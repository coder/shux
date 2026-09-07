import * as fs from "node:fs/promises";
import { readFile, readdir, writeFile } from "node:fs/promises";
import { COMPACTION_CANCELLATION_FILE } from "@/common/constants/compactionCancellation";
import type { CompactionMonitor } from "./compactionMonitor";
import type { ContinuousCompactor } from "./continuousCompactor";
import { afterEach, expect, mock, spyOn, test } from "bun:test";
import { createMuxMessage } from "@/common/types/message";
import { Err, Ok } from "@/common/types/result";
import type { TurnCompletion } from "./streamManager";
import type { TurnCoordinator } from "./turnCoordinator";
import type { CompactionHandler } from "./compactionHandler";
import { HistoryService } from "./historyService";
import { log } from "./log";
import { ExtensionMetadataService } from "./ExtensionMetadataService";
import { WorkspaceGoalService } from "./workspaceGoalService";
import { createTestHistoryService } from "./testHistoryService";
import { createAgentSessionHarness } from "./agentSession.testHarness";

const workspaceId = "compaction-shutdown";
const options = { model: "openai:gpt-4o", agentId: "exec" };
const summary = () =>
  createMuxMessage("summary", "assistant", "Earlier work", {
    muxMetadata: {
      type: "compaction-summary",
      pendingFollowUp: { text: "Continue", ...options },
    },
  });

async function setup() {
  const history = await createTestHistoryService();
  const goalService = new WorkspaceGoalService(
    history.config,
    history.historyService,
    new ExtensionMetadataService(`${history.config.rootDir}/extension.json`),
    { recordGoalLifecycleEvent: mock(() => undefined) }
  );
  const h = await createAgentSessionHarness({
    ...history,
    workspaceId,
    workspaceGoalService: goalService,
  });
  const internals = h.session as unknown as {
    coordinator: TurnCoordinator;
    activeCompactionRequest?: { id: string; modelString: string };
    compactionHandler: CompactionHandler;
    dispatchPendingFollowUp(summaryId?: string, cancelResume?: () => boolean): Promise<boolean>;
  };
  return { ...h, cleanup: history.cleanup, goalService, internals };
}

afterEach(() => mock.restore());

test.each(["Stop", "replacement", "shutdown", "dispose"] as const)(
  "a durable handoff survives %s during goal synchronization",
  async (action) => {
    const h = await setup();
    await h.historyService.appendToHistory(workspaceId, summary());
    const entered = Promise.withResolvers<void>();
    const release = Promise.withResolvers<void>();
    const sync = h.goalService.syncGoalModeWithChatTail.bind(h.goalService);
    spyOn(h.goalService, "syncGoalModeWithChatTail").mockImplementationOnce(async (...args) => {
      entered.resolve();
      await release.promise;
      return sync(...args);
    });
    const stream = spyOn(h.aiService, "streamMessage");
    const pending = h.internals.dispatchPendingFollowUp();
    let closing: Promise<void> | undefined;
    try {
      await entered.promise;
      if (action === "Stop") await h.session.interruptStream({ abandonPartial: true });
      if (action === "replacement")
        expect((await h.session.sendMessage("manual replacement", options)).success).toBe(true);
      if (action === "shutdown") closing = h.session.finishShutdown();
      if (action === "dispose") closing = h.session.dispose();
      release.resolve();
      expect(await pending).toBe(true);
      await closing;
      expect(stream).toHaveBeenCalledTimes(action === "replacement" ? 1 : 0);
      const history = await h.historyService.getHistoryFromLatestBoundary(workspaceId);
      expect(
        history.success && history.data.find((row) => row.role === "user")?.parts
      ).toMatchObject([{ type: "text", text: "Continue" }]);
      expect(history.success && history.data[0].metadata?.muxMetadata).toHaveProperty(
        "pendingFollowUp"
      );
    } finally {
      release.resolve();
      await pending.catch(() => undefined);
      await closing;
      await h.session.dispose();
      await h.cleanup();
    }
  }
);

test.each([false, true])(
  "a real goal-sync failure retains the durable handoff and reports failure (Stop=%s)",
  async (stop) => {
    const h = await setup();
    await h.historyService.appendToHistory(workspaceId, summary());
    spyOn(h.goalService, "syncGoalModeWithChatTail").mockImplementationOnce(async () => {
      if (stop) await h.session.interruptStream({ abandonPartial: true });
      throw new Error("goal reconciliation failed");
    });
    const stream = spyOn(h.aiService, "streamMessage");
    try {
      const failure = await h.internals.dispatchPendingFollowUp().catch((error: unknown) => error);
      expect(failure).toBeInstanceOf(Error);
      expect(failure).toHaveProperty(
        "message",
        expect.stringContaining("goal reconciliation failed")
      );
      const history = await h.historyService.getHistoryFromLatestBoundary(workspaceId);
      expect(history.success && history.data.some((row) => row.role === "user")).toBe(true);
      expect(history.success && history.data[0].metadata?.muxMetadata).toHaveProperty(
        "pendingFollowUp"
      );
      expect(stream).not.toHaveBeenCalled();
    } finally {
      await h.session.dispose();
      await h.cleanup();
    }
  }
);

test.each(["Stop", "replacement"] as const)(
  "a synchronous row listener preserves the durable handoff on %s",
  async (action) => {
    const h = await setup();
    await h.historyService.appendToHistory(workspaceId, summary());
    let replacement: Promise<unknown> | undefined;
    const detach = h.session.onChatEvent(({ message }) => {
      if (message.type !== "message" || message.role !== "user") return;
      detach();
      if (action === "Stop") replacement = h.session.interruptStream({ abandonPartial: true });
      else {
        // Simulate reentrant manual admission in the same synchronous event publication.
        expect(
          h.internals.coordinator.prepare({
            kind: "fresh",
            intent: "direct",
            expectedTurnId: h.internals.coordinator.turnId,
          }).status
        ).toBe("admitted");
      }
    });
    const stream = spyOn(h.aiService, "streamMessage");
    try {
      expect(await h.internals.dispatchPendingFollowUp()).toBe(true);
      await replacement;
      expect(stream).not.toHaveBeenCalled();
      const history = await h.historyService.getHistoryFromLatestBoundary(workspaceId);
      expect(history.success && history.data[0].metadata?.muxMetadata).toHaveProperty(
        "pendingFollowUp"
      );
    } finally {
      detach();
      await replacement;
      await h.session.dispose();
      await h.cleanup();
    }
  }
);

test.each(["shutdown", "dispose"] as const)(
  "Stop cleanup retains its exact guarded commit while %s joins it",
  async (action) => {
    const h = await setup();
    await h.historyService.appendToHistory(workspaceId, summary());
    const entered = Promise.withResolvers<void>();
    const release = Promise.withResolvers<void>();
    const history = h.historyService as unknown as {
      writeGuardedHistory(path: string, serialized: string, guard: () => boolean): Promise<boolean>;
    };
    const write = history.writeGuardedHistory.bind(history);
    spyOn(history, "writeGuardedHistory").mockImplementationOnce(async (...args) => {
      entered.resolve();
      await release.promise;
      return write(...args);
    });
    const stream = spyOn(h.aiService, "streamMessage");
    // A ready owner is already clearing a canceled resume when Stop and shutdown arrive.
    const pending = h.internals.dispatchPendingFollowUp(undefined, () => true);
    let closing: Promise<void> | undefined;
    try {
      await entered.promise;
      await h.session.interruptStream({ abandonPartial: true });
      let closed = false;
      closing = (action === "shutdown" ? h.session.finishShutdown() : h.session.dispose()).then(
        () => {
          closed = true;
        }
      );
      await Promise.resolve();
      expect(closed).toBe(false);
      release.resolve();
      expect(await pending).toBe(false);
      await closing;
      const rows = await h.historyService.getLastMessages(workspaceId, 1);
      expect(rows.success && rows.data[0].metadata?.muxMetadata).not.toHaveProperty(
        "pendingFollowUp"
      );
      expect(stream).not.toHaveBeenCalled();
      await expectNoRecovery(h.config, h.historyService);
    } finally {
      release.resolve();
      await pending;
      await closing;
      await h.session.dispose();
      await h.cleanup();
    }
  }
);

async function expectNoRecovery(
  config: Awaited<ReturnType<typeof setup>>["config"],
  historyService: HistoryService
) {
  const restarted = await createAgentSessionHarness({ workspaceId, config, historyService });
  const stream = spyOn(restarted.aiService, "streamMessage");
  try {
    const recovered = restarted.session as unknown as {
      dispatchPendingFollowUp(): Promise<boolean>;
    };
    expect(await recovered.dispatchPendingFollowUp()).toBe(false);
    expect(stream).not.toHaveBeenCalled();
  } finally {
    await restarted.session.dispose();
  }
}

test.each(["success", "goal rejection", "boundary publication rejection"] as const)(
  "Stop then shutdown before terminal cleanup removes its durable intent (%s)",
  async (outcome) => {
    const h = await setup();
    const completion = Promise.withResolvers<TurnCompletion>();
    const entered = Promise.withResolvers<void>();
    const release = Promise.withResolvers<void>();
    const stream = spyOn(h.aiService, "streamMessage").mockResolvedValueOnce(
      Ok({ messageId: "assistant", completion: completion.promise })
    );
    spyOn(h.internals.compactionHandler, "handleCompletion").mockImplementationOnce(async () => {
      await h.historyService.appendToHistory(workspaceId, summary());
      if (outcome === "boundary publication rejection") {
        entered.resolve();
        await release.promise;
        throw new Error("boundary publication failed");
      }
      return true;
    });
    spyOn(h.goalService, "applyPendingAfterStreamEnd").mockImplementationOnce(async () => {
      entered.resolve();
      await release.promise;
      if (outcome === "goal rejection") throw new Error("pending goal application failed");
      return null;
    });
    const errors = spyOn(log, "error");
    const consumer = spyOn(h.internals.coordinator, "consumeCompletion");
    let closing: Promise<void> | undefined;
    try {
      expect((await h.session.sendMessage("original", options)).success).toBe(true);
      h.internals.activeCompactionRequest = { id: "compact-request", modelString: options.model };
      completion.resolve({
        status: "completed",
        streamEnd: {
          type: "stream-end",
          workspaceId,
          metadata: { model: options.model },
          parts: [],
        },
      });
      await entered.promise;
      await h.session.interruptStream({ abandonPartial: true });
      let closed = false;
      closing = h.session.finishShutdown().then(() => {
        closed = true;
      });
      await Promise.resolve();
      expect(closed).toBe(false);
      release.resolve();
      const policy = consumer.mock.results.at(-1);
      if (policy?.type !== "return") throw new Error("Expected terminal consumer");
      await policy.value;
      await closing;
      expect(stream).toHaveBeenCalledTimes(1);
      if (outcome !== "success")
        expect(errors).toHaveBeenCalledWith("stream-end cleanup failed", {
          workspaceId,
          error:
            outcome === "goal rejection"
              ? "pending goal application failed"
              : "boundary publication failed",
        });
      const rows = await h.historyService.getLastMessages(workspaceId, 1);
      expect(rows.success && rows.data[0].metadata?.muxMetadata).not.toHaveProperty(
        "pendingFollowUp"
      );
      await expectNoRecovery(h.config, h.historyService);
    } finally {
      release.resolve();
      completion.resolve({ status: "aborted", abortReason: "user" });
      await closing;
      await h.session.dispose();
      await h.cleanup();
    }
  }
);

test.each([false, true])(
  "Stop during goal redispatch admission finishes cleanup through shutdown (rejection=%s)",
  async (reject) => {
    const h = await setup();
    const boundary = summary();
    await h.historyService.appendToHistory(workspaceId, {
      ...boundary,
      metadata: {
        ...boundary.metadata,
        muxMetadata: {
          type: "compaction-summary",
          pendingFollowUp: {
            text: "Continue",
            ...options,
            goalKind: "goal_continuation",
            goalId: "00000000-0000-4000-8000-000000000001",
          },
        },
      },
    });
    const entered = Promise.withResolvers<void>();
    const release = Promise.withResolvers<void>();
    const stream = spyOn(h.aiService, "streamMessage");
    spyOn(h.goalService, "buildGoalRedispatchAdmission").mockImplementationOnce(async () => {
      entered.resolve();
      await release.promise;
      if (reject) throw new Error("goal admission read failed");
      return { admissible: true, admissionStale: () => false };
    });
    const pending = h.internals.dispatchPendingFollowUp();
    let closing: Promise<void> | undefined;
    try {
      await entered.promise;
      await h.session.interruptStream({ abandonPartial: true });
      closing = h.session.finishShutdown();
      release.resolve();
      const result = await pending.catch((error: unknown) => error);
      if (reject) expect(result).toHaveProperty("message", "goal admission read failed");
      else expect(result).toBe(false);
      await closing;
      const rows = await h.historyService.getLastMessages(workspaceId, 1);
      expect(rows.success && rows.data[0].metadata?.muxMetadata).not.toHaveProperty(
        "pendingFollowUp"
      );
      expect(stream).not.toHaveBeenCalled();
      await expectNoRecovery(h.config, h.historyService);
    } finally {
      release.resolve();
      await pending.catch(() => undefined);
      await closing;
      await h.session.dispose();
      await h.cleanup();
    }
  }
);

test("a failed Stop rollback acknowledges the retained durable continuation", async () => {
  const h = await setup();
  await h.historyService.appendToHistory(workspaceId, summary());
  const stream = spyOn(h.aiService, "streamMessage");
  const append = h.historyService.appendToHistory.bind(h.historyService);
  spyOn(h.historyService, "appendToHistory").mockImplementationOnce(async (...args) => {
    const result = await append(...args);
    await h.session.interruptStream({ abandonPartial: true });
    return result;
  });
  spyOn(h.historyService, "deleteMessages").mockResolvedValueOnce(Err("disk unavailable"));
  try {
    expect(await h.internals.dispatchPendingFollowUp()).toBe(true);
    const rows = await h.historyService.getHistoryFromLatestBoundary(workspaceId);
    expect(rows.success && rows.data.some((row) => row.role === "user")).toBe(true);
    expect(rows.success && rows.data[0].metadata?.muxMetadata).toHaveProperty("pendingFollowUp");
    expect(stream).not.toHaveBeenCalled();
  } finally {
    await h.session.dispose();
    await h.cleanup();
  }
});

test.each([
  [false, false, false],
  [true, false, false],
  [false, true, false],
  [true, true, false],
  [false, false, true],
  [true, false, true],
] as const)(
  "a failed initial follow-up read retries only abandoned ownership (targeted=%s, replacement=%s, result error=%s)",
  async (targeted, replacement, resultError) => {
    const h = await setup();
    const boundary = summary();
    await h.historyService.appendToHistory(workspaceId, boundary);
    const entered = Promise.withResolvers<void>();
    const release = Promise.withResolvers<void>();
    const read = targeted ? "getHistoryFromLatestBoundary" : "getLastMessages";
    spyOn(h.historyService, read).mockImplementationOnce(async () => {
      entered.resolve();
      await release.promise;
      if (resultError) return Err("initial history read failed");
      throw new Error("initial history read failed");
    });
    const stream = spyOn(h.aiService, "streamMessage");
    const pending = h.internals.dispatchPendingFollowUp(targeted ? boundary.id : undefined);
    let closing: Promise<void> | undefined;
    try {
      await entered.promise;
      await h.session.interruptStream({ abandonPartial: true });
      if (replacement) {
        using _mutation = h.session.holdTurnAdmission();
        await h.historyService.updateHistory(workspaceId, {
          ...boundary,
          metadata: {
            ...boundary.metadata,
            muxMetadata: {
              type: "compaction-summary",
              pendingFollowUp: { text: "replacement", ...options },
            },
          },
        });
        await h.session.contextMutationCommitted();
      }
      closing = h.session.finishShutdown();
      release.resolve();
      const failure = await pending.catch((error: unknown) => error);
      expect(failure).toHaveProperty(
        "message",
        expect.stringContaining("initial history read failed")
      );
      await closing;
      const rows = await h.historyService.getLastMessages(workspaceId, 1);
      if (replacement)
        expect(rows.success && rows.data[0].metadata?.muxMetadata).toHaveProperty(
          "pendingFollowUp.text",
          "replacement"
        );
      else {
        expect(rows.success && rows.data[0].metadata?.muxMetadata).not.toHaveProperty(
          "pendingFollowUp"
        );
        await expectNoRecovery(h.config, h.historyService);
      }
      expect(stream).not.toHaveBeenCalled();
    } finally {
      release.resolve();
      await pending.catch(() => undefined);
      await closing;
      await h.session.dispose();
      await h.cleanup();
    }
  }
);

test.each(["fields", "pending request", "message ID", "sequence"] as const)(
  "abandoned cleanup matches handoff identity and preserves newer summary fields (%s)",
  async (changed) => {
    const h = await setup();
    const boundary = summary();
    boundary.metadata = {
      ...boundary.metadata,
      compacted: "user",
      compactionBoundary: true,
      compactionEpoch: 1,
    };
    await h.historyService.appendToHistory(workspaceId, boundary);
    await h.session.interruptStream({ abandonPartial: true });
    const entered = Promise.withResolvers<void>();
    const release = Promise.withResolvers<void>();
    const update = h.historyService.updateHistory.bind(h.historyService);
    spyOn(h.historyService, "updateHistory").mockImplementationOnce(async (...args) => {
      entered.resolve();
      await release.promise;
      return update(...args);
    });
    const pending = h.internals.dispatchPendingFollowUp();
    try {
      await entered.promise;
      const rewritten = {
        ...boundary,
        id: changed === "message ID" ? "replacement-summary" : boundary.id,
        parts: [{ type: "text" as const, text: "finalized summary" }],
        metadata: {
          ...boundary.metadata,
          model: "openai:gpt-4o",
          duration: 42,
          muxMetadata: {
            type: "compaction-summary" as const,
            pendingFollowUp: {
              text: changed === "pending request" ? "replacement" : "Continue",
              ...options,
            },
          },
        },
      };
      if (changed === "sequence") {
        await h.historyService.deleteMessages(workspaceId, [boundary.id]);
        await h.historyService.appendToHistory(workspaceId, {
          ...rewritten,
          metadata: { ...rewritten.metadata, historySequence: undefined },
        });
      } else if (changed === "fields") {
        // Real late finalization omits compaction metadata; HistoryService must
        // preserve the handoff before cleanup merges only its pending field away.
        await update(workspaceId, {
          ...rewritten,
          metadata: {
            historySequence: boundary.metadata?.historySequence,
            model: "openai:gpt-4o",
            duration: 42,
          },
        });
      } else await update(workspaceId, rewritten);
      release.resolve();
      expect(await pending).toBe(false);
      const rows = await h.historyService.getLastMessages(workspaceId, 1);
      expect(rows.success && rows.data[0].parts).toMatchObject([
        { type: "text", text: "finalized summary" },
      ]);
      expect(rows.success && rows.data[0].metadata).toHaveProperty("duration", 42);
      expect(rows.success && rows.data[0].metadata).toHaveProperty("compactionBoundary", true);
      if (changed !== "fields")
        expect(rows.success && rows.data[0].metadata?.muxMetadata).toHaveProperty(
          "pendingFollowUp"
        );
      else {
        expect(rows.success && rows.data[0].metadata?.muxMetadata).not.toHaveProperty(
          "pendingFollowUp"
        );
        await expectNoRecovery(h.config, h.historyService);
      }
    } finally {
      release.resolve();
      await pending;
      await h.session.dispose();
      await h.cleanup();
    }
  }
);

test("context replacement after Stop dispatches B while A's held cleanup is retired", async () => {
  const h = await setup();
  const boundary = summary();
  await h.historyService.appendToHistory(workspaceId, boundary);
  await h.session.interruptStream({ abandonPartial: true });
  const entered = Promise.withResolvers<void>();
  const release = Promise.withResolvers<void>();
  const update = h.historyService.updateHistory.bind(h.historyService);
  spyOn(h.historyService, "updateHistory").mockImplementationOnce(async (...args) => {
    entered.resolve();
    await release.promise;
    return update(...args);
  });
  const stale = h.internals.dispatchPendingFollowUp();
  const stream = spyOn(h.aiService, "streamMessage");
  try {
    await entered.promise;
    {
      using _mutation = h.session.holdTurnAdmission();
      await update(workspaceId, {
        ...boundary,
        metadata: {
          ...boundary.metadata,
          muxMetadata: {
            type: "compaction-summary",
            pendingFollowUp: { text: "replacement", ...options },
          },
        },
      });
      await h.session.contextMutationCommitted();
    }
    expect(await h.internals.dispatchPendingFollowUp()).toBe(true);
    release.resolve();
    expect(await stale).toBe(false);
    expect(stream).toHaveBeenCalledTimes(1);
    const rows = await h.historyService.getHistoryFromLatestBoundary(workspaceId);
    expect(rows.success && rows.data.find((row) => row.role === "user")?.parts).toMatchObject([
      { type: "text", text: "replacement" },
    ]);
    expect(rows.success && rows.data[0].metadata?.muxMetadata).toHaveProperty(
      "pendingFollowUp.text",
      "replacement"
    );
  } finally {
    release.resolve();
    await stale;
    await h.session.dispose();
    await h.cleanup();
  }
});

test("a persistently unreadable abandoned follow-up retries once and preserves the initial error", async () => {
  const h = await setup();
  await h.historyService.appendToHistory(workspaceId, summary());
  await h.session.interruptStream({ abandonPartial: true });
  const read = spyOn(h.historyService, "getLastMessages")
    .mockRejectedValueOnce(new Error("original read failure"))
    .mockRejectedValueOnce(new Error("cleanup read failure"));
  const stream = spyOn(h.aiService, "streamMessage");
  try {
    const failure = await h.internals.dispatchPendingFollowUp().catch((error: unknown) => error);
    expect(failure).toHaveProperty("message", "original read failure");
    expect(read).toHaveBeenCalledTimes(2);
    expect(stream).not.toHaveBeenCalled();
  } finally {
    await h.session.dispose();
    await h.cleanup();
  }
});

test.each(["recovery", "shutdown", "dispose", "teardown read recovers"] as const)(
  "failed abandoned cleanup keeps ownership until %s retries it",
  async (retry) => {
    const h = await setup();
    await h.historyService.appendToHistory(workspaceId, summary());
    await h.session.interruptStream({ abandonPartial: true });
    const read = spyOn(h.historyService, "getLastMessages")
      .mockRejectedValueOnce(new Error("initial read unavailable"))
      .mockRejectedValueOnce(new Error("cleanup read unavailable"));
    if (retry === "teardown read recovers")
      read.mockRejectedValueOnce(new Error("teardown first read unavailable"));
    const stream = spyOn(h.aiService, "streamMessage");
    try {
      const failure = await h.internals.dispatchPendingFollowUp().catch((error: unknown) => error);
      expect(failure).toHaveProperty("message", "initial read unavailable");
      const owner = h.internals.coordinator.compactionIntent.followUp;
      expect(owner).toBeDefined();
      if (!owner) throw new Error("Expected retained cleanup owner");
      expect(h.internals.coordinator.canClearCompactionFollowUp(owner)).toBe(true);
      if (retry === "recovery") expect(await h.internals.dispatchPendingFollowUp()).toBe(false);
      if (retry === "shutdown") await h.session.finishShutdown();
      else await h.session.dispose();
      expect(stream).not.toHaveBeenCalled();
      const rows = await h.historyService.getLastMessages(workspaceId, 1);
      expect(rows.success && rows.data[0].metadata?.muxMetadata).not.toHaveProperty(
        "pendingFollowUp"
      );
      await expectNoRecovery(h.config, h.historyService);
    } finally {
      await h.session.dispose().catch(() => undefined);
      await h.cleanup();
    }
  }
);

test("permanent abandoned cleanup failure is bounded and fails shutdown after releasing resources", async () => {
  const h = await setup();
  await h.historyService.appendToHistory(workspaceId, summary());
  await h.session.interruptStream({ abandonPartial: true });
  const read = spyOn(h.historyService, "getLastMessages").mockRejectedValue(
    new Error("history unavailable")
  );
  try {
    await h.internals.dispatchPendingFollowUp().catch(() => undefined);
    const failure = await h.session.finishShutdown().catch((error: unknown) => error);
    expect(failure).toBeInstanceOf(Error);
    expect(read).toHaveBeenCalledTimes(4);
    expect(h.aiEmitter.listenerCount("stream-start")).toBe(0);
    expect(h.aiEmitter.listenerCount("stream-end")).toBe(0);
    expect(h.internals.coordinator.compactionIntent.followUp).toBeDefined();
  } finally {
    await h.session.dispose().catch(() => undefined);
    await h.cleanup();
  }
});

test("retrying retired cleanup never dispatches the replacement handoff", async () => {
  const h = await setup();
  const boundary = summary();
  await h.historyService.appendToHistory(workspaceId, boundary);
  await h.session.interruptStream({ abandonPartial: true });
  spyOn(h.historyService, "getLastMessages")
    .mockRejectedValueOnce(new Error("initial read unavailable"))
    .mockRejectedValueOnce(new Error("cleanup read unavailable"));
  const stream = spyOn(h.aiService, "streamMessage");
  try {
    await h.internals.dispatchPendingFollowUp().catch(() => undefined);
    {
      using _mutation = h.session.holdTurnAdmission();
      await h.historyService.updateHistory(workspaceId, {
        ...boundary,
        metadata: {
          ...boundary.metadata,
          muxMetadata: {
            type: "compaction-summary",
            pendingFollowUp: { text: "replacement", ...options },
          },
        },
      });
      await h.session.contextMutationCommitted();
    }
    await h.session.retryPendingCompactionCleanup();
    expect(stream).not.toHaveBeenCalled();
    expect(await h.internals.dispatchPendingFollowUp()).toBe(true);
    expect(stream).toHaveBeenCalledTimes(1);
  } finally {
    await h.session.dispose();
    await h.cleanup();
  }
});

test("stopped follow-up stays canceled after failed cleanup and a fresh process session", async () => {
  const h = await setup();
  await h.historyService.appendToHistory(workspaceId, summary());
  await h.session.interruptStream({ abandonPartial: true });
  const read = spyOn(h.historyService, "getLastMessages").mockRejectedValue(
    new Error("history unavailable")
  );
  try {
    await h.internals.dispatchPendingFollowUp().catch(() => undefined);
    await h.session.finishShutdown().catch(() => undefined);
    read.mockRestore();
    const freshHistory = new HistoryService(h.config);
    const restarted = await createAgentSessionHarness({
      workspaceId,
      config: h.config,
      historyService: freshHistory,
    });
    const stream = spyOn(restarted.aiService, "streamMessage");
    try {
      await restarted.session.runStartupRecovery();
      expect(stream).not.toHaveBeenCalled();
    } finally {
      await restarted.session.dispose();
    }
  } finally {
    read.mockRestore();
    await h.session.dispose().catch(() => undefined);
    await h.cleanup();
  }
});

test("an initial follow-up waits for admission release without consuming recovery", async () => {
  const h = await setup();
  await h.historyService.appendToHistory(workspaceId, summary());
  const hold = h.session.holdTurnAdmission();
  const stream = spyOn(h.aiService, "streamMessage");
  try {
    const pending = h.internals.dispatchPendingFollowUp();
    await Promise.resolve();
    expect(h.internals.coordinator.compactionIntent.followUp).toBeUndefined();
    expect(stream).not.toHaveBeenCalled();
    hold[Symbol.dispose]();
    expect(await pending).toBe(true);
    expect(stream).toHaveBeenCalledTimes(1);
  } finally {
    hold[Symbol.dispose]();
    await h.session.dispose();
    await h.cleanup();
  }
}, 1000);

test.each([
  "release",
  "nested release",
  "Stop",
  "replacement",
  "shutdown",
  "hold during read",
  "hold during prepare",
] as const)(
  "startup follow-up admission wait handles %s without another recovery trigger",
  async (action) => {
    const h = await setup();
    await h.historyService.appendToHistory(workspaceId, summary());
    let hold =
      action === "hold during read" || action === "hold during prepare"
        ? undefined
        : h.session.holdTurnAdmission();
    const second = action === "nested release" ? h.session.holdTurnAdmission() : undefined;
    const waiting = Promise.withResolvers<void>();
    const wait = h.internals.coordinator.waitForAdmissionRelease.bind(h.internals.coordinator);
    spyOn(h.internals.coordinator, "waitForAdmissionRelease").mockImplementation(() => {
      waiting.resolve();
      return wait();
    });
    if (action === "hold during read") {
      const read = h.historyService.getLastMessages.bind(h.historyService);
      spyOn(h.historyService, "getLastMessages").mockImplementationOnce(async (...args) => {
        const result = await read(...args);
        hold = h.session.holdTurnAdmission();
        return result;
      });
    }
    if (action === "hold during prepare") {
      const pricing = h.goalService.assertPricedModelForBudgetedGoal.bind(h.goalService);
      spyOn(h.goalService, "assertPricedModelForBudgetedGoal").mockImplementationOnce(
        async (...args) => {
          const result = await pricing(...args);
          hold = h.session.holdTurnAdmission();
          return result;
        }
      );
    }
    const stream = spyOn(h.aiService, "streamMessage");
    const recovery = h.session.runStartupRecovery();
    try {
      await waiting.promise;
      // No physical lease is waiting for a policy hold: shutdown can drain it.
      await h.internals.coordinator.drain();
      expect(stream).not.toHaveBeenCalled();
      if (action === "Stop") await h.session.interruptStream({ abandonPartial: true });
      if (action === "replacement") {
        await h.historyService.clearHistory(workspaceId);
        await h.session.contextMutationCommitted();
      }
      if (action === "shutdown") await h.session.finishShutdown();
      hold?.[Symbol.dispose]();
      if (second) {
        await Promise.resolve();
        expect(stream).not.toHaveBeenCalled();
        second[Symbol.dispose]();
      }
      await recovery;
      expect(stream).toHaveBeenCalledTimes(
        action === "release" ||
          action === "nested release" ||
          action === "hold during read" ||
          action === "hold during prepare"
          ? 1
          : 0
      );
    } finally {
      hold?.[Symbol.dispose]();
      second?.[Symbol.dispose]();
      await recovery;
      await h.session.dispose();
      await h.cleanup();
    }
  },
  2000
);

test("a delayed cancellation write survives failed manual preparation", async () => {
  const h = await setup();
  await h.historyService.appendToHistory(workspaceId, summary());
  const entered = Promise.withResolvers<void>();
  const release = Promise.withResolvers<void>();
  const write = h.historyService.writeCompactionCancellation.bind(h.historyService);
  spyOn(h.historyService, "writeCompactionCancellation").mockImplementationOnce(async (...args) => {
    entered.resolve();
    await release.promise;
    return write(...args);
  });
  try {
    await h.session.interruptStream({ abandonPartial: true });
    await entered.promise;
    spyOn(h.historyService, "appendToHistory").mockResolvedValueOnce(
      Err("replacement append failed")
    );
    expect((await h.session.sendMessage("replacement", options)).success).toBe(false);
    release.resolve();
    await h.session.dispose();
    const freshHistory = new HistoryService(h.config);
    expect(await freshHistory.readCompactionCancellation(workspaceId)).not.toBeNull();
    await expectNoRecovery(h.config, freshHistory);
  } finally {
    release.resolve();
    await h.session.dispose().catch(() => undefined);
    await h.cleanup();
  }
});

test("a durable replacement witness survives a crash before cancellation retirement", async () => {
  const h = await setup();
  await h.historyService.appendToHistory(workspaceId, summary());
  await h.session.interruptStream({ abandonPartial: true });
  const nonce = await h.session.getCompactionCancellationNonce();
  const write = h.historyService.writeCompactionCancellation.bind(h.historyService);
  const writes = spyOn(h.historyService, "writeCompactionCancellation").mockImplementation(
    async (...args) => {
      if (args[1] === null) throw new Error("cancellation unlink failed");
      return write(...args);
    }
  );
  const stream = spyOn(h.aiService, "streamMessage");
  try {
    const result = await h.session
      .sendMessage("replacement", options)
      .catch((error: unknown) => error);
    expect(result).toHaveProperty("message", "cancellation unlink failed");
    expect(stream).not.toHaveBeenCalled();
    const freshHistory = new HistoryService(h.config);
    const rows = await freshHistory.getHistoryFromLatestBoundary(workspaceId);
    expect(
      rows.success &&
        rows.data.find((row) => row.role === "user")?.metadata?.compactionCancellationNonce
    ).toBe(nonce);
    expect(await freshHistory.readCompactionCancellation(workspaceId)).not.toBeNull();
    const restarted = await createAgentSessionHarness({
      workspaceId,
      config: h.config,
      historyService: freshHistory,
    });
    try {
      await restarted.session.runStartupRecovery();
      expect(await freshHistory.readCompactionCancellation(workspaceId)).toBeNull();
      const after = await freshHistory.getHistoryFromLatestBoundary(workspaceId);
      expect(
        after.success && after.data.filter((row) => row.role === "user").map((row) => row.parts)
      ).toMatchObject([[{ type: "text", text: "replacement" }]]);
    } finally {
      await restarted.session.dispose();
    }
  } finally {
    writes.mockRestore();
    await h.session.dispose().catch(() => undefined);
    await h.cleanup();
  }
});

test("cancellation persistence failures fail teardown until an explicit durable retry", async () => {
  const h = await setup();
  await h.historyService.appendToHistory(workspaceId, summary());
  const write = spyOn(h.historyService, "writeCompactionCancellation").mockRejectedValue(
    new Error("cancellation disk unavailable")
  );
  try {
    await h.session.interruptStream({ abandonPartial: true });
    const failure = await h.session.dispose().catch((error: unknown) => error);
    expect(failure).toHaveProperty("message", "cancellation disk unavailable");
    expect(h.session.hasPendingCompactionCleanup).toBe(true);
    expect(h.aiEmitter.listenerCount("stream-start")).toBe(0);
    write.mockRestore();
    await h.session.retryPendingCompactionCleanup();
    expect(h.session.hasPendingCompactionCleanup).toBe(false);
    await expectNoRecovery(h.config, new HistoryService(h.config));
  } finally {
    write.mockRestore();
    await h.session.dispose().catch(() => undefined);
    await h.cleanup();
  }
});

test("an exact cancellation survives failed summary writes across a fresh service", async () => {
  const h = await setup();
  await h.historyService.appendToHistory(workspaceId, summary());
  await h.session.interruptStream({ abandonPartial: true });
  const historyWrites = h.historyService as unknown as {
    writeGuardedHistory(path: string, serialized: string, guard: () => boolean): Promise<boolean>;
  };
  const update = spyOn(historyWrites, "writeGuardedHistory").mockRejectedValue(
    new Error("history rewrite unavailable")
  );
  try {
    await h.internals.dispatchPendingFollowUp().catch(() => undefined);
    await h.session.finishShutdown().catch(() => undefined);
    const freshHistory = new HistoryService(h.config);
    expect((await freshHistory.readCompactionCancellation(workspaceId))?.scope.kind).toBe(
      "summary"
    );
    const rows = await freshHistory.getLastMessages(workspaceId, 1);
    expect(rows.success && rows.data[0].metadata?.muxMetadata).toHaveProperty("pendingFollowUp");
    await expectNoRecovery(h.config, freshHistory);
  } finally {
    update.mockRestore();
    await h.session.dispose().catch(() => undefined);
    await h.cleanup();
  }
});

test.each(["{", JSON.stringify({ version: 1, nonce: "broken", scope: {} })])(
  "malformed cancellation %s self-heals before automatic startup recovery",
  async (malformed) => {
    const h = await setup();
    await h.historyService.appendToHistory(workspaceId, summary());
    const sessionDir = `${h.config.sessionsDir}/${workspaceId}`;
    await writeFile(`${sessionDir}/${COMPACTION_CANCELLATION_FILE}`, malformed);
    const journal = h.historyService.getContinuousCompactionJournal(workspaceId);
    await writeFile(journal.path, "untrusted interrupted journal");
    const compactor = (h.session as unknown as { continuousCompactor: ContinuousCompactor })
      .continuousCompactor;
    const recoverJournal = compactor.recover.bind(compactor);
    const recover = spyOn(compactor, "recover").mockImplementation(async () => {
      // The old journal must be gone before normal recovery can inspect it.
      expect(await journal.exists()).toBe(false);
      return recoverJournal();
    });
    const recoverGoal = spyOn(h.goalService, "recoverPendingDispatchAfterRestart");
    const stream = spyOn(h.aiService, "streamMessage");
    try {
      await h.session.runStartupRecovery();
      expect(recoverGoal).toHaveBeenCalledTimes(1);
      expect(recover).toHaveBeenCalledTimes(1);
      expect(stream).not.toHaveBeenCalled();
      const freshHistory = new HistoryService(h.config);
      expect(await freshHistory.readCompactionCancellation(workspaceId)).toBeNull();
      expect(await freshHistory.getContinuousCompactionJournal(workspaceId).exists()).toBe(false);
      const rows = await freshHistory.getLastMessages(workspaceId, 1);
      expect(rows.success && rows.data[0].metadata?.muxMetadata).not.toHaveProperty(
        "pendingFollowUp"
      );
      const files = await readdir(sessionDir);
      const preserved = await Promise.all(
        files.map((file) => readFile(`${sessionDir}/${file}`, "utf8").catch(() => ""))
      );
      expect(preserved).toContain(malformed);
      await expectNoRecovery(h.config, freshHistory);
    } finally {
      await h.session.dispose();
      await h.cleanup();
    }
  }
);

test.each([
  [false, false],
  [true, false],
  [false, true],
  [true, true],
] as const)(
  "direct follow-up dispatch discards its pre-repair summary (targeted=%s, during history=%s)",
  async (targeted, duringHistory) => {
    const h = await setup();
    await h.historyService.appendToHistory(workspaceId, summary());
    await writeFile(`${h.config.sessionsDir}/${workspaceId}/${COMPACTION_CANCELLATION_FILE}`, "{");
    if (duringHistory) {
      if (targeted) {
        const read = h.historyService.getHistoryFromLatestBoundary.bind(h.historyService);
        spyOn(h.historyService, "getHistoryFromLatestBoundary").mockImplementationOnce(
          async (...args) => {
            const captured = await read(...args);
            await h.session.getCompactionCancellationNonce();
            return captured;
          }
        );
      } else {
        const read = h.historyService.getLastMessages.bind(h.historyService);
        spyOn(h.historyService, "getLastMessages").mockImplementationOnce(async (...args) => {
          const captured = await read(...args);
          await h.session.getCompactionCancellationNonce();
          return captured;
        });
      }
    }
    const stream = spyOn(h.aiService, "streamMessage");
    try {
      expect(await h.internals.dispatchPendingFollowUp(targeted ? "summary" : undefined)).toBe(
        false
      );
      expect(stream).not.toHaveBeenCalled();
      const rows = await h.historyService.getHistoryFromLatestBoundary(workspaceId);
      expect(rows.success && rows.data.some((row) => row.role === "user")).toBe(false);
      expect(rows.success && rows.data[0].metadata?.muxMetadata).not.toHaveProperty(
        "pendingFollowUp"
      );
    } finally {
      await h.session.dispose();
      await h.cleanup();
    }
  }
);

test.each(["goal admission", "preparation", "row persistence"] as const)(
  "late repair during %s invalidates an unaccepted follow-up",
  async (stage) => {
    const h = await setup();
    const boundary = summary();
    if (stage === "goal admission") {
      boundary.metadata = {
        ...boundary.metadata,
        muxMetadata: {
          type: "compaction-summary",
          pendingFollowUp: {
            text: "Continue",
            ...options,
            goalKind: "goal_continuation",
            goalId: "00000000-0000-4000-8000-000000000001",
          },
        },
      };
    }
    await h.historyService.appendToHistory(workspaceId, boundary);
    const entered = Promise.withResolvers<void>();
    const release = Promise.withResolvers<void>();
    if (stage === "goal admission") {
      spyOn(h.goalService, "buildGoalRedispatchAdmission").mockImplementationOnce(async () => {
        entered.resolve();
        await release.promise;
        return { admissible: true, admissionStale: () => false };
      });
    } else if (stage === "preparation") {
      const pricing = h.goalService.assertPricedModelForBudgetedGoal.bind(h.goalService);
      spyOn(h.goalService, "assertPricedModelForBudgetedGoal").mockImplementationOnce(
        async (...args) => {
          const result = await pricing(...args);
          entered.resolve();
          await release.promise;
          return result;
        }
      );
    } else {
      const append = h.historyService.appendToHistory.bind(h.historyService);
      spyOn(h.historyService, "appendToHistory").mockImplementationOnce(async (...args) => {
        const result = await append(...args);
        entered.resolve();
        await release.promise;
        return result;
      });
    }
    const stream = spyOn(h.aiService, "streamMessage");
    const pending = h.internals.dispatchPendingFollowUp();
    try {
      await entered.promise;
      await writeFile(
        `${h.config.sessionsDir}/${workspaceId}/${COMPACTION_CANCELLATION_FILE}`,
        "{"
      );
      await h.session.runStartupRecovery();
      release.resolve();
      expect(await pending).toBe(false);
      expect(stream).not.toHaveBeenCalled();
      const rows = await h.historyService.getHistoryFromLatestBoundary(workspaceId);
      expect(rows.success && rows.data.some((row) => row.role === "user")).toBe(false);
      expect(rows.success && rows.data[0].metadata?.muxMetadata).not.toHaveProperty(
        "pendingFollowUp"
      );
    } finally {
      release.resolve();
      await pending.catch(() => undefined);
      await h.session.dispose();
      await h.cleanup();
    }
  }
);

test.each(["summary read", "preparation", "auto compaction preparation"] as const)(
  "a foreign repair during %s prevents the captured follow-up from committing",
  async (stage) => {
    const h = await setup();
    await h.historyService.appendToHistory(workspaceId, summary());
    if (stage === "auto compaction preparation") {
      const monitor = (h.session as unknown as { compactionMonitor: CompactionMonitor })
        .compactionMonitor;
      spyOn(monitor, "getThreshold").mockReturnValue(0.85);
      spyOn(monitor, "checkBeforeSend").mockReturnValue({
        shouldShowWarning: true,
        shouldForceCompact: true,
        usagePercentage: 99,
        thresholdPercentage: 85,
      });
    }
    const foreignHistory = new HistoryService(h.config);
    const foreign = await createAgentSessionHarness({
      workspaceId,
      config: h.config,
      historyService: foreignHistory,
    });
    const entered = Promise.withResolvers<void>();
    const release = Promise.withResolvers<void>();
    if (stage === "summary read") {
      const read = h.historyService.getLastMessages.bind(h.historyService);
      spyOn(h.historyService, "getLastMessages").mockImplementationOnce(async (...args) => {
        const result = await read(...args);
        entered.resolve();
        await release.promise;
        return result;
      });
    } else {
      const pricing = h.goalService.assertPricedModelForBudgetedGoal.bind(h.goalService);
      spyOn(h.goalService, "assertPricedModelForBudgetedGoal").mockImplementationOnce(
        async (...args) => {
          const result = await pricing(...args);
          entered.resolve();
          await release.promise;
          return result;
        }
      );
    }
    const stream = spyOn(h.aiService, "streamMessage");
    const foreignStream = spyOn(foreign.aiService, "streamMessage");
    const pending = h.internals.dispatchPendingFollowUp();
    try {
      await entered.promise;
      await writeFile(
        `${h.config.sessionsDir}/${workspaceId}/${COMPACTION_CANCELLATION_FILE}`,
        "{"
      );
      await foreign.session.runStartupRecovery();
      expect(await foreignHistory.readCompactionCancellation(workspaceId)).toBeNull();
      expect(foreignStream).not.toHaveBeenCalled();
      release.resolve();
      expect(await pending).toBe(false);
      expect(stream).not.toHaveBeenCalled();
      const rows = await foreignHistory.getHistoryFromLatestBoundary(workspaceId);
      expect(rows.success && rows.data.some((row) => row.role === "user")).toBe(false);
    } finally {
      release.resolve();
      await pending.catch(() => undefined);
      await foreign.session.dispose();
      await h.session.dispose();
      await h.cleanup();
    }
  }
);

test.each(["clean", "cleanup failure", "guard I/O failure"] as const)(
  "a skipped follow-up never accepts preparation snapshots (%s)",
  async (failureMode) => {
    const cleanupFails = failureMode === "cleanup failure";
    const h = await setup();
    await h.historyService.appendToHistory(workspaceId, summary());
    const ownSnapshot = createMuxMessage("own-preparation", "assistant", "Snapshot", {
      synthetic: true,
    });
    const materializer = h.session as unknown as {
      materializeFileAtMentionsSnapshot(text: string): Promise<{
        snapshotMessage: ReturnType<typeof createMuxMessage>;
        materializedTokens: string[];
      } | null>;
    };
    spyOn(materializer, "materializeFileAtMentionsSnapshot").mockResolvedValue({
      snapshotMessage: ownSnapshot,
      materializedTokens: [],
    });
    const foreignHistory = new HistoryService(h.config);
    const foreign = await createAgentSessionHarness({
      workspaceId,
      config: h.config,
      historyService: foreignHistory,
    });
    const append = h.historyService.appendToHistory.bind(h.historyService);
    spyOn(h.historyService, "appendToHistory").mockImplementationOnce(async (...args) => {
      const result = await append(...args);
      if (failureMode === "guard I/O failure") {
        spyOn(h.historyService, "readCompactionCancellation").mockRejectedValueOnce(
          new Error("guard storage unavailable")
        );
      } else {
        await writeFile(
          `${h.config.sessionsDir}/${workspaceId}/${COMPACTION_CANCELLATION_FILE}`,
          "{"
        );
        await foreign.session.runStartupRecovery();
      }
      return result;
    });
    if (cleanupFails)
      spyOn(h.historyService, "deleteMessages").mockResolvedValueOnce(
        Err("snapshot cleanup unavailable")
      );
    let durableReceipts = 0;
    const send = h.session.sendMessage.bind(h.session);
    spyOn(h.session, "sendMessage").mockImplementation((message, sendOptions, internal) =>
      send(message, sendOptions, {
        ...internal,
        onRowsDurable: () => {
          durableReceipts++;
          internal?.onRowsDurable?.();
        },
      })
    );
    const stream = spyOn(h.aiService, "streamMessage");
    try {
      const result = await h.internals.dispatchPendingFollowUp().catch((error: unknown) => error);
      if (failureMode === "guard I/O failure")
        expect(result).toHaveProperty(
          "message",
          "Failed to append history: guard storage unavailable"
        );
      else if (cleanupFails)
        expect(result).toHaveProperty(
          "message",
          "Failed to roll back preparation rows after compaction follow-up became stale"
        );
      else expect(result).toBe(false);
      expect(durableReceipts).toBe(0);
      expect(stream).not.toHaveBeenCalled();
      const rows = await foreignHistory.getHistoryFromLatestBoundary(workspaceId);
      expect(rows.success && rows.data.some((row) => row.role === "user")).toBe(false);
      expect(rows.success && rows.data.some((row) => row.id === ownSnapshot.id)).toBe(cleanupFails);
    } finally {
      await foreign.session.dispose();
      await h.session.dispose();
      await h.cleanup();
    }
  }
);

test("cancellation storage-access failures still block automatic startup recovery", async () => {
  const h = await setup();
  await h.historyService.appendToHistory(workspaceId, summary());
  spyOn(h.historyService, "readCompactionCancellation").mockRejectedValue(
    Object.assign(new Error("cancellation inaccessible"), { code: "EACCES" })
  );
  const compactor = (h.session as unknown as { continuousCompactor: ContinuousCompactor })
    .continuousCompactor;
  const recover = spyOn(compactor, "recover");
  const recoverGoal = spyOn(h.goalService, "recoverPendingDispatchAfterRestart");
  const stream = spyOn(h.aiService, "streamMessage");
  try {
    await h.session.runStartupRecovery();
    expect(recover).not.toHaveBeenCalled();
    expect(recoverGoal).not.toHaveBeenCalled();
    expect(stream).not.toHaveBeenCalled();
    const failure = await h.internals.dispatchPendingFollowUp().catch((error: unknown) => error);
    expect(failure).toHaveProperty("code", "EACCES");
    const rows = await h.historyService.getLastMessages(workspaceId, 1);
    expect(rows.success && rows.data[0].metadata?.muxMetadata).toHaveProperty("pendingFollowUp");
  } finally {
    await h.session.dispose();
    await h.cleanup();
  }
});

test.each(["quarantine", "journal", "history", "unlink"] as const)(
  "failed corrupt cancellation repair at %s retains the fence and retries safely",
  async (step) => {
    const h = await setup();
    await h.historyService.appendToHistory(workspaceId, summary());
    const cancellationPath = `${h.config.sessionsDir}/${workspaceId}/${COMPACTION_CANCELLATION_FILE}`;
    await writeFile(cancellationPath, "{");
    const journal = h.historyService.getContinuousCompactionJournal(workspaceId);
    await writeFile(journal.path, "interrupted journal");
    const failure = new Error(`${step} unavailable`);
    if (step === "quarantine") {
      const write = fs.writeFile;
      let failed = false;
      spyOn(fs, "writeFile").mockImplementation(async (...args) => {
        if (!failed && typeof args[0] === "string" && args[0].includes(".corrupt.")) {
          failed = true;
          throw failure;
        }
        return write(...args);
      });
    } else if (step === "journal") {
      spyOn(journal, "clear").mockRejectedValueOnce(failure);
    } else if (step === "unlink") {
      const remove = fs.rm;
      let failed = false;
      spyOn(fs, "rm").mockImplementation(async (...args) => {
        if (!failed && typeof args[0] === "string" && args[0] === cancellationPath) {
          failed = true;
          throw failure;
        }
        return remove(...args);
      });
    } else {
      const writes = h.historyService as unknown as {
        writeGuardedHistory(path: string, contents: string, guard: () => boolean): Promise<boolean>;
      };
      spyOn(writes, "writeGuardedHistory").mockRejectedValueOnce(failure);
    }
    const recoverGoal = spyOn(h.goalService, "recoverPendingDispatchAfterRestart");
    const stream = spyOn(h.aiService, "streamMessage");
    try {
      await h.session.runStartupRecovery();
      expect(recoverGoal).not.toHaveBeenCalled();
      expect(stream).not.toHaveBeenCalled();
      expect(await readFile(cancellationPath, "utf8")).toBe("{");
      expect(await journal.exists()).toBe(step === "quarantine" || step === "journal");
      const rows = await h.historyService.getLastMessages(workspaceId, 1);
      const metadata = rows.success && rows.data[0].metadata?.muxMetadata;
      if (step === "unlink") expect(metadata).not.toHaveProperty("pendingFollowUp");
      else expect(metadata).toHaveProperty("pendingFollowUp");
      await h.session.runStartupRecovery();
      expect(recoverGoal).toHaveBeenCalledTimes(1);
      expect(stream).not.toHaveBeenCalled();
      const freshHistory = new HistoryService(h.config);
      expect(await freshHistory.readCompactionCancellation(workspaceId)).toBeNull();
      expect(await freshHistory.getContinuousCompactionJournal(workspaceId).exists()).toBe(false);
      await expectNoRecovery(h.config, freshHistory);
    } finally {
      await h.session.dispose();
      await h.cleanup();
    }
  }
);

test("ordinary manual sends do not write cancellation state or attach a witness", async () => {
  const h = await setup();
  const write = spyOn(h.historyService, "writeCompactionCancellation");
  try {
    expect((await h.session.sendMessage("ordinary user", options)).success).toBe(true);
    const rows = await h.historyService.getHistoryFromLatestBoundary(workspaceId);
    expect(
      rows.success && rows.data.find((row) => row.role === "user")?.metadata
    ).not.toHaveProperty("compactionCancellationNonce");
    expect(write).not.toHaveBeenCalled();
  } finally {
    await h.session.dispose();
    await h.cleanup();
  }
});

test("Stop during cancellation loading retains exact summary cleanup", async () => {
  const h = await setup();
  await h.historyService.appendToHistory(workspaceId, summary());
  const entered = Promise.withResolvers<void>();
  const release = Promise.withResolvers<void>();
  const read = h.historyService.readCompactionCancellation.bind(h.historyService);
  spyOn(h.historyService, "readCompactionCancellation").mockImplementationOnce(async (...args) => {
    entered.resolve();
    await release.promise;
    return read(...args);
  });
  const pending = h.internals.dispatchPendingFollowUp();
  try {
    await entered.promise;
    await h.session.interruptStream({ abandonPartial: true });
    release.resolve();
    expect(await pending).toBe(false);
    const rows = await h.historyService.getLastMessages(workspaceId, 1);
    expect(rows.success && rows.data[0].metadata?.muxMetadata).not.toHaveProperty(
      "pendingFollowUp"
    );
    expect(await new HistoryService(h.config).readCompactionCancellation(workspaceId)).toBeNull();
  } finally {
    release.resolve();
    await pending;
    await h.session.dispose();
    await h.cleanup();
  }
});

test.each(["manual", "context replacement"] as const)(
  "explicit %s repairs a corrupt cancellation without permitting old automatic recovery",
  async (action) => {
    const h = await setup();
    await h.historyService.appendToHistory(workspaceId, summary());
    await writeFile(`${h.config.sessionsDir}/${workspaceId}/${COMPACTION_CANCELLATION_FILE}`, "{");
    const stream = spyOn(h.aiService, "streamMessage");
    try {
      await h.session.runStartupRecovery();
      expect(stream).not.toHaveBeenCalled();
      if (action === "manual") {
        expect((await h.session.sendMessage("explicit repair", options)).success).toBe(true);
      } else {
        using _hold = h.session.holdTurnAdmission();
        await h.historyService.clearHistory(workspaceId);
        await h.session.contextMutationCommitted();
      }
      expect(await new HistoryService(h.config).readCompactionCancellation(workspaceId)).toBeNull();
      const rows = await h.historyService.getHistoryFromLatestBoundary(workspaceId);
      expect(rows.success && rows.data.filter((row) => row.role === "user").length).toBe(
        action === "manual" ? 1 : 0
      );
      expect(stream).toHaveBeenCalledTimes(action === "manual" ? 1 : 0);
    } finally {
      await h.session.dispose();
      await h.cleanup();
    }
  }
);

test("explicit resume durably supersedes an earlier Stop without appending another user row", async () => {
  const h = await setup();
  await h.historyService.appendToHistory(
    workspaceId,
    createMuxMessage("original-user", "user", "original request")
  );
  await h.session.interruptStream({ abandonPartial: true });
  await h.session.retryPendingCompactionCleanup();
  expect(await new HistoryService(h.config).readCompactionCancellation(workspaceId)).not.toBeNull();
  try {
    expect((await h.session.resumeStream(options)).success).toBe(true);
    expect(await new HistoryService(h.config).readCompactionCancellation(workspaceId)).toBeNull();
    const rows = await h.historyService.getHistoryFromLatestBoundary(workspaceId);
    expect(rows.success && rows.data.filter((row) => row.role === "user").length).toBe(1);
  } finally {
    await h.session.dispose();
    await h.cleanup();
  }
});

test("a second Stop after the resume witness commits cannot be retired by the first nonce", async () => {
  const h = await setup();
  await h.historyService.appendToHistory(workspaceId, createMuxMessage("user", "user", "request"));
  await h.session.interruptStream({ abandonPartial: true });
  await h.session.retryPendingCompactionCleanup();
  const firstNonce = await h.session.getCompactionCancellationNonce();
  const entered = Promise.withResolvers<void>();
  const release = Promise.withResolvers<void>();
  const history = h.historyService as unknown as {
    writeGuardedHistory(
      path: string,
      serialized: string,
      guard: () => boolean,
      committed?: () => void
    ): Promise<boolean>;
  };
  const write = history.writeGuardedHistory.bind(history);
  spyOn(history, "writeGuardedHistory").mockImplementationOnce(async (...args) => {
    const committed = await write(...args);
    entered.resolve();
    await release.promise;
    return committed;
  });
  const stream = spyOn(h.aiService, "streamMessage");
  const resume = h.session.resumeStream(options);
  try {
    await entered.promise;
    await h.session.interruptStream({ abandonPartial: true });
    const secondNonce = await h.session.getCompactionCancellationNonce();
    expect(secondNonce).not.toBe(firstNonce);
    release.resolve();
    expect(await resume).toEqual(Ok({ started: false }));
    await h.session.retryPendingCompactionCleanup();
    expect(stream).not.toHaveBeenCalled();
    expect(
      (await new HistoryService(h.config).readCompactionCancellation(workspaceId))?.nonce
    ).toBe(secondNonce);
  } finally {
    release.resolve();
    await resume;
    await h.session.dispose();
    await h.cleanup();
  }
});

test.each(["history failure", "witness no-op", "automatic"] as const)(
  "resume keeps cancellation before explicit durable acceptance (%s)",
  async (outcome) => {
    const h = await setup();
    await h.historyService.appendToHistory(
      workspaceId,
      createMuxMessage("user", "user", "request")
    );
    await h.session.interruptStream({ abandonPartial: true });
    await h.session.retryPendingCompactionCleanup();
    const nonce = await h.session.getCompactionCancellationNonce();
    if (outcome === "history failure")
      spyOn(h.historyService, "getHistoryFromLatestBoundary").mockResolvedValueOnce(
        Err("resume history unavailable")
      );
    if (outcome === "witness no-op")
      spyOn(h.historyService, "updateHistory").mockResolvedValueOnce(Ok(undefined));
    const stream = spyOn(h.aiService, "streamMessage");
    try {
      await h.session.resumeStream(options, { automatic: outcome === "automatic" });
      expect(
        (await new HistoryService(h.config).readCompactionCancellation(workspaceId))?.nonce
      ).toBe(nonce);
      expect(stream).toHaveBeenCalledTimes(outcome === "automatic" ? 1 : 0);
    } finally {
      await h.session.dispose();
      await h.cleanup();
    }
  }
);

test.each(["user row", "summary only", "failed unlink"] as const)(
  "accepted explicit resume allows B's follow-up across restart (%s)",
  async (shape) => {
    const h = await setup();
    await h.historyService.appendToHistory(
      workspaceId,
      shape === "summary only" ? summary() : createMuxMessage("user", "user", "request")
    );
    await h.session.interruptStream({ abandonPartial: true });
    await h.session.retryPendingCompactionCleanup();
    const write = h.historyService.writeCompactionCancellation.bind(h.historyService);
    const writes = spyOn(h.historyService, "writeCompactionCancellation").mockImplementation(
      async (...args) => {
        if (shape === "failed unlink" && args[1] === null) throw new Error("resume unlink failed");
        return write(...args);
      }
    );
    try {
      await h.session.resumeStream(options).catch(() => undefined);
      // A new process first reconciles an already-durable Retry receipt if unlink failed.
      const freshHistory = new HistoryService(h.config);
      const restarted = await createAgentSessionHarness({
        workspaceId,
        config: h.config,
        historyService: freshHistory,
      });
      try {
        await restarted.session.runStartupRecovery();
        expect(await freshHistory.readCompactionCancellation(workspaceId)).toBeNull();
      } finally {
        await restarted.session.dispose();
      }
      await freshHistory.appendToHistory(
        workspaceId,
        createMuxMessage("summary-b", "assistant", "B compacted", {
          muxMetadata: {
            type: "compaction-summary",
            pendingFollowUp: { text: "Continue B", ...options },
          },
        })
      );
      const next = await createAgentSessionHarness({
        workspaceId,
        config: h.config,
        historyService: new HistoryService(h.config),
      });
      const stream = spyOn(next.aiService, "streamMessage");
      try {
        await next.session.runStartupRecovery();
        expect(stream).toHaveBeenCalledTimes(1);
        const rows = await freshHistory.getLastMessages(workspaceId, 1);
        expect(rows.success && rows.data[0].parts).toMatchObject([
          { type: "text", text: "Continue B" },
        ]);
      } finally {
        await next.session.dispose();
      }
    } finally {
      writes.mockRestore();
      await h.session.dispose().catch(() => undefined);
      await h.cleanup();
    }
  }
);

test.each(["cached absence", "changed nonce"] as const)(
  "a live backend observes another backend's durable Stop after %s",
  async (cached) => {
    const a = await setup();
    const bHistory = new HistoryService(a.config);
    const b = await createAgentSessionHarness({
      workspaceId,
      config: a.config,
      historyService: bHistory,
    });
    const bDispatch = (
      b.session as unknown as { dispatchPendingFollowUp(): Promise<boolean> }
    ).dispatchPendingFollowUp.bind(b.session);
    const bWrites = bHistory as unknown as {
      writeGuardedHistory(path: string, serialized: string, guard: () => boolean): Promise<boolean>;
    };
    const failedCleanup = spyOn(bWrites, "writeGuardedHistory").mockRejectedValue(
      new Error("cleanup unavailable in backend B")
    );
    const stream = spyOn(a.aiService, "streamMessage");
    try {
      await a.historyService.appendToHistory(workspaceId, summary());
      if (cached === "changed nonce") {
        await b.session.interruptStream({ abandonPartial: true });
        await b.session.retryPendingCompactionCleanup();
        await bDispatch().catch(() => undefined);
        expect((await bHistory.readCompactionCancellation(workspaceId))?.scope.kind).toBe(
          "summary"
        );
      }
      const cachedNonce = await a.session.getCompactionCancellationNonce();
      if (cached === "changed nonce") {
        await bHistory.clearHistory(workspaceId);
        await b.session.contextMutationCommitted();
        await bHistory.appendToHistory(
          workspaceId,
          createMuxMessage("summary-b", "assistant", "B compacted", {
            muxMetadata: {
              type: "compaction-summary",
              pendingFollowUp: { text: "Continue B", ...options },
            },
          })
        );
      }
      await b.session.interruptStream({ abandonPartial: true });
      await b.session.retryPendingCompactionCleanup();
      await bDispatch().catch(() => undefined);
      expect(
        (await new HistoryService(a.config).readCompactionCancellation(workspaceId))?.nonce
      ).not.toBe(cachedNonce);
      expect(await a.internals.dispatchPendingFollowUp()).toBe(false);
      expect(stream).not.toHaveBeenCalled();
    } finally {
      failedCleanup.mockRestore();
      await a.session.dispose().catch(() => undefined);
      await b.session.dispose().catch(() => undefined);
      await a.cleanup();
    }
  }
);

test("stale cross-backend summary cleanup cannot narrow or retire a successor Stop", async () => {
  const a = await setup();
  await a.historyService.appendToHistory(workspaceId, summary());
  const bHistory = new HistoryService(a.config);
  const b = await createAgentSessionHarness({
    workspaceId,
    config: a.config,
    historyService: bHistory,
  });
  const entered = Promise.withResolvers<void>();
  const release = Promise.withResolvers<void>();
  const read = a.historyService.readCompactionCancellation.bind(a.historyService);
  spyOn(a.historyService, "readCompactionCancellation").mockImplementationOnce(async (...args) => {
    entered.resolve();
    await release.promise;
    return read(...args);
  });
  const stale = a.internals.dispatchPendingFollowUp();
  try {
    await entered.promise;
    await bHistory.clearHistory(workspaceId);
    await bHistory.appendToHistory(
      workspaceId,
      createMuxMessage("summary-b", "assistant", "B compacted", {
        muxMetadata: {
          type: "compaction-summary",
          pendingFollowUp: { text: "Continue B", ...options },
        },
      })
    );
    await b.session.interruptStream({ abandonPartial: true });
    await b.session.retryPendingCompactionCleanup();
    const canceledB = await bHistory.readCompactionCancellation(workspaceId);
    release.resolve();
    expect(await stale).toBe(false);
    expect(await new HistoryService(a.config).readCompactionCancellation(workspaceId)).toEqual(
      canceledB
    );
    await expectNoRecovery(a.config, new HistoryService(a.config));
  } finally {
    release.resolve();
    await stale;
    await a.session.dispose();
    await b.session.dispose();
    await a.cleanup();
  }
});

test("failed cleanup cannot narrow a foreign replacement's newer Stop and preserves its original error", async () => {
  const a = await setup();
  await a.historyService.appendToHistory(workspaceId, summary());
  await a.session.interruptStream({ abandonPartial: true });
  await a.session.retryPendingCompactionCleanup();
  const bHistory = new HistoryService(a.config);
  const b = await createAgentSessionHarness({
    workspaceId,
    config: a.config,
    historyService: bHistory,
  });
  const entered = Promise.withResolvers<void>();
  const release = Promise.withResolvers<void>();
  const writes = a.historyService as unknown as {
    writeGuardedHistory(path: string, serialized: string, guard: () => boolean): Promise<boolean>;
  };
  spyOn(writes, "writeGuardedHistory").mockRejectedValueOnce(
    new Error("original guarded rewrite failed")
  );
  const update = a.historyService.updateHistory.bind(a.historyService);
  spyOn(a.historyService, "updateHistory").mockImplementationOnce(async (...args) => {
    const result = await update(...args);
    entered.resolve();
    await release.promise;
    return result;
  });
  const cleanup = a.internals.dispatchPendingFollowUp().catch((error: unknown) => error);
  try {
    await entered.promise;
    await bHistory.clearHistory(workspaceId);
    await bHistory.appendToHistory(
      workspaceId,
      createMuxMessage("summary-b", "assistant", "B compacted", {
        muxMetadata: {
          type: "compaction-summary",
          pendingFollowUp: { text: "Continue B", ...options },
        },
      })
    );
    await b.session.interruptStream({ abandonPartial: true });
    await b.session.retryPendingCompactionCleanup();
    const canceledB = await bHistory.readCompactionCancellation(workspaceId);
    release.resolve();
    expect(await cleanup).toHaveProperty(
      "message",
      expect.stringContaining("original guarded rewrite failed")
    );
    expect(await new HistoryService(a.config).readCompactionCancellation(workspaceId)).toEqual(
      canceledB
    );
    await expectNoRecovery(a.config, new HistoryService(a.config));
  } finally {
    release.resolve();
    await cleanup;
    await a.session.dispose();
    await b.session.dispose();
    await a.cleanup();
  }
});

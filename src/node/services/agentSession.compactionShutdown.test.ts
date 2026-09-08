import { makeTestEffectRunner } from "./di/testEffectRunner";
import { calculateBackoffDelay } from "@/common/utils/messages/retryState";
import * as fs from "node:fs/promises";
import { readFile, readdir, writeFile } from "node:fs/promises";
import { COMPACTION_CANCELLATION_FILE } from "@/common/constants/compactionCancellation";
import { CompactionCancellation } from "./compactionCancellation";
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
import { createAgentSessionHarness, createStreamLifecycleMocks } from "./agentSession.testHarness";

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
      const stopping = h.session.interruptStream({ abandonPartial: true });
      let closed = false;
      closing = (action === "shutdown" ? h.session.finishShutdown() : h.session.dispose()).then(
        () => {
          closed = true;
        }
      );
      await Promise.resolve();
      expect(closed).toBe(false);
      release.resolve();
      await stopping;
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
      const stopping = h.session.interruptStream({ abandonPartial: true });
      let closed = false;
      closing = h.session.finishShutdown().then(() => {
        closed = true;
      });
      await Promise.resolve();
      expect(closed).toBe(false);
      release.resolve();
      await stopping;
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
    const stopping = h.session.interruptStream({ abandonPartial: true });
    await entered.promise;
    spyOn(h.historyService, "appendToHistory").mockResolvedValueOnce(
      Err("replacement append failed")
    );
    const replacement = h.session.sendMessage("replacement", options);
    release.resolve();
    expect((await replacement).success).toBe(false);
    await stopping;
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

test.each([false, true])(
  "durable replacement retirement failure preserves acceptance or its genuine goal error (goal error=%s)",
  async (goalError) => {
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
    const accepted = mock(() => undefined);
    const visibleRows: string[] = [];
    const detach = h.session.onChatEvent(({ message }) => {
      if (message.type === "message" && message.role === "user") visibleRows.push(message.id);
    });
    if (goalError)
      spyOn(h.goalService, "syncGoalModeWithChatTail").mockRejectedValueOnce(
        new Error("genuine goal failure")
      );
    try {
      const result = await h.session
        .sendMessage("replacement", options, { onAccepted: accepted })
        .catch((error: unknown) => error);
      if (goalError) expect(result).toHaveProperty("message", "genuine goal failure");
      else expect(result).toHaveProperty("success", true);
      expect(stream).toHaveBeenCalledTimes(goalError ? 0 : 1);
      expect(accepted).toHaveBeenCalledTimes(goalError ? 0 : 1);
      expect(visibleRows).toHaveLength(goalError ? 0 : 1);
      expect(h.session.hasPendingCompactionCleanup).toBe(true);
      expect(h.session.hasBlockingCompactionCleanup).toBe(false);
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
      detach();
      writes.mockRestore();
      await h.session.dispose().catch(() => undefined);
      await h.cleanup();
    }
  }
);

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
        contextTokens: 99_000,
        maxTokens: 100_000,
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
        fileStates: [];
      } | null>;
    };
    spyOn(materializer, "materializeFileAtMentionsSnapshot").mockResolvedValue({
      snapshotMessage: ownSnapshot,
      materializedTokens: [],
      fileStates: [],
    });
    const foreignHistory = new HistoryService(h.config);
    const foreign = await createAgentSessionHarness({
      workspaceId,
      config: h.config,
      historyService: foreignHistory,
    });
    const append = h.historyService.appendManyToHistory.bind(h.historyService);
    spyOn(h.historyService, "appendManyToHistory").mockImplementationOnce(async (...args) => {
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
      return append(...args);
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
          "Failed to append to history: guard storage unavailable"
        );
      else expect(result).toBe(false);
      expect(durableReceipts).toBe(0);
      expect(stream).not.toHaveBeenCalled();
      const rows = await foreignHistory.getHistoryFromLatestBoundary(workspaceId);
      expect(rows.success && rows.data.some((row) => row.role === "user")).toBe(false);
      expect(rows.success && rows.data.some((row) => row.id === ownSnapshot.id)).toBe(false);
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
      spyOn(journal, "invalidateUnderHistoryLock").mockRejectedValueOnce(failure);
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
    const stopping = h.session.interruptStream({ abandonPartial: true });
    const secondNonce = (
      await (
        h.session as unknown as { compactionCancellation: CompactionCancellation }
      ).compactionCancellation.read()
    )?.nonce;
    expect(secondNonce).not.toBe(firstNonce);
    release.resolve();
    await stopping;
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
      spyOn(h.historyService, "acceptResumeCancellation").mockResolvedValueOnce(Ok(undefined));
    const stream = spyOn(h.aiService, "streamMessage");
    try {
      await h.session.resumeStream(options, { automatic: outcome === "automatic" });
      expect(
        (await new HistoryService(h.config).readCompactionCancellation(workspaceId))?.nonce
      ).toBe(nonce);
      expect(stream).not.toHaveBeenCalled();
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

test.each([
  ["legacy", false],
  ["failed apply", false],
  ["failed apply compact", false],
  ["legacy", true],
  ["failed apply", true],
  ["failed apply compact", true],
] as const)(
  "direct %s handoff honors another backend's durable Stop during preparation (narrowed=%s)",
  async (kind, narrowed) => {
    const h = await setup();
    await h.historyService.appendToHistory(
      workspaceId,
      narrowed ? { ...summary(), id: "original" } : createMuxMessage("original", "user", "Work")
    );
    const context = { modelString: options.model, options, providersConfig: null };
    const direct = h.session as unknown as {
      activeStreamContext: typeof context;
      interruptForCompaction(): Promise<void>;
      finishContinuousCompaction(
        applied: boolean,
        capturedContext: typeof context,
        token: NonNullable<ReturnType<TurnCoordinator["beginCompactionObservation"]>>
      ): Promise<void>;
      compactionMonitor: CompactionMonitor;
    };
    direct.activeStreamContext = context;
    if (kind === "failed apply compact")
      spyOn(direct.compactionMonitor, "checkBeforeSend").mockReturnValue({
        shouldShowWarning: true,
        shouldForceCompact: true,
        usagePercentage: 99,
        thresholdPercentage: 85,
        contextTokens: 99_000,
        maxTokens: 100_000,
      });
    const entered = Promise.withResolvers<void>();
    const release = Promise.withResolvers<void>();
    const pricing = h.goalService.assertPricedModelForBudgetedGoal.bind(h.goalService);
    spyOn(h.goalService, "assertPricedModelForBudgetedGoal").mockImplementationOnce(
      async (...args) => {
        const result = await pricing(...args);
        entered.resolve();
        await release.promise;
        return result;
      }
    );
    const token =
      kind === "legacy"
        ? undefined
        : h.internals.coordinator.beginCompactionObservation("continuous");
    if (token) h.internals.coordinator.setCompactionStage(token, "stopped");
    const pending =
      kind === "legacy"
        ? direct.interruptForCompaction()
        : direct.finishContinuousCompaction(false, context, token!);
    const stream = spyOn(h.aiService, "streamMessage");
    let cleanupForeign: (() => Promise<void>) | undefined;
    try {
      await entered.promise;
      const foreignHistory = new HistoryService(h.config);
      await new CompactionCancellation(foreignHistory, workspaceId).cancel();
      if (narrowed) {
        const foreign = await createAgentSessionHarness({
          workspaceId,
          config: h.config,
          historyService: foreignHistory,
        });
        const writes = foreignHistory as unknown as {
          writeGuardedHistory(
            path: string,
            serialized: string,
            guard: () => boolean
          ): Promise<boolean>;
        };
        const failure = spyOn(writes, "writeGuardedHistory").mockRejectedValue(
          new Error("foreign summary rewrite failed")
        );
        cleanupForeign = async () => {
          failure.mockRestore();
          await foreign.session.dispose();
        };
        await foreign.session.runStartupRecovery();
        expect((await foreignHistory.readCompactionCancellation(workspaceId))?.scope.kind).toBe(
          "summary"
        );
      }
      release.resolve();
      await pending;
      expect(stream).not.toHaveBeenCalled();
      const rows = await h.historyService.getHistoryFromLatestBoundary(workspaceId);
      expect(rows.success && rows.data.map((row) => row.id)).toEqual(["original"]);
    } finally {
      release.resolve();
      await pending.catch(() => undefined);
      await cleanupForeign?.();
      if (token) h.internals.coordinator.finishCompactionObservation(token);
      await h.session.dispose();
      await h.cleanup();
    }
  }
);

test("idle Stop reports cancellation publication failure instead of success", async () => {
  const h = await setup();
  const write = spyOn(h.historyService, "writeCompactionCancellation").mockRejectedValue(
    new Error("Stop publication failed")
  );
  try {
    const stopped = await h.session.interruptStream({ abandonPartial: true });
    expect(stopped).toEqual(Err("Stop publication failed"));
    expect(h.session.hasPendingCompactionCleanup).toBe(true);
  } finally {
    write.mockRestore();
    await h.session.dispose();
    await h.cleanup();
  }
});

test("idle Stop cannot acknowledge before its held publication commits", async () => {
  const h = await setup();
  const entered = Promise.withResolvers<void>();
  const release = Promise.withResolvers<void>();
  let committed = false;
  const write = h.historyService.writeCompactionCancellation.bind(h.historyService);
  spyOn(h.historyService, "writeCompactionCancellation").mockImplementationOnce(async (...args) => {
    entered.resolve();
    await release.promise;
    await write(...args);
    committed = true;
  });
  const stopping = h.session
    .interruptStream({ abandonPartial: true })
    .then((result) => {
      expect(committed).toBe(true);
      return result;
    })
    .catch((error: unknown) => error);
  try {
    await entered.promise;
    expect(await new HistoryService(h.config).readCompactionCancellation(workspaceId)).toBeNull();
    release.resolve();
    expect(await stopping).toEqual(Ok(undefined));
  } finally {
    release.resolve();
    await stopping;
    await h.session.dispose();
    await h.cleanup();
  }
});

test("overlapping Stops wait for the newest publication when the older write becomes a no-op", async () => {
  const h = await setup();
  const firstEntered = Promise.withResolvers<void>();
  const firstRelease = Promise.withResolvers<void>();
  const secondEntered = Promise.withResolvers<void>();
  const secondRelease = Promise.withResolvers<void>();
  let secondCommitted = false;
  const write = h.historyService.writeCompactionCancellation.bind(h.historyService);
  spyOn(h.historyService, "writeCompactionCancellation")
    .mockImplementationOnce(async (...args) => {
      firstEntered.resolve();
      await firstRelease.promise;
      return write(...args);
    })
    .mockImplementationOnce(async (...args) => {
      secondEntered.resolve();
      await secondRelease.promise;
      await write(...args);
      secondCommitted = true;
    });
  const first = h.session
    .interruptStream({ abandonPartial: true })
    .then((result) => {
      expect(secondCommitted).toBe(true);
      return result;
    })
    .catch((error: unknown) => error);
  let second: ReturnType<typeof h.session.interruptStream> | undefined;
  try {
    await firstEntered.promise;
    second = h.session.interruptStream({ abandonPartial: true });
    firstRelease.resolve();
    await secondEntered.promise;
    expect(await new HistoryService(h.config).readCompactionCancellation(workspaceId)).toBeNull();
    secondRelease.resolve();
    expect(await first).toEqual(Ok(undefined));
    expect(await second).toEqual(Ok(undefined));
  } finally {
    firstRelease.resolve();
    secondRelease.resolve();
    await first;
    await second;
    await h.session.dispose();
    await h.cleanup();
  }
});

test.each([false, true])(
  "explicit Retry rejects a foreign Stop after capture (initial Stop=%s)",
  async (initialStop) => {
    const h = await setup();
    await h.historyService.appendToHistory(workspaceId, createMuxMessage("user", "user", "Work"));
    if (initialStop) await h.session.interruptStream({ abandonPartial: true });
    const capture = h.session.getCompactionCancellationNonce.bind(h.session);
    const entered = Promise.withResolvers<void>();
    const release = Promise.withResolvers<void>();
    spyOn(h.session, "getCompactionCancellationNonce").mockImplementationOnce(async () => {
      const nonce = await capture();
      entered.resolve();
      await release.promise;
      return nonce;
    });
    const stream = spyOn(h.aiService, "streamMessage");
    const pending = h.session.resumeStream(options);
    try {
      await entered.promise;
      const foreign = new CompactionCancellation(new HistoryService(h.config), workspaceId);
      await foreign.cancel();
      const stopped = await foreign.read();
      release.resolve();
      expect(await pending).toEqual(Ok({ started: false }));
      expect(stream).not.toHaveBeenCalled();
      const rows = await h.historyService.getLastMessages(workspaceId, 1);
      expect(rows.success && rows.data[0].metadata).not.toHaveProperty(
        "compactionCancellationNonce"
      );
      expect(await new HistoryService(h.config).readCompactionCancellation(workspaceId)).toEqual(
        stopped
      );
    } finally {
      release.resolve();
      await pending.catch(() => undefined);
      await h.session.dispose();
      await h.cleanup();
    }
  }
);

test.each([
  "absent",
  "witnessed debt",
  "retirement failure",
  "shared read failure",
  "witness write failure",
] as const)("explicit Retry locked acceptance handles %s", async (state) => {
  const h = await setup();
  const user = createMuxMessage("user", "user", "Work", {
    requestPreludeMessageIds: ["owned-prelude"],
  });
  await h.historyService.appendToHistory(workspaceId, user);
  const cancellation = (h.session as unknown as { compactionCancellation: CompactionCancellation })
    .compactionCancellation;
  const debt = state === "witnessed debt" || state === "retirement failure";
  let restoreWrites: (() => void) | undefined;
  if (debt) {
    await h.session.interruptStream({ abandonPartial: true });
    const record = await cancellation.read();
    if (!record) throw new Error("Expected Stop");
    const write = h.historyService.writeCompactionCancellation.bind(h.historyService);
    const writes = spyOn(h.historyService, "writeCompactionCancellation").mockImplementation(
      async (...args) => {
        if (args[1] === null) throw new Error("unlink unavailable");
        return write(...args);
      }
    );
    restoreWrites = () => writes.mockRestore();
    if (state === "witnessed debt") {
      await h.historyService.updateHistory(workspaceId, {
        ...user,
        metadata: { ...user.metadata, compactionCancellationNonce: record.nonce },
      });
      await cancellation.retireReplacement(record.nonce).catch(() => undefined);
      expect(await cancellation.read()).toBeNull();
    }
  }
  if (state === "shared read failure") {
    const capture = h.session.getCompactionCancellationNonce.bind(h.session);
    spyOn(h.session, "getCompactionCancellationNonce").mockImplementationOnce(async () => {
      const nonce = await capture();
      spyOn(h.historyService, "readCompactionCancellation").mockRejectedValueOnce(
        new Error("shared storage unavailable")
      );
      return nonce;
    });
  }
  if (state === "witness write failure") {
    const writes = h.historyService as unknown as {
      writeGuardedHistory(path: string, serialized: string, guard: () => boolean): Promise<boolean>;
    };
    spyOn(writes, "writeGuardedHistory").mockRejectedValueOnce(
      new Error("witness storage unavailable")
    );
  }
  const stream = spyOn(h.aiService, "streamMessage");
  try {
    const result = await h.session.resumeStream(options);
    const storageFailure = state === "shared read failure" || state === "witness write failure";
    if (storageFailure) {
      expect(result.success).toBe(false);
      expect(JSON.stringify(result)).toContain("storage unavailable");
    } else expect(result).toEqual(Ok({ started: true }));
    expect(stream).toHaveBeenCalledTimes(storageFailure ? 0 : 1);
    expect(cancellation.needsPersistence).toBe(debt);
    if (debt) expect(h.session.hasBlockingCompactionCleanup).toBe(false);
    const rows = await h.historyService.getHistoryFromLatestBoundary(workspaceId);
    expect(
      rows.success && rows.data.filter((row) => row.role === "user").map((row) => row.id)
    ).toEqual([user.id]);
    expect(rows.success && rows.data[0].metadata?.requestPreludeMessageIds).toEqual([
      "owned-prelude",
    ]);
  } finally {
    restoreWrites?.();
    await h.session.dispose();
    await h.cleanup();
  }
});

test.each(
  [false, true].flatMap((tokenBudget) =>
    ["accepted", "foreign Stop", "raw reset", "append failure"].map((action) => ({
      tokenBudget,
      action,
    }))
  )
)(
  "handoff batch preserves locked admission ($action, tokenBudget=$tokenBudget)",
  async ({ action, tokenBudget }) => {
    const h = await setup();
    const source = summary();
    source.metadata = {
      ...source.metadata,
      muxMetadata: {
        type: "compaction-summary",
        pendingFollowUp: { text: "Continue", ...options, experiments: { tokenBudget } },
      },
    };
    await h.historyService.appendToHistory(workspaceId, source);
    const snapshot = createMuxMessage("owned-snapshot", "assistant", "Expanded context", {
      synthetic: true,
    });
    const materializer = h.session as unknown as {
      materializeFileAtMentionsSnapshot(text: string): Promise<{
        snapshotMessage: ReturnType<typeof createMuxMessage>;
        materializedTokens: string[];
        fileStates: [];
      } | null>;
    };
    spyOn(materializer, "materializeFileAtMentionsSnapshot").mockResolvedValue({
      snapshotMessage: snapshot,
      materializedTokens: [],
      fileStates: [],
    });
    const append = h.historyService.appendManyToHistory.bind(h.historyService);
    const batch = spyOn(h.historyService, "appendManyToHistory").mockImplementationOnce(
      async (...args) => {
        if (action === "foreign Stop")
          await new CompactionCancellation(new HistoryService(h.config), workspaceId).cancel();
        if (action === "raw reset")
          await fs.appendFile(
            `${h.config.sessionsDir}/${workspaceId}/chat.jsonl`,
            '{"metadata":{"contextBoundaryKind":"reset"},broken\n'
          );
        if (action === "append failure") return Err("batch storage unavailable");
        return append(...args);
      }
    );
    const send = h.session.sendMessage.bind(h.session);
    const durable = mock(() => undefined);
    spyOn(h.session, "sendMessage").mockImplementation((message, sendOptions, internal) =>
      send(message, sendOptions, {
        ...internal,
        onRowsDurable: () => {
          durable();
          internal?.onRowsDurable?.();
        },
      })
    );
    const stream = spyOn(h.aiService, "streamMessage");
    try {
      const result = await h.internals.dispatchPendingFollowUp().catch((error: unknown) => error);
      if (action === "append failure")
        expect(result).toHaveProperty("message", "batch storage unavailable");
      else expect(result).toBe(action === "accepted");
      expect(batch).toHaveBeenCalledTimes(1);
      expect(batch.mock.calls[0][1]).toHaveLength(2);
      expect(durable).toHaveBeenCalledTimes(action === "accepted" ? 1 : 0);
      expect(stream).toHaveBeenCalledTimes(action === "accepted" ? 1 : 0);
      const rows = await h.historyService.getLastMessages(workspaceId, 10);
      expect(rows.success && rows.data.some((row) => row.id === snapshot.id)).toBe(
        action === "accepted"
      );
    } finally {
      await h.session.dispose();
      await h.cleanup();
    }
  }
);

test.each(["empty", "raw reset", "journal only"])(
  "startup retains a settled Stop on %s history against a late foreign summary",
  async (state) => {
    const h = await setup();
    try {
      await h.session.interruptStream({ abandonPartial: true });
      if (state === "raw reset") {
        await h.historyService.appendToHistory(
          workspaceId,
          createMuxMessage("private", "user", "Old context")
        );
        await fs.appendFile(
          `${h.config.sessionsDir}/${workspaceId}/chat.jsonl`,
          '{"metadata":{"contextBoundaryKind":"reset"},broken\n'
        );
      }
      if (state === "journal only")
        await writeFile(
          h.historyService.getContinuousCompactionJournal(workspaceId).path,
          "old journal"
        );
      const stopped = await h.historyService.readCompactionCancellation(workspaceId);
      await h.session.runStartupRecovery();
      const foreign = new HistoryService(h.config);
      expect(await foreign.readCompactionCancellation(workspaceId)).toEqual(stopped);
      expect(h.session.hasBlockingCompactionCleanup).toBe(false);
      await foreign.appendToHistory(workspaceId, summary());
      await expectNoRecovery(h.config, foreign);
      expect((await h.session.sendMessage("Explicit replacement", options)).success).toBe(true);
      expect(await foreign.readCompactionCancellation(workspaceId)).toBeNull();
    } finally {
      await h.session.dispose();
      await h.cleanup();
    }
  }
);

test("failed legacy compaction preflight releases idle waiters without a stream terminal", async () => {
  const h = await setup();
  await h.historyService.appendToHistory(workspaceId, createMuxMessage("original", "user", "Work"));
  const direct = h.session as unknown as {
    activeStreamContext: { modelString: string; options: typeof options; providersConfig: null };
    interruptForCompaction(): Promise<void>;
  };
  direct.activeStreamContext = { modelString: options.model, options, providersConfig: null };
  const entered = Promise.withResolvers<void>();
  const release = Promise.withResolvers<void>();
  spyOn(h.goalService, "assertPricedModelForBudgetedGoal").mockImplementationOnce(async () => {
    entered.resolve();
    await release.promise;
    throw new Error("legacy preparation unavailable");
  });
  const stream = spyOn(h.aiService, "streamMessage");
  const pending = direct.interruptForCompaction().catch((error: unknown) => error);
  try {
    await entered.promise;
    let settled = false;
    const waiting = h.session.waitForMidStreamCompactionSettled().then(() => {
      settled = true;
    });
    await Promise.resolve();
    expect(settled).toBe(false);
    release.resolve();
    await pending;
    await waiting;
    expect(settled).toBe(true);
    expect(stream).not.toHaveBeenCalled();
    expect(h.session.hasActiveOrPendingTurnWork()).toBe(false);
  } finally {
    release.resolve();
    await pending;
    await h.session.dispose();
    await h.cleanup();
  }
});

test("cancelable acceptance precedes blocked cancellation retirement and runs once", async () => {
  const h = await setup();
  await h.session.interruptStream({ abandonPartial: true });
  const entered = Promise.withResolvers<void>();
  const release = Promise.withResolvers<void>();
  const write = h.historyService.writeCompactionCancellation.bind(h.historyService);
  spyOn(h.historyService, "writeCompactionCancellation").mockImplementation(async (...args) => {
    if (args[1] === null) {
      entered.resolve();
      await release.promise;
    }
    return write(...args);
  });
  const accepted = mock(() => undefined);
  const controller = new AbortController();
  const pending = h.session.sendMessage("Explicit replacement", options, {
    cancelSignal: controller.signal,
    onAccepted: accepted,
  });
  try {
    await entered.promise;
    expect(accepted).toHaveBeenCalledTimes(1);
    release.resolve();
    expect((await pending).success).toBe(true);
    expect(accepted).toHaveBeenCalledTimes(1);
    expect(await h.historyService.readCompactionCancellation(workspaceId)).toBeNull();
  } finally {
    release.resolve();
    await pending;
    await h.session.dispose();
    await h.cleanup();
  }
});

test.each(
  [false, true].flatMap((initialStop) =>
    [
      "single",
      "token-budget single",
      "token-budget batch",
      "pre-turn batch",
      "on-send compaction",
    ].map((branch) => ({ initialStop, branch }))
  )
)(
  "manual $branch rejects a foreign Stop after capture (initial Stop=$initialStop)",
  async ({ initialStop, branch }) => {
    const h = await setup();
    await h.historyService.appendToHistory(
      workspaceId,
      createMuxMessage("original", "user", "Earlier work")
    );
    if (initialStop) await h.session.interruptStream({ abandonPartial: true });
    if (branch === "on-send compaction") {
      const monitor = (h.session as unknown as { compactionMonitor: CompactionMonitor })
        .compactionMonitor;
      spyOn(monitor, "checkBeforeSend").mockReturnValue({
        shouldShowWarning: true,
        shouldForceCompact: true,
        usagePercentage: 99,
        thresholdPercentage: 85,
        contextTokens: 99_000,
        maxTokens: 100_000,
      });
    }
    if (branch === "token-budget batch") {
      const materializer = h.session as unknown as {
        materializeFileAtMentionsSnapshot(text: string): Promise<{
          snapshotMessage: ReturnType<typeof createMuxMessage>;
          materializedTokens: string[];
          fileStates: [];
        } | null>;
      };
      spyOn(materializer, "materializeFileAtMentionsSnapshot").mockResolvedValue({
        snapshotMessage: createMuxMessage("snapshot", "assistant", "Context", { synthetic: true }),
        materializedTokens: [],
        fileStates: [],
      });
    }
    const capture = h.session.getCompactionCancellationNonce.bind(h.session);
    const entered = Promise.withResolvers<void>();
    const release = Promise.withResolvers<void>();
    spyOn(h.session, "getCompactionCancellationNonce").mockImplementationOnce(async () => {
      const nonce = await capture();
      entered.resolve();
      await release.promise;
      return nonce;
    });
    const stream = spyOn(h.aiService, "streamMessage");
    const durable = mock(() => undefined);
    const pending = h.session.sendMessage(
      "Manual replacement",
      {
        ...options,
        ...(branch.startsWith("token-budget") ? { experiments: { tokenBudget: true } } : {}),
      },
      {
        onRowsDurable: durable,
        ...(branch === "pre-turn batch"
          ? {
              preTurnMessages: [
                createMuxMessage("payload", "assistant", "Payload", { synthetic: true }),
              ],
            }
          : {}),
      }
    );
    try {
      await entered.promise;
      const foreign = new CompactionCancellation(new HistoryService(h.config), workspaceId);
      await foreign.cancel();
      const stopped = await foreign.read();
      release.resolve();
      expect((await pending).success).toBe(false);
      expect(stream).not.toHaveBeenCalled();
      expect(durable).not.toHaveBeenCalled();
      const rows = await h.historyService.getHistoryFromLatestBoundary(workspaceId);
      expect(rows.success && rows.data.map((row) => row.id)).toEqual(["original"]);
      expect(await new HistoryService(h.config).readCompactionCancellation(workspaceId)).toEqual(
        stopped
      );
    } finally {
      release.resolve();
      await pending.catch(() => undefined);
      await h.session.dispose();
      await h.cleanup();
    }
  }
);

test.each([false, true])(
  "live dispatch reconciles a foreign replacement witness (archived=%s)",
  async (archived) => {
    const h = await setup();
    const foreign = new HistoryService(h.config);
    const stop = new CompactionCancellation(foreign, workspaceId);
    await stop.cancel();
    const record = await stop.read();
    if (!record) throw new Error("Expected Stop");
    await foreign.appendToHistory(
      workspaceId,
      createMuxMessage("replacement", "user", "Fresh work", {
        compactionCancellationNonce: record.nonce,
      })
    );
    spyOn(foreign, "writeCompactionCancellation").mockRejectedValueOnce(
      new Error("unlink unavailable")
    );
    expect(
      await stop.retireReplacement(record.nonce).catch((error: unknown) => error)
    ).toHaveProperty("message", "unlink unavailable");
    expect(await foreign.readCompactionCancellation(workspaceId)).toEqual(record);
    const boundary = summary();
    if (archived)
      boundary.metadata = {
        ...boundary.metadata,
        compacted: "user",
        compactionBoundary: true,
        compactionEpoch: 1,
      };
    await foreign.appendToHistory(workspaceId, boundary);
    const stream = spyOn(h.aiService, "streamMessage");
    try {
      expect(await h.internals.dispatchPendingFollowUp()).toBe(true);
      expect(stream).toHaveBeenCalledTimes(1);
      const rows = await foreign.getLastMessages(workspaceId, 1);
      expect(rows.success && rows.data[0].role).toBe("user");
    } finally {
      await h.session.dispose();
      await h.cleanup();
    }
  }
);

test("interrupted handoff snapshot persistence leaves a fresh service able to recover", async () => {
  const h = await setup();
  await h.historyService.appendToHistory(workspaceId, summary());
  const snapshot = createMuxMessage("interrupted-snapshot", "user", "Expanded context", {
    synthetic: true,
  });
  const materializer = h.session as unknown as {
    materializeAgentSkillSnapshots(): Promise<Array<ReturnType<typeof createMuxMessage>>>;
    materializeMcpPromptSnapshots(): Promise<Array<ReturnType<typeof createMuxMessage>>>;
    materializeFileAtMentionsSnapshot(text: string): Promise<{
      snapshotMessage: ReturnType<typeof createMuxMessage>;
      materializedTokens: string[];
      fileStates: [];
    } | null>;
  };
  spyOn(materializer, "materializeFileAtMentionsSnapshot").mockResolvedValue({
    snapshotMessage: snapshot,
    materializedTokens: [],
    fileStates: [],
  });
  spyOn(materializer, "materializeAgentSkillSnapshots").mockResolvedValue([
    createMuxMessage("skill-prelude", "user", "Skill context", { synthetic: true }),
  ]);
  spyOn(materializer, "materializeMcpPromptSnapshots").mockResolvedValue([
    createMuxMessage("mcp-prelude", "user", "MCP context", { synthetic: true }),
  ]);
  const entered = Promise.withResolvers<void>();
  const release = Promise.withResolvers<void>();
  const append = h.historyService.appendToHistory.bind(h.historyService);
  spyOn(h.historyService, "appendToHistory").mockImplementationOnce(async (...args) => {
    const result = await append(...args);
    entered.resolve();
    await release.promise;
    return result;
  });
  const batch = h.historyService.appendManyToHistory.bind(h.historyService);
  spyOn(h.historyService, "appendManyToHistory").mockImplementationOnce(async (...args) => {
    // Simulate process loss before publication by observing disk from an independent service.
    entered.resolve();
    await release.promise;
    return batch(...args);
  });
  const pending = h.internals.dispatchPendingFollowUp();
  let fresh: Awaited<ReturnType<typeof createAgentSessionHarness>> | undefined;
  try {
    await entered.promise;
    fresh = await createAgentSessionHarness({
      workspaceId,
      config: h.config,
      historyService: new HistoryService(h.config),
    });
    const recoveredStream = spyOn(fresh.aiService, "streamMessage");
    await fresh.session.runStartupRecovery();
    expect(recoveredStream).toHaveBeenCalledTimes(1);
    const recovered = await fresh.historyService.getLastMessages(workspaceId, 1);
    expect(recovered.success && recovered.data[0].parts).toMatchObject([
      { type: "text", text: "Continue" },
    ]);
  } finally {
    release.resolve();
    await pending.catch(() => undefined);
    await fresh?.session.dispose();
    await h.session.dispose();
    await h.cleanup();
  }
});

test("Stop survives failed rollback of a committed handoff snapshot batch across restart", async () => {
  const h = await setup();
  const clock = makeTestEffectRunner();
  await h.historyService.appendToHistory(workspaceId, summary());
  const snapshot = createMuxMessage("retained-snapshot", "user", "Expanded context", {
    synthetic: true,
  });
  const materializer = h.session as unknown as {
    materializeFileAtMentionsSnapshot(text: string): Promise<{
      snapshotMessage: ReturnType<typeof createMuxMessage>;
      materializedTokens: string[];
      fileStates: [];
    } | null>;
  };
  spyOn(materializer, "materializeFileAtMentionsSnapshot").mockResolvedValue({
    snapshotMessage: snapshot,
    materializedTokens: [],
    fileStates: [],
  });
  const append = h.historyService.appendManyToHistory.bind(h.historyService);
  spyOn(h.historyService, "appendManyToHistory").mockImplementationOnce(async (...args) => {
    const result = await append(...args);
    await h.session.interruptStream({ abandonPartial: true });
    return result;
  });
  spyOn(h.historyService, "deleteMessages").mockResolvedValue(Err("rollback unavailable"));
  const stream = spyOn(h.aiService, "streamMessage");
  try {
    await h.internals.dispatchPendingFollowUp();
    expect(stream).not.toHaveBeenCalled();
    const foreign = new HistoryService(h.config);
    expect(await foreign.readCompactionCancellation(workspaceId)).not.toBeNull();
    const rows = await foreign.getHistoryFromLatestBoundary(workspaceId);
    expect(rows.success && rows.data.filter((row) => row.role === "user")).toHaveLength(2);
    const fresh = await createAgentSessionHarness({
      workspaceId,
      config: h.config,
      historyService: foreign,
      streamManager: { ...createStreamLifecycleMocks(), effectRunner: clock.runner },
      captureEvents: true,
    });
    try {
      const recovered = spyOn(fresh.aiService, "streamMessage");
      const retries = fresh.session as unknown as { retryActiveStream(): Promise<void> };
      const deliver = spyOn(retries, "retryActiveStream");
      await fresh.session.runStartupRecovery();
      await clock.adjust(calculateBackoffDelay(6) * 2);
      // Deliver any armed retry and join its actual callback before checking provider entry.
      await Promise.all(deliver.mock.results.map((result) => result.value));
      expect(deliver).not.toHaveBeenCalled();
      expect(fresh.events.some((event) => event.type === "auto-retry-scheduled")).toBe(false);
      expect(recovered).not.toHaveBeenCalled();
      expect(await foreign.readCompactionCancellation(workspaceId)).not.toBeNull();
    } finally {
      await fresh.session.dispose();
    }
  } finally {
    await h.session.dispose();
    await h.cleanup();
    await clock.dispose();
  }
});

test.each(["witness read", "retirement"] as const)(
  "live witness reconciliation preserves newer Stop during %s",
  async (stage) => {
    const h = await setup();
    const foreign = new HistoryService(h.config);
    const cancellation = new CompactionCancellation(foreign, workspaceId);
    await cancellation.cancel();
    const record = await cancellation.read();
    if (!record) throw new Error("Expected Stop");
    await foreign.appendToHistory(
      workspaceId,
      createMuxMessage("replacement", "user", "Work", { compactionCancellationNonce: record.nonce })
    );
    await foreign.appendToHistory(workspaceId, summary());
    const entered = Promise.withResolvers<void>();
    const release = Promise.withResolvers<void>();
    if (stage === "witness read") {
      const read = h.historyService.hasCompactionReplacementWitness.bind(h.historyService);
      spyOn(h.historyService, "hasCompactionReplacementWitness").mockImplementationOnce(
        async (...args) => {
          const result = await read(...args);
          entered.resolve();
          await release.promise;
          return result;
        }
      );
    } else {
      const write = h.historyService.writeCompactionCancellation.bind(h.historyService);
      spyOn(h.historyService, "writeCompactionCancellation").mockImplementationOnce(
        async (...args) => {
          entered.resolve();
          await release.promise;
          return write(...args);
        }
      );
    }
    const stream = spyOn(h.aiService, "streamMessage");
    const pending = h.internals.dispatchPendingFollowUp();
    try {
      await entered.promise;
      await cancellation.cancel();
      const newer = await cancellation.read();
      // Keep the newer cancellation observable through a failed durable cleanup.
      const writes = h.historyService as unknown as {
        writeGuardedHistory(
          path: string,
          serialized: string | Buffer,
          guard: () => boolean
        ): Promise<boolean>;
      };
      spyOn(writes, "writeGuardedHistory").mockRejectedValueOnce(new Error("cleanup unavailable"));
      release.resolve();
      expect(await pending.catch((error: unknown) => error)).toHaveProperty(
        "message",
        "Failed to clear skipped pending follow-up: Failed to update history: cleanup unavailable"
      );
      expect(stream).not.toHaveBeenCalled();
      expect((await foreign.readCompactionCancellation(workspaceId))?.nonce).toBe(newer?.nonce);
    } finally {
      release.resolve();
      await pending.catch(() => undefined);
      await h.session.dispose();
      await h.cleanup();
    }
  }
);

test("cancellation cleanup rechecks a replacement witness under the summary write lock", async () => {
  const h = await setup();
  const foreign = new HistoryService(h.config);
  const user = createMuxMessage("replacement", "user", "Work");
  await foreign.appendToHistory(workspaceId, user);
  const boundary = summary();
  await foreign.appendToHistory(workspaceId, boundary);
  const cancellation = new CompactionCancellation(foreign, workspaceId);
  await cancellation.cancel();
  const record = await cancellation.read();
  if (!record) throw new Error("Expected Stop");
  const update = h.historyService.updateHistory.bind(h.historyService);
  spyOn(h.historyService, "updateHistory").mockImplementationOnce(async (...args) => {
    await foreign.updateHistory(workspaceId, {
      ...user,
      metadata: { ...user.metadata, compactionCancellationNonce: record.nonce },
    });
    return update(...args);
  });
  try {
    expect(await h.internals.dispatchPendingFollowUp()).toBe(false);
    const rows = await foreign.getLastMessages(workspaceId, 1);
    expect(rows.success && rows.data[0].metadata?.muxMetadata).toHaveProperty("pendingFollowUp");
  } finally {
    await h.session.dispose();
    await h.cleanup();
  }
});

test.each(["absence", "witnessed debt", "Stop after commit"] as const)(
  "manual locked acceptance handles %s",
  async (state) => {
    const h = await setup();
    const cancellation = (
      h.session as unknown as { compactionCancellation: CompactionCancellation }
    ).compactionCancellation;
    let captured: string | undefined;
    let newer: string | undefined;
    let restoreWrite: (() => void) | undefined;
    if (state !== "absence") {
      await h.session.interruptStream({ abandonPartial: true });
      captured = await h.session.getCompactionCancellationNonce();
      if (!captured) throw new Error("Expected Stop");
      if (state === "witnessed debt") {
        await h.historyService.appendToHistory(
          workspaceId,
          createMuxMessage("accepted-earlier", "user", "Work", {
            compactionCancellationNonce: captured,
          })
        );
        const write = h.historyService.writeCompactionCancellation.bind(h.historyService);
        const spy = spyOn(h.historyService, "writeCompactionCancellation").mockImplementation(
          (...args) =>
            args[1] === null ? Promise.reject(new Error("unlink unavailable")) : write(...args)
        );
        restoreWrite = () => spy.mockRestore();
        await cancellation.retireReplacement(captured).catch(() => undefined);
        expect(await h.session.getCompactionCancellationNonce()).toBeUndefined();
      } else {
        const append = h.historyService.appendToHistory.bind(h.historyService);
        spyOn(h.historyService, "appendToHistory").mockImplementationOnce(async (...args) => {
          const result = await append(...args);
          const foreign = new CompactionCancellation(new HistoryService(h.config), workspaceId);
          await foreign.cancel();
          newer = (await foreign.read())?.nonce;
          return result;
        });
      }
    }
    const durable = mock(() => undefined);
    const accepted = mock(() => undefined);
    const stream = spyOn(h.aiService, "streamMessage");
    try {
      expect(
        (
          await h.session.sendMessage("Accepted work", options, {
            onRowsDurable: durable,
            onAccepted: accepted,
          })
        ).success
      ).toBe(true);
      expect(durable).toHaveBeenCalledTimes(1);
      expect(accepted).toHaveBeenCalledTimes(1);
      expect(stream).toHaveBeenCalledTimes(1);
      const foreign = new HistoryService(h.config);
      const rows = await foreign.getLastMessages(workspaceId, 1);
      expect(rows.success && rows.data[0].metadata?.compactionCancellationNonce).toBe(
        state === "Stop after commit" ? captured : undefined
      );
      if (state === "Stop after commit")
        expect((await foreign.readCompactionCancellation(workspaceId))?.nonce).toBe(newer);
      if (state === "witnessed debt") expect(cancellation.blocksRecovery).toBe(false);
    } finally {
      restoreWrite?.();
      await h.session.dispose();
      await h.cleanup();
    }
  }
);

test.each([false, true])(
  "manual replacement retries a failed Stop publication (storage still fails=%s)",
  async (persistent) => {
    const h = await setup();
    const write = spyOn(h.historyService, "writeCompactionCancellation").mockRejectedValueOnce(
      new Error("Stop disk unavailable")
    );
    const stream = spyOn(h.aiService, "streamMessage");
    try {
      expect((await h.session.interruptStream({ abandonPartial: true })).success).toBe(false);
      if (persistent) write.mockRejectedValue(new Error("Stop disk unavailable"));
      const result = await h.session
        .sendMessage("Fresh explicit work", options)
        .catch((error: unknown) => error);
      if (persistent) {
        expect(result).toHaveProperty("message", "Stop disk unavailable");
        expect(stream).not.toHaveBeenCalled();
        expect(h.session.hasBlockingCompactionCleanup).toBe(true);
      } else {
        expect(result).toEqual(Ok(undefined));
        expect(stream).toHaveBeenCalledTimes(1);
        const rows = await new HistoryService(h.config).getLastMessages(workspaceId, 1);
        expect(rows.success && rows.data[0].parts).toMatchObject([
          { type: "text", text: "Fresh explicit work" },
        ]);
      }
    } finally {
      write.mockRestore();
      await h.session.dispose();
      await h.cleanup();
    }
  }
);

test.each(
  ["legacy", "failed apply", "failed apply compact"].flatMap((kind) =>
    [false, true].map((unlinkDebt) => ({ kind, unlinkDebt }))
  )
)(
  "captured source-less $kind cannot follow a foreign replacement (unlink debt=$unlinkDebt)",
  async ({ kind, unlinkDebt }) => {
    const h = await setup();
    await h.historyService.appendToHistory(
      workspaceId,
      createMuxMessage("original", "user", "Old work")
    );
    const context = {
      modelString: options.model,
      options,
      providersConfig: null,
      compactionPublication: {
        generation: await h.historyService
          .getContinuousCompactionJournal(workspaceId)
          .captureGeneration(),
      },
    };
    const direct = h.session as unknown as {
      activeStreamContext: typeof context;
      interruptForCompaction(): Promise<void>;
      finishContinuousCompaction(
        applied: boolean,
        streamContext: typeof context,
        token: NonNullable<ReturnType<TurnCoordinator["beginCompactionObservation"]>>
      ): Promise<void>;
      compactionMonitor: CompactionMonitor;
    };
    direct.activeStreamContext = context;
    if (kind === "failed apply compact")
      spyOn(direct.compactionMonitor, "checkBeforeSend").mockReturnValue({
        shouldShowWarning: true,
        shouldForceCompact: true,
        usagePercentage: 99,
        thresholdPercentage: 85,
        contextTokens: 99_000,
        maxTokens: 100_000,
      });
    const entered = Promise.withResolvers<void>();
    const release = Promise.withResolvers<void>();
    const pricing = h.goalService.assertPricedModelForBudgetedGoal.bind(h.goalService);
    spyOn(h.goalService, "assertPricedModelForBudgetedGoal").mockImplementationOnce(
      async (...args) => {
        const result = await pricing(...args);
        entered.resolve();
        await release.promise;
        return result;
      }
    );
    const token =
      kind === "legacy"
        ? undefined
        : h.internals.coordinator.beginCompactionObservation("continuous");
    if (token) h.internals.coordinator.setCompactionStage(token, "stopped");
    const pending =
      kind === "legacy"
        ? direct.interruptForCompaction()
        : direct.finishContinuousCompaction(false, context, token!);
    const stream = spyOn(h.aiService, "streamMessage");
    const foreignHistory = new HistoryService(h.config);
    const foreign = await createAgentSessionHarness({
      workspaceId,
      config: h.config,
      historyService: foreignHistory,
    });
    let restoreWrite: (() => void) | undefined;
    try {
      await entered.promise;
      await foreign.session.interruptStream({ abandonPartial: true });
      if (unlinkDebt) {
        const write = foreignHistory.writeCompactionCancellation.bind(foreignHistory);
        const spy = spyOn(foreignHistory, "writeCompactionCancellation").mockImplementation(
          (...args) =>
            args[1] === null ? Promise.reject(new Error("unlink unavailable")) : write(...args)
        );
        restoreWrite = () => spy.mockRestore();
      }
      expect((await foreign.session.sendMessage("New accepted work", options)).success).toBe(true);
      release.resolve();
      await pending;
      expect(stream).not.toHaveBeenCalled();
      const rows = await foreignHistory.getLastMessages(workspaceId, 10);
      expect(
        rows.success && rows.data.filter((row) => row.role === "user").map((row) => row.parts)
      ).toMatchObject([[{ text: "Old work" }], [{ text: "New accepted work" }]]);
      if (token) h.internals.coordinator.finishCompactionObservation(token);
      direct.activeStreamContext = {
        ...context,
        compactionPublication: {
          generation: await h.historyService
            .getContinuousCompactionJournal(workspaceId)
            .captureGeneration(),
        },
      };
      await direct.interruptForCompaction();
      expect(stream).toHaveBeenCalledTimes(1);
    } finally {
      release.resolve();
      await pending.catch(() => undefined);
      restoreWrite?.();
      await foreign.session.dispose();
      await h.session.dispose();
      await h.cleanup();
    }
  }
);

test.each(["unresolved", "absent", "witnessed", "Stop during backoff", "Stop during preparation"])(
  "startup retry actually delivers retained user rows only without unresolved Stop (%s)",
  async (state) => {
    const h = await setup();
    const clock = makeTestEffectRunner();
    const foreign = new HistoryService(h.config);
    const cancellation = new CompactionCancellation(foreign, workspaceId);
    if (state === "unresolved" || state === "witnessed") await cancellation.cancel();
    const record = await cancellation.read();
    await foreign.appendToHistory(
      workspaceId,
      createMuxMessage("retained-trigger", "user", "Retained explicit work", {
        synthetic: true,
        uiVisible: true,
        retrySendOptions: options,
        ...(state === "witnessed" ? { compactionCancellationNonce: record?.nonce } : {}),
      })
    );
    const fresh = await createAgentSessionHarness({
      workspaceId,
      config: h.config,
      historyService: foreign,
      streamManager: { ...createStreamLifecycleMocks(), effectRunner: clock.runner },
      captureEvents: true,
    });
    const deliver = spyOn(
      fresh.session as unknown as { retryActiveStream(): Promise<void> },
      "retryActiveStream"
    );
    const stream = spyOn(fresh.aiService, "streamMessage");
    try {
      await fresh.session.runStartupRecovery();
      if (state === "Stop during backoff") await cancellation.cancel();
      if (state === "Stop during preparation") {
        const read = foreign.getHistoryFromLatestBoundary.bind(foreign);
        spyOn(foreign, "getHistoryFromLatestBoundary").mockImplementationOnce(async (...args) => {
          const result = await read(...args);
          await cancellation.cancel();
          return result;
        });
      }
      await clock.adjust(calculateBackoffDelay(6) * 2);
      await Promise.all(deliver.mock.results.map((result) => result.value));
      expect(deliver).toHaveBeenCalledTimes(state === "unresolved" ? 0 : 1);
      expect(stream).toHaveBeenCalledTimes(state === "absent" || state === "witnessed" ? 1 : 0);
      expect(fresh.events.some((event) => event.type === "auto-retry-scheduled")).toBe(
        state !== "unresolved"
      );
    } finally {
      await fresh.session.dispose();
      await h.session.dispose();
      await clock.dispose();
      await h.cleanup();
    }
  }
);

test.each(["before capture", "after capture"])(
  "a real stream pins handoff publication when foreign Stop wins %s",
  async (stage) => {
    const h = await setup();
    const journal = h.historyService.getContinuousCompactionJournal(workspaceId);
    const capture = journal.captureGeneration.bind(journal);
    const entered = Promise.withResolvers<void>();
    const release = Promise.withResolvers<void>();
    spyOn(journal, "captureGeneration").mockImplementationOnce(async () => {
      if (stage === "before capture") {
        entered.resolve();
        await release.promise;
      }
      const generation = await capture();
      if (stage === "after capture") {
        entered.resolve();
        await release.promise;
      }
      return generation;
    });
    const completed = Promise.withResolvers<TurnCompletion>();
    const stream = spyOn(h.aiService, "streamMessage").mockResolvedValueOnce(
      Ok({ messageId: "original-live-stream", completion: completed.promise })
    );
    spyOn(h.aiService, "stopStream").mockImplementation(() => {
      completed.resolve({ status: "aborted", abortReason: "system" });
      return Promise.resolve(Ok(undefined));
    });
    const sending = h.session.sendMessage("Original work", options);
    const foreign = await createAgentSessionHarness({
      workspaceId,
      config: h.config,
      historyService: new HistoryService(h.config),
    });
    try {
      await entered.promise;
      await foreign.session.interruptStream({ abandonPartial: true });
      expect((await foreign.session.sendMessage("Replacement work", options)).success).toBe(true);
      release.resolve();
      expect((await sending).success).toBe(true);
      const direct = h.session as unknown as { interruptForCompaction(): Promise<void> };
      await direct.interruptForCompaction();
      // Capturing after Stop precedes this stream's first context read/provider call;
      // capturing before it keeps the older epoch even through delayed provider entry.
      expect(stream).toHaveBeenCalledTimes(stage === "before capture" ? 2 : 1);
    } finally {
      release.resolve();
      completed.resolve({ status: "aborted", abortReason: "system" });
      await sending.catch(() => undefined);
      await foreign.session.dispose();
      await h.session.dispose();
      await h.cleanup();
    }
  }
);

test.each(["replacement", "dispose"])(
  "held stream generation capture cannot mutate its %s successor",
  async (action) => {
    const h = await setup();
    const journal = h.historyService.getContinuousCompactionJournal(workspaceId);
    const capture = journal.captureGeneration.bind(journal);
    const entered = Promise.withResolvers<void>();
    const release = Promise.withResolvers<void>();
    spyOn(journal, "captureGeneration").mockImplementationOnce(async () => {
      const generation = await capture();
      entered.resolve();
      await release.promise;
      return generation;
    });
    const pending = h.session.sendMessage("Old held preparation", options);
    let closing: Promise<void> | undefined;
    try {
      await entered.promise;
      if (action === "replacement") {
        await h.session.interruptStream({ abandonPartial: true });
        // This fixture has no engine startup-abort event; finish its logical turn
        // while the old physical capture remains held, then admit the successor.
        h.internals.coordinator.finishTurn(h.internals.coordinator.turnId);
        expect(await h.session.sendMessage("New successor", options)).toEqual(Ok(undefined));
        const rows = await h.historyService.getLastMessages(workspaceId, 1);
        expect(rows.success && rows.data[0].parts).toMatchObject([{ text: "New successor" }]);
      } else closing = h.session.dispose();
      const state = h.session as unknown as {
        activeStreamContext: unknown;
        activeStreamUserMessageId: string | undefined;
      };
      const context = state.activeStreamContext;
      const userId = state.activeStreamUserMessageId;
      await h.historyService.writePartial(
        workspaceId,
        createMuxMessage("successor-partial", "assistant", "Successor owned partial")
      );
      const commit = spyOn(h.historyService, "commitPartial");
      release.resolve();
      await pending;
      await closing;
      expect(commit).not.toHaveBeenCalled();
      expect(state.activeStreamContext).toBe(context);
      expect(state.activeStreamUserMessageId).toBe(userId);
      expect((await h.historyService.readPartial(workspaceId))?.id).toBe("successor-partial");
    } finally {
      release.resolve();
      await pending.catch(() => undefined);
      await closing;
      await h.session.dispose();
      await h.cleanup();
    }
  }
);

test.each(["heartbeat", "legacy"])(
  "invalidated %s publication preserves a successor partial and pending context",
  async (producer) => {
    const h = await setup();
    const followUp = { text: "Continue old work", ...options };
    await h.historyService.appendToHistory(
      workspaceId,
      createMuxMessage("old-request", "user", "Compact", {
        muxMetadata: {
          type: "compaction-request",
          rawCommand: "/compact",
          parsed: { followUpContent: followUp },
        },
      })
    );
    const journal = h.historyService.getContinuousCompactionJournal(workspaceId);
    const capture = journal.captureGeneration.bind(journal);
    const entered = Promise.withResolvers<void>();
    const release = Promise.withResolvers<void>();
    spyOn(journal, "captureGeneration").mockImplementationOnce(async () => {
      const generation = await capture();
      entered.resolve();
      await release.promise;
      return generation;
    });
    const pending =
      producer === "heartbeat"
        ? h.internals.compactionHandler.appendHeartbeatContextResetBoundary({
            boundaryText: "Old context",
            pendingFollowUp: followUp,
          })
        : h.internals.compactionHandler.handleCompletion(
            {
              type: "stream-end",
              workspaceId,
              messageId: "old-stream",
              parts: [{ type: "text", text: "Old context" }],
              metadata: { model: options.model, duration: 1 },
            },
            "old-request"
          );
    const foreign = await createAgentSessionHarness({
      workspaceId,
      config: h.config,
      historyService: new HistoryService(h.config),
    });
    try {
      await entered.promise;
      await foreign.session.interruptStream({ abandonPartial: true });
      expect((await foreign.session.sendMessage("B replacement", options)).success).toBe(true);
      await foreign.historyService.writePartial(
        workspaceId,
        createMuxMessage("b-partial", "assistant", "B live partial")
      );
      const pendingPath = `${h.config.sessionsDir}/${workspaceId}/post-compaction.json`;
      await writeFile(pendingPath, "foreign B pending state");
      release.resolve();
      await pending;
      expect((await foreign.historyService.readPartial(workspaceId))?.id).toBe("b-partial");
      expect(await readFile(pendingPath, "utf8")).toBe("foreign B pending state");
    } finally {
      release.resolve();
      await pending.catch(() => undefined);
      await foreign.session.dispose();
      await h.session.dispose();
      await h.cleanup();
    }
  }
);

test.each(
  ["heartbeat", "legacy"].flatMap((producer) =>
    ["prepare write", "failed cleanup", "invalid read cleanup"].map((stage) => ({
      producer,
      stage,
    }))
  )
)(
  "retired $producer $stage cannot change successor pending-state bytes",
  async ({ producer, stage }) => {
    const h = await setup();
    const followUp = { text: "Continue old work", ...options };
    await h.historyService.appendToHistory(
      workspaceId,
      createMuxMessage("old-request", "user", "Compact", {
        muxMetadata: {
          type: "compaction-request",
          rawCommand: "/compact",
          parsed: { followUpContent: followUp },
        },
      })
    );
    if (producer === "legacy")
      await h.historyService.appendToHistory(
        workspaceId,
        createMuxMessage("old-stream", "assistant", "Streamed old summary")
      );
    const pendingPath = `${h.config.sessionsDir}/${workspaceId}/post-compaction.json`;
    if (stage === "invalid read cleanup") await writeFile(pendingPath, "malformed old state");
    const handler = h.internals.compactionHandler;
    const entered = Promise.withResolvers<void>();
    const release = Promise.withResolvers<void>();
    if (stage !== "failed cleanup") {
      const writes = handler as unknown as {
        enqueuePendingStateWrite(write: () => Promise<void>): Promise<void>;
      };
      const enqueue = writes.enqueuePendingStateWrite.bind(writes);
      spyOn(writes, "enqueuePendingStateWrite").mockImplementationOnce(async (...args) => {
        entered.resolve();
        await release.promise;
        return enqueue(...args);
      });
    } else if (producer === "heartbeat") {
      spyOn(h.historyService, "appendToHistory").mockImplementationOnce(async () => {
        entered.resolve();
        await release.promise;
        return Err("held heartbeat append failure");
      });
    } else {
      const update = h.historyService.updateHistory.bind(h.historyService);
      spyOn(h.historyService, "updateHistory").mockImplementationOnce(async (...args) => {
        entered.resolve();
        await release.promise;
        return update(...args);
      });
    }
    const pending =
      producer === "heartbeat"
        ? handler.appendHeartbeatContextResetBoundary({
            boundaryText: "Old context",
            pendingFollowUp: followUp,
          })
        : handler.handleCompletion(
            {
              type: "stream-end",
              workspaceId,
              messageId: "old-stream",
              parts: [{ type: "text", text: "Old context" }],
              metadata: { model: options.model, duration: 1 },
            },
            "old-request"
          );
    const foreign = await createAgentSessionHarness({
      workspaceId,
      config: h.config,
      historyService: new HistoryService(h.config),
    });
    const successor = JSON.stringify({
      version: 1,
      createdAt: 1,
      diffs: [],
      loadedSkills: [],
      readFiles: ["/foreign/successor.ts"],
    });
    try {
      await entered.promise;
      await foreign.session.interruptStream({ abandonPartial: true });
      expect((await foreign.session.sendMessage("B replacement", options)).success).toBe(true);
      await writeFile(pendingPath, successor);
      release.resolve();
      await pending;
      expect(await readFile(pendingPath, "utf8").catch(() => "missing")).toBe(successor);
    } finally {
      release.resolve();
      await pending.catch(() => undefined);
      await foreign.session.dispose();
      await h.session.dispose();
      await h.cleanup();
    }
  }
);

test.each(
  ["heartbeat", "legacy append", "legacy update"].flatMap((producer) =>
    ["restart before cleanup", "cleanup", "reset", "edit", "successor"].map((stage) => ({
      producer,
      stage,
    }))
  )
)("uncommitted $producer pending state is owned across $stage", async ({ producer, stage }) => {
  const h = await setup();
  const readMessage = createMuxMessage("read", "assistant", "");
  readMessage.parts = [
    {
      type: "dynamic-tool",
      toolCallId: "read-call",
      toolName: "file_read",
      state: "output-available",
      input: { path: "/same-logical-read.ts" },
      output: { success: true },
    },
  ];
  await h.historyService.appendToHistory(workspaceId, readMessage);
  await h.historyService.appendToHistory(
    workspaceId,
    createMuxMessage("old-request", "user", "Compact", {
      muxMetadata: {
        type: "compaction-request",
        rawCommand: "/compact",
        parsed: { followUpContent: { text: "Continue", ...options } },
      },
    })
  );
  if (producer === "legacy update")
    await h.historyService.appendToHistory(
      workspaceId,
      createMuxMessage("old-stream", "assistant", "Uncommitted summary")
    );
  const entered = Promise.withResolvers<void>();
  const release = Promise.withResolvers<void>();
  if (producer === "legacy update") {
    const update = h.historyService.updateHistory.bind(h.historyService);
    spyOn(h.historyService, "updateHistory").mockImplementationOnce(async (...args) => {
      entered.resolve();
      await release.promise;
      return update(...args);
    });
  } else {
    const append = h.historyService.appendToHistory.bind(h.historyService);
    spyOn(h.historyService, "appendToHistory").mockImplementationOnce(async (...args) => {
      entered.resolve();
      await release.promise;
      return append(...args);
    });
  }
  const handler = h.internals.compactionHandler;
  const pending =
    producer === "heartbeat"
      ? handler.appendHeartbeatContextResetBoundary({
          boundaryText: "Captured context",
          pendingFollowUp: { text: "Continue", ...options },
        })
      : handler.handleCompletion(
          {
            type: "stream-end",
            workspaceId,
            messageId: "old-stream",
            parts: [{ type: "text", text: "Captured context" }],
            metadata: { model: options.model, duration: 1 },
          },
          "old-request"
        );
  const foreign = await createAgentSessionHarness({
    workspaceId,
    config: h.config,
    historyService: new HistoryService(h.config),
  });
  const foreignHandler = (foreign.session as unknown as { compactionHandler: CompactionHandler })
    .compactionHandler;
  const pendingPath = `${h.config.sessionsDir}/${workspaceId}/post-compaction.json`;
  try {
    await entered.promise;
    expect(JSON.parse(await readFile(pendingPath, "utf8"))).toHaveProperty("readFiles", [
      "/same-logical-read.ts",
    ]);
    if (stage === "reset") {
      await foreign.historyService.appendToHistory(
        workspaceId,
        createMuxMessage("reset", "assistant", "", { contextBoundaryKind: "reset" })
      );
    } else if (stage === "edit") {
      await foreign.historyService.truncateAfterMessage(workspaceId, "read");
    } else {
      await foreign.session.interruptStream({ abandonPartial: true });
    }
    if (stage === "restart before cleanup")
      expect(await foreignHandler.peekPendingState()).toBeNull();
    let successor: string | undefined;
    if (stage === "successor") {
      await foreignHandler.preparePendingStateFromMessages([readMessage]);
      successor = await readFile(pendingPath, "utf8");
    }
    release.resolve();
    await pending;
    if (successor !== undefined) {
      expect(await readFile(pendingPath, "utf8")).toBe(successor);
    } else {
      expect(await foreignHandler.peekPendingState()).toBeNull();
      expect(await readFile(pendingPath, "utf8").catch(() => null)).toBeNull();
    }
  } finally {
    release.resolve();
    await pending.catch(() => undefined);
    await foreign.session.dispose();
    await h.session.dispose();
    await h.cleanup();
  }
});

test.each([
  "same-generation successor",
  "new-generation successor",
  "write rejected",
  "write acknowledgement lost",
  "cleanup failure",
  "current prior state",
])("provisional pending receipt handles %s without claiming successor bytes", async (scenario) => {
  const h = await setup();
  const handler = h.internals.compactionHandler;
  const journal = h.historyService.getContinuousCompactionJournal(workspaceId);
  const publication = { generation: await journal.captureGeneration() };
  const pendingPath = `${h.config.sessionsDir}/${workspaceId}/post-compaction.json`;
  const cleanup = (
    handler as unknown as {
      cleanupProvisionalPendingState(
        receipt: Awaited<ReturnType<CompactionHandler["preparePendingStateFromMessages"]>>,
        capturedPublication: typeof publication
      ): Promise<void>;
    }
  ).cleanupProvisionalPendingState.bind(handler);
  let prior: string | undefined;
  if (scenario === "write rejected" || scenario === "current prior state") {
    await h.historyService.appendToHistory(
      workspaceId,
      createMuxMessage("committed", "assistant", "Prior context", {
        compacted: "user",
        compactionBoundary: true,
        compactionEpoch: 1,
      })
    );
    prior = JSON.stringify({
      version: 1,
      createdAt: 1,
      diffs: [],
      loadedSkills: [],
      readFiles: ["/prior.ts"],
      boundaryMessageId: "committed",
    });
    await writeFile(pendingPath, prior);
  }
  if (scenario === "write rejected" || scenario === "write acknowledgement lost") {
    const write = h.historyService.withCompactionPublicationWrite.bind(h.historyService);
    spyOn(h.historyService, "withCompactionPublicationWrite").mockImplementationOnce(
      async (...args) => {
        if (scenario === "write acknowledgement lost") await write(...args);
        throw new Error("pending write unavailable");
      }
    );
  }
  const now = spyOn(Date, "now").mockReturnValue(1234);
  try {
    const read = createMuxMessage("a-read", "assistant", "");
    read.parts = [
      {
        type: "dynamic-tool",
        toolCallId: "a-read",
        toolName: "file_read",
        state: "output-available",
        input: { path: "/provisional.ts" },
        output: { success: true },
      },
    ];
    const receipt = await handler.preparePendingStateFromMessages(
      [read],
      "provisional",
      undefined,
      publication
    );
    if (scenario === "write rejected") expect(receipt.write).toBeUndefined();
    else expect(receipt.write).toBeDefined();
    if (
      scenario === "new-generation successor" ||
      scenario === "write acknowledgement lost" ||
      scenario === "cleanup failure"
    ) {
      await new CompactionCancellation(new HistoryService(h.config), workspaceId).cancel();
    }
    if (scenario === "new-generation successor") {
      expect((await h.session.sendMessage("Fresh successor", options)).success).toBe(true);
    }
    let successor: string | undefined;
    if (scenario === "same-generation successor" || scenario === "new-generation successor") {
      await handler.preparePendingStateFromMessages([read], "provisional", undefined, {
        generation: await journal.captureGeneration(),
      });
      successor = await readFile(pendingPath, "utf8");
      expect(successor).not.toBe(receipt.write?.serialized);
    }
    if (scenario === "cleanup failure") {
      const unlink = fs.unlink;
      let failed = false;
      spyOn(fs, "unlink").mockImplementation(async (...args) => {
        if (!failed && args[0] === pendingPath) {
          failed = true;
          throw new Error("cleanup unavailable");
        }
        return unlink(...args);
      });
    }
    await cleanup(receipt, publication);
    const expected = successor ?? prior;
    if (expected !== undefined) {
      expect(await readFile(pendingPath, "utf8")).toBe(expected);
      if (prior !== undefined)
        expect(await handler.peekPendingState()).toHaveProperty("readFiles", ["/prior.ts"]);
    } else {
      const fresh = await createAgentSessionHarness({
        workspaceId,
        config: h.config,
        historyService: new HistoryService(h.config),
      });
      try {
        expect(
          await (
            fresh.session as unknown as { compactionHandler: CompactionHandler }
          ).compactionHandler.peekPendingState()
        ).toBeNull();
        expect(await readFile(pendingPath, "utf8").catch(() => null)).toBeNull();
      } finally {
        await fresh.session.dispose();
      }
    }
  } finally {
    now.mockRestore();
    await h.session.dispose();
    await h.cleanup();
  }
});

test("provisional cleanup cannot clear memory prepared by a successor waiting for its lock", async () => {
  const h = await setup();
  const handler = h.internals.compactionHandler;
  const publication = {
    generation: await h.historyService
      .getContinuousCompactionJournal(workspaceId)
      .captureGeneration(),
  };
  const receipt = await handler.preparePendingStateFromMessages(
    [],
    "a-boundary",
    undefined,
    publication
  );
  const entered = Promise.withResolvers<void>();
  const release = Promise.withResolvers<void>();
  const locked = h.historyService.withCompactionPublicationLock.bind(h.historyService);
  spyOn(h.historyService, "withCompactionPublicationLock").mockImplementationOnce(
    (id, captured, operation) =>
      locked(id, captured, async (current) => {
        entered.resolve();
        await release.promise;
        await operation(current);
      })
  );
  const cleanup = (
    handler as unknown as {
      cleanupProvisionalPendingState(
        capturedReceipt: typeof receipt,
        captured: typeof publication
      ): Promise<void>;
    }
  ).cleanupProvisionalPendingState(receipt, publication);
  await entered.promise;
  const queued = Promise.withResolvers<void>();
  const writes = handler as unknown as {
    enqueuePendingStateWrite(write: () => Promise<void>): Promise<void>;
  };
  const enqueue = writes.enqueuePendingStateWrite.bind(writes);
  spyOn(writes, "enqueuePendingStateWrite").mockImplementationOnce((...args) => {
    queued.resolve();
    return enqueue(...args);
  });
  const read = createMuxMessage("b-read", "assistant", "");
  read.parts = [
    {
      type: "dynamic-tool",
      toolCallId: "b-read-call",
      toolName: "file_read",
      state: "output-available",
      input: { path: "/b.ts" },
      output: { success: true },
    },
  ];
  const preparation = handler.preparePendingStateFromMessages(
    [read],
    "b-boundary",
    undefined,
    publication
  );
  try {
    await queued.promise;
    release.resolve();
    await cleanup;
    await preparation;
    expect(
      await handler.persistContinuousCompaction({
        boundaryMessageId: "b-boundary",
        messages: [read],
        text: "B summary",
        model: options.model,
        tail: [],
        systemMessageTokens: 0,
        attachmentTokens: 0,
        shouldPersist: () => true,
        publication,
      })
    ).toBe(true);
    expect(await handler.peekPendingState()).toHaveProperty("readFiles", ["/b.ts"]);
    expect(handler as unknown as { pendingStateBoundaryMessageId: string }).toHaveProperty(
      "pendingStateBoundaryMessageId",
      "b-boundary"
    );
  } finally {
    release.resolve();
    await cleanup;
    await preparation;
    await h.session.dispose();
    await h.cleanup();
  }
});

test("held pending-state load cannot overwrite a newer preparation", async () => {
  const h = await setup();
  const handler = h.internals.compactionHandler;
  await h.historyService.appendToHistory(
    workspaceId,
    createMuxMessage("prior", "assistant", "Prior context", {
      compacted: "user",
      compactionBoundary: true,
      compactionEpoch: 1,
    })
  );
  const pendingPath = `${h.config.sessionsDir}/${workspaceId}/post-compaction.json`;
  await writeFile(
    pendingPath,
    JSON.stringify({
      version: 1,
      createdAt: 1,
      diffs: [],
      loadedSkills: [],
      readFiles: ["/old.ts"],
      boundaryMessageId: "prior",
    })
  );
  const publication = {
    generation: await h.historyService
      .getContinuousCompactionJournal(workspaceId)
      .captureGeneration(),
  };
  const entered = Promise.withResolvers<void>();
  const release = Promise.withResolvers<void>();
  const readHistory = h.historyService.getHistoryFromLatestBoundary.bind(h.historyService);
  spyOn(h.historyService, "getHistoryFromLatestBoundary").mockImplementationOnce(
    async (...args) => {
      const history = await readHistory(...args);
      entered.resolve();
      await release.promise;
      return history;
    }
  );
  const oldPreparation = handler.preparePendingStateFromMessages(
    [],
    "a-boundary",
    undefined,
    publication
  );
  try {
    await entered.promise;
    const read = createMuxMessage("b-read", "assistant", "");
    read.parts = [
      {
        type: "dynamic-tool",
        toolCallId: "b-read-call",
        toolName: "file_read",
        state: "output-available",
        input: { path: "/b.ts" },
        output: { success: true },
      },
    ];
    const successor = await handler.preparePendingStateFromMessages(
      [read],
      "b-boundary",
      undefined,
      publication
    );
    const serialized = successor.write?.serialized;
    if (serialized === undefined) throw new Error("Expected successor pending write");
    release.resolve();
    expect((await oldPreparation).write).toBeUndefined();
    expect(await fs.readFile(pendingPath, "utf8")).toBe(serialized);
    expect(
      await handler.persistContinuousCompaction({
        boundaryMessageId: "b-boundary",
        messages: [read],
        text: "B summary",
        model: options.model,
        tail: [],
        systemMessageTokens: 0,
        attachmentTokens: 0,
        shouldPersist: () => true,
        publication,
      })
    ).toBe(true);
    expect(await handler.peekPendingState()).toHaveProperty("readFiles", ["/b.ts"]);
    expect(handler as unknown as { pendingStateBoundaryMessageId: string }).toHaveProperty(
      "pendingStateBoundaryMessageId",
      "b-boundary"
    );
  } finally {
    release.resolve();
    await oldPreparation;
    await h.session.dispose();
    await h.cleanup();
  }
});

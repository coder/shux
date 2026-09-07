import { afterEach, expect, mock, spyOn, test } from "bun:test";
import { createMuxMessage } from "@/common/types/message";
import { Err, Ok } from "@/common/types/result";
import type { TurnCompletion } from "./streamManager";
import type { TurnCoordinator } from "./turnCoordinator";
import type { CompactionHandler } from "./compactionHandler";
import type { HistoryService } from "./historyService";
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
        h.session.contextMutationCommitted();
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
      h.session.contextMutationCommitted();
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
      h.session.contextMutationCommitted();
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

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

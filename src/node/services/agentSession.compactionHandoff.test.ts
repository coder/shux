import { afterEach, describe, expect, mock, spyOn, test } from "bun:test";
import assert from "@/common/utils/assert";
import { createMuxMessage, type CompactionFollowUpRequest } from "@/common/types/message";
import { Err, Ok } from "@/common/types/result";
import type { WorkspaceGoalService } from "./workspaceGoalService";
import type { TurnCoordinator } from "./turnCoordinator";
import { createAgentSessionHarness, type AgentSessionHarness } from "./agentSession.testHarness";

const workspaceId = "correlated-handoff";
const sendOptions = { model: "openai:gpt-4o", agentId: "exec" };

describe("AgentSession correlated compaction handoff", () => {
  let h: AgentSessionHarness;
  afterEach(async () => {
    await h?.session.dispose();
    await h?.cleanup();
    mock.restore();
  });

  async function setup(options?: {
    heartbeat?: boolean;
    workspaceGoalService?: WorkspaceGoalService;
  }) {
    h = await createAgentSessionHarness({
      workspaceId,
      workspaceGoalService: options?.workspaceGoalService,
      captureEvents: true,
    });
    const followUp: CompactionFollowUpRequest = {
      text: "Resume captured work",
      ...sendOptions,
      ...(options?.heartbeat ? { dispatchOptions: { requireIdle: true } } : {}),
    };
    const summary = createMuxMessage("summary", "assistant", "Compacted context", {
      compacted: options?.heartbeat ? "heartbeat" : "user",
      compactionBoundary: true,
      muxMetadata: { type: "compaction-summary", pendingFollowUp: followUp },
    });
    expect((await h.historyService.appendToHistory(workspaceId, summary)).success).toBe(true);
    return (h.session as unknown as { coordinator: TurnCoordinator }).coordinator;
  }

  async function rows() {
    const result = await h.historyService.getHistoryFromLatestBoundary(workspaceId);
    assert(result.success, "Expected real history read");
    return result.data;
  }

  function holdSummaryRead() {
    const entered = Promise.withResolvers<void>();
    const release = Promise.withResolvers<void>();
    const read = h.historyService.getLastMessages.bind(h.historyService);
    spyOn(h.historyService, "getLastMessages").mockImplementationOnce(async (...args) => {
      const result = await read(...args);
      entered.resolve();
      await release.promise;
      return result;
    });
    return { entered: entered.promise, release: release.resolve };
  }

  test("concurrent recovery shares one physical dispatch slot and persists one continuation", async () => {
    await setup();
    const gate = holdSummaryRead();
    const dispatch = h.session.dispatchPendingCompactionFollowUpIfNeeded();
    try {
      await gate.entered;
      expect(await h.session.dispatchPendingCompactionFollowUpIfNeeded()).toBe(false);
      expect(h.aiService.streamMessage).not.toHaveBeenCalled();
      gate.release();
      expect(await dispatch).toBe(true);
      expect(h.aiService.streamMessage).toHaveBeenCalledTimes(1);
      expect((await rows()).filter((row) => row.role === "user")).toHaveLength(1);
    } finally {
      gate.release();
      await dispatch;
    }
  });

  test.each(["replacement", "edit", "mutation"] as const)(
    "%s finishing during the history read cannot resurrect the captured continuation",
    async (action) => {
      const coordinator = await setup();
      const gate = holdSummaryRead();
      const dispatch = h.session.dispatchPendingCompactionFollowUpIfNeeded();
      try {
        await gate.entered;
        if (action === "replacement") {
          const admission = coordinator.prepare({
            kind: "fresh",
            intent: "direct",
            expectedTurnId: coordinator.turnId,
          });
          assert(admission.status === "admitted", "Expected replacement admission");
          coordinator.finishTurn(admission.turnId);
        } else if (action === "edit") {
          coordinator.reserve("edit")[Symbol.dispose]();
        } else {
          expect((await h.session.discardAutoRetryForContextMutation()).success).toBe(true);
        }
        gate.release();
        expect(await dispatch).toBe(false);
        expect(h.aiService.streamMessage).not.toHaveBeenCalled();
        const history = await rows();
        expect(history).toHaveLength(1);
        expect(history[0].metadata?.muxMetadata).toHaveProperty("pendingFollowUp");
      } finally {
        gate.release();
        await dispatch;
      }
    }
  );

  test.each(["stop", "shutdown"] as const)(
    "%s during observation refuses a send and preserves only recoverable intent",
    async (action) => {
      const coordinator = await setup();
      const gate = holdSummaryRead();
      const dispatch = h.session.dispatchPendingCompactionFollowUpIfNeeded();
      try {
        await gate.entered;
        if (action === "stop") await h.session.interruptStream({ abandonPartial: true });
        else coordinator.beginShutdown();
        gate.release();
        expect(await dispatch).toBe(false);
        expect(h.aiService.streamMessage).not.toHaveBeenCalled();
        const history = await rows();
        expect(history).toHaveLength(1);
        expect(history[0].metadata?.muxMetadata).toEqual({
          type: "compaction-summary",
          ...(action === "shutdown"
            ? { pendingFollowUp: { text: "Resume captured work", ...sendOptions } }
            : {}),
        });
      } finally {
        gate.release();
        await dispatch;
      }
    }
  );

  test("manual input and compaction waiters remain behind heartbeat rollback until it settles", async () => {
    await setup({ heartbeat: true });
    const readGate = holdSummaryRead();
    const entered = Promise.withResolvers<void>();
    const release = Promise.withResolvers<void>();
    const cleanup = h.historyService.cleanupCompactionFollowUp.bind(h.historyService);
    spyOn(h.historyService, "cleanupCompactionFollowUp").mockImplementationOnce(async (...args) => {
      entered.resolve();
      await release.promise;
      return cleanup(...args);
    });
    const manualSent = Promise.withResolvers<void>();
    h.session.onChatEvent(({ message }) => {
      if (message.type === "message" && message.role === "user") manualSent.resolve();
    });
    const dispatch = h.session.dispatchPendingCompactionFollowUpIfNeeded();
    try {
      await readGate.entered;
      h.session.queueMessage("Manual work", sendOptions);
      readGate.release();
      await entered.promise;
      h.session.drainQueuedMessagesIfIdle();
      let settled = false;
      const wait = h.session.waitForMidStreamCompactionSettled().then(() => {
        settled = true;
      });
      expect(await h.session.dispatchPendingCompactionFollowUpIfNeeded()).toBe(false);
      await Promise.resolve();
      expect(settled).toBe(false);
      expect(h.aiService.streamMessage).not.toHaveBeenCalled();
      expect((await rows()).map((row) => row.id)).toEqual(["summary"]);
      release.resolve();
      expect(await dispatch).toBe(false);
      await wait;
      await manualSent.promise;
      const history = await rows();
      expect(history.some((row) => row.id === "summary")).toBe(false);
      expect(history.filter((row) => row.role === "user").map((row) => row.parts)).toMatchObject([
        [{ type: "text", text: "Manual work" }],
      ]);
    } finally {
      readGate.release();
      release.resolve();
      await dispatch;
    }
  });

  test("Stop during the continuation append rolls back its row before clearing the source", async () => {
    await setup();
    const entered = Promise.withResolvers<void>();
    const release = Promise.withResolvers<void>();
    const append = h.historyService.appendToHistory.bind(h.historyService);
    spyOn(h.historyService, "appendToHistory").mockImplementationOnce(async (...args) => {
      const result = await append(...args);
      entered.resolve();
      await release.promise;
      return result;
    });
    const dispatch = h.session.dispatchPendingCompactionFollowUpIfNeeded();
    try {
      await entered.promise;
      await h.session.interruptStream({ abandonPartial: true });
      release.resolve();
      expect(await dispatch).toBe(false);
      const history = await rows();
      expect(history).toHaveLength(1);
      expect(history[0].metadata?.muxMetadata).not.toHaveProperty("pendingFollowUp");
      expect(h.aiService.streamMessage).not.toHaveBeenCalled();
    } finally {
      release.resolve();
      await dispatch;
    }
  });

  test.each(["stop", "replacement", "shutdown"] as const)(
    "%s during goal sync cannot erase an irrevocable continuation before onAccepted",
    async (action) => {
      const entered = Promise.withResolvers<void>();
      const release = Promise.withResolvers<void>();
      const coordinator = await setup({
        workspaceGoalService: {
          assertPricedModelForBudgetedGoal: mock(() => Promise.resolve(Ok(undefined))),
          getGoal: mock(() => Promise.resolve(null)),
          syncGoalModeWithChatTail: mock(async () => {
            entered.resolve();
            await release.promise;
          }),
        } as unknown as WorkspaceGoalService,
      });
      const dispatch = h.session.dispatchPendingCompactionFollowUpIfNeeded();
      try {
        await entered.promise;
        if (action === "stop") await h.session.interruptStream({ abandonPartial: true });
        else if (action === "shutdown") coordinator.beginShutdown();
        else {
          const admission = coordinator.prepare({
            kind: "fresh",
            intent: "direct",
            expectedTurnId: coordinator.turnId,
          });
          expect(admission.status).toBe("admitted");
        }
        release.resolve();
        expect(await dispatch).toBe(true);
        expect(h.aiService.streamMessage).not.toHaveBeenCalled();
        const history = await rows();
        expect(history).toHaveLength(2);
        expect(history[0].metadata?.muxMetadata).toHaveProperty("pendingFollowUp");
        expect(history[1].role).toBe("user");
      } finally {
        release.resolve();
        await dispatch;
      }
    }
  );

  test("a successful pre-acceptance no-op is not a continued turn", async () => {
    await setup();
    spyOn(h.session, "sendMessage").mockResolvedValueOnce(Ok(undefined));
    expect(await h.session.dispatchPendingCompactionFollowUpIfNeeded()).toBe(false);
    expect((await rows()).map((row) => row.id)).toEqual(["summary"]);
  });

  test("a real startup error remains a failure after the continuation becomes durable", async () => {
    await setup();
    spyOn(h.aiService, "streamMessage").mockResolvedValueOnce(
      Err({ type: "unknown", raw: "startup failed" })
    );
    await expect(h.session.dispatchPendingCompactionFollowUpIfNeeded()).rejects.toThrow(
      "Failed to dispatch pending follow-up"
    );
    const history = await rows();
    expect(history[0].metadata?.muxMetadata).toHaveProperty("pendingFollowUp");
    expect(history.some((row) => row.role === "user")).toBe(true);
  });
});

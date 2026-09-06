import type { StreamAbortEvent } from "@/common/types/stream";
import { runSessionTerminalPolicy } from "./agentSession.testHarness";
import { describe, expect, mock, spyOn, test } from "bun:test";

import type { MuxMessageMetadata } from "@/common/types/message";
import { Err, Ok } from "@/common/types/result";
import type { WorkspaceGoalService } from "./workspaceGoalService";
import { createAgentSessionHarness, createStartedTurnHandle } from "./agentSession.testHarness";
import type { AIService } from "./aiService";

const TEST_MODEL = "anthropic:claude-sonnet-4-5";
const WORKSPACE_TURN_CORRELATION = {
  type: "workspace-turn-task",
  taskHandleId: "wst_preparing",
  ownerWorkspaceId: "owner-workspace",
  turnId: "turn-preparing",
} as const;

function toolCallEndEvent(workspaceId: string): Record<string, unknown> {
  return {
    type: "tool-call-end",
    workspaceId,
    messageId: "assistant-1",
    toolCallId: "tool-call-1",
    toolName: "bash",
    result: { success: true },
    timestamp: Date.now(),
  };
}

function streamStartEvent(workspaceId: string): Record<string, unknown> {
  return {
    type: "stream-start",
    workspaceId,
    messageId: "assistant-1",
    model: TEST_MODEL,
    startTime: Date.now(),
  };
}

function streamAbortEvent(workspaceId: string, abortReason: "system" | "user"): StreamAbortEvent {
  return {
    type: "stream-abort",
    workspaceId,
    messageId: "assistant-1",
    abortReason,
    metadata: { duration: 1 },
  };
}

async function waitForCondition(condition: () => boolean, timeoutMs = 500): Promise<boolean> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (condition()) {
      return true;
    }
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
  return condition();
}

describe("AgentSession queued message tool-call dispatch", () => {
  test.each(["returned error", "rejection"] as const)(
    "reserves queued startup synchronously and drains after %s cleanup",
    async (failureKind) => {
      const workspaceId = `queue-prestart-${failureKind}`;
      const failureEntered = Promise.withResolvers<void>();
      const releaseFailure = Promise.withResolvers<void>();
      const successorStarted = Promise.withResolvers<void>();
      const streamMessage = mock(() => {
        successorStarted.resolve();
        return Promise.resolve(Ok(createStartedTurnHandle()));
      });
      const { session, historyService, cleanup } = await createAgentSessionHarness({
        workspaceId,
        aiServiceOverrides: { streamMessage },
      });
      const append = spyOn(historyService, "appendToHistory");
      if (failureKind === "returned error") {
        append.mockResolvedValueOnce(Err("disk unavailable"));
      } else {
        append.mockRejectedValueOnce(new Error("disk unavailable"));
      }
      const failures: unknown[] = [];

      try {
        session.queueMessage(
          "failed head",
          { model: TEST_MODEL, agentId: "exec" },
          {
            synthetic: true,
            onAcceptedPreStreamFailure: async (error) => {
              failures.push(error);
              failureEntered.resolve();
              await releaseFailure.promise;
            },
          }
        );
        session.queueMessage("surviving successor", { model: TEST_MODEL, agentId: "exec" });
        session.sendQueuedMessages();

        // Admission must cover the first await, or another caller can bypass this FIFO head.
        expect(session.isBusy()).toBe(true);
        expect(session.isPreparingTurn()).toBe(true);
        expect(append).not.toHaveBeenCalled();

        await failureEntered.promise;
        expect(session.isBusy()).toBe(true);
        expect(session.queuedMessageEntryCount()).toBe(1);
        expect(streamMessage).not.toHaveBeenCalled();
        expect(await historyService.getHistoryFromLatestBoundary(workspaceId)).toEqual(Ok([]));

        // No stream-end will arrive for the failed head. Cleanup must finish before its
        // successor persists, then the queue must make progress without an external nudge.
        releaseFailure.resolve();
        await successorStarted.promise;
        await session.waitForIdle();
        expect(failures).toHaveLength(1);
        expect(streamMessage).toHaveBeenCalledTimes(1);
        expect(session.hasQueuedMessages()).toBe(false);
        const history = await historyService.getHistoryFromLatestBoundary(workspaceId);
        expect(history.success).toBe(true);
        if (!history.success) throw new Error(history.error);
        expect(history.data).toMatchObject([
          { role: "user", parts: [{ type: "text", text: "surviving successor" }] },
        ]);
      } finally {
        releaseFailure.resolve();
        append.mockRestore();
        session.dispose();
        await cleanup();
      }
    }
  );

  test("counts only a different direct preparing send as a superseding predecessor", async () => {
    const sessionHolder: {
      current?: {
        hasQueuedOrDispatchingEntry(
          continuationMetadata?: Extract<MuxMessageMetadata, { type: "workspace-turn-task" }>
        ): boolean;
        hasPendingWorkspaceTurnContinuation(
          continuationMetadata: Extract<MuxMessageMetadata, { type: "workspace-turn-task" }>
        ): boolean;
      };
    } = {};
    let preparingState:
      | {
          sameTurn: boolean;
          differentTurn: boolean;
          uncorrelated: boolean;
          pendingSameTurn: boolean;
          pendingDifferentTurn: boolean;
        }
      | undefined;
    const streamMessage = mock(() => {
      const session = sessionHolder.current;
      preparingState = {
        sameTurn: session?.hasQueuedOrDispatchingEntry(WORKSPACE_TURN_CORRELATION) === true,
        differentTurn:
          session?.hasQueuedOrDispatchingEntry({
            ...WORKSPACE_TURN_CORRELATION,
            turnId: "turn-different",
          }) === true,
        uncorrelated: session?.hasQueuedOrDispatchingEntry() === true,
        pendingSameTurn:
          session?.hasPendingWorkspaceTurnContinuation(WORKSPACE_TURN_CORRELATION) === true,
        pendingDifferentTurn:
          session?.hasPendingWorkspaceTurnContinuation({
            ...WORKSPACE_TURN_CORRELATION,
            turnId: "turn-different",
          }) === true,
      };
      return Promise.resolve(Ok(createStartedTurnHandle()));
    });
    const { session, cleanup } = await createAgentSessionHarness({
      workspaceId: "queue-dispatch-preparing-predecessor",
      aiServiceOverrides: {
        streamMessage: streamMessage as unknown as AIService["streamMessage"],
      },
    });
    sessionHolder.current = session;

    try {
      expect(session.hasQueuedOrDispatchingEntry()).toBe(false);
      const result = await session.sendMessage("direct send", {
        model: TEST_MODEL,
        agentId: "exec",
        muxMetadata: WORKSPACE_TURN_CORRELATION,
      });

      expect(result.success).toBe(true);
      expect(preparingState).toEqual({
        sameTurn: false,
        differentTurn: true,
        uncorrelated: true,
        pendingSameTurn: true,
        pendingDifferentTurn: false,
      });
      expect(session.hasQueuedOrDispatchingEntry()).toBe(false);
    } finally {
      session.dispose();
      await cleanup();
    }
  });

  test("preserves correlation for same-turn queued and dequeued predecessors", async () => {
    const { session, cleanup } = await createAgentSessionHarness({
      workspaceId: "queue-dispatch-same-turn-predecessor",
    });
    const differentCorrelation = {
      ...WORKSPACE_TURN_CORRELATION,
      turnId: "turn-different",
    };

    try {
      session.queueMessage(
        "queued continuation",
        { model: TEST_MODEL, agentId: "exec", muxMetadata: WORKSPACE_TURN_CORRELATION },
        { synthetic: true }
      );
      expect(session.hasQueuedOrDispatchingEntry(WORKSPACE_TURN_CORRELATION)).toBe(false);
      expect(session.hasQueuedOrDispatchingEntry(differentCorrelation)).toBe(true);

      session.queueMessage(
        "second queued continuation",
        { model: TEST_MODEL, agentId: "exec", muxMetadata: WORKSPACE_TURN_CORRELATION },
        { synthetic: true }
      );
      expect(session.hasQueuedOrDispatchingEntry(WORKSPACE_TURN_CORRELATION)).toBe(false);

      session.queueMessage(
        "unrelated predecessor",
        { model: TEST_MODEL, agentId: "exec" },
        {
          synthetic: true,
        }
      );
      expect(session.hasQueuedOrDispatchingEntry(WORKSPACE_TURN_CORRELATION)).toBe(true);

      const sendMessage = spyOn(session, "sendMessage").mockResolvedValue(Ok(undefined));
      session.sendQueuedMessages();
      expect(session.hasQueuedOrDispatchingEntry(WORKSPACE_TURN_CORRELATION)).toBe(true);
      expect(session.hasQueuedOrDispatchingEntry(differentCorrelation)).toBe(true);
      sendMessage.mockRestore();
    } finally {
      session.dispose();
      await cleanup();
    }
  });

  test("getQueueCutCutter reports an engaged no-metadata dispatch over a queued follow-up", async () => {
    // Queue-cut attribution must never blame an entry queued BEHIND the input
    // actually taking over the session: a manual message being dispatched wins
    // over a workspace-turn follow-up waiting behind it, even though its
    // metadata is undefined.
    const { session, cleanup } = await createAgentSessionHarness({
      workspaceId: "queue-cut-cutter-preparing",
    });

    try {
      expect(session.getQueueCutCutter()).toBeUndefined();

      session.queueMessage(
        "manual message",
        { model: TEST_MODEL, agentId: "exec" },
        { synthetic: true }
      );
      session.queueMessage(
        "workspace-turn follow-up",
        { model: TEST_MODEL, agentId: "exec", muxMetadata: WORKSPACE_TURN_CORRELATION },
        { synthetic: true }
      );

      // Queued stage: the manual head entry is the candidate (no metadata).
      const queued = session.getQueueCutCutter();
      expect(queued?.stage).toBe("queued");
      expect(queued?.muxMetadata).toBeUndefined();

      // Dispatch the manual entry: it becomes the engaged PREPARING cutter and
      // keeps winning over the follow-up still queued behind it.
      const sendMessage = spyOn(session, "sendMessage").mockResolvedValue(Ok(undefined));
      session.sendQueuedMessages();
      const engaged = session.getQueueCutCutter();
      expect(engaged?.stage).toBe("preparing");
      expect(engaged?.muxMetadata).toBeUndefined();
      sendMessage.mockRestore();
    } finally {
      session.dispose();
      await cleanup();
    }
  });

  test("getQueueCutCutter reports a no-metadata mid-dispatch entry over a queued follow-up", async () => {
    const { session, cleanup } = await createAgentSessionHarness({
      workspaceId: "queue-cut-cutter-dispatching",
    });

    try {
      session.queueMessage(
        "workspace-turn follow-up",
        { model: TEST_MODEL, agentId: "exec", muxMetadata: WORKSPACE_TURN_CORRELATION },
        { synthetic: true }
      );
      // Force the dequeue-to-stream-start window with PREPARING already
      // released (a background send can resolve before stream-start): the
      // dispatched entry stays the engaged cutter.
      const internal = session as unknown as {
        dispatchingQueuedEntry: boolean;
        dispatchingQueuedEntryMuxMetadata?: unknown;
      };
      internal.dispatchingQueuedEntry = true;
      internal.dispatchingQueuedEntryMuxMetadata = undefined;

      const cutter = session.getQueueCutCutter();
      expect(cutter?.stage).toBe("dispatching");
      expect(cutter?.muxMetadata).toBeUndefined();
    } finally {
      session.dispose();
      await cleanup();
    }
  });

  test("getQueueCutCutter exposes the queued head's dispatch mode and correlation", async () => {
    const { session, cleanup } = await createAgentSessionHarness({
      workspaceId: "queue-cut-cutter-queued",
    });

    try {
      session.queueMessage(
        "workspace-turn follow-up",
        {
          model: TEST_MODEL,
          agentId: "exec",
          muxMetadata: WORKSPACE_TURN_CORRELATION,
          queueDispatchMode: "turn-end",
        },
        { synthetic: true }
      );

      const cutter = session.getQueueCutCutter();
      expect(cutter?.stage).toBe("queued");
      expect(cutter?.stage === "queued" ? cutter.dispatchMode : undefined).toBe("turn-end");
      expect((cutter?.muxMetadata as MuxMessageMetadata | undefined)?.type).toBe(
        "workspace-turn-task"
      );

      // Once dispatched, the follow-up's correlation rides through PREPARING.
      const sendMessage = spyOn(session, "sendMessage").mockResolvedValue(Ok(undefined));
      session.sendQueuedMessages();
      const engaged = session.getQueueCutCutter();
      expect(engaged?.stage).toBe("preparing");
      expect((engaged?.muxMetadata as MuxMessageMetadata | undefined)?.type).toBe(
        "workspace-turn-task"
      );
      sendMessage.mockRestore();
    } finally {
      session.dispose();
      await cleanup();
    }
  });

  test("waits for stream-end instead of interrupting between sibling tool results", async () => {
    const workspaceId = "queue-dispatch-full-step";
    const { session, cleanup, aiEmitter, aiService } = await createAgentSessionHarness({
      workspaceId,
    });
    const stopStream = spyOn(aiService, "stopStream").mockResolvedValue(Ok(undefined));
    const sendQueuedMessages = spyOn(session, "sendQueuedMessages").mockImplementation(
      () => undefined
    );

    try {
      aiEmitter.emit("stream-start", streamStartEvent(workspaceId));
      session.queueMessage("follow up", { model: TEST_MODEL, agentId: "exec" });

      aiEmitter.emit("tool-call-end", toolCallEndEvent(workspaceId));
      aiEmitter.emit("tool-call-end", {
        ...toolCallEndEvent(workspaceId),
        toolCallId: "tool-call-2",
      });

      expect(stopStream).not.toHaveBeenCalled();
      expect(sendQueuedMessages).not.toHaveBeenCalled();

      void runSessionTerminalPolicy(session, aiEmitter, {
        type: "stream-end",
        workspaceId,
        messageId: "assistant-1",
        parts: [],
        metadata: {
          model: TEST_MODEL,
          contextUsage: { inputTokens: 5, outputTokens: 5, totalTokens: 10 },
          providerMetadata: {},
          finishReason: "tool-calls",
        },
      });

      const didDispatch = await waitForCondition(() => sendQueuedMessages.mock.calls.length > 0);
      expect(didDispatch).toBe(true);
      expect(sendQueuedMessages).toHaveBeenCalledTimes(1);
    } finally {
      sendQueuedMessages.mockRestore();
      stopStream.mockRestore();
      session.dispose();
      await cleanup();
    }
  });

  test("soft-stops after a provider-executed tool result and dispatches after abort", async () => {
    const workspaceId = "queue-dispatch-provider-tool";
    const { session, cleanup, aiEmitter, aiService } = await createAgentSessionHarness({
      workspaceId,
    });
    const stopStream = spyOn(aiService, "stopStream").mockResolvedValue(Ok(undefined));
    const sendQueuedMessages = spyOn(session, "sendQueuedMessages").mockImplementation(
      () => undefined
    );

    try {
      aiEmitter.emit("stream-start", streamStartEvent(workspaceId));
      session.queueMessage("follow up", { model: TEST_MODEL, agentId: "exec" });

      aiEmitter.emit("tool-call-end", {
        ...toolCallEndEvent(workspaceId),
        toolName: "web_search",
        providerExecuted: true,
      });

      expect(stopStream).toHaveBeenCalledWith(workspaceId, {
        soft: true,
        abortReason: "system",
      });

      void runSessionTerminalPolicy(session, aiEmitter, streamAbortEvent(workspaceId, "system"));
      const didDispatch = await waitForCondition(() => sendQueuedMessages.mock.calls.length > 0);
      expect(didDispatch).toBe(true);
      expect(sendQueuedMessages).toHaveBeenCalledTimes(1);
    } finally {
      sendQueuedMessages.mockRestore();
      stopStream.mockRestore();
      session.dispose();
      await cleanup();
    }
  });

  test("withdrawn tool-end entry neither soft-stops nor hides a later entry's mode", async () => {
    const workspaceId = "queue-dispatch-withdrawn-head";
    const queuedSignals: boolean[] = [];
    const { session, cleanup, aiEmitter, aiService } = await createAgentSessionHarness({
      workspaceId,
      backgroundProcessManagerOverrides: {
        setMessageQueued: mock((_workspaceId: string, queued: boolean) => {
          queuedSignals.push(queued);
        }),
      },
    });
    const stopStream = spyOn(aiService, "stopStream").mockResolvedValue(Ok(undefined));

    try {
      aiEmitter.emit("stream-start", streamStartEvent(workspaceId));
      const controller = new AbortController();
      session.queueMessage(
        "Background monitor wake",
        { model: TEST_MODEL, agentId: "exec", queueDispatchMode: "tool-end" },
        { synthetic: true, agentInitiated: true, cancelSignal: controller.signal }
      );
      expect(session.hasQueuedMessages("tool-end")).toBe(true);

      controller.abort("monitor withdrawn");
      expect(session.hasQueuedMessages("tool-end")).toBe(false);
      expect(session.hasQueuedMessages()).toBe(false);

      aiEmitter.emit("tool-call-end", {
        ...toolCallEndEvent(workspaceId),
        toolName: "web_search",
        providerExecuted: true,
      });
      expect(stopStream).not.toHaveBeenCalled();

      session.queueMessage("follow up", {
        model: TEST_MODEL,
        agentId: "exec",
        queueDispatchMode: "turn-end",
      });
      expect(session.hasQueuedMessages("tool-end")).toBe(false);
      expect(session.hasQueuedMessages("turn-end")).toBe(true);
      expect(queuedSignals).toEqual([true, false]);
    } finally {
      stopStream.mockRestore();
      session.dispose();
      await cleanup();
    }
  });

  test.each([
    ["turn-end", "tool-end"],
    ["tool-end", "turn-end"],
  ] as const)(
    "queueMessage reports the live entry's mode behind a withdrawn %s head",
    async (withdrawnMode, liveMode) => {
      const { session, cleanup } = await createAgentSessionHarness({
        workspaceId: "queue-dispatch-withdrawn-" + withdrawnMode + "-head",
      });
      try {
        const controller = new AbortController();
        session.queueMessage(
          "Background monitor wake",
          { model: TEST_MODEL, agentId: "exec", queueDispatchMode: withdrawnMode },
          { synthetic: true, agentInitiated: true, cancelSignal: controller.signal }
        );
        controller.abort("monitor withdrawn");

        expect(
          session.queueMessage("follow up", {
            model: TEST_MODEL,
            agentId: "exec",
            queueDispatchMode: liveMode,
          })
        ).toBe(liveMode);
      } finally {
        session.dispose();
        await cleanup();
      }
    }
  );

  test("waits for every known sibling before stopping after a provider-executed result", async () => {
    const workspaceId = "queue-dispatch-provider-siblings";
    const { session, cleanup, aiEmitter, aiService } = await createAgentSessionHarness({
      workspaceId,
    });
    const stopStream = spyOn(aiService, "stopStream").mockResolvedValue(Ok(undefined));

    try {
      aiEmitter.emit("stream-start", streamStartEvent(workspaceId));
      session.queueMessage("follow up", { model: TEST_MODEL, agentId: "exec" });
      aiEmitter.emit("tool-call-start", {
        type: "tool-call-start",
        workspaceId,
        messageId: "assistant-1",
        toolCallId: "provider-tool-1",
        toolName: "web_search",
        args: {},
        tokens: 0,
        timestamp: Date.now(),
      });
      aiEmitter.emit("tool-call-start", {
        type: "tool-call-start",
        workspaceId,
        messageId: "assistant-1",
        toolCallId: "provider-tool-2",
        toolName: "web_search",
        args: {},
        tokens: 0,
        timestamp: Date.now(),
      });

      aiEmitter.emit("tool-call-end", {
        ...toolCallEndEvent(workspaceId),
        toolCallId: "provider-tool-1",
        toolName: "web_search",
        providerExecuted: true,
      });
      expect(stopStream).not.toHaveBeenCalled();

      aiEmitter.emit("tool-call-end", {
        ...toolCallEndEvent(workspaceId),
        toolCallId: "provider-tool-2",
        toolName: "web_search",
        providerExecuted: true,
      });
      expect(stopStream).toHaveBeenCalledTimes(1);
    } finally {
      stopStream.mockRestore();
      session.dispose();
      await cleanup();
    }
  });

  // Heartbeat force-queue drain path: a scheduled message queued while the session is IDLE
  // (e.g. a heartbeat deferred behind active descendant tasks) must ride along with the next
  // turn and drain at its stream-end, releasing the dedupe key so the next firing can enqueue.
  test("drains an idle-queued deduped message at the next turn's stream-end", async () => {
    const workspaceId = "queue-dispatch-idle-queued-drain";
    const { session, cleanup, aiEmitter } = await createAgentSessionHarness({
      workspaceId,
    });
    const sendMessage = spyOn(session, "sendMessage").mockResolvedValue(Ok(undefined));

    try {
      expect(session.isBusy()).toBe(false);
      const dispatchMode = session.queueMessage(
        "[Scheduled heartbeat] check in",
        { model: TEST_MODEL, agentId: "exec", queueDispatchMode: "turn-end" },
        { synthetic: true, dedupeKey: "heartbeat-request" }
      );
      expect(dispatchMode).toBe("turn-end");
      expect(session.hasQueuedDedupeKey("heartbeat-request")).toBe(true);

      // A duplicate firing while pending is dropped (coalescing).
      expect(
        session.queueMessage(
          "[Scheduled heartbeat] check in",
          { model: TEST_MODEL, agentId: "exec", queueDispatchMode: "turn-end" },
          { synthetic: true, dedupeKey: "heartbeat-request" }
        )
      ).toBeNull();

      // The next turn (e.g. a descendant-task terminal wake) starts and ends.
      aiEmitter.emit("stream-start", streamStartEvent(workspaceId));
      void runSessionTerminalPolicy(session, aiEmitter, {
        type: "stream-end",
        workspaceId,
        messageId: "assistant-1",
        parts: [{ type: "text", text: "wake turn done" }],
        metadata: {
          model: TEST_MODEL,
          contextUsage: { inputTokens: 5, outputTokens: 5, totalTokens: 10 },
          providerMetadata: {},
          finishReason: "stop",
        },
      });

      const didDrain = await waitForCondition(
        () =>
          sendMessage.mock.calls.some((call) => call[0] === "[Scheduled heartbeat] check in") &&
          !session.hasQueuedMessages()
      );
      expect(didDrain).toBe(true);
      // Queue clear released the dedupe key: the next scheduled firing can enqueue again.
      expect(session.hasQueuedDedupeKey("heartbeat-request")).toBe(false);
    } finally {
      sendMessage.mockRestore();
      session.dispose();
      await cleanup();
    }
  });

  test("updates visible queued dispatch mode without dequeuing content", async () => {
    const workspaceId = "queue-dispatch-mode-update";
    const setMessageQueued = mock((_workspaceId: string, _queued: boolean) => undefined);
    const { session, cleanup, events } = await createAgentSessionHarness({
      workspaceId,
      captureEvents: true,
      backgroundProcessManagerOverrides: { setMessageQueued },
    });

    try {
      session.queueMessage(
        "hidden predecessor",
        { model: TEST_MODEL, agentId: "exec", queueDispatchMode: "turn-end" },
        { synthetic: true, agentInitiated: true }
      );
      session.queueMessage("my queued follow-up", {
        model: TEST_MODEL,
        agentId: "exec",
        queueDispatchMode: "tool-end",
      });

      expect(session.setQueuedMessageDispatchMode("tool-end")).toBe(true);
      const toolEndEvent = events.filter((event) => event.type === "queued-message-changed").at(-1);
      expect(toolEndEvent).toMatchObject({
        queuedMessages: ["my queued follow-up"],
        queueDispatchMode: "tool-end",
      });
      expect(setMessageQueued).toHaveBeenLastCalledWith(workspaceId, true);
      expect(session.hasQueuedMessages()).toBe(true);

      expect(session.setQueuedMessageDispatchMode("turn-end")).toBe(true);
      const turnEndEvent = events.filter((event) => event.type === "queued-message-changed").at(-1);
      expect(turnEndEvent).toMatchObject({
        queuedMessages: ["my queued follow-up"],
        queueDispatchMode: "turn-end",
      });
      expect(setMessageQueued).toHaveBeenLastCalledWith(workspaceId, false);
      expect(session.hasQueuedMessages()).toBe(true);
    } finally {
      session.dispose();
      await cleanup();
    }
  });

  test("restoreQueueToInput discards a queued heartbeat instead of restoring it", async () => {
    const workspaceId = "queue-dispatch-restore-discards-heartbeat";
    const { session, cleanup } = await createAgentSessionHarness({ workspaceId });

    try {
      session.queueMessage(
        "[Scheduled heartbeat] check in",
        { model: TEST_MODEL, agentId: "exec", queueDispatchMode: "turn-end" },
        { synthetic: true, dedupeKey: "heartbeat-request" }
      );
      expect(session.hasQueuedMessages()).toBe(true);

      const restoredTexts: string[] = [];
      const unsubscribe = session.onChatEvent((event) => {
        if (event.message.type === "restore-to-input") {
          restoredTexts.push(event.message.text);
        }
      });

      // A user interrupt restores queued input to the composer — the backend-initiated
      // heartbeat must be discarded, not surfaced as editable user text.
      session.restoreQueueToInput();
      unsubscribe();

      expect(restoredTexts).toEqual([]);
      expect(session.hasQueuedMessages()).toBe(false);
      // Dropping released the dedupe key so the next scheduled firing can enqueue again.
      expect(session.hasQueuedDedupeKey("heartbeat-request")).toBe(false);

      // Plain user input still restores.
      session.queueMessage("my own words", { model: TEST_MODEL, agentId: "exec" });
      const unsubscribeUser = session.onChatEvent((event) => {
        if (event.message.type === "restore-to-input") {
          restoredTexts.push(event.message.text);
        }
      });
      session.restoreQueueToInput();
      unsubscribeUser();
      expect(restoredTexts).toEqual(["my own words"]);
    } finally {
      session.dispose();
      await cleanup();
    }
  });

  test("synthetic background entries neither surface in queue UI nor restore over user input", async () => {
    const workspaceId = "queue-dispatch-hide-synthetic";
    const { session, cleanup } = await createAgentSessionHarness({ workspaceId });

    try {
      const queuedSnapshots: string[][] = [];
      const hasQueuedSnapshots: boolean[] = [];
      const restoredTexts: string[] = [];
      const canceledReasons: string[] = [];
      const unsubscribe = session.onChatEvent((event) => {
        if (event.message.type === "queued-message-changed") {
          queuedSnapshots.push(event.message.queuedMessages);
          hasQueuedSnapshots.push(event.message.hasQueuedMessages ?? false);
        }
        if (event.message.type === "restore-to-input") {
          restoredTexts.push(event.message.text);
        }
      });

      session.queueMessage(
        "Background monitor wake",
        { model: TEST_MODEL, agentId: "exec" },
        {
          synthetic: true,
          agentInitiated: true,
          onCanceled: (reason) => {
            canceledReasons.push(reason);
          },
        }
      );
      expect(hasQueuedSnapshots.at(-1)).toBe(true);
      expect(queuedSnapshots.at(-1)).toEqual([]);

      session.queueMessage("my own words", {
        model: TEST_MODEL,
        agentId: "exec",
        queueDispatchMode: "turn-end",
      });
      expect(queuedSnapshots.at(-1)).toEqual(["my own words"]);

      session.restoreQueueToInput();
      unsubscribe();

      expect(restoredTexts).toEqual(["my own words"]);
      expect(canceledReasons).toHaveLength(1);
      expect(session.hasQueuedMessages()).toBe(false);
    } finally {
      session.dispose();
      await cleanup();
    }
  });

  test("cancel signal retracts a synthetic entry after dequeue while history append is preparing", async () => {
    const workspaceId = "queue-dispatch-cancel-preparing";
    const { session, cleanup, historyService, events } = await createAgentSessionHarness({
      workspaceId,
      captureEvents: true,
    });
    const originalAppend = historyService.appendToHistory.bind(historyService);
    let markAppendStarted: () => void = () => undefined;
    const appendStarted = new Promise<void>((resolve) => {
      markAppendStarted = resolve;
    });
    let releaseAppend: () => void = () => undefined;
    const appendRelease = new Promise<void>((resolve) => {
      releaseAppend = resolve;
    });
    const appendSpy = spyOn(historyService, "appendToHistory").mockImplementation(
      async (...args) => {
        markAppendStarted();
        await appendRelease;
        return originalAppend(...args);
      }
    );

    try {
      const controller = new AbortController();
      const cancelState = { canceledBeforeAcceptance: false };
      const canceledReasons: string[] = [];
      session.queueMessage(
        "Background monitor wake",
        { model: TEST_MODEL, agentId: "exec" },
        {
          synthetic: true,
          agentInitiated: true,
          cancelState,
          cancelSignal: controller.signal,
          onCanceled: (reason) => {
            canceledReasons.push(reason);
          },
        }
      );

      session.sendQueuedMessages();
      await appendStarted;
      controller.abort("monitor canceled");
      releaseAppend();

      expect(await waitForCondition(() => canceledReasons.length === 1)).toBe(true);
      expect(await waitForCondition(() => !session.isBusy())).toBe(true);
      expect(canceledReasons).toEqual(["monitor canceled"]);

      const history = await historyService.getHistoryFromLatestBoundary(workspaceId);
      expect(history.success).toBe(true);
      if (history.success) {
        expect(
          history.data.some((message) =>
            message.parts.some(
              (part) => part.type === "text" && part.text === "Background monitor wake"
            )
          )
        ).toBe(false);
      }
      expect(
        events.some(
          (event) =>
            event.type === "message" &&
            event.role === "user" &&
            event.parts.some(
              (part) => part.type === "text" && part.text === "Background monitor wake"
            )
        )
      ).toBe(false);
    } finally {
      releaseAppend();
      appendSpy.mockRestore();
      session.dispose();
      await cleanup();
    }
  });

  test("rollback failure preserves the wake and continues acceptance", async () => {
    const workspaceId = "queue-dispatch-cancel-rollback-failure";
    const { session, cleanup, historyService } = await createAgentSessionHarness({ workspaceId });
    const originalAppend = historyService.appendToHistory.bind(historyService);
    let markAppendStarted: () => void = () => undefined;
    const appendStarted = new Promise<void>((resolve) => {
      markAppendStarted = resolve;
    });
    let releaseAppend: () => void = () => undefined;
    const appendRelease = new Promise<void>((resolve) => {
      releaseAppend = resolve;
    });
    const appendSpy = spyOn(historyService, "appendToHistory").mockImplementation(
      async (...args) => {
        markAppendStarted();
        await appendRelease;
        return originalAppend(...args);
      }
    );
    const deleteMessagesSpy = spyOn(historyService, "deleteMessages").mockResolvedValue(
      Err("injected rollback failure")
    );

    try {
      const controller = new AbortController();
      const cancelState = { canceledBeforeAcceptance: false };
      const canceledReasons: string[] = [];
      let accepted = false;
      const sendPromise = session.sendMessage(
        "Background monitor wake",
        { model: TEST_MODEL, agentId: "exec" },
        {
          synthetic: true,
          agentInitiated: true,
          cancelState,
          cancelSignal: controller.signal,
          onCanceled: (reason) => {
            canceledReasons.push(reason);
          },
          onAccepted: () => {
            accepted = true;
          },
        }
      );

      await appendStarted;
      controller.abort("monitor canceled");
      releaseAppend();
      const result = await sendPromise;

      expect(result.success).toBe(true);
      expect(deleteMessagesSpy).toHaveBeenCalledTimes(1);
      expect(canceledReasons).toEqual([]);
      expect(cancelState.canceledBeforeAcceptance).toBe(false);
      expect(accepted).toBe(true);

      const history = await historyService.getHistoryFromLatestBoundary(workspaceId);
      expect(history.success).toBe(true);
      if (history.success) {
        expect(
          history.data.some((message) =>
            message.parts.some(
              (part) => part.type === "text" && part.text === "Background monitor wake"
            )
          )
        ).toBe(true);
      }
    } finally {
      releaseAppend();
      deleteMessagesSpy.mockRestore();
      appendSpy.mockRestore();
      session.dispose();
      await cleanup();
    }
  });

  test("verifies a committed rollback when batch deletion reports a post-write failure", async () => {
    const workspaceId = "queue-dispatch-cancel-post-write-failure";
    const { session, cleanup, historyService } = await createAgentSessionHarness({ workspaceId });
    const originalAppend = historyService.appendToHistory.bind(historyService);
    const originalDeleteMessages = historyService.deleteMessages.bind(historyService);
    let markAppendStarted: () => void = () => undefined;
    const appendStarted = new Promise<void>((resolve) => {
      markAppendStarted = resolve;
    });
    let releaseAppend: () => void = () => undefined;
    const appendRelease = new Promise<void>((resolve) => {
      releaseAppend = resolve;
    });
    const appendSpy = spyOn(historyService, "appendToHistory").mockImplementation(
      async (...args) => {
        markAppendStarted();
        await appendRelease;
        return originalAppend(...args);
      }
    );
    const deleteMessagesSpy = spyOn(historyService, "deleteMessages").mockImplementation(
      async (...args) => {
        const result = await originalDeleteMessages(...args);
        expect(result.success).toBe(true);
        return Err("injected post-write failure");
      }
    );

    try {
      const controller = new AbortController();
      const cancelState = { canceledBeforeAcceptance: false };
      const canceledReasons: string[] = [];
      let accepted = false;
      const sendPromise = session.sendMessage(
        "Background monitor wake",
        { model: TEST_MODEL, agentId: "exec" },
        {
          synthetic: true,
          agentInitiated: true,
          cancelState,
          cancelSignal: controller.signal,
          onCanceled: (reason) => {
            canceledReasons.push(reason);
          },
          onAccepted: () => {
            accepted = true;
          },
        }
      );

      await appendStarted;
      controller.abort("monitor canceled");
      releaseAppend();
      const result = await sendPromise;

      expect(result.success).toBe(true);
      expect(deleteMessagesSpy).toHaveBeenCalledTimes(1);
      expect(canceledReasons).toEqual(["monitor canceled"]);
      expect(cancelState.canceledBeforeAcceptance).toBe(true);
      expect(accepted).toBe(false);

      const history = await historyService.getHistoryFromLatestBoundary(workspaceId);
      expect(history.success).toBe(true);
      if (history.success) {
        expect(
          history.data.some((message) =>
            message.parts.some(
              (part) => part.type === "text" && part.text === "Background monitor wake"
            )
          )
        ).toBe(false);
      }
    } finally {
      releaseAppend();
      deleteMessagesSpy.mockRestore();
      appendSpy.mockRestore();
      session.dispose();
      await cleanup();
    }
  });

  test("cancellation during goal sync crosses the acceptance point of no return", async () => {
    const workspaceId = "queue-dispatch-cancel-goal-reconcile";
    let markInitialSyncStarted: () => void = () => undefined;
    const initialSyncStarted = new Promise<void>((resolve) => {
      markInitialSyncStarted = resolve;
    });
    let releaseInitialSync: () => void = () => undefined;
    const initialSyncRelease = new Promise<void>((resolve) => {
      releaseInitialSync = resolve;
    });
    let syncCalls = 0;
    const syncGoalModeWithChatTail = mock(async () => {
      syncCalls += 1;
      if (syncCalls === 1) {
        markInitialSyncStarted();
        await initialSyncRelease;
      }
      return null;
    });
    const workspaceGoalService = {
      assertPricedModelForBudgetedGoal: mock(() => Promise.resolve(Ok(undefined))),
      syncGoalModeWithChatTail,
    } as unknown as WorkspaceGoalService;
    const { session, cleanup, historyService } = await createAgentSessionHarness({
      workspaceId,
      workspaceGoalService,
    });

    try {
      const controller = new AbortController();
      const cancelState = { canceledBeforeAcceptance: false };
      const canceledReasons: string[] = [];
      let accepted = false;
      const sendPromise = session.sendMessage(
        "Background monitor wake",
        { model: TEST_MODEL, agentId: "exec" },
        {
          synthetic: true,
          agentInitiated: true,
          cancelState,
          cancelSignal: controller.signal,
          onCanceled: (reason) => {
            canceledReasons.push(reason);
          },
          onAccepted: () => {
            accepted = true;
          },
        }
      );

      await initialSyncStarted;
      controller.abort("monitor canceled");
      releaseInitialSync();
      const result = await sendPromise;

      expect(result.success).toBe(true);
      expect(syncGoalModeWithChatTail).toHaveBeenCalledTimes(1);
      expect(canceledReasons).toEqual([]);
      expect(cancelState.canceledBeforeAcceptance).toBe(false);
      expect(accepted).toBe(true);

      const history = await historyService.getHistoryFromLatestBoundary(workspaceId);
      expect(history.success).toBe(true);
      if (history.success) {
        expect(
          history.data.some((message) =>
            message.parts.some(
              (part) => part.type === "text" && part.text === "Background monitor wake"
            )
          )
        ).toBe(true);
      }
    } finally {
      releaseInitialSync();
      session.dispose();
      await cleanup();
    }
  });

  test("disposed sessions finalize durable wakes after goal sync completes", async () => {
    const workspaceId = "queue-dispatch-disposed-after-goal-sync";
    let markSyncStarted: () => void = () => undefined;
    const syncStarted = new Promise<void>((resolve) => {
      markSyncStarted = resolve;
    });
    let releaseSync: () => void = () => undefined;
    const syncRelease = new Promise<void>((resolve) => {
      releaseSync = resolve;
    });
    const syncGoalModeWithChatTail = mock(async () => {
      markSyncStarted();
      await syncRelease;
      return null;
    });
    const workspaceGoalService = {
      assertPricedModelForBudgetedGoal: mock(() => Promise.resolve(Ok(undefined))),
      syncGoalModeWithChatTail,
    } as unknown as WorkspaceGoalService;
    const { session, cleanup } = await createAgentSessionHarness({
      workspaceId,
      workspaceGoalService,
    });

    let disposed = false;
    try {
      const controller = new AbortController();
      const cancelState = { canceledBeforeAcceptance: false };
      let accepted = false;
      const sendPromise = session.sendMessage(
        "Background monitor wake",
        { model: TEST_MODEL, agentId: "exec" },
        {
          synthetic: true,
          agentInitiated: true,
          cancelState,
          cancelSignal: controller.signal,
          onAccepted: () => {
            accepted = true;
          },
        }
      );

      await syncStarted;
      session.dispose();
      disposed = true;
      releaseSync();
      const result = await sendPromise;

      expect(result.success).toBe(true);
      expect(accepted).toBe(true);
      expect(cancelState.canceledBeforeAcceptance).toBe(false);
    } finally {
      releaseSync();
      if (!disposed) session.dispose();
      await cleanup();
    }
  });

  test("every goal sync failure after the boundary finalizes the durable wake", async () => {
    const workspaceId = "queue-dispatch-cancel-goal-sync-failure";
    let markSyncStarted: () => void = () => undefined;
    const syncStarted = new Promise<void>((resolve) => {
      markSyncStarted = resolve;
    });
    let releaseSync: () => void = () => undefined;
    const syncRelease = new Promise<void>((resolve) => {
      releaseSync = resolve;
    });
    const syncGoalModeWithChatTail = mock(async () => {
      markSyncStarted();
      await syncRelease;
      throw new Error("injected goal sync failure");
    });
    const workspaceGoalService = {
      assertPricedModelForBudgetedGoal: mock(() => Promise.resolve(Ok(undefined))),
      syncGoalModeWithChatTail,
    } as unknown as WorkspaceGoalService;
    const { session, cleanup, historyService } = await createAgentSessionHarness({
      workspaceId,
      workspaceGoalService,
    });

    try {
      const controller = new AbortController();
      const cancelState = { canceledBeforeAcceptance: false };
      const canceledReasons: string[] = [];
      let accepted = false;
      const sendPromise = session.sendMessage(
        "Background monitor wake",
        { model: TEST_MODEL, agentId: "exec" },
        {
          synthetic: true,
          agentInitiated: true,
          cancelState,
          cancelSignal: controller.signal,
          onCanceled: (reason) => {
            canceledReasons.push(reason);
          },
          onAccepted: () => {
            accepted = true;
          },
        }
      );

      await syncStarted;
      releaseSync();
      let syncError: unknown;
      try {
        await sendPromise;
      } catch (error) {
        syncError = error;
      }
      expect(syncError).toBeInstanceOf(Error);
      expect((syncError as Error).message).toContain("injected goal sync failure");

      expect(accepted).toBe(true);
      expect(canceledReasons).toEqual([]);
      expect(cancelState.canceledBeforeAcceptance).toBe(false);
      const history = await historyService.getHistoryFromLatestBoundary(workspaceId);
      expect(history.success).toBe(true);
      if (history.success) {
        expect(
          history.data.some((message) =>
            message.parts.some(
              (part) => part.type === "text" && part.text === "Background monitor wake"
            )
          )
        ).toBe(true);
      }
    } finally {
      releaseSync();
      session.dispose();
      await cleanup();
    }
  });

  test("hard user interrupt cancels a pending provider-tool dispatch", async () => {
    const workspaceId = "queue-dispatch-hard-user-interrupt";
    const { session, cleanup, aiEmitter, aiService } = await createAgentSessionHarness({
      workspaceId,
    });
    const stopStream = spyOn(aiService, "stopStream").mockResolvedValue(Ok(undefined));
    const sendQueuedMessages = spyOn(session, "sendQueuedMessages").mockImplementation(
      () => undefined
    );

    try {
      aiEmitter.emit("stream-start", streamStartEvent(workspaceId));
      session.queueMessage("follow up", { model: TEST_MODEL, agentId: "exec" });
      aiEmitter.emit("tool-call-end", {
        ...toolCallEndEvent(workspaceId),
        toolName: "web_search",
        providerExecuted: true,
      });
      expect(stopStream).toHaveBeenCalledTimes(1);

      const interruptResult = await session.interruptStream();
      expect(interruptResult.success).toBe(true);
      // The native soft-stop can still win the event race after the hard user interrupt.
      void runSessionTerminalPolicy(session, aiEmitter, streamAbortEvent(workspaceId, "system"));

      await new Promise((resolve) => setTimeout(resolve, 25));
      expect(sendQueuedMessages).not.toHaveBeenCalled();
    } finally {
      sendQueuedMessages.mockRestore();
      stopStream.mockRestore();
      session.dispose();
      await cleanup();
    }
  });

  test("rejected queued dispatch surfaces through onAcceptedPreStreamFailure", async () => {
    const workspaceId = "queue-dispatch-rejected";
    const { session, cleanup } = await createAgentSessionHarness({ workspaceId });
    const failures: string[] = [];

    try {
      session.queueMessage(
        "queued peer trigger",
        { model: TEST_MODEL, agentId: "exec" },
        {
          synthetic: true,
          // Peer sends refund their family-message reservation through this hook; a dispatch
          // that REJECTS (throws) instead of returning Err must reach it just like the
          // returned-error branch, or the reservation is stranded until restart.
          onAcceptedPreStreamFailure: (error) => {
            failures.push(error.type === "unknown" ? error.raw : error.type);
          },
        }
      );
      const sendMessage = spyOn(session, "sendMessage").mockImplementation(() =>
        Promise.reject(new Error("pricing gate exploded"))
      );
      session.sendQueuedMessages();
      expect(await waitForCondition(() => failures.length === 1)).toBe(true);
      expect(failures[0]).toContain("pricing gate exploded");
      sendMessage.mockRestore();
    } finally {
      session.dispose();
      await cleanup();
    }
  });
});

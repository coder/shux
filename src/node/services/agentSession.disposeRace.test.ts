import * as path from "path";
import { describe, expect, test, mock, spyOn } from "bun:test";
import { existsSync } from "node:fs";
import * as fs from "node:fs/promises";
import * as nodePath from "node:path";
import { AgentSession } from "./agentSession";
import type { Config } from "@/node/config";
import { createTestHistoryService } from "./testHistoryService";
import type { AIService } from "./aiService";
import type { InitStateManager } from "./initStateManager";
import type { BackgroundProcessManager } from "./backgroundProcessManager";
import type { Result } from "@/common/types/result";
import { Err, Ok } from "@/common/types/result";
import { createMuxMessage } from "@/common/types/message";
import * as branchSummary from "./branchSummary";
import {
  clearPendingBranchSummary,
  startAbandonedBranchSummaryInBackground,
  type BranchSummaryAiService,
} from "./branchSummary";
import { createAgentSessionHarness, createStreamLifecycleMocks } from "./agentSession.testHarness";
import type { StreamMessageOptions } from "./aiService";
import type { TurnCompletion } from "./streamManager";
import type { TurnCoordinator } from "./turnCoordinator";

function createDeferred<T>(): {
  promise: Promise<T>;
  resolve: (value: T) => void;
} {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((res) => {
    resolve = res;
  });
  return { promise, resolve };
}

describe("AgentSession disposal race conditions", () => {
  test("does not crash if disposed while auto-sending a queued message", async () => {
    const aiHandlers = new Map<string, (...args: unknown[]) => void>();

    const streamMessage = mock(() => Promise.resolve(Ok(undefined)));

    const aiService: AIService = {
      ...createStreamLifecycleMocks(),
      on(eventName: string | symbol, listener: (...args: unknown[]) => void) {
        aiHandlers.set(String(eventName), listener);
        return this;
      },
      off(_eventName: string | symbol, _listener: (...args: unknown[]) => void) {
        return this;
      },
      stopStream: mock(() => Promise.resolve(Ok(undefined))),
      isStreaming: mock(() => false),
      streamMessage,
    } as unknown as AIService;

    const history = await createTestHistoryService();
    const historyService = history.historyService;

    const initStateManager: InitStateManager = {
      on(_eventName: string | symbol, _listener: (...args: unknown[]) => void) {
        return this;
      },
      off(_eventName: string | symbol, _listener: (...args: unknown[]) => void) {
        return this;
      },
    } as unknown as InitStateManager;

    const backgroundProcessManager: BackgroundProcessManager = {
      cleanup: mock(() => Promise.resolve()),
      setMessageQueued: mock(() => undefined),
    } as unknown as BackgroundProcessManager;

    const config: Config = {
      srcDir: "/tmp",
      sessionsDir: "/tmp",
    } as unknown as Config;

    const session = new AgentSession({
      workspaceId: "ws",
      config,
      historyService,
      aiService,
      initStateManager,
      backgroundProcessManager,
    });

    // Capture the fire-and-forget sendMessage() promise that sendQueuedMessages() creates.
    const originalSendMessage = session.sendMessage.bind(session);
    let inFlight: Promise<unknown> | undefined;
    (session as unknown as { sendMessage: typeof originalSendMessage }).sendMessage = (
      ...args: Parameters<typeof originalSendMessage>
    ) => {
      const promise = originalSendMessage(...args);
      inFlight = promise;
      return promise;
    };

    session.queueMessage("Queued message", {
      model: "anthropic:claude-sonnet-4-5",
      agentId: "exec",
    });
    session.sendQueuedMessages();

    expect(inFlight).toBeDefined();

    // Dispose during queued admission, before a replacement can become durable.
    session.beginDispose();

    const result = await (inFlight as Promise<Result<void>>);
    expect(result.success).toBe(false);
    expect(await historyService.getLastMessages("ws", 1)).toEqual(Ok([]));

    // We should not attempt to stream once disposal has begun.
    expect(streamMessage).toHaveBeenCalledTimes(0);

    // Sanity: invoking a forwarded handler after dispose should be a no-op.
    const streamStart = aiHandlers.get("stream-start");
    expect(() =>
      streamStart?.({
        type: "stream-start",
        workspaceId: "ws",
        messageId: "m1",
        model: "anthropic:claude-sonnet-4-5",
        historySequence: 1,
        startTime: Date.now(),
      })
    ).not.toThrow();
    await session.dispose();
    await history.cleanup();
  });

  test("bails out of a send parked on the branch-summary await when removal disposes the session", async () => {
    const streamMessage = mock(() => Promise.resolve(Ok(undefined)));
    const aiService: AIService = {
      ...createStreamLifecycleMocks(),
      on(_eventName: string | symbol, _listener: (...args: unknown[]) => void) {
        return this;
      },
      off(_eventName: string | symbol, _listener: (...args: unknown[]) => void) {
        return this;
      },
      stopStream: mock(() => Promise.resolve(Ok(undefined))),
      isStreaming: mock(() => false),
      streamMessage,
    } as unknown as AIService;

    // Real HistoryService on a real temp session dir (r55): the assertion
    // below is about actual disk state — a late append would recreate the
    // just-deleted session directory — so mock call counts prove nothing.
    // The race seam stays at the gated MODEL creation, not at history I/O.
    const { historyService, config, cleanup } = await createTestHistoryService();

    const initStateManager: InitStateManager = {
      on(_eventName: string | symbol, _listener: (...args: unknown[]) => void) {
        return this;
      },
      off(_eventName: string | symbol, _listener: (...args: unknown[]) => void) {
        return this;
      },
    } as unknown as InitStateManager;

    const backgroundProcessManager: BackgroundProcessManager = {
      cleanup: mock(() => Promise.resolve()),
      setMessageQueued: mock(() => undefined),
    } as unknown as BackgroundProcessManager;

    const workspaceId = "ws-branch-summary-dispose";
    const sessionDir = path.join(config.sessionsDir, workspaceId);
    const summaryEntered = Promise.withResolvers<void>();
    const awaitSummary = branchSummary.awaitPendingBranchSummary;
    const summaryWait = spyOn(branchSummary, "awaitPendingBranchSummary").mockImplementation(
      (...args) => {
        const pending = awaitSummary(...args);
        summaryEntered.resolve();
        return pending;
      }
    );
    try {
      const session = new AgentSession({
        workspaceId,
        config,
        historyService,
        aiService,
        initStateManager,
        backgroundProcessManager,
      });

      // Register a gated background summary (generation held open at model
      // creation) so sendMessage parks on awaitPendingBranchSummary — the exact
      // window workspace removal races into. Same real HistoryService as the
      // session, mirroring production.
      let releaseModel: () => void = () => undefined;
      const modelGate = new Promise<void>((resolve) => {
        releaseModel = resolve;
      });
      const gatedAiService = {
        createModelWithPinnedMetadata: async () => {
          await modelGate;
          return Err({ type: "api_key_not_found" as const, provider: "anthropic" });
        },
        // Side-channel candidates are confined to workspace-configured
        // providers; metadata must resolve with a model or the writer settles
        // null before createModelWithPinnedMetadata — the gate above would
        // never park the send.
        getWorkspaceMetadata: () =>
          Promise.resolve(Ok({ aiSettings: { model: "anthropic:claude-sonnet-4-5" } })),
      } as unknown as BranchSummaryAiService;
      // Large enough to clear the tiny-segment threshold (chars/4 heuristic).
      const filler = "investigated the dispose race and traced the write path ".repeat(200);
      await startAbandonedBranchSummaryInBackground({
        historyService,
        aiService: gatedAiService,
        workspaceId,
        abandonedMessages: [
          createMuxMessage("bs-u", "user", filler, { timestamp: 1 }),
          createMuxMessage("bs-a", "assistant", filler, { timestamp: 2 }),
        ],
        experiments: { rlm: true, programmaticToolCalling: true },
        guardTailMessageId: "bs-a",
      });

      const sendPromise = session.sendMessage("first send on the fork", {
        model: "anthropic:claude-sonnet-4-5",
        agentId: "exec",
      });
      // Compaction admission now does disk I/O first; signal the actual await instead of
      // assuming it has been reached after a timer on a loaded CI runner.
      await Promise.race([
        summaryEntered.promise,
        sendPromise.then(() => {
          throw new Error("send settled before awaiting the branch summary");
        }),
      ]);
      expect(existsSync(nodePath.join(sessionDir, "chat.jsonl"))).toBe(false);

      // Mirror removeWorkspace: dispose the session, cancel + drain the
      // writer, then delete the session directory.
      session.beginDispose();
      const clearPromise = clearPendingBranchSummary(workspaceId);
      releaseModel();
      await clearPromise;
      await session.dispose();
      await fs.rm(sessionDir, { recursive: true, force: true });

      const result = await sendPromise;
      expect(result.success).toBe(true);
      expect(streamMessage).toHaveBeenCalledTimes(0);
      // Give any stray late write a macrotask to land before inspecting disk.
      await new Promise((resolve) => setTimeout(resolve, 10));
      // Neither the resumed send nor the cancelled writer wrote anything: the
      // just-deleted session directory must not have been recreated.
      expect(existsSync(sessionDir)).toBe(false);
      // Read-back through the real service agrees: no history rows survived.
      const readBack = await historyService.getHistoryFromLatestBoundary(workspaceId);
      expect(readBack.success).toBe(true);
      if (readBack.success) {
        expect(readBack.data).toHaveLength(0);
      }
    } finally {
      summaryWait.mockRestore();
      await cleanup();
    }
  });

  test("forwards task-created events to onChatEvent subscribers for the matching workspace", async () => {
    const aiHandlers = new Map<string, (...args: unknown[]) => void>();

    const aiService: AIService = {
      ...createStreamLifecycleMocks(),
      on(eventName: string | symbol, listener: (...args: unknown[]) => void) {
        aiHandlers.set(String(eventName), listener);
        return this;
      },
      off(_eventName: string | symbol, _listener: (...args: unknown[]) => void) {
        return this;
      },
      stopStream: mock(() => Promise.resolve(Ok(undefined))),
      isStreaming: mock(() => false),
      streamMessage: mock(() => Promise.resolve(Ok(undefined))),
    } as unknown as AIService;

    // Session startup owns compaction/history services even when this test only forwards events.
    const { historyService, config, cleanup } = await createTestHistoryService();
    await using _history = { [Symbol.asyncDispose]: cleanup };

    const initStateManager: InitStateManager = {
      on(_eventName: string | symbol, _listener: (...args: unknown[]) => void) {
        return this;
      },
      off(_eventName: string | symbol, _listener: (...args: unknown[]) => void) {
        return this;
      },
    } as unknown as InitStateManager;

    const backgroundProcessManager: BackgroundProcessManager = {
      cleanup: mock(() => Promise.resolve()),
      setMessageQueued: mock(() => undefined),
    } as unknown as BackgroundProcessManager;

    const session = new AgentSession({
      workspaceId: "ws",
      config,
      historyService,
      aiService,
      initStateManager,
      backgroundProcessManager,
    });
    await using _session = { [Symbol.asyncDispose]: () => session.dispose() };

    const chatEvents: Array<{ workspaceId: string; message: unknown }> = [];
    session.onChatEvent((event) => {
      chatEvents.push(event);
    });

    const taskCreated = aiHandlers.get("task-created");
    expect(taskCreated).toBeDefined();

    taskCreated?.({
      type: "task-created",
      workspaceId: "other-workspace",
      toolCallId: "tool-call-1",
      taskId: "task-1",
      timestamp: 100,
    });
    expect(chatEvents).toHaveLength(0);

    taskCreated?.({
      type: "task-created",
      workspaceId: "ws",
      toolCallId: "tool-call-1",
      taskId: "task-1",
      timestamp: 101,
    });

    expect(chatEvents).toHaveLength(1);
    expect(chatEvents[0]).toEqual({
      workspaceId: "ws",
      message: {
        type: "task-created",
        workspaceId: "ws",
        toolCallId: "tool-call-1",
        taskId: "task-1",
        timestamp: 101,
      },
    });
  });

  test("forwards session-usage-delta events to onChatEvent subscribers for the matching workspace", async () => {
    const aiHandlers = new Map<string, (...args: unknown[]) => void>();

    const aiService: AIService = {
      ...createStreamLifecycleMocks(),
      on(eventName: string | symbol, listener: (...args: unknown[]) => void) {
        aiHandlers.set(String(eventName), listener);
        return this;
      },
      off(_eventName: string | symbol, _listener: (...args: unknown[]) => void) {
        return this;
      },
      stopStream: mock(() => Promise.resolve(Ok(undefined))),
      isStreaming: mock(() => false),
      streamMessage: mock(() => Promise.resolve(Ok(undefined))),
    } as unknown as AIService;

    const { historyService, config, cleanup } = await createTestHistoryService();
    await using _history = { [Symbol.asyncDispose]: cleanup };

    const initStateManager: InitStateManager = {
      on(_eventName: string | symbol, _listener: (...args: unknown[]) => void) {
        return this;
      },
      off(_eventName: string | symbol, _listener: (...args: unknown[]) => void) {
        return this;
      },
    } as unknown as InitStateManager;

    const backgroundProcessManager: BackgroundProcessManager = {
      cleanup: mock(() => Promise.resolve()),
      setMessageQueued: mock(() => undefined),
    } as unknown as BackgroundProcessManager;

    const session = new AgentSession({
      workspaceId: "ws",
      config,
      historyService,
      aiService,
      initStateManager,
      backgroundProcessManager,
    });
    await using _session = { [Symbol.asyncDispose]: () => session.dispose() };

    const chatEvents: Array<{ workspaceId: string; message: unknown }> = [];
    session.onChatEvent((event) => {
      chatEvents.push(event);
    });

    const usageDeltaPayload = {
      "anthropic:claude-sonnet-4-20250514": {
        input: { tokens: 10, cost_usd: 0.005 },
        cached: { tokens: 0, cost_usd: 0 },
        cacheCreate: { tokens: 0, cost_usd: 0 },
        output: { tokens: 5, cost_usd: 0.005 },
        reasoning: { tokens: 0, cost_usd: 0 },
      },
    };

    const sessionUsageDelta = aiHandlers.get("session-usage-delta");
    expect(sessionUsageDelta).toBeDefined();

    sessionUsageDelta?.({
      type: "session-usage-delta",
      workspaceId: "other-workspace",
      sourceWorkspaceId: "other-workspace",
      byModelDelta: usageDeltaPayload,
      timestamp: 100,
    });
    expect(chatEvents).toHaveLength(0);

    sessionUsageDelta?.({
      type: "session-usage-delta",
      workspaceId: "ws",
      sourceWorkspaceId: "ws",
      byModelDelta: usageDeltaPayload,
      timestamp: 101,
    });

    expect(chatEvents).toHaveLength(1);
    expect(chatEvents[0]).toEqual({
      workspaceId: "ws",
      message: {
        type: "session-usage-delta",
        workspaceId: "ws",
        sourceWorkspaceId: "ws",
        byModelDelta: usageDeltaPayload,
        timestamp: 101,
      },
    });
  });

  test("does not reset auto-retry intent for synthetic or rejected sends", async () => {
    const aiService: AIService = {
      ...createStreamLifecycleMocks(),
      on(_eventName: string | symbol, _listener: (...args: unknown[]) => void) {
        return this;
      },
      off(_eventName: string | symbol, _listener: (...args: unknown[]) => void) {
        return this;
      },
      stopStream: mock(() => Promise.resolve(Ok(undefined))),
      isStreaming: mock(() => false),
      streamMessage: mock(() => Promise.resolve(Ok(undefined))),
    } as unknown as AIService;

    const { historyService, config, cleanup } = await createTestHistoryService();
    await using _history = { [Symbol.asyncDispose]: cleanup };

    const initStateManager: InitStateManager = {
      on(_eventName: string | symbol, _listener: (...args: unknown[]) => void) {
        return this;
      },
      off(_eventName: string | symbol, _listener: (...args: unknown[]) => void) {
        return this;
      },
    } as unknown as InitStateManager;

    const backgroundProcessManager: BackgroundProcessManager = {
      cleanup: mock(() => Promise.resolve()),
      setMessageQueued: mock(() => undefined),
    } as unknown as BackgroundProcessManager;

    const session = new AgentSession({
      workspaceId: "ws",
      config,
      historyService,
      aiService,
      initStateManager,
      backgroundProcessManager,
    });
    await using _session = { [Symbol.asyncDispose]: () => session.dispose() };

    const { retryManager } = session as unknown as {
      retryManager: { cancel: () => void; setEnabled: (enabled: boolean) => void };
    };
    const cancel = spyOn(retryManager, "cancel");
    const setEnabled = spyOn(retryManager, "setEnabled");

    const options = {
      model: "anthropic:claude-sonnet-4-5",
      agentId: "exec",
    };

    const syntheticResult = await session.sendMessage("", options, { synthetic: true });
    expect(syntheticResult.success).toBe(false);
    expect(cancel).toHaveBeenCalledTimes(0);
    expect(setEnabled).toHaveBeenCalledTimes(0);

    const userResult = await session.sendMessage("", options);
    expect(userResult.success).toBe(false);
    expect(cancel).toHaveBeenCalledTimes(0);
    expect(setEnabled).toHaveBeenCalledTimes(0);
  });

  test("drops failed turn completions delivered after disposal", async () => {
    const completion = createDeferred<TurnCompletion>();
    const streamMessage = mock((_opts: StreamMessageOptions) =>
      Promise.resolve(Ok({ messageId: "assistant-post-dispose", completion: completion.promise }))
    );
    const { session, cleanup } = await createAgentSessionHarness({
      workspaceId: "ws-dispose-turn-completion",
      aiServiceOverrides: {
        streamMessage: streamMessage as unknown as AIService["streamMessage"],
      },
    });
    try {
      const result = await session.sendMessage("hello", {
        model: "anthropic:claude-3-5-sonnet-latest",
        agentId: "exec",
      });
      expect(result.success).toBe(true);

      const errorSink = session as unknown as {
        handleStreamError: (data: unknown) => Promise<void>;
      };
      const handleStreamErrorSpy = spyOn(errorSink, "handleStreamError");
      session.beginDispose();
      completion.resolve({
        status: "failed",
        streamError: { messageId: "assistant-post-dispose", error: "boom", errorType: "api" },
      });
      await new Promise((resolve) => setTimeout(resolve, 0));
      expect(handleStreamErrorSpy).not.toHaveBeenCalled();
    } finally {
      await session.dispose();
      await cleanup();
    }
  });

  test("skips handle-less startup-failure recovery when disposal begins mid-startup", async () => {
    const commitDeferred = createDeferred<Result<void>>();
    const commitEntered = Promise.withResolvers<void>();
    const { session, historyService, cleanup } = await createAgentSessionHarness({
      workspaceId: "ws-dispose-startup-failure",
    });
    try {
      spyOn(historyService, "commitPartial").mockImplementationOnce(() => {
        commitEntered.resolve();
        return commitDeferred.promise;
      });
      const errorSink = session as unknown as {
        handleStreamError: (data: unknown) => Promise<void>;
        handleStreamFailureForAutoRetry: (failure: unknown) => Promise<void>;
      };
      const handleStreamErrorSpy = spyOn(errorSink, "handleStreamError");
      const autoRetrySpy = spyOn(errorSink, "handleStreamFailureForAutoRetry");

      const resumePromise = session.resumeStream({
        model: "anthropic:claude-3-5-sonnet-latest",
        agentId: "exec",
      });
      // Wait for the intended startup failure seam, including any earlier admission I/O.
      await Promise.race([
        commitEntered.promise,
        resumePromise.then(() => {
          throw new Error("resume settled before committing its partial");
        }),
      ]);
      session.beginDispose();
      commitDeferred.resolve(Err("workspace removed mid-startup"));

      const result = await resumePromise;
      expect(result.success).toBe(false);
      if (!result.success) {
        expect(result.failureHandled).toBe(true);
      }
      expect(handleStreamErrorSpy).not.toHaveBeenCalled();
      expect(autoRetrySpy).not.toHaveBeenCalled();
    } finally {
      await session.dispose();
      await cleanup();
    }
  });

  test("preserves synthetic flag when flushing queued messages", async () => {
    const aiService: AIService = {
      ...createStreamLifecycleMocks(),
      on(_eventName: string | symbol, _listener: (...args: unknown[]) => void) {
        return this;
      },
      off(_eventName: string | symbol, _listener: (...args: unknown[]) => void) {
        return this;
      },
      stopStream: mock(() => Promise.resolve(Ok(undefined))),
      isStreaming: mock(() => false),
      streamMessage: mock(() => Promise.resolve(Ok(undefined))),
    } as unknown as AIService;

    const { historyService, config, cleanup } = await createTestHistoryService();
    await using _history = { [Symbol.asyncDispose]: cleanup };

    const initStateManager: InitStateManager = {
      on(_eventName: string | symbol, _listener: (...args: unknown[]) => void) {
        return this;
      },
      off(_eventName: string | symbol, _listener: (...args: unknown[]) => void) {
        return this;
      },
    } as unknown as InitStateManager;

    const backgroundProcessManager: BackgroundProcessManager = {
      cleanup: mock(() => Promise.resolve()),
      setMessageQueued: mock(() => undefined),
    } as unknown as BackgroundProcessManager;

    const session = new AgentSession({
      workspaceId: "ws",
      config,
      historyService,
      aiService,
      initStateManager,
      backgroundProcessManager,
    });
    await using _session = { [Symbol.asyncDispose]: () => session.dispose() };

    const sendMessage = mock(
      (
        _message: string,
        _options?: { model: string; agentId: string },
        _internal?: { synthetic?: boolean; enqueuedAtMs?: number }
      ) => Promise.resolve(Ok(undefined))
    );

    (session as unknown as { sendMessage: typeof sendMessage }).sendMessage = sendMessage;

    session.queueMessage(
      "Background compaction request",
      { model: "anthropic:claude-sonnet-4-5", agentId: "compact" },
      { synthetic: true }
    );
    session.sendQueuedMessages();

    expect(sendMessage).toHaveBeenCalledTimes(1);
    const [text, options, internal] = sendMessage.mock.calls[0] ?? [];
    expect(text).toBe("Background compaction request");
    expect(options).toMatchObject({ model: "anthropic:claude-sonnet-4-5", agentId: "compact" });
    // Queue dispatch stamps enqueuedAtMs alongside preserved internal flags
    // (goal safety uses it to detect messages that predate a fresh goal).
    expect(internal?.synthetic).toBe(true);
    expect(typeof internal?.enqueuedAtMs).toBe("number");
  });
});

describe("AgentSession awaitable disposal", () => {
  test.each([false, true])(
    "joins stop, background cleanup and original leases; terminal subscriber throws=%s",
    async (throwSubscriber) => {
      const stopped = Promise.withResolvers<void>();
      const background = Promise.withResolvers<void>();
      const workspaceId = "disposal-fence";
      const streamManager = {
        ...createStreamLifecycleMocks(),
        getStreamInfo: () => ({
          messageId: "old",
          model: "openai:gpt-4o",
          historySequence: 1,
          startTime: 0,
          parts: [],
          currentStepStartIndex: 0,
          stepStartIndices: [],
          toolCompletionTimestamps: new Map<string, number>(),
        }),
        stopStream: mock(async () => {
          await stopped.promise;
          h.aiEmitter.emit("stream-abort", {
            type: "stream-abort",
            workspaceId,
            messageId: "old",
            abortReason: "system",
            abandonPartial: true,
          });
          return Ok(undefined);
        }),
      };
      const h = await createAgentSessionHarness({
        workspaceId,
        streamManager,
        captureEvents: true,
        backgroundProcessManagerOverrides: { cleanup: mock(() => background.promise) },
      });
      const { coordinator } = h.session as unknown as { coordinator: TurnCoordinator };
      const originalLease = coordinator.enterExecution();
      let finished = false;
      if (throwSubscriber)
        h.session.onChatEvent(({ message }) => {
          if (message.type === "stream-abort") throw new Error("terminal subscriber failed");
        });
      const disposed = h.session.dispose();
      const observedDisposal = disposed.then(() => {
        finished = true;
      });
      try {
        expect(h.session.dispose()).toBe(disposed);
        expect(coordinator.disposed).toBe(true);
        expect(h.aiEmitter.listenerCount("stream-abort")).toBeGreaterThan(0);
        stopped.resolve();
        await stopped.promise;
        // The original stop is a separate join from background cleanup and preparation callbacks.
        expect(finished).toBe(false);
        background.resolve();
        await background.promise;
        expect(finished).toBe(false);
        originalLease[Symbol.dispose]();
        await observedDisposal;
        expect(h.events.filter((event) => event.type === "stream-abort")).toHaveLength(1);
        expect(h.aiEmitter.listenerCount("stream-abort")).toBe(0);
        expect(h.initStateManager.listenerCount("init-start")).toBe(0);
        expect(streamManager.stopStream).toHaveBeenCalledTimes(1);
      } finally {
        stopped.resolve();
        background.resolve();
        originalLease[Symbol.dispose]();
        await disposed;
        await h.cleanup();
      }
    }
  );

  test("leased callback can initiate disposal before releasing itself", async () => {
    const h = await createAgentSessionHarness({ workspaceId: "callback-disposal" });
    const { coordinator } = h.session as unknown as { coordinator: TurnCoordinator };
    const callbackReturned = Promise.withResolvers<void>();
    const callback = (async () => {
      using _lease = coordinator.enterExecution();
      h.session.beginDispose();
      await callbackReturned.promise;
    })();
    try {
      expect(coordinator.disposed).toBe(true);
      callbackReturned.resolve();
      await callback;
      await h.session.dispose();
    } finally {
      callbackReturned.resolve();
      await h.session.dispose();
      await h.cleanup();
    }
  });
});

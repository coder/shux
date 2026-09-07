import type { TurnCoordinator } from "./turnCoordinator";
import { describe, expect, it, mock, afterEach } from "bun:test";
import { EventEmitter } from "events";
import { PROVIDER_DISPLAY_NAMES } from "@/common/constants/providers";
import type { AIService, StreamMessageOptions } from "@/node/services/aiService";
import type { BackgroundProcessManager } from "@/node/services/backgroundProcessManager";
import type { InitStateManager } from "@/node/services/initStateManager";
import type { SendMessageError } from "@/common/types/errors";
import { createMuxMessage, type MuxMessage } from "@/common/types/message";
import type { Result } from "@/common/types/result";
import { Err, Ok } from "@/common/types/result";
import { computePriorHistoryFingerprint } from "@/common/orpc/onChatCursorFingerprint";
import {
  isMuxMessage,
  type StreamErrorMessage,
  type WorkspaceChatMessage,
} from "@/common/orpc/types";
import { AgentSession } from "./agentSession";
import { createAgentSessionHarness } from "./agentSession.testHarness";
import { createTestHistoryService } from "./testHistoryService";

interface ReplayHarnessStreamInfo {
  messageId: string;
  startTime: number;
  parts: Array<{ type: "text"; text: string; timestamp?: number }>;
  toolCompletionTimestamps: Map<string, number>;
}

async function createReplaySessionHarness(
  workspaceId: string,
  options?: { streamInfo?: ReplayHarnessStreamInfo }
) {
  const streamInfo = options?.streamInfo;
  const replayStream = mock((_workspaceId: string, _opts?: { afterTimestamp?: number }) =>
    Promise.resolve()
  );
  const replayInit = mock((_workspaceId: string) => Promise.resolve());
  const harness = await createAgentSessionHarness({
    workspaceId,
    aiServiceOverrides: {
      streamMessage: mock((_history: MuxMessage[]) =>
        Promise.resolve(Err({ type: "unknown", raw: "unused" }))
      ) as unknown as AIService["streamMessage"],
      getStreamInfo: mock((_workspaceId: string) => streamInfo),
      replayStream,
    },
    initStateManagerOverrides: { replayInit },
  });

  return { ...harness, replayInit, replayStream };
}
describe("AgentSession pre-stream errors", () => {
  let historyCleanup: (() => Promise<void>) | undefined;
  afterEach(async () => {
    await historyCleanup?.();
  });

  it("emits stream-error when stream startup fails", async () => {
    const workspaceId = "ws-test";

    const streamMessage = mock((_history: MuxMessage[]) => {
      return Promise.resolve(
        Err({
          type: "api_key_not_found",
          provider: "anthropic",
        })
      );
    });
    const { session, cleanup, events } = await createAgentSessionHarness({
      workspaceId,
      aiServiceOverrides: {
        streamMessage: streamMessage as unknown as AIService["streamMessage"],
      },
      captureEvents: true,
    });
    historyCleanup = cleanup;

    const result = await session.sendMessage("hello", {
      model: "anthropic:claude-3-5-sonnet-latest",
      agentId: "exec",
    });

    expect(result.success).toBe(false);
    expect(streamMessage.mock.calls).toHaveLength(1);

    const streamError = events.find(
      (event): event is StreamErrorMessage => event.type === "stream-error"
    );

    expect(streamError).toBeDefined();
    expect(streamError?.errorType).toBe("authentication");
    expect(streamError?.error).toContain(PROVIDER_DISPLAY_NAMES.anthropic);
    expect(streamError?.messageId).toMatch(/^assistant-/);
  });

  it("notifies accepted background sends when stream startup rejects", async () => {
    const workspaceId = "ws-background-startup-rejected";
    const { session, cleanup } = await createAgentSessionHarness({ workspaceId });
    historyCleanup = cleanup;
    const privateSession = session as unknown as {
      streamWithHistory: () => Promise<Result<void, SendMessageError>>;
    };
    privateSession.streamWithHistory = () => Promise.reject(new Error("startup rejected"));
    const sendQueuedMessages = mock(() => undefined);
    session.sendQueuedMessages = sendQueuedMessages;

    const failure = new Promise<SendMessageError>((resolve) => {
      void session.sendMessage(
        "background",
        { model: "anthropic:claude-3-5-sonnet-latest", agentId: "exec" },
        {
          startStreamInBackground: true,
          onAcceptedPreStreamFailure: resolve,
        }
      );
    });

    session.queueMessage("later correction", {
      model: "anthropic:claude-3-5-sonnet-latest",
      agentId: "exec",
    });

    expect(await failure).toEqual({ type: "unknown", raw: "startup rejected" });
    await session.waitForIdle();
    // The failure callback resolves before the rejection handler continues to drain the queue.
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(sendQueuedMessages).toHaveBeenCalledTimes(1);
  });

  it("notifies accepted background sends when startup is aborted during preparation", async () => {
    const workspaceId = "ws-background-startup-aborted-during-preparation";
    const { session, cleanup } = await createAgentSessionHarness({ workspaceId });
    historyCleanup = cleanup;
    let finishStartup: (() => void) | undefined;
    const privateSession = session as unknown as {
      streamWithHistory: () => Promise<Result<void, SendMessageError>>;
      coordinator: TurnCoordinator;
    };
    privateSession.streamWithHistory = async () => {
      await new Promise<void>((resolve) => {
        finishStartup = resolve;
      });
      return Ok(undefined);
    };

    const failure = new Promise<SendMessageError>((resolve) => {
      void session.sendMessage(
        "background",
        { model: "anthropic:claude-3-5-sonnet-latest", agentId: "exec" },
        {
          startStreamInBackground: true,
          onAcceptedPreStreamFailure: resolve,
        }
      );
    });

    while (finishStartup == null) {
      await new Promise((resolve) => setTimeout(resolve, 0));
    }
    expect(privateSession.coordinator.preemptPreparation()).toBe(true);
    finishStartup();

    expect(await failure).toEqual({
      type: "unknown",
      raw: "Accepted stream startup was canceled during preparation.",
    });
    await session.waitForIdle();
  });

  it("acknowledges edited sends immediately and surfaces later startup failure via stream-error", async () => {
    const workspaceId = "ws-edit-startup-failed";

    const streamMessage = mock((_history: MuxMessage[]) => {
      return Promise.resolve(
        Err({
          type: "api_key_not_found",
          provider: "anthropic",
        })
      );
    });
    const { session, historyService, cleanup, events } = await createAgentSessionHarness({
      workspaceId,
      aiServiceOverrides: {
        streamMessage: streamMessage as unknown as AIService["streamMessage"],
      },
      captureEvents: true,
    });
    historyCleanup = cleanup;

    const originalMessageId = "editable-user-message";
    await historyService.appendToHistory(
      workspaceId,
      createMuxMessage(originalMessageId, "user", "original", { historySequence: 0 })
    );

    const result = await session.sendMessage("edited", {
      model: "anthropic:claude-3-5-sonnet-latest",
      agentId: "exec",
      editMessageId: originalMessageId,
    });

    expect(result.success).toBe(true);

    await session.waitForIdle();
    expect(streamMessage.mock.calls).toHaveLength(1);

    const streamError = events.find(
      (event): event is StreamErrorMessage => event.type === "stream-error"
    );

    expect(streamError).toBeDefined();
    expect(streamError?.errorType).toBe("authentication");
    expect(streamError?.error).toContain(PROVIDER_DISPLAY_NAMES.anthropic);
  });

  async function replayTerminalAuthFailure(
    workspaceId: string,
    mode?: { type: "live" }
  ): Promise<{
    replayedEvents: WorkspaceChatMessage[];
    replayInit: ReturnType<typeof mock<(workspaceId: string) => Promise<void>>>;
  }> {
    const replayInit = mock((_workspaceId: string) => Promise.resolve());
    const { session, cleanup } = await createAgentSessionHarness({
      workspaceId,
      aiServiceOverrides: {
        streamMessage: mock((_history: MuxMessage[]) =>
          Promise.resolve(Err({ type: "api_key_not_found", provider: "anthropic" }))
        ) as unknown as AIService["streamMessage"],
        getStreamInfo: mock((_workspaceId: string) => undefined),
        replayStream: mock((_workspaceId: string, _opts?: { afterTimestamp?: number }) =>
          Promise.resolve()
        ),
      },
      initStateManagerOverrides: { replayInit },
    });
    historyCleanup = cleanup;

    const sendResult = await session.sendMessage("hello", {
      model: "anthropic:claude-3-5-sonnet-latest",
      agentId: "exec",
    });
    expect(sendResult.success).toBe(false);

    const replayedEvents: WorkspaceChatMessage[] = [];
    await session.replayHistory(({ message }) => replayedEvents.push(message), mode);
    return { replayedEvents, replayInit };
  }

  it("replays terminal stream-error state before caught-up after a pre-stream failure", async () => {
    const workspaceId = "ws-replay-terminal-stream-error";
    const { replayedEvents, replayInit } = await replayTerminalAuthFailure(workspaceId);

    const replayedStreamErrorIndex = replayedEvents.findIndex(
      (event) => event.type === "stream-error"
    );
    const replayedLifecycleIndex = replayedEvents.findIndex(
      (event) => event.type === "stream-lifecycle"
    );
    const caughtUpIndex = replayedEvents.findIndex((event) => event.type === "caught-up");
    const replayedStreamError = replayedEvents.find(
      (event): event is StreamErrorMessage => event.type === "stream-error"
    );
    const replayedLifecycle = replayedEvents.find(
      (event): event is Extract<WorkspaceChatMessage, { type: "stream-lifecycle" }> =>
        event.type === "stream-lifecycle"
    );

    expect(replayedStreamError?.errorType).toBe("authentication");
    expect(replayedStreamError?.replay).toBe(true);
    expect(replayedLifecycle?.phase).toBe("failed");
    expect(replayedStreamErrorIndex).toBeGreaterThanOrEqual(0);
    expect(replayedLifecycleIndex).toBeGreaterThan(replayedStreamErrorIndex);
    expect(caughtUpIndex).toBeGreaterThan(replayedLifecycleIndex);
    expect(replayInit).toHaveBeenCalledWith(workspaceId);
  });

  it("does not replay terminal failure state in live mode", async () => {
    const workspaceId = "ws-live-replay-ignores-terminal-failure";
    const { replayedEvents, replayInit } = await replayTerminalAuthFailure(workspaceId, {
      type: "live",
    });

    expect(replayedEvents.some((event) => event.type === "stream-error")).toBe(false);
    expect(replayedEvents.some((event) => event.type === "stream-lifecycle")).toBe(false);
    expect(replayInit).toHaveBeenCalledWith(workspaceId);
  });

  it("replays preparing runtime-status before caught-up so reconnects keep startup details", async () => {
    const workspaceId = "ws-replay-runtime-status";
    const { session, cleanup, replayInit, aiEmitter } =
      await createReplaySessionHarness(workspaceId);
    historyCleanup = cleanup;

    const privateSession = session as unknown as {
      coordinator: TurnCoordinator;
    };

    privateSession.coordinator.prepare({
      kind: "fresh",
      intent: "handoff",
      expectedTurnId: privateSession.coordinator.turnId,
    });
    aiEmitter.emit("runtime-status", {
      type: "runtime-status",
      workspaceId,
      phase: "starting",
      runtimeType: "ssh",
      source: "runtime",
      detail: "Checking workspace runtime...",
    });

    const replayedEvents: WorkspaceChatMessage[] = [];
    await session.replayHistory(({ message }) => replayedEvents.push(message));

    const replayedLifecycleIndex = replayedEvents.findIndex(
      (event) => event.type === "stream-lifecycle"
    );
    const replayedRuntimeStatusIndex = replayedEvents.findIndex(
      (event) => event.type === "runtime-status"
    );
    const caughtUpIndex = replayedEvents.findIndex((event) => event.type === "caught-up");
    const replayedRuntimeStatus = replayedEvents.find(
      (event): event is Extract<WorkspaceChatMessage, { type: "runtime-status" }> =>
        event.type === "runtime-status"
    );

    expect(replayedRuntimeStatus).toEqual({
      type: "runtime-status",
      workspaceId,
      phase: "starting",
      runtimeType: "ssh",
      source: "runtime",
      detail: "Checking workspace runtime...",
    });
    expect(replayedLifecycleIndex).toBeGreaterThanOrEqual(0);
    expect(replayedRuntimeStatusIndex).toBeGreaterThan(replayedLifecycleIndex);
    expect(caughtUpIndex).toBeGreaterThan(replayedRuntimeStatusIndex);
    expect(replayInit).toHaveBeenCalledWith(workspaceId);
  });

  it("schedules auto-retry when runtime startup fails before stream events", async () => {
    const workspaceId = "ws-runtime-start-failed";

    const streamMessage = mock((_history: MuxMessage[]) => {
      return Promise.resolve(
        Err({
          type: "runtime_start_failed",
          message: "Runtime is starting",
        })
      );
    });
    const { session, cleanup, events } = await createAgentSessionHarness({
      workspaceId,
      aiServiceOverrides: {
        streamMessage: streamMessage as unknown as AIService["streamMessage"],
      },
      captureEvents: true,
    });
    historyCleanup = cleanup;

    const result = await session.sendMessage("hello", {
      model: "anthropic:claude-3-5-sonnet-latest",
      agentId: "exec",
    });

    expect(result.success).toBe(false);

    const scheduledRetry = events.find(
      (event): event is Extract<WorkspaceChatMessage, { type: "auto-retry-scheduled" }> =>
        event.type === "auto-retry-scheduled"
    );
    expect(scheduledRetry).toBeDefined();
    expect(events.some((event) => event.type === "stream-error")).toBe(false);
  });

  it("honors persisted auto-retry opt-out for synthetic startup-time failures", async () => {
    const workspaceId = "ws-runtime-start-failed-persisted-opt-out";

    const { historyService, config, cleanup } = await createTestHistoryService();
    historyCleanup = cleanup;

    const aiEmitter = new EventEmitter();
    const streamMessage = mock((_history: MuxMessage[]) => {
      return Promise.resolve(
        Err({
          type: "runtime_start_failed",
          message: "Runtime is starting",
        })
      );
    });
    const aiService = Object.assign(aiEmitter, {
      isStreaming: mock((_workspaceId: string) => false),
      stopStream: mock((_workspaceId: string) => Promise.resolve(Ok(undefined))),
      getStreamInfo: mock((_workspaceId: string) => undefined),
      replayStream: mock((_workspaceId: string) => Promise.resolve()),
      streamMessage: streamMessage as unknown as (
        ...args: Parameters<AIService["streamMessage"]>
      ) => Promise<Result<void, SendMessageError>>,
    }) as unknown as AIService;

    const initStateManager = new EventEmitter() as unknown as InitStateManager;

    const backgroundProcessManager = {
      cleanup: mock((_workspaceId: string) => Promise.resolve()),
      setMessageQueued: mock((_workspaceId: string, _queued: boolean) => {
        void _queued;
      }),
    } as unknown as BackgroundProcessManager;

    const sessionWithPersistedPreference = new AgentSession({
      workspaceId,
      config,
      historyService,
      aiService,
      initStateManager,
      backgroundProcessManager,
    });
    await sessionWithPersistedPreference.setAutoRetryEnabled(false);
    sessionWithPersistedPreference.dispose();

    const session = new AgentSession({
      workspaceId,
      config,
      historyService,
      aiService,
      initStateManager,
      backgroundProcessManager,
    });

    const events: WorkspaceChatMessage[] = [];
    session.onChatEvent((event) => {
      events.push(event.message);
    });

    // Synthetic sends mirror backend-driven startup/compaction paths that can fail
    // before subscribeChat-based startup recovery loads persisted retry preference.
    const result = await session.sendMessage(
      "hello",
      {
        model: "anthropic:claude-3-5-sonnet-latest",
        agentId: "exec",
      },
      { synthetic: true }
    );

    expect(result.success).toBe(false);
    expect(events.some((event) => event.type === "auto-retry-scheduled")).toBe(false);

    session.dispose();
  });

  it("replays init state for since-mode reconnects", async () => {
    const workspaceId = "ws-replay-init-since";
    const { session, cleanup, replayInit } = await createReplaySessionHarness(workspaceId);
    historyCleanup = cleanup;

    const events: WorkspaceChatMessage[] = [];
    await session.replayHistory(
      ({ message }) => {
        events.push(message);
      },
      {
        type: "since",
        cursor: {
          history: {
            messageId: "missing-message",
            historySequence: 123,
            oldestHistorySequence: 123,
          },
        },
      }
    );

    expect(replayInit).toHaveBeenCalledWith(workspaceId);
    expect(events.some((event) => "type" in event && event.type === "caught-up")).toBe(true);
  });

  it("keeps since replay when stream cursor is stale but history cursor is valid", async () => {
    const workspaceId = "ws-replay-since-stale-stream-cursor";
    const { session, cleanup, replayInit, historyService } =
      await createReplaySessionHarness(workspaceId);
    historyCleanup = cleanup;

    const firstMessage = createMuxMessage("msg-history-1", "user", "first");
    const secondMessage = createMuxMessage("msg-history-2", "assistant", "second");

    const appendFirst = await historyService.appendToHistory(workspaceId, firstMessage);
    expect(appendFirst.success).toBe(true);
    const appendSecond = await historyService.appendToHistory(workspaceId, secondMessage);
    expect(appendSecond.success).toBe(true);

    const historyResult = await historyService.getHistoryFromLatestBoundary(workspaceId);
    if (!historyResult.success) {
      throw new Error(`Failed to read history: ${historyResult.error}`);
    }

    const firstPersisted = historyResult.data.find((message) => message.id === firstMessage.id);
    const secondPersisted = historyResult.data.find((message) => message.id === secondMessage.id);
    if (!firstPersisted || !secondPersisted) {
      throw new Error("Expected persisted history messages for since replay test");
    }

    const firstHistorySequence = firstPersisted.metadata?.historySequence;
    if (firstHistorySequence === undefined) {
      throw new Error("Expected first persisted message to have historySequence");
    }

    const historySequences = historyResult.data
      .map((message) => message.metadata?.historySequence)
      .filter((historySequence): historySequence is number => historySequence !== undefined);
    if (historySequences.length === 0) {
      throw new Error("Expected persisted history sequences for since replay test");
    }
    const oldestHistorySequence = Math.min(...historySequences);

    const events: WorkspaceChatMessage[] = [];
    await session.replayHistory(
      ({ message }) => {
        events.push(message);
      },
      {
        type: "since",
        cursor: {
          history: {
            messageId: firstPersisted.id,
            historySequence: firstHistorySequence,
            oldestHistorySequence,
          },
          stream: {
            messageId: "ended-stream",
            lastTimestamp: 9_999,
          },
        },
      }
    );

    expect(replayInit).toHaveBeenCalledWith(workspaceId);

    const caughtUp = events.find(
      (event): event is Extract<WorkspaceChatMessage, { type: "caught-up" }> =>
        "type" in event && event.type === "caught-up"
    );
    expect(caughtUp).toBeDefined();
    expect(caughtUp?.replay).toBe("since");
    expect(caughtUp?.downgradeReason).toBeUndefined();

    const replayedMessageIds = events.reduce<string[]>((ids, event) => {
      if (
        "role" in event &&
        (event.role === "user" || event.role === "assistant") &&
        "id" in event &&
        typeof event.id === "string"
      ) {
        ids.push(event.id);
      }
      return ids;
    }, []);

    expect(replayedMessageIds).toEqual([firstPersisted.id, secondPersisted.id]);
  });

  it("clamps since stream cursor timestamp to current server stream timeline", async () => {
    const workspaceId = "ws-replay-since-clamp-stream-cursor";
    const { session, cleanup, replayStream, historyService } = await createReplaySessionHarness(
      workspaceId,
      {
        streamInfo: {
          messageId: "msg-live-clamp",
          startTime: 1_000,
          parts: [{ type: "text", text: "partial", timestamp: 100 }],
          toolCompletionTimestamps: new Map(),
        },
      }
    );
    historyCleanup = cleanup;

    const seedMessage = createMuxMessage("msg-history-seed", "assistant", "seed");
    expect((await historyService.appendToHistory(workspaceId, seedMessage)).success).toBe(true);

    const historyResult = await historyService.getHistoryFromLatestBoundary(workspaceId);
    if (!historyResult.success) {
      throw new Error(`Failed to read seeded history: ${historyResult.error}`);
    }

    const persistedSeed = historyResult.data.find((message) => message.id === seedMessage.id);
    if (!persistedSeed) {
      throw new Error("Expected seeded history message");
    }

    const seedHistorySequence = persistedSeed.metadata?.historySequence;
    if (seedHistorySequence === undefined) {
      throw new Error("Expected seeded history message to include historySequence");
    }

    const events: WorkspaceChatMessage[] = [];
    await session.replayHistory(
      ({ message }) => {
        events.push(message);
      },
      {
        type: "since",
        cursor: {
          history: {
            messageId: persistedSeed.id,
            historySequence: seedHistorySequence,
            oldestHistorySequence: seedHistorySequence,
          },
          stream: {
            messageId: "msg-live-clamp",
            lastTimestamp: 9_999,
          },
        },
      }
    );

    expect(replayStream).toHaveBeenCalledWith(workspaceId, { afterTimestamp: 100 });

    const caughtUp = events.find(
      (event): event is Extract<WorkspaceChatMessage, { type: "caught-up" }> =>
        "type" in event && event.type === "caught-up"
    );
    expect(caughtUp?.replay).toBe("since");
  });

  it("falls back to full replay when history below since cursor changed", async () => {
    const workspaceId = "ws-replay-since-history-changed-below-cursor";
    const { session, cleanup, historyService } = await createReplaySessionHarness(workspaceId);
    historyCleanup = cleanup;

    const firstMessage = createMuxMessage("msg-history-a", "user", "first");
    const secondMessage = createMuxMessage("msg-history-b", "assistant", "second");
    const thirdMessage = createMuxMessage("msg-history-c", "assistant", "third");

    expect((await historyService.appendToHistory(workspaceId, firstMessage)).success).toBe(true);
    expect((await historyService.appendToHistory(workspaceId, secondMessage)).success).toBe(true);
    expect((await historyService.appendToHistory(workspaceId, thirdMessage)).success).toBe(true);

    const beforeDeleteHistory = await historyService.getHistoryFromLatestBoundary(workspaceId);
    if (!beforeDeleteHistory.success) {
      throw new Error(`Failed to read seeded history: ${beforeDeleteHistory.error}`);
    }

    const persistedFirst = beforeDeleteHistory.data.find(
      (message) => message.id === firstMessage.id
    );
    const persistedSecond = beforeDeleteHistory.data.find(
      (message) => message.id === secondMessage.id
    );
    const persistedThird = beforeDeleteHistory.data.find(
      (message) => message.id === thirdMessage.id
    );
    if (!persistedFirst || !persistedSecond || !persistedThird) {
      throw new Error("Expected all seeded history rows to persist");
    }

    const thirdHistorySequence = persistedThird.metadata?.historySequence;
    if (thirdHistorySequence === undefined) {
      throw new Error("Expected cursor-boundary message to have historySequence");
    }

    const oldestHistorySequence = Math.min(
      ...beforeDeleteHistory.data
        .map((message) => message.metadata?.historySequence)
        .filter((historySequence): historySequence is number => historySequence !== undefined)
    );
    const priorHistoryFingerprint = computePriorHistoryFingerprint(
      beforeDeleteHistory.data,
      thirdHistorySequence
    );
    if (priorHistoryFingerprint === undefined) {
      throw new Error("Expected priorHistoryFingerprint for rows below cursor");
    }

    expect((await historyService.deleteMessage(workspaceId, persistedSecond.id)).success).toBe(
      true
    );

    const events: WorkspaceChatMessage[] = [];
    await session.replayHistory(
      ({ message }) => {
        events.push(message);
      },
      {
        type: "since",
        cursor: {
          history: {
            messageId: persistedThird.id,
            historySequence: thirdHistorySequence,
            oldestHistorySequence,
            priorHistoryFingerprint,
          },
          stream: {
            messageId: "ended-stream",
            lastTimestamp: 9_999,
          },
        },
      }
    );

    const caughtUp = events.find(
      (event): event is Extract<WorkspaceChatMessage, { type: "caught-up" }> =>
        "type" in event && event.type === "caught-up"
    );
    expect(caughtUp).toBeDefined();
    expect(caughtUp?.replay).toBe("full");
    expect(caughtUp?.downgradeReason).toBe("fingerprint-mismatch");

    const replayedMessageIds = events.filter(isMuxMessage).map((message) => message.id);
    expect(replayedMessageIds).toContain(persistedFirst.id);
    expect(replayedMessageIds).toContain(persistedThird.id);
    expect(replayedMessageIds).not.toContain(persistedSecond.id);
  });

  it("classifies cursor-row-missing downgrades on since replay", async () => {
    const workspaceId = "ws-replay-downgrade-cursor-row-missing";
    const { session, cleanup, historyService } = await createReplaySessionHarness(workspaceId);
    historyCleanup = cleanup;

    const seedMessage = createMuxMessage("msg-history-seed", "assistant", "seed");
    expect((await historyService.appendToHistory(workspaceId, seedMessage)).success).toBe(true);

    const events: WorkspaceChatMessage[] = [];
    await session.replayHistory(
      ({ message }) => {
        events.push(message);
      },
      {
        type: "since",
        cursor: {
          history: {
            messageId: "missing-message",
            historySequence: 123,
            oldestHistorySequence: 123,
          },
        },
      }
    );

    const caughtUp = events.find(
      (event): event is Extract<WorkspaceChatMessage, { type: "caught-up" }> =>
        "type" in event && event.type === "caught-up"
    );
    expect(caughtUp?.replay).toBe("full");
    expect(caughtUp?.downgradeReason).toBe("cursor-row-missing");
  });

  it("classifies oldest-mismatch downgrades on since replay", async () => {
    const workspaceId = "ws-replay-downgrade-oldest-mismatch";
    const { session, cleanup, historyService } = await createReplaySessionHarness(workspaceId);
    historyCleanup = cleanup;

    const seedMessage = createMuxMessage("msg-history-seed", "assistant", "seed");
    expect((await historyService.appendToHistory(workspaceId, seedMessage)).success).toBe(true);

    const historyResult = await historyService.getHistoryFromLatestBoundary(workspaceId);
    if (!historyResult.success) {
      throw new Error(`Failed to read seeded history: ${historyResult.error}`);
    }
    const persistedSeed = historyResult.data.find((message) => message.id === seedMessage.id);
    const seedHistorySequence = persistedSeed?.metadata?.historySequence;
    if (!persistedSeed || seedHistorySequence === undefined) {
      throw new Error("Expected seeded history message with historySequence");
    }

    const events: WorkspaceChatMessage[] = [];
    await session.replayHistory(
      ({ message }) => {
        events.push(message);
      },
      {
        type: "since",
        cursor: {
          history: {
            messageId: persistedSeed.id,
            historySequence: seedHistorySequence,
            // Claim an older replay window than the server currently has, as if rows
            // below the cursor were truncated while the client was disconnected.
            oldestHistorySequence: seedHistorySequence - 1,
          },
        },
      }
    );

    const caughtUp = events.find(
      (event): event is Extract<WorkspaceChatMessage, { type: "caught-up" }> =>
        "type" in event && event.type === "caught-up"
    );
    expect(caughtUp?.replay).toBe("full");
    expect(caughtUp?.downgradeReason).toBe("oldest-mismatch");
  });

  it("keeps since replay mode when failure occurs after incremental payload is emitted", async () => {
    const workspaceId = "ws-replay-since-error-downgrade";
    const { session, cleanup, historyService, replayStream } = await createReplaySessionHarness(
      workspaceId,
      {
        streamInfo: {
          messageId: "msg-live-replay",
          startTime: 9_000,
          parts: [],
          toolCompletionTimestamps: new Map(),
        },
      }
    );
    historyCleanup = cleanup;

    const seededMessage = createMuxMessage("msg-history-d", "assistant", "seed");
    expect((await historyService.appendToHistory(workspaceId, seededMessage)).success).toBe(true);

    const historyResult = await historyService.getHistoryFromLatestBoundary(workspaceId);
    if (!historyResult.success) {
      throw new Error(`Failed to read seeded history: ${historyResult.error}`);
    }

    const persistedSeeded = historyResult.data.find((message) => message.id === seededMessage.id);
    if (!persistedSeeded) {
      throw new Error("Expected seeded message to persist");
    }

    const seededHistorySequence = persistedSeeded.metadata?.historySequence;
    if (seededHistorySequence === undefined) {
      throw new Error("Expected seeded message to have historySequence");
    }

    replayStream.mockImplementationOnce(() => Promise.reject(new Error("replay stream failed")));

    const events: WorkspaceChatMessage[] = [];
    await session.replayHistory(
      ({ message }) => {
        events.push(message);
      },
      {
        type: "since",
        cursor: {
          history: {
            messageId: persistedSeeded.id,
            historySequence: seededHistorySequence,
            oldestHistorySequence: seededHistorySequence,
          },
        },
      }
    );

    const caughtUp = events.find(
      (event): event is Extract<WorkspaceChatMessage, { type: "caught-up" }> =>
        "type" in event && event.type === "caught-up"
    );
    expect(caughtUp).toBeDefined();
    expect(caughtUp?.replay).toBe("since");
    expect(caughtUp?.cursor).toBeUndefined();
  });

  it("keeps incremental replay mode when replay stream events were already emitted", async () => {
    const workspaceId = "ws-replay-since-error-after-stream-events";
    const { session, cleanup, historyService, replayStream, aiEmitter } =
      await createReplaySessionHarness(workspaceId, {
        streamInfo: {
          messageId: "msg-live-stream-events",
          startTime: 8_500,
          parts: [],
          toolCompletionTimestamps: new Map(),
        },
      });
    historyCleanup = cleanup;

    const placeholder = createMuxMessage("msg-history-stream-events", "assistant", "placeholder");
    expect((await historyService.appendToHistory(workspaceId, placeholder)).success).toBe(true);

    const historyResult = await historyService.getHistoryFromLatestBoundary(workspaceId);
    if (!historyResult.success) {
      throw new Error(`Failed to read seeded history: ${historyResult.error}`);
    }

    const persistedPlaceholder = historyResult.data.find(
      (message) => message.id === placeholder.id
    );
    if (!persistedPlaceholder) {
      throw new Error("Expected placeholder history row");
    }

    const placeholderHistorySequence = persistedPlaceholder.metadata?.historySequence;
    if (placeholderHistorySequence === undefined) {
      throw new Error("Expected placeholder row to include historySequence");
    }

    const partial = createMuxMessage("msg-partial-stream-events", "assistant", "partial", {
      historySequence: placeholderHistorySequence,
    });
    expect((await historyService.writePartial(workspaceId, partial)).success).toBe(true);

    replayStream.mockImplementationOnce(() => {
      aiEmitter.emit("stream-start", {
        type: "stream-start",
        workspaceId,
        messageId: "msg-live-stream-events",
        replay: true,
        model: "claude-3-5-sonnet-20241022",
        historySequence: placeholderHistorySequence,
        startTime: 8_500,
      });
      return Promise.reject(new Error("replay stream failed after events"));
    });

    const events: WorkspaceChatMessage[] = [];
    await session.replayHistory(
      ({ message }) => {
        events.push(message);
      },
      {
        type: "since",
        cursor: {
          history: {
            messageId: persistedPlaceholder.id,
            historySequence: placeholderHistorySequence,
            oldestHistorySequence: placeholderHistorySequence,
          },
        },
      }
    );

    const caughtUp = events.find(
      (event): event is Extract<WorkspaceChatMessage, { type: "caught-up" }> =>
        "type" in event && event.type === "caught-up"
    );
    expect(caughtUp).toBeDefined();
    expect(caughtUp?.replay).toBe("since");
    expect(caughtUp?.cursor).toBeUndefined();
  });

  it("reports full replay when since replay fails before emitting incremental payload", async () => {
    const workspaceId = "ws-replay-since-error-before-payload";
    const { session, cleanup, historyService, replayStream } = await createReplaySessionHarness(
      workspaceId,
      {
        streamInfo: {
          messageId: "msg-live-prepayload",
          startTime: 8_000,
          parts: [],
          toolCompletionTimestamps: new Map(),
        },
      }
    );
    historyCleanup = cleanup;

    const placeholder = createMuxMessage("msg-history-placeholder", "assistant", "placeholder");
    expect((await historyService.appendToHistory(workspaceId, placeholder)).success).toBe(true);

    const historyResult = await historyService.getHistoryFromLatestBoundary(workspaceId);
    if (!historyResult.success) {
      throw new Error(`Failed to read seeded history: ${historyResult.error}`);
    }

    const persistedPlaceholder = historyResult.data.find(
      (message) => message.id === placeholder.id
    );
    if (!persistedPlaceholder) {
      throw new Error("Expected placeholder history row");
    }

    const placeholderHistorySequence = persistedPlaceholder.metadata?.historySequence;
    if (placeholderHistorySequence === undefined) {
      throw new Error("Expected placeholder row to include historySequence");
    }

    const partial = createMuxMessage("msg-partial-prepayload", "assistant", "partial", {
      historySequence: placeholderHistorySequence,
    });
    expect((await historyService.writePartial(workspaceId, partial)).success).toBe(true);

    replayStream.mockImplementationOnce(() => Promise.reject(new Error("replay stream failed")));

    const events: WorkspaceChatMessage[] = [];
    await session.replayHistory(
      ({ message }) => {
        events.push(message);
      },
      {
        type: "since",
        cursor: {
          history: {
            messageId: persistedPlaceholder.id,
            historySequence: placeholderHistorySequence,
            oldestHistorySequence: placeholderHistorySequence,
          },
        },
      }
    );

    const caughtUp = events.find(
      (event): event is Extract<WorkspaceChatMessage, { type: "caught-up" }> =>
        "type" in event && event.type === "caught-up"
    );
    expect(caughtUp).toBeDefined();
    expect(caughtUp?.replay).toBe("full");
    expect(caughtUp?.cursor).toBeUndefined();
  });

  it("replays cursor-boundary message when stream completed while offline", async () => {
    const workspaceId = "ws-replay-since-boundary-message";
    const { session, cleanup, replayInit, historyService } =
      await createReplaySessionHarness(workspaceId);
    historyCleanup = cleanup;

    const inFlightPlaceholder = createMuxMessage("msg-stream-1", "assistant", "partial");
    const appendPlaceholder = await historyService.appendToHistory(
      workspaceId,
      inFlightPlaceholder
    );
    expect(appendPlaceholder.success).toBe(true);

    const beforeUpdateHistory = await historyService.getHistoryFromLatestBoundary(workspaceId);
    if (!beforeUpdateHistory.success) {
      throw new Error(`Failed to read history before update: ${beforeUpdateHistory.error}`);
    }

    const persistedPlaceholder = beforeUpdateHistory.data.find(
      (message) => message.id === inFlightPlaceholder.id
    );
    if (!persistedPlaceholder) {
      throw new Error("Expected persisted placeholder message before update");
    }

    const placeholderHistorySequence = persistedPlaceholder.metadata?.historySequence;
    if (placeholderHistorySequence === undefined) {
      throw new Error("Expected persisted placeholder to have historySequence");
    }

    const finalizedMessage = createMuxMessage("msg-stream-1", "assistant", "finalized", {
      historySequence: placeholderHistorySequence,
    });
    const updateResult = await historyService.updateHistory(workspaceId, finalizedMessage);
    expect(updateResult.success).toBe(true);

    const events: WorkspaceChatMessage[] = [];
    await session.replayHistory(
      ({ message }) => {
        events.push(message);
      },
      {
        type: "since",
        cursor: {
          history: {
            messageId: persistedPlaceholder.id,
            historySequence: placeholderHistorySequence,
            oldestHistorySequence: placeholderHistorySequence,
          },
          stream: {
            messageId: "ended-stream",
            lastTimestamp: 9_999,
          },
        },
      }
    );

    expect(replayInit).toHaveBeenCalledWith(workspaceId);

    const caughtUp = events.find(
      (event): event is Extract<WorkspaceChatMessage, { type: "caught-up" }> =>
        "type" in event && event.type === "caught-up"
    );
    expect(caughtUp).toBeDefined();
    expect(caughtUp?.replay).toBe("since");

    const replayedMessages = events
      .filter(isMuxMessage)
      .filter((event) => event.role === "assistant");
    expect(replayedMessages).toHaveLength(1);
    expect(replayedMessages[0].id).toBe("msg-stream-1");

    const replayedText = replayedMessages[0].parts
      .filter(
        (
          part
        ): part is Extract<(typeof replayedMessages)[number]["parts"][number], { type: "text" }> =>
          part.type === "text"
      )
      .map((part) => part.text)
      .join("");
    expect(replayedText).toContain("finalized");
  });

  it("uses stream start timestamp baseline for live replay when no parts exist", async () => {
    const workspaceId = "ws-replay-live-start-baseline";
    const streamStartTime = 4_321;
    const { session, cleanup, replayStream } = await createReplaySessionHarness(workspaceId, {
      streamInfo: {
        messageId: "live-msg-1",
        startTime: streamStartTime,
        parts: [],
        toolCompletionTimestamps: new Map(),
      },
    });
    historyCleanup = cleanup;

    const events: WorkspaceChatMessage[] = [];
    await session.replayHistory(
      ({ message }) => {
        events.push(message);
      },
      {
        type: "live",
      }
    );

    expect(replayStream).toHaveBeenCalledWith(workspaceId, { afterTimestamp: streamStartTime });
    expect(events.some((event) => "type" in event && event.type === "caught-up")).toBe(true);
  });

  it("replays init state for live-mode reconnects", async () => {
    const workspaceId = "ws-replay-init-live";
    const { session, cleanup, replayInit } = await createReplaySessionHarness(workspaceId);
    historyCleanup = cleanup;

    const events: WorkspaceChatMessage[] = [];
    await session.replayHistory(
      ({ message }) => {
        events.push(message);
      },
      {
        type: "live",
      }
    );

    expect(replayInit).toHaveBeenCalledWith(workspaceId);
    expect(events.some((event) => "type" in event && event.type === "caught-up")).toBe(true);
  });

  it("handles a pre-start error event once and resolves its recovery decision", async () => {
    const workspaceId = "ws-prestart-error-event";
    const preStartMessageId = "assistant-prestart-error";

    // Mirrors AIService's runtime-readiness failure: the error event fires for
    // fire-and-forget senders (and the caller's onPreStartError collector),
    // then streamMessage returns Err with no handle.
    const aiEmitter = new EventEmitter();
    const streamMessage = mock((opts: StreamMessageOptions) => {
      const errorEvent = {
        type: "error" as const,
        workspaceId,
        messageId: preStartMessageId,
        error: "Runtime unavailable.",
        errorType: "runtime_not_ready" as const,
      };
      aiEmitter.emit("error", errorEvent);
      opts.onPreStartError?.(errorEvent);
      return Promise.resolve(Err({ type: "runtime_not_ready", message: "Runtime unavailable." }));
    });

    const harness = await createAgentSessionHarness({
      workspaceId,
      aiEmitter,
      aiServiceOverrides: {
        streamMessage: streamMessage as unknown as AIService["streamMessage"],
      },
      captureEvents: true,
    });
    historyCleanup = harness.cleanup;

    await harness.session.sendMessage("hello", {
      model: "anthropic:claude-3-5-sonnet-latest",
      agentId: "exec",
    });

    // The decision opened at event emission must resolve through the returned
    // failure path; an unresolved decision would hang settlement waiters.
    expect(await harness.session.waitForPendingStreamErrorRecoveryDecision(preStartMessageId)).toBe(
      "terminal"
    );

    const streamErrors = harness.events.filter(
      (event): event is StreamErrorMessage =>
        "type" in event && event.type === "stream-error" && event.messageId === preStartMessageId
    );
    expect(streamErrors).toHaveLength(1);
  });
});

import type { TurnCoordinator } from "./turnCoordinator";
import { afterEach, describe, expect, mock, spyOn, test } from "bun:test";
import { createMuxMessage } from "@/common/types/message";
import type { CompactionFollowUpRequest, MuxMessage } from "@/common/types/message";
import type { FilePart, SendMessageOptions } from "@/common/orpc/types";
import type { Config } from "@/node/config";
import { AgentSession } from "./agentSession";
import { createStreamLifecycleMocks } from "./agentSession.testHarness";
import type { AIService } from "./aiService";
import type { BackgroundProcessManager } from "./backgroundProcessManager";
import type { InitStateManager } from "./initStateManager";
import { createTestHistoryService } from "./testHistoryService";

// NOTE: These tests validate crash-safe compaction follow-up recovery, including
// legacy `mode` fallback, without repeating a full AgentSession fixture per case.

type SendOptions = SendMessageOptions & { fileParts?: FilePart[] };

type SendMessageResult =
  | { success: true }
  | { success: false; error: { type: string; message?: string } };

interface AutoRetryResumeRequest {
  options: SendMessageOptions;
  agentInitiated?: boolean;
}

interface SessionInternals {
  dispatchPendingFollowUp: () => Promise<boolean>;
  sendMessage: (
    message: string,
    options?: SendOptions,
    internal?: { synthetic?: boolean; agentInitiated?: boolean }
  ) => Promise<SendMessageResult>;
  runStartupRecovery: () => Promise<void>;
  lastAutoRetryResumeRequest?: AutoRetryResumeRequest;
  coordinator: TurnCoordinator;
  onPostCompactionStateChange?: () => void;
}

const idleFollowUp = (): CompactionFollowUpRequest => ({
  text: "heartbeat follow-up",
  model: "openai:gpt-4o",
  agentId: "exec",
  dispatchOptions: { requireIdle: true },
});

function compactionSummaryMessage(
  id: string,
  pendingFollowUp: CompactionFollowUpRequest
): MuxMessage {
  return {
    id,
    role: "assistant",
    parts: [{ type: "text", text: "Compaction summary" }],
    metadata: {
      muxMetadata: {
        type: "compaction-summary",
        pendingFollowUp,
      },
    },
  } satisfies MuxMessage;
}

/**
 * RLM keep-recent floor: a durable compaction boundary summary followed by
 * preserved-tail copies. The startup follow-up recovery branch must locate the
 * summary through the epoch read when the last history row is a tail copy.
 */
function rlmSummaryBoundaryMessage(pendingFollowUp: CompactionFollowUpRequest): MuxMessage {
  return createMuxMessage("rlm-summary", "assistant", "Compaction summary", {
    compacted: true,
    compactionBoundary: true,
    compactionEpoch: 1,
    muxMetadata: {
      type: "compaction-summary",
      pendingFollowUp,
    },
  });
}

function preservedTailCopy(id: string, role: "user" | "assistant", text: string): MuxMessage {
  return createMuxMessage(id, role, text, {
    synthetic: true,
    rlmPreservedTailCopy: true,
  });
}

function heartbeatBoundaryMessage(pendingFollowUp = idleFollowUp()): MuxMessage {
  return createMuxMessage("heartbeat-boundary", "assistant", "Reset boundary", {
    compacted: "heartbeat",
    compactionBoundary: true,
    compactionEpoch: 1,
    muxMetadata: {
      type: "compaction-summary",
      pendingFollowUp,
    },
  });
}

function createAiService(): AIService {
  return {
    on() {
      return this;
    },
    off() {
      return this;
    },
    ...createStreamLifecycleMocks(),
    isStreaming: () => false,
    stopStream: mock(() => Promise.resolve({ success: true as const, data: undefined })),
  } as unknown as AIService;
}

function createInitStateManager(): InitStateManager {
  return {
    on() {
      return this;
    },
    off() {
      return this;
    },
  } as unknown as InitStateManager;
}

function createBackgroundProcessManager(): BackgroundProcessManager {
  return {
    cleanup: mock(() => Promise.resolve()),
    setMessageQueued: mock(() => undefined),
  } as unknown as BackgroundProcessManager;
}

function createConfig(): Config {
  return {
    rootDir: "/tmp",
    sessionsDir: "/tmp",
    srcDir: "/tmp",
    loadConfigOrDefault: mock(() => ({})),
  } as unknown as Config;
}

describe("AgentSession continue-message agentId fallback", () => {
  let historyCleanup: (() => Promise<void>) | undefined;
  const sessions: AgentSession[] = [];

  afterEach(async () => {
    for (const session of sessions.splice(0)) {
      await session.dispose();
    }
    await historyCleanup?.();
    historyCleanup = undefined;
    mock.restore();
  });

  const createSession = async (messages: MuxMessage[] = [], config = createConfig()) => {
    const { historyService, cleanup } = await createTestHistoryService();
    historyCleanup = cleanup;
    for (const message of messages) {
      await historyService.appendToHistory("ws", message);
    }

    const session = new AgentSession({
      workspaceId: "ws",
      config,
      historyService,
      aiService: createAiService(),
      initStateManager: createInitStateManager(),
      backgroundProcessManager: createBackgroundProcessManager(),
    });
    sessions.push(session);

    return {
      session,
      historyService,
      internals: session as unknown as SessionInternals,
    };
  };

  test.each([false, true])(
    "a new turn during queued follow-up cleanup preserves the summary (heartbeat=%s)",
    async (heartbeat) => {
      const summary = heartbeat
        ? heartbeatBoundaryMessage()
        : compactionSummaryMessage("summary", idleFollowUp());
      const { session, internals, historyService } = await createSession([summary]);
      const entered = Promise.withResolvers<void>();
      const release = Promise.withResolvers<void>();
      const cleanup = historyService.cleanupCompactionFollowUp.bind(historyService);
      spyOn(historyService, "cleanupCompactionFollowUp").mockImplementationOnce(async (...args) => {
        entered.resolve();
        await release.promise;
        return cleanup(...args);
      });
      const changed = mock(() => undefined);
      internals.onPostCompactionStateChange = changed;
      session.queueMessage("manual work", { model: "openai:gpt-4o", agentId: "exec" });
      const dispatch = internals.dispatchPendingFollowUp();
      try {
        await entered.promise;
        const admission = internals.coordinator.prepare({
          kind: "fresh",
          intent: "direct",
          expectedTurnId: internals.coordinator.turnId,
        });
        expect(admission.status).toBe("admitted");
        release.resolve();
        expect(await dispatch).toBe(false);
        const history = await historyService.getLastMessages("ws", 1);
        expect(history.success && history.data[0].metadata?.muxMetadata).toHaveProperty(
          "pendingFollowUp"
        );
        expect(changed).not.toHaveBeenCalled();
      } finally {
        release.resolve();
        await dispatch;
      }
    }
  );

  test("legacy continueMessage.mode does not fall back to compact agent", async () => {
    let dispatchedMessage: string | undefined;
    let dispatchedOptions: SendOptions | undefined;
    let dispatchedInternal: { synthetic?: boolean; agentInitiated?: boolean } | undefined;
    const legacyFollowUp = {
      text: "follow up",
      model: "openai:gpt-4o",
      agentId: undefined as unknown as string,
      mode: "plan" as const,
    };
    const { internals } = await createSession([
      compactionSummaryMessage("summary-1", legacyFollowUp),
    ]);

    internals.sendMessage = mock(
      (
        message: string,
        options?: SendOptions,
        internal?: { synthetic?: boolean; agentInitiated?: boolean }
      ) => {
        dispatchedMessage = message;
        dispatchedOptions = options;
        dispatchedInternal = internal;
        return Promise.resolve({ success: true as const });
      }
    );

    await internals.dispatchPendingFollowUp();

    expect(dispatchedMessage).toBe("follow up");
    expect(dispatchedOptions?.agentId).toBe("plan");
    expect(dispatchedInternal?.synthetic).toBe(true);
  });

  test("dispatchPendingFollowUp aliases legacy exclusive-PTC experiments", async () => {
    // An older build can persist {programmaticToolCalling: false,
    // programmaticToolCallingExclusive: true}; dispatch copies raw persisted
    // JSON into the next send, and the explicit false would otherwise win
    // over backend overrides while the removed legacy field is ignored —
    // silently downgrading the crash-safe follow-up to PTC-off (and making
    // its rlm flag inert).
    let dispatchedOptions: SendOptions | undefined;
    const { internals } = await createSession([
      compactionSummaryMessage("summary-legacy-ptc", {
        text: "continue after compaction",
        model: "openai:gpt-4o",
        agentId: "exec",
        experiments: {
          programmaticToolCalling: false,
          programmaticToolCallingExclusive: true,
          rlm: true,
        },
      }),
    ]);
    internals.sendMessage = mock((_message: string, options?: SendOptions) => {
      dispatchedOptions = options;
      return Promise.resolve({ success: true as const });
    });

    await internals.dispatchPendingFollowUp();

    expect(dispatchedOptions?.experiments?.programmaticToolCalling).toBe(true);
    expect(dispatchedOptions?.experiments?.rlm).toBe(true);
  });

  test("dispatchPendingFollowUp preserves agent-initiated attribution", async () => {
    let dispatchedInternal: { synthetic?: boolean; agentInitiated?: boolean } | undefined;
    const { internals } = await createSession([
      compactionSummaryMessage("summary-agent-initiated", {
        text: "continue delegated work",
        model: "openai:gpt-4o",
        agentId: "exec",
        agentInitiated: true,
      }),
    ]);
    internals.sendMessage = mock(
      (
        _message: string,
        _options?: SendOptions,
        internal?: { synthetic?: boolean; agentInitiated?: boolean }
      ) => {
        dispatchedInternal = internal;
        return Promise.resolve({ success: true as const });
      }
    );

    await internals.dispatchPendingFollowUp();

    expect(dispatchedInternal).toMatchObject({ synthetic: true, agentInitiated: true });
    expect(internals.lastAutoRetryResumeRequest?.agentInitiated).toBe(true);
  });

  test("dispatchPendingFollowUp forwards strictAgentResolution to the resumed turn", async () => {
    let dispatchedOptions: SendOptions | undefined;
    const { internals } = await createSession([
      compactionSummaryMessage("summary-strict", {
        text: "continue delegated work",
        model: "openai:gpt-4o",
        agentId: "plan",
        strictAgentResolution: true,
      }),
    ]);
    internals.sendMessage = mock((_message: string, options?: SendOptions) => {
      dispatchedOptions = options;
      return Promise.resolve({ success: true as const });
    });

    await internals.dispatchPendingFollowUp();

    // The requested agent may have been removed/hidden/disabled while compaction ran;
    // the resumed turn must stay loud instead of silently falling back to exec.
    expect(dispatchedOptions?.agentId).toBe("plan");
    expect(dispatchedOptions?.strictAgentResolution).toBe(true);
  });

  test("dispatchPendingFollowUp leaves the follow-up pending when the workspace is archived on disk", async () => {
    const archivedConfig = {
      ...createConfig(),
      loadConfigOrDefault: () => ({
        projects: new Map([
          [
            "/tmp",
            {
              workspaces: [{ id: "ws", path: "/tmp/ws", archivedAt: "2026-01-01T00:00:00.000Z" }],
            },
          ],
        ]),
      }),
    } as unknown as Config;
    const { historyService, internals } = await createSession(
      [
        compactionSummaryMessage("summary-archived", {
          text: "resume after compaction",
          model: "openai:gpt-4o",
          agentId: "exec",
        }),
      ],
      archivedConfig
    );
    internals.sendMessage = mock(() => Promise.resolve({ success: true as const }));

    const dispatched = await internals.dispatchPendingFollowUp();

    expect(dispatched).toBe(false);
    expect(internals.sendMessage).not.toHaveBeenCalled();
    // Still pending for the next startup after an unarchive.
    const lastMessages = await historyService.getLastMessages("ws", 1);
    expect(lastMessages.success && lastMessages.data[0]?.metadata?.muxMetadata).toMatchObject({
      type: "compaction-summary",
      pendingFollowUp: { text: "resume after compaction" },
    });
  });

  test("dispatchPendingFollowUp skips idle-only follow-ups when queued user input exists", async () => {
    const { session, historyService, internals } = await createSession([
      compactionSummaryMessage("summary-idle-only", idleFollowUp()),
    ]);
    internals.sendMessage = mock(() => Promise.resolve({ success: true as const }));
    session.queueMessage(
      "user returned",
      { model: "openai:gpt-4o", agentId: "exec" },
      { synthetic: false }
    );

    const dispatched = await internals.dispatchPendingFollowUp();

    expect(dispatched).toBe(false);
    expect(internals.sendMessage).not.toHaveBeenCalled();

    const lastMessages = await historyService.getLastMessages("ws", 1);
    expect(lastMessages.success).toBe(true);
    if (!lastMessages.success) {
      throw new Error(`Expected history read to succeed: ${lastMessages.error}`);
    }
    expect(lastMessages.data[0]?.metadata?.muxMetadata).toEqual({ type: "compaction-summary" });
  });

  test("dispatchPendingFollowUp removes heartbeat reset boundaries when idle-only follow-ups are skipped", async () => {
    const earlierMessage = createMuxMessage("before-reset", "assistant", "Earlier context");
    const { session, historyService, internals } = await createSession([
      earlierMessage,
      heartbeatBoundaryMessage(),
    ]);
    internals.sendMessage = mock(() => Promise.resolve({ success: true as const }));
    session.queueMessage(
      "user returned",
      { model: "openai:gpt-4o", agentId: "exec" },
      { synthetic: false }
    );

    const dispatched = await internals.dispatchPendingFollowUp();

    expect(dispatched).toBe(false);
    expect(internals.sendMessage).not.toHaveBeenCalled();

    const historyResult = await historyService.getLastMessages("ws", 10);
    expect(historyResult.success).toBe(true);
    if (!historyResult.success) {
      throw new Error(`Expected history read to succeed: ${historyResult.error}`);
    }
    expect(historyResult.data.map((message) => message.id)).toEqual(["before-reset"]);
  });

  test("dispatchPendingFollowUp rolls back heartbeat boundaries when a service send is in preflight", async () => {
    // Codex P2 (PRRT_kwDOPxxmWM6cRi_N): a manual service-level send still in
    // preflight is user contention too — the heartbeat reset boundary must be
    // rolled back (as for queued input), not left in history with the
    // follow-up silently cleared.
    const earlierMessage = createMuxMessage("before-reset", "assistant", "Earlier context");
    const { session, historyService, internals } = await createSession([
      earlierMessage,
      heartbeatBoundaryMessage(),
    ]);
    internals.sendMessage = mock(() => Promise.resolve({ success: true as const }));
    (session as unknown as { hasExternalSendPreflight?: () => boolean }).hasExternalSendPreflight =
      () => true;

    const dispatched = await internals.dispatchPendingFollowUp();

    expect(dispatched).toBe(false);
    expect(internals.sendMessage).not.toHaveBeenCalled();

    const historyResult = await historyService.getLastMessages("ws", 10);
    expect(historyResult.success).toBe(true);
    if (!historyResult.success) {
      throw new Error(`Expected history read to succeed: ${historyResult.error}`);
    }
    expect(historyResult.data.map((message) => message.id)).toEqual(["before-reset"]);
  });

  test("dispatchPendingFollowUp skips idle-only follow-ups when a new turn is already active", async () => {
    const { historyService, internals } = await createSession([
      compactionSummaryMessage("summary-active-turn", idleFollowUp()),
    ]);
    const busyInternals = internals as SessionInternals & { isBusy: () => boolean };
    busyInternals.sendMessage = mock(() => Promise.resolve({ success: true as const }));
    busyInternals.isBusy = () => true;

    const dispatched = await busyInternals.dispatchPendingFollowUp();

    expect(dispatched).toBe(false);
    expect(busyInternals.sendMessage).not.toHaveBeenCalled();

    const lastMessages = await historyService.getLastMessages("ws", 1);
    expect(lastMessages.success).toBe(true);
    if (!lastMessages.success) {
      throw new Error(`Expected history read to succeed: ${lastMessages.error}`);
    }
    expect(lastMessages.data[0]?.metadata?.muxMetadata).toEqual({ type: "compaction-summary" });
  });

  test("dispatchPendingFollowUp keeps heartbeat reset boundaries once a non-idle turn has started", async () => {
    const { historyService, internals } = await createSession([heartbeatBoundaryMessage()]);
    const busyInternals = internals as SessionInternals & { isBusy: () => boolean };
    busyInternals.sendMessage = mock(() => Promise.resolve({ success: true as const }));
    busyInternals.isBusy = () => true;

    const dispatched = await busyInternals.dispatchPendingFollowUp();

    expect(dispatched).toBe(false);
    expect(busyInternals.sendMessage).not.toHaveBeenCalled();

    const historyResult = await historyService.getLastMessages("ws", 10);
    expect(historyResult.success).toBe(true);
    if (!historyResult.success) {
      throw new Error(`Expected history read to succeed: ${historyResult.error}`);
    }
    expect(historyResult.data[0]?.id).toBe("heartbeat-boundary");
    expect(historyResult.data[0]?.metadata?.muxMetadata).toEqual({ type: "compaction-summary" });
  });

  test("dispatchPendingFollowUp still runs idle-only follow-ups during compaction completion", async () => {
    const { internals } = await createSession([
      compactionSummaryMessage("summary-completing-turn", idleFollowUp()),
    ]);
    const completingInternals = internals as SessionInternals & { coordinator: TurnCoordinator };
    completingInternals.sendMessage = mock(() => Promise.resolve({ success: true as const }));
    completingInternals.coordinator.beginPolicy(completingInternals.coordinator.turnId);

    const dispatched = await completingInternals.dispatchPendingFollowUp();

    expect(dispatched).toBe(true);
    expect(completingInternals.sendMessage).toHaveBeenCalledTimes(1);
  });

  test("dispatchPendingFollowUp rewrites stale compact retry state to the reconstructed follow-up", async () => {
    const legacyFollowUp = {
      text: "follow up retry",
      model: "openai:gpt-4o",
      agentId: undefined as unknown as string,
      mode: "plan" as const,
      allowAgentSetGoal: true,
      thinkingLevel: "high" as const,
    };
    const { internals } = await createSession([
      compactionSummaryMessage("summary-retry-state", legacyFollowUp),
    ]);
    internals.lastAutoRetryResumeRequest = {
      options: {
        model: "openai:gpt-4o-mini",
        agentId: "compact",
        toolPolicy: [{ regex_match: ".*", action: "disable" }],
      },
      agentInitiated: true,
    };
    internals.sendMessage = mock(() =>
      Promise.resolve({
        success: false as const,
        error: { type: "runtime_start_failed", message: "startup failed" },
      })
    );

    let dispatchError: unknown;
    try {
      await internals.dispatchPendingFollowUp();
    } catch (error) {
      dispatchError = error;
    }

    expect(dispatchError).toBeInstanceOf(Error);
    if (!(dispatchError instanceof Error)) {
      throw new Error("Expected dispatchPendingFollowUp to throw when sendMessage fails");
    }
    expect(dispatchError.message).toContain("Failed to dispatch pending follow-up");
    expect(internals.lastAutoRetryResumeRequest?.options.model).toBe("openai:gpt-4o");
    expect(internals.lastAutoRetryResumeRequest?.options.agentId).toBe("plan");
    expect(internals.lastAutoRetryResumeRequest?.options.allowAgentSetGoal).toBe(true);
    expect(internals.lastAutoRetryResumeRequest?.options.thinkingLevel).toBe("high");
    expect(internals.lastAutoRetryResumeRequest?.options.toolPolicy).toBeUndefined();
    expect(internals.lastAutoRetryResumeRequest?.agentInitiated).toBeUndefined();
  });

  test("dispatchPendingFollowUp throws when history read fails", async () => {
    const { internals } = await createSession();
    const historyInternals = internals as SessionInternals & {
      historyService: {
        getLastMessages: (
          workspaceId: string,
          count: number
        ) => Promise<{ success: boolean; error?: string; data: MuxMessage[] }>;
      };
    };
    historyInternals.historyService.getLastMessages = mock(() =>
      Promise.resolve({ success: false, error: "temporary history read failure", data: [] })
    );

    let dispatchError: unknown;
    try {
      await historyInternals.dispatchPendingFollowUp();
    } catch (error) {
      dispatchError = error;
    }

    expect(dispatchError).toBeInstanceOf(Error);
    if (!(dispatchError instanceof Error)) {
      throw new Error("Expected dispatchPendingFollowUp to throw on history read failures");
    }
    expect(dispatchError.message).toContain(
      "Failed to read history for startup follow-up recovery"
    );
  });

  test("startup recovery dispatches pending follow-up only once", async () => {
    let sendCount = 0;
    const { internals } = await createSession([
      compactionSummaryMessage("summary-once", {
        text: "follow up once",
        model: "openai:gpt-4o",
        agentId: "exec",
      }),
    ]);
    internals.sendMessage = mock(() => {
      sendCount += 1;
      return Promise.resolve({ success: true as const });
    });

    await Promise.all([internals.runStartupRecovery(), internals.runStartupRecovery()]);

    expect(sendCount).toBe(1);
  });

  test("startup recovery retries pending follow-up after an initial send failure", async () => {
    let sendCount = 0;
    const { internals } = await createSession([
      compactionSummaryMessage("summary-retry", {
        text: "follow up retry",
        model: "openai:gpt-4o",
        agentId: "exec",
      }),
    ]);
    internals.sendMessage = mock(() => {
      sendCount += 1;
      if (sendCount === 1) {
        return Promise.resolve({
          success: false,
          error: { type: "runtime_start_failed", message: "startup failed" },
        });
      }
      return Promise.resolve({ success: true as const });
    });

    await internals.runStartupRecovery();

    expect(sendCount).toBe(1);

    await internals.runStartupRecovery();

    expect(sendCount).toBe(2);
  });

  // RLM keep-recent floor: post-crash recovery when the compaction summary is
  // no longer the last history row because preserved-tail copies trail it.
  test("startup recovery dispatches the follow-up when preserved-tail copies trail the summary", async () => {
    let dispatchedMessage: string | undefined;
    const { internals } = await createSession([
      rlmSummaryBoundaryMessage({
        text: "follow up after tail",
        model: "openai:gpt-4o",
        agentId: "exec",
      }),
      preservedTailCopy("tail-copy-1", "user", "original user message"),
      preservedTailCopy("tail-copy-2", "assistant", "original assistant reply"),
    ]);
    internals.sendMessage = mock((message: string) => {
      dispatchedMessage = message;
      return Promise.resolve({ success: true as const });
    });

    await internals.runStartupRecovery();

    expect(dispatchedMessage).toBe("follow up after tail");
    expect(internals.sendMessage).toHaveBeenCalledTimes(1);
  });

  test("startup recovery declines a trailing tail copy when a non-copy row follows the boundary", async () => {
    // Staleness guard: the epoch is not exactly [summary, ...tail copies], so
    // "compaction just completed" no longer holds and the follow-up must stay
    // parked on the summary for a later legitimate recovery.
    const { historyService, internals } = await createSession([
      rlmSummaryBoundaryMessage({
        text: "stale follow up",
        model: "openai:gpt-4o",
        agentId: "exec",
      }),
      preservedTailCopy("tail-copy-1", "user", "original user message"),
      createMuxMessage("post-compaction-turn", "assistant", "new turn after compaction"),
      preservedTailCopy("tail-copy-2", "assistant", "trailing copy"),
    ]);
    internals.sendMessage = mock(() => Promise.resolve({ success: true as const }));

    const dispatched = await internals.dispatchPendingFollowUp();

    expect(dispatched).toBe(false);
    expect(internals.sendMessage).not.toHaveBeenCalled();

    const historyResult = await historyService.getLastMessages("ws", 10);
    expect(historyResult.success).toBe(true);
    if (!historyResult.success) {
      throw new Error(`Expected history read to succeed: ${historyResult.error}`);
    }
    const summary = historyResult.data.find((message) => message.id === "rlm-summary");
    expect(summary?.metadata?.muxMetadata).toMatchObject({
      type: "compaction-summary",
      pendingFollowUp: { text: "stale follow up" },
    });
  });
});

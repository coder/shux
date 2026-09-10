import { runSessionTerminalPolicy } from "./agentSession.testHarness";
import { describe, expect, test, mock, afterEach } from "bun:test";
import { AgentSession } from "./agentSession";
import type { Config } from "@/node/config";
import type { AIService } from "./aiService";
import type { InitStateManager } from "./initStateManager";
import type { BackgroundProcessManager } from "./backgroundProcessManager";
import { createTestHistoryService } from "./testHistoryService";
import type { CompactionCompletionMetadata } from "@/common/types/compaction";
import { createMuxMessage } from "@/common/types/message";
import type { StreamEndEvent } from "@/common/types/stream";
import { createAgentSessionHarness, createStreamLifecycleMocks } from "./agentSession.testHarness";

// NOTE: These tests focus on the event wiring (tool-call-end -> callback).
// The actual post-compaction state computation is covered elsewhere.

async function waitForCondition(assertion: () => void): Promise<void> {
  const deadline = Date.now() + 1000;
  let lastError: unknown;

  while (Date.now() < deadline) {
    try {
      assertion();
      return;
    } catch (error) {
      lastError = error;
      await new Promise((resolve) => setTimeout(resolve, 10));
    }
  }

  try {
    assertion();
  } catch (error) {
    if (error instanceof Error) throw error;
    throw new Error(String(error));
  }

  if (lastError instanceof Error) throw lastError;
  if (lastError != null) throw new Error("condition failed with non-Error value");
}

describe("AgentSession post-compaction refresh trigger", () => {
  let historyCleanup: (() => Promise<void>) | undefined;
  afterEach(async () => {
    await historyCleanup?.();
  });

  test("calls compaction-complete callback once for a durable compaction boundary", async () => {
    const workspaceId = "ws-compaction-once";
    const onCompactionComplete = mock((_metadata: CompactionCompletionMetadata) => undefined);
    const { session, historyService, aiEmitter, cleanup } = await createAgentSessionHarness({
      workspaceId,
      onCompactionComplete,
    });
    historyCleanup = cleanup;

    await historyService.appendToHistory(
      workspaceId,
      createMuxMessage("user-before-compact", "user", "Remember that we prefer concise tests", {
        timestamp: 1000,
      })
    );
    await historyService.appendToHistory(
      workspaceId,
      createMuxMessage("assistant-before-compact", "assistant", "Noted.", {
        timestamp: 1001,
      })
    );
    await historyService.appendToHistory(
      workspaceId,
      createMuxMessage("compact-request", "user", "Please compact", {
        timestamp: 1002,
        muxMetadata: { type: "compaction-request", rawCommand: "/compact", parsed: {} },
      })
    );

    const streamEnd: StreamEndEvent = {
      type: "stream-end",
      workspaceId,
      messageId: "compact-summary-stream",
      parts: [{ type: "text", text: "The user prefers concise tests." }],
      metadata: {
        model: "openai:gpt-4o",
        usage: { inputTokens: 10, outputTokens: 5, totalTokens: 15 },
        duration: 100,
      },
    };

    void runSessionTerminalPolicy(session, aiEmitter, streamEnd);

    await waitForCondition(() => {
      expect(onCompactionComplete).toHaveBeenCalledTimes(1);
    });
    const completionMetadata = onCompactionComplete.mock.calls[0]?.[0];
    expect(completionMetadata).toBeDefined();
    if (completionMetadata === undefined) throw new Error("missing compaction completion metadata");
    expect(completionMetadata.workspaceId).toBe(workspaceId);
    expect(typeof completionMetadata.summaryMessageId).toBe("string");
    expect(typeof completionMetadata.summaryHistorySequence).toBe("number");
    expect(completionMetadata.compactionEpoch).toBe(1);
    expect(completionMetadata.compactionRequestMessageId).toBe("compact-request");

    const history = await historyService.getHistoryFromLatestBoundary(workspaceId);
    expect(history.success).toBe(true);
    if (!history.success) throw new Error(history.error);
    expect(history.data).toHaveLength(1);
    expect(history.data[0]?.metadata?.compactionBoundary).toBe(true);
    expect(history.data[0]?.parts[0]).toMatchObject({
      type: "text",
      text: "The user prefers concise tests.",
    });

    void runSessionTerminalPolicy(session, aiEmitter, streamEnd);
    await new Promise((resolve) => setTimeout(resolve, 25));
    expect(onCompactionComplete).toHaveBeenCalledTimes(1);

    await session.dispose();
  });

  test("reports failed compaction continuation dispatch to lifecycle consumers", async () => {
    const workspaceId = "ws-compaction-follow-up-failure";
    const { session, historyService, aiEmitter, cleanup } = await createAgentSessionHarness({
      workspaceId,
    });
    historyCleanup = cleanup;
    await historyService.appendToHistory(
      workspaceId,
      createMuxMessage("before-failed-follow-up", "user", "Preserve this context")
    );
    await historyService.appendToHistory(
      workspaceId,
      createMuxMessage("failed-follow-up-request", "user", "Please compact", {
        muxMetadata: {
          type: "compaction-request",
          rawCommand: "/compact",
          parsed: {
            followUpContent: {
              text: "Continue delegated work",
              model: "openai:gpt-4o",
              agentId: "exec",
            },
          },
        },
      })
    );

    const internals = session as unknown as {
      activeCompactionRequest?: { id: string; modelString: string };
      dispatchPendingFollowUp: () => Promise<boolean>;
    };
    internals.activeCompactionRequest = {
      id: "failed-follow-up-request",
      modelString: "openai:gpt-4o",
    };
    internals.dispatchPendingFollowUp = mock(() =>
      Promise.reject(new Error("follow-up startup failed"))
    );
    const decision = session.waitForPendingCompactionCompletionDecision("failed-follow-up-summary");

    void runSessionTerminalPolicy(session, aiEmitter, {
      type: "stream-end",
      workspaceId,
      messageId: "failed-follow-up-summary",
      metadata: { model: "openai:gpt-4o", agentId: "compact", finishReason: "stop" },
      parts: [{ type: "text", text: "Compacted context" }],
    } satisfies StreamEndEvent);

    expect(await decision).toBe(false);
    expect(internals.dispatchPendingFollowUp).toHaveBeenCalledTimes(1);
    await session.dispose();
  });

  test("triggers callback on file_edit_* tool-call-end", async () => {
    const handlers = new Map<string, (...args: unknown[]) => void>();

    const aiService: AIService = {
      ...createStreamLifecycleMocks(),
      on(eventName: string | symbol, listener: (...args: unknown[]) => void) {
        handlers.set(String(eventName), listener);
        return this;
      },
      off(_eventName: string | symbol, _listener: (...args: unknown[]) => void) {
        return this;
      },
      stopStream: mock(() => Promise.resolve({ success: true as const, data: undefined })),
    } as unknown as AIService;

    const { historyService, cleanup } = await createTestHistoryService();
    historyCleanup = cleanup;

    const initStateManager: InitStateManager = {
      on(_eventName: string | symbol, _listener: (...args: unknown[]) => void) {
        return this;
      },
      off(_eventName: string | symbol, _listener: (...args: unknown[]) => void) {
        return this;
      },
    } as unknown as InitStateManager;

    const backgroundProcessManager: BackgroundProcessManager = {
      setMessageQueued: mock(() => undefined),
      cleanup: mock(() => Promise.resolve()),
    } as unknown as BackgroundProcessManager;

    const config: Config = {
      rootDir: "/tmp",
      sessionsDir: "/tmp",
      srcDir: "/tmp",
      loadConfigOrDefault: mock(() => ({})),
    } as unknown as Config;

    const onPostCompactionStateChange = mock(() => undefined);

    const session = new AgentSession({
      workspaceId: "ws",
      config,
      historyService,
      aiService,
      initStateManager,
      backgroundProcessManager,
      onPostCompactionStateChange,
    });

    const toolEnd = handlers.get("tool-call-end");
    expect(toolEnd).toBeDefined();

    toolEnd!({
      type: "tool-call-end",
      workspaceId: "ws",
      messageId: "m1",
      toolCallId: "t1b",
      toolName: "file_edit_replace_lines",
      result: {},
      timestamp: Date.now(),
    });

    toolEnd!({
      type: "tool-call-end",
      workspaceId: "ws",
      messageId: "m1",
      toolCallId: "t1",
      toolName: "file_edit_insert",
      result: {},
      timestamp: Date.now(),
    });

    toolEnd!({
      type: "tool-call-end",
      workspaceId: "ws",
      messageId: "m1",
      toolCallId: "t2",
      toolName: "bash",
      result: {},
      timestamp: Date.now(),
    });

    expect(onPostCompactionStateChange).toHaveBeenCalledTimes(2);

    await session.dispose();
  });
});

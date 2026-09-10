import { describe, test, expect } from "bun:test";
import { CONTEXT_BOUNDARY_KINDS } from "@/common/constants/contextBoundary";
import { MuxMessageSchema } from "@/common/orpc/schemas/message";
import { createMuxMessage, type DisplayedMessage } from "@/common/types/message";
import { formatSubagentReportEnvelope } from "@/common/utils/subagentReportEnvelope";
import { buildWorkflowRunCardMessage } from "@/common/utils/workflowRunMessages";
import { getInterruptionContext } from "@/common/utils/messages/retryEligibility";
import { shouldNotifyOnResponseComplete } from "./responseCompletionMetadata";
import { MAX_HISTORY_HIDDEN_SEGMENTS } from "./transcriptTruncationPlan";
import { StreamingMessageAggregator } from "./StreamingMessageAggregator";

// Test helper: create aggregator with default createdAt for tests
const TEST_CREATED_AT = "2024-01-01T00:00:00.000Z";

// Test helper: enable debugLlmRequest for the duration of a test.
function withDebugLlmRequestEnabled<T>(fn: () => T): T {
  const globalWithWindow = globalThis as unknown as { window?: { api?: WindowApi } };

  const previousWindow = globalWithWindow.window;
  const previousApi = previousWindow?.api;
  const previousDebugLlmRequest = previousApi?.debugLlmRequest;

  globalWithWindow.window ??= {};
  globalWithWindow.window.api ??= { platform: process.platform, versions: {} };
  globalWithWindow.window.api.debugLlmRequest = true;

  try {
    return fn();
  } finally {
    if (!previousWindow) {
      delete globalWithWindow.window;
    } else {
      globalWithWindow.window = previousWindow;

      if (!previousApi) {
        delete previousWindow.api;
      } else {
        previousApi.debugLlmRequest = previousDebugLlmRequest;
        previousWindow.api = previousApi;
      }
    }
  }
}
// Helper to wait for throttled init output updates (100ms throttle + buffer)
const waitForInitThrottle = () => new Promise((r) => setTimeout(r, 120));

function seedPendingStreamState(aggregator: StreamingMessageAggregator): void {
  aggregator.handleMessage({
    ...createMuxMessage("user-1", "user", "Hello", {
      historySequence: 1,
      timestamp: Date.now(),
      muxMetadata: {
        type: "normal",
        requestedModel: "openai:gpt-4o-mini",
      },
    }),
    type: "message",
  });

  aggregator.handleRuntimeStatus({
    type: "runtime-status",
    workspaceId: "test-workspace",
    phase: "starting",
    runtimeType: "local",
    detail: "Starting workspace...",
  });
}

type TodoStatus = "pending" | "in_progress" | "completed";
interface TodoItem {
  content: string;
  status: TodoStatus;
}

const TEST_WORKSPACE_ID = "test-workspace";
const TEST_MODEL = "claude-3-5-sonnet-20241022";

function createTestAggregator(): StreamingMessageAggregator {
  return new StreamingMessageAggregator(TEST_CREATED_AT);
}

function startTestStream(
  aggregator: StreamingMessageAggregator,
  options: { messageId?: string; historySequence?: number } = {}
): void {
  aggregator.handleStreamStart({
    type: "stream-start",
    workspaceId: TEST_WORKSPACE_ID,
    messageId: options.messageId ?? "msg1",
    historySequence: options.historySequence ?? 1,
    model: TEST_MODEL,
    startTime: Date.now(),
  });
}

function endTestStream(aggregator: StreamingMessageAggregator, messageId = "msg1"): void {
  aggregator.handleStreamEnd({
    type: "stream-end",
    workspaceId: TEST_WORKSPACE_ID,
    messageId,
    metadata: {
      historySequence: 1,
      timestamp: Date.now(),
      model: TEST_MODEL,
    },
    parts: [],
  });
}

function startToolCall(
  aggregator: StreamingMessageAggregator,
  options: {
    messageId?: string;
    toolCallId: string;
    toolName: string;
    args: Record<string, unknown>;
    tokens?: number;
    timestamp?: number;
    parentToolCallId?: string;
  }
): void {
  aggregator.handleToolCallStart({
    type: "tool-call-start",
    workspaceId: TEST_WORKSPACE_ID,
    messageId: options.messageId ?? "msg-1",
    toolCallId: options.toolCallId,
    toolName: options.toolName,
    args: options.args,
    tokens: options.tokens ?? 0,
    timestamp: options.timestamp ?? Date.now(),
    parentToolCallId: options.parentToolCallId,
  });
}

function endToolCall(
  aggregator: StreamingMessageAggregator,
  options: {
    messageId?: string;
    toolCallId: string;
    toolName: string;
    result: unknown;
    timestamp?: number;
    parentToolCallId?: string;
    replay?: boolean;
  }
): void {
  aggregator.handleToolCallEnd({
    type: "tool-call-end",
    workspaceId: TEST_WORKSPACE_ID,
    messageId: options.messageId ?? "msg-1",
    toolCallId: options.toolCallId,
    toolName: options.toolName,
    result: options.result,
    timestamp: options.timestamp ?? Date.now(),
    parentToolCallId: options.parentToolCallId,
    replay: options.replay,
  });
}

function startParentTool(aggregator: StreamingMessageAggregator, code = "test"): void {
  startTestStream(aggregator, { messageId: "msg-1" });
  startToolCall(aggregator, {
    toolCallId: "parent-tool-1",
    toolName: "code_execution",
    args: { code },
    tokens: 10,
    timestamp: 1000,
  });
}

function parentToolMessage(aggregator: StreamingMessageAggregator) {
  return aggregator
    .getDisplayedMessages()
    .find((m) => m.type === "tool" && m.toolCallId === "parent-tool-1");
}

function runTestTool(
  aggregator: StreamingMessageAggregator,
  options: {
    messageId?: string;
    toolCallId?: string;
    toolName: string;
    args: Record<string, unknown>;
    result?: unknown;
    tokens?: number;
  }
): void {
  const messageId = options.messageId ?? "msg1";
  const toolCallId = options.toolCallId ?? "tool1";

  aggregator.handleToolCallStart({
    messageId,
    toolCallId,
    toolName: options.toolName,
    args: options.args,
    tokens: options.tokens ?? 10,
    timestamp: Date.now(),
    type: "tool-call-start",
    workspaceId: TEST_WORKSPACE_ID,
  });

  aggregator.handleToolCallEnd({
    type: "tool-call-end",
    workspaceId: TEST_WORKSPACE_ID,
    messageId,
    toolCallId,
    toolName: options.toolName,
    result: options.result ?? { success: true },
    timestamp: Date.now(),
  });
}

function writeTodos(
  aggregator: StreamingMessageAggregator,
  todos: TodoItem[],
  options: { messageId?: string; toolCallId?: string } = {}
): void {
  runTestTool(aggregator, {
    messageId: options.messageId,
    toolCallId: options.toolCallId,
    toolName: "todo_write",
    args: { todos },
  });
}

function historicalToolMessage(
  id: string,
  toolName: string,
  input: Record<string, unknown>,
  options: {
    toolCallId?: string;
    output?: unknown;
    historySequence?: number;
    partial?: boolean;
    workflowRun?: { runId: string; timestamp: number };
  } = {}
) {
  const message = createMuxMessage(id, "assistant", "", {
    partial: options.partial,
    historySequence: options.historySequence ?? 1,
    timestamp: Date.now(),
    muxMetadata: { type: "normal", requestedModel: TEST_MODEL },
  });
  message.parts.push({
    type: "dynamic-tool",
    toolCallId: options.toolCallId ?? "tool1",
    toolName,
    state: "output-available",
    input,
    ...(options.workflowRun != null ? { workflowRun: options.workflowRun } : {}),
    output: options.output ?? { success: true },
  });
  return message;
}

function historicalTodoMessage(
  id: string,
  todos: TodoItem[],
  options: { historySequence?: number; partial?: boolean } = {}
) {
  return historicalToolMessage(id, "todo_write", { todos }, options);
}

describe("StreamingMessageAggregator", () => {
  describe("workflow run attachments", () => {
    test("preserves persisted workflow run attachments on displayed tool rows", () => {
      const aggregator = createTestAggregator();
      const workflowRun = { runId: "wfr_partial", timestamp: 101 };
      const message = historicalToolMessage(
        "partial-workflow",
        "workflow_run",
        { name: "simplify", args: {} },
        {
          toolCallId: "workflow-call-1",
          historySequence: 7,
          partial: true,
          workflowRun,
        }
      );

      aggregator.loadHistoricalMessages([message], false);

      const toolRow = aggregator
        .getDisplayedMessages()
        .find((row) => row.type === "tool" && row.toolCallId === "workflow-call-1");
      expect(toolRow).toMatchObject({ workflowRun });
    });
  });

  describe("init state reference stability", () => {
    test("should return new array reference when state changes", async () => {
      const aggregator = new StreamingMessageAggregator(TEST_CREATED_AT);

      // Start init hook
      aggregator.handleMessage({
        type: "init-start",
        hookPath: "/test/init",
        timestamp: Date.now(),
      });

      const messages1 = aggregator.getDisplayedMessages();

      // Add output to change state
      aggregator.handleMessage({
        type: "init-output",
        line: "Line 1",
        isError: false,
        timestamp: Date.now(),
      });

      // Wait for throttled cache invalidation
      await waitForInitThrottle();

      const messages2 = aggregator.getDisplayedMessages();

      // Array references should be different when state changes
      expect(messages1).not.toBe(messages2);
    });

    test("should return new lines array reference when init state changes", async () => {
      const aggregator = new StreamingMessageAggregator(TEST_CREATED_AT);

      // Start init hook
      aggregator.handleMessage({
        type: "init-start",
        hookPath: "/test/init",
        timestamp: Date.now(),
      });

      const messages1 = aggregator.getDisplayedMessages();
      const initMsg1 = messages1.find((m) => m.type === "workspace-init");
      expect(initMsg1).toBeDefined();

      // Add output
      aggregator.handleMessage({
        type: "init-output",
        line: "Line 1",
        isError: false,
        timestamp: Date.now(),
      });

      // Wait for throttled cache invalidation
      await waitForInitThrottle();

      const messages2 = aggregator.getDisplayedMessages();
      const initMsg2 = messages2.find((m) => m.type === "workspace-init");
      expect(initMsg2).toBeDefined();

      // Lines array should be a NEW reference (critical for React.memo)
      if (initMsg1?.type === "workspace-init" && initMsg2?.type === "workspace-init") {
        expect(initMsg1.lines).not.toBe(initMsg2.lines);
        expect(initMsg2.lines).toHaveLength(1);
        expect(initMsg2.lines[0]).toEqual({ line: "Line 1", isError: false });
      }
    });

    test("should create new init message object on each state change", async () => {
      const aggregator = new StreamingMessageAggregator(TEST_CREATED_AT);

      // Start init hook
      aggregator.handleMessage({
        type: "init-start",
        hookPath: "/test/init",
        timestamp: Date.now(),
      });

      const messages1 = aggregator.getDisplayedMessages();
      const initMsg1 = messages1.find((m) => m.type === "workspace-init");

      // Add first output
      aggregator.handleMessage({
        type: "init-output",
        line: "Line 1",
        isError: false,
        timestamp: Date.now(),
      });

      // Wait for throttled cache invalidation
      await waitForInitThrottle();

      const messages2 = aggregator.getDisplayedMessages();
      const initMsg2 = messages2.find((m) => m.type === "workspace-init");

      // Add second output
      aggregator.handleMessage({
        type: "init-output",
        line: "Line 2",
        isError: false,
        timestamp: Date.now(),
      });

      // Wait for throttled cache invalidation
      await waitForInitThrottle();

      const messages3 = aggregator.getDisplayedMessages();
      const initMsg3 = messages3.find((m) => m.type === "workspace-init");

      // Each message object should be a new reference
      expect(initMsg1).not.toBe(initMsg2);
      expect(initMsg2).not.toBe(initMsg3);

      // Lines arrays should be different references
      if (
        initMsg1?.type === "workspace-init" &&
        initMsg2?.type === "workspace-init" &&
        initMsg3?.type === "workspace-init"
      ) {
        expect(initMsg1.lines).not.toBe(initMsg2.lines);
        expect(initMsg2.lines).not.toBe(initMsg3.lines);

        // Verify content progression
        expect(initMsg1.lines).toHaveLength(0);
        expect(initMsg2.lines).toHaveLength(1);
        expect(initMsg3.lines).toHaveLength(2);
      }
    });

    test("should return same cached reference when state has not changed", () => {
      const aggregator = new StreamingMessageAggregator(TEST_CREATED_AT);

      // Start init hook
      aggregator.handleMessage({
        type: "init-start",
        hookPath: "/test/init",
        timestamp: Date.now(),
      });

      const messages1 = aggregator.getDisplayedMessages();
      const messages2 = aggregator.getDisplayedMessages();

      // When no state changes, cache should return same reference
      expect(messages1).toBe(messages2);
    });
  });

  describe("display flags", () => {
    test("propagates modelFallback metadata to displayed assistant rows", () => {
      const aggregator = new StreamingMessageAggregator(TEST_CREATED_AT);

      const fallback = createMuxMessage("a1", "assistant", "answer", {
        timestamp: 1,
        historySequence: 1,
        model: "anthropic:claude-opus-4-8",
        modelFallback: {
          requestedModel: "openai:gpt-5.5",
          refusedModels: ["openai:gpt-5.5"],
        },
      });
      const plain = createMuxMessage("a2", "assistant", "no fallback", {
        timestamp: 2,
        historySequence: 2,
        model: "anthropic:claude-opus-4-8",
      });

      aggregator.loadHistoricalMessages([fallback, plain], false);

      const assistantRows = aggregator.getDisplayedMessages().filter((m) => m.type === "assistant");

      expect(assistantRows).toHaveLength(2);
      expect(assistantRows[0]?.modelFallback).toEqual({
        requestedModel: "openai:gpt-5.5",
        refusedModels: ["openai:gpt-5.5"],
      });
      expect(assistantRows[1]?.modelFallback).toBeUndefined();
    });

    test("should hide synthetic messages by default", () => {
      const aggregator = new StreamingMessageAggregator(TEST_CREATED_AT);

      const synthetic = createMuxMessage("s1", "user", "synthetic", {
        timestamp: 1,
        historySequence: 1,
        synthetic: true,
      });
      const user = createMuxMessage("u1", "user", "hello", {
        timestamp: 2,
        historySequence: 2,
      });

      aggregator.loadHistoricalMessages([synthetic, user], false);

      const displayed = aggregator.getDisplayedMessages();
      const contents = displayed.filter((m) => m.type === "user").map((m) => m.content);

      expect(contents).toEqual(["hello"]);
    });

    test("should show uiVisible synthetic messages by default", () => {
      const aggregator = new StreamingMessageAggregator(TEST_CREATED_AT);

      const syntheticVisible = createMuxMessage("s1", "user", "synthetic visible", {
        timestamp: 1,
        historySequence: 1,
        synthetic: true,
        uiVisible: true,
      });
      const user = createMuxMessage("u1", "user", "hello", {
        timestamp: 2,
        historySequence: 2,
      });

      aggregator.loadHistoricalMessages([syntheticVisible, user], false);

      const displayed = aggregator.getDisplayedMessages();
      const userMessages = displayed.filter((m) => m.type === "user");

      expect(userMessages).toHaveLength(2);
      expect(userMessages[0]?.content).toBe("synthetic visible");
      expect(userMessages[0]?.isSynthetic).toBe(true);
      expect(userMessages[1]?.content).toBe("hello");
      expect(userMessages[1]?.isSynthetic).toBeUndefined();
    });

    test("renders unknown persisted muxMetadata as an ordinary row", () => {
      const aggregator = new StreamingMessageAggregator(TEST_CREATED_AT);
      const legacyMessage = MuxMessageSchema.parse({
        id: "legacy-1",
        role: "user",
        parts: [{ type: "text", text: "ordinary persisted content" }],
        metadata: {
          timestamp: 1,
          historySequence: 1,
          muxMetadata: {
            type: "removed-feature",
            rawCommand: "/removed decorated content",
          },
        },
      });

      aggregator.loadHistoricalMessages([legacyMessage], false);

      expect(aggregator.getDisplayedMessages()).toMatchObject([
        {
          type: "user",
          historyId: "legacy-1",
          content: "ordinary persisted content",
          commandPrefix: undefined,
        },
      ]);
    });

    test("does not start a parent response for a visible completed subagent report", () => {
      const aggregator = new StreamingMessageAggregator(TEST_CREATED_AT);
      aggregator.loadHistoricalMessages(
        [
          createMuxMessage("assistant-1", "assistant", "I incorporated the progress update.", {
            timestamp: 1,
            historySequence: 1,
          }),
        ],
        false
      );

      aggregator.handleMessage({
        ...createMuxMessage(
          "report-1",
          "user",
          formatSubagentReportEnvelope({
            taskId: "task-1",
            agentType: "explore",
            status: "completed",
            title: "Investigation complete",
            reportMarkdown: "The child finished successfully.",
          }),
          {
            timestamp: 2,
            historySequence: 2,
            synthetic: true,
            uiVisible: true,
          }
        ),
        type: "message",
      });

      expect(aggregator.getPendingStreamStartTime()).toBeNull();
      const displayedMessages = aggregator.getDisplayedMessages();
      expect(
        displayedMessages
          .filter((message) => message.type === "user" || message.type === "assistant")
          .map((message) => `${message.type}:${message.historyId}`)
      ).toEqual(["user:report-1", "assistant:assistant-1"]);
      expect(getInterruptionContext(displayedMessages).hasInterruptedStream).toBe(false);
    });

    test("keeps an anchored completed report between reasoning emitted before and after it", () => {
      const report = createMuxMessage(
        "report-1",
        "user",
        formatSubagentReportEnvelope({
          taskId: "task-1",
          agentType: "explore",
          status: "completed",
          title: "Investigation complete",
          reportMarkdown: "The child finished successfully.",
        }),
        {
          timestamp: 2,
          historySequence: 2,
          synthetic: true,
          uiVisible: true,
          transcriptAnchor: {
            messageId: "assistant-1",
            historySequence: 1,
            textLength: 0,
            reasoningLength: 11,
            partIndex: 1,
          },
        }
      );

      const live = new StreamingMessageAggregator(TEST_CREATED_AT);
      live.handleStreamStart({
        type: "stream-start",
        workspaceId: "workspace-1",
        messageId: "assistant-1",
        historySequence: 1,
        model: "openai:gpt-5",
        startTime: 1,
      });
      live.handleReasoningDelta({
        type: "reasoning-delta",
        workspaceId: "workspace-1",
        messageId: "assistant-1",
        delta: "reasoning A",
        tokens: 1,
        timestamp: 1,
      });
      live.handleMessage({ ...report, type: "message" });
      live.handleReasoningDelta({
        type: "reasoning-delta",
        workspaceId: "workspace-1",
        messageId: "assistant-1",
        delta: "reasoning B",
        tokens: 1,
        timestamp: 3,
      });

      const readOrder = (aggregator: StreamingMessageAggregator) =>
        aggregator
          .getDisplayedMessages()
          .filter((row) => row.type === "reasoning" || row.type === "user")
          .map((row) =>
            row.type === "reasoning" ? `reasoning:${row.content}` : `user:${row.historyId}`
          );

      expect(readOrder(live)).toEqual([
        "reasoning:reasoning A",
        "user:report-1",
        "reasoning:reasoning B",
      ]);

      const liveRows = live.getDisplayedMessages();
      const liveReasoningRows = liveRows.filter((row) => row.type === "reasoning");
      expect(liveReasoningRows.map((row) => row.isLastPartOfMessage)).toEqual([false, true]);

      const reloaded = new StreamingMessageAggregator(TEST_CREATED_AT);
      reloaded.loadHistoricalMessages(
        [
          {
            ...createMuxMessage("assistant-1", "assistant", "", {
              timestamp: 1,
              historySequence: 1,
              model: "openai:gpt-5",
            }),
            parts: [
              { type: "reasoning", text: "reasoning A" },
              { type: "reasoning", text: "reasoning B" },
            ],
          },
          report,
        ],
        false
      );

      expect(readOrder(reloaded)).toEqual([
        "reasoning:reasoning A",
        "user:report-1",
        "reasoning:reasoning B",
      ]);
      const reloadedReasoningRows = reloaded
        .getDisplayedMessages()
        .filter((row) => row.type === "reasoning");
      expect(reloadedReasoningRows.map((row) => row.isLastPartOfMessage)).toEqual([false, true]);
      expect(readOrder(reloaded).at(-1)).not.toBe("user:report-1");
    });

    test("prefers a valid later-stream anchor over the earlier progress response", () => {
      const aggregator = new StreamingMessageAggregator(TEST_CREATED_AT);
      aggregator.loadHistoricalMessages(
        [
          createMuxMessage(
            "progress-1",
            "user",
            formatSubagentReportEnvelope({
              taskId: "task-1",
              agentType: "explore",
              status: "in_progress",
              title: "Progress",
              reportMarkdown: "Still investigating.",
            }),
            { timestamp: 1, historySequence: 1, synthetic: true }
          ),
          createMuxMessage("assistant-progress", "assistant", "I incorporated the update.", {
            timestamp: 2,
            historySequence: 2,
          }),
          createMuxMessage("manual-user", "user", "Continue with other work", {
            timestamp: 3,
            historySequence: 3,
          }),
          {
            ...createMuxMessage("assistant-current", "assistant", "", {
              timestamp: 4,
              historySequence: 4,
            }),
            parts: [
              { type: "reasoning", text: "reasoning A" },
              { type: "reasoning", text: "reasoning B" },
            ],
          },
          createMuxMessage(
            "report-1",
            "user",
            formatSubagentReportEnvelope({
              taskId: "task-1",
              agentType: "explore",
              status: "completed",
              title: "Investigation complete",
              reportMarkdown: "The child finished successfully.",
            }),
            {
              timestamp: 5,
              historySequence: 5,
              synthetic: true,
              uiVisible: true,
              transcriptAnchor: {
                messageId: "assistant-current",
                historySequence: 4,
                textLength: 0,
                reasoningLength: "reasoning A".length,
                partIndex: 1,
              },
            }
          ),
        ],
        false
      );

      expect(
        aggregator
          .getDisplayedMessages()
          .filter(
            (row) => row.type === "assistant" || row.type === "reasoning" || row.type === "user"
          )
          .map((row) =>
            row.type === "reasoning" ? `reasoning:${row.content}` : `${row.type}:${row.historyId}`
          )
      ).toEqual([
        "assistant:assistant-progress",
        "user:manual-user",
        "reasoning:reasoning A",
        "user:report-1",
        "reasoning:reasoning B",
      ]);
    });

    test("places an unanchored completed report before the assistant response to its progress update", () => {
      const aggregator = new StreamingMessageAggregator(TEST_CREATED_AT);
      aggregator.loadHistoricalMessages(
        [
          createMuxMessage(
            "progress-1",
            "user",
            formatSubagentReportEnvelope({
              taskId: "task-1",
              agentType: "explore",
              status: "in_progress",
              title: "Progress",
              reportMarkdown: "Still investigating.",
            }),
            { timestamp: 1, historySequence: 1, synthetic: true }
          ),
          createMuxMessage("assistant-1", "assistant", "Final answer", {
            timestamp: 2,
            historySequence: 2,
          }),
          createMuxMessage(
            "report-1",
            "user",
            formatSubagentReportEnvelope({
              taskId: "task-1",
              agentType: "explore",
              status: "completed",
              title: "Investigation complete",
              reportMarkdown: "The child finished successfully.",
            }),
            {
              timestamp: 3,
              historySequence: 3,
              synthetic: true,
              uiVisible: true,
            }
          ),
        ],
        false
      );

      expect(
        aggregator
          .getDisplayedMessages()
          .filter((row) => row.type === "assistant" || row.type === "user")
          .map((row) => `${row.type}:${row.historyId}`)
      ).toEqual(["user:report-1", "assistant:assistant-1"]);
    });

    test("skips another completed report while locating the progress response", () => {
      const aggregator = new StreamingMessageAggregator(TEST_CREATED_AT);
      aggregator.loadHistoricalMessages(
        [
          createMuxMessage(
            "progress-1",
            "user",
            formatSubagentReportEnvelope({
              taskId: "task-1",
              agentType: "explore",
              status: "in_progress",
              title: "Progress",
              reportMarkdown: "Still investigating.",
            }),
            { timestamp: 1, historySequence: 1, synthetic: true }
          ),
          createMuxMessage(
            "report-2",
            "user",
            formatSubagentReportEnvelope({
              taskId: "task-2",
              agentType: "explore",
              status: "completed",
              title: "Other investigation complete",
              reportMarkdown: "Another child finished first.",
            }),
            { timestamp: 2, historySequence: 2, synthetic: true, uiVisible: true }
          ),
          createMuxMessage("assistant-1", "assistant", "Final answer", {
            timestamp: 3,
            historySequence: 3,
          }),
          createMuxMessage(
            "report-1",
            "user",
            formatSubagentReportEnvelope({
              taskId: "task-1",
              agentType: "explore",
              status: "completed",
              title: "Investigation complete",
              reportMarkdown: "The first child finished successfully.",
            }),
            { timestamp: 4, historySequence: 4, synthetic: true, uiVisible: true }
          ),
        ],
        false
      );

      expect(
        aggregator
          .getDisplayedMessages()
          .filter((row) => row.type === "assistant" || row.type === "user")
          .map((row) => `${row.type}:${row.historyId}`)
      ).toEqual(["user:report-2", "user:report-1", "assistant:assistant-1"]);
    });

    test.each([
      {
        label: "reasoning",
        parts: [{ type: "reasoning" as const, text: "Finished reasoning" }],
        expectedType: "reasoning",
      },
      {
        label: "tool",
        parts: [
          {
            type: "dynamic-tool" as const,
            toolCallId: "tool-1",
            toolName: "file_read",
            input: { path: "README.md" },
            state: "output-available" as const,
            output: { success: true },
          },
        ],
        expectedType: "tool",
      },
    ])("repairs a trailing report before a $label-only assistant", ({ parts, expectedType }) => {
      const aggregator = new StreamingMessageAggregator(TEST_CREATED_AT);
      const assistant = createMuxMessage(
        "assistant-1",
        "assistant",
        "",
        { timestamp: 1, historySequence: 1 },
        [...parts]
      );
      const report = createMuxMessage(
        "report-1",
        "user",
        formatSubagentReportEnvelope({
          taskId: "task-1",
          agentType: "explore",
          status: "completed",
          title: "Investigation complete",
          reportMarkdown: "The child finished successfully.",
        }),
        { timestamp: 2, historySequence: 2, synthetic: true, uiVisible: true }
      );

      aggregator.loadHistoricalMessages([assistant, report], false);

      expect(
        aggregator
          .getDisplayedMessages()
          .filter((row) => row.type === "user" || row.type === "reasoning" || row.type === "tool")
          .map((row) => (row.type === "user" ? `user:${row.historyId}` : row.type))
      ).toEqual(["user:report-1", expectedType]);
    });

    test("pairs an old unanchored report with the first response to its progress turn", () => {
      const aggregator = new StreamingMessageAggregator(TEST_CREATED_AT);
      aggregator.loadHistoricalMessages(
        [
          createMuxMessage(
            "progress-1",
            "user",
            formatSubagentReportEnvelope({
              taskId: "task-1",
              agentType: "explore",
              status: "in_progress",
              title: "Progress",
              reportMarkdown: "Still investigating.",
            }),
            { timestamp: 1, historySequence: 1, synthetic: true }
          ),
          createMuxMessage("assistant-progress", "assistant", "I incorporated the update.", {
            timestamp: 2,
            historySequence: 2,
          }),
          createMuxMessage("manual-user", "user", "One more question", {
            timestamp: 3,
            historySequence: 3,
          }),
          createMuxMessage("assistant-manual", "assistant", "Answering the later question.", {
            timestamp: 4,
            historySequence: 4,
          }),
          createMuxMessage(
            "report-1",
            "user",
            formatSubagentReportEnvelope({
              taskId: "task-1",
              agentType: "explore",
              status: "completed",
              title: "Investigation complete",
              reportMarkdown: "The child finished successfully.",
            }),
            {
              timestamp: 5,
              historySequence: 5,
              synthetic: true,
              uiVisible: true,
            }
          ),
        ],
        false
      );

      expect(
        aggregator
          .getDisplayedMessages()
          .filter((row) => row.type === "assistant" || row.type === "user")
          .map((row) => `${row.type}:${row.historyId}`)
      ).toEqual([
        "user:report-1",
        "assistant:assistant-progress",
        "user:manual-user",
        "assistant:assistant-manual",
      ]);
    });

    test("does not repair a trailing report across a context boundary", () => {
      const aggregator = new StreamingMessageAggregator(TEST_CREATED_AT);
      aggregator.loadHistoricalMessages(
        [
          createMuxMessage("assistant-1", "assistant", "Old answer", {
            timestamp: 1,
            historySequence: 1,
          }),
          createMuxMessage("reset-1", "assistant", "", {
            timestamp: 2,
            historySequence: 2,
            contextBoundaryKind: CONTEXT_BOUNDARY_KINDS.RESET,
          }),
          createMuxMessage(
            "report-1",
            "user",
            formatSubagentReportEnvelope({
              taskId: "task-1",
              agentType: "explore",
              status: "completed",
              title: "Investigation complete",
              reportMarkdown: "The child finished successfully.",
            }),
            { timestamp: 3, historySequence: 3, synthetic: true, uiVisible: true }
          ),
        ],
        false
      );

      expect(aggregator.getDisplayedMessages().at(-1)).toMatchObject({
        type: "user",
        historyId: "report-1",
      });
    });

    test("keeps a cross-epoch completion after an unrelated new turn", () => {
      const aggregator = new StreamingMessageAggregator(TEST_CREATED_AT);
      aggregator.loadHistoricalMessages(
        [
          createMuxMessage("reset-1", "assistant", "", {
            timestamp: 1,
            historySequence: 1,
            contextBoundaryKind: CONTEXT_BOUNDARY_KINDS.RESET,
          }),
          createMuxMessage("new-user", "user", "New epoch question", {
            timestamp: 2,
            historySequence: 2,
          }),
          createMuxMessage("new-assistant", "assistant", "New epoch answer", {
            timestamp: 3,
            historySequence: 3,
          }),
          createMuxMessage(
            "report-1",
            "user",
            formatSubagentReportEnvelope({
              taskId: "old-task",
              agentType: "explore",
              status: "completed",
              title: "Old task complete",
              reportMarkdown: "The old task finished after the reset.",
            }),
            { timestamp: 4, historySequence: 4, synthetic: true, uiVisible: true }
          ),
        ],
        false
      );

      expect(
        aggregator
          .getDisplayedMessages()
          .filter((row) => row.type === "assistant" || row.type === "user")
          .map((row) => `${row.type}:${row.historyId}`)
      ).toEqual(["user:new-user", "assistant:new-assistant", "user:report-1"]);
    });

    test("keeps no-progress historical repair stable after later turns", () => {
      const aggregator = new StreamingMessageAggregator(TEST_CREATED_AT);
      aggregator.loadHistoricalMessages(
        [
          createMuxMessage("assistant-1", "assistant", "Original answer", {
            timestamp: 1,
            historySequence: 1,
          }),
          createMuxMessage(
            "report-1",
            "user",
            formatSubagentReportEnvelope({
              taskId: "task-1",
              agentType: "explore",
              status: "completed",
              title: "Investigation complete",
              reportMarkdown: "The child finished successfully.",
            }),
            { timestamp: 2, historySequence: 2, synthetic: true, uiVisible: true }
          ),
          createMuxMessage("manual-user", "user", "A later question", {
            timestamp: 3,
            historySequence: 3,
          }),
          createMuxMessage("assistant-2", "assistant", "A later answer", {
            timestamp: 4,
            historySequence: 4,
          }),
        ],
        false
      );

      expect(
        aggregator
          .getDisplayedMessages()
          .filter((row) => row.type === "assistant" || row.type === "user")
          .map((row) => `${row.type}:${row.historyId}`)
      ).toEqual([
        "user:report-1",
        "assistant:assistant-1",
        "user:manual-user",
        "assistant:assistant-2",
      ]);
    });

    test("repairs a completed report whose persisted anchor target is missing", () => {
      const aggregator = new StreamingMessageAggregator(TEST_CREATED_AT);
      aggregator.loadHistoricalMessages(
        [
          createMuxMessage(
            "progress-1",
            "user",
            formatSubagentReportEnvelope({
              taskId: "task-1",
              agentType: "explore",
              status: "in_progress",
              title: "Progress",
              reportMarkdown: "Still investigating.",
            }),
            { timestamp: 1, historySequence: 1, synthetic: true }
          ),
          createMuxMessage("assistant-1", "assistant", "Final answer", {
            timestamp: 2,
            historySequence: 2,
          }),
          createMuxMessage(
            "report-1",
            "user",
            formatSubagentReportEnvelope({
              taskId: "task-1",
              agentType: "explore",
              status: "completed",
              title: "Investigation complete",
              reportMarkdown: "The child finished successfully.",
            }),
            {
              timestamp: 3,
              historySequence: 3,
              synthetic: true,
              uiVisible: true,
              transcriptAnchor: {
                messageId: "deleted-assistant",
                historySequence: 2,
                textLength: 0,
                reasoningLength: 0,
                partIndex: 0,
              },
            }
          ),
        ],
        false
      );

      expect(
        aggregator
          .getDisplayedMessages()
          .filter((row) => row.type === "assistant" || row.type === "user")
          .map((row) => `${row.type}:${row.historyId}`)
      ).toEqual(["user:report-1", "assistant:assistant-1"]);
    });

    test("keeps a tail-anchored report at the active stream position", () => {
      const aggregator = new StreamingMessageAggregator(TEST_CREATED_AT);
      aggregator.loadHistoricalMessages(
        Array.from({ length: 70 }, (_, index) =>
          createMuxMessage(`older-${index}`, "assistant", `older response ${index}`, {
            historySequence: index + 1,
            timestamp: index + 1,
          })
        ),
        false
      );
      aggregator.handleStreamStart({
        type: "stream-start",
        workspaceId: "workspace-1",
        messageId: "assistant-1",
        historySequence: 71,
        model: "openai:gpt-5",
        startTime: 71,
      });
      aggregator.handleStreamDelta({
        type: "stream-delta",
        workspaceId: "workspace-1",
        messageId: "assistant-1",
        delta: "current answer",
        tokens: 1,
        timestamp: 71,
      });
      aggregator.handleMessage({
        ...createMuxMessage(
          "report-1",
          "user",
          formatSubagentReportEnvelope({
            taskId: "task-1",
            agentType: "explore",
            status: "completed",
            title: "Investigation complete",
            reportMarkdown: "The child finished successfully.",
          }),
          {
            timestamp: 72,
            historySequence: 72,
            synthetic: true,
            uiVisible: true,
            transcriptAnchor: {
              messageId: "assistant-1",
              historySequence: 71,
              textLength: "current answer".length,
              reasoningLength: 0,
              partIndex: 1,
            },
          }
        ),
        type: "message",
      });

      const assistantRows = aggregator
        .getDisplayedMessages()
        .filter(
          (row): row is Extract<DisplayedMessage, { type: "assistant" }> =>
            row.type === "assistant" && row.historyId === "assistant-1"
        );
      expect(aggregator.getDisplayedMessages().some((row) => row.type === "history-hidden")).toBe(
        true
      );
      expect(assistantRows).toHaveLength(1);
      expect(assistantRows[0]?.isLastPartOfMessage).toBe(false);
      expect(
        aggregator
          .getDisplayedMessages()
          .filter(
            (row): row is Extract<DisplayedMessage, { type: "assistant" | "user" }> =>
              (row.type === "assistant" && row.historyId === "assistant-1") ||
              (row.type === "user" && row.historyId === "report-1")
          )
          .map((row) => `${row.type}:${row.historyId}`)
      ).toEqual(["assistant:assistant-1", "user:report-1"]);
    });

    test("places a tail-anchored report before final assistant text while keeping terminal chrome", () => {
      const aggregator = new StreamingMessageAggregator(TEST_CREATED_AT);
      aggregator.loadHistoricalMessages(
        [
          {
            ...createMuxMessage("assistant-1", "assistant", "", {
              timestamp: 1,
              historySequence: 1,
              model: "openai:gpt-5",
            }),
            parts: [{ type: "text", text: "final answer" }],
          },
          createMuxMessage(
            "report-1",
            "user",
            formatSubagentReportEnvelope({
              taskId: "task-1",
              agentType: "explore",
              status: "completed",
              title: "Investigation complete",
              reportMarkdown: "The child finished successfully.",
            }),
            {
              timestamp: 2,
              historySequence: 2,
              synthetic: true,
              uiVisible: true,
              transcriptAnchor: {
                messageId: "assistant-1",
                historySequence: 1,
                textLength: "final answer".length,
                reasoningLength: 0,
                partIndex: 1,
              },
            }
          ),
        ],
        false
      );

      expect(
        aggregator
          .getDisplayedMessages()
          .filter((row) => row.type === "assistant" || row.type === "user")
          .map((row) => `${row.type}:${row.historyId}`)
      ).toEqual(["user:report-1", "assistant:assistant-1"]);

      const assistantRows = aggregator
        .getDisplayedMessages()
        .filter((row) => row.type === "assistant");
      expect(assistantRows).toHaveLength(1);
      expect(assistantRows[0]?.isLastPartOfMessage).toBe(true);
    });

    test("renders terminal stream errors once when a report splits an assistant", () => {
      const aggregator = new StreamingMessageAggregator(TEST_CREATED_AT);
      aggregator.loadHistoricalMessages(
        [
          {
            ...createMuxMessage("assistant-1", "assistant", "", {
              timestamp: 1,
              historySequence: 1,
              error: "Provider failed",
              errorType: "api",
            }),
            parts: [{ type: "text", text: "before after" }],
          },
          createMuxMessage(
            "report-1",
            "user",
            formatSubagentReportEnvelope({
              taskId: "task-1",
              agentType: "explore",
              status: "completed",
              title: "Investigation complete",
              reportMarkdown: "The child finished successfully.",
            }),
            {
              timestamp: 2,
              historySequence: 2,
              synthetic: true,
              uiVisible: true,
              transcriptAnchor: {
                messageId: "assistant-1",
                historySequence: 1,
                textLength: "before".length,
                reasoningLength: 0,
                partIndex: 1,
              },
            }
          ),
        ],
        false
      );

      expect(
        aggregator.getDisplayedMessages().filter((row) => row.type === "stream-error")
      ).toHaveLength(1);
    });

    test("keeps hidden completed subagent reports in the retry lifecycle", () => {
      withDebugLlmRequestEnabled(() => {
        const aggregator = new StreamingMessageAggregator(TEST_CREATED_AT);
        aggregator.loadHistoricalMessages(
          [
            createMuxMessage(
              "report-1",
              "user",
              formatSubagentReportEnvelope({
                taskId: "task-1",
                agentType: "explore",
                status: "completed",
                title: "Investigation complete",
                reportMarkdown: "The child finished successfully.",
              }),
              {
                timestamp: 1,
                historySequence: 1,
                synthetic: true,
              }
            ),
          ],
          false
        );

        const displayedMessages = aggregator.getDisplayedMessages();
        expect(displayedMessages.at(-1)).toMatchObject({
          type: "user",
          id: "report-1",
          isSynthetic: true,
          isUiVisible: undefined,
        });
        expect(getInterruptionContext(displayedMessages).hasInterruptedStream).toBe(true);
      });
    });

    test("renders persisted workflow slash invocation before workflow card", () => {
      const aggregator = new StreamingMessageAggregator(TEST_CREATED_AT);
      const command = createMuxMessage("workflow-command", "user", "/deep-research mux", {
        timestamp: 1,
        historySequence: 1,
        muxMetadata: {
          type: "workflow-trigger-display",
          rawCommand: "/deep-research mux",
          commandPrefix: "/deep-research",
          runId: "wfr_123",
        },
      });
      const card = buildWorkflowRunCardMessage(
        { scriptPath: "skill://deep-research/workflow.js", args: { input: "mux" } },
        { runId: "wfr_123", status: "running", result: null },
        2
      );
      card.metadata = {
        timestamp: 2,
        historySequence: 2,
        synthetic: true,
        uiVisible: true,
        muxMetadata: { type: "workflow-run-card-display", runId: "wfr_123" },
      };
      const hiddenWorkflowResult = createMuxMessage(
        "workflow-result",
        "user",
        '/deep-research mux\n\n<mux_workflow_result>{"reportMarkdown":"hidden"}</mux_workflow_result>',
        {
          timestamp: 3,
          historySequence: 3,
          muxMetadata: {
            type: "workflow-result",
            rawCommand: "/deep-research mux",
            commandPrefix: "/deep-research",
            runId: "wfr_123",
          },
        }
      );
      const assistant = createMuxMessage("assistant-1", "assistant", "Done", {
        timestamp: 4,
        historySequence: 4,
      });

      aggregator.loadHistoricalMessages([command, card, hiddenWorkflowResult, assistant], false);

      const displayed = aggregator.getDisplayedMessages();
      expect(displayed.map((message) => message.type)).toEqual(["user", "tool", "assistant"]);
      expect(displayed[0]).toMatchObject({
        type: "user",
        content: "/deep-research mux",
        commandPrefix: "/deep-research",
      });
      if (displayed[0]?.type !== "user") {
        throw new Error("Expected workflow command to render as a user message");
      }
      expect(displayed[0].content).not.toContain("mux_workflow_result");
      expect(displayed.some((message) => message.id === "workflow-result")).toBe(false);
      expect(displayed[1]).toMatchObject({
        type: "tool",
        toolName: "workflow_run",
        args: {
          script_path: "skill://deep-research/workflow.js",
          args: { input: "mux" },
          run_in_background: true,
        },
        result: { status: "running", runId: "wfr_123", result: null },
      });
    });

    test("should strip legacy goal-cleared label from displayed summaries", () => {
      const aggregator = new StreamingMessageAggregator(TEST_CREATED_AT);
      const legacySummary = createMuxMessage(
        "goal-cleared-1",
        "assistant",
        'Goal cleared: "Ship goal primitive" — spent $0.00 over 0 turns (status: active)',
        {
          timestamp: 1,
          historySequence: 1,
          synthetic: true,
          uiVisible: true,
          muxMetadata: { type: "goal-cleared-summary" },
        }
      );

      aggregator.loadHistoricalMessages([legacySummary], false);

      const displayed = aggregator.getDisplayedMessages();
      const assistantMessages = displayed.filter((m) => m.type === "assistant");
      expect(assistantMessages[0]?.content).toBe(
        '"Ship goal primitive" — spent $0.00 over 0 turns (status: active)'
      );
    });

    test("should preserve already-concise goal-cleared summaries", () => {
      const aggregator = new StreamingMessageAggregator(TEST_CREATED_AT);
      const summary = createMuxMessage(
        "goal-cleared-2",
        "assistant",
        '"Ship goal primitive" — spent $0.00 over 0 turns (status: active)',
        {
          timestamp: 1,
          historySequence: 1,
          synthetic: true,
          uiVisible: true,
          muxMetadata: { type: "goal-cleared-summary" },
        }
      );

      aggregator.loadHistoricalMessages([summary], false);

      const displayed = aggregator.getDisplayedMessages();
      const assistantMessages = displayed.filter((m) => m.type === "assistant");
      expect(assistantMessages[0]?.content).toBe(
        '"Ship goal primitive" — spent $0.00 over 0 turns (status: active)'
      );
    });

    test("should show synthetic messages when debugLlmRequest is enabled", () => {
      withDebugLlmRequestEnabled(() => {
        const aggregator = new StreamingMessageAggregator(TEST_CREATED_AT);

        const synthetic = createMuxMessage("s1", "user", "synthetic", {
          timestamp: 1,
          historySequence: 1,
          synthetic: true,
        });
        const user = createMuxMessage("u1", "user", "hello", {
          timestamp: 2,
          historySequence: 2,
        });

        aggregator.loadHistoricalMessages([synthetic, user], false);

        const displayed = aggregator.getDisplayedMessages();
        const userMessages = displayed.filter((m) => m.type === "user");

        expect(userMessages).toHaveLength(2);
        expect(userMessages[0].content).toBe("synthetic");
        expect(userMessages[0].isSynthetic).toBe(true);
        expect(userMessages[1].content).toBe("hello");
        expect(userMessages[1].isSynthetic).toBeUndefined();
      });
    });

    test("should disable displayed message cap when showAllMessages is enabled", () => {
      // Test smart truncation: user messages are always kept, while older assistant/tool/
      // reasoning rows can be filtered behind a history-hidden marker.
      // Create a mix of message types: user messages with tool-heavy assistant responses.
      const manyMessages: Parameters<
        typeof StreamingMessageAggregator.prototype.loadHistoricalMessages
      >[0] = [];
      for (let i = 0; i < 100; i++) {
        const baseSequence = i * 3;
        // User message (always kept)
        manyMessages.push(
          createMuxMessage(`u${i}`, "user", `msg-${i}`, {
            timestamp: baseSequence,
            historySequence: baseSequence,
          })
        );
        // Assistant message that only contains reasoning + tool calls (omitted in old messages)
        manyMessages.push({
          id: `tool-msg-${i}`,
          role: "assistant" as const,
          parts: [
            { type: "reasoning" as const, text: `thinking-${i}` },
            {
              type: "dynamic-tool" as const,
              toolCallId: `tool${i}`,
              toolName: "bash",
              state: "output-available" as const,
              input: { script: "echo test" },
              output: { success: true, output: "test", exitCode: 0 },
            },
          ],
          metadata: {
            historySequence: baseSequence + 1,
            timestamp: baseSequence + 1,
            model: "claude-3-5-sonnet-20241022",
          },
        });
        // Assistant response message (always kept)
        manyMessages.push(
          createMuxMessage(`a${i}`, "assistant", `response-${i}`, {
            historySequence: baseSequence + 2,
            timestamp: baseSequence + 2,
            model: "claude-3-5-sonnet-20241022",
          })
        );
      }

      const aggregator = new StreamingMessageAggregator(TEST_CREATED_AT);
      aggregator.loadHistoricalMessages(manyMessages, false);

      // Each pair produces 4 DisplayedMessages: user + reasoning + tool + assistant
      // Total: 100 user + 100 assistant + 100 tool + 100 reasoning = 400 DisplayedMessages
      // With cap at 64, the first 336 are candidates for filtering.
      // In those 336: user messages are kept, while assistant/tool/reasoning may be omitted.
      const capped = aggregator.getDisplayedMessages();

      const expectedHiddenCount = 252;
      const hiddenMessages = capped.filter(
        (msg): msg is Extract<DisplayedMessage, { type: "history-hidden" }> => {
          return msg.type === "history-hidden";
        }
      );
      expect(hiddenMessages).toHaveLength(MAX_HISTORY_HIDDEN_SEGMENTS);
      expect(hiddenMessages.every((msg) => msg.hiddenCount > 0)).toBe(true);
      expect(hiddenMessages.reduce((sum, msg) => sum + msg.hiddenCount, 0)).toBe(
        expectedHiddenCount
      );

      const firstHiddenIndex = capped.findIndex((msg) => msg.type === "history-hidden");
      expect(firstHiddenIndex).toBeGreaterThan(0);
      expect(firstHiddenIndex).toBeLessThan(capped.length - 1);
      expect(capped[firstHiddenIndex - 1]?.type).toBe("user");
      expect(capped[firstHiddenIndex + 1]?.type).toBe("user");

      // User prompts remain fully visible; older assistant rows can be omitted.
      const userMessages = capped.filter((m) => m.type === "user");
      const assistantMessages = capped.filter((m) => m.type === "assistant");
      expect(userMessages).toHaveLength(100);
      expect(assistantMessages.length).toBeLessThan(100);
      expect(assistantMessages.length).toBeGreaterThan(0);

      // A Timeline reveal may pin one old row, but must not disable the transcript cap.
      aggregator.setTranscriptRevealTarget({ messageId: "a0" });
      const withRevealTarget = aggregator.getDisplayedMessages();
      expect(
        withRevealTarget.some((message) => "historyId" in message && message.historyId === "a0")
      ).toBe(true);
      expect(withRevealTarget.some((message) => message.type === "history-hidden")).toBe(true);
      expect(withRevealTarget.length).toBeLessThan(400);

      // Enable showAllMessages to see full history
      aggregator.setShowAllMessages(true);

      const displayed = aggregator.getDisplayedMessages();
      // Now all 400 messages should be visible (100 user + 100 assistant + 100 tool + 100 reasoning)
      expect(displayed).toHaveLength(400);
      expect(displayed.some((m) => m.type === "history-hidden")).toBe(false);
    });

    test("should cap history-hidden markers for alternating user/assistant history", () => {
      // Alternating user/assistant history creates many tiny omission runs.
      // We preserve locality for recent runs while capping marker rows to keep DOM size bounded.
      const manyMessages: Parameters<
        typeof StreamingMessageAggregator.prototype.loadHistoricalMessages
      >[0] = [];

      for (let i = 0; i < 200; i++) {
        const baseSequence = i * 2;
        manyMessages.push(
          createMuxMessage(`u${i}`, "user", `msg-${i}`, {
            timestamp: baseSequence,
            historySequence: baseSequence,
          })
        );
        manyMessages.push(
          createMuxMessage(`a${i}`, "assistant", `response-${i}`, {
            historySequence: baseSequence + 1,
            timestamp: baseSequence + 1,
            model: "claude-3-5-sonnet-20241022",
          })
        );
      }

      const aggregator = new StreamingMessageAggregator(TEST_CREATED_AT);
      aggregator.loadHistoricalMessages(manyMessages, false);

      const displayed = aggregator.getDisplayedMessages();
      const hiddenMarkers = displayed.filter(
        (msg): msg is Extract<DisplayedMessage, { type: "history-hidden" }> => {
          return msg.type === "history-hidden";
        }
      );

      expect(hiddenMarkers).toHaveLength(MAX_HISTORY_HIDDEN_SEGMENTS);
      expect(hiddenMarkers.reduce((sum, marker) => sum + marker.hiddenCount, 0)).toBe(168);

      const hiddenIndices = displayed
        .map((msg, index) => (msg.type === "history-hidden" ? index : -1))
        .filter((index) => index !== -1);
      for (const hiddenIndex of hiddenIndices) {
        expect(hiddenIndex).toBeGreaterThan(0);
        expect(hiddenIndex).toBeLessThan(displayed.length - 1);
        expect(displayed[hiddenIndex - 1]?.type).toBe("user");
        expect(displayed[hiddenIndex + 1]?.type).toBe("user");
      }

      const userMessages = displayed.filter(
        (msg): msg is Extract<DisplayedMessage, { type: "user" }> => {
          return msg.type === "user";
        }
      );
      expect(userMessages).toHaveLength(200);

      // Rendered rows stay well below full history size because hidden markers are capped.
      expect(displayed.length).toBeLessThan(260);
    });

    test("should not show history-hidden when messages are below truncation threshold", () => {
      const aggregator = new StreamingMessageAggregator(TEST_CREATED_AT);
      aggregator.loadHistoricalMessages(
        [
          createMuxMessage("u1", "user", "first", { historySequence: 1, timestamp: 1 }),
          createMuxMessage("u2", "user", "second", { historySequence: 2, timestamp: 2 }),
          createMuxMessage("u3", "user", "third", { historySequence: 3, timestamp: 3 }),
        ],
        false
      );

      const displayed = aggregator.getDisplayedMessages();
      expect(displayed).toHaveLength(3);
      expect(displayed.some((msg) => msg.type === "history-hidden")).toBe(false);
    });

    test("should not show history-hidden when only user messages exceed cap", () => {
      // When all messages are user rows (always-keep type), no filtering occurs
      const manyMessages = Array.from({ length: 200 }, (_, i) =>
        createMuxMessage(`u${i}`, "user", `msg-${i}`, {
          timestamp: i,
          historySequence: i,
        })
      );

      const aggregator = new StreamingMessageAggregator(TEST_CREATED_AT);
      aggregator.loadHistoricalMessages(manyMessages, false);

      const displayed = aggregator.getDisplayedMessages();
      // All 200 user messages are kept (user type is always preserved)
      expect(displayed).toHaveLength(200);
      expect(displayed.some((m) => m.type === "history-hidden")).toBe(false);
    });
  });

  describe("agent skill snapshot cache", () => {
    test("should invalidate cached hover snapshot when frontmatter changes", () => {
      const aggregator = new StreamingMessageAggregator(TEST_CREATED_AT);

      const snapshotText = "<agent-skill>\nBODY\n</agent-skill>";

      const snapshot1 = createMuxMessage("s1", "assistant", snapshotText, {
        timestamp: 1,
        historySequence: 1,
        synthetic: true,
        agentSkillSnapshot: {
          skillName: "test-skill",
          scope: "project",
          sha256: "sha-1",
          frontmatterYaml: "description: v1",
        },
      });

      const invocation = createMuxMessage("u1", "user", "/test-skill", {
        timestamp: 2,
        historySequence: 2,
        muxMetadata: {
          type: "agent-skill",
          rawCommand: "/test-skill",
          skillName: "test-skill",
          scope: "project",
        },
      });

      aggregator.addMessage(snapshot1);
      aggregator.addMessage(invocation);

      const displayed1 = aggregator.getDisplayedMessages();
      const user1 = displayed1.find((m) => m.type === "user" && m.id === "u1");
      expect(user1).toBeDefined();

      if (user1?.type === "user") {
        expect(user1.agentSkill?.snapshot?.frontmatterYaml).toBe("description: v1");
        expect(user1.agentSkill?.snapshot?.body).toBe("BODY");
      }

      // Update the snapshot frontmatter without changing body or sha256.
      const snapshot2 = createMuxMessage("s1", "assistant", snapshotText, {
        timestamp: 1,
        historySequence: 1,
        synthetic: true,
        agentSkillSnapshot: {
          skillName: "test-skill",
          scope: "project",
          sha256: "sha-1",
          frontmatterYaml: "description: v2",
        },
      });

      aggregator.addMessage(snapshot2);

      const displayed2 = aggregator.getDisplayedMessages();
      const user2 = displayed2.find((m) => m.type === "user" && m.id === "u1");
      expect(user2).toBeDefined();

      if (user2?.type === "user") {
        expect(user2.agentSkill?.snapshot?.frontmatterYaml).toBe("description: v2");
        expect(user2.agentSkill?.snapshot?.body).toBe("BODY");
      }

      // Cache should not reuse the prior DisplayedMessage when snapshot metadata changes.
      expect(user2).not.toBe(user1);
    });
  });

  describe("todo lifecycle", () => {
    test("should preserve incomplete todos when stream ends", () => {
      const aggregator = createTestAggregator();
      startTestStream(aggregator);
      writeTodos(aggregator, [
        { content: "Do task 1", status: "in_progress" },
        { content: "Do task 2", status: "pending" },
      ]);

      expect(aggregator.getCurrentTodos()).toHaveLength(2);
      expect(aggregator.getCurrentTodos()[0].content).toBe("Do task 1");

      endTestStream(aggregator);
      expect(aggregator.getCurrentTodos()).toHaveLength(2);
    });

    test("marks in-progress todos completed when propose_plan succeeds", () => {
      const aggregator = createTestAggregator();
      startTestStream(aggregator);
      writeTodos(aggregator, [
        { content: "Inspected relevant files", status: "completed" },
        { content: "Writing the plan", status: "in_progress" },
        { content: "Wait for approval", status: "pending" },
      ]);

      runTestTool(aggregator, {
        toolCallId: "tool2",
        toolName: "propose_plan",
        args: {},
        tokens: 1,
        result: {
          success: true,
          planPath: "/tmp/plan.md",
          message: "Plan proposed. Waiting for user approval.",
        },
      });

      expect(aggregator.getCurrentTodos()).toEqual([
        { content: "Inspected relevant files", status: "completed" },
        { content: "Writing the plan", status: "completed" },
        { content: "Wait for approval", status: "pending" },
      ]);
    });

    test("should clear fully completed todos when the final stream ends", () => {
      const aggregator = createTestAggregator();
      startTestStream(aggregator);
      writeTodos(aggregator, [
        { content: "Do task 1", status: "completed" },
        { content: "Do task 2", status: "completed" },
      ]);

      expect(aggregator.getCurrentTodos()).toHaveLength(2);
      endTestStream(aggregator);
      expect(aggregator.getCurrentTodos()).toHaveLength(0);
    });

    test("should preserve todos when stream aborts", () => {
      const aggregator = createTestAggregator();
      startTestStream(aggregator);
      writeTodos(aggregator, [{ content: "Task", status: "in_progress" }]);

      expect(aggregator.getCurrentTodos()).toHaveLength(1);
      aggregator.handleStreamAbort({
        type: "stream-abort",
        workspaceId: TEST_WORKSPACE_ID,
        messageId: "msg1",
        metadata: {},
      });
      expect(aggregator.getCurrentTodos()).toHaveLength(1);
    });

    test("should keep completed todos on reload only while reconnecting to an active stream", () => {
      const historicalMessage = historicalTodoMessage("msg1", [
        { content: "Historical task 1", status: "completed" },
        { content: "Historical task 2", status: "completed" },
      ]);

      const aggregator = createTestAggregator();
      aggregator.loadHistoricalMessages([historicalMessage], true);
      expect(aggregator.getCurrentTodos()).toHaveLength(2);
      expect(aggregator.getCurrentTodos()[0].content).toBe("Historical task 1");

      const aggregator2 = createTestAggregator();
      aggregator2.loadHistoricalMessages([historicalMessage], false);
      expect(aggregator2.getCurrentTodos()).toHaveLength(0);
    });

    test("preserves completed todos on idle reload when they came from a partial assistant message", () => {
      const aggregator = createTestAggregator();
      aggregator.loadHistoricalMessages(
        [
          historicalTodoMessage(
            "msg-partial",
            [
              { content: "Recovered task 1", status: "completed" },
              { content: "Recovered task 2", status: "completed" },
            ],
            { partial: true, historySequence: 11 }
          ),
        ],
        false
      );

      expect(aggregator.getCurrentTodos()).toHaveLength(2);
    });

    test("does not clear completed todos when appending older history without derived-state replay", () => {
      const aggregator = createTestAggregator();
      aggregator.loadHistoricalMessages(
        [
          historicalTodoMessage(
            "msg1",
            [
              { content: "Historical task 1", status: "completed" },
              { content: "Historical task 2", status: "completed" },
            ],
            { historySequence: 10 }
          ),
        ],
        true
      );
      expect(aggregator.getCurrentTodos()).toHaveLength(2);

      aggregator.loadHistoricalMessages(
        [
          createMuxMessage("older-user", "user", "Older history", {
            historySequence: 1,
            timestamp: 1,
          }),
        ],
        false,
        { mode: "append", skipDerivedState: true }
      );
      expect(aggregator.getCurrentTodos()).toHaveLength(2);
    });

    test("does not clear completed todos during replay when an active stream is already tracked", () => {
      const aggregator = createTestAggregator();
      startTestStream(aggregator, { messageId: "msg-live", historySequence: 20 });
      writeTodos(
        aggregator,
        [
          { content: "Live task 1", status: "completed" },
          { content: "Live task 2", status: "completed" },
        ],
        { messageId: "msg-live", toolCallId: "tool-live" }
      );
      expect(aggregator.getCurrentTodos()).toHaveLength(2);

      aggregator.loadHistoricalMessages(
        [
          createMuxMessage("replayed-user", "user", "Replay window", {
            historySequence: 21,
            timestamp: 21,
          }),
        ],
        false,
        { mode: "append" }
      );
      expect(aggregator.getCurrentTodos()).toHaveLength(2);
    });

    test("should reconstruct agentStatus and incomplete todos when no active stream", () => {
      const aggregator = createTestAggregator();
      const historicalMessage = historicalTodoMessage("msg1", [
        { content: "Task 1", status: "in_progress" },
      ]);
      historicalMessage.parts.push({
        type: "dynamic-tool",
        toolCallId: "tool2",
        toolName: "status_set",
        state: "output-available",
        input: { emoji: "🔧", message: "Working on it" },
        output: { success: true, emoji: "🔧", message: "Working on it" },
      });

      aggregator.loadHistoricalMessages([historicalMessage], false);

      expect(aggregator.getAgentStatus()).toEqual({ emoji: "🔧", message: "Working on it" });
      expect(aggregator.getCurrentTodos()).toHaveLength(1);
    });

    test("should preserve todos when new user message arrives during active stream", () => {
      const aggregator = createTestAggregator();
      startTestStream(aggregator);
      writeTodos(aggregator, [{ content: "Task", status: "completed" }]);

      expect(aggregator.getCurrentTodos()).toHaveLength(1);
      aggregator.handleMessage({
        type: "message",
        id: "msg2",
        role: "user",
        parts: [{ type: "text", text: "Hello" }],
        metadata: { historySequence: 2, timestamp: Date.now() },
      });
      expect(aggregator.getCurrentTodos()).toHaveLength(1);
    });
  });

  describe("compaction boundary rows", () => {
    test("inserts a boundary row before compaction summary messages", () => {
      const aggregator = new StreamingMessageAggregator(TEST_CREATED_AT);

      const before = createMuxMessage("user-before", "user", "Before compaction", {
        historySequence: 1,
        timestamp: 1,
      });
      const summary = createMuxMessage("summary-1", "assistant", "Compacted summary", {
        historySequence: 2,
        timestamp: 2,
        compacted: "user",
        compactionBoundary: true,
        compactionEpoch: 3,
        muxMetadata: { type: "compaction-summary" },
      });
      const after = createMuxMessage("user-after", "user", "After compaction", {
        historySequence: 3,
        timestamp: 3,
      });

      aggregator.loadHistoricalMessages([before, summary, after], false);

      const displayed = aggregator.getDisplayedMessages();
      expect(displayed.map((message) => message.type)).toEqual([
        "user",
        "compaction-boundary",
        "assistant",
        "user",
      ]);

      const boundary = displayed[1];
      expect(boundary?.type).toBe("compaction-boundary");

      if (boundary?.type === "compaction-boundary") {
        expect(boundary.position).toBe("start");
        expect(boundary.compactionEpoch).toBe(3);
        expect(boundary.historySequence).toBe(2);
      }
    });

    test("omits malformed compaction epoch values instead of crashing transcript rendering", () => {
      const aggregator = new StreamingMessageAggregator(TEST_CREATED_AT);

      const before = createMuxMessage("user-before", "user", "Before compaction", {
        historySequence: 1,
        timestamp: 1,
      });
      const summaryWithMalformedEpoch = createMuxMessage(
        "summary-malformed",
        "assistant",
        "Compacted summary",
        {
          historySequence: 2,
          timestamp: 2,
          compacted: "user",
          compactionBoundary: true,
          compactionEpoch: 0,
          muxMetadata: { type: "compaction-summary" },
        }
      );
      const after = createMuxMessage("user-after", "user", "After compaction", {
        historySequence: 3,
        timestamp: 3,
      });

      aggregator.loadHistoricalMessages([before, summaryWithMalformedEpoch, after], false);

      const displayed = aggregator.getDisplayedMessages();
      const boundaries = displayed.filter((message) => message.type === "compaction-boundary");

      expect(boundaries).toHaveLength(1);

      const boundary = boundaries[0];
      if (boundary?.type !== "compaction-boundary") {
        throw new Error("Expected compaction boundary message");
      }
      expect(boundary.compactionEpoch).toBeUndefined();
      expect(boundary.historySequence).toBe(2);
    });
  });

  describe("live compaction boundary pruning", () => {
    // handleMessage expects ChatXumMessage (type: "message"), matching how the
    // backend emits events via emitChatEvent({ ...message, type: "message" }).
    const asChatMessage = (msg: ReturnType<typeof createMuxMessage>) => ({
      ...msg,
      type: "message" as const,
    });

    test("prunes older messages on first compaction and keeps the new boundary", () => {
      const aggregator = new StreamingMessageAggregator(TEST_CREATED_AT);

      // Simulate messages accumulated during a live session (no prior compaction)
      const msg1 = asChatMessage(
        createMuxMessage("user-1", "user", "First message", {
          historySequence: 0,
          timestamp: 1,
        })
      );
      const msg2 = asChatMessage(
        createMuxMessage("assistant-1", "assistant", "Response", {
          historySequence: 1,
          timestamp: 2,
        })
      );

      aggregator.handleMessage(msg1);
      aggregator.handleMessage(msg2);

      const summary = asChatMessage(
        createMuxMessage("summary-1", "assistant", "Compacted summary", {
          historySequence: 2,
          compacted: "user",
          compactionBoundary: true,
          compactionEpoch: 1,
          muxMetadata: { type: "compaction-summary" },
        })
      );
      aggregator.handleMessage(summary);

      // Existing messages with sequence < incoming boundary (2) are pruned.
      // The incoming boundary itself is appended after pruning and remains visible.
      const remaining = aggregator.getAllMessages();
      expect(remaining).toHaveLength(1);
      expect(remaining.map((m) => m.id)).toEqual(["summary-1"]);
    });

    test("keeps only the latest boundary epoch start on subsequent compactions", () => {
      const aggregator = new StreamingMessageAggregator(TEST_CREATED_AT);

      // Epoch 0 messages (before any compaction)
      const epoch0Msg = asChatMessage(
        createMuxMessage("epoch0-user", "user", "Old message", {
          historySequence: 0,
          timestamp: 1,
        })
      );
      aggregator.handleMessage(epoch0Msg);

      // First compaction boundary (epoch 1)
      const boundary1 = asChatMessage(
        createMuxMessage("boundary-1", "assistant", "Summary epoch 1", {
          historySequence: 1,
          compacted: "user",
          compactionBoundary: true,
          compactionEpoch: 1,
          muxMetadata: { type: "compaction-summary" },
        })
      );
      aggregator.handleMessage(boundary1);

      // Epoch 1 messages
      const epoch1Msg = asChatMessage(
        createMuxMessage("epoch1-user", "user", "Message in epoch 1", {
          historySequence: 2,
          timestamp: 3,
        })
      );
      aggregator.handleMessage(epoch1Msg);

      // First boundary already pruned epoch 0; boundary-1 + epoch1-user remain.
      expect(aggregator.getAllMessages()).toHaveLength(2);

      // Second compaction boundary (epoch 2): existing messages with sequence < 3
      // are pruned, then boundary-2 is appended.
      const boundary2 = asChatMessage(
        createMuxMessage("boundary-2", "assistant", "Summary epoch 2", {
          historySequence: 3,
          compacted: "user",
          compactionBoundary: true,
          compactionEpoch: 2,
          muxMetadata: { type: "compaction-summary" },
        })
      );
      aggregator.handleMessage(boundary2);

      const remaining = aggregator.getAllMessages();
      expect(remaining).toHaveLength(1);
      expect(remaining.map((m) => m.id)).toEqual(["boundary-2"]);
    });

    test("keeps returning the stored server cursor when a live compaction boundary arrives", () => {
      const aggregator = new StreamingMessageAggregator(TEST_CREATED_AT);

      // Simulate initial replay window starting at historySequence 40.
      aggregator.loadHistoricalMessages(
        [
          createMuxMessage("history-40", "user", "Historical user", {
            historySequence: 40,
            timestamp: 40,
          }),
          createMuxMessage("history-41", "assistant", "Historical assistant", {
            historySequence: 41,
            timestamp: 41,
          }),
        ],
        false,
        { mode: "replace" }
      );

      const serverCursor = {
        messageId: "history-41",
        historySequence: 41,
        oldestHistorySequence: 40,
        priorHistoryFingerprint: "cafe1234",
      };
      aggregator.setServerHistoryCursor(serverCursor);

      const beforeCompactionCursor = aggregator.getOnChatCursor();
      expect(beforeCompactionCursor?.history).toEqual(serverCursor);

      const boundary = asChatMessage(
        createMuxMessage("boundary-60", "assistant", "Summary epoch 60", {
          historySequence: 60,
          compacted: "user",
          compactionBoundary: true,
          compactionEpoch: 60,
          muxMetadata: { type: "compaction-summary" },
        })
      );
      aggregator.handleMessage(boundary);

      // The cursor is reused verbatim: a live compaction makes it stale, and the
      // server-side anchor validation downgrades the next reconnect to a (small)
      // full replay of the fresh epoch instead of the client guessing a new cursor.
      const afterCompactionCursor = aggregator.getOnChatCursor();
      expect(afterCompactionCursor?.history).toEqual(serverCursor);
    });

    test("keeps visible history when a live reset boundary arrives", () => {
      const aggregator = new StreamingMessageAggregator(TEST_CREATED_AT);

      const user = asChatMessage(
        createMuxMessage("user-1", "user", "First message", { historySequence: 0 })
      );
      const assistant = asChatMessage(
        createMuxMessage("assistant-1", "assistant", "Normal response", { historySequence: 1 })
      );
      const resetBoundary = asChatMessage(
        createMuxMessage("reset-1", "assistant", "", {
          historySequence: 2,
          contextBoundaryKind: CONTEXT_BOUNDARY_KINDS.RESET,
        })
      );

      aggregator.handleMessage(user);
      aggregator.handleMessage(assistant);
      aggregator.handleMessage(resetBoundary);

      expect(aggregator.getAllMessages().map((message) => message.id)).toEqual([
        "user-1",
        "assistant-1",
        "reset-1",
      ]);

      const displayed = aggregator.getDisplayedMessages();
      expect(displayed.map((message) => message.type)).toEqual([
        "user",
        "assistant",
        "compaction-boundary",
      ]);

      const resetDivider = displayed[2];
      if (resetDivider?.type !== "compaction-boundary") {
        throw new Error("Expected reset boundary divider");
      }
      expect(resetDivider.boundaryKind).toBe("reset");

      const displayedAssistant = displayed[1];
      if (displayedAssistant?.type !== "assistant") {
        throw new Error("Expected second displayed row to remain the pre-reset assistant message");
      }
      expect(displayedAssistant.isBeforeLatestContextBoundary).toBe(true);

      const displayedUser = displayed[0];
      if (displayedUser?.type !== "user") {
        throw new Error("Expected first displayed row to remain the pre-reset user message");
      }
      expect(displayedUser.isBeforeLatestContextBoundary).toBe(true);
    });

    test("does not prune messages when a non-boundary message arrives", () => {
      const aggregator = new StreamingMessageAggregator(TEST_CREATED_AT);

      const msg1 = asChatMessage(
        createMuxMessage("user-1", "user", "First message", { historySequence: 0 })
      );
      const msg2 = asChatMessage(
        createMuxMessage("assistant-1", "assistant", "Normal response", { historySequence: 1 })
      );

      aggregator.handleMessage(msg1);
      aggregator.handleMessage(msg2);

      expect(aggregator.getAllMessages()).toHaveLength(2);
    });
  });

  describe("stream metadata", () => {
    test("keeps derived agentId on the live assistant message when legacy mode is omitted", () => {
      const aggregator = new StreamingMessageAggregator(TEST_CREATED_AT);

      aggregator.handleStreamStart({
        type: "stream-start",
        workspaceId: TEST_WORKSPACE_ID,
        messageId: "explore-msg",
        historySequence: 1,
        model: TEST_MODEL,
        startTime: Date.now(),
        agentId: "explore",
      });

      const streamingMessage = aggregator
        .getAllMessages()
        .find((message) => message.id === "explore-msg");
      expect(streamingMessage?.metadata?.agentId).toBe("explore");
      expect(streamingMessage?.metadata?.mode).toBeUndefined();
    });

    test("preserves derived agentId when replay stream-start omits it", () => {
      const aggregator = new StreamingMessageAggregator(TEST_CREATED_AT);

      aggregator.handleStreamStart({
        type: "stream-start",
        workspaceId: TEST_WORKSPACE_ID,
        messageId: "explore-replay-msg",
        historySequence: 1,
        model: TEST_MODEL,
        startTime: Date.now(),
        agentId: "explore",
      });
      aggregator.handleStreamDelta({
        type: "stream-delta",
        workspaceId: TEST_WORKSPACE_ID,
        messageId: "explore-replay-msg",
        delta: "hello",
        tokens: 1,
        timestamp: Date.now(),
      });

      aggregator.handleStreamStart({
        type: "stream-start",
        workspaceId: TEST_WORKSPACE_ID,
        messageId: "explore-replay-msg",
        historySequence: 1,
        model: TEST_MODEL,
        startTime: Date.now(),
        replay: true,
      });

      const streamingMessage = aggregator
        .getAllMessages()
        .find((message) => message.id === "explore-replay-msg");
      expect(streamingMessage?.metadata?.agentId).toBe("explore");
    });
  });

  describe("recency on stream completion", () => {
    test("bumps recency on final non-compaction stream end", () => {
      let callbackCompletedAt: number | null | undefined;
      const aggregator = new StreamingMessageAggregator(
        TEST_CREATED_AT,
        "test-workspace-recency-final"
      );
      aggregator.onResponseComplete = (event) => {
        callbackCompletedAt = event.completedAt;
      };
      const initialRecency = aggregator.getRecencyTimestamp();
      expect(initialRecency).not.toBeNull();

      aggregator.handleStreamStart({
        type: "stream-start",
        workspaceId: "test-workspace-recency-final",
        messageId: "msg-1",
        historySequence: 1,
        model: "claude-3-5-sonnet-20241022",
        startTime: Date.now(),
      });

      const beforeEnd = Date.now();
      aggregator.handleStreamEnd({
        type: "stream-end",
        workspaceId: "test-workspace-recency-final",
        messageId: "msg-1",
        metadata: {
          historySequence: 1,
          timestamp: Date.now(),
          model: "claude-3-5-sonnet-20241022",
        },
        parts: [],
      });

      const recency = aggregator.getRecencyTimestamp();
      expect(recency).not.toBeNull();
      if (recency === null) {
        throw new Error("Expected recency timestamp after stream end");
      }
      expect(recency).toBeGreaterThanOrEqual(beforeEnd);

      // The same completion timestamp is passed to the callback so App.tsx
      // can write an identical lastRead value — no ms-boundary race.
      expect(callbackCompletedAt).toBe(recency);
    });

    test("does not bump on compaction stream end", () => {
      const aggregator = new StreamingMessageAggregator(
        TEST_CREATED_AT,
        "test-workspace-recency-compaction"
      );

      let callbackCompletedAt: number | null | undefined;
      aggregator.onResponseComplete = (event) => {
        callbackCompletedAt = event.completedAt;
      };

      const initialRecency = aggregator.getRecencyTimestamp();
      expect(initialRecency).not.toBeNull();
      if (initialRecency === null) {
        throw new Error("Expected initial recency timestamp");
      }

      aggregator.handleStreamStart({
        type: "stream-start",
        workspaceId: "test-workspace-recency-compaction",
        messageId: "msg-1",
        historySequence: 1,
        model: "claude-3-5-sonnet-20241022",
        startTime: Date.now(),
        mode: "compact",
      });

      const beforeEnd = Date.now();
      aggregator.handleStreamEnd({
        type: "stream-end",
        workspaceId: "test-workspace-recency-compaction",
        messageId: "msg-1",
        metadata: {
          historySequence: 1,
          timestamp: Date.now(),
          model: "claude-3-5-sonnet-20241022",
        },
        parts: [],
      });

      const recency = aggregator.getRecencyTimestamp();
      expect(recency).toBe(initialRecency);
      if (recency !== null) {
        expect(recency).toBeLessThan(beforeEnd);
      }

      // completedAt IS passed to callback — App.tsx can mark active workspace as read
      // even after compaction, preventing false unread indicators.
      expect(callbackCompletedAt).not.toBeNull();
      expect(callbackCompletedAt).toBeGreaterThanOrEqual(beforeEnd);
    });

    test("marks compaction completions as non-notifying", () => {
      const workspaceId = "test-workspace-recency-idle-compaction";
      const aggregator = new StreamingMessageAggregator(TEST_CREATED_AT, workspaceId);
      let completion: Parameters<typeof shouldNotifyOnResponseComplete>[0];
      aggregator.onResponseComplete = (event) => {
        completion = event.completion;
      };

      aggregator.handleMessage({
        ...createMuxMessage("idle-compaction-request", "user", "/compact", {
          historySequence: 1,
          timestamp: Date.now(),
          muxMetadata: {
            type: "compaction-request",
            rawCommand: "/compact",
            parsed: { model: "claude-3-5-sonnet-20241022" },
            source: "idle-compaction",
          },
        }),
        type: "message",
      });

      aggregator.handleStreamStart({
        type: "stream-start",
        workspaceId,
        messageId: "idle-compaction-stream",
        historySequence: 2,
        model: "claude-3-5-sonnet-20241022",
        startTime: Date.now(),
        mode: "compact",
      });

      aggregator.handleStreamEnd({
        type: "stream-end",
        workspaceId,
        messageId: "idle-compaction-stream",
        metadata: {
          historySequence: 2,
          timestamp: Date.now(),
          model: "claude-3-5-sonnet-20241022",
        },
        parts: [],
      });

      expect(completion).toEqual({ kind: "compaction" });
      expect(shouldNotifyOnResponseComplete(completion)).toBe(false);
    });

    test("does not bump on non-final stream end", () => {
      const aggregator = new StreamingMessageAggregator(
        TEST_CREATED_AT,
        "test-workspace-recency-non-final"
      );
      const initialRecency = aggregator.getRecencyTimestamp();
      expect(initialRecency).not.toBeNull();
      if (initialRecency === null) {
        throw new Error("Expected initial recency timestamp");
      }

      aggregator.handleStreamStart({
        type: "stream-start",
        workspaceId: "test-workspace-recency-non-final",
        messageId: "msg-1",
        historySequence: 1,
        model: "claude-3-5-sonnet-20241022",
        startTime: Date.now(),
      });

      aggregator.handleStreamStart({
        type: "stream-start",
        workspaceId: "test-workspace-recency-non-final",
        messageId: "msg-2",
        historySequence: 2,
        model: "claude-3-5-sonnet-20241022",
        startTime: Date.now(),
      });

      const beforeFirstEnd = Date.now();
      aggregator.handleStreamEnd({
        type: "stream-end",
        workspaceId: "test-workspace-recency-non-final",
        messageId: "msg-1",
        metadata: {
          historySequence: 1,
          timestamp: Date.now(),
          model: "claude-3-5-sonnet-20241022",
        },
        parts: [],
      });

      const recency = aggregator.getRecencyTimestamp();
      expect(recency).toBe(initialRecency);
      if (recency !== null) {
        expect(recency).toBeLessThan(beforeFirstEnd);
      }
    });

    test("does not bump in reconnection branch", () => {
      const aggregator = new StreamingMessageAggregator(
        TEST_CREATED_AT,
        "test-workspace-recency-reconnect"
      );
      const initialRecency = aggregator.getRecencyTimestamp();
      expect(initialRecency).not.toBeNull();
      if (initialRecency === null) {
        throw new Error("Expected initial recency timestamp");
      }

      const beforeEnd = Date.now();
      aggregator.handleStreamEnd({
        type: "stream-end",
        workspaceId: "test-workspace-recency-reconnect",
        messageId: "msg-1",
        metadata: {
          historySequence: 1,
          timestamp: Date.now(),
          model: "claude-3-5-sonnet-20241022",
        },
        parts: [],
      });

      const recency = aggregator.getRecencyTimestamp();
      expect(recency).toBe(initialRecency);
      if (recency !== null) {
        expect(recency).toBeLessThan(beforeEnd);
      }
    });
  });

  describe("incremental stream replay", () => {
    test("preserves last stream timestamp when replayed stream-start re-establishes context", () => {
      const aggregator = new StreamingMessageAggregator(TEST_CREATED_AT);
      const startTime = 1_000;
      const deltaTimestamp = 1_250;

      aggregator.handleStreamStart({
        type: "stream-start",
        workspaceId: "test-workspace",
        messageId: "msg-replay-1",
        historySequence: 1,
        model: "claude-3-5-sonnet-20241022",
        startTime,
      });

      aggregator.handleStreamDelta({
        type: "stream-delta",
        workspaceId: "test-workspace",
        messageId: "msg-replay-1",
        delta: "partial",
        tokens: 1,
        timestamp: deltaTimestamp,
      });

      const beforeReplayCursor = aggregator.getOnChatCursor();
      expect(beforeReplayCursor?.stream?.lastTimestamp).toBe(deltaTimestamp);

      // Since-mode reconnect can replay stream-start without replaying additional parts.
      // Cursor timestamp must remain monotonic to avoid requesting duplicate events.
      aggregator.handleStreamStart({
        type: "stream-start",
        workspaceId: "test-workspace",
        messageId: "msg-replay-1",
        historySequence: 1,
        model: "claude-3-5-sonnet-20241022",
        startTime,
        replay: true,
      });

      const afterReplayCursor = aggregator.getOnChatCursor();
      expect(afterReplayCursor?.stream?.lastTimestamp).toBe(deltaTimestamp);
    });

    test("marks streamed assistant rows as replay presentation when stream-start is replayed", () => {
      const aggregator = new StreamingMessageAggregator(TEST_CREATED_AT);

      aggregator.handleStreamStart({
        type: "stream-start",
        workspaceId: "test-workspace",
        messageId: "msg-replay-presentation",
        historySequence: 1,
        model: "claude-3-5-sonnet-20241022",
        startTime: 1_000,
        replay: true,
      });

      aggregator.handleStreamDelta({
        type: "stream-delta",
        workspaceId: "test-workspace",
        messageId: "msg-replay-presentation",
        delta: "replayed partial",
        tokens: 1,
        timestamp: 1_100,
        replay: true,
      });

      const displayed = aggregator.getDisplayedMessages();
      const assistant = displayed.find(
        (message): message is Extract<(typeof displayed)[number], { type: "assistant" }> =>
          message.type === "assistant" && message.historyId === "msg-replay-presentation"
      );

      expect(assistant).toBeDefined();
      expect(assistant?.streamPresentation).toEqual({ source: "replay" });
    });
    test("switches streaming presentation from replay to live when non-replay delta arrives", () => {
      const aggregator = new StreamingMessageAggregator(TEST_CREATED_AT);

      // Reconnect: stream-start with replay flag
      aggregator.handleStreamStart({
        type: "stream-start",
        workspaceId: "test-workspace",
        messageId: "msg-replay-to-live",
        historySequence: 1,
        model: "claude-3-5-sonnet-20241022",
        startTime: 1_000,
        replay: true,
      });

      // Replay catch-up delta (tagged with replay)
      aggregator.handleStreamDelta({
        type: "stream-delta",
        workspaceId: "test-workspace",
        messageId: "msg-replay-to-live",
        delta: "cached ",
        tokens: 1,
        timestamp: 1_100,
        replay: true,
      });

      // During replay: source should be "replay"
      const duringReplay = aggregator.getDisplayedMessages();
      const replayRow = duringReplay.find(
        (message): message is Extract<(typeof duringReplay)[number], { type: "assistant" }> =>
          message.type === "assistant" && message.historyId === "msg-replay-to-live"
      );
      expect(replayRow?.streamPresentation).toEqual({ source: "replay" });

      // Fresh live delta (no replay flag) — catch-up is over
      aggregator.handleStreamDelta({
        type: "stream-delta",
        workspaceId: "test-workspace",
        messageId: "msg-replay-to-live",
        delta: "fresh tokens",
        tokens: 2,
        timestamp: 1_200,
      });

      // After live resume: source should flip to "live"
      const afterLive = aggregator.getDisplayedMessages();
      const liveRow = afterLive.find(
        (message): message is Extract<(typeof afterLive)[number], { type: "assistant" }> =>
          message.type === "assistant" && message.historyId === "msg-replay-to-live"
      );
      expect(liveRow?.streamPresentation).toEqual({ source: "live" });
    });

    test("does not exit replay phase on non-replay tool events arriving before replay text drains", () => {
      const aggregator = new StreamingMessageAggregator(TEST_CREATED_AT);

      // Reconnect: stream-start with replay flag
      aggregator.handleStreamStart({
        type: "stream-start",
        workspaceId: "test-workspace",
        messageId: "msg-tool-during-replay",
        historySequence: 1,
        model: "claude-3-5-sonnet-20241022",
        startTime: 1_000,
        replay: true,
      });

      // Replay catch-up delta
      aggregator.handleStreamDelta({
        type: "stream-delta",
        workspaceId: "test-workspace",
        messageId: "msg-tool-during-replay",
        delta: "cached ",
        tokens: 1,
        timestamp: 1_100,
        replay: true,
      });

      // Non-replay tool event arrives before replay text finishes draining.
      // Tool events are not buffered by the reconnect relay, so they can
      // arrive without the replay flag even while replay text is still in-flight.
      aggregator.handleToolCallStart({
        type: "tool-call-start",
        workspaceId: "test-workspace",
        messageId: "msg-tool-during-replay",
        toolCallId: "tool-1",
        toolName: "bash",
        args: { command: "echo hi" },
        tokens: 1,
        timestamp: 1_150,
      });

      // Another replay delta arrives (still part of catch-up)
      aggregator.handleStreamDelta({
        type: "stream-delta",
        workspaceId: "test-workspace",
        messageId: "msg-tool-during-replay",
        delta: "tail",
        tokens: 1,
        timestamp: 1_200,
        replay: true,
      });

      // Source must still be "replay" — tool event must not have flipped it
      const displayed = aggregator.getDisplayedMessages();
      const assistantRows = displayed.filter(
        (message): message is Extract<(typeof displayed)[number], { type: "assistant" }> =>
          message.type === "assistant" && message.historyId === "msg-tool-during-replay"
      );
      const assistant = assistantRows.at(-1);
      expect(assistant?.streamPresentation).toEqual({ source: "replay" });
    });
  });

  describe("append replay cache invalidation", () => {
    test("rebuilds displayed rows when append replay overwrites an existing message id", () => {
      const aggregator = new StreamingMessageAggregator(TEST_CREATED_AT);

      const partialMessage = createMuxMessage("msg-overwrite-1", "assistant", "partial", {
        historySequence: 1,
        timestamp: 1,
      });
      aggregator.loadHistoricalMessages([partialMessage], false);

      const initialDisplayed = aggregator.getDisplayedMessages();
      const initialAssistant = initialDisplayed.find(
        (message): message is Extract<(typeof initialDisplayed)[number], { type: "assistant" }> =>
          message.type === "assistant" && message.historyId === "msg-overwrite-1"
      );
      expect(initialAssistant).toBeDefined();
      expect(initialAssistant?.content).toBe("partial");

      const finalizedMessage = createMuxMessage("msg-overwrite-1", "assistant", "finalized", {
        historySequence: 1,
        timestamp: 2,
      });
      aggregator.loadHistoricalMessages([finalizedMessage], false, { mode: "append" });

      const updatedDisplayed = aggregator.getDisplayedMessages();
      const updatedAssistant = updatedDisplayed.find(
        (message): message is Extract<(typeof updatedDisplayed)[number], { type: "assistant" }> =>
          message.type === "assistant" && message.historyId === "msg-overwrite-1"
      );

      expect(updatedAssistant).toBeDefined();
      expect(updatedAssistant?.content).toBe("finalized");
      expect(updatedAssistant).not.toBe(initialAssistant);
    });
  });

  test("tool-call-execution-start stamps executionStartedAt onto the displayed tool row", () => {
    const aggregator = new StreamingMessageAggregator(TEST_CREATED_AT);

    startTestStream(aggregator, { messageId: "msg-1" });
    startToolCall(aggregator, {
      toolCallId: "tool-queued",
      toolName: "bash",
      args: { command: "echo hi" },
      timestamp: 1_000,
    });

    // Queued behind a sibling: no execution start yet.
    const queuedRow = aggregator
      .getDisplayedMessages()
      .find((m) => m.type === "tool" && m.toolCallId === "tool-queued");
    expect(queuedRow?.type).toBe("tool");
    expect(queuedRow?.type === "tool" ? queuedRow.executionStartedAt : null).toBeUndefined();

    aggregator.handleToolCallExecutionStart({
      type: "tool-call-execution-start",
      workspaceId: TEST_WORKSPACE_ID,
      messageId: "msg-1",
      toolCallId: "tool-queued",
      timestamp: 5_000,
    });

    const executingRow = aggregator
      .getDisplayedMessages()
      .find((m) => m.type === "tool" && m.toolCallId === "tool-queued");
    expect(executingRow?.type === "tool" ? executingRow.executionStartedAt : undefined).toBe(5_000);
  });

  test("tool execution stats measure from execution start, not queue entry", () => {
    const aggregator = new StreamingMessageAggregator(TEST_CREATED_AT);

    startTestStream(aggregator, { messageId: "msg-1" });
    // Two parallel tool calls emitted back-to-back; they execute sequentially.
    startToolCall(aggregator, {
      toolCallId: "tool-a",
      toolName: "bash",
      args: {},
      timestamp: 1_000,
    });
    startToolCall(aggregator, {
      toolCallId: "tool-b",
      toolName: "bash",
      args: {},
      timestamp: 1_001,
    });

    aggregator.handleToolCallExecutionStart({
      type: "tool-call-execution-start",
      workspaceId: TEST_WORKSPACE_ID,
      messageId: "msg-1",
      toolCallId: "tool-a",
      timestamp: 1_002,
    });
    endToolCall(aggregator, {
      toolCallId: "tool-a",
      toolName: "bash",
      result: {},
      timestamp: 5_000,
    });
    aggregator.handleToolCallExecutionStart({
      type: "tool-call-execution-start",
      workspaceId: TEST_WORKSPACE_ID,
      messageId: "msg-1",
      toolCallId: "tool-b",
      timestamp: 5_001,
    });
    endToolCall(aggregator, {
      toolCallId: "tool-b",
      toolName: "bash",
      result: {},
      timestamp: 9_000,
    });

    const stats = aggregator.getActiveStreamTimingStats();
    // A: 5000-1002, B: 9000-5001. Without execution-start re-anchoring, B would
    // count from emission (9000-1001) and double-count A's run time.
    expect(stats?.toolExecutionMs).toBe(3_998 + 3_999);
  });

  test("replayed tool-call-start merges executionStartedAt into an existing tool part", () => {
    const aggregator = new StreamingMessageAggregator(TEST_CREATED_AT);

    startTestStream(aggregator, { messageId: "msg-1" });
    // Client saw the queued tool-call-start live (no execution start yet)...
    startToolCall(aggregator, {
      toolCallId: "tool-reconnect",
      toolName: "bash",
      args: { command: "echo hi" },
      timestamp: 1_000,
    });

    // ...disconnected, execute() began, and the `since` replay re-sends the enriched start.
    aggregator.handleToolCallStart({
      type: "tool-call-start",
      workspaceId: TEST_WORKSPACE_ID,
      messageId: "msg-1",
      toolCallId: "tool-reconnect",
      toolName: "bash",
      args: { command: "echo hi" },
      tokens: 0,
      timestamp: 1_000,
      executionStartedAt: 6_000,
      replay: true,
    });

    const row = aggregator
      .getDisplayedMessages()
      .find((m) => m.type === "tool" && m.toolCallId === "tool-reconnect");
    expect(row?.type === "tool" ? row.executionStartedAt : undefined).toBe(6_000);

    // The merge must also re-anchor timing stats: the tool's duration counts from
    // execution start (6000), not the pre-disconnect emission seed (1000).
    endToolCall(aggregator, {
      toolCallId: "tool-reconnect",
      toolName: "bash",
      result: {},
      timestamp: 9_000,
    });
    expect(aggregator.getActiveStreamTimingStats()?.toolExecutionMs).toBe(3_000);
  });

  test("stashes execution starts that arrive before their tool part exists", () => {
    const aggregator = new StreamingMessageAggregator(TEST_CREATED_AT);

    startTestStream(aggregator, { messageId: "msg-1" });
    // Reconnect replay in progress: the live execution-start (not replay-buffered)
    // arrives before the replayed tool-call-start creates the part.
    aggregator.handleToolCallExecutionStart({
      type: "tool-call-execution-start",
      workspaceId: TEST_WORKSPACE_ID,
      messageId: "msg-1",
      toolCallId: "tool-race",
      timestamp: 6_000,
    });

    // Replayed start without executionStartedAt (snapshot predates execute()).
    aggregator.handleToolCallStart({
      type: "tool-call-start",
      workspaceId: TEST_WORKSPACE_ID,
      messageId: "msg-1",
      toolCallId: "tool-race",
      toolName: "bash",
      args: { command: "echo hi" },
      tokens: 0,
      timestamp: 1_000,
      replay: true,
    });

    const row = aggregator
      .getDisplayedMessages()
      .find((m) => m.type === "tool" && m.toolCallId === "tool-race");
    expect(row?.type === "tool" ? row.executionStartedAt : undefined).toBe(6_000);

    // Timing stats must also anchor at execution start, not the replayed emission time.
    endToolCall(aggregator, {
      toolCallId: "tool-race",
      toolName: "bash",
      result: {},
      timestamp: 9_000,
    });
    expect(aggregator.getActiveStreamTimingStats()?.toolExecutionMs).toBe(3_000);
  });

  test("fresh replayed tool-call-start seeds timing stats from executionStartedAt", () => {
    const aggregator = new StreamingMessageAggregator(TEST_CREATED_AT);

    startTestStream(aggregator, { messageId: "msg-1" });
    // Full replay after reconnect: the client never saw the live start, and the
    // replayed event already carries the true execution start.
    aggregator.handleToolCallStart({
      type: "tool-call-start",
      workspaceId: TEST_WORKSPACE_ID,
      messageId: "msg-1",
      toolCallId: "tool-fresh-replay",
      toolName: "bash",
      args: { command: "echo hi" },
      tokens: 0,
      timestamp: 1_000,
      executionStartedAt: 6_000,
      replay: true,
    });
    endToolCall(aggregator, {
      toolCallId: "tool-fresh-replay",
      toolName: "bash",
      result: {},
      timestamp: 9_000,
    });

    expect(aggregator.getActiveStreamTimingStats()?.toolExecutionMs).toBe(3_000);
  });

  test("keeps richer in-memory parts when append replay sends a stale duplicate", () => {
    const aggregator = new StreamingMessageAggregator(TEST_CREATED_AT);

    aggregator.handleStreamStart({
      type: "stream-start",
      workspaceId: "test-workspace",
      messageId: "msg-stale-append",
      historySequence: 1,
      model: "claude-3-5-sonnet-20241022",
      startTime: 1_000,
    });

    aggregator.handleToolCallStart({
      type: "tool-call-start",
      workspaceId: "test-workspace",
      messageId: "msg-stale-append",
      toolCallId: "tool-stale-append",
      toolName: "bash",
      args: { command: "echo hi" },
      tokens: 1,
      timestamp: 1_100,
    });

    aggregator.handleStreamDelta({
      type: "stream-delta",
      workspaceId: "test-workspace",
      messageId: "msg-stale-append",
      delta: "tool output pending",
      tokens: 1,
      timestamp: 1_200,
    });

    const existingMessage = aggregator
      .getAllMessages()
      .find((message) => message.id === "msg-stale-append");
    expect(existingMessage).toBeDefined();
    expect(existingMessage?.parts.length).toBeGreaterThan(1);

    const staleReplayMessage = createMuxMessage("msg-stale-append", "assistant", "placeholder", {
      historySequence: 1,
      timestamp: 1_050,
    });
    aggregator.loadHistoricalMessages([staleReplayMessage], true, { mode: "append" });

    const updatedMessage = aggregator
      .getAllMessages()
      .find((message) => message.id === "msg-stale-append");
    expect(updatedMessage).toBeDefined();
    expect(updatedMessage).toBe(existingMessage);
    expect(updatedMessage?.parts.length).toBeGreaterThan(1);
    expect(updatedMessage?.parts.some((part) => part.type === "dynamic-tool")).toBe(true);
  });

  describe("compaction detection", () => {
    test("treats active stream as compacting on reconnect when stream-start has no mode", () => {
      const aggregator = new StreamingMessageAggregator(TEST_CREATED_AT);

      const compactionRequestMessage = {
        id: "msg1",
        role: "user" as const,
        parts: [{ type: "text" as const, text: "/compact" }],
        metadata: {
          historySequence: 1,
          timestamp: Date.now(),
          muxMetadata: {
            type: "compaction-request" as const,
            rawCommand: "/compact",
            parsed: { model: "anthropic:claude-3-5-haiku-20241022" },
          },
        },
      };

      aggregator.loadHistoricalMessages([compactionRequestMessage], true);

      // Older stream-start events may omit `mode`.
      aggregator.handleStreamStart({
        type: "stream-start",
        workspaceId: "test-workspace",
        messageId: "msg2",
        historySequence: 2,
        model: "anthropic:claude-3-5-haiku-20241022",
        startTime: Date.now(),
      });

      expect(aggregator.isCompacting()).toBe(true);
    });

    test("treats active stream as compacting on reconnect when stream-start mode is exec", () => {
      const aggregator = new StreamingMessageAggregator(TEST_CREATED_AT);

      const compactionRequestMessage = {
        id: "msg1",
        role: "user" as const,
        parts: [{ type: "text" as const, text: "/compact" }],
        metadata: {
          historySequence: 1,
          timestamp: Date.now(),
          muxMetadata: {
            type: "compaction-request" as const,
            rawCommand: "/compact",
            parsed: { model: "anthropic:claude-3-5-haiku-20241022" },
          },
        },
      };

      aggregator.loadHistoricalMessages([compactionRequestMessage], true);

      // The backend may send mode="exec" even for compaction streams (mode is derived from
      // the resolved agent/toolchain), so we must not treat non-compact mode as a negative.
      aggregator.handleStreamStart({
        type: "stream-start",
        workspaceId: "test-workspace",
        messageId: "msg2",
        historySequence: 2,
        model: "anthropic:claude-3-5-haiku-20241022",
        startTime: Date.now(),
        mode: "exec",
      });

      expect(aggregator.isCompacting()).toBe(true);
    });

    test("treats active stream as compacting when user message is a compaction-request and stream-start mode is exec", () => {
      const aggregator = new StreamingMessageAggregator(TEST_CREATED_AT);

      aggregator.handleMessage({
        type: "message",
        id: "msg1",
        role: "user",
        parts: [{ type: "text", text: "/compact" }],
        metadata: {
          historySequence: 1,
          timestamp: Date.now(),
          muxMetadata: {
            type: "compaction-request",
            rawCommand: "/compact",
            parsed: { model: "anthropic:claude-3-5-haiku-20241022" },
          },
        },
      });

      aggregator.handleStreamStart({
        type: "stream-start",
        workspaceId: "test-workspace",
        messageId: "msg2",
        historySequence: 2,
        model: "anthropic:claude-3-5-haiku-20241022",
        startTime: Date.now(),
        mode: "exec",
      });

      expect(aggregator.isCompacting()).toBe(true);
    });

    test("treats mode=compact as authoritative", () => {
      const aggregator = new StreamingMessageAggregator(TEST_CREATED_AT);

      aggregator.handleStreamStart({
        type: "stream-start",
        workspaceId: "test-workspace",
        messageId: "msg1",
        historySequence: 1,
        model: "anthropic:claude-3-5-haiku-20241022",
        startTime: Date.now(),
        mode: "compact",
      });

      expect(aggregator.isCompacting()).toBe(true);
    });
    test("does not treat non-compact agent streams as compacting even when the latest user message is /compact", () => {
      const aggregator = new StreamingMessageAggregator(TEST_CREATED_AT);

      const compactionRequestMessage = {
        id: "msg1",
        role: "user" as const,
        parts: [{ type: "text" as const, text: "/compact" }],
        metadata: {
          historySequence: 1,
          timestamp: Date.now(),
          muxMetadata: {
            type: "compaction-request" as const,
            rawCommand: "/compact",
            parsed: { model: "anthropic:claude-3-5-haiku-20241022" },
          },
        },
      };

      aggregator.loadHistoricalMessages([compactionRequestMessage], true);

      aggregator.handleStreamStart({
        type: "stream-start",
        workspaceId: "test-workspace",
        messageId: "continue-stream",
        historySequence: 2,
        model: "anthropic:claude-3-5-haiku-20241022",
        startTime: Date.now(),
        agentId: "exec",
        mode: "exec",
      });

      expect(aggregator.isCompacting()).toBe(false);
    });

    test("does not reuse a completed compaction request when older stream-start events omit agentId", () => {
      const aggregator = new StreamingMessageAggregator(TEST_CREATED_AT);

      const compactionRequestMessage = {
        id: "msg1",
        role: "user" as const,
        parts: [{ type: "text" as const, text: "/compact" }],
        metadata: {
          historySequence: 1,
          timestamp: Date.now(),
          muxMetadata: {
            type: "compaction-request" as const,
            rawCommand: "/compact",
            parsed: { model: "anthropic:claude-3-5-haiku-20241022" },
          },
        },
      };
      const compactionSummaryMessage = createMuxMessage(
        "summary-1",
        "assistant",
        "Compacted summary",
        {
          historySequence: 2,
          timestamp: Date.now(),
          compactionBoundary: true,
          muxMetadata: { type: "compaction-summary" },
        }
      );

      aggregator.loadHistoricalMessages([compactionRequestMessage, compactionSummaryMessage], true);

      aggregator.handleStreamStart({
        type: "stream-start",
        workspaceId: "test-workspace",
        messageId: "continue-stream",
        historySequence: 3,
        model: "anthropic:claude-3-5-haiku-20241022",
        startTime: Date.now(),
        mode: "exec",
      });

      expect(aggregator.isCompacting()).toBe(false);
    });

    test("suppresses response notifications for default post-compaction Continue resumes", () => {
      const workspaceId = "test-workspace-default-continue-notify";
      const aggregator = new StreamingMessageAggregator(TEST_CREATED_AT, workspaceId);
      let completion: Parameters<typeof shouldNotifyOnResponseComplete>[0];
      aggregator.onResponseComplete = (event) => {
        completion = event.completion;
      };

      const summaryMessage = createMuxMessage("summary-default-continue", "assistant", "Summary", {
        historySequence: 1,
        timestamp: Date.now(),
        compactionBoundary: true,
        muxMetadata: {
          type: "compaction-summary",
          pendingFollowUp: {
            text: "Continue",
            model: "anthropic:claude-3-5-haiku-20241022",
            dispatchOptions: { source: "internal-resume" },
            agentId: "exec",
          },
        },
      });

      aggregator.loadHistoricalMessages([summaryMessage], true);
      aggregator.handleMessage({
        ...createMuxMessage("synthetic-default-continue", "user", "Continue", {
          historySequence: 2,
          timestamp: Date.now(),
          synthetic: true,
          uiVisible: true,
        }),
        type: "message",
      });

      aggregator.handleStreamStart({
        type: "stream-start",
        workspaceId,
        messageId: "continue-stream",
        historySequence: 3,
        model: "anthropic:claude-3-5-haiku-20241022",
        startTime: Date.now(),
        agentId: "exec",
        mode: "exec",
      });
      aggregator.handleStreamEnd({
        type: "stream-end",
        workspaceId,
        messageId: "continue-stream",
        metadata: {
          historySequence: 3,
          timestamp: Date.now(),
          model: "anthropic:claude-3-5-haiku-20241022",
        },
        parts: [{ type: "text", text: "Done" }],
      });

      expect(completion).toEqual({
        kind: "response",
        hasAutoFollowUp: false,
        suppressNotification: true,
      });
      expect(shouldNotifyOnResponseComplete(completion)).toBe(false);
    });

    test("does not suppress response notifications for user-authored Continue follow-ups", () => {
      const workspaceId = "test-workspace-user-follow-up-notify";
      const aggregator = new StreamingMessageAggregator(TEST_CREATED_AT, workspaceId);
      let completion: Parameters<typeof shouldNotifyOnResponseComplete>[0];
      aggregator.onResponseComplete = (event) => {
        completion = event.completion;
      };

      const summaryMessage = createMuxMessage("summary-user-follow-up", "assistant", "Summary", {
        historySequence: 1,
        timestamp: Date.now(),
        compactionBoundary: true,
        muxMetadata: {
          type: "compaction-summary",
          pendingFollowUp: {
            text: "Continue",
            model: "anthropic:claude-3-5-haiku-20241022",
            agentId: "exec",
          },
        },
      });

      aggregator.loadHistoricalMessages([summaryMessage], true);
      aggregator.handleMessage({
        ...createMuxMessage("synthetic-user-follow-up", "user", "Continue", {
          historySequence: 2,
          timestamp: Date.now(),
          synthetic: true,
          uiVisible: true,
        }),
        type: "message",
      });

      aggregator.handleStreamStart({
        type: "stream-start",
        workspaceId,
        messageId: "follow-up-stream",
        historySequence: 3,
        model: "anthropic:claude-3-5-haiku-20241022",
        startTime: Date.now(),
        agentId: "exec",
        mode: "exec",
      });
      aggregator.handleStreamEnd({
        type: "stream-end",
        workspaceId,
        messageId: "follow-up-stream",
        metadata: {
          historySequence: 3,
          timestamp: Date.now(),
          model: "anthropic:claude-3-5-haiku-20241022",
        },
        parts: [{ type: "text", text: "Done" }],
      });

      expect(completion).toBeUndefined();
      expect(shouldNotifyOnResponseComplete(completion)).toBe(true);
    });
  });

  describe("pending stream model", () => {
    test("tracks requestedModel for pending user messages", () => {
      const aggregator = new StreamingMessageAggregator(TEST_CREATED_AT);

      aggregator.handleMessage({
        type: "message",
        id: "msg1",
        role: "user",
        parts: [{ type: "text", text: "Hello" }],
        metadata: {
          historySequence: 1,
          timestamp: Date.now(),
          muxMetadata: {
            type: "normal",
            requestedModel: "anthropic:claude-sonnet-4-5",
          },
        },
      });

      expect(aggregator.getPendingStreamModel()).toBe("anthropic:claude-sonnet-4-5");
    });

    test("tracks requestedModel for compaction requests", () => {
      const aggregator = new StreamingMessageAggregator(TEST_CREATED_AT);

      aggregator.handleMessage({
        type: "message",
        id: "msg1",
        role: "user",
        parts: [{ type: "text", text: "/compact" }],
        metadata: {
          historySequence: 1,
          timestamp: Date.now(),
          muxMetadata: {
            type: "compaction-request",
            requestedModel: "anthropic:claude-sonnet-4-5",
            parsed: { model: "anthropic:claude-sonnet-4-5" },
          },
        },
      });

      expect(aggregator.getPendingStreamModel()).toBe("anthropic:claude-sonnet-4-5");
    });

    test("clears pending stream model on stream-start", () => {
      const aggregator = new StreamingMessageAggregator(TEST_CREATED_AT);

      aggregator.handleMessage({
        type: "message",
        id: "msg1",
        role: "user",
        parts: [{ type: "text", text: "Hello" }],
        metadata: {
          historySequence: 1,
          timestamp: Date.now(),
          muxMetadata: {
            type: "normal",
            requestedModel: "anthropic:claude-sonnet-4-5",
          },
        },
      });

      aggregator.handleStreamStart({
        type: "stream-start",
        workspaceId: "test-workspace",
        messageId: "msg2",
        historySequence: 2,
        model: "anthropic:claude-sonnet-4-5",
        startTime: Date.now(),
      });

      expect(aggregator.getPendingStreamModel()).toBeNull();
    });
  });

  describe("pending stream lifecycle", () => {
    test("clears pending state when stream-end arrives without prior stream-start", () => {
      const aggregator = new StreamingMessageAggregator(TEST_CREATED_AT);
      seedPendingStreamState(aggregator);

      expect(aggregator.getPendingStreamStartTime()).not.toBeNull();
      expect(aggregator.getPendingStreamModel()).toBe("openai:gpt-4o-mini");
      expect(aggregator.getRuntimeStatus()?.phase).toBe("starting");

      aggregator.handleStreamEnd({
        type: "stream-end",
        workspaceId: "test-workspace",
        messageId: "assistant-1",
        metadata: {
          historySequence: 2,
          timestamp: Date.now(),
          model: "openai:gpt-4o-mini",
        },
        parts: [],
      });

      expect(aggregator.getPendingStreamStartTime()).toBeNull();
      expect(aggregator.getPendingStreamModel()).toBeNull();
      expect(aggregator.getRuntimeStatus()).toBeNull();
    });

    test("keeps an optimistic new-chat start through an empty replay", () => {
      const aggregator = new StreamingMessageAggregator(TEST_CREATED_AT);

      aggregator.markOptimisticPendingStreamStart("openai:gpt-4o-mini");
      aggregator.loadHistoricalMessages([], false);

      expect(aggregator.getPendingStreamStartTime()).not.toBeNull();
      expect(aggregator.getPendingStreamModel()).toBe("openai:gpt-4o-mini");
    });

    test("ends the optimistic new-chat start once replay shows the first user turn", () => {
      const aggregator = new StreamingMessageAggregator(TEST_CREATED_AT);

      aggregator.markOptimisticPendingStreamStart("openai:gpt-4o-mini");
      aggregator.loadHistoricalMessages([
        createMuxMessage("user-1", "user", "Hello", {
          historySequence: 1,
          timestamp: Date.now(),
        }),
      ]);

      expect(aggregator.getPendingStreamStartTime()).toBeNull();
      expect(aggregator.getPendingStreamModel()).toBeNull();
    });

    test("preserves an optimistic new-chat start across replay resets", () => {
      const aggregator = new StreamingMessageAggregator(TEST_CREATED_AT);

      aggregator.markOptimisticPendingStreamStart("openai:gpt-4o-mini");
      aggregator.resetForReplay();

      expect(aggregator.getPendingStreamStartTime()).not.toBeNull();
      expect(aggregator.getPendingStreamModel()).toBe("openai:gpt-4o-mini");
    });

    test("clears stale pending state when authoritative history now ends with assistant", () => {
      const aggregator = new StreamingMessageAggregator(TEST_CREATED_AT);
      seedPendingStreamState(aggregator);

      aggregator.loadHistoricalMessages(
        [
          createMuxMessage("assistant-1", "assistant", "Done", {
            historySequence: 2,
            timestamp: Date.now(),
            model: "openai:gpt-4o-mini",
          }),
        ],
        false,
        { mode: "append" }
      );

      expect(aggregator.getPendingStreamStartTime()).toBeNull();
      expect(aggregator.getPendingStreamModel()).toBeNull();
      expect(aggregator.getRuntimeStatus()).toBeNull();
    });
  });

  describe("usage-delta handling", () => {
    test("handleUsageDelta stores usage by messageId", () => {
      const aggregator = new StreamingMessageAggregator(TEST_CREATED_AT);

      aggregator.handleUsageDelta({
        type: "usage-delta",
        workspaceId: "ws-1",
        messageId: "msg-1",
        usage: { inputTokens: 1000, outputTokens: 50, totalTokens: 1050 },
        cumulativeUsage: { inputTokens: 1000, outputTokens: 50, totalTokens: 1050 },
      });

      expect(aggregator.getActiveStreamUsage("msg-1")).toEqual({
        inputTokens: 1000,
        outputTokens: 50,
        totalTokens: 1050,
      });
    });

    test("clearTokenState removes usage", () => {
      const aggregator = new StreamingMessageAggregator(TEST_CREATED_AT);

      aggregator.handleUsageDelta({
        type: "usage-delta",
        workspaceId: "ws-1",
        messageId: "msg-1",
        usage: { inputTokens: 1000, outputTokens: 50, totalTokens: 1050 },
        cumulativeUsage: { inputTokens: 1000, outputTokens: 50, totalTokens: 1050 },
      });

      expect(aggregator.getActiveStreamUsage("msg-1")).toBeDefined();

      aggregator.clearTokenState("msg-1");

      expect(aggregator.getActiveStreamUsage("msg-1")).toBeUndefined();
    });

    test("latest usage-delta replaces previous for same messageId", () => {
      const aggregator = new StreamingMessageAggregator(TEST_CREATED_AT);

      // First step usage
      aggregator.handleUsageDelta({
        type: "usage-delta",
        workspaceId: "ws-1",
        messageId: "msg-1",
        usage: { inputTokens: 1000, outputTokens: 50, totalTokens: 1050 },
        cumulativeUsage: { inputTokens: 1000, outputTokens: 50, totalTokens: 1050 },
      });

      // Second step usage (larger context after tool result added)
      aggregator.handleUsageDelta({
        type: "usage-delta",
        workspaceId: "ws-1",
        messageId: "msg-1",
        usage: { inputTokens: 1500, outputTokens: 100, totalTokens: 1600 },
        cumulativeUsage: { inputTokens: 2500, outputTokens: 150, totalTokens: 2650 },
      });

      // Should have latest step's values (for context window display)
      expect(aggregator.getActiveStreamUsage("msg-1")).toEqual({
        inputTokens: 1500,
        outputTokens: 100,
        totalTokens: 1600,
      });
      // Cumulative should be sum of all steps (for cost display)
      expect(aggregator.getActiveStreamCumulativeUsage("msg-1")).toEqual({
        inputTokens: 2500,
        outputTokens: 150,
        totalTokens: 2650,
      });
    });

    test("tracks usage independently per messageId", () => {
      const aggregator = new StreamingMessageAggregator(TEST_CREATED_AT);

      aggregator.handleUsageDelta({
        type: "usage-delta",
        workspaceId: "ws-1",
        messageId: "msg-1",
        usage: { inputTokens: 1000, outputTokens: 50, totalTokens: 1050 },
        cumulativeUsage: { inputTokens: 1000, outputTokens: 50, totalTokens: 1050 },
      });

      aggregator.handleUsageDelta({
        type: "usage-delta",
        workspaceId: "ws-1",
        messageId: "msg-2",
        usage: { inputTokens: 2000, outputTokens: 100, totalTokens: 2100 },
        cumulativeUsage: { inputTokens: 2000, outputTokens: 100, totalTokens: 2100 },
      });

      expect(aggregator.getActiveStreamUsage("msg-1")).toEqual({
        inputTokens: 1000,
        outputTokens: 50,
        totalTokens: 1050,
      });
      expect(aggregator.getActiveStreamUsage("msg-2")).toEqual({
        inputTokens: 2000,
        outputTokens: 100,
        totalTokens: 2100,
      });
    });

    test("stores and retrieves cumulativeProviderMetadata", () => {
      const aggregator = new StreamingMessageAggregator(TEST_CREATED_AT);

      aggregator.handleUsageDelta({
        type: "usage-delta",
        workspaceId: "ws-1",
        messageId: "msg-1",
        usage: { inputTokens: 1000, outputTokens: 50, totalTokens: 1050 },
        cumulativeUsage: { inputTokens: 1000, outputTokens: 50, totalTokens: 1050 },
        cumulativeProviderMetadata: {
          anthropic: { cacheCreationInputTokens: 500, cacheReadInputTokens: 200 },
        },
      });

      expect(aggregator.getActiveStreamCumulativeProviderMetadata("msg-1")).toEqual({
        anthropic: { cacheCreationInputTokens: 500, cacheReadInputTokens: 200 },
      });
    });

    test("cumulativeProviderMetadata is undefined when not provided", () => {
      const aggregator = new StreamingMessageAggregator(TEST_CREATED_AT);

      aggregator.handleUsageDelta({
        type: "usage-delta",
        workspaceId: "ws-1",
        messageId: "msg-1",
        usage: { inputTokens: 1000, outputTokens: 50, totalTokens: 1050 },
        cumulativeUsage: { inputTokens: 1000, outputTokens: 50, totalTokens: 1050 },
        // No cumulativeProviderMetadata
      });

      expect(aggregator.getActiveStreamCumulativeProviderMetadata("msg-1")).toBeUndefined();
    });

    test("stores and retrieves step providerMetadata for cache creation display", () => {
      const aggregator = new StreamingMessageAggregator(TEST_CREATED_AT);

      aggregator.handleUsageDelta({
        type: "usage-delta",
        workspaceId: "ws-1",
        messageId: "msg-1",
        usage: { inputTokens: 1000, outputTokens: 50, totalTokens: 1050 },
        cumulativeUsage: { inputTokens: 1000, outputTokens: 50, totalTokens: 1050 },
        providerMetadata: {
          anthropic: { cacheCreationInputTokens: 800 },
        },
      });

      expect(aggregator.getActiveStreamStepProviderMetadata("msg-1")).toEqual({
        anthropic: { cacheCreationInputTokens: 800 },
      });
    });

    test("step providerMetadata is undefined when not provided", () => {
      const aggregator = new StreamingMessageAggregator(TEST_CREATED_AT);

      aggregator.handleUsageDelta({
        type: "usage-delta",
        workspaceId: "ws-1",
        messageId: "msg-1",
        usage: { inputTokens: 1000, outputTokens: 50, totalTokens: 1050 },
        cumulativeUsage: { inputTokens: 1000, outputTokens: 50, totalTokens: 1050 },
        // No providerMetadata
      });

      expect(aggregator.getActiveStreamStepProviderMetadata("msg-1")).toBeUndefined();
    });

    test("clearTokenState clears all usage tracking (step, cumulative, metadata)", () => {
      const aggregator = new StreamingMessageAggregator(TEST_CREATED_AT);

      aggregator.handleUsageDelta({
        type: "usage-delta",
        workspaceId: "ws-1",
        messageId: "msg-1",
        usage: { inputTokens: 1000, outputTokens: 50, totalTokens: 1050 },
        cumulativeUsage: { inputTokens: 1000, outputTokens: 50, totalTokens: 1050 },
        providerMetadata: { anthropic: { cacheCreationInputTokens: 300 } },
        cumulativeProviderMetadata: { anthropic: { cacheCreationInputTokens: 500 } },
      });

      // All should be defined
      expect(aggregator.getActiveStreamUsage("msg-1")).toBeDefined();
      expect(aggregator.getActiveStreamStepProviderMetadata("msg-1")).toBeDefined();
      expect(aggregator.getActiveStreamCumulativeUsage("msg-1")).toBeDefined();
      expect(aggregator.getActiveStreamCumulativeProviderMetadata("msg-1")).toBeDefined();

      aggregator.clearTokenState("msg-1");

      // All should be cleared
      expect(aggregator.getActiveStreamUsage("msg-1")).toBeUndefined();
      expect(aggregator.getActiveStreamStepProviderMetadata("msg-1")).toBeUndefined();
      expect(aggregator.getActiveStreamCumulativeUsage("msg-1")).toBeUndefined();
      expect(aggregator.getActiveStreamCumulativeProviderMetadata("msg-1")).toBeUndefined();
    });

    test("multi-step scenario: step usage replaced, cumulative accumulated", () => {
      const aggregator = new StreamingMessageAggregator(TEST_CREATED_AT);

      // Step 1: Initial request with cache creation
      aggregator.handleUsageDelta({
        type: "usage-delta",
        workspaceId: "ws-1",
        messageId: "msg-1",
        usage: { inputTokens: 1000, outputTokens: 50, totalTokens: 1050 },
        cumulativeUsage: { inputTokens: 1000, outputTokens: 50, totalTokens: 1050 },
        cumulativeProviderMetadata: { anthropic: { cacheCreationInputTokens: 800 } },
      });

      // Verify step 1 state
      expect(aggregator.getActiveStreamUsage("msg-1")?.inputTokens).toBe(1000);
      expect(aggregator.getActiveStreamCumulativeUsage("msg-1")?.inputTokens).toBe(1000);
      expect(
        (
          aggregator.getActiveStreamCumulativeProviderMetadata("msg-1")?.anthropic as {
            cacheCreationInputTokens: number;
          }
        ).cacheCreationInputTokens
      ).toBe(800);

      // Step 2: After tool call, larger context, more cache creation
      aggregator.handleUsageDelta({
        type: "usage-delta",
        workspaceId: "ws-1",
        messageId: "msg-1",
        usage: { inputTokens: 1500, outputTokens: 100, totalTokens: 1600 }, // Last step only
        cumulativeUsage: { inputTokens: 2500, outputTokens: 150, totalTokens: 2650 }, // Sum of all
        cumulativeProviderMetadata: { anthropic: { cacheCreationInputTokens: 1200 } }, // Sum of all
      });

      // Step usage should be REPLACED (last step only)
      expect(aggregator.getActiveStreamUsage("msg-1")).toEqual({
        inputTokens: 1500,
        outputTokens: 100,
        totalTokens: 1600,
      });

      // Cumulative usage should show SUM of all steps
      expect(aggregator.getActiveStreamCumulativeUsage("msg-1")).toEqual({
        inputTokens: 2500,
        outputTokens: 150,
        totalTokens: 2650,
      });

      // Cumulative metadata should show SUM of cache creation tokens
      expect(aggregator.getActiveStreamCumulativeProviderMetadata("msg-1")).toEqual({
        anthropic: { cacheCreationInputTokens: 1200 },
      });
    });
  });

  describe("nested tool calls (PTC code_execution)", () => {
    test("adds nested call to parent tool part on tool-call-start with parentToolCallId", () => {
      const aggregator = createTestAggregator();
      startParentTool(aggregator, "mux.file_read({ filePath: 'test.txt' })");
      startToolCall(aggregator, {
        toolCallId: "nested-tool-1",
        toolName: "file_read",
        args: { filePath: "test.txt" },
        timestamp: 1100,
        parentToolCallId: "parent-tool-1",
      });

      const toolMsg = parentToolMessage(aggregator);
      expect(toolMsg).toBeDefined();
      if (toolMsg?.type === "tool") {
        expect(toolMsg.nestedCalls).toHaveLength(1);
        expect(toolMsg.nestedCalls![0]).toEqual({
          toolCallId: "nested-tool-1",
          toolName: "file_read",
          state: "input-available",
          input: { filePath: "test.txt" },
          timestamp: 1100,
        });
      }
    });

    test("drops nested starts whose parent part has not streamed in (no ghost top-level row)", () => {
      const aggregator = createTestAggregator();
      startTestStream(aggregator, { messageId: "msg-1" });
      // No parent tool part exists yet; streamManager re-emits the nested
      // events after the parent lands, so the early event must be dropped.
      startToolCall(aggregator, {
        toolCallId: "nested-early-1",
        toolName: "workflow_run",
        args: {},
        timestamp: 1100,
        parentToolCallId: "parent-tool-1",
      });

      expect(
        aggregator
          .getDisplayedMessages()
          .some((m) => m.type === "tool" && m.toolCallId === "nested-early-1")
      ).toBe(false);
    });

    test("skips duplicate nested starts (reconnect replays re-emit them with the parent part)", () => {
      const aggregator = createTestAggregator();
      startParentTool(aggregator);
      for (let i = 0; i < 2; i++) {
        startToolCall(aggregator, {
          toolCallId: "nested-tool-1",
          toolName: "workflow_run",
          args: { script_path: "wf.js" },
          timestamp: 1100,
          parentToolCallId: "parent-tool-1",
        });
      }

      const toolMsg = parentToolMessage(aggregator);
      if (toolMsg?.type !== "tool") {
        throw new Error("Expected parent tool message");
      }
      expect(toolMsg.nestedCalls).toHaveLength(1);
    });

    test("updates nested call with output on tool-call-end with parentToolCallId", () => {
      const aggregator = createTestAggregator();
      startParentTool(aggregator);
      startToolCall(aggregator, {
        toolCallId: "nested-tool-1",
        toolName: "file_read",
        args: { filePath: "test.txt" },
        timestamp: 1100,
        parentToolCallId: "parent-tool-1",
      });
      endToolCall(aggregator, {
        toolCallId: "nested-tool-1",
        toolName: "file_read",
        result: { success: true, content: "file content" },
        timestamp: 1200,
        parentToolCallId: "parent-tool-1",
      });

      const toolMsg = parentToolMessage(aggregator);
      if (toolMsg?.type === "tool") {
        expect(toolMsg.nestedCalls).toHaveLength(1);
        expect(toolMsg.nestedCalls![0].state).toBe("output-available");
        expect(toolMsg.nestedCalls![0].output).toEqual({
          success: true,
          content: "file content",
        });
      }
    });

    test("handles multiple nested calls in sequence", () => {
      const aggregator = createTestAggregator();
      startParentTool(aggregator, "multi-tool code");

      for (const nested of [
        {
          toolCallId: "nested-1",
          toolName: "file_read",
          args: { filePath: "a.txt" },
          result: { success: true, content: "content A" },
          start: 1100,
          end: 1150,
        },
        {
          toolCallId: "nested-2",
          toolName: "bash",
          args: { script: "echo hello" },
          result: { success: true, output: "hello" },
          start: 1200,
          end: 1250,
        },
      ]) {
        startToolCall(aggregator, {
          toolCallId: nested.toolCallId,
          toolName: nested.toolName,
          args: nested.args,
          timestamp: nested.start,
          parentToolCallId: "parent-tool-1",
        });
        endToolCall(aggregator, {
          toolCallId: nested.toolCallId,
          toolName: nested.toolName,
          result: nested.result,
          timestamp: nested.end,
          parentToolCallId: "parent-tool-1",
        });
      }

      const toolMsg = parentToolMessage(aggregator);
      if (toolMsg?.type === "tool") {
        expect(toolMsg.nestedCalls).toHaveLength(2);
        expect(toolMsg.nestedCalls![0].toolName).toBe("file_read");
        expect(toolMsg.nestedCalls![0].state).toBe("output-available");
        expect(toolMsg.nestedCalls![1].toolName).toBe("bash");
        expect(toolMsg.nestedCalls![1].state).toBe("output-available");
      }
    });

    test("nested call end is ignored if nested call not found in parent", () => {
      const aggregator = createTestAggregator();
      startParentTool(aggregator);
      endToolCall(aggregator, {
        toolCallId: "unknown-nested",
        toolName: "file_read",
        result: { success: true },
        timestamp: 1100,
        parentToolCallId: "parent-tool-1",
      });

      const toolMsg = parentToolMessage(aggregator);
      expect(toolMsg).toBeDefined();
      if (toolMsg?.type === "tool") {
        expect(toolMsg.nestedCalls ?? []).toHaveLength(0);
      }
    });
  });

  describe("abort reason tracking", () => {
    test("stores last abort reason and clears on stream-start", () => {
      const aggregator = new StreamingMessageAggregator(TEST_CREATED_AT);

      aggregator.handleStreamAbort({
        type: "stream-abort",
        workspaceId: "test-workspace",
        messageId: "msg-1",
        abortReason: "startup",
      });

      expect(aggregator.getLastAbortReason()?.reason).toBe("startup");

      aggregator.handleStreamStart({
        type: "stream-start",
        workspaceId: "test-workspace",
        messageId: "msg-1",
        historySequence: 1,
        model: "claude-3-5-sonnet-20241022",
        startTime: Date.now(),
      });

      expect(aggregator.getLastAbortReason()).toBeNull();
    });

    test("clears last abort reason on new user message", () => {
      const aggregator = new StreamingMessageAggregator(TEST_CREATED_AT);

      aggregator.handleStreamAbort({
        type: "stream-abort",
        workspaceId: "test-workspace",
        messageId: "msg-1",
        abortReason: "user",
      });

      aggregator.handleMessage({
        ...createMuxMessage("user-1", "user", "Hello", { historySequence: 1 }),
        type: "message",
      });

      expect(aggregator.getLastAbortReason()).toBeNull();
    });

    test("clears last abort reason on clear", () => {
      const aggregator = new StreamingMessageAggregator(TEST_CREATED_AT);

      aggregator.handleStreamAbort({
        type: "stream-abort",
        workspaceId: "test-workspace",
        messageId: "msg-1",
        abortReason: "user",
      });

      aggregator.clear();

      expect(aggregator.getLastAbortReason()).toBeNull();
    });
  });

  describe("max output tokens (finishReason: length)", () => {
    // Regression: an assistant turn that hits max_tokens mid-thinking has
    // `finishReason: "length"` and only reasoning parts. Without explicit UI
    // surfacing, ReasoningMessage auto-collapses on stream-end, leaving the
    // user staring at a single "Thinking" header with no signal that the turn
    // truncated. SMA must synthesize a stream-error row and mark the reasoning
    // row as the only renderable content so collapse is suppressed.
    test("synthesizes a max_output_tokens stream-error row for reasoning-only truncated turns", () => {
      const aggregator = new StreamingMessageAggregator(TEST_CREATED_AT);

      aggregator.addMessage({
        id: "asst-truncated",
        role: "assistant",
        parts: [{ type: "reasoning" as const, text: "I need to think about this..." }],
        metadata: {
          historySequence: 1,
          timestamp: 1,
          model: "anthropic:claude-opus-4-7",
          finishReason: "length",
        },
      });

      const displayed = aggregator.getDisplayedMessages();

      const errorRow = displayed.find((m) => m.type === "stream-error");
      expect(errorRow).toBeDefined();
      if (errorRow?.type === "stream-error") {
        expect(errorRow.errorType).toBe("max_output_tokens");
        expect(errorRow.historyId).toBe("asst-truncated");
        expect(errorRow.model).toBe("anthropic:claude-opus-4-7");
      }

      const reasoningRow = displayed.find((m) => m.type === "reasoning");
      expect(reasoningRow).toBeDefined();
      if (reasoningRow?.type === "reasoning") {
        expect(reasoningRow.isOnlyMessageContent).toBe(true);
      }
    });

    test("still synthesizes the row when the turn also has text/tool parts", () => {
      // A truncated turn can include earlier text or tool calls; the user still
      // needs the banner so they know the response was cut off mid-flight.
      const aggregator = new StreamingMessageAggregator(TEST_CREATED_AT);

      aggregator.addMessage({
        id: "asst-mixed-truncated",
        role: "assistant",
        parts: [
          { type: "reasoning" as const, text: "thinking" },
          { type: "text" as const, text: "Partial reply" },
        ],
        metadata: {
          historySequence: 1,
          timestamp: 1,
          model: "anthropic:claude-opus-4-7",
          finishReason: "length",
        },
      });

      const displayed = aggregator.getDisplayedMessages();
      const errorRow = displayed.find((m) => m.type === "stream-error");
      expect(errorRow).toBeDefined();
      expect(errorRow?.type === "stream-error" && errorRow.errorType).toBe("max_output_tokens");

      // Reasoning here is *not* the only content, so collapse should be allowed.
      const reasoningRow = displayed.find((m) => m.type === "reasoning");
      if (reasoningRow?.type === "reasoning") {
        expect(reasoningRow.isOnlyMessageContent).toBe(false);
      }
    });

    test("treats reasoning + skipped (empty-text) parts as reasoning-only", () => {
      // Regression: assistant turns can contain non-renderable parts like empty
      // text (the renderer's predicate filters them out). The
      // `isOnlyMessageContent` flag must use that same predicate, otherwise a
      // turn that visually consists of only a reasoning block still gets
      // auto-collapsed when it ends — exactly the silent-end UX this PR fixes.
      const aggregator = new StreamingMessageAggregator(TEST_CREATED_AT);

      aggregator.addMessage({
        id: "asst-reasoning-and-empty-text",
        role: "assistant",
        parts: [
          { type: "reasoning" as const, text: "thinking..." },
          { type: "text" as const, text: "" },
        ],
        metadata: {
          historySequence: 1,
          timestamp: 1,
          model: "anthropic:claude-opus-4-7",
          finishReason: "length",
        },
      });

      const displayed = aggregator.getDisplayedMessages();
      const reasoningRow = displayed.find((m) => m.type === "reasoning");
      expect(reasoningRow).toBeDefined();
      if (reasoningRow?.type === "reasoning") {
        expect(reasoningRow.isOnlyMessageContent).toBe(true);
      }
      // Empty text part should not produce an assistant row at all.
      expect(displayed.find((m) => m.type === "assistant")).toBeUndefined();
    });

    test("survives malformed text parts in persisted history", () => {
      // Self-healing: chat.jsonl is loaded via plain JSON parse, so an entry
      // with `type: "text"` but a missing/non-string `text` field is reachable.
      // getDisplayedMessages must not crash on this — it should just skip the
      // bad part and continue.
      const aggregator = new StreamingMessageAggregator(TEST_CREATED_AT);

      aggregator.addMessage({
        id: "asst-malformed",
        role: "assistant",
        parts: [
          { type: "reasoning" as const, text: "thinking" },
          // Cast through unknown to model a malformed history entry.
          { type: "text" } as unknown as { type: "text"; text: string },
        ],
        metadata: {
          historySequence: 1,
          timestamp: 1,
          model: "anthropic:claude-opus-4-7",
          finishReason: "length",
        },
      });

      // The call itself must not throw.
      const displayed = aggregator.getDisplayedMessages();
      expect(displayed.find((m) => m.type === "reasoning")).toBeDefined();
      expect(displayed.find((m) => m.type === "stream-error")).toBeDefined();
    });

    test("does not synthesize the row when finishReason is a normal stop", () => {
      const aggregator = new StreamingMessageAggregator(TEST_CREATED_AT);

      aggregator.addMessage({
        id: "asst-normal",
        role: "assistant",
        parts: [{ type: "text" as const, text: "All done." }],
        metadata: {
          historySequence: 1,
          timestamp: 1,
          model: "anthropic:claude-opus-4-7",
          finishReason: "stop",
        },
      });

      const displayed = aggregator.getDisplayedMessages();
      expect(displayed.find((m) => m.type === "stream-error")).toBeUndefined();
    });

    test("does not stack a length banner on top of an existing stream error", () => {
      // If the message already failed with a real error, that takes precedence —
      // we don't want two banners on the same turn.
      const aggregator = new StreamingMessageAggregator(TEST_CREATED_AT);

      aggregator.addMessage({
        id: "asst-errored",
        role: "assistant",
        parts: [{ type: "reasoning" as const, text: "hmm" }],
        metadata: {
          historySequence: 1,
          timestamp: 1,
          model: "anthropic:claude-opus-4-7",
          finishReason: "length",
          error: "Network timed out",
          errorType: "network",
        },
      });

      const displayed = aggregator.getDisplayedMessages();
      const errorRows = displayed.filter((m) => m.type === "stream-error");
      expect(errorRows).toHaveLength(1);
      expect(errorRows[0]?.type === "stream-error" && errorRows[0].errorType).toBe("network");
    });
  });

  describe("refusal finish reasons", () => {
    test("synthesizes a visible refusal row for legacy content-filter completions", () => {
      const aggregator = new StreamingMessageAggregator(TEST_CREATED_AT);

      aggregator.addMessage({
        id: "asst-refused",
        role: "assistant",
        parts: [{ type: "text" as const, text: "I checked the security report." }],
        metadata: {
          historySequence: 1,
          timestamp: 1,
          model: "anthropic:claude-fable-5",
          finishReason: "content-filter",
          providerMetadata: {
            anthropic: {
              stopDetails: {
                explanation: "This request triggered restrictions on cyber content.",
              },
            },
          },
        },
      });

      const displayed = aggregator.getDisplayedMessages();
      const errorRow = displayed.find((message) => message.type === "stream-error");
      expect(errorRow).toBeDefined();
      if (errorRow?.type === "stream-error") {
        expect(errorRow.errorType).toBe("model_refusal");
        expect(errorRow.error).toContain("finishReason: content-filter");
        expect(errorRow.error).toContain("triggered restrictions");
      }
    });

    test("does not render a red refusal row for successful fallback completions", () => {
      const aggregator = new StreamingMessageAggregator(TEST_CREATED_AT);

      aggregator.addMessage({
        id: "asst-fallback-success",
        role: "assistant",
        parts: [{ type: "text" as const, text: "Fallback finished the response." }],
        metadata: {
          historySequence: 1,
          timestamp: 1,
          model: "openai:gpt-5.5",
          finishReason: "stop",
          modelFallback: {
            requestedModel: "anthropic:claude-fable-5",
            refusedModels: ["anthropic:claude-fable-5"],
          },
        },
      });

      const displayed = aggregator.getDisplayedMessages();
      expect(displayed.find((message) => message.type === "stream-error")).toBeUndefined();
    });
  });
});

/**
 * Tests for `review_pane_update` -> assistedReviewHunks bookkeeping.
 *
 * Cover the metadata bits the aggregator tracks for the assisted-review UI:
 *   - addedAt: set on first sight of each pin's path[:range] key during a
 *     live update, used to drive the transient "new" badge. Replay
 *     intentionally skips this so historical pins don't flash as "new" on
 *     initial load.
 *   - Carryover: re-flagging an existing key with `operation: "add"`
 *     preserves the original `addedAt` so a refined comment does not make
 *     the pin look brand-new.
 *   - Dedup: a fresh `replace` snapshot drops keys that aren't reincluded.
 *
 * Lives in this file (rather than its own test file) so test ordering stays
 * stable — adding a new `*.test.ts` shifts the alphabetical order across the
 * suite, which has historically exposed latent pollution in unrelated tests.
 */
function historicalReviewPaneUpdateMessage(
  id: string,
  hunks: Array<{ path: string; comment?: string | null }>,
  operation: "add" | "replace" = "replace",
  options: { historySequence?: number; toolCallId?: string } = {}
) {
  const message = createMuxMessage(id, "assistant", "", {
    historySequence: options.historySequence ?? 1,
    timestamp: Date.now(),
    muxMetadata: { type: "normal", requestedModel: TEST_MODEL },
  });
  message.parts.push({
    type: "dynamic-tool",
    toolCallId: options.toolCallId ?? `tc-${id}`,
    toolName: "review_pane_update",
    state: "output-available",
    input: { operation, hunks: hunks.map((h) => ({ path: h.path })) },
    output: { success: true, operation, hunks },
  });
  return message;
}

describe("review_pane_update -> assistedReviewHunks", () => {
  test("replay parses pins without lighting up the addedAt badge", () => {
    // Initial-load case: we never want replayed history to flash the
    // transient "new" badge. The aggregator deliberately omits the
    // timestamp on replay, so addedAt stays undefined for every pin.
    const aggregator = new StreamingMessageAggregator(TEST_CREATED_AT);
    aggregator.loadHistoricalMessages([
      historicalReviewPaneUpdateMessage("assistant-1", [
        { path: "src/foo.ts:10-12", comment: "double-check" },
        { path: "src/bar.ts", comment: null },
      ]),
    ]);

    const pins = aggregator.getAssistedReviewHunks();
    expect(pins).toHaveLength(2);
    expect(pins[0].path).toBe("src/foo.ts");
    expect(pins[0].range).toEqual({ start: 10, end: 12 });
    expect(pins[0].addedAt).toBeUndefined();

    expect(pins[1].path).toBe("src/bar.ts");
    expect(pins[1].addedAt).toBeUndefined();
  });

  test("`add` re-flagging an existing path:range refines the comment in place", () => {
    // `add` semantics: dedup the existing key, but let the latest comment
    // win so an agent can revise its rationale without producing a second
    // pin for the same range.
    const aggregator = new StreamingMessageAggregator(TEST_CREATED_AT);
    aggregator.loadHistoricalMessages([
      historicalReviewPaneUpdateMessage(
        "assistant-1",
        [{ path: "src/foo.ts:10-12", comment: "look at parser" }],
        "replace",
        { historySequence: 1 }
      ),
      historicalReviewPaneUpdateMessage(
        "assistant-2",
        [{ path: "src/foo.ts:10-12", comment: "look at parser (revised)" }],
        "add",
        { historySequence: 2, toolCallId: "tc-2" }
      ),
    ]);

    const refreshed = aggregator.getAssistedReviewHunks();
    expect(refreshed).toHaveLength(1);
    // Last-writer-wins on the comment for duplicate keys under `add`.
    expect(refreshed[0].comment).toBe("look at parser (revised)");
  });

  test("a `replace` drops keys that the new snapshot does not reinclude", () => {
    // Sanity check: when the agent replaces the set, dropped keys vanish.
    const aggregator = new StreamingMessageAggregator(TEST_CREATED_AT);
    aggregator.loadHistoricalMessages([
      historicalReviewPaneUpdateMessage(
        "assistant-1",
        [{ path: "src/foo.ts", comment: null }],
        "replace",
        { historySequence: 1 }
      ),
      historicalReviewPaneUpdateMessage(
        "assistant-2",
        [{ path: "src/bar.ts", comment: null }],
        "replace",
        { historySequence: 2, toolCallId: "tc-2" }
      ),
    ]);

    const pins = aggregator.getAssistedReviewHunks();
    expect(pins).toHaveLength(1);
    expect(pins[0].path).toBe("src/bar.ts");
  });
});

/**
 * Tests for notify tool results -> Web Notifications routing.
 *
 * The notify tool persists its routing metadata (`notifiedVia: "browser"`) in
 * history, so the aggregator must fire Web Notifications only for live tool
 * results. History hydration and reconnect replay re-process the same outputs
 * on every workspace switch/reload and must stay silent (#2547).
 */
class FakeNotification {
  static permission = "granted";
  static created: Array<{ title: string; body?: string }> = [];
  onclick: (() => void) | null = null;

  constructor(title: string, options?: { body?: string }) {
    FakeNotification.created.push({ title, body: options?.body });
  }

  static requestPermission(): Promise<string> {
    return Promise.resolve("granted");
  }
}

function withFakeNotificationWindow<T>(fn: () => T): T {
  const globalWithWindow = globalThis as unknown as { window?: unknown };
  const previousWindow = globalWithWindow.window;
  FakeNotification.created = [];
  globalWithWindow.window = { Notification: FakeNotification, focus: () => undefined };
  try {
    return fn();
  } finally {
    if (previousWindow === undefined) {
      delete globalWithWindow.window;
    } else {
      globalWithWindow.window = previousWindow;
    }
  }
}

function browserNotifyOutput(title: string, message?: string) {
  return {
    success: true,
    title,
    message,
    ui_only: { notify: { notifiedVia: "browser", workspaceId: TEST_WORKSPACE_ID } },
  };
}

function runNotifyTool(
  aggregator: StreamingMessageAggregator,
  options: { messageId?: string; toolCallId?: string; replay?: boolean } = {}
): void {
  const messageId = options.messageId ?? "msg-1";
  const toolCallId = options.toolCallId ?? "tc-notify";
  startToolCall(aggregator, {
    messageId,
    toolCallId,
    toolName: "notify",
    args: { title: "Task done" },
  });
  endToolCall(aggregator, {
    messageId,
    toolCallId,
    toolName: "notify",
    result: browserNotifyOutput("Task done", "All checks passed"),
    replay: options.replay,
  });
}

describe("notify tool -> browser notifications", () => {
  test("live notify results fire a browser notification", () => {
    withFakeNotificationWindow(() => {
      const aggregator = createTestAggregator();
      startTestStream(aggregator, { messageId: "msg-1" });

      runNotifyTool(aggregator);

      expect(FakeNotification.created).toEqual([{ title: "Task done", body: "All checks passed" }]);
    });
  });

  test("replayed tool-call-end does not re-fire the notification", () => {
    // Reconnect replay re-emits tool-call-end (replay: true) for already-completed
    // calls of an active stream; the user was already notified when it ran live.
    withFakeNotificationWindow(() => {
      const aggregator = createTestAggregator();
      startTestStream(aggregator, { messageId: "msg-1" });

      runNotifyTool(aggregator, { replay: true });

      expect(FakeNotification.created).toEqual([]);
    });
  });

  test("history hydration does not re-fire notifications; later live ones still do", () => {
    // Workspace switches and reloads hydrate the full transcript through
    // loadHistoricalMessages; historical notify results must stay silent.
    withFakeNotificationWindow(() => {
      const aggregator = createTestAggregator();
      const message = createMuxMessage("msg-1", "assistant", "", {
        historySequence: 1,
        timestamp: Date.now(),
        muxMetadata: { type: "normal", requestedModel: TEST_MODEL },
      });
      message.parts.push({
        type: "dynamic-tool",
        toolCallId: "tc-notify",
        toolName: "notify",
        state: "output-available",
        input: { title: "Task done" },
        output: browserNotifyOutput("Task done", "All checks passed"),
      });

      aggregator.loadHistoricalMessages([message]);
      expect(FakeNotification.created).toEqual([]);

      // A genuinely new notify after hydration still notifies.
      startTestStream(aggregator, { messageId: "msg-2", historySequence: 2 });
      runNotifyTool(aggregator, { messageId: "msg-2", toolCallId: "tc-notify-2" });
      expect(FakeNotification.created).toEqual([{ title: "Task done", body: "All checks passed" }]);
    });
  });

  describe("server-issued reconnect cursor", () => {
    test("returns undefined before any server cursor is stored", () => {
      const aggregator = createTestAggregator();
      aggregator.loadHistoricalMessages(
        [createMuxMessage("history-1", "user", "hello", { historySequence: 1, timestamp: 1 })],
        false,
        { mode: "replace" }
      );

      // Local rows alone are not enough: only the server can issue a valid cursor.
      expect(aggregator.getOnChatCursor()).toBeUndefined();
    });

    test("returns the stored server cursor verbatim and clears on null", () => {
      const aggregator = createTestAggregator();
      const serverCursor = {
        messageId: "history-2",
        historySequence: 2,
        oldestHistorySequence: 1,
        priorHistoryFingerprint: "deadbeef",
      };

      aggregator.setServerHistoryCursor(serverCursor);
      expect(aggregator.getOnChatCursor()?.history).toEqual(serverCursor);

      aggregator.setServerHistoryCursor(null);
      expect(aggregator.getOnChatCursor()).toBeUndefined();
    });

    test("clear() drops the stored server cursor", () => {
      const aggregator = createTestAggregator();
      aggregator.setServerHistoryCursor({ messageId: "history-1", historySequence: 1 });
      aggregator.clear();
      expect(aggregator.getOnChatCursor()).toBeUndefined();
    });
  });

  describe("since-replay suffix reconciliation", () => {
    const persistedRow = (
      id: string,
      historySequence: number,
      texts: string[],
      role: "user" | "assistant" = "assistant"
    ) => {
      // createMuxMessage rejects empty user messages, so build with placeholder
      // content and overwrite parts with the exact persisted-form layout.
      const message = createMuxMessage(id, role, "placeholder", {
        historySequence,
        timestamp: historySequence * 100,
      });
      message.parts = texts.map((text) => ({ type: "text" as const, text }));
      return message;
    };

    test("removes local suffix rows the server did not re-send", () => {
      const aggregator = createTestAggregator();
      aggregator.loadHistoricalMessages(
        [
          persistedRow("user-1", 1, ["hello"], "user"),
          persistedRow("assistant-2", 2, ["kept"]),
          persistedRow("assistant-3", 3, ["deleted server-side while away"]),
        ],
        false,
        { mode: "replace" }
      );

      aggregator.reconcileSinceReplay({
        requestedAnchorSequence: 2,
        messages: [persistedRow("assistant-2", 2, ["kept"])],
        hasActiveStream: false,
      });

      expect(aggregator.getAllMessages().map((message) => message.id)).toEqual([
        "user-1",
        "assistant-2",
      ]);
    });

    test("replaces rewritten rows even when the persisted form has fewer parts", () => {
      const aggregator = createTestAggregator();
      aggregator.loadHistoricalMessages(
        [
          persistedRow("user-1", 1, ["hello"], "user"),
          persistedRow("assistant-2", 2, ["a", "b", "c"]),
        ],
        false,
        { mode: "replace" }
      );

      aggregator.reconcileSinceReplay({
        requestedAnchorSequence: 2,
        messages: [persistedRow("assistant-2", 2, ["rewritten"])],
        hasActiveStream: false,
      });

      const rewritten = aggregator.getAllMessages().find((message) => message.id === "assistant-2");
      expect(rewritten?.parts).toEqual([{ type: "text", text: "rewritten" }]);
    });

    test("keeps optimistic rows without a historySequence and does not duplicate the boundary row", () => {
      const aggregator = createTestAggregator();
      aggregator.loadHistoricalMessages([persistedRow("assistant-1", 1, ["turn one"])], false, {
        mode: "replace",
      });
      // Optimistic send awaiting ack: no historySequence yet.
      aggregator.addMessage(createMuxMessage("optimistic-1", "user", "queued send"));

      aggregator.reconcileSinceReplay({
        requestedAnchorSequence: 1,
        messages: [persistedRow("assistant-1", 1, ["turn one"])],
        hasActiveStream: false,
      });

      const ids = aggregator.getAllMessages().map((message) => message.id);
      expect(ids.filter((id) => id === "assistant-1")).toHaveLength(1);
      expect(ids).toContain("optimistic-1");
    });

    test("drops derived state sourced from a removed suffix row", () => {
      const aggregator = createTestAggregator();
      const todos = [{ content: "task", status: "in_progress" as const }];
      aggregator.loadHistoricalMessages(
        [
          persistedRow("user-1", 1, ["hello"], "user"),
          historicalTodoMessage("todo-row", todos, { historySequence: 3 }),
        ],
        false,
        { mode: "replace" }
      );
      expect(aggregator.getCurrentTodos()).toEqual(todos);

      // The todo-bearing row was deleted server-side while the client was away.
      aggregator.reconcileSinceReplay({
        requestedAnchorSequence: 2,
        messages: [],
        hasActiveStream: false,
      });

      expect(aggregator.getAllMessages().map((message) => message.id)).toEqual(["user-1"]);
      expect(aggregator.getCurrentTodos()).toEqual([]);
    });

    test("rebuilds derived state from surviving rows when a suffix source is removed", () => {
      const aggregator = createTestAggregator();
      const keptTodos = [{ content: "kept", status: "in_progress" as const }];
      const staleTodos = [{ content: "stale", status: "in_progress" as const }];
      aggregator.loadHistoricalMessages(
        [
          historicalTodoMessage("todo-kept", keptTodos, { historySequence: 1 }),
          historicalTodoMessage("todo-stale", staleTodos, { historySequence: 3 }),
        ],
        false,
        { mode: "replace" }
      );
      expect(aggregator.getCurrentTodos()).toEqual(staleTodos);

      aggregator.reconcileSinceReplay({
        requestedAnchorSequence: 2,
        messages: [],
        hasActiveStream: false,
      });

      // Derived state falls back to the surviving todo_write below the anchor.
      expect(aggregator.getCurrentTodos()).toEqual(keptTodos);
    });

    test("preserves the locally assembled active-stream row when the carve-out applies", () => {
      const aggregator = createTestAggregator();
      aggregator.loadHistoricalMessages([persistedRow("user-1", 1, ["hello"], "user")], false, {
        mode: "replace",
      });

      startTestStream(aggregator, { messageId: "msg-live", historySequence: 2 });
      aggregator.handleStreamDelta({
        type: "stream-delta",
        workspaceId: TEST_WORKSPACE_ID,
        messageId: "msg-live",
        delta: "Hello ",
        tokens: 1,
        timestamp: 1_001,
      });
      aggregator.handleStreamDelta({
        type: "stream-delta",
        workspaceId: TEST_WORKSPACE_ID,
        messageId: "msg-live",
        delta: "world",
        tokens: 1,
        timestamp: 1_002,
      });

      // The persisted placeholder for an in-flight stream has empty parts.
      aggregator.reconcileSinceReplay({
        requestedAnchorSequence: 1,
        messages: [persistedRow("user-1", 1, ["hello"], "user"), persistedRow("msg-live", 2, [])],
        preservedActiveStreamMessageId: "msg-live",
        hasActiveStream: true,
      });

      const liveRow = aggregator.getAllMessages().find((message) => message.id === "msg-live");
      expect(liveRow?.parts).toEqual([{ type: "text", text: "Hello world", timestamp: 1_001 }]);
      expect(aggregator.getActiveStreamMessageId()).toBe("msg-live");

      // Stream ending right after caught-up still finalizes the preserved message.
      aggregator.handleStreamEnd({
        type: "stream-end",
        workspaceId: TEST_WORKSPACE_ID,
        messageId: "msg-live",
        metadata: { model: TEST_MODEL, historySequence: 2, timestamp: 1_003 },
        parts: [],
      });
      const finalized = aggregator.getAllMessages().find((message) => message.id === "msg-live");
      expect(finalized?.parts).toEqual([{ type: "text", text: "Hello world", timestamp: 1_001 }]);
      expect(aggregator.getActiveStreamMessageId()).toBeUndefined();
    });

    test("rebuilds the stream row from persisted form when no carve-out applies", () => {
      const aggregator = createTestAggregator();
      aggregator.loadHistoricalMessages([persistedRow("user-1", 1, ["hello"], "user")], false, {
        mode: "replace",
      });

      // Local stream context went stale (e.g. stream A ended while away); the store
      // clears mismatched stream contexts before reconciling, so no carve-out applies
      // and the persisted (finalized) form wins over the richer local assembly.
      startTestStream(aggregator, { messageId: "msg-old", historySequence: 2 });
      aggregator.handleStreamDelta({
        type: "stream-delta",
        workspaceId: TEST_WORKSPACE_ID,
        messageId: "msg-old",
        delta: "locally assembled much longer content",
        tokens: 1,
        timestamp: 1_001,
      });
      aggregator.clearActiveStreams();

      aggregator.reconcileSinceReplay({
        requestedAnchorSequence: 1,
        messages: [
          persistedRow("user-1", 1, ["hello"], "user"),
          persistedRow("msg-old", 2, ["final"]),
        ],
        hasActiveStream: false,
      });

      const rebuilt = aggregator.getAllMessages().find((message) => message.id === "msg-old");
      expect(rebuilt?.parts).toEqual([{ type: "text", text: "final" }]);
    });
  });
});

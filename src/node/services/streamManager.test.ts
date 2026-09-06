import { describe, test, expect, afterEach, beforeEach, mock, spyOn } from "bun:test";
import * as fs from "node:fs/promises";
import { existsSync } from "node:fs";
import * as path from "node:path";

import { KNOWN_MODELS } from "@/common/constants/knownModels";
import type { ProvidersConfigMap } from "@/common/orpc/types";
import { StreamEndEventSchema, ToolCallStartEventSchema } from "@/common/orpc/schemas/stream";
import type {
  CompletedMessagePart,
  ToolCallEndEvent,
  ToolCallExecutionStartEvent,
  ToolCallStartEvent,
  WorkflowRunAttachedEvent,
} from "@/common/types/stream";
import type { MuxMessage } from "@/common/types/message";
import type { WorkflowRunRecord } from "@/common/types/workflow";
import { Ok, Err } from "@/common/types/result";
import type { ToolPolicy } from "@/common/utils/tools/toolPolicy";
import type { ToolSearchStreamState } from "@/common/utils/tools/toolCatalog";
import {
  StreamManager,
  type ModelFallbackPrepareOptions,
  type TurnEngineEvent,
  type TurnCompletion,
  type TurnExecutionOptions,
} from "./streamManager";
import type {
  ActiveTurnThinkingOverride,
  RebuildFirstStepForThinkingLevel,
  RebuildProviderOptionsForThinkingLevel,
} from "./thinkingOverride";
import { stripEncryptedContent } from "@/node/utils/messages/stripEncryptedContent";
import * as aiSdk from "ai";
import {
  APICallError,
  RetryError,
  tool,
  type LanguageModel,
  type ModelMessage,
  type Tool,
} from "ai";
import { z } from "zod";
import * as modelStatsModule from "@/common/utils/tokens/modelStats";
import { SessionUsageService } from "./sessionUsageService";
import type { HistoryService } from "./historyService";
import { createTestHistoryService } from "./testHistoryService";
import { makeTestEffectRunner } from "./di/testEffectRunner";
import { closeScopeBounded } from "./di/appRuntime";
import { Scope } from "effect";
import { createAnthropic } from "@ai-sdk/anthropic";
import { countTokens } from "@/node/utils/main/tokenizer";
import * as tokenizer from "@/node/utils/main/tokenizer";
import { shouldRunIntegrationTests, validateApiKeys } from "../../../tests/testUtils";
import { DisposableTempDir } from "@/node/services/tempDir";
import type { ExecOptions, ExecStream, Runtime } from "@/node/runtime/Runtime";
import { createRuntime } from "@/node/runtime/runtimeFactory";
import { attachLanguageModelCleanup } from "./languageModelCleanup";
import { shellQuote } from "@/common/utils/shell";
import { onTurnEngineEvent } from "./streamManager.testHarness";
import { AIService } from "./aiService";
import { InitStateManager } from "./initStateManager";
import { ProviderService } from "./providerService";
import { createAgentSessionHarness } from "./agentSession.testHarness";

function createTestLanguageModel(modelId = "cleanup-model"): LanguageModel {
  return {
    specificationVersion: "v3",
    provider: "test",
    modelId,
    supportedUrls: {},
    doGenerate: () => Promise.reject(new Error("doGenerate is unused in StreamManager tests")),
    doStream: () => Promise.reject(new Error("doStream is unused in StreamManager tests")),
  };
}

// Skip integration tests if TEST_INTEGRATION is not set

// Validate API keys before running tests
if (shouldRunIntegrationTests()) {
  validateApiKeys(["ANTHROPIC_API_KEY"]);
}

// Real HistoryService backed by a temp directory (created fresh per test)
let historyService: HistoryService;
let historyConfig: Awaited<ReturnType<typeof createTestHistoryService>>["config"];
let historyCleanup: () => Promise<void>;

beforeEach(async () => {
  ({
    historyService,
    config: historyConfig,
    cleanup: historyCleanup,
  } = await createTestHistoryService());
});

afterEach(async () => {
  await historyCleanup();
});

function createExecStreamForTests(): ExecStream {
  return {
    stdout: new ReadableStream<Uint8Array>({
      start(controller) {
        controller.close();
      },
    }),
    stderr: new ReadableStream<Uint8Array>({
      start(controller) {
        controller.close();
      },
    }),
    stdin: new WritableStream<Uint8Array>({
      write(_chunk) {
        return Promise.resolve();
      },
      close() {
        return Promise.resolve();
      },
    }),
    exitCode: Promise.resolve(0),
    duration: Promise.resolve(0),
  };
}

const TEST_STREAM_MODEL_ID = KNOWN_MODELS.SONNET.id;
const TEST_USAGE = { inputTokens: 1, outputTokens: 1, totalTokens: 2 };
const LOCAL_TEST_RUNTIME = createRuntime({ type: "local", srcBaseDir: "/tmp" });

/** Base startStream options; scenarios override only what they assert. */
function testStartOptions(
  overrides: Partial<TurnExecutionOptions> &
    Pick<TurnExecutionOptions, "workspaceId" | "messageId" | "model">
): TurnExecutionOptions {
  return {
    messages: [{ role: "user", content: "hello" }],
    modelString: "openai:gpt-4.1-mini",
    historySequence: 1,
    system: "system",
    runtime: LOCAL_TEST_RUNTIME,
    ...overrides,
  };
}

type ProcessStreamWithCleanupForTests = (
  workspaceId: string,
  streamInfo: unknown,
  historySequence: number
) => Promise<void>;

function getPrivateMethodForTests<T extends (...args: never[]) => unknown>(
  streamManager: StreamManager,
  name: string
): T {
  const method: unknown = Reflect.get(streamManager, name);
  expect(typeof method).toBe("function");
  if (typeof method !== "function") {
    throw new Error(`Expected StreamManager.${name} to exist`);
  }
  return method as T;
}

function getProcessStreamWithCleanupForTests(
  streamManager: StreamManager
): ProcessStreamWithCleanupForTests {
  return getPrivateMethodForTests<ProcessStreamWithCleanupForTests>(
    streamManager,
    "processStreamWithCleanup"
  );
}

function getWorkspaceStreamsForTests(streamManager: StreamManager): Map<string, unknown> {
  const workspaceStreams: unknown = Reflect.get(streamManager, "workspaceStreams");
  expect(workspaceStreams instanceof Map).toBe(true);
  if (!(workspaceStreams instanceof Map)) {
    throw new Error("Expected StreamManager.workspaceStreams to be a Map");
  }
  return workspaceStreams as Map<string, unknown>;
}

async function appendPartialAssistantForTests(
  workspaceId: string,
  messageId: string,
  historySequence: number
): Promise<void> {
  const appendResult = await historyService.appendToHistory(workspaceId, {
    id: messageId,
    role: "assistant",
    metadata: { historySequence, partial: true },
    parts: [],
  });
  expect(appendResult.success).toBe(true);
  if (!appendResult.success) {
    throw new Error(appendResult.error);
  }
}

function createStreamResultForTests(
  fullStream: AsyncGenerator<unknown, void, unknown>,
  usage: unknown = TEST_USAGE,
  providerMetadata: unknown = undefined
): Record<string, unknown> {
  return {
    fullStream,
    totalUsage: Promise.resolve(usage),
    usage: Promise.resolve(usage),
    providerMetadata: Promise.resolve(providerMetadata),
    steps: Promise.resolve([]),
  };
}

function createApiCallErrorForTests(overrides: {
  message: string;
  statusCode: number;
  responseBody: string;
  isRetryable: boolean;
  data?: unknown;
  url?: string;
}): APICallError {
  return new APICallError({
    message: overrides.message,
    url: overrides.url ?? "https://api.openai.com/v1/responses",
    requestBodyValues: {},
    statusCode: overrides.statusCode,
    responseHeaders: {},
    responseBody: overrides.responseBody,
    isRetryable: overrides.isRetryable,
    ...(overrides.data !== undefined ? { data: overrides.data } : {}),
  });
}

function createStreamInfoForTests(
  overrides: Record<string, unknown> = {}
): Record<string, unknown> {
  const now = Date.now();
  const model = overrides.model ?? TEST_STREAM_MODEL_ID;
  return {
    state: "streaming",
    streamResult: createStreamResultForTests(
      (async function* emptyStream() {
        await Promise.resolve();
        yield* [];
      })()
    ),
    abortController: new AbortController(),
    messageId: "test-message",
    token: "test-token",
    startTime: now,
    lastPartTimestamp: now,
    toolCompletionTimestamps: new Map<string, number>(),
    pendingWorkflowRunAttachments: new Map<string, unknown>(),
    pendingNestedCalls: new Map<string, unknown[]>(),
    pendingToolExecutionStarts: new Map<string, number>(),
    model,
    metadataModel: overrides.metadataModel ?? model,
    historySequence: 1,
    request: { model: createTestLanguageModel(), messages: [], providerOptions: undefined },
    toolModelUsages: [],
    parts: [],
    lastPartialWriteTime: 0,
    partialWriteTimer: undefined,
    partialWritePromise: undefined,
    processingPromise: Promise.resolve(),
    softInterrupt: { pending: false as const },
    runtimeTempDir: "",
    runtime: LOCAL_TEST_RUNTIME,
    cumulativeUsage: { inputTokens: 0, outputTokens: 0, totalTokens: 0 },
    cumulativeProviderMetadata: undefined,
    didRetryPreviousResponseIdAtStep: false,
    receivedTerminalEvent: false,
    currentStepStartIndex: 0,
    stepStartIndices: [0],
    stepTracker: {},
    ...overrides,
  };
}

function createWorkflowRunRecordForTests(runId: string, workspaceId: string): WorkflowRunRecord {
  return {
    id: runId,
    workspaceId,
    workflow: {
      name: "deep-research",
      description: "test workflow",
      scope: "project",
      executable: true,
    },
    source: "export default function workflow() { return { reportMarkdown: 'x'.repeat(64) }; }",
    sourceHash: "sha256:test",
    args: {},
    status: "running",
    createdAt: "2026-05-29T00:00:00.000Z",
    updatedAt: "2026-05-29T00:00:01.000Z",
    events: [],
    steps: [],
  };
}

describe("StreamManager - event sink rejection containment", () => {
  test("a rejecting async event sink does not become an unhandled rejection", async () => {
    const unhandled: unknown[] = [];
    const onUnhandled = (reason: unknown) => {
      unhandled.push(reason);
    };
    process.on("unhandledRejection", onUnhandled);
    try {
      const streamManager = new StreamManager(historyService, undefined, undefined, () =>
        Promise.reject(new Error("sink boom"))
      );
      const emitTurnEvent = getPrivateMethodForTests<(event: TurnEngineEvent) => void>(
        streamManager,
        "emitTurnEvent"
      );
      emitTurnEvent.call(streamManager, {
        type: "workflow-run-attached",
        workspaceId: "sink-rejection-workspace",
        messageId: "sink-rejection-message",
        toolCallId: "sink-rejection-call",
        runId: "wfr_sink",
        timestamp: Date.now(),
      });
      // A macrotask so an uncontained rejection would surface before asserting.
      await new Promise((resolve) => setTimeout(resolve, 10));
      expect(unhandled).toHaveLength(0);
    } finally {
      process.off("unhandledRejection", onUnhandled);
    }
  });
});

describe("StreamManager - workflow run attachments", () => {
  test("persists attached workflow run metadata to partial immediately", async () => {
    const streamManager = new StreamManager(historyService);
    const workspaceId = "workflow-attachment-workspace";
    const messageId = "workflow-attachment-message";
    const timestamp = Date.now();
    const streamInfo = createStreamInfoForTests({
      messageId,
      lastPartialWriteTime: timestamp,
      pendingWorkflowRunAttachments: undefined,
      parts: [
        {
          type: "dynamic-tool",
          toolCallId: "workflow-call-1",
          toolName: "workflow_run",
          input: { name: "deep-research", args: {} },
          state: "input-available",
          timestamp,
        },
      ],
    });

    getWorkspaceStreamsForTests(streamManager).set(workspaceId, streamInfo);

    const attached = await streamManager.attachWorkflowRunToToolCall({
      type: "workflow-run-attached",
      workspaceId,
      messageId,
      toolCallId: "workflow-call-1",
      runId: "wfr_attached",
      timestamp: timestamp + 1,
    });

    expect(attached).toBe(true);
    const partial = await historyService.readPartial(workspaceId);
    const part = partial?.parts[0];
    if (part?.type !== "dynamic-tool") {
      throw new Error("Expected workflow tool part in persisted partial");
    }
    expect(part.workflowRun).toEqual({
      runId: "wfr_attached",
      timestamp: timestamp + 1,
    });
  });

  test("persists workflow attachments onto nested kernel tool calls", async () => {
    const streamManager = new StreamManager(historyService);
    const workspaceId = "workflow-nested-attachment-workspace";
    const messageId = "workflow-nested-attachment-message";
    const timestamp = Date.now();
    const streamInfo = createStreamInfoForTests({
      messageId,
      lastPartialWriteTime: timestamp,
      parts: [
        {
          type: "dynamic-tool",
          toolCallId: "code-exec-1",
          toolName: "code_execution",
          input: { code: "mux.workflow_run({...})" },
          state: "input-available",
          timestamp,
          nestedCalls: [
            {
              toolCallId: "nested-workflow-1",
              toolName: "workflow_run",
              // Kernel bounding replaced the launch args with a marker; the
              // attachment is the only durable run identity for this call.
              input: { __kernelBounded: true, bytes: 18_457, preview: "{…}" },
              state: "input-available",
              timestamp,
            },
          ],
        },
      ],
    });

    getWorkspaceStreamsForTests(streamManager).set(workspaceId, streamInfo);

    const attached = await streamManager.attachWorkflowRunToToolCall({
      type: "workflow-run-attached",
      workspaceId,
      messageId,
      toolCallId: "nested-workflow-1",
      runId: "wfr_nested",
      // The live event carries the full run record (large source/args),
      // exactly what kernel bounding keeps out of the nested record.
      run: createWorkflowRunRecordForTests("wfr_nested", workspaceId),
      timestamp: timestamp + 1,
    });

    expect(attached).toBe(true);
    const partial = await historyService.readPartial(workspaceId);
    const part = partial?.parts[0];
    if (part?.type !== "dynamic-tool") {
      throw new Error("Expected code_execution tool part in persisted partial");
    }
    // Identity only: persisting the run record (source, args) would bypass the
    // kernel record caps via partial.json.
    expect(part.nestedCalls?.[0]?.workflowRun).toEqual({
      runId: "wfr_nested",
      timestamp: timestamp + 1,
    });
    // The attachment landed on the nested record, not the pending map.
    expect((streamInfo.pendingWorkflowRunAttachments as Map<string, unknown>).size).toBe(0);
  });

  test("persists workflow attachments that arrive before the tool part", async () => {
    const streamManager = new StreamManager(historyService);
    const workspaceId = "workflow-attachment-race-workspace";
    const messageId = "workflow-attachment-race-message";
    const timestamp = Date.now();
    const streamInfo = createStreamInfoForTests({
      messageId,
      lastPartialWriteTime: timestamp,
      parts: [],
    });

    getWorkspaceStreamsForTests(streamManager).set(workspaceId, streamInfo);

    const attached = await streamManager.attachWorkflowRunToToolCall({
      type: "workflow-run-attached",
      workspaceId,
      messageId,
      toolCallId: "workflow-call-race",
      runId: "wfr_race",
      timestamp: timestamp + 1,
    });

    expect(attached).toBe(true);
    expect(await historyService.readPartial(workspaceId)).toBeNull();

    const appendPartAndEmit = getPrivateMethodForTests<
      (
        workspaceId: string,
        streamInfo: Record<string, unknown>,
        part: CompletedMessagePart,
        schedulePartialWrite?: boolean
      ) => Promise<void>
    >(streamManager, "appendPartAndEmit");

    const replayedAttachments: WorkflowRunAttachedEvent[] = [];
    onTurnEngineEvent(streamManager, "workflow-run-attached", (event: WorkflowRunAttachedEvent) => {
      replayedAttachments.push(event);
    });

    await appendPartAndEmit.call(
      streamManager,
      workspaceId,
      streamInfo,
      {
        type: "dynamic-tool",
        toolCallId: "workflow-call-race",
        toolName: "workflow_run",
        input: { name: "deep-research", args: {} },
        state: "input-available",
        timestamp: timestamp + 2,
      },
      false
    );

    expect(replayedAttachments).toEqual([
      {
        type: "workflow-run-attached",
        workspaceId,
        messageId,
        toolCallId: "workflow-call-race",
        runId: "wfr_race",
        timestamp: timestamp + 1,
      },
    ]);

    const partial = await historyService.readPartial(workspaceId);
    const part = partial?.parts[0];
    if (part?.type !== "dynamic-tool") {
      throw new Error("Expected workflow tool part in persisted partial");
    }
    expect(part.workflowRun).toEqual({
      runId: "wfr_race",
      timestamp: timestamp + 1,
    });
  });
});

describe("StreamManager - nested kernel call race and replay", () => {
  test("buffers nested events that beat the parent part and persists them (with run identity) on merge", async () => {
    const streamManager = new StreamManager(historyService);
    const workspaceId = "nested-race-workspace";
    const messageId = "nested-race-message";
    const timestamp = Date.now();
    const streamInfo = createStreamInfoForTests({
      messageId,
      lastPartialWriteTime: timestamp,
      parts: [],
    });
    getWorkspaceStreamsForTests(streamManager).set(workspaceId, streamInfo);

    // execute() wins the race: nested start arrives before the parent part exists.
    streamManager.emitNestedToolEvent(workspaceId, messageId, {
      type: "tool-call-start",
      callId: "nested-race-workflow",
      toolName: "workflow_run",
      args: { __kernelBounded: true, bytes: 18_457, preview: "{…}" },
      parentToolCallId: "code-exec-race",
      startTime: timestamp,
    });

    // The workflow attachment lands while the nested record is still buffered.
    const attached = await streamManager.attachWorkflowRunToToolCall({
      type: "workflow-run-attached",
      workspaceId,
      messageId,
      toolCallId: "nested-race-workflow",
      runId: "wfr_race_nested",
      run: createWorkflowRunRecordForTests("wfr_race_nested", workspaceId),
      timestamp: timestamp + 1,
    });
    expect(attached).toBe(true);
    // Nothing persisted yet: the parent part has not landed.
    expect(await historyService.readPartial(workspaceId)).toBeNull();

    const appendPartAndEmit = getPrivateMethodForTests<
      (
        workspaceId: string,
        streamInfo: Record<string, unknown>,
        part: CompletedMessagePart,
        schedulePartialWrite?: boolean
      ) => Promise<void>
    >(streamManager, "appendPartAndEmit");
    // The renderer dropped the original raced events, so the merge must
    // re-deliver them once the parent part exists.
    const reEmittedStarts: ToolCallStartEvent[] = [];
    const reEmittedAttachments: WorkflowRunAttachedEvent[] = [];
    onTurnEngineEvent(streamManager, "tool-call-start", (event) => reEmittedStarts.push(event));
    onTurnEngineEvent(streamManager, "workflow-run-attached", (event) =>
      reEmittedAttachments.push(event)
    );
    await appendPartAndEmit.call(
      streamManager,
      workspaceId,
      streamInfo,
      {
        type: "dynamic-tool",
        toolCallId: "code-exec-race",
        toolName: "code_execution",
        input: { code: "mux.workflow_run({...})" },
        state: "input-available",
        timestamp: timestamp + 2,
      },
      false
    );
    const reEmittedStart = reEmittedStarts.find((e) => e.toolCallId === "nested-race-workflow");
    expect(reEmittedStart?.parentToolCallId).toBe("code-exec-race");
    expect(reEmittedAttachments.some((e) => e.toolCallId === "nested-race-workflow")).toBe(true);

    const partial = await historyService.readPartial(workspaceId);
    const part = partial?.parts[0];
    if (part?.type !== "dynamic-tool") {
      throw new Error("Expected code_execution tool part in persisted partial");
    }
    expect(part.nestedCalls).toHaveLength(1);
    expect(part.nestedCalls?.[0]?.toolCallId).toBe("nested-race-workflow");
    // Run identity only (no run record), same bound as the direct attach path.
    expect(part.nestedCalls?.[0]?.workflowRun).toEqual({
      runId: "wfr_race_nested",
      timestamp: timestamp + 1,
    });
    // Both holding areas were consumed.
    expect((streamInfo.pendingNestedCalls as Map<string, unknown>).size).toBe(0);
    expect((streamInfo.pendingWorkflowRunAttachments as Map<string, unknown>).size).toBe(0);
  });

  test("replays persisted nested calls (start, attachment, end) with the parent part", async () => {
    const streamManager = new StreamManager(historyService);
    const workspaceId = "nested-replay-workspace";
    const messageId = "nested-replay-message";
    const timestamp = Date.now();
    const streamInfo = createStreamInfoForTests({
      messageId,
      lastPartialWriteTime: timestamp,
      parts: [
        {
          type: "dynamic-tool",
          toolCallId: "code-exec-replay",
          toolName: "code_execution",
          input: { code: "mux.workflow_run({...})" },
          state: "input-available",
          timestamp,
          nestedCalls: [
            {
              toolCallId: "nested-replay-workflow",
              toolName: "workflow_run",
              input: { __kernelBounded: true, bytes: 18_457, preview: "{…}" },
              state: "output-available",
              output: { __kernelBounded: true, runId: "wfr_replay", status: "running" },
              timestamp: timestamp + 1,
              workflowRun: { runId: "wfr_replay", timestamp: timestamp + 2 },
            },
          ],
        },
      ],
    });
    getWorkspaceStreamsForTests(streamManager).set(workspaceId, streamInfo);

    const starts: ToolCallStartEvent[] = [];
    const attachments: WorkflowRunAttachedEvent[] = [];
    const ends: ToolCallEndEvent[] = [];
    onTurnEngineEvent(streamManager, "tool-call-start", (event) => starts.push(event));
    onTurnEngineEvent(streamManager, "workflow-run-attached", (event) => attachments.push(event));
    onTurnEngineEvent(streamManager, "tool-call-end", (event) => ends.push(event));

    await streamManager.replayStream(workspaceId);

    const nestedStart = starts.find((e) => e.toolCallId === "nested-replay-workflow");
    expect(nestedStart?.parentToolCallId).toBe("code-exec-replay");
    expect(nestedStart?.replay).toBe(true);
    const nestedAttach = attachments.find((e) => e.toolCallId === "nested-replay-workflow");
    expect(nestedAttach?.runId).toBe("wfr_replay");
    const nestedEnd = ends.find((e) => e.toolCallId === "nested-replay-workflow");
    expect(nestedEnd?.parentToolCallId).toBe("code-exec-replay");
  });

  test("incremental replay notices a nested call that completed while disconnected", async () => {
    const streamManager = new StreamManager(historyService);
    const workspaceId = "nested-replay-completion-workspace";
    const messageId = "nested-replay-completion-message";
    const timestamp = Date.now();
    const makeStreamInfo = (completedAt: number) =>
      createStreamInfoForTests({
        messageId,
        lastPartialWriteTime: timestamp,
        toolCompletionTimestamps: new Map([["nested-completed-workflow", completedAt]]),
        parts: [
          {
            type: "dynamic-tool",
            toolCallId: "code-exec-completion",
            toolName: "code_execution",
            input: { code: "mux.workflow_run({...})" },
            state: "input-available",
            timestamp,
            nestedCalls: [
              {
                toolCallId: "nested-completed-workflow",
                toolName: "workflow_run",
                input: {},
                state: "output-available",
                output: { runId: "wfr_done" },
                // Start predates the cursor; only the completion is fresh.
                timestamp,
              },
            ],
          },
        ],
      });
    const cursor = timestamp + 50;

    // Completed after the cursor: the parent must replay.
    getWorkspaceStreamsForTests(streamManager).set(workspaceId, makeStreamInfo(timestamp + 100));
    const starts: ToolCallStartEvent[] = [];
    onTurnEngineEvent(streamManager, "tool-call-start", (event) => starts.push(event));
    await streamManager.replayStream(workspaceId, { afterTimestamp: cursor });
    expect(starts.some((e) => e.toolCallId === "nested-completed-workflow")).toBe(true);

    // Completed before the cursor: nothing fresh, no replay.
    getWorkspaceStreamsForTests(streamManager).set(workspaceId, makeStreamInfo(timestamp + 10));
    starts.length = 0;
    await streamManager.replayStream(workspaceId, { afterTimestamp: cursor });
    expect(starts.some((e) => e.toolCallId === "nested-completed-workflow")).toBe(false);
  });

  test("emitNestedToolEvent records nested completion timestamps", () => {
    const streamManager = new StreamManager(historyService);
    const workspaceId = "nested-completion-record-workspace";
    const messageId = "nested-completion-record-message";
    const timestamp = Date.now();
    const streamInfo = createStreamInfoForTests({
      messageId,
      parts: [
        {
          type: "dynamic-tool",
          toolCallId: "code-exec-ts",
          toolName: "code_execution",
          input: {},
          state: "input-available",
          timestamp,
          nestedCalls: [
            {
              toolCallId: "nested-ts",
              toolName: "bash",
              input: {},
              state: "input-available",
              timestamp,
            },
          ],
        },
      ],
    });
    getWorkspaceStreamsForTests(streamManager).set(workspaceId, streamInfo);

    streamManager.emitNestedToolEvent(workspaceId, messageId, {
      type: "tool-call-end",
      callId: "nested-ts",
      toolName: "bash",
      args: {},
      parentToolCallId: "code-exec-ts",
      startTime: timestamp,
      endTime: timestamp + 5,
      result: { ok: true },
    });

    expect((streamInfo.toolCompletionTimestamps as Map<string, number>).get("nested-ts")).toBe(
      timestamp + 5
    );
  });

  test("incremental replay keeps a parent whose only fresh activity is nested", async () => {
    const streamManager = new StreamManager(historyService);
    const workspaceId = "nested-replay-cursor-workspace";
    const messageId = "nested-replay-cursor-message";
    const timestamp = Date.now();
    const streamInfo = createStreamInfoForTests({
      messageId,
      lastPartialWriteTime: timestamp,
      parts: [
        {
          type: "dynamic-tool",
          toolCallId: "code-exec-cursor",
          toolName: "code_execution",
          input: { code: "mux.workflow_run({...})" },
          state: "input-available",
          // Parent part predates the reconnect cursor...
          timestamp,
          nestedCalls: [
            {
              toolCallId: "nested-cursor-workflow",
              toolName: "workflow_run",
              input: {},
              state: "input-available",
              // ...but the nested workflow started after it.
              timestamp: timestamp + 100,
            },
          ],
        },
      ],
    });
    getWorkspaceStreamsForTests(streamManager).set(workspaceId, streamInfo);

    const starts: ToolCallStartEvent[] = [];
    onTurnEngineEvent(streamManager, "tool-call-start", (event) => starts.push(event));

    await streamManager.replayStream(workspaceId, { afterTimestamp: timestamp + 50 });

    expect(starts.some((e) => e.toolCallId === "nested-cursor-workflow")).toBe(true);
  });
});

describe("StreamManager - nested tool call normalization", () => {
  test("normalizes zero-arg nested calls to {} for the persisted record and the wire event", () => {
    const streamManager = new StreamManager(historyService);
    const workspaceId = "nested-normalize-workspace";
    const messageId = "nested-normalize-message";
    const timestamp = Date.now();
    const parts: CompletedMessagePart[] = [
      {
        type: "dynamic-tool",
        toolCallId: "parent-1",
        toolName: "code_execution",
        input: { code: "mux.linear_list_teams()" },
        state: "input-available",
        timestamp,
      },
    ];
    const streamInfo = createStreamInfoForTests({ messageId, parts });
    getWorkspaceStreamsForTests(streamManager).set(workspaceId, streamInfo);

    const events: unknown[] = [];
    onTurnEngineEvent(streamManager, "tool-call-start", (event: unknown) => events.push(event));

    streamManager.emitNestedToolEvent(workspaceId, messageId, {
      type: "tool-call-start",
      callId: "nested-1",
      toolName: "linear_list_teams",
      // Zero-argument guest call: JSON cannot represent undefined, so both the
      // persisted record and the wire event must carry {} instead.
      args: undefined,
      parentToolCallId: "parent-1",
      startTime: timestamp,
    });

    const parentPart = parts[0] as { nestedCalls?: Array<{ input?: unknown }> };
    expect(parentPart.nestedCalls).toHaveLength(1);
    expect(parentPart.nestedCalls?.[0]?.input).toEqual({});

    // The live event must survive oRPC output validation (args key required).
    expect(events).toHaveLength(1);
    expect(ToolCallStartEventSchema.safeParse(events[0]).success).toBe(true);
    expect((events[0] as { args?: unknown }).args).toEqual({});
  });
});

describe("StreamManager - tool execution start timing", () => {
  test("stamps executionStartedAt and emits tool-call-execution-start when the part already exists", () => {
    const streamManager = new StreamManager(historyService);
    const workspaceId = "execution-start-workspace";
    const messageId = "execution-start-message";
    // Seed the monotonic stream clock ahead of wall time: a raw Date.now() execution
    // start would be <= the tool-call timestamp and reconnect replay's
    // `executionStartedAt > cursor` repair predicate would never fire.
    const timestamp = Date.now() + 60_000;
    const streamInfo = createStreamInfoForTests({
      messageId,
      lastPartTimestamp: timestamp,
      parts: [
        {
          type: "dynamic-tool",
          toolCallId: "tool-call-1",
          toolName: "bash",
          input: { command: "echo hi" },
          state: "input-available",
          timestamp,
        },
      ],
    });
    getWorkspaceStreamsForTests(streamManager).set(workspaceId, streamInfo);

    const events: ToolCallExecutionStartEvent[] = [];
    onTurnEngineEvent(
      streamManager,
      "tool-call-execution-start",
      (event: ToolCallExecutionStartEvent) => {
        events.push(event);
      }
    );

    const handleToolExecutionStart = getPrivateMethodForTests<
      (workspaceId: string, messageId: string, toolCallId: string) => void
    >(streamManager, "handleToolExecutionStart");
    handleToolExecutionStart.call(streamManager, workspaceId, messageId, "tool-call-1");

    expect(events).toHaveLength(1);
    expect(events[0]).toMatchObject({
      type: "tool-call-execution-start",
      workspaceId,
      messageId,
      toolCallId: "tool-call-1",
    });
    // Cursor-monotonic: strictly after the tool-call part timestamp even when the wall
    // clock has not advanced past it.
    expect(events[0].timestamp).toBeGreaterThan(timestamp);

    const parts = streamInfo.parts as Array<Record<string, unknown>>;
    expect(parts[0].executionStartedAt).toBe(events[0].timestamp);
  });

  test("applies execution starts that arrive before the tool part lands", async () => {
    const streamManager = new StreamManager(historyService);
    const workspaceId = "execution-start-race-workspace";
    const messageId = "execution-start-race-message";
    const streamInfo = createStreamInfoForTests({ messageId, parts: [] });
    getWorkspaceStreamsForTests(streamManager).set(workspaceId, streamInfo);

    const events: ToolCallExecutionStartEvent[] = [];
    onTurnEngineEvent(
      streamManager,
      "tool-call-execution-start",
      (event: ToolCallExecutionStartEvent) => {
        events.push(event);
      }
    );

    // execute() wins the race: no part yet, so the start is parked as pending.
    const handleToolExecutionStart = getPrivateMethodForTests<
      (workspaceId: string, messageId: string, toolCallId: string) => void
    >(streamManager, "handleToolExecutionStart");
    handleToolExecutionStart.call(streamManager, workspaceId, messageId, "tool-call-race");
    expect(events).toHaveLength(0);

    const appendPartAndEmit = getPrivateMethodForTests<
      (
        workspaceId: string,
        streamInfo: Record<string, unknown>,
        part: CompletedMessagePart,
        schedulePartialWrite?: boolean
      ) => Promise<void>
    >(streamManager, "appendPartAndEmit");
    await appendPartAndEmit.call(
      streamManager,
      workspaceId,
      streamInfo,
      {
        type: "dynamic-tool",
        toolCallId: "tool-call-race",
        toolName: "bash",
        input: { command: "echo hi" },
        state: "input-available",
        timestamp: Date.now(),
      },
      false
    );

    expect(events).toHaveLength(1);
    expect(events[0].toolCallId).toBe("tool-call-race");

    const parts = streamInfo.parts as Array<Record<string, unknown>>;
    expect(parts[0].executionStartedAt).toBe(events[0].timestamp);
    expect((streamInfo.pendingToolExecutionStarts as Map<string, number>).size).toBe(0);
  });
});

describe("StreamManager - createTempDirForStream", () => {
  test("creates ~/.xum-tmp/<token> under the runtime's home", async () => {
    using home = new DisposableTempDir("stream-home");

    const prevHome = process.env.HOME;
    const prevUserProfile = process.env.USERPROFILE;

    process.env.HOME = home.path;
    process.env.USERPROFILE = home.path;

    try {
      const streamManager = new StreamManager(historyService);
      const runtime = createRuntime({ type: "local", srcBaseDir: "/tmp" });

      const token = streamManager.generateStreamToken();
      const resolved = await streamManager.createTempDirForStream(token, runtime);

      // StreamManager normalizes Windows paths to forward slashes.
      const normalizedHomePath = home.path.replace(/\\/g, "/");
      expect(resolved.startsWith(normalizedHomePath)).toBe(true);
      expect(resolved).toContain(`/.xum-tmp/${token}`);

      const stat = await fs.stat(resolved);
      expect(stat.isDirectory()).toBe(true);
    } finally {
      if (prevHome === undefined) {
        delete process.env.HOME;
      } else {
        process.env.HOME = prevHome;
      }

      if (prevUserProfile === undefined) {
        delete process.env.USERPROFILE;
      } else {
        process.env.USERPROFILE = prevUserProfile;
      }
    }
  });
});

describe("StreamManager - cleanupStreamTempDir", () => {
  test("quotes temp-dir basename in rm -rf command", () => {
    const streamManager = new StreamManager(historyService);
    const execCalls: Array<{ command: string; options: ExecOptions }> = [];
    const runtime = {
      exec: (command: string, options: ExecOptions) => {
        execCalls.push({ command, options });
        return Promise.resolve(createExecStreamForTests());
      },
    } as unknown as Runtime;

    const cleanup = Reflect.get(streamManager, "cleanupStreamTempDir") as
      | ((runtime: Runtime, runtimeTempDir: string) => void)
      | undefined;

    expect(typeof cleanup).toBe("function");

    const runtimeTempDir = "/tmp/stream-$(echo injected)";
    cleanup?.(runtime, runtimeTempDir);

    expect(execCalls).toHaveLength(1);
    expect(execCalls[0]?.command).toBe(`rm -rf ${shellQuote("stream-$(echo injected)")}`);
    expect(execCalls[0]?.options).toMatchObject({ cwd: "/tmp", timeout: 10 });
  });
});

describe("StreamManager - stream resource scope", () => {
  function createLifecycleStreamManagerForTests(fullStreamParts: unknown[]): {
    streamManager: StreamManager;
    cleanupCalls: string[];
  } {
    const streamManager = new StreamManager(historyService);
    Reflect.set(streamManager, "tokenTracker", {
      setModel: () => Promise.resolve(undefined),
      countTokens: () => Promise.resolve(0),
    });
    Reflect.set(streamManager, "createStreamResult", () =>
      createStreamResultForTests(
        (async function* () {
          await Promise.resolve();
          yield* fullStreamParts;
        })()
      )
    );
    Reflect.set(streamManager, "createTempDirForStream", () =>
      Promise.resolve("/tmp/phase10-scope-tempdir")
    );
    const cleanupCalls: string[] = [];
    Reflect.set(streamManager, "cleanupStreamTempDir", (_runtime: unknown, dir: string) => {
      cleanupCalls.push(dir);
    });
    return { streamManager, cleanupCalls };
  }

  async function runLifecycleStreamForTests(
    streamManager: StreamManager,
    workspaceId: string
  ): Promise<void> {
    const messageId = `${workspaceId}-msg`;
    await appendPartialAssistantForTests(workspaceId, messageId, 1);

    const result = await streamManager.startStream(
      testStartOptions({
        workspaceId,
        messageId,
        model: createTestLanguageModel(),
        tools: {},
      })
    );
    expect(result.success).toBe(true);
    if (!result.success) {
      throw new Error("Expected stream to start");
    }
    await result.data.completion;
    // Let the fire-and-forget scope close settle.
    await new Promise((resolve) => setTimeout(resolve, 0));
  }

  test("releases the temp dir exactly once when the stream completes", async () => {
    // The temp-dir release finalizer is owned by the stream's resource scope:
    // ownership transfers from startStream to processStreamWithCleanup at
    // registration, and Scope.close must run the release on natural
    // completion without double-releasing across the two cleanup paths.
    const { streamManager, cleanupCalls } = createLifecycleStreamManagerForTests([
      { type: "text-delta", text: "hello" },
      { type: "finish", finishReason: "stop" },
    ]);

    await runLifecycleStreamForTests(streamManager, "scope-release-once-workspace");

    expect(cleanupCalls).toEqual(["/tmp/phase10-scope-tempdir"]);
  });

  test("interrupts a pending debounced partial write when the stream ends", async () => {
    // A debounced partial flush scheduled during streaming is tied to the
    // stream's resource scope. Once the stream ends, the pending flush must be
    // interrupted with the scope — a late write would resurrect partial state
    // for a dead stream. The debounce sleeps on the injected runner's
    // TestClock, so "later" is a virtual-time adjust, not a real wait.
    const testRunner = makeTestEffectRunner();
    try {
      const workspaceId = "scope-debounce-interrupt-workspace";
      const streamManager = new StreamManager(
        historyService,
        undefined,
        undefined,
        undefined,
        testRunner.runner
      );
      Reflect.set(streamManager, "tokenTracker", {
        setModel: () => Promise.resolve(undefined),
        countTokens: () => Promise.resolve(0),
      });
      Reflect.set(streamManager, "createTempDirForStream", () =>
        Promise.resolve("/tmp/phase10-scope-tempdir")
      );
      Reflect.set(streamManager, "cleanupStreamTempDir", () => undefined);

      const workspaceStreams = getWorkspaceStreamsForTests(streamManager);
      const streamInfoForTests = () =>
        workspaceStreams.get(workspaceId) as
          | { lastPartialWriteTime?: number; partialWriteFiber?: unknown }
          | undefined;

      let debounceArmedBeforeFinish = false;
      Reflect.set(streamManager, "createStreamResult", () =>
        createStreamResultForTests(
          (async function* () {
            // First delta writes immediately (lastPartialWriteTime starts at 0).
            yield { type: "text-delta", text: "first" };
            // Wait until that write stamps the throttle clock so the second
            // delta deterministically lands inside the throttle window.
            while ((streamInfoForTests()?.lastPartialWriteTime ?? 0) === 0) {
              await new Promise((resolve) => setTimeout(resolve, 5));
            }
            yield { type: "text-delta", text: "second" };
            // The consumer fully processed the second delta before pulling the
            // next part, and the debounce arms synchronously.
            debounceArmedBeforeFinish = streamInfoForTests()?.partialWriteFiber != null;
            yield { type: "finish", finishReason: "stop" };
          })()
        )
      );
      const writePartialSpy = spyOn(historyService, "writePartial");

      const throttleMs: unknown = Reflect.get(streamManager, "PARTIAL_WRITE_THROTTLE_MS");
      if (typeof throttleMs !== "number") {
        throw new Error("Expected StreamManager.PARTIAL_WRITE_THROTTLE_MS to be a number");
      }

      await runLifecycleStreamForTests(streamManager, workspaceId);

      expect(debounceArmedBeforeFinish).toBe(true);
      const writesAtStreamEnd = writePartialSpy.mock.calls.length;
      await testRunner.adjust(throttleMs * 2);
      // A flush that survived the scope close would settle on the next macrotask.
      await new Promise((resolve) => setTimeout(resolve, 0));
      expect(writePartialSpy.mock.calls.length).toBe(writesAtStreamEnd);
    } finally {
      await testRunner.dispose();
    }
  });

  test("a debounced partial write arms a real setTimeout through the default runner", async () => {
    // Default-runner smoke: with nothing injected the debounce sleeps on
    // Effect's default clock, i.e. a real setTimeout. Intercepting the timer
    // registration (as the RetryManager smoke does) keeps this deterministic:
    // no wall-clock window that a loaded host could overrun.
    const realSetTimeout = globalThis.setTimeout;
    const timers: Array<{ delayMs: number; fire: () => void }> = [];
    const setTimeoutSpy = spyOn(globalThis, "setTimeout").mockImplementation(((
      handler: TimerHandler,
      timeout?: number
    ) => {
      if (typeof handler !== "function") {
        throw new Error("debounce smoke only supports function timer handlers");
      }
      timers.push({ delayMs: timeout ?? 0, fire: handler as () => void });
      return timers.length as unknown as ReturnType<typeof setTimeout>;
    }) as unknown as typeof setTimeout);
    try {
      const streamManager = new StreamManager(historyService);
      const workspaceId = "default-runner-debounce-workspace";
      const throttleMs: unknown = Reflect.get(streamManager, "PARTIAL_WRITE_THROTTLE_MS");
      if (typeof throttleMs !== "number") {
        throw new Error("Expected StreamManager.PARTIAL_WRITE_THROTTLE_MS to be a number");
      }
      // A write just happened: the whole throttle window is still ahead.
      const streamInfo = createStreamInfoForTests({ lastPartialWriteTime: Date.now() });
      getWorkspaceStreamsForTests(streamManager).set(workspaceId, streamInfo);
      const schedulePartialWrite = getPrivateMethodForTests<
        (workspaceId: string, streamInfo: Record<string, unknown>) => Promise<void>
      >(streamManager, "schedulePartialWrite");
      const writePartialSpy = spyOn(historyService, "writePartial");

      await schedulePartialWrite.call(streamManager, workspaceId, streamInfo);
      expect(streamInfo.partialWriteFiber).toBeDefined();
      expect(writePartialSpy).not.toHaveBeenCalled();
      // Exactly one timer, for the remaining throttle window.
      expect(timers).toHaveLength(1);
      expect(timers[0].delayMs).toBeGreaterThan(0);
      expect(timers[0].delayMs).toBeLessThanOrEqual(throttleMs);

      timers[0].fire();
      setTimeoutSpy.mockRestore();
      // The flush's Effect.promise settles asynchronously.
      const deadline = Date.now() + 2_000;
      while (writePartialSpy.mock.calls.length === 0 && Date.now() < deadline) {
        await new Promise((resolve) => realSetTimeout(resolve, 5));
      }
      expect(writePartialSpy).toHaveBeenCalledTimes(1);
      expect(streamInfo.partialWriteFiber).toBeUndefined();
    } finally {
      setTimeoutSpy.mockRestore();
    }
  });

  test("runs the partial-write debounce on the injected runner's clock", async () => {
    // The debounce fiber must sleep on the injected EffectRunner (the app
    // runtime's clock in production), not the global runtime: a TestClock
    // runner fires the flush only when the test clock advances.
    const testRunner = makeTestEffectRunner();
    try {
      const streamManager = new StreamManager(
        historyService,
        undefined,
        undefined,
        undefined,
        testRunner.runner
      );
      expect(streamManager.effectRunner).toBe(testRunner.runner);
      const workspaceId = "runner-debounce-workspace";
      // Inside the throttle window, so the write is debounced rather than immediate.
      const streamInfo = createStreamInfoForTests({ lastPartialWriteTime: Date.now() });
      getWorkspaceStreamsForTests(streamManager).set(workspaceId, streamInfo);
      const schedulePartialWrite = getPrivateMethodForTests<
        (workspaceId: string, streamInfo: Record<string, unknown>) => Promise<void>
      >(streamManager, "schedulePartialWrite");
      const writePartialSpy = spyOn(historyService, "writePartial");
      const throttleMs: unknown = Reflect.get(streamManager, "PARTIAL_WRITE_THROTTLE_MS");
      if (typeof throttleMs !== "number") {
        throw new Error("Expected StreamManager.PARTIAL_WRITE_THROTTLE_MS to be a number");
      }

      await schedulePartialWrite.call(streamManager, workspaceId, streamInfo);
      expect(streamInfo.partialWriteFiber).toBeDefined();
      // Real time passes; the virtual clock has not, so nothing flushes.
      await new Promise((resolve) => setTimeout(resolve, 20));
      expect(writePartialSpy).not.toHaveBeenCalled();

      await testRunner.adjust(throttleMs);
      // The flush's Effect.promise settles on the next macrotask.
      await new Promise((resolve) => setTimeout(resolve, 0));
      expect(writePartialSpy).toHaveBeenCalledTimes(1);
      expect(streamInfo.partialWriteFiber).toBeUndefined();
    } finally {
      await testRunner.dispose();
    }
  });
});

describe("StreamManager - engine supervision (AppFiberScope occupant)", () => {
  type StreamAbortEvent = Extract<TurnEngineEvent, { type: "stream-abort" }>;

  /**
   * A manager whose streams are supervised by `engineScope` (the app runtime's
   * AppFiberScope in production). `fullStream` receives the stream's own
   * AbortSignal so scenarios can model a provider that stops on abort — or one
   * that ignores it.
   */
  function createSupervisedStreamManagerForTests(
    fullStream: (signal: AbortSignal) => AsyncGenerator<unknown, void, unknown>,
    options: { supervised: boolean } = { supervised: true }
  ) {
    const engineScope = Scope.makeUnsafe("parallel");
    const events: TurnEngineEvent[] = [];
    const streamManager = new StreamManager(
      historyService,
      undefined,
      undefined,
      (event) => {
        events.push(event);
      },
      undefined,
      options.supervised ? engineScope : undefined
    );
    Reflect.set(streamManager, "tokenTracker", {
      setModel: () => Promise.resolve(undefined),
      countTokens: () => Promise.resolve(0),
    });
    Reflect.set(
      streamManager,
      "createStreamResult",
      (_request: unknown, abortController: AbortController) =>
        createStreamResultForTests(fullStream(abortController.signal))
    );
    Reflect.set(streamManager, "createTempDirForStream", () =>
      Promise.resolve("/tmp/wave4-supervisor-tempdir")
    );
    Reflect.set(streamManager, "cleanupStreamTempDir", () => undefined);
    return { streamManager, events, engineScope };
  }

  async function startSupervisedStreamForTests(
    streamManager: StreamManager,
    workspaceId: string,
    historySequence = 1
  ) {
    const messageId = `${workspaceId}-msg-${historySequence}`;
    await appendPartialAssistantForTests(workspaceId, messageId, historySequence);
    const result = await streamManager.startStream(
      testStartOptions({
        workspaceId,
        messageId,
        model: createTestLanguageModel(),
        tools: {},
        historySequence,
      })
    );
    expect(result.success).toBe(true);
    if (!result.success) {
      throw new Error("Expected stream to start");
    }
    return result.data;
  }

  /** Yields one delta, then blocks until the stream's AbortSignal fires (a well-behaved provider). */
  function flowingThenBlockedStream(signal: AbortSignal): AsyncGenerator<unknown, void, unknown> {
    return (async function* () {
      yield { type: "text-delta", text: "hello" };
      await new Promise<void>((resolve) => {
        if (signal.aborted) return resolve();
        signal.addEventListener("abort", () => resolve(), { once: true });
      });
    })();
  }

  async function waitForPartialText(workspaceId: string, text: string): Promise<void> {
    const deadline = Date.now() + 5_000;
    while (Date.now() < deadline) {
      const partial = await historyService.readPartial(workspaceId);
      if (
        partial?.parts.some((part) => part.type === "text" && part.text.includes(text)) === true
      ) {
        return;
      }
      await new Promise((resolve) => setTimeout(resolve, 5));
    }
    throw new Error(`partial for ${workspaceId} never contained ${JSON.stringify(text)}`);
  }

  function terminalEvents(events: TurnEngineEvent[]): TurnEngineEvent[] {
    return events.filter((event) => ["stream-end", "stream-abort", "error"].includes(event.type));
  }

  test("closing the engine scope aborts a flowing stream as 'system', commits its partial and settles it", async () => {
    const workspaceId = "supervised-flowing-workspace";
    const { streamManager, events, engineScope } =
      createSupervisedStreamManagerForTests(flowingThenBlockedStream);
    const writePartialSpy = spyOn(historyService, "writePartial");
    const handle = await startSupervisedStreamForTests(streamManager, workspaceId);
    await waitForPartialText(workspaceId, "hello");
    expect(streamManager.isStreaming(workspaceId)).toBe(true);

    // What ServiceContainer.dispose() does at step 2: interrupt + await.
    await closeScopeBounded(engineScope);

    // The finalizer routed through the user-stop path: the streamed text was
    // flushed (with usage stamping) before the abort was delivered ...
    const lastWrite = writePartialSpy.mock.calls.at(-1)?.[1];
    expect(lastWrite?.parts.some((part) => part.type === "text" && part.text === "hello")).toBe(
      true
    );
    // ... exactly one terminal event, an involuntary backend abort, no stream-end ...
    const terminal = terminalEvents(events);
    expect(terminal.map((event) => event.type)).toEqual(["stream-abort"]);
    expect((terminal[0] as StreamAbortEvent).abortReason).toBe("system");
    // ... and the turn handle plus the registry were settled before the close resolved.
    expect(await handle.completion).toMatchObject({ status: "aborted", abortReason: "system" });
    expect(getWorkspaceStreamsForTests(streamManager).size).toBe(0);
    expect(streamManager.isStreaming(workspaceId)).toBe(false);
  });

  test.each([
    "tokenization",
    "sink-sync",
    "sink-async",
    "preflush",
    "processing",
    "usage",
    "soft-tokenization",
    "soft-preflush",
    "soft-usage",
  ] as const)("abort completion survives %s failure", async (failure) => {
    const workspaceId = `abort-failure-${failure}`;
    const soft = failure.startsWith("soft-");
    const failureKind = failure.replace("soft-", "");
    const releaseBoundary = Promise.withResolvers<void>();
    const providerEntered = Promise.withResolvers<void>();
    const { streamManager, events } = createSupervisedStreamManagerForTests(
      (signal) =>
        (async function* () {
          yield { type: "reasoning-delta", text: "unfinished reasoning" };
          providerEntered.resolve();
          if (soft) {
            await releaseBoundary.promise;
            yield { type: "text-end" };
          }
          if (!signal.aborted) {
            await new Promise<void>((resolve) =>
              signal.addEventListener("abort", () => resolve(), { once: true })
            );
          }
        })(),
      { supervised: false }
    );
    const handle = await startSupervisedStreamForTests(streamManager, workspaceId);
    await providerEntered.promise;
    const streamInfo = getWorkspaceStreamsForTests(streamManager).get(workspaceId) as Record<
      string,
      unknown
    >;
    const usage = { inputTokens: 120, outputTokens: 30, totalTokens: 150 };
    streamInfo.cumulativeUsage = usage;
    const processingPromise = streamInfo.processingPromise as Promise<void>;
    const abortController = streamInfo.abortController as AbortController;
    const countTokensSpy = spyOn(tokenizer, "countTokens");
    const flush = getPrivateMethodForTests<(...args: never[]) => Promise<void>>(
      streamManager,
      "flushPartialWrite"
    );
    let outcome: TurnCompletion | undefined;
    const observed = handle.completion.then((value) => {
      outcome = value;
    });
    try {
      if (failureKind === "tokenization") {
        countTokensSpy.mockRejectedValueOnce(new Error("tokenizer unavailable"));
      } else if (failureKind === "sink-sync" || failureKind === "sink-async") {
        streamManager.setEventSink((event) => {
          events.push(event);
          if (event.type !== "stream-abort") return;
          if (failureKind === "sink-sync") throw new Error("synchronous sink failure");
          return Promise.reject(new Error("asynchronous sink failure"));
        });
      } else if (failureKind === "preflush") {
        Reflect.set(streamManager, "flushPartialWrite", () => {
          Reflect.set(streamManager, "flushPartialWrite", flush);
          return Promise.reject(new Error("pre-cancel flush failure"));
        });
      } else if (failureKind === "usage") {
        Reflect.set(streamManager, "recordSessionUsage", () =>
          Promise.reject(new Error("usage attribution unavailable"))
        );
      } else {
        // A teardown failure after the provider exits rejects the processing join.
        streamInfo.processingPromise = processingPromise.then(() => {
          throw new Error("processing teardown failure");
        });
      }
      expect(
        (await streamManager.stopStream(workspaceId, { abortReason: "user", soft })).success
      ).toBe(true);
      if (soft) {
        releaseBoundary.resolve();
        await processingPromise;
        await streamInfo.cancelPromise;
      }
      // stop intentionally does not await sink delivery; drain its settlement microtasks.
      await new Promise<void>((resolve) => setImmediate(resolve));
      expect(outcome).toMatchObject({
        status: "aborted",
        abortReason: "user",
        streamAbort: {
          messageId: handle.messageId,
          metadata: { usage },
        },
      });
      await observed;
      expect(abortController.signal.aborted).toBe(true);
      expect(terminalEvents(events).map((event) => event.type)).toEqual(["stream-abort"]);
      expect(getWorkspaceStreamsForTests(streamManager).size).toBe(0);
    } finally {
      countTokensSpy.mockRestore();
      Reflect.set(streamManager, "flushPartialWrite", flush);
      abortController.abort();
      releaseBoundary.resolve();
      await processingPromise;
    }
  });

  test.each(["interrupt", "edit", "raw-listener", "partial-commit"] as const)(
    "%s finishes and publishes its abort despite cancellation bookkeeping failure",
    async (scenario) => {
      const workspaceId = `session-abort-failure-${scenario}`;
      const providerEntered = Promise.withResolvers<void>();
      const replacementEntered = Promise.withResolvers<void>();
      let providerCalls = 0;
      const { streamManager } = createSupervisedStreamManagerForTests(
        (signal) =>
          (async function* () {
            yield { type: "text-delta", text: "retained partial" };
            yield { type: "reasoning-delta", text: "unfinished reasoning" };
            if (++providerCalls === 1) providerEntered.resolve();
            else replacementEntered.resolve();
            if (!signal.aborted)
              await new Promise<void>((resolve) =>
                signal.addEventListener("abort", () => resolve(), { once: true })
              );
          })(),
        { supervised: false }
      );
      const service = new AIService(
        historyConfig,
        historyService,
        new InitStateManager(historyConfig),
        new ProviderService(historyConfig),
        undefined,
        undefined,
        undefined,
        undefined,
        undefined,
        undefined,
        undefined,
        streamManager
      );
      let turns = 0;
      spyOn(service, "streamMessage").mockImplementation(async () =>
        Ok(await startSupervisedStreamForTests(streamManager, workspaceId, ++turns * 2 - 1))
      );
      const h = await createAgentSessionHarness({
        workspaceId,
        config: historyConfig,
        historyService,
        aiService: service,
        streamManager,
        captureEvents: true,
      });
      const countTokensSpy = spyOn(tokenizer, "countTokens");
      const commitSpy = spyOn(historyService, "commitPartial");
      const throwFromRawListener = () => {
        throw new Error("raw abort subscriber failure");
      };
      const options = { model: "openai:gpt-4.1-mini", agentId: "exec" };
      try {
        await h.session.sendMessage("original", options);
        await providerEntered.promise;
        const streamInfo = getWorkspaceStreamsForTests(streamManager).get(workspaceId) as Record<
          string,
          unknown
        >;
        streamInfo.cumulativeUsage = { inputTokens: 120, outputTokens: 30, totalTokens: 150 };
        if (scenario === "raw-listener") service.on("stream-abort", throwFromRawListener);
        else if (scenario === "partial-commit")
          commitSpy.mockRejectedValueOnce(new Error("disk unavailable"));
        else countTokensSpy.mockRejectedValueOnce(new Error("tokenizer unavailable"));
        const history = await historyService.getHistoryFromLatestBoundary(workspaceId);
        if (!history.success) throw new Error(history.error);
        const userId = history.data.find((message) => message.role === "user")!.id;
        const result =
          scenario === "edit"
            ? await h.session.sendMessage("edited", { ...options, editMessageId: userId })
            : await h.session.interruptStream();
        expect(result.success).toBe(true);
        expect(h.events.filter((event) => event.type === "stream-abort")).toMatchObject([
          { abortReason: "user", messageId: `${workspaceId}-msg-1` },
        ]);
        if (scenario !== "edit") {
          expect(h.session.isBusy()).toBe(false);
          const partial = await historyService.readPartial(workspaceId);
          if (scenario === "partial-commit") expect(partial).not.toBeNull();
          else expect(partial).toBeNull();
          if (scenario !== "partial-commit") {
            const committed = await historyService.getHistoryFromLatestBoundary(workspaceId);
            if (!committed.success) throw new Error(committed.error);
            expect(
              committed.data.find((message) => message.role === "assistant")?.metadata?.usage
            ).toMatchObject({ inputTokens: 120, outputTokens: 30 });
          }
          expect((await h.session.sendMessage("next", options)).success).toBe(true);
        }
        await replacementEntered.promise;
        expect(providerCalls).toBe(2);
        expect(h.session.isBusy()).toBe(true);
      } finally {
        service.off("stream-abort", throwFromRawListener);
        countTokensSpy.mockRestore();
        commitSpy.mockRestore();
        h.session.dispose();
        await streamManager.stopStream(workspaceId, { abortReason: "system" });
      }
    }
  );

  test("a wedged provider (never yields, ignores abort) cannot pin the bounded close", async () => {
    const workspaceId = "supervised-wedged-workspace";
    const { streamManager, engineScope } = createSupervisedStreamManagerForTests(() =>
      (async function* () {
        await new Promise<never>(() => undefined);
        yield { type: "text-delta", text: "never" };
      })()
    );
    await startSupervisedStreamForTests(streamManager, workspaceId);
    expect(streamManager.isStreaming(workspaceId)).toBe(true);

    // cleanupAbortedStream waits for the loop, which waits on the provider that
    // never returns; the close must still resolve at the bound, and never reject.
    const startedAt = Date.now();
    await closeScopeBounded(engineScope, 100);
    expect(Date.now() - startedAt).toBeLessThan(2_000);
  });

  test("a stream started after the engine scope closed is aborted immediately (fail-closed during shutdown)", async () => {
    const workspaceId = "supervised-late-start-workspace";
    const { streamManager, events, engineScope } =
      createSupervisedStreamManagerForTests(flowingThenBlockedStream);
    await closeScopeBounded(engineScope);

    const handle = await startSupervisedStreamForTests(streamManager, workspaceId);

    expect(await handle.completion).toMatchObject({ status: "aborted", abortReason: "system" });
    expect(terminalEvents(events).map((event) => event.type)).toEqual(["stream-abort"]);
    expect(getWorkspaceStreamsForTests(streamManager).size).toBe(0);
  });

  test("a cancel landing after the loop finished but before COMPLETED neither resurrects partial.json nor emits a second terminal event", async () => {
    // The completion path deletes partial.json, then awaits updateHistory, and
    // only then flips state to COMPLETED. A cancel (user stop or the shutdown
    // supervisor) landing inside that window previously re-created partial.json
    // (pre-abort flush + abort bookkeeping) and emitted stream-abort after
    // stream-end. No engine scope here: this is the stopStream path itself.
    const workspaceId = "cancel-after-loop-exit-workspace";
    const { streamManager, events } = createSupervisedStreamManagerForTests(
      () =>
        (async function* () {
          await Promise.resolve();
          yield { type: "text-delta", text: "final answer" };
          yield { type: "finish", finishReason: "stop" };
        })(),
      { supervised: false }
    );
    const finalWriteEntered = Promise.withResolvers<void>();
    const releaseFinalWrite = Promise.withResolvers<void>();
    const realUpdateHistory = historyService.updateHistory.bind(historyService);
    const updateHistorySpy = spyOn(historyService, "updateHistory").mockImplementation(
      async (targetWorkspaceId, message) => {
        finalWriteEntered.resolve();
        await releaseFinalWrite.promise;
        return realUpdateHistory(targetWorkspaceId, message);
      }
    );
    let completionObserved: Promise<void> | undefined;
    let stopPromise: Promise<unknown> | undefined;
    try {
      const handle = await startSupervisedStreamForTests(streamManager, workspaceId);
      let settled = false;
      completionObserved = handle.completion.then(async () => {
        settled = true;
        // Dependent turns read immediately on completion, so final history must already exist.
        const history = await historyService.getHistoryFromLatestBoundary(workspaceId);
        expect(history.success).toBe(true);
        if (!history.success) throw new Error(history.error);
        expect(history.data.filter((message) => message.role === "assistant")).toMatchObject([
          { parts: [{ type: "text", text: "final answer" }] },
        ]);
        expect(history.data[0].metadata?.partial).not.toBe(true);
      });

      await finalWriteEntered.promise;
      stopPromise = streamManager.stopStream(workspaceId);
      const beforeCommit = await historyService.getHistoryFromLatestBoundary(workspaceId);
      expect(beforeCommit.success).toBe(true);
      if (!beforeCommit.success) throw new Error(beforeCommit.error);
      expect(beforeCommit.data[0].parts).toEqual([]);
      expect(settled).toBe(false);
      expect(terminalEvents(events)).toEqual([]);

      releaseFinalWrite.resolve();
      expect(await handle.completion).toMatchObject({ status: "completed" });
      expect(await stopPromise).toEqual(Ok(undefined));
      await completionObserved;

      expect(terminalEvents(events).map((event) => event.type)).toEqual(["stream-end"]);
      expect(await historyService.readPartial(workspaceId)).toBeNull();
      const history = await historyService.getHistoryFromLatestBoundary(workspaceId);
      expect(history.success).toBe(true);
      if (!history.success) throw new Error(history.error);
      const assistantRows = history.data.filter((message) => message.role === "assistant");
      expect(assistantRows).toHaveLength(1);
      expect(assistantRows[0].metadata?.partial).not.toBe(true);
      expect(
        assistantRows[0].parts.some((part) => part.type === "text" && part.text === "final answer")
      ).toBe(true);
      expect(getWorkspaceStreamsForTests(streamManager).size).toBe(0);
    } finally {
      releaseFinalWrite.resolve();
      try {
        await stopPromise;
        await completionObserved;
      } finally {
        updateHistorySpy.mockRestore();
      }
    }
  });

  test("stopStream racing the engine-scope close produces exactly one stream-abort and one settle", async () => {
    const workspaceId = "supervised-stop-vs-close-workspace";
    const { streamManager, events, engineScope } =
      createSupervisedStreamManagerForTests(flowingThenBlockedStream);
    const handle = await startSupervisedStreamForTests(streamManager, workspaceId);
    await waitForPartialText(workspaceId, "hello");
    let settleCount = 0;
    void handle.completion.then(() => {
      settleCount += 1;
    });

    // Both cancellers enter cancelStreamSafely in the same tick; the latch is
    // taken synchronously, so the second joins the first's cleanup.
    const stopPromise = streamManager.stopStream(workspaceId, { abortReason: "user" });
    const closePromise = closeScopeBounded(engineScope);
    await Promise.all([stopPromise, closePromise]);
    await new Promise((resolve) => setTimeout(resolve, 0));

    const aborts = events.filter(
      (event): event is StreamAbortEvent => event.type === "stream-abort"
    );
    expect(aborts).toHaveLength(1);
    // First canceller's reason wins (the user pressed stop before shutdown reached the stream).
    expect(aborts[0].abortReason).toBe("user");
    expect(terminalEvents(events)).toHaveLength(1);
    expect(settleCount).toBe(1);
    expect(await handle.completion).toMatchObject({ status: "aborted", abortReason: "user" });
    expect(getWorkspaceStreamsForTests(streamManager).size).toBe(0);
  });

  test("closing the engine scope while the turn-envelope write is pending cancels the STARTING stream inside the close", async () => {
    // startStream registers the stream, then awaits onStreamConstructed (the
    // durable turn-envelope write) before launching processing. Supervision
    // starts at registration, so a shutdown landing inside that await cancels
    // the STARTING stream through the same hard-interrupt path a user stop
    // takes there — before closeScopeBounded resolves, not after teardown has
    // moved on and the envelope write finally returns.
    const workspaceId = "supervised-starting-window-workspace";
    const { streamManager, events, engineScope } =
      createSupervisedStreamManagerForTests(flowingThenBlockedStream);
    const messageId = `${workspaceId}-msg`;
    await appendPartialAssistantForTests(workspaceId, messageId, 1);
    let releaseEnvelope!: () => void;
    const envelopeWritten = new Promise<void>((resolve) => {
      releaseEnvelope = resolve;
    });
    const startPromise = streamManager.startStream(
      testStartOptions({
        workspaceId,
        messageId,
        model: createTestLanguageModel(),
        tools: {},
        onStreamConstructed: () => envelopeWritten,
      })
    );
    const workspaceStreams = getWorkspaceStreamsForTests(streamManager);
    const deadline = Date.now() + 5_000;
    while (!workspaceStreams.has(workspaceId)) {
      if (Date.now() > deadline) throw new Error("stream never registered");
      await new Promise((resolve) => setTimeout(resolve, 5));
    }

    await closeScopeBounded(engineScope);

    // Cancelled inside the close: abort delivered, registry cleared, no
    // stream-start ever emitted for it.
    expect(terminalEvents(events).map((event) => event.type)).toEqual(["stream-abort"]);
    expect((terminalEvents(events)[0] as StreamAbortEvent).abortReason).toBe("system");
    expect(workspaceStreams.size).toBe(0);

    releaseEnvelope();
    const result = await startPromise;
    expect(result.success).toBe(true);
    if (!result.success) throw new Error("expected Ok");
    expect(await result.data.completion).toMatchObject({
      status: "aborted",
      abortReason: "system",
    });
    expect(events.filter((event) => event.type === "stream-start")).toHaveLength(0);
    expect(terminalEvents(events)).toHaveLength(1);
    expect(streamManager.isStreaming(workspaceId)).toBe(false);
  });

  test("a provider whose iterator rejects on abort is still recorded as an abort, not a failure", async () => {
    // Some transports surface a cancellation as an iterator rejection rather
    // than a clean close. The canceller owns the terminal bookkeeping, so the
    // loop must not record that rejection as a provider failure — otherwise the
    // lost-race guard would suppress the stream-abort and the partial commit.
    const workspaceId = "abort-as-rejection-workspace";
    const { streamManager, events } = createSupervisedStreamManagerForTests(
      (signal) =>
        (async function* () {
          yield { type: "text-delta", text: "hello" };
          await new Promise<void>((resolve) => {
            if (signal.aborted) return resolve();
            signal.addEventListener("abort", () => resolve(), { once: true });
          });
          throw new Error("connection reset after abort");
        })(),
      { supervised: false }
    );
    const handle = await startSupervisedStreamForTests(streamManager, workspaceId);
    await waitForPartialText(workspaceId, "hello");

    expect(await streamManager.stopStream(workspaceId, { abortReason: "user" })).toEqual(
      Ok(undefined)
    );

    expect(await handle.completion).toMatchObject({ status: "aborted", abortReason: "user" });
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(terminalEvents(events).map((event) => event.type)).toEqual(["stream-abort"]);
    expect(getWorkspaceStreamsForTests(streamManager).size).toBe(0);
  });

  test("completed streams leave no supervisor residue: closing the scope after 50 completions aborts nothing", async () => {
    const workspaceId = "supervised-residue-workspace";
    const { streamManager, events, engineScope } = createSupervisedStreamManagerForTests(() =>
      (async function* () {
        await Promise.resolve();
        yield { type: "text-delta", text: "done" };
        yield { type: "finish", finishReason: "stop" };
      })()
    );
    for (let i = 1; i <= 50; i++) {
      const handle = await startSupervisedStreamForTests(streamManager, workspaceId, i);
      expect(await handle.completion).toMatchObject({ status: "completed" });
    }
    expect(getWorkspaceStreamsForTests(streamManager).size).toBe(0);
    expect(events.filter((event) => event.type === "stream-end")).toHaveLength(50);

    await closeScopeBounded(engineScope);

    expect(events.filter((event) => event.type === "stream-abort")).toHaveLength(0);
    expect(getWorkspaceStreamsForTests(streamManager).size).toBe(0);
  });
});

describe("StreamManager - stopWhen configuration", () => {
  type StopWhenCondition = (options: { steps: unknown[] }) => boolean;
  type BuildStopWhenCondition = (request: {
    hasQueuedMessages?: (dispatchMode?: "tool-end" | "turn-end") => boolean;
    toolPolicy?: ToolPolicy;
  }) => StopWhenCondition[];

  function buildStopWhenForTests(streamManager = new StreamManager(historyService)) {
    return getPrivateMethodForTests<BuildStopWhenCondition>(
      streamManager,
      "createStopWhenCondition"
    );
  }

  function requiredToolConditionForTests(toolPolicy: ToolPolicy): StopWhenCondition {
    const [, , requiredToolCondition] = buildStopWhenForTests()({
      hasQueuedMessages: () => false,
      toolPolicy,
    });
    return requiredToolCondition;
  }

  function stepsWithToolResult(toolName: string, output: unknown): { steps: unknown[] } {
    return { steps: [{ toolResults: [{ toolName, output }] }] };
  }

  test("returns step-cap and queued-message conditions with no policy", () => {
    let queued = false;
    const stopWhen = buildStopWhenForTests()({ hasQueuedMessages: () => queued });
    expect(stopWhen).toHaveLength(3);

    const [maxStepCondition, queuedMessageCondition, requiredToolCondition] = stopWhen;
    expect(maxStepCondition({ steps: new Array(99999) })).toBe(false);
    expect(maxStepCondition({ steps: new Array(100000) })).toBe(true);

    expect(queuedMessageCondition({ steps: [] })).toBe(false);
    queued = true;
    expect(queuedMessageCondition({ steps: [] })).toBe(true);
    expect(requiredToolCondition(stepsWithToolResult("agent_report", { success: true }))).toBe(
      false
    );
  });

  const requiredToolCases: Array<{
    name: string;
    toolPolicy: ToolPolicy;
    assertions: Array<{ toolName: string; output: unknown; expected: boolean }>;
    emptyStepsExpected?: boolean;
  }> = [
    {
      name: "stops on successful required tool result matching policy",
      toolPolicy: [{ regex_match: "agent_report", action: "require" }],
      assertions: [
        { toolName: "agent_report", output: { success: true }, expected: true },
        { toolName: "agent_report", output: { success: false }, expected: false },
        { toolName: "bash", output: { success: true }, expected: false },
      ],
      emptyStepsExpected: false,
    },
    {
      name: "stops on required tool result without success/ok markers (e.g. MCP tools)",
      toolPolicy: [{ regex_match: "chrome_take_screenshot", action: "require" }],
      assertions: [
        {
          toolName: "chrome_take_screenshot",
          output: { content: [{ type: "image", data: "..." }] },
          expected: true,
        },
      ],
    },
    {
      name: "does not stop when required tool returns error-shaped output",
      toolPolicy: [{ regex_match: "chrome_take_screenshot", action: "require" }],
      assertions: [
        {
          toolName: "chrome_take_screenshot",
          output: { error: "connection refused" },
          expected: false,
        },
        {
          toolName: "chrome_take_screenshot",
          output: { isError: true, content: [{ type: "text", text: "failed" }] },
          expected: false,
        },
      ],
    },
    {
      name: "does not stop when required tool explicitly returns success: false",
      toolPolicy: [{ regex_match: "propose_plan", action: "require" }],
      assertions: [
        {
          toolName: "propose_plan",
          output: { success: false, error: "plan file missing" },
          expected: false,
        },
      ],
    },
    {
      name: "handles pre-anchored require patterns from recovery paths",
      toolPolicy: [{ regex_match: "^agent_report$", action: "require" }],
      assertions: [{ toolName: "agent_report", output: { success: true }, expected: true }],
    },
    {
      name: "stops on successful propose_plan when required by policy",
      toolPolicy: [{ regex_match: "propose_plan", action: "require" }],
      assertions: [{ toolName: "propose_plan", output: { success: true }, expected: true }],
    },
    {
      name: "does not stop on tool results when no tools are required",
      toolPolicy: [{ regex_match: "bash", action: "enable" }],
      assertions: [{ toolName: "bash", output: { success: true }, expected: false }],
    },
  ];

  for (const requiredToolCase of requiredToolCases) {
    test(requiredToolCase.name, () => {
      const requiredToolCondition = requiredToolConditionForTests(requiredToolCase.toolPolicy);
      for (const assertion of requiredToolCase.assertions) {
        expect(
          requiredToolCondition(stepsWithToolResult(assertion.toolName, assertion.output))
        ).toBe(assertion.expected);
      }
      if (requiredToolCase.emptyStepsExpected != null) {
        expect(requiredToolCondition({ steps: [] })).toBe(requiredToolCase.emptyStepsExpected);
      }
    });
  }
});
describe("StreamManager - refusal usage attribution", () => {
  test("terminal refusal records the raw Coder identity, not the name-canonical form", async () => {
    // Cross-typed instance {name: "openai", type: "anthropic"}: the refusal
    // path must hand the RAW coder string to usage recording so
    // normalizeUsageModelKey can resolve the instance type — the canonical
    // openai:<claude> form would attribute Anthropic tokens to OpenAI.
    const rawModel = "coder:openai/claude-opus-4-5";
    const providersConfig = {
      coder: {
        apiKeySet: false,
        isEnabled: true,
        isConfigured: true,
        discoveredProviders: [{ name: "openai", type: "anthropic" }],
      },
    };
    const recordedKeys: string[] = [];
    const sessionUsageService = {
      recordUsage: (_workspaceId: string, model: string) => {
        recordedKeys.push(model);
        return Promise.resolve();
      },
    } as unknown as SessionUsageService;

    const streamManager = new StreamManager(
      historyService,
      sessionUsageService,
      () => providersConfig
    );
    const tryFallback = Reflect.get(streamManager, "tryModelFallbackAfterRefusal") as (
      workspaceId: string,
      streamInfo: Record<string, unknown>,
      refusalFinishReason: string
    ) => Promise<{ kind: string }>;
    expect(typeof tryFallback).toBe("function");

    const streamInfo = {
      model: rawModel,
      metadataModel: "anthropic:claude-opus-4-5",
      cumulativeUsage: { inputTokens: 1200, outputTokens: 30, totalTokens: 1230 },
      cumulativeProviderMetadata: undefined,
      initialMetadata: undefined,
      stepStartIndices: [0],
      parts: [],
      toolModelUsages: [],
      // No fallback chain: the terminal-refusal recording path runs.
      modelFallback: undefined,
    };

    const outcome = await tryFallback.call(streamManager, "ws-refusal-raw", streamInfo, "refusal");
    expect(outcome.kind).toBe("terminal");
    // The ledger key resolved through instance metadata (type anthropic).
    expect(recordedKeys).toEqual(["anthropic:claude-opus-4-5"]);
  });

  test("zero-usage refused attempt still records a zero-usage hop entry without touching the session ledger", async () => {
    const recordUsage = mock((_workspaceId: string, _model: string, _usage: unknown) =>
      Promise.resolve(undefined)
    );
    const sessionUsageService = { recordUsage } as unknown as SessionUsageService;
    const streamManager = new StreamManager(historyService, sessionUsageService);
    const tryFallback = Reflect.get(streamManager, "tryModelFallbackAfterRefusal") as (
      workspaceId: string,
      streamInfo: Record<string, unknown>,
      refusalFinishReason: string
    ) => Promise<{ kind: string }>;
    expect(typeof tryFallback).toBe("function");

    const toolModelUsages: Array<{ toolName: string; model: string; usage: unknown }> = [];
    const streamInfo = {
      model: KNOWN_MODELS.SONNET.id,
      metadataModel: KNOWN_MODELS.SONNET.id,
      // No billed usage anywhere: neither live-tracked nor via streamResult.
      cumulativeUsage: undefined,
      cumulativeProviderMetadata: undefined,
      streamResult: { usage: Promise.resolve(undefined), finalStep: Promise.resolve(undefined) },
      startTime: Date.now(),
      initialMetadata: undefined,
      stepStartIndices: [0],
      parts: [],
      toolModelUsages,
      abortController: { signal: { aborted: false } },
      softInterrupt: { pending: false },
      // Empty chain: the hop is recorded, then the chain exhausts terminally.
      modelFallback: {
        options: { chain: [], prepare: mock(() => Promise.reject(new Error("unused"))) },
        requestedModel: KNOWN_MODELS.SONNET.id,
        refusedModels: [],
        original: { maxOutputTokens: undefined },
      },
    };

    const outcome = await tryFallback.call(
      streamManager,
      "ws-zero-usage-hop",
      streamInfo,
      "refusal"
    );
    expect(outcome.kind).toBe("terminal");

    // The refused attempt is durably recorded with explicit zero usage so
    // analytics counts it, while the session cost ledger stays untouched.
    expect(toolModelUsages).toHaveLength(1);
    expect(toolModelUsages[0]).toMatchObject({
      toolName: "model_fallback_refusal",
      model: KNOWN_MODELS.SONNET.id,
      usage: { inputTokens: 0, outputTokens: 0, totalTokens: 0 },
    });
    expect(recordUsage).not.toHaveBeenCalled();
  });

  test("refused attempt entries persist the attribution key, not the raw gateway identity", async () => {
    // Sidecar refused_stream rows are keyed by recordHeadlessUsageLocked's
    // canonical model; a raw mux-gateway identity on committed hop rows would
    // split one model across two analytics buckets in the refusal queries.
    const recordUsage = mock((_workspaceId: string, _model: string, _usage: unknown) =>
      Promise.resolve(undefined)
    );
    const sessionUsageService = { recordUsage } as unknown as SessionUsageService;
    const streamManager = new StreamManager(historyService, sessionUsageService);
    const tryFallback = Reflect.get(streamManager, "tryModelFallbackAfterRefusal") as (
      workspaceId: string,
      streamInfo: Record<string, unknown>,
      refusalFinishReason: string
    ) => Promise<{ kind: string }>;
    expect(typeof tryFallback).toBe("function");

    const toolModelUsages: Array<{ toolName: string; model: string }> = [];
    const streamInfo = {
      model: "mux-gateway:anthropic/claude-opus-4-5",
      metadataModel: "anthropic:claude-opus-4-5",
      cumulativeUsage: { inputTokens: 10, outputTokens: 2, totalTokens: 12 },
      cumulativeProviderMetadata: { anthropic: {} },
      startTime: Date.now(),
      initialMetadata: undefined,
      stepStartIndices: [0],
      parts: [],
      toolModelUsages,
      abortController: { signal: { aborted: false } },
      softInterrupt: { pending: false },
      modelFallback: {
        options: { chain: [], prepare: mock(() => Promise.reject(new Error("unused"))) },
        requestedModel: "mux-gateway:anthropic/claude-opus-4-5",
        refusedModels: [],
        original: { maxOutputTokens: undefined },
      },
    };

    const outcome = await tryFallback.call(streamManager, "ws-gateway-hop", streamInfo, "refusal");
    expect(outcome.kind).toBe("terminal");
    expect(toolModelUsages).toHaveLength(1);
    expect(toolModelUsages[0]).toMatchObject({
      toolName: "model_fallback_refusal",
      model: "anthropic:claude-opus-4-5",
    });
  });

  test("sidecar flatten labels refusal hops refused_stream and keeps the drop reason for other usage", async () => {
    const recordHeadlessUsage = mock(
      (
        _workspaceId: string,
        _model: string,
        _usage: unknown,
        _providerMetadata: unknown,
        _options: unknown
      ) => Promise.resolve(undefined)
    );
    const sessionUsageService = { recordHeadlessUsage } as unknown as SessionUsageService;
    const streamManager = new StreamManager(historyService, sessionUsageService);
    const recordDropped = Reflect.get(streamManager, "recordDroppedPartialUsageInSidecar") as (
      workspaceId: string,
      streamInfo: Record<string, unknown>,
      usage: Record<string, number> | undefined,
      providerMetadata: Record<string, unknown> | undefined,
      analyticsSource: string,
      streamUsageSource?: string
    ) => Promise<void>;
    expect(typeof recordDropped).toBe("function");

    const streamInfo = {
      model: KNOWN_MODELS.SONNET.id,
      metadataModel: KNOWN_MODELS.SONNET.id,
      toolModelUsages: [
        {
          toolName: "model_fallback_refusal",
          timestamp: 1,
          model: KNOWN_MODELS.SONNET.id,
          metadataModel: KNOWN_MODELS.SONNET.id,
          usage: { inputTokens: 0, outputTokens: 0, totalTokens: 0 },
        },
        {
          toolName: "task",
          timestamp: 2,
          model: KNOWN_MODELS.GPT.id,
          metadataModel: KNOWN_MODELS.GPT.id,
          usage: { inputTokens: 7, outputTokens: 1, totalTokens: 8 },
        },
      ],
    };
    const sourcesOf = () =>
      recordHeadlessUsage.mock.calls.map(
        (call) => (call[4] as { analyticsSource?: string }).analyticsSource
      );

    // Aborted turn with a prior refusal hop: the stream's own usage row keeps
    // the abort label (default streamUsageSource), the hop is still a refusal,
    // and unrelated tool usage keeps the drop reason.
    await recordDropped.call(
      streamManager,
      "ws-flatten-aborted",
      streamInfo,
      { inputTokens: 2, outputTokens: 1, totalTokens: 3 },
      undefined,
      "aborted_stream"
    );
    expect(sourcesOf()).toEqual(["aborted_stream", "refused_stream", "aborted_stream"]);

    // Terminal-refusal error turn: the stream's own usage row is explicitly
    // labeled refused_stream while non-refusal tool usage stays errored_stream.
    recordHeadlessUsage.mockClear();
    await recordDropped.call(
      streamManager,
      "ws-flatten-refused",
      streamInfo,
      { inputTokens: 2, outputTokens: 1, totalTokens: 3 },
      undefined,
      "errored_stream",
      "refused_stream"
    );
    expect(sourcesOf()).toEqual(["refused_stream", "refused_stream", "errored_stream"]);
  });

  test("ledger key uses the stream's pinned metadata identity when instance metadata is gone", async () => {
    // A catalog refresh can remove/retag the instance while the turn is
    // active: the LIVE config no longer resolves coder:prod/<claude>, so a
    // live re-resolution would key the ledger under the raw string while
    // createDisplayUsage priced with the pinned metadataModel — repricing
    // would then strip the row. The stream's record-time metadataModel must
    // key the ledger instead.
    const rawModel = "coder:prod/claude-opus-4-5";
    const recordedKeys: string[] = [];
    const sessionUsageService = {
      recordUsage: (_workspaceId: string, model: string) => {
        recordedKeys.push(model);
        return Promise.resolve();
      },
    } as unknown as SessionUsageService;

    // Live config has NO metadata for the instance (removed mid-turn).
    const streamManager = new StreamManager(historyService, sessionUsageService, () => ({}));
    const recordSessionUsage = Reflect.get(streamManager, "recordSessionUsage") as (
      workspaceId: string,
      model: string,
      usage: Record<string, number>,
      providerMetadata: undefined,
      logMessage: string,
      logLevel: "warn" | "error",
      streamInfo?: Record<string, unknown>
    ) => Promise<void>;
    expect(typeof recordSessionUsage).toBe("function");

    await recordSessionUsage.call(
      streamManager,
      "ws-pinned-metadata",
      rawModel,
      { inputTokens: 100, outputTokens: 10, totalTokens: 110 },
      undefined,
      "test",
      "warn",
      { metadataModel: "anthropic:claude-opus-4-5" }
    );
    expect(recordedKeys).toEqual(["anthropic:claude-opus-4-5"]);
  });

  test("message metadata preserves the raw Coder identity", () => {
    // WorkspaceStore live deltas and SessionUsageService history rebuilds
    // re-key usage from metadata.model via normalizeUsageModelKey, which
    // needs the raw identity to resolve the instance type — the canonical
    // openai:<claude> form would accumulate under a second, wrongly priced
    // key that diverges from the backend's ledger.
    const streamManager = new StreamManager(historyService);
    const buildPartial = Reflect.get(streamManager, "buildPartialAssistantMessage") as (
      streamInfo: Record<string, unknown>,
      options?: Record<string, unknown>
    ) => MuxMessage;
    expect(typeof buildPartial).toBe("function");

    const message = buildPartial.call(streamManager, {
      messageId: "msg-raw-coder",
      historySequence: 3,
      startTime: Date.now(),
      model: "coder:openai/claude-opus-4-5",
      metadataModel: "anthropic:claude-opus-4-5",
      initialMetadata: undefined,
      stepStartIndices: [0],
      parts: [],
      toolModelUsages: [],
    });
    expect(message.metadata?.model).toBe("coder:openai/claude-opus-4-5");
    // Non-Coder gateway strings still canonicalize for display.
    const canonicalMessage = buildPartial.call(streamManager, {
      messageId: "msg-canonical",
      historySequence: 4,
      startTime: Date.now(),
      model: "mux-gateway:anthropic/claude-opus-4-5",
      metadataModel: "anthropic:claude-opus-4-5",
      initialMetadata: undefined,
      stepStartIndices: [0],
      parts: [],
      toolModelUsages: [],
    });
    expect(canonicalMessage.metadata?.model).toBe("anthropic:claude-opus-4-5");
  });
});

describe("StreamManager - fallback construction callbacks", () => {
  const eligibleProvidersConfig: ProvidersConfigMap = {
    openai: { apiKeySet: true, isEnabled: true, isConfigured: true },
  };

  // The fallback swap must evaluate the fallback's freshly-resolved route
  // (initialMetadataPatch.routeProvider), not the stale source metadata that
  // streamInfo.initialMetadata still holds when the swapped request is built.
  async function runRefusalFallbackForTests(options: {
    workspaceId: string;
    staleRouteProvider: string;
    initialMetadataPatch?: Record<string, unknown>;
    onStreamConstructed?: () => Promise<void>;
    failStreamConstruction?: boolean;
  }): Promise<Record<string, unknown>> {
    const streamManager = new StreamManager(
      historyService,
      undefined,
      () => eligibleProvidersConfig
    );
    Reflect.set(streamManager, "tokenTracker", {
      setModel: () => Promise.resolve(undefined),
      countTokens: () => Promise.resolve(0),
    });

    const messageId = `${options.workspaceId}-message`;
    const historySequence = 1;
    await appendPartialAssistantForTests(options.workspaceId, messageId, historySequence);
    const processStreamWithCleanup = getProcessStreamWithCleanupForTests(streamManager);

    const createStreamResult = mock(() => {
      if (options.failStreamConstruction) {
        throw new Error("stream construction failed for tests");
      }
      return createStreamResultForTests(
        (async function* () {
          await Promise.resolve();
          yield { type: "text-delta", text: "fallback answer" };
          yield { type: "finish", finishReason: "stop" };
        })()
      );
    });
    expect(Reflect.set(streamManager, "createStreamResult", createStreamResult)).toBe(true);

    const prepare = mock((nextModelString: string, _options?: ModelFallbackPrepareOptions) =>
      Promise.resolve(
        Ok({
          model: createTestLanguageModel("fallback-model"),
          modelString: nextModelString,
          messages: [],
          system: "You are a helpful assistant",
          tools: undefined,
          thinkingLevel: "off",
          ...(options.initialMetadataPatch
            ? { initialMetadataPatch: options.initialMetadataPatch }
            : {}),
          ...(options.onStreamConstructed
            ? { onStreamConstructed: options.onStreamConstructed }
            : {}),
        })
      )
    );

    const startTime = Date.now() - 250;
    const streamInfo = createStreamInfoForTests({
      streamResult: createStreamResultForTests(
        (async function* () {
          await Promise.resolve();
          yield { type: "finish", finishReason: "content-filter", rawFinishReason: "refusal" };
        })(),
        { inputTokens: 10, outputTokens: 0, totalTokens: 10 }
      ),
      messageId,
      startTime,
      lastPartTimestamp: startTime,
      model: KNOWN_MODELS.SONNET.id,
      metadataModel: KNOWN_MODELS.SONNET.id,
      historySequence,
      initialMetadata: { agentId: "plan", routeProvider: options.staleRouteProvider },
      request: { model: createTestLanguageModel(), messages: [], providerOptions: undefined },
      modelFallback: {
        options: { chain: ["openai:gpt-5.6-luna"], prepare },
        requestedModel: KNOWN_MODELS.SONNET.id,
        refusedModels: [],
        original: { maxOutputTokens: undefined },
      },
    });

    await processStreamWithCleanup.call(
      streamManager,
      options.workspaceId,
      streamInfo,
      historySequence
    );
    expect(prepare).toHaveBeenCalledTimes(1);
    return streamInfo.request as Record<string, unknown>;
  }

  test("onStreamConstructed fires after successful construction, never on failure", async () => {
    // Durable side effects hung on this callback (the superseding fallback
    // turn envelope) must describe a stream that exists: called exactly once
    // on success, not at all when createStreamResult throws.
    const onSuccess = mock(() => Promise.resolve());
    await runRefusalFallbackForTests({
      workspaceId: "fallback-envelope-success-workspace",
      staleRouteProvider: "openai",
      onStreamConstructed: onSuccess,
    });
    expect(onSuccess).toHaveBeenCalledTimes(1);

    const onFailure = mock(() => Promise.resolve());
    await runRefusalFallbackForTests({
      workspaceId: "fallback-envelope-failure-workspace",
      staleRouteProvider: "openai",
      onStreamConstructed: onFailure,
      failStreamConstruction: true,
    });
    expect(onFailure).not.toHaveBeenCalled();
  });
});

describe("StreamManager - sequential tool execution", () => {
  interface Deferred<T> {
    promise: Promise<T>;
    resolve: (value: T | PromiseLike<T>) => void;
    reject: (reason?: unknown) => void;
  }

  interface StreamRequestConfigForTests {
    model: unknown;
    messages: ModelMessage[];
    system?: string;
    tools?: Record<string, Tool>;
    providerOptions?: Record<string, unknown>;
    headers?: Record<string, string | undefined>;
    maxOutputTokens?: number;
    streamCallSettings?: Record<string, unknown>;
    hasQueuedMessages?: (dispatchMode?: "tool-end" | "turn-end") => boolean;
    toolPolicy?: ToolPolicy;
    toolChoice?: { type: "tool"; toolName: string };
  }

  type BuildStreamRequestConfig = (input: Record<string, unknown>) => StreamRequestConfigForTests;
  type CreateStreamResult = (
    request: StreamRequestConfigForTests,
    abortController: AbortController
  ) => unknown;

  function createDeferred<T>(): Deferred<T> {
    let resolve: Deferred<T>["resolve"] | undefined;
    let reject: Deferred<T>["reject"] | undefined;
    const promise = new Promise<T>((promiseResolve, promiseReject) => {
      resolve = promiseResolve;
      reject = promiseReject;
    });

    if (!resolve || !reject) {
      throw new Error("createDeferred failed to initialize promise controls");
    }

    return { promise, resolve, reject };
  }

  function getRequestHelpers(streamManager: StreamManager): {
    buildRequestConfig: BuildStreamRequestConfig;
    createStreamResult: CreateStreamResult;
  } {
    const buildRequestConfig = Reflect.get(streamManager, "buildStreamRequestConfig") as
      | BuildStreamRequestConfig
      | undefined;
    const createStreamResultMethod = Reflect.get(streamManager, "createStreamResult") as
      | CreateStreamResult
      | undefined;

    expect(typeof buildRequestConfig).toBe("function");
    expect(typeof createStreamResultMethod).toBe("function");

    if (!buildRequestConfig || !createStreamResultMethod) {
      throw new Error("Expected StreamManager private helpers to exist");
    }

    return {
      // .apply: buildStreamRequestConfig reads this.getProvidersConfig for
      // cache-marker eligibility; a detached Reflect.get reference loses `this`.
      buildRequestConfig: (input) => buildRequestConfig.call(streamManager, input),
      createStreamResult: (request, abortController) =>
        createStreamResultMethod.call(streamManager, request, abortController),
    };
  }

  test("passes sequentially wrapped tools to streamText", async () => {
    const streamManager = new StreamManager(historyService);
    const { buildRequestConfig, createStreamResult } = getRequestHelpers(streamManager);
    const model = createAnthropic({ apiKey: "test" })("claude-sonnet-4-5");
    const executionLog: string[] = [];
    const started = {
      a: createDeferred<void>(),
      b: createDeferred<void>(),
    };
    const release = {
      a: createDeferred<void>(),
      b: createDeferred<void>(),
    };

    const tools = {
      a: tool({
        description: "Tool A",
        inputSchema: z.object({}),
        execute: async () => {
          executionLog.push("start A");
          started.a.resolve();
          await release.a.promise;
          executionLog.push("end A");
          return { tool: "A" };
        },
      }),
      b: tool({
        description: "Tool B",
        inputSchema: z.object({}),
        execute: async () => {
          executionLog.push("start B");
          started.b.resolve();
          await release.b.promise;
          executionLog.push("end B");
          return { tool: "B" };
        },
      }),
    };

    const streamTextSpy = spyOn(aiSdk, "streamText").mockReturnValue({
      fullStream: (async function* asyncGenerator() {
        yield* [] as unknown[];
        await Promise.resolve();
      })(),
      usage: Promise.resolve(undefined),
      providerMetadata: Promise.resolve(undefined),
      totalUsage: Promise.resolve(undefined),
      steps: Promise.resolve([]),
    } as unknown as ReturnType<typeof aiSdk.streamText>);

    const request = buildRequestConfig({
      model,
      modelString: KNOWN_MODELS.SONNET.id,
      messages: [{ role: "user", content: "hello" }],
      system: "system",
      tools,
      hasQueuedMessages: () => false,
    });
    createStreamResult(request, new AbortController());

    expect(streamTextSpy).toHaveBeenCalledTimes(1);
    const capturedTools = streamTextSpy.mock.calls[0]?.[0]?.tools as
      | StreamRequestConfigForTests["tools"]
      | undefined;
    expect(capturedTools).toBeDefined();
    expect(capturedTools).not.toBe(tools);
    expect(capturedTools!.a).not.toBe(tools.a);
    expect(capturedTools!.b).not.toBe(tools.b);

    const resultsPromise = Promise.all([
      capturedTools!.a.execute!({}, {} as never),
      capturedTools!.b.execute!({}, {} as never),
    ]);

    await started.a.promise;
    await Promise.resolve();
    expect(executionLog).toEqual(["start A"]);

    release.a.resolve();
    await started.b.promise;
    await Promise.resolve();
    expect(executionLog).toEqual(["start A", "end A", "start B"]);

    release.b.resolve();
    const results = await resultsPromise;

    expect(results).toEqual([{ tool: "A" }, { tool: "B" }]);
    expect(executionLog).toEqual(["start A", "end A", "start B", "end B"]);
  });
});

describe("StreamManager - call settings overrides", () => {
  interface StreamRequestConfigForTests {
    model: unknown;
    messages: ModelMessage[];
    system?: string;
    tools?: Record<string, unknown>;
    providerOptions?: Record<string, unknown>;
    headers?: Record<string, string | undefined>;
    maxOutputTokens?: number;
    streamCallSettings?: Record<string, unknown>;
    onChunk?: NonNullable<Parameters<typeof aiSdk.streamText>[0]["onChunk"]>;
  }

  type BuildStreamRequestConfig = (input: Record<string, unknown>) => StreamRequestConfigForTests;
  type CreateStreamResult = (
    request: StreamRequestConfigForTests,
    abortController: AbortController
  ) => unknown;

  const model = createAnthropic({ apiKey: "test" })("claude-sonnet-4-5");
  const modelString = KNOWN_MODELS.SONNET.id;
  const messages: ModelMessage[] = [{ role: "user", content: "hello" }];

  function getRequestHelpers(streamManager: StreamManager): {
    buildRequestConfig: BuildStreamRequestConfig;
    createStreamResult: CreateStreamResult;
  } {
    const buildRequestConfig = Reflect.get(streamManager, "buildStreamRequestConfig") as
      | BuildStreamRequestConfig
      | undefined;
    const createStreamResultMethod = Reflect.get(streamManager, "createStreamResult") as
      | CreateStreamResult
      | undefined;

    expect(typeof buildRequestConfig).toBe("function");
    expect(typeof createStreamResultMethod).toBe("function");

    if (!buildRequestConfig || !createStreamResultMethod) {
      throw new Error("Expected StreamManager private helpers to exist");
    }

    return {
      // .apply: buildStreamRequestConfig reads this.getProvidersConfig for
      // cache-marker eligibility; a detached Reflect.get reference loses `this`.
      buildRequestConfig: (input) => buildRequestConfig.call(streamManager, input),
      createStreamResult: (request, abortController) =>
        createStreamResultMethod.call(streamManager, request, abortController),
    };
  }

  function buildRequest(
    buildRequestConfig: BuildStreamRequestConfig,
    options: {
      maxOutputTokens?: number;
      callSettingsOverrides?: {
        maxOutputTokens?: number;
        temperature?: number;
        topP?: number;
      };
    }
  ): StreamRequestConfigForTests {
    return buildRequestConfig({
      model,
      modelString,
      messages,
      system: "system",
      maxOutputTokens: options.maxOutputTokens,
      callSettingsOverrides: options.callSettingsOverrides,
    });
  }

  function setupStreamTextSpy() {
    return spyOn(aiSdk, "streamText").mockReturnValue({
      fullStream: (async function* asyncGenerator() {
        yield* [] as unknown[];
        await Promise.resolve();
      })(),
      usage: Promise.resolve(undefined),
      providerMetadata: Promise.resolve(undefined),
      totalUsage: Promise.resolve(undefined),
      steps: Promise.resolve([]),
    } as unknown as ReturnType<typeof aiSdk.streamText>);
  }

  afterEach(() => {
    mock.restore();
  });

  test("uses config maxOutputTokens override when explicit maxOutputTokens is missing", () => {
    const streamManager = new StreamManager(historyService);
    const { buildRequestConfig, createStreamResult } = getRequestHelpers(streamManager);
    const streamTextSpy = setupStreamTextSpy();

    spyOn(modelStatsModule, "getModelStats").mockReturnValue({
      max_input_tokens: 200000,
      max_output_tokens: 8192,
      input_cost_per_token: 0,
      output_cost_per_token: 0,
    });

    const request = buildRequest(buildRequestConfig, {
      callSettingsOverrides: { maxOutputTokens: 4096 },
    });

    createStreamResult(request, new AbortController());

    expect(streamTextSpy).toHaveBeenCalledWith(expect.objectContaining({ maxOutputTokens: 4096 }));
  });

  test("uses explicit maxOutputTokens over config maxOutputTokens override", () => {
    const streamManager = new StreamManager(historyService);
    const { buildRequestConfig, createStreamResult } = getRequestHelpers(streamManager);
    const streamTextSpy = setupStreamTextSpy();

    spyOn(modelStatsModule, "getModelStats").mockReturnValue({
      max_input_tokens: 200000,
      max_output_tokens: 8192,
      input_cost_per_token: 0,
      output_cost_per_token: 0,
    });

    const request = buildRequest(buildRequestConfig, {
      maxOutputTokens: 1024,
      callSettingsOverrides: { maxOutputTokens: 4096 },
    });

    createStreamResult(request, new AbortController());

    expect(streamTextSpy).toHaveBeenCalledWith(expect.objectContaining({ maxOutputTokens: 1024 }));
  });

  test("forwards stream call settings to streamText", () => {
    const streamManager = new StreamManager(historyService);
    const { buildRequestConfig, createStreamResult } = getRequestHelpers(streamManager);
    const streamTextSpy = setupStreamTextSpy();

    const request = buildRequest(buildRequestConfig, {
      callSettingsOverrides: { temperature: 0.5, topP: 0.9 },
    });

    createStreamResult(request, new AbortController());

    expect(streamTextSpy).toHaveBeenCalledWith(
      expect.objectContaining({
        temperature: 0.5,
        topP: 0.9,
      })
    );
  });

  test("forwards onChunk to streamText unchanged", () => {
    const streamManager = new StreamManager(historyService);
    const { buildRequestConfig, createStreamResult } = getRequestHelpers(streamManager);
    const streamTextSpy = setupStreamTextSpy();
    const onChunk = mock(() => undefined);

    const request = buildRequestConfig({ model, modelString, messages, system: "system", onChunk });

    createStreamResult(request, new AbortController());

    expect(streamTextSpy).toHaveBeenCalledWith(expect.objectContaining({ onChunk }));
  });

  test("does not store streamCallSettings when overrides are empty", () => {
    const streamManager = new StreamManager(historyService);
    const { buildRequestConfig } = getRequestHelpers(streamManager);

    const requestWithUndefined = buildRequest(buildRequestConfig, {
      callSettingsOverrides: undefined,
    });
    const requestWithEmpty = buildRequest(buildRequestConfig, {
      callSettingsOverrides: {},
    });

    expect(requestWithUndefined.streamCallSettings).toBeUndefined();
    expect(requestWithEmpty.streamCallSettings).toBeUndefined();
  });
});

describe("StreamManager - language model cleanup", () => {
  const runtime = LOCAL_TEST_RUNTIME;

  function createCleanupModel(modelId: string): {
    model: LanguageModel;
    getCleanupCalls: () => number;
  } {
    let cleanupCalls = 0;
    const model = createTestLanguageModel(modelId);
    attachLanguageModelCleanup(model, () => {
      cleanupCalls += 1;
    });
    return { model, getCleanupCalls: () => cleanupCalls };
  }

  async function processCleanupStream(params: {
    workspaceId: string;
    messageId: string;
    model: LanguageModel;
    streamInfoOverrides?: Record<string, unknown>;
  }): Promise<void> {
    const streamManager = new StreamManager(historyService);
    const historySequence = 1;

    await appendPartialAssistantForTests(params.workspaceId, params.messageId, historySequence);

    const streamInfo = createStreamInfoForTests({
      messageId: params.messageId,
      token: `${params.messageId}-token`,
      model: "openai:gpt-4.1-mini",
      metadataModel: "openai:gpt-4.1-mini",
      historySequence,
      request: { model: params.model, messages: [], providerOptions: undefined },
      runtime,
      ...params.streamInfoOverrides,
    });
    getWorkspaceStreamsForTests(streamManager).set(params.workspaceId, streamInfo);

    await getProcessStreamWithCleanupForTests(streamManager).call(
      streamManager,
      params.workspaceId,
      streamInfo,
      historySequence
    );
  }

  const cleanupLifecycleCases: Array<{
    name: string;
    modelId: string;
    workspaceId: string;
    messageId: string;
    streamInfoOverrides: (getCleanupCalls: () => number) => Record<string, unknown>;
  }> = [
    {
      name: "runs model cleanup when stream processing finishes",
      modelId: "cleanup-model",
      workspaceId: "cleanup-workspace",
      messageId: "cleanup-message",
      streamInfoOverrides: () => ({
        streamResult: createStreamResultForTests(
          (async function* () {
            await Promise.resolve();
            yield { type: "finish", finishReason: "stop" };
          })()
        ),
        parts: [{ type: "text" as const, text: "done", timestamp: Date.now() }],
      }),
    },
    {
      name: "keeps model cleanup until a multi-step tool stream finishes",
      modelId: "cleanup-multistep-model",
      workspaceId: "cleanup-multistep-workspace",
      messageId: "cleanup-multistep-message",
      streamInfoOverrides: (getCleanupCalls) => ({
        streamResult: createStreamResultForTests(
          (async function* () {
            await Promise.resolve();
            yield {
              type: "tool-call",
              toolCallId: "call-1",
              toolName: "test_tool",
              input: { value: 1 },
            };
            expect(getCleanupCalls()).toBe(0);
            yield {
              type: "tool-result",
              toolCallId: "call-1",
              toolName: "test_tool",
              output: { ok: true },
            };
            expect(getCleanupCalls()).toBe(0);
            yield { type: "text-delta", text: "done" };
            expect(getCleanupCalls()).toBe(0);
            yield { type: "finish", finishReason: "stop" };
          })()
        ),
      }),
    },
    {
      name: "runs model cleanup when stream processing fails",
      modelId: "cleanup-error-model",
      workspaceId: "cleanup-error-workspace",
      messageId: "cleanup-error-message",
      streamInfoOverrides: () => ({
        streamResult: createStreamResultForTests(
          (async function* () {
            await Promise.resolve();
            throw new Error("stream failed before output");
            yield* [] as unknown[];
          })(),
          { inputTokens: 1, outputTokens: 0, totalTokens: 1 }
        ),
      }),
    },
    {
      name: "runs model cleanup when stream processing is aborted",
      modelId: "cleanup-abort-model",
      workspaceId: "cleanup-abort-workspace",
      messageId: "cleanup-abort-message",
      streamInfoOverrides: () => {
        const abortController = new AbortController();
        abortController.abort(new Error("test abort"));
        return {
          abortController,
          streamResult: createStreamResultForTests(
            (async function* () {
              await Promise.resolve();
              yield* [];
            })(),
            { inputTokens: 1, outputTokens: 0, totalTokens: 1 }
          ),
        };
      },
    },
  ];

  for (const cleanupCase of cleanupLifecycleCases) {
    test(cleanupCase.name, async () => {
      const { model, getCleanupCalls } = createCleanupModel(cleanupCase.modelId);

      await processCleanupStream({
        workspaceId: cleanupCase.workspaceId,
        messageId: cleanupCase.messageId,
        model,
        streamInfoOverrides: cleanupCase.streamInfoOverrides(getCleanupCalls),
      });

      expect(getCleanupCalls()).toBe(1);
    });
  }

  test("runs model cleanup when startStream exits before processing after abort", async () => {
    const streamManager = new StreamManager(historyService);
    const { model, getCleanupCalls } = createCleanupModel("cleanup-preabort-model");
    const abortController = new AbortController();
    abortController.abort(new Error("pre-abort"));

    const result = await streamManager.startStream(
      testStartOptions({
        workspaceId: "cleanup-preabort-workspace",
        messageId: "cleanup-preabort-message",
        model,
        abortSignal: abortController.signal,
      })
    );

    expect(result.success).toBe(true);
    expect(getCleanupCalls()).toBe(1);
  });

  test("interrupt during onStreamConstructed skips processing and preserves a replacement registration", async () => {
    const streamManager = new StreamManager(historyService);
    const { model, getCleanupCalls } = createCleanupModel("constructed-abort-model");
    const startEvents: unknown[] = [];
    onTurnEngineEvent(streamManager, "stream-start", (event) => startEvents.push(event));

    const workspaceId = "constructed-abort-workspace";
    const replacementSentinel = { replacement: true };
    const onStreamConstructed = async (): Promise<void> => {
      // Hard interrupt racing the awaited envelope write: stopStream aborts
      // the registered STARTING stream, awaits its placeholder
      // processingPromise, and deletes the registration…
      await streamManager.stopStream(workspaceId);
      // …after which a replacement stream can occupy the workspace slot.
      const streams = Reflect.get(streamManager, "workspaceStreams") as Map<string, unknown>;
      streams.set(workspaceId, replacementSentinel);
    };

    const result = await streamManager.startStream(
      testStartOptions({
        workspaceId,
        messageId: "constructed-abort-message",
        model,
        onStreamConstructed,
      })
    );

    expect(result.success).toBe(true);
    // The canceled stream must never start processing: stream-start after the
    // abort would leave the UI stuck streaming with no abort/end to follow.
    expect(startEvents).toHaveLength(0);
    // The replacement registration survives (the canceled stream's cleanup
    // must not delete another stream's slot).
    const streams = Reflect.get(streamManager, "workspaceStreams") as Map<string, unknown>;
    expect(streams.get(workspaceId)).toBe(replacementSentinel);
    // The never-processed stream's model still gets cleaned up.
    expect(getCleanupCalls()).toBe(1);
  });

  test("runs model cleanup when stream creation throws before processing", async () => {
    const streamManager = new StreamManager(historyService);
    const { model, getCleanupCalls } = createCleanupModel("cleanup-create-throw-model");
    const replaceCreateStreamResult = Reflect.set(streamManager, "createStreamResult", () => {
      throw new Error("create stream failed");
    });
    expect(replaceCreateStreamResult).toBe(true);

    const result = await streamManager.startStream(
      testStartOptions({
        workspaceId: "cleanup-create-throw-workspace",
        messageId: "cleanup-create-throw-message",
        model,
      })
    );

    expect(result.success).toBe(false);
    expect(getCleanupCalls()).toBe(1);
  });
});

describe("StreamManager - turn completion", () => {
  function stubTokenTracker(streamManager: StreamManager): void {
    Reflect.set(streamManager, "tokenTracker", {
      setModel: () => Promise.resolve(),
      countTokens: () => Promise.resolve(0),
    });
  }

  /** Stream body that stays open until its turn abort controller fires. */
  const hangUntilAbort = (_request: unknown, abortController: AbortController) =>
    createStreamResultForTests(
      (async function* () {
        await new Promise<void>((resolve) => {
          abortController.signal.addEventListener("abort", () => resolve(), { once: true });
        });
        yield* [];
      })()
    );

  async function startWithStreamResult(input: {
    workspaceId: string;
    messageId: string;
    fullStream?: AsyncGenerator<unknown, void, unknown>;
    createStreamResult?: (request: unknown, abortController: AbortController) => unknown;
    sink?: (event: TurnEngineEvent) => void | Promise<void>;
    events?: TurnEngineEvent[];
    systemMessageTokens?: number;
  }) {
    const streamManager = new StreamManager(
      historyService,
      undefined,
      undefined,
      input.sink ??
        ((event) => {
          input.events?.push(event);
        })
    );
    stubTokenTracker(streamManager);
    Reflect.set(
      streamManager,
      "createStreamResult",
      input.createStreamResult ?? (() => createStreamResultForTests(input.fullStream!))
    );
    await appendPartialAssistantForTests(input.workspaceId, input.messageId, 1);

    const result = await streamManager.startStream(
      testStartOptions({
        workspaceId: input.workspaceId,
        messageId: input.messageId,
        model: createTestLanguageModel(),
        providedRuntimeTempDir: "",
        initialMetadata: { systemMessageTokens: input.systemMessageTokens },
      })
    );
    expect(result.success).toBe(true);
    if (!result.success) throw new Error("Expected stream to start");
    return { streamManager, handle: result.data };
  }

  test("pre-start failures return Err while successful startup owns an aborted completion", async () => {
    const streamManager = new StreamManager(historyService);
    const model = createTestLanguageModel();
    const failed = await streamManager.startStream(
      testStartOptions({
        workspaceId: "completion-prestart-failure",
        messageId: "prestart-failure-message",
        model,
        messages: [],
      })
    );
    expect(failed.success).toBe(false);

    const abortController = new AbortController();
    abortController.abort();
    const aborted = await streamManager.startStream(
      testStartOptions({
        workspaceId: "completion-prestart-abort",
        messageId: "prestart-abort-message",
        model,
        abortSignal: abortController.signal,
      })
    );
    expect(aborted.success).toBe(true);
    if (!aborted.success) throw new Error("Expected aborted startup handle");
    expect(await aborted.data.completion).toMatchObject({
      status: "aborted",
      abortReason: "startup",
    });
  });

  test("completed, failed, and debug-injected turns settle once after their terminal event", async () => {
    const completedEvents: TurnEngineEvent[] = [];
    const completed = await startWithStreamResult({
      workspaceId: "completion-success-workspace",
      messageId: "completion-success-message",
      events: completedEvents,
      fullStream: (async function* () {
        await Promise.resolve();
        yield { type: "text-delta", text: "done" };
        yield { type: "finish", finishReason: "stop" };
      })(),
    });
    let completedSettlements = 0;
    void completed.handle.completion.then(() => {
      completedSettlements += 1;
    });
    expect(await completed.handle.completion).toMatchObject({ status: "completed" });
    await Promise.resolve();
    expect(completedEvents.at(-1)?.type).toBe("stream-end");
    expect(completedSettlements).toBe(1);

    const failedEvents: TurnEngineEvent[] = [];
    const failed = await startWithStreamResult({
      workspaceId: "completion-failure-workspace",
      messageId: "completion-failure-message",
      events: failedEvents,
      fullStream: (async function* () {
        await Promise.resolve();
        throw new Error("provider failed");
        yield* [];
      })(),
    });
    let failedSettlements = 0;
    void failed.handle.completion.then(() => {
      failedSettlements += 1;
    });
    const failedCompletion = await failed.handle.completion;
    expect(failedCompletion.status).toBe("failed");
    expect(failedEvents.at(-1)?.type).toBe("error");
    await failed.streamManager.stopStream("completion-failure-workspace");
    await Promise.resolve();
    expect(failedSettlements).toBe(1);

    // Debug-injected failures reach the same terminal settlement path.
    const debug = await startWithStreamResult({
      workspaceId: "completion-debug-error-workspace",
      messageId: "completion-debug-error-message",
      createStreamResult: hangUntilAbort,
    });
    expect(
      await debug.streamManager.debugTriggerStreamError(
        "completion-debug-error-workspace",
        "debug injected failure"
      )
    ).toBe(true);
    expect(await debug.handle.completion).toMatchObject({
      status: "failed",
      streamError: { error: "debug injected failure" },
    });
  });

  test("aborted completion waits for the sink to commit and remove the partial", async () => {
    const workspaceId = "completion-abort-workspace";
    const providerBlocked = Promise.withResolvers<void>();
    const abortDeliveryEntered = Promise.withResolvers<void>();
    const releaseAbortDelivery = Promise.withResolvers<void>();
    const { streamManager, handle } = await startWithStreamResult({
      workspaceId,
      messageId: "completion-abort-message",
      systemMessageTokens: 733,
      createStreamResult: (_request, controller) =>
        createStreamResultForTests(
          (async function* () {
            yield { type: "text-delta", text: "interrupted answer" };
            providerBlocked.resolve();
            await new Promise<void>((resolve) => {
              if (controller.signal.aborted) return resolve();
              controller.signal.addEventListener("abort", () => resolve(), { once: true });
            });
          })()
        ),
      sink: async (event) => {
        if (event.type !== "stream-abort") return;
        abortDeliveryEntered.resolve();
        await releaseAbortDelivery.promise;
        // The facade owns abort persistence. A completion consumer must see its cleanup,
        // even though stopStream has already released the engine's streaming registration.
        await historyService.commitPartial(workspaceId);
        await historyService.deletePartial(workspaceId);
      },
    });

    let settled = false;
    const completionObserved = handle.completion.then(async () => {
      settled = true;
      return {
        history: await historyService.getHistoryFromLatestBoundary(workspaceId),
        partial: await historyService.readPartial(workspaceId),
      };
    });
    let stopPromise: Promise<unknown> | undefined;
    try {
      await providerBlocked.promise;
      stopPromise = streamManager.stopStream(workspaceId, { abortReason: "user" });
      await stopPromise;
      await abortDeliveryEntered.promise;
      expect(streamManager.isStreaming(workspaceId)).toBe(false);
      expect(await historyService.readPartial(workspaceId)).toMatchObject({
        parts: [{ type: "text", text: "interrupted answer" }],
      });
      expect(settled).toBe(false);

      releaseAbortDelivery.resolve();
      expect(await handle.completion).toMatchObject({
        status: "aborted",
        abortReason: "user",
        systemMessageTokens: 733,
        streamAbort: { type: "stream-abort", workspaceId, messageId: handle.messageId },
      });
      expect(streamManager.getStreamInfo(workspaceId)).toBeUndefined();
      const observed = await completionObserved;
      expect(observed.partial).toBeNull();
      expect(observed.history.success).toBe(true);
      if (!observed.history.success) throw new Error(observed.history.error);
      expect(observed.history.data).toMatchObject([
        { id: handle.messageId, parts: [{ type: "text", text: "interrupted answer" }] },
      ]);
    } finally {
      releaseAbortDelivery.resolve();
      await (stopPromise ?? streamManager.stopStream(workspaceId));
      await completionObserved;
    }
  });
});

describe("StreamManager - stripEncryptedContent", () => {
  test("strips encryptedContent from array output shape", () => {
    const output = [
      {
        url: "https://example.com/a",
        title: "Result A",
        pageAge: "2d",
        encryptedContent: "secret-a",
      },
      {
        url: "https://example.com/b",
        title: "Result B",
      },
      "non-object-item",
    ];

    expect(stripEncryptedContent(output)).toEqual([
      {
        url: "https://example.com/a",
        title: "Result A",
        pageAge: "2d",
      },
      {
        url: "https://example.com/b",
        title: "Result B",
      },
      "non-object-item",
    ]);
  });

  test("strips encryptedContent from json value output shape", () => {
    const output = {
      type: "json",
      value: [
        {
          url: "https://example.com/c",
          title: "Result C",
          encryptedContent: "secret-c",
        },
        {
          url: "https://example.com/d",
          title: "Result D",
          pageAge: "5h",
        },
      ],
      source: "web_search",
    };

    expect(stripEncryptedContent(output)).toEqual({
      type: "json",
      value: [
        {
          url: "https://example.com/c",
          title: "Result C",
        },
        {
          url: "https://example.com/d",
          title: "Result D",
          pageAge: "5h",
        },
      ],
      source: "web_search",
    });
  });
});

describe("StreamManager - Concurrent Stream Prevention", () => {
  let streamManager: StreamManager;
  const runtime = createRuntime({ type: "local", srcBaseDir: "/tmp" });

  beforeEach(() => {
    streamManager = new StreamManager(historyService);
    // Suppress error events from bubbling up as uncaught exceptions during tests
  });

  // Unit test - doesn't require API key
  test("should serialize multiple rapid startStream calls", async () => {
    // This is a simpler test that doesn't require API key
    // It tests the mutex behavior without actually streaming

    const workspaceId = "test-workspace-serial";

    // Track the order of operations
    const operations: string[] = [];

    // Create a dummy model (won't actually be used since we're mocking the core behavior)
    const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

    interface WorkspaceStreamInfoStub {
      state: string;
      streamResult: {
        fullStream: AsyncGenerator<unknown, void, unknown>;
        usage: Promise<unknown>;
        providerMetadata: Promise<unknown>;
      };
      abortController: AbortController;
      messageId: string;
      token: string;
      startTime: number;
      model: string;
      initialMetadata?: Record<string, unknown>;
      historySequence: number;
      parts: unknown[];
      lastPartialWriteTime: number;
      partialWriteTimer?: ReturnType<typeof setTimeout>;
      partialWritePromise?: Promise<void>;
      processingPromise: Promise<void>;
    }

    const replaceEnsureResult = Reflect.set(
      streamManager,
      "ensureStreamSafety",
      async (_wsId: string): Promise<string> => {
        operations.push("ensure-start");
        await new Promise((resolve) => setTimeout(resolve, 50));
        operations.push("ensure-end");
        return "test-token";
      }
    );

    const replaceTempDirResult = Reflect.set(
      streamManager,
      "createTempDirForStream",
      (_streamToken: string, _runtime: unknown): Promise<string> => {
        return Promise.resolve("/tmp/mock-stream-temp");
      }
    );

    if (!replaceTempDirResult) {
      throw new Error("Failed to mock StreamManager.createTempDirForStream");
    }
    if (!replaceEnsureResult) {
      throw new Error("Failed to mock StreamManager.ensureStreamSafety");
    }

    const workspaceStreamsValue = Reflect.get(streamManager, "workspaceStreams") as unknown;
    if (!(workspaceStreamsValue instanceof Map)) {
      throw new Error("StreamManager.workspaceStreams is not a Map");
    }
    const workspaceStreams = workspaceStreamsValue as Map<string, WorkspaceStreamInfoStub>;

    const replaceCreateResult = Reflect.set(
      streamManager,
      "createStreamAtomically",
      (
        options: TurnExecutionOptions,
        ctx: { streamToken: string; abortController: AbortController }
      ): WorkspaceStreamInfoStub => {
        operations.push("create");

        const streamInfo: WorkspaceStreamInfoStub = {
          state: "starting",
          streamResult: {
            fullStream: (async function* asyncGenerator() {
              // No-op generator; we only care about synchronization
            })(),
            usage: Promise.resolve(undefined),
            providerMetadata: Promise.resolve(undefined),
          },
          abortController: ctx.abortController,
          messageId: `test-${Math.random().toString(36).slice(2)}`,
          token: ctx.streamToken,
          startTime: Date.now(),
          model: options.modelString,
          initialMetadata: options.initialMetadata,
          historySequence: options.historySequence,
          parts: [],
          lastPartialWriteTime: 0,
          partialWriteTimer: undefined,
          partialWritePromise: undefined,
          processingPromise: Promise.resolve(),
        };

        workspaceStreams.set(options.workspaceId, streamInfo);
        return streamInfo;
      }
    );

    if (!replaceCreateResult) {
      throw new Error("Failed to mock StreamManager.createStreamAtomically");
    }

    const replaceProcessResult = Reflect.set(
      streamManager,
      "processStreamWithCleanup",
      async (_wsId: string, info: WorkspaceStreamInfoStub): Promise<void> => {
        operations.push("process-start");
        await sleep(20);
        info.state = "streaming";
        operations.push("process-end");
      }
    );

    if (!replaceProcessResult) {
      throw new Error("Failed to mock StreamManager.processStreamWithCleanup");
    }

    const anthropic = createAnthropic({ apiKey: "dummy-key" });
    const model = anthropic("claude-sonnet-4-5");

    // Start three streams rapidly
    // Without mutex, these would interleave (ensure-start, ensure-start, ensure-start, ensure-end, ensure-end, ensure-end)
    // With mutex, they should be serialized (ensure-start, ensure-end, ensure-start, ensure-end, ensure-start, ensure-end)
    const promises = [1, 2, 3].map((sequence) =>
      streamManager.startStream({
        workspaceId,
        messages: [{ role: "user", content: `test ${sequence}` }],
        model,
        modelString: KNOWN_MODELS.SONNET.id,
        historySequence: sequence,
        system: "system",
        runtime,
        messageId: `test-msg-${sequence}`,
        tools: {},
      })
    );

    // Wait for all to complete (they will fail due to dummy API key, but that's ok)
    await Promise.allSettled(promises);

    // Verify operations are serialized: each ensure-start should be followed by its ensure-end
    // before the next ensure-start
    const ensureOperations = operations.filter((op) => op.startsWith("ensure"));
    for (let i = 0; i < ensureOperations.length - 1; i += 2) {
      expect(ensureOperations[i]).toBe("ensure-start");
      expect(ensureOperations[i + 1]).toBe("ensure-end");
    }
  });

  test("should honor abortSignal before atomic stream creation", async () => {
    const workspaceId = "test-workspace-abort-before-create";

    let createCalled = false;
    let processCalled = false;
    let streamStartEmitted = false;

    onTurnEngineEvent(streamManager, "stream-start", () => {
      streamStartEmitted = true;
    });

    const abortController = new AbortController();

    let tempDirStartedResolve: (() => void) | undefined;
    const tempDirStarted = new Promise<void>((resolve) => {
      tempDirStartedResolve = resolve;
    });

    let cleanupCalled = false;
    Reflect.set(streamManager, "createTempDirForStream", (): Promise<string> => {
      tempDirStartedResolve?.();
      return new Promise((resolve) => {
        abortController.signal.addEventListener("abort", () => resolve("/tmp/mock-stream-temp"), {
          once: true,
        });
      });
    });
    Reflect.set(streamManager, "cleanupStreamTempDir", (): void => {
      cleanupCalled = true;
    });
    Reflect.set(streamManager, "createStreamAtomically", (): never => {
      createCalled = true;
      throw new Error("createStreamAtomically should not be called");
    });
    Reflect.set(streamManager, "processStreamWithCleanup", (): Promise<void> => {
      processCalled = true;
      return Promise.resolve();
    });

    const startPromise = streamManager.startStream(
      testStartOptions({
        workspaceId,
        messageId: "test-msg-abort",
        model: createTestLanguageModel(),
        runtime,
        abortSignal: abortController.signal,
        tools: {},
      })
    );

    await tempDirStarted;
    abortController.abort();

    const result = await startPromise;
    expect(result.success).toBe(true);
    if (!result.success) throw new Error("Expected aborted startup handle");
    expect(await result.data.completion).toMatchObject({
      status: "aborted",
      abortReason: "startup",
    });
    expect(createCalled).toBe(false);
    expect(cleanupCalled).toBe(true);
    expect(processCalled).toBe(false);
    expect(streamStartEmitted).toBe(false);
    expect(streamManager.isStreaming(workspaceId)).toBe(false);
  });
});

describe("StreamManager - exact step indices", () => {
  test("persists exact tool-only step boundaries through successful completion", async () => {
    const streamManager = new StreamManager(historyService);
    const workspaceId = "step-indices-workspace";
    const messageId = "step-indices-message";
    await appendPartialAssistantForTests(workspaceId, messageId, 1);
    Reflect.set(streamManager, "tokenTracker", {
      setModel: () => Promise.resolve(undefined),
      countTokens: () => Promise.resolve(0),
    });
    const streamInfo = createStreamInfoForTests({
      messageId,
      streamResult: createStreamResultForTests(
        (async function* () {
          await Promise.resolve();
          for (const toolCallId of ["first", "second"]) {
            yield { type: "start-step" };
            // An empty/repeated SDK start must not create duplicate indices.
            yield { type: "start-step" };
            yield { type: "tool-call", toolCallId, toolName: "bash", input: { script: "pwd" } };
            yield { type: "tool-result", toolCallId, toolName: "bash", output: "/tmp" };
            yield {
              type: "finish-step",
              usage: { inputTokens: 10, outputTokens: 1, totalTokens: 11 },
            };
          }
          yield { type: "start-step" };
          yield { type: "finish", finishReason: "stop" };
        })()
      ),
    });
    await getProcessStreamWithCleanupForTests(streamManager).call(
      streamManager,
      workspaceId,
      streamInfo,
      1
    );
    const history = await historyService.getHistoryFromLatestBoundary(workspaceId);
    expect(history.success).toBe(true);
    if (!history.success) throw new Error(history.error);
    const committed = history.data.find((row) => row.id === messageId);
    expect(committed?.parts.map((part) => part.type)).toEqual(["dynamic-tool", "dynamic-tool"]);
    expect(committed?.metadata?.stepStartPartIndices).toEqual([0, 1]);
    expect(streamInfo.stepStartIndices).toEqual([0, 1, 2]);
  });

  test.each([true, false])(
    "retry reset preserves or discards step indices with parts: %s",
    async (preserveParts) => {
      const streamManager = new StreamManager(historyService);
      const streamInfo = createStreamInfoForTests({
        parts: [{ type: "text", text: "preserved", timestamp: 1 }],
        stepStartIndices: [0, 1, 3],
      });
      const reset = getPrivateMethodForTests<
        (
          workspaceId: string,
          streamInfo: unknown,
          options: { preserveParts: boolean }
        ) => Promise<void>
      >(streamManager, "resetStreamStateForRetry");
      await reset.call(streamManager, "step-reset-workspace", streamInfo, { preserveParts });
      expect(streamInfo.stepStartIndices).toEqual(preserveParts ? [0, 1] : [0]);
      expect(streamInfo.currentStepStartIndex).toBe(preserveParts ? 1 : 0);
      const buildPartial = getPrivateMethodForTests<(streamInfo: unknown) => MuxMessage>(
        streamManager,
        "buildPartialAssistantMessage"
      );
      const partial = buildPartial.call(streamManager, streamInfo);
      expect(partial.metadata?.stepStartPartIndices).toEqual(preserveParts ? [0] : []);
      await historyService.writePartial("step-reset-workspace", partial);
      expect(
        (await historyService.readPartial("step-reset-workspace"))?.metadata?.stepStartPartIndices
      ).toEqual(preserveParts ? [0] : []);
    }
  );
});

describe("StreamManager - empty stream completions", () => {
  const runtime = createRuntime({ type: "local", srcBaseDir: "/tmp" });

  test("retries one empty stream internally before persisting a retryable empty-output error", async () => {
    const streamManager = new StreamManager(historyService);
    const errorEvents: Array<{ messageId: string; error: string; errorType?: string }> = [];
    const streamEndEvents: unknown[] = [];

    onTurnEngineEvent(streamManager, "error", (data) => {
      errorEvents.push(data as { messageId: string; error: string; errorType?: string });
    });
    onTurnEngineEvent(streamManager, "stream-end", (data) => {
      streamEndEvents.push(data);
    });

    const replaceTokenTrackerResult = Reflect.set(streamManager, "tokenTracker", {
      setModel: () => Promise.resolve(undefined),
      countTokens: () => Promise.resolve(0),
    });
    expect(replaceTokenTrackerResult).toBe(true);

    const workspaceId = "empty-output-workspace";
    const messageId = "empty-output-message";
    const historySequence = 1;

    await appendPartialAssistantForTests(workspaceId, messageId, historySequence);
    const processStreamWithCleanup = getProcessStreamWithCleanupForTests(streamManager);
    const emptyUsage = { inputTokens: 3, outputTokens: 0, totalTokens: 3 };
    const createStreamResult = mock(() =>
      createStreamResultForTests(
        (async function* () {
          // Retry path also returns no output so the empty-output error still surfaces.
        })(),
        emptyUsage
      )
    );
    expect(Reflect.set(streamManager, "createStreamResult", createStreamResult)).toBe(true);

    const startTime = Date.now() - 250;
    const streamInfo = createStreamInfoForTests({
      streamResult: createStreamResultForTests(
        (async function* () {
          // No-op stream: this reproduces the silent placeholder case we saw in debug logs.
        })(),
        emptyUsage
      ),
      messageId,
      startTime,
      lastPartTimestamp: startTime,
      model: KNOWN_MODELS.SONNET.id,
      metadataModel: KNOWN_MODELS.SONNET.id,
      historySequence,
      initialMetadata: { agentId: "plan" },
      request: { model: "ignored-model", messages: [], providerOptions: undefined },
      runtime,
      cumulativeUsage: { inputTokens: 7, outputTokens: 0, totalTokens: 7 },
      cumulativeProviderMetadata: { openai: { cached_tokens: 2 } },
      lastStepUsage: { inputTokens: 7, outputTokens: 0, totalTokens: 7 },
      lastStepProviderMetadata: { openai: { cached_tokens: 2 } },
    });

    await processStreamWithCleanup.call(streamManager, workspaceId, streamInfo, historySequence);

    expect(createStreamResult).toHaveBeenCalledTimes(1);
    expect(streamEndEvents).toHaveLength(0);
    expect(errorEvents).toHaveLength(1);
    expect(errorEvents[0]).toMatchObject({
      messageId,
      errorType: "empty_output",
    });
    expect(errorEvents[0]?.error).toContain("before producing any assistant-visible output");

    expect(streamInfo.cumulativeUsage).toEqual({ inputTokens: 7, outputTokens: 0, totalTokens: 7 });
    expect(streamInfo.lastStepUsage).toEqual({ inputTokens: 7, outputTokens: 0, totalTokens: 7 });
    expect(streamInfo.cumulativeProviderMetadata).toEqual({ openai: { cached_tokens: 2 } });
    expect(streamInfo.lastStepProviderMetadata).toEqual({ openai: { cached_tokens: 2 } });

    const partial = await historyService.readPartial(workspaceId);
    expect(partial?.metadata?.errorType).toBe("empty_output");
    expect(partial?.metadata?.error).toContain("before producing any assistant-visible output");
    expect(partial?.metadata?.metadataModel).toBe(KNOWN_MODELS.SONNET.id);
    expect(partial?.parts).toEqual([]);
    // Errored turns are sidecar-canonical: usage is deliberately NOT stamped
    // on the error partial (it routes to headless-usage.jsonl, covered by
    // dedicated sidecar tests) so a later commit cannot double-count.
    expect(partial?.metadata?.usage).toBeUndefined();
    expect(partial?.metadata?.providerMetadata).toEqual({ openai: { cached_tokens: 2 } });
  });

  test("persists retryable partial error when a non-empty stream closes before finish", async () => {
    const streamManager = new StreamManager(historyService);
    const errorEvents: Array<{ messageId: string; error: string; errorType?: string }> = [];
    const streamEndEvents: unknown[] = [];

    onTurnEngineEvent(streamManager, "error", (data) => {
      errorEvents.push(data as { messageId: string; error: string; errorType?: string });
    });
    onTurnEngineEvent(streamManager, "stream-end", (data) => {
      streamEndEvents.push(data);
    });

    const replaceTokenTrackerResult = Reflect.set(streamManager, "tokenTracker", {
      setModel: () => Promise.resolve(undefined),
      countTokens: () => Promise.resolve(0),
    });
    expect(replaceTokenTrackerResult).toBe(true);

    const workspaceId = "truncated-stream-workspace";
    const messageId = "truncated-stream-message";
    const historySequence = 1;

    await appendPartialAssistantForTests(workspaceId, messageId, historySequence);
    const processStreamWithCleanup = getProcessStreamWithCleanupForTests(streamManager);
    const startTime = Date.now() - 250;
    const streamInfo = createStreamInfoForTests({
      streamResult: createStreamResultForTests(
        (async function* () {
          await Promise.resolve();
          yield { type: "text-delta", text: "partial answer" };
        })(),
        { inputTokens: 3, outputTokens: 2, totalTokens: 5 }
      ),
      messageId,
      startTime,
      lastPartTimestamp: startTime,
      model: KNOWN_MODELS.SONNET.id,
      metadataModel: KNOWN_MODELS.SONNET.id,
      historySequence,
      initialMetadata: { agentId: "plan" },
      runtime,
    });

    await processStreamWithCleanup.call(streamManager, workspaceId, streamInfo, historySequence);

    expect(streamEndEvents).toHaveLength(0);
    expect(errorEvents).toHaveLength(1);
    expect(errorEvents[0]).toMatchObject({
      messageId,
      errorType: "stream_truncated",
    });
    expect(errorEvents[0]?.error).toContain(
      "Anthropic stream closed unexpectedly before the response completed"
    );

    const partial = await historyService.readPartial(workspaceId);
    expect(partial?.metadata?.errorType).toBe("stream_truncated");
    expect(partial?.metadata?.error).toContain(
      "Anthropic stream closed unexpectedly before the response completed"
    );
    expect(partial?.metadata?.metadataModel).toBe(KNOWN_MODELS.SONNET.id);
    expect(partial?.parts).toMatchObject([{ type: "text", text: "partial answer" }]);
  });

  test("treats streamText's synthesized (other, undefined) finish part as a truncated stream", async () => {
    // streamText's runStep initializes stepFinishReason="other" /
    // stepRawFinishReason=undefined and unconditionally emits those from its
    // flush() at end-of-stream. The OpenAI Responses, Chat Completions, and
    // Anthropic Messages adapters all surface this shape when the upstream
    // SSE stream closed before any terminal event arrived. StreamManager
    // must treat that synthesized default as a missing terminal event so the
    // existing truncation guard fires a retryable `stream_truncated` error
    // rather than committing the partial output as a clean assistant
    // message.
    const streamManager = new StreamManager(historyService);
    const errorEvents: Array<{ messageId: string; error: string; errorType?: string }> = [];
    const streamEndEvents: unknown[] = [];

    onTurnEngineEvent(streamManager, "error", (data) => {
      errorEvents.push(data as { messageId: string; error: string; errorType?: string });
    });
    onTurnEngineEvent(streamManager, "stream-end", (data) => {
      streamEndEvents.push(data);
    });

    Reflect.set(streamManager, "tokenTracker", {
      setModel: () => Promise.resolve(undefined),
      countTokens: () => Promise.resolve(0),
    });

    const workspaceId = "synthesized-finish-workspace";
    const messageId = "synthesized-finish-message";
    const historySequence = 1;

    await appendPartialAssistantForTests(workspaceId, messageId, historySequence);
    const processStreamWithCleanup = getProcessStreamWithCleanupForTests(streamManager);
    const startTime = Date.now() - 250;
    const streamInfo = createStreamInfoForTests({
      streamResult: createStreamResultForTests(
        (async function* () {
          await Promise.resolve();
          yield { type: "text-delta", text: "partial answer" };
          // The provider adapter never emitted its own finish (e.g. clean
          // SSE EOF before response.completed / message_stop). The ai
          // package's flush() synthesizes this one:
          yield { type: "finish", finishReason: "other", rawFinishReason: undefined };
        })(),
        { inputTokens: 3, outputTokens: 2, totalTokens: 5 }
      ),
      messageId,
      startTime,
      lastPartTimestamp: startTime,
      model: KNOWN_MODELS.SONNET.id,
      metadataModel: KNOWN_MODELS.SONNET.id,
      historySequence,
      initialMetadata: { agentId: "plan" },
      runtime,
    });

    await processStreamWithCleanup.call(streamManager, workspaceId, streamInfo, historySequence);

    expect(streamEndEvents).toHaveLength(0);
    expect(errorEvents).toHaveLength(1);
    expect(errorEvents[0]).toMatchObject({
      messageId,
      errorType: "stream_truncated",
    });

    const partial = await historyService.readPartial(workspaceId);
    expect(partial?.metadata?.errorType).toBe("stream_truncated");
    expect(partial?.parts).toMatchObject([{ type: "text", text: "partial answer" }]);
  });

  test("treats real (other, <raw>) finish parts as a clean completion", async () => {
    // The synthesized-default discriminator must NOT swallow legitimate
    // `"other"` finishes. Both OpenAI and Anthropic map a few real stop
    // reasons to `unified: "other"`, but always with a defined raw value
    // (e.g. Anthropic's `"compaction"`). This test guards against the
    // discriminator widening into a false positive that would mis-fire the
    // truncation guard on a clean stream.
    const streamManager = new StreamManager(historyService);
    const errorEvents: Array<{ messageId: string; error: string; errorType?: string }> = [];
    const streamEndEvents: unknown[] = [];

    onTurnEngineEvent(streamManager, "error", (data) => {
      errorEvents.push(data as { messageId: string; error: string; errorType?: string });
    });
    onTurnEngineEvent(streamManager, "stream-end", (data) => {
      streamEndEvents.push(data);
    });

    Reflect.set(streamManager, "tokenTracker", {
      setModel: () => Promise.resolve(undefined),
      countTokens: () => Promise.resolve(0),
    });

    const workspaceId = "real-other-finish-workspace";
    const messageId = "real-other-finish-message";
    const historySequence = 1;

    await appendPartialAssistantForTests(workspaceId, messageId, historySequence);
    const processStreamWithCleanup = getProcessStreamWithCleanupForTests(streamManager);
    const startTime = Date.now() - 250;
    const streamInfo = createStreamInfoForTests({
      streamResult: createStreamResultForTests(
        (async function* () {
          await Promise.resolve();
          yield { type: "text-delta", text: "complete answer" };
          // Real Anthropic compaction finish (or any other mapped-to-other
          // stop reason) carries a defined raw value.
          yield { type: "finish", finishReason: "other", rawFinishReason: "compaction" };
        })(),
        { inputTokens: 3, outputTokens: 2, totalTokens: 5 }
      ),
      messageId,
      startTime,
      lastPartTimestamp: startTime,
      model: KNOWN_MODELS.SONNET.id,
      metadataModel: KNOWN_MODELS.SONNET.id,
      historySequence,
      initialMetadata: { agentId: "plan" },
      runtime,
    });

    await processStreamWithCleanup.call(streamManager, workspaceId, streamInfo, historySequence);

    expect(errorEvents).toHaveLength(0);
    expect(streamEndEvents).toHaveLength(1);
  });

  test("classifies zero-output refusal finish as terminal model_refusal without empty-stream retry", async () => {
    // The AI SDK's Anthropic adapter maps stop_reason "refusal" to the unified
    // finish reason "content-filter" with rawFinishReason "refusal" (pinned
    // against @ai-sdk/anthropic 3.0.82). A refusal with zero output is a
    // deliberate terminal outcome: it must NOT take the empty-output recovery
    // path (in-stream retry + retryable empty_output), which previously looped
    // auto-retries on the same refusal forever.
    const streamManager = new StreamManager(historyService);
    const errorEvents: Array<{ messageId: string; error: string; errorType?: string }> = [];
    const streamEndEvents: unknown[] = [];

    onTurnEngineEvent(streamManager, "error", (data) => {
      errorEvents.push(data as { messageId: string; error: string; errorType?: string });
    });
    onTurnEngineEvent(streamManager, "stream-end", (data) => {
      streamEndEvents.push(data);
    });

    Reflect.set(streamManager, "tokenTracker", {
      setModel: () => Promise.resolve(undefined),
      countTokens: () => Promise.resolve(0),
    });

    const workspaceId = "refusal-workspace";
    const messageId = "refusal-message";
    const historySequence = 1;

    await appendPartialAssistantForTests(workspaceId, messageId, historySequence);
    const processStreamWithCleanup = getProcessStreamWithCleanupForTests(streamManager);

    // Guard that no empty-stream recovery attempt re-creates the stream.
    const createStreamResult = mock(() =>
      createStreamResultForTests(
        (async function* () {
          // Would refuse again; must never be called.
        })()
      )
    );
    expect(Reflect.set(streamManager, "createStreamResult", createStreamResult)).toBe(true);

    const startTime = Date.now() - 250;
    const streamInfo = createStreamInfoForTests({
      streamResult: createStreamResultForTests(
        (async function* () {
          await Promise.resolve();
          yield { type: "finish", finishReason: "content-filter", rawFinishReason: "refusal" };
        })(),
        { inputTokens: 30000, outputTokens: 0, totalTokens: 30000 }
      ),
      messageId,
      startTime,
      lastPartTimestamp: startTime,
      model: KNOWN_MODELS.SONNET.id,
      metadataModel: KNOWN_MODELS.SONNET.id,
      historySequence,
      initialMetadata: { agentId: "plan" },
      runtime,
    });

    await processStreamWithCleanup.call(streamManager, workspaceId, streamInfo, historySequence);

    expect(createStreamResult).not.toHaveBeenCalled();
    expect(streamEndEvents).toHaveLength(0);
    expect(errorEvents).toHaveLength(1);
    expect(errorEvents[0]).toMatchObject({
      messageId,
      errorType: "model_refusal",
    });
    expect(errorEvents[0]?.error).toContain("refused to continue");

    const partial = await historyService.readPartial(workspaceId);
    expect(partial?.metadata?.errorType).toBe("model_refusal");
    expect(partial?.metadata?.finishReason).toBe("content-filter");
    // Sidecar-canonical: refusal usage routes to headless-usage.jsonl, so the
    // partial (and its eventual commit) must not carry usage.
    expect(partial?.metadata?.usage).toBeUndefined();

    const commitResult = await historyService.commitPartial(workspaceId);
    expect(commitResult.success).toBe(true);
    const historyResult = await historyService.getHistoryFromLatestBoundary(workspaceId);
    expect(historyResult.success).toBe(true);
    if (!historyResult.success) {
      throw new Error(historyResult.error);
    }
    const committed = historyResult.data.find((message) => message.id === messageId);
    expect(committed?.parts).toEqual([]);
    expect(committed?.metadata?.error).toBeUndefined();
    expect(committed?.metadata?.errorType).toBeUndefined();
    expect(committed?.metadata?.finishReason).toBe("content-filter");
    expect(committed?.metadata?.usage).toBeUndefined();
  });

  test("zero-output refusal finishReason survives commit when usage is unavailable", async () => {
    const streamManager = new StreamManager(historyService);

    Reflect.set(streamManager, "tokenTracker", {
      setModel: () => Promise.resolve(undefined),
      countTokens: () => Promise.resolve(0),
    });

    const workspaceId = "refusal-no-usage-workspace";
    const messageId = "refusal-no-usage-message";
    const historySequence = 1;

    await appendPartialAssistantForTests(workspaceId, messageId, historySequence);
    const processStreamWithCleanup = getProcessStreamWithCleanupForTests(streamManager);
    const startTime = Date.now() - 250;
    const streamInfo = createStreamInfoForTests({
      streamResult: createStreamResultForTests(
        (async function* () {
          await Promise.resolve();
          yield { type: "finish", finishReason: "content-filter", rawFinishReason: "refusal" };
        })(),
        { inputTokens: 0, outputTokens: 0, totalTokens: 0 }
      ),
      messageId,
      startTime,
      lastPartTimestamp: startTime,
      model: KNOWN_MODELS.SONNET.id,
      metadataModel: KNOWN_MODELS.SONNET.id,
      historySequence,
      initialMetadata: { agentId: "plan" },
      runtime,
    });

    await processStreamWithCleanup.call(streamManager, workspaceId, streamInfo, historySequence);

    const partial = await historyService.readPartial(workspaceId);
    expect(partial?.metadata?.errorType).toBe("model_refusal");
    expect(partial?.metadata?.finishReason).toBe("content-filter");
    expect(partial?.metadata?.usage).toBeUndefined();

    const commitResult = await historyService.commitPartial(workspaceId);
    expect(commitResult.success).toBe(true);
    const historyResult = await historyService.getHistoryFromLatestBoundary(workspaceId);
    expect(historyResult.success).toBe(true);
    if (!historyResult.success) {
      throw new Error(historyResult.error);
    }
    const committed = historyResult.data.find((message) => message.id === messageId);
    expect(committed?.parts).toEqual([]);
    expect(committed?.metadata?.finishReason).toBe("content-filter");
    expect(committed?.metadata?.usage).toBeUndefined();
    expect(committed?.metadata?.error).toBeUndefined();
    expect(committed?.metadata?.errorType).toBeUndefined();
  });

  test("zero-usage terminal refusal reaches the sidecar as refused_stream without touching the session ledger", async () => {
    const recordUsage = mock((_workspaceId: string, _model: string, _usage: unknown) =>
      Promise.resolve(undefined)
    );
    const recordHeadlessUsage = mock(
      (
        _workspaceId: string,
        _model: string,
        _usage: unknown,
        _providerMetadata: unknown,
        _options: unknown
      ) => Promise.resolve(undefined)
    );
    const sessionUsageService = {
      recordUsage,
      recordHeadlessUsage,
    } as unknown as SessionUsageService;
    const streamManager = new StreamManager(historyService, sessionUsageService);

    Reflect.set(streamManager, "tokenTracker", {
      setModel: () => Promise.resolve(undefined),
      countTokens: () => Promise.resolve(0),
    });

    const workspaceId = "refusal-zero-usage-sidecar-workspace";
    const messageId = "refusal-zero-usage-sidecar-message";
    const historySequence = 1;

    await appendPartialAssistantForTests(workspaceId, messageId, historySequence);
    const processStreamWithCleanup = getProcessStreamWithCleanupForTests(streamManager);
    const startTime = Date.now() - 250;
    const streamInfo = createStreamInfoForTests({
      streamResult: createStreamResultForTests(
        (async function* () {
          await Promise.resolve();
          yield { type: "finish", finishReason: "content-filter", rawFinishReason: "refusal" };
        })(),
        { inputTokens: 0, outputTokens: 0, totalTokens: 0 }
      ),
      messageId,
      startTime,
      lastPartTimestamp: startTime,
      model: KNOWN_MODELS.SONNET.id,
      metadataModel: KNOWN_MODELS.SONNET.id,
      historySequence,
      initialMetadata: { agentId: "plan" },
      runtime,
    });

    await processStreamWithCleanup.call(streamManager, workspaceId, streamInfo, historySequence);

    // A refusal the provider billed nothing for is still a refusal: exactly
    // one refused_stream analytics record with explicit zero usage…
    expect(recordHeadlessUsage).toHaveBeenCalledTimes(1);
    expect(recordHeadlessUsage.mock.calls[0]?.[0]).toBe(workspaceId);
    expect(recordHeadlessUsage.mock.calls[0]?.[2]).toEqual({
      inputTokens: 0,
      outputTokens: 0,
      totalTokens: 0,
    });
    expect(recordHeadlessUsage.mock.calls[0]?.[4]).toMatchObject({
      analyticsSource: "refused_stream",
      skipSessionLedger: true,
    });
    // …and no zero-cost noise in the session cost ledger.
    expect(recordUsage).not.toHaveBeenCalled();
  });

  test("refusal finish after partial output fails visibly when no fallback is configured", async () => {
    const recordUsage = mock((_workspaceId: string, _model: string, _usage: unknown) =>
      Promise.resolve(undefined)
    );
    const recordHeadlessUsage = mock(
      (
        _workspaceId: string,
        _model: string,
        _usage: unknown,
        _providerMetadata: unknown,
        _options: unknown
      ) => Promise.resolve(undefined)
    );
    const sessionUsageService = {
      recordUsage,
      recordHeadlessUsage,
    } as unknown as SessionUsageService;
    const streamManager = new StreamManager(historyService, sessionUsageService);
    const errorEvents: Array<{ messageId: string; error: string; errorType?: string }> = [];
    const streamEndEvents: unknown[] = [];

    onTurnEngineEvent(streamManager, "error", (data) => {
      errorEvents.push(data as { messageId: string; error: string; errorType?: string });
    });
    onTurnEngineEvent(streamManager, "stream-end", (data) => {
      streamEndEvents.push(data);
    });

    Reflect.set(streamManager, "tokenTracker", {
      setModel: () => Promise.resolve(undefined),
      countTokens: () => Promise.resolve(0),
    });

    const workspaceId = "refusal-partial-workspace";
    const messageId = "refusal-partial-message";
    const historySequence = 1;

    await appendPartialAssistantForTests(workspaceId, messageId, historySequence);
    const processStreamWithCleanup = getProcessStreamWithCleanupForTests(streamManager);
    const startTime = Date.now() - 250;
    const streamInfo = createStreamInfoForTests({
      streamResult: createStreamResultForTests(
        (async function* () {
          await Promise.resolve();
          yield { type: "text-delta", text: "partial answer before refusing" };
          yield { type: "finish", finishReason: "content-filter", rawFinishReason: "refusal" };
        })(),
        { inputTokens: 3, outputTokens: 2, totalTokens: 5 }
      ),
      messageId,
      startTime,
      lastPartTimestamp: startTime,
      model: KNOWN_MODELS.SONNET.id,
      metadataModel: KNOWN_MODELS.SONNET.id,
      historySequence,
      initialMetadata: { agentId: "plan" },
      runtime,
    });

    await processStreamWithCleanup.call(streamManager, workspaceId, streamInfo, historySequence);

    expect(streamEndEvents).toHaveLength(0);
    expect(errorEvents).toHaveLength(1);
    expect(errorEvents[0]).toMatchObject({ messageId, errorType: "model_refusal" });

    const partial = await historyService.readPartial(workspaceId);
    expect(partial?.metadata?.errorType).toBe("model_refusal");
    expect(partial?.parts).toHaveLength(1);
    const preservedPart = partial?.parts[0];
    expect(preservedPart?.type).toBe("text");
    if (preservedPart?.type === "text") {
      expect(preservedPart.text).toBe("partial answer before refusing");
      expect(typeof preservedPart.timestamp).toBe("number");
    }
    expect(recordUsage).toHaveBeenCalledTimes(1);
    expect(recordUsage.mock.calls[0]?.[0]).toBe(workspaceId);
    expect(recordUsage.mock.calls[0]?.[1]).toBe(KNOWN_MODELS.SONNET.id);
    expect(partial?.metadata?.finishReason).toBe("content-filter");
    // Sidecar-canonical: the billed refusal usage routes to the headless
    // sidecar (asserted via recordHeadlessUsage below), never the partial.
    expect(partial?.metadata?.usage).toBeUndefined();
    expect(recordHeadlessUsage).toHaveBeenCalledTimes(1);
    expect(recordHeadlessUsage.mock.calls[0]?.[0]).toBe(workspaceId);
    expect(recordHeadlessUsage.mock.calls[0]?.[2]).toMatchObject({ inputTokens: 3 });
    // Terminal refusals are labeled refused_stream (not errored_stream) so
    // analytics can distinguish refusals from generic stream errors.
    expect(recordHeadlessUsage.mock.calls[0]?.[4]).toMatchObject({
      analyticsSource: "refused_stream",
      skipSessionLedger: true,
    });

    const commitResult = await historyService.commitPartial(workspaceId);
    expect(commitResult.success).toBe(true);
    const historyResult = await historyService.getHistoryFromLatestBoundary(workspaceId);
    expect(historyResult.success).toBe(true);
    if (!historyResult.success) {
      throw new Error(historyResult.error);
    }
    const committed = historyResult.data.find((message) => message.id === messageId);
    expect(committed?.metadata?.error).toBeUndefined();
    expect(committed?.metadata?.errorType).toBeUndefined();
    expect(committed?.metadata?.finishReason).toBe("content-filter");
    expect(committed?.metadata?.usage).toBeUndefined();
  });

  test("zero-output refusal with a configured fallback chain swaps models without any error event", async () => {
    const streamManager = new StreamManager(historyService);
    const errorEvents: unknown[] = [];
    const streamEndEvents: Array<{
      metadata?: {
        model?: string;
        modelFallback?: { requestedModel: string; refusedModels: string[] };
        toolModelUsages?: Array<{
          toolName: string;
          model: string;
          usage?: { inputTokens?: number };
        }>;
      };
    }> = [];

    onTurnEngineEvent(streamManager, "error", (data) => errorEvents.push(data));
    onTurnEngineEvent(streamManager, "stream-end", (data) => {
      streamEndEvents.push(data as (typeof streamEndEvents)[number]);
    });

    Reflect.set(streamManager, "tokenTracker", {
      setModel: () => Promise.resolve(undefined),
      countTokens: () => Promise.resolve(0),
    });

    const workspaceId = "fallback-swap-workspace";
    const messageId = "fallback-swap-message";
    const historySequence = 1;
    const fallbackModel = KNOWN_MODELS.GPT.id;

    await appendPartialAssistantForTests(workspaceId, messageId, historySequence);
    const processStreamWithCleanup = getProcessStreamWithCleanupForTests(streamManager);

    // The swapped-in stream: the fallback model answers normally.
    const createStreamResult = mock(() =>
      createStreamResultForTests(
        (async function* () {
          await Promise.resolve();
          yield { type: "text-delta", text: "fallback answer" };
          yield { type: "finish", finishReason: "stop" };
        })(),
        { inputTokens: 5, outputTokens: 3, totalTokens: 8 }
      )
    );
    expect(Reflect.set(streamManager, "createStreamResult", createStreamResult)).toBe(true);

    // Cleanup spies prove neither model's transport resources leak: the refused
    // model is released at swap time, the fallback model at stream exit.
    const refusedModelCleanup = mock(() => undefined);
    const fallbackModelCleanup = mock(() => undefined);
    const fallbackLanguageModel = createTestLanguageModel("fallback-model");
    attachLanguageModelCleanup(fallbackLanguageModel, fallbackModelCleanup);

    // Marker toolset proving the swapped request uses the tools rebuilt for the
    // fallback model (provider-specific web tools / MCP sanitization), not the
    // refused model's toolset.
    const fallbackTools = { fallback_only_tool: { description: "rebuilt for fallback" } };
    const prepare = mock((nextModelString: string, _options?: ModelFallbackPrepareOptions) =>
      Promise.resolve(
        Ok({
          model: fallbackLanguageModel,
          modelString: nextModelString,
          messages: [],
          system: "fallback system",
          tools: fallbackTools,
          thinkingLevel: "off",
        })
      )
    );

    const refusedLanguageModel = createTestLanguageModel("refused-model");
    attachLanguageModelCleanup(refusedLanguageModel, refusedModelCleanup);

    const startTime = Date.now() - 250;
    const streamInfo = createStreamInfoForTests({
      streamResult: createStreamResultForTests(
        (async function* () {
          await Promise.resolve();
          // finish-step carries the refused attempt's usage (mirrors the SDK,
          // which emits per-step usage even for zero-output refusals).
          yield {
            type: "finish-step",
            usage: { inputTokens: 30000, outputTokens: 0, totalTokens: 30000 },
          };
          yield { type: "finish", finishReason: "content-filter", rawFinishReason: "refusal" };
        })(),
        { inputTokens: 30000, outputTokens: 0, totalTokens: 30000 }
      ),
      messageId,
      startTime,
      lastPartTimestamp: startTime,
      model: KNOWN_MODELS.SONNET.id,
      metadataModel: KNOWN_MODELS.SONNET.id,
      historySequence,
      initialMetadata: { agentId: "plan" },
      runtime,
      request: { model: refusedLanguageModel, messages: [], providerOptions: undefined },
      modelFallback: {
        options: { chain: [fallbackModel], prepare },
        requestedModel: KNOWN_MODELS.SONNET.id,
        refusedModels: [],
        original: { maxOutputTokens: undefined },
      },
    });

    await processStreamWithCleanup.call(streamManager, workspaceId, streamInfo, historySequence);

    // No terminal failure: TaskService and waiters never observe the refusal.
    expect(errorEvents).toHaveLength(0);
    expect(prepare).toHaveBeenCalledTimes(1);
    expect(prepare.mock.calls[0]?.[0]).toBe(fallbackModel);
    expect(prepare.mock.calls[0]?.[1]).toBeUndefined();
    expect(createStreamResult).toHaveBeenCalledTimes(1);

    expect(streamEndEvents).toHaveLength(1);
    const metadata = streamEndEvents[0]?.metadata;
    expect(metadata?.model).toBe(fallbackModel);
    expect(metadata?.modelFallback).toEqual({
      requestedModel: KNOWN_MODELS.SONNET.id,
      refusedModels: [KNOWN_MODELS.SONNET.id],
    });
    // Pin the IPC passthrough: the oRPC schema strips unknown metadata keys, so
    // modelFallback must survive StreamEndEventSchema or the live transcript
    // never learns about the swap.
    const ipcEvent = StreamEndEventSchema.parse(streamEndEvents[0]);
    expect(ipcEvent.metadata.historySequence).toBe(historySequence);
    expect(ipcEvent.metadata.modelFallback).toEqual({
      requestedModel: KNOWN_MODELS.SONNET.id,
      refusedModels: [KNOWN_MODELS.SONNET.id],
    });
    // The refused attempt's usage is attributed to the refusing model, not the
    // fallback model that ultimately answered.
    expect(metadata?.toolModelUsages?.[0]).toMatchObject({
      toolName: "model_fallback_refusal",
      model: KNOWN_MODELS.SONNET.id,
      usage: { inputTokens: 30000 },
    });
    // Both models' transport resources were released exactly once: the refused
    // model at swap time (the stream-exit finally only sees the final request),
    // the fallback model at stream exit.
    expect(refusedModelCleanup).toHaveBeenCalledTimes(1);
    expect(fallbackModelCleanup).toHaveBeenCalledTimes(1);
    // The swapped request was built from the prepared per-model pieces (tools
    // may be re-wrapped for caching, so assert contents rather than identity).
    const swappedRequest = streamInfo.request as {
      tools?: Record<string, unknown>;
      system?: unknown;
    };
    expect(Object.keys(swappedRequest.tools ?? {})).toEqual(Object.keys(fallbackTools));
    expect(swappedRequest.system).toBe("fallback system");
  });

  test("partial refusal with a configured fallback continues from cloned partial output", async () => {
    const streamManager = new StreamManager(historyService);
    const errorEvents: unknown[] = [];
    const streamEndEvents: Array<{
      metadata?: {
        model?: string;
        modelFallback?: { requestedModel: string; refusedModels: string[] };
        toolModelUsages?: Array<{
          toolName: string;
          model: string;
          usage?: { inputTokens?: number; outputTokens?: number };
        }>;
      };
      parts?: Array<{ type: string; text?: string; toolName?: string }>;
    }> = [];

    onTurnEngineEvent(streamManager, "error", (data) => errorEvents.push(data));
    onTurnEngineEvent(streamManager, "stream-end", (data) => {
      streamEndEvents.push(data as (typeof streamEndEvents)[number]);
    });

    Reflect.set(streamManager, "tokenTracker", {
      setModel: () => Promise.resolve(undefined),
      countTokens: () => Promise.resolve(0),
    });

    const workspaceId = "fallback-partial-workspace";
    const messageId = "fallback-partial-message";
    const historySequence = 1;
    const fallbackModel = KNOWN_MODELS.GPT.id;

    await appendPartialAssistantForTests(workspaceId, messageId, historySequence);
    const processStreamWithCleanup = getProcessStreamWithCleanupForTests(streamManager);

    const createStreamResult = mock(() =>
      createStreamResultForTests(
        (async function* () {
          await Promise.resolve();
          yield { type: "text-delta", text: "fallback continuation" };
          yield { type: "finish", finishReason: "stop" };
        })(),
        { inputTokens: 7, outputTokens: 4, totalTokens: 11 }
      )
    );
    expect(Reflect.set(streamManager, "createStreamResult", createStreamResult)).toBe(true);

    const prepareCalls: Array<{
      nextModelString: string;
      options?: ModelFallbackPrepareOptions;
    }> = [];
    const fallbackLanguageModel = createTestLanguageModel("fallback-partial-model");
    const prepare = mock((nextModelString: string, options?: ModelFallbackPrepareOptions) => {
      prepareCalls.push({ nextModelString, options });
      return Promise.resolve(
        Ok({
          model: fallbackLanguageModel,
          modelString: nextModelString,
          messages: [],
          system: "fallback system",
          tools: {},
          thinkingLevel: "off",
        })
      );
    });

    const startTime = Date.now() - 250;
    const streamInfo = createStreamInfoForTests({
      streamResult: createStreamResultForTests(
        (async function* () {
          await Promise.resolve();
          yield { type: "text-delta", text: "partial answer" };
          yield {
            type: "tool-call",
            toolCallId: "tool-call-1",
            toolName: "bash",
            input: { script: "printf ok" },
          };
          yield {
            type: "tool-result",
            toolCallId: "tool-call-1",
            toolName: "bash",
            output: { success: true, output: "ok" },
          };
          yield {
            type: "finish-step",
            usage: { inputTokens: 12, outputTokens: 5, totalTokens: 17 },
          };
          yield { type: "finish", finishReason: "content-filter", rawFinishReason: "refusal" };
        })(),
        { inputTokens: 12, outputTokens: 5, totalTokens: 17 }
      ),
      messageId,
      startTime,
      lastPartTimestamp: startTime,
      model: KNOWN_MODELS.SONNET.id,
      metadataModel: KNOWN_MODELS.SONNET.id,
      historySequence,
      initialMetadata: { agentId: "plan" },
      runtime,
      stepTracker: {
        latestMessages: [{ role: "user", content: "stale source-step transcript" }],
      },
      modelFallback: {
        options: { chain: [fallbackModel], prepare },
        requestedModel: KNOWN_MODELS.SONNET.id,
        refusedModels: [],
        original: { maxOutputTokens: undefined },
      },
    });

    await processStreamWithCleanup.call(streamManager, workspaceId, streamInfo, historySequence);

    expect(errorEvents).toHaveLength(0);
    expect((streamInfo.stepTracker as { latestMessages?: unknown }).latestMessages).toBeUndefined();
    expect(prepareCalls).toHaveLength(1);
    expect(prepareCalls[0]?.nextModelString).toBe(fallbackModel);

    const continuationMessage = prepareCalls[0]?.options?.continuation?.assistantMessage;
    expect(continuationMessage?.metadata?.partial).toBe(true);
    expect(continuationMessage?.metadata?.finishReason).toBe("content-filter");
    expect(continuationMessage?.parts.map((part) => part.type)).toEqual(["text", "dynamic-tool"]);
    expect(continuationMessage?.parts).not.toBe(streamInfo.parts);

    expect(streamEndEvents).toHaveLength(1);
    const streamEnd = streamEndEvents[0];
    expect(streamEnd?.metadata?.model).toBe(fallbackModel);
    expect(streamEnd?.metadata?.modelFallback).toEqual({
      requestedModel: KNOWN_MODELS.SONNET.id,
      refusedModels: [KNOWN_MODELS.SONNET.id],
    });
    expect(streamEnd?.metadata?.toolModelUsages?.[0]).toMatchObject({
      toolName: "model_fallback_refusal",
      model: KNOWN_MODELS.SONNET.id,
      usage: { inputTokens: 12, outputTokens: 5 },
    });
    expect(
      streamEnd?.parts?.map((part) => (part.type === "text" ? part.text : part.toolName))
    ).toEqual(["partial answer", "bash", "fallback continuation"]);
  });

  test("partial refusal backfills refused-hop reasoning usage before fallback swap", async () => {
    const streamManager = new StreamManager(historyService);
    const errorEvents: unknown[] = [];
    const streamEndEvents: Array<{
      metadata?: {
        usage?: { reasoningTokens?: number };
        toolModelUsages?: Array<{
          model: string;
          usage?: { reasoningTokens?: number };
        }>;
      };
    }> = [];

    onTurnEngineEvent(streamManager, "error", (data) => errorEvents.push(data));
    onTurnEngineEvent(streamManager, "stream-end", (data) => {
      streamEndEvents.push(data as (typeof streamEndEvents)[number]);
    });

    Reflect.set(streamManager, "tokenTracker", {
      setModel: () => Promise.resolve(undefined),
      countTokens: () => Promise.resolve(0),
    });

    const workspaceId = "fallback-reasoning-refusal-workspace";
    const messageId = "fallback-reasoning-refusal-message";
    const historySequence = 1;
    const fallbackModel = KNOWN_MODELS.GPT.id;
    const refusedReasoning = "Reasoning before refusal";
    const expectedReasoningTokens = await countTokens(KNOWN_MODELS.SONNET.id, refusedReasoning);

    await appendPartialAssistantForTests(workspaceId, messageId, historySequence);
    const processStreamWithCleanup = getProcessStreamWithCleanupForTests(streamManager);

    const createStreamResult = mock(() =>
      createStreamResultForTests(
        (async function* () {
          await Promise.resolve();
          yield { type: "text-delta", text: "fallback answer" };
          yield { type: "finish", finishReason: "stop" };
        })(),
        { inputTokens: 7, outputTokens: 4, totalTokens: 11 }
      )
    );
    expect(Reflect.set(streamManager, "createStreamResult", createStreamResult)).toBe(true);

    const prepare = mock((nextModelString: string, _options?: ModelFallbackPrepareOptions) =>
      Promise.resolve(
        Ok({
          model: createTestLanguageModel("fallback-reasoning-refusal-model"),
          modelString: nextModelString,
          messages: [],
          system: "fallback system",
          tools: {},
          thinkingLevel: "off",
        })
      )
    );

    const startTime = Date.now() - 250;
    const streamInfo = createStreamInfoForTests({
      streamResult: createStreamResultForTests(
        (async function* () {
          await Promise.resolve();
          yield { type: "reasoning-delta", text: refusedReasoning };
          yield { type: "text-delta", text: "partial answer" };
          yield {
            type: "finish-step",
            usage: { inputTokens: 12, outputTokens: 5, totalTokens: 17 },
          };
          yield { type: "finish", finishReason: "content-filter", rawFinishReason: "refusal" };
        })(),
        { inputTokens: 12, outputTokens: 5, totalTokens: 17 }
      ),
      messageId,
      startTime,
      lastPartTimestamp: startTime,
      model: KNOWN_MODELS.SONNET.id,
      metadataModel: KNOWN_MODELS.SONNET.id,
      historySequence,
      initialMetadata: { agentId: "plan" },
      runtime,
      modelFallback: {
        options: { chain: [fallbackModel], prepare },
        requestedModel: KNOWN_MODELS.SONNET.id,
        refusedModels: [],
        original: { maxOutputTokens: undefined },
      },
    });

    await processStreamWithCleanup.call(streamManager, workspaceId, streamInfo, historySequence);

    expect(errorEvents).toHaveLength(0);
    expect(streamEndEvents).toHaveLength(1);
    const metadata = streamEndEvents[0]?.metadata;
    expect(metadata?.toolModelUsages?.[0]).toMatchObject({
      model: KNOWN_MODELS.SONNET.id,
      usage: { reasoningTokens: expectedReasoningTokens },
    });
    expect(metadata?.usage?.reasoningTokens).toBeUndefined();
  });

  test("partial refusal skips fallback when a tool call is still incomplete", async () => {
    const streamManager = new StreamManager(historyService);
    const errorEvents: Array<{ messageId: string; error: string; errorType?: string }> = [];
    const streamEndEvents: unknown[] = [];

    onTurnEngineEvent(streamManager, "error", (data) => {
      errorEvents.push(data as { messageId: string; error: string; errorType?: string });
    });
    onTurnEngineEvent(streamManager, "stream-end", (data) => streamEndEvents.push(data));

    Reflect.set(streamManager, "tokenTracker", {
      setModel: () => Promise.resolve(undefined),
      countTokens: () => Promise.resolve(0),
    });

    const workspaceId = "fallback-incomplete-tool-workspace";
    const messageId = "fallback-incomplete-tool-message";
    const historySequence = 1;
    const fallbackModel = KNOWN_MODELS.GPT.id;
    const prepare = mock((_nextModelString: string) =>
      Promise.resolve(
        Ok({
          model: createTestLanguageModel("fallback-incomplete-tool"),
          modelString: fallbackModel,
          messages: [],
          system: "fallback system",
          tools: {},
        })
      )
    );

    await appendPartialAssistantForTests(workspaceId, messageId, historySequence);
    const processStreamWithCleanup = getProcessStreamWithCleanupForTests(streamManager);
    const startTime = Date.now() - 250;
    const streamInfo = createStreamInfoForTests({
      streamResult: createStreamResultForTests(
        (async function* () {
          await Promise.resolve();
          yield {
            type: "tool-call",
            toolCallId: "tool-call-1",
            toolName: "bash",
            input: { script: "printf ok" },
          };
          yield { type: "finish", finishReason: "content-filter", rawFinishReason: "refusal" };
        })(),
        { inputTokens: 12, outputTokens: 1, totalTokens: 13 }
      ),
      messageId,
      startTime,
      lastPartTimestamp: startTime,
      model: KNOWN_MODELS.SONNET.id,
      metadataModel: KNOWN_MODELS.SONNET.id,
      historySequence,
      initialMetadata: { agentId: "plan" },
      runtime,
      modelFallback: {
        options: { chain: [fallbackModel], prepare },
        requestedModel: KNOWN_MODELS.SONNET.id,
        refusedModels: [],
        original: { maxOutputTokens: undefined },
      },
    });

    await processStreamWithCleanup.call(streamManager, workspaceId, streamInfo, historySequence);

    expect(prepare).not.toHaveBeenCalled();
    expect(streamEndEvents).toHaveLength(0);
    expect(errorEvents).toHaveLength(1);
    expect(errorEvents[0]).toMatchObject({ messageId, errorType: "model_refusal" });
    expect(errorEvents[0]?.error).toContain("incomplete tool call");
  });

  test("multi-hop fallback chain walks entries in order and attributes usage per refusing model", async () => {
    const streamManager = new StreamManager(historyService);
    const errorEvents: unknown[] = [];
    const streamEndEvents: Array<{
      metadata?: {
        model?: string;
        usage?: { inputTokens?: number; outputTokens?: number };
        modelFallback?: { requestedModel: string; refusedModels: string[] };
        toolModelUsages?: Array<{
          toolName: string;
          model: string;
          usage?: { inputTokens?: number };
        }>;
      };
    }> = [];

    onTurnEngineEvent(streamManager, "error", (data) => errorEvents.push(data));
    onTurnEngineEvent(streamManager, "stream-end", (data) => {
      streamEndEvents.push(data as (typeof streamEndEvents)[number]);
    });

    Reflect.set(streamManager, "tokenTracker", {
      setModel: () => Promise.resolve(undefined),
      countTokens: () => Promise.resolve(0),
    });

    const workspaceId = "fallback-multihop-workspace";
    const messageId = "fallback-multihop-message";
    const historySequence = 1;
    const firstFallbackModel = KNOWN_MODELS.GPT.id;
    const secondFallbackModel = KNOWN_MODELS.GEMINI_FLASH.id;

    await appendPartialAssistantForTests(workspaceId, messageId, historySequence);
    const processStreamWithCleanup = getProcessStreamWithCleanupForTests(streamManager);

    // First swapped-in stream refuses too; the second answers.
    const createStreamResult = mock()
      .mockImplementationOnce(() =>
        createStreamResultForTests(
          (async function* () {
            await Promise.resolve();
            yield {
              type: "finish-step",
              usage: { inputTokens: 2000, outputTokens: 0, totalTokens: 2000 },
            };
            yield { type: "finish", finishReason: "content-filter", rawFinishReason: "refusal" };
          })(),
          { inputTokens: 2000, outputTokens: 0, totalTokens: 2000 }
        )
      )
      .mockImplementationOnce(() =>
        createStreamResultForTests(
          (async function* () {
            await Promise.resolve();
            yield { type: "text-delta", text: "second fallback answer" };
            yield { type: "finish", finishReason: "stop" };
          })(),
          { inputTokens: 5, outputTokens: 3, totalTokens: 8 }
        )
      );
    expect(Reflect.set(streamManager, "createStreamResult", createStreamResult)).toBe(true);

    const prepare = mock((nextModelString: string, _options?: ModelFallbackPrepareOptions) =>
      Promise.resolve(
        Ok({
          model: createTestLanguageModel(`fallback-${nextModelString}`),
          modelString: nextModelString,
          messages: [],
          system: "fallback system",
          tools: undefined,
        })
      )
    );

    const startTime = Date.now() - 250;
    const streamInfo = createStreamInfoForTests({
      streamResult: createStreamResultForTests(
        (async function* () {
          await Promise.resolve();
          yield {
            type: "finish-step",
            usage: { inputTokens: 30000, outputTokens: 0, totalTokens: 30000 },
          };
          yield { type: "finish", finishReason: "content-filter", rawFinishReason: "refusal" };
        })(),
        { inputTokens: 30000, outputTokens: 0, totalTokens: 30000 }
      ),
      messageId,
      startTime,
      lastPartTimestamp: startTime,
      model: KNOWN_MODELS.SONNET.id,
      metadataModel: KNOWN_MODELS.SONNET.id,
      historySequence,
      initialMetadata: { agentId: "plan" },
      runtime,
      modelFallback: {
        options: { chain: [firstFallbackModel, secondFallbackModel], prepare },
        requestedModel: KNOWN_MODELS.SONNET.id,
        refusedModels: [],
        original: { maxOutputTokens: undefined },
      },
    });

    await processStreamWithCleanup.call(streamManager, workspaceId, streamInfo, historySequence);

    expect(errorEvents).toHaveLength(0);
    // Chain entries are attempted in configured order, one attempt each.
    expect(prepare.mock.calls.map((call) => call[0])).toEqual([
      firstFallbackModel,
      secondFallbackModel,
    ]);
    expect(prepare.mock.calls.map((call) => call[1])).toEqual([undefined, undefined]);
    expect(createStreamResult).toHaveBeenCalledTimes(2);

    expect(streamEndEvents).toHaveLength(1);
    const metadata = streamEndEvents[0]?.metadata;
    expect(metadata?.model).toBe(secondFallbackModel);
    // refusedModels accumulates every refusing hop, in order.
    expect(metadata?.modelFallback).toEqual({
      requestedModel: KNOWN_MODELS.SONNET.id,
      refusedModels: [KNOWN_MODELS.SONNET.id, firstFallbackModel],
    });
    // One usage row per refusing hop, attributed to the model that refused.
    expect(metadata?.toolModelUsages).toHaveLength(2);
    expect(metadata?.toolModelUsages?.[0]).toMatchObject({
      toolName: "model_fallback_refusal",
      model: KNOWN_MODELS.SONNET.id,
      usage: { inputTokens: 30000 },
    });
    expect(metadata?.toolModelUsages?.[1]).toMatchObject({
      toolName: "model_fallback_refusal",
      model: firstFallbackModel,
      usage: { inputTokens: 2000 },
    });
    // Final turn usage reflects only the answering attempt (refused attempts
    // live in their toolModelUsages rows, not the headline usage).
    expect(metadata?.usage).toMatchObject({ inputTokens: 5, outputTokens: 3 });
  });

  test("multi-hop fallback continues preserved partial output when a later hop refuses", async () => {
    const streamManager = new StreamManager(historyService);
    const errorEvents: unknown[] = [];
    const streamEndEvents: Array<{
      metadata?: {
        model?: string;
        usage?: { inputTokens?: number; outputTokens?: number };
        modelFallback?: { requestedModel: string; refusedModels: string[] };
        toolModelUsages?: Array<{
          toolName: string;
          model: string;
          usage?: { inputTokens?: number; outputTokens?: number };
        }>;
      };
      parts?: Array<{ type: string; text?: string; toolName?: string }>;
    }> = [];

    onTurnEngineEvent(streamManager, "error", (data) => errorEvents.push(data));
    onTurnEngineEvent(streamManager, "stream-end", (data) => {
      streamEndEvents.push(data as (typeof streamEndEvents)[number]);
    });

    Reflect.set(streamManager, "tokenTracker", {
      setModel: () => Promise.resolve(undefined),
      countTokens: () => Promise.resolve(0),
    });

    const workspaceId = "fallback-multihop-partial-workspace";
    const messageId = "fallback-multihop-partial-message";
    const historySequence = 1;
    const firstFallbackModel = KNOWN_MODELS.GPT.id;
    const secondFallbackModel = KNOWN_MODELS.GEMINI_FLASH.id;

    await appendPartialAssistantForTests(workspaceId, messageId, historySequence);
    const processStreamWithCleanup = getProcessStreamWithCleanupForTests(streamManager);

    const createStreamResult = mock()
      .mockImplementationOnce(() =>
        createStreamResultForTests(
          (async function* () {
            await Promise.resolve();
            yield {
              type: "finish-step",
              usage: { inputTokens: 20, outputTokens: 0, totalTokens: 20 },
            };
            yield { type: "finish", finishReason: "content-filter", rawFinishReason: "refusal" };
          })(),
          { inputTokens: 20, outputTokens: 0, totalTokens: 20 }
        )
      )
      .mockImplementationOnce(() =>
        createStreamResultForTests(
          (async function* () {
            await Promise.resolve();
            yield { type: "text-delta", text: "second fallback answer" };
            yield { type: "finish", finishReason: "stop" };
          })(),
          { inputTokens: 5, outputTokens: 3, totalTokens: 8 }
        )
      );
    expect(Reflect.set(streamManager, "createStreamResult", createStreamResult)).toBe(true);

    const prepareCalls: Array<{
      nextModelString: string;
      options?: ModelFallbackPrepareOptions;
    }> = [];
    const prepare = mock((nextModelString: string, options?: ModelFallbackPrepareOptions) => {
      prepareCalls.push({ nextModelString, options });
      return Promise.resolve(
        Ok({
          model: createTestLanguageModel(`fallback-${nextModelString}`),
          modelString: nextModelString,
          messages: [],
          system: "fallback system",
          tools: {},
        })
      );
    });

    const startTime = Date.now() - 250;
    const streamInfo = createStreamInfoForTests({
      streamResult: createStreamResultForTests(
        (async function* () {
          await Promise.resolve();
          yield { type: "text-delta", text: "partial answer" };
          yield {
            type: "tool-call",
            toolCallId: "tool-call-1",
            toolName: "bash",
            input: { script: "printf ok" },
          };
          yield {
            type: "tool-result",
            toolCallId: "tool-call-1",
            toolName: "bash",
            output: { success: true, output: "ok" },
          };
          yield {
            type: "finish-step",
            usage: { inputTokens: 12, outputTokens: 5, totalTokens: 17 },
          };
          yield { type: "finish", finishReason: "content-filter", rawFinishReason: "refusal" };
        })(),
        { inputTokens: 12, outputTokens: 5, totalTokens: 17 }
      ),
      messageId,
      startTime,
      lastPartTimestamp: startTime,
      model: KNOWN_MODELS.SONNET.id,
      metadataModel: KNOWN_MODELS.SONNET.id,
      historySequence,
      initialMetadata: { agentId: "plan" },
      runtime,
      modelFallback: {
        options: { chain: [firstFallbackModel, secondFallbackModel], prepare },
        requestedModel: KNOWN_MODELS.SONNET.id,
        refusedModels: [],
        original: { maxOutputTokens: undefined },
      },
    });

    await processStreamWithCleanup.call(streamManager, workspaceId, streamInfo, historySequence);

    expect(errorEvents).toHaveLength(0);
    expect(prepareCalls.map((call) => call.nextModelString)).toEqual([
      firstFallbackModel,
      secondFallbackModel,
    ]);
    const firstContinuation = prepareCalls[0]?.options?.continuation?.assistantMessage;
    const secondContinuation = prepareCalls[1]?.options?.continuation?.assistantMessage;
    expect(firstContinuation?.metadata?.model).toBe(KNOWN_MODELS.SONNET.id);
    expect(secondContinuation?.metadata?.model).toBe(firstFallbackModel);
    expect(firstContinuation?.parts.map((part) => part.type)).toEqual(["text", "dynamic-tool"]);
    expect(secondContinuation?.parts.map((part) => part.type)).toEqual(["text", "dynamic-tool"]);

    expect(streamEndEvents).toHaveLength(1);
    const streamEnd = streamEndEvents[0];
    expect(streamEnd?.metadata?.model).toBe(secondFallbackModel);
    expect(streamEnd?.metadata?.modelFallback).toEqual({
      requestedModel: KNOWN_MODELS.SONNET.id,
      refusedModels: [KNOWN_MODELS.SONNET.id, firstFallbackModel],
    });
    expect(streamEnd?.metadata?.toolModelUsages).toHaveLength(2);
    expect(streamEnd?.metadata?.toolModelUsages?.[0]).toMatchObject({
      toolName: "model_fallback_refusal",
      model: KNOWN_MODELS.SONNET.id,
      usage: { inputTokens: 12, outputTokens: 5 },
    });
    expect(streamEnd?.metadata?.toolModelUsages?.[1]).toMatchObject({
      toolName: "model_fallback_refusal",
      model: firstFallbackModel,
      usage: { inputTokens: 20, outputTokens: 0 },
    });
    expect(streamEnd?.metadata?.usage).toMatchObject({ inputTokens: 5, outputTokens: 3 });
    expect(
      streamEnd?.parts?.map((part) => (part.type === "text" ? part.text : part.toolName))
    ).toEqual(["partial answer", "bash", "second fallback answer"]);
    const history = await historyService.getHistoryFromLatestBoundary(workspaceId);
    expect(history.success).toBe(true);
    if (!history.success) throw new Error(history.error);
    expect(
      history.data.find((row) => row.id === messageId)?.metadata?.stepStartPartIndices
    ).toEqual([0, 2]);
  });

  test("refusal fallback chain exhaustion fails terminally as model_refusal", async () => {
    const recordHeadlessUsage = mock(
      (
        _workspaceId: string,
        _model: string,
        _usage: unknown,
        _providerMetadata: unknown,
        _options: unknown
      ) => Promise.resolve(undefined)
    );
    const sessionUsageService = {
      recordUsage: mock(() => Promise.resolve(undefined)),
      recordHeadlessUsage,
    } as unknown as SessionUsageService;
    const streamManager = new StreamManager(historyService, sessionUsageService);
    const errorEvents: Array<{ messageId: string; error: string; errorType?: string }> = [];
    const streamEndEvents: unknown[] = [];

    onTurnEngineEvent(streamManager, "error", (data) => {
      errorEvents.push(data as { messageId: string; error: string; errorType?: string });
    });
    onTurnEngineEvent(streamManager, "stream-end", (data) => streamEndEvents.push(data));

    Reflect.set(streamManager, "tokenTracker", {
      setModel: () => Promise.resolve(undefined),
      countTokens: () => Promise.resolve(0),
    });

    const workspaceId = "fallback-exhausted-workspace";
    const messageId = "fallback-exhausted-message";
    const historySequence = 1;
    const fallbackModel = KNOWN_MODELS.GPT.id;

    await appendPartialAssistantForTests(workspaceId, messageId, historySequence);
    const processStreamWithCleanup = getProcessStreamWithCleanupForTests(streamManager);

    // The fallback model refuses too — the chain is then exhausted.
    const createStreamResult = mock(() =>
      createStreamResultForTests(
        (async function* () {
          await Promise.resolve();
          yield {
            type: "finish-step",
            usage: { inputTokens: 10, outputTokens: 0, totalTokens: 10 },
          };
          yield { type: "finish", finishReason: "content-filter", rawFinishReason: "refusal" };
        })(),
        { inputTokens: 10, outputTokens: 0, totalTokens: 10 }
      )
    );
    expect(Reflect.set(streamManager, "createStreamResult", createStreamResult)).toBe(true);

    const prepare = mock((nextModelString: string) =>
      Promise.resolve(
        Ok({
          model: createTestLanguageModel("fallback-model"),
          modelString: nextModelString,
          messages: [],
          system: "fallback system",
          tools: undefined,
        })
      )
    );

    const startTime = Date.now() - 250;
    const streamInfo = createStreamInfoForTests({
      streamResult: createStreamResultForTests(
        (async function* () {
          await Promise.resolve();
          yield {
            type: "finish-step",
            usage: { inputTokens: 30000, outputTokens: 0, totalTokens: 30000 },
          };
          yield { type: "finish", finishReason: "content-filter", rawFinishReason: "refusal" };
        })(),
        { inputTokens: 30000, outputTokens: 0, totalTokens: 30000 }
      ),
      messageId,
      startTime,
      lastPartTimestamp: startTime,
      model: KNOWN_MODELS.SONNET.id,
      metadataModel: KNOWN_MODELS.SONNET.id,
      historySequence,
      initialMetadata: { agentId: "plan" },
      runtime,
      modelFallback: {
        options: { chain: [fallbackModel], prepare },
        requestedModel: KNOWN_MODELS.SONNET.id,
        refusedModels: [],
        original: { maxOutputTokens: undefined },
      },
    });

    await processStreamWithCleanup.call(streamManager, workspaceId, streamInfo, historySequence);

    expect(prepare).toHaveBeenCalledTimes(1);
    expect(createStreamResult).toHaveBeenCalledTimes(1);
    expect(streamEndEvents).toHaveLength(0);
    expect(errorEvents).toHaveLength(1);
    expect(errorEvents[0]).toMatchObject({ messageId, errorType: "model_refusal" });
    // The terminal error names the last refusing model and lists the chain.
    expect(errorEvents[0]?.error).toContain(`: ${fallbackModel}.`);
    expect(errorEvents[0]?.error).toContain(
      `Model fallback chain exhausted; refused models: ${KNOWN_MODELS.SONNET.id}, ${fallbackModel}.`
    );

    // Even though the turn failed terminally, every refused hop's usage —
    // including the FINAL refusing model's — is attributed and persisted.
    // Sidecar-canonical: errored turns route usage through the headless
    // sidecar (never the partial), so chains ending in failure don't
    // underreport costs and the eventual commit can't double-count.
    const partial = await historyService.readPartial(workspaceId);
    expect(partial?.metadata?.errorType).toBe("model_refusal");
    expect(partial?.metadata?.toolModelUsages).toBeUndefined();
    expect(partial?.metadata?.usage).toBeUndefined();
    const sidecarCalls = recordHeadlessUsage.mock.calls;
    expect(sidecarCalls).toHaveLength(2);
    expect(sidecarCalls[0]?.[1]).toBe(KNOWN_MODELS.SONNET.id);
    expect(sidecarCalls[0]?.[2]).toMatchObject({ inputTokens: 30000 });
    expect(sidecarCalls[1]?.[1]).toBe(fallbackModel);
    expect(sidecarCalls[1]?.[2]).toMatchObject({ inputTokens: 10 });
    for (const call of sidecarCalls) {
      // Both flattened entries are refused fallback hops, so they carry the
      // refusal-specific analytics label rather than the generic drop reason.
      expect(call?.[4]).toMatchObject({
        analyticsSource: "refused_stream",
        skipSessionLedger: true,
      });
    }
  });

  test("unstartable fallback model fails terminally as model_refusal instead of skipping ahead", async () => {
    const streamManager = new StreamManager(historyService);
    const errorEvents: Array<{ messageId: string; error: string; errorType?: string }> = [];

    onTurnEngineEvent(streamManager, "error", (data) => {
      errorEvents.push(data as { messageId: string; error: string; errorType?: string });
    });

    Reflect.set(streamManager, "tokenTracker", {
      setModel: () => Promise.resolve(undefined),
      countTokens: () => Promise.resolve(0),
    });

    const workspaceId = "fallback-prepare-failure-workspace";
    const messageId = "fallback-prepare-failure-message";
    const historySequence = 1;
    const fallbackModel = KNOWN_MODELS.GPT.id;

    await appendPartialAssistantForTests(workspaceId, messageId, historySequence);
    const processStreamWithCleanup = getProcessStreamWithCleanupForTests(streamManager);

    const createStreamResult = mock(() =>
      createStreamResultForTests(
        (async function* () {
          // Must never be called: prepare failure aborts the chain.
        })()
      )
    );
    expect(Reflect.set(streamManager, "createStreamResult", createStreamResult)).toBe(true);

    // Silently skipping to the next chain entry would effectively create
    // fallback-on-auth/config errors, which is out of scope by design.
    const prepare = mock((_nextModelString: string) =>
      Promise.resolve(
        Err("API key not configured for OpenAI. Please add your API key in settings.")
      )
    );

    const startTime = Date.now() - 250;
    const streamInfo = createStreamInfoForTests({
      streamResult: createStreamResultForTests(
        (async function* () {
          await Promise.resolve();
          yield { type: "finish", finishReason: "content-filter", rawFinishReason: "refusal" };
        })(),
        { inputTokens: 30000, outputTokens: 0, totalTokens: 30000 }
      ),
      messageId,
      startTime,
      lastPartTimestamp: startTime,
      model: KNOWN_MODELS.SONNET.id,
      metadataModel: KNOWN_MODELS.SONNET.id,
      historySequence,
      initialMetadata: { agentId: "plan" },
      runtime,
      modelFallback: {
        options: { chain: [fallbackModel], prepare },
        requestedModel: KNOWN_MODELS.SONNET.id,
        refusedModels: [],
        original: { maxOutputTokens: undefined },
      },
    });

    await processStreamWithCleanup.call(streamManager, workspaceId, streamInfo, historySequence);

    expect(prepare).toHaveBeenCalledTimes(1);
    expect(createStreamResult).not.toHaveBeenCalled();
    expect(errorEvents).toHaveLength(1);
    expect(errorEvents[0]).toMatchObject({ messageId, errorType: "model_refusal" });
    expect(errorEvents[0]?.error).toContain(
      `Configured fallback model ${fallbackModel} could not be started: API key not configured`
    );

    const partial = await historyService.readPartial(workspaceId);
    expect(partial?.metadata?.errorType).toBe("model_refusal");
  });

  test("a throwing prepare() fails terminally as model_refusal instead of a retryable error", async () => {
    const streamManager = new StreamManager(historyService);
    const errorEvents: Array<{ messageId: string; error: string; errorType?: string }> = [];

    onTurnEngineEvent(streamManager, "error", (data) => {
      errorEvents.push(data as { messageId: string; error: string; errorType?: string });
    });

    Reflect.set(streamManager, "tokenTracker", {
      setModel: () => Promise.resolve(undefined),
      countTokens: () => Promise.resolve(0),
    });

    const workspaceId = "fallback-prepare-throw-workspace";
    const messageId = "fallback-prepare-throw-message";
    const historySequence = 1;
    const fallbackModel = KNOWN_MODELS.GPT.id;

    await appendPartialAssistantForTests(workspaceId, messageId, historySequence);
    const processStreamWithCleanup = getProcessStreamWithCleanupForTests(streamManager);

    const createStreamResult = mock(() =>
      createStreamResultForTests(
        (async function* () {
          // Must never be called: prepare threw before a request was built.
        })()
      )
    );
    expect(Reflect.set(streamManager, "createStreamResult", createStreamResult)).toBe(true);

    // A THROW (not an Err) must not escape into the generic stream-error path,
    // where it would be categorized as a retryable api/unknown error and
    // re-enter the unbounded auto-retry loop refusals exist to prevent.
    const prepare = mock((_nextModelString: string) =>
      Promise.reject(new Error("provider factory exploded"))
    );

    const startTime = Date.now() - 250;
    const streamInfo = createStreamInfoForTests({
      streamResult: createStreamResultForTests(
        (async function* () {
          await Promise.resolve();
          yield { type: "finish", finishReason: "content-filter", rawFinishReason: "refusal" };
        })(),
        { inputTokens: 30000, outputTokens: 0, totalTokens: 30000 }
      ),
      messageId,
      startTime,
      lastPartTimestamp: startTime,
      model: KNOWN_MODELS.SONNET.id,
      metadataModel: KNOWN_MODELS.SONNET.id,
      historySequence,
      initialMetadata: { agentId: "plan" },
      runtime,
      modelFallback: {
        options: { chain: [fallbackModel], prepare },
        requestedModel: KNOWN_MODELS.SONNET.id,
        refusedModels: [],
        original: { maxOutputTokens: undefined },
      },
    });

    await processStreamWithCleanup.call(streamManager, workspaceId, streamInfo, historySequence);

    expect(prepare).toHaveBeenCalledTimes(1);
    expect(createStreamResult).not.toHaveBeenCalled();
    expect(errorEvents).toHaveLength(1);
    expect(errorEvents[0]).toMatchObject({ messageId, errorType: "model_refusal" });
    expect(errorEvents[0]?.error).toContain(
      `Configured fallback model ${fallbackModel} could not be started: provider factory exploded`
    );

    const partial = await historyService.readPartial(workspaceId);
    expect(partial?.metadata?.errorType).toBe("model_refusal");
  });
});

describe("StreamManager - TTFT metadata persistence", () => {
  const runtime = createRuntime({ type: "local", srcBaseDir: "/tmp" });

  interface ToolModelUsageEventForTests {
    toolName: string;
    toolCallId?: string;
    timestamp?: number;
    model: string;
    usage: {
      inputTokens: number;
      outputTokens: number;
      totalTokens: number;
      reasoningTokens?: number;
      cachedInputTokens?: number;
    };
    providerMetadata?: Record<string, unknown>;
    metadataModel?: string;
  }

  function recordToolModelUsageForTests(
    streamManager: StreamManager,
    workspaceId: string,
    messageId: string,
    event: ToolModelUsageEventForTests
  ): void {
    const recordToolModelUsage = Reflect.get(streamManager, "recordToolModelUsage");
    expect(typeof recordToolModelUsage).toBe("function");
    if (typeof recordToolModelUsage !== "function") {
      throw new Error("Expected StreamManager.recordToolModelUsage to exist");
    }

    recordToolModelUsage.call(streamManager, workspaceId, messageId, event);
  }

  function readToolModelUsages(message: { metadata?: unknown }): unknown[] | undefined {
    const metadata = message.metadata;
    if (metadata == null || typeof metadata !== "object") {
      return undefined;
    }

    const toolModelUsages = (metadata as Record<string, unknown>).toolModelUsages;
    return Array.isArray(toolModelUsages) ? toolModelUsages : undefined;
  }

  function createToolModelUsageEvent(
    overrides: Partial<ToolModelUsageEventForTests> = {}
  ): ToolModelUsageEventForTests {
    return {
      toolName: overrides.toolName ?? "advisor",
      toolCallId: overrides.toolCallId ?? "tool-call-1",
      timestamp: overrides.timestamp ?? Date.now(),
      model: overrides.model ?? "anthropic:claude-sonnet-4-20250514",
      usage: overrides.usage ?? {
        inputTokens: 40,
        outputTokens: 12,
        totalTokens: 52,
      },
      providerMetadata: overrides.providerMetadata,
      ...(overrides.metadataModel != null ? { metadataModel: overrides.metadataModel } : {}),
    };
  }

  async function finalizeStreamAndReadMessage(params: {
    workspaceId: string;
    messageId: string;
    historySequence: number;
    startTime: number;
    parts: unknown[];
    initialMetadata?: Record<string, unknown>;
    emitStartEvent?: boolean;
    onStreamStart?: (event: Record<string, unknown>) => void;
    onStreamEnd?: (event: { metadata?: Record<string, unknown> }) => void;
    usage?: {
      inputTokens: number;
      outputTokens: number;
      totalTokens: number;
      reasoningTokens?: number;
    };
    model?: string;
    metadataModel?: string;
    streamManager?: StreamManager;
    beforeProcess?: (params: {
      streamManager: StreamManager;
      workspaceId: string;
      messageId: string;
    }) => Promise<void> | void;
  }) {
    const streamManager = params.streamManager ?? new StreamManager(historyService);
    // Suppress error events from bubbling up as uncaught exceptions during tests

    if (params.onStreamStart) {
      onTurnEngineEvent(streamManager, "stream-start", params.onStreamStart);
    }
    if (params.onStreamEnd) {
      onTurnEngineEvent(streamManager, "stream-end", params.onStreamEnd);
    }

    const replaceTokenTrackerResult = Reflect.set(streamManager, "tokenTracker", {
      setModel: () => Promise.resolve(undefined),
      countTokens: () => Promise.resolve(0),
    });
    if (!replaceTokenTrackerResult) {
      throw new Error("Failed to mock StreamManager.tokenTracker");
    }

    await appendPartialAssistantForTests(
      params.workspaceId,
      params.messageId,
      params.historySequence
    );

    const processStreamWithCleanup = getProcessStreamWithCleanupForTests(streamManager);
    const usage = params.usage ?? { inputTokens: 4, outputTokens: 6, totalTokens: 10 };
    const streamInfo = createStreamInfoForTests({
      streamResult: createStreamResultForTests(
        (async function* () {
          // Tests pre-populate parts but still need the provider's terminal proof of completion.
          await Promise.resolve();
          yield { type: "finish", finishReason: "stop" };
        })(),
        usage
      ),
      messageId: params.messageId,
      startTime: params.startTime,
      lastPartTimestamp: params.startTime,
      model: params.model ?? KNOWN_MODELS.SONNET.id,
      metadataModel: params.metadataModel ?? params.model ?? KNOWN_MODELS.SONNET.id,
      historySequence: params.historySequence,
      initialMetadata: params.initialMetadata,
      parts: params.parts,
      runtime,
    });
    getWorkspaceStreamsForTests(streamManager).set(params.workspaceId, streamInfo);

    if (params.beforeProcess) {
      await params.beforeProcess({
        streamManager,
        workspaceId: params.workspaceId,
        messageId: params.messageId,
      });
    }

    if (params.emitStartEvent) {
      const emitStreamStart = getPrivateMethodForTests<
        (workspaceId: string, streamInfo: unknown, historySequence: number) => void
      >(streamManager, "emitStreamStart");
      emitStreamStart.call(streamManager, params.workspaceId, streamInfo, params.historySequence);
    }

    await processStreamWithCleanup.call(
      streamManager,
      params.workspaceId,
      streamInfo,
      params.historySequence
    );

    const historyResult = await historyService.getHistoryFromLatestBoundary(params.workspaceId);
    expect(historyResult.success).toBe(true);
    if (!historyResult.success) {
      throw new Error(historyResult.error);
    }

    const updatedMessage = historyResult.data.find((message) => message.id === params.messageId);
    expect(updatedMessage).toBeDefined();
    if (!updatedMessage) {
      throw new Error(`Expected updated message ${params.messageId} in history`);
    }

    return updatedMessage;
  }

  test("persists ttftMs in final assistant metadata when first-token timing is available", async () => {
    const startTime = Date.now() - 1000;
    const updatedMessage = await finalizeStreamAndReadMessage({
      workspaceId: "ttft-present-workspace",
      messageId: "ttft-present-message",
      historySequence: 1,
      startTime,
      parts: [
        {
          type: "text",
          text: "hello",
          timestamp: startTime + 250,
        },
      ],
    });

    expect(updatedMessage.metadata?.ttftMs).toBe(250);
  });

  test("omits ttftMs in final assistant metadata when first-token timing is unavailable", async () => {
    const startTime = Date.now() - 1000;
    const updatedMessage = await finalizeStreamAndReadMessage({
      workspaceId: "ttft-missing-workspace",
      messageId: "ttft-missing-message",
      historySequence: 1,
      startTime,
      parts: [
        {
          type: "dynamic-tool",
          toolCallId: "tool-1",
          toolName: "bash",
          state: "output-available",
          input: { script: "echo hi" },
          output: { ok: true },
          timestamp: startTime + 100,
        },
      ],
    });

    expect(updatedMessage.metadata?.ttftMs).toBeUndefined();
    expect(Object.prototype.hasOwnProperty.call(updatedMessage.metadata ?? {}, "ttftMs")).toBe(
      false
    );
  });

  test("persists metadataModel alongside the raw model for analytics pricing", async () => {
    const updatedMessage = await finalizeStreamAndReadMessage({
      workspaceId: "metadata-model-workspace",
      messageId: "metadata-model-message",
      historySequence: 1,
      startTime: Date.now() - 1000,
      model: "openai:my-gpt4",
      metadataModel: "openai:gpt-4",
      parts: [
        {
          type: "text",
          text: "hello",
          timestamp: Date.now(),
        },
      ],
    });

    expect(updatedMessage.metadata?.model).toBe("openai:my-gpt4");
    expect(updatedMessage.metadata?.metadataModel).toBe("openai:gpt-4");
  });

  test("emits and persists routeProvider from initial stream metadata", async () => {
    const startTime = Date.now() - 1000;
    let streamStartEvent: Record<string, unknown> | undefined;
    let streamEndEvent: { metadata?: Record<string, unknown> } | undefined;

    const updatedMessage = await finalizeStreamAndReadMessage({
      workspaceId: "route-provider-workspace",
      messageId: "route-provider-message",
      historySequence: 1,
      startTime,
      initialMetadata: {
        routeProvider: "openrouter",
        routedThroughGateway: true,
      },
      emitStartEvent: true,
      onStreamStart: (event) => {
        streamStartEvent = event;
      },
      onStreamEnd: (event) => {
        streamEndEvent = event;
      },
      parts: [
        {
          type: "text",
          text: "hello",
          timestamp: startTime + 100,
        },
      ],
    });

    expect(streamStartEvent).toMatchObject({
      routeProvider: "openrouter",
      routedThroughGateway: true,
    });
    expect(streamEndEvent?.metadata).toMatchObject({
      routeProvider: "openrouter",
      routedThroughGateway: true,
    });
    expect(updatedMessage.metadata?.routeProvider).toBe("openrouter");
    expect(updatedMessage.metadata?.routedThroughGateway).toBe(true);
  });

  test("persists per-invocation tool model usages on the final assistant message", async () => {
    const startTime = Date.now() - 1000;
    const firstToolUsage = createToolModelUsageEvent({
      toolName: "advisor",
      toolCallId: "tool-call-1",
      timestamp: startTime + 50,
      model: "openai:gpt-4",
      usage: {
        inputTokens: 60,
        outputTokens: 18,
        totalTokens: 78,
      },
      providerMetadata: { openai: { reasoningTokens: 4 } },
    });
    const secondToolUsage = createToolModelUsageEvent({
      toolName: "advisor",
      toolCallId: "tool-call-2",
      timestamp: startTime + 90,
      model: "openai:gpt-4",
      usage: {
        inputTokens: 30,
        outputTokens: 9,
        totalTokens: 39,
      },
      providerMetadata: { anthropic: { cacheCreationInputTokens: 3 } },
    });

    const updatedMessage = await finalizeStreamAndReadMessage({
      workspaceId: "tool-usage-persist-workspace",
      messageId: "tool-usage-persist-message",
      historySequence: 1,
      startTime,
      beforeProcess: ({ streamManager, workspaceId, messageId }) => {
        recordToolModelUsageForTests(streamManager, workspaceId, messageId, firstToolUsage);
        recordToolModelUsageForTests(streamManager, workspaceId, messageId, secondToolUsage);
      },
      parts: [
        {
          type: "text",
          text: "final response",
          timestamp: startTime + 200,
        },
      ],
    });

    expect(readToolModelUsages(updatedMessage)).toMatchObject([firstToolUsage, secondToolUsage]);
  });

  test("omits toolModelUsages when the assistant turn has no tool model usage", async () => {
    const startTime = Date.now() - 1000;
    const updatedMessage = await finalizeStreamAndReadMessage({
      workspaceId: "tool-usage-empty-workspace",
      messageId: "tool-usage-empty-message",
      historySequence: 1,
      startTime,
      parts: [
        {
          type: "text",
          text: "no tool usage here",
          timestamp: startTime + 150,
        },
      ],
    });

    expect(readToolModelUsages(updatedMessage)).toBeUndefined();
    expect(
      Object.prototype.hasOwnProperty.call(updatedMessage.metadata ?? {}, "toolModelUsages")
    ).toBe(false);
  });

  test("scopes tool model usage accumulation to the active assistant turn", async () => {
    const workspaceId = "tool-usage-scope-workspace";
    const streamManager = new StreamManager(historyService);
    const firstStartTime = Date.now() - 2000;
    const firstMessage = await finalizeStreamAndReadMessage({
      workspaceId,
      messageId: "tool-usage-first-message",
      historySequence: 1,
      startTime: firstStartTime,
      streamManager,
      beforeProcess: ({ streamManager: activeStreamManager, workspaceId, messageId }) => {
        recordToolModelUsageForTests(
          activeStreamManager,
          workspaceId,
          messageId,
          createToolModelUsageEvent({
            toolName: "advisor",
            toolCallId: "tool-call-first",
            timestamp: firstStartTime + 25,
            model: "anthropic:claude-sonnet-4-20250514",
            usage: {
              inputTokens: 24,
              outputTokens: 6,
              totalTokens: 30,
            },
          })
        );
      },
      parts: [
        {
          type: "text",
          text: "first response",
          timestamp: firstStartTime + 100,
        },
      ],
    });

    expect(readToolModelUsages(firstMessage)).toMatchObject([
      {
        toolName: "advisor",
        toolCallId: "tool-call-first",
      },
    ]);

    const secondMessage = await finalizeStreamAndReadMessage({
      workspaceId,
      messageId: "tool-usage-second-message",
      historySequence: 2,
      startTime: firstStartTime + 500,
      streamManager,
      beforeProcess: ({ streamManager: activeStreamManager, workspaceId }) => {
        recordToolModelUsageForTests(
          activeStreamManager,
          workspaceId,
          "tool-usage-first-message",
          createToolModelUsageEvent({
            toolName: "advisor",
            toolCallId: "tool-call-stale",
            timestamp: firstStartTime + 525,
            model: "anthropic:claude-sonnet-4-20250514",
            usage: {
              inputTokens: 12,
              outputTokens: 3,
              totalTokens: 15,
            },
          })
        );
      },
      parts: [
        {
          type: "text",
          text: "second response",
          timestamp: firstStartTime + 700,
        },
      ],
    });

    expect(readToolModelUsages(secondMessage)).toBeUndefined();
  });

  describe("StreamManager - reasoning token backfill", () => {
    test("backfills reasoningTokens from concatenated reasoning text when provider reports undefined", async () => {
      const startTime = Date.now() - 1000;
      const reasoningSegments = ["Thinking through ", "tradeoffs"];
      const expectedReasoningTokens = await countTokens(
        KNOWN_MODELS.SONNET.id,
        reasoningSegments.join("")
      );

      const updatedMessage = await finalizeStreamAndReadMessage({
        workspaceId: "reasoning-backfill-workspace",
        messageId: "reasoning-backfill-message",
        historySequence: 1,
        startTime,
        usage: { inputTokens: 100, outputTokens: 50, totalTokens: 150 },
        parts: [
          {
            type: "reasoning",
            text: reasoningSegments[0],
            timestamp: startTime + 100,
          },
          {
            type: "reasoning",
            text: reasoningSegments[1],
            timestamp: startTime + 150,
          },
          {
            type: "text",
            text: "Final answer",
            timestamp: startTime + 200,
          },
        ],
      });

      expect(updatedMessage.metadata?.usage?.reasoningTokens).toBe(expectedReasoningTokens);
    });

    test("does not backfill refused-model reasoning under the fallback model", async () => {
      const startTime = Date.now() - 1000;
      const fallbackReasoning = "Fallback-only reasoning";
      const expectedReasoningTokens = await countTokens(KNOWN_MODELS.GPT.id, fallbackReasoning);

      const updatedMessage = await finalizeStreamAndReadMessage({
        workspaceId: "reasoning-fallback-boundary-workspace",
        messageId: "reasoning-fallback-boundary-message",
        historySequence: 1,
        startTime,
        model: KNOWN_MODELS.GPT.id,
        metadataModel: KNOWN_MODELS.GPT.id,
        usage: { inputTokens: 100, outputTokens: 50, totalTokens: 150 },
        parts: [
          {
            type: "reasoning",
            text: "Refused-model reasoning",
            timestamp: startTime + 100,
          },
          {
            type: "reasoning",
            text: fallbackReasoning,
            timestamp: startTime + 150,
          },
          {
            type: "text",
            text: "Final answer",
            timestamp: startTime + 200,
          },
        ],
        beforeProcess: ({ streamManager, workspaceId }) => {
          const streamInfo = getWorkspaceStreamsForTests(streamManager).get(workspaceId);
          expect(streamInfo && typeof streamInfo === "object").toBe(true);
          if (!streamInfo || typeof streamInfo !== "object") {
            throw new Error("Expected stream info for reasoning fallback boundary test");
          }
          (streamInfo as { reasoningBackfillStartIndex?: number }).reasoningBackfillStartIndex = 1;
        },
      });

      expect(updatedMessage.metadata?.usage?.reasoningTokens).toBe(expectedReasoningTokens);
    });

    test("preserves provider-reported reasoningTokens when present", async () => {
      const startTime = Date.now() - 1000;
      const updatedMessage = await finalizeStreamAndReadMessage({
        workspaceId: "reasoning-provider-workspace",
        messageId: "reasoning-provider-message",
        historySequence: 1,
        startTime,
        usage: { inputTokens: 100, outputTokens: 250, totalTokens: 350, reasoningTokens: 200 },
        parts: [
          {
            type: "reasoning",
            text: "Model-supplied chain of thought",
            timestamp: startTime + 150,
          },
          {
            type: "text",
            text: "Summarized response",
            timestamp: startTime + 300,
          },
        ],
      });

      expect(updatedMessage.metadata?.usage?.reasoningTokens).toBe(200);
    });

    test("does not inject reasoningTokens when no reasoning deltas occurred", async () => {
      const startTime = Date.now() - 1000;
      const updatedMessage = await finalizeStreamAndReadMessage({
        workspaceId: "reasoning-none-workspace",
        messageId: "reasoning-none-message",
        historySequence: 1,
        startTime,
        usage: { inputTokens: 100, outputTokens: 50, totalTokens: 150 },
        parts: [
          {
            type: "text",
            text: "Only final response",
            timestamp: startTime + 200,
          },
        ],
      });

      expect(updatedMessage.metadata?.usage?.reasoningTokens).toBeUndefined();
    });
  });
});

describe("StreamManager - previousResponseId recovery", () => {
  test("isResponseIdLost returns false for unknown IDs", () => {
    const streamManager = new StreamManager(historyService);

    // Verify the ID is not lost initially
    expect(streamManager.isResponseIdLost("resp_123abc")).toBe(false);
    expect(streamManager.isResponseIdLost("resp_different")).toBe(false);
  });

  test("extractPreviousResponseIdFromError extracts ID from various error formats", () => {
    const streamManager = new StreamManager(historyService);

    // Get the private method via reflection
    const extractMethod = Reflect.get(streamManager, "extractPreviousResponseIdFromError") as (
      error: unknown
    ) => string | undefined;
    expect(typeof extractMethod).toBe("function");

    // Test extraction from APICallError with responseBody
    const apiError = new APICallError({
      message: "Previous response with id 'resp_abc123' not found.",
      url: "https://api.openai.com/v1/responses",
      requestBodyValues: {},
      statusCode: 400,
      responseHeaders: {},
      responseBody:
        '{"error":{"message":"Previous response with id \'resp_abc123\' not found.","code":"previous_response_not_found"}}',
      isRetryable: false,
      data: { error: { code: "previous_response_not_found" } },
    });
    expect(extractMethod.call(streamManager, apiError)).toBe("resp_abc123");

    // Test extraction from error message
    const errorWithMessage = new Error("Previous response with id 'resp_def456' not found.");
    expect(extractMethod.call(streamManager, errorWithMessage)).toBe("resp_def456");

    // Test when no ID is present
    const errorWithoutId = new Error("Some other error");
    expect(extractMethod.call(streamManager, errorWithoutId)).toBeUndefined();
  });

  const lostResponseIdCases = [
    {
      name: "explicit OpenAI errors",
      workspaceId: "workspace-1",
      messageId: "msg-1",
      lostId: "resp_deadbeef",
      error: createApiCallErrorForTests({
        message: "Previous response with id 'resp_deadbeef' not found.",
        statusCode: 400,
        responseBody: "Previous response with id 'resp_deadbeef' not found.",
        isRetryable: false,
        data: { error: { code: "previous_response_not_found" } },
      }),
    },
    {
      name: "500 errors referencing previous responses",
      workspaceId: "workspace-2",
      messageId: "msg-2",
      lostId: "resp_cafebabe",
      error: createApiCallErrorForTests({
        message: "Internal error: Previous response with id 'resp_cafebabe' not found.",
        statusCode: 500,
        responseBody: "Internal error: Previous response with id 'resp_cafebabe' not found.",
        isRetryable: false,
        data: { error: { code: "server_error" } },
      }),
    },
  ];

  for (const lostResponseIdCase of lostResponseIdCases) {
    test(`recordLostResponseIdIfApplicable records IDs for ${lostResponseIdCase.name}`, () => {
      const streamManager = new StreamManager(historyService);
      const recordMethod = getPrivateMethodForTests<
        (workspaceId: string, error: unknown, streamInfo: unknown) => void
      >(streamManager, "recordLostResponseIdIfApplicable");

      recordMethod.call(streamManager, lostResponseIdCase.workspaceId, lostResponseIdCase.error, {
        messageId: lostResponseIdCase.messageId,
        model: "openai:gpt-mini",
      });

      expect(streamManager.isResponseIdLost(lostResponseIdCase.lostId)).toBe(true);
    });
  }

  test("retryStreamWithoutPreviousResponseId retries at step boundary with existing parts", async () => {
    const streamManager = new StreamManager(historyService);

    const retryMethod = Reflect.get(streamManager, "retryStreamWithoutPreviousResponseId") as (
      workspaceId: string,
      streamInfo: unknown,
      error: unknown,
      hasRetried: boolean
    ) => Promise<boolean>;

    const model = createAnthropic({ apiKey: "test" })("claude-sonnet-4-5");
    const runtime = createRuntime({ type: "local", srcBaseDir: "/tmp" });
    const stepMessages: ModelMessage[] = [{ role: "user", content: "next step" }];

    const streamInfo = {
      state: "streaming",
      streamResult: {},
      abortController: new AbortController(),
      messageId: "msg-1",
      token: "token",
      startTime: Date.now(),
      model: "mux-gateway:openai/gpt-5.2-codex",
      historySequence: 1,
      stepTracker: { latestMessages: stepMessages },
      didRetryPreviousResponseIdAtStep: false,
      currentStepStartIndex: 1,
      stepStartIndices: [0, 1, 2],
      request: {
        model,
        messages: [{ role: "user", content: "original" }],
        system: "system",
        providerOptions: { openai: { previousResponseId: "resp_abc123" } },
      },
      parts: [
        {
          type: "dynamic-tool",
          toolCallId: "tool-1",
          toolName: "test",
          state: "output-available",
          input: {},
          output: {},
        },
      ],
      lastPartialWriteTime: 0,
      processingPromise: Promise.resolve(),
      softInterrupt: { pending: false },
      runtimeTempDir: "/tmp",
      runtime,
      cumulativeUsage: { inputTokens: 1, outputTokens: 2, totalTokens: 3 },
      cumulativeProviderMetadata: { openai: {} },
    };

    (streamManager as unknown as { createStreamResult: () => unknown }).createStreamResult =
      () => ({
        fullStream: (async function* () {
          await Promise.resolve();
          yield* [];
        })(),
        totalUsage: Promise.resolve(undefined),
        usage: Promise.resolve(undefined),
        providerMetadata: Promise.resolve(undefined),
        steps: Promise.resolve([]),
      });

    const apiError = createApiCallErrorForTests({
      message: "Previous response with id 'resp_abc123' not found.",
      statusCode: 400,
      responseBody: "Previous response with id 'resp_abc123' not found.",
      isRetryable: false,
      data: { error: { code: "previous_response_not_found" } },
    });

    const retried = await retryMethod.call(streamManager, "ws-step", streamInfo, apiError, false);
    expect(retried).toBe(true);
    expect(streamInfo.parts).toHaveLength(1);
    expect(streamInfo.didRetryPreviousResponseIdAtStep).toBe(true);
    expect(streamInfo.stepStartIndices).toEqual([0, 1]);
    expect(streamInfo.request.messages as ModelMessage[]).toBe(stepMessages);

    const openaiOptions = streamInfo.request.providerOptions as {
      openai?: Record<string, unknown>;
    };
    expect(openaiOptions.openai?.previousResponseId).toBeUndefined();
  });

  const totalUsageCases: Array<{
    name: string;
    streamInfo: Record<string, unknown>;
    totalUsage: Record<string, number> | undefined;
    expected: Record<string, number>;
  }> = [
    {
      name: "falls back to cumulative usage when stream total is missing",
      streamInfo: {
        didRetryPreviousResponseIdAtStep: false,
        cumulativeUsage: { inputTokens: 4, outputTokens: 5, totalTokens: 9 },
      },
      // getStreamMetadata's totalUsage read can time out (slow SDK settlement)
      // even though the provider billed the turn.
      totalUsage: undefined,
      expected: { inputTokens: 4, outputTokens: 5, totalTokens: 9 },
    },
    {
      name: "falls back to cumulative usage when stream total has zero tokens",
      streamInfo: {
        didRetryPreviousResponseIdAtStep: false,
        cumulativeUsage: { inputTokens: 4, outputTokens: 5, totalTokens: 9 },
      },
      totalUsage: { inputTokens: 0, outputTokens: 0, totalTokens: 0 },
      expected: { inputTokens: 4, outputTokens: 5, totalTokens: 9 },
    },
    {
      name: "prefers cumulative usage after step retry",
      streamInfo: {
        didRetryPreviousResponseIdAtStep: true,
        cumulativeUsage: { inputTokens: 4, outputTokens: 5, totalTokens: 9 },
      },
      totalUsage: { inputTokens: 1, outputTokens: 2, totalTokens: 3 },
      expected: { inputTokens: 4, outputTokens: 5, totalTokens: 9 },
    },
    {
      name: "prefers cumulative usage after empty-output retry",
      streamInfo: {
        didRetryPreviousResponseIdAtStep: false,
        didRetryAfterEmptyOutput: true,
        cumulativeUsage: { inputTokens: 6, outputTokens: 5, totalTokens: 11 },
      },
      totalUsage: { inputTokens: 2, outputTokens: 2, totalTokens: 4 },
      expected: { inputTokens: 6, outputTokens: 5, totalTokens: 11 },
    },
    {
      name: "treats non-zero fields as valid usage",
      streamInfo: {
        didRetryPreviousResponseIdAtStep: true,
        cumulativeUsage: { inputTokens: 4, outputTokens: 1, totalTokens: 0 },
      },
      totalUsage: { inputTokens: 1, outputTokens: 2, totalTokens: 3 },
      expected: { inputTokens: 4, outputTokens: 1, totalTokens: 0 },
    },
    {
      name: "keeps stream total without step retry",
      streamInfo: {
        didRetryPreviousResponseIdAtStep: false,
        cumulativeUsage: { inputTokens: 4, outputTokens: 5, totalTokens: 9 },
      },
      totalUsage: { inputTokens: 1, outputTokens: 2, totalTokens: 3 },
      expected: { inputTokens: 1, outputTokens: 2, totalTokens: 3 },
    },
  ];

  for (const usageCase of totalUsageCases) {
    test(`resolveTotalUsageForStreamEnd ${usageCase.name}`, () => {
      const streamManager = new StreamManager(historyService);
      const resolveMethod = getPrivateMethodForTests<
        (streamInfo: unknown, totalUsage: unknown) => unknown
      >(streamManager, "resolveTotalUsageForStreamEnd");

      expect(resolveMethod.call(streamManager, usageCase.streamInfo, usageCase.totalUsage)).toEqual(
        usageCase.expected
      );
    });
  }
});

describe("StreamManager - replayStream", () => {
  function createReplayStreamManager(): StreamManager {
    const streamManager = new StreamManager(historyService);
    // Suppress error events from bubbling up as uncaught exceptions during tests.
    return streamManager;
  }

  function setReplayStreamInfo(
    streamManager: StreamManager,
    workspaceId: string,
    streamInfo: Record<string, unknown>
  ): void {
    getWorkspaceStreamsForTests(streamManager).set(workspaceId, streamInfo);
  }

  function stubReplayTokenTracker(
    streamManager: StreamManager,
    countTokens: (text: string) => Promise<number> = () => Promise.resolve(1)
  ): void {
    const tokenTracker = Reflect.get(streamManager, "tokenTracker") as {
      setModel: (model: string) => Promise<void>;
      countTokens: (text: string) => Promise<number>;
    };
    tokenTracker.setModel = () => Promise.resolve();
    tokenTracker.countTokens = countTokens;
  }

  test("replayStream snapshots parts so reconnect doesn't block until stream ends", async () => {
    const streamManager = createReplayStreamManager();

    let sawStreamStart = false;
    onTurnEngineEvent(streamManager, "stream-start", (event: { replay?: boolean | undefined }) => {
      sawStreamStart = true;
      expect(event.replay).toBe(true);
    });
    const workspaceId = "ws-replay-snapshot";

    const deltas: string[] = [];
    onTurnEngineEvent(
      streamManager,
      "stream-delta",
      (event: { delta: string; replay?: boolean | undefined }) => {
        expect(event.replay).toBe(true);
        deltas.push(event.delta);
      }
    );

    const streamInfo = {
      state: "streaming",
      messageId: "msg-1",
      model: "claude-sonnet-4",
      historySequence: 1,
      startTime: 123,
      initialMetadata: {},
      parts: [{ type: "text", text: "a", timestamp: 10 }],
    };

    setReplayStreamInfo(streamManager, workspaceId, streamInfo);

    let pushed = false;
    stubReplayTokenTracker(streamManager, async () => {
      if (!pushed) {
        pushed = true;
        // While replay is mid-await, simulate the running stream appending more parts.
        (streamInfo.parts as Array<{ type: string; text?: string; timestamp?: number }>).push({
          type: "text",
          text: "b",
          timestamp: 20,
        });
      }
      // Force an await boundary so the mutation happens during replay.
      await new Promise((resolve) => setTimeout(resolve, 0));
      return 1;
    });

    await streamManager.replayStream(workspaceId);
    expect(sawStreamStart).toBe(true);

    // If replayStream iterates the live array, it would also emit "b".
    expect(deltas).toEqual(["a"]);
  });

  test("replayStream filters output-available tool parts using completion timestamps", async () => {
    const streamManager = createReplayStreamManager();

    const workspaceId = "ws-replay-tool-filter";

    const replayedToolEnds: string[] = [];
    onTurnEngineEvent(
      streamManager,
      "tool-call-end",
      (event: { replay?: boolean | undefined; toolCallId: string }) => {
        expect(event.replay).toBe(true);
        replayedToolEnds.push(event.toolCallId);
      }
    );

    const streamInfo = {
      state: "streaming",
      messageId: "msg-tools",
      model: "claude-sonnet-4",
      historySequence: 1,
      startTime: 123,
      initialMetadata: {},
      toolCompletionTimestamps: new Map([
        ["tool-old", 15],
        ["tool-new", 30],
      ]),
      parts: [
        {
          type: "dynamic-tool",
          toolCallId: "tool-old",
          toolName: "bash",
          input: {},
          state: "output-available",
          output: { ok: true },
          timestamp: 10,
        },
        {
          type: "dynamic-tool",
          toolCallId: "tool-new",
          toolName: "bash",
          input: {},
          state: "output-available",
          output: { ok: true },
          timestamp: 12,
        },
      ],
    };

    setReplayStreamInfo(streamManager, workspaceId, streamInfo);

    stubReplayTokenTracker(streamManager);

    await streamManager.replayStream(workspaceId, { afterTimestamp: 20 });

    expect(replayedToolEnds).toEqual(["tool-new"]);
  });

  test("replayStream replays queued tool parts whose execute() began after the cursor", async () => {
    const streamManager = createReplayStreamManager();

    const workspaceId = "ws-replay-exec-start";

    const replayedToolStarts: Array<{ toolCallId: string; executionStartedAt?: number }> = [];
    onTurnEngineEvent(
      streamManager,
      "tool-call-start",
      (event: {
        replay?: boolean | undefined;
        toolCallId: string;
        executionStartedAt?: number;
      }) => {
        expect(event.replay).toBe(true);
        replayedToolStarts.push({
          toolCallId: event.toolCallId,
          executionStartedAt: event.executionStartedAt,
        });
      }
    );

    const streamInfo = {
      state: "streaming",
      messageId: "msg-exec-start",
      model: "claude-sonnet-4",
      historySequence: 1,
      startTime: 123,
      initialMetadata: {},
      toolCompletionTimestamps: new Map(),
      parts: [
        {
          // Queued before the cursor, still waiting for the execution lock: not replayed.
          type: "dynamic-tool",
          toolCallId: "tool-still-queued",
          toolName: "bash",
          input: {},
          state: "input-available",
          timestamp: 10,
        },
        {
          // Queued before the cursor, execute() began after it: replayed with the
          // enriched executionStartedAt so the renderer can start the elapsed timer.
          type: "dynamic-tool",
          toolCallId: "tool-started-after-cursor",
          toolName: "bash",
          input: {},
          state: "input-available",
          timestamp: 12,
          executionStartedAt: 25,
        },
      ],
    };

    setReplayStreamInfo(streamManager, workspaceId, streamInfo);
    stubReplayTokenTracker(streamManager);

    await streamManager.replayStream(workspaceId, { afterTimestamp: 20 });

    expect(replayedToolStarts).toEqual([
      { toolCallId: "tool-started-after-cursor", executionStartedAt: 25 },
    ]);
  });

  test("replayStream emits replay usage-delta from tracked step/cumulative usage", async () => {
    const streamManager = createReplayStreamManager();

    const workspaceId = "ws-replay-usage";
    const usageEvents: Array<Extract<TurnEngineEvent, { type: "usage-delta" }>> = [];

    onTurnEngineEvent(streamManager, "usage-delta", (event) => {
      usageEvents.push(event);
    });

    setReplayStreamInfo(streamManager, workspaceId, {
      state: "streaming",
      messageId: "msg-usage",
      model: "claude-sonnet-4",
      metadataModel: "claude-sonnet-4",
      historySequence: 1,
      startTime: 123,
      initialMetadata: { costsIncluded: true },
      toolCompletionTimestamps: new Map<string, number>(),
      parts: [{ type: "text", text: "hello", timestamp: 10 }],
      lastStepUsage: { inputTokens: 21, outputTokens: 3, totalTokens: 24 },
      cumulativeUsage: { inputTokens: 55, outputTokens: 11, totalTokens: 66 },
      lastStepProviderMetadata: { anthropic: { cacheReadInputTokens: 2 } },
      cumulativeProviderMetadata: { anthropic: { cacheCreationInputTokens: 9 } },
    });

    stubReplayTokenTracker(streamManager);

    await streamManager.replayStream(workspaceId);

    expect(usageEvents).toHaveLength(1);
    expect(usageEvents[0]?.replay).toBe(true);
    expect(usageEvents[0]?.usage).toEqual({ inputTokens: 21, outputTokens: 3, totalTokens: 24 });
    expect(usageEvents[0]?.providerMetadata).toEqual({
      anthropic: { cacheReadInputTokens: 2 },
    });
    expect(usageEvents[0]?.cumulativeUsage).toEqual({
      inputTokens: 55,
      outputTokens: 11,
      totalTokens: 66,
    });
    expect(usageEvents[0]?.cumulativeProviderMetadata).toEqual({
      anthropic: { cacheCreationInputTokens: 9 },
      mux: { costsIncluded: true },
    });
  });
  test("replayStream skips replay usage-delta for incremental afterTimestamp replays", async () => {
    const streamManager = createReplayStreamManager();

    const workspaceId = "ws-replay-usage-incremental";
    const usageEvents: Array<{ replay?: boolean }> = [];

    onTurnEngineEvent(streamManager, "usage-delta", (event: { replay?: boolean }) => {
      usageEvents.push(event);
    });

    setReplayStreamInfo(streamManager, workspaceId, {
      state: "streaming",
      messageId: "msg-usage-incremental",
      model: "claude-sonnet-4",
      metadataModel: "claude-sonnet-4",
      historySequence: 1,
      startTime: 123,
      initialMetadata: {},
      toolCompletionTimestamps: new Map<string, number>(),
      parts: [{ type: "text", text: "hello", timestamp: 10 }],
      lastStepUsage: { inputTokens: 21, outputTokens: 3, totalTokens: 24 },
      cumulativeUsage: { inputTokens: 55, outputTokens: 11, totalTokens: 66 },
      lastStepProviderMetadata: { anthropic: { cacheReadInputTokens: 2 } },
      cumulativeProviderMetadata: { anthropic: { cacheCreationInputTokens: 9 } },
    });

    stubReplayTokenTracker(streamManager);

    await streamManager.replayStream(workspaceId, { afterTimestamp: 999 });

    expect(usageEvents).toHaveLength(0);
  });
});

describe("StreamManager - getStreamInfo", () => {
  test("returns startTime so reconnect cursors can preserve live-only boundaries", () => {
    const streamManager = new StreamManager(historyService);
    const workspaceId = "ws-get-stream-info";

    getWorkspaceStreamsForTests(streamManager).set(workspaceId, {
      state: "starting",
      messageId: "msg-starting",
      model: "claude-sonnet-4",
      historySequence: 1,
      startTime: 4_321,
      initialMetadata: { systemMessageTokens: 2_048 },
      currentStepStartIndex: 0,
      stepStartIndices: [0],
      parts: [],
      toolCompletionTimestamps: new Map<string, number>(),
    });

    const streamInfo = streamManager.getStreamInfo(workspaceId);

    expect(streamInfo?.messageId).toBe("msg-starting");
    expect(streamInfo?.startTime).toBe(4_321);
    expect(streamInfo?.initialMetadata?.systemMessageTokens).toBe(2_048);
    expect(streamInfo?.currentStepStartIndex).toBe(0);
    expect(streamInfo?.stepStartIndices).toEqual([0]);
    streamInfo?.stepStartIndices.push(5);
    expect(streamManager.getStreamInfo(workspaceId)?.stepStartIndices).toEqual([0]);
  });
});

describe("StreamManager - categorizeError", () => {
  function categorizeErrorForTests(error: unknown): unknown {
    const streamManager = new StreamManager(historyService);
    const categorizeMethod = getPrivateMethodForTests<(error: unknown) => unknown>(
      streamManager,
      "categorizeError"
    );
    return categorizeMethod.call(streamManager, error);
  }

  test("unwraps RetryError.lastError to classify model_not_found", () => {
    const apiError = createApiCallErrorForTests({
      message: "The model `gpt-5.2-codex` does not exist or you do not have access to it.",
      statusCode: 400,
      responseBody:
        '{"error":{"message":"The model `gpt-5.2-codex` does not exist or you do not have access to it.","code":"model_not_found"}}',
      isRetryable: false,
      data: { error: { code: "model_not_found" } },
    });
    const retryError = new RetryError({
      message: "AI SDK retry exhausted",
      reason: "maxRetriesExceeded",
      errors: [apiError],
    });

    expect(categorizeErrorForTests(retryError)).toBe("model_not_found");
  });

  test("classifies OpenAI 404 model_not_found by error code", () => {
    const apiError = createApiCallErrorForTests({
      message: "The model `gpt-nonexistent` does not exist or you do not have access to it.",
      statusCode: 404,
      responseBody:
        '{"error":{"message":"The model `gpt-nonexistent` does not exist or you do not have access to it.","type":"invalid_request_error","code":"model_not_found"}}',
      isRetryable: false,
      data: { error: { type: "invalid_request_error", code: "model_not_found" } },
    });

    expect(categorizeErrorForTests(apiError)).toBe("model_not_found");
  });

  const categorizeCases: Array<{ name: string; error: unknown; expected: string }> = [
    {
      name: "classifies Anthropic missing message_stop as stream_truncated",
      error: new Error("anthropic stream closed before message_stop"),
      expected: "stream_truncated",
    },
    {
      name: "classifies OpenAI Responses missing terminal event as stream_truncated",
      error: new Error("openai responses stream closed before terminal event"),
      expected: "stream_truncated",
    },
    {
      name: "classifies model_not_found via message fallback",
      error: new Error("The model `gpt-5.2-codex` does not exist or you do not have access to it."),
      expected: "model_not_found",
    },
    {
      name: "classifies 402 payment required as quota (avoid auto-retry)",
      error: createApiCallErrorForTests({
        message: "Insufficient balance. Please add credits to continue.",
        url: "https://gateway.mux.coder.com/api/v1/ai-gateway/v1/ai/language-model",
        statusCode: 402,
        responseBody:
          '{"error":{"message":"Insufficient balance. Please add credits to continue.","type":"invalid_request_error"}}',
        isRetryable: false,
        data: { error: { message: "Insufficient balance. Please add credits to continue." } },
      }),
      expected: "quota",
    },
    {
      name: "classifies 429 insufficient_quota responses as quota",
      error: createApiCallErrorForTests({
        message: "Request failed",
        statusCode: 429,
        responseBody:
          '{"error":{"code":"insufficient_quota","message":"You exceeded your current quota"}}',
        isRetryable: false,
        data: {
          error: { code: "insufficient_quota", message: "You exceeded your current quota" },
        },
      }),
      expected: "quota",
    },
    {
      name: "classifies generic 429 throttling as rate_limit",
      error: createApiCallErrorForTests({
        message: "Too many requests, please retry shortly",
        statusCode: 429,
        responseBody: '{"error":{"message":"Too many requests"}}',
        isRetryable: true,
      }),
      expected: "rate_limit",
    },
    {
      name: "classifies 429 mentioning quota limits as rate_limit (not billing)",
      error: createApiCallErrorForTests({
        message: "Per-minute quota limit reached. Retry in 10s.",
        statusCode: 429,
        responseBody: '{"error":{"message":"Per-minute quota limit reached"}}',
        isRetryable: true,
      }),
      expected: "rate_limit",
    },
  ];

  for (const categorizeCase of categorizeCases) {
    test(categorizeCase.name, () => {
      expect(categorizeErrorForTests(categorizeCase.error)).toBe(categorizeCase.expected);
    });
  }
});
describe("StreamManager - stopStream", () => {
  test("aborts a pending startup with its reserved identity", async () => {
    const events: TurnEngineEvent[] = [];
    const streamManager = new StreamManager(historyService, undefined, undefined, (event) => {
      events.push(event);
    });
    const startup = streamManager.beginStreamStart({
      workspaceId: "pending-workspace",
      acpPromptId: "prompt-1",
    });

    const result = await streamManager.stopStream("pending-workspace", {
      abandonPartial: true,
      abortReason: "user",
    });
    startup.finish();

    expect(result.success).toBe(true);
    expect(startup.abortSignal.aborted).toBe(true);
    expect(events).toHaveLength(1);
    expect(events[0]).toMatchObject({
      type: "stream-abort",
      workspaceId: "pending-workspace",
      messageId: startup.syntheticMessageId,
      abortReason: "user",
      abandonPartial: true,
      acpPromptId: "prompt-1",
    });
  });

  test("routes mock lifecycle operations through the engine", async () => {
    const streamManager = new StreamManager(historyService);
    const stop = mock(() => Promise.resolve());
    const replayStream = mock(() => Promise.resolve());
    streamManager.setMockStreamLifecycle({
      isStreaming: (workspaceId) => workspaceId === "mock-workspace",
      stop,
      replayStream,
    });

    expect(streamManager.isStreaming("mock-workspace")).toBe(true);
    expect((await streamManager.stopStream("mock-workspace")).success).toBe(true);
    await streamManager.replayStream("mock-workspace", { afterTimestamp: 10 });

    expect(stop).toHaveBeenCalledWith("mock-workspace");
    expect(replayStream).toHaveBeenCalledWith("mock-workspace");
  });

  test("emits stream-abort when stopping non-existent stream", async () => {
    const streamManager = new StreamManager(historyService);

    // Track emitted events
    const abortEvents: Array<{ workspaceId: string; messageId: string }> = [];
    onTurnEngineEvent(
      streamManager,
      "stream-abort",
      (data: { workspaceId: string; messageId: string }) => {
        abortEvents.push(data);
      }
    );

    // Stop a stream that doesn't exist (simulates interrupt before stream-start)
    const result = await streamManager.stopStream("test-workspace");

    expect(result.success).toBe(true);
    expect(abortEvents).toHaveLength(1);
    expect(abortEvents[0].workspaceId).toBe("test-workspace");
    // messageId is empty for synthetic abort (no actual stream existed)
    expect(abortEvents[0].messageId).toBe("");
  });
});

describe("StreamManager - aborted stream usage persistence", () => {
  type CleanupAbortedStreamForTests = (
    workspaceId: string,
    streamInfo: unknown,
    abortReason: string,
    abandonPartial?: boolean
  ) => Promise<void>;

  function createAbortStreamInfo(messageId: string): Record<string, unknown> {
    const usage = { inputTokens: 120, outputTokens: 30, totalTokens: 150 };
    return createStreamInfoForTests({
      messageId,
      parts: [{ type: "text", text: "partial output", timestamp: Date.now() }],
      cumulativeUsage: usage,
      cumulativeProviderMetadata: { anthropic: { cacheCreationInputTokens: 42 } },
      lastStepUsage: usage,
    });
  }

  test("stamps cumulative usage on the partial so committed history rows stay billable", async () => {
    const streamManager = new StreamManager(historyService);
    const workspaceId = "abort-usage-workspace";
    const messageId = "abort-usage-message";
    await appendPartialAssistantForTests(workspaceId, messageId, 1);

    const cleanupAborted = getPrivateMethodForTests<CleanupAbortedStreamForTests>(
      streamManager,
      "cleanupAbortedStream"
    );
    await cleanupAborted.call(streamManager, workspaceId, createAbortStreamInfo(messageId), "user");

    const partial = await historyService.readPartial(workspaceId);
    expect(partial?.metadata?.partial).toBe(true);
    expect(partial?.metadata?.usage).toEqual({
      inputTokens: 120,
      outputTokens: 30,
      totalTokens: 150,
    });
    expect(partial?.metadata?.providerMetadata).toEqual({
      anthropic: { cacheCreationInputTokens: 42 },
    });
    expect(partial?.metadata?.contextUsage).toEqual({
      inputTokens: 120,
      outputTokens: 30,
      totalTokens: 150,
    });
  });

  test("routes tool-only aborted usage to the headless sidecar (commit would drop it)", async () => {
    // Esc while a tool is still running: the partial's only part is an
    // input-available tool call, which commitPartial refuses to commit —
    // without the sidecar the billed usage would vanish with the partial.
    const { historyService: hs, config, cleanup } = await createTestHistoryService();
    try {
      const sessionUsageService = new SessionUsageService(config, hs);
      const streamManager = new StreamManager(hs, sessionUsageService);
      const workspaceId = "abort-tool-only-workspace";

      const usage = { inputTokens: 500, outputTokens: 0, totalTokens: 500 };
      const streamInfo = createStreamInfoForTests({
        messageId: "abort-tool-only-message",
        parts: [
          {
            type: "dynamic-tool",
            toolCallId: "call-1",
            toolName: "bash",
            input: { script: "sleep 60" },
            state: "input-available",
            timestamp: Date.now(),
          },
        ],
        cumulativeUsage: usage,
        lastStepUsage: usage,
        // Tool-internal model call reported before the abort: stamped as
        // metadata.toolModelUsages on the partial, which is dropped too.
        toolModelUsages: [
          {
            toolName: "agent_report",
            model: KNOWN_MODELS.SONNET.id,
            usage: { inputTokens: 70, outputTokens: 7, totalTokens: 77 },
          },
        ],
      });

      const cleanupAborted = getPrivateMethodForTests<CleanupAbortedStreamForTests>(
        streamManager,
        "cleanupAbortedStream"
      );
      await cleanupAborted.call(streamManager, workspaceId, streamInfo, "user");

      const sidecarPath = path.join(
        path.join(config.sessionsDir, workspaceId),
        "headless-usage.jsonl"
      );
      const records = (await fs.readFile(sidecarPath, "utf-8"))
        .trim()
        .split("\n")
        .map((line) => JSON.parse(line) as Record<string, unknown>);
      // Parent stream usage AND the tool-internal model call each get a row.
      expect(records).toHaveLength(2);
      expect(records[0].source).toBe("aborted_stream");
      expect((records[0].usage as Record<string, unknown>).inputTokens).toBe(500);
      expect(records[1].source).toBe("aborted_stream");
      expect(records[1].model).toBe(KNOWN_MODELS.SONNET.id);
      expect((records[1].usage as Record<string, unknown>).inputTokens).toBe(70);
    } finally {
      await cleanup();
    }
  });

  test("does not write the sidecar when the aborted partial is commit-worthy", async () => {
    // Text parts commit with usage attached — a sidecar line here would
    // double-count the turn (chat row + headless row).
    const { historyService: hs, config, cleanup } = await createTestHistoryService();
    try {
      const sessionUsageService = new SessionUsageService(config, hs);
      const streamManager = new StreamManager(hs, sessionUsageService);
      const workspaceId = "abort-commit-worthy-workspace";
      await appendPartialAssistantForTests(workspaceId, "abort-commit-worthy-message", 1);

      const cleanupAborted = getPrivateMethodForTests<CleanupAbortedStreamForTests>(
        streamManager,
        "cleanupAbortedStream"
      );
      await cleanupAborted.call(
        streamManager,
        workspaceId,
        createAbortStreamInfo("abort-commit-worthy-message"),
        "user"
      );

      const sidecarPath = path.join(
        path.join(config.sessionsDir, workspaceId),
        "headless-usage.jsonl"
      );
      expect(existsSync(sidecarPath)).toBe(false);
      // Usage still reaches history via the partial (asserted in the test above).
      const partial = await hs.readPartial(workspaceId);
      expect(partial?.metadata?.usage).toBeDefined();
    } finally {
      await cleanup();
    }
  });

  test("routes non-durable errored usage to the headless sidecar (commit would drop it)", async () => {
    // Provider/empty-output error before any commit-worthy output: the error
    // placeholder is deleted at commit time, so the billed usage must ride
    // the sidecar or the turn never reaches the events table.
    const { historyService: hs, config, cleanup } = await createTestHistoryService();
    try {
      const sessionUsageService = new SessionUsageService(config, hs);
      const streamManager = new StreamManager(hs, sessionUsageService);
      const workspaceId = "error-nondurable-workspace";

      const usage = { inputTokens: 900, outputTokens: 0, totalTokens: 900 };
      const streamInfo = createStreamInfoForTests({
        messageId: "error-nondurable-message",
        parts: [],
        cumulativeUsage: usage,
        lastStepUsage: usage,
      });

      type PersistStreamErrorForTests = (
        workspaceId: string,
        streamInfo: unknown,
        payload: { messageId: string; error: string; errorType: string }
      ) => Promise<void>;
      const persistError = getPrivateMethodForTests<PersistStreamErrorForTests>(
        streamManager,
        "persistStreamError"
      );
      await persistError.call(streamManager, workspaceId, streamInfo, {
        messageId: "error-nondurable-message",
        error: "provider exploded",
        errorType: "empty_output",
      });

      const sidecarPath = path.join(
        path.join(config.sessionsDir, workspaceId),
        "headless-usage.jsonl"
      );
      const record = JSON.parse((await fs.readFile(sidecarPath, "utf-8")).trim()) as Record<
        string,
        unknown
      >;
      expect(record.source).toBe("errored_stream");
      expect((record.usage as Record<string, unknown>).inputTokens).toBe(900);
    } finally {
      await cleanup();
    }
  });

  test("errored turns are sidecar-canonical even with commit-worthy parts", async () => {
    // Nothing commits the error partial at error time (AIService forwards
    // "error" without commitPartial), and a retry overwrites it — so usage
    // must ride the sidecar and stay OFF the partial, or the spend strands
    // until an unrelated send (and the eventual commit would double-count).
    const { historyService: hs, config, cleanup } = await createTestHistoryService();
    try {
      const sessionUsageService = new SessionUsageService(config, hs);
      const streamManager = new StreamManager(hs, sessionUsageService);
      const workspaceId = "error-commit-worthy-workspace";

      const usage = { inputTokens: 900, outputTokens: 40, totalTokens: 940 };
      const streamInfo = createStreamInfoForTests({
        messageId: "error-commit-worthy-message",
        parts: [{ type: "text", text: "partial answer before failure", timestamp: Date.now() }],
        cumulativeUsage: usage,
        lastStepUsage: usage,
      });

      type PersistStreamErrorForTests = (
        workspaceId: string,
        streamInfo: unknown,
        payload: { messageId: string; error: string; errorType: string }
      ) => Promise<void>;
      const persistError = getPrivateMethodForTests<PersistStreamErrorForTests>(
        streamManager,
        "persistStreamError"
      );
      await persistError.call(streamManager, workspaceId, streamInfo, {
        messageId: "error-commit-worthy-message",
        error: "stream truncated",
        errorType: "stream_truncated",
      });

      const sidecarPath = path.join(
        path.join(config.sessionsDir, workspaceId),
        "headless-usage.jsonl"
      );
      const record = JSON.parse((await fs.readFile(sidecarPath, "utf-8")).trim()) as Record<
        string,
        unknown
      >;
      expect(record.source).toBe("errored_stream");
      expect((record.usage as Record<string, unknown>).inputTokens).toBe(900);
      // The partial keeps its content for retry/resume but carries no usage.
      const partial = await hs.readPartial(workspaceId);
      expect(partial?.metadata?.usage).toBeUndefined();
      expect(partial?.parts).toMatchObject([{ type: "text" }]);
    } finally {
      await cleanup();
    }
  });

  test("abandoned aborts skip the partial but route usage to the headless sidecar", async () => {
    // Edit/discard of a streaming turn (abandonPartial=true): the partial and
    // its content are deliberately dropped, so the sidecar is the only route
    // for the billed tokens to reach the events table.
    const { historyService: hs, config, cleanup } = await createTestHistoryService();
    try {
      const sessionUsageService = new SessionUsageService(config, hs);
      const streamManager = new StreamManager(hs, sessionUsageService);
      const workspaceId = "abort-abandon-workspace";
      const messageId = "abort-abandon-message";

      const cleanupAborted = getPrivateMethodForTests<CleanupAbortedStreamForTests>(
        streamManager,
        "cleanupAbortedStream"
      );
      await cleanupAborted.call(
        streamManager,
        workspaceId,
        createAbortStreamInfo(messageId),
        "user",
        true
      );

      // Partial untouched (the abandon contract) …
      const partial = await hs.readPartial(workspaceId);
      expect(partial).toBeNull();
      // … but the billed usage still reaches analytics via the sidecar.
      const sidecarPath = path.join(
        path.join(config.sessionsDir, workspaceId),
        "headless-usage.jsonl"
      );
      const record = JSON.parse((await fs.readFile(sidecarPath, "utf-8")).trim()) as Record<
        string,
        unknown
      >;
      expect(record.source).toBe("aborted_stream");
      expect((record.usage as Record<string, unknown>).inputTokens).toBe(120);
    } finally {
      await cleanup();
    }
  });
});

// Note: Comprehensive Anthropic cache control tests are in cacheStrategy.test.ts
// Those unit tests cover all cache control functionality without requiring
// complex setup. StreamManager integrates those functions directly.

describe("StreamManager - tool search activeTools scoping", () => {
  interface StreamRequestConfigForTests {
    model: unknown;
    messages: ModelMessage[];
    system?: string;
    tools?: Record<string, Tool>;
    toolSearchState?: ToolSearchStreamState;
  }

  type BuildStreamRequestConfig = (input: Record<string, unknown>) => StreamRequestConfigForTests;
  type CreateStreamResult = (
    request: StreamRequestConfigForTests,
    abortController: AbortController
  ) => unknown;

  // prepareStep only destructures `messages`; the remaining PrepareStepFunction
  // fields are irrelevant to this behavior.
  type CapturedPrepareStep = (options: {
    messages: ModelMessage[];
  }) => Promise<{ messages?: ModelMessage[]; activeTools?: string[] } | undefined>;

  const model = createAnthropic({ apiKey: "test" })("claude-sonnet-4-5");
  const messages: ModelMessage[] = [{ role: "user", content: "hello" }];

  function getRequestHelpers(streamManager: StreamManager): {
    buildRequestConfig: BuildStreamRequestConfig;
    createStreamResult: CreateStreamResult;
  } {
    const buildRequestConfig = Reflect.get(streamManager, "buildStreamRequestConfig") as
      | BuildStreamRequestConfig
      | undefined;
    const createStreamResultMethod = Reflect.get(streamManager, "createStreamResult") as
      | CreateStreamResult
      | undefined;

    expect(typeof buildRequestConfig).toBe("function");
    expect(typeof createStreamResultMethod).toBe("function");

    if (!buildRequestConfig || !createStreamResultMethod) {
      throw new Error("Expected StreamManager private helpers to exist");
    }

    return {
      // .apply: buildStreamRequestConfig reads this.getProvidersConfig for
      // cache-marker eligibility; a detached Reflect.get reference loses `this`.
      buildRequestConfig: (input) => buildRequestConfig.call(streamManager, input),
      createStreamResult: (request, abortController) =>
        createStreamResultMethod.call(streamManager, request, abortController),
    };
  }

  function setupStreamTextSpy() {
    return spyOn(aiSdk, "streamText").mockReturnValue({
      fullStream: (async function* asyncGenerator() {
        yield* [] as unknown[];
        await Promise.resolve();
      })(),
      usage: Promise.resolve(undefined),
      providerMetadata: Promise.resolve(undefined),
      totalUsage: Promise.resolve(undefined),
      steps: Promise.resolve([]),
    } as unknown as ReturnType<typeof aiSdk.streamText>);
  }

  function capturePrepareStep(
    streamTextSpy: ReturnType<typeof setupStreamTextSpy>
  ): CapturedPrepareStep {
    const prepareStep = streamTextSpy.mock.calls[0]?.[0]?.prepareStep as
      | CapturedPrepareStep
      | undefined;
    expect(typeof prepareStep).toBe("function");
    if (!prepareStep) {
      throw new Error("Expected prepareStep to be captured");
    }
    return prepareStep;
  }

  afterEach(() => {
    mock.restore();
  });

  test("returns undefined (not {}) without tool search state and unchanged messages", async () => {
    const streamManager = new StreamManager(historyService);
    const { createStreamResult } = getRequestHelpers(streamManager);
    const streamTextSpy = setupStreamTextSpy();

    createStreamResult({ model, messages, system: "system" }, new AbortController());

    const prepareStep = capturePrepareStep(streamTextSpy);
    // Feature-off path must stay byte-identical to today's behavior.
    expect(await prepareStep({ messages })).toBeUndefined();
  });

  test("scopes activeTools to core + activated deferred tools, reflecting live activations", async () => {
    const streamManager = new StreamManager(historyService);
    const { createStreamResult } = getRequestHelpers(streamManager);
    const streamTextSpy = setupStreamTextSpy();

    const toolSearchState: ToolSearchStreamState = {
      catalog: [
        { name: "slack_send_message", description: "Send a message", paramText: "" },
        { name: "slack_list_channels", description: "List channels", paramText: "" },
      ],
      deferredToolNames: new Set(["slack_send_message", "slack_list_channels"]),
      allToolNames: ["bash", "tool_catalog_search", "slack_send_message", "slack_list_channels"],
      activatedToolNames: new Set(),
    };

    createStreamResult(
      { model, messages, system: "system", toolSearchState },
      new AbortController()
    );

    const prepareStep = capturePrepareStep(streamTextSpy);

    const firstStep = await prepareStep({ messages });
    expect(firstStep?.activeTools).toEqual(["bash", "tool_catalog_search"]);
    // Messages were unchanged, so no messages key should be introduced.
    expect(firstStep && "messages" in firstStep).toBe(false);

    // Simulate tool_catalog_search.execute activating a tool mid-stream: the next
    // prepareStep call must advertise it without rebuilding the request.
    toolSearchState.activatedToolNames.add("slack_send_message");
    const nextStep = await prepareStep({ messages });
    expect(nextStep?.activeTools).toEqual(["bash", "tool_catalog_search", "slack_send_message"]);
  });

  test("buildStreamRequestConfig forwards the tool search state reference", () => {
    const streamManager = new StreamManager(historyService);
    const { buildRequestConfig } = getRequestHelpers(streamManager);

    const toolSearchState: ToolSearchStreamState = {
      catalog: [],
      deferredToolNames: new Set(["mcp_tool"]),
      allToolNames: ["bash", "mcp_tool"],
      activatedToolNames: new Set(),
    };

    const request = buildRequestConfig({
      model,
      modelString: KNOWN_MODELS.SONNET.id,
      messages,
      system: "system",
      toolSearchState,
    });

    // Same reference, not a copy. tool_catalog_search.execute mutations must be
    // visible to prepareStep.
    expect(request.toolSearchState).toBe(toolSearchState);
  });
});

describe("StreamManager - mid-turn thinking override", () => {
  interface OverrideRequestForTests {
    model: unknown;
    messages: ModelMessage[];
    system?: string;
    providerOptions?: Record<string, unknown>;
    thinkingOverrideState?: ActiveTurnThinkingOverride;
    rebuildProviderOptionsForThinkingLevel?: RebuildProviderOptionsForThinkingLevel;
    rebuildFirstStepForThinkingLevel?: RebuildFirstStepForThinkingLevel;
    onStepMessages?: (stepMessages: ModelMessage[]) => void;
  }

  type BuildStreamRequestConfig = (input: Record<string, unknown>) => OverrideRequestForTests;
  type CreateStreamResult = (
    request: OverrideRequestForTests,
    abortController: AbortController
  ) => unknown;
  type CapturedPrepareStep = (options: {
    messages: ModelMessage[];
    stepNumber?: number;
  }) => Promise<
    | {
        messages?: ModelMessage[];
        activeTools?: string[];
        providerOptions?: Record<string, unknown>;
      }
    | undefined
  >;

  const model = createAnthropic({ apiKey: "test" })("claude-sonnet-4-5");
  const messages: ModelMessage[] = [{ role: "user", content: "hello" }];

  function getRequestHelpers(streamManager: StreamManager): {
    buildRequestConfig: BuildStreamRequestConfig;
    createStreamResult: CreateStreamResult;
  } {
    const buildRequestConfig = Reflect.get(streamManager, "buildStreamRequestConfig") as
      | ((input: Record<string, unknown>) => OverrideRequestForTests)
      | undefined;
    const createStreamResultMethod = Reflect.get(streamManager, "createStreamResult") as
      | CreateStreamResult
      | undefined;
    expect(typeof buildRequestConfig).toBe("function");
    expect(typeof createStreamResultMethod).toBe("function");
    if (!buildRequestConfig || !createStreamResultMethod) {
      throw new Error("Expected StreamManager private helpers to exist");
    }
    return {
      buildRequestConfig: (input) => buildRequestConfig.call(streamManager, input),
      createStreamResult: (request, abortController) =>
        createStreamResultMethod.call(streamManager, request, abortController),
    };
  }

  function setupStreamTextSpy() {
    return spyOn(aiSdk, "streamText").mockReturnValue({
      fullStream: (async function* asyncGenerator() {
        yield* [] as unknown[];
        await Promise.resolve();
      })(),
      usage: Promise.resolve(undefined),
      providerMetadata: Promise.resolve(undefined),
      totalUsage: Promise.resolve(undefined),
      steps: Promise.resolve([]),
    } as unknown as ReturnType<typeof aiSdk.streamText>);
  }

  function capturePrepareStep(
    streamTextSpy: ReturnType<typeof setupStreamTextSpy>
  ): CapturedPrepareStep {
    const prepareStep = streamTextSpy.mock.calls[0]?.[0]?.prepareStep as
      | CapturedPrepareStep
      | undefined;
    expect(typeof prepareStep).toBe("function");
    if (!prepareStep) {
      throw new Error("Expected prepareStep to be captured");
    }
    return prepareStep;
  }

  afterEach(() => {
    mock.restore();
  });

  test("applies a pending override in place: same object identity, old keys deleted, sink invoked", async () => {
    const streamManager = new StreamManager(historyService);
    const { createStreamResult } = getRequestHelpers(streamManager);
    const streamTextSpy = setupStreamTextSpy();

    const appliedLevels: string[] = [];
    const state: ActiveTurnThinkingOverride = {
      pending: "high",
      onApplied: (level) => appliedLevels.push(level),
    };
    const originalProviderOptions: Record<string, unknown> = {
      anthropic: { effort: "low", thinking: { type: "enabled", budgetTokens: 4000 } },
      staleNamespace: { key: "must-be-deleted" },
    };
    const rebuilt = { anthropic: { effort: "high", thinking: { type: "enabled" } } };
    const rebuild = mock((level: string) =>
      level === "high" ? { effectiveLevel: "high" as const, providerOptions: rebuilt } : null
    );

    const request: OverrideRequestForTests = {
      model,
      messages,
      system: "system",
      providerOptions: originalProviderOptions,
      thinkingOverrideState: state,
      rebuildProviderOptionsForThinkingLevel:
        rebuild as unknown as RebuildProviderOptionsForThinkingLevel,
    };
    createStreamResult(request, new AbortController());
    const prepareStep = capturePrepareStep(streamTextSpy);

    const step = await prepareStep({ messages });
    // Rebuilt options are returned for the step (defense in depth) …
    expect(step?.providerOptions).toEqual(rebuilt);
    // … and the live request object is replaced IN PLACE (same identity),
    // deleting keys the SDK's deep-merge could never remove.
    expect(request.providerOptions).toBe(originalProviderOptions);
    expect(request.providerOptions).toEqual(rebuilt);
    expect("staleNamespace" in originalProviderOptions).toBe(false);
    // Consume-once bookkeeping + metadata sink.
    expect(state.pending).toBeUndefined();
    expect(state.applied).toBe("high");
    expect(appliedLevels).toEqual(["high"]);
    // Without a new pending value the next step is a no-op again.
    expect(await prepareStep({ messages })).toBeUndefined();
    expect(rebuild).toHaveBeenCalledTimes(1);
  });

  test("clears pending without touching options when the rebuild reports not-applicable", async () => {
    const streamManager = new StreamManager(historyService);
    const { createStreamResult } = getRequestHelpers(streamManager);
    const streamTextSpy = setupStreamTextSpy();

    const state: ActiveTurnThinkingOverride = { pending: "off" };
    const originalProviderOptions: Record<string, unknown> = { xai: { some: "config" } };
    const rebuild = mock(() => null);

    const request: OverrideRequestForTests = {
      model,
      messages,
      system: "system",
      providerOptions: originalProviderOptions,
      thinkingOverrideState: state,
      rebuildProviderOptionsForThinkingLevel:
        rebuild as unknown as RebuildProviderOptionsForThinkingLevel,
    };
    createStreamResult(request, new AbortController());
    const prepareStep = capturePrepareStep(streamTextSpy);

    expect(await prepareStep({ messages })).toBeUndefined();
    expect(request.providerOptions).toEqual({ xai: { some: "config" } });
    // Consume-once: a skipped application must not retry on every later step.
    expect(state.pending).toBeUndefined();
    expect(state.applied).toBeUndefined();
    expect(await prepareStep({ messages })).toBeUndefined();
    expect(rebuild).toHaveBeenCalledTimes(1);
  });

  test("stays byte-identical to the feature-off behavior when no override state exists", async () => {
    const streamManager = new StreamManager(historyService);
    const { createStreamResult } = getRequestHelpers(streamManager);
    const streamTextSpy = setupStreamTextSpy();

    createStreamResult({ model, messages, system: "system" }, new AbortController());
    const prepareStep = capturePrepareStep(streamTextSpy);
    expect(await prepareStep({ messages })).toBeUndefined();
  });

  test("buildStreamRequestConfig normalizes providerOptions to a stable mutable object only when a rebuild closure exists", () => {
    const streamManager = new StreamManager(historyService);
    const { buildRequestConfig, createStreamResult } = getRequestHelpers(streamManager);
    const streamTextSpy = setupStreamTextSpy();

    const state: ActiveTurnThinkingOverride = {};
    const rebuild: RebuildProviderOptionsForThinkingLevel = () => null;

    // Without the closure, an absent providerOptions stays absent (no behavior change).
    const plainRequest = buildRequestConfig({
      model,
      modelString: KNOWN_MODELS.SONNET.id,
      messages,
      system: "system",
    });
    expect(plainRequest.providerOptions).toBeUndefined();

    // With the closure, undefined normalizes to a mutable object whose identity
    // is exactly what streamText() captures — otherwise in-place mutation at
    // prepareStep time would be unobservable to the SDK's per-step merge.
    const request = buildRequestConfig({
      model,
      modelString: KNOWN_MODELS.SONNET.id,
      messages,
      system: "system",
      // providerOptions intentionally absent
      thinkingOverrideState: state,
      rebuildProviderOptionsForThinkingLevel: rebuild,
    });
    expect(request.providerOptions).toEqual({});
    expect(request.thinkingOverrideState).toBe(state);
    expect(request.rebuildProviderOptionsForThinkingLevel).toBe(rebuild);

    createStreamResult(request, new AbortController());
    const streamTextArgs = streamTextSpy.mock.calls[0]?.[0];
    expect(streamTextArgs?.providerOptions).toBe(
      request.providerOptions as NonNullable<typeof streamTextArgs>["providerOptions"]
    );
  });

  test("model fallback folds the pending override into prepare() and rebinds holder + closure on the swapped request", async () => {
    const streamManager = new StreamManager(historyService);
    Reflect.set(streamManager, "tokenTracker", {
      setModel: () => Promise.resolve(undefined),
      countTokens: () => Promise.resolve(0),
    });

    const workspaceId = "thinking-fallback-workspace";
    const messageId = "thinking-fallback-message";
    const historySequence = 1;
    const fallbackModel = KNOWN_MODELS.GPT.id;

    await appendPartialAssistantForTests(workspaceId, messageId, historySequence);
    const processStreamWithCleanup = getProcessStreamWithCleanupForTests(streamManager);

    const capturedNextRequests: OverrideRequestForTests[] = [];
    const createStreamResult = mock((request: OverrideRequestForTests) => {
      capturedNextRequests.push(request);
      return createStreamResultForTests(
        (async function* () {
          await Promise.resolve();
          yield { type: "text-delta", text: "fallback answer" };
          yield { type: "finish", finishReason: "stop" };
        })(),
        { inputTokens: 5, outputTokens: 3, totalTokens: 8 }
      );
    });
    expect(Reflect.set(streamManager, "createStreamResult", createStreamResult)).toBe(true);

    const fallbackLanguageModel = createTestLanguageModel("fallback-model");
    const fallbackRebuild: RebuildProviderOptionsForThinkingLevel = () => null;
    const prepare = mock((nextModelString: string, options?: ModelFallbackPrepareOptions) => {
      expect(options?.thinkingLevelOverride).toBe("high");
      return Promise.resolve(
        Ok({
          model: fallbackLanguageModel,
          modelString: nextModelString,
          messages: [],
          system: "fallback system",
          tools: undefined,
          thinkingLevel: "high",
          rebuildProviderOptionsForThinkingLevel: fallbackRebuild,
        })
      );
    });

    // Pending override that never got a next step on the refusing stream: the
    // fallback hop must not silently revert it.
    const holder: ActiveTurnThinkingOverride = { pending: "high" };
    const startTime = Date.now() - 250;
    const streamInfo = createStreamInfoForTests({
      streamResult: createStreamResultForTests(
        (async function* () {
          await Promise.resolve();
          yield { type: "finish", finishReason: "content-filter", rawFinishReason: "refusal" };
        })(),
        { inputTokens: 10, outputTokens: 0, totalTokens: 10 }
      ),
      messageId,
      startTime,
      lastPartTimestamp: startTime,
      model: KNOWN_MODELS.SONNET.id,
      metadataModel: KNOWN_MODELS.SONNET.id,
      historySequence,
      runtime: LOCAL_TEST_RUNTIME,
      request: {
        model: createTestLanguageModel("refused-model"),
        messages: [],
        providerOptions: undefined,
        thinkingOverrideState: holder,
      },
      modelFallback: {
        options: { chain: [fallbackModel], prepare },
        requestedModel: KNOWN_MODELS.SONNET.id,
        refusedModels: [],
        original: { maxOutputTokens: undefined },
      },
    });

    await processStreamWithCleanup.call(streamManager, workspaceId, streamInfo, historySequence);

    expect(prepare).toHaveBeenCalledTimes(1);
    // Pending was folded into the fallback baseline (consumed, kept as applied
    // for potential second hops).
    expect(holder.pending).toBeUndefined();
    expect(holder.applied).toBe("high");
    // The swapped request carries the SAME holder (the session setter keeps
    // working) and the fallback-bound rebuild closure.
    expect(createStreamResult).toHaveBeenCalledTimes(1);
    const nextRequest = capturedNextRequests[0];
    expect(nextRequest?.thinkingOverrideState).toBe(holder);
    expect(nextRequest?.rebuildProviderOptionsForThinkingLevel).toBe(fallbackRebuild);
  });
});

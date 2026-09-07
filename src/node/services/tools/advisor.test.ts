import { afterEach, describe, expect, it, mock, spyOn } from "bun:test";
import type { LanguageModelV2Usage } from "@ai-sdk/provider";
import * as ai from "ai";
import type { LanguageModel, ToolExecutionOptions } from "ai";

import {
  ADVISOR_HANDOFF_MAX_REASONING_CHARS,
  ADVISOR_HANDOFF_MAX_TEXT_CHARS,
} from "@/common/constants/advisor";
import type { ModelMessage } from "@/common/types/message";
import type { WorkspaceChatMessage } from "@/common/orpc/types";
import type { AdvisorToolCallSnapshot, ToolModelUsageEvent } from "@/common/utils/tools/tools";
import { log } from "@/node/services/log";
import { createAdvisorTool } from "./advisor";
import { TestTempDir, createTestToolConfig } from "./testHelpers";

const ADVISOR_MODEL = "anthropic:claude-sonnet-4-20250514";
const mockToolCallOptions: ToolExecutionOptions<unknown> = {
  toolCallId: "test-call-id",
  messages: [],
  context: undefined,
};

function createTranscript(): ModelMessage[] {
  return [{ role: "user", content: "hello" }];
}

function createSnapshot(overrides?: Partial<AdvisorToolCallSnapshot>): AdvisorToolCallSnapshot {
  return {
    toolCallId: "test-call-id",
    toolName: "advisor",
    input: { question: "How should we proceed?" },
    stepText: "current-step commentary",
    stepReasoning: "current-step reasoning",
    ...overrides,
  };
}

function createToolConfig(
  tempDir: string,
  options?: {
    reportModelUsage?: Parameters<typeof createAdvisorTool>[0]["reportModelUsage"];
    metadataModel?: string;
    transcript?: ModelMessage[];
    snapshot?: AdvisorToolCallSnapshot | undefined;
    maxOutputTokens?: number;
    emitChatEvent?: (event: WorkspaceChatMessage) => void;
    workspaceId?: string;
  }
) {
  const advisorLanguageModel = Object.create(null) as LanguageModel;
  const createModel = mock(() =>
    Promise.resolve({
      model: advisorLanguageModel,
      ...(options?.metadataModel ? { metadataModel: options.metadataModel } : {}),
      optionsModelString: ADVISOR_MODEL,
      optionsProvidersConfig: null,
    })
  );
  const transcript = options?.transcript ?? createTranscript();
  const getTranscriptSnapshot = mock(() => transcript);
  const takeToolCallSnapshot = mock((_toolCallId: string) => options?.snapshot);
  const config = {
    ...createTestToolConfig(tempDir, { workspaceId: options?.workspaceId }),
    emitChatEvent: options?.emitChatEvent,
    reportModelUsage: options?.reportModelUsage,
    advisorRuntime: {
      advisorModelString: ADVISOR_MODEL,
      reasoningLevel: "medium",
      maxUsesPerTurn: 3,
      maxOutputTokens: options?.maxOutputTokens,
      getTranscriptSnapshot,
      takeToolCallSnapshot,
      createModel,
      abortSignal: new AbortController().signal,
    },
  };

  return { config, createModel, getTranscriptSnapshot, takeToolCallSnapshot, transcript };
}

type StreamTextArgs = Parameters<typeof ai.streamText>[0];
type StreamTextResult = ReturnType<typeof ai.streamText>;
type StreamTextFinishReason = Awaited<StreamTextResult["finishReason"]>;

function mockStreamTextSuccess(result: {
  text: string;
  usage: LanguageModelV2Usage;
  providerMetadata?: Record<string, unknown>;
  chunks?: Array<{ type: string; text?: string; delta?: string; textDelta?: string }>;
  finishReason?: StreamTextFinishReason;
  streamError?: Error;
}) {
  return spyOn(ai, "streamText").mockImplementation(((args: StreamTextArgs) => {
    const text = (async () => {
      for (const chunk of result.chunks ?? []) {
        await args.onChunk?.({ chunk } as Parameters<NonNullable<typeof args.onChunk>>[0]);
      }
      if (result.streamError) {
        await args.onError?.({ error: result.streamError });
      }
      return result.text;
    })();

    return {
      text,
      finishReason: Promise.resolve(result.finishReason ?? "stop"),
      usage: Promise.resolve(result.usage),
      providerMetadata: Promise.resolve(result.providerMetadata),
    } as unknown as StreamTextResult;
  }) as unknown as typeof ai.streamText);
}

function mockStreamTextFailure(error: Error) {
  return spyOn(ai, "streamText").mockImplementation(
    (() =>
      ({
        text: Promise.reject(error),
        finishReason: Promise.resolve("error"),
        usage: Promise.resolve(undefined),
        providerMetadata: Promise.resolve(undefined),
      }) as unknown as StreamTextResult) as unknown as typeof ai.streamText
  );
}

function getStreamTextArgs(
  streamTextSpy: ReturnType<typeof mockStreamTextSuccess>
): Parameters<typeof ai.streamText>[0] {
  const args = streamTextSpy.mock.calls[0]?.[0];
  expect(args).toBeDefined();
  if (!args) {
    throw new Error("Expected streamText to be called");
  }

  return args;
}

function getStreamTextMessages(
  streamTextSpy: ReturnType<typeof mockStreamTextSuccess>
): ModelMessage[] {
  const { messages } = getStreamTextArgs(streamTextSpy);
  expect(messages).toBeDefined();
  if (!messages) {
    throw new Error("Expected streamText to receive messages");
  }

  return messages;
}

function getHandoffText(streamTextSpy: ReturnType<typeof mockStreamTextSuccess>): string {
  const handoffMessage = getStreamTextMessages(streamTextSpy).at(-1);
  expect(handoffMessage).toBeDefined();
  expect(handoffMessage?.role).toBe("user");
  if (handoffMessage?.role !== "user") {
    throw new Error("Expected a user handoff message");
  }

  expect(typeof handoffMessage.content).toBe("string");
  if (typeof handoffMessage.content !== "string") {
    throw new Error("Expected handoff content to be plain text");
  }

  return handoffMessage.content;
}

function extractLabeledBlock(handoffText: string, label: string): string {
  const marker = `**${label}:**\n`;
  const start = handoffText.indexOf(marker);
  expect(start).toBeGreaterThanOrEqual(0);
  const contentStart = start + marker.length;
  const nextSection = handoffText.indexOf("\n\n**", contentStart);
  return nextSection === -1
    ? handoffText.slice(contentStart)
    : handoffText.slice(contentStart, nextSection);
}

describe("advisor tool", () => {
  afterEach(() => {
    mock.restore();
  });

  it.each([
    { model: "openai:gpt-5.6", mode: "pro", effort: "high", expectedMode: "pro" },
    { model: "openai:gpt-5.6", mode: "pro", effort: "max", expectedMode: "pro" },
    { model: "openai:gpt-5.6", mode: "standard", effort: "high", expectedMode: undefined },
    { model: "openai:gpt-5.6", mode: undefined, effort: "high", expectedMode: undefined },
    { model: "openai:gpt-5.2", mode: "pro", effort: "high", expectedMode: undefined },
  ] as const)("forwards advisor mode independently of effort: %j", async (testCase) => {
    using tempDir = new TestTempDir("advisor-reasoning-mode");
    const { config } = createToolConfig(tempDir.path);
    const streamTextSpy = mockStreamTextSuccess({
      text: "Consider the tradeoff.",
      usage: { inputTokens: 10, outputTokens: 10, totalTokens: 20 },
    });
    const tool = createAdvisorTool({
      ...config,
      advisorRuntime: {
        ...config.advisorRuntime,
        advisorModelString: testCase.model,
        reasoningLevel: testCase.effort,
        reasoningMode: testCase.mode,
        createModel: () =>
          Promise.resolve({
            model: Object.create(null) as LanguageModel,
            optionsModelString: testCase.model,
            optionsProvidersConfig: null,
          }),
      },
    });
    await tool.execute!({}, mockToolCallOptions);
    expect(getStreamTextArgs(streamTextSpy).providerOptions?.openai?.reasoningMode).toBe(
      testCase.expectedMode
    );
    expect(getStreamTextArgs(streamTextSpy).providerOptions?.openai?.reasoningEffort).toBe(
      testCase.effort
    );
  });

  it.each([
    { modelOptions: { optionsRouteProvider: "coder" }, expectedMode: "pro" },
    { modelOptions: { optionsRouteProvider: "mux-gateway" }, expectedMode: undefined },
    {
      modelOptions: { optionsMuxProviderOptions: { openai: { wireFormat: "chatCompletions" } } },
      expectedMode: undefined,
    },
  ] as const)("gates advisor Pro by the effective route/wire: %j", async (testCase) => {
    using tempDir = new TestTempDir("advisor-reasoning-route");
    const { config } = createToolConfig(tempDir.path);
    const streamTextSpy = mockStreamTextSuccess({
      text: "Consider the tradeoff.",
      usage: { inputTokens: 10, outputTokens: 10, totalTokens: 20 },
    });
    const tool = createAdvisorTool({
      ...config,
      advisorRuntime: {
        ...config.advisorRuntime,
        advisorModelString: "openai:gpt-5.6",
        reasoningMode: "pro",
        createModel: () =>
          Promise.resolve({
            model: Object.create(null) as LanguageModel,
            optionsModelString: "openai:gpt-5.6",
            optionsProvidersConfig: null,
            ...testCase.modelOptions,
          }),
      },
    });
    await tool.execute!({}, mockToolCallOptions);
    expect(getStreamTextArgs(streamTextSpy).providerOptions?.openai?.reasoningMode).toBe(
      testCase.expectedMode
    );
  });

  it("reports model usage after a successful advisor call", async () => {
    using tempDir = new TestTempDir("advisor-tool-report-usage");
    const usage: LanguageModelV2Usage = {
      inputTokens: 120,
      cachedInputTokens: 10,
      outputTokens: 45,
      reasoningTokens: 5,
      totalTokens: 165,
    };
    const providerMetadata = {
      anthropic: { cacheCreationInputTokens: 6 },
    };
    const reportModelUsage = mock((_event: ToolModelUsageEvent) => undefined);
    const { config, createModel } = createToolConfig(tempDir.path, {
      reportModelUsage,
      metadataModel: "openai:pinned-pricing-model",
    });
    const streamTextSpy = mockStreamTextSuccess({
      text: "Focus on the highest-risk dependency edges first.",
      usage,
      providerMetadata,
    });

    const tool = createAdvisorTool(config);
    const rawResult: unknown = await Promise.resolve(tool.execute!({}, mockToolCallOptions));

    expect(createModel).toHaveBeenCalledWith(ADVISOR_MODEL);
    expect(streamTextSpy).toHaveBeenCalledTimes(1);
    expect(rawResult).toEqual({
      type: "advice",
      advice: "Focus on the highest-risk dependency edges first.",
      advisorModel: ADVISOR_MODEL,
      reasoningLevel: "medium",
      remainingUses: 2,
    });
    expect(reportModelUsage).toHaveBeenCalledWith(
      expect.objectContaining({
        source: "tool",
        toolName: "advisor",
        model: ADVISOR_MODEL,
        metadataModel: "openai:pinned-pricing-model",
        usage,
        providerMetadata,
        toolCallId: "test-call-id",
      })
    );

    const event = reportModelUsage.mock.calls[0]?.[0];
    expect(event?.toolName).toBe("advisor");
    expect(event?.model).toBe(ADVISOR_MODEL);
    expect(typeof event?.timestamp).toBe("number");
  });

  it("emits live advisor output chunks while preserving the final result", async () => {
    using tempDir = new TestTempDir("advisor-tool-live-output");
    const emitChatEvent = mock((_event: WorkspaceChatMessage) => undefined);
    const { config } = createToolConfig(tempDir.path, {
      emitChatEvent,
      workspaceId: "workspace-1",
    });
    mockStreamTextSuccess({
      text: "Start with the risky edge first.",
      chunks: [
        { type: "text", text: "Start " },
        { type: "text-delta", delta: "with " },
        { type: "text-delta", textDelta: "the risky edge first." },
        { type: "text-delta", text: "" },
        { type: "reasoning", text: "hidden reasoning" },
        { type: "reasoning-delta", delta: " plus delta" },
      ],
      usage: {
        inputTokens: 40,
        outputTokens: 15,
        totalTokens: 55,
      },
    });

    const tool = createAdvisorTool(config);
    const rawResult: unknown = await Promise.resolve(tool.execute!({}, mockToolCallOptions));

    expect(rawResult).toEqual({
      type: "advice",
      advice: "Start with the risky edge first.",
      advisorModel: ADVISOR_MODEL,
      reasoningLevel: "medium",
      remainingUses: 2,
    });
    expect(emitChatEvent).toHaveBeenCalledWith(
      expect.objectContaining({
        type: "advisor-output",
        workspaceId: "workspace-1",
        toolCallId: "test-call-id",
        text: "Start ",
      })
    );
    expect(emitChatEvent).toHaveBeenCalledWith(
      expect.objectContaining({ type: "advisor-output", text: "with " })
    );
    expect(emitChatEvent).toHaveBeenCalledWith(
      expect.objectContaining({ type: "advisor-output", text: "the risky edge first." })
    );
    expect(
      emitChatEvent.mock.calls
        .filter((call) => call[0].type === "advisor-output")
        .map((call) => call[0])
    ).toHaveLength(3);
    expect(emitChatEvent).toHaveBeenCalledWith(
      expect.objectContaining({
        type: "advisor-reasoning-output",
        workspaceId: "workspace-1",
        toolCallId: "test-call-id",
        text: "hidden reasoning",
      })
    );
    expect(emitChatEvent).toHaveBeenCalledWith(
      expect.objectContaining({
        type: "advisor-reasoning-output",
        workspaceId: "workspace-1",
        toolCallId: "test-call-id",
        text: " plus delta",
      })
    );
  });

  it("falls back to the raw transcript when there is no question or same-step snapshot", async () => {
    using tempDir = new TestTempDir("advisor-tool-transcript-fallback");
    const transcript = createTranscript();
    const { config } = createToolConfig(tempDir.path, { transcript, snapshot: undefined });
    const streamTextSpy = mockStreamTextSuccess({
      text: "Proceed with the existing plan.",
      usage: {
        inputTokens: 20,
        outputTokens: 10,
        totalTokens: 30,
      },
    });

    const tool = createAdvisorTool(config);
    await Promise.resolve(tool.execute!({}, mockToolCallOptions));

    expect(getStreamTextMessages(streamTextSpy)).toEqual(transcript);
  });

  it("flattens provider-executed tool parts from the transcript before calling the advisor model", async () => {
    using tempDir = new TestTempDir("advisor-tool-provider-executed-flatten");
    // Anthropic-shaped server tool use: providerExecuted tool-call + assistant
    // tool-result with a foreign srvtoolu_ id. Replaying these against a
    // different provider fails (OpenAI 404s on unknown item_references).
    const transcript: ModelMessage[] = [
      { role: "user", content: "research this" },
      {
        role: "assistant",
        content: [
          {
            type: "tool-call",
            toolCallId: "srvtoolu_013m4MqeeoVpBWdeyQvGkvqQ",
            toolName: "web_search",
            input: { query: "advisor cross-provider bug" },
            providerExecuted: true,
          },
          {
            type: "tool-result",
            toolCallId: "srvtoolu_013m4MqeeoVpBWdeyQvGkvqQ",
            toolName: "web_search",
            output: { type: "json", value: [{ url: "https://example.com/finding" }] },
          },
        ],
      },
    ];
    const { config } = createToolConfig(tempDir.path, { transcript, snapshot: undefined });
    const streamTextSpy = mockStreamTextSuccess({
      text: "Advice based on the web findings.",
      usage: { inputTokens: 30, outputTokens: 10, totalTokens: 40 },
    });

    const tool = createAdvisorTool(config);
    await Promise.resolve(
      tool.execute!({ question: "Challenge the findings" }, mockToolCallOptions)
    );

    const messages = getStreamTextMessages(streamTextSpy);
    // Handoff message is still appended last.
    expect(messages.at(-1)).toEqual({
      role: "user",
      content: "## Advisor Handoff\n\n**Question:** Challenge the findings",
    });

    const assistantMessage = messages[1];
    expect(assistantMessage?.role).toBe("assistant");
    if (assistantMessage?.role !== "assistant" || !Array.isArray(assistantMessage.content)) {
      throw new Error("Expected assistant message with array content");
    }
    // No tool parts survive; the web-search payload does, as text.
    expect(
      assistantMessage.content.every(
        (part) => part.type !== "tool-call" && part.type !== "tool-result"
      )
    ).toBe(true);
    const textParts = assistantMessage.content.filter((part) => part.type === "text");
    expect(textParts.some((part) => part.text.includes("https://example.com/finding"))).toBe(true);
  });

  it("appends a question-only advisor handoff when a normalized question is provided", async () => {
    using tempDir = new TestTempDir("advisor-tool-question-handoff");
    const question = "Should we split this refactor?";
    const { config, transcript } = createToolConfig(tempDir.path, { snapshot: undefined });
    const streamTextSpy = mockStreamTextSuccess({
      text: "Split the work if each piece can be reviewed independently.",
      usage: {
        inputTokens: 50,
        outputTokens: 20,
        totalTokens: 70,
      },
    });

    const tool = createAdvisorTool(config);
    await Promise.resolve(tool.execute!({ question: `  ${question}  ` }, mockToolCallOptions));

    expect(getStreamTextMessages(streamTextSpy)).toEqual([
      ...transcript,
      {
        role: "user",
        content: `## Advisor Handoff\n\n**Question:** ${question}`,
      },
    ]);
  });

  it("appends the full advisor handoff when question and same-step snapshot context exist", async () => {
    using tempDir = new TestTempDir("advisor-tool-full-handoff");
    const question = "What's the best approach for handling concurrent file writes?";
    const snapshot = createSnapshot({
      input: { question },
      stepText: "Visible commentary about the current step.",
      stepReasoning: "Internal reasoning about coordination and race conditions.",
    });
    const { config, transcript } = createToolConfig(tempDir.path, { snapshot });
    const streamTextSpy = mockStreamTextSuccess({
      text: "Use a write queue around the shared file handle.",
      usage: {
        inputTokens: 60,
        outputTokens: 25,
        totalTokens: 85,
      },
    });

    const tool = createAdvisorTool(config);
    await Promise.resolve(tool.execute!({ question }, mockToolCallOptions));

    expect(getStreamTextMessages(streamTextSpy)).toEqual([
      ...transcript,
      {
        role: "user",
        content:
          "## Advisor Handoff\n\n" +
          `**Question:** ${question}\n\n` +
          "**Current-step commentary:**\nVisible commentary about the current step.\n\n" +
          "**Current-step reasoning:**\nInternal reasoning about coordination and race conditions.",
      },
    ]);

    const handoffText = getHandoffText(streamTextSpy);
    expect(handoffText).not.toContain("**Pending tool call:**");
    expect(handoffText).not.toContain('advisor({"question":');
  });

  it("consumes the frozen snapshot exactly once for the current tool call", async () => {
    using tempDir = new TestTempDir("advisor-tool-snapshot-consumed");
    const { config, takeToolCallSnapshot } = createToolConfig(tempDir.path, {
      snapshot: createSnapshot(),
    });
    mockStreamTextSuccess({
      text: "Continue with the current architecture.",
      usage: {
        inputTokens: 25,
        outputTokens: 12,
        totalTokens: 37,
      },
    });

    const tool = createAdvisorTool(config);
    await Promise.resolve(tool.execute!({}, mockToolCallOptions));

    expect(takeToolCallSnapshot).toHaveBeenCalledTimes(1);
    expect(takeToolCallSnapshot).toHaveBeenCalledWith(mockToolCallOptions.toolCallId);
  });

  it("tail-truncates long same-step commentary and reasoning in the handoff", async () => {
    using tempDir = new TestTempDir("advisor-tool-handoff-truncation");
    const longStepText = `discard-text-${"a".repeat(ADVISOR_HANDOFF_MAX_TEXT_CHARS)}TAIL-TEXT`;
    const longStepReasoning = `discard-reasoning-${"b".repeat(ADVISOR_HANDOFF_MAX_REASONING_CHARS)}TAIL-REASONING`;
    const snapshot = createSnapshot({
      stepText: longStepText,
      stepReasoning: longStepReasoning,
    });
    const { config } = createToolConfig(tempDir.path, { snapshot });
    const streamTextSpy = mockStreamTextSuccess({
      text: "Prefer a deterministic queue.",
      usage: {
        inputTokens: 80,
        outputTokens: 18,
        totalTokens: 98,
      },
    });

    const tool = createAdvisorTool(config);
    await Promise.resolve(tool.execute!({}, mockToolCallOptions));

    const handoffText = getHandoffText(streamTextSpy);
    const truncatedStepText = extractLabeledBlock(handoffText, "Current-step commentary");
    const truncatedStepReasoning = extractLabeledBlock(handoffText, "Current-step reasoning");

    expect(truncatedStepText).toBe(
      `...${longStepText.slice(-(ADVISOR_HANDOFF_MAX_TEXT_CHARS - 3))}`
    );
    expect(truncatedStepText.length).toBe(ADVISOR_HANDOFF_MAX_TEXT_CHARS);
    expect(truncatedStepText).not.toContain("discard-text-");

    expect(truncatedStepReasoning).toBe(
      `...${longStepReasoning.slice(-(ADVISOR_HANDOFF_MAX_REASONING_CHARS - 3))}`
    );
    expect(truncatedStepReasoning.length).toBe(ADVISOR_HANDOFF_MAX_REASONING_CHARS);
    expect(truncatedStepReasoning).not.toContain("discard-reasoning-");
  });

  it("skips the handoff when the frozen snapshot has no visible same-step content", async () => {
    using tempDir = new TestTempDir("advisor-tool-empty-snapshot-fields");
    const transcript = createTranscript();
    const { config } = createToolConfig(tempDir.path, {
      transcript,
      snapshot: createSnapshot({ stepText: "", stepReasoning: "" }),
    });
    const streamTextSpy = mockStreamTextSuccess({
      text: "No extra context was needed.",
      usage: {
        inputTokens: 15,
        outputTokens: 7,
        totalTokens: 22,
      },
    });

    const tool = createAdvisorTool(config);
    await Promise.resolve(tool.execute!({}, mockToolCallOptions));

    expect(getStreamTextMessages(streamTextSpy)).toEqual(transcript);
  });

  it("passes maxOutputTokens to streamText when the advisor runtime is capped", async () => {
    using tempDir = new TestTempDir("advisor-tool-max-output-tokens-limited");
    const { config } = createToolConfig(tempDir.path, { maxOutputTokens: 1000 });
    const streamTextSpy = mockStreamTextSuccess({
      text: "Keep the recommendation concise.",
      usage: {
        inputTokens: 24,
        outputTokens: 12,
        totalTokens: 36,
      },
    });

    const tool = createAdvisorTool(config);
    await Promise.resolve(tool.execute!({}, mockToolCallOptions));

    expect(streamTextSpy).toHaveBeenCalledTimes(1);
    const streamTextArgs = streamTextSpy.mock.calls[0]?.[0];
    expect(streamTextArgs?.maxOutputTokens).toBe(1000);
  });

  it("omits maxOutputTokens from streamText when the advisor runtime is unlimited", async () => {
    using tempDir = new TestTempDir("advisor-tool-max-output-tokens-unlimited");
    const { config } = createToolConfig(tempDir.path, { maxOutputTokens: undefined });
    const streamTextSpy = mockStreamTextSuccess({
      text: "Return the full analysis.",
      usage: {
        inputTokens: 30,
        outputTokens: 18,
        totalTokens: 48,
      },
    });

    const tool = createAdvisorTool(config);
    await Promise.resolve(tool.execute!({}, mockToolCallOptions));

    expect(streamTextSpy).toHaveBeenCalledTimes(1);
    const streamTextArgs = streamTextSpy.mock.calls[0]?.[0] as Record<string, unknown> | undefined;
    expect(streamTextArgs?.maxOutputTokens).toBeUndefined();
    expect(Object.prototype.hasOwnProperty.call(streamTextArgs ?? {}, "maxOutputTokens")).toBe(
      false
    );
  });

  it("does not report usage when the advisor model call fails", async () => {
    using tempDir = new TestTempDir("advisor-tool-no-usage-on-error");
    const reportModelUsage = mock((_event: ToolModelUsageEvent) => undefined);
    const { config } = createToolConfig(tempDir.path, { reportModelUsage });
    mockStreamTextFailure(new Error("model unavailable"));

    const tool = createAdvisorTool(config);
    const rawResult: unknown = await Promise.resolve(tool.execute!({}, mockToolCallOptions));

    expect(rawResult).toEqual({
      type: "error",
      isError: true,
      message: "Advisor request failed: model unavailable",
    });
    expect(reportModelUsage).not.toHaveBeenCalled();
  });

  it("returns an error when streamText reports an error part", async () => {
    using tempDir = new TestTempDir("advisor-tool-stream-error-part");
    const reportModelUsage = mock((_event: ToolModelUsageEvent) => undefined);
    const { config } = createToolConfig(tempDir.path, { reportModelUsage });
    mockStreamTextSuccess({
      text: "partial advice",
      finishReason: "error",
      streamError: new Error("stream broke"),
      usage: {
        inputTokens: 12,
        outputTokens: 3,
        totalTokens: 15,
      },
    });

    const tool = createAdvisorTool(config);
    const rawResult: unknown = await Promise.resolve(tool.execute!({}, mockToolCallOptions));

    expect(rawResult).toEqual({
      type: "error",
      isError: true,
      message: "Advisor request failed: stream broke",
    });
    expect(reportModelUsage).not.toHaveBeenCalled();
  });

  it("sanitizes binary-like advisor provider failures", async () => {
    using tempDir = new TestTempDir("advisor-tool-sanitized-error");
    const { config } = createToolConfig(tempDir.path);
    mockStreamTextFailure(new Error("Invalid JSON response: \u001b\u0000\ufffdpayload"));

    const tool = createAdvisorTool(config);
    const rawResult: unknown = await Promise.resolve(tool.execute!({}, mockToolCallOptions));

    expect(typeof rawResult).toBe("object");
    expect(rawResult).not.toBeNull();
    const result = rawResult as { type?: unknown; isError?: unknown; message?: unknown };
    expect(result.type).toBe("error");
    expect(result.isError).toBe(true);
    expect(result.message).toEqual(expect.stringContaining("Advisor request failed:"));
    expect(result.message).toEqual(expect.stringContaining("nul=1"));
    expect(JSON.stringify(rawResult)).not.toContain("\u0000");
    expect(JSON.stringify(rawResult)).not.toContain("�");
  });

  it("swallows synchronous usage reporting failures and logs them", async () => {
    using tempDir = new TestTempDir("advisor-tool-report-failure");
    const usage: LanguageModelV2Usage = {
      inputTokens: 40,
      outputTokens: 10,
      totalTokens: 50,
    };
    const reportModelUsage = mock((_event: ToolModelUsageEvent) => {
      throw new Error("report callback failed");
    });
    const debugSpy = spyOn(log, "debug").mockImplementation(() => undefined);
    const { config } = createToolConfig(tempDir.path, { reportModelUsage });
    mockStreamTextSuccess({
      text: "Keep the implementation narrow.",
      usage,
    });

    const tool = createAdvisorTool(config);
    const rawResult: unknown = await Promise.resolve(tool.execute!({}, mockToolCallOptions));

    expect(rawResult).toEqual({
      type: "advice",
      advice: "Keep the implementation narrow.",
      advisorModel: ADVISOR_MODEL,
      reasoningLevel: "medium",
      remainingUses: 2,
    });
    expect(debugSpy).toHaveBeenCalledWith(
      "advisor: failed to report model usage",
      expect.objectContaining({ error: "report callback failed" })
    );
  });
});

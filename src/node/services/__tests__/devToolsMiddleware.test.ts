import { afterEach, beforeEach, describe, expect, it, spyOn } from "bun:test";
import * as fs from "fs/promises";
import * as os from "os";
import * as path from "path";
import type {
  LanguageModelV4,
  LanguageModelV4CallOptions,
  LanguageModelV4GenerateResult,
  LanguageModelV4Middleware,
  LanguageModelV4StreamPart,
  LanguageModelV4Usage,
} from "@ai-sdk/provider";
import { Config } from "@/node/config";
import { createDevToolsMiddleware, extractUsage } from "@/node/services/devToolsMiddleware";
import { DevToolsService } from "@/node/services/devToolsService";

function createTestConfig(opts: { sessionsDir: string; enabled?: boolean }): Config {
  const config = new Config(path.dirname(opts.sessionsDir));
  spyOn(config, "getLlmDebugLogsEnabled").mockImplementation(() => opts.enabled ?? true);
  return config;
}

function createMockModel(overrides: Partial<LanguageModelV4> = {}): LanguageModelV4 {
  return {
    specificationVersion: "v4",
    provider: "test-provider",
    modelId: "test-model",
    supportedUrls: {},
    doGenerate: () =>
      Promise.reject(new Error("createMockModel.doGenerate should not be called in tests")),
    doStream: () =>
      Promise.reject(new Error("createMockModel.doStream should not be called in tests")),
    ...overrides,
  };
}

function createMockParams(): LanguageModelV4CallOptions {
  return {
    prompt: [
      {
        role: "system",
        content: "Be concise",
      },
      {
        role: "user",
        content: [{ type: "text", text: "Hello middleware" }],
      },
    ],
    maxOutputTokens: 128,
    temperature: 0.7,
    toolChoice: { type: "auto" },
    providerOptions: {
      test: {
        debug: true,
      },
    },
  };
}

function createUsage(inputTokens: number, outputTokens: number): LanguageModelV4Usage {
  return {
    inputTokens: {
      total: inputTokens,
      noCache: inputTokens,
      cacheRead: 0,
      cacheWrite: 0,
    },
    outputTokens: {
      total: outputTokens,
      text: outputTokens,
      reasoning: 0,
    },
  };
}

function createGenerateResult(
  overrides: Partial<LanguageModelV4GenerateResult> = {}
): LanguageModelV4GenerateResult {
  return {
    content: [{ type: "text", text: "Hello" }],
    finishReason: { unified: "stop", raw: "stop" },
    usage: createUsage(10, 5),
    warnings: [],
    request: { body: "test-req" },
    response: { body: "test-resp" },
    ...overrides,
  };
}

function getWrapGenerate(middleware: LanguageModelV4Middleware) {
  if (!middleware.wrapGenerate) {
    throw new Error("Expected wrapGenerate to be defined");
  }

  return middleware.wrapGenerate;
}

function getWrapStream(middleware: LanguageModelV4Middleware) {
  if (!middleware.wrapStream) {
    throw new Error("Expected wrapStream to be defined");
  }

  return middleware.wrapStream;
}

async function collectStream(
  stream: ReadableStream<LanguageModelV4StreamPart>
): Promise<LanguageModelV4StreamPart[]> {
  const reader = stream.getReader();
  const chunks: LanguageModelV4StreamPart[] = [];

  for (;;) {
    const { done, value } = await reader.read();
    if (done) {
      break;
    }

    chunks.push(value);
  }

  return chunks;
}

describe("extractUsage", () => {
  it("preserves object-style token breakdowns", () => {
    const usage = extractUsage({
      inputTokens: {
        total: 8844,
        noCache: 8844,
        cacheRead: 0,
      },
      outputTokens: {
        total: 294,
        text: 26,
        reasoning: 268,
      },
    });

    expect(usage).toEqual({
      inputTokens: {
        total: 8844,
        noCache: 8844,
        cacheRead: 0,
        cacheWrite: undefined,
      },
      outputTokens: {
        total: 294,
        text: 26,
        reasoning: 268,
      },
      totalTokens: 9138,
    });
  });

  it("preserves raw provider usage", () => {
    const raw = {
      thoughtsTokenCount: 268,
      promptTokenCount: 8844,
      candidatesTokenCount: 26,
      totalTokenCount: 9138,
    };

    const usage = extractUsage({ raw });

    expect(usage).toEqual({
      inputTokens: undefined,
      outputTokens: undefined,
      totalTokens: undefined,
      raw,
    });
  });

  it("supports legacy numeric token fields", () => {
    expect(
      extractUsage({
        inputTokens: 120,
        outputTokens: 34,
      })
    ).toEqual({
      inputTokens: 120,
      outputTokens: 34,
      totalTokens: 154,
    });

    expect(
      extractUsage({
        promptTokens: 77,
        completionTokens: 9,
      })
    ).toEqual({
      inputTokens: 77,
      outputTokens: 9,
      totalTokens: 86,
    });
  });
});

describe("createDevToolsMiddleware", () => {
  let tempDir: string;
  let sessionsDir: string;

  beforeEach(async () => {
    tempDir = await fs.mkdtemp(path.join(os.tmpdir(), "mux-devtools-middleware-test-"));
    sessionsDir = path.join(tempDir, "sessions");
    await fs.mkdir(sessionsDir, { recursive: true });
  });

  afterEach(async () => {
    await fs.rm(tempDir, { recursive: true, force: true });
  });

  it("does not finalize existing in-progress steps when middleware is created", async () => {
    const service = new DevToolsService(createTestConfig({ sessionsDir, enabled: true }));

    await service.createRun("ws-1", {
      id: "run-1",
      workspaceId: "ws-1",
      startedAt: "2025-06-01T00:00:00Z",
    });
    await service.createStep("ws-1", {
      id: "step-1",
      runId: "run-1",
      stepNumber: 1,
      type: "generate",
      modelId: "test-model",
      provider: "test-provider",
      startedAt: "2025-06-01T00:00:00Z",
      durationMs: null,
      input: null,
      output: null,
      usage: null,
      error: null,
      rawRequest: null,
      requestHeaders: null,
      responseHeaders: null,
      rawResponse: null,
      rawChunks: null,
    });

    createDevToolsMiddleware("ws-1", service);
    await new Promise((resolve) => setTimeout(resolve, 50));

    const runWithSteps = await service.getRunWithSteps("ws-1", "run-1");
    expect(runWithSteps).not.toBeNull();

    const step = runWithSteps?.steps[0];
    expect(step?.durationMs).toBeNull();
    expect(step?.error).toBeNull();
  });

  describe("wrapGenerate", () => {
    it("records a run + step for successful generate calls", async () => {
      const service = new DevToolsService(createTestConfig({ sessionsDir, enabled: true }));
      const middleware = createDevToolsMiddleware("ws-1", service);
      const wrapGenerate = getWrapGenerate(middleware);
      const model = createMockModel();
      const params = createMockParams();
      const expectedResult = createGenerateResult({
        response: {
          body: "test-resp",
          headers: {
            "content-type": "application/json",
            "x-request-id": "abc",
          },
        },
      });

      const result = await wrapGenerate({
        doGenerate: () => Promise.resolve(expectedResult),
        doStream: () => Promise.reject(new Error("doStream should not be called")),
        params,
        model,
      });

      expect(result).toBe(expectedResult);

      const runs = await service.getRuns("ws-1");
      expect(runs).toHaveLength(1);
      expect(runs[0]).toMatchObject({
        workspaceId: "ws-1",
        stepCount: 1,
      });

      const runWithSteps = await service.getRunWithSteps("ws-1", runs[0].id);
      expect(runWithSteps).not.toBeNull();
      expect(runWithSteps?.steps).toHaveLength(1);

      const step = runWithSteps?.steps[0];
      expect(step).toBeDefined();
      expect(step?.type).toBe("generate");
      expect(step?.modelId).toBe("test-model");
      expect(step?.provider).toBe("test-provider");
      expect(step?.durationMs).not.toBeNull();
      expect(step?.durationMs).toBeGreaterThanOrEqual(0);
      expect(step?.input).toMatchObject({
        maxOutputTokens: 128,
        temperature: 0.7,
        toolChoice: { type: "auto" },
      });
      expect(step?.output).toEqual({
        content: expectedResult.content,
        finishReason: "stop",
        toolCalls: undefined,
      });
      expect(step?.usage).toEqual({
        inputTokens: {
          total: 10,
          noCache: 10,
          cacheRead: 0,
          cacheWrite: 0,
        },
        outputTokens: {
          total: 5,
          text: 5,
          reasoning: 0,
        },
        totalTokens: 15,
      });
      expect(step?.rawRequest).toEqual(expectedResult.request?.body);
      expect(step?.requestHeaders).toBeNull();
      expect(step?.responseHeaders).toEqual(expectedResult.response?.headers);
      expect(step?.rawResponse).toEqual(expectedResult.response?.body);
      expect(step?.rawChunks).toBeNull();
      expect(step?.error).toBeNull();
    });

    it("records error when doGenerate throws and rethrows", async () => {
      const service = new DevToolsService(createTestConfig({ sessionsDir, enabled: true }));
      const middleware = createDevToolsMiddleware("ws-1", service);
      const wrapGenerate = getWrapGenerate(middleware);
      const failure = new Error("generate failed");

      let thrownError: unknown;
      try {
        await wrapGenerate({
          doGenerate: () => Promise.reject(failure),
          doStream: () => Promise.reject(new Error("doStream should not be called")),
          params: createMockParams(),
          model: createMockModel(),
        });
      } catch (error) {
        thrownError = error;
      }

      expect(thrownError).toBe(failure);

      const runs = await service.getRuns("ws-1");
      expect(runs).toHaveLength(1);

      const runWithSteps = await service.getRunWithSteps("ws-1", runs[0].id);
      expect(runWithSteps).not.toBeNull();
      expect(runWithSteps?.steps).toHaveLength(1);

      const step = runWithSteps?.steps[0];
      expect(step?.error).toBe("generate failed");
      expect(step?.durationMs).not.toBeNull();
      expect(step?.durationMs).toBeGreaterThanOrEqual(0);
    });

    it("passes through result unmodified", async () => {
      const service = new DevToolsService(createTestConfig({ sessionsDir, enabled: true }));
      const middleware = createDevToolsMiddleware("ws-1", service);
      const wrapGenerate = getWrapGenerate(middleware);
      const expectedResult = createGenerateResult();

      const result = await wrapGenerate({
        doGenerate: () => Promise.resolve(expectedResult),
        doStream: () => Promise.reject(new Error("doStream should not be called")),
        params: createMockParams(),
        model: createMockModel(),
      });

      expect(result).toBe(expectedResult);
    });

    it("is a no-op when service is disabled", async () => {
      const service = new DevToolsService(createTestConfig({ sessionsDir, enabled: false }));
      const middleware = createDevToolsMiddleware("ws-1", service);
      const wrapGenerate = getWrapGenerate(middleware);
      const expectedResult = createGenerateResult();
      let callCount = 0;

      const result = await wrapGenerate({
        doGenerate: () => {
          callCount += 1;
          return Promise.resolve(expectedResult);
        },
        doStream: () => Promise.reject(new Error("doStream should not be called")),
        params: createMockParams(),
        model: createMockModel(),
      });

      expect(callCount).toBe(1);
      expect(result).toBe(expectedResult);
      expect(await service.getRuns("ws-1")).toEqual([]);
    });
  });

  describe("wrapStream", () => {
    it("records streamed output plus raw provider chunks on flush", async () => {
      const service = new DevToolsService(createTestConfig({ sessionsDir, enabled: true }));
      const middleware = createDevToolsMiddleware("ws-1", service);
      const wrapStream = getWrapStream(middleware);

      const rawChunkValue = {
        event: "response.output_text.delta",
        data: "world",
      };
      const chunks: LanguageModelV4StreamPart[] = [
        { type: "text-start", id: "t1" },
        { type: "text-delta", id: "t1", delta: "Hello " },
        { type: "raw", rawValue: rawChunkValue },
        { type: "text-delta", id: "t1", delta: "world" },
        { type: "text-end", id: "t1" },
        {
          type: "finish",
          finishReason: { unified: "stop", raw: "stop" },
          usage: createUsage(5, 2),
        },
      ];
      const expectedForwardedChunks = chunks.filter((chunk) => chunk.type !== "raw");

      const stream = new ReadableStream<LanguageModelV4StreamPart>({
        start(controller) {
          for (const chunk of chunks) {
            controller.enqueue(chunk);
          }
          controller.close();
        },
      });

      const result = await wrapStream({
        doGenerate: () => Promise.reject(new Error("doGenerate should not be called")),
        doStream: () =>
          Promise.resolve({
            stream,
            request: { body: "stream-req" },
            response: { headers: { "content-type": "text/event-stream" } },
          }),
        params: createMockParams(),
        model: createMockModel(),
      });

      const observedChunks = await collectStream(result.stream);
      expect(observedChunks).toEqual(expectedForwardedChunks);

      const runs = await service.getRuns("ws-1");
      expect(runs).toHaveLength(1);

      const runWithSteps = await service.getRunWithSteps("ws-1", runs[0].id);
      expect(runWithSteps).not.toBeNull();
      expect(runWithSteps?.steps).toHaveLength(1);

      const step = runWithSteps?.steps[0];
      expect(step?.type).toBe("stream");
      expect(step?.output).toEqual({
        textParts: [{ id: "t1", text: "Hello world" }],
        reasoningParts: [],
        toolCalls: [],
        finishReason: "stop",
      });
      expect(step?.usage).toEqual({
        inputTokens: {
          total: 5,
          noCache: 5,
          cacheRead: 0,
          cacheWrite: 0,
        },
        outputTokens: {
          total: 2,
          text: 2,
          reasoning: 0,
        },
        totalTokens: 7,
      });
      expect(step?.rawRequest).toEqual("stream-req");
      expect(step?.requestHeaders).toBeNull();
      expect(step?.responseHeaders).toEqual({ "content-type": "text/event-stream" });
      expect(step?.rawResponse).toEqual(expectedForwardedChunks);
      expect(step?.rawChunks).toEqual([rawChunkValue]);
      expect(step?.error).toBeNull();
    });

    it("does not forward raw chunks when includeRawChunks was not requested", async () => {
      const service = new DevToolsService(createTestConfig({ sessionsDir, enabled: true }));
      const middleware = createDevToolsMiddleware("ws-1", service);
      const wrapStream = getWrapStream(middleware);

      const rawValue = { event: "response.output_text.delta", data: "hidden" };
      const chunks: LanguageModelV4StreamPart[] = [
        { type: "raw", rawValue },
        {
          type: "finish",
          finishReason: { unified: "stop", raw: "stop" },
          usage: createUsage(1, 1),
        },
      ];

      const stream = new ReadableStream<LanguageModelV4StreamPart>({
        start(controller) {
          for (const chunk of chunks) {
            controller.enqueue(chunk);
          }
          controller.close();
        },
      });

      const params = createMockParams();
      const result = await wrapStream({
        doGenerate: () => Promise.reject(new Error("doGenerate should not be called")),
        doStream: () => Promise.resolve({ stream }),
        params,
        model: createMockModel(),
      });

      const observedChunks = await collectStream(result.stream);
      expect(observedChunks).toEqual([chunks[1]]);

      const runs = await service.getRuns("ws-1");
      const runWithSteps = await service.getRunWithSteps("ws-1", runs[0].id);
      expect(runWithSteps).not.toBeNull();
      expect(runWithSteps?.steps[0]?.rawChunks).toEqual([rawValue]);
    });

    it("forwards raw chunks when includeRawChunks was explicitly requested", async () => {
      const service = new DevToolsService(createTestConfig({ sessionsDir, enabled: true }));
      const middleware = createDevToolsMiddleware("ws-1", service);
      const wrapStream = getWrapStream(middleware);

      const rawValue = { event: "response.output_text.delta", data: "visible" };
      const chunks: LanguageModelV4StreamPart[] = [
        { type: "raw", rawValue },
        {
          type: "finish",
          finishReason: { unified: "stop", raw: "stop" },
          usage: createUsage(1, 1),
        },
      ];

      const stream = new ReadableStream<LanguageModelV4StreamPart>({
        start(controller) {
          for (const chunk of chunks) {
            controller.enqueue(chunk);
          }
          controller.close();
        },
      });

      const params = {
        ...createMockParams(),
        includeRawChunks: true,
      };

      const result = await wrapStream({
        doGenerate: () => Promise.reject(new Error("doGenerate should not be called")),
        doStream: () => Promise.resolve({ stream }),
        params,
        model: createMockModel(),
      });

      const observedChunks = await collectStream(result.stream);
      expect(observedChunks).toEqual(chunks);

      const runs = await service.getRuns("ws-1");
      const runWithSteps = await service.getRunWithSteps("ws-1", runs[0].id);
      expect(runWithSteps).not.toBeNull();
      expect(runWithSteps?.steps[0]?.rawChunks).toEqual([rawValue]);
    });

    it("records tool calls from stream chunks", async () => {
      const service = new DevToolsService(createTestConfig({ sessionsDir, enabled: true }));
      const middleware = createDevToolsMiddleware("ws-1", service);
      const wrapStream = getWrapStream(middleware);

      const chunks: LanguageModelV4StreamPart[] = [
        {
          type: "tool-call",
          toolCallId: "call-1",
          toolName: "weather",
          input: '{"city":"SF"}',
        },
        {
          type: "finish",
          finishReason: { unified: "tool-calls", raw: "tool-calls" },
          usage: createUsage(8, 3),
        },
      ];

      const stream = new ReadableStream<LanguageModelV4StreamPart>({
        start(controller) {
          for (const chunk of chunks) {
            controller.enqueue(chunk);
          }
          controller.close();
        },
      });

      const result = await wrapStream({
        doGenerate: () => Promise.reject(new Error("doGenerate should not be called")),
        doStream: () => Promise.resolve({ stream }),
        params: createMockParams(),
        model: createMockModel(),
      });

      await collectStream(result.stream);

      const runs = await service.getRuns("ws-1");
      const runWithSteps = await service.getRunWithSteps("ws-1", runs[0].id);
      expect(runWithSteps).not.toBeNull();

      const step = runWithSteps?.steps[0];
      expect(step?.output).toMatchObject({
        toolCalls: [
          {
            toolCallId: "call-1",
            toolName: "weather",
            args: '{"city":"SF"}',
          },
        ],
        finishReason: "tool-calls",
      });
    });

    it("records 'Request aborted' on stream cancel", async () => {
      const service = new DevToolsService(createTestConfig({ sessionsDir, enabled: true }));
      const middleware = createDevToolsMiddleware("ws-1", service);
      const wrapStream = getWrapStream(middleware);

      const neverEndingStream = new ReadableStream<LanguageModelV4StreamPart>({
        start(controller) {
          controller.enqueue({ type: "text-start", id: "t1" });
          controller.enqueue({ type: "text-delta", id: "t1", delta: "partial" });
        },
      });

      const result = await wrapStream({
        doGenerate: () => Promise.reject(new Error("doGenerate should not be called")),
        doStream: () => Promise.resolve({ stream: neverEndingStream }),
        params: createMockParams(),
        model: createMockModel(),
      });

      const reader = result.stream.getReader();
      await reader.read();
      await reader.cancel();
      await new Promise((resolve) => setTimeout(resolve, 50));

      const runs = await service.getRuns("ws-1");
      const runWithSteps = await service.getRunWithSteps("ws-1", runs[0].id);
      expect(runWithSteps).not.toBeNull();

      const step = runWithSteps?.steps[0];
      expect(step?.error).toBe("Request aborted");
      expect(step?.durationMs).not.toBeNull();
      expect(step?.output).toEqual({
        textParts: [{ id: "t1", text: "" }],
        reasoningParts: [],
        toolCalls: [],
        finishReason: undefined,
      });
    });

    it("finalizes step as aborted when AbortSignal fires during stream", async () => {
      const service = new DevToolsService(createTestConfig({ sessionsDir, enabled: true }));
      const middleware = createDevToolsMiddleware("ws-1", service);
      const wrapStream = getWrapStream(middleware);
      const abortController = new AbortController();

      const neverEndingStream = new ReadableStream<LanguageModelV4StreamPart>({
        start(controller) {
          controller.enqueue({ type: "text-start", id: "t1" });
          controller.enqueue({ type: "text-delta", id: "t1", delta: "partial" });
        },
      });

      const result = await wrapStream({
        doGenerate: () => Promise.reject(new Error("doGenerate should not be called")),
        doStream: () => Promise.resolve({ stream: neverEndingStream }),
        params: {
          ...createMockParams(),
          abortSignal: abortController.signal,
        },
        model: createMockModel(),
      });

      const reader = result.stream.getReader();
      await reader.read();

      abortController.abort();
      await new Promise((resolve) => setTimeout(resolve, 50));

      const runs = await service.getRuns("ws-1");
      const runWithSteps = await service.getRunWithSteps("ws-1", runs[0].id);
      expect(runWithSteps).not.toBeNull();

      const step = runWithSteps?.steps[0];
      expect(step?.error).toBe("Request aborted");
      expect(step?.durationMs).not.toBeNull();

      await reader.cancel();
    });

    it("does not double-finalize when abort fires after normal completion", async () => {
      const service = new DevToolsService(createTestConfig({ sessionsDir, enabled: true }));
      const middleware = createDevToolsMiddleware("ws-1", service);
      const wrapStream = getWrapStream(middleware);
      const abortController = new AbortController();

      const stream = new ReadableStream<LanguageModelV4StreamPart>({
        start(controller) {
          controller.enqueue({
            type: "finish",
            finishReason: { unified: "stop", raw: "stop" },
            usage: createUsage(1, 1),
          });
          controller.close();
        },
      });

      const result = await wrapStream({
        doGenerate: () => Promise.reject(new Error("doGenerate should not be called")),
        doStream: () => Promise.resolve({ stream }),
        params: {
          ...createMockParams(),
          abortSignal: abortController.signal,
        },
        model: createMockModel(),
      });

      await collectStream(result.stream);
      abortController.abort();
      await new Promise((resolve) => setTimeout(resolve, 50));

      const runs = await service.getRuns("ws-1");
      const runWithSteps = await service.getRunWithSteps("ws-1", runs[0].id);
      expect(runWithSteps).not.toBeNull();

      const step = runWithSteps?.steps[0];
      expect(step?.error).toBeNull();
    });

    it("multiple steps in one middleware instance share the same runId", async () => {
      const service = new DevToolsService(createTestConfig({ sessionsDir, enabled: true }));
      const middleware = createDevToolsMiddleware("ws-1", service);
      const wrapGenerate = getWrapGenerate(middleware);

      await wrapGenerate({
        doGenerate: () => Promise.resolve(createGenerateResult({ response: { body: "first" } })),
        doStream: () => Promise.reject(new Error("doStream should not be called")),
        params: createMockParams(),
        model: createMockModel(),
      });

      await wrapGenerate({
        doGenerate: () => Promise.resolve(createGenerateResult({ response: { body: "second" } })),
        doStream: () => Promise.reject(new Error("doStream should not be called")),
        params: createMockParams(),
        model: createMockModel(),
      });

      const runs = await service.getRuns("ws-1");
      expect(runs).toHaveLength(1);
      expect(runs[0]?.stepCount).toBe(2);

      const runWithSteps = await service.getRunWithSteps("ws-1", runs[0].id);
      expect(runWithSteps).not.toBeNull();
      expect(runWithSteps?.steps).toHaveLength(2);

      const [firstStep, secondStep] = runWithSteps?.steps ?? [];
      expect(firstStep?.runId).toBe(secondStep?.runId);
      expect(firstStep?.stepNumber).toBe(1);
      expect(secondStep?.stepNumber).toBe(2);
    });
  });
});

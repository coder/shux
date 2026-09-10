import * as http from "node:http";
import type { AddressInfo } from "node:net";

import { ProvidersConfigStore, type ProvidersConfig } from "@/node/config";
import type { WorkspaceChatMessage } from "@/common/orpc/types";
import { OPENAI_RESPONSES_BASE_URL_HINT } from "@/node/services/utils/openAIResponsesBaseUrlHint";
import { loadTokenizerModules } from "@/node/utils/main/tokenizer";
import {
  assertStreamSuccess,
  cleanupTempGitRepo,
  createStreamCollector,
  createTempGitRepo,
  createWorkspace,
  extractTextFromEvents,
  generateBranchName,
  sendMessageWithModel,
} from "../helpers";
import {
  cleanupTestEnvironment,
  createTestEnvironment,
  shouldRunIntegrationTests,
  type TestEnvironment,
} from "../setup";

const describeOpenAICompatible = shouldRunIntegrationTests() ? describe : describe.skip;
const MOCK_MODEL = "mock-model";

type MockRequestBody = Record<string, unknown> & {
  messages?: Array<{ role?: unknown; content?: unknown }>;
};

type MockHandler = (request: {
  path: string;
  body: MockRequestBody;
  headers: http.IncomingHttpHeaders;
  response: http.ServerResponse;
}) => void;

interface MockServer {
  origin: string;
  baseUrl: string;
  requests: Array<{
    path: string;
    body: MockRequestBody;
    headers: http.IncomingHttpHeaders;
  }>;
  errors: Error[];
  close: () => Promise<void>;
}

function writeCompletion(
  response: http.ServerResponse,
  chunks: Array<Record<string, unknown>>
): void {
  response.writeHead(200, {
    "Content-Type": "text/event-stream",
    "Cache-Control": "no-cache",
    Connection: "keep-alive",
  });
  for (const chunk of chunks) {
    response.write(`data: ${JSON.stringify(chunk)}\n\n`);
  }
  response.end("data: [DONE]\n\n");
}

function writeResponsesCompletion(response: http.ServerResponse, text: string): void {
  response.writeHead(200, {
    "Content-Type": "text/event-stream",
    "Cache-Control": "no-cache",
    Connection: "keep-alive",
  });
  // Minimal Responses SSE lifecycle: the SDK only emits text-start when the
  // message output item is announced, so the delta must be preceded by
  // response.output_item.added or the stream errors with a missing text part.
  const events: Array<Record<string, unknown>> = [
    {
      type: "response.created",
      response: { id: "resp-mock", created_at: 0, model: MOCK_MODEL },
    },
    {
      type: "response.output_item.added",
      output_index: 0,
      item: { type: "message", id: "msg-mock" },
    },
    {
      type: "response.output_text.delta",
      item_id: "msg-mock",
      output_index: 0,
      delta: text,
    },
    {
      type: "response.output_item.done",
      output_index: 0,
      item: { type: "message", id: "msg-mock" },
    },
    {
      type: "response.completed",
      response: {
        incomplete_details: null,
        usage: { input_tokens: 1, output_tokens: 2 },
      },
    },
  ];
  for (const event of events) {
    response.write(`data: ${JSON.stringify(event)}\n\n`);
  }
  response.end();
}

function writeAnthropicCompletion(response: http.ServerResponse, text: string): void {
  response.writeHead(200, {
    "Content-Type": "text/event-stream",
    "Cache-Control": "no-cache",
    Connection: "keep-alive",
  });
  const events = [
    {
      event: "message_start",
      data: {
        type: "message_start",
        message: {
          id: "msg-mock",
          model: MOCK_MODEL,
          role: "assistant",
          usage: { input_tokens: 1 },
          content: [],
          stop_reason: null,
        },
      },
    },
    {
      event: "content_block_start",
      data: {
        type: "content_block_start",
        index: 0,
        content_block: { type: "text", text: "" },
      },
    },
    {
      event: "content_block_delta",
      data: {
        type: "content_block_delta",
        index: 0,
        delta: { type: "text_delta", text },
      },
    },
    {
      event: "content_block_stop",
      data: { type: "content_block_stop", index: 0 },
    },
    {
      event: "message_delta",
      data: {
        type: "message_delta",
        delta: { stop_reason: "end_turn", stop_sequence: null },
        usage: { output_tokens: 2 },
      },
    },
    { event: "message_stop", data: { type: "message_stop" } },
  ];
  for (const event of events) {
    response.write(`event: ${event.event}\ndata: ${JSON.stringify(event.data)}\n\n`);
  }
  response.end();
}

function completionChunk(
  delta: Record<string, unknown>,
  finishReason: string | null = null
): Record<string, unknown> {
  return {
    id: "chatcmpl-mock",
    object: "chat.completion.chunk",
    created: 1,
    model: MOCK_MODEL,
    choices: [{ index: 0, delta, finish_reason: finishReason }],
  };
}

async function createMockServer(handlers: MockHandler[]): Promise<MockServer> {
  const requests: MockServer["requests"] = [];
  const errors: Error[] = [];
  const handlerQueue = [...handlers];

  const server = http.createServer((request, response) => {
    const bodyChunks: Buffer[] = [];
    request.on("data", (chunk: Buffer) => bodyChunks.push(chunk));
    request.on("end", () => {
      try {
        const body = JSON.parse(Buffer.concat(bodyChunks).toString("utf8")) as MockRequestBody;
        const received = { path: request.url ?? "", body, headers: request.headers };
        requests.push(received);

        if (request.method !== "POST") {
          response.writeHead(404).end();
          return;
        }

        const handler = handlerQueue.shift();
        if (!handler) {
          response.writeHead(404).end();
          return;
        }
        handler({ ...received, response });
      } catch (error) {
        errors.push(error instanceof Error ? error : new Error(String(error)));
        if (!response.headersSent) {
          response.writeHead(500, { "Content-Type": "application/json" });
        }
        response.end(JSON.stringify({ error: "mock handler failed" }));
      }
    });
  });

  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", resolve);
  });

  const address = server.address() as AddressInfo;
  const origin = `http://127.0.0.1:${address.port}`;
  return {
    origin,
    baseUrl: `${origin}/v1`,
    requests,
    errors,
    close: () =>
      new Promise<void>((resolve, reject) => {
        server.close((error) => (error ? reject(error) : resolve()));
      }),
  };
}

async function createConfiguredWorkspace(providersConfig: ProvidersConfig): Promise<{
  env: TestEnvironment;
  workspaceId: string;
  cleanup: () => Promise<void>;
}> {
  const tempGitRepo = await createTempGitRepo();
  const env = await createTestEnvironment();
  new ProvidersConfigStore(env.config.rootDir).saveProvidersConfig(providersConfig);

  const created = await createWorkspace(env, tempGitRepo, generateBranchName("openai-compatible"));
  if (!created.success) {
    await cleanupTestEnvironment(env);
    await cleanupTempGitRepo(tempGitRepo);
    throw new Error(`Workspace creation failed: ${created.error}`);
  }

  return {
    env,
    workspaceId: created.metadata.id,
    cleanup: async () => {
      await env.orpc.workspace.remove({
        workspaceId: created.metadata.id,
        options: { force: true },
      });
      await cleanupTestEnvironment(env);
      await cleanupTempGitRepo(tempGitRepo);
    },
  };
}

function getEventsOfType(events: WorkspaceChatMessage[], type: string): WorkspaceChatMessage[] {
  return events.filter((event) => event.type === type);
}

describeOpenAICompatible("custom OpenAI-compatible providers", () => {
  beforeAll(async () => {
    await loadTokenizerModules();
  }, 150000);

  test("streams simple chat through /v1/chat/completions", async () => {
    const mock = await createMockServer([
      ({ response }) => {
        writeCompletion(response, [
          completionChunk({ role: "assistant", content: "Hello " }),
          completionChunk({ content: "from local" }),
          completionChunk({}, "stop"),
        ]);
      },
    ]);
    const workspace = await createConfiguredWorkspace({
      "local-mock": {
        providerType: "openai-compatible",
        baseUrl: mock.origin,
        models: [MOCK_MODEL],
      },
    });
    const collector = createStreamCollector(workspace.env.orpc, workspace.workspaceId);
    collector.start();

    try {
      await collector.waitForSubscription();
      const result = await sendMessageWithModel(
        workspace.env,
        workspace.workspaceId,
        "Say hello",
        `local-mock:${MOCK_MODEL}`
      );
      expect(result.success).toBe(true);

      expect(await collector.waitForEvent("stream-end", 30000)).toBeDefined();
      assertStreamSuccess(collector);
      expect(extractTextFromEvents(collector.getDeltas())).toContain("Hello from local");
      expect(mock.requests).toHaveLength(1);
      expect(mock.requests[0]?.path).toBe("/v1/chat/completions");
      expect(mock.errors).toEqual([]);
    } finally {
      collector.stop();
      await workspace.cleanup();
      await mock.close();
    }
  }, 45000);

  test("rejects custom provider base URLs carrying a query string", async () => {
    // Every SDK adapter raw-appends endpoint paths onto the base URL
    // (`${baseURL}/messages`), so a query string would swallow the endpoint.
    // The IPC surface must reject it up front instead of misrouting requests.
    const env = await createTestEnvironment();
    try {
      const result = await env.orpc.providers.addCustomProvider({
        provider: "query-proxy",
        displayName: "Query Proxy",
        providerType: "anthropic-messages",
        baseUrl: "https://proxy.example/anthropic?token=x",
      });

      expect(result.success).toBe(false);
      if (!result.success) {
        expect(result.error.code).toBe("invalid_base_url");
        expect(result.error.message).toContain("query");
      }
      expect(await env.orpc.providers.list()).not.toContain("query-proxy");
    } finally {
      await cleanupTestEnvironment(env);
    }
  }, 30000);

  test("streams a custom OpenAI Responses provider through /v1/responses", async () => {
    const mock = await createMockServer([
      ({ response }) => writeResponsesCompletion(response, "Hello from responses"),
    ]);
    const previousApiKey = process.env.OPENAI_API_KEY;
    process.env.OPENAI_API_KEY = "must-not-leak";
    const workspace = await createConfiguredWorkspace({
      "local-responses": {
        providerType: "openai-responses",
        baseUrl: mock.origin,
        models: [MOCK_MODEL],
      },
    });
    const collector = createStreamCollector(workspace.env.orpc, workspace.workspaceId);
    collector.start();

    try {
      await collector.waitForSubscription();
      const result = await sendMessageWithModel(
        workspace.env,
        workspace.workspaceId,
        "Say hello",
        `local-responses:${MOCK_MODEL}`
      );
      expect(result.success).toBe(true);

      expect(await collector.waitForEvent("stream-end", 30000)).toBeDefined();
      assertStreamSuccess(collector);
      expect(extractTextFromEvents(collector.getDeltas())).toContain("Hello from responses");
      expect(mock.requests[0]?.path).toBe("/v1/responses");
      // Keyless provider: no env-key fallback AND no empty auth header.
      expect(mock.requests[0]?.headers.authorization).toBeUndefined();
      expect(mock.errors).toEqual([]);
    } finally {
      if (previousApiKey === undefined) {
        delete process.env.OPENAI_API_KEY;
      } else {
        process.env.OPENAI_API_KEY = previousApiKey;
      }
      collector.stop();
      await workspace.cleanup();
      await mock.close();
    }
  }, 45000);

  test("streams a custom Anthropic Messages provider through /v1/messages", async () => {
    const mock = await createMockServer([
      ({ response }) => writeAnthropicCompletion(response, "Hello from Anthropic"),
    ]);
    const previousApiKey = process.env.ANTHROPIC_API_KEY;
    process.env.ANTHROPIC_API_KEY = "must-not-leak";
    const workspace = await createConfiguredWorkspace({
      "local-anthropic": {
        providerType: "anthropic-messages",
        baseUrl: mock.origin,
        models: [MOCK_MODEL],
      },
    });
    const collector = createStreamCollector(workspace.env.orpc, workspace.workspaceId);
    collector.start();

    try {
      await collector.waitForSubscription();
      const result = await sendMessageWithModel(
        workspace.env,
        workspace.workspaceId,
        "Say hello",
        `local-anthropic:${MOCK_MODEL}`
      );
      expect(result.success).toBe(true);

      expect(await collector.waitForEvent("stream-end", 30000)).toBeDefined();
      assertStreamSuccess(collector);
      expect(extractTextFromEvents(collector.getDeltas())).toContain("Hello from Anthropic");
      expect(mock.requests[0]?.path).toBe("/v1/messages");
      // Keyless provider: no env-key fallback AND no empty auth header.
      expect(mock.requests[0]?.headers["x-api-key"]).toBeUndefined();
      expect(mock.errors).toEqual([]);
    } finally {
      if (previousApiKey === undefined) {
        delete process.env.ANTHROPIC_API_KEY;
      } else {
        process.env.ANTHROPIC_API_KEY = previousApiKey;
      }
      collector.stop();
      await workspace.cleanup();
      await mock.close();
    }
  }, 45000);

  test("guides built-in OpenAI users when a custom endpoint rejects Responses requests", async () => {
    const mock = await createMockServer([]);
    const workspace = await createConfiguredWorkspace({
      openai: {
        apiKey: "test-key",
        baseUrl: mock.baseUrl,
      },
    });
    const collector = createStreamCollector(workspace.env.orpc, workspace.workspaceId);
    collector.start();

    try {
      await collector.waitForSubscription();
      const result = await sendMessageWithModel(
        workspace.env,
        workspace.workspaceId,
        "Say hello",
        `openai:${MOCK_MODEL}`
      );
      expect(result.success).toBe(true);

      const errorEvent = await collector.waitForEvent("stream-error", 30000);
      if (!errorEvent || errorEvent.type !== "stream-error") {
        throw new Error("Expected a stream-error event");
      }
      expect(errorEvent.error).toContain(OPENAI_RESPONSES_BASE_URL_HINT);
      expect(mock.requests[0]?.path).toBe("/v1/responses");
      expect(mock.errors).toEqual([]);
    } finally {
      collector.stop();
      await workspace.cleanup();
      await mock.close();
    }
  }, 45000);

  test("guides built-in OpenAI users when the custom endpoint comes from OPENAI_BASE_URL", async () => {
    const mock = await createMockServer([]);
    const previousEnvBaseUrl = process.env.OPENAI_BASE_URL;
    process.env.OPENAI_BASE_URL = mock.baseUrl;
    const workspace = await createConfiguredWorkspace({
      openai: {
        apiKey: "test-key",
      },
    });
    const collector = createStreamCollector(workspace.env.orpc, workspace.workspaceId);
    collector.start();

    try {
      await collector.waitForSubscription();
      const result = await sendMessageWithModel(
        workspace.env,
        workspace.workspaceId,
        "Say hello",
        `openai:${MOCK_MODEL}`
      );
      expect(result.success).toBe(true);

      const errorEvent = await collector.waitForEvent("stream-error", 30000);
      if (!errorEvent || errorEvent.type !== "stream-error") {
        throw new Error("Expected a stream-error event");
      }
      expect(errorEvent.error).toContain(OPENAI_RESPONSES_BASE_URL_HINT);
      expect(mock.requests[0]?.path).toBe("/v1/responses");
      expect(mock.errors).toEqual([]);
    } finally {
      if (previousEnvBaseUrl === undefined) {
        delete process.env.OPENAI_BASE_URL;
      } else {
        process.env.OPENAI_BASE_URL = previousEnvBaseUrl;
      }
      collector.stop();
      await workspace.cleanup();
      await mock.close();
    }
  }, 45000);

  test("streams through the built-in OpenAI provider in chat completions mode", async () => {
    const mock = await createMockServer([
      ({ response }) => {
        writeCompletion(response, [
          completionChunk({ role: "assistant", content: "Built-in chat works" }),
          completionChunk({}, "stop"),
        ]);
      },
    ]);
    const workspace = await createConfiguredWorkspace({
      openai: {
        apiKey: "test-key",
        // Origin-only URL: the built-in provider must gain /v1 like custom
        // providers do, or following the hint to chatCompletions still fails.
        baseUrl: mock.origin,
        wireFormat: "chatCompletions",
      },
    });
    const collector = createStreamCollector(workspace.env.orpc, workspace.workspaceId);
    collector.start();

    try {
      await collector.waitForSubscription();
      const result = await sendMessageWithModel(
        workspace.env,
        workspace.workspaceId,
        "Say hello",
        `openai:${MOCK_MODEL}`
      );
      expect(result.success).toBe(true);

      expect(await collector.waitForEvent("stream-end", 30000)).toBeDefined();
      assertStreamSuccess(collector);
      expect(extractTextFromEvents(collector.getDeltas())).toContain("Built-in chat works");
      expect(mock.requests[0]?.path).toBe("/v1/chat/completions");
      expect(mock.errors).toEqual([]);
    } finally {
      collector.stop();
      await workspace.cleanup();
      await mock.close();
    }
  }, 45000);

  test("round-trips a real bash tool result into the next chat request", async () => {
    let toolResultRoundTripObserved = false;
    const mock = await createMockServer([
      ({ response }) => {
        writeCompletion(response, [
          completionChunk({
            role: "assistant",
            tool_calls: [
              {
                index: 0,
                id: "call-bash-1",
                type: "function",
                function: {
                  name: "bash",
                  arguments:
                    '{"script":"echo MAGIC_42_XYZ","timeout_secs":30,"display_name":"echo"}',
                },
              },
            ],
          }),
          completionChunk({}, "tool_calls"),
        ]);
      },
      ({ body, response }) => {
        const toolMessage = body.messages?.find((message) => message.role === "tool");
        if (!toolMessage || !JSON.stringify(toolMessage.content).includes("MAGIC_42_XYZ")) {
          throw new Error("Follow-up request did not include the bash tool result");
        }
        toolResultRoundTripObserved = true;
        writeCompletion(response, [
          completionChunk({ role: "assistant", content: "Tool result received" }),
          completionChunk({}, "stop"),
        ]);
      },
    ]);
    const workspace = await createConfiguredWorkspace({
      "local-tools": {
        providerType: "openai-compatible",
        baseUrl: mock.baseUrl,
        models: [MOCK_MODEL],
      },
    });
    const collector = createStreamCollector(workspace.env.orpc, workspace.workspaceId);
    collector.start();

    try {
      await collector.waitForSubscription();
      const result = await sendMessageWithModel(
        workspace.env,
        workspace.workspaceId,
        "Run the requested command",
        `local-tools:${MOCK_MODEL}`
      );
      expect(result.success).toBe(true);

      const streamEnd = await collector.waitForEvent("stream-end", 30000);
      expect(streamEnd).toBeDefined();
      assertStreamSuccess(collector);

      const events = collector.getEvents();
      expect(
        getEventsOfType(events, "tool-call-start").some(
          (event) => "toolName" in event && event.toolName === "bash"
        )
      ).toBe(true);
      expect(
        getEventsOfType(events, "tool-call-end").some(
          (event) => "toolName" in event && event.toolName === "bash"
        )
      ).toBe(true);
      expect(toolResultRoundTripObserved).toBe(true);
      expect(mock.requests).toHaveLength(2);
      const finalStreamEnd = getEventsOfType(events, "stream-end").at(-1);
      expect(
        finalStreamEnd?.type === "stream-end" ? finalStreamEnd.metadata.finishReason : undefined
      ).toBe("stop");
      expect(mock.errors).toEqual([]);
    } finally {
      collector.stop();
      await workspace.cleanup();
      await mock.close();
    }
  }, 45000);

  test("keeps simultaneous custom providers isolated", async () => {
    const firstMock = await createMockServer([
      ({ response }) => {
        writeCompletion(response, [
          completionChunk({ role: "assistant", content: "first response" }),
          completionChunk({}, "stop"),
        ]);
      },
    ]);
    const secondMock = await createMockServer([
      ({ response }) => {
        writeCompletion(response, [
          completionChunk({ role: "assistant", content: "second response" }),
          completionChunk({}, "stop"),
        ]);
      },
    ]);
    const workspace = await createConfiguredWorkspace({
      "first-local": {
        providerType: "openai-compatible",
        baseUrl: firstMock.baseUrl,
        models: [MOCK_MODEL],
      },
      "second-local": {
        providerType: "openai-compatible",
        baseUrl: secondMock.baseUrl,
        models: [MOCK_MODEL],
      },
    });
    const tempGitRepo = await createTempGitRepo();
    const secondWorkspace = await createWorkspace(
      workspace.env,
      tempGitRepo,
      generateBranchName("second-openai-compatible")
    );
    if (!secondWorkspace.success) {
      await cleanupTempGitRepo(tempGitRepo);
      await workspace.cleanup();
      await firstMock.close();
      await secondMock.close();
      throw new Error(`Second workspace creation failed: ${secondWorkspace.error}`);
    }

    const firstCollector = createStreamCollector(workspace.env.orpc, workspace.workspaceId);
    const secondCollector = createStreamCollector(workspace.env.orpc, secondWorkspace.metadata.id);
    firstCollector.start();
    secondCollector.start();

    try {
      expect(await workspace.env.orpc.providers.list()).toEqual(
        expect.arrayContaining(["first-local", "second-local"])
      );
      const providersConfig = await workspace.env.orpc.providers.getConfig();
      expect(providersConfig["first-local"]?.models).toEqual([MOCK_MODEL]);
      expect(providersConfig["second-local"]?.models).toEqual([MOCK_MODEL]);
      await Promise.all([
        firstCollector.waitForSubscription(),
        secondCollector.waitForSubscription(),
      ]);

      const [firstResult, secondResult] = await Promise.all([
        sendMessageWithModel(
          workspace.env,
          workspace.workspaceId,
          "First request",
          `first-local:${MOCK_MODEL}`
        ),
        sendMessageWithModel(
          workspace.env,
          secondWorkspace.metadata.id,
          "Second request",
          `second-local:${MOCK_MODEL}`
        ),
      ]);
      expect(firstResult.success).toBe(true);
      expect(secondResult.success).toBe(true);

      await Promise.all([
        firstCollector.waitForEvent("stream-end", 30000),
        secondCollector.waitForEvent("stream-end", 30000),
      ]);
      assertStreamSuccess(firstCollector);
      assertStreamSuccess(secondCollector);
      expect(extractTextFromEvents(firstCollector.getDeltas())).toContain("first response");
      expect(extractTextFromEvents(secondCollector.getDeltas())).toContain("second response");
      expect(firstMock.requests).toHaveLength(1);
      expect(secondMock.requests).toHaveLength(1);
      expect(firstMock.errors).toEqual([]);
      expect(secondMock.errors).toEqual([]);
    } finally {
      firstCollector.stop();
      secondCollector.stop();
      await workspace.env.orpc.workspace.remove({
        workspaceId: secondWorkspace.metadata.id,
        options: { force: true },
      });
      await cleanupTempGitRepo(tempGitRepo);
      await workspace.cleanup();
      await firstMock.close();
      await secondMock.close();
    }
  }, 60000);
});

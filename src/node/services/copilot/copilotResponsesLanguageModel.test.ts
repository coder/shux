import { afterEach, describe, expect, it } from "bun:test";
import type { LanguageModelV2CallOptions, LanguageModelV2StreamPart } from "@ai-sdk/provider";
import { CopilotResponsesLanguageModel } from "./copilotResponsesLanguageModel";

function mockFetch(handler: (url: string, init: RequestInit) => Promise<Response>) {
  const originalFetch = globalThis.fetch;
  Object.defineProperty(globalThis, "fetch", {
    value: Object.assign(handler, {
      preconnect: () => {
        // no-op
      },
    }) as typeof globalThis.fetch,
    configurable: true,
    writable: true,
  });
  return () => {
    Object.defineProperty(globalThis, "fetch", {
      value: originalFetch,
      configurable: true,
      writable: true,
    });
  };
}

function createJsonResponse(body: unknown, status = 200) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json" },
  });
}

function createSseResponse(events: Array<{ event: string; data: unknown }>) {
  const encoder = new TextEncoder();
  const payload = events
    .map(
      ({ event, data }) =>
        `event: ${event}\ndata: ${typeof data === "string" ? data : JSON.stringify(data)}\n\n`
    )
    .join("");

  return new Response(encoder.encode(payload), {
    status: 200,
    headers: { "content-type": "text/event-stream" },
  });
}

function createChunkedSseResponse(chunks: string[]) {
  const encoder = new TextEncoder();
  return new Response(
    new ReadableStream<Uint8Array>({
      start(controller) {
        for (const chunk of chunks) {
          controller.enqueue(encoder.encode(chunk));
        }
        controller.close();
      },
    }),
    {
      status: 200,
      headers: { "content-type": "text/event-stream" },
    }
  );
}

async function collectStreamParts(stream: ReadableStream<LanguageModelV2StreamPart>) {
  const reader = stream.getReader();
  const parts: LanguageModelV2StreamPart[] = [];

  for (;;) {
    const { done, value } = await reader.read();
    if (done) {
      return parts;
    }

    parts.push(value);
  }
}

function createModel() {
  return new CopilotResponsesLanguageModel({
    modelId: "copilot-test",
    fetch: globalThis.fetch,
    baseUrl: "https://example.test",
  });
}

function getJsonBody(init: RequestInit) {
  if (typeof init.body !== "string") {
    throw new Error("Expected JSON string request body");
  }

  return JSON.parse(init.body) as Record<string, unknown>;
}

function createCompletedResponse(finishReason: string) {
  return {
    id: "resp_123",
    created_at: 1_710_000_000,
    model: "copilot-test",
    finish_reason: finishReason,
    output: [
      {
        type: "message",
        role: "assistant",
        content: [{ type: "output_text", text: "Hello from Copilot" }],
      },
    ],
    usage: {
      input_tokens: 11,
      output_tokens: 7,
      total_tokens: 18,
    },
  };
}

describe("CopilotResponsesLanguageModel", () => {
  const restoreFetchers: Array<() => void> = [];

  afterEach(() => {
    while (restoreFetchers.length > 0) {
      restoreFetchers.pop()?.();
    }
  });

  it("rejects an invalid service tier before sending a request", async () => {
    let requests = 0;
    const model = new CopilotResponsesLanguageModel({
      modelId: "gpt-5.4",
      fetch: Object.assign(() => {
        requests++;
        return Promise.resolve(createJsonResponse({}));
      }, globalThis.fetch),
    });
    const options: LanguageModelV2CallOptions = {
      prompt: [{ role: "user", content: [{ type: "text", text: "hello" }] }],
      providerOptions: { "github-copilot": { serviceTier: "invalid" } },
    };
    // eslint-disable-next-line @typescript-eslint/await-thenable -- Bun mistypes rejection matchers.
    await expect(model.doGenerate(options)).rejects.toThrow();
    // eslint-disable-next-line @typescript-eslint/await-thenable -- Bun mistypes rejection matchers.
    await expect(model.doStream(options)).rejects.toThrow();
    expect(requests).toBe(0);
  });

  it.each(["auto", "default", "flex", "priority", undefined] as const)(
    "serializes service tier %s for generate and stream independently of reasoning",
    async (serviceTier) => {
      const capturedBodies: Array<Record<string, unknown>> = [];
      const response = createCompletedResponse("stop");
      const model = new CopilotResponsesLanguageModel({
        modelId: "copilot-test",
        fetch: Object.assign(
          (_url: RequestInfo | URL, init?: RequestInit) => {
            if (!init) {
              throw new Error("Expected request init");
            }
            const body = getJsonBody(init);
            capturedBodies.push(body);
            return Promise.resolve(
              body.stream
                ? createSseResponse([
                    { event: "response.completed", data: { type: "response.completed", response } },
                  ])
                : createJsonResponse(response)
            );
          },
          { preconnect: globalThis.fetch.preconnect.bind(globalThis.fetch) }
        ),
      });
      for (const reasoningEffort of [undefined, "medium"] as const) {
        const options: LanguageModelV2CallOptions = {
          prompt: [{ role: "user", content: [{ type: "text", text: "hello" }] }],
          providerOptions: {
            "github-copilot": {
              ...(serviceTier && { serviceTier }),
              ...(reasoningEffort && { reasoningEffort }),
            },
            // Other namespaces must never supply a fallback tier.
            openai: { serviceTier: "priority" },
            anthropic: { serviceTier: "priority" },
            google: { serviceTier: "priority" },
          },
        };
        await model.doGenerate(options);
        const result = await model.doStream(options);
        await collectStreamParts(result.stream);
      }
      expect(capturedBodies).toHaveLength(4);
      for (const body of capturedBodies) {
        expect(body.service_tier).toBe(serviceTier);
        expect(body).not.toHaveProperty("serviceTier");
        if (serviceTier === undefined) {
          expect(body).not.toHaveProperty("service_tier");
        }
      }
      expect(capturedBodies[0]).not.toHaveProperty("reasoning");
      expect(capturedBodies[1]).not.toHaveProperty("reasoning");
      expect(capturedBodies[2].reasoning).toEqual({ effort: "medium" });
      expect(capturedBodies[3].reasoning).toEqual({ effort: "medium" });
    }
  );

  it("shapes the outbound request body for streaming calls", async () => {
    let capturedBody: Record<string, unknown> | undefined;
    restoreFetchers.push(
      mockFetch((url, init) => {
        expect(url).toBe("https://example.test/responses");
        expect(init.method).toBe("POST");
        capturedBody = getJsonBody(init);
        return Promise.resolve(
          createSseResponse([
            {
              event: "response.completed",
              data: {
                type: "response.completed",
                response: {
                  finish_reason: "stop",
                  usage: { input_tokens: 1, output_tokens: 1, total_tokens: 2 },
                },
              },
            },
          ])
        );
      })
    );

    const model = createModel();
    const streamResult = await model.doStream({
      prompt: [
        { role: "system", content: "Be concise" },
        { role: "user", content: [{ type: "text", text: "hello" }] },
        {
          role: "assistant",
          content: [
            { type: "text", text: "previous answer" },
            { type: "tool-call", toolCallId: "call_1", toolName: "lookup", input: { q: "hello" } },
          ],
        },
        {
          role: "tool",
          content: [
            {
              type: "tool-result",
              toolCallId: "call_1",
              toolName: "lookup",
              output: { type: "json", value: { answer: 42 } },
            },
          ],
        },
      ],
      tools: [
        {
          type: "function",
          name: "lookup",
          description: "Look up a value",
          inputSchema: {
            type: "object",
            properties: { q: { type: "string" } },
            required: ["q"],
          },
        },
      ],
      toolChoice: { type: "tool", toolName: "lookup" },
      temperature: 0.2,
      topP: 0.8,
      maxOutputTokens: 64,
      providerOptions: {
        "github-copilot": {
          reasoningEffort: "medium",
        },
      },
    } satisfies LanguageModelV2CallOptions);

    await collectStreamParts(streamResult.stream);

    expect(capturedBody).toEqual({
      model: "copilot-test",
      stream: true,
      instructions: "Be concise",
      input: [
        {
          role: "user",
          content: [{ type: "input_text", text: "hello" }],
        },
        {
          role: "assistant",
          content: [{ type: "output_text", text: "previous answer" }],
        },
        {
          type: "function_call",
          call_id: "call_1",
          name: "lookup",
          arguments: JSON.stringify({ q: "hello" }),
        },
        {
          type: "function_call_output",
          call_id: "call_1",
          output: JSON.stringify({ answer: 42 }),
        },
      ],
      tools: [
        {
          type: "function",
          name: "lookup",
          description: "Look up a value",
          parameters: {
            type: "object",
            properties: { q: { type: "string" } },
            required: ["q"],
          },
        },
      ],
      tool_choice: { type: "function", name: "lookup" },
      temperature: 0.2,
      top_p: 0.8,
      max_output_tokens: 64,
      reasoning: { effort: "medium" },
    });
    expect(capturedBody).not.toHaveProperty("store");
  });

  it("returns generated text, finish reason, usage, and metadata for doGenerate", async () => {
    restoreFetchers.push(
      mockFetch(() => Promise.resolve(createJsonResponse(createCompletedResponse("stop"))))
    );

    const model = createModel();
    const result = await model.doGenerate({
      prompt: [{ role: "user", content: [{ type: "text", text: "Hello" }] }],
    });

    expect(result.content).toEqual([{ type: "text", text: "Hello from Copilot" }]);
    expect(result.finishReason).toBe("stop");
    expect(result.usage).toEqual({
      inputTokens: 11,
      outputTokens: 7,
      totalTokens: 18,
      reasoningTokens: undefined,
      cachedInputTokens: undefined,
    });
    expect(result.warnings).toEqual([]);
    expect(result.response).toEqual({
      id: "resp_123",
      modelId: "copilot-test",
      timestamp: new Date(1_710_000_000 * 1000),
      headers: { "content-type": "application/json" },
      body: createCompletedResponse("stop"),
    });
  });

  it("streams response metadata, text parts, and finish usage", async () => {
    restoreFetchers.push(
      mockFetch(() =>
        Promise.resolve(
          createSseResponse([
            {
              event: "response.created",
              data: {
                type: "response.created",
                response: {
                  id: "resp_stream",
                  created_at: 1_710_000_010,
                  model: "copilot-test",
                },
              },
            },
            {
              event: "response.output_item.added",
              data: {
                type: "response.output_item.added",
                output_index: 0,
                content_index: 0,
                item: { type: "message", id: "msg_1" },
              },
            },
            {
              event: "response.output_text.delta",
              data: {
                type: "response.output_text.delta",
                output_index: 0,
                content_index: 0,
                item_id: "msg_1",
                delta: "Hello ",
              },
            },
            {
              event: "response.output_text.delta",
              data: {
                type: "response.output_text.delta",
                output_index: 0,
                content_index: 0,
                item_id: "msg_1",
                delta: "world",
              },
            },
            {
              event: "response.output_text.done",
              data: {
                type: "response.output_text.done",
                output_index: 0,
                content_index: 0,
                item_id: "msg_1",
                text: "Hello world",
              },
            },
            {
              event: "response.completed",
              data: {
                type: "response.completed",
                response: {
                  finish_reason: "stop",
                  usage: { input_tokens: 3, output_tokens: 2, total_tokens: 5 },
                },
              },
            },
          ])
        )
      )
    );

    const model = createModel();
    const result = await model.doStream({
      prompt: [{ role: "user", content: [{ type: "text", text: "Stream please" }] }],
    });
    const parts = await collectStreamParts(result.stream);

    expect(parts.map((part) => part.type)).toEqual([
      "stream-start",
      "response-metadata",
      "text-start",
      "text-delta",
      "text-delta",
      "text-end",
      "finish",
    ]);
    expect(parts[1]).toEqual({
      type: "response-metadata",
      id: "resp_stream",
      modelId: "copilot-test",
      timestamp: new Date(1_710_000_010 * 1000),
    });
    expect(parts[2]).toEqual({ type: "text-start", id: "text-0-0" });
    expect(parts[3]).toEqual({ type: "text-delta", id: "text-0-0", delta: "Hello " });
    expect(parts[4]).toEqual({ type: "text-delta", id: "text-0-0", delta: "world" });
    expect(parts[5]).toEqual({ type: "text-end", id: "text-0-0" });
    expect(parts[6]).toEqual({
      type: "finish",
      finishReason: "stop",
      usage: {
        inputTokens: 3,
        outputTokens: 2,
        totalTokens: 5,
        reasoningTokens: undefined,
        cachedInputTokens: undefined,
      },
    });
  });

  it("emits an error when the SSE stream closes before a terminal event", async () => {
    restoreFetchers.push(
      mockFetch(() =>
        Promise.resolve(
          createSseResponse([
            {
              event: "response.output_item.added",
              data: {
                type: "response.output_item.added",
                output_index: 0,
                content_index: 0,
                item: { type: "message", id: "msg_1" },
              },
            },
            {
              event: "response.output_text.delta",
              data: {
                type: "response.output_text.delta",
                output_index: 0,
                content_index: 0,
                item_id: "msg_1",
                delta: "partial",
              },
            },
          ])
        )
      )
    );

    const model = createModel();
    const result = await model.doStream({
      prompt: [{ role: "user", content: [{ type: "text", text: "Stream please" }] }],
    });
    const parts = await collectStreamParts(result.stream);

    expect(parts.map((part) => part.type)).toEqual([
      "stream-start",
      "text-start",
      "text-delta",
      "error",
    ]);
    const errorPart = parts.find(
      (part): part is Extract<LanguageModelV2StreamPart, { type: "error" }> => part.type === "error"
    );
    expect(errorPart?.error).toBeInstanceOf(Error);
    expect(errorPart?.error instanceof Error ? errorPart.error.message : "").toContain(
      "stream closed before terminal event"
    );
  });

  it("treats response.incomplete as a terminal finish event", async () => {
    restoreFetchers.push(
      mockFetch(() =>
        Promise.resolve(
          createSseResponse([
            {
              event: "response.incomplete",
              data: {
                type: "response.incomplete",
                response: {
                  incomplete_details: { reason: "max_output_tokens" },
                  usage: { input_tokens: 3, output_tokens: 2, total_tokens: 5 },
                },
              },
            },
          ])
        )
      )
    );

    const model = createModel();
    const result = await model.doStream({
      prompt: [{ role: "user", content: [{ type: "text", text: "Stream please" }] }],
    });
    const parts = await collectStreamParts(result.stream);

    expect(parts).toEqual([
      { type: "stream-start", warnings: [] },
      {
        type: "finish",
        finishReason: "length",
        usage: {
          inputTokens: 3,
          outputTokens: 2,
          totalTokens: 5,
          reasoningTokens: undefined,
          cachedInputTokens: undefined,
        },
      },
    ]);
  });

  it("uses a stable synthetic text id even when item_id rotates", async () => {
    restoreFetchers.push(
      mockFetch(() =>
        Promise.resolve(
          createSseResponse([
            {
              event: "response.output_item.added",
              data: {
                type: "response.output_item.added",
                output_index: 2,
                content_index: 7,
                item: { type: "message", id: "msg_added" },
              },
            },
            {
              event: "response.output_text.delta",
              data: {
                type: "response.output_text.delta",
                output_index: 2,
                content_index: 7,
                item_id: "msg_delta_1",
                delta: "A",
              },
            },
            {
              event: "response.output_text.delta",
              data: {
                type: "response.output_text.delta",
                output_index: 2,
                content_index: 7,
                item_id: "msg_delta_2",
                delta: "B",
              },
            },
            {
              event: "response.output_text.done",
              data: {
                type: "response.output_text.done",
                output_index: 2,
                content_index: 7,
                item_id: "msg_done",
                text: "AB",
              },
            },
            {
              event: "response.completed",
              data: {
                type: "response.completed",
                response: {
                  finish_reason: "stop",
                  usage: { input_tokens: 1, output_tokens: 2, total_tokens: 3 },
                },
              },
            },
          ])
        )
      )
    );

    const model = createModel();
    const result = await model.doStream({
      prompt: [{ role: "user", content: [{ type: "text", text: "id stability" }] }],
    });
    const parts = await collectStreamParts(result.stream);
    const textIds = parts
      .filter((part): part is Extract<LanguageModelV2StreamPart, { id: string }> => "id" in part)
      .map((part) => part.id);

    expect(textIds).toEqual(["text-2-7", "text-2-7", "text-2-7", "text-2-7"]);
  });

  it("maps finish reasons in a table-driven way", async () => {
    const cases = [
      ["stop", "stop"],
      ["max_tokens", "length"],
      ["content_filter", "content-filter"],
      ["tool_calls", "tool-calls"],
      ["unexpected_reason", "other"],
    ] as const;

    for (const [rawReason, expectedReason] of cases) {
      restoreFetchers.push(
        mockFetch(() => Promise.resolve(createJsonResponse(createCompletedResponse(rawReason))))
      );

      const model = createModel();
      const result = await model.doGenerate({
        prompt: [{ role: "user", content: [{ type: "text", text: rawReason }] }],
      });

      expect(result.finishReason).toBe(expectedReason);
      restoreFetchers.pop()?.();
    }
  });

  it("moves string system prompts into the instructions field", async () => {
    let capturedBody: Record<string, unknown> | undefined;
    restoreFetchers.push(
      mockFetch((_url, init) => {
        capturedBody = getJsonBody(init);
        return Promise.resolve(createJsonResponse(createCompletedResponse("stop")));
      })
    );

    const model = createModel();
    await model.doGenerate({
      prompt: [
        { role: "system", content: "Follow the house style" },
        { role: "user", content: [{ type: "text", text: "Hi" }] },
      ],
    });

    expect(capturedBody?.instructions).toBe("Follow the house style");
    expect(capturedBody?.input).toEqual([
      {
        role: "user",
        content: [{ type: "input_text", text: "Hi" }],
      },
    ]);
  });

  it("preserves complex system content as a developer input item", async () => {
    let capturedBody: Record<string, unknown> | undefined;
    restoreFetchers.push(
      mockFetch((_url, init) => {
        capturedBody = getJsonBody(init);
        return Promise.resolve(createJsonResponse(createCompletedResponse("stop")));
      })
    );

    const model = createModel();
    const structuredSystemPrompt = {
      role: "system",
      content: [{ type: "input_text", text: "Structured system prompt" }],
    };
    await model.doGenerate({
      prompt: [
        structuredSystemPrompt as never,
        { role: "user", content: [{ type: "text", text: "Hi" }] },
      ],
    } as LanguageModelV2CallOptions);

    expect(capturedBody?.instructions).toBeUndefined();
    expect(capturedBody?.input).toEqual([
      {
        role: "developer",
        content: [{ type: "input_text", text: "Structured system prompt" }],
      },
      {
        role: "user",
        content: [{ type: "input_text", text: "Hi" }],
      },
    ]);
  });

  it("emits raw chunks when includeRawChunks is true", async () => {
    const events = [
      {
        event: "response.created",
        data: {
          type: "response.created",
          response: { id: "resp_raw", created_at: 1_710_000_020, model: "copilot-test" },
        },
      },
      {
        event: "response.output_item.added",
        data: {
          type: "response.output_item.added",
          output_index: 0,
          item: { type: "message", id: "msg_raw" },
        },
      },
      {
        event: "response.output_text.delta",
        data: {
          type: "response.output_text.delta",
          output_index: 0,
          content_index: 0,
          item_id: "msg_raw",
          delta: "raw text",
        },
      },
      {
        event: "response.completed",
        data: {
          type: "response.completed",
          response: { finish_reason: "stop", usage: { input_tokens: 1, output_tokens: 1 } },
        },
      },
    ];
    restoreFetchers.push(mockFetch(() => Promise.resolve(createSseResponse(events))));

    const model = createModel();
    const result = await model.doStream({
      prompt: [{ role: "user", content: [{ type: "text", text: "Raw chunks" }] }],
      includeRawChunks: true,
    });
    const parts = await collectStreamParts(result.stream);
    const rawParts = parts.filter(
      (part): part is Extract<LanguageModelV2StreamPart, { type: "raw" }> => part.type === "raw"
    );

    expect(rawParts).toEqual(
      events.map((entry) => ({ type: "raw", rawValue: { event: entry.event, data: entry.data } }))
    );
    expect(parts.some((part) => part.type === "finish")).toBe(true);
  });

  it("parses SSE events that are split across byte chunks", async () => {
    restoreFetchers.push(
      mockFetch(() =>
        Promise.resolve(
          createChunkedSseResponse([
            "event: response.created\nda",
            'ta: {"type":"response.created","response":{"id":"resp_split","created_at":1710000030,"model":"copilot-test"}}\n\n',
            'event: response.output_item.added\ndata: {"type":"response.output_item.added","output_index":0,"item":{"type":"message","id":"msg_split"}}\n\n',
            'event: response.output_text.delta\ndata: {"type":"response.output_text.delta","output_index":0,"content_index":0,"item_id":"msg_split","delta":"split ',
            'text"}\n\n',
            'event: response.output_text.done\ndata: {"type":"response.output_text.done","output_index":0,"content_index":0,"item_id":"msg_split","text":"split text"}\n\n',
            'event: response.completed\ndata: {"type":"response.completed","response":{"finish_reason":"stop","usage":{"input_tokens":1,"output_tokens":2,"total_tokens":3}}}\n\n',
          ])
        )
      )
    );

    const model = createModel();
    const result = await model.doStream({
      prompt: [{ role: "user", content: [{ type: "text", text: "split parser" }] }],
    });
    const parts = await collectStreamParts(result.stream);

    expect(parts.find((part) => part.type === "response-metadata")).toEqual({
      type: "response-metadata",
      id: "resp_split",
      modelId: "copilot-test",
      timestamp: new Date(1_710_000_030 * 1000),
    });
    expect(
      parts
        .filter(
          (part): part is Extract<LanguageModelV2StreamPart, { type: "text-delta" }> =>
            part.type === "text-delta"
        )
        .map((part) => part.delta)
        .join("")
    ).toBe("split text");
    expect(parts.at(-1)).toEqual({
      type: "finish",
      finishReason: "stop",
      usage: {
        inputTokens: 1,
        outputTokens: 2,
        totalTokens: 3,
        reasoningTokens: undefined,
        cachedInputTokens: undefined,
      },
    });
  });

  it("emits an error part and closes cleanly on malformed JSON", async () => {
    restoreFetchers.push(
      mockFetch(() =>
        Promise.resolve(
          createChunkedSseResponse([
            'event: response.created\ndata: {"type":"response.created","response":{"id":"resp_bad","created_at":1710000040,"model":"copilot-test"}}\n\n',
            'event: response.output_text.delta\ndata: {"type":"response.output_text.delta","output_index":0,\n\n',
            'event: response.completed\ndata: {"type":"response.completed","response":{"finish_reason":"stop","usage":{"input_tokens":1,"output_tokens":1,"total_tokens":2}}}\n\n',
          ])
        )
      )
    );

    const model = createModel();
    const result = await model.doStream({
      prompt: [{ role: "user", content: [{ type: "text", text: "bad parser" }] }],
    });
    const parts = await collectStreamParts(result.stream);

    expect(parts.map((part) => part.type)).toEqual(["stream-start", "response-metadata", "error"]);
    expect(parts[2].type).toBe("error");
  });

  it("maps function-call SSE events to tool stream parts", async () => {
    restoreFetchers.push(
      mockFetch(() =>
        Promise.resolve(
          createSseResponse([
            {
              event: "response.created",
              data: {
                type: "response.created",
                response: { id: "resp_tool", created_at: 1_710_000_050, model: "copilot-test" },
              },
            },
            {
              event: "response.output_item.added",
              data: {
                type: "response.output_item.added",
                output_index: 0,
                item: {
                  type: "function_call",
                  id: "fc_1",
                  call_id: "call_1",
                  name: "get_weather",
                },
              },
            },
            {
              event: "response.function_call_arguments.delta",
              data: {
                type: "response.function_call_arguments.delta",
                output_index: 0,
                item_id: "fc_1",
                delta: '{"city":',
              },
            },
            {
              event: "response.function_call_arguments.delta",
              data: {
                type: "response.function_call_arguments.delta",
                output_index: 0,
                item_id: "fc_1",
                delta: '"Berlin"}',
              },
            },
            {
              event: "response.function_call_arguments.done",
              data: {
                type: "response.function_call_arguments.done",
                output_index: 0,
                item_id: "fc_1",
                arguments: '{"city":"Berlin"}',
              },
            },
            {
              event: "response.output_item.done",
              data: {
                type: "response.output_item.done",
                output_index: 0,
                item: {
                  type: "function_call",
                  id: "fc_1",
                  call_id: "call_1",
                  name: "get_weather",
                  arguments: '{"city":"Berlin"}',
                },
              },
            },
            {
              event: "response.completed",
              data: {
                type: "response.completed",
                response: { usage: { input_tokens: 5, output_tokens: 9, total_tokens: 14 } },
              },
            },
          ])
        )
      )
    );

    const model = createModel();
    const result = await model.doStream({
      prompt: [{ role: "user", content: [{ type: "text", text: "weather?" }] }],
    });
    const parts = await collectStreamParts(result.stream);

    // The done events (arguments.done + output_item.done) must finalize once:
    // exactly one tool-input-end and one tool-call.
    expect(parts.map((part) => part.type)).toEqual([
      "stream-start",
      "response-metadata",
      "tool-input-start",
      "tool-input-delta",
      "tool-input-delta",
      "tool-input-end",
      "tool-call",
      "finish",
    ]);
    expect(parts[2]).toEqual({ type: "tool-input-start", id: "call_1", toolName: "get_weather" });
    expect(parts[3]).toEqual({ type: "tool-input-delta", id: "call_1", delta: '{"city":' });
    expect(parts[4]).toEqual({ type: "tool-input-delta", id: "call_1", delta: '"Berlin"}' });
    expect(parts[5]).toEqual({ type: "tool-input-end", id: "call_1" });
    expect(parts[6]).toEqual({
      type: "tool-call",
      toolCallId: "call_1",
      toolName: "get_weather",
      input: '{"city":"Berlin"}',
    });
    expect(parts.at(-1)).toMatchObject({ type: "finish", finishReason: "tool-calls" });
  });

  it("interleaves text and tool-call parts from a mixed stream", async () => {
    restoreFetchers.push(
      mockFetch(() =>
        Promise.resolve(
          createSseResponse([
            {
              event: "response.created",
              data: {
                type: "response.created",
                response: { id: "resp_mixed", created_at: 1_710_000_060, model: "copilot-test" },
              },
            },
            {
              event: "response.output_item.added",
              data: {
                type: "response.output_item.added",
                output_index: 0,
                item: { type: "message", id: "msg_1" },
              },
            },
            {
              event: "response.output_text.delta",
              data: {
                type: "response.output_text.delta",
                output_index: 0,
                content_index: 0,
                item_id: "msg_1",
                delta: "Checking the weather.",
              },
            },
            {
              event: "response.output_text.done",
              data: {
                type: "response.output_text.done",
                output_index: 0,
                content_index: 0,
                item_id: "msg_1",
              },
            },
            {
              event: "response.output_item.added",
              data: {
                type: "response.output_item.added",
                output_index: 1,
                item: {
                  type: "function_call",
                  id: "fc_2",
                  call_id: "call_2",
                  name: "get_weather",
                },
              },
            },
            {
              event: "response.function_call_arguments.delta",
              data: {
                type: "response.function_call_arguments.delta",
                output_index: 1,
                item_id: "fc_2",
                delta: '{"city":"Paris"}',
              },
            },
            {
              event: "response.function_call_arguments.done",
              data: {
                type: "response.function_call_arguments.done",
                output_index: 1,
                item_id: "fc_2",
                arguments: '{"city":"Paris"}',
              },
            },
            {
              event: "response.completed",
              data: {
                type: "response.completed",
                response: { usage: { input_tokens: 4, output_tokens: 6, total_tokens: 10 } },
              },
            },
          ])
        )
      )
    );

    const model = createModel();
    const result = await model.doStream({
      prompt: [{ role: "user", content: [{ type: "text", text: "weather?" }] }],
    });
    const parts = await collectStreamParts(result.stream);

    expect(parts.map((part) => part.type)).toEqual([
      "stream-start",
      "response-metadata",
      "text-start",
      "text-delta",
      "text-end",
      "tool-input-start",
      "tool-input-delta",
      "tool-input-end",
      "tool-call",
      "finish",
    ]);
    expect(parts[3]).toEqual({
      type: "text-delta",
      id: "text-0-0",
      delta: "Checking the weather.",
    });
    expect(parts[8]).toEqual({
      type: "tool-call",
      toolCallId: "call_2",
      toolName: "get_weather",
      input: '{"city":"Paris"}',
    });
    expect(parts.at(-1)).toMatchObject({ type: "finish", finishReason: "tool-calls" });
  });

  it("routes interleaved argument deltas to the correct tool call", async () => {
    restoreFetchers.push(
      mockFetch(() =>
        Promise.resolve(
          createSseResponse([
            {
              event: "response.created",
              data: {
                type: "response.created",
                response: { id: "resp_multi", created_at: 1_710_000_070, model: "copilot-test" },
              },
            },
            {
              event: "response.output_item.added",
              data: {
                type: "response.output_item.added",
                output_index: 0,
                item: { type: "function_call", id: "fc_a", call_id: "call_a", name: "lookup_user" },
              },
            },
            {
              event: "response.output_item.added",
              data: {
                type: "response.output_item.added",
                output_index: 1,
                item: { type: "function_call", id: "fc_b", call_id: "call_b", name: "lookup_org" },
              },
            },
            {
              event: "response.function_call_arguments.delta",
              data: {
                type: "response.function_call_arguments.delta",
                output_index: 0,
                item_id: "fc_a",
                delta: '{"id":',
              },
            },
            {
              event: "response.function_call_arguments.delta",
              data: {
                type: "response.function_call_arguments.delta",
                output_index: 1,
                item_id: "fc_b",
                delta: '{"org":',
              },
            },
            {
              event: "response.function_call_arguments.delta",
              data: {
                type: "response.function_call_arguments.delta",
                output_index: 0,
                item_id: "fc_a",
                delta: "7}",
              },
            },
            {
              event: "response.function_call_arguments.delta",
              data: {
                type: "response.function_call_arguments.delta",
                output_index: 1,
                item_id: "fc_b",
                delta: '"acme"}',
              },
            },
            {
              event: "response.function_call_arguments.done",
              data: {
                type: "response.function_call_arguments.done",
                output_index: 0,
                item_id: "fc_a",
                arguments: '{"id":7}',
              },
            },
            {
              event: "response.function_call_arguments.done",
              data: {
                type: "response.function_call_arguments.done",
                output_index: 1,
                item_id: "fc_b",
                arguments: '{"org":"acme"}',
              },
            },
            {
              event: "response.completed",
              data: {
                type: "response.completed",
                response: { usage: { input_tokens: 3, output_tokens: 8, total_tokens: 11 } },
              },
            },
          ])
        )
      )
    );

    const model = createModel();
    const result = await model.doStream({
      prompt: [{ role: "user", content: [{ type: "text", text: "who?" }] }],
    });
    const parts = await collectStreamParts(result.stream);

    const deltas = parts.filter(
      (part): part is Extract<LanguageModelV2StreamPart, { type: "tool-input-delta" }> =>
        part.type === "tool-input-delta"
    );
    expect(deltas.map((part) => ({ id: part.id, delta: part.delta }))).toEqual([
      { id: "call_a", delta: '{"id":' },
      { id: "call_b", delta: '{"org":' },
      { id: "call_a", delta: "7}" },
      { id: "call_b", delta: '"acme"}' },
    ]);

    const toolCalls = parts.filter(
      (part): part is Extract<LanguageModelV2StreamPart, { type: "tool-call" }> =>
        part.type === "tool-call"
    );
    expect(toolCalls).toEqual([
      { type: "tool-call", toolCallId: "call_a", toolName: "lookup_user", input: '{"id":7}' },
      { type: "tool-call", toolCallId: "call_b", toolName: "lookup_org", input: '{"org":"acme"}' },
    ]);
    expect(parts.at(-1)).toMatchObject({ type: "finish", finishReason: "tool-calls" });
  });

  it("falls back to accumulated argument deltas when the done event omits arguments", async () => {
    restoreFetchers.push(
      mockFetch(() =>
        Promise.resolve(
          createSseResponse([
            {
              event: "response.created",
              data: {
                type: "response.created",
                response: { id: "resp_acc", created_at: 1_710_000_080, model: "copilot-test" },
              },
            },
            {
              event: "response.output_item.added",
              data: {
                type: "response.output_item.added",
                output_index: 0,
                item: { type: "function_call", id: "fc_3", call_id: "call_3", name: "run_query" },
              },
            },
            {
              event: "response.function_call_arguments.delta",
              data: {
                type: "response.function_call_arguments.delta",
                output_index: 0,
                item_id: "fc_3",
                delta: '{"q":"a"}',
              },
            },
            {
              event: "response.function_call_arguments.done",
              data: {
                type: "response.function_call_arguments.done",
                output_index: 0,
                item_id: "fc_3",
              },
            },
            {
              event: "response.completed",
              data: {
                type: "response.completed",
                response: { usage: { input_tokens: 2, output_tokens: 3, total_tokens: 5 } },
              },
            },
          ])
        )
      )
    );

    const model = createModel();
    const result = await model.doStream({
      prompt: [{ role: "user", content: [{ type: "text", text: "query" }] }],
    });
    const parts = await collectStreamParts(result.stream);

    expect(parts.map((part) => part.type)).toEqual([
      "stream-start",
      "response-metadata",
      "tool-input-start",
      "tool-input-delta",
      "tool-input-end",
      "tool-call",
      "finish",
    ]);
    expect(parts[5]).toEqual({
      type: "tool-call",
      toolCallId: "call_3",
      toolName: "run_query",
      input: '{"q":"a"}',
    });
  });

  it("emits a full tool lifecycle for a done-only function_call stream", async () => {
    restoreFetchers.push(
      mockFetch(() =>
        Promise.resolve(
          createSseResponse([
            {
              event: "response.created",
              data: {
                type: "response.created",
                response: { id: "resp_done", created_at: 1_710_000_085, model: "copilot-test" },
              },
            },
            {
              event: "response.output_item.done",
              data: {
                type: "response.output_item.done",
                output_index: 0,
                item: {
                  type: "function_call",
                  id: "fc_4",
                  call_id: "call_4",
                  name: "get_time",
                  arguments: '{"tz":"UTC"}',
                },
              },
            },
            {
              event: "response.completed",
              data: {
                type: "response.completed",
                response: { usage: { input_tokens: 2, output_tokens: 2, total_tokens: 4 } },
              },
            },
          ])
        )
      )
    );

    const model = createModel();
    const result = await model.doStream({
      prompt: [{ role: "user", content: [{ type: "text", text: "time?" }] }],
    });
    const parts = await collectStreamParts(result.stream);

    expect(parts.map((part) => part.type)).toEqual([
      "stream-start",
      "response-metadata",
      "tool-input-start",
      "tool-input-end",
      "tool-call",
      "finish",
    ]);
    expect(parts[2]).toEqual({ type: "tool-input-start", id: "call_4", toolName: "get_time" });
    expect(parts[4]).toEqual({
      type: "tool-call",
      toolCallId: "call_4",
      toolName: "get_time",
      input: '{"tz":"UTC"}',
    });
  });

  it("keeps the non-tool finish mapping when no function call was seen", async () => {
    restoreFetchers.push(
      mockFetch(() =>
        Promise.resolve(
          createSseResponse([
            {
              event: "response.created",
              data: {
                type: "response.created",
                response: { id: "resp_plain", created_at: 1_710_000_090, model: "copilot-test" },
              },
            },
            {
              event: "response.completed",
              data: {
                type: "response.completed",
                response: { usage: { input_tokens: 1, output_tokens: 1, total_tokens: 2 } },
              },
            },
          ])
        )
      )
    );

    const model = createModel();
    const result = await model.doStream({
      prompt: [{ role: "user", content: [{ type: "text", text: "plain" }] }],
    });
    const parts = await collectStreamParts(result.stream);

    expect(parts.at(-1)).toMatchObject({ type: "finish", finishReason: "other" });
  });

  it("returns tool-call content for function_call output items in doGenerate", async () => {
    restoreFetchers.push(
      mockFetch(() =>
        Promise.resolve(
          createJsonResponse({
            id: "resp_gen",
            created_at: 1_710_000_100,
            model: "copilot-test",
            output: [
              {
                type: "message",
                role: "assistant",
                content: [{ type: "output_text", text: "Looking that up." }],
              },
              {
                type: "function_call",
                id: "fc_gen",
                call_id: "call_gen",
                name: "get_weather",
                arguments: '{"city":"Oslo"}',
              },
            ],
            usage: { input_tokens: 6, output_tokens: 4, total_tokens: 10 },
          })
        )
      )
    );

    const model = createModel();
    const result = await model.doGenerate({
      prompt: [{ role: "user", content: [{ type: "text", text: "weather?" }] }],
    });

    expect(result.content).toEqual([
      { type: "text", text: "Looking that up." },
      {
        type: "tool-call",
        toolCallId: "call_gen",
        toolName: "get_weather",
        input: '{"city":"Oslo"}',
      },
    ]);
    expect(result.finishReason).toBe("tool-calls");
  });
});

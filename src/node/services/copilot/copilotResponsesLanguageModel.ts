import type {
  LanguageModelV2,
  LanguageModelV2CallOptions,
  LanguageModelV2Content,
  LanguageModelV2FinishReason,
  LanguageModelV2FunctionTool,
  LanguageModelV2StreamPart,
  LanguageModelV2ToolResultOutput,
  LanguageModelV2Usage,
} from "@ai-sdk/provider";

import { ServiceTierSchema } from "@/common/config/schemas/providersConfig";

export interface CopilotResponsesConfig {
  modelId: string;
  fetch: typeof globalThis.fetch;
  baseUrl?: string;
}

type JsonRecord = Record<string, unknown>;

const DEFAULT_BASE_URL = "https://api.githubcopilot.com";

export class CopilotResponsesLanguageModel implements LanguageModelV2 {
  readonly specificationVersion = "v2" as const;
  readonly provider = "github-copilot.responses";
  readonly modelId: string;
  readonly supportedUrls = {};

  private readonly fetchFn: typeof globalThis.fetch;
  private readonly baseUrl: string;

  constructor(config: CopilotResponsesConfig) {
    this.modelId = config.modelId;
    this.fetchFn = config.fetch;
    this.baseUrl = config.baseUrl ?? DEFAULT_BASE_URL;
  }

  async doGenerate(options: LanguageModelV2CallOptions) {
    const body = buildRequestBody(this.modelId, options, false);
    const response = await this.post(body, options);
    const responseBody = (await response.json()) as JsonRecord;

    const content = extractContent(responseBody);

    return {
      content,
      finishReason: mapFinishReason(
        getRawFinishReason(responseBody),
        content.some((part) => part.type === "tool-call")
      ),
      usage: mapUsage(responseBody.usage),
      warnings: [],
      request: { body },
      response: {
        id: getString(responseBody.id),
        modelId: getString(responseBody.model),
        timestamp: toDate(responseBody.created_at),
        headers: headersToRecord(response.headers),
        body: responseBody,
      },
    };
  }

  async doStream(options: LanguageModelV2CallOptions) {
    const body = buildRequestBody(this.modelId, options, true);
    const response = await this.post(body, options);
    if (response.body == null) {
      throw new Error("Copilot Responses API returned no response body for streaming request");
    }

    const headers = headersToRecord(response.headers);
    const source = response.body;

    return {
      stream: new ReadableStream<LanguageModelV2StreamPart>({
        start(controller) {
          controller.enqueue({ type: "stream-start", warnings: [] });

          return consumeSseStream(source, options.includeRawChunks === true, controller);
        },
      }),
      request: { body },
      response: { headers },
    };
  }

  private async post(body: JsonRecord, options: LanguageModelV2CallOptions) {
    const response = await this.fetchFn(`${this.baseUrl}/responses`, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        ...options.headers,
      },
      body: JSON.stringify(body),
      signal: options.abortSignal,
    });

    if (response.ok) {
      return response;
    }

    const responseText = await response.text().catch(() => "");
    const snippet = responseText.replace(/\s+/g, " ").trim().slice(0, 200);
    throw new Error(
      `Copilot Responses API request failed with status ${response.status}: ${snippet || response.statusText}`
    );
  }
}

function buildRequestBody(modelId: string, options: LanguageModelV2CallOptions, stream: boolean) {
  // Fast mode uses the same gateway option as Chat, but Responses sends snake_case.
  const serviceTier = ServiceTierSchema.optional().parse(
    options.providerOptions?.["github-copilot"]?.serviceTier
  );
  const instructions: string[] = [];
  const input: unknown[] = [];

  for (const message of options.prompt) {
    switch (message.role) {
      case "system":
        if (typeof message.content === "string") {
          instructions.push(message.content);
        } else {
          input.push({ role: "developer", content: message.content });
        }
        break;
      case "user":
        input.push({ role: "user", content: message.content.map(mapUserContentPart) });
        break;
      case "assistant": {
        const textParts = message.content
          .filter(
            (part): part is Extract<(typeof message.content)[number], { type: "text" }> =>
              part.type === "text"
          )
          .map((part) => ({ type: "output_text", text: part.text }));
        if (textParts.length > 0) {
          input.push({ role: "assistant", content: textParts });
        }

        for (const part of message.content) {
          if (part.type === "tool-call") {
            input.push({
              type: "function_call",
              call_id: part.toolCallId,
              name: part.toolName,
              arguments: JSON.stringify(part.input),
            });
          }
          if (part.type === "tool-result") {
            input.push({
              type: "function_call_output",
              call_id: part.toolCallId,
              output: serializeToolResultOutput(part.output),
            });
          }
        }
        break;
      }
      case "tool":
        for (const part of message.content) {
          input.push({
            type: "function_call_output",
            call_id: part.toolCallId,
            output: serializeToolResultOutput(part.output),
          });
        }
        break;
    }
  }

  return {
    model: modelId,
    stream,
    ...(serviceTier != null ? { service_tier: serviceTier } : {}),
    ...(instructions.length > 0 ? { instructions: instructions.join("\n\n") } : {}),
    ...(input.length > 0 ? { input } : {}),
    ...(options.tools ? { tools: options.tools.flatMap(mapToolDefinition) } : {}),
    ...(options.toolChoice ? { tool_choice: mapToolChoice(options.toolChoice) } : {}),
    ...(options.temperature !== undefined ? { temperature: options.temperature } : {}),
    ...(options.topP !== undefined ? { top_p: options.topP } : {}),
    ...(options.maxOutputTokens !== undefined
      ? { max_output_tokens: options.maxOutputTokens }
      : {}),
    ...(getReasoningOption(options.providerOptions) !== undefined
      ? { reasoning: getReasoningOption(options.providerOptions) }
      : {}),
  } satisfies JsonRecord;
}

function mapToolDefinition(tool: NonNullable<LanguageModelV2CallOptions["tools"]>[number]) {
  if (!isFunctionTool(tool)) {
    return [];
  }

  return [
    {
      type: "function",
      name: tool.name,
      ...(tool.description ? { description: tool.description } : {}),
      parameters: tool.inputSchema,
    },
  ];
}

function isFunctionTool(tool: unknown): tool is LanguageModelV2FunctionTool {
  return (
    typeof tool === "object" &&
    tool !== null &&
    "type" in tool &&
    tool.type === "function" &&
    "name" in tool &&
    "inputSchema" in tool
  );
}

function mapToolChoice(toolChoice: NonNullable<LanguageModelV2CallOptions["toolChoice"]>) {
  switch (toolChoice.type) {
    case "auto":
    case "none":
    case "required":
      return toolChoice.type;
    case "tool":
      return { type: "function", name: toolChoice.toolName };
  }
}

function mapUserContentPart(
  part: Extract<LanguageModelV2CallOptions["prompt"][number], { role: "user" }>["content"][number]
) {
  if (part.type === "text") {
    return { type: "input_text", text: part.text };
  }

  if (part.data instanceof URL) {
    return part.mediaType.startsWith("image/")
      ? { type: "input_image", image_url: part.data.toString() }
      : { type: "input_file", file_url: part.data.toString() };
  }

  const base64 =
    typeof part.data === "string" ? part.data : Buffer.from(part.data).toString("base64");
  return part.mediaType.startsWith("image/")
    ? { type: "input_image", image_url: `data:${part.mediaType};base64,${base64}` }
    : {
        type: "input_file",
        filename: part.filename ?? "file",
        file_data: `data:${part.mediaType};base64,${base64}`,
      };
}

function serializeToolResultOutput(output: LanguageModelV2ToolResultOutput) {
  switch (output.type) {
    case "text":
    case "error-text":
      return output.value;
    case "json":
    case "error-json":
      return JSON.stringify(output.value);
    case "content":
      return output.value.map((item) =>
        item.type === "text"
          ? { type: "input_text", text: item.text }
          : {
              type: "input_file",
              filename: "file",
              file_data: `data:${item.mediaType};base64,${item.data}`,
            }
      );
  }
}

function getReasoningOption(providerOptions: LanguageModelV2CallOptions["providerOptions"]) {
  const copilotOptions = providerOptions?.["github-copilot"];
  if (!copilotOptions || typeof copilotOptions !== "object") {
    return undefined;
  }

  const explicitReasoning = (copilotOptions as Record<string, unknown>).reasoning;
  if (explicitReasoning && typeof explicitReasoning === "object") {
    return explicitReasoning;
  }

  const reasoningEffort = (copilotOptions as Record<string, unknown>).reasoningEffort;
  return typeof reasoningEffort === "string" ? { effort: reasoningEffort } : undefined;
}

interface OngoingToolCall {
  toolCallId: string;
  toolName: string;
  argumentsText: string;
  finalized: boolean;
}

interface StreamState {
  textAliases: Map<string, string>;
  toolCallsByIndex: Map<number, OngoingToolCall>;
  toolCallsByItemId: Map<string, OngoingToolCall>;
  sawFunctionCall: boolean;
}

async function consumeSseStream(
  source: ReadableStream<Uint8Array>,
  includeRawChunks: boolean,
  controller: ReadableStreamDefaultController<LanguageModelV2StreamPart>
) {
  const state: StreamState = {
    textAliases: new Map(),
    toolCallsByIndex: new Map(),
    toolCallsByItemId: new Map(),
    sawFunctionCall: false,
  };
  const reader = source.getReader();
  const decoder = new TextDecoder();
  let buffer = "";
  let sawTerminalEvent = false;

  try {
    for (;;) {
      const { done, value } = await reader.read();
      buffer += value ? decoder.decode(value, { stream: !done }) : decoder.decode();
      buffer = buffer.replace(/\r/g, "");

      let boundary = buffer.indexOf("\n\n");
      while (boundary >= 0) {
        const frame = buffer.slice(0, boundary);
        buffer = buffer.slice(boundary + 2);
        sawTerminalEvent =
          processFrame(frame, state, includeRawChunks, controller) || sawTerminalEvent;
        boundary = buffer.indexOf("\n\n");
      }

      if (done) {
        if (buffer.trim().length > 0) {
          sawTerminalEvent =
            processFrame(buffer, state, includeRawChunks, controller) || sawTerminalEvent;
        }
        if (!sawTerminalEvent) {
          controller.enqueue({ type: "error", error: createStreamTruncatedError() });
        }
        break;
      }
    }
  } catch (error) {
    controller.enqueue({ type: "error", error });
  } finally {
    controller.close();
    reader.releaseLock();
  }
}

function processFrame(
  frame: string,
  state: StreamState,
  includeRawChunks: boolean,
  controller: ReadableStreamDefaultController<LanguageModelV2StreamPart>
): boolean {
  const parsed = parseSseFrame(frame);
  if (parsed == null) {
    return false;
  }

  if (includeRawChunks) {
    controller.enqueue({ type: "raw", rawValue: parsed });
  }

  let sawTerminalEvent = false;
  for (const part of mapStreamEvent(parsed.event, parsed.data, state)) {
    sawTerminalEvent = part.type === "finish" || part.type === "error" || sawTerminalEvent;
    controller.enqueue(part);
  }

  return sawTerminalEvent;
}

function parseSseFrame(frame: string) {
  let event = "message";
  const dataLines: string[] = [];

  for (const rawLine of frame.split("\n")) {
    const line = rawLine.trimEnd();
    if (line.length === 0 || line.startsWith(":")) {
      continue;
    }
    if (line.startsWith("event:")) {
      event = line.slice(6).trim();
    } else if (line.startsWith("data:")) {
      dataLines.push(line.slice(5).trimStart());
    }
  }

  if (dataLines.length === 0) {
    return null;
  }

  const rawData = dataLines.join("\n");
  if (rawData === "[DONE]") {
    return null;
  }

  return { event, data: JSON.parse(rawData) as JsonRecord };
}

function mapStreamEvent(event: string, data: JsonRecord, state: StreamState) {
  const type = getString(data.type) ?? event;
  switch (type) {
    case "response.created":
      return [
        {
          type: "response-metadata",
          id: getString((data.response as JsonRecord | undefined)?.id),
          modelId: getString((data.response as JsonRecord | undefined)?.model),
          timestamp: toDate((data.response as JsonRecord | undefined)?.created_at),
        },
      ] satisfies LanguageModelV2StreamPart[];
    case "response.output_item.added": {
      const item = data.item as JsonRecord | undefined;
      const itemType = getString(item?.type);
      if (itemType === "function_call") {
        const call = registerToolCall(data, item, state);
        return call
          ? ([
              { type: "tool-input-start", id: call.toolCallId, toolName: call.toolName },
            ] satisfies LanguageModelV2StreamPart[])
          : [];
      }
      if (itemType !== "message") {
        return [];
      }
      const id = resolveStableTextId(data, state.textAliases, getString(item?.id));
      return id ? ([{ type: "text-start", id }] satisfies LanguageModelV2StreamPart[]) : [];
    }
    case "response.output_text.delta": {
      const id = resolveStableTextId(data, state.textAliases, getString(data.item_id));
      const delta = getString(data.delta);
      return id && delta !== undefined
        ? ([{ type: "text-delta", id, delta }] satisfies LanguageModelV2StreamPart[])
        : [];
    }
    case "response.output_text.done": {
      const id = resolveStableTextId(data, state.textAliases, getString(data.item_id));
      return id ? ([{ type: "text-end", id }] satisfies LanguageModelV2StreamPart[]) : [];
    }
    case "response.function_call_arguments.delta": {
      const call = resolveToolCall(data, state);
      const delta = getString(data.delta);
      if (!call || call.finalized || delta === undefined) {
        return [];
      }
      call.argumentsText += delta;
      return [
        { type: "tool-input-delta", id: call.toolCallId, delta },
      ] satisfies LanguageModelV2StreamPart[];
    }
    case "response.function_call_arguments.done": {
      const call = resolveToolCall(data, state);
      return call ? finalizeToolCall(call, getString(data.arguments), state) : [];
    }
    case "response.output_item.done": {
      const item = data.item as JsonRecord | undefined;
      if (getString(item?.type) !== "function_call") {
        return [];
      }
      const known = resolveToolCall(data, state);
      // Register on the fly so a done-only stream (no prior added event) still
      // yields a terminal tool-call part, with a matching tool-input-start so
      // consumers see a complete input lifecycle.
      const call = known ?? registerToolCall(data, item, state);
      if (!call) {
        return [];
      }
      const parts = finalizeToolCall(call, getString(item?.arguments), state);
      return known
        ? parts
        : ([
            { type: "tool-input-start", id: call.toolCallId, toolName: call.toolName },
            ...parts,
          ] satisfies LanguageModelV2StreamPart[]);
    }
    case "response.completed":
    case "response.incomplete":
      return [
        {
          type: "finish",
          usage: mapUsage((data.response as JsonRecord | undefined)?.usage),
          finishReason: mapFinishReason(getRawFinishReason(data.response), state.sawFunctionCall),
        },
      ] satisfies LanguageModelV2StreamPart[];
    case "response.failed":
      return [
        { type: "error", error: createResponseFailedError(data) },
      ] satisfies LanguageModelV2StreamPart[];
    case "error":
      return [{ type: "error", error: data }] satisfies LanguageModelV2StreamPart[];
    default:
      return [];
  }
}

function createStreamTruncatedError() {
  return new Error("Copilot Responses stream closed before terminal event");
}

function createResponseFailedError(data: JsonRecord) {
  const response = data.response as JsonRecord | undefined;
  const error = response?.error as JsonRecord | undefined;
  const message = getString(error?.message) ?? "Response failed";
  const code = getString(error?.code);

  return new Error(
    code ? `response failed: ${message} (code: ${code})` : `response failed: ${message}`
  );
}

function registerToolCall(data: JsonRecord, item: JsonRecord | undefined, state: StreamState) {
  const toolCallId = getString(item?.call_id);
  const toolName = getString(item?.name);
  if (toolCallId === undefined || toolName === undefined) {
    return undefined;
  }

  const call: OngoingToolCall = { toolCallId, toolName, argumentsText: "", finalized: false };
  const outputIndex = getNumber(data.output_index);
  if (outputIndex !== undefined) {
    state.toolCallsByIndex.set(outputIndex, call);
  }
  const itemId = getString(item?.id);
  if (itemId !== undefined) {
    state.toolCallsByItemId.set(itemId, call);
  }
  return call;
}

function resolveToolCall(data: JsonRecord, state: StreamState) {
  const outputIndex = getNumber(data.output_index);
  if (outputIndex !== undefined) {
    const call = state.toolCallsByIndex.get(outputIndex);
    if (call) {
      return call;
    }
  }

  const itemId = getString(data.item_id) ?? getString((data.item as JsonRecord | undefined)?.id);
  return itemId !== undefined ? state.toolCallsByItemId.get(itemId) : undefined;
}

function finalizeToolCall(
  call: OngoingToolCall,
  completeArguments: string | undefined,
  state: StreamState
): LanguageModelV2StreamPart[] {
  if (call.finalized) {
    return [];
  }
  call.finalized = true;
  state.sawFunctionCall = true;

  return [
    { type: "tool-input-end", id: call.toolCallId },
    {
      type: "tool-call",
      toolCallId: call.toolCallId,
      toolName: call.toolName,
      input: completeArguments ?? call.argumentsText,
    },
  ];
}

function resolveStableTextId(
  data: JsonRecord,
  aliasRegistry: Map<string, string>,
  rawItemId?: string
) {
  const outputIndex = getNumber(data.output_index);
  if (outputIndex !== undefined) {
    const canonicalId = `text-${outputIndex}-${getNumber(data.content_index) ?? 0}`;
    if (rawItemId) {
      aliasRegistry.set(rawItemId, canonicalId);
    }
    return canonicalId;
  }

  if (rawItemId) {
    return aliasRegistry.get(rawItemId);
  }

  return undefined;
}

function extractContent(responseBody: JsonRecord): LanguageModelV2Content[] {
  const output = Array.isArray(responseBody.output) ? responseBody.output : [];
  const content: LanguageModelV2Content[] = [];

  for (const item of output) {
    const outputItem = item as JsonRecord;
    const itemType = getString(outputItem.type);

    if (itemType === "function_call") {
      const toolCallId = getString(outputItem.call_id);
      const toolName = getString(outputItem.name);
      if (toolCallId !== undefined && toolName !== undefined) {
        content.push({
          type: "tool-call",
          toolCallId,
          toolName,
          input: getString(outputItem.arguments) ?? "{}",
        });
      }
      continue;
    }

    if (itemType !== "message" || !Array.isArray(outputItem.content)) {
      continue;
    }

    for (const part of outputItem.content) {
      const textPart = part as JsonRecord;
      if (getString(textPart.type) === "output_text" && typeof textPart.text === "string") {
        content.push({ type: "text", text: textPart.text });
      }
    }
  }

  return content;
}

function mapUsage(rawUsage: unknown): LanguageModelV2Usage {
  const usage = rawUsage && typeof rawUsage === "object" ? (rawUsage as JsonRecord) : {};
  const inputTokens = getNumber(usage.input_tokens);
  const outputTokens = getNumber(usage.output_tokens);
  return {
    inputTokens,
    outputTokens,
    totalTokens: getNumber(usage.total_tokens) ?? sumUsage(inputTokens, outputTokens),
    reasoningTokens: getNumber(
      (usage.output_tokens_details as JsonRecord | undefined)?.reasoning_tokens
    ),
    cachedInputTokens: getNumber(
      (usage.input_tokens_details as JsonRecord | undefined)?.cached_tokens
    ),
  };
}

function getRawFinishReason(value: unknown) {
  const record = value && typeof value === "object" ? (value as JsonRecord) : undefined;
  return (
    getString(record?.finish_reason) ??
    getString((record?.incomplete_details as JsonRecord | undefined)?.reason)
  );
}

function mapFinishReason(reason: unknown, hasFunctionCall: boolean): LanguageModelV2FinishReason {
  // The Responses API reports completion via status, not finish_reason, so a
  // tool-calling turn typically ends with no raw reason at all.
  if (reason === undefined && hasFunctionCall) {
    return "tool-calls";
  }
  switch (reason) {
    case "stop":
      return "stop";
    case "max_tokens":
    case "max_output_tokens":
      return "length";
    case "content_filter":
      return "content-filter";
    case "tool_calls":
      return "tool-calls";
    default:
      return "other";
  }
}

function headersToRecord(headers: Headers) {
  return Object.fromEntries(headers.entries());
}

function toDate(value: unknown) {
  const timestamp = getNumber(value);
  if (timestamp === undefined) {
    return undefined;
  }
  return new Date(timestamp > 1_000_000_000_000 ? timestamp : timestamp * 1000);
}

function getString(value: unknown) {
  return typeof value === "string" ? value : undefined;
}

function getNumber(value: unknown) {
  return typeof value === "number" ? value : undefined;
}

function sumUsage(inputTokens: number | undefined, outputTokens: number | undefined) {
  return inputTokens !== undefined || outputTokens !== undefined
    ? (inputTokens ?? 0) + (outputTokens ?? 0)
    : undefined;
}

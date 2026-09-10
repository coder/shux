import {
  Client,
  SSEClientTransport,
  StreamableHTTPClientTransport,
  type OAuthClientProvider,
  type PriorDiscovery,
  type Transport,
} from "@modelcontextprotocol/client";
import { dynamicTool, jsonSchema, type JSONSchema7, type Tool } from "ai";
import { createOptionalNullSchemaContract } from "@/common/utils/tools/optionalNullSchema";
import assert from "@/common/utils/assert";

/**
 * MCP client adapter over the official TypeScript SDK v2
 * (@modelcontextprotocol/client).
 *
 * Xum previously used @ai-sdk/mcp, which only speaks MCP protocol revisions up
 * to 2025-11-25 (initialize handshake + Mcp-Session-Id sessions) and has no
 * support for the stateless 2026-07-28 revision (SEP-2575/2567). The official
 * SDK v2 client implements both revisions; its default connect sequence is the
 * plain legacy `initialize` handshake, byte-identical to the previous wire
 * behavior, so existing user-configured servers see no change.
 *
 * This module keeps transport and request details behind the small handle consumed by
 * mcpServerManager, preserving its instance-cache, lease, and recycle machinery.
 */

/** Client identity sent to servers (initialize request / clientInfo _meta). */
const CLIENT_INFO = { name: "xum", version: "1.0.0" };

/**
 * Maximum time a single MCP tool call may run.
 *
 * mcpServerManager's wrapMCPTools enforces this deadline (with recycle
 * semantics) around every tool execution.
 */
export const MCP_TOOL_CALL_TIMEOUT_MS = 300_000;

/**
 * SDK-level timeout for tools/call requests.
 *
 * @ai-sdk/mcp had no per-request timeouts; the official SDK defaults to 60s,
 * which would cut long-running tool calls that Xum intentionally allows (up to
 * MCP_TOOL_CALL_TIMEOUT_MS). Keep the SDK timeout slightly above the wrapper
 * deadline so wrapMCPTools' MCPDeadlineError (which drives client recycling)
 * always wins the race, while the SDK still cleans up abandoned requests.
 */
const SDK_TOOL_CALL_TIMEOUT_MS = MCP_TOOL_CALL_TIMEOUT_MS + 5_000;
const PROMPT_GET_TIMEOUT_MS = 30_000;
// One hung server must not stall the whole slash/inline prompt catalog.
const PROMPT_LIST_TIMEOUT_MS = 10_000;

export interface MCPHttpTransportConfig {
  type: "http" | "sse";
  url: string;
  headers?: Record<string, string> | undefined;
  /** Custom fetch (e.g. WWW-Authenticate capture during server tests). */
  fetch?: typeof fetch;
  authProvider?: OAuthClientProvider;
}

/**
 * Timeout for the connect-time `server/discover` probe.
 *
 * Deliberately short: a legacy stdio server that silently ignores unknown
 * pre-`initialize` requests only reveals itself via probe timeout, and that
 * wait counts against mcpServerManager's 60s startup deadline. Probe verdicts
 * are cached per server config (see MCPServerManager.eraVerdicts), so the
 * cost is paid once per config change, not per startup.
 */
const NEGOTIATION_PROBE_TIMEOUT_MS = 5_000;

export interface MCPClientConfig {
  /** Either a ready transport (stdio) or an HTTP/SSE transport config. */
  transport: Transport | MCPHttpTransportConfig;
  /** Receives transport/protocol errors surfaced outside request call sites. */
  onUncaughtError?: (error: unknown) => void;
  /**
   * Cached era verdict from a previous negotiation against the same server
   * config. When present, connect() adopts it with zero probe round trips:
   * a modern verdict replays the stored server/discover result (failing
   * loudly via EraNegotiationFailed if stale), a legacy verdict runs the
   * plain initialize handshake directly.
   */
  prior?: PriorDiscovery;
}

export type MCPPrompt = Awaited<ReturnType<Client["listPrompts"]>>["prompts"][number];
export type MCPGetPromptResult = Awaited<ReturnType<Client["getPrompt"]>>;

export interface MCPClientHandle {
  /** Fetch tools/list and build AI SDK tools whose execute calls tools/call. */
  tools(): Promise<Record<string, Tool>>;
  prompts(options?: { signal?: AbortSignal }): Promise<MCPPrompt[]>;
  getPrompt(
    name: string,
    args: Record<string, string>,
    options?: { signal?: AbortSignal }
  ): Promise<MCPGetPromptResult>;
  /**
   * The MCP protocol revision negotiated at connect ("2026-07-28" once the
   * server/discover probe finds a modern server; "2025-11-25" or earlier on
   * the legacy initialize fallback).
   */
  negotiatedProtocolVersion(): string | undefined;
  /**
   * Persistable era verdict for this connection, suitable for `prior` on a
   * later connect against the same server config.
   */
  priorDiscovery(): PriorDiscovery;
  close(): Promise<void>;
}

/** True when the connection negotiated the stateless 2026-07-28+ era. */
export function isModernEra(prior: PriorDiscovery): boolean {
  return prior.kind === "modern";
}

function isHttpTransportConfig(
  transport: Transport | MCPHttpTransportConfig
): transport is MCPHttpTransportConfig {
  return "type" in transport && (transport.type === "http" || transport.type === "sse");
}

function createHttpTransport(config: MCPHttpTransportConfig): Transport {
  const url = new URL(config.url);
  // MCP server URLs are user-configured and already trusted to execute tools,
  // so follow HTTP redirects (http->https, trailing slash) to avoid breaking
  // existing setups. Note undici's fetch follows redirects by default; this
  // pins the behavior explicitly.
  const requestInit: RequestInit = {
    redirect: "follow",
    ...(config.headers !== undefined ? { headers: config.headers } : {}),
  };

  const options = {
    requestInit,
    ...(config.fetch !== undefined ? { fetch: config.fetch } : {}),
    ...(config.authProvider !== undefined ? { authProvider: config.authProvider } : {}),
  };

  // Custom headers in requestInit are merged into every request by both
  // transports, including the SSE GET stream (verified against SDK v2.0.0's
  // _commonHeaders implementation).
  return config.type === "http"
    ? new StreamableHTTPClientTransport(url, options)
    : new SSEClientTransport(url, options);
}

/**
 * MCP CallToolResult -> AI SDK tool-result output for the model.
 *
 * Mirrors @ai-sdk/mcp's mcpToModelOutput so model-visible tool results stay
 * identical across the SDK swap.
 */
function mcpToModelOutput({
  output,
}: {
  output: unknown;
}): ReturnType<NonNullable<Tool["toModelOutput"]>> {
  const result = output as {
    type?: string;
    value?: Array<Record<string, unknown> & { type?: string }>;
    content?: Array<Record<string, unknown> & { type?: string }>;
  };
  // mcpServerManager's wrapMCPTools runs transformMCPResult over execute
  // results first — the single conversion layer for MCP binary content
  // (image/audio/blob resources, size guard included) — producing Xum's
  // canonical { type: "content", value: [text | media] } shape. Map its
  // media parts to model-output file parts here.
  if (
    result &&
    typeof result === "object" &&
    result.type === "content" &&
    Array.isArray(result.value)
  ) {
    return {
      type: "content",
      value: result.value.map((part) => {
        if (
          part.type === "media" &&
          typeof part.data === "string" &&
          typeof part.mediaType === "string"
        ) {
          return {
            type: "file" as const,
            mediaType: part.mediaType,
            data: { type: "data" as const, data: part.data },
          };
        }
        if (part.type === "text" && typeof part.text === "string") {
          return { type: "text" as const, text: part.text };
        }
        return { type: "text" as const, text: JSON.stringify(part) };
      }),
    };
  }
  if (!result || typeof result !== "object" || !Array.isArray(result.content)) {
    return { type: "json", value: result as never };
  }
  // Untransformed MCP results (no binary payloads; see transformMCPResult):
  // text and text-resource parts only in practice.
  const convertedContent = result.content.map((part) => {
    if (part.type === "text" && typeof part.text === "string") {
      return { type: "text" as const, text: part.text };
    }
    if (part.type === "resource" && part.resource && typeof part.resource === "object") {
      const resource = part.resource as { uri?: string; text?: string };
      if (typeof resource.text === "string") {
        return { type: "text" as const, text: resource.text };
      }
    }
    return { type: "text" as const, text: JSON.stringify(part) };
  });
  return { type: "content", value: convertedContent };
}

function isJsonSchemaProperties(value: unknown): value is NonNullable<JSONSchema7["properties"]> {
  return value != null && typeof value === "object" && !Array.isArray(value);
}

function createMCPSourceSchema(inputSchema: Record<string, unknown> | undefined): JSONSchema7 {
  const sourceSchema: JSONSchema7 = { ...(inputSchema ?? { type: "object" }) };
  const hasComposition = ["$ref", "$dynamicRef", "$recursiveRef", "allOf", "anyOf", "oneOf"].some(
    (key) => Object.hasOwn(sourceSchema, key)
  );
  if (isJsonSchemaProperties(inputSchema?.properties)) {
    sourceSchema.properties = inputSchema.properties;
    sourceSchema.additionalProperties = inputSchema.additionalProperties ?? false;
  } else if (!hasComposition || inputSchema?.additionalProperties !== undefined) {
    sourceSchema.properties = {};
    sourceSchema.additionalProperties = inputSchema?.additionalProperties ?? false;
  }
  return sourceSchema;
}

export function createMCPToolContract(inputSchema: Record<string, unknown> | undefined) {
  // Strict REST-backed servers reject present-but-empty arguments (#2887), so
  // an optional `""` is an omission here.
  const contract = createOptionalNullSchemaContract(createMCPSourceSchema(inputSchema), {
    emptyStringIsOmission: true,
  });
  return {
    strict: contract.strict,
    inputSchema: jsonSchema(contract.modelSchema as JSONSchema7, {
      validate: (value) => ({
        success: true as const,
        value: contract.restore(value),
      }),
    }),
  };
}

/** Build the provider contract and restore the MCP server contract during input parsing. */
export function createMCPToolInputSchema(inputSchema: Record<string, unknown> | undefined) {
  return createMCPToolContract(inputSchema).inputSchema;
}

/**
 * Connect to an MCP server and return a handle for tools and prompts.
 *
 * Version negotiation is per connection (and therefore per configured
 * server): connect() probes with `server/discover` and conservatively falls
 * back to the plain legacy 2025-11-25 initialize handshake — byte-identical
 * to a pre-2026 client — on anything but definitive modern evidence. A
 * `prior` verdict skips the probe entirely.
 */
export async function createMCPClient(config: MCPClientConfig): Promise<MCPClientHandle> {
  const client = new Client(CLIENT_INFO, {
    versionNegotiation: {
      mode: "auto",
      probe: { timeoutMs: NEGOTIATION_PROBE_TIMEOUT_MS },
    },
  });

  if (config.onUncaughtError) {
    const onUncaughtError = config.onUncaughtError;
    client.onerror = (error) => onUncaughtError(error);
  }

  const transport = isHttpTransportConfig(config.transport)
    ? createHttpTransport(config.transport)
    : config.transport;

  await client.connect(transport, config.prior !== undefined ? { prior: config.prior } : {});

  return {
    tools: async () => {
      const listResult = await client.listTools();
      assert(Array.isArray(listResult.tools), "MCP tools/list result must carry a tools array");

      const tools: Record<string, Tool> = {};
      for (const definition of listResult.tools) {
        const contract = createMCPToolContract(definition.inputSchema);
        tools[definition.name] = dynamicTool({
          description: definition.description,
          title: definition.title ?? definition.annotations?.title,
          strict: contract.strict,
          inputSchema: contract.inputSchema,
          execute: async (args: unknown, options: { abortSignal?: AbortSignal }) => {
            options.abortSignal?.throwIfAborted();
            return await client.callTool(
              {
                name: definition.name,
                arguments: args as Record<string, unknown>,
              },
              {
                timeout: SDK_TOOL_CALL_TIMEOUT_MS,
                ...(options.abortSignal !== undefined ? { signal: options.abortSignal } : {}),
              }
            );
          },
          toModelOutput: mcpToModelOutput,
        });
      }
      return tools;
    },
    prompts: async (options) => {
      // Cursorless listPrompts() aggregates pages up to ClientOptions.listMaxPages
      // and forwards these options to each request; the integration test covers
      // page two.
      const result = await client.listPrompts(undefined, {
        timeout: PROMPT_LIST_TIMEOUT_MS,
        ...(options?.signal !== undefined ? { signal: options.signal } : {}),
      });
      assert(Array.isArray(result.prompts), "MCP prompts/list result must carry a prompts array");
      return result.prompts;
    },
    getPrompt: (name, args, options) =>
      client.getPrompt(
        { name, arguments: args },
        {
          // Prompt expansion blocks send preparation, so use a shorter timeout than
          // tool calls and honor send cancellation.
          timeout: PROMPT_GET_TIMEOUT_MS,
          ...(options?.signal !== undefined ? { signal: options.signal } : {}),
        }
      ),
    negotiatedProtocolVersion: () => client.getNegotiatedProtocolVersion(),
    priorDiscovery: (): PriorDiscovery => {
      const discover = client.getDiscoverResult();
      return discover !== undefined ? { kind: "modern", discover } : { kind: "legacy" };
    },
    close: () => client.close(),
  };
}

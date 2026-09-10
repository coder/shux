import { tool as createTool, type ModelMessage, type SystemModelMessage, type Tool } from "ai";
import type { ProvidersConfigMap } from "@/common/orpc/types";
import { isGpt56FamilyModel } from "@/common/types/thinking";
import assert from "@/common/utils/assert";
import { cloneToolPreservingDescriptors } from "@/common/utils/tools/cloneToolPreservingDescriptors";
import {
  wouldRouteOpenAIThroughCodexOauth,
  type CodexOauthRoutingOptions,
} from "@/common/utils/providers/codexOauthRouting";
import { resolveCoderWireCanonicalModel } from "@/common/constants/coderOAuth";
import {
  customProviderWireOrigin,
  isCustomProviderConfig,
} from "@/common/utils/providers/customProviders";
import { resolveModelForMetadata } from "@/common/utils/providers/modelEntries";
import { getExplicitGatewayPrefix, normalizeToCanonical } from "./models";

/**
 * Anthropic prompt cache TTL value.
 * "5m" = 5-minute cache (default, free refresh on hit).
 * "1h" = 1-hour cache (2× base input write cost, longer lived).
 * See: https://docs.anthropic.com/en/docs/build-with-claude/prompt-caching#1-hour-cache-duration
 */
export type AnthropicCacheTtl = "5m" | "1h";

function isAnthropicCacheTtl(value: unknown): value is AnthropicCacheTtl {
  return value === "5m" || value === "1h";
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}

/**
 * Recover the Anthropic cache TTL from merged provider options. Users can set
 * cacheControl.ttl through per-model providerOptions extras (modelParameters),
 * so manual cache markers must honor it when the dedicated mux-level
 * anthropic.cacheTtl setting is unset.
 */
export function getAnthropicCacheTtl(
  providerOptions?: Record<string, unknown>
): AnthropicCacheTtl | undefined {
  const anthropicOptions = providerOptions?.anthropic;
  if (!isRecord(anthropicOptions)) {
    return undefined;
  }
  const cacheControl = anthropicOptions.cacheControl;
  if (!isRecord(cacheControl)) {
    return undefined;
  }
  return isAnthropicCacheTtl(cacheControl.ttl) ? cacheControl.ttl : undefined;
}

/**
 * Check if a model supports Anthropic cache control.
 *
 * Coder gateway strings resolve their wire from instance metadata FIRST (raw
 * identity, before name-based normalization): a custom-named Anthropic
 * instance (coder:prod-anthropic/<model>) stays gateway-scoped yet speaks
 * Anthropic on the wire, so cache markers must apply; conversely a canonical
 * name with a non-Anthropic type must not get them. Without a providersConfig
 * the name convention (normalizeToCanonical) is the only signal available.
 */
export function supportsAnthropicCache(
  modelString: string,
  providersConfig?: ProvidersConfigMap | null
): boolean {
  // ZDR: the backend-authoritative disableBetaFeatures flag turns prompt
  // caching off for every Anthropic-wire route (direct, mux-gateway,
  // Coder instances). The provider fetch wrapper only skips INJECTING
  // markers — it never strips ones already serialized by these helpers —
  // so eligibility itself must be rejected here.
  if (providersConfig?.anthropic?.disableBetaFeatures === true) {
    return false;
  }
  // Custom providers (including ones shadowing built-in ids) speak the wire
  // their providerType selects; name normalization below cannot see that.
  const colonIndex = modelString.indexOf(":");
  const prefixEntry =
    colonIndex > 0 ? providersConfig?.[modelString.slice(0, colonIndex)] : undefined;
  if (isCustomProviderConfig(prefixEntry)) {
    return customProviderWireOrigin(prefixEntry.providerType) === "anthropic";
  }
  if (modelString.startsWith("coder:") && !isCustomProviderConfig(providersConfig?.coder)) {
    const wire = resolveCoderWireCanonicalModel(
      modelString.slice("coder:".length),
      providersConfig?.coder
    );
    if (wire) {
      return wire.origin === "anthropic";
    }
  }
  const normalized = normalizeToCanonical(modelString);
  // After normalizeToCanonical, all gateway Anthropic models normalize to "anthropic:..."
  // so we only need to check for the "anthropic:" prefix.
  return normalized.startsWith("anthropic:");
}

/** Build cache control providerOptions for Anthropic with optional TTL. */
function anthropicCacheControl(cacheTtl?: AnthropicCacheTtl | null) {
  return {
    anthropic: {
      cacheControl: cacheTtl
        ? { type: "ephemeral" as const, ttl: cacheTtl }
        : { type: "ephemeral" as const },
    },
  };
}

/** Default cache control (no explicit TTL — Anthropic defaults to 5m). */
const ANTHROPIC_CACHE_CONTROL = anthropicCacheControl();

type ProviderNativeTool = Extract<Tool, { type: "provider" }>;

function isProviderNativeTool(tool: Tool): tool is ProviderNativeTool {
  return tool.type === "provider";
}

/**
 * Add providerOptions to the last content part of a message.
 * The SDK requires providerOptions on content parts, not on the message itself.
 *
 * For system messages with string content, we use message-level providerOptions
 * (which the SDK handles correctly). For user/assistant messages with array
 * content, we add providerOptions to the last content part.
 */
function addCacheControlToLastContentPart(
  msg: ModelMessage,
  cacheTtl?: AnthropicCacheTtl | null
): ModelMessage {
  const cacheOpts = cacheTtl ? anthropicCacheControl(cacheTtl) : ANTHROPIC_CACHE_CONTROL;
  const content = msg.content;

  // String content (typically system messages): use message-level providerOptions
  // The SDK correctly translates this for system messages
  if (typeof content === "string") {
    return {
      ...msg,
      providerOptions: cacheOpts,
    };
  }

  // Array content: add providerOptions to the last part
  // Use type assertion since we're adding providerOptions which is valid but not in base types
  if (Array.isArray(content) && content.length > 0) {
    const lastIndex = content.length - 1;
    const newContent = content.map((part, i) =>
      i === lastIndex ? { ...part, providerOptions: cacheOpts } : part
    );
    // Type assertion needed: ModelMessage types are strict unions but providerOptions
    // on content parts is valid per SDK docs
    const result = { ...msg, content: newContent };
    return result as ModelMessage;
  }

  // Empty or unexpected content: return as-is
  return msg;
}

/**
 * Apply cache control to messages for Anthropic models.
 * Adds a cache marker to the last message so the entire conversation is cached.
 *
 * NOTE: The SDK requires providerOptions on content parts, not on the message.
 * We add cache_control to the last content part of the last message.
 */
export function applyCacheControl(
  messages: ModelMessage[],
  modelString: string,
  cacheTtl?: AnthropicCacheTtl | null,
  providersConfig?: ProvidersConfigMap | null
): ModelMessage[] {
  // Only apply cache control for Anthropic models
  if (!supportsAnthropicCache(modelString, providersConfig)) {
    return messages;
  }

  // Need at least 1 message to add a cache breakpoint
  if (messages.length < 1) {
    return messages;
  }

  // Add cache breakpoint at the last message
  const cacheIndex = messages.length - 1;

  return messages.map((msg, index) => {
    if (index === cacheIndex) {
      return addCacheControlToLastContentPart(msg, cacheTtl);
    }
    return msg;
  });
}

/**
 * Create a system message with cache control for Anthropic models.
 * System messages rarely change and should always be cached.
 */
export function createCachedSystemMessage(
  systemContent: string,
  modelString: string,
  cacheTtl?: AnthropicCacheTtl | null,
  providersConfig?: ProvidersConfigMap | null
): ModelMessage | null {
  if (!systemContent || !supportsAnthropicCache(modelString, providersConfig)) {
    return null;
  }

  return {
    role: "system" as const,
    content: systemContent,
    providerOptions: cacheTtl ? anthropicCacheControl(cacheTtl) : ANTHROPIC_CACHE_CONTROL,
  };
}

/**
 * Whether an official-endpoint host check passes for direct OpenAI explicit
 * prompt caching. Absence of any override means the SDK's official default;
 * any configured value must resolve to the canonical https://api.openai.com
 * endpoint (root or /v1 path, default port, no credentials/query/hash).
 */
function isOfficialOpenAIBaseUrl(baseUrl: string): boolean {
  let url: URL;
  try {
    url = new URL(baseUrl);
  } catch {
    return false;
  }

  return (
    url.protocol === "https:" &&
    url.hostname === "api.openai.com" &&
    url.port === "" &&
    url.username === "" &&
    url.password === "" &&
    url.search === "" &&
    url.hash === "" &&
    (url.pathname === "/" || url.pathname === "/v1" || url.pathname === "/v1/")
  );
}

/**
 * Route-aware eligibility for GPT-5.6 explicit prompt cache breakpoints.
 *
 * Explicit breakpoints (and the Chat Completions promptCacheKey extension) are
 * only known to work on the official direct OpenAI API with API-key auth, so
 * every branch fails closed until proven eligible:
 * - the request model's parsed origin must be exactly `openai` (raw unprefixed
 *   strings and non-OpenAI namespaces never infer a provider here);
 * - mapped aliases resolve through resolveModelForMetadata and the resolved
 *   capability target must itself be an OpenAI GPT-5.6-family model;
 * - the backend-resolved route provider must be exactly "openai" — missing,
 *   legacy, gateway, or unknown route metadata fails closed;
 * - Codex OAuth precedence (mirrored by wouldRouteOpenAIThroughCodexOauth)
 *   fails closed because the ChatGPT backend strips these fields;
 * - a configured custom base URL fails closed unless it is the official
 *   endpoint. Transport-level HTTP proxy env vars are not endpoint overrides
 *   and stay outside this check.
 */
export function openaiExplicitPromptCachingAvailable(
  modelString: string,
  routeProvider: string | undefined,
  providersConfig: ProvidersConfigMap | null,
  options?: CodexOauthRoutingOptions
): boolean {
  if (routeProvider !== "openai") {
    return false;
  }

  // Explicit gateway namespaces (e.g. openrouter:openai/gpt-5.6) fail closed
  // even though they canonicalize to an openai: origin — the request namespace
  // itself must be OpenAI.
  if (getExplicitGatewayPrefix(modelString) != null) {
    return false;
  }

  const normalized = normalizeToCanonical(modelString);
  const [origin, modelName] = normalized.split(":", 2);
  if (origin !== "openai" || !modelName) {
    return false;
  }

  // Mapped aliases inherit eligibility only when the resolved capability
  // target is also an OpenAI GPT-5.6-family model.
  const capabilityModel = resolveModelForMetadata(normalized, providersConfig);
  const [capabilityOrigin, capabilityModelName] = capabilityModel.split(":", 2);
  if (capabilityOrigin !== "openai" || !capabilityModelName) {
    return false;
  }
  if (!isGpt56FamilyModel(capabilityModel)) {
    return false;
  }

  // Without a providers config view we cannot verify auth precedence or the
  // active endpoint, so eligibility cannot be established.
  const openaiConfig = providersConfig?.openai;
  if (openaiConfig == null) {
    return false;
  }

  if (wouldRouteOpenAIThroughCodexOauth(normalized, providersConfig, options)) {
    return false;
  }

  // baseUrl is the config-set value (which wins over env in the provider
  // factory); baseUrlResolved carries the active env value when config is
  // unset. Absence of both means the SDK's official default endpoint.
  const activeBaseUrl = openaiConfig.baseUrl ?? openaiConfig.baseUrlResolved;
  if (activeBaseUrl != null && !isOfficialOpenAIBaseUrl(activeBaseUrl)) {
    return false;
  }

  return true;
}

/**
 * Create a structured system message carrying one explicit GPT-5.6 prompt
 * cache breakpoint at the end of Xum's stable system/developer instructions.
 *
 * The AI SDK reads message-level providerOptions.openai.promptCacheBreakpoint
 * on system messages (string content — not a content-part array) and
 * serializes it to a `prompt_cache_breakpoint` content block on both the
 * Responses and Chat Completions wire formats. Request-wide caching stays
 * implicit (no promptCacheOptions), preserving OpenAI's automatic
 * latest-message breakpoint alongside this stable-prefix one.
 */
export function createOpenAICachedSystemMessage(
  systemContent: string,
  modelString: string,
  routeProvider: string | undefined,
  providersConfig: ProvidersConfigMap | null,
  options?: CodexOauthRoutingOptions
): SystemModelMessage | null {
  if (
    !systemContent ||
    !openaiExplicitPromptCachingAvailable(modelString, routeProvider, providersConfig, options)
  ) {
    return null;
  }

  return {
    role: "system",
    content: systemContent,
    providerOptions: {
      openai: {
        promptCacheBreakpoint: { mode: "explicit" },
      },
    },
  } satisfies SystemModelMessage;
}

/**
 * Apply cache control to tool definitions for Anthropic models.
 * Tools are static per model and should always be cached.
 *
 * IMPORTANT: Anthropic has a 4 cache breakpoint limit. We use:
 * 1. System message (1 breakpoint)
 * 2. Conversation history (1 breakpoint)
 * 3. Last tool only (1 breakpoint) - caches all tools up to and including this one
 * = 3 total, leaving 1 for future use
 *
 * NOTE: Function tools with execute handlers are recreated so providerOptions is set
 * at creation time. Provider-native tools (type: "provider") and execute-less
 * dynamic/MCP tools keep their runtime metadata and are descriptor-cloned before
 * attaching providerOptions.
 */
export function applyCacheControlToTools<T extends Record<string, Tool>>(
  tools: T,
  modelString: string,
  cacheTtl?: AnthropicCacheTtl | null,
  providersConfig?: ProvidersConfigMap | null
): T {
  // Only apply cache control for Anthropic models
  if (
    !supportsAnthropicCache(modelString, providersConfig) ||
    !tools ||
    Object.keys(tools).length === 0
  ) {
    return tools;
  }

  // Get the last tool key (tools are ordered, last one gets cached)
  const toolKeys = Object.keys(tools);
  const lastToolKey = toolKeys[toolKeys.length - 1];

  const cacheOpts = cacheTtl ? anthropicCacheControl(cacheTtl) : ANTHROPIC_CACHE_CONTROL;

  // Clone tools and add cache control ONLY to the last tool
  // Anthropic caches everything up to the cache breakpoint, so marking
  // only the last tool will cache all tools
  // eslint-disable-next-line local/no-chained-type-assertions -- grandfathered when the rule was introduced; fix the underlying type instead of copying this pattern
  const cachedTools = {} as unknown as T;
  for (const [key, existingTool] of Object.entries(tools)) {
    if (key === lastToolKey) {
      if (isProviderNativeTool(existingTool)) {
        // Provider-native tools (e.g. Anthropic/OpenAI web search) cannot be recreated with
        // createTool(). Clone while preserving descriptors/getters and attach providerOptions.
        const cachedProviderTool = cloneToolPreservingDescriptors(
          existingTool
        ) as ProviderNativeTool;
        cachedProviderTool.providerOptions = cacheOpts;
        // eslint-disable-next-line local/no-chained-type-assertions -- grandfathered when the rule was introduced; fix the underlying type instead of copying this pattern
        cachedTools[key as keyof T] = cachedProviderTool as unknown as T[keyof T];
      } else if (existingTool.execute == null) {
        // Some MCP/dynamic tools are valid without execute handlers (provider-/client-executed).
        // Keep their runtime shape and attach cache control without forcing recreation.
        const cachedDynamicTool = cloneToolPreservingDescriptors(existingTool);
        cachedDynamicTool.providerOptions = cacheOpts;
        // eslint-disable-next-line local/no-chained-type-assertions -- grandfathered when the rule was introduced; fix the underlying type instead of copying this pattern
        cachedTools[key as keyof T] = cachedDynamicTool as unknown as T[keyof T];
      } else {
        assert(
          existingTool.execute != null,
          `Tool "${key}" must define execute before cache control is applied`
        );

        // Function tools with execute handlers: re-create with providerOptions (SDK requires this at creation time)
        const cachedTool = createTool({
          description: existingTool.description,
          inputSchema: existingTool.inputSchema,
          execute: existingTool.execute,
          providerOptions: cacheOpts,
        });
        // createTool() returns a fresh object that drops any extra own symbol markers attached
        // to the original (e.g. the built-in task-tool marker that lets sibling explore tasks run
        // in parallel). Copy them over so downstream wrappers still recognize the recreated tool.
        for (const marker of Object.getOwnPropertySymbols(existingTool)) {
          const descriptor = Object.getOwnPropertyDescriptor(existingTool, marker);
          if (descriptor) {
            Object.defineProperty(cachedTool, marker, descriptor);
          }
        }
        // eslint-disable-next-line local/no-chained-type-assertions -- grandfathered when the rule was introduced; fix the underlying type instead of copying this pattern
        cachedTools[key as keyof T] = cachedTool as unknown as T[keyof T];
      }
    } else {
      // Other tools are copied as-is
      // eslint-disable-next-line local/no-chained-type-assertions -- grandfathered when the rule was introduced; fix the underlying type instead of copying this pattern
      cachedTools[key as keyof T] = existingTool as unknown as T[keyof T];
    }
  }

  return cachedTools;
}

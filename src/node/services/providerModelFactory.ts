import assert from "node:assert";
import { Effect } from "effect";
import { createOpenAICompatible } from "@ai-sdk/openai-compatible";
import type { XaiProviderOptions } from "@ai-sdk/xai";
import { fromNodeProviderChain } from "@aws-sdk/credential-providers";
import { wrapLanguageModel, type LanguageModel } from "ai";
import { isGrokFrontierModel, type ThinkingLevel } from "@/common/types/thinking";
import { Ok, Err } from "@/common/types/result";
import type { Result } from "@/common/types/result";
import type { SendMessageError } from "@/common/types/errors";
import {
  PROVIDER_REGISTRY,
  PROVIDER_DEFINITIONS,
  type ProviderName,
} from "@/common/constants/providers";
import {
  CODEX_ENDPOINT,
  CODEX_OAUTH_ROUTED_HEADER,
  isCodexOauthAllowedModel,
  isCodexOauthRequiredModel,
} from "@/common/constants/codexOAuth";
import { parseCodexOauthAuth } from "@/node/utils/codexOauthAuth";
import type { Config, ProviderConfig, ProvidersConfig } from "@/node/config";
import { ProvidersConfigStore } from "@/node/config";
import type { MuxProviderOptions } from "@/common/types/providerOptions";
import type { ProvidersConfigMap } from "@/common/orpc/types";
import { ServiceTierSchema, type XAIServiceTier } from "@/common/config/schemas/providersConfig";
import { openaiServiceTierAvailable } from "@/common/utils/ai/openaiProviderOptionsAvailability";
import { resolveConfigBaseUrl } from "@/common/utils/providers/baseUrl";
import { isProviderDisabledInConfig } from "@/common/utils/providers/isProviderDisabled";
import {
  customProviderWireOrigin,
  isBuiltInProvider,
  isCustomProviderConfig,
} from "@/common/utils/providers/customProviders";
import { isGatewayModelAccessibleFromAuthoritativeCatalog } from "@/common/utils/providers/gatewayModelCatalog";
import {
  maybeGetProviderModelEntryId,
  resolveModelForMetadata,
} from "@/common/utils/providers/modelEntries";
import {
  isCopilotModelAccessible,
  selectCopilotApiMode,
  toCopilotModelId,
} from "@/common/utils/copilot/modelRouting";
import { CopilotResponsesLanguageModel } from "@/node/services/copilot/copilotResponsesLanguageModel";
import type { PolicyService } from "@/node/services/policyService";
import type { ProviderService } from "@/node/services/providerService";
import type { CodexOauthService } from "@/node/services/codexOauthService";
import type { CoderOauthService } from "@/node/services/coderOauthService";
import {
  coderAibridgeBaseUrl,
  coderGatewayWireProtocol,
  parseCoderGatewayProviders,
  resolveCoderGatewayProvider,
  resolveCoderWireCanonicalModel,
} from "@/common/constants/coderOAuth";
import { resolveCoderGatewayMetadataModel } from "@/common/utils/providers/coderGatewayMetadata";
import type { DevToolsService } from "@/node/services/devToolsService";
import { captureAndStripDevToolsHeader } from "@/node/services/devToolsHeaderCapture";
import { createDevToolsMiddleware } from "@/node/services/devToolsMiddleware";
import {
  attachLanguageModelCleanup,
  moveLanguageModelCleanup,
} from "@/node/services/languageModelCleanup";
import { createOpenAIWebSocketTransportFetch } from "@/node/services/openAIWebSocketTransportFetch";
import { log } from "@/node/services/log";
import { resolveProviderOptionsNamespaceKey } from "@/common/utils/ai/providerOptions";
import { resolveRoute, type RouteContext } from "@/common/routing";
import {
  getExplicitGatewayPrefix as getExplicitGatewayProvider,
  normalizeToCanonical,
} from "@/common/utils/ai/models";
import type { AnthropicCacheTtl } from "@/common/utils/ai/cacheStrategy";
import { resolveXumEnvironmentValue } from "@/common/compat/legacyMux";
import { XUM_APP_ATTRIBUTION_TITLE, XUM_APP_ATTRIBUTION_URL } from "@/constants/appAttribution";
import {
  resolveCustomProviderCredentials,
  resolveProviderCredentials,
  type ProviderConfigRaw,
  type ProviderRequirementError,
} from "@/node/utils/providerRequirements";
import {
  normalizeGatewayStreamUsage,
  normalizeGatewayGenerateResult,
} from "@/node/utils/gatewayStreamNormalization";
import { EnvHttpProxyAgent, type Dispatcher } from "undici";
import packageJson from "../../../package.json";

// ---------------------------------------------------------------------------
// Undici agent with unlimited timeouts for AI streaming requests.
// Safe because users control cancellation via AbortSignal from the UI.
// Uses EnvHttpProxyAgent to automatically respect HTTP_PROXY, HTTPS_PROXY,
// and NO_PROXY environment variables for debugging/corporate network support.
// ---------------------------------------------------------------------------

const unlimitedTimeoutAgent = new EnvHttpProxyAgent({
  bodyTimeout: 0, // No timeout - prevents BodyTimeoutError on long reasoning pauses
  headersTimeout: 0, // No timeout for headers
});

// Extend RequestInit with undici-specific dispatcher property (Node.js only)
type RequestInitWithDispatcher = RequestInit & { dispatcher?: Dispatcher };

const xumVersionFromEnv = (() => {
  const value = resolveXumEnvironmentValue("VERSION", process.env)?.trim();
  return value && value.length > 0 ? value : undefined;
})();

const xumVersionFromPackageJson = (() => {
  if (typeof packageJson.version !== "string") {
    return undefined;
  }
  const value = packageJson.version.trim();
  return value.length > 0 ? value : undefined;
})();

// Stable default User-Agent for AI provider requests. XUM_VERSION is canonical;
// the transition helper also accepts MUX_VERSION from existing launch scripts.
export const XUM_AI_PROVIDER_USER_AGENT = `xum/${
  xumVersionFromEnv ?? xumVersionFromPackageJson ?? "dev"
}`;

assert(
  XUM_AI_PROVIDER_USER_AGENT.length > "xum/".length,
  "XUM_AI_PROVIDER_USER_AGENT must include a non-empty version"
);

/**
 * Resolve the header source for provider fetch calls.
 *
 * When fetch is called with a Request object, that Request may already carry
 * auth/content headers. Preserve those unless init.headers is explicitly provided,
 * matching fetch override semantics.
 */
export function resolveAIProviderHeaderSource(
  input: RequestInfo | URL,
  init?: RequestInit
): HeadersInit | undefined {
  if (init?.headers != null) {
    return init.headers;
  }

  return input instanceof Request ? input.headers : undefined;
}

/**
 * Build request headers for provider fetch calls.
 *
 * Always includes Xum attribution in User-Agent while preserving provider SDK info
 * for downstream diagnostics and compatibility.
 * Exported for testing.
 */
export function buildAIProviderRequestHeaders(existingHeaders: HeadersInit | undefined): Headers {
  const headers = new Headers(existingHeaders);
  const existingUserAgent = headers.get("user-agent")?.trim();

  if (!existingUserAgent) {
    headers.set("User-Agent", XUM_AI_PROVIDER_USER_AGENT);
    return headers;
  }

  assert(existingUserAgent.length > 0, "existingUserAgent should be non-empty after trim");

  // Avoid duplicating prefix when callers already include Xum attribution.
  if (
    existingUserAgent !== XUM_AI_PROVIDER_USER_AGENT &&
    !existingUserAgent.startsWith(`${XUM_AI_PROVIDER_USER_AGENT} `)
  ) {
    headers.set("User-Agent", `${XUM_AI_PROVIDER_USER_AGENT} ${existingUserAgent}`);
  }

  return headers;
}

/**
 * Default fetch function with unlimited timeouts for AI streaming.
 * Uses undici Agent to remove artificial timeout limits while still
 * respecting user cancellation via AbortSignal.
 *
 * Note: If users provide custom fetch in providers.jsonc, they are
 * responsible for configuring timeouts appropriately. Custom fetch
 * implementations using undici should set bodyTimeout: 0 and
 * headersTimeout: 0 to prevent BodyTimeoutError on long-running
 * reasoning models.
 */
const defaultFetchWithUnlimitedTimeout = (async (
  input: RequestInfo | URL,
  init?: RequestInit
): Promise<Response> => {
  const headerSource = resolveAIProviderHeaderSource(input, init);
  const headers = buildAIProviderRequestHeaders(headerSource);

  // Capture final request headers for DevTools if a synthetic step ID is present.
  // This runs after buildAIProviderRequestHeaders so the Xum user-agent is included.
  // The synthetic header is stripped before the request is sent.
  captureAndStripDevToolsHeader(headers);

  // dispatcher is a Node.js undici-specific property for custom HTTP agents
  const requestInit: RequestInitWithDispatcher = {
    ...(init ?? {}),
    headers,
    dispatcher: unlimitedTimeoutAgent,
  };
  return fetch(input, requestInit);
}) as typeof fetch;

export function resolveOpenAIWebSocketResponsesUrl(baseURL: unknown): string | undefined {
  const resolvedBaseURL = resolveConfigBaseUrl({ baseURL });
  if (resolvedBaseURL == null) {
    return undefined;
  }

  const url = new URL(resolvedBaseURL);
  if (url.protocol === "https:") {
    url.protocol = "wss:";
  } else if (url.protocol === "http:") {
    url.protocol = "ws:";
  } else {
    throw new Error(`Unsupported OpenAI WebSocket base URL protocol: ${url.protocol}`);
  }
  url.pathname = `${url.pathname.replace(/\/+$/, "")}/responses`;
  url.search = "";
  url.hash = "";
  return url.toString();
}

/**
 * Force frontier Grok Responses onto store=false by default (ZDR-safe).
 * Applied for both direct xAI and gateway-routed Grok so callers that omit
 * providerOptions (identity generation, memory harvest, headless tools) never
 * hit the upstream store=true default. Explicit request-level store wins.
 */
function injectGrokStoreDefault(
  model: {
    doStream: (options: never) => unknown;
    doGenerate: (options: never) => unknown;
  },
  configuredStore: unknown
): void {
  const defaultStore = typeof configuredStore === "boolean" ? configuredStore : false;
  interface CallOptions {
    providerOptions?: Record<string, unknown>;
  }
  const injectStoreFlag = <T extends CallOptions>(options: T): T => {
    const xaiOpts = (options.providerOptions?.xai as Record<string, unknown> | undefined) ?? {};
    return {
      ...options,
      providerOptions: {
        ...options.providerOptions,
        // Request-level store wins; otherwise force the ZDR-safe default.
        xai: { store: defaultStore, ...xaiOpts },
      },
    };
  };

  // LanguageModelV4 method types are invariant on options; cast through a local
  // structural type so we can wrap doStream/doGenerate without dragging AI SDK
  // generics into this factory helper.
  const mutableModel = model as {
    doStream: (options: CallOptions) => unknown;
    doGenerate: (options: CallOptions) => unknown;
  };
  const originalDoStream = mutableModel.doStream.bind(mutableModel);
  const originalDoGenerate = mutableModel.doGenerate.bind(mutableModel);
  mutableModel.doStream = (options) => originalDoStream(injectStoreFlag(options));
  mutableModel.doGenerate = (options) => originalDoGenerate(injectStoreFlag(options));
}

/**
 * Add xAI's service_tier request field until @ai-sdk/xai exposes it directly.
 * Priority Processing is a scheduling/billing choice, not a separate model id.
 */
export function wrapFetchWithXAIServiceTier(
  baseFetch: typeof fetch,
  serviceTier?: XAIServiceTier
): typeof fetch {
  if (serviceTier == null) {
    return baseFetch;
  }

  const tieredFetch = async (
    input: Parameters<typeof fetch>[0],
    init?: Parameters<typeof fetch>[1]
  ): Promise<Response> => {
    if (init?.method?.toUpperCase() !== "POST" || typeof init.body !== "string") {
      return baseFetch(input, init);
    }

    try {
      const body = JSON.parse(init.body) as Record<string, unknown>;
      const headers = new Headers(init.headers);
      headers.delete("content-length");
      return baseFetch(input, {
        ...init,
        headers,
        body: JSON.stringify({ ...body, service_tier: serviceTier }),
      });
    } catch {
      return baseFetch(input, init);
    }
  };

  return Object.assign(tieredFetch, baseFetch) as typeof fetch;
}

type FetchWithBunExtensions = typeof fetch & {
  preconnect?: typeof fetch extends { preconnect: infer P } ? P : unknown;
  certificate?: typeof fetch extends { certificate: infer C } ? C : unknown;
};

const globalFetchWithExtras = fetch as FetchWithBunExtensions;
const defaultFetchWithExtras = defaultFetchWithUnlimitedTimeout as FetchWithBunExtensions;

if (typeof globalFetchWithExtras.preconnect === "function") {
  defaultFetchWithExtras.preconnect = globalFetchWithExtras.preconnect.bind(globalFetchWithExtras);
}

if (typeof globalFetchWithExtras.certificate === "function") {
  defaultFetchWithExtras.certificate =
    globalFetchWithExtras.certificate.bind(globalFetchWithExtras);
}

// ---------------------------------------------------------------------------
// Fetch wrappers
// ---------------------------------------------------------------------------

function mergeAnthropicCacheControl(
  existing: unknown,
  cacheTtl?: AnthropicCacheTtl | null
): Record<string, string> {
  const merged: Record<string, string> = { type: "ephemeral" };

  if (typeof existing === "object" && existing !== null) {
    const existingRecord = existing as Record<string, unknown>;
    if (typeof existingRecord.type === "string") {
      merged.type = existingRecord.type;
    }
    if (typeof existingRecord.ttl === "string") {
      merged.ttl = existingRecord.ttl;
    }
  }

  if (cacheTtl) {
    merged.ttl = cacheTtl;
  }

  return merged;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}

function hasAnthropicProviderCacheControl(value: unknown): boolean {
  if (!isRecord(value)) {
    return false;
  }

  const anthropicOptions = value.anthropic;
  return isRecord(anthropicOptions) && isRecord(anthropicOptions.cacheControl);
}

/**
 * Count Anthropic prompt-cache breakpoints in a shaped request payload.
 *
 * This intentionally counts both raw `cache_control` blocks and untransformed
 * `providerOptions.anthropic.cacheControl` markers so tests can guard the
 * budget across direct and gateway request-shaping paths.
 */
export function countAnthropicCacheBreakpoints(requestBody: unknown): number {
  const pending: unknown[] = [requestBody];
  let count = 0;

  while (pending.length > 0) {
    const current = pending.pop();
    if (current == null) {
      continue;
    }

    if (Array.isArray(current)) {
      for (const value of current) {
        pending.push(value);
      }
      continue;
    }

    if (!isRecord(current)) {
      continue;
    }

    if (isRecord(current.cache_control)) {
      count += 1;
    }

    if (hasAnthropicProviderCacheControl(current.providerOptions)) {
      count += 1;
    }

    for (const value of Object.values(current)) {
      pending.push(value);
    }
  }

  return count;
}

/**
 * Remove every cache marker the request pipeline may have serialized:
 * `cache_control` on system/message/tool entries and nested content parts,
 * plus gateway-style providerOptions.anthropic.cacheControl. ZDR enforcement
 * happens HERE, at the wire, because upstream eligibility checks read a
 * policy-filtered providers view that can hide the global anthropic
 * disableBetaFeatures flag.
 */
function stripAnthropicCacheControlMarkers(json: Record<string, unknown>): void {
  const stripEntry = (entry: unknown): void => {
    if (entry == null || typeof entry !== "object" || Array.isArray(entry)) {
      return;
    }
    const record = entry as Record<string, unknown>;
    delete record.cache_control;
    const providerOptions = record.providerOptions;
    if (providerOptions != null && typeof providerOptions === "object") {
      const anthropicOptions = (providerOptions as Record<string, unknown>).anthropic;
      if (anthropicOptions != null && typeof anthropicOptions === "object") {
        delete (anthropicOptions as Record<string, unknown>).cacheControl;
      }
    }
    if (Array.isArray(record.content)) {
      for (const part of record.content) {
        stripEntry(part);
      }
    }
  };

  for (const key of ["system", "messages", "prompt", "tools"]) {
    const value = json[key];
    if (Array.isArray(value)) {
      for (const entry of value) {
        stripEntry(entry);
      }
    }
  }
}

/**
 * Wrap fetch to normalize Anthropic cache_control directly on the final request body.
 *
 * This keeps routed Anthropic payloads aligned with Xum's manual cache markers
 * and lets a higher-level cacheTtl override win at the last wire-shaping step.
 *
 * Injects cache_control on:
 * 1. Last tool (caches all tool definitions)
 * 2. Last message's last content part (caches entire conversation)
 *
 * When injectCacheControl is false (beta features disabled), existing markers
 * are STRIPPED instead (see stripAnthropicCacheControlMarkers).
 */
export function wrapFetchWithAnthropicCacheControl(
  baseFetch: typeof fetch,
  cacheTtl?: AnthropicCacheTtl | null,
  options?: { injectCacheControl?: boolean }
): typeof fetch {
  const injectCacheControl = options?.injectCacheControl ?? true;
  const cachingFetch = async (
    input: Parameters<typeof fetch>[0],
    init?: Parameters<typeof fetch>[1]
  ): Promise<Response> => {
    // Only modify POST requests with JSON body
    if (init?.method?.toUpperCase() !== "POST" || typeof init?.body !== "string") {
      return baseFetch(input, init);
    }

    try {
      const json = JSON.parse(init.body) as Record<string, unknown>;

      if (!injectCacheControl) {
        stripAnthropicCacheControlMarkers(json);
      }

      // Inject cache_control on the last tool if tools array exists.
      // If the SDK already populated cache_control, preserve it but override ttl
      // when a higher-level cacheTtl is configured.
      if (injectCacheControl && Array.isArray(json.tools) && json.tools.length > 0) {
        const lastTool = json.tools[json.tools.length - 1] as Record<string, unknown>;
        lastTool.cache_control = mergeAnthropicCacheControl(lastTool.cache_control, cacheTtl);
      }

      // Inject cache_control on last message's last content part
      // This caches the entire conversation
      // Handle both formats:
      // - Direct Anthropic provider: json.messages (Anthropic API format)
      // - Gateway provider: json.prompt (AI SDK internal format)
      const messages =
        injectCacheControl && Array.isArray(json.messages)
          ? json.messages
          : injectCacheControl && Array.isArray(json.prompt)
            ? json.prompt
            : null;

      if (messages && messages.length >= 1) {
        const lastMsg = messages[messages.length - 1] as Record<string, unknown>;

        // For gateway: add providerOptions.anthropic.cacheControl at message level
        // (gateway validates schema strictly, doesn't allow raw cache_control on messages)
        if (Array.isArray(json.prompt)) {
          const providerOpts = (lastMsg.providerOptions ?? {}) as Record<string, unknown>;
          const anthropicOpts = (providerOpts.anthropic ?? {}) as Record<string, unknown>;
          anthropicOpts.cacheControl = mergeAnthropicCacheControl(
            anthropicOpts.cacheControl,
            cacheTtl
          );
          providerOpts.anthropic = anthropicOpts;
          lastMsg.providerOptions = providerOpts;
        }

        // For direct Anthropic: add cache_control to last content part
        const content = lastMsg.content;
        if (Array.isArray(content) && content.length > 0) {
          const lastPart = content[content.length - 1] as Record<string, unknown>;
          lastPart.cache_control = mergeAnthropicCacheControl(lastPart.cache_control, cacheTtl);
        }
      }

      // Update body with modified JSON
      const newBody = JSON.stringify(json);
      const outHeaders = new Headers(init.headers);
      outHeaders.delete("content-length"); // Body size changed
      return baseFetch(input, { ...init, headers: outHeaders, body: newBody });
    } catch {
      // If JSON parsing fails we can't touch the body; forward unchanged.
      return baseFetch(input, init);
    }
  };

  return Object.assign(cachingFetch, baseFetch) as typeof fetch;
}

/**
 * Wrap fetch so any mux-gateway 401 response clears local credentials (best-effort).
 *
 * This ensures the UI immediately reflects that the user has been logged out
 * when the gateway session expires.
 */
function wrapFetchWithMuxGatewayAutoLogout(
  baseFetch: typeof fetch,
  providerService: ProviderService
): typeof fetch {
  const wrappedFetch = async (
    input: Parameters<typeof fetch>[0],
    init?: Parameters<typeof fetch>[1]
  ): Promise<Response> => {
    const response = await baseFetch(input, init);

    if (response.status === 401) {
      try {
        await providerService.setConfig("mux-gateway", ["couponCode"], "");
        await providerService.setConfig("mux-gateway", ["voucher"], "");
      } catch {
        // Ignore failures clearing local credentials
      }
    }

    return response;
  };

  return Object.assign(wrappedFetch, baseFetch) as typeof fetch;
}

/**
 * Custom adapters pass an explicit empty apiKey so the official SDKs cannot
 * fall back to OPENAI_API_KEY/ANTHROPIC_API_KEY env credentials, but the SDKs
 * then emit an empty auth header ("Authorization: Bearer" / "x-api-key: ").
 * Keyless endpoints and auth proxies can reject a present malformed
 * credential, so strip the empty header before the request leaves.
 */
function wrapFetchStrippingEmptyAuthHeaders(baseFetch: typeof fetch): typeof fetch {
  const wrappedFetch = async (
    input: Parameters<typeof fetch>[0],
    init?: Parameters<typeof fetch>[1]
  ): Promise<Response> => {
    const headers = new Headers(init?.headers);
    const authorization = headers.get("authorization");
    if (
      authorization != null &&
      authorization
        .trim()
        .toLowerCase()
        .replace(/^bearer$/, "") === ""
    ) {
      headers.delete("authorization");
    }
    const apiKeyHeader = headers.get("x-api-key");
    if (apiKeyHeader != null && apiKeyHeader.trim() === "") {
      headers.delete("x-api-key");
    }
    return baseFetch(input, { ...init, headers });
  };
  return Object.assign(wrappedFetch, baseFetch) as typeof fetch;
}

/**
 * Get fetch function for provider - use custom if provided, otherwise unlimited timeout default
 */
function getProviderFetch(providerConfig: ProviderConfig): typeof fetch {
  if (typeof providerConfig.fetch !== "function") {
    return defaultFetchWithUnlimitedTimeout;
  }

  const customFetch = providerConfig.fetch as typeof fetch;

  // Wrap custom fetch to strip the synthetic DevTools correlation header.
  // Without this, x-mux-devtools-step-id can leak to upstream APIs because
  // only defaultFetchWithUnlimitedTimeout strips it natively.
  const wrappedFetch = async (
    input: Parameters<typeof fetch>[0],
    init?: Parameters<typeof fetch>[1]
  ): Promise<Response> => {
    // Build merged headers: start from the Request (if any), then overlay init.headers.
    const merged = new Headers(input instanceof Request ? input.headers : undefined);
    if (init?.headers) {
      for (const [key, value] of new Headers(init.headers).entries()) {
        merged.set(key, value);
      }
    }

    captureAndStripDevToolsHeader(merged);
    return customFetch(input, { ...init, headers: merged });
  };

  return Object.assign(wrappedFetch, customFetch) as typeof fetch;
}

// ---------------------------------------------------------------------------
// Exported helpers (re-exported from aiService.ts for backward compatibility)
// ---------------------------------------------------------------------------

/**
 * Normalize Anthropic base URL to ensure it ends with /v1 suffix.
 *
 * The Anthropic SDK expects baseURL to include /v1 (default: https://api.anthropic.com/v1).
 * Many users configure base URLs without the /v1 suffix, which causes API calls to fail.
 * This function automatically appends /v1 if missing.
 *
 * @param baseURL - The base URL to normalize (may or may not have /v1)
 * @returns The base URL with /v1 suffix
 */
export function normalizeAnthropicBaseURL(baseURL: string): string {
  // Append /v1 to the URL PATH: raw-string suffixing would push the version
  // segment into a query or fragment (proxy.example/a?token=x -> ...?token=x/v1).
  try {
    const url = new URL(baseURL.trim());
    // Compute on a local: the pathname setter normalizes "" back to "/".
    const strippedPath = url.pathname.replace(/\/+$/, "");
    url.pathname = strippedPath.endsWith("/v1") ? strippedPath : `${strippedPath}/v1`;
    return url.toString();
  } catch {
    // Not an absolute URL; keep the legacy raw-string behavior.
    const trimmed = baseURL.replace(/\/+$/, ""); // Remove trailing slashes
    if (trimmed.endsWith("/v1")) {
      return trimmed;
    }
    return `${trimmed}/v1`;
  }
}

export function normalizeOpenAICompatibleBaseURL(baseURL: string): string {
  // Trim first: new URL() tolerates surrounding whitespace, which would defeat
  // the raw-string trailing-slash check below for values like "http://x/ ".
  const trimmed = baseURL.trim();
  try {
    const url = new URL(trimmed);
    // An explicit trailing slash ("http://host:8080/") opts out for servers that
    // mount /chat/completions at the origin root. The URL API normalizes both
    // spellings to pathname "/", so the raw string is the only place the intent
    // survives.
    if (url.pathname !== "/" || trimmed.endsWith("/")) {
      return trimmed;
    }

    // Most compatible servers mount their API under /v1, but explicit proxy paths must remain intact.
    url.pathname = "/v1";
    return url.toString();
  } catch {
    return trimmed;
  }
}

/**
 * Mark a Codex-OAuth-rerouted error response so error consumers (e.g. the
 * Responses base-URL hint) can tell the bytes came from the Codex backend,
 * not the configured base URL. Success responses pass through untouched to
 * keep streaming bodies unwrapped.
 *
 * Exported for testing.
 */
export function markCodexOauthRoutedResponse(response: Response): Response {
  if (response.ok) {
    return response;
  }
  const headers = new Headers(response.headers);
  headers.set(CODEX_OAUTH_ROUTED_HEADER, "1");
  return new Response(response.body, {
    status: response.status,
    statusText: response.statusText,
    headers,
  });
}

import { getErrorMessage } from "@/common/utils/errors";

/**
 * Build app attribution headers used by OpenRouter (and other compatible platforms).
 *
 * Attribution docs:
 * - OpenRouter: https://openrouter.ai/docs/app-attribution
 * - Vercel AI Gateway: https://vercel.com/docs/ai-gateway/app-attribution
 *
 * Exported for testing.
 */
export function buildAppAttributionHeaders(
  existingHeaders: Record<string, string> | undefined
): Record<string, string> {
  // Clone to avoid mutating caller-provided objects.
  const headers: Record<string, string> = existingHeaders ? { ...existingHeaders } : {};

  // Header names are case-insensitive. Preserve user-provided values by never overwriting.
  const existingLowercaseKeys = new Set(Object.keys(headers).map((key) => key.toLowerCase()));

  if (!existingLowercaseKeys.has("http-referer")) {
    headers["HTTP-Referer"] = XUM_APP_ATTRIBUTION_URL;
  }

  if (!existingLowercaseKeys.has("x-title")) {
    headers["X-Title"] = XUM_APP_ATTRIBUTION_TITLE;
  }

  return headers;
}

/**
 * Preload AI SDK provider modules to avoid race conditions in concurrent test environments.
 * This function loads @ai-sdk/anthropic, @ai-sdk/openai, and ollama-ai-provider-v2 eagerly
 * so that subsequent dynamic imports in createModel() hit the module cache instead of racing.
 *
 * In production, providers are lazy-loaded on first use to optimize startup time.
 * In tests, we preload them once during setup to ensure reliable concurrent execution.
 */
export async function preloadAISDKProviders(): Promise<void> {
  // Preload providers to ensure they're in the module cache before concurrent tests run
  await Promise.all(Object.values(PROVIDER_REGISTRY).map((importFn) => importFn()));
}

/**
 * Parse provider and model ID from model string.
 * Handles model IDs with colons (e.g., "ollama:gpt-oss:20b").
 * Only splits on the first colon to support Ollama model naming convention.
 *
 * @param modelString - Model string in format "provider:model-id"
 * @returns Tuple of [providerName, modelId]
 * @example
 * parseModelString("anthropic:claude-opus-4") // ["anthropic", "claude-opus-4"]
 * parseModelString("ollama:gpt-oss:20b") // ["ollama", "gpt-oss:20b"]
 */
export function parseModelString(modelString: string): [string, string] {
  const colonIndex = modelString.indexOf(":");
  const providerName = colonIndex !== -1 ? modelString.slice(0, colonIndex) : modelString;
  const modelId = colonIndex !== -1 ? modelString.slice(colonIndex + 1) : "";
  return [providerName, modelId];
}

/**
 * Classify a Copilot API request as "user" or "agent" initiated by inspecting
 * the last conversational item in the request body. GitHub Copilot bills premium
 * requests only for "user"-initiated calls.
 *
 * Heuristic: if the last chat-completions message or Responses input item is a
 * user turn, treat the request as user-initiated. Assistant continuations, tool
 * calls, tool outputs, and stored item references are agent-initiated.
 */
export function classifyCopilotInitiator(body: string | null | undefined): "user" | "agent" {
  try {
    if (typeof body !== "string") return "user"; // can't parse -> safe default
    const parsed = JSON.parse(body) as { messages?: unknown[]; input?: unknown };
    const messages = parsed.messages;
    if (Array.isArray(messages) && messages.length > 0) {
      const last = messages[messages.length - 1] as { role?: string } | undefined;
      return last?.role === "user" ? "user" : "agent";
    }

    const input = parsed.input;
    if (Array.isArray(input)) {
      for (let index = input.length - 1; index >= 0; index -= 1) {
        const item: unknown = input[index];
        if (typeof item !== "object" || item === null) {
          continue;
        }

        const role = (item as { role?: unknown }).role;
        if (typeof role === "string") {
          if (role === "user") {
            return "user";
          }
          if (role === "assistant") {
            return "agent";
          }
          continue;
        }

        // AI SDK Responses conversion only emits non-role items for assistant or
        // tool-driven state, such as function calls, tool outputs, reasoning, and
        // item references. Treat those as agent-initiated to preserve Copilot billing.
        const type = (item as { type?: unknown }).type;
        if (typeof type === "string") {
          return "agent";
        }
      }
    }

    return "user";
  } catch {
    return "user"; // parse failure -> safe fallback (don't hide usage)
  }
}

function parseAnthropicCacheTtl(value: unknown): AnthropicCacheTtl | undefined {
  if (value === "5m" || value === "1h") {
    return value;
  }
  return undefined;
}

const CODEX_ALLOWED_PARAMS = new Set([
  "model",
  "input",
  "instructions",
  "tools",
  "tool_choice",
  "parallel_tool_calls",
  "stream",
  "store",
  "prompt_cache_key",
  "reasoning",
  "temperature",
  "top_p",
  "include",
  "text", // structured output via Output.object -> text.format
]);

// ---------------------------------------------------------------------------
// Fetch input helpers
// ---------------------------------------------------------------------------

/**
 * Extract a URL string from the `input` argument of a `fetch`-compatible call.
 * Handles the three shapes AI SDK providers pass through: plain string, `URL`,
 * and `Request`-like objects that expose a `url` property. Returns an empty
 * string when the URL cannot be determined so callers can fall through to
 * normal fetch behavior without throwing.
 */
function getFetchInputUrl(input: Parameters<typeof fetch>[0]): string {
  if (typeof input === "string") {
    return input;
  }
  if (input instanceof URL) {
    return input.toString();
  }
  if (typeof input === "object" && input !== null && "url" in input) {
    const possibleUrl = (input as { url?: unknown }).url;
    if (typeof possibleUrl === "string") {
      return possibleUrl;
    }
  }
  return "";
}

// ---------------------------------------------------------------------------
// Content extraction
// ---------------------------------------------------------------------------

/**
 * Extract text from AI SDK message content.
 * Content may be a plain string or a structured array like [{type:"text", text:"..."}].
 */
function extractTextContent(content: unknown): string {
  if (typeof content === "string") return content.trim();
  if (Array.isArray(content)) {
    return (content as unknown[])
      .filter(
        (part): part is { type: string; text: string } =>
          typeof part === "object" &&
          part !== null &&
          (part as { type?: unknown }).type === "text" &&
          typeof (part as { text?: unknown }).text === "string"
      )
      .map((part) => part.text)
      .join("")
      .trim();
  }
  return "";
}

export function normalizeCodexResponsesBody(body: string): string {
  const json = JSON.parse(body) as Record<string, unknown>;

  // ChatGPT's Codex endpoint is stricter than the public OpenAI Responses API
  // and currently rejects the `truncation` field entirely.
  delete json.truncation;

  // Strip the native pro-mode field before forwarding to the stricter ChatGPT
  // backend. Unknown nested reasoning fields risk a hard 4xx, and falling back
  // to standard mode is safer. Preserve effort/summary.
  if (isRecord(json.reasoning)) {
    delete json.reasoning.mode;
    if (Object.keys(json.reasoning).length === 0) {
      delete json.reasoning;
    }
  }

  // Codex-compatible Responses requests must disable storage and strip unsupported params.
  json.store = false;

  for (const key of Object.keys(json)) {
    if (!CODEX_ALLOWED_PARAMS.has(key)) {
      delete json[key];
    }
  }

  // item_reference entries depend on stored state lookups, which fail with store=false.
  if (Array.isArray(json.input)) {
    json.input = (json.input as Array<Record<string, unknown>>).filter(
      (item) => !(item && typeof item === "object" && item.type === "item_reference")
    );
  }

  const existingInstructions =
    typeof json.instructions === "string" ? json.instructions.trim() : "";
  if (existingInstructions.length === 0) {
    const derivedParts: string[] = [];
    const keptInput: unknown[] = [];

    const responseInput = json.input;
    if (Array.isArray(responseInput)) {
      for (const item of responseInput as unknown[]) {
        if (!item || typeof item !== "object") {
          keptInput.push(item);
          continue;
        }

        const role = (item as { role?: unknown }).role;
        if (role !== "system" && role !== "developer") {
          keptInput.push(item);
          continue;
        }

        const content = (item as { content?: unknown }).content;
        const text = extractTextContent(content);
        if (text.length > 0) {
          derivedParts.push(text);
        }
      }

      json.input = keptInput;
    }

    const joined = derivedParts.join("\n\n").trim();
    json.instructions = joined.length > 0 ? joined : "You are a helpful assistant.";
  }

  return JSON.stringify(json);
}

function getConfiguredProviderModelIds(providerConfig: ProviderConfig | undefined): string[] {
  const models = providerConfig?.models;
  if (!Array.isArray(models)) {
    return [];
  }

  return models.flatMap((entry) => {
    const modelId = maybeGetProviderModelEntryId(entry);
    return modelId == null ? [] : [modelId];
  });
}

function createGatewayModelAccessibilityChecker(
  providersConfig: ProvidersConfig,
  policyService?: PolicyService | null
) {
  // discoveredModels/removedModels are Coder-specific keys (other gateways
  // have no server-discovered catalog marker), and ProvidersConfig's
  // loosely-typed Record variant widens them to unknown — validate the shape
  // once here.
  const rawDiscovered = providersConfig.coder?.discoveredModels;
  const coderDiscoveredModels = Array.isArray(rawDiscovered)
    ? rawDiscovered.filter((id): id is string => typeof id === "string")
    : undefined;
  const rawRemoved = providersConfig.coder?.removedModels;
  const coderRemovedModels = Array.isArray(rawRemoved)
    ? rawRemoved.filter((id): id is string => typeof id === "string")
    : undefined;
  return (gateway: string, gatewayModelId: string): boolean => {
    // The persisted catalog is deliberately policy-unfiltered (a temporarily
    // restrictive policy must not survive in durable state); the CURRENT
    // policy is applied here at routing time, so disallowed gateway models
    // fall back to other routes instead of dying at model creation.
    if (policyService?.isEnforced() && !policyService.isModelAllowed(gateway, gatewayModelId)) {
      return false;
    }
    return isGatewayModelAccessibleFromAuthoritativeCatalog(
      gateway,
      gatewayModelId,
      providersConfig[gateway]?.models,
      gateway === "coder" ? coderDiscoveredModels : undefined,
      gateway === "coder" ? coderRemovedModels : undefined
    );
  };
}

function formatCustomProviderRequirementError(
  provider: string,
  error: ProviderRequirementError
): SendMessageError {
  switch (error.code) {
    case "missing_base_url":
      return {
        type: "unknown",
        raw: `Custom provider ${provider} requires baseUrl.`,
      };
    case "api_key_file_unreadable": {
      const reason =
        error.reason === "missing"
          ? "the file does not exist"
          : error.reason === "not_file"
            ? "the path is not a regular file"
            : error.reason === "too_large"
              ? "the file is too large"
              : error.reason === "empty"
                ? "the file is empty"
                : "the file could not be read";
      return {
        type: "unknown",
        raw: `Failed to read API key file for ${provider} at ${error.path}: ${reason}.`,
      };
    }
  }
}

// ---------------------------------------------------------------------------
// ProviderModelFactory
// ---------------------------------------------------------------------------

/**
 * OAuth services are wired after construction (they depend on services built
 * later), so the factory reads them from this shared bindings object at use
 * time instead of capturing instances up front.
 */
export interface OauthServiceBindings {
  codexOauthService?: CodexOauthService;
  coderOauthService?: CoderOauthService;
}

/** Success payload of {@link ProviderModelFactory.resolveAndCreateModel}. */
export interface ResolveAndCreateModelResult {
  model: LanguageModel;
  /** Model string after routing (direct provider or gateway provider prefix). */
  effectiveModelString: string;
  /** Model string with gateway prefix stripped (canonical provider:model). */
  canonicalModelString: string;
  /** Provider name from the canonical model string. */
  canonicalProviderName: string;
  /** Model ID from the canonical model string. */
  canonicalModelId: string;
  /**
   * Provider whose WIRE format the request actually speaks. Differs from
   * canonicalProviderName only for gateway-scoped Coder strings
   * (coder:<instance>/<model>), where the wire is derived from the
   * instance's type. Drives message preparation (Anthropic reasoning
   * transforms, PDF-filename sanitization) and providerOptions namespace
   * selection; canonicalProviderName remains the config identity for
   * providers.jsonc lookups.
   */
  wireProviderName: string;
  /**
   * Coder gateway wire snapshot (instance origin/type + gateway-local
   * model ID), resolved from the SAME providers-config read that
   * produced wireProviderName. Present only when the effective route
   * goes through the Coder gateway. Callers assembling tools/options
   * for this request MUST consume this snapshot instead of re-reading
   * the providers config: an authoritative catalog refresh can change
   * the instance's type mid-request, and a fresh read would assemble
   * another wire's tools/options for the already-created SDK model.
   */
  coderWire?: { origin: "anthropic" | "openai"; modelId: string; providerType: string };
  /**
   * The Coder instance addressed by a raw coder: selection, resolved
   * from the SAME providers-config read — present even when routing
   * fell away from the gateway (unlike coderWire). Callers that pin a
   * request providers-config snapshot must pin THIS identity so
   * builders resolving the raw model string cannot see a concurrently
   * retagged instance type diverging from the created fallback model.
   */
  coderSelectedInstance?: { name: string; type: string };
  /** Whether the request is being routed through the Xum gateway. */
  routedThroughGateway: boolean;
  /** Route provider chosen by backend routing (direct provider or gateway). */
  routeProvider?: ProviderName;
}

/** Creation-time request receipt; routing and wire data must not be reconstructed after awaits. */
export interface PinnedModelOptions extends Pick<
  ResolveAndCreateModelResult,
  "model" | "effectiveModelString" | "wireProviderName"
> {
  metadataModel: string;
  optionsModelString: string;
  optionsProvidersConfig: ProvidersConfigMap;
  optionsMuxProviderOptions: MuxProviderOptions;
  optionsRouteProvider?: ProviderName;
}

interface CreateModelOptions {
  agentInitiated?: boolean;
  workspaceId?: string;
  routeContext?: RouteContext;
  /**
   * Providers-config snapshot to create the model from. Passed by
   * resolveAndCreateModel so routing, the returned coderWire snapshot,
   * and SDK model creation all read ONE config: another Xum process can
   * rewrite providers.jsonc between those steps (e.g. an authoritative
   * catalog refresh changing an instance's type), and a fresh reload
   * here would create a model on the new wire while the caller
   * assembles tools/options for the old one. Direct createModel callers
   * omit it and keep loading the current config.
   */
  providersConfig?: ProvidersConfig;
}

/**
 * Factory responsible for creating AI SDK LanguageModel instances from model strings.
 *
 * Extracted from AIService to isolate provider/model construction logic from the
 * streaming and orchestration concerns that AIService owns.
 *
 * Model-creation internals are Effect-native: the `createModel` /
 * `resolveAndCreateModel` pipelines are `Effect.gen` programs that compose via
 * `yield*`, and the public Promise methods are thin `Effect.runPromise`
 * facades so pre-Effect callers (AIService, TurnRequestBuilder, tests) keep
 * working unchanged. The wire `Result<_, SendMessageError>` union stays in the
 * success channel — callers branch on `success` / `error.type`, never on
 * thrown error identity — so there are no typed failure tags here. The old
 * whole-pipeline try/catch is a single `Effect.catchDefect` fold producing the
 * same `{ type: "unknown" }` wire error from `getErrorMessage`, covering both
 * synchronous throws and rejected provider-module imports exactly like the
 * pre-Effect catch did.
 *
 * Deliberately NOT converted:
 * - Synchronous read/plumbing paths (`resolveEffectiveModelString`,
 *   `resolveGatewayModelString`, `resolveModelRoute`, credential resolution
 *   via `resolveProviderCredentials`): they compose no async work, so an
 *   Effect conversion would add fiber overhead without composition benefit.
 * - Per-request fetch wrappers and doStream/doGenerate wrappers (Codex/Coder
 *   OAuth token refresh via `getValidAuth()`, mux-gateway auto-logout,
 *   Copilot billing classification, gateway usage normalization): these are
 *   AI SDK-owned async callbacks executed on every network request after
 *   model creation, not service pipelines — converting them would embed a
 *   `runPromise` boundary per request with no error-typing win.
 * - `preloadAISDKProviders`: a single `Promise.all` of module imports used by
 *   test setup only.
 */
export class ProviderModelFactory {
  private readonly config: Config;
  private readonly providerService: ProviderService;
  private readonly policyService?: PolicyService;
  private readonly devToolsService?: DevToolsService;
  private readonly oauthServices?: OauthServiceBindings;
  private readonly providersConfigStore: ProvidersConfigStore;

  constructor(
    config: Config,
    providerService: ProviderService,
    policyService?: PolicyService,
    oauthServices?: OauthServiceBindings,
    devToolsService?: DevToolsService,
    providersConfigStore?: ProvidersConfigStore
  ) {
    this.config = config;
    this.providerService = providerService;
    this.policyService = policyService;
    this.oauthServices = oauthServices;
    this.devToolsService = devToolsService;
    this.providersConfigStore = providersConfigStore ?? new ProvidersConfigStore(config.rootDir);
  }

  /**
   * Apply an enforced policy forcedBaseUrl to the coder provider's
   * user-editable deploymentUrl. Coder credentials are issuer-bound, so they
   * must be resolved against the effective (policy-locked) deployment —
   * validating against the still-editable config field would wrongly reject
   * policy-bound credentials after a user edit.
   */
  private coderEffectiveProviderConfig(providerConfig: ProviderConfigRaw): ProviderConfigRaw {
    const forced = this.policyService?.isEnforced()
      ? this.policyService.getForcedBaseUrl("coder")
      : undefined;
    return forced ? { ...providerConfig, deploymentUrl: forced } : providerConfig;
  }

  private isProviderAvailableForRouting(
    provider: ProviderName,
    providersConfig: ProvidersConfig,
    config: ReturnType<Config["loadConfigOrDefault"]>
  ): boolean {
    const rawProviderConfig = providersConfig[provider] ?? {};
    const providerConfig =
      provider === "coder"
        ? this.coderEffectiveProviderConfig(rawProviderConfig)
        : rawProviderConfig;
    const credentials = resolveProviderCredentials(provider, providerConfig);

    // OpenAI Codex OAuth is a valid credential path even without an API key;
    // routing should treat it as available so direct OpenAI routes are honored.
    const hasCodexOauth =
      provider === "openai" &&
      parseCodexOauthAuth((providerConfig as { codexOauth?: unknown }).codexOauth) !== null;

    if (!credentials.isConfigured && !hasCodexOauth) {
      return false;
    }

    // Route resolution must honor the shared provider-level enabled=false switch
    // before considering legacy gateway-specific config gates.
    if (isProviderDisabledInConfig(providerConfig as { enabled?: unknown })) {
      return false;
    }

    if (provider === "mux-gateway") {
      return config.muxGatewayEnabled !== false;
    }

    return true;
  }

  /**
   * Create an AI SDK model from a model string (e.g., "anthropic:claude-opus-4-1")
   *
   * IMPORTANT: We ONLY use providers.jsonc as the single source of truth for provider configuration.
   * We DO NOT use environment variables or default constructors that might read them.
   * This ensures consistent, predictable configuration management.
   *
   * Provider configuration from providers.jsonc is passed verbatim to the provider
   * constructor, ensuring automatic parity with Vercel AI SDK - any configuration options
   * supported by the provider will work without modification.
   */
  createModel(
    modelString: string,
    muxProviderOptions?: MuxProviderOptions,
    opts?: CreateModelOptions
  ): Promise<Result<LanguageModel, SendMessageError>> {
    return Effect.runPromise(this.createModelEffect(modelString, muxProviderOptions, opts));
  }

  private createModelEffect(
    modelString: string,
    muxProviderOptions?: MuxProviderOptions,
    opts?: CreateModelOptions
  ): Effect.Effect<Result<LanguageModel, SendMessageError>> {
    // eslint-disable-next-line @typescript-eslint/no-this-alias -- Effect.gen generator bodies do not inherit `this`
    const self = this;
    return Effect.gen(function* () {
      const result = yield* self.createModelCoreEffect(modelString, muxProviderOptions, opts);
      if (!result.success) {
        return result;
      }

      // DevTools middleware wrappers currently support LanguageModelV3 instances only.
      if (typeof result.data === "string" || result.data.specificationVersion !== "v4") {
        return result;
      }

      let model: LanguageModel = result.data;

      const workspaceId = opts?.workspaceId;
      const devToolsService = self.devToolsService;
      if (workspaceId != null && devToolsService?.enabled) {
        const innerModel = model;
        model = wrapLanguageModel({
          model,
          middleware: createDevToolsMiddleware(workspaceId, devToolsService),
        });
        moveLanguageModelCleanup(innerModel, model);
      }

      return Ok(model);
    });
  }

  private createModelCoreEffect(
    modelString: string,
    muxProviderOptions?: MuxProviderOptions,
    opts?: {
      agentInitiated?: boolean;
      routeContext?: RouteContext;
      providersConfig?: ProvidersConfig;
    }
  ): Effect.Effect<Result<LanguageModel, SendMessageError>> {
    // eslint-disable-next-line @typescript-eslint/no-this-alias -- Effect.gen generator bodies do not inherit `this`
    const self = this;
    // The explicit annotation restores the contextual typing the old async
    // signature provided, so the wire-error literals below stay narrowed.
    const pipeline: Effect.Effect<Result<LanguageModel, SendMessageError>> = Effect.gen(
      function* () {
        // Route resolution is centralized here so every caller gets identical,
        // provider-agnostic dispatch behavior. resolveGatewayModelString is idempotent,
        // so already-routed strings pass through unchanged.
        modelString = self.resolveEffectiveModelString(
          modelString,
          opts?.routeContext,
          opts?.providersConfig
        );

        // Parse model string (format: "provider:model-id")
        const [providerName, modelId] = parseModelString(modelString);

        if (!providerName || !modelId) {
          return Err({
            type: "invalid_model_string",
            message: `Invalid model string format: "${modelString}". Expected "provider:model-id"`,
          });
        }

        // Load providers configuration - the ONLY source of truth. A caller's
        // snapshot (resolveAndCreateModel) wins so the created model matches
        // the wire/route identity that snapshot produced (see createModel).
        const providersConfig =
          opts?.providersConfig ?? self.providersConfigStore.loadProvidersConfig() ?? {};
        const providerConfigEntry = providersConfig[providerName];
        const providerIsBuiltIn = isBuiltInProvider(providerName);
        const customProviderType = isCustomProviderConfig(providerConfigEntry)
          ? providerConfigEntry.providerType
          : null;
        const providerIsCustom = customProviderType !== null;

        // Check if provider is supported. Explicit custom provider config wins
        // even if a future release adds a built-in provider with the same id.
        if (!providerIsCustom && providerIsBuiltIn) {
          if (!Object.hasOwn(PROVIDER_REGISTRY, providerName)) {
            return Err({
              type: "provider_not_supported",
              provider: providerName,
            });
          }
        } else if (!providerIsCustom) {
          return Err({
            type: "provider_not_supported",
            provider: providerName,
          });
        }

        if (self.policyService?.isEnforced()) {
          if (!self.policyService.isProviderAllowed(providerName)) {
            return Err({
              type: "policy_denied",
              message: `Provider ${providerName} is not allowed by policy`,
            });
          }

          if (!self.policyService.isModelAllowed(providerName, modelId)) {
            return Err({
              type: "policy_denied",
              message: `Model ${providerName}:${modelId} is not allowed by policy`,
            });
          }
        }

        // Backend config is authoritative for Anthropic prompt cache TTL on any
        // Anthropic-routed model (direct Anthropic, mux-gateway:anthropic/*,
        // openrouter:anthropic/*). We still allow request-level values when config
        // is unset for backward compatibility with older clients.
        const configAnthropicCacheTtl = parseAnthropicCacheTtl(providersConfig.anthropic?.cacheTtl);
        // Coder gateway instances classify by their resolved WIRE type, not the
        // route name: a custom-named Anthropic instance (coder:prod-anthropic/x)
        // is an Anthropic request that must honor the backend's authoritative
        // disableBetaFeatures/cacheTtl, while a cross-typed canonical name
        // (coder:anthropic/x fronting an OpenAI-compatible upstream) must not.
        const isCoderGatewayModel =
          providerName === "coder" && !isCustomProviderConfig(providersConfig.coder);
        const coderWire = isCoderGatewayModel
          ? resolveCoderWireCanonicalModel(
              modelId,
              providersConfig.coder as
                | { discoveredProviders?: unknown; additionalProviders?: unknown }
                | undefined
            )
          : null;
        const isAnthropicRoutedModel = isCoderGatewayModel
          ? coderWire?.origin === "anthropic"
          : customProviderType === "anthropic-messages" ||
            providerName === "anthropic" ||
            modelId.startsWith("anthropic/");

        // Anthropic-specific: merge global disableBetaFeatures into muxProviderOptions.
        const configDisableBeta = providersConfig.anthropic?.disableBetaFeatures;
        if (isAnthropicRoutedModel && configDisableBeta === true) {
          muxProviderOptions ??= {};
          muxProviderOptions.anthropic = {
            ...(muxProviderOptions.anthropic ?? {}),
            disableBetaFeatures: muxProviderOptions.anthropic?.disableBetaFeatures ?? true,
          };
        }

        if (isAnthropicRoutedModel && configAnthropicCacheTtl && muxProviderOptions) {
          muxProviderOptions.anthropic = {
            ...(muxProviderOptions.anthropic ?? {}),
            cacheTtl: configAnthropicCacheTtl,
          };
        }
        const effectiveAnthropicCacheTtl =
          muxProviderOptions?.anthropic?.cacheTtl ?? configAnthropicCacheTtl;

        // Fast is one OpenAI preference across direct and forwarding gateways.
        // Resolve it after routing, from the model's config snapshot, so pinned
        // requests cannot change tier midway through creation or on fallback.
        const serviceTier = ServiceTierSchema.safeParse(
          muxProviderOptions?.openai?.serviceTier ?? providersConfig.openai?.serviceTier
        );
        if (
          serviceTier.success &&
          openaiServiceTierAvailable(modelString, {
            providersConfig: self.providerService.getConfig(providersConfig),
            openaiWireFormat: muxProviderOptions?.openai?.wireFormat,
          })
        ) {
          muxProviderOptions ??= {};
          muxProviderOptions.openai = {
            ...muxProviderOptions.openai,
            serviceTier: serviceTier.data,
          };
        } else if (muxProviderOptions?.openai) {
          delete muxProviderOptions.openai.serviceTier;
        }

        // OpenAI-specific: merge global store setting into muxProviderOptions.
        // Coder instances classify by the instance's exact TYPE ("openai" =
        // the real OpenAI Responses upstream, where ZDR store applies): a
        // custom-named openai instance must honor providers.openai.store,
        // while a cross-typed openai-named instance must not.
        const isOpenAIRoutedModel = isCoderGatewayModel
          ? coderWire?.providerType === "openai"
          : customProviderType === "openai-responses" ||
            providerName === "openai" ||
            modelId.startsWith("openai/");
        const configOpenAIStore = providersConfig.openai?.store;
        if (isOpenAIRoutedModel && typeof configOpenAIStore === "boolean") {
          muxProviderOptions ??= {};
          muxProviderOptions.openai = {
            ...(muxProviderOptions.openai ?? {}),
            store: muxProviderOptions.openai?.store ?? configOpenAIStore,
          };
        }

        let providerConfig = providersConfig[providerName] ?? {};

        // Providers can be disabled in providers.jsonc without deleting credentials.
        if (
          providerName !== "mux-gateway" &&
          isProviderDisabledInConfig(providerConfig as { enabled?: unknown })
        ) {
          return Err({ type: "provider_disabled", provider: providerName });
        }

        // Map baseUrl to baseURL if present (SDK expects baseURL)
        const { baseUrl, ...configWithoutBaseUrl } = providerConfig;
        providerConfig = baseUrl
          ? { ...configWithoutBaseUrl, baseURL: baseUrl }
          : configWithoutBaseUrl;

        // Policy: force provider base URL (if configured).
        const forcedBaseUrl = self.policyService?.isEnforced()
          ? self.policyService.getForcedBaseUrl(providerName)
          : undefined;
        if (forcedBaseUrl) {
          providerConfig = { ...providerConfig, baseURL: forcedBaseUrl };
        }

        // Inject app attribution headers (used by OpenRouter and other compatible platforms).
        // We never overwrite user-provided values (case-insensitive header matching).
        providerConfig = {
          ...providerConfig,
          headers: buildAppAttributionHeaders(providerConfig.headers),
        };

        if (customProviderType) {
          const credentials = resolveCustomProviderCredentials(providerName, providerConfig);
          if (!credentials.ok) {
            return Err(formatCustomProviderRequirementError(providerName, credentials.error));
          }

          const providerFetch = getProviderFetch(providerConfig);
          const muxAttributionHeaders = buildAppAttributionHeaders(providerConfig.headers);
          // Custom adapters must not fall back to official-provider environment keys.
          const isolatedApiKey = credentials.apiKey ?? "";
          const customAdapterFetch =
            credentials.apiKey == null
              ? wrapFetchStrippingEmptyAuthHeaders(providerFetch)
              : providerFetch;

          switch (customProviderType) {
            case "openai-compatible": {
              // Pass only explicit OpenAI-compatible SDK settings so Xum-only config
              // fields such as models, enabled, and providerType never reach the SDK.
              const provider = createOpenAICompatible({
                name: providerName,
                baseURL: normalizeOpenAICompatibleBaseURL(credentials.baseURL),
                ...(credentials.apiKey != null ? { apiKey: credentials.apiKey } : {}),
                headers: { ...muxAttributionHeaders },
                fetch: providerFetch,
              });
              return Ok(provider(modelId));
            }
            case "openai-responses": {
              const { createOpenAI } = yield* Effect.promise(async () =>
                PROVIDER_REGISTRY.openai()
              );
              const provider = createOpenAI({
                baseURL: normalizeOpenAICompatibleBaseURL(credentials.baseURL),
                apiKey: isolatedApiKey,
                headers: { ...muxAttributionHeaders },
                fetch: customAdapterFetch,
              });
              return Ok(provider.responses(modelId));
            }
            case "anthropic-messages": {
              const { createAnthropic } = yield* Effect.promise(async () =>
                PROVIDER_REGISTRY.anthropic()
              );
              // Honor beta disablement like the built-in Anthropic path: strict
              // ZDR proxies reject cache_control when beta features are off.
              const disableBeta = muxProviderOptions?.anthropic?.disableBetaFeatures === true;
              const provider = createAnthropic({
                baseURL: normalizeAnthropicBaseURL(credentials.baseURL),
                apiKey: isolatedApiKey,
                headers: { ...muxAttributionHeaders },
                fetch: wrapFetchWithAnthropicCacheControl(
                  customAdapterFetch,
                  effectiveAnthropicCacheTtl,
                  { injectCacheControl: !disableBeta }
                ),
              });
              return Ok(provider(modelId));
            }
          }
        }

        // Handle Anthropic provider
        if (providerName === "anthropic") {
          // Resolve credentials from config + env (single source of truth)
          const creds = resolveProviderCredentials("anthropic", providerConfig);
          if (!creds.isConfigured) {
            return Err({ type: "api_key_not_found", provider: providerName });
          }

          // Build config with resolved credentials
          const configWithApiKey = creds.apiKey
            ? { ...providerConfig, apiKey: creds.apiKey }
            : providerConfig;

          // Normalize base URL to ensure /v1 suffix (SDK expects it)
          const effectiveBaseURL = configWithApiKey.baseURL ?? creds.baseUrl?.trim();
          const normalizedConfig = effectiveBaseURL
            ? { ...configWithApiKey, baseURL: normalizeAnthropicBaseURL(effectiveBaseURL) }
            : configWithApiKey;

          // 1M context beta header is injected per-request via buildRequestHeaders() →
          // streamText({ headers }), not at provider creation time. This avoids duplicating
          // header logic across direct and gateway handlers.

          // Lazy-load Anthropic provider to reduce startup time
          const { createAnthropic } = yield* Effect.promise(async () =>
            PROVIDER_REGISTRY.anthropic()
          );
          // Wrap fetch to normalize cache_control on the final Anthropic payload.
          // Use getProviderFetch to preserve any user-configured custom fetch (e.g., proxies)
          const baseFetch = getProviderFetch(providerConfig);
          const disableBeta = muxProviderOptions?.anthropic?.disableBetaFeatures === true;
          // Wrap for cache_control normalization; skip injection when beta features are off.
          const fetchWithCacheControl = wrapFetchWithAnthropicCacheControl(
            baseFetch,
            effectiveAnthropicCacheTtl,
            { injectCacheControl: !disableBeta }
          );
          const providerFetch = fetchWithCacheControl;
          const provider = createAnthropic({
            ...normalizedConfig,
            fetch: providerFetch,
          });
          return Ok(provider(modelId));
        }

        // Handle OpenAI provider (using Responses API)
        if (providerName === "openai") {
          const fullModelId = `${providerName}:${modelId}`;

          const codexOauthAllowed = isCodexOauthAllowedModel(fullModelId, providersConfig);
          const codexOauthRequired = isCodexOauthRequiredModel(fullModelId, providersConfig);

          const storedCodexOauth = parseCodexOauthAuth(
            (providerConfig as { codexOauth?: unknown }).codexOauth
          );

          // Resolve credentials from config + env so we can decide whether to
          // route through Codex OAuth or fall back to API key auth.
          const creds = resolveProviderCredentials("openai", providerConfig);

          // When a model requires Codex OAuth but the user hasn't connected it,
          // fall back to their API key instead of blocking entirely.  If the model
          // truly only works through OAuth, OpenAI's API will return a clear error.
          if (codexOauthRequired && !storedCodexOauth && !creds.isConfigured) {
            return Err({ type: "oauth_not_connected", provider: providerName });
          }

          const codexOauthDefaultAuthRaw = (providerConfig as { codexOauthDefaultAuth?: unknown })
            .codexOauthDefaultAuth;
          const codexOauthDefaultAuth = codexOauthDefaultAuthRaw === "apiKey" ? "apiKey" : "oauth";

          // Codex OAuth only serves the Responses API. Resolve the wire format
          // before choosing credentials so Chat Completions falls back to the API
          // key instead of sending the "codex-oauth" placeholder to api.openai.com.
          const earlyWireFormat =
            (providerConfig.wireFormat as string | undefined) ??
            muxProviderOptions?.openai?.wireFormat;

          // Codex OAuth routing:
          // - Chat Completions never routes through OAuth when an API key exists.
          // - Required models route through ChatGPT OAuth when connected.
          // - If OAuth is not connected, fall back to API key (if available).
          // - Allowed models route through OAuth only when:
          //   - no API key is configured, OR
          //   - the user prefers OAuth when both are set.
          const shouldRouteThroughCodexOauth = (() => {
            if (!codexOauthAllowed || !storedCodexOauth) {
              return false;
            }

            if (earlyWireFormat === "chatCompletions" && creds.isConfigured) {
              return false;
            }

            if (codexOauthRequired) {
              return true;
            }

            if (!creds.isConfigured) {
              return true;
            }

            return codexOauthDefaultAuth === "oauth";
          })();

          // OAuth requests use a placeholder key and override auth headers in fetch().
          const resolvedApiKey = shouldRouteThroughCodexOauth ? undefined : creds.apiKey;

          if (!shouldRouteThroughCodexOauth && !creds.isConfigured) {
            return Err({ type: "api_key_not_found", provider: providerName });
          }

          // Chat Completions with OAuth only (no API key to fall back to): block
          // early with a clear error instead of sending the placeholder key.
          if (shouldRouteThroughCodexOauth && earlyWireFormat === "chatCompletions") {
            return Err({ type: "api_key_not_found", provider: providerName });
          }

          // Origin-only custom base URLs get /v1 appended (same rule and
          // trailing-slash opt-out as custom openai-compatible providers) so both
          // wire formats produce /v1/... endpoint paths instead of always failing.
          const effectiveOpenAIBaseURL =
            (typeof providerConfig.baseURL === "string" ? providerConfig.baseURL : undefined) ??
            creds.baseUrl;

          // Merge resolved credentials into config
          const configWithCreds = {
            ...providerConfig,
            // When using Codex OAuth, we overwrite auth headers in fetch(), so the OpenAI API key
            // isn't required. Still pass a placeholder to ensure the SDK never reads env vars.
            apiKey: shouldRouteThroughCodexOauth ? "codex-oauth" : resolvedApiKey,
            ...(effectiveOpenAIBaseURL && {
              baseURL: normalizeOpenAICompatibleBaseURL(effectiveOpenAIBaseURL),
            }),
            ...(creds.organization && { organization: creds.organization }),
          };

          // The stored direct wire format wins over request-level preferences.
          const configWireFormat = providerConfig.wireFormat;
          if (configWireFormat === "responses" || configWireFormat === "chatCompletions") {
            muxProviderOptions ??= {};
            muxProviderOptions.openai = {
              ...muxProviderOptions.openai,
              wireFormat: configWireFormat,
            };
          }

          // Resolve effective wireFormat once — used by both fetch wrapper and model selection.
          // Includes request-level overrides from muxProviderOptions, not just config.
          const effectiveWireFormat = muxProviderOptions?.openai?.wireFormat ?? "responses";

          const baseFetch = getProviderFetch(providerConfig);
          const codexOauthService = self.oauthServices?.codexOauthService;
          const webSocketTransportEnabled =
            (providerConfig as { webSocketTransportEnabled?: unknown })
              .webSocketTransportEnabled === true;

          // Wrap fetch so Codex OAuth Responses requests are normalized before
          // they are rerouted from api.openai.com to chatgpt.com's Codex backend.
          const fetchWithOpenAICodexNormalization = Object.assign(
            async (
              input: Parameters<typeof fetch>[0],
              init?: Parameters<typeof fetch>[1]
            ): Promise<Response> => {
              try {
                const urlString = getFetchInputUrl(input);

                const method = (init?.method ?? "GET").toUpperCase();
                const isOpenAIResponses = /\/v1\/responses(\?|$)/.test(urlString);
                const isOpenAIChatCompletions = /\/chat\/completions(\?|$)/.test(urlString);

                let nextInput: Parameters<typeof fetch>[0] = input;
                let nextInit: Parameters<typeof fetch>[1] | undefined = init;
                let reroutedThroughCodexOauth = false;

                const body = init?.body;
                // Only parse the JSON body when routing through Codex OAuth, since Codex
                // requires instruction lifting, store=false, and stripping unsupported
                // Responses fields like `truncation`.
                if (
                  shouldRouteThroughCodexOauth &&
                  isOpenAIResponses &&
                  method === "POST" &&
                  typeof body === "string"
                ) {
                  try {
                    const headers = new Headers(init?.headers);
                    headers.delete("content-length");
                    // Codex derives its cache routing key from session-id, not the body key.
                    // Reuse Xum's stable scope so successive OAuth turns reach the same cache.
                    const { prompt_cache_key: promptCacheKey } = JSON.parse(body) as {
                      prompt_cache_key?: unknown;
                    };
                    if (
                      !headers.has("session-id") &&
                      typeof promptCacheKey === "string" &&
                      promptCacheKey.length > 0
                    ) {
                      // UTF-8 replaces lone surrogates before encoding project names for HTTP headers.
                      headers.set(
                        "session-id",
                        encodeURIComponent(Buffer.from(promptCacheKey).toString())
                      );
                    }
                    nextInit = {
                      ...init,
                      headers,
                      body: normalizeCodexResponsesBody(body),
                    };
                  } catch {
                    // If body isn't JSON, fall through to normal fetch (but still allow Codex routing).
                  }
                }

                if (
                  shouldRouteThroughCodexOauth &&
                  effectiveWireFormat !== "chatCompletions" &&
                  (isOpenAIResponses || isOpenAIChatCompletions)
                ) {
                  if (!codexOauthService) {
                    throw new Error("Codex OAuth service not initialized");
                  }

                  const authResult = await codexOauthService.getValidAuth();
                  if (!authResult.success) {
                    throw new Error(authResult.error);
                  }

                  const headers = new Headers(nextInit?.headers);
                  headers.set("Authorization", `Bearer ${authResult.data.access}`);
                  if (authResult.data.accountId) {
                    headers.set("ChatGPT-Account-Id", authResult.data.accountId);
                  }

                  nextInput = CODEX_ENDPOINT;
                  nextInit = { ...(nextInit ?? {}), headers };
                  reroutedThroughCodexOauth = true;
                }

                const response = await baseFetch(nextInput, nextInit);
                return reroutedThroughCodexOauth
                  ? markCodexOauthRoutedResponse(response)
                  : response;
              } catch (error) {
                // For normal OpenAI (API key) requests, fall back to the original fetch on unexpected errors.
                // For Codex OAuth routing, failures should surface (falling back would hit api.openai.com).
                if (shouldRouteThroughCodexOauth) {
                  throw error;
                }
                return baseFetch(input, init);
              }
            },
            "preconnect" in baseFetch && typeof baseFetch.preconnect === "function"
              ? {
                  preconnect: baseFetch.preconnect.bind(baseFetch),
                }
              : {}
          );

          const webSocketTransport = createOpenAIWebSocketTransportFetch({
            // Codex OAuth requests must keep using the HTTP fetch wrapper above so
            // Xum can rewrite the endpoint and attach ChatGPT OAuth headers.
            enabled:
              webSocketTransportEnabled &&
              effectiveWireFormat === "responses" &&
              !shouldRouteThroughCodexOauth,
            baseFetch: fetchWithOpenAICodexNormalization as typeof fetch,
            // The upstream WebSocket fetch defaults to api.openai.com. Pass Xum's
            // resolved base URL so custom/proxied OpenAI endpoints are not bypassed.
            webSocketUrl: resolveOpenAIWebSocketResponsesUrl(configWithCreds.baseURL),
          });

          // Lazy-load OpenAI provider to reduce startup time
          const { createOpenAI } = yield* Effect.promise(async () => PROVIDER_REGISTRY.openai());
          const provider = createOpenAI({
            ...configWithCreds,
            // Cast is safe: our fetch implementation is compatible with the SDK's fetch type.
            // The preconnect method is optional in our implementation but required by the SDK type.
            fetch: webSocketTransport.fetch,
          });
          // OpenAI reasoning state is preserved via explicit history, so no extra
          // middleware is needed beyond the provider's standard Responses handling.
          const model =
            effectiveWireFormat === "chatCompletions"
              ? provider.chat(modelId)
              : provider.responses(modelId);
          if (webSocketTransport.active) {
            attachLanguageModelCleanup(model, webSocketTransport.close);
          }

          const injectModelOpenAIStore = (storeValue: unknown, mode: "default" | "force"): void => {
            assert(typeof storeValue === "boolean", "OpenAI store override must be boolean");
            const store = storeValue;

            const injectStoreFlag = (
              options: Parameters<typeof model.doStream>[0]
            ): Parameters<typeof model.doStream>[0] => {
              const openaiOpts =
                (options.providerOptions?.openai as Record<string, unknown> | undefined) ?? {};
              return {
                ...options,
                providerOptions: {
                  ...options.providerOptions,
                  openai: mode === "force" ? { ...openaiOpts, store } : { store, ...openaiOpts },
                },
              };
            };

            const originalDoStream = model.doStream.bind(model);
            const originalDoGenerate = model.doGenerate.bind(model);
            model.doStream = (options) => originalDoStream(injectStoreFlag(options));
            model.doGenerate = (options) => originalDoGenerate(injectStoreFlag(options));
          };

          const configuredOpenAIStore = muxProviderOptions?.openai?.store;
          if (typeof configuredOpenAIStore === "boolean") {
            // Inject configured OpenAI store as a request-level default so callers
            // that omit providerOptions still honor global ZDR settings.
            injectModelOpenAIStore(configuredOpenAIStore, "default");
          }

          // Skip Codex OAuth routing for chatCompletions — the Codex endpoint
          // only accepts Responses API format, so chat-completions requests would fail.
          if (shouldRouteThroughCodexOauth && effectiveWireFormat !== "chatCompletions") {
            // OAuth can consume paid Business workspace credits. Keep API-equivalent cost estimates;
            // authentication does not prove that usage is free.
            // Apply this policy to new requests only. Do not migrate historical usage.

            // Codex OAuth requires store=false and must override any request-level
            // setting to avoid unresolved item_reference lookups.
            injectModelOpenAIStore(false, "force");
          }
          return Ok(model);
        }

        // Handle xAI provider
        if (providerName === "xai") {
          // Resolve credentials from config + env (single source of truth)
          const creds = resolveProviderCredentials("xai", providerConfig);
          if (!creds.isConfigured) {
            return Err({ type: "api_key_not_found", provider: providerName });
          }
          const resolvedApiKey = creds.apiKey;

          const baseFetch = getProviderFetch(providerConfig);
          const { apiKey: _apiKey, baseURL, headers, ...extraOptions } = providerConfig;

          const { searchParameters, serviceTier, ...restOptions } = extraOptions as {
            searchParameters?: Record<string, unknown>;
            serviceTier?: unknown;
          } & Record<string, unknown>;

          if (searchParameters && muxProviderOptions) {
            const existingXaiOverrides = muxProviderOptions.xai ?? {};
            muxProviderOptions.xai = {
              ...existingXaiOverrides,
              searchParameters:
                existingXaiOverrides.searchParameters ??
                (searchParameters as XaiProviderOptions["searchParameters"]),
            };
          }

          const configuredServiceTier =
            serviceTier === "default" || serviceTier === "priority" ? serviceTier : undefined;
          const effectiveServiceTier =
            muxProviderOptions?.xai?.serviceTier ?? configuredServiceTier;

          const { createXai } = yield* Effect.promise(async () => PROVIDER_REGISTRY.xai());
          const providerFetch = wrapFetchWithXAIServiceTier(baseFetch, effectiveServiceTier);
          const provider = createXai({
            apiKey: resolvedApiKey,
            baseURL: creds.baseUrl ?? baseURL,
            headers,
            ...restOptions,
            fetch: providerFetch,
          });
          // Frontier Grok uses the Responses API so @ai-sdk/xai surfaces exact billed
          // cost metadata (including Priority Processing). Mapped provider aliases inherit
          // that capability; older custom model strings stay on Chat Completions for
          // legacy search_parameters compatibility.
          const capabilityModel = resolveModelForMetadata(`xai:${modelId}`, providersConfig);
          const model = isGrokFrontierModel(capabilityModel)
            ? provider.responses(modelId)
            : provider.chat(modelId);

          // Frontier Grok Responses: force store=false by default so ZDR and non-ZDR share
          // one path. buildProviderOptions already defaults this; inject here too so
          // callers that omit providerOptions still get ZDR-safe requests.
          if (isGrokFrontierModel(capabilityModel)) {
            injectGrokStoreDefault(model, muxProviderOptions?.xai?.store);
          }

          return Ok(model);
        }

        // Handle Ollama provider
        if (providerName === "ollama") {
          // Ollama doesn't require API key - it's a local service
          const baseFetch = getProviderFetch(providerConfig);

          // Lazy-load Ollama provider to reduce startup time
          const { createOllama } = yield* Effect.promise(async () => PROVIDER_REGISTRY.ollama());
          const providerFetch = baseFetch;
          const provider = createOllama({
            ...providerConfig,
            fetch: providerFetch,
            // Use strict mode for better compatibility with Ollama API
            compatibility: "strict",
          });
          return Ok(provider(modelId));
        }

        // Handle OpenRouter provider
        if (providerName === "openrouter") {
          // Resolve credentials from config + env (single source of truth)
          const creds = resolveProviderCredentials("openrouter", providerConfig);
          if (!creds.isConfigured) {
            return Err({ type: "api_key_not_found", provider: providerName });
          }
          const resolvedApiKey = creds.apiKey;
          const baseFetch = getProviderFetch(providerConfig);

          // Extract standard provider settings and Xum-local metadata before building extraBody.
          // OpenRouter also has a request-level `models` fallback field capped at 3 entries; our
          // configured `models` catalog can be longer and must not be forwarded as request input.
          const {
            apiKey: _apiKey,
            baseUrl,
            headers,
            fetch: _fetch,
            models: _models,
            ...extraOptions
          } = providerConfig;

          // OpenRouter routing options that need to be nested under "provider" in API request
          // See: https://openrouter.ai/docs/features/provider-routing
          const OPENROUTER_ROUTING_OPTIONS = [
            "order",
            "allow_fallbacks",
            "only",
            "ignore",
            "require_parameters",
            "data_collection",
            "sort",
            "quantizations",
          ];

          // Build extraBody: routing options go under "provider", others stay at root
          const routingOptions: Record<string, unknown> = {};
          const otherOptions: Record<string, unknown> = {};

          for (const [key, value] of Object.entries(extraOptions)) {
            if (OPENROUTER_ROUTING_OPTIONS.includes(key)) {
              routingOptions[key] = value;
            } else {
              otherOptions[key] = value;
            }
          }

          // Build extraBody with provider nesting if routing options exist
          let extraBody: Record<string, unknown> | undefined;
          if (Object.keys(routingOptions).length > 0) {
            extraBody = { provider: routingOptions, ...otherOptions };
          } else if (Object.keys(otherOptions).length > 0) {
            extraBody = otherOptions;
          }

          // Lazy-load OpenRouter provider to reduce startup time
          const { createOpenRouter } = yield* Effect.promise(async () =>
            PROVIDER_REGISTRY.openrouter()
          );
          const providerFetch = baseFetch;
          const provider = createOpenRouter({
            apiKey: resolvedApiKey,
            baseURL: creds.baseUrl ?? baseUrl,
            headers,
            fetch: providerFetch,
            extraBody,
          });
          return Ok(provider(modelId));
        }

        // Handle Amazon Bedrock provider
        if (providerName === "bedrock") {
          // Resolve region from config + env (single source of truth)
          const creds = resolveProviderCredentials("bedrock", providerConfig);
          if (!creds.isConfigured || !creds.region) {
            return Err({ type: "api_key_not_found", provider: providerName });
          }
          const { region } = creds;

          // Optional AWS shared config profile name (equivalent to AWS_PROFILE).
          // Useful for SSO profiles when Xum isn't launched with AWS_PROFILE set.
          const profile =
            typeof providerConfig.profile === "string" && providerConfig.profile.trim()
              ? providerConfig.profile.trim()
              : undefined;

          const baseFetch = getProviderFetch(providerConfig);
          const providerFetch = baseFetch;
          const { createAmazonBedrock } = yield* Effect.promise(async () =>
            PROVIDER_REGISTRY.bedrock()
          );

          // Check if explicit credentials are provided in config
          const hasExplicitCredentials =
            providerConfig.accessKeyId && providerConfig.secretAccessKey;

          if (hasExplicitCredentials) {
            // Use explicit credentials from providers.jsonc
            const provider = createAmazonBedrock({
              ...providerConfig,
              region,
              fetch: providerFetch,
            });
            return Ok(provider(modelId));
          }

          // Check for Bedrock bearer token (simplest auth) - from config or environment
          // The SDK's apiKey option maps to AWS_BEARER_TOKEN_BEDROCK
          const bearerToken =
            typeof providerConfig.bearerToken === "string" ? providerConfig.bearerToken : undefined;

          if (bearerToken) {
            const provider = createAmazonBedrock({
              region,
              apiKey: bearerToken,
              fetch: providerFetch,
            });
            return Ok(provider(modelId));
          }

          // Check if AWS_BEARER_TOKEN_BEDROCK env var is set
          if (process.env.AWS_BEARER_TOKEN_BEDROCK) {
            // SDK automatically picks this up via apiKey option
            const provider = createAmazonBedrock({
              region,
              fetch: providerFetch,
            });
            return Ok(provider(modelId));
          }

          // Use AWS credential provider chain for flexible authentication:
          // - Environment variables (AWS_ACCESS_KEY_ID, AWS_SECRET_ACCESS_KEY)
          // - Shared credentials file (~/.aws/credentials)
          // - EC2 instance profiles
          // - ECS task roles
          // - EKS service account (IRSA)
          // - SSO credentials
          // - And more...
          const provider = createAmazonBedrock({
            region,
            credentialProvider: fromNodeProviderChain(profile ? { profile } : {}),
            fetch: providerFetch,
          });
          return Ok(provider(modelId));
        }

        // Handle Xum Gateway provider
        if (providerName === "mux-gateway") {
          // Resolve couponCode from config (single source of truth)
          const creds = resolveProviderCredentials("mux-gateway", providerConfig);
          if (!creds.isConfigured || !creds.couponCode) {
            return Err({ type: "api_key_not_found", provider: providerName });
          }
          const { couponCode } = creds;

          const { createGateway } = yield* Effect.promise(async () =>
            PROVIDER_REGISTRY["mux-gateway"]()
          );
          // For Anthropic models via gateway, normalize cache_control on the final payload.
          // Use getProviderFetch to preserve any user-configured custom fetch (e.g., proxies)
          const baseFetch = getProviderFetch(providerConfig);
          const isAnthropicModel = modelId.startsWith("anthropic/");
          const disableBeta = muxProviderOptions?.anthropic?.disableBetaFeatures === true;
          // For Anthropic models via gateway, wrap for cache_control normalization;
          // skip injection when beta features are off.
          const fetchWithCacheControl = isAnthropicModel
            ? wrapFetchWithAnthropicCacheControl(baseFetch, effectiveAnthropicCacheTtl, {
                injectCacheControl: !disableBeta,
              })
            : baseFetch;
          const fetchWithAutoLogout = wrapFetchWithMuxGatewayAutoLogout(
            fetchWithCacheControl,
            self.providerService
          );
          const providerFetch = fetchWithAutoLogout;
          // Use configured baseURL or fall back to default gateway URL
          const gatewayBaseURL =
            providerConfig.baseURL ?? "https://gateway.mux.coder.com/api/v1/ai-gateway/v1/ai";

          // 1M context beta header is injected per-request via buildRequestHeaders() →
          // streamText({ headers }), not at provider creation time.
          const gateway = createGateway({
            apiKey: couponCode,
            baseURL: gatewayBaseURL,
            fetch: providerFetch,
          });
          const model = gateway(modelId);

          // Normalize usage format from the gateway server.
          // The gateway SDK declares specificationVersion "v3", so the AI SDK core
          // expects nested v3 usage: { inputTokens: { total, ... }, outputTokens: { total, ... } }.
          // However the gateway server may return flat v2-style usage
          // (e.g. { inputTokens: 123, outputTokens: 456 }), causing
          // asLanguageModelUsage to produce undefined → 0 for all token counts.
          // These wrappers detect flat usage and convert to v3 nested format.
          // Google forwards candidatesTokenCount as flat outputTokens, which excludes
          // thoughts; other providers report output inclusive of reasoning.
          const usageOptions = { outputExcludesReasoning: modelId.startsWith("google/") };
          const originalDoStream = model.doStream.bind(model);
          model.doStream = async (options) => {
            const result = await originalDoStream(options);
            return {
              ...result,
              // Type assertion safe: the transform only modifies the shape of usage/finishReason
              // fields within existing chunks, it doesn't change the stream part types.
              stream: result.stream.pipeThrough(
                normalizeGatewayStreamUsage(usageOptions)
              ) as typeof result.stream,
            };
          };

          const originalDoGenerate = model.doGenerate.bind(model);
          model.doGenerate = async (options) => {
            const result = await originalDoGenerate(options);
            return normalizeGatewayGenerateResult(result, usageOptions);
          };

          const configuredOpenAIStore = muxProviderOptions?.openai?.store;
          if (modelId.startsWith("openai/") && typeof configuredOpenAIStore === "boolean") {
            // Inject configured OpenAI store as a request-level default for
            // gateway-routed OpenAI models when callers omit providerOptions.
            const injectStoreFlag = (
              options: Parameters<typeof model.doStream>[0]
            ): Parameters<typeof model.doStream>[0] => {
              const openaiOpts =
                (options.providerOptions?.openai as Record<string, unknown> | undefined) ?? {};
              return {
                ...options,
                providerOptions: {
                  ...options.providerOptions,
                  openai: {
                    store: configuredOpenAIStore,
                    ...openaiOpts,
                  },
                },
              };
            };

            const originalDoStream = model.doStream.bind(model);
            const originalDoGenerate = model.doGenerate.bind(model);
            model.doStream = (options) => originalDoStream(injectStoreFlag(options));
            model.doGenerate = (options) => originalDoGenerate(injectStoreFlag(options));
          }

          // Gateway-routed frontier Grok must get the same store=false default as direct xAI.
          // Route form is mux-gateway:xai/<model>; capability lookup uses canonical xai:id.
          if (modelId.startsWith("xai/")) {
            const gatewayGrokModel = `xai:${modelId.slice("xai/".length)}`;
            const capabilityModel = resolveModelForMetadata(gatewayGrokModel, providersConfig);
            if (isGrokFrontierModel(capabilityModel)) {
              injectGrokStoreDefault(model, muxProviderOptions?.xai?.store);
            }
          }

          return Ok(model);
        }

        // GitHub Copilot chooses a stock OpenAI chat model or a custom Responses model per route.
        if (providerName === "github-copilot") {
          const creds = resolveProviderCredentials(
            "github-copilot" as ProviderName,
            providerConfig
          );
          if (!creds.isConfigured) {
            return Err({ type: "api_key_not_found", provider: providerName });
          }
          const resolvedApiKey = creds.apiKey;

          const availableModels = getConfiguredProviderModelIds(providerConfig);
          if (!isCopilotModelAccessible(modelId, availableModels)) {
            return Err({
              type: "model_not_available",
              provider: providerName,
              modelId,
            });
          }

          const baseFetch = getProviderFetch(providerConfig);
          const copilotFetchFn = async (
            input: Parameters<typeof fetch>[0],
            init?: Parameters<typeof fetch>[1]
          ) => {
            const headers = new Headers(input instanceof Request ? input.headers : undefined);
            if (init?.headers) {
              for (const [key, value] of new Headers(init.headers).entries()) {
                headers.set(key, value);
              }
            }
            headers.set("Authorization", `Bearer ${resolvedApiKey ?? ""}`);
            headers.set("Openai-Intent", "conversation-edits");

            // Copilot's custom Responses serializer already builds its request.
            // Codex OAuth pruning would strip Fast, including at custom /v1 URLs.
            const nextInit: Parameters<typeof fetch>[1] = { ...init, headers };

            // Resolve request body text for billing classification.
            // Standard AI SDK path: init.body is a JSON string.
            // Request object path: clone + read body text so the original stream
            // remains intact for the real network request.
            let originalBodyText: string | undefined;
            if (typeof init?.body === "string") {
              originalBodyText = init.body;
            } else if (input instanceof Request) {
              try {
                originalBodyText = await input.clone().text();
              } catch {
                // Fall back to undefined so classifyCopilotInitiator defaults to "user".
              }
            }

            // GitHub Copilot uses X-Initiator to determine premium request billing.
            // "user" = consumes a premium request; "agent" = free (tool/agent work).
            // If the caller explicitly marked this as agent-initiated (e.g., sub-agent,
            // compaction, internal utility), skip the heuristic and always use "agent".
            const initiator =
              opts?.agentInitiated === true ? "agent" : classifyCopilotInitiator(originalBodyText);
            headers.set("X-Initiator", initiator);
            headers.delete("x-api-key");
            return baseFetch(input, nextInit);
          };
          const copilotFetch = Object.assign(copilotFetchFn, baseFetch) as typeof fetch;
          const providerFetch = copilotFetch;
          const baseURL = providerConfig.baseURL ?? "https://api.githubcopilot.com";
          const apiMode = selectCopilotApiMode(modelId);
          const outboundCopilotModelId = toCopilotModelId(modelId);
          log.debug(`GitHub Copilot model ${modelId} using ${apiMode} API mode`);

          if (apiMode === "responses") {
            // Copilot Codex models use a custom Responses language model
            // that handles Copilot's SSE stream quirks (rotating item_id,
            // text arriving via output_text.delta rather than inline).
            const model = new CopilotResponsesLanguageModel({
              modelId: outboundCopilotModelId,
              fetch: providerFetch,
              baseUrl: baseURL,
            });
            return Ok(model as LanguageModel);
          }

          const { createOpenAI } = yield* Effect.promise(async () => PROVIDER_REGISTRY.openai());
          const providerOptionsNamespace = resolveProviderOptionsNamespaceKey(
            "openai",
            "github-copilot"
          );
          const provider = createOpenAI({
            // Preserve Copilot's provider identity for usage and diagnostics.
            name: providerOptionsNamespace,
            baseURL,
            apiKey: "copilot", // placeholder, actual auth via custom fetch
            fetch: providerFetch,
          });
          return Ok(
            wrapLanguageModel({
              model: provider.chat(outboundCopilotModelId),
              middleware: {
                specificationVersion: "v4",
                // OpenAI's Chat parser reads "openai" even on a named provider.
                // Keep Copilot's public namespace, translating only at the adapter.
                transformParams: ({ params }) =>
                  Promise.resolve({
                    ...params,
                    providerOptions: {
                      ...params.providerOptions,
                      openai: {
                        ...params.providerOptions?.openai,
                        ...params.providerOptions?.[providerOptionsNamespace],
                      },
                    },
                  }),
              },
            })
          );
        }

        // Coder AI Bridge: per-origin endpoints under <deployment>/api/v2/aibridge,
        // authenticated with Coder OAuth access tokens (refreshed per request).
        if (providerName === "coder") {
          // Policy: an enforced forcedBaseUrl must win over the user-editable
          // deploymentUrl, otherwise Coder traffic would bypass the policy-locked
          // endpoint. Apply the forced URL BEFORE credential resolution (see
          // coderEffectiveProviderConfig): credentials are issuer-bound, and
          // tokens minted by any other deployment fail closed as "not
          // configured". The login flow itself targets the forced URL
          // (CoderOauthService is policy-aware), so re-login produces matching
          // credentials.
          const creds = resolveProviderCredentials(
            "coder",
            self.coderEffectiveProviderConfig(providerConfig)
          );
          if (!creds.isConfigured || !creds.deploymentUrl) {
            return Err({ type: "api_key_not_found", provider: providerName });
          }
          const deploymentUrl = creds.deploymentUrl;

          const coderOauthService = self.oauthServices?.coderOauthService;
          if (!coderOauthService) {
            return Err({
              type: "invalid_model_string",
              message: "Coder OAuth service not initialized",
            });
          }

          // Model IDs are <providerName>/<modelId> (mux-gateway style) because
          // the gateway has no cross-provider routing: each configured provider
          // instance is mounted at /<name>/... and only serves its own wire
          // format. The FIRST slash separates the instance name (names cannot
          // contain slashes) from the upstream model ID (which can — e.g.
          // OpenRouter's vendor/model IDs). The instance's type — from the
          // discovered provider list, the user-managed additionalProviders
          // escape hatch, or the default name === type convention — selects the
          // wire protocol to speak.
          const separatorIndex = modelId.indexOf("/");
          const gatewayProviderName = separatorIndex > 0 ? modelId.slice(0, separatorIndex) : "";
          const originModelId = separatorIndex > 0 ? modelId.slice(separatorIndex + 1) : "";
          const gatewayProvider = gatewayProviderName
            ? resolveCoderGatewayProvider(
                gatewayProviderName,
                parseCoderGatewayProviders(
                  (providerConfig as { discoveredProviders?: unknown }).discoveredProviders
                ),
                parseCoderGatewayProviders(
                  (providerConfig as { additionalProviders?: unknown }).additionalProviders
                )
              )
            : null;
          if (!gatewayProvider || !originModelId) {
            return Err({
              type: "invalid_model_string",
              message: `Invalid Coder model "${modelId}". Expected coder:<provider>/<model> where <provider> is an AI Gateway provider on the deployment (e.g. coder:anthropic/<model>). Unknown provider names can be declared under the coder provider's additionalProviders setting.`,
            });
          }
          const wire = coderGatewayWireProtocol(gatewayProvider.type);
          if (!wire) {
            return Err({
              type: "invalid_model_string",
              message: `The Coder AI Gateway provider "${gatewayProvider.name}" (type ${gatewayProvider.type}) is not supported by Xum.`,
            });
          }

          // Per-request auth wrapper: getValidAuth() transparently refreshes and
          // persists rotated tokens, so long sessions never send stale tokens.
          const baseFetch = getProviderFetch(providerConfig);
          const policyService = self.policyService;
          // Policy recheck per REQUEST, not just at model creation: an
          // enforced policy can refresh mid-stream (or during the awaited
          // setup between resolveAndCreateModel and the first fetch) to deny
          // Coder or this model. getValidAuth() only validates the
          // credential/issuer, so without this gate the wrapper would keep
          // attaching the OAuth token and bypass the newly effective
          // restriction for the remainder of a long multi-step stream.
          const assertCoderModelAllowedByPolicy = () => {
            if (
              policyService?.isEnforced() &&
              (!policyService.isProviderAllowed("coder") ||
                !policyService.isModelAllowed("coder", modelId))
            ) {
              throw new Error(`Model coder:${modelId} is not allowed by policy`);
            }
          };
          const coderFetchFn = async (
            input: Parameters<typeof fetch>[0],
            init?: Parameters<typeof fetch>[1]
          ) => {
            // Fail fast before the (possibly slow) token round-trip below.
            assertCoderModelAllowedByPolicy();
            const authResult = await coderOauthService.getValidAuth();
            if (!authResult.success) {
              throw new Error(authResult.error);
            }
            // This model instance captured its deployment URL at creation time.
            // If the user has since logged in to a DIFFERENT deployment, the
            // current credential must not be attached to this model's (old) base
            // URL — that would send the new deployment's bearer token to the old
            // host. Fail the request instead; a freshly created model picks up
            // the new deployment.
            if (authResult.data.deploymentUrl !== deploymentUrl) {
              throw new Error(
                "Coder deployment changed since this model was created. Retry the request."
              );
            }
            // Recheck AFTER the await: getValidAuth() can spend tens of seconds
            // refreshing an expired token and waiting for cross-process file
            // locks. A policy refresh landing during that window must not be
            // bypassed by a check that passed before the await.
            assertCoderModelAllowedByPolicy();

            const headers = new Headers(input instanceof Request ? input.headers : undefined);
            if (init?.headers) {
              for (const [key, value] of new Headers(init.headers).entries()) {
                headers.set(key, value);
              }
            }
            headers.set("Authorization", `Bearer ${authResult.data.access}`);
            // The Anthropic SDK authenticates via x-api-key; the bridge reads the
            // Bearer token instead, so drop the placeholder key.
            headers.delete("x-api-key");
            return baseFetch(input, { ...init, headers });
          };
          const coderFetch = Object.assign(coderFetchFn, baseFetch) as typeof fetch;

          const gatewayBaseUrl = coderAibridgeBaseUrl(deploymentUrl, gatewayProvider.name);
          if (wire === "anthropic") {
            const disableBeta = muxProviderOptions?.anthropic?.disableBetaFeatures === true;
            // Same cache_control normalization as direct Anthropic / mux-gateway:
            // the bridge forwards origin-shaped payloads to the real Anthropic API.
            const providerFetch = wrapFetchWithAnthropicCacheControl(
              coderFetch,
              effectiveAnthropicCacheTtl,
              { injectCacheControl: !disableBeta }
            );
            const { createAnthropic } = yield* Effect.promise(async () =>
              PROVIDER_REGISTRY.anthropic()
            );
            const provider = createAnthropic({
              apiKey: "coder", // placeholder; real auth injected by the fetch wrapper
              baseURL: gatewayBaseUrl,
              fetch: providerFetch,
            });
            return Ok(provider(originModelId));
          }

          const { createOpenAI } = yield* Effect.promise(async () => PROVIDER_REGISTRY.openai());
          const provider = createOpenAI({
            apiKey: "coder", // placeholder; real auth injected by the fetch wrapper
            baseURL: gatewayBaseUrl,
            fetch: coderFetch,
          });
          // The gateway intercepts both /responses and /chat/completions. Real
          // OpenAI upstreams get the Responses API to match Xum's default OpenAI
          // wire format; the other OpenAI-wire provider types front
          // OpenAI-compatible upstreams where only /chat/completions can be
          // assumed (see coderGatewayWireProtocol).
          return Ok(
            wire === "openai-responses"
              ? provider.responses(originModelId)
              : provider.chat(originModelId)
          );
        }

        // Generic handler for simple providers (standard API key + factory pattern)
        // Providers with custom logic (anthropic, openai, xai, ollama, openrouter, bedrock, mux-gateway,
        // github-copilot) are handled explicitly above. New providers using the standard pattern need
        // only be added to PROVIDER_DEFINITIONS - no code changes required here.
        const providerDef = PROVIDER_DEFINITIONS[providerName as ProviderName];
        if (providerDef) {
          // Resolve credentials from config + env (single source of truth)
          const creds = resolveProviderCredentials(providerName as ProviderName, providerConfig);
          if (providerDef.requiresApiKey && !creds.isConfigured) {
            return Err({ type: "api_key_not_found", provider: providerName });
          }
          const resolvedApiKey = creds.apiKey;

          // Lazy-load and create provider using factoryName from definition
          // eslint-disable-next-line local/no-chained-type-assertions -- grandfathered when the rule was introduced; fix the underlying type instead of copying this pattern
          const providerModule = (yield* Effect.promise(async () =>
            providerDef.import()
          )) as unknown as Record<
            string,
            (config: Record<string, unknown>) => (modelId: string) => LanguageModel
          >;
          const factory = providerModule[providerDef.factoryName];
          if (!factory) {
            return Err({
              type: "provider_not_supported",
              provider: providerName,
            });
          }

          // Merge resolved credentials into config
          const configWithCreds = {
            ...providerConfig,
            ...(resolvedApiKey && { apiKey: resolvedApiKey }),
            ...(creds.baseUrl && !providerConfig.baseURL && { baseURL: creds.baseUrl }),
          };

          const providerFetch = getProviderFetch(providerConfig);
          const provider = factory({
            ...configWithCreds,
            fetch: providerFetch,
          });
          return Ok(provider(modelId));
        }

        return Err({
          type: "provider_not_supported",
          provider: providerName,
        });
      }
    );
    return pipeline.pipe(
      // Parity with the pre-Effect whole-pipeline try/catch: any throw —
      // synchronous (SDK constructors, URL parsing) or a rejected provider
      // module import — folds into the same "unknown" wire error. Defects
      // carry the raw thrown value, so getErrorMessage sees the identical
      // error the old catch block received.
      Effect.catchDefect((error) => {
        const errorMessage = getErrorMessage(error);
        return Effect.succeed(
          Err<SendMessageError>({ type: "unknown", raw: `Failed to create model: ${errorMessage}` })
        );
      })
    );
  }

  /** Create a model and its complete request options from one config/route decision. */
  async createModelWithPinnedOptions(
    modelString: string,
    opts?: {
      thinkingLevel?: ThinkingLevel;
      providerOptions?: MuxProviderOptions;
      agentInitiated?: boolean;
      workspaceId?: string;
    }
  ): Promise<Result<PinnedModelOptions, SendMessageError>> {
    const providersConfig = this.providersConfigStore.loadProvidersConfig() ?? {};
    const optionsProvidersConfig = this.providerService.getConfig(providersConfig);
    const optionsMuxProviderOptions = structuredClone(opts?.providerOptions ?? {});
    const result = await this.resolveAndCreateModel(
      modelString,
      opts?.thinkingLevel,
      optionsMuxProviderOptions,
      {
        agentInitiated: opts?.agentInitiated,
        workspaceId: opts?.workspaceId,
        providersConfig,
      }
    );
    if (!result.success) return result;

    if (result.data.coderWire?.origin === "openai") {
      // Coder's SDK protocol comes from the selected instance, not direct
      // OpenAI preferences (or a caller's requested wire format).
      optionsMuxProviderOptions.openai = {
        ...optionsMuxProviderOptions.openai,
        wireFormat:
          result.data.coderWire.providerType === "openai" ? "responses" : "chatCompletions",
      };
    }

    const onCoderRoute = result.data.effectiveModelString.startsWith("coder:");
    const custom = isCustomProviderConfig(providersConfig[modelString.split(":", 1)[0]]);
    // Preserve scoped aliases on Coder/custom routes, but fallback options and
    // pricing must follow the provider that actually created the model.
    const fallbackModel = normalizeToCanonical(result.data.effectiveModelString);
    const optionsModelString =
      modelString.startsWith("coder:") && !custom && !onCoderRoute ? fallbackModel : modelString;
    return Ok({
      model: result.data.model,
      effectiveModelString: result.data.effectiveModelString,
      wireProviderName: result.data.wireProviderName,
      metadataModel: resolveModelForMetadata(
        custom || onCoderRoute ? modelString : fallbackModel,
        providersConfig
      ),
      optionsModelString,
      optionsProvidersConfig,
      optionsMuxProviderOptions,
      optionsRouteProvider: result.data.routeProvider,
    });
  }

  /**
   * Resolve model string (xAI variant mapping + gateway routing) and create the model.
   *
   * Combines the xAI thinking-level variant swap, gateway resolution, and model
   * creation into a single call. Previously this logic was inlined in
   * `AIService.streamMessage()`.
   *
   * @returns On success: the created model + resolution metadata.
   */
  resolveAndCreateModel(
    modelString: string,
    thinkingLevel: ThinkingLevel | undefined,
    muxProviderOptions?: MuxProviderOptions,
    opts?: Pick<CreateModelOptions, "agentInitiated" | "workspaceId" | "providersConfig">
  ): Promise<Result<ResolveAndCreateModelResult, SendMessageError>> {
    return Effect.runPromise(
      this.resolveAndCreateModelEffect(modelString, thinkingLevel, muxProviderOptions, opts)
    );
  }

  private resolveAndCreateModelEffect(
    modelString: string,
    thinkingLevel: ThinkingLevel | undefined,
    muxProviderOptions?: MuxProviderOptions,
    opts?: Pick<CreateModelOptions, "agentInitiated" | "workspaceId" | "providersConfig">
  ): Effect.Effect<Result<ResolveAndCreateModelResult, SendMessageError>> {
    // eslint-disable-next-line @typescript-eslint/no-this-alias -- Effect.gen generator bodies do not inherit `this`
    const self = this;
    return Effect.gen(function* () {
      // Shadow check on the RAW prefix, BEFORE the first normalization: a custom
      // OpenAI-compatible provider can shadow a built-in gateway id (an upgraded
      // install may already have one named "coder"). normalizeToCanonical would
      // rewrite e.g. coder:openai/foo to openai:foo and silently route it
      // through the built-in machinery instead of the user's custom endpoint.
      // The equivalent guard in resolveGatewayModelString only protects callers
      // that pass raw strings.
      const providersConfigForShadowCheck =
        opts?.providersConfig ?? self.providersConfigStore.loadProvidersConfig() ?? {};
      const [rawProviderName] = parseModelString(modelString);
      const rawPrefixShadowedByCustomProvider =
        rawProviderName.length > 0 &&
        isCustomProviderConfig(providersConfigForShadowCheck[rawProviderName]);

      const explicitGateway = rawPrefixShadowedByCustomProvider
        ? undefined
        : getExplicitGatewayProvider(modelString);
      const canonicalModelString = rawPrefixShadowedByCustomProvider
        ? modelString
        : normalizeToCanonical(modelString);
      let effectiveModelString = canonicalModelString;
      const [canonicalProviderName, canonicalModelId] = parseModelString(canonicalModelString);

      // xAI Grok: swap between reasoning and non-reasoning variants based on thinking level.
      // An unset level preserves createModel's no-variant-selection behavior for headless callers.
      // xAI only supports full reasoning (no medium/low).
      if (
        thinkingLevel != null &&
        canonicalProviderName === "xai" &&
        canonicalModelId === "grok-4-1-fast"
      ) {
        const variant =
          thinkingLevel !== "off" ? "grok-4-1-fast-reasoning" : "grok-4-1-fast-non-reasoning";
        effectiveModelString = `xai:${variant}`;
      }

      // Coder selections resolve routes in two metadata-aware steps, because
      // name-based canonicalization misidentifies instances whose name and
      // type diverge ({name: "openai", type: "anthropic"}):
      // 1. The explicit gateway restore checks accessibility with the RAW
      //    instance-name gateway ID — the static toGatewayModelId
      //    reconstruction cannot restore instance-name prefixes
      //    (prod-anthropic) and would rebuild cross-typed names under the
      //    wrong origin.
      // 2. The FALLBACK identity (coder unavailable, or model excluded by the
      //    authoritative catalog) is seeded from the instance TYPE via
      //    provider metadata: an anthropic-typed instance falls back to
      //    direct Anthropic, not to whatever provider its name resembles.
      const rawCoderGatewayModelId =
        rawProviderName === "coder" && !rawPrefixShadowedByCustomProvider
          ? modelString.slice(modelString.indexOf(":") + 1)
          : null;
      const coderMetadataCanonical =
        rawCoderGatewayModelId != null
          ? resolveCoderGatewayMetadataModel(modelString, providersConfigForShadowCheck)
          : null;
      const routeSeedModelString = (() => {
        if (
          coderMetadataCanonical != null &&
          Object.hasOwn(
            PROVIDER_REGISTRY,
            coderMetadataCanonical.slice(0, coderMetadataCanonical.indexOf(":"))
          )
        ) {
          return coderMetadataCanonical;
        }
        if (rawCoderGatewayModelId != null) {
          const wire = resolveCoderWireCanonicalModel(
            rawCoderGatewayModelId,
            providersConfigForShadowCheck.coder as
              | { discoveredProviders?: unknown; additionalProviders?: unknown }
              | undefined
          );
          if (wire) {
            // Known but UNMAPPABLE instance (openai-compat fronts arbitrary
            // upstreams; vendor-less vercel IDs carry no catalog identity):
            // keep the raw gateway-scoped seed. A canonical-named cross-typed
            // instance ({name: "anthropic", type: "openai-compat"}) would
            // otherwise seed the name-derived anthropic:<model> identity and
            // silently fall back to direct Anthropic when Coder is
            // disconnected or the catalog rejects the model — the equivalent
            // custom-named instance (coder:llm-proxy/x) is rejected instead.
            return modelString;
          }
        }
        return canonicalModelString;
      })();

      const routeContext = self.resolveModelRoute(
        routeSeedModelString,
        providersConfigForShadowCheck
      );
      if (rawCoderGatewayModelId != null) {
        const appConfig = self.config.loadConfigOrDefault();
        const isGatewayModelAccessible = createGatewayModelAccessibilityChecker(
          providersConfigForShadowCheck,
          self.policyService
        );
        const coderProviderRoutable = self.isProviderAvailableForRouting(
          "coder",
          providersConfigForShadowCheck,
          appConfig
        );
        const coderModelAccessible = isGatewayModelAccessible("coder", rawCoderGatewayModelId);
        if (coderProviderRoutable && coderModelAccessible) {
          effectiveModelString = modelString;
        } else if (routeSeedModelString.startsWith("coder:")) {
          // The instance type has no distinct canonical fallback identity
          // (openai-compat and copilot front arbitrary upstreams; vendor-less
          // vercel IDs are unmappable), so falling away from the gateway is
          // never valid for this selection.
          if (coderProviderRoutable) {
            // The authoritative catalog / removedModels tombstone / policy
            // conclusively rejected this gateway model. Feeding the rejected
            // coder: identity back into route resolution would land on the
            // last-resort direct Coder route and send the request through the
            // gateway anyway, bypassing the rejection.
            return Err({
              type: "model_not_available",
              provider: "coder",
              modelId: rawCoderGatewayModelId,
            });
          }
          // Coder disconnected/disabled: surface the coder route's own
          // unavailability directly. Letting routing continue would
          // name-canonicalize the selection (createModel re-resolves the
          // gateway string) and silently send e.g. {name: "anthropic",
          // type: "openai-compat"} to direct Anthropic when direct
          // credentials exist.
          return Err(
            isProviderDisabledInConfig(
              (providersConfigForShadowCheck.coder ?? {}) as { enabled?: unknown }
            )
              ? { type: "provider_disabled", provider: "coder" }
              : { type: "api_key_not_found", provider: "coder" }
          );
        } else {
          effectiveModelString = self.resolveGatewayModelString(
            routeSeedModelString,
            routeContext,
            undefined,
            providersConfigForShadowCheck
          );
        }
      } else {
        effectiveModelString = self.resolveGatewayModelString(
          effectiveModelString,
          routeContext,
          explicitGateway,
          providersConfigForShadowCheck
        );
      }

      // Custom providers own their canonical prefix (including shadowed
      // built-in ids); their requests are always direct, never gateway-routed.
      const canonicalCustomEntry = providersConfigForShadowCheck[canonicalProviderName];
      const canonicalIsCustomProvider = isCustomProviderConfig(canonicalCustomEntry);

      // Stream result normalization currently only understands Xum gateway responses,
      // so keep this flag mux-gateway-specific until the downstream normalization path
      // is generalized too. A custom provider shadowing the mux-gateway id is
      // direct: gateway attribution/quota handling must not engage for it.
      const routedThroughGateway =
        !canonicalIsCustomProvider && effectiveModelString.startsWith("mux-gateway:");
      const [effectiveRouteProvider] = parseModelString(effectiveModelString);
      const routeProvider = Object.hasOwn(PROVIDER_REGISTRY, effectiveRouteProvider)
        ? (effectiveRouteProvider as ProviderName)
        : routeContext.routeProvider;

      // Wire-canonical provider for message preparation and options namespaces:
      // a Coder gateway request sends instance-type-shaped bytes (e.g.
      // Anthropic messages), so Anthropic-only reasoning transforms, PDF
      // sanitization, and namespace merging must key on the wire — keying them
      // on "coder" silently skips them. Derived from the EFFECTIVE route, not
      // the raw selection: instance metadata applies only when the request
      // actually goes through the Coder gateway. A cross-typed canonical name
      // (coder:openai/<model>, type anthropic) resolves to the Anthropic wire
      // while routed through Coder, but when the catalog gate rejects the
      // instance and routing falls back to direct OpenAI, the wire must be
      // OpenAI — Anthropic transforms against a direct OpenAI request would be
      // invalid. Shadowed prefixes keep the custom provider's identity.
      let wireProviderName = canonicalProviderName;
      let coderWire:
        | { origin: "anthropic" | "openai"; modelId: string; providerType: string }
        | undefined;
      if (
        effectiveRouteProvider === "coder" &&
        !isCustomProviderConfig(providersConfigForShadowCheck.coder)
      ) {
        const wire = resolveCoderWireCanonicalModel(
          effectiveModelString.slice(effectiveModelString.indexOf(":") + 1),
          providersConfigForShadowCheck.coder as
            | { discoveredProviders?: unknown; additionalProviders?: unknown }
            | undefined
        );
        if (wire) {
          wireProviderName = wire.origin;
          coderWire = wire;
        }
      } else if (
        rawCoderGatewayModelId != null &&
        routeSeedModelString !== canonicalModelString &&
        // Known-but-unmappable instances keep a raw coder:-scoped seed; its
        // name-canonical origin says nothing about the wire (the instance type
        // does), and the first branch already resolved the wire when the
        // request stayed on the coder route.
        !routeSeedModelString.startsWith("coder:")
      ) {
        // A Coder selection that fell back to its type-derived route: the wire
        // follows the fallback identity, not the name-based canonical string —
        // a cross-typed coder:openai/<claude> routed to direct Anthropic must
        // get Anthropic transforms. The seed can itself be gateway-scoped
        // (a bedrock-typed instance seeds bedrock:anthropic.<model>), so take
        // the seed's CANONICAL origin — the same identity a direct selection
        // of that seed would prepare with (bedrock → anthropic) — instead of
        // its prefix, which would skip Anthropic-specific transforms for the
        // Anthropic-shaped bytes behind the fallback route.
        const [seedOrigin] = parseModelString(normalizeToCanonical(routeSeedModelString));
        if (seedOrigin) {
          wireProviderName = seedOrigin;
        }
      }

      // Custom providers speak the wire their providerType selects: an
      // anthropic-messages provider sends Anthropic-shaped bytes, so Anthropic
      // reasoning transforms and options namespaces must key on the wire, not
      // the custom prefix (same rationale as the Coder-gateway remap above).
      // Must mirror resolveOptionsCanonicalModel so the extras-merge namespace
      // key matches what buildProviderOptions computes internally.
      if (canonicalIsCustomProvider) {
        const customWireOrigin = customProviderWireOrigin(canonicalCustomEntry.providerType);
        if (customWireOrigin) {
          wireProviderName = customWireOrigin;
        }
      }

      const modelResult = yield* self.createModelEffect(effectiveModelString, muxProviderOptions, {
        ...opts,
        routeContext,
        // ONE config snapshot for the whole resolve+create: the wire snapshot
        // above and the SDK model must come from the same providers.jsonc read,
        // or a concurrent instance-type change makes them describe different
        // wires.
        providersConfig: providersConfigForShadowCheck,
      });
      if (!modelResult.success) {
        return Err(modelResult.error);
      }

      // Selected-instance snapshot for raw coder: selections, resolved from
      // the same config read as routing — independent of the effective route,
      // so fallback-away requests can also pin the instance type.
      const coderSelectedInstance = (() => {
        if (rawCoderGatewayModelId == null) {
          return undefined;
        }
        const separator = rawCoderGatewayModelId.indexOf("/");
        if (separator <= 0) {
          return undefined;
        }
        const coderSection = providersConfigForShadowCheck.coder as
          | { discoveredProviders?: unknown; additionalProviders?: unknown }
          | undefined;
        return (
          resolveCoderGatewayProvider(
            rawCoderGatewayModelId.slice(0, separator),
            parseCoderGatewayProviders(coderSection?.discoveredProviders),
            parseCoderGatewayProviders(coderSection?.additionalProviders)
          ) ?? undefined
        );
      })();

      return Ok({
        model: modelResult.data,
        effectiveModelString,
        canonicalModelString,
        canonicalProviderName,
        canonicalModelId,
        wireProviderName,
        coderWire,
        coderSelectedInstance,
        routedThroughGateway,
        // Custom adapters are direct routes: the raw custom id is not a
        // ProviderName, and leaking it as routeProvider makes downstream
        // namespace/format selection treat the request as a transforming
        // gateway (empty provider options, suppressed Anthropic headers).
        routeProvider: canonicalIsCustomProvider ? undefined : routeProvider,
      });
    });
  }

  private resolveModelRoute(
    canonicalModel: string,
    providersConfigSnapshot?: ProvidersConfig
  ): RouteContext {
    const config = this.config.loadConfigOrDefault();
    // resolveAndCreateModel passes its snapshot so route availability,
    // accessibility, the wire snapshot, and model creation all read one
    // providers.jsonc state (see createModel's providersConfig option).
    const providersConfig =
      providersConfigSnapshot ?? this.providersConfigStore.loadProvidersConfig() ?? {};
    const isGatewayModelAccessible = createGatewayModelAccessibilityChecker(
      providersConfig,
      this.policyService
    );
    return resolveRoute(
      canonicalModel,
      config.routePriority ?? ["direct"],
      config.routeOverrides ?? {},
      (provider) => {
        if (!Object.hasOwn(PROVIDER_REGISTRY, provider)) {
          return false;
        }

        return this.isProviderAvailableForRouting(
          provider as ProviderName,
          providersConfig,
          config
        );
      },
      isGatewayModelAccessible
    );
  }

  /**
   * The route-resolution preamble used by createModel, exposed so callers can
   * recompute the EFFECTIVE model string the factory dispatched on (from the
   * same providers-config snapshot). Needed for identity decisions such as
   * headless usage metadata: a coder: selection can fall away to a direct
   * provider when the gateway is unavailable, and identities derived from the
   * raw selection would then diverge from the model actually created.
   */
  resolveEffectiveModelString(
    modelString: string,
    routeContext?: RouteContext,
    providersConfig?: ProvidersConfig
  ): string {
    const explicitGateway = getExplicitGatewayProvider(modelString);
    return this.resolveGatewayModelString(
      modelString,
      routeContext,
      explicitGateway,
      providersConfig
    );
  }

  resolveGatewayModelString(
    modelString: string,
    modelKeyOrRouteContext?: string | RouteContext,
    explicitGatewayOrLegacyFlag?: ProviderName | boolean,
    providersConfigSnapshot?: ProvidersConfig
  ): string {
    // Legacy callers may still pass boolean true to mean an explicit mux-gateway request.
    const explicitGateway: ProviderName | undefined =
      explicitGatewayOrLegacyFlag === true
        ? "mux-gateway"
        : typeof explicitGatewayOrLegacyFlag === "string"
          ? explicitGatewayOrLegacyFlag
          : undefined;

    // Same single-snapshot rule as resolveModelRoute: callers holding one
    // providers.jsonc read pass it so routing cannot diverge from it.
    const providersConfig =
      providersConfigSnapshot ?? this.providersConfigStore.loadProvidersConfig() ?? {};

    // Shadow check on the RAW prefix, BEFORE gateway canonicalization: a
    // custom provider can shadow a built-in gateway id
    // (an upgraded install may already have one named "coder"). Left to the
    // canonical check below, fromGatewayModelId would rewrite
    // coder:openai/foo to openai:foo first and silently route it through
    // the built-in machinery instead of the user's custom endpoint.
    const [rawProviderName] = parseModelString(modelString);
    if (rawProviderName && isCustomProviderConfig(providersConfig[rawProviderName])) {
      return modelString;
    }

    // Backend-authoritative routing avoids frontend localStorage races (issue #1769).
    const canonicalModelString = normalizeToCanonical(modelString);
    const [originProviderName, originModelId] = parseModelString(canonicalModelString);

    if (!originProviderName || !originModelId) {
      return canonicalModelString;
    }

    if (originProviderName === "mux-gateway") {
      return canonicalModelString;
    }

    if (isCustomProviderConfig(providersConfig[originProviderName])) {
      // Manual providers.jsonc edits can shadow a built-in provider id. Custom providers
      // are direct-only, so keep the user's model pointed at the custom endpoint.
      return canonicalModelString;
    }

    if (!Object.hasOwn(PROVIDER_REGISTRY, originProviderName)) {
      return canonicalModelString;
    }

    const originProvider = originProviderName as ProviderName;
    const config = this.config.loadConfigOrDefault();
    const isGatewayModelAccessible = createGatewayModelAccessibilityChecker(
      providersConfig,
      this.policyService
    );
    const routeContext =
      typeof modelKeyOrRouteContext === "object" && modelKeyOrRouteContext != null
        ? modelKeyOrRouteContext
        : resolveRoute(
            typeof modelKeyOrRouteContext === "string"
              ? normalizeToCanonical(modelKeyOrRouteContext)
              : canonicalModelString,
            config.routePriority ?? ["direct"],
            config.routeOverrides ?? {},
            (provider) => {
              if (!Object.hasOwn(PROVIDER_REGISTRY, provider)) {
                return false;
              }

              return this.isProviderAvailableForRouting(
                provider as ProviderName,
                providersConfig,
                config
              );
            },
            isGatewayModelAccessible
          );

    let resolvedRouteProvider = routeContext.routeProvider;

    // Preserve an explicit gateway prefix from the raw model string when that
    // gateway can still route the canonical origin. This keeps deliberate
    // gateway selections from being silently rewritten after canonicalization.
    if (
      explicitGateway != null &&
      this.isProviderAvailableForRouting(explicitGateway, providersConfig, config)
    ) {
      const explicitGatewayDefinition = PROVIDER_DEFINITIONS[explicitGateway];
      if (explicitGatewayDefinition.kind === "gateway") {
        const explicitGatewayRoutes = explicitGatewayDefinition.routes as readonly ProviderName[];
        // Authoritative-catalog gate: restoring the explicit gateway must
        // apply the same accessibility check as resolveRoute, or an explicit
        // coder:<origin>/<model> absent from the discovered catalog would be
        // sent to AI Bridge (and fail there) instead of using the fallback
        // route already resolved above.
        const explicitGatewayModelId =
          explicitGatewayDefinition.toGatewayModelId?.(originProvider, originModelId) ??
          originModelId;
        if (
          explicitGatewayRoutes.includes(originProvider) &&
          isGatewayModelAccessible(explicitGateway, explicitGatewayModelId)
        ) {
          resolvedRouteProvider = explicitGateway;
        }
      }
    }

    if (resolvedRouteProvider === originProvider) {
      return canonicalModelString;
    }

    const routeDefinition = PROVIDER_DEFINITIONS[resolvedRouteProvider];

    if (routeDefinition.kind !== "gateway") {
      return canonicalModelString;
    }

    const gatewayRoutes: readonly ProviderName[] = routeDefinition.routes;
    if (!gatewayRoutes.includes(originProvider)) {
      return canonicalModelString;
    }

    if (!("toGatewayModelId" in routeDefinition) || !routeDefinition.toGatewayModelId) {
      return canonicalModelString;
    }

    return `${resolvedRouteProvider}:${routeDefinition.toGatewayModelId(originProvider, originModelId)}`;
  }
}

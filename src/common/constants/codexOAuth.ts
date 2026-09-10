/**
 * Codex OAuth constants and helpers.
 *
 * Codex (ChatGPT subscription) authentication uses ChatGPT OAuth tokens rather
 * than a standard OpenAI API key.
 *
 * This module is intentionally shared (common/) so both the backend and future
 * UI can reference the same endpoints and model gating rules.
 */

import {
  resolveModelForMetadata,
  type ProviderModelsConfig,
} from "@/common/utils/providers/modelEntries";

// NOTE: These endpoints + params follow the OpenCode Codex OAuth guide.
// If OpenAI changes them, keep all updates centralized here.

export const CODEX_OAUTH_ORIGIN = "https://auth.openai.com";

// Public OAuth client id for ChatGPT/Codex flows.
//
// The exact value is not a secret, but it is intentionally centralized so we
// can update it without hunting through backend/UI code.
export const CODEX_OAUTH_CLIENT_ID = "app_EMoamEEZ73f0CkXaXp7hrann";

export const CODEX_OAUTH_AUTHORIZE_URL = `${CODEX_OAUTH_ORIGIN}/oauth/authorize`;
export const CODEX_OAUTH_TOKEN_URL = `${CODEX_OAUTH_ORIGIN}/oauth/token`;

// ChatGPT subscription endpoint for Codex-flavored requests.
//
// IMPORTANT: This is *not* the public OpenAI platform endpoint (api.openai.com).
// Codex OAuth tokens are only valid against this ChatGPT backend.
export const CODEX_ENDPOINT = "https://chatgpt.com/backend-api/codex/responses";

// Marks error responses that the provider fetch wrapper rerouted to the Codex
// backend. The reroute happens inside fetch, AFTER the SDK fixes the request
// URL it reports on APICallError, so error consumers cannot infer the actual
// endpoint from the URL alone.
export const CODEX_OAUTH_ROUTED_HEADER = "x-xum-codex-oauth-routed";

// We request offline_access to receive refresh tokens.
export const CODEX_OAUTH_SCOPE = "openid profile email offline_access";

// Desktop browser redirect URI used by the simplified flow.
export const CODEX_OAUTH_BROWSER_REDIRECT_URI = "http://localhost:1455/auth/callback";

// Codex-specific device auth endpoints.
export const CODEX_OAUTH_DEVICE_USERCODE_URL = `${CODEX_OAUTH_ORIGIN}/api/accounts/deviceauth/usercode`;
export const CODEX_OAUTH_DEVICE_TOKEN_POLL_URL = `${CODEX_OAUTH_ORIGIN}/api/accounts/deviceauth/token`;
export const CODEX_OAUTH_DEVICE_VERIFY_URL = `${CODEX_OAUTH_ORIGIN}/codex/device`;

export function buildCodexAuthorizeUrl(input: {
  redirectUri: string;
  state: string;
  codeChallenge: string;
}): string {
  const url = new URL(CODEX_OAUTH_AUTHORIZE_URL);
  url.searchParams.set("response_type", "code");
  url.searchParams.set("client_id", CODEX_OAUTH_CLIENT_ID);
  url.searchParams.set("redirect_uri", input.redirectUri);
  url.searchParams.set("scope", CODEX_OAUTH_SCOPE);
  url.searchParams.set("state", input.state);
  url.searchParams.set("code_challenge", input.codeChallenge);
  url.searchParams.set("code_challenge_method", "S256");

  // Extra authorize params required by the Codex flow.
  url.searchParams.set("id_token_add_organizations", "true");
  url.searchParams.set("codex_cli_simplified_flow", "true");
  url.searchParams.set("originator", "mux");

  return url.toString();
}

export function buildCodexTokenExchangeBody(input: {
  code: string;
  redirectUri: string;
  codeVerifier: string;
}): URLSearchParams {
  const body = new URLSearchParams();
  body.set("grant_type", "authorization_code");
  body.set("client_id", CODEX_OAUTH_CLIENT_ID);
  body.set("code", input.code);
  body.set("redirect_uri", input.redirectUri);
  body.set("code_verifier", input.codeVerifier);
  return body;
}

export function buildCodexRefreshBody(input: { refreshToken: string }): URLSearchParams {
  const body = new URLSearchParams();
  body.set("grant_type", "refresh_token");
  body.set("client_id", CODEX_OAUTH_CLIENT_ID);
  body.set("refresh_token", input.refreshToken);
  return body;
}

/**
 * Models that may be routed through the Codex OAuth path.
 *
 * The values in this set are providerModelIds (no `openai:` prefix).
 */
export const CODEX_OAUTH_ALLOWED_MODELS = new Set<string>([
  "gpt-5.1-codex-max",
  "gpt-5.1-codex-mini",
  "gpt-5.2",
  "gpt-5.4-mini",
  "gpt-5.5",
  // GPT-5.6 family (July 9, 2026): available via both the public API and Codex.
  // The bare alias is a servable model id (OpenAI routes it to Sol), so it must
  // be allowed too or OAuth-only users selecting it fall to the API-key path.
  "gpt-5.6",
  "gpt-5.6-sol",
  "gpt-5.6-terra",
  "gpt-5.6-luna",
  // GPT-6 Astra (September 3, 2026): served in Codex for ChatGPT subscribers and
  // in the public API. Without this entry an OAuth-only user selecting Astra
  // falls to the API-key path and fails with api_key_not_found.
  "gpt-6-astra",
  "gpt-5.2-codex",
  "gpt-5.3-codex",
  "gpt-5.3-codex-spark",
  "gpt-5.1-codex",
]);

/**
 * Models that *prefer* Codex OAuth routing.
 *
 * These models are initially gated behind OAuth but eventually become available
 * via regular API keys.  When the user has OAuth connected, we route through it;
 * otherwise we fall back to their API key and let OpenAI decide whether the
 * model is accessible.
 */
export const CODEX_OAUTH_REQUIRED_MODELS = new Set<string>([
  // Spark variants still require ChatGPT OAuth routing.
  "gpt-5.3-codex-spark",
]);

/**
 * Runtime context caps that differ when an otherwise public API model is routed through
 * ChatGPT/Codex OAuth. Keep these separate from model metadata so API-key requests can
 * still use the public OpenAI limits.
 */
const CODEX_OAUTH_CONTEXT_WINDOW_OVERRIDES: Record<string, number> = {
  // The public API exposes a 1.05M window for these models, but the ChatGPT/Codex
  // model catalog publishes smaller context windows (372K for the GPT-5.6 family).
  // Keep auth-route caps separate so API-key requests retain the full public window.
  "gpt-5.5": 272_000,
  "gpt-5.6": 372_000,
  "gpt-5.6-sol": 372_000,
  "gpt-5.6-terra": 372_000,
  "gpt-5.6-luna": 372_000,
  // Astra shares the GPT-5.6 Codex cap: the catalog lists the same window for
  // Astra and Sol.
  "gpt-6-astra": 372_000,
};

function normalizeCodexOauthModelId(modelId: string): string {
  // Accept either provider:model or bare model ids and normalize to providerModelId.
  const colonIndex = modelId.indexOf(":");
  if (colonIndex !== -1) {
    return modelId.slice(colonIndex + 1);
  }

  return modelId;
}

export function isCodexOauthAllowedModelId(modelId: string): boolean {
  return CODEX_OAUTH_ALLOWED_MODELS.has(normalizeCodexOauthModelId(modelId));
}

export function isCodexOauthRequiredModelId(modelId: string): boolean {
  return CODEX_OAUTH_REQUIRED_MODELS.has(normalizeCodexOauthModelId(modelId));
}

function normalizeOpenAIModelString(modelId: string): string | null {
  const trimmedModelId = modelId.trim();
  if (!trimmedModelId) {
    return null;
  }

  if (trimmedModelId.startsWith("openai:")) {
    return trimmedModelId.length > "openai:".length ? trimmedModelId : null;
  }

  if (trimmedModelId.startsWith("openai/")) {
    return trimmedModelId.length > "openai/".length
      ? `openai:${trimmedModelId.slice("openai/".length)}`
      : null;
  }

  return trimmedModelId.includes(":") || trimmedModelId.includes("/")
    ? null
    : `openai:${trimmedModelId}`;
}

/**
 * Resolve the OpenAI model whose capabilities a runtime model inherits.
 *
 * Custom OpenAI IDs may opt into Codex OAuth compatibility by mapping to a known
 * OpenAI model. The runtime ID is still sent to OpenAI; only capability checks
 * inherit from mappedToModel. Treat-as mappings also accept the bare and
 * LiteLLM-style OpenAI IDs supported by metadata lookups.
 */
export function getCodexOauthCompatibilityModelId(
  modelId: string,
  providersConfig: ProviderModelsConfig | null
): string | null {
  const runtimeModelId = normalizeOpenAIModelString(modelId);
  if (runtimeModelId === null || !modelId.trim().startsWith("openai:")) {
    return null;
  }

  const mappedModelId = resolveModelForMetadata(runtimeModelId, providersConfig);
  return normalizeOpenAIModelString(mappedModelId) ?? runtimeModelId;
}

export function isCodexOauthAllowedModel(
  modelId: string,
  providersConfig: ProviderModelsConfig | null
): boolean {
  const compatibilityModelId = getCodexOauthCompatibilityModelId(modelId, providersConfig);
  return compatibilityModelId !== null && isCodexOauthAllowedModelId(compatibilityModelId);
}

export function isCodexOauthRequiredModel(
  modelId: string,
  providersConfig: ProviderModelsConfig | null
): boolean {
  const compatibilityModelId = getCodexOauthCompatibilityModelId(modelId, providersConfig);
  return compatibilityModelId !== null && isCodexOauthRequiredModelId(compatibilityModelId);
}

export function getCodexOauthContextWindowOverride(modelId: string): number | null {
  return CODEX_OAUTH_CONTEXT_WINDOW_OVERRIDES[normalizeCodexOauthModelId(modelId)] ?? null;
}

/**
 * Coder OAuth + AI Bridge constants and helpers.
 *
 * "Login with Coder" authenticates against a user-supplied Coder deployment via
 * standard OAuth2 authorization-code + PKCE (RFC 8414 discovery, RFC 7591
 * dynamic client registration). The resulting access token is a regular Coder
 * API key accepted by the deployment's AI Bridge endpoints.
 *
 * This module is intentionally shared (common/) so both the backend and UI can
 * reference the same endpoints and helpers.
 */

/** Unauthenticated probe used to validate that a URL points at a Coder deployment. */
export const CODER_BUILDINFO_PATH = "/api/v2/buildinfo";

/** RFC 8414 authorization server metadata (served by coderd with --experiments=oauth2). */
export const CODER_OAUTH_DISCOVERY_PATH = "/.well-known/oauth-authorization-server";

/** Loopback callback path for the desktop authorization-code flow. */
export const CODER_OAUTH_CALLBACK_PATH = "/callback";

/**
 * Xum server routes for the browser/server-mode flow: the browser cannot reach
 * a loopback listener on a remote Xum server, so the authorization redirect
 * lands on the server itself (shared between the HTTP layer and the UI).
 */
export const CODER_OAUTH_SERVER_START_PATH = "/auth/coder/start";
export const CODER_OAUTH_SERVER_CALLBACK_PATH = "/auth/coder/callback";

/** Client name registered via RFC 7591 dynamic client registration. */
export const CODER_OAUTH_CLIENT_NAME = "Xum";

/**
 * AI Gateway data-plane mount point on the deployment. Newer coderd also
 * serves the canonical alias /api/v2/ai-gateway, but the legacy prefix is
 * kept for backward compatibility and works on every deployment Xum
 * supports, so it stays the single prefix used here.
 */
export const CODER_AIBRIDGE_PATH = "/api/v2/aibridge";

/**
 * Admin CRUD endpoint listing the deployment's configured AI Gateway provider
 * instances ({name, type, enabled, ...}). Requires site-wide AIProvider read
 * (regular members receive 403); discovery falls back to probing default
 * provider names when this endpoint is unavailable.
 */
export const CODER_AI_PROVIDERS_PATH = "/api/v2/ai/providers";

/**
 * AI Gateway provider types (mirrors codersdk.AIProviderType). A deployment
 * can configure multiple provider instances per type, each with its own
 * name; the name is the URL route segment on the gateway's data plane
 * (/api/v2/aibridge/<name>/...). When admins don't set an explicit name it
 * defaults to the type.
 */
export const CODER_GATEWAY_PROVIDER_TYPES = [
  "anthropic",
  "openai",
  "azure",
  "google",
  "openai-compat",
  "openrouter",
  "vercel",
  "bedrock",
  "copilot",
] as const;

/** A configured AI Gateway provider instance discovered from the deployment. */
export interface CoderGatewayProvider {
  /** Instance name — the gateway route segment and the model ID prefix. */
  name: string;
  /** Provider type (see CODER_GATEWAY_PROVIDER_TYPES); decides the wire protocol. */
  type: string;
}

/**
 * Default probe set when the providers listing is unavailable: every
 * non-Copilot type under its default (name === type) instance name. Copilot
 * is excluded because its gateway routes require request-time tokens only an
 * official Copilot client can mint — Xum's Coder OAuth token is not enough.
 */
export const CODER_GATEWAY_DEFAULT_PROVIDER_NAMES: readonly string[] =
  CODER_GATEWAY_PROVIDER_TYPES.filter((type) => type !== "copilot");

/**
 * Wire protocol Xum must speak to a gateway provider, derived from its type.
 * Mirrors the gateway's own client mapping: anthropic/bedrock are served by
 * its Anthropic client (/v1/messages), everything else by its OpenAI client.
 * Only the real OpenAI upstream reliably supports the Responses API; the
 * other OpenAI-wire types target OpenAI-compatible upstreams where only
 * /chat/completions can be assumed. Unknown (future) types default to
 * openai-chat to match the gateway's own default. Returns null for
 * unsupported types (copilot, see above).
 */
export type CoderGatewayWire = "anthropic" | "openai-responses" | "openai-chat";

export function coderGatewayWireProtocol(type: string): CoderGatewayWire | null {
  switch (type) {
    case "anthropic":
    case "bedrock":
      return "anthropic";
    case "openai":
      return "openai-responses";
    case "copilot":
      return null;
    default:
      return "openai-chat";
  }
}

/** Parse a persisted (hand-editable) gateway provider list, dropping malformed entries. */
export function parseCoderGatewayProviders(value: unknown): CoderGatewayProvider[] {
  if (!Array.isArray(value)) {
    return [];
  }
  const providers: CoderGatewayProvider[] = [];
  for (const entry of value) {
    if (
      typeof entry === "object" &&
      entry !== null &&
      typeof (entry as { name?: unknown }).name === "string" &&
      (entry as { name: string }).name &&
      typeof (entry as { type?: unknown }).type === "string"
    ) {
      providers.push({
        name: (entry as { name: string }).name,
        type: (entry as { type: string }).type,
      });
    }
  }
  return providers;
}

/**
 * Wire-canonical identity for a Coder gateway model ID that stayed
 * gateway-scoped (custom-named instance, or an instance whose name is not a
 * canonical coder route): the origin whose payload/options/header format the
 * request will actually speak, plus the instance-stripped model ID.
 * Thinking/cache/beta-header builders must target the WIRE, not the "coder"
 * gateway prefix — otherwise a coder:prod-anthropic/<model> request silently
 * drops the thinking and context options a coder:anthropic/<model> request
 * would carry. Returns null when the instance is unknown or unsupported.
 */
export function resolveCoderWireCanonicalModel(
  gatewayModelId: string,
  metadata?: { discoveredProviders?: unknown; additionalProviders?: unknown }
): { origin: "anthropic" | "openai"; modelId: string; providerType: string } | null {
  const separatorIndex = gatewayModelId.indexOf("/");
  if (separatorIndex <= 0 || separatorIndex === gatewayModelId.length - 1) {
    return null;
  }
  const provider = resolveCoderGatewayProvider(
    gatewayModelId.slice(0, separatorIndex),
    parseCoderGatewayProviders(metadata?.discoveredProviders),
    parseCoderGatewayProviders(metadata?.additionalProviders)
  );
  if (!provider) {
    return null;
  }
  const wire = coderGatewayWireProtocol(provider.type);
  if (!wire) {
    return null;
  }
  return {
    origin: wire === "anthropic" ? "anthropic" : "openai",
    modelId: gatewayModelId.slice(separatorIndex + 1),
    // The instance's exact type: origin collapses every OpenAI-shaped wire
    // to "openai", but some config is upstream-specific (e.g. the OpenAI ZDR
    // store flag applies to the real OpenAI Responses upstream only).
    providerType: provider.type,
  };
}

/**
 * Capability/metadata identity for a Coder gateway model ID: the canonical
 * model whose pricing, context-window, and capability data describe the
 * instance's upstream. Distinct from the WIRE identity above — a google-typed
 * instance speaks OpenAI-chat on the wire, but its models are priced and
 * sized as google:<model>. Keying stats on the gateway-scoped string instead
 * leaves the model unpriced (budgeted goals reject it) and without context
 * limits (no limit-driven compaction). Returns null when the upstream's
 * catalog identity cannot be known (openai-compat fronts arbitrary
 * upstreams), so callers keep the gateway-scoped string.
 */
export function resolveCoderMetadataCanonicalModel(
  gatewayModelId: string,
  metadata?: { discoveredProviders?: unknown; additionalProviders?: unknown }
): string | null {
  const separatorIndex = gatewayModelId.indexOf("/");
  if (separatorIndex <= 0 || separatorIndex === gatewayModelId.length - 1) {
    return null;
  }
  const provider = resolveCoderGatewayProvider(
    gatewayModelId.slice(0, separatorIndex),
    parseCoderGatewayProviders(metadata?.discoveredProviders),
    parseCoderGatewayProviders(metadata?.additionalProviders)
  );
  if (!provider) {
    return null;
  }
  const modelId = gatewayModelId.slice(separatorIndex + 1);
  switch (provider.type) {
    case "anthropic":
    case "openai":
    case "google":
    case "azure":
    case "bedrock":
    case "openrouter":
      // Azure/Bedrock/OpenRouter model IDs match the pricing catalogs under
      // their own provider prefixes (bedrock's anthropic.<model> IDs also
      // canonicalize to anthropic:<model> through the bedrock gateway rules).
      return `${provider.type}:${modelId}`;
    // Vercel AI Gateway model IDs are vendor/model; the vendor is the
    // catalog identity when it is a known provider.
    case "vercel": {
      const vendorSeparator = modelId.indexOf("/");
      return vendorSeparator > 0 && vendorSeparator < modelId.length - 1
        ? `${modelId.slice(0, vendorSeparator)}:${modelId.slice(vendorSeparator + 1)}`
        : null;
    }
    default:
      // openai-compat fronts arbitrary upstreams; copilot is unsupported.
      return null;
  }
}

/**
 * Resolve a model-ID prefix to the gateway provider it addresses:
 * user-configured entries win (escape hatch for custom-named providers on
 * deployments where the member cannot list providers), then the discovered
 * catalog, then the default name === type convention.
 */
export function resolveCoderGatewayProvider(
  name: string,
  discovered: readonly CoderGatewayProvider[] | undefined,
  additional: readonly CoderGatewayProvider[] | undefined
): CoderGatewayProvider | null {
  const fromConfig =
    additional?.find((provider) => provider.name === name) ??
    discovered?.find((provider) => provider.name === name);
  if (fromConfig) {
    return fromConfig;
  }
  if ((CODER_GATEWAY_PROVIDER_TYPES as readonly string[]).includes(name)) {
    return { name, type: name };
  }
  return null;
}

/**
 * Normalize a user-supplied deployment URL: require http(s), strip trailing
 * slashes and any path/query/fragment noise. Returns null when invalid.
 */
export function normalizeCoderDeploymentUrl(raw: string): string | null {
  const trimmed = raw.trim();
  if (!trimmed) {
    return null;
  }

  let url: URL;
  try {
    url = new URL(trimmed);
  } catch {
    return null;
  }

  if (url.protocol !== "https:" && url.protocol !== "http:") {
    return null;
  }

  // Coder access URLs are origin-scoped; drop any accidental path suffix.
  return url.origin;
}

/**
 * Per-provider AI Gateway base URL, e.g.
 *   https://coder.example.com/api/v2/aibridge/anthropic/v1
 *   https://coder.example.com/api/v2/aibridge/my-openai/v1
 *
 * Both the Anthropic and OpenAI AI SDK providers append their route suffixes
 * (/messages, /chat/completions, /responses) to a .../v1 base URL.
 */
export function coderAibridgeBaseUrl(deploymentUrl: string, providerName: string): string {
  return `${deploymentUrl}${CODER_AIBRIDGE_PATH}/${providerName}/v1`;
}

export function buildCoderAuthorizeUrl(input: {
  authorizationEndpoint: string;
  clientId: string;
  redirectUri: string;
  state: string;
  codeChallenge: string;
}): string {
  const url = new URL(input.authorizationEndpoint);
  url.searchParams.set("response_type", "code");
  url.searchParams.set("client_id", input.clientId);
  url.searchParams.set("redirect_uri", input.redirectUri);
  url.searchParams.set("state", input.state);
  url.searchParams.set("code_challenge", input.codeChallenge);
  url.searchParams.set("code_challenge_method", "S256");
  // No scope requested: Coder currently ignores scopes and issues full-privilege
  // tokens; sending none keeps the flow forward-compatible with scoped tokens.
  return url.toString();
}

export function buildCoderTokenExchangeBody(input: {
  clientId: string;
  clientSecret: string;
  code: string;
  redirectUri: string;
  codeVerifier: string;
}): URLSearchParams {
  const body = new URLSearchParams();
  body.set("grant_type", "authorization_code");
  body.set("client_id", input.clientId);
  // Coder's token endpoint requires client_secret even for native apps
  // (DetermineClientType() treats every client as confidential).
  body.set("client_secret", input.clientSecret);
  body.set("code", input.code);
  body.set("redirect_uri", input.redirectUri);
  body.set("code_verifier", input.codeVerifier);
  return body;
}

export function buildCoderRefreshBody(input: {
  clientId: string;
  clientSecret: string;
  refreshToken: string;
}): URLSearchParams {
  const body = new URLSearchParams();
  body.set("grant_type", "refresh_token");
  body.set("client_id", input.clientId);
  body.set("client_secret", input.clientSecret);
  body.set("refresh_token", input.refreshToken);
  return body;
}

/**
 * RFC 7591/7592 client metadata. Coder validates redirect URIs with exact
 * matching (OAuth 2.1), so the current loopback redirect URI (with its
 * ephemeral port) must be (re-)registered before each login.
 */
export function buildCoderClientMetadata(redirectUri: string): Record<string, unknown> {
  return {
    client_name: CODER_OAUTH_CLIENT_NAME,
    client_uri: "https://mux.coder.com",
    redirect_uris: [redirectUri],
    grant_types: ["authorization_code", "refresh_token"],
    response_types: ["code"],
    token_endpoint_auth_method: "client_secret_post",
  };
}

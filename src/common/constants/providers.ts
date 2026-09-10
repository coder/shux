/**
 * Provider Definitions - Single source of truth for all provider metadata
 *
 * When adding a new provider:
 * 1. Add entry to PROVIDER_DEFINITIONS below
 * 2. Add SVG icon + import in src/browser/components/ProviderIcon.tsx
 * 3. If provider needs custom logic, add handler in aiService.ts
 *    (simple providers using standard pattern are handled automatically)
 *
 * Simple providers (requiresApiKey + standard factory pattern) need NO aiService.ts changes.
 */

/**
 * Union type of all supported provider names
 */
export type ProviderName =
  | "mux-gateway"
  | "anthropic"
  | "openai"
  | "google"
  | "xai"
  | "deepseek"
  | "moonshotai"
  | "zai"
  | "openrouter"
  | "github-copilot"
  | "coder"
  | "bedrock"
  | "ollama";

interface ProviderDefinition {
  /** Display name for UI (proper casing) */
  displayName: string;
  /** Dynamic import function for lazy loading */
  import: () => Promise<unknown>;
  /** Name of the factory function exported by the package */
  factoryName: string;
  /** Whether provider requires an API key (false for local services like Ollama) */
  requiresApiKey: boolean;
  /** Provider category for routing behavior */
  kind: "direct" | "gateway" | "local";
  /** Gateways only: which direct providers this gateway routes to */
  routes?: ProviderName[];
  /** Transform canonical model identity into a gateway-specific model ID */
  toGatewayModelId?: (origin: string, modelId: string) => string;
  /** Parse a gateway-specific model ID back into canonical model identity */
  fromGatewayModelId?: (gatewayModelId: string) => { origin: string; modelId: string } | null;
  /** True when gateway is a transparent proxy and preserves canonical identity */
  passthrough?: boolean;
  /** Whether this provider uses stroke-based icon styling instead of fill */
  strokeBasedIcon?: boolean;
}

const toSlashSeparatedGatewayModelId = (origin: string, modelId: string): string =>
  `${origin}/${modelId}`;

const fromSlashSeparatedGatewayModelId = (
  gatewayModelId: string
): { origin: string; modelId: string } | null => {
  const separatorIndex = gatewayModelId.indexOf("/");
  // Reject leading/trailing separators: an empty origin or model id would
  // otherwise canonicalize to invalid ":model" / "origin:" identities.
  if (separatorIndex <= 0 || separatorIndex === gatewayModelId.length - 1) {
    return null;
  }

  return {
    origin: gatewayModelId.slice(0, separatorIndex),
    modelId: gatewayModelId.slice(separatorIndex + 1),
  };
};

// Coder gateway route origins that carry canonical identity: only these
// DEFAULT-NAMED instances canonicalize (coder:anthropic/x ≙ anthropic:x).
// Every other instance name — custom names (prod-anthropic), non-canonical
// types (openai-compat), and instances named after other direct providers
// (google) — must stay gateway-scoped: rewriting coder:google/x to google:x
// would route the request to the DIRECT provider, silently bypassing the
// gateway the user explicitly selected (or failing without direct
// credentials), because this static route table cannot restore
// instance-name prefixes.
const CODER_CANONICAL_GATEWAY_ROUTES: ProviderName[] = ["anthropic", "openai"];

const fromCoderGatewayModelId = (
  gatewayModelId: string
): { origin: string; modelId: string } | null => {
  const parsed = fromSlashSeparatedGatewayModelId(gatewayModelId);
  return parsed != null &&
    (CODER_CANONICAL_GATEWAY_ROUTES as readonly string[]).includes(parsed.origin)
    ? parsed
    : null;
};

const fromDotSeparatedGatewayModelId = (
  gatewayModelId: string
): { origin: string; modelId: string } | null => {
  const separatorIndex = gatewayModelId.indexOf(".");
  // Reject leading/trailing separators (empty origin or model id) — see
  // fromSlashSeparatedGatewayModelId.
  if (separatorIndex <= 0 || separatorIndex === gatewayModelId.length - 1) {
    return null;
  }

  return {
    origin: gatewayModelId.slice(0, separatorIndex),
    modelId: gatewayModelId.slice(separatorIndex + 1),
  };
};

// Order determines display order in UI (Settings, model selectors, etc.)
export const PROVIDER_DEFINITIONS = {
  "mux-gateway": {
    displayName: "Xum Gateway",
    import: () => import("ai"),
    factoryName: "createGateway",
    requiresApiKey: true, // Uses couponCode
    kind: "gateway",
    routes: ["anthropic", "openai", "google", "xai"],
    passthrough: true,
    toGatewayModelId: toSlashSeparatedGatewayModelId,
    fromGatewayModelId: fromSlashSeparatedGatewayModelId,
    strokeBasedIcon: true,
  },
  anthropic: {
    displayName: "Anthropic",
    import: () => import("@ai-sdk/anthropic"),
    factoryName: "createAnthropic",
    requiresApiKey: true,
    kind: "direct",
  },
  openai: {
    displayName: "OpenAI",
    import: () => import("@ai-sdk/openai"),
    factoryName: "createOpenAI",
    requiresApiKey: true,
    kind: "direct",
  },
  google: {
    displayName: "Google",
    import: () => import("@ai-sdk/google"),
    factoryName: "createGoogleGenerativeAI",
    requiresApiKey: true,
    kind: "direct",
  },
  xai: {
    displayName: "xAI",
    import: () => import("@ai-sdk/xai"),
    factoryName: "createXai",
    requiresApiKey: true,
    kind: "direct",
  },
  deepseek: {
    displayName: "DeepSeek",
    import: () => import("@ai-sdk/deepseek"),
    factoryName: "createDeepSeek",
    requiresApiKey: true,
    kind: "direct",
  },
  moonshotai: {
    displayName: "Moonshot AI",
    import: () => import("@ai-sdk/moonshotai"),
    factoryName: "createMoonshotAI",
    requiresApiKey: true,
    kind: "direct",
  },
  zai: {
    displayName: "Z.ai",
    import: () => import("@ai-sdk/zai"),
    factoryName: "createZai",
    requiresApiKey: true,
    kind: "direct",
  },
  openrouter: {
    displayName: "OpenRouter",
    import: () => import("@openrouter/ai-sdk-provider"),
    factoryName: "createOpenRouter",
    requiresApiKey: true,
    kind: "gateway",
    // OpenRouter uses the hyphenated vendor slug "z-ai", so direct "zai" routing is not inferred.
    routes: ["anthropic", "openai", "google", "xai", "deepseek", "moonshotai"],
    passthrough: false,
    toGatewayModelId: toSlashSeparatedGatewayModelId,
    fromGatewayModelId: fromSlashSeparatedGatewayModelId,
  },
  "github-copilot": {
    displayName: "GitHub Copilot",
    import: () => import("@ai-sdk/openai-compatible"),
    factoryName: "createOpenAICompatible",
    requiresApiKey: true,
    kind: "gateway",
    routes: ["openai", "anthropic", "google"],
    passthrough: false,
    // Copilot's OpenAI-compatible API accepts raw upstream model IDs for routed OpenAI traffic.
    // Intentionally omit fromGatewayModelId: github-copilot:* model strings are canonical identities
    // with Copilot-specific pricing/capabilities, including non-OpenAI families like Claude.
    toGatewayModelId: (_origin, modelId) => modelId,
  },
  coder: {
    displayName: "Coder",
    // Nominal import only: the model factory branches per provider instance
    // (wire protocol derived from the instance's type) because Coder's AI
    // Gateway exposes per-instance endpoints.
    import: () => import("@ai-sdk/openai"),
    factoryName: "createOpenAI",
    requiresApiKey: false, // Uses "Login with Coder" OAuth tokens
    kind: "gateway",
    routes: CODER_CANONICAL_GATEWAY_ROUTES,
    // The AI Gateway is a transparent proxy to the configured upstreams, so
    // canonical model identity (and providerOptions namespaces) are preserved.
    passthrough: true,
    toGatewayModelId: toSlashSeparatedGatewayModelId,
    fromGatewayModelId: fromCoderGatewayModelId,
  },
  bedrock: {
    displayName: "Bedrock",
    import: () => import("@ai-sdk/amazon-bedrock"),
    factoryName: "createAmazonBedrock",
    requiresApiKey: false, // Uses AWS credential chain
    kind: "gateway",
    routes: ["anthropic"],
    passthrough: false,
    // Bedrock model IDs use dot-separated vendor.model notation.
    toGatewayModelId: (origin, modelId) => `${origin}.${modelId}`,
    fromGatewayModelId: fromDotSeparatedGatewayModelId,
  },
  ollama: {
    displayName: "Ollama",
    import: () => import("ollama-ai-provider-v2"),
    factoryName: "createOllama",
    requiresApiKey: false, // Local service
    kind: "local",
  },
} as const satisfies Record<ProviderName, ProviderDefinition>;

export const GATEWAY_PROVIDERS = Object.entries(PROVIDER_DEFINITIONS)
  .filter(([, def]) => def.kind === "gateway")
  .map(([name]) => name as ProviderName);

/**
 * Array of all supported provider names (for UI lists, iteration, etc.)
 */
export const SUPPORTED_PROVIDERS = Object.keys(PROVIDER_DEFINITIONS) as ProviderName[];

/**
 * Display names for providers (proper casing for UI)
 * Derived from PROVIDER_DEFINITIONS - do not edit directly
 */
export const PROVIDER_DISPLAY_NAMES: Record<ProviderName, string> = Object.fromEntries(
  Object.entries(PROVIDER_DEFINITIONS).map(([key, def]) => [key, def.displayName])
) as Record<ProviderName, string>;

/**
 * Legacy registry for backward compatibility with aiService.ts
 * Maps provider names to their import functions
 */
export const PROVIDER_REGISTRY = Object.fromEntries(
  Object.entries(PROVIDER_DEFINITIONS).map(([key, def]) => [key, def.import])
) as { [K in ProviderName]: (typeof PROVIDER_DEFINITIONS)[K]["import"] };

/**
 * Type guard to check if a string is a valid provider name
 */
export function isValidProvider(provider: string): provider is ProviderName {
  return provider in PROVIDER_REGISTRY;
}

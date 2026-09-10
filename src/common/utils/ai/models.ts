/**
 * Model configuration and constants
 */

import { DEFAULT_MODEL, MODEL_ABBREVIATIONS } from "@/common/constants/knownModels";
import { PROVIDER_DEFINITIONS, type ProviderName } from "@/common/constants/providers";
import { formatCompactModelDisplayName, formatModelDisplayName } from "./modelDisplay";
import { resolveCoderGatewayMetadataModel } from "@/common/utils/providers/coderGatewayMetadata";
import { resolveCoderWireCanonicalModel } from "@/common/constants/coderOAuth";

export const defaultModel = DEFAULT_MODEL;

/**
 * Resolve model alias to full model string.
 * If the input is an alias (e.g., "haiku", "sonnet"), returns the full model string.
 * Otherwise returns the input unchanged.
 */
export function resolveModelAlias(modelInput: string): string {
  if (Object.hasOwn(MODEL_ABBREVIATIONS, modelInput)) {
    return MODEL_ABBREVIATIONS[modelInput];
  }
  return modelInput;
}

/**
 * Validate model string format (must be "provider:model-id").
 * Supports colons in the model ID (e.g., "ollama:gpt-oss:20b").
 */
export function isValidModelFormat(model: string): boolean {
  const colonIndex = model.indexOf(":");
  return colonIndex > 0 && colonIndex < model.length - 1;
}

/**
 * Normalize gateway model strings to canonical provider:model format when possible.
 * For gateway-only vendor/model IDs, keep the original gateway-scoped identity.
 */
export function normalizeToCanonical(modelString: string): string {
  const colonIndex = modelString.indexOf(":");
  if (colonIndex === -1) {
    return modelString;
  }

  const providerName = modelString.slice(0, colonIndex) as ProviderName;
  const gatewayModelId = modelString.slice(colonIndex + 1);

  const def = PROVIDER_DEFINITIONS[providerName];
  if (def?.kind !== "gateway" || !("fromGatewayModelId" in def) || !def.fromGatewayModelId) {
    return modelString; // direct/local provider or unknown — already canonical
  }

  const parsed = def.fromGatewayModelId(gatewayModelId);
  if (!parsed) {
    return modelString; // couldn't parse
  }

  // Only normalize if the origin is a known direct provider.
  // Gateway-only models like "meta-llama/llama-3.1-405b" stay gateway-scoped.
  const originDef = PROVIDER_DEFINITIONS[parsed.origin as ProviderName];
  if (originDef?.kind !== "direct") {
    return modelString; // origin is not a known direct provider
  }

  return `${parsed.origin}:${parsed.modelId}`;
}

/**
 * Return the explicitly requested gateway provider prefix from a raw model string.
 * This preserves user-selected gateway routing (for example, openrouter:openai/gpt-5)
 * instead of canonicalizing back to a direct provider model string.
 */
export function getExplicitGatewayPrefix(modelString: string): ProviderName | undefined {
  const trimmedModelString = modelString.trim();
  const colonIndex = trimmedModelString.indexOf(":");
  if (colonIndex <= 0 || colonIndex === trimmedModelString.length - 1) {
    return undefined;
  }

  const providerName = trimmedModelString.slice(0, colonIndex) as ProviderName;
  return PROVIDER_DEFINITIONS[providerName]?.kind === "gateway" ? providerName : undefined;
}

/**
 * Resolve which providerOptions namespace a request will use for a given
 * canonical origin and route provider. Passthrough gateways (mux-gateway)
 * keep the origin namespace; transforming gateways (openrouter,
 * github-copilot, bedrock) use their own.
 */
export function resolveProviderOptionsNamespaceKey(
  canonicalProviderName: string,
  routeProvider?: ProviderName
): string {
  const routeDefinition = routeProvider ? PROVIDER_DEFINITIONS[routeProvider] : undefined;
  if (
    !routeProvider ||
    routeProvider === canonicalProviderName ||
    (routeDefinition != null &&
      "passthrough" in routeDefinition &&
      routeDefinition.passthrough === true)
  ) {
    return canonicalProviderName;
  }

  return routeProvider;
}

/**
 * Equality key for UI selection tracking (explicit-change origin recording,
 * same-model warning suppression).
 *
 * Collapses passthrough gateway aliases to canonical identity — a persisted
 * rewrite like mux-gateway:openai/x must still match an explicit openai:x
 * switch — but keeps raw coder:<instance>/<model> identities distinct: the
 * instance's TYPE (not its name) decides the upstream, so name-only
 * canonicalization would equate a cross-typed gateway selection with an
 * unrelated direct model and drop the switch/warning.
 */
export function modelSelectionEqualityKey(modelString: string): string {
  const trimmed = modelString.trim();
  return trimmed.startsWith("coder:") ? trimmed : normalizeToCanonical(trimmed);
}

/**
 * Normalize a selected model while preserving explicit gateway routing choices.
 * User-selected gateway identities like openrouter:openai/gpt-5 should stay intact.
 */
export function normalizeSelectedModel(modelString: string): string {
  const trimmedModelString = modelString.trim();
  return getExplicitGatewayPrefix(trimmedModelString)
    ? trimmedModelString
    : normalizeToCanonical(trimmedModelString);
}

/**
 * Extract the model name from a model string (e.g., "anthropic:claude-sonnet-4-5" -> "claude-sonnet-4-5")
 * @param modelString - Full model string in format "provider:model-name"
 * @returns The model name part (after the colon), or the full string if no colon is found
 */
export function getModelName(modelString: string): string {
  const normalized = normalizeToCanonical(modelString);
  const colonIndex = normalized.indexOf(":");
  if (colonIndex === -1) {
    return normalized;
  }
  return normalized.substring(colonIndex + 1);
}

/**
 * Format a full model string (e.g. "anthropic:claude-sonnet-4-5") into its
 * human display name (e.g. "Sonnet 4.5"). Shared by ModelDisplay,
 * ModelSelector, and ModelFallbackBadge. Lives here (not modelDisplay.ts) to
 * avoid a modelDisplay -> knownModels -> modelDisplay import cycle.
 */
export function formatModelStringForDisplay(modelString: string): string {
  return formatModelDisplayName(getModelName(modelString));
}

export function formatCompactModelStringForDisplay(modelString: string): string {
  return formatCompactModelDisplayName(getModelName(modelString));
}

/**
 * Extract the provider from a model string (e.g., "anthropic:claude-sonnet-4-5" -> "anthropic")
 * @param modelString - Full model string in format "provider:model-name"
 * @returns The provider part (before the colon), or empty string if no colon is found
 */
export function getModelProvider(modelString: string): string {
  const normalized = normalizeToCanonical(modelString);
  const colonIndex = normalized.indexOf(":");
  if (colonIndex === -1) {
    return "";
  }
  return normalized.substring(0, colonIndex);
}

export type Anthropic1MContextMode = "none" | "beta" | "native";

const OPTIONAL_VERSION_SUFFIX = String.raw`(?:-(?:\d{8}|\d{4}-\d{2}-\d{2}))?`;
const ANTHROPIC_NATIVE_1M_PATTERNS = [
  // Mythos-class models (Fable 5 / Mythos 5) ship 1M context as standard metadata.
  new RegExp(`^claude-fable-5${OPTIONAL_VERSION_SUFFIX}$`, "i"),
  new RegExp(`^claude-fable-5-1${OPTIONAL_VERSION_SUFFIX}$`, "i"),
  new RegExp(`^claude-mythos-5${OPTIONAL_VERSION_SUFFIX}$`, "i"),
  new RegExp(`^claude-mythos-5-1${OPTIONAL_VERSION_SUFFIX}$`, "i"),
  new RegExp(`^claude-opus-5${OPTIONAL_VERSION_SUFFIX}$`, "i"),
  new RegExp(`^claude-opus-4-8${OPTIONAL_VERSION_SUFFIX}$`, "i"),
  new RegExp(`^claude-opus-4-7${OPTIONAL_VERSION_SUFFIX}$`, "i"),
  new RegExp(`^claude-opus-4-6${OPTIONAL_VERSION_SUFFIX}$`, "i"),
  new RegExp(`^claude-sonnet-5${OPTIONAL_VERSION_SUFFIX}$`, "i"),
  new RegExp(`^claude-sonnet-4-6${OPTIONAL_VERSION_SUFFIX}$`, "i"),
];
const ANTHROPIC_BETA_1M_PATTERNS = [
  new RegExp(`^claude-sonnet-4-5${OPTIONAL_VERSION_SUFFIX}$`, "i"),
  new RegExp(`^claude-sonnet-4-20250514${OPTIONAL_VERSION_SUFFIX}$`, "i"),
];

function matchesAnthropicPattern(modelName: string, patterns: readonly RegExp[]): boolean {
  return patterns.some((pattern) => pattern.test(modelName));
}

/**
 * Classify Anthropic models by how they reach a 1M context window.
 *
 * - `native`: published 1M context is part of the model's standard metadata/pricing.
 * - `beta`: 1M requires Anthropic's opt-in beta header.
 * - `none`: model does not offer 1M context.
 */
export function getAnthropic1MContextMode(
  modelString: string,
  providersConfig?: Record<string, unknown> | null
): Anthropic1MContextMode {
  // Coder gateway instances inherit the upstream's runtime capabilities (the
  // gateway is a transparent proxy), so map coder:<instance>/<model> through
  // the instance's provider type before pattern-matching. This deliberately
  // does NOT apply mappedToModel ("Treat as") overrides: treat-as targets
  // must not confer the 1M beta onto models that cannot accept the header.
  // With metadata available the mapping is CONCLUSIVE: an unmappable
  // instance (cross-typed compat upstream, shadowed prefix) has no known
  // Anthropic upstream, and falling back to name-based normalization would
  // grant the beta to coder:anthropic/<claude> fronting a non-Anthropic
  // upstream.
  let capabilityModel = modelString;
  // The beta requires the opt-in anthropic-beta HEADER, which only an
  // Anthropic wire can carry (anthropic/bedrock instance types). A
  // vercel/google-typed instance fronting a Claude model maps to anthropic:*
  // for pricing/metadata but speaks openai-chat on the wire — conferring the
  // beta would grow sessions past the model's effective non-beta limit and
  // fail with context errors. Native 1M is standard model metadata (no
  // header), so it is not wire-gated.
  let wireCarriesAnthropicBeta = true;
  if (providersConfig != null && modelString.startsWith("coder:")) {
    const mapped = resolveCoderGatewayMetadataModel(modelString, providersConfig);
    if (mapped == null) {
      return "none";
    }
    capabilityModel = mapped;
    const wire = resolveCoderWireCanonicalModel(
      modelString.slice("coder:".length),
      providersConfig.coder as
        | { discoveredProviders?: unknown; additionalProviders?: unknown }
        | undefined
    );
    wireCarriesAnthropicBeta = wire?.origin === "anthropic";
  }
  const normalized = normalizeToCanonical(capabilityModel);
  const [provider, modelName] = normalized.split(":", 2);
  const normalizedModelName = modelName?.toLowerCase() ?? "";

  if (provider !== "anthropic" || normalizedModelName.length === 0) {
    return "none";
  }

  if (matchesAnthropicPattern(normalizedModelName, ANTHROPIC_NATIVE_1M_PATTERNS)) {
    return "native";
  }

  if (matchesAnthropicPattern(normalizedModelName, ANTHROPIC_BETA_1M_PATTERNS)) {
    return wireCarriesAnthropicBeta ? "beta" : "none";
  }

  return "none";
}

/**
 * Check if a model supports Anthropic's optional 1M beta mode used by Xum's context toggle.
 *
 * Native long-context models like Claude Opus 4.6, Claude Sonnet 4.6, and GPT-5.5 expose
 * their larger window directly through model metadata and should not appear behind this toggle.
 */
export function supports1MContext(
  modelString: string,
  providersConfig?: Record<string, unknown> | null
): boolean {
  return getAnthropic1MContextMode(modelString, providersConfig) === "beta";
}

export function hasNative1MContext(
  modelString: string,
  providersConfig?: Record<string, unknown> | null
): boolean {
  return getAnthropic1MContextMode(modelString, providersConfig) === "native";
}

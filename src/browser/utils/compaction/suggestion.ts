/**
 * Helpers for best-effort compaction suggestions.
 *
 * Used by RetryBarrier to offer "Compact & retry" when we hit context limits.
 */

import { isModelAllowedByPolicy } from "@/browser/utils/policyUi";
import { KNOWN_MODELS } from "@/common/constants/knownModels";
import { isModelAvailable } from "@/common/routing";
import type { EffectivePolicy, ProvidersConfigMap } from "@/common/orpc/types";
import { normalizeToCanonical } from "@/common/utils/ai/models";
import { formatModelDisplayName } from "@/common/utils/ai/modelDisplay";
import {
  isGatewayModelAccessibleFromAuthoritativeCatalog,
  isProviderModelAccessibleFromAuthoritativeCatalog,
} from "@/common/utils/providers/gatewayModelCatalog";
import { getModelStats, getModelStatsResolved } from "@/common/utils/tokens/modelStats";

export interface CompactionSuggestion {
  kind: "preferred" | "higher_context";
  /** Model argument shown to the user (alias when available) */
  modelArg: string;
  /** Canonical model ID (provider:model) used for sending */
  modelId: string;
  displayName: string;
  /**
   * Best-effort context size for display.
   *
   * Null when we don't have model stats for this model ID.
   */
  maxInputTokens: number | null;
}

function buildIsConfigured(
  providersConfig: ProvidersConfigMap | null
): (provider: string) => boolean {
  return (provider: string) =>
    providersConfig?.[provider]?.isConfigured === true &&
    providersConfig?.[provider]?.isEnabled !== false;
}

function buildIsGatewayModelAccessible(
  providersConfig: ProvidersConfigMap | null
): (gateway: string, modelId: string) => boolean {
  return (gateway: string, modelId: string) =>
    isGatewayModelAccessibleFromAuthoritativeCatalog(
      gateway,
      modelId,
      providersConfig?.[gateway]?.models,
      providersConfig?.[gateway]?.discoveredModels,
      providersConfig?.[gateway]?.removedModels
    );
}

function buildIsAuthoritativeProviderModelAccessible(
  providersConfig: ProvidersConfigMap | null
): (modelString: string) => boolean {
  return (modelString: string) => {
    // Raw-first: a canonical-named Coder instance (coder:openai/<model>) must
    // check the coder catalog, not the direct provider that name-only
    // canonicalization would produce — the instance TYPE decides the upstream.
    const normalized = modelString.startsWith("coder:")
      ? modelString
      : normalizeToCanonical(modelString);
    const colonIndex = normalized.indexOf(":");
    if (colonIndex <= 0 || colonIndex >= normalized.length - 1) {
      return true;
    }

    const provider = normalized.slice(0, colonIndex);
    const providerModelId = normalized.slice(colonIndex + 1);
    return isProviderModelAccessibleFromAuthoritativeCatalog(
      provider,
      providerModelId,
      providersConfig?.[provider]?.models,
      providersConfig?.[provider]?.discoveredModels,
      providersConfig?.[provider]?.removedModels
    );
  };
}

export interface CompactionRouteOptions {
  routePriority: string[];
  routeOverrides: Record<string, string>;
}

export interface CompactionAvailabilityOptions extends CompactionRouteOptions {
  providersConfig: ProvidersConfigMap | null;
  policy?: EffectivePolicy | null;
}

export function getExplicitCompactionSuggestion(
  options: {
    modelId: string;
  } & CompactionAvailabilityOptions
): CompactionSuggestion | null {
  const modelId = options.modelId.trim();
  if (modelId.length === 0) {
    return null;
  }

  // Raw-first: keep coder:<instance>/<model> identities intact so catalog,
  // routing, and policy checks validate the Coder gateway entry itself. A
  // cross-typed instance ({name:"openai", type:"anthropic"}) canonicalizes by
  // NAME to the direct provider, so canonical-first checks would reject an
  // available Coder compaction model (or validate an unrelated direct one).
  const normalized = modelId.startsWith("coder:") ? modelId : normalizeToCanonical(modelId);
  const isConfigured = buildIsConfigured(options.providersConfig);
  const isGatewayModelAccessible = buildIsGatewayModelAccessible(options.providersConfig);
  const isAuthoritativeProviderModelAccessible = buildIsAuthoritativeProviderModelAccessible(
    options.providersConfig
  );
  if (!isAuthoritativeProviderModelAccessible(normalized)) {
    return null;
  }

  if (
    !isModelAvailable(
      normalized,
      options.routePriority,
      options.routeOverrides,
      isConfigured,
      isGatewayModelAccessible
    )
  ) {
    return null;
  }

  const colonIndex = normalized.indexOf(":");

  // Validate against policy if provided
  if (!isModelAllowedByPolicy(options.policy ?? null, normalized)) {
    return null;
  }

  // Metadata-aware stats: coder identities resolve through the instance type
  // (and mappedToModel overrides) to their upstream catalog entry.
  const stats = getModelStatsResolved(normalized, options.providersConfig);

  // Prefer a stable alias for built-in known models.
  const known = Object.values(KNOWN_MODELS).find((m) => m.id === normalized);
  const modelArg = known?.aliases?.[0] ?? modelId;

  const providerModelId = colonIndex === -1 ? normalized : normalized.slice(colonIndex + 1);
  const displayName = formatModelDisplayName(known?.providerModelId ?? providerModelId);

  return {
    kind: "preferred",
    modelArg,
    modelId,
    displayName,
    maxInputTokens: stats?.max_input_tokens ?? null,
  };
}

/**
 * Find a configured known model with a strictly larger input window than `currentModel`.
 *
 * Uses max_input_tokens (not total context) since that's the actual limit for request payloads.
 */
export function getHigherContextCompactionSuggestion(
  options: {
    currentModel: string;
  } & CompactionAvailabilityOptions
): CompactionSuggestion | null {
  const currentStats = getModelStats(options.currentModel);
  if (!currentStats?.max_input_tokens) {
    return null;
  }

  let best: CompactionSuggestion | null = null;
  const isConfigured = buildIsConfigured(options.providersConfig);
  const isGatewayModelAccessible = buildIsGatewayModelAccessible(options.providersConfig);

  for (const known of Object.values(KNOWN_MODELS)) {
    if (
      !isModelAvailable(
        known.id,
        options.routePriority,
        options.routeOverrides,
        isConfigured,
        isGatewayModelAccessible
      )
    ) {
      continue;
    }

    // Skip models blocked by policy
    if (!isModelAllowedByPolicy(options.policy ?? null, known.id)) {
      continue;
    }

    const candidateStats = getModelStats(known.id);
    if (!candidateStats?.max_input_tokens) {
      continue;
    }

    if (candidateStats.max_input_tokens <= currentStats.max_input_tokens) {
      continue;
    }

    const bestMax = best?.maxInputTokens ?? 0;
    if (!best || candidateStats.max_input_tokens > bestMax) {
      best = {
        kind: "higher_context",
        modelArg: known.aliases?.[0] ?? known.id,
        modelId: known.id,
        displayName: formatModelDisplayName(known.providerModelId),
        maxInputTokens: candidateStats.max_input_tokens,
      };
    }
  }

  return best;
}

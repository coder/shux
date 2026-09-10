/**
 * Shared context limit utilities for compaction logic.
 *
 * Used by autoCompactionCheck and contextSwitchCheck to calculate
 * effective context limits accounting for auth-route caps and the 1M context toggle.
 */

import {
  getCodexOauthCompatibilityModelId,
  getCodexOauthContextWindowOverride,
} from "@/common/constants/codexOAuth";
import {
  wouldRouteOpenAIThroughCodexOauth,
  type CodexOauthRoutingOptions,
} from "@/common/utils/providers/codexOauthRouting";
import type { ProvidersConfigMap } from "@/common/orpc/types";
import { supports1MContext } from "@/common/utils/ai/models";
import {
  getModelContextWindowOverride,
  resolveModelForMetadata,
} from "@/common/utils/providers/modelEntries";
import { getModelStats } from "@/common/utils/tokens/modelStats";

function getCodexOauthContextLimit(
  model: string,
  providersConfig: ProvidersConfigMap | null,
  options: CodexOauthRoutingOptions | undefined
): number | null {
  const compatibilityModelId = getCodexOauthCompatibilityModelId(model, providersConfig);
  if (compatibilityModelId === null) {
    return null;
  }

  const oauthLimit = getCodexOauthContextWindowOverride(compatibilityModelId);
  if (oauthLimit == null) {
    return null;
  }

  return wouldRouteOpenAIThroughCodexOauth(model, providersConfig, options) ? oauthLimit : null;
}

/**
 * Get effective context limit for a model, accounting for custom overrides, auth-route caps, and 1M toggle.
 *
 * @param model - Model ID (e.g., "anthropic:claude-sonnet-4-5")
 * @param use1M - Whether 1M context is enabled in settings
 * @param providersConfig - Provider configuration map for custom model overrides
 * @param options - Request-level routing inputs (backend send path); browser callers have none
 * @returns Max input tokens, or null if no limit is known
 */
export function getEffectiveContextLimit(
  model: string,
  use1M: boolean,
  providersConfig: ProvidersConfigMap | null = null,
  options?: CodexOauthRoutingOptions
): number | null {
  const metadataModel = resolveModelForMetadata(model, providersConfig);
  const customOverride = getModelContextWindowOverride(model, providersConfig);
  const stats = getModelStats(metadataModel);
  const baseLimit = customOverride ?? stats?.max_input_tokens ?? null;
  if (!baseLimit) return null;

  // ChatGPT/Codex OAuth can impose a smaller routing-layer cap than the public OpenAI
  // API metadata. Cap the effective window so auto-compaction and token meters compact
  // before OAuth requests reach provider-side validation failures.
  const codexOauthLimit = getCodexOauthContextLimit(model, providersConfig, options);
  if (codexOauthLimit != null) {
    return Math.min(baseLimit, codexOauthLimit);
  }

  // Anthropic's optional 1M beta is a runtime capability, so it must be gated on the
  // runtime model, not the mapped metadata model (Coder gateway instances resolve
  // through their instance type inside the gate). Native 1M models already expose
  // their larger window through model stats above.
  if (supports1MContext(model, providersConfig) && use1M) return 1_000_000;
  return baseLimit;
}

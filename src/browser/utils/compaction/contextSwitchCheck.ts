/**
 * Context switch check utility
 *
 * Determines whether switching to a new model would exceed the model's context limit.
 * Used to warn users before they switch from a high-context model (e.g., Gemini 1M)
 * to a lower-context model (e.g., GPT 272K) when their current context is too large.
 */

import type { EffectivePolicy, ProvidersConfigMap } from "@/common/orpc/types";
import type { DisplayedMessage } from "@/common/types/message";
import { getPreferredCompactionModel } from "@/browser/utils/messages/compactionModelPreference";
import { modelSelectionEqualityKey } from "@/common/utils/ai/models";
import { getEffectiveContextLimit } from "@/common/utils/compaction/contextLimit";
import { getExplicitCompactionSuggestion, type CompactionRouteOptions } from "./suggestion";

/** Safety buffer - warn if context exceeds 90% of target model's limit */
const CONTEXT_FIT_THRESHOLD = 0.9;

/** Warning state returned when context doesn't fit in target model */
export interface ContextSwitchWarning {
  currentTokens: number;
  targetLimit: number;
  targetModel: string;
  /** Model to use for compaction, or null if none available */
  compactionModel: string | null;
  /** Error message when no capable compaction model exists */
  errorMessage: string | null;
}

/**
 * Find the most recent assistant message's model from chat history.
 */
export function findPreviousModel(messages: DisplayedMessage[]): string | null {
  for (let i = messages.length - 1; i >= 0; i--) {
    const msg = messages[i];
    if (msg.type === "assistant" && msg.model) return msg.model;
  }
  return null;
}

/** Options for accessibility checks in context switch validation */
export interface ContextSwitchOptions extends CompactionRouteOptions {
  providersConfig: ProvidersConfigMap | null;
  policy: EffectivePolicy | null;
}

/**
 * Resolve compaction model: preferred (if fits + accessible) → previous (if fits + accessible) → null.
 */
function resolveCompactionModel(
  currentTokens: number,
  previousModel: string | null,
  use1M: boolean,
  options: ContextSwitchOptions
): string | null {
  const preferred = getPreferredCompactionModel();
  if (preferred) {
    // Validate accessibility via getExplicitCompactionSuggestion (checks provider config + policy)
    const accessible = getExplicitCompactionSuggestion({
      modelId: preferred,
      providersConfig: options.providersConfig,
      policy: options.policy,
      routePriority: options.routePriority,
      routeOverrides: options.routeOverrides,
    });
    const limit = getEffectiveContextLimit(preferred, use1M, options.providersConfig);
    if (accessible && limit && limit > currentTokens) return preferred;
  }
  if (previousModel) {
    const accessible = getExplicitCompactionSuggestion({
      modelId: previousModel,
      providersConfig: options.providersConfig,
      policy: options.policy,
      routePriority: options.routePriority,
      routeOverrides: options.routeOverrides,
    });
    const limit = getEffectiveContextLimit(previousModel, use1M, options.providersConfig);
    if (accessible && limit && limit > currentTokens) return previousModel;
  }
  return null;
}

/**
 * Check if switching to targetModel would exceed its context limit.
 * Returns warning info if context doesn't fit, null otherwise.
 *
 * The `options` parameter validates compaction model accessibility via provider config and policy.
 */
export function checkContextSwitch(
  currentTokens: number,
  targetModel: string,
  previousModel: string | null,
  use1M: boolean,
  options: ContextSwitchOptions,
  opts?: { allowSameModel?: boolean }
): ContextSwitchWarning | null {
  // Only warn on same-model changes when the caller knows the effective limit changed
  // (ex: 1M context toggle). Otherwise, workspace entry/sync should stay silent.
  if (
    !opts?.allowSameModel &&
    previousModel &&
    // Coder-aware equality: a cross-typed Coder route and the direct provider
    // can have different effective limits (e.g. 1M on the Anthropic-typed
    // gateway route), so switching between them must still be evaluated
    // rather than suppressed as a same-model change.
    modelSelectionEqualityKey(targetModel) === modelSelectionEqualityKey(previousModel)
  ) {
    return null;
  }

  const targetLimit = getEffectiveContextLimit(targetModel, use1M, options.providersConfig);

  // Unknown model or context fits with 10% buffer - no warning
  if (!targetLimit || currentTokens <= targetLimit * CONTEXT_FIT_THRESHOLD) {
    return null;
  }

  const compactionModel = resolveCompactionModel(currentTokens, previousModel, use1M, options);

  return {
    currentTokens,
    targetLimit,
    targetModel,
    compactionModel,
    errorMessage: compactionModel
      ? null
      : "Context too large. Use `/compact -m <model>` with a 1M context model.",
  };
}

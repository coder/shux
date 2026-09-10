/**
 * Compaction options transformation
 *
 * Single source of truth for converting compaction metadata into SendMessageOptions.
 * Used by both ChatInput (initial send) and RetryBarrier manual resume actions.
 */

import { readPersistedState } from "@/browser/hooks/usePersistedState";
import { AGENT_AI_DEFAULTS_KEY } from "@/common/constants/storage";
import type { SendMessageOptions } from "@/common/orpc/types";
import type { CompactionRequestData } from "@/common/types/message";
import type { AgentAiDefaults } from "@/common/types/agentAiDefaults";
import { coerceOpenAIReasoningMode, coerceThinkingLevel } from "@/common/types/thinking";
import {
  InvalidExplicitAiSettingError,
  resolveAgentAiSettings,
} from "@/common/utils/ai/resolveAgentAiSettings";

/**
 * Apply compaction-specific option overrides to base options.
 *
 * This function is the single source of truth for how compaction metadata
 * transforms workspace defaults. Both initial sends and stream resumption
 * use this function to ensure consistent behavior.
 *
 * @param baseOptions - Workspace default options (from localStorage or useSendMessageOptions)
 * @param compactData - Compaction request metadata from /compact command
 * @returns Final SendMessageOptions with compaction overrides applied
 */
export function applyCompactionOverrides(
  baseOptions: SendMessageOptions,
  compactData: CompactionRequestData
): SendMessageOptions {
  const compactionModelOverride = compactData.model?.trim();
  const agentAiDefaults = readPersistedState<AgentAiDefaults>(AGENT_AI_DEFAULTS_KEY, {});

  // Unified resolution as agent "compact": the /compact -m flag is the
  // explicit tier, configured compact defaults (and their base chain, so a
  // saved Exec pro default reaches compaction) win over the workspace's live
  // settings (parent runtime). The send path re-gates reasoning per
  // model/route so pro is inert for unsupported models.
  const resolveWith = (explicitModel: string | undefined) =>
    resolveAgentAiSettings({
      targetAgentId: "compact",
      profile: "interactive",
      explicit: { model: explicitModel },
      agentAiDefaults,
      parentRuntime: {
        model: baseOptions.model,
        thinkingLevel: coerceThinkingLevel(baseOptions.thinkingLevel),
        reasoningMode: coerceOpenAIReasoningMode(baseOptions.reasoningMode),
      },
    });

  let resolved;
  let compactionModel: string;
  try {
    // The resolver treats an empty/whitespace explicit model as absent.
    resolved = resolveWith(compactionModelOverride);
    compactionModel = resolved.selected.model;
  } catch (error) {
    if (!(error instanceof InvalidExplicitAiSettingError)) {
      throw error;
    }
    // Preserve the legacy surface for an unrecognized -m value: send it
    // verbatim and let the backend reject it visibly (model_not_found).
    resolved = resolveWith(undefined);
    compactionModel = compactionModelOverride ?? baseOptions.model;
  }

  return {
    ...baseOptions,
    agentId: "compact",
    // Compaction shouldn't update persisted model/thinking defaults.
    skipAiSettingsPersistence: true,
    model: compactionModel,
    thinkingLevel: resolved.effective.thinkingLevel,
    ...(resolved.selected.reasoningMode != null
      ? { reasoningMode: resolved.selected.reasoningMode }
      : {}),
    maxOutputTokens: compactData.maxOutputTokens,
    // Disable all tools during compaction - regex .* matches all tool names
    toolPolicy: [{ regex_match: ".*", action: "disable" }],
  };
}

import React from "react";
import { useWorkspaceUsage } from "@/browser/stores/WorkspaceStore";
import { usePersistedState } from "@/browser/hooks/usePersistedState";
import { AGENT_AI_DEFAULTS_KEY } from "@/common/constants/storage";
import { resolveCompactionModel } from "@/browser/utils/messages/compactionModelPreference";
import type { AgentAiDefaults } from "@/common/types/agentAiDefaults";
import { useProviderOptions } from "@/browser/hooks/useProviderOptions";
import { useSendMessageOptions } from "@/browser/hooks/useSendMessageOptions";
import { calculateTokenMeterData } from "@/common/utils/tokens/tokenMeterUtils";
import { ContextUsageBar } from "./ContextUsageBar";
import { useProvidersConfig } from "@/browser/hooks/useProvidersConfig";
import { useAutoCompactionSettings } from "@/browser/hooks/useAutoCompactionSettings";
import { getEffectiveContextLimit } from "@/common/utils/compaction/contextLimit";

interface ContextUsageSectionProps {
  workspaceId: string;
}

/**
 * Context usage meter with auto-compaction threshold slider.
 * Rendered above the Stats sub-tabs so it stays visible on every sub-tab.
 */
export const ContextUsageSection: React.FC<ContextUsageSectionProps> = ({ workspaceId }) => {
  const usage = useWorkspaceUsage(workspaceId);
  const [agentAiDefaults] = usePersistedState<AgentAiDefaults>(
    AGENT_AI_DEFAULTS_KEY,
    {},
    {
      listener: true,
    }
  );
  const configuredCompactionModel = agentAiDefaults.compact?.modelString ?? "";
  const { has1MContext } = useProviderOptions();
  const pendingSendOptions = useSendMessageOptions(workspaceId);
  const { config: providersConfig } = useProvidersConfig();

  // Token counts come from usage metadata, but context limits/1M eligibility should
  // follow the currently selected model unless a stream is actively running.
  const contextDisplayModel = usage.liveUsage?.model ?? pendingSendOptions.baseModel;
  // Align warning with /compact model resolution so it matches actual compaction behavior.
  const effectiveCompactionModel =
    resolveCompactionModel(configuredCompactionModel) ?? contextDisplayModel;

  // Auto-compaction settings: threshold per-model (100 = disabled)
  const {
    threshold: autoCompactThreshold,
    setThreshold: setAutoCompactThreshold,
    rolloverEnabled,
  } = useAutoCompactionSettings(workspaceId, contextDisplayModel);

  const contextUsage = usage.liveUsage ?? usage.lastContextUsage;
  if (!contextUsage) {
    return null;
  }

  const contextUsageData = calculateTokenMeterData(
    contextUsage,
    contextDisplayModel,
    has1MContext(contextDisplayModel),
    false,
    providersConfig
  );

  // Warn when the compaction model can't fit the auto-compact threshold to avoid failures.
  const contextWarning = (() => {
    const maxTokens = contextUsageData.maxTokens;
    if (rolloverEnabled || !maxTokens || autoCompactThreshold >= 100 || !effectiveCompactionModel)
      return undefined;

    const thresholdTokens = Math.round((autoCompactThreshold / 100) * maxTokens);
    const compactionMaxTokens = getEffectiveContextLimit(
      effectiveCompactionModel,
      has1MContext(effectiveCompactionModel),
      providersConfig
    );

    if (compactionMaxTokens && compactionMaxTokens < thresholdTokens) {
      return { compactionModelMaxTokens: compactionMaxTokens, thresholdTokens };
    }
    return undefined;
  })();

  return (
    <div
      data-testid="context-usage-section"
      className="text-light font-primary mt-2 mb-4 text-[13px] leading-relaxed"
    >
      <ContextUsageBar
        testId="context-usage"
        data={contextUsageData}
        model={contextDisplayModel}
        autoCompaction={{
          threshold: autoCompactThreshold,
          setThreshold: setAutoCompactThreshold,
          contextWarning,
          rolloverEnabled,
        }}
      />
    </div>
  );
};

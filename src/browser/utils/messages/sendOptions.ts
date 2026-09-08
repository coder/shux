import {
  getAgentIdKey,
  getModelKey,
  getReasoningModeKey,
  getThinkingLevelByModelKey,
  getThinkingLevelKey,
  getDisableWorkspaceAgentsKey,
} from "@/common/constants/storage";
import { readPersistedState, updatePersistedState } from "@/browser/hooks/usePersistedState";
import { getDefaultModel } from "@/browser/hooks/useModelsFromSettings";
import {
  buildSendMessageOptions,
  normalizeModelPreference,
} from "@/browser/utils/messages/buildSendMessageOptions";
import type { SendMessageOptions } from "@/common/orpc/types";
import {
  coerceOpenAIReasoningMode,
  type OpenAIReasoningMode,
  type ThinkingLevel,
} from "@/common/types/thinking";
import type { MuxProviderOptions } from "@/common/types/providerOptions";
import { WORKSPACE_DEFAULTS } from "@/constants/workspaceDefaults";
import { isExperimentEnabled } from "@/browser/hooks/useExperiments";
import { EXPERIMENT_IDS } from "@/common/constants/experiments";

/**
 * Read provider options from localStorage
 */
function getProviderOptions(): MuxProviderOptions {
  const anthropic = readPersistedState<MuxProviderOptions["anthropic"]>(
    "provider_options_anthropic",
    {}
  );
  const google = readPersistedState<MuxProviderOptions["google"]>("provider_options_google", {});

  return {
    anthropic,
    google,
  };
}

/**
 * Non-hook equivalent of useSendMessageOptions — reads current preferences from localStorage.
 * Used by compaction, resume, idle-compaction, and plan execution outside React context.
 */
export function getSendOptionsFromStorage(workspaceId: string): SendMessageOptions {
  const defaultModel = getDefaultModel();
  const rawModel = readPersistedState<string>(getModelKey(workspaceId), defaultModel);
  const baseModel = normalizeModelPreference(rawModel, defaultModel);

  // Read thinking level (workspace-scoped).
  // Migration: if the workspace-scoped value is missing, fall back to legacy per-model storage
  // once, then persist into the workspace-scoped key.
  const scopedKey = getThinkingLevelKey(workspaceId);
  const existingScoped = readPersistedState<ThinkingLevel | undefined>(scopedKey, undefined);
  const thinkingLevel =
    existingScoped ??
    readPersistedState<ThinkingLevel>(
      getThinkingLevelByModelKey(baseModel),
      WORKSPACE_DEFAULTS.thinkingLevel
    );
  if (existingScoped === undefined) {
    // Best-effort: avoid losing a user's existing per-model preference.
    updatePersistedState<ThinkingLevel>(scopedKey, thinkingLevel);
  }

  const agentId = readPersistedState<string>(
    getAgentIdKey(workspaceId),
    WORKSPACE_DEFAULTS.agentId
  );

  // OpenAI pro reasoning mode (workspace-scoped); absent = standard.
  // Coerce untrusted persisted values so corrupt entries self-heal to "standard"
  // instead of failing SendMessageOptionsSchema on retry/resume/creation flows.
  const reasoningMode =
    coerceOpenAIReasoningMode(
      readPersistedState<OpenAIReasoningMode | null>(getReasoningModeKey(workspaceId), null)
    ) ?? "standard";

  const providerOptions = getProviderOptions();

  const disableWorkspaceAgents = readPersistedState<boolean>(
    getDisableWorkspaceAgentsKey(workspaceId),
    false
  );

  return buildSendMessageOptions({
    model: baseModel,
    agentId,
    thinkingLevel,
    reasoningMode,
    providerOptions,
    disableWorkspaceAgents,
    experiments: {
      programmaticToolCalling: isExperimentEnabled(EXPERIMENT_IDS.PROGRAMMATIC_TOOL_CALLING),
      rlm: isExperimentEnabled(EXPERIMENT_IDS.RLM),
      advisorTool: isExperimentEnabled(EXPERIMENT_IDS.ADVISOR_TOOL),
      dynamicWorkflows: isExperimentEnabled(EXPERIMENT_IDS.DYNAMIC_WORKFLOWS),
      memory: isExperimentEnabled(EXPERIMENT_IDS.MEMORY),
      memoryIntuition: isExperimentEnabled(EXPERIMENT_IDS.MEMORY_INTUITION),
      toolSearch: isExperimentEnabled(EXPERIMENT_IDS.TOOL_SEARCH),
      continuousCompaction: isExperimentEnabled(EXPERIMENT_IDS.CONTINUOUS_COMPACTION),
      tokenBudget: isExperimentEnabled(EXPERIMENT_IDS.TOKEN_BUDGET),
    },
  });
}

import { WORKSPACE_DEFAULTS } from "@/constants/workspaceDefaults";
import { useReasoningMode } from "./useReasoningMode";
import { useThinkingLevel } from "./useThinkingLevel";
import { useAgent } from "@/browser/contexts/AgentContext";
import { usePersistedState } from "./usePersistedState";
import {
  buildSendMessageOptions,
  normalizeModelPreference,
} from "@/browser/utils/messages/buildSendMessageOptions";
import { DEFAULT_MODEL_KEY, getModelKey } from "@/common/constants/storage";
import type { SendMessageOptions } from "@/common/orpc/types";
import { useProviderOptions } from "./useProviderOptions";
import { useExperimentOverrideValue } from "./useExperiments";
import { EXPERIMENT_IDS } from "@/common/constants/experiments";
import { useWorkspaceContext } from "@/browser/contexts/WorkspaceContext";
import { resolveEffectiveComposerModel } from "@/browser/utils/workspaceAiSettingsSync";

/**
 * Extended send options that includes both the canonical model used for backend routing
 * and a base model string for UI components that need a stable display value.
 */
export interface SendMessageOptionsWithBase extends SendMessageOptions {
  /** Base model in canonical format (e.g., "openai:gpt-5.1-codex-max") for UI/policy checks */
  baseModel: string;
}

/**
 * Single source of truth for message send options (ChatInput, RetryBarrier, etc.).
 * Subscribes to persisted preferences so model/thinking/agent changes propagate automatically.
 */
export function useSendMessageOptions(workspaceId: string): SendMessageOptionsWithBase {
  const [thinkingLevel] = useThinkingLevel();
  const [reasoningMode] = useReasoningMode();
  const { agentId, disableWorkspaceAgents } = useAgent();
  const { workspaceMetadata } = useWorkspaceContext();
  const { options: providerOptions } = useProviderOptions();

  // Subscribe to the global default model preference so backend-seeded values apply
  // immediately on fresh origins (e.g., when switching ports).
  const [defaultModelPref] = usePersistedState<string>(
    DEFAULT_MODEL_KEY,
    WORKSPACE_DEFAULTS.model,
    { listener: true }
  );
  const defaultModel = normalizeModelPreference(defaultModelPref, WORKSPACE_DEFAULTS.model);

  // Workspace-scoped model preference. If unset, fall back to metadata, then global default.
  // Note: we intentionally *don't* pass defaultModel as the usePersistedState initialValue;
  // initialValue is sticky and would lock in the fallback before startup seeding.
  const [preferredModel] = usePersistedState<string | null>(getModelKey(workspaceId), null, {
    listener: true,
  });

  // Subscribe to local override state so toggles apply immediately.
  const programmaticToolCalling = useExperimentOverrideValue(
    EXPERIMENT_IDS.PROGRAMMATIC_TOOL_CALLING
  );
  const rlm = useExperimentOverrideValue(EXPERIMENT_IDS.RLM);
  const advisorTool = useExperimentOverrideValue(EXPERIMENT_IDS.ADVISOR_TOOL);
  const dynamicWorkflows = useExperimentOverrideValue(EXPERIMENT_IDS.DYNAMIC_WORKFLOWS);
  const memory = useExperimentOverrideValue(EXPERIMENT_IDS.MEMORY);
  const memoryIntuition = useExperimentOverrideValue(EXPERIMENT_IDS.MEMORY_INTUITION);
  const toolSearch = useExperimentOverrideValue(EXPERIMENT_IDS.TOOL_SEARCH);
  const continuousCompaction = useExperimentOverrideValue(EXPERIMENT_IDS.CONTINUOUS_COMPACTION);
  const tokenBudget = useExperimentOverrideValue(EXPERIMENT_IDS.TOKEN_BUDGET);

  // Prefer metadata over the global default until workspace localStorage seeding catches up.
  const baseModel = resolveEffectiveComposerModel(
    preferredModel,
    workspaceMetadata.get(workspaceId),
    agentId,
    defaultModel
  );

  const options = buildSendMessageOptions({
    agentId,
    thinkingLevel,
    reasoningMode,
    model: baseModel,
    providerOptions,
    experiments: {
      programmaticToolCalling,
      rlm,
      advisorTool,
      dynamicWorkflows,
      memory,
      memoryIntuition,
      toolSearch,
      continuousCompaction,
      tokenBudget,
    },
    disableWorkspaceAgents,
  });

  return {
    ...options,
    baseModel,
  };
}

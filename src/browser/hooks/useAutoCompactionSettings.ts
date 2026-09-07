import { EXPERIMENT_IDS } from "@/common/constants/experiments";
import { useExperimentValue } from "./useExperiments";
import { usePersistedState } from "@/browser/hooks/usePersistedState";
import { getAutoCompactionThresholdKey } from "@/common/constants/storage";
import { DEFAULT_AUTO_COMPACTION_THRESHOLD_PERCENT } from "@/common/constants/ui";

export interface AutoCompactionSettings {
  /** Current threshold percentage (50-100). 100 means disabled. */
  threshold: number;
  /** Automatic rollover yields to continuous compaction and effective RLM. */
  rolloverEnabled: boolean;
  /** Update threshold percentage */
  setThreshold: (value: number) => void;
}

/**
 * Custom hook for auto-compaction settings.
 * - Threshold is per-model (different models have different context windows)
 * - Threshold >= 100% means disabled for that model
 *
 * @param workspaceId - Workspace identifier (unused now, kept for API compatibility if needed)
 * @param model - Model identifier for threshold (e.g., "claude-sonnet-4-5")
 * @returns Settings object with getters and setters
 */
export function useAutoCompactionSettings(
  _workspaceId: string,
  model: string | null
): AutoCompactionSettings {
  // Use model for threshold key, fall back to "default" if no model
  const thresholdKey = getAutoCompactionThresholdKey(model ?? "default");
  const [threshold, setThreshold] = usePersistedState<number>(
    thresholdKey,
    DEFAULT_AUTO_COMPACTION_THRESHOLD_PERCENT,
    { listener: true }
  );

  const tokenBudget = useExperimentValue(EXPERIMENT_IDS.TOKEN_BUDGET);
  const continuousCompaction = useExperimentValue(EXPERIMENT_IDS.CONTINUOUS_COMPACTION);
  const ptc = useExperimentValue(EXPERIMENT_IDS.PROGRAMMATIC_TOOL_CALLING);
  const rlm = useExperimentValue(EXPERIMENT_IDS.RLM);
  const rolloverEnabled = tokenBudget && !continuousCompaction && !(ptc && rlm);

  return { threshold, setThreshold, rolloverEnabled };
}

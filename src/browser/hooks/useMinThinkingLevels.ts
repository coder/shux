import { useCallback, useSyncExternalStore } from "react";
import { useOptionalAPI } from "@/browser/contexts/API";
import { useProvidersConfig } from "@/browser/hooks/useProvidersConfig";
import { getAppConfigStore } from "@/browser/stores/AppConfigStore";
import { normalizeSelectedModel } from "@/common/utils/ai/models";
import {
  getAvailableThinkingLevels,
  getDefaultMinimumThinkingLevel,
  lookupMinThinkingLevelOverride,
  resolveMinimumThinkingLevel,
} from "@/common/utils/thinking/policy";
import type { ThinkingLevel } from "@/common/types/thinking";

// Stable fallback so snapshot-less renders don't churn referential equality.
const EMPTY_MIN_LEVELS: Record<string, ThinkingLevel> = {};

export interface MinThinkingLevelsState {
  /** Per-model minimum thinking overrides, keyed by canonical model id. */
  minThinkingLevelByModel: Record<string, ThinkingLevel>;
  // Arrow-function property types (not method shorthand) so consumers can safely
  // destructure these without tripping @typescript-eslint/unbound-method.
  /** Explicit per-model override (undefined when the model uses the default floor). */
  getMinOverride: (modelString: string) => ThinkingLevel | undefined;
  /** Effective floor for a model: explicit override, else the built-in default. */
  getMinimum: (modelString: string) => ThinkingLevel;
  /** Set (or clear, with null) a model's minimum thinking override. */
  setMinThinkingLevel: (modelString: string, level: ThinkingLevel | null) => void;
}

/**
 * Reads/writes the per-model "Minimum Thinking level" map from app config.
 *
 * Mirrors the route-override pattern (useRouting): fetch on mount, subscribe to
 * config changes, and optimistically apply local edits while ignoring stale fetches.
 * The map is the single source of truth that the thinking selector, keybind cycle, and
 * command palette consult to hide thinking levels below the configured floor.
 */
export function useMinThinkingLevels(): MinThinkingLevelsState {
  // Optional so providers that mount this (e.g. ThinkingProvider) don't crash when rendered
  // outside an APIProvider in isolated test harnesses; without an api we degrade to defaults.
  const api = useOptionalAPI()?.api ?? null;
  // Resolve mapped aliases (mappedToModel) to their capability model so floors
  // and ladders match the target model; degrades to null outside APIProvider.
  const { config: providersConfig } = useProvidersConfig();
  // Shared AppConfigStore (one fetch + one onConfigChanged subscription per
  // app session) instead of per-mount fetches — see useRouting.
  const store = getAppConfigStore();
  const appConfig = useSyncExternalStore(store.subscribe, store.getSnapshot);
  const minThinkingLevelByModel = appConfig?.minThinkingLevelByModel ?? EMPTY_MIN_LEVELS;

  // Lookups go through lookupMinThinkingLevelOverride so floors persisted by
  // older versions under the name-canonical key keep applying (see helper).
  const getMinOverride = useCallback(
    (modelString: string): ThinkingLevel | undefined =>
      lookupMinThinkingLevelOverride(minThinkingLevelByModel, modelString),
    [minThinkingLevelByModel]
  );

  const getMinimum = useCallback(
    (modelString: string): ThinkingLevel =>
      resolveMinimumThinkingLevel(
        modelString,
        lookupMinThinkingLevelOverride(minThinkingLevelByModel, modelString),
        providersConfig
      ),
    [minThinkingLevelByModel, providersConfig]
  );

  const setMinThinkingLevel = useCallback(
    (modelString: string, level: ThinkingLevel | null) => {
      const key = normalizeSelectedModel(modelString);
      const next = { ...minThinkingLevelByModel };
      // Keep the persisted map sparse: clear the override when it has the same effect as the
      // built-in default floor. We compare effective lowest-available levels so models whose
      // default floor isn't a native level still collapse correctly (e.g. gemini-3, where the
      // medium default and an explicit "high" both yield ["high"]).
      const defaultFloor = getAvailableThinkingLevels(
        modelString,
        getDefaultMinimumThinkingLevel(modelString, providersConfig),
        providersConfig
      )[0];
      const pickedFloor =
        level == null ? null : getAvailableThinkingLevels(modelString, level, providersConfig)[0];
      if (level == null || pickedFloor === defaultFloor) {
        delete next[key];
      } else {
        next[key] = level;
      }

      store.updateOptimistically({ minThinkingLevelByModel: next });

      api?.config?.updateMinThinkingLevels({ minThinkingLevelByModel: next }).catch(() => {
        // If the write fails, re-fetch so the UI reverts to the backend's actual floor rather
        // than displaying an override the send path (which reads config synchronously) never
        // applied. On success, the onConfigChanged subscription already reconciles state.
        void store.refresh();
      });
    },
    [api, minThinkingLevelByModel, providersConfig, store]
  );

  return {
    minThinkingLevelByModel,
    getMinOverride,
    getMinimum,
    setMinThinkingLevel,
  };
}

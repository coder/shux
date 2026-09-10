import type { ReactNode } from "react";
import React, { createContext, useContext, useEffect, useMemo, useCallback } from "react";
import {
  THINKING_LEVEL_OFF,
  coerceOpenAIReasoningMode,
  type OpenAIReasoningMode,
  type ThinkingLevel,
} from "@/common/types/thinking";
import {
  readPersistedState,
  updatePersistedState,
  usePersistedState,
} from "@/browser/hooks/usePersistedState";
import {
  getAgentIdKey,
  getModelKey,
  getProjectScopeId,
  getReasoningModeKey,
  getThinkingLevelByModelKey,
  getThinkingLevelKey,
  getWorkspaceAISettingsByAgentKey,
  GLOBAL_SCOPE_ID,
} from "@/common/constants/storage";
import { getDefaultModel } from "@/browser/hooks/useModelsFromSettings";
import { normalizeSelectedModel, normalizeToCanonical } from "@/common/utils/ai/models";
import { enforceThinkingPolicy, getAvailableThinkingLevels } from "@/common/utils/thinking/policy";
import { useMinThinkingLevels } from "@/browser/hooks/useMinThinkingLevels";
import { useProvidersConfig } from "@/browser/hooks/useProvidersConfig";
import { useAPI } from "@/browser/contexts/API";
import { requestActiveTurnThinkingLevel } from "@/browser/utils/activeTurnThinking";
import { getWorkspaceAiSettingsFromMetadata } from "@/browser/utils/workspaceAiSettingsSync";
import { useOptionalWorkspaceContext } from "@/browser/contexts/WorkspaceContext";
import { KEYBINDS, matchesKeybind } from "@/browser/utils/ui/keybinds";
import { WORKSPACE_DEFAULTS } from "@/constants/workspaceDefaults";

interface ThinkingContextType {
  thinkingLevel: ThinkingLevel;
  setThinkingLevel: (level: ThinkingLevel) => void;
  /** OpenAI pro reasoning-mode toggle; sibling of thinkingLevel (orthogonal on the wire). */
  reasoningMode: OpenAIReasoningMode;
  setReasoningMode: (mode: OpenAIReasoningMode) => void;
}

const ThinkingContext = createContext<ThinkingContextType | undefined>(undefined);

interface ThinkingProviderProps {
  workspaceId?: string; // Workspace-scoped storage (highest priority)
  projectPath?: string; // Project-scoped storage (fallback if no workspaceId)
  children: ReactNode;
}

function getScopeId(workspaceId: string | undefined, projectPath: string | undefined): string {
  return workspaceId ?? (projectPath ? getProjectScopeId(projectPath) : GLOBAL_SCOPE_ID);
}

function getCanonicalModelForScope(scopeId: string, fallbackModel: string): string {
  const rawModel = readPersistedState<string>(getModelKey(scopeId), fallbackModel);
  return normalizeToCanonical(rawModel || fallbackModel);
}

function getModelForThinkingUpdate(
  scopeId: string,
  metadataModel: string | undefined,
  fallbackModel: string
): string {
  const persistedModel = readPersistedState<string | undefined>(getModelKey(scopeId), undefined);
  // Prefer localStorage, then metadata, then the default model to avoid clobbering startup metadata.
  // normalizeSelectedModel (not normalizeToCanonical): this value is persisted
  // back via persistAgentAiSettings, and explicit gateway identities must
  // survive — normalizeToCanonical rewrites coder:openai/<claude> (a valid
  // cross-typed instance) to openai:<claude> from the name alone, so merely
  // changing the thinking level would silently reroute the workspace to
  // direct OpenAI. Thinking policy lookups resolve gateway-scoped strings
  // through resolveModelForMetadata, so capability behavior is unchanged.
  return normalizeSelectedModel(persistedModel ?? metadataModel ?? fallbackModel);
}

export const ThinkingProvider: React.FC<ThinkingProviderProps> = (props) => {
  const { api } = useAPI();
  const workspaceContext = useOptionalWorkspaceContext();
  const { getMinimum } = useMinThinkingLevels();
  // Resolve mapped aliases so keybind stepping walks the target model's ladder.
  const { config: providersConfig } = useProvidersConfig();
  const defaultModel = getDefaultModel();
  const scopeId = getScopeId(props.workspaceId, props.projectPath);
  const thinkingKey = getThinkingLevelKey(scopeId);
  const metadataAgentId = readPersistedState<string>(
    getAgentIdKey(scopeId),
    WORKSPACE_DEFAULTS.agentId
  );
  const metadataSettings = getWorkspaceAiSettingsFromMetadata(
    props.workspaceId ? workspaceContext?.workspaceMetadata.get(props.workspaceId) : undefined,
    metadataAgentId
  );

  // Workspace-scoped thinking. Null means no explicit user choice has been persisted yet.
  const [persistedThinkingLevel, setThinkingLevelInternal] =
    usePersistedState<ThinkingLevel | null>(thinkingKey, null, { listener: true });
  const thinkingLevel =
    persistedThinkingLevel ?? metadataSettings.thinkingLevel ?? THINKING_LEVEL_OFF;

  // Workspace-scoped OpenAI pro reasoning mode. Null = no explicit user choice yet;
  // absent everywhere means "standard" (the API default).
  const reasoningKey = getReasoningModeKey(scopeId);
  const [persistedReasoningMode, setReasoningModeInternal] =
    usePersistedState<OpenAIReasoningMode | null>(reasoningKey, null, { listener: true });
  // Coerce untrusted persisted values (corrupt entries or a future downgrade) so
  // bad state self-heals to "standard" instead of failing SendMessageOptionsSchema
  // validation and bricking sends until storage is cleared.
  const reasoningMode =
    coerceOpenAIReasoningMode(persistedReasoningMode) ??
    coerceOpenAIReasoningMode(metadataSettings.reasoningMode) ??
    "standard";

  // One-time migration: if the new workspace-scoped key is missing, seed from the legacy per-model key.
  useEffect(() => {
    const existing = readPersistedState<ThinkingLevel | null | undefined>(thinkingKey, undefined);
    if (existing != null) {
      return;
    }

    const model = getCanonicalModelForScope(scopeId, defaultModel);
    const legacyKey = getThinkingLevelByModelKey(model);
    const legacy = readPersistedState<ThinkingLevel | undefined>(legacyKey, undefined);
    if (legacy === undefined) {
      return;
    }

    updatePersistedState(thinkingKey, legacy);
  }, [defaultModel, scopeId, thinkingKey]);

  // Keep picker choices local until a user message sends the full settings.
  const persistAgentAiSettings = useCallback(
    (settings: {
      model: string;
      thinkingLevel: ThinkingLevel;
      reasoningMode: OpenAIReasoningMode;
    }) => {
      if (!props.workspaceId) {
        return;
      }

      const workspaceId = props.workspaceId;

      type WorkspaceAISettingsByAgentCache = Partial<
        Record<
          string,
          { model: string; thinkingLevel: ThinkingLevel; reasoningMode?: OpenAIReasoningMode }
        >
      >;

      const normalizedAgentId =
        readPersistedState<string>(getAgentIdKey(scopeId), WORKSPACE_DEFAULTS.agentId)
          .trim()
          .toLowerCase() || WORKSPACE_DEFAULTS.agentId;

      updatePersistedState<WorkspaceAISettingsByAgentCache>(
        getWorkspaceAISettingsByAgentKey(workspaceId),
        (prev) => {
          const record: WorkspaceAISettingsByAgentCache =
            prev && typeof prev === "object" ? prev : {};
          return {
            ...record,
            [normalizedAgentId]: settings,
          };
        },
        {}
      );
    },
    [props.workspaceId, scopeId]
  );

  // Read the sibling setting at call time (not from the render closure) so
  // rapid interleaved updates cannot persist a stale counterpart value.
  const getCurrentReasoningMode = useCallback(
    (): OpenAIReasoningMode =>
      coerceOpenAIReasoningMode(
        readPersistedState<OpenAIReasoningMode | null>(reasoningKey, null)
      ) ??
      coerceOpenAIReasoningMode(metadataSettings.reasoningMode) ??
      "standard",
    [metadataSettings.reasoningMode, reasoningKey]
  );

  const getCurrentThinkingLevel = useCallback(
    (): ThinkingLevel =>
      readPersistedState<ThinkingLevel | null>(thinkingKey, null) ??
      metadataSettings.thinkingLevel ??
      THINKING_LEVEL_OFF,
    [metadataSettings.thinkingLevel, thinkingKey]
  );

  const setThinkingLevel = useCallback(
    (level: ThinkingLevel) => {
      const model = getModelForThinkingUpdate(scopeId, metadataSettings.model, defaultModel);

      setThinkingLevelInternal(level);
      persistAgentAiSettings({
        model,
        thinkingLevel: level,
        reasoningMode: getCurrentReasoningMode(),
      });
      // Mid-turn change: also request the new level for the active turn's next
      // model step. Non-workspace (project/global) mounts have no workspaceId
      // and skip this inside the helper.
      if (props.workspaceId) {
        requestActiveTurnThinkingLevel(api, props.workspaceId, level);
      }
    },
    [
      api,
      defaultModel,
      getCurrentReasoningMode,
      metadataSettings.model,
      persistAgentAiSettings,
      props.workspaceId,
      scopeId,
      setThinkingLevelInternal,
    ]
  );

  const setReasoningMode = useCallback(
    (mode: OpenAIReasoningMode) => {
      const model = getModelForThinkingUpdate(scopeId, metadataSettings.model, defaultModel);

      setReasoningModeInternal(mode);
      persistAgentAiSettings({
        model,
        thinkingLevel: getCurrentThinkingLevel(),
        reasoningMode: mode,
      });
    },
    [
      defaultModel,
      getCurrentThinkingLevel,
      metadataSettings.model,
      persistAgentAiSettings,
      scopeId,
      setReasoningModeInternal,
    ]
  );

  // Global keybinds for adjusting the thinking level.
  // Implemented at the ThinkingProvider level so they work in both the workspace view
  // and the "New Workspace" creation screen (which doesn't mount AIView).
  useEffect(() => {
    const handleKeyDown = (e: KeyboardEvent) => {
      const isIncrease = matchesKeybind(e, KEYBINDS.INCREASE_THINKING);
      const isDecrease = matchesKeybind(e, KEYBINDS.DECREASE_THINKING);
      // TOGGLE_THINKING is deprecated but still honored for muscle memory.
      const isCycle = matchesKeybind(e, KEYBINDS.TOGGLE_THINKING);
      if (!isIncrease && !isDecrease && !isCycle) {
        return;
      }

      e.preventDefault();

      // Keep stepping aligned with setThinkingLevel so startup metadata uses the matching policy.
      const model = getModelForThinkingUpdate(scopeId, metadataSettings.model, defaultModel);
      // Step only within levels at or above the model's minimum floor.
      const minimum = getMinimum(model);
      const allowed = getAvailableThinkingLevels(model, minimum, providersConfig);
      if (allowed.length <= 1) {
        return;
      }

      const effectiveThinkingLevel = enforceThinkingPolicy(
        model,
        thinkingLevel,
        minimum,
        providersConfig
      );
      const currentIndex = allowed.indexOf(effectiveThinkingLevel);

      // Increase/decrease are directional: clamp at the ends instead of wrapping,
      // since stepping past "max"/"off" and looping around is surprising. The
      // legacy cycle keybind keeps its wrap-around behavior.
      const nextIndex = isCycle
        ? (currentIndex + 1) % allowed.length
        : Math.min(allowed.length - 1, Math.max(0, currentIndex + (isIncrease ? 1 : -1)));

      if (nextIndex !== currentIndex) {
        setThinkingLevel(allowed[nextIndex]);
      }
    };

    window.addEventListener("keydown", handleKeyDown);
    return () => window.removeEventListener("keydown", handleKeyDown);
  }, [
    defaultModel,
    getMinimum,
    metadataSettings.model,
    providersConfig,
    scopeId,
    thinkingLevel,
    setThinkingLevel,
  ]);

  // Memoize context value to prevent unnecessary re-renders of consumers.
  const contextValue = useMemo(
    () => ({ thinkingLevel, setThinkingLevel, reasoningMode, setReasoningMode }),
    [thinkingLevel, setThinkingLevel, reasoningMode, setReasoningMode]
  );

  return <ThinkingContext.Provider value={contextValue}>{props.children}</ThinkingContext.Provider>;
};

export const useThinking = () => {
  const context = useContext(ThinkingContext);
  if (!context) {
    throw new Error("useThinking must be used within a ThinkingProvider");
  }
  return context;
};

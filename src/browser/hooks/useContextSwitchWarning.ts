/**
 * Hook for managing context switch warnings.
 *
 * Shows a warning when the user switches to a model that can't fit the current context.
 * Handles model changes, 1M toggle changes, and provides compact/dismiss actions.
 */

import { useReducer, useRef, useEffect, useLayoutEffect, useCallback, useMemo } from "react";
import type { RouterClient } from "@orpc/server";
import type { AppRouter } from "@/node/orpc/router";
import type { ProvidersConfigMap, SendMessageOptions } from "@/common/orpc/types";
import type { DisplayedMessage } from "@/common/types/message";
import type { WorkspaceUsageState } from "@/browser/stores/WorkspaceStore";
import { normalizeSelectedModel } from "@/common/utils/ai/models";
import { usePolicy } from "@/browser/contexts/PolicyContext";
import { useRouting } from "@/browser/hooks/useRouting";
import {
  checkContextSwitch,
  findPreviousModel,
  type ContextSwitchOptions,
  type ContextSwitchWarning,
} from "@/browser/utils/compaction/contextSwitchCheck";
import { getHigherContextCompactionSuggestion } from "@/browser/utils/compaction/suggestion";
import { getEffectiveContextLimit } from "@/common/utils/compaction/contextLimit";
import {
  consumeWorkspaceModelChange,
  setWorkspaceModelWithOrigin,
} from "@/browser/utils/modelChange";
import { executeCompaction } from "@/browser/utils/chatCommands";

interface UseContextSwitchWarningProps {
  workspaceId: string;
  messages: DisplayedMessage[];
  pendingModel: string;
  use1M: boolean;
  workspaceUsage: WorkspaceUsageState | undefined;
  api: RouterClient<AppRouter> | undefined;
  pendingSendOptions: SendMessageOptions;
  providersConfig: ProvidersConfigMap | null;
}

interface UseContextSwitchWarningResult {
  warning: ContextSwitchWarning | null;
  handleModelChange: (newModel: string) => void;
  handleCompact: () => void;
  handleDismiss: () => void;
}

interface PendingSwitch {
  model: string;
  previousModel: string | null;
  deferred: boolean;
}

interface SwitchState {
  currentModel: string;
  pending: PendingSwitch | null;
  warning: ContextSwitchWarning | null;
}

type SwitchAction =
  | { type: "RESET"; model: string }
  | { type: "USER_REQUESTED_MODEL"; pending: PendingSwitch }
  | { type: "MODEL_APPLIED"; model: string }
  | { type: "WARNING_EVALUATED"; warning: ContextSwitchWarning | null }
  | { type: "WARNING_UPDATED"; warning: ContextSwitchWarning | null }
  | { type: "CLEAR_WARNING" }
  | { type: "CLEAR_PENDING" };

const createSwitchState = (model: string): SwitchState => ({
  currentModel: model,
  pending: null,
  warning: null,
});

// Avoid re-dispatching identical warnings when policy/config refreshes churn.
const areWarningsEqual = (
  a: ContextSwitchWarning | null,
  b: ContextSwitchWarning | null
): boolean => {
  if (a === b) return true;
  if (!a || !b) return false;
  return (
    a.currentTokens === b.currentTokens &&
    a.targetLimit === b.targetLimit &&
    a.targetModel === b.targetModel &&
    a.compactionModel === b.compactionModel &&
    a.errorMessage === b.errorMessage
  );
};

// User request: keep explicit model switches isolated so deferred switches
// (tokens === 0) don't leak into background updates.
function switchReducer(state: SwitchState, action: SwitchAction): SwitchState {
  switch (action.type) {
    case "RESET":
      return createSwitchState(action.model);
    case "USER_REQUESTED_MODEL":
      return { ...state, pending: action.pending };
    case "MODEL_APPLIED": {
      if (state.pending && state.pending.model !== action.model) {
        return { currentModel: action.model, pending: null, warning: null };
      }
      if (state.pending && !state.pending.deferred && state.pending.model === action.model) {
        return { ...state, currentModel: action.model, pending: null };
      }
      if (!state.pending && state.warning) {
        return { currentModel: action.model, pending: null, warning: null };
      }
      return { ...state, currentModel: action.model };
    }
    case "WARNING_EVALUATED":
      return { ...state, warning: action.warning, pending: null };
    case "WARNING_UPDATED":
      return { ...state, warning: action.warning };
    case "CLEAR_WARNING":
      return { ...state, warning: null };
    case "CLEAR_PENDING":
      return { ...state, pending: null };
    default:
      return state;
  }
}

export function useContextSwitchWarning(
  props: UseContextSwitchWarningProps
): UseContextSwitchWarningResult {
  const {
    workspaceId,
    messages,
    pendingModel,
    use1M,
    workspaceUsage,
    api,
    pendingSendOptions,
    providersConfig,
  } = props;

  const [switchState, dispatch] = useReducer(switchReducer, pendingModel, createSwitchState);
  const warning = switchState.warning;
  const prevUse1MRef = useRef(use1M);
  const policyState = usePolicy();
  const { routePriority, routeOverrides } = useRouting();
  const effectivePolicy =
    policyState.status.state === "enforced" ? (policyState.policy ?? null) : null;

  // Options for validating compaction model accessibility
  const checkOptions: ContextSwitchOptions = useMemo(
    () => ({
      providersConfig,
      policy: effectivePolicy,
      routePriority,
      routeOverrides,
    }),
    [providersConfig, effectivePolicy, routePriority, routeOverrides]
  );

  const prevCheckOptionsRef = useRef(checkOptions);
  const prevWarningPreviousModelRef = useRef<string | null>(null);
  const lastEvaluatedTargetModelRef = useRef<string | null>(null);
  const dismissedWarningModelRef = useRef<string | null>(null);
  const prevWorkspaceIdRef = useRef(workspaceId);

  // ChatPane is keyed by workspaceId today; keep a defensive reset to avoid stale warnings
  // if mount behavior changes or localStorage sync reuses this hook instance.
  useLayoutEffect(() => {
    if (prevWorkspaceIdRef.current !== workspaceId) {
      prevWorkspaceIdRef.current = workspaceId;
      prevUse1MRef.current = use1M;
      prevCheckOptionsRef.current = checkOptions;
      prevWarningPreviousModelRef.current = null;
      lastEvaluatedTargetModelRef.current = null;
      dismissedWarningModelRef.current = null;
      dispatch({ type: "RESET", model: pendingModel });
    }
  }, [workspaceId, pendingModel, use1M, checkOptions]);

  const getCurrentTokens = useCallback(() => {
    const usage = workspaceUsage?.liveUsage ?? workspaceUsage?.lastContextUsage;
    return usage ? usage.input.tokens + usage.cached.tokens + usage.cacheCreate.tokens : 0;
  }, [workspaceUsage]);

  const tokens = getCurrentTokens();

  // Enhance warning with smarter model suggestion when basic resolution fails.
  // Searches all known models for one with larger context that user can access.
  const enhanceWarning = useCallback(
    (w: ContextSwitchWarning | null): ContextSwitchWarning | null => {
      if (!w || w.compactionModel) return w;

      const suggestion = getHigherContextCompactionSuggestion({
        currentModel: w.targetModel,
        providersConfig,
        policy: effectivePolicy,
        routePriority,
        routeOverrides,
      });

      if (suggestion) {
        const limit = getEffectiveContextLimit(suggestion.modelId, use1M, providersConfig);
        if (limit && limit > w.currentTokens) {
          return { ...w, compactionModel: suggestion.modelId, errorMessage: null };
        }
      }
      return w;
    },
    [providersConfig, effectivePolicy, routePriority, routeOverrides, use1M]
  );

  const evaluateWarning = useCallback(
    (options: {
      tokens: number;
      targetModel: string;
      previousModel: string | null;
      allowSameModel?: boolean;
    }): ContextSwitchWarning | null => {
      if (options.tokens === 0) {
        return null;
      }

      lastEvaluatedTargetModelRef.current = options.targetModel;
      const previousModel = options.previousModel ?? findPreviousModel(messages);
      prevWarningPreviousModelRef.current = previousModel;
      const result = checkContextSwitch(
        options.tokens,
        options.targetModel,
        previousModel,
        use1M,
        checkOptions,
        { allowSameModel: options.allowSameModel }
      );
      return enhanceWarning(result);
    },
    [checkOptions, enhanceWarning, messages, use1M]
  );

  const queueExplicitSwitch = useCallback(
    (options: { model: string; previousModel: string | null }) => {
      if (options.previousModel === options.model) {
        dispatch({ type: "CLEAR_PENDING" });
        return;
      }

      const pendingSwitch: PendingSwitch = {
        model: options.model,
        previousModel: options.previousModel,
        deferred: tokens === 0,
      };

      dismissedWarningModelRef.current = null;
      dispatch({ type: "USER_REQUESTED_MODEL", pending: pendingSwitch });

      if (pendingSwitch.deferred) {
        dispatch({ type: "CLEAR_WARNING" });
        return;
      }

      const nextWarning = evaluateWarning({
        tokens,
        targetModel: options.model,
        previousModel: options.previousModel,
      });
      dispatch({ type: "WARNING_UPDATED", warning: nextWarning });
    },
    [evaluateWarning, tokens]
  );

  const handleModelChange = useCallback(
    (newModel: string) => {
      // Gateway-preserving equality: coder:<instance>/<model> and the direct
      // <provider>:<model> are distinct selections even when the instance
      // name matches the provider — name-only canonicalization would treat
      // them as equal and return before persisting the switch.
      if (normalizeSelectedModel(newModel).trim() === normalizeSelectedModel(pendingModel).trim()) {
        return;
      }

      // User request: record explicit model switches so warnings only follow user actions.
      setWorkspaceModelWithOrigin(workspaceId, newModel, "user");
    },
    [pendingModel, workspaceId]
  );

  const handleCompact = useCallback(() => {
    if (!api || !warning?.compactionModel) return;

    void executeCompaction({
      api,
      workspaceId,
      model: warning.compactionModel,
      sendMessageOptions: pendingSendOptions,
    });
    dispatch({ type: "CLEAR_WARNING" });
  }, [api, workspaceId, pendingSendOptions, warning]);

  const handleDismiss = useCallback(() => {
    dismissedWarningModelRef.current = warning?.targetModel ?? pendingModel;
    dispatch({ type: "CLEAR_WARNING" });
  }, [warning, pendingModel]);

  // Sync with indirect model changes (e.g., WorkspaceModeAISync updating model on mode/agent change).
  // Effect is appropriate: pendingModel comes from usePersistedState (localStorage).
  // Only explicit user/agent switches should surface warnings; background updates just update refs.
  useEffect(() => {
    if (switchState.currentModel === pendingModel) {
      return;
    }

    dismissedWarningModelRef.current = null;
    const origin = consumeWorkspaceModelChange(workspaceId, pendingModel);
    // Agent/mode switches call setWorkspaceModelWithOrigin, so they flow through this explicit path.
    if (origin === "user" || origin === "agent") {
      queueExplicitSwitch({
        model: pendingModel,
        previousModel: switchState.currentModel,
      });
    }

    dispatch({ type: "MODEL_APPLIED", model: pendingModel });
  }, [pendingModel, queueExplicitSwitch, switchState.currentModel, workspaceId]);

  useEffect(() => {
    const pendingSwitch = switchState.pending;
    if (!pendingSwitch?.deferred) {
      return;
    }

    if (pendingSwitch.model !== pendingModel) {
      dispatch({ type: "CLEAR_PENDING" });
      return;
    }

    if (tokens === 0) {
      return;
    }

    const nextWarning = evaluateWarning({
      tokens,
      targetModel: pendingSwitch.model,
      previousModel: pendingSwitch.previousModel,
    });
    dispatch({ type: "WARNING_EVALUATED", warning: nextWarning });
  }, [pendingModel, tokens, switchState.pending, evaluateWarning]);

  useEffect(() => {
    const prevCheckOptions = prevCheckOptionsRef.current;
    const checkOptionsChanged = prevCheckOptions !== checkOptions;
    prevCheckOptionsRef.current = checkOptions;

    if (!checkOptionsChanged) {
      return;
    }

    if (warning) {
      // User request: keep explicit warnings tied to the model that triggered them.
      // If a background model change happens, skip refresh instead of re-warning.
      if (warning.targetModel !== pendingModel) {
        return;
      }

      // Refresh existing warnings when policy/config arrives so compaction suggestions appear.
      // Only update active warnings to avoid resurrecting dismissed banners.
      // Preserve same-model warnings (like 1M toggle) when refreshing for policy/config updates.
      const nextWarning = evaluateWarning({
        tokens,
        targetModel: pendingModel,
        previousModel: prevWarningPreviousModelRef.current,
        allowSameModel: true,
      });
      if (areWarningsEqual(warning, nextWarning)) {
        return;
      }
      dispatch({ type: "WARNING_UPDATED", warning: nextWarning });
      return;
    }

    if (tokens === 0) {
      return;
    }

    // Re-evaluate the most recent explicit switch whenever provider/policy access changes.
    // This includes non-null -> non-null updates (e.g. custom model override added later)
    // so we don't miss warnings after an earlier "no limit known" evaluation.
    if (lastEvaluatedTargetModelRef.current !== pendingModel) {
      return;
    }

    if (dismissedWarningModelRef.current === pendingModel) {
      return;
    }

    const nextWarning = evaluateWarning({
      tokens,
      targetModel: pendingModel,
      previousModel: prevWarningPreviousModelRef.current,
      allowSameModel: true,
    });
    if (!nextWarning) {
      return;
    }

    dispatch({ type: "WARNING_UPDATED", warning: nextWarning });
  }, [checkOptions, warning, tokens, pendingModel, evaluateWarning]);

  // Sync with 1M toggle changes from ProviderOptionsContext.
  // Effect is appropriate here: we're syncing with an external context (not our own state),
  // and the toggle change happens in Settings which can't directly call our handlers.
  useEffect(() => {
    const wasEnabled = prevUse1MRef.current;
    prevUse1MRef.current = use1M;

    // Recompute warning when toggle changes (either direction)
    // OFF → ON: may clear warning if context now fits
    // ON → OFF: may show warning if context no longer fits
    if (wasEnabled !== use1M) {
      const previousLimit = getEffectiveContextLimit(pendingModel, wasEnabled, providersConfig);
      const nextLimit = getEffectiveContextLimit(pendingModel, use1M, providersConfig);

      // Only surface same-model warnings if the effective limit actually changed.
      if (previousLimit === nextLimit) {
        if (use1M && tokens === 0) {
          // No tokens but toggled ON - clear any stale warning
          dispatch({ type: "CLEAR_WARNING" });
        }
        return;
      }

      if (tokens > 0) {
        const nextWarning = evaluateWarning({
          tokens,
          targetModel: pendingModel,
          previousModel: findPreviousModel(messages),
          allowSameModel: true,
        });
        if (areWarningsEqual(warning, nextWarning)) {
          return;
        }
        dispatch({ type: "WARNING_UPDATED", warning: nextWarning });
      } else if (use1M) {
        // No tokens but toggled ON - clear any stale warning
        dispatch({ type: "CLEAR_WARNING" });
      }
    }
  }, [use1M, pendingModel, tokens, messages, providersConfig, evaluateWarning, warning]);

  return { warning, handleModelChange, handleCompact, handleDismiss };
}

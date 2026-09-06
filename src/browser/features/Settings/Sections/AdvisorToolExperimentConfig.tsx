import React, { useEffect, useRef, useState } from "react";
import { Loader2 } from "lucide-react";

import { ThinkingSelectorControl } from "@/browser/components/ThinkingSelector/ThinkingSelector";
import { Input } from "@/browser/components/Input/Input";
import { ModelSelector } from "@/browser/components/ModelSelector/ModelSelector";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/browser/components/SelectPrimitive/SelectPrimitive";
import { useAPI } from "@/browser/contexts/API";
import { useProvidersConfig } from "@/browser/hooks/useProvidersConfig";
import type { ProvidersConfigMap } from "@/common/orpc/types";
import { useModelsFromSettings } from "@/browser/hooks/useModelsFromSettings";
import { ADVISOR_DEFAULT_MAX_USES_PER_TURN } from "@/common/constants/advisor";
import { normalizeTaskSettings, type TaskSettings } from "@/common/types/tasks";
import {
  coerceThinkingLevel,
  coerceOpenAIReasoningMode,
  type OpenAIReasoningMode,
  THINKING_LEVEL_OFF,
  type ThinkingLevel,
} from "@/common/types/thinking";
import assert from "@/common/utils/assert";
import { getErrorMessage } from "@/common/utils/errors";
import { enforceThinkingPolicy } from "@/common/utils/thinking/policy";

const DEFAULT_LIMITED_MAX_USES = ADVISOR_DEFAULT_MAX_USES_PER_TURN;
const DEFAULT_LIMITED_MAX_OUTPUT_TOKENS = 16000;

assert(
  Number.isInteger(DEFAULT_LIMITED_MAX_USES) && DEFAULT_LIMITED_MAX_USES > 0,
  "Advisor limited mode must seed a positive default"
);
assert(
  Number.isInteger(DEFAULT_LIMITED_MAX_OUTPUT_TOKENS) && DEFAULT_LIMITED_MAX_OUTPUT_TOKENS > 0,
  "Advisor limited output tokens mode must seed a positive default"
);

type AdvisorMode = "limited" | "unlimited";

interface AdvisorSettingsState {
  advisorModelString: string | null;
  advisorThinkingLevel: ThinkingLevel;
  advisorReasoningMode: OpenAIReasoningMode;
  advisorMaxUsesPerTurn: number | null;
  advisorMaxOutputTokens: number | null;
}

interface AdvisorSavePayload extends AdvisorSettingsState {
  taskSettings: TaskSettings;
}

function normalizeAdvisorModelString(value: string | null | undefined): string | null {
  const trimmedValue = value?.trim();
  if (!trimmedValue) {
    return null;
  }

  return trimmedValue;
}

/** Coerce a nullable number to a positive integer or null. */
function normalizePositiveIntOrNull(value: number | null | undefined): number | null {
  if (!Number.isInteger(value) || value == null || value <= 0) {
    return null;
  }

  return value;
}

function parsePositiveInteger(value: string): number | null {
  const trimmedValue = value.trim();
  if (!/^\d+$/.test(trimmedValue)) {
    return null;
  }

  const parsedValue = Number.parseInt(trimmedValue, 10);
  if (!Number.isInteger(parsedValue) || parsedValue <= 0) {
    return null;
  }

  return parsedValue;
}

function normalizeAdvisorDraft(params: {
  advisorModelString: string;
  providersConfig: ProvidersConfigMap | null;
  advisorThinkingLevel: ThinkingLevel;
  advisorReasoningMode: OpenAIReasoningMode;
  maxUsesMode: AdvisorMode;
  limitedDraft: string;
  lastValidLimitedValue: number;
  maxOutputTokensMode: AdvisorMode;
  outputTokensDraft: string;
  lastValidOutputTokensValue: number;
}): AdvisorSettingsState {
  const normalizedModelString = normalizeAdvisorModelString(params.advisorModelString);
  const normalizedThinkingLevel = enforceThinkingPolicy(
    normalizedModelString ?? "",
    params.advisorThinkingLevel,
    undefined,
    params.providersConfig
  );

  let normalizedMaxUsesPerTurn: number | null = null;
  if (params.maxUsesMode === "limited") {
    assert(
      Number.isInteger(params.lastValidLimitedValue) && params.lastValidLimitedValue > 0,
      "Advisor limited mode must keep a positive saved value"
    );
    normalizedMaxUsesPerTurn =
      parsePositiveInteger(params.limitedDraft) ?? params.lastValidLimitedValue;
  }

  let normalizedMaxOutputTokens: number | null = null;
  if (params.maxOutputTokensMode === "limited") {
    assert(
      Number.isInteger(params.lastValidOutputTokensValue) && params.lastValidOutputTokensValue > 0,
      "Advisor limited max output tokens mode must keep a positive saved value"
    );
    normalizedMaxOutputTokens =
      parsePositiveInteger(params.outputTokensDraft) ?? params.lastValidOutputTokensValue;
  }

  return {
    advisorModelString: normalizedModelString,
    advisorThinkingLevel: normalizedThinkingLevel,
    advisorReasoningMode: params.advisorReasoningMode,
    advisorMaxUsesPerTurn: normalizedMaxUsesPerTurn,
    advisorMaxOutputTokens: normalizedMaxOutputTokens,
  };
}

function areAdvisorSettingsEqual(a: AdvisorSettingsState, b: AdvisorSettingsState): boolean {
  return (
    a.advisorModelString === b.advisorModelString &&
    a.advisorThinkingLevel === b.advisorThinkingLevel &&
    a.advisorReasoningMode === b.advisorReasoningMode &&
    a.advisorMaxUsesPerTurn === b.advisorMaxUsesPerTurn &&
    a.advisorMaxOutputTokens === b.advisorMaxOutputTokens
  );
}

export function AdvisorToolExperimentConfig() {
  const { api } = useAPI();
  const { config: providersConfig } = useProvidersConfig();
  const { models, hiddenModelsForSelector } = useModelsFromSettings();

  const [advisorModelString, setAdvisorModelString] = useState("");
  const [advisorThinkingLevel, setAdvisorThinkingLevel] =
    useState<ThinkingLevel>(THINKING_LEVEL_OFF);
  const [advisorReasoningMode, setAdvisorReasoningMode] = useState<OpenAIReasoningMode>("standard");
  const [maxUsesMode, setMaxUsesMode] = useState<AdvisorMode>("limited");
  const [limitedDraft, setLimitedDraft] = useState(String(DEFAULT_LIMITED_MAX_USES));
  const [lastValidLimitedValue, setLastValidLimitedValue] = useState(DEFAULT_LIMITED_MAX_USES);
  const [maxOutputTokensMode, setMaxOutputTokensMode] = useState<AdvisorMode>("unlimited");
  const [outputTokensDraft, setOutputTokensDraft] = useState(
    String(DEFAULT_LIMITED_MAX_OUTPUT_TOKENS)
  );
  const [lastValidOutputTokensValue, setLastValidOutputTokensValue] = useState(
    DEFAULT_LIMITED_MAX_OUTPUT_TOKENS
  );

  const [loaded, setLoaded] = useState(false);
  const [loadFailed, setLoadFailed] = useState(false);
  const [saveError, setSaveError] = useState<string | null>(null);

  const taskSettingsRef = useRef<TaskSettings | null>(null);
  const saveTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const savingRef = useRef(false);
  const pendingSaveRef = useRef<AdvisorSavePayload | null>(null);
  const lastSyncedRef = useRef<AdvisorSettingsState | null>(null);
  const isMountedRef = useRef(true);

  useEffect(() => {
    return () => {
      isMountedRef.current = false;
    };
  }, []);

  useEffect(() => {
    if (!api) {
      return;
    }

    let ignore = false;

    setLoaded(false);
    setLoadFailed(false);
    setSaveError(null);

    void api.config
      .getConfig()
      .then((cfg) => {
        if (ignore) {
          return;
        }

        const normalizedTaskSettings = normalizeTaskSettings(cfg.taskSettings);
        const normalizedModelString = normalizeAdvisorModelString(cfg.advisorModelString);
        const normalizedThinkingLevel =
          coerceThinkingLevel(cfg.advisorThinkingLevel) ?? THINKING_LEVEL_OFF;
        const normalizedReasoningMode =
          coerceOpenAIReasoningMode(cfg.advisorReasoningMode) ?? "standard";
        const normalizedMaxUsesPerTurn = normalizePositiveIntOrNull(cfg.advisorMaxUsesPerTurn);
        const normalizedMaxOutputTokens = normalizePositiveIntOrNull(cfg.advisorMaxOutputTokens);
        // Match the backend starter cap when the setting is unset; only an explicit null is
        // the user's Unlimited opt-in.
        const nextMaxUsesMode: AdvisorMode =
          cfg.advisorMaxUsesPerTurn === null ? "unlimited" : "limited";
        const nextLimitedValue = normalizedMaxUsesPerTurn ?? DEFAULT_LIMITED_MAX_USES;
        const nextMaxUsesPerTurn = nextMaxUsesMode === "unlimited" ? null : nextLimitedValue;
        const nextMaxOutputTokensMode: AdvisorMode =
          cfg.advisorMaxOutputTokens == null ? "unlimited" : "limited";
        const nextOutputTokensValue =
          normalizedMaxOutputTokens ?? DEFAULT_LIMITED_MAX_OUTPUT_TOKENS;
        const nextMaxOutputTokens =
          nextMaxOutputTokensMode === "unlimited" ? null : nextOutputTokensValue;

        taskSettingsRef.current = normalizedTaskSettings;
        setAdvisorModelString(normalizedModelString ?? "");
        setAdvisorThinkingLevel(normalizedThinkingLevel);
        setAdvisorReasoningMode(normalizedReasoningMode);
        setMaxUsesMode(nextMaxUsesMode);
        setLimitedDraft(String(nextLimitedValue));
        setLastValidLimitedValue(nextLimitedValue);
        setMaxOutputTokensMode(nextMaxOutputTokensMode);
        setOutputTokensDraft(String(nextOutputTokensValue));
        setLastValidOutputTokensValue(nextOutputTokensValue);
        lastSyncedRef.current = {
          advisorModelString: normalizedModelString,
          advisorThinkingLevel: normalizedThinkingLevel,
          advisorReasoningMode: normalizedReasoningMode,
          advisorMaxUsesPerTurn: nextMaxUsesPerTurn,
          advisorMaxOutputTokens: nextMaxOutputTokens,
        };
        setLoadFailed(false);
        setLoaded(true);
      })
      .catch((error: unknown) => {
        if (ignore) {
          return;
        }

        taskSettingsRef.current = null;
        setSaveError(getErrorMessage(error));
        setLoadFailed(true);
        setLoaded(true);
      });

    return () => {
      ignore = true;
    };
  }, [api]);

  useEffect(() => {
    if (!api) {
      return;
    }
    if (!loaded) {
      return;
    }
    if (loadFailed) {
      return;
    }

    const taskSettings = taskSettingsRef.current;
    if (!taskSettings) {
      return;
    }

    const normalizedAdvisorSettings = normalizeAdvisorDraft({
      advisorModelString,
      providersConfig,
      advisorThinkingLevel,
      advisorReasoningMode,
      maxUsesMode,
      limitedDraft,
      lastValidLimitedValue,
      maxOutputTokensMode,
      outputTokensDraft,
      lastValidOutputTokensValue,
    });
    const lastSynced = lastSyncedRef.current;

    if (lastSynced && areAdvisorSettingsEqual(lastSynced, normalizedAdvisorSettings)) {
      pendingSaveRef.current = null;
      if (saveTimerRef.current) {
        clearTimeout(saveTimerRef.current);
        saveTimerRef.current = null;
      }
      return;
    }

    pendingSaveRef.current = { taskSettings, ...normalizedAdvisorSettings };
    if (saveTimerRef.current) {
      clearTimeout(saveTimerRef.current);
      saveTimerRef.current = null;
    }

    saveTimerRef.current = setTimeout(() => {
      const flush = () => {
        if (savingRef.current) {
          return;
        }

        const payload = pendingSaveRef.current;
        if (!payload) {
          return;
        }

        pendingSaveRef.current = null;
        savingRef.current = true;

        void api.config
          .saveConfig({
            taskSettings: payload.taskSettings,
            advisorModelString: payload.advisorModelString,
            advisorThinkingLevel: payload.advisorThinkingLevel,
            advisorReasoningMode: payload.advisorReasoningMode,
            advisorMaxUsesPerTurn: payload.advisorMaxUsesPerTurn,
            advisorMaxOutputTokens: payload.advisorMaxOutputTokens,
          })
          .then(() => {
            lastSyncedRef.current = {
              advisorModelString: payload.advisorModelString,
              advisorThinkingLevel: payload.advisorThinkingLevel,
              advisorReasoningMode: payload.advisorReasoningMode,
              advisorMaxUsesPerTurn: payload.advisorMaxUsesPerTurn,
              advisorMaxOutputTokens: payload.advisorMaxOutputTokens,
            };
            if (isMountedRef.current) {
              setSaveError(null);
            }
          })
          .catch((error: unknown) => {
            if (isMountedRef.current) {
              setSaveError(getErrorMessage(error));
            }
          })
          .finally(() => {
            savingRef.current = false;
            flush();
          });
      };

      flush();
    }, 400);

    return () => {
      if (saveTimerRef.current) {
        clearTimeout(saveTimerRef.current);
        saveTimerRef.current = null;
      }
    };
  }, [
    api,
    providersConfig,
    advisorModelString,
    advisorThinkingLevel,
    advisorReasoningMode,
    limitedDraft,
    loadFailed,
    loaded,
    maxUsesMode,
    lastValidLimitedValue,
    maxOutputTokensMode,
    outputTokensDraft,
    lastValidOutputTokensValue,
  ]);

  useEffect(() => {
    if (!api) {
      return;
    }
    if (!loaded) {
      return;
    }
    if (loadFailed) {
      return;
    }

    return () => {
      if (saveTimerRef.current) {
        clearTimeout(saveTimerRef.current);
        saveTimerRef.current = null;
      }

      if (savingRef.current) {
        return;
      }

      const payload = pendingSaveRef.current;
      if (!payload) {
        return;
      }

      // The inline advisor settings disappear immediately when the experiment is toggled off, so
      // flush any debounced edits during unmount instead of dropping the user's last change.
      pendingSaveRef.current = null;
      savingRef.current = true;
      void api.config
        .saveConfig({
          taskSettings: payload.taskSettings,
          advisorModelString: payload.advisorModelString,
          advisorThinkingLevel: payload.advisorThinkingLevel,
          advisorReasoningMode: payload.advisorReasoningMode,
          advisorMaxUsesPerTurn: payload.advisorMaxUsesPerTurn,
          advisorMaxOutputTokens: payload.advisorMaxOutputTokens,
        })
        .catch(() => undefined)
        .finally(() => {
          savingRef.current = false;
        });
    };
  }, [api, loadFailed, loaded]);

  const setAdvisorMaxUsesMode = (value: string) => {
    if (value !== "unlimited" && value !== "limited") {
      return;
    }

    if (value === "limited") {
      const nextLimitedValue = parsePositiveInteger(limitedDraft) ?? lastValidLimitedValue;
      assert(
        Number.isInteger(nextLimitedValue) && nextLimitedValue > 0,
        "Advisor limited mode needs a positive restored value"
      );
      setLastValidLimitedValue(nextLimitedValue);
      setLimitedDraft(String(nextLimitedValue));
    }

    setMaxUsesMode(value);
  };

  const handleLimitedDraftChange = (rawValue: string) => {
    setLimitedDraft(rawValue);
    const parsedValue = parsePositiveInteger(rawValue);
    if (parsedValue == null) {
      return;
    }

    setLastValidLimitedValue(parsedValue);
  };

  const handleLimitedDraftBlur = () => {
    const normalizedValue = parsePositiveInteger(limitedDraft) ?? lastValidLimitedValue;
    assert(
      Number.isInteger(normalizedValue) && normalizedValue > 0,
      "Advisor limited draft must resolve to a positive integer"
    );
    setLimitedDraft(String(normalizedValue));
    setLastValidLimitedValue(normalizedValue);
  };

  const setAdvisorMaxOutputTokensMode = (value: string) => {
    if (value !== "unlimited" && value !== "limited") {
      return;
    }
    if (value === "limited") {
      const nextValue = parsePositiveInteger(outputTokensDraft) ?? lastValidOutputTokensValue;
      assert(
        Number.isInteger(nextValue) && nextValue > 0,
        "Advisor limited max output tokens needs a positive restored value"
      );
      setLastValidOutputTokensValue(nextValue);
      setOutputTokensDraft(String(nextValue));
    }
    setMaxOutputTokensMode(value);
  };

  const handleOutputTokensDraftChange = (rawValue: string) => {
    setOutputTokensDraft(rawValue);
    const parsedValue = parsePositiveInteger(rawValue);
    if (parsedValue == null) {
      return;
    }
    setLastValidOutputTokensValue(parsedValue);
  };

  const handleOutputTokensDraftBlur = () => {
    const normalizedValue = parsePositiveInteger(outputTokensDraft) ?? lastValidOutputTokensValue;
    assert(
      Number.isInteger(normalizedValue) && normalizedValue > 0,
      "Advisor output tokens draft must resolve to a positive integer"
    );
    setOutputTokensDraft(String(normalizedValue));
    setLastValidOutputTokensValue(normalizedValue);
  };

  if (!api) {
    return (
      <div className="bg-background-secondary px-4 py-3">
        <div className="text-muted text-xs">Connect to xum to configure this setting.</div>
      </div>
    );
  }

  if (!loaded) {
    return (
      <div className="bg-background-secondary flex items-center gap-2 px-4 py-3">
        <Loader2 className="text-muted h-4 w-4 animate-spin" />
        <span className="text-muted text-xs">Loading advisor defaults…</span>
      </div>
    );
  }

  if (loadFailed) {
    return (
      <div className="bg-background-secondary px-4 py-3">
        <div className="text-danger-light text-xs">Failed to load advisor settings.</div>
      </div>
    );
  }

  return (
    <div className="bg-background-secondary space-y-3 px-4 py-3">
      <div className="flex flex-col gap-2 sm:flex-row sm:items-center sm:justify-between sm:gap-4">
        <div className="flex-1">
          <div className="text-foreground text-sm">Advisor Model</div>
          <div className="text-muted text-xs">Global default for nested advisor calls.</div>
        </div>
        <div className="flex min-w-0 items-center gap-2 sm:justify-end">
          <ModelSelector
            value={advisorModelString}
            onChange={setAdvisorModelString}
            models={models}
            hiddenModels={hiddenModelsForSelector}
            emptyLabel="Select model"
            variant="box"
            className="bg-modal-bg max-w-full sm:max-w-[22rem]"
          />
        </div>
      </div>

      <div className="flex flex-col gap-2 sm:flex-row sm:items-center sm:justify-between sm:gap-4">
        <div className="flex-1">
          <div className="text-foreground text-sm">Reasoning</div>
          <div className="text-muted text-xs">Applied to advisor requests.</div>
        </div>
        <div className="w-52 shrink-0">
          {/* Reuse the route-aware picker so advisor Pro has the same delivery gates as chat. */}
          <ThinkingSelectorControl
            modelString={advisorModelString || undefined}
            modelCapabilitiesDeferred={!advisorModelString}
            allowProMode={Boolean(advisorModelString)}
            allowFastMode={false}
            applyMinimumThinkingLevel={false}
            thinkingLevel={advisorThinkingLevel}
            onThinkingLevelChange={setAdvisorThinkingLevel}
            reasoningMode={advisorReasoningMode}
            onReasoningModeChange={setAdvisorReasoningMode}
            variant="box"
          />
        </div>
      </div>

      <div className="flex flex-col gap-2 sm:flex-row sm:items-center sm:justify-between sm:gap-4">
        <div className="flex-1">
          <div className="text-foreground text-sm">Max Uses / Turn</div>
          <div className="text-muted text-xs">Per response.</div>
        </div>
        <div className="flex min-w-0 items-center gap-2 sm:justify-end">
          <Select value={maxUsesMode} onValueChange={setAdvisorMaxUsesMode}>
            <SelectTrigger className="border-border-medium bg-modal-bg h-9 w-32">
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              <SelectItem value="unlimited">Unlimited</SelectItem>
              <SelectItem value="limited">Limited</SelectItem>
            </SelectContent>
          </Select>
          {maxUsesMode === "limited" ? (
            <Input
              aria-label="Advisor max uses per turn"
              type="number"
              min={1}
              step={1}
              value={limitedDraft}
              onChange={(event: React.ChangeEvent<HTMLInputElement>) =>
                handleLimitedDraftChange(event.target.value)
              }
              onBlur={handleLimitedDraftBlur}
              className="border-border-medium bg-modal-bg h-9 w-28"
            />
          ) : null}
        </div>
      </div>

      <div className="flex flex-col gap-2 sm:flex-row sm:items-center sm:justify-between sm:gap-4">
        <div className="flex-1">
          <div className="text-foreground text-sm">Max Output Tokens</div>
          <div className="text-muted text-xs">Per advisor response.</div>
        </div>
        <div className="flex min-w-0 items-center gap-2 sm:justify-end">
          <Select value={maxOutputTokensMode} onValueChange={setAdvisorMaxOutputTokensMode}>
            <SelectTrigger className="border-border-medium bg-modal-bg h-9 w-32">
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              <SelectItem value="unlimited">Unlimited</SelectItem>
              <SelectItem value="limited">Limited</SelectItem>
            </SelectContent>
          </Select>
          {maxOutputTokensMode === "limited" ? (
            <Input
              aria-label="Advisor max output tokens"
              type="number"
              min={1}
              step={1}
              value={outputTokensDraft}
              onChange={(event: React.ChangeEvent<HTMLInputElement>) =>
                handleOutputTokensDraftChange(event.target.value)
              }
              onBlur={handleOutputTokensDraftBlur}
              className="border-border-medium bg-modal-bg h-9 w-28"
            />
          ) : null}
        </div>
      </div>

      {saveError ? <div className="text-danger-light text-xs">{saveError}</div> : null}
    </div>
  );
}

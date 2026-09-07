import React, { useEffect, useMemo, useRef, useState } from "react";
import { useAPI } from "@/browser/contexts/API";
import { useWorkspaceContext } from "@/browser/contexts/WorkspaceContext";
import { Tooltip, TooltipContent, TooltipTrigger } from "@/browser/components/Tooltip/Tooltip";
import { Input } from "@/browser/components/Input/Input";
import { Switch } from "@/browser/components/Switch/Switch";
import { Button } from "@/browser/components/Button/Button";
import { ModelSelector } from "@/browser/components/ModelSelector/ModelSelector";
import { ThinkingSelectorControl } from "@/browser/components/ThinkingSelector/ThinkingSelector";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/browser/components/SelectPrimitive/SelectPrimitive";
import { copyToClipboard } from "@/browser/utils/clipboard";
import { useExperimentValue } from "@/browser/hooks/useExperiments";
import { getDefaultModel, useModelsFromSettings } from "@/browser/hooks/useModelsFromSettings";
import { updatePersistedState, usePersistedState } from "@/browser/hooks/usePersistedState";
import { resolveAdvisorEnabledForAgent } from "@/common/constants/advisor";
import { EXPERIMENT_IDS } from "@/common/constants/experiments";
import {
  AGENT_AI_DEFAULTS_KEY,
  GLOBAL_SCOPE_ID,
  getAgentIdKey,
  getModelKey,
} from "@/common/constants/storage";
import { CUSTOM_EVENTS, createCustomEvent } from "@/common/constants/events";
import type { AgentDefinitionDescriptor } from "@/common/types/agentDefinition";
import {
  normalizeAgentAiDefaults,
  type AgentAiDefaults,
  type AgentAiDefaultsEntry,
  type AgentAiSubagentProfile,
} from "@/common/types/agentAiDefaults";
import {
  DEFAULT_TASK_SETTINGS,
  TASK_SETTINGS_LIMITS,
  normalizeTaskSettings,
  type TaskSettings,
} from "@/common/types/tasks";
import {
  coerceThinkingLevel,
  THINKING_LEVEL_OFF,
  type OpenAIReasoningMode,
  type ThinkingLevel,
} from "@/common/types/thinking";
import { normalizeModelInput } from "@/common/utils/ai/normalizeModelInput";
import { getErrorMessage } from "@/common/utils/errors";
import { enforceThinkingPolicy } from "@/common/utils/thinking/policy";
import { normalizeAgentId } from "@/common/utils/agentIds";
import { WORKSPACE_DEFAULTS } from "@/constants/workspaceDefaults";
import { FALLBACK_AGENTS, deriveTasksSectionAgentGroups } from "./TasksSection.agents";

const INHERIT = "__inherit__";

// Agents whose requests run outside the send path (raw streamText: Dream in
// memoryConsolidation, Name Workspace in workspaceTitleGenerator) and never
// apply reasoningMode. Never offer a Pro toggle that cannot affect requests.
// Compact stays eligible: compaction goes through the send path, which
// threads reasoningMode.
const HEADLESS_REASONING_AGENT_IDS = new Set(["dream", "name_workspace", "intuition"]);

function getAgentDefinitionPath(agent: AgentDefinitionDescriptor): string | null {
  switch (agent.scope) {
    case "project":
      return `.xum/agents/${agent.id}.md`;
    case "global":
      return `~/.xum/agents/${agent.id}.md`;
    default:
      return null;
  }
}

function updateAgentDefaultEntry(
  previous: AgentAiDefaults,
  agentId: string,
  update: (entry: AgentAiDefaultsEntry) => void
): AgentAiDefaults {
  const normalizedId = normalizeAgentId(agentId, WORKSPACE_DEFAULTS.agentId);

  const next = { ...previous };
  const existing = next[normalizedId] ?? {};
  const updated: AgentAiDefaultsEntry = { ...existing };
  update(updated);

  if (updated.modelString && updated.thinkingLevel) {
    updated.thinkingLevel = enforceThinkingPolicy(updated.modelString, updated.thinkingLevel);
  }

  if (
    !updated.modelString &&
    !updated.thinkingLevel &&
    !updated.reasoningMode &&
    updated.enabled === undefined &&
    updated.advisorEnabled === undefined &&
    updated.subagent === undefined
  ) {
    delete next[normalizedId];
  } else {
    next[normalizedId] = updated;
  }

  return next;
}

/** Updates an agent's sparse delegated-run override profile (entry.subagent). */
function updateAgentSubagentProfile(
  previous: AgentAiDefaults,
  agentId: string,
  update: (profile: AgentAiSubagentProfile) => void
): AgentAiDefaults {
  return updateAgentDefaultEntry(previous, agentId, (entry) => {
    const profile: AgentAiSubagentProfile = { ...entry.subagent };
    update(profile);

    if (profile.modelString && profile.thinkingLevel) {
      profile.thinkingLevel = enforceThinkingPolicy(profile.modelString, profile.thinkingLevel);
    }

    if (
      profile.modelString === undefined &&
      profile.thinkingLevel === undefined &&
      profile.reasoningMode === undefined
    ) {
      delete entry.subagent;
    } else {
      entry.subagent = profile;
    }
  });
}

interface TasksSectionSavePayload {
  taskSettings: TaskSettings;
  agentAiDefaults: AgentAiDefaults;
}

function renderPolicySummary(agent: AgentDefinitionDescriptor): React.ReactNode {
  const isCompact = agent.id === "compact";

  const baseDescription = (() => {
    if (isCompact) {
      return {
        title: "Base: compact",
        note: "Internal no-tools mode.",
      };
    }

    if (agent.base) {
      return {
        title: `Base: ${agent.base}`,
        note: "Inherits prompt/tools from base.",
      };
    }

    return {
      title: "Base: (none)",
      note: "No base agent configured.",
    };
  })();

  const pieces: React.ReactNode[] = [
    <Tooltip key="base-policy">
      <TooltipTrigger asChild>
        <span className="cursor-help underline decoration-dotted underline-offset-2">
          {baseDescription.title.toLowerCase()}
        </span>
      </TooltipTrigger>
      <TooltipContent align="start" className="max-w-80 whitespace-normal">
        <div className="font-medium">{baseDescription.title}</div>
        <div className="text-muted mt-2 text-xs">{baseDescription.note}</div>
      </TooltipContent>
    </Tooltip>,
  ];

  const toolAdd = agent.tools?.add ?? [];
  const toolRemove = agent.tools?.remove ?? [];
  const toolRuleCount = toolAdd.length + toolRemove.length;

  if (toolRuleCount > 0 || agent.base) {
    pieces.push(
      <Tooltip key="tools">
        <TooltipTrigger asChild>
          <span className="cursor-help underline decoration-dotted underline-offset-2">
            {toolRuleCount > 0 ? `tools: ${toolRuleCount}` : "tools: inherited"}
          </span>
        </TooltipTrigger>
        <TooltipContent align="start" className="max-w-80 whitespace-normal">
          <div className="font-medium">Tools</div>
          {toolRuleCount > 0 ? (
            <ul className="mt-1 space-y-0.5">
              {toolAdd.map((pattern) => (
                <li key={`add:${pattern}`}>
                  <span className="text-green-500">+</span> <code>{pattern}</code>
                </li>
              ))}
              {toolRemove.map((pattern) => (
                <li key={`remove:${pattern}`}>
                  <span className="text-red-500">−</span> <code>{pattern}</code>
                </li>
              ))}
            </ul>
          ) : (
            <div className="text-muted mt-1 text-xs">Inherited from base.</div>
          )}
        </TooltipContent>
      </Tooltip>
    );
  }

  return (
    <>
      {pieces.map((piece, idx) => (
        <React.Fragment key={idx}>
          {idx > 0 ? " • " : null}
          {piece}
        </React.Fragment>
      ))}
    </>
  );
}

function getAdvisorSwitchState(
  agentId: string,
  advisorEnabledOverride: boolean | undefined
): { checked: boolean; title: string } {
  const checked = resolveAdvisorEnabledForAgent(agentId, advisorEnabledOverride);
  const title =
    advisorEnabledOverride === undefined
      ? checked
        ? "Advisor enabled by default."
        : "Advisor disabled by default."
      : advisorEnabledOverride
        ? "Advisor enabled (local override)."
        : "Advisor disabled (local override).";

  return { checked, title };
}

function areTaskSettingsEqual(a: TaskSettings, b: TaskSettings): boolean {
  return (
    a.maxParallelAgentTasks === b.maxParallelAgentTasks &&
    a.maxTaskNestingDepth === b.maxTaskNestingDepth &&
    a.proposePlanImplementReplacesChatHistory === b.proposePlanImplementReplacesChatHistory
  );
}

function areSubagentProfilesEqual(
  a: AgentAiSubagentProfile | undefined,
  b: AgentAiSubagentProfile | undefined
): boolean {
  return (
    (a?.modelString ?? undefined) === (b?.modelString ?? undefined) &&
    (a?.thinkingLevel ?? undefined) === (b?.thinkingLevel ?? undefined) &&
    (a?.reasoningMode ?? undefined) === (b?.reasoningMode ?? undefined)
  );
}

function areAgentAiDefaultsEqual(a: AgentAiDefaults, b: AgentAiDefaults): boolean {
  const aKeys = Object.keys(a);
  const bKeys = Object.keys(b);
  if (aKeys.length !== bKeys.length) {
    return false;
  }

  aKeys.sort();
  bKeys.sort();

  for (let i = 0; i < aKeys.length; i += 1) {
    const key = aKeys[i];
    if (key !== bKeys[i]) {
      return false;
    }

    const aEntry = a[key];
    const bEntry = b[key];
    if ((aEntry?.modelString ?? undefined) !== (bEntry?.modelString ?? undefined)) {
      return false;
    }
    if ((aEntry?.thinkingLevel ?? undefined) !== (bEntry?.thinkingLevel ?? undefined)) {
      return false;
    }
    if ((aEntry?.reasoningMode ?? undefined) !== (bEntry?.reasoningMode ?? undefined)) {
      return false;
    }
    if ((aEntry?.enabled ?? undefined) !== (bEntry?.enabled ?? undefined)) {
      return false;
    }
    if ((aEntry?.advisorEnabled ?? undefined) !== (bEntry?.advisorEnabled ?? undefined)) {
      return false;
    }
    if (!areSubagentProfilesEqual(aEntry?.subagent, bEntry?.subagent)) {
      return false;
    }
  }

  return true;
}
function coerceAgentId(value: unknown): string {
  return normalizeAgentId(value, WORKSPACE_DEFAULTS.agentId);
}

interface AiDefaultsControlsProps {
  modelValue: string;
  thinkingValue: string;
  reasoningModeValue: OpenAIReasoningMode;
  reasoningModeInherited?: boolean;
  modelCapabilitiesDeferred?: boolean;
  applyMinimumThinkingLevel?: boolean;
  /** Forwarded to the picker; false hides the Pro toggle (e.g. Dream, whose requests never apply reasoningMode). */
  allowProMode?: boolean;
  effectiveModel: string | undefined;
  models: string[];
  hiddenModelsForSelector: string[];
  inheritLabel?: string;
  showThinkingResetButton?: boolean;
  onModelChange: (value: string) => void;
  onThinkingChange: (value: string) => void;
  onReasoningModeChange: (mode: OpenAIReasoningMode) => void;
}

function AiDefaultsControls(props: AiDefaultsControlsProps) {
  const inheritLabel = props.inheritLabel ?? "Inherit";

  return (
    <div className="mt-3 grid grid-cols-1 gap-3 md:grid-cols-2">
      <div className="space-y-1">
        <div className="text-muted text-xs">Model</div>
        <div className="flex items-center gap-2">
          {/* Match the Reasoning dropdown styling for inherit defaults. */}
          <ModelSelector
            value={props.modelValue === INHERIT ? "" : props.modelValue}
            emptyLabel={inheritLabel}
            onChange={(value) => props.onModelChange(value.trim().length > 0 ? value : INHERIT)}
            models={props.models}
            hiddenModels={props.hiddenModelsForSelector}
            variant="box"
            className="bg-modal-bg"
          />
          {props.modelValue !== INHERIT ? (
            <Button
              type="button"
              variant="ghost"
              size="sm"
              className="h-9 px-2"
              onClick={() => props.onModelChange(INHERIT)}
            >
              Reset
            </Button>
          ) : null}
        </div>
      </div>

      <div className="space-y-1">
        <div className="text-muted text-xs">Reasoning</div>
        <div className="flex items-center gap-2">
          {/* Shared composer picker so settings inherit the same features
            (route-aware Pro mode, provider Fast mode) as the chat input. */}
          <ThinkingSelectorControl
            modelString={props.effectiveModel}
            modelCapabilitiesDeferred={props.modelCapabilitiesDeferred}
            applyMinimumThinkingLevel={props.applyMinimumThinkingLevel}
            thinkingLevel={coerceThinkingLevel(props.thinkingValue) ?? THINKING_LEVEL_OFF}
            onThinkingLevelChange={(level) => props.onThinkingChange(level)}
            reasoningMode={props.reasoningModeValue}
            reasoningModeInherited={props.reasoningModeInherited}
            onReasoningModeChange={props.onReasoningModeChange}
            allowProMode={props.allowProMode}
            variant="box"
            inheritOption={{
              label: inheritLabel,
              selected: props.thinkingValue === INHERIT,
              onSelect: () => props.onThinkingChange(INHERIT),
            }}
          />
          {props.showThinkingResetButton === true && props.thinkingValue !== INHERIT ? (
            <Button
              type="button"
              variant="ghost"
              size="sm"
              className="h-9 px-2"
              onClick={() => props.onThinkingChange(INHERIT)}
            >
              Reset
            </Button>
          ) : null}
        </div>
      </div>
    </div>
  );
}

export function TasksSection() {
  const { api } = useAPI();
  const { selectedWorkspace } = useWorkspaceContext();

  const selectedWorkspaceRef = useRef(selectedWorkspace);
  useEffect(() => {
    selectedWorkspaceRef.current = selectedWorkspace;
  }, [selectedWorkspace]);

  const [taskSettings, setTaskSettings] = useState<TaskSettings>(DEFAULT_TASK_SETTINGS);
  const [agentAiDefaults, setAgentAiDefaults] = useState<AgentAiDefaults>({});

  const [agents, setAgents] = useState<AgentDefinitionDescriptor[]>([]);
  const [enabledAgentIds, setEnabledAgentIds] = useState<string[]>([]);
  const [agentsLoaded, setAgentsLoaded] = useState(false);
  const [agentsLoadFailed, setAgentsLoadFailed] = useState(false);

  const [loaded, setLoaded] = useState(false);
  const [loadFailed, setLoadFailed] = useState(false);
  const [saveError, setSaveError] = useState<string | null>(null);

  const saveTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const savingRef = useRef(false);
  const pendingSaveRef = useRef<TasksSectionSavePayload | null>(null);

  const { models, hiddenModelsForSelector } = useModelsFromSettings();
  const [globalDefaultAgentIdRaw, setGlobalDefaultAgentIdRaw] = usePersistedState<string>(
    getAgentIdKey(GLOBAL_SCOPE_ID),
    WORKSPACE_DEFAULTS.agentId,
    {
      listener: true,
    }
  );
  const newWorkspaceDefaultAgentId = coerceAgentId(globalDefaultAgentIdRaw);
  const portableDesktopEnabled = useExperimentValue(EXPERIMENT_IDS.PORTABLE_DESKTOP);
  const advisorToolEnabled = useExperimentValue(EXPERIMENT_IDS.ADVISOR_TOOL);
  // Dream only runs when both flags are on (see memoryConsolidationService);
  // mirror that gate for its Settings card.
  const memoryEnabled = useExperimentValue(EXPERIMENT_IDS.MEMORY);
  const memoryConsolidationFlag = useExperimentValue(EXPERIMENT_IDS.MEMORY_CONSOLIDATION);
  const memoryConsolidationEnabled = memoryEnabled && memoryConsolidationFlag;
  const memoryIntuitionFlag = useExperimentValue(EXPERIMENT_IDS.MEMORY_INTUITION);
  const memoryIntuitionEnabled = memoryEnabled && memoryIntuitionFlag;

  // Resolve the workspace's active model so that when a sub-agent's model is
  // "Inherit", we show thinking levels for the workspace model (falling back to
  // the global default). This mirrors the workspace model resolution chain used when sending messages.
  const selectedWorkspaceId = selectedWorkspace?.workspaceId ?? null;
  const defaultModel = getDefaultModel();
  const workspaceModelStorageKey = selectedWorkspaceId
    ? getModelKey(selectedWorkspaceId)
    : "__tasks_workspace_model_fallback__";
  const [workspaceModelRaw] = usePersistedState<unknown>(workspaceModelStorageKey, defaultModel, {
    listener: true,
  });
  const inheritedEffectiveModel =
    (typeof workspaceModelRaw === "string" ? workspaceModelRaw.trim() : "") || defaultModel;

  const lastSyncedTaskSettingsRef = useRef<TaskSettings | null>(null);
  const lastSyncedAgentAiDefaultsRef = useRef<AgentAiDefaults | null>(null);

  useEffect(() => {
    if (!api) return;

    setLoaded(false);
    setLoadFailed(false);
    setSaveError(null);

    void api.config
      .getConfig()
      .then((cfg) => {
        const normalizedTaskSettings = normalizeTaskSettings(cfg.taskSettings);
        setTaskSettings(normalizedTaskSettings);
        const normalizedAgentDefaults = normalizeAgentAiDefaults(cfg.agentAiDefaults);
        setAgentAiDefaults(normalizedAgentDefaults);
        updatePersistedState(AGENT_AI_DEFAULTS_KEY, normalizedAgentDefaults);

        setLoadFailed(false);
        lastSyncedTaskSettingsRef.current = normalizedTaskSettings;
        lastSyncedAgentAiDefaultsRef.current = normalizedAgentDefaults;

        setLoaded(true);
      })
      .catch((error: unknown) => {
        setSaveError(getErrorMessage(error));
        setLoadFailed(true);
        setLoaded(true);
      });
  }, [api]);

  useEffect(() => {
    if (!api) return;

    const projectPath = selectedWorkspace?.projectPath;
    const workspaceId = selectedWorkspace?.workspaceId;
    if (!projectPath) {
      setAgents([]);
      setEnabledAgentIds(FALLBACK_AGENTS.map((agent) => agent.id));
      setAgentsLoaded(true);
      setAgentsLoadFailed(false);
      return;
    }

    let cancelled = false;
    setAgentsLoaded(false);
    setAgentsLoadFailed(false);

    void Promise.all([
      api.agents.list({ projectPath, workspaceId }),
      api.agents.list({ projectPath, workspaceId, includeDisabled: true }),
    ])
      .then(([enabled, all]) => {
        if (cancelled) return;
        setAgents(all);
        setEnabledAgentIds(enabled.map((agent) => agent.id));
        setAgentsLoadFailed(false);
        setAgentsLoaded(true);
      })
      .catch(() => {
        if (cancelled) return;
        setAgents([]);
        setEnabledAgentIds(FALLBACK_AGENTS.map((agent) => agent.id));
        setAgentsLoadFailed(true);
        setAgentsLoaded(true);
      });

    return () => {
      cancelled = true;
    };
  }, [api, selectedWorkspace?.projectPath, selectedWorkspace?.workspaceId]);

  useEffect(() => {
    if (!api) return;
    if (!loaded) return;
    if (loadFailed) return;

    pendingSaveRef.current = {
      taskSettings,
      agentAiDefaults,
    };
    const lastTaskSettings = lastSyncedTaskSettingsRef.current;
    const lastAgentDefaults = lastSyncedAgentAiDefaultsRef.current;

    if (
      lastTaskSettings &&
      lastAgentDefaults &&
      areTaskSettingsEqual(lastTaskSettings, taskSettings) &&
      areAgentAiDefaultsEqual(lastAgentDefaults, agentAiDefaults)
    ) {
      pendingSaveRef.current = null;
      if (saveTimerRef.current) {
        clearTimeout(saveTimerRef.current);
        saveTimerRef.current = null;
      }
      return;
    }

    // Keep agent defaults cache up-to-date for any syncers/non-react readers.
    updatePersistedState(AGENT_AI_DEFAULTS_KEY, agentAiDefaults);

    if (saveTimerRef.current) {
      clearTimeout(saveTimerRef.current);
      saveTimerRef.current = null;
    }

    saveTimerRef.current = setTimeout(() => {
      const flush = () => {
        if (savingRef.current) return;
        if (!api) return;

        const payload = pendingSaveRef.current;
        if (!payload) return;

        pendingSaveRef.current = null;
        savingRef.current = true;
        void api.config
          .saveConfig(payload)
          .then(() => {
            const previousAgentDefaults = lastSyncedAgentAiDefaultsRef.current;
            const agentDefaultsChanged =
              !previousAgentDefaults ||
              !areAgentAiDefaultsEqual(previousAgentDefaults, payload.agentAiDefaults);

            lastSyncedTaskSettingsRef.current = payload.taskSettings;
            lastSyncedAgentAiDefaultsRef.current = payload.agentAiDefaults;
            setSaveError(null);

            if (agentDefaultsChanged) {
              window.dispatchEvent(createCustomEvent(CUSTOM_EVENTS.AGENTS_REFRESH_REQUESTED));

              const projectPath = selectedWorkspaceRef.current?.projectPath;
              const workspaceId = selectedWorkspaceRef.current?.workspaceId;
              if (!projectPath) {
                return;
              }

              // Refresh in the background so enablement inheritance stays accurate after saving
              // defaults, but keep the existing list rendered to avoid a "Loading agents…" flash
              // while the user tweaks values.
              setAgentsLoadFailed(false);
              void Promise.all([
                api.agents.list({ projectPath, workspaceId }),
                api.agents.list({ projectPath, workspaceId, includeDisabled: true }),
              ])
                .then(([enabled, all]) => {
                  setAgents(all);
                  setEnabledAgentIds(enabled.map((agent) => agent.id));
                  setAgentsLoadFailed(false);
                  setAgentsLoaded(true);
                })
                .catch(() => {
                  setAgents([]);
                  setEnabledAgentIds(FALLBACK_AGENTS.map((agent) => agent.id));
                  setAgentsLoadFailed(true);
                  setAgentsLoaded(true);
                });
            }
          })
          .catch((error: unknown) => {
            setSaveError(getErrorMessage(error));
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
  }, [api, agentAiDefaults, loaded, loadFailed, taskSettings]);

  // Flush any pending debounced save on unmount so changes aren't lost.
  useEffect(() => {
    if (!api) return;
    if (!loaded) return;
    if (loadFailed) return;

    return () => {
      if (saveTimerRef.current) {
        clearTimeout(saveTimerRef.current);
        saveTimerRef.current = null;
      }

      if (savingRef.current) return;
      const payload = pendingSaveRef.current;
      if (!payload) return;

      pendingSaveRef.current = null;
      savingRef.current = true;
      void api.config
        .saveConfig(payload)
        .catch(() => undefined)
        .finally(() => {
          savingRef.current = false;
        });
    };
  }, [api, loaded, loadFailed]);

  const setMaxParallelAgentTasks = (rawValue: string) => {
    const parsed = Number(rawValue);
    setTaskSettings((prev) => normalizeTaskSettings({ ...prev, maxParallelAgentTasks: parsed }));
  };

  const setMaxTaskNestingDepth = (rawValue: string) => {
    const parsed = Number(rawValue);
    setTaskSettings((prev) => normalizeTaskSettings({ ...prev, maxTaskNestingDepth: parsed }));
  };

  const setProposePlanImplementReplacesChatHistory = (value: boolean) => {
    setTaskSettings((prev) =>
      normalizeTaskSettings({ ...prev, proposePlanImplementReplacesChatHistory: value })
    );
  };

  const setNewWorkspaceDefaultAgentId = (agentId: string) => {
    setGlobalDefaultAgentIdRaw(coerceAgentId(agentId));
  };

  const setAgentModel = (agentId: string, value: string) => {
    setAgentAiDefaults((prev) =>
      updateAgentDefaultEntry(prev, agentId, (updated) => {
        if (value === INHERIT || value.trim().length === 0) {
          delete updated.modelString;
        } else {
          updated.modelString = value;
        }
      })
    );
  };

  const setAgentThinking = (agentId: string, value: string) => {
    setAgentAiDefaults((prev) =>
      updateAgentDefaultEntry(prev, agentId, (updated) => {
        if (value === INHERIT) {
          // The Inherit row resets the whole reasoning config: a retained
          // reasoning override would be invisible (explicit "standard" renders
          // identically to absent) with no other way to remove it.
          delete updated.thinkingLevel;
          delete updated.reasoningMode;
          return;
        }

        updated.thinkingLevel = value as ThinkingLevel;
      })
    );
  };

  // Mirrors resolveAgentAiSettings' field-wise base-chain walk (ACP
  // resolution): agents without their own default inherit each field from the
  // closest ancestor that sets it, so the card must display and gate against
  // the same inherited model/mode the backend resolves.
  const resolveBaseChainDefaults = (
    agentId: string
  ): { modelString?: string; reasoningMode?: OpenAIReasoningMode } => {
    const agentsById = new Map(listedAgents.map((agent) => [agent.id, agent]));
    const visited = new Set<string>([agentId]);
    let cursor = agentId;
    let modelString: string | undefined;
    let reasoningMode: OpenAIReasoningMode | undefined;
    while (modelString === undefined || reasoningMode === undefined) {
      const base = agentsById.get(cursor)?.base ?? (cursor === "plan" ? "plan" : "exec");
      if (base === cursor || visited.has(base)) {
        break;
      }
      const inherited = agentAiDefaults[base];
      modelString ??= inherited?.modelString;
      reasoningMode ??= inherited?.reasoningMode;
      visited.add(base);
      cursor = base;
    }
    return { modelString, reasoningMode };
  };

  const baseChainInheritsPro = (agentId: string): boolean =>
    resolveBaseChainDefaults(agentId).reasoningMode === "pro";

  // Definitions may pin ai.model (possibly an alias like "sonnet"); ACP/task
  // resolution slots it below Settings overrides and above the ambient
  // fallback (resolveAgentAiSettings), so display gating must match.
  const resolveDefinitionModel = (agent: AgentDefinitionDescriptor): string | undefined =>
    normalizeModelInput(agent.aiDefaults?.model).model ?? undefined;

  const setAgentReasoningMode = (agentId: string, mode: OpenAIReasoningMode) => {
    // "standard" is the wire default; keep entries sparse by only persisting
    // "pro", unless a base agent supplies pro, where deleting the override
    // would silently fall back to pro (see baseChainInheritsPro).
    const inheritsPro = baseChainInheritsPro(agentId);
    setAgentAiDefaults((prev) =>
      updateAgentDefaultEntry(prev, agentId, (updated) => {
        if (mode === "pro") {
          updated.reasoningMode = "pro";
        } else if (inheritsPro) {
          updated.reasoningMode = "standard";
        } else {
          delete updated.reasoningMode;
        }
      })
    );
  };

  const setSubagentModel = (agentId: string, value: string) => {
    setAgentAiDefaults((prev) =>
      updateAgentSubagentProfile(prev, agentId, (profile) => {
        if (value === INHERIT || value.trim().length === 0) {
          delete profile.modelString;
        } else {
          profile.modelString = value;
        }
      })
    );
  };

  const setSubagentThinking = (agentId: string, value: string) => {
    setAgentAiDefaults((prev) =>
      updateAgentSubagentProfile(prev, agentId, (profile) => {
        if (value === INHERIT) {
          // Clear the reasoning override too (same rationale as setAgentThinking).
          delete profile.thinkingLevel;
          delete profile.reasoningMode;
          return;
        }

        profile.thinkingLevel = value as ThinkingLevel;
      })
    );
  };

  const setSubagentReasoningMode = (agentId: string, mode: OpenAIReasoningMode) => {
    // The calling chat is unknown here: Standard must remain explicit even if
    // global Exec is Standard, or a Pro calling chat would override the choice.
    setAgentAiDefaults((prev) =>
      updateAgentSubagentProfile(prev, agentId, (profile) => {
        profile.reasoningMode = mode;
      })
    );
  };

  const setAgentEnabled = (agentId: string, value: boolean) => {
    setAgentAiDefaults((prev) =>
      updateAgentDefaultEntry(prev, agentId, (updated) => {
        updated.enabled = value;
      })
    );
  };

  const resetAgentEnabled = (agentId: string) => {
    setAgentAiDefaults((prev) =>
      updateAgentDefaultEntry(prev, agentId, (updated) => {
        delete updated.enabled;
      })
    );
  };

  const setAgentAdvisorEnabled = (agentId: string, value: boolean) => {
    setAgentAiDefaults((prev) =>
      updateAgentDefaultEntry(prev, agentId, (updated) => {
        updated.advisorEnabled = value;
      })
    );
  };

  const resetAgentAdvisorEnabled = (agentId: string) => {
    setAgentAiDefaults((prev) =>
      updateAgentDefaultEntry(prev, agentId, (updated) => {
        delete updated.advisorEnabled;
      })
    );
  };

  const listedAgents = agents.length > 0 ? agents : FALLBACK_AGENTS;
  const enabledAgentIdSet = new Set(enabledAgentIds);

  const { uiAgents, subagents, internalAgents, unknownAgentIds } = useMemo(
    () =>
      deriveTasksSectionAgentGroups({
        listedAgents,
        agentAiDefaults,
        portableDesktopEnabled,
        memoryConsolidationEnabled,
        memoryIntuitionEnabled,
      }),
    [
      agentAiDefaults,
      listedAgents,
      portableDesktopEnabled,
      memoryConsolidationEnabled,
      memoryIntuitionEnabled,
    ]
  );
  const execSubagentAgent = listedAgents.find(
    (agent) => agent.id === "exec" && agent.subagentRunnable && agent.uiSelectable
  );

  const newWorkspaceDefaultAgentOptions = useMemo(() => {
    const options = uiAgents.map((agent) => ({
      id: agent.id,
      label: agent.name,
    }));

    if (!options.some((option) => option.id === newWorkspaceDefaultAgentId)) {
      options.unshift({
        id: newWorkspaceDefaultAgentId,
        label: `${newWorkspaceDefaultAgentId} (unavailable)`,
      });
    }

    return options;
  }, [newWorkspaceDefaultAgentId, uiAgents]);

  const renderAgentDefaults = (agent: AgentDefinitionDescriptor) => {
    const entry = agentAiDefaults[agent.id];
    const modelValue = entry?.modelString ?? INHERIT;
    const thinkingValue = entry?.thinkingLevel ?? INHERIT;
    const enabledOverride = entry?.enabled;
    const advisorEnabledOverride = entry?.advisorEnabled;
    const advisorSwitchState = getAdvisorSwitchState(agent.id, advisorEnabledOverride);

    const enablementLocked =
      agent.id === "exec" || agent.id === "plan" || agent.id === "compact" || agent.id === "mux";

    const enabledValue = enablementLocked
      ? true
      : typeof enabledOverride === "boolean"
        ? enabledOverride
        : enabledAgentIdSet.has(agent.id);

    const enablementTitle = enablementLocked
      ? "Core agent. Can't be disabled."
      : enabledOverride === undefined
        ? enabledValue
          ? "Enabled by agent definition."
          : "Disabled by agent definition."
        : enabledOverride
          ? "Enabled (local override)."
          : "Disabled (local override).";

    const enablementHint =
      !enablementLocked && enabledOverride === undefined && !enabledValue
        ? "Disabled by default"
        : null;
    // When model is "Inherit", resolve the effective model so the dropdown
    // shows the correct thinking levels (e.g. "max" for Opus 4.6, not "xhigh")
    // and Pro gating matches ACP resolution: the agent's own definition model
    // precedes ancestor configuration (resolveAgentAiSettings tier order), and
    // a base-chain model wins over the ambient default (otherwise an agent
    // inheriting GPT-5.6+pro from its base would hide the Pro toggle whenever
    // the ambient model isn't pro-capable).
    // Intuition resolves without ancestors, falling back to the parent turn's model.
    const inheritedDefaults = agent.id === "intuition" ? {} : resolveBaseChainDefaults(agent.id);
    const effectiveModel =
      modelValue !== INHERIT
        ? modelValue
        : (resolveDefinitionModel(agent) ??
          inheritedDefaults.modelString ??
          inheritedEffectiveModel);

    const agentDefinitionPath = getAgentDefinitionPath(agent);
    const scopeNode = agentDefinitionPath ? (
      <Tooltip>
        <TooltipTrigger asChild>
          <button
            type="button"
            className="hover:text-foreground cursor-copy bg-transparent p-0 underline decoration-dotted underline-offset-2"
            onClick={(e) => {
              e.stopPropagation();
              void copyToClipboard(agentDefinitionPath);
            }}
          >
            {agent.scope}
          </button>
        </TooltipTrigger>
        <TooltipContent align="start" className="max-w-80 whitespace-normal">
          <div className="font-medium">Agent file</div>
          <div className="mt-1">
            <code>{agentDefinitionPath}</code>
          </div>
          <div className="text-muted mt-2 text-xs">Click to copy</div>
        </TooltipContent>
      </Tooltip>
    ) : (
      <span>{agent.scope}</span>
    );

    return (
      <div
        key={agent.id}
        className="border-border-medium bg-background-secondary rounded-md border p-3"
      >
        <div className="flex items-start justify-between gap-3">
          <div className="min-w-0 flex-1">
            <div className="text-foreground text-sm font-medium">{agent.name}</div>
            <div className="text-muted text-xs">
              {agent.id} • {scopeNode} • {renderPolicySummary(agent)}
              {agent.uiSelectable && agent.subagentRunnable ? (
                <>
                  {" "}
                  •{" "}
                  <Tooltip>
                    <TooltipTrigger asChild>
                      <span className="cursor-help underline decoration-dotted underline-offset-2">
                        sub-agent
                      </span>
                    </TooltipTrigger>
                    <TooltipContent align="start" className="max-w-80 whitespace-normal">
                      Can be invoked as a sub-agent.
                    </TooltipContent>
                  </Tooltip>
                </>
              ) : null}
            </div>

            {agent.description ? (
              <div className="text-muted mt-1 text-xs">{agent.description}</div>
            ) : null}
          </div>

          <div className="flex shrink-0 flex-col items-end gap-2">
            <div className="flex items-center gap-3">
              {enablementHint ? <div className="text-muted text-xs">{enablementHint}</div> : null}
              <Tooltip>
                <TooltipTrigger asChild>
                  <div className="flex items-center gap-2">
                    <div className="text-muted text-xs">Enabled</div>
                    <Switch
                      checked={enabledValue}
                      disabled={enablementLocked}
                      onCheckedChange={(checked) => setAgentEnabled(agent.id, checked)}
                      aria-label={`Toggle ${agent.id} enabled`}
                    />
                  </div>
                </TooltipTrigger>
                <TooltipContent>{enablementTitle}</TooltipContent>
              </Tooltip>
              {enabledOverride !== undefined ? (
                <Button
                  type="button"
                  variant="ghost"
                  size="sm"
                  className="px-2"
                  onClick={() => resetAgentEnabled(agent.id)}
                >
                  Reset
                </Button>
              ) : null}
            </div>
            {advisorToolEnabled && agent.id !== "intuition" ? (
              <div className="flex items-center gap-3">
                <Tooltip>
                  <TooltipTrigger asChild>
                    <div className="flex items-center gap-2">
                      <div className="text-muted text-xs">Advisor</div>
                      <Switch
                        checked={advisorSwitchState.checked}
                        onCheckedChange={(checked) => setAgentAdvisorEnabled(agent.id, checked)}
                        aria-label={`Toggle ${agent.id} advisor`}
                      />
                    </div>
                  </TooltipTrigger>
                  <TooltipContent>{advisorSwitchState.title}</TooltipContent>
                </Tooltip>
                {advisorEnabledOverride !== undefined ? (
                  <Button
                    type="button"
                    variant="ghost"
                    size="sm"
                    className="px-2"
                    onClick={() => resetAgentAdvisorEnabled(agent.id)}
                  >
                    Reset
                  </Button>
                ) : null}
              </div>
            ) : null}
          </div>
        </div>

        <AiDefaultsControls
          modelValue={modelValue}
          thinkingValue={thinkingValue}
          reasoningModeValue={entry?.reasoningMode ?? inheritedDefaults.reasoningMode ?? "standard"}
          allowProMode={!HEADLESS_REASONING_AGENT_IDS.has(agent.id)}
          // Intuition clamps to model capabilities, not the chat's minimum effort.
          applyMinimumThinkingLevel={agent.id !== "intuition"}
          effectiveModel={effectiveModel}
          models={models}
          hiddenModelsForSelector={hiddenModelsForSelector}
          onModelChange={(value) => setAgentModel(agent.id, value)}
          onThinkingChange={(value) => setAgentThinking(agent.id, value)}
          onReasoningModeChange={(mode) => setAgentReasoningMode(agent.id, mode)}
        />
      </div>
    );
  };

  const renderExecSubagentDefaults = (agent: AgentDefinitionDescriptor) => {
    const entry = agentAiDefaults.exec?.subagent;
    const modelValue = entry?.modelString ?? INHERIT;
    const thinkingValue = entry?.thinkingLevel ?? INHERIT;

    return (
      <div
        key="exec-subagent"
        role="group"
        aria-label="Exec defaults"
        className="border-border-medium bg-background-secondary rounded-md border p-3"
      >
        <div className="min-w-0 flex-1">
          <div className="text-foreground text-sm font-medium">Exec</div>
          <div className="text-muted text-xs">
            {agent.id} • {agent.scope} • {renderPolicySummary(agent)}
          </div>
          <div className="text-muted mt-1 text-xs">
            Unset fields use the calling chat’s Exec settings at task creation, falling back to UI
            Exec defaults when no chat selection exists. Model capabilities are enforced at launch.
            Enabled and advisor settings stay shared with UI Exec.
          </div>
        </div>

        <AiDefaultsControls
          modelValue={modelValue}
          thinkingValue={thinkingValue}
          reasoningModeValue={entry?.reasoningMode ?? "standard"}
          reasoningModeInherited={entry?.reasoningMode === undefined}
          modelCapabilitiesDeferred={entry?.modelString === undefined}
          effectiveModel={entry?.modelString}
          models={models}
          hiddenModelsForSelector={hiddenModelsForSelector}
          inheritLabel="Use calling chat’s Exec"
          showThinkingResetButton
          onModelChange={(value) => setSubagentModel("exec", value)}
          onThinkingChange={(value) => setSubagentThinking("exec", value)}
          onReasoningModeChange={(mode) => setSubagentReasoningMode("exec", mode)}
        />
      </div>
    );
  };

  const renderUnknownAgentDefaults = (agentId: string) => {
    const entry = agentAiDefaults[agentId];
    const modelValue = entry?.modelString ?? INHERIT;
    const thinkingValue = entry?.thinkingLevel ?? INHERIT;
    const advisorEnabledOverride = entry?.advisorEnabled;
    const advisorSwitchState = getAdvisorSwitchState(agentId, advisorEnabledOverride);
    // Base-chain model wins over the ambient default (see renderAgentDefaults).
    const inheritedDefaults = resolveBaseChainDefaults(agentId);
    const effectiveModel =
      modelValue !== INHERIT
        ? modelValue
        : (inheritedDefaults.modelString ?? inheritedEffectiveModel);

    return (
      <div
        key={agentId}
        className="border-border-medium bg-background-secondary rounded-md border p-3"
      >
        <div className="flex items-start justify-between gap-3">
          <div>
            <div className="text-foreground text-sm font-medium">{agentId}</div>
            <div className="text-muted text-xs">Not discovered in the current workspace</div>
          </div>
          {advisorToolEnabled ? (
            <div className="flex shrink-0 items-center gap-3">
              <Tooltip>
                <TooltipTrigger asChild>
                  <div className="flex items-center gap-2">
                    <div className="text-muted text-xs">Advisor</div>
                    <Switch
                      checked={advisorSwitchState.checked}
                      onCheckedChange={(checked) => setAgentAdvisorEnabled(agentId, checked)}
                      aria-label={`Toggle ${agentId} advisor`}
                    />
                  </div>
                </TooltipTrigger>
                <TooltipContent>{advisorSwitchState.title}</TooltipContent>
              </Tooltip>
              {advisorEnabledOverride !== undefined ? (
                <Button
                  type="button"
                  variant="ghost"
                  size="sm"
                  className="px-2"
                  onClick={() => resetAgentAdvisorEnabled(agentId)}
                >
                  Reset
                </Button>
              ) : null}
            </div>
          ) : null}
        </div>

        <AiDefaultsControls
          modelValue={modelValue}
          thinkingValue={thinkingValue}
          reasoningModeValue={entry?.reasoningMode ?? inheritedDefaults.reasoningMode ?? "standard"}
          effectiveModel={effectiveModel}
          models={models}
          hiddenModelsForSelector={hiddenModelsForSelector}
          onModelChange={(value) => setAgentModel(agentId, value)}
          onThinkingChange={(value) => setAgentThinking(agentId, value)}
          onReasoningModeChange={(mode) => setAgentReasoningMode(agentId, mode)}
        />
      </div>
    );
  };

  return (
    <div className="space-y-6">
      <div>
        <h3 className="text-foreground mb-4 text-sm font-medium">Task Settings</h3>
        <div className="space-y-4">
          <div className="flex items-center justify-between gap-4">
            <div className="flex-1">
              <div className="text-foreground text-sm">Default new-workspace agent</div>
              <div className="text-muted text-xs">
                Applies when a project does not have its own agent preference yet.
              </div>
            </div>
            <Select
              value={newWorkspaceDefaultAgentId}
              onValueChange={setNewWorkspaceDefaultAgentId}
            >
              <SelectTrigger className="border-border-medium bg-background-secondary h-9 w-56">
                <SelectValue placeholder="Select agent" />
              </SelectTrigger>
              <SelectContent>
                {newWorkspaceDefaultAgentOptions.map((option) => (
                  <SelectItem key={option.id} value={option.id}>
                    {option.label}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
          </div>

          <div className="flex items-center justify-between gap-4">
            <div className="flex-1">
              <div className="text-foreground text-sm">Max Parallel Agent Tasks</div>
              <div className="text-muted text-xs">
                Default {TASK_SETTINGS_LIMITS.maxParallelAgentTasks.default}, range{" "}
                {TASK_SETTINGS_LIMITS.maxParallelAgentTasks.min}–
                {TASK_SETTINGS_LIMITS.maxParallelAgentTasks.max}
              </div>
            </div>
            <Input
              type="number"
              value={taskSettings.maxParallelAgentTasks}
              min={TASK_SETTINGS_LIMITS.maxParallelAgentTasks.min}
              max={TASK_SETTINGS_LIMITS.maxParallelAgentTasks.max}
              onChange={(e: React.ChangeEvent<HTMLInputElement>) =>
                setMaxParallelAgentTasks(e.target.value)
              }
              className="border-border-medium bg-background-secondary h-9 w-28"
            />
          </div>

          <div className="flex items-center justify-between gap-4">
            <div className="flex-1">
              <div className="text-foreground text-sm">Max Task Nesting Depth</div>
              <div className="text-muted text-xs">
                Default {TASK_SETTINGS_LIMITS.maxTaskNestingDepth.default}, range{" "}
                {TASK_SETTINGS_LIMITS.maxTaskNestingDepth.min}–
                {TASK_SETTINGS_LIMITS.maxTaskNestingDepth.max}
              </div>
            </div>
            <Input
              type="number"
              value={taskSettings.maxTaskNestingDepth}
              min={TASK_SETTINGS_LIMITS.maxTaskNestingDepth.min}
              max={TASK_SETTINGS_LIMITS.maxTaskNestingDepth.max}
              onChange={(e: React.ChangeEvent<HTMLInputElement>) =>
                setMaxTaskNestingDepth(e.target.value)
              }
              className="border-border-medium bg-background-secondary h-9 w-28"
            />
          </div>

          <div className="flex items-center justify-between gap-4">
            <div className="flex-1">
              <div className="text-foreground text-sm">
                Plan: Implement replaces conversation with plan
              </div>
              <div className="text-muted text-xs">
                When enabled, clicking Implement on a plan proposal clears previous messages and
                shows the plan before switching to Exec.
              </div>
            </div>
            <Switch
              checked={taskSettings.proposePlanImplementReplacesChatHistory ?? false}
              onCheckedChange={setProposePlanImplementReplacesChatHistory}
              aria-label="Toggle plan Implement replaces conversation with plan"
            />
          </div>
        </div>

        {saveError ? <div className="text-danger-light mt-4 text-xs">{saveError}</div> : null}
      </div>

      <div>
        <h3 className="text-foreground mb-1 text-sm font-medium">Agent Defaults</h3>
        <div className="text-muted text-xs">
          Defaults apply globally. Changing model/reasoning in a workspace creates a workspace
          override.
        </div>
        {agentsLoadFailed ? (
          <div className="text-danger-light mt-3 text-xs">
            Failed to load agent definitions for this workspace.
          </div>
        ) : null}
        {!agentsLoaded ? <div className="text-muted mt-3 text-xs">Loading agents…</div> : null}
      </div>

      {uiAgents.length > 0 ? (
        <div>
          <h4 className="text-foreground mb-3 text-sm font-medium">UI agents</h4>
          <div className="space-y-4">{uiAgents.map(renderAgentDefaults)}</div>
        </div>
      ) : null}

      {subagents.length > 0 || execSubagentAgent ? (
        <div>
          <h4 className="text-foreground mb-3 text-sm font-medium">Sub-agents</h4>
          <div className="space-y-4">
            {execSubagentAgent ? renderExecSubagentDefaults(execSubagentAgent) : null}
            {subagents.map(renderAgentDefaults)}
          </div>
        </div>
      ) : null}

      {internalAgents.length > 0 ? (
        <div>
          <h4 className="text-foreground mb-3 text-sm font-medium">Internal</h4>
          <div className="space-y-4">{internalAgents.map(renderAgentDefaults)}</div>
        </div>
      ) : null}

      {unknownAgentIds.length > 0 ? (
        <div>
          <h4 className="text-foreground mb-3 text-sm font-medium">Unknown agents</h4>
          <div className="space-y-4">{unknownAgentIds.map(renderUnknownAgentDefaults)}</div>
        </div>
      ) : null}
    </div>
  );
}

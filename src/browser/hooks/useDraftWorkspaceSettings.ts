import { useState, useEffect, useRef, useCallback } from "react";
import { readPersistedState, usePersistedState } from "./usePersistedState";
import { useReasoningMode } from "./useReasoningMode";
import { useThinkingLevel } from "./useThinkingLevel";
import { normalizeSelectedModel } from "@/common/utils/ai/models";
import { useProjectContext } from "@/browser/contexts/ProjectContext";
import {
  type RuntimeMode,
  type ParsedRuntime,
  type CoderWorkspaceConfig,
  buildRuntimeString,
  RUNTIME_MODE,
  CODER_RUNTIME_PLACEHOLDER,
} from "@/common/types/runtime";
import type { RuntimeChoice } from "@/browser/utils/runtimeUi";
import {
  readOptionField,
  readSshOptionDefaults,
  type RuntimeOptionDefaults,
  writeSshOptionDefaults,
} from "@/browser/utils/runtimeOptionDefaults";
import {
  DEFAULT_MODEL_KEY,
  DEFAULT_RUNTIME_KEY,
  getAgentIdKey,
  getModelKey,
  getRuntimeKey,
  getTrunkBranchKey,
  getLastRuntimeConfigKey,
  getProjectScopeId,
  GLOBAL_SCOPE_ID,
} from "@/common/constants/storage";
import type { OpenAIReasoningMode, ThinkingLevel } from "@/common/types/thinking";
import { normalizeAgentId } from "@/common/utils/agentIds";
import { WORKSPACE_DEFAULTS } from "@/constants/workspaceDefaults";

/**
 * Centralized draft workspace settings for project-level persistence
 * All settings persist across navigation and are restored when returning to the same project
 */
export interface DraftWorkspaceSettings {
  // Model & AI settings (synced with global state)
  model: string;
  thinkingLevel: ThinkingLevel;
  reasoningMode: OpenAIReasoningMode;
  agentId: string;

  // Workspace creation settings (project-specific)
  /**
   * Currently selected runtime for this workspace creation.
   * Uses discriminated union so SSH has host, Docker has image, etc.
   */
  selectedRuntime: ParsedRuntime;
  /** Persisted default runtime choice for this project (used to initialize selection) */
  defaultRuntimeMode: RuntimeChoice;
  trunkBranch: string;
}

interface SshRuntimeConfig {
  host: string;
  coder?: CoderWorkspaceConfig;
}

interface SshRuntimeState {
  host: string;
  coderEnabled: boolean;
  coderConfig: CoderWorkspaceConfig | null;
}

interface RememberedRuntimeValues {
  ssh: SshRuntimeConfig;
  dockerImage: string;
  dockerShareCredentials: boolean;
  devcontainerConfigPath: string;
  devcontainerShareCredentials: boolean;
}

/** Stable fallback for Coder config to avoid new object on every render */
const DEFAULT_CODER_CONFIG: CoderWorkspaceConfig = { existingWorkspace: false };
function coerceAgentId(value: unknown): string {
  return normalizeAgentId(value, WORKSPACE_DEFAULTS.agentId);
}

const buildRuntimeForMode = (
  mode: RuntimeMode,
  sshConfig: SshRuntimeConfig,
  dockerImage: string,
  dockerShareCredentials: boolean,
  devcontainerConfigPath: string,
  devcontainerShareCredentials: boolean
): ParsedRuntime => {
  switch (mode) {
    case RUNTIME_MODE.LOCAL:
      return { mode: "local" };
    case RUNTIME_MODE.SSH: {
      // Use placeholder when Coder is enabled with no explicit SSH host
      // This ensures the runtime string round-trips correctly for Coder-only users
      const effectiveHost =
        sshConfig.coder && !sshConfig.host.trim() ? CODER_RUNTIME_PLACEHOLDER : sshConfig.host;

      return {
        mode: "ssh",
        host: effectiveHost,
        coder: sshConfig.coder,
      };
    }
    case RUNTIME_MODE.DOCKER:
      return { mode: "docker", image: dockerImage, shareCredentials: dockerShareCredentials };
    case RUNTIME_MODE.DEVCONTAINER:
      return {
        mode: "devcontainer",
        configPath: devcontainerConfigPath,
        shareCredentials: devcontainerShareCredentials,
      };
    case RUNTIME_MODE.WORKTREE:
    default:
      return { mode: "worktree" };
  }
};

const mergeRememberedRuntimeConfig = (
  nextRuntime: ParsedRuntime,
  previousMode: RuntimeMode,
  remembered: RememberedRuntimeValues
): ParsedRuntime => {
  if (nextRuntime.mode === previousMode) {
    return nextRuntime;
  }

  switch (nextRuntime.mode) {
    case RUNTIME_MODE.SSH:
      return {
        ...nextRuntime,
        host:
          !nextRuntime.host.trim() && remembered.ssh.host.trim()
            ? remembered.ssh.host
            : nextRuntime.host,
        coder:
          nextRuntime.coder === undefined && remembered.ssh.coder != null
            ? remembered.ssh.coder
            : nextRuntime.coder,
      };
    case RUNTIME_MODE.DOCKER:
      return {
        ...nextRuntime,
        image:
          !nextRuntime.image.trim() && remembered.dockerImage.trim()
            ? remembered.dockerImage
            : nextRuntime.image,
        shareCredentials:
          nextRuntime.shareCredentials === undefined && remembered.dockerShareCredentials
            ? remembered.dockerShareCredentials
            : nextRuntime.shareCredentials,
      };
    case RUNTIME_MODE.DEVCONTAINER:
      return {
        ...nextRuntime,
        configPath:
          !nextRuntime.configPath.trim() && remembered.devcontainerConfigPath.trim()
            ? remembered.devcontainerConfigPath
            : nextRuntime.configPath,
        shareCredentials:
          nextRuntime.shareCredentials === undefined && remembered.devcontainerShareCredentials
            ? remembered.devcontainerShareCredentials
            : nextRuntime.shareCredentials,
      };
    default:
      return nextRuntime;
  }
};

const normalizeRuntimeChoice = (value: unknown): RuntimeChoice | null => {
  if (
    value === "coder" ||
    value === RUNTIME_MODE.LOCAL ||
    value === RUNTIME_MODE.WORKTREE ||
    value === RUNTIME_MODE.SSH ||
    value === RUNTIME_MODE.DOCKER ||
    value === RUNTIME_MODE.DEVCONTAINER
  ) {
    return value;
  }

  return null;
};

const buildRuntimeFromChoice = (choice: RuntimeChoice): ParsedRuntime => {
  switch (choice) {
    case "coder":
      return { mode: RUNTIME_MODE.SSH, host: CODER_RUNTIME_PLACEHOLDER };
    case RUNTIME_MODE.LOCAL:
      return { mode: RUNTIME_MODE.LOCAL };
    case RUNTIME_MODE.WORKTREE:
      return { mode: RUNTIME_MODE.WORKTREE };
    case RUNTIME_MODE.SSH:
      return { mode: RUNTIME_MODE.SSH, host: "" };
    case RUNTIME_MODE.DOCKER:
      return { mode: RUNTIME_MODE.DOCKER, image: "" };
    case RUNTIME_MODE.DEVCONTAINER:
      return { mode: RUNTIME_MODE.DEVCONTAINER, configPath: "" };
  }
};

/**
 * Hook to manage all draft workspace settings with centralized persistence
 * Loads saved preferences when projectPath changes, persists all changes automatically
 *
 * @param projectPath - Path to the project (used as key prefix for localStorage)
 * @param branches - Available branches (used to set default trunk branch)
 * @param recommendedTrunk - Backend-recommended trunk branch
 * @returns Settings object and setters
 */
export function useDraftWorkspaceSettings(
  projectPath: string,
  branches: string[],
  recommendedTrunk: string | null
): {
  settings: DraftWorkspaceSettings;
  /** Restores prior Coder selections when re-entering Coder mode. */
  coderConfigFallback: CoderWorkspaceConfig;
  /** Preserves the last SSH host when leaving Coder so the input stays populated. */
  sshHostFallback: string;
  /** Set the currently selected runtime (discriminated union) */
  setSelectedRuntime: (runtime: ParsedRuntime) => void;
  /** Set the default runtime choice for this project (persists via checkbox) */
  setDefaultRuntimeChoice: (choice: RuntimeChoice) => void;
  setTrunkBranch: (branch: string) => void;
  getRuntimeString: () => string | undefined;
} {
  // Global AI settings (read-only from global state)
  const [thinkingLevel] = useThinkingLevel();
  const [reasoningMode] = useReasoningMode();

  const projectScopeId = getProjectScopeId(projectPath);
  const { userProjects } = useProjectContext();
  const projectConfig = userProjects.get(projectPath);

  const [globalDefaultAgentId] = usePersistedState<string>(
    getAgentIdKey(GLOBAL_SCOPE_ID),
    WORKSPACE_DEFAULTS.agentId,
    { listener: true }
  );
  const [projectAgentId] = usePersistedState<string | null>(getAgentIdKey(projectScopeId), null, {
    listener: true,
  });
  const agentId =
    typeof projectAgentId === "string" && projectAgentId.trim().length > 0
      ? coerceAgentId(projectAgentId)
      : coerceAgentId(globalDefaultAgentId);

  // Subscribe to the global default model preference so backend-seeded values apply
  // immediately on fresh origins (e.g., when switching ports).
  const [defaultModelPref] = usePersistedState<string>(
    DEFAULT_MODEL_KEY,
    WORKSPACE_DEFAULTS.model,
    { listener: true }
  );
  // normalizeSelectedModel (not normalizeToCanonical) to preserve explicit
  // gateway routing choices like "openrouter:openai/gpt-5".
  const defaultModel = normalizeSelectedModel(defaultModelPref).trim() || WORKSPACE_DEFAULTS.model;

  // Project-scoped model preference (persisted per project). If unset, fall back to the global
  // default model preference.
  const [modelOverride] = usePersistedState<string | null>(getModelKey(projectScopeId), null, {
    listener: true,
  });
  const model = normalizeSelectedModel(
    typeof modelOverride === "string" && modelOverride.trim().length > 0
      ? modelOverride.trim()
      : defaultModel
  );

  const [rawGlobalDefaultRuntime] = usePersistedState<unknown>(DEFAULT_RUNTIME_KEY, null, {
    listener: true,
  });
  const globalDefaultRuntime = normalizeRuntimeChoice(rawGlobalDefaultRuntime);

  // Project-scoped default runtime (persisted when the creation tooltip checkbox is used).
  // Legacy per-project default (only write-side used by setDefaultRuntimeChoice; reads
  // now come from settingsDefaultRuntime above).
  const [, setDefaultRuntimeString] = usePersistedState<string | undefined>(
    getRuntimeKey(projectPath),
    undefined,
    { listener: true }
  );

  const hasProjectRuntimeOverrides =
    projectConfig?.runtimeOverridesEnabled === true ||
    Boolean(projectConfig?.runtimeEnablement) ||
    projectConfig?.defaultRuntime !== undefined;
  const settingsDefaultRuntime: RuntimeChoice = hasProjectRuntimeOverrides
    ? (projectConfig?.defaultRuntime ?? globalDefaultRuntime ?? RUNTIME_MODE.WORKTREE)
    : (globalDefaultRuntime ?? RUNTIME_MODE.WORKTREE);

  // Always use the Settings-configured default as the canonical source of truth.
  // The old per-project localStorage key (getRuntimeKey) is now stale since the creation
  // tooltip default toggle was removed; new defaults come from the Runtimes settings panel.
  const parsedDefault = buildRuntimeFromChoice(settingsDefaultRuntime);
  const defaultRuntimeMode: RuntimeMode = parsedDefault?.mode ?? RUNTIME_MODE.WORKTREE;

  // Project-scoped trunk branch preference (persisted per project)
  const [trunkBranch, setTrunkBranch] = usePersistedState<string>(
    getTrunkBranchKey(projectPath),
    "",
    { listener: true }
  );

  type LastRuntimeConfigs = RuntimeOptionDefaults;

  // Project-scoped last runtime config (persisted per provider, stored as an object)
  const [lastRuntimeConfigs, setLastRuntimeConfigs] = usePersistedState<LastRuntimeConfigs>(
    getLastRuntimeConfigKey(projectPath),
    {},
    { listener: true }
  );

  const readRuntimeConfigFlag = (
    configs: LastRuntimeConfigs,
    mode: RuntimeMode,
    field: string
  ): boolean => {
    const modeConfig = configs[mode];
    if (!modeConfig || typeof modeConfig !== "object" || Array.isArray(modeConfig)) {
      return false;
    }

    return (modeConfig as Record<string, unknown>)[field] === true;
  };

  // Hide Coder-specific persistence fields behind helpers so callsites stay clean.
  const readSshRuntimeState = (configs: LastRuntimeConfigs): SshRuntimeState => {
    return readSshOptionDefaults(configs, "");
  };

  const readSshRuntimeConfig = (configs: LastRuntimeConfigs): SshRuntimeConfig => {
    const sshState = readSshRuntimeState(configs);

    return {
      host: sshState.host,
      coder: sshState.coderEnabled && sshState.coderConfig ? sshState.coderConfig : undefined,
    };
  };

  const lastSshState = readSshRuntimeState(lastRuntimeConfigs);

  // Preserve the last SSH host when switching out of Coder so the input stays populated.
  const sshHostFallback = lastSshState.host;

  // Restore prior Coder selections when switching back into Coder mode.
  const coderConfigFallback = lastSshState.coderConfig ?? DEFAULT_CODER_CONFIG;
  const lastSsh = readSshRuntimeConfig(lastRuntimeConfigs);
  const lastDockerImage = readOptionField(lastRuntimeConfigs, RUNTIME_MODE.DOCKER, "image", "");
  const lastShareCredentials = readRuntimeConfigFlag(
    lastRuntimeConfigs,
    RUNTIME_MODE.DOCKER,
    "shareCredentials"
  );
  const lastDevcontainerConfigPath = readOptionField(
    lastRuntimeConfigs,
    RUNTIME_MODE.DEVCONTAINER,
    "configPath",
    ""
  );
  const lastDevcontainerShareCredentials = readRuntimeConfigFlag(
    lastRuntimeConfigs,
    RUNTIME_MODE.DEVCONTAINER,
    "shareCredentials"
  );

  const coderDefaultFromString =
    parsedDefault?.mode === RUNTIME_MODE.SSH && parsedDefault.host === CODER_RUNTIME_PLACEHOLDER;
  // Defaults must stay explicit and sticky; last-used SSH state should only seed inputs.
  const defaultRuntimeChoice: RuntimeChoice =
    defaultRuntimeMode === RUNTIME_MODE.SSH && coderDefaultFromString
      ? "coder"
      : defaultRuntimeMode;

  const setLastRuntimeConfig = useCallback(
    // eslint-disable-next-line local/no-object-parameters -- grandfathered when the rule was introduced; fix the underlying type instead of copying this pattern
    (mode: RuntimeMode, field: string, value: string | boolean | object | null) => {
      setLastRuntimeConfigs((prev) => {
        const existing = prev[mode];
        const existingObj =
          existing && typeof existing === "object" && !Array.isArray(existing)
            ? (existing as Record<string, unknown>)
            : {};

        return { ...prev, [mode]: { ...existingObj, [field]: value } };
      });
    },
    [setLastRuntimeConfigs]
  );

  // Persist SSH config while keeping the legacy field shape hidden from callsites.
  const writeSshRuntimeConfig = useCallback(
    (config: SshRuntimeConfig) => {
      setLastRuntimeConfigs((prev) =>
        writeSshOptionDefaults(prev, {
          host: config.host,
          coderEnabled: config.coder !== undefined,
          coderConfig: config.coder ?? null,
        })
      );
    },
    [setLastRuntimeConfigs]
  );

  const seededProjectPathRef = useRef<string | null>(null);

  // If the default runtime string contains a host/image (e.g. older persisted values like "ssh devbox"),
  // prefer it as the initial remembered value.
  // This initialization runs once per project mount instead of reacting to ongoing field edits.
  useEffect(() => {
    if (seededProjectPathRef.current === projectPath) {
      return;
    }
    seededProjectPathRef.current = projectPath;

    if (
      parsedDefault?.mode === RUNTIME_MODE.SSH &&
      !lastSsh.host.trim() &&
      parsedDefault.host.trim()
    ) {
      setLastRuntimeConfig(RUNTIME_MODE.SSH, "host", parsedDefault.host);
    }
    if (
      parsedDefault?.mode === RUNTIME_MODE.DOCKER &&
      !lastDockerImage.trim() &&
      parsedDefault.image.trim()
    ) {
      setLastRuntimeConfig(RUNTIME_MODE.DOCKER, "image", parsedDefault.image);
    }
    if (
      parsedDefault?.mode === RUNTIME_MODE.DEVCONTAINER &&
      !lastDevcontainerConfigPath.trim() &&
      parsedDefault.configPath.trim()
    ) {
      setLastRuntimeConfig(RUNTIME_MODE.DEVCONTAINER, "configPath", parsedDefault.configPath);
    }
  }, [
    projectPath,
    parsedDefault,
    lastSsh.host,
    lastDockerImage,
    lastDevcontainerConfigPath,
    setLastRuntimeConfig,
  ]);

  const defaultSshHost =
    parsedDefault?.mode === RUNTIME_MODE.SSH && parsedDefault.host.trim()
      ? parsedDefault.host
      : lastSsh.host;

  // When the settings default says "Coder", reuse the saved config even if last-used SSH disabled it.
  // When settings say plain "ssh", don't reattach the last-used coder config.
  const defaultSshCoder = coderDefaultFromString
    ? (lastSshState.coderConfig ?? DEFAULT_CODER_CONFIG)
    : settingsDefaultRuntime === RUNTIME_MODE.SSH
      ? undefined
      : lastSsh.coder;

  const defaultDockerImage =
    parsedDefault?.mode === RUNTIME_MODE.DOCKER && parsedDefault.image.trim()
      ? parsedDefault.image
      : lastDockerImage;

  const defaultDevcontainerConfigPath =
    parsedDefault?.mode === RUNTIME_MODE.DEVCONTAINER && parsedDefault.configPath.trim()
      ? parsedDefault.configPath
      : lastDevcontainerConfigPath;

  const defaultRuntime = buildRuntimeForMode(
    defaultRuntimeMode,
    { host: defaultSshHost, coder: defaultSshCoder },
    defaultDockerImage,
    lastShareCredentials,
    defaultDevcontainerConfigPath,
    lastDevcontainerShareCredentials
  );

  // Currently selected runtime for this session (initialized from default)
  // Uses discriminated union: SSH has host, Docker has image
  const [selectedRuntime, setSelectedRuntimeState] = useState<ParsedRuntime>(() => defaultRuntime);

  // Project changes remount ChatInput (key includes projectPath), so this effect only handles
  // live Settings updates to the default runtime while staying on the same project.
  const appliedDefaultRuntimeChoiceRef = useRef<RuntimeChoice>(settingsDefaultRuntime);
  useEffect(() => {
    if (appliedDefaultRuntimeChoiceRef.current === settingsDefaultRuntime) {
      return;
    }

    appliedDefaultRuntimeChoiceRef.current = settingsDefaultRuntime;
    setSelectedRuntimeState(
      buildRuntimeForMode(
        defaultRuntimeMode,
        { host: defaultSshHost, coder: defaultSshCoder },
        defaultDockerImage,
        lastShareCredentials,
        defaultDevcontainerConfigPath,
        lastDevcontainerShareCredentials
      )
    );
  }, [
    settingsDefaultRuntime,
    defaultRuntimeMode,
    defaultSshHost,
    defaultDockerImage,
    lastShareCredentials,
    defaultSshCoder,
    defaultDevcontainerConfigPath,
    lastDevcontainerShareCredentials,
  ]);

  // Initialize trunk branch from backend recommendation or first branch
  useEffect(() => {
    if (branches.length > 0 && (!trunkBranch || !branches.includes(trunkBranch))) {
      const defaultBranch = recommendedTrunk ?? branches[0];
      setTrunkBranch(defaultBranch);
    }
  }, [branches, recommendedTrunk, trunkBranch, setTrunkBranch]);

  const lastSshHost = lastSsh.host;
  const lastSshCoder = lastSsh.coder;

  // Setter for selected runtime (also persists host/image/coder for future mode switches)
  const setSelectedRuntime = (runtime: ParsedRuntime) => {
    // Construct remembered values only when the user changes runtimes. Keeping
    // this object off the render path lets React Compiler retain the setter
    // identity while unrelated ChatInput draft text changes.
    const mergedRuntime = mergeRememberedRuntimeConfig(runtime, selectedRuntime.mode, {
      ssh: { host: lastSshHost, coder: lastSshCoder },
      dockerImage: lastDockerImage,
      dockerShareCredentials: lastShareCredentials,
      devcontainerConfigPath: lastDevcontainerConfigPath,
      devcontainerShareCredentials: lastDevcontainerShareCredentials,
    });

    setSelectedRuntimeState(mergedRuntime);

    // Persist host/image/coder so they're remembered when switching modes.
    // Avoid wiping the remembered value when the UI switches modes with an empty field.
    // Avoid persisting the Coder placeholder as the remembered SSH host.
    if (mergedRuntime.mode === RUNTIME_MODE.SSH) {
      writeSshRuntimeConfig({ host: mergedRuntime.host, coder: mergedRuntime.coder });
    } else if (mergedRuntime.mode === RUNTIME_MODE.DOCKER) {
      if (mergedRuntime.image.trim()) {
        setLastRuntimeConfig(RUNTIME_MODE.DOCKER, "image", mergedRuntime.image);
      }
      if (mergedRuntime.shareCredentials !== undefined) {
        setLastRuntimeConfig(
          RUNTIME_MODE.DOCKER,
          "shareCredentials",
          mergedRuntime.shareCredentials
        );
      }
    } else if (mergedRuntime.mode === RUNTIME_MODE.DEVCONTAINER) {
      if (mergedRuntime.configPath.trim()) {
        setLastRuntimeConfig(RUNTIME_MODE.DEVCONTAINER, "configPath", mergedRuntime.configPath);
      }
      if (mergedRuntime.shareCredentials !== undefined) {
        setLastRuntimeConfig(
          RUNTIME_MODE.DEVCONTAINER,
          "shareCredentials",
          mergedRuntime.shareCredentials
        );
      }
    }
  };

  // Setter for default runtime choice (persists via checkbox in tooltip)
  const setDefaultRuntimeChoice = (choice: RuntimeChoice) => {
    // Defaults should only change when the checkbox is toggled, not when last-used SSH flips.
    const freshRuntimeConfigs = readPersistedState<LastRuntimeConfigs>(
      getLastRuntimeConfigKey(projectPath),
      {}
    );
    const freshSshState = readSshRuntimeState(freshRuntimeConfigs);

    const newMode = choice === "coder" ? RUNTIME_MODE.SSH : choice;
    const sshConfig: SshRuntimeConfig =
      choice === "coder"
        ? {
            host: CODER_RUNTIME_PLACEHOLDER,
            coder: freshSshState.coderConfig ?? DEFAULT_CODER_CONFIG,
          }
        : {
            host: freshSshState.host,
            coder: undefined,
          };

    const newRuntime = buildRuntimeForMode(
      newMode,
      sshConfig,
      lastDockerImage,
      lastShareCredentials,
      defaultDevcontainerConfigPath,
      lastDevcontainerShareCredentials
    );
    const newRuntimeString = buildRuntimeString(newRuntime);
    setDefaultRuntimeString(newRuntimeString);
    // Also update selection to match new default
    setSelectedRuntimeState(newRuntime);
  };

  // Helper to get runtime string for IPC calls
  const getRuntimeString = (): string | undefined => {
    return buildRuntimeString(selectedRuntime);
  };

  return {
    settings: {
      model,
      thinkingLevel,
      reasoningMode,
      agentId,
      selectedRuntime,
      defaultRuntimeMode: defaultRuntimeChoice,
      trunkBranch,
    },
    coderConfigFallback,
    sshHostFallback,
    setSelectedRuntime,
    setDefaultRuntimeChoice,
    setTrunkBranch,
    getRuntimeString,
  };
}

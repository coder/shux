import { useEffect, useRef, useState } from "react";
import { AlertTriangle, Loader2 } from "lucide-react";

import { Button } from "@/browser/components/Button/Button";
import { Input } from "@/browser/components/Input/Input";
import { getErrorMessage } from "@/common/utils/errors";

import {
  CoderWorkspaceForm,
  resolveCoderAvailability,
} from "@/browser/features/Runtime/CoderControls";
import { RuntimeConfigInput } from "@/browser/components/RuntimeConfigInput/RuntimeConfigInput";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/browser/components/SelectPrimitive/SelectPrimitive";
import { Switch } from "@/browser/components/Switch/Switch";
import { Tooltip, TooltipContent, TooltipTrigger } from "@/browser/components/Tooltip/Tooltip";
import { useAPI } from "@/browser/contexts/API";
import { useProjectContext } from "@/browser/contexts/ProjectContext";
import { useSettings } from "@/browser/contexts/SettingsContext";
import { useCoderWorkspace } from "@/browser/hooks/useCoderWorkspace";
import { usePersistedState } from "@/browser/hooks/usePersistedState";
import { useRuntimeEnablement } from "@/browser/hooks/useRuntimeEnablement";
import {
  readSshOptionDefaults,
  type RuntimeOptionDefaults,
  writeSshCoderDefaultsPreservingMode,
} from "@/browser/utils/runtimeOptionDefaults";
import {
  RUNTIME_CHOICE_UI,
  getRuntimeOptionField,
  type RuntimeUiSpec,
} from "@/browser/utils/runtimeUi";
import type { CoderWorkspaceConfig } from "@/common/orpc/schemas/coder";
import { cn } from "@/common/lib/utils";
import { getLastRuntimeConfigKey } from "@/common/constants/storage";
import type { ProjectConfig } from "@/common/types/project";
import { normalizeRuntimeEnablement, RUNTIME_MODE } from "@/common/types/runtime";
import type {
  RuntimeAvailabilityStatus,
  RuntimeEnablement,
  RuntimeEnablementId,
  RuntimeMode,
} from "@/common/types/runtime";

type RuntimeAvailabilityMap = Record<RuntimeMode, RuntimeAvailabilityStatus>;

type RuntimeRow = { id: RuntimeEnablementId } & RuntimeUiSpec;

type RuntimeAvailabilityState =
  | { status: "idle" }
  | { status: "loading" }
  | { status: "failed" }
  | { status: "loaded"; data: RuntimeAvailabilityMap };

interface RuntimeOverrideCacheEntry {
  enablement: RuntimeEnablement;
  defaultRuntime: RuntimeEnablementId | null;
  pending: boolean;
  overridesEnabled: boolean;
}

const ALL_SCOPE_VALUE = "__all__";

const RUNTIME_ROWS: RuntimeRow[] = [
  { id: "local", ...RUNTIME_CHOICE_UI.local },
  { id: "worktree", ...RUNTIME_CHOICE_UI.worktree },
  { id: "ssh", ...RUNTIME_CHOICE_UI.ssh },
  { id: "coder", ...RUNTIME_CHOICE_UI.coder },
  { id: "docker", ...RUNTIME_CHOICE_UI.docker },
  { id: "devcontainer", ...RUNTIME_CHOICE_UI.devcontainer },
];

function getProjectLabel(path: string) {
  return path.split(/[\\/]/).pop() ?? path;
}

function getFallbackRuntime(enablement: RuntimeEnablement): RuntimeEnablementId | null {
  return RUNTIME_ROWS.find((runtime) => enablement[runtime.id])?.id ?? null;
}

function deriveProjectOverrideState(
  selectedProjectPath: string | null,
  projects: Map<string, ProjectConfig>,
  enablement: RuntimeEnablement,
  defaultRuntime: RuntimeEnablementId | null | undefined,
  overrideCache: Map<string, RuntimeOverrideCacheEntry>
): {
  projectOverrideEnabled: boolean;
  projectEnablement: RuntimeEnablement;
  projectDefaultRuntime: RuntimeEnablementId | null;
} {
  if (!selectedProjectPath) {
    return {
      projectOverrideEnabled: false,
      projectEnablement: enablement,
      projectDefaultRuntime: defaultRuntime ?? null,
    };
  }

  const cached = overrideCache.get(selectedProjectPath);
  if (cached?.pending) {
    // Keep pending override state stable until refreshProjects completes to avoid
    // toggling the UI back on/off while backend config is still propagating.
    return {
      projectOverrideEnabled: cached.overridesEnabled === true,
      projectEnablement: cached.enablement,
      projectDefaultRuntime: cached.defaultRuntime ?? defaultRuntime ?? null,
    };
  }

  const projectConfig = projects.get(selectedProjectPath);
  const hasOverrides =
    projectConfig?.runtimeOverridesEnabled === true ||
    Boolean(projectConfig?.runtimeEnablement) ||
    projectConfig?.defaultRuntime !== undefined;

  if (hasOverrides) {
    const resolvedEnablement = normalizeRuntimeEnablement(projectConfig?.runtimeEnablement);
    // When overrides are active, the project's enablement is independent of global settings
    // (all-true defaults + only the project's explicit `false` overrides). This matches
    // the creation flow in ChatInput/index.tsx which uses normalizeRuntimeEnablement directly.
    return {
      projectOverrideEnabled: true,
      projectEnablement: resolvedEnablement,
      projectDefaultRuntime: projectConfig?.defaultRuntime ?? defaultRuntime ?? null,
    };
  }

  return {
    projectOverrideEnabled: false,
    projectEnablement: enablement,
    projectDefaultRuntime: defaultRuntime ?? null,
  };
}

/**
 * Per-project opt-in path of a VS Code .code-workspace file that xum keeps in
 * sync with the project's active worktrees (issue #3722). Parent keys this by
 * project path so drafts reset on scope switches.
 */
function CodeWorkspaceSyncField(props: { projectPath: string }) {
  const { userProjects, updateCodeWorkspaceSyncPath } = useProjectContext();
  const savedPath = userProjects.get(props.projectPath)?.codeWorkspaceSyncPath ?? "";
  // null = untouched: the input shows the saved value.
  const [draft, setDraft] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const draftValue = draft ?? savedPath;
  const isDirty = draftValue.trim() !== savedPath;

  // DOM attributes must not receive promise-returning handlers
  // (@typescript-eslint/no-misused-promises), so instead of awaiting inline,
  // unexpected rejections are explicitly routed into the visible error state.
  const saveDraft = () => {
    void handleSave().catch((saveError: unknown) => {
      setError(getErrorMessage(saveError));
      setSaving(false);
    });
  };

  const handleSave = async () => {
    setSaving(true);
    setError(null);
    const result = await updateCodeWorkspaceSyncPath(
      props.projectPath,
      draftValue.trim() ? draftValue.trim() : null
    );
    if (result.success) {
      setDraft(null);
    } else {
      setError(result.error ?? "Failed to save workspace file path");
    }
    setSaving(false);
  };

  return (
    <div className="border-border-light bg-background-secondary rounded-md border px-3 py-2">
      <div className="text-foreground text-sm">VS Code workspace file</div>
      <div className="text-muted text-xs">
        Path of a <code className="text-accent">.code-workspace</code> file kept in sync with this
        project&apos;s active worktrees (absolute, <code className="text-accent">~</code>, or
        relative to the project). Leave empty to disable.
      </div>
      <div className="mt-2 flex items-center gap-2">
        <Input
          value={draftValue}
          onChange={(event) => {
            setDraft(event.target.value);
          }}
          onKeyDown={(event) => {
            if (event.key === "Enter" && isDirty && !saving) {
              event.preventDefault();
              saveDraft();
            }
          }}
          disabled={saving}
          placeholder="e.g. ~/my-project.code-workspace"
          aria-label="VS Code workspace file path"
          className="max-w-[360px] min-w-0"
        />
        <Button onClick={saveDraft} disabled={!isDirty || saving} className="shrink-0">
          {saving ? "Saving..." : "Save"}
        </Button>
      </div>
      {error && (
        <div className="bg-destructive/10 text-destructive mt-2 rounded-md px-3 py-2 text-sm">
          {error}
        </div>
      )}
    </div>
  );
}

export function RuntimesSection() {
  const { api } = useAPI();
  const { userProjects, refreshProjects } = useProjectContext();
  const { enablement, setRuntimeEnabled, defaultRuntime, setDefaultRuntime } =
    useRuntimeEnablement();
  const { runtimesProjectPath, setRuntimesProjectPath } = useSettings();

  const projectList = Array.from(userProjects.keys());

  // Consume one-shot project scope hint from "set defaults" button in creation controls.
  const initialScope =
    runtimesProjectPath && userProjects.has(runtimesProjectPath)
      ? runtimesProjectPath
      : ALL_SCOPE_VALUE;
  const [selectedScope, setSelectedScope] = useState(initialScope);
  const [runtimeAvailabilityState, setRuntimeAvailabilityState] =
    useState<RuntimeAvailabilityState>({ status: "idle" });
  const [, setOverrideCacheVersion] = useState(0);
  // Cache pending per-project overrides locally while config updates propagate.
  const overrideCacheRef = useRef<Map<string, RuntimeOverrideCacheEntry>>(new Map());

  // When re-opened with a new project hint (e.g., clicking "set defaults" again for
  // a different project), sync the scope and clear the one-shot hint.
  // Only clear the hint once the project is actually found in the project list;
  // projects load asynchronously, so we must keep the hint alive until then.
  useEffect(() => {
    if (!runtimesProjectPath) return;
    if (!userProjects.has(runtimesProjectPath)) return;
    setSelectedScope(runtimesProjectPath);
    setRuntimesProjectPath(null);
  }, [runtimesProjectPath, userProjects, setRuntimesProjectPath]);

  // Derive scope during render so stale selections self-heal without effect-driven state sync.
  const effectiveScope =
    selectedScope !== ALL_SCOPE_VALUE && userProjects.has(selectedScope)
      ? selectedScope
      : ALL_SCOPE_VALUE;
  const selectedProjectPath = effectiveScope === ALL_SCOPE_VALUE ? null : effectiveScope;
  const isProjectScope = Boolean(selectedProjectPath);

  // Per-project runtime option defaults (SSH host, Docker image, etc.).
  // Same localStorage keys the creation flow reads, so edits here are reflected immediately.
  const runtimeConfigKey = selectedProjectPath
    ? getLastRuntimeConfigKey(selectedProjectPath)
    : "__no_project_defaults__";
  const [runtimeOptionConfigs, setRuntimeOptionConfigs] = usePersistedState<RuntimeOptionDefaults>(
    runtimeConfigKey,
    {},
    { listener: true }
  );
  const sshOptionDefaults = readSshOptionDefaults(runtimeOptionConfigs, "");

  // Settings-local Coder draft: absorbs hook auto-selection without persisting.
  // Only written to localStorage after explicit user interaction.
  const [coderDraftConfig, setCoderDraftConfig] = useState<CoderWorkspaceConfig | null>(null);
  const hasCoderUserInteractionRef = useRef(false);
  const selectedProjectPathRef = useRef(selectedProjectPath);
  selectedProjectPathRef.current = selectedProjectPath;

  useEffect(() => {
    setCoderDraftConfig(null);
    hasCoderUserInteractionRef.current = false;
  }, [selectedProjectPath]);

  const readOptionField = (runtimeMode: string, field: string): string => {
    const modeConfig = runtimeOptionConfigs[runtimeMode as RuntimeMode];
    if (!modeConfig || typeof modeConfig !== "object") return "";
    const val = (modeConfig as Record<string, unknown>)[field];
    return typeof val === "string" ? val : "";
  };

  const setOptionField = (runtimeMode: string, field: string, value: string) => {
    setRuntimeOptionConfigs((prev) => {
      const existing = prev[runtimeMode as RuntimeMode];
      const existingObj = existing && typeof existing === "object" ? existing : {};
      return {
        ...prev,
        [runtimeMode]: { ...(existingObj as Record<string, unknown>), [field]: value },
      };
    });
  };

  const syncProjects = () =>
    refreshProjects().catch(() => {
      // Best-effort only.
    });

  const queueProjectOverrideUpdate = (
    projectPath: string,
    entry: RuntimeOverrideCacheEntry,
    payload: {
      projectPath: string;
      runtimeEnablement?: RuntimeEnablement | null;
      defaultRuntime?: RuntimeEnablementId | null;
      runtimeOverridesEnabled?: boolean | null;
    }
  ) => {
    overrideCacheRef.current.set(projectPath, entry);
    // Cache writes are mutable, so bump a lightweight counter to force render-time re-derivation.
    setOverrideCacheVersion((prev) => prev + 1);
    const updatePromise = api?.config?.updateRuntimeEnablement(payload);
    if (!updatePromise) {
      overrideCacheRef.current.set(projectPath, { ...entry, pending: false });
      setOverrideCacheVersion((prev) => prev + 1);
      return;
    }

    updatePromise
      .finally(() =>
        syncProjects().finally(() => {
          if (overrideCacheRef.current.get(projectPath) === entry) {
            overrideCacheRef.current.set(projectPath, { ...entry, pending: false });
            setOverrideCacheVersion((prev) => prev + 1);
          }
        })
      )
      .catch(() => {
        // Best-effort only.
      });
  };

  // Keep project override UI purely derived from project config + pending cache.
  // This avoids duplicated derived state and effect-driven synchronization.
  const { projectOverrideEnabled, projectEnablement, projectDefaultRuntime } =
    deriveProjectOverrideState(
      selectedProjectPath,
      userProjects,
      enablement,
      defaultRuntime,
      overrideCacheRef.current
    );
  const isProjectOverrideActive = isProjectScope && projectOverrideEnabled;

  const effectiveEnablement = isProjectOverrideActive ? projectEnablement : enablement;
  const effectiveDefaultRuntime = isProjectOverrideActive ? projectDefaultRuntime : defaultRuntime;
  // Coder config precedence: draft (in-session auto-selection) → persisted → seed.
  // Draft-first ensures auto-selected templates/presets from useCoderWorkspace are
  // immediately reflected in the form, even when persisted config is already non-null.
  const coderConfigForHook =
    selectedProjectPath && effectiveEnablement.coder
      ? (coderDraftConfig ?? sshOptionDefaults.coderConfig ?? { existingWorkspace: false })
      : null;

  const coderWorkspace = useCoderWorkspace({
    coderConfig: coderConfigForHook,
    // Settings only refreshes auth on mount — no need for focus-based re-checks.
    coderInfoRefreshPolicy: "mount-only",
    onCoderConfigChange: (nextConfig) => {
      // Guard against stale scope: async template/preset fetches from
      // useCoderWorkspace can complete after a project switch. If the
      // captured selectedProjectPath no longer matches, discard the update.
      if (!selectedProjectPath || selectedProjectPath !== selectedProjectPathRef.current) {
        return;
      }

      // Always update local draft for UI responsiveness.
      setCoderDraftConfig(nextConfig);

      // Only persist to localStorage after explicit user interaction.
      if (!hasCoderUserInteractionRef.current) {
        return;
      }

      // Settings edits own Coder defaults, not mode selection memory.
      // writeSshCoderDefaultsPreservingMode preserves coderEnabled from storage.
      setRuntimeOptionConfigs((prev) => writeSshCoderDefaultsPreservingMode(prev, nextConfig));
    },
  });

  useEffect(() => {
    if (!api || !selectedProjectPath) {
      setRuntimeAvailabilityState({ status: "idle" });
      return;
    }

    let active = true;
    setRuntimeAvailabilityState({ status: "loading" });

    api.projects
      .runtimeAvailability({ projectPath: selectedProjectPath })
      .then((availability) => {
        if (active) {
          setRuntimeAvailabilityState({ status: "loaded", data: availability });
        }
      })
      .catch(() => {
        if (active) {
          setRuntimeAvailabilityState({ status: "failed" });
        }
      });

    return () => {
      active = false;
    };
  }, [api, selectedProjectPath]);

  const coderAvailability = resolveCoderAvailability(coderWorkspace.coderInfo);
  const availabilityMap =
    runtimeAvailabilityState.status === "loaded" ? runtimeAvailabilityState.data : null;

  const enabledRuntimeOptions = RUNTIME_ROWS.filter((runtime) => effectiveEnablement[runtime.id]);
  const enabledRuntimeCount = enabledRuntimeOptions.length;

  const defaultRuntimeValue =
    effectiveDefaultRuntime && effectiveEnablement[effectiveDefaultRuntime]
      ? effectiveDefaultRuntime
      : "";
  const defaultRuntimePlaceholder =
    enabledRuntimeOptions.length === 0 ? "No runtimes enabled" : "Select default runtime";
  const defaultRuntimeDisabled =
    enabledRuntimeOptions.length === 0 || (isProjectScope && !projectOverrideEnabled);

  const handleOverrideToggle = (checked: boolean) => {
    if (!selectedProjectPath) {
      return;
    }

    if (!checked) {
      const cacheEntry: RuntimeOverrideCacheEntry = {
        enablement,
        defaultRuntime: defaultRuntime ?? null,
        pending: true,
        overridesEnabled: false,
      };
      queueProjectOverrideUpdate(selectedProjectPath, cacheEntry, {
        projectPath: selectedProjectPath,
        runtimeEnablement: null,
        defaultRuntime: null,
        runtimeOverridesEnabled: null,
      });
      return;
    }

    const nextEnablement = { ...enablement };
    const cacheEntry: RuntimeOverrideCacheEntry = {
      enablement: nextEnablement,
      defaultRuntime: defaultRuntime ?? null,
      pending: true,
      overridesEnabled: true,
    };
    queueProjectOverrideUpdate(selectedProjectPath, cacheEntry, {
      projectPath: selectedProjectPath,
      runtimeEnablement: nextEnablement,
      defaultRuntime: defaultRuntime ?? null,
      runtimeOverridesEnabled: true,
    });
  };

  const handleRuntimeToggle = (runtimeId: RuntimeEnablementId, enabled: boolean) => {
    if (!enabled) {
      // Keep at least one runtime enabled to avoid leaving users without a fallback.
      const currentEnabledCount = RUNTIME_ROWS.filter(
        (runtime) => effectiveEnablement[runtime.id]
      ).length;
      if (currentEnabledCount <= 1) {
        return;
      }
    }

    const nextEnablement: RuntimeEnablement = {
      ...effectiveEnablement,
      [runtimeId]: enabled,
    };

    if (!isProjectScope) {
      const implicitDefault: RuntimeEnablementId = defaultRuntime ?? RUNTIME_MODE.WORKTREE;
      let nextDefaultRuntime: RuntimeEnablementId | null = implicitDefault;
      if (!nextEnablement[implicitDefault]) {
        nextDefaultRuntime = getFallbackRuntime(nextEnablement);
      }

      const shouldUpdateDefault =
        defaultRuntime !== null
          ? nextDefaultRuntime !== defaultRuntime
          : nextDefaultRuntime !== implicitDefault;

      if (shouldUpdateDefault) {
        setRuntimeEnabled(runtimeId, enabled, nextDefaultRuntime ?? null);
      } else {
        setRuntimeEnabled(runtimeId, enabled);
      }
      return;
    }

    if (!selectedProjectPath || !projectOverrideEnabled) {
      return;
    }

    const inheritedDefault = projectDefaultRuntime ?? defaultRuntime ?? null;
    let nextDefaultRuntime = inheritedDefault;
    if (nextDefaultRuntime && !nextEnablement[nextDefaultRuntime]) {
      nextDefaultRuntime = getFallbackRuntime(nextEnablement);
    }
    const cacheEntry: RuntimeOverrideCacheEntry = {
      enablement: nextEnablement,
      defaultRuntime: nextDefaultRuntime,
      pending: true,
      overridesEnabled: true,
    };

    const updatePayload: {
      projectPath: string;
      runtimeEnablement: RuntimeEnablement;
      defaultRuntime?: RuntimeEnablementId | null;
      runtimeOverridesEnabled?: boolean;
    } = {
      projectPath: selectedProjectPath,
      runtimeEnablement: nextEnablement,
      runtimeOverridesEnabled: true,
    };

    if (nextDefaultRuntime !== projectDefaultRuntime) {
      updatePayload.defaultRuntime = nextDefaultRuntime ?? null;
    }

    queueProjectOverrideUpdate(selectedProjectPath, cacheEntry, updatePayload);
  };

  const handleDefaultRuntimeChange = (value: string) => {
    const runtimeId = value as RuntimeEnablementId;

    if (!isProjectScope) {
      setDefaultRuntime(runtimeId);
      return;
    }

    if (!selectedProjectPath || !projectOverrideEnabled) {
      return;
    }

    const cacheEntry: RuntimeOverrideCacheEntry = {
      enablement: projectEnablement,
      defaultRuntime: runtimeId,
      pending: true,
      overridesEnabled: true,
    };
    queueProjectOverrideUpdate(selectedProjectPath, cacheEntry, {
      projectPath: selectedProjectPath,
      defaultRuntime: runtimeId,
      runtimeOverridesEnabled: true,
    });
  };

  return (
    <div className="space-y-6">
      <div className="space-y-4">
        <div className="flex items-center justify-between gap-4">
          <div>
            <div className="text-foreground text-sm">Scope</div>
            <div className="text-muted text-xs">Manage runtimes globally or per project.</div>
          </div>
          <Select value={effectiveScope} onValueChange={setSelectedScope}>
            <SelectTrigger
              className="border-border-medium bg-background-secondary hover:bg-hover h-9 w-auto min-w-[160px] cursor-pointer rounded-md border px-3 text-sm transition-colors"
              aria-label="Scope"
            >
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              <SelectItem value={ALL_SCOPE_VALUE}>All</SelectItem>
              {projectList.map((path) => (
                <SelectItem key={path} value={path}>
                  {getProjectLabel(path)}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
        </div>

        {isProjectScope ? (
          <div className="border-border-light bg-background-secondary flex items-center justify-between gap-4 rounded-md border px-3 py-2">
            <div>
              <div className="text-foreground text-sm">Override project settings</div>
              <div className="text-muted text-xs">
                Keep global defaults or customize enabled runtimes for this project.
              </div>
            </div>
            <Switch
              checked={projectOverrideEnabled}
              onCheckedChange={handleOverrideToggle}
              aria-label="Override project runtime settings"
            />
          </div>
        ) : null}

        {selectedProjectPath ? (
          <CodeWorkspaceSyncField key={selectedProjectPath} projectPath={selectedProjectPath} />
        ) : null}
      </div>

      <div className="space-y-4">
        <div
          className={cn(
            "flex items-center justify-between gap-4",
            isProjectScope && !projectOverrideEnabled && "opacity-60"
          )}
        >
          <div>
            <div className="text-foreground text-sm">Default runtime</div>
            <div className="text-muted text-xs">
              {isProjectScope
                ? "Applied to new workspaces in this project."
                : "Applied to new workspaces by default."}
            </div>
          </div>
          <Select
            value={defaultRuntimeValue}
            onValueChange={handleDefaultRuntimeChange}
            disabled={defaultRuntimeDisabled}
          >
            <SelectTrigger className="border-border-medium bg-background-secondary hover:bg-hover h-9 w-auto min-w-[180px] cursor-pointer rounded-md border px-3 text-sm transition-colors">
              <SelectValue placeholder={defaultRuntimePlaceholder} />
            </SelectTrigger>
            <SelectContent>
              {enabledRuntimeOptions.map((runtime) => (
                <SelectItem key={runtime.id} value={runtime.id}>
                  {runtime.label}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
        </div>

        <div className="divide-border-light divide-y">
          {RUNTIME_ROWS.map((runtime) => {
            const Icon = runtime.Icon;
            const isCoder = runtime.id === "coder";
            const availability = isCoder
              ? null
              : (availabilityMap?.[runtime.id as RuntimeMode] ?? null);
            const availabilityReason = isProjectScope
              ? isCoder
                ? coderAvailability.state !== "available" && coderAvailability.state !== "loading"
                  ? coderAvailability.reason
                  : null
                : availability && !availability.available
                  ? availability.reason
                  : null
              : null;
            const showLoading = isProjectScope
              ? isCoder
                ? coderAvailability.state === "loading"
                : runtimeAvailabilityState.status === "loading"
              : false;
            const rowDisabled = isProjectScope && !projectOverrideEnabled;
            const isLastEnabled = effectiveEnablement[runtime.id] && enabledRuntimeCount <= 1;
            const switchDisabled = rowDisabled || isLastEnabled;
            const optionSpec = getRuntimeOptionField(runtime.id);
            const optionRuntimeMode: RuntimeMode =
              runtime.id === "coder" ? RUNTIME_MODE.SSH : runtime.id;
            const switchControl = (
              <Switch
                checked={effectiveEnablement[runtime.id]}
                disabled={switchDisabled}
                onCheckedChange={(checked) => handleRuntimeToggle(runtime.id, checked)}
                aria-label={`Toggle ${runtime.label} runtime`}
              />
            );
            const switchNode =
              isLastEnabled && !rowDisabled ? (
                <Tooltip>
                  <TooltipTrigger asChild>
                    <span className="inline-flex">{switchControl}</span>
                  </TooltipTrigger>
                  <TooltipContent align="end">At least one runtime must be enabled.</TooltipContent>
                </Tooltip>
              ) : (
                switchControl
              );

            // Inline status indicators keep availability feedback from shifting row layout.
            return (
              <div
                key={runtime.id}
                className={cn(
                  "flex items-start justify-between gap-4 py-3",
                  rowDisabled && "opacity-60"
                )}
              >
                <div className="flex flex-1 gap-3 pr-4">
                  <Icon size={16} className="text-muted mt-0.5" />
                  <div className="flex-1">
                    <div className="flex items-center gap-2">
                      <div className="text-foreground text-sm">{runtime.label}</div>
                      {availabilityReason ? (
                        <Tooltip>
                          <TooltipTrigger asChild>
                            <span className="bg-warning/10 text-warning border-warning/30 inline-flex cursor-help items-center gap-1 rounded-full border px-1.5 py-0.5 text-[10px]">
                              <AlertTriangle className="h-3 w-3" />
                              Unavailable
                            </span>
                          </TooltipTrigger>
                          <TooltipContent align="start" className="max-w-64 whitespace-normal">
                            {availabilityReason}
                          </TooltipContent>
                        </Tooltip>
                      ) : null}
                    </div>
                    <div className="text-muted text-xs">{runtime.description}</div>
                    {/* Configurable option inputs: project scope uses the same input component
                        and localStorage defaults as the creation flow. */}
                    {!optionSpec || !selectedProjectPath ? (
                      runtime.options && !selectedProjectPath ? (
                        <div className="text-muted/70 text-[11px]">Options: {runtime.options}</div>
                      ) : null
                    ) : (
                      <RuntimeConfigInput
                        fieldSpec={optionSpec}
                        value={readOptionField(optionRuntimeMode, optionSpec.field)}
                        onChange={(value) =>
                          setOptionField(optionRuntimeMode, optionSpec.field, value)
                        }
                        disabled={rowDisabled}
                        className="mt-1.5"
                        inputClassName="w-full max-w-[260px]"
                        ariaLabel={`${optionSpec.label} for ${runtime.label}`}
                        stacked
                      />
                    )}
                    {isCoder &&
                    selectedProjectPath &&
                    effectiveEnablement.coder &&
                    coderAvailability.state === "available" ? (
                      <CoderWorkspaceForm
                        className="mt-3"
                        coderConfig={coderWorkspace.coderConfig}
                        onCoderConfigChange={(config) => {
                          hasCoderUserInteractionRef.current = true;
                          coderWorkspace.setCoderConfig(config);
                        }}
                        templates={coderWorkspace.templates}
                        templatesError={coderWorkspace.templatesError}
                        presets={coderWorkspace.presets}
                        presetsError={coderWorkspace.presetsError}
                        existingWorkspaces={coderWorkspace.existingWorkspaces}
                        workspacesError={coderWorkspace.workspacesError}
                        loadingTemplates={coderWorkspace.loadingTemplates}
                        loadingPresets={coderWorkspace.loadingPresets}
                        loadingWorkspaces={coderWorkspace.loadingWorkspaces}
                        username={
                          coderWorkspace.coderInfo?.state === "available"
                            ? coderWorkspace.coderInfo.username
                            : undefined
                        }
                        deploymentUrl={
                          coderWorkspace.coderInfo?.state === "available"
                            ? coderWorkspace.coderInfo.url
                            : undefined
                        }
                        disabled={rowDisabled || coderAvailability.state !== "available"}
                      />
                    ) : null}
                  </div>
                </div>
                <div className="flex items-center gap-3">
                  <div className="flex h-4 w-4 items-center justify-center">
                    {showLoading ? <Loader2 className="text-muted h-4 w-4 animate-spin" /> : null}
                  </div>
                  {switchNode}
                </div>
              </div>
            );
          })}
        </div>
      </div>
    </div>
  );
}

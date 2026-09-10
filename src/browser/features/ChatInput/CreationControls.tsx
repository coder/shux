import React, { useCallback, useEffect } from "react";
import * as SelectPrimitive from "@radix-ui/react-select";
import {
  RUNTIME_MODE,
  type CoderWorkspaceConfig,
  type RuntimeMode,
  type ParsedRuntime,
  type RuntimeEnablement,
  CODER_RUNTIME_PLACEHOLDER,
} from "@/common/types/runtime";
import type { RuntimeAvailabilityMap, RuntimeAvailabilityState } from "./useCreationWorkspace";
import {
  resolveDevcontainerSelection,
  DEFAULT_DEVCONTAINER_CONFIG_PATH,
} from "@/browser/utils/devcontainerSelection";
import {
  Select as RadixSelect,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/browser/components/SelectPrimitive/SelectPrimitive";
import { GitBranch, Loader2, Wand2 } from "lucide-react";
import type { ProjectConfig } from "@/common/types/project";
import { formatProjectHierarchyLabel } from "@/common/utils/subProjects";
import { CreationProjectSelect } from "./CreationProjectSelect";
import { RuntimeConfigInput } from "@/browser/components/RuntimeConfigInput/RuntimeConfigInput";
import { usePerfRenderMarker } from "@/browser/utils/perf/PerfRenderMarker";
import { cn } from "@/common/lib/utils";
import { formatNameGenerationError } from "@/common/utils/errors/formatNameGenerationError";
import { Tooltip, TooltipTrigger, TooltipContent } from "@/browser/components/Tooltip/Tooltip";
import { Skeleton } from "@/browser/components/Skeleton/Skeleton";
import { DocsLink } from "@/browser/components/DocsLink/DocsLink";
import {
  RUNTIME_CHOICE_UI,
  RUNTIME_OPTION_FIELDS,
  type RuntimeChoice,
  type RuntimeIconProps,
} from "@/browser/utils/runtimeUi";

import type { WorkspaceNameState, WorkspaceNameUIError } from "@/browser/hooks/useWorkspaceName";
import type { CoderInfo } from "@/common/orpc/schemas/coder";
import {
  CoderAvailabilityMessage,
  CoderWorkspaceForm,
  resolveCoderAvailability,
  type CoderAvailabilityState,
  type CoderControlsProps,
} from "../Runtime/CoderControls";

/**
 * Shared styling for inline form controls in the creation UI.
 * Used by both Select and text inputs to ensure visual consistency.
 * Fixed width ensures Select (with chevron) and text inputs render identically.
 */
const INLINE_CONTROL_CLASSES =
  "h-7 w-[140px] rounded border border-border-light bg-transparent px-2 text-xs text-foreground focus:border-accent focus:outline-none disabled:cursor-not-allowed disabled:opacity-50";

const SENTENCE_CLAUSE_CLASSES = "flex w-full min-w-0 items-center gap-2 md:w-auto";

/** Credential sharing checkbox - used by Docker and Devcontainer runtimes */
function CredentialSharingCheckbox(props: {
  checked: boolean;
  onChange: (checked: boolean) => void;
  disabled?: boolean;
  docsPath: string;
}) {
  return (
    <label className="flex items-center gap-1.5 text-xs">
      <input
        type="checkbox"
        checked={props.checked}
        onChange={(e) => props.onChange(e.target.checked)}
        disabled={props.disabled}
        className="accent-accent"
      />
      <span className="text-muted">Share credentials (SSH, Git)</span>
      <DocsLink path={props.docsPath} />
    </label>
  );
}

function NameErrorDisplay(props: { error: Extract<WorkspaceNameUIError, { kind: "generation" }> }) {
  const formatted = formatNameGenerationError(props.error.error);
  return (
    <div className="text-primary rounded border border-red-500/40 bg-red-500/10 px-2 py-1 text-xs">
      <div className="font-medium">{formatted.title}</div>
      <div>{formatted.message}</div>
      {formatted.hint && <div className="text-secondary mt-1">Fix: {formatted.hint}</div>}
      {formatted.docsPath && (
        <DocsLink path={formatted.docsPath} className="mt-1 text-xs">
          Troubleshooting
        </DocsLink>
      )}
    </div>
  );
}

interface CreationControlsProps {
  branches: string[];
  /** Whether branches have finished loading (to distinguish loading vs non-git repo) */
  branchesLoaded: boolean;
  trunkBranch: string;
  onTrunkBranchChange: (branch: string) => void;
  /** Currently selected runtime (discriminated union: SSH has host, Docker has image) */
  selectedRuntime: ParsedRuntime;
  /** Fallback Coder config to restore prior selections. */
  coderConfigFallback: CoderWorkspaceConfig;
  /** Fallback SSH host to restore when leaving Coder. */
  sshHostFallback: string;
  defaultRuntimeMode: RuntimeChoice;
  /** Set the currently selected runtime (discriminated union) */
  onSelectedRuntimeChange: (runtime: ParsedRuntime) => void;
  onSetDefaultRuntime: (mode: RuntimeChoice) => void;
  disabled: boolean;
  /** Owning project path used for runtime/settings scoping (always the parent). */
  projectPath: string;
  /**
   * Path of the project actually selected by the user. May be a sub-project
   * even when {@link projectPath} is its parent, since workspace creation is
   * always owned by the top-level parent. Used for the dropdown's selected
   * value/label so sub-projects render correctly. Falls back to
   * {@link projectPath} when omitted.
   */
  selectedProjectPath?: string;
  /** Stable project data passed by ChatInput so typing does not subscribe this form to broad contexts. */
  userProjects: Map<string, ProjectConfig>;
  onSelectedProjectPathChange: (path: string) => void;
  /** Project name to display as header */
  projectName: string;
  /** Workspace name/title generation state and actions */
  nameState: WorkspaceNameState;
  /** Runtime availability state for each mode */
  runtimeAvailabilityState: RuntimeAvailabilityState;
  /** Runtime enablement toggles from Settings (hide disabled runtimes). */
  runtimeEnablement?: RuntimeEnablement;
  /** Which runtime field (if any) is in error state for visual feedback */
  runtimeFieldError?: "docker" | "ssh" | null;

  /** Policy: allowed runtime modes (null/undefined = allow all) */
  allowedRuntimeModes?: RuntimeMode[] | null;
  /** Policy: allow plain host SSH */
  allowSshHost?: boolean;
  /** Policy: allow Coder-backed SSH */
  allowSshCoder?: boolean;
  /** Optional policy error message to display near runtime controls */
  runtimePolicyError?: string | null;
  /** Coder CLI availability info (null while checking) */
  coderInfo?: CoderInfo | null;
  /** Coder workspace controls props (optional - only rendered when provided) */
  coderProps?: Omit<CoderControlsProps, "disabled">;
}

/** Runtime type button group with icons and colors */
export interface RuntimeButtonGroupProps {
  value: RuntimeChoice;
  onChange: (mode: RuntimeChoice) => void;
  defaultMode: RuntimeChoice;
  onSetDefault: (mode: RuntimeChoice) => void;
  disabled?: boolean;
  runtimeAvailabilityState?: RuntimeAvailabilityState;
  runtimeEnablement?: RuntimeEnablement;
  coderInfo?: CoderInfo | null;
  allowedRuntimeModes?: RuntimeMode[] | null;
  allowSshHost?: boolean;
  allowSshCoder?: boolean;
}

const RUNTIME_CHOICE_ORDER: RuntimeChoice[] = [
  RUNTIME_MODE.LOCAL,
  RUNTIME_MODE.WORKTREE,
  RUNTIME_MODE.SSH,
  "coder",
  RUNTIME_MODE.DOCKER,
  RUNTIME_MODE.DEVCONTAINER,
];

const RUNTIME_FALLBACK_ORDER: RuntimeChoice[] = [
  RUNTIME_MODE.WORKTREE,
  RUNTIME_MODE.LOCAL,
  RUNTIME_MODE.SSH,
  "coder",
  RUNTIME_MODE.DOCKER,
  RUNTIME_MODE.DEVCONTAINER,
];

const RUNTIME_CHOICE_ACCENTS: Record<
  RuntimeChoice,
  {
    triggerClass: string;
    iconClass: string;
    accentColor: string;
  }
> = {
  local: {
    triggerClass:
      "border-[var(--color-runtime-local)]/60 bg-[var(--color-runtime-local)]/15 text-foreground",
    iconClass: "text-[var(--color-runtime-local)]",
    accentColor: "var(--color-runtime-local)",
  },
  worktree: {
    triggerClass:
      "border-[var(--color-runtime-worktree)]/60 bg-[var(--color-runtime-worktree)]/15 text-[var(--color-runtime-worktree-text)]",
    iconClass: "text-[var(--color-runtime-worktree-text)]",
    accentColor: "var(--color-runtime-worktree)",
  },
  ssh: {
    triggerClass:
      "border-[var(--color-runtime-ssh)]/60 bg-[var(--color-runtime-ssh)]/15 text-[var(--color-runtime-ssh-text)]",
    iconClass: "text-[var(--color-runtime-ssh-text)]",
    accentColor: "var(--color-runtime-ssh)",
  },
  coder: {
    triggerClass:
      "border-[var(--color-runtime-ssh)]/60 bg-[var(--color-runtime-ssh)]/15 text-[var(--color-runtime-ssh-text)]",
    iconClass: "text-[var(--color-runtime-ssh-text)]",
    accentColor: "var(--color-runtime-ssh)",
  },
  docker: {
    triggerClass:
      "border-[var(--color-runtime-docker)]/60 bg-[var(--color-runtime-docker)]/15 text-[var(--color-runtime-docker-text)]",
    iconClass: "text-[var(--color-runtime-docker-text)]",
    accentColor: "var(--color-runtime-docker)",
  },
  devcontainer: {
    triggerClass:
      "border-[var(--color-runtime-devcontainer)]/60 bg-[var(--color-runtime-devcontainer)]/15 text-[var(--color-runtime-devcontainer-text)]",
    iconClass: "text-[var(--color-runtime-devcontainer-text)]",
    accentColor: "var(--color-runtime-devcontainer)",
  },
};

const RUNTIME_CHOICE_OPTIONS: Array<{
  value: RuntimeChoice;
  label: string;
  description: string;
  docsPath: string;
  Icon: React.ComponentType<RuntimeIconProps>;
  triggerClass: string;
  iconClass: string;
  accentColor: string;
}> = RUNTIME_CHOICE_ORDER.map((mode) => {
  const ui = RUNTIME_CHOICE_UI[mode];
  const accent = RUNTIME_CHOICE_ACCENTS[mode];

  return {
    value: mode,
    label: ui.label,
    description: ui.description,
    docsPath: ui.docsPath,
    Icon: ui.Icon,
    triggerClass: accent.triggerClass,
    iconClass: accent.iconClass,
    accentColor: accent.accentColor,
  };
});

interface RuntimeButtonState {
  isModeDisabled: boolean;
  isPolicyDisabled: boolean;
  disabledReason?: string;
  isDefault: boolean;
}

const resolveRuntimeButtonState = (
  value: RuntimeChoice,
  availabilityMap: RuntimeAvailabilityMap | null,
  defaultMode: RuntimeChoice,
  coderAvailability: CoderAvailabilityState,
  allowedModeSet: Set<RuntimeMode> | null,
  allowSshHost: boolean,
  allowSshCoder: boolean
): RuntimeButtonState => {
  const isPolicyAllowed = (): boolean => {
    if (!allowedModeSet) {
      return true;
    }

    if (value === "coder") {
      return allowSshCoder;
    }

    if (value === RUNTIME_MODE.SSH) {
      // Host SSH is separate from Coder; block it when policy forbids host SSH.
      return allowSshHost;
    }

    return allowedModeSet.has(value);
  };

  const isPolicyDisabled = !isPolicyAllowed();

  // Coder availability: keep the button disabled with a reason until the CLI is ready.
  if (value === "coder" && coderAvailability.state !== "available") {
    return {
      isModeDisabled: true,
      isPolicyDisabled,
      disabledReason: isPolicyDisabled ? "Disabled by policy" : coderAvailability.reason,
      isDefault: defaultMode === value,
    };
  }

  // Coder is SSH under the hood; all other RuntimeChoice values are RuntimeMode identity.
  const availabilityKey = value === "coder" ? RUNTIME_MODE.SSH : value;
  const availability = availabilityMap?.[availabilityKey];
  // Disable only if availability is explicitly known and unavailable.
  // When availability is undefined (loading or fetch failed), allow selection
  // as fallback - the config picker will validate before creation.
  const isModeDisabled = availability !== undefined && !availability.available;
  const disabledReason = isPolicyDisabled
    ? "Disabled by policy"
    : availability && !availability.available
      ? availability.reason
      : undefined;

  return {
    isModeDisabled,
    isPolicyDisabled,
    disabledReason,
    isDefault: defaultMode === value,
  };
};

export function RuntimeButtonGroup(props: RuntimeButtonGroupProps) {
  const state = props.runtimeAvailabilityState;
  const availabilityMap = state?.status === "loaded" ? state.data : null;
  const coderInfo = props.coderInfo ?? null;
  const coderAvailability = resolveCoderAvailability(coderInfo);
  const runtimeEnablement = props.runtimeEnablement;

  const allowSshHost = props.allowSshHost ?? true;
  const allowSshCoder = props.allowSshCoder ?? true;
  const allowedModeSet = props.allowedRuntimeModes ? new Set(props.allowedRuntimeModes) : null;
  const isSshModeAllowed = !allowedModeSet || allowedModeSet.has(RUNTIME_MODE.SSH);

  const isDevcontainerMissing =
    availabilityMap?.devcontainer?.available === false &&
    availabilityMap.devcontainer.reason === "No devcontainer.json found";
  // Hide devcontainer while loading OR when confirmed missing.
  // Only show when availability is loaded and devcontainer is available.
  // This prevents layout flash for projects without devcontainer.json (the common case).
  const hideDevcontainer = state?.status === "loading" || isDevcontainerMissing;
  // Keep Devcontainer visible when policy requires it so the selector doesn't go empty.
  const isDevcontainerOnlyPolicy =
    allowedModeSet?.size === 1 && allowedModeSet.has(RUNTIME_MODE.DEVCONTAINER);
  const shouldForceShowDevcontainer =
    props.value === RUNTIME_MODE.DEVCONTAINER ||
    (isDevcontainerOnlyPolicy && isDevcontainerMissing);

  // Match devcontainer UX: only surface Coder once availability is confirmed (no flash),
  // but keep it visible when policy requires it or when already selected to avoid an empty selector.
  const shouldForceShowCoder =
    props.value === "coder" || (allowSshCoder && !allowSshHost && isSshModeAllowed);
  const shouldShowCoder = coderAvailability.shouldShowRuntimeButton || shouldForceShowCoder;

  const runtimeVisibilityOverrides: Partial<Record<RuntimeChoice, boolean>> = {
    [RUNTIME_MODE.DEVCONTAINER]: !hideDevcontainer || shouldForceShowDevcontainer,
    coder: shouldShowCoder,
  };

  // Policy filtering keeps forbidden runtimes out of the selector so users don't
  // get stuck with defaults that can never be created.
  const runtimeOptions = RUNTIME_CHOICE_OPTIONS.filter((option) => {
    if (runtimeVisibilityOverrides[option.value] === false) {
      return false;
    }

    // User request: hide Settings-disabled runtimes (selection auto-switches elsewhere).
    // Keep the currently active runtime visible even if disabled to avoid trapping the user
    // when the fallback can't find a replacement (e.g., non-git repo with Local disabled).
    const isEnablementDisabled = runtimeEnablement?.[option.value] === false;
    if (isEnablementDisabled && option.value !== props.value) {
      return false;
    }

    const { isPolicyDisabled } = resolveRuntimeButtonState(
      option.value,
      availabilityMap,
      props.defaultMode,
      coderAvailability,
      allowedModeSet,
      allowSshHost,
      allowSshCoder
    );

    if (isPolicyDisabled && props.value !== option.value) {
      return false;
    }

    return true;
  });

  const selectedOption =
    runtimeOptions.find((option) => option.value === props.value) ?? runtimeOptions[0] ?? null;

  const selectedOptionState = selectedOption
    ? resolveRuntimeButtonState(
        selectedOption.value,
        availabilityMap,
        props.defaultMode,
        coderAvailability,
        allowedModeSet,
        allowSshHost,
        allowSshCoder
      )
    : null;

  const selectedOptionDisabledReason =
    selectedOptionState &&
    (selectedOptionState.isModeDisabled || selectedOptionState.isPolicyDisabled)
      ? selectedOptionState.disabledReason
      : undefined;

  return (
    <div className="flex min-w-0 flex-col gap-1" role="group" aria-label="Runtime type">
      <RadixSelect
        value={selectedOption?.value}
        onValueChange={(value) => {
          const nextOption = runtimeOptions.find((option) => option.value === value);
          if (!nextOption) {
            return;
          }
          props.onChange(nextOption.value);
        }}
        disabled={Boolean(props.disabled) || runtimeOptions.length === 0}
      >
        <Tooltip>
          <TooltipTrigger asChild>
            <SelectTrigger
              aria-label="Workspace type"
              className={cn(
                "h-7 w-full justify-between gap-2 rounded-md border px-2.5 text-xs font-medium shadow-none md:w-[168px]",
                selectedOption?.triggerClass
              )}
            >
              {selectedOption ? (
                <div className="flex min-w-0 flex-1 items-center gap-2">
                  <selectedOption.Icon
                    size={12}
                    className={cn("shrink-0", selectedOption.iconClass)}
                  />
                  <span className="truncate">{selectedOption.label}</span>
                </div>
              ) : (
                <SelectValue placeholder="Select workspace type" />
              )}
            </SelectTrigger>
          </TooltipTrigger>
          {selectedOption ? (
            <TooltipContent align="start" className="max-w-56">
              <div className="flex items-start justify-between gap-3">
                <span className="block max-w-[170px] text-xs leading-snug whitespace-normal">
                  {selectedOption.description}
                </span>
                <DocsLink path={selectedOption.docsPath} />
              </div>
              {selectedOptionDisabledReason ? (
                <p className="mt-1 text-yellow-500">{selectedOptionDisabledReason}</p>
              ) : null}
            </TooltipContent>
          ) : null}
        </Tooltip>
        <SelectContent className="border-border-medium w-[232px]">
          {runtimeOptions.map((option) => {
            const {
              isModeDisabled,
              isPolicyDisabled,
              disabledReason: resolvedDisabledReason,
            } = resolveRuntimeButtonState(
              option.value,
              availabilityMap,
              props.defaultMode,
              coderAvailability,
              allowedModeSet,
              allowSshHost,
              allowSshCoder
            );

            const disabledReason = resolvedDisabledReason;
            const isDisabled = Boolean(props.disabled) || isModeDisabled || isPolicyDisabled;
            const showDisabledReason = isModeDisabled || isPolicyDisabled;
            const Icon = option.Icon;

            return (
              <SelectPrimitive.Item
                key={option.value}
                value={option.value}
                disabled={isDisabled}
                className={cn(
                  "focus:bg-hover data-[state=checked]:bg-hover relative flex cursor-default select-none items-center rounded-sm py-1.5 pr-3 pl-3 text-xs outline-none",
                  "data-[disabled]:pointer-events-none data-[disabled]:opacity-50"
                )}
              >
                <div className="flex min-w-0 items-center gap-2">
                  <Icon size={12} className={cn("shrink-0", option.iconClass)} />
                  <div className="flex w-[164px] min-w-0 flex-col gap-0.5">
                    <SelectPrimitive.ItemText>
                      <span className="text-foreground text-xs font-medium">{option.label}</span>
                    </SelectPrimitive.ItemText>
                    <span className="text-muted line-clamp-2 text-[11px] leading-snug whitespace-normal">
                      {option.description}
                    </span>
                    {showDisabledReason ? (
                      <span className="line-clamp-2 text-[11px] leading-snug whitespace-normal text-yellow-500">
                        {disabledReason ?? "Unavailable"}
                      </span>
                    ) : null}
                  </div>
                </div>
              </SelectPrimitive.Item>
            );
          })}
        </SelectContent>
      </RadixSelect>
    </div>
  );
}

/**
 * Prominent controls shown above the input during workspace creation.
 * Displays project name as header, workspace name with magic wand, and runtime/branch selectors.
 */
function CreationControlsContent(props: CreationControlsProps) {
  usePerfRenderMarker("chat-input.creation-controls");
  const { nameState, runtimeAvailabilityState } = props;

  // Extract mode from discriminated union for convenience
  const runtimeMode = props.selectedRuntime.mode;
  const { selectedRuntime, onSelectedRuntimeChange } = props;
  // Coder is surfaced as a separate runtime option while keeping SSH as the config mode.
  const isCoderSelected =
    selectedRuntime.mode === RUNTIME_MODE.SSH && selectedRuntime.coder != null;
  const runtimeChoice: RuntimeChoice = isCoderSelected ? "coder" : runtimeMode;
  const coderInfo = props.coderInfo ?? props.coderProps?.coderInfo ?? null;
  const coderAvailability = resolveCoderAvailability(coderInfo);
  const isCoderAvailable = coderAvailability.state === "available";
  const coderUsername = coderInfo?.state === "available" ? coderInfo.username : undefined;
  const coderDeploymentUrl = coderInfo?.state === "available" ? coderInfo.url : undefined;

  const availabilityMap =
    runtimeAvailabilityState.status === "loaded" ? runtimeAvailabilityState.data : null;

  // Centralized devcontainer selection logic
  const devcontainerSelection = resolveDevcontainerSelection({
    selectedRuntime,
    availabilityState: runtimeAvailabilityState,
  });

  const isDevcontainerMissing =
    availabilityMap?.devcontainer?.available === false &&
    availabilityMap.devcontainer.reason === "No devcontainer.json found";

  // Check if git is required (worktree unavailable due to git or no branches)
  const isNonGitRepo =
    (availabilityMap?.worktree?.available === false &&
      availabilityMap.worktree.reason === "Requires git repository") ||
    (props.branchesLoaded && props.branches.length === 0);

  const branchOptions =
    props.trunkBranch && !props.branches.includes(props.trunkBranch)
      ? [props.trunkBranch, ...props.branches]
      : props.branches;
  const isBranchSelectorDisabled =
    Boolean(props.disabled) || isNonGitRepo || branchOptions.length === 0;

  // Keep selected runtime aligned with availability + Settings enablement constraints.
  // All constraint checks (non-git, devcontainer missing, enablement, policy) are unified
  // into a single firstEnabled fallback so every edge combination is handled consistently.
  useEffect(() => {
    const runtimeEnablement = props.runtimeEnablement;

    // Determine if the current selection needs correction.
    const isCurrentDisabledBySettings = runtimeEnablement?.[runtimeChoice] === false;
    // In non-git repos all modes except Local are unavailable (not just Worktree).
    const isCurrentUnavailable =
      (isNonGitRepo && selectedRuntime.mode !== RUNTIME_MODE.LOCAL) ||
      (isDevcontainerMissing && selectedRuntime.mode === RUNTIME_MODE.DEVCONTAINER);

    if (!isCurrentDisabledBySettings && !isCurrentUnavailable) {
      return;
    }

    // Build a policy set matching RuntimeButtonGroup's eligibility logic so the
    // auto-switch fallback never lands on a policy-forbidden runtime.
    const allowedModes = props.allowedRuntimeModes
      ? new Set<RuntimeMode>(props.allowedRuntimeModes)
      : null;

    const firstEnabled = RUNTIME_FALLBACK_ORDER.find((mode) => {
      if (runtimeEnablement?.[mode] === false) {
        return false;
      }
      if (mode === "coder") {
        if (!props.coderProps) {
          return false;
        }
        if (!isCoderAvailable) {
          return false;
        }
      }
      // Filter by availability to avoid selecting unavailable runtimes (e.g., Docker
      // when daemon is down, devcontainer when config missing, non-git projects).
      if (isDevcontainerMissing && mode === RUNTIME_MODE.DEVCONTAINER) {
        return false;
      }
      if (isNonGitRepo && mode !== RUNTIME_MODE.LOCAL) {
        return false;
      }
      // Check the general availability map for any other unavailable runtimes.
      if (mode !== "coder") {
        const avail = availabilityMap?.[mode];
        if (avail !== undefined && !avail.available) {
          return false;
        }
      }
      // Filter by policy constraints to avoid selecting a blocked runtime.
      if (allowedModes) {
        if (mode === "coder" && !(props.allowSshCoder ?? true)) {
          return false;
        }
        if (mode === RUNTIME_MODE.SSH && !(props.allowSshHost ?? true)) {
          return false;
        }
        if (mode !== "coder" && mode !== RUNTIME_MODE.SSH && !allowedModes.has(mode)) {
          return false;
        }
      }
      return true;
    });
    if (!firstEnabled || firstEnabled === runtimeChoice) {
      return;
    }

    // User request: auto-switch away from Settings-disabled runtimes.
    if (firstEnabled === "coder") {
      if (!props.coderProps || !isCoderAvailable) {
        return;
      }
      onSelectedRuntimeChange({
        mode: "ssh",
        host: CODER_RUNTIME_PLACEHOLDER,
        coder: props.coderConfigFallback,
      });
      return;
    }

    switch (firstEnabled) {
      case RUNTIME_MODE.SSH: {
        const sshHost =
          selectedRuntime.mode === RUNTIME_MODE.SSH &&
          selectedRuntime.host !== CODER_RUNTIME_PLACEHOLDER
            ? selectedRuntime.host
            : props.sshHostFallback;
        onSelectedRuntimeChange({
          mode: "ssh",
          host: sshHost,
        });
        return;
      }
      case RUNTIME_MODE.DOCKER:
        onSelectedRuntimeChange({
          mode: "docker",
          image: selectedRuntime.mode === "docker" ? selectedRuntime.image : "",
        });
        return;
      case RUNTIME_MODE.DEVCONTAINER: {
        const initialSelection = resolveDevcontainerSelection({
          selectedRuntime: { mode: "devcontainer", configPath: "" },
          availabilityState: runtimeAvailabilityState,
        });
        onSelectedRuntimeChange({
          mode: "devcontainer",
          configPath:
            selectedRuntime.mode === "devcontainer"
              ? selectedRuntime.configPath
              : initialSelection.configPath,
          shareCredentials:
            selectedRuntime.mode === "devcontainer" ? selectedRuntime.shareCredentials : false,
        });
        return;
      }
      case RUNTIME_MODE.LOCAL:
        onSelectedRuntimeChange({ mode: "local" });
        return;
      case RUNTIME_MODE.WORKTREE:
      default:
        onSelectedRuntimeChange({ mode: "worktree" });
        return;
    }
  }, [
    isDevcontainerMissing,
    isNonGitRepo,
    onSelectedRuntimeChange,
    props.coderConfigFallback,
    props.coderProps,
    props.runtimeEnablement,
    props.sshHostFallback,
    props.allowedRuntimeModes,
    props.allowSshHost,
    props.allowSshCoder,
    availabilityMap,
    runtimeAvailabilityState,
    runtimeChoice,
    selectedRuntime,
    isCoderAvailable,
  ]);

  const handleNameChange = useCallback(
    (e: React.ChangeEvent<HTMLInputElement>) => {
      nameState.setName(e.target.value);
    },
    [nameState]
  );

  // Clicking into the input disables auto-generation so user can edit
  const handleInputFocus = useCallback(() => {
    if (nameState.autoGenerate) {
      nameState.setAutoGenerate(false);
    }
  }, [nameState]);

  // Toggle auto-generation via wand button
  const handleWandClick = useCallback(() => {
    nameState.setAutoGenerate(!nameState.autoGenerate);
  }, [nameState]);

  const nameTooltipError =
    nameState.error?.kind === "validation" || nameState.error?.kind === "transport"
      ? nameState.error
      : null;

  return (
    <div className="mb-3 flex flex-col gap-4">
      <div
        className={cn("flex gap-y-2", nameState.error ? "items-start" : "items-center")}
        data-component="WorkspaceNameGroup"
      >
        {(() => {
          // Reflect the actual project the user picked (possibly a sub-project)
          // even though workspace creation is owned by the parent — otherwise
          // selecting "gbot/bbot" would show "gbot" because props.projectPath
          // is normalized to the owning parent for runtime/config scoping.
          const selected = props.selectedProjectPath ?? props.projectPath;
          return (
            <CreationProjectSelect
              selected={selected}
              selectedLabel={formatProjectHierarchyLabel(selected, props.userProjects)}
              options={Array.from(props.userProjects.keys()).map((path) => ({
                value: path,
                label: formatProjectHierarchyLabel(path, props.userProjects),
              }))}
              onChange={props.onSelectedProjectPathChange}
            />
          );
        })()}
        <span className="text-muted-foreground mx-2 text-lg">/</span>

        {/* Keep generation errors stacked with the name field so remediation appears directly below it. */}
        <div className="flex min-w-0 flex-col gap-1" data-component="WorkspaceNameInputBlock">
          {/* Name input with magic wand */}
          <div className="flex items-center gap-1">
            <Tooltip open={nameTooltipError ? true : undefined}>
              <TooltipTrigger asChild>
                <input
                  id="workspace-name"
                  type="text"
                  value={nameState.name}
                  onChange={handleNameChange}
                  onFocus={handleInputFocus}
                  placeholder={nameState.isGenerating ? "Generating..." : "workspace-name"}
                  disabled={props.disabled}
                  aria-invalid={nameState.error ? true : undefined}
                  className={cn(
                    `border-border-medium focus:border-accent h-7 rounded-md
                     border border-transparent bg-transparent text-lg font-semibold 
                     field-sizing-content focus:border focus:bg-bg-dark focus:outline-none 
                     disabled:opacity-50 max-w-[50vw] sm:max-w-[40vw] lg:max-w-[30vw]`,
                    nameState.autoGenerate ? "text-muted" : "text-foreground",
                    // focus:border-red-500 keeps the error border visible while typing;
                    // focus:border-accent would otherwise override it.
                    nameState.error && "border-red-500 focus:border-red-500"
                  )}
                />
              </TooltipTrigger>
              <TooltipContent
                align="start"
                className={cn("max-w-64", nameTooltipError && "border-red-500/40 text-red-500")}
              >
                {nameTooltipError ? (
                  nameTooltipError.message
                ) : (
                  <>
                    Use lowercase letters, numbers, hyphens, underscores, and the <code>/</code>
                    separator. Slashes in git branches map to hyphens in folder and workspace names.
                  </>
                )}
              </TooltipContent>
            </Tooltip>
            {/* Magic wand / loading indicator */}
            {nameState.isGenerating ? (
              <Loader2 className="text-accent h-3.5 w-3.5 shrink-0 animate-spin" />
            ) : (
              <Tooltip>
                <TooltipTrigger asChild>
                  <button
                    type="button"
                    onClick={handleWandClick}
                    disabled={props.disabled}
                    className="flex shrink-0 items-center disabled:opacity-50"
                    aria-label={
                      nameState.autoGenerate ? "Disable auto-naming" : "Enable auto-naming"
                    }
                  >
                    <Wand2
                      className={cn(
                        "h-3.5 w-3.5 transition-colors",
                        nameState.autoGenerate
                          ? "text-accent"
                          : "text-muted-foreground opacity-50 hover:opacity-75"
                      )}
                    />
                  </button>
                </TooltipTrigger>
                <TooltipContent align="center">
                  {nameState.autoGenerate ? "Auto-naming enabled" : "Click to enable auto-naming"}
                </TooltipContent>
              </Tooltip>
            )}
          </div>
          {nameState.error?.kind === "generation" && <NameErrorDisplay error={nameState.error} />}
        </div>
      </div>

      <div className="flex flex-col gap-1.5" data-component="RuntimeTypeGroup">
        <div className="flex flex-wrap items-center gap-x-2 gap-y-2 text-sm">
          <span className="text-muted-foreground shrink-0">This workspace will use</span>
          {/* Workspace Type + Source Branch share a row on mobile */}
          <div className="flex w-full items-center gap-2 md:contents md:w-auto">
            <div className="flex min-w-0 flex-1 items-center gap-1.5 md:flex-initial">
              <label className="sr-only" htmlFor="workspace-type-group">
                Workspace Type
              </label>
              <RuntimeButtonGroup
                value={runtimeChoice}
                onChange={(mode) => {
                  if (mode === "coder") {
                    if (!props.coderProps) {
                      return;
                    }
                    // Switch to SSH mode with the last known Coder config so prior selections restore.
                    onSelectedRuntimeChange({
                      mode: "ssh",
                      host: CODER_RUNTIME_PLACEHOLDER,
                      coder: props.coderConfigFallback,
                    });
                    return;
                  }
                  // Convert mode to ParsedRuntime with appropriate defaults
                  switch (mode) {
                    case RUNTIME_MODE.SSH: {
                      const sshHost =
                        selectedRuntime.mode === "ssh" &&
                        selectedRuntime.host !== CODER_RUNTIME_PLACEHOLDER
                          ? selectedRuntime.host
                          : props.sshHostFallback;
                      onSelectedRuntimeChange({
                        mode: "ssh",
                        host: sshHost,
                      });
                      break;
                    }
                    case RUNTIME_MODE.DOCKER:
                      onSelectedRuntimeChange({
                        mode: "docker",
                        image: selectedRuntime.mode === "docker" ? selectedRuntime.image : "",
                      });
                      break;
                    case RUNTIME_MODE.DEVCONTAINER: {
                      // Use resolver to get initial config path (prefers first available config)
                      const initialSelection = resolveDevcontainerSelection({
                        selectedRuntime: { mode: "devcontainer", configPath: "" },
                        availabilityState: runtimeAvailabilityState,
                      });
                      onSelectedRuntimeChange({
                        mode: "devcontainer",
                        configPath:
                          selectedRuntime.mode === "devcontainer"
                            ? selectedRuntime.configPath
                            : initialSelection.configPath,
                        shareCredentials:
                          selectedRuntime.mode === "devcontainer"
                            ? selectedRuntime.shareCredentials
                            : false,
                      });
                      break;
                    }
                    case RUNTIME_MODE.LOCAL:
                      onSelectedRuntimeChange({ mode: "local" });
                      break;
                    case RUNTIME_MODE.WORKTREE:
                    default:
                      onSelectedRuntimeChange({ mode: "worktree" });
                      break;
                  }
                }}
                defaultMode={props.defaultRuntimeMode}
                onSetDefault={props.onSetDefaultRuntime}
                disabled={props.disabled}
                runtimeAvailabilityState={runtimeAvailabilityState}
                runtimeEnablement={props.runtimeEnablement}
                coderInfo={coderInfo}
                allowedRuntimeModes={props.allowedRuntimeModes}
                allowSshHost={props.allowSshHost}
                allowSshCoder={props.allowSshCoder}
              />
            </div>

            <span className="text-muted-foreground shrink-0">from</span>

            <div
              className="flex min-w-0 flex-1 items-center gap-1.5 md:flex-initial"
              data-component="BranchSelector"
              data-tutorial="trunk-branch"
            >
              <label className="sr-only" htmlFor="source-branch-select">
                Source Branch
              </label>
              <GitBranch className="text-muted-foreground h-3.5 w-3.5 shrink-0" />
              {props.branchesLoaded ? (
                <RadixSelect
                  value={props.trunkBranch}
                  onValueChange={props.onTrunkBranchChange}
                  disabled={isBranchSelectorDisabled}
                >
                  <SelectTrigger
                    className={cn(INLINE_CONTROL_CLASSES, "w-full md:w-[140px]")}
                    aria-label="Select source branch"
                  >
                    <SelectValue placeholder="Select source branch" />
                  </SelectTrigger>
                  <SelectContent className="border-border-medium">
                    {branchOptions.map((branch) => (
                      <SelectItem key={branch} value={branch}>
                        {branch}
                      </SelectItem>
                    ))}
                  </SelectContent>
                </RadixSelect>
              ) : (
                <Skeleton className="h-7 w-full rounded md:w-[140px]" />
              )}
            </div>
          </div>
          {/* end mobile row wrapper */}

          {selectedRuntime.mode === "ssh" &&
            !isCoderSelected &&
            (props.allowSshHost ?? true) &&
            !props.coderProps?.enabled &&
            // Also hide when Coder is still checking but has saved config (will enable after check)
            !(props.coderProps?.coderInfo === null && props.coderProps?.coderConfig) && (
              <div className={SENTENCE_CLAUSE_CLASSES}>
                <span className="text-muted-foreground shrink-0">on host</span>
                <RuntimeConfigInput
                  id="ssh-host"
                  fieldSpec={RUNTIME_OPTION_FIELDS.ssh}
                  value={selectedRuntime.host}
                  onChange={(value) => onSelectedRuntimeChange({ mode: "ssh", host: value })}
                  disabled={props.disabled}
                  hasError={props.runtimeFieldError === "ssh"}
                  className="min-w-0 flex-1 md:flex-initial"
                  labelClassName="sr-only"
                  inputClassName={cn(INLINE_CONTROL_CLASSES, "w-full md:w-[160px]")}
                />
              </div>
            )}

          {selectedRuntime.mode === "docker" && (
            <div className={SENTENCE_CLAUSE_CLASSES}>
              <span className="text-muted-foreground shrink-0">with image</span>
              <RuntimeConfigInput
                fieldSpec={RUNTIME_OPTION_FIELDS.docker}
                value={selectedRuntime.image}
                onChange={(value) =>
                  onSelectedRuntimeChange({
                    mode: "docker",
                    image: value,
                    shareCredentials: selectedRuntime.shareCredentials,
                  })
                }
                disabled={props.disabled}
                hasError={props.runtimeFieldError === "docker"}
                id="docker-image"
                ariaLabel="Docker image"
                className="min-w-0 flex-1 md:flex-initial"
                labelClassName="sr-only"
                inputClassName={cn(INLINE_CONTROL_CLASSES, "w-full md:w-[160px]")}
              />
            </div>
          )}
        </div>

        {props.runtimePolicyError && (
          // Explain why send is blocked when policy forbids the selected runtime.
          <p className="text-xs text-red-500">{props.runtimePolicyError}</p>
        )}

        {/* Dev container controls - config dropdown/input + credential sharing */}
        {selectedRuntime.mode === "devcontainer" && devcontainerSelection.uiMode !== "hidden" && (
          <div className="border-border-medium flex w-fit flex-col gap-1.5 rounded-md border p-2">
            <div className="flex flex-col gap-1">
              <label className="text-muted-foreground text-xs">
                {RUNTIME_OPTION_FIELDS.devcontainer.label}
              </label>
              {devcontainerSelection.uiMode === "loading" ? (
                // Skeleton placeholder while loading - matches dropdown dimensions
                <Skeleton className="h-6 w-[280px] rounded-md" />
              ) : devcontainerSelection.uiMode === "dropdown" ? (
                <RadixSelect
                  value={devcontainerSelection.configPath}
                  onValueChange={(value: string) =>
                    onSelectedRuntimeChange({
                      mode: "devcontainer",
                      configPath: value,
                      shareCredentials: selectedRuntime.shareCredentials,
                    })
                  }
                  disabled={props.disabled}
                >
                  <SelectTrigger
                    className="h-6 w-[280px] text-xs"
                    aria-label="Dev container config"
                  >
                    <SelectValue placeholder="Select config" />
                  </SelectTrigger>
                  <SelectContent>
                    {devcontainerSelection.configs.map((config) => (
                      <SelectItem key={config.path} value={config.path}>
                        {config.label}
                      </SelectItem>
                    ))}
                  </SelectContent>
                </RadixSelect>
              ) : (
                <input
                  type="text"
                  value={devcontainerSelection.configPath}
                  onChange={(e) =>
                    onSelectedRuntimeChange({
                      mode: "devcontainer",
                      configPath: e.target.value,
                      shareCredentials: selectedRuntime.shareCredentials,
                    })
                  }
                  placeholder={DEFAULT_DEVCONTAINER_CONFIG_PATH}
                  disabled={props.disabled}
                  className={cn(
                    "bg-bg-dark text-foreground border-border-medium focus:border-accent h-7 w-[280px] rounded-md border px-2 text-xs focus:outline-none disabled:opacity-50"
                  )}
                  aria-label="Dev container config path"
                />
              )}
            </div>
            {devcontainerSelection.helperText && (
              <p className="text-muted-foreground text-xs">{devcontainerSelection.helperText}</p>
            )}
            <CredentialSharingCheckbox
              checked={selectedRuntime.shareCredentials ?? false}
              onChange={(checked) =>
                onSelectedRuntimeChange({
                  mode: "devcontainer",
                  configPath: devcontainerSelection.configPath,
                  shareCredentials: checked,
                })
              }
              disabled={props.disabled}
              docsPath="/runtime/docker#credential-sharing"
            />
          </div>
        )}

        {/* Credential sharing - separate row for consistency with Coder controls */}
        {selectedRuntime.mode === "docker" && (
          <CredentialSharingCheckbox
            checked={selectedRuntime.shareCredentials ?? false}
            onChange={(checked) =>
              onSelectedRuntimeChange({
                mode: "docker",
                image: selectedRuntime.image,
                shareCredentials: checked,
              })
            }
            disabled={props.disabled}
            docsPath="/runtime/docker#credential-sharing"
          />
        )}

        {/* Coder Controls - shown when Coder runtime is selected */}
        {isCoderSelected && props.coderProps && (
          <div className="flex flex-col gap-1.5" data-testid="coder-controls">
            {/* Coder runtime needs availability status without the SSH-only toggle. */}
            <CoderAvailabilityMessage coderInfo={props.coderProps.coderInfo} />
            {props.coderProps.enabled && (
              <>
                <CoderWorkspaceForm
                  coderConfig={props.coderProps.coderConfig}
                  username={coderUsername}
                  deploymentUrl={coderDeploymentUrl}
                  onCoderConfigChange={props.coderProps.onCoderConfigChange}
                  templates={props.coderProps.templates}
                  templatesError={props.coderProps.templatesError}
                  presets={props.coderProps.presets}
                  presetsError={props.coderProps.presetsError}
                  existingWorkspaces={props.coderProps.existingWorkspaces}
                  workspacesError={props.coderProps.workspacesError}
                  loadingTemplates={props.coderProps.loadingTemplates}
                  loadingPresets={props.coderProps.loadingPresets}
                  loadingWorkspaces={props.coderProps.loadingWorkspaces}
                  disabled={props.disabled}
                  hasError={props.runtimeFieldError === "ssh"}
                />
              </>
            )}
          </div>
        )}
      </div>
    </div>
  );
}

// ChatInput is not currently compiler-eligible because of its async control flow,
// so keep this small wrapper compiler-friendly and pass every dependency explicitly.
// React Compiler then retains the expensive control tree while draft text changes.
export function CreationControls(props: CreationControlsProps) {
  const coderEnabled = props.coderProps?.enabled;
  const coderOnEnabledChange = props.coderProps?.onEnabledChange;
  const coderInfo = props.coderProps?.coderInfo;
  const coderConfig = props.coderProps?.coderConfig;
  const coderOnConfigChange = props.coderProps?.onCoderConfigChange;
  const coderTemplates = props.coderProps?.templates;
  const coderTemplatesError = props.coderProps?.templatesError;
  const coderPresets = props.coderProps?.presets;
  const coderPresetsError = props.coderProps?.presetsError;
  const coderExistingWorkspaces = props.coderProps?.existingWorkspaces;
  const coderWorkspacesError = props.coderProps?.workspacesError;
  const coderLoadingTemplates = props.coderProps?.loadingTemplates;
  const coderLoadingPresets = props.coderProps?.loadingPresets;
  const coderLoadingWorkspaces = props.coderProps?.loadingWorkspaces;
  const hasCoderProps = props.coderProps != null;
  const coderProps = !hasCoderProps
    ? undefined
    : {
        enabled: coderEnabled ?? false,
        onEnabledChange: coderOnEnabledChange!,
        coderInfo: coderInfo ?? null,
        coderConfig: coderConfig ?? null,
        onCoderConfigChange: coderOnConfigChange!,
        templates: coderTemplates ?? [],
        templatesError: coderTemplatesError ?? null,
        presets: coderPresets ?? [],
        presetsError: coderPresetsError ?? null,
        existingWorkspaces: coderExistingWorkspaces ?? [],
        workspacesError: coderWorkspacesError ?? null,
        loadingTemplates: coderLoadingTemplates ?? false,
        loadingPresets: coderLoadingPresets ?? false,
        loadingWorkspaces: coderLoadingWorkspaces ?? false,
      };
  const runtimeLocal = props.runtimeEnablement?.local;
  const runtimeWorktree = props.runtimeEnablement?.worktree;
  const runtimeSsh = props.runtimeEnablement?.ssh;
  const runtimeCoder = props.runtimeEnablement?.coder;
  const runtimeDocker = props.runtimeEnablement?.docker;
  const runtimeDevcontainer = props.runtimeEnablement?.devcontainer;
  const hasRuntimeEnablement = props.runtimeEnablement != null;
  const runtimeEnablement = !hasRuntimeEnablement
    ? undefined
    : {
        local: runtimeLocal ?? true,
        worktree: runtimeWorktree ?? true,
        ssh: runtimeSsh ?? true,
        coder: runtimeCoder ?? true,
        docker: runtimeDocker ?? true,
        devcontainer: runtimeDevcontainer ?? true,
      };
  const nameState = {
    name: props.nameState.name,
    title: props.nameState.title,
    isGenerating: props.nameState.isGenerating,
    autoGenerate: props.nameState.autoGenerate,
    error: props.nameState.error,
    setAutoGenerate: props.nameState.setAutoGenerate,
    setName: props.nameState.setName,
  };

  return (
    <CreationControlsContent
      branches={props.branches}
      branchesLoaded={props.branchesLoaded}
      trunkBranch={props.trunkBranch}
      onTrunkBranchChange={props.onTrunkBranchChange}
      selectedRuntime={props.selectedRuntime}
      coderConfigFallback={props.coderConfigFallback}
      sshHostFallback={props.sshHostFallback}
      defaultRuntimeMode={props.defaultRuntimeMode}
      onSelectedRuntimeChange={props.onSelectedRuntimeChange}
      onSetDefaultRuntime={props.onSetDefaultRuntime}
      disabled={props.disabled}
      projectPath={props.projectPath}
      selectedProjectPath={props.selectedProjectPath}
      userProjects={props.userProjects}
      onSelectedProjectPathChange={props.onSelectedProjectPathChange}
      projectName={props.projectName}
      nameState={nameState}
      runtimeAvailabilityState={props.runtimeAvailabilityState}
      runtimeEnablement={runtimeEnablement}
      runtimeFieldError={props.runtimeFieldError}
      allowedRuntimeModes={props.allowedRuntimeModes}
      allowSshHost={props.allowSshHost}
      allowSshCoder={props.allowSshCoder}
      runtimePolicyError={props.runtimePolicyError}
      coderInfo={props.coderInfo}
      coderProps={coderProps}
    />
  );
}

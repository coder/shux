import { THEME_OPTIONS, type ThemePreference } from "@/browser/contexts/ThemeContext";
import type { OpenSettingsOptions } from "@/browser/contexts/SettingsContext";
import type { CommandAction } from "@/browser/contexts/CommandRegistryContext";
import type { APIClient } from "@/browser/contexts/API";
import type { ConfirmDialogOptions } from "@/browser/contexts/ConfirmDialogContext";
import { getContextResetSuccessMessage } from "@/browser/utils/contextResetFeedback";
import { formatKeybind, KEYBINDS } from "@/browser/utils/ui/keybinds";
import type { PinnedMoveDirection } from "@/browser/utils/ui/pinnedReorder";
import {
  THINKING_LEVELS,
  type OpenAIReasoningMode,
  type ThinkingLevel,
} from "@/common/types/thinking";
import type { ProvidersConfigMap } from "@/common/orpc/types";
import { normalizeToCanonical } from "@/common/utils/ai/models";
import { getFastModeProvider } from "@/browser/utils/fastModeServiceTier";
import { openaiProModeAvailable } from "@/common/utils/ai/proMode";
import {
  enforceThinkingPolicy,
  getAvailableThinkingLevels,
  resolveMinimumThinkingLevel,
} from "@/common/utils/thinking/policy";
import assert from "@/common/utils/assert";
import { isWorkspacePinnable, isWorkspacePinned } from "@/common/utils/pin";
import { CUSTOM_EVENTS, createCustomEvent } from "@/common/constants/events";
import {
  DEFAULT_TERMINAL_BADGE_CONFIG,
  RIGHT_SIDEBAR_COLLAPSED_KEY,
  SIDEBAR_HIDE_SUBAGENTS_KEY,
  SIDEBAR_FLAT_MODE_KEY,
  TERMINAL_BADGE_CONFIG_KEY,
  normalizeTerminalBadgeConfig,
  type TerminalBadgeConfig,
} from "@/common/constants/storage";
import { readPersistedState, updatePersistedState } from "@/browser/hooks/usePersistedState";
import { CommandIds } from "@/browser/utils/commandIds";
import { publishAgentPluginsMutated } from "@/browser/utils/agentPluginMutations";
import { stopStream } from "@/browser/utils/stopStream";
import { publishPluginsSectionIntent } from "@/browser/features/Settings/Sections/pluginsSectionIntents";
import { isTabType, type TabType } from "@/browser/types/rightSidebar";
import {
  getOrderedBaseTabIds,
  getTabConfig,
  type BaseTabType,
} from "@/browser/features/RightSidebar/Tabs/tabConfig";
import {
  getEffectiveSlotKeybind,
  getLayoutsConfigOrDefault,
  getPresetForSlot,
} from "@/browser/utils/uiLayouts";
import { formatProjectHierarchyLabel, getTopLevelProjectEntries } from "@/common/utils/subProjects";
import type { LayoutPresetsConfig, LayoutSlotNumber } from "@/common/types/uiLayouts";
import {
  addToolToFocusedTabset,
  hasTab,
  selectTabInTabset,
  setFocusedTabset,
  splitFocusedTabset,
  toggleTab,
  type RightSidebarLayoutState,
} from "@/browser/utils/rightSidebarLayout";
import {
  readRightSidebarLayout,
  updateRightSidebarLayout,
} from "@/browser/utils/rightSidebarTabFocus";

import type { ProjectConfig } from "@/node/config";
import type { FrontendWorkspaceMetadata } from "@/common/types/workspace";
import type { BranchListResult } from "@/common/orpc/types";
import type { WorkspaceState } from "@/browser/stores/WorkspaceStore";
import type { RuntimeConfig } from "@/common/types/runtime";
import type { UpdateChannel } from "@/common/types/project";
import { isGoalPendingPersistence, type GoalSetError, type GoalStatus } from "@/common/types/goal";
import { GOAL_OBJECTIVE_PLACEHOLDER } from "@/constants/goals";
import { UPDATE_CHANNEL_LABELS } from "@/constants/updateChannels";
import { hasWorkspaceRepository } from "@/browser/utils/workspaceCapabilities";
import { getErrorMessage } from "@/common/utils/errors";
import { parseGoalBudgetCents } from "@/browser/utils/slashCommands/registry";
import { setGoalWithConflictRetry } from "@/browser/utils/goals/setGoalWithConflictRetry";
import { loadGoalDefaults, resolveGoalSetIntent } from "@/browser/utils/goals/resolveGoalSetIntent";
import {
  hasGoalBudgetLimit,
  modelHasPricingData,
  UNPRICED_CURRENT_MODEL_GOAL_MESSAGE,
} from "@/common/utils/goals/budgetPricing";
import { getSendOptionsFromStorage } from "@/browser/utils/messages/sendOptions";

export interface BuildSourcesParams {
  api: APIClient | null;
  supportedUpdateChannels: readonly UpdateChannel[];
  userProjects: Map<string, ProjectConfig>;
  /** Map of workspace ID to workspace metadata (keyed by metadata.id, not path) */
  workspaceMetadata: Map<string, FrontendWorkspaceMetadata>;
  /** In-app confirmation dialog (replaces window.confirm) */
  confirmDialog: (opts: ConfirmDialogOptions) => Promise<boolean>;
  themePreference: ThemePreference;
  selectedWorkspaceState?: WorkspaceState | null;
  selectedWorkspace: {
    projectPath: string;
    projectName: string;
    namedWorkspacePath: string;
    workspaceId: string;
  } | null;
  /** Project-scoped preference ID used while a creation composer is active. */
  creationScopeId?: string | null;
  streamingModels?: Map<string, string>;
  // UI actions
  getThinkingLevel: (workspaceId: string) => ThinkingLevel;
  onSetThinkingLevel: (workspaceId: string, level: ThinkingLevel) => void;
  getReasoningMode: (workspaceId: string) => OpenAIReasoningMode;
  onToggleReasoningMode: (workspaceId: string) => void;
  getFastMode: () => boolean;
  onToggleFastMode: () => void | Promise<void>;
  /** Effective model currently displayed by the workspace or creation composer. */
  getEffectiveComposerModel: (scopeId: string) => string;
  /** Providers config for route-aware provider-option availability. */
  providersConfig?: ProvidersConfigMap | null;
  /** Settings-resolved route for a canonical model ("direct" = no gateway). */
  getRouteForModel?: (canonicalModel: string) => string;
  getEffectiveRouteForModel?: (modelString: string) => string;
  /**
   * Explicit per-model minimum thinking override (undefined → built-in default floor).
   * Used to hide off/low from the "Set Thinking Effort" picker, matching the selector.
   */
  getMinThinkingOverride?: (modelString: string) => ThinkingLevel | null | undefined;

  onStartScratchCreation: () => void;
  onStartWorkspaceCreation: (projectPath: string) => void;
  onStartMultiProjectWorkspaceCreation: () => void;
  multiProjectWorkspacesEnabled: boolean;
  /** agent-plugins experiment: gates the Settings → Plugins palette entry. */
  agentPluginsEnabled: boolean;
  onArchiveMergedWorkspacesInProject: (projectPath: string) => Promise<void>;
  getBranchesForProject: (projectPath: string) => Promise<BranchListResult>;
  onSelectWorkspace: (sel: {
    projectPath: string;
    projectName: string;
    namedWorkspacePath: string;
    workspaceId: string;
  }) => void;
  onRemoveWorkspace: (workspaceId: string) => Promise<{ success: boolean; error?: string }>;
  onUpdateTitle: (
    workspaceId: string,
    newName: string
  ) => Promise<{ success: boolean; error?: string }>;
  onAddProject: () => void;
  onRemoveProject: (path: string) => void;
  onToggleSidebar: () => void;
  onNavigateWorkspace: (dir: "next" | "prev") => void;
  onMovePinnedChat: (direction: PinnedMoveDirection) => void;
  onOpenWorkspaceInTerminal: (workspaceId: string, runtimeConfig?: RuntimeConfig) => void;
  onToggleTheme: () => void;
  onSetTheme: (theme: ThemePreference) => void;
  onOpenSettings?: (section?: string, options?: OpenSettingsOptions) => void;
  onOpenAbout?: () => void;

  // Layout slots
  layoutPresets?: LayoutPresetsConfig | null;
  onApplyLayoutSlot?: (workspaceId: string, slot: LayoutSlotNumber) => void;
  onCaptureLayoutSlot?: (
    workspaceId: string,
    slot: LayoutSlotNumber,
    name: string
  ) => Promise<void>;
  onClearTimingStats?: (workspaceId: string) => void;
}

/**
 * Command palette section names
 * Exported for use in filtering and command organization
 */
export const COMMAND_SECTIONS = {
  WORKSPACES: "Workspaces",
  LAYOUTS: "Layouts",
  NAVIGATION: "Navigation",
  CHAT: "Chat",
  MODE: "Modes & Model",
  HELP: "Help",
  PROJECTS: "Projects",
  APPEARANCE: "Appearance",
  SETTINGS: "Settings",
  GOALS: "Goals",
} as const;

const section = {
  layouts: COMMAND_SECTIONS.LAYOUTS,
  workspaces: COMMAND_SECTIONS.WORKSPACES,
  navigation: COMMAND_SECTIONS.NAVIGATION,
  chat: COMMAND_SECTIONS.CHAT,
  appearance: COMMAND_SECTIONS.APPEARANCE,
  mode: COMMAND_SECTIONS.MODE,
  help: COMMAND_SECTIONS.HELP,
  projects: COMMAND_SECTIONS.PROJECTS,
  settings: COMMAND_SECTIONS.SETTINGS,
  goals: COMMAND_SECTIONS.GOALS,
};

function toFileUrl(filePath: string): string {
  const normalized = filePath.replace(/\\/g, "/");

  // Windows drive letter paths: C:/...
  if (/^[A-Za-z]:\//.test(normalized)) {
    return `file:///${encodeURI(normalized)}`;
  }

  // POSIX absolute paths: /...
  if (normalized.startsWith("/")) {
    return `file://${encodeURI(normalized)}`;
  }

  // Fall back to treating the string as a path-ish URL segment.
  return `file://${encodeURI(normalized)}`;
}

interface AnalyticsRebuildNamespace {
  rebuildDatabase?: (
    input: Record<string, never>
  ) => Promise<{ success: boolean; workspacesIngested: number }>;
}

const getAnalyticsRebuildDatabase = (
  api: APIClient | null
): AnalyticsRebuildNamespace["rebuildDatabase"] | null => {
  const candidate = (api as { analytics?: unknown } | null)?.analytics;
  if (!candidate || (typeof candidate !== "object" && typeof candidate !== "function")) {
    return null;
  }

  const rebuildDatabase = (candidate as AnalyticsRebuildNamespace).rebuildDatabase;
  return typeof rebuildDatabase === "function" ? rebuildDatabase : null;
};

// Serializes Toggle Usage Telemetry read-modify-writes: palette invocations
// start actions without awaiting them, so two rapid toggles would otherwise
// both read the same value and write the same inverse, collapsing two
// requested transitions into one. Each queued run observes its predecessor's
// persisted result.
let telemetryTogglePending: Promise<void> = Promise.resolve();

const showCommandFeedbackToast = (feedback: {
  type: "success" | "error";
  message: string;
  title?: string;
}) => {
  if (typeof window === "undefined") {
    return;
  }

  // Analytics view does not mount ChatInput, so keep a basic alert fallback
  // for command palette actions that need user feedback.
  const hasChatInputToastHost =
    typeof document !== "undefined" &&
    document.querySelector('[data-component="ChatInputSection"]') !== null;

  if (hasChatInputToastHost) {
    window.dispatchEvent(createCustomEvent(CUSTOM_EVENTS.ANALYTICS_REBUILD_TOAST, feedback));
    return;
  }

  const alertMessage = feedback.title
    ? `${feedback.title}\n\n${feedback.message}`
    : feedback.message;
  if (typeof window.alert === "function") {
    window.alert(alertMessage);
  }
};

const findFirstTerminalSessionTab = (
  node: RightSidebarLayoutState["root"]
): { tabsetId: string; tab: TabType } | null => {
  if (node.type === "tabset") {
    const tab = node.tabs.find((t) => t.startsWith("terminal:") && t !== "terminal");
    return tab ? { tabsetId: node.id, tab } : null;
  }

  return (
    findFirstTerminalSessionTab(node.children[0]) ?? findFirstTerminalSessionTab(node.children[1])
  );
};

/**
 * Build a "Hide/Show <Name>" command for a config-defined tab.
 *
 * Each command-source factory is re-invoked per palette render, so the
 * Hide/Show title is up-to-date without any explicit subscription wiring.
 *
 * This is secondary discoverability only; default visibility is controlled by
 * `inDefaultLayout` in `tabConfig.ts` and enforced by the layout migration.
 */
function buildToggleTabCommand(
  workspaceId: string,
  tabId: BaseTabType,
  navigationSection: CommandAction["section"]
): CommandAction {
  const reg = getTabConfig(tabId);
  const visible = hasTab(readRightSidebarLayout(workspaceId), tabId as TabType);
  return {
    id: `nav:toggle-tab:${tabId}`,
    title: `${visible ? "Hide" : "Show"} ${reg.name}`,
    section: navigationSection,
    keywords: reg.paletteKeywords ?? [tabId],
    run: () => {
      updateRightSidebarLayout(workspaceId, (s) => toggleTab(s, tabId as TabType));
      if (!visible) {
        updatePersistedState<boolean>(RIGHT_SIDEBAR_COLLAPSED_KEY, false);
      }
    },
  };
}

function getGoalSetErrorMessage(error: GoalSetError): string {
  if (error.type === "goal_conflict") {
    return "Goal changed in another window. Please try again.";
  }
  return error.message;
}

interface GoalPaletteSetGoalInput {
  objective?: string;
  // Palette commands only ever request user-facing transitions (pause, resume,
  // complete); `budget_limited` is internal-only and is now excluded from the
  // public oRPC `setGoal` input shape (Coder-agents-review nit DEREM-53).
  status?: Exclude<GoalStatus, "budget_limited">;
  budgetCents?: number | null;
  turnCap?: number | null;
  completionSummary?: string;
}

function canSetBudgetedGoalWithCurrentPaletteModel(
  workspaceId: string,
  selectedWorkspaceState: WorkspaceState | null | undefined,
  budgetCents: number | null,
  providersConfig: unknown
): boolean {
  if (!hasGoalBudgetLimit(budgetCents)) {
    return true;
  }
  const selectedModel =
    typeof window === "undefined"
      ? (selectedWorkspaceState?.currentModel ?? "")
      : getSendOptionsFromStorage(workspaceId).model;
  return selectedModel.length === 0 || modelHasPricingData(selectedModel, providersConfig);
}

function showUnpricedCurrentModelGoalFeedback(): void {
  showCommandFeedbackToast({
    type: "error",
    message: UNPRICED_CURRENT_MODEL_GOAL_MESSAGE,
  });
}

async function requireGoalSetSuccess(
  api: APIClient,
  workspaceId: string,
  input: GoalPaletteSetGoalInput
): Promise<boolean> {
  // Shared retry helper centralized in `@/browser/utils/goals/` to avoid the
  // three-way drift Coder-agents-review P3 DEREM-25 flagged.
  const result = await setGoalWithConflictRetry(api, workspaceId, input);
  if (!result.success) {
    showCommandFeedbackToast({ type: "error", message: getGoalSetErrorMessage(result.error) });
    return false;
  }
  return true;
}

function openGoalPanel(workspaceId: string, openCompleteInput = false): void {
  if (typeof window === "undefined" || typeof window.dispatchEvent !== "function") {
    return;
  }
  window.dispatchEvent(
    createCustomEvent(CUSTOM_EVENTS.OPEN_GOAL_TAB, { workspaceId, openCompleteInput })
  );
}
export function buildCoreSources(p: BuildSourcesParams): Array<() => CommandAction[]> {
  const actions: Array<() => CommandAction[]> = [];

  // NOTE: We intentionally route to the chat-based creation flow instead of
  // building a separate prompt. This keeps `/new`, keybinds, and the command
  // palette perfectly aligned on one experience.
  const createWorkspaceForSelectedProjectAction = (
    selected: NonNullable<BuildSourcesParams["selectedWorkspace"]>
  ): CommandAction => {
    const metadata = p.workspaceMetadata.get(selected.workspaceId);
    const targetProjectPath = metadata?.subProjectPath ?? selected.projectPath;
    const targetProjectLabel = formatProjectHierarchyLabel(targetProjectPath, p.userProjects);
    return {
      id: CommandIds.workspaceNew(),
      title: "Create New Workspace…",
      subtitle: `for ${targetProjectLabel}`,
      section: section.workspaces,
      shortcutHint: formatKeybind(KEYBINDS.NEW_WORKSPACE),
      run: () => p.onStartWorkspaceCreation(targetProjectPath),
    };
  };

  // Workspaces
  actions.push(() => {
    const list: CommandAction[] = [];

    list.push({
      id: CommandIds.workspaceNewScratch(),
      title: "New Scratch Chat",
      subtitle: "Start a chat without selecting a project",
      section: section.workspaces,
      shortcutHint: formatKeybind(KEYBINDS.NEW_SCRATCH_CHAT),
      run: p.onStartScratchCreation,
    });

    const selected = p.selectedWorkspace;
    // For scratch chats, selected.projectPath is the app-managed workdir (not
    // a configured project), so the generic action would create a workspace in
    // an unrelated project; New Scratch Chat above already covers creation.
    if (selected && p.workspaceMetadata.get(selected.workspaceId)?.kind !== "scratch") {
      list.push(createWorkspaceForSelectedProjectAction(selected));
    }

    // Switch to workspace
    // Iterate through all workspace metadata (now keyed by workspace ID)
    for (const meta of p.workspaceMetadata.values()) {
      const isCurrent = selected?.workspaceId === meta.id;
      const isStreaming = p.streamingModels?.has(meta.id) ?? false;
      // Title is primary (if set), name is secondary identifier
      const primaryLabel = meta.title ?? meta.name;
      const secondaryParts = [meta.name, meta.projectName];
      if (isStreaming) secondaryParts.push("streaming");
      list.push({
        id: CommandIds.workspaceSwitch(meta.id),
        title: `${isCurrent ? "• " : ""}${primaryLabel}`,
        subtitle: secondaryParts.join(" · "),
        section: section.workspaces,
        keywords: [meta.name, meta.projectName, meta.namedWorkspacePath, meta.title].filter(
          (k): k is string => !!k
        ),
        run: () =>
          p.onSelectWorkspace({
            projectPath: meta.projectPath,
            projectName: meta.projectName,
            namedWorkspacePath: meta.namedWorkspacePath,
            workspaceId: meta.id,
          }),
      });
    }

    // Remove current workspace (rename action intentionally omitted until we add a proper modal)
    if (selected?.namedWorkspacePath) {
      const workspaceDisplayName = `${selected.projectName}/${selected.namedWorkspacePath.split("/").pop() ?? selected.namedWorkspacePath}`;
      const selectedMeta = p.workspaceMetadata.get(selected.workspaceId);
      list.push({
        id: CommandIds.workspaceOpenTerminalCurrent(),
        title: "New Terminal Window",
        subtitle: workspaceDisplayName,
        section: section.workspaces,
        // Note: Cmd/Ctrl+T opens integrated terminal in sidebar (not shown here since this opens a popout)
        run: () => {
          p.onOpenWorkspaceInTerminal(selected.workspaceId, selectedMeta?.runtimeConfig);
        },
      });
      list.push({
        id: CommandIds.workspaceRemove(),
        title: "Remove Current Workspace…",
        subtitle: workspaceDisplayName,
        section: section.workspaces,
        run: async () => {
          const branchName =
            selectedMeta?.name ??
            selected.namedWorkspacePath.split("/").pop() ??
            selected.namedWorkspacePath;
          const ok = await p.confirmDialog({
            title: "Remove current workspace?",
            description: `This will delete the worktree and local branch "${branchName}".`,
            warning: "This cannot be undone.",
            confirmLabel: "Remove",
            confirmVariant: "destructive",
          });
          if (ok) await p.onRemoveWorkspace(selected.workspaceId);
        },
      });
      list.push({
        id: CommandIds.workspaceEditTitle(),
        title: "Edit Current Workspace Title…",
        subtitle: workspaceDisplayName,
        shortcutHint: formatKeybind(KEYBINDS.EDIT_WORKSPACE_TITLE),
        section: section.workspaces,
        run: () => undefined,
        prompt: {
          title: "Edit Workspace Title",
          fields: [
            {
              type: "text",
              name: "newTitle",
              label: "New title",
              placeholder: "Enter new workspace title",
              initialValue:
                p.workspaceMetadata.get(selected.workspaceId)?.title ??
                p.workspaceMetadata.get(selected.workspaceId)?.name ??
                "",
              getInitialValue: () => {
                const current = p.workspaceMetadata.get(selected.workspaceId);
                return current?.title ?? current?.name ?? "";
              },
              validate: (v) => (!v.trim() ? "Title is required" : null),
            },
          ],
          onSubmit: async (vals) => {
            await p.onUpdateTitle(selected.workspaceId, vals.newTitle.trim());
          },
        },
      });
      list.push({
        id: CommandIds.workspaceGenerateTitle(),
        title: "Generate New Title for Current Workspace",
        subtitle: workspaceDisplayName,
        shortcutHint: formatKeybind(KEYBINDS.GENERATE_WORKSPACE_TITLE),
        section: section.workspaces,
        run: () => {
          window.dispatchEvent(
            createCustomEvent(CUSTOM_EVENTS.WORKSPACE_GENERATE_TITLE_REQUESTED, {
              workspaceId: selected.workspaceId,
            })
          );
        },
      });
      // Only live root chats are pinnable (sub-agents follow their pinned parent).
      if (selectedMeta && isWorkspacePinnable(selectedMeta)) {
        const pinned = isWorkspacePinned(selectedMeta);
        list.push({
          id: CommandIds.workspaceTogglePinned(),
          title: pinned ? "Unpin Current Chat" : "Pin Current Chat",
          subtitle: workspaceDisplayName,
          shortcutHint: formatKeybind(KEYBINDS.PIN_WORKSPACE),
          section: section.workspaces,
          run: async () => {
            if (!p.api) return;
            await p.api.workspace.setPinned({
              workspaceId: selected.workspaceId,
              pinned: !pinned,
            });
          },
        });
        if (pinned) {
          // Edge positions are handled inside the move handler (no-op), so the
          // commands stay listed whenever the chat is pinned.
          list.push({
            id: CommandIds.workspaceMovePinnedUp(),
            title: "Move Pinned Chat Up",
            subtitle: workspaceDisplayName,
            shortcutHint: formatKeybind(KEYBINDS.MOVE_PINNED_UP),
            section: section.workspaces,
            run: () => p.onMovePinnedChat("up"),
          });
          list.push({
            id: CommandIds.workspaceMovePinnedDown(),
            title: "Move Pinned Chat Down",
            subtitle: workspaceDisplayName,
            shortcutHint: formatKeybind(KEYBINDS.MOVE_PINNED_DOWN),
            section: section.workspaces,
            run: () => p.onMovePinnedChat("down"),
          });
        }
      }
    }

    if (p.workspaceMetadata.size > 0) {
      list.push({
        id: CommandIds.workspaceOpenTerminal(),
        title: "Open Terminal Window for Workspace…",
        section: section.workspaces,
        run: () => undefined,
        prompt: {
          title: "Open Terminal Window",
          fields: [
            {
              type: "select",
              name: "workspaceId",
              label: "Workspace",
              placeholder: "Search workspaces…",
              getOptions: () =>
                Array.from(p.workspaceMetadata.values()).map((meta) => {
                  // Use workspace name instead of extracting from path
                  const label = `${meta.projectName} / ${meta.name}`;
                  return {
                    id: meta.id,
                    label,
                    keywords: [
                      meta.name,
                      meta.projectName,
                      meta.namedWorkspacePath,
                      meta.id,
                      meta.title,
                    ].filter((k): k is string => !!k),
                  };
                }),
            },
          ],
          onSubmit: (vals) => {
            const meta = p.workspaceMetadata.get(vals.workspaceId);
            p.onOpenWorkspaceInTerminal(vals.workspaceId, meta?.runtimeConfig);
          },
        },
      });
      list.push({
        id: CommandIds.workspaceEditTitleAny(),
        title: "Edit Workspace Title…",
        section: section.workspaces,
        run: () => undefined,
        prompt: {
          title: "Edit Workspace Title",
          fields: [
            {
              type: "select",
              name: "workspaceId",
              label: "Select workspace",
              placeholder: "Search workspaces…",
              getOptions: () =>
                Array.from(p.workspaceMetadata.values()).map((meta) => {
                  const label = `${meta.projectName} / ${meta.name}`;
                  return {
                    id: meta.id,
                    label,
                    keywords: [
                      meta.name,
                      meta.projectName,
                      meta.namedWorkspacePath,
                      meta.id,
                      meta.title,
                    ].filter((k): k is string => !!k),
                  };
                }),
            },
            {
              type: "text",
              name: "newTitle",
              label: "New title",
              placeholder: "Enter new workspace title",
              getInitialValue: (values) => {
                const meta = Array.from(p.workspaceMetadata.values()).find(
                  (m) => m.id === values.workspaceId
                );
                return meta?.title ?? meta?.name ?? "";
              },
              validate: (v) => (!v.trim() ? "Title is required" : null),
            },
          ],
          onSubmit: async (vals) => {
            await p.onUpdateTitle(vals.workspaceId, vals.newTitle.trim());
          },
        },
      });
      list.push({
        id: CommandIds.workspaceRemoveAny(),
        title: "Remove Workspace…",
        section: section.workspaces,
        run: () => undefined,
        prompt: {
          title: "Remove Workspace",
          fields: [
            {
              type: "select",
              name: "workspaceId",
              label: "Select workspace",
              placeholder: "Search workspaces…",
              getOptions: () =>
                Array.from(p.workspaceMetadata.values()).map((meta) => {
                  const label = `${meta.projectName}/${meta.name}`;
                  return {
                    id: meta.id,
                    label,
                    keywords: [
                      meta.name,
                      meta.projectName,
                      meta.namedWorkspacePath,
                      meta.id,
                      meta.title,
                    ].filter((k): k is string => !!k),
                  };
                }),
            },
          ],
          onSubmit: async (vals) => {
            const meta = Array.from(p.workspaceMetadata.values()).find(
              (m) => m.id === vals.workspaceId
            );
            const workspaceName = meta ? `${meta.projectName}/${meta.name}` : vals.workspaceId;
            const branchName = meta?.name ?? workspaceName.split("/").pop() ?? workspaceName;
            const ok = await p.confirmDialog({
              title: `Remove workspace ${workspaceName}?`,
              description: `This will delete the worktree and local branch "${branchName}".`,
              warning: "This cannot be undone.",
              confirmLabel: "Remove",
              confirmVariant: "destructive",
            });
            if (ok) {
              await p.onRemoveWorkspace(vals.workspaceId);
            }
          },
        },
      });
    }

    return list;
  });

  // Navigation / Interface
  actions.push(() => {
    const list: CommandAction[] = [
      {
        id: CommandIds.navNext(),
        title: "Next Workspace",
        section: section.navigation,
        shortcutHint: formatKeybind(KEYBINDS.NEXT_WORKSPACE),
        run: () => p.onNavigateWorkspace("next"),
      },
      {
        id: CommandIds.navPrev(),
        title: "Previous Workspace",
        section: section.navigation,
        shortcutHint: formatKeybind(KEYBINDS.PREV_WORKSPACE),
        run: () => p.onNavigateWorkspace("prev"),
      },
      {
        id: CommandIds.navToggleSidebar(),
        title: "Toggle Sidebar",
        section: section.navigation,
        shortcutHint: formatKeybind(KEYBINDS.TOGGLE_SIDEBAR),
        run: () => p.onToggleSidebar(),
      },
      {
        id: CommandIds.navToggleHideSubAgents(),
        title: "Toggle Hide Sub-Agents in Sidebar",
        subtitle: `Current: ${readPersistedState(SIDEBAR_HIDE_SUBAGENTS_KEY, false) ? "Hidden" : "Shown"}`,
        section: section.navigation,
        keywords: ["sub-agents", "subagents", "hide", "show", "sidebar"],
        run: () => {
          updatePersistedState<boolean>(SIDEBAR_HIDE_SUBAGENTS_KEY, (prev) => !prev, false);
        },
      },
      {
        id: CommandIds.navToggleFlatChatList(),
        title: "Toggle Flat Chat List",
        subtitle: `Current: ${readPersistedState(SIDEBAR_FLAT_MODE_KEY, false) ? "Flat" : "Grouped"}`,
        section: section.navigation,
        keywords: ["flat", "chat", "list", "projects", "folders", "sidebar"],
        run: () => {
          updatePersistedState<boolean>(SIDEBAR_FLAT_MODE_KEY, (prev) => !prev, false);
        },
      },
      {
        id: CommandIds.navToggleTerminalBadge(),
        title: "Toggle Terminal Badge",
        subtitle: `Current: ${
          normalizeTerminalBadgeConfig(
            readPersistedState(TERMINAL_BADGE_CONFIG_KEY, DEFAULT_TERMINAL_BADGE_CONFIG)
          ).enabled
            ? "Shown"
            : "Hidden"
        }`,
        section: section.navigation,
        keywords: ["terminal", "badge", "watermark", "overlay", "workspace", "tab"],
        run: () => {
          updatePersistedState<TerminalBadgeConfig>(
            TERMINAL_BADGE_CONFIG_KEY,
            (prev) => {
              const config = normalizeTerminalBadgeConfig(prev);
              return { ...config, enabled: !config.enabled };
            },
            DEFAULT_TERMINAL_BADGE_CONFIG
          );
        },
      },
    ];

    // Right sidebar layout commands require a selected workspace (layout is per-workspace)
    const wsId = p.selectedWorkspace?.workspaceId;
    if (wsId) {
      const canReviewDiffs = hasWorkspaceRepository(p.workspaceMetadata.get(wsId));
      list.push(
        // Generic per-tab "Hide/Show <Name>" commands are only for optional tabs.
        // Default-layout tabs (Stats/Review/Instructions) are auto-restored by
        // the layout migration, so exposing hide commands for them would be a
        // no-op and obscure the fact that they are meant to be visible by default.
        ...getOrderedBaseTabIds()
          .filter((tabId) => {
            const config = getTabConfig(tabId);
            return config.inDefaultLayout !== true && config.featureFlag == null;
          })
          .map((tabId) => buildToggleTabCommand(wsId, tabId, section.navigation)),
        {
          id: CommandIds.navOpenLogFile(),
          title: "Open Log File",
          section: section.navigation,
          keywords: ["log", "logs"],
          run: async () => {
            const result = await p.api?.general.getLogPath();
            const logPath = result?.path;
            if (!logPath) return;

            window.open(toFileUrl(logPath), "_blank", "noopener");
          },
        },
        {
          id: CommandIds.navRightSidebarFocusTerminal(),
          title: "Right Sidebar: Focus Terminal",
          section: section.navigation,
          run: () =>
            updateRightSidebarLayout(wsId, (s) => {
              const found = findFirstTerminalSessionTab(s.root);
              if (!found) return s;
              return selectTabInTabset(
                setFocusedTabset(s, found.tabsetId),
                found.tabsetId,
                found.tab
              );
            }),
        },
        {
          id: CommandIds.navRightSidebarSplitHorizontal(),
          title: "Right Sidebar: Split Horizontally",
          section: section.navigation,
          run: () => updateRightSidebarLayout(wsId, (s) => splitFocusedTabset(s, "horizontal")),
        },
        {
          id: CommandIds.navRightSidebarSplitVertical(),
          title: "Right Sidebar: Split Vertically",
          section: section.navigation,
          run: () => updateRightSidebarLayout(wsId, (s) => splitFocusedTabset(s, "vertical")),
        },
        {
          id: CommandIds.navRightSidebarAddTool(),
          title: "Right Sidebar: Add Tool…",
          section: section.navigation,
          run: () => undefined,
          prompt: {
            title: "Add Right Sidebar Tool",
            fields: [
              {
                type: "select",
                name: "tool",
                label: "Tool",
                placeholder: "Select a tool…",
                // Static tabs come straight from the lightweight config (in default order).
                // Terminal is appended manually because it lives outside the static registry.
                getOptions: () => [
                  ...getOrderedBaseTabIds()
                    .filter(
                      (tabId) =>
                        getTabConfig(tabId).featureFlag == null &&
                        (canReviewDiffs || tabId !== "review")
                    )
                    .map((tabId) => {
                      const config = getTabConfig(tabId);
                      return {
                        id: tabId as TabType,
                        label: config.name,
                        keywords: config.paletteKeywords ?? [tabId],
                      };
                    }),
                  { id: "terminal" as TabType, label: "Terminal", keywords: ["terminal"] },
                ],
              },
            ],
            onSubmit: (vals) => {
              const tool = vals.tool;
              if (!isTabType(tool)) return;

              if (tool === "review" && !canReviewDiffs) return;

              // "terminal" is now an alias for "focus an existing terminal session tab".
              // Creating new terminal sessions is handled in the main UI ("+" button).
              if (tool === "terminal") {
                updateRightSidebarLayout(wsId, (s) => {
                  const found = findFirstTerminalSessionTab(s.root);
                  if (!found) return s;
                  return selectTabInTabset(
                    setFocusedTabset(s, found.tabsetId),
                    found.tabsetId,
                    found.tab
                  );
                });
                return;
              }

              updateRightSidebarLayout(wsId, (s) => addToolToFocusedTabset(s, tool));
            },
          },
        }
      );
    }

    return list;
  });

  // Layout slots
  actions.push(() => {
    const list: CommandAction[] = [];
    const selected = p.selectedWorkspace;
    if (!selected) {
      return list;
    }

    const config = getLayoutsConfigOrDefault(p.layoutPresets);

    for (const slot of [1, 2, 3, 4, 5, 6, 7, 8, 9] as const) {
      const preset = getPresetForSlot(config, slot);
      const keybind = getEffectiveSlotKeybind(config, slot);
      assert(keybind, `Slot ${slot} must have a default keybind`);
      const shortcutHint = formatKeybind(keybind);

      list.push({
        id: CommandIds.layoutApplySlot(slot),
        title: `Layout: Apply Slot ${slot}`,
        subtitle: preset ? preset.name : "Empty",
        section: section.layouts,
        shortcutHint,
        enabled: () => Boolean(preset) && Boolean(p.onApplyLayoutSlot),
        run: () => {
          if (!preset) return;
          void p.onApplyLayoutSlot?.(selected.workspaceId, slot);
        },
      });

      if (p.onCaptureLayoutSlot) {
        list.push({
          id: CommandIds.layoutCaptureSlot(slot),
          title: `Layout: Capture current to Slot ${slot}…`,
          subtitle: preset ? preset.name : "Empty",
          section: section.layouts,
          run: () => undefined,
          prompt: {
            title: `Capture Layout Slot ${slot}`,
            fields: [
              {
                type: "text",
                name: "name",
                label: "Name",
                placeholder: `Slot ${slot}`,
                initialValue: preset ? preset.name : `Slot ${slot}`,
                getInitialValue: () => getPresetForSlot(config, slot)?.name ?? `Slot ${slot}`,
                validate: (v) => (!v.trim() ? "Name is required" : null),
              },
            ],
            onSubmit: async (vals) => {
              await p.onCaptureLayoutSlot?.(selected.workspaceId, slot, vals.name.trim());
            },
          },
        });
      }
    }

    return list;
  });

  // Appearance
  actions.push(() => {
    const list: CommandAction[] = [
      {
        id: CommandIds.themeToggle(),
        title: "Cycle Theme",
        section: section.appearance,
        run: () => p.onToggleTheme(),
      },
    ];

    // Add command for each theme the user isn't currently using
    for (const opt of THEME_OPTIONS) {
      if (p.themePreference !== opt.value) {
        list.push({
          id: CommandIds.themeSet(opt.value),
          title: `Use ${opt.label} Theme`,
          section: section.appearance,
          run: () => p.onSetTheme(opt.value),
        });
      }
    }

    return list;
  });

  // Goals
  actions.push(() => {
    const selected = p.selectedWorkspace;
    if (!selected) {
      return [];
    }

    const workspaceId = selected.workspaceId;
    const selectedMetadata = p.workspaceMetadata.get(workspaceId);
    // Goal writes are rejected for child task workspaces by
    // WorkspaceGoalService.assertParentWorkspace(), so keep palette actions
    // hidden there just like the Goal tab.
    if (selectedMetadata?.parentWorkspaceId != null) {
      return [];
    }

    const api = p.api;
    const goal = p.selectedWorkspaceState?.goal ?? null;
    const list: CommandAction[] = [
      {
        id: CommandIds.goalSetObjective(),
        title: "Goal: Set objective",
        section: section.goals,
        keywords: ["target", "objective", "budget"],
        run: () => undefined,
        prompt: {
          title: "Set Goal Objective",
          fields: [
            {
              type: "text",
              name: "objective",
              label: "Goal objective",
              placeholder: GOAL_OBJECTIVE_PLACEHOLDER,
              validate: (value) => (!value.trim() ? "Goal objective is required" : null),
            },
            {
              type: "text",
              name: "budget",
              label: "Goal budget",
              placeholder: "$5.00 or blank for no budget",
              validate: (value) => {
                const trimmed = value.trim();
                if (!trimmed || parseGoalBudgetCents(trimmed) != null) {
                  return null;
                }
                return "Use a budget like $5.00 or 500c";
              },
            },
          ],
          onSubmit: async (values) => {
            assert(api, "Goal palette actions require a connected backend");
            const objective = values.objective.trim();
            assert(objective.length > 0, "Goal objective is required");
            const budget = values.budget.trim();
            const budgetCents = budget ? parseGoalBudgetCents(budget) : null;
            assert(
              !budget || budgetCents !== null,
              "Goal budget must be blank or formatted like $5.00 or 500c"
            );
            // Apply shared defaults for turn caps, while preserving the palette
            // field contract that a blank budget means no budget. Pass the
            // workspaceId so a per-workspace override (configured from the
            // GoalTab) wins over the global default for palette-initiated
            // goal creation.
            const defaults = await loadGoalDefaults(api, workspaceId);
            const intent = resolveGoalSetIntent(
              {
                objective,
                budgetCents,
              },
              defaults
            );
            let providersConfig: unknown = null;
            try {
              providersConfig = await api.providers.getConfig();
            } catch {
              providersConfig = null;
            }
            if (
              !canSetBudgetedGoalWithCurrentPaletteModel(
                workspaceId,
                p.selectedWorkspaceState,
                intent.budgetCents,
                providersConfig
              )
            ) {
              showUnpricedCurrentModelGoalFeedback();
              return;
            }
            const ok = await requireGoalSetSuccess(api, workspaceId, {
              objective: intent.objective,
              budgetCents: intent.budgetCents,
              ...(intent.turnCap != null ? { turnCap: intent.turnCap } : {}),
            });
            if (!ok) return;
            openGoalPanel(workspaceId);
          },
        },
      },
    ];

    const isPendingGoalPersistence = isGoalPendingPersistence(goal);

    if (!isPendingGoalPersistence && goal?.status === "active") {
      list.push({
        id: CommandIds.goalPause(),
        title: "Goal: Pause",
        section: section.goals,
        keywords: ["target", "objective"],
        run: async () => {
          assert(api, "Goal palette actions require a connected backend");
          await requireGoalSetSuccess(api, workspaceId, { status: "paused" });
        },
      });
    }

    if (!isPendingGoalPersistence && goal?.status === "paused") {
      list.push({
        id: CommandIds.goalResume(),
        title: "Goal: Resume",
        section: section.goals,
        keywords: ["target", "objective"],
        run: async () => {
          assert(api, "Goal palette actions require a connected backend");
          await requireGoalSetSuccess(api, workspaceId, { status: "active" });
        },
      });
    }

    if (
      !isPendingGoalPersistence &&
      (goal?.status === "active" || goal?.status === "budget_limited")
    ) {
      list.push({
        id: CommandIds.goalMarkComplete(),
        title: "Goal: Mark complete",
        section: section.goals,
        keywords: ["target", "objective", "summary"],
        run: () => undefined,
        prompt: {
          title: "Complete Goal",
          fields: [
            {
              type: "text",
              name: "summary",
              label: "Completion summary",
              placeholder: "Summarize the completed goal…",
              validate: (value) => (!value.trim() ? "Completion summary is required" : null),
            },
          ],
          onSubmit: async (values) => {
            assert(api, "Goal palette actions require a connected backend");
            const completionSummary = values.summary.trim();
            assert(completionSummary.length > 0, "Completion summary is required");
            const ok = await requireGoalSetSuccess(api, workspaceId, {
              status: "complete",
              completionSummary,
            });
            if (!ok) return;
            openGoalPanel(workspaceId);
          },
        },
      });
    }

    if (goal) {
      if (!isPendingGoalPersistence) {
        list.push({
          id: CommandIds.goalClear(),
          title: "Goal: Clear",
          section: section.goals,
          keywords: ["target", "objective"],
          run: async () => {
            assert(api, "Goal palette actions require a connected backend");
            await api.workspace.clearGoal({ workspaceId });
          },
        });
      }
      list.push({
        id: CommandIds.goalOpenPanel(),
        title: "Goal: Open panel",
        section: section.goals,
        keywords: ["target", "objective", "sidebar"],
        run: () => openGoalPanel(workspaceId),
      });
    }

    return list;
  });

  // Chat utilities
  actions.push(() => {
    const list: CommandAction[] = [];
    if (p.selectedWorkspace) {
      const id = p.selectedWorkspace.workspaceId;
      list.push({
        id: CommandIds.chatResetContext(),
        title: "Reset Context, Preserve History",
        section: section.chat,
        keywords: ["context reset", "soft clear", "preserve history", "reset chat"],
        run: async () => {
          assert(p.api, "Reset Context palette action requires a connected backend");
          const result = await p.api.workspace.resetContext({ workspaceId: id });
          if (!result.success) {
            showCommandFeedbackToast({ type: "error", message: result.error });
            throw new Error(result.error);
          }
          if (result.data === "reset") {
            window.dispatchEvent(
              createCustomEvent(CUSTOM_EVENTS.CLEAR_CHAT_COMPOSER, { workspaceId: id })
            );
          }
          showCommandFeedbackToast({
            type: "success",
            message: getContextResetSuccessMessage(result.data),
          });
        },
      });
      // Truncation failures — including partial ones where history was
      // deleted but durable cleanup (e.g. sandbox kernel invalidation)
      // failed — must surface instead of silently resolving as success
      // (mirrors the Reset Context action above).
      const runTruncate = async (percentage: number) => {
        const result = await p.api?.workspace.truncateHistory({ workspaceId: id, percentage });
        if (result && !result.success) {
          showCommandFeedbackToast({ type: "error", message: result.error });
          throw new Error(result.error);
        }
      };
      list.push({
        id: CommandIds.chatClear(),
        title: "Clear History",
        section: section.chat,
        run: () => runTruncate(1.0),
      });
      for (const pct of [0.75, 0.5, 0.25]) {
        list.push({
          id: CommandIds.chatTruncate(pct),
          title: `Truncate History to ${Math.round((1 - pct) * 100)}%`,
          section: section.chat,
          run: () => runTruncate(pct),
        });
      }
      list.push({
        id: CommandIds.chatInterrupt(),
        title: "Interrupt Streaming",
        section: section.chat,
        // Shows the normal-mode shortcut (Esc). Vim mode uses Ctrl+C instead,
        // but vim state isn't available here; Esc is the common-case default.
        shortcutHint: formatKeybind(KEYBINDS.INTERRUPT_STREAM_NORMAL),
        run: async () => {
          if (p.selectedWorkspaceState?.awaitingUserQuestion) {
            return;
          }
          if (!p.api) {
            return;
          }
          await stopStream(p.api, id, { disableAutoRetry: true });
        },
      });
      list.push({
        id: CommandIds.chatJumpBottom(),
        title: "Jump to Bottom",
        section: section.chat,
        shortcutHint: formatKeybind(KEYBINDS.JUMP_TO_BOTTOM),
        run: () => {
          // Dispatch the keybind; AIView listens for it
          const ev = new KeyboardEvent("keydown", { key: "G", shiftKey: true });
          window.dispatchEvent(ev);
        },
      });
      list.push({
        id: CommandIds.chatVoiceInput(),
        title: "Toggle Voice Input",
        subtitle: "Dictate instead of typing",
        section: section.chat,
        shortcutHint: formatKeybind(KEYBINDS.TOGGLE_VOICE_INPUT),
        run: () => {
          // Dispatch custom event; ChatInput listens for it
          window.dispatchEvent(createCustomEvent(CUSTOM_EVENTS.TOGGLE_VOICE_INPUT));
        },
      });
      list.push({
        id: CommandIds.chatClearTimingStats(),
        title: "Clear Timing Stats",
        subtitle: "Reset session timing data for this workspace",
        section: section.chat,
        run: () => {
          p.onClearTimingStats?.(id);
        },
      });
    }
    return list;
  });

  // Modes & Model
  actions.push(() => {
    const list: CommandAction[] = [
      {
        id: CommandIds.modeToggle(),
        title: "Open Agent Picker",
        section: section.mode,
        shortcutHint: formatKeybind(KEYBINDS.TOGGLE_AGENT),
        run: () => {
          window.dispatchEvent(createCustomEvent(CUSTOM_EVENTS.OPEN_AGENT_PICKER));
        },
      },
      {
        id: "cycle-agent",
        title: "Cycle Agent",
        section: section.mode,
        shortcutHint: formatKeybind(KEYBINDS.CYCLE_AGENT),
        run: () => {
          const ev = new KeyboardEvent("keydown", { key: ".", ctrlKey: true });
          window.dispatchEvent(ev);
        },
      },
      {
        id: CommandIds.modelChange(),
        title: "Change Model…",
        section: section.mode,
        // No shortcutHint: CYCLE_MODEL (⌘/) cycles to next model directly,
        // but this action opens the model selector picker — different behavior.
        run: () => {
          window.dispatchEvent(createCustomEvent(CUSTOM_EVENTS.OPEN_MODEL_SELECTOR));
        },
      },
    ];

    const selectedWorkspace = p.selectedWorkspace;
    const providerOptionScopeId = selectedWorkspace?.workspaceId ?? p.creationScopeId;
    const providerOptionGateModel = providerOptionScopeId
      ? p.getEffectiveComposerModel(providerOptionScopeId)
      : undefined;
    const currentModelString = providerOptionGateModel ?? p.selectedWorkspaceState?.currentModel;
    const providerOptionRoute = providerOptionGateModel
      ? p.getRouteForModel?.(normalizeToCanonical(providerOptionGateModel))
      : undefined;
    const fastModeAction: CommandAction | null =
      p.providersConfig != null &&
      getFastModeProvider(providerOptionGateModel ?? "", {
        providersConfig: p.providersConfig,
        resolvedRouteProvider: providerOptionRoute,
      }) != null
        ? {
            id: CommandIds.toggleFastMode(),
            title: "Toggle Fast Mode",
            subtitle: `Current: ${p.getFastMode() ? "Fast — faster responses at higher cost" : "Standard"}`,
            section: section.mode,
            shortcutHint: formatKeybind(KEYBINDS.TOGGLE_FAST_MODE),
            run: p.onToggleFastMode,
          }
        : null;

    if (selectedWorkspace) {
      const { workspaceId } = selectedWorkspace;
      const levelDescriptions: Record<ThinkingLevel, string> = {
        off: "Off — fastest responses",
        low: "Low — add a bit of reasoning",
        medium: "Medium — balanced reasoning",
        high: "High — maximum reasoning depth",
        xhigh: "Max — deepest possible reasoning",
        max: "Max — deepest possible reasoning",
      };
      // Display the floored level so it matches the selector (e.g. a stored "off" with a
      // medium floor reads as "medium").
      const rawCurrentLevel = p.getThinkingLevel(workspaceId);
      // Pass providersConfig so mapped aliases (mappedToModel -> e.g. GPT-5.6)
      // resolve to the target's ladder, matching the selector and send path.
      const currentLevel = currentModelString
        ? enforceThinkingPolicy(
            currentModelString,
            rawCurrentLevel,
            resolveMinimumThinkingLevel(
              currentModelString,
              p.getMinThinkingOverride?.(currentModelString),
              p.providersConfig
            ),
            p.providersConfig
          )
        : rawCurrentLevel;

      list.push({
        id: CommandIds.thinkingSetLevel(),
        title: "Set Thinking Effort…",
        subtitle: `Current: ${levelDescriptions[currentLevel] ?? currentLevel}`,
        section: section.mode,
        // No shortcutHint: INCREASE_THINKING / DECREASE_THINKING (⌘⇧] / ⌘⇧[) step
        // the level directly, but this action opens a level selection prompt — different behavior.
        run: () => undefined,
        prompt: {
          title: "Select Thinking Effort",
          fields: [
            {
              type: "select",
              name: "thinkingLevel",
              label: "Thinking effort",
              placeholder: "Choose effort level…",
              getOptions: () => {
                // Filter thinking levels by the active model's policy AND its minimum
                // floor, so users only see levels valid for the current model (matching
                // the selector — off/low hidden unless the model's minimum is lowered).
                const allowedLevels = currentModelString
                  ? getAvailableThinkingLevels(
                      currentModelString,
                      resolveMinimumThinkingLevel(
                        currentModelString,
                        p.getMinThinkingOverride?.(currentModelString),
                        p.providersConfig
                      ),
                      p.providersConfig
                    )
                  : THINKING_LEVELS;
                return allowedLevels.map((level) => ({
                  id: level,
                  label: levelDescriptions[level],
                  keywords: [
                    level,
                    levelDescriptions[level].toLowerCase(),
                    "thinking",
                    "reasoning",
                  ],
                }));
              },
            },
          ],
          onSubmit: (vals) => {
            const rawLevel = vals.thinkingLevel;
            const level = THINKING_LEVELS.includes(rawLevel as ThinkingLevel)
              ? (rawLevel as ThinkingLevel)
              : "off";
            p.onSetThinkingLevel(workspaceId, level);
          },
        },
      });

      if (fastModeAction) {
        list.push(fastModeAction);
      }

      // Pro reasoning mode is only meaningful for models that support it
      // on routes that deliver the native provider option (direct OpenAI or
      // Coder OpenAI instances) with the Responses wire format; hide the action
      // elsewhere to avoid inert toggles. Gate on the chat input's persisted selection —
      // that is the model the NEXT send will use — and only fall back to the
      // activity snapshot's currentModel (last streamed model, stale after a
      // model switch) when no selection exists. The mobile layout hides the
      // Pro row and relies on this palette action being reachable before the
      // first send with the newly selected model.
      const proGateModelString = providerOptionGateModel;
      const currentModelRoute = providerOptionRoute;
      if (
        openaiProModeAvailable(proGateModelString ?? "", {
          providersConfig: p.providersConfig,
          resolvedRouteProvider: currentModelRoute,
          effectiveRouteProvider: proGateModelString
            ? p.getEffectiveRouteForModel?.(proGateModelString)
            : undefined,
        })
      ) {
        const proActive = p.getReasoningMode(workspaceId) === "pro";
        list.push({
          id: CommandIds.toggleProReasoning(),
          title: "Toggle Pro Reasoning Mode",
          subtitle: `Current: ${proActive ? "Pro — slower, more thorough" : "Standard"}`,
          section: section.mode,
          run: () => {
            p.onToggleReasoningMode(workspaceId);
          },
        });
      }
    } else if (fastModeAction) {
      // Creation composers use their project-scoped model preference before a workspace exists.
      list.push(fastModeAction);
    }

    return list;
  });

  // Help / Docs
  actions.push(() => [
    {
      id: CommandIds.helpKeybinds(),
      title: "Show Keyboard Shortcuts",
      section: section.help,
      run: () => {
        try {
          window.open("https://mux.coder.com/config/keybinds", "_blank");
        } catch {
          /* ignore */
        }
      },
    },
  ]);

  // Updates: the About dialog owns the controls and shows status, blockers, and errors, so each
  // command starts the operation and opens the dialog.
  if (p.onOpenAbout) {
    const openAbout = p.onOpenAbout;
    const updateCommand = (operation: (api: APIClient) => Promise<unknown>) => () => {
      if (p.api) void operation(p.api).catch(console.error);
      openAbout();
    };
    actions.push(() => [
      {
        id: CommandIds.aboutOpen(),
        title: "About",
        section: section.help,
        keywords: ["version", "update", "release"],
        run: () => openAbout(),
      },
      {
        id: CommandIds.updateCheck(),
        title: "Check for Updates",
        section: section.help,
        keywords: ["update", "upgrade", "version"],
        run: updateCommand((api) => api.update.check({ source: "manual" })),
      },
      {
        id: CommandIds.updateDownload(),
        title: "Download Update",
        section: section.help,
        keywords: ["update", "upgrade"],
        run: updateCommand((api) => api.update.download()),
      },
      {
        id: CommandIds.updateInstall(),
        title: "Install Update and Restart",
        section: section.help,
        keywords: ["update", "upgrade", "restart"],
        run: updateCommand((api) => api.update.install()),
      },
      {
        id: CommandIds.updateInstallForce(),
        title: "Install Update and Restart Anyway",
        subtitle: "Interrupts active work",
        section: section.help,
        keywords: ["update", "upgrade", "restart", "force"],
        run: updateCommand((api) => api.update.install({ force: true })),
      },
      ...p.supportedUpdateChannels.map((channel) => ({
        id: CommandIds.updateChannel(channel),
        title: `Update Channel: ${UPDATE_CHANNEL_LABELS[channel]}`,
        section: section.help,
        keywords: ["update", "channel", channel],
        // The dialog reads the channel once when it opens, so the change must land first.
        run: async () => {
          if (p.api) await p.api.update.setChannel({ channel }).catch(console.error);
          openAbout();
        },
      })),
    ]);
  }

  // Projects
  actions.push(() => {
    const list: CommandAction[] = [
      {
        id: CommandIds.projectAdd(),
        title: "Add Project…",
        section: section.projects,
        run: () => p.onAddProject(),
      },
      {
        id: CommandIds.workspaceNewInProject(),
        title: "Create New Workspace in Project…",
        section: section.projects,
        run: () => undefined,
        prompt: {
          title: "New Workspace in Project",
          fields: [
            {
              type: "select",
              name: "projectPath",
              label: "Select project",
              placeholder: "Search projects…",
              getOptions: (_values) =>
                Array.from(p.userProjects.keys()).map((projectPath) => ({
                  id: projectPath,
                  label: formatProjectHierarchyLabel(projectPath, p.userProjects),
                  keywords: [projectPath],
                })),
            },
          ],
          onSubmit: (vals) => {
            const projectPath = vals.projectPath;
            // Reuse the chat-based creation flow for the selected project
            p.onStartWorkspaceCreation(projectPath);
          },
        },
      },
      {
        id: CommandIds.workspaceNewMultiProject(),
        title: "New Multi-Project Workspace",
        section: section.projects,
        keywords: ["multi", "project", "workspace", "create"],
        visible: () => p.multiProjectWorkspacesEnabled,
        run: () => {
          if (!p.multiProjectWorkspacesEnabled) {
            return;
          }
          p.onStartMultiProjectWorkspaceCreation();
        },
      },
      {
        id: CommandIds.workspaceArchiveMergedInProject(),
        title: "Archive Merged Workspaces in Project…",
        section: section.projects,
        keywords: ["archive", "merged", "pr", "github", "gh", "cleanup"],
        run: () => undefined,
        prompt: {
          title: "Archive Merged Workspaces in Project",
          fields: [
            {
              type: "select",
              name: "projectPath",
              label: "Select project",
              placeholder: "Search projects…",
              getOptions: (_values) =>
                getTopLevelProjectEntries(p.userProjects).map(([projectPath]) => ({
                  id: projectPath,
                  label: formatProjectHierarchyLabel(projectPath, p.userProjects),
                  keywords: [projectPath],
                })),
            },
          ],
          onSubmit: async (vals) => {
            const projectPath = vals.projectPath;
            const projectName = projectPath.split("/").pop() ?? projectPath;

            const ok = await p.confirmDialog({
              title: `Archive merged workspaces in ${projectName}?`,
              description:
                "This will archive (not delete) workspaces in this project whose GitHub PR is merged. This is reversible.\n\nThis may start/wake workspace runtimes and can take a while.\n\nThis uses GitHub via the gh CLI. Make sure gh is installed and authenticated.",
              confirmLabel: "Archive",
            });
            if (!ok) return;

            await p.onArchiveMergedWorkspacesInProject(projectPath);
          },
        },
      },
    ];

    for (const [projectPath] of p.userProjects.entries()) {
      const projectName = projectPath.split("/").pop() ?? projectPath;
      list.push({
        id: CommandIds.projectRemove(projectPath),
        title: `Remove Project ${projectName}…`,
        section: section.projects,
        run: () => p.onRemoveProject(projectPath),
      });
    }
    return list;
  });

  // Analytics maintenance
  actions.push(() => [
    {
      id: CommandIds.analyticsRebuildDatabase(),
      title: "Rebuild Analytics Database",
      subtitle: "Recompute analytics from workspace history",
      section: section.settings,
      keywords: ["analytics", "rebuild", "recompute", "database", "stats"],
      run: async () => {
        const rebuildDatabase = getAnalyticsRebuildDatabase(p.api);
        if (!rebuildDatabase) {
          showCommandFeedbackToast({
            type: "error",
            title: "Analytics Unavailable",
            message: "Analytics backend is not available in this build.",
          });
          return;
        }

        try {
          const result = await rebuildDatabase({});
          if (!result.success) {
            showCommandFeedbackToast({
              type: "error",
              title: "Analytics Rebuild Failed",
              message: "Analytics database rebuild did not complete successfully.",
            });
            return;
          }

          const workspaceLabel = `${result.workspacesIngested} workspace${
            result.workspacesIngested === 1 ? "" : "s"
          }`;
          showCommandFeedbackToast({
            type: "success",
            message: `Analytics database rebuilt successfully (${workspaceLabel} ingested).`,
          });
        } catch (error) {
          showCommandFeedbackToast({
            type: "error",
            title: "Analytics Rebuild Failed",
            message: getErrorMessage(error),
          });
        }
      },
    },
  ]);

  // Settings
  if (p.onOpenSettings) {
    const openSettings = p.onOpenSettings;
    actions.push(() => [
      {
        id: CommandIds.settingsOpen(),
        title: "Open Settings",
        section: section.settings,
        keywords: ["preferences", "config", "configuration"],
        shortcutHint: formatKeybind(KEYBINDS.OPEN_SETTINGS),
        run: () => openSettings(),
      },
      {
        id: CommandIds.settingsOpenSection("providers"),
        title: "Settings: Providers",
        subtitle: "Configure API keys and endpoints",
        section: section.settings,
        keywords: ["api", "key", "anthropic", "openai", "google"],
        run: () => openSettings("providers"),
      },
      {
        id: CommandIds.settingsOpenSection("models"),
        title: "Settings: Models",
        subtitle: "Manage custom models",
        section: section.settings,
        keywords: ["model", "custom", "add"],
        run: () => openSettings("models"),
      },
      {
        id: CommandIds.settingsOpenSection("providers-coder-login"),
        title: "Settings: Login with Coder",
        subtitle: "Connect to a Coder deployment (AI Bridge)",
        section: section.settings,
        keywords: ["coder", "login", "oauth", "aibridge", "deployment", "connect"],
        // Hidden when a custom OpenAI-compatible provider shadows the "coder"
        // id (an upgraded install may carry one): ProvidersSection hides the
        // OAuth block for shadowed providers, so the login hint would either
        // surface an invisible "Set the deployment URL first" error or —
        // if the custom section happens to have a deploymentUrl — inject
        // built-in OAuth credentials into the custom provider's section.
        visible: () => p.providersConfig?.coder?.isCustom !== true,
        // Expands the Coder provider and starts the OAuth login (one-shot
        // hints consumed by ProvidersSection) instead of only opening the
        // generic Providers list.
        run: () => openSettings("providers", { expandProvider: "coder", startCoderLogin: true }),
      },
      ...(p.agentPluginsEnabled
        ? ([
            {
              id: CommandIds.settingsOpenSection("plugins"),
              title: "Settings: Plugins",
              subtitle: "Install and manage Agent Plugins",
              section: section.settings,
              keywords: ["plugin", "install", "agent", "skill", "mcp", "update"],
              run: () => openSettings("plugins"),
            },
            {
              id: CommandIds.pluginsInstall(),
              title: "Install Agent Plugin…",
              subtitle: "Paste a git URL or owner/repo",
              section: section.settings,
              keywords: ["plugin", "install", "add", "git", "clone"],
              run: () => {
                // Open the section with the add-plugin form already expanded.
                publishPluginsSectionIntent({ type: "open-add-panel" });
                openSettings("plugins");
              },
            },
            {
              id: CommandIds.pluginsUninstall(),
              title: "Uninstall Agent Plugin…",
              section: section.settings,
              keywords: ["plugin", "uninstall", "remove", "delete"],
              run: () => undefined,
              prompt: {
                title: "Uninstall Agent Plugin",
                fields: [
                  {
                    type: "select",
                    name: "pluginName",
                    label: "Managed plugin",
                    placeholder: "Search installed plugins…",
                    getOptions: async () => {
                      const result = await p.api?.agentPlugins.list();
                      if (!result?.success) {
                        return [];
                      }
                      return result.data
                        .filter((item) => item.managed)
                        .map((item) => ({
                          id: item.name,
                          label: item.version ? `${item.name} (v${item.version})` : item.name,
                          keywords: [item.name, item.location],
                        }));
                    },
                  },
                ],
                onSubmit: (values) => {
                  // Route through the section's confirmation flow (plugin-data
                  // checkbox, explicit destructive button) — the palette never
                  // uninstalls directly.
                  publishPluginsSectionIntent({
                    type: "confirm-uninstall",
                    name: values.pluginName,
                  });
                  openSettings("plugins");
                },
              },
            },
            {
              id: CommandIds.pluginsCheckUpdates(),
              title: "Check for Plugin Updates",
              section: section.settings,
              keywords: ["plugin", "update", "check", "outdated"],
              run: async () => {
                const result = await p.api?.agentPlugins.checkUpdates();
                if (!result) return;
                if (!result.success) {
                  showCommandFeedbackToast({ type: "error", message: result.error });
                  return;
                }
                const updatable = result.data.filter(
                  (check) => check.status === "update-available" || check.status === "tag-moved"
                );
                // Per-plugin failures ride inside a successful result; an
                // unreachable remote is an unknown state, not "up to date" —
                // and it stays in the summary even when updates were found.
                const failed = result.data.filter((check) => check.status === "error");
                const summary: string[] = [];
                if (updatable.length > 0) {
                  summary.push(
                    `Updates available: ${updatable.map((check) => check.name).join(", ")}`
                  );
                }
                if (failed.length > 0) {
                  summary.push(
                    `Update check failed for ${failed.map((check) => check.name).join(", ")}`
                  );
                }
                // A mounted section keeps its own stale updateChecks map;
                // tell it to re-query so badges match the toast.
                publishPluginsSectionIntent({ type: "refresh" });
                if (summary.length === 0) {
                  showCommandFeedbackToast({
                    type: "success",
                    message: "All plugins are up to date.",
                  });
                  return;
                }
                showCommandFeedbackToast({
                  type: failed.length > 0 ? "error" : "success",
                  message: summary.join(". "),
                });
                openSettings("plugins");
              },
            },
            {
              id: CommandIds.pluginsUpdateAll(),
              title: "Update All Plugins",
              subtitle: "Apply pending plugin updates",
              section: section.settings,
              keywords: ["plugin", "update", "upgrade", "all"],
              run: async () => {
                const api = p.api;
                if (!api) return;
                const checks = await api.agentPlugins.checkUpdates();
                if (!checks.success) {
                  showCommandFeedbackToast({ type: "error", message: checks.error });
                  return;
                }
                // Moved tags are excluded from the bulk apply: tags are
                // supposed to be immutable, so a moved tag warrants the
                // section's per-plugin review — but it must never read as
                // "up to date", so it stays in the summary below.
                const updatable = checks.data.filter(
                  (check) => check.status === "update-available"
                );
                const tagMoved = checks.data
                  .filter((check) => check.status === "tag-moved")
                  .map((check) => check.name);
                // Unreachable remotes are an unknown state, never "up to date" —
                // and they must stay visible even when other updates succeed.
                const checkFailures = checks.data
                  .filter((check) => check.status === "error")
                  .map((check) => check.name);

                const updateFailures: string[] = [];
                const updatedNames: string[] = [];
                for (const check of updatable) {
                  const result = await api.agentPlugins.update({ name: check.name });
                  if (result.success) {
                    updatedNames.push(check.name);
                  } else {
                    updateFailures.push(`${check.name}: ${result.error}`);
                  }
                }
                // A mounted section only re-queries from its own handlers, so
                // tell it the state changed under it. This runs even when no
                // branch update applied: the fresh check may have discovered
                // moved tags or per-plugin errors the section should show.
                publishPluginsSectionIntent({ type: "refresh" });
                if (updatedNames.length > 0) {
                  // Mounted composers cache contributed slash-command/skill
                  // descriptors; an update can change them without a remount.
                  publishAgentPluginsMutated();
                }

                const summary: string[] = [];
                if (updatedNames.length > 0) {
                  summary.push(`Updated ${updatedNames.join(", ")}`);
                }
                if (updateFailures.length > 0) {
                  summary.push(`Update failed — ${updateFailures.join("; ")}`);
                }
                if (tagMoved.length > 0) {
                  summary.push(
                    `Tag moved for ${tagMoved.join(", ")} — review in Settings → Plugins`
                  );
                }
                if (checkFailures.length > 0) {
                  summary.push(`Update check failed for ${checkFailures.join(", ")}`);
                }
                if (summary.length === 0) {
                  showCommandFeedbackToast({
                    type: "success",
                    message: "All plugins are up to date.",
                  });
                  return;
                }
                showCommandFeedbackToast({
                  // Anything unexpected taints the toast: a partial success or
                  // a moved tag must not read as a verified all-clear.
                  type:
                    updateFailures.length > 0 || checkFailures.length > 0 || tagMoved.length > 0
                      ? "error"
                      : "success",
                  message: summary.join(". "),
                });
                if (tagMoved.length > 0 || checkFailures.length > 0) {
                  openSettings("plugins");
                }
              },
            },
            {
              id: CommandIds.pluginsUpdateOne(),
              title: "Update Agent Plugin…",
              subtitle: "Apply one plugin's pending update",
              section: section.settings,
              keywords: ["plugin", "update", "upgrade", "single", "one"],
              run: () => undefined,
              prompt: {
                title: "Update Agent Plugin",
                fields: [
                  {
                    type: "select",
                    name: "pluginName",
                    label: "Plugin with a pending update",
                    placeholder: "Search updatable plugins…",
                    getOptions: async () => {
                      const checks = await p.api?.agentPlugins.checkUpdates();
                      if (!checks?.success) {
                        return [];
                      }
                      // Moved tags are updatable here BY DESIGN: bulk update
                      // excludes them so they get per-plugin review, and this
                      // selector (with its warning label) is that reviewed,
                      // keyboard-accessible path.
                      return checks.data
                        .filter(
                          (check) =>
                            check.status === "update-available" || check.status === "tag-moved"
                        )
                        .map((check) => ({
                          id: check.name,
                          label:
                            check.status === "tag-moved"
                              ? `${check.name} — tag moved (review: tags should be immutable)`
                              : `${check.name} — update available`,
                          keywords: [check.name, check.status],
                        }));
                    },
                  },
                ],
                onSubmit: async (values) => {
                  const api = p.api;
                  if (!api) return;
                  // Review before applying: an update that changes the
                  // plugin's capability surface needs the user's consent,
                  // which only the section's inline review can collect.
                  const preview = await api.agentPlugins.previewUpdate({
                    name: values.pluginName,
                  });
                  if (!preview.success) {
                    showCommandFeedbackToast({ type: "error", message: preview.error });
                    return;
                  }
                  if (preview.data.changes.length > 0) {
                    publishPluginsSectionIntent({ type: "review-update", review: preview.data });
                    openSettings("plugins");
                    return;
                  }
                  const result = await api.agentPlugins.update({ name: values.pluginName });
                  // A mounted section keeps its own stale updateChecks map;
                  // tell it to re-query so badges match the toast.
                  publishPluginsSectionIntent({ type: "refresh" });
                  if (result.success) {
                    // Mounted composers cache contributed slash-command/skill
                    // descriptors; an update can change them without a remount.
                    publishAgentPluginsMutated();
                  }
                  showCommandFeedbackToast(
                    result.success
                      ? { type: "success", message: `Updated ${values.pluginName}.` }
                      : { type: "error", message: result.error }
                  );
                },
              },
            },
          ] satisfies CommandAction[])
        : []),
    ]);
  }

  // Telemetry toggle: keyboard-reachable twin of the Settings -> General
  // switch (every user operation must be invocable from the palette). Calls
  // the RPC directly so it works even when the Settings pane never opened.
  if (p.api) {
    const apiForTelemetry = p.api;
    actions.push(() => [
      {
        id: CommandIds.telemetryToggle(),
        title: "Toggle Usage Telemetry",
        subtitle: "Anonymous usage analytics (Settings -> General)",
        section: section.settings,
        keywords: ["telemetry", "analytics", "privacy", "usage", "tracking", "opt out"],
        run: () => {
          const task = telemetryTogglePending.then(async () => {
            // Read fresh backend truth instead of any cached UI state: the
            // palette can run with Settings closed, and a privacy toggle must
            // flip the real persisted value.
            const cfg = await apiForTelemetry.config.getConfig();
            if (cfg.telemetryDisabledByEnv === true) {
              showCommandFeedbackToast({
                type: "error",
                message:
                  "Telemetry is hard-disabled by the environment (XUM_DISABLE_TELEMETRY, CI, or tests); the toggle has no effect.",
              });
              return;
            }
            const next = cfg.telemetryEnabled === false;
            await apiForTelemetry.config.updateTelemetryEnabled({ enabled: next });
            showCommandFeedbackToast({
              type: "success",
              message: next ? "Usage telemetry enabled." : "Usage telemetry disabled.",
            });
          });
          telemetryTogglePending = task.then(
            () => undefined,
            () => {
              // A privacy control must never fail silently: without feedback
              // the user cannot tell whether collection state changed. The
              // coerced chain stays usable for the next invocation.
              showCommandFeedbackToast({
                type: "error",
                message: "Could not toggle usage telemetry - the backend is unreachable.",
              });
            }
          );
          return telemetryTogglePending;
        },
      },
    ]);
  }

  // Coder disconnect: calls the RPC directly (no settings UI needed), so it is
  // not gated on onOpenSettings like the section-opening commands above.
  actions.push(() => [
    {
      id: CommandIds.coderDisconnect(),
      title: "Settings: Disconnect Coder",
      subtitle: "Revoke the stored Coder OAuth credential",
      section: section.settings,
      keywords: ["coder", "logout", "disconnect", "oauth", "revoke", "sign out"],
      // Gated on credential PRESENCE (not routability): a blob minted for a
      // previously configured deployment URL must stay revocable — the
      // backend revokes against the blob's own issuer.
      visible: () => p.providersConfig?.coder?.coderOauthCredentialStored === true,
      run: async () => {
        if (!p.api) {
          showCommandFeedbackToast({
            type: "error",
            title: "Coder Disconnect Failed",
            message: "Xum API not connected.",
          });
          return;
        }
        try {
          const result = await p.api.coderOauth.disconnect();
          if (!result.success) {
            showCommandFeedbackToast({
              type: "error",
              title: "Coder Disconnect Failed",
              message: result.error,
            });
            return;
          }
          showCommandFeedbackToast({
            type: "success",
            message: "Coder account disconnected.",
          });
        } catch (error) {
          showCommandFeedbackToast({
            type: "error",
            title: "Coder Disconnect Failed",
            message: getErrorMessage(error),
          });
        }
      },
    },
    {
      id: CommandIds.coderRefreshModels(),
      title: "Settings: Refresh Coder Models",
      subtitle: "Re-discover the deployment's AI Gateway providers and models",
      section: section.settings,
      keywords: ["coder", "models", "refresh", "discover", "gateway", "aibridge"],
      // Gated on routability (not mere credential presence): discovery needs a
      // credential that is valid for the currently effective deployment.
      visible: () => p.providersConfig?.coder?.coderOauthSet === true,
      run: async () => {
        if (!p.api) {
          showCommandFeedbackToast({
            type: "error",
            title: "Coder Model Refresh Failed",
            message: "Xum API not connected.",
          });
          return;
        }
        try {
          const result = await p.api.coderOauth.refreshModels();
          if (!result.success) {
            showCommandFeedbackToast({
              type: "error",
              title: "Coder Model Refresh Failed",
              message: result.error,
            });
            return;
          }
          showCommandFeedbackToast({
            type: "success",
            message: "Coder model catalog refreshed.",
          });
        } catch (error) {
          showCommandFeedbackToast({
            type: "error",
            title: "Coder Model Refresh Failed",
            message: getErrorMessage(error),
          });
        }
      },
    },
  ]);

  return actions;
}

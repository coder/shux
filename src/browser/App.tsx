import { useEffect, useCallback, useRef, useState } from "react";
import { useRouter } from "./contexts/RouterContext";
import { useLocation, useNavigate } from "react-router-dom";
import "./styles/globals.css";
import { useWorkspaceContext, toWorkspaceSelection } from "./contexts/WorkspaceContext";
import { useProjectContext } from "./contexts/ProjectContext";
import { getCodexOauthProjectPath } from "@/common/utils/providers/codexOauthRouting";
import type { WorkspaceSelection } from "./components/ProjectSidebar/ProjectSidebar";
import { LeftSidebar } from "./components/LeftSidebar/LeftSidebar";
import { ProjectCreateModal } from "./components/ProjectCreateModal/ProjectCreateModal";
import { MultiProjectWorkspaceCreateModal } from "./components/MultiProjectWorkspaceCreateModal/MultiProjectWorkspaceCreateModal";
import { AIView } from "./components/AIView/AIView";
import { ErrorBoundary } from "./components/ErrorBoundary/ErrorBoundary";
import {
  usePersistedState,
  updatePersistedState,
  readPersistedState,
} from "./hooks/usePersistedState";
import { useResizableSidebar } from "./hooks/useResizableSidebar";
import { matchesKeybind, KEYBINDS } from "./utils/ui/keybinds";
import { applyFastModeServiceTierChange, getFastModeProvider } from "./utils/fastModeServiceTier";
import { handleLayoutSlotHotkeys } from "./utils/ui/layoutSlotHotkeys";
import { buildSortedWorkspacesByProject } from "./utils/ui/workspaceFiltering";
import {
  computePinnedMoveOrderForWorkspace,
  type PinnedMoveDirection,
} from "./utils/ui/pinnedReorder";
import { getVisibleWorkspaceIds } from "./utils/ui/workspaceDomNav";
import { useUnreadTracking } from "./hooks/useUnreadTracking";
import { useWorkspaceStoreRaw, useWorkspaceRecency } from "./stores/WorkspaceStore";
import {
  getResponseCompleteNotificationBody,
  shouldNotifyOnResponseComplete,
  type ResponseCompleteEvent,
} from "./utils/messages/responseCompletionMetadata";
import { showBrowserNotification } from "./utils/ui/showBrowserNotification";

import { useStableReference, compareMaps } from "./hooks/useStableReference";
import { CommandRegistryProvider, useCommandRegistry } from "./contexts/CommandRegistryContext";
import { useOpenTerminal } from "./hooks/useOpenTerminal";
import { useMinThinkingLevels } from "./hooks/useMinThinkingLevels";
import type { CommandAction } from "./contexts/CommandRegistryContext";
import { useTheme, type ThemePreference } from "./contexts/ThemeContext";
import { CommandPalette } from "./components/CommandPalette/CommandPalette";
import {
  LEFT_SIDEBAR_DEFAULT_WIDTH_PX,
  LEFT_SIDEBAR_MAX_WIDTH_PX,
  LEFT_SIDEBAR_MIN_WIDTH_PX,
} from "@/constants/layout";
import { XUM_PRODUCT_SLUG } from "@/common/constants/product";
import { buildCoreSources, type BuildSourcesParams } from "./utils/commands/sources";

import {
  getTopLevelProjectEntries,
  resolveWorkspaceCreationScope,
} from "@/common/utils/subProjects";
import {
  THINKING_LEVELS,
  coerceOpenAIReasoningMode,
  type OpenAIReasoningMode,
  type ThinkingLevel,
} from "@/common/types/thinking";
import { CUSTOM_EVENTS } from "@/common/constants/events";
import { isWorkspaceForkSwitchEvent } from "./utils/workspaceEvents";
import {
  getAgentIdKey,
  getAgentsInitNudgeKey,
  getModelKey,
  getNotifyOnResponseKey,
  getProjectScopeId,
  getThinkingLevelByModelKey,
  getReasoningModeKey,
  getThinkingLevelKey,
  getWorkspaceAISettingsByAgentKey,
  getWorkspaceLastReadKey,
  EXPANDED_PROJECTS_KEY,
  LEFT_SIDEBAR_COLLAPSED_KEY,
  LEFT_SIDEBAR_WIDTH_KEY,
  SIDEBAR_FLAT_MODE_KEY,
} from "@/common/constants/storage";
import { normalizeToCanonical } from "@/common/utils/ai/models";
import { getDefaultModel } from "@/browser/hooks/useModelsFromSettings";
import type { BranchListResult } from "@/common/orpc/types";
import { useTelemetry } from "./hooks/useTelemetry";
import { getRuntimeTypeForTelemetry } from "@/common/telemetry";
import { useStartWorkspaceCreation } from "./hooks/useStartWorkspaceCreation";
import { useAPI } from "@/browser/contexts/API";
import { requestActiveTurnThinkingLevel } from "@/browser/utils/activeTurnThinking";
import {
  clearPendingWorkspaceAiSettings,
  markPendingWorkspaceAiSettings,
  resolveEffectiveComposerModel,
} from "@/browser/utils/workspaceAiSettingsSync";
import { AuthTokenModal } from "@/browser/components/AuthTokenModal/AuthTokenModal";

import { ScratchPage } from "@/browser/components/ScratchPage/ScratchPage";
import type { FrontendWorkspaceMetadata } from "@/common/types/workspace";
import type { WorkspaceCreatedOptions } from "@/browser/features/ChatInput/types";
import { SCRATCH_PROJECT_CONFIG_KEY } from "@/common/constants/scratch";
import { ProjectPage } from "@/browser/components/ProjectPage/ProjectPage";

import { SettingsProvider, useSettings } from "./contexts/SettingsContext";
import { AboutDialogProvider } from "./contexts/AboutDialogContext";
import { ConfirmDialogProvider, useConfirmDialog } from "./contexts/ConfirmDialogContext";
import { AboutDialog } from "./features/About/AboutDialog";
import { SettingsPage } from "@/browser/features/Settings/SettingsPage";
import { AnalyticsDashboard } from "@/browser/features/Analytics/AnalyticsDashboard";
import { MuxGatewaySessionExpiredDialog } from "./components/MuxGatewaySessionExpiredDialog/MuxGatewaySessionExpiredDialog";
import { SshPromptDialog } from "./components/SshPromptDialog/SshPromptDialog";
import { SplashScreenProvider } from "./features/SplashScreens/SplashScreenProvider";
import { TutorialProvider } from "./contexts/TutorialContext";
import { PowerModeProvider } from "./contexts/PowerModeContext";
import { TooltipProvider } from "./components/Tooltip/Tooltip";
import { UILayoutsProvider, useUILayouts } from "@/browser/contexts/UILayoutsContext";
import { ExperimentsProvider } from "./contexts/ExperimentsContext";
import { ProviderOptionsProvider } from "./contexts/ProviderOptionsContext";
import { getWorkspaceSidebarKey } from "./utils/workspace";
import { WindowsToolchainBanner } from "./components/WindowsToolchainBanner/WindowsToolchainBanner";
import { RosettaBanner } from "./components/RosettaBanner/RosettaBanner";

import { useExperimentValue } from "@/browser/hooks/useExperiments";
import { useProvidersConfig } from "@/browser/hooks/useProvidersConfig";
import { useRouting } from "@/browser/hooks/useRouting";
import { EXPERIMENT_IDS } from "@/common/constants/experiments";
import { getErrorMessage } from "@/common/utils/errors";
import assert from "@/common/utils/assert";
import { createProjectRefs } from "@/common/utils/multiProject";
import { MULTI_PROJECT_SIDEBAR_SECTION_ID } from "@/common/constants/multiProject";
import { WORKSPACE_DEFAULTS } from "@/constants/workspaceDefaults";
import { isDesktopMode } from "@/browser/hooks/useDesktopTitlebar";
import { prependInitialAppProxyBasePath } from "@/browser/utils/frontendBasePath";
import { WorkspaceActiveGoalsWarningToast } from "@/browser/components/ActiveGoalsWarningToast/ActiveGoalsWarningToast";
import { LoadingScreen } from "@/browser/components/LoadingScreen/LoadingScreen";

function RootRouteShell(props: {
  leftSidebarCollapsed: boolean;
  onToggleLeftSidebarCollapsed: () => void;
}) {
  return (
    <div className="bg-surface-primary flex flex-1 flex-col overflow-hidden">
      {props.leftSidebarCollapsed ? (
        <div
          className={`bg-sidebar border-border-light flex shrink-0 items-center border-b px-4 py-2 ${isDesktopMode() ? "titlebar-drag" : ""}`}
        >
          <button
            type="button"
            onClick={props.onToggleLeftSidebarCollapsed}
            className={`border-border-medium bg-background-secondary text-foreground hover:bg-hover rounded-md border px-3 py-1.5 text-sm transition-colors ${isDesktopMode() ? "titlebar-no-drag" : ""}`}
            aria-label="Open sidebar menu"
          >
            Open sidebar
          </button>
        </div>
      ) : null}
      <div className="flex flex-1 items-center justify-center px-6">
        <p className="text-muted text-sm">Select or add a project to get started.</p>
      </div>
    </div>
  );
}

function AppInner() {
  // Get workspace state from context
  const {
    workspaceMetadata,
    loading,
    setWorkspaceMetadata,
    removeWorkspace,
    updateWorkspaceTitle,
    reorderPinnedWorkspaces,
    selectedWorkspace,
    setSelectedWorkspace,
    pendingNewWorkspaceProject,
    pendingNewWorkspaceSubProjectPath,
    pendingNewWorkspaceDraftId,
    createWorkspaceDraft,
    beginWorkspaceCreation,
  } = useWorkspaceContext();
  const {
    currentWorkspaceId,
    currentSettingsSection,
    isAnalyticsOpen,
    navigateToAnalytics,
    navigateFromAnalytics,
  } = useRouter();
  const { themePreference, setTheme, toggleTheme } = useTheme();
  const { open: openSettings, isOpen: isSettingsOpen } = useSettings();
  const { confirm: confirmDialog } = useConfirmDialog();
  const setThemePreference = useCallback(
    (nextTheme: ThemePreference) => {
      setTheme(nextTheme);
    },
    [setTheme]
  );
  const { layoutPresets, applySlotToWorkspace, saveCurrentWorkspaceToSlot } = useUILayouts();
  const { getMinOverride: getMinThinkingOverride } = useMinThinkingLevels();
  const { api, status, error, authenticate, retry } = useAPI();

  const {
    userProjects,
    getProjectConfig,
    refreshProjects,
    removeProject,
    openProjectCreateModal,
    projectCreateInitialPath,
    isProjectCreateModalOpen,
    closeProjectCreateModal,
    addProject,
  } = useProjectContext();

  // Auto-collapse sidebar on mobile by default
  const isMobile = typeof window !== "undefined" && window.innerWidth <= 768;
  const [sidebarCollapsed, setSidebarCollapsed] = usePersistedState(
    LEFT_SIDEBAR_COLLAPSED_KEY,
    isMobile,
    {
      listener: true,
    }
  );

  const [isMultiProjectWorkspaceModalOpen, setMultiProjectWorkspaceModalOpen] = useState(false);
  const multiProjectWorkspacesEnabled = useExperimentValue(EXPERIMENT_IDS.MULTI_PROJECT_WORKSPACES);
  const agentPluginsEnabled = useExperimentValue(EXPERIMENT_IDS.AGENT_PLUGINS);

  // Left sidebar is drag-resizable (mirrors RightSidebar). Width is persisted globally;
  // collapse remains a separate toggle and the drag handle is hidden in mobile-touch overlay mode.
  const leftSidebar = useResizableSidebar({
    enabled: true,
    defaultWidth: LEFT_SIDEBAR_DEFAULT_WIDTH_PX,
    minWidth: LEFT_SIDEBAR_MIN_WIDTH_PX,
    maxWidth: LEFT_SIDEBAR_MAX_WIDTH_PX,
    // Keep enough room for the main content so you can't drag-resize the left sidebar
    // to a point where the chat pane becomes unusably narrow.
    getMaxWidthPx: () => {
      // Match LeftSidebar's mobile overlay gate. In that mode we don't want viewport-based clamping
      // because the sidebar width is controlled by CSS and shouldn't rewrite the user's desktop
      // width preference.
      const isMobileTouch =
        typeof window !== "undefined" &&
        window.matchMedia("(max-width: 768px) and (pointer: coarse)").matches;
      if (isMobileTouch) {
        return Number.POSITIVE_INFINITY;
      }

      const viewportWidth = typeof window !== "undefined" ? window.innerWidth : 1200;
      // ChatPane uses tailwind `min-w-96`.
      return viewportWidth - 384;
    },
    storageKey: LEFT_SIDEBAR_WIDTH_KEY,
    side: "left",
  });
  // Sync sidebar collapse state to the root element for non-React consumers like
  // Storybook play helpers that need to know whether the sidebar is currently collapsed.
  useEffect(() => {
    document.documentElement.dataset.leftSidebarCollapsed = String(sidebarCollapsed);
  }, [sidebarCollapsed]);
  const creationProjectPath =
    !selectedWorkspace && !currentWorkspaceId ? pendingNewWorkspaceProject : null;
  // Sub-project creation shares the owning parent's model preference, matching ChatInput.
  const creationScope = creationProjectPath
    ? resolveWorkspaceCreationScope(
        creationProjectPath,
        userProjects,
        pendingNewWorkspaceSubProjectPath
      )
    : null;
  const creationScopeId = creationScope ? getProjectScopeId(creationScope.projectPath) : null;
  const accountWorkspaceId = selectedWorkspace?.workspaceId ?? currentWorkspaceId;
  const accountProjectPath = getCodexOauthProjectPath(
    accountWorkspaceId
      ? (workspaceMetadata.get(accountWorkspaceId) ?? selectedWorkspace)
      : {
          projectPath: creationScope?.projectPath,
          subProjectPath: creationScope?.subProjectPath ?? undefined,
        }
  );
  const codexOauthAccountId = accountProjectPath
    ? getProjectConfig(accountProjectPath)?.codexOauthAccountId
    : undefined;

  // History navigation (back/forward)
  const navigate = useNavigate();
  const location = useLocation();
  const locationRef = useRef(location);
  locationRef.current = location;

  const startWorkspaceCreation = useStartWorkspaceCreation({
    projects: userProjects,
    beginWorkspaceCreation,
  });

  // ProjectPage handles its own focus when mounted

  const handleToggleSidebar = useCallback(() => {
    setSidebarCollapsed((prev) => !prev);
  }, [setSidebarCollapsed]);

  // Telemetry tracking
  const telemetry = useTelemetry();

  // Get workspace store for command palette
  const workspaceStore = useWorkspaceStoreRaw();

  const handleWorkspaceCreated = (
    metadata: FrontendWorkspaceMetadata,
    options?: WorkspaceCreatedOptions
  ) => {
    workspaceStore.addWorkspace(metadata);
    setWorkspaceMetadata((prev) => new Map(prev).set(metadata.id, metadata));

    if (options?.autoNavigate !== false) {
      let createdSelection: WorkspaceSelection | null = null;
      setSelectedWorkspace((current) => {
        if (current !== null) return current;
        createdSelection = toWorkspaceSelection(metadata);
        return createdSelection;
      });

      if (createdSelection && options?.markPendingInitialSend !== false) {
        workspaceStore.markPendingInitialSend(metadata.id, options?.pendingStreamModel ?? null);
      }
    }

    telemetry.workspaceCreated(metadata.id, getRuntimeTypeForTelemetry(metadata.runtimeConfig));
  };

  // Track telemetry when workspace selection changes
  const prevWorkspaceRef = useRef<WorkspaceSelection | null>(null);
  // Ref for selectedWorkspace to access in callbacks without stale closures
  const selectedWorkspaceRef = useRef(selectedWorkspace);
  selectedWorkspaceRef.current = selectedWorkspace;
  // Ref for route-level workspace visibility to avoid stale closure in response callbacks
  const currentWorkspaceIdRef = useRef(currentWorkspaceId);
  currentWorkspaceIdRef.current = currentWorkspaceId;
  useEffect(() => {
    const prev = prevWorkspaceRef.current;
    if (prev && selectedWorkspace && prev.workspaceId !== selectedWorkspace.workspaceId) {
      telemetry.workspaceSwitched(prev.workspaceId, selectedWorkspace.workspaceId);
    }
    prevWorkspaceRef.current = selectedWorkspace;
  }, [selectedWorkspace, telemetry]);

  // Track last-read timestamps for unread indicators.
  // Read-marking is gated on chat-route visibility (currentWorkspaceId).
  useUnreadTracking(selectedWorkspace, currentWorkspaceId);

  const workspaceMetadataRef = useRef(workspaceMetadata);
  useEffect(() => {
    workspaceMetadataRef.current = workspaceMetadata;
  }, [workspaceMetadata]);

  // Update window title based on selected workspace
  // URL syncing is now handled by RouterContext
  useEffect(() => {
    if (selectedWorkspace) {
      // Update window title with workspace title (or name for legacy workspaces)
      const metadata = workspaceMetadata.get(selectedWorkspace.workspaceId);
      const workspaceTitle = metadata?.title ?? metadata?.name ?? selectedWorkspace.workspaceId;
      const title = `${workspaceTitle} - ${selectedWorkspace.projectName} - ${XUM_PRODUCT_SLUG}`;
      // Set document.title locally for browser mode, call backend for Electron
      document.title = title;
      void api?.window.setTitle({ title });
    } else {
      // Set document.title locally for browser mode, call backend for Electron
      document.title = XUM_PRODUCT_SLUG;
      void api?.window.setTitle({ title: XUM_PRODUCT_SLUG });
    }
  }, [selectedWorkspace, workspaceMetadata, api]);

  // Validate selected workspace exists and has all required fields
  // Note: workspace validity is now primarily handled by RouterContext deriving
  // selectedWorkspace from URL + metadata. This effect handles edge cases like
  // stale localStorage or missing fields in legacy workspaces.
  useEffect(() => {
    if (selectedWorkspace) {
      const metadata = workspaceMetadata.get(selectedWorkspace.workspaceId);

      if (!metadata) {
        // Workspace metadata disappeared while this route was active. Clear the stale
        // selection so the router can self-heal to the compatibility root route.
        console.warn(
          `Workspace ${selectedWorkspace.workspaceId} no longer exists, clearing selection`
        );
        setSelectedWorkspace(null);
      } else if (!selectedWorkspace.namedWorkspacePath && metadata.namedWorkspacePath) {
        // Old localStorage entry missing namedWorkspacePath - update it once
        console.log(`Updating workspace ${selectedWorkspace.workspaceId} with missing fields`);
        setSelectedWorkspace(toWorkspaceSelection(metadata));
      }
    }
  }, [selectedWorkspace, workspaceMetadata, setSelectedWorkspace]);

  const openWorkspaceInTerminal = useOpenTerminal();

  const handleRemoveProject = useCallback(
    async (path: string) => {
      if (selectedWorkspace?.projectPath === path) {
        setSelectedWorkspace(null);
      }
      return removeProject(path);
    },
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [selectedWorkspace, setSelectedWorkspace]
  );

  // Memoize callbacks to prevent LeftSidebar/ProjectSidebar re-renders

  // NEW: Get workspace recency from store
  const workspaceRecency = useWorkspaceRecency();

  // Build sorted workspaces map including pending workspaces
  // Use stable reference to prevent sidebar re-renders when sort order hasn't changed
  const sortedWorkspacesByProject = useStableReference(
    () => buildSortedWorkspacesByProject(userProjects, workspaceMetadata, workspaceRecency),
    (prev, next) =>
      compareMaps(prev, next, (a, b) => {
        if (a.length !== b.length) return false;
        return a.every((meta, i) => {
          const other = b[i];
          // Compare all fields that affect sidebar display.
          // If you add a new display-relevant field to WorkspaceMetadata,
          // add it to getWorkspaceSidebarKey() in src/browser/utils/workspace.ts
          return other && getWorkspaceSidebarKey(meta) === getWorkspaceSidebarKey(other);
        });
      }),
    [userProjects, workspaceMetadata, workspaceRecency]
  );

  const handleNavigateWorkspace = useCallback(
    (direction: "next" | "prev") => {
      // Read actual rendered workspace order from DOM — impossible to drift from sidebar.
      const visibleIds = getVisibleWorkspaceIds();
      if (visibleIds.length === 0) return;

      const currentIndex = selectedWorkspace
        ? visibleIds.indexOf(selectedWorkspace.workspaceId)
        : -1;

      let targetIndex: number;
      if (currentIndex === -1) {
        targetIndex = direction === "next" ? 0 : visibleIds.length - 1;
      } else if (direction === "next") {
        targetIndex = (currentIndex + 1) % visibleIds.length;
      } else {
        targetIndex = currentIndex === 0 ? visibleIds.length - 1 : currentIndex - 1;
      }

      const targetMeta = workspaceMetadata.get(visibleIds[targetIndex]);
      if (targetMeta) setSelectedWorkspace(toWorkspaceSelection(targetMeta));
    },
    [selectedWorkspace, workspaceMetadata, setSelectedWorkspace]
  );

  // Register command sources with registry
  const {
    registerSource,
    isOpen: isCommandPaletteOpen,
    open: openCommandPalette,
    close: closeCommandPalette,
  } = useCommandRegistry();

  /**
   * Get the selected model for a workspace, preserving explicit gateway prefixes.
   */
  const getModelForWorkspace = useCallback(
    (workspaceId: string): string => {
      const defaultModel = getDefaultModel();
      const preferredModel = readPersistedState<string | null>(getModelKey(workspaceId), null);
      const metadata = workspaceMetadata.get(workspaceId);
      const persistedAgentId =
        readPersistedState<string>(getAgentIdKey(workspaceId), WORKSPACE_DEFAULTS.agentId)
          .trim()
          .toLowerCase() || WORKSPACE_DEFAULTS.agentId;
      const agentId =
        metadata?.parentWorkspaceId != null && metadata.agentId
          ? metadata.agentId
          : persistedAgentId;
      return resolveEffectiveComposerModel(preferredModel, metadata, agentId, defaultModel);
    },
    [workspaceMetadata]
  );

  const getThinkingLevelForWorkspace = useCallback(
    (workspaceId: string): ThinkingLevel => {
      if (!workspaceId) {
        return "off";
      }

      const scopedKey = getThinkingLevelKey(workspaceId);
      const scoped = readPersistedState<ThinkingLevel | undefined>(scopedKey, undefined);
      if (scoped !== undefined) {
        return THINKING_LEVELS.includes(scoped) ? scoped : "off";
      }

      // Keep this render-time palette lookup pure. ThinkingProvider owns migration to the
      // workspace-scoped key, while the palette can read legacy values as a fallback.
      const model = getModelForWorkspace(workspaceId);
      const legacy = readPersistedState<ThinkingLevel | undefined>(
        getThinkingLevelByModelKey(model),
        undefined
      );
      if (legacy !== undefined && THINKING_LEVELS.includes(legacy)) {
        return legacy;
      }

      // Fallback: check canonical key for legacy entries stored before gateway-aware normalization.
      const canonicalModel = normalizeToCanonical(model);
      if (canonicalModel !== model) {
        const canonicalLegacy = readPersistedState<ThinkingLevel | undefined>(
          getThinkingLevelByModelKey(canonicalModel),
          undefined
        );
        if (canonicalLegacy !== undefined && THINKING_LEVELS.includes(canonicalLegacy)) {
          return canonicalLegacy;
        }
      }

      return "off";
    },
    [getModelForWorkspace]
  );

  // Pro mode is Responses-only; the palette command hides under chatCompletions
  // and on non-passthrough routes (mirroring the send path's header gating).
  const {
    config: providersConfig,
    refresh: refreshProvidersConfig,
    updateOptimistically,
  } = useProvidersConfig();
  const routing = useRouting();
  const getRouteForModel = useCallback(
    (canonicalModel: string) => routing.resolveRoute(canonicalModel).route,
    [routing]
  );

  const getReasoningModeForWorkspace = useCallback((workspaceId: string): OpenAIReasoningMode => {
    if (!workspaceId) {
      return "standard";
    }
    const stored = readPersistedState<OpenAIReasoningMode | null>(
      getReasoningModeKey(workspaceId),
      null
    );
    // Coerce untrusted persisted values so corrupt entries self-heal to "standard".
    return coerceOpenAIReasoningMode(stored) ?? "standard";
  }, []);

  const setThinkingLevelFromPalette = useCallback(
    (workspaceId: string, level: ThinkingLevel) => {
      if (!workspaceId) {
        return;
      }

      const normalized = THINKING_LEVELS.includes(level) ? level : "off";
      const model = getModelForWorkspace(workspaceId);
      const key = getThinkingLevelKey(workspaceId);
      // Carry the current pro-mode choice: the backend replaces the agent's
      // settings wholesale, so omitting reasoningMode would wipe it.
      const reasoningMode = getReasoningModeForWorkspace(workspaceId);

      // Use the utility function which handles localStorage and event dispatch
      // ThinkingProvider will pick this up via its listener
      updatePersistedState(key, normalized);

      type WorkspaceAISettingsByAgentCache = Partial<
        Record<
          string,
          { model: string; thinkingLevel: ThinkingLevel; reasoningMode?: OpenAIReasoningMode }
        >
      >;

      const normalizedAgentId =
        readPersistedState<string>(getAgentIdKey(workspaceId), WORKSPACE_DEFAULTS.agentId)
          .trim()
          .toLowerCase() || WORKSPACE_DEFAULTS.agentId;

      updatePersistedState<WorkspaceAISettingsByAgentCache>(
        getWorkspaceAISettingsByAgentKey(workspaceId),
        (prev) => {
          const record: WorkspaceAISettingsByAgentCache =
            prev && typeof prev === "object" ? prev : {};
          return {
            ...record,
            [normalizedAgentId]: { model, thinkingLevel: normalized, reasoningMode },
          };
        },
        {}
      );

      // Persist to backend so the palette change follows the workspace across devices.
      if (api) {
        markPendingWorkspaceAiSettings(workspaceId, normalizedAgentId, {
          model,
          thinkingLevel: normalized,
          reasoningMode,
        });

        api.workspace
          .updateAgentAISettings({
            workspaceId,
            agentId: normalizedAgentId,
            aiSettings: { model, thinkingLevel: normalized, reasoningMode },
          })
          .then((result) => {
            if (!result.success) {
              clearPendingWorkspaceAiSettings(workspaceId, normalizedAgentId);
            }
          })
          .catch(() => {
            clearPendingWorkspaceAiSettings(workspaceId, normalizedAgentId);
            // Best-effort only.
          });

        // Mid-turn change: also apply to the active turn's next model step so
        // the palette/keybind path behaves like the selector (ThinkingProvider).
        requestActiveTurnThinkingLevel(api, workspaceId, normalized);
      }

      // Dispatch toast notification event for UI feedback
      if (typeof window !== "undefined") {
        window.dispatchEvent(
          new CustomEvent(CUSTOM_EVENTS.THINKING_LEVEL_TOAST, {
            detail: { workspaceId, level: normalized },
          })
        );
      }
    },
    [api, getModelForWorkspace, getReasoningModeForWorkspace]
  );

  // Palette toggle for the OpenAI pro reasoning mode. Persists like the
  // thinking-level palette action: localStorage first (ThinkingProvider listens),
  // then best-effort backend sync with the full settings payload.
  const toggleReasoningModeFromPalette = useCallback(
    (workspaceId: string) => {
      if (!workspaceId) {
        return;
      }

      const next: OpenAIReasoningMode =
        getReasoningModeForWorkspace(workspaceId) === "pro" ? "standard" : "pro";
      const model = getModelForWorkspace(workspaceId);
      const thinkingLevel = getThinkingLevelForWorkspace(workspaceId);

      updatePersistedState(getReasoningModeKey(workspaceId), next);

      type WorkspaceAISettingsByAgentCache = Partial<
        Record<
          string,
          { model: string; thinkingLevel: ThinkingLevel; reasoningMode?: OpenAIReasoningMode }
        >
      >;

      const normalizedAgentId =
        readPersistedState<string>(getAgentIdKey(workspaceId), WORKSPACE_DEFAULTS.agentId)
          .trim()
          .toLowerCase() || WORKSPACE_DEFAULTS.agentId;

      updatePersistedState<WorkspaceAISettingsByAgentCache>(
        getWorkspaceAISettingsByAgentKey(workspaceId),
        (prev) => {
          const record: WorkspaceAISettingsByAgentCache =
            prev && typeof prev === "object" ? prev : {};
          return {
            ...record,
            [normalizedAgentId]: { model, thinkingLevel, reasoningMode: next },
          };
        },
        {}
      );

      if (api) {
        markPendingWorkspaceAiSettings(workspaceId, normalizedAgentId, {
          model,
          thinkingLevel,
          reasoningMode: next,
        });

        api.workspace
          .updateAgentAISettings({
            workspaceId,
            agentId: normalizedAgentId,
            aiSettings: { model, thinkingLevel, reasoningMode: next },
          })
          .then((result) => {
            if (!result.success) {
              clearPendingWorkspaceAiSettings(workspaceId, normalizedAgentId);
            }
          })
          .catch(() => {
            clearPendingWorkspaceAiSettings(workspaceId, normalizedAgentId);
            // Best-effort only.
          });
      }
    },
    [api, getModelForWorkspace, getReasoningModeForWorkspace, getThinkingLevelForWorkspace]
  );

  const getFastModeActive = useCallback(() => {
    const scopeId = selectedWorkspace?.workspaceId ?? creationScopeId;
    if (!scopeId || providersConfig == null) return false;

    const model = getModelForWorkspace(scopeId);
    const provider = getFastModeProvider(model, {
      providersConfig,
      resolvedRouteProvider: getRouteForModel(normalizeToCanonical(model)),
      codexOauthAccountId,
    });
    return provider != null && providersConfig[provider]?.serviceTier === "priority";
  }, [
    codexOauthAccountId,
    creationScopeId,
    getModelForWorkspace,
    getRouteForModel,
    providersConfig,
    selectedWorkspace,
  ]);

  const fastModeToggleInFlightRef = useRef(false);
  const toggleFastMode = useCallback(async () => {
    const scopeId = selectedWorkspace?.workspaceId ?? creationScopeId;
    if (!api || !scopeId || providersConfig == null || fastModeToggleInFlightRef.current) return;

    // Creation composers use the same project-scoped model preference as their selector,
    // so the global shortcut remains available before the first workspace exists.
    // Serialize requests so a quick double press cannot compute two writes from stale config.
    fastModeToggleInFlightRef.current = true;
    const model = getModelForWorkspace(scopeId);
    const provider = getFastModeProvider(model, {
      providersConfig,
      resolvedRouteProvider: getRouteForModel(normalizeToCanonical(model)),
      codexOauthAccountId,
    });
    if (provider == null) {
      fastModeToggleInFlightRef.current = false;
      return;
    }

    try {
      const providerConfig = providersConfig[provider];
      const change = await applyFastModeServiceTierChange(
        api.providers,
        provider,
        providerConfig?.serviceTier,
        providerConfig?.fastModePreviousServiceTier
      );
      if (change) {
        updateOptimistically(provider, {
          serviceTier: change.serviceTier,
          fastModePreviousServiceTier: change.previousServiceTier,
        });
      } else {
        await refreshProvidersConfig();
      }
    } catch {
      await refreshProvidersConfig();
    } finally {
      fastModeToggleInFlightRef.current = false;
    }
  }, [
    api,
    codexOauthAccountId,
    creationScopeId,
    getModelForWorkspace,
    getRouteForModel,
    providersConfig,
    refreshProvidersConfig,
    selectedWorkspace,
    updateOptimistically,
  ]);

  const registerParamsRef = useRef<BuildSourcesParams | null>(null);

  const openNewScratchFromPalette = useCallback(() => {
    createWorkspaceDraft(SCRATCH_PROJECT_CONFIG_KEY);
  }, [createWorkspaceDraft]);

  const openNewWorkspaceFromPalette = useCallback(
    (projectPath: string) => {
      startWorkspaceCreation(projectPath);
    },
    [startWorkspaceCreation]
  );

  const openNewMultiProjectWorkspaceFromPalette = useCallback(() => {
    if (!multiProjectWorkspacesEnabled) {
      return;
    }
    setMultiProjectWorkspaceModalOpen(true);
  }, [multiProjectWorkspacesEnabled]);

  useEffect(() => {
    if (multiProjectWorkspacesEnabled || !isMultiProjectWorkspaceModalOpen) {
      return;
    }

    setMultiProjectWorkspaceModalOpen(false);
  }, [isMultiProjectWorkspaceModalOpen, multiProjectWorkspacesEnabled]);

  const createMultiProjectWorkspace = useCallback(
    async (projectPaths: string[]) => {
      assert(
        projectPaths.length >= 2,
        "createMultiProjectWorkspace requires at least two projects"
      );
      if (!api) {
        throw new Error("Not connected to server");
      }

      const [primaryProjectPath] = projectPaths;
      assert(primaryProjectPath, "createMultiProjectWorkspace requires a primary project");

      const branchResult = await api.projects.listBranches({ projectPath: primaryProjectPath });
      const candidateBranches = branchResult.branches.filter(
        (branch): branch is string => typeof branch === "string"
      );
      const trunkBranch =
        (branchResult.recommendedTrunk && candidateBranches.includes(branchResult.recommendedTrunk)
          ? branchResult.recommendedTrunk
          : candidateBranches[0]) ?? null;
      if (!trunkBranch) {
        const primaryProjectName =
          primaryProjectPath.split("/").pop() ??
          primaryProjectPath.split("\\").pop() ??
          primaryProjectPath;
        throw new Error(
          `No branches found for ${primaryProjectName}. Initialize a git repository before creating a multi-project workspace.`
        );
      }

      // Multi-project container names must stay unique and path-separator-free.
      const projects = createProjectRefs(projectPaths);

      const metadata = await api.workspace.createMultiProject({
        projects,
        branchName: `multi-${Date.now().toString(36)}`,
        trunkBranch,
      });

      // Make the synthetic section visible immediately after creation.
      updatePersistedState<string[]>(
        EXPANDED_PROJECTS_KEY,
        (prev) => {
          const expanded = Array.isArray(prev) ? prev : [];
          return expanded.includes(MULTI_PROJECT_SIDEBAR_SECTION_ID)
            ? expanded
            : [...expanded, MULTI_PROJECT_SIDEBAR_SECTION_ID];
        },
        []
      );

      // Inline workspace creation bookkeeping (main removed the extracted callback)
      workspaceStore.addWorkspace(metadata);
      setWorkspaceMetadata((prev) => new Map(prev).set(metadata.id, metadata));
      telemetry.workspaceCreated(metadata.id, getRuntimeTypeForTelemetry(metadata.runtimeConfig));
      setSelectedWorkspace(toWorkspaceSelection(metadata));
      setMultiProjectWorkspaceModalOpen(false);
    },
    [api, setSelectedWorkspace, setWorkspaceMetadata, telemetry, workspaceStore]
  );

  const archiveMergedWorkspacesInProjectFromPalette = useCallback(
    async (projectPath: string): Promise<void> => {
      const trimmedProjectPath = projectPath.trim();
      if (!trimmedProjectPath) return;

      if (!api) {
        if (typeof window !== "undefined") {
          window.alert("Cannot archive merged workspaces: API not connected");
        }
        return;
      }

      try {
        const result = await api.workspace.archiveMergedInProject({
          projectPath: trimmedProjectPath,
        });

        if (!result.success) {
          if (typeof window !== "undefined") {
            window.alert(result.error);
          }
          return;
        }

        const errorCount = result.data.errors.length;
        if (errorCount > 0) {
          const archivedCount = result.data.archivedWorkspaceIds.length;
          const skippedCount = result.data.skippedWorkspaceIds.length;

          const MAX_ERRORS_TO_SHOW = 5;
          const shownErrors = result.data.errors
            .slice(0, MAX_ERRORS_TO_SHOW)
            .map((e) => `- ${e.workspaceId}: ${e.error}`)
            .join("\n");
          const remainingCount = Math.max(0, errorCount - MAX_ERRORS_TO_SHOW);
          const remainingSuffix = remainingCount > 0 ? `\n… and ${remainingCount} more.` : "";

          if (typeof window !== "undefined") {
            window.alert(
              `Archived merged workspaces with some errors.\n\nArchived: ${archivedCount}\nSkipped: ${skippedCount}\nErrors: ${errorCount}\n\nErrors:\n${shownErrors}${remainingSuffix}`
            );
          }
        }
      } catch (error) {
        const message = getErrorMessage(error);
        if (typeof window !== "undefined") {
          window.alert(message);
        }
      }
    },
    [api]
  );

  const getBranchesForProject = useCallback(
    async (projectPath: string): Promise<BranchListResult> => {
      if (!api) {
        return { branches: [], recommendedTrunk: null };
      }
      const branchResult = await api.projects.listBranches({ projectPath });
      const sanitizedBranches = branchResult.branches.filter(
        (branch): branch is string => typeof branch === "string"
      );

      const recommended =
        branchResult.recommendedTrunk && sanitizedBranches.includes(branchResult.recommendedTrunk)
          ? branchResult.recommendedTrunk
          : (sanitizedBranches[0] ?? null);

      return {
        branches: sanitizedBranches,
        recommendedTrunk: recommended,
      };
    },
    [api]
  );

  const selectWorkspaceFromPalette = useCallback(
    (selection: WorkspaceSelection) => {
      setSelectedWorkspace(selection);
    },
    [setSelectedWorkspace]
  );

  const removeWorkspaceFromPalette = useCallback(
    async (workspaceId: string) => removeWorkspace(workspaceId),
    [removeWorkspace]
  );

  const updateTitleFromPalette = useCallback(
    async (workspaceId: string, newTitle: string) => updateWorkspaceTitle(workspaceId, newTitle),
    [updateWorkspaceTitle]
  );

  const addProjectFromPalette = useCallback(() => {
    openProjectCreateModal();
  }, [openProjectCreateModal]);

  const removeProjectFromPalette = useCallback(
    (path: string) => {
      void handleRemoveProject(path);
    },
    [handleRemoveProject]
  );

  const toggleSidebarFromPalette = useCallback(() => {
    setSidebarCollapsed((prev) => !prev);
  }, [setSidebarCollapsed]);

  const navigateWorkspaceFromPalette = useCallback(
    (dir: "next" | "prev") => {
      handleNavigateWorkspace(dir);
    },
    [handleNavigateWorkspace]
  );

  // Move the selected pinned chat within its visual pinned block. Shares the
  // move-order helper with the sidebar keybind handler so palette and keyboard
  // behavior can't drift apart.
  const movePinnedChatFromPalette = useCallback(
    (direction: PinnedMoveDirection) => {
      if (!selectedWorkspace) return;
      const meta = workspaceMetadata.get(selectedWorkspace.workspaceId);
      if (!meta) return;
      const order = computePinnedMoveOrderForWorkspace(
        meta,
        direction,
        sortedWorkspacesByProject,
        userProjects,
        readPersistedState(SIDEBAR_FLAT_MODE_KEY, false)
          ? { multiProjectEnabled: multiProjectWorkspacesEnabled }
          : false
      );
      if (order) void reorderPinnedWorkspaces(order);
    },
    [
      selectedWorkspace,
      workspaceMetadata,
      sortedWorkspacesByProject,
      userProjects,
      multiProjectWorkspacesEnabled,
      reorderPinnedWorkspaces,
    ]
  );

  registerParamsRef.current = {
    userProjects,
    workspaceMetadata,
    selectedWorkspace,
    creationScopeId,
    codexOauthAccountId,
    themePreference,
    getThinkingLevel: getThinkingLevelForWorkspace,
    onSetThinkingLevel: setThinkingLevelFromPalette,
    getReasoningMode: getReasoningModeForWorkspace,
    onToggleReasoningMode: toggleReasoningModeFromPalette,
    getFastMode: getFastModeActive,
    onToggleFastMode: toggleFastMode,
    getEffectiveComposerModel: getModelForWorkspace,
    providersConfig,
    getRouteForModel,
    getMinThinkingOverride,
    onStartScratchCreation: openNewScratchFromPalette,
    onStartWorkspaceCreation: openNewWorkspaceFromPalette,
    onStartMultiProjectWorkspaceCreation: openNewMultiProjectWorkspaceFromPalette,
    multiProjectWorkspacesEnabled,
    agentPluginsEnabled,
    onArchiveMergedWorkspacesInProject: archiveMergedWorkspacesInProjectFromPalette,
    getBranchesForProject,
    onSelectWorkspace: selectWorkspaceFromPalette,
    onRemoveWorkspace: removeWorkspaceFromPalette,
    onUpdateTitle: updateTitleFromPalette,
    onAddProject: addProjectFromPalette,
    onRemoveProject: removeProjectFromPalette,
    onToggleSidebar: toggleSidebarFromPalette,
    onNavigateWorkspace: navigateWorkspaceFromPalette,
    onMovePinnedChat: movePinnedChatFromPalette,
    onOpenWorkspaceInTerminal: (workspaceId, runtimeConfig) => {
      // Best-effort only. Palette actions should never throw.
      void openWorkspaceInTerminal(workspaceId, runtimeConfig).catch(() => {
        // Errors are surfaced elsewhere (toasts/logs) and users can retry.
      });
    },
    onToggleTheme: toggleTheme,
    onSetTheme: setThemePreference,
    onOpenSettings: openSettings,
    layoutPresets,
    onApplyLayoutSlot: (workspaceId, slot) => {
      void applySlotToWorkspace(workspaceId, slot).catch(() => {
        // Best-effort only.
      });
    },
    onCaptureLayoutSlot: async (workspaceId, slot, name) => {
      try {
        await saveCurrentWorkspaceToSlot(workspaceId, slot, name);
      } catch {
        // Best-effort only.
      }
    },
    onClearTimingStats: (workspaceId: string) => workspaceStore.clearTimingStats(workspaceId),
    api,
    confirmDialog,
  };

  useEffect(() => {
    const unregister = registerSource(() => {
      const params = registerParamsRef.current;
      if (!params) return [];

      // Compute streaming models here (only when command palette opens)
      const allStates = workspaceStore.getAllStates();
      const selectedWorkspaceState = params.selectedWorkspace
        ? (allStates.get(params.selectedWorkspace.workspaceId) ?? null)
        : null;
      const streamingModels = new Map<string, string>();
      for (const [workspaceId, state] of allStates) {
        if (state.canInterrupt && state.currentModel) {
          streamingModels.set(workspaceId, state.currentModel);
        }
      }

      const factories = buildCoreSources({
        ...params,
        streamingModels,
        selectedWorkspaceState,
      });
      const actions: CommandAction[] = [];
      for (const factory of factories) {
        actions.push(...factory());
      }
      return actions;
    });
    return unregister;
  }, [registerSource, workspaceStore]);

  // Handle keyboard shortcuts
  useEffect(() => {
    const handleKeyDown = (e: KeyboardEvent) => {
      if (e.defaultPrevented) {
        return;
      }

      if (matchesKeybind(e, KEYBINDS.NEW_SCRATCH_CHAT)) {
        e.preventDefault();
        openNewScratchFromPalette();
      } else if (matchesKeybind(e, KEYBINDS.NEXT_WORKSPACE)) {
        e.preventDefault();
        handleNavigateWorkspace("next");
      } else if (matchesKeybind(e, KEYBINDS.PREV_WORKSPACE)) {
        e.preventDefault();
        handleNavigateWorkspace("prev");
      } else if (
        matchesKeybind(e, KEYBINDS.OPEN_COMMAND_PALETTE) ||
        matchesKeybind(e, KEYBINDS.OPEN_COMMAND_PALETTE_ACTIONS)
      ) {
        e.preventDefault();
        if (isCommandPaletteOpen) {
          closeCommandPalette();
        } else {
          // Alternate palette shortcut opens in command mode (with ">") while the
          // primary Ctrl/Cmd+Shift+P shortcut opens default workspace-switch mode.
          const initialQuery = matchesKeybind(e, KEYBINDS.OPEN_COMMAND_PALETTE_ACTIONS)
            ? ">"
            : undefined;
          openCommandPalette(initialQuery);
        }
      } else if (matchesKeybind(e, KEYBINDS.TOGGLE_FAST_MODE)) {
        e.preventDefault();
        toggleFastMode().catch(() => undefined);
      } else if (matchesKeybind(e, KEYBINDS.TOGGLE_SIDEBAR)) {
        e.preventDefault();
        setSidebarCollapsed((prev) => !prev);
      } else if (matchesKeybind(e, KEYBINDS.OPEN_SETTINGS)) {
        e.preventDefault();
        openSettings();
      } else if (matchesKeybind(e, KEYBINDS.OPEN_ANALYTICS)) {
        e.preventDefault();
        if (isAnalyticsOpen) {
          navigateFromAnalytics();
        } else {
          navigateToAnalytics();
        }
      } else if (matchesKeybind(e, KEYBINDS.NAVIGATE_BACK)) {
        e.preventDefault();
        void navigate(-1);
      } else if (matchesKeybind(e, KEYBINDS.NAVIGATE_FORWARD)) {
        e.preventDefault();
        void navigate(1);
      }
    };

    window.addEventListener("keydown", handleKeyDown);
    return () => window.removeEventListener("keydown", handleKeyDown);
  }, [
    openNewScratchFromPalette,
    handleNavigateWorkspace,
    setSidebarCollapsed,
    isCommandPaletteOpen,
    closeCommandPalette,
    openCommandPalette,
    toggleFastMode,
    openSettings,
    isAnalyticsOpen,
    navigateToAnalytics,
    navigateFromAnalytics,
    navigate,
  ]);
  // Mouse back/forward buttons (buttons 3 and 4)
  useEffect(() => {
    const handleMouseNavigation = (e: MouseEvent) => {
      if (e.button === 3) {
        e.preventDefault();
        void navigate(-1);
      } else if (e.button === 4) {
        e.preventDefault();
        void navigate(1);
      }
    };

    // Capture phase fires before Chrome's default back/forward handling
    window.addEventListener("mousedown", handleMouseNavigation, true);
    return () => window.removeEventListener("mousedown", handleMouseNavigation, true);
  }, [navigate]);

  useEffect(() => {
    // Only needed in standalone PWA mode — normal browser tabs should have standard back/forward behavior
    const isStandalone = window.matchMedia("(display-mode: standalone)").matches;
    if (window.api || !isStandalone) return;

    // Push a dummy state so back button has somewhere to go without leaving the app
    window.history.pushState({ mux: true }, "", window.location.href);

    const handlePopState = () => {
      // Re-push the correct URL from MemoryRouter, not the popped browser URL
      const { pathname, search, hash } = locationRef.current;
      const correctUrl = new URL(
        prependInitialAppProxyBasePath(`${pathname}${search}${hash}`),
        window.location.origin
      );
      window.history.pushState({ mux: true }, "", correctUrl);
    };

    window.addEventListener("popstate", handlePopState);
    return () => window.removeEventListener("popstate", handlePopState);
  }, []);

  // Layout slot hotkeys (Ctrl/Cmd+Alt+1..9 by default)
  useEffect(() => {
    const handleKeyDownCapture = (e: KeyboardEvent) => {
      handleLayoutSlotHotkeys(e, {
        isCommandPaletteOpen,
        isSettingsOpen,
        selectedWorkspaceId: selectedWorkspace?.workspaceId ?? null,
        layoutPresets,
        applySlotToWorkspace,
      });
    };

    window.addEventListener("keydown", handleKeyDownCapture, { capture: true });
    return () => window.removeEventListener("keydown", handleKeyDownCapture, { capture: true });
  }, [
    isCommandPaletteOpen,
    isSettingsOpen,
    selectedWorkspace,
    layoutPresets,
    applySlotToWorkspace,
  ]);

  // Subscribe to menu bar "Open Settings" (macOS Cmd+, from app menu)
  useEffect(() => {
    if (!api) return;

    const abortController = new AbortController();
    const signal = abortController.signal;

    (async () => {
      try {
        const iterator = await api.menu.onOpenSettings(undefined, { signal });
        for await (const _ of iterator) {
          if (signal.aborted) break;
          openSettings();
        }
      } catch {
        // Subscription cancelled via abort signal - expected on cleanup
      }
    })();

    return () => abortController.abort();
  }, [api, openSettings]);

  // Handle workspace fork switch event
  useEffect(() => {
    const handleForkSwitch = (e: Event) => {
      if (!isWorkspaceForkSwitchEvent(e)) return;

      const workspaceInfo = e.detail;

      // Ensure the workspace's project is present in the sidebar config.
      //
      // IMPORTANT: don't early-return here. In practice this event can fire before
      // ProjectContext has finished loading (or before a refresh runs), and returning
      // would make the forked workspace appear "missing" until a later refresh.
      const project = userProjects.get(workspaceInfo.projectPath);
      if (!project) {
        console.warn(
          `[Frontend] Project not found for forked workspace path: ${workspaceInfo.projectPath} (will refresh)`
        );
        void refreshProjects();
      }

      // DEFENSIVE: Ensure createdAt exists
      if (!workspaceInfo.createdAt) {
        console.warn(
          `[Frontend] Workspace ${workspaceInfo.id} missing createdAt in fork switch - using default (2025-01-01)`
        );
        workspaceInfo.createdAt = "2025-01-01T00:00:00.000Z";
      }

      // Update metadata Map immediately (don't wait for async metadata event)
      // This ensures the title bar effect has the workspace name available
      setWorkspaceMetadata((prev) => {
        const updated = new Map(prev);
        updated.set(workspaceInfo.id, workspaceInfo);
        return updated;
      });

      // Switch to the new workspace
      setSelectedWorkspace(toWorkspaceSelection(workspaceInfo));
    };

    window.addEventListener(CUSTOM_EVENTS.WORKSPACE_FORK_SWITCH, handleForkSwitch as EventListener);
    return () =>
      window.removeEventListener(
        CUSTOM_EVENTS.WORKSPACE_FORK_SWITCH,
        handleForkSwitch as EventListener
      );
  }, [userProjects, refreshProjects, setSelectedWorkspace, setWorkspaceMetadata]);

  // Set up navigation callback for notification clicks
  useEffect(() => {
    const navigateToWorkspace = (workspaceId: string) => {
      const metadata = workspaceMetadataRef.current.get(workspaceId);
      if (metadata) {
        setSelectedWorkspace(toWorkspaceSelection(metadata));
      }
    };

    // Single source of truth: WorkspaceStore owns the navigation callback.
    // Browser notifications and Electron notification clicks both route through this.
    workspaceStore.setNavigateToWorkspace(navigateToWorkspace);

    // Callback for "notify on response" feature - fires when any assistant response completes.
    // Only notify when isFinal=true (assistant done with all work, no more active streams).
    // finalText is extracted by the aggregator (text after tool calls).
    // completion carries notification-policy metadata (compaction vs normal response,
    // and whether another queued/auto follow-up will immediately take over).
    const handleResponseComplete = (event: ResponseCompleteEvent) => {
      // Only notify on final message (when assistant is done with all work).
      if (!event.isFinal) {
        return;
      }

      // Only mark read when the user is actively viewing this workspace's chat.
      // Checking currentWorkspaceIdRef ensures we don't advance lastRead when
      // a non-chat route (e.g. /settings) is active — the workspace remains
      // "selected" but the chat content is not visible.
      const isChatVisible =
        document.hasFocus() && currentWorkspaceIdRef.current === event.workspaceId;
      if (event.completedAt != null && isChatVisible) {
        updatePersistedState(getWorkspaceLastReadKey(event.workspaceId), event.completedAt);
      }

      if (!shouldNotifyOnResponseComplete(event.completion)) {
        return;
      }

      // Skip notification if the selected workspace is focused (Slack-like behavior).
      // Notification suppression intentionally follows selection state, not chat-route visibility.
      const isWorkspaceFocused =
        document.hasFocus() && selectedWorkspaceRef.current?.workspaceId === event.workspaceId;
      if (isWorkspaceFocused) {
        return;
      }

      // Check if notifications are enabled for this workspace.
      const notifyEnabled = readPersistedState(getNotifyOnResponseKey(event.workspaceId), false);
      if (!notifyEnabled) {
        return;
      }

      const metadata = workspaceMetadataRef.current.get(event.workspaceId);
      const title = metadata?.title ?? metadata?.name ?? "Response complete";
      const body = getResponseCompleteNotificationBody(event.finalText, event.completion);

      showBrowserNotification(title, {
        body,
        onClick: () => {
          window.focus();
          navigateToWorkspace(event.workspaceId);
        },
      });
    };

    workspaceStore.setOnResponseComplete(handleResponseComplete);

    const unsubscribe = window.api?.onNotificationClicked?.((data) => {
      workspaceStore.navigateToWorkspace(data.workspaceId);
    });

    return () => {
      unsubscribe?.();
    };
  }, [setSelectedWorkspace, workspaceStore]);

  // Show auth modal if authentication is required
  if (status === "auth_required") {
    return (
      <AuthTokenModal
        isOpen={true}
        onSubmit={authenticate}
        onSessionAuthenticated={retry}
        error={error}
      />
    );
  }

  return (
    <>
      {/* mobile-bottom-inset-host: narrow layouts give this box's bottom inset up to a column that
          reserves its own clearance, keyed off the column rather than the route so surfaces without
          one still get it here. The sidebar is position: fixed with its own inset at these widths. */}
      <div className="bg-surface-primary mobile-layout mobile-bottom-inset-host flex h-full overflow-hidden pt-[env(safe-area-inset-top)] pr-[env(safe-area-inset-right)] pb-[min(env(safe-area-inset-bottom,0px),40px)] pl-[env(safe-area-inset-left)]">
        <LeftSidebar
          collapsed={sidebarCollapsed}
          onToggleCollapsed={handleToggleSidebar}
          widthPx={leftSidebar.width}
          isResizing={leftSidebar.isResizing}
          onStartResize={leftSidebar.startResize}
          sortedWorkspacesByProject={sortedWorkspacesByProject}
          workspaceRecency={workspaceRecency}
        />
        <div className="mobile-main-content flex min-w-0 flex-1 flex-col overflow-hidden">
          <WindowsToolchainBanner />
          <RosettaBanner />
          <div className="mobile-layout flex flex-1 overflow-hidden">
            {/* Route-driven settings and analytics render in the main pane so project/workspace navigation stays visible. */}
            {isAnalyticsOpen ? (
              <AnalyticsDashboard
                leftSidebarCollapsed={sidebarCollapsed}
                onToggleLeftSidebarCollapsed={handleToggleSidebar}
              />
            ) : currentSettingsSection ? (
              <SettingsPage
                leftSidebarCollapsed={sidebarCollapsed}
                onToggleLeftSidebarCollapsed={handleToggleSidebar}
              />
            ) : selectedWorkspace ? (
              (() => {
                const currentMetadata = workspaceMetadata.get(selectedWorkspace.workspaceId);
                // Guard: Don't render AIView if workspace metadata not found.
                // This can happen when selectedWorkspace (from localStorage) refers to a
                // deleted workspace, or during a race condition on reload before the
                // validation effect clears the stale selection.
                if (!currentMetadata) {
                  return null;
                }
                // Use metadata.name for workspace name (works for both worktree and local runtimes)
                // Fallback to path-based derivation for legacy compatibility
                const workspaceName =
                  currentMetadata.name ??
                  selectedWorkspace.namedWorkspacePath?.split("/").pop() ??
                  selectedWorkspace.workspaceId;
                // Use live metadata path (updates on rename) with fallback to initial path
                const workspacePath =
                  currentMetadata.namedWorkspacePath ?? selectedWorkspace.namedWorkspacePath ?? "";
                return (
                  <ErrorBoundary
                    workspaceInfo={`${selectedWorkspace.projectName}/${workspaceName}`}
                  >
                    <AIView
                      workspaceId={selectedWorkspace.workspaceId}
                      projectPath={selectedWorkspace.projectPath}
                      projectName={selectedWorkspace.projectName}
                      leftSidebarCollapsed={sidebarCollapsed}
                      onToggleLeftSidebarCollapsed={handleToggleSidebar}
                      workspaceName={workspaceName}
                      namedWorkspacePath={workspacePath}
                      runtimeConfig={currentMetadata.runtimeConfig}
                      incompatibleRuntime={currentMetadata.incompatibleRuntime}
                      isInitializing={currentMetadata.isInitializing === true}
                    />
                  </ErrorBoundary>
                );
              })()
            ) : currentWorkspaceId ? (
              loading ? (
                // Keep a lightweight loading shell while WorkspaceContext validates or
                // self-heals stale `/workspace/:id` routes. Restoring a path alone is not
                // enough; we only render AIView once metadata hydration confirms it exists.
                <LoadingScreen statusText="Opening workspace..." />
              ) : (
                // If metadata never hydrated for the routed workspace, avoid trapping the user
                // on a permanent spinner. Show the same non-blocking root shell while the route
                // waits for a later retry or manual navigation.
                <RootRouteShell
                  leftSidebarCollapsed={sidebarCollapsed}
                  onToggleLeftSidebarCollapsed={handleToggleSidebar}
                />
              )
            ) : creationProjectPath === SCRATCH_PROJECT_CONFIG_KEY ? (
              <ScratchPage
                leftSidebarCollapsed={sidebarCollapsed}
                onToggleLeftSidebarCollapsed={handleToggleSidebar}
                pendingDraftId={pendingNewWorkspaceDraftId}
                onWorkspaceCreated={handleWorkspaceCreated}
              />
            ) : creationProjectPath ? (
              <ProjectPage
                projectPath={creationProjectPath}
                projectName={
                  creationProjectPath.split("/").pop() ??
                  creationProjectPath.split("\\").pop() ??
                  "Project"
                }
                leftSidebarCollapsed={sidebarCollapsed}
                onToggleLeftSidebarCollapsed={handleToggleSidebar}
                pendingSubProjectPath={pendingNewWorkspaceSubProjectPath}
                pendingDraftId={pendingNewWorkspaceDraftId}
                onWorkspaceCreated={handleWorkspaceCreated}
              />
            ) : (
              // The dedicated Xum home page was removed. Keep `/` as a minimal shell so
              // WorkspaceContext can redirect it to a concrete project route when possible,
              // without reintroducing a sticky dashboard screen.
              <RootRouteShell
                leftSidebarCollapsed={sidebarCollapsed}
                onToggleLeftSidebarCollapsed={handleToggleSidebar}
              />
            )}
          </div>
        </div>
        <WorkspaceActiveGoalsWarningToast />
        <CommandPalette getSlashContext={() => ({ workspaceId: selectedWorkspace?.workspaceId })} />
        <ProjectCreateModal
          initialPath={projectCreateInitialPath}
          isOpen={isProjectCreateModalOpen}
          onClose={closeProjectCreateModal}
          onSuccess={(normalizedPath, projectConfig) => {
            addProject(normalizedPath, projectConfig);
            updatePersistedState(getAgentsInitNudgeKey(normalizedPath), true);
            // Auto-expand new project in sidebar
            updatePersistedState<string[]>(
              EXPANDED_PROJECTS_KEY,
              (prev) => [...(Array.isArray(prev) ? prev : []), normalizedPath],
              []
            );
            beginWorkspaceCreation(normalizedPath);
          }}
        />
        {multiProjectWorkspacesEnabled && (
          <MultiProjectWorkspaceCreateModal
            isOpen={isMultiProjectWorkspaceModalOpen}
            onClose={() => setMultiProjectWorkspaceModalOpen(false)}
            projectOptions={getTopLevelProjectEntries(userProjects).map(([projectPath]) => ({
              projectPath,
              projectName:
                projectPath.split("/").pop() ?? projectPath.split("\\").pop() ?? "Unnamed Project",
            }))}
            onConfirm={createMultiProjectWorkspace}
          />
        )}
        <AboutDialog />
        <MuxGatewaySessionExpiredDialog />
        <SshPromptDialog />
      </div>
    </>
  );
}

function App() {
  return (
    <ExperimentsProvider>
      <UILayoutsProvider>
        <TooltipProvider delayDuration={200}>
          <SettingsProvider>
            <AboutDialogProvider>
              <ProviderOptionsProvider>
                <SplashScreenProvider>
                  <TutorialProvider>
                    <CommandRegistryProvider>
                      <PowerModeProvider>
                        <ConfirmDialogProvider>
                          <AppInner />
                        </ConfirmDialogProvider>
                      </PowerModeProvider>
                    </CommandRegistryProvider>
                  </TutorialProvider>
                </SplashScreenProvider>
              </ProviderOptionsProvider>
            </AboutDialogProvider>
          </SettingsProvider>
        </TooltipProvider>
      </UILayoutsProvider>
    </ExperimentsProvider>
  );
}

export default App;

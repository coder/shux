import React, { useCallback, useEffect, useRef, useState } from "react";
import { Bell, BellOff, Ellipsis, Info, Menu, Pencil } from "lucide-react";
import { CUSTOM_EVENTS, createCustomEvent } from "@/common/constants/events";
import { EXPERIMENT_IDS } from "@/common/constants/experiments";
import { cn } from "@/common/lib/utils";
import { getErrorMessage } from "@/common/utils/errors";
import { isWorkspacePinnable, isWorkspacePinned } from "@/common/utils/pin";

import {
  RIGHT_SIDEBAR_COLLAPSED_KEY,
  getNotifyOnResponseKey,
  getNotifyOnResponseAutoEnableKey,
} from "@/common/constants/storage";
import { WorkspaceHeartbeatModal } from "../WorkspaceHeartbeatModal";
import { WorkspaceMCPModal } from "../WorkspaceMCPModal/WorkspaceMCPModal";
import { Tooltip, TooltipTrigger, TooltipContent } from "../Tooltip/Tooltip";
import { Popover, PopoverTrigger, PopoverContent } from "../Popover/Popover";
import { Checkbox } from "../Checkbox/Checkbox";
import {
  formatKeybind,
  isDialogOpen,
  isEditableElement,
  KEYBINDS,
  matchesKeybind,
} from "@/browser/utils/ui/keybinds";
import { useRuntimeStatus, useRuntimeStatusStoreRaw } from "@/browser/stores/RuntimeStatusStore";
import { useWorkspaceSidebarState } from "@/browser/stores/WorkspaceStore";
import { Button } from "@/browser/components/Button/Button";
import { isDevcontainerRuntime, type RuntimeConfig } from "@/common/types/runtime";
import { useTutorial } from "@/browser/contexts/TutorialContext";

import type { TerminalSessionCreateOptions } from "@/browser/utils/terminal";
import { useOpenTerminal } from "@/browser/hooks/useOpenTerminal";
import { useOpenInEditor } from "@/browser/hooks/useOpenInEditor";
import { usePersistedState } from "@/browser/hooks/usePersistedState";
import { usePopoverError } from "@/browser/hooks/usePopoverError";
import { isDesktopMode, DESKTOP_TITLEBAR_HEIGHT_CLASS } from "@/browser/hooks/useDesktopTitlebar";
import { useExperimentValue } from "@/browser/hooks/useExperiments";
import { DebugLlmRequestModal } from "../DebugLlmRequestModal/DebugLlmRequestModal";
import { ConfirmationModal } from "../ConfirmationModal/ConfirmationModal";
import { PopoverError } from "../PopoverError/PopoverError";
import { WorkspaceActionsMenuContent } from "../WorkspaceActionsMenuContent/WorkspaceActionsMenuContent";
import { WorkspaceTerminalIcon } from "../icons/WorkspaceTerminalIcon/WorkspaceTerminalIcon";
import { ArchiveIcon } from "../icons/ArchiveIcon/ArchiveIcon";

import { SkillIndicator } from "../SkillIndicator/SkillIndicator";
import { WorkspaceLinks } from "../WorkspaceLinks/WorkspaceLinks";
import { useAPI } from "@/browser/contexts/API";
import { useAgent } from "@/browser/contexts/AgentContext";

import { useWorkspaceActions, useWorkspaceContext } from "@/browser/contexts/WorkspaceContext";
import { useProjectContext } from "@/browser/contexts/ProjectContext";
import { formatProjectHierarchyLabel } from "@/common/utils/subProjects";
import { forkWorkspace } from "@/browser/utils/chatCommands";
import { SCRATCH_PROJECT_CONFIG_KEY, SCRATCH_PROJECT_NAME } from "@/common/constants/scratch";
import { hasWorkspaceRepository } from "@/browser/utils/workspaceCapabilities";
import { stopKeyboardPropagation } from "@/browser/utils/events";
import {
  NARROW_VIEWPORT_MAX_WIDTH_PX,
  WORKSPACE_MENU_BAR_LEFT_SIDEBAR_COLLAPSED_PADDING_PX,
} from "@/constants/layout";
import { TimelineDialog } from "@/browser/features/RightSidebar/Timeline/TimelineDialog";
import type { AgentSkillDescriptor, AgentSkillIssue } from "@/common/types/agentSkill";

interface WorkspaceMenuBarProps {
  workspaceId: string;
  projectName: string;
  projectPath: string;
  workspaceName: string;
  workspaceTitle?: string;
  namedWorkspacePath: string;
  runtimeConfig?: RuntimeConfig;
  leftSidebarCollapsed: boolean;
  onToggleLeftSidebarCollapsed: () => void;
  /** Callback to open integrated terminal in sidebar (optional, falls back to popout) */
  onOpenTerminal?: (options?: TerminalSessionCreateOptions) => void;
}

import {
  buildArchiveConfirmDescription,
  buildArchiveConfirmWarning,
} from "@/browser/utils/archiveConfirmation";

const COLLAPSED_LEFT_SIDEBAR_MENU_BAR_STYLE = {
  paddingLeft: `${WORKSPACE_MENU_BAR_LEFT_SIDEBAR_COLLAPSED_PADDING_PX}px`,
} as const;

export const WorkspaceMenuBar: React.FC<WorkspaceMenuBarProps> = ({
  workspaceId,
  projectName,
  projectPath,
  workspaceName,
  workspaceTitle,
  namedWorkspacePath,
  runtimeConfig,
  leftSidebarCollapsed,
  onToggleLeftSidebarCollapsed,
  onOpenTerminal,
}) => {
  const { api } = useAPI();
  const { disableWorkspaceAgents } = useAgent();
  const { preflightArchiveWorkspace, archiveWorkspace, archivingWorkspaceIds, setWorkspacePinned } =
    useWorkspaceActions();
  const isArchiving = archivingWorkspaceIds.has(workspaceId);
  const { workspaceMetadata } = useWorkspaceContext();
  const workspaceHeartbeatsEnabled = useExperimentValue(EXPERIMENT_IDS.WORKSPACE_HEARTBEATS);
  const timelineExperimentEnabled = useExperimentValue(EXPERIMENT_IDS.TIMELINE);
  const openTerminalPopout = useOpenTerminal();
  const openInEditor = useOpenInEditor();
  const runtimeStatus = useRuntimeStatus(workspaceId);
  const workspaceEntry = workspaceMetadata.get(workspaceId);
  const hasRepository = hasWorkspaceRepository(workspaceEntry);
  // The workspace's metadata.projectName is the parent project (since worktrees
  // are owned by the top-most parent). When the workspace is scoped to a
  // sub-project we surface the hierarchy as "parent / child" so the menu bar
  // alone reveals the sub-project context.
  const { userProjects } = useProjectContext();
  const subProjectPath = workspaceEntry?.subProjectPath;
  const projectLabel =
    workspaceEntry?.kind === "scratch"
      ? SCRATCH_PROJECT_NAME
      : subProjectPath && userProjects.has(subProjectPath)
        ? formatProjectHierarchyLabel(subProjectPath, userProjects)
        : projectName;
  const runtimeStatusStore = useRuntimeStatusStoreRaw();
  const { canInterrupt, isStarting, awaitingUserQuestion, loadedSkills, skillLoadErrors } =
    useWorkspaceSidebarState(workspaceId);
  const isWorking = (canInterrupt || isStarting) && !awaitingUserQuestion;
  const { startSequence: startTutorial } = useTutorial();
  const [editorError, setEditorError] = useState<string | null>(null);
  const [debugLlmRequestOpen, setDebugLlmRequestOpen] = useState(false);
  const [mcpModalOpen, setMcpModalOpen] = useState(false);
  const [heartbeatModalOpen, setHeartbeatModalOpen] = useState(false);
  // Keyed by workspace so switching workspaces (e.g. the timeline's "Open child
  // workspace" action) implicitly closes the dialog instead of covering the new view.
  const [timelineDialogWorkspaceId, setTimelineDialogWorkspaceId] = useState<string | null>(null);
  if (timelineDialogWorkspaceId !== null && timelineDialogWorkspaceId !== workspaceId) {
    // Render-time adjustment (not an effect): leaving the dialog's workspace closes it
    // for good; merely deriving open=false would reopen it when navigating back.
    setTimelineDialogWorkspaceId(null);
  }
  const timelineDialogOpen = timelineDialogWorkspaceId === workspaceId;
  const [availableSkills, setAvailableSkills] = useState<AgentSkillDescriptor[]>([]);
  const [invalidSkills, setInvalidSkills] = useState<AgentSkillIssue[]>([]);
  const isSkillsMountedRef = useRef(true);
  const moreActionsButtonRef = useRef<HTMLButtonElement | null>(null);
  const menuBarRef = useRef<HTMLDivElement | null>(null);

  const skillsRequestIdRef = useRef(0);
  const [moreMenuOpen, setMoreMenuOpen] = useState(false);
  const [archiveConfirmOpen, setArchiveConfirmOpen] = useState(false);
  // Untracked paths from archive preflight that the user needs to acknowledge.
  // When set, the confirmation dialog warns about permanent file deletion.
  const [archiveUntrackedPaths, setArchiveUntrackedPaths] = useState<string[] | null>(null);
  // Whether the confirmation includes an active-stream interruption warning.
  const [archiveConfirmIsStreaming, setArchiveConfirmIsStreaming] = useState(false);
  const archiveError = usePopoverError();
  const forkError = usePopoverError();
  const stopRuntimeError = usePopoverError();

  const [rightSidebarCollapsed] = usePersistedState<boolean>(RIGHT_SIDEBAR_COLLAPSED_KEY, false, {
    // This state is toggled from RightSidebar, so we need cross-component updates.
    listener: true,
  });

  // Notification on response toggle (workspace-level) - defaults to disabled
  const [notifyOnResponse, setNotifyOnResponse] = usePersistedState<boolean>(
    getNotifyOnResponseKey(workspaceId),
    false,
    { listener: true }
  );

  const notificationScope =
    workspaceEntry?.kind === "scratch" ? SCRATCH_PROJECT_CONFIG_KEY : projectPath;
  // Auto-enable notifications for new workspaces (project-level)
  const [autoEnableNotifications, setAutoEnableNotifications] = usePersistedState<boolean>(
    getNotifyOnResponseAutoEnableKey(notificationScope),
    false,
    { listener: true }
  );

  // Popover state for notification settings (interactive on click)
  const [notificationPopoverOpen, setNotificationPopoverOpen] = useState(false);
  const [detailsPopoverOpen, setDetailsPopoverOpen] = useState(false);
  const [detailsTooltipOpen, setDetailsTooltipOpen] = useState(false);

  const handleOpenTerminal = useCallback(() => {
    // On mobile touch devices, always use popout since the right sidebar is hidden
    const isMobileTouch = window.matchMedia("(max-width: 768px) and (pointer: coarse)").matches;
    if (onOpenTerminal && !isMobileTouch) {
      onOpenTerminal();
    } else {
      // Fallback to popout if no integrated terminal callback provided or on mobile
      void openTerminalPopout(workspaceId, runtimeConfig);
    }
  }, [workspaceId, openTerminalPopout, runtimeConfig, onOpenTerminal]);

  const isTouchMobileScreen =
    typeof window !== "undefined" &&
    window.matchMedia("(max-width: 768px) and (pointer: coarse)").matches;

  // The right sidebar (home of the Timeline tab) is CSS-hidden by two independent
  // rules: a viewport media query (<=768px, any pointer) and the workspace-shell
  // container query (<=684px shell, e.g. a ~900px window with the left sidebar
  // expanded). Read the sidebar's actual computed visibility so the timeline dialog
  // gate matches the CSS truth; fall back to the media query when no shell is in
  // the DOM (scratch pages, first render before refs attach, tests).
  const isTimelineSidebarHidden = useCallback((): boolean => {
    if (typeof window === "undefined") {
      return false;
    }
    const sidebar = menuBarRef.current
      ?.closest("[data-workspace-shell]")
      ?.querySelector(".mobile-hide-right-sidebar");
    if (sidebar instanceof HTMLElement) {
      // Immersive review hides the sidebar on any viewport (marked aria-hidden);
      // only a responsive hide should surface the dialog entry points.
      if (sidebar.getAttribute("aria-hidden") === "true") {
        return false;
      }
      return window.getComputedStyle(sidebar).display === "none";
    }
    return window.matchMedia(`(max-width: ${NARROW_VIEWPORT_MAX_WIDTH_PX}px)`).matches;
  }, []);

  // Keep the gate reactive: resizing re-evaluates CSS instantly, but a render-time read
  // would leave the More menu stale until an unrelated state update. The media-query
  // listener covers viewport transitions and the ResizeObserver covers the shell
  // container query (e.g. expanding the left sidebar squeezes the shell under 684px).
  const [timelineSidebarHidden, setTimelineSidebarHidden] = useState(false);
  useEffect(() => {
    const compute = () => setTimelineSidebarHidden(isTimelineSidebarHidden());
    compute();
    const mql = window.matchMedia(`(max-width: ${NARROW_VIEWPORT_MAX_WIDTH_PX}px)`);
    mql.addEventListener("change", compute);
    const shell = menuBarRef.current?.closest("[data-workspace-shell]");
    let resizeObserver: ResizeObserver | undefined;
    if (shell instanceof HTMLElement && typeof ResizeObserver !== "undefined") {
      resizeObserver = new ResizeObserver(compute);
      resizeObserver.observe(shell);
    }
    return () => {
      mql.removeEventListener("change", compute);
      resizeObserver?.disconnect();
    };
  }, [isTimelineSidebarHidden]);

  // The dialog is the only timeline entry point while the sidebar is hidden, and every
  // operation needs a keyboard shortcut. Evaluated at keydown time so the gate tracks
  // live viewport/layout changes without a resize subscription.
  useEffect(() => {
    if (!timelineExperimentEnabled) {
      return;
    }
    const handler = (e: KeyboardEvent) => {
      if (
        !matchesKeybind(e, KEYBINDS.OPEN_TIMELINE_DIALOG) ||
        isDialogOpen() ||
        isEditableElement(e.target) ||
        !isTimelineSidebarHidden()
      ) {
        return;
      }
      e.preventDefault();
      setTimelineDialogWorkspaceId(workspaceId);
    };
    window.addEventListener("keydown", handler);
    return () => window.removeEventListener("keydown", handler);
  }, [timelineExperimentEnabled, isTimelineSidebarHidden, workspaceId]);

  const isDevcontainerWorkspace = isDevcontainerRuntime(runtimeConfig);
  const isRuntimeRunning = isDevcontainerWorkspace && runtimeStatus === "running";

  const getMoreMenuAnchor = useCallback(() => {
    const rect = moreActionsButtonRef.current?.getBoundingClientRect();
    if (!rect) {
      return undefined;
    }

    return {
      top: rect.top + window.scrollY,
      left: rect.right + 10,
    };
  }, []);

  const handleOpenTouchFullscreenReview = useCallback(() => {
    window.dispatchEvent(
      createCustomEvent(CUSTOM_EVENTS.OPEN_TOUCH_REVIEW_IMMERSIVE, {
        workspaceId,
      })
    );
  }, [workspaceId]);

  const handleEnterImmersiveReview = useCallback(() => {
    window.dispatchEvent(createCustomEvent(CUSTOM_EVENTS.OPEN_REVIEW_IMMERSIVE, { workspaceId }));
  }, [workspaceId]);

  const handleOpenInEditor = useCallback(async () => {
    setEditorError(null);
    const result = await openInEditor(workspaceId, namedWorkspacePath, runtimeConfig);
    if (!result.success && result.error) {
      setEditorError(result.error);
      // Clear error after 3 seconds
      setTimeout(() => setEditorError(null), 3000);
    }
  }, [workspaceId, namedWorkspacePath, openInEditor, runtimeConfig]);

  // Mirror sidebar archive behavior so the workspace menu bar matches existing actions.
  /**
   * Execute the archive call (optionally with acknowledged untracked paths).
   * Callers are responsible for the isArchiving guard — this function only does the RPC
   * and error display. Called from handleArchiveChat (no-confirmation path) and from
   * the confirmation modal's onConfirm.
   */
  const executeArchive = useCallback(
    async (anchorEl?: HTMLElement, acknowledgedUntrackedPaths?: string[]) => {
      const res = await archiveWorkspace(
        workspaceId,
        acknowledgedUntrackedPaths ? { acknowledgedUntrackedPaths } : undefined
      );
      if (res.success && res.data?.kind === "confirm-lossy-untracked-files") {
        setArchiveUntrackedPaths(res.data.paths);
        // The retry path already handled any earlier streaming warning. Only surface the
        // interruption warning again when the archive attempt has not yet been confirmed.
        setArchiveConfirmIsStreaming(acknowledgedUntrackedPaths == null ? isWorking : false);
        setArchiveConfirmOpen(true);
        return;
      }
      if (!res.success) {
        const rect = anchorEl?.getBoundingClientRect();
        archiveError.showError(
          workspaceId,
          res.error ?? "Failed to archive chat",
          rect ? { top: rect.top + window.scrollY, left: rect.right + 10 } : undefined
        );
      }
    },
    [workspaceId, archiveWorkspace, archiveError, isWorking]
  );

  /**
   * Entry point for the archive action. Runs a preflight check and either:
   * - archives immediately (no warnings),
   * - opens a combined confirmation dialog (streaming / untracked-file warnings), or
   * - shows an error popover (unexpected backend failures).
   */
  const handleArchiveChat = useCallback(
    async (anchorEl?: HTMLElement) => {
      if (isArchiving) return;

      // Run preflight to check for untracked files that can't be preserved.
      const preflight = await preflightArchiveWorkspace(workspaceId);
      if (!preflight.success) {
        const rect = anchorEl?.getBoundingClientRect();
        archiveError.showError(
          workspaceId,
          preflight.error ?? "Failed to check archive readiness",
          rect ? { top: rect.top + window.scrollY, left: rect.right + 10 } : undefined
        );
        return;
      }

      const preflightData = preflight.data;
      const untrackedPaths =
        preflightData?.kind === "confirm-lossy-untracked-files" ? preflightData.paths : null;
      const streamingNow = isWorking;

      if (untrackedPaths || streamingNow) {
        // Show a single combined confirmation dialog for all warnings.
        setArchiveUntrackedPaths(untrackedPaths);
        setArchiveConfirmIsStreaming(streamingNow);
        setArchiveConfirmOpen(true);
      } else {
        await executeArchive(anchorEl);
      }
    },
    [workspaceId, preflightArchiveWorkspace, archiveError, isWorking, isArchiving, executeArchive]
  );

  const handleForkChat = useCallback(
    async (anchorEl: HTMLElement) => {
      if (!api) {
        const rect = anchorEl.getBoundingClientRect();
        forkError.showError(workspaceId, "Not connected to server", {
          top: rect.top + window.scrollY,
          left: rect.right + 10,
        });
        return;
      }

      const rect = anchorEl.getBoundingClientRect();
      const anchor = { top: rect.top + window.scrollY, left: rect.right + 10 };

      try {
        const result = await forkWorkspace({
          client: api,
          sourceWorkspaceId: workspaceId,
        });
        if (!result.success) {
          forkError.showError(workspaceId, result.error ?? "Failed to fork chat", anchor);
        }
      } catch (error) {
        const message = getErrorMessage(error);
        forkError.showError(workspaceId, message, anchor);
      }
    },
    [api, forkError, workspaceId]
  );

  const handleStopRuntime = useCallback(async () => {
    if (!api) {
      stopRuntimeError.showError(workspaceId, "Not connected to server", getMoreMenuAnchor());
      return;
    }

    try {
      const result = await api.workspace.stopRuntime({ workspaceId });
      if (!result.success) {
        stopRuntimeError.showError(
          workspaceId,
          result.error ?? "Failed to stop container",
          getMoreMenuAnchor()
        );
        return;
      }

      // Clear the cached running state immediately so both menu entry points converge
      // on a fresh backend read after the container stop succeeds.
      runtimeStatusStore.invalidateWorkspace(workspaceId);
    } catch (error) {
      stopRuntimeError.showError(workspaceId, getErrorMessage(error), getMoreMenuAnchor());
    }
  }, [api, getMoreMenuAnchor, runtimeStatusStore, stopRuntimeError, workspaceId]);

  const loadSkills = useCallback(async () => {
    const requestId = ++skillsRequestIdRef.current;

    if (!api) {
      if (!isSkillsMountedRef.current || requestId !== skillsRequestIdRef.current) return;
      setAvailableSkills([]);
      setInvalidSkills([]);
      return;
    }

    try {
      const diagnostics = await api.agentSkills.listDiagnostics({
        workspaceId,
        disableWorkspaceAgents: disableWorkspaceAgents || undefined,
      });
      if (!isSkillsMountedRef.current || requestId !== skillsRequestIdRef.current) return;
      setAvailableSkills(Array.isArray(diagnostics.skills) ? diagnostics.skills : []);
      setInvalidSkills(Array.isArray(diagnostics.invalidSkills) ? diagnostics.invalidSkills : []);
    } catch (error) {
      console.error("Failed to load available skills:", error);
      if (isSkillsMountedRef.current && requestId === skillsRequestIdRef.current) {
        setAvailableSkills([]);
        setInvalidSkills([]);
      }
    }
  }, [api, workspaceId, disableWorkspaceAgents]);

  // Start workspace tutorial on first entry
  useEffect(() => {
    // Small delay to ensure UI is rendered
    const timer = setTimeout(() => {
      startTutorial("workspace");
    }, 300);
    return () => clearTimeout(timer);
  }, [startTutorial]);

  // Listen for /debug-llm-request command to open modal
  useEffect(() => {
    const handler = () => setDebugLlmRequestOpen(true);
    window.addEventListener(CUSTOM_EVENTS.OPEN_DEBUG_LLM_REQUEST, handler);
    return () => window.removeEventListener(CUSTOM_EVENTS.OPEN_DEBUG_LLM_REQUEST, handler);
  }, []);

  // Keybind for toggling notifications
  useEffect(() => {
    const handler = (e: KeyboardEvent) => {
      if (matchesKeybind(e, KEYBINDS.TOGGLE_NOTIFICATIONS)) {
        e.preventDefault();
        setNotifyOnResponse((prev) => !prev);
      }
    };
    window.addEventListener("keydown", handler);
    return () => window.removeEventListener("keydown", handler);
  }, [setNotifyOnResponse]);

  useEffect(() => {
    const handler = (e: KeyboardEvent) => {
      if (matchesKeybind(e, KEYBINDS.SHOW_WORKSPACE_DETAILS)) {
        e.preventDefault();
        setDetailsPopoverOpen((prev) => !prev);
      }
    };
    window.addEventListener("keydown", handler);
    return () => window.removeEventListener("keydown", handler);
  }, []);

  // Keybind for opening MCP configuration
  useEffect(() => {
    const handler = (e: KeyboardEvent) => {
      if (matchesKeybind(e, KEYBINDS.CONFIGURE_MCP)) {
        e.preventDefault();
        setMcpModalOpen(true);
      }
    };
    window.addEventListener("keydown", handler);
    return () => window.removeEventListener("keydown", handler);
  }, []);

  // Keybind for opening heartbeat configuration
  useEffect(() => {
    if (!workspaceHeartbeatsEnabled) return;

    const handler = (e: KeyboardEvent) => {
      if (matchesKeybind(e, KEYBINDS.CONFIGURE_HEARTBEAT)) {
        e.preventDefault();
        setHeartbeatModalOpen(true);
      }
    };
    window.addEventListener("keydown", handler);
    return () => window.removeEventListener("keydown", handler);
  }, [workspaceHeartbeatsEnabled]);

  useEffect(() => {
    isSkillsMountedRef.current = true;

    return () => {
      isSkillsMountedRef.current = false;
    };
  }, []);

  // Fetch available skills + diagnostics for this workspace.
  useEffect(() => {
    void loadSkills();
  }, [loadSkills]);

  useEffect(() => {
    const handleFocus = () => {
      void loadSkills();
    };

    window.addEventListener("focus", handleFocus);
    return () => window.removeEventListener("focus", handleFocus);
  }, [loadSkills]);

  useEffect(() => {
    const handleSkillsRefreshRequested = () => {
      void loadSkills();
    };

    window.addEventListener(CUSTOM_EVENTS.SKILLS_REFRESH_REQUESTED, handleSkillsRefreshRequested);
    return () =>
      window.removeEventListener(
        CUSTOM_EVENTS.SKILLS_REFRESH_REQUESTED,
        handleSkillsRefreshRequested
      );
  }, [loadSkills]);

  // On Windows/Linux, the native window controls overlay the top-right of the app.
  // When the right sidebar is collapsed (20px), this header stretches underneath
  // those controls and the MCP/editor/terminal buttons become unclickable.
  const isDesktop = isDesktopMode();

  return (
    <div
      ref={menuBarRef}
      data-testid="workspace-menu-bar"
      className={cn(
        "bg-sidebar border-border-light flex items-center justify-between border-b px-2",
        isDesktop ? DESKTOP_TITLEBAR_HEIGHT_CLASS : "h-8",
        rightSidebarCollapsed && "titlebar-safe-right-minus-sidebar titlebar-safe-right-gutter-2",
        // In desktop mode, make header draggable for window movement
        isDesktop && "titlebar-drag",
        // Keep header visible when iOS keyboard opens and causes scroll
        "mobile-sticky-header"
      )}
      // Apply the collapsed-left-sidebar inset from props so the workspace header starts in
      // the correct position on the very first paint instead of waiting for a later root-attr sync.
      style={leftSidebarCollapsed ? COLLAPSED_LEFT_SIDEBAR_MENU_BAR_STYLE : undefined}
    >
      <div
        className={cn(
          "text-foreground flex min-w-0 items-center gap-1.5 overflow-hidden",
          isDesktop && "titlebar-no-drag"
        )}
      >
        {leftSidebarCollapsed && (
          <Tooltip>
            <TooltipTrigger asChild>
              <Button
                variant="ghost"
                size="icon"
                onClick={onToggleLeftSidebarCollapsed}
                aria-label="Open sidebar menu"
                className="mobile-menu-btn text-muted hover:text-foreground hidden h-6 w-6 shrink-0"
              >
                <Menu className="h-3.5 w-3.5" />
              </Button>
            </TooltipTrigger>
            <TooltipContent>Open sidebar ({formatKeybind(KEYBINDS.TOGGLE_SIDEBAR)})</TooltipContent>
          </Tooltip>
        )}
        <span className="min-w-0 truncate text-sm" data-testid="workspace-title">
          {workspaceTitle ?? workspaceName}
        </span>
        {/* Touch and keyboard users need a focusable control for workspace details. */}
        <Popover open={detailsPopoverOpen} onOpenChange={setDetailsPopoverOpen}>
          <Tooltip
            open={detailsTooltipOpen && !detailsPopoverOpen}
            onOpenChange={setDetailsTooltipOpen}
          >
            <TooltipTrigger asChild>
              <PopoverTrigger asChild>
                <button
                  type="button"
                  className="text-muted hover:text-foreground focus-visible:ring-accent flex shrink-0 cursor-pointer items-center border-0 bg-transparent p-0 transition-colors focus-visible:ring-1"
                  aria-label="Workspace details"
                  onKeyDown={stopKeyboardPropagation}
                >
                  <Info className="h-3.5 w-3.5" />
                </button>
              </PopoverTrigger>
            </TooltipTrigger>
            <TooltipContent>
              Workspace details ({formatKeybind(KEYBINDS.SHOW_WORKSPACE_DETAILS)})
            </TooltipContent>
          </Tooltip>
          <PopoverContent align="start" className="flex flex-col gap-0.5 p-2 text-xs">
            <span className="font-mono">{projectLabel}</span>
            <span>{workspaceName}</span>
            <span className="text-muted">{namedWorkspacePath}</span>
          </PopoverContent>
        </Popover>
        {isArchiving && (
          <span
            role="status"
            className="text-muted flex shrink-0 items-center gap-1 text-xs whitespace-nowrap"
            data-testid="workspace-archiving-status"
          >
            <ArchiveIcon className="h-3 w-3 shrink-0" />
            Archiving...
          </span>
        )}
      </div>
      <div className={cn("flex items-center gap-2", isDesktop && "titlebar-no-drag")}>
        {/* The footer hides these links at this width, so the header carries them. */}
        <WorkspaceLinks
          workspaceId={workspaceId}
          className="hidden [@media(max-width:768px)]:inline-flex"
          menuDirection="down"
        />
        <Popover open={notificationPopoverOpen} onOpenChange={setNotificationPopoverOpen}>
          <Tooltip {...(notificationPopoverOpen ? { open: false } : {})}>
            <TooltipTrigger asChild>
              <PopoverTrigger asChild>
                <button
                  type="button"
                  onClick={() => setNotifyOnResponse((prev) => !prev)}
                  className={cn(
                    "flex h-6 w-6 shrink-0 items-center justify-center rounded",
                    notifyOnResponse
                      ? "text-foreground"
                      : "text-muted hover:bg-sidebar-hover hover:text-foreground"
                  )}
                  data-testid="notify-on-response-button"
                  aria-pressed={notifyOnResponse}
                >
                  {notifyOnResponse ? (
                    <Bell className="h-3.5 w-3.5" />
                  ) : (
                    <BellOff className="h-3.5 w-3.5" />
                  )}
                </button>
              </PopoverTrigger>
            </TooltipTrigger>
            <TooltipContent side="bottom" align="end">
              <div className="flex flex-col gap-2">
                <label className="flex cursor-pointer items-center gap-2">
                  <Checkbox
                    checked={notifyOnResponse}
                    onCheckedChange={(checked) => setNotifyOnResponse(checked === true)}
                  />
                  <span className="text-foreground">
                    Notify on all responses{" "}
                    <span className="text-muted-foreground">
                      ({formatKeybind(KEYBINDS.TOGGLE_NOTIFICATIONS)})
                    </span>
                  </span>
                </label>
                <label className="flex cursor-pointer items-start gap-2">
                  <Checkbox
                    checked={autoEnableNotifications}
                    onCheckedChange={(checked) => setAutoEnableNotifications(checked === true)}
                  />
                  <span className="text-muted-foreground">
                    Auto-enable for new workspaces in this project
                  </span>
                </label>
                <p className="text-muted-foreground border-separator-light border-t pt-2">
                  Agents can also notify on specific events.{" "}
                  <a
                    href="https://mux.coder.com/config/notifications"
                    target="_blank"
                    rel="noopener noreferrer"
                    className="text-accent hover:underline"
                  >
                    Learn more
                  </a>
                </p>
              </div>
            </TooltipContent>
          </Tooltip>

          <PopoverContent
            side="bottom"
            align="end"
            className="bg-modal-bg border-separator-light w-64 overflow-visible rounded px-[10px] py-[6px] text-[11px] font-normal shadow-[0_2px_8px_rgba(0,0,0,0.4)]"
          >
            <div className="flex flex-col gap-2">
              <label className="flex cursor-pointer items-center gap-2">
                <Checkbox
                  checked={notifyOnResponse}
                  onCheckedChange={(checked) => setNotifyOnResponse(checked === true)}
                />
                <span className="text-foreground">
                  Notify on all responses{" "}
                  <span className="text-muted-foreground">
                    ({formatKeybind(KEYBINDS.TOGGLE_NOTIFICATIONS)})
                  </span>
                </span>
              </label>
              <label className="flex cursor-pointer items-start gap-2">
                <Checkbox
                  checked={autoEnableNotifications}
                  onCheckedChange={(checked) => setAutoEnableNotifications(checked === true)}
                />
                <span className="text-muted-foreground">
                  Auto-enable for new workspaces in this project
                </span>
              </label>
              <p className="text-muted-foreground border-separator-light border-t pt-2">
                Agents can also notify on specific events.{" "}
                <a
                  href="https://mux.coder.com/config/notifications"
                  target="_blank"
                  rel="noopener noreferrer"
                  className="text-accent hover:underline"
                >
                  Learn more
                </a>
              </p>
            </div>
          </PopoverContent>
        </Popover>
        <SkillIndicator
          loadedSkills={loadedSkills}
          availableSkills={availableSkills}
          invalidSkills={invalidSkills}
          skillLoadErrors={skillLoadErrors}
        />
        {editorError && <span className="text-danger-soft text-xs">{editorError}</span>}
        <div className="max-[480px]:hidden">
          <Tooltip>
            <TooltipTrigger asChild>
              <Button
                variant="ghost"
                size="icon"
                onClick={() => void handleOpenInEditor()}
                className="text-muted hover:text-foreground ml-1 h-6 w-6 shrink-0"
              >
                <Pencil className="h-3.5 w-3.5" />
              </Button>
            </TooltipTrigger>
            <TooltipContent side="bottom" align="center">
              Open in editor ({formatKeybind(KEYBINDS.OPEN_IN_EDITOR)})
            </TooltipContent>
          </Tooltip>
        </div>
        <Tooltip>
          <TooltipTrigger asChild>
            <Button
              variant="ghost"
              size="icon"
              onClick={handleOpenTerminal}
              className="text-muted hover:text-foreground ml-1 h-6 w-6 shrink-0 [&_svg]:h-4 [&_svg]:w-4"
              data-tutorial="terminal-button"
            >
              <WorkspaceTerminalIcon />
            </Button>
          </TooltipTrigger>
          <TooltipContent side="bottom" align="center">
            New terminal ({formatKeybind(KEYBINDS.OPEN_TERMINAL)})
          </TooltipContent>
        </Tooltip>
        {/* Mirror sidebar share/archive actions in the workspace menu bar for quick access. */}
        <Popover open={moreMenuOpen} onOpenChange={setMoreMenuOpen}>
          <Tooltip {...(moreMenuOpen ? { open: false } : {})}>
            <TooltipTrigger asChild>
              <PopoverTrigger asChild>
                <Button
                  ref={moreActionsButtonRef}
                  variant="ghost"
                  size="icon"
                  className="text-muted hover:text-foreground ml-1 h-6 w-6 shrink-0"
                  aria-label="Workspace actions"
                  data-testid="workspace-more-actions"
                >
                  <Ellipsis className="h-3.5 w-3.5" />
                </Button>
              </PopoverTrigger>
            </TooltipTrigger>
            <TooltipContent side="bottom" align="end">
              More actions
            </TooltipContent>
          </Tooltip>

          <PopoverContent
            side="bottom"
            align="end"
            sideOffset={6}
            className="w-[240px] !min-w-0 p-1"
            onClick={(event: React.MouseEvent<HTMLDivElement>) => {
              event.stopPropagation();
            }}
          >
            {/* Keep MCP configuration in the more actions menu to keep the workspace menu bar lean. */}
            <WorkspaceActionsMenuContent
              onConfigureMcp={() => setMcpModalOpen(true)}
              onConfigureHeartbeat={
                workspaceHeartbeatsEnabled ? () => setHeartbeatModalOpen(true) : null
              }
              onOpenTouchFullscreenReview={
                hasRepository && isTouchMobileScreen ? handleOpenTouchFullscreenReview : null
              }
              onEnterImmersiveReview={
                hasRepository && !isTouchMobileScreen ? handleEnterImmersiveReview : null
              }
              onOpenTimeline={
                timelineExperimentEnabled && timelineSidebarHidden
                  ? () => setTimelineDialogWorkspaceId(workspaceId)
                  : null
              }
              onStopRuntime={isRuntimeRunning ? () => void handleStopRuntime() : null}
              // Scratch chats have no repo: review events are ignored by
              // RightSidebar and fork is unsupported on the backend, so hide
              // both instead of offering dead menu items.
              onForkChat={
                hasRepository
                  ? (anchorEl) => {
                      void handleForkChat(anchorEl);
                    }
                  : null
              }
              onTogglePinned={
                workspaceEntry && isWorkspacePinnable(workspaceEntry)
                  ? () => {
                      void setWorkspacePinned(workspaceId, !isWorkspacePinned(workspaceEntry));
                    }
                  : null
              }
              isPinned={workspaceEntry ? isWorkspacePinned(workspaceEntry) : false}
              onArchiveChat={
                workspaceEntry?.parentWorkspaceId != null
                  ? null
                  : (anchorEl) => {
                      // handleArchiveChat runs preflight and opens a confirmation dialog
                      // when streaming or untracked files are detected.
                      void handleArchiveChat(anchorEl);
                    }
              }
              onCloseMenu={() => setMoreMenuOpen(false)}
              shortcutClassName="mobile-hide-shortcut-hints"
              configureMcpTestId="workspace-mcp-button"
            />
          </PopoverContent>
        </Popover>
      </div>
      {workspaceHeartbeatsEnabled && (
        <WorkspaceHeartbeatModal
          workspaceId={workspaceId}
          open={heartbeatModalOpen}
          onOpenChange={setHeartbeatModalOpen}
        />
      )}
      <WorkspaceMCPModal
        workspaceId={workspaceId}
        projectPath={projectPath}
        open={mcpModalOpen}
        onOpenChange={setMcpModalOpen}
      />
      <TimelineDialog
        workspaceId={workspaceId}
        open={timelineDialogOpen}
        onOpenChange={(open) => setTimelineDialogWorkspaceId(open ? workspaceId : null)}
      />
      <DebugLlmRequestModal
        workspaceId={workspaceId}
        open={debugLlmRequestOpen}
        onOpenChange={setDebugLlmRequestOpen}
      />
      {/* Combined confirmation for archive warnings (streaming + untracked files). */}
      <ConfirmationModal
        isOpen={archiveConfirmOpen}
        title={
          archiveUntrackedPaths
            ? "Archive workspace with untracked files?"
            : workspaceTitle
              ? `Archive "${workspaceTitle}" while streaming?`
              : "Archive chat?"
        }
        description={buildArchiveConfirmDescription(
          archiveConfirmIsStreaming,
          archiveUntrackedPaths
        )}
        warning={buildArchiveConfirmWarning(archiveConfirmIsStreaming, archiveUntrackedPaths)}
        confirmLabel={archiveUntrackedPaths ? "Archive and delete files" : "Archive"}
        confirmVariant="destructive"
        onConfirm={() => {
          const paths = archiveUntrackedPaths;
          setArchiveConfirmOpen(false);
          setArchiveUntrackedPaths(null);
          setArchiveConfirmIsStreaming(false);
          void executeArchive(undefined, paths ?? undefined);
        }}
        onCancel={() => {
          setArchiveConfirmOpen(false);
          setArchiveUntrackedPaths(null);
          setArchiveConfirmIsStreaming(false);
        }}
      />
      <PopoverError
        error={stopRuntimeError.error}
        prefix="Failed to stop container"
        onDismiss={stopRuntimeError.clearError}
      />
      <PopoverError
        error={forkError.error}
        prefix="Failed to fork chat"
        onDismiss={forkError.clearError}
      />
      <PopoverError
        error={archiveError.error}
        prefix="Failed to archive chat"
        onDismiss={archiveError.clearError}
      />
    </div>
  );
};

import React from "react";
import {
  RIGHT_SIDEBAR_COLLAPSED_KEY,
  RIGHT_SIDEBAR_TAB_KEY,
  getReviewImmersiveKey,
  getRightSidebarLayoutKey,
  getTerminalTitlesKey,
} from "@/common/constants/storage";
import { CUSTOM_EVENTS } from "@/common/constants/events";
import { EXPERIMENT_IDS } from "@/common/constants/experiments";
import { useExperimentValue } from "@/browser/hooks/useExperiments";
import { isDesktopMode } from "@/browser/hooks/useDesktopTitlebar";
import {
  readPersistedState,
  updatePersistedState,
  usePersistedState,
} from "@/browser/hooks/usePersistedState";
import { useProvidersConfig } from "@/browser/hooks/useProvidersConfig";
import { useAPI } from "@/browser/contexts/API";
import { useWorkspaceMetadata } from "@/browser/contexts/WorkspaceContext";
import { useSendMessageOptions } from "@/browser/hooks/useSendMessageOptions";
import {
  hasGoalBudgetLimit,
  modelHasPricingData,
  UNPRICED_CURRENT_MODEL_GOAL_MESSAGE,
} from "@/common/utils/goals/budgetPricing";
import { setGoalWithConflictRetry } from "@/browser/utils/goals/setGoalWithConflictRetry";
import { loadGoalDefaults, resolveGoalSetIntent } from "@/browser/utils/goals/resolveGoalSetIntent";
import type { GoalCreateIntent } from "@/browser/features/RightSidebar/GoalTab";
import { usePopoverError } from "@/browser/hooks/usePopoverError";
import { PopoverError } from "@/browser/components/PopoverError/PopoverError";
import { hasWorkspaceRepository } from "@/browser/utils/workspaceCapabilities";
import { getErrorMessage } from "@/common/utils/errors";

// Per-tab panel components are no longer imported here directly — the
// `tabRegistry` owns label + panel rendering for static tabs (see
// `Tabs/tabRegistry.tsx`). Adding or removing a non-terminal tab is now a
// one-line registry change rather than a multi-file edit ledger.
//
// The RightSidebar itself only retains terminal-specific code paths because
// terminal tabs are multi-instance and keep-alive (state survives hidden
// tabsets), which doesn't fit the static "one panel per id" registry shape.
import {
  matchesKeybind,
  KEYBINDS,
  formatKeybind,
  isDialogOpen,
  isEditableElement,
  isDesktopViewportFocused,
} from "@/browser/utils/ui/keybinds";
import { SidebarCollapseButton } from "@/browser/components/SidebarCollapseButton/SidebarCollapseButton";
import { cn } from "@/common/lib/utils";
import type { ReviewNoteData } from "@/common/types/review";
import type { GoalSetError, GoalSnapshot, GoalStatus } from "@/common/types/goal";
import { TerminalTab } from "@/browser/features/RightSidebar/TerminalTab";
import {
  useOptionalWorkspaceSidebarState,
  useWorkspaceActivityAuthoritative,
} from "@/browser/stores/WorkspaceStore";
import { shouldAutoActivateWorkflowsTab } from "@/browser/features/RightSidebar/Workflows/workflowDisplay";
import {
  isTabType,
  isTerminalTab,
  getTerminalSessionId,
  getTerminalTabFallbackName,
  makeTerminalTabType,
  type TabType,
} from "@/browser/types/rightSidebar";
import { Panel, PanelGroup, PanelResizeHandle } from "react-resizable-panels";
import {
  addTabToFocusedTabset,
  collectAllTabs,
  collectAllTabsWithTabset,
  dockTabToEdge,
  findTabset,
  getDefaultRightSidebarLayoutState,
  getFocusedActiveTab,
  moveTabToTabset,
  parseRightSidebarLayoutState,
  removeTabEverywhere,
  reorderTabInTabset,
  selectTabByIndex,
  selectOrAddTab,
  selectTabInTabset,
  setFocusedTabset,
  updateSplitSizes,
  type RightSidebarLayoutNode,
  type RightSidebarLayoutState,
} from "@/browser/utils/rightSidebarLayout";
import {
  RightSidebarTabStrip,
  getTabName,
  type TabDragData,
} from "@/browser/features/RightSidebar/RightSidebarTabStrip";
import {
  createTerminalSession,
  openTerminalPopout,
  type TerminalSessionCreateOptions,
} from "@/browser/utils/terminal";
import { ReviewAssistedStatsReporter } from "@/browser/features/RightSidebar/CodeReview/ReviewPanel";
import {
  TAB_REGISTRY,
  TerminalTabLabel,
  getTabContentClassName,
  isBaseTabId,
  type BaseTabType,
  type ReviewStats,
  type TabPanelContext,
} from "@/browser/features/RightSidebar/Tabs";
import {
  DndContext,
  DragOverlay,
  PointerSensor,
  useSensor,
  useSensors,
  useDroppable,
  type DragStartEvent,
  type DragEndEvent,
} from "@dnd-kit/core";
import { SortableContext, rectSortingStrategy } from "@dnd-kit/sortable";

interface SidebarContainerProps {
  collapsed: boolean;
  /** Custom width from drag-resize (unified across all tabs) */
  customWidth?: number;
  /** Whether actively dragging resize handle (disables transition) */
  isResizing?: boolean;
  /** Whether running in Electron desktop mode (hides border when collapsed) */
  isDesktop?: boolean;
  /** Hide + inactivate sidebar while immersive review overlay is active. */
  immersiveHidden?: boolean;
  children: React.ReactNode;
  role: string;
  "aria-label": string;
}

/**
 * SidebarContainer - Main sidebar wrapper with dynamic width
 *
 * Width priority (first match wins):
 * 1. collapsed (20px) - Shows collapse button only
 * 2. customWidth - From drag-resize (unified width from AIView)
 * 3. default (400px) - Fallback when no custom width set
 */
const SidebarContainer: React.FC<SidebarContainerProps> = ({
  collapsed,
  customWidth,
  isResizing,
  isDesktop,
  immersiveHidden = false,
  children,
  role,
  "aria-label": ariaLabel,
}) => {
  const containerRef = React.useRef<HTMLDivElement>(null);
  const width = collapsed ? "20px" : customWidth ? `${customWidth}px` : "400px";

  React.useEffect(() => {
    const container = containerRef.current;
    if (!container) {
      return;
    }

    if (immersiveHidden) {
      container.setAttribute("inert", "");
    } else {
      container.removeAttribute("inert");
    }

    return () => {
      container.removeAttribute("inert");
    };
  }, [immersiveHidden]);

  return (
    <div
      ref={containerRef}
      aria-hidden={immersiveHidden || undefined}
      className={cn(
        "bg-surface-primary border-l border-border-light flex flex-col overflow-hidden flex-shrink-0",
        // Hide on mobile touch devices - too narrow for useful interaction
        "mobile-hide-right-sidebar",
        // Immersive review renders its own full-screen overlay, so hiding the underlying
        // sidebar container cuts layout/paint cost without discarding its React state.
        immersiveHidden && "hidden",
        !isResizing && "transition-[width] duration-200",
        collapsed && "sticky right-0 z-10 shadow-[-2px_0_4px_rgba(0,0,0,0.2)]",
        // In desktop mode, hide the left border when collapsed to avoid
        // visual separation in the titlebar area (overlay buttons zone)
        isDesktop && collapsed && "border-l-0"
      )}
      style={{ width, maxWidth: "100%" }}
      role={role}
      aria-label={ariaLabel}
    >
      {children}
    </div>
  );
};

function getGoalSetErrorMessage(error: GoalSetError): string {
  if (error.type === "goal_conflict") {
    return "Goal changed in another window. Please try again.";
  }
  return error.message;
}

interface RightSidebarProps {
  workspaceId: string;
  workspacePath: string;
  projectPath: string;
  /** Custom width in pixels (persisted per-tab, provided by AIView) */
  width?: number;
  /** Drag start handler for resize */
  onStartResize?: (e: React.MouseEvent) => void;
  /** Whether currently resizing */
  isResizing?: boolean;
  /** Callback when user adds a review note from Code Review tab */
  onReviewNote?: (data: ReviewNoteData) => void;
  /** Workspace is still being created (git operations in progress) */
  isCreating?: boolean;
  /** Hide + inactivate sidebar while immersive review overlay is active. */
  immersiveHidden?: boolean;
  /** Ref callback to expose addTerminal function to parent */
  addTerminalRef?: React.MutableRefObject<
    ((options?: TerminalSessionCreateOptions) => void) | null
  >;
}

/**
 * Wrapper component for PanelResizeHandle that disables pointer events during tab drag.
 * Uses isDragging prop passed from parent DndContext.
 */
const DragAwarePanelResizeHandle: React.FC<{
  direction: "horizontal" | "vertical";
  isDraggingTab: boolean;
}> = ({ direction, isDraggingTab }) => {
  const className = cn(
    direction === "horizontal"
      ? "w-0.5 flex-shrink-0 z-10 transition-[background] duration-150 cursor-col-resize bg-border-light hover:bg-accent"
      : "h-0.5 flex-shrink-0 z-10 transition-[background] duration-150 cursor-row-resize bg-border-light hover:bg-accent",
    isDraggingTab && "pointer-events-none"
  );

  return <PanelResizeHandle className={className} />;
};

function hasMountedReviewPanel(node: RightSidebarLayoutNode): boolean {
  if (node.type === "tabset") {
    return node.activeTab === "review";
  }

  return node.children.some((child) => hasMountedReviewPanel(child));
}

type TabsetNode = Extract<RightSidebarLayoutNode, { type: "tabset" }>;

interface RightSidebarTabsetNodeProps {
  node: TabsetNode;
  baseId: string;
  workspaceId: string;
  workspacePath: string;
  projectPath: string;
  isCreating: boolean;
  focusTrigger: number;
  onReviewNote?: (data: ReviewNoteData) => void;
  reviewStats: ReviewStats | null;
  onReviewStatsChange: (stats: ReviewStats | null) => void;
  /** Whether immersive review should use touch/mobile UX affordances. */
  isTouchReviewImmersive: boolean;
  /** Update touch/mobile immersive affordance mode from child controls/events. */
  onTouchReviewImmersiveChange: (isTouch: boolean) => void;
  /** Whether any sidebar tab is currently being dragged */
  isDraggingTab: boolean;
  /** Data about the currently dragged tab (if any) */
  activeDragData: TabDragData | null;
  setLayout: (updater: (prev: RightSidebarLayoutState) => RightSidebarLayoutState) => void;
  /** Handler to pop out a terminal tab to a separate window */
  onPopOutTerminal: (tab: TabType) => void;
  /** Handler to add a new terminal tab */
  onAddTerminal: () => void;
  /** Handler to close a terminal tab */
  onCloseTerminal: (tab: TabType) => void;
  /** Handler to remove a terminal tab after the session exits */
  onTerminalExit: (tab: TabType) => void;
  /** Map of terminal tab types to their current titles (from OSC sequences) */
  terminalTitles: Map<TabType, string>;
  /** Workspace-wide 0-based ordering of terminal tabs across all splits */
  terminalTabOrder: Map<TabType, number>;
  /** Handler to update a terminal's title */
  onTerminalTitleChange: (tab: TabType, title: string) => void;
  /** Map of tab → global position index (0-based) for keybind tooltips */
  tabPositions: Map<TabType, number>;
  /** Terminal session ID that should be auto-focused (cleared once focus lands) */
  autoFocusTerminalSession: string | null;
  goal: GoalSnapshot | null;
  goalCompleteInputRequest: number;
  // RightSidebar / GoalTab UI requests user-facing transitions only;
  // `budget_limited` is internal-only.
  onGoalSetStatus: (
    status: Exclude<GoalStatus, "budget_limited">,
    completionSummary?: string
  ) => Promise<void>;
  onGoalUpdateObjective: (objective: string) => Promise<void>;
  onGoalUpdateBudget: (budgetCents: number | null) => Promise<void>;
  onGoalUpdateTurnCap: (turnCap: number | null) => Promise<void>;
  onGoalClear: () => Promise<void>;
  /**
   * Create a brand-new goal from the GoalTab's in-tab form. Matches the
   * slash command's `goal-set` semantics (objective + optional budget +
   * optional turn cap) and routes through the same defaults-resolution +
   * unpriced-model pricing gate.
   */
  onGoalCreate: (intent: GoalCreateIntent) => Promise<void>;
  /** Callback to request terminal focus when a tab is selected */
  onRequestTerminalFocus: (sessionId: string) => void;
  /** Callback to clear the auto-focus state after it's been consumed */
  onAutoFocusConsumed: () => void;
}

const RightSidebarTabsetNode: React.FC<RightSidebarTabsetNodeProps> = (props) => {
  const tabsetBaseId = `${props.baseId}-${props.node.id}`;

  // Content container class comes from tab registry - each tab defines its own padding/overflow
  const tabsetContentClassName = cn(
    "relative flex-1 min-h-0 min-w-0",
    getTabContentClassName(props.node.activeTab)
  );

  // Drop zones using @dnd-kit's useDroppable
  const { setNodeRef: contentRef, isOver: isOverContent } = useDroppable({
    id: `content:${props.node.id}`,
    data: { type: "content", tabsetId: props.node.id },
  });

  const { setNodeRef: topRef, isOver: isOverTop } = useDroppable({
    id: `edge:${props.node.id}:top`,
    data: { type: "edge", tabsetId: props.node.id, edge: "top" },
  });

  const { setNodeRef: bottomRef, isOver: isOverBottom } = useDroppable({
    id: `edge:${props.node.id}:bottom`,
    data: { type: "edge", tabsetId: props.node.id, edge: "bottom" },
  });

  const { setNodeRef: leftRef, isOver: isOverLeft } = useDroppable({
    id: `edge:${props.node.id}:left`,
    data: { type: "edge", tabsetId: props.node.id, edge: "left" },
  });

  const { setNodeRef: rightRef, isOver: isOverRight } = useDroppable({
    id: `edge:${props.node.id}:right`,
    data: { type: "edge", tabsetId: props.node.id, edge: "right" },
  });

  const showDockHints =
    props.isDraggingTab &&
    (isOverContent || isOverTop || isOverBottom || isOverLeft || isOverRight);

  const setFocused = () => {
    props.setLayout((prev) => setFocusedTabset(prev, props.node.id));
  };

  const selectTab = (tab: TabType) => {
    if (isTerminalTab(tab)) {
      const sessionId = getTerminalSessionId(tab);
      if (sessionId) {
        props.onRequestTerminalFocus(sessionId);
      }
    }

    props.setLayout((prev) => {
      const withFocus = setFocusedTabset(prev, props.node.id);
      return selectTabInTabset(withFocus, props.node.id, tab);
    });
  };

  // Count terminal tabs in this tabset for numbering (Terminal, Terminal 2, etc.)
  const terminalTabs = props.node.tabs.filter(isTerminalTab);

  const items = props.node.tabs.flatMap((tab) => {
    const tabId = `${tabsetBaseId}-tab-${tab}`;
    const panelId = `${tabsetBaseId}-panel-${tab}`;

    // Show keybind for tabs 1-9 based on their position in the layout
    const isTerminal = isTerminalTab(tab);
    const tabPosition = props.tabPositions.get(tab);
    const keybinds = [
      KEYBINDS.SIDEBAR_TAB_1,
      KEYBINDS.SIDEBAR_TAB_2,
      KEYBINDS.SIDEBAR_TAB_3,
      KEYBINDS.SIDEBAR_TAB_4,
      KEYBINDS.SIDEBAR_TAB_5,
      KEYBINDS.SIDEBAR_TAB_6,
      KEYBINDS.SIDEBAR_TAB_7,
      KEYBINDS.SIDEBAR_TAB_8,
      KEYBINDS.SIDEBAR_TAB_9,
    ];
    const keybindStr =
      tabPosition !== undefined && tabPosition < keybinds.length
        ? formatKeybind(keybinds[tabPosition])
        : undefined;

    const tooltip = keybindStr;

    // Build label by delegating to the per-tab Label component declared in
    // the tab registry. Terminal tabs are special-cased (multi-instance label
    // with index + close/pop-out actions) — see `tabRegistry.tsx` for why
    // terminals stay outside the static registry.
    let label: React.ReactNode;
    if (isBaseTabId(tab)) {
      const Label = TAB_REGISTRY[tab].Label;
      label = <Label workspaceId={props.workspaceId} reviewStats={props.reviewStats} />;
    } else if (isTerminal) {
      const terminalIndex = props.terminalTabOrder.get(tab) ?? 0;
      label = (
        <TerminalTabLabel
          dynamicTitle={props.terminalTitles.get(tab)}
          terminalIndex={terminalIndex}
          onPopOut={() => props.onPopOutTerminal(tab)}
          onClose={() => props.onCloseTerminal(tab)}
        />
      );
    } else {
      label = tab;
    }

    return [
      {
        id: tabId,
        panelId,
        selected: props.node.activeTab === tab,
        onSelect: () => selectTab(tab),
        label,
        tooltip,
        tab,
        // Terminal tabs are closeable
        onClose: isTerminal ? () => props.onCloseTerminal(tab) : undefined,
      },
    ];
  });

  // Generate sortable IDs for tabs in this tabset
  const sortableIds = items.map((item) => `${props.node.id}:${item.tab}`);

  // Build the panel context once per tabset render — passed verbatim to each
  // active tab's `renderPanel` from the registry. Centralising this means a
  // panel renderer never has to negotiate with the RightSidebar component
  // about prop shape.
  const panelContext: TabPanelContext = {
    workspaceId: props.workspaceId,
    workspacePath: props.workspacePath,
    projectPath: props.projectPath,
    isCreating: props.isCreating,
    focusTrigger: props.focusTrigger,
    tabsetId: props.node.id,
    review: {
      onReviewNote: props.onReviewNote,
      onStatsChange: props.onReviewStatsChange,
      isTouchImmersive: props.isTouchReviewImmersive,
      onTouchImmersiveChange: props.onTouchReviewImmersiveChange,
    },
    goal: {
      snapshot: props.goal,
      openCompleteInputRequest: props.goalCompleteInputRequest,
      onSetStatus: props.onGoalSetStatus,
      onUpdateObjective: props.onGoalUpdateObjective,
      onUpdateBudget: props.onGoalUpdateBudget,
      onUpdateTurnCap: props.onGoalUpdateTurnCap,
      onClear: props.onGoalClear,
      onCreate: props.onGoalCreate,
    },
  };

  return (
    <div className="flex min-h-0 min-w-0 flex-1 flex-col" onMouseDownCapture={setFocused}>
      <SortableContext items={sortableIds} strategy={rectSortingStrategy}>
        <RightSidebarTabStrip
          ariaLabel="Sidebar views"
          items={items}
          tabsetId={props.node.id}
          onAddTerminal={props.onAddTerminal}
        />
      </SortableContext>
      <div
        ref={contentRef}
        className={cn(
          tabsetContentClassName,
          props.isDraggingTab && isOverContent && "bg-accent/10 ring-1 ring-accent/50"
        )}
      >
        {/* Edge docking zones - always rendered but only visible/interactive during drag */}
        <div
          ref={topRef}
          className={cn(
            "absolute inset-x-0 top-0 z-10 h-10 transition-opacity",
            props.isDraggingTab
              ? showDockHints
                ? "opacity-100"
                : "opacity-0"
              : "opacity-0 pointer-events-none",
            isOverTop ? "bg-accent/20 border-b border-accent" : "bg-accent/5"
          )}
        />
        <div
          ref={bottomRef}
          className={cn(
            "absolute inset-x-0 bottom-0 z-10 h-10 transition-opacity",
            props.isDraggingTab
              ? showDockHints
                ? "opacity-100"
                : "opacity-0"
              : "opacity-0 pointer-events-none",
            isOverBottom ? "bg-accent/20 border-t border-accent" : "bg-accent/5"
          )}
        />
        <div
          ref={leftRef}
          className={cn(
            "absolute inset-y-0 left-0 z-10 w-10 transition-opacity",
            props.isDraggingTab
              ? showDockHints
                ? "opacity-100"
                : "opacity-0"
              : "opacity-0 pointer-events-none",
            isOverLeft ? "bg-accent/20 border-r border-accent" : "bg-accent/5"
          )}
        />
        <div
          ref={rightRef}
          className={cn(
            "absolute inset-y-0 right-0 z-10 w-10 transition-opacity",
            props.isDraggingTab
              ? showDockHints
                ? "opacity-100"
                : "opacity-0"
              : "opacity-0 pointer-events-none",
            isOverRight ? "bg-accent/20 border-l border-accent" : "bg-accent/5"
          )}
        />

        {/* Static (non-terminal) tab panels — render the active one via the registry. */}
        {isBaseTabId(props.node.activeTab) && (
          <RegistryTabPanel
            tabId={props.node.activeTab}
            tabsetBaseId={tabsetBaseId}
            context={panelContext}
          />
        )}

        {/* Render all terminal tabs (keep-alive: hidden but mounted) */}
        {terminalTabs.map((terminalTab) => {
          const terminalTabId = `${tabsetBaseId}-tab-${terminalTab}`;
          const terminalPanelId = `${tabsetBaseId}-panel-${terminalTab}`;
          const isActive = props.node.activeTab === terminalTab;
          // Check if this terminal should be auto-focused (was just opened via keybind)
          const terminalSessionId = getTerminalSessionId(terminalTab);
          const shouldAutoFocus = isActive && terminalSessionId === props.autoFocusTerminalSession;
          const terminalIndex = props.terminalTabOrder.get(terminalTab) ?? 0;
          const tabName =
            props.terminalTitles.get(terminalTab) ?? getTerminalTabFallbackName(terminalIndex);

          return (
            <div
              key={terminalPanelId}
              role="tabpanel"
              id={terminalPanelId}
              aria-labelledby={terminalTabId}
              className="h-full"
              hidden={!isActive}
            >
              <TerminalTab
                workspaceId={props.workspaceId}
                tabType={terminalTab}
                visible={isActive}
                tabName={tabName}
                tabIndex={terminalIndex}
                onTitleChange={(title) => props.onTerminalTitleChange(terminalTab, title)}
                autoFocus={shouldAutoFocus}
                onAutoFocusConsumed={shouldAutoFocus ? props.onAutoFocusConsumed : undefined}
                onExit={() => props.onTerminalExit(terminalTab)}
              />
            </div>
          );
        })}
      </div>
    </div>
  );
};

/**
 * Render the active static (non-terminal) tab's panel by delegating to the
 * `renderPanel` function declared in the registry. Wrapping the render in a
 * `tabpanel` element here means each registry entry only has to describe its
 * content — accessibility wiring stays in one place.
 */
const RegistryTabPanel: React.FC<{
  tabId: BaseTabType;
  tabsetBaseId: string;
  context: TabPanelContext;
}> = ({ tabId, tabsetBaseId, context }) => {
  const reg = TAB_REGISTRY[tabId];
  // Tabs whose content needs the full available height opt in via their
  // `contentClassName` (`overflow-hidden p-0`); those that scroll
  // (`overflow-y-auto …`) don't. Keep the `h-full` policy decision local to
  // the registry rather than the wrapper.
  const needsFullHeight = reg.contentClassName.includes("overflow-hidden") || tabId === "goal";
  return (
    <div
      role="tabpanel"
      id={`${tabsetBaseId}-panel-${tabId}`}
      aria-labelledby={`${tabsetBaseId}-tab-${tabId}`}
      className={needsFullHeight ? "h-full" : undefined}
    >
      {reg.renderPanel(context)}
    </div>
  );
};

const RightSidebarComponent: React.FC<RightSidebarProps> = ({
  workspaceId,
  workspacePath,
  projectPath,
  width,
  onStartResize,
  isResizing = false,
  onReviewNote,
  isCreating = false,
  immersiveHidden = false,
  addTerminalRef,
}) => {
  // Trigger for focusing Review panel (preserves hunk selection)
  const [focusTrigger, _setFocusTrigger] = React.useState(0);

  // Review hunk totals are reported by the Review panel when mounted, while
  // unread-assisted is reported by an always-mounted headless component so the
  // tab attention cue updates even when the user is on another tab.
  const [reviewPanelStats, setReviewPanelStats] = React.useState<Pick<
    ReviewStats,
    "total" | "read"
  > | null>(null);
  const [unreadAssisted, setUnreadAssisted] = React.useState(0);
  const reviewStats = React.useMemo<ReviewStats | null>(() => {
    if (reviewPanelStats === null && unreadAssisted === 0) return null;
    return {
      total: reviewPanelStats?.total ?? 0,
      read: reviewPanelStats?.read ?? 0,
      unreadAssisted,
    };
  }, [reviewPanelStats, unreadAssisted]);
  const handleReviewStatsChange = React.useCallback((stats: ReviewStats | null) => {
    setReviewPanelStats(stats ? { total: stats.total, read: stats.read } : null);
  }, []);

  // Terminal session ID that should be auto-focused (new terminal or explicit tab focus).
  const [autoFocusTerminalSession, setAutoFocusTerminalSession] = React.useState<string | null>(
    null
  );

  // Surface backend failures from terminal creation (e.g., the markdown Run button kicking off
  // a session against a transcript-only workspace, or a runtime that isn't connected). Without
  // this the click silently expands the sidebar with no new tab, which users perceive as a hang
  // or app crash.
  const terminalCreateError = usePopoverError();

  // Manual collapse state (persisted globally)
  const [collapsed, setCollapsed] = usePersistedState<boolean>(RIGHT_SIDEBAR_COLLAPSED_KEY, false, {
    listener: true,
  });
  const [isReviewImmersive, setIsReviewImmersive] = usePersistedState<boolean>(
    getReviewImmersiveKey(workspaceId),
    false,
    { listener: true }
  );

  const [isTouchReviewImmersive, setIsTouchReviewImmersive] = React.useState(false);

  // API for reading config and managing terminal sessions.
  const apiState = useAPI();
  const api = apiState.api;
  const desktopExperimentEnabled = useExperimentValue(EXPERIMENT_IDS.PORTABLE_DESKTOP);
  const browserExperimentEnabled = useExperimentValue(EXPERIMENT_IDS.AGENT_BROWSER);
  const memoryExperimentEnabled = useExperimentValue(EXPERIMENT_IDS.MEMORY);
  const workflowsExperimentEnabled = useExperimentValue(EXPERIMENT_IDS.DYNAMIC_WORKFLOWS);
  const timelineExperimentEnabled = useExperimentValue(EXPERIMENT_IDS.TIMELINE);
  // Child task workspaces can't run goal actions — backend rejects them
  // via `WorkspaceGoalService.assertParentWorkspace`. We use this flag
  // both to hide the Goal tab below and to gate any inline goal UX.
  const workspaceMetadataContext = useWorkspaceMetadata();
  const currentWorkspaceMetadata =
    workspaceMetadataContext.workspaceMetadata.get(workspaceId) ?? null;
  const canReviewDiffs = hasWorkspaceRepository(currentWorkspaceMetadata);
  const isChildWorkspaceForGoal = currentWorkspaceMetadata?.parentWorkspaceId != null;
  // Safe variant: storybook stories may render before addWorkspace() runs; the
  // optional hook returns null instead of throwing assertGet on the unregistered
  // workspace. Real workspaces always have an aggregator by the time RightSidebar
  // mounts, so the optional path doesn't change runtime behavior.
  const { config: providersConfig } = useProvidersConfig();
  const sendMessageOptions = useSendMessageOptions(workspaceId);
  const sidebarState = useOptionalWorkspaceSidebarState(workspaceId);
  const goal = sidebarState?.goal ?? null;
  const [goalCompleteInputRequest, setGoalCompleteInputRequest] = React.useState(0);
  const [llmDebugLogsEnabled, setLlmDebugLogsEnabled] = React.useState<boolean | null>(null);
  const [desktopAvailable, setDesktopAvailable] = React.useState<boolean | null>(null);
  const [browserAvailable, setBrowserAvailable] = React.useState<boolean | null>(null);
  const debugLogsLocalOverrideRef = React.useRef(false);

  const setGoalWithSingleConflictRetry = async (intent: {
    // RightSidebar buttons only ever request user-facing transitions;
    // `budget_limited` is internal-only and excluded from public setGoal input.
    status?: Exclude<GoalStatus, "budget_limited">;
    objective?: string;
    budgetCents?: number | null;
    turnCap?: number | null;
    completionSummary?: string;
    // `editInPlace` is forwarded verbatim to `setGoal`; it tells the backend
    // to mutate the existing goal record instead of archiving+recreating.
    editInPlace?: boolean;
  }) => {
    if (!api) {
      throw new Error("Backend is not connected.");
    }
    // Shared retry helper keeps sidebar, slash-command, and palette conflict
    // handling in lockstep.
    const result = await setGoalWithConflictRetry(api, workspaceId, intent);
    if (!result.success) {
      throw new Error(getGoalSetErrorMessage(result.error));
    }
  };

  const handleGoalSetStatus = async (
    // The downstream `setGoal` mutation excludes internal-only `budget_limited`.
    status: Exclude<GoalStatus, "budget_limited">,
    completionSummary?: string
  ) => {
    await setGoalWithSingleConflictRetry({ status, completionSummary });
  };

  const handleGoalUpdateBudget = async (budgetCents: number | null) => {
    if (
      hasGoalBudgetLimit(budgetCents) &&
      !modelHasPricingData(sendMessageOptions.model, providersConfig)
    ) {
      throw new Error(UNPRICED_CURRENT_MODEL_GOAL_MESSAGE);
    }
    await setGoalWithSingleConflictRetry({ budgetCents });
  };

  const handleGoalUpdateTurnCap = async (turnCap: number | null) => {
    await setGoalWithSingleConflictRetry({ turnCap });
  };

  const handleGoalUpdateObjective = async (objective: string) => {
    // The inline objective editor matches the budget / turn-cap editors:
    // mutate the current goal in place rather than archiving + recreating
    // (which is what `/goal <new objective>` does). `editInPlace: true` is
    // the toggle the backend reads to take the rename branch.
    await setGoalWithSingleConflictRetry({ objective, editInPlace: true });
  };

  const handleGoalClear = async () => {
    if (!api) {
      throw new Error("Backend is not connected.");
    }
    await api.workspace.clearGoal({ workspaceId });
  };

  const handleGoalCreate = async (intent: GoalCreateIntent) => {
    if (!api) {
      throw new Error("Backend is not connected.");
    }
    // Apply shared defaults (turn cap + `alwaysRequireExplicitBudget`)
    // so the GoalTab form, slash command, and command palette produce
    // identical goals for identical inputs. Pass workspaceId so any
    // per-workspace override wins over the global.
    const defaults = await loadGoalDefaults(api, workspaceId);
    const resolved = resolveGoalSetIntent(intent, defaults);
    if (hasGoalBudgetLimit(resolved.budgetCents)) {
      // Fetch provider config at submit time so quick submits before the
      // hook populates still honor priced custom/mapped models. Slash
      // command and palette paths also fetch here, keeping all create
      // surfaces in lockstep.
      let freshProvidersConfig: unknown = providersConfig;
      try {
        freshProvidersConfig = await api.providers.getConfig();
      } catch {
        // Fall back to the hook value (which may still be null). Better
        // to surface the pricing-gate error than to leak the network
        // failure to the user — they can retry.
      }
      if (!modelHasPricingData(sendMessageOptions.model, freshProvidersConfig)) {
        throw new Error(UNPRICED_CURRENT_MODEL_GOAL_MESSAGE);
      }
    }
    await setGoalWithSingleConflictRetry({
      objective: resolved.objective,
      budgetCents: resolved.budgetCents,
      ...(resolved.turnCap != null ? { turnCap: resolved.turnCap } : {}),
    });
  };

  React.useEffect(() => {
    if (!api) {
      setLlmDebugLogsEnabled(null);
      return;
    }

    // Reset local override so a fresh config fetch can set the initial value.
    debugLogsLocalOverrideRef.current = false;
    let cancelled = false;

    void api.config
      .getConfig()
      .then((cfg) => {
        if (cancelled) {
          return;
        }

        // If the user toggled debug logs while this config fetch was in flight,
        // the event listener has already set the authoritative value.
        if (debugLogsLocalOverrideRef.current) {
          return;
        }

        setLlmDebugLogsEnabled(cfg.llmDebugLogs === true);
      })
      .catch(() => {
        if (cancelled) {
          return;
        }

        setLlmDebugLogsEnabled(false);
      });

    return () => {
      cancelled = true;
    };
  }, [api]);

  React.useEffect(() => {
    const handleLlmDebugLogsChanged = (event: Event) => {
      const detail = (event as CustomEvent<{ enabled: boolean }>).detail;
      debugLogsLocalOverrideRef.current = true;
      setLlmDebugLogsEnabled(detail?.enabled === true);
    };

    window.addEventListener(CUSTOM_EVENTS.LLM_DEBUG_LOGS_CHANGED, handleLlmDebugLogsChanged);
    return () =>
      window.removeEventListener(CUSTOM_EVENTS.LLM_DEBUG_LOGS_CHANGED, handleLlmDebugLogsChanged);
  }, []);

  // Read last-used focused tab for better defaults when initializing a new layout.
  const initialActiveTab = React.useMemo<TabType>(() => {
    const raw = readPersistedState<string>(RIGHT_SIDEBAR_TAB_KEY, "costs");
    if (!canReviewDiffs && raw === "review") return "costs";
    return isTabType(raw) ? raw : "costs";
  }, [canReviewDiffs]);

  const defaultLayout = React.useMemo(
    () => getDefaultRightSidebarLayoutState(initialActiveTab),
    [initialActiveTab]
  );

  // Layout is per-workspace so each workspace can have its own split/tab configuration
  // (e.g., different numbers of terminals). Width and collapsed state remain global.
  const layoutKey = getRightSidebarLayoutKey(workspaceId);
  const [layoutRaw, setLayoutRaw] = usePersistedState<RightSidebarLayoutState>(
    layoutKey,
    defaultLayout,
    {
      listener: true,
    }
  );

  // While dragging tabs (hover-based reorder), keep layout changes in-memory and
  // commit once on drop to avoid localStorage writes on every mousemove.
  const [layoutDraft, setLayoutDraft] = React.useState<RightSidebarLayoutState | null>(null);
  const layoutDraftRef = React.useRef<RightSidebarLayoutState | null>(null);

  // Ref to access latest layoutRaw without causing callback recreation
  const layoutRawRef = React.useRef(layoutRaw);
  layoutRawRef.current = layoutRaw;

  const isSidebarTabDragInProgressRef = React.useRef(false);

  const handleSidebarTabDragStart = React.useCallback(() => {
    isSidebarTabDragInProgressRef.current = true;
    layoutDraftRef.current = null;
  }, []);

  const handleSidebarTabDragEnd = React.useCallback(() => {
    isSidebarTabDragInProgressRef.current = false;

    const draft = layoutDraftRef.current;
    if (draft) {
      setLayoutRaw(draft);
    }

    layoutDraftRef.current = null;
    setLayoutDraft(null);
  }, [setLayoutRaw]);

  const parsedLayout = React.useMemo(
    () => parseRightSidebarLayoutState(layoutDraft ?? layoutRaw, initialActiveTab),
    [layoutDraft, layoutRaw, initialActiveTab]
  );
  const layout = React.useMemo(
    () => (canReviewDiffs ? parsedLayout : removeTabEverywhere(parsedLayout, "review")),
    [canReviewDiffs, parsedLayout]
  );

  const hasReviewPanelMounted = React.useMemo(
    () => !collapsed && hasMountedReviewPanel(layout.root),
    [collapsed, layout.root]
  );

  // If immersive mode is active but no ReviewPanel is mounted (e.g., user switched tabs),
  // clear the persisted immersive flag to avoid leaving a blank overlay mounted.
  React.useEffect(() => {
    if (!isReviewImmersive || hasReviewPanelMounted) {
      return;
    }

    setIsReviewImmersive(false);
  }, [hasReviewPanelMounted, isReviewImmersive, setIsReviewImmersive]);

  // Legacy "stats" tabs in persisted layouts are stripped during parsing
  // (see stripLegacyStatsTab in rightSidebarLayout.ts).
  // If LLM debug logs are enabled, ensure the Debug tab exists in the layout.
  // If disabled, ensure it doesn't linger in persisted layouts.
  React.useEffect(() => {
    // Skip layout mutations until the config has been loaded. Using null
    // as the initial state prevents pruning debug tabs from persisted layouts
    // before we know the real setting.
    if (llmDebugLogsEnabled == null) {
      return;
    }

    setLayoutRaw((prevRaw) => {
      const prev = parseRightSidebarLayoutState(prevRaw, initialActiveTab);
      const hasDebug = collectAllTabs(prev.root).includes("debug");

      if (llmDebugLogsEnabled && !hasDebug) {
        // Add debug tab to the focused tabset without stealing focus.
        return addTabToFocusedTabset(prev, "debug", false);
      }

      if (!llmDebugLogsEnabled && hasDebug) {
        return removeTabEverywhere(prev, "debug");
      }

      return prev;
    });
  }, [initialActiveTab, layoutRaw, llmDebugLogsEnabled, setLayoutRaw]);
  React.useEffect(() => {
    setBrowserAvailable(browserExperimentEnabled);
  }, [browserExperimentEnabled]);

  React.useEffect(() => {
    if (browserAvailable == null) {
      return;
    }

    setLayoutRaw((prevRaw) => {
      const prev = parseRightSidebarLayoutState(prevRaw, initialActiveTab);
      const hasBrowser = collectAllTabs(prev.root).includes("browser");

      if (browserAvailable && !hasBrowser) {
        return addTabToFocusedTabset(prev, "browser", false);
      }

      if (!browserAvailable && hasBrowser) {
        return removeTabEverywhere(prev, "browser");
      }

      return prev;
    });
  }, [browserAvailable, initialActiveTab, setLayoutRaw]);

  // Memory tab follows the experiment value (same shape as the browser tab).
  React.useEffect(() => {
    setLayoutRaw((prevRaw) => {
      const prev = parseRightSidebarLayoutState(prevRaw, initialActiveTab);
      const hasMemory = collectAllTabs(prev.root).includes("memory");

      if (memoryExperimentEnabled && !hasMemory) {
        return addTabToFocusedTabset(prev, "memory", false);
      }

      if (!memoryExperimentEnabled && hasMemory) {
        return removeTabEverywhere(prev, "memory");
      }

      return prev;
    });
  }, [memoryExperimentEnabled, initialActiveTab, setLayoutRaw]);

  // Workflows tab follows the dynamic-workflows experiment (same shape as the memory tab):
  // experimental tabs are added/removed from the persisted layout here, not via tabConfig's
  // featureFlag (which only filters the Add-Tool picker / command palette).
  React.useEffect(() => {
    setLayoutRaw((prevRaw) => {
      const prev = parseRightSidebarLayoutState(prevRaw, initialActiveTab);
      const hasWorkflows = collectAllTabs(prev.root).includes("workflows");

      if (workflowsExperimentEnabled && !hasWorkflows) {
        return addTabToFocusedTabset(prev, "workflows", false);
      }

      if (!workflowsExperimentEnabled && hasWorkflows) {
        return removeTabEverywhere(prev, "workflows");
      }

      return prev;
    });
  }, [workflowsExperimentEnabled, initialActiveTab, setLayoutRaw]);

  React.useEffect(() => {
    setLayoutRaw((prevRaw) => {
      const prev = parseRightSidebarLayoutState(prevRaw, initialActiveTab);
      const hasTimeline = collectAllTabs(prev.root).includes("timeline");

      if (timelineExperimentEnabled && !hasTimeline) {
        return addTabToFocusedTabset(prev, "timeline", false);
      }

      if (!timelineExperimentEnabled && hasTimeline) {
        return removeTabEverywhere(prev, "timeline");
      }

      return prev;
    });
  }, [timelineExperimentEnabled, initialActiveTab, setLayoutRaw]);

  React.useEffect(() => {
    setLayoutRaw((prevRaw) => {
      const prev = parseRightSidebarLayoutState(prevRaw, initialActiveTab);
      const hasGoal = collectAllTabs(prev.root).includes("goal");
      // Goal tab is always visible on top-level workspaces. Child task
      // workspaces can't use any goal action — every backend write goes
      // through `assertParentWorkspace()` which throws for workspaces
      // with `parentWorkspaceId`. Showing the tab there would surface
      // a create/queue UI whose submits fail.
      const goalTabShouldExist = !isChildWorkspaceForGoal;
      if (goalTabShouldExist && !hasGoal) {
        return addTabToFocusedTabset(prev, "goal", false);
      }

      if (!goalTabShouldExist && hasGoal) {
        return removeTabEverywhere(prev, "goal");
      }

      return prev;
    });
  }, [initialActiveTab, setLayoutRaw, isChildWorkspaceForGoal]);

  React.useEffect(() => {
    if (!desktopExperimentEnabled) {
      setDesktopAvailable(false);
      return;
    }

    // A degraded (slow) connection still has a usable api; only a missing api means offline.
    if (!api) {
      setDesktopAvailable(null);
      return;
    }

    let cancelled = false;

    void api.desktop
      .getCapability({ workspaceId })
      .then((capability) => {
        if (!cancelled) {
          setDesktopAvailable(capability.available);
        }
      })
      .catch(() => {
        if (!cancelled) {
          setDesktopAvailable(false);
        }
      });

    return () => {
      cancelled = true;
    };
  }, [api, desktopExperimentEnabled, workspaceId]);

  React.useEffect(() => {
    if (desktopAvailable == null) {
      return;
    }

    setLayoutRaw((prevRaw) => {
      const prev = parseRightSidebarLayoutState(prevRaw, initialActiveTab);
      const hasDesktop = collectAllTabs(prev.root).includes("desktop");

      if (desktopAvailable && !hasDesktop) {
        return addTabToFocusedTabset(prev, "desktop", false);
      }

      if (!desktopAvailable && hasDesktop) {
        return removeTabEverywhere(prev, "desktop");
      }

      return prev;
    });
  }, [desktopAvailable, initialActiveTab, setLayoutRaw]);

  // Persist parser migrations (schema resets, removed-tab cleanup, newly-added
  // default tabs like Instructions) back to storage. Without this, the current
  // render can show the migrated layout while other localStorage readers — and
  // future mounts after a hot reload — still see the stale pre-migration tabs.
  React.useEffect(() => {
    if (layoutDraft !== null) {
      return;
    }
    if (layoutRaw !== parsedLayout) {
      setLayoutRaw(parsedLayout);
    }
  }, [layoutDraft, layoutRaw, parsedLayout, setLayoutRaw]);

  const getBaseLayout = React.useCallback(() => {
    return (
      layoutDraftRef.current ?? parseRightSidebarLayoutState(layoutRawRef.current, initialActiveTab)
    );
  }, [initialActiveTab]);

  const focusActiveTerminal = React.useCallback(
    (state: RightSidebarLayoutState) => {
      const activeTab = getFocusedActiveTab(state, initialActiveTab);
      if (!isTerminalTab(activeTab)) {
        return;
      }
      const sessionId = getTerminalSessionId(activeTab);
      if (sessionId) {
        setAutoFocusTerminalSession(sessionId);
      }
    },
    [initialActiveTab, setAutoFocusTerminalSession]
  );

  const setLayout = React.useCallback(
    (updater: (prev: RightSidebarLayoutState) => RightSidebarLayoutState) => {
      if (isSidebarTabDragInProgressRef.current) {
        // Use ref to get latest layoutRaw without dependency
        const base =
          layoutDraftRef.current ??
          parseRightSidebarLayoutState(layoutRawRef.current, initialActiveTab);
        const next = updater(base);
        layoutDraftRef.current = next;
        setLayoutDraft(next);
        return;
      }

      setLayoutRaw((prevRaw) => updater(parseRightSidebarLayoutState(prevRaw, initialActiveTab)));
    },
    [initialActiveTab, setLayoutRaw]
  );

  const selectOrOpenReviewTab = React.useCallback(() => {
    if (!canReviewDiffs) return;
    setLayout((prev) => selectOrAddTab(prev, "review"));
    _setFocusTrigger((prev) => prev + 1);
  }, [canReviewDiffs, setLayout]);

  React.useEffect(() => {
    const handleOpenGoalTab = (event: Event) => {
      const detail = (event as CustomEvent<{ workspaceId: string; openCompleteInput?: boolean }>)
        .detail;
      if (detail?.workspaceId !== workspaceId) {
        return;
      }
      setCollapsed(false);
      setLayout((prev) => selectOrAddTab(prev, "goal"));
      if (detail.openCompleteInput) {
        setGoalCompleteInputRequest((prev) => prev + 1);
      }
    };

    window.addEventListener(CUSTOM_EVENTS.OPEN_GOAL_TAB, handleOpenGoalTab);
    return () => window.removeEventListener(CUSTOM_EVENTS.OPEN_GOAL_TAB, handleOpenGoalTab);
  }, [setCollapsed, setLayout, workspaceId]);

  // Auto-surface the Workflows tab when a run starts: the tab is the primary
  // run-detail surface (the chat card stays collapsed while it exists), but a
  // background-added tab with a small badge is easy to miss. Only a mounted
  // 0 → >0 transition activates — opening a workspace mid-run keeps the user's
  // persisted tab, and switching away afterwards is respected. Does not
  // un-collapse a collapsed sidebar.
  const activeWorkflowRunCount = sidebarState?.activeWorkflowRunCount ?? 0;
  const activityAuthoritative = useWorkspaceActivityAuthoritative();
  const previousActiveWorkflowRunCountRef = React.useRef<number | null>(null);
  React.useEffect(() => {
    // Before an AUTHORITATIVE activity snapshot the store reports 0 for every
    // workspace — both pre-hydration and after a failure-path self-heal (which marks
    // hydrated with an empty map). Recording that 0 as the baseline would misread the
    // eventual real snapshot of a pre-existing active run as a fresh 0 → >0 start and
    // steal the persisted tab. Keep the baseline unknown until authoritative data; the
    // first authoritative observation counts as "first observation" and never activates.
    if (!activityAuthoritative) {
      return;
    }
    const previous = previousActiveWorkflowRunCountRef.current;
    previousActiveWorkflowRunCountRef.current = activeWorkflowRunCount;
    if (
      !workflowsExperimentEnabled ||
      !shouldAutoActivateWorkflowsTab(previous, activeWorkflowRunCount)
    ) {
      return;
    }
    setLayout((prev) => selectOrAddTab(prev, "workflows"));
  }, [activityAuthoritative, activeWorkflowRunCount, setLayout, workflowsExperimentEnabled]);

  React.useEffect(() => {
    const handleOpenTouchReviewImmersive = (event: Event) => {
      const detail = (event as CustomEvent<{ workspaceId: string }>).detail;
      if (!canReviewDiffs) return;

      if (detail?.workspaceId !== workspaceId) {
        return;
      }

      setIsTouchReviewImmersive(true);
      setCollapsed(false);
      selectOrOpenReviewTab();
      setIsReviewImmersive(true);
    };

    window.addEventListener(
      CUSTOM_EVENTS.OPEN_TOUCH_REVIEW_IMMERSIVE,
      handleOpenTouchReviewImmersive
    );
    return () =>
      window.removeEventListener(
        CUSTOM_EVENTS.OPEN_TOUCH_REVIEW_IMMERSIVE,
        handleOpenTouchReviewImmersive
      );
  }, [canReviewDiffs, selectOrOpenReviewTab, setCollapsed, setIsReviewImmersive, workspaceId]);

  React.useEffect(() => {
    const handleOpenReviewImmersive = (event: Event) => {
      const detail = (event as CustomEvent<{ workspaceId: string }>).detail;
      if (!canReviewDiffs) return;

      if (detail?.workspaceId !== workspaceId) {
        return;
      }

      setIsTouchReviewImmersive(false);
      setCollapsed(false);
      selectOrOpenReviewTab();
      setIsReviewImmersive(true);
    };

    window.addEventListener(CUSTOM_EVENTS.OPEN_REVIEW_IMMERSIVE, handleOpenReviewImmersive);
    return () =>
      window.removeEventListener(CUSTOM_EVENTS.OPEN_REVIEW_IMMERSIVE, handleOpenReviewImmersive);
  }, [canReviewDiffs, selectOrOpenReviewTab, setCollapsed, setIsReviewImmersive, workspaceId]);

  // Keyboard shortcuts for tab switching by position (Cmd/Ctrl+1-9)
  // Auto-expands sidebar if collapsed
  React.useEffect(() => {
    const tabKeybinds = [
      KEYBINDS.SIDEBAR_TAB_1,
      KEYBINDS.SIDEBAR_TAB_2,
      KEYBINDS.SIDEBAR_TAB_3,
      KEYBINDS.SIDEBAR_TAB_4,
      KEYBINDS.SIDEBAR_TAB_5,
      KEYBINDS.SIDEBAR_TAB_6,
      KEYBINDS.SIDEBAR_TAB_7,
      KEYBINDS.SIDEBAR_TAB_8,
      KEYBINDS.SIDEBAR_TAB_9,
    ];

    const handleKeyDown = (e: KeyboardEvent) => {
      for (let i = 0; i < tabKeybinds.length; i++) {
        if (matchesKeybind(e, tabKeybinds[i])) {
          e.preventDefault();

          const parsedLayout = parseRightSidebarLayoutState(layoutRawRef.current, initialActiveTab);
          const currentLayout = canReviewDiffs
            ? parsedLayout
            : removeTabEverywhere(parsedLayout, "review");
          const allTabs = collectAllTabsWithTabset(currentLayout.root);
          const target = allTabs[i];
          if (target && isTerminalTab(target.tab)) {
            const sessionId = getTerminalSessionId(target.tab);
            if (sessionId) {
              setAutoFocusTerminalSession(sessionId);
            }
          } else if (target?.tab === "review") {
            // Review panel keyboard navigation (j/k) is gated on focus. If the user explicitly
            // opened the tab via shortcut, focus the panel so it works immediately.
            _setFocusTrigger((prev) => prev + 1);
          }

          setLayout((prev) =>
            selectTabByIndex(canReviewDiffs ? prev : removeTabEverywhere(prev, "review"), i)
          );
          setCollapsed(false);
          return;
        }
      }
    };

    window.addEventListener("keydown", handleKeyDown);
    return () => window.removeEventListener("keydown", handleKeyDown);
  }, [
    canReviewDiffs,
    initialActiveTab,
    setAutoFocusTerminalSession,
    setCollapsed,
    setLayout,
    _setFocusTrigger,
  ]);

  React.useEffect(() => {
    const handleKeyDown = (e: KeyboardEvent) => {
      if (!matchesKeybind(e, KEYBINDS.TOGGLE_REVIEW_IMMERSIVE)) {
        return;
      }

      if (!canReviewDiffs) return;

      if (isEditableElement(e.target)) {
        return;
      }

      e.preventDefault();
      setCollapsed(false);
      selectOrOpenReviewTab();
      setIsReviewImmersive((prev) => {
        const next = !prev;
        if (next) {
          setIsTouchReviewImmersive(false);
        }
        return next;
      });
    };

    window.addEventListener("keydown", handleKeyDown);
    return () => window.removeEventListener("keydown", handleKeyDown);
  }, [canReviewDiffs, selectOrOpenReviewTab, setCollapsed, setIsReviewImmersive]);

  const baseId = `right-sidebar-${workspaceId}`;

  // Build map of tab → position for keybind tooltips
  const tabPositions = React.useMemo(() => {
    const allTabs = collectAllTabsWithTabset(layout.root);
    const positions = new Map<TabType, number>();
    allTabs.forEach(({ tab }, index) => {
      positions.set(tab, index);
    });
    return positions;
  }, [layout.root]);

  // Workspace-wide terminal ordering. Numbering per tabset would restart at
  // "Terminal"/#1 in every split, defeating the badge's per-tab identity.
  const terminalTabOrder = new Map<TabType, number>();
  collectAllTabs(layout.root)
    .filter(isTerminalTab)
    .forEach((tab, index) => terminalTabOrder.set(tab, index));

  // @dnd-kit state for tracking active drag
  const [activeDragData, setActiveDragData] = React.useState<TabDragData | null>(null);

  // Terminal titles from OSC sequences (e.g., shell setting window title)
  // Persisted to localStorage so they survive reload
  const terminalTitlesKey = getTerminalTitlesKey(workspaceId);
  const [terminalTitles, setTerminalTitles] = React.useState<Map<TabType, string>>(() => {
    const stored = readPersistedState<Record<string, string>>(terminalTitlesKey, {});
    return new Map(Object.entries(stored) as Array<[TabType, string]>);
  });

  const removeTerminalTab = React.useCallback(
    (tab: TabType) => {
      // User request: close terminal panes when the session exits.
      const nextLayout = removeTabEverywhere(getBaseLayout(), tab);
      setLayout(() => nextLayout);
      focusActiveTerminal(nextLayout);

      setTerminalTitles((prev) => {
        const next = new Map(prev);
        next.delete(tab);
        updatePersistedState(terminalTitlesKey, Object.fromEntries(next));
        return next;
      });
    },
    [focusActiveTerminal, getBaseLayout, setLayout, terminalTitlesKey]
  );

  // Keyboard shortcut for closing active terminal tab (Ctrl/Cmd+W)
  React.useEffect(() => {
    const handleKeyDown = (e: KeyboardEvent) => {
      if (isDesktopViewportFocused(e.target)) return;
      if (!matchesKeybind(e, KEYBINDS.CLOSE_TAB)) return;
      // Always prevent platform default (Cmd/Ctrl+W closes window), even during dialogs.
      e.preventDefault();
      if (isDialogOpen()) return;

      const focusedTabset = findTabset(layout.root, layout.focusedTabsetId);
      if (focusedTabset?.type !== "tabset") return;

      const activeTab = focusedTabset.activeTab;

      // Handle terminal tabs
      if (isTerminalTab(activeTab)) {
        e.preventDefault();

        // Close the backend session
        const sessionId = getTerminalSessionId(activeTab);
        if (sessionId) {
          api?.terminal.close({ sessionId }).catch((err) => {
            console.warn("[RightSidebar] Failed to close terminal session:", err);
          });
        }

        removeTerminalTab(activeTab);
        return;
      }
    };

    window.addEventListener("keydown", handleKeyDown, { capture: true });
    return () => window.removeEventListener("keydown", handleKeyDown, { capture: true });
  }, [api, focusActiveTerminal, layout, removeTerminalTab, setLayout]);

  // Sync terminal tabs with backend sessions on workspace mount.
  // - Adds tabs for backend sessions that don't have tabs (restore after reload)
  // - Removes "ghost" tabs for sessions that no longer exist (cleanup after app restart)
  React.useEffect(() => {
    if (!api) return;

    let cancelled = false;

    void api.terminal.listSessions({ workspaceId }).then((backendSessionIds) => {
      if (cancelled) return;

      const backendSessionSet = new Set(backendSessionIds);

      // Get current terminal tabs in layout
      const currentTabs = collectAllTabs(layout.root);
      const currentTerminalTabs = currentTabs.filter(isTerminalTab);
      const currentTerminalSessionIds = new Set(
        currentTerminalTabs.map(getTerminalSessionId).filter(Boolean)
      );

      // Find sessions that don't have tabs yet (add them)
      const missingSessions = backendSessionIds.filter(
        (sid) => !currentTerminalSessionIds.has(sid)
      );

      // Find tabs for sessions that no longer exist in backend (remove them)
      const ghostTabs = currentTerminalTabs.filter((tab) => {
        const sessionId = getTerminalSessionId(tab);
        return sessionId && !backendSessionSet.has(sessionId);
      });

      if (missingSessions.length > 0 || ghostTabs.length > 0) {
        setLayout((prev) => {
          let next = prev;

          // Remove ghost tabs first
          for (const ghostTab of ghostTabs) {
            next = removeTabEverywhere(next, ghostTab);
          }

          // Add tabs for backend sessions that don't have tabs
          for (const sessionId of missingSessions) {
            next = addTabToFocusedTabset(next, makeTerminalTabType(sessionId), false);
          }

          return next;
        });
      }
    });

    return () => {
      cancelled = true;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps -- Only run on workspace change, not layout change. layout.root would cause infinite loop.
  }, [api, workspaceId, setLayout]);

  // Handler to update a terminal's title (from OSC sequences)
  // Also persists to localStorage for reload survival
  const handleTerminalTitleChange = React.useCallback(
    (tab: TabType, title: string) => {
      setTerminalTitles((prev) => {
        const next = new Map(prev);
        next.set(tab, title);
        // Persist to localStorage
        updatePersistedState(terminalTitlesKey, Object.fromEntries(next));
        return next;
      });
    },
    [terminalTitlesKey]
  );

  // Handler to add a new terminal tab.
  // Creates the backend session first, then adds the tab with the real sessionId.
  // This ensures the tabType (and React key) never changes, preventing remounts.
  //
  // The promise is given a `.catch` so backend rejections (e.g., transcript-only workspaces
  // with no projectPath, archived worktrees, or disconnected SSH/Devcontainer runtimes)
  // surface to the user via PopoverError instead of becoming an unhandled promise rejection
  // that leaves the sidebar half-expanded and looks like an app crash. The wrapper stays
  // non-async (`() => void`) so the existing `addTerminalRef` / `onAddTerminal` callsites
  // (typed as void-returning) don't trip `no-misused-promises`.
  const handleAddTerminal = React.useCallback(
    (options?: TerminalSessionCreateOptions): void => {
      if (!api) return;

      // Also expand sidebar if collapsed
      setCollapsed(false);

      void createTerminalSession(api, workspaceId, options)
        .then((session) => {
          const newTab = makeTerminalTabType(session.sessionId);
          setLayout((prev) => addTabToFocusedTabset(prev, newTab));
          // Schedule focus for this terminal (will be consumed when the tab mounts)
          setAutoFocusTerminalSession(session.sessionId);
        })
        .catch((err: unknown) => {
          console.error("[RightSidebar] Failed to create terminal session:", err);
          terminalCreateError.showError("terminal-create", getErrorMessage(err));
        });
    },
    [api, workspaceId, setLayout, setCollapsed, terminalCreateError]
  );

  // Expose handleAddTerminal to parent via ref (for Cmd/Ctrl+T keybind)
  React.useEffect(() => {
    if (addTerminalRef) {
      addTerminalRef.current = handleAddTerminal;
    }
    return () => {
      if (addTerminalRef) {
        addTerminalRef.current = null;
      }
    };
  }, [addTerminalRef, handleAddTerminal]);

  // Handler to close a terminal tab
  const handleCloseTerminal = React.useCallback(
    (tab: TabType) => {
      // Close the backend session
      const sessionId = getTerminalSessionId(tab);
      if (sessionId) {
        api?.terminal.close({ sessionId }).catch((err) => {
          console.warn("[RightSidebar] Failed to close terminal session:", err);
        });
      }

      removeTerminalTab(tab);
    },
    [api, removeTerminalTab]
  );

  // Handler to pop out a terminal to a separate window, then remove the tab
  const handlePopOutTerminal = React.useCallback(
    (tab: TabType) => {
      if (!api) return;

      // Session ID is embedded in the tab type
      const sessionId = getTerminalSessionId(tab);
      if (!sessionId) return; // Can't pop out without a session

      // Open the pop-out window (handles browser vs Electron modes). The promise is
      // attached a `.catch` so an Electron terminalWindowManager rejection cannot become
      // an unhandled promise rejection. We surface it via the same PopoverError used by
      // handleAddTerminal — the user already paid the cost of removing the tab below, so
      // they need to know if the pop-out itself failed.
      // Carry the known OSC title into the pop-out; it is deleted from the
      // sidebar map below and the new window only sees future title changes.
      void openTerminalPopout(api, workspaceId, sessionId, terminalTitles.get(tab)).catch(
        (err: unknown) => {
          console.error("[RightSidebar] Failed to open terminal pop-out:", err);
          terminalCreateError.showError("terminal-popout", getErrorMessage(err));
        }
      );

      // Remove the tab from the sidebar (terminal now lives in its own window)
      // Don't close the session - the pop-out window takes over
      setLayout((prev) => removeTabEverywhere(prev, tab));

      // Clean up title (and persist)
      setTerminalTitles((prev) => {
        const next = new Map(prev);
        next.delete(tab);
        updatePersistedState(terminalTitlesKey, Object.fromEntries(next));
        return next;
      });
    },
    [workspaceId, api, setLayout, terminalTitlesKey, terminalCreateError, terminalTitles]
  );

  // Configure sensors with distance threshold for click vs drag disambiguation

  const sensors = useSensors(
    useSensor(PointerSensor, {
      activationConstraint: {
        distance: 8, // 8px movement required before drag starts
      },
    })
  );

  const handleDragStart = React.useCallback(
    (event: DragStartEvent) => {
      const data = event.active.data.current as TabDragData | undefined;
      if (data) {
        setActiveDragData(data);
        handleSidebarTabDragStart();
      }
    },
    [handleSidebarTabDragStart]
  );

  const handleDragEnd = React.useCallback(
    (event: DragEndEvent) => {
      const { active, over } = event;
      const activeData = active.data.current as TabDragData | undefined;

      if (activeData && over) {
        const overData = over.data.current as
          | { type: "edge"; tabsetId: string; edge: "top" | "bottom" | "left" | "right" }
          | { type: "content"; tabsetId: string }
          | { tabsetId: string }
          | TabDragData
          | undefined;

        if (overData) {
          // Handle dropping on edge zones (create splits)
          if ("type" in overData && overData.type === "edge") {
            setLayout((prev) =>
              dockTabToEdge(
                prev,
                activeData.tab,
                activeData.sourceTabsetId,
                overData.tabsetId,
                overData.edge
              )
            );
          }
          // Handle dropping on content area (move to tabset)
          else if ("type" in overData && overData.type === "content") {
            if (activeData.sourceTabsetId !== overData.tabsetId) {
              setLayout((prev) =>
                moveTabToTabset(prev, activeData.tab, activeData.sourceTabsetId, overData.tabsetId)
              );
            }
          }
          // Handle dropping on another tabstrip (move to tabset)
          else if ("tabsetId" in overData && !("tab" in overData)) {
            if (activeData.sourceTabsetId !== overData.tabsetId) {
              setLayout((prev) =>
                moveTabToTabset(prev, activeData.tab, activeData.sourceTabsetId, overData.tabsetId)
              );
            }
          }
          // Handle reordering within same tabset (sortable handles this via arrayMove pattern)
          else if ("tab" in overData && "sourceTabsetId" in overData) {
            // Both are tabs - check if same tabset for reorder
            if (activeData.sourceTabsetId === overData.sourceTabsetId) {
              const fromIndex = activeData.index;
              const toIndex = overData.index;
              if (fromIndex !== toIndex) {
                setLayout((prev) =>
                  reorderTabInTabset(prev, activeData.sourceTabsetId, fromIndex, toIndex)
                );
              }
            } else {
              // Different tabsets - move tab
              setLayout((prev) =>
                moveTabToTabset(
                  prev,
                  activeData.tab,
                  activeData.sourceTabsetId,
                  overData.sourceTabsetId
                )
              );
            }
          }
        }
      }

      setActiveDragData(null);
      handleSidebarTabDragEnd();
    },
    [setLayout, handleSidebarTabDragEnd]
  );

  const isDraggingTab = activeDragData !== null;

  const renderLayoutNode = (node: RightSidebarLayoutNode): React.ReactNode => {
    if (node.type === "split") {
      // Our layout uses "horizontal" to mean a horizontal divider (top/bottom panes).
      // react-resizable-panels uses "vertical" for top/bottom.
      const groupDirection = node.direction === "horizontal" ? "vertical" : "horizontal";

      return (
        <PanelGroup
          direction={groupDirection}
          className="flex min-h-0 min-w-0 flex-1"
          onLayout={(sizes) => {
            if (sizes.length !== 2) return;
            const nextSizes: [number, number] = [
              typeof sizes[0] === "number" ? sizes[0] : 50,
              typeof sizes[1] === "number" ? sizes[1] : 50,
            ];
            setLayout((prev) => updateSplitSizes(prev, node.id, nextSizes));
          }}
        >
          <Panel defaultSize={node.sizes[0]} minSize={15} className="flex min-h-0 min-w-0 flex-col">
            {renderLayoutNode(node.children[0])}
          </Panel>
          <DragAwarePanelResizeHandle direction={groupDirection} isDraggingTab={isDraggingTab} />
          <Panel defaultSize={node.sizes[1]} minSize={15} className="flex min-h-0 min-w-0 flex-col">
            {renderLayoutNode(node.children[1])}
          </Panel>
        </PanelGroup>
      );
    }

    return (
      <RightSidebarTabsetNode
        key={node.id}
        node={node}
        baseId={baseId}
        workspaceId={workspaceId}
        workspacePath={workspacePath}
        projectPath={projectPath}
        isCreating={Boolean(isCreating)}
        focusTrigger={focusTrigger}
        onReviewNote={onReviewNote}
        reviewStats={reviewStats}
        onReviewStatsChange={handleReviewStatsChange}
        isTouchReviewImmersive={isTouchReviewImmersive}
        onTouchReviewImmersiveChange={setIsTouchReviewImmersive}
        isDraggingTab={isDraggingTab}
        activeDragData={activeDragData}
        setLayout={setLayout}
        onPopOutTerminal={handlePopOutTerminal}
        onAddTerminal={handleAddTerminal}
        onCloseTerminal={handleCloseTerminal}
        onTerminalExit={removeTerminalTab}
        terminalTitles={terminalTitles}
        terminalTabOrder={terminalTabOrder}
        onTerminalTitleChange={handleTerminalTitleChange}
        tabPositions={tabPositions}
        onRequestTerminalFocus={setAutoFocusTerminalSession}
        autoFocusTerminalSession={autoFocusTerminalSession}
        goal={goal ?? null}
        goalCompleteInputRequest={goalCompleteInputRequest}
        onGoalSetStatus={handleGoalSetStatus}
        onGoalUpdateObjective={handleGoalUpdateObjective}
        onGoalUpdateBudget={handleGoalUpdateBudget}
        onGoalUpdateTurnCap={handleGoalUpdateTurnCap}
        onGoalClear={handleGoalClear}
        onGoalCreate={handleGoalCreate}
        onAutoFocusConsumed={() => setAutoFocusTerminalSession(null)}
      />
    );
  };

  return (
    <DndContext sensors={sensors} onDragStart={handleDragStart} onDragEnd={handleDragEnd}>
      <ReviewAssistedStatsReporter
        workspaceId={workspaceId}
        workspacePath={workspacePath}
        projectPath={projectPath}
        isCreating={Boolean(isCreating)}
        onUnreadAssistedChange={setUnreadAssisted}
      />
      <SidebarContainer
        collapsed={collapsed}
        isResizing={isResizing}
        isDesktop={isDesktopMode()}
        immersiveHidden={immersiveHidden}
        customWidth={width} // Unified width from AIView (applies to all tabs)
        role="complementary"
        aria-label="Workspace insights"
      >
        {!collapsed && (
          <div className="flex min-h-0 min-w-0 flex-1 flex-row">
            {/* Resize handle (left edge) */}
            {onStartResize && (
              <div
                className={cn(
                  "w-0.5 flex-shrink-0 z-10 transition-[background] duration-150 cursor-col-resize",
                  isResizing ? "bg-accent" : "bg-border-light hover:bg-accent"
                )}
                // eslint-disable-next-line local/no-chained-type-assertions -- grandfathered when the rule was introduced; fix the underlying type instead of copying this pattern
                onMouseDown={(e) => onStartResize(e as unknown as React.MouseEvent)}
              />
            )}

            <div className="flex min-h-0 min-w-0 flex-1 flex-col">
              {renderLayoutNode(layout.root)}
              <SidebarCollapseButton
                collapsed={collapsed}
                onToggle={() => setCollapsed(!collapsed)}
                side="right"
              />
            </div>
          </div>
        )}
        {collapsed && (
          <SidebarCollapseButton
            collapsed={collapsed}
            onToggle={() => setCollapsed(!collapsed)}
            side="right"
          />
        )}
      </SidebarContainer>

      {/* Drag overlay - shows tab being dragged at cursor position */}
      <DragOverlay>
        {activeDragData ? (
          <div className="border-border bg-background/95 cursor-grabbing rounded-md border px-3 py-1 text-xs font-medium shadow">
            {getTabName(activeDragData.tab)}
          </div>
        ) : null}
      </DragOverlay>

      <PopoverError
        error={terminalCreateError.error}
        prefix="Failed to open terminal:"
        onDismiss={terminalCreateError.clearError}
      />
    </DndContext>
  );
};

// Memoize to prevent re-renders when parent (AIView) re-renders during streaming
// Only re-renders when workspaceId or chatAreaRef changes, or internal state updates
export const RightSidebar = React.memo(RightSidebarComponent);

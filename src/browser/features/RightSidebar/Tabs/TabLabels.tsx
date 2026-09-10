/**
 * Tab label components for RightSidebar tabs.
 *
 * Each tab type has its own label component that handles badges, icons, and actions.
 *
 * CostsTabLabel and StatsTabLabel subscribe to their own data to avoid re-rendering
 * the entire RightSidebarTabsetNode tree when stats update during agent streaming.
 */

import React from "react";
import {
  BugPlay,
  ExternalLink,
  Monitor,
  Globe,
  Sparkles,
  Target,
  ListTree,
  Terminal as TerminalIcon,
  Workflow,
  X,
} from "lucide-react";
import { Tooltip, TooltipContent, TooltipTrigger } from "@/browser/components/Tooltip/Tooltip";
import { getTerminalTabFallbackName } from "@/browser/types/rightSidebar";
import { type ReviewStats } from "./registry";
import { useAPI } from "@/browser/contexts/API";
import { formatKeybind, KEYBINDS } from "@/browser/utils/ui/keybinds";
import { useAdditionalSystemContextSnapshot } from "@/browser/utils/additionalSystemContextStore";
import {
  ensureWorkspaceInstructionsFetched,
  useWorkspaceInstructionsFileCount,
} from "@/browser/utils/workspaceInstructionsStore";
import { cn } from "@/common/lib/utils";
import {
  useOptionalWorkspaceSidebarState,
  useWorkspaceUsage,
} from "@/browser/stores/WorkspaceStore";
import { goalActiveMode, isGoalPendingPersistence } from "@/common/types/goal";
import { sumUsageHistory, type ChatUsageDisplay } from "@/common/utils/tokens/usageAggregator";

interface StatsTabLabelProps {
  workspaceId: string;
}

/**
 * Unified Stats tab label with a session cost badge.
 * Subscribes to workspace usage directly to avoid re-rendering parent components.
 *
 * Accepts a context-bag prop so it can be invoked through the generic
 * `tabRegistry` Label slot (see `Tabs/tabRegistry.tsx`).
 */
export const StatsTabLabel: React.FC<StatsTabLabelProps> = ({ workspaceId }) => {
  const usage = useWorkspaceUsage(workspaceId);

  const sessionCost = React.useMemo(() => {
    const parts: ChatUsageDisplay[] = [];
    if (usage.sessionTotal) parts.push(usage.sessionTotal);
    if (usage.liveCostUsage) parts.push(usage.liveCostUsage);
    if (parts.length === 0) return null;

    const aggregated = sumUsageHistory(parts);
    if (!aggregated) return null;

    const total =
      (aggregated.input.cost_usd ?? 0) +
      (aggregated.cached.cost_usd ?? 0) +
      (aggregated.cacheCreate.cost_usd ?? 0) +
      (aggregated.output.cost_usd ?? 0) +
      (aggregated.reasoning.cost_usd ?? 0);
    return total > 0 ? total : null;
  }, [usage.sessionTotal, usage.liveCostUsage]);

  return (
    <>
      Stats
      {sessionCost !== null && (
        <span className="text-muted text-[10px] tabular-nums">
          ${sessionCost < 0.01 ? "<0.01" : sessionCost.toFixed(2)}
        </span>
      )}
    </>
  );
};

interface ReviewTabLabelProps {
  reviewStats: ReviewStats | null;
}

/**
 * Review tab label with two mutually-exclusive states:
 *
 *   • **Assisted-focus state** — when the agent has flagged hunks the user
 *     hasn't acked, the entire label renders as one `inline-flex
 *     items-center` group (Review · Sparkles · count) tinted with
 *     `--color-review-accent`. Same composition pattern as the Goal tab's
 *     icon-plus-text label, which guarantees the digit and the icon share
 *     a single alignment context — three separately-baselined siblings
 *     (the previous shape) let the digit drift off the icon center.
 *
 *     The `read/total` badge is suppressed in this state on purpose: two
 *     adjacent numbers (e.g. `Review ✦ 5 4/10`) are hard to parse, and
 *     the assisted count is the user's primary cue. The read/total
 *     badge returns once everything assisted has been read.
 *
 *   • **Default state** — plain "Review" plus the `read/total` badge,
 *     unchanged from the long-standing label.
 *
 * No animation in either state — pulsing was too noisy next to the other
 * static tab labels.
 */
export const ReviewTabLabel: React.FC<ReviewTabLabelProps> = ({ reviewStats }) => {
  const unreadAssisted = reviewStats?.unreadAssisted ?? 0;
  const hasUnreadAssisted = unreadAssisted > 0;

  if (hasUnreadAssisted) {
    return (
      <Tooltip>
        <TooltipTrigger asChild>
          <span
            className="text-review-accent inline-flex items-center gap-1"
            aria-label={`Review — ${unreadAssisted} unread agent-flagged hunk${unreadAssisted === 1 ? "" : "s"}`}
            data-testid="review-tab-assisted-pizzazz"
          >
            Review
            <Sparkles className="h-3 w-3 shrink-0" aria-hidden="true" />
            <span className="counter-nums">{unreadAssisted}</span>
          </span>
        </TooltipTrigger>
        <TooltipContent side="bottom">
          {unreadAssisted} agent-flagged hunk{unreadAssisted === 1 ? "" : "s"} pending review
        </TooltipContent>
      </Tooltip>
    );
  }

  return (
    <>
      Review
      {reviewStats !== null && reviewStats.total > 0 && (
        <span className="text-muted text-[10px]">
          {reviewStats.read}/{reviewStats.total}
        </span>
      )}
    </>
  );
};

/** Desktop tab label with monitor icon */
export const DesktopTabLabel: React.FC = () => (
  <span className="inline-flex items-center gap-1">
    <Monitor className="h-3 w-3 shrink-0" />
    Desktop
  </span>
);

/** Browser tab label with globe icon */
export const BrowserTabLabel: React.FC = () => (
  <span className="inline-flex items-center gap-1">
    <Globe className="h-3 w-3 shrink-0" />
    Browser
  </span>
);

/** Debug tab label with bug icon */
export const DebugTabLabel: React.FC = () => (
  <span className="inline-flex items-center gap-1">
    <BugPlay className="h-3 w-3 shrink-0" />
    Debug
  </span>
);

interface GoalTabLabelProps {
  workspaceId: string;
}

/**
 * Goal tab label.
 *
 * Subscribes directly to the workspace's sidebar state so the label can apply
 * a semantic accent (`text-success` or `text-warning`) when the workspace
 * has a *live* goal in chat:
 *
 *   • `text-success` — the goal is running (`status === "active"` &&
 *     non-pending). Mirrors the `useActiveGoalCount` /
 *     `ActiveGoalsWarningToast` predicate so a workspace that contributes
 *     to the global "active goals" toast is also the one that lights up
 *     green here.
 *   • `text-warning` — the goal is lifecycle-active but stalled (paused
 *     or budget-limited). Surfaces a glanceable cue that the workspace
 *     needs the user's attention even though no agent is currently
 *     burning turns. This mirrors the amber tinting on the Goals-tab
 *     header band and the `GoalStatusBadge` paused/budget-limited
 *     color.
 *
 * Pending-persistence goals (mid-stream / unsaved) stay unaccented so
 * the accent doesn't flicker during a stream — same gating as before.
 */
export const GoalTabLabel: React.FC<GoalTabLabelProps> = ({ workspaceId }) => {
  const sidebarState = useOptionalWorkspaceSidebarState(workspaceId);
  const goal = sidebarState?.goal ?? null;
  const activeMode = goal && !isGoalPendingPersistence(goal) ? goalActiveMode(goal.status) : null;
  const isRunning = activeMode === "running";
  const isStalled = activeMode === "paused" || activeMode === "budget_limited";
  const ariaLabel = isRunning
    ? "Goal (active)"
    : activeMode === "paused"
      ? "Goal (paused)"
      : activeMode === "budget_limited"
        ? "Goal (budget limited)"
        : "Goal";

  return (
    <span
      className={cn(
        "inline-flex items-center gap-1",
        isRunning && "text-success",
        isStalled && "text-warning"
      )}
      aria-label={ariaLabel}
    >
      <Target className="h-3 w-3 shrink-0" />
      Goal
    </span>
  );
};

interface WorkflowsTabLabelProps {
  workspaceId: string;
}

/**
 * Workflows tab label. Subscribes to the workspace's sidebar state to surface a
 * pulsing accent count of currently-active (pending/running/backgrounded) runs,
 * mirroring how the Goal/Stats labels expose live workspace signals.
 */
export const WorkflowsTabLabel: React.FC<WorkflowsTabLabelProps> = ({ workspaceId }) => {
  const sidebarState = useOptionalWorkspaceSidebarState(workspaceId);
  const activeCount = sidebarState?.activeWorkflowRunCount ?? 0;
  return (
    <span className="inline-flex items-center gap-1">
      <Workflow className="h-3 w-3 shrink-0" />
      Workflows
      {activeCount > 0 && (
        <span
          className="text-accent inline-flex items-center gap-1 text-[10px] tabular-nums"
          aria-label={`${activeCount} running workflow${activeCount === 1 ? "" : "s"}`}
        >
          <span className="bg-accent inline-block h-[6px] w-[6px] animate-pulse rounded-full motion-reduce:animate-none" />
          {activeCount}
        </span>
      )}
    </span>
  );
};

export function OutputTabLabel() {
  return <>Output</>;
}

export function TimelineTabLabel() {
  return (
    <span className="inline-flex items-center gap-1">
      <ListTree className="h-3 w-3 shrink-0" />
      Timeline
    </span>
  );
}

export function MemoryTabLabel() {
  return <>Memory</>;
}

interface InstructionsTabLabelProps {
  workspaceId: string;
}

/**
 * Instructions tab label with a count badge consistent with Stats/Review.
 *
 * Subscribes to the shared instructions store so the count stays in sync with
 * the panel's own fetches, and triggers a one-shot IPC fetch on first mount
 * when the count is unknown (e.g. another tab is active in the same tabset).
 *
 * The badge picks up the accent color when the per-workspace scratchpad has
 * any user content — a quick visual hint that this workspace is sending
 * additional system context to the agent.
 */
export const InstructionsTabLabel: React.FC<InstructionsTabLabelProps> = ({ workspaceId }) => {
  const { api } = useAPI();
  const fileCount = useWorkspaceInstructionsFileCount(workspaceId);
  const scratchpad = useAdditionalSystemContextSnapshot(workspaceId);
  const chatInstructionsActive = scratchpad.enabled && scratchpad.content.trim().length > 0;

  React.useEffect(() => {
    if (!api) return;
    ensureWorkspaceInstructionsFetched(api, workspaceId);
  }, [api, workspaceId]);

  // Chat Instructions, when active, contribute one additional "instruction
  // source" to the badge count. We mark them with a trailing asterisk so
  // users can tell ephemeral chat-scoped instructions apart from on-disk
  // AGENTS.md files at a glance.
  const baseCount = fileCount ?? 0;
  const displayCount = baseCount + (chatInstructionsActive ? 1 : 0);
  const showBadge = chatInstructionsActive || (fileCount != null && fileCount > 0);

  return (
    <>
      Instructions
      {showBadge && (
        <span
          className="text-muted text-[10px] tabular-nums"
          aria-label={
            chatInstructionsActive
              ? `${baseCount} instruction files plus active Chat Instructions`
              : `${baseCount} instruction files`
          }
        >
          {displayCount}
          {chatInstructionsActive && (
            // Orange asterisk mirrors the "dirty / has unsaved changes" cue used
            // by the git status indicator — a glanceable signal that the agent
            // is receiving ephemeral chat-scoped instructions in addition to
            // whatever AGENTS.md files contribute to this workspace.
            <span className="text-warning">*</span>
          )}
        </span>
      )}
    </>
  );
};

interface TerminalTabLabelProps {
  /** Dynamic title from OSC sequences, if available */
  dynamicTitle?: string;
  /** Terminal index (0-based) within the current tabset */
  terminalIndex: number;
  /** Callback when pop-out button is clicked */
  onPopOut: () => void;
  /** Callback when close button is clicked */
  onClose: () => void;
}

/** Terminal tab label with icon, dynamic title, and action buttons */
export const TerminalTabLabel: React.FC<TerminalTabLabelProps> = ({
  dynamicTitle,
  terminalIndex,
  onPopOut,
  onClose,
}) => {
  const displayName = dynamicTitle ?? getTerminalTabFallbackName(terminalIndex);

  return (
    <span className="inline-flex items-center gap-1">
      <TerminalIcon className="h-3 w-3 shrink-0" />
      <span className="max-w-[20ch] min-w-0 truncate">{displayName}</span>
      <Tooltip>
        <TooltipTrigger asChild>
          <button
            type="button"
            className="text-muted hover:text-foreground -my-0.5 rounded p-0.5 transition-colors"
            onClick={(e) => {
              e.stopPropagation();
              onPopOut();
            }}
            aria-label="Open terminal in new window"
          >
            <ExternalLink className="h-3 w-3" />
          </button>
        </TooltipTrigger>
        <TooltipContent side="bottom">Open in new window</TooltipContent>
      </Tooltip>
      <Tooltip>
        <TooltipTrigger asChild>
          <button
            type="button"
            className="text-muted hover:text-destructive -my-0.5 rounded p-0.5 transition-colors"
            onClick={(e) => {
              e.stopPropagation();
              onClose();
            }}
            aria-label="Close terminal"
          >
            <X className="h-3 w-3" />
          </button>
        </TooltipTrigger>
        <TooltipContent side="bottom">
          Close terminal ({formatKeybind(KEYBINDS.CLOSE_TAB)})
        </TooltipContent>
      </Tooltip>
    </span>
  );
};

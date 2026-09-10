/**
 * Right-sidebar tab registry — UI renderers for non-terminal tabs.
 *
 * Static tab metadata lives in `tabConfig.ts` so shared helpers can read tab
 * names/default-layout policy without importing React panels. This file layers
 * labels and panel renderers on top of that lightweight config for the actual
 * desktop right sidebar.
 *
 * Terminal tabs are intentionally NOT in this registry: they are
 * multi-instance (`terminal:<sessionId>`), keep-alive, and need session-aware
 * wiring that doesn't fit the static "one panel per id" shape. They live in
 * `RightSidebar.tsx` directly.
 */

import React from "react";
import { ErrorBoundary } from "@/browser/components/ErrorBoundary/ErrorBoundary";
import { InstructionsTab } from "@/browser/components/InstructionsTab/InstructionsTab";
import { OutputTab } from "@/browser/components/OutputTab/OutputTab";
import { StatsContainer } from "@/browser/features/RightSidebar/StatsContainer";
import { ReviewPanel } from "@/browser/features/RightSidebar/CodeReview/ReviewPanel";
import { DesktopPanel } from "@/browser/features/desktop/DesktopPanel";
import { BrowserTab } from "@/browser/features/RightSidebar/BrowserTab";
import { DevToolsTab } from "@/browser/features/RightSidebar/DevToolsTab";
import { GoalTab, type GoalCreateIntent } from "@/browser/features/RightSidebar/GoalTab";
import { MemoryTab } from "@/browser/features/RightSidebar/Memory/MemoryTab";
import { WorkflowsTab } from "@/browser/features/RightSidebar/Workflows/WorkflowsTab";
import { TimelinePanel } from "@/browser/features/RightSidebar/Timeline/TimelinePanel";
import type { GoalSnapshot, GoalStatus } from "@/common/types/goal";
import type { ReviewNoteData } from "@/common/types/review";
import { BASE_TAB_IDS, TAB_CONFIG, type BaseTabType, type TabConfig } from "./tabConfig";
import {
  BrowserTabLabel,
  DebugTabLabel,
  DesktopTabLabel,
  GoalTabLabel,
  InstructionsTabLabel,
  MemoryTabLabel,
  OutputTabLabel,
  ReviewTabLabel,
  StatsTabLabel,
  TimelineTabLabel,
  WorkflowsTabLabel,
} from "./TabLabels";

export { isBaseTabId, type BaseTabType } from "./tabConfig";

/** Stats reported by ReviewPanel for tab display (kept local to the registry). */
export interface ReviewStats {
  total: number;
  read: number;
  /**
   * Number of agent-flagged ("assisted") hunks that resolve to a hunk in the
   * current diff AND the user hasn't marked read yet. Used by the Review tab
   * label to surface an attention indicator while there's still unread agent
   * focus pending. 0 means either the agent flagged nothing or everything it
   * flagged has been read (or no flag intersects the current diff).
   */
  unreadAssisted: number;
}

/** Props every tab label receives. Most tabs ignore most fields. */
export interface TabLabelContext {
  workspaceId: string;
  /** Latest review stats (only consumed by the review label). */
  reviewStats: ReviewStats | null;
}

/** Props every tab panel renderer receives. Most tabs use just `workspaceId`. */
export interface TabPanelContext {
  workspaceId: string;
  workspacePath: string;
  projectPath: string;
  isCreating: boolean;
  /** Bumps when the workspace requests review-tab focus (e.g., immersive open). */
  focusTrigger: number;
  /** Stable key suffix for tabset-scoped panels (used by `ReviewPanel`). */
  tabsetId: string;
  /** Review-panel-specific callbacks. Other tabs ignore. */
  review: {
    onReviewNote?: (data: ReviewNoteData) => void;
    onStatsChange: (stats: ReviewStats | null) => void;
    isTouchImmersive: boolean;
    onTouchImmersiveChange: (isTouch: boolean) => void;
  };
  goal: {
    snapshot: GoalSnapshot | null;
    openCompleteInputRequest: number;
    onSetStatus: (
      status: Exclude<GoalStatus, "budget_limited">,
      completionSummary?: string
    ) => Promise<void>;
    onUpdateObjective: (objective: string) => Promise<void>;
    onUpdateBudget: (budgetCents: number | null) => Promise<void>;
    onUpdateTurnCap: (turnCap: number | null) => Promise<void>;
    onClear: () => Promise<void>;
    onCreate: (intent: GoalCreateIntent) => Promise<void>;
  };
}

/** Static description of one non-terminal tab, including UI renderers. */
export interface TabRegistration extends TabConfig {
  /** Workspace-scope label component (subscribes to per-workspace stores as needed). */
  Label: React.ComponentType<TabLabelContext>;
  /** Renders the panel body. Receives a workspace-scoped context bag. */
  renderPanel: (ctx: TabPanelContext) => React.ReactNode;
}

const TAB_RENDERERS = {
  costs: {
    Label: ({ workspaceId }) => <StatsTabLabel workspaceId={workspaceId} />,
    renderPanel: (ctx) => (
      <ErrorBoundary workspaceInfo="Stats tab">
        <StatsContainer workspaceId={ctx.workspaceId} />
      </ErrorBoundary>
    ),
  },
  review: {
    Label: ({ reviewStats }) => <ReviewTabLabel reviewStats={reviewStats} />,
    renderPanel: (ctx) => (
      <ReviewPanel
        // Re-key per (workspace, tabset) so an immersive overlay re-mounts cleanly when
        // the user moves the review tab between tabsets.
        key={`${ctx.workspaceId}:${ctx.tabsetId}`}
        workspaceId={ctx.workspaceId}
        workspacePath={ctx.workspacePath}
        projectPath={ctx.projectPath}
        onReviewNote={ctx.review.onReviewNote}
        focusTrigger={ctx.focusTrigger}
        isCreating={ctx.isCreating}
        isTouchImmersive={ctx.review.isTouchImmersive}
        onTouchImmersiveChange={ctx.review.onTouchImmersiveChange}
        onStatsChange={ctx.review.onStatsChange}
      />
    ),
  },
  instructions: {
    Label: ({ workspaceId }) => <InstructionsTabLabel workspaceId={workspaceId} />,
    renderPanel: (ctx) => <InstructionsTab workspaceId={ctx.workspaceId} />,
  },
  goal: {
    Label: ({ workspaceId }) => <GoalTabLabel workspaceId={workspaceId} />,
    renderPanel: (ctx) => (
      <ErrorBoundary workspaceInfo="Goal tab">
        <GoalTab
          workspaceId={ctx.workspaceId}
          goal={ctx.goal.snapshot}
          openCompleteInputRequest={ctx.goal.openCompleteInputRequest}
          onSetStatus={ctx.goal.onSetStatus}
          onUpdateObjective={ctx.goal.onUpdateObjective}
          onUpdateBudget={ctx.goal.onUpdateBudget}
          onUpdateTurnCap={ctx.goal.onUpdateTurnCap}
          onClear={ctx.goal.onClear}
          onCreate={ctx.goal.onCreate}
        />
      </ErrorBoundary>
    ),
  },
  timeline: {
    Label: TimelineTabLabel,
    renderPanel: (ctx) => (
      <ErrorBoundary workspaceInfo="Timeline tab">
        <TimelinePanel workspaceId={ctx.workspaceId} />
      </ErrorBoundary>
    ),
  },
  memory: {
    Label: MemoryTabLabel,
    renderPanel: (ctx) => <MemoryTab workspaceId={ctx.workspaceId} />,
  },
  workflows: {
    Label: ({ workspaceId }) => <WorkflowsTabLabel workspaceId={workspaceId} />,
    renderPanel: (ctx) => (
      <ErrorBoundary workspaceInfo="Workflows tab">
        <WorkflowsTab workspaceId={ctx.workspaceId} />
      </ErrorBoundary>
    ),
  },
  desktop: {
    Label: DesktopTabLabel,
    renderPanel: (ctx) => (
      <ErrorBoundary workspaceInfo="Desktop tab">
        <DesktopPanel workspaceId={ctx.workspaceId} />
      </ErrorBoundary>
    ),
  },
  browser: {
    Label: BrowserTabLabel,
    renderPanel: (ctx) => (
      <ErrorBoundary workspaceInfo="Browser tab">
        <BrowserTab workspaceId={ctx.workspaceId} projectPath={ctx.projectPath} />
      </ErrorBoundary>
    ),
  },
  output: {
    Label: OutputTabLabel,
    renderPanel: (ctx) => <OutputTab workspaceId={ctx.workspaceId} />,
  },
  debug: {
    Label: DebugTabLabel,
    renderPanel: (ctx) => (
      <ErrorBoundary workspaceInfo="Debug tab">
        <DevToolsTab workspaceId={ctx.workspaceId} />
      </ErrorBoundary>
    ),
  },
} satisfies Record<
  BaseTabType,
  {
    Label: React.ComponentType<TabLabelContext>;
    renderPanel: (ctx: TabPanelContext) => React.ReactNode;
  }
>;

/** Public UI registry indexed by tab id. */
export const TAB_REGISTRY: Record<BaseTabType, TabRegistration> = Object.fromEntries(
  BASE_TAB_IDS.map((id) => [id, { ...TAB_CONFIG[id], ...TAB_RENDERERS[id] }])
) as Record<BaseTabType, TabRegistration>;

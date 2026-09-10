import type { FrontendWorkspaceMetadata } from "@/common/types/workspace";
import type { ProjectConfig } from "@/common/types/project";
import { hasCompletedAgentReport } from "@/common/utils/agentTaskCompletion";
import { assert } from "@/common/utils/assert";
import { comparePinnedOrder, isWorkspacePinned } from "@/common/utils/pin";

interface WorkspaceGroupConfig {
  id: string;
}

function flattenWorkspaceTree(
  workspaces: FrontendWorkspaceMetadata[]
): FrontendWorkspaceMetadata[] {
  if (workspaces.length === 0) return [];

  const byId = new Map<string, FrontendWorkspaceMetadata>();
  for (const workspace of workspaces) {
    byId.set(workspace.id, workspace);
  }

  const childrenByParent = new Map<string, FrontendWorkspaceMetadata[]>();
  const roots: FrontendWorkspaceMetadata[] = [];

  // Preserve input order for both roots and siblings by iterating in-order.
  // Active sub-workspaces only render when their full parent chain is active.
  for (const workspace of workspaces) {
    const parentId = workspace.parentWorkspaceId;
    if (parentId == null) {
      roots.push(workspace);
      continue;
    }

    if (!byId.has(parentId)) {
      continue;
    }

    const children = childrenByParent.get(parentId) ?? [];
    children.push(workspace);
    childrenByParent.set(parentId, children);
  }

  const result: FrontendWorkspaceMetadata[] = [];
  const visited = new Set<string>();
  const stack = roots.slice().reverse();

  while (stack.length > 0) {
    const workspace = stack.pop();
    assert(workspace != null, "flattenWorkspaceTree: stack entries must exist while traversing");

    if (visited.has(workspace.id)) {
      continue;
    }
    visited.add(workspace.id);
    result.push(workspace);

    const children = childrenByParent.get(workspace.id);
    if (!children) {
      continue;
    }

    for (let index = children.length - 1; index >= 0; index -= 1) {
      stack.push(children[index]);
    }
  }

  for (const workspace of workspaces) {
    if (visited.has(workspace.id)) {
      continue;
    }

    assert(
      workspace.parentWorkspaceId != null,
      "flattenWorkspaceTree: unvisited root workspaces should have been traversed"
    );
    // Intentionally drop orphaned/cyclic descendants instead of promoting them to roots.
  }

  return result;
}

export function computeWorkspaceDepthMap(
  workspaces: FrontendWorkspaceMetadata[]
): Record<string, number> {
  const byId = new Map<string, FrontendWorkspaceMetadata>();
  for (const workspace of workspaces) {
    byId.set(workspace.id, workspace);
  }

  const depths = new Map<string, number>();
  const visiting = new Set<string>();

  const computeDepth = (workspaceId: string): number => {
    const existing = depths.get(workspaceId);
    if (existing !== undefined) return existing;

    if (visiting.has(workspaceId)) {
      // Cycle detected - treat as root.
      return 0;
    }

    visiting.add(workspaceId);
    const workspace = byId.get(workspaceId);
    const parentId = workspace?.parentWorkspaceId;
    const depth = parentId && byId.has(parentId) ? Math.min(computeDepth(parentId) + 1, 32) : 0;
    visiting.delete(workspaceId);

    depths.set(workspaceId, depth);
    return depth;
  };

  for (const workspace of workspaces) {
    computeDepth(workspace.id);
  }

  return Object.fromEntries(depths);
}

export interface WorkspaceDelegatedActivity {
  activeCount: number;
  queuedCount: number;
  workflowActiveCount: number;
  workflowQueuedCount: number;
}

interface DelegatedActivityOptions {
  isWorkspaceLiveActive?: (workspaceId: string) => boolean;
}

function createEmptyDelegatedActivity(): WorkspaceDelegatedActivity {
  return {
    activeCount: 0,
    queuedCount: 0,
    workflowActiveCount: 0,
    workflowQueuedCount: 0,
  };
}

function addDelegatedActivity(
  target: WorkspaceDelegatedActivity,
  source: WorkspaceDelegatedActivity
): void {
  target.activeCount += source.activeCount;
  target.queuedCount += source.queuedCount;
  target.workflowActiveCount += source.workflowActiveCount;
  target.workflowQueuedCount += source.workflowQueuedCount;
}

function hasDelegatedActivity(activity: WorkspaceDelegatedActivity): boolean {
  return activity.activeCount > 0 || activity.queuedCount > 0;
}

export function isSidebarSubAgentRunning(
  workspace: FrontendWorkspaceMetadata,
  options: DelegatedActivityOptions = {}
): boolean {
  return (
    workspace.taskExecutionStatus === "starting" ||
    workspace.taskExecutionStatus === "running" ||
    isRunningOrStartingTaskStatus(workspace.taskStatus) ||
    getIsWorkspaceLiveActive(workspace.id, options)
  );
}

export function isActionableTaskExecutionStatus(
  status: FrontendWorkspaceMetadata["taskExecutionStatus"]
): boolean {
  return status === "queued" || status === "starting" || status === "running";
}

export function isActiveOrStartingTaskStatus(
  status: FrontendWorkspaceMetadata["taskStatus"]
): boolean {
  return status === "starting" || status === "running" || status === "awaiting_report";
}

export function isRunningOrStartingTaskStatus(
  status: FrontendWorkspaceMetadata["taskStatus"]
): boolean {
  return status === "starting" || status === "running";
}

export function isBlockedPreStreamTaskStatus(
  status: FrontendWorkspaceMetadata["taskStatus"]
): boolean {
  return status === "queued" || status === "starting";
}

function getIsWorkspaceLiveActive(workspaceId: string, options: DelegatedActivityOptions): boolean {
  try {
    return options.isWorkspaceLiveActive?.(workspaceId) === true;
  } catch {
    // Sidebar store teardown can race workspace metadata updates. Ignore the
    // live hint rather than making a malformed descendant brick rendering.
    return false;
  }
}

/** Queued task work that has not yet produced a completed report. */
function isWorkspaceDelegatedActivityQueued(workspace: FrontendWorkspaceMetadata): boolean {
  return (
    workspace.taskExecutionStatus === "queued" ||
    (!hasCompletedAgentReport(workspace) && workspace.taskStatus === "queued")
  );
}

export function isWorkspaceDelegatedActivityActive(
  workspace: FrontendWorkspaceMetadata,
  options: DelegatedActivityOptions = {}
): boolean {
  if (
    workspace.taskExecutionStatus === "starting" ||
    workspace.taskExecutionStatus === "running" ||
    isActiveOrStartingTaskStatus(workspace.taskStatus)
  ) {
    return true;
  }
  if (hasCompletedAgentReport(workspace)) {
    return false;
  }

  // Interrupted tasks without a finalized report can still be streaming while
  // task finalization catches up, so let the live fallback decide.
  return getIsWorkspaceLiveActive(workspace.id, options);
}

/**
 * Roll active descendant task state up to parent rows for sidebar attention.
 * The child itself is counted for its ancestors, while each child row only
 * receives counts for its own descendants so rows don't double-count themselves.
 */
export function computeDelegatedActivityByWorkspaceId(
  workspaces: readonly FrontendWorkspaceMetadata[],
  options: DelegatedActivityOptions = {}
): Map<string, WorkspaceDelegatedActivity> {
  const workspaceById = new Map<string, FrontendWorkspaceMetadata>();
  for (const workspace of workspaces) {
    assert(
      workspace.id.length > 0,
      "computeDelegatedActivityByWorkspaceId: workspace id is required"
    );
    workspaceById.set(workspace.id, workspace);
  }

  const childrenByParentId = new Map<string, FrontendWorkspaceMetadata[]>();
  const roots: FrontendWorkspaceMetadata[] = [];
  for (const workspace of workspaceById.values()) {
    const parentId = workspace.parentWorkspaceId;
    if (!parentId || !workspaceById.has(parentId)) {
      roots.push(workspace);
      continue;
    }

    const children = childrenByParentId.get(parentId) ?? [];
    children.push(workspace);
    childrenByParentId.set(parentId, children);
  }

  const activityByWorkspaceId = new Map<string, WorkspaceDelegatedActivity>();
  const visited = new Set<string>();

  const getIsLiveActive = (workspaceId: string): boolean => {
    try {
      return options.isWorkspaceLiveActive?.(workspaceId) === true;
    } catch {
      // Sidebar store teardown can race workspace metadata updates. Ignore the
      // live hint rather than making a malformed descendant brick rendering.
      return false;
    }
  };

  const traverse = (
    workspace: FrontendWorkspaceMetadata,
    ancestorWorkflowOwned: boolean,
    path: Set<string>
  ): WorkspaceDelegatedActivity => {
    if (path.has(workspace.id)) {
      return createEmptyDelegatedActivity();
    }
    if (visited.has(workspace.id)) {
      return activityByWorkspaceId.get(workspace.id) ?? createEmptyDelegatedActivity();
    }

    path.add(workspace.id);
    const ownWorkflowOwned = ancestorWorkflowOwned || workspace.workflowTask != null;
    const descendantActivity = createEmptyDelegatedActivity();

    for (const child of childrenByParentId.get(workspace.id) ?? []) {
      const childWorkflowOwned = ownWorkflowOwned || child.workflowTask != null;
      if (isWorkspaceDelegatedActivityActive(child, { isWorkspaceLiveActive: getIsLiveActive })) {
        descendantActivity.activeCount += 1;
        if (childWorkflowOwned) {
          descendantActivity.workflowActiveCount += 1;
        }
      } else if (isWorkspaceDelegatedActivityQueued(child)) {
        descendantActivity.queuedCount += 1;
        if (childWorkflowOwned) {
          descendantActivity.workflowQueuedCount += 1;
        }
      }

      addDelegatedActivity(descendantActivity, traverse(child, childWorkflowOwned, path));
    }

    path.delete(workspace.id);
    visited.add(workspace.id);
    if (hasDelegatedActivity(descendantActivity)) {
      activityByWorkspaceId.set(workspace.id, descendantActivity);
    }
    return descendantActivity;
  };

  for (const root of roots) {
    traverse(root, root.workflowTask != null, new Set());
  }

  return activityByWorkspaceId;
}

/**
 * Drop rows whose ancestry reaches a root in the list (the opt-in "hide
 * sub-agents in sidebar" setting). Orphans keep rendering as promoted roots,
 * and members of malformed parent cycles stay visible so corrupted metadata
 * cannot make workspaces inaccessible.
 */
export function excludeSubAgentRows(
  workspaces: FrontendWorkspaceMetadata[]
): FrontendWorkspaceMetadata[] {
  const byId = new Map(workspaces.map((workspace) => [workspace.id, workspace] as const));
  const reachesRootById = new Map<string, boolean>();

  const reachesRoot = (workspace: FrontendWorkspaceMetadata, path: Set<string>): boolean => {
    const cached = reachesRootById.get(workspace.id);
    if (cached !== undefined) {
      return cached;
    }
    if (path.has(workspace.id)) {
      return false;
    }

    path.add(workspace.id);
    const parentId = workspace.parentWorkspaceId;
    const parent = parentId != null ? byId.get(parentId) : undefined;
    const result = parent == null ? true : reachesRoot(parent, path);
    path.delete(workspace.id);

    reachesRootById.set(workspace.id, result);
    return result;
  };

  return workspaces.filter((workspace) => {
    const parentId = workspace.parentWorkspaceId;
    if (parentId == null || !byId.has(parentId)) {
      return true;
    }
    return !reachesRoot(workspace, new Set());
  });
}

/**
 * Descendant census a parent row shows while its sub-agent rows are hidden,
 * mirroring the transcript's sub-agent decoration: workflow workers are
 * counted separately from user-owned sub-agents.
 */
export interface WorkspaceSubAgentsSummary {
  /** All user-owned (non-workflow) descendants, active or not. */
  subAgentCount: number;
  /** Running user-owned descendants. */
  runningSubAgentCount: number;
  /** Queued user-owned descendants. */
  queuedSubAgentCount: number;
  /** Distinct workflow runs with at least one running descendant worker. */
  runningWorkflowRunCount: number;
  /** Distinct workflow runs whose descendant workers are all queued. */
  queuedWorkflowRunCount: number;
  /** Running workflow-owned descendant workers across runs. */
  runningWorkflowAgentCount: number;
  /** Queued workflow-owned descendant workers across runs. */
  queuedWorkflowAgentCount: number;
  /**
   * IDs of the runs behind the run counts, so a parent's own active runs
   * that currently have no live worker can be reconciled instead of hidden
   * behind a concurrent run's workers.
   */
  workflowRunIds: ReadonlySet<string>;
  /** Name of the first running workflow run, or first queued run when none run. */
  workflowName?: string;
  /** Title of the first running workflow worker, the run's current step. */
  runningWorkflowStepTitle?: string;
}

interface SubAgentsSummaryOptions extends DelegatedActivityOptions {
  /**
   * Active workflow run IDs owned by a workspace, from live sidebar state.
   * Lets the rollup keep a hidden descendant's run visible while it is
   * between sequential steps and has no countable workers.
   */
  getActiveWorkflowRunIds?: (workspaceId: string) => readonly string[];
  /**
   * Workflow name for a run, from state retained beyond worker lifetimes.
   * Workers are deleted after reporting, so a run between sequential steps
   * has no descendant carrying its name.
   */
  getWorkflowRunName?: (runId: string) => string | undefined;
}

/** Roll a hidden-descendant census up to each ancestor workspace. */
export function computeSubAgentsSummaryByWorkspaceId(
  workspaces: readonly FrontendWorkspaceMetadata[],
  options: SubAgentsSummaryOptions = {}
): Map<string, WorkspaceSubAgentsSummary> {
  const workspaceById = new Map<string, FrontendWorkspaceMetadata>();
  for (const workspace of workspaces) {
    workspaceById.set(workspace.id, workspace);
  }

  const childrenByParentId = new Map<string, FrontendWorkspaceMetadata[]>();
  const roots: FrontendWorkspaceMetadata[] = [];
  for (const workspace of workspaceById.values()) {
    const parentId = workspace.parentWorkspaceId;
    if (!parentId || !workspaceById.has(parentId)) {
      roots.push(workspace);
      continue;
    }

    const children = childrenByParentId.get(parentId) ?? [];
    children.push(workspace);
    childrenByParentId.set(parentId, children);
  }

  interface WorkflowRunRollup {
    hasRunning: boolean;
    name?: string;
    runningStepTitle?: string;
  }

  interface MutableSummary {
    subAgentCount: number;
    runningSubAgentCount: number;
    queuedSubAgentCount: number;
    runningWorkflowAgentCount: number;
    queuedWorkflowAgentCount: number;
    workflowRunsById: Map<string, WorkflowRunRollup>;
  }

  const result = new Map<string, WorkspaceSubAgentsSummary>();

  // Each workspace has at most one parent, so traversal from roots reaches
  // every node at most once; nodes inside parent cycles are never roots and
  // stay unreachable, so no cycle guard is needed.
  const traverse = (
    workspace: FrontendWorkspaceMetadata,
    ancestorWorkflowRunId: string | undefined
  ): MutableSummary => {
    const summary: MutableSummary = {
      subAgentCount: 0,
      runningSubAgentCount: 0,
      queuedSubAgentCount: 0,
      runningWorkflowAgentCount: 0,
      queuedWorkflowAgentCount: 0,
      workflowRunsById: new Map(),
    };

    const mergeWorkflowRun = (runId: string, rollup: WorkflowRunRollup): void => {
      const run = summary.workflowRunsById.get(runId) ?? { hasRunning: false };
      run.hasRunning ||= rollup.hasRunning;
      run.name ??= rollup.name;
      run.runningStepTitle ??= rollup.runningStepTitle;
      summary.workflowRunsById.set(runId, run);
    };

    for (const child of childrenByParentId.get(workspace.id) ?? []) {
      // Descendants of a workflow worker stay workflow-owned, matching the
      // delegated-activity rollup.
      const childWorkflowRunId = child.workflowTask?.runId ?? ancestorWorkflowRunId;
      const isRunning = isWorkspaceDelegatedActivityActive(child, options);
      const isQueued = !isRunning && isWorkspaceDelegatedActivityQueued(child);

      if (childWorkflowRunId == null) {
        summary.subAgentCount += 1;
        if (isRunning) {
          summary.runningSubAgentCount += 1;
        } else if (isQueued) {
          summary.queuedSubAgentCount += 1;
        }
      } else if (isRunning || isQueued) {
        if (isRunning) {
          summary.runningWorkflowAgentCount += 1;
        } else {
          summary.queuedWorkflowAgentCount += 1;
        }
        mergeWorkflowRun(childWorkflowRunId, {
          hasRunning: isRunning,
          name: child.workflowTask?.workflowName,
          runningStepTitle: isRunning ? (child.title ?? child.name) : undefined,
        });
      }

      const childSummary = traverse(child, childWorkflowRunId);
      summary.subAgentCount += childSummary.subAgentCount;
      summary.runningSubAgentCount += childSummary.runningSubAgentCount;
      summary.queuedSubAgentCount += childSummary.queuedSubAgentCount;
      summary.runningWorkflowAgentCount += childSummary.runningWorkflowAgentCount;
      summary.queuedWorkflowAgentCount += childSummary.queuedWorkflowAgentCount;
      for (const [runId, rollup] of childSummary.workflowRunsById) {
        mergeWorkflowRun(runId, rollup);
      }

      // A run the child owns that has no tracked worker (between sequential
      // steps) is still in progress and must count as running; runs already
      // tracked by workers keep their worker-derived state, mirroring the
      // displayed row's own-run reconciliation.
      for (const runId of options.getActiveWorkflowRunIds?.(child.id) ?? []) {
        if (!summary.workflowRunsById.has(runId)) {
          summary.workflowRunsById.set(runId, { hasRunning: true });
        }
      }
    }

    if (summary.subAgentCount > 0 || summary.workflowRunsById.size > 0) {
      let runningWorkflowRunCount = 0;
      let queuedWorkflowRunCount = 0;
      let runningWorkflowName: string | undefined;
      let queuedWorkflowName: string | undefined;
      let runningWorkflowStepTitle: string | undefined;
      for (const [runId, run] of summary.workflowRunsById) {
        const runName = run.name ?? options.getWorkflowRunName?.(runId);
        if (run.hasRunning) {
          runningWorkflowRunCount += 1;
          runningWorkflowName ??= runName;
          runningWorkflowStepTitle ??= run.runningStepTitle;
        } else {
          queuedWorkflowRunCount += 1;
          queuedWorkflowName ??= runName;
        }
      }

      result.set(workspace.id, {
        subAgentCount: summary.subAgentCount,
        runningSubAgentCount: summary.runningSubAgentCount,
        queuedSubAgentCount: summary.queuedSubAgentCount,
        runningWorkflowRunCount,
        queuedWorkflowRunCount,
        runningWorkflowAgentCount: summary.runningWorkflowAgentCount,
        queuedWorkflowAgentCount: summary.queuedWorkflowAgentCount,
        workflowRunIds: new Set(summary.workflowRunsById.keys()),
        // A queued-only run must never lend its name to the running label.
        workflowName: runningWorkflowRunCount > 0 ? runningWorkflowName : queuedWorkflowName,
        runningWorkflowStepTitle,
      });
    }
    return summary;
  };

  for (const root of roots) {
    traverse(root, root.workflowTask?.runId);
  }

  return result;
}

export interface AgentRowRenderMeta {
  depth: number;
  /** Nearest visible ancestor after inactive intermediate sub-agents are removed. */
  visibleParentWorkspaceId?: string;
  rowKind: "primary" | "subagent";
  connectorPosition: "single" | "middle" | "last";
  // Sub-agent trunks should render as a single continuous line, so each row
  // receives explicit geometry/animation flags derived from its visible sibling
  // order and the lowest running child in that sibling group.
  connectorStartsAtParent: boolean;
  sharedTrunkActiveThroughRow: boolean;
  sharedTrunkActiveBelowRow: boolean;
  // Nested sub-agents need ancestor continuation columns whenever an ancestor
  // branch has visible lower siblings, so connector rendering receives one trunk
  // descriptor per continuing ancestor depth.
  ancestorTrunks: ReadonlyArray<{ depth: number; active: boolean }>;
  hasHiddenCompletedChildren: boolean;
  visibleCompletedChildrenCount: number;
}

/**
 * Keep only active sub-agent rows in the left sidebar. Inactive persistent children remain
 * accessible through the transcript's sub-agent decoration, which is the canonical hierarchy UI.
 * Active descendants remain visible even when an intermediate persistent parent is inactive.
 */
export function filterVisibleAgentRows(
  flattenedWorkspaces: FrontendWorkspaceMetadata[],
  _expandedParentIds: ReadonlySet<string> = new Set(),
  options: DelegatedActivityOptions = {}
): FrontendWorkspaceMetadata[] {
  if (flattenedWorkspaces.length === 0) {
    return [];
  }

  const byId = new Map<string, FrontendWorkspaceMetadata>();
  for (const workspace of flattenedWorkspaces) {
    byId.set(workspace.id, workspace);
  }

  const visibilityById = new Map<string, boolean>();
  const visiting = new Set<string>();

  const isVisible = (workspace: FrontendWorkspaceMetadata): boolean => {
    const cached = visibilityById.get(workspace.id);
    if (cached !== undefined) {
      return cached;
    }

    if (visiting.has(workspace.id)) {
      // Defensive cycle handling: keep nodes visible instead of accidentally hiding them forever.
      return true;
    }

    visiting.add(workspace.id);

    const parentId = workspace.parentWorkspaceId;
    if (!parentId) {
      visiting.delete(workspace.id);
      visibilityById.set(workspace.id, true);
      return true;
    }

    const parent = byId.get(parentId);
    if (!parent) {
      visiting.delete(workspace.id);
      visibilityById.set(workspace.id, true);
      return true;
    }

    // Completed children are terminal even if WorkspaceStore still has a stale live signal from
    // their final stream. Reuse the delegated-activity predicate so retained reports cannot leak
    // inactive persistent children back into the sidebar; queued work remains visible before it has
    // live runtime state.
    const visible =
      workspace.taskExecutionStatus === "queued" ||
      workspace.taskStatus === "queued" ||
      isWorkspaceDelegatedActivityActive(workspace, options);

    visiting.delete(workspace.id);
    visibilityById.set(workspace.id, visible);
    return visible;
  };

  return flattenedWorkspaces.filter((workspace) => isVisible(workspace));
}

/**
 * Build render metadata for visible rows in a flattened workspace tree.
 */
export function computeAgentRowRenderMeta(
  flattenedWorkspaces: FrontendWorkspaceMetadata[],
  _depthByWorkspaceId: Record<string, number>,
  expandedParentIds: ReadonlySet<string> = new Set(),
  options: DelegatedActivityOptions = {}
): Map<string, AgentRowRenderMeta> {
  const visibleRows = filterVisibleAgentRows(flattenedWorkspaces, expandedParentIds, options);
  const workspaceById = new Map(
    flattenedWorkspaces.map((workspace) => [workspace.id, workspace] as const)
  );
  const visibleWorkspaceIds = new Set(visibleRows.map((workspace) => workspace.id));
  const visibleChildrenByParent = new Map<string, FrontendWorkspaceMetadata[]>();
  const visibleWorkspaceById = new Map<string, FrontendWorkspaceMetadata>();
  const effectiveParentByWorkspaceId = new Map<string, string>();

  for (const workspace of visibleRows) {
    visibleWorkspaceById.set(workspace.id, workspace);

    let parentId = workspace.parentWorkspaceId;
    const visitedParentIds = new Set<string>();
    while (parentId != null && !visibleWorkspaceIds.has(parentId)) {
      if (visitedParentIds.has(parentId)) {
        parentId = undefined;
        break;
      }
      visitedParentIds.add(parentId);
      parentId = workspaceById.get(parentId)?.parentWorkspaceId;
    }
    if (parentId == null) {
      continue;
    }

    effectiveParentByWorkspaceId.set(workspace.id, parentId);
    const siblings = visibleChildrenByParent.get(parentId) ?? [];
    siblings.push(workspace);
    visibleChildrenByParent.set(parentId, siblings);
  }

  const metadataByWorkspaceId = new Map<string, AgentRowRenderMeta>();

  for (const workspace of visibleRows) {
    const effectiveParentId = effectiveParentByWorkspaceId.get(workspace.id);
    const rowKind = effectiveParentId != null ? "subagent" : "primary";

    let connectorPosition: AgentRowRenderMeta["connectorPosition"] = "single";
    let connectorStartsAtParent = false;
    let sharedTrunkActiveThroughRow = false;
    let sharedTrunkActiveBelowRow = false;
    let ancestorTrunks: AgentRowRenderMeta["ancestorTrunks"] = [];

    if (effectiveParentId != null) {
      const siblings = visibleChildrenByParent.get(effectiveParentId) ?? [];
      const siblingIndex = siblings.findIndex((sibling) => sibling.id === workspace.id);
      if (siblings.length > 1) {
        connectorPosition = siblings[siblings.length - 1]?.id === workspace.id ? "last" : "middle";
      }

      if (siblingIndex >= 0) {
        connectorStartsAtParent = siblingIndex === 0;

        let lastRunningSiblingIndex = -1;
        for (let index = siblings.length - 1; index >= 0; index -= 1) {
          const sibling = siblings[index];
          if (sibling != null && isSidebarSubAgentRunning(sibling, options)) {
            lastRunningSiblingIndex = index;
            break;
          }
        }

        // Animate one shared trunk from the parent down through the lowest
        // running child, even when intermediate children are not running.
        if (lastRunningSiblingIndex >= 0) {
          sharedTrunkActiveThroughRow = siblingIndex <= lastRunningSiblingIndex;
          sharedTrunkActiveBelowRow = siblingIndex < lastRunningSiblingIndex;
        }
      }

      const continuingAncestorTrunks: Array<{ depth: number; active: boolean }> = [];
      const visitedAncestorIds = new Set<string>();
      let ancestorId: string | undefined = effectiveParentId;
      while (ancestorId && !visitedAncestorIds.has(ancestorId)) {
        visitedAncestorIds.add(ancestorId);

        const ancestorMeta = metadataByWorkspaceId.get(ancestorId);
        const ancestorDepth = ancestorMeta?.depth ?? 0;
        if (ancestorDepth > 0 && ancestorMeta?.connectorPosition === "middle") {
          continuingAncestorTrunks.push({
            depth: ancestorDepth,
            active: ancestorMeta.sharedTrunkActiveBelowRow,
          });
        }

        if (!visibleWorkspaceById.has(ancestorId)) {
          break;
        }
        ancestorId = effectiveParentByWorkspaceId.get(ancestorId);
      }

      continuingAncestorTrunks.sort((left, right) => left.depth - right.depth);
      ancestorTrunks = continuingAncestorTrunks;
    }

    const effectiveDepth =
      effectiveParentId != null
        ? (metadataByWorkspaceId.get(effectiveParentId)?.depth ?? 0) + 1
        : 0;
    metadataByWorkspaceId.set(workspace.id, {
      depth: effectiveDepth,
      ...(effectiveParentId != null ? { visibleParentWorkspaceId: effectiveParentId } : {}),
      rowKind,
      connectorPosition,
      connectorStartsAtParent,
      sharedTrunkActiveThroughRow,
      sharedTrunkActiveBelowRow,
      ancestorTrunks,
      // Inactive sub-agents are intentionally absent from the sidebar; the transcript decoration
      // is the canonical place to inspect and manage the persistent hierarchy.
      hasHiddenCompletedChildren: false,
      visibleCompletedChildrenCount: 0,
    });
  }

  return metadataByWorkspaceId;
}

/**
 * One renderable sidebar row in final visual order: either a workspace row or
 * a synthetic task-group header. Connector geometry must be derived from this
 * final order (after group coalescing pulled member rows together), otherwise
 * trunks/elbows go stale around group headers.
 */
export interface SidebarVisibleRowNode {
  id: string;
  parentId: string | undefined;
  depth: number;
  /** Drives the shared-trunk animation through this row's sibling run. */
  isRunning: boolean;
  /** Base meta whose non-connector fields (rowKind, completed-children info) are preserved. */
  baseMeta: AgentRowRenderMeta;
}

/**
 * Recompute connector geometry for the final, visible row order. Mirrors the
 * sibling/trunk rules of computeAgentRowRenderMeta but works on generic nodes
 * so synthetic group-header rows participate in the same geometry as
 * workspace rows.
 */
export function computeRowMetaForVisibleNodes(
  nodes: readonly SidebarVisibleRowNode[]
): Map<string, AgentRowRenderMeta> {
  const nodesById = new Map(nodes.map((node) => [node.id, node] as const));
  const childrenByParentId = new Map<string, SidebarVisibleRowNode[]>();
  for (const node of nodes) {
    if (node.parentId == null) {
      continue;
    }
    const siblings = childrenByParentId.get(node.parentId) ?? [];
    siblings.push(node);
    childrenByParentId.set(node.parentId, siblings);
  }

  const metaById = new Map<string, AgentRowRenderMeta>();
  for (const node of nodes) {
    if (node.parentId == null) {
      metaById.set(node.id, { ...node.baseMeta, ancestorTrunks: [] });
      continue;
    }

    const siblings = childrenByParentId.get(node.parentId) ?? [];
    const siblingIndex = siblings.findIndex((sibling) => sibling.id === node.id);
    let connectorPosition: AgentRowRenderMeta["connectorPosition"] = "single";
    if (siblings.length > 1) {
      connectorPosition = siblings[siblings.length - 1]?.id === node.id ? "last" : "middle";
    }

    let lastRunningSiblingIndex = -1;
    for (let index = siblings.length - 1; index >= 0; index -= 1) {
      if (siblings[index]?.isRunning) {
        lastRunningSiblingIndex = index;
        break;
      }
    }

    const connectorStartsAtParent = siblingIndex === 0;
    const sharedTrunkActiveThroughRow =
      siblingIndex >= 0 && lastRunningSiblingIndex >= 0 && siblingIndex <= lastRunningSiblingIndex;
    const sharedTrunkActiveBelowRow =
      siblingIndex >= 0 && lastRunningSiblingIndex >= 0 && siblingIndex < lastRunningSiblingIndex;

    const ancestorTrunks: Array<{ depth: number; active: boolean }> = [];
    const visitedAncestorIds = new Set<string>();
    let ancestorId: string | undefined = node.parentId;
    while (ancestorId && !visitedAncestorIds.has(ancestorId)) {
      visitedAncestorIds.add(ancestorId);

      const ancestorNode = nodesById.get(ancestorId);
      if (!ancestorNode) {
        break;
      }

      const ancestorMeta = metaById.get(ancestorId);
      if (ancestorNode.depth > 0 && ancestorMeta?.connectorPosition === "middle") {
        ancestorTrunks.push({
          depth: ancestorNode.depth,
          active: ancestorMeta.sharedTrunkActiveBelowRow,
        });
      }

      ancestorId = ancestorNode.parentId;
    }
    ancestorTrunks.sort((left, right) => left.depth - right.depth);

    metaById.set(node.id, {
      ...node.baseMeta,
      depth: node.depth,
      connectorPosition,
      connectorStartsAtParent,
      sharedTrunkActiveThroughRow,
      sharedTrunkActiveBelowRow,
      ancestorTrunks,
    });
  }

  return metaById;
}

/**
 * Age thresholds for workspace filtering, in ascending order.
 * Each tier hides workspaces older than the specified duration.
 */
export const AGE_THRESHOLDS_DAYS = [1, 7, 30] as const;

const DAY_MS = 24 * 60 * 60 * 1000;

/**
 * Parse an optional ISO timestamp string to epoch milliseconds, treating missing
 * or unparseable values as 0. Used as a sort key so absent/malformed timestamps
 * deterministically sort last (oldest) instead of leaking NaN into comparisons.
 */
function parseTimestampMs(value: string | undefined): number {
  const parsed = Date.parse(value ?? "");
  return Number.isFinite(parsed) ? parsed : 0;
}

/**
 * Ascending lexicographic comparison for use as an Array.sort tie-breaker,
 * returning the standard -1 / 0 / 1 so equal values fall through to the next
 * tie-breaker instead of short-circuiting the sort.
 */
function compareStringsAsc(a: string, b: string): number {
  return a < b ? -1 : a > b ? 1 : 0;
}

/**
 * Pinned rows float above unpinned ones in stable pin order (pinnedAt asc: new
 * pins append at the bottom of the pinned block); recency is intentionally
 * ignored for pinned rows so activity never reshuffles them. Returns the pinned
 * placement delta, or null when both rows share the same pinned status so the
 * caller can fall through to its own tie-breakers (recency, stable order, ...).
 */
function comparePinnedPlacement(
  a: FrontendWorkspaceMetadata,
  b: FrontendWorkspaceMetadata
): number | null {
  const aPinned = isWorkspacePinned(a);
  const bPinned = isWorkspacePinned(b);
  if (aPinned !== bPinned) {
    return aPinned ? -1 : 1;
  }
  if (aPinned && bPinned) {
    return comparePinnedOrder(a, b);
  }
  return null;
}

function sortWorkspaceRows(
  workspaces: FrontendWorkspaceMetadata[],
  workspaceRecency: Record<string, number>
): void {
  workspaces.sort((a, b) => {
    const pinnedPlacement = comparePinnedPlacement(a, b);
    if (pinnedPlacement !== null) {
      return pinnedPlacement;
    }

    const aTimestamp = workspaceRecency[a.id] ?? 0;
    const bTimestamp = workspaceRecency[b.id] ?? 0;
    if (aTimestamp !== bTimestamp) {
      return bTimestamp - aTimestamp;
    }

    const aCreatedAt = parseTimestampMs(a.createdAt);
    const bCreatedAt = parseTimestampMs(b.createdAt);
    if (aCreatedAt !== bCreatedAt) {
      return bCreatedAt - aCreatedAt;
    }

    const nameOrder = compareStringsAsc(a.name, b.name);
    if (nameOrder !== 0) {
      return nameOrder;
    }

    return compareStringsAsc(a.id, b.id);
  });
}

/**
 * Build a map of project paths to sorted workspace metadata lists.
 * Includes both persisted workspaces (from config) and workspaces from
 * metadata that haven't yet appeared in config (handles race condition
 * where metadata event arrives before config refresh completes).
 *
 * Workspaces are sorted by recency (most recent first).
 */
export function buildSortedWorkspacesByProject(
  projects: Map<string, ProjectConfig>,
  workspaceMetadata: Map<string, FrontendWorkspaceMetadata>,
  workspaceRecency: Record<string, number>
): Map<string, FrontendWorkspaceMetadata[]> {
  const result = new Map<string, FrontendWorkspaceMetadata[]>();
  const includedIds = new Set<string>();

  // First pass: include workspaces from persisted config
  for (const [projectPath, config] of projects) {
    const metadataList: FrontendWorkspaceMetadata[] = [];
    for (const ws of config.workspaces) {
      if (!ws.id) continue;
      const meta = workspaceMetadata.get(ws.id);
      if (meta) {
        metadataList.push(meta);
        includedIds.add(ws.id);
      }
    }
    result.set(projectPath, metadataList);
  }

  // Second pass: add workspaces from metadata not yet in projects config
  // (handles race condition where metadata event arrives before config refresh completes)
  for (const [id, metadata] of workspaceMetadata) {
    if (!includedIds.has(id)) {
      const projectWorkspaces = result.get(metadata.projectPath) ?? [];
      projectWorkspaces.push(metadata);
      result.set(metadata.projectPath, projectWorkspaces);
    }
  }

  // Sort each project's workspaces by recency (sort mutates in place)
  // IMPORTANT: Include deterministic tie-breakers so Storybook visual snapshots can't
  // flip ordering when multiple workspaces have equal recency.
  for (const metadataList of result.values()) {
    sortWorkspaceRows(metadataList, workspaceRecency);
  }

  // Ensure child workspaces appear directly below their parents.
  for (const [projectPath, metadataList] of result) {
    result.set(projectPath, flattenWorkspaceTree(metadataList));
  }

  return result;
}

/** Build one globally sorted workspace tree for the optional flat sidebar. */
export function buildSortedWorkspacesFlat(
  workspaces: FrontendWorkspaceMetadata[],
  workspaceRecency: Record<string, number>
): FrontendWorkspaceMetadata[] {
  const rows = [...workspaces];
  sortWorkspaceRows(rows, workspaceRecency);
  return flattenWorkspaceTree(rows);
}

/**
 * Order rows for the flat Multi-Project section. The rows are collected across
 * per-primary-project buckets of the sorted map, so without this pass two
 * pinned multi-project chats with different primary projects would render in
 * bucket order and a cross-primary pinned reorder would visually snap back.
 * Pinned roots float to the top in global pinnedAt order (matching every other
 * pinned block); unpinned rows keep their collected relative order (stable
 * sort), and the tree flatten restores sub-agent adjacency under parents.
 *
 * Shared by the sidebar renderer and pinned-reorder block resolution so drag
 * targets always match what is on screen.
 */
export function orderMultiProjectSectionRows(
  rows: FrontendWorkspaceMetadata[]
): FrontendWorkspaceMetadata[] {
  // Unpinned rows keep their collected relative order (comparePinnedPlacement
  // returns null -> 0, and Array.sort is stable).
  const sorted = rows.slice().sort((a, b) => comparePinnedPlacement(a, b) ?? 0);
  return flattenWorkspaceTree(sorted);
}

/**
 * Format a day count for display.
 * Returns a human-readable string like "1 day", "7 days", etc.
 */
export function formatDaysThreshold(days: number): string {
  return days === 1 ? "1 day" : `${days} days`;
}

/**
 * Result of partitioning workspaces by age thresholds.
 * - recent: workspaces newer than the first threshold (1 day)
 * - buckets: array of workspaces for each threshold tier
 *   - buckets[0]: older than 1 day but newer than 7 days
 *   - buckets[1]: older than 7 days but newer than 30 days
 *   - buckets[2]: older than 30 days
 */
interface AgePartitionResult {
  recent: FrontendWorkspaceMetadata[];
  buckets: FrontendWorkspaceMetadata[][];
}

/**
 * Build the storage key for a tier's expanded state.
 */
export function getTierKey(projectPath: string, tierIndex: number): string {
  return `${projectPath}:${tierIndex}`;
}

/**
 * Find the next non-empty tier starting from a given index.
 * @returns The index of the next non-empty bucket, or -1 if none found.
 */
export function findNextNonEmptyTier(
  buckets: FrontendWorkspaceMetadata[][],
  startIndex: number
): number {
  for (let i = startIndex; i < buckets.length; i++) {
    if (buckets[i].length > 0) return i;
  }
  return -1;
}

/**
 * Partition workspaces into age-based buckets.
 *
 * Parent/child hierarchy is preserved across tiers: if a workspace has a parent
 * present in the same list, it inherits the parent's tier. This keeps sub-agent
 * rows colocated with their parent instead of splitting them across recent/old
 * buckets based on each child row's individual recency.
 *
 * Workspaces older than the first threshold remain in old-age tiers, even when
 * that leaves the recent section empty.
 */
export function partitionWorkspacesByAge(
  workspaces: FrontendWorkspaceMetadata[],
  workspaceRecency: Record<string, number>
): AgePartitionResult {
  if (workspaces.length === 0) {
    return { recent: [], buckets: AGE_THRESHOLDS_DAYS.map(() => []) };
  }

  const now = Date.now();
  const thresholdMs = AGE_THRESHOLDS_DAYS.map((d) => d * DAY_MS);
  const byId = new Map(workspaces.map((workspace) => [workspace.id, workspace] as const));

  // Tier index: -1 => recent, 0..N-1 => age buckets.
  const tierByWorkspaceId = new Map<string, number>();
  const visiting = new Set<string>();

  const classifyByOwnRecency = (workspace: FrontendWorkspaceMetadata): number => {
    // Pinned chats never age out into the collapsed "Older than N days" buckets;
    // children inherit this tier via resolveTierIndex so the whole subtree stays visible.
    if (isWorkspacePinned(workspace)) {
      return -1;
    }

    const recencyTimestamp = workspaceRecency[workspace.id] ?? 0;
    const age = now - recencyTimestamp;

    if (age < thresholdMs[0]) {
      return -1;
    }

    for (let i = 0; i < thresholdMs.length - 1; i++) {
      if (age >= thresholdMs[i] && age < thresholdMs[i + 1]) {
        return i;
      }
    }

    return thresholdMs.length - 1;
  };

  const resolveTierIndex = (workspace: FrontendWorkspaceMetadata): number => {
    const cachedTier = tierByWorkspaceId.get(workspace.id);
    if (cachedTier !== undefined) {
      return cachedTier;
    }

    if (visiting.has(workspace.id)) {
      // Defensive cycle handling: fall back to direct age classification.
      const fallbackTier = classifyByOwnRecency(workspace);
      tierByWorkspaceId.set(workspace.id, fallbackTier);
      return fallbackTier;
    }

    visiting.add(workspace.id);

    const parentId = workspace.parentWorkspaceId;
    const parent = parentId ? byId.get(parentId) : undefined;
    const tierIndex = parent ? resolveTierIndex(parent) : classifyByOwnRecency(workspace);

    visiting.delete(workspace.id);
    tierByWorkspaceId.set(workspace.id, tierIndex);
    return tierIndex;
  };

  const recent: FrontendWorkspaceMetadata[] = [];
  const buckets: FrontendWorkspaceMetadata[][] = AGE_THRESHOLDS_DAYS.map(() => []);

  for (const workspace of workspaces) {
    const tierIndex = resolveTierIndex(workspace);
    if (tierIndex === -1) {
      recent.push(workspace);
      continue;
    }

    const safeBucketIndex =
      tierIndex >= 0 && tierIndex < buckets.length ? tierIndex : buckets.length - 1;
    buckets[safeBucketIndex].push(workspace);
  }

  return { recent, buckets };
}

// ─────────────────────────────────────────────────────────────────────────────
// Section-based workspace grouping
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Result of partitioning workspaces by section.
 * - unsectioned: workspaces not assigned to any section
 * - bySectionId: map of section ID to workspaces in that section
 */
interface SectionPartitionResult {
  unsectioned: FrontendWorkspaceMetadata[];
  bySectionId: Map<string, FrontendWorkspaceMetadata[]>;
}

/**
 * Partition workspaces by their sectionId.
 * Preserves input order within each partition.
 *
 * @param workspaces - All workspaces for the project (in display order)
 * @param sections - Section configs for the project (used to validate section IDs)
 * @returns Partitioned workspaces
 */
export function partitionWorkspacesBySection(
  workspaces: FrontendWorkspaceMetadata[],
  sections: WorkspaceGroupConfig[]
): SectionPartitionResult {
  const sectionIds = new Set(sections.map((s) => s.id));
  const unsectioned: FrontendWorkspaceMetadata[] = [];
  const bySectionId = new Map<string, FrontendWorkspaceMetadata[]>();

  // Initialize all sections with empty arrays to ensure consistent ordering
  for (const section of sections) {
    bySectionId.set(section.id, []);
  }

  // Build workspace lookup for parent resolution
  const byId = new Map<string, FrontendWorkspaceMetadata>();
  for (const workspace of workspaces) {
    byId.set(workspace.id, workspace);
  }

  for (const workspace of workspaces) {
    const effectiveSectionId = resolveEffectiveSectionId(workspace, byId, sectionIds);
    if (effectiveSectionId) {
      const list = bySectionId.get(effectiveSectionId)!;
      list.push(workspace);
    } else {
      unsectioned.push(workspace);
    }
  }

  return { unsectioned, bySectionId };
}

/**
 * Resolve the effective sub-project section ID for a workspace, matching how
 * the sidebar renders it: honor the workspace's own `subProjectPath` if the
 * section still exists, otherwise inherit from the parent workspace (sub-agent
 * children created via the task tool do not set `subProjectPath` themselves).
 *
 * Exported so keybind/command handlers can stay in sync with the renderer
 * without re-implementing the parent walk.
 */
export function resolveEffectiveSectionId(
  workspace: FrontendWorkspaceMetadata,
  byId: ReadonlyMap<string, FrontendWorkspaceMetadata>,
  sectionIds: ReadonlySet<string>
): string | undefined {
  if (workspace.subProjectPath && sectionIds.has(workspace.subProjectPath)) {
    return workspace.subProjectPath;
  }
  if (workspace.parentWorkspaceId) {
    const parent = byId.get(workspace.parentWorkspaceId);
    if (parent) {
      return resolveEffectiveSectionId(parent, byId, sectionIds);
    }
  }
  return undefined;
}

/**
 * Build the storage key for a section's expanded state.
 */
export function getSectionExpandedKey(projectPath: string, sectionId: string): string {
  return `section:${projectPath}:${sectionId}`;
}

/**
 * Build the storage key for a section's age tier expanded state.
 * This is separate from project-level tiers to allow per-section age collapse.
 */
export function getSectionTierKey(
  projectPath: string,
  sectionId: string,
  tierIndex: number
): string {
  return `section:${projectPath}:${sectionId}:tier:${tierIndex}`;
}

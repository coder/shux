import {
  Bot,
  CheckCircle2,
  CircleSlash2,
  CircleX,
  Clock3,
  LoaderCircle,
  Workflow,
} from "lucide-react";

import { useEffect, useRef, useState, useSyncExternalStore } from "react";

import { useAPI } from "@/browser/contexts/API";
import { useWorkspaceMetadata } from "@/browser/contexts/WorkspaceContext";
import { useWorkspaceStoreRaw } from "@/browser/stores/WorkspaceStore";
import { isActiveWorkflowRunStatus } from "@/common/types/workflow";
import type { WorkflowRunLivenessEntry } from "@/common/orpc/schemas/api";
import { shortenWorkflowRunId } from "@/browser/components/ProjectSidebar/sidebarTaskGroups";
import { usePersistedState } from "@/browser/hooks/usePersistedState";
import { useRouter } from "@/browser/contexts/RouterContext";
import { ChatInputDecoration } from "@/browser/components/ChatPane/ChatInputDecoration";
import { getSubAgentTasksExpandedKey } from "@/common/constants/storage";
import type { FrontendWorkspaceMetadata } from "@/common/types/workspace";
import { isWorkspaceArchived } from "@/common/utils/archive";
import { isActionableTaskExecutionStatus } from "@/browser/utils/ui/workspaceFiltering";
import { cn } from "@/common/lib/utils";

interface DescendantSubAgent {
  workspace: FrontendWorkspaceMetadata;
  depth: number;
}

// Matches useWorkflowRunById's refresh cadence; polls only while a nested gap group renders.
const NESTED_RUN_VERIFY_INTERVAL_MS = 2_000;
const NESTED_RUN_VERIFY_MAX_FAILURES = 3;
const RUN_DISCOVERY_RETRY_BASE_MS = 1_000;
const RUN_DISCOVERY_RETRY_MAX_MS = 30_000;

const ACTIVE_SUBAGENT_STATUSES = new Set<FrontendWorkspaceMetadata["taskStatus"]>([
  "queued",
  "starting",
  "running",
  "awaiting_report",
]);

export function isSubAgentActive(workspace: FrontendWorkspaceMetadata): boolean {
  return (
    isActionableTaskExecutionStatus(workspace.taskExecutionStatus) ||
    ACTIVE_SUBAGENT_STATUSES.has(workspace.taskStatus)
  );
}

/** Live workers of one workflow run, in traversal order (parents before children). */
export interface WorkflowAgentGroup {
  runId: string;
  /** Display name stamped at spawn time; absent on runs from before the field existed. */
  workflowName?: string;
  /** Workspace whose durable run store owns this run (the workers' spawner). */
  ownerWorkspaceId?: string;
  workers: DescendantSubAgent[];
}

export interface DescendantAgents {
  /** User-owned descendant tasks in stable workspace order. */
  subAgents: DescendantSubAgent[];
  /** Workflow-owned descendants grouped per run, in first-encounter order. */
  workflowGroups: WorkflowAgentGroup[];
  /** Every traversed descendant workspace id (workflow-run owners live here too). */
  descendantWorkspaceIds: string[];
}

/**
 * Split the parent's descendants into user-owned sub-agents and workflow
 * workers. Workflow workers stay transient implementation details the parent
 * never manages individually, but they ARE the workflow's current state, so the
 * tray lists them grouped per run instead of leaving the run invisible.
 * User-owned tasks spawned by a worker stay inside that run's group.
 */
export function collectDescendantAgents(
  workspaces: Iterable<FrontendWorkspaceMetadata>,
  parentWorkspaceId: string
): DescendantAgents {
  const childrenByParentId = new Map<string, FrontendWorkspaceMetadata[]>();
  for (const workspace of workspaces) {
    if (
      workspace.parentWorkspaceId == null ||
      isWorkspaceArchived(workspace.archivedAt, workspace.unarchivedAt)
    ) {
      continue;
    }
    const children = childrenByParentId.get(workspace.parentWorkspaceId) ?? [];
    children.push(workspace);
    childrenByParentId.set(workspace.parentWorkspaceId, children);
  }

  const subAgents: DescendantSubAgent[] = [];
  const workflowGroups: WorkflowAgentGroup[] = [];
  const groupsByRunId = new Map<string, WorkflowAgentGroup>();
  const visited = new Set<string>([parentWorkspaceId]);
  const stack = (childrenByParentId.get(parentWorkspaceId) ?? [])
    .map((workspace) => ({ workspace, depth: 1, runId: workspace.workflowTask?.runId ?? null }))
    .reverse();

  while (stack.length > 0) {
    const next = stack.pop();
    if (next == null || visited.has(next.workspace.id)) {
      continue;
    }
    visited.add(next.workspace.id);

    if (next.runId == null) {
      subAgents.push({ workspace: next.workspace, depth: next.depth });
    } else {
      let group = groupsByRunId.get(next.runId);
      if (group == null) {
        group = {
          runId: next.runId,
          // Workers run inside the workspace that owns the run's durable record.
          ownerWorkspaceId: next.workspace.parentWorkspaceId,
          workers: [],
        };
        groupsByRunId.set(next.runId, group);
        workflowGroups.push(group);
      }
      group.workflowName ??= next.workspace.workflowTask?.workflowName;
      group.workers.push({ workspace: next.workspace, depth: next.depth });
    }

    const children = childrenByParentId.get(next.workspace.id) ?? [];
    for (let index = children.length - 1; index >= 0; index -= 1) {
      const child = children[index];
      stack.push({
        workspace: child,
        depth: next.depth + 1,
        // A nested workflow's workers regroup under their own run; user-owned
        // tasks spawned by a worker inherit the worker's run.
        runId: child.workflowTask?.runId ?? next.runId,
      });
    }
  }

  visited.delete(parentWorkspaceId);
  return { subAgents, workflowGroups, descendantWorkspaceIds: [...visited] };
}

/** Per-run info learned from observed worker rows; survives the workers' deletion. */
export interface ObservedWorkflowRunInfo {
  workflowName?: string;
  /** Workspace whose durable run store owns this run (for liveness verification). */
  ownerWorkspaceId?: string;
  /**
   * True once the run id has appeared in some owner's activity set. Nested
   * (workflow-in-workflow) runs never do — the backend deliberately excludes runs
   * with `parentWorkflow` from workspace activity — so their liveness must be
   * verified against the durable run record instead. Top-level runs seeded by
   * cold-mount discovery start false too: they flip as soon as activity reports
   * them, and until then (e.g. while the activity bootstrap is unavailable) the
   * same durable-record verification owns their liveness.
   */
  activityCovered: boolean;
}

/**
 * Sequential workflows delete each worker workspace once it reports, and the next
 * worker may not exist yet — during that gap a purely row-derived group list goes
 * empty and the run would vanish from the tray even though it is still active.
 * Synthesize a header-only group (its workers' workspaces are deleted, so no rows)
 * for every run known to be alive but currently worker-less:
 *   - runs in some owner's activity set (`activeRunIds`), including on a cold
 *     mount mid-gap where nothing was ever observed;
 *   - observed runs activity does not cover — nested runs (never in activity)
 *     and top-level runs seeded while the activity bootstrap was unavailable —
 *     until `isObservedRunDead` reports their durable record as settled.
 * `observed` (mutated: learn + prune) mirrors the ProjectSidebar's retention refs.
 */
export function mergeActiveWorkflowGroups(
  current: readonly WorkflowAgentGroup[],
  activeRunIds: readonly string[],
  observed: Map<string, ObservedWorkflowRunInfo>,
  isObservedRunDead: (runId: string) => boolean
): WorkflowAgentGroup[] {
  const activeIds = new Set(activeRunIds);
  const currentIds = new Set(current.map((group) => group.runId));
  for (const group of current) {
    const entry = observed.get(group.runId) ?? { activityCovered: false };
    if (group.workflowName != null) {
      entry.workflowName = group.workflowName;
    }
    if (group.ownerWorkspaceId != null) {
      entry.ownerWorkspaceId = group.ownerWorkspaceId;
    }
    observed.set(group.runId, entry);
  }
  for (const [runId, entry] of observed) {
    entry.activityCovered ||= activeIds.has(runId);
    if (currentIds.has(runId)) {
      continue;
    }
    const dead = entry.activityCovered ? !activeIds.has(runId) : isObservedRunDead(runId);
    if (dead) {
      observed.delete(runId);
    }
  }
  const merged = [...current];
  for (const runId of activeIds) {
    if (!currentIds.has(runId)) {
      merged.push({ runId, workflowName: observed.get(runId)?.workflowName, workers: [] });
    }
  }
  for (const [runId, entry] of observed) {
    if (entry.activityCovered || currentIds.has(runId)) {
      continue;
    }
    merged.push({
      runId,
      workflowName: entry.workflowName,
      ownerWorkspaceId: entry.ownerWorkspaceId,
      workers: [],
    });
  }
  return merged;
}

export function getSubAgentStatusPresentation(workspace: FrontendWorkspaceMetadata): {
  label: string;
  icon: typeof Clock3;
  iconClassName: string;
} {
  // No execution status (never-reawakened sub-agent) falls through to taskStatus.
  if (workspace.taskExecutionStatus !== undefined) {
    switch (workspace.taskExecutionStatus) {
      case "queued":
        return { label: "Queued", icon: Clock3, iconClassName: "text-muted" };
      case "starting":
      case "running":
        return {
          label: "Running",
          icon: LoaderCircle,
          iconClassName: "text-success animate-spin",
        };
      case "completed":
        return { label: "Completed", icon: CheckCircle2, iconClassName: "text-success" };
      case "interrupted":
        return { label: "Interrupted", icon: CircleSlash2, iconClassName: "text-muted" };
      case "error":
        return { label: "Failed", icon: CircleX, iconClassName: "text-danger" };
    }
  }
  switch (workspace.taskStatus) {
    case "queued":
      return { label: "Queued", icon: Clock3, iconClassName: "text-muted" };
    case "starting":
      return { label: "Starting", icon: LoaderCircle, iconClassName: "text-warning animate-spin" };
    case "running":
      return { label: "Running", icon: LoaderCircle, iconClassName: "text-success animate-spin" };
    case "awaiting_report":
      return { label: "Finishing", icon: LoaderCircle, iconClassName: "text-warning animate-spin" };
    case "reported":
      return { label: "Completed", icon: CheckCircle2, iconClassName: "text-success" };
    case "interrupted":
      return { label: "Interrupted", icon: CircleSlash2, iconClassName: "text-muted" };
    default:
      return { label: "Inactive", icon: CheckCircle2, iconClassName: "text-muted" };
  }
}

function AgentRow(props: {
  workspace: FrontendWorkspaceMetadata;
  indentLevel: number;
  onNavigate: (workspaceId: string) => void;
}) {
  const status = getSubAgentStatusPresentation(props.workspace);
  const StatusIcon = status.icon;
  return (
    <button
      type="button"
      onClick={() => props.onNavigate(props.workspace.id)}
      className="hover:bg-hover flex w-full min-w-0 items-center gap-2 rounded px-2 py-1.5 text-left transition-colors"
      style={{ paddingLeft: `${Math.min(props.indentLevel, 4) * 12 + 8}px` }}
    >
      <StatusIcon className={cn("size-3.5 shrink-0", status.iconClassName)} />
      <span className="text-foreground min-w-0 flex-1 truncate text-xs">
        {props.workspace.title ?? props.workspace.name}
      </span>
      <span className="text-muted shrink-0 text-[10px]">{status.label}</span>
    </button>
  );
}

function formatWorkflowSummary(workflowGroups: readonly WorkflowAgentGroup[]): string {
  const workerCount = workflowGroups.reduce((count, group) => count + group.workers.length, 0);
  const activeWorkerCount = workflowGroups.reduce(
    (count, group) =>
      count + group.workers.filter(({ workspace }) => isSubAgentActive(workspace)).length,
    0
  );
  const label =
    workflowGroups.length === 1
      ? `Workflow${workflowGroups[0].workflowName != null ? ` ${workflowGroups[0].workflowName}` : ""}`
      : `${workflowGroups.length} workflows`;
  // Workers vanish once they report, so a lingering all-inactive group (e.g. an
  // interrupted run) must not read as running.
  // A worker-less group is a retained active run between sequential steps.
  const workers =
    activeWorkerCount > 0
      ? `${activeWorkerCount} active`
      : workerCount > 0
        ? `${workerCount} agent${workerCount === 1 ? "" : "s"}`
        : "running";
  return `${label} · ${workers}`;
}

/**
 * Fold one bulk verification response into the failure-streak state and return the
 * run ids whose groups must drop. `entries` is the workflows.getRunStatuses result
 * (refs whose read failed are omitted); null means the whole call failed. A settled
 * or missing durable record dies immediately; an unreachable one dies only after
 * maxFailures CONSECUTIVE failed cycles — a successful read resets its streak.
 */
export function reconcileNestedRunLiveness(input: {
  candidateRunIds: readonly string[];
  entries: readonly WorkflowRunLivenessEntry[] | null;
  failureCounts: Map<string, number>;
  maxFailures: number;
}): string[] {
  const dead: string[] = [];
  const statusByRunId =
    input.entries == null
      ? null
      : new Map<string, WorkflowRunLivenessEntry["status"]>(
          input.entries.map((entry) => [entry.runId, entry.status])
        );
  for (const runId of input.candidateRunIds) {
    if (statusByRunId?.has(runId)) {
      input.failureCounts.delete(runId);
      const status = statusByRunId.get(runId) ?? null;
      if (status == null || !isActiveWorkflowRunStatus(status)) {
        dead.push(runId);
      }
      continue;
    }
    const failures = (input.failureCounts.get(runId) ?? 0) + 1;
    input.failureCounts.set(runId, failures);
    if (failures >= input.maxFailures) {
      dead.push(runId);
    }
  }
  return dead;
}

export function SubAgentTasksDecoration(props: { workspaceId: string }) {
  const { workspaceMetadata } = useWorkspaceMetadata();
  const { navigateToWorkspace } = useRouter();
  const [expanded, setExpanded] = usePersistedState(
    getSubAgentTasksExpandedKey(props.workspaceId),
    false
  );
  const workspaceStore = useWorkspaceStoreRaw();
  const { api } = useAPI();
  const observedWorkflowRunsRef = useRef<Map<string, ObservedWorkflowRunInfo>>(new Map());
  // Nested runs whose durable record was verified settled (or unreachable); their
  // synthesized gap groups must stop rendering. Reset entries when the run reappears.
  const [deadObservedRunIds, setDeadObservedRunIds] = useState<ReadonlySet<string>>(
    () => new Set<string>()
  );
  // Bumped when cold-mount discovery seeds the observed map (a ref mutation the
  // merge below would otherwise not re-render for).
  const [, setObservedSeedVersion] = useState(0);
  const {
    subAgents,
    workflowGroups: liveWorkflowGroups,
    descendantWorkspaceIds,
  } = collectDescendantAgents(workspaceMetadata.values(), props.workspaceId);
  // Union of active workflow run ids across this workspace AND its descendants: a run
  // owned by a descendant sub-agent appears only in that descendant's workspace-scoped
  // activity (never the root's), so reconciling against the root alone would drop a
  // descendant-owned run during its between-workers gap. Activity snapshots publish via
  // states.bump, so subscribe to the states store (subscribeDerived would miss workflow
  // start/completion events that change no derived data). Snapshot is a joined string
  // so useSyncExternalStore's Object.is comparison stays stable across recomputes.
  const activeRunIdsKey = useSyncExternalStore(workspaceStore.subscribe, () => {
    const ids: string[] = [];
    const seen = new Set<string>();
    for (const ownerId of [props.workspaceId, ...descendantWorkspaceIds]) {
      let ownerRunIds: readonly string[];
      try {
        ownerRunIds = workspaceStore.getWorkspaceSidebarState(ownerId).activeWorkflowRunIds ?? [];
      } catch {
        continue;
      }
      for (const runId of ownerRunIds) {
        if (!seen.has(runId)) {
          seen.add(runId);
          ids.push(runId);
        }
      }
    }
    return ids.join("\u0000");
  });
  const workflowGroups = mergeActiveWorkflowGroups(
    liveWorkflowGroups,
    activeRunIdsKey.length > 0 ? activeRunIdsKey.split("\u0000") : [],
    observedWorkflowRunsRef.current,
    (runId) => deadObservedRunIds.has(runId)
  );
  // A dead-marked nested run that reacquired live workers (checkpoint retry) is alive
  // again; clear its verdict. "Adjust state during render" pattern with a no-op guard.
  const liveRunIds = new Set(liveWorkflowGroups.map((group) => group.runId));
  if ([...deadObservedRunIds].some((runId) => liveRunIds.has(runId))) {
    setDeadObservedRunIds((previous) => {
      const next = new Set(previous);
      let changed = false;
      for (const runId of liveRunIds) {
        changed = next.delete(runId) || changed;
      }
      return changed ? next : previous;
    });
  }
  // Cold-mount discovery: nested (parentWorkflow) runs never appear in workspace
  // activity, so a tray mounting during such a run's between-workers gap would
  // hide it until its next worker spawns. One bulk read per owner-set change
  // seeds the observed map. Top-level summaries are seeded too: normally the
  // activity path covers them instantly (the merge flips them to
  // activity-covered with no duplicate group), but when the activity bootstrap
  // is unavailable (list() returning null replays no current state), the seed
  // is the only way a cold tray learns about an already-active run. The
  // liveness poll below keeps every seeded group honest either way.
  const ownerIdsKey = [props.workspaceId, ...descendantWorkspaceIds].join("\u0000");
  useEffect(() => {
    if (api == null) {
      return;
    }
    let cancelled = false;
    let retryTimer: ReturnType<typeof setTimeout> | undefined;
    let attempt = 0;
    const discover = () => {
      api.workflows
        .listActiveRuns({ workspaceIds: ownerIdsKey.split("\u0000") })
        .then((summaries) => {
          if (cancelled) {
            return;
          }
          let seeded = false;
          for (const summary of summaries) {
            if (observedWorkflowRunsRef.current.has(summary.runId)) {
              continue;
            }
            observedWorkflowRunsRef.current.set(summary.runId, {
              workflowName: summary.workflowName ?? undefined,
              ownerWorkspaceId: summary.workspaceId,
              activityCovered: false,
            });
            seeded = true;
          }
          if (seeded) {
            setObservedSeedVersion((version) => version + 1);
          }
        })
        .catch(() => {
          if (cancelled) {
            return;
          }
          // A transient store failure must not end discovery for the rest of a
          // nested run's worker gap (this effect otherwise re-runs only when
          // the owner set changes): retry with capped backoff while mounted.
          attempt += 1;
          retryTimer = setTimeout(
            discover,
            Math.min(RUN_DISCOVERY_RETRY_MAX_MS, RUN_DISCOVERY_RETRY_BASE_MS * 2 ** attempt)
          );
        });
    };
    discover();
    return () => {
      cancelled = true;
      if (retryTimer != null) {
        clearTimeout(retryTimer);
      }
    };
  }, [api, ownerIdsKey]);
  // Observed gap groups carry no activity signal (nested runs never do;
  // discovery-seeded top-level runs don't until activity reports them), so
  // verify their durable run records (same source useWorkflowRunById polls)
  // while any are on screen — one bulk IPC call per cycle. Settled, missing, or
  // repeatedly unreachable runs are marked dead so their groups drop out.
  const nestedGapKey = workflowGroups
    .flatMap((group) => {
      const owner = group.ownerWorkspaceId;
      if (
        group.workers.length > 0 ||
        owner == null ||
        observedWorkflowRunsRef.current.get(group.runId)?.activityCovered !== false
      ) {
        return [];
      }
      return [`${group.runId}\u0000${owner}`];
    })
    .join("\u0001");
  useEffect(() => {
    if (api == null || nestedGapKey.length === 0) {
      return;
    }
    const candidates = nestedGapKey.split("\u0001").map((pair) => {
      const [runId, ownerWorkspaceId] = pair.split("\u0000");
      return { runId, ownerWorkspaceId };
    });
    let cancelled = false;
    // Serialize cycles: a lookup slower than the interval must not stack overlapping
    // requests — skip ticks until the in-flight one settles.
    let inFlight = false;
    const failureCounts = new Map<string, number>();
    const candidateRunIds = candidates.map((candidate) => candidate.runId);
    const markDead = (runIds: readonly string[]) => {
      if (runIds.length === 0) {
        return;
      }
      setDeadObservedRunIds((previous) => {
        if (runIds.every((runId) => previous.has(runId))) {
          return previous;
        }
        return new Set([...previous, ...runIds]);
      });
    };
    const reconcile = (entries: readonly WorkflowRunLivenessEntry[] | null) => {
      if (!cancelled) {
        markDead(
          reconcileNestedRunLiveness({
            candidateRunIds,
            entries,
            failureCounts,
            maxFailures: NESTED_RUN_VERIFY_MAX_FAILURES,
          })
        );
      }
    };
    const verify = () => {
      if (inFlight) {
        return;
      }
      inFlight = true;
      api.workflows
        .getRunStatuses({
          runs: candidates.map((candidate) => ({
            workspaceId: candidate.ownerWorkspaceId,
            runId: candidate.runId,
          })),
        })
        .then(reconcile)
        // Transient IPC errors keep the group; a repeatedly unreachable record
        // (e.g. the owning workspace was deleted) must not pin it forever.
        .catch(() => reconcile(null))
        .finally(() => {
          inFlight = false;
        });
    };
    verify();
    const interval = setInterval(verify, NESTED_RUN_VERIFY_INTERVAL_MS);
    return () => {
      cancelled = true;
      clearInterval(interval);
    };
  }, [api, nestedGapKey]);

  if (subAgents.length === 0 && workflowGroups.length === 0) {
    return null;
  }

  const activeCount = subAgents.filter(({ workspace }) => isSubAgentActive(workspace)).length;
  const SummaryIcon = subAgents.length === 0 ? Workflow : Bot;

  return (
    <ChatInputDecoration
      expanded={expanded}
      onToggle={() => setExpanded(!expanded)}
      dataComponent="SubAgentTasksDecoration"
      contentClassName="max-h-52 space-y-1 overflow-y-auto py-2"
      summary={
        <>
          <SummaryIcon className="text-muted group-hover:text-secondary size-3.5 shrink-0 transition-colors" />
          <span className="text-muted group-hover:text-secondary min-w-0 truncate transition-colors">
            {subAgents.length > 0 && (
              <>
                <span className="font-medium">{subAgents.length}</span> sub-agent
                {subAgents.length === 1 ? "" : "s"}
                {activeCount > 0 ? ` · ${activeCount} active` : " · inactive"}
              </>
            )}
            {subAgents.length > 0 && workflowGroups.length > 0 && " · "}
            {workflowGroups.length > 0 && formatWorkflowSummary(workflowGroups)}
          </span>
        </>
      }
      renderExpanded={() => (
        <>
          {subAgents.map(({ workspace, depth }) => (
            <AgentRow
              key={workspace.id}
              workspace={workspace}
              indentLevel={depth - 1}
              onNavigate={navigateToWorkspace}
            />
          ))}
          {workflowGroups.map((group) => (
            <div key={group.runId} className="space-y-1">
              <div className="text-muted flex min-w-0 items-center gap-2 px-2 pt-1.5 pb-0.5 text-[10px]">
                <Workflow className="size-3.5 shrink-0" />
                <span className="min-w-0 truncate font-medium">
                  Workflow · {group.workflowName ?? shortenWorkflowRunId(group.runId)}
                </span>
              </div>
              {group.workers.map(({ workspace, depth }) => (
                <AgentRow
                  key={workspace.id}
                  workspace={workspace}
                  // Nest workers one level under their run header; nested runs keep
                  // their relative depth without inheriting the outer tree's offset.
                  indentLevel={Math.max(0, depth - group.workers[0].depth) + 1}
                  onNavigate={navigateToWorkspace}
                />
              ))}
            </div>
          ))}
        </>
      )}
    />
  );
}

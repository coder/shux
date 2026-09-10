import React, { useContext, useEffect, useRef, useState, useSyncExternalStore } from "react";

import { APIContext, type APIClient } from "@/browser/contexts/API";
import { useExperimentValue } from "@/browser/contexts/ExperimentsContext";
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
  DialogTrigger,
} from "@/browser/components/Dialog/Dialog";
import { TooltipIfPresent } from "@/browser/components/Tooltip/Tooltip";
import {
  useOptionalCommandRegistry,
  type CommandAction,
} from "@/browser/contexts/CommandRegistryContext";
import { EXPERIMENT_IDS } from "@/common/constants/experiments";
import { STRUCTURED_WORKFLOW_REPORT_PLACEHOLDER_MARKDOWN } from "@/common/constants/workflowReports";
import { WorkflowTimeline } from "@/browser/features/RightSidebar/Workflows/WorkflowTimeline";
import {
  getActiveWorkflowPhase,
  projectWorkflowRun,
} from "@/browser/features/RightSidebar/Workflows/projectWorkflowRun";
import {
  formatWorkflowCost,
  formatWorkflowDuration,
  formatWorkflowTokens,
} from "@/browser/features/RightSidebar/Workflows/workflowDisplay";
import { useWorkflowRunLiveSnapshot } from "@/browser/features/RightSidebar/Workflows/useWorkflowRuns";
import { useWorkflowRunById } from "@/browser/hooks/useWorkflowRunById";
import {
  isActiveWorkflowChildEventStatus,
  isActiveWorkflowRunStatus,
  type WorkflowRunEvent,
  type WorkflowRunRecord,
  type WorkflowStepRecord,
} from "@/common/types/workflow";
import type {
  WorkflowResumeToolArgs,
  WorkflowResumeToolResult,
  WorkflowRunToolArgs,
  WorkflowRunToolResult,
  WorkflowRunToolSuccessResult,
} from "@/common/types/tools";
import assert from "@/common/utils/assert";
import { canRetryWorkflowFromCheckpoint } from "@/common/utils/workflowRetryEligibility";

import {
  ToolContainer,
  ToolHeader,
  ExpandIcon,
  ToolName,
  StatusIndicator,
  ToolDetails,
  ToolIcon,
  ErrorBox,
} from "./Shared/ToolPrimitives";
import {
  getStatusDisplay,
  isToolErrorResult,
  type ToolStatus,
  useAutoCollapsingToolExpansion,
} from "./Shared/toolUtils";
import { HighlightedCode } from "./Shared/HighlightedCode";
import {
  WorkflowScriptCard,
  WorkflowJsonBlock,
  WorkflowKindBadge,
  WorkflowSection,
  WORKFLOW_ACTION_BUTTON_CLASS,
} from "./WorkflowToolShared";
import {
  useWorkflowToolLiveRun,
  useWorkspaceStoreRaw,
  type WorkflowToolLiveRunState,
} from "@/browser/stores/WorkspaceStore";
import { workflowScriptMatchesPath } from "@/browser/utils/workflowRunScriptPaths";
import {
  isKernelBoundedMarker,
  type KernelBoundedMarker,
} from "@/common/utils/tools/kernelBoundedMarker";
import { MarkdownRenderer } from "../Messages/MarkdownRenderer";

type WorkflowRunToolLaunchArgs =
  | WorkflowRunToolArgs
  | (Omit<WorkflowRunToolArgs, "script_path"> & { script_path?: string; name: string });

/**
 * Kernel-nested calls can arrive with their launch args replaced by a
 * __kernelBounded marker; capture retains script_path when it fits (see
 * retainPersistenceCriticalArgsFields). Run identity then comes from the
 * workflow-run-attached hint or the result's retained runId.
 */
type KernelBoundedWorkflowRunArgs = KernelBoundedMarker & { script_path?: string | null };

type WorkflowRunToolDisplayArgs = WorkflowRunToolLaunchArgs | KernelBoundedWorkflowRunArgs;

function getWorkflowRunLaunchArgs(
  args: WorkflowRunToolDisplayArgs
): WorkflowRunToolLaunchArgs | null {
  return isKernelBoundedMarker(args) ? null : args;
}

interface WorkflowRunToolCallProps {
  args: WorkflowRunToolDisplayArgs;
  result?: WorkflowRunToolResult;
  status?: ToolStatus;
  workspaceId?: string;
  toolCallId?: string;
  startedAt?: number;
  /** When the model emitted the call; freshness fallback when startedAt is unknown. */
  toolCallTimestamp?: number;
  /** Which tool rendered this card; controls the header icon. */
  toolName?: "workflow_run" | "workflow_resume";
  /**
   * Exact run identity known from the tool args (workflow_resume passes its run_id). Enables
   * direct getRun discovery while executing instead of name+args matching against listRuns.
   */
  knownRunId?: string;
  workflowRunHint?: WorkflowToolLiveRunState | null;
}

type WorkflowRunControlAction = "interrupt" | "resume" | "retryFromCheckpoint";

function shouldKeepWorkflowControlPolling(input: {
  action: WorkflowRunControlAction;
  run: WorkflowRunRecord;
  baselineSequence: number;
}): boolean {
  if (input.run.status === "interrupted") {
    return true;
  }
  if (input.action !== "retryFromCheckpoint" || input.run.status !== "failed") {
    return false;
  }
  return getLatestWorkflowEventSequence(input.run) <= input.baselineSequence;
}

async function updateWorkflowRunFromAction(input: {
  api: APIClient;
  workspaceId: string;
  runId: string;
  action: WorkflowRunControlAction;
  setActionError: React.Dispatch<React.SetStateAction<string | null>>;
  setRefreshedRun: React.Dispatch<React.SetStateAction<WorkflowRunRecord | null>>;
  setResumingRunId: React.Dispatch<React.SetStateAction<string | null>>;
  baselineSequence: number;
}) {
  input.setActionError(null);
  let resumeRequestAccepted = false;
  try {
    const nextRun =
      input.action === "interrupt"
        ? await input.api.workflows.interrupt({
            workspaceId: input.workspaceId,
            runId: input.runId,
          })
        : input.action === "resume"
          ? await input.api.workflows.resume({
              workspaceId: input.workspaceId,
              runId: input.runId,
            })
          : await input.api.workflows.retryFromCheckpoint({
              workspaceId: input.workspaceId,
              runId: input.runId,
            });
    if (input.action === "resume" || input.action === "retryFromCheckpoint") {
      resumeRequestAccepted = true;
      input.setResumingRunId(input.runId);
    }
    if ("id" in nextRun) {
      input.setRefreshedRun((current) => getNewestWorkflowRunSnapshot(current, nextRun));
      if (
        !shouldKeepWorkflowControlPolling({
          action: input.action,
          run: nextRun,
          baselineSequence: input.baselineSequence,
        })
      ) {
        input.setResumingRunId(null);
      }
      return;
    }
    const refreshed = await input.api.workflows.getRun({
      workspaceId: input.workspaceId,
      runId: input.runId,
    });
    if (refreshed != null) {
      input.setRefreshedRun((current) => getNewestWorkflowRunSnapshot(current, refreshed));
      if (
        !shouldKeepWorkflowControlPolling({
          action: input.action,
          run: refreshed,
          baselineSequence: input.baselineSequence,
        })
      ) {
        input.setResumingRunId(null);
      }
    }
  } catch (error) {
    if (
      (input.action === "resume" || input.action === "retryFromCheckpoint") &&
      !resumeRequestAccepted
    ) {
      input.setResumingRunId(null);
    }
    input.setActionError(
      error instanceof Error ? error.message : `Failed to ${input.action} workflow`
    );
    // A failed action usually means this card's snapshot is stale (e.g. Resume on a run an
    // agent already resumed via workflow_resume -> "already active"). Re-sync best-effort so
    // the card converges to the live status instead of keeping dead-end affordances.
    try {
      const refreshed = await input.api.workflows.getRun({
        workspaceId: input.workspaceId,
        runId: input.runId,
      });
      if (refreshed != null) {
        input.setRefreshedRun((current) => getNewestWorkflowRunSnapshot(current, refreshed));
      }
    } catch {
      // Keep the action error visible even when the refresh itself fails.
    }
  }
}

function isWorkflowRunSuccessResult(
  value: WorkflowRunToolResult | undefined
): value is WorkflowRunToolSuccessResult {
  return value != null && !isToolErrorResult(value) && !isKernelBoundedMarker(value);
}

/** RunId/status retained on a kernel-bounded result marker (see retainWorkflowResultIdentityFields). */
function getKernelBoundedResultIdentity(
  result: unknown
): { runId: string; status?: string } | null {
  if (!isKernelBoundedMarker(result)) {
    return null;
  }
  const { runId, status } = result as { runId?: unknown; status?: unknown };
  if (typeof runId !== "string" || runId.length === 0) {
    return null;
  }
  return { runId, ...(typeof status === "string" ? { status } : {}) };
}

// Schema-shaped workflow agent reports carry structuredOutput only; their placeholder
// markdown exists for backend compatibility and should not create noisy Report buttons.
function hasDisplayableReportMarkdown(
  reportMarkdown: string,
  result: { structuredOutput?: unknown } | null | undefined
): boolean {
  const trimmedReportMarkdown = reportMarkdown.trim();
  if (trimmedReportMarkdown.length === 0) {
    return false;
  }
  return !(
    trimmedReportMarkdown === STRUCTURED_WORKFLOW_REPORT_PLACEHOLDER_MARKDOWN &&
    result?.structuredOutput !== undefined
  );
}

function getReportMarkdown(value: unknown): string | null {
  if (value != null && typeof value === "object") {
    const result = value as Record<string, unknown>;
    const reportMarkdown = result.reportMarkdown;
    if (
      typeof reportMarkdown === "string" &&
      hasDisplayableReportMarkdown(reportMarkdown, result)
    ) {
      return reportMarkdown;
    }
  }
  return null;
}

function getStructuredOutput(value: unknown): unknown {
  if (value != null && typeof value === "object") {
    return (value as Record<string, unknown>).structuredOutput;
  }
  return undefined;
}

type WorkflowTaskEvent = Extract<WorkflowRunEvent, { type: "task" }>;
type WorkflowChildEvent = Extract<WorkflowRunEvent, { type: "workflow" }>;
type WorkflowPatchEvent = Extract<WorkflowRunEvent, { type: "patch" }>;

type WorkflowDisplayRow =
  | { kind: "event"; event: WorkflowRunEvent }
  | { kind: "task"; firstEvent: WorkflowTaskEvent; latestEvent: WorkflowTaskEvent }
  | { kind: "workflow"; firstEvent: WorkflowChildEvent; latestEvent: WorkflowChildEvent }
  | { kind: "patch"; firstEvent: WorkflowPatchEvent; latestEvent: WorkflowPatchEvent };

type WorkflowTaskRow = Extract<WorkflowDisplayRow, { kind: "task" }>;
type WorkflowChildDisplayRow = Extract<WorkflowDisplayRow, { kind: "workflow" }>;
type WorkflowPatchRow = Extract<WorkflowDisplayRow, { kind: "patch" }>;

const MAX_TOOL_INLINE_NESTED_WORKFLOW_DEPTH = 3;

function getWorkflowChildProgressSummary(run: WorkflowRunRecord | null): string | null {
  if (run == null) {
    return null;
  }
  const view = projectWorkflowRun(run);
  const activePhase = getActiveWorkflowPhase(view.phases);
  const phaseLabel =
    activePhase != null && activePhase.label.length > 0 ? ` · ${activePhase.label}` : "";
  return `${view.status} · ${view.stats.done}/${view.stats.total} steps${phaseLabel}`;
}

/**
 * "phase 2/5 · Verify" position label, present only when the run DECLARES
 * meta.phases and the active phase is one of the declared names. Inferred
 * manifests never produce a fraction (source order is not runtime order).
 */
function getDeclaredPhasePositionLabel(
  run: WorkflowRunRecord,
  activePhase: { name: string; label: string } | null
): string | null {
  const manifest = run.workflow.phaseManifest;
  if (manifest?.provenance !== "declared" || activePhase == null) {
    return null;
  }
  const index = manifest.phases.findIndex((phase) => phase.name === activePhase.name);
  if (index < 0) {
    return null;
  }
  const label = activePhase.label.length > 0 ? ` · ${activePhase.label}` : "";
  return `phase ${index + 1}/${manifest.phases.length}${label}`;
}

/**
 * Compact "what is the workflow doing right now" line for the card header: steps
 * done/observed plus the running step title (or active phase when several steps
 * run). Manually collapsed active cards keep this summary visible so progress remains
 * scannable without reopening the full timeline.
 * Totals are observed-so-far, not planned (see WorkflowPhaseView.total).
 */
export function getWorkflowHeaderProgressSummary(
  run: WorkflowRunRecord | null | undefined
): string | null {
  if (run == null) {
    return null;
  }
  const view = projectWorkflowRun(run);
  const parts: string[] = [];
  if (view.stats.total > 0) {
    parts.push(`${view.stats.done}/${view.stats.total} steps`);
  }
  const runningSteps = view.steps.filter((step) => step.status === "running");
  const activePhase = getActiveWorkflowPhase(view.phases);
  // Declared manifests upgrade the phase label to "phase 2/5 · Verify".
  const declaredPosition = getDeclaredPhasePositionLabel(run, activePhase);
  if (runningSteps.length === 1) {
    parts.push(runningSteps[0].title);
    if (declaredPosition != null) {
      parts.push(declaredPosition);
    }
  } else if (declaredPosition != null) {
    parts.push(
      runningSteps.length > 1
        ? `${declaredPosition} · ${runningSteps.length} running`
        : declaredPosition
    );
  } else if (activePhase != null && activePhase.label.length > 0) {
    parts.push(
      runningSteps.length > 1
        ? `${activePhase.label} · ${runningSteps.length} running`
        : activePhase.label
    );
  } else if (runningSteps.length > 1) {
    parts.push(`${runningSteps.length} running`);
  }
  return parts.length > 0 ? parts.join(" · ") : null;
}

function getTaskEventKey(event: WorkflowTaskEvent): string {
  return `task:${event.stepId}:${event.taskId}`;
}

function getWorkflowChildEventKey(event: WorkflowChildEvent): string {
  return `workflow:${event.stepId}:${event.runId}`;
}

function getPatchEventKey(event: WorkflowPatchEvent): string {
  return `patch:${event.stepId}:${event.sourceTaskId}`;
}
function getWorkflowDisplayRows(events: readonly WorkflowRunEvent[]): WorkflowDisplayRow[] {
  const rows: WorkflowDisplayRow[] = [];
  const taskRows = new Map<string, WorkflowTaskRow>();
  const workflowRows = new Map<string, WorkflowChildDisplayRow>();
  const patchRows = new Map<string, WorkflowPatchRow>();

  for (const event of events) {
    if (event.type === "status" || event.type === "result") {
      continue;
    }
    if (event.type === "task") {
      const key = getTaskEventKey(event);
      const existingRow = taskRows.get(key);
      if (existingRow != null) {
        existingRow.latestEvent = event;
        continue;
      }

      const row: WorkflowTaskRow = {
        kind: "task",
        firstEvent: event,
        latestEvent: event,
      };
      taskRows.set(key, row);
      rows.push(row);
      continue;
    }

    if (event.type === "workflow") {
      const key = getWorkflowChildEventKey(event);
      const existingRow = workflowRows.get(key);
      if (existingRow != null) {
        existingRow.latestEvent = event;
        continue;
      }

      const row: WorkflowChildDisplayRow = {
        kind: "workflow",
        firstEvent: event,
        latestEvent: event,
      };
      workflowRows.set(key, row);
      rows.push(row);
      continue;
    }

    if (event.type === "patch") {
      // A patch step emits started → applied/conflict/failed for the same
      // stepId+sourceTaskId; collapse them into one row (latest status wins),
      // mirroring task-row coalescing.
      const key = getPatchEventKey(event);
      const existingRow = patchRows.get(key);
      if (existingRow != null) {
        existingRow.latestEvent = event;
        continue;
      }

      const row: WorkflowPatchRow = {
        kind: "patch",
        firstEvent: event,
        latestEvent: event,
      };
      patchRows.set(key, row);
      rows.push(row);
      continue;
    }

    rows.push({ kind: "event", event });
  }
  return rows;
}

function getDisplayRowKey(row: WorkflowDisplayRow): string {
  if (row.kind === "task") {
    return getTaskEventKey(row.firstEvent);
  }
  if (row.kind === "workflow") {
    return getWorkflowChildEventKey(row.firstEvent);
  }
  if (row.kind === "patch") {
    return getPatchEventKey(row.firstEvent);
  }
  return getEventKey(row.event);
}
function getEventKey(event: WorkflowRunEvent): string {
  return `${event.sequence}:${event.type}`;
}

function getWorkflowEventLabel(event: WorkflowRunEvent): string {
  switch (event.type) {
    case "phase":
      return event.name;
    case "log":
      return event.message;
    case "agent-step":
      return `${event.title ?? event.stepId} / ${event.status}`;
    case "task":
      // Prefer the human-readable sub-agent title (matches the spawned
      // workspace title); fall back to stepId for legacy events without one.
      return `${event.title ?? event.stepId} / ${event.taskId} / ${event.status}`;
    case "timeout":
      switch (event.phase) {
        case "soft":
          return `${event.stepId} / ${event.taskId} / Soft timeout reached; requesting final report`;
        case "finalization_prompt_sent":
          return `${event.stepId} / ${event.taskId} / Final report requested`;
        case "recovered":
          return `${event.stepId} / ${event.taskId} / Recovered during grace period`;
        case "hard":
          return `${event.stepId} / ${event.taskId} / Hard timeout; child terminated`;
      }
      return `${event.stepId} / ${event.taskId} / timeout`;
    case "workflow":
      return `${event.stepId} / ${event.name} / ${event.runId} / ${event.status}`;
    case "patch":
      return `${event.stepId} / ${event.sourceTaskId} / ${event.status}`;
    case "action":
      return `${event.stepId} / ${event.name} / ${event.status}`;
    case "validation": {
      const verdict = event.success ? "passed" : "failed";
      return event.message
        ? `${event.stepId} validation ${verdict}: ${event.message}`
        : `${event.stepId} validation ${verdict}`;
    }
    case "error":
      return event.message;
    case "status":
      return event.status;
    case "result":
      return "Result recorded";
  }
}

function getWorkflowEventDetail(event: WorkflowRunEvent): unknown {
  switch (event.type) {
    // Every event type carrying an opaque `details` payload surfaces it as-is;
    // group them so a new details-bearing event can't drift from the others.
    case "phase":
    case "workflow":
    case "patch":
    case "agent-step":
    case "timeout":
    case "action":
      return event.details;
    case "log":
      return event.data;
    case "result":
      return event.result;
    case "task":
    case "validation":
    case "error":
    case "status":
      return undefined;
  }
}

function getEventTone(event: WorkflowRunEvent): "normal" | "success" | "warning" {
  if (event.type === "error") {
    return "warning";
  }
  if (event.type === "validation") {
    return event.success ? "success" : "warning";
  }
  if (event.type === "patch") {
    return event.status === "applied"
      ? "success"
      : event.status === "started"
        ? "normal"
        : "warning";
  }
  if (event.type === "agent-step") {
    return event.status === "failed" ? "warning" : "normal";
  }
  if (event.type === "action") {
    if (
      event.status === "completed" ||
      event.status === "cached" ||
      event.status === "reconciled"
    ) {
      return "success";
    }
    return event.status === "failed" ? "warning" : "normal";
  }
  if (event.type === "timeout") {
    return event.phase === "recovered" ? "success" : "warning";
  }
  if (event.type === "workflow") {
    return event.status === "completed"
      ? "success"
      : event.status === "failed" || event.status === "interrupted"
        ? "warning"
        : "normal";
  }
  if (event.type === "result") {
    return "success";
  }
  return "normal";
}

function getEventToneClass(event: WorkflowRunEvent): string {
  switch (getEventTone(event)) {
    case "success":
      return "text-success";
    case "warning":
      return "text-warning";
    case "normal":
      return "text-muted";
  }
}

function WorkflowDisclosureSection(props: {
  title: string;
  children: React.ReactNode;
  className?: string;
  unmountCollapsed?: boolean;
  onOpen?: () => void;
}) {
  const [open, setOpen] = useState(false);
  if (props.unmountCollapsed) {
    return (
      <div className={`group mb-2 ${props.className ?? ""}`}>
        <button
          type="button"
          aria-expanded={open}
          className="text-muted hover:text-foreground flex cursor-pointer list-none items-center gap-2 text-[10px] tracking-wide uppercase"
          onClick={() => {
            const nextOpen = !open;
            setOpen(nextOpen);
            if (nextOpen) {
              props.onOpen?.();
            }
          }}
        >
          <span className={open ? "rotate-90 transition-transform" : "transition-transform"}>
            ▶
          </span>
          <span>{props.title}</span>
        </button>
        {open && <div className="mt-1">{props.children}</div>}
      </div>
    );
  }
  return (
    <details className={`group mb-2 ${props.className ?? ""}`}>
      <summary className="text-muted hover:text-foreground flex cursor-pointer list-none items-center gap-2 text-[10px] tracking-wide uppercase [&::-webkit-details-marker]:hidden">
        <span className="transition-transform group-open:rotate-90">▶</span>
        <span>{props.title}</span>
      </summary>
      <div className="mt-1">{props.children}</div>
    </details>
  );
}

function getEventRowClass(event: WorkflowRunEvent): string {
  if (event.type === "phase") {
    return "border-l-2 border-plan-mode/70 bg-plan-mode-alpha";
  }
  return "border-l-2 border-transparent";
}

function getEventTypeClass(event: WorkflowRunEvent): string {
  if (event.type === "phase") {
    return "rounded border border-plan-mode/40 bg-plan-mode-alpha px-1 py-0.5 text-plan-mode-light";
  }
  return getEventToneClass(event);
}

function findTaskStepForEvent(
  event: WorkflowRunEvent,
  steps: readonly WorkflowStepRecord[]
): WorkflowStepRecord | null {
  if (event.type !== "task") {
    return null;
  }

  return steps.find((step) => step.taskId === event.taskId && step.stepId === event.stepId) ?? null;
}

function getTaskReportMarkdown(
  event: WorkflowRunEvent,
  steps: readonly WorkflowStepRecord[]
): string | null {
  const step = findTaskStepForEvent(event, steps);
  const result = step?.result;
  const reportMarkdown = result?.reportMarkdown;
  return typeof reportMarkdown === "string" && hasDisplayableReportMarkdown(reportMarkdown, result)
    ? reportMarkdown
    : null;
}

function getTaskStructuredOutput(
  event: WorkflowRunEvent,
  steps: readonly WorkflowStepRecord[]
): unknown {
  const step = findTaskStepForEvent(event, steps);
  return step?.result?.structuredOutput;
}

function WorkflowEventTooltip(props: {
  event: WorkflowRunEvent;
  displayIndex: number;
  label: string;
}) {
  return (
    <div className="space-y-1">
      <div className="text-muted counter-nums-mono text-[10px]">
        Display #{props.displayIndex} · Raw event #{props.event.sequence}
      </div>
      <div className="text-foreground text-[11px] leading-snug">{props.label}</div>
    </div>
  );
}

function getWorkflowMergedRowDetail(row: WorkflowChildDisplayRow | WorkflowPatchRow): unknown {
  const firstDetail = getWorkflowEventDetail(row.firstEvent);
  const latestDetail = getWorkflowEventDetail(row.latestEvent);
  if (row.firstEvent === row.latestEvent || row.latestEvent.status === "started") {
    return latestDetail;
  }
  if (firstDetail === undefined) {
    return latestDetail;
  }
  if (latestDetail === undefined) {
    return { started: firstDetail };
  }
  return { started: firstDetail, [row.latestEvent.status]: latestDetail };
}

function WorkflowEventRow(props: {
  event: WorkflowRunEvent;
  displayIndex: number;
  steps: readonly WorkflowStepRecord[];
  detailOverride?: unknown;
  tooltipEvent?: WorkflowRunEvent;
}) {
  const event = props.event;
  const tooltipEvent = props.tooltipEvent ?? event;
  const detail =
    props.detailOverride !== undefined ? props.detailOverride : getWorkflowEventDetail(event);
  const taskReportMarkdown = getTaskReportMarkdown(event, props.steps);
  const isExpandable = detail !== undefined || taskReportMarkdown != null;
  const clickableCursorClass = isExpandable ? "cursor-pointer" : "";
  const label = getWorkflowEventLabel(event);
  const row = (
    <div
      className={`grid ${clickableCursorClass} grid-cols-[3rem_4.75rem_minmax(0,1fr)] items-center gap-2 px-2 py-1 text-[10px] ${getEventRowClass(event)}`}
    >
      {/* Keep the tooltip trigger on the sequence cell so expandable row text still advertises clickability. */}
      <TooltipIfPresent
        tooltip={
          <WorkflowEventTooltip
            event={tooltipEvent}
            displayIndex={props.displayIndex}
            label={label}
          />
        }
        side="top"
        align="start"
      >
        <span
          className="text-muted counter-nums-mono w-fit cursor-help"
          aria-label={`Raw event #${tooltipEvent.sequence}`}
        >
          #{props.displayIndex}
        </span>
      </TooltipIfPresent>
      <span
        className={`w-fit ${clickableCursorClass} font-mono uppercase ${getEventTypeClass(event)}`}
      >
        {event.type}
      </span>
      <span className={`text-foreground ${clickableCursorClass} truncate`}>{label}</span>
    </div>
  );

  if (!isExpandable) {
    return <li className="hover:bg-background/50">{row}</li>;
  }

  return (
    <li className="hover:bg-background/50">
      <details className="group">
        <summary className="cursor-pointer list-none [&::-webkit-details-marker]:hidden">
          {row}
        </summary>
        {taskReportMarkdown != null ? (
          <div className="border-border bg-background/40 mx-2 mb-2 rounded border p-2 text-[11px]">
            <MarkdownRenderer content={taskReportMarkdown} />
          </div>
        ) : (
          <WorkflowJsonBlock value={detail} className="mx-2 mb-2 max-h-[140px]" />
        )}
      </details>
    </li>
  );
}

function WorkflowChildEventDetailBlock(props: { detail: unknown }) {
  if (props.detail === undefined) {
    return null;
  }
  return (
    <div className="mt-2 space-y-1">
      <div className="text-muted text-[10px] tracking-wide uppercase">Workflow event details</div>
      <WorkflowJsonBlock value={props.detail} className="max-h-[180px]" />
    </div>
  );
}

function WorkflowChildRunRow(props: {
  row: WorkflowChildDisplayRow;
  displayIndex: number;
  workspaceId?: string;
  depth: number;
  parentRunActive: boolean;
}) {
  const event = props.row.latestEvent;
  const [open, setOpen] = useState(
    () =>
      props.depth < MAX_TOOL_INLINE_NESTED_WORKFLOW_DEPTH &&
      isActiveWorkflowChildEventStatus(event.status)
  );
  const withinDepthLimit = props.depth < MAX_TOOL_INLINE_NESTED_WORKFLOW_DEPTH;
  const fallbackActive = isActiveWorkflowChildEventStatus(event.status);
  const shouldPollChildRun = open || fallbackActive || props.parentRunActive;
  // Fetch collapsed terminal-looking rows while the parent run is active: checkpoint retries reuse
  // the child run id and may not emit another parent started event. Once the parent is terminal,
  // collapsed terminal rows stop polling unless the user expands them.
  const childRunState = useWorkflowRunById({
    workspaceId: props.workspaceId,
    runId: event.runId,
    enabled: props.workspaceId != null && withinDepthLimit && shouldPollChildRun,
    pollAfterTerminal: shouldPollChildRun,
    pollWhileActive: true,
  });
  const childRun = childRunState.run;
  const childView = childRun != null ? projectWorkflowRun(childRun) : null;
  const childStatus = childRun?.status ?? event.status;
  const childActive =
    childRun != null ? isActiveWorkflowRunStatus(childRun.status) : fallbackActive;
  const progressSummary = getWorkflowChildProgressSummary(childRun);
  const fallbackDetail = getWorkflowMergedRowDetail(props.row);
  const label = `${event.stepId} / ${event.name} / ${event.runId} / ${childStatus}`;

  return (
    <li className="hover:bg-background/50">
      <details
        className="group"
        open={open}
        onToggle={(toggleEvent) => setOpen(toggleEvent.currentTarget.open)}
      >
        <summary className="cursor-pointer list-none [&::-webkit-details-marker]:hidden">
          <div className="border-plan-mode/70 bg-plan-mode-alpha grid grid-cols-[3rem_4.75rem_minmax(0,1fr)] items-center gap-2 border-l-2 px-2 py-1 text-[10px]">
            <TooltipIfPresent
              tooltip={
                <WorkflowEventTooltip
                  event={props.row.firstEvent}
                  displayIndex={props.displayIndex}
                  label={label}
                />
              }
              side="top"
              align="start"
            >
              <span
                className="text-muted counter-nums-mono w-fit cursor-help"
                aria-label={`Raw event #${props.row.firstEvent.sequence}`}
              >
                #{props.displayIndex}
              </span>
            </TooltipIfPresent>
            <span className={`w-fit font-mono uppercase ${getEventTypeClass(event)}`}>
              workflow
            </span>
            <span className="text-foreground flex min-w-0 items-center gap-1.5 truncate">
              {childActive && <span className="bg-plan-mode h-1.5 w-1.5 shrink-0 rounded-full" />}
              <span className="min-w-0 truncate">{label}</span>
            </span>
          </div>
        </summary>
        <div className="border-border bg-background/40 mx-2 mb-2 rounded border p-2">
          <div className="flex min-w-0 flex-wrap items-center gap-2 text-[10px]">
            <span className="text-plan-mode font-medium">Nested workflow</span>
            <span className="text-foreground font-medium">{event.name}</span>
            <span className="text-muted counter-nums-mono min-w-0 truncate">{event.runId}</span>
          </div>
          {progressSummary != null && (
            <div className="text-muted mt-1 text-[11px]">{progressSummary}</div>
          )}
          {!withinDepthLimit ? (
            <div className="text-muted mt-2 text-[11px]">
              Nested workflow depth limit reached; showing summary only.
            </div>
          ) : childRunState.error != null ? (
            <>
              <ErrorBox className="mt-2">{childRunState.error}</ErrorBox>
              <WorkflowChildEventDetailBlock detail={fallbackDetail} />
            </>
          ) : childRunState.loading && childRun == null ? (
            <div className="text-muted mt-2 text-[11px]">Loading nested workflow…</div>
          ) : childRun != null && childView != null ? (
            <div className="border-border/70 mt-2 border-l pl-3">
              <WorkflowTimeline
                view={childView}
                workspaceId={childRun.workspaceId}
                nestedDepth={props.depth + 1}
              />
            </div>
          ) : (
            <>
              <div className="text-muted mt-2 text-[11px]">
                Nested workflow run is not available.
              </div>
              <WorkflowChildEventDetailBlock detail={fallbackDetail} />
            </>
          )}
        </div>
      </details>
    </li>
  );
}

function WorkflowTaskReportDialogContent(props: {
  taskId: string;
  title: string;
  reportMarkdown: string;
}) {
  assert(
    props.reportMarkdown.trim().length > 0,
    "WorkflowTaskReportDialogContent requires non-empty report markdown"
  );

  return (
    <DialogContent className="flex max-h-[80vh] min-h-0 max-w-5xl flex-col overflow-hidden">
      <DialogHeader>
        <DialogTitle className="flex flex-col gap-1">
          <span>Task report</span>
          <span className="text-muted flex flex-wrap items-baseline gap-2 text-[11px] font-normal">
            <span>{props.title}</span>
            <code className="rounded bg-[var(--color-bg-tertiary)] px-1.5 py-0.5 font-mono text-[10px] leading-none">
              {props.taskId}
            </code>
          </span>
        </DialogTitle>
      </DialogHeader>

      <div className="min-h-0 flex-1 overflow-y-auto rounded bg-[var(--color-bg-secondary)] p-3">
        <MarkdownRenderer content={props.reportMarkdown} />
      </div>
    </DialogContent>
  );
}

function shouldShowWorkflowTaskOpenAffordance(
  event: WorkflowRunEvent
): event is Extract<WorkflowRunEvent, { type: "task" }> {
  return event.type === "task" && event.status === "started";
}

// Workflow history can outlive child task workspaces, so only render navigation
// affordances when the live workspace registry still contains the task id.
function useWorkflowTaskWorkspaceAvailable(taskId: string): boolean {
  const workspaceStore = useWorkspaceStoreRaw();
  return useSyncExternalStore(
    workspaceStore.subscribeDerived,
    () => workspaceStore.getWorkspaceMetadata(taskId) != null,
    () => false
  );
}

function WorkflowTaskRow(props: {
  row: Extract<WorkflowDisplayRow, { kind: "task" }>;
  displayIndex: number;
  steps: readonly WorkflowStepRecord[];
  onNavigate: (taskId: string) => void;
  onOpenReport: () => void;
  onInspectStructuredOutput: () => void;
}) {
  const [reportDialogOpen, setReportDialogOpen] = useState(false);
  const [structuredOutputExpanded, setStructuredOutputExpanded] = useState(false);
  const event = props.row.latestEvent;
  const label = getWorkflowEventLabel(event);
  const taskReportMarkdown = getTaskReportMarkdown(event, props.steps);
  const taskStructuredOutput = getTaskStructuredOutput(event, props.steps);
  const taskWorkspaceAvailable = useWorkflowTaskWorkspaceAvailable(event.taskId);
  // Completed task rows inspect structured output inline; keep workspace navigation as a separate action.
  const canExpandStructuredOutput =
    event.status === "completed" && taskStructuredOutput !== undefined;
  const canNavigateViaRow = !canExpandStructuredOutput && taskWorkspaceAvailable;
  const taskRowInteractive = canExpandStructuredOutput || canNavigateViaRow;
  const showWorkspaceAction = canExpandStructuredOutput && taskWorkspaceAvailable;
  const showOpenAffordance =
    taskReportMarkdown == null && canNavigateViaRow && shouldShowWorkflowTaskOpenAffordance(event);
  const toggleStructuredOutput = () => {
    props.onInspectStructuredOutput();
    setStructuredOutputExpanded((isExpanded) => !isExpanded);
  };
  const activateTaskRow = () => {
    if (canExpandStructuredOutput) {
      toggleStructuredOutput();
      return;
    }
    if (taskWorkspaceAvailable) {
      props.onNavigate(event.taskId);
    }
  };
  const handleReportDialogOpenChange = (isOpen: boolean) => {
    if (isOpen) {
      props.onOpenReport();
    }
    setReportDialogOpen(isOpen);
  };
  const onKeyDown: React.KeyboardEventHandler<HTMLDivElement> = (keyboardEvent) => {
    if (keyboardEvent.key !== "Enter" && keyboardEvent.key !== " ") {
      return;
    }
    keyboardEvent.preventDefault();
    activateTaskRow();
  };
  const taskRowAriaLabel = canExpandStructuredOutput
    ? `${structuredOutputExpanded ? "Collapse" : "Expand"} structured output for workflow task ${event.taskId}`
    : canNavigateViaRow
      ? `Open workflow task ${event.taskId}`
      : undefined;

  const taskRow = (
    <div
      className={`grid items-center gap-2 border-l-2 border-transparent px-2 py-1 text-[10px] ${
        taskRowInteractive ? "cursor-pointer" : ""
      } ${
        showOpenAffordance
          ? "grid-cols-[3rem_4.75rem_minmax(0,1fr)_auto]"
          : "grid-cols-[3rem_4.75rem_minmax(0,1fr)]"
      }`}
      role={taskRowInteractive ? "button" : undefined}
      tabIndex={taskRowInteractive ? 0 : undefined}
      aria-expanded={canExpandStructuredOutput ? structuredOutputExpanded : undefined}
      aria-label={taskRowAriaLabel}
      onClick={taskRowInteractive ? activateTaskRow : undefined}
      onKeyDown={taskRowInteractive ? onKeyDown : undefined}
    >
      <TooltipIfPresent
        tooltip={
          <WorkflowEventTooltip
            event={props.row.firstEvent}
            displayIndex={props.displayIndex}
            label={label}
          />
        }
        side="top"
        align="start"
      >
        <span
          className="text-muted counter-nums-mono w-fit cursor-help"
          aria-label={`Raw event #${props.row.firstEvent.sequence}`}
        >
          #{props.displayIndex}
        </span>
      </TooltipIfPresent>
      <span className={`w-fit font-mono uppercase ${getEventTypeClass(event)}`}>{event.type}</span>
      <span className="text-foreground truncate">{label}</span>
      {/* Keep Open visual-only so the task row remains the single keyboard target. */}
      {showOpenAffordance ? (
        <span
          className={`${WORKFLOW_ACTION_BUTTON_CLASS} pointer-events-none inline-flex items-center px-1.5 py-0.5 text-[10px] whitespace-nowrap`}
          aria-hidden="true"
        >
          Open
        </span>
      ) : null}
    </div>
  );

  const workspaceAction = showWorkspaceAction ? (
    <button
      type="button"
      className={`${WORKFLOW_ACTION_BUTTON_CLASS} inline-flex items-center px-1.5 py-0.5 text-[10px] whitespace-nowrap`}
      aria-label={`Open task workspace for ${event.taskId}`}
      onClick={() => props.onNavigate(event.taskId)}
    >
      Workspace
    </button>
  ) : null;

  return (
    <li className="hover:bg-background/50">
      {taskReportMarkdown != null ? (
        <Dialog open={reportDialogOpen} onOpenChange={handleReportDialogOpenChange}>
          <div
            className={`grid ${
              showWorkspaceAction
                ? "grid-cols-[minmax(0,1fr)_auto_auto]"
                : "grid-cols-[minmax(0,1fr)_auto]"
            } items-center gap-1 pr-2`}
          >
            {taskRow}
            {workspaceAction}
            <DialogTrigger asChild>
              <button
                type="button"
                className={`${WORKFLOW_ACTION_BUTTON_CLASS} inline-flex items-center px-1.5 py-0.5 text-[10px] whitespace-nowrap`}
                aria-label={`Open report for ${event.taskId}`}
              >
                Report
              </button>
            </DialogTrigger>
          </div>
          <WorkflowTaskReportDialogContent
            taskId={event.taskId}
            title={label}
            reportMarkdown={taskReportMarkdown}
          />
        </Dialog>
      ) : showWorkspaceAction ? (
        <div className="grid grid-cols-[minmax(0,1fr)_auto] items-center gap-1 pr-2">
          {taskRow}
          {workspaceAction}
        </div>
      ) : (
        taskRow
      )}
      {canExpandStructuredOutput && structuredOutputExpanded ? (
        <div className="mx-2 mb-2 space-y-1">
          <div className="text-muted text-[10px] tracking-wide uppercase">Structured output</div>
          {/* The inline JSON is height-capped, so name/focus its own scroll region for keyboard users. */}
          <WorkflowJsonBlock
            value={taskStructuredOutput}
            className="max-h-[180px]"
            ariaLabel={`Structured output for workflow task ${event.taskId}`}
          />
        </div>
      ) : null}
    </li>
  );
}

const REFRESHING_WORKFLOW_STATUSES = new Set(["pending", "running", "backgrounded"]);

const FOREGROUND_WORKFLOW_DISCOVERY_SKEW_MS = 1_000;

const DISCOVERABLE_FOREGROUND_WORKFLOW_STATUSES = new Set(["pending", "running", "backgrounded"]);

function getWorkflowRunTimestamp(value: string): number | null {
  const timestamp = Date.parse(value);
  return Number.isFinite(timestamp) ? timestamp : null;
}

function stringifyWorkflowArgs(value: unknown): string | null {
  try {
    return JSON.stringify(value);
  } catch {
    return null;
  }
}

function workflowArgsEqual(left: unknown, right: unknown): boolean {
  const leftJson = stringifyWorkflowArgs(left);
  const rightJson = stringifyWorkflowArgs(right);
  return leftJson != null && rightJson != null && leftJson === rightJson;
}

function isFreshEnoughForToolCall(run: WorkflowRunRecord, startedAt: number | undefined): boolean {
  if (startedAt == null) {
    return true;
  }
  const createdAt = getWorkflowRunTimestamp(run.createdAt);
  if (createdAt == null) {
    return true;
  }
  // Tool-call timestamps are monotonic stream timestamps; run.createdAt is workflow-service wall
  // time. Allow a small skew for same-tick creation without accepting clearly stale runs.
  return createdAt >= startedAt - FOREGROUND_WORKFLOW_DISCOVERY_SKEW_MS;
}

function getLatestWorkflowEventSequence(run: WorkflowRunRecord | null | undefined): number {
  return run?.events.reduce((maxSequence, event) => Math.max(maxSequence, event.sequence), 0) ?? 0;
}

function compareWorkflowRunSnapshots(left: WorkflowRunRecord, right: WorkflowRunRecord): number {
  const leftUpdatedAt = getWorkflowRunTimestamp(left.updatedAt);
  const rightUpdatedAt = getWorkflowRunTimestamp(right.updatedAt);
  if (leftUpdatedAt != null && rightUpdatedAt != null && leftUpdatedAt !== rightUpdatedAt) {
    return leftUpdatedAt - rightUpdatedAt;
  }
  if (leftUpdatedAt != null && rightUpdatedAt == null) {
    return 1;
  }
  if (leftUpdatedAt == null && rightUpdatedAt != null) {
    return -1;
  }
  return getLatestWorkflowEventSequence(left) - getLatestWorkflowEventSequence(right);
}

function getNewestWorkflowRunSnapshot(
  current: WorkflowRunRecord | null,
  next: WorkflowRunRecord
): WorkflowRunRecord {
  if (current == null || current.id !== next.id) {
    return next;
  }
  return compareWorkflowRunSnapshots(current, next) > 0 ? current : next;
}

function getWorkflowRunSource(run: WorkflowRunRecord | null | undefined): string | null {
  const source = (run as { source?: unknown } | null | undefined)?.source;
  return typeof source === "string" && source.length > 0 ? source : null;
}

function getWorkflowRunScriptPath(args: WorkflowRunToolDisplayArgs): string {
  return args.script_path ?? ("name" in args ? args.name : "");
}

function getWorkflowRunDisplayName(args: WorkflowRunToolDisplayArgs): string {
  const scriptPath = getWorkflowRunScriptPath(args);
  if (scriptPath.length > 0) {
    return scriptPath;
  }
  if (isKernelBoundedMarker(args)) {
    // Placeholder until the attached durable run supplies the real name.
    return "workflow";
  }
  return args.script_source != null ? "inline workflow" : "";
}

function workflowRunMatchesLaunchArgs(
  run: WorkflowRunRecord,
  args: WorkflowRunToolLaunchArgs
): boolean {
  const invocationArgs = args.args ?? {};
  if (!workflowArgsEqual(run.args ?? {}, invocationArgs)) {
    return false;
  }
  if (args.script_source != null) {
    return run.workflow.sourceKind === "inline" && getWorkflowRunSource(run) === args.script_source;
  }
  const scriptPath = getWorkflowRunScriptPath(args);
  assert(scriptPath.length > 0, "workflowRunMatchesLaunchArgs requires a script path");
  return workflowScriptMatchesPath(run.workflow, scriptPath);
}

function findForegroundWorkflowRun(input: {
  runs: readonly WorkflowRunRecord[];
  args: WorkflowRunToolLaunchArgs;
  startedAt?: number;
}): WorkflowRunRecord | null {
  const candidates = input.runs.filter(
    (run) =>
      workflowRunMatchesLaunchArgs(run, input.args) &&
      DISCOVERABLE_FOREGROUND_WORKFLOW_STATUSES.has(run.status) &&
      isFreshEnoughForToolCall(run, input.startedAt)
  );
  if (candidates.length !== 1) {
    return null;
  }
  return candidates[0] ?? null;
}

function selectWorkflowRunSnapshot(input: {
  runId?: string;
  baseRun?: WorkflowRunRecord;
  refreshedRun: WorkflowRunRecord | null;
}): { runId?: string; run?: WorkflowRunRecord } {
  const runId = input.runId ?? input.baseRun?.id ?? input.refreshedRun?.id;
  if (runId == null) {
    return {};
  }
  if (input.refreshedRun?.id !== runId) {
    return input.baseRun == null ? { runId } : { runId, run: input.baseRun };
  }
  if (input.baseRun?.id !== runId) {
    return { runId, run: input.refreshedRun };
  }
  return {
    runId,
    run:
      compareWorkflowRunSnapshots(input.refreshedRun, input.baseRun) >= 0
        ? input.refreshedRun
        : input.baseRun,
  };
}

function getLatestResultEvent(run: WorkflowRunRecord | null | undefined): unknown {
  return run?.events.findLast((event) => event.type === "result")?.result;
}

function isWorkflowDisplayStatusActive(status: string): boolean {
  return status === "pending" || status === "running" || status === "backgrounded";
}

function shouldRefreshWorkflow(status: string): boolean {
  return REFRESHING_WORKFLOW_STATUSES.has(status);
}

function toToolStatus(status: string): ToolStatus {
  if (status === "running" || status === "executing") {
    return "executing";
  }
  if (
    status === "pending" ||
    status === "completed" ||
    status === "failed" ||
    status === "interrupted" ||
    status === "backgrounded"
  ) {
    return status;
  }
  return "pending";
}

export const WorkflowRunToolCall: React.FC<WorkflowRunToolCallProps> = ({
  args,
  result,
  status = "pending",
  workspaceId,
  toolCallId,
  startedAt,
  toolCallTimestamp,
  toolName = "workflow_run",
  knownRunId,
  workflowRunHint: explicitWorkflowRunHint,
}) => {
  // Freshness bound for run discovery: prefer the true execution start, but fall back to
  // the model-emission timestamp for parts without execution-start tracking (history replay).
  const discoveryFreshnessBound = startedAt ?? toolCallTimestamp;
  const apiState = useContext(APIContext);
  const commandRegistry = useOptionalCommandRegistry();
  const registerCommandSource = commandRegistry?.registerSource;
  const errorResult = isToolErrorResult(result) ? result : null;
  const successResult = isWorkflowRunSuccessResult(result) ? result : null;
  // Kernel-nested calls: launch args may be a bounded marker (no launch args
  // to match against) and the result marker may retain only runId/status.
  const launchArgs = getWorkflowRunLaunchArgs(args);
  const boundedResultIdentity = getKernelBoundedResultIdentity(result);
  const liveWorkflowRunHint = useWorkflowToolLiveRun(workspaceId, toolCallId);
  const workflowRunHint = explicitWorkflowRunHint ?? liveWorkflowRunHint;
  const [refreshedRun, setRefreshedRun] = useState<WorkflowRunRecord | null>(null);
  const [resumingRunId, setResumingRunId] = useState<string | null>(null);
  const [workflowControlInFlightRunId, setWorkflowControlInFlightRunId] = useState<string | null>(
    null
  );
  const workflowControlInFlightRunIdRef = useRef<string | null>(null);
  const setWorkflowControlInFlight = (nextRunId: string | null) => {
    workflowControlInFlightRunIdRef.current = nextRunId;
    setWorkflowControlInFlightRunId(nextRunId);
  };
  const baseRun =
    successResult?.run != null && workflowRunHint?.run != null
      ? getNewestWorkflowRunSnapshot(successResult.run, workflowRunHint.run)
      : (successResult?.run ?? workflowRunHint?.run);
  const selectedRun = selectWorkflowRunSnapshot({
    // knownRunId (workflow_resume) and workflowRunHint provide exact identities before any
    // result arrives, which also disables the heuristic name+args foreground discovery below.
    runId:
      successResult?.runId ?? boundedResultIdentity?.runId ?? knownRunId ?? workflowRunHint?.runId,
    baseRun,
    refreshedRun,
  });
  const runId = selectedRun.runId;
  const run = selectedRun.run;
  const workflowWorkspaceId = run?.workspaceId ?? workspaceId;
  const hasRefreshedRunSnapshot =
    refreshedRun != null && refreshedRun.id === runId && run === refreshedRun;
  // workflow_resume can return a fresh dispatch status while intentionally omitting a stale
  // pre-dispatch run snapshot. Trust that result status only until polling provides a fresher run.
  const displayStatus =
    successResult?.run == null && successResult?.status != null && !hasRefreshedRunSnapshot
      ? successResult.status
      : (run?.status ?? successResult?.status ?? boundedResultIdentity?.status ?? status);
  const parentRunActive = isWorkflowDisplayStatusActive(displayStatus);
  const displayEventSequence = getLatestWorkflowEventSequence(run);
  const resultValue = successResult?.result ?? getLatestResultEvent(run);
  const reportMarkdown = getReportMarkdown(resultValue);
  const structuredOutput = getStructuredOutput(resultValue);
  const invocationArgs = run?.args ?? launchArgs?.args ?? {};
  const events = run?.events ?? [];
  const displayRows = getWorkflowDisplayRows(events);
  const headerStatus = toToolStatus(displayStatus);
  // Completed runs already read as done; mid-run (and stopped-early) cards get the
  // live "current step / phase" header line instead of a bare status.
  const headerProgressSummary =
    displayStatus === "completed" ? null : getWorkflowHeaderProgressSummary(run);
  const workspaceStore = useWorkspaceStoreRaw();
  // Active runs stay visible in the transcript as a live surface. The Workflows tab remains the
  // broader detail and history surface once a run settles.
  const workflowsTabEnabled = useExperimentValue(EXPERIMENT_IDS.DYNAMIC_WORKFLOWS);
  const {
    expanded,
    setLocalExpanded,
    toggleExpanded,
    markInteracted: markExpansionInteracted,
  } = useAutoCollapsingToolExpansion(true, {
    // Active runs are a live transcript surface even when the Workflows tab is available. Once a
    // run settles, the experiment restores the compact history presentation. Without the tab, only
    // completed runs collapse. Tool errors always stay open because no durable run may exist.
    autoCollapsed:
      errorResult == null &&
      !parentRunActive &&
      (workflowsTabEnabled || displayStatus === "completed"),
    resetKey: runId,
  });

  const [actionError, setActionError] = useState<string | null>(null);
  const resumeOrRetryPendingForRun =
    runId != null && (resumingRunId === runId || workflowControlInFlightRunId === runId);
  const liveSubscriptionEnabled =
    typeof apiState?.api?.workflows.subscribe === "function" &&
    workflowWorkspaceId != null &&
    runId != null &&
    // The workflows.subscribe feed deliberately omits nested (parentWorkflow) runs, so a card
    // whose snapshot is confirmed nested must keep the getRun poller instead of freezing on a
    // healthy stream that will never yield its run.
    run?.parentWorkflow == null &&
    (shouldRefreshWorkflow(displayStatus) ||
      resumingRunId === runId ||
      workflowControlInFlightRunId === runId);
  const liveSnapshot = useWorkflowRunLiveSnapshot({
    workspaceId: workflowWorkspaceId,
    runId,
    enabled: liveSubscriptionEnabled,
  });
  const displayWorkflow = run?.workflow;
  const runSource = getWorkflowRunSource(run);
  // workflow_resume cards only know the run ID until a snapshot loads; prefer the real
  // workflow name once available.
  const displayName = displayWorkflow?.name ?? getWorkflowRunDisplayName(args);
  // A uniquely discovered foreground run is actionable before the blocking tool call returns.
  const discoveredForegroundRunConfirmed =
    status === "executing" &&
    launchArgs != null &&
    launchArgs.run_in_background !== true &&
    workspaceId != null &&
    refreshedRun != null &&
    runId === refreshedRun.id &&
    refreshedRun.workspaceId === workspaceId;
  // knownRunId comes from the tool args themselves, so a fetched snapshot with a matching
  // ID confirms identity regardless of foreground/background mode.
  const discoveredKnownRunConfirmed =
    knownRunId != null &&
    workspaceId != null &&
    refreshedRun?.id === knownRunId &&
    refreshedRun.workspaceId === workspaceId;
  const workflowRunHintConfirmed =
    workflowRunHint?.runId != null &&
    workspaceId != null &&
    (workflowRunHint.run?.workspaceId == null || workflowRunHint.run.workspaceId === workspaceId);
  const runIdentityConfirmed =
    successResult?.runId != null ||
    boundedResultIdentity?.runId != null ||
    baseRun?.id != null ||
    discoveredForegroundRunConfirmed ||
    discoveredKnownRunConfirmed ||
    workflowRunHintConfirmed;
  const canInterrupt =
    runIdentityConfirmed &&
    apiState?.api != null &&
    run?.workspaceId != null &&
    (displayStatus === "running" || displayStatus === "backgrounded");
  const canResume =
    runIdentityConfirmed &&
    apiState?.api != null &&
    run?.workspaceId != null &&
    displayStatus === "interrupted" &&
    !resumeOrRetryPendingForRun;
  const canRetryFromCheckpoint =
    runIdentityConfirmed &&
    apiState?.api != null &&
    run?.workspaceId != null &&
    canRetryWorkflowFromCheckpoint(run) &&
    !resumeOrRetryPendingForRun;
  const updateRunFromAction = async (action: WorkflowRunControlAction) => {
    if (apiState?.api == null || run?.workspaceId == null || runId == null) {
      return;
    }
    const isResumeOrRetry = action === "resume" || action === "retryFromCheckpoint";
    if (isResumeOrRetry) {
      if (workflowControlInFlightRunIdRef.current === runId || resumingRunId === runId) {
        return;
      }
      setWorkflowControlInFlight(runId);
    }
    try {
      await updateWorkflowRunFromAction({
        api: apiState.api,
        workspaceId: run.workspaceId,
        runId,
        action,
        setActionError,
        setRefreshedRun,
        setResumingRunId,
        baselineSequence: getLatestWorkflowEventSequence(run),
      });
    } finally {
      if (isResumeOrRetry) {
        setWorkflowControlInFlight(null);
      }
    }
  };

  const updateRunFromActionRef = useRef(updateRunFromAction);
  updateRunFromActionRef.current = updateRunFromAction;

  useEffect(() => {
    // Checkpoint retries briefly keep showing the old failed snapshot until polling observes a
    // post-retry event sequence, so don't clear that pending marker just because status is failed.
    if (
      resumingRunId === runId &&
      run?.status !== "interrupted" &&
      !(run?.status === "failed" && canRetryWorkflowFromCheckpoint(run))
    ) {
      setResumingRunId(null);
    }
  }, [resumingRunId, run, runId]);

  useEffect(() => {
    const nextRun = liveSnapshot.run;
    if (nextRun == null) {
      return;
    }
    setRefreshedRun((current) => getNewestWorkflowRunSnapshot(current, nextRun));
    if (
      !shouldKeepWorkflowControlPolling({
        action: "retryFromCheckpoint",
        run: nextRun,
        baselineSequence: displayEventSequence,
      })
    ) {
      setResumingRunId(null);
    }
  }, [displayEventSequence, liveSnapshot.run]);

  useEffect(() => {
    if (registerCommandSource == null || runId == null || run?.workspaceId == null) {
      return;
    }

    const unregister = registerCommandSource(() => {
      const subtitle = `${displayName} • ${runId}`;
      const actions: CommandAction[] = [];
      if (canInterrupt) {
        actions.push({
          id: `workflow:${runId}:interrupt`,
          title: `Interrupt workflow: ${displayName}`,
          subtitle,
          section: "Workflows",
          keywords: ["workflow", "interrupt", "stop", displayName, runId],
          run: () => updateRunFromActionRef.current("interrupt"),
        });
      }
      if (canResume) {
        actions.push({
          id: `workflow:${runId}:resume`,
          title: `Resume workflow: ${displayName}`,
          subtitle,
          section: "Workflows",
          keywords: ["workflow", "resume", "continue", displayName, runId],
          run: () => updateRunFromActionRef.current("resume"),
        });
      }
      if (canRetryFromCheckpoint) {
        actions.push({
          id: `workflow:${runId}:retry-from-checkpoint`,
          title: `Retry workflow from checkpoint: ${displayName}`,
          subtitle,
          section: "Workflows",
          keywords: ["workflow", "retry", "resume", "checkpoint", displayName, runId],
          run: () => updateRunFromActionRef.current("retryFromCheckpoint"),
        });
      }
      return actions;
    });

    return unregister;
  }, [
    apiState?.api,
    displayName,
    canInterrupt,
    canRetryFromCheckpoint,
    canResume,
    resumeOrRetryPendingForRun,
    registerCommandSource,
    run?.workspaceId,
    runId,
    setLocalExpanded,
  ]);

  useEffect(() => {
    if (
      apiState?.api == null ||
      workspaceId == null ||
      runId != null ||
      status !== "executing" ||
      // Bounded marker args carry nothing to match against; identity arrives
      // via the workflow-run-attached hint instead.
      launchArgs == null ||
      launchArgs.run_in_background === true
    ) {
      return;
    }

    let ignore = false;
    const discover = async () => {
      try {
        const runs = await apiState.api.workflows.listRuns({ workspaceId });
        const foregroundRun = findForegroundWorkflowRun({
          runs,
          args: launchArgs,
          startedAt: discoveryFreshnessBound,
        });
        if (!ignore && foregroundRun != null) {
          setRefreshedRun((current) => getNewestWorkflowRunSnapshot(current, foregroundRun));
        }
      } catch (error) {
        console.error("Failed to discover foreground workflow run:", error);
      }
    };

    void discover();
    const interval = window.setInterval(() => {
      void discover();
    }, 2_000);
    return () => {
      ignore = true;
      window.clearInterval(interval);
    };
  }, [apiState?.api, launchArgs, runId, discoveryFreshnessBound, status, workspaceId]);

  const exactDiscoveryRunId = knownRunId ?? workflowRunHint?.runId ?? boundedResultIdentity?.runId;

  useEffect(() => {
    // workflow_resume args and workflowRunHint carry exact run identity, so fetch by ID while
    // the tool call executes. Keep polling until the snapshot reaches a status the regular
    // refresh effect covers; the first poll can race the backend's `running` append.
    if (
      apiState?.api == null ||
      workspaceId == null ||
      exactDiscoveryRunId == null ||
      (run != null && REFRESHING_WORKFLOW_STATUSES.has(run.status)) ||
      status !== "executing"
    ) {
      return;
    }

    let ignore = false;
    const discover = async () => {
      try {
        const nextRun = await apiState.api.workflows.getRun({
          workspaceId,
          runId: exactDiscoveryRunId,
        });
        if (!ignore && nextRun != null) {
          setRefreshedRun((current) => getNewestWorkflowRunSnapshot(current, nextRun));
        }
      } catch (error) {
        console.error("Failed to discover workflow run by id:", error);
      }
    };

    void discover();
    const interval = window.setInterval(() => {
      void discover();
    }, 2_000);
    return () => {
      ignore = true;
      window.clearInterval(interval);
    };
  }, [apiState?.api, exactDiscoveryRunId, run, status, workspaceId]);

  // Tool output redaction can strip `run.source` from completed cards; fetch the full durable
  // run lazily when the user expands the card so the Script source disclosure remains useful.
  // Snapshots persisted by pre-manifest builds embed `source` but the
  // `workflow.phaseManifest` field is ABSENT (hydrated records carry a manifest
  // or an explicit null). Active cards subscribe and receive hydrated records,
  // but terminal cards never do — so an absent field on a terminal snapshot also
  // triggers one hydrated fetch per run, or historical rails would never appear
  // after upgrading.
  const runPhaseManifest = run?.workflow.phaseManifest;
  const runStatus = run?.status;
  const manifestHydrationAttemptedFor = useRef<string | null>(null);
  useEffect(() => {
    const needsSource = runSource == null;
    const needsManifest =
      runSource != null &&
      runStatus != null &&
      !isActiveWorkflowRunStatus(runStatus) &&
      runPhaseManifest === undefined &&
      manifestHydrationAttemptedFor.current !== runId;
    if (
      !expanded ||
      apiState?.api == null ||
      runId == null ||
      workflowWorkspaceId == null ||
      (!needsSource && !needsManifest)
    ) {
      return;
    }

    let ignore = false;
    const refresh = async () => {
      try {
        const nextRun = await apiState.api.workflows.getRun({
          workspaceId: workflowWorkspaceId,
          runId,
        });
        if (!ignore && nextRun != null) {
          // Only a delivered hydrated record retires the manifest fetch; a
          // rejection or null leaves it eligible for the next expand.
          manifestHydrationAttemptedFor.current = runId;
          setRefreshedRun((current) => getNewestWorkflowRunSnapshot(current, nextRun));
        }
      } catch (error) {
        console.error("Failed to load workflow run source:", error);
      }
    };

    void refresh();
    return () => {
      ignore = true;
    };
  }, [apiState?.api, expanded, runId, runPhaseManifest, runSource, runStatus, workflowWorkspaceId]);

  useEffect(() => {
    if (
      apiState?.api == null ||
      runId == null ||
      run?.workspaceId == null ||
      (!shouldRefreshWorkflow(displayStatus) && resumingRunId !== runId) ||
      (liveSubscriptionEnabled && !liveSnapshot.failed)
    ) {
      return;
    }

    let ignore = false;
    const refresh = async () => {
      try {
        const nextRun = await apiState.api.workflows.getRun({
          workspaceId: run.workspaceId,
          runId,
        });
        if (!ignore && nextRun != null) {
          setRefreshedRun((current) => getNewestWorkflowRunSnapshot(current, nextRun));
          if (
            !shouldKeepWorkflowControlPolling({
              action: "retryFromCheckpoint",
              run: nextRun,
              baselineSequence: displayEventSequence,
            })
          ) {
            setResumingRunId(null);
          }
        }
      } catch (error) {
        console.error("Failed to refresh workflow run:", error);
      }
    };

    void refresh();
    const interval = window.setInterval(() => {
      void refresh();
    }, 2_000);
    return () => {
      ignore = true;
      window.clearInterval(interval);
    };
  }, [
    apiState?.api,
    displayEventSequence,
    displayStatus,
    liveSnapshot.failed,
    liveSubscriptionEnabled,
    resumingRunId,
    run?.workspaceId,
    runId,
  ]);

  const workflowView = run != null ? projectWorkflowRun(run) : null;
  const hasProjectedTimeline =
    workflowView != null && (workflowView.phases.length > 0 || workflowView.steps.length > 0);
  const eventLog =
    displayRows.length > 0 ? (
      <div className="border-border bg-background/20 max-h-[220px] overflow-y-auto rounded border">
        <ol className="divide-border/60 divide-y">
          {displayRows.map((row, index) => {
            if (row.kind === "task") {
              return (
                <WorkflowTaskRow
                  key={getDisplayRowKey(row)}
                  row={row}
                  displayIndex={index + 1}
                  steps={run?.steps ?? []}
                  onNavigate={(taskId) => workspaceStore.navigateToWorkspace(taskId)}
                  onOpenReport={() => {
                    markExpansionInteracted();
                  }}
                  onInspectStructuredOutput={() => {
                    markExpansionInteracted();
                  }}
                />
              );
            }
            if (row.kind === "workflow") {
              return (
                <WorkflowChildRunRow
                  key={getDisplayRowKey(row)}
                  row={row}
                  displayIndex={index + 1}
                  workspaceId={workflowWorkspaceId}
                  parentRunActive={parentRunActive}
                  depth={0}
                />
              );
            }
            if (row.kind === "patch") {
              return (
                <WorkflowEventRow
                  key={getDisplayRowKey(row)}
                  event={row.latestEvent}
                  tooltipEvent={row.firstEvent}
                  detailOverride={getWorkflowMergedRowDetail(row)}
                  displayIndex={index + 1}
                  steps={run?.steps ?? []}
                />
              );
            }
            return (
              <WorkflowEventRow
                key={getDisplayRowKey(row)}
                event={row.event}
                displayIndex={index + 1}
                steps={run?.steps ?? []}
              />
            );
          })}
        </ol>
      </div>
    ) : null;

  return (
    <ToolContainer expanded={expanded} className="@container">
      <ToolHeader onClick={toggleExpanded}>
        <ExpandIcon expanded={expanded}>▶</ExpandIcon>
        <ToolIcon toolName={toolName} />
        <WorkflowKindBadge />
        {/* min-w-0 + truncate lets a long workflow name yield space instead of holding
            its intrinsic width and starving the progress summary at narrow widths. */}
        <ToolName className="min-w-0 truncate">{displayName}</ToolName>
        {/* Collapsed-only: the expanded body already lists phases/steps, and duplicating
            their text in the header would just add noise next to the event log.
            grow + basis floor keeps the summary usable when the name is long (the name
            truncates first) and fills leftover space otherwise. */}
        {!expanded && headerProgressSummary != null && (
          <span className="text-muted counter-nums min-w-0 grow basis-24 truncate text-[10px]">
            {headerProgressSummary}
          </span>
        )}
        <StatusIndicator status={headerStatus}>{getStatusDisplay(headerStatus)}</StatusIndicator>
      </ToolHeader>

      {expanded && (
        <ToolDetails>
          <div className="text-muted mb-2 flex flex-wrap items-center gap-2 text-[10px]">
            {runId && <span className="font-mono">{runId}</span>}
            <span>{displayStatus}</span>
            {displayWorkflow?.scope && <span>{displayWorkflow.scope}</span>}
          </div>

          {displayWorkflow && (
            <WorkflowSection title="Script">
              <WorkflowScriptCard descriptor={displayWorkflow} compact />
            </WorkflowSection>
          )}

          {/* Large workflow payloads stay collapsed so completed runs remain scannable. */}
          <WorkflowDisclosureSection title="Arguments">
            <WorkflowJsonBlock value={invocationArgs} className="max-h-[180px]" />
          </WorkflowDisclosureSection>

          {runSource && (
            <WorkflowDisclosureSection title="Script source">
              <div className="border-border bg-code-bg max-h-[260px] overflow-auto rounded border p-2">
                <HighlightedCode language="javascript" code={runSource.trimEnd()} showLineNumbers />
              </div>
            </WorkflowDisclosureSection>
          )}

          {(canInterrupt || canResume || canRetryFromCheckpoint) && (
            <div className="mb-2 flex flex-wrap gap-2 text-[10px]">
              {canInterrupt && (
                <button
                  type="button"
                  className={WORKFLOW_ACTION_BUTTON_CLASS}
                  onClick={(event) => {
                    event.stopPropagation();
                    void updateRunFromAction("interrupt");
                  }}
                >
                  Interrupt workflow
                </button>
              )}
              {canResume && (
                <button
                  type="button"
                  className={WORKFLOW_ACTION_BUTTON_CLASS}
                  onClick={(event) => {
                    event.stopPropagation();
                    void updateRunFromAction("resume");
                  }}
                >
                  Resume workflow
                </button>
              )}
              {canRetryFromCheckpoint && (
                <button
                  type="button"
                  className={WORKFLOW_ACTION_BUTTON_CLASS}
                  onClick={(event) => {
                    event.stopPropagation();
                    void updateRunFromAction("retryFromCheckpoint");
                  }}
                >
                  Retry from checkpoint
                </button>
              )}
            </div>
          )}

          {actionError && <ErrorBox className="mb-2">{actionError}</ErrorBox>}

          {hasProjectedTimeline && workflowView != null ? (
            <>
              <div
                className={`border-border bg-background/20 counter-nums mb-3 grid grid-cols-2 gap-x-3 gap-y-1 rounded border px-2 py-1.5 text-[10px] ${
                  workflowView.stats.usage != null ? "@sm:grid-cols-4" : ""
                }`}
              >
                <span>
                  {workflowView.stats.done}/{workflowView.stats.total} steps
                </span>
                <span>{formatWorkflowDuration(workflowView.stats.elapsedMs)}</span>
                {/* Usage exists only when a per-task overlay was supplied to projectWorkflowRun;
                    mirror WorkflowRunHeader and omit the cells instead of rendering dashes. */}
                {workflowView.stats.usage != null && (
                  <>
                    <span>{formatWorkflowTokens(workflowView.stats.usage.tokens)} tokens</span>
                    <span>{formatWorkflowCost(workflowView.stats.usage.costUsd)}</span>
                  </>
                )}
              </div>
              <div
                className="max-h-[400px] overflow-y-auto pr-1"
                onClickCapture={markExpansionInteracted}
              >
                <WorkflowTimeline
                  view={workflowView}
                  workspaceId={workflowWorkspaceId}
                  showFinalReport={false}
                />
              </div>
              {eventLog != null && (
                <WorkflowDisclosureSection
                  title="Event log"
                  className="mt-2"
                  unmountCollapsed
                  onOpen={markExpansionInteracted}
                >
                  {eventLog}
                </WorkflowDisclosureSection>
              )}
            </>
          ) : (
            eventLog != null && (
              <WorkflowSection title={`Workflow events (${displayRows.length})`}>
                {eventLog}
              </WorkflowSection>
            )
          )}
          {structuredOutput !== undefined && (
            <WorkflowDisclosureSection title="Structured output" className="mt-2">
              <WorkflowJsonBlock value={structuredOutput} className="max-h-[220px]" />
            </WorkflowDisclosureSection>
          )}

          {reportMarkdown && (
            <div className="text-[11px]">
              <MarkdownRenderer content={reportMarkdown} />
            </div>
          )}

          {errorResult && <ErrorBox className="mt-2">{errorResult.error}</ErrorBox>}
        </ToolDetails>
      )}
    </ToolContainer>
  );
};

interface WorkflowResumeToolCallProps {
  args: WorkflowResumeToolArgs;
  result?: WorkflowResumeToolResult;
  status?: ToolStatus;
  workspaceId?: string;
  toolCallId?: string;
  startedAt?: number;
  workflowRunHint?: WorkflowToolLiveRunState | null;
}

/**
 * workflow_resume renders the same run card as workflow_run. The args only carry a run ID
 * (no workflow name/args), so the run ID doubles as the display name until the run record
 * loads, and knownRunId enables exact-by-ID discovery instead of name+args matching.
 */
export const WorkflowResumeToolCall: React.FC<WorkflowResumeToolCallProps> = (props) => {
  return (
    <WorkflowRunToolCall
      args={{
        script_path: props.args.run_id,
        args: undefined,
        run_in_background: props.args.run_in_background ?? false,
      }}
      result={props.result}
      status={props.status}
      workspaceId={props.workspaceId}
      toolCallId={props.toolCallId}
      startedAt={props.startedAt}
      toolName="workflow_resume"
      workflowRunHint={props.workflowRunHint}
      knownRunId={props.args.run_id}
    />
  );
};

/**
 * Projects a durable `WorkflowRunRecord` into the view-model the Workflows tab
 * renders (the "Timeline" layout: phases → steps).
 *
 * Why a projector: the persisted run record is intentionally lean. A
 * `WorkflowStepRecord` carries only `{ stepId, status, taskId, timestamps,
 * result, error }` — it has no phase, title, or per-step usage. Those are
 * reconstructed here from the ordered event log:
 *   - phase grouping comes from `phase` events (a step belongs to the phase
 *     that was current at its first `task` event, by sequence);
 *   - the step title comes from its `task` event (falling back to the step's
 *     result title, then the stepId);
 *   - duration is derived from the step timestamps;
 *   - per-step token/cost usage is an optional overlay keyed by the persisted
 *     step `taskId`. UI navigation uses `taskWorkspaceId`, which is present only
 *     for direct agent-task events so patch rows do not link to their source task.
 *
 * Keeping this pure (no React, no IPC) makes the non-trivial folding logic unit
 * testable and keeps the components dumb.
 */
import {
  isActiveWorkflowRunStatus,
  isTerminalWorkflowRunStatus,
  type StructuredTaskOutput,
  type WorkflowPhaseManifest,
  type WorkflowResult,
  type WorkflowRunEvent,
  type WorkflowRunRecord,
  type WorkflowRunStatus,
  type WorkflowStepStatus,
} from "@/common/types/workflow";

/** UI-facing step status. The persisted "started" maps to "running". */
export type WorkflowStepDisplayStatus = "running" | "completed" | "failed" | "interrupted";

export interface WorkflowStepUsage {
  tokens?: number;
  costUsd?: number;
}

export interface WorkflowStepView {
  stepId: string;
  /** Persisted task id associated with the step; patch steps may reference their source task. */
  taskId?: string;
  /** Child workspace id created by this step's direct agent task event. */
  taskWorkspaceId?: string;
  status: WorkflowStepDisplayStatus;
  /** Human title (task title or nested-workflow name → step result title → stepId). */
  title: string;
  /** Owning phase name, or null when no phase was announced before the step. */
  phaseName: string | null;
  startedAt: string;
  completedAt?: string;
  /** Wall-clock duration once the step has settled. */
  durationMs?: number;
  result?: StructuredTaskOutput;
  error?: string;
  /** Optional usage overlay resolved from the step's task workspace. */
  usage?: WorkflowStepUsage;
  /** Nested workflow run spawned by this step, when the step delegates to another workflow. */
  nestedWorkflowRunId?: string;
  nestedWorkflowName?: string;
  nestedWorkflowStatus?: Extract<WorkflowRunEvent, { type: "workflow" }>["status"];
}

/**
 * Rail lifecycle for a phase, derived from the declared manifest (intent) merged
 * with observed phase events (truth):
 * - "pending": declared but not yet visited while the run is active.
 * - "running"/"completed"/"failed"/"interrupted": visited; latest-visited phases
 *   mirror the run status, earlier visited phases read as completed unless a
 *   step in them failed.
 * - "skipped"/"not-reached": declared but never visited once the run settled
 *   (completed vs failed/interrupted).
 * - "not-visited": the neutral terminal-unvisited state for INFERRED manifests,
 *   which cannot distinguish mutually-exclusive branches from skipped work.
 */
export type WorkflowPhaseLifecycle =
  | "pending"
  | "running"
  | "completed"
  | "failed"
  | "interrupted"
  | "skipped"
  | "not-reached"
  | "not-visited";

/** Lifecycles of phases that never emitted a phase event. */
const UNVISITED_PHASE_LIFECYCLES: ReadonlySet<WorkflowPhaseLifecycle> = new Set([
  "pending",
  "skipped",
  "not-reached",
  "not-visited",
]);

export function isUnvisitedPhaseLifecycle(lifecycle: WorkflowPhaseLifecycle): boolean {
  return UNVISITED_PHASE_LIFECYCLES.has(lifecycle);
}

export interface WorkflowPhaseView {
  /** Phase id; "" for the implicit bucket holding steps with no announced phase. */
  name: string;
  label: string;
  detail?: string;
  /** Raw `details` from the phase event — often a structured info object the UI can expand. */
  details?: unknown;
  steps: WorkflowStepView[];
  /** Completed steps observed so far in this phase. */
  done: number;
  /**
   * Steps observed so far in this phase. NOT the eventual count: the run record
   * never declares how many steps a phase will ultimately spawn, so totals grow
   * as steps start. Render as "done / observed", not "done / planned".
   */
  total: number;
  running: boolean;
  failed: boolean;
  lifecycle: WorkflowPhaseLifecycle;
  /**
   * True for the phase the run entered most recently in EVENT order — the run's
   * current (or, once terminal, final) position. `phases` is rail-ordered, so
   * after `scope → verify → scope` this marks `scope` even though `verify` sits
   * later in the array. Never set on the implicit "" bucket.
   */
  latest: boolean;
  /** Declared fan-out marker from meta.phases (presentational). */
  parallel?: boolean;
}

export interface WorkflowRunStats {
  total: number;
  done: number;
  running: number;
  failed: number;
  /** updatedAt − createdAt; the components can show a live ticker on top. */
  elapsedMs: number;
  /** Aggregate usage, present only when a usage overlay was supplied. */
  usage?: WorkflowStepUsage;
}

export interface WorkflowArgEntry {
  /** null for a single positional/primitive arg with no name. */
  key: string | null;
  value: string;
  stages?: Array<{ name: string; role?: string; brief?: string }>;
}

export interface WorkflowRunView {
  id: string;
  workflow: WorkflowRunRecord["workflow"];
  status: WorkflowRunStatus;
  argEntries: WorkflowArgEntry[];
  createdAt: string;
  updatedAt: string;
  phases: WorkflowPhaseView[];
  steps: WorkflowStepView[];
  /** Final report, present once a `result` event has been recorded. */
  result: WorkflowResult | null;
  /** Last `error` event message — surfaces a run-level failure with no step error. */
  errorMessage: string | null;
  stats: WorkflowRunStats;
}

export interface ProjectWorkflowRunOptions {
  /** Per-task usage keyed by the persisted step `taskId`. */
  usageByTaskId?: ReadonlyMap<string, WorkflowStepUsage>;
}

const STEP_STATUS_TO_DISPLAY: Record<WorkflowStepStatus, WorkflowStepDisplayStatus> = {
  started: "running",
  completed: "completed",
  failed: "failed",
  interrupted: "interrupted",
};

function parseTime(iso: string): number {
  const value = Date.parse(iso);
  return Number.isFinite(value) ? value : 0;
}

/** Render an arbitrary workflow arg value for display (primitives verbatim, else JSON). */
export function stringifyWorkflowArgValue(value: unknown): string {
  if (typeof value === "string") {
    return value;
  }
  if (typeof value === "number" || typeof value === "boolean") {
    return String(value);
  }
  if (value == null) {
    return "";
  }
  try {
    return JSON.stringify(value) ?? "";
  } catch {
    return "[unserializable]";
  }
}

function derivePlannedStages(value: unknown): WorkflowArgEntry["stages"] {
  if (!Array.isArray(value) || value.length === 0) return undefined;
  const items: unknown[] = value;
  const stages: NonNullable<WorkflowArgEntry["stages"]> = [];
  for (const item of items) {
    if (
      item == null ||
      typeof item !== "object" ||
      Array.isArray(item) ||
      !("name" in item) ||
      typeof item.name !== "string" ||
      item.name.trim().length === 0
    ) {
      return undefined;
    }
    const role = "role" in item ? item.role : undefined;
    const brief = "brief" in item ? item.brief : undefined;
    if (
      (role !== undefined && typeof role !== "string") ||
      (brief !== undefined && typeof brief !== "string")
    ) {
      return undefined;
    }
    stages.push({ name: item.name, role, brief });
  }
  return stages;
}

function deriveArgEntries(args: unknown): WorkflowArgEntry[] {
  if (args != null && typeof args === "object" && !Array.isArray(args)) {
    return Object.entries(args as Record<string, unknown>).map(([key, value]) => {
      const entry: WorkflowArgEntry = { key, value: stringifyWorkflowArgValue(value) };
      const stages = key === "stages" ? derivePlannedStages(value) : undefined;
      if (stages != null) entry.stages = stages;
      return entry;
    });
  }
  const value = stringifyWorkflowArgValue(args);
  return value.length > 0 ? [{ key: null, value }] : [];
}

// Phase events carry a freeform `details` JSON value; pull a human detail string
// out of it when present (string, or an object with a detail-ish field).
function derivePhaseDetail(details: unknown): string | undefined {
  if (typeof details === "string") {
    return details.length > 0 ? details : undefined;
  }
  if (details != null && typeof details === "object" && !Array.isArray(details)) {
    const record = details as Record<string, unknown>;
    for (const key of ["detail", "description", "summary"]) {
      const candidate = record[key];
      if (typeof candidate === "string" && candidate.length > 0) {
        return candidate;
      }
    }
  }
  return undefined;
}

function buildPhaseView(
  name: string,
  label: string,
  detail: string | undefined,
  details: unknown,
  steps: WorkflowStepView[],
  lifecycle: WorkflowPhaseLifecycle,
  latest: boolean,
  parallel?: boolean
): WorkflowPhaseView {
  return {
    name,
    label,
    detail,
    details,
    steps,
    done: steps.filter((step) => step.status === "completed").length,
    total: steps.length,
    running: steps.some((step) => step.status === "running"),
    failed: steps.some((step) => step.status === "failed"),
    lifecycle,
    latest,
    ...(parallel === true ? { parallel: true } : {}),
  };
}

/**
 * Collapse consecutive duplicate phase events (same name back-to-back) into one
 * transition.
 *
 * Replay finding (verified empirically via interrupt + workflow_resume): the
 * runner replays the script from the start and `phase()` re-appends its event
 * unconditionally (WorkflowRunner has no phase-event dedup, unlike checkpointed
 * agent steps). A resumed run's log therefore contains the ENTIRE phase walk
 * again (e.g. plan → verify → plan → verify → finalize). Reconciliation absorbs
 * that as loop re-entry — visited-set + latest-visited semantics with manifest
 * order — while this collapse handles the same-phase-resume case (interrupt and
 * resume inside one phase re-announces it back-to-back) and scripts announcing
 * a phase twice in a row. This is also why per-phase iteration counters stay
 * out of v1: entry counts would double after every resume.
 */
function collapsePhaseTransitions(events: readonly WorkflowRunEvent[]): string[] {
  const transitions: string[] = [];
  for (const event of events) {
    if (event.type !== "phase") {
      continue;
    }
    if (transitions.at(-1) !== event.name) {
      transitions.push(event.name);
    }
  }
  return transitions;
}

/**
 * Merge the declared manifest order (intent) with observed phase transitions
 * (truth). Declared phases always keep manifest order — out-of-order visits do
 * NOT reorder the rail. A dynamic (observed-but-undeclared) phase is inserted
 * immediately after its anchor: the most recent declared phase observed before
 * its LATEST visit (`scope → detour → verify → detour` places `detour` after
 * `verify`, where the run currently is); dynamic phases sharing an anchor keep
 * the order of those latest visits, and a dynamic phase observed before any
 * declared phase anchors at the head of the rail.
 */
function mergeManifestPhaseOrder(
  manifest: WorkflowPhaseManifest,
  transitions: readonly string[]
): string[] {
  const declaredNames = new Set(manifest.phases.map((phase) => phase.name));
  const anchorByDynamic = new Map<string, string | null>();
  let currentAnchor: string | null = null;
  for (const name of transitions) {
    if (declaredNames.has(name)) {
      currentAnchor = name;
      continue;
    }
    // Delete-then-set so re-entry moves the phase to the end of its (new) anchor group.
    anchorByDynamic.delete(name);
    anchorByDynamic.set(name, currentAnchor);
  }
  const dynamicByAnchor = new Map<string | null, string[]>();
  for (const [name, anchor] of anchorByDynamic) {
    const bucket = dynamicByAnchor.get(anchor);
    if (bucket != null) {
      bucket.push(name);
    } else {
      dynamicByAnchor.set(anchor, [name]);
    }
  }

  const order: string[] = [...(dynamicByAnchor.get(null) ?? [])];
  for (const phase of manifest.phases) {
    order.push(phase.name);
    order.push(...(dynamicByAnchor.get(phase.name) ?? []));
  }
  return order;
}

function derivePhaseLifecycle(input: {
  name: string;
  visited: ReadonlySet<string>;
  latestVisited: string | null;
  runStatus: WorkflowRunStatus;
  hasFailedStep: boolean;
  inferredProvenance: boolean;
}): WorkflowPhaseLifecycle {
  const isLatest = input.name === input.latestVisited;
  if (input.visited.has(input.name)) {
    // A failed step marks its phase regardless of position; the latest-visited
    // phase of a failed run is also failed even without a failed step record.
    if (input.hasFailedStep || (isLatest && input.runStatus === "failed")) {
      return "failed";
    }
    if (isLatest && input.runStatus === "interrupted") {
      return "interrupted";
    }
    if (isLatest && !isTerminalWorkflowRunStatus(input.runStatus)) {
      return "running";
    }
    return "completed";
  }
  if (isActiveWorkflowRunStatus(input.runStatus)) {
    return "pending";
  }
  // Terminal-unvisited. Inference cannot distinguish mutually-exclusive branches
  // from genuinely skipped work, so inferred rails stay judgment-free.
  if (input.inferredProvenance) {
    return "not-visited";
  }
  return input.runStatus === "completed" ? "skipped" : "not-reached";
}

// Events that belong to a step. Steps are recorded via task events (agent steps) and also via
// patch (apply-patch), workflow (nested-workflow), and legacy action/validation events. Phase
// assignment keys off the first of ANY of these per stepId so every step lands in its phase.
function stepBearingEventStepId(event: WorkflowRunEvent): string | null {
  switch (event.type) {
    case "agent-step":
    case "task":
    case "workflow":
    case "patch":
    case "action":
    case "validation":
      return event.stepId;
    default:
      return null;
  }
}

type WorkflowChildEvent = Extract<WorkflowRunEvent, { type: "workflow" }>;

interface WorkflowChildAttempt {
  firstEvent: WorkflowChildEvent;
  latestEvent: WorkflowChildEvent;
}

function getWorkflowChildAttempts(events: readonly WorkflowRunEvent[]): WorkflowChildAttempt[] {
  const attempts: WorkflowChildAttempt[] = [];
  const attemptsByKey = new Map<string, WorkflowChildAttempt>();
  for (const event of events) {
    if (event.type !== "workflow") {
      continue;
    }
    const key = `${event.stepId}:${event.runId}`;
    const existing = attemptsByKey.get(key);
    if (existing != null) {
      existing.latestEvent = event;
      continue;
    }
    const attempt = { firstEvent: event, latestEvent: event };
    attemptsByKey.set(key, attempt);
    attempts.push(attempt);
  }
  return attempts;
}

function workflowChildAttemptOverlapsStep(
  attempt: WorkflowChildAttempt,
  step: WorkflowRunRecord["steps"][number]
): boolean {
  const childStartedAt = parseTime(attempt.firstEvent.at);
  const stepStartedAt = parseTime(step.startedAt);
  const stepCompletedAt =
    step.completedAt != null ? parseTime(step.completedAt) : Number.POSITIVE_INFINITY;
  return childStartedAt >= stepStartedAt && childStartedAt < stepCompletedAt;
}

function findNestedWorkflowAttemptForStep(
  step: WorkflowRunRecord["steps"][number],
  attempts: readonly WorkflowChildAttempt[]
): WorkflowChildAttempt | null {
  const matchingAttempts = attempts.filter(
    (attempt) =>
      attempt.firstEvent.stepId === step.stepId && workflowChildAttemptOverlapsStep(attempt, step)
  );
  if (matchingAttempts.length > 0) {
    return (
      [...matchingAttempts].sort((a, b) => b.latestEvent.sequence - a.latestEvent.sequence)[0] ??
      null
    );
  }

  const sameStepAttempts = attempts.filter((attempt) => attempt.firstEvent.stepId === step.stepId);
  return sameStepAttempts.length === 1 ? (sameStepAttempts[0] ?? null) : null;
}

export function projectWorkflowRun(
  run: WorkflowRunRecord,
  options: ProjectWorkflowRunOptions = {}
): WorkflowRunView {
  const events = run.events;

  // Named phases in first-appearance order, plus an ordered index of phase
  // changes so each step can be assigned the phase current at its first task.
  const phaseOrder: string[] = [];
  const phaseMeta = new Map<string, { label: string; detail?: string; details?: unknown }>();
  const phaseChanges: Array<{ sequence: number; name: string }> = [];
  for (const event of events) {
    if (event.type === "phase") {
      if (!phaseMeta.has(event.name)) {
        phaseOrder.push(event.name);
        phaseMeta.set(event.name, {
          label: event.name,
          detail: derivePhaseDetail(event.details),
          details: event.details,
        });
      }
      phaseChanges.push({ sequence: event.sequence, name: event.name });
    }
  }

  // First step-bearing event sequence + title per step. A step can be recorded via task,
  // patch, workflow, action, or validation events, so phase assignment must use whichever of
  // those comes first — keying only off task events would drop patch/nested-workflow steps into
  // the ungrouped bucket even when a phase was active.
  const stepFirstEventSeq = new Map<string, number>();
  const stepTitle = new Map<string, string>();
  const stepTaskEventIds = new Map<string, Set<string>>();
  const nestedWorkflowAttempts = getWorkflowChildAttempts(events);
  for (const event of events) {
    const stepId = stepBearingEventStepId(event);
    if (stepId == null) {
      continue;
    }
    if (!stepFirstEventSeq.has(stepId)) {
      stepFirstEventSeq.set(stepId, event.sequence);
    }
    if (event.type === "task") {
      const taskEventIds = stepTaskEventIds.get(stepId);
      if (taskEventIds != null) {
        taskEventIds.add(event.taskId);
      } else {
        stepTaskEventIds.set(stepId, new Set([event.taskId]));
      }
    }
    if (!stepTitle.has(stepId)) {
      if (
        (event.type === "agent-step" || event.type === "task") &&
        event.title != null &&
        event.title.length > 0
      ) {
        stepTitle.set(stepId, event.title);
      } else if (event.type === "workflow") {
        // Nested-workflow steps have no task title; use the child workflow's name.
        stepTitle.set(stepId, event.name);
      }
    }
  }

  // phaseChanges is already in ascending sequence order (event order).
  const phaseAtSequence = (sequence: number): string | null => {
    let current: string | null = null;
    for (const change of phaseChanges) {
      if (change.sequence <= sequence) {
        current = change.name;
      } else {
        break;
      }
    }
    return current;
  };

  const usageByTaskId = options.usageByTaskId;

  const steps: WorkflowStepView[] = run.steps.map((step) => {
    const startSequence = stepFirstEventSeq.get(step.stepId);
    const phaseName = startSequence != null ? phaseAtSequence(startSequence) : null;
    const durationMs =
      step.completedAt != null
        ? Math.max(0, parseTime(step.completedAt) - parseTime(step.startedAt))
        : undefined;
    const usage = step.taskId != null ? usageByTaskId?.get(step.taskId) : undefined;
    const taskWorkspaceId =
      step.taskId != null && stepTaskEventIds.get(step.stepId)?.has(step.taskId) === true
        ? step.taskId
        : undefined;
    const nestedWorkflowEvent = findNestedWorkflowAttemptForStep(
      step,
      nestedWorkflowAttempts
    )?.latestEvent;
    return {
      stepId: step.stepId,
      taskId: step.taskId,
      taskWorkspaceId,
      status: STEP_STATUS_TO_DISPLAY[step.status],
      title: stepTitle.get(step.stepId) ?? step.result?.title ?? step.stepId,
      phaseName,
      startedAt: step.startedAt,
      completedAt: step.completedAt,
      durationMs,
      result: step.result,
      error: step.error,
      usage,
      nestedWorkflowRunId: nestedWorkflowEvent?.runId,
      nestedWorkflowName: nestedWorkflowEvent?.name,
      nestedWorkflowStatus: nestedWorkflowEvent?.status,
    };
  });

  const recordedStepKeys = new Set(run.steps.map((step) => `${step.stepId}\0${step.inputHash}`));
  const reservationByStepKey = new Map<
    string,
    {
      first: Extract<WorkflowRunEvent, { type: "agent-step" }>;
      latest: Extract<WorkflowRunEvent, { type: "agent-step" }>;
    }
  >();
  for (const event of events) {
    if (event.type !== "agent-step") {
      continue;
    }
    const key = `${event.stepId}\0${event.inputHash}`;
    if (recordedStepKeys.has(key)) {
      continue;
    }
    const existing = reservationByStepKey.get(key);
    if (existing != null) {
      existing.latest = event;
    } else {
      reservationByStepKey.set(key, { first: event, latest: event });
    }
  }

  for (const reservation of reservationByStepKey.values()) {
    const status = reservation.latest.status === "failed" ? "failed" : "running";
    const errorDetails = reservation.latest.details;
    const error =
      errorDetails != null &&
      typeof errorDetails === "object" &&
      !Array.isArray(errorDetails) &&
      typeof (errorDetails as Record<string, unknown>).error === "string"
        ? (errorDetails as Record<string, string>).error
        : undefined;
    steps.push({
      stepId: reservation.first.stepId,
      status,
      title: reservation.first.title ?? reservation.first.stepId,
      phaseName: phaseAtSequence(reservation.first.sequence),
      startedAt: reservation.first.at,
      completedAt: status === "failed" ? reservation.latest.at : undefined,
      durationMs:
        status === "failed"
          ? Math.max(0, parseTime(reservation.latest.at) - parseTime(reservation.first.at))
          : undefined,
      error,
    });
  }

  // Group steps by phase, preserving declared phase order.
  const stepsByPhase = new Map<string | null, WorkflowStepView[]>();
  for (const step of steps) {
    const bucket = stepsByPhase.get(step.phaseName);
    if (bucket != null) {
      bucket.push(step);
    } else {
      stepsByPhase.set(step.phaseName, [step]);
    }
  }

  // Declared manifest (hydrated onto the run's workflow descriptor) merged with
  // observed events. Absent manifest → observed-only order, exactly as before.
  const manifest = run.workflow.phaseManifest;
  const transitions = collapsePhaseTransitions(events);
  const visited = new Set(transitions);
  const latestVisited = transitions.at(-1) ?? null;
  const inferredProvenance = manifest?.provenance === "inferred";
  const declaredByName = new Map(manifest?.phases.map((phase) => [phase.name, phase]) ?? []);
  const orderedNames =
    manifest != null ? mergeManifestPhaseOrder(manifest, transitions) : phaseOrder;

  const phases: WorkflowPhaseView[] = [];
  for (const name of orderedNames) {
    const meta = phaseMeta.get(name);
    const declared = declaredByName.get(name);
    const phaseSteps = stepsByPhase.get(name) ?? [];
    phases.push(
      buildPhaseView(
        name,
        declared?.label ?? meta?.label ?? name,
        meta?.detail ?? declared?.description,
        meta?.details,
        phaseSteps,
        derivePhaseLifecycle({
          name,
          visited,
          latestVisited,
          runStatus: run.status,
          hasFailedStep: phaseSteps.some((step) => step.status === "failed"),
          inferredProvenance,
        }),
        name === latestVisited,
        declared?.parallel
      )
    );
  }
  const ungrouped = stepsByPhase.get(null) ?? [];
  if (ungrouped.length > 0) {
    // Steps with no announced phase precede the named phases chronologically. When
    // the run declares no phases at all, this is the sole flat group. The bucket
    // holds real observed steps, so its lifecycle derives from them directly.
    const label = orderedNames.length === 0 ? "Steps" : "Other steps";
    const bucketLifecycle: WorkflowPhaseLifecycle = ungrouped.some(
      (step) => step.status === "failed"
    )
      ? "failed"
      : ungrouped.some((step) => step.status === "running")
        ? "running"
        : "completed";
    phases.unshift(
      buildPhaseView("", label, undefined, undefined, ungrouped, bucketLifecycle, false)
    );
  }

  let result: WorkflowResult | null = null;
  let errorMessage: string | null = null;
  for (const event of events) {
    if (event.type === "result") {
      result = event.result;
    } else if (event.type === "error") {
      errorMessage = event.message;
    }
  }

  let usageTotal: WorkflowStepUsage | undefined;
  if (usageByTaskId != null) {
    let tokens = 0;
    let costUsd = 0;
    let hasUsage = false;
    for (const step of steps) {
      if (step.usage == null) {
        continue;
      }
      tokens += step.usage.tokens ?? 0;
      costUsd += step.usage.costUsd ?? 0;
      hasUsage = true;
    }
    if (hasUsage) {
      usageTotal = { tokens, costUsd };
    }
  }

  return {
    id: run.id,
    workflow: run.workflow,
    status: run.status,
    argEntries: deriveArgEntries(run.args),
    createdAt: run.createdAt,
    updatedAt: run.updatedAt,
    phases,
    steps,
    result,
    errorMessage,
    stats: {
      total: steps.length,
      done: steps.filter((step) => step.status === "completed").length,
      running: steps.filter((step) => step.status === "running").length,
      failed: steps.filter((step) => step.status === "failed").length,
      elapsedMs: Math.max(0, parseTime(run.updatedAt) - parseTime(run.createdAt)),
      usage: usageTotal,
    },
  };
}

/**
 * The phase a compact summary should name: the running phase, else the phase
 * visited most recently in EVENT order, else the implicit step bucket. Never an
 * unvisited rail node: before the first phase event a pending (or setup-failed)
 * declared run must read as "no phase", not "phase N/N".
 */
export function getActiveWorkflowPhase(
  phases: readonly WorkflowPhaseView[]
): WorkflowPhaseView | null {
  return (
    // `latest` is the phase entered most recently in EVENT order: on an active run
    // it is the one with lifecycle "running", on a terminal run the final position.
    // It beats both rail order (`findLast` would name `verify` after a
    // `scope → verify → scope` loop) and phases that merely still have a live step
    // (`phase(A); agent(...); phase(B)` must read as B, not regress to "phase 1/N").
    phases.find((phase) => phase.latest) ??
    // Steps observed before any phase event sit in the "" bucket, which is
    // chronologically first — so it is the position only when nothing else was
    // visited, even while its steps are still running.
    phases.find((phase) => phase.name === "") ??
    null
  );
}

/**
 * Picks the run the tab should focus by default: the most recently updated
 * active (pending/running/backgrounded) run, else the most recently updated run.
 */
export function selectPrimaryWorkflowRun<
  T extends Pick<WorkflowRunRecord, "id" | "status" | "updatedAt">,
>(runs: readonly T[]): T | null {
  if (runs.length === 0) {
    return null;
  }
  const active = runs.filter((run) => isActiveWorkflowRunStatus(run.status));
  const pool = active.length > 0 ? active : runs;
  return [...pool].sort((a, b) => parseTime(b.updatedAt) - parseTime(a.updatedAt))[0] ?? null;
}

import type {
  WorkflowRunEvent,
  WorkflowRunRecord,
  WorkflowStepStatus,
} from "@/common/types/workflow";
import assert from "@/common/utils/assert";
import { resolveWorkflowPhaseManifest } from "@/node/services/workflows/workflowPhaseManifest";

type WorkflowProgressEvent = Exclude<WorkflowRunEvent, { type: "status" | "result" }>;

function isWorkflowProgressEvent(event: WorkflowRunEvent): event is WorkflowProgressEvent {
  return event.type !== "status" && event.type !== "result";
}

function getWorkflowStepCounts(steps: ReadonlyArray<{ status: WorkflowStepStatus }>) {
  const counts: Record<WorkflowStepStatus, number> = {
    started: 0,
    completed: 0,
    failed: 0,
    interrupted: 0,
  };

  for (const step of steps) {
    counts[step.status] += 1;
  }

  return counts;
}

// Shared so the summary builder and the note formatter agree on what "latest phase" means.
function getLatestPhaseEvent(run: WorkflowRunRecord) {
  return run.events.findLast((event) => event.type === "phase");
}

// "phase i/N" position within the DECLARED manifest, or null when the run's
// script declares no phases or the latest phase is dynamic/undeclared. Inferred
// manifests never drive a fraction: their source order may not match runtime
// order, so a "2/5" would mislead. task_list/task_await hand this builder raw
// (non-hydrated) run records, so resolve from run.source directly (memoized).
function getDeclaredPhasePosition(
  run: WorkflowRunRecord,
  latestPhaseName: string
): { phaseIndex: number; declaredPhaseCount: number } | null {
  const outcome = resolveWorkflowPhaseManifest(run.source, run.sourceHash);
  if (outcome.kind !== "manifest" || outcome.manifest.provenance !== "declared") {
    return null;
  }
  const index = outcome.manifest.phases.findIndex((phase) => phase.name === latestPhaseName);
  if (index < 0) {
    return null;
  }
  return { phaseIndex: index + 1, declaredPhaseCount: outcome.manifest.phases.length };
}

export function buildWorkflowProgressSummary(run: WorkflowRunRecord) {
  assert(run.workflow.name.length > 0, "buildWorkflowProgressSummary: workflow name is required");

  const progressEvents = run.events.filter(isWorkflowProgressEvent);
  const latestPhase = getLatestPhaseEvent(run);
  const latestProgressEvent = progressEvents.at(-1);

  if (latestPhase == null && progressEvents.length === 0 && run.steps.length === 0) {
    return undefined;
  }

  return {
    name: run.workflow.name,
    ...(latestPhase != null
      ? {
          latestPhase: {
            name: latestPhase.name,
            at: latestPhase.at,
            ...getDeclaredPhasePosition(run, latestPhase.name),
          },
        }
      : {}),
    ...(latestProgressEvent != null ? { lastProgressAt: latestProgressEvent.at } : {}),
    stepCounts: getWorkflowStepCounts(run.steps),
  };
}

export function formatWorkflowProgressNote(baseNote: string, run: WorkflowRunRecord): string {
  assert(baseNote.length > 0, "formatWorkflowProgressNote: base note is required");

  const latestPhase = getLatestPhaseEvent(run);
  if (latestPhase == null) {
    return baseNote;
  }
  const position = getDeclaredPhasePosition(run, latestPhase.name);
  const positionSuffix =
    position != null ? ` (${position.phaseIndex}/${position.declaredPhaseCount})` : "";
  return `${baseNote} Latest phase: ${latestPhase.name}${positionSuffix}.`;
}

import type { z } from "zod";
import type {
  AvailableWorkflowSchema,
  StructuredTaskOutputSchema,
  WorkflowArgSummarySchema,
  WorkflowDeclaredPhaseSchema,
  WorkflowPhaseManifestSchema,
  WorkflowScriptDescriptorSchema,
  WorkflowMetadataSchema,
  WorkflowScriptScopeSchema,
  WorkflowResultSchema,
  WorkflowRunEventSchema,
  WorkflowRunParentSchema,
  WorkflowRunRecordSchema,
  WorkflowRunStatusSchema,
  WorkflowRunStreamEventSchema,
  WorkflowStepRecordSchema,
  WorkflowStepStatusSchema,
} from "@/common/orpc/schemas";

export type WorkflowArgSummary = z.infer<typeof WorkflowArgSummarySchema>;
export type WorkflowMetadata = z.infer<typeof WorkflowMetadataSchema>;
export type WorkflowScriptScope = z.infer<typeof WorkflowScriptScopeSchema>;
export type WorkflowRunStatus = z.infer<typeof WorkflowRunStatusSchema>;
export type WorkflowStepStatus = z.infer<typeof WorkflowStepStatusSchema>;
export type WorkflowDeclaredPhase = z.infer<typeof WorkflowDeclaredPhaseSchema>;
export type WorkflowPhaseManifest = z.infer<typeof WorkflowPhaseManifestSchema>;
export type WorkflowScriptDescriptor = z.infer<typeof WorkflowScriptDescriptorSchema>;
export type WorkflowResult = z.infer<typeof WorkflowResultSchema>;
export type StructuredTaskOutput = z.infer<typeof StructuredTaskOutputSchema>;
export type WorkflowRunEvent = z.infer<typeof WorkflowRunEventSchema>;
export type WorkflowStepRecord = z.infer<typeof WorkflowStepRecordSchema>;
export type WorkflowRunParent = z.infer<typeof WorkflowRunParentSchema>;
export type WorkflowRunRecord = z.infer<typeof WorkflowRunRecordSchema>;
export type WorkflowRunStreamEvent = z.infer<typeof WorkflowRunStreamEventSchema>;
export type AvailableWorkflow = z.infer<typeof AvailableWorkflowSchema>;

const ACTIVE_WORKFLOW_RUN_STATUSES = new Set<WorkflowRunStatus>([
  "pending",
  "running",
  "backgrounded",
]);

export function isActiveWorkflowRunStatus(status: WorkflowRunStatus): boolean {
  return ACTIVE_WORKFLOW_RUN_STATUSES.has(status);
}

export function isTerminalWorkflowRunStatus(status: WorkflowRunStatus): boolean {
  return status === "completed" || status === "failed" || status === "interrupted";
}

/**
 * Terminal statuses that owe a proactive background continuation (terminal wake). An
 * interrupted run was stopped deliberately, so neither the terminal callback (unless the
 * service opts in) nor the level-triggered attention sweep may notify it.
 */
export const WORKFLOW_BACKGROUND_CONTINUATION_STATUSES: ReadonlySet<WorkflowRunStatus> = new Set([
  "completed",
  "failed",
]);

/**
 * Status of a nested-workflow ("child") run event embedded in a parent run's event stream.
 * Distinct from {@link WorkflowRunStatus}: an in-progress child event reports "started" rather
 * than the persisted run's "pending".
 */
export type WorkflowChildEventStatus = Extract<WorkflowRunEvent, { type: "workflow" }>["status"];

const ACTIVE_WORKFLOW_CHILD_EVENT_STATUSES = new Set<WorkflowChildEventStatus>([
  "started",
  "running",
  "backgrounded",
]);

/**
 * Whether a nested-workflow event status represents an in-progress child run. Accepts
 * null/undefined so callers can pass an optional projected status without their own guard.
 */
export function isActiveWorkflowChildEventStatus(
  status: WorkflowChildEventStatus | null | undefined
): boolean {
  return status != null && ACTIVE_WORKFLOW_CHILD_EVENT_STATUSES.has(status);
}

export function isNestedWorkflowRun(run: { parentWorkflow?: WorkflowRunParent | null }): boolean {
  return run.parentWorkflow != null;
}

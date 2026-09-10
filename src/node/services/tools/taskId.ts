import assert from "node:assert/strict";

const BASH_TASK_ID_PREFIX = "bash:";
// Canonical workflow-run task ID prefix. WorkflowService.generateWorkflowRunId() builds run IDs
// from this exact constant, so there is a single source of truth instead of duplicated literals.
export const WORKFLOW_RUN_TASK_ID_PREFIX = "wfr_";

/**
 * Workflow run IDs are accepted by the task tools (task_await/task_list/task_stop)
 * alongside agent-task and bash task IDs; the prefix is the discriminator.
 *
 * The predicate narrows to the template-literal type (not plain `string`) so negated uses on
 * string inputs keep their type instead of collapsing to `never`.
 */
export function isWorkflowRunTaskId(value: unknown): value is `wfr_${string}` {
  return typeof value === "string" && value.startsWith(WORKFLOW_RUN_TASK_ID_PREFIX);
}

export function toBashTaskId(processId: string): string {
  assert(typeof processId === "string", "toBashTaskId: processId must be a string");
  const trimmed = processId.trim();
  assert(trimmed.length > 0, "toBashTaskId: processId must be non-empty");
  return `${BASH_TASK_ID_PREFIX}${trimmed}`;
}

export function fromBashTaskId(taskId: string): string | null {
  assert(typeof taskId === "string", "fromBashTaskId: taskId must be a string");
  if (!taskId.startsWith(BASH_TASK_ID_PREFIX)) {
    return null;
  }

  const processId = taskId.slice(BASH_TASK_ID_PREFIX.length).trim();
  return processId.length > 0 ? processId : null;
}

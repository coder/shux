import { tool } from "ai";

import { getErrorMessage } from "@/common/utils/errors";
import type { ToolConfiguration, ToolFactory } from "@/common/utils/tools/tools";
import { WorkflowRunRecordSchema } from "@/common/orpc/schemas";
import { TaskStopToolResultSchema, TOOL_DEFINITIONS } from "@/common/utils/tools/toolDefinitions";

import { TASK_TERMINATION_TOOL_TIMEOUT_MS } from "@/constants/terminationTimeouts";
import { log } from "@/node/services/log";
import { raceWithAbortAndTimeout } from "@/node/utils/concurrency/withTimeout";
import { isWorkspaceTurnTaskId } from "@/node/services/taskHandleStore";
import { fromBashTaskId, isWorkflowRunTaskId } from "./taskId";
import {
  dedupeStrings,
  parseToolResult,
  requireTaskService,
  requireWorkspaceTurnManager,
  requireWorkspaceId,
} from "./toolUtils";

const WORKFLOW_STOPPED_NOTE =
  "Workflow run stopped. Durable state is preserved; resume it later with workflow_resume.";

/**
 * Workflow runs are interrupted (resumable) rather than terminated: the durable event log is
 * preserved, which is why this reports a distinct "interrupted" status instead of "terminated"
 * (whose contract says in-progress work is discarded).
 */
async function interruptWorkflowRun(
  config: ToolConfiguration,
  workspaceId: string,
  taskId: string
) {
  const workflowService = config.workflowService;
  if (workflowService?.getRun == null || workflowService.interruptRun == null) {
    return {
      status: "error" as const,
      taskId,
      error: "Workflow service not available for workflow run interrupts",
    };
  }

  // getRun is workspace-scoped: runs owned by other workspaces are reported as not found.
  const rawRun = await workflowService.getRun({ workspaceId, runId: taskId });
  if (rawRun == null) {
    return { status: "not_found" as const, taskId };
  }
  // safeParse keeps batch entries isolated: one unreadable record must not collapse the
  // whole Promise.all into a single opaque tool error (self-healing doctrine).
  const parsedRun = WorkflowRunRecordSchema.safeParse(rawRun);
  if (!parsedRun.success) {
    return {
      status: "error" as const,
      taskId,
      error: "Workflow run record is unreadable and cannot be interrupted.",
    };
  }
  const run = parsedRun.data;

  if (run.status === "interrupted") {
    // Idempotent: re-interrupting an interrupted run is a no-op success.
    return { status: "already_inactive" as const, taskId };
  }
  if (run.status === "completed" || run.status === "failed") {
    return {
      status: "error" as const,
      taskId,
      error: `Workflow run is already ${run.status} and cannot be interrupted.`,
    };
  }

  try {
    await workflowService.interruptRun({ workspaceId, runId: taskId });
  } catch (error: unknown) {
    return { status: "error" as const, taskId, error: getErrorMessage(error) };
  }
  return { status: "stopped" as const, taskId, note: WORKFLOW_STOPPED_NOTE };
}

export const createTaskStopTool: ToolFactory = (config: ToolConfiguration) => {
  return tool({
    description: TOOL_DEFINITIONS.task_stop.description,
    inputSchema: TOOL_DEFINITIONS.task_stop.schema,
    execute: async (args, { abortSignal }): Promise<unknown> => {
      const workspaceId = requireWorkspaceId(config, "task_stop");
      const taskService = requireTaskService(config, "task_stop");
      const workspaceTurnManager = requireWorkspaceTurnManager(config, "task_stop");

      const uniqueTaskIds = dedupeStrings(args.task_ids);

      const results = await Promise.all(
        uniqueTaskIds.map(async (taskId) => {
          // A pre-aborted call must not start stop work at all.
          if (abortSignal?.aborted) {
            return {
              status: "error" as const,
              taskId,
              error: "Termination interrupted before it started",
            };
          }
          const terminationPromise = (async () => {
            try {
              if (isWorkflowRunTaskId(taskId)) {
                return await interruptWorkflowRun(config, workspaceId, taskId);
              }

              if (isWorkspaceTurnTaskId(taskId)) {
                const interruptResult = await workspaceTurnManager.interruptWorkspaceTurn(
                  workspaceId,
                  taskId
                );
                if (!interruptResult.success) {
                  const msg = interruptResult.error;
                  if (/not found/i.test(msg) || /scope/i.test(msg)) {
                    return { status: "invalid_scope" as const, taskId };
                  }
                  return { status: "error" as const, taskId, error: msg };
                }
                return {
                  status: "stopped" as const,
                  taskId,
                  note: "Workspace turn stopped. The workspace is preserved for future messages.",
                };
              }

              const maybeProcessId = fromBashTaskId(taskId);
              if (taskId.startsWith("bash:") && !maybeProcessId) {
                return { status: "error" as const, taskId, error: "Invalid bash taskId." };
              }

              if (maybeProcessId) {
                if (!config.backgroundProcessManager) {
                  return {
                    status: "error" as const,
                    taskId,
                    error: "Background process manager not available",
                  };
                }

                const proc = await config.backgroundProcessManager.getProcess(maybeProcessId);
                if (!proc) {
                  return { status: "not_found" as const, taskId };
                }

                const inScope =
                  proc.workspaceId === workspaceId ||
                  (await taskService.isDescendantAgentTask(workspaceId, proc.workspaceId));
                if (!inScope) {
                  return { status: "invalid_scope" as const, taskId };
                }

                const terminateResult = await config.backgroundProcessManager.terminate(
                  maybeProcessId,
                  {
                    monitorDisposition: "discard",
                  }
                );
                if (!terminateResult.success) {
                  return { status: "error" as const, taskId, error: terminateResult.error };
                }

                return {
                  status: "stopped" as const,
                  taskId,
                  stoppedTaskIds: [taskId],
                };
              }

              const stopResult = await taskService.stopDescendantAgentTask(workspaceId, taskId);
              if (!stopResult.success) {
                const msg = stopResult.error;
                // Exact-match the canonical scope errors: aggregated cleanup failures
                // may mention "descendant" or "not found" and must stay actionable errors.
                if (msg === "Task not found") {
                  return { status: "not_found" as const, taskId };
                }
                if (msg === "Task is not a descendant of this workspace") {
                  return { status: "invalid_scope" as const, taskId };
                }
                return { status: "error" as const, taskId, error: msg };
              }

              return stopResult.data.stoppedTaskIds.length === 0
                ? { status: "already_inactive" as const, taskId }
                : {
                    status: "stopped" as const,
                    taskId,
                    stoppedTaskIds: stopResult.data.stoppedTaskIds,
                  };
            } catch (error: unknown) {
              return { status: "error" as const, taskId, error: getErrorMessage(error) };
            }
          })();

          const outcome = await raceWithAbortAndTimeout(terminationPromise, {
            signal: abortSignal,
            timeoutMs: TASK_TERMINATION_TOOL_TIMEOUT_MS,
          });
          if (outcome.kind === "ok") {
            return outcome.value;
          }

          void terminationPromise.catch((error: unknown) => {
            log.debug("task_terminate cleanup failed after tool returned", { taskId, error });
          });
          return {
            status: "error" as const,
            taskId,
            error:
              outcome.kind === "aborted"
                ? "Termination interrupted; cleanup continues in the background"
                : "Termination timed out; cleanup continues in the background",
          };
        })
      );

      return parseToolResult(TaskStopToolResultSchema, { results }, "task_stop");
    },
  });
};

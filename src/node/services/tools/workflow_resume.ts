import { tool } from "ai";

import { getErrorMessage } from "@/common/utils/errors";
import type { ToolConfiguration, ToolFactory } from "@/common/utils/tools/tools";
import { isTerminalWorkflowRunStatus, type WorkflowRunRecord } from "@/common/types/workflow";
import { getWorkflowCheckpointRetryEligibility } from "@/common/utils/workflowRetryEligibility";
import { WorkflowRunRecordSchema } from "@/common/orpc/schemas";
import {
  WorkflowResumeToolResultSchema,
  TOOL_DEFINITIONS,
} from "@/common/utils/tools/toolDefinitions";
import { isWorkflowRunTaskId } from "./taskId";
import {
  emitWorkflowRunAttachedEvent,
  parseToolResult,
  recordBackgroundWorkflowRunReference,
  requireWorkspaceId,
} from "./toolUtils";

type WorkflowResumeMode = "resume" | "retry_from_checkpoint";

interface WorkflowResumeService {
  getRun(input: { workspaceId: string; runId: string }): Promise<unknown>;
  resumeRun(input: {
    workspaceId: string;
    runId: string;
    projectTrusted: boolean;
    abortSignal?: AbortSignal;
  }): Promise<{ runId: string; status: string; result: unknown }>;
  resumeRunInBackground(input: {
    workspaceId: string;
    runId: string;
    projectTrusted: boolean;
  }): Promise<{ runId: string; status: string; result: unknown }>;
  retryRunFromCheckpoint(input: {
    workspaceId: string;
    runId: string;
    projectTrusted: boolean;
    abortSignal?: AbortSignal;
  }): Promise<{ runId: string; status: string; result: unknown }>;
  retryRunFromCheckpointInBackground(input: {
    workspaceId: string;
    runId: string;
    projectTrusted: boolean;
  }): Promise<{ runId: string; status: string; result: unknown }>;
}

function requireWorkflowResumeService(config: ToolConfiguration): WorkflowResumeService {
  const workflowService = config.workflowService;
  if (!workflowService) {
    throw new Error("workflow_resume requires workflowService");
  }
  if (
    workflowService.getRun == null ||
    workflowService.resumeRun == null ||
    workflowService.resumeRunInBackground == null ||
    workflowService.retryRunFromCheckpoint == null ||
    workflowService.retryRunFromCheckpointInBackground == null
  ) {
    throw new Error("workflow_resume requires workflow run lifecycle support");
  }
  return {
    getRun: workflowService.getRun.bind(workflowService),
    resumeRun: workflowService.resumeRun.bind(workflowService),
    resumeRunInBackground: workflowService.resumeRunInBackground.bind(workflowService),
    retryRunFromCheckpoint: workflowService.retryRunFromCheckpoint.bind(workflowService),
    retryRunFromCheckpointInBackground:
      workflowService.retryRunFromCheckpointInBackground.bind(workflowService),
  };
}

async function getWorkflowRunForWorkspace(
  service: WorkflowResumeService,
  workspaceId: string,
  runId: string
): Promise<WorkflowRunRecord | null> {
  const run = await service.getRun({ workspaceId, runId });
  if (run == null) {
    return null;
  }
  // safeParse keeps the failure actionable: an unreadable record should produce a concise
  // tool error instead of leaking a verbose zod stack (self-healing doctrine).
  const parsed = WorkflowRunRecordSchema.safeParse(run);
  if (!parsed.success) {
    throw new Error(`Workflow run record is unreadable: ${runId}`);
  }
  return parsed.data;
}

function getLatestWorkflowResult(run: WorkflowRunRecord): unknown {
  return run.events.findLast((event) => event.type === "result")?.result ?? null;
}

function isWorkflowRunAlreadyActiveError(error: unknown, runId: string): boolean {
  return getErrorMessage(error) === `Workflow run is already active: ${runId}`;
}

/**
 * Resuming an interrupted/crashed run only replays durable state (never re-executes completed
 * steps), so it is the safe default. Checkpoint retry of a *failed* run re-executes whatever
 * followed the last durable event, so it must be requested explicitly — see the user rationale
 * captured in this tool's description.
 */
function assertRunStatusAllowsMode(run: WorkflowRunRecord, mode: WorkflowResumeMode): void {
  if (mode === "retry_from_checkpoint") {
    if (run.status !== "failed") {
      throw new Error(
        `retry_from_checkpoint requires a failed workflow run; ${run.id} is ${run.status}. ` +
          "Use mode 'resume' (or omit mode) for interrupted or crash-orphaned runs."
      );
    }
    const eligibility = getWorkflowCheckpointRetryEligibility(run);
    if (!eligibility.canRetry) {
      throw new Error(
        `${eligibility.reason ?? "Workflow run cannot be retried from checkpoint"}. ` +
          "Start a fresh run with workflow_run instead."
      );
    }
    return;
  }

  if (run.status === "failed") {
    const eligibility = getWorkflowCheckpointRetryEligibility(run);
    throw new Error(
      `Workflow run failed: ${run.id}. Resume only continues interrupted or crash-orphaned runs. ` +
        (eligibility.canRetry
          ? "Retry it from the last durable checkpoint with mode 'retry_from_checkpoint' (re-executes work after the checkpoint), or start a fresh run with workflow_run."
          : `It cannot be retried from checkpoint (${eligibility.reason ?? "ineligible"}); start a fresh run with workflow_run.`)
    );
  }
}

export const createWorkflowResumeTool: ToolFactory = (config: ToolConfiguration) => {
  return tool({
    description: TOOL_DEFINITIONS.workflow_resume.description,
    inputSchema: TOOL_DEFINITIONS.workflow_resume.schema,
    execute: async (args, options): Promise<unknown> => {
      const workspaceId = requireWorkspaceId(config, "workflow_resume");
      const workflowService = requireWorkflowResumeService(config);

      const runId = args.run_id.trim();
      if (!isWorkflowRunTaskId(runId)) {
        throw new Error(
          `workflow_resume requires a workflow run ID (wfr_...); got: ${args.run_id}. ` +
            "Discover run IDs with task_list or from a prior workflow_run result."
        );
      }

      const run = await getWorkflowRunForWorkspace(workflowService, workspaceId, runId);
      if (run == null) {
        throw new Error(`Workflow run not found in this workspace: ${runId}`);
      }

      const mode: WorkflowResumeMode = args.mode ?? "resume";
      const invocationStartedAtMs = Date.now();

      // A kernel-nested resume (mux.workflow_resume inside code_execution) leaves no top-level
      // workflow_resume part in history, so the history-walk consumption predicates cannot see
      // that this turn already received the terminal result. Persist consumption durably so the
      // terminal-attention drain never re-delivers it.
      const markTerminalAttentionSettled = async (
        terminalRun: Pick<WorkflowRunRecord, "id" | "status" | "updatedAt">
      ) => {
        if (!isTerminalWorkflowRunStatus(terminalRun.status)) {
          return;
        }
        await config.taskService?.markWorkflowRunTerminalAttentionSettled?.({
          ownerWorkspaceId: workspaceId,
          runId: terminalRun.id,
          status: terminalRun.status,
          runUpdatedAt: terminalRun.updatedAt,
          settledAs: "delivered",
        });
      };

      // Idempotent success: the work is already done, so hand back the durable result instead
      // of failing the agent's recovery loop (e.g. resuming after a crash that actually finished).
      if (run.status === "completed" && mode === "resume") {
        await markTerminalAttentionSettled(run);
        return parseToolResult(
          WorkflowResumeToolResultSchema,
          {
            status: "completed",
            runId,
            result: getLatestWorkflowResult(run),
            mode,
            note: "Workflow run had already completed; returning its existing result without re-running.",
            run,
          },
          "workflow_resume"
        );
      }

      assertRunStatusAllowsMode(run, mode);

      await emitWorkflowRunAttachedEvent({
        config,
        workspaceId,
        toolCallId: options.toolCallId,
        runId: run.id,
        run,
      });

      const dispatchInput = {
        workspaceId,
        runId,
        projectTrusted: config.trusted === true,
      };
      let dispatched: { runId: string; status: string; result: unknown };
      try {
        if (mode === "retry_from_checkpoint") {
          dispatched =
            args.run_in_background === true
              ? await workflowService.retryRunFromCheckpointInBackground(dispatchInput)
              : await workflowService.retryRunFromCheckpoint({
                  ...dispatchInput,
                  ...(options.abortSignal != null ? { abortSignal: options.abortSignal } : {}),
                });
        } else {
          dispatched =
            args.run_in_background === true
              ? await workflowService.resumeRunInBackground(dispatchInput)
              : await workflowService.resumeRun({
                  ...dispatchInput,
                  ...(options.abortSignal != null ? { abortSignal: options.abortSignal } : {}),
                });
        }
      } catch (error: unknown) {
        if (isWorkflowRunAlreadyActiveError(error, runId)) {
          throw new Error(
            `Workflow run is already active: ${runId}. It does not need resuming — await it with task_await.`
          );
        }
        throw error;
      }

      // Background-style resumes outlive this turn; persist provenance so the run is
      // rediscoverable (task_await/task_list) and its terminal result re-engages the agent.
      // Deliberately AFTER the dispatch, unlike workflow_run's onRunCreated record: the
      // resumed run sits in an old terminal state until the dispatch durably restarts it, and
      // a pre-dispatch reference would let a crash in that window make startup recovery
      // deliver the stale failure/interruption as a current wake. Recording late fails safe
      // instead (a crash loses this resume's wake); with the process alive, delivery always
      // waits for the owner to go idle, by which point this record is durable.
      const isBackgroundDispatch =
        args.run_in_background === true || dispatched.status === "backgrounded";
      if (isBackgroundDispatch) {
        await recordBackgroundWorkflowRunReference(config, runId, invocationStartedAtMs);
      }

      const refreshedRun = await getWorkflowRunForWorkspace(workflowService, workspaceId, runId);
      // Background dispatch resolves at lease acquisition, which can race the runner's
      // `running` status append. A snapshot still showing the pre-dispatch status is stale:
      // embedding it would freeze the UI card (and mislead the agent) on a status the run has
      // already left, with no poller applying after the tool result lands. Omit it; the
      // result's `status` field plus run polling converge on the live state.
      const refreshedRunIsStale =
        isBackgroundDispatch && refreshedRun != null && refreshedRun.status === run.status;

      // Foreground only: a background dispatch can still observe the stale pre-dispatch
      // terminal status, and settling it would absorb the retried run's future terminal wake.
      // The settled marker binds to the run's terminal generation (updatedAt), so it needs a
      // refreshed record that reflects the dispatched terminal status; when the refresh failed
      // or lags, skip the marker and the wake settles as consumed from the tool result in
      // history on the next scan (worst case one redundant wake for a kernel-nested resume).
      if (
        !isBackgroundDispatch &&
        refreshedRun != null &&
        refreshedRun.status === dispatched.status
      ) {
        await markTerminalAttentionSettled(refreshedRun);
      }

      return parseToolResult(
        WorkflowResumeToolResultSchema,
        {
          status: dispatched.status,
          runId: dispatched.runId,
          result: dispatched.result,
          mode,
          ...(refreshedRun != null && !refreshedRunIsStale ? { run: refreshedRun } : {}),
        },
        "workflow_resume"
      );
    },
  });
};

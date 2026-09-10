import type { SendMessageOptions } from "@/common/orpc/types";
import type { WorkflowRunRecord, WorkflowRunStatus } from "@/common/types/workflow";
import {
  WORKFLOW_RESULT_METADATA_TYPE,
  buildWorkflowResultContextMessage,
} from "@/common/utils/workflowRunMessages";
import { log } from "@/node/services/log";
import type { WorkspaceService } from "@/node/services/workspaceService";

const WORKFLOW_CONTINUATION_RETRY_DELAY_MS = 1_000;
const WORKSPACE_BUSY_IDLE_ONLY_SEND_MESSAGE = "Workspace is busy; idle-only send was skipped.";

// Standalone module so WorkflowService's value import stays off workspaceService.ts,
// whose transitive graph (hookService -> ptc -> typescript) must not enter the CLI api bundle.
type WorkflowContinuationWorkspaceService = Pick<
  WorkspaceService,
  "isWorkflowInvocationCurrent" | "getWorkflowContinuationSendOptions" | "sendMessage"
>;

export async function sendWorkflowRunTerminalContinuation(
  service: WorkflowContinuationWorkspaceService,
  input: {
    workspaceId: string;
    rawCommand: string;
    name: string;
    runId: string;
    status: WorkflowRunStatus;
    result: unknown;
    run: WorkflowRunRecord;
    continuationOptions?: SendMessageOptions;
  }
): Promise<void> {
  const commandPrefix = input.rawCommand.split(/\s+/u)[0] ?? input.name;
  const workflowResultMessage = buildWorkflowResultContextMessage(input);
  let continuationOptions = input.continuationOptions ?? null;

  for (;;) {
    if (!(await service.isWorkflowInvocationCurrent(input.workspaceId, input.runId))) {
      log.debug("Skipping superseded workflow continuation", {
        workspaceId: input.workspaceId,
        runId: input.runId,
      });
      return;
    }

    continuationOptions ??= await service.getWorkflowContinuationSendOptions(input.workspaceId);
    if (continuationOptions == null) {
      log.warn("Skipping workflow continuation without send options", {
        workspaceId: input.workspaceId,
        runId: input.runId,
      });
      return;
    }

    const sendResult = await service.sendMessage(
      input.workspaceId,
      workflowResultMessage,
      {
        ...continuationOptions,
        skipAiSettingsPersistence: true,
        muxMetadata: {
          type: WORKFLOW_RESULT_METADATA_TYPE,
          rawCommand: input.rawCommand,
          commandPrefix,
          runId: input.runId,
          requestedModel: continuationOptions.model,
        },
      },
      {
        skipAutoResumeReset: true,
        synthetic: true,
        agentInitiated: true,
        requireIdle: true,
        startStreamInBackground: true,
      }
    );
    if (sendResult.success) {
      return;
    }
    if (
      sendResult.error.type !== "unknown" ||
      sendResult.error.raw?.includes(WORKSPACE_BUSY_IDLE_ONLY_SEND_MESSAGE) !== true
    ) {
      log.warn("Failed to continue workflow after completion", {
        workspaceId: input.workspaceId,
        runId: input.runId,
        error: sendResult.error,
      });
      return;
    }
    await new Promise((resolve) => setTimeout(resolve, WORKFLOW_CONTINUATION_RETRY_DELAY_MS));
  }
}

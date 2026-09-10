import { addEphemeralMessage } from "@/browser/stores/WorkspaceStore";
import type { MuxMessage } from "@/common/types/message";
import type { WorkflowRunRecord } from "@/common/types/workflow";
import {
  getWorkflowScriptDisplayPath,
  workflowScriptMatchesPath,
} from "@/browser/utils/workflowRunScriptPaths";
import assert from "@/common/utils/assert";
import {
  WORKFLOW_RUN_CARD_DISPLAY_METADATA_TYPE,
  WORKFLOW_TRIGGER_DISPLAY_METADATA_TYPE,
  buildWorkflowRunCardMessage,
  filterWorkflowDisplayOnlyMessages,
  isWorkflowRunEmittingToolName,
  type WorkflowRunCardInput,
  type WorkflowRunCardResult,
} from "@/common/utils/workflowRunMessages";

export { buildWorkflowRunCardMessage, filterWorkflowDisplayOnlyMessages };

function getLatestWorkflowResult(run: WorkflowRunRecord): unknown {
  return run.events.findLast((event) => event.type === "result")?.result ?? null;
}

function getOutputRunId(output: unknown): string | null {
  if (output != null && typeof output === "object") {
    const runId = (output as Record<string, unknown>).runId;
    if (typeof runId === "string" && runId.length > 0) {
      return runId;
    }
  }
  return null;
}

function getWorkflowInput(
  input: unknown
):
  | { scriptPath: string; scriptSource?: never; args: unknown }
  | { scriptSource: string; scriptPath?: never; args: unknown }
  | null {
  if (input != null && typeof input === "object") {
    const record = input as Record<string, unknown>;
    const scriptPath = record.script_path ?? record.name;
    if (typeof scriptPath === "string" && scriptPath.length > 0) {
      return { scriptPath, args: record.args ?? {} };
    }
    if (typeof record.script_source === "string" && record.script_source.length > 0) {
      return { scriptSource: record.script_source, args: record.args ?? {} };
    }
  }
  return null;
}

function workflowRunMatchesInput(
  run: Pick<WorkflowRunRecord, "workflow" | "args" | "source">,
  input: NonNullable<ReturnType<typeof getWorkflowInput>>
): boolean {
  if (!jsonEqual(input.args, run.args)) {
    return false;
  }
  if (input.scriptSource != null) {
    return run.workflow.sourceKind === "inline" && run.source === input.scriptSource;
  }
  return workflowScriptMatchesPath(run.workflow, input.scriptPath);
}

function jsonEqual(left: unknown, right: unknown): boolean {
  try {
    return JSON.stringify(left) === JSON.stringify(right);
  } catch {
    return false;
  }
}

function getProjectedWorkflowRunCardMessageId(runId: string): string {
  assert(runId.length > 0, "getProjectedWorkflowRunCardMessageId: run id is required");
  return `workflow-run-${runId}`;
}

function hasWorkflowRunCardMetadata(message: MuxMessage, runId: string): boolean {
  return (
    message.id === getProjectedWorkflowRunCardMessageId(runId) &&
    message.role === "assistant" &&
    message.metadata?.muxMetadata?.type === WORKFLOW_RUN_CARD_DISPLAY_METADATA_TYPE &&
    message.metadata.muxMetadata.runId === runId
  );
}

function findWorkflowTriggerDisplayMessage(
  messages: readonly MuxMessage[],
  runId: string
): MuxMessage | null {
  return (
    messages.find(
      (message) =>
        message.metadata?.muxMetadata?.type === WORKFLOW_TRIGGER_DISPLAY_METADATA_TYPE &&
        message.metadata.muxMetadata.runId === runId
    ) ?? null
  );
}

function getWorkflowRunCardMetadata(
  metadata: MuxMessage["metadata"] | undefined,
  runId: string
): MuxMessage["metadata"] {
  return {
    ...metadata,
    muxMetadata: {
      type: WORKFLOW_RUN_CARD_DISPLAY_METADATA_TYPE,
      runId,
    },
  };
}

export function findProjectedWorkflowRunCardMessage(
  messages: readonly MuxMessage[],
  runId: string
): MuxMessage | null {
  assert(runId.length > 0, "findProjectedWorkflowRunCardMessage: run id is required");
  const metadataMatch = messages.find((message) => hasWorkflowRunCardMetadata(message, runId));
  if (metadataMatch != null) {
    return metadataMatch;
  }

  const messageId = getProjectedWorkflowRunCardMessageId(runId);
  return (
    messages.find(
      (message) =>
        message.id === messageId &&
        message.parts.some(
          (part) =>
            part.type === "dynamic-tool" &&
            part.toolName === "workflow_run" &&
            part.state === "output-available" &&
            getOutputRunId(part.output) === runId
        )
    ) ?? null
  );
}

export function hasWorkflowRunToolCallMessage(
  messages: readonly MuxMessage[],
  run: Pick<WorkflowRunRecord, "id" | "workflow" | "args" | "source">
): boolean {
  assert(run.id.length > 0, "hasWorkflowRunToolCallMessage: run id is required");
  return messages.some((message) =>
    message.parts.some((part) => {
      if (part.type !== "dynamic-tool" || !isWorkflowRunEmittingToolName(part.toolName)) {
        return false;
      }
      if (part.state === "output-available") {
        return getOutputRunId(part.output) === run.id;
      }
      // The scriptPath+args heuristic deliberately stays workflow_run-only: workflow_resume
      // inputs carry a run_id, not a workflow script path/args pair.
      if (part.toolName !== "workflow_run") {
        return false;
      }
      const input = getWorkflowInput(part.input);
      return input != null && workflowRunMatchesInput(run, input);
    })
  );
}

export function getWorkflowRunCardProjection(
  messages: readonly MuxMessage[],
  run: Pick<WorkflowRunRecord, "id" | "workflow" | "args" | "status" | "source">
): { shouldProject: boolean; existingMessage: MuxMessage | null } {
  assert(run.id.length > 0, "getWorkflowRunCardProjection: run id is required");
  const existingMessage = findProjectedWorkflowRunCardMessage(messages, run.id);
  if (existingMessage != null) {
    return { shouldProject: true, existingMessage };
  }

  // Normal assistant workflow_run tool calls render and refresh themselves. Only synthetic
  // projected cards should be replaced here; otherwise we would duplicate model-started cards.
  if (hasWorkflowRunToolCallMessage(messages, run)) {
    return { shouldProject: false, existingMessage: null };
  }

  const triggerMessage = findWorkflowTriggerDisplayMessage(messages, run.id);
  if (triggerMessage != null) {
    return { shouldProject: true, existingMessage: triggerMessage };
  }

  // A durable workflow run can outlive the chat row that launched it (for example after editing a
  // prior message truncates history). Without a current transcript anchor, projecting it would
  // resurrect discarded workflow cards at the bottom of the chat.
  return { shouldProject: false, existingMessage: null };
}

export function addWorkflowRunCardMessage(
  workspaceId: string,
  input: WorkflowRunCardInput,
  result: WorkflowRunCardResult,
  options?: { existingMessage?: MuxMessage | null }
): void {
  assert(workspaceId.length > 0, "addWorkflowRunCardMessage: workspaceId is required");
  const message = buildWorkflowRunCardMessage(input, result);
  if (options?.existingMessage?.metadata != null) {
    message.metadata = getWorkflowRunCardMetadata(options.existingMessage.metadata, result.runId);
  }
  addEphemeralMessage(workspaceId, message);
}

export function addWorkflowRunCardMessageForRun(
  workspaceId: string,
  run: WorkflowRunRecord,
  options?: { existingMessage?: MuxMessage | null }
): void {
  addWorkflowRunCardMessage(
    workspaceId,
    { scriptPath: getWorkflowScriptDisplayPath(run.workflow), args: run.args },
    { runId: run.id, status: run.status, result: getLatestWorkflowResult(run), run },
    options
  );
}

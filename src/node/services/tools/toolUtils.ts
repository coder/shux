import assert from "node:assert/strict";

import type { z } from "zod";

import { getErrorMessage } from "@/common/utils/errors";
import { WorkflowRunRecordSchema } from "@/common/orpc/schemas";
import type { WorkflowRunAttachedEvent } from "@/common/types/stream";
import type { WorkspaceChatMessage } from "@/common/orpc/types";
import type { ToolConfiguration } from "@/common/utils/tools/tools";
import { recordAgentWorkflowRunReference } from "@/node/services/agentWorkflowRunReferences";
import { log } from "@/node/services/log";
import type { TaskService } from "@/node/services/taskService";
import type { WorkspaceTurnManager } from "@/node/services/workspaceTurnManager";

export function requireWorkspaceId(config: ToolConfiguration, toolName: string): string {
  assert(config.workspaceId, `${toolName} requires workspaceId`);
  return config.workspaceId;
}

export function requireTaskService(config: ToolConfiguration, toolName: string): TaskService {
  assert(config.taskService, `${toolName} requires taskService`);
  return config.taskService;
}

export function requireWorkspaceTurnManager(
  config: ToolConfiguration,
  toolName: string
): WorkspaceTurnManager {
  const manager = config.workspaceTurnManager ?? config.taskService;
  assert(manager, toolName + " requires workspaceTurnManager");
  return manager as WorkspaceTurnManager;
}

export function parseToolResult<TSchema>(
  schema: z.ZodType<TSchema>,
  value: unknown,
  toolName: string
): TSchema {
  const parsed = schema.safeParse(value);
  if (!parsed.success) {
    throw new Error(`${toolName} tool result validation failed: ${parsed.error.message}`);
  }
  return parsed.data;
}

export function dedupeStrings(values: readonly string[]): string[] {
  return Array.from(new Set(values));
}

export function emitChatEventBestEffort(
  config: ToolConfiguration,
  event: WorkspaceChatMessage,
  context: string
): void {
  const emitted = config.emitChatEvent?.(event);
  if (emitted == null) {
    return;
  }

  emitted.catch((error: unknown) => {
    log.debug("Failed to emit tool chat event", {
      context,
      eventType: event.type,
      error: getErrorMessage(error),
    });
  });
}

export async function emitWorkflowRunAttachedEvent(input: {
  config: ToolConfiguration;
  workspaceId: string;
  toolCallId?: string;
  runId: string;
  run?: unknown;
}): Promise<void> {
  if (!input.config.emitChatEvent || !input.toolCallId) {
    return;
  }

  const parsedRun = WorkflowRunRecordSchema.safeParse(input.run);
  const event: WorkflowRunAttachedEvent = {
    type: "workflow-run-attached",
    workspaceId: input.workspaceId,
    toolCallId: input.toolCallId,
    runId: input.runId,
    ...(parsedRun.success ? { run: parsedRun.data } : {}),
    timestamp: Date.now(),
  };
  await input.config.emitChatEvent(event);
}

/**
 * Persist agent provenance for a workflow run that outlives the current turn (background
 * start/resume, or a foreground run that backgrounded itself). TaskService reads these
 * references back so the run stays rediscoverable and its terminal result re-engages the agent.
 * Best-effort by design: failing the tool would strand a run that already started successfully,
 * and the history scan fallback can still re-establish provenance for the current context epoch.
 */
export async function recordBackgroundWorkflowRunReference(
  config: ToolConfiguration,
  runId: string,
  createdAtMs: number,
  options?: {
    /**
     * Pre-launch records must not fail soft: the sidecar is the kernel invocation's only
     * durable provenance, and starting the runner without it lets a fast terminal run have
     * its wake permanently marked superseded. Throwing before dispatch leaves the run
     * pending and resumable (workflow_resume re-records), so the caller surfaces a loud,
     * recoverable launch failure instead. Post-dispatch records stay best-effort because the
     * run already started and failing the tool would strand it.
     */
    propagateWriteFailure?: boolean;
  }
): Promise<void> {
  const workspaceSessionDir = config.workspaceSessionDir;
  if (workspaceSessionDir == null || workspaceSessionDir.length === 0) {
    if (options?.propagateWriteFailure === true) {
      throw new Error(
        `Cannot record workflow run provenance without a workspace session dir: ${runId}`
      );
    }
    log.warn("Skipping agent workflow run reference without workspace session dir", { runId });
    return;
  }

  // Snapshot which invocation-decision row is newest at launch so the terminal-wake
  // currentness check compares row identity instead of wall-clock order, which clock
  // corrections can reorder (see WorkspaceService.isWorkflowInvocationCurrent). A history read
  // failure must not be persisted as a verified-empty boundary (null): record without the
  // field instead, so the run stays rediscoverable (listAgentReferencedWorkflowRunIds) and a
  // later workflow_resume re-record can repair provenance, while the unverifiable boundary
  // fails safe to a not-current wake instead of guessing from wall-clock order.
  let afterBoundaryMessageId: string | null | undefined;
  const taskService = config.taskService;
  if (config.workspaceId != null && taskService?.getWorkflowInvocationBoundaryMessageId != null) {
    try {
      afterBoundaryMessageId = await taskService.getWorkflowInvocationBoundaryMessageId(
        config.workspaceId,
        runId
      );
    } catch (error: unknown) {
      log.error("Failed to snapshot workflow invocation boundary for run reference", {
        runId,
        error: getErrorMessage(error),
      });
    }
  }

  try {
    await recordAgentWorkflowRunReference({
      workspaceSessionDir,
      runId,
      createdAtMs,
      ...(afterBoundaryMessageId !== undefined ? { afterBoundaryMessageId } : {}),
      ...(config.agentId != null && config.agentId.length > 0
        ? {
            agentId: config.agentId,
            // The pin pairs with the identity: null records a verified-unpinned launch so the
            // wake never inherits another row's pin (see AgentWorkflowRunReference).
            strictAgentResolution:
              config.strictAgentResolution != null && config.strictAgentResolution !== false
                ? config.strictAgentResolution
                : null,
          }
        : {}),
    });
  } catch (error: unknown) {
    if (options?.propagateWriteFailure === true) {
      throw error;
    }
    log.warn("Failed to record agent workflow run reference", {
      runId,
      error: getErrorMessage(error),
    });
  }
}

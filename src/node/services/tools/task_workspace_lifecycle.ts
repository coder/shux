import { tool } from "ai";

import { getErrorMessage } from "@/common/utils/errors";
import type { ToolConfiguration, ToolFactory } from "@/common/utils/tools/tools";
import {
  TaskWorkspaceLifecycleToolResultSchema,
  TOOL_DEFINITIONS,
} from "@/common/utils/tools/toolDefinitions";
import { isWorkspaceTurnTaskId } from "@/node/services/taskHandleStore";
import { parseToolResult, requireWorkspaceId, requireWorkspaceTurnManager } from "./toolUtils";

// Only the reversible verbs survive the #3825 restoration; task_remove is the
// sole irreversible verb for child cleanup.
type LifecycleAction = "archive" | "unarchive";

interface LifecycleTarget {
  taskId?: string | null;
  workspaceId?: string | null;
}

function normalizeTarget(target: LifecycleTarget): { taskId?: string; workspaceId?: string } {
  // Trimmed presence, matching the input schema's superRefine: a blank identifier is absent,
  // so a valid workspaceId next to a whitespace-only taskId must select the workspaceId
  // instead of failing invalid_scope on the blank task ID.
  const taskId = target.taskId?.trim();
  if (taskId) {
    return { taskId };
  }
  const workspaceId = target.workspaceId?.trim();
  if (workspaceId) {
    return { workspaceId };
  }
  throw new Error("task_workspace_lifecycle requires exactly one target identifier");
}

function targetKey(target: { taskId?: string; workspaceId?: string }): string {
  return target.taskId != null ? `task:${target.taskId}` : `workspace:${target.workspaceId ?? ""}`;
}

function rejectInvalidWorkspaceTaskId(
  action: LifecycleAction,
  target: { taskId?: string; workspaceId?: string }
) {
  if (target.taskId == null || isWorkspaceTurnTaskId(target.taskId)) {
    return null;
  }
  return {
    status: "invalid_scope" as const,
    action,
    taskId: target.taskId,
    note: "task_workspace_lifecycle only accepts workspace-turn task IDs (wst_...).",
  };
}

export const createTaskWorkspaceLifecycleTool: ToolFactory = (config: ToolConfiguration) => {
  return tool({
    description: TOOL_DEFINITIONS.task_workspace_lifecycle.description,
    inputSchema: TOOL_DEFINITIONS.task_workspace_lifecycle.schema,
    execute: async (args): Promise<unknown> => {
      if (config.planFileOnly === true) {
        throw new Error("task_workspace_lifecycle is not available in plan mode");
      }

      const ownerWorkspaceId = requireWorkspaceId(config, "task_workspace_lifecycle");
      const workspaceTurnManager = requireWorkspaceTurnManager(config, "task_workspace_lifecycle");
      const interruptActive = args.interrupt_active === true;

      const seen = new Set<string>();
      const targets = args.targets.map(normalizeTarget).filter((target) => {
        const key = targetKey(target);
        if (seen.has(key)) return false;
        seen.add(key);
        return true;
      });

      const results = await Promise.all(
        targets.map(async (target) => {
          const invalidTaskId = rejectInvalidWorkspaceTaskId(args.action, target);
          if (invalidTaskId != null) {
            return invalidTaskId;
          }

          try {
            return await runLifecycleAction();
          } catch (error: unknown) {
            // Per-target isolation: one target's unexpected throw must degrade to that
            // target's error result instead of rejecting the whole Promise.all and losing
            // the sibling results.
            return {
              status: "error" as const,
              action: args.action,
              ...target,
              error: getErrorMessage(error),
            };
          }

          async function runLifecycleAction() {
            switch (args.action) {
              case "archive": {
                const result = await workspaceTurnManager.archiveOwnedWorkspaceTurnWorkspace(
                  ownerWorkspaceId,
                  target,
                  {
                    interruptActive,
                    acknowledgedUntrackedPaths:
                      target.workspaceId != null
                        ? (args.acknowledged_untracked_paths?.[target.workspaceId] ?? undefined)
                        : undefined,
                    // Targets addressed by taskId resolve to a workspaceId in the backend, so
                    // forward the full by-workspaceId map for post-resolution lookup.
                    acknowledgedUntrackedPathsByWorkspaceId:
                      args.acknowledged_untracked_paths ?? undefined,
                  }
                );
                return result.success
                  ? result.data
                  : {
                      status: "error" as const,
                      action: args.action,
                      ...target,
                      error: result.error,
                    };
              }
              case "unarchive": {
                const result = await workspaceTurnManager.unarchiveOwnedWorkspaceTurnWorkspace(
                  ownerWorkspaceId,
                  target
                );
                return result.success
                  ? result.data
                  : {
                      status: "error" as const,
                      action: args.action,
                      ...target,
                      error: result.error,
                    };
              }
            }
          }
        })
      );

      return parseToolResult(
        TaskWorkspaceLifecycleToolResultSchema,
        { results },
        "task_workspace_lifecycle"
      );
    },
  });
};

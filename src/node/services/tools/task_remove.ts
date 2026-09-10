import { tool } from "ai";

import type { ToolConfiguration, ToolFactory } from "@/common/utils/tools/tools";
import { TaskRemoveToolResultSchema, TOOL_DEFINITIONS } from "@/common/utils/tools/toolDefinitions";
import {
  dedupeStrings,
  parseToolResult,
  requireTaskService,
  requireWorkspaceId,
} from "./toolUtils";

export const createTaskRemoveTool: ToolFactory = (config: ToolConfiguration) => {
  return tool({
    description: TOOL_DEFINITIONS.task_remove.description,
    inputSchema: TOOL_DEFINITIONS.task_remove.schema,
    execute: async (args): Promise<unknown> => {
      if (config.planFileOnly === true) {
        throw new Error("task_remove is not available in plan mode");
      }

      const ownerWorkspaceId = requireWorkspaceId(config, "task_remove");
      const taskService = requireTaskService(config, "task_remove");
      const taskIds = dedupeStrings(args.task_ids);
      const depths = new Map(
        taskService
          .listDescendantAgentTasks(ownerWorkspaceId)
          .map((task) => [task.taskId, task.depth] as const)
      );
      taskIds.sort((left, right) => (depths.get(right) ?? 0) - (depths.get(left) ?? 0));

      const results = [];
      for (const taskId of taskIds) {
        const result = await taskService.removeInactiveDescendantAgentTask(
          ownerWorkspaceId,
          taskId
        );
        if (!result.success) {
          results.push({ status: "error" as const, taskId, error: result.error });
          continue;
        }
        const data = result.data;
        switch (data.status) {
          case "removed":
          case "already_removed":
          case "active":
          case "not_found":
          case "invalid_scope":
            results.push({
              status: data.status,
              taskId,
              ...(data.workspaceId != null ? { workspaceId: data.workspaceId } : {}),
            });
            break;
          case "error":
            results.push({
              status: "error" as const,
              taskId,
              ...(data.workspaceId != null ? { workspaceId: data.workspaceId } : {}),
              ...(data.descendantTaskIds != null
                ? { descendantTaskIds: data.descendantTaskIds }
                : {}),
              error: data.error ?? "Task removal failed.",
            });
            break;
          default:
            results.push({
              status: "error" as const,
              taskId,
              error: `Task cannot be removed from lifecycle state ${data.status}.`,
            });
        }
      }

      return parseToolResult(TaskRemoveToolResultSchema, { results }, "task_remove");
    },
  });
};

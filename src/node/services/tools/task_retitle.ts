import { tool } from "ai";

import type { ToolConfiguration, ToolFactory } from "@/common/utils/tools/tools";
import {
  TaskRetitleToolResultSchema,
  TOOL_DEFINITIONS,
} from "@/common/utils/tools/toolDefinitions";

import { parseToolResult, requireTaskService, requireWorkspaceId } from "./toolUtils";

export const createTaskRetitleTool: ToolFactory = (config: ToolConfiguration) => {
  return tool({
    description: TOOL_DEFINITIONS.task_retitle.description,
    inputSchema: TOOL_DEFINITIONS.task_retitle.schema,
    execute: async (args): Promise<unknown> => {
      const workspaceId = requireWorkspaceId(config, "task_retitle");
      const taskService = requireTaskService(config, "task_retitle");
      const result = await taskService.retitleDescendantAgentTask(
        workspaceId,
        args.task_id,
        args.title
      );

      const toolResult = result.success
        ? {
            status: "retitled" as const,
            taskId: args.task_id,
            title: result.data.title,
          }
        : result.error.code === "not_found"
          ? { status: "not_found" as const, taskId: args.task_id }
          : result.error.code === "invalid_scope"
            ? { status: "invalid_scope" as const, taskId: args.task_id }
            : {
                status: "error" as const,
                taskId: args.task_id,
                error: result.error.message,
              };

      return parseToolResult(TaskRetitleToolResultSchema, toolResult, "task_retitle");
    },
  });
};

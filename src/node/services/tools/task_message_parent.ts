import { tool } from "ai";

import type { ToolConfiguration, ToolFactory } from "@/common/utils/tools/tools";
import {
  TaskMessageParentToolResultSchema,
  TOOL_DEFINITIONS,
} from "@/common/utils/tools/toolDefinitions";

import { parseToolResult, requireTaskService, requireWorkspaceId } from "./toolUtils";

/**
 * RLM family messaging: child -> parent. Only registered for sub-agent sessions whose
 * task record was stamped with the rlm experiment at spawn (see aiService gating).
 */
export const createTaskMessageParentTool: ToolFactory = (config: ToolConfiguration) => {
  return tool({
    description: TOOL_DEFINITIONS.task_message_parent.description,
    inputSchema: TOOL_DEFINITIONS.task_message_parent.schema,
    execute: async (args): Promise<unknown> => {
      const workspaceId = requireWorkspaceId(config, "task_message_parent");
      const taskService = requireTaskService(config, "task_message_parent");

      // Family messages default to tool-end dispatch so a busy parent picks them up at
      // its next tool boundary (matches task_send_message's default toward children).
      const result = await taskService.sendMessageToParentFromAgentTask(
        workspaceId,
        args.message,
        "tool-end"
      );

      const toolResult = result.success
        ? { status: "sent" as const, parentWorkspaceId: result.data.parentWorkspaceId }
        : result.error.code === "invalid_scope"
          ? { status: "invalid_scope" as const, error: result.error.message }
          : { status: "error" as const, error: result.error.message };

      return parseToolResult(TaskMessageParentToolResultSchema, toolResult, "task_message_parent");
    },
  });
};

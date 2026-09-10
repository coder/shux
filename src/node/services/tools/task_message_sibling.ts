import { tool } from "ai";

import type { ToolConfiguration, ToolFactory } from "@/common/utils/tools/tools";
import {
  TaskMessageSiblingToolResultSchema,
  TOOL_DEFINITIONS,
} from "@/common/utils/tools/toolDefinitions";

import { parseToolResult, requireTaskService, requireWorkspaceId } from "./toolUtils";

/**
 * RLM family messaging: sibling -> sibling (nuclear-family scope: the target must
 * share the sender's direct parent). Only registered for sub-agent sessions whose
 * task record was stamped with the rlm experiment at spawn (see aiService gating).
 */
export const createTaskMessageSiblingTool: ToolFactory = (config: ToolConfiguration) => {
  return tool({
    description: TOOL_DEFINITIONS.task_message_sibling.description,
    inputSchema: TOOL_DEFINITIONS.task_message_sibling.schema,
    execute: async (args): Promise<unknown> => {
      const workspaceId = requireWorkspaceId(config, "task_message_sibling");
      const taskService = requireTaskService(config, "task_message_sibling");

      // Family messages default to tool-end dispatch so a busy sibling picks them up
      // at its next tool boundary (matches task_send_message's default).
      const result = await taskService.sendMessageToSiblingAgentTask(
        workspaceId,
        args.task_id,
        args.message,
        "tool-end"
      );

      if (result.success) {
        return parseToolResult(
          TaskMessageSiblingToolResultSchema,
          result.data.delivery === "accepted"
            ? { status: "accepted", taskId: args.task_id }
            : result.data.delivery === "reactivated"
              ? { status: "reactivated", taskId: args.task_id }
              : {
                  status: "queued",
                  taskId: args.task_id,
                  ...(result.data.queueDispatchMode != null
                    ? { queueDispatchMode: result.data.queueDispatchMode }
                    : {}),
                },
          "task_message_sibling"
        );
      }

      const error = result.error;
      const toolResult =
        error.code === "not_found"
          ? { status: "not_found" as const, taskId: args.task_id }
          : error.code === "invalid_scope"
            ? { status: "invalid_scope" as const, taskId: args.task_id }
            : error.code === "not_active"
              ? {
                  status: "not_active" as const,
                  taskId: args.task_id,
                  taskStatus: error.taskStatus,
                  error: error.message ?? `Task is ${error.taskStatus} and cannot accept messages.`,
                }
              : { status: "error" as const, taskId: args.task_id, error: error.message };

      return parseToolResult(
        TaskMessageSiblingToolResultSchema,
        toolResult,
        "task_message_sibling"
      );
    },
  });
};

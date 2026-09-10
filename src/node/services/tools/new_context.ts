import { tool } from "ai";
import type { z } from "zod";
import { TOOL_DEFINITIONS } from "@/common/utils/tools/toolDefinitions";
import type { ToolConfiguration, ToolFactory } from "@/common/utils/tools/tools";

export type NewContextResult = z.infer<typeof TOOL_DEFINITIONS.new_context.resultSchema>;

/**
 * Model-requested context rollover. The tool itself is pure: its persisted successful result is
 * the durable request receipt. StreamManager reports it to AgentSession once every sibling tool
 * result of the step has settled (`SettledStepBudget.newContextRequested`), which schedules the
 * same rollover continuation the automatic token budget uses; on restart, AgentSession recovers
 * an unconsumed receipt from the current window's last completed assistant message.
 */
export const createNewContextTool: ToolFactory = (_config: ToolConfiguration) =>
  tool({
    description: TOOL_DEFINITIONS.new_context.description,
    inputSchema: TOOL_DEFINITIONS.new_context.schema,
    execute: (): Promise<NewContextResult> =>
      Promise.resolve({
        success: true,
        status: "scheduled",
        message:
          "A fresh context window starts after this tool step settles. Finish any notes now; completed tool results stay retrievable through session_history.",
      }),
  });

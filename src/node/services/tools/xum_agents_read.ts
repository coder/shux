import * as fsPromises from "fs/promises";
import { tool } from "ai";

import type { XumAgentsReadToolResult } from "@/common/types/tools";
import { getErrorMessage } from "@/common/utils/errors";
import { TOOL_DEFINITIONS } from "@/common/utils/tools/toolDefinitions";
import type { ToolConfiguration, ToolFactory } from "@/common/utils/tools/tools";
import { readFileString } from "@/node/utils/runtime/helpers";
import { resolveAgentsPathOnRuntime, resolveAgentsPathWithinRoot } from "./xum_agents_path";
import { resolveXumAgentsStorageContext } from "./xum_agents_storage_context";

export const createXumAgentsReadTool: ToolFactory = (config: ToolConfiguration) => {
  return tool({
    description: TOOL_DEFINITIONS.mux_agents_read.description,
    inputSchema: TOOL_DEFINITIONS.mux_agents_read.schema,
    execute: async (_args, { abortSignal: _abortSignal }): Promise<XumAgentsReadToolResult> => {
      try {
        const ctx = resolveXumAgentsStorageContext(config);

        if (ctx.kind === "project-runtime") {
          // Resolve with symlink containment — mirrors resolveAgentsPathWithinRoot for local paths.
          const resolved = await resolveAgentsPathOnRuntime(config.runtime, ctx.workspacePath);

          if (resolved.kind === "error") {
            return { success: false, error: resolved.error };
          }
          if (resolved.kind === "missing") {
            return { success: true, content: "" };
          }

          const content = await readFileString(config.runtime, resolved.realPath);
          return { success: true, content };
        }

        // Local path: global-local or project-local — existing containment/symlink logic.
        const resolved = await resolveAgentsPathWithinRoot(ctx.root);

        if (resolved.kind === "error") {
          return { success: false, error: resolved.error };
        }
        if (resolved.kind === "missing") {
          return { success: true, content: "" };
        }

        const content = await fsPromises.readFile(resolved.realPath, "utf-8");
        return { success: true, content };
      } catch (error) {
        const message = getErrorMessage(error);
        return {
          success: false,
          error: `Failed to read AGENTS.md: ${message}`,
        };
      }
    },
  });
};

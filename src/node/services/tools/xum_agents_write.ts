import * as fsPromises from "fs/promises";
import { tool } from "ai";

import {
  FILE_EDIT_DIFF_OMITTED_MESSAGE,
  type XumAgentsWriteToolArgs,
  type XumAgentsWriteToolResult,
} from "@/common/types/tools";
import { getErrorMessage } from "@/common/utils/errors";
import { TOOL_DEFINITIONS } from "@/common/utils/tools/toolDefinitions";
import type { ToolConfiguration, ToolFactory } from "@/common/utils/tools/tools";
import { readFileString, writeFileString } from "@/node/utils/runtime/helpers";
import { generateDiff } from "./fileCommon";
import { resolveAgentsPathOnRuntime, resolveAgentsPathWithinRoot } from "./xum_agents_path";
import { resolveXumAgentsStorageContext } from "./xum_agents_storage_context";

export const createXumAgentsWriteTool: ToolFactory = (config: ToolConfiguration) => {
  return tool({
    description: TOOL_DEFINITIONS.mux_agents_write.description,
    inputSchema: TOOL_DEFINITIONS.mux_agents_write.schema,
    execute: async (
      args: XumAgentsWriteToolArgs,
      { abortSignal: _abortSignal }
    ): Promise<XumAgentsWriteToolResult> => {
      try {
        if (!args.confirm) {
          return {
            success: false,
            error: "Refusing to write AGENTS.md without confirm: true",
          };
        }

        const ctx = resolveXumAgentsStorageContext(config);

        if (ctx.kind === "project-runtime") {
          // Resolve with symlink containment — mirrors resolveAgentsPathWithinRoot for local paths.
          const runtimeAgentsPath = config.runtime.normalizePath("AGENTS.md", ctx.workspacePath);
          const resolved = await resolveAgentsPathOnRuntime(config.runtime, ctx.workspacePath);

          if (resolved.kind === "error") {
            return { success: false, error: resolved.error };
          }

          let originalContent = "";
          if (resolved.kind === "existing") {
            try {
              originalContent = await readFileString(config.runtime, resolved.realPath);
            } catch {
              // Best-effort read for diff — proceed with empty original.
            }
          }

          const writePath = resolved.kind === "existing" ? resolved.realPath : runtimeAgentsPath;
          await writeFileString(config.runtime, writePath, args.newContent);

          const diff = generateDiff(writePath, originalContent, args.newContent);

          return {
            success: true,
            diff: FILE_EDIT_DIFF_OMITTED_MESSAGE,
            ui_only: {
              file_edit: {
                diff,
              },
            },
          };
        }

        // Local path: global-local or project-local — existing containment/symlink logic.
        const agentsRoot = ctx.root;
        // Only self-heal missing roots for mux-owned storage (global scope).
        // Project roots are user-managed; recreating a stale one would silently
        // mutate an unintended location.
        if (ctx.kind === "global-local") {
          await fsPromises.mkdir(agentsRoot, { recursive: true });
        }

        const resolved = await resolveAgentsPathWithinRoot(agentsRoot);

        if (resolved.kind === "error") {
          return { success: false, error: resolved.error };
        }

        let originalContent = "";
        let writePath: string;
        if (resolved.kind === "existing") {
          originalContent = await fsPromises.readFile(resolved.realPath, "utf-8");
          writePath = resolved.realPath;
        } else {
          writePath = resolved.writePath;
        }

        await fsPromises.writeFile(writePath, args.newContent, "utf-8");

        const diff = generateDiff(writePath, originalContent, args.newContent);

        return {
          success: true,
          diff: FILE_EDIT_DIFF_OMITTED_MESSAGE,
          ui_only: {
            file_edit: {
              diff,
            },
          },
        };
      } catch (error) {
        const message = getErrorMessage(error);
        return {
          success: false,
          error: `Failed to write AGENTS.md: ${message}`,
        };
      }
    },
  });
};

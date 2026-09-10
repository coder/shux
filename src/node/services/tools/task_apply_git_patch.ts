import { tool } from "ai";

import type { ToolConfiguration, ToolFactory } from "@/common/utils/tools/tools";
import { TOOL_DEFINITIONS } from "@/common/utils/tools/toolDefinitions";
import { taskGitPatchEngine } from "@/node/services/taskGitPatchEngine";

export const createTaskApplyGitPatchTool: ToolFactory = (config: ToolConfiguration) =>
  tool({
    description: TOOL_DEFINITIONS.task_apply_git_patch.description,
    inputSchema: TOOL_DEFINITIONS.task_apply_git_patch.schema,
    execute: async (args, { abortSignal }): Promise<unknown> => {
      const apply = () => taskGitPatchEngine.applyPatch(config, args, { abortSignal });
      return config.taskService == null
        ? await apply()
        : await config.taskService.withGitPatchArtifactOperationLock(args.task_id, apply);
    },
  });

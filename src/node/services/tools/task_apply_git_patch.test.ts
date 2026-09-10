import { expect, it, mock, spyOn } from "bun:test";

import type { ToolConfiguration } from "@/common/utils/tools/tools";
import { taskGitPatchEngine } from "@/node/services/taskGitPatchEngine";
import { createTaskApplyGitPatchTool } from "@/node/services/tools/task_apply_git_patch";
import { getTestDeps, mockToolCallOptions } from "@/node/services/tools/testHelpers";

const result = { success: true as const, taskId: "task_1", projectResults: [] };

it("locks and delegates task patch application", async () => {
  const applyPatch = spyOn(taskGitPatchEngine, "applyPatch").mockResolvedValue(result);
  const withGitPatchArtifactOperationLock = mock(
    async <T>(taskId: string, operation: () => Promise<T>): Promise<T> => {
      expect(taskId).toBe("task_1");
      return await operation();
    }
  );
  const config = {
    ...getTestDeps(),
    taskService: { withGitPatchArtifactOperationLock },
  } as unknown as ToolConfiguration;
  const tool = createTaskApplyGitPatchTool(config);

  try {
    expect(
      await tool.execute!({ task_id: "task_1", three_way: true }, mockToolCallOptions)
    ).toEqual(result);
    expect(withGitPatchArtifactOperationLock).toHaveBeenCalledTimes(1);
    expect(applyPatch).toHaveBeenCalledWith(
      config,
      { task_id: "task_1", three_way: true },
      { abortSignal: undefined }
    );
  } finally {
    applyPatch.mockRestore();
  }
});

it("delegates directly without a task service", async () => {
  const applyPatch = spyOn(taskGitPatchEngine, "applyPatch").mockResolvedValue(result);
  const config = getTestDeps() as unknown as ToolConfiguration;
  const tool = createTaskApplyGitPatchTool(config);

  try {
    expect(
      await tool.execute!({ task_id: "task_1", three_way: true }, mockToolCallOptions)
    ).toEqual(result);
    expect(applyPatch).toHaveBeenCalledTimes(1);
  } finally {
    applyPatch.mockRestore();
  }
});

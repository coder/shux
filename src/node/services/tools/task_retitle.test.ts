import { describe, expect, it, mock } from "bun:test";
import type { ToolExecutionOptions } from "ai";

import { Err, Ok, type Result } from "@/common/types/result";
import type {
  RetitleAgentTaskError,
  RetitleAgentTaskResult,
  TaskService,
} from "@/node/services/taskService";

import { createTaskRetitleTool } from "./task_retitle";
import { createTestToolConfig, TestTempDir } from "./testHelpers";

const toolCallOptions: ToolExecutionOptions<unknown> = {
  toolCallId: "task-retitle-call",
  messages: [],
  context: undefined,
};

describe("task_retitle tool", () => {
  it("retitles a persistent descendant through its stable task ID", async () => {
    using tempDir = new TestTempDir("task-retitle-success");
    const retitleDescendantAgentTask = mock(
      (): Promise<Result<RetitleAgentTaskResult, RetitleAgentTaskError>> =>
        Promise.resolve(Ok({ title: "Simplicity Auditor" }))
    );
    const taskService = { retitleDescendantAgentTask } as unknown as TaskService;
    const tool = createTaskRetitleTool({
      ...createTestToolConfig(tempDir.path, { workspaceId: "parent" }),
      taskService,
    });

    const result: unknown = await Promise.resolve(
      tool.execute!({ task_id: "child", title: "Simplicity Auditor" }, toolCallOptions)
    );

    expect(retitleDescendantAgentTask).toHaveBeenCalledWith(
      "parent",
      "child",
      "Simplicity Auditor"
    );
    expect(result).toEqual({
      status: "retitled",
      taskId: "child",
      title: "Simplicity Auditor",
    });
  });

  it("maps scope and update failures", async () => {
    using tempDir = new TestTempDir("task-retitle-errors");
    const outcomes: RetitleAgentTaskError[] = [
      { code: "not_found" },
      { code: "invalid_scope" },
      { code: "update_failed", message: "disk full" },
    ];
    const taskService = {
      retitleDescendantAgentTask: mock(
        (): Promise<Result<RetitleAgentTaskResult, RetitleAgentTaskError>> =>
          Promise.resolve(Err(outcomes.shift()!))
      ),
    } as unknown as TaskService;
    const tool = createTaskRetitleTool({
      ...createTestToolConfig(tempDir.path, { workspaceId: "parent" }),
      taskService,
    });

    expect(
      await Promise.resolve(
        tool.execute!({ task_id: "missing", title: "Reviewer" }, toolCallOptions)
      )
    ).toEqual({ status: "not_found", taskId: "missing" });
    expect(
      await Promise.resolve(
        tool.execute!({ task_id: "foreign", title: "Reviewer" }, toolCallOptions)
      )
    ).toEqual({ status: "invalid_scope", taskId: "foreign" });
    expect(
      await Promise.resolve(tool.execute!({ task_id: "child", title: "Reviewer" }, toolCallOptions))
    ).toEqual({ status: "error", taskId: "child", error: "disk full" });
  });
});

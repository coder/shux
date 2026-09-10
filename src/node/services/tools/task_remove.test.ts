import { describe, expect, it, mock } from "bun:test";
import type { ToolExecutionOptions } from "ai";

import { Ok, type Result } from "@/common/types/result";
import type { TaskService } from "@/node/services/taskService";
import { createTaskRemoveTool } from "./task_remove";
import { TestTempDir, createTestToolConfig } from "./testHelpers";

const toolOptions: ToolExecutionOptions<unknown> = {
  toolCallId: "test-call-id",
  messages: [],
  context: undefined,
};

describe("task_remove tool", () => {
  it("removes nested inactive children deepest-first", async () => {
    using tempDir = new TestTempDir("test-task-remove-order");
    const calls: string[] = [];
    const removeOwnedTaskWorkspace = mock(
      (_ownerWorkspaceId: string, taskId: string): Promise<Result<unknown, string>> => {
        calls.push(taskId);
        return Promise.resolve(
          Ok({ status: "removed", action: "remove", taskId, workspaceId: taskId })
        );
      }
    );
    const taskService = {
      listDescendantAgentTasks: mock(() => [
        { taskId: "parent", depth: 1 },
        { taskId: "child", depth: 2 },
      ]),
      removeInactiveDescendantAgentTask: removeOwnedTaskWorkspace,
    } as unknown as TaskService;
    const tool = createTaskRemoveTool({
      ...createTestToolConfig(tempDir.path, { workspaceId: "root" }),
      taskService,
    });

    const result: unknown = await Promise.resolve(
      tool.execute!({ task_ids: ["parent", "child"] }, toolOptions)
    );

    expect(calls).toEqual(["child", "parent"]);
    expect(result).toEqual({
      results: [
        { status: "removed", taskId: "child", workspaceId: "child" },
        { status: "removed", taskId: "parent", workspaceId: "parent" },
      ],
    });
  });

  it("surfaces active and scope outcomes without removing", async () => {
    using tempDir = new TestTempDir("test-task-remove-outcomes");
    const removeOwnedTaskWorkspace = mock(
      (_ownerWorkspaceId: string, taskId: string): Promise<Result<unknown, string>> =>
        Promise.resolve(
          Ok(
            taskId === "active"
              ? { status: "active", action: "remove", taskId: "active", workspaceId: "active" }
              : { status: "invalid_scope", action: "remove", taskId }
          )
        )
    );
    const taskService = {
      listDescendantAgentTasks: mock(() => []),
      removeInactiveDescendantAgentTask: removeOwnedTaskWorkspace,
    } as unknown as TaskService;
    const tool = createTaskRemoveTool({
      ...createTestToolConfig(tempDir.path, { workspaceId: "root" }),
      taskService,
    });

    expect(
      await Promise.resolve(tool.execute!({ task_ids: ["active", "foreign"] }, toolOptions))
    ).toEqual({
      results: [
        { status: "active", taskId: "active", workspaceId: "active" },
        { status: "invalid_scope", taskId: "foreign" },
      ],
    });
  });

  it("rejects plan-mode removal", () => {
    using tempDir = new TestTempDir("test-task-remove-plan");
    const tool = createTaskRemoveTool({
      ...createTestToolConfig(tempDir.path, { workspaceId: "root" }),
      planFileOnly: true,
      taskService: {} as unknown as TaskService,
    });

    expect(Promise.resolve(tool.execute!({ task_ids: ["child"] }, toolOptions))).rejects.toThrow(
      "task_remove is not available in plan mode"
    );
  });
});

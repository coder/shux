/* eslint-disable @typescript-eslint/no-unsafe-assignment -- expect.stringContaining returns `any` in bun:test types */
import { describe, it, expect, mock } from "bun:test";
import type { ToolExecutionOptions } from "ai";

import { createTaskStopTool } from "./task_stop";
import { TestTempDir, createTestToolConfig } from "./testHelpers";
import type { TaskService } from "@/node/services/taskService";
import { Err, Ok, type Result } from "@/common/types/result";

const mockToolCallOptions: ToolExecutionOptions<unknown> = {
  toolCallId: "test-call-id",
  messages: [],
  context: undefined,
};

describe("task_stop tool", () => {
  it("returns not_found when the task does not exist", async () => {
    using tempDir = new TestTempDir("test-task-terminate-not-found");
    const baseConfig = createTestToolConfig(tempDir.path, { workspaceId: "root-workspace" });

    const taskService = {
      listActiveDescendantAgentTaskIds: mock(() => ["child-task"]),
      stopDescendantAgentTask: mock(
        (): Promise<Result<{ stoppedTaskIds: string[] }, string>> =>
          Promise.resolve(Err("Task not found"))
      ),
    } as unknown as TaskService;

    const tool = createTaskStopTool({ ...baseConfig, taskService });

    const result: unknown = await Promise.resolve(
      tool.execute!({ task_ids: ["missing-task"] }, mockToolCallOptions)
    );

    expect(result).toEqual({
      results: [{ status: "not_found", taskId: "missing-task" }],
    });
  });

  it("returns invalid_scope when the task is outside the workspace scope", async () => {
    using tempDir = new TestTempDir("test-task-terminate-invalid-scope");
    const baseConfig = createTestToolConfig(tempDir.path, { workspaceId: "root-workspace" });

    const taskService = {
      listActiveDescendantAgentTaskIds: mock(() => ["child-task"]),
      stopDescendantAgentTask: mock(
        (): Promise<Result<{ stoppedTaskIds: string[] }, string>> =>
          Promise.resolve(Err("Task is not a descendant of this workspace"))
      ),
    } as unknown as TaskService;

    const tool = createTaskStopTool({ ...baseConfig, taskService });

    const result: unknown = await Promise.resolve(
      tool.execute!({ task_ids: ["other-task"] }, mockToolCallOptions)
    );

    expect(result).toEqual({
      results: [{ status: "invalid_scope", taskId: "other-task" }],
    });
  });

  it("reports aggregated cleanup failures as error, not invalid_scope", async () => {
    using tempDir = new TestTempDir("test-task-terminate-cleanup-error");
    const baseConfig = createTestToolConfig(tempDir.path, { workspaceId: "root-workspace" });
    const cleanupError =
      "Timed out stopping task stream (child-task); " +
      "Skipped removing task workspace (parent-task): a descendant task workspace was not removed";

    const taskService = {
      stopDescendantAgentTask: mock(
        (): Promise<Result<{ stoppedTaskIds: string[] }, string>> =>
          Promise.resolve(Err(cleanupError))
      ),
      listActiveDescendantAgentTaskIds: mock(() => []),
    } as unknown as TaskService;

    const tool = createTaskStopTool({ ...baseConfig, taskService });

    const result: unknown = await Promise.resolve(
      tool.execute!({ task_ids: ["parent-task"] }, mockToolCallOptions)
    );

    expect(result).toEqual({
      results: [{ status: "error", taskId: "parent-task", error: cleanupError }],
    });
  });

  it("returns terminated with stoppedTaskIds on success", async () => {
    using tempDir = new TestTempDir("test-task-terminate-ok");
    const baseConfig = createTestToolConfig(tempDir.path, { workspaceId: "root-workspace" });

    const taskService = {
      stopDescendantAgentTask: mock(
        (): Promise<Result<{ stoppedTaskIds: string[] }, string>> =>
          Promise.resolve(Ok({ stoppedTaskIds: ["child-task", "parent-task"] }))
      ),
    } as unknown as TaskService;

    const tool = createTaskStopTool({ ...baseConfig, taskService });

    const result: unknown = await Promise.resolve(
      tool.execute!({ task_ids: ["parent-task"] }, mockToolCallOptions)
    );

    expect(result).toEqual({
      results: [
        {
          status: "stopped",
          taskId: "parent-task",
          stoppedTaskIds: ["child-task", "parent-task"],
        },
      ],
    });
  });

  it("returns an interrupted error promptly while completed task IDs still resolve", async () => {
    using tempDir = new TestTempDir("test-task-terminate-abort");
    const baseConfig = createTestToolConfig(tempDir.path, { workspaceId: "root-workspace" });
    const controller = new AbortController();

    const taskService = {
      stopDescendantAgentTask: mock(
        (
          _workspaceId: string,
          taskId: string
        ): Promise<Result<{ stoppedTaskIds: string[] }, string>> => {
          if (taskId === "stuck-task") {
            return new Promise(() => undefined);
          }
          return Promise.resolve(Ok({ stoppedTaskIds: [taskId] }));
        }
      ),
    } as unknown as TaskService;
    const tool = createTaskStopTool({ ...baseConfig, taskService });

    const resultPromise = Promise.resolve(
      tool.execute!(
        { task_ids: ["stuck-task", "finished-task"] },
        { ...mockToolCallOptions, abortSignal: controller.signal }
      )
    );
    await Promise.resolve();
    await Promise.resolve();
    controller.abort();

    expect(await resultPromise).toEqual({
      results: [
        {
          status: "error",
          taskId: "stuck-task",
          error: "Termination interrupted; cleanup continues in the background",
        },
        {
          status: "stopped",
          taskId: "finished-task",
          stoppedTaskIds: ["finished-task"],
        },
      ],
    });
  });

  it("interrupts a workspace turn without deleting the workspace", async () => {
    using tempDir = new TestTempDir("test-task-terminate-workspace-turn");
    const baseConfig = createTestToolConfig(tempDir.path, { workspaceId: "root-workspace" });

    const interruptWorkspaceTurn = mock(
      (): Promise<Result<{ workspaceId: string }, string>> =>
        Promise.resolve(Ok({ workspaceId: "child-workspace" }))
    );
    const taskService = {
      interruptWorkspaceTurn,
      stopDescendantAgentTask: mock(() => {
        throw new Error("workspace turn IDs must not reach agent task termination");
      }),
    } as unknown as TaskService;

    const tool = createTaskStopTool({ ...baseConfig, taskService });

    const result: unknown = await Promise.resolve(
      tool.execute!({ task_ids: ["wst_turn"] }, mockToolCallOptions)
    );

    expect(interruptWorkspaceTurn).toHaveBeenCalledWith("root-workspace", "wst_turn");
    expect(result).toEqual({
      results: [
        {
          status: "stopped",
          taskId: "wst_turn",
          note: "Workspace turn stopped. The workspace is preserved for future messages.",
        },
      ],
    });
  });

  const buildWorkflowRun = (status: string) => ({
    id: "wfr_run_1",
    workspaceId: "root-workspace",
    workflow: {
      name: "deep-research",
      description: "Deep research",
      scope: "built-in" as const,
      executable: true,
    },
    source: "export default function workflow() { return null; }",
    sourceHash: "sha256:test",
    args: {},
    status,
    createdAt: "2026-05-29T00:00:00.000Z",
    updatedAt: "2026-05-29T00:00:01.000Z",
    events: [],
    steps: [],
  });

  it("interrupts a workflow run and reports it as resumable", async () => {
    using tempDir = new TestTempDir("test-task-terminate-workflow");
    const baseConfig = createTestToolConfig(tempDir.path, { workspaceId: "root-workspace" });

    const getRun = mock(() => Promise.resolve(buildWorkflowRun("running")));
    const interruptRun = mock(() => Promise.resolve(buildWorkflowRun("interrupted")));
    const taskService = {
      stopDescendantAgentTask: mock(() => {
        throw new Error("workflow IDs must not reach agent task termination");
      }),
    } as unknown as TaskService;

    const tool = createTaskStopTool({
      ...baseConfig,
      taskService,
      workflowService: {
        getRun,
        interruptRun,
      },
    });

    const result: unknown = await Promise.resolve(
      tool.execute!({ task_ids: ["wfr_run_1"] }, mockToolCallOptions)
    );

    expect(getRun).toHaveBeenCalledWith({ workspaceId: "root-workspace", runId: "wfr_run_1" });
    expect(interruptRun).toHaveBeenCalledWith({
      workspaceId: "root-workspace",
      runId: "wfr_run_1",
    });
    expect(result).toEqual({
      results: [
        {
          status: "stopped",
          taskId: "wfr_run_1",
          note: expect.stringContaining("workflow_resume"),
        },
      ],
    });
  });

  it("does not start termination when the signal is already aborted", async () => {
    using tempDir = new TestTempDir("test-task-terminate-preaborted");
    const baseConfig = createTestToolConfig(tempDir.path, { workspaceId: "root-workspace" });
    const controller = new AbortController();
    controller.abort();

    const stopDescendantAgentTask = mock(
      (): Promise<Result<{ stoppedTaskIds: string[] }, string>> =>
        Promise.resolve(Ok({ stoppedTaskIds: ["child-task"] }))
    );
    const tool = createTaskStopTool({
      ...baseConfig,
      taskService: { stopDescendantAgentTask } as unknown as TaskService,
    });

    const result: unknown = await Promise.resolve(
      tool.execute!(
        { task_ids: ["child-task"] },
        { ...mockToolCallOptions, abortSignal: controller.signal }
      )
    );

    expect(stopDescendantAgentTask).not.toHaveBeenCalled();
    expect(result).toEqual({
      results: [
        {
          status: "error",
          taskId: "child-task",
          error: "Termination interrupted before it started",
        },
      ],
    });
  });

  it("returns a per-task error when a workflow branch throws", async () => {
    using tempDir = new TestTempDir("test-task-terminate-workflow-throws");
    const baseConfig = createTestToolConfig(tempDir.path, { workspaceId: "root-workspace" });

    const tool = createTaskStopTool({
      ...baseConfig,
      taskService: {} as unknown as TaskService,
      workflowService: {
        getRun: mock(() => Promise.reject(new Error("workflow lookup failed"))),
        interruptRun: mock(() => Promise.reject(new Error("unused"))),
      },
    });

    const result: unknown = await Promise.resolve(
      tool.execute!({ task_ids: ["wfr_run_1"] }, mockToolCallOptions)
    );

    expect(result).toEqual({
      results: [{ status: "error", taskId: "wfr_run_1", error: "workflow lookup failed" }],
    });
  });

  it("treats interrupting an already-interrupted workflow run as idempotent success", async () => {
    using tempDir = new TestTempDir("test-task-terminate-workflow-idempotent");
    const baseConfig = createTestToolConfig(tempDir.path, { workspaceId: "root-workspace" });

    const interruptRun = mock(() => Promise.reject(new Error("must not re-interrupt")));
    const tool = createTaskStopTool({
      ...baseConfig,
      taskService: {} as unknown as TaskService,
      workflowService: {
        getRun: mock(() => Promise.resolve(buildWorkflowRun("interrupted"))),
        interruptRun,
      },
    });

    const result: unknown = await Promise.resolve(
      tool.execute!({ task_ids: ["wfr_run_1"] }, mockToolCallOptions)
    );

    expect(interruptRun).not.toHaveBeenCalled();
    expect(result).toEqual({
      results: [
        {
          status: "already_inactive",
          taskId: "wfr_run_1",
        },
      ],
    });
  });

  it("rejects interrupting terminal workflow runs", async () => {
    using tempDir = new TestTempDir("test-task-terminate-workflow-terminal");
    const baseConfig = createTestToolConfig(tempDir.path, { workspaceId: "root-workspace" });

    const interruptRun = mock(() => Promise.reject(new Error("must not interrupt terminal runs")));
    const tool = createTaskStopTool({
      ...baseConfig,
      taskService: {} as unknown as TaskService,
      workflowService: {
        getRun: mock(() => Promise.resolve(buildWorkflowRun("completed"))),
        interruptRun,
      },
    });

    const result: unknown = await Promise.resolve(
      tool.execute!({ task_ids: ["wfr_run_1"] }, mockToolCallOptions)
    );

    expect(interruptRun).not.toHaveBeenCalled();
    expect(result).toEqual({
      results: [
        {
          status: "error",
          taskId: "wfr_run_1",
          error: expect.stringContaining("already completed"),
        },
      ],
    });
  });

  it("reports workflow runs outside this workspace as not found", async () => {
    using tempDir = new TestTempDir("test-task-terminate-workflow-not-found");
    const baseConfig = createTestToolConfig(tempDir.path, { workspaceId: "root-workspace" });

    const tool = createTaskStopTool({
      ...baseConfig,
      taskService: {} as unknown as TaskService,
      workflowService: {
        getRun: mock(() => Promise.resolve(null)),
        interruptRun: mock(() => Promise.reject(new Error("unused"))),
      },
    });

    const result: unknown = await Promise.resolve(
      tool.execute!({ task_ids: ["wfr_other_workspace"] }, mockToolCallOptions)
    );

    expect(result).toEqual({
      results: [{ status: "not_found", taskId: "wfr_other_workspace" }],
    });
  });

  it("errors when workflow interrupts are requested without workflow support", async () => {
    using tempDir = new TestTempDir("test-task-terminate-workflow-no-service");
    const baseConfig = createTestToolConfig(tempDir.path, { workspaceId: "root-workspace" });

    const tool = createTaskStopTool({
      ...baseConfig,
      taskService: {} as unknown as TaskService,
    });

    const result: unknown = await Promise.resolve(
      tool.execute!({ task_ids: ["wfr_run_1"] }, mockToolCallOptions)
    );

    expect(result).toEqual({
      results: [
        {
          status: "error",
          taskId: "wfr_run_1",
          error: expect.stringContaining("Workflow service not available"),
        },
      ],
    });
  });
});

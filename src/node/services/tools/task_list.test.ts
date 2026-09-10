import * as path from "node:path";

import { describe, it, expect, mock } from "bun:test";
import type { ToolExecutionOptions } from "ai";

import { createTaskListTool } from "./task_list";
import { TestTempDir, createTestToolConfig } from "./testHelpers";
import { Config, type Workspace } from "@/node/config";
import type { TaskService } from "@/node/services/taskService";
import type { AgentTaskStatus } from "@/node/services/taskWorkspaceSeam";
import type { BackgroundProcessManager } from "@/node/services/backgroundProcessManager";
import type {
  WorkspaceTurnTaskHandleRecord,
  WorkspaceTurnTaskStatus,
} from "@/node/services/taskHandleStore";

const mockToolCallOptions: ToolExecutionOptions<unknown> = {
  toolCallId: "test-call-id",
  messages: [],
  context: undefined,
};

interface WorkspaceFixtureOptions {
  parentWorkspaceId?: string;
  archivedAt?: string;
  unarchivedAt?: string;
}

function buildWorkspace(
  tempDir: string,
  id: string,
  options: WorkspaceFixtureOptions = {}
): Workspace {
  return {
    id,
    path: path.join(tempDir, id),
    parentWorkspaceId: options.parentWorkspaceId,
    archivedAt: options.archivedAt,
    unarchivedAt: options.unarchivedAt,
  };
}

async function writeWorkspaceConfig(tempDir: string, workspaces: Workspace[]): Promise<void> {
  const config = new Config(tempDir);
  const cfg = config.loadConfigOrDefault();
  cfg.projects.set(path.join(tempDir, "project"), { workspaces });
  await config.editConfig(() => cfg);
}

function buildAgentTask(
  taskId: string,
  status: AgentTaskStatus,
  parentWorkspaceId = "root-workspace",
  depth = 1
) {
  return {
    taskId,
    status,
    parentWorkspaceId,
    agentType: "exec",
    workspaceName: taskId,
    title: taskId,
    createdAt: "2026-06-23T00:00:00.000Z",
    depth,
  };
}

function buildWorkspaceTurn(
  handleId: string,
  workspaceId: string,
  status: WorkspaceTurnTaskStatus
): WorkspaceTurnTaskHandleRecord {
  return {
    kind: "workspace_turn",
    handleId,
    ownerWorkspaceId: "root-workspace",
    workspaceId,
    turnId: `${handleId}-turn`,
    status,
    createdAt: "2026-06-23T00:00:00.000Z",
    updatedAt: "2026-06-23T00:00:01.000Z",
    createdWorkspace: true,
    disposableWorkspace: false,
    title: handleId,
  };
}

function taskIds(result: unknown): string[] {
  const parsed = result as { tasks: Array<{ taskId: string }> };
  return parsed.tasks.map((task) => task.taskId);
}

describe("task_list tool", () => {
  it("uses default statuses when none are provided", async () => {
    using tempDir = new TestTempDir("test-task-list-default-statuses");
    const baseConfig = createTestToolConfig(tempDir.path, { workspaceId: "root-workspace" });

    const listDescendantAgentTasks = mock(() => []);
    const taskService = { listDescendantAgentTasks } as unknown as TaskService;

    const tool = createTaskListTool({ ...baseConfig, taskService });

    const result: unknown = await Promise.resolve(tool.execute!({}, mockToolCallOptions));

    expect(result).toEqual({ tasks: [] });
    expect(listDescendantAgentTasks).toHaveBeenCalledWith("root-workspace", {
      excludeWorkflowTasks: true,
    });
  });

  it("passes through provided statuses", async () => {
    using tempDir = new TestTempDir("test-task-list-statuses");
    const baseConfig = createTestToolConfig(tempDir.path, { workspaceId: "root-workspace" });

    const listDescendantAgentTasks = mock(() => []);
    const taskService = { listDescendantAgentTasks } as unknown as TaskService;

    const tool = createTaskListTool({ ...baseConfig, taskService });

    const result: unknown = await Promise.resolve(
      tool.execute!({ statuses: ["running"] }, mockToolCallOptions)
    );

    expect(result).toEqual({ tasks: [] });
    expect(listDescendantAgentTasks).toHaveBeenCalledWith("root-workspace", {
      excludeWorkflowTasks: true,
    });
  });

  it("returns tasks with metadata", async () => {
    using tempDir = new TestTempDir("test-task-list-ok");
    const baseConfig = createTestToolConfig(tempDir.path, { workspaceId: "root-workspace" });

    const listDescendantAgentTasks = mock(() => [
      {
        taskId: "task-1",
        status: "running",
        parentWorkspaceId: "root-workspace",
        agentType: "exec",
        workspaceName: "agent_exec_task-1",
        title: "t",
        createdAt: "2025-01-01T00:00:00.000Z",
        modelString: "anthropic:claude-haiku-4-5",
        thinkingLevel: "low",
        bestOf: { groupId: "task-group:root-workspace:test-call", index: 0, total: 2 },
        depth: 1,
      },
    ]);
    const taskService = { listDescendantAgentTasks } as unknown as TaskService;

    const tool = createTaskListTool({ ...baseConfig, taskService });

    const result: unknown = await Promise.resolve(tool.execute!({}, mockToolCallOptions));

    expect(result).toEqual({
      tasks: [
        {
          taskId: "task-1",
          status: "running",
          parentWorkspaceId: "root-workspace",
          agentType: "exec",
          workspaceName: "agent_exec_task-1",
          title: "t",
          createdAt: "2025-01-01T00:00:00.000Z",
          modelString: "anthropic:claude-haiku-4-5",
          thinkingLevel: "low",
          bestOf: { groupId: "task-group:root-workspace:test-call", index: 0, total: 2 },
          depth: 1,
        },
      ],
    });
  });

  it("guides bounded retention when listed user-owned children are inactive", async () => {
    using tempDir = new TestTempDir("test-task-list-inactive-retention-note");
    const baseConfig = createTestToolConfig(tempDir.path, { workspaceId: "root-workspace" });
    const listDescendantAgentTasks = mock(() => [
      buildAgentTask("reviewer", "reported"),
      buildAgentTask("tooling-mapper", "interrupted"),
    ]);
    const taskService = { listDescendantAgentTasks } as unknown as TaskService;
    const tool = createTaskListTool({ ...baseConfig, taskService });

    const result = (await Promise.resolve(
      tool.execute!({ statuses: ["reported", "interrupted"] }, mockToolCallOptions)
    )) as { tasks: unknown[]; note?: string };

    expect(result.tasks).toHaveLength(2);
    expect(result.note).toContain("task_retitle");
    expect(result.note).toContain("task_remove");
    expect(result.note).toContain("ask them to finalize");
  });

  it("hides archived non-actionable descendant agent tasks by default", async () => {
    using tempDir = new TestTempDir("test-task-list-agent-archive-filter");
    await writeWorkspaceConfig(tempDir.path, [
      buildWorkspace(tempDir.path, "root-workspace", {
        archivedAt: "2026-06-23T00:00:00.000Z",
      }),
      buildWorkspace(tempDir.path, "archived-reported", {
        parentWorkspaceId: "root-workspace",
        archivedAt: "2026-06-23T00:01:00.000Z",
      }),
      buildWorkspace(tempDir.path, "archived-running", {
        parentWorkspaceId: "root-workspace",
        archivedAt: "2026-06-23T00:02:00.000Z",
      }),
      buildWorkspace(tempDir.path, "archived-interrupted", {
        parentWorkspaceId: "root-workspace",
        archivedAt: "2026-06-23T00:03:00.000Z",
      }),
      buildWorkspace(tempDir.path, "archived-parent", {
        parentWorkspaceId: "root-workspace",
        archivedAt: "2026-06-23T00:04:00.000Z",
      }),
      buildWorkspace(tempDir.path, "ancestor-archived-child", {
        parentWorkspaceId: "archived-parent",
      }),
      buildWorkspace(tempDir.path, "open-reported", {
        parentWorkspaceId: "root-workspace",
      }),
      buildWorkspace(tempDir.path, "unarchived-reported", {
        parentWorkspaceId: "root-workspace",
        archivedAt: "2026-06-23T00:05:00.000Z",
        unarchivedAt: "2026-06-23T00:06:00.000Z",
      }),
    ]);
    const baseConfig = createTestToolConfig(tempDir.path, { workspaceId: "root-workspace" });

    const listDescendantAgentTasks = mock(() => [
      buildAgentTask("archived-reported", "reported"),
      buildAgentTask("archived-running", "running"),
      buildAgentTask("archived-interrupted", "interrupted"),
      buildAgentTask("ancestor-archived-child", "reported", "archived-parent", 2),
      buildAgentTask("open-reported", "reported"),
      buildAgentTask("unarchived-reported", "reported"),
      buildAgentTask("missing-reported", "reported"),
    ]);
    const taskService = { listDescendantAgentTasks } as unknown as TaskService;
    const tool = createTaskListTool({ ...baseConfig, taskService });

    const result: unknown = await Promise.resolve(
      tool.execute!({ statuses: ["reported", "running", "interrupted"] }, mockToolCallOptions)
    );

    expect(taskIds(result)).toEqual([
      "archived-reported",
      "archived-running",
      "archived-interrupted",
      "ancestor-archived-child",
      "open-reported",
      "unarchived-reported",
      "missing-reported",
    ]);
  });

  it("includes archived descendant agent tasks when requested", async () => {
    using tempDir = new TestTempDir("test-task-list-agent-archive-include");
    await writeWorkspaceConfig(tempDir.path, [
      buildWorkspace(tempDir.path, "root-workspace"),
      buildWorkspace(tempDir.path, "archived-reported", {
        parentWorkspaceId: "root-workspace",
        archivedAt: "2026-06-23T00:01:00.000Z",
      }),
      buildWorkspace(tempDir.path, "archived-parent", {
        parentWorkspaceId: "root-workspace",
        archivedAt: "2026-06-23T00:02:00.000Z",
      }),
      buildWorkspace(tempDir.path, "ancestor-archived-child", {
        parentWorkspaceId: "archived-parent",
      }),
      buildWorkspace(tempDir.path, "open-reported", {
        parentWorkspaceId: "root-workspace",
      }),
    ]);
    const baseConfig = createTestToolConfig(tempDir.path, { workspaceId: "root-workspace" });
    const listDescendantAgentTasks = mock(() => [
      buildAgentTask("archived-reported", "reported"),
      buildAgentTask("ancestor-archived-child", "reported", "archived-parent", 2),
      buildAgentTask("open-reported", "reported"),
    ]);
    const taskService = { listDescendantAgentTasks } as unknown as TaskService;
    const tool = createTaskListTool({ ...baseConfig, taskService });

    const defaultResult: unknown = await Promise.resolve(
      tool.execute!({ statuses: ["reported"], includeArchived: null }, mockToolCallOptions)
    );
    const includeArchivedResult: unknown = await Promise.resolve(
      tool.execute!({ statuses: ["reported"], includeArchived: true }, mockToolCallOptions)
    );

    expect(taskIds(defaultResult)).toEqual([
      "archived-reported",
      "ancestor-archived-child",
      "open-reported",
    ]);
    expect(taskIds(includeArchivedResult)).toEqual([
      "archived-reported",
      "ancestor-archived-child",
      "open-reported",
    ]);
  });

  it("overlays a reawakened execution onto the stable child task row", async () => {
    using tempDir = new TestTempDir("test-task-list-reactivated-child");
    const baseConfig = createTestToolConfig(tempDir.path, { workspaceId: "root-workspace" });
    const taskService = {
      listDescendantAgentTasks: mock(() => [
        {
          taskId: "child-agent",
          status: "reported" as const,
          parentWorkspaceId: "parent-agent",
          title: "React lifecycle expert",
          executionTaskId: "wst_internal",
          executionStatus: "running" as const,
          depth: 2,
        },
      ]),
      getDescendantAgentTaskExecutionSnapshot: mock(() =>
        Promise.resolve({
          ownerWorkspaceId: "parent-agent",
          record: {
            kind: "workspace_turn" as const,
            handleId: "wst_internal",
            ownerWorkspaceId: "parent-agent",
            workspaceId: "child-agent",
            turnId: "turn",
            status: "running" as const,
            createdAt: "2026-08-10T00:00:00.000Z",
            updatedAt: "2026-08-10T00:00:00.000Z",
            createdWorkspace: false,
            disposableWorkspace: false,
          },
        })
      ),
      listWorkspaceTurnTasks: mock(() => Promise.resolve([])),
    } as unknown as TaskService;
    const tool = createTaskListTool({ ...baseConfig, taskService });

    expect(
      await Promise.resolve(tool.execute!({ statuses: ["running"] }, mockToolCallOptions))
    ).toEqual({
      tasks: [
        {
          taskId: "child-agent",
          status: "running",
          parentWorkspaceId: "parent-agent",
          title: "React lifecycle expert",
          depth: 2,
        },
      ],
    });
  });

  it("maps terminal continuation outcomes onto stable child rows", async () => {
    using tempDir = new TestTempDir("test-task-list-terminal-continuation-status");
    const baseConfig = createTestToolConfig(tempDir.path, { workspaceId: "root-workspace" });
    const taskService = {
      listDescendantAgentTasks: mock(() => [
        {
          taskId: "failed-child",
          status: "reported" as const,
          parentWorkspaceId: "root-workspace",
          executionTaskId: "wst_failed",
          executionStatus: "error" as const,
          depth: 1,
        },
        {
          taskId: "interrupted-child",
          status: "reported" as const,
          parentWorkspaceId: "root-workspace",
          executionTaskId: "wst_interrupted",
          executionStatus: "interrupted" as const,
          depth: 1,
        },
      ]),
      getDescendantAgentTaskExecutionSnapshot: mock(
        (_ancestorWorkspaceId: string, taskId: string) =>
          Promise.resolve({
            ownerWorkspaceId: "root-workspace",
            record: {
              status: taskId === "failed-child" ? ("error" as const) : ("interrupted" as const),
            },
          })
      ),
      listWorkspaceTurnTasks: mock(() => Promise.resolve([])),
    } as unknown as TaskService;
    const tool = createTaskListTool({ ...baseConfig, taskService });

    const result = (await Promise.resolve(
      tool.execute!({ statuses: ["failed", "interrupted"] }, mockToolCallOptions)
    )) as { tasks: unknown[]; note?: string };

    expect(result.note).toContain("task_remove");
    expect(result.tasks).toEqual([
      {
        taskId: "failed-child",
        status: "failed",
        parentWorkspaceId: "root-workspace",
        depth: 1,
      },
      {
        taskId: "interrupted-child",
        status: "interrupted",
        parentWorkspaceId: "root-workspace",
        depth: 1,
      },
    ]);
  });

  it("never exposes settled continuation handles for descendant agent workspaces", async () => {
    using tempDir = new TestTempDir("test-task-list-hidden-continuation-handles");
    const baseConfig = createTestToolConfig(tempDir.path, { workspaceId: "root-workspace" });
    const listDescendantAgentTasks = mock(() => [
      {
        taskId: "child-agent",
        status: "reported" as const,
        parentWorkspaceId: "root-workspace",
        title: "React lifecycle expert",
        executionTaskId: "wst_current",
        depth: 1,
      },
    ]);
    const listWorkspaceTurnTasks = mock(() =>
      Promise.resolve([
        {
          kind: "workspace_turn" as const,
          handleId: "wst_previous",
          ownerWorkspaceId: "root-workspace",
          workspaceId: "child-agent",
          turnId: "turn-previous",
          status: "completed" as const,
          createdAt: "2026-08-09T00:00:00.000Z",
          updatedAt: "2026-08-09T00:00:01.000Z",
          createdWorkspace: false,
          disposableWorkspace: false,
        },
        {
          kind: "workspace_turn" as const,
          handleId: "wst_current",
          ownerWorkspaceId: "root-workspace",
          workspaceId: "child-agent",
          turnId: "turn-current",
          status: "completed" as const,
          createdAt: "2026-08-10T00:00:00.000Z",
          updatedAt: "2026-08-10T00:00:01.000Z",
          createdWorkspace: false,
          disposableWorkspace: false,
        },
      ])
    );
    const taskService = {
      listDescendantAgentTasks,
      isDescendantAgentTask: mock((_ancestorWorkspaceId: string, candidateWorkspaceId: string) =>
        Promise.resolve(candidateWorkspaceId === "child-agent")
      ),
      listWorkspaceTurnTasks,
    } as unknown as TaskService;
    const tool = createTaskListTool({ ...baseConfig, taskService });

    expect(
      await Promise.resolve(tool.execute!({ statuses: ["completed"] }, mockToolCallOptions))
    ).toEqual({ tasks: [] });
  });

  it("lists workspace-turn handles with workspace metadata", async () => {
    using tempDir = new TestTempDir("test-task-list-workspace-turns");
    const baseConfig = createTestToolConfig(tempDir.path, { workspaceId: "root-workspace" });

    const listDescendantAgentTasks = mock(() => []);
    const listWorkspaceTurnTasks = mock(() => [
      {
        kind: "workspace_turn" as const,
        handleId: "wst_turn",
        ownerWorkspaceId: "root-workspace",
        workspaceId: "child-workspace",
        turnId: "turn-1",
        status: "running" as const,
        createdAt: "2026-06-19T00:00:00.000Z",
        updatedAt: "2026-06-19T00:00:01.000Z",
        createdWorkspace: true,
        disposableWorkspace: false,
        title: "Summary",
      },
    ]);
    const taskService = {
      listDescendantAgentTasks,
      listWorkspaceTurnTasks,
    } as unknown as TaskService;

    const tool = createTaskListTool({ ...baseConfig, taskService });

    const result: unknown = await Promise.resolve(
      tool.execute!({ statuses: ["running"] }, mockToolCallOptions)
    );

    expect(listWorkspaceTurnTasks).toHaveBeenCalledWith("root-workspace", {
      statuses: ["running"],
    });
    expect(result).toEqual({
      tasks: [
        {
          taskId: "wst_turn",
          status: "running",
          parentWorkspaceId: "root-workspace",
          handleKind: "workspace_turn",
          workspaceId: "child-workspace",
          title: "Summary",
          createdAt: "2026-06-19T00:00:00.000Z",
          depth: 1,
        },
      ],
    });
  });

  it("hides archived non-actionable workspace-turn tasks by default", async () => {
    using tempDir = new TestTempDir("test-task-list-workspace-turn-archive-filter");
    await writeWorkspaceConfig(tempDir.path, [
      buildWorkspace(tempDir.path, "root-workspace"),
      buildWorkspace(tempDir.path, "archived-turn-workspace", {
        parentWorkspaceId: "root-workspace",
        archivedAt: "2026-06-23T00:01:00.000Z",
      }),
      buildWorkspace(tempDir.path, "archived-running-workspace", {
        parentWorkspaceId: "root-workspace",
        archivedAt: "2026-06-23T00:02:00.000Z",
      }),
      buildWorkspace(tempDir.path, "archived-turn-parent", {
        parentWorkspaceId: "root-workspace",
        archivedAt: "2026-06-23T00:03:00.000Z",
      }),
      buildWorkspace(tempDir.path, "ancestor-archived-turn-workspace", {
        parentWorkspaceId: "archived-turn-parent",
      }),
      buildWorkspace(tempDir.path, "open-turn-workspace", {
        parentWorkspaceId: "root-workspace",
      }),
    ]);
    const baseConfig = createTestToolConfig(tempDir.path, { workspaceId: "root-workspace" });

    const listDescendantAgentTasks = mock(() => []);
    const listWorkspaceTurnTasks = mock(() => [
      buildWorkspaceTurn("turn-archived-completed", "archived-turn-workspace", "completed"),
      buildWorkspaceTurn("turn-archived-running", "archived-running-workspace", "running"),
      buildWorkspaceTurn("turn-ancestor-error", "ancestor-archived-turn-workspace", "error"),
      buildWorkspaceTurn("turn-open-completed", "open-turn-workspace", "completed"),
      buildWorkspaceTurn("turn-missing-completed", "missing-turn-workspace", "completed"),
    ]);
    const taskService = {
      listDescendantAgentTasks,
      listWorkspaceTurnTasks,
    } as unknown as TaskService;
    const tool = createTaskListTool({ ...baseConfig, taskService });

    const result: unknown = await Promise.resolve(
      tool.execute!({ statuses: ["completed", "failed", "running"] }, mockToolCallOptions)
    );

    expect(listWorkspaceTurnTasks).toHaveBeenCalledWith("root-workspace", {
      statuses: ["completed", "error", "running"],
    });
    expect(taskIds(result)).toEqual([
      "turn-archived-running",
      "turn-open-completed",
      "turn-missing-completed",
    ]);
  });

  it("includes archived workspace-turn tasks when requested", async () => {
    using tempDir = new TestTempDir("test-task-list-workspace-turn-archive-include");
    await writeWorkspaceConfig(tempDir.path, [
      buildWorkspace(tempDir.path, "root-workspace"),
      buildWorkspace(tempDir.path, "archived-turn-workspace", {
        parentWorkspaceId: "root-workspace",
        archivedAt: "2026-06-23T00:01:00.000Z",
      }),
      buildWorkspace(tempDir.path, "archived-turn-parent", {
        parentWorkspaceId: "root-workspace",
        archivedAt: "2026-06-23T00:02:00.000Z",
      }),
      buildWorkspace(tempDir.path, "ancestor-archived-turn-workspace", {
        parentWorkspaceId: "archived-turn-parent",
      }),
      buildWorkspace(tempDir.path, "open-turn-workspace", {
        parentWorkspaceId: "root-workspace",
      }),
    ]);
    const baseConfig = createTestToolConfig(tempDir.path, { workspaceId: "root-workspace" });
    const listDescendantAgentTasks = mock(() => []);
    const listWorkspaceTurnTasks = mock(() => [
      buildWorkspaceTurn("turn-archived-completed", "archived-turn-workspace", "completed"),
      buildWorkspaceTurn("turn-ancestor-error", "ancestor-archived-turn-workspace", "error"),
      buildWorkspaceTurn("turn-open-completed", "open-turn-workspace", "completed"),
    ]);
    const taskService = {
      listDescendantAgentTasks,
      listWorkspaceTurnTasks,
    } as unknown as TaskService;
    const tool = createTaskListTool({ ...baseConfig, taskService });

    const defaultResult: unknown = await Promise.resolve(
      tool.execute!({ statuses: ["completed", "failed"] }, mockToolCallOptions)
    );
    const includeArchivedResult: unknown = await Promise.resolve(
      tool.execute!(
        { statuses: ["completed", "failed"], includeArchived: true },
        mockToolCallOptions
      )
    );

    expect(taskIds(defaultResult)).toEqual(["turn-open-completed"]);
    expect(taskIds(includeArchivedResult)).toEqual([
      "turn-archived-completed",
      "turn-ancestor-error",
      "turn-open-completed",
    ]);
  });

  it("hides archived non-running background bash tasks by default", async () => {
    using tempDir = new TestTempDir("test-task-list-background-archive-filter");
    await writeWorkspaceConfig(tempDir.path, [
      buildWorkspace(tempDir.path, "root-workspace"),
      buildWorkspace(tempDir.path, "archived-bash-workspace", {
        parentWorkspaceId: "root-workspace",
        archivedAt: "2026-06-23T00:01:00.000Z",
      }),
      buildWorkspace(tempDir.path, "open-bash-workspace", {
        parentWorkspaceId: "root-workspace",
      }),
    ]);
    const baseConfig = createTestToolConfig(tempDir.path, { workspaceId: "root-workspace" });
    const listDescendantAgentTasks = mock(() => [
      buildAgentTask("archived-bash-workspace", "running"),
      buildAgentTask("open-bash-workspace", "running"),
    ]);
    const isDescendantAgentTask = mock((_root: string, candidate: string) =>
      ["archived-bash-workspace", "open-bash-workspace"].includes(candidate)
    );
    const isWorkflowOwnedDescendantAgentTask = mock(() => false);
    const taskService = {
      listDescendantAgentTasks,
      isDescendantAgentTask,
      isWorkflowOwnedDescendantAgentTask,
    } as unknown as TaskService;
    const backgroundProcessManager = {
      list: mock(() =>
        Promise.resolve([
          {
            id: "archived-exited-proc",
            workspaceId: "archived-bash-workspace",
            status: "exited" as const,
            startTime: 1,
          },
          {
            id: "archived-running-proc",
            workspaceId: "archived-bash-workspace",
            status: "running" as const,
            startTime: 2,
          },
          {
            id: "open-exited-proc",
            workspaceId: "open-bash-workspace",
            status: "exited" as const,
            startTime: 3,
          },
        ])
      ),
    } as unknown as BackgroundProcessManager;
    const tool = createTaskListTool({
      ...baseConfig,
      taskService,
      backgroundProcessManager,
    });

    const defaultResult: unknown = await Promise.resolve(
      tool.execute!({ statuses: ["running", "reported"] }, mockToolCallOptions)
    );
    const includeArchivedResult: unknown = await Promise.resolve(
      tool.execute!(
        { statuses: ["running", "reported"], includeArchived: true },
        mockToolCallOptions
      )
    );

    expect(taskIds(defaultResult)).toEqual([
      "archived-bash-workspace",
      "open-bash-workspace",
      "bash:archived-running-proc",
      "bash:open-exited-proc",
    ]);
    expect(taskIds(includeArchivedResult)).toEqual([
      "archived-bash-workspace",
      "open-bash-workspace",
      "bash:archived-exited-proc",
      "bash:archived-running-proc",
      "bash:open-exited-proc",
    ]);
  });

  const buildWorkflowRun = (id: string, status: string) => ({
    id,
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

  it("includes workflow runs with their native statuses", async () => {
    using tempDir = new TestTempDir("test-task-list-workflows");
    const baseConfig = createTestToolConfig(tempDir.path, { workspaceId: "root-workspace" });

    const listDescendantAgentTasks = mock(() => []);
    const taskService = { listDescendantAgentTasks } as unknown as TaskService;
    const activeRun = {
      ...buildWorkflowRun("wfr_active", "backgrounded"),
      events: [
        {
          sequence: 1,
          type: "phase" as const,
          at: "2026-05-29T00:00:01.000Z",
          name: "verify",
          details: { claimCount: 2 },
        },
        {
          sequence: 2,
          type: "task" as const,
          at: "2026-05-29T00:00:02.000Z",
          stepId: "verify-1",
          taskId: "child-task-id",
          title: "Verify claim 1",
          status: "started",
        },
      ],
      steps: [
        {
          stepId: "verify-1",
          inputHash: "sha256:verify-1",
          status: "started" as const,
          taskId: "child-task-id",
          startedAt: "2026-05-29T00:00:02.000Z",
        },
      ],
    };
    const listRuns = mock(() =>
      Promise.resolve([
        activeRun,
        // Terminal/interrupted runs are excluded by the default (active) status filter.
        buildWorkflowRun("wfr_done", "completed"),
        buildWorkflowRun("wfr_stopped", "interrupted"),
      ])
    );

    const tool = createTaskListTool({
      ...baseConfig,
      taskService,
      workflowService: {
        listRuns,
      },
    });

    const result: unknown = await Promise.resolve(
      tool.execute!({ includeArchived: false }, mockToolCallOptions)
    );

    expect(listRuns).toHaveBeenCalledWith({ workspaceId: "root-workspace" });
    expect(result).toEqual({
      tasks: [
        {
          taskId: "wfr_active",
          status: "backgrounded",
          parentWorkspaceId: "root-workspace",
          title: "deep-research",
          createdAt: "2026-05-29T00:00:00.000Z",
          workflowProgress: {
            name: "deep-research",
            latestPhase: {
              name: "verify",
              at: "2026-05-29T00:00:01.000Z",
            },
            lastProgressAt: "2026-05-29T00:00:02.000Z",
            stepCounts: { started: 1, completed: 0, failed: 0, interrupted: 0 },
          },
          depth: 1,
        },
      ],
    });
    expect(JSON.stringify(result)).not.toContain("child-task-id");
    expect(JSON.stringify(result)).not.toContain("claimCount");
  });

  it("reports agent reservation events as workflow progress before a child task exists", async () => {
    using tempDir = new TestTempDir("test-task-list-workflow-agent-reservation-progress");
    const baseConfig = createTestToolConfig(tempDir.path, { workspaceId: "root-workspace" });

    const taskService = {
      listDescendantAgentTasks: mock(() => []),
    } as unknown as TaskService;
    const listRuns = mock(() =>
      Promise.resolve([
        {
          ...buildWorkflowRun("wfr_reserving", "running"),
          events: [
            {
              sequence: 1,
              type: "phase" as const,
              at: "2026-05-29T00:00:01.000Z",
              name: "before-agent",
            },
            {
              sequence: 2,
              type: "agent-step" as const,
              at: "2026-05-29T00:00:02.000Z",
              stepId: "slow-agent",
              inputHash: "sha256:slow-agent",
              status: "reserving" as const,
              title: "Slow agent",
            },
          ],
        },
      ])
    );

    const tool = createTaskListTool({
      ...baseConfig,
      taskService,
      workflowService: { listRuns },
    });

    const result: unknown = await Promise.resolve(
      tool.execute!({ includeArchived: false }, mockToolCallOptions)
    );

    expect(result).toEqual({
      tasks: [
        expect.objectContaining({
          taskId: "wfr_reserving",
          workflowProgress: {
            name: "deep-research",
            latestPhase: { name: "before-agent", at: "2026-05-29T00:00:01.000Z" },
            lastProgressAt: "2026-05-29T00:00:02.000Z",
            stepCounts: { started: 0, completed: 0, failed: 0, interrupted: 0 },
          },
        }),
      ],
    });
  });

  it("discovers resumable workflow runs while checking stable child continuations", async () => {
    using tempDir = new TestTempDir("test-task-list-resumable-workflows");
    const baseConfig = createTestToolConfig(tempDir.path, { workspaceId: "root-workspace" });

    const listDescendantAgentTasks = mock(() => []);
    const taskService = { listDescendantAgentTasks } as unknown as TaskService;
    const listRuns = mock(() =>
      Promise.resolve([
        buildWorkflowRun("wfr_running", "running"),
        buildWorkflowRun("wfr_failed", "failed"),
      ])
    );

    const tool = createTaskListTool({
      ...baseConfig,
      taskService,
      workflowService: {
        listRuns,
      },
    });

    const result: unknown = await Promise.resolve(
      tool.execute!({ statuses: ["failed"] }, mockToolCallOptions)
    );

    expect(listDescendantAgentTasks).toHaveBeenCalledWith("root-workspace", {
      excludeWorkflowTasks: true,
    });
    expect(result).toEqual({
      tasks: [
        {
          taskId: "wfr_failed",
          status: "failed",
          parentWorkspaceId: "root-workspace",
          title: "deep-research",
          createdAt: "2026-05-29T00:00:00.000Z",
          depth: 1,
        },
      ],
    });
  });

  function buildTreeTaskService() {
    const listTaskTreeAgents = mock(() => ({
      rootWorkspaceId: "tree-root",
      rootTitle: "Root workspace",
      rootRelationship: "ancestor" as const,
      tasks: [
        { ...buildAgentTask("task-self", "running", "tree-root"), relationship: "self" as const },
        {
          ...buildAgentTask("task-sib", "running", "tree-root"),
          relationship: "sibling" as const,
        },
        {
          ...buildAgentTask("task-done", "reported", "tree-root"),
          relationship: "sibling" as const,
        },
      ],
    }));
    return {
      listTaskTreeAgents,
      taskService: { listTaskTreeAgents } as unknown as TaskService,
    };
  }

  it("tree scope includes the root row by default and filters inactive rows", async () => {
    using tempDir = new TestTempDir("test-task-list-tree-default");
    const baseConfig = createTestToolConfig(tempDir.path, { workspaceId: "task-self" });
    const { listTaskTreeAgents, taskService } = buildTreeTaskService();

    const tool = createTaskListTool({ ...baseConfig, taskService });
    const result: unknown = await Promise.resolve(
      tool.execute!({ scope: "tree" }, mockToolCallOptions)
    );

    expect(listTaskTreeAgents).toHaveBeenCalledWith("task-self");
    // Default statuses: the root "workspace" row plus active rows; reported rows stay hidden.
    expect(taskIds(result)).toEqual(["tree-root", "task-self", "task-sib"]);
    const parsed = result as {
      tasks: Array<{
        taskId: string;
        status: string;
        title?: string;
        relationship?: string;
        depth: number;
      }>;
      note?: string;
    };
    expect(parsed.tasks[0]).toEqual({
      taskId: "tree-root",
      status: "workspace",
      title: "Root workspace",
      relationship: "ancestor",
      depth: 0,
    });
    expect(parsed.tasks[1].relationship).toBe("self");
  });

  it("tree scope does not advertise queued reawakenings on peer rows", async () => {
    using tempDir = new TestTempDir("test-task-list-tree-reawakening");
    const baseConfig = createTestToolConfig(tempDir.path, { workspaceId: "task-self" });
    const listTaskTreeAgents = mock(() => ({
      rootWorkspaceId: "tree-root",
      rootRelationship: "ancestor" as const,
      tasks: [
        { ...buildAgentTask("task-self", "running", "tree-root"), relationship: "self" as const },
        // Sibling with a QUEUED reawakening: peer admission only accepts a running execution
        // mirror, so the row must keep its stable terminal status (which the note marks
        // unaddressable) instead of advertising an addressable-looking "queued".
        {
          ...buildAgentTask("task-sib-requeued", "reported", "tree-root"),
          executionTaskId: "wtt-sib",
          executionStatus: "queued" as const,
          relationship: "sibling" as const,
        },
        // A RUNNING reawakened sibling stays overlaid: it genuinely accepts peer messages.
        {
          ...buildAgentTask("task-sib-live", "reported", "tree-root"),
          executionTaskId: "wtt-live",
          executionStatus: "running" as const,
          relationship: "sibling" as const,
        },
      ],
    }));
    const tool = createTaskListTool({
      ...baseConfig,
      taskService: { listTaskTreeAgents } as unknown as TaskService,
    });

    const parsed = (await Promise.resolve(
      tool.execute!(
        { scope: "tree", statuses: ["workspace", "running", "queued", "reported"] },
        mockToolCallOptions
      )
    )) as { tasks: Array<{ taskId: string; status: string }> };

    const statusById = new Map(parsed.tasks.map((task) => [task.taskId, task.status]));
    expect(statusById.get("task-sib-requeued")).toBe("reported");
    expect(statusById.get("task-sib-live")).toBe("running");
  });

  it("tree scope hides initially queued peers that peer sends would refuse", async () => {
    using tempDir = new TestTempDir("test-task-list-tree-initially-queued");
    const baseConfig = createTestToolConfig(tempDir.path, { workspaceId: "task-self" });
    const listTaskTreeAgents = mock(() => ({
      rootWorkspaceId: "tree-root",
      rootRelationship: "ancestor" as const,
      tasks: [
        { ...buildAgentTask("task-self", "running", "tree-root"), relationship: "self" as const },
        // Initially queued/starting siblings (launch capacity) carry a nonterminal STABLE
        // status with no execution overlay, but sendAgentPeerMessage refuses those statuses
        // outright — advertising them would break the note's addressability claim.
        {
          ...buildAgentTask("task-sib-queued", "queued", "tree-root"),
          relationship: "sibling" as const,
        },
        {
          ...buildAgentTask("task-sib-starting", "starting", "tree-root"),
          relationship: "sibling" as const,
        },
        // Queued DESCENDANTS stay visible: parent guidance may target them.
        {
          ...buildAgentTask("task-child-queued", "queued", "task-self"),
          relationship: "descendant" as const,
        },
      ],
    }));
    const tool = createTaskListTool({
      ...baseConfig,
      taskService: { listTaskTreeAgents } as unknown as TaskService,
    });

    const result: unknown = await Promise.resolve(
      tool.execute!(
        { scope: "tree", statuses: ["workspace", "running", "queued", "starting"] },
        mockToolCallOptions
      )
    );
    expect(taskIds(result)).toEqual(["tree-root", "task-self", "task-child-queued"]);
  });

  it("tree scope hides peers and swaps the note for restricted callers", async () => {
    using tempDir = new TestTempDir("test-task-list-tree-restricted");
    const baseConfig = createTestToolConfig(tempDir.path, { workspaceId: "task-cand-child" });
    // A best-of candidate (or workflow-owned) caller cannot message the root or any peer:
    // listTaskTreeAgents already omits those rows and flags the caller, and the tool must not
    // advertise the root row or the standard addressability note.
    const listTaskTreeAgents = mock(() => ({
      rootWorkspaceId: "tree-root",
      rootTitle: "Root workspace",
      rootRelationship: "ancestor" as const,
      callerPeerMessagingRestricted: true as const,
      tasks: [
        {
          ...buildAgentTask("task-cand-child", "running", "task-cand"),
          relationship: "self" as const,
        },
        {
          ...buildAgentTask("task-cand-grandchild", "running", "task-cand-child"),
          relationship: "descendant" as const,
        },
      ],
    }));
    const tool = createTaskListTool({
      ...baseConfig,
      taskService: { listTaskTreeAgents } as unknown as TaskService,
    });

    const result = (await Promise.resolve(
      tool.execute!({ scope: "tree" }, mockToolCallOptions)
    )) as { tasks: Array<{ taskId: string }>; note?: string };
    expect(result.tasks.map((task) => task.taskId)).toEqual([
      "task-cand-child",
      "task-cand-grandchild",
    ]);
    expect(result.note).toContain("cannot send or receive peer messages");
  });

  it("tree scope omits an archived root from discovery", async () => {
    using tempDir = new TestTempDir("test-task-list-tree-archived-root");
    const baseConfig = createTestToolConfig(tempDir.path, { workspaceId: "task-self" });
    // Peer sends refuse archived targets, so an archived root must not be published as an
    // addressable "workspace" row.
    const listTaskTreeAgents = mock(() => ({
      rootWorkspaceId: "tree-root",
      rootTitle: "Root workspace",
      rootRelationship: "ancestor" as const,
      rootArchived: true as const,
      tasks: [
        { ...buildAgentTask("task-self", "running", "tree-root"), relationship: "self" as const },
      ],
    }));
    const tool = createTaskListTool({
      ...baseConfig,
      taskService: { listTaskTreeAgents } as unknown as TaskService,
    });

    const result: unknown = await Promise.resolve(
      tool.execute!({ scope: "tree" }, mockToolCallOptions)
    );
    expect(taskIds(result)).toEqual(["task-self"]);
  });

  it("tree scope omits a missing root from discovery", async () => {
    using tempDir = new TestTempDir("test-task-list-tree-missing-root");
    const baseConfig = createTestToolConfig(tempDir.path, { workspaceId: "task-self" });
    // A retained descendant whose parent chain ends at a removed/corrupted workspace: sends to
    // that ID return not_found, so the root row must not be published as addressable.
    const listTaskTreeAgents = mock(() => ({
      rootWorkspaceId: "vanished-root",
      rootRelationship: "ancestor" as const,
      rootMissing: true as const,
      tasks: [
        {
          ...buildAgentTask("task-self", "running", "vanished-root"),
          relationship: "self" as const,
        },
      ],
    }));
    const tool = createTaskListTool({
      ...baseConfig,
      taskService: { listTaskTreeAgents } as unknown as TaskService,
    });

    const result: unknown = await Promise.resolve(
      tool.execute!({ scope: "tree" }, mockToolCallOptions)
    );
    expect(taskIds(result)).toEqual(["task-self"]);
  });

  it("tree scope filters the root row like any other row when explicit statuses are passed", async () => {
    using tempDir = new TestTempDir("test-task-list-tree-explicit");
    const baseConfig = createTestToolConfig(tempDir.path, { workspaceId: "task-self" });

    const tool = createTaskListTool({
      ...baseConfig,
      taskService: buildTreeTaskService().taskService,
    });

    const withoutWorkspaceStatus: unknown = await Promise.resolve(
      tool.execute!({ scope: "tree", statuses: ["running"] }, mockToolCallOptions)
    );
    expect(taskIds(withoutWorkspaceStatus)).toEqual(["task-self", "task-sib"]);

    const withWorkspaceStatus: unknown = await Promise.resolve(
      tool.execute!({ scope: "tree", statuses: ["workspace", "reported"] }, mockToolCallOptions)
    );
    expect(taskIds(withWorkspaceStatus)).toEqual(["tree-root", "task-done"]);
  });
});

import { describe, it, expect, mock } from "bun:test";
import type { TaskCreatedEvent } from "@/common/types/stream";

import { tool } from "ai";
import { z } from "zod";

import { createTaskTool, markBuiltInTaskTool, isBuiltInTaskTool } from "./task";
import { createTestToolConfig, mockToolCallOptions, TestTempDir } from "./testHelpers";
import { Ok, Err } from "@/common/types/result";
import { ForegroundWaitBackgroundedError, type TaskService } from "@/node/services/taskService";

function expectQueuedOrRunningTaskToolResult(
  result: unknown,
  expected: { status: "queued" | "running"; taskId: string }
): void {
  expect(result).toBeTruthy();
  expect(typeof result).toBe("object");
  expect(result).not.toBeNull();

  const obj = result as Record<string, unknown>;
  expect(obj.status).toBe(expected.status);
  expect(obj.taskId).toBe(expected.taskId);
  expect(typeof obj.note).toBe("string");
}

function expectGroupedQueuedOrRunningTaskToolResult(
  result: unknown,
  expected: { status: "queued" | "running"; taskIds: string[] }
): void {
  expect(result).toBeTruthy();
  expect(typeof result).toBe("object");
  expect(result).not.toBeNull();

  const obj = result as Record<string, unknown>;
  expect(obj.status).toBe(expected.status);
  expect(obj.taskIds).toEqual(expected.taskIds);
  expect(obj.tasks).toMatchObject(
    expected.taskIds.map((taskId) => ({
      taskId,
      status: expected.status,
    }))
  );
  expect(typeof obj.note).toBe("string");
}

describe("task tool", () => {
  it("uses runtime-aware description for local runtimes", () => {
    using tempDir = new TestTempDir("test-task-tool-local-description");
    const tool = createTaskTool({
      ...createTestToolConfig(tempDir.path),
      xumEnv: { MUX_RUNTIME: "local" },
    });

    expect(tool.description).toContain("share the same working directory as the parent");
    expect(tool.description).toContain("can see uncommitted changes");
  });

  it("uses runtime-aware description for worktree runtimes", () => {
    using tempDir = new TestTempDir("test-task-tool-worktree-description");
    const tool = createTaskTool({
      ...createTestToolConfig(tempDir.path),
      xumEnv: { MUX_RUNTIME: "worktree" },
    });

    expect(tool.description).toContain("forked workspace based on committed state");
    expect(tool.description).toContain("Uncommitted changes from the parent are not available");
  });

  // The advertised inputSchema is the raw (strict) Zod schema. A `.strict()` schema that omits
  // `isolation` rejects the field outright, proving it never enters LLM context for that runtime.
  const parseWithIsolation = (tool: ReturnType<typeof createTaskTool>) =>
    (tool.inputSchema as { safeParse: (v: unknown) => { success: boolean } }).safeParse({
      agentId: "explore",
      prompt: "look",
      title: "Look",
      isolation: "none",
    });

  it("omits the isolation parameter from the schema on local runtimes", () => {
    using tempDir = new TestTempDir("test-task-tool-local-isolation-schema");
    const tool = createTaskTool({
      ...createTestToolConfig(tempDir.path),
      xumEnv: { MUX_RUNTIME: "local" },
    });

    expect(parseWithIsolation(tool).success).toBe(false);
  });

  it("advertises the isolation parameter in the schema on worktree runtimes", () => {
    using tempDir = new TestTempDir("test-task-tool-worktree-isolation-schema");
    const tool = createTaskTool({
      ...createTestToolConfig(tempDir.path),
      xumEnv: { MUX_RUNTIME: "worktree" },
    });

    expect(parseWithIsolation(tool).success).toBe(true);
  });

  it("rejects unsupported workspace fork mode in the schema", () => {
    using tempDir = new TestTempDir("test-task-tool-workspace-fork-schema");
    const tool = createTaskTool({
      ...createTestToolConfig(tempDir.path),
      xumEnv: { MUX_RUNTIME: "worktree" },
    });

    const parsed = (
      tool.inputSchema as { safeParse: (v: unknown) => { success: boolean } }
    ).safeParse({
      kind: "workspace",
      prompt: "summarize the fork",
      title: "Workspace fork",
      workspace: { mode: "fork" },
    });

    expect(parsed.success).toBe(false);
  });

  it("rejects sticky retention for full workspace tasks", () => {
    using tempDir = new TestTempDir("test-task-tool-workspace-sticky-schema");
    const tool = createTaskTool({
      ...createTestToolConfig(tempDir.path),
      xumEnv: { MUX_RUNTIME: "worktree" },
    });

    const parsed = (
      tool.inputSchema as { safeParse: (v: unknown) => { success: boolean } }
    ).safeParse({
      kind: "workspace",
      prompt: "keep working",
      title: "Persistent workspace",
      sticky: true,
    });

    expect(parsed.success).toBe(false);
  });

  it("starts a background workspace turn without requiring a sub-agent id", async () => {
    using tempDir = new TestTempDir("test-task-tool-workspace-turn");
    const baseConfig = createTestToolConfig(tempDir.path, { workspaceId: "parent-workspace" });

    const createWorkspaceTurn = mock(() =>
      Ok({
        taskId: "wst_child-turn",
        kind: "workspace_turn" as const,
        status: "running" as const,
        workspaceId: "child-workspace",
      })
    );
    const create = mock(() => Err("sub-agent path should not be used"));
    const waitForWorkspaceTurn = mock(() => Promise.resolve({ reportMarkdown: "ignored" }));
    const taskService = {
      create,
      createWorkspaceTurn,
      waitForWorkspaceTurn,
    } as unknown as TaskService;

    const tool = createTaskTool({
      ...baseConfig,
      xumEnv: { MUX_MODEL_STRING: "openai:gpt-4o-mini", MUX_THINKING_LEVEL: "high" },
      taskService,
    });

    const result: unknown = await Promise.resolve(
      tool.execute!(
        {
          kind: "workspace",
          prompt: "summarize the repository",
          title: "Repository summary",
          run_in_background: true,
        },
        mockToolCallOptions
      )
    );

    expect(create).not.toHaveBeenCalled();
    expect(waitForWorkspaceTurn).not.toHaveBeenCalled();
    expect(createWorkspaceTurn).toHaveBeenCalledTimes(1);
    const createWorkspaceTurnCall = createWorkspaceTurn.mock.calls[0] as unknown[];
    expect(createWorkspaceTurnCall[0]).toMatchObject({
      ownerWorkspaceId: "parent-workspace",
      prompt: "summarize the repository",
      title: "Repository summary",
      parentRuntimeAiSettings: { modelString: "openai:gpt-4o-mini", thinkingLevel: "high" },
      workspace: { mode: "new" },
    });
    expect(result).toMatchObject({
      status: "running",
      taskId: "wst_child-turn",
      workspaceId: "child-workspace",
      handleKind: "workspace_turn",
    });
  });

  it("forwards agentId to createWorkspaceTurn for workspace kind", async () => {
    using tempDir = new TestTempDir("test-task-tool-workspace-turn-agent-id");
    const baseConfig = createTestToolConfig(tempDir.path, { workspaceId: "parent-workspace" });

    const createWorkspaceTurn = mock(() =>
      Ok({
        taskId: "wst_child-turn",
        kind: "workspace_turn" as const,
        status: "running" as const,
        workspaceId: "child-workspace",
      })
    );
    const taskService = { createWorkspaceTurn } as unknown as TaskService;
    const tool = createTaskTool({ ...baseConfig, taskService });

    const result: unknown = await Promise.resolve(
      tool.execute!(
        {
          kind: "workspace",
          agentId: "plan",
          prompt: "plan a small change",
          title: "Plan dogfood",
          run_in_background: true,
        },
        mockToolCallOptions
      )
    );

    expect(createWorkspaceTurn).toHaveBeenCalledTimes(1);
    const createWorkspaceTurnCall = createWorkspaceTurn.mock.calls[0] as unknown[];
    expect(createWorkspaceTurnCall[0]).toMatchObject({
      ownerWorkspaceId: "parent-workspace",
      agentId: "plan",
      prompt: "plan a small change",
      workspace: { mode: "new" },
    });
    expect(result).toMatchObject({
      status: "running",
      taskId: "wst_child-turn",
      workspaceId: "child-workspace",
      handleKind: "workspace_turn",
    });
  });

  it("forwards workspace turn queue dispatch mode", async () => {
    using tempDir = new TestTempDir("test-task-tool-workspace-turn-queue-mode");
    const baseConfig = createTestToolConfig(tempDir.path, { workspaceId: "parent-workspace" });

    const createWorkspaceTurn = mock(() =>
      Ok({
        taskId: "wst_child-turn",
        kind: "workspace_turn" as const,
        status: "queued" as const,
        workspaceId: "child-workspace",
      })
    );
    const taskService = { createWorkspaceTurn } as unknown as TaskService;
    const tool = createTaskTool({ ...baseConfig, taskService });

    const result: unknown = await Promise.resolve(
      tool.execute!(
        {
          kind: "workspace",
          prompt: "follow up",
          title: "Follow-up",
          run_in_background: true,
          workspace: {
            mode: "existing",
            workspaceId: "child-workspace",
            queueDispatchMode: "turn-end",
          },
        },
        mockToolCallOptions
      )
    );

    expect(createWorkspaceTurn).toHaveBeenCalledTimes(1);
    const createWorkspaceTurnCall = createWorkspaceTurn.mock.calls[0] as unknown[];
    expect(createWorkspaceTurnCall[0]).toMatchObject({
      ownerWorkspaceId: "parent-workspace",
      workspace: {
        mode: "existing",
        workspaceId: "child-workspace",
        queueDispatchMode: "turn-end",
      },
    });
    expect(result).toMatchObject({
      status: "queued",
      taskId: "wst_child-turn",
      workspaceId: "child-workspace",
      handleKind: "workspace_turn",
    });
  });

  it("announces the possibly superseded handle only when createWorkspaceTurn reports one", async () => {
    using tempDir = new TestTempDir("test-task-tool-workspace-turn-supersede-note");
    const baseConfig = createTestToolConfig(tempDir.path, { workspaceId: "parent-workspace" });
    const executeFollowUp = async (maySupersedeTaskId?: string): Promise<{ note?: string }> => {
      const createWorkspaceTurn = mock(() =>
        Ok({
          taskId: "wst_follow_up",
          kind: "workspace_turn" as const,
          status: "queued" as const,
          workspaceId: "child-workspace",
          ...(maySupersedeTaskId != null ? { maySupersedeTaskId } : {}),
        })
      );
      const taskService = { createWorkspaceTurn } as unknown as TaskService;
      const tool = createTaskTool({ ...baseConfig, taskService });
      return (await Promise.resolve(
        tool.execute!(
          {
            kind: "workspace",
            prompt: "follow up",
            title: "Follow-up",
            run_in_background: true,
            workspace: { mode: "existing", workspaceId: "child-workspace" },
          },
          mockToolCallOptions
        )
      )) as { note?: string };
    };

    // Assert on the superseded handle id, not the note prose.
    const announced = await executeFollowUp("wst_previous_turn");
    expect(announced.note).toContain("wst_previous_turn");

    const silent = await executeFollowUp();
    expect(silent.note ?? "").not.toContain("wst_previous_turn");
  });

  it("carries the superseded handle id into foreground completed results", async () => {
    // The old handle's wake is suppressed, so a foreground completion is the
    // owner's only notification that its previously tracked handle settled.
    using tempDir = new TestTempDir("test-task-tool-workspace-turn-supersede-completed");
    const baseConfig = createTestToolConfig(tempDir.path, { workspaceId: "parent-workspace" });
    const executeForegroundFollowUp = async (
      maySupersedeTaskId?: string
    ): Promise<{ status?: string; note?: string }> => {
      const createWorkspaceTurn = mock(() =>
        Ok({
          taskId: "wst_follow_up",
          kind: "workspace_turn" as const,
          status: "queued" as const,
          workspaceId: "child-workspace",
          ...(maySupersedeTaskId != null ? { maySupersedeTaskId } : {}),
        })
      );
      const waitForWorkspaceTurn = mock(() =>
        Promise.resolve({
          taskId: "wst_follow_up",
          workspaceId: "child-workspace",
          updatedAt: "2026-08-11T00:00:00.000Z",
          reportMarkdown: "done",
        })
      );
      const taskService = { createWorkspaceTurn, waitForWorkspaceTurn } as unknown as TaskService;
      const tool = createTaskTool({ ...baseConfig, taskService });
      return (await Promise.resolve(
        tool.execute!(
          {
            kind: "workspace",
            prompt: "follow up",
            title: "Follow-up",
            run_in_background: false,
            workspace: { mode: "existing", workspaceId: "child-workspace" },
          },
          mockToolCallOptions
        )
      )) as { status?: string; note?: string };
    };

    const announced = await executeForegroundFollowUp("wst_previous_turn");
    expect(announced.status).toBe("completed");
    expect(announced.note).toContain("wst_previous_turn");

    const silent = await executeForegroundFollowUp();
    expect(silent.status).toBe("completed");
    expect(silent.note ?? "").not.toContain("wst_previous_turn");
  });

  it.each([
    { kind: "workspace", desktop: "shared" },
    { kind: "workspace", desktop: "isolated" },
    { agentId: "desktop", n: 2 },
    { agentId: "desktop", desktop: null, n: 2 },
    { agentId: "custom", desktop: "shared", n: 2 },
  ])("rejects invalid desktop delegation before creating any work: %j", async (args) => {
    using tempDir = new TestTempDir("test-desktop-task-refusal");
    const create = mock(() => Ok({ taskId: "unexpected", kind: "agent", status: "running" }));
    const createWorkspaceTurn = mock(() => Promise.resolve(Err("unexpected")));
    const baseConfig = createTestToolConfig(tempDir.path);
    const tool = createTaskTool({
      ...baseConfig,
      taskService: { create } as unknown as TaskService,
      workspaceTurnManager: {
        createWorkspaceTurn,
      } as unknown as NonNullable<typeof baseConfig.workspaceTurnManager>,
    });
    await Promise.resolve(
      expect(
        tool.execute!({ ...args, prompt: "test", title: "Operator" }, mockToolCallOptions)
      ).rejects.toThrow("task tool input validation failed")
    );
    expect(create).not.toHaveBeenCalled();
    expect(createWorkspaceTurn).not.toHaveBeenCalled();
  });

  it.each([true, false])(
    "preserves the resolved desktop in task results (background=%s)",
    async (background) => {
      using tempDir = new TestTempDir("test-desktop-task-target");
      const create = mock((_: { desktop?: string; isolation?: string }) =>
        Ok({
          taskId: "child",
          kind: "agent" as const,
          status: "running" as const,
          desktopOwnerWorkspaceId: "ancestor",
        })
      );
      const taskService = {
        create,
        waitForAgentReport: () => Promise.resolve({ reportMarkdown: "done" }),
      } as unknown as TaskService;
      const tool = createTaskTool({ ...createTestToolConfig(tempDir.path), taskService });
      const result: unknown = await tool.execute!(
        {
          agentId: "custom",
          desktop: "shared",
          isolation: "none",
          prompt: "test",
          title: "Operator",
          run_in_background: background,
        },
        mockToolCallOptions
      );
      expect(create.mock.calls[0]?.[0]).toMatchObject({ desktop: "shared", isolation: "none" });
      expect(result).toMatchObject({ desktopOwnerWorkspaceId: "ancestor" });
    }
  );

  it("allows explicitly isolated desktop groups", async () => {
    using tempDir = new TestTempDir("test-isolated-desktop-group");
    const create = mock(() =>
      Ok({ taskId: "child", kind: "agent" as const, status: "running" as const })
    );
    const tool = createTaskTool({
      ...createTestToolConfig(tempDir.path),
      taskService: { create } as unknown as TaskService,
    });
    await tool.execute!(
      {
        agentId: "desktop",
        desktop: "isolated",
        n: 2,
        prompt: "test",
        title: "Operator",
        run_in_background: true,
      },
      mockToolCallOptions
    );
    expect(create).toHaveBeenCalledTimes(2);
  });

  it("forwards isolation to taskService.create", async () => {
    using tempDir = new TestTempDir("test-task-tool-isolation-passthrough");
    const baseConfig = createTestToolConfig(tempDir.path, { workspaceId: "parent-workspace" });

    const create = mock((_: { isolation?: unknown }) =>
      Ok({ taskId: "child-task", kind: "agent" as const, status: "running" as const })
    );
    const waitForAgentReport = mock(() => Promise.resolve({ reportMarkdown: "ignored" }));
    const taskService = { create, waitForAgentReport } as unknown as TaskService;

    const tool = createTaskTool({
      ...baseConfig,
      xumEnv: { MUX_RUNTIME: "worktree" },
      taskService,
    });

    await Promise.resolve(
      tool.execute!(
        {
          subagent_type: "explore",
          prompt: "read-only look",
          title: "Child task",
          run_in_background: true,
          isolation: "none",
        },
        mockToolCallOptions
      )
    );

    expect(create).toHaveBeenCalledTimes(1);
    expect(create.mock.calls[0]?.[0]?.isolation).toBe("none");
  });

  it("omits isolation from taskService.create when not provided", async () => {
    using tempDir = new TestTempDir("test-task-tool-isolation-default");
    const baseConfig = createTestToolConfig(tempDir.path, { workspaceId: "parent-workspace" });

    const create = mock((_: { isolation?: unknown }) =>
      Ok({ taskId: "child-task", kind: "agent" as const, status: "queued" as const })
    );
    const waitForAgentReport = mock(() => Promise.resolve({ reportMarkdown: "ignored" }));
    const taskService = { create, waitForAgentReport } as unknown as TaskService;

    const tool = createTaskTool({
      ...baseConfig,
      xumEnv: { MUX_RUNTIME: "worktree" },
      taskService,
    });

    await Promise.resolve(
      tool.execute!(
        { subagent_type: "explore", prompt: "do it", title: "Child task", run_in_background: true },
        mockToolCallOptions
      )
    );

    expect(create).toHaveBeenCalledTimes(1);
    expect(create.mock.calls[0]?.[0]?.isolation).toBeUndefined();
  });

  it("rejects removed sticky retention input before task creation", async () => {
    using tempDir = new TestTempDir("test-task-tool-sticky-rejected");
    const baseConfig = createTestToolConfig(tempDir.path, { workspaceId: "parent-workspace" });

    const create = mock(() =>
      Ok({ taskId: "child-task", kind: "agent" as const, status: "running" as const })
    );
    const waitForAgentReport = mock(() => Promise.resolve({ reportMarkdown: "ignored" }));
    const taskService = { create, waitForAgentReport } as unknown as TaskService;
    const tool = createTaskTool({ ...baseConfig, taskService });

    const error: unknown = await Promise.resolve(
      tool.execute!(
        {
          agentId: "exec",
          prompt: "own the separate PR",
          title: "PR owner",
          run_in_background: true,
          sticky: true,
        },
        mockToolCallOptions
      )
    ).catch((caught: unknown) => caught);

    expect(error).toBeInstanceOf(Error);
    expect(String(error)).toMatch(/sticky/i);
    expect(create).not.toHaveBeenCalled();
  });

  it("should return immediately when run_in_background is true", async () => {
    using tempDir = new TestTempDir("test-task-tool");
    const baseConfig = createTestToolConfig(tempDir.path, { workspaceId: "parent-workspace" });

    const create = mock(() =>
      Ok({ taskId: "child-task", kind: "agent" as const, status: "queued" as const })
    );
    const waitForAgentReport = mock(() => Promise.resolve({ reportMarkdown: "ignored" }));
    const taskService = { create, waitForAgentReport } as unknown as TaskService;

    const tool = createTaskTool({
      ...baseConfig,
      xumEnv: { MUX_MODEL_STRING: "openai:gpt-4o-mini", MUX_THINKING_LEVEL: "high" },
      taskService,
    });

    const result: unknown = await Promise.resolve(
      tool.execute!(
        { subagent_type: "explore", prompt: "do it", title: "Child task", run_in_background: true },
        mockToolCallOptions
      )
    );

    expect(create).toHaveBeenCalled();
    expect(waitForAgentReport).not.toHaveBeenCalled();
    expectQueuedOrRunningTaskToolResult(result, { status: "queued", taskId: "child-task" });
  });

  it("passes parent MUX_MODEL_STRING/MUX_THINKING_LEVEL as a runtime fallback hint", async () => {
    using tempDir = new TestTempDir("test-task-tool-parent-ai-env");
    const baseConfig = createTestToolConfig(tempDir.path, { workspaceId: "parent-workspace" });

    const create = mock(
      (_: {
        modelString?: unknown;
        thinkingLevel?: unknown;
        parentRuntimeAiSettings?: { modelString?: unknown; thinkingLevel?: unknown };
      }) => Ok({ taskId: "child-task", kind: "agent" as const, status: "queued" as const })
    );
    const waitForAgentReport = mock(() => Promise.resolve({ reportMarkdown: "ignored" }));
    const taskService = { create, waitForAgentReport } as unknown as TaskService;

    const tool = createTaskTool({
      ...baseConfig,
      xumEnv: { MUX_MODEL_STRING: "openai:gpt-4o-mini", MUX_THINKING_LEVEL: "med" },
      taskService,
    });

    await Promise.resolve(
      tool.execute!(
        { subagent_type: "explore", prompt: "do it", title: "Child task", run_in_background: true },
        mockToolCallOptions
      )
    );

    expect(create).toHaveBeenCalledTimes(1);
    const createArgs = create.mock.calls[0]?.[0];
    expect(createArgs).toBeDefined();
    expect(createArgs?.modelString).toBeUndefined();
    expect(createArgs?.thinkingLevel).toBeUndefined();
    expect(createArgs?.parentRuntimeAiSettings).toEqual({
      modelString: "openai:gpt-4o-mini",
      thinkingLevel: "medium",
    });
  });

  it("forwards a model alias and named thinking override to taskService.create", async () => {
    using tempDir = new TestTempDir("test-task-tool-model-thinking-override");
    const baseConfig = createTestToolConfig(tempDir.path, { workspaceId: "parent-workspace" });

    const create = mock(
      (_: {
        modelString?: unknown;
        thinkingLevel?: unknown;
        parentRuntimeAiSettings?: { modelString?: unknown; thinkingLevel?: unknown };
      }) => Ok({ taskId: "child-task", kind: "agent" as const, status: "queued" as const })
    );
    const waitForAgentReport = mock(() => Promise.resolve({ reportMarkdown: "ignored" }));
    const taskService = { create, waitForAgentReport } as unknown as TaskService;

    const tool = createTaskTool({
      ...baseConfig,
      xumEnv: { MUX_MODEL_STRING: "openai:gpt-4o-mini", MUX_THINKING_LEVEL: "low" },
      taskService,
    });

    await Promise.resolve(
      tool.execute!(
        {
          subagent_type: "explore",
          prompt: "do it",
          title: "Child task",
          run_in_background: true,
          // "sonnet" is an alias; the handler must resolve it like the UI does.
          model: "sonnet",
          thinking: "high",
        },
        mockToolCallOptions
      )
    );

    expect(create).toHaveBeenCalledTimes(1);
    const createArgs = create.mock.calls[0]?.[0];
    expect(createArgs?.modelString).toBe("anthropic:claude-sonnet-5");
    expect(createArgs?.thinkingLevel).toBe("high");
    // Parent runtime hint is still forwarded so unspecified fields keep inheriting.
    expect(createArgs?.parentRuntimeAiSettings).toEqual({
      modelString: "openai:gpt-4o-mini",
      thinkingLevel: "low",
    });
  });

  it("forwards a numeric thinking override as a deferred index", async () => {
    using tempDir = new TestTempDir("test-task-tool-numeric-thinking");
    const baseConfig = createTestToolConfig(tempDir.path, { workspaceId: "parent-workspace" });

    const create = mock((_: { thinkingLevel?: unknown }) =>
      Ok({ taskId: "child-task", kind: "agent" as const, status: "queued" as const })
    );
    const waitForAgentReport = mock(() => Promise.resolve({ reportMarkdown: "ignored" }));
    const taskService = { create, waitForAgentReport } as unknown as TaskService;

    const tool = createTaskTool({ ...baseConfig, taskService });

    await Promise.resolve(
      tool.execute!(
        {
          subagent_type: "explore",
          prompt: "do it",
          title: "Child task",
          run_in_background: true,
          // Numeric indices stay deferred (resolved against the model in taskService).
          thinking: "2",
        },
        mockToolCallOptions
      )
    );

    expect(create).toHaveBeenCalledTimes(1);
    const createArgs = create.mock.calls[0]?.[0];
    expect(createArgs?.thinkingLevel).toBe(2);
  });

  it("rejects an invalid model override before spawning a task", async () => {
    using tempDir = new TestTempDir("test-task-tool-invalid-model");
    const baseConfig = createTestToolConfig(tempDir.path, { workspaceId: "parent-workspace" });

    const create = mock(() =>
      Ok({ taskId: "child-task", kind: "agent" as const, status: "queued" as const })
    );
    const taskService = { create } as unknown as TaskService;

    const tool = createTaskTool({ ...baseConfig, taskService });

    let caught: unknown = null;
    try {
      await Promise.resolve(
        tool.execute!(
          {
            subagent_type: "explore",
            prompt: "do it",
            title: "Child task",
            run_in_background: true,
            model: "definitely-not-a-model",
          },
          mockToolCallOptions
        )
      );
    } catch (error: unknown) {
      caught = error;
    }

    expect(caught).toBeInstanceOf(Error);
    if (caught instanceof Error) {
      expect(caught.message).toMatch(/invalid model/i);
    }
    expect(create).not.toHaveBeenCalled();
  });

  it("spawns best-of-n background tasks with shared grouping metadata", async () => {
    using tempDir = new TestTempDir("test-task-tool-best-of-background");
    const baseConfig = createTestToolConfig(tempDir.path, { workspaceId: "parent-workspace" });

    const createArgs: Array<{
      bestOf?: { groupId: string; index: number; total: number };
    }> = [];
    let createCount = 0;
    const create = mock((args: { bestOf?: { groupId: string; index: number; total: number } }) => {
      createArgs.push(args);
      createCount += 1;
      return Ok({
        taskId: `child-task-${createCount}`,
        kind: "agent" as const,
        status: "running" as const,
      });
    });
    const waitForAgentReport = mock(() => Promise.resolve({ reportMarkdown: "ignored" }));
    const taskService = { create, waitForAgentReport } as unknown as TaskService;

    const tool = createTaskTool({
      ...baseConfig,
      taskService,
    });

    const result: unknown = await Promise.resolve(
      tool.execute!(
        {
          subagent_type: "explore",
          prompt: "compare three approaches",
          title: "Best of 3",
          run_in_background: true,
          n: 3,
        },
        mockToolCallOptions
      )
    );

    expect(create).toHaveBeenCalledTimes(3);
    expectGroupedQueuedOrRunningTaskToolResult(result, {
      status: "running",
      taskIds: ["child-task-1", "child-task-2", "child-task-3"],
    });

    const bestOfGroups = createArgs.map((args) => args.bestOf);
    expect(bestOfGroups).toHaveLength(3);
    expect(bestOfGroups[0]).toMatchObject({ index: 0, total: 3 });
    expect(bestOfGroups[1]).toMatchObject({ index: 1, total: 3 });
    expect(bestOfGroups[2]).toMatchObject({ index: 2, total: 3 });
    expect(typeof bestOfGroups[0]?.groupId).toBe("string");
    expect(bestOfGroups[0]?.groupId).toBe(bestOfGroups[1]?.groupId);
    expect(bestOfGroups[1]?.groupId).toBe(bestOfGroups[2]?.groupId);
  });

  it("keeps grouped metadata when best-of task creation fails after only one candidate", async () => {
    using tempDir = new TestTempDir("test-task-tool-best-of-single-partial-failure");
    const baseConfig = createTestToolConfig(tempDir.path, { workspaceId: "parent-workspace" });

    let createCount = 0;
    const create = mock(() => {
      createCount += 1;
      if (createCount === 2) {
        return Err("workspace creation failed");
      }

      return Ok({
        taskId: `child-task-${createCount}`,
        kind: "agent" as const,
        status: "running" as const,
      });
    });
    const waitForAgentReport = mock(() => Promise.resolve({ reportMarkdown: "ignored" }));
    const taskService = { create, waitForAgentReport } as unknown as TaskService;

    const tool = createTaskTool({
      ...baseConfig,
      taskService,
    });

    const result: unknown = await Promise.resolve(
      tool.execute!(
        {
          subagent_type: "explore",
          prompt: "compare two approaches",
          title: "Best of 2",
          run_in_background: false,
          n: 2,
        },
        mockToolCallOptions
      )
    );

    expect(create).toHaveBeenCalledTimes(2);
    expect(waitForAgentReport).not.toHaveBeenCalled();
    expect(result).toBeTruthy();
    expect(typeof result).toBe("object");
    expect(result).not.toBeNull();

    const obj = result as Record<string, unknown>;
    expect(obj.status).toBe("running");
    expect(obj.taskIds).toEqual(["child-task-1"]);
    expect(obj.tasks).toMatchObject([{ taskId: "child-task-1", status: "running" }]);
    expect(typeof obj.note).toBe("string");
  });

  it("returns partial spawn metadata when best-of task creation fails mid-batch", async () => {
    using tempDir = new TestTempDir("test-task-tool-best-of-partial-failure");
    const baseConfig = createTestToolConfig(tempDir.path, { workspaceId: "parent-workspace" });

    let createCount = 0;
    const create = mock(() => {
      createCount += 1;
      if (createCount === 3) {
        return Err("workspace creation failed");
      }

      return Ok({
        taskId: `child-task-${createCount}`,
        kind: "agent" as const,
        status: "running" as const,
      });
    });
    const waitForAgentReport = mock(() => Promise.resolve({ reportMarkdown: "ignored" }));
    const taskService = { create, waitForAgentReport } as unknown as TaskService;

    const tool = createTaskTool({
      ...baseConfig,
      taskService,
    });

    const result: unknown = await Promise.resolve(
      tool.execute!(
        {
          subagent_type: "explore",
          prompt: "compare three approaches",
          title: "Best of 3",
          run_in_background: false,
          n: 3,
        },
        mockToolCallOptions
      )
    );

    expect(create).toHaveBeenCalledTimes(3);
    expect(waitForAgentReport).not.toHaveBeenCalled();
    expect(result).toBeTruthy();
    expect(typeof result).toBe("object");
    expect(result).not.toBeNull();

    const obj = result as Record<string, unknown>;
    expect(obj.status).toBe("running");
    expect(obj.taskIds).toEqual(["child-task-1", "child-task-2"]);
    expect(obj.tasks).toMatchObject([
      { taskId: "child-task-1", status: "running" },
      { taskId: "child-task-2", status: "running" },
    ]);
    expect(typeof obj.note).toBe("string");
  });

  it("returns one completed report per best-of task when run in foreground", async () => {
    using tempDir = new TestTempDir("test-task-tool-best-of-foreground");
    const baseConfig = createTestToolConfig(tempDir.path, { workspaceId: "parent-workspace" });

    let createCount = 0;
    const create = mock(() => {
      createCount += 1;
      return Ok({
        taskId: `child-task-${createCount}`,
        kind: "agent" as const,
        status: "running" as const,
      });
    });
    const waitForAgentReport = mock((taskId: string) =>
      Promise.resolve({
        reportMarkdown: `report for ${taskId}`,
        title: `Report ${taskId}`,
      })
    );
    const taskService = { create, waitForAgentReport } as unknown as TaskService;

    const tool = createTaskTool({
      ...baseConfig,
      taskService,
    });

    const result: unknown = await Promise.resolve(
      tool.execute!(
        {
          subagent_type: "explore",
          prompt: "compare two approaches",
          title: "Best of 2",
          run_in_background: false,
          n: 2,
        },
        mockToolCallOptions
      )
    );

    expect(create).toHaveBeenCalledTimes(2);
    expect(waitForAgentReport).toHaveBeenCalledTimes(2);
    expect(result).toMatchObject({
      status: "completed",
      taskIds: ["child-task-1", "child-task-2"],
      reports: [
        {
          taskId: "child-task-1",
          reportMarkdown: "report for child-task-1",
          title: "Report child-task-1",
          agentId: "explore",
          agentType: "explore",
        },
        {
          taskId: "child-task-2",
          reportMarkdown: "report for child-task-2",
          title: "Report child-task-2",
          agentId: "explore",
          agentType: "explore",
        },
      ],
    });
  });

  it("prefers report-time AI settings over the launch snapshot in completed results", async () => {
    using tempDir = new TestTempDir("test-task-tool-report-time-settings");
    const baseConfig = createTestToolConfig(tempDir.path, { workspaceId: "parent-workspace" });

    // Launch resolves plan-phase settings; the report arrives after a plan-to-exec
    // handoff rewrote the child's task settings.
    const create = mock(() =>
      Ok({
        taskId: "child-task",
        kind: "agent" as const,
        status: "running" as const,
        modelString: "openai:plan-model",
        thinkingLevel: "low" as const,
      })
    );
    const waitForAgentReport = mock(() =>
      Promise.resolve({
        reportMarkdown: "final report",
        model: "anthropic:exec-model",
        thinkingLevel: "high" as const,
      })
    );
    const taskService = { create, waitForAgentReport } as unknown as TaskService;

    const tool = createTaskTool({ ...baseConfig, taskService });

    const result: unknown = await Promise.resolve(
      tool.execute!(
        {
          subagent_type: "plan",
          prompt: "plan then implement",
          title: "Plan task",
          run_in_background: false,
        },
        mockToolCallOptions
      )
    );

    expect(result).toMatchObject({
      status: "completed",
      taskId: "child-task",
      modelString: "anthropic:exec-model",
      thinkingLevel: "high",
    });
  });

  it("preserves completed best-of reports when another foreground wait times out", async () => {
    using tempDir = new TestTempDir("test-task-tool-best-of-timeout-partial-complete");
    const baseConfig = createTestToolConfig(tempDir.path, { workspaceId: "parent-workspace" });

    let createCount = 0;
    const create = mock(() => {
      createCount += 1;
      return Ok({
        taskId: `child-task-${createCount}`,
        kind: "agent" as const,
        status: "running" as const,
      });
    });
    const waitForAgentReport = mock((taskId: string) => {
      if (taskId === "child-task-1") {
        return Promise.resolve({
          reportMarkdown: "report for child-task-1",
          title: "Report child-task-1",
        });
      }
      return Promise.reject(new Error("Timed out waiting for agent_report"));
    });
    const getAgentTaskStatus = mock((taskId: string) =>
      taskId === "child-task-3" ? ("queued" as const) : ("running" as const)
    );
    const taskService = {
      create,
      waitForAgentReport,
      getAgentTaskStatus,
    } as unknown as TaskService;

    const tool = createTaskTool({
      ...baseConfig,
      taskService,
    });

    const result: unknown = await Promise.resolve(
      tool.execute!(
        {
          subagent_type: "explore",
          prompt: "compare three approaches",
          title: "Best of 3",
          run_in_background: false,
          n: 3,
        },
        mockToolCallOptions
      )
    );

    expect(create).toHaveBeenCalledTimes(3);
    expect(waitForAgentReport).toHaveBeenCalledTimes(3);
    expect(getAgentTaskStatus).toHaveBeenCalledTimes(2);
    expect(result).toBeTruthy();
    expect(typeof result).toBe("object");
    expect(result).not.toBeNull();

    const obj = result as Record<string, unknown>;
    expect(obj.status).toBe("running");
    expect(obj.taskIds).toEqual(["child-task-1", "child-task-2", "child-task-3"]);
    expect(obj.tasks).toMatchObject([
      { taskId: "child-task-1", status: "completed" },
      { taskId: "child-task-2", status: "running" },
      { taskId: "child-task-3", status: "queued" },
    ]);
    expect(obj.reports).toMatchObject([
      {
        taskId: "child-task-1",
        reportMarkdown: "report for child-task-1",
        title: "Report child-task-1",
        agentId: "explore",
        agentType: "explore",
      },
    ]);
    expect(typeof obj.note).toBe("string");
  });

  it("should allow sub-agent workspaces to spawn nested tasks", async () => {
    using tempDir = new TestTempDir("test-task-tool");
    const baseConfig = createTestToolConfig(tempDir.path, { workspaceId: "child-workspace" });

    const create = mock(() =>
      Ok({ taskId: "grandchild-task", kind: "agent" as const, status: "queued" as const })
    );
    const waitForAgentReport = mock(() => Promise.resolve({ reportMarkdown: "ignored" }));
    const taskService = { create, waitForAgentReport } as unknown as TaskService;

    const tool = createTaskTool({
      ...baseConfig,
      enableAgentReport: true,
      taskService,
    });

    const result: unknown = await Promise.resolve(
      tool.execute!(
        {
          subagent_type: "explore",
          prompt: "do it",
          title: "Grandchild task",
          run_in_background: true,
        },
        mockToolCallOptions
      )
    );

    expect(create).toHaveBeenCalledWith(
      expect.objectContaining({
        parentWorkspaceId: "child-workspace",
        kind: "agent",
        agentId: "explore",
        agentType: "explore",
      })
    );
    expectQueuedOrRunningTaskToolResult(result, { status: "queued", taskId: "grandchild-task" });
  });

  it("should block and return report when run_in_background is false", async () => {
    using tempDir = new TestTempDir("test-task-tool");
    const baseConfig = createTestToolConfig(tempDir.path, { workspaceId: "parent-workspace" });

    const events: TaskCreatedEvent[] = [];
    let didEmitTaskCreated = false;

    const create = mock(() =>
      Ok({ taskId: "child-task", kind: "agent" as const, status: "running" as const })
    );
    const waitForAgentReport = mock(() => {
      // The main thing we care about: emit the UI-only taskId before we block waiting for the report.
      expect(didEmitTaskCreated).toBe(true);
      return Promise.resolve({
        reportMarkdown: "Hello from child",
        title: "Result",
      });
    });
    const taskService = { create, waitForAgentReport } as unknown as TaskService;

    const tool = createTaskTool({
      ...baseConfig,
      emitChatEvent: (event) => {
        if (event.type === "task-created") {
          didEmitTaskCreated = true;
          events.push(event);
        }
      },
      taskService,
    });

    const result: unknown = await Promise.resolve(
      tool.execute!(
        {
          subagent_type: "explore",
          prompt: "do it",
          title: "Child task",
          run_in_background: false,
        },
        mockToolCallOptions
      )
    );

    expect(create).toHaveBeenCalled();
    expect(waitForAgentReport).toHaveBeenCalledWith("child-task", expect.any(Object));

    expect(events).toHaveLength(1);
    const taskCreated = events[0];
    if (!taskCreated) {
      throw new Error("Expected a task-created event");
    }

    expect(taskCreated.type).toBe("task-created");

    const parentWorkspaceId = baseConfig.workspaceId;
    if (!parentWorkspaceId) {
      throw new Error("Expected baseConfig.workspaceId to be set");
    }
    expect(taskCreated.workspaceId).toBe(parentWorkspaceId);
    expect(taskCreated.toolCallId).toBe(mockToolCallOptions.toolCallId);
    expect(taskCreated.taskId).toBe("child-task");
    expect(typeof taskCreated.timestamp).toBe("number");
    expect(result).toEqual({
      status: "completed",
      taskId: "child-task",
      reportMarkdown: "Hello from child",
      title: "Result",
      agentId: "explore",
      agentType: "explore",
    });
  });

  it("should return taskId if foreground wait times out", async () => {
    using tempDir = new TestTempDir("test-task-tool");
    const baseConfig = createTestToolConfig(tempDir.path, { workspaceId: "parent-workspace" });

    const create = mock(() =>
      Ok({ taskId: "child-task", kind: "agent" as const, status: "queued" as const })
    );
    const waitForAgentReport = mock(() =>
      Promise.reject(new Error("Timed out waiting for agent_report"))
    );
    const getAgentTaskStatus = mock(() => "running" as const);
    const taskService = {
      create,
      waitForAgentReport,
      getAgentTaskStatus,
    } as unknown as TaskService;

    const tool = createTaskTool({
      ...baseConfig,
      taskService,
    });

    const result: unknown = await Promise.resolve(
      tool.execute!(
        {
          subagent_type: "explore",
          prompt: "do it",
          title: "Child task",
          run_in_background: false,
        },
        mockToolCallOptions
      )
    );

    expect(create).toHaveBeenCalled();
    expect(waitForAgentReport).toHaveBeenCalledWith("child-task", expect.any(Object));
    expect(getAgentTaskStatus).toHaveBeenCalledWith("child-task");
    expectQueuedOrRunningTaskToolResult(result, { status: "running", taskId: "child-task" });
  });

  it("should return background result when foreground wait is backgrounded", async () => {
    using tempDir = new TestTempDir("test-task-tool");
    const baseConfig = createTestToolConfig(tempDir.path, { workspaceId: "parent-workspace" });

    const create = mock(() =>
      Ok({ taskId: "child-task", kind: "agent" as const, status: "queued" as const })
    );
    const waitForAgentReport = mock(() => Promise.reject(new ForegroundWaitBackgroundedError()));
    const getAgentTaskStatus = mock(() => "running" as const);
    const taskService = {
      create,
      waitForAgentReport,
      getAgentTaskStatus,
    } as unknown as TaskService;

    const tool = createTaskTool({
      ...baseConfig,
      taskService,
    });

    const result: unknown = await Promise.resolve(
      tool.execute!(
        {
          subagent_type: "explore",
          prompt: "do it",
          title: "Child task",
          run_in_background: false,
        },
        mockToolCallOptions
      )
    );

    expect(create).toHaveBeenCalled();
    expect(waitForAgentReport).toHaveBeenCalledWith(
      "child-task",
      expect.objectContaining({ backgroundOnMessageQueued: true })
    );
    expect(getAgentTaskStatus).toHaveBeenCalledWith("child-task");
    expectQueuedOrRunningTaskToolResult(result, { status: "running", taskId: "child-task" });
  });

  it("should throw when TaskService.create fails (e.g., depth limit)", async () => {
    using tempDir = new TestTempDir("test-task-tool");
    const baseConfig = createTestToolConfig(tempDir.path, { workspaceId: "parent-workspace" });

    const create = mock(() => Err("maxTaskNestingDepth exceeded"));
    const waitForAgentReport = mock(() => Promise.resolve({ reportMarkdown: "ignored" }));
    const taskService = { create, waitForAgentReport } as unknown as TaskService;

    const tool = createTaskTool({
      ...baseConfig,
      taskService,
    });

    let caught: unknown = null;
    try {
      await Promise.resolve(
        tool.execute!(
          { subagent_type: "explore", prompt: "do it", title: "Child task" },
          mockToolCallOptions
        )
      );
    } catch (error: unknown) {
      caught = error;
    }

    expect(caught).toBeInstanceOf(Error);
    if (caught instanceof Error) {
      expect(caught.message).toMatch(/maxTaskNestingDepth/i);
    }
  });

  it("should reject workspace turns while in plan agent", async () => {
    using tempDir = new TestTempDir("test-task-tool-plan-workspace");
    const baseConfig = createTestToolConfig(tempDir.path, { workspaceId: "parent-workspace" });

    const createWorkspaceTurn = mock(() =>
      Ok({
        taskId: "wst_child-turn",
        kind: "workspace_turn" as const,
        status: "running" as const,
        workspaceId: "child-workspace",
      })
    );
    const taskService = { createWorkspaceTurn } as unknown as TaskService;

    const tool = createTaskTool({
      ...baseConfig,
      planFileOnly: true,
      taskService,
    });

    let caught: unknown = null;
    try {
      await Promise.resolve(
        tool.execute!(
          {
            kind: "workspace",
            prompt: "implement it",
            title: "Workspace turn",
            run_in_background: true,
          },
          mockToolCallOptions
        )
      );
    } catch (error: unknown) {
      caught = error;
    }

    expect(caught).toBeInstanceOf(Error);
    if (caught instanceof Error) {
      expect(caught.message).toMatch(/plan agent/i);
    }
    expect(createWorkspaceTurn).not.toHaveBeenCalled();
  });

  it('should reject spawning "exec" tasks while in plan agent', async () => {
    using tempDir = new TestTempDir("test-task-tool");
    const baseConfig = createTestToolConfig(tempDir.path, { workspaceId: "parent-workspace" });

    const create = mock(() =>
      Ok({ taskId: "child-task", kind: "agent" as const, status: "running" as const })
    );
    const waitForAgentReport = mock(() =>
      Promise.resolve({
        reportMarkdown: "Hello from child",
        title: "Result",
      })
    );
    const taskService = { create, waitForAgentReport } as unknown as TaskService;

    const tool = createTaskTool({
      ...baseConfig,
      planFileOnly: true,
      taskService,
    });

    let caught: unknown = null;
    try {
      await Promise.resolve(
        tool.execute!(
          { subagent_type: "exec", prompt: "do it", title: "Child task" },
          mockToolCallOptions
        )
      );
    } catch (error: unknown) {
      caught = error;
    }

    expect(caught).toBeInstanceOf(Error);
    if (caught instanceof Error) {
      expect(caught.message).toMatch(/plan agent/i);
    }
    expect(create).not.toHaveBeenCalled();
    expect(waitForAgentReport).not.toHaveBeenCalled();
  });
});

describe("built-in task marker", () => {
  function makeTool() {
    return tool({
      description: "task",
      inputSchema: z.object({ prompt: z.string() }),
      execute: () => Promise.resolve("ok"),
    });
  }

  it("marks and recognizes the built-in task tool", () => {
    const t = makeTool();
    expect(isBuiltInTaskTool(t)).toBe(false);
    markBuiltInTaskTool(t);
    expect(isBuiltInTaskTool(t)).toBe(true);
  });
});

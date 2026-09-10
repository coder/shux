import * as fs from "fs";

import { describe, it, expect, mock, spyOn } from "bun:test";
import type { ToolExecutionOptions } from "ai";

import type { ToolConfiguration } from "@/common/utils/tools/tools";
import { COMPLETED_REPORT_REFETCH_NOTE } from "@/common/utils/tools/toolDefinitions";
import type { WorkflowRunRecord, WorkflowRunStatus } from "@/common/types/workflow";
import { createTaskAwaitTool } from "./task_await";
import { TestTempDir, createTestToolConfig } from "./testHelpers";
import type { BackgroundProcessManager } from "@/node/services/backgroundProcessManager";
import { getSubagentGitPatchArtifactsFilePath } from "@/node/services/subagentGitPatchArtifacts";
import { ForegroundWaitBackgroundedError, type TaskService } from "@/node/services/taskService";
import { WORKFLOW_CHECKPOINT_RETRY_ERROR_MESSAGE } from "@/common/utils/workflowRetryEligibility";

const mockToolCallOptions: ToolExecutionOptions<unknown> = {
  toolCallId: "test-call-id",
  messages: [],
  context: undefined,
};

type TestWorkflowService = NonNullable<ToolConfiguration["workflowService"]>;

function createWorkflowRun(
  status: WorkflowRunStatus,
  events: WorkflowRunRecord["events"] = []
): WorkflowRunRecord {
  return {
    id: "wfr_demo",
    workspaceId: "parent-workspace",
    workflow: { name: "demo", description: "Demo workflow", scope: "built-in", executable: true },
    source: "export default function workflow() { return null; }\n",
    sourceHash: "sha256:demo",
    args: {},
    status,
    createdAt: "2026-01-01T00:00:00.000Z",
    updatedAt: "2026-01-01T00:00:05.000Z",
    events,
    steps: [],
  };
}

describe("task_await tool", () => {
  it("returns completed workspace-turn results without raw part duplication", async () => {
    using tempDir = new TestTempDir("test-task-await-workspace-turn");
    const baseConfig = createTestToolConfig(tempDir.path, { workspaceId: "parent-workspace" });

    const markWorkspaceTurnTerminalAttentionConsumed = mock(() => Promise.resolve());
    const taskService = {
      listActiveDescendantAgentTaskIds: mock(() => []),
      listWorkspaceTurnTasks: mock(() => []),
      isDescendantAgentTask: mock(() => Promise.resolve(false)),
      getAgentTaskStatuses: mock(() => new Map()),
      markWorkspaceTurnTerminalAttentionConsumed,
      getWorkspaceTurnSnapshot: mock(() =>
        Promise.resolve({
          kind: "workspace_turn",
          handleId: "wst_done",
          ownerWorkspaceId: "parent-workspace",
          workspaceId: "child-workspace",
          turnId: "turn-1",
          status: "completed",
          createdAt: "2026-06-19T00:00:00.000Z",
          updatedAt: "2026-06-19T00:00:10.000Z",
          createdWorkspace: true,
          disposableWorkspace: false,
          title: "Summary",
          reportMarkdown: "Done",
          messageId: "msg_1",
          finalMessageRef: { messageId: "msg_1", partCount: 1, textCharCount: 4 },
          finalMessage: {
            messageId: "msg_1",
            parts: [{ type: "text", text: "Done" }],
            metadata: {},
          },
        })
      ),
    } as unknown as TaskService;

    const tool = createTaskAwaitTool({ ...baseConfig, taskService });
    const result = (await Promise.resolve(
      tool.execute!({ task_ids: ["wst_done"], timeout_secs: 0 }, mockToolCallOptions)
    )) as { results: Array<Record<string, unknown>> };

    expect(result.results).toEqual([
      {
        status: "completed",
        taskId: "wst_done",
        handleKind: "workspace_turn",
        workspaceId: "child-workspace",
        reportMarkdown: "Done",
        title: "Summary",
        messageId: "msg_1",
        finalMessageRef: { messageId: "msg_1", partCount: 1, textCharCount: 4 },
        note: COMPLETED_REPORT_REFETCH_NOTE,
      },
    ]);
    expect(result.results[0]?.finalMessage).toBeUndefined();
    expect(markWorkspaceTurnTerminalAttentionConsumed).toHaveBeenCalledWith({
      ownerWorkspaceId: "parent-workspace",
      consumingWorkspaceId: "parent-workspace",
      handleId: "wst_done",
      status: "completed",
      updatedAt: "2026-06-19T00:00:10.000Z",
    });
  });

  it("surfaces the persisted interrupt reason for interrupted workspace turns", async () => {
    // Queue-cut supersedes settle interrupted with a persisted reason; the owner
    // must be able to distinguish that from an explicit cancellation.
    using tempDir = new TestTempDir("test-task-await-workspace-turn-interrupted");
    const baseConfig = createTestToolConfig(tempDir.path, { workspaceId: "parent-workspace" });

    const taskService = {
      listActiveDescendantAgentTaskIds: mock(() => []),
      listWorkspaceTurnTasks: mock(() => []),
      isDescendantAgentTask: mock(() => Promise.resolve(false)),
      getAgentTaskStatuses: mock(() => new Map()),
      markWorkspaceTurnTerminalAttentionConsumed: mock(() => Promise.resolve()),
      getWorkspaceTurnSnapshot: mock(() =>
        Promise.resolve({
          kind: "workspace_turn",
          handleId: "wst_superseded",
          ownerWorkspaceId: "parent-workspace",
          workspaceId: "child-workspace",
          turnId: "turn-1",
          status: "interrupted",
          error: "Workspace turn superseded by new input in the target workspace",
          createdAt: "2026-06-19T00:00:00.000Z",
          updatedAt: "2026-06-19T00:00:10.000Z",
          createdWorkspace: true,
          disposableWorkspace: false,
        })
      ),
    } as unknown as TaskService;

    const tool = createTaskAwaitTool({ ...baseConfig, taskService });
    const result = (await Promise.resolve(
      tool.execute!({ task_ids: ["wst_superseded"], timeout_secs: 0 }, mockToolCallOptions)
    )) as { results: Array<Record<string, unknown>> };

    expect(result.results).toEqual([
      {
        status: "interrupted",
        taskId: "wst_superseded",
        handleKind: "workspace_turn",
        workspaceId: "child-workspace",
        note: "Workspace turn was interrupted: Workspace turn superseded by new input in the target workspace. The full workspace is preserved.",
      },
    ]);
  });

  it("awaits a nested child continuation through its recorded owner", async () => {
    using tempDir = new TestTempDir("test-task-await-nested-continuation-owner");
    const baseConfig = createTestToolConfig(tempDir.path, { workspaceId: "root-workspace" });
    const continuation = {
      kind: "workspace_turn",
      handleId: "wst_nested",
      ownerWorkspaceId: "parent-task",
      workspaceId: "child-task",
      turnId: "turn-nested",
      status: "running",
      createdAt: "2026-08-10T00:00:00.000Z",
      updatedAt: "2026-08-10T00:00:01.000Z",
      createdWorkspace: false,
      disposableWorkspace: false,
    } as const;
    const waitForWorkspaceTurn = mock(
      (
        _handleId: string,
        _options: {
          timeoutMs?: number;
          abortSignal?: AbortSignal;
          requestingWorkspaceId: string;
          ownerWorkspaceId?: string;
          backgroundOnMessageQueued?: boolean;
        }
      ) =>
        Promise.resolve({
          workspaceId: "child-task",
          updatedAt: "2026-08-10T00:00:01.000Z",
          reportMarkdown: "Nested work completed",
        })
    );
    const markWorkspaceTurnTerminalAttentionConsumed = mock(() => Promise.resolve());
    const taskService = {
      listActiveDescendantAgentTaskIds: mock(() => []),
      isDescendantAgentTask: mock(() => Promise.resolve(true)),
      getAgentTaskExecutionId: mock(() => "wst_nested"),
      getDescendantAgentTaskExecutionSnapshot: mock(() =>
        Promise.resolve({ ownerWorkspaceId: "parent-task", record: continuation })
      ),
      getWorkspaceTurnSnapshot: mock(() => {
        throw new Error("requester-owned snapshot lookup should not be used");
      }),
      waitForWorkspaceTurn,
      markWorkspaceTurnTerminalAttentionConsumed,
    } as unknown as TaskService;

    const tool = createTaskAwaitTool({ ...baseConfig, taskService });
    const result: unknown = await Promise.resolve(
      tool.execute!({ task_ids: ["child-task"] }, mockToolCallOptions)
    );

    expect(result).toEqual({
      results: [
        {
          status: "completed",
          taskId: "child-task",
          reportMarkdown: "Nested work completed",
          title: undefined,
          messageId: undefined,
          finalMessageRef: undefined,
          note: COMPLETED_REPORT_REFETCH_NOTE,
        },
      ],
    });
    expect(waitForWorkspaceTurn).toHaveBeenCalledTimes(1);
    const [observedHandleId, observedOptions] = waitForWorkspaceTurn.mock.calls[0];
    expect(observedHandleId).toBe("wst_nested");
    expect(observedOptions).toMatchObject({
      timeoutMs: 600_000,
      requestingWorkspaceId: "root-workspace",
      ownerWorkspaceId: "parent-task",
      backgroundOnMessageQueued: true,
    });
    expect(observedOptions.abortSignal).toBeInstanceOf(AbortSignal);
    expect(markWorkspaceTurnTerminalAttentionConsumed).toHaveBeenCalledWith({
      ownerWorkspaceId: "parent-task",
      consumingWorkspaceId: "root-workspace",
      handleId: "wst_nested",
      status: "completed",
      updatedAt: "2026-08-10T00:00:01.000Z",
    });
  });

  it("does not mark active workspace-turn awaits consumed", async () => {
    using tempDir = new TestTempDir("test-task-await-active-workspace-turn-consumption");
    const baseConfig = createTestToolConfig(tempDir.path, { workspaceId: "parent-workspace" });
    const markWorkspaceTurnTerminalAttentionConsumed = mock(() => Promise.resolve());
    const runningSnapshot = {
      kind: "workspace_turn",
      handleId: "wst_running",
      ownerWorkspaceId: "parent-workspace",
      workspaceId: "child-running",
      turnId: "turn-running",
      status: "running",
      createdAt: "2026-06-19T00:00:00.000Z",
      updatedAt: "2026-06-19T00:00:00.000Z",
      createdWorkspace: true,
      disposableWorkspace: false,
    } as const;
    const taskService = {
      listActiveDescendantAgentTaskIds: mock(() => []),
      listWorkspaceTurnTasks: mock(() => Promise.resolve([runningSnapshot])),
      isDescendantAgentTask: mock(() => Promise.resolve(false)),
      getAgentTaskStatuses: mock(() => new Map()),
      markWorkspaceTurnTerminalAttentionConsumed,
      getWorkspaceTurnSnapshot: mock(() => Promise.resolve(runningSnapshot)),
    } as unknown as TaskService;

    const tool = createTaskAwaitTool({ ...baseConfig, taskService });
    const result = (await Promise.resolve(
      tool.execute!({ task_ids: ["wst_running"], timeout_secs: 0 }, mockToolCallOptions)
    )) as { results: Array<Record<string, unknown>> };

    expect(result.results).toEqual([
      {
        status: "running",
        taskId: "wst_running",
        handleKind: "workspace_turn",
        workspaceId: "child-running",
        note: "Workspace turn is still running.",
      },
    ]);
    expect(markWorkspaceTurnTerminalAttentionConsumed).not.toHaveBeenCalled();
  });

  it("returns live workspace-turn status when min_completed detaches an unfinished await", async () => {
    using tempDir = new TestTempDir("test-task-await-workspace-turn-detached");
    const baseConfig = createTestToolConfig(tempDir.path, { workspaceId: "parent-workspace" });
    const completedSnapshot = {
      kind: "workspace_turn",
      handleId: "wst_done",
      ownerWorkspaceId: "parent-workspace",
      workspaceId: "child-done",
      turnId: "turn-done",
      status: "completed",
      createdAt: "2026-06-19T00:00:00.000Z",
      updatedAt: "2026-06-19T00:00:10.000Z",
      createdWorkspace: true,
      disposableWorkspace: false,
      reportMarkdown: "Done",
      messageId: "msg_done",
    } as const;
    const runningSnapshot = {
      kind: "workspace_turn",
      handleId: "wst_running",
      ownerWorkspaceId: "parent-workspace",
      workspaceId: "child-running",
      turnId: "turn-running",
      status: "running",
      createdAt: "2026-06-19T00:00:00.000Z",
      updatedAt: "2026-06-19T00:00:00.000Z",
      createdWorkspace: true,
      disposableWorkspace: false,
    } as const;

    const taskService = {
      listActiveDescendantAgentTaskIds: mock(() => []),
      listWorkspaceTurnTasks: mock(() => Promise.resolve([runningSnapshot])),
      isDescendantAgentTask: mock(() => Promise.resolve(false)),
      getAgentTaskStatuses: mock(() => new Map()),
      getWorkspaceTurnSnapshot: mock((_ownerWorkspaceId: string, taskId: string) =>
        Promise.resolve(taskId === "wst_done" ? completedSnapshot : runningSnapshot)
      ),
      waitForWorkspaceTurn: mock(
        (_taskId: string, options: { abortSignal?: AbortSignal }) =>
          new Promise((_resolve, reject) => {
            if (options.abortSignal?.aborted) {
              reject(new Error("Interrupted"));
              return;
            }
            options.abortSignal?.addEventListener("abort", () => reject(new Error("Interrupted")), {
              once: true,
            });
          })
      ),
    } as unknown as TaskService;

    const tool = createTaskAwaitTool({ ...baseConfig, taskService });
    const result = (await Promise.resolve(
      tool.execute!(
        { task_ids: ["wst_done", "wst_running"], min_completed: 1, timeout_secs: 60 },
        mockToolCallOptions
      )
    )) as { results: Array<Record<string, unknown>> };

    expect(result.results).toEqual([
      {
        status: "completed",
        taskId: "wst_done",
        handleKind: "workspace_turn",
        workspaceId: "child-done",
        reportMarkdown: "Done",
        messageId: "msg_done",
        note: COMPLETED_REPORT_REFETCH_NOTE,
      },
      {
        status: "running",
        taskId: "wst_running",
        handleKind: "workspace_turn",
        workspaceId: "child-running",
        note: "Workspace turn await detached; task continues in background.",
      },
    ]);
  });

  it("uses the documented default timeout for workspace-turn awaits when timeout is null", async () => {
    using tempDir = new TestTempDir("test-task-await-workspace-turn-default-timeout");
    const baseConfig = createTestToolConfig(tempDir.path, { workspaceId: "parent-workspace" });
    const runningSnapshot = {
      kind: "workspace_turn",
      handleId: "wst_running",
      ownerWorkspaceId: "parent-workspace",
      workspaceId: "child-running",
      turnId: "turn-running",
      status: "running",
      createdAt: "2026-06-19T00:00:00.000Z",
      updatedAt: "2026-06-19T00:00:00.000Z",
      createdWorkspace: true,
      disposableWorkspace: false,
    } as const;
    let observedTimeoutMs: number | undefined;

    const markWorkspaceTurnTerminalAttentionConsumed = mock(() => Promise.resolve());
    const taskService = {
      listActiveDescendantAgentTaskIds: mock(() => []),
      listWorkspaceTurnTasks: mock(() => Promise.resolve([runningSnapshot])),
      isDescendantAgentTask: mock(() => Promise.resolve(false)),
      getAgentTaskStatuses: mock(() => new Map()),
      getWorkspaceTurnSnapshot: mock(() => Promise.resolve(runningSnapshot)),
      markWorkspaceTurnTerminalAttentionConsumed,
      waitForWorkspaceTurn: mock((_taskId: string, options: { timeoutMs?: number }) => {
        observedTimeoutMs = options.timeoutMs;
        return Promise.resolve({
          workspaceId: "child-running",
          updatedAt: "2026-06-19T00:00:01.000Z",
          reportMarkdown: "Done",
        });
      }),
    } as unknown as TaskService;

    const tool = createTaskAwaitTool({ ...baseConfig, taskService });
    await Promise.resolve(
      tool.execute!({ task_ids: ["wst_running"], timeout_secs: null }, mockToolCallOptions)
    );

    expect(markWorkspaceTurnTerminalAttentionConsumed).toHaveBeenCalledWith({
      ownerWorkspaceId: "parent-workspace",
      consumingWorkspaceId: "parent-workspace",
      handleId: "wst_running",
      status: "completed",
      updatedAt: "2026-06-19T00:00:01.000Z",
    });
    expect(observedTimeoutMs).toBe(600_000);
  });

  it("returns terminal workspace-turn result when timeout races with completion", async () => {
    using tempDir = new TestTempDir("test-task-await-workspace-turn-timeout-terminal");
    const baseConfig = createTestToolConfig(tempDir.path, { workspaceId: "parent-workspace" });
    const runningSnapshot = {
      kind: "workspace_turn",
      handleId: "wst_race",
      ownerWorkspaceId: "parent-workspace",
      workspaceId: "child-race",
      turnId: "turn-race",
      status: "running",
      createdAt: "2026-06-19T00:00:00.000Z",
      updatedAt: "2026-06-19T00:00:00.000Z",
      createdWorkspace: true,
      disposableWorkspace: false,
    } as const;
    const completedSnapshot = {
      ...runningSnapshot,
      status: "completed",
      updatedAt: "2026-06-19T00:00:01.000Z",
      reportMarkdown: "Finished during timeout",
      messageId: "msg_race",
      finalMessageRef: { messageId: "msg_race", textCharCount: 23 },
    } as const;
    const snapshots = [runningSnapshot, completedSnapshot];

    const markWorkspaceTurnTerminalAttentionConsumed = mock(() => Promise.resolve());
    const taskService = {
      listActiveDescendantAgentTaskIds: mock(() => []),
      listWorkspaceTurnTasks: mock(() => Promise.resolve([runningSnapshot])),
      isDescendantAgentTask: mock(() => Promise.resolve(false)),
      getAgentTaskStatuses: mock(() => new Map()),
      getWorkspaceTurnSnapshot: mock(() => Promise.resolve(snapshots.shift() ?? completedSnapshot)),
      markWorkspaceTurnTerminalAttentionConsumed,
      waitForWorkspaceTurn: mock(() => Promise.reject(new Error("timed out"))),
    } as unknown as TaskService;

    const tool = createTaskAwaitTool({ ...baseConfig, taskService });
    const result = (await Promise.resolve(
      tool.execute!({ task_ids: ["wst_race"], timeout_secs: 1 }, mockToolCallOptions)
    )) as { results: Array<Record<string, unknown>> };

    expect(result.results).toEqual([
      {
        status: "completed",
        taskId: "wst_race",
        handleKind: "workspace_turn",
        workspaceId: "child-race",
        reportMarkdown: "Finished during timeout",
        messageId: "msg_race",
        finalMessageRef: { messageId: "msg_race", textCharCount: 23 },
        note: COMPLETED_REPORT_REFETCH_NOTE,
      },
    ]);
    expect(markWorkspaceTurnTerminalAttentionConsumed).toHaveBeenCalledWith({
      ownerWorkspaceId: "parent-workspace",
      consumingWorkspaceId: "parent-workspace",
      handleId: "wst_race",
      status: "completed",
      updatedAt: "2026-06-19T00:00:01.000Z",
    });
  });

  it("returns terminal workspace-turn result when wait rejects after the turn fails", async () => {
    using tempDir = new TestTempDir("test-task-await-workspace-turn-generic-terminal");
    const baseConfig = createTestToolConfig(tempDir.path, { workspaceId: "parent-workspace" });
    const runningSnapshot = {
      kind: "workspace_turn",
      handleId: "wst_failed",
      ownerWorkspaceId: "parent-workspace",
      workspaceId: "child-failed",
      turnId: "turn-failed",
      status: "running",
      createdAt: "2026-06-19T00:00:00.000Z",
      updatedAt: "2026-06-19T00:00:00.000Z",
      createdWorkspace: true,
      disposableWorkspace: false,
    } as const;
    const errorSnapshot = {
      ...runningSnapshot,
      status: "error",
      updatedAt: "2026-06-19T00:00:01.000Z",
      error: "Child turn failed",
    } as const;
    const snapshots = [runningSnapshot, errorSnapshot];
    const markWorkspaceTurnTerminalAttentionConsumed = mock(() => Promise.resolve());
    const taskService = {
      listActiveDescendantAgentTaskIds: mock(() => []),
      listWorkspaceTurnTasks: mock(() => Promise.resolve([runningSnapshot])),
      isDescendantAgentTask: mock(() => Promise.resolve(false)),
      getAgentTaskStatuses: mock(() => new Map()),
      getWorkspaceTurnSnapshot: mock(() => Promise.resolve(snapshots.shift() ?? errorSnapshot)),
      markWorkspaceTurnTerminalAttentionConsumed,
      waitForWorkspaceTurn: mock(() => Promise.reject(new Error("workspace turn settled"))),
    } as unknown as TaskService;

    const tool = createTaskAwaitTool({ ...baseConfig, taskService });
    const result = (await Promise.resolve(
      tool.execute!({ task_ids: ["wst_failed"], timeout_secs: 1 }, mockToolCallOptions)
    )) as { results: Array<Record<string, unknown>> };

    expect(result.results).toEqual([
      {
        status: "error",
        taskId: "wst_failed",
        error: "Child turn failed",
      },
    ]);
    expect(markWorkspaceTurnTerminalAttentionConsumed).toHaveBeenCalledWith({
      ownerWorkspaceId: "parent-workspace",
      consumingWorkspaceId: "parent-workspace",
      handleId: "wst_failed",
      status: "error",
      updatedAt: "2026-06-19T00:00:01.000Z",
    });
  });

  it("includes gitFormatPatch artifacts written during waitForAgentReport", async () => {
    using tempDir = new TestTempDir("test-task-await-tool-artifacts");
    const baseConfig = createTestToolConfig(tempDir.path, { workspaceId: "parent-workspace" });

    const workspaceSessionDir = baseConfig.workspaceSessionDir;
    if (!workspaceSessionDir) {
      throw new Error("Expected workspaceSessionDir to be set in test tool config");
    }
    const artifactsPath = getSubagentGitPatchArtifactsFilePath(workspaceSessionDir);

    const gitFormatPatch = {
      childTaskId: "t1",
      parentWorkspaceId: "parent-workspace",
      createdAtMs: 123,
      status: "ready",
      projectArtifacts: [
        {
          projectPath: "/tmp/project-a",
          projectName: "project-a",
          storageKey: "project-a",
          status: "ready",
          commitCount: 1,
          mboxPath: "/tmp/project-a/series.mbox",
        },
      ],
      readyProjectCount: 1,
      failedProjectCount: 0,
      skippedProjectCount: 0,
      totalCommitCount: 1,
    } as const;

    const taskService = {
      listActiveDescendantAgentTaskIds: mock(() => []),
      isDescendantAgentTask: mock(() => Promise.resolve(true)),
      waitForAgentReport: mock(async (taskId: string) => {
        await fs.promises.writeFile(
          artifactsPath,
          JSON.stringify(
            {
              version: 2,
              artifactsByChildTaskId: { [taskId]: gitFormatPatch },
            },
            null,
            2
          ),
          "utf-8"
        );

        return { reportMarkdown: "ok" };
      }),
    } as unknown as TaskService;

    const tool = createTaskAwaitTool({ ...baseConfig, taskService });

    const result: unknown = await Promise.resolve(
      tool.execute!({ task_ids: ["t1"] }, mockToolCallOptions)
    );

    expect(result).toEqual({
      results: [
        {
          status: "completed",
          taskId: "t1",
          reportMarkdown: "ok",
          title: undefined,
          artifacts: { gitFormatPatch },
          note: COMPLETED_REPORT_REFETCH_NOTE,
        },
      ],
    });
  });

  it("normalizes version 1 gitFormatPatch artifacts into a one-project patch set", async () => {
    using tempDir = new TestTempDir("test-task-await-tool-v1-artifacts");
    const baseConfig = createTestToolConfig(tempDir.path, { workspaceId: "parent-workspace" });

    const workspaceSessionDir = baseConfig.workspaceSessionDir;
    if (!workspaceSessionDir) {
      throw new Error("Expected workspaceSessionDir to be set in test tool config");
    }
    const artifactsPath = getSubagentGitPatchArtifactsFilePath(workspaceSessionDir);

    const taskService = {
      listActiveDescendantAgentTaskIds: mock(() => []),
      isDescendantAgentTask: mock(() => Promise.resolve(true)),
      waitForAgentReport: mock(async (taskId: string) => {
        await fs.promises.writeFile(
          artifactsPath,
          JSON.stringify(
            {
              version: 1,
              artifactsByChildTaskId: {
                [taskId]: {
                  childTaskId: taskId,
                  parentWorkspaceId: "parent-workspace",
                  createdAtMs: 123,
                  status: "ready",
                  commitCount: 1,
                  mboxPath: "/tmp/legacy-series.mbox",
                },
              },
            },
            null,
            2
          ),
          "utf-8"
        );

        return { reportMarkdown: "ok" };
      }),
    } as unknown as TaskService;

    const tool = createTaskAwaitTool({ ...baseConfig, taskService });
    const result = (await Promise.resolve(
      tool.execute!({ task_ids: ["t1"] }, mockToolCallOptions)
    )) as {
      results: Array<{
        status: string;
        artifacts?: { gitFormatPatch?: { projectArtifacts?: unknown[] } };
      }>;
    };

    expect(result.results).toHaveLength(1);
    expect(result.results[0]?.status).toBe("completed");
    expect(result.results[0]?.artifacts?.gitFormatPatch?.projectArtifacts).toEqual([
      expect.objectContaining({
        projectName: "project",
        storageKey: "legacy-single-project",
        status: "ready",
        commitCount: 1,
      }),
    ]);
  });
  it("returns completed results for all awaited tasks", async () => {
    using tempDir = new TestTempDir("test-task-await-tool");
    const baseConfig = createTestToolConfig(tempDir.path, { workspaceId: "parent-workspace" });

    const waitForAgentReport = mock((taskId: string) =>
      Promise.resolve({ reportMarkdown: `report:${taskId}`, title: `title:${taskId}` })
    );
    const taskService = {
      listActiveDescendantAgentTaskIds: mock(() => ["t1", "t2"]),
      isDescendantAgentTask: mock(() => Promise.resolve(true)),
      waitForAgentReport,
    } as unknown as TaskService;

    const tool = createTaskAwaitTool({ ...baseConfig, taskService });

    const result: unknown = await Promise.resolve(
      tool.execute!({ task_ids: ["t1", "t2"] }, mockToolCallOptions)
    );

    expect(result).toEqual({
      results: [
        {
          status: "completed",
          taskId: "t1",
          reportMarkdown: "report:t1",
          title: "title:t1",
          note: COMPLETED_REPORT_REFETCH_NOTE,
        },
        {
          status: "completed",
          taskId: "t2",
          reportMarkdown: "report:t2",
          title: "title:t2",
          note: COMPLETED_REPORT_REFETCH_NOTE,
        },
      ],
    });
    expect(waitForAgentReport).toHaveBeenCalledWith(
      "t1",
      expect.objectContaining({
        backgroundOnMessageQueued: true,
      })
    );
    expect(waitForAgentReport).toHaveBeenCalledWith(
      "t2",
      expect.objectContaining({
        backgroundOnMessageQueued: true,
      })
    );
  });

  it("propagates report-time AI settings into completed results", async () => {
    using tempDir = new TestTempDir("test-task-await-tool-report-settings");
    const baseConfig = createTestToolConfig(tempDir.path, { workspaceId: "parent-workspace" });

    const waitForAgentReport = mock(() =>
      Promise.resolve({
        reportMarkdown: "final report",
        model: "anthropic:claude-opus-5",
        thinkingLevel: "high" as const,
      })
    );
    const taskService = {
      listActiveDescendantAgentTaskIds: mock(() => ["t1"]),
      isDescendantAgentTask: mock(() => Promise.resolve(true)),
      waitForAgentReport,
    } as unknown as TaskService;

    const tool = createTaskAwaitTool({ ...baseConfig, taskService });

    const result: unknown = await Promise.resolve(
      tool.execute!({ task_ids: ["t1"] }, mockToolCallOptions)
    );

    expect(result).toEqual({
      results: [
        {
          status: "completed",
          taskId: "t1",
          reportMarkdown: "final report",
          modelString: "anthropic:claude-opus-5",
          thinkingLevel: "high",
          note: COMPLETED_REPORT_REFETCH_NOTE,
        },
      ],
    });
  });

  it("includes elapsed_ms for completed agent task results when timestamps are available", async () => {
    using tempDir = new TestTempDir("test-task-await-tool-agent-elapsed-completed");
    const baseConfig = createTestToolConfig(tempDir.path, { workspaceId: "parent-workspace" });

    const taskService = {
      listActiveDescendantAgentTaskIds: mock(() => ["t1"]),
      isDescendantAgentTask: mock(() => Promise.resolve(true)),
      waitForAgentReport: mock(() => Promise.resolve({ reportMarkdown: "ok" })),
      getAgentTaskTimestamps: mock(() => ({
        createdAt: "2026-01-01T00:00:00.000Z",
        reportedAt: "2026-01-01T00:00:02.500Z",
      })),
    } as unknown as TaskService;

    const tool = createTaskAwaitTool({ ...baseConfig, taskService });

    const result: unknown = await Promise.resolve(
      tool.execute!({ task_ids: ["t1"] }, mockToolCallOptions)
    );

    expect(result).toEqual({
      results: [
        {
          status: "completed",
          taskId: "t1",
          reportMarkdown: "ok",
          title: undefined,
          elapsed_ms: 2500,
          note: COMPLETED_REPORT_REFETCH_NOTE,
        },
      ],
    });
  });

  it("includes elapsed_ms for active agent task results when timestamps are available", async () => {
    using tempDir = new TestTempDir("test-task-await-tool-agent-elapsed-active");
    const baseConfig = createTestToolConfig(tempDir.path, { workspaceId: "parent-workspace" });
    const nowMs = Date.parse("2026-01-01T00:00:05.000Z");
    const dateNowSpy = spyOn(Date, "now").mockReturnValue(nowMs);

    try {
      const waitForAgentReport = mock(() => {
        throw new Error("waitForAgentReport should not be called for timeout_secs=0");
      });
      const taskService = {
        listActiveDescendantAgentTaskIds: mock(() => ["t1"]),
        isDescendantAgentTask: mock(() => Promise.resolve(true)),
        getAgentTaskStatus: mock(() => "running" as const),
        getAgentTaskTimestamps: mock(() => ({
          createdAt: "2026-01-01T00:00:02.000Z",
        })),
        waitForAgentReport,
      } as unknown as TaskService;

      const tool = createTaskAwaitTool({ ...baseConfig, taskService });

      const result: unknown = await Promise.resolve(
        tool.execute!({ timeout_secs: 0 }, mockToolCallOptions)
      );

      expect(result).toEqual({
        results: [{ status: "running", taskId: "t1", elapsed_ms: 3000 }],
      });
      expect(waitForAgentReport).toHaveBeenCalledTimes(0);
    } finally {
      dateNowSpy.mockRestore();
    }
  });

  it("does not list background bash tasks when explicit agent task IDs are valid", async () => {
    using tempDir = new TestTempDir("test-task-await-tool-explicit-valid-agent-with-bash-manager");
    const baseConfig = createTestToolConfig(tempDir.path, { workspaceId: "parent-workspace" });

    const waitForAgentReport = mock(() => Promise.resolve({ reportMarkdown: "ok" }));
    const listBackgroundProcesses = mock(() => {
      throw new Error(
        "background task discovery should be skipped for valid explicit agent awaits"
      );
    });
    const backgroundProcessManager = {
      list: listBackgroundProcesses,
    } as unknown as BackgroundProcessManager;
    const taskService = {
      listActiveDescendantAgentTaskIds: mock(() => ["t1"]),
      isDescendantAgentTask: mock(() => Promise.resolve(true)),
      waitForAgentReport,
    } as unknown as TaskService;

    const tool = createTaskAwaitTool({
      ...baseConfig,
      backgroundProcessManager,
      taskService,
    });

    const result: unknown = await Promise.resolve(
      tool.execute!({ task_ids: ["t1"] }, mockToolCallOptions)
    );

    expect(result).toEqual({
      results: [
        {
          status: "completed",
          taskId: "t1",
          reportMarkdown: "ok",
          title: undefined,
          note: COMPLETED_REPORT_REFETCH_NOTE,
        },
      ],
    });
    expect(waitForAgentReport).toHaveBeenCalledTimes(1);
    expect(listBackgroundProcesses).toHaveBeenCalledTimes(0);
  });

  it("rejects explicit workflow-owned agent task IDs", async () => {
    using tempDir = new TestTempDir("test-task-await-tool-explicit-workflow-owned-agent");
    const baseConfig = createTestToolConfig(tempDir.path, { workspaceId: "parent-workspace" });

    const waitForAgentReport = mock(() => Promise.resolve({ reportMarkdown: "leaked" }));
    const getAgentTaskStatuses = mock((taskIds: string[]) => {
      expect(taskIds).toEqual(["workflow-task"]);
      return new Map([["workflow-task", { exists: true, taskStatus: "reported" as const }]]);
    });
    const isWorkflowOwnedDescendantAgentTask = mock(
      (_ancestorWorkspaceId: string, taskId: string) => Promise.resolve(taskId === "workflow-task")
    );
    const taskService = {
      listActiveDescendantAgentTaskIds: mock(() => []),
      isDescendantAgentTask: mock(() => Promise.resolve(true)),
      isWorkflowOwnedDescendantAgentTask,
      getAgentTaskStatuses,
      waitForAgentReport,
    } as unknown as TaskService;

    const tool = createTaskAwaitTool({ ...baseConfig, taskService });

    const result = (await Promise.resolve(
      tool.execute!({ task_ids: ["workflow-task"] }, mockToolCallOptions)
    )) as { results: Array<{ status: string; taskId: string }> };

    expect(result.results).toHaveLength(1);
    const firstResult = result.results[0];
    if (!firstResult) {
      throw new Error("Expected one task_await result");
    }
    expect(firstResult.status).toBe("invalid_scope");
    expect(firstResult.taskId).toBe("workflow-task");
    expect(isWorkflowOwnedDescendantAgentTask).toHaveBeenCalledWith(
      "parent-workspace",
      "workflow-task"
    );
    expect(waitForAgentReport).toHaveBeenCalledTimes(0);
  });

  it("falls back to not_found when bash suggestion discovery fails", async () => {
    using tempDir = new TestTempDir("test-task-await-tool-suggestion-fallback-on-list-error");
    const baseConfig = createTestToolConfig(tempDir.path, { workspaceId: "parent-workspace" });

    const waitForAgentReport = mock(() => {
      throw new Error("waitForAgentReport should not be called for hallucinated task IDs");
    });
    const getAgentTaskStatuses = mock((taskIds: string[]) => {
      expect(taskIds).toEqual(["hallucinated"]);
      return new Map([["hallucinated", { exists: false, taskStatus: null }]]);
    });
    const listBackgroundProcesses = mock(() =>
      Promise.reject(new Error("background refresh failed"))
    );
    const backgroundProcessManager = {
      list: listBackgroundProcesses,
    } as unknown as BackgroundProcessManager;
    const taskService = {
      listActiveDescendantAgentTaskIds: mock(() => []),
      isDescendantAgentTask: mock(() => Promise.resolve(false)),
      getAgentTaskStatuses,
      waitForAgentReport,
    } as unknown as TaskService;

    const tool = createTaskAwaitTool({
      ...baseConfig,
      backgroundProcessManager,
      taskService,
    });

    const result: unknown = await Promise.resolve(
      tool.execute!({ task_ids: ["hallucinated"] }, mockToolCallOptions)
    );

    expect(result).toEqual({
      results: [{ status: "not_found", taskId: "hallucinated" }],
    });
    expect(getAgentTaskStatuses).toHaveBeenCalledTimes(1);
    expect(waitForAgentReport).toHaveBeenCalledTimes(0);
    expect(listBackgroundProcesses).toHaveBeenCalledTimes(1);
  });

  it("supports filterDescendantAgentTaskIds without losing this binding", async () => {
    using tempDir = new TestTempDir("test-task-await-tool-this-binding");
    const baseConfig = createTestToolConfig(tempDir.path, { workspaceId: "parent-workspace" });

    const waitForAgentReport = mock(() => Promise.resolve({ reportMarkdown: "ok" }));
    const isDescendantAgentTask = mock(() => Promise.resolve(true));

    const taskService = {
      filterDescendantAgentTaskIds: function (ancestorWorkspaceId: string, taskIds: string[]) {
        expect(this).toBe(taskService);
        expect(ancestorWorkspaceId).toBe("parent-workspace");
        expect(taskIds).toEqual(["t1"]);
        return Promise.resolve(taskIds);
      },
      listActiveDescendantAgentTaskIds: mock(() => []),
      isDescendantAgentTask,
      waitForAgentReport,
    } as unknown as TaskService;

    const tool = createTaskAwaitTool({ ...baseConfig, taskService });

    const result: unknown = await Promise.resolve(
      tool.execute!({ task_ids: ["t1"] }, mockToolCallOptions)
    );

    expect(result).toEqual({
      results: [
        {
          status: "completed",
          taskId: "t1",
          reportMarkdown: "ok",
          title: undefined,
          note: COMPLETED_REPORT_REFETCH_NOTE,
        },
      ],
    });
    expect(isDescendantAgentTask).toHaveBeenCalledTimes(0);
    expect(waitForAgentReport).toHaveBeenCalledTimes(1);
  });

  it("returns an error with descendant task suggestions for hallucinated IDs", async () => {
    using tempDir = new TestTempDir("test-task-await-tool-hallucinated-descendant-suggestions");
    const baseConfig = createTestToolConfig(tempDir.path, { workspaceId: "parent-workspace" });

    const waitForAgentReport = mock(() => {
      throw new Error("waitForAgentReport should not be called for hallucinated task IDs");
    });
    const getAgentTaskStatuses = mock((taskIds: string[]) => {
      expect(taskIds).toEqual(["hallucinated"]);
      return new Map([["hallucinated", { exists: false, taskStatus: null }]]);
    });

    const taskService = {
      listActiveDescendantAgentTaskIds: mock(() => ["real-child"]),
      isDescendantAgentTask: mock(() => Promise.resolve(false)),
      getAgentTaskStatuses,
      waitForAgentReport,
    } as unknown as TaskService;

    const tool = createTaskAwaitTool({ ...baseConfig, taskService });

    const result = (await Promise.resolve(
      tool.execute!({ task_ids: ["hallucinated"] }, mockToolCallOptions)
    )) as { results: Array<{ status: string; taskId: string; error?: string }> };

    expect(result.results).toHaveLength(1);
    expect(result.results[0]).toMatchObject({
      status: "error",
      taskId: "hallucinated",
    });
    const descendantSuggestionError = result.results[0]?.error;
    expect(typeof descendantSuggestionError).toBe("string");
    if (typeof descendantSuggestionError !== "string") {
      throw new Error("Expected hallucinated descendant result to include an error message");
    }
    expect(descendantSuggestionError).toContain("same parallel tool-call batch");
    expect(descendantSuggestionError).toContain("real-child");
    expect(getAgentTaskStatuses).toHaveBeenCalledTimes(1);
    expect(waitForAgentReport).toHaveBeenCalledTimes(0);
  });

  it("returns an error with bash task suggestions for out-of-scope IDs", async () => {
    using tempDir = new TestTempDir("test-task-await-tool-hallucinated-bash-suggestions");
    const baseConfig = createTestToolConfig(tempDir.path, { workspaceId: "parent-workspace" });

    const waitForAgentReport = mock(() => {
      throw new Error("waitForAgentReport should not be called for out-of-scope task IDs");
    });
    const getAgentTaskStatuses = mock((taskIds: string[]) => {
      expect(taskIds).toEqual(["other-workspace"]);
      return new Map([["other-workspace", { exists: true, taskStatus: "running" as const }]]);
    });

    const backgroundProcessManager = {
      list: mock(() => [
        {
          id: "proc-1",
          workspaceId: "parent-workspace",
          status: "running" as const,
          displayName: "Build",
        },
      ]),
    } as unknown as BackgroundProcessManager;

    const taskService = {
      listActiveDescendantAgentTaskIds: mock(() => []),
      isDescendantAgentTask: mock(() => Promise.resolve(false)),
      getAgentTaskStatuses,
      waitForAgentReport,
    } as unknown as TaskService;

    const tool = createTaskAwaitTool({
      ...baseConfig,
      backgroundProcessManager,
      taskService,
    });

    const result = (await Promise.resolve(
      tool.execute!({ task_ids: ["other-workspace"] }, mockToolCallOptions)
    )) as { results: Array<{ status: string; taskId: string; error?: string }> };

    expect(result.results).toHaveLength(1);
    expect(result.results[0]).toMatchObject({
      status: "error",
      taskId: "other-workspace",
    });
    const bashSuggestionError = result.results[0]?.error;
    expect(typeof bashSuggestionError).toBe("string");
    if (typeof bashSuggestionError !== "string") {
      throw new Error("Expected out-of-scope bash suggestion result to include an error message");
    }
    expect(bashSuggestionError).toContain("same parallel tool-call batch");
    expect(bashSuggestionError).toContain("bash:proc-1");
    expect(getAgentTaskStatuses).toHaveBeenCalledTimes(1);
    expect(waitForAgentReport).toHaveBeenCalledTimes(0);
  });

  it("preserves mixed results when one requested ID is real and one is hallucinated", async () => {
    using tempDir = new TestTempDir("test-task-await-tool-mixed-results");
    const baseConfig = createTestToolConfig(tempDir.path, { workspaceId: "parent-workspace" });

    const waitForAgentReport = mock(() => Promise.resolve({ reportMarkdown: "ok" }));
    const getAgentTaskStatuses = mock((taskIds: string[]) => {
      expect(taskIds).toEqual(["hallucinated"]);
      return new Map([["hallucinated", { exists: false, taskStatus: null }]]);
    });

    const taskService = {
      listActiveDescendantAgentTaskIds: mock(() => ["real-child"]),
      isDescendantAgentTask: mock((ancestorWorkspaceId: string, taskId: string) => {
        expect(ancestorWorkspaceId).toBe("parent-workspace");
        return Promise.resolve(taskId === "real-child");
      }),
      getAgentTaskStatuses,
      waitForAgentReport,
    } as unknown as TaskService;

    const tool = createTaskAwaitTool({ ...baseConfig, taskService });

    const result = (await Promise.resolve(
      tool.execute!({ task_ids: ["real-child", "hallucinated"] }, mockToolCallOptions)
    )) as {
      results: Array<{
        status: string;
        taskId: string;
        error?: string;
        reportMarkdown?: string;
        title?: string;
        note?: string;
      }>;
    };

    expect(result.results).toHaveLength(2);
    expect(result.results[0]).toEqual({
      status: "completed",
      taskId: "real-child",
      reportMarkdown: "ok",
      title: undefined,
      note: COMPLETED_REPORT_REFETCH_NOTE,
    });
    expect(result.results[1]).toMatchObject({
      status: "error",
      taskId: "hallucinated",
    });
    const mixedResultError = result.results[1]?.error;
    expect(typeof mixedResultError).toBe("string");
    if (typeof mixedResultError !== "string") {
      throw new Error("Expected mixed-result hallucinated task to include an error message");
    }
    expect(mixedResultError).toContain("real-child");
    expect(waitForAgentReport).toHaveBeenCalledTimes(1);
    expect(waitForAgentReport).toHaveBeenCalledWith("real-child", expect.any(Object));
    expect(getAgentTaskStatuses).toHaveBeenCalledTimes(1);
  });

  it("keeps not_found when no replacement task IDs are available", async () => {
    using tempDir = new TestTempDir("test-task-await-tool-hallucinated-not-found-no-suggestions");
    const baseConfig = createTestToolConfig(tempDir.path, { workspaceId: "parent-workspace" });

    const waitForAgentReport = mock(() => {
      throw new Error("waitForAgentReport should not be called for hallucinated task IDs");
    });
    const getAgentTaskStatuses = mock((taskIds: string[]) => {
      expect(taskIds).toEqual(["hallucinated"]);
      return new Map([["hallucinated", { exists: false, taskStatus: null }]]);
    });

    const taskService = {
      listActiveDescendantAgentTaskIds: mock(() => []),
      isDescendantAgentTask: mock(() => Promise.resolve(false)),
      getAgentTaskStatuses,
      waitForAgentReport,
    } as unknown as TaskService;

    const tool = createTaskAwaitTool({ ...baseConfig, taskService });

    const result: unknown = await Promise.resolve(
      tool.execute!({ task_ids: ["hallucinated"] }, mockToolCallOptions)
    );

    expect(result).toEqual({
      results: [
        {
          status: "not_found",
          taskId: "hallucinated",
        },
      ],
    });
    expect(getAgentTaskStatuses).toHaveBeenCalledTimes(1);
    expect(waitForAgentReport).toHaveBeenCalledTimes(0);
  });

  it("awaits workflow run ids and returns the consolidated workflow result", async () => {
    using tempDir = new TestTempDir("test-task-await-tool-workflow-completed");
    const baseConfig = createTestToolConfig(tempDir.path, { workspaceId: "parent-workspace" });
    const completedRun = createWorkflowRun("completed", [
      {
        sequence: 1,
        type: "status",
        at: "2026-01-01T00:00:01.000Z",
        status: "running",
      },
      {
        sequence: 2,
        type: "result",
        at: "2026-01-01T00:00:04.000Z",
        result: { reportMarkdown: "workflow done", structuredOutput: { ok: true } },
      },
      {
        sequence: 3,
        type: "status",
        at: "2026-01-01T00:00:05.000Z",
        status: "completed",
      },
    ]);

    const markWorkflowRunTerminalAttentionSettled = mock(() => Promise.resolve());
    const taskService = {
      listActiveDescendantAgentTaskIds: mock(() => []),
      isDescendantAgentTask: mock(() => Promise.resolve(false)),
      markWorkflowRunTerminalAttentionSettled,
      waitForAgentReport: mock(() => {
        throw new Error("workflow run IDs should not be treated as agent tasks");
      }),
    } as unknown as TaskService;
    const workflowService = {
      getRun: mock(() => Promise.resolve(completedRun)),
    };
    const tool = createTaskAwaitTool({
      ...baseConfig,
      taskService,
      workflowService: workflowService as unknown as TestWorkflowService,
    });

    const result: unknown = await Promise.resolve(
      tool.execute!({ task_ids: ["wfr_demo"] }, mockToolCallOptions)
    );

    expect(result).toEqual({
      results: [
        {
          status: "completed",
          taskId: "wfr_demo",
          reportMarkdown: "workflow done",
          structuredOutput: { ok: true },
          title: "demo",
          elapsed_ms: 5000,
          note: COMPLETED_REPORT_REFETCH_NOTE,
        },
      ],
    });
    expect(workflowService.getRun).toHaveBeenCalledWith({
      workspaceId: "parent-workspace",
      runId: "wfr_demo",
    });
    expect(markWorkflowRunTerminalAttentionSettled).toHaveBeenCalledWith({
      ownerWorkspaceId: "parent-workspace",
      status: "completed",
      runId: "wfr_demo",
      runUpdatedAt: "2026-01-01T00:00:05.000Z",
      settledAs: "delivered",
    });
  });

  it("returns retry_from_checkpoint guidance for checkpoint-retryable failed workflow runs", async () => {
    using tempDir = new TestTempDir("test-task-await-tool-workflow-retryable-failed");
    const baseConfig = createTestToolConfig(tempDir.path, { workspaceId: "parent-workspace" });
    const failedRun = createWorkflowRun("failed", [
      {
        sequence: 1,
        type: "status",
        at: "2026-01-01T00:00:01.000Z",
        status: "running",
      },
      {
        sequence: 2,
        type: "error",
        at: "2026-01-01T00:00:04.000Z",
        message: WORKFLOW_CHECKPOINT_RETRY_ERROR_MESSAGE,
      },
      {
        sequence: 3,
        type: "status",
        at: "2026-01-01T00:00:05.000Z",
        status: "failed",
      },
    ]);

    const taskService = {
      listActiveDescendantAgentTaskIds: mock(() => []),
      isDescendantAgentTask: mock(() => Promise.resolve(false)),
      waitForAgentReport: mock(() => {
        throw new Error("workflow run IDs should not be treated as agent tasks");
      }),
    } as unknown as TaskService;
    const workflowService = {
      getRun: mock(() => Promise.resolve(failedRun)),
    };
    const tool = createTaskAwaitTool({
      ...baseConfig,
      taskService,
      workflowService: workflowService as unknown as TestWorkflowService,
    });

    const result: unknown = await Promise.resolve(
      tool.execute!({ task_ids: ["wfr_demo"] }, mockToolCallOptions)
    );

    const workflowResult = result as { results: Array<{ error?: string }> };
    expect(workflowResult.results).toHaveLength(1);
    expect(workflowResult.results[0]).toMatchObject({
      status: "error",
      taskId: "wfr_demo",
      elapsed_ms: 5000,
      workflow: { name: "demo", steps: [] },
    });
    expect(workflowResult.results[0]?.error).toContain(WORKFLOW_CHECKPOINT_RETRY_ERROR_MESSAGE);
    expect(workflowResult.results[0]?.error).toContain("workflow_resume");
    expect(workflowResult.results[0]?.error).toContain("retry_from_checkpoint");
  });

  it("does not show checkpoint retry guidance for ordinary failed workflow runs", async () => {
    using tempDir = new TestTempDir("test-task-await-tool-workflow-ordinary-failed");
    const baseConfig = createTestToolConfig(tempDir.path, { workspaceId: "parent-workspace" });
    const failedRun = {
      ...createWorkflowRun("failed", [
        {
          sequence: 1,
          type: "status" as const,
          at: "2026-01-01T00:00:01.000Z",
          status: "running" as const,
        },
        {
          sequence: 2,
          type: "error" as const,
          at: "2026-01-01T00:00:04.000Z",
          message: "boom",
        },
        {
          sequence: 3,
          type: "status" as const,
          at: "2026-01-01T00:00:05.000Z",
          status: "failed" as const,
        },
      ]),
      steps: [
        {
          stepId: "step-one",
          inputHash: "sha256:one",
          status: "completed" as const,
          taskId: "child-task-1",
          startedAt: "2026-01-01T00:00:01.000Z",
          completedAt: "2026-01-01T00:00:02.000Z",
        },
        {
          stepId: "step-two",
          inputHash: "sha256:two",
          status: "failed" as const,
          startedAt: "2026-01-01T00:00:03.000Z",
          error: "boom",
        },
      ],
    };

    const taskService = {
      listActiveDescendantAgentTaskIds: mock(() => []),
      isDescendantAgentTask: mock(() => Promise.resolve(false)),
      waitForAgentReport: mock(() => {
        throw new Error("workflow run IDs should not be treated as agent tasks");
      }),
    } as unknown as TaskService;
    const workflowService = {
      getRun: mock(() => Promise.resolve(failedRun)),
    };
    const tool = createTaskAwaitTool({
      ...baseConfig,
      taskService,
      workflowService: workflowService as unknown as TestWorkflowService,
    });

    const result: unknown = await Promise.resolve(
      tool.execute!({ task_ids: ["wfr_demo"] }, mockToolCallOptions)
    );

    // The compact failure state replaces the full run record: per-step outcomes (with
    // completed steps' taskIds for report re-fetching) instead of the event log/source.
    expect(result).toEqual({
      results: [
        {
          status: "error",
          taskId: "wfr_demo",
          error: "boom",
          elapsed_ms: 5000,
          workflow: {
            name: "demo",
            steps: [
              { stepId: "step-one", status: "completed", taskId: "child-task-1" },
              { stepId: "step-two", status: "failed", error: "boom" },
            ],
          },
        },
      ],
    });
  });

  it("surfaces compact workflow progress for active workflow awaits", async () => {
    using tempDir = new TestTempDir("test-task-await-tool-workflow-progress");
    const baseConfig = createTestToolConfig(tempDir.path, { workspaceId: "parent-workspace" });
    const runningRun = {
      ...createWorkflowRun("running", [
        {
          sequence: 1,
          type: "status" as const,
          at: "2026-01-01T00:00:01.000Z",
          status: "running" as const,
        },
        {
          sequence: 2,
          type: "phase" as const,
          at: "2026-01-01T00:00:02.000Z",
          name: "verify",
          details: { claimCount: 2 },
        },
        {
          sequence: 3,
          type: "task" as const,
          at: "2026-01-01T00:00:03.000Z",
          stepId: "verify-1",
          taskId: "child-task-id",
          title: "Verify claim 1",
          status: "started",
        },
        {
          sequence: 4,
          type: "log" as const,
          at: "2026-01-01T00:00:04.000Z",
          message: "Verification half done",
          data: { verified: 1 },
        },
      ]),
      steps: [
        {
          stepId: "scope",
          inputHash: "sha256:scope",
          status: "completed" as const,
          taskId: "scope-task",
          startedAt: "2026-01-01T00:00:01.000Z",
          completedAt: "2026-01-01T00:00:02.000Z",
        },
        {
          stepId: "verify-1",
          inputHash: "sha256:verify-1",
          status: "started" as const,
          taskId: "child-task-id",
          startedAt: "2026-01-01T00:00:03.000Z",
        },
      ],
    };

    const taskService = {
      listActiveDescendantAgentTaskIds: mock(() => []),
      isDescendantAgentTask: mock(() => Promise.resolve(false)),
      waitForAgentReport: mock(() => {
        throw new Error("workflow run IDs should not be treated as agent tasks");
      }),
    } as unknown as TaskService;
    const workflowService = {
      getRun: mock(() => Promise.resolve(runningRun)),
    };
    const tool = createTaskAwaitTool({
      ...baseConfig,
      taskService,
      workflowService: workflowService as unknown as TestWorkflowService,
    });

    const result: unknown = await Promise.resolve(
      tool.execute!({ task_ids: ["wfr_demo"], timeout_secs: 0 }, mockToolCallOptions)
    );

    const workflowResult = result as { results: Array<Record<string, unknown>> };
    expect(workflowResult.results).toHaveLength(1);
    expect(workflowResult.results[0]).toMatchObject({
      status: "running",
      taskId: "wfr_demo",
      workflowProgress: {
        name: "demo",
        latestPhase: {
          name: "verify",
          at: "2026-01-01T00:00:02.000Z",
        },
        lastProgressAt: "2026-01-01T00:00:04.000Z",
        stepCounts: { started: 1, completed: 1, failed: 0, interrupted: 0 },
      },
    });
    expect(String(workflowResult.results[0]?.note)).toContain("Latest phase: verify");
    expect(JSON.stringify(workflowResult.results[0])).not.toContain("claimCount");
    expect(JSON.stringify(workflowResult.results[0])).not.toContain("recentEvents");
    expect(JSON.stringify(workflowResult.results[0])).not.toContain("child-task-id");
  });

  it("surfaces reservation-only workflow progress while awaiting a run", async () => {
    using tempDir = new TestTempDir("test-task-await-workflow-agent-reservation-progress");
    const baseConfig = createTestToolConfig(tempDir.path, { workspaceId: "root-workspace" });
    const reservingRun = {
      ...createWorkflowRun("running", [
        {
          sequence: 1,
          type: "phase" as const,
          at: "2026-01-01T00:00:01.000Z",
          name: "before-agent",
        },
        {
          sequence: 2,
          type: "agent-step" as const,
          at: "2026-01-01T00:00:02.000Z",
          stepId: "slow-agent",
          inputHash: "sha256:slow-agent",
          status: "reserving" as const,
          title: "Slow agent",
        },
      ]),
      id: "wfr_reserving",
    };
    const taskService = {
      listActiveDescendantAgentTaskIds: mock(() => []),
      isDescendantAgentTask: mock(() => Promise.resolve(false)),
      waitForAgentReport: mock(() => {
        throw new Error("workflow run IDs should not be treated as agent tasks");
      }),
    } as unknown as TaskService;
    const workflowService = { getRun: mock(() => Promise.resolve(reservingRun)) };
    const tool = createTaskAwaitTool({
      ...baseConfig,
      taskService,
      workflowService: workflowService as unknown as TestWorkflowService,
    });

    const result: unknown = await Promise.resolve(
      tool.execute!({ task_ids: ["wfr_reserving"], timeout_secs: 0 }, mockToolCallOptions)
    );

    expect(result).toEqual({
      results: [
        expect.objectContaining({
          taskId: "wfr_reserving",
          status: "running",
          workflowProgress: {
            name: "demo",
            latestPhase: { name: "before-agent", at: "2026-01-01T00:00:01.000Z" },
            lastProgressAt: "2026-01-01T00:00:02.000Z",
            stepCounts: { started: 0, completed: 0, failed: 0, interrupted: 0 },
          },
        }),
      ],
    });
  });

  it("discovers active workflow runs when task_ids is omitted", async () => {
    using tempDir = new TestTempDir("test-task-await-tool-workflow-discovery");
    const baseConfig = createTestToolConfig(tempDir.path, { workspaceId: "parent-workspace" });
    const backgroundedRun = {
      ...createWorkflowRun("backgrounded", [
        {
          sequence: 1,
          type: "status" as const,
          at: "2026-01-01T00:00:01.000Z",
          status: "running" as const,
        },
        {
          sequence: 2,
          type: "status" as const,
          at: "2026-01-01T00:00:02.000Z",
          status: "backgrounded" as const,
        },
      ]),
      id: "wfr_backgrounded",
      status: "backgrounded" as const,
    };

    const taskService = {
      listActiveDescendantAgentTaskIds: mock(() => []),
      isDescendantAgentTask: mock(() => Promise.resolve(false)),
      waitForAgentReport: mock(() => {
        throw new Error("workflow discovery should not wait for agent reports");
      }),
    } as unknown as TaskService;
    const workflowService = {
      listRuns: mock(() => Promise.resolve([backgroundedRun])),
      getRun: mock(() => Promise.resolve(backgroundedRun)),
    };
    const tool = createTaskAwaitTool({
      ...baseConfig,
      taskService,
      workflowService: workflowService as unknown as TestWorkflowService,
    });

    const result: unknown = await Promise.resolve(
      tool.execute!({ timeout_secs: 0 }, mockToolCallOptions)
    );

    const workflowResult = result as {
      results: Array<{ elapsed_ms?: unknown }>;
    };
    expect(typeof workflowResult.results[0]?.elapsed_ms).toBe("number");
    expect(result).toEqual({
      results: [
        {
          status: "backgrounded",
          taskId: "wfr_backgrounded",
          elapsed_ms: workflowResult.results[0]?.elapsed_ms,
          note: "Workflow demo is backgrounded. Use task_await to monitor progress.",
        },
      ],
    });
  });

  it("polls a backgrounded workflow run until the final result is available", async () => {
    using tempDir = new TestTempDir("test-task-await-tool-workflow-poll");
    const baseConfig = createTestToolConfig(tempDir.path, { workspaceId: "parent-workspace" });
    const backgroundedRun = {
      ...createWorkflowRun("backgrounded"),
      id: "wfr_poll",
      status: "backgrounded" as const,
    };
    const completedRun = {
      ...createWorkflowRun("completed", [
        {
          sequence: 1,
          type: "result" as const,
          at: "2026-01-01T00:00:05.000Z",
          result: { reportMarkdown: "poll complete" },
        },
        {
          sequence: 2,
          type: "status" as const,
          at: "2026-01-01T00:00:05.000Z",
          status: "completed" as const,
        },
      ]),
      id: "wfr_poll",
      status: "completed" as const,
    };
    let getRunCalls = 0;

    const taskService = {
      listActiveDescendantAgentTaskIds: mock(() => []),
      isDescendantAgentTask: mock(() => Promise.resolve(false)),
      waitForAgentReport: mock(() => {
        throw new Error("workflow polling should not wait for agent reports");
      }),
    } as unknown as TaskService;
    const workflowService = {
      getRun: mock(() => Promise.resolve(getRunCalls++ === 0 ? backgroundedRun : completedRun)),
    };
    const tool = createTaskAwaitTool({
      ...baseConfig,
      taskService,
      workflowService: workflowService as unknown as TestWorkflowService,
    });

    const result: unknown = await Promise.resolve(
      tool.execute!({ task_ids: ["wfr_poll"], timeout_secs: 1 }, mockToolCallOptions)
    );

    expect(result).toEqual({
      results: [
        {
          status: "completed",
          taskId: "wfr_poll",
          reportMarkdown: "poll complete",
          title: "demo",
          elapsed_ms: 5000,
          note: COMPLETED_REPORT_REFETCH_NOTE,
        },
      ],
    });
    expect(workflowService.getRun).toHaveBeenCalledTimes(2);
  });

  it("returns interrupted status with workflow_resume guidance for interrupted workflow runs", async () => {
    using tempDir = new TestTempDir("test-task-await-tool-workflow-interrupted");
    const baseConfig = createTestToolConfig(tempDir.path, { workspaceId: "parent-workspace" });
    const interruptedRun = createWorkflowRun("interrupted", [
      {
        sequence: 1,
        type: "status",
        at: "2026-01-01T00:00:01.000Z",
        status: "running",
      },
      {
        sequence: 2,
        type: "status",
        at: "2026-01-01T00:00:05.000Z",
        status: "interrupted",
      },
    ]);

    const taskService = {
      listActiveDescendantAgentTaskIds: mock(() => []),
      isDescendantAgentTask: mock(() => Promise.resolve(false)),
      waitForAgentReport: mock(() => {
        throw new Error("workflow run IDs should not be treated as agent tasks");
      }),
    } as unknown as TaskService;
    const workflowService = {
      getRun: mock(() => Promise.resolve(interruptedRun)),
    };
    const tool = createTaskAwaitTool({
      ...baseConfig,
      taskService,
      workflowService: workflowService as unknown as TestWorkflowService,
    });

    const result: unknown = await Promise.resolve(
      tool.execute!({ task_ids: ["wfr_demo"] }, mockToolCallOptions)
    );

    // Interrupted is terminal for awaiting (durable state is kept), so the await resolves
    // immediately instead of polling, and the note points the agent at workflow_resume.
    const interruptedResult = result as { results: Array<{ note?: string }> };
    expect(interruptedResult.results).toHaveLength(1);
    expect(interruptedResult.results[0]).toMatchObject({
      status: "interrupted",
      taskId: "wfr_demo",
    });
    expect(interruptedResult.results[0]?.note).toContain("workflow_resume");
  });

  it("defaults to waiting on all active descendant tasks when task_ids is omitted", async () => {
    using tempDir = new TestTempDir("test-task-await-tool-descendants");
    const baseConfig = createTestToolConfig(tempDir.path, { workspaceId: "parent-workspace" });

    const listActiveDescendantAgentTaskIds = mock(() => ["t1"]);
    const isDescendantAgentTask = mock(() => Promise.resolve(true));
    const waitForAgentReport = mock(() => Promise.resolve({ reportMarkdown: "ok" }));

    const taskService = {
      listActiveDescendantAgentTaskIds,
      isDescendantAgentTask,
      waitForAgentReport,
    } as unknown as TaskService;

    const tool = createTaskAwaitTool({ ...baseConfig, taskService });

    const result: unknown = await Promise.resolve(tool.execute!({}, mockToolCallOptions));

    expect(listActiveDescendantAgentTaskIds).toHaveBeenCalledWith("parent-workspace", {
      excludeWorkflowTasks: true,
    });
    expect(result).toEqual({
      results: [
        {
          status: "completed",
          taskId: "t1",
          reportMarkdown: "ok",
          title: undefined,
          note: COMPLETED_REPORT_REFETCH_NOTE,
        },
      ],
    });
  });

  it("omitted task_ids await a reactivated child only through its stable task ID", async () => {
    using tempDir = new TestTempDir("test-task-await-tool-reactivated-descendant");
    const baseConfig = createTestToolConfig(tempDir.path, { workspaceId: "parent-workspace" });
    const continuation = {
      kind: "workspace_turn",
      handleId: "wst_continuation",
      ownerWorkspaceId: "parent-workspace",
      workspaceId: "child-task",
      turnId: "turn-continuation",
      status: "running",
      createdAt: "2026-08-10T00:00:00.000Z",
      updatedAt: "2026-08-10T00:00:00.000Z",
      createdWorkspace: false,
      disposableWorkspace: false,
    } as const;
    const getWorkspaceTurnSnapshot = mock(() => Promise.resolve(continuation));
    const taskService = {
      listActiveDescendantAgentTaskIds: mock(() => ["child-task"]),
      listWorkspaceTurnTasks: mock(() => Promise.resolve([continuation])),
      isDescendantAgentTask: mock((_ancestorWorkspaceId: string, taskId: string) =>
        Promise.resolve(taskId === "child-task")
      ),
      getAgentTaskExecutionId: mock((taskId: string) =>
        taskId === "child-task" ? "wst_continuation" : null
      ),
      getWorkspaceTurnSnapshot,
    } as unknown as TaskService;

    const tool = createTaskAwaitTool({ ...baseConfig, taskService });
    const result: unknown = await Promise.resolve(
      tool.execute!({ timeout_secs: 0, min_completed: 2 }, mockToolCallOptions)
    );

    expect(result).toEqual({
      results: [
        {
          status: "running",
          taskId: "child-task",
          note: "Workspace turn is still running.",
        },
      ],
    });
    expect(getWorkspaceTurnSnapshot).toHaveBeenCalledTimes(1);
    expect(getWorkspaceTurnSnapshot).toHaveBeenCalledWith("parent-workspace", "wst_continuation", {
      consumingWorkspaceId: "parent-workspace",
    });
  });

  it("returns running status when foreground wait is backgrounded", async () => {
    using tempDir = new TestTempDir("test-task-await-tool-backgrounded");
    const baseConfig = createTestToolConfig(tempDir.path, { workspaceId: "parent-workspace" });

    const waitForAgentReport = mock(() => Promise.reject(new ForegroundWaitBackgroundedError()));
    const getAgentTaskStatus = mock(() => "running" as const);

    const taskService = {
      listActiveDescendantAgentTaskIds: mock(() => []),
      isDescendantAgentTask: mock(() => Promise.resolve(true)),
      waitForAgentReport,
      getAgentTaskStatus,
    } as unknown as TaskService;

    const tool = createTaskAwaitTool({ ...baseConfig, taskService });

    const result: unknown = await Promise.resolve(
      tool.execute!({ task_ids: ["t1"] }, mockToolCallOptions)
    );

    expect(result).toEqual({
      results: [
        {
          status: "running",
          taskId: "t1",
          note: "Task sent to background because a new message was queued. Use task_await to monitor progress.",
        },
      ],
    });
  });

  it("maps wait errors to running/not_found/error statuses", async () => {
    using tempDir = new TestTempDir("test-task-await-tool-errors");
    const baseConfig = createTestToolConfig(tempDir.path, { workspaceId: "parent-workspace" });

    const waitForAgentReport = mock((taskId: string) => {
      if (taskId === "timeout") {
        return Promise.reject(new Error("Timed out waiting for agent_report"));
      }
      if (taskId === "missing") {
        return Promise.reject(new Error("Task not found"));
      }
      return Promise.reject(new Error("Boom"));
    });

    const taskService = {
      listActiveDescendantAgentTaskIds: mock(() => []),
      isDescendantAgentTask: mock(() => Promise.resolve(true)),
      getAgentTaskStatus: mock((taskId: string) => (taskId === "timeout" ? "running" : null)),
      waitForAgentReport,
    } as unknown as TaskService;

    const tool = createTaskAwaitTool({ ...baseConfig, taskService });

    const result: unknown = await Promise.resolve(
      tool.execute!({ task_ids: ["timeout", "missing", "boom"] }, mockToolCallOptions)
    );

    expect(result).toEqual({
      results: [
        { status: "running", taskId: "timeout" },
        { status: "not_found", taskId: "missing" },
        { status: "error", taskId: "boom", error: "Boom" },
      ],
    });
  });

  it("treats timeout_secs=0 as non-blocking for agent tasks", async () => {
    using tempDir = new TestTempDir("test-task-await-tool-timeout-zero");
    const baseConfig = createTestToolConfig(tempDir.path, { workspaceId: "parent-workspace" });

    const waitForAgentReport = mock(() => {
      throw new Error("waitForAgentReport should not be called for timeout_secs=0");
    });
    const getAgentTaskStatus = mock(() => "running" as const);

    const taskService = {
      listActiveDescendantAgentTaskIds: mock(() => ["t1"]),
      isDescendantAgentTask: mock(() => Promise.resolve(true)),
      getAgentTaskStatus,
      waitForAgentReport,
    } as unknown as TaskService;

    const tool = createTaskAwaitTool({ ...baseConfig, taskService });

    const result: unknown = await Promise.resolve(
      tool.execute!({ timeout_secs: 0 }, mockToolCallOptions)
    );

    expect(result).toEqual({ results: [{ status: "running", taskId: "t1" }] });
    expect(waitForAgentReport).toHaveBeenCalledTimes(0);
    expect(getAgentTaskStatus).toHaveBeenCalledWith("t1");
  });

  it("awaits a reawakened child through its stable task ID", async () => {
    using tempDir = new TestTempDir("test-task-await-reactivated-child");
    const baseConfig = createTestToolConfig(tempDir.path, { workspaceId: "parent-workspace" });
    const taskService = {
      listActiveDescendantAgentTaskIds: mock(() => ["child-agent"]),
      isDescendantAgentTask: mock(() => Promise.resolve(true)),
      getAgentTaskExecutionId: mock(() => "wst_internal"),
      getWorkspaceTurnSnapshot: mock(() =>
        Promise.resolve({
          kind: "workspace_turn" as const,
          handleId: "wst_internal",
          ownerWorkspaceId: "parent-workspace",
          workspaceId: "child-agent",
          turnId: "turn",
          status: "running" as const,
          createdAt: "2026-08-10T00:00:00.000Z",
          updatedAt: "2026-08-10T00:00:00.000Z",
          createdWorkspace: false,
          disposableWorkspace: false,
        })
      ),
    } as unknown as TaskService;
    const tool = createTaskAwaitTool({ ...baseConfig, taskService });

    expect(
      await Promise.resolve(
        tool.execute!({ task_ids: ["child-agent"], timeout_secs: 0 }, mockToolCallOptions)
      )
    ).toEqual({
      results: [
        {
          status: "running",
          taskId: "child-agent",
          note: "Workspace turn is still running.",
        },
      ],
    });
  });

  it("returns completed result when timeout_secs=0 and a cached report is available", async () => {
    using tempDir = new TestTempDir("test-task-await-tool-timeout-zero-cached");
    const baseConfig = createTestToolConfig(tempDir.path, { workspaceId: "parent-workspace" });

    const getAgentTaskStatus = mock(() => null);
    const waitForAgentReport = mock(() =>
      Promise.resolve({ reportMarkdown: "ok", title: "cached-title" })
    );

    const taskService = {
      listActiveDescendantAgentTaskIds: mock(() => ["t1"]),
      isDescendantAgentTask: mock(() => Promise.resolve(true)),
      getAgentTaskStatus,
      waitForAgentReport,
    } as unknown as TaskService;

    const tool = createTaskAwaitTool({ ...baseConfig, taskService });

    const result: unknown = await Promise.resolve(
      tool.execute!({ timeout_secs: 0 }, mockToolCallOptions)
    );

    expect(result).toEqual({
      results: [
        {
          status: "completed",
          taskId: "t1",
          reportMarkdown: "ok",
          title: "cached-title",
          note: COMPLETED_REPORT_REFETCH_NOTE,
        },
      ],
    });
    expect(getAgentTaskStatus).toHaveBeenCalledWith("t1");
    expect(waitForAgentReport).toHaveBeenCalledTimes(1);
    expect(waitForAgentReport).toHaveBeenCalledWith(
      "t1",
      expect.objectContaining({
        backgroundOnMessageQueued: true,
      })
    );
  });

  it("returns after the first completion by default, leaving the rest running", async () => {
    using tempDir = new TestTempDir("test-task-await-tool-min-completed-default");
    const baseConfig = createTestToolConfig(tempDir.path, { workspaceId: "parent-workspace" });

    let t1Signal: AbortSignal | undefined;
    let t2Signal: AbortSignal | undefined;
    const waitForAgentReport = mock((taskId: string, opts: { abortSignal?: AbortSignal }) => {
      if (taskId === "t1") {
        t1Signal = opts.abortSignal;
        return Promise.resolve({ reportMarkdown: "report:t1", title: "title:t1" });
      }
      // t2 stays pending until its per-task signal is aborted (the early-stop detach), mirroring
      // how the real waitForAgentReport rejects with "Interrupted" when its waiter is removed.
      t2Signal = opts.abortSignal;
      return new Promise((_resolve, reject) => {
        opts.abortSignal?.addEventListener("abort", () => reject(new Error("Interrupted")), {
          once: true,
        });
      });
    });

    const taskService = {
      listActiveDescendantAgentTaskIds: mock(() => ["t1", "t2"]),
      isDescendantAgentTask: mock(() => Promise.resolve(true)),
      getAgentTaskStatus: mock(() => "running" as const),
      waitForAgentReport,
    } as unknown as TaskService;

    const tool = createTaskAwaitTool({ ...baseConfig, taskService });

    const result: unknown = await Promise.resolve(
      tool.execute!({ task_ids: ["t1", "t2"] }, mockToolCallOptions)
    );

    expect(result).toEqual({
      results: [
        {
          status: "completed",
          taskId: "t1",
          reportMarkdown: "report:t1",
          title: "title:t1",
          note: COMPLETED_REPORT_REFETCH_NOTE,
        },
        { status: "running", taskId: "t2" },
      ],
    });
    // The loser's wait is detached (so TaskService can drop its waiter) without terminating it,
    // while the winner's wait is left untouched.
    expect(t2Signal?.aborted).toBe(true);
    expect(t1Signal?.aborted).toBe(false);
  });

  it("waits for every task when min_completed equals the batch size", async () => {
    using tempDir = new TestTempDir("test-task-await-tool-min-completed-total");
    const baseConfig = createTestToolConfig(tempDir.path, { workspaceId: "parent-workspace" });

    const waitForAgentReport = mock((taskId: string) => {
      if (taskId === "t1") {
        return Promise.resolve({ reportMarkdown: "report:t1", title: "title:t1" });
      }
      // t2 finishes on a later macrotask; min_completed=2 must keep waiting for it rather than
      // returning early after t1.
      return new Promise((resolve) =>
        setTimeout(() => resolve({ reportMarkdown: "report:t2", title: "title:t2" }), 5)
      );
    });

    const taskService = {
      listActiveDescendantAgentTaskIds: mock(() => ["t1", "t2"]),
      isDescendantAgentTask: mock(() => Promise.resolve(true)),
      waitForAgentReport,
    } as unknown as TaskService;

    const tool = createTaskAwaitTool({ ...baseConfig, taskService });

    const result: unknown = await Promise.resolve(
      tool.execute!({ task_ids: ["t1", "t2"], min_completed: 2 }, mockToolCallOptions)
    );

    expect(result).toEqual({
      results: [
        {
          status: "completed",
          taskId: "t1",
          reportMarkdown: "report:t1",
          title: "title:t1",
          note: COMPLETED_REPORT_REFETCH_NOTE,
        },
        {
          status: "completed",
          taskId: "t2",
          reportMarkdown: "report:t2",
          title: "title:t2",
          note: COMPLETED_REPORT_REFETCH_NOTE,
        },
      ],
    });
  });

  it("returns after the k-th completion when min_completed=k", async () => {
    using tempDir = new TestTempDir("test-task-await-tool-min-completed-k");
    const baseConfig = createTestToolConfig(tempDir.path, { workspaceId: "parent-workspace" });

    const waitForAgentReport = mock((taskId: string, opts: { abortSignal?: AbortSignal }) => {
      if (taskId === "t1" || taskId === "t2") {
        return Promise.resolve({ reportMarkdown: `report:${taskId}`, title: `title:${taskId}` });
      }
      return new Promise((_resolve, reject) => {
        opts.abortSignal?.addEventListener("abort", () => reject(new Error("Interrupted")), {
          once: true,
        });
      });
    });

    const taskService = {
      listActiveDescendantAgentTaskIds: mock(() => ["t1", "t2", "t3"]),
      isDescendantAgentTask: mock(() => Promise.resolve(true)),
      getAgentTaskStatus: mock(() => "running" as const),
      waitForAgentReport,
    } as unknown as TaskService;

    const tool = createTaskAwaitTool({ ...baseConfig, taskService });

    const result: unknown = await Promise.resolve(
      tool.execute!({ task_ids: ["t1", "t2", "t3"], min_completed: 2 }, mockToolCallOptions)
    );

    expect(result).toEqual({
      results: [
        {
          status: "completed",
          taskId: "t1",
          reportMarkdown: "report:t1",
          title: "title:t1",
          note: COMPLETED_REPORT_REFETCH_NOTE,
        },
        {
          status: "completed",
          taskId: "t2",
          reportMarkdown: "report:t2",
          title: "title:t2",
          note: COMPLETED_REPORT_REFETCH_NOTE,
        },
        { status: "running", taskId: "t3" },
      ],
    });
  });

  it("clamps min_completed above the awaited count to wait for all", async () => {
    using tempDir = new TestTempDir("test-task-await-tool-min-completed-clamp");
    const baseConfig = createTestToolConfig(tempDir.path, { workspaceId: "parent-workspace" });

    const waitForAgentReport = mock((taskId: string) =>
      Promise.resolve({ reportMarkdown: `report:${taskId}`, title: `title:${taskId}` })
    );

    const taskService = {
      listActiveDescendantAgentTaskIds: mock(() => ["t1", "t2"]),
      isDescendantAgentTask: mock(() => Promise.resolve(true)),
      waitForAgentReport,
    } as unknown as TaskService;

    const tool = createTaskAwaitTool({ ...baseConfig, taskService });

    const result: unknown = await Promise.resolve(
      tool.execute!({ task_ids: ["t1", "t2"], min_completed: 50 }, mockToolCallOptions)
    );

    expect(result).toEqual({
      results: [
        {
          status: "completed",
          taskId: "t1",
          reportMarkdown: "report:t1",
          title: "title:t1",
          note: COMPLETED_REPORT_REFETCH_NOTE,
        },
        {
          status: "completed",
          taskId: "t2",
          reportMarkdown: "report:t2",
          title: "title:t2",
          note: COMPLETED_REPORT_REFETCH_NOTE,
        },
      ],
    });
  });

  it("returns promptly when min_completed can no longer be reached", async () => {
    using tempDir = new TestTempDir("test-task-await-tool-min-completed-unreachable");
    const baseConfig = createTestToolConfig(tempDir.path, { workspaceId: "parent-workspace" });

    const waitForAgentReport = mock((taskId: string) => {
      if (taskId === "t1") {
        return Promise.resolve({ reportMarkdown: "report:t1", title: "title:t1" });
      }
      // t2 fails outright, so two completions are impossible — the call must still return once
      // every task has settled rather than blocking forever.
      return Promise.reject(new Error("Boom"));
    });

    const taskService = {
      listActiveDescendantAgentTaskIds: mock(() => ["t1", "t2"]),
      isDescendantAgentTask: mock(() => Promise.resolve(true)),
      getAgentTaskStatus: mock(() => null),
      waitForAgentReport,
    } as unknown as TaskService;

    const tool = createTaskAwaitTool({ ...baseConfig, taskService });

    const result: unknown = await Promise.resolve(
      tool.execute!({ task_ids: ["t1", "t2"], min_completed: 2 }, mockToolCallOptions)
    );

    expect(result).toEqual({
      results: [
        {
          status: "completed",
          taskId: "t1",
          reportMarkdown: "report:t1",
          title: "title:t1",
          note: COMPLETED_REPORT_REFETCH_NOTE,
        },
        { status: "error", taskId: "t2", error: "Boom" },
      ],
    });
  });

  it("keeps a previously-running task awaitable on a later call", async () => {
    using tempDir = new TestTempDir("test-task-await-tool-min-completed-reawait");
    const baseConfig = createTestToolConfig(tempDir.path, { workspaceId: "parent-workspace" });

    let t2Ready = false;
    const waitForAgentReport = mock((taskId: string, opts: { abortSignal?: AbortSignal }) => {
      if (taskId === "t1") {
        return Promise.resolve({ reportMarkdown: "report:t1", title: "title:t1" });
      }
      if (t2Ready) {
        // Simulates the cached report becoming available after the child finishes.
        return Promise.resolve({ reportMarkdown: "report:t2", title: "title:t2" });
      }
      return new Promise((_resolve, reject) => {
        opts.abortSignal?.addEventListener("abort", () => reject(new Error("Interrupted")), {
          once: true,
        });
      });
    });

    const taskService = {
      listActiveDescendantAgentTaskIds: mock(() => ["t1", "t2"]),
      isDescendantAgentTask: mock(() => Promise.resolve(true)),
      getAgentTaskStatus: mock(() => "running" as const),
      waitForAgentReport,
    } as unknown as TaskService;

    const tool = createTaskAwaitTool({ ...baseConfig, taskService });

    const firstResult: unknown = await Promise.resolve(
      tool.execute!({ task_ids: ["t1", "t2"] }, mockToolCallOptions)
    );
    expect(firstResult).toEqual({
      results: [
        {
          status: "completed",
          taskId: "t1",
          reportMarkdown: "report:t1",
          title: "title:t1",
          note: COMPLETED_REPORT_REFETCH_NOTE,
        },
        { status: "running", taskId: "t2" },
      ],
    });

    t2Ready = true;
    const secondResult: unknown = await Promise.resolve(
      tool.execute!({ task_ids: ["t2"] }, mockToolCallOptions)
    );
    expect(secondResult).toEqual({
      results: [
        {
          status: "completed",
          taskId: "t2",
          reportMarkdown: "report:t2",
          title: "title:t2",
          note: COMPLETED_REPORT_REFETCH_NOTE,
        },
      ],
    });
  });

  it("treats timeout_secs=0 as non-blocking regardless of min_completed", async () => {
    using tempDir = new TestTempDir("test-task-await-tool-min-completed-timeout-zero");
    const baseConfig = createTestToolConfig(tempDir.path, { workspaceId: "parent-workspace" });

    const waitForAgentReport = mock(() => {
      throw new Error("waitForAgentReport should not be called for timeout_secs=0");
    });
    const getAgentTaskStatus = mock(() => "running" as const);

    const taskService = {
      listActiveDescendantAgentTaskIds: mock(() => ["t1", "t2"]),
      isDescendantAgentTask: mock(() => Promise.resolve(true)),
      getAgentTaskStatus,
      waitForAgentReport,
    } as unknown as TaskService;

    const tool = createTaskAwaitTool({ ...baseConfig, taskService });

    const result: unknown = await Promise.resolve(
      tool.execute!(
        { task_ids: ["t1", "t2"], timeout_secs: 0, min_completed: 5 },
        mockToolCallOptions
      )
    );

    expect(result).toEqual({
      results: [
        { status: "running", taskId: "t1" },
        { status: "running", taskId: "t2" },
      ],
    });
    expect(waitForAgentReport).toHaveBeenCalledTimes(0);
  });

  it("surfaces a waiter that rejects outside its internal catches without stalling", async () => {
    using tempDir = new TestTempDir("test-task-await-tool-min-completed-reject");
    const baseConfig = createTestToolConfig(tempDir.path, { workspaceId: "parent-workspace" });

    const waitForAgentReport = mock(() =>
      Promise.resolve({ reportMarkdown: "report:t1", title: "title:t1" })
    );
    // A bash read whose getProcess rejects escapes awaitOne's per-path catches; the call must
    // still settle that task as an error so min_completed=2 can fall back to "all settled".
    const backgroundProcessManager = {
      list: mock(() => Promise.resolve([])),
      getProcess: mock(() => Promise.reject(new Error("proc boom"))),
    } as unknown as BackgroundProcessManager;

    const taskService = {
      listActiveDescendantAgentTaskIds: mock(() => ["t1"]),
      isDescendantAgentTask: mock(() => Promise.resolve(true)),
      waitForAgentReport,
    } as unknown as TaskService;

    const tool = createTaskAwaitTool({ ...baseConfig, backgroundProcessManager, taskService });

    const result: unknown = await Promise.resolve(
      tool.execute!({ task_ids: ["t1", "bash:p1"], min_completed: 2 }, mockToolCallOptions)
    );

    expect(result).toEqual({
      results: [
        {
          status: "completed",
          taskId: "t1",
          reportMarkdown: "report:t1",
          title: "title:t1",
          note: COMPLETED_REPORT_REFETCH_NOTE,
        },
        { status: "error", taskId: "bash:p1", error: "proc boom" },
      ],
    });
  });
});

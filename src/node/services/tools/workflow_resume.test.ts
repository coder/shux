/* eslint-disable @typescript-eslint/await-thenable, @typescript-eslint/no-unsafe-assignment, @typescript-eslint/require-await */
import { describe, expect, mock, test } from "bun:test";
import type { ToolExecutionOptions } from "ai";
import { createWorkflowResumeTool } from "./workflow_resume";
import { TestTempDir, createTestToolConfig } from "./testHelpers";
import { readAgentWorkflowRunReferences } from "@/node/services/agentWorkflowRunReferences";
import { WORKFLOW_CHECKPOINT_RETRY_ERROR_MESSAGE } from "@/common/utils/workflowRetryEligibility";
import type { WorkflowRunRecord } from "@/common/types/workflow";
import type { TaskService } from "@/node/services/taskService";
import type { WorkflowRunAttachedEvent } from "@/common/types/stream";

const mockToolCallOptions: ToolExecutionOptions<unknown> = {
  toolCallId: "test-call-id",
  messages: [],
  context: undefined,
};

function buildRun(overrides: Partial<WorkflowRunRecord> = {}): WorkflowRunRecord {
  return {
    id: "wfr_resume_me",
    workspaceId: "workspace-1",
    workflow: {
      name: "deep-research",
      description: "Deep research",
      scope: "built-in",
      executable: true,
    },
    source: "export default function workflow() { return null; }",
    sourceHash: "sha256:test",
    args: {},
    status: "interrupted",
    createdAt: "2026-05-29T00:00:00.000Z",
    updatedAt: "2026-05-29T00:00:01.000Z",
    events: [
      { sequence: 1, type: "status", at: "2026-05-29T00:00:00.000Z", status: "running" },
      { sequence: 2, type: "status", at: "2026-05-29T00:00:01.000Z", status: "interrupted" },
    ],
    steps: [],
    ...overrides,
  };
}

// Checkpoint-retry-eligible failure: eligibility requires the latest error event to be the
// canonical "Execution interrupted" message (see workflowRetryEligibility).
function buildFailedRun(
  errorMessage: string = WORKFLOW_CHECKPOINT_RETRY_ERROR_MESSAGE
): WorkflowRunRecord {
  return buildRun({
    status: "failed",
    events: [
      { sequence: 1, type: "status", at: "2026-05-29T00:00:00.000Z", status: "running" },
      { sequence: 2, type: "error", at: "2026-05-29T00:00:01.000Z", message: errorMessage },
      { sequence: 3, type: "status", at: "2026-05-29T00:00:01.000Z", status: "failed" },
    ],
  });
}

interface WorkflowServiceMockOverrides {
  getRun?: ReturnType<typeof mock>;
  resumeRun?: ReturnType<typeof mock>;
  resumeRunInBackground?: ReturnType<typeof mock>;
  retryRunFromCheckpoint?: ReturnType<typeof mock>;
  retryRunFromCheckpointInBackground?: ReturnType<typeof mock>;
}

function buildWorkflowService(overrides: WorkflowServiceMockOverrides = {}) {
  return {
    startWorkflow: mock(async () => {
      throw new Error("workflow_resume must not start new workflows");
    }),
    getRun: overrides.getRun ?? mock(async () => buildRun()),
    resumeRun:
      overrides.resumeRun ??
      mock(async () => ({
        runId: "wfr_resume_me",
        status: "completed" as const,
        result: { reportMarkdown: "resumed" },
      })),
    resumeRunInBackground:
      overrides.resumeRunInBackground ??
      mock(async () => ({ runId: "wfr_resume_me", status: "running" as const, result: null })),
    retryRunFromCheckpoint:
      overrides.retryRunFromCheckpoint ??
      mock(async () => ({
        runId: "wfr_resume_me",
        status: "completed" as const,
        result: { reportMarkdown: "retried" },
      })),
    retryRunFromCheckpointInBackground:
      overrides.retryRunFromCheckpointInBackground ??
      mock(async () => ({ runId: "wfr_resume_me", status: "running" as const, result: null })),
  };
}

describe("workflow_resume tool", () => {
  test("resumes an interrupted run in the foreground with the tool abort signal", async () => {
    using tempDir = new TestTempDir("test-workflow-resume-fg");
    const workflowService = buildWorkflowService();
    const abortController = new AbortController();
    const tool = createWorkflowResumeTool({
      ...createTestToolConfig(tempDir.path, { workspaceId: "workspace-1" }),
      trusted: true,
      workflowService,
    });

    const result = await tool.execute!(
      { run_id: "wfr_resume_me", run_in_background: false, mode: null },
      { ...mockToolCallOptions, abortSignal: abortController.signal }
    );

    expect(workflowService.resumeRun).toHaveBeenCalledWith({
      workspaceId: "workspace-1",
      runId: "wfr_resume_me",
      projectTrusted: true,
      abortSignal: abortController.signal,
    });
    expect(workflowService.retryRunFromCheckpoint).not.toHaveBeenCalled();
    expect(result).toEqual({
      status: "completed",
      runId: "wfr_resume_me",
      result: { reportMarkdown: "resumed" },
      mode: "resume",
      run: expect.objectContaining({ id: "wfr_resume_me" }),
    });
  });

  test("emits a workflow run attachment before resuming", async () => {
    using tempDir = new TestTempDir("test-workflow-resume-attached");
    const run = buildRun({ id: "wfr_resume_attached" });
    const emittedEvents: WorkflowRunAttachedEvent[] = [];
    let emitChatEventSettled = false;
    let resumeWaitedForEmission = false;
    const workflowService = buildWorkflowService({
      getRun: mock(async () => run),
      resumeRun: mock(async () => {
        resumeWaitedForEmission = emitChatEventSettled;
        return { runId: run.id, status: "running" as const, result: null };
      }),
    });
    const tool = createWorkflowResumeTool({
      ...createTestToolConfig(tempDir.path, { workspaceId: "workspace-1" }),
      trusted: true,
      emitChatEvent: async (event) => {
        await Promise.resolve();
        if (event.type === "workflow-run-attached") {
          emittedEvents.push(event);
          emitChatEventSettled = true;
        }
      },
      workflowService,
    });

    await tool.execute!(
      { run_id: run.id, run_in_background: false, mode: null },
      mockToolCallOptions
    );

    expect(resumeWaitedForEmission).toBe(true);
    expect(emittedEvents).toHaveLength(1);
    expect(emittedEvents[0]).toMatchObject({
      type: "workflow-run-attached",
      workspaceId: "workspace-1",
      toolCallId: "test-call-id",
      runId: run.id,
      run: expect.objectContaining({ id: run.id, status: "interrupted" }),
    });
    expect(typeof emittedEvents[0]?.timestamp).toBe("number");
  });

  test("resumes in background and records an agent workflow run reference", async () => {
    using tempDir = new TestTempDir("test-workflow-resume-bg");
    // The reference must NOT be durable before the dispatch: the run still sits in its old
    // terminal state until the dispatch restarts it, and a pre-dispatch reference would let a
    // crash in that window replay the stale failure/interruption as a current wake.
    let referenceDurableAtDispatch = false;
    const workflowService = buildWorkflowService({
      resumeRunInBackground: mock(async () => {
        const references = await readAgentWorkflowRunReferences(tempDir.path);
        referenceDurableAtDispatch = references.some(
          (reference) => reference.runId === "wfr_resume_me"
        );
        return { runId: "wfr_resume_me", status: "running" as const, result: null };
      }),
    });
    const tool = createWorkflowResumeTool({
      ...createTestToolConfig(tempDir.path, { workspaceId: "workspace-1" }),
      trusted: false,
      workflowService,
    });

    const result = await tool.execute!(
      { run_id: "wfr_resume_me", run_in_background: true, mode: "resume" },
      mockToolCallOptions
    );

    expect(workflowService.resumeRunInBackground).toHaveBeenCalledWith({
      workspaceId: "workspace-1",
      runId: "wfr_resume_me",
      projectTrusted: false,
    });
    expect(workflowService.resumeRun).not.toHaveBeenCalled();
    expect(referenceDurableAtDispatch).toBe(false);
    const references = await readAgentWorkflowRunReferences(tempDir.path);
    expect(references.map((reference) => reference.runId)).toContain("wfr_resume_me");
    expect(result).toMatchObject({ status: "running", runId: "wfr_resume_me", mode: "resume" });
  });

  test("returns the existing result for a completed run without re-running", async () => {
    using tempDir = new TestTempDir("test-workflow-resume-completed");
    const completedRun = buildRun({
      status: "completed",
      events: [
        { sequence: 1, type: "status", at: "2026-05-29T00:00:00.000Z", status: "running" },
        {
          sequence: 2,
          type: "result",
          at: "2026-05-29T00:00:01.000Z",
          result: { reportMarkdown: "already done" },
        },
        { sequence: 3, type: "status", at: "2026-05-29T00:00:01.000Z", status: "completed" },
      ],
    });
    const workflowService = buildWorkflowService({ getRun: mock(async () => completedRun) });
    const tool = createWorkflowResumeTool({
      ...createTestToolConfig(tempDir.path, { workspaceId: "workspace-1" }),
      trusted: true,
      workflowService,
    });

    const result = await tool.execute!(
      { run_id: "wfr_resume_me", run_in_background: false, mode: null },
      mockToolCallOptions
    );

    expect(workflowService.resumeRun).not.toHaveBeenCalled();
    expect(workflowService.resumeRunInBackground).not.toHaveBeenCalled();
    expect(result).toMatchObject({
      status: "completed",
      runId: "wfr_resume_me",
      result: { reportMarkdown: "already done" },
      mode: "resume",
      note: expect.stringContaining("already completed"),
    });
  });

  test("marks terminal attention settled when returning an already-completed run's result", async () => {
    using tempDir = new TestTempDir("test-workflow-resume-consumed");
    const completedRun = buildRun({
      status: "completed",
      events: [
        { sequence: 1, type: "status", at: "2026-05-29T00:00:00.000Z", status: "running" },
        {
          sequence: 2,
          type: "result",
          at: "2026-05-29T00:00:01.000Z",
          result: { reportMarkdown: "already done" },
        },
        { sequence: 3, type: "status", at: "2026-05-29T00:00:01.000Z", status: "completed" },
      ],
    });
    const workflowService = buildWorkflowService({ getRun: mock(async () => completedRun) });
    const markWorkflowRunTerminalAttentionSettled = mock(() => Promise.resolve());
    const tool = createWorkflowResumeTool({
      ...createTestToolConfig(tempDir.path, { workspaceId: "workspace-1" }),
      trusted: true,
      workflowService,
      taskService: { markWorkflowRunTerminalAttentionSettled } as unknown as TaskService,
    });

    await tool.execute!(
      { run_id: "wfr_resume_me", run_in_background: false, mode: null },
      mockToolCallOptions
    );

    expect(markWorkflowRunTerminalAttentionSettled).toHaveBeenCalledWith({
      ownerWorkspaceId: "workspace-1",
      runId: "wfr_resume_me",
      status: "completed",
      runUpdatedAt: completedRun.updatedAt,
      settledAs: "delivered",
    });
  });

  test("does not mark terminal attention settled for background dispatches", async () => {
    using tempDir = new TestTempDir("test-workflow-resume-background-no-consume");
    // The refresh after a background dispatch can still observe the stale pre-dispatch failed
    // status; settling it would absorb the retried run's future terminal wake.
    const workflowService = buildWorkflowService({ getRun: mock(async () => buildFailedRun()) });
    const markWorkflowRunTerminalAttentionSettled = mock(() => Promise.resolve());
    const tool = createWorkflowResumeTool({
      ...createTestToolConfig(tempDir.path, { workspaceId: "workspace-1" }),
      trusted: true,
      workflowService,
      taskService: { markWorkflowRunTerminalAttentionSettled } as unknown as TaskService,
    });

    await tool.execute!(
      { run_id: "wfr_resume_me", run_in_background: true, mode: "retry_from_checkpoint" },
      mockToolCallOptions
    );

    expect(markWorkflowRunTerminalAttentionSettled).not.toHaveBeenCalled();
  });

  test("marks terminal attention settled when a foreground retry finishes terminal", async () => {
    using tempDir = new TestTempDir("test-workflow-resume-foreground-consume");
    const failedRun = buildFailedRun();
    const completedRun = buildRun({
      status: "completed",
      events: [
        { sequence: 1, type: "status", at: "2026-05-29T00:00:00.000Z", status: "running" },
        { sequence: 2, type: "status", at: "2026-05-29T00:00:02.000Z", status: "completed" },
      ],
    });
    let getRunCalls = 0;
    const workflowService = buildWorkflowService({
      getRun: mock(async () => {
        getRunCalls += 1;
        return getRunCalls === 1 ? failedRun : completedRun;
      }),
      retryRunFromCheckpoint: mock(async () => ({
        runId: "wfr_resume_me",
        status: "completed" as const,
        result: { reportMarkdown: "retried" },
      })),
    });
    const markWorkflowRunTerminalAttentionSettled = mock(() => Promise.resolve());
    const tool = createWorkflowResumeTool({
      ...createTestToolConfig(tempDir.path, { workspaceId: "workspace-1" }),
      trusted: true,
      workflowService,
      taskService: { markWorkflowRunTerminalAttentionSettled } as unknown as TaskService,
    });

    await tool.execute!(
      { run_id: "wfr_resume_me", run_in_background: false, mode: "retry_from_checkpoint" },
      mockToolCallOptions
    );

    expect(markWorkflowRunTerminalAttentionSettled).toHaveBeenCalledWith({
      ownerWorkspaceId: "workspace-1",
      runId: "wfr_resume_me",
      status: "completed",
      runUpdatedAt: completedRun.updatedAt,
      settledAs: "delivered",
    });
  });

  test("skips the settled marker when the refresh read fails but still returns the result", async () => {
    using tempDir = new TestTempDir("test-workflow-resume-refresh-failure-consume");
    // WorkflowService.getRun collapses transient read failures to null. The marker binds to the
    // run's terminal generation (updatedAt), which is unknowable without the refreshed record:
    // the terminal result still returns to the model, and the wake settles as consumed from
    // history evidence on the next scan instead of being marked here.
    let getRunCalls = 0;
    const workflowService = buildWorkflowService({
      getRun: mock(async () => {
        getRunCalls += 1;
        return getRunCalls === 1 ? buildRun() : null;
      }),
      resumeRun: mock(async () => ({
        runId: "wfr_resume_me",
        status: "completed" as const,
        result: { reportMarkdown: "resumed" },
      })),
    });
    const markWorkflowRunTerminalAttentionSettled = mock(() => Promise.resolve());
    const tool = createWorkflowResumeTool({
      ...createTestToolConfig(tempDir.path, { workspaceId: "workspace-1" }),
      trusted: true,
      workflowService,
      taskService: { markWorkflowRunTerminalAttentionSettled } as unknown as TaskService,
    });

    const result = await tool.execute!(
      { run_id: "wfr_resume_me", run_in_background: false, mode: null },
      mockToolCallOptions
    );

    expect(markWorkflowRunTerminalAttentionSettled).not.toHaveBeenCalled();
    expect(result).toMatchObject({ status: "completed", runId: "wfr_resume_me", mode: "resume" });
  });

  test("rejects default resume of a failed run with checkpoint retry guidance", async () => {
    using tempDir = new TestTempDir("test-workflow-resume-failed");
    const workflowService = buildWorkflowService({ getRun: mock(async () => buildFailedRun()) });
    const tool = createWorkflowResumeTool({
      ...createTestToolConfig(tempDir.path, { workspaceId: "workspace-1" }),
      trusted: true,
      workflowService,
    });

    await expect(
      Promise.resolve(
        tool.execute!(
          { run_id: "wfr_resume_me", run_in_background: false, mode: null },
          mockToolCallOptions
        )
      )
    ).rejects.toThrow(/retry_from_checkpoint/);
    expect(workflowService.resumeRun).not.toHaveBeenCalled();
    expect(workflowService.retryRunFromCheckpoint).not.toHaveBeenCalled();
  });

  test("explains when a failed run cannot be retried and suggests a fresh run", async () => {
    using tempDir = new TestTempDir("test-workflow-resume-failed-ineligible");
    const workflowService = buildWorkflowService({
      getRun: mock(async () => buildFailedRun("SyntaxError: Unexpected token")),
    });
    const tool = createWorkflowResumeTool({
      ...createTestToolConfig(tempDir.path, { workspaceId: "workspace-1" }),
      trusted: true,
      workflowService,
    });

    await expect(
      Promise.resolve(
        tool.execute!(
          { run_id: "wfr_resume_me", run_in_background: false, mode: null },
          mockToolCallOptions
        )
      )
    ).rejects.toThrow(/start a fresh run with workflow_run/);
    expect(workflowService.resumeRun).not.toHaveBeenCalled();
  });

  test("retries a failed run from checkpoint when explicitly requested", async () => {
    using tempDir = new TestTempDir("test-workflow-resume-retry");
    const workflowService = buildWorkflowService({ getRun: mock(async () => buildFailedRun()) });
    const abortController = new AbortController();
    const tool = createWorkflowResumeTool({
      ...createTestToolConfig(tempDir.path, { workspaceId: "workspace-1" }),
      trusted: true,
      workflowService,
    });

    const result = await tool.execute!(
      { run_id: "wfr_resume_me", run_in_background: false, mode: "retry_from_checkpoint" },
      { ...mockToolCallOptions, abortSignal: abortController.signal }
    );

    expect(workflowService.retryRunFromCheckpoint).toHaveBeenCalledWith({
      workspaceId: "workspace-1",
      runId: "wfr_resume_me",
      projectTrusted: true,
      abortSignal: abortController.signal,
    });
    expect(workflowService.resumeRun).not.toHaveBeenCalled();
    expect(result).toMatchObject({
      status: "completed",
      runId: "wfr_resume_me",
      result: { reportMarkdown: "retried" },
      mode: "retry_from_checkpoint",
    });
  });

  test("retries a failed run from checkpoint in the background and records a run reference", async () => {
    using tempDir = new TestTempDir("test-workflow-resume-retry-bg");
    const workflowService = buildWorkflowService({ getRun: mock(async () => buildFailedRun()) });
    const tool = createWorkflowResumeTool({
      ...createTestToolConfig(tempDir.path, { workspaceId: "workspace-1" }),
      trusted: false,
      workflowService,
    });

    const result = await tool.execute!(
      { run_id: "wfr_resume_me", run_in_background: true, mode: "retry_from_checkpoint" },
      mockToolCallOptions
    );

    expect(workflowService.retryRunFromCheckpointInBackground).toHaveBeenCalledWith({
      workspaceId: "workspace-1",
      runId: "wfr_resume_me",
      projectTrusted: false,
    });
    expect(workflowService.retryRunFromCheckpoint).not.toHaveBeenCalled();
    expect(workflowService.resumeRun).not.toHaveBeenCalled();
    expect(workflowService.resumeRunInBackground).not.toHaveBeenCalled();
    const references = await readAgentWorkflowRunReferences(tempDir.path);
    expect(references.map((reference) => reference.runId)).toContain("wfr_resume_me");
    expect(result).toMatchObject({
      status: "running",
      runId: "wfr_resume_me",
      mode: "retry_from_checkpoint",
    });
    // The static getRun mock still reports the pre-dispatch "failed" status after dispatch, so
    // the stale run snapshot must be omitted from the background-dispatch result.
    expect(result).not.toHaveProperty("run");
  });

  test("rejects checkpoint retry of an ineligible failed run", async () => {
    using tempDir = new TestTempDir("test-workflow-resume-retry-unsafe");
    // An unfinished patch step makes checkpoint retry unsafe.
    const unsafeRun = buildRun({
      status: "failed",
      events: [
        {
          sequence: 1,
          type: "patch",
          at: "2026-05-29T00:00:00.000Z",
          stepId: "patch",
          sourceTaskId: "t",
          status: "started",
        },
        { sequence: 2, type: "status", at: "2026-05-29T00:00:01.000Z", status: "failed" },
      ],
    });
    const workflowService = buildWorkflowService({ getRun: mock(async () => unsafeRun) });
    const tool = createWorkflowResumeTool({
      ...createTestToolConfig(tempDir.path, { workspaceId: "workspace-1" }),
      trusted: true,
      workflowService,
    });

    await expect(
      Promise.resolve(
        tool.execute!(
          { run_id: "wfr_resume_me", run_in_background: false, mode: "retry_from_checkpoint" },
          mockToolCallOptions
        )
      )
    ).rejects.toThrow(/cannot be retried from checkpoint/i);
    expect(workflowService.retryRunFromCheckpoint).not.toHaveBeenCalled();
  });

  test("rejects checkpoint retry of a non-failed run", async () => {
    using tempDir = new TestTempDir("test-workflow-resume-retry-wrong-status");
    const workflowService = buildWorkflowService();
    const tool = createWorkflowResumeTool({
      ...createTestToolConfig(tempDir.path, { workspaceId: "workspace-1" }),
      trusted: true,
      workflowService,
    });

    await expect(
      Promise.resolve(
        tool.execute!(
          { run_id: "wfr_resume_me", run_in_background: false, mode: "retry_from_checkpoint" },
          mockToolCallOptions
        )
      )
    ).rejects.toThrow(/requires a failed workflow run/);
    expect(workflowService.retryRunFromCheckpoint).not.toHaveBeenCalled();
  });

  test("guides toward task_await when the run is already active", async () => {
    using tempDir = new TestTempDir("test-workflow-resume-active");
    const workflowService = buildWorkflowService({
      getRun: mock(async () => buildRun({ status: "running" })),
      resumeRun: mock(async () => {
        throw new Error("Workflow run is already active: wfr_resume_me");
      }),
    });
    const tool = createWorkflowResumeTool({
      ...createTestToolConfig(tempDir.path, { workspaceId: "workspace-1" }),
      trusted: true,
      workflowService,
    });

    await expect(
      Promise.resolve(
        tool.execute!(
          { run_id: "wfr_resume_me", run_in_background: false, mode: null },
          mockToolCallOptions
        )
      )
    ).rejects.toThrow(/task_await/);
  });

  test("rejects non-workflow task IDs", async () => {
    using tempDir = new TestTempDir("test-workflow-resume-bad-id");
    const workflowService = buildWorkflowService();
    const tool = createWorkflowResumeTool({
      ...createTestToolConfig(tempDir.path, { workspaceId: "workspace-1" }),
      trusted: true,
      workflowService,
    });

    await expect(
      Promise.resolve(
        tool.execute!(
          { run_id: "bash:proc-1", run_in_background: false, mode: null },
          mockToolCallOptions
        )
      )
    ).rejects.toThrow(/requires a workflow run ID/);
    expect(workflowService.getRun).not.toHaveBeenCalled();
  });

  test("reports runs that are missing or outside the workspace as not found", async () => {
    using tempDir = new TestTempDir("test-workflow-resume-not-found");
    const workflowService = buildWorkflowService({ getRun: mock(async () => null) });
    const tool = createWorkflowResumeTool({
      ...createTestToolConfig(tempDir.path, { workspaceId: "workspace-1" }),
      trusted: true,
      workflowService,
    });

    await expect(
      Promise.resolve(
        tool.execute!(
          { run_id: "wfr_missing", run_in_background: false, mode: null },
          mockToolCallOptions
        )
      )
    ).rejects.toThrow(/not found in this workspace/);
  });

  test("requires the workflow service", async () => {
    using tempDir = new TestTempDir("test-workflow-resume-missing-service");
    const tool = createWorkflowResumeTool({
      ...createTestToolConfig(tempDir.path, { workspaceId: "workspace-1" }),
    });

    await expect(
      Promise.resolve(
        tool.execute!(
          { run_id: "wfr_resume_me", run_in_background: false, mode: null },
          mockToolCallOptions
        )
      )
    ).rejects.toThrow(/workflowService/);
  });
});

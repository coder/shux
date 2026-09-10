/* eslint-disable @typescript-eslint/await-thenable, @typescript-eslint/no-unsafe-assignment, @typescript-eslint/require-await */
import * as fs from "node:fs/promises";
import * as path from "node:path";

import { describe, expect, mock, test } from "bun:test";
import type { ToolExecutionOptions } from "ai";
import {
  COMPLETED_REPORT_REFETCH_NOTE,
  WorkflowRunToolResultSchema,
} from "@/common/utils/tools/toolDefinitions";
import { createWorkflowRunTool } from "./workflow_run";
import { LocalRuntime } from "@/node/runtime/LocalRuntime";
import { resolveWorkflowScript } from "@/node/services/workflows/workflowScriptResolver";
import { TestTempDir, createTestToolConfig, writeProjectSkill } from "./testHelpers";
import { readAgentWorkflowRunReferences } from "@/node/services/agentWorkflowRunReferences";
import type { TaskService } from "@/node/services/taskService";
import type { ToolConfiguration } from "@/common/utils/tools/tools";
import type { WorkflowRunAttachedEvent } from "@/common/types/stream";
import type { WorkflowRunRecord } from "@/common/types/workflow";

type BackgroundStartInput = Parameters<
  NonNullable<NonNullable<ToolConfiguration["workflowService"]>["startWorkflowInBackground"]>
>[0];

const mockToolCallOptions: ToolExecutionOptions<unknown> = {
  toolCallId: "test-call-id",
  messages: [],
  context: undefined,
};

async function writeWorkflowScript(root: string): Promise<string> {
  const relativePath = "workflows/deep-research.js";
  const target = path.join(root, relativePath);
  await fs.mkdir(path.dirname(target), { recursive: true });
  await fs.writeFile(target, "export default function workflow() { return null; }\n", "utf-8");
  return `./${relativePath}`;
}

function createWorkflowRunRecord(overrides: Partial<WorkflowRunRecord> = {}): WorkflowRunRecord {
  return {
    id: "wfr_123",
    workspaceId: "workspace-1",
    workflow: {
      name: "deep-research",
      description: "Deep research",
      scope: "project",
      executable: true,
    },
    source: "export default function workflow() { return null; }",
    sourceHash: "sha256:test",
    args: { topic: "workflow tools" },
    status: "pending",
    createdAt: "2026-05-29T00:00:00.000Z",
    updatedAt: "2026-05-29T00:00:00.000Z",
    events: [
      {
        sequence: 1,
        type: "status",
        at: "2026-05-29T00:00:00.000Z",
        status: "pending",
      },
    ],
    steps: [],
    ...overrides,
  };
}

describe("workflow_run tool", () => {
  test("starts an explicit script_path workflow through WorkflowService", async () => {
    using tempDir = new TestTempDir("test-workflow-run-tool");
    const scriptPath = await writeWorkflowScript(tempDir.path);
    const startWorkflow = mock(async () => ({
      runId: "wfr_123",
      status: "completed" as const,
      result: { reportMarkdown: "done" },
    }));
    const getRun = mock(async () =>
      createWorkflowRunRecord({
        status: "completed",
        updatedAt: "2026-05-29T00:00:01.000Z",
        events: [
          {
            sequence: 1,
            type: "status" as const,
            at: "2026-05-29T00:00:00.000Z",
            status: "running" as const,
          },
          { sequence: 2, type: "phase" as const, at: "2026-05-29T00:00:00.000Z", name: "scope" },
          {
            sequence: 3,
            type: "result" as const,
            at: "2026-05-29T00:00:01.000Z",
            result: { reportMarkdown: "done" },
          },
          {
            sequence: 4,
            type: "status" as const,
            at: "2026-05-29T00:00:01.000Z",
            status: "completed" as const,
          },
        ],
      })
    );
    const abortController = new AbortController();
    const tool = createWorkflowRunTool({
      ...createTestToolConfig(tempDir.path, { workspaceId: "workspace-1" }),
      trusted: true,
      workflowService: {
        startWorkflow,
        getRun,
      },
    });

    const result = await tool.execute!(
      { script_path: scriptPath, args: { topic: "workflow tools" }, run_in_background: false },
      { ...mockToolCallOptions, abortSignal: abortController.signal }
    );

    expect(startWorkflow).toHaveBeenCalledWith(
      expect.objectContaining({
        script: expect.objectContaining({
          requestedScriptPath: scriptPath,
          sourceKind: "workspace-file",
          source: expect.stringContaining("export default"),
        }),
        workspaceId: "workspace-1",
        projectTrusted: true,
        args: { topic: "workflow tools" },
        abortSignal: abortController.signal,
        onRunCreated: expect.any(Function),
      })
    );
    expect(getRun).toHaveBeenCalledWith({ workspaceId: "workspace-1", runId: "wfr_123" });
    expect(result).toEqual({
      status: "completed",
      runId: "wfr_123",
      result: { reportMarkdown: "done" },
      run: expect.objectContaining({
        id: "wfr_123",
        status: "completed",
        events: expect.arrayContaining([expect.objectContaining({ type: "phase", name: "scope" })]),
      }),
      note: COMPLETED_REPORT_REFETCH_NOTE,
    });
  });

  test("resolves relative workflow script paths from the active tool cwd", async () => {
    using tempDir = new TestTempDir("test-workflow-run-tool-active-cwd");
    const activeRoot = path.join(tempDir.path, "active-worktree");
    const staleRoot = path.join(tempDir.path, "source-project");
    await fs.mkdir(path.join(activeRoot, "workflows"), { recursive: true });
    await fs.mkdir(path.join(staleRoot, "workflows"), { recursive: true });
    await fs.writeFile(
      path.join(activeRoot, "workflows", "deep-research.js"),
      "export default function workflow() { return 'active'; }\n",
      "utf-8"
    );
    await fs.writeFile(
      path.join(staleRoot, "workflows", "deep-research.js"),
      "export default function workflow() { return 'stale'; }\n",
      "utf-8"
    );
    let capturedSource = "";
    const startWorkflow = mock(async (input: { script: { source: string } }) => {
      capturedSource = input.script.source;
      return {
        runId: "wfr_active_cwd",
        status: "completed" as const,
        result: { reportMarkdown: "done" },
      };
    });
    const tool = createWorkflowRunTool({
      ...createTestToolConfig(activeRoot, { workspaceId: "workspace-1" }),
      workspaceExecutionRootPath: staleRoot,
      trusted: true,
      workflowService: {
        startWorkflow,
        getRun: mock(async () => null),
      },
    });

    await tool.execute!(
      {
        script_path: "./workflows/deep-research.js",
        args: {},
        run_in_background: false,
      },
      mockToolCallOptions
    );

    expect(startWorkflow).toHaveBeenCalledWith(
      expect.objectContaining({
        script: expect.objectContaining({
          source: expect.stringContaining("active"),
        }),
      })
    );
    expect(capturedSource).not.toContain("stale");
  });

  test("starts a skill workflow inherited by a subproject", async () => {
    using checkout = new TestTempDir("test-workflow-run-tool-subproject-skill");
    using xumHome = new TestTempDir("test-workflow-run-tool-subproject-mux-home");
    const subprojectRoot = path.join(checkout.path, "packages", "app");
    await fs.mkdir(subprojectRoot, { recursive: true });
    await writeProjectSkill(checkout.path, "parent-flow", {
      files: {
        "workflow.js":
          "export default function workflow() { return { reportMarkdown: 'parent workflow' }; }",
      },
    });

    const startWorkflow = mock(async (input: { script: { source: string } }) => ({
      runId: "wfr_parent_skill",
      status: "completed" as const,
      result: { reportMarkdown: input.script.source },
    }));
    const tool = createWorkflowRunTool({
      ...createTestToolConfig(subprojectRoot, {
        workspaceId: "workspace-1",
        xumScope: {
          type: "project",
          xumHome: xumHome.path,
          projectRoot: subprojectRoot,
          projectStorageAuthority: "host-local",
          checkoutRoot: checkout.path,
        },
      }),
      trusted: true,
      workflowService: {
        startWorkflow,
        getRun: mock(async () => null),
      },
    });

    await tool.execute!(
      {
        script_path: "skill://parent-flow/workflow.js",
        args: {},
        run_in_background: false,
      },
      mockToolCallOptions
    );

    expect(startWorkflow).toHaveBeenCalledWith(
      expect.objectContaining({
        script: expect.objectContaining({
          source: expect.stringContaining("parent workflow"),
          scope: "project",
        }),
      })
    );
  });

  test("starts a built-in skill workflow by explicit skill script_path", async () => {
    using tempDir = new TestTempDir("test-workflow-run-tool-built-in-skill");
    const startWorkflow = mock(async () => ({
      runId: "wfr_builtin_skill",
      status: "completed" as const,
      result: { reportMarkdown: "done" },
    }));
    const tool = createWorkflowRunTool({
      ...createTestToolConfig(tempDir.path, { workspaceId: "workspace-1" }),
      trusted: false,
      workflowService: {
        startWorkflow,
        getRun: mock(async () => null),
      },
    });

    const result = await tool.execute!(
      {
        script_path: "skill://deep-research/workflow.js",
        args: { input: "from tool" },
        run_in_background: false,
      },
      mockToolCallOptions
    );

    expect(startWorkflow).toHaveBeenCalledWith(
      expect.objectContaining({
        script: expect.objectContaining({
          requestedScriptPath: "skill://deep-research/workflow.js",
          canonicalScriptPath: "skill://deep-research/workflow.js",
          sourceKind: "skill",
          scope: "built-in",
          source: expect.stringContaining("Deep Research"),
        }),
        projectTrusted: false,
        args: { input: "from tool" },
      })
    );
    expect(result).toEqual({
      status: "completed",
      runId: "wfr_builtin_skill",
      result: { reportMarkdown: "done" },
      note: COMPLETED_REPORT_REFETCH_NOTE,
    });
  });

  test("starts a trusted inline script_source workflow through WorkflowService", async () => {
    using tempDir = new TestTempDir("test-workflow-run-tool-inline");
    const scriptSource =
      "export default function workflow() { return { reportMarkdown: 'inline done' }; }\n";
    const startWorkflow = mock(async () => ({
      runId: "wfr_inline",
      status: "completed" as const,
      result: { reportMarkdown: "inline done" },
    }));
    const tool = createWorkflowRunTool({
      ...createTestToolConfig(tempDir.path, { workspaceId: "workspace-1" }),
      trusted: true,
      workflowService: {
        startWorkflow,
        getRun: mock(async () => null),
      },
    });

    const result = await tool.execute!(
      { script_source: scriptSource, args: { topic: "inline" }, run_in_background: false },
      mockToolCallOptions
    );

    expect(startWorkflow).toHaveBeenCalledWith(
      expect.objectContaining({
        script: expect.objectContaining({
          requestedScriptPath: expect.stringMatching(/^inline:\/\/workflow-[a-f0-9]{12}\.js$/),
          canonicalScriptPath: expect.stringMatching(/^inline:\/\/workflow-[a-f0-9]{12}\.js$/),
          sourceKind: "inline",
          source: scriptSource,
        }),
        workspaceId: "workspace-1",
        projectTrusted: true,
        args: { topic: "inline" },
      })
    );
    expect(result).toEqual({
      status: "completed",
      runId: "wfr_inline",
      result: { reportMarkdown: "inline done" },
      note: COMPLETED_REPORT_REFETCH_NOTE,
    });
  });

  test("rejects untrusted inline workflows and inline provenance paths", async () => {
    using tempDir = new TestTempDir("test-workflow-run-tool-inline-reject");
    const startWorkflow = mock(async () => ({
      runId: "wfr_should_not_start",
      status: "completed" as const,
      result: null,
    }));
    const tool = createWorkflowRunTool({
      ...createTestToolConfig(tempDir.path, { workspaceId: "workspace-1" }),
      trusted: false,
      workflowService: {
        startWorkflow,
        getRun: mock(async () => null),
      },
    });

    await expect(
      Promise.resolve(
        tool.execute!(
          {
            script_source: "export default function workflow() {}",
            args: {},
            run_in_background: false,
          },
          mockToolCallOptions
        )
      )
    ).rejects.toThrow("Project trust is required to run inline workflow scripts");
    await expect(
      Promise.resolve(
        tool.execute!(
          { script_path: "inline://workflow-deadbeef.js", args: {}, run_in_background: false },
          mockToolCallOptions
        )
      )
    ).rejects.toThrow("use script_source instead");
    expect(startWorkflow).not.toHaveBeenCalled();
  });

  test("emits a workflow run attachment when the durable run is created", async () => {
    using tempDir = new TestTempDir("test-workflow-run-tool-attached");
    const scriptPath = await writeWorkflowScript(tempDir.path);
    const attachedRun = createWorkflowRunRecord({ id: "wfr_attached" });
    const emittedEvents: WorkflowRunAttachedEvent[] = [];
    let emitChatEventSettled = false;
    let onRunCreatedWaitedForEmission = false;
    const startWorkflow = mock(
      async (input: {
        onRunCreated?: (event: {
          runId: string;
          status: "pending";
          result: null;
          run: unknown;
        }) => Promise<void> | void;
      }) => {
        await input.onRunCreated?.({
          runId: attachedRun.id,
          status: "pending",
          result: null,
          run: attachedRun,
        });
        onRunCreatedWaitedForEmission = emitChatEventSettled;
        return { runId: attachedRun.id, status: "completed" as const, result: null };
      }
    );
    const tool = createWorkflowRunTool({
      ...createTestToolConfig(tempDir.path, { workspaceId: "workspace-1" }),
      trusted: true,
      emitChatEvent: async (event) => {
        await Promise.resolve();
        if (event.type === "workflow-run-attached") {
          emittedEvents.push(event);
          emitChatEventSettled = true;
        }
      },
      workflowService: {
        startWorkflow,
        getRun: mock(async () => attachedRun),
      },
    });

    await tool.execute!(
      { script_path: scriptPath, args: { topic: "workflow tools" }, run_in_background: false },
      mockToolCallOptions
    );

    expect(onRunCreatedWaitedForEmission).toBe(true);
    expect(emittedEvents).toHaveLength(1);
    expect(emittedEvents[0]).toMatchObject({
      type: "workflow-run-attached",
      workspaceId: "workspace-1",
      toolCallId: "test-call-id",
      runId: "wfr_attached",
      run: expect.objectContaining({ id: "wfr_attached", status: "pending" }),
    });
    expect(typeof emittedEvents[0]?.timestamp).toBe("number");
  });

  test("returns a recoverable run when foreground start throws after durable creation", async () => {
    using tempDir = new TestTempDir("test-workflow-run-tool-recover-created-run");
    const scriptPath = await writeWorkflowScript(tempDir.path);
    const createdRun = createWorkflowRunRecord({
      id: "wfr_created_then_aborted",
      status: "running",
    });
    const startWorkflow = mock(
      async (input: {
        onRunCreated?: (event: {
          runId: string;
          status: "pending";
          result: null;
          run: unknown;
        }) => Promise<void> | void;
      }) => {
        await input.onRunCreated?.({
          runId: createdRun.id,
          status: "pending",
          result: null,
          run: createdRun,
        });
        throw new Error("Execution aborted");
      }
    );
    const getRun = mock(async () => createdRun);
    const tool = createWorkflowRunTool({
      ...createTestToolConfig(tempDir.path, { workspaceId: "workspace-1" }),
      trusted: true,
      workflowService: {
        startWorkflow,
        getRun,
      },
    });

    const result = await tool.execute!(
      { script_path: scriptPath, args: { topic: "workflow tools" }, run_in_background: false },
      mockToolCallOptions
    );

    const references = await readAgentWorkflowRunReferences(tempDir.path);
    expect(references.map((reference) => reference.runId)).toContain(createdRun.id);
    expect(getRun).toHaveBeenCalledWith({ workspaceId: "workspace-1", runId: createdRun.id });
    expect(result).toEqual({
      status: "running",
      runId: createdRun.id,
      result: null,
      run: expect.objectContaining({ id: createdRun.id, status: "running" }),
      note: expect.stringContaining("Execution aborted"),
    });
    const note = WorkflowRunToolResultSchema.parse(result).note;
    expect(note).toContain("Do not start another copy");
    expect(note).toContain("running");
    expect(note).toContain("task_await");
  });

  test("returns pending post-create failures as resumable instead of awaitable", async () => {
    using tempDir = new TestTempDir("test-workflow-run-tool-recover-pending-run");
    const scriptPath = await writeWorkflowScript(tempDir.path);
    const pendingRun = createWorkflowRunRecord({
      id: "wfr_pending_then_aborted",
      status: "pending",
    });
    const startWorkflow = mock(
      async (input: {
        onRunCreated?: (event: {
          runId: string;
          status: "pending";
          result: null;
          run: unknown;
        }) => Promise<void> | void;
      }) => {
        await input.onRunCreated?.({
          runId: pendingRun.id,
          status: "pending",
          result: null,
          run: pendingRun,
        });
        throw new Error("Execution aborted");
      }
    );
    const tool = createWorkflowRunTool({
      ...createTestToolConfig(tempDir.path, { workspaceId: "workspace-1" }),
      trusted: true,
      workflowService: {
        startWorkflow,
        getRun: mock(async () => pendingRun),
      },
    });

    const result = await tool.execute!(
      { script_path: scriptPath, args: { topic: "workflow tools" }, run_in_background: false },
      mockToolCallOptions
    );

    const references = await readAgentWorkflowRunReferences(tempDir.path);
    expect(references).toEqual([]);
    expect(result).toEqual({
      status: "pending",
      runId: pendingRun.id,
      result: null,
      run: expect.objectContaining({ id: pendingRun.id, status: "pending" }),
      note: expect.stringContaining("workflow_resume"),
    });
    const note = WorkflowRunToolResultSchema.parse(result).note;
    expect(note).toContain("pending");
    expect(note).toContain("Do not start another copy");
  });

  test("still rejects when foreground start throws before durable creation", async () => {
    using tempDir = new TestTempDir("test-workflow-run-tool-pre-create-error");
    const scriptPath = await writeWorkflowScript(tempDir.path);
    const startWorkflow = mock(async () => {
      throw new Error("script failed before persistence");
    });
    const getRun = mock(async () => createWorkflowRunRecord());
    const tool = createWorkflowRunTool({
      ...createTestToolConfig(tempDir.path, { workspaceId: "workspace-1" }),
      trusted: true,
      workflowService: {
        startWorkflow,
        getRun,
      },
    });

    await expect(
      Promise.resolve(
        tool.execute!(
          { script_path: scriptPath, args: { topic: "workflow tools" }, run_in_background: false },
          mockToolCallOptions
        )
      )
    ).rejects.toThrow("script failed before persistence");
    expect(getRun).not.toHaveBeenCalled();
  });

  test("returns latest durable result when post-create foreground error already completed", async () => {
    using tempDir = new TestTempDir("test-workflow-run-tool-recover-completed-run");
    const scriptPath = await writeWorkflowScript(tempDir.path);
    const completedRun = createWorkflowRunRecord({
      id: "wfr_completed_then_aborted",
      status: "completed",
      events: [
        {
          sequence: 1,
          type: "status",
          at: "2026-05-29T00:00:00.000Z",
          status: "running",
        },
        {
          sequence: 2,
          type: "result",
          at: "2026-05-29T00:00:01.000Z",
          result: { reportMarkdown: "durable report" },
        },
        {
          sequence: 3,
          type: "status",
          at: "2026-05-29T00:00:01.000Z",
          status: "completed",
        },
      ],
    });
    const startWorkflow = mock(
      async (input: {
        onRunCreated?: (event: {
          runId: string;
          status: "pending";
          result: null;
          run: unknown;
        }) => Promise<void> | void;
      }) => {
        await input.onRunCreated?.({
          runId: completedRun.id,
          status: "pending",
          result: null,
          run: completedRun,
        });
        throw new Error("Execution aborted");
      }
    );
    const tool = createWorkflowRunTool({
      ...createTestToolConfig(tempDir.path, { workspaceId: "workspace-1" }),
      trusted: true,
      workflowService: {
        startWorkflow,
        getRun: mock(async () => completedRun),
      },
    });

    const result = await tool.execute!(
      { script_path: scriptPath, args: { topic: "workflow tools" }, run_in_background: false },
      mockToolCallOptions
    );

    expect(result).toEqual({
      status: "completed",
      runId: completedRun.id,
      result: { reportMarkdown: "durable report" },
      run: expect.objectContaining({ id: completedRun.id, status: "completed" }),
      note: expect.stringContaining("Execution aborted"),
    });
  });

  test("starts an explicit script_path workflow in background mode", async () => {
    using tempDir = new TestTempDir("test-workflow-run-tool-background");
    const scriptPath = await writeWorkflowScript(tempDir.path);
    const startWorkflow = mock(async () => {
      throw new Error("foreground start should not be used");
    });
    // Faithful to WorkflowService: onRunCreated is awaited at run creation, before the runner
    // starts executing. The probe checks the sidecar reference is already durable at that
    // point, so a fast run (or a crash) after launch cannot lose its terminal wake.
    let referenceDurableBeforeRunnerStart = false;
    const startWorkflowInBackground = mock(async (input: BackgroundStartInput) => {
      await input.onRunCreated?.({
        runId: "wfr_background",
        status: "pending",
        result: null,
        run: null,
      });
      const references = await readAgentWorkflowRunReferences(tempDir.path);
      referenceDurableBeforeRunnerStart = references.some(
        (reference) => reference.runId === "wfr_background"
      );
      return { runId: "wfr_background", status: "running" as const, result: null };
    });
    const getRun = mock(async () => null);
    const getWorkflowInvocationBoundaryMessageId = mock(async () => "boundary-row-1");
    const tool = createWorkflowRunTool({
      ...createTestToolConfig(tempDir.path, { workspaceId: "workspace-1" }),
      trusted: true,
      agentId: "plan",
      strictAgentResolution: { expectedScope: "built-in" },
      taskService: { getWorkflowInvocationBoundaryMessageId } as unknown as TaskService,
      workflowService: {
        startWorkflow,
        startWorkflowInBackground,
        getRun,
      },
    });

    const result = await tool.execute!(
      { script_path: scriptPath, args: { topic: "workflow tools" }, run_in_background: true },
      mockToolCallOptions
    );

    expect(referenceDurableBeforeRunnerStart).toBe(true);
    // The reference must persist the invocation-boundary snapshot: currentness compares row
    // identity, so a reference recorded without it fails safe and the wake is dropped.
    const references = await readAgentWorkflowRunReferences(tempDir.path);
    expect(references).toHaveLength(1);
    expect(references[0]).toMatchObject({
      runId: "wfr_background",
      afterBoundaryMessageId: "boundary-row-1",
      // The wake binds to the launching agent, so the reference must carry its identity
      // and the launch turn's provenance pin.
      agentId: "plan",
      strictAgentResolution: { expectedScope: "built-in" },
    });
    expect(getWorkflowInvocationBoundaryMessageId).toHaveBeenCalledWith(
      "workspace-1",
      "wfr_background"
    );

    expect(startWorkflowInBackground).toHaveBeenCalledWith(
      expect.objectContaining({
        script: expect.objectContaining({ requestedScriptPath: scriptPath }),
        workspaceId: "workspace-1",
        projectTrusted: true,
        args: { topic: "workflow tools" },
        onRunCreated: expect.any(Function),
      })
    );
    expect(startWorkflow).not.toHaveBeenCalled();
    expect(result).toEqual({ status: "running", runId: "wfr_background", result: null });
  });

  test("records a rediscovery-only reference when the boundary snapshot fails", async () => {
    using tempDir = new TestTempDir("test-workflow-run-tool-boundary-error");
    const scriptPath = await writeWorkflowScript(tempDir.path);
    const startWorkflowInBackground = mock(async (input: BackgroundStartInput) => {
      await input.onRunCreated?.({
        runId: "wfr_boundary_error",
        status: "pending",
        result: null,
        run: null,
      });
      return { runId: "wfr_boundary_error", status: "running" as const, result: null };
    });
    const getWorkflowInvocationBoundaryMessageId = mock(async () => {
      throw new Error("history read failed");
    });
    const tool = createWorkflowRunTool({
      ...createTestToolConfig(tempDir.path, { workspaceId: "workspace-1" }),
      trusted: true,
      taskService: { getWorkflowInvocationBoundaryMessageId } as unknown as TaskService,
      workflowService: {
        startWorkflow: mock(async () => {
          throw new Error("foreground start should not be used");
        }),
        startWorkflowInBackground,
        getRun: mock(async () => null),
      },
    });

    const result = await tool.execute!(
      { script_path: scriptPath, args: { topic: "workflow tools" }, run_in_background: true },
      mockToolCallOptions
    );
    expect(result).toEqual({ status: "running", runId: "wfr_boundary_error", result: null });

    // A read failure must not persist a verified-empty boundary (null): the entry keeps the run
    // rediscoverable while a later resume re-record can repair provenance.
    const references = await readAgentWorkflowRunReferences(tempDir.path);
    expect(references).toHaveLength(1);
    expect(references[0]?.runId).toBe("wfr_boundary_error");
    expect(references[0] != null && "afterBoundaryMessageId" in references[0]).toBe(false);
  });

  test("a sidecar write failure aborts the background launch before the runner starts", async () => {
    using tempDir = new TestTempDir("test-workflow-run-tool-sidecar-write-error");
    const scriptPath = await writeWorkflowScript(tempDir.path);
    // The reference path exists as a directory, so every sidecar write fails.
    await fs.mkdir(path.join(tempDir.path, "agent-workflow-runs.json"));
    let runnerStarted = false;
    const startWorkflowInBackground = mock(async (input: BackgroundStartInput) => {
      await input.onRunCreated?.({
        runId: "wfr_sidecar_write_error",
        status: "pending",
        result: null,
        run: null,
      });
      runnerStarted = true;
      return { runId: "wfr_sidecar_write_error", status: "running" as const, result: null };
    });
    const getRun = mock(async () => null);
    const getWorkflowInvocationBoundaryMessageId = mock(async () => "boundary-row-1");
    const tool = createWorkflowRunTool({
      ...createTestToolConfig(tempDir.path, { workspaceId: "workspace-1" }),
      trusted: true,
      agentId: "plan",
      taskService: { getWorkflowInvocationBoundaryMessageId } as unknown as TaskService,
      workflowService: { startWorkflowInBackground, getRun },
    });

    // Starting the runner without durable provenance would let a fast terminal run have its
    // wake permanently superseded; the launch must fail loudly instead, leaving the run
    // pending and resumable (workflow_resume re-records provenance).
    await expect(
      tool.execute!({ script_path: scriptPath, run_in_background: true }, mockToolCallOptions)
    ).rejects.toThrow(/created durable run wfr_sidecar_write_error/);
    expect(runnerStarted).toBe(false);
  });

  test("requires the workflow service", async () => {
    using tempDir = new TestTempDir("test-workflow-run-tool-missing");
    const scriptPath = await writeWorkflowScript(tempDir.path);
    const tool = createWorkflowRunTool({
      ...createTestToolConfig(tempDir.path, { workspaceId: "workspace-1" }),
      trusted: true,
    });

    await expect(
      Promise.resolve(
        tool.execute!(
          { script_path: scriptPath, args: {}, run_in_background: false },
          mockToolCallOptions
        )
      )
    ).rejects.toThrow(/workflowService/);
  });
});
describe("workflow_run duplicate guard", () => {
  const runningWorkflowDescriptor = (canonicalScriptPath: string) => ({
    name: "deep-research",
    description: "Deep research",
    scope: "project" as const,
    executable: true,
    sourcePath: canonicalScriptPath,
    canonicalScriptPath,
    sourceKind: "workspace-file" as const,
    sourceHash: "sha256:active",
  });

  function activeRunRecordFor(canonicalScriptPath: string, id = "wfr_active"): WorkflowRunRecord {
    return createWorkflowRunRecord({
      id,
      status: "running",
      workflow: runningWorkflowDescriptor(canonicalScriptPath),
    });
  }

  const completedStart = () =>
    mock(async () => ({ runId: "wfr_new", status: "completed" as const, result: null }));
  const completedGetRun = async () => createWorkflowRunRecord({ status: "completed" });

  test("refuses when the same script already has an active run", async () => {
    using tempDir = new TestTempDir("test-workflow-run-duplicate");
    const scriptPath = await writeWorkflowScript(tempDir.path);
    const startWorkflow = completedStart();
    const tool = createWorkflowRunTool({
      ...createTestToolConfig(tempDir.path, { workspaceId: "workspace-1" }),
      trusted: true,
      workflowService: {
        listRuns: async () => [activeRunRecordFor(scriptPath)],
        startWorkflow,
        getRun: completedGetRun,
      },
    });

    const launch = Promise.resolve(
      tool.execute!(
        { script_path: scriptPath, script_source: null, args: {}, run_in_background: false },
        mockToolCallOptions
      )
    );
    await expect(launch).rejects.toThrow(/already has an active run/);
    await launch.catch((error: unknown) => {
      expect(String(error)).toContain("wfr_active");
      expect(String(error)).toContain("task_await");
      expect(String(error)).toContain("allow_concurrent");
    });
    expect(startWorkflow).not.toHaveBeenCalled();
  });

  test("matches equivalent spellings of the same script path", async () => {
    using tempDir = new TestTempDir("test-workflow-run-duplicate");
    const scriptPath = await writeWorkflowScript(tempDir.path);
    const startWorkflow = completedStart();
    const tool = createWorkflowRunTool({
      ...createTestToolConfig(tempDir.path, { workspaceId: "workspace-1" }),
      trusted: true,
      workflowService: {
        listRuns: async () => [activeRunRecordFor(scriptPath)],
        startWorkflow,
        getRun: completedGetRun,
      },
    });

    // Stored spelling is "./workflows/deep-research.js"; launch without the "./" prefix.
    await expect(
      Promise.resolve(
        tool.execute!(
          {
            script_path: scriptPath.replace(/^\.\//, ""),
            script_source: null,
            args: {},
            run_in_background: false,
          },
          mockToolCallOptions
        )
      )
    ).rejects.toThrow(/already has an active run/);
    expect(startWorkflow).not.toHaveBeenCalled();
  });

  test("allows a launch while a different script runs", async () => {
    using tempDir = new TestTempDir("test-workflow-run-duplicate");
    const scriptPath = await writeWorkflowScript(tempDir.path);
    const startWorkflow = completedStart();
    const tool = createWorkflowRunTool({
      ...createTestToolConfig(tempDir.path, { workspaceId: "workspace-1" }),
      trusted: true,
      workflowService: {
        listRuns: async () => [activeRunRecordFor("./workflows/other.js")],
        startWorkflow,
        getRun: completedGetRun,
      },
    });

    await tool.execute!(
      { script_path: scriptPath, script_source: null, args: {}, run_in_background: false },
      mockToolCallOptions
    );
    expect(startWorkflow).toHaveBeenCalledTimes(1);
  });

  test("allows a relaunch when the previous same-script run is terminal", async () => {
    using tempDir = new TestTempDir("test-workflow-run-duplicate");
    const scriptPath = await writeWorkflowScript(tempDir.path);
    const startWorkflow = completedStart();
    const terminalRun = createWorkflowRunRecord({
      id: "wfr_done",
      status: "completed",
      workflow: runningWorkflowDescriptor(scriptPath),
    });
    const tool = createWorkflowRunTool({
      ...createTestToolConfig(tempDir.path, { workspaceId: "workspace-1" }),
      trusted: true,
      workflowService: {
        listRuns: async () => [terminalRun],
        startWorkflow,
        getRun: completedGetRun,
      },
    });

    await tool.execute!(
      { script_path: scriptPath, script_source: null, args: {}, run_in_background: false },
      mockToolCallOptions
    );
    expect(startWorkflow).toHaveBeenCalledTimes(1);
  });

  test("allow_concurrent=true starts despite an active same-script run", async () => {
    using tempDir = new TestTempDir("test-workflow-run-duplicate");
    const scriptPath = await writeWorkflowScript(tempDir.path);
    const startWorkflow = completedStart();
    const listRuns = mock(async () => [activeRunRecordFor(scriptPath)]);
    const tool = createWorkflowRunTool({
      ...createTestToolConfig(tempDir.path, { workspaceId: "workspace-1" }),
      trusted: true,
      workflowService: { listRuns, startWorkflow, getRun: completedGetRun },
    });

    await tool.execute!(
      {
        script_path: scriptPath,
        script_source: null,
        args: {},
        run_in_background: false,
        allow_concurrent: true,
      },
      mockToolCallOptions
    );
    expect(startWorkflow).toHaveBeenCalledTimes(1);
    expect(listRuns).not.toHaveBeenCalled();
  });

  test("fails closed when active runs cannot be listed", async () => {
    using tempDir = new TestTempDir("test-workflow-run-duplicate");
    const scriptPath = await writeWorkflowScript(tempDir.path);
    const startWorkflow = completedStart();
    const tool = createWorkflowRunTool({
      ...createTestToolConfig(tempDir.path, { workspaceId: "workspace-1" }),
      trusted: true,
      workflowService: {
        listRuns: async () => {
          throw new Error("store unreadable");
        },
        startWorkflow,
        getRun: completedGetRun,
      },
    });

    await expect(
      Promise.resolve(
        tool.execute!(
          { script_path: scriptPath, script_source: null, args: {}, run_in_background: false },
          mockToolCallOptions
        )
      )
    ).rejects.toThrow(/could not verify/);
    expect(startWorkflow).not.toHaveBeenCalled();
  });

  test("refuses an inline script whose source already has an active run", async () => {
    using tempDir = new TestTempDir("test-workflow-run-duplicate");
    const inlineSource = "export default function workflow() { return 42; }\n";
    const resolved = await resolveWorkflowScript({
      scriptSource: inlineSource,
      runtime: new LocalRuntime(tempDir.path),
      workspacePath: tempDir.path,
      projectTrusted: true,
    });
    const inlineRun = createWorkflowRunRecord({
      id: "wfr_inline",
      status: "running",
      workflow: {
        name: "inline",
        description: "Inline workflow",
        scope: "project",
        executable: true,
        sourceKind: "inline",
        sourceHash: resolved.sourceHash,
      },
    });
    const startWorkflow = completedStart();
    const tool = createWorkflowRunTool({
      ...createTestToolConfig(tempDir.path, { workspaceId: "workspace-1" }),
      trusted: true,
      workflowService: {
        listRuns: async () => [inlineRun],
        startWorkflow,
        getRun: completedGetRun,
      },
    });

    await expect(
      Promise.resolve(
        tool.execute!(
          { script_path: null, script_source: inlineSource, args: {}, run_in_background: false },
          mockToolCallOptions
        )
      )
    ).rejects.toThrow(/already has an active run/);
    expect(startWorkflow).not.toHaveBeenCalled();
  });

  test("serializes overlapping launches so only one creates a run", async () => {
    using tempDir = new TestTempDir("test-workflow-run-duplicate");
    const scriptPath = await writeWorkflowScript(tempDir.path);
    const runs: WorkflowRunRecord[] = [];
    let releaseFirstLaunch!: () => void;
    const firstLaunchGate = new Promise<void>((resolve) => {
      releaseFirstLaunch = resolve;
    });
    const startWorkflow = mock(
      async (input: {
        onRunCreated?: (event: {
          runId: string;
          status: "pending";
          result: null;
          run: unknown;
        }) => Promise<void> | void;
      }) => {
        const isFirstAdmission = runs.length === 0;
        const record = activeRunRecordFor(scriptPath, `wfr_${runs.length + 1}`);
        runs.push(record);
        await input.onRunCreated?.({
          runId: record.id,
          status: "pending",
          result: null,
          run: record,
        });
        // A broken guard must fail promptly rather than block both launches forever.
        if (isFirstAdmission) await firstLaunchGate;
        return { runId: record.id, status: "completed" as const, result: null };
      }
    );
    const tool = createWorkflowRunTool({
      ...createTestToolConfig(tempDir.path, { workspaceId: "workspace-1" }),
      trusted: true,
      workflowService: {
        listRuns: async () => runs,
        startWorkflow,
        getRun: completedGetRun,
      },
    });

    const launchArgs = {
      script_path: scriptPath,
      script_source: null,
      args: {},
      run_in_background: false,
    };
    // Script reads can finish in either order. Handle both rejections immediately
    // and assert the duplicate invariant without assuming which caller wins.
    const launch = () =>
      Promise.resolve()
        .then(async () => {
          await tool.execute!(launchArgs, mockToolCallOptions);
        })
        .then(
          () => ({ status: "fulfilled" as const }),
          (reason: unknown) => ({ status: "rejected" as const, reason })
        );
    const launches = [launch(), launch()];
    const beforeRelease = await Promise.race(launches).finally(releaseFirstLaunch);
    const outcomes = await Promise.all(launches);
    expect(beforeRelease.status).toBe("rejected");
    if (beforeRelease.status === "rejected") {
      expect(beforeRelease.reason).toMatchObject({
        message: expect.stringMatching(/already has an active run/),
      });
    }
    expect(outcomes.map((outcome) => outcome.status).sort()).toEqual(["fulfilled", "rejected"]);
    expect(startWorkflow).toHaveBeenCalledTimes(1);
  });

  test("serializes overlapping launches across equivalent path spellings", async () => {
    using tempDir = new TestTempDir("test-workflow-run-duplicate");
    const scriptPath = await writeWorkflowScript(tempDir.path);

    const deferred = () => {
      let resolve!: () => void;
      const promise = new Promise<void>((res) => {
        resolve = res;
      });
      return { promise, resolve };
    };
    // Signals when the Nth read of the workflow script finishes, marking the last async step
    // of that launch's script resolution; everything from there to the duplicate check is
    // microtasks, so one macrotask turn afterwards deterministically settles the launch at
    // either the admission gate or the listRuns gate.
    class ReadSignalingRuntime extends LocalRuntime {
      scriptReads = 0;
      onSecondScriptRead: (() => void) | null = null;
      override readFile(path: string, abortSignal?: AbortSignal): ReadableStream<Uint8Array> {
        const inner = super.readFile(path, abortSignal);
        if (!path.includes("deep-research.js")) {
          return inner;
        }
        this.scriptReads += 1;
        const notify = this.scriptReads === 2 ? this.onSecondScriptRead : null;
        const reader = inner.getReader();
        return new ReadableStream<Uint8Array>({
          async pull(controller) {
            const { done, value } = await reader.read();
            if (done) {
              notify?.();
              controller.close();
              return;
            }
            controller.enqueue(value);
          },
        });
      }
    }
    const runtime = new ReadSignalingRuntime(tempDir.path);
    const secondScriptRead = deferred();
    runtime.onSecondScriptRead = secondScriptRead.resolve;

    const runs: WorkflowRunRecord[] = [];
    const firstListReached = deferred();
    const firstListGate = deferred();
    const secondListGate = deferred();
    let listRunsCalls = 0;
    const listRuns = async () => {
      listRunsCalls += 1;
      // Snapshot at invocation time: a call that starts while the first launch still holds
      // its gate must observe the pre-persist (empty) state, so an admission-key regression
      // cannot be masked by the record landing before the gates are released below.
      const snapshot = [...runs];
      if (listRunsCalls === 1) {
        firstListReached.resolve();
        await firstListGate.promise;
      } else {
        await secondListGate.promise;
      }
      return snapshot;
    };
    const startWorkflow = mock(
      async (input: {
        onRunCreated?: (event: {
          runId: string;
          status: "pending";
          result: null;
          run: unknown;
        }) => Promise<void> | void;
      }) => {
        const record = activeRunRecordFor(scriptPath, "wfr_first");
        runs.push(record);
        await input.onRunCreated?.({
          runId: record.id,
          status: "pending",
          result: null,
          run: record,
        });
        return { runId: record.id, status: "completed" as const, result: null };
      }
    );
    const tool = createWorkflowRunTool({
      ...createTestToolConfig(tempDir.path, { workspaceId: "workspace-1", runtime }),
      trusted: true,
      workflowService: { listRuns, startWorkflow, getRun: completedGetRun },
    });

    const firstLaunch = Promise.resolve(
      tool.execute!(
        { script_path: scriptPath, script_source: null, args: {}, run_in_background: false },
        mockToolCallOptions
      )
    );
    await firstListReached.promise;
    // Same file, different spelling: must queue on the same admission gate instead of
    // racing its own duplicate check before the first launch persists a run.
    const secondLaunch = Promise.resolve(
      tool.execute!(
        {
          script_path: scriptPath.replace(/^\.\//, ""),
          script_source: null,
          args: {},
          run_in_background: false,
        },
        mockToolCallOptions
      )
    );
    await secondScriptRead.promise;
    await new Promise((resolve) => setImmediate(resolve));
    // With the first launch still parked inside its listing, the second must be waiting on
    // the shared admission gate rather than running its own duplicate check.
    expect(listRunsCalls).toBe(1);
    firstListGate.resolve();
    secondListGate.resolve();
    await expect(secondLaunch).rejects.toThrow(/already has an active run/);
    await firstLaunch;
    expect(startWorkflow).toHaveBeenCalledTimes(1);
  });

  test("matches a legacy inline run that omits workflow.sourceKind", async () => {
    using tempDir = new TestTempDir("test-workflow-run-duplicate");
    const inlineSource = "export default function workflow() { return 42; }\n";
    const resolved = await resolveWorkflowScript({
      scriptSource: inlineSource,
      runtime: new LocalRuntime(tempDir.path),
      workspacePath: tempDir.path,
      projectTrusted: true,
    });
    // Legacy descriptor shape: no sourceKind/sourceHash/canonicalScriptPath on the workflow;
    // only the run-level sourceHash identifies the source.
    const legacyInlineRun = createWorkflowRunRecord({
      id: "wfr_legacy_inline",
      status: "running",
      sourceHash: resolved.sourceHash,
      workflow: {
        name: "inline",
        description: "Inline workflow",
        scope: "project",
        executable: true,
      },
    });
    const startWorkflow = completedStart();
    const tool = createWorkflowRunTool({
      ...createTestToolConfig(tempDir.path, { workspaceId: "workspace-1" }),
      trusted: true,
      workflowService: {
        listRuns: async () => [legacyInlineRun],
        startWorkflow,
        getRun: completedGetRun,
      },
    });

    await expect(
      Promise.resolve(
        tool.execute!(
          { script_path: null, script_source: inlineSource, args: {}, run_in_background: false },
          mockToolCallOptions
        )
      )
    ).rejects.toThrow(/already has an active run/);
    expect(startWorkflow).not.toHaveBeenCalled();
  });
});

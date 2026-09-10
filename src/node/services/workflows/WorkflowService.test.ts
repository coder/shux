/* eslint-disable @typescript-eslint/await-thenable, @typescript-eslint/require-await */
import * as crypto from "node:crypto";
import * as fs from "node:fs/promises";
import * as path from "node:path";

import { describe, expect, test } from "bun:test";
import assert from "@/common/utils/assert";
import { WORKFLOW_CHECKPOINT_RETRY_ERROR_MESSAGE } from "@/common/utils/workflowRetryEligibility";
import { ForegroundWaitBackgroundedError } from "@/node/services/taskService";
import { DisposableTempDir } from "@/node/services/tempDir";
import { QuickJSRuntimeFactory } from "@/node/services/ptc/quickjsRuntime";
import { WorkflowRunStore } from "./WorkflowRunStore";
import { WorkflowService } from "./WorkflowService";
import {
  acquireWorkflowArchiveAdmission,
  hasInProcessWorkflowWork,
  registerInProcessWorkflowRun,
  setWorkflowArchiveAdmissionGuard,
} from "./workflowArchiveAdmission";
import type { ResolvedWorkflowScript } from "./workflowScriptResolver";

function createScript(
  source: string,
  overrides: Partial<ResolvedWorkflowScript> = {}
): ResolvedWorkflowScript {
  return {
    requestedScriptPath: "./workflows/demo.js",
    canonicalScriptPath: "./workflows/demo.js",
    source,
    sourceHash: "sha256:test",
    sourceKind: "workspace-file",
    resolvedPath: "/workspace/workflows/demo.js",
    ...overrides,
  };
}

describe("WorkflowService archive admission", () => {
  test("startWorkflow refuses admission while the workspace archive guard is armed", async () => {
    using tmp = new DisposableTempDir("workflow-service-archive-admission");
    const runStore = new WorkflowRunStore({ sessionDir: tmp.path });
    const service = new WorkflowService({
      runStore,
      runtimeFactory: new QuickJSRuntimeFactory(),
      taskAdapter: {
        async runAgent() {
          throw new Error("No agent steps expected");
        },
      },
      generateRunId: () => "wfr_admission_refused",
      runnerId: "runner-admission",
    });

    setWorkflowArchiveAdmissionGuard((workspaceId) =>
      workspaceId === "workspace-archiving" ? "Workspace is being archived: refuse" : null
    );
    try {
      await expectStartRefused(service, "workspace-archiving");
      // Background checkpoint retry is a run-starting entry point too: admission is acquired
      // at method entry, before the run lookup, so the refusal fires even for eligible runs.
      try {
        await service.retryRunFromCheckpointInBackground({
          workspaceId: "workspace-archiving",
          runId: "wfr_any",
          projectTrusted: true,
        });
        expect.unreachable("retryRunFromCheckpointInBackground must refuse while archiving");
      } catch (error) {
        expect(String(error)).toContain("being archived");
      }
      // No durable run may be created for a refused admission.
      expect(await runStore.listRuns()).toEqual([]);
      expect(hasInProcessWorkflowWork("workspace-archiving")).toBe(false);
    } finally {
      setWorkflowArchiveAdmissionGuard(() => null);
    }
  });

  test("admissions and in-process runs release their workspace work when disposed", () => {
    expect(hasInProcessWorkflowWork("workspace-admission")).toBe(false);
    {
      using _admission = acquireWorkflowArchiveAdmission("workspace-admission");
      expect(hasInProcessWorkflowWork("workspace-admission")).toBe(true);
      const release = registerInProcessWorkflowRun("workspace-admission");
      release();
      // Idempotent release must not free the still-held admission.
      release();
      expect(hasInProcessWorkflowWork("workspace-admission")).toBe(true);
    }
    expect(hasInProcessWorkflowWork("workspace-admission")).toBe(false);
  });
});

async function expectStartRefused(service: WorkflowService, workspaceId: string): Promise<void> {
  try {
    await service.startWorkflow({
      script: createScript("export default function workflow() { return {}; }\n"),
      workspaceId,
      projectTrusted: true,
      args: {},
    });
    expect.unreachable("startWorkflow must refuse while the workspace is being archived");
  } catch (error) {
    expect(String(error)).toContain("being archived");
  }
}

describe("WorkflowService", () => {
  test("starts an explicit script workflow and persists the resolved source snapshot", async () => {
    using tmp = new DisposableTempDir("workflow-service-script-path");
    const source = `export default function workflow({ args }) {
  return { reportMarkdown: "Hello " + args.topic };
}
`;
    const runStore = new WorkflowRunStore({ sessionDir: tmp.path });
    const service = new WorkflowService({
      runStore,
      runtimeFactory: new QuickJSRuntimeFactory(),
      taskAdapter: {
        async runAgent() {
          throw new Error("No agent steps expected");
        },
      },
      generateRunId: () => "wfr_script_path",
      runnerId: "runner-a",
      clock: {
        nowIso: () => "2026-05-29T00:00:00.000Z",
        nowMs: () => 1_000,
      },
    });

    const result = await service.startWorkflow({
      script: createScript(source, {
        resolvedPath: path.join(tmp.path, "project", "workflows", "demo.js"),
      }),
      workspaceId: "workspace-1",
      projectTrusted: true,
      args: { topic: "script paths" },
    });

    const run = await runStore.getRun("wfr_script_path");
    expect(result).toEqual({
      runId: "wfr_script_path",
      status: "completed",
      result: { reportMarkdown: "Hello script paths" },
    });
    expect(run.source).toBe(source);
    expect(run.sourceHash).not.toBe("sha256:test");
    expect(run.workflow).toMatchObject({
      name: "demo",
      description: "Workflow script ./workflows/demo.js",
      scope: "project",
      sourcePath: "./workflows/demo.js",
      requestedScriptPath: "./workflows/demo.js",
      canonicalScriptPath: "./workflows/demo.js",
      sourceKind: "workspace-file",
      sourceHash: "sha256:test",
      executable: true,
    });
  });

  test("persists inline workflow source with project-scoped virtual provenance", async () => {
    using tmp = new DisposableTempDir("workflow-service-inline-source");
    const source = `export default function workflow({ args }) {
  return { reportMarkdown: "Inline " + args.value };
}
`;
    const sourceHash = crypto.createHash("sha256").update(source).digest("hex");
    const virtualPath = `inline://workflow-${sourceHash.slice(0, 12)}.js`;
    const runStore = new WorkflowRunStore({ sessionDir: tmp.path });
    const service = new WorkflowService({
      runStore,
      runtimeFactory: new QuickJSRuntimeFactory(),
      taskAdapter: {
        async runAgent() {
          throw new Error("No agent steps expected");
        },
      },
      generateRunId: () => "wfr_inline_source",
      runnerId: "runner-a",
      clock: {
        nowIso: () => "2026-05-29T00:00:00.000Z",
        nowMs: () => 1_000,
      },
    });

    const result = await service.startWorkflow({
      script: createScript(source, {
        requestedScriptPath: virtualPath,
        canonicalScriptPath: virtualPath,
        sourceHash,
        sourceKind: "inline",
      }),
      workspaceId: "workspace-1",
      projectTrusted: true,
      args: { value: "ok" },
    });

    const loaded = await runStore.getRun("wfr_inline_source");
    expect(result).toEqual({
      runId: "wfr_inline_source",
      status: "completed",
      result: { reportMarkdown: "Inline ok" },
    });
    expect(loaded.source).toBe(source);
    expect(loaded.sourceHash).toBe(`sha256:${sourceHash}`);
    expect(loaded.workflow).toMatchObject({
      name: `inline-${sourceHash.slice(0, 12)}`,
      description: `Workflow script ${virtualPath}`,
      scope: "project",
      sourcePath: virtualPath,
      requestedScriptPath: virtualPath,
      canonicalScriptPath: virtualPath,
      sourceKind: "inline",
      sourceHash,
      executable: true,
    });
  });

  test("uses workflow meta name and description for the run descriptor", async () => {
    using tmp = new DisposableTempDir("workflow-service-meta-descriptor");
    const source = `export const meta = { name: "Deep Research", description: "Research deeply" };
export default function workflow() { return { reportMarkdown: "done" }; }
`;
    const runStore = new WorkflowRunStore({ sessionDir: tmp.path });
    const service = new WorkflowService({
      runStore,
      runtimeFactory: new QuickJSRuntimeFactory(),
      taskAdapter: {
        async runAgent() {
          throw new Error("No agent steps expected");
        },
      },
      generateRunId: () => "wfr_meta_descriptor",
      runnerId: "runner-a",
    });

    await service.startWorkflow({
      script: createScript(source),
      workspaceId: "workspace-1",
      projectTrusted: true,
      args: {},
    });

    const run = await runStore.getRun("wfr_meta_descriptor");
    expect(run.workflow).toMatchObject({
      name: "deep-research",
      description: "Research deeply",
    });
  });

  test("ignores legacy metadata export names when building the run descriptor", async () => {
    using tmp = new DisposableTempDir("workflow-service-legacy-metadata-descriptor");
    const legacyMetaIdentifier = "metadata";
    const source = `export const ${legacyMetaIdentifier} = { name: "Legacy Name", description: "Legacy description" };
export default function workflow() { return { reportMarkdown: "done" }; }
`;
    const runStore = new WorkflowRunStore({ sessionDir: tmp.path });
    const service = new WorkflowService({
      runStore,
      runtimeFactory: new QuickJSRuntimeFactory(),
      taskAdapter: {
        async runAgent() {
          throw new Error("No agent steps expected");
        },
      },
      generateRunId: () => "wfr_legacy_metadata_descriptor",
      runnerId: "runner-a",
    });

    await service.startWorkflow({
      script: createScript(source),
      workspaceId: "workspace-1",
      projectTrusted: true,
      args: {},
    });

    const run = await runStore.getRun("wfr_legacy_metadata_descriptor");
    expect(run.workflow).toMatchObject({
      name: "demo",
      description: "Workflow script ./workflows/demo.js",
    });
  });

  test("notifies run status changes around a foreground script run", async () => {
    using tmp = new DisposableTempDir("workflow-service-status");
    const runStore = new WorkflowRunStore({ sessionDir: tmp.path });
    const statusEvents: Array<{ workspaceId: string; runId: string; status: string }> = [];
    const service = new WorkflowService({
      runStore,
      onRunStatusChanged: (event) => {
        statusEvents.push(event);
      },
      runtimeFactory: new QuickJSRuntimeFactory(),
      taskAdapter: {
        async runAgent() {
          return {
            taskId: "task_1",
            reportMarkdown: "child summary",
            structuredOutput: { summary: "child summary" },
          };
        },
      },
      generateRunId: () => "wfr_demo",
      runnerId: "runner-a",
      clock: {
        nowIso: () => "2026-05-29T00:00:00.000Z",
        nowMs: () => 1_000,
      },
    });

    const result = await service.startWorkflow({
      script: createScript(`export default async function workflow({ agent }) {
  const child = await agent("Summarize", {
    id: "summarize",
    schema: { type: "object", required: ["summary"], properties: { summary: { type: "string" } } },
  });
  return { reportMarkdown: "Final " + child.summary };
}
`),
      workspaceId: "workspace-1",
      projectTrusted: true,
      args: {},
    });

    expect(result).toEqual({
      runId: "wfr_demo",
      status: "completed",
      result: { reportMarkdown: "Final child summary" },
    });
    expect(statusEvents).toEqual([
      { workspaceId: "workspace-1", runId: "wfr_demo", status: "pending" },
      { workspaceId: "workspace-1", runId: "wfr_demo", status: "completed" },
    ]);
  });

  test("background workflow starts persist notify_on_terminal policy", async () => {
    using tmp = new DisposableTempDir("workflow-service-background-notify");
    const runStore = new WorkflowRunStore({ sessionDir: tmp.path });
    const service = new WorkflowService({
      runStore,
      runtimeFactory: new QuickJSRuntimeFactory(),
      taskAdapter: {
        async runAgent() {
          throw new Error("No agent steps expected");
        },
      },
      generateRunId: () => "wfr_background_notify",
      runnerId: "runner-a",
      clock: {
        nowIso: () => "2026-05-29T00:00:00.000Z",
        nowMs: () => 1_000,
      },
    });

    const result = await service.startWorkflowInBackground({
      script: createScript(
        `export default function workflow() { return { reportMarkdown: "done" }; }\n`
      ),
      workspaceId: "workspace-1",
      projectTrusted: true,
      args: {},
    });

    expect(result).toMatchObject({
      runId: "wfr_background_notify",
      status: "running",
      result: null,
    });
    await expect(runStore.getRun("wfr_background_notify")).resolves.toMatchObject({
      attentionPolicy: "notify_on_terminal",
    });
  });

  test("foreground workflows that self-background persist notify_on_terminal policy", async () => {
    using tmp = new DisposableTempDir("workflow-service-self-background-notify");
    const runStore = new WorkflowRunStore({ sessionDir: tmp.path });
    let agentCalls = 0;
    const service = new WorkflowService({
      runStore,
      runtimeFactory: new QuickJSRuntimeFactory(),
      taskAdapter: {
        async runAgent() {
          agentCalls += 1;
          if (agentCalls === 1) {
            throw new ForegroundWaitBackgroundedError();
          }
          return {
            taskId: "task-resumed",
            reportMarkdown: "resumed",
            structuredOutput: { summary: "resumed" },
          };
        },
      },
      generateRunId: () => "wfr_self_background_notify",
      runnerId: "runner-a",
      clock: {
        nowIso: () => "2026-05-29T00:00:00.000Z",
        nowMs: () => 1_000,
      },
    });

    const result = await service.startWorkflow({
      script: createScript(`export default async function workflow({ agent }) {
  const child = await agent("Wait for queued message", {
    id: "wait-for-queue",
    schema: { type: "object", required: ["summary"], properties: { summary: { type: "string" } } },
  });
  return { reportMarkdown: child.summary };
}
`),
      workspaceId: "workspace-1",
      projectTrusted: true,
      args: {},
    });

    expect(result).toEqual({
      runId: "wfr_self_background_notify",
      status: "backgrounded",
      result: null,
    });
    await expect(runStore.getRun("wfr_self_background_notify")).resolves.toMatchObject({
      attentionPolicy: "notify_on_terminal",
    });
  });

  test("background checkpoint retry persists notify_on_terminal policy", async () => {
    using tmp = new DisposableTempDir("workflow-service-checkpoint-retry-notify");
    const runStore = new WorkflowRunStore({ sessionDir: tmp.path });
    await runStore.createRun({
      id: "wfr_checkpoint_retry_notify",
      workspaceId: "workspace-1",
      workflow: {
        name: "demo",
        description: "Workflow script ./workflows/demo.js",
        scope: "project",
        executable: true,
      },
      source: `export default function workflow() { return { reportMarkdown: "retried" }; }\n`,
      args: {},
      now: "2026-05-29T00:00:00.000Z",
    });
    await runStore.appendStatus(
      "wfr_checkpoint_retry_notify",
      "running",
      "2026-05-29T00:00:01.000Z"
    );
    await runStore.appendNextEvent("wfr_checkpoint_retry_notify", {
      type: "error",
      at: "2026-05-29T00:00:02.000Z",
      message: WORKFLOW_CHECKPOINT_RETRY_ERROR_MESSAGE,
    });
    await runStore.appendStatus(
      "wfr_checkpoint_retry_notify",
      "failed",
      "2026-05-29T00:00:03.000Z"
    );

    const service = new WorkflowService({
      runStore,
      runtimeFactory: new QuickJSRuntimeFactory(),
      taskAdapter: {
        async runAgent() {
          throw new Error("No agent steps expected");
        },
      },
      runnerId: "runner-a",
      clock: {
        nowIso: () => "2026-05-29T00:00:04.000Z",
        nowMs: () => 4_000,
      },
    });

    const result = await service.retryRunFromCheckpointInBackground({
      workspaceId: "workspace-1",
      runId: "wfr_checkpoint_retry_notify",
      projectTrusted: true,
    });

    expect(result).toMatchObject({
      runId: "wfr_checkpoint_retry_notify",
      status: "running",
      result: null,
    });
    await expect(runStore.getRun("wfr_checkpoint_retry_notify")).resolves.toMatchObject({
      attentionPolicy: "notify_on_terminal",
    });
  });

  test("does not continue canceled foreground workflows in the background", async () => {
    using tmp = new DisposableTempDir("workflow-service-canceled-background");
    const runStore = new WorkflowRunStore({ sessionDir: tmp.path });
    const abortController = new AbortController();
    let runnerFactoryCalls = 0;
    const service = new WorkflowService({
      runStore,
      runtimeFactory: new QuickJSRuntimeFactory(),
      taskAdapterFactory: (_runId, workflowName) => {
        if (workflowName != null) {
          runnerFactoryCalls += 1;
        }
        return {
          async runAgent() {
            abortController.abort();
            throw new ForegroundWaitBackgroundedError();
          },
          async interruptRun() {
            // The foreground caller cancellation is expected to interrupt the run.
          },
        };
      },
      generateRunId: () => "wfr_canceled_foreground",
      runnerId: "runner-a",
      clock: {
        nowIso: () => "2026-05-29T00:00:00.000Z",
        nowMs: () => 1_000,
      },
    });

    const result = await service.startWorkflow({
      script: createScript(`export default async function workflow({ agent }) {
  await agent("Queue follow-up", {
    id: "queue-follow-up",
    schema: { type: "object", required: ["summary"], properties: { summary: { type: "string" } } },
  });
  return { reportMarkdown: "done" };
}
`),
      workspaceId: "workspace-1",
      projectTrusted: true,
      args: {},
      abortSignal: abortController.signal,
    });

    expect(result).toEqual({
      runId: "wfr_canceled_foreground",
      status: "backgrounded",
      result: null,
    });
    expect(runnerFactoryCalls).toBe(1);
    await expect(runStore.getRun("wfr_canceled_foreground")).resolves.toMatchObject({
      status: "interrupted",
    });
  });

  test("runs nested workflow scripts as durable child runs", async () => {
    using tmp = new DisposableTempDir("workflow-service-nested-run");
    const runStore = new WorkflowRunStore({ sessionDir: tmp.path });
    const childSource = `export const meta = {
  name: "Child Workflow",
  description: "Nested child",
  argsSchema: {
    type: "object",
    properties: { input: { type: "string" } },
    required: ["input"]
  }
};
export default function workflow({ args }) {
  return { reportMarkdown: "Child " + args.input };
}
`;
    const childScript = createScript(childSource, {
      requestedScriptPath: "./workflows/child.js",
      canonicalScriptPath: "./workflows/child.js",
      resolvedPath: path.join(tmp.path, "project", "workflows", "child.js"),
    });
    const service = new WorkflowService({
      runStore,
      runtimeFactory: new QuickJSRuntimeFactory(),
      taskAdapter: {
        async runAgent() {
          throw new Error("No agent steps expected");
        },
      },
      resolveWorkflowScript: async (scriptPath) => {
        expect(scriptPath).toBe("./workflows/child.js");
        return childScript;
      },
      generateRunId: () => "wfr_parent_nested",
      runnerId: "runner-a",
      clock: {
        nowIso: () => "2026-05-29T00:00:00.000Z",
        nowMs: () => 1_000,
      },
    });

    const childInput = "quoted markdown: I'm testing --not-a-flag";
    const result = await service.startWorkflow({
      script: createScript(`export default function workflow({ workflow }) {
  const child = workflow("./workflows/child.js", { id: "child-step", args: { input: "${childInput}" } });
  return { reportMarkdown: "Parent saw " + child.reportMarkdown };
}
`),
      workspaceId: "workspace-1",
      projectTrusted: true,
      args: {},
    });
    const parentRun = await runStore.getRun("wfr_parent_nested");
    const childRunIds = (await runStore.listRunStatusSnapshots())
      .filter((snapshot) => snapshot.parentWorkflow?.runId === "wfr_parent_nested")
      .map((snapshot) => snapshot.id);
    expect(childRunIds).toHaveLength(1);
    const childRunId = childRunIds[0];
    assert(childRunId != null, "nested workflow test must create one child run");
    const childRun = await runStore.getRun(childRunId);

    expect(result.result).toEqual({ reportMarkdown: `Parent saw Child ${childInput}` });
    expect(childRun).toMatchObject({
      workspaceId: "workspace-1",
      status: "completed",
      args: { input: childInput },
      workflow: { name: "child-workflow", sourcePath: "./workflows/child.js" },
      parentWorkflow: { runId: "wfr_parent_nested", stepId: "child-step" },
    });
    expect(
      parentRun.events.some(
        (event) =>
          event.type === "workflow" &&
          event.stepId === "child-step" &&
          event.runId === childRun.id &&
          event.name === "child-workflow" &&
          event.status === "completed"
      )
    ).toBe(true);
  });

  test("interrupts active child workflow runs with the parent", async () => {
    using tmp = new DisposableTempDir("workflow-service-interrupt-nested-run");
    const runStore = new WorkflowRunStore({ sessionDir: tmp.path });
    const definition = {
      name: "demo",
      description: "Demo",
      scope: "project",
      sourcePath: "./workflows/demo.js",
      executable: true,
    } as const;
    await runStore.createRun({
      id: "wfr_parent_interrupt",
      workspaceId: "workspace-1",
      workflow: definition,
      source: "export default function workflow() { return {}; }\n",
      args: {},
      now: "2026-05-29T00:00:00.000Z",
    });
    await runStore.createRun({
      id: "wfr_child_interrupt",
      workspaceId: "workspace-1",
      workflow: definition,
      source: "export default function workflow() { return {}; }\n",
      args: {},
      parentWorkflow: {
        runId: "wfr_parent_interrupt",
        stepId: "child-step",
        inputHash: "child-hash",
        depth: 1,
      },
      now: "2026-05-29T00:00:01.000Z",
    });
    await runStore.appendStatus("wfr_parent_interrupt", "running", "2026-05-29T00:00:02.000Z");
    await runStore.appendStatus("wfr_child_interrupt", "running", "2026-05-29T00:00:03.000Z");
    const interruptedRunIds: string[] = [];
    const service = new WorkflowService({
      runStore,
      runtimeFactory: new QuickJSRuntimeFactory(),
      taskAdapterFactory: (runId) => ({
        async runAgent() {
          throw new Error("No agent steps expected");
        },
        async interruptRun() {
          interruptedRunIds.push(runId);
        },
      }),
      runnerId: "runner-a",
      clock: {
        nowIso: () => "2026-05-29T00:00:04.000Z",
        nowMs: () => 4_000,
      },
    });

    await service.interruptRun({ workspaceId: "workspace-1", runId: "wfr_parent_interrupt" });

    await expect(runStore.getRun("wfr_parent_interrupt")).resolves.toMatchObject({
      status: "interrupted",
    });
    await expect(runStore.getRun("wfr_child_interrupt")).resolves.toMatchObject({
      status: "interrupted",
    });
    expect(interruptedRunIds).toEqual(["wfr_parent_interrupt", "wfr_child_interrupt"]);
  });

  test("listRuns only loads root runs for the requested workspace", async () => {
    using tmp = new DisposableTempDir("workflow-service-list-runs");
    const runStore = new WorkflowRunStore({ sessionDir: tmp.path });
    const definition = {
      name: "demo",
      description: "Demo",
      scope: "built-in",
      sourcePath: "skill://demo/workflow.js",
      executable: true,
    } as const;
    await runStore.createRun({
      id: "wfr_workspace_1",
      workspaceId: "workspace-1",
      workflow: definition,
      source: "export default function workflow() { return {}; }\n",
      args: {},
      now: "2026-05-29T00:00:00.000Z",
    });
    await runStore.createRun({
      id: "wfr_workspace_2",
      workspaceId: "workspace-2",
      workflow: definition,
      source: "export default function workflow() { return {}; }\n",
      args: {},
      now: "2026-05-29T00:00:01.000Z",
    });
    await runStore.createRun({
      id: "wfr_workspace_1_child",
      workspaceId: "workspace-1",
      workflow: definition,
      source: "export default function workflow() { return {}; }\n",
      args: {},
      parentWorkflow: {
        runId: "wfr_workspace_1",
        stepId: "child-step",
        inputHash: "child-hash",
        depth: 1,
      },
      now: "2026-05-29T00:00:02.000Z",
    });
    const service = new WorkflowService({
      runStore,
      runtimeFactory: new QuickJSRuntimeFactory(),
      taskAdapter: {
        async runAgent() {
          throw new Error("No agent steps expected");
        },
      },
      runnerId: "runner-a",
    });

    const runs = await service.listRuns({ workspaceId: "workspace-1" });

    expect(runs.map((run) => run.id)).toEqual(["wfr_workspace_1"]);
  });

  test("getRun and listRuns hydrate the phase manifest on the service itself", async () => {
    // workflow_run/workflow_resume call these directly (not the oRPC wrappers) and
    // embed the result in persisted tool output that reloaded cards render as-is.
    using tmp = new DisposableTempDir("workflow-service-hydrate");
    const runStore = new WorkflowRunStore({ sessionDir: tmp.path });
    await runStore.createRun({
      id: "wfr_hydrated",
      workspaceId: "workspace-1",
      workflow: { name: "demo", description: "Demo", scope: "built-in", executable: true },
      source:
        'export const meta = { phases: [{ name: "a" }] };\n' +
        'export default function workflow({ phase }) { phase("a"); return {}; }\n',
      args: {},
      now: "2026-05-29T00:00:00.000Z",
    });
    const service = new WorkflowService({
      runStore,
      runtimeFactory: new QuickJSRuntimeFactory(),
      taskAdapter: {
        async runAgent() {
          throw new Error("No agent steps expected");
        },
      },
      runnerId: "runner-a",
    });

    const expected = { provenance: "declared" as const, phases: [{ name: "a" }] };
    const run = await service.getRun({ workspaceId: "workspace-1", runId: "wfr_hydrated" });
    expect(run?.workflow.phaseManifest).toEqual(expected);
    const [listed] = await service.listRuns({ workspaceId: "workspace-1" });
    expect(listed?.workflow.phaseManifest).toEqual(expected);
    // The store record itself stays manifest-free.
    expect((await runStore.getRun("wfr_hydrated")).workflow.phaseManifest).toBeUndefined();
  });

  test("rejects resuming untrusted workspace-file workflow runs", async () => {
    using tmp = new DisposableTempDir("workflow-service-trust");
    const runStore = new WorkflowRunStore({ sessionDir: tmp.path });
    await runStore.createRun({
      id: "wfr_untrusted",
      workspaceId: "workspace-1",
      workflow: {
        name: "demo",
        description: "Demo",
        scope: "project",
        sourcePath: "./workflows/demo.js",
        executable: true,
      },
      source: "export default function workflow() { return {}; }\n",
      args: {},
      now: "2026-05-29T00:00:00.000Z",
    });
    const service = new WorkflowService({
      runStore,
      runtimeFactory: new QuickJSRuntimeFactory(),
      taskAdapter: {
        async runAgent() {
          throw new Error("No agent steps expected");
        },
      },
      runnerId: "runner-a",
    });

    await expect(
      service.resumeRun({
        workspaceId: "workspace-1",
        runId: "wfr_untrusted",
        projectTrusted: false,
      })
    ).rejects.toThrow("Project trust is required");
  });
});

describe("WorkflowRunStore.getRunStatusForLiveness", () => {
  test("maps only definitively-missing records to null and rethrows read failures", async () => {
    using tmp = new DisposableTempDir("workflow-service-liveness");
    const source = `export default function workflow() {
  return { reportMarkdown: "done" };
}
`;
    const runStore = new WorkflowRunStore({ sessionDir: tmp.path });
    const service = new WorkflowService({
      runStore,
      runtimeFactory: new QuickJSRuntimeFactory(),
      taskAdapter: {
        async runAgent() {
          throw new Error("No agent steps expected");
        },
      },
      generateRunId: () => "wfr_liveness",
      runnerId: "runner-liveness",
    });
    await service.startWorkflow({
      script: createScript(source),
      workspaceId: "workspace-1",
      projectTrusted: true,
      args: {},
    });

    // Existing record: real status.
    expect(
      await runStore.getRunStatusForLiveness({ workspaceId: "workspace-1", runId: "wfr_liveness" })
    ).toBe("completed");
    // Definitively missing record / wrong owner: null (settled for that ref).
    expect(
      await runStore.getRunStatusForLiveness({ workspaceId: "workspace-1", runId: "wfr_absent" })
    ).toBeNull();
    expect(
      await runStore.getRunStatusForLiveness({ workspaceId: "workspace-2", runId: "wfr_liveness" })
    ).toBeNull();

    // A missing presentation-only file must not read as "run gone": liveness
    // consults only the durable status snapshot, never source/step files.
    await fs.rm(path.join(tmp.path, "workflows", "wfr_liveness", "source.js"));
    expect(
      await runStore.getRunStatusForLiveness({ workspaceId: "workspace-1", runId: "wfr_liveness" })
    ).toBe("completed");

    // A transient read/parse failure must propagate (callers retry) instead of
    // masquerading as a missing record — unlike getRun(), which maps it to null.
    const runFile = path.join(tmp.path, "workflows", "wfr_liveness", "run.json");
    await fs.writeFile(runFile, "{ not json", "utf-8");
    await expect(
      runStore.getRunStatusForLiveness({ workspaceId: "workspace-1", runId: "wfr_liveness" })
    ).rejects.toThrow();
    expect(await service.getRun({ workspaceId: "workspace-1", runId: "wfr_liveness" })).toBeNull();
  });
});

describe("WorkflowRunStore.listActiveRunSummaries", () => {
  test("includes nested active runs and excludes settled or foreign-workspace runs", async () => {
    using tmp = new DisposableTempDir("workflow-service-active-summaries");
    const runStore = new WorkflowRunStore({ sessionDir: tmp.path });
    const service = new WorkflowService({
      runStore,
      runtimeFactory: new QuickJSRuntimeFactory(),
      taskAdapter: {
        async runAgent() {
          throw new Error("No agent steps expected");
        },
      },
      generateRunId: () => "wfr_completed_run",
      runnerId: "runner-active-summaries",
    });
    const descriptor = {
      name: "deep-research",
      description: "Research a topic",
      scope: "built-in" as const,
      executable: true,
    };
    const source = "export default async function workflow() { return 'ok'; }\n";
    const now = "2026-05-29T00:00:00.000Z";
    // Active (pending) top-level and NESTED runs — nested runs are deliberately
    // absent from workspace activity, so this discovery read is the only way a
    // cold-mounted tray can learn about them mid-gap.
    await runStore.createRun({
      id: "wfr_top_active",
      workspaceId: "workspace-1",
      workflow: descriptor,
      source,
      args: {},
      now,
    });
    await runStore.createRun({
      id: "wfr_nested_active",
      workspaceId: "workspace-1",
      workflow: { ...descriptor, name: "implementation-loop" },
      source,
      args: {},
      parentWorkflow: { runId: "wfr_top_active", stepId: "step-1", inputHash: "hash-1", depth: 1 },
      now,
    });
    await runStore.createRun({
      id: "wfr_other_workspace",
      workspaceId: "workspace-2",
      workflow: descriptor,
      source,
      args: {},
      now,
    });
    // A settled run must not be discovered.
    await service.startWorkflow({
      script: createScript(
        'export default function workflow() {\n  return { reportMarkdown: "done" };\n}\n'
      ),
      workspaceId: "workspace-1",
      projectTrusted: true,
      args: {},
    });

    const summaries = await runStore.listActiveRunSummaries({ workspaceId: "workspace-1" });
    summaries.sort((a, b) => a.runId.localeCompare(b.runId));
    expect(summaries).toEqual([
      { runId: "wfr_nested_active", workflowName: "implementation-loop", nested: true },
      { runId: "wfr_top_active", workflowName: "deep-research", nested: false },
    ]);
  });

  test("treats a missing workflows dir as empty", async () => {
    using tmp = new DisposableTempDir("workflow-store-discovery-fresh");
    const runStore = new WorkflowRunStore({ sessionDir: tmp.path });
    expect(await runStore.listActiveRunSummaries({ workspaceId: "workspace-1" })).toEqual([]);
  });

  // Root bypasses permission bits and Windows ignores POSIX modes, so the
  // unreadable-dir scenario is only reproducible on non-root POSIX runs.
  const canDropDirPermissions = process.platform !== "win32" && process.getuid?.() !== 0;
  test.skipIf(!canDropDirPermissions)(
    "rejects discovery when the workflows dir is unreadable instead of reporting empty",
    async () => {
      using tmp = new DisposableTempDir("workflow-store-discovery-unreadable");
      const runStore = new WorkflowRunStore({ sessionDir: tmp.path });
      await runStore.createRun({
        id: "wfr_unreadable",
        workspaceId: "workspace-1",
        workflow: {
          name: "deep-research",
          description: "Research a topic",
          scope: "built-in" as const,
          executable: true,
        },
        source: "export default async function workflow() { return 'ok'; }\n",
        args: {},
        now: "2026-05-29T00:00:00.000Z",
      });
      const workflowsDir = path.join(tmp.path, "workflows");
      await fs.chmod(workflowsDir, 0o000);
      try {
        // Strict discovery must surface the failure so callers retry…
        await expect(
          runStore.listActiveRunSummaries({ workspaceId: "workspace-1" })
        ).rejects.toThrow();
        // …while lenient callers (activity/UI lists) still degrade to empty.
        expect(await runStore.listRunStatusSnapshots()).toEqual([]);
      } finally {
        await fs.chmod(workflowsDir, 0o755);
      }

      // Per-record IO failures must also reject in strict mode: silently
      // omitting an unreadable-but-active run would be a false success.
      const runFile = path.join(workflowsDir, "wfr_unreadable", "run.json");
      await fs.chmod(runFile, 0o000);
      try {
        await expect(
          runStore.listActiveRunSummaries({ workspaceId: "workspace-1" })
        ).rejects.toThrow();
      } finally {
        await fs.chmod(runFile, 0o644);
      }

      // Journal IO failures must reject too: after a crash the active status
      // can exist only in events.jsonl, so a swallowed journal read error
      // would fall back to a stale run.json status and silently omit the run.
      const eventsFile = path.join(workflowsDir, "wfr_unreadable", "events.jsonl");
      await fs.chmod(eventsFile, 0o000);
      try {
        await expect(
          runStore.listActiveRunSummaries({ workspaceId: "workspace-1" })
        ).rejects.toThrow();
      } finally {
        await fs.chmod(eventsFile, 0o644);
      }
    }
  );

  test("skips a corrupt run record instead of hiding every other run", async () => {
    using tmp = new DisposableTempDir("workflow-store-discovery-corrupt");
    const runStore = new WorkflowRunStore({ sessionDir: tmp.path });
    const descriptor = {
      name: "deep-research",
      description: "Research a topic",
      scope: "built-in" as const,
      executable: true,
    };
    const source = "export default async function workflow() { return 'ok'; }\n";
    await runStore.createRun({
      id: "wfr_healthy",
      workspaceId: "workspace-1",
      workflow: descriptor,
      source,
      args: {},
      now: "2026-05-29T00:00:00.000Z",
    });
    await runStore.createRun({
      id: "wfr_corrupt",
      workspaceId: "workspace-1",
      workflow: descriptor,
      source,
      args: {},
      now: "2026-05-29T00:00:01.000Z",
    });
    // Permanent data corruption (not an IO error) self-heals by omission —
    // one bad record must not turn discovery into a forever-rejecting call
    // that hides the healthy run too.
    await fs.writeFile(path.join(tmp.path, "workflows", "wfr_corrupt", "run.json"), "{ not json");
    const summaries = await runStore.listActiveRunSummaries({ workspaceId: "workspace-1" });
    expect(summaries.map((summary) => summary.runId)).toEqual(["wfr_healthy"]);
  });
});

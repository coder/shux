/* eslint-disable @typescript-eslint/no-unsafe-argument, @typescript-eslint/no-unsafe-assignment, @typescript-eslint/require-await, local/no-sync-fs-methods */
import * as fs from "node:fs";
import * as path from "node:path";

import { afterEach, beforeEach, describe, expect, mock, test } from "bun:test";
import { Config } from "@/node/config";
import { QuickJSRuntimeFactory } from "@/node/services/ptc/quickjsRuntime";
import { DisposableTempDir } from "@/node/services/tempDir";
import { WorkflowRunStore } from "./WorkflowRunStore";
import {
  interruptWorkflowRun,
  listWorkflowRuns,
  listWorkflowScripts,
  resumeWorkflowRun,
  startWorkflowRun,
  type WorkflowServiceContext,
} from "./WorkflowService";
import { WorkflowArgsValidationError } from "./workflowArgs";
import { WorkflowDeclaredPhasesValidationError } from "./workflowMetadata";

interface TestWorkspaceService {
  emitWorkflowRunActivity: ReturnType<typeof mock>;
  waitForWorkspaceIdle: ReturnType<typeof mock>;
  prepareManualWorkflowInvocation: ReturnType<typeof mock>;
  appendWorkflowRunInvocation: ReturnType<typeof mock>;
  isWorkflowInvocationCurrent: ReturnType<typeof mock>;
  getWorkflowContinuationSendOptions: ReturnType<typeof mock>;
  sendMessage: ReturnType<typeof mock>;
}

describe("WorkflowService request orchestration", () => {
  let temp: DisposableTempDir;
  let config: Config;
  let projectPath: string;

  beforeEach(async () => {
    temp = new DisposableTempDir("workflow-service-context");
    config = new Config(temp.path);
    projectPath = path.join(temp.path, "project");
    fs.mkdirSync(path.join(projectPath, "workflows"), { recursive: true });
    fs.writeFileSync(
      path.join(projectPath, "workflows", "demo.js"),
      'export const meta = { description: "Demo workflow" };\n' +
        "export default function workflow({ args }) { return { reportMarkdown: args.topic }; }\n"
    );
    await config.editConfig((current) => {
      current.projects.set(projectPath, { workspaces: [], trusted: true });
      return current;
    });
  });

  afterEach(() => temp[Symbol.dispose]());

  function createContext(
    options: {
      enabled?: boolean;
      workspacePath?: string;
      subProjectPath?: string;
    } = {}
  ): {
    context: WorkflowServiceContext;
    workspaceService: TestWorkspaceService;
    waitForInit: ReturnType<typeof mock>;
  } {
    const workspacePath = options.workspacePath ?? projectPath;
    const workspaceService: TestWorkspaceService = {
      emitWorkflowRunActivity: mock(async () => undefined),
      waitForWorkspaceIdle: mock(async () => undefined),
      prepareManualWorkflowInvocation: mock(async () => undefined),
      appendWorkflowRunInvocation: mock(async () => true),
      isWorkflowInvocationCurrent: mock(async () => false),
      getWorkflowContinuationSendOptions: mock(async () => null),
      sendMessage: mock(async () => ({ success: true, data: undefined })),
    };
    const waitForInit = mock(async () => undefined);
    const context = {
      workflowRuntimeFactory: new QuickJSRuntimeFactory(),
      config,
      initStateManager: { waitForInit },
      aiService: {
        resolveXumToolScopeForWorkspace: mock((_metadata, _runtime, executionPath) => ({
          type: "project",
          xumHome: temp.path,
          projectRoot: executionPath,
          projectStorageAuthority: "host-local",
          checkoutRoot: workspacePath,
        })),
        getWorkspaceMetadata: mock(async () => ({
          success: true,
          data: {
            id: "workspace-1",
            name: "workspace-1",
            projectPath,
            namedWorkspacePath: workspacePath,
            ...(options.subProjectPath != null ? { subProjectPath: options.subProjectPath } : {}),
            runtimeConfig: { type: "local", srcBaseDir: temp.path },
          },
        })),
      },
      workspaceService,
      taskService: {
        noteWorkflowRunTerminalAttention: mock(() => undefined),
        clearWorkflowRunDowngradeSettlement: mock(async () => undefined),
      },
      experimentsService: {
        isExperimentEnabled: mock(() => options.enabled ?? true),
      },
    } as unknown as WorkflowServiceContext;
    return { context, workspaceService, waitForInit };
  }

  test("starts workflows from the active subproject and inherits parent skill workflows", async () => {
    const subProjectPath = path.join(projectPath, "packages", "app");
    const skillDir = path.join(projectPath, ".mux", "skills", "parent-flow");
    fs.mkdirSync(path.join(subProjectPath, "workflows"), { recursive: true });
    fs.mkdirSync(skillDir, { recursive: true });
    fs.writeFileSync(
      path.join(subProjectPath, "workflows", "demo.js"),
      'export default function workflow({ args }) { return { reportMarkdown: "subproject:" + args.topic }; }\n'
    );
    fs.writeFileSync(
      path.join(skillDir, "SKILL.md"),
      "---\nname: parent-flow\ndescription: Parent workflow\n---\nRun it.\n"
    );
    fs.writeFileSync(
      path.join(skillDir, "workflow.js"),
      'export default function workflow({ args }) { return { reportMarkdown: "parent:" + args.topic }; }\n'
    );
    const { context } = createContext({ subProjectPath });

    const scripts = await listWorkflowScripts(context, "workspace-1");
    expect(scripts).toContainEqual(
      expect.objectContaining({ scriptPath: "skill://parent-flow/workflow.js" })
    );
    expect(
      await startWorkflowRun(context, {
        workspaceId: "workspace-1",
        scriptPath: "./workflows/demo.js",
        args: { topic: "direct" },
      })
    ).toMatchObject({ status: "completed", result: { reportMarkdown: "subproject:direct" } });
    expect(
      await startWorkflowRun(context, {
        workspaceId: "workspace-1",
        scriptPath: "skill://parent-flow/workflow.js",
        args: { topic: "direct" },
      })
    ).toMatchObject({ status: "completed", result: { reportMarkdown: "parent:direct" } });
  });

  test("waits for idle and persists slash invocation inputs before starting", async () => {
    const workspacePath = path.join(temp.path, "checkout");
    const subProjectPath = path.join(projectPath, "packages", "api");
    const activeProjectPath = path.join(workspacePath, "packages", "api");
    fs.mkdirSync(path.join(activeProjectPath, ".mux", "workflows"), { recursive: true });
    fs.writeFileSync(
      path.join(activeProjectPath, ".mux", "workflows", "needs-project.js"),
      "const s = mux.schema;\n" +
        "export const meta = { argsSchema: s.object({ projectPath: s.string(), input: s.string() }) };\n" +
        "export default function workflow({ args }) { return { reportMarkdown: args.projectPath }; }\n"
    );
    const { context, workspaceService } = createContext({ workspacePath, subProjectPath });
    let releaseIdle: (() => void) | undefined;
    workspaceService.waitForWorkspaceIdle = mock(
      () => new Promise<void>((resolve) => (releaseIdle = resolve))
    );
    const runStore = new WorkflowRunStore({
      sessionDir: path.join(config.sessionsDir, "workspace-1"),
    });

    const start = startWorkflowRun(context, {
      workspaceId: "workspace-1",
      scriptPath: "./.mux/workflows/needs-project.js",
      runInBackground: true,
      args: { input: "hello" },
      rawCommand: "/workflow needs-project hello",
    });
    await waitFor(() => workspaceService.waitForWorkspaceIdle.mock.calls.length === 1);
    expect(workspaceService.prepareManualWorkflowInvocation).not.toHaveBeenCalled();
    expect(await runStore.listRuns()).toEqual([]);

    releaseIdle?.();
    const result = await start;
    const run = await runStore.getRun(result.runId);
    expect(result).toMatchObject({ status: "running", invocationMessagePersisted: true });
    expect(run.args).toEqual({ projectPath: activeProjectPath, input: "hello" });
    expect(workspaceService.appendWorkflowRunInvocation).toHaveBeenCalledWith(
      expect.objectContaining({
        rawCommand: "/workflow needs-project hello",
        args: { input: "hello" },
        status: "running",
      })
    );
  });

  test("preserves workflow argument validation errors without coercing null", async () => {
    const workflows = [
      {
        name: "required.js",
        source:
          "const s = mux.schema;\n" +
          "export const meta = { argsSchema: s.object({ topic: s.string() }) };\n" +
          "export default function workflow() { return {}; }\n",
        args: {},
        message: "Workflow argument topic is required",
      },
      {
        name: "null.js",
        source:
          "const s = mux.schema;\n" +
          "export const meta = { argsSchema: s.object({ quick: s.optional(s.boolean()) }) };\n" +
          "export default function workflow() { return {}; }\n",
        args: null,
        message: "Workflow args must be an object for object argsSchema",
      },
      {
        name: "malformed.js",
        source:
          'export const meta = { argsSchema: { type: "object", properties: { topic: "bad" } } };\n' +
          "export default function workflow() { return {}; }\n",
        args: { topic: "hello" },
        message: "Workflow args property topic must be an object schema",
      },
    ];
    const { context } = createContext();

    for (const workflow of workflows) {
      fs.writeFileSync(path.join(projectPath, "workflows", workflow.name), workflow.source);
      try {
        await startWorkflowRun(context, {
          workspaceId: "workspace-1",
          scriptPath: "./workflows/" + workflow.name,
          args: workflow.args,
        });
        expect.unreachable("invalid workflow args must fail");
      } catch (error) {
        expect(error).toBeInstanceOf(WorkflowArgsValidationError);
        expect(error).toHaveProperty("message", workflow.message);
      }
    }
  });

  test("hydrates declared phase manifests on read paths without persisting them", async () => {
    const { context } = createContext();
    fs.writeFileSync(
      path.join(projectPath, "workflows", "phased.js"),
      'export const meta = { description: "Phased", phases: [{ name: "scope" }, { name: "verify", parallel: true }] };\n' +
        'export default function workflow({ phase }) { phase("scope"); return { reportMarkdown: "ok" }; }\n'
    );
    await startWorkflowRun(context, {
      workspaceId: "workspace-1",
      scriptPath: "./workflows/phased.js",
      args: {},
    });

    const runs = await listWorkflowRuns(context, "workspace-1");
    const phased = runs.find((run) => run.workflow.name === "phased");
    expect(phased?.workflow.phaseManifest).toEqual({
      provenance: "declared",
      phases: [{ name: "scope" }, { name: "verify", parallel: true }],
    });

    // run.json stays manifest-free: hydration happens on outbound copies only.
    const rawRunFile = fs.readFileSync(
      path.join(config.sessionsDir, "workspace-1", "workflows", phased!.id, "run.json"),
      "utf-8"
    );
    expect(rawRunFile).not.toContain("phaseManifest");
  });

  test("legacy runs hydrate inferred manifests; dynamic-name runs hydrate none", async () => {
    const runStore = new WorkflowRunStore({
      sessionDir: path.join(config.sessionsDir, "workspace-1"),
    });
    const baseRun = {
      workspaceId: "workspace-1",
      workflow: { name: "demo", description: "Demo", scope: "built-in" as const, executable: true },
      args: {},
      now: "2026-05-29T00:00:00.000Z",
    };
    await runStore.createRun({
      ...baseRun,
      id: "wfr_legacy_static",
      source:
        'export default function workflow({ phase }) { phase("a"); phase("b"); return {}; }\n',
    });
    await runStore.createRun({
      ...baseRun,
      id: "wfr_legacy_dynamic",
      source:
        'export default function workflow({ phase, args }) { phase("x-" + args.key); return {}; }\n',
    });

    const { context } = createContext();
    const runs = await listWorkflowRuns(context, "workspace-1");
    expect(runs.find((run) => run.id === "wfr_legacy_static")?.workflow.phaseManifest).toEqual({
      provenance: "inferred",
      phases: [{ name: "a" }, { name: "b" }],
    });
    // Hydrated-but-none is an explicit null (absent = pre-upgrade snapshot).
    expect(runs.find((run) => run.id === "wfr_legacy_dynamic")?.workflow.phaseManifest).toBeNull();
  });

  test("rejects run creation when meta.phases is invalid, enumerating every issue", async () => {
    const { context } = createContext();
    fs.writeFileSync(
      path.join(projectPath, "workflows", "bad-phases.js"),
      'export const meta = { description: "Bad", phases: [{ name: "" }, { name: "dup" }, { name: "dup", extra: 1 }] };\n' +
        "export default function workflow() { return {}; }\n"
    );
    try {
      await startWorkflowRun(context, {
        workspaceId: "workspace-1",
        scriptPath: "./workflows/bad-phases.js",
        args: {},
      });
      expect.unreachable("invalid meta.phases must fail run creation");
    } catch (error) {
      expect(error).toBeInstanceOf(WorkflowDeclaredPhasesValidationError);
      const message = String(error);
      expect(message).toContain("meta.phases[0].name must be a non-empty string");
      expect(message).toContain('duplicates phase name "dup"');
      expect(message).toContain('unknown key "extra"');
    }
    // No durable run record may exist for the refused start.
    const runs = await listWorkflowRuns(context, "workspace-1");
    expect(runs.some((run) => run.workflow.name === "bad-phases")).toBe(false);
  });

  test("still starts legacy workflows whose unreadable meta declares no phases", async () => {
    const { context } = createContext();
    fs.writeFileSync(
      path.join(projectPath, "workflows", "dynamic-description.js"),
      'const description = "Legacy";\nexport const meta = { description };\n' +
        'export default function workflow({ phase }) { phase("a"); return { reportMarkdown: "ok" }; }\n'
    );
    const result = await startWorkflowRun(context, {
      workspaceId: "workspace-1",
      scriptPath: "./workflows/dynamic-description.js",
      args: {},
    });
    expect(result.status).toBe("completed");
  });

  test("rejects run creation when meta declares phases but is not statically readable", async () => {
    const { context } = createContext();
    fs.writeFileSync(
      path.join(projectPath, "workflows", "dynamic-meta.js"),
      'const phases = [{ name: "a" }];\nexport const meta = { phases };\n' +
        'export default function workflow({ phase }) { phase("a"); return {}; }\n'
    );
    try {
      await startWorkflowRun(context, {
        workspaceId: "workspace-1",
        scriptPath: "./workflows/dynamic-meta.js",
        args: {},
      });
      expect.unreachable("non-static meta must fail run creation, not run undeclared");
    } catch (error) {
      expect(error).toBeInstanceOf(WorkflowDeclaredPhasesValidationError);
      expect(String(error)).toContain("static object literal");
    }
    const runs = await listWorkflowRuns(context, "workspace-1");
    expect(runs.some((run) => run.workflow.name === "dynamic-meta")).toBe(false);
  });

  test("interrupt responses carry the hydrated phase manifest like read paths", async () => {
    const runStore = new WorkflowRunStore({
      sessionDir: path.join(config.sessionsDir, "workspace-1"),
    });
    await runStore.createRun({
      id: "wfr_interrupt_hydrate",
      workspaceId: "workspace-1",
      workflow: { name: "demo", description: "Demo", scope: "project" as const, executable: true },
      args: {},
      now: "2026-05-29T00:00:00.000Z",
      source:
        'export const meta = { phases: [{ name: "a" }, { name: "b" }] };\n' +
        'export default function workflow({ phase }) { phase("a"); return {}; }\n',
    });

    const { context } = createContext();
    const interrupted = await interruptWorkflowRun(context, {
      workspaceId: "workspace-1",
      runId: "wfr_interrupt_hydrate",
    });
    expect(interrupted.status).toBe("interrupted");
    // The tool card installs this response as a snapshot that ties with the hydrated
    // subscription update; an unhydrated record here would drop the rail.
    expect(interrupted.workflow.phaseManifest).toEqual({
      provenance: "declared",
      phases: [{ name: "a" }, { name: "b" }],
    });
    const rawRunFile = fs.readFileSync(
      path.join(
        config.sessionsDir,
        "workspace-1",
        "workflows",
        "wfr_interrupt_hydrate",
        "run.json"
      ),
      "utf-8"
    );
    expect(rawRunFile).not.toContain("phaseManifest");
  });

  test("discovery surfaces phase previews and never fails on invalid declarations", async () => {
    const writeSkillWorkflow = (skillName: string, workflowSource: string) => {
      const skillDir = path.join(projectPath, ".mux", "skills", skillName);
      fs.mkdirSync(skillDir, { recursive: true });
      fs.writeFileSync(
        path.join(skillDir, "SKILL.md"),
        `---\nname: ${skillName}\ndescription: ${skillName} workflow\n---\nRun it.\n`
      );
      fs.writeFileSync(path.join(skillDir, "workflow.js"), workflowSource);
    };
    writeSkillWorkflow(
      "declared-flow",
      'export const meta = { description: "Declared", phases: [{ name: "scope", parallel: true }] };\n' +
        "export default function workflow() { return {}; }\n"
    );
    writeSkillWorkflow(
      "broken-flow",
      'export const meta = { description: "Broken", phases: [{ name: "" }] };\n' +
        "export default function workflow() { return {}; }\n"
    );
    const { context } = createContext();

    const scripts = await listWorkflowScripts(context, "workspace-1");
    const declared = scripts.find((s) => s.scriptPath === "skill://declared-flow/workflow.js");
    expect(declared?.descriptor.phaseManifest).toEqual({
      provenance: "declared",
      phases: [{ name: "scope", parallel: true }],
    });
    expect(declared?.phaseManifestWarning).toBeUndefined();

    // Invalid declaration: script stays listed with a warning and no preview.
    const broken = scripts.find((s) => s.scriptPath === "skill://broken-flow/workflow.js");
    expect(broken).toBeDefined();
    expect(broken?.descriptor.phaseManifest).toBeUndefined();
    expect(broken?.phaseManifestWarning).toContain("meta.phases[0].name");
  }, 60_000);

  test("crash-resumed background runs note terminal attention on settle", async () => {
    const runStore = new WorkflowRunStore({
      sessionDir: path.join(config.sessionsDir, "workspace-1"),
    });
    await runStore.createRun({
      id: "wfr_crash_wake",
      workspaceId: "workspace-1",
      workflow: { name: "demo", description: "Demo", scope: "built-in", executable: true },
      source: "export default function workflow() { return { reportMarkdown: 'done' }; }\n",
      args: {},
      attentionPolicy: "notify_on_terminal",
      now: "2026-05-29T00:00:00.000Z",
    });
    // Orphaned by a crash: durable status says running, but no live runner.
    await runStore.appendStatus("wfr_crash_wake", "running", "2026-05-29T00:00:01.000Z");

    const noteWorkflowRunTerminalAttention = mock(() => undefined);
    const { context } = createContext();
    (context as unknown as Record<string, unknown>).taskService = {
      noteWorkflowRunTerminalAttention,
    };

    // A read path triggers crash recovery; the resumed run's settle must poke the drain
    // instead of waiting for the next sweep.
    await listWorkflowRuns(context, "workspace-1");
    const deadline = Date.now() + 5_000;
    while (noteWorkflowRunTerminalAttention.mock.calls.length === 0 && Date.now() < deadline) {
      await new Promise((resolve) => setTimeout(resolve, 25));
    }
    expect(noteWorkflowRunTerminalAttention).toHaveBeenCalledWith({
      ownerWorkspaceId: "workspace-1",
      runId: "wfr_crash_wake",
      status: "completed",
    });
  });

  test("resuming a run clears the stale downgrade settlement marker", async () => {
    const runStore = new WorkflowRunStore({
      sessionDir: path.join(config.sessionsDir, "workspace-1"),
    });
    await runStore.createRun({
      id: "wfr_resume_compat",
      workspaceId: "workspace-1",
      workflow: { name: "demo", description: "Demo", scope: "built-in", executable: true },
      source: "export default function workflow() { return { reportMarkdown: 'done' }; }\n",
      args: {},
      attentionPolicy: "notify_on_terminal",
      now: "2026-05-29T00:00:00.000Z",
    });
    await runStore.appendStatus("wfr_resume_compat", "running", "2026-05-29T00:00:01.000Z");
    await runStore.appendStatus("wfr_resume_compat", "interrupted", "2026-05-29T00:00:02.000Z");

    const clearWorkflowRunDowngradeSettlement = mock(async () => undefined);
    const { context } = createContext();
    (context as unknown as Record<string, unknown>).taskService = {
      noteWorkflowRunTerminalAttention: mock(() => undefined),
      clearWorkflowRunDowngradeSettlement,
    };

    // Leaving terminal state invalidates the stable downgrade marker written at settlement;
    // without the clear, a downgraded build would refuse to enqueue the resumed result.
    await resumeWorkflowRun(context, { workspaceId: "workspace-1", runId: "wfr_resume_compat" });
    const deadline = Date.now() + 5_000;
    while (clearWorkflowRunDowngradeSettlement.mock.calls.length === 0 && Date.now() < deadline) {
      await new Promise((resolve) => setTimeout(resolve, 25));
    }
    expect(clearWorkflowRunDowngradeSettlement).toHaveBeenCalledWith({
      ownerWorkspaceId: "workspace-1",
      runId: "wfr_resume_compat",
    });
  });

  test("rejects disabled dynamic workflows before workspace initialization", async () => {
    const { context, waitForInit } = createContext({ enabled: false });
    try {
      await startWorkflowRun(context, { workspaceId: "workspace-1", scriptPath: "demo" });
      expect.unreachable("disabled workflows must fail");
    } catch (error) {
      expect(error).toHaveProperty("message", "Dynamic workflows are disabled");
    }
    expect(waitForInit).not.toHaveBeenCalled();
  });
});

async function waitFor(predicate: () => boolean): Promise<void> {
  const deadline = Date.now() + 1_000;
  while (!predicate()) {
    if (Date.now() >= deadline) throw new Error("Timed out waiting for condition");
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
}

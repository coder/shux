/* eslint-disable @typescript-eslint/await-thenable, @typescript-eslint/no-unsafe-argument, @typescript-eslint/require-await */
import * as fs from "node:fs/promises";
import * as path from "node:path";
import { describe, expect, mock, test } from "bun:test";
import { QuickJSRuntimeFactory } from "@/node/services/ptc/quickjsRuntime";
import { ForegroundWaitBackgroundedError } from "@/node/services/taskService";
import { DisposableTempDir } from "@/node/services/tempDir";
import { WorkflowRunStore } from "./WorkflowRunStore";
import {
  WorkflowRunBackgroundedError,
  WorkflowRunner,
  type WorkflowAgentSpec,
  type WorkflowTaskAdapter,
} from "./WorkflowRunner";
import { hashWorkflowStepInput } from "./workflowReplayKey";

const WORKFLOW_RUNNER_TEST_STALE_LEASE_MS = 100;

const definition = {
  name: "deep-research",
  description: "Research a topic",
  scope: "built-in" as const,
  executable: true,
};

const source = `export default function workflow({ args, phase, log, agent }) {
  phase("scope", { topic: args.topic });
  log("delegating", { topic: args.topic });
  const summary = agent("Summarize " + args.topic, { id: "summarize-topic" });
  return { reportMarkdown: "Final: " + summary };
}
`;

async function createRunStore(sessionDir: string) {
  const store = new WorkflowRunStore({
    sessionDir,
    staleLeaseMs: WORKFLOW_RUNNER_TEST_STALE_LEASE_MS,
  });
  await store.createRun({
    id: "wfr_123",
    workspaceId: "workspace-1",
    workflow: definition,
    source: source,
    args: { topic: "durable workflows" },
    now: "2026-05-29T00:00:00.000Z",
  });
  return store;
}

function createRunner(store: WorkflowRunStore, taskAdapter: WorkflowTaskAdapter) {
  return new WorkflowRunner({
    runStore: store,
    runtimeFactory: new QuickJSRuntimeFactory(),
    taskAdapter,
    runnerId: "runner-a",
    clock: {
      nowIso: () => "2026-05-29T00:00:01.000Z",
      nowMs: () => 1_000,
    },
  });
}

function createDeferred() {
  let resolve!: () => void;
  let reject!: (error: unknown) => void;
  const promise = new Promise<void>((promiseResolve, promiseReject) => {
    resolve = promiseResolve;
    reject = promiseReject;
  });
  return { promise, resolve, reject };
}

describe("WorkflowRunner", () => {
  test("runs onRunEnded after a successful workflow", async () => {
    using tmp = new DisposableTempDir("workflow-runner");
    const store = await createRunStore(tmp.path);
    const lifecycle: string[] = [];
    const runner = createRunner(store, {
      async runAgent() {
        lifecycle.push("agent");
        return { taskId: "task_1", reportMarkdown: "summary", structuredOutput: {} };
      },
      onRunEnded() {
        lifecycle.push("ended");
      },
    });

    await runner.run("wfr_123");

    expect(lifecycle).toEqual(["agent", "ended"]);
  });

  test("rejects schema on built-in plan agent steps", async () => {
    using tmp = new DisposableTempDir("workflow-runner-plan-schema");
    const store = new WorkflowRunStore({
      sessionDir: tmp.path,
      staleLeaseMs: WORKFLOW_RUNNER_TEST_STALE_LEASE_MS,
    });
    await store.createRun({
      id: "wfr_plan_schema",
      workspaceId: "workspace-1",
      workflow: definition,
      source: `export default function workflow({ agent }) {
  return agent("Plan", {
    id: "plan",
    agentId: "plan",
    schema: { type: "object", properties: { plan: { type: "string" } }, required: ["plan"] },
  });
}
`,
      args: {},
      now: "2026-05-29T00:00:00.000Z",
    });
    const runner = createRunner(store, {
      async runAgent() {
        throw new Error("plan schema should fail before spawning");
      },
    });

    await expect(runner.run("wfr_plan_schema")).rejects.toThrow(
      "Workflow plan agents return { reportMarkdown, planFilePath }"
    );
  });

  test("plan agent returns report markdown and plan file path object", async () => {
    using tmp = new DisposableTempDir("workflow-runner-plan-result");
    const store = new WorkflowRunStore({
      sessionDir: tmp.path,
      staleLeaseMs: WORKFLOW_RUNNER_TEST_STALE_LEASE_MS,
    });
    await store.createRun({
      id: "wfr_plan_result",
      workspaceId: "workspace-1",
      workflow: definition,
      source: `export default function workflow({ agent }) {
  const result = agent("Plan the change", { id: "plan", agentId: "plan" });
  return { reportMarkdown: result.reportMarkdown + "\\n" + result.planFilePath };
}
`,
      args: {},
      now: "2026-05-29T00:00:00.000Z",
    });
    const runner = createRunner(store, {
      async runAgent() {
        return {
          taskId: "task_plan",
          reportMarkdown: "Plan contents",
          planFilePath: "/tmp/mux/plans/example.md",
          structuredOutput: {},
        };
      },
    });

    await expect(runner.run("wfr_plan_result")).resolves.toEqual({
      reportMarkdown: "Plan contents\n/tmp/mux/plans/example.md",
      structuredOutput: undefined,
    });
  });

  test("parallel plan agents return report objects in input order", async () => {
    using tmp = new DisposableTempDir("workflow-runner-parallel-plan-result");
    const store = new WorkflowRunStore({
      sessionDir: tmp.path,
      staleLeaseMs: WORKFLOW_RUNNER_TEST_STALE_LEASE_MS,
    });
    await store.createRun({
      id: "wfr_parallel_plan_result",
      workspaceId: "workspace-1",
      workflow: definition,
      source: `export default function workflow({ agent, parallel }) {
  const results = parallel([
    () => agent("Plan A", { id: "plan-a", agentId: "plan" }),
    () => agent("Plan B", { id: "plan-b", agentId: "plan" }),
  ]);
  return { reportMarkdown: results.map((result) => result.reportMarkdown + "@" + result.planFilePath).join("|") };
}
`,
      args: {},
      now: "2026-05-29T00:00:00.000Z",
    });
    const runner = createRunner(store, {
      async runAgent() {
        throw new Error("parallel should create captured agent specs");
      },
      async createAgentTasks(specs, lifecycle) {
        for (const [index, spec] of specs.entries()) {
          await lifecycle?.onTaskCreated?.(index, `task_${spec.id}`);
        }
        return specs.map((spec) => ({ taskId: `task_${spec.id}`, status: "starting" as const }));
      },
      async waitForAgentTask(taskId) {
        const id = taskId.replace("task_", "");
        return {
          taskId,
          reportMarkdown: `Plan ${id}`,
          planFilePath: `/tmp/mux/plans/${id}.md`,
          structuredOutput: {},
        };
      },
    });

    await expect(runner.run("wfr_parallel_plan_result")).resolves.toEqual({
      reportMarkdown: "Plan plan-a@/tmp/mux/plans/plan-a.md|Plan plan-b@/tmp/mux/plans/plan-b.md",
    });
  });

  test("pipeline plan agents pass report objects to the next stage", async () => {
    using tmp = new DisposableTempDir("workflow-runner-pipeline-plan-result");
    const store = new WorkflowRunStore({
      sessionDir: tmp.path,
      staleLeaseMs: WORKFLOW_RUNNER_TEST_STALE_LEASE_MS,
    });
    await store.createRun({
      id: "wfr_pipeline_plan_result",
      workspaceId: "workspace-1",
      workflow: definition,
      source: `export default function workflow({ agent, pipeline }) {
  const results = pipeline(
    ["a", "b"],
    (item) => agent("Plan " + item, { id: "plan-" + item, agentId: "plan" }),
    (plan) => plan.reportMarkdown + "@" + plan.planFilePath
  );
  return { reportMarkdown: results.join("|") };
}
`,
      args: {},
      now: "2026-05-29T00:00:00.000Z",
    });
    const runner = createRunner(store, {
      async runAgent() {
        throw new Error("pipeline should start captured agent specs");
      },
      async createAgentTasks(specs, lifecycle) {
        for (const [index, spec] of specs.entries()) {
          await lifecycle?.onTaskCreated?.(index, `task_${spec.id}`);
        }
        return specs.map((spec) => ({ taskId: `task_${spec.id}`, status: "starting" as const }));
      },
      async waitForAgentTask(taskId) {
        const id = taskId.replace("task_", "");
        return {
          taskId,
          reportMarkdown: `Plan ${id}`,
          planFilePath: `/tmp/mux/plans/${id}.md`,
          structuredOutput: {},
        };
      },
    });

    await expect(runner.run("wfr_pipeline_plan_result")).resolves.toEqual({
      reportMarkdown: "Plan plan-a@/tmp/mux/plans/plan-a.md|Plan plan-b@/tmp/mux/plans/plan-b.md",
    });
  });

  test("plan agent fails fast when task output is missing plan file path", async () => {
    using tmp = new DisposableTempDir("workflow-runner-plan-missing-path");
    const store = new WorkflowRunStore({
      sessionDir: tmp.path,
      staleLeaseMs: WORKFLOW_RUNNER_TEST_STALE_LEASE_MS,
    });
    await store.createRun({
      id: "wfr_plan_missing_path",
      workspaceId: "workspace-1",
      workflow: definition,
      source: `export default function workflow({ agent }) {
  const result = agent("Plan the change", { id: "plan", agentId: "plan" });
  return { reportMarkdown: result.reportMarkdown };
}
`,
      args: {},
      now: "2026-05-29T00:00:00.000Z",
    });
    const runner = createRunner(store, {
      async runAgent() {
        return { taskId: "task_plan", reportMarkdown: "Plan contents", structuredOutput: {} };
      },
    });

    await expect(runner.run("wfr_plan_missing_path")).rejects.toThrow(
      "Workflow plan agent result is missing planFilePath"
    );
  });

  test("new agent API returns structured output for schema-backed steps and markdown otherwise", async () => {
    using tmp = new DisposableTempDir("workflow-runner-agent-api");
    const store = new WorkflowRunStore({
      sessionDir: tmp.path,
      staleLeaseMs: WORKFLOW_RUNNER_TEST_STALE_LEASE_MS,
    });
    await store.createRun({
      id: "wfr_agent_api",
      workspaceId: "workspace-1",
      workflow: definition,
      source: `export default function workflow({ agent }) {
  const structured = agent("Return structured output", {
    id: "structured",
    schema: { type: "object", properties: { answer: { type: "string" } }, required: ["answer"] },
  });
  const markdown = agent("Return markdown output", { id: "markdown" });
  return { reportMarkdown: structured.answer + " / " + markdown };
}
`,
      args: {},
      now: "2026-05-29T00:00:00.000Z",
    });
    const seenSpecs: WorkflowAgentSpec[] = [];
    const runner = createRunner(store, {
      async runAgent(spec) {
        seenSpecs.push(spec);
        if (spec.id === "structured") {
          return {
            taskId: "task_structured",
            reportMarkdown: "unused markdown",
            structuredOutput: { answer: "structured answer" },
          };
        }
        return { taskId: "task_markdown", reportMarkdown: "markdown answer", structuredOutput: {} };
      },
    });

    const result = await runner.run("wfr_agent_api");

    expect(result).toEqual({ reportMarkdown: "structured answer / markdown answer" });
    expect(seenSpecs).toHaveLength(2);
    expect(seenSpecs[0]).toMatchObject({ id: "structured" });
    expect(seenSpecs[0]?.outputSchema).toEqual({
      type: "object",
      properties: { answer: { type: "string" } },
      required: ["answer"],
    });
    expect(seenSpecs[1]).toMatchObject({ id: "markdown" });
  });

  test("new agent API maps agentId, model, and thinking options", async () => {
    using tmp = new DisposableTempDir("workflow-runner-agent-options");
    const store = new WorkflowRunStore({
      sessionDir: tmp.path,
      staleLeaseMs: WORKFLOW_RUNNER_TEST_STALE_LEASE_MS,
    });
    await store.createRun({
      id: "wfr_agent_options",
      workspaceId: "workspace-1",
      workflow: definition,
      source: `export default function workflow({ agent }) {
  const result = agent("Verify claim", {
    id: "verify",
    agentId: "exec",
    model: "fable",
    thinking: "high",
  });
  return { reportMarkdown: result };
}
`,
      args: {},
      now: "2026-05-29T00:00:00.000Z",
    });
    const seenSpecs: WorkflowAgentSpec[] = [];
    const runner = createRunner(store, {
      async runAgent(spec) {
        seenSpecs.push(spec);
        return { taskId: "task_verify", reportMarkdown: "verified", structuredOutput: {} };
      },
    });

    await expect(runner.run("wfr_agent_options")).resolves.toEqual({
      reportMarkdown: "verified",
    });
    expect(seenSpecs).toEqual([
      expect.objectContaining({
        id: "verify",
        agentId: "exec",
        modelString: "anthropic:claude-fable-5-1",
        thinkingLevel: "high",
      }),
    ]);
  });

  test("new agent API rejects legacy agentType option", async () => {
    using tmp = new DisposableTempDir("workflow-runner-agent-type-rejected");
    const store = new WorkflowRunStore({
      sessionDir: tmp.path,
      staleLeaseMs: WORKFLOW_RUNNER_TEST_STALE_LEASE_MS,
    });
    await store.createRun({
      id: "wfr_agent_type_rejected",
      workspaceId: "workspace-1",
      workflow: definition,
      source: `export default function workflow({ agent }) {
  agent("Verify claim", { id: "verify", agentType: "explore" });
  return { reportMarkdown: "unreachable" };
}
`,
      args: {},
      now: "2026-05-29T00:00:00.000Z",
    });
    const runAgent = mock(async () => ({
      taskId: "task_verify",
      reportMarkdown: "verified",
      structuredOutput: {},
    }));
    const runner = createRunner(store, { runAgent });

    await expect(runner.run("wfr_agent_type_rejected")).rejects.toThrow(
      "agent options.agentType is not supported; use options.agentId"
    );
    expect(runAgent).not.toHaveBeenCalled();
  });

  test("legacy runs still replay agentType source snapshots", async () => {
    using tmp = new DisposableTempDir("workflow-runner-legacy-agent-type-replay");
    const store = new WorkflowRunStore({
      sessionDir: tmp.path,
      staleLeaseMs: WORKFLOW_RUNNER_TEST_STALE_LEASE_MS,
    });
    await store.createRun({
      id: "wfr_legacy_agent_type_replay",
      workspaceId: "workspace-1",
      workflow: definition,
      source: `export default function workflow({ agent }) {
  const result = agent("Verify claim", { id: "verify", agentType: "explore" });
  return { reportMarkdown: result };
}
`,
      args: {},
      now: "2026-05-29T00:00:00.000Z",
    });
    const runFile = path.join(tmp.path, "workflows", "wfr_legacy_agent_type_replay", "run.json");
    const persistedRun = JSON.parse(await fs.readFile(runFile, "utf-8")) as Record<string, unknown>;
    delete persistedRun.agentTypeAliasAllowed;
    await fs.writeFile(runFile, `${JSON.stringify(persistedRun, null, 2)}\n`, "utf-8");
    const legacySpec = {
      id: "verify",
      prompt: "Verify claim",
      agentId: "explore",
      markdownOnly: true,
    };
    await store.recordStepCompleted("wfr_legacy_agent_type_replay", {
      stepId: legacySpec.id,
      inputHash: hashWorkflowStepInput(legacySpec.id, legacySpec),
      taskId: "task_legacy_verify",
      result: { taskId: "task_legacy_verify", reportMarkdown: "verified", structuredOutput: {} },
      startedAt: "2026-05-29T00:00:00.500Z",
      completedAt: "2026-05-29T00:00:00.750Z",
    });
    const runAgent = mock(async () => {
      throw new Error("agent should replay");
    });
    const runner = createRunner(store, { runAgent });

    await expect(runner.run("wfr_legacy_agent_type_replay")).resolves.toEqual({
      reportMarkdown: "verified",
    });
    expect(runAgent).not.toHaveBeenCalled();
  });

  test("parallel runs agent thunks concurrently and returns ordered schema outputs", async () => {
    using tmp = new DisposableTempDir("workflow-runner-parallel-api");
    const store = new WorkflowRunStore({
      sessionDir: tmp.path,
      staleLeaseMs: WORKFLOW_RUNNER_TEST_STALE_LEASE_MS,
    });
    await store.createRun({
      id: "wfr_parallel_api",
      workspaceId: "workspace-1",
      workflow: definition,
      source: `export default function workflow({ parallel, agent }) {
  const results = parallel([
    () => agent("First", { id: "first", schema: { type: "object", properties: { value: { type: "string" } }, required: ["value"] } }),
    () => agent("Second", { id: "second", schema: { type: "object", properties: { value: { type: "string" } }, required: ["value"] } }),
  ]);
  return { reportMarkdown: results.map((result) => result.value).join(",") };
}
`,
      args: {},
      now: "2026-05-29T00:00:00.000Z",
    });
    const firstTaskCreated = createDeferred();
    const secondTaskCreated = createDeferred();
    const releaseReports = createDeferred();
    const starts: string[] = [];
    const runner = createRunner(store, {
      async runAgent(spec, lifecycle) {
        starts.push(spec.id);
        await lifecycle?.onTaskCreated?.(`task_${spec.id}`);
        if (spec.id === "first") firstTaskCreated.resolve();
        if (spec.id === "second") secondTaskCreated.resolve();
        await releaseReports.promise;
        return {
          taskId: `task_${spec.id}`,
          reportMarkdown: spec.id,
          structuredOutput: { value: spec.id },
        };
      },
    });

    const runPromise = runner.run("wfr_parallel_api");
    await Promise.all([firstTaskCreated.promise, secondTaskCreated.promise]);
    expect(starts).toEqual(["first", "second"]);
    releaseReports.resolve();

    await expect(runPromise).resolves.toEqual({ reportMarkdown: "first,second" });
  });

  test("parallel thunks start agent tasks before waiting and preserve input order", async () => {
    using tmp = new DisposableTempDir("workflow-runner-parallel-thunks");
    const store = new WorkflowRunStore({
      sessionDir: tmp.path,
      staleLeaseMs: WORKFLOW_RUNNER_TEST_STALE_LEASE_MS,
    });
    await store.createRun({
      id: "wfr_parallel_thunks",
      workspaceId: "workspace-1",
      workflow: definition,
      source: `export default function workflow({ agent, parallel }) {
  const schema = { type: "object", properties: { label: { type: "string" } }, required: ["label"] };
  const results = parallel([
    () => agent("Read source A", { id: "source-a", schema }),
    () => agent("Read source B", { id: "source-b", schema }),
  ]);
  return { reportMarkdown: results.map((result) => result.label).join(" + ") };
}
`,
      args: {},
      now: "2026-05-29T00:00:00.000Z",
    });
    const trace: string[] = [];
    const createAgentTasks = mock(
      async (
        specs: WorkflowAgentSpec[],
        lifecycle?: { onTaskCreated?: (index: number, taskId: string) => Promise<void> | void }
      ) => {
        for (const [index, spec] of specs.entries()) {
          trace.push(`create:${spec.id}`);
          await lifecycle?.onTaskCreated?.(index, `task_${spec.id}`);
        }
        return specs.map((spec) => ({ taskId: `task_${spec.id}`, status: "starting" as const }));
      }
    );
    const waitForAgentTask = mock(async (taskId: string) => {
      trace.push(`wait:${taskId}`);
      if (taskId === "task_source-a") {
        await new Promise((resolve) => setTimeout(resolve, 10));
      }
      const label = taskId.replace("task_", "");
      return { taskId, reportMarkdown: label, structuredOutput: { label } };
    });
    const runAgent = mock(async () => {
      throw new Error("parallel should use captured specs instead of running thunks serially");
    });
    const runner = createRunner(store, { runAgent, createAgentTasks, waitForAgentTask });

    await expect(runner.run("wfr_parallel_thunks")).resolves.toEqual({
      reportMarkdown: "source-a + source-b",
    });

    expect(createAgentTasks).toHaveBeenCalledTimes(1);
    expect(runAgent).not.toHaveBeenCalled();
    expect(waitForAgentTask).toHaveBeenCalledTimes(2);
    expect(trace.slice(0, 2)).toEqual(["create:source-a", "create:source-b"]);
    expect(trace).toEqual(expect.arrayContaining(["wait:task_source-a", "wait:task_source-b"]));
  });

  test("pipeline advances items to later stages without waiting for a full-stage barrier", async () => {
    using tmp = new DisposableTempDir("workflow-runner-pipeline-nonbarrier");
    const store = new WorkflowRunStore({
      sessionDir: tmp.path,
      staleLeaseMs: WORKFLOW_RUNNER_TEST_STALE_LEASE_MS,
    });
    await store.createRun({
      id: "wfr_pipeline_nonbarrier",
      workspaceId: "workspace-1",
      workflow: definition,
      source: `export default function workflow({ agent, pipeline }) {
  const schema = { type: "object", properties: { label: { type: "string" } }, required: ["label"] };
  const results = pipeline(
    ["a", "b"],
    (item) => agent("Stage 1 " + item, { id: "stage1-" + item, schema }),
    (stage1) => agent("Stage 2 " + stage1.label, { id: "stage2-" + stage1.label, schema })
  );
  return { reportMarkdown: results.map((result) => result.label).join(",") };
}
`,
      args: {},
      now: "2026-05-29T00:00:00.000Z",
    });
    const releaseStage1B = createDeferred();
    const trace: string[] = [];
    const createAgentTasks = mock(
      async (
        specs: WorkflowAgentSpec[],
        lifecycle?: { onTaskCreated?: (index: number, taskId: string) => Promise<void> | void }
      ) => {
        for (const [index, spec] of specs.entries()) {
          trace.push(`create:${spec.id}`);
          await lifecycle?.onTaskCreated?.(index, `task_${spec.id}`);
          if (spec.id === "stage2-a") {
            releaseStage1B.resolve();
          }
        }
        return specs.map((spec) => ({ taskId: `task_${spec.id}`, status: "starting" as const }));
      }
    );
    const waitForAgentTask = mock(async (taskId: string) => {
      trace.push(`wait-start:${taskId}`);
      if (taskId === "task_stage1-b") {
        await releaseStage1B.promise;
      }
      trace.push(`wait-done:${taskId}`);
      const label = taskId.startsWith("task_stage1-")
        ? taskId.replace("task_stage1-", "")
        : `done-${taskId.replace("task_stage2-", "")}`;
      return { taskId, reportMarkdown: label, structuredOutput: { label } };
    });
    const runner = createRunner(store, {
      async runAgent() {
        throw new Error("pipeline should start agent tasks without using runAgent");
      },
      createAgentTasks,
      waitForAgentTask,
    });

    await expect(runner.run("wfr_pipeline_nonbarrier")).resolves.toEqual({
      reportMarkdown: "done-a,done-b",
    });
    expect(trace.indexOf("create:stage2-a")).toBeGreaterThan(-1);
    expect(trace.indexOf("wait-done:task_stage1-b")).toBeGreaterThan(-1);
    expect(trace.indexOf("create:stage2-a")).toBeLessThan(trace.indexOf("wait-done:task_stage1-b"));
  });

  test("pipeline interrupts sibling agents when one wait fails", async () => {
    using tmp = new DisposableTempDir("workflow-runner-pipeline-failure-interrupt");
    const store = new WorkflowRunStore({
      sessionDir: tmp.path,
      staleLeaseMs: WORKFLOW_RUNNER_TEST_STALE_LEASE_MS,
    });
    await store.createRun({
      id: "wfr_pipeline_failure_interrupt",
      workspaceId: "workspace-1",
      workflow: definition,
      source: `export default function workflow({ agent, pipeline }) {
  const schema = { type: "object", properties: { label: { type: "string" } }, required: ["label"] };
  return pipeline(["slow", "fail"], (item) => agent("Stage " + item, { id: item, schema }));
}
`,
      args: {},
      now: "2026-05-29T00:00:00.000Z",
    });
    const releaseSlowTask = createDeferred();
    const createAgentTasks = mock(
      async (
        specs: WorkflowAgentSpec[],
        lifecycle?: { onTaskCreated?: (index: number, taskId: string) => Promise<void> | void }
      ) => {
        for (const [index, spec] of specs.entries()) {
          await lifecycle?.onTaskCreated?.(index, `task_${spec.id}`);
        }
        return specs.map((spec) => ({ taskId: `task_${spec.id}`, status: "starting" as const }));
      }
    );
    const waitForAgentTask = mock(async (taskId: string) => {
      if (taskId === "task_fail") {
        throw new Error("pipeline child failed");
      }
      await releaseSlowTask.promise;
      return { taskId, reportMarkdown: "slow", structuredOutput: { label: "slow" } };
    });
    const interruptRun = mock(async () => {
      releaseSlowTask.resolve();
    });
    const runner = createRunner(store, {
      async runAgent() {
        throw new Error("pipeline should start agent tasks without using runAgent");
      },
      createAgentTasks,
      waitForAgentTask,
      interruptRun,
    });

    await expect(runner.run("wfr_pipeline_failure_interrupt")).rejects.toThrow(
      "pipeline child failed"
    );
    expect(interruptRun).toHaveBeenCalledTimes(1);
  });

  test("pipeline interrupts sibling agents when result validation fails", async () => {
    using tmp = new DisposableTempDir("workflow-runner-pipeline-validation-interrupt");
    const store = new WorkflowRunStore({
      sessionDir: tmp.path,
      staleLeaseMs: WORKFLOW_RUNNER_TEST_STALE_LEASE_MS,
    });
    await store.createRun({
      id: "wfr_pipeline_validation_interrupt",
      workspaceId: "workspace-1",
      workflow: definition,
      source: `export default function workflow({ agent, pipeline }) {
  const schema = { type: "object", properties: { label: { type: "string" } }, required: ["label"] };
  return pipeline(["slow", "invalid"], (item) => agent("Stage " + item, { id: item, schema }));
}
`,
      args: {},
      now: "2026-05-29T00:00:00.000Z",
    });
    const releaseSlowTask = createDeferred();
    const createAgentTasks = mock(
      async (
        specs: WorkflowAgentSpec[],
        lifecycle?: { onTaskCreated?: (index: number, taskId: string) => Promise<void> | void }
      ) => {
        for (const [index, spec] of specs.entries()) {
          await lifecycle?.onTaskCreated?.(index, `task_${spec.id}`);
        }
        return specs.map((spec) => ({ taskId: `task_${spec.id}`, status: "starting" as const }));
      }
    );
    const waitForAgentTask = mock(async (taskId: string) => {
      if (taskId === "task_invalid") {
        return { taskId, reportMarkdown: "invalid", structuredOutput: {} };
      }
      await releaseSlowTask.promise;
      return { taskId, reportMarkdown: "slow", structuredOutput: { label: "slow" } };
    });
    const interruptRun = mock(async () => {
      releaseSlowTask.resolve();
    });
    const runner = createRunner(store, {
      async runAgent() {
        throw new Error("pipeline should start agent tasks without using runAgent");
      },
      createAgentTasks,
      waitForAgentTask,
      interruptRun,
    });

    await expect(runner.run("wfr_pipeline_validation_interrupt")).rejects.toThrow(
      "structured output failed schema validation"
    );
    expect(interruptRun).toHaveBeenCalledTimes(1);
  });

  test("pipeline hard timeouts keep the timed_out task event without adding a failed task event", async () => {
    using tmp = new DisposableTempDir("workflow-runner-pipeline-timeout-terminal-event");
    const store = new WorkflowRunStore({
      sessionDir: tmp.path,
      staleLeaseMs: WORKFLOW_RUNNER_TEST_STALE_LEASE_MS,
    });
    const runId = "wfr_pipeline_timeout_terminal_event";
    await store.createRun({
      id: runId,
      workspaceId: "workspace-1",
      workflow: definition,
      source: `export default function workflow({ agent, pipeline }) {
  return pipeline(["slow", "sibling"], (item) => agent("Stage " + item, { id: item, timeout: { softMs: 1000, graceMs: 2000 } }));
}
`,
      args: {},
      now: "2026-05-29T00:00:00.000Z",
    });
    const timeoutError = new Error("wait expired");
    timeoutError.name = "AgentReportWaitTimeoutError";
    const releaseSibling = createDeferred();
    const interruptRun = mock(async () => {
      releaseSibling.resolve();
    });
    const runner = createRunner(store, {
      async runAgent() {
        throw new Error("pipeline should start agent tasks without using runAgent");
      },
      async createAgentTasks(specs, lifecycle) {
        for (const [index, spec] of specs.entries()) {
          await lifecycle?.onTaskCreated?.(index, `task_${spec.id}`);
        }
        return specs.map((spec) => ({ taskId: `task_${spec.id}`, status: "running" as const }));
      },
      async waitForAgentTask(taskId, _spec, waitOptions) {
        await waitOptions?.onExecutionStarted?.();
        if (taskId === "task_slow") {
          throw timeoutError;
        }
        await releaseSibling.promise;
        return { taskId, reportMarkdown: "sibling", structuredOutput: { label: "sibling" } };
      },
      async requestAgentFinalReportForTimeout() {
        return "prompted";
      },
      async failAgentTaskForHardTimeout() {
        // The workflow timeout path records the timed_out event before surfacing the failure.
      },
      interruptRun,
    });

    await expect(runner.run(runId)).rejects.toThrow("exceeded its soft timeout");
    expect(interruptRun).toHaveBeenCalledTimes(1);
    const run = await store.getRun(runId);
    expect(
      run.events.some(
        (event) =>
          event.type === "task" && event.taskId === "task_slow" && event.status === "timed_out"
      )
    ).toBe(true);
    expect(
      run.events.some(
        (event) =>
          event.type === "task" && event.taskId === "task_slow" && event.status === "failed"
      )
    ).toBe(false);
  });

  test("workflow primitive requires a stable id before creating child runs", async () => {
    using tmp = new DisposableTempDir("workflow-runner-nested-workflow-missing-id");
    const store = new WorkflowRunStore({
      sessionDir: tmp.path,
      staleLeaseMs: WORKFLOW_RUNNER_TEST_STALE_LEASE_MS,
    });
    await store.createRun({
      id: "wfr_nested_missing_id",
      workspaceId: "workspace-1",
      workflow: definition,
      source: `export default function workflow({ workflow }) {
  return workflow({ script_path: "./child.js", args: {} });
}
`,
      args: {},
      now: "2026-05-29T00:00:00.000Z",
    });
    const runner = createRunner(store, {
      async runAgent() {
        throw new Error("workflow primitive should not spawn agent tasks");
      },
    });

    await expect(runner.run("wfr_nested_missing_id")).rejects.toThrow(
      "workflow replay boundary requires a stable id"
    );
  });

  test("workflow primitive accepts script path shorthand", async () => {
    using tmp = new DisposableTempDir("workflow-runner-nested-workflow-shorthand");
    const store = new WorkflowRunStore({
      sessionDir: tmp.path,
      staleLeaseMs: WORKFLOW_RUNNER_TEST_STALE_LEASE_MS,
    });
    await store.createRun({
      id: "wfr_nested_shorthand",
      workspaceId: "workspace-1",
      workflow: definition,
      source: `export default function workflow({ workflow }) {
  const child = workflow("./child.js", { id: "child", args: { topic: "shorthand" } });
  return { reportMarkdown: child.reportMarkdown };
}
`,
      args: {},
      now: "2026-05-29T00:00:00.000Z",
    });
    const seenSpecs: Array<{ scriptPath: string; args: unknown }> = [];
    const createRun = mock(async (input: { spec: { scriptPath: string; args: unknown } }) => {
      seenSpecs.push({ scriptPath: input.spec.scriptPath, args: input.spec.args });
      return { runId: "wfr_child_shorthand", name: "child" };
    });
    const runChild = mock(async () => ({ reportMarkdown: "child-result" }));
    const runner = new WorkflowRunner({
      runStore: store,
      runtimeFactory: new QuickJSRuntimeFactory(),
      taskAdapter: {
        async runAgent() {
          throw new Error("workflow primitive should not spawn agent tasks");
        },
      },
      nestedWorkflowAdapter: { createRun, run: runChild },
      runnerId: "runner-a",
      clock: {
        nowIso: () => "2026-05-29T00:00:01.000Z",
        nowMs: () => 1_000,
      },
    });

    await expect(runner.run("wfr_nested_shorthand")).resolves.toEqual({
      reportMarkdown: "child-result",
    });
    expect(seenSpecs).toEqual([{ scriptPath: "./child.js", args: { topic: "shorthand" } }]);
  });

  test("workflow primitive replays a completed child step with the same script path and args", async () => {
    using tmp = new DisposableTempDir("workflow-runner-nested-workflow-replay");
    const store = new WorkflowRunStore({
      sessionDir: tmp.path,
      staleLeaseMs: WORKFLOW_RUNNER_TEST_STALE_LEASE_MS,
    });
    await store.createRun({
      id: "wfr_nested_replay",
      workspaceId: "workspace-1",
      workflow: definition,
      source: `export default function workflow({ workflow }) {
  const first = workflow({ id: "child", script_path: "./child.js", args: { topic: "same" } });
  const second = workflow({ id: "child", script_path: "./child.js", args: { topic: "same" } });
  return { reportMarkdown: first.reportMarkdown + ":" + second.reportMarkdown };
}
`,
      args: {},
      now: "2026-05-29T00:00:00.000Z",
    });
    const createRun = mock(async () => ({ runId: "wfr_child_replay", name: "child" }));
    const runChild = mock(async () => ({ reportMarkdown: "child-result" }));
    const runner = new WorkflowRunner({
      runStore: store,
      runtimeFactory: new QuickJSRuntimeFactory(),
      taskAdapter: {
        async runAgent() {
          throw new Error("workflow primitive should not spawn agent tasks");
        },
      },
      nestedWorkflowAdapter: { createRun, run: runChild },
      runnerId: "runner-a",
      clock: {
        nowIso: () => "2026-05-29T00:00:01.000Z",
        nowMs: () => 1_000,
      },
    });

    await expect(runner.run("wfr_nested_replay")).resolves.toEqual({
      reportMarkdown: "child-result:child-result",
    });
    expect(createRun).toHaveBeenCalledTimes(1);
    expect(runChild).toHaveBeenCalledTimes(1);
  });

  test("workflow primitive treats changed args as a distinct child replay identity", async () => {
    using tmp = new DisposableTempDir("workflow-runner-nested-workflow-input-hash");
    const store = new WorkflowRunStore({
      sessionDir: tmp.path,
      staleLeaseMs: WORKFLOW_RUNNER_TEST_STALE_LEASE_MS,
    });
    await store.createRun({
      id: "wfr_nested_changed_args",
      workspaceId: "workspace-1",
      workflow: definition,
      source: `export default function workflow({ workflow }) {
  const first = workflow({ id: "child", script_path: "./child.js", args: { topic: "a" } });
  const second = workflow({ id: "child", script_path: "./child.js", args: { topic: "b" } });
  return { reportMarkdown: first.reportMarkdown + ":" + second.reportMarkdown };
}
`,
      args: {},
      now: "2026-05-29T00:00:00.000Z",
    });
    const inputHashes: string[] = [];
    const createRun = mock(async (input: { inputHash: string }) => {
      inputHashes.push(input.inputHash);
      return { runId: `wfr_child_changed_args_${inputHashes.length}`, name: "child" };
    });
    const runChild = mock(async (runId: string) => ({ reportMarkdown: runId }));
    const runner = new WorkflowRunner({
      runStore: store,
      runtimeFactory: new QuickJSRuntimeFactory(),
      taskAdapter: {
        async runAgent() {
          throw new Error("workflow primitive should not spawn agent tasks");
        },
      },
      nestedWorkflowAdapter: { createRun, run: runChild },
      runnerId: "runner-a",
      clock: {
        nowIso: () => "2026-05-29T00:00:01.000Z",
        nowMs: () => 1_000,
      },
    });

    await expect(runner.run("wfr_nested_changed_args")).resolves.toEqual({
      reportMarkdown: "wfr_child_changed_args_1:wfr_child_changed_args_2",
    });
    expect(inputHashes).toHaveLength(2);
    expect(new Set(inputHashes).size).toBe(2);
    expect(runChild).toHaveBeenCalledTimes(2);
  });

  test("workflow primitive treats changed script paths as distinct child replay identities", async () => {
    using tmp = new DisposableTempDir("workflow-runner-nested-workflow-script-path-hash");
    const store = new WorkflowRunStore({
      sessionDir: tmp.path,
      staleLeaseMs: WORKFLOW_RUNNER_TEST_STALE_LEASE_MS,
    });
    await store.createRun({
      id: "wfr_nested_changed_script_path",
      workspaceId: "workspace-1",
      workflow: definition,
      source: `export default function workflow({ workflow }) {
  const first = workflow({ id: "child", script_path: "./child-a.js", args: { topic: "same" } });
  const second = workflow({ id: "child", script_path: "./child-b.js", args: { topic: "same" } });
  return { reportMarkdown: first.reportMarkdown + ":" + second.reportMarkdown };
}
`,
      args: {},
      now: "2026-05-29T00:00:00.000Z",
    });
    const inputHashes: string[] = [];
    const scriptPaths: string[] = [];
    const createRun = mock(async (input: { inputHash: string; spec: { scriptPath: string } }) => {
      inputHashes.push(input.inputHash);
      scriptPaths.push(input.spec.scriptPath);
      return { runId: `wfr_child_changed_script_${inputHashes.length}`, name: "child" };
    });
    const runChild = mock(async (runId: string) => ({ reportMarkdown: runId }));
    const runner = new WorkflowRunner({
      runStore: store,
      runtimeFactory: new QuickJSRuntimeFactory(),
      taskAdapter: {
        async runAgent() {
          throw new Error("workflow primitive should not spawn agent tasks");
        },
      },
      nestedWorkflowAdapter: { createRun, run: runChild },
      runnerId: "runner-a",
      clock: {
        nowIso: () => "2026-05-29T00:00:01.000Z",
        nowMs: () => 1_000,
      },
    });

    await expect(runner.run("wfr_nested_changed_script_path")).resolves.toEqual({
      reportMarkdown: "wfr_child_changed_script_1:wfr_child_changed_script_2",
    });
    expect(scriptPaths).toEqual(["./child-a.js", "./child-b.js"]);
    expect(inputHashes).toHaveLength(2);
    expect(new Set(inputHashes).size).toBe(2);
    expect(runChild).toHaveBeenCalledTimes(2);
  });

  test("fails before spawning when workflow code uses the removed object-form agent API", async () => {
    using tmp = new DisposableTempDir("workflow-runner-object-form-agent");
    const store = new WorkflowRunStore({
      sessionDir: tmp.path,
      staleLeaseMs: WORKFLOW_RUNNER_TEST_STALE_LEASE_MS,
    });
    await store.createRun({
      id: "wfr_object_form_agent",
      workspaceId: "workspace-1",
      workflow: definition,
      source: `export default function workflow({ agent }) {
  return agent({ id: "old-shape", prompt: "Old object shape" });
}
`,
      args: {},
      now: "2026-05-29T00:00:00.000Z",
    });
    const runAgent = mock(async () => ({
      taskId: "task_1",
      reportMarkdown: "summary",
      structuredOutput: {},
    }));
    const runner = createRunner(store, { runAgent });

    await expect(runner.run("wfr_object_form_agent")).rejects.toThrow(
      "agent requires a non-empty prompt"
    );
    expect(runAgent).not.toHaveBeenCalled();
  });

  test("normalizes explicit workflow agent timeout options before spawning", async () => {
    using tmp = new DisposableTempDir("workflow-runner-agent-timeout-options");
    const store = new WorkflowRunStore({
      sessionDir: tmp.path,
      staleLeaseMs: WORKFLOW_RUNNER_TEST_STALE_LEASE_MS,
    });
    await store.createRun({
      id: "wfr_agent_timeout_options",
      workspaceId: "workspace-1",
      workflow: definition,
      source: `export default function workflow({ agent }) {
  return agent("Return structured output", {
    id: "timeout-step",
    schema: { type: "object", properties: { ok: { type: "boolean" } }, required: ["ok"] },
    timeout: { softMs: 1000, graceMs: 2000, finalInstructions: "Summarize only completed work." },
  });
}
`,
      args: {},
      now: "2026-05-29T00:00:00.000Z",
    });
    const seenSpecs: WorkflowAgentSpec[] = [];
    const runner = createRunner(store, {
      async runAgent(spec) {
        seenSpecs.push(spec);
        return { taskId: "task_timeout", reportMarkdown: "ok", structuredOutput: { ok: true } };
      },
    });

    await expect(runner.run("wfr_agent_timeout_options")).resolves.toEqual({
      reportMarkdown: JSON.stringify({ ok: true }),
    });
    expect(seenSpecs[0]?.timeout).toEqual({
      softMs: 1000,
      graceMs: 2000,
      finalInstructions: "Summarize only completed work.",
    });
  });

  test("fails before spawning when workflow agent timeout is incomplete", async () => {
    using tmp = new DisposableTempDir("workflow-runner-agent-timeout-invalid");
    const store = new WorkflowRunStore({
      sessionDir: tmp.path,
      staleLeaseMs: WORKFLOW_RUNNER_TEST_STALE_LEASE_MS,
    });
    await store.createRun({
      id: "wfr_agent_timeout_invalid",
      workspaceId: "workspace-1",
      workflow: definition,
      source: `export default function workflow({ agent }) {
  return agent("Invalid timeout", { id: "invalid-timeout", timeout: { softMs: 1000 } });
}
`,
      args: {},
      now: "2026-05-29T00:00:00.000Z",
    });
    const runAgent = mock(async () => ({
      taskId: "task_1",
      reportMarkdown: "summary",
      structuredOutput: {},
    }));
    const runner = createRunner(store, { runAgent });

    await expect(runner.run("wfr_agent_timeout_invalid")).rejects.toThrow(
      "agent timeout.graceMs must be a positive integer"
    );
    expect(runAgent).not.toHaveBeenCalled();
  });

  test("requests a final report when an agent soft timeout recovers during grace", async () => {
    using tmp = new DisposableTempDir("workflow-runner-agent-timeout-recovered");
    const store = new WorkflowRunStore({
      sessionDir: tmp.path,
      staleLeaseMs: WORKFLOW_RUNNER_TEST_STALE_LEASE_MS,
    });
    await store.createRun({
      id: "wfr_agent_timeout_recovered",
      workspaceId: "workspace-1",
      workflow: definition,
      source: `export default function workflow({ agent }) {
  const result = agent("Slow work", {
    id: "slow-step",
    schema: { type: "object", properties: { ok: { type: "boolean" } }, required: ["ok"] },
    timeout: { softMs: 1000, graceMs: 2000, finalInstructions: "No extra tools." },
  });
  return { reportMarkdown: result.ok ? "recovered" : "bad" };
}
`,
      args: {},
      now: "2026-05-29T00:00:00.000Z",
    });
    const timeoutError = new Error("soft wait expired");
    timeoutError.name = "AgentReportWaitTimeoutError";
    const waitTimeouts: Array<number | undefined> = [];
    const finalizationRequests: unknown[] = [];
    const runner = createRunner(store, {
      async runAgent() {
        throw new Error("timeout steps should use createAgentTasks so the runner controls waits");
      },
      async createAgentTasks(specs, lifecycle) {
        await lifecycle?.onTaskCreated?.(0, "task_slow");
        expect(specs).toHaveLength(1);
        return [{ taskId: "task_slow", status: "running" }];
      },
      async waitForAgentTask(_taskId, _spec, waitOptions) {
        await waitOptions?.onExecutionStarted?.();
        waitTimeouts.push(waitOptions?.timeoutMs);
        if (waitTimeouts.length === 1) {
          throw timeoutError;
        }
        return { taskId: "task_slow", reportMarkdown: "ok", structuredOutput: { ok: true } };
      },
      async requestAgentFinalReportForTimeout(taskId, request) {
        finalizationRequests.push({ taskId, request });
        return "prompted";
      },
      async failAgentTaskForHardTimeout() {
        throw new Error("hard timeout should not run when grace recovers");
      },
    });

    await expect(runner.run("wfr_agent_timeout_recovered")).resolves.toEqual({
      reportMarkdown: "recovered",
    });

    expect(waitTimeouts).toEqual([1000, 2000]);
    expect(finalizationRequests).toHaveLength(1);
    const run = await store.getRun("wfr_agent_timeout_recovered");
    expect(
      run.events.filter((event) => event.type === "timeout").map((event) => event.phase)
    ).toEqual(["soft", "finalization_prompt_sent", "recovered"]);
  });

  test("extends persisted hard deadline when timeout finalization prompt is accepted", async () => {
    using tmp = new DisposableTempDir("workflow-runner-agent-timeout-finalization-deadline");
    const store = new WorkflowRunStore({
      sessionDir: tmp.path,
      staleLeaseMs: WORKFLOW_RUNNER_TEST_STALE_LEASE_MS,
    });
    const runId = "wfr_agent_timeout_finalization_deadline";
    await store.createRun({
      id: runId,
      workspaceId: "workspace-1",
      workflow: definition,
      source: `export default function workflow({ agent }) {
  const result = agent("Slow work", {
    id: "slow-step",
    schema: { type: "object", properties: { ok: { type: "boolean" } }, required: ["ok"] },
    timeout: { softMs: 1000, graceMs: 2000 },
  });
  return { reportMarkdown: result.ok ? "recovered" : "bad" };
}
`,
      args: {},
      now: "2026-05-29T00:00:00.000Z",
    });
    const timeoutError = new Error("soft wait expired");
    timeoutError.name = "AgentReportWaitTimeoutError";
    let nowMs = Date.parse("2026-05-29T00:00:01.000Z");
    let waitCount = 0;
    const runner = new WorkflowRunner({
      runStore: store,
      runtimeFactory: new QuickJSRuntimeFactory(),
      runnerId: "runner-a",
      clock: {
        nowIso: () => new Date(nowMs).toISOString(),
        nowMs: () => nowMs,
      },
      taskAdapter: {
        async runAgent() {
          throw new Error("timeout steps should use createAgentTasks so the runner controls waits");
        },
        async createAgentTasks(_specs, lifecycle) {
          await lifecycle?.onTaskCreated?.(0, "task_slow");
          return [{ taskId: "task_slow", status: "running" }];
        },
        async waitForAgentTask(_taskId, _spec, waitOptions) {
          await waitOptions?.onExecutionStarted?.();
          waitCount += 1;
          if (waitCount === 1) {
            throw timeoutError;
          }
          return { taskId: "task_slow", reportMarkdown: "ok", structuredOutput: { ok: true } };
        },
        async requestAgentFinalReportForTimeout() {
          nowMs = Date.parse("2026-05-29T00:00:06.000Z");
          return "prompted";
        },
      },
    });

    await expect(runner.run(runId)).resolves.toEqual({ reportMarkdown: "recovered" });
    const run = await store.getRun(runId);
    const timeout = run.steps.find((step) => step.stepId === "slow-step")?.timeout;
    expect(timeout?.finalizationPromptSentAt).toBe("2026-05-29T00:00:06.000Z");
    expect(timeout?.hardDeadlineAt).toBe("2026-05-29T00:00:08.000Z");
  });

  test("does not mark timeout finalization prompt sent before TaskService accepts it", async () => {
    using tmp = new DisposableTempDir("workflow-runner-agent-timeout-finalization-queued");
    const store = new WorkflowRunStore({
      sessionDir: tmp.path,
      staleLeaseMs: WORKFLOW_RUNNER_TEST_STALE_LEASE_MS,
    });
    const runId = "wfr_agent_timeout_finalization_queued";
    await store.createRun({
      id: runId,
      workspaceId: "workspace-1",
      workflow: definition,
      source: `export default function workflow({ agent }) {
  const result = agent("Slow work", {
    id: "slow-step",
    schema: { type: "object", properties: { ok: { type: "boolean" } }, required: ["ok"] },
    timeout: { softMs: 1000, graceMs: 2000 },
  });
  return { reportMarkdown: result.ok ? "recovered" : "bad" };
}
`,
      args: {},
      now: "2026-05-29T00:00:00.000Z",
    });
    const timeoutError = new Error("soft wait expired");
    timeoutError.name = "AgentReportWaitTimeoutError";
    let waitCount = 0;
    const runner = createRunner(store, {
      async runAgent() {
        throw new Error("timeout steps should use createAgentTasks so the runner controls waits");
      },
      async createAgentTasks(_specs, lifecycle) {
        await lifecycle?.onTaskCreated?.(0, "task_slow");
        return [{ taskId: "task_slow", status: "running" }];
      },
      async waitForAgentTask(_taskId, _spec, waitOptions) {
        await waitOptions?.onExecutionStarted?.();
        waitCount += 1;
        if (waitCount === 1) {
          throw timeoutError;
        }
        return { taskId: "task_slow", reportMarkdown: "ok", structuredOutput: { ok: true } };
      },
      async requestAgentFinalReportForTimeout() {
        return "queued";
      },
    });

    await expect(runner.run(runId)).resolves.toEqual({ reportMarkdown: "recovered" });
    const run = await store.getRun(runId);
    expect(
      run.events.filter((event) => event.type === "timeout").map((event) => event.phase)
    ).toEqual(["soft", "recovered"]);
    expect(
      run.steps.find((step) => step.stepId === "slow-step")?.timeout?.finalizationPromptSentAt
    ).toBeUndefined();
  });

  test("fails and hard-times-out an agent that does not report during grace", async () => {
    using tmp = new DisposableTempDir("workflow-runner-agent-timeout-hard");
    const store = new WorkflowRunStore({
      sessionDir: tmp.path,
      staleLeaseMs: WORKFLOW_RUNNER_TEST_STALE_LEASE_MS,
    });
    await store.createRun({
      id: "wfr_agent_timeout_hard",
      workspaceId: "workspace-1",
      workflow: definition,
      source: `export default function workflow({ agent }) {
  return agent("Slow work", { id: "slow-step", timeout: { softMs: 1000, graceMs: 2000 } });
}
`,
      args: {},
      now: "2026-05-29T00:00:00.000Z",
    });
    const timeoutError = new Error("wait expired");
    timeoutError.name = "AgentReportWaitTimeoutError";
    const hardTimeouts: unknown[] = [];
    const runner = createRunner(store, {
      async runAgent() {
        throw new Error("timeout steps should use createAgentTasks so the runner controls waits");
      },
      async createAgentTasks(_specs, lifecycle) {
        await lifecycle?.onTaskCreated?.(0, "task_slow");
        return [{ taskId: "task_slow", status: "running" }];
      },
      async waitForAgentTask(_taskId, _spec, waitOptions) {
        await waitOptions?.onExecutionStarted?.();
        throw timeoutError;
      },
      async requestAgentFinalReportForTimeout() {
        return "prompted";
      },
      async failAgentTaskForHardTimeout(taskId, request) {
        hardTimeouts.push({ taskId, request });
      },
    });

    await expect(runner.run("wfr_agent_timeout_hard")).rejects.toThrow(
      "Workflow agent step slow-step exceeded its soft timeout (1000ms) and did not produce a valid final response within the grace period (2000ms)."
    );
    expect(hardTimeouts).toHaveLength(1);
    const run = await store.getRun("wfr_agent_timeout_hard");
    expect(
      run.events.filter((event) => event.type === "timeout").map((event) => event.phase)
    ).toContain("hard");
  });

  test("does not persist workflow agent timeout deadlines before the child starts running", async () => {
    using tmp = new DisposableTempDir("workflow-runner-agent-timeout-queued-start");
    const store = new WorkflowRunStore({
      sessionDir: tmp.path,
      staleLeaseMs: WORKFLOW_RUNNER_TEST_STALE_LEASE_MS,
    });
    const runId = "wfr_agent_timeout_queued_start";
    await store.createRun({
      id: runId,
      workspaceId: "workspace-1",
      workflow: definition,
      source: `export default function workflow({ agent }) {
  const result = agent("Queued work", {
    id: "queued-step",
    schema: { type: "object", properties: { ok: { type: "boolean" } }, required: ["ok"] },
    timeout: { softMs: 1000, graceMs: 2000 },
  });
  return { reportMarkdown: result.ok ? "started" : "bad" };
}
`,
      args: {},
      now: "2026-05-29T00:00:00.000Z",
    });
    const spec: WorkflowAgentSpec = {
      id: "queued-step",
      prompt: "Queued work",
      outputSchema: {
        type: "object",
        properties: { ok: { type: "boolean" } },
        required: ["ok"],
      },
      timeout: { softMs: 1000, graceMs: 2000 },
    };
    const inputHash = hashWorkflowStepInput(spec.id, spec);
    let inspectedBeforeStart = false;
    const runner = new WorkflowRunner({
      runStore: store,
      runtimeFactory: new QuickJSRuntimeFactory(),
      runnerId: "runner-a",
      clock: {
        nowIso: () => "2026-05-29T00:00:01.000Z",
        nowMs: () => Date.parse("2026-05-29T00:00:01.000Z"),
      },
      taskAdapter: {
        async runAgent() {
          throw new Error("timeout steps should use createAgentTasks so the runner controls waits");
        },
        async createAgentTasks(_specs, lifecycle) {
          await lifecycle?.onTaskCreated?.(0, "task_queued");
          return [{ taskId: "task_queued", status: "queued" }];
        },
        async waitForAgentTask(_taskId, _spec, waitOptions) {
          const stepBeforeStart = await store.getStep(runId, spec.id, inputHash);
          expect(stepBeforeStart?.timeout).toBeUndefined();
          inspectedBeforeStart = true;
          await waitOptions?.onExecutionStarted?.();
          return { taskId: "task_queued", reportMarkdown: "ok", structuredOutput: { ok: true } };
        },
      },
    });

    await expect(runner.run(runId)).resolves.toEqual({ reportMarkdown: "started" });
    expect(inspectedBeforeStart).toBe(true);
    const stepAfterStart = await store.getStep(runId, spec.id, inputHash);
    expect(stepAfterStart?.timeout).toEqual({
      executionStartedAt: "2026-05-29T00:00:01.000Z",
      softDeadlineAt: "2026-05-29T00:00:02.000Z",
    });
  });

  test("resets timeout metadata when validation retries start a fresh agent task", async () => {
    using tmp = new DisposableTempDir("workflow-runner-agent-timeout-retry-reset");
    const store = new WorkflowRunStore({
      sessionDir: tmp.path,
      staleLeaseMs: WORKFLOW_RUNNER_TEST_STALE_LEASE_MS,
    });
    const runId = "wfr_agent_timeout_retry_reset";
    await store.createRun({
      id: runId,
      workspaceId: "workspace-1",
      workflow: definition,
      source: `export default function workflow({ agent }) {
  const result = agent("Slow work", {
    id: "slow-step",
    schema: { type: "object", properties: { ok: { type: "boolean" } }, required: ["ok"] },
    timeout: { softMs: 1000, graceMs: 2000 },
  });
  return { reportMarkdown: result.ok ? "recovered" : "bad" };
}
`,
      args: {},
      now: "2026-05-29T00:00:00.000Z",
    });
    const timeoutError = new Error("soft wait expired");
    timeoutError.name = "AgentReportWaitTimeoutError";
    const taskIds = ["task_first", "task_retry"];
    const waitCalls: Array<{ taskId: string; timeoutMs: number | undefined }> = [];
    const finalizationRequests: string[] = [];
    const runner = createRunner(store, {
      async runAgent() {
        throw new Error("timeout steps should use createAgentTasks so the runner controls waits");
      },
      async createAgentTasks(_specs, lifecycle) {
        const taskId = taskIds.shift();
        expect(taskId).toBeDefined();
        if (taskId == null) {
          throw new Error("test expected another task id");
        }
        await lifecycle?.onTaskCreated?.(0, taskId);
        return [{ taskId, status: "running" }];
      },
      async waitForAgentTask(taskId, _spec, waitOptions) {
        await waitOptions?.onExecutionStarted?.();
        waitCalls.push({ taskId, timeoutMs: waitOptions?.timeoutMs });
        if (taskId === "task_first" && waitCalls.length === 1) {
          throw timeoutError;
        }
        if (taskId === "task_first") {
          return { taskId, reportMarkdown: "invalid", structuredOutput: { ok: "not boolean" } };
        }
        return { taskId, reportMarkdown: "ok", structuredOutput: { ok: true } };
      },
      async requestAgentFinalReportForTimeout(taskId) {
        finalizationRequests.push(taskId);
        return "prompted";
      },
      async failAgentTaskForHardTimeout() {
        throw new Error("hard timeout should not run when retry gets a fresh budget");
      },
    });

    await expect(runner.run(runId)).resolves.toEqual({ reportMarkdown: "recovered" });
    expect(waitCalls).toEqual([
      { taskId: "task_first", timeoutMs: 1000 },
      { taskId: "task_first", timeoutMs: 2000 },
      { taskId: "task_retry", timeoutMs: 1000 },
    ]);
    expect(finalizationRequests).toEqual(["task_first"]);
  });

  test("uses a task-accepted report instead of recording hard timeout failure", async () => {
    using tmp = new DisposableTempDir("workflow-runner-agent-timeout-hard-report-race");
    const store = new WorkflowRunStore({
      sessionDir: tmp.path,
      staleLeaseMs: WORKFLOW_RUNNER_TEST_STALE_LEASE_MS,
    });
    const runId = "wfr_agent_timeout_hard_report_race";
    await store.createRun({
      id: runId,
      workspaceId: "workspace-1",
      workflow: definition,
      source: `export default function workflow({ agent }) {
  const result = agent("Slow work", {
    id: "slow-step",
    schema: { type: "object", properties: { ok: { type: "boolean" } }, required: ["ok"] },
    timeout: { softMs: 1000, graceMs: 2000 },
  });
  return { reportMarkdown: result.ok ? "accepted" : "bad" };
}
`,
      args: {},
      now: "2026-05-29T00:00:00.000Z",
    });
    const timeoutError = new Error("wait expired");
    timeoutError.name = "AgentReportWaitTimeoutError";
    let waitCount = 0;
    const failHardTimeout = mock(async () => undefined);
    const runner = createRunner(store, {
      async runAgent() {
        throw new Error("timeout steps should use createAgentTasks so the runner controls waits");
      },
      async createAgentTasks(_specs, lifecycle) {
        await lifecycle?.onTaskCreated?.(0, "task_slow");
        return [{ taskId: "task_slow", status: "running" }];
      },
      async waitForAgentTask(_taskId, _spec, waitOptions) {
        await waitOptions?.onExecutionStarted?.();
        waitCount += 1;
        if (waitCount <= 2) {
          throw timeoutError;
        }
        return { taskId: "task_slow", reportMarkdown: "ok", structuredOutput: { ok: true } };
      },
      async requestAgentFinalReportForTimeout() {
        return "prompted";
      },
      failAgentTaskForHardTimeout: failHardTimeout,
    });

    await expect(runner.run(runId)).resolves.toEqual({ reportMarkdown: "accepted" });
    expect(failHardTimeout).not.toHaveBeenCalled();
    const run = await store.getRun(runId);
    expect(run.steps.find((step) => step.stepId === "slow-step")?.status).toBe("completed");
  });

  test("restarts timeout-configured resumed agent steps whose task workspace is gone", async () => {
    using tmp = new DisposableTempDir("workflow-runner-agent-timeout-missing-task-restart");
    const store = new WorkflowRunStore({
      sessionDir: tmp.path,
      staleLeaseMs: WORKFLOW_RUNNER_TEST_STALE_LEASE_MS,
    });
    const runId = "wfr_agent_timeout_missing_task_restart";
    const source = `export default function workflow({ agent }) {
  const result = agent("Slow work", {
    id: "slow-step",
    schema: { type: "object", properties: { ok: { type: "boolean" } }, required: ["ok"] },
    timeout: { softMs: 1000, graceMs: 2000 },
  });
  return { reportMarkdown: result.ok ? "restarted" : "bad" };
}
`;
    await store.createRun({
      id: runId,
      workspaceId: "workspace-1",
      workflow: definition,
      source,
      args: {},
      now: "2026-05-29T00:00:00.000Z",
    });
    const spec: WorkflowAgentSpec = {
      id: "slow-step",
      prompt: "Slow work",
      outputSchema: {
        type: "object",
        properties: { ok: { type: "boolean" } },
        required: ["ok"],
      },
      timeout: { softMs: 1000, graceMs: 2000 },
    };
    const inputHash = hashWorkflowStepInput(spec.id, spec);
    await store.recordStepStarted(runId, {
      stepId: spec.id,
      inputHash,
      taskId: "task_missing",
      startedAt: "2026-05-29T00:00:00.000Z",
    });
    const waitCalls: string[] = [];
    const runner = createRunner(store, {
      async runAgent() {
        throw new Error("timeout steps should use createAgentTasks so the runner controls waits");
      },
      async createAgentTasks(_specs, lifecycle) {
        await lifecycle?.onTaskCreated?.(0, "task_restarted");
        return [{ taskId: "task_restarted", status: "running" }];
      },
      async waitForAgentTask(taskId, _spec, waitOptions) {
        waitCalls.push(taskId);
        if (taskId === "task_missing") {
          throw new Error("Task not found");
        }
        await waitOptions?.onExecutionStarted?.();
        return { taskId, reportMarkdown: "ok", structuredOutput: { ok: true } };
      },
    });

    await expect(runner.run(runId)).resolves.toEqual({ reportMarkdown: "restarted" });
    expect(waitCalls).toEqual(["task_missing", "task_restarted"]);
  });

  test("records terminal task events for non-timeout failures from timeout waits", async () => {
    using tmp = new DisposableTempDir("workflow-runner-agent-timeout-terminal-event");
    const store = new WorkflowRunStore({
      sessionDir: tmp.path,
      staleLeaseMs: WORKFLOW_RUNNER_TEST_STALE_LEASE_MS,
    });
    const runId = "wfr_agent_timeout_terminal_event";
    await store.createRun({
      id: runId,
      workspaceId: "workspace-1",
      workflow: definition,
      source: `export default function workflow({ agent }) {
  return agent("Slow work", { id: "slow-step", timeout: { softMs: 1000, graceMs: 2000 } });
}
`,
      args: {},
      now: "2026-05-29T00:00:00.000Z",
    });
    const runner = createRunner(store, {
      async runAgent() {
        throw new Error("timeout steps should use createAgentTasks so the runner controls waits");
      },
      async createAgentTasks(_specs, lifecycle) {
        await lifecycle?.onTaskCreated?.(0, "task_failed");
        return [{ taskId: "task_failed", status: "running" }];
      },
      async waitForAgentTask() {
        throw new Error("model refused");
      },
    });

    await expect(runner.run(runId)).rejects.toThrow("model refused");
    const run = await store.getRun(runId);
    expect(
      run.events.some(
        (event) =>
          event.type === "task" && event.taskId === "task_failed" && event.status === "failed"
      )
    ).toBe(true);
  });

  test("resumes a timeout-finalizing agent without sending a duplicate finalization prompt", async () => {
    using tmp = new DisposableTempDir("workflow-runner-agent-timeout-resume-grace");
    const store = new WorkflowRunStore({
      sessionDir: tmp.path,
      staleLeaseMs: WORKFLOW_RUNNER_TEST_STALE_LEASE_MS,
    });
    const source = `export default function workflow({ agent }) {
  const result = agent("Slow work", {
    id: "slow-step",
    schema: { type: "object", properties: { ok: { type: "boolean" } }, required: ["ok"] },
    timeout: { softMs: 1000, graceMs: 2000 },
  });
  return { reportMarkdown: result.ok ? "recovered" : "bad" };
}
`;
    await store.createRun({
      id: "wfr_agent_timeout_resume_grace",
      workspaceId: "workspace-1",
      workflow: definition,
      source,
      args: {},
      now: "2026-05-29T00:00:00.000Z",
    });
    const spec: WorkflowAgentSpec = {
      id: "slow-step",
      prompt: "Slow work",
      outputSchema: {
        type: "object",
        properties: { ok: { type: "boolean" } },
        required: ["ok"],
      },
      timeout: { softMs: 1000, graceMs: 2000 },
    };
    const inputHash = hashWorkflowStepInput(spec.id, spec);
    await store.recordStepStarted("wfr_agent_timeout_resume_grace", {
      stepId: spec.id,
      inputHash,
      taskId: "task_slow",
      startedAt: "2026-05-29T00:00:00.000Z",
    });
    await store.recordStepTimeoutMetadata("wfr_agent_timeout_resume_grace", {
      stepId: spec.id,
      inputHash,
      taskId: "task_slow",
      startedAt: "2026-05-29T00:00:00.000Z",
      timeout: {
        executionStartedAt: "2026-05-29T00:00:00.000Z",
        softDeadlineAt: "2026-05-29T00:00:01.000Z",
        softTimedOutAt: "2026-05-29T00:00:01.000Z",
        hardDeadlineAt: "2026-05-29T00:00:03.000Z",
        finalizationToken: "existing-token",
        finalizationPromptSentAt: "2026-05-29T00:00:01.100Z",
      },
    });
    const waitTimeouts: Array<number | undefined> = [];
    const requestFinalReport = mock(async () => "prompted" as const);
    const runner = new WorkflowRunner({
      runStore: store,
      runtimeFactory: new QuickJSRuntimeFactory(),
      runnerId: "runner-a",
      clock: {
        nowIso: () => "2026-05-29T00:00:01.500Z",
        nowMs: () => Date.parse("2026-05-29T00:00:01.500Z"),
      },
      taskAdapter: {
        async runAgent() {
          throw new Error("resume should wait on the started task");
        },
        async waitForAgentTask(_taskId, _spec, waitOptions) {
          await waitOptions?.onExecutionStarted?.();
          waitTimeouts.push(waitOptions?.timeoutMs);
          return { taskId: "task_slow", reportMarkdown: "ok", structuredOutput: { ok: true } };
        },
        requestAgentFinalReportForTimeout: requestFinalReport,
      },
    });

    await expect(runner.run("wfr_agent_timeout_resume_grace")).resolves.toEqual({
      reportMarkdown: "recovered",
    });
    expect(waitTimeouts).toEqual([1500]);
    expect(requestFinalReport).not.toHaveBeenCalled();
  });

  test("fails before spawning when workflow agent outputSchema is invalid", async () => {
    using tmp = new DisposableTempDir("workflow-runner-invalid-output-schema");
    const store = new WorkflowRunStore({
      sessionDir: tmp.path,
      staleLeaseMs: WORKFLOW_RUNNER_TEST_STALE_LEASE_MS,
    });
    await store.createRun({
      id: "wfr_invalid_schema",
      workspaceId: "workspace-1",
      workflow: definition,
      source: `export default function workflow({ agent }) {
  return agent("Invalid schema", { id: "invalid-schema", schema: { type: "definitely-not-json-schema" } });
}
`,
      args: {},
      now: "2026-05-29T00:00:00.000Z",
    });
    const runAgent = mock(async () => ({
      taskId: "task_1",
      reportMarkdown: "summary",
      structuredOutput: {},
    }));
    const runner = createRunner(store, { runAgent });

    await expect(runner.run("wfr_invalid_schema")).rejects.toThrow(
      "Workflow agent step invalid-schema has invalid outputSchema"
    );
    expect(runAgent).not.toHaveBeenCalled();
  });

  test("fails before spawning when workflow agent outputSchema is not an object schema", async () => {
    using tmp = new DisposableTempDir("workflow-runner-scalar-output-schema");
    const store = new WorkflowRunStore({
      sessionDir: tmp.path,
      staleLeaseMs: WORKFLOW_RUNNER_TEST_STALE_LEASE_MS,
    });
    await store.createRun({
      id: "wfr_scalar_schema",
      workspaceId: "workspace-1",
      workflow: definition,
      source: `export default function workflow({ agent }) {
  return agent("Return a scalar", { id: "scalar", schema: { type: "string" } });
}
`,
      args: {},
      now: "2026-05-29T00:00:00.000Z",
    });
    const runAgent = mock(async () => ({
      taskId: "task_1",
      reportMarkdown: "summary",
      structuredOutput: "scalar",
    }));
    const runner = createRunner(store, { runAgent });

    await expect(runner.run("wfr_scalar_schema")).rejects.toThrow(
      "Workflow agent schemas must be object schemas"
    );
    expect(runAgent).not.toHaveBeenCalled();
  });

  test("runs the terminal lifecycle callback when the workflow fails", async () => {
    using tmp = new DisposableTempDir("workflow-runner");
    const store = await createRunStore(tmp.path);
    const lifecycle: string[] = [];
    const runner = createRunner(store, {
      async runAgent() {
        throw new Error("agent exploded");
      },
      onRunEnded() {
        lifecycle.push("ended");
      },
    });

    await expect(runner.run("wfr_123")).rejects.toThrow("agent exploded");

    expect(lifecycle).toEqual(["ended"]);
  });

  test("does not run the terminal lifecycle callback when the lease belongs to another runner", async () => {
    using tmp = new DisposableTempDir("workflow-runner");
    const store = await createRunStore(tmp.path);
    // Simulate a concurrent runner owning a fresh (non-stale) lease at the
    // same clock instant the runner under test will see (nowMs = 1000).
    expect(await store.acquireLease("wfr_123", "runner-other", 1_000)).toBe(true);

    const lifecycle: string[] = [];
    const runner = createRunner(store, {
      async runAgent() {
        return { taskId: "task_1", reportMarkdown: "summary", structuredOutput: {} };
      },
      onRunEnded() {
        lifecycle.push("ended");
      },
    });

    await expect(runner.run("wfr_123")).rejects.toThrow("Workflow run is already active");

    // The lease owner is responsible for the terminal lifecycle callback; this runner must not.
    expect(lifecycle).toEqual([]);
  });

  test("executes conductor primitives and persists run events/results", async () => {
    using tmp = new DisposableTempDir("workflow-runner");
    const store = await createRunStore(tmp.path);
    const taskCalls: unknown[] = [];
    let runTimeoutMs: number | undefined;
    let runAbortSignalWasAbortedDuringAgent: boolean | undefined;
    const runner = createRunner(store, {
      async runAgent(spec, _lifecycle, waitOptions) {
        taskCalls.push(spec);
        runTimeoutMs = waitOptions?.timeoutMs;
        runAbortSignalWasAbortedDuringAgent = waitOptions?.abortSignal?.aborted;
        return {
          taskId: "task_1",
          reportMarkdown: "summary",
          structuredOutput: { sources: 3 },
        };
      },
    });

    const result = await runner.run("wfr_123");
    const run = await store.getRun("wfr_123");

    expect(result).toEqual({ reportMarkdown: "Final: summary" });
    expect(taskCalls).toEqual([
      { id: "summarize-topic", prompt: "Summarize durable workflows", markdownOnly: true },
    ]);
    expect(runTimeoutMs).toBeGreaterThan(5 * 60 * 1000);
    expect(runAbortSignalWasAbortedDuringAgent).toBe(false);
    expect(run.status).toBe("completed");
    expect(run.events.map((event) => event.type)).toEqual([
      "status",
      "phase",
      "log",
      "task",
      "task",
      "result",
      "status",
    ]);
    expect(run.events.filter((event) => event.type === "task")).toEqual([
      expect.objectContaining({ stepId: "summarize-topic", taskId: "task_1", status: "started" }),
      expect.objectContaining({ stepId: "summarize-topic", taskId: "task_1", status: "completed" }),
    ]);
    expect(run.steps).toHaveLength(1);
    expect(run.steps[0]).toMatchObject({
      stepId: "summarize-topic",
      status: "completed",
      taskId: "task_1",
      result: { reportMarkdown: "summary", structuredOutput: { sources: 3 } },
    });
  });

  test("records an agent reservation event before reserving a single agent task", async () => {
    using tmp = new DisposableTempDir("workflow-runner-agent-reservation-event");
    const store = await createRunStore(tmp.path);
    const trace: string[] = [];
    const runner = createRunner(store, {
      async runAgent() {
        throw new Error("single workflow agents should use reservation-first task creation");
      },
      async createAgentTasks(specs, lifecycle) {
        trace.push(`reserve:${specs.map((spec) => spec.id).join(",")}`);
        const runDuringReservation = await store.getRun("wfr_123");
        expect(runDuringReservation.events).toEqual(
          expect.arrayContaining([
            expect.objectContaining({
              type: "agent-step",
              stepId: "summarize-topic",
              status: "reserving",
            }),
          ])
        );
        await lifecycle?.onTaskCreated?.(0, "task_reserved");
        return [{ taskId: "task_reserved", status: "starting" as const }];
      },
      async waitForAgentTask(taskId) {
        trace.push(`wait:${taskId}`);
        return { taskId, reportMarkdown: "summary", structuredOutput: { sources: 3 } };
      },
    });

    await expect(runner.run("wfr_123")).resolves.toEqual({ reportMarkdown: "Final: summary" });

    const run = await store.getRun("wfr_123");
    expect(trace).toEqual(["reserve:summarize-topic", "wait:task_reserved"]);
    expect(run.events.map((event) => event.type)).toEqual([
      "status",
      "phase",
      "log",
      "agent-step",
      "task",
      "task",
      "result",
      "status",
    ]);
  });

  test("records a failed agent reservation event when reservation fails", async () => {
    using tmp = new DisposableTempDir("workflow-runner-agent-reservation-failed-event");
    const store = await createRunStore(tmp.path);
    const runner = createRunner(store, {
      async runAgent() {
        throw new Error("single workflow agents should use reservation-first task creation");
      },
      async createAgentTasks() {
        throw new Error("reservation failed");
      },
      async waitForAgentTask() {
        throw new Error("wait should not run when reservation fails");
      },
    });

    await expect(runner.run("wfr_123")).rejects.toThrow("reservation failed");

    const run = await store.getRun("wfr_123");
    expect(run.events).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          type: "agent-step",
          stepId: "summarize-topic",
          status: "failed",
        }),
      ])
    );
  });

  test("records a started task event as soon as an agent task is created", async () => {
    using tmp = new DisposableTempDir("workflow-runner-started-task-event");
    const store = await createRunStore(tmp.path);
    const runner = createRunner(store, {
      async runAgent(_spec, lifecycle) {
        await lifecycle?.onTaskCreated?.("task_live");
        const runDuringTask = await store.getRun("wfr_123");
        expect(runDuringTask.events).toEqual(
          expect.arrayContaining([
            expect.objectContaining({
              type: "task",
              stepId: "summarize-topic",
              taskId: "task_live",
              status: "started",
            }),
          ])
        );
        return {
          taskId: "task_live",
          reportMarkdown: "summary",
          structuredOutput: { sources: 3 },
        };
      },
    });

    await runner.run("wfr_123");
    const taskEvents = (await store.getRun("wfr_123")).events.filter(
      (event) => event.type === "task"
    );

    expect(taskEvents).toEqual([
      expect.objectContaining({
        stepId: "summarize-topic",
        taskId: "task_live",
        status: "started",
      }),
      expect.objectContaining({
        stepId: "summarize-topic",
        taskId: "task_live",
        status: "completed",
      }),
    ]);
  });

  test("task events carry the agent spec title and omit it when the spec has none", async () => {
    using tmp = new DisposableTempDir("workflow-runner-task-event-title");
    const store = new WorkflowRunStore({
      sessionDir: tmp.path,
      staleLeaseMs: WORKFLOW_RUNNER_TEST_STALE_LEASE_MS,
    });
    await store.createRun({
      id: "wfr_titled",
      workspaceId: "workspace-1",
      workflow: definition,
      source: `export default function workflow({ agent }) {
        agent("Verify", {
          id: "verify-claim-0-vote-2",
          title: "Verify claim 1 vote 3",
          schema: { type: "object", additionalProperties: false },
        });
        agent("No title", {
          id: "untitled-step",
          schema: { type: "object", additionalProperties: false },
        });
        return { reportMarkdown: "done" };
      }`,
      args: {},
      now: "2026-05-29T00:00:00.000Z",
    });
    let nextTaskNumber = 1;
    const runner = createRunner(store, {
      async runAgent(_spec, lifecycle) {
        const taskId = `task_${nextTaskNumber}`;
        nextTaskNumber += 1;
        // Report the taskId via the lifecycle callback like the production adapter
        // does, so the started-event title is pinned on the lifecycle path rather
        // than the post-hoc fallback.
        await lifecycle?.onTaskCreated?.(taskId);
        return { taskId, reportMarkdown: "ok", structuredOutput: {} };
      },
    });

    await runner.run("wfr_titled");
    const taskEvents = (await store.getRun("wfr_titled")).events.filter(
      (event) => event.type === "task"
    );

    expect(taskEvents).toEqual([
      expect.objectContaining({
        stepId: "verify-claim-0-vote-2",
        title: "Verify claim 1 vote 3",
        status: "started",
      }),
      expect.objectContaining({
        stepId: "verify-claim-0-vote-2",
        title: "Verify claim 1 vote 3",
        status: "completed",
      }),
      expect.objectContaining({ stepId: "untitled-step", status: "started" }),
      expect.objectContaining({ stepId: "untitled-step", status: "completed" }),
    ]);
    // Untitled specs must omit the field rather than defaulting it to something else.
    const untitledEvents = taskEvents.filter((event) => event.stepId === "untitled-step");
    expect(untitledEvents).toHaveLength(2);
    for (const event of untitledEvents) {
      expect(event.title).toBeUndefined();
    }
  });

  test("returns markdown-only agent reports as text to workflow code", async () => {
    using tmp = new DisposableTempDir("workflow-runner-markdown-agent-result");
    const store = new WorkflowRunStore({
      sessionDir: tmp.path,
      staleLeaseMs: WORKFLOW_RUNNER_TEST_STALE_LEASE_MS,
    });
    await store.createRun({
      id: "wfr_markdown_agent_result",
      workspaceId: "workspace-1",
      workflow: definition,
      source: `export default function workflow({ agent }) {
        const result = agent("Implement", { id: "implement" });
        return { reportMarkdown: result };
      }`,
      args: {},
      now: "2026-05-29T00:00:00.000Z",
    });
    const runner = createRunner(store, {
      async runAgent() {
        return { taskId: "task_impl", reportMarkdown: "implemented" };
      },
    });

    await expect(runner.run("wfr_markdown_agent_result")).resolves.toEqual({
      reportMarkdown: "implemented",
    });
    const run = await store.getRun("wfr_markdown_agent_result");

    expect(run.steps[0]?.result).toMatchObject({ taskId: "task_impl" });
  });

  test("applyPatch applies a completed workflow agent patch by agentId", async () => {
    using tmp = new DisposableTempDir("workflow-runner-apply-patch-agent-id");
    const store = new WorkflowRunStore({
      sessionDir: tmp.path,
      staleLeaseMs: WORKFLOW_RUNNER_TEST_STALE_LEASE_MS,
    });
    await store.createRun({
      id: "wfr_apply_patch_agent_id",
      workspaceId: "workspace-1",
      workflow: definition,
      source: `export default function workflow({ agent, applyPatch }) {
  agent("Implement the change", { id: "implement" });
  const patch = applyPatch({ id: "apply-implement", agentId: "implement" });
  return { reportMarkdown: patch.status + ":" + patch.taskId };
}
`,
      args: {},
      now: "2026-05-29T00:00:00.000Z",
    });
    const applyPatchCalls: unknown[] = [];
    const runner = createRunner(store, {
      async runAgent() {
        return { taskId: "task_impl", reportMarkdown: "implemented", structuredOutput: {} };
      },
      async applyPatch(spec) {
        applyPatchCalls.push(spec);
        return {
          success: true,
          status: "applied",
          taskId: spec.sourceTaskId,
          appliedCommits: ["abc123"],
        };
      },
    });

    await expect(runner.run("wfr_apply_patch_agent_id")).resolves.toEqual({
      reportMarkdown: "applied:task_impl",
    });
    const run = await store.getRun("wfr_apply_patch_agent_id");

    expect(applyPatchCalls).toHaveLength(1);
    expect(applyPatchCalls[0]).toMatchObject({
      id: "apply-implement",
      sourceTaskId: "task_impl",
      target: "parent",
    });
    expect(run.events).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          type: "patch",
          stepId: "apply-implement",
          sourceTaskId: "task_impl",
          status: "applied",
        }),
      ])
    );
  });

  test("applyPatch fails before adapter calls when agentId has not completed", async () => {
    using tmp = new DisposableTempDir("workflow-runner-apply-patch-missing-agent-id");
    const store = new WorkflowRunStore({
      sessionDir: tmp.path,
      staleLeaseMs: WORKFLOW_RUNNER_TEST_STALE_LEASE_MS,
    });
    await store.createRun({
      id: "wfr_apply_patch_missing_agent_id",
      workspaceId: "workspace-1",
      workflow: definition,
      source: `export default function workflow({ applyPatch }) {
  return applyPatch({ id: "apply-missing", agentId: "missing" });
}
`,
      args: {},
      now: "2026-05-29T00:00:00.000Z",
    });
    const applyPatch = mock(async () => {
      throw new Error("applyPatch adapter should not be called");
    });
    const runner = createRunner(store, {
      async runAgent() {
        throw new Error("No agent steps expected");
      },
      applyPatch,
    });

    await expect(runner.run("wfr_apply_patch_missing_agent_id")).rejects.toThrow(
      "applyPatch agentId missing was not produced by a completed workflow agent step"
    );
    expect(applyPatch).not.toHaveBeenCalled();
  });

  test("marks run failed when runtime setup throws after starting", async () => {
    using tmp = new DisposableTempDir("workflow-runner-runtime-setup");
    const store = await createRunStore(tmp.path);
    const runner = new WorkflowRunner({
      runStore: store,
      runtimeFactory: {
        async create() {
          throw new Error("runtime unavailable");
        },
      },
      taskAdapter: {
        async runAgent() {
          throw new Error("should not spawn tasks");
        },
      },
      runnerId: "runner-a",
      clock: {
        nowIso: () => "2026-05-29T00:00:01.000Z",
        nowMs: () => 1_000,
      },
    });

    await expect(runner.run("wfr_123")).rejects.toThrow("runtime unavailable");
    const run = await store.getRun("wfr_123");

    expect(run.status).toBe("failed");
    expect(run.events).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ type: "error", message: "runtime unavailable" }),
        expect.objectContaining({ type: "status", status: "failed" }),
      ])
    );
  });

  test("requires explicit resume permission to restart interrupted runs", async () => {
    using tmp = new DisposableTempDir("workflow-runner");
    const store = await createRunStore(tmp.path);
    await store.appendStatus("wfr_123", "interrupted", "2026-05-29T00:00:00.500Z");
    let taskCalls = 0;
    const runner = createRunner(store, {
      async runAgent() {
        taskCalls += 1;
        return { taskId: "task_1", reportMarkdown: "summary", structuredOutput: {} };
      },
    });

    await expect(runner.run("wfr_123")).rejects.toThrow(/interrupted/);
    await expect(store.getRun("wfr_123")).resolves.toMatchObject({ status: "interrupted" });
    expect(taskCalls).toBe(0);

    await expect(
      runner.run("wfr_123", { allowResumeFromInterrupted: true })
    ).resolves.toMatchObject({ reportMarkdown: "Final: summary" });
    await expect(store.getRun("wfr_123")).resolves.toMatchObject({ status: "completed" });
    expect(taskCalls).toBe(1);
  });

  test("requires explicit checkpoint retry permission to restart failed runs", async () => {
    using tmp = new DisposableTempDir("workflow-runner");
    const store = await createRunStore(tmp.path);
    const spec = {
      id: "summarize-topic",
      prompt: "Summarize durable workflows",
      markdownOnly: true,
    };
    await store.recordStepStarted("wfr_123", {
      stepId: spec.id,
      inputHash: hashWorkflowStepInput(spec.id, spec),
      taskId: "task_existing",
      startedAt: "2026-05-29T00:00:00.500Z",
    });
    await store.appendEvent("wfr_123", {
      sequence: 1,
      type: "error",
      at: "2026-05-29T00:00:00.750Z",
      message: "Execution interrupted",
    });
    await store.appendStatus("wfr_123", "failed", "2026-05-29T00:00:00.751Z");

    let runAgentCalls = 0;
    const waitedFor: string[] = [];
    const runner = createRunner(store, {
      async runAgent() {
        runAgentCalls += 1;
        return { taskId: "task_duplicate", reportMarkdown: "duplicate", structuredOutput: {} };
      },
      async waitForAgentTask(taskId) {
        waitedFor.push(taskId);
        return { taskId, reportMarkdown: "summary", structuredOutput: {} };
      },
    });

    await expect(runner.run("wfr_123")).rejects.toThrow(/failed/);
    await expect(runner.run("wfr_123", { allowRetryFromFailedCheckpoint: true })).resolves.toEqual({
      reportMarkdown: "Final: summary",
    });
    const run = await store.getRun("wfr_123");

    expect(run.status).toBe("completed");
    expect(waitedFor).toEqual(["task_existing"]);
    expect(runAgentCalls).toBe(0);
  });

  test("aborts without terminal writes after losing its lease", async () => {
    using tmp = new DisposableTempDir("workflow-runner");
    const store = await createRunStore(tmp.path);
    let renewCalls = 0;
    let resolveTaskStarted!: () => void;
    const taskStarted = new Promise<void>((resolve) => {
      resolveTaskStarted = resolve;
    });
    store.renewLease = async () => {
      renewCalls += 1;
      if (renewCalls === 1) {
        return true;
      }
      await taskStarted;
      return false;
    };
    let sawAbort = false;
    const runner = createRunner(store, {
      async runAgent(_spec, _lifecycle, waitOptions) {
        resolveTaskStarted();
        return await new Promise<never>((_resolve, reject) => {
          const signal = waitOptions?.abortSignal;
          if (signal == null) {
            reject(new Error("missing abort signal"));
            return;
          }
          if (signal.aborted) {
            sawAbort = true;
            reject(new Error("task aborted"));
            return;
          }
          signal.addEventListener(
            "abort",
            () => {
              sawAbort = true;
              reject(new Error("task aborted"));
            },
            { once: true }
          );
        });
      },
    });

    await expect(runner.run("wfr_123")).rejects.toThrow(/lease lost/);
    const run = await store.getRun("wfr_123");

    expect(renewCalls).toBeGreaterThan(0);
    expect(sawAbort).toBe(true);
    expect(run.status).toBe("running");
    expect(
      run.events.some((event) => event.type === "status" && event.status === "completed")
    ).toBe(false);
    expect(run.events.some((event) => event.type === "status" && event.status === "failed")).toBe(
      false
    );
  });

  test("replays completed agent steps without respawning child tasks", async () => {
    using tmp = new DisposableTempDir("workflow-runner");
    const store = await createRunStore(tmp.path);
    let taskCalls = 0;
    const runner = createRunner(store, {
      async runAgent() {
        taskCalls += 1;
        return { taskId: "task_1", reportMarkdown: "summary", structuredOutput: {} };
      },
    });

    await runner.run("wfr_123");
    await runner.run("wfr_123");

    expect(taskCalls).toBe(1);
  });

  test("replays completed legacy agent steps that omitted outputSchema", async () => {
    using tmp = new DisposableTempDir("workflow-runner-legacy-completed-missing-schema");
    const store = new WorkflowRunStore({
      sessionDir: tmp.path,
      staleLeaseMs: WORKFLOW_RUNNER_TEST_STALE_LEASE_MS,
    });
    await store.createRun({
      id: "wfr_legacy_completed_schema",
      workspaceId: "workspace-1",
      workflow: definition,
      source: `export default function workflow({ agent }) {
  const summary = agent("Summarize durable workflows", { id: "summarize-topic" });
  return { reportMarkdown: "Final: " + summary };
}
`,
      args: {},
      agentOutputSchemaRequired: false,
      now: "2026-05-29T00:00:00.000Z",
    });
    const legacySpec = {
      id: "summarize-topic",
      prompt: "Summarize durable workflows",
      markdownOnly: true,
    };
    await store.recordStepCompleted("wfr_legacy_completed_schema", {
      stepId: legacySpec.id,
      inputHash: hashWorkflowStepInput(legacySpec.id, legacySpec),
      taskId: "task_legacy_completed",
      result: { taskId: "task_legacy_completed", reportMarkdown: "summary", structuredOutput: {} },
      startedAt: "2026-05-29T00:00:00.500Z",
      completedAt: "2026-05-29T00:00:00.750Z",
    });
    const runAgent = mock(async () => {
      throw new Error("agent should replay");
    });
    const runner = createRunner(store, { runAgent });

    await expect(runner.run("wfr_legacy_completed_schema")).resolves.toEqual({
      reportMarkdown: "Final: summary",
    });
    expect(runAgent).not.toHaveBeenCalled();
  });

  test("replays completed legacy agent steps before validating old outputSchema keywords", async () => {
    using tmp = new DisposableTempDir("workflow-runner-legacy-completed-invalid-schema");
    const store = new WorkflowRunStore({
      sessionDir: tmp.path,
      staleLeaseMs: WORKFLOW_RUNNER_TEST_STALE_LEASE_MS,
    });
    await store.createRun({
      id: "wfr_legacy_completed_invalid_schema",
      workspaceId: "workspace-1",
      workflow: definition,
      source: `export default function workflow({ agent }) {
  const summary = agent("Summarize durable workflows", { id: "summarize-topic" });
  return { reportMarkdown: "Final: " + summary };
}
`,
      args: {},
      agentOutputSchemaRequired: false,
      now: "2026-05-29T00:00:00.000Z",
    });
    const legacySpec = {
      id: "summarize-topic",
      prompt: "Summarize durable workflows",
      markdownOnly: true,
    };
    await store.recordStepCompleted("wfr_legacy_completed_invalid_schema", {
      stepId: legacySpec.id,
      inputHash: hashWorkflowStepInput(legacySpec.id, legacySpec),
      taskId: "task_legacy_completed",
      result: { taskId: "task_legacy_completed", reportMarkdown: "summary" },
      startedAt: "2026-05-29T00:00:00.500Z",
      completedAt: "2026-05-29T00:00:00.750Z",
    });
    const runAgent = mock(async () => {
      throw new Error("agent should replay");
    });
    const runner = createRunner(store, { runAgent });

    await expect(runner.run("wfr_legacy_completed_invalid_schema")).resolves.toEqual({
      reportMarkdown: "Final: summary",
    });
    expect(runAgent).not.toHaveBeenCalled();
  });

  test("resumes started legacy agent steps before validating old outputSchema keywords", async () => {
    using tmp = new DisposableTempDir("workflow-runner-legacy-started-invalid-schema");
    const store = new WorkflowRunStore({
      sessionDir: tmp.path,
      staleLeaseMs: WORKFLOW_RUNNER_TEST_STALE_LEASE_MS,
    });
    await store.createRun({
      id: "wfr_legacy_started_invalid_schema",
      workspaceId: "workspace-1",
      workflow: definition,
      source: `export default function workflow({ agent }) {
  const summary = agent("Summarize durable workflows", { id: "summarize-topic" });
  return { reportMarkdown: "Final: " + summary };
}
`,
      args: {},
      agentOutputSchemaRequired: false,
      now: "2026-05-29T00:00:00.000Z",
    });
    await store.appendStatus(
      "wfr_legacy_started_invalid_schema",
      "running",
      "2026-05-29T00:00:00.250Z"
    );
    const legacySpec = {
      id: "summarize-topic",
      prompt: "Summarize durable workflows",
      markdownOnly: true,
    };
    await store.recordStepStarted("wfr_legacy_started_invalid_schema", {
      stepId: legacySpec.id,
      inputHash: hashWorkflowStepInput(legacySpec.id, legacySpec),
      taskId: "task_legacy_started",
      startedAt: "2026-05-29T00:00:00.500Z",
    });
    const runAgent = mock(async () => {
      throw new Error("agent should resume existing task");
    });
    const waitedFor: string[] = [];
    const runner = createRunner(store, {
      runAgent,
      async waitForAgentTask(taskId) {
        waitedFor.push(taskId);
        return { taskId, reportMarkdown: "summary" };
      },
    });

    await expect(runner.run("wfr_legacy_started_invalid_schema")).resolves.toEqual({
      reportMarkdown: "Final: summary",
    });
    expect(runAgent).not.toHaveBeenCalled();
    expect(waitedFor).toEqual(["task_legacy_started"]);
  });

  test("resumes started legacy agent steps that omitted outputSchema", async () => {
    using tmp = new DisposableTempDir("workflow-runner-legacy-started-missing-schema");
    const store = new WorkflowRunStore({
      sessionDir: tmp.path,
      staleLeaseMs: WORKFLOW_RUNNER_TEST_STALE_LEASE_MS,
    });
    await store.createRun({
      id: "wfr_legacy_started_schema",
      workspaceId: "workspace-1",
      workflow: definition,
      source: `export default function workflow({ agent }) {
  const summary = agent("Summarize durable workflows", { id: "summarize-topic" });
  return { reportMarkdown: "Final: " + summary };
}
`,
      args: {},
      agentOutputSchemaRequired: false,
      now: "2026-05-29T00:00:00.000Z",
    });
    await store.appendStatus("wfr_legacy_started_schema", "running", "2026-05-29T00:00:00.250Z");
    const legacySpec = {
      id: "summarize-topic",
      prompt: "Summarize durable workflows",
      markdownOnly: true,
    };
    await store.recordStepStarted("wfr_legacy_started_schema", {
      stepId: legacySpec.id,
      inputHash: hashWorkflowStepInput(legacySpec.id, legacySpec),
      taskId: "task_legacy_started",
      startedAt: "2026-05-29T00:00:00.500Z",
    });
    const runAgent = mock(async () => {
      throw new Error("agent should resume existing task");
    });
    const waitedFor: string[] = [];
    const runner = createRunner(store, {
      runAgent,
      async waitForAgentTask(taskId) {
        waitedFor.push(taskId);
        return { taskId, reportMarkdown: "summary" };
      },
    });

    await expect(runner.run("wfr_legacy_started_schema")).resolves.toEqual({
      reportMarkdown: "Final: summary",
    });
    expect(runAgent).not.toHaveBeenCalled();
    expect(waitedFor).toEqual(["task_legacy_started"]);
  });

  test("runs unstarted legacy markdown-only workflow steps without outputSchema", async () => {
    using tmp = new DisposableTempDir("workflow-runner-legacy-unstarted-invalid-schema");
    const store = new WorkflowRunStore({
      sessionDir: tmp.path,
      staleLeaseMs: WORKFLOW_RUNNER_TEST_STALE_LEASE_MS,
    });
    await store.createRun({
      id: "wfr_legacy_unstarted_invalid_schema",
      workspaceId: "workspace-1",
      workflow: definition,
      source: `export default function workflow({ agent }) {
  const summary = agent("Summarize durable workflows", { id: "summarize-topic" });
  return { reportMarkdown: "Final: " + summary };
}
`,
      args: {},
      agentOutputSchemaRequired: false,
      now: "2026-05-29T00:00:00.000Z",
    });
    await store.appendStatus(
      "wfr_legacy_unstarted_invalid_schema",
      "running",
      "2026-05-29T00:00:00.250Z"
    );
    const runner = createRunner(store, {
      async runAgent(spec) {
        expect(spec.outputSchema).toBeUndefined();
        return { taskId: "task_legacy_unstarted", reportMarkdown: "summary" };
      },
    });

    await expect(runner.run("wfr_legacy_unstarted_invalid_schema")).resolves.toEqual({
      reportMarkdown: "Final: summary",
    });
  });

  test("does not synthesize outputSchema for markdown-only legacy workflow steps", async () => {
    using tmp = new DisposableTempDir("workflow-runner-legacy-unstarted-schema");
    const store = new WorkflowRunStore({
      sessionDir: tmp.path,
      staleLeaseMs: WORKFLOW_RUNNER_TEST_STALE_LEASE_MS,
    });
    await store.createRun({
      id: "wfr_legacy_unstarted_schema",
      workspaceId: "workspace-1",
      workflow: definition,
      source: `export default function workflow({ agent }) {
  const summary = agent("Summarize durable workflows", { id: "summarize-topic" });
  return { reportMarkdown: "Final: " + summary };
}
`,
      args: {},
      agentOutputSchemaRequired: false,
      now: "2026-05-29T00:00:00.000Z",
    });
    await store.appendStatus("wfr_legacy_unstarted_schema", "running", "2026-05-29T00:00:00.250Z");
    let runAgentCalls = 0;
    const runner = createRunner(store, {
      async runAgent(spec) {
        runAgentCalls += 1;
        expect(spec.outputSchema).toBeUndefined();
        expect(spec.markdownOnly).toBe(true);
        return { taskId: "task_legacy_unstarted", reportMarkdown: "summary" };
      },
    });

    await expect(runner.run("wfr_legacy_unstarted_schema")).resolves.toEqual({
      reportMarkdown: "Final: summary",
    });
    expect(runAgentCalls).toBe(1);
  });

  test("runs markdown-only agent steps in new non-pending workflow runs", async () => {
    using tmp = new DisposableTempDir("workflow-runner-new-nonpending-missing-schema");
    const store = new WorkflowRunStore({
      sessionDir: tmp.path,
      staleLeaseMs: WORKFLOW_RUNNER_TEST_STALE_LEASE_MS,
    });
    await store.createRun({
      id: "wfr_new_nonpending_schema",
      workspaceId: "workspace-1",
      workflow: definition,
      source: `export default function workflow({ agent }) {
  const summary = agent("Missing schema", { id: "missing-schema" });
  return { reportMarkdown: summary };
}
`,
      args: {},
      now: "2026-05-29T00:00:00.000Z",
    });
    await store.appendStatus("wfr_new_nonpending_schema", "running", "2026-05-29T00:00:00.250Z");
    const runAgentSpecs: WorkflowAgentSpec[] = [];
    const runAgent = mock(async (spec: WorkflowAgentSpec) => {
      runAgentSpecs.push(spec);
      return {
        taskId: "task_1",
        reportMarkdown: "summary",
        structuredOutput: {},
      };
    });
    const runner = createRunner(store, { runAgent });

    await expect(runner.run("wfr_new_nonpending_schema")).resolves.toEqual({
      reportMarkdown: "summary",
    });
    expect(runAgentSpecs).toEqual([
      expect.objectContaining({ id: "missing-schema", markdownOnly: true }),
    ]);
  });

  test("backfills completed task events when replaying completed agent steps", async () => {
    using tmp = new DisposableTempDir("workflow-runner-completed-task-event-backfill");
    const store = await createRunStore(tmp.path);
    const spec = {
      id: "summarize-topic",
      prompt: "Summarize durable workflows",
      markdownOnly: true,
    };
    await store.recordStepCompleted("wfr_123", {
      stepId: spec.id,
      inputHash: hashWorkflowStepInput(spec.id, spec),
      taskId: "task_completed_missing_event",
      result: {
        taskId: "task_completed_missing_event",
        reportMarkdown: "summary",
        structuredOutput: {},
      },
      startedAt: "2026-05-29T00:00:00.500Z",
      completedAt: "2026-05-29T00:00:00.750Z",
    });
    await store.appendEvent("wfr_123", {
      sequence: 1,
      type: "task",
      at: "2026-05-29T00:00:00.500Z",
      stepId: spec.id,
      taskId: "task_completed_missing_event",
      status: "started",
    });
    let taskCalls = 0;
    const runner = createRunner(store, {
      async runAgent() {
        taskCalls += 1;
        throw new Error("agent should replay");
      },
    });

    await expect(runner.run("wfr_123")).resolves.toEqual({ reportMarkdown: "Final: summary" });
    const taskEvents = (await store.getRun("wfr_123")).events.filter(
      (event) => event.type === "task" && event.taskId === "task_completed_missing_event"
    );

    expect(taskCalls).toBe(0);
    expect(taskEvents).toEqual([
      expect.objectContaining({ status: "started" }),
      expect.objectContaining({ status: "completed" }),
    ]);
  });

  test("reuses a recorded started task id instead of respawning on resume", async () => {
    using tmp = new DisposableTempDir("workflow-runner");
    const store = await createRunStore(tmp.path);
    const spec = {
      id: "summarize-topic",
      prompt: "Summarize durable workflows",
      markdownOnly: true,
    };
    await store.recordStepStarted("wfr_123", {
      stepId: spec.id,
      inputHash: hashWorkflowStepInput(spec.id, spec),
      taskId: "task_existing",
      startedAt: "2026-05-29T00:00:00.500Z",
    });
    await store.appendEvent("wfr_123", {
      sequence: 1,
      type: "task",
      at: "2026-05-29T00:00:00.500Z",
      stepId: spec.id,
      taskId: "task_existing",
      status: "started",
    });
    let runAgentCalls = 0;
    const waitedFor: string[] = [];
    let waitTimeoutMs: number | undefined;
    let waitAbortSignal: AbortSignal | undefined;
    const runner = createRunner(store, {
      async runAgent() {
        runAgentCalls += 1;
        return { taskId: "task_duplicate", reportMarkdown: "duplicate", structuredOutput: {} };
      },
      async waitForAgentTask(taskId, _spec, waitOptions) {
        waitedFor.push(taskId);
        waitTimeoutMs = waitOptions?.timeoutMs;
        waitAbortSignal = waitOptions?.abortSignal;
        expect(waitAbortSignal?.aborted).toBe(false);
        return { taskId, reportMarkdown: "summary", structuredOutput: {} };
      },
    });

    await expect(runner.run("wfr_123")).resolves.toEqual({ reportMarkdown: "Final: summary" });

    expect(runAgentCalls).toBe(0);
    expect(waitedFor).toEqual(["task_existing"]);
    const startedEvents = (await store.getRun("wfr_123")).events.filter(
      (event) =>
        event.type === "task" && event.status === "started" && event.taskId === "task_existing"
    );
    expect(startedEvents).toHaveLength(1);
    expect(waitTimeoutMs).toBeGreaterThan(5 * 60 * 1000);
    expect(waitAbortSignal).toBeDefined();
  });

  test("adds one started task event when resuming legacy started steps", async () => {
    using tmp = new DisposableTempDir("workflow-runner-legacy-started-event");
    const store = await createRunStore(tmp.path);
    const spec = {
      id: "summarize-topic",
      prompt: "Summarize durable workflows",
      markdownOnly: true,
    };
    await store.recordStepStarted("wfr_123", {
      stepId: spec.id,
      inputHash: hashWorkflowStepInput(spec.id, spec),
      taskId: "task_legacy",
      startedAt: "2026-05-29T00:00:00.500Z",
    });
    const runner = createRunner(store, {
      async runAgent() {
        throw new Error("agent should not respawn");
      },
      async waitForAgentTask(taskId) {
        return { taskId, reportMarkdown: "summary", structuredOutput: {} };
      },
    });

    await expect(runner.run("wfr_123")).resolves.toEqual({ reportMarkdown: "Final: summary" });
    const startedEvents = (await store.getRun("wfr_123")).events.filter(
      (event) =>
        event.type === "task" && event.status === "started" && event.taskId === "task_legacy"
    );

    expect(startedEvents).toHaveLength(1);
  });

  test("reruns stale started task ids that no longer have recoverable reports", async () => {
    using tmp = new DisposableTempDir("workflow-runner");
    const store = await createRunStore(tmp.path);
    const spec = {
      id: "summarize-topic",
      prompt: "Summarize durable workflows",
      markdownOnly: true,
    };
    await store.recordStepStarted("wfr_123", {
      stepId: spec.id,
      inputHash: hashWorkflowStepInput(spec.id, spec),
      taskId: "task_missing",
      startedAt: "2026-05-29T00:00:00.500Z",
    });
    let runAgentCalls = 0;
    const waitedFor: string[] = [];
    const runner = createRunner(store, {
      async runAgent() {
        runAgentCalls += 1;
        return { taskId: "task_recovered", reportMarkdown: "summary", structuredOutput: {} };
      },
      async waitForAgentTask(taskId) {
        waitedFor.push(taskId);
        throw new Error("Task not found");
      },
    });

    await expect(runner.run("wfr_123")).resolves.toEqual({ reportMarkdown: "Final: summary" });
    const run = await store.getRun("wfr_123");

    expect(waitedFor).toEqual(["task_missing"]);
    expect(runAgentCalls).toBe(1);
    expect(run.steps.at(-1)).toMatchObject({
      stepId: "summarize-topic",
      status: "completed",
      taskId: "task_recovered",
    });
    expect(run.events).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          type: "task",
          stepId: "summarize-topic",
          taskId: "task_missing",
          status: "failed",
        }),
        expect.objectContaining({
          type: "task",
          stepId: "summarize-topic",
          taskId: "task_recovered",
          status: "completed",
        }),
      ])
    );
  });

  test("respawns stale started legacy markdown-only steps without outputSchema", async () => {
    using tmp = new DisposableTempDir("workflow-runner-legacy-stale-started-invalid-schema");
    const store = new WorkflowRunStore({
      sessionDir: tmp.path,
      staleLeaseMs: WORKFLOW_RUNNER_TEST_STALE_LEASE_MS,
    });
    await store.createRun({
      id: "wfr_legacy_stale_started_invalid_schema",
      workspaceId: "workspace-1",
      workflow: definition,
      source: `export default function workflow({ agent }) {
  const summary = agent("Summarize durable workflows", { id: "summarize-topic" });
  return { reportMarkdown: "Final: " + summary };
}
`,
      args: {},
      agentOutputSchemaRequired: false,
      now: "2026-05-29T00:00:00.000Z",
    });
    await store.appendStatus(
      "wfr_legacy_stale_started_invalid_schema",
      "running",
      "2026-05-29T00:00:00.250Z"
    );
    const legacySpec = {
      id: "summarize-topic",
      prompt: "Summarize durable workflows",
      markdownOnly: true,
    };
    await store.recordStepStarted("wfr_legacy_stale_started_invalid_schema", {
      stepId: legacySpec.id,
      inputHash: hashWorkflowStepInput(legacySpec.id, legacySpec),
      taskId: "task_legacy_missing",
      startedAt: "2026-05-29T00:00:00.500Z",
    });
    const waitedFor: string[] = [];
    const runner = createRunner(store, {
      async runAgent(spec) {
        expect(spec.outputSchema).toBeUndefined();
        return { taskId: "task_legacy_recovered", reportMarkdown: "summary" };
      },
      async waitForAgentTask(taskId) {
        waitedFor.push(taskId);
        throw new Error("Task not found");
      },
    });

    await expect(runner.run("wfr_legacy_stale_started_invalid_schema")).resolves.toEqual({
      reportMarkdown: "Final: summary",
    });
    expect(waitedFor).toEqual(["task_legacy_missing"]);
  });

  test("recovers stale started legacy markdown-only agent steps", async () => {
    using tmp = new DisposableTempDir("workflow-runner-legacy-stale-started");
    const store = new WorkflowRunStore({
      sessionDir: tmp.path,
      staleLeaseMs: WORKFLOW_RUNNER_TEST_STALE_LEASE_MS,
    });
    await store.createRun({
      id: "wfr_legacy_stale_started",
      workspaceId: "workspace-1",
      workflow: definition,
      source: `export default function workflow({ agent }) {
  const summary = agent("Summarize durable workflows", { id: "summarize-topic" });
  return { reportMarkdown: "Final: " + summary };
}
`,
      args: {},
      agentOutputSchemaRequired: false,
      now: "2026-05-29T00:00:00.000Z",
    });
    await store.appendStatus("wfr_legacy_stale_started", "running", "2026-05-29T00:00:00.250Z");
    const legacySpec = {
      id: "summarize-topic",
      prompt: "Summarize durable workflows",
      markdownOnly: true,
    };
    await store.recordStepStarted("wfr_legacy_stale_started", {
      stepId: legacySpec.id,
      inputHash: hashWorkflowStepInput(legacySpec.id, legacySpec),
      taskId: "task_legacy_missing",
      startedAt: "2026-05-29T00:00:00.500Z",
    });
    const waitedFor: string[] = [];
    let runAgentCalls = 0;
    const runner = createRunner(store, {
      async runAgent(spec) {
        runAgentCalls += 1;
        expect(spec.outputSchema).toBeUndefined();
        expect(spec.markdownOnly).toBe(true);
        return { taskId: "task_legacy_recovered", reportMarkdown: "summary" };
      },
      async waitForAgentTask(taskId) {
        waitedFor.push(taskId);
        throw new Error("Task not found");
      },
    });

    await expect(runner.run("wfr_legacy_stale_started")).resolves.toEqual({
      reportMarkdown: "Final: summary",
    });

    expect(waitedFor).toEqual(["task_legacy_missing"]);
    expect(runAgentCalls).toBe(1);
  });

  test("records failed task events when an agent task fails after creation", async () => {
    using tmp = new DisposableTempDir("workflow-runner-child-failure");
    const store = await createRunStore(tmp.path);
    const runner = createRunner(store, {
      async runAgent(_spec, lifecycle) {
        await lifecycle?.onTaskCreated?.("task_failed_after_create");
        throw new Error("child execution failed");
      },
    });

    await expect(runner.run("wfr_123")).rejects.toThrow("child execution failed");
    const taskEvents = (await store.getRun("wfr_123")).events.filter(
      (event) => event.type === "task" && event.taskId === "task_failed_after_create"
    );

    expect(taskEvents).toEqual([
      expect.objectContaining({ status: "started" }),
      expect.objectContaining({ status: "failed" }),
    ]);
  });

  test("restarts started task records when resuming a user-interrupted run", async () => {
    using tmp = new DisposableTempDir("workflow-runner");
    const store = await createRunStore(tmp.path);
    const spec = {
      id: "summarize-topic",
      prompt: "Summarize durable workflows",
      markdownOnly: true,
    };
    await store.recordStepStarted("wfr_123", {
      stepId: spec.id,
      inputHash: hashWorkflowStepInput(spec.id, spec),
      taskId: "task_interrupted",
      startedAt: "2026-05-29T00:00:00.500Z",
    });
    await store.appendStatus("wfr_123", "interrupted", "2026-05-29T00:00:00.750Z");
    let runAgentCalls = 0;
    const waitedFor: string[] = [];
    const runner = createRunner(store, {
      async runAgent() {
        runAgentCalls += 1;
        return { taskId: "task_restarted", reportMarkdown: "summary", structuredOutput: {} };
      },
      async waitForAgentTask(taskId) {
        waitedFor.push(taskId);
        throw new Error("interrupted task should not be awaited");
      },
    });

    await expect(runner.run("wfr_123", { allowResumeFromInterrupted: true })).resolves.toEqual({
      reportMarkdown: "Final: summary",
    });

    expect(runAgentCalls).toBe(1);
    expect(waitedFor).toEqual([]);
  });

  test("retries workflow agent steps that fail structured output validation", async () => {
    using tmp = new DisposableTempDir("workflow-runner");
    const store = new WorkflowRunStore({
      sessionDir: tmp.path,
      staleLeaseMs: WORKFLOW_RUNNER_TEST_STALE_LEASE_MS,
    });
    await store.createRun({
      id: "wfr_retry_validation",
      workspaceId: "workspace-1",
      workflow: definition,
      source: `export default function workflow({ agent }) {
        const result = agent("Extract claims", {
          id: "claims",
          schema: {
            type: "object",
            required: ["claims"],
            properties: { claims: { type: "array", items: { type: "string" } } },
            additionalProperties: false,
          },
        });
        return { reportMarkdown: result.claims.join(", ") };
      }`,
      args: {},
      now: "2026-05-29T00:00:00.000Z",
    });
    const prompts: string[] = [];
    const runner = createRunner(store, {
      async runAgent(spec) {
        prompts.push(spec.prompt);
        if (prompts.length === 1) {
          return { taskId: "task_bad", reportMarkdown: "bad", structuredOutput: {} };
        }
        return {
          taskId: "task_good",
          reportMarkdown: "good",
          structuredOutput: { claims: ["durable"] },
        };
      },
    });

    await expect(runner.run("wfr_retry_validation")).resolves.toEqual({
      reportMarkdown: "durable",
    });
    const run = await store.getRun("wfr_retry_validation");

    expect(prompts).toHaveLength(2);
    expect(prompts[1]).toContain("Previous workflow attempt 1 failed output validation");
    expect(run.status).toBe("completed");
    expect(run.steps).toEqual([
      expect.objectContaining({ stepId: "claims", status: "completed", taskId: "task_good" }),
    ]);
    expect(run.events).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ type: "validation", stepId: "claims", success: false }),
        expect.objectContaining({
          type: "task",
          stepId: "claims",
          taskId: "task_bad",
          status: "failed",
        }),
        expect.objectContaining({
          type: "task",
          stepId: "claims",
          taskId: "task_good",
          status: "completed",
        }),
        expect.objectContaining({
          type: "log",
          message: "Retrying claims after validation failure",
        }),
      ])
    );
  });

  test("stops retrying workflow agent validation after the maximum attempts", async () => {
    using tmp = new DisposableTempDir("workflow-runner");
    const store = new WorkflowRunStore({
      sessionDir: tmp.path,
      staleLeaseMs: WORKFLOW_RUNNER_TEST_STALE_LEASE_MS,
    });
    await store.createRun({
      id: "wfr_retry_exhausted",
      workspaceId: "workspace-1",
      workflow: definition,
      source: `export default function workflow({ agent }) {
        return agent("Extract claims", {
          id: "claims",
          schema: { type: "object", required: ["claims"], properties: { claims: { type: "array" } } },
        });
      }`,
      args: {},
      now: "2026-05-29T00:00:00.000Z",
    });
    let calls = 0;
    const runner = createRunner(store, {
      async runAgent() {
        calls += 1;
        return { taskId: `task_bad_${calls}`, reportMarkdown: "bad", structuredOutput: {} };
      },
    });

    await expect(runner.run("wfr_retry_exhausted")).rejects.toThrow(/structured output/);
    const run = await store.getRun("wfr_retry_exhausted");

    expect(calls).toBe(3);
    expect(run.status).toBe("failed");
    expect(run.steps).toEqual([
      expect.objectContaining({ stepId: "claims", status: "failed", taskId: "task_bad_3" }),
    ]);
    expect(
      run.events.filter(
        (event) => event.type === "task" && event.stepId === "claims" && event.status === "failed"
      )
    ).toHaveLength(3);
  });

  test("validates workflow agent structured output against requested schema", async () => {
    using tmp = new DisposableTempDir("workflow-runner");
    const store = new WorkflowRunStore({
      sessionDir: tmp.path,
      staleLeaseMs: WORKFLOW_RUNNER_TEST_STALE_LEASE_MS,
    });
    await store.createRun({
      id: "wfr_schema",
      workspaceId: "workspace-1",
      workflow: definition,
      source: `export default function workflow({ agent }) {
        return agent("Extract claims", {
          id: "claims",
          schema: {
            type: "object",
            required: ["claims"],
            properties: { claims: { type: "array", items: { type: "string" } } },
            additionalProperties: false,
          },
        });
      }`,
      args: {},
      now: "2026-05-29T00:00:00.000Z",
    });
    const runner = createRunner(store, {
      async runAgent() {
        return { taskId: "task_1", reportMarkdown: "bad", structuredOutput: { claims: [1] } };
      },
    });

    await expect(runner.run("wfr_schema")).rejects.toThrow(
      /structured output failed schema validation.*claims\[0\]/
    );
    const run = await store.getRun("wfr_schema");
    expect(run.steps).toEqual([
      expect.objectContaining({ stepId: "claims", status: "failed", taskId: "task_1" }),
    ]);
  });

  test("marks foreground-backgrounded agent waits as backgrounded runs", async () => {
    using tmp = new DisposableTempDir("workflow-runner");
    const store = await createRunStore(tmp.path);
    const runner = createRunner(store, {
      async runAgent() {
        throw new ForegroundWaitBackgroundedError();
      },
    });

    await expect(runner.run("wfr_123")).rejects.toBeInstanceOf(WorkflowRunBackgroundedError);
    await expect(store.getRun("wfr_123")).resolves.toMatchObject({ status: "backgrounded" });
  });

  test("applies sandbox limits before evaluating workflow source", async () => {
    using tmp = new DisposableTempDir("workflow-runner");
    const store = new WorkflowRunStore({
      sessionDir: tmp.path,
      staleLeaseMs: WORKFLOW_RUNNER_TEST_STALE_LEASE_MS,
    });
    await store.createRun({
      id: "wfr_limits",
      workspaceId: "workspace-1",
      workflow: definition,
      source: `export default function workflow() { return { reportMarkdown: "limited" }; }`,
      args: {},
      now: "2026-05-29T00:00:00.000Z",
    });
    let limitsApplied = false;
    let evalSawLimits = false;
    let timeoutMs: number | undefined;
    const noop = () => undefined;
    const runner = new WorkflowRunner({
      runStore: store,
      runtimeFactory: {
        async create() {
          return {
            setLimits(limits) {
              limitsApplied = true;
              timeoutMs = limits.timeoutMs;
            },
            registerFunction: noop,
            registerObject: noop,
            registerPromiseFunction: noop,
            registerSyncFunction: noop,
            setVarsProperty: noop,
            setKernelRecordBounds: noop,
            setCaptureResultSanitizer: noop,
            setPendingJobGate: noop,
            onEvent: noop,
            abort: noop,
            getAbortSignal() {
              return undefined;
            },
            takeActiveHostCallId() {
              return undefined;
            },
            async eval() {
              evalSawLimits = limitsApplied;
              return {
                success: true,
                result: { reportMarkdown: "limited" },
                toolCalls: [],
                consoleOutput: [],
                duration_ms: 0,
              };
            },
            dispose: noop,
            [Symbol.dispose]: noop,
          };
        },
      },
      taskAdapter: {
        async runAgent() {
          throw new Error("agent should not run");
        },
      },
      runnerId: "runner-a",
      clock: {
        nowIso: () => "2026-05-29T00:00:01.000Z",
        nowMs: () => 1_000,
      },
    });

    await expect(runner.run("wfr_limits")).resolves.toEqual({ reportMarkdown: "limited" });
    expect(timeoutMs).toBeGreaterThan(5 * 60 * 1000);
    expect(evalSawLimits).toBe(true);
  });

  test("supports async workflow function exports", async () => {
    using tmp = new DisposableTempDir("workflow-runner");
    const store = new WorkflowRunStore({
      sessionDir: tmp.path,
      staleLeaseMs: WORKFLOW_RUNNER_TEST_STALE_LEASE_MS,
    });
    await store.createRun({
      id: "wfr_async",
      workspaceId: "workspace-1",
      workflow: definition,
      source: `export default async function workflow() { return { reportMarkdown: "async ok" }; }`,
      args: {},
      now: "2026-05-29T00:00:00.000Z",
    });
    const runner = createRunner(store, {
      async runAgent() {
        throw new Error("agent should not run");
      },
    });

    await expect(runner.run("wfr_async")).resolves.toEqual({ reportMarkdown: "async ok" });
  });

  test("supports top-level named export declarations alongside the default export", async () => {
    using tmp = new DisposableTempDir("workflow-runner");
    const store = new WorkflowRunStore({
      sessionDir: tmp.path,
      staleLeaseMs: WORKFLOW_RUNNER_TEST_STALE_LEASE_MS,
    });
    await store.createRun({
      id: "wfr_named_exports",
      workspaceId: "workspace-1",
      workflow: definition,
      // Built-in workflows export pure helpers for direct unit testing; the
      // compiler must strip those export modifiers before script evaluation.
      source: [
        `export const GREETING = "named";`,
        `export class Exclaimer {`,
        `  render(value) { return value + "!"; }`,
        `}`,
        `export function exclaim(value) { return new Exclaimer().render(value); }`,
        `export async function emphasize(value) { return value.toUpperCase(); }`,
        `export default async function workflow() {`,
        `  return { reportMarkdown: await emphasize(exclaim(GREETING)) };`,
        `}`,
      ].join("\n"),
      args: {},
      now: "2026-05-29T00:00:00.000Z",
    });
    const runner = createRunner(store, {
      async runAgent() {
        throw new Error("agent should not run");
      },
    });

    await expect(runner.run("wfr_named_exports")).resolves.toEqual({ reportMarkdown: "NAMED!" });
  });

  test("returns the normalized workflow result for JSON-serializable values", async () => {
    using tmp = new DisposableTempDir("workflow-runner");
    const store = new WorkflowRunStore({
      sessionDir: tmp.path,
      staleLeaseMs: WORKFLOW_RUNNER_TEST_STALE_LEASE_MS,
    });
    await store.createRun({
      id: "wfr_normalized_return",
      workspaceId: "workspace-1",
      workflow: definition,
      source: `export default function workflow() { return { summary: "done" }; }`,
      args: {},
      now: "2026-05-29T00:00:00.000Z",
    });
    const runner = createRunner(store, {
      async runAgent() {
        throw new Error("agent should not run");
      },
    });

    await expect(runner.run("wfr_normalized_return")).resolves.toEqual({
      reportMarkdown: JSON.stringify({ summary: "done" }),
    });
  });

  test("marks empty workflow returns as failed runs", async () => {
    using tmp = new DisposableTempDir("workflow-runner");
    const store = new WorkflowRunStore({
      sessionDir: tmp.path,
      staleLeaseMs: WORKFLOW_RUNNER_TEST_STALE_LEASE_MS,
    });
    await store.createRun({
      id: "wfr_empty_return",
      workspaceId: "workspace-1",
      workflow: definition,
      source: `export default function workflow() {}`,
      args: {},
      now: "2026-05-29T00:00:00.000Z",
    });
    const runner = createRunner(store, {
      async runAgent() {
        throw new Error("agent should not run");
      },
    });

    await expect(runner.run("wfr_empty_return")).rejects.toThrow(/must return/);
    const run = await store.getRun("wfr_empty_return");
    expect(run.status).toBe("failed");
    expect(run.events.some((event) => event.type === "result")).toBe(false);
  });

  test("does not overwrite an interrupted run with completed status", async () => {
    using tmp = new DisposableTempDir("workflow-runner");
    const store = await createRunStore(tmp.path);
    let releaseAgent!: () => void;
    let runPromise!: Promise<unknown>;
    const agentStarted = new Promise<void>((resolve) => {
      const runner = createRunner(store, {
        async runAgent() {
          resolve();
          await new Promise<void>((release) => {
            releaseAgent = release;
          });
          return { taskId: "task_1", reportMarkdown: "late summary", structuredOutput: {} };
        },
      });
      runPromise = runner.run("wfr_123");
    });

    await agentStarted;
    await store.appendStatus("wfr_123", "interrupted", "2026-05-29T00:00:02.000Z");
    releaseAgent();
    await expect(runPromise).rejects.toThrow(/interrupted/);

    const run = await store.getRun("wfr_123");
    expect(run.status).toBe("interrupted");
    expect(run.events.some((event) => event.type === "result")).toBe(false);
  });

  test("marks compile failures as failed runs", async () => {
    using tmp = new DisposableTempDir("workflow-runner");
    const store = new WorkflowRunStore({
      sessionDir: tmp.path,
      staleLeaseMs: WORKFLOW_RUNNER_TEST_STALE_LEASE_MS,
    });
    await store.createRun({
      id: "wfr_compile_error",
      workspaceId: "workspace-1",
      workflow: definition,
      source: `export default () => ({ reportMarkdown: "bad shape" });`,
      args: {},
      now: "2026-05-29T00:00:00.000Z",
    });
    const runner = createRunner(store, {
      async runAgent() {
        throw new Error("agent should not run");
      },
    });

    await expect(runner.run("wfr_compile_error")).rejects.toThrow(/export a default function/);
    const run = await store.getRun("wfr_compile_error");
    expect(run.status).toBe("failed");
    expect(run.events.map((event) => event.type)).toContain("error");
  });

  test("fails fast when a replay-boundary primitive omits a stable id", async () => {
    using tmp = new DisposableTempDir("workflow-runner");
    const store = new WorkflowRunStore({
      sessionDir: tmp.path,
      staleLeaseMs: WORKFLOW_RUNNER_TEST_STALE_LEASE_MS,
    });
    await store.createRun({
      id: "wfr_missing_id",
      workspaceId: "workspace-1",
      workflow: definition,
      source: `export default function workflow({ agent }) { return agent("no id", {}); }`,
      args: {},
      now: "2026-05-29T00:00:00.000Z",
    });
    const runner = createRunner(store, {
      async runAgent() {
        throw new Error("agent should not run without a stable id");
      },
    });

    await expect(runner.run("wfr_missing_id")).rejects.toThrow(/stable id/);
  });

  test("exposes mux helpers without filesystem imports or timers to workflow code", async () => {
    using tmp = new DisposableTempDir("workflow-runner");
    const store = new WorkflowRunStore({
      sessionDir: tmp.path,
      staleLeaseMs: WORKFLOW_RUNNER_TEST_STALE_LEASE_MS,
    });
    await store.createRun({
      id: "wfr_forbidden",
      workspaceId: "workspace-1",
      workflow: definition,
      source: `export default function workflow() {
        return {
          mux: typeof mux,
          require: typeof require,
          setTimeout: typeof setTimeout,
          Date: typeof Date,
          random: typeof Math.random,
        };
      }`,
      args: {},
      now: "2026-05-29T00:00:00.000Z",
    });
    const runner = createRunner(store, {
      async runAgent() {
        throw new Error("agent should not run");
      },
    });

    const result = await runner.run("wfr_forbidden");

    expect(JSON.parse(result.reportMarkdown)).toEqual({
      mux: "object",
      require: "undefined",
      setTimeout: "undefined",
      Date: "undefined",
      random: "undefined",
    });
  });
});

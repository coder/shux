import { describe, expect, test } from "bun:test";

import type {
  WorkflowRunEvent,
  WorkflowRunRecord,
  WorkflowStepRecord,
} from "@/common/types/workflow";
import {
  getActiveWorkflowPhase,
  projectWorkflowRun,
  selectPrimaryWorkflowRun,
  type WorkflowStepUsage,
} from "./projectWorkflowRun";

const BASE = Date.parse("2026-06-23T14:31:00.000Z");
const at = (seconds: number): string => new Date(BASE + seconds * 1000).toISOString();

function makeRun(overrides: Partial<WorkflowRunRecord>): WorkflowRunRecord {
  return {
    id: "wfr_test",
    workspaceId: "ws-main",
    workflow: {
      name: "deep-research",
      description: "Fan out research, verify, synthesize.",
      scope: "built-in",
      sourcePath: "skill://deep-research/workflow.js",
      sourceKind: "skill",
      executable: true,
    },
    source: "export default function () {}",
    sourceHash: "sha256:test",
    args: { question: "What are the durability guarantees of JS workflows?" },
    status: "running",
    createdAt: at(0),
    updatedAt: at(74),
    events: [],
    steps: [],
    ...overrides,
  };
}

describe("planned stage argument projection", () => {
  test("preserves order, duplicate names, optional fields and the entire frozen input", () => {
    const stages = Object.freeze([
      Object.freeze({
        name: " foundation ",
        role: "Architect",
        brief: "Build the base",
        extra: 42,
      }),
      Object.freeze({ name: " foundation " }),
      Object.freeze({ name: "implement", role: undefined, brief: undefined }),
      Object.freeze({ name: "verify", role: "", brief: "" }),
    ] as const);
    const args = Object.freeze({ contract: "No regressions", stages });
    const run = makeRun({ args });
    const before = JSON.stringify(run);
    const view = projectWorkflowRun(run);
    expect(view.argEntries.map((entry) => entry.key)).toEqual(["contract", "stages"]);
    expect(view.argEntries[0]).toEqual({ key: "contract", value: args.contract });
    const entry = view.argEntries[1];
    expect(entry.stages?.map((stage) => stage.name)).toEqual(stages.map((stage) => stage.name));
    expect(entry.stages?.[0]).toEqual({
      name: stages[0].name,
      role: stages[0].role,
      brief: stages[0].brief,
    });
    expect(entry.value).toBe(JSON.stringify(stages));
    expect(run.args).toBe(args);
    expect(JSON.stringify(run)).toBe(before);
    expect(view.phases).toEqual([]);
    expect(view.stats.total).toBe(0);
  });

  test.each(
    [
      null,
      {},
      [],
      '[{"name":"foundation"}]',
      ["foundation"],
      [{ name: "valid" }, null],
      [{ name: "valid" }, []],
      [{ name: "valid" }, {}],
      [{ name: "valid" }, { name: "  " }],
      [{ name: "valid" }, { name: 123 }],
      [{ name: "valid" }, { name: "invalid", role: null }],
      [{ name: "invalid", role: 1 }],
      [{ name: "invalid", brief: null }],
      [{ name: "invalid", brief: [] }],
      Array.from({ length: 2 }, (_, index) => (index === 0 ? { name: "valid" } : undefined)),
      Object.assign(new Array<unknown>(2), { 0: { name: "valid" } }),
    ].map((stages) => ({ stages }))
  )("falls back for the entire unsupported value: %j", ({ stages }) => {
    const entry = projectWorkflowRun(makeRun({ args: { stages } })).argEntries[0];
    expect(entry).not.toHaveProperty("stages");
    expect(entry.value).toBe(
      stages == null ? "" : typeof stages === "string" ? stages : JSON.stringify(stages)
    );
  });

  test("does not specialize other keys or positional arrays", () => {
    const stages = [{ name: "foundation" }];
    const named = projectWorkflowRun(makeRun({ args: { steps: stages } }));
    const positional = projectWorkflowRun(makeRun({ args: stages }));
    expect(named.argEntries).toEqual([{ key: "steps", value: JSON.stringify(stages) }]);
    expect(positional.argEntries).toEqual([{ key: null, value: JSON.stringify(stages) }]);
  });
});

// A representative in-flight deep-research run: scope → search-fetch (fan-out)
// → verify (one still running) → synthesize (announced, no steps yet).
function makeRunningResearchRun(): WorkflowRunRecord {
  const events: WorkflowRunEvent[] = [
    { sequence: 1, type: "status", at: at(1), status: "running" },
    { sequence: 2, type: "phase", at: at(2), name: "Scope", details: "Decompose the question" },
    {
      sequence: 3,
      type: "task",
      at: at(2),
      stepId: "scope",
      taskId: "ws-scope",
      status: "started",
      title: "Scope research angles",
    },
    {
      sequence: 4,
      type: "task",
      at: at(14),
      stepId: "scope",
      taskId: "ws-scope",
      status: "completed",
      title: "Scope research angles",
    },
    { sequence: 5, type: "phase", at: at(15), name: "Search & Fetch" },
    {
      sequence: 6,
      type: "task",
      at: at(15),
      stepId: "search-1",
      taskId: "ws-search-1",
      status: "started",
      title: "Search: Broad overview",
    },
    {
      sequence: 7,
      type: "task",
      at: at(27),
      stepId: "search-1",
      taskId: "ws-search-1",
      status: "completed",
      title: "Search: Broad overview",
    },
    {
      sequence: 8,
      type: "task",
      at: at(28),
      stepId: "fetch-1a",
      taskId: "ws-fetch-1a",
      status: "started",
      title: "Fetch: arxiv.org",
    },
    {
      sequence: 9,
      type: "task",
      at: at(46),
      stepId: "fetch-1a",
      taskId: "ws-fetch-1a",
      status: "completed",
      title: "Fetch: arxiv.org",
    },
    { sequence: 10, type: "phase", at: at(53), name: "Verify" },
    {
      sequence: 11,
      type: "task",
      at: at(53),
      stepId: "verify-1",
      taskId: "ws-verify-1",
      status: "started",
      title: "Verify claim 1",
    },
    {
      sequence: 12,
      type: "task",
      at: at(74),
      stepId: "verify-1",
      taskId: "ws-verify-1",
      status: "completed",
      title: "Verify claim 1",
    },
    {
      sequence: 13,
      type: "task",
      at: at(53),
      stepId: "verify-2",
      taskId: "ws-verify-2",
      status: "started",
      title: "Verify claim 2",
    },
    // Synthesize phase announced before any of its steps start (pending phase).
    { sequence: 14, type: "phase", at: at(81), name: "Synthesize" },
  ];
  const steps: WorkflowStepRecord[] = [
    {
      stepId: "scope",
      inputHash: "h1",
      status: "completed",
      taskId: "ws-scope",
      startedAt: at(2),
      completedAt: at(14),
      result: {
        reportMarkdown: "5 angles",
        title: "5 research angles",
        structuredOutput: { angles: 5 },
      },
    },
    {
      stepId: "search-1",
      inputHash: "h2",
      status: "completed",
      taskId: "ws-search-1",
      startedAt: at(15),
      completedAt: at(27),
      result: { reportMarkdown: "6 results" },
    },
    {
      stepId: "fetch-1a",
      inputHash: "h3",
      status: "completed",
      taskId: "ws-fetch-1a",
      startedAt: at(28),
      completedAt: at(46),
      result: { reportMarkdown: "4 claims" },
    },
    {
      stepId: "verify-1",
      inputHash: "h4",
      status: "completed",
      taskId: "ws-verify-1",
      startedAt: at(53),
      completedAt: at(74),
      result: { reportMarkdown: "confirmed" },
    },
    {
      stepId: "verify-2",
      inputHash: "h5",
      status: "started",
      taskId: "ws-verify-2",
      startedAt: at(53),
    },
  ];
  return makeRun({ status: "running", events, steps, updatedAt: at(74) });
}

describe("projectWorkflowRun — phase grouping & step folding", () => {
  const view = projectWorkflowRun(makeRunningResearchRun());

  test("derives phases in declared order with labels from the phase name", () => {
    expect(view.phases.map((phase) => phase.name)).toEqual([
      "Scope",
      "Search & Fetch",
      "Verify",
      "Synthesize",
    ]);
    expect(view.phases.map((phase) => phase.label)).toEqual([
      "Scope",
      "Search & Fetch",
      "Verify",
      "Synthesize",
    ]);
    expect(view.phases[0].detail).toBe("Decompose the question");
    expect(view.phases[0].details).toBe("Decompose the question");
  });

  test("assigns each step to the phase current at its first task event", () => {
    const phaseOf = (stepId: string) =>
      view.steps.find((step) => step.stepId === stepId)?.phaseName;
    expect(phaseOf("scope")).toBe("Scope");
    expect(phaseOf("search-1")).toBe("Search & Fetch");
    expect(phaseOf("fetch-1a")).toBe("Search & Fetch");
    expect(phaseOf("verify-1")).toBe("Verify");
    expect(phaseOf("verify-2")).toBe("Verify");
  });

  test("counts done/observed per phase and flags a running phase", () => {
    const verify = view.phases.find((phase) => phase.name === "Verify");
    expect(verify).toMatchObject({ done: 1, total: 2, running: true, failed: false });
    expect(verify?.steps.map((step) => step.stepId)).toEqual(["verify-1", "verify-2"]);

    // Announced-but-empty phase: no steps observed yet, so total is 0 (not "planned").
    const synthesize = view.phases.find((phase) => phase.name === "Synthesize");
    expect(synthesize).toMatchObject({ done: 0, total: 0, running: false });
    expect(synthesize?.steps).toHaveLength(0);
  });

  test("maps the persisted 'started' status to 'running' and derives duration", () => {
    const scope = view.steps.find((step) => step.stepId === "scope");
    expect(scope?.status).toBe("completed");
    expect(scope?.durationMs).toBe(12_000);

    const verify2 = view.steps.find((step) => step.stepId === "verify-2");
    expect(verify2?.status).toBe("running");
    expect(verify2?.durationMs).toBeUndefined();
  });

  test("prefers the task-event title for each step", () => {
    expect(view.steps.find((step) => step.stepId === "fetch-1a")?.title).toBe("Fetch: arxiv.org");
  });

  test("exposes direct task event workspaces for row navigation", () => {
    const verify2 = view.steps.find((step) => step.stepId === "verify-2");

    expect(verify2?.taskId).toBe("ws-verify-2");
    expect(verify2?.taskWorkspaceId).toBe("ws-verify-2");
  });

  test("uses the current retried task id for row navigation", () => {
    const events: WorkflowRunEvent[] = [
      { sequence: 1, type: "phase", at: at(1), name: "Verify" },
      {
        sequence: 2,
        type: "task",
        at: at(1),
        stepId: "verify",
        taskId: "ws-verify-old",
        status: "started",
        title: "Verify claim",
      },
      {
        sequence: 3,
        type: "task",
        at: at(5),
        stepId: "verify",
        taskId: "ws-verify-old",
        status: "failed",
        title: "Verify claim",
      },
      {
        sequence: 4,
        type: "task",
        at: at(8),
        stepId: "verify",
        taskId: "ws-verify-new",
        status: "started",
        title: "Verify claim",
      },
    ];
    const steps: WorkflowStepRecord[] = [
      {
        stepId: "verify",
        inputHash: "h-new",
        status: "started",
        taskId: "ws-verify-new",
        startedAt: at(8),
      },
    ];

    const view = projectWorkflowRun(makeRun({ events, steps }));

    const verify = view.steps.find((step) => step.stepId === "verify");
    expect(verify?.taskId).toBe("ws-verify-new");
    expect(verify?.taskWorkspaceId).toBe("ws-verify-new");
  });

  test("aggregates run stats and arg entries", () => {
    expect(view.stats).toMatchObject({ total: 5, done: 4, running: 1, failed: 0 });
    expect(view.stats.elapsedMs).toBe(74_000);
    expect(view.argEntries).toEqual([
      { key: "question", value: "What are the durability guarantees of JS workflows?" },
    ]);
    expect(view.result).toBeNull();
  });
});

describe("projectWorkflowRun — phase details", () => {
  test("preserves a phase's structured details object for the expandable info panel", () => {
    const events: WorkflowRunEvent[] = [
      {
        sequence: 1,
        type: "phase",
        at: at(1),
        name: "search-fetch",
        details: { angleCount: 5, maxSources: 15 },
      },
      {
        sequence: 2,
        type: "task",
        at: at(1),
        stepId: "s1",
        taskId: "ws-s1",
        status: "started",
        title: "Search",
      },
    ];
    const steps: WorkflowStepRecord[] = [
      { stepId: "s1", inputHash: "h", status: "started", taskId: "ws-s1", startedAt: at(1) },
    ];
    const phase = projectWorkflowRun(makeRun({ events, steps })).phases.find(
      (candidate) => candidate.name === "search-fetch"
    );
    expect(phase?.details).toEqual({ angleCount: 5, maxSources: 15 });
    // A structured object yields no human-readable `detail` string.
    expect(phase?.detail).toBeUndefined();
  });
});

describe("projectWorkflowRun — non-task step events", () => {
  test("assigns phases to patch and nested-workflow steps, not only task steps", () => {
    const events: WorkflowRunEvent[] = [
      { sequence: 1, type: "phase", at: at(1), name: "apply" },
      {
        sequence: 2,
        type: "patch",
        at: at(1),
        stepId: "patch-1",
        sourceTaskId: "ws-src",
        status: "started",
      },
      {
        sequence: 3,
        type: "patch",
        at: at(4),
        stepId: "patch-1",
        sourceTaskId: "ws-src",
        status: "applied",
      },
      { sequence: 4, type: "phase", at: at(5), name: "delegate" },
      {
        sequence: 5,
        type: "workflow",
        at: at(5),
        stepId: "wf-1",
        runId: "wfr_child01",
        name: "deep-research",
        status: "started",
      },
    ];
    const steps: WorkflowStepRecord[] = [
      {
        stepId: "patch-1",
        inputHash: "h",
        status: "completed",
        taskId: "ws-src",
        startedAt: at(1),
        completedAt: at(4),
      },
      { stepId: "wf-1", inputHash: "h", status: "started", startedAt: at(5) },
    ];
    const view = projectWorkflowRun(makeRun({ events, steps }));

    // Steps recorded via patch/workflow events still land in the active phase (regression:
    // previously only task events seeded phase assignment, dropping these to "Other steps").
    expect(view.steps.find((step) => step.stepId === "patch-1")?.phaseName).toBe("apply");
    expect(view.steps.find((step) => step.stepId === "wf-1")?.phaseName).toBe("delegate");
    // Nested-workflow steps take their title from the child workflow name.
    expect(view.steps.find((step) => step.stepId === "wf-1")?.title).toBe("deep-research");
    expect(view.steps.find((step) => step.stepId === "wf-1")).toMatchObject({
      nestedWorkflowRunId: "wfr_child01",
      nestedWorkflowName: "deep-research",
      nestedWorkflowStatus: "started",
    });
    // Patch steps may store the source task id for persistence/usage, but only direct task
    // events represent a child workspace created by that row.
    const patchStep = view.steps.find((step) => step.stepId === "patch-1");
    expect(patchStep?.taskId).toBe("ws-src");
    expect(patchStep?.taskWorkspaceId).toBeUndefined();
    // Nothing falls into the implicit ungrouped bucket.
    expect(view.phases.some((phase) => phase.name === "")).toBe(false);
  });

  test("synthesizes a running step for reservation-only agent-step events", () => {
    const events: WorkflowRunEvent[] = [
      { sequence: 1, type: "phase", at: at(1), name: "branch-recon" },
      {
        sequence: 2,
        type: "agent-step",
        at: at(2),
        stepId: "branch-recon",
        inputHash: "h-reserving",
        status: "reserving",
        title: "Recon branch diff",
        details: { agentId: "explore", isolation: "none" },
      },
    ];

    const view = projectWorkflowRun(makeRun({ events, steps: [], updatedAt: at(4) }));

    expect(view.steps).toHaveLength(1);
    expect(view.steps[0]).toMatchObject({
      stepId: "branch-recon",
      status: "running",
      title: "Recon branch diff",
      phaseName: "branch-recon",
      startedAt: at(2),
    });
    expect(view.phases.find((phase) => phase.name === "branch-recon")).toMatchObject({
      total: 1,
      done: 0,
      running: true,
      failed: false,
    });
    expect(view.stats).toMatchObject({ total: 1, done: 0, running: 1, failed: 0 });
  });

  test("assigns repeated nested workflow ids to their matching step attempts", () => {
    const events: WorkflowRunEvent[] = [
      { sequence: 1, type: "phase", at: at(1), name: "delegate" },
      {
        sequence: 2,
        type: "workflow",
        at: at(2),
        stepId: "wf-repeat",
        runId: "wfr_child_first",
        name: "implementation-loop",
        status: "started",
      },
      {
        sequence: 3,
        type: "workflow",
        at: at(3),
        stepId: "wf-repeat",
        runId: "wfr_child_first",
        name: "implementation-loop",
        status: "completed",
      },
      {
        sequence: 4,
        type: "workflow",
        at: at(4),
        stepId: "wf-repeat",
        runId: "wfr_child_second",
        name: "implementation-loop",
        status: "started",
      },
    ];
    const steps: WorkflowStepRecord[] = [
      {
        stepId: "wf-repeat",
        inputHash: "h-first",
        status: "completed",
        startedAt: at(1),
        completedAt: at(4),
      },
      {
        stepId: "wf-repeat",
        inputHash: "h-second",
        status: "started",
        startedAt: at(4),
      },
    ];

    // The second child starts at the exact timestamp the first attempt completed; the end of
    // a completed attempt must be exclusive so the older row does not steal the newer child.
    const view = projectWorkflowRun(makeRun({ events, steps }));

    expect(view.steps.map((step) => step.nestedWorkflowRunId)).toEqual([
      "wfr_child_first",
      "wfr_child_second",
    ]);
    expect(view.steps.map((step) => step.nestedWorkflowStatus)).toEqual(["completed", "started"]);
  });
});

describe("projectWorkflowRun — title & result fallbacks", () => {
  test("falls back to result title, then stepId, when no task title exists", () => {
    const events: WorkflowRunEvent[] = [
      { sequence: 1, type: "phase", at: at(1), name: "Work" },
      // task events without a title (legacy events)
      { sequence: 2, type: "task", at: at(1), stepId: "a", taskId: "ws-a", status: "started" },
      { sequence: 3, type: "task", at: at(5), stepId: "a", taskId: "ws-a", status: "completed" },
      { sequence: 4, type: "task", at: at(1), stepId: "b", taskId: "ws-b", status: "started" },
    ];
    const steps: WorkflowStepRecord[] = [
      {
        stepId: "a",
        inputHash: "h",
        status: "completed",
        taskId: "ws-a",
        startedAt: at(1),
        completedAt: at(5),
        result: { reportMarkdown: "x", title: "Result A title" },
      },
      { stepId: "b", inputHash: "h", status: "started", taskId: "ws-b", startedAt: at(1) },
    ];
    const view = projectWorkflowRun(makeRun({ events, steps }));
    expect(view.steps.find((step) => step.stepId === "a")?.title).toBe("Result A title");
    expect(view.steps.find((step) => step.stepId === "b")?.title).toBe("b");
  });
});

describe("projectWorkflowRun — terminal states", () => {
  test("extracts the final report and surfaces a step failure", () => {
    const events: WorkflowRunEvent[] = [
      { sequence: 1, type: "phase", at: at(1), name: "Search & Fetch" },
      {
        sequence: 2,
        type: "task",
        at: at(1),
        stepId: "fetch",
        taskId: "ws-fetch",
        status: "started",
        title: "Fetch: ieee.org",
      },
      {
        sequence: 3,
        type: "task",
        at: at(8),
        stepId: "fetch",
        taskId: "ws-fetch",
        status: "failed",
        title: "Fetch: ieee.org",
      },
      { sequence: 4, type: "error", at: at(8), message: "web_fetch timed out after 30s" },
      { sequence: 5, type: "status", at: at(8), status: "failed" },
    ];
    const steps: WorkflowStepRecord[] = [
      {
        stepId: "fetch",
        inputHash: "h",
        status: "failed",
        taskId: "ws-fetch",
        startedAt: at(1),
        completedAt: at(8),
        error: "web_fetch timed out after 30s (ieee.org 403)",
      },
    ];
    const view = projectWorkflowRun(makeRun({ status: "failed", events, steps, updatedAt: at(8) }));

    expect(view.stats).toMatchObject({ total: 1, done: 0, failed: 1, running: 0 });
    expect(view.phases[0]).toMatchObject({ name: "Search & Fetch", failed: true });
    expect(view.steps[0]).toMatchObject({
      status: "failed",
      error: "web_fetch timed out after 30s (ieee.org 403)",
    });
    expect(view.errorMessage).toBe("web_fetch timed out after 30s");
    expect(view.result).toBeNull();
  });

  test("uses the last result event when several are present", () => {
    const events: WorkflowRunEvent[] = [
      { sequence: 1, type: "result", at: at(1), result: { reportMarkdown: "draft" } },
      {
        sequence: 2,
        type: "result",
        at: at(2),
        result: { reportMarkdown: "final", structuredOutput: { findings: 4 } },
      },
      { sequence: 3, type: "status", at: at(2), status: "completed" },
    ];
    const view = projectWorkflowRun(makeRun({ status: "completed", events, updatedAt: at(2) }));
    expect(view.result).toEqual({ reportMarkdown: "final", structuredOutput: { findings: 4 } });
  });
});

describe("projectWorkflowRun — phase-less & arg shapes", () => {
  test("renders steps in a single flat group when no phase was announced", () => {
    const events: WorkflowRunEvent[] = [
      {
        sequence: 1,
        type: "task",
        at: at(1),
        stepId: "only",
        taskId: "ws-only",
        status: "completed",
        title: "Do it",
      },
    ];
    const steps: WorkflowStepRecord[] = [
      {
        stepId: "only",
        inputHash: "h",
        status: "completed",
        taskId: "ws-only",
        startedAt: at(1),
        completedAt: at(3),
      },
    ];
    const view = projectWorkflowRun(makeRun({ events, steps }));
    expect(view.phases).toHaveLength(1);
    expect(view.phases[0]).toMatchObject({ name: "", label: "Steps" });
    expect(view.steps[0].phaseName).toBeNull();
  });

  test("represents a primitive positional arg as a single keyless entry", () => {
    const view = projectWorkflowRun(makeRun({ args: 3541 }));
    expect(view.argEntries).toEqual([{ key: null, value: "3541" }]);
  });

  test("represents an empty/absent arg object as no entries", () => {
    expect(projectWorkflowRun(makeRun({ args: {} })).argEntries).toEqual([]);
  });
});

describe("projectWorkflowRun — usage overlay", () => {
  test("attaches per-step usage by taskId and sums the run total", () => {
    const usageByTaskId = new Map<string, WorkflowStepUsage>([
      ["ws-scope", { tokens: 18_400, costUsd: 0.07 }],
      ["ws-verify-1", { tokens: 22_100, costUsd: 0.11 }],
    ]);
    const view = projectWorkflowRun(makeRunningResearchRun(), { usageByTaskId });

    expect(view.steps.find((step) => step.stepId === "scope")?.usage).toEqual({
      tokens: 18_400,
      costUsd: 0.07,
    });
    // A step whose task has no usage entry stays undefined.
    expect(view.steps.find((step) => step.stepId === "fetch-1a")?.usage).toBeUndefined();
    expect(view.stats.usage?.tokens).toBe(40_500);
    expect(view.stats.usage?.costUsd).toBeCloseTo(0.18, 5);
  });

  test("omits run usage entirely when no overlay is supplied", () => {
    expect(projectWorkflowRun(makeRunningResearchRun()).stats.usage).toBeUndefined();
  });
});

describe("selectPrimaryWorkflowRun", () => {
  const run = (id: string, status: WorkflowRunRecord["status"], updatedAt: string) => ({
    id,
    status,
    updatedAt,
  });

  test("prefers the most recently updated active run over terminal runs", () => {
    const runs = [
      run("done-recent", "completed", at(100)),
      run("running-old", "running", at(10)),
      run("bg-newer", "backgrounded", at(20)),
    ];
    expect(selectPrimaryWorkflowRun(runs)?.id).toBe("bg-newer");
  });

  test("falls back to the most recently updated run when none are active", () => {
    const runs = [run("old", "completed", at(10)), run("new", "failed", at(50))];
    expect(selectPrimaryWorkflowRun(runs)?.id).toBe("new");
  });

  test("returns null for an empty list", () => {
    expect(selectPrimaryWorkflowRun([])).toBeNull();
  });
});

describe("projectWorkflowRun — declared phase manifest", () => {
  const MANIFEST = {
    provenance: "declared" as const,
    phases: [
      { name: "scope", label: "Scope", description: "Pick angles" },
      { name: "verify", parallel: true },
      { name: "synthesize" },
    ],
  };

  function manifestRun(overrides: Partial<WorkflowRunRecord>): WorkflowRunRecord {
    const base = makeRun(overrides);
    return { ...base, workflow: { ...base.workflow, phaseManifest: MANIFEST } };
  }

  const phaseEvent = (sequence: number, name: string): WorkflowRunEvent => ({
    sequence,
    type: "phase",
    at: at(sequence),
    name,
  });

  test("seeds the full declared rail with lifecycle states mid-run", () => {
    const view = projectWorkflowRun(
      manifestRun({ events: [phaseEvent(1, "scope"), phaseEvent(2, "verify")] })
    );
    expect(view.phases.map((phase) => [phase.name, phase.lifecycle])).toEqual([
      ["scope", "completed"],
      ["verify", "running"],
      ["synthesize", "pending"],
    ]);
    // Declared display metadata applies without any observed detail.
    expect(view.phases[0]).toMatchObject({ label: "Scope", detail: "Pick angles" });
    expect(view.phases[1].parallel).toBe(true);
    expect(getActiveWorkflowPhase(view.phases)?.name).toBe("verify");
  });

  test("inserts dynamic phases after their anchor and head-anchors pre-declared ones", () => {
    const view = projectWorkflowRun(
      manifestRun({
        events: [
          phaseEvent(1, "bootstrap"),
          phaseEvent(2, "scope"),
          phaseEvent(3, "detour-a"),
          phaseEvent(4, "detour-b"),
          phaseEvent(5, "verify"),
        ],
      })
    );
    expect(view.phases.map((phase) => phase.name)).toEqual([
      "bootstrap",
      "scope",
      "detour-a",
      "detour-b",
      "verify",
      "synthesize",
    ]);
    expect(view.phases.map((phase) => phase.lifecycle)).toEqual([
      "completed",
      "completed",
      "completed",
      "completed",
      "running",
      "pending",
    ]);
  });

  test("a revisited dynamic phase re-anchors after the latest declared phase", () => {
    // scope → detour → verify → detour: the rail must show detour where the run
    // currently is (after verify), not where it was first seen.
    const view = projectWorkflowRun(
      manifestRun({
        events: [
          phaseEvent(1, "scope"),
          phaseEvent(2, "detour"),
          phaseEvent(3, "verify"),
          phaseEvent(4, "detour"),
        ],
      })
    );
    expect(view.phases.map((phase) => [phase.name, phase.lifecycle])).toEqual([
      ["scope", "completed"],
      ["verify", "completed"],
      ["detour", "running"],
      ["synthesize", "pending"],
    ]);
  });

  test("out-of-order declared visits keep manifest order; loop re-entry re-activates a phase", () => {
    const view = projectWorkflowRun(
      manifestRun({
        events: [
          phaseEvent(1, "verify"),
          phaseEvent(2, "scope"),
          // Loop back to verify: no error, verify becomes latest-visited again.
          phaseEvent(3, "verify"),
          // Replay-style consecutive duplicate must collapse into the same visit.
          phaseEvent(4, "verify"),
        ],
      })
    );
    expect(view.phases.map((phase) => [phase.name, phase.lifecycle])).toEqual([
      ["scope", "completed"],
      ["verify", "running"],
      ["synthesize", "pending"],
    ]);
  });

  test("active phase follows event order after a terminal loop re-entry", () => {
    // scope → verify → scope, then the run ends: `verify` sits later on the rail,
    // but the run's final position is `scope`.
    const view = projectWorkflowRun(
      manifestRun({
        status: "completed",
        events: [phaseEvent(1, "scope"), phaseEvent(2, "verify"), phaseEvent(3, "scope")],
      })
    );
    expect(view.phases.map((phase) => [phase.name, phase.latest])).toEqual([
      ["scope", true],
      ["verify", false],
      ["synthesize", false],
    ]);
    expect(getActiveWorkflowPhase(view.phases)?.name).toBe("scope");
  });

  test("active phase is the entered phase even while an earlier phase's step still runs", () => {
    // phase(scope); agent(...) still in flight; phase(verify) — rail order must not
    // regress the header to "phase 1/N" just because scope still has live work.
    const view = projectWorkflowRun(
      manifestRun({
        events: [
          phaseEvent(1, "scope"),
          {
            sequence: 2,
            type: "task",
            at: at(2),
            stepId: "s1",
            taskId: "t1",
            status: "started",
            title: "Background scope task",
          },
          phaseEvent(3, "verify"),
        ],
        steps: [
          { stepId: "s1", inputHash: "h", status: "started", taskId: "t1", startedAt: at(2) },
        ],
      })
    );
    expect(view.phases.map((phase) => [phase.name, phase.running, phase.lifecycle])).toEqual([
      ["scope", true, "completed"],
      ["verify", false, "running"],
      ["synthesize", false, "pending"],
    ]);
    expect(getActiveWorkflowPhase(view.phases)?.name).toBe("verify");
  });

  test("no active phase before the first phase event on a declared run", () => {
    // Pending / setup-failed declared runs seed an all-unvisited rail; a summary
    // must not claim the last manifest phase ("phase 3/3") for them.
    for (const status of ["pending", "running", "failed"] as const) {
      const view = projectWorkflowRun(manifestRun({ status, events: [] }));
      expect(getActiveWorkflowPhase(view.phases)).toBeNull();
    }
  });

  test("terminal completed run resolves unvisited declared phases to skipped", () => {
    const view = projectWorkflowRun(
      manifestRun({ status: "completed", events: [phaseEvent(1, "scope")] })
    );
    expect(view.phases.map((phase) => [phase.name, phase.lifecycle])).toEqual([
      ["scope", "completed"],
      ["verify", "skipped"],
      ["synthesize", "skipped"],
    ]);
  });

  test("failed and interrupted runs mark the latest-visited phase and not-reached tail", () => {
    const failed = projectWorkflowRun(
      manifestRun({ status: "failed", events: [phaseEvent(1, "scope"), phaseEvent(2, "verify")] })
    );
    expect(failed.phases.map((phase) => [phase.name, phase.lifecycle])).toEqual([
      ["scope", "completed"],
      ["verify", "failed"],
      ["synthesize", "not-reached"],
    ]);

    const interrupted = projectWorkflowRun(
      manifestRun({ status: "interrupted", events: [phaseEvent(1, "scope")] })
    );
    expect(interrupted.phases.map((phase) => [phase.name, phase.lifecycle])).toEqual([
      ["scope", "interrupted"],
      ["verify", "not-reached"],
      ["synthesize", "not-reached"],
    ]);
  });

  test("a failed step marks its phase failed even when the run keeps going", () => {
    const events: WorkflowRunEvent[] = [
      phaseEvent(1, "scope"),
      {
        sequence: 2,
        type: "task",
        at: at(2),
        stepId: "scope-step",
        taskId: "ws-scope",
        status: "started",
        title: "Scope",
      },
      phaseEvent(3, "verify"),
    ];
    const steps: WorkflowStepRecord[] = [
      {
        stepId: "scope-step",
        inputHash: "sha256:scope",
        status: "failed",
        taskId: "ws-scope",
        startedAt: at(2),
        completedAt: at(3),
        error: "boom",
      },
    ];
    const view = projectWorkflowRun(manifestRun({ events, steps }));
    expect(view.phases.map((phase) => [phase.name, phase.lifecycle])).toEqual([
      ["scope", "failed"],
      ["verify", "running"],
      ["synthesize", "pending"],
    ]);
  });

  test("inferred provenance resolves terminal-unvisited phases to neutral not-visited", () => {
    const base = makeRun({ status: "completed", events: [phaseEvent(1, "scope")] });
    const view = projectWorkflowRun({
      ...base,
      workflow: {
        ...base.workflow,
        phaseManifest: { ...MANIFEST, provenance: "inferred" },
      },
    });
    expect(view.phases.map((phase) => [phase.name, phase.lifecycle])).toEqual([
      ["scope", "completed"],
      ["verify", "not-visited"],
      ["synthesize", "not-visited"],
    ]);
  });

  test("manifest-less runs keep observed-only order and derive lifecycles", () => {
    const view = projectWorkflowRun(
      makeRun({ events: [phaseEvent(1, "alpha"), phaseEvent(2, "beta")] })
    );
    expect(view.phases.map((phase) => [phase.name, phase.lifecycle])).toEqual([
      ["alpha", "completed"],
      ["beta", "running"],
    ]);
  });

  test("manifest-less runs with no phase events summarize the implicit step bucket", () => {
    const view = projectWorkflowRun(
      makeRun({
        status: "completed",
        events: [],
        steps: [
          {
            stepId: "s1",
            inputHash: "h",
            status: "completed",
            taskId: "t1",
            startedAt: at(1),
            completedAt: at(2),
          },
        ],
      })
    );
    expect(view.phases.map((phase) => phase.name)).toEqual([""]);
    expect(getActiveWorkflowPhase(view.phases)?.label).toBe("Steps");
  });

  test("a running unphased step does not outrank the latest named phase", () => {
    // The "" bucket is unshifted to the front with lifecycle "running" while its
    // step is live; the header must still name the phase the run has entered.
    const view = projectWorkflowRun(
      manifestRun({
        events: [
          {
            sequence: 1,
            type: "task",
            at: at(1),
            stepId: "s0",
            taskId: "t0",
            status: "started",
            title: "Unphased warmup",
          },
          phaseEvent(2, "scope"),
        ],
        steps: [
          { stepId: "s0", inputHash: "h", status: "started", taskId: "t0", startedAt: at(1) },
        ],
      })
    );
    expect(view.phases.map((phase) => [phase.name, phase.lifecycle])).toEqual([
      ["", "running"],
      ["scope", "running"],
      ["verify", "pending"],
      ["synthesize", "pending"],
    ]);
    expect(getActiveWorkflowPhase(view.phases)?.name).toBe("scope");
  });
});

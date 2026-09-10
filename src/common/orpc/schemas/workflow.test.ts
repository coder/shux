import { describe, expect, test } from "bun:test";
import { EXPERIMENTS, EXPERIMENT_IDS } from "@/common/constants/experiments";
import { WorkflowTaskMetadataSchema } from "./workspace";
import {
  StructuredTaskOutputSchema,
  WorkflowDeclaredPhaseSchema,
  WorkflowPhaseManifestSchema,
  WorkflowScriptDescriptorSchema,
  WorkflowEventSequenceSchema,
  WorkflowNameSchema,
  WorkflowRunIdSchema,
  WorkflowRunRecordSchema,
  WorkflowRunStatusTransitionSchema,
} from "./workflow";

describe("workflow domain schemas", () => {
  test("accepts a durable workflow run record with ordered events", () => {
    const run = WorkflowRunRecordSchema.parse({
      id: "wfr_123",
      workspaceId: "workspace-1",
      workflow: {
        name: "deep-research",
        description: "Research a topic",
        scope: "built-in",
        executable: true,
      },
      source: "export default async function workflow() { return null; }",
      sourceHash: "sha256:abc123",
      args: { topic: "workflow replay" },
      status: "running",
      createdAt: "2026-05-29T00:00:00.000Z",
      updatedAt: "2026-05-29T00:00:01.000Z",
      events: [
        {
          sequence: 1,
          type: "status",
          at: "2026-05-29T00:00:00.000Z",
          status: "running",
        },
        {
          sequence: 2,
          type: "phase",
          at: "2026-05-29T00:00:01.000Z",
          name: "scope",
        },
        {
          sequence: 3,
          type: "agent-step",
          at: "2026-05-29T00:00:01.500Z",
          stepId: "reserve-child",
          inputHash: "sha256:reserve-child",
          status: "reserving",
          title: "Reserve child task",
          details: { agentId: "explore", isolation: "none" },
        },
        {
          sequence: 4,
          type: "patch",
          at: "2026-05-29T00:00:02.000Z",
          stepId: "apply-implementation",
          sourceTaskId: "task_impl",
          status: "applied",
          details: { taskId: "task_impl" },
        },
      ],
      steps: [],
    });

    expect(run.workflow.name).toBe("deep-research");
    expect(run.events.map((event) => event.sequence)).toEqual([1, 2, 3, 4]);
  });

  test("workflow run records default to no attentionPolicy and accept notify_on_terminal", () => {
    const baseRun = {
      id: "wfr_123",
      workspaceId: "workspace-1",
      workflow: { name: "deep-research", description: "x", scope: "built-in", executable: true },
      source: "export default async function workflow() { return null; }",
      sourceHash: "sha256:abc123",
      args: {},
      status: "running",
      createdAt: "2026-05-29T00:00:00.000Z",
      updatedAt: "2026-05-29T00:00:01.000Z",
      events: [],
      steps: [],
    };
    // Legacy record without the field still parses.
    expect(WorkflowRunRecordSchema.parse(baseRun).attentionPolicy).toBeUndefined();
    // Background runs persist notify_on_terminal.
    expect(
      WorkflowRunRecordSchema.parse({ ...baseRun, attentionPolicy: "notify_on_terminal" })
        .attentionPolicy
    ).toBe("notify_on_terminal");
    // Invalid policy values are rejected.
    expect(
      WorkflowRunRecordSchema.safeParse({ ...baseRun, attentionPolicy: "bogus" }).success
    ).toBe(false);
  });

  test("accepts plan file path metadata on structured task output", () => {
    const parsed = StructuredTaskOutputSchema.parse({
      taskId: "task-plan",
      title: "Proposed plan",
      reportMarkdown: "Plan content",
      planFilePath: "/tmp/mux/plans/repo/task-plan.md",
    });

    expect(parsed.planFilePath).toBe("/tmp/mux/plans/repo/task-plan.md");
  });

  test("rejects workflow run ids that could escape the run directory", () => {
    expect(WorkflowRunIdSchema.safeParse("wfr_123").success).toBe(true);
    expect(WorkflowRunIdSchema.safeParse("../wfr_123").success).toBe(false);
    expect(WorkflowRunIdSchema.safeParse("wfr_../escape").success).toBe(false);
    expect(WorkflowRunIdSchema.safeParse("task_123").success).toBe(false);
  });

  test("rejects invalid workflow names and non-executable untrusted descriptors", () => {
    expect(WorkflowNameSchema.safeParse("bad--name").success).toBe(false);
    expect(WorkflowNameSchema.safeParse("DeepResearch").success).toBe(false);

    const result = WorkflowScriptDescriptorSchema.safeParse({
      name: "local-workflow",
      description: "Project local workflow",
      scope: "project",
      executable: false,
      blockedReason: "Project is not trusted",
    });

    expect(result.success).toBe(true);
  });

  test("round-trips descriptors with a hydrated phase manifest and rejects malformed phases", () => {
    const descriptor = WorkflowScriptDescriptorSchema.parse({
      name: "deep-research",
      description: "Research a topic",
      scope: "built-in",
      executable: true,
      phaseManifest: {
        provenance: "declared",
        phases: [
          { name: "scope", label: "Scope", description: "Pick angles" },
          { name: "verify", parallel: true },
        ],
      },
    });
    expect(descriptor.phaseManifest?.phases.map((phase) => phase.name)).toEqual([
      "scope",
      "verify",
    ]);
    // Legacy records without the field still parse.
    expect(
      WorkflowScriptDescriptorSchema.safeParse({
        name: "deep-research",
        description: "Research a topic",
        scope: "built-in",
        executable: true,
      }).success
    ).toBe(true);

    // Strictness: unknown phase keys and empty manifests are rejected.
    expect(WorkflowDeclaredPhaseSchema.safeParse({ name: "scope", next: ["x"] }).success).toBe(
      false
    );
    expect(WorkflowDeclaredPhaseSchema.safeParse({ name: "" }).success).toBe(false);
    expect(
      WorkflowPhaseManifestSchema.safeParse({ provenance: "declared", phases: [] }).success
    ).toBe(false);
    expect(
      WorkflowPhaseManifestSchema.safeParse({
        provenance: "guessed",
        phases: [{ name: "scope" }],
      }).success
    ).toBe(false);
  });

  test("accepts inline workflow script descriptors as project-scoped provenance", () => {
    const result = WorkflowScriptDescriptorSchema.safeParse({
      name: "inline-abcdef123456",
      description: "Inline smoke test",
      scope: "project",
      sourcePath: "inline://workflow-abcdef123456.js",
      requestedScriptPath: "inline://workflow-abcdef123456.js",
      canonicalScriptPath: "inline://workflow-abcdef123456.js",
      sourceKind: "inline",
      sourceHash: "abcdef1234567890",
      executable: true,
    });

    expect(result.success).toBe(true);
  });

  test("rejects out-of-order events", () => {
    const result = WorkflowEventSequenceSchema.safeParse([
      { sequence: 2, type: "log", at: "2026-05-29T00:00:00.000Z", message: "late" },
      { sequence: 1, type: "log", at: "2026-05-29T00:00:01.000Z", message: "early" },
    ]);

    expect(result.success).toBe(false);
  });

  test("rejects impossible status transitions", () => {
    expect(
      WorkflowRunStatusTransitionSchema.safeParse({ from: "completed", to: "running" }).success
    ).toBe(false);
    expect(
      WorkflowRunStatusTransitionSchema.safeParse({ from: "running", to: "interrupted" }).success
    ).toBe(true);
  });
});

describe("workflow task metadata schema", () => {
  test("accepts workflow task metadata with an output schema", () => {
    const parsed = WorkflowTaskMetadataSchema.parse({
      runId: "wfr_123",
      stepId: "claims",
      outputSchema: { type: "object" },
    });

    expect(parsed).toEqual({
      runId: "wfr_123",
      stepId: "claims",
      outputSchema: { type: "object" },
    });
  });
});

describe("workflow experiment gate", () => {
  test("keeps dynamic workflows opt-in during rollout", () => {
    const experiment = EXPERIMENTS[EXPERIMENT_IDS.DYNAMIC_WORKFLOWS];

    expect(experiment.enabledByDefault).toBe(false);
    expect(experiment.showInSettings).toBe(true);
  });
});

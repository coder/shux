import { describe, expect, test } from "bun:test";

import type { WorkflowRunEvent, WorkflowRunRecord } from "@/common/types/workflow";
import { buildWorkflowProgressSummary, formatWorkflowProgressNote } from "./workflowProgress";

const DECLARED_SOURCE = `export const meta = {
  description: "Declared",
  phases: [{ name: "scope" }, { name: "verify" }, { name: "synthesize" }],
};
export default function workflow({ phase }) { return {}; }
`;

let hashCounter = 0;

function makeRun(source: string, phaseNames: string[]): WorkflowRunRecord {
  hashCounter += 1;
  const events: WorkflowRunEvent[] = phaseNames.map((name, index) => ({
    sequence: index + 1,
    type: "phase",
    at: `2026-05-29T00:00:0${index}.000Z`,
    name,
  }));
  return {
    id: "wfr_progress_test",
    workspaceId: "workspace-1",
    workflow: { name: "demo", description: "Demo", scope: "built-in", executable: true },
    source,
    sourceHash: `sha256:progress-${hashCounter}`,
    args: {},
    status: "running",
    createdAt: "2026-05-29T00:00:00.000Z",
    updatedAt: "2026-05-29T00:00:05.000Z",
    events,
    steps: [],
  };
}

describe("buildWorkflowProgressSummary declared phase position", () => {
  test("reports phaseIndex/declaredPhaseCount when the latest phase is declared", () => {
    const summary = buildWorkflowProgressSummary(makeRun(DECLARED_SOURCE, ["scope", "verify"]));
    expect(summary?.latestPhase).toEqual({
      name: "verify",
      at: "2026-05-29T00:00:01.000Z",
      phaseIndex: 2,
      declaredPhaseCount: 3,
    });
  });

  test("falls back to name-only when the latest phase is dynamic/undeclared", () => {
    const summary = buildWorkflowProgressSummary(
      makeRun(DECLARED_SOURCE, ["scope", "unexpected-detour"])
    );
    expect(summary?.latestPhase).toEqual({
      name: "unexpected-detour",
      at: "2026-05-29T00:00:01.000Z",
    });
  });

  test("inferred manifests never drive a phase fraction", () => {
    // No meta.phases: the alphabet is inferable, but source order is not a
    // trustworthy runtime order, so no phaseIndex may be reported.
    const inferredOnlySource = `export default function workflow({ phase }) {
  phase("scope"); phase("verify"); return {};
}
`;
    const summary = buildWorkflowProgressSummary(makeRun(inferredOnlySource, ["scope"]));
    expect(summary?.latestPhase).toEqual({ name: "scope", at: "2026-05-29T00:00:00.000Z" });
  });
});

describe("formatWorkflowProgressNote", () => {
  test("appends the declared position and omits it for dynamic phases", () => {
    expect(formatWorkflowProgressNote("Running.", makeRun(DECLARED_SOURCE, ["verify"]))).toBe(
      "Running. Latest phase: verify (2/3)."
    );
    expect(formatWorkflowProgressNote("Running.", makeRun(DECLARED_SOURCE, ["detour"]))).toBe(
      "Running. Latest phase: detour."
    );
  });
});

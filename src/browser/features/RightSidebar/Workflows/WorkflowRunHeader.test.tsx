import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { cleanup, fireEvent, render, within } from "@testing-library/react";

import { APIContext } from "@/browser/contexts/API";
import type { WorkflowRunRecord } from "@/common/types/workflow";
import { installDom } from "../../../../../tests/ui/dom";
import { getWorkflowRunRerunScriptPath, WorkflowRunHeader } from "./WorkflowRunHeader";
import { projectWorkflowRun } from "./projectWorkflowRun";

function makeRun(workflow: WorkflowRunRecord["workflow"]): WorkflowRunRecord {
  return {
    id: "wfr_test",
    workspaceId: "workspace-1",
    workflow,
    source: "export default function workflow() { return null; }",
    sourceHash: "sha256:test",
    args: {},
    status: "completed",
    createdAt: "2026-05-29T00:00:00.000Z",
    updatedAt: "2026-05-29T00:00:01.000Z",
    events: [],
    steps: [],
  };
}

describe("WorkflowRunHeader planned stages", () => {
  let cleanupDom: (() => void) | null = null;

  beforeEach(() => {
    cleanupDom = installDom();
  });

  afterEach(() => {
    cleanup();
    cleanupDom?.();
    cleanupDom = null;
  });

  function renderHeader(overrides: Partial<WorkflowRunRecord>) {
    const run = {
      ...makeRun({
        name: "staged-workflow",
        description: "Staged workflow",
        scope: "project",
        executable: true,
      }),
      ...overrides,
    };
    return render(
      <APIContext.Provider
        value={{
          status: "connecting",
          api: null,
          error: null,
          authenticate: () => undefined,
          retry: () => undefined,
        }}
      >
        <WorkflowRunHeader workspaceId={run.workspaceId} run={run} view={projectWorkflowRun(run)} />
      </APIContext.Provider>
    );
  }

  test.each(["unstarted", "first-phase", "terminal"])(
    "starts compact and retains all stage details independently of execution: %s",
    (state) => {
      const stages = [
        { name: "foundation", role: "Architect", brief: "Establish the baseline" },
        { name: "implementation", role: "Builder", brief: "Implement the change" },
        { name: "verification", role: "Reviewer", brief: "Check the result" },
      ];
      const { getByRole, container } = renderHeader({
        args: { contract: "Preserve existing behavior", stages },
        status: state === "terminal" ? "completed" : "running",
        events:
          state === "unstarted"
            ? []
            : [{ sequence: 1, type: "phase", at: "2026-05-29T00:00:00.000Z", name: "foundation" }],
      });
      const disclosure = container.querySelector("details");
      expect(disclosure).not.toBeNull();
      expect(disclosure!.open).toBe(false);
      const summary = disclosure!.querySelector("summary")!;
      stages.forEach((stage) => {
        expect(summary.textContent).toContain(stage.name);
        expect(summary.textContent).not.toContain(stage.role);
        expect(summary.textContent).not.toContain(stage.brief);
      });
      // Native disclosure interaction and CSS visibility are verified in Storybook/browser checks.
      disclosure!.open = true;
      const list = getByRole("list", { name: "Planned stages" });
      expect(disclosure!.contains(list)).toBe(true);
      expect(list.tagName).toBe("OL");
      const items = within(list).getAllByRole("listitem");
      expect(items).toHaveLength(stages.length);
      stages.forEach((stage, index) => {
        expect(items[index].textContent).toContain(stage.name);
        expect(items[index].textContent).toContain(stage.role);
        expect(items[index].textContent).toContain(stage.brief);
      });
      expect(container.textContent).toContain("Preserve existing behavior");
      expect(container.textContent).toContain("0/0 steps");
      expect(list.textContent).not.toMatch(/running|completed|pending/i);
      expect(disclosure!.querySelector("details")?.open).toBe(false);
    }
  );

  test("expands inert briefs and preserves unknown fields in original arguments", () => {
    const name = '<img src=x onerror="alert(1)">';
    const brief = `<script>alert(1)</script> ${"long brief ".repeat(60)}`;
    const stages = [Object.freeze({ name, role: "<b>Reviewer</b>", brief, extra: { keep: true } })];
    const { container, getByRole, getByLabelText } = renderHeader({
      args: Object.freeze({ stages: Object.freeze(stages) }),
    });
    const disclosure = container.querySelector("details");
    expect(disclosure).not.toBeNull();
    expect(disclosure!.querySelector("summary")!.textContent).toContain(name);
    disclosure!.open = true;
    const list = getByRole("list", { name: "Planned stages" });
    expect(list.textContent).toContain(name);
    expect(list.textContent).toContain("<b>Reviewer</b>");
    expect(list.textContent).not.toContain(brief);
    const expand = getByLabelText(`Show more of Stage 1: ${name}`);
    expect(expand.getAttribute("aria-expanded")).toBe("false");
    fireEvent.click(expand);
    expect(expand.getAttribute("aria-expanded")).toBe("true");
    expect(list.textContent).toContain(brief);
    fireEvent.click(expand);
    expect(list.textContent).not.toContain(brief);

    const raw = disclosure!.querySelector("details");
    expect(raw).not.toBeNull();
    // Native details keyboard behavior is covered in the real-browser story.
    raw!.open = true;
    fireEvent.click(getByLabelText("Show more of Argument: stages"));
    expect(raw!.textContent).toContain(JSON.stringify(stages));
    expect(container.querySelector("img, script, b")).toBeNull();
  });

  test("keeps the whole malformed array on the generic path", () => {
    const stages = [{ name: "valid", unknown: "preserved" }, { name: 123 }];
    const { container, queryByRole } = renderHeader({ args: { stages } });
    expect(queryByRole("list")).toBeNull();
    expect(container.querySelector("details")).toBeNull();
    expect(container.textContent).toContain(JSON.stringify(stages));
  });
});

describe("getWorkflowRunRerunScriptPath", () => {
  test("returns path-based workflow script paths", () => {
    expect(
      getWorkflowRunRerunScriptPath(
        makeRun({
          name: "local-workflow",
          description: "Local workflow",
          scope: "project",
          sourcePath: "./workflows/local.js",
          sourceKind: "workspace-file",
          executable: true,
        })
      )
    ).toBe("./workflows/local.js");
  });

  test("does not treat inline workflow provenance paths as rerunnable script paths", () => {
    expect(
      getWorkflowRunRerunScriptPath(
        makeRun({
          name: "inline-abcdef123456",
          description: "Inline workflow",
          scope: "project",
          sourcePath: "inline://workflow-abcdef123456.js",
          requestedScriptPath: "inline://workflow-abcdef123456.js",
          canonicalScriptPath: "inline://workflow-abcdef123456.js",
          sourceKind: "inline",
          executable: true,
        })
      )
    ).toBeNull();

    expect(
      getWorkflowRunRerunScriptPath(
        makeRun({
          name: "legacy-inline",
          description: "Legacy inline provenance",
          scope: "project",
          sourcePath: "inline://workflow-deadbeef.js",
          executable: true,
        })
      )
    ).toBeNull();
  });
});

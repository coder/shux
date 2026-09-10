import { afterEach, beforeEach, describe, expect, mock, test } from "bun:test";
import { cleanup, fireEvent, render } from "@testing-library/react";

import { installDom } from "../../../../../tests/ui/dom";
import type { WorkflowPhaseManifest } from "@/common/types/workflow";

import {
  WorkflowPhaseFlow,
  type WorkflowPhaseFlowNode,
  phaseFlowNodesFromManifest,
  phaseFlowNodesFromView,
  phaseNodeTooltip,
} from "./WorkflowPhaseFlow";
import type { WorkflowPhaseView } from "./projectWorkflowRun";

const MANIFEST: WorkflowPhaseManifest = {
  provenance: "declared",
  phases: [
    { name: "scope", label: "Scope", description: "Pick angles" },
    { name: "verify", parallel: true },
  ],
};

function phaseView(overrides: Partial<WorkflowPhaseView>): WorkflowPhaseView {
  return {
    name: "scope",
    label: "Scope",
    steps: [],
    done: 0,
    total: 0,
    running: false,
    failed: false,
    lifecycle: "pending",
    latest: false,
    ...overrides,
  };
}

describe("WorkflowPhaseFlow", () => {
  beforeEach(() => {
    installDom();
  });

  afterEach(() => {
    cleanup();
  });

  test("renders every node in order with a fan-out badge for parallel phases", () => {
    const rendered = render(
      <WorkflowPhaseFlow nodes={phaseFlowNodesFromManifest(MANIFEST)} provenance="declared" />
    );
    const items = rendered.getAllByRole("listitem");
    expect(items.map((item) => item.textContent)).toEqual(["Scope", "verify"]);
    expect(rendered.getByLabelText("Fan-out phase")).toBeTruthy();
    // Declared rails carry no provenance hint.
    expect(rendered.queryByText("inferred")).toBeNull();
  });

  test("inferred rails show the provenance hint", () => {
    const rendered = render(
      <WorkflowPhaseFlow
        nodes={[{ name: "a", label: "a", lifecycle: "not-visited" }]}
        provenance="inferred"
      />
    );
    expect(rendered.getByText("inferred")).toBeTruthy();
  });

  test("nodes are buttons only when a phase-select handler exists, and clicking selects", () => {
    const onSelect = mock(() => undefined);
    const nodes: WorkflowPhaseFlowNode[] = [
      { name: "scope", label: "Scope", lifecycle: "completed" },
    ];
    const withHandler = render(
      <WorkflowPhaseFlow nodes={nodes} provenance="declared" onPhaseSelect={onSelect} />
    );
    fireEvent.click(withHandler.getByRole("button"));
    expect(onSelect).toHaveBeenCalledWith("scope");
    cleanup();

    const withoutHandler = render(<WorkflowPhaseFlow nodes={nodes} provenance="declared" />);
    expect(withoutHandler.queryByRole("button")).toBeNull();
  });

  test("unvisited phases never become buttons — they have no timeline section to jump to", () => {
    const onSelect = mock(() => undefined);
    const rendered = render(
      <WorkflowPhaseFlow
        nodes={[
          { name: "scope", label: "Scope", lifecycle: "completed" },
          { name: "verify", label: "Verify", lifecycle: "running" },
          { name: "a", label: "Pending", lifecycle: "pending" },
          { name: "b", label: "Skipped", lifecycle: "skipped" },
          { name: "c", label: "Not reached", lifecycle: "not-reached" },
          { name: "d", label: "Not visited", lifecycle: "not-visited" },
        ]}
        provenance="declared"
        onPhaseSelect={onSelect}
      />
    );
    expect(rendered.getAllByRole("button").map((button) => button.textContent)).toEqual([
      "Scope",
      "Verify",
    ]);
    // Unvisited nodes still render as plain rail labels.
    expect(rendered.getByText("Skipped")).toBeTruthy();
  });

  test("non-interactive nodes expose their lifecycle as the accessible name", () => {
    // Unvisited nodes are not focusable, so the hover tooltip is unreachable for
    // keyboard/screen-reader users; the status must live in the accessible name.
    const rendered = render(
      <WorkflowPhaseFlow
        nodes={[
          { name: "a", label: "Scope", lifecycle: "completed" },
          { name: "b", label: "Verify", lifecycle: "skipped", description: "Adversarial pass" },
        ]}
        provenance="declared"
      />
    );
    expect(rendered.getByRole("img", { name: "Scope — Completed" })).toBeTruthy();
    expect(rendered.getByRole("img", { name: "Verify — Skipped — Adversarial pass" })).toBeTruthy();
  });

  test("each connector is grouped inside its following node's list item", () => {
    // flex-wrap can only break BETWEEN list items, so a connector that lives inside
    // the item it leads into can never be stranded at the end of a row.
    const rendered = render(
      <WorkflowPhaseFlow
        nodes={[
          { name: "a", label: "A", lifecycle: "completed" },
          { name: "b", label: "B", lifecycle: "running" },
          { name: "c", label: "C", lifecycle: "pending" },
        ]}
        provenance="declared"
      />
    );
    const items = rendered.getAllByRole("listitem");
    expect(items).toHaveLength(3);
    const connectorCounts = items.map(
      (item) => item.querySelectorAll(':scope > [aria-hidden="true"]').length
    );
    expect(connectorCounts).toEqual([0, 1, 1]);
    // No connector may sit directly in the list between items.
    expect(
      rendered.getByRole("list").querySelectorAll(':scope > [aria-hidden="true"]')
    ).toHaveLength(0);
  });

  test("the tooltip carries the full label so truncated pills stay readable", () => {
    // Pills are width-capped; a long label without a description would otherwise
    // be unreadable anywhere on the rail.
    const label = "a-very-long-phase-name-that-will-certainly-be-truncated-in-a-160px-pill";
    expect(phaseNodeTooltip({ name: "long", label, lifecycle: "pending" })).toBe(
      `${label} — Pending`
    );
    expect(
      phaseNodeTooltip({ name: "s", label: "Scope", lifecycle: "running", description: "Pick" })
    ).toBe("Scope — Running — Pick");
  });

  test("renders nothing for an empty node list", () => {
    const rendered = render(<WorkflowPhaseFlow nodes={[]} provenance="declared" />);
    expect(rendered.container.textContent).toBe("");
  });

  test("phaseFlowNodesFromView drops the implicit ungrouped bucket and keeps lifecycle metadata", () => {
    const nodes = phaseFlowNodesFromView([
      phaseView({ name: "", label: "Other steps", lifecycle: "completed" }),
      phaseView({ name: "verify", label: "verify", lifecycle: "running", parallel: true }),
      phaseView({ name: "synthesize", label: "synthesize", lifecycle: "skipped" }),
    ]);
    expect(nodes).toEqual([
      { name: "verify", label: "verify", lifecycle: "running", parallel: true },
      { name: "synthesize", label: "synthesize", lifecycle: "skipped" },
    ]);
  });
});

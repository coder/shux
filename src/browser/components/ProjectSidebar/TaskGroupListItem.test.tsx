import "../../../../tests/ui/dom";

import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { cleanup, render } from "@testing-library/react";
import { installDom } from "../../../../tests/ui/dom";
import type { TaskGroupListItem as TaskGroupListItemComponent } from "./TaskGroupListItem";

/* eslint-disable @typescript-eslint/no-require-imports */
const { TaskGroupListItem } = require("./TaskGroupListItem") as {
  TaskGroupListItem: typeof TaskGroupListItemComponent;
};
/* eslint-enable @typescript-eslint/no-require-imports */

function renderTaskGroup(overrides: Partial<React.ComponentProps<typeof TaskGroupListItem>> = {}) {
  return render(
    <TaskGroupListItem
      groupId="best-of-demo"
      title="Compare options"
      kind="bestOf"
      depth={1}
      totalCount={3}
      visibleCount={3}
      completedCount={0}
      runningCount={0}
      queuedCount={0}
      interruptedCount={0}
      isExpanded={false}
      isSelected={false}
      onToggle={() => undefined}
      {...overrides}
    />
  );
}

describe("TaskGroupListItem", () => {
  let cleanupDom: (() => void) | null = null;

  beforeEach(() => {
    cleanupDom = installDom();
  });

  afterEach(() => {
    cleanup();
    cleanupDom?.();
    cleanupDom = null;
  });

  test("marks groups with running members as in progress", () => {
    const view = renderTaskGroup({ runningCount: 2, queuedCount: 1 });

    const groupRow = view.getByTestId("task-group-best-of-demo");

    expect(groupRow.dataset.running).toBe("true");
    const descriptionId = groupRow.getAttribute("aria-describedby");
    expect(descriptionId).toBe("task-group-status-best-of-demo");
    expect(document.getElementById(descriptionId ?? "")?.textContent).toContain("2 running");
    expect(view.getByTestId("task-group-status-icon").className).toContain("text-content-success");
    expect(groupRow.textContent).toContain("2 running");
  });

  test("does not paint running groups with the selected background", () => {
    const running = renderTaskGroup({ runningCount: 1, isRunActive: true });
    expect(
      running.getByTestId("task-group-best-of-demo").classList.contains("bg-surface-secondary")
    ).toBe(false);
    cleanup();

    const selected = renderTaskGroup({ isSelected: true });
    expect(
      selected.getByTestId("task-group-best-of-demo").classList.contains("bg-surface-secondary")
    ).toBe(true);
  });

  test("keeps queued-only groups pending instead of active", () => {
    const view = renderTaskGroup({ queuedCount: 1 });

    const groupRow = view.getByTestId("task-group-best-of-demo");

    expect(groupRow.dataset.running).toBe("false");
    expect(view.getByTestId("task-group-status-icon").className).not.toContain(
      "text-content-success"
    );
    expect(groupRow.textContent).toContain("1 queued");
  });

  test("aggregates member state into the shared status-dot language", () => {
    // Running wins over interrupted: the group is still making progress.
    const running = renderTaskGroup({ runningCount: 1, interruptedCount: 1 });
    expect(running.getByTestId("task-group-best-of-demo").dataset.aggregateState).toBe("active");
    cleanup();

    const interrupted = renderTaskGroup({ interruptedCount: 1, completedCount: 2 });
    expect(interrupted.getByTestId("task-group-best-of-demo").dataset.aggregateState).toBe("error");
    cleanup();

    const completed = renderTaskGroup({ completedCount: 3 });
    expect(completed.getByTestId("task-group-best-of-demo").dataset.aggregateState).toBe("idle");
  });
});

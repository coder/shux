import { describe, expect, it } from "bun:test";

import {
  buildTaskGroupLaunches,
  formatTaskGroupHeader,
  formatTaskGroupMemberLabel,
  formatTaskGroupSummary,
  getTaskGroupCount,
} from "./taskGroups";

describe("taskGroups", () => {
  it("defaults omitted task grouping to one candidate", () => {
    expect(getTaskGroupCount({})).toBe(1);
  });

  it("builds repeated best-of launches with the shared prompt", () => {
    expect(buildTaskGroupLaunches({ prompt: "compare options", n: 3 })).toEqual([
      { index: 0, total: 3, prompt: "compare options" },
      { index: 1, total: 3, prompt: "compare options" },
      { index: 2, total: 3, prompt: "compare options" },
    ]);
  });

  it("formats best-of group copy", () => {
    expect(formatTaskGroupSummary(3)).toBe("Best of 3");
    expect(formatTaskGroupHeader(3, "Compare options")).toBe("Best of 3 · Compare options");
    expect(formatTaskGroupMemberLabel(2)).toBe("candidate 3");
  });
});

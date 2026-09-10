import { describe, expect, test } from "bun:test";
import { formatTerminalBadge } from "./terminalBadgeTemplate";

const vars = { workspace: "fix-badge", project: "xum", tab: "Terminal 2", index: "2" };

describe("formatTerminalBadge", () => {
  test("substitutes workspace, project, tab, and index tokens", () => {
    expect(formatTerminalBadge("{workspace} · {tab}", vars)).toBe("fix-badge · Terminal 2");
    expect(formatTerminalBadge("{project}/{workspace}", vars)).toBe("xum/fix-badge");
    expect(formatTerminalBadge("{workspace} #{index}", vars)).toBe("fix-badge #2");
  });

  test("unknown index expands to empty and trims away", () => {
    expect(formatTerminalBadge("{workspace} {index}", { ...vars, index: "" })).toBe("fix-badge");
  });

  test("substitutes repeated tokens", () => {
    expect(formatTerminalBadge("{tab} {tab}", vars)).toBe("Terminal 2 Terminal 2");
  });

  test("preserves unknown tokens", () => {
    expect(formatTerminalBadge("{workspace} {nope}", vars)).toBe("fix-badge {nope}");
  });

  test("trims surrounding whitespace so empty expansions collapse", () => {
    expect(formatTerminalBadge("  {tab}  ", vars)).toBe("Terminal 2");
    expect(formatTerminalBadge(" {workspace} ", { ...vars, workspace: "" })).toBe("");
  });

  test("empty template yields empty string", () => {
    expect(formatTerminalBadge("", vars)).toBe("");
  });
});

import { describe, expect, test } from "bun:test";
import type { AgentSkillDescriptor } from "@/common/types/agentSkill";
import type { SlashSuggestion } from "@/browser/utils/slashCommands/types";
import {
  applyComposerSuggestion,
  detectActiveComposerToken,
  getSynchronousComposerSuggestions,
} from "./useComposerSuggestions";

const context = {
  agentSkills: [
    { name: "deep-review", description: "Review code", scope: "global" },
  ] satisfies AgentSkillDescriptor[],
  mcpPrompts: [],
  pluginCommands: [],
  variant: "workspace" as const,
  experiments: {
    workspaceHeartbeats: false,
    dynamicWorkflows: false,
    memory: false,
    memoryConsolidation: false,
    rlm: false,
    programmaticToolCalling: false,
  },
};
const suggestion = (replacement: string): SlashSuggestion => ({
  id: replacement,
  display: replacement,
  description: "",
  replacement,
});

describe("composer suggestion seams", () => {
  test.each([
    ["/ask @src/fo", 12, "file", "src/fo"],
    ["/ask $deep", 10, "inline", "deep"],
    [String.raw`/ask \alp`, 9, "symbol", "alp"],
    ["/clear", 6, "slash", "/clear"],
    ["plain text", 10, null, null],
  ] as const)("detects the active token in %s", (input, cursor, kind, query) => {
    const token = detectActiveComposerToken(input, cursor);
    expect([token?.kind ?? null, token?.query ?? null]).toEqual([kind, query]);
  });

  test.each([
    ["$deep", 5, "$deep-review"],
    [String.raw`\alpha`, 6, String.raw`\alpha`],
    ["/cl", 3, "/clear"],
  ] as const)("derives matches for %s during render", (input, cursor, expected) => {
    const token = detectActiveComposerToken(input, cursor);
    expect(
      getSynchronousComposerSuggestions(token, context).map(({ display }) => display)
    ).toContain(expected);
  });

  test.each([
    ["see @sr now", 7, "@src/file.ts", "see @src/file.ts  now", 17],
    ["use $de, now", 7, "$deep-review", "use $deep-review, now", 16],
    [String.raw`x \alp2`, 6, "α", "x α2", 3],
    ["/cl", 3, "/clear", "/clear", 6],
  ] as const)("applies a selection for %s", (input, cursor, replacement, expected, nextCursor) => {
    const token = detectActiveComposerToken(input, cursor);
    if (!token) throw new Error("expected active token");
    expect(applyComposerSuggestion(input, token, suggestion(replacement))).toEqual({
      input: expected,
      cursor: nextCursor,
    });
  });
});

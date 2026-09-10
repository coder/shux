import { describe, expect, test } from "bun:test";
import type { APIClient } from "@/browser/contexts/API";
import type { AgentSkillDescriptor } from "@/common/types/agentSkill";
import {
  extractInlineSkillReferenceCandidates,
  findInlineSkillReferenceAtCursor,
  resolveInlineSkillReferences,
  type InlineSkillCandidate,
} from "./inlineSkillReferences";

type AgentSkillsGetInput = Parameters<APIClient["agentSkills"]["get"]>[0];
type AgentSkillsGetOutput = Awaited<ReturnType<APIClient["agentSkills"]["get"]>>;

function descriptor(
  name: string,
  scope: AgentSkillDescriptor["scope"] = "global"
): AgentSkillDescriptor {
  return { name, description: `${name} description`, scope };
}

function candidate(skillName: string, startIndex = 0): InlineSkillCandidate {
  return { skillName, startIndex, endIndex: startIndex + skillName.length + 1 };
}

function skillPackage(
  name: string,
  scope: AgentSkillDescriptor["scope"] = "global"
): AgentSkillsGetOutput {
  return {
    scope,
    directoryName: name,
    frontmatter: { name, description: `${name} description` },
    body: `${name} body`,
  };
}

function apiClient(get: APIClient["agentSkills"]["get"]): APIClient {
  return { agentSkills: { get } } as unknown as APIClient;
}

describe("extractInlineSkillReferenceCandidates", () => {
  test("returns an empty list for empty input", () => {
    expect(extractInlineSkillReferenceCandidates("")).toEqual([]);
  });

  test("extracts a single skill reference", () => {
    expect(extractInlineSkillReferenceCandidates("Use $tdd")).toEqual([
      { skillName: "tdd", startIndex: 4, endIndex: 8 },
    ]);
  });

  test("extracts multiple skill references in order", () => {
    expect(extractInlineSkillReferenceCandidates("$tdd and $deep-review")).toEqual([
      { skillName: "tdd", startIndex: 0, endIndex: 4 },
      { skillName: "deep-review", startIndex: 9, endIndex: 21 },
    ]);
  });

  test("extracts normalized MCP prompt references with underscores", () => {
    expect(extractInlineSkillReferenceCandidates("Use $mcp__coder__review")).toEqual([
      { skillName: "mcp__coder__review", startIndex: 4, endIndex: 23 },
    ]);
  });

  test("keeps duplicate parser candidates", () => {
    expect(extractInlineSkillReferenceCandidates("$tdd $tdd")).toEqual([
      { skillName: "tdd", startIndex: 0, endIndex: 4 },
      { skillName: "tdd", startIndex: 5, endIndex: 9 },
    ]);
  });

  test("accepts punctuation boundaries", () => {
    expect(extractInlineSkillReferenceCandidates("($tdd) $tdd, $tdd.")).toEqual([
      { skillName: "tdd", startIndex: 1, endIndex: 5 },
      { skillName: "tdd", startIndex: 7, endIndex: 11 },
      { skillName: "tdd", startIndex: 13, endIndex: 17 },
    ]);
  });

  test("rejects unsupported token starts and left boundaries", () => {
    expect(extractInlineSkillReferenceCandidates("foo$tdd")).toEqual([]);
    expect(extractInlineSkillReferenceCandidates("$100")).toEqual([]);
    expect(extractInlineSkillReferenceCandidates("$PATH")).toEqual([]);
    expect(extractInlineSkillReferenceCandidates("$-bad")).toEqual([]);
  });

  test("strips one trailing hyphen before validation", () => {
    expect(extractInlineSkillReferenceCandidates("$bad-")).toEqual([
      { skillName: "bad", startIndex: 0, endIndex: 4 },
    ]);
  });

  test("skips inline code spans", () => {
    expect(extractInlineSkillReferenceCandidates("use `$tdd` here")).toEqual([]);
  });

  test("skips double-backtick inline code spans", () => {
    expect(extractInlineSkillReferenceCandidates("use ``$tdd`` here")).toEqual([]);
  });

  test("skips triple-backtick inline code spans", () => {
    expect(extractInlineSkillReferenceCandidates("use ```$tdd``` here")).toEqual([]);
  });

  test("skips multi-backtick inline code containing shorter backtick runs", () => {
    expect(
      extractInlineSkillReferenceCandidates("``code with `single` backtick `$tdd` ``")
    ).toEqual([]);
  });

  test("skips unterminated multi-backtick spans conservatively", () => {
    expect(extractInlineSkillReferenceCandidates("``$tdd`")).toEqual([]);
  });

  test("extracts references between inline code spans", () => {
    expect(extractInlineSkillReferenceCandidates("`a` $tdd `b`")).toEqual([
      { skillName: "tdd", startIndex: 4, endIndex: 8 },
    ]);
  });

  test("skips fenced code blocks", () => {
    expect(extractInlineSkillReferenceCandidates("```\n$tdd\n```")).toEqual([]);
  });

  test("keeps fenced code blocks open when a candidate closer has trailing text", () => {
    const text = "```\n```notclosing\n$tdd\n```";

    expect(extractInlineSkillReferenceCandidates(text)).toEqual([]);
  });

  test("closes fenced code blocks when the closing marker has trailing spaces and tabs", () => {
    const text = "```\n$inside\n``` \t  \n$outside";
    const outsideIndex = text.indexOf("$outside");

    expect(extractInlineSkillReferenceCandidates(text)).toEqual([
      {
        skillName: "outside",
        startIndex: outsideIndex,
        endIndex: outsideIndex + "$outside".length,
      },
    ]);
  });

  test("skips fenced code blocks indented up to three spaces", () => {
    for (const indentation of [" ", "  ", "   "]) {
      expect(
        extractInlineSkillReferenceCandidates(`${indentation}\`\`\`\n$tdd\n${indentation}\`\`\``)
      ).toEqual([]);
    }
  });

  test("extracts references when code fence markers are indented four spaces", () => {
    const text = "    ```\n$tdd\n    ```";
    const tddIndex = text.indexOf("$tdd");

    expect(extractInlineSkillReferenceCandidates(text)).toEqual([
      { skillName: "tdd", startIndex: tddIndex, endIndex: tddIndex + "$tdd".length },
    ]);
  });

  test("closes fenced code blocks with an indented closing marker", () => {
    const text = "```\n$tdd\n  ```\n$outside";
    const outsideIndex = text.indexOf("$outside");

    expect(extractInlineSkillReferenceCandidates(text)).toEqual([
      {
        skillName: "outside",
        startIndex: outsideIndex,
        endIndex: outsideIndex + "$outside".length,
      },
    ]);
  });

  test("skips tilde fenced code blocks", () => {
    expect(extractInlineSkillReferenceCandidates("~~~ts\n$tdd\n~~~")).toEqual([]);
  });

  test("skips longer tilde fenced code blocks", () => {
    expect(extractInlineSkillReferenceCandidates("~~~~\n$tdd\n~~~~")).toEqual([]);
  });

  test("keeps mismatched tilde fences inside backtick fences", () => {
    const text = "```\n$tdd\n~~~\n$deep-review\n```\n$outside";
    const outsideIndex = text.indexOf("$outside");

    expect(extractInlineSkillReferenceCandidates(text)).toEqual([
      {
        skillName: "outside",
        startIndex: outsideIndex,
        endIndex: outsideIndex + "$outside".length,
      },
    ]);
  });

  test("extracts non-code references from mixed text", () => {
    expect(extractInlineSkillReferenceCandidates("$tdd `$nope` $deep-review")).toEqual([
      { skillName: "tdd", startIndex: 0, endIndex: 4 },
      { skillName: "deep-review", startIndex: 13, endIndex: 25 },
    ]);
  });
});

describe("findInlineSkillReferenceAtCursor", () => {
  test("finds a partial skill reference at the end of input", () => {
    expect(findInlineSkillReferenceAtCursor("Use $td", 7)).toEqual({
      partial: "td",
      startIndex: 4,
      endIndex: 7,
    });
  });

  test("finds an empty partial after a bare dollar sign", () => {
    expect(findInlineSkillReferenceAtCursor("$", 1)).toEqual({
      partial: "",
      startIndex: 0,
      endIndex: 1,
    });
  });

  test("finds the active token when the cursor is inside the skill name", () => {
    expect(findInlineSkillReferenceAtCursor("Use $tdd more", 6)).toEqual({
      partial: "tdd",
      startIndex: 4,
      endIndex: 8,
    });
  });

  test("returns null when the cursor is out of bounds", () => {
    expect(findInlineSkillReferenceAtCursor("$tdd", -1)).toBeNull();
    expect(findInlineSkillReferenceAtCursor("$tdd", 5)).toBeNull();
  });

  test("returns null when the cursor is inside inline code", () => {
    const text = "use `$td` here";
    expect(findInlineSkillReferenceAtCursor(text, text.indexOf("$td") + 3)).toBeNull();
  });

  test("returns null when the cursor is inside a fenced code block", () => {
    const text = "```\n$td\n```";
    expect(findInlineSkillReferenceAtCursor(text, text.indexOf("$td") + 3)).toBeNull();
  });
});

describe("resolveInlineSkillReferences", () => {
  test("returns an empty list for empty candidates", async () => {
    expect(
      await resolveInlineSkillReferences({
        candidates: [],
        agentSkillDescriptors: [descriptor("tdd")],
        api: null,
        discovery: null,
      })
    ).toEqual([]);
  });

  test("resolves known local descriptors", async () => {
    expect(
      await resolveInlineSkillReferences({
        candidates: [candidate("tdd")],
        agentSkillDescriptors: [descriptor("tdd", "project")],
        api: null,
        discovery: null,
      })
    ).toEqual([{ skillName: "tdd", scope: "project", source: "inline" }]);
  });

  test("collapses duplicate candidates", async () => {
    expect(
      await resolveInlineSkillReferences({
        candidates: [candidate("tdd"), candidate("tdd", 5)],
        agentSkillDescriptors: [descriptor("tdd")],
        api: null,
        discovery: null,
      })
    ).toEqual([{ skillName: "tdd", scope: "global", source: "inline" }]);
  });

  test("silently drops unknown skills without an api", async () => {
    expect(
      await resolveInlineSkillReferences({
        candidates: [candidate("unknown")],
        agentSkillDescriptors: [],
        api: null,
        discovery: null,
      })
    ).toEqual([]);
  });

  test("silently drops skills when the api throws", async () => {
    const api = apiClient(() => Promise.reject(new Error("not found")));

    expect(
      await resolveInlineSkillReferences({
        candidates: [candidate("unknown")],
        agentSkillDescriptors: [],
        api,
        discovery: { kind: "project", projectPath: "/repo" },
      })
    ).toEqual([]);
  });

  test("uses backend package name and scope when remote resolution succeeds", async () => {
    const api = apiClient(() => Promise.resolve(skillPackage("backend-skill", "built-in")));

    expect(
      await resolveInlineSkillReferences({
        candidates: [candidate("remote-skill")],
        agentSkillDescriptors: [],
        api,
        discovery: { kind: "project", projectPath: "/repo" },
      })
    ).toEqual([{ skillName: "backend-skill", scope: "built-in", source: "inline" }]);
  });

  test("passes project discovery targets to the api", async () => {
    const calls: AgentSkillsGetInput[] = [];
    const api = apiClient((input) => {
      calls.push(input);
      return Promise.resolve(skillPackage("remote-skill", "project"));
    });

    expect(
      await resolveInlineSkillReferences({
        candidates: [candidate("remote-skill")],
        agentSkillDescriptors: [],
        api,
        discovery: { kind: "project", projectPath: "/repo" },
      })
    ).toEqual([{ skillName: "remote-skill", scope: "project", source: "inline" }]);

    expect(calls).toEqual([{ projectPath: "/repo", skillName: "remote-skill" }]);
  });

  test("passes workspace discovery targets and disableWorkspaceAgents to the api", async () => {
    const calls: AgentSkillsGetInput[] = [];
    const api = apiClient((input) => {
      calls.push(input);
      return Promise.resolve(skillPackage("workspace-skill", "global"));
    });

    expect(
      await resolveInlineSkillReferences({
        candidates: [candidate("workspace-skill")],
        agentSkillDescriptors: [],
        api,
        discovery: {
          kind: "workspace",
          workspaceId: "workspace-1",
          disableWorkspaceAgents: true,
        },
      })
    ).toEqual([{ skillName: "workspace-skill", scope: "global", source: "inline" }]);

    expect(calls).toEqual([
      {
        workspaceId: "workspace-1",
        disableWorkspaceAgents: true,
        skillName: "workspace-skill",
      },
    ]);
  });
});

import { describe, expect, it } from "bun:test";

import type { WorkspaceStackInfo } from "@/common/types/links";
import { mergeStackPullRequestMetadata, parseStackViewOutput } from "./PRStatusStore";

const STACK_VIEW_FIXTURE = JSON.stringify({
  trunk: "main",
  currentBranch: "mike/feat-b",
  branches: [
    {
      name: "mike/feat-a",
      head: "aaa",
      base: "main",
      isCurrent: false,
      isMerged: false,
      isQueued: false,
      needsRebase: false,
      pr: {
        number: 101,
        url: "https://github.com/coder/mux/pull/101",
        state: "OPEN",
      },
    },
    {
      name: "mike/feat-b",
      head: "bbb",
      base: "mike/feat-a",
      isCurrent: true,
      isMerged: false,
      isQueued: true,
      needsRebase: true,
      pr: {
        number: 102,
        url: "https://github.com/coder/mux/pull/102",
        state: "OPEN",
      },
    },
  ],
});

function makeBranch(name: string) {
  return {
    name,
    base: "main",
    isCurrent: false,
    isMerged: false,
    isQueued: false,
    needsRebase: false,
  };
}

describe("parseStackViewOutput", () => {
  it("parses gh-stack output into UI-oriented branch data", () => {
    const stack = parseStackViewOutput(STACK_VIEW_FIXTURE);

    expect(stack).toEqual({
      trunk: "main",
      branches: [
        {
          branch: "mike/feat-a",
          isCurrent: false,
          needsRebase: false,
          pr: {
            number: 101,
            url: "https://github.com/coder/mux/pull/101",
            state: "OPEN",
          },
        },
        {
          branch: "mike/feat-b",
          isCurrent: true,
          needsRebase: true,
          pr: {
            number: 102,
            url: "https://github.com/coder/mux/pull/102",
            state: "QUEUED",
          },
        },
      ],
    });
  });

  it("returns null for no-stack and malformed output", () => {
    expect(parseStackViewOutput('{"no_stack":true}')).toBeNull();
    expect(parseStackViewOutput("not json")).toBeNull();
  });

  it("keeps branches without pull requests", () => {
    const stack = parseStackViewOutput(
      JSON.stringify({
        trunk: "main",
        branches: [makeBranch("mike/feat-a"), makeBranch("mike/feat-b")],
      })
    );

    expect(stack?.branches.map((branch) => branch.pr)).toEqual([undefined, undefined]);
  });

  it("hides a one-branch stack", () => {
    expect(
      parseStackViewOutput(JSON.stringify({ trunk: "main", branches: [makeBranch("mike/feat-a")] }))
    ).toBeNull();
  });
});

describe("mergeStackPullRequestMetadata", () => {
  it("merges available metadata while preserving queued and missing entries", () => {
    const stack: WorkspaceStackInfo = {
      trunk: "main",
      branches: [
        {
          branch: "mike/feat-a",
          isCurrent: false,
          needsRebase: false,
          pr: { number: 101, state: "OPEN" },
        },
        {
          branch: "mike/feat-b",
          isCurrent: true,
          needsRebase: false,
          pr: { number: 102, state: "QUEUED" },
        },
        {
          branch: "mike/feat-c",
          isCurrent: false,
          needsRebase: false,
          pr: { number: 103, state: "OPEN" },
        },
      ],
    };

    const merged = mergeStackPullRequestMetadata(stack, {
      data: {
        repository: {
          p101: { number: 101, title: "Closed change", state: "CLOSED", isDraft: false },
          p102: { number: 102, title: "Queued change", state: "OPEN", isDraft: true },
        },
      },
    });

    expect(merged.branches[0].pr).toEqual({
      number: 101,
      state: "CLOSED",
      title: "Closed change",
      isDraft: false,
    });
    expect(merged.branches[1].pr).toEqual({
      number: 102,
      state: "QUEUED",
      title: "Queued change",
      isDraft: true,
    });
    expect(merged.branches[2]).toBe(stack.branches[2]);
  });
});

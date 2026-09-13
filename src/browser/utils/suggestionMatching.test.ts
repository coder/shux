import { describe, expect, test } from "bun:test";
import {
  filterAndRankByNameMatch,
  matchesNameBySegmentPrefix,
  NAME_MATCH_RANK,
  rankNameMatch,
} from "./suggestionMatching";

describe("matchesNameBySegmentPrefix", () => {
  test("matches empty and whitespace-only partials", () => {
    expect(matchesNameBySegmentPrefix("deep-review", "")).toBe(true);
    expect(matchesNameBySegmentPrefix("deep-review", "   ")).toBe(true);
  });

  test("matches full-name prefixes case-insensitively", () => {
    expect(matchesNameBySegmentPrefix("deep-review", "DEEP-R")).toBe(true);
  });

  test("matches hyphen-delimited segment prefixes", () => {
    expect(matchesNameBySegmentPrefix("code-simplifier", "simpl")).toBe(true);
    expect(matchesNameBySegmentPrefix("deep-review", "review")).toBe(true);
  });

  test("does not match substring-only partials", () => {
    expect(matchesNameBySegmentPrefix("deep-review", "view")).toBe(false);
  });
});

describe("rankNameMatch", () => {
  test("ranks exact above whole-name prefix above segment prefix", () => {
    expect(rankNameMatch("lint", "lint")).toBe(NAME_MATCH_RANK.exact);
    expect(rankNameMatch("lint-fix", "lint")).toBe(NAME_MATCH_RANK.namePrefix);
    expect(rankNameMatch("auto-lint", "lint")).toBe(NAME_MATCH_RANK.segmentPrefix);
    expect(rankNameMatch("deep-review", "view")).toBe(null);
  });

  test("is case-insensitive and trims the partial", () => {
    expect(rankNameMatch("LINT", " lint ")).toBe(NAME_MATCH_RANK.exact);
  });

  test("empty partials match everything at equal rank", () => {
    expect(rankNameMatch("deep-review", "")).toBe(rankNameMatch("lint", "   "));
  });
});

describe("filterAndRankByNameMatch", () => {
  test("orders matches by tier and keeps original order within a tier", () => {
    const names = ["auto-lint", "run-lint", "lint", "lint-fix", "unrelated", "lint-staged"];
    expect(filterAndRankByNameMatch(names, "lint", (name) => name)).toEqual([
      "lint",
      "lint-fix",
      "lint-staged",
      "auto-lint",
      "run-lint",
    ]);
  });
});

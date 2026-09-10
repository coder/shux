import { describe, expect, test } from "bun:test";

import { STRUCTURED_WORKFLOW_REPORT_PLACEHOLDER_MARKDOWN } from "@/common/constants/workflowReports";
import {
  WORKFLOW_TEXT_PREVIEW_CHAR_LIMIT,
  WORKFLOW_TEXT_PREVIEW_TOLERANCE_CHARS,
  formatWorkflowCost,
  formatWorkflowDuration,
  formatWorkflowTimeAgo,
  formatWorkflowTokens,
  getWorkflowTextPreview,
  hasDisplayableWorkflowReport,
  shouldAutoActivateWorkflowsTab,
  workflowStructuredOutputEntries,
} from "./workflowDisplay";

describe("formatWorkflowDuration", () => {
  test("sub-minute durations render as seconds", () => {
    expect(formatWorkflowDuration(12_000)).toBe("12s");
    expect(formatWorkflowDuration(0)).toBe("0s");
  });
  test("minute-plus durations render as minutes and seconds", () => {
    expect(formatWorkflowDuration(72_000)).toBe("1m 12s");
    expect(formatWorkflowDuration(125_000)).toBe("2m 5s");
  });
  test("missing duration renders an em dash", () => {
    expect(formatWorkflowDuration(null)).toBe("—");
    expect(formatWorkflowDuration(undefined)).toBe("—");
  });
});

describe("formatWorkflowTokens", () => {
  test("keeps one decimal under 10k and drops it at/above 10k", () => {
    expect(formatWorkflowTokens(950)).toBe("950");
    expect(formatWorkflowTokens(9_200)).toBe("9.2k");
    expect(formatWorkflowTokens(41_000)).toBe("41k");
  });
  test("missing token count renders an em dash", () => {
    expect(formatWorkflowTokens(null)).toBe("—");
  });
});

describe("formatWorkflowCost", () => {
  test("collapses tiny positive costs to a threshold label", () => {
    expect(formatWorkflowCost(0.004)).toBe("$<0.01");
  });
  test("formats normal costs with two decimals", () => {
    expect(formatWorkflowCost(0.11)).toBe("$0.11");
    expect(formatWorkflowCost(0)).toBe("$0.00");
  });
  test("missing cost renders an em dash", () => {
    expect(formatWorkflowCost(null)).toBe("—");
  });
});

describe("formatWorkflowTimeAgo", () => {
  const now = Date.parse("2026-06-23T14:33:00.000Z");
  test("buckets by minute / hour / day relative to now", () => {
    expect(formatWorkflowTimeAgo("2026-06-23T14:32:40.000Z", now)).toBe("just now");
    expect(formatWorkflowTimeAgo("2026-06-23T14:28:00.000Z", now)).toBe("5m ago");
    expect(formatWorkflowTimeAgo("2026-06-23T11:33:00.000Z", now)).toBe("3h ago");
    expect(formatWorkflowTimeAgo("2026-06-21T14:33:00.000Z", now)).toBe("2d ago");
  });
});

describe("hasDisplayableWorkflowReport", () => {
  test("suppresses the structured-output placeholder but keeps real markdown", () => {
    expect(
      hasDisplayableWorkflowReport(STRUCTURED_WORKFLOW_REPORT_PLACEHOLDER_MARKDOWN, true)
    ).toBe(false);
    // The same placeholder is worth showing when there's no structured output to stand in for it.
    expect(
      hasDisplayableWorkflowReport(STRUCTURED_WORKFLOW_REPORT_PLACEHOLDER_MARKDOWN, false)
    ).toBe(true);
    expect(hasDisplayableWorkflowReport("## Findings\n- real", true)).toBe(true);
  });
  test("treats empty / missing markdown as non-displayable", () => {
    expect(hasDisplayableWorkflowReport("", false)).toBe(false);
    expect(hasDisplayableWorkflowReport("   ", false)).toBe(false);
    expect(hasDisplayableWorkflowReport(null, false)).toBe(false);
  });
});

describe("workflowStructuredOutputEntries", () => {
  test("keeps primitive entries and drops nested/array values", () => {
    expect(
      workflowStructuredOutputEntries({
        findings: 4,
        confirmed: true,
        label: "x",
        nested: { a: 1 },
        list: [1],
      })
    ).toEqual([
      { key: "findings", value: "4" },
      { key: "confirmed", value: "true" },
      { key: "label", value: "x" },
    ]);
  });
  test("returns nothing for non-object inputs", () => {
    expect(workflowStructuredOutputEntries(null)).toEqual([]);
    expect(workflowStructuredOutputEntries([1, 2])).toEqual([]);
    expect(workflowStructuredOutputEntries("nope")).toEqual([]);
  });
});

describe("shouldAutoActivateWorkflowsTab", () => {
  test("activates only on a mounted zero-to-active transition", () => {
    expect(shouldAutoActivateWorkflowsTab(0, 1)).toBe(true);
    expect(shouldAutoActivateWorkflowsTab(0, 3)).toBe(true);
  });
  test("first observation never activates, so opening a workspace mid-run keeps the persisted tab", () => {
    expect(shouldAutoActivateWorkflowsTab(null, 2)).toBe(false);
  });
  test("additional concurrent runs and run completion do not re-activate", () => {
    expect(shouldAutoActivateWorkflowsTab(1, 2)).toBe(false);
    expect(shouldAutoActivateWorkflowsTab(2, 0)).toBe(false);
    expect(shouldAutoActivateWorkflowsTab(0, 0)).toBe(false);
  });
});

describe("getWorkflowTextPreview", () => {
  test("keeps text within the limit untouched", () => {
    const text = "short prompt";
    expect(getWorkflowTextPreview(text)).toEqual({
      truncated: false,
      preview: text,
      totalChars: text.length,
    });
  });
  test("does not truncate when the hidden remainder would be within the tolerance", () => {
    const text = "a".repeat(
      WORKFLOW_TEXT_PREVIEW_CHAR_LIMIT + WORKFLOW_TEXT_PREVIEW_TOLERANCE_CHARS
    );
    expect(getWorkflowTextPreview(text)).toEqual({
      truncated: false,
      preview: text,
      totalChars: text.length,
    });
  });
  test("truncates to the char limit once past the tolerance", () => {
    const text = "b".repeat(
      WORKFLOW_TEXT_PREVIEW_CHAR_LIMIT + WORKFLOW_TEXT_PREVIEW_TOLERANCE_CHARS + 1
    );
    expect(getWorkflowTextPreview(text)).toEqual({
      truncated: true,
      preview: "b".repeat(WORKFLOW_TEXT_PREVIEW_CHAR_LIMIT),
      totalChars: text.length,
    });
  });
  test("trims trailing whitespace from the cut point and honors a custom limit", () => {
    const text = `word ${"x".repeat(500)}`;
    expect(getWorkflowTextPreview(text, 5)).toEqual({
      truncated: true,
      preview: "word",
      totalChars: text.length,
    });
  });
  test("measures and cuts in code points so surrogate pairs are never split", () => {
    // 500 emoji = 1000 UTF-16 units; a unit-based cut at 5 would split a pair.
    const text = "😀".repeat(500);
    expect(getWorkflowTextPreview(text, 5)).toEqual({
      truncated: true,
      preview: "😀".repeat(5),
      totalChars: 500,
    });
  });
  test("does not truncate emoji text whose code-point count is within the limit", () => {
    // UTF-16 length (2× the limit) would truncate; code-point length must not.
    const text = "😀".repeat(WORKFLOW_TEXT_PREVIEW_CHAR_LIMIT);
    expect(getWorkflowTextPreview(text)).toEqual({
      truncated: false,
      preview: text,
      totalChars: WORKFLOW_TEXT_PREVIEW_CHAR_LIMIT,
    });
  });
});

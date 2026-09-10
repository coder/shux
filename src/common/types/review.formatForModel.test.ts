import { describe, expect, test } from "bun:test";

import {
  stripRenderedReviews,
  formatReviewForModel,
  isPlanFilePath,
  normalizePlanFilePath,
  type ReviewNoteData,
} from "./review";

const baseReviewData: ReviewNoteData = {
  filePath: "src/common/types/review.ts",
  lineRange: "-10-12 +14-16",
  selectedCode: "const value = 1;",
  userNote: "Please rename this variable.",
};

describe("stripRenderedReviews", () => {
  const reviews = [baseReviewData];
  const prefix = reviews.map(formatReviewForModel).join("\n\n");
  test.each(["", "\n", "\n\n"])("removes one matching prefix with separator %j", (separator) => {
    const body = `  ${prefix}\n\n<review>literal user text</review>\n `;
    expect(stripRenderedReviews(`${prefix}${separator}${body}`, reviews)).toBe(body);
  });
  test("keeps nonmatching metadata and interior/literal blocks byte-for-byte", () => {
    for (const body of [`before\n${prefix}`, ` ${prefix}`, "<review>other content</review>"]) {
      expect(stripRenderedReviews(body, reviews)).toBe(body);
    }
    expect(stripRenderedReviews(prefix)).toBe(prefix);
    expect(stripRenderedReviews(prefix, [])).toBe(prefix);
    expect(stripRenderedReviews(prefix, [{ ...baseReviewData, userNote: "different" }])).toBe(
      prefix
    );
    expect(stripRenderedReviews(prefix, reviews)).toBe("");
  });
});

describe("formatReviewForModel", () => {
  test("formats standard code review notes with file path and line range", () => {
    expect(formatReviewForModel(baseReviewData)).toBe(
      "<review>\nRe src/common/types/review.ts:-10-12 +14-16\n```\nconst value = 1;\n```\n> Please rename this variable.\n</review>"
    );
  });

  test("formats plan annotations with Plan location instead of raw plan file path", () => {
    const formatted = formatReviewForModel({
      ...baseReviewData,
      filePath: "/opt/user/.mux/plans/workspace/my-plan.md",
      lineRange: "+5-8",
    });

    expect(formatted).toContain("Re Plan:L5-8");
    expect(formatted).not.toContain(".mux/plans");
  });

  test("formats Docker plan annotations with Plan location", () => {
    const formatted = formatReviewForModel({
      ...baseReviewData,
      filePath: "/var/mux/plans/workspace/my-plan.md",
      lineRange: "+5-8",
    });

    expect(formatted).toContain("Re Plan:L5-8");
    expect(formatted).not.toContain("/var/mux/plans");
  });

  test("formats dev-mode mux plan annotations with Plan location", () => {
    const formatted = formatReviewForModel({
      ...baseReviewData,
      filePath: "/home/user/.mux-dev/plans/workspace/my-plan.md",
      lineRange: "+5-8",
    });

    expect(formatted).toContain("Re Plan:L5-8");
    expect(formatted).not.toContain(".mux-dev/plans");
  });

  test("formats custom MUX_ROOT plan annotations with raw file location", () => {
    const formatted = formatReviewForModel({
      ...baseReviewData,
      filePath: "/tmp/custom-root/plans/project/ws.md",
      lineRange: "+5-8",
    });

    expect(formatted).toContain("Re /tmp/custom-root/plans/project/ws.md:+5-8");
    expect(formatted).not.toContain("Re Plan:");
  });

  test("uses clean L-prefixed line ranges for plan annotations", () => {
    const formatted = formatReviewForModel({
      ...baseReviewData,
      filePath: "/home/user/.mux/plans/workspace/my-plan.md",
      lineRange: "-5-8 +5-8",
    });

    expect(formatted).toContain("Re Plan:L5-8");
  });

  test("formats unprefixed line range correctly for plan annotations", () => {
    const formatted = formatReviewForModel({
      ...baseReviewData,
      filePath: "/home/user/.mux/plans/project/ws.md",
      lineRange: "42-45",
    });

    expect(formatted).toContain("Re Plan:L42-45");
  });

  test("formats single-line unprefixed range for plan annotations", () => {
    const formatted = formatReviewForModel({
      ...baseReviewData,
      filePath: "/home/user/.mux/plans/project/ws.md",
      lineRange: "10",
    });

    expect(formatted).toContain("Re Plan:L10");
  });

  test("treats bare .mux/plans relative paths as plan annotations", () => {
    const formatted = formatReviewForModel({
      ...baseReviewData,
      filePath: ".mux/plans/workspace/my-plan.md",
      lineRange: "+5-8",
    });

    expect(formatted).toContain("Re Plan:L5-8");
    expect(formatted).not.toContain(".mux/plans");
  });

  test("does not treat non-plan paths containing plan-like words as plan paths", () => {
    const formatted = formatReviewForModel({
      ...baseReviewData,
      filePath: "src/planning/planner.ts",
      lineRange: "+5-8",
    });

    expect(formatted).toContain("Re src/planning/planner.ts:+5-8");
  });

  test("trims surrounding whitespace from user note", () => {
    const formatted = formatReviewForModel({
      ...baseReviewData,
      userNote: "   keep this note trimmed   ",
    });

    expect(formatted).toContain("> keep this note trimmed\n</review>");
  });
});

describe("normalizePlanFilePath", () => {
  test("normalizes absolute, tilde-prefixed mux, mux-suffix, and Docker plan paths to a stable .mux/plans suffix", () => {
    expect(normalizePlanFilePath("/opt/user/.mux/plans/project/ws.md")).toBe(
      ".mux/plans/project/ws.md"
    );
    expect(normalizePlanFilePath("/home/user/.mux/plans/workspace/plan.md")).toBe(
      ".mux/plans/workspace/plan.md"
    );
    expect(normalizePlanFilePath("/Users/user/.mux/plans/workspace/plan.md")).toBe(
      ".mux/plans/workspace/plan.md"
    );
    expect(normalizePlanFilePath("/root/.mux/plans/workspace/plan.md")).toBe(
      ".mux/plans/workspace/plan.md"
    );
    expect(normalizePlanFilePath("/tmp/.mux/plans/workspace/plan.md")).toBe(
      ".mux/plans/workspace/plan.md"
    );
    expect(normalizePlanFilePath("~/.mux/plans/workspace/plan.md")).toBe(
      ".mux/plans/workspace/plan.md"
    );
    expect(normalizePlanFilePath("~/.mux-dev/plans/workspace/plan.md")).toBe(
      ".mux/plans/workspace/plan.md"
    );
    expect(normalizePlanFilePath("~/.mux-test/plans/workspace/plan.md")).toBe(
      ".mux/plans/workspace/plan.md"
    );
    expect(normalizePlanFilePath("/home/user/.mux-dev/plans/workspace/plan.md")).toBe(
      ".mux/plans/workspace/plan.md"
    );
    expect(normalizePlanFilePath("/home/user/.mux-test/plans/workspace/plan.md")).toBe(
      ".mux/plans/workspace/plan.md"
    );
    expect(normalizePlanFilePath("C:\\Users\\user\\.mux-dev\\plans\\workspace\\plan.md")).toBe(
      ".mux/plans/workspace/plan.md"
    );
    expect(normalizePlanFilePath("C:\\Users\\user\\.mux\\plans\\workspace\\plan.md")).toBe(
      ".mux/plans/workspace/plan.md"
    );
    expect(normalizePlanFilePath("/var/mux/plans/myproject/workspace.md")).toBe(
      ".mux/plans/myproject/workspace.md"
    );
    expect(normalizePlanFilePath("C:\\var\\mux\\plans\\myproject\\workspace.md")).toBe(
      ".mux/plans/myproject/workspace.md"
    );
  });

  test("round-trips already-normalized plan paths", () => {
    const firstPass = normalizePlanFilePath("/home/user/.mux/plans/project/ws.md");
    expect(firstPass).toBe(".mux/plans/project/ws.md");
    // Second pass should return the same result
    const secondPass = normalizePlanFilePath(firstPass!);
    expect(secondPass).toBe(".mux/plans/project/ws.md");
  });

  test("rejects embedded/relative mux paths and non-plan /plans patterns", () => {
    expect(normalizePlanFilePath("project/.mux/plans/workspace/plan.md")).toBeNull();
    expect(normalizePlanFilePath(".mux-dev/plans/workspace/plan.md")).toBeNull();
    expect(normalizePlanFilePath("project/.mux-dev/plans/workspace/plan.md")).toBeNull();
    expect(normalizePlanFilePath("/var/mux/plans/")).toBeNull();
    expect(normalizePlanFilePath("src/plans/utils.ts")).toBeNull();
    expect(normalizePlanFilePath("/src/deeply/plans/a/b/c.ts")).toBeNull();
    expect(normalizePlanFilePath("/tmp/custom-root/plans/project/ws.md")).toBeNull();
    expect(normalizePlanFilePath("/opt/mux-production/plans/project/ws.md")).toBeNull();
    expect(normalizePlanFilePath("/workspace/repo/plans/roadmap/v1.txt")).toBeNull();
  });
});

describe("isPlanFilePath", () => {
  test("recognizes absolute, tilde-prefixed local, and Docker plan paths across separators", () => {
    expect(isPlanFilePath("/opt/user/.mux/plans/project/ws.md")).toBeTrue();
    expect(isPlanFilePath("/home/user/.mux/plans/workspace/plan.md")).toBeTrue();
    expect(isPlanFilePath("/Users/user/.mux/plans/workspace/plan.md")).toBeTrue();
    expect(isPlanFilePath("/root/.mux/plans/workspace/plan.md")).toBeTrue();
    expect(isPlanFilePath("/tmp/.mux/plans/workspace/plan.md")).toBeTrue();
    expect(isPlanFilePath("~/.mux/plans/workspace/plan.md")).toBeTrue();
    expect(isPlanFilePath("~/.mux-dev/plans/workspace/plan.md")).toBeTrue();
    expect(isPlanFilePath("~/.mux-test/plans/workspace/plan.md")).toBeTrue();
    expect(isPlanFilePath("C:\\Users\\user\\.mux\\plans\\workspace\\plan.md")).toBeTrue();
    expect(isPlanFilePath("C:/Users/user/.mux/plans/workspace/plan.md")).toBeTrue();
    expect(isPlanFilePath("/home/user/.mux-dev/plans/workspace/plan.md")).toBeTrue();
    expect(isPlanFilePath("/home/user/.mux-test/plans/workspace/plan.md")).toBeTrue();
    expect(isPlanFilePath("C:\\Users\\user\\.mux-dev\\plans\\workspace\\plan.md")).toBeTrue();
    expect(isPlanFilePath("/var/mux/plans/myproject/workspace.md")).toBeTrue();
    expect(isPlanFilePath("C:\\var\\mux\\plans\\myproject\\workspace.md")).toBeTrue();
  });

  test("isPlanFilePath recognizes already-normalized paths", () => {
    expect(isPlanFilePath(".mux/plans/project/ws.md")).toBe(true);
  });

  test("rejects non-plan paths, relative paths, and empty paths", () => {
    expect(isPlanFilePath("src/planning/planner.ts")).toBeFalse();
    expect(isPlanFilePath("src/plans/utils.ts")).toBeFalse();
    expect(isPlanFilePath("plan.txt")).toBeFalse();
    expect(isPlanFilePath("/tmp/custom-root/plans/project/ws.md")).toBeFalse();
    expect(isPlanFilePath("/workspace/repo/plans/roadmap/v1.txt")).toBeFalse();
    expect(isPlanFilePath("project/.mux/plans/workspace/plan.md")).toBeFalse();
    expect(isPlanFilePath(".mux-dev/plans/workspace/plan.md")).toBeFalse();
    expect(isPlanFilePath("project/.mux-dev/plans/workspace/plan.md")).toBeFalse();
    expect(isPlanFilePath("/src/deeply/plans/a/b/c.ts")).toBeFalse();
    expect(isPlanFilePath("/var/mux/plan/myproject/workspace.md")).toBeFalse();
    expect(isPlanFilePath("")).toBeFalse();
  });
});

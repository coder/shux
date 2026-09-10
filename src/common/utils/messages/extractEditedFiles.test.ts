import { describe, expect, it } from "bun:test";
import { createPatch } from "diff";
import { FILE_EDIT_DIFF_OMITTED_MESSAGE } from "@/common/types/tools";
import type { MuxMessage } from "@/common/types/message";
import { extractEditedFileDiffs, extractEditedFilePaths } from "./extractEditedFiles";

/**
 * Helper to create a mock XumMessage with file edit tool results.
 */
function createAssistantMessage(
  toolCalls: Array<{
    toolName: string;
    filePath: string;
    diff: string;
    uiOnlyDiff?: string;
    success?: boolean;
    inputPathKey?: "path" | "file_path";
  }>
): MuxMessage {
  return {
    id: `msg-${Math.random().toString(36).slice(2)}`,
    role: "assistant",
    parts: toolCalls.map((tc) => ({
      type: "dynamic-tool" as const,
      toolCallId: `tc-${Math.random().toString(36).slice(2)}`,
      toolName: tc.toolName,
      state: "output-available" as const,
      input: tc.inputPathKey === "file_path" ? { file_path: tc.filePath } : { path: tc.filePath },
      output: {
        success: tc.success ?? true,
        diff: tc.diff,
        ...(tc.uiOnlyDiff
          ? {
              ui_only: {
                file_edit: {
                  diff: tc.uiOnlyDiff,
                },
              },
            }
          : {}),
      },
    })),
  };
}

/**
 * Helper to generate a unified diff.
 */
function makeDiff(filePath: string, oldContent: string, newContent: string): string {
  return createPatch(filePath, oldContent, newContent, "", "", { context: 3 });
}

/**
 * Helper to create an assistant message with one code_execution part whose
 * output carries nested PTC tool-call records (exclusive posture).
 */
function createCodeExecutionMessage(toolCalls: unknown[]): MuxMessage {
  return {
    id: `msg-${Math.random().toString(36).slice(2)}`,
    role: "assistant",
    parts: [
      {
        type: "dynamic-tool" as const,
        toolCallId: `tc-${Math.random().toString(36).slice(2)}`,
        toolName: "code_execution",
        state: "output-available" as const,
        input: { code: "..." },
        output: { success: true, toolCalls },
      },
    ],
  };
}

describe("nested PTC edit records (exclusive posture)", () => {
  it("extracts paths and diffs from successful nested file_edit_* records", () => {
    const nestedDiff = makeDiff("/nested.ts", "old", "new");
    const messages: MuxMessage[] = [
      createCodeExecutionMessage([
        {
          toolName: "file_edit_replace_string",
          args: { path: "/nested.ts" },
          result: { success: true, diff: nestedDiff },
        },
        // Failed nested edits (bridge error, resolved failure, kernel ok bit)
        // are all skipped.
        { toolName: "file_edit_insert", args: { path: "/errored.ts" }, error: "denied" },
        {
          toolName: "file_edit_replace_string",
          args: { path: "/resolved-failed.ts" },
          result: { success: false },
        },
        { toolName: "file_edit_insert", args: { path: "/kernel-failed.ts" }, ok: false },
        // Non-edit nested calls are ignored.
        { toolName: "bash", args: { script: "true" }, result: { success: true } },
      ]),
    ];

    expect(extractEditedFilePaths(messages)).toEqual(["/nested.ts"]);
    const diffs = extractEditedFileDiffs(messages);
    expect(diffs).toHaveLength(1);
    expect(diffs[0].path).toBe("/nested.ts");
    expect(diffs[0].diff).toBe(nestedDiff);
  });

  it("returns edits from the newest code_execution part first when one message has several", () => {
    // Successive SDK steps append separate code_execution parts to one
    // assistant message; the later execution's edits must fill the
    // MAX_EDITED_FILES cap first.
    const older = createCodeExecutionMessage([
      { toolName: "file_edit_insert", args: { path: "/older.ts" }, ok: true },
    ]);
    const newer = createCodeExecutionMessage([
      { toolName: "file_edit_insert", args: { path: "/newer.ts" }, ok: true },
    ]);
    const combined: MuxMessage = { ...older, parts: [...older.parts, ...newer.parts] };

    expect(extractEditedFilePaths([combined])).toEqual(["/newer.ts", "/older.ts"]);
  });

  it("returns nested batch paths newest-first", () => {
    // The surrounding scan walks history backward to keep the LATEST edits
    // under MAX_EDITED_FILES; nested records are chronological, so a batch
    // must be traversed in reverse.
    const messages: MuxMessage[] = [
      createCodeExecutionMessage([
        { toolName: "file_edit_insert", args: { path: "/first.ts" }, ok: true },
        { toolName: "file_edit_insert", args: { path: "/second.ts" }, ok: true },
        { toolName: "file_edit_insert", args: { path: "/third.ts" }, ok: true },
      ]),
    ];

    expect(extractEditedFilePaths(messages)).toEqual(["/third.ts", "/second.ts", "/first.ts"]);
  });

  it("skips malformed records (null or primitive result) instead of throwing", () => {
    // History rows are untrusted persisted JSON; compaction preparation and
    // post-compaction attachment tracking both run this extractor, so one
    // corrupt nested result must not repeatedly fail those flows.
    const messages: MuxMessage[] = [
      createCodeExecutionMessage([
        { toolName: "file_edit_insert", args: { path: "/null-result.ts" }, result: null },
        { toolName: "file_edit_insert", args: { path: "/string-result.ts" }, result: "corrupt" },
        {
          toolName: "file_edit_insert",
          args: { path: "/good.ts" },
          result: { success: true, diff: makeDiff("/good.ts", "old", "new") },
        },
      ]),
    ];

    expect(extractEditedFilePaths(messages)).toEqual(["/good.ts"]);
    expect(extractEditedFileDiffs(messages)).toHaveLength(1);
  });

  it("propagates capture-time diff truncation to the combined diff", () => {
    // A kernel-retained record whose oversized diff was hunk-bounded at
    // capture (diffTruncated) makes every combined diff for that file
    // incomplete — even when a later small edit combines cleanly, the result
    // must not look like a complete original→final snapshot.
    const laterDiff = makeDiff("/big.ts", "old", "new");
    const messages: MuxMessage[] = [
      createCodeExecutionMessage([
        {
          toolName: "file_edit_replace_string",
          args: { path: "/big.ts" },
          result: { success: true, diffTruncated: true },
        },
        {
          toolName: "file_edit_replace_string",
          args: { path: "/big.ts" },
          result: { success: true, diff: laterDiff },
        },
      ]),
    ];

    expect(extractEditedFilePaths(messages)).toEqual(["/big.ts"]);
    const diffs = extractEditedFileDiffs(messages);
    expect(diffs).toHaveLength(1);
    expect(diffs[0].diff).toBe(laterDiff);
    expect(diffs[0].truncated).toBe(true);
  });

  it("skips non-string diffs (nested and direct) instead of throwing in parsePatch", () => {
    // Untrusted persisted JSON: a successful record can carry an array (or
    // object) diff, which passes truthiness/length checks and would throw in
    // parsePatch/applyPatch on every compaction/recovery pass (round 14).
    // The edit still counts for path tracking; only the diff is dropped.
    const goodDiff = makeDiff("/good.ts", "old", "new");
    const messages: MuxMessage[] = [
      createCodeExecutionMessage([
        {
          toolName: "file_edit_insert",
          args: { path: "/array-diff.ts" },
          result: { success: true, diff: ["not", "a", "string"] },
        },
        {
          toolName: "file_edit_insert",
          args: { path: "/good.ts" },
          result: { success: true, diff: goodDiff },
        },
      ]),
      {
        id: "msg-direct-corrupt-diff",
        role: "assistant",
        parts: [
          {
            type: "dynamic-tool" as const,
            toolCallId: "tc-direct-corrupt-diff",
            toolName: "file_edit_replace_string",
            state: "output-available" as const,
            input: { path: "/direct-array-diff.ts" },
            output: { success: true, diff: { corrupt: true } },
          },
        ],
      },
    ];

    expect(extractEditedFilePaths(messages)).toEqual([
      "/direct-array-diff.ts",
      "/good.ts",
      "/array-diff.ts",
    ]);
    const diffs = extractEditedFileDiffs(messages);
    expect(diffs).toHaveLength(1);
    expect(diffs[0].path).toBe("/good.ts");
  });

  it("does not report records lacking both a result and an ok bit as edits", () => {
    // Success must be positive: kernel-compacted records always carry an
    // explicit boolean ok and classic records carry a result, so a malformed
    // row with neither must not be reported by crash-safe tracking as a
    // completed edit (round 16).
    const messages: MuxMessage[] = [
      createCodeExecutionMessage([
        { toolName: "file_edit_insert", args: { path: "/unmodified.ts" } },
        { toolName: "file_edit_insert", args: { path: "/kernel-ok.ts" }, ok: true },
      ]),
    ];

    expect(extractEditedFilePaths(messages)).toEqual(["/kernel-ok.ts"]);
  });

  it("kernel-compacted records surface the path but no diff", () => {
    // Current kernel compaction exempts file_edit_* records (results kept for
    // exactly this extractor), but result-less compact records still exist in
    // history persisted by earlier builds and must degrade to path-only
    // tracking instead of being dropped.
    const messages: MuxMessage[] = [
      createCodeExecutionMessage([
        { toolName: "file_edit_replace_string", args: { path: "/kernel.ts" }, ok: true, bytes: 9 },
      ]),
    ];

    expect(extractEditedFilePaths(messages)).toEqual(["/kernel.ts"]);
    expect(extractEditedFileDiffs(messages)).toEqual([]);
  });

  it("marks the combined diff truncated when a result-less edit's diff did not survive", () => {
    // A kernel execution that exhausts the retained-result budget compacts a
    // later successful edit to a result-less {ok: true} record: the earlier
    // retained diff no longer describes the final file content, so the
    // surviving combined diff must not present itself as complete (round 26).
    const earlierDiff = makeDiff("/kernel.ts", "old", "mid");
    const messages: MuxMessage[] = [
      createCodeExecutionMessage([
        {
          toolName: "file_edit_replace_string",
          args: { path: "/kernel.ts" },
          result: { success: true, diff: earlierDiff },
        },
        { toolName: "file_edit_replace_string", args: { path: "/kernel.ts" }, ok: true, bytes: 9 },
      ]),
    ];

    const diffs = extractEditedFileDiffs(messages);
    expect(diffs).toHaveLength(1);
    expect(diffs[0].path).toBe("/kernel.ts");
    expect(diffs[0].diff).toBe(earlierDiff);
    expect(diffs[0].truncated).toBe(true);
  });

  it("moves recency to a later result-less edit so the file keeps its rank", () => {
    // The result-less record is the file's LATEST edit: without a recency
    // bump it stays ranked by its older retained diff and can fall off the
    // MAX_EDITED_FILES cut once enough other files are edited in between
    // (round 27).
    const aDiff = makeDiff("/a.ts", "old", "new");
    const bDiff = makeDiff("/b.ts", "old", "new");
    const messages: MuxMessage[] = [
      createCodeExecutionMessage([
        {
          toolName: "file_edit_replace_string",
          args: { path: "/a.ts" },
          result: { success: true, diff: aDiff },
        },
        {
          toolName: "file_edit_replace_string",
          args: { path: "/b.ts" },
          result: { success: true, diff: bDiff },
        },
        { toolName: "file_edit_replace_string", args: { path: "/a.ts" }, ok: true, bytes: 9 },
      ]),
    ];

    const diffs = extractEditedFileDiffs(messages);
    expect(diffs.map((d) => d.path)).toEqual(["/a.ts", "/b.ts"]);
    expect(diffs[0].truncated).toBe(true);
    expect(diffs[1].truncated).toBe(false);
  });
});

describe("extractEditedFilePaths", () => {
  it("should extract file paths from successful edits", () => {
    const messages: MuxMessage[] = [
      createAssistantMessage([
        {
          toolName: "file_edit_replace_string",
          filePath: "/path/to/file1.ts",
          diff: makeDiff("/path/to/file1.ts", "old", "new"),
        },
      ]),
      createAssistantMessage([
        {
          toolName: "file_edit_insert",
          filePath: "/path/to/file2.ts",
          diff: makeDiff("/path/to/file2.ts", "", "content"),
        },
      ]),
    ];

    const paths = extractEditedFilePaths(messages);
    expect(paths).toEqual(["/path/to/file2.ts", "/path/to/file1.ts"]);
  });

  it("should extract file paths from legacy path alias inputs", () => {
    const messages: MuxMessage[] = [
      createAssistantMessage([
        {
          toolName: "file_edit_replace_string",
          filePath: "/path/to/legacy.ts",
          diff: makeDiff("/path/to/legacy.ts", "old", "new"),
          inputPathKey: "path",
        },
      ]),
    ];

    const paths = extractEditedFilePaths(messages);
    expect(paths).toEqual(["/path/to/legacy.ts"]);
  });

  it("should ignore failed edits", () => {
    const messages: MuxMessage[] = [
      createAssistantMessage([
        {
          toolName: "file_edit_replace_string",
          filePath: "/path/to/file1.ts",
          diff: "",
          success: false,
        },
      ]),
    ];

    const paths = extractEditedFilePaths(messages);
    expect(paths).toEqual([]);
  });

  it("should dedupe paths and return most recent first", () => {
    const messages: MuxMessage[] = [
      createAssistantMessage([
        {
          toolName: "file_edit_replace_string",
          filePath: "/path/to/file1.ts",
          diff: makeDiff("/path/to/file1.ts", "v1", "v2"),
        },
      ]),
      createAssistantMessage([
        {
          toolName: "file_edit_replace_string",
          filePath: "/path/to/file2.ts",
          diff: makeDiff("/path/to/file2.ts", "old", "new"),
        },
      ]),
      createAssistantMessage([
        {
          toolName: "file_edit_replace_string",
          filePath: "/path/to/file1.ts",
          diff: makeDiff("/path/to/file1.ts", "v2", "v3"),
        },
      ]),
    ];

    const paths = extractEditedFilePaths(messages);
    // file1 was edited last, so it should be first
    expect(paths).toEqual(["/path/to/file1.ts", "/path/to/file2.ts"]);
  });
});

describe("extractEditedFileDiffs", () => {
  it("should extract single diff for a file", () => {
    const originalContent = "line1\nline2\nline3";
    const newContent = "line1\nmodified\nline3";
    const diff = makeDiff("/path/to/file.ts", originalContent, newContent);

    const messages: MuxMessage[] = [
      createAssistantMessage([
        {
          toolName: "file_edit_replace_string",
          filePath: "/path/to/file.ts",
          diff,
        },
      ]),
    ];

    const result = extractEditedFileDiffs(messages);
    expect(result).toHaveLength(1);
    expect(result[0].path).toBe("/path/to/file.ts");
    expect(result[0].truncated).toBe(false);
    // Single diff should be returned as-is
    expect(result[0].diff).toBe(diff);
  });

  it("should extract diffs when input uses legacy path alias", () => {
    const originalContent = "line1\nline2\nline3";
    const newContent = "line1\nupdated\nline3";
    const diff = makeDiff("/path/to/legacy.ts", originalContent, newContent);

    const messages: MuxMessage[] = [
      createAssistantMessage([
        {
          toolName: "file_edit_replace_string",
          filePath: "/path/to/legacy.ts",
          diff,
          inputPathKey: "path",
        },
      ]),
    ];

    const result = extractEditedFileDiffs(messages);
    expect(result).toHaveLength(1);
    expect(result[0].path).toBe("/path/to/legacy.ts");
    expect(result[0].diff).toBe(diff);
  });

  it("should prefer ui_only diffs when present", () => {
    const originalContent = "line1\nline2\nline3";
    const newContent = "line1\nmodified\nline3";
    const diff = makeDiff("/path/to/file.ts", originalContent, newContent);

    const messages: MuxMessage[] = [
      createAssistantMessage([
        {
          toolName: "file_edit_replace_string",
          filePath: "/path/to/file.ts",
          diff: FILE_EDIT_DIFF_OMITTED_MESSAGE,
          uiOnlyDiff: diff,
        },
      ]),
    ];

    const result = extractEditedFileDiffs(messages);
    expect(result).toHaveLength(1);
    expect(result[0].diff).toBe(diff);
  });

  it("should combine multiple non-overlapping diffs for the same file", () => {
    // Edit 1: change line 2
    const original = "line1\nline2\nline3\nline4\nline5";
    const afterEdit1 = "line1\nMODIFIED2\nline3\nline4\nline5";
    const diff1 = makeDiff("/path/to/file.ts", original, afterEdit1);

    // Edit 2: change line 4
    const afterEdit2 = "line1\nMODIFIED2\nline3\nMODIFIED4\nline5";
    const diff2 = makeDiff("/path/to/file.ts", afterEdit1, afterEdit2);

    const messages: MuxMessage[] = [
      createAssistantMessage([
        {
          toolName: "file_edit_replace_string",
          filePath: "/path/to/file.ts",
          diff: diff1,
        },
      ]),
      createAssistantMessage([
        {
          toolName: "file_edit_replace_string",
          filePath: "/path/to/file.ts",
          diff: diff2,
        },
      ]),
    ];

    const result = extractEditedFileDiffs(messages);
    expect(result).toHaveLength(1);
    expect(result[0].path).toBe("/path/to/file.ts");

    // The combined diff should show original -> final
    const expectedCombinedDiff = makeDiff("/path/to/file.ts", original, afterEdit2);
    expect(result[0].diff).toBe(expectedCombinedDiff);
  });

  it("should combine overlapping diffs (editing same lines twice)", () => {
    // Edit 1: change line 2
    const original = "line1\nline2\nline3";
    const afterEdit1 = "line1\nFIRST_EDIT\nline3";
    const diff1 = makeDiff("/path/to/file.ts", original, afterEdit1);

    // Edit 2: change line 2 again (overlapping edit)
    const afterEdit2 = "line1\nSECOND_EDIT\nline3";
    const diff2 = makeDiff("/path/to/file.ts", afterEdit1, afterEdit2);

    const messages: MuxMessage[] = [
      createAssistantMessage([
        {
          toolName: "file_edit_replace_string",
          filePath: "/path/to/file.ts",
          diff: diff1,
        },
      ]),
      createAssistantMessage([
        {
          toolName: "file_edit_replace_string",
          filePath: "/path/to/file.ts",
          diff: diff2,
        },
      ]),
    ];

    const result = extractEditedFileDiffs(messages);
    expect(result).toHaveLength(1);

    // Combined diff should show original -> final (skipping intermediate state)
    const expectedCombinedDiff = makeDiff("/path/to/file.ts", original, afterEdit2);
    expect(result[0].diff).toBe(expectedCombinedDiff);
  });

  it("should handle three sequential edits to the same lines", () => {
    const original = "function foo() {\n  return 1;\n}";
    const v1 = "function foo() {\n  return 2;\n}";
    const v2 = "function foo() {\n  return 3;\n}";
    const v3 = "function foo() {\n  return 42;\n}";

    const diff1 = makeDiff("/path/to/file.ts", original, v1);
    const diff2 = makeDiff("/path/to/file.ts", v1, v2);
    const diff3 = makeDiff("/path/to/file.ts", v2, v3);

    const messages: MuxMessage[] = [
      createAssistantMessage([
        { toolName: "file_edit_replace_string", filePath: "/path/to/file.ts", diff: diff1 },
      ]),
      createAssistantMessage([
        { toolName: "file_edit_replace_string", filePath: "/path/to/file.ts", diff: diff2 },
      ]),
      createAssistantMessage([
        { toolName: "file_edit_replace_string", filePath: "/path/to/file.ts", diff: diff3 },
      ]),
    ];

    const result = extractEditedFileDiffs(messages);
    expect(result).toHaveLength(1);

    // Should show original -> final
    const expectedCombinedDiff = makeDiff("/path/to/file.ts", original, v3);
    expect(result[0].diff).toBe(expectedCombinedDiff);
  });

  it("should handle edits that add and then modify new lines", () => {
    // Start with empty file
    const original = "";
    const afterInsert = "line1\nline2\nline3";
    const diff1 = makeDiff("/path/to/file.ts", original, afterInsert);

    // Then modify one of the inserted lines
    const afterModify = "line1\nMODIFIED\nline3";
    const diff2 = makeDiff("/path/to/file.ts", afterInsert, afterModify);

    const messages: MuxMessage[] = [
      createAssistantMessage([
        { toolName: "file_edit_insert", filePath: "/path/to/file.ts", diff: diff1 },
      ]),
      createAssistantMessage([
        { toolName: "file_edit_replace_string", filePath: "/path/to/file.ts", diff: diff2 },
      ]),
    ];

    const result = extractEditedFileDiffs(messages);
    expect(result).toHaveLength(1);

    // Combined diff should show empty -> final
    const expectedCombinedDiff = makeDiff("/path/to/file.ts", original, afterModify);
    expect(result[0].diff).toBe(expectedCombinedDiff);
  });

  it("should handle multiple files with different edit counts", () => {
    const file1Original = "a";
    const file1Final = "b";
    const diff1 = makeDiff("/file1.ts", file1Original, file1Final);

    const file2Original = "x";
    const file2V1 = "y";
    const file2Final = "z";
    const diff2a = makeDiff("/file2.ts", file2Original, file2V1);
    const diff2b = makeDiff("/file2.ts", file2V1, file2Final);

    const messages: MuxMessage[] = [
      createAssistantMessage([
        { toolName: "file_edit_replace_string", filePath: "/file1.ts", diff: diff1 },
      ]),
      createAssistantMessage([
        { toolName: "file_edit_replace_string", filePath: "/file2.ts", diff: diff2a },
      ]),
      createAssistantMessage([
        { toolName: "file_edit_replace_string", filePath: "/file2.ts", diff: diff2b },
      ]),
    ];

    const result = extractEditedFileDiffs(messages);
    expect(result).toHaveLength(2);

    // file2 was edited last, so it should be first
    expect(result[0].path).toBe("/file2.ts");
    expect(result[0].diff).toBe(makeDiff("/file2.ts", file2Original, file2Final));

    expect(result[1].path).toBe("/file1.ts");
    expect(result[1].diff).toBe(diff1);
  });

  it("should ignore failed edits when combining", () => {
    const original = "original";
    const afterSuccess = "modified";
    const successDiff = makeDiff("/file.ts", original, afterSuccess);

    const messages: MuxMessage[] = [
      createAssistantMessage([
        { toolName: "file_edit_replace_string", filePath: "/file.ts", diff: successDiff },
      ]),
      createAssistantMessage([
        {
          toolName: "file_edit_replace_string",
          filePath: "/file.ts",
          diff: "",
          success: false,
        },
      ]),
    ];

    const result = extractEditedFileDiffs(messages);
    expect(result).toHaveLength(1);
    expect(result[0].diff).toBe(successDiff);
  });

  it("should handle edit that deletes content from edited lines", () => {
    // Edit 1: add some content
    const original = "start\nend";
    const afterAdd = "start\nmiddle1\nmiddle2\nend";
    const diff1 = makeDiff("/file.ts", original, afterAdd);

    // Edit 2: remove some of the added content
    const afterDelete = "start\nmiddle1\nend";
    const diff2 = makeDiff("/file.ts", afterAdd, afterDelete);

    const messages: MuxMessage[] = [
      createAssistantMessage([
        { toolName: "file_edit_replace_string", filePath: "/file.ts", diff: diff1 },
      ]),
      createAssistantMessage([
        { toolName: "file_edit_replace_string", filePath: "/file.ts", diff: diff2 },
      ]),
    ];

    const result = extractEditedFileDiffs(messages);
    expect(result).toHaveLength(1);

    const expectedCombinedDiff = makeDiff("/file.ts", original, afterDelete);
    expect(result[0].diff).toBe(expectedCombinedDiff);
  });

  it("should combine non-overlapping diffs in large files with separate hunks", () => {
    // Create a file large enough that edits at top and bottom produce separate hunks
    // (more than 6 lines apart, so the 3-line context doesn't overlap)
    const lines = Array.from({ length: 20 }, (_, i) => `line${i + 1}`);
    const original = lines.join("\n");

    // Edit 1: change line 2 (near the top)
    const linesAfterEdit1 = [...lines];
    linesAfterEdit1[1] = "MODIFIED_LINE2";
    const afterEdit1 = linesAfterEdit1.join("\n");
    const diff1 = makeDiff("/large-file.ts", original, afterEdit1);

    // Edit 2: change line 18 (near the bottom) - far enough to be a separate hunk
    const linesAfterEdit2 = [...linesAfterEdit1];
    linesAfterEdit2[17] = "MODIFIED_LINE18";
    const afterEdit2 = linesAfterEdit2.join("\n");
    const diff2 = makeDiff("/large-file.ts", afterEdit1, afterEdit2);

    const messages: MuxMessage[] = [
      createAssistantMessage([
        { toolName: "file_edit_replace_string", filePath: "/large-file.ts", diff: diff1 },
      ]),
      createAssistantMessage([
        { toolName: "file_edit_replace_string", filePath: "/large-file.ts", diff: diff2 },
      ]),
    ];

    const result = extractEditedFileDiffs(messages);
    expect(result).toHaveLength(1);
    expect(result[0].path).toBe("/large-file.ts");

    // The combined diff should show original -> final with both edits
    const expectedCombinedDiff = makeDiff("/large-file.ts", original, afterEdit2);
    expect(result[0].diff).toBe(expectedCombinedDiff);
  });
});

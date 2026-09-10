import type { MuxMessage } from "@/common/types/message";
import { getToolOutputUiOnly } from "@/common/utils/tools/toolOutputUiOnly";
import { FILE_EDIT_TOOL_NAMES } from "@/common/types/tools";
import { MAX_EDITED_FILES, MAX_FILE_CONTENT_SIZE } from "@/common/constants/attachments";
import { applyPatch, createPatch, parsePatch } from "diff";
import { extractToolFilePath } from "@/common/utils/tools/toolInputFilePath";

/**
 * Output shape for file edit tools.
 * Successful edits contain a diff field.
 */
interface FileEditToolOutput {
  success?: boolean;
  diff?: string;
  /**
   * Kernel-retained records bound oversized diffs at a hunk boundary at
   * capture (see boundRetainedEditDiff in ptc/types.ts) and flag the loss
   * here; it propagates to FileEditDiff.truncated so consumers know the
   * combined diff is incomplete.
   */
  diffTruncated?: boolean;
}

/**
 * One successful nested edit found inside a code_execution output. `diff` is
 * present only for classic (non-kernel) PTC records, which retain the full
 * tool result; kernel-compacted records keep args (so the path survives) but
 * drop result contents, leaving nothing to rebuild a diff from.
 */
interface NestedEditRecord {
  filePath: string;
  diff?: string;
  /** See FileEditToolOutput.diffTruncated. */
  diffTruncated?: boolean;
}

/**
 * Nested edit calls inside a code_execution part (exclusive PTC): file edits
 * happen as nested xum.file_edit_* calls, so the outer part is named
 * "code_execution" and the edits live in its output's toolCalls records.
 * Mirrors collectNestedReadPaths in extractReadFiles.ts. Records are returned
 * in chronological (execution) order.
 */
function collectNestedEditRecords(output: unknown): NestedEditRecord[] {
  if (typeof output !== "object" || output === null) return [];
  const toolCalls = (output as { toolCalls?: unknown }).toolCalls;
  if (!Array.isArray(toolCalls)) return [];

  const records: NestedEditRecord[] = [];
  for (const record of toolCalls as Array<Record<string, unknown>>) {
    if (typeof record !== "object" || record === null) continue;
    if (!FILE_EDIT_TOOL_NAMES.includes(record.toolName as (typeof FILE_EDIT_TOOL_NAMES)[number])) {
      continue;
    }
    // Success = no error, and for kernel-compacted records ok !== false.
    if (record.error !== undefined || record.ok === false) continue;
    // History rows are untrusted persisted JSON: a malformed record can carry
    // null (or a primitive) here, and compaction preparation plus
    // post-compaction attachment tracking both run this extractor — one
    // corrupt row must degrade to a skip, never a repeated throw.
    if (
      record.result !== undefined &&
      (record.result === null || typeof record.result !== "object")
    ) {
      continue;
    }
    const result = record.result as FileEditToolOutput | undefined;
    // Success must be POSITIVE, never inferred from absence: classic records
    // retain the full result (edits resolve with {success: false} instead of
    // throwing), and kernel-compacted result-less records always carry an
    // explicit boolean ok — a malformed row with neither must not be
    // reported by crash-safe tracking as a completed edit.
    if (result === undefined && record.ok !== true) continue;
    if (result !== undefined && result.success !== true) continue;
    const filePath = extractToolFilePath(record.args);
    if (!filePath) continue;
    const rawDiff =
      result !== undefined
        ? (getToolOutputUiOnly(result)?.file_edit?.diff ?? result.diff)
        : undefined;
    // Untrusted persisted JSON again: a malformed row can carry a non-string
    // diff (array/object) that would pass truthiness/length checks and then
    // throw inside parsePatch/applyPatch on every compaction and recovery
    // pass — admit strings only (the path-only edit record still counts).
    const diff = typeof rawDiff === "string" ? rawDiff : undefined;
    records.push({
      filePath,
      ...(diff !== undefined ? { diff } : {}),
      // Propagated even when the bounded diff itself was dropped (no hunk
      // fit): a later small edit to the same file must still surface as an
      // incomplete combined diff, not a complete-looking one.
      ...(result?.diffTruncated === true ? { diffTruncated: true } : {}),
    });
  }
  return records;
}

/**
 * Represents a file and its combined diff from all edits.
 */
export interface FileEditDiff {
  path: string;
  diff: string;
  truncated: boolean;
}

/**
 * Extract unique file paths that have been edited from message history.
 * Scans assistant messages for successful file_edit_* tool uses.
 * Returns most recently edited files first, limited to MAX_EDITED_FILES.
 *
 * @param messages - The message history to scan
 * @returns Array of unique absolute file paths that were edited (max MAX_EDITED_FILES)
 */
export function extractEditedFilePaths(messages: MuxMessage[]): string[] {
  const editedFiles: string[] = [];
  const seen = new Set<string>();

  // Iterate in reverse to get most recent edits first
  for (let i = messages.length - 1; i >= 0; i--) {
    const message = messages[i];
    if (message.role !== "assistant") continue;

    // Parts are chronological too (successive SDK steps can each add a
    // code_execution batch): walk them backward so a later execution's edits
    // fill the MAX_EDITED_FILES cap before an earlier one's (mirrors
    // extractReadFilePaths).
    for (let partIndex = message.parts.length - 1; partIndex >= 0; partIndex--) {
      const part = message.parts[partIndex];
      if (part.type !== "dynamic-tool") continue;
      if (part.state !== "output-available") continue;

      if (part.toolName === "code_execution") {
        // Nested edits that completed before a later failure still landed.
        // Records are chronological; reverse them so this newest-first scan
        // keeps the LATEST edits of a large batch under MAX_EDITED_FILES.
        for (const record of collectNestedEditRecords(part.output).reverse()) {
          if (!seen.has(record.filePath)) {
            seen.add(record.filePath);
            editedFiles.push(record.filePath);
          }
        }
        continue;
      }

      if (!FILE_EDIT_TOOL_NAMES.includes(part.toolName as (typeof FILE_EDIT_TOOL_NAMES)[number]))
        continue;

      // Check if the tool result indicates success
      const output = part.output as { success?: boolean } | undefined;
      if (!output?.success) continue;

      const filePath = extractToolFilePath(part.input);
      if (filePath && !seen.has(filePath)) {
        seen.add(filePath);
        editedFiles.push(filePath);
      }
    }
  }

  // Return most recent files, limited to MAX_EDITED_FILES
  return editedFiles.slice(0, MAX_EDITED_FILES);
}

/**
 * Extract the original content from multiple unified diffs.
 * Parses all diffs and reconstructs what the file looked like before any edits.
 *
 * Strategy:
 * 1. The first diff's "original" side is the true original for regions it covers.
 * 2. For regions not covered by the first diff, later diffs provide the original
 *    content (since those regions weren't modified by earlier diffs).
 * 3. Lines that the first diff ADDS (new content) should not be filled from
 *    subsequent diffs, as they didn't exist in the original.
 *
 * Uses hunk positions to place content correctly and tracks claimed regions.
 */
function extractOriginalFromDiffs(diffs: string[]): string {
  if (diffs.length === 0) return "";

  const lines: string[] = [];

  // First pass: extract original from first diff and track its coverage
  // Also track line indices that were ADDED by the first diff (in the new file)
  // These indices shouldn't be filled from subsequent diffs
  const firstDiffOriginalIndices = new Set<number>();
  const firstDiffAddedIndices = new Set<number>(); // Indices in the NEW file that were added

  const firstDiff = diffs[0];
  const firstPatches = parsePatch(firstDiff);
  if (firstPatches.length > 0 && firstPatches[0].hunks) {
    for (const hunk of firstPatches[0].hunks) {
      let oldLineIndex = hunk.oldStart - 1;
      let newLineIndex = hunk.newStart - 1;

      // Fill gap with placeholder empty lines if needed
      while (lines.length < oldLineIndex) {
        lines.push("");
      }

      for (const line of hunk.lines) {
        if (line.startsWith("-") || line.startsWith(" ")) {
          // Original content
          const content = line.slice(1);
          if (oldLineIndex >= lines.length) {
            lines.push(content);
          } else {
            lines[oldLineIndex] = content;
          }
          firstDiffOriginalIndices.add(oldLineIndex);
          oldLineIndex++;
        }
        if (line.startsWith("+") || line.startsWith(" ")) {
          // Track new-file indices for context lines and additions
          firstDiffAddedIndices.add(newLineIndex);
          newLineIndex++;
        }
      }
    }
  }

  // Second pass: fill gaps from subsequent diffs
  // Only add content for regions not covered by the first diff
  for (let i = 1; i < diffs.length; i++) {
    const diff = diffs[i];
    const patches = parsePatch(diff);
    if (patches.length === 0 || !patches[0].hunks) continue;

    for (const hunk of patches[0].hunks) {
      // The hunk's oldStart refers to line numbers in the file AFTER previous diffs
      // For non-overlapping regions, this should match the original file
      let lineIndex = hunk.oldStart - 1;

      // Fill gap with placeholder empty lines if needed
      while (lines.length < lineIndex) {
        lines.push("");
      }

      for (const line of hunk.lines) {
        if (line.startsWith("-") || line.startsWith(" ")) {
          const content = line.slice(1);

          // Only fill if:
          // 1. This index wasn't part of the first diff's original content
          // 2. This index wasn't ADDED by the first diff (would be intermediate state)
          // 3. We haven't already filled this slot
          const isOriginalFromFirstDiff = firstDiffOriginalIndices.has(lineIndex);
          const wasAddedByFirstDiff = firstDiffAddedIndices.has(lineIndex);

          if (!isOriginalFromFirstDiff && !wasAddedByFirstDiff) {
            if (lineIndex >= lines.length) {
              lines.push(content);
            } else if (lines[lineIndex] === "") {
              lines[lineIndex] = content;
            }
          }
          lineIndex++;
        }
      }
    }
  }

  return lines.join("\n");
}

/**
 * Extract edited files with their combined diffs from message history.
 * Scans assistant messages for successful file_edit_* tool uses and combines
 * multiple edits to the same file into a single unified diff.
 *
 * Returns most recently edited files first, limited to MAX_EDITED_FILES.
 *
 * @param messages - The message history to scan
 * @returns Array of file diffs (max MAX_EDITED_FILES)
 */
export function extractEditedFileDiffs(messages: MuxMessage[]): FileEditDiff[] {
  // Collect all diffs per file path in chronological order
  const diffsByPath = new Map<string, string[]>();
  const editOrder: string[] = []; // Track order of last edit per file
  // Paths whose kernel-retained diff was hunk-truncated at capture: the
  // combined diff is incomplete no matter how the combination goes.
  const captureTruncatedPaths = new Set<string>();

  // Update edit order (move to end if already exists).
  const bumpRecency = (filePath: string): void => {
    const idx = editOrder.indexOf(filePath);
    if (idx !== -1) editOrder.splice(idx, 1);
    editOrder.push(filePath);
  };

  const addDiff = (filePath: string, diff: string): void => {
    if (!diffsByPath.has(filePath)) {
      diffsByPath.set(filePath, []);
    }
    diffsByPath.get(filePath)!.push(diff);
    bumpRecency(filePath);
  };

  for (const message of messages) {
    if (message.role !== "assistant") continue;

    for (const part of message.parts) {
      if (part.type !== "dynamic-tool") continue;
      if (part.state !== "output-available") continue;

      if (part.toolName === "code_execution") {
        // Classic PTC records retain the full nested result (including the
        // diff); kernel-compacted records surface path-only edits whose diff
        // contents did not survive compaction.
        for (const record of collectNestedEditRecords(part.output)) {
          if (record.diffTruncated === true) {
            captureTruncatedPaths.add(record.filePath);
          }
          if (record.diff !== undefined && record.diff.length > 0) {
            addDiff(record.filePath, record.diff);
          } else if (record.diff === undefined) {
            // A successful result-less (kernel-compacted) edit landed without
            // any retained diff: diffs from the file's OTHER retained edits no
            // longer describe the final content, so any surviving combined
            // diff must surface as incomplete rather than complete-looking
            // (r26 — mirrors the dropped-bounded-diff diffTruncated signal).
            captureTruncatedPaths.add(record.filePath);
            // It is also the file's LATEST edit: recency must move with it
            // (r27), or a recently edited file still ranked by its older
            // retained diff could fall off the MAX_EDITED_FILES cut entirely
            // once enough other files were edited in between.
            if (diffsByPath.has(record.filePath)) bumpRecency(record.filePath);
          }
        }
        continue;
      }

      if (!FILE_EDIT_TOOL_NAMES.includes(part.toolName as (typeof FILE_EDIT_TOOL_NAMES)[number]))
        continue;

      const output = part.output as FileEditToolOutput | undefined;
      if (!output?.success) continue;

      const uiOnly = getToolOutputUiOnly(output);
      const rawPartDiff = uiOnly?.file_edit?.diff ?? output.diff;
      // Same untrusted-JSON guard as collectNestedEditRecords: strings only.
      const diff = typeof rawPartDiff === "string" && rawPartDiff.length > 0 ? rawPartDiff : null;
      if (diff === null) continue;

      const filePath = extractToolFilePath(part.input);
      if (!filePath) continue;

      addDiff(filePath, diff);
    }
  }

  // Process files in reverse edit order (most recent first)
  const results: FileEditDiff[] = [];
  for (let i = editOrder.length - 1; i >= 0 && results.length < MAX_EDITED_FILES; i--) {
    const filePath = editOrder[i];
    const diffs = diffsByPath.get(filePath)!;

    const combined = combineDiffs(filePath, diffs);
    if (combined) {
      results.push(
        captureTruncatedPaths.has(filePath) ? { ...combined, truncated: true } : combined
      );
    }
  }

  return results;
}

/**
 * Combine multiple diffs for the same file into a single unified diff.
 * Applies diffs sequentially to reconstruct original→final transformation.
 */
function combineDiffs(filePath: string, diffs: string[]): FileEditDiff | null {
  if (diffs.length === 0) return null;

  // Single diff - no combination needed
  if (diffs.length === 1) {
    const diff = diffs[0];
    const truncated = diff.length > MAX_FILE_CONTENT_SIZE;
    return {
      path: filePath,
      diff: truncated ? diff.slice(0, MAX_FILE_CONTENT_SIZE) : diff,
      truncated,
    };
  }

  // Multiple diffs - need to combine
  // Start by extracting original content from all diffs (each covers different regions)
  let content = extractOriginalFromDiffs(diffs);
  const originalContent = content;

  // Apply each diff sequentially
  for (const diff of diffs) {
    const result = applyPatch(content, diff);
    if (result === false) {
      // Patch failed to apply - fall back to just using the last diff
      const lastDiff = diffs[diffs.length - 1];
      const truncated = lastDiff.length > MAX_FILE_CONTENT_SIZE;
      return {
        path: filePath,
        diff: truncated ? lastDiff.slice(0, MAX_FILE_CONTENT_SIZE) : lastDiff,
        truncated,
      };
    }
    content = result;
  }

  // Generate combined diff from original to final
  const combinedDiff = createPatch(filePath, originalContent, content, "", "", { context: 3 });
  const truncated = combinedDiff.length > MAX_FILE_CONTENT_SIZE;

  return {
    path: filePath,
    diff: truncated ? combinedDiff.slice(0, MAX_FILE_CONTENT_SIZE) : combinedDiff,
    truncated,
  };
}

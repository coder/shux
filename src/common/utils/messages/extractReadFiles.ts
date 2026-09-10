import type { MuxMessage } from "@/common/types/message";
import { FILE_READ_TOOL_NAMES } from "@/common/types/tools";
import { MAX_POST_COMPACTION_READ_FILES } from "@/constants/rlmCompaction";
import { extractToolFilePath } from "@/common/utils/tools/toolInputFilePath";

/**
 * Structural view of one nested tool-call record inside a code_execution
 * output (PTCToolCallRecord). Declared here because src/common must not
 * import node-side PTC types; only the fields this extractor reads.
 */
interface NestedToolCallRecord {
  toolName?: unknown;
  args?: unknown;
  error?: unknown;
  ok?: unknown;
}

/**
 * Nested read-flavored calls inside a code_execution part (RLM/PTC): in the
 * exclusive posture file access happens as nested xum.file_read / xum.load
 * calls, so the outer part is named "code_execution" and the reads live in
 * its output's toolCalls records. Success = no error, and for kernel compact
 * records ok !== false (non-RLM inline-results records carry no ok field).
 */
function collectNestedReadPaths(output: unknown): string[] {
  if (typeof output !== "object" || output === null) return [];
  const toolCalls = (output as { toolCalls?: unknown }).toolCalls;
  if (!Array.isArray(toolCalls)) return [];

  const paths: string[] = [];
  for (const record of toolCalls as NestedToolCallRecord[]) {
    if (typeof record !== "object" || record === null) continue;
    const isRead =
      FILE_READ_TOOL_NAMES.includes(record.toolName as (typeof FILE_READ_TOOL_NAMES)[number]) ||
      record.toolName === "load";
    if (!isRead) continue;
    if (record.error !== undefined || record.ok === false) continue;
    // Non-compacted records (classic PTC) retain the full result: file_read
    // resolves with {success: false} for missing/oversized/directory paths
    // instead of throwing, so a missing error does not mean the read
    // succeeded. (Kernel-compacted records fold this into the ok bit.)
    const result = (record as { result?: unknown }).result;
    // Same positive-success rule as collectNestedEditRecords: a result-less
    // record must carry an explicit ok === true (all kernel-compacted records
    // do) — a malformed row with neither result nor ok must not advertise a
    // never-read path.
    if (result === undefined && record.ok !== true) continue;
    // Records WITH a result must show the POSITIVE successful file_read shape
    // (r33): a corrupted persisted row can carry null, a primitive, or a
    // success-less object, and result presence alone must not tell the model
    // an unread file was already inspected. Kernel `load` results are the
    // exception — their retained {key, bytes, lines, preview} shape has no
    // success field; load failures surface through error/ok above.
    if (result !== undefined && record.toolName !== "load") {
      if (typeof result !== "object" || result === null) continue;
      if ((result as { success?: unknown }).success !== true) continue;
    }
    const filePath = extractToolFilePath(record.args);
    if (filePath) paths.push(filePath);
  }
  return paths;
}

/**
 * Extract unique file paths successfully READ during the given messages
 * (RLM post-compaction read tracking). Mirrors extractEditedFilePaths but for
 * read-flavored tools: paths only, never contents.
 *
 * Returns most recently read paths first, capped at
 * MAX_POST_COMPACTION_READ_FILES.
 */
export function extractReadFilePaths(messages: readonly MuxMessage[]): string[] {
  const readFiles: string[] = [];
  const seen = new Set<string>();

  const add = (filePath: string): boolean => {
    // Do NOT trim: leading/trailing whitespace is legal in path bytes, and
    // normalizing here changes the file's identity — a read of " report.txt"
    // would be advertised post-compaction as "report.txt", making the agent
    // believe it already read a different file. Reject only empty strings.
    if (filePath.length === 0 || seen.has(filePath)) return false;
    seen.add(filePath);
    readFiles.push(filePath);
    return readFiles.length >= MAX_POST_COMPACTION_READ_FILES;
  };

  // Iterate in reverse AT EVERY LEVEL — messages, parts within a message,
  // and nested kernel records within one code_execution — so the cap always
  // evicts the OLDEST reads. A single batched execution can exceed the cap
  // by itself; a forward inner loop would keep its earliest reads and drop
  // the files the agent just used.
  for (let i = messages.length - 1; i >= 0; i--) {
    const message = messages[i];
    if (message.role !== "assistant") continue;

    for (let p = message.parts.length - 1; p >= 0; p--) {
      const part = message.parts[p];
      if (part.type !== "dynamic-tool") continue;
      if (part.state !== "output-available") continue;

      if (part.toolName === "code_execution") {
        // The execution's overall success is irrelevant: nested reads that
        // completed before a later failure still loaded those files.
        const nestedPaths = collectNestedReadPaths(part.output);
        for (let n = nestedPaths.length - 1; n >= 0; n--) {
          if (add(nestedPaths[n])) return readFiles;
        }
        continue;
      }

      if (!FILE_READ_TOOL_NAMES.includes(part.toolName as (typeof FILE_READ_TOOL_NAMES)[number])) {
        continue;
      }

      // Only count completed reads that actually returned content.
      const output = part.output as { success?: boolean } | undefined;
      if (output?.success !== true) continue;

      const filePath = extractToolFilePath(part.input);
      if (!filePath) continue;
      if (add(filePath)) return readFiles;
    }
  }

  return readFiles;
}

/**
 * Merge read-file paths cumulatively across compactions: incoming (newer)
 * paths first, then previously tracked paths, deduped and capped. Mirrors
 * mergeFileEditDiffs so successive compactions keep older reads until the cap
 * evicts them newest-first.
 */
export function mergeReadFilePaths(
  existing: readonly string[],
  incoming: readonly string[]
): string[] {
  const merged: string[] = [];
  const seen = new Set<string>();

  for (const path of [...incoming, ...existing]) {
    if (typeof path !== "string") continue;
    // Do NOT trim: extractReadFilePaths deliberately preserves leading/trailing
    // whitespace as part of the file's identity (see its `add` helper).
    // Trimming here would advertise a different file post-compaction and
    // could collapse two distinct filenames into one. Reject only empties.
    if (path.length === 0 || seen.has(path)) continue;
    seen.add(path);
    merged.push(path);
    if (merged.length >= MAX_POST_COMPACTION_READ_FILES) {
      break;
    }
  }

  return merged;
}

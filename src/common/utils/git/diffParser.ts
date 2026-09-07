/**
 * Git diff parser - parses unified diff output into structured hunks
 */

import type { DiffHunk, FileDiff } from "@/common/types/review";
import { shellQuote } from "@/common/utils/shell";

/**
 * Generate a stable content-based ID for a hunk
 * Uses file path + line range + diff content to ensure uniqueness
 */
function generateHunkId(
  filePath: string,
  oldStart: number,
  newStart: number,
  content: string
): string {
  // Hash file path + line range + diff content for uniqueness and rebase stability
  const str = `${filePath}:${oldStart}-${newStart}:${content}`;
  let hash = 0;
  for (let i = 0; i < str.length; i++) {
    const char = str.charCodeAt(i);
    hash = (hash << 5) - hash + char;
    hash = hash & hash; // Convert to 32bit integer
  }
  return `hunk-${Math.abs(hash).toString(16)}`;
}

/**
 * Parse a hunk header line (e.g., "@@ -1,5 +1,6 @@ optional context")
 * Returns null if the line is not a valid hunk header
 */
function parseHunkHeader(line: string): {
  oldStart: number;
  oldLines: number;
  newStart: number;
  newLines: number;
} | null {
  const regex = /^@@ -(\d+)(?:,(\d+))? \+(\d+)(?:,(\d+))? @@/;
  const match = regex.exec(line);
  if (!match) return null;

  return {
    oldStart: parseInt(match[1], 10),
    oldLines: match[2] ? parseInt(match[2], 10) : 1,
    newStart: parseInt(match[3], 10),
    newLines: match[4] ? parseInt(match[4], 10) : 1,
  };
}

/**
 * Parse unified diff output into structured file diffs with hunks
 * Supports standard git diff format with file headers and hunk markers
 */
export function parseDiff(diffOutput: string): FileDiff[] {
  // Normalize line endings so CRLF diffs (and CRLF file contents) don't leak `\r` into the UI.
  // Note: a CRLF file often produces diff lines ending in `\r\n` (the `\r` is part of the file line).
  const lines = diffOutput.split(/\r?\n/);
  // Intentionally keep the trailing empty line from a final newline.
  // (When a hunk is still open, we convert it into a " " context line so the UI
  // has a stable trailing line for selection/comment placement.)
  const files: FileDiff[] = [];
  let currentFile: FileDiff | null = null;
  let currentHunk: Partial<DiffHunk> | null = null;
  let hunkLines: string[] = [];

  const finishHunk = () => {
    if (currentHunk && currentFile && hunkLines.length > 0) {
      const content = hunkLines.join("\n");
      const hunkId = generateHunkId(
        currentFile.filePath,
        currentHunk.oldStart!,
        currentHunk.newStart!,
        content
      );
      currentFile.hunks.push({
        ...currentHunk,
        id: hunkId,
        filePath: currentFile.filePath,
        content,
        changeType: currentFile.changeType,
        oldPath: currentFile.oldPath,
      } as DiffHunk);
      hunkLines = [];
      currentHunk = null;
    }
  };

  const finishFile = () => {
    finishHunk();
    if (currentFile) {
      files.push(currentFile);
      currentFile = null;
    }
  };

  for (const line of lines) {
    // File header: diff --git a/... b/...
    if (line.startsWith("diff --git ")) {
      finishFile();
      // Extract file paths from "diff --git a/path b/path"
      const regex = /^diff --git a\/(.+) b\/(.+)$/;
      const match = regex.exec(line);
      if (match) {
        const oldPath = match[1];
        const newPath = match[2];
        currentFile = {
          filePath: newPath,
          oldPath: oldPath !== newPath ? oldPath : undefined,
          changeType: "modified",
          isBinary: false,
          hunks: [],
        };
      }
      continue;
    }

    if (!currentFile) continue;

    // Binary file marker
    if (line.startsWith("Binary files ")) {
      currentFile.isBinary = true;
      continue;
    }

    if (line.startsWith("new file mode ")) {
      currentFile.changeType = "added";
      continue;
    }

    if (line.startsWith("deleted file mode ")) {
      currentFile.changeType = "deleted";
      continue;
    }

    // Rename marker
    if (line.startsWith("rename from ") || line.startsWith("rename to ")) {
      currentFile.changeType = "renamed";
      continue;
    }

    // Hunk header
    if (line.startsWith("@@")) {
      finishHunk();
      const parsed = parseHunkHeader(line);
      if (parsed) {
        currentHunk = {
          ...parsed,
          header: line,
        };
      }
      continue;
    }

    // Hunk content (lines starting with +, -, or space)
    if (currentHunk && (line.startsWith("+") || line.startsWith("-") || line.startsWith(" "))) {
      hunkLines.push(line);
      continue;
    }

    // Context line in hunk (no prefix, but within a hunk)
    if (currentHunk && line.length === 0) {
      hunkLines.push(" "); // Treat empty line as context
      continue;
    }
  }

  finishFile();

  return files;
}

/**
 * Extract all hunks from file diffs
 * Flattens the file -> hunks structure into a single array
 */
export function extractAllHunks(fileDiffs: FileDiff[]): DiffHunk[] {
  return fileDiffs.flatMap((file) => file.hunks);
}

/**
 * Build git diff command based on diffBase and includeUncommitted flag
 * Shared logic between numstat (file tree) and diff (hunks) commands
 *
 * Git diff semantics:
 * - `git diff A...HEAD` (three-dot): Shows commits on current branch since branching from A
 *   → Uses merge-base(A, HEAD) as comparison point, so changes to A after branching don't appear
 * - `git diff $(git merge-base A HEAD)`: Shows all changes from branch point to working directory
 *   → Includes both committed changes on the branch AND uncommitted working directory changes
 *   → Single unified diff (no duplicate hunks from concatenation)
 * - `git diff HEAD`: Shows only uncommitted changes (working directory vs HEAD)
 * - `git diff --staged`: Shows only staged changes (index vs HEAD)
 *
 * The key insight: When includeUncommitted is true, we compare from the merge-base directly
 * to the working directory. This gives a stable comparison point (doesn't change when base
 * ref moves forward) while including both committed and uncommitted work in a single diff.
 *
 * @param diffBase - Base reference ("main", "HEAD", "--staged")
 * @param includeUncommitted - Include uncommitted working directory changes
 * @param pathFilter - Optional path filter (e.g., ' -- "src/foo.ts"')
 * @param command - "diff" (unified), "numstat" (file stats), or "name-status" (file status)
 */
export function buildGitDiffCommand(
  diffBase: string,
  includeUncommitted: boolean,
  pathFilter: string,
  command: "diff" | "numstat" | "name-status"
): string {
  const flags =
    command === "numstat"
      ? " -M --numstat"
      : command === "name-status"
        ? " -M --name-status"
        : " -M";

  if (diffBase === "--staged") {
    // Staged changes, optionally with unstaged appended as separate diff
    const base = `git diff --staged${flags}${pathFilter}`;
    return includeUncommitted ? `${base} && git diff HEAD${flags}${pathFilter}` : base;
  }

  if (diffBase === "HEAD") {
    // Uncommitted changes only (working vs HEAD)
    return `git diff HEAD${flags}${pathFilter}`;
  }

  // SECURITY: diffBase can come from repository branch names (including auto-detected trunk refs).
  // Quote it before embedding in shell command strings to prevent command injection.
  const quotedDiffBase = shellQuote(diffBase);

  // Branch diff: use three-dot for committed only, or merge-base for committed+uncommitted
  if (includeUncommitted) {
    // Use merge-base to get a unified diff from branch point to working directory
    // This includes both committed changes on the branch AND uncommitted working changes
    // Single command avoids duplicate hunks from concatenation
    // Stable comparison point: merge-base doesn't change when diffBase ref moves forward
    return `git diff $(git merge-base ${quotedDiffBase} HEAD)${flags}${pathFilter}`;
  } else {
    // Three-dot: committed changes only (merge-base to HEAD)
    return `git diff ${quotedDiffBase}...HEAD${flags}${pathFilter}`;
  }
}

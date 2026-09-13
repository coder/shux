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

interface ParsedDiffPathLabel {
  raw: string;
  prefix: string | null;
  path: string | null;
}

function decodeGitCString(value: string): string {
  const bytes: number[] = [];
  const encoder = new TextEncoder();
  const decoder = new TextDecoder();

  for (let index = 0; index < value.length; index++) {
    const char = value[index];
    if (char !== "\\") {
      bytes.push(...encoder.encode(char));
      continue;
    }

    index += 1;
    if (index >= value.length) {
      bytes.push(0x5c);
      break;
    }

    const escape = value[index];
    if (/[0-7]/.test(escape)) {
      let octal = escape;
      while (index + 1 < value.length && octal.length < 3 && /[0-7]/.test(value[index + 1])) {
        index += 1;
        octal += value[index];
      }
      bytes.push(parseInt(octal, 8));
      continue;
    }

    switch (escape) {
      case "a":
        bytes.push(0x07);
        break;
      case "b":
        bytes.push(0x08);
        break;
      case "t":
        bytes.push(0x09);
        break;
      case "n":
        bytes.push(0x0a);
        break;
      case "v":
        bytes.push(0x0b);
        break;
      case "f":
        bytes.push(0x0c);
        break;
      case "r":
        bytes.push(0x0d);
        break;
      case '"':
        bytes.push(0x22);
        break;
      case "\\":
        bytes.push(0x5c);
        break;
      default:
        bytes.push(...encoder.encode(escape));
        break;
    }
  }

  return decoder.decode(new Uint8Array(bytes));
}

function parseQuotedDiffLabel(
  value: string,
  startIndex = 0
): { rawLabel: string; label: string; nextIndex: number } | null {
  if (value[startIndex] !== '"') {
    return null;
  }

  let escaped = false;
  for (let index = startIndex + 1; index < value.length; index++) {
    const char = value[index];
    if (!escaped && char === '"') {
      return {
        rawLabel: value.slice(startIndex, index + 1),
        label: decodeGitCString(value.slice(startIndex + 1, index)),
        nextIndex: index + 1,
      };
    }

    escaped = !escaped && char === "\\";
  }

  return null;
}

function normalizeDiffPathLabel(label: string | undefined): string | undefined {
  if (label == null) {
    return undefined;
  }

  const quotedLabel = parseQuotedDiffLabel(label);
  if (quotedLabel) {
    return quotedLabel.label;
  }

  // Preserve literal trailing spaces in file names while still stripping the tab separator
  // Git appends to unquoted patch labels before any optional timestamp metadata.
  const tabIndex = label.indexOf("\t");
  const normalizedLabel = tabIndex === -1 ? label : label.slice(0, tabIndex);
  return normalizedLabel.length === 0 ? undefined : normalizedLabel;
}

function parseDiffPathLabel(label: string | undefined): ParsedDiffPathLabel | null {
  const normalizedLabel = normalizeDiffPathLabel(label);
  if (normalizedLabel == null) {
    return null;
  }

  if (normalizedLabel === "/dev/null") {
    return {
      raw: normalizedLabel,
      prefix: null,
      path: null,
    };
  }

  const slashIndex = normalizedLabel.indexOf("/");
  if (slashIndex === -1) {
    return {
      raw: normalizedLabel,
      prefix: null,
      path: normalizedLabel,
    };
  }

  return {
    raw: normalizedLabel,
    prefix: normalizedLabel.slice(0, slashIndex),
    path: normalizedLabel.slice(slashIndex + 1),
  };
}

function parseDiffGitHeaderLabels(line: string): {
  oldLabel: string | undefined;
  newLabel: string | undefined;
} {
  const labelSection = line.slice("diff --git ".length);
  const quotedOldLabel = parseQuotedDiffLabel(labelSection);
  if (quotedOldLabel) {
    const separatorMatch = /\s+/.exec(labelSection.slice(quotedOldLabel.nextIndex));
    if (separatorMatch) {
      const quotedNewLabel = parseQuotedDiffLabel(
        labelSection,
        quotedOldLabel.nextIndex + separatorMatch.index + separatorMatch[0].length
      );
      if (quotedNewLabel) {
        return {
          oldLabel: quotedOldLabel.rawLabel,
          newLabel: quotedNewLabel.rawLabel,
        };
      }
    }
  }

  const simpleLabels = labelSection.split(" ");
  if (simpleLabels.length === 2) {
    return {
      oldLabel: simpleLabels[0],
      newLabel: simpleLabels[1],
    };
  }

  // Git can emit unquoted `diff --git` headers for paths with spaces, so look for the split
  // that preserves the paired path on both sides instead of tokenizing on every space.
  for (let index = 0; index < labelSection.length; index++) {
    if (labelSection[index] !== " ") {
      continue;
    }

    const oldLabel = labelSection.slice(0, index);
    const newLabel = labelSection.slice(index + 1);
    const parsedOldLabel = parseDiffPathLabel(oldLabel);
    const parsedNewLabel = parseDiffPathLabel(newLabel);
    if (
      parsedOldLabel?.path != null &&
      parsedNewLabel?.path != null &&
      parsedOldLabel.path === parsedNewLabel.path
    ) {
      return {
        oldLabel,
        newLabel,
      };
    }
  }

  return {
    oldLabel: undefined,
    newLabel: undefined,
  };
}

function choosePairedDiffLabel(
  primaryLabel: string | undefined,
  fallbackLabel: string | undefined
): string | undefined {
  return primaryLabel != null && primaryLabel !== "/dev/null" ? primaryLabel : fallbackLabel;
}

function canonicalizeDiffPathLabel(
  label: string | undefined,
  pairedLabel: string | undefined
): string | undefined {
  const parsedLabel = parseDiffPathLabel(label);
  if (parsedLabel?.path == null) {
    return undefined;
  }

  const parsedPair = parseDiffPathLabel(pairedLabel);
  if (
    parsedLabel.prefix &&
    parsedPair?.prefix &&
    parsedLabel.prefix !== parsedPair.prefix &&
    parsedLabel.path === parsedPair.path
  ) {
    return parsedLabel.path;
  }

  return parsedLabel.raw;
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
  let currentHeaderOldLabel: string | undefined;
  let currentHeaderNewLabel: string | undefined;
  let currentPatchOldLabel: string | undefined;
  let currentPatchNewLabel: string | undefined;
  let currentRenameFrom: string | undefined;
  let currentRenameTo: string | undefined;

  const syncCurrentFilePaths = () => {
    if (!currentFile) {
      return;
    }

    const resolvedOldPath =
      currentRenameFrom ??
      canonicalizeDiffPathLabel(
        currentPatchOldLabel ?? currentHeaderOldLabel,
        choosePairedDiffLabel(currentPatchNewLabel, currentHeaderNewLabel)
      );
    const resolvedNewPath =
      currentRenameTo ??
      canonicalizeDiffPathLabel(
        currentPatchNewLabel ?? currentHeaderNewLabel,
        choosePairedDiffLabel(currentPatchOldLabel, currentHeaderOldLabel)
      );
    const filePath = resolvedNewPath ?? resolvedOldPath;
    if (filePath) {
      currentFile.filePath = filePath;
    }

    currentFile.oldPath =
      resolvedOldPath &&
      (currentFile.changeType === "deleted" ||
        currentFile.changeType === "renamed" ||
        (resolvedNewPath != null && resolvedOldPath !== resolvedNewPath))
        ? resolvedOldPath
        : undefined;
  };

  const resetCurrentFileLabels = () => {
    currentHeaderOldLabel = undefined;
    currentHeaderNewLabel = undefined;
    currentPatchOldLabel = undefined;
    currentPatchNewLabel = undefined;
    currentRenameFrom = undefined;
    currentRenameTo = undefined;
  };

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
      syncCurrentFilePaths();
      files.push(currentFile);
      currentFile = null;
    }
    resetCurrentFileLabels();
  };

  for (const line of lines) {
    // File header: git emits path labels here, but they are not guaranteed to be literal a/ and b/.
    if (line.startsWith("diff --git ")) {
      finishFile();
      // Extract the paired labels without assuming literal a/ and b/ prefixes or space-free paths.
      const parsedHeaderLabels = parseDiffGitHeaderLabels(line);
      currentHeaderOldLabel = parsedHeaderLabels.oldLabel;
      currentHeaderNewLabel = parsedHeaderLabels.newLabel;
      currentFile = {
        filePath: "",
        oldPath: undefined,
        changeType: "modified",
        isBinary: false,
        hunks: [],
      };
      syncCurrentFilePaths();
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
      syncCurrentFilePaths();
      continue;
    }

    if (line.startsWith("deleted file mode ")) {
      currentFile.changeType = "deleted";
      syncCurrentFilePaths();
      continue;
    }

    if (!currentHunk && line.startsWith("--- ")) {
      currentPatchOldLabel = line.slice(4);
      syncCurrentFilePaths();
      continue;
    }

    if (!currentHunk && line.startsWith("+++ ")) {
      currentPatchNewLabel = line.slice(4);
      syncCurrentFilePaths();
      continue;
    }

    if (line.startsWith("rename from ")) {
      currentFile.changeType = "renamed";
      currentRenameFrom = normalizeDiffPathLabel(line.slice("rename from ".length));
      syncCurrentFilePaths();
      continue;
    }

    if (line.startsWith("rename to ")) {
      currentFile.changeType = "renamed";
      currentRenameTo = normalizeDiffPathLabel(line.slice("rename to ".length));
      syncCurrentFilePaths();
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

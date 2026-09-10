/**
 * Parse `git diff --name-status` output.
 *
 * Format examples:
 *   M\tpath/to/file.ts
 *   A\tpath/to/new.ts
 *   D\tpath/to/deleted.ts
 *   R100\told/path.ts\tnew/path.ts
 *   C100\told/path.ts\tnew/path.ts
 */

import type { FileChangeType } from "@/common/types/review";

export interface NameStatusEntry {
  filePath: string;
  changeType: FileChangeType;
  oldPath?: string;
}

const CHANGE_TYPE_PRECEDENCE: Record<FileChangeType, number> = {
  deleted: 4,
  added: 3,
  renamed: 2,
  modified: 1,
};

function toFileChangeType(statusCode: string): FileChangeType {
  if (statusCode.startsWith("A")) return "added";
  if (statusCode.startsWith("D")) return "deleted";
  if (statusCode.startsWith("R")) return "renamed";
  // Treat copies as adds (new path exists).
  if (statusCode.startsWith("C")) return "added";
  return "modified";
}

/**
 * Returns a de-duplicated list of file change entries.
 *
 * `git diff --name-status` can contain duplicates when commands are concatenated
 * (e.g. staged + uncommitted). We keep the "strongest" changeType by precedence:
 * `deleted > added > renamed > modified`.
 */
export function parseNameStatus(output: string): NameStatusEntry[] {
  // Split before filtering instead of trimming the whole output: a full trim would
  // strip trailing whitespace from the LAST line's file path, desyncing it from the
  // exact paths parseNumstat preserves and losing that file's change status.
  const lines = output.split("\n").filter(Boolean);
  const byPath = new Map<string, NameStatusEntry>();

  for (const line of lines) {
    const parts = line.split("\t");
    if (parts.length < 2) continue;

    const statusCode = parts[0];
    const changeType = toFileChangeType(statusCode);

    const isCopy = statusCode.startsWith("C");

    const entry: NameStatusEntry | null =
      changeType === "renamed" || isCopy
        ? parts.length >= 3
          ? { filePath: parts[2], oldPath: parts[1], changeType }
          : null
        : { filePath: parts[1], changeType };

    if (!entry) continue;

    const existing = byPath.get(entry.filePath);
    if (!existing) {
      byPath.set(entry.filePath, entry);
      continue;
    }

    const existingPrecedence = CHANGE_TYPE_PRECEDENCE[existing.changeType];
    const nextPrecedence = CHANGE_TYPE_PRECEDENCE[entry.changeType];
    if (nextPrecedence > existingPrecedence) {
      byPath.set(entry.filePath, entry);
      continue;
    }

    // Preserve oldPath if we already have the strongest entry but are missing the old path.
    if (existing.changeType === entry.changeType && !existing.oldPath && entry.oldPath) {
      byPath.set(entry.filePath, { ...existing, oldPath: entry.oldPath });
    }
  }

  return [...byPath.values()];
}

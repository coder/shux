import * as fsPromises from "node:fs/promises";
import * as path from "node:path";
import assert from "@/common/utils/assert";
import { WORKSPACE_MEMORY_REVISION_FILE_NAME } from "@/common/constants/memory";

/**
 * Per-owner clock for a shared `/memories/workspace` store, persisted at
 * `<ownerSessionDir>/memory.revision`. Two jobs, one file:
 *
 * - Cross-journal order. Owner and sub-agent rows describing the same store
 *   live in DIFFERENT session journals, whose `seq`/`ts` are not comparable
 *   (a migrated child row gets a fresh owner sequence; same-millisecond
 *   edits tie on `ts`). Every store mutation — memory command or rollback —
 *   advances this clock while holding the store's target mutation lock and
 *   stamps the value as the row's `sourceTs`, so rollback's conflict
 *   detection sees one total order across the whole task tree.
 * - Cross-process change signal. The value only ever grows, so consumers in
 *   other backends (AgentSession's cached memory context, the Memory tab)
 *   compare it before reusing a cached view (MemoryService.workspaceMemoryRevision).
 *
 * Millisecond domain: `max(now, previous + 1)` keeps it a real timestamp for
 * ordinary spacing while guaranteeing strict monotonicity under the lock.
 */
export function workspaceMemoryRevisionPath(ownerSessionDir: string): string {
  assert(ownerSessionDir.length > 0, "workspaceMemoryRevisionPath requires an owner session dir");
  return path.join(ownerSessionDir, WORKSPACE_MEMORY_REVISION_FILE_NAME);
}

/** Current clock value, or null when the store was never written (or the file is unreadable). */
export async function readWorkspaceMemoryRevision(ownerSessionDir: string): Promise<number | null> {
  try {
    const raw = await fsPromises.readFile(workspaceMemoryRevisionPath(ownerSessionDir), "utf-8");
    const value = Number.parseInt(raw, 10);
    return Number.isSafeInteger(value) && value > 0 ? value : null;
  } catch {
    return null;
  }
}

/**
 * Advance and persist the clock; returns the new value. Callers MUST hold the
 * store's target mutation lock (cross-process) — the read→write here is what
 * that lock makes atomic. Throws when the owner session dir is missing: the
 * file is never allowed to recreate a removed owner's directory.
 */
export async function advanceWorkspaceMemoryRevision(ownerSessionDir: string): Promise<number> {
  const previous = (await readWorkspaceMemoryRevision(ownerSessionDir)) ?? 0;
  const next = Math.max(Date.now(), previous + 1);
  await fsPromises.writeFile(workspaceMemoryRevisionPath(ownerSessionDir), String(next));
  return next;
}

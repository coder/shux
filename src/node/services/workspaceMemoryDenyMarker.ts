/**
 * Durable fallback for the workspace-memory write-policy DENY.
 *
 * The epoch accumulator normally lives on the workspace's config.json entry
 * (`workspaceMemoryWritable`, see WorkspaceService.recordWorkspaceMemoryWritable).
 * By the time a turn learns its final tool set has no `memory` tool, its user
 * row is already durable in chat.jsonl — so if the config write fails, refusing
 * the turn is not enough: after a restart the accumulator would be absent, a
 * later writable turn would publish `true`, and the compaction harvest (which
 * reads EVERY message of the epoch) would carry the refused turn's rows into
 * the shared notebook. This marker lives in the session dir — the same
 * durability domain as chat.jsonl — and is ANDed into the accumulator wherever
 * it is consulted; it is cleared only at the epoch boundary that clears the
 * config bit.
 *
 * Like the config bit, the marker is bound to its compaction epoch (the
 * opening boundary's history sequence, -1 before any boundary): a reader
 * consulting it for another epoch ignores it, so a backend starting the new
 * epoch before this one's boundary reset landed cannot inherit a stale deny.
 *
 * Fail-closed by construction: a missing marker (or one recorded for a
 * different epoch) is "no deny"; a present marker for this epoch, or a
 * malformed/unreadable one, is a deny.
 */
import * as fsPromises from "node:fs/promises";
import * as path from "node:path";
import writeFileAtomic from "write-file-atomic";
import assert from "@/common/utils/assert";
import { hasErrorCode } from "@/node/services/tools/skillFileUtils";

export const WORKSPACE_MEMORY_DENY_MARKER_FILE_NAME = "memory-policy-deny.json";

export function workspaceMemoryDenyMarkerPath(sessionDir: string): string {
  assert(sessionDir.length > 0, "workspaceMemoryDenyMarkerPath requires a session dir");
  return path.join(sessionDir, WORKSPACE_MEMORY_DENY_MARKER_FILE_NAME);
}

/** Durable-or-throw: verified by reading the marker back. */
export async function writeWorkspaceMemoryDenyMarker(
  sessionDir: string,
  epoch: number
): Promise<void> {
  assert(Number.isInteger(epoch), "workspace memory deny marker epoch must be an integer");
  const markerPath = workspaceMemoryDenyMarkerPath(sessionDir);
  await fsPromises.mkdir(sessionDir, { recursive: true });
  await writeFileAtomic(markerPath, JSON.stringify({ deniedAt: Date.now(), epoch }), {
    encoding: "utf-8",
  });
  if (!(await readWorkspaceMemoryDenyMarker(sessionDir, epoch))) {
    throw new Error(`Workspace memory deny marker did not persist at ${markerPath}`);
  }
}

/** Parsed marker, or null when it is unreadable/malformed (which readers treat as a deny). */
async function readMarkerRecord(
  markerPath: string
): Promise<{ deniedAt: number | null; epoch: number | null } | "absent" | null> {
  try {
    const parsed: unknown = JSON.parse(await fsPromises.readFile(markerPath, "utf-8"));
    if (typeof parsed !== "object" || parsed === null) return null;
    const { deniedAt, epoch } = parsed as { deniedAt?: unknown; epoch?: unknown };
    return {
      deniedAt: typeof deniedAt === "number" && Number.isFinite(deniedAt) ? deniedAt : null,
      epoch: typeof epoch === "number" && Number.isInteger(epoch) ? epoch : null,
    };
  } catch (error) {
    return hasErrorCode(error, "ENOENT") ? "absent" : null;
  }
}

/**
 * True when a deny is recorded for `epoch` (or the marker cannot be trusted:
 * unreadable, malformed, or written by a build that did not record an epoch);
 * false when absent or recorded for a different epoch. Without `epoch`, any
 * present marker is a deny (epoch-agnostic existence check).
 */
export async function readWorkspaceMemoryDenyMarker(
  sessionDir: string,
  epoch?: number
): Promise<boolean> {
  const record = await readMarkerRecord(workspaceMemoryDenyMarkerPath(sessionDir));
  if (record === "absent") return false;
  if (record === null || epoch === undefined) return true;
  return record.epoch === null || record.epoch === epoch;
}

/**
 * Epoch boundary: remove the marker, durable-or-throw (verified absent).
 * `closingEpoch` fences the clear to that epoch's deny: a deny another
 * backend recorded for the NEW epoch in the meantime (different epoch) must
 * survive. Only a well-formed marker can claim to be another epoch's; a
 * truncated or malformed one is stale state from some earlier epoch (every
 * reader already treated it as a deny for as long as it existed) and is
 * healed here — otherwise one corrupt file would force every later epoch's
 * accumulator to false until a destructive history clear.
 */
export async function clearWorkspaceMemoryDenyMarker(
  sessionDir: string,
  options?: { closingEpoch: number }
): Promise<void> {
  const markerPath = workspaceMemoryDenyMarkerPath(sessionDir);
  if (options !== undefined) {
    const record = await readMarkerRecord(markerPath);
    if (record === "absent") return;
    if (record !== null && record.epoch !== null && record.epoch !== options.closingEpoch) return;
  }
  await fsPromises.rm(markerPath, { force: true });
  if (await readWorkspaceMemoryDenyMarker(sessionDir)) {
    throw new Error(`Workspace memory deny marker could not be removed at ${markerPath}`);
  }
}

/**
 * A preserved-tail compaction carries the closing epoch's policy into the new
 * one (the tail copies were produced under it): a deny marker recorded for
 * `closingEpoch` is re-stamped with `nextEpoch` so readers of the new epoch
 * keep seeing it. Markers of other epochs and absent markers are left alone;
 * a malformed one stays a deny for every reader regardless.
 */
export async function carryWorkspaceMemoryDenyMarker(
  sessionDir: string,
  closingEpoch: number,
  nextEpoch: number
): Promise<void> {
  const record = await readMarkerRecord(workspaceMemoryDenyMarkerPath(sessionDir));
  if (record === "absent" || record?.epoch !== closingEpoch) return;
  await writeWorkspaceMemoryDenyMarker(sessionDir, nextEpoch);
}

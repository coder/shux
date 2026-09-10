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
 * Like the config records, the marker is bound to its compaction epoch (the
 * opening boundary's history sequence, -1 before any boundary) and holds one
 * entry per epoch (the newest few): a reader consulting it for another epoch
 * ignores it, so a backend starting the new epoch before this one's boundary
 * reset landed cannot inherit a stale deny — and a deny that backend records
 * for the new epoch cannot displace the closing epoch's deny before the
 * compacting backend observes it (see workspaceMemoryPolicyEpochs.ts).
 *
 * Fail-closed by construction: a missing marker (or one without an entry for
 * this epoch) is "no deny"; a present entry for this epoch, a wildcard entry
 * (inherited from a malformed marker some later writer replaced), or a
 * malformed/unreadable marker, is a deny.
 */
import * as fsPromises from "node:fs/promises";
import * as path from "node:path";
import writeFileAtomic from "write-file-atomic";
import assert from "@/common/utils/assert";
import { hasErrorCode } from "@/node/services/tools/skillFileUtils";
import { withTargetMutationLock } from "@/node/services/refinement/targetMutationLocks";

export const WORKSPACE_MEMORY_DENY_MARKER_FILE_NAME = "memory-policy-deny.json";

export function workspaceMemoryDenyMarkerPath(sessionDir: string): string {
  assert(sessionDir.length > 0, "workspaceMemoryDenyMarkerPath requires a session dir");
  return path.join(sessionDir, WORKSPACE_MEMORY_DENY_MARKER_FILE_NAME);
}

/** Durable-or-throw: verified by reading the marker back. Adds `epoch` to the recorded set. */
export async function writeWorkspaceMemoryDenyMarker(
  sessionDir: string,
  epoch: number
): Promise<void> {
  assert(Number.isInteger(epoch), "workspace memory deny marker epoch must be an integer");
  const markerPath = workspaceMemoryDenyMarkerPath(sessionDir);
  await fsPromises.mkdir(sessionDir, { recursive: true });
  const record = await readMarkerRecord(markerPath);
  if (record === "unreadable") {
    throw new Error(`Workspace memory deny marker is unreadable at ${markerPath}`);
  }
  // A malformed marker was a deny for EVERY epoch's reader while it existed,
  // possibly the only evidence of some other backend's read-only turn in
  // the closing epoch. This writer, recording a deny for its own epoch,
  // cannot know which epoch that was, so the well-formed file it leaves
  // behind carries the deny forward as a wildcard until a boundary
  // observation clears it (clearWorkspaceMemoryDenyMarker).
  const epochs = record === "absent" || record === null ? [] : record.epochs;
  const wildcard = record === null || (record !== "absent" && record.wildcard);
  await writeMarkerRecord(markerPath, [...epochs.filter((e) => e !== epoch), epoch], wildcard);
  if (!(await readWorkspaceMemoryDenyMarker(sessionDir, epoch))) {
    throw new Error(`Workspace memory deny marker did not persist at ${markerPath}`);
  }
}

/** `wildcard`: a deny of unknown epoch (inherited from a malformed marker), denying every reader. */
async function writeMarkerRecord(
  markerPath: string,
  epochs: readonly number[],
  wildcard: boolean
): Promise<void> {
  // Entries are removed only by the boundary observation that consumes them
  // (clear/carry), never by count — see workspaceMemoryPolicyEpochs.ts.
  const retained = [...new Set(epochs)].sort((a, b) => b - a);
  await writeFileAtomic(
    markerPath,
    JSON.stringify({ deniedAt: Date.now(), epochs: retained, wildcard }),
    { encoding: "utf-8" }
  );
}

/**
 * Parsed marker; "absent" on a proven ENOENT; null when the content is
 * malformed (readers deny; a boundary clear heals it); "unreadable" when the
 * file could not be read at all (EACCES, I/O) — readers deny, and mutators
 * throw rather than replace or delete epoch state they could not see.
 */
async function readMarkerRecord(
  markerPath: string
): Promise<{ epochs: number[]; wildcard: boolean } | "absent" | "unreadable" | null> {
  let raw: string;
  try {
    raw = await fsPromises.readFile(markerPath, "utf-8");
  } catch (error) {
    return hasErrorCode(error, "ENOENT") ? "absent" : "unreadable";
  }
  try {
    const parsed: unknown = JSON.parse(raw);
    if (typeof parsed !== "object" || parsed === null) return null;
    const { epochs, wildcard } = parsed as { epochs?: unknown; wildcard?: unknown };
    // Epochs are -1 (before any boundary) or a boundary's history sequence:
    // anything outside that domain is corruption, read as malformed (deny).
    if (
      !Array.isArray(epochs) ||
      !epochs.every(
        (epoch): epoch is number =>
          typeof epoch === "number" && Number.isSafeInteger(epoch) && epoch >= -1
      )
    ) {
      return null;
    }
    // `wildcard` may be omitted (false) but, when present, must be a boolean:
    // a corrupted `"true"` read as false would drop the only surviving deny
    // of an epoch the `epochs` list does not name.
    if (wildcard !== undefined && typeof wildcard !== "boolean") return null;
    return { epochs, wildcard: wildcard === true };
  } catch {
    return null;
  }
}

/**
 * True when a deny is recorded for `epoch` (or the marker cannot be trusted:
 * unreadable or malformed); false when absent or recorded only for other
 * epochs. Without `epoch`, any present marker is a deny (epoch-agnostic
 * existence check).
 */
export async function readWorkspaceMemoryDenyMarker(
  sessionDir: string,
  epoch?: number
): Promise<boolean> {
  return readWorkspaceMemoryDenyMarkerForEpochs(
    sessionDir,
    epoch === undefined ? undefined : [epoch]
  );
}

/**
 * `readWorkspaceMemoryDenyMarker` for several epochs from ONE read of the
 * marker: a deny recorded for any of them. A preserved-tail turn consults its
 * own epoch and the epochs its tail copies were produced under; the carry
 * (carryWorkspaceMemoryDenyMarker) re-stamps an entry from the closing epoch
 * to the new one atomically, so two separate reads could each miss it (old
 * gone, new not yet seen) while a single snapshot always holds it under one
 * key or the other. Without `epochs`, any present marker is a deny.
 */
export async function readWorkspaceMemoryDenyMarkerForEpochs(
  sessionDir: string,
  epochs?: readonly number[]
): Promise<boolean> {
  const record = await readMarkerRecord(workspaceMemoryDenyMarkerPath(sessionDir));
  if (record === "absent") return false;
  if (record === null || record === "unreadable" || epochs === undefined) return true;
  return record.wildcard || epochs.some((epoch) => record.epochs.includes(epoch));
}

/**
 * Epoch boundary: remove the closing epoch's deny, durable-or-throw (verified
 * absent). `closingEpoch` fences the clear to that epoch's entry: a deny
 * another backend recorded for the NEW epoch in the meantime must survive,
 * so the file is removed only once no entry is left. Only a well-formed
 * marker can hold other epochs' entries; a truncated or malformed one is
 * stale state from some earlier epoch (every reader already treated it as a
 * deny for as long as it existed) and is healed here — otherwise one corrupt
 * file would force every later epoch's accumulator to false until a
 * destructive history clear. Without `closingEpoch` (destructive boundary),
 * every epoch's deny goes.
 */
export async function clearWorkspaceMemoryDenyMarker(
  rootDir: string,
  sessionDir: string,
  options?: { closingEpoch: number }
): Promise<void> {
  const markerPath = workspaceMemoryDenyMarkerPath(sessionDir);
  // Read-check-delete under the session-dir target lock the writer holds
  // (WorkspaceService.recordWorkspaceMemoryWritable's fallback), so the fence
  // cannot go stale between the read and the rm: a new-epoch deny written in
  // that gap — possibly the only durable record of it — would otherwise be
  // deleted right after its writer verified it.
  await withTargetMutationLock(rootDir, sessionDir, async () => {
    if (options !== undefined) {
      const record = await readMarkerRecord(markerPath);
      if (record === "absent") return;
      // Unreadable is not malformed: the file may hold a newer epoch's deny
      // (possibly the only durable record of a read-only turn). Refuse; the
      // caller's reset fails and is retried rather than deleting unknown state.
      if (record === "unreadable") {
        throw new Error(`Workspace memory deny marker is unreadable at ${markerPath}`);
      }
      if (record !== null) {
        // This boundary observed the closing epoch (deny included): the
        // epoch-less wildcard, if any, is consumed with it.
        const remaining = record.epochs.filter((epoch) => epoch !== options.closingEpoch);
        if (remaining.length === record.epochs.length && !record.wildcard) return;
        if (remaining.length > 0) {
          await writeMarkerRecord(markerPath, remaining, false);
          if (await readWorkspaceMemoryDenyMarker(sessionDir, options.closingEpoch)) {
            throw new Error(`Workspace memory deny marker could not be cleared at ${markerPath}`);
          }
          return;
        }
      }
    }
    await fsPromises.rm(markerPath, { force: true });
    if (await readWorkspaceMemoryDenyMarker(sessionDir)) {
      throw new Error(`Workspace memory deny marker could not be removed at ${markerPath}`);
    }
  });
}

/**
 * A preserved-tail compaction carries the closing epoch's policy into the new
 * one (the tail copies were produced under it): a deny recorded for
 * `closingEpoch` is re-stamped as `nextEpoch` so readers of the new epoch
 * keep seeing it. Entries of other epochs and absent markers are left alone;
 * a malformed one stays a deny for every reader regardless. Same lock as the
 * clear, for the same read→write reason.
 */
export async function carryWorkspaceMemoryDenyMarker(
  rootDir: string,
  sessionDir: string,
  closingEpoch: number,
  nextEpoch: number
): Promise<void> {
  await withTargetMutationLock(rootDir, sessionDir, async () => {
    const markerPath = workspaceMemoryDenyMarkerPath(sessionDir);
    const record = await readMarkerRecord(markerPath);
    if (record === "unreadable") {
      throw new Error(
        `Workspace memory deny marker is unreadable at ${workspaceMemoryDenyMarkerPath(sessionDir)}`
      );
    }
    if (record === "absent" || record === null) return;
    if (!record.wildcard && !record.epochs.includes(closingEpoch)) return;
    // The wildcard denied the closing epoch; carried as the new epoch's deny.
    await writeMarkerRecord(
      markerPath,
      [
        ...record.epochs.filter((epoch) => epoch !== closingEpoch && epoch !== nextEpoch),
        nextEpoch,
      ],
      false
    );
    if (!(await readWorkspaceMemoryDenyMarker(sessionDir, nextEpoch))) {
      throw new Error(`Workspace memory deny marker did not persist at ${markerPath}`);
    }
  });
}

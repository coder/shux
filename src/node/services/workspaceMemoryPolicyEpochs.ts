/**
 * Per-epoch storage of the workspace-memory write-policy accumulator on a
 * workspace's config.json entry (`workspaceMemoryWritableByEpoch`, see
 * WorkspaceService.recordWorkspaceMemoryWritable).
 *
 * One record per compaction epoch rather than a single slot: with several
 * backends over one chat.jsonl (XUM_ALLOW_MULTIPLE_INSTANCES), a backend can
 * start the NEW epoch's first turn between another backend's compaction
 * boundary and that backend's completion-side read of the CLOSING epoch's
 * value. A single slot would be overwritten by the new epoch's grant, dropping
 * a deny recorded for the closing epoch — and the compacting backend's own
 * mirror (writable) would then grant the harvest of a read-only turn. A
 * record is removed only by the observation that consumes it — the
 * compacting session's boundary reset/carry (AgentSession) or a destructive
 * boundary — never by count: a backend suspended between persisting its
 * boundary and observing the closing policy must still find the record
 * however many epochs other backends opened meanwhile. Records of a boundary
 * whose observer never ran (crash in between) linger until the next
 * destructive boundary; that residue is bounded by such crashes.
 */
import type { Workspace as WorkspaceConfigEntry } from "@/node/config";
import assert from "@/common/utils/assert";

function epochKey(epoch: number): string {
  assert(Number.isInteger(epoch), "workspace memory policy epoch must be an integer");
  return String(epoch);
}

/**
 * The recorded policy for `epoch`: `undefined` when none was recorded. Config
 * entries are loaded from raw JSON without schema validation, so anything
 * present that is not an actual boolean (a corrupted `"false"` or `null`)
 * reads as a DENY — a truthy string or a null-coalesced default would
 * otherwise turn corrupted deny state into a grant.
 */
export function workspaceMemoryWritableForEpoch(
  entry: WorkspaceConfigEntry,
  epoch: number
): boolean | undefined {
  const records: Record<string, unknown> | undefined = entry.workspaceMemoryWritableByEpoch;
  const key = epochKey(epoch);
  if (records === undefined || !Object.hasOwn(records, key)) return undefined;
  const value = records[key];
  return typeof value === "boolean" ? value : false;
}

/** Record `writable` for `epoch`. */
export function setWorkspaceMemoryWritableForEpoch(
  entry: WorkspaceConfigEntry,
  epoch: number,
  writable: boolean
): void {
  entry.workspaceMemoryWritableByEpoch = {
    ...entry.workspaceMemoryWritableByEpoch,
    [epochKey(epoch)]: writable,
  };
}

/** Forget `epoch`'s record; removes the field once no record is left. */
export function deleteWorkspaceMemoryWritableForEpoch(
  entry: WorkspaceConfigEntry,
  epoch: number
): void {
  const current = entry.workspaceMemoryWritableByEpoch;
  if (current === undefined) return;
  const key = epochKey(epoch);
  if (!(key in current)) return;
  const next = { ...current };
  delete next[key];
  if (Object.keys(next).length === 0) delete entry.workspaceMemoryWritableByEpoch;
  else entry.workspaceMemoryWritableByEpoch = next;
}

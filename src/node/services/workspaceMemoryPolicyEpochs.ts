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
 * record is removed only by a destructive boundary (AgentSession.
 * resetWorkspaceMemoryWritable), never by a compaction boundary's observation
 * and never by count: two backends can each commit a boundary closing the
 * same epoch, and a backend suspended between persisting its boundary and
 * observing the closing policy must still find the record however many
 * epochs other backends opened meanwhile. Readers key strictly by epoch and
 * epoch keys (boundary history sequences; -1 only before the first boundary
 * of a segment) never recur before the destructive boundary that drops every
 * record, so retained records are inert — one boolean per compaction epoch
 * in config.json until then.
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
  const records = policyRecords(entry);
  if (records === undefined) return undefined;
  // A container of the wrong shape (null, array, string) is corruption too:
  // fail closed for every epoch rather than throw out of every turn start
  // (Object.hasOwn(null) would). The next write or forget heals it.
  if (records === null) return false;
  const key = epochKey(epoch);
  if (!Object.hasOwn(records, key)) return undefined;
  const value = records[key];
  return typeof value === "boolean" ? value : false;
}

/**
 * The persisted container: `undefined` when absent, `null` when present but
 * not a plain object (raw JSON, no schema validation upstream).
 */
function policyRecords(entry: WorkspaceConfigEntry): Record<string, unknown> | null | undefined {
  const records: unknown = entry.workspaceMemoryWritableByEpoch;
  if (records === undefined) return undefined;
  return typeof records === "object" && records !== null && !Array.isArray(records)
    ? (records as Record<string, unknown>)
    : null;
}

/** Record `writable` for `epoch`. */
export function setWorkspaceMemoryWritableForEpoch(
  entry: WorkspaceConfigEntry,
  epoch: number,
  writable: boolean
): void {
  // A malformed container is replaced, not spread (spreading a string would
  // persist its characters as epoch keys).
  entry.workspaceMemoryWritableByEpoch = {
    ...(policyRecords(entry) === null ? {} : entry.workspaceMemoryWritableByEpoch),
    [epochKey(epoch)]: writable,
  };
}

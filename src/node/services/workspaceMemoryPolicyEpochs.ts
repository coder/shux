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
 * mirror (writable) would then grant the harvest of a read-only turn. Epochs
 * are history sequences (-1 before any boundary), so the newest few are kept
 * and older ones garbage-collected: a closing epoch is observed at its
 * boundary, before more than a couple of further boundaries can exist.
 */
import type { Workspace as WorkspaceConfigEntry } from "@/node/config";
import assert from "@/common/utils/assert";

/** The closing epoch plus the next ones that can be opened before it is observed. */
export const WORKSPACE_MEMORY_POLICY_EPOCHS_RETAINED = 3;

function epochKey(epoch: number): string {
  assert(Number.isInteger(epoch), "workspace memory policy epoch must be an integer");
  return String(epoch);
}

export function workspaceMemoryWritableForEpoch(
  entry: WorkspaceConfigEntry,
  epoch: number
): boolean | undefined {
  return entry.workspaceMemoryWritableByEpoch?.[epochKey(epoch)];
}

/** Record `writable` for `epoch`; drops the oldest records beyond the retained window. */
export function setWorkspaceMemoryWritableForEpoch(
  entry: WorkspaceConfigEntry,
  epoch: number,
  writable: boolean
): void {
  const next: Record<string, boolean> = {
    ...entry.workspaceMemoryWritableByEpoch,
    [epochKey(epoch)]: writable,
  };
  const keys = Object.keys(next).sort((a, b) => Number(b) - Number(a));
  for (const key of keys.slice(WORKSPACE_MEMORY_POLICY_EPOCHS_RETAINED)) delete next[key];
  entry.workspaceMemoryWritableByEpoch = next;
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

import { isWorkspaceArchived } from "./archive";

/**
 * Determine if a workspace is effectively pinned.
 *
 * A workspace is pinned only when all of the following hold:
 * - `pinnedAt` is set
 * - the workspace is not archived (archive clears pins; stale timestamps are ignored)
 * - it is a root workspace (sub-agents follow their parent and are never pinned themselves)
 *
 * Single definition shared by sorting, age-bucketing, and UI affordances so a stale or
 * malformed `pinnedAt` (e.g. on a child workspace) can never detach a row from its parent.
 */
export function isWorkspacePinned(workspace: {
  pinnedAt?: string;
  archivedAt?: string;
  unarchivedAt?: string;
  parentWorkspaceId?: string;
}): boolean {
  return Boolean(workspace.pinnedAt) && isWorkspacePinnable(workspace);
}

/**
 * Whether the pin/unpin action applies to this workspace at all: only live
 * (non-archived) root chats are pinnable. UI entry points hide the action when
 * this is false; the backend enforces the same rule in setPinned.
 */
export function isWorkspacePinnable(workspace: {
  archivedAt?: string;
  unarchivedAt?: string;
  parentWorkspaceId?: string;
}): boolean {
  if (workspace.parentWorkspaceId) return false;
  return !isWorkspaceArchived(workspace.archivedAt, workspace.unarchivedAt);
}

/**
 * Unparseable/missing pinnedAt sorts first (same fallback the sidebar sort
 * always used). Corrupted boundary timestamps get the same treatment so the
 * comparator, the reorder re-deal, and the successor scan agree: the corrupted
 * row sits stably at the top of the pinned block while new pins keep appending
 * at the bottom, and any reorder re-deals it to a sane value.
 */
function parsePinnedAtMs(pinnedAt: string | undefined): number {
  return pinnedAtMsForSuccessorScan(pinnedAt) ?? 0;
}

/**
 * Highest sane pinnedAt epoch ms: one below the maximum representable Date so
 * every accepted value still has a serializable +1ms successor. pinnedAt is
 * persisted as an unrestricted string, so a corrupted-but-parseable boundary
 * timestamp (e.g. "+275760-09-13T00:00:00.000Z") would otherwise poison every
 * monotonic successor computation: max + 1ms leaves the representable range
 * and toISOString() throws, permanently blocking pinning. Ordering and
 * successor scans treat values above this as absent (self-healing), and
 * generated timestamps clamp to it so they stay valid for later scans; ties at
 * the clamp fall back to the comparator's id tie-break.
 */
const MAX_PINNED_AT_MS = 8_640_000_000_000_000 - 1;

/** Epoch ms of a sane pinnedAt (parseable, within MAX_PINNED_AT_MS), else null. */
function pinnedAtMsForSuccessorScan(pinnedAt: string | undefined): number | null {
  if (!pinnedAt) return null;
  const ms = new Date(pinnedAt).getTime();
  return Number.isFinite(ms) && ms <= MAX_PINNED_AT_MS ? ms : null;
}

/**
 * Monotonic pin timestamp: strictly greater than every existing
 * (representable) pin so rapid pins always append deterministically, even if
 * the wall clock is skewed or several pins land within the same millisecond.
 * The scan is global (all projects), keeping the flat sidebar's unified pinned
 * block appending at the bottom. Shared by the backend and the client's
 * optimistic update so the optimistic row lands where the authoritative
 * metadata will place it.
 */
export function nextMonotonicPinnedAtIso(
  existingPinnedAts: Iterable<string | undefined>,
  nowMs: number = Date.now()
): string {
  let pinnedAtMs = Math.min(nowMs, MAX_PINNED_AT_MS);
  for (const value of existingPinnedAts) {
    const ms = pinnedAtMsForSuccessorScan(value);
    if (ms !== null && ms >= pinnedAtMs) pinnedAtMs = Math.min(ms + 1, MAX_PINNED_AT_MS);
  }
  return new Date(pinnedAtMs).toISOString();
}

/**
 * Ordering key for a newly pinned chat plus any write-path healing. Normally
 * mints max+1ms (see nextMonotonicPinnedAtIso) and changes nothing else. When
 * the successor saturates at the sane cap (reachable only through corrupted
 * persisted state), no strictly-greater sane key exists, so every currently
 * pinned entry is renumbered compactly below nowMs in its current visual
 * order: ordering keys stay unique, append order survives, and future pins
 * regain their full headroom (write-path self-healing).
 */
export function appendPinnedTimestamp(
  pinned: ReadonlyArray<{ id?: string; pinnedAt?: string }>,
  nowMs: number = Date.now()
): { changed: Map<string, string>; pinnedAt: string } {
  const pinnedAt = nextMonotonicPinnedAtIso(
    pinned.map((entry) => entry.pinnedAt),
    nowMs
  );
  // Collision detection compares parsed values: JavaScript accepts multiple
  // string representations of the same capped millisecond, so raw string
  // equality would miss noncanonical duplicates.
  const pinnedAtMs = new Date(pinnedAt).getTime();
  if (!pinned.some((entry) => pinnedAtMsForSuccessorScan(entry.pinnedAt) === pinnedAtMs)) {
    return { changed: new Map(), pinnedAt };
  }
  const order = pinned.filter((entry) => entry.pinnedAt).sort(comparePinnedOrderLoose);
  const changed = new Map<string, string>();
  order.forEach((entry, index) => {
    const iso = new Date(nowMs - order.length + index).toISOString();
    if (entry.id !== undefined && entry.pinnedAt !== iso) {
      changed.set(entry.id, iso);
    }
  });
  return { changed, pinnedAt: new Date(nowMs).toISOString() };
}

/** comparePinnedOrder for entries whose id may be missing (config rows). */
function comparePinnedOrderLoose(
  a: { id?: string; pinnedAt?: string },
  b: { id?: string; pinnedAt?: string }
): number {
  return comparePinnedOrder(
    { id: a.id ?? "", pinnedAt: a.pinnedAt },
    { id: b.id ?? "", pinnedAt: b.pinnedAt }
  );
}

/**
 * Stable pinned-block comparator: pinnedAt ascending (new pins append at the
 * bottom of the pinned block), workspace id as deterministic tie-breaker.
 * Shared by frontend sorting and the backend reorder path so both derive the
 * same current order.
 */
export function comparePinnedOrder(
  a: { id: string; pinnedAt?: string },
  b: { id: string; pinnedAt?: string }
): number {
  const aPinnedAt = parsePinnedAtMs(a.pinnedAt);
  const bPinnedAt = parsePinnedAtMs(b.pinnedAt);
  if (aPinnedAt !== bPinnedAt) {
    return aPinnedAt - bPinnedAt;
  }
  return a.id < b.id ? -1 : a.id > b.id ? 1 : 0;
}

/**
 * Re-deal an existing pool of pinnedAt timestamps onto a new pinned order.
 *
 * pinnedAt is an ordering key, not a "when pinned" record: reordering permutes
 * the already-persisted timestamps (sorted ascending) onto `orderedIds` instead
 * of minting fresh now() values. Reusing the pool keeps max(pinnedAt) stable so
 * a subsequent pin (max + 1ms) still appends at the bottom, and values never
 * drift into the future. Ties and unparseable values are nudged +1ms so the
 * assigned sequence is strictly monotonic and sorts exactly as `orderedIds`.
 *
 * Returns only the entries whose stored value changes (a single move rewrites
 * just the displaced range, so untouched rows emit no updates).
 */
export function reassignPinnedTimestamps(
  orderedIds: readonly string[],
  currentPinnedAtById: ReadonlyMap<string, string>
): Map<string, string> {
  // Corrupted boundary timestamps re-deal from 0 like unparseable ones so the
  // +1ms nudges below can never leave the representable Date range.
  const poolMs = orderedIds
    .map((id) => parsePinnedAtMs(currentPinnedAtById.get(id)))
    .sort((a, b) => a - b);

  const assignedMs: number[] = [];
  let previousMs = Number.NEGATIVE_INFINITY;
  for (let index = 0; index < orderedIds.length; index++) {
    previousMs = Math.max(poolMs[index], previousMs + 1);
    assignedMs.push(previousMs);
  }
  // Backward clamp: capped values compact strictly below the sane maximum so
  // the assigned sequence stays strictly monotonic (unique keys) and the
  // requested order always persists, even when corrupted pool values tie at
  // the cap.
  for (let index = assignedMs.length - 1; index >= 0; index--) {
    const bound = index === assignedMs.length - 1 ? MAX_PINNED_AT_MS : assignedMs[index + 1] - 1;
    if (assignedMs[index] > bound) assignedMs[index] = bound;
  }

  const changed = new Map<string, string>();
  orderedIds.forEach((id, index) => {
    const iso = new Date(assignedMs[index]).toISOString();
    if (currentPinnedAtById.get(id) !== iso) {
      changed.set(id, iso);
    }
  });
  return changed;
}

/**
 * Recompose a bucket-wide pinned order after one visual block was reordered.
 * Sections partition the sorted list, so each partition renders its own pinned
 * block; walking `fullOrder` and substituting only ids that belong to the
 * reordered block keeps pinned chats in every other partition untouched.
 */
export function recomposePinnedOrder(
  fullOrder: readonly string[],
  blockIds: readonly string[],
  reorderedBlockIds: readonly string[]
): string[] {
  const blockSet = new Set(blockIds);
  let nextReplacement = 0;
  return fullOrder.map((id) => (blockSet.has(id) ? reorderedBlockIds[nextReplacement++] : id));
}

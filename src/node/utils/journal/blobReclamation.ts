/**
 * Shared blob-reclamation helpers for durable-event journals (journal kit
 * companion). Consumers (sandbox vars snapshots, result handles, refinement
 * inverses) each keep their own per-journal incremental state; these helpers
 * hold the two rules every reclamation pass must share:
 * - joint reference safety across event kinds (content addressing can share
 *   one payload between kinds — see canDeleteEvictedBlob), and
 * - newest-first byte-quota retention (see walkBlobQuota).
 * Every decide→delete window must run under the journal's blob lock
 * (DurableEventJournal.withBlobLock) so publishers' put→append windows can
 * never be observed.
 */

import type { BlobRef } from "@/common/types/durableEvent";
import type { BlobMentions, DurableEventJournal } from "./durableEventJournal";

/** One reclaimable blob payload as quota accounting sees it. */
export interface BlobQuotaEntry {
  ref: BlobRef;
  /** Payload size in bytes (recorded on the event or measured at publish). */
  size: number;
}

/** Event kinds whose blob references are governed by a byte quota. */
export type QuotaKind = "result-handle" | "refinement";

/**
 * Per-journal registry of what each quota currently RETAINS, published by
 * every quota pass before it deletes. Joint retention (Codex round 9): a
 * hash mentioned by several kinds used to be undeletable by ANY reclaimer
 * ("only my kind may mention it"), so a guest offloading a result whose
 * serialized bytes equal a prior refinement-captured file version made the
 * shared hash immortal — repeating unique such values bypassed both
 * aggregate quotas. Now a mention only protects a blob while its OWN
 * reclaimer still retains it; deletion happens at the pass of whichever
 * retainer releases the hash last. A kind whose quota has not run this
 * process has no registry entry and retains conservatively (heals on its
 * next pass or the next process's recovery sweep).
 *
 * Entries are stamped with the journal's blob-index epoch (round 14): a
 * foreign process (debug CLI rollback) can append a row that newly RETAINS a
 * hash after a set was published, so a set from an older epoch proves
 * nothing about the current journal and is treated as absent (conservative
 * retain) until that quota's next pass re-derives from the journal.
 */
interface QuotaRetentionEntry {
  refs: ReadonlySet<BlobRef>;
  /** journal.blobIndexEpoch at publish time. */
  epoch: number;
}

const quotaRetention = new WeakMap<DurableEventJournal, Map<QuotaKind, QuotaRetentionEntry>>();

/**
 * Record the refs a quota's latest pass retained (call BEFORE deleting, and
 * only after blobMentionIndex() in the same pass so the epoch is current).
 */
export function publishQuotaRetention(
  journal: DurableEventJournal,
  kind: QuotaKind,
  retained: ReadonlySet<BlobRef>
): void {
  let registry = quotaRetention.get(journal);
  if (!registry) {
    registry = new Map();
    quotaRetention.set(journal, registry);
  }
  registry.set(kind, { refs: retained, epoch: journal.blobIndexEpoch });
}

/**
 * Lazily resolve the LATEST snapshot ref per scope from the journal itself
 * (one read on first use, memoized per pass). The journal — not any cached
 * pointer — is the truth under the blob lock: a stale latest-pointer could
 * authorize deleting a scope's current restore payload. `seed` lets the
 * snapshot reclaimer inject the ref it just published without a read.
 */
export function makeSnapshotLatestResolver(
  journal: DurableEventJournal,
  seed?: { scopeKey: string; ref: BlobRef }
): (scope: string) => Promise<BlobRef | null> {
  let loaded: Promise<Map<string, BlobRef>> | null = null;
  return async (scope: string): Promise<BlobRef | null> => {
    if (seed?.scopeKey === scope) return seed.ref;
    loaded ??= journal.read().then((events) => {
      const latest = new Map<string, BlobRef>();
      for (let i = events.length - 1; i >= 0; i--) {
        const event = events[i];
        if (event.kind !== "sandbox-vars-snapshot") continue;
        if (!latest.has(event.data.scopeKey)) {
          latest.set(event.data.scopeKey, event.data.blobHash);
        }
      }
      return latest;
    });
    return (await loaded).get(scope) ?? null;
  };
}

/**
 * Joint reference safety: an evicted blob may be deleted only when every
 * event kind mentioning its hash has ALSO released it —
 * - turn-envelope / hook-context mentions retain permanently: replay purity
 *   requires those payloads for the life of the session, and they are not a
 *   guest-controlled repetition vector (each hash requires an actual turn,
 *   so a guest cannot mint unbounded unique envelope-mentioned hashes);
 * - quota kinds (result-handle, refinement) release a hash once their pass
 *   no longer retains it (see publishQuotaRetention); a quota that never ran
 *   this process — or whose set predates the current blob-index epoch and so
 *   cannot know about foreign appends — retains conservatively;
 * - snapshot mentions release once the hash is no longer the LATEST snapshot
 *   of any mentioning scope (superseded payloads are pure disk growth).
 * Callers must hold the journal blob lock and must have published their own
 * quota's retained set (or, for snapshots, guarantee candidates are
 * superseded) before calling.
 */
export async function canDeleteEvictedBlob(args: {
  journal: DurableEventJournal;
  ref: BlobRef;
  mentions: BlobMentions | undefined;
  resolveLatestSnapshot: (scope: string) => Promise<BlobRef | null>;
}): Promise<boolean> {
  const { journal, ref, mentions } = args;
  // Candidates come from journal events, so an unindexed ref means the index
  // and the journal disagree — retain, never guess.
  if (mentions === undefined) return false;
  for (const kind of mentions.kinds) {
    switch (kind) {
      case "turn-envelope":
      case "hook-context":
        return false;
      case "result-handle":
      case "refinement": {
        const entry = quotaRetention.get(journal)?.get(kind);
        if (entry === undefined || entry.epoch !== journal.blobIndexEpoch || entry.refs.has(ref)) {
          return false;
        }
        break;
      }
      case "sandbox-vars-snapshot": {
        for (const scope of mentions.snapshotScopes) {
          if ((await args.resolveLatestSnapshot(scope)) === ref) return false;
        }
        break;
      }
      default: {
        // A future event kind without reclamation semantics must retain.
        const exhaustive: never = kind;
        void exhaustive;
        return false;
      }
    }
  }
  return true;
}

/**
 * The newest-first quota walk shared by recovery sweeps (all journal rows)
 * and incremental passes (previous retained list + newly published entries).
 * Content addressing can repeat a ref; its NEWEST occurrence decides
 * retention (duplicates are one blob, counted once). Note the walk keeps
 * accumulating after an entry fails to fit, so an older-but-smaller payload
 * can stay retained past a newer oversized one — retention is per-entry
 * "fits the remaining quota", not a suffix cut.
 */
export function walkBlobQuota(
  entries: BlobQuotaEntry[],
  quotaBytes: number
): { retained: BlobQuotaEntry[]; evictable: Set<BlobRef> } {
  const seen = new Set<BlobRef>();
  const retained: BlobQuotaEntry[] = [];
  const evictable = new Set<BlobRef>();
  let retainedBytes = 0;
  for (const entry of entries) {
    if (seen.has(entry.ref)) continue;
    seen.add(entry.ref);
    if (retainedBytes + entry.size <= quotaBytes) {
      retainedBytes += entry.size;
      retained.push(entry);
    } else {
      evictable.add(entry.ref);
    }
  }
  return { retained, evictable };
}

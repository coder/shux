/**
 * DurableEventJournal: the concrete per-session journal for the shared
 * durable-event schema (src/common/types/durableEvent.ts), pairing the generic
 * Journal with a content-addressed BlobStore.
 *
 * Layout inside a session dir:
 * - `durable-events.jsonl` — one DurableEvent per line
 * - `blobs/<hash[0:2]>/<hash>` — content-addressed payloads
 *
 * This is the durable leg of the event spine's three-way split. New consumers
 * (turn envelopes, refinement journal, result handles) append here; the
 * HistoryService/chat.jsonl family intentionally stays as-is.
 */

import assert from "node:assert";
import crypto from "node:crypto";
import * as fs from "fs/promises";
import * as path from "path";
import {
  DurableEventSchema,
  DURABLE_EVENT_VERSION,
  type BlobRef,
  type DurableEvent,
  type DurableEventDraft,
} from "@/common/types/durableEvent";
import { AsyncMutex } from "@/node/utils/concurrency/asyncMutex";
import { acquireProcessFileLock, type ProcessFileLock } from "@/node/utils/concurrency/fileLock";
import { Journal } from "./journal";
import { BlobStore } from "./blobStore";

export const DURABLE_EVENTS_FILE_NAME = "durable-events.jsonl";
export const BLOBS_DIR_NAME = "blobs";
export const BLOB_LOCK_FILE_NAME = "blobs.lock";

/**
 * Bound on waiting for the cross-process blob lock. Holders include
 * once-per-process recovery sweeps (journal read + per-blob stats), so this
 * is more generous than the append lock's 5s; hitting it means another
 * process is wedged, and failing the operation (all blob-lock consumers are
 * best-effort or self-healing) beats deciding reclamation from an
 * unserialized view.
 */
const BLOB_LOCK_TIMEOUT_MS = 10_000;

/**
 * Process-wide journal registry keyed by resolved session dir. Multiple
 * producers (turn envelopes, hook context, sandbox vars snapshots) append to
 * the same durable-events.jsonl; independent instances would each cache their
 * own next sequence number and could reuse or regress `seq`, corrupting the
 * journal's global event ordering. All live writers must obtain their journal
 * here — blob reclamation additionally relies on it (the blob lock and the
 * blob-mention index are per-instance). Entries are tiny and live for the
 * process.
 */
const sharedJournals = new Map<string, DurableEventJournal>();

export function sharedDurableEventJournal(sessionDir: string): DurableEventJournal {
  const key = path.resolve(sessionDir);
  let journal = sharedJournals.get(key);
  if (!journal) {
    journal = new DurableEventJournal(sessionDir);
    sharedJournals.set(key, journal);
  }
  return journal;
}

/**
 * Which events mention a blob ref, summarized for reclamation decisions.
 * `kinds` answers "which event kinds reference this blob"; snapshot
 * reclamation is additionally per-scope, so sandbox-vars-snapshot mentions
 * also record their scopeKey. Journal rows are never removed, so mentions
 * only accumulate and plain sets (not counts) suffice.
 */
export interface BlobMentions {
  kinds: Set<DurableEvent["kind"]>;
  /** scopeKeys of sandbox-vars-snapshot rows mentioning the ref. */
  snapshotScopes: Set<string>;
}

/** Matches BlobRefSchema refs anywhere inside a serialized row. */
const BLOB_REF_MENTION_PATTERN = /sha256:[0-9a-f]{64}/g;

/**
 * Record every blob ref mentioned by `event`. Serialized containment (rather
 * than a per-kind field list) so every current and future event kind that
 * embeds a blob hash is honored; 64-hex-char refs make false positives a
 * non-concern (a false positive merely retains a blob).
 */
function indexBlobMentions(index: Map<BlobRef, BlobMentions>, event: DurableEvent): void {
  const serialized = JSON.stringify(event);
  for (const match of serialized.matchAll(BLOB_REF_MENTION_PATTERN)) {
    const ref = match[0];
    let mentions = index.get(ref);
    if (!mentions) {
      mentions = { kinds: new Set(), snapshotScopes: new Set() };
      index.set(ref, mentions);
    }
    mentions.kinds.add(event.kind);
    if (event.kind === "sandbox-vars-snapshot") {
      mentions.snapshotScopes.add(event.data.scopeKey);
    }
  }
}

export class DurableEventJournal {
  private readonly journal: Journal<DurableEvent>;
  /** Blob store for content-addressed payloads referenced from rows. */
  public readonly blobs: BlobStore;
  private readonly journalFilePath: string;
  private readonly blobLockPath: string;
  /** In-process leg of the blob lock (fairness + reentrancy assertions);
   * the cross-process leg is the blobs.lock file (see withBlobLock). */
  private readonly blobLock = new AsyncMutex();
  /** The live blobs.lock handle while withBlobLock runs (one holder at a
   * time — the mutex serializes in-process callers). Lets critical blob
   * mutations re-verify cross-process ownership without signature changes. */
  private activeBlobFileLock: ProcessFileLock | null = null;
  /**
   * Lazily built blob-mention index (see indexBlobMentions), maintained
   * incrementally on append so reclamation passes do O(1) reference lookups
   * instead of re-reading the journal on every persist. Entries are tiny and
   * bounded by journal size; rows are never removed, so it only grows.
   */
  private blobMentions: Map<BlobRef, BlobMentions> | null = null;
  /**
   * Journal file size up to which blobMentions is verifiably complete; null
   * while no index exists. Our own appends advance it contiguously (see the
   * onAppended hook); a stat mismatch at blobMentionIndex() means a FOREIGN
   * instance/process appended rows we never indexed, forcing a rebuild —
   * without this, a reclamation pass could delete a blob whose referencing
   * row was appended by the debug CLI after our index was built.
   */
  private mentionSyncSize: number | null = null;
  /**
   * Bumped on every mention-index (re)build — i.e. whenever foreign appends
   * were detected (or on the first build). Derived reclamation caches
   * (per-quota retained sets, incremental retained lists) record the epoch
   * they were computed at and must re-derive from the journal when it moved:
   * a foreign process (debug CLI rollback) can append rows that RETAIN a
   * hash this process's caches believe released (round 14).
   */
  private mentionEpoch = 0;

  constructor(sessionDir: string) {
    this.journalFilePath = path.join(sessionDir, DURABLE_EVENTS_FILE_NAME);
    this.blobLockPath = path.join(sessionDir, BLOB_LOCK_FILE_NAME);
    this.journal = new Journal<DurableEvent>({
      filePath: this.journalFilePath,
      schema: DurableEventSchema,
      getSeq: (row) => row.seq,
      getId: (row) => row.id,
      onAppended: (row, sizes) => {
        // Keep the lazily-built blob-mention index current (see
        // blobMentionIndex). Runs synchronously inside the append's exclusive
        // section so the index can never expose an appended-but-unindexed row.
        if (this.blobMentions === null) return;
        indexBlobMentions(this.blobMentions, row);
        // Advance the freshness watermark only when this append extended the
        // exact file state we had indexed; any gap (foreign bytes) leaves the
        // watermark behind so the next blobMentionIndex() stat forces a
        // rebuild. A mid-rebuild append leaves mentionSyncSize null and is
        // covered by the rebuild's own read + this idempotent indexing.
        if (this.mentionSyncSize !== null && this.mentionSyncSize === sizes.preAppendFileSize) {
          this.mentionSyncSize = sizes.postAppendFileSize;
        }
      },
    });
    this.blobs = new BlobStore(path.join(sessionDir, BLOBS_DIR_NAME));
  }

  /** Append a draft; the journal assigns v/seq/ts (and id unless provided). */
  async append(draft: DurableEventDraft): Promise<DurableEvent> {
    return await this.journal.append((seq) => {
      const built = {
        ...draft,
        v: DURABLE_EVENT_VERSION,
        seq,
        id: draft.id ?? crypto.randomUUID(),
        ts: Date.now(),
      };
      // The spread of a distributive draft union does not re-narrow to the
      // discriminated union; the journal schema-validates the row on append.
      return built as DurableEvent;
    });
  }

  /** Read all events (self-healed: malformed/duplicate rows dropped, seq order). */
  async read(): Promise<DurableEvent[]> {
    return this.journal.read();
  }

  /**
   * Run `fn` while holding this journal's blob lock. Producers pairing
   * `blobs.put()` with a later `append()` MUST do both inside one locked
   * section: content addressing means a concurrent reclamation pass could
   * otherwise observe the blob during the put→append window, find no event
   * referencing its hash, and delete it — permanently breaking the event
   * about to be appended. Reclamation passes hold the same lock across their
   * whole decide→delete window. Non-reentrant: do not nest (including
   * publishWithBlob, which takes the lock itself).
   *
   * Two-level like the journal's append serialization: the in-process mutex
   * orders callers on this instance cheaply, and a cross-process lockfile
   * (blobs.lock, same protocol as the append lock) excludes OTHER journal
   * instances — the debug rollback CLI publishes inverse blobs from its own
   * process, and without the file lock the live app's reclamation could
   * observe (and delete inside) that publisher's put→append window.
   * Lock order is blob → append (fn's appends take the append lock);
   * nothing acquires them in the opposite order, so no deadlock.
   */
  async withBlobLock<T>(fn: () => Promise<T>): Promise<T> {
    await using _mutex = await this.blobLock.acquire();
    await using fileLock = await acquireProcessFileLock({
      lockPath: this.blobLockPath,
      timeoutMs: BLOB_LOCK_TIMEOUT_MS,
      label: "blob lock",
    });
    this.activeBlobFileLock = fileLock;
    try {
      return await fn();
    } finally {
      this.activeBlobFileLock = null;
    }
  }

  /**
   * Re-verify cross-process blob-lock ownership from inside a withBlobLock
   * section. Defense in depth (round 11): the lock protocol makes wrongful
   * displacement practically impossible but not provably impossible on
   * birth-less platforms; critical blob mutations verify immediately before
   * acting so a displaced holder aborts instead of racing the new owner.
   */
  async assertBlobLockOwned(): Promise<void> {
    assert(
      this.blobLock.isLocked && this.activeBlobFileLock !== null,
      "assertBlobLockOwned requires holding withBlobLock"
    );
    await this.activeBlobFileLock.assertStillOwned();
  }

  /**
   * Delete a blob payload from inside a withBlobLock section, re-verifying
   * ownership immediately before the irreversible unlink. All reclamation
   * delete loops MUST use this instead of blobs.delete: a wrongfully
   * displaced reclaimer could otherwise delete a blob the new lock owner is
   * concurrently publishing.
   */
  async deleteBlobUnderLock(ref: BlobRef): Promise<void> {
    await this.assertBlobLockOwned();
    await this.blobs.delete(ref);
  }

  /**
   * Store a blob and append the event referencing it as one atomic unit with
   * respect to blob reclamation (see withBlobLock).
   *
   * `options.precondition` (r52) runs INSIDE the blob lock before anything
   * is stored; a throw aborts the publish with no blob and no row. Because
   * every publisher serializes on the same cross-process blob lock, this
   * lets a producer verify journal state that a concurrent foreign
   * publication could invalidate (e.g. a stale vars snapshot racing a
   * context-reset tombstone) with no check→append window.
   */
  async publishWithBlob(
    content: string | Uint8Array,
    buildDraft: (ref: BlobRef, size: number) => DurableEventDraft,
    options?: { precondition?: () => Promise<void> }
  ): Promise<{ event: DurableEvent; ref: BlobRef; size: number }> {
    return await this.withBlobLock(async () => {
      await options?.precondition?.();
      const { ref, size, created } = await this.blobs.put(content);
      try {
        // Ownership re-check between put and append (round 11 defense in
        // depth): if this holder was wrongfully displaced, a reclaimer may
        // have deleted the just-put blob — appending would then create a row
        // permanently referencing a missing payload. Abort instead.
        await this.assertBlobLockOwned();
        const event = await this.append(buildDraft(ref, size));
        return { event, ref, size };
      } catch (error) {
        // A blob whose row never landed would leak forever: reclamation
        // derives its candidates from journal references, so it never even
        // considers an unreferenced file. Restore the pre-put state — but
        // ONLY when this put created the file: content-addressed dedup means
        // a pre-existing blob with the same hash may be referenced by
        // earlier rows. deleteBlobUnderLock re-verifies ownership, so a
        // displaced holder skips the delete instead of racing a new owner
        // who may already reference the hash. That skip — and a crash
        // anywhere in this window — can still leave an orphan; accepted as
        // bounded (one blob per failed publish) rather than adding a
        // startup mark-and-sweep.
        if (created) {
          try {
            await this.deleteBlobUnderLock(ref);
          } catch {
            // Best-effort: never mask the original publish failure.
          }
        }
        throw error;
      }
    });
  }

  /**
   * Blob-mention index for reclamation decisions. Callers MUST hold the blob
   * lock: decisions on the index are only race-free while publishers are
   * excluded. Freshness is verified against the journal file size
   * (mentionSyncSize): our own appends advance the watermark incrementally,
   * while foreign appends (a second in-process instance, or the debug CLI in
   * another process) leave a size gap that forces a rebuild here — foreign
   * publishers hold the cross-process blob lock, so their rows are fully
   * appended (and thus visible to the rebuild's read) before we run.
   */
  async blobMentionIndex(): Promise<ReadonlyMap<BlobRef, BlobMentions>> {
    assert(this.blobLock.isLocked, "blobMentionIndex requires holding withBlobLock");
    const fileSize = await this.journalFileSize();
    if (this.blobMentions !== null && this.mentionSyncSize === fileSize) {
      return this.blobMentions;
    }
    // Foreign rows entered the journal (or this is the first build): move the
    // epoch so derived reclamation caches re-derive before releasing blobs.
    this.mentionEpoch += 1;
    // Install the map BEFORE the read: own appends that interleave with the
    // read index themselves into it (see onAppended), and set semantics make
    // the potential double-indexing of one row idempotent. The watermark is
    // set only AFTER the read completes so an interleaved own append (whose
    // watermark advance sees null and skips) triggers at most a harmless
    // extra rebuild, never a stale-marked-fresh index.
    const index = new Map<BlobRef, BlobMentions>();
    this.blobMentions = index;
    this.mentionSyncSize = null;
    for (const event of await this.read()) {
      indexBlobMentions(index, event);
    }
    this.mentionSyncSize = await this.journalFileSize();
    return index;
  }

  /**
   * Epoch of the current blob-mention index (see mentionEpoch). Meaningful
   * only under the blob lock AFTER calling blobMentionIndex() in the same
   * pass — that call is what detects foreign appends and moves the epoch.
   */
  get blobIndexEpoch(): number {
    return this.mentionEpoch;
  }

  /** Journal file size in bytes; 0 when the file does not exist yet. */
  private async journalFileSize(): Promise<number> {
    try {
      return (await fs.stat(this.journalFilePath)).size;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") {
        return 0;
      }
      throw error;
    }
  }
}

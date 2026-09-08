import { randomUUID } from "node:crypto";
import { isDeepStrictEqual } from "node:util";
import { z } from "zod";
import type { MuxMessage } from "@/common/types/message";
import type { HistoryService } from "./historyService";

export const CompactionCancellationSchema = z.object({
  version: z.literal(1),
  nonce: z.string().min(1),
  retainUntilReplacement: z.boolean().optional(),
  scope: z.discriminatedUnion("kind", [
    z.object({ kind: z.literal("unresolved") }),
    z.object({
      kind: z.literal("summary"),
      id: z.string(),
      sequence: z.number().optional(),
      pendingFollowUp: z.record(z.string(), z.unknown()),
    }),
  ]),
});
export type CompactionCancellationRecord = z.infer<typeof CompactionCancellationSchema>;

/** Process-local retry ownership; durable nonce + epoch prevent adopting foreign mutations. */
export interface CompactionCancellationPublication {
  attempts: number;
  predecessor?: { nonce: string | null | undefined; generation: string | undefined };
}

/** Only successfully read bytes with invalid JSON/schema may enter automatic repair. */
export class MalformedCompactionCancellationError extends Error {
  constructor(readonly contents: Uint8Array) {
    super("Malformed compaction cancellation record");
  }
}

/** Cancellation publication survives failed preparation, independently of turn admission epochs. */
export class CompactionCancellation {
  private current: CompactionCancellationRecord | null | undefined;
  private generation = 0;
  private repairedHistoryRevision = 0;
  private replacementNonce?: string;
  private pending: Promise<void> = Promise.resolve();
  private unsettled = false;
  private mutation?: {
    record: CompactionCancellationRecord | null;
    retiredNonce?: string;
    publication?: CompactionCancellationPublication;
  };

  constructor(
    private readonly history: HistoryService,
    private readonly workspaceId: string
  ) {}

  get needsPersistence(): boolean {
    return this.unsettled;
  }

  get blocksRecovery(): boolean {
    return this.unsettled && !this.isWitnessedRetirement();
  }

  private isWitnessedRetirement(): boolean {
    return this.mutation?.record === null && this.mutation.retiredNonce === this.replacementNonce;
  }

  private effectiveRecord(): CompactionCancellationRecord | null {
    return this.current?.nonce === this.replacementNonce ? null : (this.current ?? null);
  }

  get repairRevision(): number {
    return this.repairedHistoryRevision;
  }

  async read(): Promise<CompactionCancellationRecord | null> {
    // Other backends can publish Stop after a previous read (including absence).
    // Local in-flight/failed mutations still own their conservative exclusion.
    if (this.unsettled && !this.isWitnessedRetirement()) return this.effectiveRecord();
    const generation = this.generation;
    const mutation = this.mutation;
    const isCurrent = () => generation === this.generation && mutation === this.mutation;
    try {
      const record = await this.history
        .readCompactionCancellation(this.workspaceId)
        .catch((error: unknown) => {
          if (!(error instanceof MalformedCompactionCancellationError) || !isCurrent()) throw error;
          return this.history.repairCompactionCancellation(this.workspaceId, isCurrent, () => {
            this.repairedHistoryRevision++;
          });
        });
      if (isCurrent()) this.current = record;
    } catch (error) {
      // An obsolete read must not trigger explicit repair over a newer local Stop.
      if (isCurrent()) throw error;
    }
    return this.effectiveRecord();
  }

  cancel(options?: { retainUntilReplacement?: boolean }): Promise<void> {
    // Each explicit Stop is new intent, even during a previous retirement's
    // post-commit await. Only retry() may reuse publication identity.
    this.current = {
      version: 1,
      nonce: randomUUID(),
      scope: { kind: "unresolved" },
      ...(options?.retainUntilReplacement || this.current?.retainUntilReplacement
        ? { retainUntilReplacement: true }
        : {}),
    };
    this.generation++;
    return this.persist(this.current, undefined, { attempts: 0 });
  }

  async readForReplacement(): Promise<CompactionCancellationRecord | null> {
    for (;;) {
      // An unpublished nonce cannot pass the shared append CAS. Repair only the
      // latest blocking publication; witnessed unlink debt remains ancillary.
      if (this.blocksRecovery) {
        const pending = this.pending;
        try {
          await pending;
        } catch {
          // Join first, then retry only the exact failed publication. Concurrent
          // readers share the retry instead of continually superseding one another.
          if (pending !== this.pending) continue;
          const retried = this.retry();
          try {
            await retried;
          } catch (error) {
            if (retried === this.pending) throw error;
          }
        }
        continue;
      }
      let record: CompactionCancellationRecord | null;
      try {
        record = await this.read();
      } catch {
        // Explicit intervention can replace corrupt/unreadable state with a
        // conservative fence, but failed publication must remain visible.
        await this.cancel();
        continue;
      }
      if (!this.blocksRecovery) return record;
    }
  }

  async narrow(nonce: string, summary: MuxMessage): Promise<void> {
    // Exact CAS cannot turn a failed initial publication into apparent success.
    await this.pending;
    if (
      this.current?.nonce !== nonce ||
      this.current.scope.kind !== "unresolved" ||
      this.current.retainUntilReplacement
    )
      return;
    const metadata = summary.metadata?.muxMetadata;
    if (!metadata || !("pendingFollowUp" in metadata) || !metadata.pendingFollowUp) return;
    this.current = {
      ...this.current,
      scope: {
        kind: "summary",
        id: summary.id,
        sequence: summary.metadata?.historySequence,
        pendingFollowUp: { ...structuredClone(metadata.pendingFollowUp) },
      },
    };
    await this.persist(this.current);
  }

  matches(record: CompactionCancellationRecord, summary: MuxMessage): boolean {
    return matchesCompactionCancellation(record, summary);
  }

  async flush(): Promise<void> {
    // An obsolete publication may have become a no-op behind a newer Stop.
    // Success acknowledges the latest mutation, never an absent superseded write.
    for (;;) {
      const pending = this.pending;
      try {
        await pending;
      } catch (error) {
        if (pending !== this.pending) continue;
        if (!this.isWitnessedRetirement()) throw error;
      }
      if (pending === this.pending) return;
    }
  }

  retireReplacement(nonce: string): Promise<void> {
    if (this.current?.nonce !== nonce) return Promise.resolve();
    // Only callers holding an actual durable row witness may retire intent before
    // unlink succeeds. The physical deletion mutation remains observable/retryable.
    this.replacementNonce = nonce;
    return this.retire(nonce);
  }

  retry(): Promise<void> {
    return this.unsettled && this.mutation
      ? this.persist(this.mutation.record, this.mutation.retiredNonce, this.mutation.publication)
      : this.pending;
  }

  retire(nonce: string): Promise<void> {
    if (
      this.current?.nonce !== nonce ||
      (this.current.retainUntilReplacement && this.replacementNonce !== nonce)
    )
      return Promise.resolve();
    this.generation++;
    // Keep conservative exclusion in memory until deletion really commits. The
    // retry payload remains a deletion, not a republication of that read state.
    return this.persist(null, nonce);
  }

  private persist(
    snapshot: CompactionCancellationRecord | null,
    retiredNonce?: string,
    publication?: CompactionCancellationPublication
  ): Promise<void> {
    const generation = this.generation;
    const mutation = { record: snapshot, retiredNonce, publication };
    this.mutation = mutation;
    this.unsettled = true;
    const result = this.pending
      .catch(() => undefined)
      .then(async () => {
        if (publication) publication.attempts++;
        await this.history.writeCompactionCancellation(
          this.workspaceId,
          snapshot,
          () => this.generation === generation,
          retiredNonce,
          publication
        );
        if (this.generation === generation && this.mutation === mutation) {
          this.unsettled = false;
          if (snapshot === null && this.current?.nonce === retiredNonce) this.current = null;
        }
      });
    this.pending = result;
    return result;
  }
}

/** Shared by unlocked policy checks and the locked follow-up append admission. */
export function matchesCompactionCancellation(
  record: CompactionCancellationRecord,
  summary: MuxMessage
): boolean {
  if (record.scope.kind === "unresolved") return true;
  const metadata = summary.metadata?.muxMetadata;
  return (
    record.scope.id === summary.id &&
    record.scope.sequence === summary.metadata?.historySequence &&
    isDeepStrictEqual(
      record.scope.pendingFollowUp,
      metadata && "pendingFollowUp" in metadata ? metadata.pendingFollowUp : undefined
    )
  );
}

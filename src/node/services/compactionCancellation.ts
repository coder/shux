import { randomUUID } from "node:crypto";
import { isDeepStrictEqual } from "node:util";

export interface CompactionCancellationSummary {
  id: string;
  sequence?: number;
  pendingFollowUp: Record<string, unknown>;
}

export interface CompactionCancellationRecord {
  version: 1;
  nonce: string;
  retainUntilReplacement?: boolean;
  scope: { kind: "unresolved" } | ({ kind: "summary" } & CompactionCancellationSummary);
}

export interface CompactionCancellationPublication {
  attempts: number;
  // The adapter records each admitted/advanced frontier BEFORE any subsequent failing await.
  // Retries reuse this object; an unobserved attempt must never adopt a foreign frontier.
  predecessor?: { nonce: string | null | undefined; generation: string | undefined };
}

/** Issued only after an exact replacement row is durably committed or found in history. */
export interface CompactionCancellationReplacementWitness {
  readonly nonce: string;
}

export type CompactionCancellationMutation =
  | {
      kind: "publish";
      record: CompactionCancellationRecord;
      publication: CompactionCancellationPublication;
    }
  | { kind: "narrow"; record: CompactionCancellationRecord }
  | {
      kind: "retire";
      nonce: string;
      replacementWitness?: CompactionCancellationReplacementWitness;
    };

export type CompactionCancellationMutationOutcome = "applied" | "superseded";

/** Only successfully read bytes with invalid JSON/schema authorize automatic repair. */
export class MalformedCompactionCancellationError extends Error {}

export interface CompactionCancellationStorage {
  /** Fresh shared state; absence and unreadable I/O must remain distinguishable. */
  read(): Promise<CompactionCancellationRecord | null>;
  /**
   * Atomically compare nonce/frontier and mutate under the shared history lock, checking
   * isCurrent immediately before publication. Preserve inherited retention, including an
   * unreadable predecessor. Retirement requires the exact nonce and, for retained records,
   * a verified replacement witness. Superseded means no authority to apply this mutation.
   */
  mutate(
    mutation: CompactionCancellationMutation,
    isCurrent: () => boolean
  ): Promise<CompactionCancellationMutationOutcome>;
  /**
   * Re-read under the lock; preserve newer valid records. Neutralize obsolete recovery
   * before removing malformed bytes, preserve privacy floors, and call onCommitted
   * synchronously when repair commits. Never repair an ordinary read/I/O failure.
   */
  repair(
    isCurrent: () => boolean,
    onCommitted: () => void
  ): Promise<CompactionCancellationRecord | null>;
}

/**
 * Inactive cancellation state core. Stop's retry identity outlives failed turn preparation;
 * a later delivery must supply the storage adapter and activate every recovery consumer.
 * Injected-adapter tests establish state invariants, not filesystem or cross-process CAS.
 */
export class CompactionCancellation {
  private current?: CompactionCancellationRecord | null;
  private replacementNonce?: string;
  private mutation?: CompactionCancellationMutation;
  private pending: Promise<CompactionCancellationMutationOutcome | undefined> =
    Promise.resolve(undefined);
  private unsettled = false;
  private inFlight = false;
  private repairedHistoryRevision = 0;

  constructor(private readonly storage: CompactionCancellationStorage) {}

  get needsPersistence(): boolean {
    return this.unsettled;
  }

  get blocksRecovery(): boolean {
    return this.unsettled && !this.isWitnessedRetirement();
  }

  get repairRevision(): number {
    return this.repairedHistoryRevision;
  }

  private isWitnessedRetirement(): boolean {
    return (
      this.mutation?.kind === "retire" &&
      this.mutation.replacementWitness?.nonce === this.mutation.nonce
    );
  }

  private effectiveRecord(): CompactionCancellationRecord | null {
    // Callers cannot mutate a captured cancellation or its exact pending-request identity.
    return structuredClone(
      this.current?.nonce === this.replacementNonce ? null : (this.current ?? null)
    );
  }

  async read(): Promise<CompactionCancellationRecord | null> {
    if (this.blocksRecovery) return this.effectiveRecord();
    const mutation = this.mutation;
    const pending = this.pending;
    const isCurrent = () => mutation === this.mutation && pending === this.pending;
    try {
      const record = await this.storage.read().catch((error: unknown) => {
        if (!(error instanceof MalformedCompactionCancellationError) || !isCurrent()) throw error;
        return this.storage.repair(isCurrent, () => {
          this.repairedHistoryRevision++;
        });
      });
      if (isCurrent()) this.current = structuredClone(record);
    } catch (error) {
      // A stale read/repair cannot hide a newer local Stop or trigger its replacement.
      if (isCurrent()) throw error;
    }
    return this.effectiveRecord();
  }

  cancel(options?: {
    retainUntilReplacement?: boolean;
  }): Promise<CompactionCancellationMutationOutcome> {
    this.current = {
      version: 1,
      nonce: randomUUID(),
      scope: { kind: "unresolved" },
      ...(options?.retainUntilReplacement || this.current?.retainUntilReplacement
        ? { retainUntilReplacement: true }
        : {}),
    };
    return this.persist({ kind: "publish", record: this.current, publication: { attempts: 0 } });
  }

  async readForReplacement(): Promise<CompactionCancellationRecord | null> {
    for (;;) {
      if (this.blocksRecovery) {
        const pending = this.pending;
        const retryFailed = !this.inFlight;
        try {
          await pending;
        } catch (error) {
          // Retry already-failed debt; readers joining an in-flight attempt share its
          // outcome instead of turning one failure into a chain of additional retries.
          if (pending !== this.pending) continue;
          if (!retryFailed) throw error;
          const retried = this.retry();
          try {
            await retried;
          } catch (error) {
            if (retried === this.pending) throw error;
          }
        }
        continue;
      }
      try {
        const record = await this.read();
        if (!this.blocksRecovery) return record;
      } catch {
        // Explicit intervention may replace unreadable state, but cannot lose an unknown
        // full-clear obligation. Failed publication remains blocking and visible.
        await this.cancel({ retainUntilReplacement: true });
      }
    }
  }

  async narrow(nonce: string, summary: CompactionCancellationSummary) {
    const captured = structuredClone(summary);
    const mutation = this.mutation;
    const pending = this.pending;
    await pending;
    // Retirement can claim the same nonce during this join. Narrowing must not
    // supersede its deletion or discard witnessed cleanup debt on resumption.
    if (
      this.mutation !== mutation ||
      this.pending !== pending ||
      this.replacementNonce === nonce ||
      this.current?.nonce !== nonce ||
      this.current.scope.kind !== "unresolved" ||
      this.current.retainUntilReplacement
    )
      return;
    // Failed narrowing must retain the broader exclusion until persistence succeeds.
    return this.persist({
      kind: "narrow",
      record: { ...this.current, scope: { kind: "summary", ...captured } },
    });
  }

  retire(nonce: string) {
    if (this.current?.nonce !== nonce) return Promise.resolve(undefined);
    // A later cleanup request cannot downgrade already-witnessed deletion debt.
    if (this.replacementNonce === nonce) return this.retireReplacement({ nonce });
    if (this.current.retainUntilReplacement) return Promise.resolve(undefined);
    return this.persist({ kind: "retire", nonce });
  }

  retireReplacement(witness: CompactionCancellationReplacementWitness) {
    if (this.current?.nonce !== witness.nonce) return Promise.resolve(undefined);
    this.replacementNonce = witness.nonce;
    return this.persist({
      kind: "retire",
      nonce: witness.nonce,
      replacementWitness: { ...witness },
    });
  }

  retry(): Promise<CompactionCancellationMutationOutcome | undefined> {
    return this.unsettled && !this.inFlight && this.mutation
      ? this.persist(this.mutation)
      : this.pending;
  }

  async flush(): Promise<void> {
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

  private persist(
    mutation: CompactionCancellationMutation
  ): Promise<CompactionCancellationMutationOutcome> {
    this.mutation = mutation;
    this.unsettled = true;
    this.inFlight = true;
    const isCurrent = () => this.mutation === mutation;
    const result = this.pending
      .catch(() => undefined)
      .then(async (): Promise<CompactionCancellationMutationOutcome> => {
        if (!isCurrent()) return "superseded";
        if (mutation.kind === "publish") mutation.publication.attempts++;
        const outcome = await this.storage.mutate(mutation, isCurrent);
        if (isCurrent()) {
          this.unsettled = false;
          this.current =
            outcome === "superseded"
              ? undefined
              : mutation.kind === "retire"
                ? null
                : structuredClone(mutation.record);
        }
        return outcome;
      });
    this.pending = result;
    const settled = () => {
      if (this.pending === result) this.inFlight = false;
    };
    result.then(settled, settled);
    return result;
  }
}

export function matchesCompactionCancellation(
  record: CompactionCancellationRecord,
  summary: CompactionCancellationSummary
): boolean {
  return (
    record.scope.kind === "unresolved" ||
    (record.scope.id === summary.id &&
      record.scope.sequence === summary.sequence &&
      isDeepStrictEqual(record.scope.pendingFollowUp, summary.pendingFollowUp))
  );
}

import { randomUUID } from "node:crypto";
import { isDeepStrictEqual } from "node:util";
import { promises as fs, rmSync } from "node:fs";
import * as path from "node:path";
import { z } from "zod";
import { COMPACTION_CANCELLATION_FILE } from "@/constants/continuousCompaction";
import type { HistoryService } from "./historyService";
import { publishCompactionFile } from "./continuousCompactionJournal";

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

/** Unsupported or oversized records must be preserved instead of repaired or overwritten. */
export class CompactionCancellationReadRefusedError extends Error {}

export interface CompactionCancellationStorage {
  /** Fresh shared state; absence and unreadable I/O must remain distinguishable. */
  read(): Promise<CompactionCancellationRecord | null>;
  /**
   * Atomically compare nonce/frontier and mutate under the shared history lock, checking
   * isCurrent immediately before publication. Preserve inherited retention, including an
   * unreadable predecessor. Retirement requires the exact nonce and, for retained records,
   * a verified replacement witness. Superseded means no authority to apply this mutation.
   * Call onCommitted synchronously at the durable commit/confirmation, before releasing
   * the lock or awaiting cleanup, with inherited retention or null after retirement.
   * Every applied outcome requires this receipt; later failure cannot undo the commit.
   */
  mutate(
    mutation: CompactionCancellationMutation,
    isCurrent: () => boolean,
    onCommitted: (record: CompactionCancellationRecord | null) => undefined
  ): Promise<CompactionCancellationMutationOutcome>;
  /**
   * Re-read under the lock; preserve newer valid records. Neutralize obsolete recovery
   * before removing malformed bytes, preserve privacy floors, and call onCommitted
   * synchronously when repair commits. Never repair an ordinary read/I/O failure.
   * Returning undefined excludes async observers that could publish state too late.
   */
  repair(
    isCurrent: () => boolean,
    onCommitted: () => undefined
  ): Promise<CompactionCancellationRecord | null>;
}

const CancellationRecordSchema = z.strictObject({
  version: z.literal(1),
  nonce: z.string().min(1),
  retainUntilReplacement: z.boolean().optional(),
  scope: z.discriminatedUnion("kind", [
    z.strictObject({ kind: z.literal("unresolved") }),
    z.strictObject({
      kind: z.literal("summary"),
      id: z.string().min(1),
      sequence: z.number().int().nonnegative().optional(),
      pendingFollowUp: z.record(z.string(), z.unknown()),
    }),
  ]),
});

/** Inactive real adapter. H2b supplies accepted-row verification; H2c wires runtime consumers. */
export class FileCompactionCancellationStorage implements CompactionCancellationStorage {
  readonly path: string;

  constructor(
    private readonly history: HistoryService,
    private readonly workspaceId: string,
    // This verifier runs under both history locks and must not re-enter them.
    // No default authority: a caller-provided nonce alone cannot retire retention.
    private readonly verifyReplacementUnderHistoryLock?: (
      witness: CompactionCancellationReplacementWitness
    ) => Promise<boolean>
  ) {
    this.path = path.join(
      path.dirname(history.getContinuousCompactionJournal(workspaceId).path),
      COMPACTION_CANCELLATION_FILE
    );
  }

  async read(): Promise<CompactionCancellationRecord | null> {
    let contents: string;
    try {
      contents = await fs.readFile(this.path, "utf8");
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") return null;
      throw error;
    }
    try {
      return CancellationRecordSchema.parse(JSON.parse(contents));
    } catch {
      // Do not include the bytes: pending requests can contain private user content.
      throw new MalformedCompactionCancellationError("Invalid compaction cancellation record");
    }
  }

  mutate(
    mutation: CompactionCancellationMutation,
    isCurrent: () => boolean
  ): Promise<CompactionCancellationMutationOutcome> {
    return this.history.withCompactionStorageLock(this.workspaceId, async (_dir, checkLock) => {
      if (!isCurrent()) return "superseded";
      if (
        mutation.kind === "publish" &&
        mutation.publication.attempts > 1 &&
        !mutation.publication.predecessor
      )
        throw new Error("Cancellation frontier was not captured; a new Stop is required");
      const current = await this.read().catch((error: unknown) => {
        if (mutation.kind !== "publish") throw error;
        // Explicit Stop may overwrite unreadable state, inheriting its unknown
        // full-clear obligation. Reads and automatic repair never gain this authority.
        return undefined;
      });
      if (mutation.kind === "publish") {
        const journal = this.history.getContinuousCompactionJournal(this.workspaceId);
        const generation = await journal.captureGenerationUnderHistoryLock();
        const nonce = current === undefined ? undefined : (current?.nonce ?? null);
        const publication = mutation.publication;
        if (
          publication.attempts > 1 &&
          (!publication.predecessor ||
            publication.predecessor.nonce !== nonce ||
            publication.predecessor.generation !== generation)
        )
          return "superseded";
        const frontier = (publication.predecessor = { nonce, generation });
        if (current === undefined || current?.retainUntilReplacement)
          mutation.record.retainUntilReplacement = true;
        if (!isCurrent()) return "superseded";
        // Record admission before advancing, and advancement at its commit point.
        // Unobserved failures remain blocking until a new explicit Stop captures a frontier.
        await journal.advanceGenerationUnderHistoryLock((advanced) => {
          frontier.generation = advanced;
        }, checkLock);
        return (await publishCompactionFile(
          this.path,
          JSON.stringify(mutation.record),
          isCurrent,
          () => {
            frontier.nonce = mutation.record.nonce;
          },
          checkLock
        ))
          ? "applied"
          : "superseded";
      }
      const nonce = mutation.kind === "retire" ? mutation.nonce : mutation.record.nonce;
      if (current?.nonce !== nonce) return "superseded";
      if (mutation.kind === "narrow") {
        if (current.retainUntilReplacement) return "superseded";
        if (current.scope.kind !== "unresolved")
          return isCurrent() && isDeepStrictEqual(current, mutation.record)
            ? "applied"
            : "superseded";
        return (await publishCompactionFile(
          this.path,
          JSON.stringify(mutation.record),
          isCurrent,
          undefined,
          checkLock
        ))
          ? "applied"
          : "superseded";
      }
      const witness = mutation.replacementWitness;
      if (witness) {
        if (!this.verifyReplacementUnderHistoryLock)
          throw new Error("Replacement witness verification is not configured");
        if (witness.nonce !== nonce || !(await this.verifyReplacementUnderHistoryLock(witness)))
          throw new Error("Replacement witness was not verified");
      } else if (current.retainUntilReplacement) return "superseded";
      await checkLock();
      if (!isCurrent()) return "superseded";
      rmSync(this.path, { force: true });
      return "applied";
    });
  }

  repair(
    isCurrent: () => boolean,
    onCommitted: () => undefined
  ): Promise<CompactionCancellationRecord | null> {
    return this.history.withCompactionStorageLock(this.workspaceId, async (_dir, checkLock) => {
      if (!isCurrent()) return null;
      try {
        return await this.read();
      } catch (error) {
        if (!(error instanceof MalformedCompactionCancellationError)) throw error;
      }
      if (!isCurrent()) return null;
      await this.history
        .getContinuousCompactionJournal(this.workspaceId)
        .advanceGenerationUnderHistoryLock(undefined, checkLock);
      if (
        !(await this.history.neutralizeCompactionRecoveryUnderHistoryLock(
          this.workspaceId,
          isCurrent,
          checkLock
        )) ||
        !isCurrent()
      )
        return null;
      await checkLock();
      if (!isCurrent()) return null;
      // Keep malformed bytes until all obsolete recovery has been neutralized.
      // No await separates removal from the repair receipt or its final guard.
      rmSync(this.path, { force: true });
      onCommitted();
      return null;
    });
  }
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
  private readGeneration = 0;
  private acceptedReadGeneration = 0;
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
    // Only an accepted newer read or committed mutation displaces a snapshot/error/repair.
    // A pending successor is not evidence of absence and cannot hide a valid Stop.
    const generation = ++this.readGeneration;
    const isCurrent = () =>
      generation >= this.acceptedReadGeneration &&
      mutation === this.mutation &&
      pending === this.pending;
    try {
      const record = await this.storage.read().catch((error: unknown) => {
        if (!(error instanceof MalformedCompactionCancellationError) || !isCurrent()) throw error;
        return this.storage.repair(isCurrent, () => {
          this.repairedHistoryRevision++;
          if (!isCurrent()) return;
          // Removal is already committed; pre-repair reads must not restore retention
          // while the adapter is still finishing lock cleanup.
          this.current = null;
          this.acceptedReadGeneration = ++this.readGeneration;
        });
      });
      if (isCurrent()) {
        this.current = structuredClone(record);
        this.acceptedReadGeneration = generation;
      }
    } catch (error) {
      // A stale read/repair cannot hide a newer local Stop or trigger its replacement.
      if (isCurrent() || this.current === undefined) throw error;
    }
    // Supersession without a receipt leaves unknown state, never evidence of absence.
    if (this.current === undefined) throw new Error("Cancellation state changed during read");
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
        if (this.current === undefined) return this.refreshForReplacement();
        continue;
      }
      const mutation = this.mutation;
      const pending = this.pending;
      const reading = this.read();
      const generation = this.readGeneration;
      try {
        await reading;
        if (this.current === undefined) return this.refreshForReplacement();
        // A Stop or newer read can commit after reading resolves but before we resume.
        if (!this.blocksRecovery) return this.effectiveRecord();
      } catch (error) {
        if (error instanceof CompactionCancellationReadRefusedError) throw error;
        // Refresh unknown state once; propagate that read's failure instead of repeatedly
        // publishing fallback Stops that a foreign cancellation keeps superseding.
        if (this.current === undefined && (this.mutation !== mutation || this.pending !== pending))
          return this.refreshForReplacement();
        // read() checks before rejecting, but a newer Stop/retry/read can enter before
        // this rejection resumes. Fallback must still own that exact failed read.
        if (
          this.acceptedReadGeneration > generation ||
          this.mutation !== mutation ||
          this.pending !== pending
        )
          continue;
        // Explicit intervention may replace unreadable state, but cannot lose an unknown
        // full-clear obligation. Failed publication remains blocking and visible.
        await this.cancel({ retainUntilReplacement: true });
      }
    }
  }

  private async refreshForReplacement(): Promise<CompactionCancellationRecord | null> {
    const pending = this.pending;
    await this.read();
    // One refresh cannot turn another Stop's tentative state into replacement authority.
    // Further overlap requires a new request rather than an unbounded refresh/retry loop.
    if (this.pending !== pending || this.blocksRecovery || this.current === undefined)
      throw new Error("Cancellation changed during replacement refresh");
    return this.effectiveRecord();
  }

  async narrow(nonce: string, summary: CompactionCancellationSummary) {
    const captured = structuredClone(summary);
    const mutation = this.mutation;
    const pending = this.pending;
    try {
      await pending;
    } catch (error) {
      if (this.mutation !== mutation || this.pending !== pending) return;
      // An old witnessed unlink is ancillary once a fresh read discovers B.
      // Its failure cannot block B's narrowing; B's own failed writes still do.
      if (
        mutation?.kind !== "retire" ||
        mutation.replacementWitness?.nonce !== mutation.nonce ||
        mutation.nonce === nonce
      )
        throw error;
    }
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
    const generation = this.acceptedReadGeneration;
    const isCurrent = () => this.mutation === mutation;
    const result = this.pending
      .catch(() => undefined)
      .then(async (): Promise<CompactionCancellationMutationOutcome> => {
        if (!isCurrent()) return "superseded";
        if (mutation.kind === "publish") mutation.publication.attempts++;
        const outcome = await this.storage.mutate(mutation, isCurrent, (record) => {
          if (!isCurrent()) return;
          this.current = structuredClone(record);
          // Commit invalidates pre-deletion reads before lock release. A later foreign
          // read must survive acknowledgment delayed by adapter cleanup.
          this.acceptedReadGeneration = ++this.readGeneration;
        });
        if (isCurrent()) {
          this.unsettled = false;
          if (outcome === "superseded" && this.acceptedReadGeneration === generation)
            this.current = undefined;
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

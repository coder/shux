import { randomUUID } from "node:crypto";
import { isDeepStrictEqual } from "node:util";
import { promises as fs, rmSync } from "node:fs";
import * as path from "node:path";
import { z } from "zod";
import { COMPACTION_CANCELLATION_FILE } from "@/constants/continuousCompaction";
import { SESSION_HISTORY_MAX_LINE_BYTES } from "@/common/constants/contextBudget";
import { isPlainObject } from "@/common/utils/isPlainObject";
import type { HistoryService } from "./historyService";
import { publishCompactionFile } from "./continuousCompactionJournal";
import { hasAmbiguousResetKeys } from "./historyScanner";
import type { MuxMessage } from "@/common/types/message";
import { log } from "./log";

export interface CompactionReplacementCapture {
  nonce: string | null;
  generation: string | undefined;
}

export type CompactionReplacementOperation =
  | {
      kind: "append";
      messages: MuxMessage[];
      /** Record ordinary input against this capture without replacing its Stop. */
      preserveCancellation?: true;
    }
  | { kind: "resume"; message: MuxMessage };

export type CompactionReplacementOutcome =
  | { kind: "accepted"; witness: CompactionCancellationReplacementWitness | null }
  | { kind: "superseded" | "skipped" };

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
      onRetired?: (
        predecessor: CompactionReplacementCapture,
        successor: CompactionReplacementCapture
      ) => undefined;
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
    onCommitted: (
      record: CompactionCancellationRecord | null,
      retiredPredecessor?: CompactionReplacementCapture
    ) => undefined,
    signal?: AbortSignal
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

function assertCancellationSize(contents: string): void {
  if (Buffer.byteLength(contents, "utf8") > SESSION_HISTORY_MAX_LINE_BYTES)
    throw new CompactionCancellationReadRefusedError("Cancellation record exceeds supported size");
}

function serializeCancellation(record: CompactionCancellationRecord) {
  // JSON normalization must agree with both confirmation comparisons and commit receipts.
  const contents = JSON.stringify(record);
  assertCancellationSize(contents);
  return { contents, record: CancellationRecordSchema.parse(JSON.parse(contents)) };
}

/** Inactive real adapter. H2b supplies accepted-row verification; H2c wires runtime consumers. */
export class FileCompactionCancellationStorage implements CompactionCancellationStorage {
  readonly path: string;

  constructor(
    private readonly history: HistoryService,
    private readonly workspaceId: string,
    // Prepare expensive history evidence outside both locks; the returned verifier only
    // revalidates it under the lock. A caller-provided nonce alone grants no authority.
    private readonly prepareVerification?: (
      witness: CompactionCancellationReplacementWitness,
      signal?: AbortSignal
    ) => Promise<() => Promise<boolean>>
  ) {
    this.path = path.join(
      path.dirname(history.getContinuousCompactionJournal(workspaceId).path),
      COMPACTION_CANCELLATION_FILE
    );
  }

  async read(): Promise<CompactionCancellationRecord | null> {
    let contents: string;
    try {
      const handle = await fs.open(this.path, "r");
      try {
        // Bound allocation even if the file grows; short reads do not imply EOF.
        const buffer = Buffer.alloc(SESSION_HISTORY_MAX_LINE_BYTES + 1);
        let count = 0;
        while (count < buffer.length) {
          const { bytesRead } = await handle.read(buffer, count, buffer.length - count, count);
          if (bytesRead === 0) break;
          count += bytesRead;
        }
        contents = buffer.toString("utf8", 0, count);
      } finally {
        await handle.close();
      }
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") return null;
      throw error;
    }
    // The duplicate scanner's size ceiling must refuse inspection, never authorize repair.
    assertCancellationSize(contents);
    try {
      const parsed: unknown = JSON.parse(contents);
      if (
        isPlainObject(parsed) &&
        typeof parsed.version === "number" &&
        Number.isInteger(parsed.version) &&
        parsed.version > 1
      )
        throw new CompactionCancellationReadRefusedError("Unsupported cancellation record version");
      if (hasAmbiguousResetKeys(contents)) throw new Error("Duplicate cancellation fields");
      return CancellationRecordSchema.parse(parsed);
    } catch (error) {
      if (error instanceof CompactionCancellationReadRefusedError) throw error;
      // Do not include the bytes: pending requests can contain private user content.
      throw new MalformedCompactionCancellationError("Invalid compaction cancellation record");
    }
  }

  async mutate(
    mutation: CompactionCancellationMutation,
    isCurrent: () => boolean,
    onCommitted: (
      record: CompactionCancellationRecord | null,
      retiredPredecessor?: CompactionReplacementCapture
    ) => undefined,
    signal?: AbortSignal
  ): Promise<CompactionCancellationMutationOutcome> {
    if (!isCurrent()) return "superseded";
    let verifyReplacementUnderHistoryLock: (() => Promise<boolean>) | undefined;
    try {
      if (mutation.kind === "retire" && mutation.replacementWitness)
        verifyReplacementUnderHistoryLock = await this.prepareVerification?.(
          mutation.replacementWitness,
          signal
        );
    } catch (error) {
      // Superseded evidence must release its scanner before the queued Stop can publish.
      // A current operation's I/O or cancellation failure is still a real failure.
      if (!isCurrent()) return "superseded";
      throw error;
    }
    if (!isCurrent()) return "superseded";
    return this.history.withCompactionStorageLock(this.workspaceId, async (_dir, checkLock) => {
      if (!isCurrent()) return "superseded";
      if (
        mutation.kind === "publish" &&
        mutation.publication.attempts > 1 &&
        !mutation.publication.predecessor
      )
        throw new Error("Cancellation frontier was not captured; a new Stop is required");
      const current = await this.read().catch((error: unknown) => {
        if (mutation.kind !== "publish" || error instanceof CompactionCancellationReadRefusedError)
          throw error;
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
        const { contents, record: committed } = serializeCancellation(mutation.record);
        // Record admission before advancing, and advancement at its commit point.
        // Unobserved failures remain blocking until a new explicit Stop captures a frontier.
        const advanced = await journal.advanceGenerationUnderHistoryLock(
          (advanced) => {
            frontier.generation = advanced;
          },
          checkLock,
          isCurrent
        );
        if (!advanced) return "superseded";
        return (await publishCompactionFile(
          this.path,
          contents,
          isCurrent,
          () => {
            frontier.nonce = committed.nonce;
            // Install inherited retention before cleanup can admit a newer read.
            onCommitted(committed);
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
        const { contents, record: committed } = serializeCancellation(mutation.record);
        if (current.scope.kind !== "unresolved") {
          if (!isDeepStrictEqual(current, committed)) return "superseded";
          await checkLock();
          if (!isCurrent()) return "superseded";
          onCommitted(current);
          return "applied";
        }
        return (await publishCompactionFile(
          this.path,
          contents,
          isCurrent,
          () => onCommitted(committed),
          checkLock
        ))
          ? "applied"
          : "superseded";
      }
      const witness = mutation.replacementWitness;
      if (witness) {
        if (!verifyReplacementUnderHistoryLock)
          throw new Error("Replacement witness verification is not configured");
        try {
          if (witness.nonce !== nonce || !(await verifyReplacementUnderHistoryLock()))
            throw new Error("Replacement witness was not verified");
        } catch (error) {
          // Supersession can also abort stamp revalidation or flushes after taking the lock.
          if (!isCurrent()) return "superseded";
          throw error;
        }
      } else if (current.retainUntilReplacement) return "superseded";
      // Queued work may follow this exact replacement across unlink, but cannot adopt
      // a later Stop. Capture the frontier under the same lock and report only deletion.
      const retiredPredecessor = mutation.onRetired
        ? {
            nonce,
            generation: await this.history
              .getContinuousCompactionJournal(this.workspaceId)
              .captureGenerationUnderHistoryLock(),
          }
        : undefined;
      await checkLock();
      if (!isCurrent()) return "superseded";
      rmSync(this.path, { force: true });
      onCommitted(null, retiredPredecessor);
      return "applied";
    });
  }

  repair(
    isCurrent: () => boolean,
    onCommitted: () => undefined
  ): Promise<CompactionCancellationRecord | null> {
    return this.history.withCompactionStorageLock(this.workspaceId, (_dir, checkLock) =>
      this.repairUnderHistoryLock(isCurrent, onCommitted, checkLock)
    );
  }

  /** Admission captures repair and its resulting frontier without releasing the history lock. */
  async repairUnderHistoryLock(
    isCurrent: () => boolean,
    onCommitted: () => void,
    checkLock: () => Promise<void>,
    replaceUnreadable = false
  ): Promise<CompactionCancellationRecord | null> {
    if (!isCurrent()) return null;
    let replacement: CompactionCancellationRecord | undefined;
    try {
      return await this.read();
    } catch (error) {
      if (error instanceof CompactionCancellationReadRefusedError && replaceUnreadable) {
        // Explicit replacement preserves the same retention floor as readForReplacement's
        // fallback Stop, but acquires its receipt without a foreign writer entering between.
        replacement = {
          version: 1,
          nonce: randomUUID(),
          scope: { kind: "unresolved" },
          retainUntilReplacement: true,
        };
      } else if (!(error instanceof MalformedCompactionCancellationError)) throw error;
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
    if (replacement) {
      const serialized = serializeCancellation(replacement);
      if (
        !(await publishCompactionFile(
          this.path,
          serialized.contents,
          isCurrent,
          onCommitted,
          checkLock
        ))
      )
        throw new Error("Cancellation repair was superseded");
      return serialized.record;
    }
    rmSync(this.path, { force: true });
    onCommitted();
    return null;
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
  private mutationAbort?: AbortController;
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

  retireReplacement(
    witness: CompactionCancellationReplacementWitness,
    onRetired?: Extract<CompactionCancellationMutation, { kind: "retire" }>["onRetired"]
  ) {
    if (this.current?.nonce !== witness.nonce) return Promise.resolve(undefined);
    // An ordinary cleanup retry must retain the original queued-work receipt obligation.
    if (this.mutation?.kind === "retire" && this.mutation.nonce === witness.nonce)
      onRetired ??= this.mutation.onRetired;
    this.replacementNonce = witness.nonce;
    return this.persist({
      kind: "retire",
      nonce: witness.nonce,
      replacementWitness: { ...witness },
      onRetired,
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
    // Supersession cancels only this attempt's provisional scan, never its successor.
    this.mutationAbort?.abort(new Error("Compaction mutation superseded"));
    const abort = (this.mutationAbort = new AbortController());
    this.unsettled = true;
    this.inFlight = true;
    const generation = this.acceptedReadGeneration;
    const isCurrent = () => this.mutation === mutation;
    const result = this.pending
      .catch(() => undefined)
      .then(async (): Promise<CompactionCancellationMutationOutcome> => {
        if (!isCurrent()) return "superseded";
        if (mutation.kind === "publish") mutation.publication.attempts++;
        const outcome = await this.storage.mutate(
          mutation,
          isCurrent,
          (record, retired) => {
            if (!isCurrent()) return;
            this.current = structuredClone(record);
            // Commit invalidates pre-deletion reads before lock release. A later foreign
            // read must survive acknowledgment delayed by adapter cleanup.
            this.acceptedReadGeneration = ++this.readGeneration;
            if (mutation.kind === "retire" && record === null && retired) {
              try {
                mutation.onRetired?.(
                  { ...retired },
                  { nonce: null, generation: retired.generation }
                );
              } catch (error) {
                // Notification cannot undo the receipt or skip the unlink's directory flush.
                log.warn("Compaction retirement observer failed", error);
              }
            }
          },
          abort.signal
        );
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

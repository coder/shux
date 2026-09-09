import { randomUUID } from "node:crypto";
import * as fs from "node:fs/promises";
import * as path from "node:path";
import {
  MAX_EDITED_FILES,
  MAX_FILE_CONTENT_SIZE,
  MAX_POST_COMPACTION_LOADED_SKILLS,
} from "@/common/constants/attachments";
import type { LoadedSkillSnapshot } from "@/common/types/attachment";
import type { MuxMessage } from "@/common/types/message";
import { Err, Ok, type Result } from "@/common/types/result";
import { getErrorMessage } from "@/common/utils/errors";
import type { FileEditDiff } from "@/common/utils/messages/extractEditedFiles";
import { mergeReadFilePaths } from "@/common/utils/messages/extractReadFiles";
import { log } from "./log";
import {
  createLoadedSkillSnapshot,
  mergeLoadedSkillSnapshots,
} from "./agentSkills/loadedSkillSnapshots";
import {
  publishCompactionFile,
  type ContinuousCompactionPublication,
} from "./continuousCompactionJournal";

export interface CompactionPendingAttachments {
  diffs: FileEditDiff[];
  loadedSkills: LoadedSkillSnapshot[];
  readFiles: string[];
}

export type CompactionPendingBoundary =
  | { kind: "none" }
  | { kind: "identified"; messageId: string }
  | { kind: "unreadable-reset" };

interface PersistedState extends CompactionPendingAttachments {
  version: 1;
  createdAt: number;
  boundaryMessageId?: string;
  writeId?: string;
  publicationGeneration?: string | null;
  previousState?: PersistedState;
  previousStateGeneration?: string | null;
  previousStateBoundary?: CompactionPendingBoundary;
}

export interface CompactionPendingHistoryView {
  generation: string | undefined;
  /** Recheck physical lock ownership after awaited I/O before publishing or retiring bytes. */
  assertStillOwned(this: void): Promise<void>;
  /**
   * Provenance from the same verified chat/archive scan as the history rows. `none` requires
   * exhausting both files without a boundary or raw reset floor; unreadable is never absence.
   */
  boundary: CompactionPendingBoundary;
  isPublicationCurrent(publication: ContinuousCompactionPublication): Promise<boolean>;
  /** Only valid inside withLock; do not call a public history writer from that scope. */
  publishBoundary(
    input: CompactionPendingBoundaryWrite,
    onCommitted: () => undefined
  ): Promise<Result<void>>;
}

export interface CompactionPendingBoundaryWrite {
  summaryMessage: MuxMessage;
  tailCopies: readonly MuxMessage[];
  updateExisting: boolean;
  publication: ContinuousCompactionPublication;
  /** Pure admission check over held-lock history and a strictly parsed partial (null if absent). */
  shouldPersist: (messages: MuxMessage[], partial: MuxMessage | null) => boolean;
}

interface PendingPreparation {
  attachments: CompactionPendingAttachments;
  boundaryMessageId: string;
  publication: ContinuousCompactionPublication;
  isCurrent: () => boolean;
}

export interface CompactionPendingHistory {
  /** Owns its history locks; invoke outside withLock, then revalidate any pending receipt. */
  cleanupHeartbeat(
    summary: MuxMessage,
    isCurrent: () => boolean,
    onCommitted: () => undefined
  ): Promise<Result<"applied" | "skipped">>;
  /**
   * Hold BOTH existing history locks throughout the callback, reject removed workspaces,
   * and provide a stable view without reacquiring history/journal queues inside the lock.
   * The HistoryService adapter remains inactive: every producer/consumer must activate together.
   */
  withLock<T>(operation: (view: CompactionPendingHistoryView) => Promise<T>): Promise<T>;
}

/** Only receipts returned by this store authorize consumption or rollback. */
export interface CompactionPendingReceipt {
  readonly attachments: CompactionPendingAttachments;
}

function record(value: unknown): Record<string, unknown> | undefined {
  return value !== null && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : undefined;
}

function parseBoundary(value: unknown): CompactionPendingBoundary | undefined {
  const input = record(value);
  if (input?.kind === "none" || input?.kind === "unreadable-reset") return { kind: input.kind };
  if (input?.kind === "identified" && typeof input.messageId === "string" && input.messageId)
    return { kind: "identified", messageId: input.messageId };
}

function parseState(value: unknown, allowPrevious = true): PersistedState | undefined {
  const input = record(value);
  if (input?.version !== 1 || typeof input.createdAt !== "number") return;
  for (const key of ["boundaryMessageId", "writeId"] as const) {
    if (input[key] !== undefined && (typeof input[key] !== "string" || !input[key])) return;
  }
  for (const key of ["publicationGeneration", "previousStateGeneration"] as const) {
    if (input[key] !== undefined && input[key] !== null && typeof input[key] !== "string") return;
  }
  const diffs: FileEditDiff[] = [];
  for (const item of Array.isArray(input.diffs) ? input.diffs : []) {
    const diff = record(item);
    if (
      !diff ||
      typeof diff.path !== "string" ||
      !diff.path.trim() ||
      typeof diff.diff !== "string" ||
      typeof diff.truncated !== "boolean"
    )
      continue;
    diffs.push({
      path: diff.path.trim(),
      diff: diff.diff.slice(0, MAX_FILE_CONTENT_SIZE),
      truncated: diff.truncated || diff.diff.length > MAX_FILE_CONTENT_SIZE,
    });
    if (diffs.length >= MAX_EDITED_FILES) break;
  }
  const skills: LoadedSkillSnapshot[] = [];
  for (const item of Array.isArray(input.loadedSkills) ? input.loadedSkills : []) {
    const skill = record(item);
    if (
      !skill ||
      typeof skill.name !== "string" ||
      !skill.name.trim() ||
      typeof skill.body !== "string"
    )
      continue;
    try {
      skills.push(
        createLoadedSkillSnapshot({
          name: skill.name,
          scope: skill.scope,
          body: skill.body,
          frontmatterYaml:
            typeof skill.frontmatterYaml === "string" ? skill.frontmatterYaml : undefined,
          alreadyNormalized: true,
          truncated: skill.truncated === true,
        })
      );
    } catch {
      continue;
    }
    if (skills.length >= MAX_POST_COMPACTION_LOADED_SKILLS) break;
  }
  return {
    version: 1,
    createdAt: input.createdAt,
    diffs,
    loadedSkills: mergeLoadedSkillSnapshots(skills),
    readFiles: mergeReadFilePaths(
      [],
      (Array.isArray(input.readFiles) ? input.readFiles : []).filter(
        (item): item is string => typeof item === "string"
      )
    ),
    boundaryMessageId: input.boundaryMessageId as string | undefined,
    writeId: input.writeId as string | undefined,
    publicationGeneration: input.publicationGeneration as string | null | undefined,
    previousStateGeneration: input.previousStateGeneration as string | null | undefined,
    previousStateBoundary: parseBoundary(input.previousStateBoundary),
    previousState: allowPrevious ? parseState(input.previousState, false) : undefined,
  };
}

function parseJson(raw: string | undefined): unknown {
  try {
    // Only object roots can represent an unsupported pending-state schema.
    return raw === undefined ? undefined : record(JSON.parse(raw));
  } catch {
    return undefined;
  }
}

/** A fallback is mutable bookkeeping; the immutable head is the receipt's identity. */
function head(state: PersistedState): PersistedState {
  return {
    ...state,
    previousState: undefined,
    previousStateGeneration: undefined,
    previousStateBoundary: undefined,
  };
}

function identity(state: PersistedState): string {
  return JSON.stringify([
    state.writeId,
    state.createdAt,
    state.boundaryMessageId,
    state.publicationGeneration,
    state.diffs,
    state.loadedSkills,
    state.readFiles,
  ]);
}

function sameBoundary(
  expected: CompactionPendingBoundary | undefined,
  current: CompactionPendingBoundary
): boolean {
  return (
    (expected?.kind === "none" && current.kind === "none") ||
    (expected?.kind === "identified" &&
      current.kind === "identified" &&
      expected.messageId === current.messageId)
  );
}

function isCurrentState(state: PersistedState, view: CompactionPendingHistoryView): boolean {
  return (
    sameBoundary(
      state.boundaryMessageId
        ? { kind: "identified", messageId: state.boundaryMessageId }
        : { kind: "none" },
      view.boundary
    ) &&
    // Untagged V1 files predate generation tracking; only proven initial history qualifies.
    (state.boundaryMessageId !== undefined || view.generation === undefined) &&
    // A destructive edit can preserve the boundary ID, so even tagged legacy state
    // without generation proof must stop qualifying once a generation exists.
    (state.publicationGeneration === undefined
      ? view.generation === undefined
      : state.publicationGeneration === (view.generation ?? null))
  );
}

function eligiblePrevious(
  state: PersistedState,
  view: CompactionPendingHistoryView
): PersistedState | undefined {
  const previous = state.previousState;
  // Restart and rollback require the same captured proof. Missing V1 proof may drop
  // enrichments, but must not resurrect context across a reset or a same-generation boundary.
  if (
    previous &&
    state.previousStateGeneration === (view.generation ?? null) &&
    sameBoundary(state.previousStateBoundary, view.boundary) &&
    isCurrentState(previous, view)
  )
    return previous;
}

function eligibleState(
  state: PersistedState | undefined,
  view: CompactionPendingHistoryView
): PersistedState | undefined {
  if (state) return isCurrentState(state, view) ? state : eligiblePrevious(state, view);
}

/**
 * Inactive pending-file protocol. CompactionHandler owns local caches/preparation; this owns disk.
 * Read-side cleanup is best-effort; mutation failures propagate so callers can distinguish
 * attachment writes from mandatory reset cleanup.
 *
 * Activation must use `publishBoundary` for every producer, with matching receipt consumers
 * and an explicit policy for ambiguous legacy files. `prepare` alone is not atomic with history.
 * Queued methods acquire their own locks; never call them inside held locks.
 */
export class CompactionPendingState {
  private pending: Promise<unknown> = Promise.resolve();
  private readonly receipts = new WeakMap<
    CompactionPendingReceipt,
    {
      identity: string;
      generation: string | undefined;
      boundaryMessageId?: string;
      prepared: boolean;
      published: boolean;
      startingBoundary?: CompactionPendingBoundary;
    }
  >();

  constructor(
    private readonly filePath: string,
    private readonly history: CompactionPendingHistory
  ) {}

  private enqueue<T>(operation: (view: CompactionPendingHistoryView) => Promise<T>): Promise<T> {
    const result = this.pending.then(() => this.history.withLock(operation));
    this.pending = result.catch(() => undefined);
    return result;
  }

  private async readBytes(assertStillOwned?: () => Promise<void>): Promise<string | undefined> {
    return fs.readFile(this.filePath, "utf8").catch(async (error: NodeJS.ErrnoException) => {
      if (error.code === "EISDIR") {
        // Only empty directories are safe to remove; preserve unrelated contents and errors.
        if (assertStillOwned) await assertStillOwned();
        await fs.rmdir(this.filePath);
        return undefined;
      }
      if (error.code !== "ENOENT") throw error;
      return undefined;
    });
  }

  private receipt(
    state: PersistedState,
    generation: string | undefined,
    prepared = false,
    startingBoundary?: CompactionPendingBoundary
  ): CompactionPendingReceipt {
    const receipt = {
      attachments: {
        diffs: state.diffs,
        loadedSkills: state.loadedSkills,
        readFiles: state.readFiles,
      },
    };
    this.receipts.set(receipt, {
      identity: identity(state),
      generation,
      boundaryMessageId: state.boundaryMessageId,
      prepared,
      published: !prepared,
      startingBoundary,
    });
    return receipt;
  }

  load(isCurrent: () => boolean): Promise<CompactionPendingReceipt | undefined> {
    return this.enqueue(async (view) => {
      // Optional enrichment must not brick recovery when its sidecar is unreadable.
      const raw = await this.readBytes(view.assertStillOwned).catch(() => undefined);
      if (!isCurrent()) return;
      const parsed = parseJson(raw);
      // A downgraded reader must leave newer schemas intact for the version that owns them.
      if (parsed !== undefined && record(parsed)?.version !== 1) return;
      const persisted = parseState(parsed);
      const state = eligibleState(persisted, view);
      if (state) {
        await view.assertStillOwned();
        if (isCurrent()) return this.receipt(state, view.generation);
        return;
      }
      // A live writer may still be between pending-file publication and boundary commit.
      // Missing boundary proof suppresses injection; it does not authorize deleting its file.
      // Preserve ambiguous legacy bytes too; fresh compaction must establish usable ownership.
      if (
        raw !== undefined &&
        (!persisted ||
          (persisted.publicationGeneration !== undefined &&
            persisted.publicationGeneration !== (view.generation ?? null)))
      ) {
        // Attachments are already suppressed; inability to prune them must not block a request.
        await view.assertStillOwned();
        if (isCurrent()) await fs.unlink(this.filePath).catch(() => undefined);
      }
    });
  }

  prepare(input: PendingPreparation): Promise<CompactionPendingReceipt | undefined> {
    // Freeze before enqueueing: a caller may reuse its arrays while another write holds the lock.
    const captured = structuredClone(input.attachments);
    const publication = structuredClone(input.publication);
    const boundaryMessageId = input.boundaryMessageId;
    const isCurrent = input.isCurrent;
    if (!boundaryMessageId.trim()) throw new Error("Pending state requires a boundary message ID");
    return this.enqueue((view) =>
      this.prepareUnderLock(view, {
        attachments: captured,
        publication,
        boundaryMessageId,
        isCurrent,
      })
    );
  }

  private async prepareUnderLock(
    view: CompactionPendingHistoryView,
    input: PendingPreparation
  ): Promise<CompactionPendingReceipt | undefined> {
    const { attachments: captured, publication, boundaryMessageId, isCurrent } = input;
    if (!boundaryMessageId.trim()) throw new Error("Pending state requires a boundary message ID");
    if (!isCurrent() || !(await view.isPublicationCurrent(publication))) return;
    await view.assertStillOwned();
    await fs.mkdir(path.dirname(this.filePath), { recursive: true });
    const parsed = parseJson(await this.readBytes(view.assertStillOwned));
    // Unsupported future schemas remain owned by their version, even after a new boundary.
    if (parsed !== undefined && record(parsed)?.version !== 1) return;
    const previous = eligibleState(parseState(parsed), view);
    if (!isCurrent()) return;
    const startingBoundary = structuredClone(view.boundary);
    const state = parseState({
      ...captured,
      version: 1,
      createdAt: Date.now(),
      boundaryMessageId,
      writeId: randomUUID(),
      publicationGeneration: publication.generation ?? null,
      previousState: previous && head(previous),
      previousStateGeneration: previous ? (view.generation ?? null) : undefined,
      previousStateBoundary: previous ? startingBoundary : undefined,
    });
    if (!state) throw new Error("Invalid pending state");
    let receipt: CompactionPendingReceipt | undefined;
    // Staging also awaits I/O. The helper checks local ownership immediately before rename
    // and publishes the receipt before cleanup/lock release can admit a successor.
    await publishCompactionFile(
      this.filePath,
      JSON.stringify(state),
      isCurrent,
      () => {
        receipt = this.receipt(state, publication.generation, true, startingBoundary);
      },
      view.assertStillOwned
    );
    return receipt;
  }

  /**
   * Derive rows/attachments before entry; retain ownership of the rows until this returns.
   * A separate prepare followed by a history write lets another backend replace our fallback.
   * Keep one store queue -> both history locks through commit or exact preparation cleanup.
   */
  async publishBoundary(
    input: CompactionPendingBoundaryWrite & {
      attachments: CompactionPendingAttachments;
      isCurrent: () => boolean;
      /** Synchronous lifecycle state only. Events and goal observers run after this returns. */
      onCommitted: (receipt: CompactionPendingReceipt | undefined) => undefined;
    }
  ): Promise<Result<CompactionPendingReceipt | undefined>> {
    const { summaryMessage, tailCopies, updateExisting, isCurrent, shouldPersist, onCommitted } =
      input;
    const publication = structuredClone(input.publication);
    const preparation = {
      attachments: structuredClone(input.attachments),
      boundaryMessageId: summaryMessage.id,
      publication,
      isCurrent,
    };
    let receipt: CompactionPendingReceipt | undefined;
    let committed = false;
    try {
      return await this.enqueue(async (view) => {
        // Restart proves commit from the boundary ID, so an already-current ID cannot
        // distinguish a new preparation from its durable predecessor after a crash.
        if (view.boundary.kind === "identified" && view.boundary.messageId === summaryMessage.id)
          return Err("Compaction publication requires a new boundary ID");
        try {
          receipt = await this.prepareUnderLock(view, preparation);
        } catch (error) {
          // Enrichment failures cannot brick mandatory history. The history writer rechecks
          // physical ownership, publication and admission independently before committing.
          log.warn("Compaction pending enrichment unavailable", error);
        }
        try {
          const result = await view.publishBoundary(
            {
              summaryMessage,
              tailCopies,
              updateExisting,
              publication,
              shouldPersist: (messages, partial) => isCurrent() && shouldPersist(messages, partial),
            },
            () => {
              // The rename is the commit: observer/lock-disposal failures cannot undo it.
              committed = true;
              const owner = receipt && this.receipts.get(receipt);
              if (owner) owner.published = true;
              onCommitted(receipt);
            }
          );
          if (committed) return Ok(receipt);
          return result.success ? Err("Compaction boundary did not commit a receipt") : result;
        } finally {
          // The stable starting view is valid for rollback only because no boundary committed.
          if (!committed && receipt) await this.rollbackUnderLock(view, receipt, () => true);
        }
      });
    } catch (error) {
      if (committed) {
        log.warn("Pending publication cleanup failed after boundary commit", error);
        return Ok(receipt);
      }
      return Err(`Failed to publish compaction pending boundary: ${getErrorMessage(error)}`);
    }
  }

  consume(receipt: CompactionPendingReceipt): Promise<boolean> {
    const expected = this.receipts.get(receipt);
    if (!expected) return Promise.resolve(false);
    return this.enqueue(async (view) => {
      const state = parseState(parseJson(await this.readBytes(view.assertStillOwned)));
      if (!state) return false;
      if (identity(state) === expected.identity) {
        await view.assertStillOwned();
        await fs.unlink(this.filePath);
        return true;
      }
      if (!state.previousState || identity(state.previousState) !== expected.identity) return false;
      // A may be consumed while B is provisional. Remove only A's fallback, durably, so
      // B's later rollback/restart cannot resurrect it. B retains its immutable write identity.
      await publishCompactionFile(
        this.filePath,
        JSON.stringify(head(state)),
        () => true,
        undefined,
        view.assertStillOwned
      );
      return true;
    });
  }

  /** Acknowledgement removes the file, but warm skills/paths still require current provenance. */
  isCurrent(
    receipt: CompactionPendingReceipt,
    scope: "pending" | "carryover",
    isCurrent: () => boolean
  ): Promise<boolean> {
    const expected = this.receipts.get(receipt);
    if (!expected) return Promise.resolve(false);
    return this.enqueue(async (view) => {
      if (expected.generation !== view.generation || view.boundary.kind === "unreadable-reset")
        return false;
      // A provisional file is not evidence that its attachments ever belonged to history.
      if (scope === "carryover" && !expected.published) return false;
      if (scope === "pending") {
        const state = eligibleState(
          parseState(parseJson(await this.readBytes(view.assertStillOwned))),
          view
        );
        if (!state || identity(state) !== expected.identity) return false;
      }
      await view.assertStillOwned();
      if (!isCurrent()) return false;
      expected.published = true;
      return true;
    });
  }

  /**
   * Restart receipts cannot authorize ordinary rollback. Only this composition witnesses
   * exact heartbeat removal, then rechecks the captured file and persisted predecessor proof.
   * Never hold the pending/history lock while calling the separately queued history cleanup.
   */
  async rollbackHeartbeat(input: {
    summaryMessage: MuxMessage;
    isCurrent: () => boolean;
    canRestorePrevious: () => boolean;
    onCommitted: () => undefined;
    onRestored: (receipt: CompactionPendingReceipt) => undefined;
  }): Promise<Result<{ outcome: "applied" | "skipped"; restored?: CompactionPendingReceipt }>> {
    const summary = structuredClone(input.summaryMessage);
    const { isCurrent, canRestorePrevious, onCommitted, onRestored } = input;
    let committed = false;
    let restored: CompactionPendingReceipt | undefined;
    // Enrichment read failures must not prevent mandatory exact history cleanup.
    const receipt = await this.load(isCurrent).catch(() => undefined);
    try {
      const result = await this.history.cleanupHeartbeat(summary, isCurrent, () => {
        committed = true;
        onCommitted();
      });
      if (!committed) return result.success ? Ok({ outcome: "skipped" }) : result;
    } catch (error) {
      if (!committed) return Err(`Failed to roll back heartbeat: ${getErrorMessage(error)}`);
      log.warn("Heartbeat cleanup failed after history commit", error);
    }
    try {
      if (receipt && this.receipts.get(receipt)?.boundaryMessageId === summary.id)
        await this.enqueue((view) =>
          this.rollbackUnderLock(view, receipt, canRestorePrevious, {
            boundaryMessageId: summary.id,
            onRestored: (previous) => {
              restored = previous;
              onRestored(previous);
            },
          })
        );
    } catch (error) {
      // Cleanup is already committed. Optional restoration cannot turn it into a retry.
      log.warn("Pending heartbeat restoration unavailable", error);
    }
    return Ok({ outcome: "applied", restored });
  }

  rollback(receipt: CompactionPendingReceipt, canRestorePrevious: () => boolean): Promise<boolean> {
    if (!this.receipts.get(receipt)?.prepared) return Promise.resolve(false);
    return this.enqueue((view) => this.rollbackUnderLock(view, receipt, canRestorePrevious));
  }

  private async rollbackUnderLock(
    view: CompactionPendingHistoryView,
    receipt: CompactionPendingReceipt,
    canRestorePrevious: () => boolean,
    cleanup?: {
      boundaryMessageId: string;
      onRestored: (receipt: CompactionPendingReceipt) => undefined;
    }
  ): Promise<boolean> {
    const expected = this.receipts.get(receipt);
    if (!expected || (!expected.prepared && !cleanup)) return false;
    const state = parseState(parseJson(await this.readBytes(view.assertStillOwned)));
    if (!state || identity(state) !== expected.identity) return false;
    if (cleanup && state.boundaryMessageId !== cleanup.boundaryMessageId) return false;
    if (isCurrentState(state, view)) return false;
    // Restoring a committed heartbeat also needs the caller's exact history rollback proof.
    // A generation change permits exact cleanup, never restoration of the prior context.
    // A newer compaction can keep the generation unchanged; even an untagged legacy
    // predecessor may only return to the boundary at which preparation began.
    const previous = eligiblePrevious(state, view);
    if (
      previous &&
      expected.generation === view.generation &&
      sameBoundary(
        cleanup ? state.previousStateBoundary : expected.startingBoundary,
        view.boundary
      ) &&
      canRestorePrevious()
    ) {
      if (
        await publishCompactionFile(
          this.filePath,
          JSON.stringify(head(previous)),
          canRestorePrevious,
          () => {
            cleanup?.onRestored(this.receipt(previous, view.generation));
          },
          view.assertStillOwned
        )
      )
        return true;
    }
    await view.assertStillOwned();
    await fs.unlink(this.filePath);
    return true;
  }

  /** Call only after the destructive boundary/generation change committed under the history lock. */
  discardAfterBoundary(): Promise<void> {
    return this.enqueue(async (view) => {
      const raw = await this.readBytes(view.assertStillOwned);
      if (raw === undefined) return;
      const state = parseState(parseJson(raw));
      // A reset may retire proven old V1 state, never bytes owned by a future reader or
      // ambiguous legacy state. Their absence from enrichment is enough to honor the reset.
      if (state?.publicationGeneration === undefined) return;
      if (state.publicationGeneration === (view.generation ?? null)) return;
      await view.assertStillOwned();
      await fs.unlink(this.filePath);
    });
  }
}

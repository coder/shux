import { randomUUID } from "node:crypto";
import * as fs from "node:fs/promises";
import * as path from "node:path";
import {
  MAX_EDITED_FILES,
  MAX_FILE_CONTENT_SIZE,
  MAX_POST_COMPACTION_LOADED_SKILLS,
} from "@/common/constants/attachments";
import type { LoadedSkillSnapshot } from "@/common/types/attachment";
import type { FileEditDiff } from "@/common/utils/messages/extractEditedFiles";
import { mergeReadFilePaths } from "@/common/utils/messages/extractReadFiles";
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
  /**
   * Provenance from the same verified chat/archive scan as the history rows. `none` requires
   * exhausting both files without a boundary or raw reset floor; unreadable is never absence.
   */
  boundary: CompactionPendingBoundary;
  isPublicationCurrent(publication: ContinuousCompactionPublication): Promise<boolean>;
}

export interface CompactionPendingHistory {
  /**
   * Hold BOTH existing history locks throughout the callback, reject removed workspaces,
   * and provide a stable view without reacquiring history/journal queues inside the lock.
   * Deliberately has no runtime adapter yet: every producer/consumer must activate together.
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
 * `prepare` alone does not atomically publish history. Activation requires caller coordination:
 * enter the store queue, then hold the shared history locks through preparation, boundary
 * publication, synchronous receipt delivery, and exact failure cleanup before unlocking.
 * These standalone queued methods acquire their own locks; never call them inside held locks.
 */
export class CompactionPendingState {
  private pending: Promise<unknown> = Promise.resolve();
  private readonly receipts = new WeakMap<
    CompactionPendingReceipt,
    {
      identity: string;
      generation: string | undefined;
      prepared: boolean;
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

  private async readBytes(): Promise<string | undefined> {
    return fs.readFile(this.filePath, "utf8").catch(async (error: NodeJS.ErrnoException) => {
      if (error.code === "EISDIR") {
        // Only empty directories are safe to remove; preserve unrelated contents and errors.
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
      prepared,
      startingBoundary,
    });
    return receipt;
  }

  load(isCurrent: () => boolean): Promise<CompactionPendingReceipt | undefined> {
    return this.enqueue(async (view) => {
      // Optional enrichment must not brick recovery when its sidecar is unreadable.
      const raw = await this.readBytes().catch(() => undefined);
      if (!isCurrent()) return;
      const parsed = parseJson(raw);
      // A downgraded reader must leave newer schemas intact for the version that owns them.
      if (parsed !== undefined && record(parsed)?.version !== 1) return;
      const persisted = parseState(parsed);
      const state = eligibleState(persisted, view);
      if (state) return this.receipt(state, view.generation);
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
        await fs.unlink(this.filePath).catch(() => undefined);
      }
    });
  }

  prepare(input: {
    attachments: CompactionPendingAttachments;
    boundaryMessageId: string;
    publication: ContinuousCompactionPublication;
    isCurrent: () => boolean;
  }): Promise<CompactionPendingReceipt | undefined> {
    // Freeze before enqueueing: a caller may reuse its arrays while another write holds the lock.
    const captured = structuredClone(input.attachments);
    const publication = structuredClone(input.publication);
    const boundaryMessageId = input.boundaryMessageId;
    const isCurrent = input.isCurrent;
    if (!boundaryMessageId.trim()) throw new Error("Pending state requires a boundary message ID");
    return this.enqueue(async (view) => {
      if (!isCurrent() || !(await view.isPublicationCurrent(publication))) return;
      await fs.mkdir(path.dirname(this.filePath), { recursive: true });
      const parsed = parseJson(await this.readBytes());
      // Unknown bytes require atomic history publication before replacement. This standalone
      // preparation must decline enrichment; callers still own the mandatory history write.
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
      await publishCompactionFile(this.filePath, JSON.stringify(state), isCurrent, () => {
        receipt = this.receipt(state, publication.generation, true, startingBoundary);
      });
      return receipt;
    });
  }

  consume(receipt: CompactionPendingReceipt): Promise<boolean> {
    const expected = this.receipts.get(receipt);
    if (!expected) return Promise.resolve(false);
    return this.enqueue(async () => {
      const state = parseState(parseJson(await this.readBytes()));
      if (!state) return false;
      if (identity(state) === expected.identity) {
        await fs.unlink(this.filePath);
        return true;
      }
      if (!state.previousState || identity(state.previousState) !== expected.identity) return false;
      // A may be consumed while B is provisional. Remove only A's fallback, durably, so
      // B's later rollback/restart cannot resurrect it. B retains its immutable write identity.
      await publishCompactionFile(this.filePath, JSON.stringify(head(state)), () => true);
      return true;
    });
  }

  rollback(receipt: CompactionPendingReceipt, canRestorePrevious: () => boolean): Promise<boolean> {
    const expected = this.receipts.get(receipt);
    if (!expected?.prepared) return Promise.resolve(false);
    return this.enqueue(async (view) => {
      const state = parseState(parseJson(await this.readBytes()));
      if (!state || identity(state) !== expected.identity) return false;
      if (isCurrentState(state, view)) return false;
      // Restoring a committed heartbeat also needs the caller's exact history rollback proof.
      // A generation change permits exact cleanup, never restoration of the prior context.
      // A newer compaction can keep the generation unchanged; even an untagged legacy
      // predecessor may only return to the boundary at which preparation began.
      const previous = eligiblePrevious(state, view);
      if (
        previous &&
        expected.generation === view.generation &&
        sameBoundary(expected.startingBoundary, view.boundary) &&
        canRestorePrevious()
      ) {
        if (
          await publishCompactionFile(
            this.filePath,
            JSON.stringify(head(previous)),
            canRestorePrevious
          )
        )
          return true;
      }
      await fs.unlink(this.filePath);
      return true;
    });
  }

  /** Call only after the destructive boundary/generation change committed under the history lock. */
  discardAfterBoundary(): Promise<void> {
    return this.enqueue(async (view) => {
      const raw = await this.readBytes();
      if (raw === undefined) return;
      const state = parseState(parseJson(raw));
      if (
        state &&
        (isCurrentState(state, view) ||
          (state.boundaryMessageId !== undefined &&
            state.publicationGeneration !== undefined &&
            state.publicationGeneration === (view.generation ?? null)))
      )
        return;
      await fs.unlink(this.filePath);
    });
  }
}

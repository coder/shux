/**
 * Refinement journal emitters (RLM track, phase r2).
 *
 * Every harness self-modification (memory tool mutations, agent_skill_write,
 * agent_skill_delete) appends exactly one invertible `refinement` durable
 * event to the acting workspace's session journal. Journaling is purely
 * additive: it never changes tool behavior and a journaling failure must
 * never fail the user-facing mutation (self-healing doctrine — log.debug and
 * continue).
 *
 * Cross-workspace caveat (intended v1 scope): memory and skill files are
 * global- or project-scoped, but the durable journal is per-session. Rows
 * land in the journal of the workspace that made the edit, so concurrent
 * edits to one shared file from different workspaces are each attributed to
 * (and invertible from) their own acting workspace's log.
 */

import { createHash } from "node:crypto";

import assert from "@/common/utils/assert";
import {
  REFINEMENT_INVERSE_BLOB_QUOTA_BYTES,
  REFINEMENT_INVERSE_QUOTA_MIN_CHARGE_BYTES,
  RefinementInverseSchema,
  type MemoryRefinementAction,
  type RefinementEvidence,
  type RefinementInverse,
  type RefinementPostState,
  type SkillRefinementAction,
} from "@/common/types/refinement";
import type { BlobStore } from "@/node/utils/journal/blobStore";
import {
  sharedDurableEventJournal,
  type DurableEventJournal,
} from "@/node/utils/journal/durableEventJournal";
import {
  canDeleteEvictedBlob,
  makeSnapshotLatestResolver,
  publishQuotaRetention,
  walkBlobQuota,
  type BlobQuotaEntry,
} from "@/node/utils/journal/blobReclamation";
import { log } from "@/node/services/log";

/** Prior-content capture with inline content; the emitter offloads large contents to blobs. */
export interface RefinementFileCapture {
  path: string;
  content: string;
}

/** Inverse draft with captured contents inline; blob offload happens at append. */
export type RefinementInverseDraft =
  | { op: "delete-files"; paths: string[] }
  // deletePaths (r67): mixed force-apply pre-state — restore `files` AND
  // delete the paths the forced rollback created (see RefinementInverseSchema).
  | { op: "restore-files"; files: RefinementFileCapture[]; deletePaths?: string[] }
  | { op: "rename"; from: string; to: string };

export interface RefinementEmitArgs {
  /** Acting workspace's session dir (owns durable-events.jsonl + blobs). */
  sessionDir: string;
  workspaceId: string;
  kind: "memory" | "skill";
  action: MemoryRefinementAction | SkillRefinementAction;
  inverse: RefinementInverseDraft;
  evidence: { toolName: string; toolCallId?: string; actor?: string };
  /**
   * Contents the action left on disk (edit-type actions only: create,
   * str_replace, insert, skill write). Hashed at append into the row's
   * `postState` so rollback can detect out-of-band edits content-exactly.
   */
  postFiles?: RefinementFileCapture[];
  /**
   * "remote" when the mutation ran through a non-local runtime (SSH/Docker).
   * Such rows carry runtime-namespace paths and are refused by rollback,
   * which only applies inverses to the host filesystem.
   */
  runtime?: "remote";
}

/** Shared by the rollback engine to compare current files against `postState`. */
export function sha256Hex(text: string): string {
  return createHash("sha256").update(text, "utf-8").digest("hex");
}

/**
 * Quota charge for one inverse payload: real bytes, floored at one
 * filesystem allocation unit so the horizon also bounds retained blob COUNT
 * (see REFINEMENT_INVERSE_QUOTA_MIN_CHARGE_BYTES).
 */
function inverseQuotaCharge(sizeBytes: number): number {
  return Math.max(sizeBytes, REFINEMENT_INVERSE_QUOTA_MIN_CHARGE_BYTES);
}

/**
 * Offload EVERY captured content to the blob store — no inline fast path.
 * Inline copies would live in the append-only durable-events.jsonl where
 * they can neither be reclaimed nor quota-counted, so a loop of small
 * unique versions would grow the session without bound (Codex round 8);
 * uniform offloading makes horizon eviction cover all payloads. Legacy rows
 * written by older binaries still carry inline `text` and stay rollbackable.
 * Exported so the rollback service (refinementRollback.ts) resolves the
 * inverses of its own rollback rows through the identical offload policy.
 * `publishedBlobs` reports every payload (at its quota charge) so callers
 * feed the inverse-blob quota (reclaimExcessRefinementInverseBlobs)
 * incrementally.
 */
export async function resolveRefinementInverse(
  blobs: BlobStore,
  draft: RefinementInverseDraft
): Promise<{ inverse: RefinementInverse; publishedBlobs: BlobQuotaEntry[] }> {
  if (draft.op !== "restore-files") {
    return { inverse: draft, publishedBlobs: [] };
  }
  const publishedBlobs: BlobQuotaEntry[] = [];
  const files = await Promise.all(
    draft.files.map(async (file) => {
      const { ref, size } = await blobs.put(file.content);
      publishedBlobs.push({ ref, size: inverseQuotaCharge(size) });
      return { path: file.path, blobRef: ref };
    })
  );
  return {
    inverse: {
      op: "restore-files",
      files,
      // Mixed force-apply pre-state (r67): carry the deletion half through.
      ...(draft.deletePaths !== undefined && draft.deletePaths.length > 0
        ? { deletePaths: draft.deletePaths }
        : {}),
    },
    publishedBlobs,
  };
}

/**
 * Per-journal incremental quota state for refinement inverse payloads,
 * mirroring the sandbox host's reclamation state: keyed by the
 * (process-shared) journal instance, first pass per process runs a full
 * recovery sweep, later passes do O(1)-ish work over the retained list.
 */
interface RefinementReclamationState {
  /** Inverse payloads currently retained under the quota, newest first;
   * null until the recovery sweep. */
  retainedInverseBlobs: BlobQuotaEntry[] | null;
  /** journal.blobIndexEpoch the list was derived at: foreign appends (debug
   * CLI rollback rows) move the epoch, and a stale list must be re-derived
   * from the journal before it may authorize releases (round 14). */
  retainedEpoch: number;
}

const reclamationStates = new WeakMap<DurableEventJournal, RefinementReclamationState>();

/**
 * Enforce the per-session quota on retained refinement-inverse blob bytes
 * (see REFINEMENT_INVERSE_BLOB_QUOTA_BYTES). Newest-first: recent inverses
 * stay rollbackable; once the cumulative size crosses the quota, older
 * payload blobs are deleted while their refinement rows remain (rollback of
 * an evicted row fails with a descriptive beyond-the-horizon error).
 * Reference safety: a hash also mentioned by any other event kind survives
 * (content addressing can share payloads). Holds the journal blob lock
 * across the decide→delete window; callers must NOT already hold it.
 *
 * Exported for tests (quota interleavings need synthetic payloads).
 */
export async function reclaimExcessRefinementInverseBlobs(
  journal: DurableEventJournal,
  published: BlobQuotaEntry[]
): Promise<void> {
  await journal.withBlobLock(async () => {
    let state = reclamationStates.get(journal);
    if (!state) {
      state = { retainedInverseBlobs: null, retainedEpoch: -1 };
      reclamationStates.set(journal, state);
    }
    const index = await journal.blobMentionIndex();
    // Epoch check AFTER blobMentionIndex(): that call detects foreign
    // appends. A retained list from an older epoch may miss rollback rows a
    // foreign CLI appended and must be re-derived from the journal.
    const epoch = journal.blobIndexEpoch;
    let entries: BlobQuotaEntry[];
    if (state.retainedInverseBlobs !== null && state.retainedEpoch === epoch) {
      entries = [...published, ...state.retainedInverseBlobs];
    } else {
      // Recovery sweep: walk refinement rows newest-first and re-derive the
      // retained set. Rows never recorded payload sizes, so stat the blobs;
      // a missing blob was already evicted (or never landed) — skip it.
      const events = await journal.read();
      entries = [];
      for (let i = events.length - 1; i >= 0; i--) {
        const event = events[i];
        if (event.kind !== "refinement") continue;
        const inverse = RefinementInverseSchema.safeParse(event.data.inverse);
        if (!inverse.success || inverse.data.op !== "restore-files") continue;
        for (const file of inverse.data.files) {
          if (file.blobRef === undefined) continue;
          const size = await journal.blobs.size(file.blobRef);
          if (size === null) continue;
          // Same floor as publish-time accounting, or the sweep would
          // under-charge small payloads relative to the incremental path.
          entries.push({ ref: file.blobRef, size: inverseQuotaCharge(size) });
        }
      }
    }
    const { retained, evictable } = walkBlobQuota(entries, REFINEMENT_INVERSE_BLOB_QUOTA_BYTES);
    state.retainedInverseBlobs = retained;
    state.retainedEpoch = epoch;
    // Publish BEFORE deleting so joint retention decisions (ours and other
    // quotas') always see this pass's eviction verdicts.
    publishQuotaRetention(journal, "refinement", new Set(retained.map((entry) => entry.ref)));
    const resolveLatestSnapshot = makeSnapshotLatestResolver(journal);
    for (const ref of evictable) {
      const deletable = await canDeleteEvictedBlob({
        journal,
        ref,
        mentions: index.get(ref),
        resolveLatestSnapshot,
      });
      if (!deletable) continue;
      await journal.deleteBlobUnderLock(ref);
    }
  });
}

/**
 * Append one `refinement` durable event. Never throws — the mutation this row
 * describes must succeed even when the journal is unavailable.
 */
export async function appendRefinementEvent(args: RefinementEmitArgs): Promise<void> {
  try {
    assert(args.sessionDir.length > 0, "refinement journal requires a session dir");
    assert(args.workspaceId.length > 0, "refinement journal requires a workspace id");
    const journal = sharedDurableEventJournal(args.sessionDir);
    // Inverse blob puts and the append referencing them run under the journal
    // blob lock: a concurrent reclamation pass must never observe the
    // put→append window (see DurableEventJournal.withBlobLock).
    let publishedBlobs: BlobQuotaEntry[] = [];
    await journal.withBlobLock(async () => {
      const resolved = await resolveRefinementInverse(journal.blobs, args.inverse);
      const inverse = resolved.inverse;
      publishedBlobs = resolved.publishedBlobs;
      // Optional fields are spread conditionally: an explicit `undefined` value
      // would fail the JsonValue schema validation on append and drop the row.
      const evidence: RefinementEvidence = {
        workspaceId: args.workspaceId,
        toolName: args.evidence.toolName,
        ...(args.evidence.toolCallId !== undefined ? { toolCallId: args.evidence.toolCallId } : {}),
        ...(args.evidence.actor !== undefined ? { actor: args.evidence.actor } : {}),
      };
      const postState: RefinementPostState | undefined =
        args.postFiles !== undefined
          ? {
              files: args.postFiles.map((file) => ({
                path: file.path,
                sha256: sha256Hex(file.content),
              })),
            }
          : undefined;
      await journal.append({
        workspaceId: args.workspaceId,
        kind: "refinement",
        data: {
          kind: args.kind,
          action: args.action,
          inverse,
          evidence,
          ...(postState !== undefined ? { postState } : {}),
          ...(args.runtime !== undefined ? { runtime: args.runtime } : {}),
        },
      });
    });
    // Bound retained inverse payloads per session AFTER releasing the publish
    // lock (reclaim takes it itself; the mutex is non-reentrant). Best-effort:
    // failure must never fail the mutation this row describes.
    try {
      await reclaimExcessRefinementInverseBlobs(journal, publishedBlobs);
    } catch (error) {
      log.debug("[refinement] inverse blob reclamation failed; continuing", { error });
    }
  } catch (error) {
    log.debug("[refinement] failed to journal refinement event; continuing", {
      kind: args.kind,
      workspaceId: args.workspaceId,
      error,
    });
  }
}

/**
 * Tool-side convenience wrapper: resolves the session journal from the tool
 * configuration. Skips (log-only) when the tool runs without a workspace
 * session — there is no journal to attribute the edit to.
 */
export async function appendRefinementEventFromTool(
  config: { workspaceSessionDir?: string; workspaceId?: string },
  args: Omit<RefinementEmitArgs, "sessionDir" | "workspaceId">
): Promise<void> {
  if (!config.workspaceSessionDir || !config.workspaceId) {
    log.debug("[refinement] skipping refinement journal: no workspace session", {
      kind: args.kind,
    });
    return;
  }
  await appendRefinementEvent({
    ...args,
    sessionDir: config.workspaceSessionDir,
    workspaceId: config.workspaceId,
  });
}

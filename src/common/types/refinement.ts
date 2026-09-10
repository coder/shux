/**
 * Refinement payload contracts (v1) — the concrete vocabulary carried inside
 * `refinement` durable events (src/common/types/durableEvent.ts).
 *
 * RefinementDataSchema deliberately keeps `action`/`inverse`/`evidence` as
 * opaque JSON so the envelope stays generic across future refinement kinds;
 * these schemas are the producer/consumer contract for the harness
 * self-modification emitters (memory tool + skill CRUD tools). Applying the
 * `inverse` must fully restore the file state that existed before the action.
 */

import { z } from "zod";
import { BlobRefSchema } from "./durableEvent";

/**
 * Minimum quota charge for one refinement-inverse payload blob. Captured
 * contents are ALWAYS offloaded to the blob store (never inlined into the
 * append-only durable-events.jsonl, where they could neither be reclaimed
 * nor quota-counted), so the horizon quota below governs every payload
 * uniformly. Charging at least one filesystem allocation unit per payload
 * bounds the retained blob COUNT (quota/charge), not just logical bytes —
 * without a floor, a loop of tiny unique versions could retain millions of
 * blob files whose block usage dwarfs their content.
 */
export const REFINEMENT_INVERSE_QUOTA_MIN_CHARGE_BYTES = 4_096;

/**
 * Budgets for pre-delete inverse capture (agent_skill_delete). Skill content
 * is repo-controlled, so an attacker-sized skill dir must not make a routine
 * cleanup call buffer unbounded bytes in memory or duplicate them into
 * journal blobs. When any budget is exceeded, journaling is skipped entirely
 * (the delete still proceeds): a partial inverse is worse than none because
 * rollback would silently restore an incomplete skill.
 */
export const REFINEMENT_CAPTURE_MAX_FILE_BYTES = 1024 * 1024;
export const REFINEMENT_CAPTURE_MAX_TOTAL_BYTES = 4 * 1024 * 1024;
export const REFINEMENT_CAPTURE_MAX_FILES = 200;

/**
 * Per-session quota on TOTAL retained refinement-inverse blob bytes — the
 * rollback horizon. The capture budgets above bound one event, but nothing
 * bounded the aggregate: a prompt-influenced loop mutating a large memory
 * file with a changing suffix captures the complete prior content per edit,
 * each unique version over the inline cap becoming a durable blob, growing
 * disk without any bash/file grant. Newest inverses keep their payloads up
 * to this quota; older payload blobs are deleted while the refinement rows
 * remain as an audit record (rolling them back fails with a descriptive
 * beyond-the-horizon error). 4x the per-event capture budget retains the
 * most recent edits — e.g. the last ~160 unique 100KB memory-file versions —
 * comfortably beyond any practical rollback need.
 */
export const REFINEMENT_INVERSE_BLOB_QUOTA_BYTES = 16 * 1024 * 1024;

/** One file to restore: exactly one of `text` (legacy inline rows written by
 * older binaries — new rows always use `blobRef`, see resolveRefinementInverse)
 * or `blobRef` (content-addressed, quota-managed payload). */
export const RefinementFileSchema = z
  .object({
    /**
     * Absolute physical path: host-local for memory files, runtime-namespace
     * for skill files on remote runtimes (the inverse is applied through the
     * same filesystem that performed the action).
     */
    path: z.string().min(1),
    text: z.string().optional(),
    blobRef: BlobRefSchema.optional(),
  })
  .refine((file) => (file.text === undefined) !== (file.blobRef === undefined), {
    message: "refinement file requires exactly one of text or blobRef",
  });

/**
 * Invertible file-level operations. File-level (rather than command-level)
 * payloads keep the applier trivial and byte-exact: no re-parsing of memory
 * commands or skill frontmatter is needed to roll an edit back.
 */
export const RefinementInverseSchema = z.discriminatedUnion("op", [
  z.object({ op: z.literal("delete-files"), paths: z.array(z.string().min(1)).min(1) }),
  z.object({
    op: z.literal("restore-files"),
    files: z.array(RefinementFileSchema),
    /**
     * Paths this inverse must DELETE in addition to restoring `files` (r67):
     * a rollback row captured from a mixed force-apply pre-state (some
     * targets existed, others were about to be force-created) must both
     * restore the edited files and delete the force-created ones, or the
     * rollback chain silently leaves files behind on a double rollback.
     * Optional for compatibility: rows from older binaries never carry it,
     * and older binaries parsing new rows strip the field (degrading to the
     * pre-r67 restore-only behavior instead of failing).
     */
    deletePaths: z.array(z.string().min(1)).optional(),
  }),
  z.object({ op: z.literal("rename"), from: z.string().min(1), to: z.string().min(1) }),
]);
export type RefinementInverse = z.infer<typeof RefinementInverseSchema>;

/**
 * Expected post-action file state, recorded at write time: sha256 of each
 * file's contents exactly as the action left them. Rollback compares these
 * hashes against the current files before restoring, so manual or
 * cross-workspace edits — which never appear in this session's journal — are
 * detected as divergence. Optional: rows written before this field existed
 * (and rollback rows, which never record it) fall back to presence-only
 * divergence checks because their post-edit contents cannot be reconstructed.
 */
export const RefinementPostStateSchema = z.object({
  files: z.array(z.object({ path: z.string().min(1), sha256: z.string().length(64) })),
});
export type RefinementPostState = z.infer<typeof RefinementPostStateSchema>;

/** Action payload for `data.kind === "memory"` rows (memory tool commands). */
export const MemoryRefinementActionSchema = z.object({
  op: z.enum(["create", "str_replace", "insert", "delete", "rename"]),
  /** Virtual memory path (/memories/<scope>/...). */
  path: z.string().min(1),
  /** Destination virtual path (rename only). */
  newPath: z.string().optional(),
});
export type MemoryRefinementAction = z.infer<typeof MemoryRefinementActionSchema>;

/** Action payload for `data.kind === "skill"` rows (agent_skill_write/delete). */
export const SkillRefinementActionSchema = z.object({
  op: z.enum(["write", "delete-file", "delete-skill"]),
  skillName: z.string().min(1),
  /** Skill-relative file path (absent for delete-skill). */
  filePath: z.string().optional(),
});
export type SkillRefinementAction = z.infer<typeof SkillRefinementActionSchema>;

/**
 * Action payload for rollback rows (r6). A rollback applies the target row's
 * inverse, so the row carries the same `kind` as its target (memory | skill)
 * and is itself a legal rollback target (double inversion).
 */
export const RollbackRefinementActionSchema = z.object({
  op: z.literal("rollback"),
  /** Envelope `id` of the row this rollback applied the inverse of. */
  of: z.string().min(1),
  /** Caller-supplied justification (model tool calls record it here). */
  reason: z.string().optional(),
});
export type RollbackRefinementAction = z.infer<typeof RollbackRefinementActionSchema>;

/** Attribution for a refinement row: who/what performed the mutation. */
export const RefinementEvidenceSchema = z.object({
  workspaceId: z.string().min(1),
  toolName: z.string().min(1),
  /** Provider tool call id, when the mutation came from a model tool call. */
  toolCallId: z.string().optional(),
  /** Memory mutations record the acting party ("agent" | "user"). */
  actor: z.string().optional(),
});
export type RefinementEvidence = z.infer<typeof RefinementEvidenceSchema>;

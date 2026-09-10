import { z } from "zod";
import { MEMORY_SCOPES } from "@/common/constants/memory";

/**
 * Schemas for the Memory tab oRPC surface (experiment: "memory").
 * Paths are always virtual (/memories/<scope>/...); the backend MemoryService
 * owns the physical mapping and the security envelope.
 */

export const MemoryScopeSchema = z.enum(MEMORY_SCOPES);

export const MemoryActorSchema = z.enum(["agent", "user"]);

/** One memory file in the bulk list (all scopes, one IPC call). */
export const MemoryFileInfoSchema = z.object({
  /** Virtual path (e.g. /memories/global/prefs.md). */
  path: z.string(),
  scope: MemoryScopeSchema,
  /** Sanitized single-line frontmatter description (may be empty). */
  description: z.string(),
  /** User pin state from the host-local sidecar (never stored in the file). */
  pinned: z.boolean(),
  /** Recorded uses (reads, writes, pins) from the host-local sidecar. */
  accessCount: z.number(),
  /** Timestamp of the most recent use; null when never used. */
  lastAccessedAt: z.number().nullable(),
});
export type MemoryFileInfo = z.infer<typeof MemoryFileInfoSchema>;

/** File change emitted by the MemoryService (agent tool + UI writes). */
export const MemoryFileChangeEventSchema = z.object({
  kind: z.literal("file").optional(),
  scope: MemoryScopeSchema,
  /** Virtual path of the changed file or directory. */
  path: z.string(),
  actor: MemoryActorSchema,
  /** Workspace whose scope context performed the change. */
  workspaceId: z.string(),
  /** Stable project identity of the emitting scope context. */
  projectPath: z.string(),
});

/** Sidecar-only consolidation coverage changed; subscribers should refetch status. */
export const MemoryConsolidationStatusChangeEventSchema = z.object({
  kind: z.literal("consolidation_status"),
  /** Workspace whose run advanced its workspace coverage record. */
  workspaceId: z.string(),
  /** Single-project identity covered by the run, or "" for multi-project workspaces. */
  projectPath: z.string(),
});
export type MemoryConsolidationStatusChangeEventPayload = z.infer<
  typeof MemoryConsolidationStatusChangeEventSchema
>;

export const MemoryChangeEventSchema = z.union([
  MemoryFileChangeEventSchema,
  MemoryConsolidationStatusChangeEventSchema,
]);
export type MemoryChangeEventPayload = z.infer<typeof MemoryChangeEventSchema>;

/**
 * Save failures distinguish conflicts (sha precondition failed; the UI shows
 * a conflict banner and offers reload) from plain errors.
 */
export const MemorySaveErrorSchema = z.object({
  kind: z.enum(["conflict", "error"]),
  message: z.string(),
});
export type MemorySaveError = z.infer<typeof MemorySaveErrorSchema>;

/**
 * One journaled mutating command from a consolidation ("dream") run.
 * Single source of truth: the node services derive their types from these
 * schemas (z.infer), so a field added on the node side cannot silently be
 * stripped by oRPC output validation.
 */
export const MemoryConsolidationOpSchema = z.object({
  command: z.enum(["create", "str_replace", "insert", "delete", "rename"]),
  path: z.string(),
  newPath: z.string().optional(),
  applied: z.boolean(),
  note: z.string().optional(),
});
export type MemoryConsolidationOp = z.infer<typeof MemoryConsolidationOpSchema>;

/** Persisted record of the latest consolidation run for a workspace. */
export const MemoryConsolidationRecordSchema = z.object({
  lastRunAt: z.number(),
  trigger: z.enum(["compaction", "launch", "archive", "manual"]),
  summary: z.string(),
  ops: z.array(MemoryConsolidationOpSchema),
  /** Token cost of the run (absent for records persisted before telemetry). */
  usage: z.object({ inputTokens: z.number(), outputTokens: z.number() }).optional(),
});
export type MemoryConsolidationRecordPayload = z.infer<typeof MemoryConsolidationRecordSchema>;

export const CompactionCompletionMetadataSchema = z.object({
  workspaceId: z.string(),
  summaryMessageId: z.string(),
  summaryHistorySequence: z.number(),
  compactionEpoch: z.number(),
  previousBoundaryHistorySequence: z.number().optional(),
  compactionRequestMessageId: z.string(),
  // RLM keep-recent floor: preserved-tail copies appended after the boundary.
  preservedTailMessageCount: z.number().optional(),
});

export const MemoryHarvestRecordSchema = z.object({
  status: z.enum(["pending", "completed", "failed"]),
  startedAt: z.number(),
  completedAt: z.number().optional(),
  attemptCount: z.number(),
  boundaryKey: z.string(),
  compactionEpoch: z.number(),
  acceptedCandidates: z.number(),
  skippedCandidates: z.number(),
  error: z.string().optional(),
  usage: z.object({ inputTokens: z.number(), outputTokens: z.number() }).optional(),
  completionMetadata: CompactionCompletionMetadataSchema.optional(),
});
export type MemoryHarvestRecordPayload = z.infer<typeof MemoryHarvestRecordSchema>;

export const MemoryConsolidationStatusSchema = z.object({
  workspaceRecord: MemoryConsolidationRecordSchema.nullable(),
  projectRecord: MemoryConsolidationRecordSchema.nullable(),
  globalRecord: MemoryConsolidationRecordSchema.nullable(),
  latestHarvestRecord: MemoryHarvestRecordSchema.nullable(),
  projectAvailable: z.boolean(),
});
export type MemoryConsolidationStatusPayload = z.infer<typeof MemoryConsolidationStatusSchema>;
export type MemoryConsolidationTrigger = MemoryConsolidationRecordPayload["trigger"];

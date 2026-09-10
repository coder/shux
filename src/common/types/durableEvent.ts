/**
 * Durable agent event record schema — the joint design constraint shared by
 * the plugin-architecture track (turn envelopes, hook-injected context) and
 * the RLM track (refinement journal, offloaded result handles).
 *
 * Rows are appended to per-session JSONL journals via the journal kit
 * (src/node/utils/journal/). Invariants:
 * - "model-visible ⟺ logged": anything the model can see must exist as a
 *   durable row first (append-time materialization, never request-time
 *   injection), so log replay can reconstruct requests byte-for-byte.
 * - Large payloads (full prompt text, offloaded values, vars snapshots) are
 *   content-addressed in the blob store and referenced by BlobRef.
 * - Readers are tolerant: malformed lines and unknown kinds are skipped
 *   (self-heal doctrine), so new kinds can be added without breaking readers.
 */

import { z } from "zod";
import { JsonValueSchema } from "@/common/orpc/schemas/workflow";

export const DURABLE_EVENT_VERSION = 1;

/** Reference into a content-addressed blob store: `sha256:<64 hex chars>`. */
export const BlobRefSchema = z.string().regex(/^sha256:[0-9a-f]{64}$/);
export type BlobRef = z.infer<typeof BlobRefSchema>;

/**
 * Turn envelope: the request fingerprint for one stream turn. Full prompt text
 * is content-addressed; the row stores only hashes so envelope comparison is
 * cheap and the journal stays small.
 */
export const TurnEnvelopeDataSchema = z.object({
  systemPromptHash: BlobRefSchema,
  /** Sorted by tool name; schemaHash fingerprints the tool's input schema. */
  toolsetManifest: z.array(z.object({ name: z.string(), schemaHash: z.string() })),
  /**
   * Tool names the agent-transition sentinel advertised, when they differ from
   * the wire manifest: forced first-step scoping (e.g. xAI search) narrows the
   * wire toolset while the sentinel still lists the full active set, so replay
   * cannot derive one from the other.
   */
  sentinelToolNames: z.array(z.string()).optional(),
  modelString: z.string(),
  providerOptionsHash: z.string(),
  thinkingLevel: z.string(),
  // The fields below are optional so rows written by older binaries stay
  // readable (z.object strips unknown keys, so newer rows also stay readable
  // by older binaries — upgrade↔downgrade safe).
  /**
   * The request's requestHistorySequence (max historySequence of the chat.jsonl
   * rows the request was built from). Join key that re-anchors this envelope to
   * its assistant row and its recorded devtools run — array-index pairing
   * breaks on retries, devtools toggling, and compaction.
   */
  requestHistorySequence: z.number().int().nonnegative().optional(),
  /**
   * Resolved wire provider name (providerModelFactory). Coder instance-typed
   * gateway strings cannot be name-canonicalized to a wire provider offline,
   * so replay needs the resolved value logged.
   */
  wireProviderName: z.string().optional(),
  /** Per-send Anthropic cache TTL override ("5m" | "1h"); absent = default. */
  anthropicCacheTtl: z.string().optional(),
  /** Plan content injected on a plan→exec handoff (blob-stored, model-visible). */
  planTransitionContentHash: BlobRefSchema.optional(),
  /** Plan file path referenced by the plan→exec handoff injection. */
  planTransitionFilePath: z.string().optional(),
  /** JSON-serialized PostCompactionAttachment[] injected this turn (blob-stored). */
  postCompactionAttachmentsHash: BlobRefSchema.optional(),
  /**
   * JSON-serialized MuxMessage: the partial-output continuation a refusal
   * fallback appended to its request (blob-stored). The turn's eventual
   * assistant row lands after requestHistorySequence, so replay cannot
   * recover this message from chat.jsonl alone.
   */
  partialContinuationHash: BlobRefSchema.optional(),
});

/**
 * Refinement journal entry: an auditable, invertible harness edit.
 * `data.kind` is the refinement's own taxonomy (e.g. "skill-edit"); the
 * envelope `kind` stays the discriminator, which is why payloads are nested.
 */
export const RefinementDataSchema = z.object({
  kind: z.string(),
  action: JsonValueSchema,
  inverse: JsonValueSchema,
  evidence: JsonValueSchema.optional(),
  /** Envelope `id` of the entry this one rolls back. */
  rollbackOf: z.string().optional(),
  /**
   * Stable source identity (`<workspaceId>:<row id>`) when this row was
   * copied from a removed sub-agent's journal into its memory owner's
   * (sharedMemoryRowMigration.ts); lets a retried migration skip it.
   */
  migratedFrom: z.string().optional(),
  /**
   * Where a migrated row was ORIGINALLY appended: the journal (workspace id)
   * whose append sequence positions it, and its `seq` there. Two rows of one
   * origin were serialized by that store's mutation lock (clock + append run
   * inside it), so their origin sequence IS their mutation order — even when
   * neither carries a usable clock value (pre-sharing history, a failed clock
   * write). Copies are appended to the owner journal later than they happened
   * and in migration order, so their own `seq` is no order evidence; a
   * copy-of-copy keeps the first origin. Absent on a copy (older builds,
   * corruption) = order unknown, never the copying journal's position.
   * Native rows need no fields: their origin is (`workspaceId`, `seq`).
   */
  originJournal: z.string().optional(),
  originSeq: z.number().optional(),
  /**
   * Cross-session order key for rollback conflict detection (`sourceTs ?? ts`):
   * a shared workspace store's monotonic clock, advanced under the store's
   * mutation lock by every mutation (workspaceMemoryRevision.ts), so rows in
   * an owner's and its sub-agents' journals — whose `ts`/`seq` are not
   * comparable — still order totally; migrated rows keep their source value.
   * Persisted rows are raw JSON: only a value isValidSourceClock accepts is
   * order evidence; a present value outside that domain reads as order
   * unknown (refinementRollback.ts), never as "earlier than everything".
   */
  sourceTs: z.number().optional(),
  /**
   * The mutation landed but the shared store's clock write failed, so this
   * row has NO defensible position relative to other rows (its `ts`/`seq`
   * are journal-local). Rollback conflict detection treats such a row as
   * conflicting with every overlapping row in either direction (force
   * overrides), instead of ordering it by an incomparable timestamp.
   */
  orderUnknown: z.literal(true).optional(),
  /** Expected post-action file hashes (RefinementPostStateSchema in refinement.ts). */
  postState: JsonValueSchema.optional(),
  /**
   * "remote" when the mutation ran through a non-local runtime (SSH/Docker):
   * its inverse paths are runtime-namespace and must not be applied to the
   * host filesystem. Absent (older rows / local runtimes) = host-local.
   */
  runtime: z.string().optional(),
});

/**
 * Offloaded result handle: a large tool result stored instead of returned.
 * The row is the durable source of the model-visible text (handle + preview +
 * size), so "model-visible ⟺ logged" holds for offloads.
 */
export const ResultHandleDataSchema = z.object({
  handle: z.string(),
  preview: z.string(),
  blobHash: BlobRefSchema,
  size: z.number().int().nonnegative(),
});

/**
 * Hook-injected context: content a hook adds to a request. Materialized at
 * append time; exactly one of `text` (small) or `blobHash` (large) is set.
 */
export const HookContextDataSchema = z
  .object({
    hookId: z.string(),
    /** Where the content lands, e.g. "system-prompt" or "user-context". */
    placement: z.string(),
    text: z.string().optional(),
    blobHash: BlobRefSchema.optional(),
  })
  .refine((data) => (data.text === undefined) !== (data.blobHash === undefined), {
    message: "hook-context requires exactly one of text or blobHash",
  });

/** Sandbox persistent-mount `vars` snapshot (JSON text stored in blob store). */
export const SandboxVarsSnapshotDataSchema = z.object({
  scopeKey: z.string(),
  blobHash: BlobRefSchema,
  size: z.number().int().nonnegative(),
  /**
   * Marks a context-reset tombstone (r52): an empty snapshot superseding all
   * prior ones. The count of reset-marked rows per scope is its "reset
   * generation" — persistent mounts capture it at creation and re-verify it
   * before every lease and persist, so a mount still alive in ANOTHER
   * backend (XUM_ALLOW_MULTIPLE_INSTANCES=1) cannot expose or re-persist
   * vars the user discarded. Absent on ordinary snapshots and on pre-r52
   * rows (both count as generation contributions of zero).
   */
  reset: z.boolean().optional(),
});

/** Envelope shared by all durable agent events (one JSONL row each). */
const envelopeBase = {
  v: z.literal(DURABLE_EVENT_VERSION),
  /** Per-journal monotonic sequence, assigned at append. */
  seq: z.number().int().nonnegative(),
  /** Stable unique id; dedupe key on read. */
  id: z.string().min(1),
  /** Epoch milliseconds. */
  ts: z.number(),
  workspaceId: z.string().min(1),
};

export const DurableEventSchema = z.discriminatedUnion("kind", [
  z.object({ ...envelopeBase, kind: z.literal("turn-envelope"), data: TurnEnvelopeDataSchema }),
  z.object({ ...envelopeBase, kind: z.literal("refinement"), data: RefinementDataSchema }),
  z.object({ ...envelopeBase, kind: z.literal("result-handle"), data: ResultHandleDataSchema }),
  z.object({ ...envelopeBase, kind: z.literal("hook-context"), data: HookContextDataSchema }),
  z.object({
    ...envelopeBase,
    kind: z.literal("sandbox-vars-snapshot"),
    data: SandboxVarsSnapshotDataSchema,
  }),
]);

export type DurableEvent = z.infer<typeof DurableEventSchema>;

/** Omit that distributes over union members, preserving the discriminant pairing. */
type DistributiveOmit<T, K extends PropertyKey> = T extends unknown ? Omit<T, K> : never;

/** Fields callers provide to append; seq/ts/v are assigned by the journal kit
 * (id too, unless the caller supplies a stable one). */
export type DurableEventDraft = DistributiveOmit<DurableEvent, "v" | "seq" | "id" | "ts"> & {
  id?: string;
};

/**
 * A usable shared-store clock value: the clock is `max(Date.now(), prev + 1)`
 * (workspaceMemoryRevision.ts), so a genuine value is a positive safe integer.
 * Zero, negatives, fractions, unsafe integers and non-numbers are corruption.
 */
export function isValidSourceClock(value: unknown): value is number {
  return typeof value === "number" && Number.isSafeInteger(value) && value > 0;
}

/** Where a refinement row was originally appended (see `originJournal`). */
export interface RefinementRowOrigin {
  journal: string;
  seq: number;
}

/**
 * The journal position that orders a refinement row against rows of the same
 * origin (RefinementDataSchema.originJournal). A native row is positioned by
 * its own journal; a migrated copy only by a carried, well-formed origin —
 * anything else about a copy is no order evidence (null).
 */
export function refinementRowOrigin(row: {
  workspaceId: string;
  seq: number;
  data: { migratedFrom?: string; originJournal?: unknown; originSeq?: unknown };
}): RefinementRowOrigin | null {
  if (row.data.migratedFrom === undefined) return { journal: row.workspaceId, seq: row.seq };
  const { originJournal, originSeq } = row.data;
  if (
    typeof originJournal !== "string" ||
    originJournal === "" ||
    typeof originSeq !== "number" ||
    !Number.isSafeInteger(originSeq) ||
    originSeq < 0
  ) {
    return null;
  }
  return { journal: originJournal, seq: originSeq };
}

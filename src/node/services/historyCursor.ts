import {
  SESSION_HISTORY_MAX_ID_CHARS,
  SESSION_HISTORY_CURSOR_MAX_ENTRIES,
  SESSION_HISTORY_CURSOR_MAX_BYTES,
  SESSION_HISTORY_CURSOR_TTL_MS,
  SESSION_HISTORY_RESET_PROBE_CHARS,
} from "@/common/constants/contextBudget";
import { CONTEXT_BOUNDARY_KINDS } from "@/common/constants/contextBoundary";
import { randomBytes } from "node:crypto";
import assert from "node:assert";
import { LRUCache } from "lru-cache";
import { z } from "zod";

/** IDs must fit tool inputs and their JSON/cursor envelopes without lossy aliases. */
export function isHistoryIdentifierRepresentable(id: string): boolean {
  return (
    id.length <= SESSION_HISTORY_MAX_ID_CHARS &&
    Buffer.byteLength(JSON.stringify(id)) <= SESSION_HISTORY_MAX_ID_CHARS
  );
}

const offset = z.number().int().nonnegative().safe();
export const HistoryArtifactSchema = z.enum(["chat", "archive"]);
export type HistoryArtifact = z.infer<typeof HistoryArtifactSchema>;
export const HistorySnapshotSchema = z
  .object({
    endOffsetSnapshot: offset,
    inode: z.string(),
    modifiedTimeMs: z.number(),
    headHash: z.string(),
    anchorHash: z.string(),
  })
  .strict();
export type HistorySnapshot = z.infer<typeof HistorySnapshotSchema>;
const positionFields = {
  byteOffset: offset,
  skippingOversized: z.boolean(),
  oversizedRowEnd: offset.nullable(),
  resetProbe: z.string().max(SESSION_HISTORY_RESET_PROBE_CHARS),
  resetStage: z.union([z.literal(0), z.literal(1), z.literal(2)]),
  possibleReset: z.boolean(),
};
// null means an unaddressable persisted window, not an alias for the root.
const windowIdField = z.string().refine(isHistoryIdentifierRepresentable).nullable();
const windowBoundaryKindField = z.nativeEnum(CONTEXT_BOUNDARY_KINDS).nullable();
const rowLocation = z.object({ artifact: HistoryArtifactSchema, byteOffset: offset }).strict();
export const HistoryScanStateSchema = z
  .object({
    provenanceEpoch: z.string().uuid(),
    snapshots: z.object({ chat: HistorySnapshotSchema, archive: HistorySnapshotSchema }).strict(),
    validatedChatSnapshot: HistorySnapshotSchema,
    // Oldest-first: floor -> browse -> done. Newest-first: floor -> (probe -> deliver)* -> done.
    phase: z.enum(["floor", "browse", "probe", "deliver", "done"]),
    recentFirst: z.boolean(),
    artifact: HistoryArtifactSchema,
    ...positionFields,
    archiveWatermark: z.number().int().min(-1).safe(),
    anchorSequence: offset.nullable(),
    windowId: windowIdField,
    windowBoundaryKind: windowBoundaryKindField,
    windowPending: z.boolean(),
    appendCheck: z
      .object({ snapshot: HistorySnapshotSchema, ...positionFields })
      .strict()
      .nullable(),
    // Newest-first browsing never crosses the floor discovered by the floor phase.
    floor: z
      .object({
        artifact: HistoryArtifactSchema,
        byteOffset: offset,
        windowId: windowIdField,
        windowBoundaryKind: windowBoundaryKindField,
      })
      .strict()
      .nullable(),
    // Reverse discovery position: only locations, never buffered rows.
    probe: z
      .object({
        artifact: HistoryArtifactSchema,
        ...positionFields,
        lowestReadable: rowLocation.nullable(),
      })
      .strict()
      .nullable(),
    // The window span currently being delivered in reverse, ending at artifact/byteOffset above.
    span: z
      .object({
        start: rowLocation,
        windowId: windowIdField,
        windowBoundaryKind: windowBoundaryKindField,
        startsWindow: rowLocation.nullable(),
      })
      .strict()
      .nullable(),
  })
  .strict();
export type HistoryScanState = z.infer<typeof HistoryScanStateSchema>;

export interface HistoryCursor {
  workspaceId: string;
  action: "list_windows" | "list_items" | "search" | "read_item";
  query: string;
  // null while a descendant read is still proving authorization in the caller's history.
  scan: HistoryScanState | null;
  // Keep the finished caller scan to revalidate its privacy floor on later target pages.
  authorization: { branchRoot: string; scan: HistoryScanState; proven: boolean } | null;
}

/** Backend-owned continuations avoid asking models to copy serialized scan state.
 * Each HistoryService owns a separate store; restart/eviction requires a fresh query.
 * Possession never replaces caller binding or the scanner's privacy revalidation.
 */
export class HistoryCursorStore {
  private readonly entries = new LRUCache<string, HistoryCursor>({
    max: SESSION_HISTORY_CURSOR_MAX_ENTRIES,
    maxSize: SESSION_HISTORY_CURSOR_MAX_BYTES,
    ttl: SESSION_HISTORY_CURSOR_TTL_MS,
    // Lazy expiry only: even the clock cache must not schedule a timer.
    ttlResolution: 0,
  });

  save(cursor: HistoryCursor): string {
    const saved = structuredClone(cursor);
    const size = Buffer.byteLength(JSON.stringify(saved));
    assert(size <= SESSION_HISTORY_CURSOR_MAX_BYTES, "history continuation exceeds metadata quota");
    const token = `hc1_${randomBytes(16).toString("base64url")}`;
    this.entries.set(token, saved, { size });
    return token;
  }

  load(
    token: string,
    binding: Pick<HistoryCursor, "workspaceId" | "action" | "query">
  ): Pick<HistoryCursor, "scan" | "authorization"> {
    const cursor = this.entries.get(token);
    if (
      !cursor ||
      cursor.workspaceId !== binding.workspaceId ||
      cursor.action !== binding.action ||
      cursor.query !== binding.query
    )
      throw new Error("invalid_cursor");
    // Retries (including concurrent calls) must start at the same immutable position.
    return structuredClone({ scan: cursor.scan, authorization: cursor.authorization });
  }
}

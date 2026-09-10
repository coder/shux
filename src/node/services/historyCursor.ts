import {
  SESSION_HISTORY_MAX_ID_CHARS,
  SESSION_HISTORY_RESET_PROBE_CHARS,
} from "@/common/constants/contextBudget";
import { CONTEXT_BOUNDARY_KINDS } from "@/common/constants/contextBoundary";
import { createHmac, randomBytes, timingSafeEqual } from "node:crypto";
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

const CursorSchema = z
  .object({
    version: z.literal(1),
    workspaceId: z.string(),
    action: z.enum(["list_windows", "list_items", "search", "read_item"]),
    query: z.string(),
    // null while a descendant read is still proving authorization in the caller's history.
    scan: HistoryScanStateSchema.nullable(),
    // Descendant reads: bounded scan of the caller's own post-floor history looking for the
    // branch root's creation receipt. Present until proven; the proof is then carried as the
    // finished scan so later pages can revalidate the caller snapshot (an appended manual
    // reset expires it) before disclosing more target rows.
    authorization: z
      .object({ branchRoot: z.string(), scan: HistoryScanStateSchema, proven: z.boolean() })
      .strict()
      .nullable(),
  })
  .strict();
export type HistoryCursor = z.infer<typeof CursorSchema>;
// Authentication prevents a model from manufacturing a pre-reset byte offset.
// A backend restart intentionally expires cursors; callers can restart their query.
const cursorKey = randomBytes(32);
export function encodeHistoryCursor(cursor: Omit<HistoryCursor, "version">): string {
  const data = JSON.stringify({ version: 1, ...cursor });
  const signature = createHmac("sha256", cursorKey).update(data).digest("hex");
  return Buffer.from(JSON.stringify({ data, signature })).toString("base64url");
}
export function decodeHistoryCursor(
  value: string,
  binding: Pick<HistoryCursor, "workspaceId" | "action" | "query">
): Pick<HistoryCursor, "scan" | "authorization"> {
  try {
    const envelope = z
      .object({ data: z.string(), signature: z.string().regex(/^[a-f0-9]{64}$/) })
      .strict()
      .parse(JSON.parse(Buffer.from(value, "base64url").toString("utf8")));
    const expected = createHmac("sha256", cursorKey).update(envelope.data).digest();
    if (!timingSafeEqual(expected, Buffer.from(envelope.signature, "hex"))) throw new Error();
    const cursor = CursorSchema.parse(JSON.parse(envelope.data));
    if (
      cursor.workspaceId !== binding.workspaceId ||
      cursor.action !== binding.action ||
      cursor.query !== binding.query
    )
      throw new Error();
    return { scan: cursor.scan, authorization: cursor.authorization };
  } catch {
    throw new Error("invalid_cursor");
  }
}

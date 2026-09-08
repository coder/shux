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
export const HistoryScanStateSchema = z
  .object({
    provenanceEpoch: z.string().uuid(),
    snapshots: z.object({ chat: HistorySnapshotSchema, archive: HistorySnapshotSchema }).strict(),
    validatedChatSnapshot: HistorySnapshotSchema,
    phase: z.enum(["floor", "browse", "done"]),
    artifact: HistoryArtifactSchema,
    byteOffset: offset,
    skippingOversized: z.boolean(),
    oversizedRowEnd: offset.nullable(),
    resetProbe: z.string().max(SESSION_HISTORY_RESET_PROBE_CHARS),
    resetStage: z.union([z.literal(0), z.literal(1), z.literal(2)]),
    possibleReset: z.boolean(),
    archiveWatermark: z.number().int().min(-1).safe(),
    anchorSequence: offset.nullable(),
    // null means an unaddressable persisted window, not an alias for the root.
    windowId: z.string().refine(isHistoryIdentifierRepresentable).nullable(),
    windowBoundaryKind: z.nativeEnum(CONTEXT_BOUNDARY_KINDS).nullable(),
    windowPending: z.boolean(),
    appendCheck: z
      .object({
        snapshot: HistorySnapshotSchema,
        byteOffset: offset,
        skippingOversized: z.boolean(),
        oversizedRowEnd: offset.nullable(),
        resetProbe: z.string().max(SESSION_HISTORY_RESET_PROBE_CHARS),
        resetStage: z.union([z.literal(0), z.literal(1), z.literal(2)]),
        possibleReset: z.boolean(),
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
    action: z.enum(["list_windows", "search", "read_item"]),
    query: z.string(),
    scan: HistoryScanStateSchema,
  })
  .strict();
type HistoryCursor = z.infer<typeof CursorSchema>;
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
): HistoryScanState {
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
    return cursor.scan;
  } catch {
    throw new Error("invalid_cursor");
  }
}

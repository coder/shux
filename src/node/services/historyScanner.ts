import { createScanner, SyntaxKind } from "jsonc-parser";
import * as fs from "node:fs/promises";
import { MuxMessageSchema } from "@/common/orpc/schemas/message";
import { isPlainObject } from "@/common/utils/isPlainObject";
import { createHash } from "node:crypto";
import assert from "node:assert";
import {
  SESSION_HISTORY_MAX_SCAN_BYTES,
  SESSION_HISTORY_SCAN_CHUNK_BYTES,
  SESSION_HISTORY_ANCHOR_BYTES,
  SESSION_HISTORY_RESET_NEEDLE,
  SESSION_HISTORY_RESET_PROBE_CHARS,
  SESSION_HISTORY_MAX_SCAN_ROWS,
  SESSION_HISTORY_MAX_LINE_BYTES,
} from "@/common/constants/contextBudget";
import type { MuxMessage } from "@/common/types/message";
import { getContextWindowId, isManualHistoryReset } from "@/common/utils/messages/contextWindows";
import {
  getContextBoundaryKind,
  isDurableContextBoundaryMarker,
} from "@/common/utils/messages/compactionBoundary";
import { normalizeLegacyMuxMetadata } from "@/node/utils/messages/legacy";
import {
  isHistoryIdentifierRepresentable,
  type HistoryArtifact,
  type HistoryScanState,
  type HistorySnapshot,
} from "./historyCursor";

const [resetKeyToken, resetValueToken] = SESSION_HISTORY_RESET_NEEDLE.split(":");
const resetTokenPattern = new RegExp(
  [resetKeyToken, resetValueToken, ":"]
    .map((token) =>
      [...token]
        .map((character) => {
          const hex = character
            .charCodeAt(0)
            .toString(16)
            .padStart(4, "0")
            .replace(/[a-f]/g, (letter) => `[${letter}${letter.toUpperCase()}]`);
          return `(?:${character}|\\\\(?:u${hex}|x${hex.slice(2)}))`;
        })
        .join("")
    )
    .join("|"),
  "g"
);

export function isReadableHistoryMessage(value: unknown): value is MuxMessage {
  return (
    !!value &&
    typeof value === "object" &&
    "id" in value &&
    typeof value.id === "string" &&
    "role" in value &&
    ["user", "assistant", "system"].includes(String(value.role)) &&
    (!("metadata" in value) ||
      value.metadata === undefined ||
      (value.metadata !== null &&
        typeof value.metadata === "object" &&
        !Array.isArray(value.metadata))) &&
    "parts" in value &&
    MuxMessageSchema.shape.parts.safeParse(value.parts).success
  );
}

// Corrupted JSON can contain JS hex escapes; raw and incremental probes must
// recognize the same reset tokens without making the row provider-readable.
function decodeResetEscapes(text: string): string {
  return text.replace(/\\(?:u[\da-fA-F]{4}|x[\da-fA-F]{2})/g, (escape) =>
    String.fromCharCode(Number.parseInt(escape.slice(2), 16))
  );
}

function compactResetProbe(text: string): string {
  // Corruption may insert raw or escaped control separators where JSON permits
  // whitespace. Remove them before retaining overlap, including long runs.
  return text.replace(/[\s\p{Cc}]/gu, "").replace(/\\(?:u00|x)(?:[0189][\da-f]|20|7f)/gi, "");
}

export function hasRawResetMarker(text: string): boolean {
  const decoded = decodeResetEscapes(compactResetProbe(text));
  return decoded.includes(SESSION_HISTORY_RESET_NEEDLE);
}

/** Call only for parsed reset candidates; oversized rows cannot establish a rollover exemption. */
export function hasAmbiguousResetKeys(text: string): boolean {
  if (Buffer.byteLength(text, "utf8") > SESSION_HISTORY_MAX_LINE_BYTES) return true;
  const scanner = createScanner(text, true);
  const scopes: Array<Set<string> | null> = [];
  let previousString: string | undefined;
  for (let token = scanner.scan(); token !== SyntaxKind.EOF; token = scanner.scan()) {
    switch (token) {
      case SyntaxKind.OpenBraceToken:
        scopes.push(new Set());
        break;
      case SyntaxKind.OpenBracketToken:
        scopes.push(null);
        break;
      case SyntaxKind.CloseBraceToken:
      case SyntaxKind.CloseBracketToken:
        scopes.pop();
        break;
      case SyntaxKind.StringLiteral:
        // Token values decode escapes, so metadata and metad\\u0061ta collide.
        previousString = scanner.getTokenValue();
        continue;
      case SyntaxKind.ColonToken: {
        const keys = scopes.at(-1);
        assert(keys && previousString !== undefined, "parsed JSON colon must follow an object key");
        if (keys.has(previousString)) return true;
        keys.add(previousString);
        break;
      }
      default:
        break;
    }
    previousString = undefined;
  }
  return false;
}

interface HistoryResetProbe {
  resetProbe: string;
  resetStage: 0 | 1 | 2;
  possibleReset: boolean;
}

function addHistoryResetProbe(state: HistoryResetProbe, segment: Buffer, reverse: boolean): void {
  // Oversized tool outputs remain traversable. Only a potential reset
  // marker is a fail-closed privacy barrier. Match raw bytes (including
  // nested objects conservatively) without parsing or retaining the row.
  // Keep only token-sized raw overlap plus a three-stage recognizer.
  // Junk of arbitrary size may separate intact tokens in unreadable rows;
  // valid rows isolate their own evidence in deliver() and reset this state.
  const raw = segment.toString("latin1");
  const previousLength = state.resetProbe.length;
  const probe = reverse ? raw + state.resetProbe : state.resetProbe + raw;
  const tokens = [...probe.matchAll(resetTokenPattern)];
  if (reverse) tokens.reverse();
  for (const match of tokens) {
    // Ignore tokens entirely inside already-consumed overlap. Otherwise
    // replaying overlap could manufacture the opposite token ordering.
    if (reverse ? match.index >= raw.length : match.index + match[0].length <= previousLength)
      continue;
    const token = decodeResetEscapes(match[0]);
    if (token === (reverse ? resetValueToken : resetKeyToken)) {
      if (state.resetStage === 0) state.resetStage = 1;
    } else if (token === ":" && state.resetStage === 1) state.resetStage = 2;
    else if (token === (reverse ? resetKeyToken : resetValueToken) && state.resetStage === 2)
      state.possibleReset = true;
  }
  state.resetProbe = reverse
    ? probe.slice(0, SESSION_HISTORY_RESET_PROBE_CHARS - 1)
    : probe.slice(-(SESSION_HISTORY_RESET_PROBE_CHARS - 1));
}

function classifyHistoryScanRow(text: string, probe: HistoryResetProbe): MuxMessage | null {
  let rowReset = hasRawResetMarker(text);
  probe.possibleReset ||= rowReset;
  try {
    const raw: unknown = JSON.parse(text);
    try {
      rowReset ||= JSON.stringify(raw).includes(SESSION_HISTORY_RESET_NEEDLE);
      probe.possibleReset ||= rowReset;
    } catch {
      rowReset = true;
      probe.possibleReset = true;
    }
    if (rowReset && hasAmbiguousResetKeys(text)) return null;
    if (!isReadableHistoryMessage(raw)) return null;
    // Readable payloads may discuss resets; only their top-level metadata can
    // mark one. Raw evidence is reserved for unreadable/ambiguous rows above.
    probe.possibleReset = false;
    return normalizeLegacyMuxMetadata(raw);
  } catch {
    return null;
  }
}

/** Use the provider reader's probe when rewrites join previously separated unreadable rows. */
export function hasUnreadableHistoryResetEvidence(rows: readonly Buffer[]): boolean {
  const probe: HistoryResetProbe = { resetProbe: "", resetStage: 0, possibleReset: false };
  for (let i = rows.length - 1; i >= 0; i--) {
    const raw = rows[i].at(-1) === 10 ? rows[i].subarray(0, -1) : rows[i];
    addHistoryResetProbe(probe, raw, true);
    if (raw.length <= SESSION_HISTORY_MAX_LINE_BYTES)
      classifyHistoryScanRow(raw.toString("utf8"), probe);
    if (probe.possibleReset) return true;
  }
  return false;
}

function historyFileStamp(
  stat: { dev: number; ino: number; size: number; mtimeMs: number; ctimeMs: number } | undefined
): string {
  return stat ? `${stat.dev}:${stat.ino}:${stat.size}:${stat.mtimeMs}:${stat.ctimeMs}` : "missing";
}

type ProviderHistoryStart =
  | { kind: "start"; offset: number }
  | { kind: "exhausted"; oldestBoundary: number | null; boundaryCount: number };

/** Provider-only location: bound row/probe carryover, not the amount of context scanned. */
async function findProviderHistoryStart(
  handle: fs.FileHandle,
  fileSize: number,
  skip: number,
  includeReadableResetFloor: boolean
): Promise<ProviderHistoryStart> {
  const probe: HistoryResetProbe = { resetProbe: "", resetStage: 0, possibleReset: false };
  let parts: Buffer[] = [];
  let size = 0;
  let rowEnd = fileSize;
  let unreadableRunEnd: number | null = null;
  let oldestBoundary: number | null = null;
  let boundaryCount = 0;
  const add = (bytes: Buffer) => {
    addHistoryResetProbe(probe, bytes, true);
    size += bytes.length;
    if (size <= SESSION_HISTORY_MAX_LINE_BYTES) parts.push(bytes);
    else parts = [];
  };
  const deliver = (start: number): number | null => {
    if (size === 0) {
      rowEnd = start;
      return null;
    }
    const message =
      size > SESSION_HISTORY_MAX_LINE_BYTES
        ? null
        : classifyHistoryScanRow(Buffer.concat(parts.reverse()).toString("utf8"), probe);
    if (message) unreadableRunEnd = null;
    else unreadableRunEnd ??= rowEnd;
    const durableBoundary = message !== null && isDurableContextBoundaryMarker(message);
    if (isManualHistoryReset(message, probe.possibleReset)) {
      // Retain readable reset markers, but never count them as skippable boundaries.
      // Deletion also needs readable malformed-role floors that provider requests exclude.
      if (durableBoundary || (includeReadableResetFloor && message)) return start;
      // A fragmented marker may end several rows to the right of the key that
      // completed recognition. Never return any of that unreadable evidence.
      return unreadableRunEnd ?? rowEnd;
    }
    if (durableBoundary) {
      oldestBoundary = start;
      if (boundaryCount++ === skip) return start;
    }
    if (message) {
      probe.resetProbe = "";
      probe.resetStage = 0;
      probe.possibleReset = false;
    }
    parts = [];
    size = 0;
    rowEnd = start;
    return null;
  };
  for (let end = fileSize; end > 0; ) {
    const start = Math.max(0, end - SESSION_HISTORY_SCAN_CHUNK_BYTES);
    const chunk = Buffer.alloc(end - start);
    const read = await handle.read(chunk, 0, chunk.length, start);
    if (read.bytesRead !== chunk.length) throw new Error("History changed during provider read");
    let edge = chunk.length;
    for (let i = chunk.length - 1; i >= 0; i--) {
      if (chunk[i] !== 10) continue;
      add(chunk.subarray(i + 1, edge));
      const offset = deliver(start + i + 1);
      if (offset !== null) return { kind: "start", offset };
      edge = i;
    }
    add(chunk.subarray(0, edge));
    end = start;
  }
  const offset = deliver(0);
  return offset === null
    ? { kind: "exhausted", oldestBoundary, boundaryCount }
    : { kind: "start", offset };
}

/** Keep raw location and projected tail reads on one verified snapshot, without write-lock re-entry. */
async function readHistoryProjectionFromLatestBoundary<Row>(
  paths: Record<HistoryArtifact, string>,
  skip: number,
  project: (value: unknown) => Row | null,
  includeReadableResetFloor = false,
  /** Start at the latest manual reset (or retained history start) instead of a durable boundary. */
  manualResetFloorOnly = false
): Promise<Row[]> {
  assert(Number.isSafeInteger(skip) && skip >= 0, "provider boundary skip must be non-negative");
  const files = new Map<HistoryArtifact, { handle: fs.FileHandle; size: number; stamp: string }>();
  try {
    for (const artifact of ["chat", "archive"] as const) {
      let handle: fs.FileHandle;
      try {
        handle = await fs.open(paths[artifact], "r");
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code === "ENOENT") continue;
        throw error;
      }
      // Register before stat so a failed snapshot still closes its descriptor.
      files.set(artifact, { handle, size: 0, stamp: "missing" });
      const stat = await handle.stat();
      files.set(artifact, { handle, size: stat.size, stamp: historyFileStamp(stat) });
    }
    const locate = (
      artifact: HistoryArtifact,
      skipCount: number
    ): Promise<ProviderHistoryStart> => {
      const file = files.get(artifact);
      return file
        ? findProviderHistoryStart(file.handle, file.size, skipCount, includeReadableResetFloor)
        : Promise.resolve({ kind: "exhausted", oldestBoundary: null, boundaryCount: 0 });
    };
    const readTail = async (artifact: HistoryArtifact, offset: number): Promise<Row[]> => {
      const file = files.get(artifact);
      if (!file) return [];
      assert(offset >= 0 && offset <= file.size, "provider start must be within its snapshot");
      const buffer = Buffer.alloc(file.size - offset);
      const read = await file.handle.read(buffer, 0, buffer.length, offset);
      if (read.bytesRead !== buffer.length) throw new Error("History changed during provider read");
      const messages: Row[] = [];
      for (const line of buffer.toString("utf8").split("\n")) {
        if (!line.trim()) continue;
        try {
          const row = project(JSON.parse(line) as unknown);
          if (row !== null) messages.push(row);
        } catch {
          // Project only usable rows; full/UI history keeps its existing reader.
        }
      }
      return messages;
    };
    const chat = await locate("chat", skip);
    let messages: Row[];
    if (chat.kind === "start") messages = await readTail("chat", chat.offset);
    else if (manualResetFloorOnly) {
      // Durable boundaries were never a stop (skip is unreachable); only a reset floor is.
      const archive = await locate("archive", skip);
      messages = [
        ...(await readTail("archive", archive.kind === "start" ? archive.offset : 0)),
        ...(await readTail("chat", 0)),
      ];
    } else {
      const archive = await locate("archive", skip - chat.boundaryCount);
      if (archive.kind === "start" || archive.oldestBoundary !== null) {
        messages = [
          ...(await readTail(
            "archive",
            archive.kind === "start" ? archive.offset : archive.oldestBoundary!
          )),
          ...(await readTail("chat", 0)),
        ];
      } else if (chat.oldestBoundary !== null)
        messages = await readTail("chat", chat.oldestBoundary);
      else messages = [...(await readTail("archive", 0)), ...(await readTail("chat", 0))];
    }
    // Foreign writers can replace either pathname while these descriptors stay
    // open. Never release provider rows assembled from an obsolete raw offset.
    for (const artifact of ["chat", "archive"] as const) {
      const stat = await fs.stat(paths[artifact]).catch((error: NodeJS.ErrnoException) => {
        if (error.code !== "ENOENT") throw error;
        return undefined;
      });
      if (historyFileStamp(stat) !== (files.get(artifact)?.stamp ?? "missing")) {
        throw new Error("History changed during provider read");
      }
    }
    return messages;
  } finally {
    await Promise.all([...files.values()].map((file) => file.handle.close()));
  }
}

export function readProviderHistoryFromLatestBoundary(
  paths: Record<HistoryArtifact, string>,
  skip: number,
  options?: {
    /** Mutation classification needs the excluded floor itself; provider requests leave this off. */
    includeReadableResetFloor?: boolean;
  }
): Promise<MuxMessage[]> {
  return readHistoryProjectionFromLatestBoundary(
    paths,
    skip,
    (value) => (isReadableHistoryMessage(value) ? normalizeLegacyMuxMetadata(value) : null),
    options?.includeReadableResetFloor
  );
}

/**
 * Task IDs spawned by `task` tool calls (top-level or PTC-nested) since the latest manual reset.
 * Reading a descendant's transcript is only allowed for children the caller's current privacy
 * segment created: an older child would otherwise leak the caller's discarded context.
 * This is a floor-bounded full read of the caller's own retained rows, not a paged scan.
 */
export function readSpawnedTaskIdsSinceManualReset(
  paths: Record<HistoryArtifact, string>
): Promise<Set<string>> {
  const collect = (value: unknown, into: Set<string>, depth: number): void => {
    if (depth > 30 || !value || typeof value !== "object") return;
    if (Array.isArray(value)) {
      for (const item of value) collect(item, into, depth + 1);
      return;
    }
    const record = value as Record<string, unknown>;
    if (typeof record.taskId === "string") into.add(record.taskId);
    if (Array.isArray(record.taskIds))
      for (const id of record.taskIds) if (typeof id === "string") into.add(id);
    for (const item of Object.values(record)) collect(item, into, depth + 1);
  };
  const spawnedBy = (record: Record<string, unknown>, into: Set<string>): void => {
    if (record.toolName === "task") collect(record.output, into, 0);
    if (Array.isArray(record.nestedCalls))
      for (const nested of record.nestedCalls) if (isPlainObject(nested)) spawnedBy(nested, into);
  };
  return readHistoryProjectionFromLatestBoundary(
    paths,
    Number.MAX_SAFE_INTEGER,
    (value) => {
      if (!isReadableHistoryMessage(value)) return null;
      const ids = new Set<string>();
      for (const part of value.parts) if (isPlainObject(part)) spawnedBy(part, ids);
      return ids.size > 0 ? ids : null;
    },
    false,
    true
  ).then((sets) => new Set(sets.flatMap((ids) => [...ids])));
}

/** Ordered lifecycle evidence, not a provider message or a source of repaired IDs. */
export interface HistoryControlRow {
  id?: unknown;
  role: "user" | "assistant" | "system";
  metadata?: Record<string, unknown>;
}

export function readHistoryControlEvidenceFromLatestBoundary(
  paths: Record<HistoryArtifact, string>,
  skip: number
): Promise<HistoryControlRow[]> {
  return readHistoryProjectionFromLatestBoundary(paths, skip, (row) => {
    if (!isPlainObject(row)) return null;
    if (row.role !== "user" && row.role !== "assistant" && row.role !== "system") return null;
    // Damaged metadata cannot hide recognized control input or establish synthetic status.
    return normalizeLegacyMuxMetadata<HistoryControlRow>({
      ...("id" in row ? { id: row.id } : {}),
      role: row.role,
      ...(isPlainObject(row.metadata) ? { metadata: row.metadata } : {}),
    });
  });
}

export interface BoundedHistoryRow {
  message: MuxMessage;
  /** Exact row, stable across certified EOF appends with an unchanged prefix, not rewrites/rotation. */
  itemId: string;
  windowId: string;
  windowBoundaryKind: HistoryScanState["windowBoundaryKind"];
  startsWindow: boolean;
}
export interface BoundedHistoryScanOptions {
  cursor?: HistoryScanState;
  /**
   * Visit rows newest-first. Attribution stays exact: each window span is
   * discovered backwards to its boundary row before any of its rows are
   * emitted, so no row is ever attributed to a window guessed from the tail.
   */
  recentFirst?: boolean;
  /** Return false to leave this row unconsumed for the next page. */
  visit: (row: BoundedHistoryRow) => boolean;
}
export interface BoundedHistoryScanResult {
  cursor?: HistoryScanState;
  bytesRead: number;
  rowsScanned: number;
  oversizedLines: number;
  malformedLines: number;
  privacyFloorReached: boolean;
}

/** One mutex-held page. Never invokes migration/recovery or a full-file reader. */
export async function scanHistoryFilesBounded(
  paths: Record<HistoryArtifact, string>,
  options: BoundedHistoryScanOptions,
  provenanceEpoch: string,
  maxBytes = SESSION_HISTORY_MAX_SCAN_BYTES
): Promise<BoundedHistoryScanResult> {
  const result: BoundedHistoryScanResult = {
    bytesRead: 0,
    rowsScanned: 0,
    oversizedLines: 0,
    malformedLines: 0,
    privacyFloorReached: false,
  };
  const boundedWindowId = (message: MuxMessage): string | null => {
    const id = getContextWindowId(message);
    if (isHistoryIdentifierRepresentable(id)) return id;
    result.malformedLines++;
    return null;
  };
  const handles = new Map<HistoryArtifact, fs.FileHandle>();
  try {
    for (const artifact of ["chat", "archive"] as const) {
      try {
        handles.set(artifact, await fs.open(paths[artifact], "r"));
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
      }
    }
    const initialStamps = new Map<HistoryArtifact, string>();
    for (const artifact of ["chat", "archive"] as const) {
      initialStamps.set(artifact, historyFileStamp(await handles.get(artifact)?.stat()));
    }
    const finish = async () => {
      // The mutex excludes local writers, not foreign backends. Never release
      // rows read through a handle that was rotated/reset while this page ran.
      for (const artifact of ["chat", "archive"] as const) {
        const current = await fs.stat(paths[artifact]).catch((error: NodeJS.ErrnoException) => {
          if (error.code !== "ENOENT") throw error;
          return undefined;
        });
        if (historyFileStamp(current) !== initialStamps.get(artifact))
          throw new Error("stale_cursor");
      }
      return result;
    };
    const read = async (artifact: HistoryArtifact, start: number, length: number) => {
      assert(length >= 0 && result.bytesRead + length <= maxBytes);
      const buffer = Buffer.alloc(length);
      const bytesRead = handles.has(artifact)
        ? (await handles.get(artifact)!.read(buffer, 0, length, start)).bytesRead
        : 0;
      result.bytesRead += bytesRead;
      return buffer.subarray(0, bytesRead);
    };
    const snapshot = async (
      artifact: HistoryArtifact,
      previous?: HistorySnapshot
    ): Promise<HistorySnapshot> => {
      const stat = await handles.get(artifact)?.stat();
      const size = stat?.size ?? 0;
      const end = previous?.endOffsetSnapshot ?? size;
      const inode = stat ? `${stat.dev}:${stat.ino}` : "missing";
      const modifiedTimeMs = stat?.mtimeMs ?? 0;
      if (
        previous &&
        artifact === "archive" &&
        size === end &&
        modifiedTimeMs !== previous.modifiedTimeMs
      )
        throw new Error("stale_cursor");
      // A validated same-epoch receipt certifies prefix-preserving atomic chat
      // appends even when rename changes its inode. Archive changes still expire.
      if (previous && (size < end || (artifact === "archive" && inode !== previous.inode)))
        throw new Error("stale_cursor");
      const hash = (bytes: Buffer) => createHash("sha256").update(bytes).digest("hex");
      const headHash = hash(await read(artifact, 0, Math.min(SESSION_HISTORY_ANCHOR_BYTES, end)));
      const anchorHash = hash(
        await read(
          artifact,
          Math.max(0, end - SESSION_HISTORY_ANCHOR_BYTES),
          Math.min(SESSION_HISTORY_ANCHOR_BYTES, end)
        )
      );
      if (previous && (headHash !== previous.headHash || anchorHash !== previous.anchorHash))
        throw new Error("stale_cursor");
      return { endOffsetSnapshot: end, inode, modifiedTimeMs, headHash, anchorHash };
    };
    const initialChat = options.cursor ? undefined : await snapshot("chat");
    const state: HistoryScanState = options.cursor
      ? structuredClone(options.cursor)
      : {
          provenanceEpoch,
          snapshots: { chat: initialChat!, archive: await snapshot("archive") },
          validatedChatSnapshot: initialChat!,
          phase: "floor",
          recentFirst: options.recentFirst === true,
          artifact: "chat",
          byteOffset: 0,
          skippingOversized: false,
          oversizedRowEnd: null,
          resetProbe: "",
          resetStage: 0,
          possibleReset: false,
          archiveWatermark: -1,
          anchorSequence: null,
          windowId: "w:0",
          windowBoundaryKind: null,
          windowPending: true,
          appendCheck: null,
          floor: null,
          probe: null,
          span: null,
        };
    if (state.provenanceEpoch !== provenanceEpoch) throw new Error("stale_cursor");
    // Direction is bound into the authenticated cursor; a mismatch is a forged or misused cursor.
    if (state.recentFirst !== (options.recentFirst === true)) throw new Error("invalid_cursor");
    if (!options.cursor) state.byteOffset = state.snapshots.chat.endOffsetSnapshot;
    else {
      await snapshot("chat", state.snapshots.chat);
      await snapshot("archive", state.snapshots.archive);
      await snapshot("chat", state.validatedChatSnapshot);
      // Rotation grows the archive and rewrites chat; even archive-only changes
      // invalidate the shared snapshot used by a resumed scan.
      if (
        (await handles.get("archive")?.stat())?.size !==
          state.snapshots.archive.endOffsetSnapshot &&
        handles.has("archive")
      )
        throw new Error("stale_cursor");
    }
    const remaining = () => maxBytes - result.bytesRead;
    interface Position {
      byteOffset: number;
      skippingOversized: boolean;
      oversizedRowEnd: number | null;
      resetProbe: string;
      resetStage: 0 | 1 | 2;
      possibleReset: boolean;
    }
    // Read chunks with at most one line of carryover. An incomplete ordinary
    // line can be retried (<1 MiB); oversized lines resume mid-line, never from
    // their original start, so a multi-megabyte row cannot monopolize every page.
    const scan = async (
      artifact: HistoryArtifact,
      position: Position,
      reverse: boolean,
      end: number,
      lower: number,
      visit: (
        message: MuxMessage | null,
        start: number,
        finish: number,
        oversized: boolean,
        possibleReset: boolean,
        raw: Buffer | null
      ) => boolean
    ) => {
      let cursor = position.byteOffset;
      let rowEdge = cursor;
      let parts: Buffer[] = [];
      let size = 0;
      let skipping = position.skippingOversized;
      const probe: HistoryResetProbe = {
        resetProbe: position.resetProbe,
        resetStage: position.resetStage,
        possibleReset: position.possibleReset,
      };
      const deliver = (edge: number): boolean => {
        const start = reverse ? edge : rowEdge;
        const finish = reverse ? (position.oversizedRowEnd ?? rowEdge) : edge;
        if (size === 0 && !skipping) {
          rowEdge = edge;
          position.byteOffset = edge;
          return true;
        }
        result.rowsScanned++;
        let message: MuxMessage | null = null;
        let raw: Buffer | null = null;
        if (skipping) result.oversizedLines++;
        else {
          raw = Buffer.concat(reverse ? parts.reverse() : parts);
          message = classifyHistoryScanRow(raw.toString("utf8"), probe);
          if (!message) result.malformedLines++;
        }
        if (!visit(message, start, finish, skipping, probe.possibleReset, raw)) return false;
        parts = [];
        size = 0;
        skipping = false;
        if (message) {
          probe.resetProbe = "";
          probe.resetStage = 0;
          probe.possibleReset = false;
        }
        position.resetProbe = probe.resetProbe;
        position.resetStage = probe.resetStage;
        position.possibleReset = probe.possibleReset;
        rowEdge = edge;
        position.byteOffset = edge;
        position.skippingOversized = false;
        position.oversizedRowEnd = null;
        return true;
      };
      while (
        (reverse ? cursor > lower : cursor < end) &&
        remaining() > 0 &&
        result.rowsScanned < SESSION_HISTORY_MAX_SCAN_ROWS
      ) {
        const length = Math.min(
          SESSION_HISTORY_SCAN_CHUNK_BYTES,
          remaining(),
          reverse ? cursor - lower : end - cursor
        );
        const start = reverse ? cursor - length : cursor;
        const chunk = await read(artifact, start, length);
        if (chunk.length !== length) throw new Error("stale_cursor");
        let segmentEdge = reverse ? chunk.length : 0;
        const add = (segment: Buffer) => {
          addHistoryResetProbe(probe, segment, reverse);
          size += segment.length;
          if (size > SESSION_HISTORY_MAX_LINE_BYTES) {
            position.oversizedRowEnd ??= rowEdge;
            skipping = true;
            parts = [];
          } else if (!skipping) parts.push(segment);
        };
        for (
          let i = reverse ? chunk.length - 1 : 0;
          reverse ? i >= 0 : i < chunk.length;
          reverse ? i-- : i++
        ) {
          if (chunk[i] !== 10) continue;
          add(reverse ? chunk.subarray(i + 1, segmentEdge) : chunk.subarray(segmentEdge, i));
          const edge = start + i + 1;
          if (!deliver(edge)) return false;
          segmentEdge = reverse ? i : i + 1;
          if (result.rowsScanned >= SESSION_HISTORY_MAX_SCAN_ROWS) return false;
        }
        add(reverse ? chunk.subarray(0, segmentEdge) : chunk.subarray(segmentEdge));
        cursor = reverse ? start : start + length;
      }
      if (reverse ? cursor === lower : cursor === end) {
        if (!deliver(cursor)) return false;
        position.byteOffset = cursor;
        position.skippingOversized = false;
        position.oversizedRowEnd = null;
        return true;
      }
      // Rewinding an ordinary partial row also restores its start-of-row probe;
      // only oversized rows persist mid-line state. Carryover stays bounded.
      position.byteOffset = skipping ? cursor : rowEdge;
      position.skippingOversized = skipping;
      if (skipping) {
        position.resetProbe = probe.resetProbe;
        position.resetStage = probe.resetStage;
        position.possibleReset = probe.possibleReset;
      }
      return false;
    };

    // New tool-result appends do not expire a cursor. Before disclosing old rows,
    // scan all appended bytes for a new privacy floor, within this SAME budget.
    if (options.cursor) {
      const chatSize = (await handles.get("chat")?.stat())?.size ?? 0;
      if (!state.appendCheck && chatSize > state.validatedChatSnapshot.endOffsetSnapshot) {
        state.appendCheck = {
          snapshot: await snapshot("chat"),
          byteOffset: chatSize,
          skippingOversized: false,
          oversizedRowEnd: null,
          resetProbe: "",
          resetStage: 0,
          possibleReset: false,
        };
      }
      if (state.appendCheck) {
        const check = state.appendCheck;
        await snapshot("chat", check.snapshot);
        let reachedValidatedRow = false;
        const completed = await scan(
          "chat",
          check,
          true,
          check.snapshot.endOffsetSnapshot,
          0,
          (message, _start, finish, _oversized, possibleReset) => {
            // A new append can finish the prior snapshot's malformed tail.
            // Continue through that tail, stopping at the first valid old row.
            if (message && finish <= state.validatedChatSnapshot.endOffsetSnapshot) {
              reachedValidatedRow = true;
              return false;
            }
            if (isManualHistoryReset(message, possibleReset)) throw new Error("stale_cursor");
            return true;
          }
        );
        if (!completed && !reachedValidatedRow) {
          result.cursor = state;
          return await finish();
        }
        // Keep the retrieval snapshot fixed even when our own result is appended.
        state.validatedChatSnapshot = check.snapshot;
        state.appendCheck = null;
        if (chatSize > state.validatedChatSnapshot.endOffsetSnapshot) {
          result.cursor = state;
          return await finish();
        }
      }
    }
    const freshPosition = () => ({
      skippingOversized: false,
      oversizedRowEnd: null,
      resetProbe: "",
      resetStage: 0 as const,
      possibleReset: false,
    });
    // Browsing starts where the floor phase stopped: at the reset row's end, or at
    // the archive head when no reset exists. Newest-first remembers that floor and
    // walks back from the tail instead.
    const enterBrowse = () => {
      if (!state.recentFirst) {
        state.phase = "browse";
        return;
      }
      state.floor = {
        artifact: state.artifact,
        byteOffset: state.byteOffset,
        windowId: state.windowId,
        windowBoundaryKind: state.windowBoundaryKind,
      };
      state.phase = "probe";
      state.artifact = "chat";
      state.byteOffset = state.snapshots.chat.endOffsetSnapshot;
      Object.assign(state, freshPosition());
      state.probe = {
        artifact: "chat",
        byteOffset: state.byteOffset,
        ...freshPosition(),
        lowestReadable: null,
      };
    };
    // Reverse discovery: walk back from the pending span end to the nearest
    // boundary row (or the floor), retaining only locations. Returns false when
    // the page budget ran out.
    const probePage = async (): Promise<boolean> => {
      const probe = state.probe!;
      const floor = state.floor!;
      assert(probe && floor, "newest-first probe requires floor and probe state");
      const lower = probe.artifact === floor.artifact ? floor.byteOffset : 0;
      let boundary:
        | { start: number; windowId: string | null; kind: HistoryScanState["windowBoundaryKind"] }
        | undefined;
      const completed = await scan(
        probe.artifact,
        probe,
        true,
        state.snapshots[probe.artifact].endOffsetSnapshot,
        lower,
        (message, start) => {
          if (!message) return true;
          const kind = getContextBoundaryKind(message);
          if (kind) {
            boundary = { start, windowId: boundedWindowId(message), kind };
            return false;
          }
          probe.lowestReadable = { artifact: probe.artifact, byteOffset: start };
          return true;
        }
      );
      if (boundary) {
        const start = { artifact: probe.artifact, byteOffset: boundary.start };
        state.span = {
          start,
          windowId: boundary.windowId,
          windowBoundaryKind: boundary.kind,
          startsWindow: start,
        };
      } else if (!completed) return false;
      else if (probe.artifact === "chat" && floor.artifact === "archive") {
        Object.assign(probe, freshPosition(), {
          artifact: "archive",
          byteOffset: state.snapshots.archive.endOffsetSnapshot,
        });
        return true;
      } else {
        // The oldest visible span has no boundary row of its own; like the forward
        // walk, its first readable row is the one that starts the window.
        state.span = {
          start: { artifact: floor.artifact, byteOffset: floor.byteOffset },
          windowId: floor.windowId,
          windowBoundaryKind: floor.windowBoundaryKind,
          startsWindow: probe.lowestReadable,
        };
      }
      state.probe = null;
      state.phase = "deliver";
      return true;
    };
    // Reverse delivery of one discovered span, from its end (state position) down
    // to its boundary row, crossing the chat -> archive seam when the span does.
    const deliverPage = async (): Promise<boolean> => {
      const span = state.span!;
      const floor = state.floor!;
      assert(span && floor, "newest-first delivery requires span and floor state");
      const artifact = state.artifact;
      const lower = artifact === span.start.artifact ? span.start.byteOffset : 0;
      const completed = await scan(
        artifact,
        state,
        true,
        state.snapshots[artifact].endOffsetSnapshot,
        lower,
        (message, start, _finish, _oversized, _possibleReset, raw) => {
          if (!message) return true;
          assert(raw, "readable browse rows retain their bounded raw bytes");
          // Unaddressable windows are consumed silently, as in the forward walk.
          if (span.windowId === null) return true;
          return options.visit({
            message,
            itemId: `r:${state.provenanceEpoch}:${artifact}:${start}:${createHash("sha256").update(raw).digest("hex")}`,
            windowId: span.windowId,
            windowBoundaryKind: span.windowBoundaryKind,
            startsWindow:
              span.startsWindow !== null &&
              span.startsWindow.artifact === artifact &&
              span.startsWindow.byteOffset === start,
          });
        }
      );
      if (!completed) return false;
      if (artifact === "chat" && span.start.artifact === "archive") {
        Object.assign(state, freshPosition(), {
          artifact: "archive",
          byteOffset: state.snapshots.archive.endOffsetSnapshot,
        });
        return true;
      }
      assert(
        state.artifact === span.start.artifact && state.byteOffset === span.start.byteOffset,
        "reverse delivery must stop exactly at the span start"
      );
      state.span = null;
      if (span.start.artifact === floor.artifact && span.start.byteOffset === floor.byteOffset) {
        state.phase = "done";
        return true;
      }
      state.probe = {
        artifact: state.artifact,
        byteOffset: state.byteOffset,
        ...freshPosition(),
        lowestReadable: null,
      };
      state.phase = "probe";
      return true;
    };
    while (
      state.phase !== "done" &&
      remaining() > 0 &&
      result.rowsScanned < SESSION_HISTORY_MAX_SCAN_ROWS
    ) {
      if (state.phase === "probe") {
        if (!(await probePage())) break;
        continue;
      }
      if (state.phase === "deliver") {
        if (!(await deliverPage())) break;
        continue;
      }
      const artifact = state.artifact;
      const reverse = state.phase === "floor";
      const end = state.snapshots[artifact].endOffsetSnapshot;
      let floor:
        | {
            offset: number;
            windowId: string | null;
            windowBoundaryKind: HistoryScanState["windowBoundaryKind"];
          }
        | undefined;
      const completed = await scan(
        artifact,
        state,
        reverse,
        end,
        0,
        (message, start, finish, _oversized, possibleReset, raw) => {
          if (reverse) {
            // Keep the legacy cursor field, but sequence coverage is not replay proof.
            const sequence = message?.metadata?.historySequence;
            if (artifact === "archive" && Number.isSafeInteger(sequence))
              state.archiveWatermark = Math.max(state.archiveWatermark, sequence!);
            if (isManualHistoryReset(message, possibleReset)) {
              // Corrupt reset rows are privacy floors even when they parse or
              // carry a partial rollover tag. Only a validated rollover is exempt.
              floor = {
                offset: finish,
                windowId: message ? boundedWindowId(message) : "w:0",
                windowBoundaryKind: getContextBoundaryKind(message ?? undefined),
              };
              return false;
            }
            return true;
          }
          if (!message) return true;
          assert(raw, "readable browse rows retain their bounded raw bytes");
          const sequence = message.metadata?.historySequence;
          const anchorSequence =
            Number.isSafeInteger(sequence) && sequence! >= 0 ? sequence! : null;
          // Repaired/imported rows may reuse archived sequences with different
          // identities or payloads. Retain possible replays without exact proof.
          const boundaryKind = getContextBoundaryKind(message);
          const windowId = boundaryKind ? boundedWindowId(message) : state.windowId;
          const windowBoundaryKind = boundaryKind ?? state.windowBoundaryKind;
          // Consume unaddressable windows without persisting oversized IDs in
          // cursors or silently assigning their rows to a different window.
          if (
            windowId !== null &&
            !options.visit({
              message,
              itemId: `r:${state.provenanceEpoch}:${artifact}:${start}:${createHash("sha256").update(raw).digest("hex")}`,
              windowId,
              windowBoundaryKind,
              startsWindow: state.windowPending || boundaryKind !== null,
            })
          )
            return false;
          state.windowId = windowId;
          state.windowBoundaryKind = windowBoundaryKind;
          state.windowPending = false;
          state.anchorSequence = anchorSequence;
          return true;
        }
      );
      if (floor) {
        result.privacyFloorReached = true;
        state.byteOffset = floor.offset;
        state.windowId = floor.windowId;
        // Browsing excludes the reset row itself; preserve its verified kind
        // alongside its ID even when the first visible row is on another page.
        state.windowBoundaryKind = floor.windowBoundaryKind;
        state.windowPending = true;
        Object.assign(state, freshPosition());
        enterBrowse();
      } else if (!completed) break;
      else if (reverse && artifact === "chat") {
        state.artifact = "archive";
        state.byteOffset = state.snapshots.archive.endOffsetSnapshot;
      } else if (reverse) {
        state.byteOffset = 0;
        state.resetProbe = "";
        state.resetStage = 0;
        state.possibleReset = false;
        enterBrowse();
      } else if (artifact === "archive") {
        state.artifact = "chat";
        state.byteOffset = 0;
      } else state.phase = "done";
    }
    if (state.phase !== "done") result.cursor = state;
    return await finish();
  } finally {
    await Promise.all([...handles.values()].map((handle) => handle.close()));
  }
}

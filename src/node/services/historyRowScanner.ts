import { createHash, type Hash } from "node:crypto";
import * as fs from "node:fs/promises";
import { finished } from "node:stream/promises";
import { parser, type Token } from "stream-json/parser.js";
import { SESSION_HISTORY_SCAN_CHUNK_BYTES } from "@/common/constants/contextBudget";

export type HistoryRowToken = Readonly<Token>;

export interface HistoryRowDescriptor {
  /** Half-open raw byte range, including the delimiter when present. */
  start: number;
  end: number;
  /** Raw bytes and their SHA-256 exclude only the optional final LF. */
  byteLength: number;
  sha256: string;
  terminatedByLf: boolean;
  validUtf8: boolean;
  /** Completion under the selected decoder; replacement decoding does not validate raw JSON. */
  decodedJsonComplete: boolean;
  validJson: boolean;
  hasDuplicateKeys: boolean;
}

export interface HistoryRowVisitor {
  /** Tokens are provisional until finish confirms a complete, valid row. False stops the scan. */
  token(token: HistoryRowToken): boolean | void;
  /** Isolated bounded bytes excluding LF; visitors must bound any retained copies. */
  raw?(bytes: Uint8Array, absoluteOffset: number): boolean | void;
  /** Completion is awaited before another row or file read begins. */
  finish(row: HistoryRowDescriptor): boolean | void | Promise<boolean | void>;
}

/**
 * Raw JSONL framing only: no message/schema projection or authority is inferred here.
 * Scalar strings, keys and numbers are never assembled. Memory is bounded by the read
 * chunk plus parser depth and per-object key fingerprints, not strictly constant for
 * arbitrarily deep/wide JSON. Visitors must keep their own accumulation bounded too.
 * A caller using descriptors as evidence must revalidate file stamps against concurrent writes.
 */
export async function scanHistoryRows(
  filePath: string,
  beginRow: (start: number) => HistoryRowVisitor,
  options: { signal?: AbortSignal; decoding?: "strict" | "replacement" } = {}
): Promise<boolean> {
  const { signal, decoding = "strict" } = options;
  signal?.throwIfAborted();
  try {
    await using handle = await fs.open(filePath, "r");
    signal?.throwIfAborted();
    const { size } = await handle.stat();
    signal?.throwIfAborted();
    return await scanHistoryRowsFromHandle(handle, size, beginRow, { signal, decoding });
  } finally {
    // Resource disposal is asynchronous too; cancellation during cleanup must remain observable.
    signal?.throwIfAborted();
  }
}

/**
 * Scan a borrowed handle through its captured size, so callers can inspect the same
 * inode for additional evidence. The caller owns the handle and its disposal.
 */
export async function scanHistoryRowsFromHandle(
  handle: fs.FileHandle,
  size: number,
  beginRow: (start: number) => HistoryRowVisitor,
  options: { signal?: AbortSignal; decoding?: "strict" | "replacement" } = {}
): Promise<boolean> {
  const { signal, decoding = "strict" } = options;
  signal?.throwIfAborted();
  try {
    const buffer = Buffer.alloc(SESSION_HISTORY_SCAN_CHUNK_BYTES);
    let position = 0;
    let row: ReturnType<typeof createRow> | undefined;
    try {
      while (position < size) {
        signal?.throwIfAborted();
        const { bytesRead } = await handle.read(
          buffer,
          0,
          Math.min(buffer.length, size - position),
          position
        );
        if (bytesRead === 0) throw new Error("History ended before its captured size");
        signal?.throwIfAborted();
        let offset = 0;
        while (offset < bytesRead) {
          signal?.throwIfAborted();
          row ??= createRow(position + offset, beginRow(position + offset), decoding, signal);
          const newline = buffer.subarray(0, bytesRead).indexOf(10, offset);
          const end = newline === -1 ? bytesRead : newline;
          const keepGoing = await row.push(buffer.subarray(offset, end));
          signal?.throwIfAborted();
          if (!keepGoing) return false;
          if (newline !== -1) {
            if (!(await row.finish(position + newline + 1, true))) return false;
            await row.close();
            row = undefined;
          }
          offset = end + (newline === -1 ? 0 : 1);
        }
        position += bytesRead;
      }
      if (row && !(await row.finish(position, false))) return false;
      return true;
    } finally {
      await row?.close();
    }
  } finally {
    // Parser disposal is awaited too; observe cancellation before returning to the owner.
    signal?.throwIfAborted();
  }
}

function createRow(
  start: number,
  visitor: HistoryRowVisitor,
  decoding: "strict" | "replacement",
  signal?: AbortSignal
) {
  // Ignore BOM handling so a BOM is passed to the strict JSON parser, never silently erased.
  const decoder = new TextDecoder("utf-8", { fatal: decoding === "strict", ignoreBOM: true });
  const utf8Probe =
    decoding === "replacement"
      ? new TextDecoder("utf-8", { fatal: true, ignoreBOM: true })
      : undefined;
  const rawHash = createHash("sha256");
  let byteLength = 0;
  let validUtf8 = true;
  let decodedJsonComplete = true;
  let hasDuplicateKeys = false;
  let stopped = false;
  let visitorFailed = false;
  let visitorError: unknown;
  const objects: Array<Set<string> | null> = [];
  let keyHash: Hash | undefined;
  const stream = parser.asStream({ packValues: false, streamValues: true });
  // Observe errors immediately, including failures before the next awaited write/end.
  const completed = finished(stream, { cleanup: true }).catch(() => {
    decodedJsonComplete = false;
  });
  stream.on("data", (token: Token) => {
    if (stopped || visitorFailed || signal?.aborted) return;
    switch (token.name) {
      case "startObject":
        objects.push(new Set());
        break;
      case "startArray":
        objects.push(null);
        break;
      case "endObject":
      case "endArray":
        objects.pop();
        break;
      case "startKey":
        keyHash = createHash("sha256");
        break;
      case "stringChunk":
        // UTF-16 code units make escaped/raw keys and split surrogate pairs equivalent,
        // while keeping distinct lone surrogates distinct (UTF-8 replacement would not).
        keyHash?.update(Buffer.from(token.value, "utf16le"));
        break;
      case "endKey": {
        const key = keyHash!.digest("hex");
        keyHash = undefined;
        const keys = objects.at(-1)!;
        if (keys.has(key)) hasDuplicateKeys = true;
        keys.add(key);
        break;
      }
      default:
        break;
    }
    try {
      if (visitor.token(token) === false) {
        stopped = true;
        stream.destroy();
      }
    } catch (error) {
      visitorFailed = true;
      visitorError = error;
      stream.destroy();
    }
  });
  const abort = () => stream.destroy();
  signal?.addEventListener("abort", abort, { once: true });
  const check = () => {
    signal?.throwIfAborted();
    if (visitorFailed) throw visitorError;
    return !stopped;
  };
  const write = async (text: string) => {
    if (!decodedJsonComplete || !text) return;
    await new Promise<void>((resolve) => {
      stream.write(text, (error) => {
        if (error) decodedJsonComplete = false;
        resolve();
      });
    });
  };
  const decode = (bytes?: Uint8Array, streaming = false): string | undefined => {
    if (utf8Probe && validUtf8) {
      try {
        utf8Probe.decode(bytes, { stream: streaming });
      } catch {
        validUtf8 = false;
      }
    }
    if (!validUtf8 && decoding === "strict") return;
    try {
      return decoder.decode(bytes, { stream: streaming });
    } catch {
      validUtf8 = false;
      decodedJsonComplete = false;
      stream.destroy();
      return;
    }
  };
  return {
    async push(bytes: Buffer) {
      if (!check()) return false;
      const absoluteOffset = start + byteLength;
      rawHash.update(bytes);
      byteLength += bytes.length;
      if (bytes.length && visitor.raw?.(Uint8Array.from(bytes), absoluteOffset) === false)
        return false;
      if (!check()) return false;
      const text = decode(bytes, true);
      if (text !== undefined) await write(text);
      return check();
    },
    async finish(end: number, terminatedByLf: boolean) {
      if (!check()) return false;
      const text = decode();
      if (text !== undefined) await write(text);
      if (!stream.destroyed) stream.end();
      await completed;
      if (!check()) return false;
      const result = await visitor.finish({
        start,
        end,
        byteLength,
        sha256: rawHash.digest("hex"),
        terminatedByLf,
        validUtf8,
        decodedJsonComplete,
        validJson: validUtf8 && decodedJsonComplete,
        hasDuplicateKeys,
      });
      return check() && result !== false;
    },
    async close() {
      signal?.removeEventListener("abort", abort);
      stream.destroy();
      await completed;
    },
  };
}

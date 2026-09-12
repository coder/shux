import * as fs from "node:fs/promises";
import { createHash } from "node:crypto";
import {
  SESSION_HISTORY_MAX_LINE_BYTES,
  SESSION_HISTORY_SCAN_CHUNK_BYTES,
} from "@/common/constants/contextBudget";
import { isNonNegativeInteger } from "@/common/utils/numbers";
import { normalizeLegacyMuxMetadata } from "@/node/utils/messages/legacy";
import { scanHistoryRowsFromHandle, type HistoryRowDescriptor } from "./historyRowScanner";
import { createHistoryMessageEvidence } from "./historyMessageEvidence";
import {
  createHistoryCanonicalEvidence,
  createHistoryStringEvidence,
} from "./historyScalarEvidence";
import {
  createRawHistoryResetProbe,
  createUnreadableHistoryResetProbe,
  hasRawResetMarker,
  hasAmbiguousResetKeys,
  isReadableHistoryMessage,
} from "./historyScanner";

export interface HistoryReplacementRow {
  file: string;
  row: HistoryRowDescriptor;
  identity?: {
    id: ReturnType<ReturnType<typeof createHistoryStringEvidence>["finish"]>;
    sequence: number | undefined;
  };
  matchesNonce: boolean;
  replacementCandidate: boolean;
  protectedReset: boolean;
}
export interface HistoryReplacementRowOptions {
  signal?: AbortSignal;
  id?: string;
  nonce?: string;
}

/** Provisional evidence only: the caller must revalidate file stamps under its publication lock. */
export async function scanHistoryReplacementRows(
  file: string,
  visit: (row: HistoryReplacementRow) => boolean | void | Promise<boolean | void>,
  options: HistoryReplacementRowOptions = {}
): Promise<boolean> {
  const targets = { ...options };
  targets.signal?.throwIfAborted();
  try {
    let opened: fs.FileHandle;
    try {
      opened = await fs.open(file, "r");
    } catch (error) {
      targets.signal?.throwIfAborted();
      if ((error as NodeJS.ErrnoException).code === "ENOENT") return true;
      throw error;
    }
    await using handle = opened;
    targets.signal?.throwIfAborted();
    // The captured file size is a safe upper bound for the numeric token reducer.
    const { size } = await handle.stat();
    targets.signal?.throwIfAborted();
    return await scanHistoryRowsFromHandle(
      handle,
      size,
      () => {
        let chunks: Buffer[] | undefined = [];
        let length = 0;
        const projected = createHistoryMessageEvidence(size, targets);
        const canonical = createHistoryCanonicalEvidence(size);
        const rawReset = createRawHistoryResetProbe();
        return {
          raw(bytes) {
            length += bytes.length;
            if (length > SESSION_HISTORY_MAX_LINE_BYTES) chunks = undefined;
            else chunks!.push(Buffer.from(bytes));
            rawReset.push(bytes);
          },
          token(token) {
            projected.token(token);
            canonical.token(token);
          },
          async finish(row) {
            targets.signal?.throwIfAborted();
            let identity: HistoryReplacementRow["identity"];
            let matchesNonce = false;
            let candidate = false;
            let systemRole = false;
            let protectedReset = false;
            if (chunks) {
              const content = Buffer.concat(chunks);
              const text = content.toString("utf8");
              try {
                const value: unknown = JSON.parse(text);
                if (isReadableHistoryMessage(value)) {
                  const message = normalizeLegacyMuxMetadata(value);
                  const id = createHistoryStringEvidence(0, targets.id);
                  id.push(message.id);
                  identity = {
                    id: id.finish(),
                    sequence:
                      typeof message.metadata?.historySequence === "number"
                        ? message.metadata.historySequence
                        : undefined,
                  };
                  matchesNonce =
                    targets.nonce !== undefined &&
                    !!message.metadata &&
                    "compactionReplacementNonce" in message.metadata &&
                    message.metadata.compactionReplacementNonce === targets.nonce;
                  // Match the readable-history predicate, including legacy array-coerced roles.
                  systemRole = String(message.role) === "system";
                  protectedReset = hasRawResetMarker(text) && hasAmbiguousResetKeys(text);
                  candidate =
                    content.equals(Buffer.from(JSON.stringify(message))) ||
                    (row.validUtf8 && !hasAmbiguousResetKeys(text));
                }
              } catch {
                /* The existing reader filters malformed rows, including invalid legacy coercions. */
              }
            } else {
              const facts = projected.finish(row);
              candidate = canonical.finish(row, facts.normalizationChanged);
              if (facts.readable && facts.id) {
                identity = {
                  id: facts.id,
                  sequence: typeof facts.sequence === "number" ? facts.sequence : undefined,
                };
                matchesNonce = facts.matchesNonce;
                systemRole = facts.systemRole;
                protectedReset =
                  rawReset.finish() || (await hasReverseReset(handle, row, targets.signal));
              }
            }
            candidate &&=
              !!identity &&
              identity.id.length > 0 &&
              isNonNegativeInteger(identity.sequence) &&
              !systemRole &&
              !protectedReset;
            const result = await visit({
              file,
              row,
              identity,
              matchesNonce,
              protectedReset,
              replacementCandidate: candidate,
            });
            targets.signal?.throwIfAborted();
            return result;
          },
        };
      },
      { signal: targets.signal, decoding: "replacement" }
    );
  } finally {
    // Disposal awaits too; observe cancellation after releasing the outer range handle.
    targets.signal?.throwIfAborted();
  }
}

async function readExact(
  handle: fs.FileHandle,
  position: number,
  buffer: Buffer,
  length: number,
  signal?: AbortSignal
) {
  let read = 0;
  while (read < length) {
    signal?.throwIfAborted();
    const { bytesRead } = await handle.read(buffer, read, length - read, position + read);
    signal?.throwIfAborted();
    if (!bytesRead) throw new Error("History row changed before its captured range ended");
    read += bytesRead;
  }
}
async function hasReverseReset(
  handle: fs.FileHandle,
  row: HistoryRowDescriptor,
  signal?: AbortSignal
) {
  const probe = createUnreadableHistoryResetProbe();
  const buffer = Buffer.alloc(SESSION_HISTORY_SCAN_CHUNK_BYTES);
  let remaining = row.byteLength;
  while (remaining > 0 && !probe.hasReset()) {
    const length = Math.min(buffer.length, remaining);
    remaining -= length;
    await readExact(handle, row.start + remaining, buffer, length, signal);
    probe.push(buffer.subarray(0, length));
  }
  return probe.hasReset();
}

/** Digest mismatch can reject a replay; matching digests never replace exact byte comparison. */
export async function equalHistoryReplacementRows(
  left: HistoryReplacementRow,
  right: HistoryReplacementRow,
  signal?: AbortSignal
): Promise<boolean> {
  const a = { file: left.file, ...left.row };
  const b = { file: right.file, ...right.row };
  signal?.throwIfAborted();
  try {
    if (a.byteLength !== b.byteLength || a.sha256 !== b.sha256) return false;
    await using aHandle = await fs.open(a.file, "r");
    signal?.throwIfAborted();
    await using bHandle = await fs.open(b.file, "r");
    signal?.throwIfAborted();
    const aBytes = Buffer.alloc(SESSION_HISTORY_SCAN_CHUNK_BYTES);
    const bBytes = Buffer.alloc(SESSION_HISTORY_SCAN_CHUNK_BYTES);
    const hash = createHash("sha256");
    for (let offset = 0; offset < a.byteLength; offset += aBytes.length) {
      const length = Math.min(aBytes.length, a.byteLength - offset);
      await readExact(aHandle, a.start + offset, aBytes, length, signal);
      await readExact(bHandle, b.start + offset, bBytes, length, signal);
      if (!aBytes.subarray(0, length).equals(bBytes.subarray(0, length))) return false;
      hash.update(aBytes.subarray(0, length));
    }
    return hash.digest("hex") === a.sha256;
  } finally {
    signal?.throwIfAborted();
  }
}

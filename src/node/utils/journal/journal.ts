/**
 * Journal kit: append-only JSONL journal with monotonic sequence assignment,
 * stable-ID dedupe, and self-healing reads (substrate 2 of the shared agent
 * foundation).
 *
 * Doctrine (matches HistoryService/TimelineService): one malformed or
 * duplicated line must never brick the log. Appends are single-write JSONL
 * lines; torn tails from crashes are healed by prepending a separator on the
 * next append and by skipping unparseable lines on read.
 *
 * Writer serialization is two-level:
 * - within one instance, appends run through an internal promise queue;
 * - across instances AND processes (the debug CLI appending while the app is
 *   live), each append holds a cross-process lockfile while it derives the
 *   next sequence and writes, revalidating the cached counter against the
 *   file size so a foreign append can never lead to a duplicated seq.
 */

import assert from "node:assert";
import * as fs from "fs/promises";
import * as path from "path";
import { acquireProcessFileLock } from "@/node/utils/concurrency/fileLock";
import { log } from "@/node/services/log";

/** Default bound on waiting for the append lock (see JournalOptions). */
const APPEND_LOCK_TIMEOUT_MS = 5_000;

/** Minimal schema contract (zod-compatible) so the kit stays dependency-light. */
export interface JournalRowSchema<T> {
  safeParse(value: unknown): { success: true; data: T } | { success: false; error?: unknown };
}

export interface JournalOptions<T> {
  filePath: string;
  schema: JournalRowSchema<T>;
  /** Extract the monotonic sequence from a row. */
  getSeq: (row: T) => number;
  /** Extract the stable unique id from a row (dedupe key on read). */
  getId: (row: T) => string;
  /**
   * Max milliseconds to wait for the cross-process append lock before the
   * append fails. Appends normally hold the lock for well under a
   * millisecond, so hitting this means another process is wedged mid-append;
   * failing (callers already tolerate append failures per the self-healing
   * doctrine) beats writing an unserialized — possibly seq-colliding — row.
   */
  appendLockTimeoutMs?: number;
  /**
   * Fires synchronously right after a row is durably appended, inside the
   * append's exclusive section, with the file sizes observed before and
   * after the write. `preAppendFileSize` differing from the previous
   * `postAppendFileSize` tells the consumer a FOREIGN writer (another
   * instance or process) appended in between — used by DurableEventJournal
   * to keep its blob-mention index verifiably fresh.
   */
  onAppended?: (row: T, sizes: { preAppendFileSize: number; postAppendFileSize: number }) => void;
  /**
   * Test seam: awaited between sequence derivation and the pre-write
   * ownership assertion — the only way to deterministically interleave a
   * competing writer into an in-flight append (see the displaced-appender
   * test).
   */
  testOnlyBeforeAppendWrite?: () => Promise<void>;
}

export class Journal<T> {
  private readonly filePath: string;
  private readonly lockPath: string;
  private readonly schema: JournalRowSchema<T>;
  private readonly getSeq: (row: T) => number;
  private readonly getId: (row: T) => string;
  private readonly appendLockTimeoutMs: number;
  private readonly onAppended?: JournalOptions<T>["onAppended"];
  private readonly testOnlyBeforeAppendWrite?: () => Promise<void>;
  /** Next sequence to assign; null until the file has been scanned once. */
  private nextSeq: number | null = null;
  /**
   * File size in bytes right after OUR last locked append; null until then.
   * A different size at the next append means another instance or process
   * appended in between, so the cached nextSeq must be re-derived.
   */
  private lastKnownSize: number | null = null;

  /** Serializes appends so seq assignment and tail-healing are race-free. */
  private writeQueue: Promise<unknown> = Promise.resolve();

  constructor(options: JournalOptions<T>) {
    assert(options.filePath.length > 0, "Journal requires a file path");
    this.filePath = options.filePath;
    this.lockPath = `${options.filePath}.lock`;
    this.schema = options.schema;
    this.getSeq = options.getSeq;
    this.getId = options.getId;
    this.appendLockTimeoutMs = options.appendLockTimeoutMs ?? APPEND_LOCK_TIMEOUT_MS;
    assert(this.appendLockTimeoutMs > 0, "Journal appendLockTimeoutMs must be positive");
    this.onAppended = options.onAppended;
    this.testOnlyBeforeAppendWrite = options.testOnlyBeforeAppendWrite;
  }

  /**
   * Append one row built from the next monotonic sequence number. The build
   * result is validated against the schema before hitting disk (crash-fast on
   * programmer error rather than persisting garbage).
   */
  async append(build: (seq: number) => T): Promise<T> {
    const task = this.writeQueue.then(async () => {
      await fs.mkdir(path.dirname(this.filePath), { recursive: true });
      // Cross-process serialization: seq derivation and the write must be one
      // exclusive unit, or a concurrent writer in another process (debug CLI
      // vs live backend) could assign the same sequence number.
      await using lock = await acquireProcessFileLock({
        lockPath: this.lockPath,
        timeoutMs: this.appendLockTimeoutMs,
        label: "append lock",
      });
      const { seq, fileSize } = await this.nextSeqLocked();
      const row = build(seq);
      assert(
        this.getSeq(row) === seq,
        `Journal append: row seq ${this.getSeq(row)} must equal assigned seq ${seq}`
      );
      const parsed = this.schema.safeParse(row);
      assert(
        parsed.success,
        `Journal append: row failed schema validation: ${JSON.stringify(row)}`
      );

      // Heal a torn tail (crash mid-append): start on a fresh line so this row
      // stays parseable even if the previous write was truncated.
      const separator = (await this.hasUnterminatedTail()) ? "\n" : "";
      const line = JSON.stringify(row);
      assert(!line.includes("\n"), "Journal rows must serialize to a single line");
      const payload = `${separator}${line}\n`;
      if (this.testOnlyBeforeAppendWrite !== undefined) {
        await this.testOnlyBeforeAppendWrite();
      }
      // Defense in depth (round 11): the lock protocol makes wrongful
      // displacement of a live holder practically impossible but not provably
      // impossible on birth-less platforms; verifying ownership immediately
      // before the write guarantees a displaced holder can never append a
      // duplicate sequence. Failure throws — callers already tolerate append
      // failures per the self-healing doctrine.
      await lock.assertStillOwned();
      await fs.appendFile(this.filePath, payload, "utf-8");
      this.nextSeq = seq + 1;
      const postAppendFileSize = fileSize + Buffer.byteLength(payload, "utf-8");
      this.lastKnownSize = postAppendFileSize;
      // Synchronous, still inside the exclusive section: consumers observe
      // the row and both sizes as one atomic unit.
      this.onAppended?.(row, { preAppendFileSize: fileSize, postAppendFileSize });
      return row;
    });
    // Keep the queue alive even if this append fails.
    this.writeQueue = task.catch(() => undefined);
    return task;
  }

  /**
   * Read all rows, self-healing as we go:
   * - unparseable / schema-invalid lines are skipped (warn-logged),
   * - duplicate ids are dropped (first occurrence wins),
   * - rows are stable-sorted by seq (ties keep file order).
   */
  async read(): Promise<T[]> {
    let raw: string;
    try {
      raw = await fs.readFile(this.filePath, "utf-8");
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") {
        return [];
      }
      throw error;
    }

    const rows: T[] = [];
    const seenIds = new Set<string>();
    const lines = raw.split("\n");
    for (let i = 0; i < lines.length; i++) {
      const line = lines[i].trim();
      if (!line) continue;
      let value: unknown;
      try {
        value = JSON.parse(line);
      } catch {
        log.warn(`Journal: skipping malformed JSON at line ${i + 1} in ${this.filePath}`);
        continue;
      }
      const parsed = this.schema.safeParse(value);
      if (!parsed.success) {
        log.warn(`Journal: skipping schema-invalid row at line ${i + 1} in ${this.filePath}`);
        continue;
      }
      const id = this.getId(parsed.data);
      if (seenIds.has(id)) {
        log.warn(`Journal: dropping duplicate row id '${id}' at line ${i + 1} in ${this.filePath}`);
        continue;
      }
      seenIds.add(id);
      rows.push(parsed.data);
    }

    // Stable sort by seq; JS Array.prototype.sort is stable, so file order is
    // preserved for equal sequence numbers.
    rows.sort((a, b) => this.getSeq(a) - this.getSeq(b));
    return rows;
  }

  /**
   * Derive the next sequence under the append lock. The cached counter is
   * trusted only while the file size still matches what we observed after our
   * own last append; any other size means a foreign writer appended (or the
   * file was replaced) and the counter is re-derived from a full scan. Foreign
   * appends are rare (debug CLI rollbacks), so the rescan cost is incidental.
   */
  private async nextSeqLocked(): Promise<{ seq: number; fileSize: number }> {
    let fileSize = 0;
    try {
      fileSize = (await fs.stat(this.filePath)).size;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") {
        throw error;
      }
    }
    if (this.nextSeq !== null && this.lastKnownSize === fileSize) {
      return { seq: this.nextSeq, fileSize };
    }
    const rows = await this.read();
    const maxSeq = rows.reduce((max, row) => Math.max(max, this.getSeq(row)), -1);
    return { seq: maxSeq + 1, fileSize };
  }

  /** True when the file exists, is non-empty, and does not end with "\n". */
  private async hasUnterminatedTail(): Promise<boolean> {
    let handle: fs.FileHandle;
    try {
      handle = await fs.open(this.filePath, "r");
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") {
        return false;
      }
      throw error;
    }
    try {
      const { size } = await handle.stat();
      if (size === 0) {
        return false;
      }
      const buffer = Buffer.alloc(1);
      await handle.read(buffer, 0, 1, size - 1);
      return buffer.toString("utf-8") !== "\n";
    } finally {
      await handle.close();
    }
  }
}

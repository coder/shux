import { CHAT_FILE_NAME, CHAT_ARCHIVE_FILE_NAME } from "@/common/constants/paths";
import assert from "node:assert";
import { AsyncLocalStorage } from "node:async_hooks";
import { constants } from "node:fs";
import * as fs from "node:fs/promises";
import * as path from "node:path";
import { randomUUID } from "node:crypto";
import { z } from "zod";
import { ensurePrivateDir } from "@/node/utils/fs";
import writeFileAtomic from "write-file-atomic";
import { log } from "./log";

export const HISTORY_APPEND_PROVENANCE_FILE = "history-append-provenance.json";
export const HISTORY_PROVENANCE_MAX_RECEIPT_BYTES = 4096;
const integer = z.string().max(40).regex(/^\d+$/);
const timestamp = z
  .string()
  .max(40)
  .regex(/^-?\d+$/);
const FileStampSchema = z
  .object({
    dev: integer,
    ino: integer,
    size: integer,
    mtimeNs: timestamp,
    ctimeNs: timestamp,
  })
  .strict()
  .nullable();
const StampsSchema = z.object({ chat: FileStampSchema, archive: FileStampSchema }).strict();
const ReceiptSchema = z
  .object({
    version: z.literal(1),
    epoch: z.string().uuid(),
    state: z.enum(["pending", "stable"]),
    files: StampsSchema,
  })
  .strict();
export type HistoryFileStamps = z.infer<typeof StampsSchema>;
export type HistoryAppendReceipt = z.infer<typeof ReceiptSchema>;
interface Transaction {
  chatPath: string;
  expected: HistoryFileStamps;
  certified: boolean;
  active: boolean;
}
const transactions = new AsyncLocalStorage<Transaction>();

export function invalidateHistoryAppendProvenance(): void {
  const transaction = transactions.getStore();
  if (transaction?.active) transaction.certified = false;
}
function sameStamps(a: HistoryFileStamps, b: HistoryFileStamps): boolean {
  return JSON.stringify(a) === JSON.stringify(b);
}

/** O(1) receipt, always accessed while the caller holds the history file lock.
 * It certifies cooperative append continuity, never arbitrary filesystem edits.
 */
export class HistoryAppendProvenance {
  readonly receiptPath: string;
  readonly chatPath: string;
  readonly archivePath: string;
  constructor(readonly sessionDir: string) {
    assert(path.isAbsolute(sessionDir), "history provenance requires an absolute session path");
    this.receiptPath = path.join(sessionDir, HISTORY_APPEND_PROVENANCE_FILE);
    this.chatPath = path.join(sessionDir, CHAT_FILE_NAME);
    this.archivePath = path.join(sessionDir, CHAT_ARCHIVE_FILE_NAME);
  }

  inTransaction(): boolean {
    const transaction = transactions.getStore();
    return transaction?.active === true && transaction.chatPath === this.chatPath;
  }

  async stamps(): Promise<HistoryFileStamps> {
    const stamp = async (filePath: string) => {
      try {
        const stat = await fs.stat(filePath, { bigint: true });
        if (!stat.isFile()) throw new Error("History artifact is not a file");
        return {
          dev: String(stat.dev),
          ino: String(stat.ino),
          size: String(stat.size),
          mtimeNs: String(stat.mtimeNs),
          ctimeNs: String(stat.ctimeNs),
        };
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code === "ENOENT") return null;
        throw error;
      }
    };
    return { chat: await stamp(this.chatPath), archive: await stamp(this.archivePath) };
  }

  async read(): Promise<{ receipt: HistoryAppendReceipt | null; bytesRead: number }> {
    let handle: fs.FileHandle | undefined;
    let bytesRead = 0;
    try {
      // Reject special files without blocking on a FIFO before the descriptor check below.
      handle = await fs.open(
        this.receiptPath,
        constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0) | (constants.O_NONBLOCK ?? 0)
      );
      const stat = await handle.stat();
      if (!stat.isFile() || stat.size > HISTORY_PROVENANCE_MAX_RECEIPT_BYTES)
        return { receipt: null, bytesRead };
      const buffer = Buffer.alloc(HISTORY_PROVENANCE_MAX_RECEIPT_BYTES);
      ({ bytesRead } = await handle.read(buffer, 0, buffer.length, 0));
      const parsed = ReceiptSchema.safeParse(
        JSON.parse(buffer.subarray(0, bytesRead).toString("utf8"))
      );
      return { receipt: parsed.success ? parsed.data : null, bytesRead };
    } catch {
      return { receipt: null, bytesRead };
    } finally {
      await handle?.close();
    }
  }

  private async syncDirectory(): Promise<void> {
    // Windows cannot fsync directory handles; rename durability follows its API.
    if (process.platform === "win32") return;
    const handle = await fs.open(this.sessionDir, "r");
    try {
      await handle.sync();
    } finally {
      await handle.close();
    }
  }

  private async publish(
    receipt: HistoryAppendReceipt,
    assertStillOwned?: () => Promise<void>
  ): Promise<void> {
    const bytes = Buffer.from(JSON.stringify(receipt));
    assert(
      bytes.length <= HISTORY_PROVENANCE_MAX_RECEIPT_BYTES,
      "history receipt exceeds its bound"
    );
    const temporary = `${this.receiptPath}.${randomUUID()}.tmp`;
    const handle = await fs.open(temporary, "wx", 0o600);
    try {
      try {
        await handle.writeFile(bytes);
        await handle.sync();
      } finally {
        await handle.close();
      }
      // Rename replaces a destination symlink rather than following it.
      if (assertStillOwned) await assertStillOwned();
      await fs.rename(temporary, this.receiptPath);
      await this.syncDirectory();
    } finally {
      await fs.rm(temporary, { force: true });
    }
  }

  /** A fresh scan can reconcile; a resumed cursor can never bless missing evidence. */
  async forScan(epoch?: string): Promise<{ receipt: HistoryAppendReceipt; bytesRead: number }> {
    const { receipt, bytesRead } = await this.read();
    const files = await this.stamps();
    if (
      receipt?.state === "stable" &&
      sameStamps(receipt.files, files) &&
      (epoch == null || epoch === receipt.epoch)
    ) {
      return { receipt, bytesRead };
    }
    if (epoch != null) throw new Error("stale_cursor");
    await ensurePrivateDir(this.sessionDir);
    const replacement: HistoryAppendReceipt = {
      version: 1,
      state: "stable",
      epoch: randomUUID(),
      files,
    };
    await this.publish(replacement);
    return { receipt: replacement, bytesRead };
  }

  async validatePage(receipt: HistoryAppendReceipt): Promise<number> {
    const current = await this.read();
    if (
      current.receipt?.state !== "stable" ||
      current.receipt.epoch !== receipt.epoch ||
      !sameStamps(current.receipt.files, receipt.files) ||
      !sameStamps(await this.stamps(), receipt.files)
    ) {
      throw new Error("stale_cursor");
    }
    return current.bytesRead;
  }

  async runMutation<T>(
    operation: () => Promise<T>,
    assertStillOwned?: () => Promise<void>
  ): Promise<T> {
    assert(
      transactions.getStore()?.active !== true,
      "history provenance transactions must not nest"
    );
    const initial = await this.stamps();
    const { receipt } = await this.read();
    const matched = receipt?.state === "stable" && sameStamps(receipt.files, initial);
    const epoch = matched ? receipt.epoch : randomUUID();
    let tracking = true;
    try {
      await this.publish({ version: 1, epoch, state: "pending", files: initial }, assertStillOwned);
    } catch (error) {
      // No mutation may begin while an old stable receipt remains trusted.
      // Deletion is the fallback; if that too fails, abort BEFORE the operation.
      if (assertStillOwned) await assertStillOwned();
      await fs.rm(this.receiptPath, { force: true });
      await this.syncDirectory();
      tracking = false;
      log.warn("History append tracking unavailable; invalidated receipt", { error });
    }
    const transaction: Transaction = {
      chatPath: this.chatPath,
      expected: initial,
      certified: matched,
      active: true,
    };
    try {
      return await transactions.run(transaction, operation);
    } catch (error) {
      transaction.certified = false;
      throw error;
    } finally {
      transaction.active = false;
      // Receipt failure after publication must never invite replay of accepted history.
      if (tracking) {
        try {
          const files = await this.stamps();
          const stableEpoch =
            transaction.certified && sameStamps(files, transaction.expected) ? epoch : randomUUID();
          await this.publish(
            { version: 1, epoch: stableEpoch, state: "stable", files },
            assertStillOwned
          );
        } catch (error) {
          log.warn("Failed to finalize history append receipt", { error });
        }
      }
    }
  }

  private async appendWasPublished(
    before: HistoryFileStamps,
    bytes: Buffer,
    replacement?: Buffer
  ): Promise<boolean> {
    const after = await this.stamps();
    const start = BigInt(before.chat?.size ?? 0);
    if (
      after.chat == null ||
      BigInt(after.chat.size) !== start + BigInt(bytes.length) ||
      JSON.stringify(after.archive) !== JSON.stringify(before.archive)
    )
      return false;
    if (replacement) return (await fs.readFile(this.chatPath)).equals(replacement);
    if (start > BigInt(Number.MAX_SAFE_INTEGER)) return false;
    const handle = await fs.open(this.chatPath, "r");
    try {
      const tail = Buffer.alloc(bytes.length);
      let offset = 0;
      while (offset < tail.length) {
        const read = await handle.read(tail, offset, tail.length - offset, Number(start) + offset);
        if (read.bytesRead === 0) return false;
        offset += read.bytesRead;
      }
      return tail.equals(bytes);
    } finally {
      await handle.close();
    }
  }

  /** Low-level append certification; the start must match the whole transaction. */
  async appendChat(
    bytes: Buffer,
    atomic = false,
    publishAtomic?: (filePath: string, bytes: Buffer) => Promise<void>
  ): Promise<void> {
    const transaction = transactions.getStore();
    assert(
      transaction?.active === true && transaction.chatPath === this.chatPath,
      "history append requires its provenance transaction"
    );
    const before = await this.stamps();
    assert(transaction.active, "history append outlived its transaction");
    if (!sameStamps(before, transaction.expected)) transaction.certified = false;
    let published = false;
    let replacement: Buffer | undefined;
    try {
      if (atomic) {
        const existing = await fs.readFile(this.chatPath).catch((error: NodeJS.ErrnoException) => {
          if (error.code === "ENOENT") return Buffer.alloc(0);
          throw error;
        });
        if (BigInt(existing.length) !== BigInt(before.chat?.size ?? 0))
          transaction.certified = false;
        // Keep prior bytes verbatim, including invalid UTF-8. Torn-tail repair
        // deliberately invalidates continuation rather than certifying recovery.
        if (existing.length > 0 && existing[existing.length - 1] !== 10) {
          transaction.certified = false;
          bytes = Buffer.concat([Buffer.from("\n"), bytes]);
        }
        replacement = Buffer.concat([existing, bytes]);
        // HistoryService supplies its commit-point observer without duplicating
        // raw-byte preservation, torn-tail repair, or append certification here.
        await (publishAtomic ?? writeFileAtomic)(this.chatPath, replacement);
        published = true;
      } else {
        const size = Number(before.chat?.size ?? 0);
        assert(Number.isSafeInteger(size), "chat tail offset must be representable");
        if (size > 0) {
          const tailHandle = await fs.open(this.chatPath, "r");
          try {
            const tail = Buffer.alloc(1);
            const read = await tailHandle.read(tail, 0, 1, size - 1);
            assert(read.bytesRead === 1, "chat tail must remain readable under the history lock");
            // Failed ordinary appends can leave a partial row. Preserve its raw
            // evidence, but do not certify a repair as uninterrupted append history.
            if (tail[0] !== 10) {
              transaction.certified = false;
              bytes = Buffer.concat([Buffer.from("\n"), bytes]);
            }
          } finally {
            await tailHandle.close();
          }
        }
        await fs.appendFile(this.chatPath, bytes);
        published = true;
        const handle = await fs.open(this.chatPath, "r");
        try {
          await handle.sync();
        } finally {
          await handle.close();
        }
      }
      const after = await this.stamps();
      if (
        after.chat == null ||
        BigInt(after.chat.size) !== BigInt(before.chat?.size ?? 0) + BigInt(bytes.length) ||
        JSON.stringify(before.archive) !== JSON.stringify(after.archive) ||
        (!atomic &&
          before.chat != null &&
          (before.chat.dev !== after.chat.dev || before.chat.ino !== after.chat.ino))
      ) {
        transaction.certified = false;
      }
      transaction.expected = after;
    } catch (error) {
      transaction.certified = false;
      if (!published) {
        // Some I/O errors arrive after publication (e.g. atomic rename followed
        // by a failing finalizer). Verify the exact result before inviting retry.
        published = await this.appendWasPublished(before, bytes, replacement).catch(() => false);
      }
      if (published) {
        log.warn("History appended but append certification failed", { error });
        return;
      }
      throw error;
    }
  }
}

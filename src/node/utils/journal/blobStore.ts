/**
 * Content-addressed blob store (journal kit companion).
 *
 * Blobs are stored once by sha256 under `<dir>/<hash[0:2]>/<hash>` and
 * referenced from journal rows as `sha256:<hex>` (BlobRef). Consumers:
 * turn-envelope system-prompt text (Track 1), offloaded result values and
 * sandbox vars snapshots (Track 2 / sandbox host).
 *
 * Writes are atomic (temp file + rename); content addressing makes concurrent
 * writers of the same content converge on identical bytes. Reads verify the
 * hash (cheap second-algorithm validation) and self-heal by returning null on
 * corruption instead of propagating bad bytes.
 */

import assert from "node:assert";
import crypto from "node:crypto";
import * as fs from "fs/promises";
import * as path from "path";
import type { BlobRef } from "@/common/types/durableEvent";
import { BlobRefSchema } from "@/common/types/durableEvent";
import { log } from "@/node/services/log";

export class BlobStore {
  constructor(private readonly dir: string) {
    assert(dir.length > 0, "BlobStore requires a directory");
  }

  /**
   * Store content once by hash. Returns the BlobRef, size in bytes, and
   * whether this call created the file. `created` is false whenever a file
   * already existed at the hash path (matching or corrupt-and-rewritten):
   * a pre-existing path may be referenced by earlier journal rows, so
   * failed-publish cleanup must never delete those (see publishWithBlob).
   */
  async put(
    content: string | Uint8Array
  ): Promise<{ ref: BlobRef; size: number; created: boolean }> {
    const buffer =
      typeof content === "string" ? Buffer.from(content, "utf-8") : Buffer.from(content);
    const hash = crypto.createHash("sha256").update(buffer).digest("hex");
    const ref: BlobRef = `sha256:${hash}`;
    const blobPath = this.pathFor(ref);

    let existed = false;
    try {
      // Store-once, but verify: an existing path whose bytes no longer match
      // the addressed content (torn write, disk corruption) must be replaced,
      // otherwise get() rejects it forever and no future put() could repair it.
      const existing = await fs.readFile(blobPath);
      existed = true;
      if (existing.equals(buffer)) {
        return { ref, size: buffer.byteLength, created: false };
      }
      log.warn(`BlobStore: existing blob ${ref} is corrupted; rewriting`);
    } catch {
      // Not present (or unreadable) yet - write below.
    }

    await fs.mkdir(path.dirname(blobPath), { recursive: true });
    // Atomic install: write to a unique temp file, then rename. Rename over an
    // existing (possibly corrupt) blob both installs and self-heals.
    const tempPath = `${blobPath}.tmp-${process.pid}-${crypto.randomBytes(4).toString("hex")}`;
    await fs.writeFile(tempPath, buffer);
    await fs.rename(tempPath, blobPath);
    return { ref, size: buffer.byteLength, created: !existed };
  }

  /**
   * Read a blob. Returns null when missing or corrupted (hash mismatch) —
   * load paths self-heal rather than crash on damaged session data.
   */
  async get(ref: BlobRef): Promise<Buffer | null> {
    this.assertValidRef(ref);
    let buffer: Buffer;
    try {
      buffer = await fs.readFile(this.pathFor(ref));
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") {
        return null;
      }
      throw error;
    }
    const hash = crypto.createHash("sha256").update(buffer).digest("hex");
    if (`sha256:${hash}` !== ref) {
      log.warn(`BlobStore: hash mismatch for ${ref} (corrupted blob); treating as missing`);
      return null;
    }
    return buffer;
  }

  /** Read a blob as UTF-8 text; null when missing or corrupted. */
  async getText(ref: BlobRef): Promise<string | null> {
    const buffer = await this.get(ref);
    return buffer === null ? null : buffer.toString("utf-8");
  }

  /**
   * Delete a blob (idempotent — missing blobs are a no-op). Callers own the
   * safety argument: content addressing means a hash can be shared by every
   * event that stored identical content, so delete only refs proven
   * unreferenced (e.g. superseded vars snapshots after a journal scan).
   */
  async delete(ref: BlobRef): Promise<void> {
    this.assertValidRef(ref);
    try {
      await fs.unlink(this.pathFor(ref));
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") {
        throw error;
      }
    }
  }

  /**
   * Byte size of a stored blob via stat; null when missing. No content
   * verification (unlike get) — intended for quota accounting, where a
   * corrupt payload still occupies the bytes being accounted.
   */
  async size(ref: BlobRef): Promise<number | null> {
    this.assertValidRef(ref);
    try {
      const stats = await fs.stat(this.pathFor(ref));
      return stats.size;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") {
        return null;
      }
      throw error;
    }
  }

  async has(ref: BlobRef): Promise<boolean> {
    this.assertValidRef(ref);
    try {
      await fs.access(this.pathFor(ref));
      return true;
    } catch {
      return false;
    }
  }

  private pathFor(ref: BlobRef): string {
    const hash = ref.slice("sha256:".length);
    // Two-level fan-out keeps directories small as blobs accumulate.
    return path.join(this.dir, hash.slice(0, 2), hash);
  }

  private assertValidRef(ref: string): void {
    assert(BlobRefSchema.safeParse(ref).success, `Invalid blob ref: ${ref}`);
  }
}

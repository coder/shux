import { createHash } from "node:crypto";
import { constants as fsConstants } from "node:fs";
import * as fs from "node:fs/promises";
import * as path from "node:path";
import assert from "@/common/utils/assert";
import { ensurePathContained } from "@/node/services/tools/skillFileUtils";

/**
 * Consent covers the complete installed tree, not just preview descriptors:
 * SKILL.md bodies, referenced files and MCP executables can change behind an unchanged Git SHA.
 * Symlinks contribute their target text; contained targets are hashed at their physical paths.
 */
export async function hashPluginTree(
  root: string,
  quota: { maxBytes: number; maxFiles: number }
): Promise<string> {
  const changed = () =>
    new Error(
      "Installed plugin files changed during component review. Refresh the component inventory."
    );
  const rootReal = await fs.realpath(root);
  if (!(await fs.lstat(rootReal)).isDirectory()) throw changed();
  const pending = [rootReal];
  const records: Array<[string, number, string]> = [];
  const buffer = Buffer.alloc(64 * 1024);
  let entries = 0;
  let bytes = 0;
  while (pending.length > 0) {
    const current = pending.pop();
    assert(current !== undefined, "hashPluginTree: queue underflow");
    const stat = await fs.lstat(current);
    const relative = path.relative(rootReal, current);
    if (stat.isSymbolicLink()) {
      records.push([relative, stat.mode, await fs.readlink(current)]);
      continue;
    }
    await ensurePathContained(rootReal, current);
    if (stat.isDirectory()) {
      const directory = await fs.opendir(current);
      for await (const entry of directory) {
        if (++entries > quota.maxFiles)
          throw new Error("Installed plugin exceeds the component review file limit.");
        pending.push(path.join(current, entry.name));
      }
      records.push([relative, stat.mode, ""]);
    } else if (stat.isFile()) {
      bytes += stat.size;
      if (bytes > quota.maxBytes)
        throw new Error("Installed plugin exceeds the component review size limit.");
      const handle = await fs.open(
        current,
        fsConstants.O_RDONLY | fsConstants.O_NOFOLLOW | fsConstants.O_NONBLOCK
      );
      try {
        const opened = await handle.stat();
        if (
          !opened.isFile() ||
          opened.dev !== stat.dev ||
          opened.ino !== stat.ino ||
          opened.size !== stat.size
        )
          throw changed();
        await ensurePathContained(rootReal, current);
        const hash = createHash("sha256");
        let offset = 0;
        while (offset < stat.size) {
          const { bytesRead } = await handle.read(
            buffer,
            0,
            Math.min(buffer.length, stat.size - offset),
            offset
          );
          if (bytesRead === 0) throw changed();
          hash.update(buffer.subarray(0, bytesRead));
          offset += bytesRead;
        }
        const after = await handle.stat();
        if (
          after.size !== stat.size ||
          after.mtimeMs !== stat.mtimeMs ||
          after.ctimeMs !== stat.ctimeMs
        )
          throw changed();
        records.push([relative, stat.mode, hash.digest("hex")]);
      } finally {
        await handle.close();
      }
    } else {
      throw new Error(`Installed plugin contains an unsupported file: ${relative}`);
    }
  }
  if ((await fs.realpath(root)) !== rootReal) throw changed();
  records.sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0));
  return createHash("sha256")
    .update(JSON.stringify([rootReal, records]))
    .digest("hex");
}

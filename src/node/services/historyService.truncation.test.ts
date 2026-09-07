import { afterEach, beforeEach, describe, expect, spyOn, test } from "bun:test";
import { createHash } from "node:crypto";
import * as fs from "node:fs/promises";
import * as path from "node:path";
import { createMuxMessage } from "@/common/types/message";
import { HistoryService } from "./historyService";
import { createTestHistoryService } from "./testHistoryService";

const workspaceId = "truncation-compatibility";
const hash = (contents: string | Buffer) => createHash("sha256").update(contents).digest("hex");
const reset = Buffer.concat([
  Buffer.from('{"metadata":{"contextBoundaryKind":"reset"},'),
  Buffer.from([0xff]),
  Buffer.from("\n"),
]);
const active = Buffer.from(
  JSON.stringify(createMuxMessage("public", "user", "public facts")) + "\n"
);
const backup = Buffer.from(
  JSON.stringify(createMuxMessage("private", "user", "private facts")) + "\n"
);
const legacyHashes = {
  finalArchiveHash: hash(reset.toString("utf8")),
  finalChatHash: hash(active.toString("utf8")),
};
const rawHashes = {
  version: 1,
  finalArchiveHash: hash(reset),
  finalChatHash: hash(active),
};

describe("HistoryService truncation marker compatibility", () => {
  let h: Awaited<ReturnType<typeof createTestHistoryService>>;
  let chatPath: string;
  let archivePath: string;
  let markerPath: string;
  let tombstonePath: string;
  beforeEach(async () => {
    h = await createTestHistoryService();
    chatPath = path.join(h.config.sessionsDir, workspaceId, "chat.jsonl");
    archivePath = path.join(h.config.sessionsDir, workspaceId, "chat-archive.jsonl");
    markerPath = `${archivePath}.truncate.json`;
    tombstonePath = `${archivePath}.truncate`;
    expect(
      (
        await h.historyService.appendToHistory(
          workspaceId,
          createMuxMessage("seed", "user", "seed")
        )
      ).success
    ).toBe(true);
  });
  afterEach(async () => {
    await h.cleanup();
  });

  async function seedTransaction(marker: unknown, archive = reset): Promise<void> {
    await fs.writeFile(archivePath, archive);
    await fs.writeFile(chatPath, active);
    await fs.writeFile(tombstonePath, backup);
    await fs.writeFile(markerPath, JSON.stringify(marker));
  }

  test.each(["preceding build", "current build"])(
    "a committed new marker is recognized by the %s after a cleanup crash",
    async (reader) => {
      await fs.writeFile(archivePath, Buffer.concat([backup, reset]));
      const rows = [
        createMuxMessage("first", "user", "public context ".repeat(2000)),
        createMuxMessage("last", "user", "public context ".repeat(2000)),
      ];
      await fs.writeFile(chatPath, rows.map((row) => JSON.stringify(row)).join("\n") + "\n");
      const originalRm = fs.rm;
      const cleanupFailure = spyOn(fs, "rm").mockImplementation(async (...args) => {
        if (args[0] === tombstonePath) throw new Error("simulated cleanup crash");
        return originalRm(...args);
      });
      try {
        expect((await h.historyService.truncateHistory(workspaceId, 0.5)).success).toBe(true);
      } finally {
        cleanupFailure.mockRestore();
      }
      const finalArchive = await fs.readFile(archivePath);
      const finalChat = await fs.readFile(chatPath);
      expect(finalArchive).toEqual(reset);
      const marker = JSON.parse(await fs.readFile(markerPath, "utf8")) as Record<string, unknown>;
      expect(marker.rawHashes).toEqual({
        version: 1,
        finalArchiveHash: hash(finalArchive),
        finalChatHash: hash(finalChat),
      });
      // The preceding build reads UTF-8 strings, ignores unknown fields, and
      // retires the tombstone only when both of these original fields match.
      const recognizedByOldBuild =
        marker.finalArchiveHash === hash(finalArchive.toString("utf8")) &&
        marker.finalChatHash === hash(finalChat.toString("utf8"));
      expect(recognizedByOldBuild).toBe(true);
      if (reader === "preceding build") {
        if (recognizedByOldBuild) {
          await fs.rm(tombstonePath);
          await fs.rm(markerPath);
        }
      } else {
        expect((await h.historyService.getLastMessages(workspaceId, 1)).success).toBe(true);
      }
      expect(await fs.readFile(archivePath)).toEqual(finalArchive);
      expect(await fs.readFile(chatPath)).toEqual(finalChat);
      expect(
        await fs.stat(tombstonePath).then(
          () => true,
          () => false
        )
      ).toBe(false);
    }
  );

  test("upgrade recognizes a committed legacy UTF-8 marker with invalid bytes", async () => {
    await seedTransaction(legacyHashes);
    expect((await h.historyService.getLastMessages(workspaceId, 1)).success).toBe(true);
    expect(await fs.readFile(archivePath)).toEqual(reset);
    expect(
      await fs.stat(tombstonePath).then(
        () => true,
        () => false
      )
    ).toBe(false);
  });

  test("versioned raw hashes reject a byte change hidden by UTF-8 decoding", async () => {
    const changed = Buffer.from(reset);
    changed[changed.indexOf(0xff)] = 0xfe;
    expect(changed.toString("utf8")).toBe(reset.toString("utf8"));
    await seedTransaction({ ...legacyHashes, rawHashes }, changed);
    expect((await h.historyService.getLastMessages(workspaceId, 1)).success).toBe(true);
    expect(await fs.readFile(archivePath)).toEqual(backup);
  });

  test.each(
    [
      null,
      {},
      { ...rawHashes, version: 2 },
      { ...rawHashes, finalArchiveHash: 42 },
      { ...rawHashes, finalChatHash: "invalid" },
    ].map((value) => [value] as const)
  )(
    "malformed raw hash extension fails closed instead of falling back to legacy hashes: %j",
    async (extension) => {
      await seedTransaction({ ...legacyHashes, rawHashes: extension });
      expect((await h.historyService.getLastMessages(workspaceId, 1)).success).toBe(true);
      expect(await fs.readFile(archivePath)).toEqual(backup);
    }
  );

  test.each([true, false])(
    "new recovery verifies committed raw hashes (tombstone: %s)",
    async (tombstone) => {
      await seedTransaction({ ...legacyHashes, rawHashes });
      if (!tombstone) await fs.rm(tombstonePath);
      expect((await h.historyService.getLastMessages(workspaceId, 1)).success).toBe(true);
      expect(await fs.readFile(archivePath)).toEqual(reset);
      expect(
        await fs.stat(markerPath).then(
          () => true,
          () => false
        )
      ).toBe(false);
    }
  );

  test("a committed full delete with null raw hashes cannot resurrect its tombstone", async () => {
    await seedTransaction({
      finalArchiveHash: null,
      finalChatHash: null,
      rawHashes: { version: 1, finalArchiveHash: null, finalChatHash: null },
    });
    await fs.rm(archivePath);
    await fs.rm(chatPath);
    const next = createMuxMessage("fresh", "user", "fresh request");
    const restarted = new HistoryService(h.config);
    expect((await restarted.appendToHistory(workspaceId, next)).success).toBe(true);
    expect(next.metadata?.historySequence).toBe(0);
    expect(
      await fs.stat(tombstonePath).then(
        () => true,
        () => false
      )
    ).toBe(false);
    expect(
      await fs.stat(archivePath).then(
        () => true,
        () => false
      )
    ).toBe(false);
  });

  test("new recovery rolls back a prepared marker when only the archive commit landed", async () => {
    await seedTransaction({ ...legacyHashes, rawHashes });
    await fs.writeFile(chatPath, backup);
    expect((await h.historyService.getLastMessages(workspaceId, 1)).success).toBe(true);
    expect(await fs.readFile(archivePath)).toEqual(backup);
  });
});

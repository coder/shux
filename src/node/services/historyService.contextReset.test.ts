import { afterEach, beforeEach, describe, expect, it, mock, spyOn } from "bun:test";
import * as fs from "node:fs/promises";
import * as path from "node:path";
import * as atomicWrite from "write-file-atomic";
import { createMuxMessage } from "@/common/types/message";
import { CONTINUOUS_COMPACTION_GENERATION_FILE } from "@/constants/continuousCompaction";
import * as fileLock from "@/node/utils/concurrency/fileLock";
import { CompactionPendingState } from "./compactionPendingState";
import { HistoryService } from "./historyService";
import { createTestHistoryService } from "./testHistoryService";
import { historyWriteLockPath } from "./workspaceRemoval";

describe("empty context reset transactions", () => {
  const workspaceId = "empty-reset-transaction";
  let h: Awaited<ReturnType<typeof createTestHistoryService>>;
  beforeEach(async () => {
    h = await createTestHistoryService();
  });
  afterEach(async () => {
    mock.restore();
    await h.cleanup();
  });

  it.each(["generation", "journal", "source"] as const)(
    "holds the initial empty view through its fence before a foreign %s publication",
    async (change) => {
      const journal = h.historyService.getContinuousCompactionJournal(workspaceId);
      const entered = Promise.withResolvers<void>();
      const release = Promise.withResolvers<void>();
      const attempted = Promise.withResolvers<void>();
      const order: string[] = [];
      const advance = journal.advanceGenerationUnderHistoryLock.bind(journal);
      spyOn(journal, "advanceGenerationUnderHistoryLock").mockImplementationOnce(
        async (...args) => {
          entered.resolve();
          await release.promise;
          const result = await advance(...args);
          order.push("fenced");
          return result;
        }
      );
      const fencing = h.historyService.fenceEmptyContext(workspaceId);
      let changing: Promise<void> | undefined;
      try {
        await entered.promise;
        const acquire = fileLock.acquireProcessFileLock;
        spyOn(fileLock, "acquireProcessFileLock").mockImplementationOnce((options) => {
          attempted.resolve();
          return acquire(options);
        });
        const target =
          change === "generation"
            ? path.join(path.dirname(journal.path), CONTINUOUS_COMPACTION_GENERATION_FILE)
            : change === "journal"
              ? journal.path
              : path.join(path.dirname(journal.path), "chat.jsonl");
        const bytes =
          change === "source"
            ? JSON.stringify(createMuxMessage("B", "user", "New context", { historySequence: 0 })) +
              "\n"
            : "foreign publication";
        changing = (async () => {
          await using _lease = await fileLock.acquireProcessFileLock({
            lockPath: historyWriteLockPath(h.config.rootDir, workspaceId),
            timeoutMs: 1000,
            label: "foreign publication",
          });
          await fs.writeFile(target, bytes);
          order.push("foreign");
        })();
        await attempted.promise;
        expect(order).toEqual([]);
        release.resolve();
        expect((await fencing).success).toBe(true);
        await changing;
        expect(order).toEqual(["fenced", "foreign"]);
        expect(await fs.readFile(target, "utf8")).toBe(bytes);
      } finally {
        release.resolve();
        await Promise.all([fencing, changing]);
      }
    }
  );

  it.each(["{", '{"version":9,"opaque":"future journal"}\n'])(
    "fences unchanged unreadable journal context while preserving its bytes (%s)",
    async (bytes) => {
      const journal = h.historyService.getContinuousCompactionJournal(workspaceId);
      await fs.mkdir(path.dirname(journal.path), { recursive: true });
      await fs.writeFile(journal.path, bytes);
      const generation = await journal.captureGeneration();
      expect((await h.historyService.fenceEmptyContext(workspaceId)).success).toBe(true);
      expect(await journal.captureGeneration()).not.toBe(generation);
      expect(await fs.readFile(journal.path, "utf8")).toBe(bytes);
    }
  );

  it.each(["noop", "clear"] as const)(
    "lost lease during %s generation staging preserves the foreign successor",
    async (operation) => {
      const sessionDir = path.join(h.config.sessionsDir, workspaceId);
      const generationPath = path.join(sessionDir, CONTINUOUS_COMPACTION_GENERATION_FILE);
      const chatPath = path.join(sessionDir, "chat.jsonl");
      const pendingPath = path.join(sessionDir, "post-compaction.json");
      const entered = Promise.withResolvers<void>();
      const release = Promise.withResolvers<void>();
      const write = atomicWrite.default;
      spyOn(atomicWrite, "default").mockImplementation(
        new Proxy(write, {
          async apply(target, _thisArg, args: Parameters<typeof write>) {
            await target(...args);
            if (String(args[0]).startsWith(`${generationPath}.continuous-`)) {
              entered.resolve();
              await release.promise;
            }
          },
        })
      );
      const fencing =
        operation === "noop"
          ? h.historyService.fenceEmptyContext(workspaceId)
          : h.historyService.clearHistory(workspaceId, { fenceEmptyHistory: true });
      let successor: Awaited<ReturnType<typeof fileLock.acquireProcessFileLock>> | undefined;
      try {
        await entered.promise;
        const lockPath = historyWriteLockPath(h.config.rootDir, workspaceId);
        const token = await fs.readFile(lockPath, "utf8");
        await fs.writeFile(lockPath, token.split(":").slice(0, 2).join(":"));
        await fs.utimes(lockPath, new Date(0), new Date(0));
        successor = await fileLock.acquireProcessFileLock({
          lockPath,
          timeoutMs: 1000,
          label: "foreign reset",
        });
        // Simulate another process writing while it owns the reclaimed physical lease.
        await fs.writeFile(generationPath, "foreign generation");
        const generation = await h.historyService
          .getContinuousCompactionJournal(workspaceId)
          .captureGenerationUnderHistoryLock();
        const chat =
          JSON.stringify(
            createMuxMessage("B", "assistant", "New context", {
              historySequence: 0,
              compacted: "user",
              compactionBoundary: true,
              compactionEpoch: 1,
            })
          ) + "\n";
        const pending = JSON.stringify({
          version: 1,
          createdAt: 1,
          boundaryMessageId: "B",
          writeId: "foreign-owner",
          publicationGeneration: generation,
          diffs: [],
          loadedSkills: [],
          readFiles: ["/tmp/B.ts"],
        });
        await fs.writeFile(chatPath, chat);
        await fs.writeFile(pendingPath, pending);
        release.resolve();
        expect((await fencing).success).toBe(false);
        expect(await fs.readFile(generationPath, "utf8")).toBe("foreign generation");
        expect(await fs.readFile(chatPath, "utf8")).toBe(chat);
        expect(await fs.readFile(pendingPath, "utf8")).toBe(pending);
        await successor[Symbol.asyncDispose]();
        successor = undefined;
        const restarted = new CompactionPendingState(
          pendingPath,
          new HistoryService(h.config).getCompactionPendingHistory(workspaceId)
        );
        expect((await restarted.load(() => true))?.attachments.readFiles).toEqual(["/tmp/B.ts"]);
      } finally {
        release.resolve();
        await fencing;
        await successor?.[Symbol.asyncDispose]();
      }
    }
  );
});

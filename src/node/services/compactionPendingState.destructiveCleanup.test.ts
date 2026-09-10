import { afterEach, beforeEach, describe, expect, it, mock, spyOn } from "bun:test";
import assert from "node:assert/strict";
import * as fs from "node:fs/promises";
import * as path from "node:path";
import { createMuxMessage } from "@/common/types/message";
import { acquireProcessFileLock } from "@/node/utils/concurrency/fileLock";
import { CompactionPendingState } from "./compactionPendingState";
import { HistoryService } from "./historyService";
import { createTestHistoryService } from "./testHistoryService";
import { historyWriteLockPath } from "./workspaceRemoval";

describe("destructive compaction cleanup compatibility", () => {
  const workspaceId = "destructive-legacy";
  let h: Awaited<ReturnType<typeof createTestHistoryService>>;
  let pendingPath: string;
  let pending: CompactionPendingState;
  const legacy = {
    version: 1,
    createdAt: 1,
    diffs: [{ path: "/before.ts", diff: "+before", truncated: false }],
    loadedSkills: [{ name: "before", scope: "project", body: "Previous instructions" }],
    readFiles: ["/before.ts"],
  };

  beforeEach(async () => {
    h = await createTestHistoryService();
    assert(
      (
        await h.historyService.appendToHistory(
          workspaceId,
          createMuxMessage("before", "user", "Previous context")
        )
      ).success
    );
    pendingPath = path.join(h.config.sessionsDir, workspaceId, "post-compaction.json");
    pending = new CompactionPendingState(
      pendingPath,
      h.historyService.getCompactionPendingHistory(workspaceId)
    );
  });

  afterEach(async () => {
    mock.restore();
    await h.cleanup();
  });

  async function destroy() {
    assert((await h.historyService.clearHistory(workspaceId)).success);
  }

  function foreignStore() {
    return new CompactionPendingState(
      pendingPath,
      new HistoryService(h.config).getCompactionPendingHistory(workspaceId)
    );
  }

  function successorBoundary() {
    return createMuxMessage("after", "assistant", "New context", {
      compacted: "user",
      compactionBoundary: true,
      compactionEpoch: 1,
    });
  }

  async function publishSuccessor() {
    return foreignStore().publishBoundary({
      summaryMessage: successorBoundary(),
      tailCopies: [],
      updateExisting: false,
      attachments: { diffs: [], loadedSkills: [], readFiles: ["/after.ts"] },
      publication: {
        generation: await h.historyService
          .getContinuousCompactionJournal(workspaceId)
          .captureGeneration(),
      },
      isCurrent: () => true,
      shouldPersist: () => true,
      onCommitted: () => undefined,
    });
  }

  it.each([false, true])(
    "explicit destruction removes legacy V1 bytes that a downgrade could reload (tagged=%s)",
    async (tagged) => {
      await fs.writeFile(
        pendingPath,
        JSON.stringify({ ...legacy, ...(tagged && { boundaryMessageId: "before" }) })
      );
      await destroy();
      await pending.discardAfterBoundary();
      expect(await fs.stat(pendingPath).catch((error: unknown) => error)).toMatchObject({
        code: "ENOENT",
      });
    }
  );

  it("ordinary ambiguous loading preserves legacy bytes after a fence", async () => {
    const raw = JSON.stringify(legacy);
    await fs.writeFile(pendingPath, raw);
    await destroy();
    expect(await pending.load(() => true)).toBeUndefined();
    expect(await foreignStore().load(() => true)).toBeUndefined();
    expect(await fs.readFile(pendingPath, "utf8")).toBe(raw);
  });

  it("does not delete legacy bytes without a durable generation fence", async () => {
    const raw = JSON.stringify(legacy);
    await fs.writeFile(pendingPath, raw);
    await pending.discardAfterBoundary();
    expect(await fs.readFile(pendingPath, "utf8")).toBe(raw);
  });

  it.each([
    { ...legacy, version: 9 },
    { schema: "future", payload: legacy },
  ])("explicit destruction preserves unknown schema bytes (%j)", async (future) => {
    const raw = JSON.stringify(future);
    await fs.writeFile(pendingPath, raw);
    await destroy();
    await pending.discardAfterBoundary();
    expect(await fs.readFile(pendingPath, "utf8")).toBe(raw);
  });

  it.each([false, true])(
    "late cleanup preserves a newer publication (additional generation=%s)",
    async (additionalGeneration) => {
      await fs.writeFile(pendingPath, JSON.stringify(legacy));
      await destroy();
      if (additionalGeneration)
        await h.historyService.getContinuousCompactionJournal(workspaceId).advanceGeneration();
      assert((await publishSuccessor()).success);
      const raw = await fs.readFile(pendingPath, "utf8");
      await pending.discardAfterBoundary();
      expect(await fs.readFile(pendingPath, "utf8")).toBe(raw);
      expect((await foreignStore().load(() => true))?.attachments.readFiles).toEqual(["/after.ts"]);
    }
  );

  it.each(["queued", "reclaimed lease"] as const)(
    "a successor survives cleanup with %s ownership",
    async (scenario) => {
      await fs.writeFile(pendingPath, JSON.stringify(legacy));
      await destroy();
      const entered = Promise.withResolvers<void>();
      const release = Promise.withResolvers<void>();
      const readFile = fs.readFile;
      const held = spyOn(fs, "readFile").mockImplementation((async (
        ...args: Parameters<typeof fs.readFile>
      ) => {
        const result = await readFile(...args);
        if (args[0] === pendingPath) {
          entered.resolve();
          await release.promise;
        }
        return result;
      }) as typeof fs.readFile);
      const cleaning = pending.discardAfterBoundary().catch((error: unknown) => error);
      let queued: ReturnType<typeof publishSuccessor> | undefined;
      let lease: Awaited<ReturnType<typeof acquireProcessFileLock>> | undefined;
      try {
        await entered.promise;
        held.mockRestore();
        if (scenario === "queued") queued = publishSuccessor();
        else {
          const lockPath = historyWriteLockPath(h.config.rootDir, workspaceId);
          const token = await fs.readFile(lockPath, "utf8");
          await fs.writeFile(lockPath, token.split(":").slice(0, 2).join(":"));
          await fs.utimes(lockPath, new Date(0), new Date(0));
          lease = await acquireProcessFileLock({ lockPath, timeoutMs: 1000, label: "successor" });
          const generation = await h.historyService
            .getContinuousCompactionJournal(workspaceId)
            .captureGenerationUnderHistoryLock();
          // Simulate a foreign process writing only after it owns the reclaimed physical lease.
          await fs.writeFile(
            path.join(path.dirname(pendingPath), "chat.jsonl"),
            JSON.stringify(successorBoundary()) + "\n"
          );
          await fs.writeFile(
            pendingPath,
            JSON.stringify({
              ...legacy,
              boundaryMessageId: "after",
              writeId: "successor",
              publicationGeneration: generation,
              readFiles: ["/after.ts"],
            })
          );
        }
        release.resolve();
        if (scenario === "reclaimed lease") expect(await cleaning).toBeInstanceOf(Error);
        else expect(await cleaning).toBeUndefined();
        await lease?.[Symbol.asyncDispose]();
        lease = undefined;
        if (queued) assert((await queued).success);
        expect((await foreignStore().load(() => true))?.attachments.readFiles).toEqual([
          "/after.ts",
        ]);
      } finally {
        release.resolve();
        await cleaning;
        await lease?.[Symbol.asyncDispose]();
        await queued;
      }
    }
  );

  it("reports legacy unlink failure and can retry the same fenced cleanup", async () => {
    const raw = JSON.stringify(legacy);
    await fs.writeFile(pendingPath, raw);
    await destroy();
    const unlink = fs.unlink;
    const failure = spyOn(fs, "unlink").mockImplementation((file) => {
      if (file === pendingPath)
        return Promise.reject(Object.assign(new Error("Permission denied"), { code: "EACCES" }));
      return unlink(file);
    });
    expect(await pending.discardAfterBoundary().catch((error: unknown) => error)).toMatchObject({
      code: "EACCES",
    });
    failure.mockRestore();
    expect(await fs.readFile(pendingPath, "utf8")).toBe(raw);
    await pending.discardAfterBoundary();
    expect(await fs.stat(pendingPath).catch((error: unknown) => error)).toMatchObject({
      code: "ENOENT",
    });
  });
});

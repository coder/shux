import { afterEach, beforeEach, describe, expect, it, mock, spyOn } from "bun:test";
import assert from "node:assert/strict";
import * as syncFs from "node:fs";
import * as fs from "node:fs/promises";
import * as path from "node:path";
import * as atomicWrite from "write-file-atomic";
import { createMuxMessage, type MuxMessage } from "@/common/types/message";
import * as fileLock from "@/node/utils/concurrency/fileLock";
import { CompactionPendingState } from "./compactionPendingState";
import { HistoryService } from "./historyService";
import { readCompactionPendingHistoryBoundary } from "./historyScanner";
import { createTestHistoryService } from "./testHistoryService";
import { historyWriteLockPath, workspaceRemovalTombstonePath } from "./workspaceRemoval";

describe("inactive compaction history transactions", () => {
  const workspaceId = "pending-history";
  let h: Awaited<ReturnType<typeof createTestHistoryService>>;
  let service: HistoryService;
  let foreign: HistoryService;
  let chatPath: string;
  let archivePath: string;
  let partialPath: string;

  const boundary = (id: string) =>
    createMuxMessage(id, "assistant", id, {
      compacted: "user",
      compactionBoundary: true,
      compactionEpoch: 1,
    });
  const line = (message: MuxMessage) => JSON.stringify(message) + "\n";
  const transaction = () => service.getCompactionPendingHistory(workspaceId);
  const currentBoundary = () => transaction().withLock((view) => Promise.resolve(view.boundary));
  async function capturedPartial() {
    const partial = await service.readPartial(workspaceId);
    assert(partial);
    return partial;
  }

  async function reclaimHistoryLock() {
    const lockPath = historyWriteLockPath(h.config.rootDir, workspaceId);
    // Exercise real lease reclamation without waiting for a live holder to expire.
    const token = await fs.readFile(lockPath, "utf8");
    await fs.writeFile(lockPath, token.split(":").slice(0, 2).join(":"));
    await fs.utimes(lockPath, new Date(0), new Date(0));
    return fileLock.acquireProcessFileLock({ lockPath, timeoutMs: 1000, label: "successor" });
  }

  async function preparedHeartbeat() {
    const pendingPath = path.join(path.dirname(chatPath), "post-compaction.json");
    const attachments = (name: string) => ({
      diffs: [],
      loadedSkills: [],
      readFiles: [`/${name}.ts`],
    });
    await fs.writeFile(
      pendingPath,
      JSON.stringify({ version: 1, createdAt: 1, ...attachments("previous") })
    );
    const pending = new CompactionPendingState(pendingPath, transaction());
    const summary = createMuxMessage("heartbeat", "assistant", "Reset", {
      compacted: "heartbeat",
      compactionBoundary: true,
      compactionEpoch: 1,
      muxMetadata: {
        type: "compaction-summary",
        pendingFollowUp: { text: "Resume", model: "openai:gpt-4o", agentId: "exec" },
      },
    });
    const publication = {
      generation: await service.getContinuousCompactionJournal(workspaceId).captureGeneration(),
    };
    const receipt = await pending.prepare({
      attachments: attachments("heartbeat"),
      boundaryMessageId: summary.id,
      publication,
      isCurrent: () => true,
    });
    assert(receipt);
    assert(
      (
        await service.persistBoundaryWithTailCopies(workspaceId, summary, [], false, () => true, {
          publication,
          onCommitted: () => undefined,
        })
      ).success
    );
    return { pending, summary, receipt, publication };
  }

  beforeEach(async () => {
    h = await createTestHistoryService();
    service = h.historyService;
    foreign = new HistoryService(h.config);
    chatPath = path.join(h.config.sessionsDir, workspaceId, "chat.jsonl");
    archivePath = path.join(h.config.sessionsDir, workspaceId, "chat-archive.jsonl");
    partialPath = path.join(h.config.sessionsDir, workspaceId, "partial.json");
    assert(
      (await service.appendToHistory(workspaceId, createMuxMessage("seed", "user", "Context")))
        .success
    );
  });
  afterEach(async () => {
    mock.restore();
    await h.cleanup();
  });

  it("rejects asynchronous cleanup receipts at compile time", () => {
    type Receipt = NonNullable<Parameters<HistoryService["cleanupCompactionFollowUp"]>[4]>;
    const acceptReceipt = (_receipt: Receipt) => undefined;
    acceptReceipt(() => undefined);
    // @ts-expect-error Receipt publication must finish before cleanup and lock release.
    acceptReceipt(async () => {
      await Promise.resolve();
    });
  });

  it.each(["unchanged", "archive edit", "raw reset"] as const)(
    "qualifies publication against the archive-backed provider source (%s)",
    async (change) => {
      const { pending, summary, publication } = await preparedHeartbeat();
      assert(
        (
          await pending.rollbackHeartbeat({
            summaryMessage: summary,
            isCurrent: () => true,
            canRestorePrevious: () => true,
            onCommitted: () => undefined,
            onRestored: () => undefined,
          })
        ).success
      );
      assert(
        (await foreign.appendToHistory(workspaceId, createMuxMessage("tail", "user", "New task")))
          .success
      );
      const source = await service.getHistoryFromLatestBoundary(workspaceId);
      assert(source.success);
      expect(source.data.map((row) => row.id)).toEqual(["seed", "tail"]);
      expect(await fs.readFile(chatPath, "utf8")).not.toContain('"seed"');
      if (change === "archive edit") {
        const edited = structuredClone(source.data[0]);
        edited.parts = [{ type: "text", text: "Changed archived context" }];
        await fs.writeFile(archivePath, line(edited));
      } else if (change === "raw reset") {
        await fs.appendFile(chatPath, '{"metadata":{"contextBoundaryKind":"reset"},broken\n');
      }
      const before = await Promise.all([
        fs.readFile(chatPath, "utf8"),
        fs.readFile(archivePath, "utf8"),
      ]);
      const result = await pending.publishBoundary({
        summaryMessage: boundary("next"),
        tailCopies: [],
        updateExisting: false,
        publication,
        attachments: { diffs: [], loadedSkills: [], readFiles: [] },
        isCurrent: () => true,
        shouldPersist: (messages, partial) =>
          partial === null && JSON.stringify(messages) === JSON.stringify(source.data),
        onCommitted: () => undefined,
      });
      expect(result.success).toBe(change === "unchanged");
      if (change === "unchanged") {
        const current = await service.getHistoryFromLatestBoundary(workspaceId);
        assert(current.success);
        expect(current.data.map((row) => row.id)).toEqual(["next"]);
      } else {
        expect(
          await Promise.all([fs.readFile(chatPath, "utf8"), fs.readFile(archivePath, "utf8")])
        ).toEqual(before);
      }
    }
  );

  it("holds both locks through the callback and releases them after rejection", async () => {
    const entered = Promise.withResolvers<void>();
    const release = Promise.withResolvers<void>();
    const order: string[] = [];
    const held = transaction()
      .withLock(async (view) => {
        entered.resolve();
        await release.promise;
        expect(await view.isPublicationCurrent({ generation: view.generation })).toBe(true);
        order.push("callback finished");
        throw new Error("callback failed");
      })
      .catch((error: unknown) => error);
    await entered.promise;
    const local = foreign.getCompactionPendingHistory(workspaceId).withLock(() => {
      order.push("local acquired");
      return Promise.resolve();
    });
    // Journal operations have an independent queue and take only the process-file lock.
    // Waiting for their real acquisition attempt proves the callback holds that lock too.
    const attempted = Promise.withResolvers<void>();
    const acquire = fileLock.acquireProcessFileLock;
    spyOn(fileLock, "acquireProcessFileLock").mockImplementation((options) => {
      attempted.resolve();
      return acquire(options);
    });
    const advancing = foreign
      .getContinuousCompactionJournal(workspaceId)
      .advanceGeneration()
      .then(() => {
        order.push("foreign committed");
      });
    try {
      await attempted.promise;
      expect(order).toEqual([]);
      await fs.access(historyWriteLockPath(h.config.rootDir, workspaceId));
      release.resolve();
      expect(await held).toMatchObject({ message: "callback failed" });
      await Promise.all([local, advancing]);
      expect(order[0]).toBe("callback finished");
      expect(order).toContain("local acquired");
      expect(order).toContain("foreign committed");
      await transaction().withLock(async (view) => {
        expect(await view.isPublicationCurrent({ generation: undefined })).toBe(false);
        expect(await view.isPublicationCurrent({ generation: view.generation })).toBe(true);
      });
    } finally {
      release.resolve();
      await Promise.all([held, local, advancing]);
    }
  });

  it("checks removal after acquiring the file lock without recreating the directory", async () => {
    const lock = await fileLock.acquireProcessFileLock({
      lockPath: historyWriteLockPath(h.config.rootDir, workspaceId),
      timeoutMs: 5000,
      label: "pending-history removal",
    });
    const attempted = Promise.withResolvers<void>();
    const acquire = fileLock.acquireProcessFileLock;
    spyOn(fileLock, "acquireProcessFileLock").mockImplementation((options) => {
      attempted.resolve();
      return acquire(options);
    });
    let entered = false;
    const waiting = transaction()
      .withLock(() => {
        entered = true;
        return Promise.resolve();
      })
      .catch((error: unknown) => error);
    try {
      await attempted.promise;
      await fs.writeFile(workspaceRemovalTombstonePath(h.config.rootDir, workspaceId), "removed");
      await fs.rm(path.dirname(chatPath), { recursive: true });
    } finally {
      await lock[Symbol.asyncDispose]();
    }
    expect(await waiting).toBeInstanceOf(Error);
    expect(entered).toBe(false);
    expect(await fs.stat(path.dirname(chatPath)).catch((error: unknown) => error)).toMatchObject({
      code: "ENOENT",
    });
  });

  it("exposes physical ownership that rejects a reclaimed lock", async () => {
    let successor: Awaited<ReturnType<typeof reclaimHistoryLock>> | undefined;
    try {
      await transaction().withLock(async (view) => {
        await view.assertStillOwned();
        successor = await reclaimHistoryLock();
        expect(await view.assertStillOwned().catch((error: unknown) => error)).toBeInstanceOf(
          Error
        );
      });
      expect(successor).toBeDefined();
    } finally {
      await successor?.[Symbol.asyncDispose]();
    }
  });

  it.each(["partial", "cleanup", "recovery"] as const)(
    "preserves successor bytes when the lock is reclaimed during %s I/O",
    async (operation) => {
      const { summary } = await preparedHeartbeat();
      assert((await service.writePartial(workspaceId, summary)).success);
      const captured = await capturedPartial();
      const markerPath = `${archivePath}.truncate.json`;
      const tombstonePath = `${archivePath}.truncate`;
      if (operation === "recovery") {
        await fs.writeFile(markerPath, "{}");
        await fs.writeFile(tombstonePath, "old archive");
      }
      const targetPath =
        operation === "partial" ? partialPath : operation === "cleanup" ? chatPath : archivePath;
      const successorBytes = line(createMuxMessage("successor", "assistant", "Keep"));
      let successor: Awaited<ReturnType<typeof reclaimHistoryLock>> | undefined;
      const reclaim = async () => {
        successor = await reclaimHistoryLock();
        await fs.writeFile(targetPath, successorBytes);
      };
      const readFile = fs.readFile;
      const reading = spyOn(fs, "readFile").mockImplementation(
        new Proxy(readFile, {
          async apply(target, _thisArg, args: Parameters<typeof readFile>) {
            const bytes = await target(...args);
            if (
              !successor &&
              ((operation === "partial" && args[0] === partialPath) ||
                (operation === "recovery" && args[0] === markerPath))
            )
              await reclaim();
            return bytes;
          },
        })
      );
      const atomic = atomicWrite.default;
      const staging = spyOn(atomicWrite, "default").mockImplementation(
        new Proxy(atomic, {
          async apply(target, _thisArg, args: Parameters<typeof atomic>) {
            const result = await target(...args);
            if (operation === "cleanup" && String(args[0]).startsWith(`${chatPath}.follow-up-`))
              await reclaim();
            return result;
          },
        })
      );
      let committed = false;
      try {
        if (operation === "recovery") {
          expect(await currentBoundary().catch((error: unknown) => error)).toBeInstanceOf(Error);
          expect(await fs.readFile(tombstonePath, "utf8")).toBe("old archive");
          expect(await fs.readFile(markerPath, "utf8")).toBe("{}");
        } else {
          const result =
            operation === "partial"
              ? await service.deletePartialIfMatches(workspaceId, captured, () => true)
              : await service.cleanupCompactionFollowUp(
                  workspaceId,
                  summary,
                  "rollback-heartbeat",
                  () => true,
                  () => {
                    committed = true;
                    return undefined;
                  }
                );
          expect(result.success).toBe(false);
        }
        expect(successor).toBeDefined();
        expect(committed).toBe(false);
        expect(await fs.readFile(targetPath, "utf8")).toBe(successorBytes);
      } finally {
        reading.mockRestore();
        staging.mockRestore();
        await successor?.[Symbol.asyncDispose]();
      }
    }
  );

  it.each(["chat", "archive"] as const)(
    "does not recover an older pending boundary across raw reset evidence in %s",
    async (artifact) => {
      const old = boundary("old");
      assert((await service.appendToHistory(workspaceId, old)).success);
      const pendingPath = path.join(path.dirname(chatPath), "post-compaction.json");
      await fs.writeFile(
        pendingPath,
        JSON.stringify({
          version: 1,
          createdAt: 1,
          boundaryMessageId: old.id,
          diffs: [],
          loadedSkills: [],
          readFiles: ["/private.ts"],
        })
      );
      const pending = new CompactionPendingState(pendingPath, transaction());
      assert(await pending.load(() => true));
      const raw = '{"metadata":{"contextBoundaryKind" : "reset"},broken\n';
      await fs.writeFile(archivePath, line(old) + (artifact === "archive" ? raw : ""));
      await fs.writeFile(
        chatPath,
        (artifact === "chat" ? raw : "") + line(createMuxMessage("public", "user", "New context"))
      );
      const before = await fs.readFile(pendingPath, "utf8");
      expect(await pending.load(() => true)).toBeUndefined();
      expect(await fs.readFile(pendingPath, "utf8")).toBe(before);
      expect(await currentBoundary()).toEqual({ kind: "unreadable-reset" });
      assert((await service.appendToHistory(workspaceId, boundary("fresh"))).success);
      expect(await currentBoundary()).toEqual({ kind: "identified", messageId: "fresh" });
    }
  );

  it("retains readable reset proof and recovers an interrupted archive rewrite before the view", async () => {
    const reset = createMuxMessage("reset", "assistant", "", { contextBoundaryKind: "reset" });
    await fs.writeFile(`${archivePath}.truncate`, line(reset));
    await fs.writeFile(archivePath, line(boundary("uncommitted")));
    await fs.writeFile(`${archivePath}.truncate.json`, "{");
    expect(await currentBoundary()).toEqual({ kind: "identified", messageId: "reset" });
    expect(await fs.readFile(archivePath, "utf8")).toBe(line(reset));
    expect(await fs.stat(`${archivePath}.truncate`).catch((error: unknown) => error)).toMatchObject(
      { code: "ENOENT" }
    );
  });

  it("rejects boundary evidence if the pathname changes during its verified scan", async () => {
    const stat = fs.stat;
    let changed = false;
    spyOn(fs, "stat").mockImplementation((async (...args: Parameters<typeof fs.stat>) => {
      if (args[0] === chatPath && !changed) {
        changed = true;
        await fs.appendFile(chatPath, '{"metadata":{"contextBoundaryKind" : "reset"},broken\n');
      }
      return stat(...args);
    }) as typeof fs.stat);
    expect(
      await readCompactionPendingHistoryBoundary({ chat: chatPath, archive: archivePath }).catch(
        (error: unknown) => error
      )
    ).toMatchObject({ message: "History changed during provider read" });
    expect(
      await readCompactionPendingHistoryBoundary({ chat: chatPath, archive: archivePath })
    ).toEqual({ kind: "unreadable-reset" });
  });

  it("fails before the pending callback if recovery cannot restore the archive", async () => {
    await fs.writeFile(`${archivePath}.truncate`, line(boundary("recoverable")));
    const rename = fs.rename;
    const failure = spyOn(fs, "rename").mockImplementation((from, to) => {
      if (from === `${archivePath}.truncate`)
        return Promise.reject(new Error("recovery unavailable"));
      return rename(from, to);
    });
    let entered = false;
    expect(
      await transaction()
        .withLock(() => {
          entered = true;
          return Promise.resolve();
        })
        .catch((error: unknown) => error)
    ).toMatchObject({ message: "recovery unavailable" });
    expect(entered).toBe(false);
    failure.mockRestore();
    expect(await currentBoundary()).toEqual({ kind: "identified", messageId: "recoverable" });
  });

  it.each([undefined, "{", "null", "{}", "[]"])(
    "malformed-only retirement distinguishes missing and invalid content (%s)",
    async (raw) => {
      if (raw !== undefined) await fs.writeFile(partialPath, raw);
      expect(await service.deletePartialIfMatches(workspaceId, null, () => true)).toEqual({
        success: true,
        data: raw !== undefined,
      });
      expect(await fs.stat(partialPath).catch((error: unknown) => error)).toMatchObject({
        code: "ENOENT",
      });
    }
  );

  it("malformed-only retirement preserves a valid successor after an unreadable observation", async () => {
    await fs.writeFile(partialPath, "{");
    expect(await service.readPartial(workspaceId)).toBeNull();
    assert(
      (await foreign.writePartial(workspaceId, createMuxMessage("next", "assistant", "Valid")))
        .success
    );
    const before = await fs.readFile(partialPath, "utf8");
    expect(await service.deletePartialIfMatches(workspaceId, null, () => true)).toEqual({
      success: true,
      data: false,
    });
    expect(await fs.readFile(partialPath, "utf8")).toBe(before);
  });

  it.each(
    (["logical", "physical", "queued successor"] as const).flatMap((scenario) =>
      [false, true].map((directory) => ({ scenario, directory }))
    )
  )(
    "malformed retirement preserves a successor after $scenario ownership changes (directory=$directory)",
    async ({ scenario, directory }) => {
      if (directory) await fs.mkdir(partialPath);
      else await fs.writeFile(partialPath, "{");
      const entered = Promise.withResolvers<void>();
      const release = Promise.withResolvers<void>();
      const readFile = fs.readFile;
      const held = spyOn(fs, "readFile").mockImplementation((async (
        ...args: Parameters<typeof fs.readFile>
      ) => {
        try {
          return await readFile(...args);
        } finally {
          if (args[0] === partialPath) {
            entered.resolve();
            await release.promise;
          }
        }
      }) as typeof fs.readFile);
      let current = true;
      const retiring = service.deletePartialIfMatches(workspaceId, null, () => current);
      let lease: Awaited<ReturnType<typeof reclaimHistoryLock>> | undefined;
      let queued: ReturnType<HistoryService["writePartial"]> | undefined;
      const successor = createMuxMessage("next", "assistant", "Valid successor");
      try {
        await entered.promise;
        held.mockRestore();
        if (scenario === "logical") current = false;
        if (scenario === "physical") {
          lease = await reclaimHistoryLock();
          // Another process owns the reclaimed lease and writes its new stream partial.
          if (directory) await fs.rmdir(partialPath);
          await fs.writeFile(partialPath, JSON.stringify(successor));
        }
        if (scenario === "queued successor") queued = foreign.writePartial(workspaceId, successor);
        release.resolve();
        const result = await retiring;
        if (scenario === "physical") expect(result.success).toBe(false);
        else expect(result).toEqual({ success: true, data: scenario === "queued successor" });
        if (queued) expect((await queued).success).toBe(true);
        if (scenario === "logical") {
          if (directory) expect((await fs.stat(partialPath)).isDirectory()).toBe(true);
          else expect(await fs.readFile(partialPath, "utf8")).toBe("{");
        } else expect((await capturedPartial()).id).toBe(successor.id);
      } finally {
        release.resolve();
        await retiring;
        await lease?.[Symbol.asyncDispose]();
        await queued;
      }
    }
  );

  it.each(["read", "unlink", "rmdir"] as const)(
    "malformed retirement reports %s permission failure and preserves bytes for retry",
    async (operation) => {
      if (operation === "rmdir") await fs.mkdir(partialPath);
      else await fs.writeFile(partialPath, "{");
      const error = Object.assign(new Error("Permission denied"), { code: "EACCES" });
      const readFile = fs.readFile;
      const failure =
        operation === "read"
          ? spyOn(fs, "readFile").mockImplementation((async (
              ...args: Parameters<typeof fs.readFile>
            ) => {
              if (args[0] === partialPath) throw error;
              return readFile(...args);
            }) as typeof fs.readFile)
          : spyOn(
              syncFs,
              operation === "rmdir" ? "rmdirSync" : "unlinkSync"
            ).mockImplementationOnce(() => {
              throw error;
            });
      const result = await service.deletePartialIfMatches(workspaceId, null, () => true);
      assert(!result.success);
      expect(result.error).toContain("Permission denied");
      failure.mockRestore();
      if (operation === "rmdir") expect((await fs.stat(partialPath)).isDirectory()).toBe(true);
      else expect(await fs.readFile(partialPath, "utf8")).toBe("{");
      expect(await service.deletePartialIfMatches(workspaceId, null, () => true)).toEqual({
        success: true,
        data: true,
      });
    }
  );

  it.each(["nonempty", "symlink", "captured message"] as const)(
    "directory retirement preserves %s ownership",
    async (scenario) => {
      const directoryPath = scenario === "symlink" ? `${partialPath}.target` : partialPath;
      await fs.mkdir(directoryPath);
      if (scenario === "nonempty") await fs.writeFile(path.join(directoryPath, "keep"), "Owned");
      if (scenario === "symlink") await fs.symlink(directoryPath, partialPath);
      const result = await service.deletePartialIfMatches(
        workspaceId,
        scenario === "captured message" ? createMuxMessage("old", "assistant", "Captured") : null,
        () => true
      );
      if (scenario === "captured message") expect(result).toEqual({ success: true, data: false });
      else expect(result.success).toBe(false);
      expect((await fs.stat(directoryPath)).isDirectory()).toBe(true);
      if (scenario === "nonempty")
        expect(await fs.readFile(path.join(directoryPath, "keep"), "utf8")).toBe("Owned");
      if (scenario === "symlink") expect(await fs.readlink(partialPath)).toBe(directoryPath);
    }
  );

  it.each(["successor", "same-id flush", "captured mutation", "owner retired", "missing"])(
    "partial retirement preserves mismatched ownership (%s)",
    async (scenario) => {
      const initial = createMuxMessage("partial", "assistant", "First flush");
      assert((await service.writePartial(workspaceId, initial)).success);
      const captured = await capturedPartial();
      if (scenario === "successor" || scenario === "same-id flush")
        assert(
          (
            await foreign.writePartial(
              workspaceId,
              createMuxMessage(
                scenario === "successor" ? "next" : initial.id,
                "assistant",
                "Later flush"
              )
            )
          ).success
        );
      if (scenario === "missing") assert((await service.deletePartial(workspaceId)).success);
      const before = await service.readPartial(workspaceId);
      const retiring = service.deletePartialIfMatches(
        workspaceId,
        captured,
        () => scenario !== "owner retired"
      );
      if (scenario === "captured mutation") captured.parts = [];
      expect(await retiring).toEqual({ success: true, data: scenario === "captured mutation" });
      expect(await service.readPartial(workspaceId)).toEqual(
        scenario === "captured mutation" ? null : before
      );
    }
  );

  it("rechecks partial ownership after reading and reports unlink failure without losing the capture", async () => {
    assert(
      (
        await service.writePartial(
          workspaceId,
          createMuxMessage("partial", "assistant", "Captured")
        )
      ).success
    );
    const captured = await capturedPartial();
    const entered = Promise.withResolvers<void>();
    const release = Promise.withResolvers<void>();
    const readFile = fs.readFile;
    spyOn(fs, "readFile").mockImplementation((async (...args: Parameters<typeof fs.readFile>) => {
      const result = await readFile(...args);
      if (args[0] === partialPath) {
        entered.resolve();
        await release.promise;
      }
      return result;
    }) as typeof fs.readFile);
    let current = true;
    const retiring = service.deletePartialIfMatches(workspaceId, captured, () => current);
    try {
      await entered.promise;
      current = false;
    } finally {
      release.resolve();
    }
    expect(await retiring).toEqual({ success: true, data: false });
    const failure = spyOn(syncFs, "unlinkSync").mockImplementationOnce(() => {
      throw new Error("disk unavailable");
    });
    expect((await service.deletePartialIfMatches(workspaceId, captured, () => true)).success).toBe(
      false
    );
    failure.mockRestore();
    expect(await capturedPartial()).toEqual(captured);
    expect(await service.deletePartialIfMatches(workspaceId, captured, () => true)).toEqual({
      success: true,
      data: true,
    });
    expect(await service.readPartial(workspaceId)).toBeNull();
  });

  it("a queued successor partial survives captured retirement", async () => {
    assert(
      (
        await service.writePartial(
          workspaceId,
          createMuxMessage("partial", "assistant", "Captured")
        )
      ).success
    );
    const captured = await capturedPartial();
    const entered = Promise.withResolvers<void>();
    const release = Promise.withResolvers<void>();
    const held = transaction().withLock(async () => {
      entered.resolve();
      await release.promise;
    });
    await entered.promise;
    const retiring = service.deletePartialIfMatches(workspaceId, captured, () => true);
    const successor = foreign.writePartial(
      workspaceId,
      createMuxMessage("successor", "assistant", "New stream")
    );
    try {
      release.resolve();
      expect(await retiring).toEqual({ success: true, data: true });
      expect((await successor).success).toBe(true);
      expect((await capturedPartial()).id).toBe("successor");
    } finally {
      release.resolve();
      await Promise.all([held, retiring, successor]);
    }
  });

  it.each(["exact", "missing", "replacement", "archived", "failure", "retired"] as const)(
    "pending restoration requires exact heartbeat cleanup evidence (%s)",
    async (scenario) => {
      const { pending, summary, receipt, publication } = await preparedHeartbeat();
      if (scenario === "missing") {
        // Another owner completed the exact rollback; absence gives this caller no receipt.
        // Generic deletion now advances the generation and would mask this stricter case.
        assert(
          (
            await foreign.cleanupCompactionFollowUp(
              workspaceId,
              summary,
              "rollback-heartbeat",
              () => true
            )
          ).success
        );
      }
      if (scenario === "replacement")
        assert(
          (
            await foreign.updateHistory(workspaceId, {
              ...summary,
              metadata: {
                ...summary.metadata,
                muxMetadata: {
                  type: "compaction-summary",
                  pendingFollowUp: { text: "New owner", model: "openai:gpt-4o", agentId: "exec" },
                },
              },
            })
          ).success
        );
      if (scenario === "archived")
        assert((await foreign.appendToHistory(workspaceId, boundary("newer"))).success);
      const before = await foreign.getLastMessages(workspaceId, 10);
      assert(before.success);
      if (scenario === "failure")
        spyOn(syncFs, "renameSync").mockImplementationOnce(() => {
          throw new Error("publication failed");
        });
      let committed = false;
      const cleanup = await service.cleanupCompactionFollowUp(
        workspaceId,
        summary,
        "rollback-heartbeat",
        () => scenario !== "retired",
        () => {
          committed = true;
          return undefined;
        }
      );
      expect(cleanup).toMatchObject(
        scenario === "failure"
          ? { success: false }
          : { success: true, data: scenario === "exact" ? "applied" : "skipped" }
      );
      expect(committed).toBe(scenario === "exact");
      // A missing row with an unchanged generation still grants no rollback authority.
      expect(await service.getContinuousCompactionJournal(workspaceId).captureGeneration()).toBe(
        publication.generation
      );
      await pending.rollback(receipt, () => committed);
      expect((await pending.load(() => true))?.attachments.readFiles).toEqual(
        scenario === "exact"
          ? ["/previous.ts"]
          : scenario === "missing" || scenario === "archived"
            ? undefined
            : ["/heartbeat.ts"]
      );
      const after = await foreign.getLastMessages(workspaceId, 10);
      assert(after.success);
      expect(after.data).toEqual(
        scenario === "exact" ? before.data.filter((row) => row.id !== summary.id) : before.data
      );
    }
  );

  it("publishes rollback evidence synchronously before lock disposal admits a replacement", async () => {
    const { pending, summary, receipt } = await preparedHeartbeat();
    const disposing = Promise.withResolvers<void>();
    const release = Promise.withResolvers<void>();
    let committed = false;
    let committedAtDisposal = false;
    const acquire = fileLock.acquireProcessFileLock;
    spyOn(fileLock, "acquireProcessFileLock").mockImplementationOnce(async (options) => {
      const lock = await acquire(options);
      return {
        assertStillOwned: () => lock.assertStillOwned(),
        [Symbol.asyncDispose]: async () => {
          committedAtDisposal = committed;
          disposing.resolve();
          await release.promise;
          await lock[Symbol.asyncDispose]();
        },
      };
    });
    const cleanup = service.cleanupCompactionFollowUp(
      workspaceId,
      summary,
      "rollback-heartbeat",
      () => true,
      () => {
        committed = true;
        return undefined;
      }
    );
    let successor: Promise<unknown> | undefined;
    try {
      await disposing.promise;
      expect(committedAtDisposal).toBe(true);
      expect(syncFs.readFileSync(chatPath, "utf8").trim()).toBe("");
      successor = foreign.appendToHistory(workspaceId, boundary("replacement"));
      release.resolve();
      expect(await cleanup).toEqual({ success: true, data: "applied" });
      await successor;
      // Positive deletion evidence cannot override a newer durable boundary.
      await pending.rollback(receipt, () => committed);
      expect(await pending.load(() => true)).toBeUndefined();
      const rows = await foreign.getHistoryFromLatestBoundary(workspaceId);
      assert(rows.success);
      expect(rows.data.map((row) => row.id)).toEqual(["replacement"]);
    } finally {
      release.resolve();
      await Promise.all([cleanup, successor]);
    }
  });

  it.each(["rollback", "restart"])(
    "does not restore untagged legacy context across a later unreadable reset (%s)",
    async (operation) => {
      const { pending, summary, receipt } = await preparedHeartbeat();
      let committed = false;
      assert(
        (
          await service.cleanupCompactionFollowUp(
            workspaceId,
            summary,
            "rollback-heartbeat",
            () => true,
            () => {
              committed = true;
              return undefined;
            }
          )
        ).success
      );
      // A malformed reset is still a privacy floor even though it provides no usable ID.
      await foreign
        .getCompactionPendingHistory(workspaceId)
        .withLock(() =>
          fs.appendFile(chatPath, '{"metadata":{"contextBoundaryKind" : "reset"},broken\n')
        );
      if (operation === "rollback") await pending.rollback(receipt, () => committed);
      const restarted = new CompactionPendingState(
        path.join(path.dirname(chatPath), "post-compaction.json"),
        foreign.getCompactionPendingHistory(workspaceId)
      );
      expect(await restarted.load(() => true)).toBeUndefined();
    }
  );

  it.each(["chat", "archive"] as const)(
    "suppresses untagged legacy loads at a raw %s reset but permits a fresh compaction",
    async (artifact) => {
      const pendingPath = path.join(path.dirname(chatPath), "post-compaction.json");
      await fs.writeFile(
        pendingPath,
        JSON.stringify({
          version: 1,
          createdAt: 1,
          diffs: [],
          loadedSkills: [],
          readFiles: ["/private.ts"],
        })
      );
      await fs.appendFile(
        artifact === "chat" ? chatPath : archivePath,
        '{"metadata":{"contextBoundaryKind" : "reset"},broken\n'
      );
      const pending = new CompactionPendingState(pendingPath, transaction());
      expect(await pending.load(() => true)).toBeUndefined();
      const publication = {
        generation: await service.getContinuousCompactionJournal(workspaceId).captureGeneration(),
      };
      assert(
        await pending.prepare({
          attachments: { diffs: [], loadedSkills: [], readFiles: ["/fresh.ts"] },
          boundaryMessageId: "fresh",
          publication,
          isCurrent: () => true,
        })
      );
      // The raw floor must not become a legacy fallback if this fresh preparation fails.
      expect(JSON.parse(await fs.readFile(pendingPath, "utf8"))).not.toHaveProperty(
        "previousState"
      );
      assert(
        (
          await service.persistBoundaryWithTailCopies(
            workspaceId,
            boundary("fresh"),
            [],
            false,
            () => true,
            { publication, onCommitted: () => undefined }
          )
        ).success
      );
      expect((await pending.load(() => true))?.attachments.readFiles).toEqual(["/fresh.ts"]);
    }
  );

  it("rejects a tagged head after a generation change even when its boundary ID is unchanged", async () => {
    const { pending, summary } = await preparedHeartbeat();
    expect((await pending.load(() => true))?.attachments.readFiles).toEqual(["/heartbeat.ts"]);
    await foreign.getContinuousCompactionJournal(workspaceId).advanceGeneration();
    expect(await currentBoundary()).toEqual({ kind: "identified", messageId: summary.id });
    const restarted = new CompactionPendingState(
      path.join(path.dirname(chatPath), "post-compaction.json"),
      foreign.getCompactionPendingHistory(workspaceId)
    );
    expect(await restarted.load(() => true)).toBeUndefined();
  });

  it.each([false, true])(
    "legacy state needs proven absence and no newer generation (changed=%s)",
    async (changed) => {
      await fs.writeFile(archivePath, line(createMuxMessage("older", "user", "Earlier context")));
      const pendingPath = path.join(path.dirname(chatPath), "post-compaction.json");
      await fs.writeFile(
        pendingPath,
        JSON.stringify({
          version: 1,
          createdAt: 1,
          diffs: [],
          loadedSkills: [],
          readFiles: ["/legacy.ts"],
        })
      );
      if (changed) await foreign.getContinuousCompactionJournal(workspaceId).advanceGeneration();
      expect(await currentBoundary()).toEqual({ kind: "none" });
      const pending = new CompactionPendingState(pendingPath, transaction());
      expect((await pending.load(() => true))?.attachments.readFiles).toEqual(
        changed ? undefined : ["/legacy.ts"]
      );
    }
  );

  it.each([false, true])(
    "guarded empty-tail publication notifies before cleanup (update=%s)",
    async (update) => {
      const summary = boundary("summary");
      if (update)
        assert(
          (
            await service.appendToHistory(
              workspaceId,
              createMuxMessage(summary.id, "assistant", "Streaming")
            )
          ).success
        );
      if (update) summary.metadata = { ...summary.metadata, historySequence: 1 };
      const journal = service.getContinuousCompactionJournal(workspaceId);
      const publication = { generation: await journal.captureGeneration() };
      let committed = false;
      let cleanupObserved = false;
      const rm = syncFs.promises.rm;
      spyOn(syncFs.promises, "rm").mockImplementation(async (file, options) => {
        if (String(file).startsWith(`${chatPath}.continuous-`)) {
          expect(committed).toBe(true);
          cleanupObserved = true;
          expect(syncFs.readFileSync(chatPath, "utf8")).toContain('"compactionBoundary":true');
        }
        return rm(file, options);
      });
      expect(
        (
          await service.persistBoundaryWithTailCopies(
            workspaceId,
            summary,
            [],
            update,
            () => true,
            {
              publication,
              onCommitted: () => {
                committed = true;
              },
            }
          )
        ).success
      ).toBe(true);
      expect(cleanupObserved).toBe(true);
      const rows = await foreign.getHistoryFromLatestBoundary(workspaceId);
      assert(rows.success);
      expect(rows.data.map((row) => row.id)).toEqual([summary.id]);
      await journal.advanceGeneration();
      const before = await fs.readFile(chatPath, "utf8");
      let staleCommitted = false;
      expect(
        (
          await service.persistBoundaryWithTailCopies(
            workspaceId,
            boundary("stale"),
            [],
            false,
            () => true,
            {
              publication,
              onCommitted: () => {
                staleCommitted = true;
              },
            }
          )
        ).success
      ).toBe(false);
      expect(staleCommitted).toBe(false);
      expect(await fs.readFile(chatPath, "utf8")).toBe(before);
    }
  );
  it.each([
    {
      name: "rollbackable suffix",
      metadata: {
        type: "compaction-summary",
        pendingFollowUp: { text: "Resume", model: "model", agentId: "exec" },
      },
      expected: ["C", "B", "A"],
    },
    { name: "cleared follow-up", metadata: { type: "compaction-summary" }, expected: ["C", "B"] },
    { name: "future metadata", metadata: { type: "future-summary" }, expected: undefined },
    {
      name: "malformed follow-up",
      metadata: { type: "compaction-summary", pendingFollowUp: null },
      expected: undefined,
    },
    {
      name: "incomplete follow-up",
      metadata: { type: "compaction-summary", pendingFollowUp: {} },
      expected: undefined,
    },
  ])("bounds retention only with proven $name history", async ({ metadata, expected }) => {
    const heartbeat = (id: string) =>
      createMuxMessage(id, "assistant", id, {
        compacted: "heartbeat",
        compactionBoundary: true,
        compactionEpoch: 1,
        muxMetadata: {
          type: "compaction-summary",
          pendingFollowUp: { text: "Resume", model: "model", agentId: "exec" },
        },
      });
    const b = heartbeat("B");
    await fs.writeFile(archivePath, line(boundary("A")));
    // Raw fixtures deliberately include future/invalid metadata that the history projection preserves.
    await fs.writeFile(
      chatPath,
      JSON.stringify({ ...b, metadata: { ...b.metadata, muxMetadata: metadata } }) +
        "\n" +
        line(heartbeat("C"))
    );
    await transaction().withLock(async (view) => {
      await view.assertStillOwned();
      expect(view.boundary).toEqual({ kind: "identified", messageId: "C" });
      expect(view.reachableBoundaryIds && [...view.reachableBoundaryIds]).toEqual(
        expected && [...expected]
      );
    });
  });

  it("does not prune through duplicate active boundary identities", async () => {
    await fs.writeFile(chatPath, line(boundary("A")) + line(boundary("A")));
    await transaction().withLock(async (view) => {
      await view.assertStillOwned();
      expect(view.reachableBoundaryIds).toBeUndefined();
    });
  });
  it("bounds the rollback horizon at a verified archived raw reset floor", async () => {
    const heartbeat = createMuxMessage("C", "assistant", "C", {
      compacted: "heartbeat",
      compactionBoundary: true,
      compactionEpoch: 1,
      muxMetadata: {
        type: "compaction-summary",
        pendingFollowUp: { text: "Resume", model: "model", agentId: "exec" },
      },
    });
    await fs.writeFile(
      archivePath,
      line(boundary("A")) + '{"metadata":{"contextBoundaryKind":"reset"},broken\n'
    );
    await fs.writeFile(chatPath, line(heartbeat));
    await transaction().withLock(async (view) => {
      await view.assertStillOwned();
      expect(view.boundary).toEqual({ kind: "identified", messageId: "C" });
      expect(view.reachableBoundaryIds && [...view.reachableBoundaryIds]).toEqual(["C"]);
    });
  });
});

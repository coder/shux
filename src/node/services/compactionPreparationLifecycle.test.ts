import { afterEach, beforeEach, describe, expect, it, mock, spyOn } from "bun:test";
import assert from "node:assert/strict";
import * as syncFs from "node:fs";
import * as fs from "node:fs/promises";
import * as path from "node:path";
import * as atomicWrite from "write-file-atomic";
import { createMuxMessage } from "@/common/types/message";
import { CompactionPendingState } from "./compactionPendingState";
import { CompactionPreparationLifecycle } from "./compactionPreparationLifecycle";
import { HistoryService } from "./historyService";
import { createTestHistoryService } from "./testHistoryService";

type BoundaryInput = Parameters<CompactionPreparationLifecycle["publish"]>[1];

describe("inactive local compaction preparation lifecycle", () => {
  const workspaceId = "local-preparation";
  let h: Awaited<ReturnType<typeof createTestHistoryService>>;
  let pendingPath: string;
  let store: CompactionPendingState;
  let lifecycle: CompactionPreparationLifecycle;

  function restart() {
    return new CompactionPendingState(
      pendingPath,
      new HistoryService(h.config).getCompactionPendingHistory(workspaceId)
    );
  }

  async function input(name: string, heartbeat = false): Promise<BoundaryInput> {
    return {
      attachments: {
        diffs: [{ path: `/${name}.ts`, diff: `+${name}`, truncated: false }],
        loadedSkills: [],
        readFiles: [`/${name}.ts`],
      },
      summaryMessage: createMuxMessage(name, "assistant", name, {
        compacted: heartbeat ? "heartbeat" : "user",
        compactionBoundary: true,
        compactionEpoch: 1,
        ...(heartbeat && {
          muxMetadata: {
            type: "compaction-summary",
            pendingFollowUp: { text: "Resume", model: "openai:gpt-4o", agentId: "exec" },
          },
        }),
      }),
      tailCopies: [],
      updateExisting: false,
      publication: {
        generation: await h.historyService
          .getContinuousCompactionJournal(workspaceId)
          .captureGeneration(),
      },
      shouldPersist: () => true,
    };
  }

  async function publish(name: string, heartbeat = false, target = lifecycle, accepted = true) {
    const preparation = target.begin(() => true);
    const prepared = await input(name, heartbeat);
    prepared.shouldPersist = () => accepted;
    return target.publish(preparation, prepared);
  }

  const bytes = () => fs.readFile(pendingPath, "utf8");
  async function historyIds() {
    const result = await h.historyService.getHistoryFromLatestBoundary(workspaceId);
    assert(result.success);
    return result.data.map((row) => row.id);
  }

  beforeEach(async () => {
    h = await createTestHistoryService();
    pendingPath = path.join(h.config.sessionsDir, workspaceId, "post-compaction.json");
    assert(
      (
        await h.historyService.appendToHistory(
          workspaceId,
          createMuxMessage("seed", "user", "Context")
        )
      ).success
    );
    store = new CompactionPendingState(
      pendingPath,
      h.historyService.getCompactionPendingHistory(workspaceId)
    );
    lifecycle = new CompactionPreparationLifecycle(store);
  });

  afterEach(async () => {
    mock.restore();
    await h.cleanup();
  });

  it("avoids history scans for absent state and observes a later foreign publication", async () => {
    const adapter = h.historyService.getCompactionPendingHistory(workspaceId);
    const locked = spyOn(adapter, "withLock");
    const target = new CompactionPreparationLifecycle(
      new CompactionPendingState(pendingPath, adapter)
    );
    expect(await target.capture("pending")).toBeUndefined();
    expect(await target.capture("carryover")).toBeUndefined();
    expect(locked).not.toHaveBeenCalled();
    assert((await publish("A", false, new CompactionPreparationLifecycle(restart()))).success);
    const delivered = await target.capture("pending");
    assert(delivered);
    expect(delivered.readFiles).toEqual(["/A.ts"]);
    expect(locked).toHaveBeenCalledTimes(1);
    await target.consume(delivered, "ack");
    const beforeWarmth = locked.mock.calls.length;
    expect((await target.capture("carryover"))?.readFiles).toEqual(["/A.ts"]);
    expect(locked.mock.calls.length).toBe(beforeWarmth + 1);
  });

  it.each(["error", "directory"] as const)(
    "qualifies ambiguous sidecar presence through history (%s)",
    async (presence) => {
      const adapter = h.historyService.getCompactionPendingHistory(workspaceId);
      const locked = spyOn(adapter, "withLock");
      const target = new CompactionPreparationLifecycle(
        new CompactionPendingState(pendingPath, adapter)
      );
      if (presence === "directory") await fs.mkdir(pendingPath);
      else {
        const stat = fs.stat;
        spyOn(fs, "stat").mockImplementation((async (...args: Parameters<typeof fs.stat>) => {
          if (args[0] === pendingPath)
            throw Object.assign(new Error("Probe unavailable"), { code: "EACCES" });
          return stat(...args);
        }) as typeof fs.stat);
      }
      expect(await target.capture("pending")).toBeUndefined();
      expect(locked).toHaveBeenCalledTimes(1);
    }
  );

  it("qualifies a local history-only token even when its pending file is absent", async () => {
    const adapter = h.historyService.getCompactionPendingHistory(workspaceId);
    const locked = spyOn(adapter, "withLock");
    const target = new CompactionPreparationLifecycle(
      new CompactionPendingState(pendingPath, adapter)
    );
    const rename = syncFs.renameSync;
    spyOn(syncFs, "renameSync").mockImplementation((from, to) => {
      if (to === pendingPath) throw new Error("Optional write unavailable");
      rename(from, to);
    });
    assert((await publish("B", true, target)).success);
    const beforeCapture = locked.mock.calls.length;
    expect((await target.capture("pending"))?.readFiles).toEqual([]);
    expect(locked.mock.calls.length).toBe(beforeCapture + 1);
  });

  it("claims preparation before awaits, rejects superseded/reused handles, and does not revive them", async () => {
    const a = lifecycle.begin(() => true);
    const b = lifecycle.begin(() => true);
    const prepared = await input("B");
    prepared.shouldPersist = () => false;
    expect(a.isCurrent()).toBe(false);
    expect((await lifecycle.publish(a, await input("A"))).success).toBe(false);
    expect((await lifecycle.publish(b, prepared)).success).toBe(false);
    expect(a.isCurrent()).toBe(false);
    expect(b.isCurrent()).toBe(false);
    expect((await lifecycle.publish(b, await input("B"))).success).toBe(false);
    expect((await lifecycle.publish({ isCurrent: () => true }, await input("fake"))).success).toBe(
      false
    );
    expect(await historyIds()).toEqual(["seed"]);
    expect(await lifecycle.capture("pending")).toBeUndefined();
  });

  it("captures rows and attachments before queued I/O without mutating caller snapshots", async () => {
    const prepared = await input("A");
    prepared.tailCopies = [createMuxMessage("tail", "user", "Tail")];
    const operation = lifecycle.publish(
      lifecycle.begin(() => true),
      prepared
    );
    prepared.attachments.readFiles.push("/changed.ts");
    prepared.summaryMessage.parts = [{ type: "text", text: "Changed" }];
    prepared.tailCopies[0].parts = [{ type: "text", text: "Changed tail" }];
    const result = await operation;
    assert(result.success);
    expect(result.data.summaryMessage.parts).toMatchObject([{ type: "text", text: "A" }]);
    expect(result.data.tailCopies[0].parts).toMatchObject([{ type: "text", text: "Tail" }]);
    expect(result.data.summaryMessage.metadata?.historySequence).toBe(1);
    expect(result.data.tailCopies[0].metadata?.historySequence).toBe(2);
    expect(prepared.summaryMessage.metadata?.historySequence).toBeUndefined();
    expect(prepared.tailCopies[0].metadata?.historySequence).toBeUndefined();
    const snapshot = await lifecycle.capture("pending");
    assert(snapshot);
    snapshot.readFiles.push("/mutated-capture.ts");
    expect((await lifecycle.capture("pending"))?.readFiles).toEqual(["/A.ts"]);
    expect((await restart().load(() => true))?.attachments.readFiles).toEqual(["/A.ts"]);
  });

  it.each(["before", "after"] as const)(
    "retains committed A when its promise returns %s B fails",
    async (order) => {
      const entered = Promise.withResolvers<void>();
      const release = Promise.withResolvers<void>();
      const atomic = store.publishBoundary.bind(store);
      spyOn(store, "publishBoundary").mockImplementationOnce(async (request) => {
        const result = await atomic(request);
        entered.resolve();
        await release.promise;
        return result;
      });
      const a = publish("A", true);
      try {
        await entered.promise;
        expect(await historyIds()).toEqual(["A"]);
        if (order === "before") {
          release.resolve();
          expect((await a).success).toBe(true);
        }
        expect((await publish("B", true, lifecycle, false)).success).toBe(false);
        expect((await lifecycle.capture("pending"))?.readFiles).toEqual(["/A.ts"]);
        release.resolve();
        expect((await a).success).toBe(true);
        expect((await lifecycle.capture("pending"))?.readFiles).toEqual(["/A.ts"]);
        expect((await restart().load(() => true))?.attachments.readFiles).toEqual(["/A.ts"]);
      } finally {
        release.resolve();
        await a;
      }
    }
  );

  it("never revives A after its exact history rollback commits but returns late", async () => {
    await publish("prior");
    const a = await publish("A", true);
    assert(a.success);
    const entered = Promise.withResolvers<void>();
    const release = Promise.withResolvers<void>();
    const cleanup = h.historyService.cleanupCompactionFollowUp.bind(h.historyService);
    spyOn(h.historyService, "cleanupCompactionFollowUp").mockImplementationOnce(async (...args) => {
      const result = await cleanup(...args);
      entered.resolve();
      await release.promise;
      return result;
    });
    const rollback = lifecycle.rollbackHeartbeat(a.data.summaryMessage, () => true);
    try {
      await entered.promise;
      expect(await historyIds()).toEqual(["prior"]);
      expect((await publish("B", true, lifecycle, false)).success).toBe(false);
      expect((await lifecycle.capture("pending"))?.readFiles).toEqual(["/prior.ts"]);
      release.resolve();
      expect((await rollback).success).toBe(true);
      expect((await lifecycle.capture("pending"))?.readFiles).toEqual(["/prior.ts"]);
    } finally {
      release.resolve();
      await rollback;
    }
  });

  it("does not restore unpublished A when a superseding B also fails", async () => {
    const bInput = { ...(await input("B")), shouldPersist: () => false };
    const entered = Promise.withResolvers<void>();
    const release = Promise.withResolvers<void>();
    const remove = syncFs.promises.rm;
    let paused = false;
    spyOn(syncFs.promises, "rm").mockImplementation(async (file, options) => {
      if (String(file).startsWith(`${pendingPath}.continuous-`) && !paused) {
        paused = true;
        entered.resolve();
        await release.promise;
      }
      return remove(file, options);
    });
    const a = publish("A");
    let b: ReturnType<typeof publish> | undefined;
    try {
      await entered.promise;
      expect(JSON.parse(await bytes())).toMatchObject({ boundaryMessageId: "A" });
      const bPreparation = lifecycle.begin(() => true);
      b = lifecycle.publish(bPreparation, bInput);
      release.resolve();
      expect((await a).success).toBe(false);
      expect((await b).success).toBe(false);
      expect(await lifecycle.capture("pending")).toBeUndefined();
      expect(await restart().load(() => true)).toBeUndefined();
      expect(await historyIds()).toEqual(["seed"]);
    } finally {
      release.resolve();
      await a;
      await b;
    }
  });

  it.each(["ack", "discard"] as const)(
    "consumed A stays retired after provisional B commits and rolls back (%s)",
    async (disposition) => {
      await publish("A");
      const snapshot = await lifecycle.capture("pending");
      assert(snapshot);
      const entered = Promise.withResolvers<void>();
      const release = Promise.withResolvers<void>();
      const remove = syncFs.promises.rm;
      let paused = false;
      spyOn(syncFs.promises, "rm").mockImplementation(async (file, options) => {
        if (String(file).startsWith(`${pendingPath}.continuous-`) && !paused) {
          paused = true;
          entered.resolve();
          await release.promise;
        }
        return remove(file, options);
      });
      const b = publish("B", true);
      let consuming: Promise<void> | undefined;
      try {
        await entered.promise;
        consuming = lifecycle.consume(snapshot, disposition);
        release.resolve();
        const result = await b;
        assert(result.success);
        await consuming;
        expect((await lifecycle.capture("pending"))?.readFiles).toEqual(["/B.ts"]);
        expect(
          (await lifecycle.rollbackHeartbeat(result.data.summaryMessage, () => true)).success
        ).toBe(true);
        expect(await lifecycle.capture("pending")).toBeUndefined();
        expect((await lifecycle.capture("carryover"))?.readFiles).toEqual(
          disposition === "ack" ? ["/A.ts"] : undefined
        );
        expect(await restart().load(() => true)).toBeUndefined();
      } finally {
        release.resolve();
        await b;
        await consuming;
      }
    }
  );

  it.each(["ack", "discard"] as const)(
    "old request %s preserves the published successor",
    async (disposition) => {
      await publish("A");
      const snapshot = await lifecycle.capture("pending");
      assert(snapshot);
      await publish("B");
      await lifecycle.consume(snapshot, disposition);
      expect((await lifecycle.capture("pending"))?.readFiles).toEqual(["/B.ts"]);
      expect((await restart().load(() => true))?.attachments.readFiles).toEqual(["/B.ts"]);
    }
  );

  it.each(["none", "before", "during"] as const)(
    "captures surviving A authority when B's enrichment fails (C=%s)",
    async (successor) => {
      await publish("A");
      const aBytes = await bytes();
      const rename = syncFs.renameSync;
      const failure = spyOn(syncFs, "renameSync").mockImplementation((from, to) => {
        if (to === pendingPath) throw new Error("Optional write failed");
        rename(from, to);
      });
      const b = await publish("B", true);
      assert(b.success);
      failure.mockRestore();
      expect(await bytes()).toBe(aBytes);
      const snapshot = await lifecycle.capture("pending");
      assert(snapshot);
      expect(snapshot).toEqual({ diffs: [], loadedSkills: [], readFiles: [] });
      if (successor === "before") await publish("C");
      const consuming = lifecycle.consume(snapshot, "discard");
      if (successor === "during") await publish("C");
      await consuming;
      expect((await lifecycle.capture("pending"))?.readFiles).toEqual(
        successor === "none" ? undefined : ["/C.ts"]
      );
      expect((await restart().load(() => true))?.attachments.readFiles).toEqual(
        successor === "none" ? undefined : ["/C.ts"]
      );
      if (successor === "none")
        expect(await fs.stat(pendingPath).catch((error: unknown) => error)).toMatchObject({
          code: "ENOENT",
        });
    }
  );

  it.each([false, true])(
    "retires surviving A after two failed enrichments and rollback (failed unlink=%s)",
    async (failUnlink) => {
      await publish("A");
      const rename = syncFs.renameSync;
      const failure = spyOn(syncFs, "renameSync").mockImplementation((from, to) => {
        if (to === pendingPath) throw new Error("Optional write failed");
        rename(from, to);
      });
      // Best-effort archive rotation may fail after commit. Keep both heartbeat rows active
      // so this exercises two applied rollbacks, not cleanup skipping an archived B.
      const open = fs.open;
      const rotation = spyOn(fs, "open").mockImplementation(async (file, flags, mode) => {
        if (String(file).endsWith("chat-archive.jsonl") && flags === "a+")
          throw new Error("Archive rotation unavailable");
        return open(file, flags, mode);
      });
      const b = await publish("B", true);
      assert(b.success);
      const c = await publish("C", true);
      assert(c.success);
      failure.mockRestore();
      expect(await lifecycle.rollbackHeartbeat(c.data.summaryMessage, () => true)).toMatchObject({
        success: true,
        data: { outcome: "applied" },
      });
      const snapshot = await lifecycle.capture("pending");
      assert(snapshot);
      expect(snapshot).toEqual({ diffs: [], loadedSkills: [], readFiles: [] });
      const remove = fs.unlink;
      const unlink = spyOn(fs, "unlink").mockImplementation(async (file) => {
        if (failUnlink && file === pendingPath) throw new Error("Cleanup unavailable");
        await remove(file);
      });
      await lifecycle.consume(snapshot, "discard");
      unlink.mockRestore();
      expect(await lifecycle.rollbackHeartbeat(b.data.summaryMessage, () => true)).toMatchObject({
        success: true,
        data: { outcome: "applied" },
      });
      rotation.mockRestore();
      expect(await lifecycle.capture("pending")).toBeUndefined();
      expect(await lifecycle.capture("carryover")).toBeUndefined();
      expect(
        await new CompactionPreparationLifecycle(restart()).capture("pending")
      ).toBeUndefined();
    }
  );

  it.each([
    { disposition: "ack", acknowledgePrevious: false },
    { disposition: "discard", acknowledgePrevious: false },
    { disposition: "discard", acknowledgePrevious: true },
  ] as const)(
    "does not restore B's fallback after target consumption with failed unlink (%j)",
    async ({ disposition, acknowledgePrevious }) => {
      await publish("A");
      if (acknowledgePrevious) {
        const a = await lifecycle.capture("pending");
        assert(a);
        await lifecycle.consume(a, "ack");
      }
      const b = await publish("B", true);
      assert(b.success);
      const snapshot = await lifecycle.capture("pending");
      assert(snapshot);
      expect(snapshot.readFiles).toEqual(["/B.ts"]);
      const before = await bytes();
      const remove = fs.unlink;
      const unlink = spyOn(fs, "unlink").mockImplementation(async (file) => {
        if (file === pendingPath) throw new Error("Cleanup unavailable");
        await remove(file);
      });
      await lifecycle.consume(snapshot, disposition);
      unlink.mockRestore();
      expect(await bytes()).toBe(before);
      expect(await lifecycle.rollbackHeartbeat(b.data.summaryMessage, () => true)).toMatchObject({
        success: true,
        data: { outcome: "applied" },
      });
      expect(await lifecycle.capture("pending")).toBeUndefined();
      // B's retirement must not discard unrelated A warmth that was already acknowledged.
      expect((await lifecycle.capture("carryover"))?.readFiles).toEqual(
        acknowledgePrevious ? ["/A.ts"] : undefined
      );
      expect(
        await new CompactionPreparationLifecycle(restart()).capture("pending")
      ).toBeUndefined();
    }
  );

  it("keeps future data inert and byte-preserved through publication, consumption and reset", async () => {
    await publish("A");
    const future = '{"version":9,"payload":"future"}\n';
    await fs.writeFile(pendingPath, future);
    expect((await publish("B")).success).toBe(true);
    const snapshot = await lifecycle.capture("pending");
    assert(snapshot);
    expect(snapshot.readFiles).toEqual([]);
    await lifecycle.consume(snapshot, "discard");
    expect(await bytes()).toBe(future);
    assert((await new HistoryService(h.config).clearHistory(workspaceId)).success);
    await lifecycle.discardAfterBoundary();
    expect(await bytes()).toBe(future);
    expect(await lifecycle.capture("pending")).toBeUndefined();
    expect(await lifecycle.capture("carryover")).toBeUndefined();
  });

  it("qualifies acknowledged carryover against a foreign reset on every capture", async () => {
    await publish("A");
    const snapshot = await lifecycle.capture("pending");
    assert(snapshot);
    await lifecycle.consume(snapshot, "ack");
    expect((await lifecycle.capture("carryover"))?.readFiles).toEqual(["/A.ts"]);
    expect((await lifecycle.capture("carryover"))?.diffs).toEqual([]);
    assert((await new HistoryService(h.config).clearHistory(workspaceId)).success);
    expect(await lifecycle.capture("carryover")).toBeUndefined();
    expect(await lifecycle.capture("pending")).toBeUndefined();
  });

  it.each(["published", "history-only"] as const)(
    "replaces acknowledged A warmth after a foreign same-generation B (%s)",
    async (enrichment) => {
      assert((await publish("A")).success);
      const a = await lifecycle.capture("pending");
      assert(a);
      await lifecycle.consume(a, "ack");
      expect((await lifecycle.capture("carryover"))?.readFiles).toEqual(["/A.ts"]);
      const journal = h.historyService.getContinuousCompactionJournal(workspaceId);
      const generation = await journal.captureGeneration();
      const rename = syncFs.renameSync;
      const failure = spyOn(syncFs, "renameSync").mockImplementation((from, to) => {
        if (enrichment === "history-only" && to === pendingPath)
          throw new Error("Optional enrichment unavailable");
        rename(from, to);
      });
      const foreign = new CompactionPreparationLifecycle(restart());
      assert((await publish("B", false, foreign)).success);
      failure.mockRestore();
      expect(await historyIds()).toEqual(["B"]);
      expect(await journal.captureGeneration()).toBe(generation);
      const before = await bytes().catch(() => undefined);
      expect((await lifecycle.capture("carryover"))?.readFiles).toEqual(
        enrichment === "published" ? ["/B.ts"] : undefined
      );
      expect((await lifecycle.capture("pending"))?.readFiles).toEqual(
        enrichment === "published" ? ["/B.ts"] : undefined
      );
      expect(await bytes().catch(() => undefined)).toBe(before);
    }
  );

  it("fences a delayed initial load when reset clears memory before cleanup awaits", async () => {
    await publish("A");
    const restarted = new CompactionPreparationLifecycle(store);
    const entered = Promise.withResolvers<void>();
    const release = Promise.withResolvers<void>();
    const load = store.observe.bind(store);
    spyOn(store, "observe").mockImplementationOnce(async (...args) => {
      const result = await load(...args);
      entered.resolve();
      await release.promise;
      return result;
    });
    const capturing = restarted.capture("pending");
    try {
      await entered.promise;
      assert((await new HistoryService(h.config).clearHistory(workspaceId)).success);
      await restarted.discardAfterBoundary();
      release.resolve();
      expect(await capturing).toBeUndefined();
      expect(await restarted.capture("pending")).toBeUndefined();
    } finally {
      release.resolve();
      await capturing;
    }
  });

  it("restores a restart heartbeat through the store's exact receipt", async () => {
    await publish("A");
    const b = await publish("B", true);
    assert(b.success);
    const restarted = new CompactionPreparationLifecycle(restart());
    expect((await restarted.rollbackHeartbeat(b.data.summaryMessage, () => true)).success).toBe(
      true
    );
    expect((await restarted.capture("pending"))?.readFiles).toEqual(["/A.ts"]);
  });

  it("retains consumption facts when a foreign heartbeat restores a known predecessor", async () => {
    await publish("A");
    const a = await lifecycle.capture("pending");
    assert(a);
    const foreign = new CompactionPreparationLifecycle(restart());
    const b = await publish("B", true, foreign);
    assert(b.success);
    expect((await lifecycle.capture("pending"))?.readFiles).toEqual(["/B.ts"]);
    expect((await lifecycle.rollbackHeartbeat(b.data.summaryMessage, () => true)).success).toBe(
      true
    );
    expect((await lifecycle.capture("pending"))?.readFiles).toEqual(["/A.ts"]);
    const before = await bytes();
    const remove = fs.unlink;
    const unlink = spyOn(fs, "unlink").mockImplementation(async (file) => {
      if (file === pendingPath) throw new Error("Cleanup unavailable");
      await remove(file);
    });
    await lifecycle.consume(a, "discard");
    unlink.mockRestore();
    expect(await bytes()).toBe(before);
    expect(await lifecycle.capture("pending")).toBeUndefined();
    expect(await lifecycle.capture("carryover")).toBeUndefined();
  });

  it("requires pending proof for unacknowledged carryover after a foreign publication", async () => {
    await publish("A");
    await publish("B", true, new CompactionPreparationLifecycle(restart()));
    expect((await lifecycle.capture("carryover"))?.readFiles).toEqual(["/B.ts"]);
  });

  it.each([
    { disposition: "ack", captureForeign: true },
    { disposition: "discard", captureForeign: true },
    { disposition: "ack", captureForeign: false },
    { disposition: "discard", captureForeign: false },
  ] as const)(
    "does not restore consumed A after failed foreign fallback cleanup (%j)",
    async ({ disposition, captureForeign }) => {
      await publish("A");
      const a = await lifecycle.capture("pending");
      assert(a);
      const b = await publish("B", true, new CompactionPreparationLifecycle(restart()));
      assert(b.success);
      if (captureForeign)
        expect((await lifecycle.capture("pending"))?.readFiles).toEqual(["/B.ts"]);
      const before = await bytes();
      const rename = syncFs.renameSync;
      const failure = spyOn(syncFs, "renameSync").mockImplementation((from, to) => {
        if (to === pendingPath) throw new Error("Fallback cleanup unavailable");
        rename(from, to);
      });
      await lifecycle.consume(a, disposition);
      failure.mockRestore();
      expect(await bytes()).toBe(before);
      expect((await lifecycle.rollbackHeartbeat(b.data.summaryMessage, () => true)).success).toBe(
        true
      );
      expect(await lifecycle.capture("pending")).toBeUndefined();
      expect(
        await new CompactionPreparationLifecycle(restart()).capture("pending")
      ).toBeUndefined();
    }
  );

  it("does not promote acknowledged predecessor warmth over a foreign successor", async () => {
    await publish("A");
    const a = await lifecycle.capture("pending");
    assert(a);
    await lifecycle.consume(a, "ack");
    await publish("B");
    await publish("C", true, new CompactionPreparationLifecycle(restart()));
    expect((await lifecycle.capture("carryover"))?.readFiles).toEqual(["/C.ts"]);
  });

  it("does not retain acknowledged warmth from a loaded heartbeat after its exact rollback", async () => {
    await publish("A");
    const b = await publish("B", true);
    assert(b.success);
    const restarted = new CompactionPreparationLifecycle(restart());
    const snapshot = await restarted.capture("pending");
    assert(snapshot);
    await restarted.consume(snapshot, "ack");
    expect((await restarted.rollbackHeartbeat(b.data.summaryMessage, () => true)).success).toBe(
      true
    );
    expect(await restarted.capture("pending")).toBeUndefined();
    expect(await restarted.capture("carryover")).toBeUndefined();
  });

  it("retains acknowledged local warmth when an uncaptured foreign heartbeat rolls back", async () => {
    await publish("A");
    const a = await lifecycle.capture("pending");
    assert(a);
    await lifecycle.consume(a, "ack");
    const b = await publish("B", true, new CompactionPreparationLifecycle(restart()));
    assert(b.success);
    expect(await lifecycle.rollbackHeartbeat(b.data.summaryMessage, () => true)).toMatchObject({
      success: true,
      data: { outcome: "applied" },
    });
    expect(await lifecycle.capture("pending")).toBeUndefined();
    expect((await lifecycle.capture("carryover"))?.readFiles).toEqual(["/A.ts"]);
    expect(await new CompactionPreparationLifecycle(restart()).capture("pending")).toBeUndefined();
  });

  it.each(["ack", "discard"] as const)(
    "restores the persisted foreign predecessor instead of applying stale local %s facts",
    async (disposition) => {
      await publish("A");
      const a = await lifecycle.capture("pending");
      assert(a);
      await lifecycle.consume(a, disposition);
      assert((await publish("B", true, new CompactionPreparationLifecycle(restart()))).success);
      const c = await publish("C", true);
      assert(c.success);
      expect(await lifecycle.rollbackHeartbeat(c.data.summaryMessage, () => true)).toMatchObject({
        success: true,
        data: { outcome: "applied" },
      });
      expect((await lifecycle.capture("pending"))?.readFiles).toEqual(["/B.ts"]);
      expect((await lifecycle.capture("carryover"))?.readFiles).toEqual(["/B.ts"]);
      expect(
        (await new CompactionPreparationLifecycle(restart()).capture("pending"))?.readFiles
      ).toEqual(["/B.ts"]);
    }
  );

  it.each([
    { acknowledgePrevious: false, failUnlink: false, consumeAfterRollback: false },
    { acknowledgePrevious: true, failUnlink: false, consumeAfterRollback: false },
    { acknowledgePrevious: true, failUnlink: true, consumeAfterRollback: false },
    { acknowledgePrevious: true, failUnlink: true, consumeAfterRollback: true },
  ])(
    "discards the exact uncaptured foreign survivor (%j)",
    async ({ acknowledgePrevious, failUnlink, consumeAfterRollback }) => {
      await publish("A");
      const a = await lifecycle.capture("pending");
      assert(a);
      await lifecycle.consume(a, acknowledgePrevious ? "ack" : "discard");
      const b = await publish("B", true, new CompactionPreparationLifecycle(restart()));
      assert(b.success);
      // Preserve B as an active row so its later exact rollback can qualify A's original warmth.
      const open = fs.open;
      const rotation = spyOn(fs, "open").mockImplementation(async (file, flags, mode) => {
        if (String(file).endsWith("chat-archive.jsonl") && flags === "a+")
          throw new Error("Archive rotation unavailable");
        return open(file, flags, mode);
      });
      const before = await bytes();
      const rename = syncFs.renameSync;
      const failure = spyOn(syncFs, "renameSync").mockImplementation((from, to) => {
        if (to === pendingPath) throw new Error("Optional write failed");
        rename(from, to);
      });
      const c = await publish("C", true);
      assert(c.success);
      failure.mockRestore();
      expect(await bytes()).toBe(before);
      const snapshot = await lifecycle.capture("pending");
      assert(snapshot);
      expect(snapshot).toEqual({ diffs: [], loadedSkills: [], readFiles: [] });
      const rollbackC = () => lifecycle.rollbackHeartbeat(c.data.summaryMessage, () => true);
      if (consumeAfterRollback) {
        expect(await rollbackC()).toMatchObject({
          success: true,
          data: { outcome: "applied" },
        });
        expect((await lifecycle.capture("pending"))?.readFiles).toEqual(["/B.ts"]);
      }
      const remove = fs.unlink;
      const unlink = spyOn(fs, "unlink").mockImplementation(async (file) => {
        if (failUnlink && file === pendingPath) throw new Error("Cleanup unavailable");
        await remove(file);
      });
      await lifecycle.consume(snapshot, "discard");
      unlink.mockRestore();
      if (!consumeAfterRollback)
        expect(await rollbackC()).toMatchObject({
          success: true,
          data: { outcome: "applied" },
        });
      expect(await lifecycle.capture("pending")).toBeUndefined();
      if (!consumeAfterRollback)
        expect(
          await new CompactionPreparationLifecycle(restart()).capture("pending")
        ).toBeUndefined();
      expect(await lifecycle.rollbackHeartbeat(b.data.summaryMessage, () => true)).toMatchObject({
        success: true,
        data: { outcome: "applied" },
      });
      rotation.mockRestore();
      expect(
        await new CompactionPreparationLifecycle(restart()).capture("pending")
      ).toBeUndefined();
      expect((await lifecycle.capture("carryover"))?.readFiles).toEqual(
        acknowledgePrevious ? ["/A.ts"] : undefined
      );
    }
  );
  it("retires a predecessor adopted by an earlier queued capture when publication reads fail", async () => {
    assert((await publish("A", false, new CompactionPreparationLifecycle(restart()))).success);
    const prepared = await input("B", true);
    const preparation = lifecycle.begin(() => true);
    const entered = Promise.withResolvers<void>();
    const release = Promise.withResolvers<void>();
    const readFile = fs.readFile;
    let pendingReads = 0;
    const reading = spyOn(fs, "readFile").mockImplementation((async (
      ...args: Parameters<typeof fs.readFile>
    ) => {
      if (args[0] === pendingPath) {
        pendingReads++;
        if (pendingReads === 1) {
          const result = await readFile(...args);
          entered.resolve();
          await release.promise;
          return result;
        }
        if (pendingReads === 2) throw new Error("Pending preparation read unavailable");
      }
      return readFile(...args);
    }) as typeof fs.readFile);
    const capturing = lifecycle.capture("pending");
    await entered.promise;
    // Start publication while capture is still awaiting real file I/O.
    const publishing = lifecycle.publish(preparation, prepared);
    release.resolve();
    try {
      expect((await capturing)?.readFiles).toEqual(["/A.ts"]);
      const b = await publishing;
      assert(b.success);
      expect(pendingReads).toBe(2);
      reading.mockRestore();
      const empty = await lifecycle.capture("pending");
      assert(empty);
      expect(empty.readFiles).toEqual([]);
      await lifecycle.consume(empty, "discard");
      const restarted = new CompactionPreparationLifecycle(restart());
      expect(await restarted.rollbackHeartbeat(b.data.summaryMessage, () => true)).toMatchObject({
        success: true,
        data: { outcome: "applied" },
      });
      expect(await restarted.capture("pending")).toBeUndefined();
      expect(
        await new CompactionPreparationLifecycle(restart()).capture("pending")
      ).toBeUndefined();
    } finally {
      release.resolve();
      await Promise.allSettled([capturing, publishing]);
    }
  });

  it("retires an unobserved foreign predecessor after publication read recovery and rollback", async () => {
    assert((await publish("A", false, new CompactionPreparationLifecycle(restart()))).success);
    const readFile = fs.readFile;
    const unreadable = spyOn(fs, "readFile").mockImplementation((async (
      ...args: Parameters<typeof fs.readFile>
    ) => {
      if (args[0] === pendingPath) throw new Error("Pending read unavailable");
      return readFile(...args);
    }) as typeof fs.readFile);
    const b = await publish("B", true);
    assert(b.success);
    const empty = await lifecycle.capture("pending");
    assert(empty);
    expect(empty.readFiles).toEqual([]);
    await lifecycle.consume(empty, "discard");
    unreadable.mockRestore();
    expect(await lifecycle.rollbackHeartbeat(b.data.summaryMessage, () => true)).toMatchObject({
      success: true,
      data: { outcome: "applied" },
    });
    expect(await lifecycle.capture("pending")).toBeUndefined();
    expect(await new CompactionPreparationLifecycle(restart()).capture("pending")).toBeUndefined();
  });

  it.each(["ack", "discard"] as const)(
    "retries known %s cleanup after an uncaptured foreign history-only rollback",
    async (disposition) => {
      await publish("A");
      const a = await lifecycle.capture("pending");
      assert(a);
      const unlink = fs.unlink;
      const unavailable = spyOn(fs, "unlink").mockImplementation(async (file) => {
        if (file === pendingPath) throw new Error("Pending unlink unavailable");
        await unlink(file);
      });
      await lifecycle.consume(a, disposition);
      unavailable.mockRestore();
      const rename = syncFs.renameSync;
      const failedWrite = spyOn(syncFs, "renameSync").mockImplementation((from, to) => {
        if (to === pendingPath) throw new Error("Optional write unavailable");
        rename(from, to);
      });
      const b = await publish("B", true, new CompactionPreparationLifecycle(restart()));
      assert(b.success);
      failedWrite.mockRestore();
      expect(await lifecycle.rollbackHeartbeat(b.data.summaryMessage, () => true)).toMatchObject({
        success: true,
        data: { outcome: "applied" },
      });
      expect(await lifecycle.capture("pending")).toBeUndefined();
      expect(
        await new CompactionPreparationLifecycle(restart()).capture("pending")
      ).toBeUndefined();
      expect((await lifecycle.capture("carryover"))?.readFiles).toEqual(
        disposition === "ack" ? ["/A.ts"] : undefined
      );
    }
  );

  it.each([
    { acknowledgeA: true, acknowledgeB: false },
    { acknowledgeA: true, acknowledgeB: true },
    { acknowledgeA: false, acknowledgeB: false },
    { acknowledgeA: false, acknowledgeB: true },
  ])(
    "retains only acknowledged warmth across nested rollback (%j)",
    async ({ acknowledgeA, acknowledgeB }) => {
      await publish("A");
      const a = await lifecycle.capture("pending");
      assert(a);
      if (acknowledgeA) await lifecycle.consume(a, "ack");
      const open = fs.open;
      const rotation = spyOn(fs, "open").mockImplementation(async (file, flags, mode) => {
        if (String(file).endsWith("chat-archive.jsonl") && flags === "a+")
          throw new Error("Archive rotation unavailable");
        return open(file, flags, mode);
      });
      const b = await publish("B", true);
      assert(b.success);
      if (acknowledgeB) {
        const bSnapshot = await lifecycle.capture("pending");
        assert(bSnapshot);
        await lifecycle.consume(bSnapshot, "ack");
      }
      const c = await publish("C", true);
      assert(b.success && c.success);
      expect(await lifecycle.rollbackHeartbeat(c.data.summaryMessage, () => true)).toMatchObject({
        success: true,
        data: { outcome: "applied" },
      });
      expect((await lifecycle.capture("pending"))?.readFiles).toEqual(
        acknowledgeB ? undefined : ["/B.ts"]
      );
      expect((await lifecycle.capture("carryover"))?.readFiles).toEqual(["/B.ts"]);
      expect(await lifecycle.rollbackHeartbeat(b.data.summaryMessage, () => true)).toMatchObject({
        success: true,
        data: { outcome: "applied" },
      });
      rotation.mockRestore();
      expect(await lifecycle.capture("pending")).toBeUndefined();
      expect((await lifecycle.capture("carryover"))?.readFiles).toEqual(
        acknowledgeA ? ["/A.ts"] : undefined
      );
    }
  );
  it("skips an older active heartbeat and preserves the successor's fallback", async () => {
    assert((await publish("A")).success);
    const open = fs.open;
    spyOn(fs, "open").mockImplementation(async (file, flags, mode) => {
      if (String(file).endsWith("chat-archive.jsonl") && flags === "a+")
        throw new Error("Archive unavailable");
      return open(file, flags, mode);
    });
    const b = await publish("B", true);
    const c = await publish("C", true);
    assert(b.success && c.success);
    const before = await bytes();
    expect(await lifecycle.rollbackHeartbeat(b.data.summaryMessage, () => true)).toMatchObject({
      success: true,
      data: { outcome: "skipped" },
    });
    expect(await bytes()).toBe(before);
    expect(await lifecycle.rollbackHeartbeat(c.data.summaryMessage, () => true)).toMatchObject({
      success: true,
      data: { outcome: "applied" },
    });
    expect(
      (await new CompactionPreparationLifecycle(restart()).capture("pending"))?.readFiles
    ).toEqual(["/B.ts"]);
  });

  it("refuses consumed rollback until exact pending retirement becomes durable", async () => {
    assert((await publish("A")).success);
    const b = await publish("B", true);
    assert(b.success);
    const captured = await lifecycle.capture("pending");
    assert(captured);
    const unlink = fs.unlink;
    const failedUnlink = spyOn(fs, "unlink").mockImplementation(async (file) => {
      if (file === pendingPath) throw new Error("Pending unlink unavailable");
      return unlink(file);
    });
    const rename = syncFs.renameSync;
    const failedReplacement = spyOn(syncFs, "renameSync").mockImplementation((from, to) => {
      if (to === pendingPath) throw new Error("Pending replacement unavailable");
      rename(from, to);
    });
    await lifecycle.consume(captured, "discard");
    expect((await lifecycle.rollbackHeartbeat(b.data.summaryMessage, () => true)).success).toBe(
      false
    );
    expect(await historyIds()).toEqual(["B"]);
    failedUnlink.mockRestore();
    failedReplacement.mockRestore();
    expect(await lifecycle.rollbackHeartbeat(b.data.summaryMessage, () => true)).toMatchObject({
      success: true,
      data: { outcome: "applied" },
    });
    expect(await new CompactionPreparationLifecycle(restart()).capture("pending")).toBeUndefined();
  });

  it.each([false, true])(
    "skips staged rollback when consumption changes after its retirement checkpoint (%s)",
    async (priorConsumption) => {
      assert((await publish("A")).success);
      if (priorConsumption) {
        const a = await lifecycle.capture("pending");
        assert(a);
        await lifecycle.consume(a, "ack");
      }
      const b = await publish("B", true);
      assert(b.success);
      const snapshot = await lifecycle.capture("pending");
      assert(snapshot);
      const entered = Promise.withResolvers<void>();
      const release = Promise.withResolvers<void>();
      const atomic = atomicWrite.default;
      spyOn(atomicWrite, "default").mockImplementation(
        new Proxy(atomic, {
          async apply(target, receiver, args: Parameters<typeof atomic>) {
            const result = await Reflect.apply(target, receiver, args);
            if (String(args[0]).includes(".follow-up-")) {
              entered.resolve();
              await release.promise;
            }
            return result;
          },
        })
      );
      const rollback = lifecycle.rollbackHeartbeat(b.data.summaryMessage, () => true);
      let consuming: Promise<void> | undefined;
      try {
        await entered.promise;
        consuming = lifecycle.consume(snapshot, "discard");
        release.resolve();
        expect(await rollback).toMatchObject({ success: true, data: { outcome: "skipped" } });
        await consuming;
        expect(await historyIds()).toEqual(["B"]);
        expect(await lifecycle.rollbackHeartbeat(b.data.summaryMessage, () => true)).toMatchObject({
          success: true,
          data: { outcome: "applied" },
        });
        expect(
          await new CompactionPreparationLifecycle(restart()).capture("pending")
        ).toBeUndefined();
      } finally {
        release.resolve();
        await rollback;
        await consuming;
      }
    }
  );

  it("preserves unconsumed B when predecessor retirement succeeds but history staging fails", async () => {
    assert((await publish("A")).success);
    const a = await lifecycle.capture("pending");
    assert(a);
    const unlink = fs.unlink;
    const unavailable = spyOn(fs, "unlink").mockImplementation(async (file) => {
      if (file === pendingPath) throw new Error("Pending unlink unavailable");
      return unlink(file);
    });
    await lifecycle.consume(a, "ack");
    unavailable.mockRestore();
    const b = await publish("B", true);
    assert(b.success);
    const rename = syncFs.renameSync;
    const failure = spyOn(syncFs, "renameSync").mockImplementation((from, to) => {
      if (to === path.join(h.config.sessionsDir, workspaceId, "chat.jsonl"))
        throw new Error("History rename unavailable");
      rename(from, to);
    });
    expect((await lifecycle.rollbackHeartbeat(b.data.summaryMessage, () => true)).success).toBe(
      false
    );
    expect(await historyIds()).toEqual(["B"]);
    expect((await lifecycle.capture("pending"))?.readFiles).toEqual(["/B.ts"]);
    expect((await restart().load(() => true))?.attachments.readFiles).toEqual(["/B.ts"]);
    failure.mockRestore();
    expect(await lifecycle.rollbackHeartbeat(b.data.summaryMessage, () => true)).toMatchObject({
      success: true,
      data: { outcome: "applied" },
    });
    expect((await lifecycle.capture("carryover"))?.readFiles).toEqual(["/A.ts"]);
  });

  it("does not apply a consumed noncurrent heartbeat to a foreign successor", async () => {
    await publish("A");
    const open = fs.open;
    const rotation = spyOn(fs, "open").mockImplementation(async (file, flags, mode) => {
      if (String(file).endsWith("chat-archive.jsonl") && flags === "a+")
        throw new Error("Archive unavailable");
      return open(file, flags, mode);
    });
    const b = await publish("B", true);
    assert(b.success);
    const snapshot = await lifecycle.capture("pending");
    assert(snapshot);
    await lifecycle.consume(snapshot, "discard");
    assert((await publish("C", true, new CompactionPreparationLifecycle(restart()))).success);
    rotation.mockRestore();
    const before = await bytes();
    expect(await lifecycle.rollbackHeartbeat(b.data.summaryMessage, () => true)).toMatchObject({
      success: true,
      data: { outcome: "skipped" },
    });
    expect(await bytes()).toBe(before);
    expect((await lifecycle.capture("pending"))?.readFiles).toEqual(["/C.ts"]);
    expect(
      (await new CompactionPreparationLifecycle(restart()).capture("pending"))?.readFiles
    ).toEqual(["/C.ts"]);
  });

  it("does not apply an old-generation empty token to newly eligible pending state", async () => {
    await publish("A");
    const original = JSON.parse(await bytes()) as Record<string, unknown>;
    const rename = syncFs.renameSync;
    const failure = spyOn(syncFs, "renameSync").mockImplementation((from, to) => {
      if (to === pendingPath) throw new Error("Optional write unavailable");
      rename(from, to);
    });
    const b = await publish("B", true);
    assert(b.success);
    const snapshot = await lifecycle.capture("pending");
    assert(snapshot);
    expect(snapshot.readFiles).toEqual([]);
    await lifecycle.consume(snapshot, "discard");
    failure.mockRestore();
    const journal = new HistoryService(h.config).getContinuousCompactionJournal(workspaceId);
    await journal.advanceGeneration();
    const replacement = JSON.stringify({
      ...original,
      // The restored A occurrence remains exact; the changed generation is the new owner.
      writeId: original.writeId,
      publicationGeneration: await journal.captureGeneration(),
      readFiles: ["/new.ts"],
    });
    await fs.writeFile(pendingPath, replacement);
    expect(await lifecycle.rollbackHeartbeat(b.data.summaryMessage, () => true)).toMatchObject({
      success: true,
      data: { outcome: "applied" },
    });
    expect(await bytes()).toBe(replacement);
    expect((await lifecycle.capture("pending"))?.readFiles).toEqual(["/new.ts"]);
  });

  it("bounds retained acknowledged candidates after successful archive rotations", async () => {
    const observed = spyOn(store, "observe");
    for (const name of ["A", "B", "C", "D", "E"]) {
      assert((await publish(name, name !== "A")).success);
      const snapshot = await lifecycle.capture("pending");
      assert(snapshot);
      await lifecycle.consume(snapshot, "ack");
    }
    expect((await lifecycle.capture("carryover"))?.readFiles).toEqual(["/E.ts"]);
    expect(observed.mock.calls.at(-1)?.[0].length).toBeLessThanOrEqual(2);
  });
  it.each([
    { failUnlink: false, disposition: "discard" as const },
    { failUnlink: true, disposition: "discard" as const },
    { failUnlink: false, disposition: "ack" as const },
    { failUnlink: true, disposition: "ack" as const },
  ])(
    "preserves independently acknowledged A warmth when consuming an empty B (%j)",
    async ({ failUnlink, disposition }) => {
      await publish("A");
      const a = await lifecycle.capture("pending");
      assert(a);
      const unlink = fs.unlink;
      const failedAck = spyOn(fs, "unlink").mockImplementation(async (file) => {
        if (failUnlink && file === pendingPath) throw new Error("Unlink unavailable");
        return unlink(file);
      });
      await lifecycle.consume(a, "ack");
      failedAck.mockRestore();
      const rename = syncFs.renameSync;
      const optional = spyOn(syncFs, "renameSync").mockImplementation((from, to) => {
        if (to === pendingPath) throw new Error("Optional write unavailable");
        rename(from, to);
      });
      const b = await publish("B", true);
      assert(b.success);
      const empty = await lifecycle.capture("pending");
      assert(empty);
      expect(empty.readFiles).toEqual([]);
      await lifecycle.consume(empty, disposition);
      optional.mockRestore();
      expect(await lifecycle.rollbackHeartbeat(b.data.summaryMessage, () => true)).toMatchObject({
        success: true,
        data: { outcome: "applied" },
      });
      expect(await lifecycle.capture("pending")).toBeUndefined();
      expect((await lifecycle.capture("carryover"))?.readFiles).toEqual(["/A.ts"]);
      expect(
        await new CompactionPreparationLifecycle(restart()).capture("pending")
      ).toBeUndefined();
    }
  );
  it("retries unreadable consumed rollback across a deeper heartbeat without deleting later bytes", async () => {
    assert((await publish("A", false, new CompactionPreparationLifecycle(restart()))).success);
    const original = await bytes();
    const read = fs.readFile;
    const unavailable = spyOn(fs, "readFile").mockImplementation((async (
      ...args: Parameters<typeof fs.readFile>
    ) => {
      if (args[0] === pendingPath) throw new Error("Pending read unavailable");
      return read(...args);
    }) as typeof fs.readFile);
    const b = await publish("B", true);
    assert(b.success);
    const empty = await lifecycle.capture("pending");
    assert(empty);
    expect(empty.readFiles).toEqual([]);
    await lifecycle.consume(empty, "discard");
    expect((await lifecycle.rollbackHeartbeat(b.data.summaryMessage, () => true)).success).toBe(
      false
    );
    expect(await historyIds()).toEqual(["B"]);
    unavailable.mockRestore();
    expect(await lifecycle.capture("pending")).toBeUndefined();
    expect(await bytes()).toBe(original);
    // The unchanged B boundary keeps A ineligible until retirement can be established.
    expect(await new CompactionPreparationLifecycle(restart()).capture("pending")).toBeUndefined();
    const open = fs.open;
    const rotation = spyOn(fs, "open").mockImplementation(async (file, flags, mode) => {
      if (String(file).endsWith("chat-archive.jsonl") && flags === "a+")
        throw new Error("Archive unavailable");
      return open(file, flags, mode);
    });
    const c = await publish("C", true);
    assert(c.success);
    expect((await lifecycle.capture("pending"))?.readFiles).toEqual(["/C.ts"]);
    expect(await lifecycle.rollbackHeartbeat(c.data.summaryMessage, () => true)).toMatchObject({
      success: true,
      data: { outcome: "applied" },
    });
    expect(await lifecycle.capture("pending")).toBeUndefined();
    expect(await lifecycle.rollbackHeartbeat(b.data.summaryMessage, () => true)).toMatchObject({
      success: true,
      data: { outcome: "applied" },
    });
    expect(await new CompactionPreparationLifecycle(restart()).capture("pending")).toBeUndefined();
    rotation.mockRestore();
    const replacement = JSON.stringify({
      ...(JSON.parse(original) as Record<string, unknown>),
      writeId: "foreign-replacement",
      readFiles: ["/replacement.ts"],
    });
    await fs.writeFile(pendingPath, replacement);
    expect(await lifecycle.capture("pending")).toBeUndefined();
    expect(await bytes()).toBe(replacement);
    assert((await publish("D")).success);
    expect((await lifecycle.capture("pending"))?.readFiles).toEqual(["/D.ts"]);
  });

  it("retains initial acknowledged warmth across a heartbeat and prunes it after an irreversible boundary", async () => {
    await fs.writeFile(
      pendingPath,
      JSON.stringify({
        version: 1,
        createdAt: 1,
        diffs: [],
        loadedSkills: [],
        readFiles: ["/initial.ts"],
      })
    );
    const initial = await lifecycle.capture("pending");
    assert(initial);
    await lifecycle.consume(initial, "ack");
    const b = await publish("B", true);
    assert(b.success);
    expect((await lifecycle.capture("pending"))?.readFiles).toEqual(["/B.ts"]);
    expect(await lifecycle.rollbackHeartbeat(b.data.summaryMessage, () => true)).toMatchObject({
      success: true,
      data: { outcome: "applied" },
    });
    expect((await lifecycle.capture("carryover"))?.readFiles).toEqual(["/initial.ts"]);
    assert((await publish("C")).success);
    const c = await lifecycle.capture("pending");
    assert(c);
    await lifecycle.consume(c, "ack");
    const observed = spyOn(store, "observe");
    expect((await lifecycle.capture("carryover"))?.readFiles).toEqual(["/C.ts"]);
    expect(observed.mock.calls[0]?.[0]).toHaveLength(1);
  });
  it.each(["ack", "discard"] as const)(
    "does not apply loaded %s facts from an older write at a reused boundary ID",
    async (disposition) => {
      const foreign = new CompactionPreparationLifecycle(restart());
      const old = await publish("B", true, foreign);
      assert(old.success);
      const captured = await lifecycle.capture("pending");
      assert(captured);
      await lifecycle.consume(captured, disposition);
      assert((await publish("A", false, foreign)).success);
      const newer = await publish("B", true, foreign);
      assert(newer.success);
      expect(newer.data.summaryMessage.metadata?.historySequence).not.toBe(
        old.data.summaryMessage.metadata?.historySequence
      );
      expect(
        await lifecycle.rollbackHeartbeat(newer.data.summaryMessage, () => true)
      ).toMatchObject({ success: true, data: { outcome: "applied" } });
      expect((await lifecycle.capture("pending"))?.readFiles).toEqual(["/A.ts"]);
      expect(
        (await new CompactionPreparationLifecycle(restart()).capture("pending"))?.readFiles
      ).toEqual(["/A.ts"]);
    }
  );

  it.each(["ack", "discard"] as const)(
    "uses exact loaded %s facts to veto fallback restoration after failed unlink",
    async (disposition) => {
      const foreign = new CompactionPreparationLifecycle(restart());
      assert((await publish("A", false, foreign)).success);
      const b = await publish("B", true, foreign);
      assert(b.success);
      const captured = await lifecycle.capture("pending");
      assert(captured);
      const unlink = fs.unlink;
      const unavailable = spyOn(fs, "unlink").mockImplementation(async (file) => {
        if (file === pendingPath) throw new Error("Unlink unavailable");
        return unlink(file);
      });
      await lifecycle.consume(captured, disposition);
      unavailable.mockRestore();
      expect(await lifecycle.rollbackHeartbeat(b.data.summaryMessage, () => true)).toMatchObject({
        success: true,
        data: { outcome: "applied" },
      });
      expect(await lifecycle.capture("pending")).toBeUndefined();
      expect(
        await new CompactionPreparationLifecycle(restart()).capture("pending")
      ).toBeUndefined();
    }
  );
  it("selects acknowledged warmth from the latest observed write at a reused boundary ID", async () => {
    const first = await publish("B", true);
    assert(first.success);
    const captured = await lifecycle.capture("pending");
    assert(captured);
    await lifecycle.consume(captured, "ack");
    expect(
      await new CompactionPreparationLifecycle(restart()).rollbackHeartbeat(
        first.data.summaryMessage,
        () => true
      )
    ).toMatchObject({ success: true, data: { outcome: "applied" } });
    const second = await input("B", true);
    second.attachments.readFiles = ["/B2.ts"];
    assert(
      (
        await lifecycle.publish(
          lifecycle.begin(() => true),
          second
        )
      ).success
    );
    const latest = await lifecycle.capture("pending");
    assert(latest);
    expect(latest.readFiles).toEqual(["/B2.ts"]);
    await lifecycle.consume(latest, "ack");
    expect((await lifecycle.capture("carryover"))?.readFiles).toEqual(["/B2.ts"]);
  });

  it("rejects old warmth after an unobserved foreign replacement at a reused boundary", async () => {
    const first = await publish("B", true);
    assert(first.success);
    const firstReceipt = await store.load(() => true);
    assert(firstReceipt);
    const captured = await lifecycle.capture("pending");
    assert(captured);
    await lifecycle.consume(captured, "ack");
    const foreign = new CompactionPreparationLifecycle(restart());
    expect(await foreign.rollbackHeartbeat(first.data.summaryMessage, () => true)).toMatchObject({
      success: true,
      data: { outcome: "applied" },
    });
    // A restarted publisher can reuse the removed sequence and identical summary bytes.
    // Only attachment ownership differs; local row-content hashes cannot distinguish it.
    const writer = new CompactionPreparationLifecycle(restart());
    const replacement = await input("B", true);
    replacement.summaryMessage = structuredClone(first.data.summaryMessage);
    delete replacement.summaryMessage.metadata!.historySequence;
    replacement.attachments.readFiles = ["/B2.ts"];
    const second = await writer.publish(
      writer.begin(() => true),
      replacement
    );
    assert(second.success);
    expect(second.data.summaryMessage.metadata?.historySequence).toBe(
      first.data.summaryMessage.metadata?.historySequence
    );
    const delivered = await writer.capture("pending");
    assert(delivered);
    await writer.consume(delivered, "ack");
    expect(await store.isCurrent(firstReceipt, "carryover", () => true)).toBe(false);
    expect(await lifecycle.capture("carryover")).toBeUndefined();
    expect(await lifecycle.rollbackHeartbeat(first.data.summaryMessage, () => true)).toMatchObject({
      success: true,
      data: { outcome: "skipped" },
    });
    expect((await writer.capture("carryover"))?.readFiles).toEqual(["/B2.ts"]);
  });

  it("bounds acknowledged receipt retention across repeated foreign rollback and ID reuse", async () => {
    const observed = spyOn(store, "observe");
    for (let iteration = 0; iteration < 5; iteration++) {
      const result = await publish("B", true);
      assert(result.success);
      const snapshot = await lifecycle.capture("pending");
      assert(snapshot);
      await lifecycle.consume(snapshot, "ack");
      expect(
        await new CompactionPreparationLifecycle(restart()).rollbackHeartbeat(
          result.data.summaryMessage,
          () => true
        )
      ).toMatchObject({ success: true, data: { outcome: "applied" } });
    }
    expect(observed.mock.calls.at(-1)?.[0].length).toBeLessThanOrEqual(1);
  });

  it("does not adopt an old history-only token after an unobserved foreign replacement", async () => {
    const rename = syncFs.renameSync;
    spyOn(syncFs, "renameSync").mockImplementation((from, to) => {
      if (to === pendingPath) throw new Error("Optional write unavailable");
      rename(from, to);
    });
    const first = await publish("B", true);
    assert(first.success);
    expect((await lifecycle.capture("pending"))?.readFiles).toEqual([]);
    const foreign = new CompactionPreparationLifecycle(restart());
    expect(await foreign.rollbackHeartbeat(first.data.summaryMessage, () => true)).toMatchObject({
      success: true,
      data: { outcome: "applied" },
    });
    assert((await publish("B", true, foreign)).success);
    expect(await lifecycle.capture("pending")).toBeUndefined();
    expect((await foreign.capture("pending"))?.readFiles).toEqual([]);
  });

  it("preserves warmth through follow-up clear, summary finalization, and unrelated append", async () => {
    const b = await publish("B", true);
    assert(b.success);
    const snapshot = await lifecycle.capture("pending");
    assert(snapshot);
    await lifecycle.consume(snapshot, "ack");
    expect(
      await h.historyService.cleanupCompactionFollowUp(
        workspaceId,
        b.data.summaryMessage,
        "clear",
        () => true
      )
    ).toMatchObject({ success: true, data: "applied" });
    const finalized = structuredClone(b.data.summaryMessage);
    finalized.parts = [{ type: "text", text: "Finalized summary" }];
    assert(finalized.metadata);
    delete finalized.metadata.compactionPublicationId;
    delete finalized.metadata.muxMetadata;
    assert((await h.historyService.updateHistory(workspaceId, finalized)).success);
    assert(
      (
        await h.historyService.appendToHistory(
          workspaceId,
          createMuxMessage("later", "user", "Later")
        )
      ).success
    );
    expect((await lifecycle.capture("carryover"))?.readFiles).toEqual(["/B.ts"]);
  });

  it("rejects a marked boundary's stale pending write after foreign enrichment fails", async () => {
    const first = await publish("B", true);
    assert(first.success);
    const oldBytes = await bytes();
    const captured = await lifecycle.capture("pending");
    assert(captured);
    const unlink = fs.unlink;
    spyOn(fs, "unlink").mockImplementation(async (file) => {
      if (file === pendingPath) throw new Error("Pending unlink unavailable");
      return unlink(file);
    });
    const rename = syncFs.renameSync;
    spyOn(syncFs, "renameSync").mockImplementation((from, to) => {
      if (to === pendingPath) throw new Error("Pending replacement unavailable");
      rename(from, to);
    });
    await lifecycle.consume(captured, "ack");
    const foreign = new CompactionPreparationLifecycle(restart());
    expect(await foreign.rollbackHeartbeat(first.data.summaryMessage, () => true)).toMatchObject({
      success: true,
      data: { outcome: "applied" },
    });
    assert((await publish("B", true, foreign)).success);
    expect(await bytes()).toBe(oldBytes);
    expect(await restart().load(() => true)).toBeUndefined();
    expect(await new CompactionPreparationLifecycle(restart()).capture("pending")).toBeUndefined();
    expect(await lifecycle.capture("carryover")).toBeUndefined();
  });

  it("does not restore a fallback with another writeId into a marked predecessor", async () => {
    assert((await publish("A")).success);
    const b = await publish("B", true);
    assert(b.success);
    const pending = JSON.parse(await bytes()) as { previousState: { writeId: string } };
    pending.previousState.writeId = "unrelated-write";
    await fs.writeFile(pendingPath, JSON.stringify(pending));
    expect(
      await new CompactionPreparationLifecycle(restart()).rollbackHeartbeat(
        b.data.summaryMessage,
        () => true
      )
    ).toMatchObject({ success: true, data: { outcome: "applied" } });
    expect(await restart().load(() => true)).toBeUndefined();
  });

  it("loads compatible unmarked rows without inventing absent-file warmth", async () => {
    const b = await publish("B", true);
    assert(b.success);
    const chatPath = path.join(h.config.sessionsDir, workspaceId, "chat.jsonl");
    const rows = (await fs.readFile(chatPath, "utf8"))
      .trim()
      .split("\n")
      .map((line) => JSON.parse(line) as typeof b.data.summaryMessage);
    for (const row of rows) if (row.metadata) delete row.metadata.compactionPublicationId;
    await fs.writeFile(chatPath, rows.map((row) => JSON.stringify(row)).join("\n") + "\n");
    const legacy = new CompactionPreparationLifecycle(restart());
    const snapshot = await legacy.capture("pending");
    assert(snapshot);
    expect(snapshot.readFiles).toEqual(["/B.ts"]);
    await legacy.consume(snapshot, "ack");
    expect(await legacy.capture("carryover")).toBeUndefined();
  });

  it("does not grant acknowledged warmth to attachments omitted by a history-only request", async () => {
    assert((await publish("A")).success);
    const rename = syncFs.renameSync;
    const unavailable = spyOn(syncFs, "renameSync").mockImplementation((from, to) => {
      if (to === pendingPath) throw new Error("Optional write unavailable");
      rename(from, to);
    });
    const b = await publish("B", true);
    assert(b.success);
    unavailable.mockRestore();
    const empty = await lifecycle.capture("pending");
    assert(empty);
    expect(empty.readFiles).toEqual([]);
    await lifecycle.consume(empty, "ack");
    expect(await lifecycle.rollbackHeartbeat(b.data.summaryMessage, () => true)).toMatchObject({
      success: true,
      data: { outcome: "applied" },
    });
    expect(await lifecycle.capture("carryover")).toBeUndefined();
  });

  it("retires rollback fallback durably when unlink fails", async () => {
    await publish("A");
    const b = await publish("B", true);
    assert(b.success);
    const captured = await lifecycle.capture("pending");
    assert(captured);
    const unlink = fs.unlink;
    const unavailable = spyOn(fs, "unlink").mockImplementation(async (file) => {
      if (file === pendingPath) throw new Error("Unlink unavailable");
      return unlink(file);
    });
    await lifecycle.consume(captured, "discard");
    expect(await lifecycle.rollbackHeartbeat(b.data.summaryMessage, () => true)).toMatchObject({
      success: true,
      data: { outcome: "applied" },
    });
    expect(await lifecycle.capture("pending")).toBeUndefined();
    unavailable.mockRestore();
    expect(await new CompactionPreparationLifecycle(restart()).capture("pending")).toBeUndefined();
    const rename = syncFs.renameSync;
    const failedWrite = spyOn(syncFs, "renameSync").mockImplementation((from, to) => {
      if (to === pendingPath) throw new Error("Optional publication unavailable");
      rename(from, to);
    });
    assert((await publish("B", true, new CompactionPreparationLifecycle(restart()))).success);
    failedWrite.mockRestore();
    expect(await new CompactionPreparationLifecycle(restart()).capture("pending")).toBeUndefined();
  });
});

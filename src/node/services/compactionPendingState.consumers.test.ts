import { afterEach, beforeEach, describe, expect, it, mock, spyOn } from "bun:test";
import assert from "node:assert/strict";
import * as fs from "node:fs/promises";
import * as path from "node:path";
import * as atomicWrite from "write-file-atomic";
import { createMuxMessage, type MuxMessage } from "@/common/types/message";
import { acquireProcessFileLock } from "@/node/utils/concurrency/fileLock";
import { CompactionPendingState, type CompactionPendingReceipt } from "./compactionPendingState";
import { HistoryService } from "./historyService";
import { createTestHistoryService } from "./testHistoryService";
import { historyWriteLockPath } from "./workspaceRemoval";

type RollbackInput = Parameters<CompactionPendingState["rollbackHeartbeat"]>[0];

describe("inactive pending consumer contracts", () => {
  const workspaceId = "pending-consumers";
  let h: Awaited<ReturnType<typeof createTestHistoryService>>;
  let pendingPath: string;
  let store: CompactionPendingState;

  function restart(service = new HistoryService(h.config)) {
    return new CompactionPendingState(
      pendingPath,
      service.getCompactionPendingHistory(workspaceId)
    );
  }

  async function publish(name: string, heartbeat = false, target = store, accepted = true) {
    const summary = createMuxMessage(name, "assistant", name, {
      compacted: heartbeat ? "heartbeat" : "user",
      compactionBoundary: true,
      compactionEpoch: 1,
      ...(heartbeat && {
        muxMetadata: {
          type: "compaction-summary",
          pendingFollowUp: { text: "Resume", model: "openai:gpt-4o", agentId: "exec" },
        },
      }),
    });
    const result = await target.publishBoundary({
      attachments: { diffs: [], loadedSkills: [], readFiles: [`/${name}.ts`] },
      summaryMessage: summary,
      tailCopies: [],
      updateExisting: false,
      publication: {
        generation: await h.historyService
          .getContinuousCompactionJournal(workspaceId)
          .captureGeneration(),
      },
      isCurrent: () => true,
      shouldPersist: () => accepted,
      onCommitted: () => undefined,
    });
    return { summary, result };
  }

  function rollback(
    summaryMessage: MuxMessage,
    target = store,
    overrides: Partial<RollbackInput> = {}
  ) {
    return target.rollbackHeartbeat({
      summaryMessage,
      isCurrent: () => true,
      canRestorePrevious: () => true,
      onCommitted: () => undefined,
      onRestored: () => undefined,
      ...overrides,
    });
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
    store = restart(h.historyService);
  });

  afterEach(async () => {
    mock.restore();
    await h.cleanup();
  });

  it("requires synchronous history and restoration receipt callbacks", () => {
    const acceptCommit = (_callback: RollbackInput["onCommitted"]) => undefined;
    const acceptRestoration = (_callback: RollbackInput["onRestored"]) => undefined;
    acceptCommit(() => undefined);
    acceptRestoration(() => undefined);
    // @ts-expect-error History publication facts must precede lock release.
    acceptCommit(async () => {
      await Promise.resolve();
    });
    // @ts-expect-error Restored receipt ownership must precede lock release.
    acceptRestoration(async () => {
      await Promise.resolve();
    });
  });

  it("does not grant warm carryover authority to an unpublished preparation", async () => {
    const receipt = await store.prepare({
      attachments: { diffs: [], loadedSkills: [], readFiles: ["/unpublished.ts"] },
      boundaryMessageId: "unpublished",
      publication: { generation: undefined },
      isCurrent: () => true,
    });
    assert(receipt);
    expect(await store.isCurrent(receipt, "pending", () => true)).toBe(false);
    expect(await store.isCurrent(receipt, "carryover", () => true)).toBe(false);
    expect(await historyIds()).toEqual(["seed"]);
  });

  it("cannot restore pending state when the real history cleanup fails before commit", async () => {
    await publish("A");
    const { summary } = await publish("B", true);
    const before = await bytes();
    const write = atomicWrite.default;
    spyOn(atomicWrite, "default").mockImplementation(
      new Proxy(write, {
        async apply(target, _thisArg, args: Parameters<typeof write>) {
          if (String(args[0]).includes(".follow-up-")) throw new Error("Disk full");
          return target(...args);
        },
      })
    );
    let committed = false;
    let restored = false;
    const result = await rollback(summary, restart(), {
      onCommitted: () => {
        committed = true;
      },
      onRestored: () => {
        restored = true;
      },
    });
    expect(result.success).toBe(false);
    expect(committed).toBe(false);
    expect(restored).toBe(false);
    expect(await bytes()).toBe(before);
    expect(await historyIds()).toEqual(["B"]);
  });

  it("restores exact predecessor bytes after restart only through witnessed heartbeat cleanup", async () => {
    assert((await publish("A")).result.success);
    const previous = await bytes();
    const { summary } = await publish("B", true);
    const restarted = restart();
    const receipt = await restarted.load(() => true);
    assert(receipt);
    const current = await bytes();
    expect(await restarted.rollback(receipt, () => true)).toBe(false);
    expect(await bytes()).toBe(current);
    let committed = false;
    let restored: CompactionPendingReceipt | undefined;
    const result = await rollback(summary, restarted, {
      onCommitted: () => {
        committed = true;
      },
      onRestored: (receipt) => {
        expect(committed).toBe(true);
        restored = receipt;
      },
    });
    assert(result.success);
    expect(result.data).toEqual({ outcome: "applied", restored });
    expect(restored?.attachments.readFiles).toEqual(["/A.ts"]);
    expect(await bytes()).toBe(previous);
    expect(await historyIds()).toEqual(["A"]);
    expect((await restart().load(() => true))?.attachments.readFiles).toEqual(["/A.ts"]);
  });

  it.each(["follow-up", "sequence", "admission"] as const)(
    "skipped %s cleanup cannot restore or consume bytes",
    async (reason) => {
      await publish("A");
      const { summary } = await publish("B", true);
      const before = await bytes();
      const wrong = structuredClone(summary);
      assert(wrong.metadata);
      if (reason === "sequence") wrong.metadata.historySequence = 900;
      if (reason === "follow-up")
        wrong.metadata.muxMetadata = {
          type: "compaction-summary",
          pendingFollowUp: { text: "Changed", model: "openai:gpt-4o", agentId: "exec" },
        };
      const result = await rollback(wrong, restart(), {
        isCurrent: () => reason !== "admission",
        onCommitted: () => {
          throw new Error("Skipped cleanup cannot commit");
        },
        onRestored: () => {
          throw new Error("Skipped cleanup cannot restore");
        },
      });
      expect(result).toEqual({ success: true, data: { outcome: "skipped" } });
      expect(await bytes()).toBe(before);
      expect(await historyIds()).toEqual(["B"]);
    }
  );

  it.each(["generation", "boundary", "consumed", "local retirement"] as const)(
    "refuses predecessor restoration with invalid %s proof",
    async (reason) => {
      const a = await publish("A");
      assert(a.result.success && a.result.data);
      const { summary } = await publish("B", true);
      if (reason === "consumed") {
        expect(await store.consume(a.result.data)).toBe(true);
      } else if (reason !== "local retirement") {
        const state = JSON.parse(await bytes()) as Record<string, unknown>;
        if (reason === "generation") delete state.previousStateGeneration;
        else state.previousStateBoundary = { kind: "identified", messageId: "unrelated" };
        await fs.writeFile(pendingPath, JSON.stringify(state));
      }
      const result = await rollback(summary, restart(), {
        canRestorePrevious: () => reason !== "local retirement",
      });
      expect(result).toEqual({ success: true, data: { outcome: "applied", restored: undefined } });
      expect(await historyIds()).toEqual(["A"]);
      expect(await restart().load(() => true)).toBeUndefined();
      expect(await fs.stat(pendingPath).catch((error: unknown) => error)).toMatchObject({
        code: "ENOENT",
      });
    }
  );

  it.each(["failed successor", "committed successor", "reset", "late error"] as const)(
    "records exact cleanup before a delayed return and preserves %s",
    async (scenario) => {
      await publish("A");
      const { summary } = await publish("B", true);
      const entered = Promise.withResolvers<void>();
      const release = Promise.withResolvers<void>();
      const cleanup = h.historyService.cleanupCompactionFollowUp.bind(h.historyService);
      spyOn(h.historyService, "cleanupCompactionFollowUp").mockImplementationOnce(
        async (...args) => {
          const result = await cleanup(...args);
          entered.resolve();
          await release.promise;
          if (scenario === "late error") throw new Error("Lock disposal failed after commit");
          return result;
        }
      );
      let committed = false;
      const operation = rollback(summary, store, {
        onCommitted: () => {
          committed = true;
        },
      });
      try {
        await entered.promise;
        expect(committed).toBe(true);
        expect(await historyIds()).toEqual(["A"]);
        let successor: string | undefined;
        if (scenario === "failed successor" || scenario === "committed successor") {
          const accepted = scenario === "committed successor";
          const c = await publish("C", false, restart(), accepted);
          expect(c.result.success).toBe(accepted);
          successor = await bytes();
        }
        if (scenario === "reset")
          assert((await new HistoryService(h.config).clearHistory(workspaceId)).success);
        release.resolve();
        const result = await operation;
        assert(result.success);
        expect(result.data.outcome).toBe("applied");
        if (successor) expect(await bytes()).toBe(successor);
        expect((await restart().load(() => true))?.attachments.readFiles).toEqual(
          scenario === "reset"
            ? undefined
            : [scenario === "committed successor" ? "/C.ts" : "/A.ts"]
        );
      } finally {
        release.resolve();
        await operation;
      }
    }
  );

  it("keeps acknowledged carryover eligible until a foreign reset, while pending authority ends", async () => {
    const a = await publish("A");
    assert(a.result.success && a.result.data);
    const receipt = a.result.data;
    expect(await store.isCurrent(receipt, "pending", () => true)).toBe(true);
    expect(await store.consume(receipt)).toBe(true);
    expect(await store.isCurrent(receipt, "pending", () => true)).toBe(false);
    expect(await store.isCurrent(receipt, "carryover", () => true)).toBe(true);
    expect(await store.isCurrent(receipt, "carryover", () => false)).toBe(false);
    expect(await restart().isCurrent(receipt, "carryover", () => true)).toBe(false);
    const b = await publish("B", false, restart());
    assert(b.result.success);
    const successor = await bytes();
    expect(await store.consume(receipt)).toBe(false);
    expect(await bytes()).toBe(successor);
    expect(await store.isCurrent(receipt, "carryover", () => true)).toBe(true);
    assert((await new HistoryService(h.config).clearHistory(workspaceId)).success);
    expect(await store.isCurrent(receipt, "carryover", () => true)).toBe(false);
  });

  it.each(["future", "legacy", "malformed"] as const)(
    "reset preserves %s bytes without trusting them as enrichment",
    async (kind) => {
      const raw =
        kind === "future"
          ? '{"version":9,"opaque":{"keep":true}}\n'
          : kind === "legacy"
            ? '{"version":1,"createdAt":1,"readFiles":["/old.ts"]}\n'
            : "{malformed";
      await fs.writeFile(pendingPath, raw);
      assert((await new HistoryService(h.config).clearHistory(workspaceId)).success);
      await store.discardAfterBoundary();
      expect(await bytes()).toBe(raw);
      expect(await restart().load(() => true)).toBeUndefined();
      if (kind !== "malformed") expect(await bytes()).toBe(raw);
    }
  );

  it("preserves future bytes through mandatory heartbeat cleanup without optional restoration", async () => {
    await publish("A");
    const { summary } = await publish("B", true);
    const future = '{"version":9,"payload":"future owner"}\n';
    await fs.writeFile(pendingPath, future);
    const result = await rollback(summary, restart());
    expect(result).toEqual({ success: true, data: { outcome: "applied", restored: undefined } });
    expect(await historyIds()).toEqual(["A"]);
    expect(await bytes()).toBe(future);
  });

  it("uses an immutable summary capture while its initial pending read is delayed", async () => {
    await publish("A");
    const { summary } = await publish("B", true);
    const entered = Promise.withResolvers<void>();
    const release = Promise.withResolvers<void>();
    const read = fs.readFile;
    let paused = false;
    spyOn(fs, "readFile").mockImplementation((async (...args: Parameters<typeof fs.readFile>) => {
      const contents = await read(...args);
      if (args[0] === pendingPath && !paused) {
        paused = true;
        entered.resolve();
        await release.promise;
      }
      return contents;
    }) as typeof fs.readFile);
    const operation = rollback(summary, restart());
    try {
      await entered.promise;
      assert(summary.metadata);
      summary.id = "replacement";
      summary.metadata.historySequence = 999;
      release.resolve();
      expect((await operation).success).toBe(true);
      expect(await historyIds()).toEqual(["A"]);
    } finally {
      release.resolve();
      await operation;
    }
  });

  it.each(["consume", "load", "discard", "restore"] as const)(
    "lost physical authority during %s cannot affect successor bytes",
    async (operation) => {
      const a = await publish("A");
      assert(a.result.success && a.result.data);
      const heartbeat = operation === "restore" ? await publish("B", true) : undefined;
      if (operation === "discard")
        await h.historyService.getContinuousCompactionJournal(workspaceId).advanceGeneration();
      const entered = Promise.withResolvers<void>();
      const release = Promise.withResolvers<void>();
      const read = fs.readFile;
      let reads = 0;
      spyOn(fs, "readFile").mockImplementation((async (...args: Parameters<typeof fs.readFile>) => {
        const contents = await read(...args);
        if (args[0] === pendingPath && ++reads === (operation === "restore" ? 2 : 1)) {
          entered.resolve();
          await release.promise;
        }
        return contents;
      }) as typeof fs.readFile);
      const task = (
        heartbeat
          ? rollback(heartbeat.summary)
          : operation === "consume"
            ? store.consume(a.result.data)
            : operation === "load"
              ? store.load(() => true)
              : store.discardAfterBoundary()
      ).catch((error: unknown) => error);
      try {
        await entered.promise;
        const lockPath = historyWriteLockPath(h.config.rootDir, workspaceId);
        const token = await fs.readFile(lockPath, "utf8");
        await fs.writeFile(lockPath, token.split(":").slice(0, 2).join(":"));
        await fs.utimes(lockPath, new Date(0), new Date(0));
        await using successor = await acquireProcessFileLock({
          lockPath,
          timeoutMs: 1000,
          label: "consumer successor",
        });
        const future = '{"version":9,"owner":"successor"}\n';
        await fs.writeFile(pendingPath, future);
        release.resolve();
        const result = await task;
        if (operation === "restore")
          expect(result).toEqual({
            success: true,
            data: { outcome: "applied", restored: undefined },
          });
        else expect(result).toBeInstanceOf(Error);
        expect(await bytes()).toBe(future);
        await successor.assertStillOwned();
      } finally {
        release.resolve();
        await task;
      }
    }
  );
});

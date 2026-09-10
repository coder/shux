import { afterEach, beforeEach, describe, expect, it, mock, spyOn } from "bun:test";
import assert from "node:assert/strict";
import * as syncFs from "node:fs";
import * as fs from "node:fs/promises";
import * as path from "node:path";
import * as atomicWrite from "write-file-atomic";
import { createMuxMessage } from "@/common/types/message";
import { acquireProcessFileLock } from "@/node/utils/concurrency/fileLock";
import { CompactionPendingState, type CompactionPendingReceipt } from "./compactionPendingState";
import { HistoryService } from "./historyService";
import { HISTORY_APPEND_PROVENANCE_FILE } from "./historyAppendProvenance";
import { createTestHistoryService } from "./testHistoryService";
import { historyWriteLockPath } from "./workspaceRemoval";

type PublicationInput = Parameters<CompactionPendingState["publishBoundary"]>[0];

describe("inactive atomic pending/history publication", () => {
  const workspaceId = "atomic-pending";
  let h: Awaited<ReturnType<typeof createTestHistoryService>>;
  let pendingPath: string;
  let chatPath: string;
  let store: CompactionPendingState;

  function input(name: string, overrides: Partial<PublicationInput> = {}): PublicationInput {
    return {
      attachments: { diffs: [], loadedSkills: [], readFiles: [`/${name}.ts`] },
      summaryMessage: createMuxMessage(name, "assistant", name, {
        compacted: "user",
        compactionBoundary: true,
        compactionEpoch: 1,
      }),
      tailCopies: [],
      updateExisting: false,
      publication: { generation: undefined },
      isCurrent: () => true,
      shouldPersist: () => true,
      onCommitted: () => undefined,
      ...overrides,
    };
  }

  function restart() {
    return new CompactionPendingState(
      pendingPath,
      new HistoryService(h.config).getCompactionPendingHistory(workspaceId)
    );
  }

  async function historyIds() {
    const result = await h.historyService.getHistoryFromLatestBoundary(workspaceId);
    assert(result.success);
    return result.data.map((row) => row.id);
  }

  beforeEach(async () => {
    h = await createTestHistoryService();
    pendingPath = path.join(h.config.sessionsDir, workspaceId, "post-compaction.json");
    chatPath = path.join(h.config.sessionsDir, workspaceId, "chat.jsonl");
    assert(
      (
        await h.historyService.appendToHistory(
          workspaceId,
          createMuxMessage("seed", "user", "Seed")
        )
      ).success
    );
    store = restart();
  });

  afterEach(async () => {
    mock.restore();
    await h.cleanup();
  });

  it("rejects asynchronous receipt callbacks at compile time", () => {
    const acceptReceipt = (_callback: PublicationInput["onCommitted"]) => undefined;
    acceptReceipt(() => undefined);
    // @ts-expect-error Receipt state must be published before lock disposal admits a successor.
    acceptReceipt(async () => {
      await Promise.resolve();
    });
  });

  it("excludes a second real store until A commits, then restores A when B refuses", async () => {
    const entered = Promise.withResolvers<void>();
    const release = Promise.withResolvers<void>();
    const attempted = Promise.withResolvers<void>();
    const order: string[] = [];
    let paused = false;
    const rm = syncFs.promises.rm;
    spyOn(syncFs.promises, "rm").mockImplementation(async (file, options) => {
      if (String(file).startsWith(`${pendingPath}.continuous-`) && !paused) {
        paused = true;
        order.push("A prepared");
        entered.resolve();
        await release.promise;
      }
      return rm(file, options);
    });
    const foreign = new HistoryService(h.config).getCompactionPendingHistory(workspaceId);
    const second = new CompactionPendingState(pendingPath, {
      withLock: (operation) => {
        attempted.resolve();
        return foreign.withLock(operation);
      },
    });
    const a = store.publishBoundary(
      input("A", {
        onCommitted: () => {
          order.push("A committed");
        },
      })
    );
    await entered.promise;
    const b = second.publishBoundary(
      input("B", {
        shouldPersist: () => {
          order.push("B prepared");
          return false;
        },
      })
    );
    try {
      await attempted.promise;
      expect(order).toEqual(["A prepared"]);
      const pending: unknown = JSON.parse(await fs.readFile(pendingPath, "utf8"));
      expect(pending).toMatchObject({ boundaryMessageId: "A" });
      expect(await fs.readFile(chatPath, "utf8")).not.toContain('"compactionBoundary":true');
    } finally {
      release.resolve();
      await Promise.all([a, b]);
    }
    expect((await a).success).toBe(true);
    expect((await b).success).toBe(false);
    expect(order).toEqual(["A prepared", "A committed", "B prepared"]);
    expect(await historyIds()).toEqual(["A"]);
    expect((await restart().load(() => true))?.attachments.readFiles).toEqual(["/A.ts"]);
  });

  it.each([
    { update: false, tail: false },
    { update: false, tail: true },
    { update: true, tail: false },
    { update: true, tail: true },
  ])(
    "publishes the receipt at rename with append/update and tail combinations (%j)",
    async ({ update, tail }) => {
      const request = input("boundary", {
        updateExisting: update,
        tailCopies: tail ? [createMuxMessage("tail", "user", "Retained")] : [],
      });
      if (update) {
        const streamed = createMuxMessage("boundary", "assistant", "Streaming");
        assert((await h.historyService.appendToHistory(workspaceId, streamed)).success);
        request.summaryMessage.metadata = {
          ...request.summaryMessage.metadata,
          historySequence: streamed.metadata?.historySequence,
        };
      }
      let committed: CompactionPendingReceipt | undefined;
      let cleanupObserved = false;
      request.onCommitted = (receipt) => {
        committed = receipt;
        const rows = syncFs.readFileSync(chatPath, "utf8");
        expect(rows).toContain('"compactionBoundary":true');
        if (tail) expect(rows).toContain('"id":"tail"');
      };
      const rm = syncFs.promises.rm;
      spyOn(syncFs.promises, "rm").mockImplementation((file, options) => {
        if (String(file).startsWith(`${chatPath}.continuous-`)) {
          expect(committed).toBeDefined();
          cleanupObserved = true;
        }
        return rm(file, options);
      });
      const result = await store.publishBoundary(request);
      assert(result.success);
      assert(committed);
      assert(result.data);
      expect(result.data).toBe(committed);
      expect(cleanupObserved).toBe(true);
      expect(await historyIds()).toEqual(tail ? ["boundary", "tail"] : ["boundary"]);
      expect(request.summaryMessage.metadata?.historySequence).toBe(1);
      expect((await restart().load(() => true))?.attachments.readFiles).toEqual(["/boundary.ts"]);
      expect(await store.consume(result.data)).toBe(true);
      expect(await restart().load(() => true)).toBeUndefined();
    }
  );

  it.each(["history write", "cancellation", "snapshot refusal"] as const)(
    "keeps the committed predecessor across precommit %s",
    async (failure) => {
      assert((await store.publishBoundary(input("A"))).success);
      const before = await fs.readFile(chatPath, "utf8");
      let current = true;
      let committed = false;
      const rename = syncFs.renameSync;
      spyOn(syncFs, "renameSync").mockImplementation((from, to) => {
        if (failure === "history write" && to === chatPath)
          throw new Error("injected write failure");
        rename(from, to);
        if (failure === "cancellation" && to === pendingPath) current = false;
      });
      const result = await store.publishBoundary(
        input("B", {
          isCurrent: () => current,
          shouldPersist: () => failure !== "snapshot refusal",
          onCommitted: () => {
            committed = true;
          },
        })
      );
      expect(result.success).toBe(false);
      expect(committed).toBe(false);
      expect(await fs.readFile(chatPath, "utf8")).toBe(before);
      expect((await restart().load(() => true))?.attachments.readFiles).toEqual(["/A.ts"]);
      const pending: unknown = JSON.parse(await fs.readFile(pendingPath, "utf8"));
      expect(pending).toMatchObject({ boundaryMessageId: "A" });
    }
  );

  it.each(
    (["cancel", "refuse", "write failure"] as const).flatMap((failure) =>
      [false, true].map((update) => ({ failure, update }))
    )
  )("keeps the same prepared rows retryable after final %j", async ({ failure, update }) => {
    let current = true;
    let admitted = true;
    let failing = true;
    let committedSequences: Array<number | undefined> | undefined;
    const request = input("B", {
      tailCopies: [createMuxMessage("tail", "user", "Retained")],
      updateExisting: update,
      isCurrent: () => current,
      shouldPersist: () => admitted,
      onCommitted: () => {
        committedSequences = [request.summaryMessage, ...request.tailCopies].map(
          (row) => row.metadata?.historySequence
        );
      },
    });
    if (update) {
      const streamed = createMuxMessage("B", "assistant", "Streaming");
      assert((await h.historyService.appendToHistory(workspaceId, streamed)).success);
      request.summaryMessage.metadata = {
        ...request.summaryMessage.metadata,
        historySequence: streamed.metadata?.historySequence,
      };
    }
    const prepared = [request.summaryMessage, ...request.tailCopies];
    const before = structuredClone(prepared);
    const atomic = atomicWrite.default;
    spyOn(atomicWrite, "default").mockImplementation(
      new Proxy(atomic, {
        async apply(target, _thisArg, args: Parameters<typeof atomic>) {
          const result = await target(...args);
          if (failing && String(args[0]).startsWith(`${chatPath}.continuous-`)) {
            if (failure === "cancel") current = false;
            if (failure === "refuse") admitted = false;
          }
          return result;
        },
      })
    );
    const rename = syncFs.renameSync;
    spyOn(syncFs, "renameSync").mockImplementation((from, to) => {
      if (failing && failure === "write failure" && to === chatPath)
        throw new Error("transient history rename failure");
      rename(from, to);
    });
    expect((await store.publishBoundary(request)).success).toBe(false);
    expect(committedSequences).toBeUndefined();
    expect(prepared).toEqual(before);
    failing = false;
    current = true;
    admitted = true;
    const retry = await store.publishBoundary(request);
    assert(retry.success, retry.success ? undefined : retry.error);
    const history = await h.historyService.getHistoryFromLatestBoundary(workspaceId);
    assert(history.success);
    expect(history.data.map((row) => row.id)).toEqual(["B", "tail"]);
    const durableSequences = history.data.map((row) => row.metadata?.historySequence);
    expect(committedSequences).toEqual(durableSequences);
    expect(prepared.map((row) => row.metadata?.historySequence)).toEqual(durableSequences);
  });

  it.each(["tail", "summary", "updated tail"] as const)(
    "refuses aliased %s objects without consuming the corrected request",
    async (alias) => {
      assert((await store.publishBoundary(input("A"))).success);
      const copy = createMuxMessage("tail", "user", "Retained");
      const request = input("B", { updateExisting: alias === "updated tail" });
      if (request.updateExisting) {
        const streamed = createMuxMessage("B", "assistant", "Streaming");
        assert((await h.historyService.appendToHistory(workspaceId, streamed)).success);
        request.summaryMessage.metadata = {
          ...request.summaryMessage.metadata,
          historySequence: streamed.metadata?.historySequence,
        };
      }
      request.tailCopies = alias === "summary" ? [request.summaryMessage, copy] : [copy, copy];
      const prepared = [request.summaryMessage, copy];
      const before = structuredClone(prepared);
      const files = [
        chatPath,
        pendingPath,
        path.join(path.dirname(chatPath), "chat-archive.jsonl"),
      ];
      const bytes = await Promise.all(files.map((file) => fs.readFile(file, "utf8")));
      expect((await store.publishBoundary(request)).success).toBe(false);
      expect(prepared).toEqual(before);
      expect(await Promise.all(files.map((file) => fs.readFile(file, "utf8")))).toEqual(bytes);
      request.tailCopies = [copy];
      assert((await store.publishBoundary(request)).success);
      const history = await h.historyService.getHistoryFromLatestBoundary(workspaceId);
      assert(history.success);
      expect(history.data.map((row) => row.id)).toEqual(["B", "tail"]);
      expect(prepared.map((row) => row.metadata?.historySequence)).toEqual(
        history.data.map((row) => row.metadata?.historySequence)
      );
    }
  );

  it("refuses reusing the current boundary ID before replacing its committed pending file", async () => {
    assert((await store.publishBoundary(input("A"))).success);
    const before = await fs.readFile(pendingPath, "utf8");
    expect(
      (
        await store.publishBoundary(
          input("A", {
            attachments: { diffs: [], loadedSkills: [], readFiles: ["/refused.ts"] },
          })
        )
      ).success
    ).toBe(false);
    expect(await fs.readFile(pendingPath, "utf8")).toBe(before);
    expect((await restart().load(() => true))?.attachments.readFiles).toEqual(["/A.ts"]);
  });

  it("removes a refused first preparation and allows the same store to publish again", async () => {
    expect(
      (await store.publishBoundary(input("refused", { shouldPersist: () => false }))).success
    ).toBe(false);
    expect(await fs.stat(pendingPath).catch((error: unknown) => error)).toMatchObject({
      code: "ENOENT",
    });
    expect(await historyIds()).toEqual(["seed"]);
    expect((await store.publishBoundary(input("retry"))).success).toBe(true);
    expect((await restart().load(() => true))?.attachments.readFiles).toEqual(["/retry.ts"]);
  });

  it.each([false, true])(
    "restart selects only committed history after a preboundary crash (previous=%s)",
    async (previous) => {
      if (previous) assert((await store.publishBoundary(input("A"))).success);
      let crashImage: string | undefined;
      const rm = syncFs.promises.rm;
      spyOn(syncFs.promises, "rm").mockImplementation(async (file, options) => {
        if (String(file).startsWith(`${pendingPath}.continuous-`) && crashImage === undefined)
          crashImage = await fs.readFile(pendingPath, "utf8");
        return rm(file, options);
      });
      expect(
        (await store.publishBoundary(input("uncommitted", { shouldPersist: () => false }))).success
      ).toBe(false);
      assert(crashImage);
      // Reproduce the exact durable bytes captured after pending rename but before history commit.
      // A process crash at this point skips in-process rollback and leaves this image on disk.
      await fs.writeFile(pendingPath, crashImage);
      expect((await restart().load(() => true))?.attachments.readFiles).toEqual(
        previous ? ["/A.ts"] : undefined
      );
      expect(await historyIds()).toEqual(previous ? ["A"] : ["seed"]);
    }
  );

  it.each(["commit", "refuse", "write failure", "stale", "cancel"] as const)(
    "preserves unsupported future bytes independently of mandatory history (%s)",
    async (outcome) => {
      const future = '{\n  "version": 2, "data": {"keep": true}\n}\n';
      await fs.writeFile(pendingPath, future);
      const before = await fs.readFile(chatPath, "utf8");
      if (outcome === "stale")
        await h.historyService.getContinuousCompactionJournal(workspaceId).advanceGeneration();
      const rename = syncFs.renameSync;
      spyOn(syncFs, "renameSync").mockImplementation((from, to) => {
        if (outcome === "write failure" && to === chatPath) throw new Error("boundary failed");
        rename(from, to);
      });
      let committed = false;
      const result = await store.publishBoundary(
        input("B", {
          isCurrent: () => outcome !== "cancel",
          shouldPersist: () => outcome !== "refuse",
          onCommitted: (receipt) => {
            expect(receipt).toBeUndefined();
            committed = true;
            // Missing optional enrichment cannot erase the mandatory commit flag.
            throw new Error("observer after history-only commit");
          },
        })
      );
      expect(result.success).toBe(outcome === "commit");
      expect(committed).toBe(outcome === "commit");
      if (result.success) expect(result.data).toBeUndefined();
      else expect(await fs.readFile(chatPath, "utf8")).toBe(before);
      expect(await fs.readFile(pendingPath, "utf8")).toBe(future);
      expect(await restart().load(() => true)).toBeUndefined();
    }
  );

  it.each(["read failure", "write failure", "nonempty directory"] as const)(
    "commits mandatory history without enrichment after optional %s",
    async (failure) => {
      if (failure === "nonempty directory") {
        await fs.mkdir(pendingPath);
        await fs.writeFile(path.join(pendingPath, "keep"), "unrelated");
      }
      const read = fs.readFile;
      spyOn(fs, "readFile").mockImplementation(
        new Proxy(read, {
          apply(target, _thisArg, args: Parameters<typeof read>) {
            if (failure === "read failure" && args[0] === pendingPath)
              return Promise.reject(
                Object.assign(new Error("unreadable enrichment"), { code: "EACCES" })
              );
            return target(...args);
          },
        })
      );
      const rename = syncFs.renameSync;
      spyOn(syncFs, "renameSync").mockImplementation((from, to) => {
        if (failure === "write failure" && to === pendingPath) throw new Error("pending failed");
        rename(from, to);
      });
      let committed = false;
      const result = await store.publishBoundary(
        input("B", {
          onCommitted: (receipt) => {
            expect(receipt).toBeUndefined();
            committed = true;
          },
        })
      );
      assert(result.success);
      expect(result.data).toBeUndefined();
      expect(committed).toBe(true);
      expect(await historyIds()).toEqual(["B"]);
      if (failure === "nonempty directory")
        expect(await fs.readFile(path.join(pendingPath, "keep"), "utf8")).toBe("unrelated");
    }
  );

  it.each(["none", "new row", "partial", "malformed", "unreadable"] as const)(
    "admits against fresh held-lock rows and strict partial state without re-entry (%s)",
    async (change) => {
      const entered = Promise.withResolvers<void>();
      const release = Promise.withResolvers<void>();
      const partialPath = path.join(path.dirname(chatPath), "partial.json");
      const held = h.historyService.getCompactionPendingHistory(workspaceId).withLock(async () => {
        entered.resolve();
        await release.promise;
        if (change === "new row")
          await fs.appendFile(
            chatPath,
            JSON.stringify(createMuxMessage("late", "user", "Later")) + "\n"
          );
        if (change === "partial")
          await fs.writeFile(
            partialPath,
            JSON.stringify(createMuxMessage("live", "assistant", "Live"))
          );
        if (change === "malformed") await fs.writeFile(partialPath, "{");
        if (change === "unreadable") await fs.mkdir(partialPath);
      });
      await entered.promise;
      let observed = false;
      const published = store.publishBoundary(
        input("B", {
          shouldPersist: (messages, partial) => {
            observed = true;
            return messages.length === 1 && messages[0]?.id === "seed" && partial === null;
          },
        })
      );
      release.resolve();
      await held;
      expect((await published).success).toBe(change === "none");
      expect(observed).toBe(change !== "malformed" && change !== "unreadable");
    }
  );

  it("eagerly rotates repeated atomic boundaries after the one-time lazy check", async () => {
    await historyIds();
    assert((await store.publishBoundary(input("A"))).success);
    assert((await store.publishBoundary(input("B"))).success);
    const active = await fs.readFile(chatPath, "utf8");
    expect(active).not.toContain('"id":"A"');
    expect(active).not.toContain('"id":"seed"');
    expect(await historyIds()).toEqual(["B"]);
    const all = await h.historyService.getLastMessages(workspaceId, 3);
    assert(all.success);
    expect(all.data.map((row) => row.id)).toEqual(["seed", "A", "B"]);
  });

  it.each([
    "pending stage",
    "boundary stage",
    "rollback read",
    "rollback unlink",
    "rollback stage",
    "postcommit",
    "archive read",
    "rotation stage",
  ] as const)(
    "preserves successor files and provenance when the physical lock is reclaimed at %s",
    async (phase) => {
      if (phase !== "rollback unlink") assert((await store.publishBoundary(input("A"))).success);
      const archivePath = path.join(path.dirname(chatPath), "chat-archive.jsonl");
      const provenancePath = path.join(path.dirname(chatPath), HISTORY_APPEND_PROVENANCE_FILE);
      const targets = [chatPath, archivePath, pendingPath, provenancePath];
      let successor: Awaited<ReturnType<typeof acquireProcessFileLock>> | undefined;
      let committed = false;
      const reclaim = async () => {
        if (successor) return;
        const lockPath = historyWriteLockPath(h.config.rootDir, workspaceId);
        const token = await fs.readFile(lockPath, "utf8");
        await fs.writeFile(lockPath, token.split(":").slice(0, 2).join(":"));
        await fs.utimes(lockPath, new Date(0), new Date(0));
        successor = await acquireProcessFileLock({ lockPath, timeoutMs: 1000, label: "successor" });
        for (const target of targets) await fs.writeFile(target, `successor:${target}`);
      };
      let pendingReads = 0;
      const read = fs.readFile;
      spyOn(fs, "readFile").mockImplementation(
        new Proxy(read, {
          async apply(target, _thisArg, args: Parameters<typeof read>) {
            const pendingRead = args[0] === pendingPath ? ++pendingReads : 0;
            const bytes = await target(...args);
            if (pendingRead === 2 && (phase === "rollback read" || phase === "rollback unlink"))
              await reclaim();
            return bytes;
          },
        })
      );
      let pendingStages = 0;
      let historyStages = 0;
      const atomic = atomicWrite.default;
      spyOn(atomicWrite, "default").mockImplementation(
        new Proxy(atomic, {
          async apply(target, _thisArg, args: Parameters<typeof atomic>) {
            const result = await target(...args);
            const pending = String(args[0]).startsWith(`${pendingPath}.continuous-`);
            const history = String(args[0]).startsWith(`${chatPath}.continuous-`);
            if (pending) pendingStages++;
            if (history) historyStages++;
            if (
              (phase === "pending stage" && pendingStages === 1 && pending) ||
              (phase === "boundary stage" && historyStages === 1 && history) ||
              (phase === "rollback stage" && pendingStages === 2 && pending) ||
              (phase === "rotation stage" && historyStages === 2 && history)
            )
              await reclaim();
            return result;
          },
        })
      );
      const rm = syncFs.promises.rm;
      spyOn(syncFs.promises, "rm").mockImplementation(async (file, options) => {
        if (
          phase === "postcommit" &&
          committed &&
          String(file).startsWith(`${chatPath}.continuous-`)
        )
          await reclaim();
        return rm(file, options);
      });
      const open = fs.open;
      spyOn(fs, "open").mockImplementation(async (file, flags, mode) => {
        const handle = await open(file, flags, mode);
        if (phase === "archive read" && file === archivePath && flags === "a+") await reclaim();
        return handle;
      });
      try {
        const result = await store.publishBoundary(
          input("B", {
            shouldPersist: () => !phase.startsWith("rollback"),
            onCommitted: () => {
              committed = true;
            },
          })
        );
        expect(successor).toBeDefined();
        expect(committed).toBe(["postcommit", "archive read", "rotation stage"].includes(phase));
        expect(result.success).toBe(committed);
        for (const target of targets)
          expect(await fs.readFile(target, "utf8")).toBe(`successor:${target}`);
      } finally {
        await successor?.[Symbol.asyncDispose]();
      }
    }
  );

  it.each(["receipt", "cleanup"] as const)(
    "a postcommit %s failure cannot roll back pending attachments",
    async (failure) => {
      let committed: CompactionPendingReceipt | undefined;
      const rm = syncFs.promises.rm;
      spyOn(syncFs.promises, "rm").mockImplementation((file, options) => {
        if (failure === "cleanup" && String(file).startsWith(`${chatPath}.continuous-`))
          return Promise.reject(new Error("cleanup observer failed"));
        return rm(file, options);
      });
      const request = input("A", {
        tailCopies: [createMuxMessage("tail", "user", "Retained")],
        onCommitted: (receipt) => {
          committed = receipt;
          if (failure === "receipt") throw new Error("receipt observer failed");
        },
      });
      const result = await store.publishBoundary(request);
      assert(result.success);
      assert(committed);
      assert(result.data);
      expect(result.data).toBe(committed);
      const history = await h.historyService.getHistoryFromLatestBoundary(workspaceId);
      assert(history.success);
      expect(history.data.map((row) => row.id)).toEqual(["A", "tail"]);
      expect([request.summaryMessage, ...request.tailCopies].map((row) => row.metadata)).toEqual(
        history.data.map((row) => row.metadata)
      );
      expect((await restart().load(() => true))?.attachments.readFiles).toEqual(["/A.ts"]);
      expect(await store.rollback(result.data, () => true)).toBe(false);
    }
  );
});

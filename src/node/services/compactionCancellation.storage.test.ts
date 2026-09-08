import { afterEach, beforeEach, describe, expect, it, mock, spyOn } from "bun:test";
import assert from "node:assert/strict";
import * as fs from "node:fs/promises";
import * as nodeFs from "node:fs";
import callbackFs from "node:fs";
import * as path from "node:path";
import { createMuxMessage } from "@/common/types/message";
import { SESSION_HISTORY_MAX_LINE_BYTES } from "@/common/constants/contextBudget";
import { CONTINUOUS_COMPACTION_GENERATION_FILE } from "@/constants/continuousCompaction";
import { acquireProcessFileLock } from "@/node/utils/concurrency/fileLock";
import { workspaceFileLocks } from "@/node/utils/concurrency/workspaceFileLocks";
import { HistoryService } from "./historyService";
import { HISTORY_APPEND_PROVENANCE_FILE } from "./historyAppendProvenance";
import { createTestHistoryService } from "./testHistoryService";
import { historyWriteLockPath, removeSessionDirUnderMemoryLocks } from "./workspaceRemoval";
import {
  CompactionCancellation,
  FileCompactionCancellationStorage,
  MalformedCompactionCancellationError,
  type CompactionCancellationMutation,
  type CompactionCancellationRecord,
  type CompactionCancellationStorage,
} from "./compactionCancellation";

type RejectsAsync<Observer> = (() => Promise<void>) extends Observer ? false : true;
type RequireTrue<T extends true> = T;
// Type-only contracts: widening any commit observer to void would admit async state installation.
export type SynchronousCancellationObservers = [
  RequireTrue<RejectsAsync<Parameters<CompactionCancellationStorage["mutate"]>[2]>>,
  RequireTrue<RejectsAsync<Parameters<FileCompactionCancellationStorage["mutate"]>[2]>>,
  RequireTrue<RejectsAsync<Parameters<CompactionCancellationStorage["repair"]>[1]>>,
  RequireTrue<RejectsAsync<Parameters<FileCompactionCancellationStorage["repair"]>[1]>>,
  RequireTrue<
    RejectsAsync<
      Parameters<
        ReturnType<
          HistoryService["getContinuousCompactionJournal"]
        >["advanceGenerationUnderHistoryLock"]
      >[0]
    >
  >,
];

const workspaceId = "cancellation-storage";
const followUp = (text = "Continue") => ({ text, model: "test:model", agentId: "exec" });
const summary = { id: "summary", sequence: 1, pendingFollowUp: { text: "Continue" } };
const record = (nonce: string): CompactionCancellationRecord => ({
  version: 1,
  nonce,
  scope: { kind: "unresolved" },
});
const publication = (
  nonce: string
): Extract<CompactionCancellationMutation, { kind: "publish" }> => ({
  kind: "publish",
  record: record(nonce),
  publication: { attempts: 1 },
});

function afterCompactionStaging(target: string, action: () => void) {
  // write-file-atomic consumes CommonJS fs, so intercept its shared default export.
  const rename = callbackFs.rename;
  spyOn(callbackFs, "rename").mockImplementation(
    Object.assign(
      (...[source, destination, callback]: Parameters<typeof rename>) => {
        rename(source, destination, (error) => {
          if (!error && String(destination).startsWith(`${target}.continuous-`)) action();
          callback(error);
        });
      },
      { __promisify__: rename.__promisify__ }
    )
  );
}

describe("inactive real cancellation storage", () => {
  let h: Awaited<ReturnType<typeof createTestHistoryService>>;
  let storage: FileCompactionCancellationStorage;
  let state: CompactionCancellation;
  let foreign: HistoryService;
  let sessionDir: string;
  const mutationCommitted = mock((_record: CompactionCancellationRecord | null) => undefined);

  beforeEach(async () => {
    mutationCommitted.mockClear();
    h = await createTestHistoryService();
    foreign = new HistoryService(h.config);
    storage = new FileCompactionCancellationStorage(h.historyService, workspaceId);
    state = new CompactionCancellation(storage);
    sessionDir = path.dirname(storage.path);
    expect(
      (
        await h.historyService.appendToHistory(
          workspaceId,
          createMuxMessage("user", "user", "Hello")
        )
      ).success
    ).toBe(true);
  });
  afterEach(async () => {
    mock.restore();
    await h.cleanup();
  });

  it.each(["publish", "narrow", "confirm", "retire"] as const)(
    "reports the exact %s receipt before cleanup or lock release",
    async (phase) => {
      const narrowed: CompactionCancellationRecord = {
        ...record("existing"),
        scope: {
          kind: "summary",
          ...summary,
          pendingFollowUp: { text: "Continue", providerOptions: { omitted: undefined } },
        },
      };
      const existing = phase === "confirm" ? narrowed : record("existing");
      if (phase === "publish") existing.retainUntilReplacement = true;
      await fs.writeFile(storage.path, JSON.stringify(existing));
      const mutation: CompactionCancellationMutation =
        phase === "publish"
          ? publication("replacement")
          : phase === "retire"
            ? { kind: "retire", nonce: existing.nonce }
            : { kind: "narrow", record: narrowed };
      const expected: CompactionCancellationRecord | null =
        phase === "publish"
          ? { ...record("replacement"), retainUntilReplacement: true }
          : phase === "retire"
            ? null
            : {
                ...narrowed,
                scope: {
                  kind: "summary",
                  ...summary,
                  pendingFollowUp: { text: "Continue", providerOptions: {} },
                },
              };
      const lockPath = historyWriteLockPath(h.config.rootDir, workspaceId);
      const cleanup = Promise.withResolvers<void>();
      const release = Promise.withResolvers<void>();
      // Pause real post-commit work so promise settlement cannot masquerade as a receipt.
      const pauseCleanup = async () => {
        cleanup.resolve();
        await release.promise;
      };
      if (phase === "publish" || phase === "narrow") {
        const remove = nodeFs.promises.rm;
        spyOn(nodeFs.promises, "rm").mockImplementation(async (file, options) => {
          if (String(file).startsWith(`${storage.path}.continuous-`)) await pauseCleanup();
          await remove(file, options);
        });
      } else {
        const unlink = fs.unlink;
        spyOn(fs, "unlink").mockImplementation(async (file) => {
          if (file === lockPath) await pauseCleanup();
          await unlink(file);
        });
      }
      const writing = storage.mutate(mutation, () => true, mutationCommitted);
      try {
        await cleanup.promise;
        expect(mutationCommitted).toHaveBeenCalledTimes(1);
        assert.deepEqual(mutationCommitted.mock.calls[0]?.[0], expected);
        expect(await storage.read()).toEqual(expected);
        expect(nodeFs.existsSync(lockPath)).toBe(true);
      } finally {
        release.resolve();
        await writing;
      }
      expect(await writing).toBe("applied");
    }
  );

  it.skipIf(process.platform === "win32").each(["publish", "narrow", "retire"] as const)(
    "keeps %s debt after directory sync fails without losing the visible receipt",
    async (phase) => {
      await state.cancel();
      const previous = (await storage.read())!;
      const syncing = Promise.withResolvers<void>();
      const release = Promise.withResolvers<void>();
      const open = fs.open;
      let fail = true;
      spyOn(fs, "open").mockImplementation(async (...args: Parameters<typeof open>) => {
        const handle = await open(...args);
        if (args[0] === sessionDir && fail) {
          fail = false;
          spyOn(handle, "sync").mockImplementation(async () => {
            syncing.resolve();
            await release.promise;
            throw new Error("directory sync failed");
          });
        }
        return handle;
      });
      const writing =
        phase === "publish"
          ? state.cancel()
          : phase === "narrow"
            ? state.narrow(previous.nonce, summary)
            : state.retire(previous.nonce);
      try {
        await Promise.race([
          syncing.promise,
          writing.then(() => assert.fail("mutation settled without syncing its directory")),
        ]);
        // Fresh disk bytes and the core's blocked read already agree before acknowledgment.
        expect(await state.read()).toEqual(await storage.read());
        expect(state.needsPersistence).toBe(true);
        expect(nodeFs.existsSync(historyWriteLockPath(h.config.rootDir, workspaceId))).toBe(true);
      } finally {
        release.resolve();
        await assert.rejects(writing, /directory sync failed/);
      }
      expect(state.needsPersistence).toBe(true);
      const committed = await storage.read();
      await state.retry();
      expect(state.needsPersistence).toBe(false);
      expect(await storage.read()).toEqual(committed);
    }
  );

  it.each(["generation", "publication", "narrowing", "retirement"] as const)(
    "a displaced history-lock holder cannot commit %s over its successor",
    async (phase) => {
      await state.cancel();
      const original = (await storage.read())!;
      const successor = { ...record("foreign-successor"), retainUntilReplacement: true };
      const generationPath = path.join(sessionDir, CONTINUOUS_COMPACTION_GENERATION_FILE);
      const lockPath = historyWriteLockPath(h.config.rootDir, workspaceId);
      let displaced = false;
      const displace = () => {
        displaced = true;
        // Deterministically model lease reclamation while the first holder is
        // suspended in I/O. The real ownership check must reject this new token.
        nodeFs.writeFileSync(lockPath, `${process.pid}:foreign-holder`);
        nodeFs.writeFileSync(storage.path, JSON.stringify(successor));
        nodeFs.writeFileSync(generationPath, "foreign-generation");
      };
      if (phase === "retirement") {
        const read = nodeFs.promises.readFile;
        spyOn(nodeFs.promises, "readFile").mockImplementation((async (
          ...args: Parameters<typeof read>
        ) => {
          const result = await read(...args);
          if (args[0] === storage.path && !displaced) displace();
          return result;
        }) as typeof read);
      } else {
        const target = phase === "generation" ? generationPath : storage.path;
        afterCompactionStaging(target, () => {
          if (!displaced) displace();
        });
      }
      const mutation: CompactionCancellationMutation =
        phase === "retirement"
          ? { kind: "retire", nonce: original.nonce }
          : phase === "narrowing"
            ? { kind: "narrow", record: { ...original, scope: { kind: "summary", ...summary } } }
            : publication("obsolete-publisher");
      await assert.rejects(
        storage.mutate(mutation, () => true, mutationCommitted),
        /no longer owned/
      );
      expect(displaced).toBe(true);
      expect(mutationCommitted).not.toHaveBeenCalled();
      expect(await storage.read()).toEqual(successor);
      expect(await fs.readFile(generationPath, "utf8")).toBe("foreign-generation");
      expect(await fs.readFile(lockPath, "utf8")).toBe(`${process.pid}:foreign-holder`);
    }
  );

  it.each(["newer", "oversized", "oversized newer"] as const)(
    "preserves %s cancellation and recovery bytes through every refusal path",
    async (kind) => {
      const bytes =
        " ".repeat(kind === "newer" ? 0 : SESSION_HISTORY_MAX_LINE_BYTES) +
        JSON.stringify({ ...record("preserved"), version: kind === "oversized" ? 1 : 2 });
      await fs.writeFile(storage.path, bytes);
      await fs.writeFile(
        path.join(sessionDir, "partial.json"),
        JSON.stringify(
          createMuxMessage("pending", "assistant", "summary", {
            muxMetadata: { type: "compaction-summary", pendingFollowUp: followUp() },
          })
        )
      );
      const before = new Map(
        await Promise.all(
          (await fs.readdir(sessionDir)).map(
            async (file) => [file, await fs.readFile(path.join(sessionDir, file))] as const
          )
        )
      );
      for (const operation of [
        () => storage.read(),
        () =>
          storage.repair(
            () => true,
            () => mutationCommitted(null)
          ),
        () => state.readForReplacement(),
        () => state.cancel(),
      ]) {
        await assert.rejects(
          operation,
          (error: unknown) =>
            error instanceof Error && !(error instanceof MalformedCompactionCancellationError)
        );
        expect((await fs.readdir(sessionDir)).sort()).toEqual([...before.keys()].sort());
        for (const [file, contents] of before)
          expect(await fs.readFile(path.join(sessionDir, file))).toEqual(contents);
      }
      expect(state.repairRevision).toBe(0);
      expect(mutationCommitted).not.toHaveBeenCalled();
    }
  );

  it.each([
    "partial",
    "archive",
    "chat",
    "truncate",
    "pending receipt",
    "final receipt",
    "repair retirement",
  ] as const)(
    "a displaced repair cannot commit %s over successor recovery state",
    async (phase) => {
      const partialPath = path.join(sessionDir, "partial.json");
      const archivePath = path.join(sessionDir, "chat-archive.jsonl");
      const chatPath = path.join(sessionDir, "chat.jsonl");
      const receiptPath = path.join(sessionDir, HISTORY_APPEND_PROVENANCE_FILE);
      const generationPath = path.join(sessionDir, CONTINUOUS_COMPACTION_GENERATION_FILE);
      const lockPath = historyWriteLockPath(h.config.rootDir, workspaceId);
      const pending = createMuxMessage("old-summary", "assistant", "old", {
        muxMetadata: { type: "compaction-summary", pendingFollowUp: followUp() },
      });
      const oldBytes = JSON.stringify(pending);
      await fs.writeFile(storage.path, "{damaged cancellation");
      await fs.writeFile(partialPath, oldBytes);
      await fs.writeFile(archivePath, oldBytes + "\n");
      await fs.writeFile(chatPath, oldBytes + "\n");
      if (phase === "truncate") {
        await fs.writeFile(`${archivePath}.truncate`, oldBytes + "\n");
        await fs.writeFile(`${archivePath}.truncate.json`, "damaged truncate marker");
      }
      const successor = { ...record("foreign-repair-successor"), retainUntilReplacement: true };
      const expected = new Map([
        [storage.path, JSON.stringify(successor)],
        [generationPath, "foreign-generation"],
        [partialPath, JSON.stringify({ ...pending, id: "foreign-partial" })],
        [archivePath, JSON.stringify({ ...pending, id: "foreign-archive" }) + "\n"],
        [chatPath, JSON.stringify({ ...pending, id: "foreign-chat" }) + "\n"],
        [receiptPath, "foreign-provenance-receipt"],
      ]);
      let displaced = false;
      const displace = () => {
        if (displaced) return;
        displaced = true;
        nodeFs.writeFileSync(lockPath, `${process.pid}:foreign-repair-holder`);
        for (const [file, contents] of expected) nodeFs.writeFileSync(file, contents);
      };
      if (phase === "partial" || phase === "archive" || phase === "chat") {
        afterCompactionStaging(
          { partial: partialPath, archive: archivePath, chat: chatPath }[phase],
          displace
        );
      } else if (phase === "truncate") {
        const remove = fs.rm;
        spyOn(fs, "rm").mockImplementation(async (file, options) => {
          await remove(file, options);
          if (file === archivePath) displace();
        });
      } else if (phase === "repair retirement") {
        const rename = fs.rename;
        spyOn(fs, "rename").mockImplementation(async (source, destination) => {
          await rename(source, destination);
          if (
            destination === receiptPath &&
            (JSON.parse(nodeFs.readFileSync(receiptPath, "utf8")) as { state?: unknown }).state ===
              "stable"
          )
            displace();
        });
      } else {
        const open = fs.open;
        spyOn(fs, "open").mockImplementation(async (...args: Parameters<typeof open>) => {
          const handle = await open(...args);
          if (String(args[0]).startsWith(`${receiptPath}.`) && String(args[0]).endsWith(".tmp")) {
            const close = handle.close.bind(handle);
            spyOn(handle, "close").mockImplementation(async () => {
              await close();
              const receipt: unknown = JSON.parse(nodeFs.readFileSync(args[0], "utf8"));
              const expectedState = phase === "pending receipt" ? "pending" : "stable";
              if (
                receipt &&
                typeof receipt === "object" &&
                "state" in receipt &&
                receipt.state === expectedState
              )
                displace();
            });
          }
          return handle;
        });
      }
      const committed = mock(() => undefined);
      await assert.rejects(
        storage.repair(() => true, committed),
        /no longer owned/
      );
      expect(displaced).toBe(true);
      expect(committed).not.toHaveBeenCalled();
      for (const [file, contents] of expected)
        expect(await fs.readFile(file, "utf8")).toBe(contents);
      expect(await fs.readFile(lockPath, "utf8")).toBe(`${process.pid}:foreign-repair-holder`);
    }
  );

  it("fresh reads distinguish absence, malformed bytes and I/O errors", async () => {
    expect(await storage.read()).toBeNull();
    await state.cancel();
    const first = (await state.read())!;
    const other = new FileCompactionCancellationStorage(foreign, workspaceId);
    expect(await other.read()).toEqual(first);
    const loaded = (await other.read())!;
    loaded.nonce = "changed locally";
    expect(await other.read()).toEqual(first);
    expect((await fs.stat(storage.path)).mode & 0o777).toBe(0o600);
    await fs.writeFile(storage.path, "{private unfinished request");
    await assert.rejects(storage.read(), MalformedCompactionCancellationError);
    await fs.rm(storage.path);
    await fs.mkdir(storage.path);
    await assert.rejects(storage.read(), (error: unknown) => {
      expect(error).not.toBeInstanceOf(MalformedCompactionCancellationError);
      return (error as NodeJS.ErrnoException).code === "EISDIR";
    });
    await assert.rejects(
      storage.repair(
        () => true,
        () => assert.fail("I/O is not repairable")
      )
    );
    expect((await fs.stat(storage.path)).isDirectory()).toBe(true);
  });

  it("serializes with the shared in-process history mutex", async () => {
    const entered = Promise.withResolvers<void>();
    const release = Promise.withResolvers<void>();
    const held = workspaceFileLocks.withLock(workspaceId, async () => {
      entered.resolve();
      await release.promise;
    });
    await entered.promise;
    const stopping = storage.mutate(publication("locked"), () => true, mutationCommitted);
    // Queued behind Stop on the same real mutex, this callback observes its commit.
    const following = workspaceFileLocks.withLock(workspaceId, async () => {
      expect(await storage.read()).not.toBeNull();
    });
    try {
      expect(await storage.read()).toBeNull();
    } finally {
      release.resolve();
    }
    await Promise.all([held, stopping, following]);
  });

  it("waits on the exact cross-instance history file lock before observing a successor", async () => {
    const lockPath = historyWriteLockPath(h.config.rootDir, workspaceId);
    const lock = await acquireProcessFileLock({ lockPath, timeoutMs: 1000, label: "test holder" });
    const attempted = Promise.withResolvers<void>();
    const link = fs.link;
    spyOn(fs, "link").mockImplementation(async (source, destination) => {
      try {
        return await link(source, destination);
      } catch (error) {
        if (destination === lockPath) attempted.resolve();
        throw error;
      }
    });
    const obsolete = publication("obsolete");
    obsolete.publication.attempts = 2;
    obsolete.publication.predecessor = { nonce: null, generation: undefined };
    const writing = storage.mutate(obsolete, () => true, mutationCommitted);
    try {
      await attempted.promise;
      expect(await storage.read()).toBeNull();
      // A cooperating foreign owner publishes while retaining the actual file lock.
      await fs.writeFile(storage.path, JSON.stringify(record("successor")));
      await foreign.getContinuousCompactionJournal(workspaceId).advanceGenerationUnderHistoryLock();
    } finally {
      await lock[Symbol.asyncDispose]();
    }
    expect(await writing).toBe("superseded");
    expect((await storage.read())?.nonce).toBe("successor");
  });

  it("protects foreign successor nonces from narrow, ordinary and witnessed retirement", async () => {
    await state.cancel();
    const old = (await state.read())!;
    const successor = new CompactionCancellation(
      new FileCompactionCancellationStorage(foreign, workspaceId)
    );
    await successor.cancel({ retainUntilReplacement: true });
    const expected = await successor.read();
    for (const mutation of [
      { kind: "narrow", record: { ...old, scope: { kind: "summary", ...summary } } },
      { kind: "retire", nonce: old.nonce },
      { kind: "retire", nonce: old.nonce, replacementWitness: { nonce: old.nonce } },
    ] satisfies CompactionCancellationMutation[]) {
      expect(await storage.mutate(mutation, () => true, mutationCommitted)).toBe("superseded");
      expect(await storage.read()).toEqual(expected);
    }
    await state.cancel();
    expect((await storage.read())?.retainUntilReplacement).toBe(true);
  });

  it("narrows and retires only the exact current nonce", async () => {
    await state.cancel();
    const old = (await state.read())!;
    await state.narrow(old.nonce, summary);
    expect((await storage.read())?.scope).toEqual({ kind: "summary", ...summary });
    expect(await state.retire(old.nonce)).toBe("applied");
    expect(await storage.read()).toBeNull();
  });

  it("refuses a narrowing it could not read without replacing the current Stop", async () => {
    await state.cancel();
    const current = (await storage.read())!;
    const scope = {
      kind: "summary" as const,
      ...summary,
      pendingFollowUp: { text: "x".repeat(SESSION_HISTORY_MAX_LINE_BYTES) },
    };
    await assert.rejects(
      storage.mutate(
        { kind: "narrow", record: { ...current, scope } },
        () => true,
        mutationCommitted
      )
    );
    expect(await storage.read()).toEqual(current);
    expect(mutationCommitted).not.toHaveBeenCalled();
  });

  it("requires an explicit in-lock verifier and rechecks local authority after verification", async () => {
    await state.cancel({ retainUntilReplacement: true });
    const retained = (await storage.read())!;
    const mutation: CompactionCancellationMutation = {
      kind: "retire",
      nonce: retained.nonce,
      replacementWitness: { nonce: retained.nonce },
    };
    expect(
      await storage.mutate({ kind: "retire", nonce: retained.nonce }, () => true, mutationCommitted)
    ).toBe("superseded");
    await assert.rejects(
      storage.mutate(mutation, () => true, mutationCommitted),
      /not configured/
    );
    const refusing = new FileCompactionCancellationStorage(foreign, workspaceId, () =>
      Promise.resolve(false)
    );
    await assert.rejects(
      refusing.mutate(mutation, () => true, mutationCommitted),
      /not verified/
    );
    expect(await storage.read()).toEqual(retained);
    let current = true;
    const verifying = new FileCompactionCancellationStorage(
      foreign,
      workspaceId,
      async (witness) => {
        expect(witness.nonce).toBe(retained.nonce);
        expect(
          await fs.readFile(historyWriteLockPath(h.config.rootDir, workspaceId), "utf8")
        ).not.toBe("");
        current = false;
        return true;
      }
    );
    expect(await verifying.mutate(mutation, () => current, mutationCommitted)).toBe("superseded");
    expect(await storage.read()).toEqual(retained);
    // This injected authority exercises the seam only; real accepted-row proof belongs to H2b.
    expect(await verifying.mutate(mutation, () => true, mutationCommitted)).toBe("applied");
    expect(await storage.read()).toBeNull();
  });

  it("records generation advancement before a later failure and retries its exact frontier", async () => {
    await fs.mkdir(storage.path); // An unreadable predecessor whose rename will fail.
    await assert.rejects(state.cancel());
    const failed = (await state.read())!;
    expect(failed.retainUntilReplacement).toBe(true);
    const journal = h.historyService.getContinuousCompactionJournal(workspaceId);
    expect(await journal.captureGeneration()).toBeDefined();
    await fs.rm(storage.path, { recursive: true });
    // The predecessor changed from unreadable to absent: this is not the recorded frontier.
    expect(await state.retry()).toBe("superseded");
    expect(await storage.read()).toBeNull();

    const mutation = publication("retry-me");
    const advance = journal.advanceGenerationUnderHistoryLock.bind(journal);
    spyOn(journal, "advanceGenerationUnderHistoryLock").mockImplementationOnce(async (...args) => {
      await advance(...args);
      expect(mutation.publication.predecessor?.generation).toBe(
        await journal.captureGenerationUnderHistoryLock()
      );
      throw new Error("after generation commit");
    });
    await assert.rejects(
      storage.mutate(mutation, () => true, mutationCommitted),
      /after generation commit/
    );
    mutation.publication.attempts++;
    expect(await storage.mutate(mutation, () => true, mutationCommitted)).toBe("applied");
    expect((await storage.read())?.nonce).toBe("retry-me");
  });

  it.each(["unobserved", "admitted", "advanced"] as const)(
    "a failed %s publication never adopts a foreign generation on retry",
    async (stage) => {
      const journal = h.historyService.getContinuousCompactionJournal(workspaceId);
      const mutation = publication("stale");
      if (stage === "unobserved") {
        spyOn(journal, "captureGenerationUnderHistoryLock").mockRejectedValueOnce(
          new Error("capture failed")
        );
      } else if (stage === "admitted") {
        spyOn(journal, "advanceGenerationUnderHistoryLock").mockRejectedValueOnce(
          new Error("advance failed")
        );
      } else {
        const advance = journal.advanceGenerationUnderHistoryLock.bind(journal);
        spyOn(journal, "advanceGenerationUnderHistoryLock").mockImplementationOnce(
          async (...args) => {
            await advance(...args);
            throw new Error("after advance");
          }
        );
      }
      await assert.rejects(storage.mutate(mutation, () => true, mutationCommitted));
      await foreign.getContinuousCompactionJournal(workspaceId).advanceGeneration();
      const expected = await fs.readFile(
        path.join(sessionDir, CONTINUOUS_COMPACTION_GENERATION_FILE)
      );
      mutation.publication.attempts++;
      if (stage === "unobserved") {
        await assert.rejects(
          storage.mutate(mutation, () => true, mutationCommitted),
          /frontier was not captured/
        );
      } else {
        expect(await storage.mutate(mutation, () => true, mutationCommitted)).toBe("superseded");
      }
      expect(await storage.read()).toBeNull();
      expect(
        await fs.readFile(path.join(sessionDir, CONTINUOUS_COMPACTION_GENERATION_FILE))
      ).toEqual(expected);
    }
  );

  it("unobserved failures keep Stop debt blocking until a new explicit Stop captures a frontier", async () => {
    spyOn(
      h.historyService.getContinuousCompactionJournal(workspaceId),
      "captureGenerationUnderHistoryLock"
    ).mockRejectedValueOnce(new Error("generation read failed"));
    await assert.rejects(state.cancel(), /generation read failed/);
    const failed = (await state.read())!;
    await foreign.getContinuousCompactionJournal(workspaceId).advanceGeneration();
    await assert.rejects(state.retry(), /frontier was not captured/);
    expect(state.needsPersistence).toBe(true);
    expect(state.blocksRecovery).toBe(true);
    expect(await state.read()).toEqual(failed);
    expect(await storage.read()).toBeNull();
    await assert.rejects(state.readForReplacement(), /frontier was not captured/);
    expect(await state.cancel()).toBe("applied");
    expect((await storage.read())?.nonce).not.toBe(failed.nonce);
    expect(state.needsPersistence).toBe(false);
  });

  it("preserves the exact debt across failed unlink without deleting a later Stop", async () => {
    await state.cancel();
    const old = (await state.read())!;
    const remove = nodeFs.rmSync;
    let fail = true;
    spyOn(nodeFs, "rmSync").mockImplementation((filePath, options) => {
      if (filePath === storage.path && fail) {
        fail = false;
        throw new Error("unlink failed");
      }
      return remove(filePath, options);
    });
    await assert.rejects(state.retire(old.nonce), /unlink failed/);
    expect(state.blocksRecovery).toBe(true);
    expect(await storage.read()).toEqual(old);
    const successor = new CompactionCancellation(
      new FileCompactionCancellationStorage(foreign, workspaceId)
    );
    await successor.cancel();
    expect(await state.retry()).toBe("superseded");
    expect(await state.read()).toEqual(await successor.read());
  });

  it("retries a failed sidecar rename without losing its nonce or accepting a foreign frontier", async () => {
    const rename = nodeFs.renameSync;
    let fail = true;
    spyOn(nodeFs, "renameSync").mockImplementation((source, destination) => {
      if (destination === storage.path && fail) {
        fail = false;
        throw new Error("cancellation rename failed");
      }
      return rename(source, destination);
    });
    await assert.rejects(state.cancel(), /cancellation rename failed/);
    const failed = (await state.read())!;
    expect(state.blocksRecovery).toBe(true);
    expect(await storage.read()).toBeNull();
    expect(await state.retry()).toBe("applied");
    expect(await storage.read()).toEqual(failed);
  });

  it("a locally superseded publication cannot rename its staged cancellation", async () => {
    let current = true;
    const journal = h.historyService.getContinuousCompactionJournal(workspaceId);
    const advance = journal.advanceGenerationUnderHistoryLock.bind(journal);
    spyOn(journal, "advanceGenerationUnderHistoryLock").mockImplementationOnce(async (...args) => {
      await advance(...args);
      current = false;
    });
    expect(await storage.mutate(publication("stale"), () => current, mutationCommitted)).toBe(
      "superseded"
    );
    expect(await storage.read()).toBeNull();
    expect((await fs.readdir(sessionDir)).some((file) => file.includes(".continuous-"))).toBe(
      false
    );
  });

  it("Stop publishes even when real truncate recovery cannot read its marker", async () => {
    await fs.mkdir(path.join(sessionDir, "chat-archive.jsonl.truncate.json"));
    expect(
      (
        await h.historyService.appendToHistory(
          workspaceId,
          createMuxMessage("blocked", "user", "blocked")
        )
      ).success
    ).toBe(false);
    expect(await state.cancel()).toBe("applied");
    expect(await storage.read()).not.toBeNull();
  });

  it.each([
    "{broken",
    JSON.stringify({ ...record("bad"), retainUntilReplacement: "unknown" }),
    '{"version":1,"nonce":"duplicate","retainUntilReplacement":true,"retainUntilReplacement":false,"scope":{"kind":"unresolved"}}',
    String.raw`{"version":1,"nonce":"escaped","retainUntilReplacement":true,"ret\u0061inUntilReplacement":false,"scope":{"kind":"unresolved"}}`,
    '{"version":1,"nonce":"nested","scope":{"kind":"summary","id":"summary","pendingFollowUp":{"text":"old","text":"new"}}}',
  ])(
    "repairs malformed cancellation, syncs its directory, and preserves raw privacy floors (%s)",
    async (bytes) => {
      const summaryRow = createMuxMessage("summary", "assistant", "summary", {
        muxMetadata: { type: "compaction-summary", pendingFollowUp: followUp() },
      });
      const rawFloor = Buffer.concat([
        Buffer.from('{"metadata":{"contextBoundaryKind":"reset"},'),
        Buffer.from([0xff]),
        Buffer.from("\n"),
      ]);
      for (const file of ["chat-archive.jsonl", "chat.jsonl"]) {
        await fs.writeFile(
          path.join(sessionDir, file),
          Buffer.concat([rawFloor, Buffer.from(JSON.stringify(summaryRow) + "\n")])
        );
      }
      await fs.writeFile(storage.path, bytes);
      const journal = h.historyService.getContinuousCompactionJournal(workspaceId);
      const generation = await journal.captureGeneration();
      let syncedRepair = false;
      const open = fs.open;
      spyOn(fs, "open").mockImplementation(async (...args: Parameters<typeof open>) => {
        const handle = await open(...args);
        if (args[0] === sessionDir) {
          const sync = handle.sync.bind(handle);
          spyOn(handle, "sync").mockImplementation(async () => {
            await sync();
            syncedRepair ||= state.repairRevision === 1;
          });
        }
        return handle;
      });
      expect(await state.read()).toBeNull();
      expect(state.repairRevision).toBe(1);
      if (process.platform !== "win32") expect(syncedRepair).toBe(true);
      expect(await journal.captureGeneration()).not.toBe(generation);
      for (const file of ["chat-archive.jsonl", "chat.jsonl"]) {
        const repaired = await fs.readFile(path.join(sessionDir, file));
        expect(repaired.subarray(0, rawFloor.length)).toEqual(rawFloor);
        expect(repaired.toString()).not.toContain('"pendingFollowUp"');
      }
      const history = await foreign.getHistoryFromLatestBoundary(workspaceId, 99);
      assert(history.success);
      expect(history.data.map((row) => row.id)).toEqual(["summary"]);
    }
  );

  it("retains malformed cancellation across partial repair and neutralizes restored summaries on retry", async () => {
    const summaryRow = createMuxMessage("restored", "assistant", "summary", {
      muxMetadata: { type: "compaction-summary", pendingFollowUp: followUp() },
    });
    const archivePath = path.join(sessionDir, "chat-archive.jsonl");
    expect((await h.historyService.writePartial(workspaceId, summaryRow)).success).toBe(true);
    await fs.writeFile(`${archivePath}.truncate`, JSON.stringify(summaryRow) + "\n");
    await fs.writeFile(`${archivePath}.truncate.json`, "malformed transaction");
    await fs.writeFile(storage.path, "{bad cancellation");
    const read = fs.readFile;
    let fail = true;
    spyOn(fs, "readFile").mockImplementation((async (...args: Parameters<typeof fs.readFile>) => {
      if (args[0] === path.join(sessionDir, "chat.jsonl") && fail) {
        fail = false;
        throw new Error("active history read failed");
      }
      return read(...args);
    }) as typeof fs.readFile);
    await assert.rejects(state.read(), /active history read failed/);
    expect(await fs.readFile(storage.path, "utf8")).toBe("{bad cancellation");
    expect(await fs.readFile(archivePath, "utf8")).not.toContain('"pendingFollowUp"');
    expect(state.repairRevision).toBe(0);
    expect((await foreign.readPartial(workspaceId))?.metadata?.muxMetadata).toEqual({
      type: "compaction-summary",
    });
    expect(await state.read()).toBeNull();
    expect(state.repairRevision).toBe(1);
    const history = await foreign.getLastMessages(workspaceId, 10);
    assert(history.success);
    expect(history.data[0]?.metadata?.muxMetadata).toEqual({ type: "compaction-summary" });
  });

  it("neutralizes the captured partial follow-up while preserving its recovery fields and eventual commit", async () => {
    const partial = createMuxMessage("partial-summary", "assistant", "summary", {
      historySequence: 1,
      contextBoundaryKind: "reset",
      muxMetadata: { type: "compaction-summary", pendingFollowUp: followUp() },
    });
    expect((await h.historyService.writePartial(workspaceId, partial)).success).toBe(true);
    const before = (await foreign.readPartial(workspaceId))!;
    await fs.writeFile(storage.path, "{broken cancellation");
    expect(await state.read()).toBeNull();
    expect(await foreign.readPartial(workspaceId)).toEqual({
      ...before,
      metadata: { ...before.metadata, muxMetadata: { type: "compaction-summary" } },
    });
    expect((await foreign.commitPartial(workspaceId)).success).toBe(true);
    const history = await h.historyService.getLastMessages(workspaceId, 1);
    assert(history.success);
    expect(history.data[0]?.id).toBe(partial.id);
    expect(history.data[0]?.metadata?.muxMetadata).toEqual({ type: "compaction-summary" });
  });

  it("a superseded partial repair leaves a queued foreign successor intact", async () => {
    const old = createMuxMessage("old-partial", "assistant", "old", {
      muxMetadata: { type: "compaction-summary", pendingFollowUp: followUp("old request") },
    });
    const successor = createMuxMessage("new-partial", "assistant", "new", {
      muxMetadata: { type: "compaction-summary", pendingFollowUp: followUp("new request") },
    });
    expect((await h.historyService.writePartial(workspaceId, old)).success).toBe(true);
    await fs.writeFile(storage.path, "{broken cancellation");
    const entered = Promise.withResolvers<void>();
    const release = Promise.withResolvers<void>();
    const read = fs.readFile;
    let held = false;
    spyOn(fs, "readFile").mockImplementation((async (...args: Parameters<typeof fs.readFile>) => {
      const result = await read(...args);
      if (args[0] === path.join(sessionDir, "partial.json") && !held) {
        held = true;
        entered.resolve();
        await release.promise;
      }
      return result;
    }) as typeof fs.readFile);
    let current = true;
    const committed = mock(() => undefined);
    const repairing = storage.repair(() => current, committed);
    await entered.promise;
    const writing = foreign.writePartial(workspaceId, successor);
    current = false;
    release.resolve();
    expect(await repairing).toBeNull();
    expect((await writing).success).toBe(true);
    expect(await foreign.readPartial(workspaceId)).toMatchObject(successor);
    expect(await fs.readFile(storage.path, "utf8")).toBe("{broken cancellation");
    expect(committed).not.toHaveBeenCalled();
  });

  it.each(["JSON", "schema", "privacy", "I/O"])(
    "retains cancellation on unsafe partial %s",
    async (damage) => {
      const partialPath = path.join(sessionDir, "partial.json");
      const partial = createMuxMessage("partial", "assistant", "summary", {
        muxMetadata: { type: "compaction-summary", pendingFollowUp: followUp() },
      });
      const contents =
        damage === "JSON"
          ? "{broken partial"
          : damage === "schema"
            ? JSON.stringify({ ...partial, parts: null })
            : JSON.stringify(partial).replace(
                '"metadata":',
                '"metadata":{"contextBoundaryKind":"reset"},"metadata":'
              );
      if (damage === "I/O") await fs.mkdir(partialPath);
      else await fs.writeFile(partialPath, contents);
      await fs.writeFile(storage.path, "{broken cancellation");
      await assert.rejects(state.read());
      expect(await fs.readFile(storage.path, "utf8")).toBe("{broken cancellation");
      expect(state.repairRevision).toBe(0);
      if (damage !== "I/O") expect(await fs.readFile(partialPath, "utf8")).toBe(contents);
    }
  );

  it("rereads valid successors under the repair lock and guards a repair superseded during I/O", async () => {
    await fs.writeFile(storage.path, "{bad");
    await assert.rejects(storage.read(), MalformedCompactionCancellationError);
    const successor = new CompactionCancellation(
      new FileCompactionCancellationStorage(foreign, workspaceId)
    );
    await successor.cancel({ retainUntilReplacement: true });
    const committed = mock(() => undefined);
    expect(await storage.repair(() => true, committed)).toEqual(await successor.read());
    expect(committed).not.toHaveBeenCalled();

    await fs.writeFile(storage.path, "{bad again");
    let current = true;
    const journal = h.historyService.getContinuousCompactionJournal(workspaceId);
    const advance = journal.advanceGenerationUnderHistoryLock.bind(journal);
    spyOn(journal, "advanceGenerationUnderHistoryLock").mockImplementationOnce(async (...args) => {
      await advance(...args);
      current = false;
    });
    expect(await storage.repair(() => current, committed)).toBeNull();
    expect(await fs.readFile(storage.path, "utf8")).toBe("{bad again");
    expect(committed).not.toHaveBeenCalled();
  });

  it.each(["damaged parts", "ambiguous reset"])(
    "retains cancellation when clearing a %s summary would compromise repair safety",
    async (damage) => {
      const row = createMuxMessage("damaged", "assistant", "summary", {
        muxMetadata: { type: "compaction-summary", pendingFollowUp: followUp() },
      });
      const raw =
        damage === "damaged parts"
          ? JSON.stringify({ ...row, parts: null })
          : JSON.stringify(row).replace(
              '"metadata":',
              '"metadata":{"contextBoundaryKind":"reset"},"metadata":'
            );
      const chatPath = path.join(sessionDir, "chat.jsonl");
      await fs.writeFile(chatPath, raw + "\n");
      await fs.writeFile(storage.path, "{damaged cancellation");
      await assert.rejects(state.read(), /Cannot safely neutralize/);
      expect(await fs.readFile(chatPath, "utf8")).toBe(raw + "\n");
      expect(await fs.readFile(storage.path, "utf8")).toBe("{damaged cancellation");
      // Explicit intervention remains usable without dropping an unknown full-clear obligation.
      expect(await state.readForReplacement()).toMatchObject({ retainUntilReplacement: true });
    }
  );

  it("never resurrects a removed session through publication or repair", async () => {
    await state.cancel();
    await removeSessionDirUnderMemoryLocks({
      rootDir: h.config.rootDir,
      sessionDir,
      workspaceId,
      attemptId: "removal",
    });
    await assert.rejects(state.cancel(), /was removed/);
    await assert.rejects(
      storage.repair(
        () => true,
        () => assert.fail("removed")
      ),
      /was removed/
    );
    await assert.rejects(fs.stat(sessionDir), { code: "ENOENT" });
  });
});

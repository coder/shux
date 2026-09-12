import { afterEach, beforeEach, describe, expect, it, mock, spyOn } from "bun:test";
import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import * as fs from "node:fs/promises";
import * as nodeFs from "node:fs";
import callbackFs from "node:fs";
import * as path from "node:path";
import { createMuxMessage, type MuxMessage } from "@/common/types/message";
import { SESSION_HISTORY_MAX_LINE_BYTES } from "@/common/constants/contextBudget";
import { CONTINUOUS_COMPACTION_GENERATION_FILE } from "@/constants/continuousCompaction";
import { acquireProcessFileLock } from "@/node/utils/concurrency/fileLock";
import { workspaceFileLocks } from "@/node/utils/concurrency/workspaceFileLocks";
import { HistoryService } from "./historyService";
import { MessageQueue } from "./messageQueue";
import { Ok } from "@/common/types/result";
import { CompactionHandler } from "./compactionHandler";
import { HISTORY_APPEND_PROVENANCE_FILE } from "./historyAppendProvenance";
import { createTestHistoryService } from "./testHistoryService";
import { historyWriteLockPath, removeSessionDirUnderMemoryLocks } from "./workspaceRemoval";
import {
  CompactionCancellation,
  CompactionCancellationReadRefusedError,
  FileCompactionCancellationStorage,
  MalformedCompactionCancellationError,
  type CompactionCancellationMutation,
  type CompactionCancellationRecord,
  type CompactionCancellationStorage,
  type CompactionReplacementCapture,
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

  it.each([
    "peer",
    "cached absence",
    "previous supersession",
    "local newer Stop",
    "new Stop",
    "Stop ABA",
    "missing witness",
    "altered witness",
    "missing capture",
    "mutated argument",
    "retry",
    "foreign retry",
  ] as const)(
    "peer retirement requires the original generation and verified witness (%s)",
    async (phase) => {
      state = new CompactionCancellation(
        h.historyService.getCompactionCancellationStorage(workspaceId)
      );
      await state.cancel({ retainUntilReplacement: true });
      const captured = await h.historyService.captureCompactionReplacement(workspaceId);
      assert(captured.success && captured.data.nonce);
      const expected = { ...captured.data };
      const accepted = await h.historyService.acceptCompactionReplacement(
        workspaceId,
        captured.data,
        { kind: "append", messages: [createMuxMessage("accepted", "user", "fresh input")] },
        { isCurrent: () => true, onCommitted: () => undefined }
      );
      assert(accepted.success && accepted.data.kind === "accepted" && accepted.data.witness);
      const peer = new CompactionCancellation(
        foreign.getCompactionCancellationStorage(workspaceId)
      );
      await peer.read();
      expect(await peer.retireReplacement(accepted.data.witness)).toBe("applied");
      if (phase === "cached absence") expect(await state.read()).toBeNull();
      if (phase === "previous supersession") {
        expect(await state.retireReplacement(accepted.data.witness)).toBe("superseded");
      }
      if (phase === "local newer Stop") await state.cancel();
      const newerStop = async (retire: boolean) => {
        await peer.cancel();
        const current = await peer.read();
        assert(current);
        if (retire) await peer.retire(current.nonce);
      };
      if (phase === "new Stop" || phase === "Stop ABA") await newerStop(phase === "Stop ABA");
      if (phase === "missing witness" || phase === "altered witness") {
        const chat = path.join(sessionDir, "chat.jsonl");
        const rows = (await fs.readFile(chat, "utf8"))
          .trimEnd()
          .split("\n")
          .map((line) => JSON.parse(line) as MuxMessage);
        const changed =
          phase === "missing witness"
            ? rows.filter((row) => row.id !== "accepted")
            : rows.map((row) => (row.id === "accepted" ? { ...row, role: "system" } : row));
        await fs.writeFile(chat, changed.map((row) => JSON.stringify(row)).join("\n") + "\n");
      }
      const notifications: unknown[] = [];
      let syncedAfterNotification = false;
      const open = fs.open;
      spyOn(fs, "open").mockImplementation(async (...args: Parameters<typeof open>) => {
        const handle = await open(...args);
        if (args[0] === sessionDir) {
          const sync = handle.sync.bind(handle);
          spyOn(handle, "sync").mockImplementation(async () => {
            await sync();
            if (notifications.length) syncedAfterNotification = true;
          });
        }
        return handle;
      });
      if (phase === "retry" || phase === "foreign retry") {
        const lock = h.historyService.withCompactionStorageLock.bind(h.historyService);
        spyOn(h.historyService, "withCompactionStorageLock").mockImplementationOnce(
          async (...args) => {
            await lock(...args);
            throw new Error("post-confirmation cleanup failed");
          }
        );
      }
      const retiring = state.retireReplacement(
        accepted.data.witness,
        (before, after) => {
          expect(nodeFs.existsSync(historyWriteLockPath(h.config.rootDir, workspaceId))).toBe(true);
          notifications.push([before, after]);
          return undefined;
        },
        phase === "missing capture" ? undefined : captured.data
      );
      if (phase === "mutated argument" || phase === "retry" || phase === "foreign retry") {
        captured.data.nonce = "not-the-original";
        captured.data.generation = "not-the-original";
        captured.data.cancellationVersion = 2;
      }
      if (phase === "local newer Stop") {
        expect(await retiring).toBeUndefined();
        expect(notifications).toEqual([]);
      } else if (phase === "missing witness" || phase === "altered witness") {
        await assert.rejects(retiring, /witness was not verified/);
        expect(notifications).toEqual([]);
      } else if (phase === "new Stop" || phase === "Stop ABA" || phase === "missing capture") {
        expect(await retiring).toBe("superseded");
        expect(notifications).toEqual([]);
      } else {
        if (phase === "retry" || phase === "foreign retry") {
          await assert.rejects(retiring, /post-confirmation cleanup failed/);
          if (phase === "foreign retry") await newerStop(true);
          expect(await state.retry()).toBe(phase === "foreign retry" ? "superseded" : "applied");
        } else expect(await retiring).toBe("applied");
        const receipt = [expected, { nonce: null, generation: expected.generation }];
        expect(notifications).toEqual(phase === "retry" ? [receipt, receipt] : [receipt]);
        if (process.platform !== "win32") expect(syncedAfterNotification).toBe(true);
      }
      if (phase === "new Stop" || phase === "local newer Stop")
        expect((await storage.read())?.nonce).not.toBe(expected.nonce);
      else expect(await storage.read()).toBeNull();
    }
  );

  it("throwing retirement notification cannot skip unlink durability or recreate debt", async () => {
    state = new CompactionCancellation(
      h.historyService.getCompactionCancellationStorage(workspaceId)
    );
    await state.cancel();
    const captured = await h.historyService.captureCompactionReplacement(workspaceId);
    assert(captured.success && captured.data.nonce);
    const accepted = await h.historyService.acceptCompactionReplacement(
      workspaceId,
      captured.data,
      { kind: "append", messages: [createMuxMessage("replacement", "user", "Fresh input")] },
      { isCurrent: () => true, onCommitted: () => undefined }
    );
    assert(accepted.success && accepted.data.kind === "accepted" && accepted.data.witness);
    let notified = false;
    let syncedAfterNotification = false;
    const open = fs.open;
    spyOn(fs, "open").mockImplementation(async (...args: Parameters<typeof open>) => {
      const handle = await open(...args);
      if (args[0] === sessionDir) {
        const sync = handle.sync.bind(handle);
        spyOn(handle, "sync").mockImplementation(async () => {
          await sync();
          if (notified) syncedAfterNotification = true;
        });
      }
      return handle;
    });
    const notifications: unknown[] = [];
    expect(
      await state.retireReplacement(accepted.data.witness, (before, after) => {
        notifications.push([before, after]);
        notified = true;
        throw new Error("consumer notification failed");
      })
    ).toBe("applied");
    // Retirement names the deleted frontier; it grants no settled-admission proof.
    expect(captured.data.cancellationVersion).toBe(1);
    expect(notifications).toEqual([
      [
        { nonce: captured.data.nonce, generation: captured.data.generation },
        { nonce: null, generation: captured.data.generation },
      ],
    ]);
    if (process.platform !== "win32") expect(syncedAfterNotification).toBe(true);
    expect(await storage.read()).toBeNull();
    expect(state.needsPersistence).toBe(false);
    expect(await state.retry()).toBe("applied");
    expect(notifications).toHaveLength(1);
  });

  it.each([
    "commit",
    "foreign-before",
    "unlink-retry",
    "generic-retry",
    "foreign-retry",
    "cleanup-failure",
    "later-foreign",
  ] as const)("replacement retirement reports its exact locked frontier (%s)", async (phase) => {
    state = new CompactionCancellation(
      h.historyService.getCompactionCancellationStorage(workspaceId)
    );
    await state.cancel();
    const captured = await h.historyService.captureCompactionReplacement(workspaceId);
    assert(captured.success);
    assert(captured.data.nonce);
    const accepted = await h.historyService.acceptCompactionReplacement(
      workspaceId,
      captured.data,
      { kind: "append", messages: [createMuxMessage("replacement", "user", "Fresh input")] },
      { isCurrent: () => true, onCommitted: () => undefined }
    );
    assert(accepted.success && accepted.data.kind === "accepted" && accepted.data.witness);
    const receipts: Array<[CompactionReplacementCapture, CompactionReplacementCapture]> = [];
    const notify = (before: CompactionReplacementCapture, after: CompactionReplacementCapture) => {
      expect(nodeFs.existsSync(storage.path)).toBe(false);
      expect(nodeFs.existsSync(historyWriteLockPath(h.config.rootDir, workspaceId))).toBe(true);
      expect(state.blocksRecovery).toBe(false);
      receipts.push([before, after]);
      return undefined;
    };
    const remove = nodeFs.rmSync;
    let failUnlink =
      phase === "unlink-retry" || phase === "generic-retry" || phase === "foreign-retry";
    spyOn(nodeFs, "rmSync").mockImplementation((file, options) => {
      if (file === storage.path && failUnlink) throw new Error("unlink unavailable");
      remove(file, options);
    });
    if (phase === "cleanup-failure") {
      const lock = h.historyService.withCompactionStorageLock.bind(h.historyService);
      spyOn(h.historyService, "withCompactionStorageLock").mockImplementationOnce(
        async (...args) => {
          await lock(...args);
          throw new Error("post-commit cleanup unavailable");
        }
      );
    }
    if (phase === "foreign-before") {
      const other = new CompactionCancellation(
        foreign.getCompactionCancellationStorage(workspaceId)
      );
      await other.cancel({ retainUntilReplacement: true });
    }
    const retiring = state.retireReplacement(accepted.data.witness, notify);
    if (phase === "foreign-before") {
      expect(await retiring).toBe("superseded");
      expect(receipts).toEqual([]);
      expect((await storage.read())?.nonce).not.toBe(captured.data.nonce);
      return;
    }
    if (failUnlink) {
      await assert.rejects(retiring, /unlink unavailable/);
      expect(receipts).toEqual([]);
      expect((await storage.read())?.nonce).toBe(captured.data.nonce);
      failUnlink = false;
      if (phase === "foreign-retry") {
        const other = new CompactionCancellation(
          foreign.getCompactionCancellationStorage(workspaceId)
        );
        await other.cancel({ retainUntilReplacement: true });
        const bytes = await fs.readFile(storage.path);
        expect(await state.retry()).toBe("superseded");
        expect(receipts).toEqual([]);
        expect(await fs.readFile(storage.path)).toEqual(bytes);
        return;
      }
      expect(
        await (phase === "generic-retry" ? state.retire(captured.data.nonce) : state.retry())
      ).toBe("applied");
    } else if (phase === "cleanup-failure") {
      await assert.rejects(retiring, /post-commit cleanup unavailable/);
      expect(state.needsPersistence).toBe(true);
      expect(await state.retry()).toBe("superseded");
    } else expect(await retiring).toBe("applied");
    // The initial admission retains its version; the transition names only nonce/generation.
    expect(captured.data.cancellationVersion).toBe(1);
    expect(receipts).toEqual([
      [
        { nonce: captured.data.nonce, generation: captured.data.generation },
        { nonce: null, generation: captured.data.generation },
      ],
    ]);
    if (phase === "later-foreign") {
      const other = new CompactionCancellation(
        foreign.getCompactionCancellationStorage(workspaceId)
      );
      await other.cancel({ retainUntilReplacement: true });
      const next = await h.historyService.acceptCompactionReplacement(
        workspaceId,
        receipts[0][1],
        { kind: "append", messages: [createMuxMessage("queued", "user", "Queued input")] },
        { isCurrent: () => true, onCommitted: () => undefined }
      );
      expect(next).toEqual({ success: true, data: { kind: "superseded" } });
    }
  });

  it("publishes legacy-readable neutralization before the Stop sidecar", async () => {
    const summaryRow = createMuxMessage("stopped-summary", "assistant", "summary", {
      muxMetadata: { type: "compaction-summary", pendingFollowUp: followUp() },
    });
    expect((await h.historyService.appendToHistory(workspaceId, summaryRow)).success).toBe(true);
    expect(
      (await h.historyService.writePartial(workspaceId, { ...summaryRow, id: "partial" })).success
    ).toBe(true);
    const committed = Promise.withResolvers<void>();
    const release = Promise.withResolvers<void>();
    const remove = nodeFs.promises.rm;
    spyOn(nodeFs.promises, "rm").mockImplementation(async (file, options) => {
      if (String(file).startsWith(`${storage.path}.continuous-`)) {
        committed.resolve();
        await release.promise;
      }
      await remove(file, options);
    });
    const stopping = state.cancel();
    try {
      await committed.promise;
      expect(await storage.read()).not.toBeNull();
      // Simulate downgrade's lock-free read after a crash at this publication boundary.
      const rows = (await fs.readFile(path.join(sessionDir, "chat.jsonl"), "utf8"))
        .trimEnd()
        .split("\n");
      const last = JSON.parse(rows.at(-1)!) as MuxMessage;
      const partial = JSON.parse(
        await fs.readFile(path.join(sessionDir, "partial.json"), "utf8")
      ) as MuxMessage;
      expect(last.metadata?.muxMetadata).toEqual({ type: "compaction-summary" });
      expect(partial.metadata?.muxMetadata).toEqual({ type: "compaction-summary" });
    } finally {
      release.resolve();
      await stopping;
    }
  });

  it.each([
    ["followUpContent", true],
    ["continueMessage", true],
    ["followUpContent", false],
    ["continueMessage", false],
  ] as const)(
    "late completion cannot republish stopped %s before settlement cleanup (captured=%s)",
    async (field, captured) => {
      const request = createMuxMessage("compact-request", "user", "summarize", {
        muxMetadata: {
          type: "compaction-request",
          rawCommand: "/compact",
          parsed: { [field]: followUp() },
        },
      });
      expect((await h.historyService.appendToHistory(workspaceId, request)).success).toBe(true);
      const admission = await foreign.captureCompactionReplacement(workspaceId);
      assert(admission.success);
      const authored = await fs.readFile(path.join(sessionDir, "chat.jsonl"));
      const initialCleanup = Promise.withResolvers<void>();
      const settled = Promise.withResolvers<void>();
      const neutralize = h.historyService.neutralizeCompactionRecoveryUnderHistoryLock.bind(
        h.historyService
      );
      spyOn(
        h.historyService,
        "neutralizeCompactionRecoveryUnderHistoryLock"
      ).mockImplementationOnce(async (...args) => {
        const result = await neutralize(...args);
        initialCleanup.resolve();
        return result;
      });
      const stopping = state.cancel({ settled: settled.promise });
      try {
        await initialCleanup.promise;
        const handler = new CompactionHandler({
          workspaceId,
          historyService: foreign,
          sessionDir,
          emitter: new EventEmitter(),
        });
        expect(
          await handler.handleCompletion(
            {
              type: "stream-end",
              workspaceId,
              messageId: "late-summary",
              parts: [{ type: "text", text: "A completed summary" }],
              metadata: { model: "test:model", duration: 1 },
            },
            request.id,
            () => true,
            captured ? { generation: admission.data.generation } : undefined
          )
        ).toBe(false);
        const history = await foreign.getLastMessages(workspaceId, 1);
        assert(history.success);
        expect(history.data[0]?.metadata?.muxMetadata).not.toHaveProperty("pendingFollowUp");
        expect(await fs.readFile(path.join(sessionDir, "chat.jsonl"))).toEqual(authored);
      } finally {
        settled.resolve();
        await stopping;
      }
    }
  );

  it.each(["joined", "unjoined", "failed", "retained", "scoped"] as const)(
    "settled proof requires successful exact ordinary Stop (%s)",
    async (kind) => {
      const entered = Promise.withResolvers<void>();
      const settled = Promise.withResolvers<boolean>();
      const stopping = state.cancel({
        retainUntilReplacement: kind === "retained",
        onCaptured: () => entered.resolve(),
        ...(kind === "unjoined" ? {} : { settled: settled.promise }),
      });
      try {
        await entered.promise;
        const initial = await storage.read();
        assert(initial);
        expect(initial.version).toBe(1);
        if (kind === "scoped") {
          const other = new CompactionCancellation(
            new FileCompactionCancellationStorage(foreign, workspaceId)
          );
          await other.read();
          await other.narrow(initial.nonce, summary);
        }
        settled.resolve(kind !== "failed");
        expect(await stopping).toBe("applied");
        const persisted = await new FileCompactionCancellationStorage(foreign, workspaceId).read();
        expect(persisted?.nonce).toBe(initial.nonce);
        expect(persisted?.version).toBe(kind === "joined" ? 2 : 1);
        if (kind === "joined") {
          expect(persisted?.settledGeneration).toBe(
            await foreign.getContinuousCompactionJournal(workspaceId).captureGeneration()
          );
          expect(
            await new CompactionCancellation(
              new FileCompactionCancellationStorage(foreign, workspaceId)
            ).read()
          ).toEqual(persisted);
        } else expect(persisted?.settledGeneration).toBeUndefined();
        if (kind === "scoped") expect(persisted?.scope.kind).toBe("summary");
      } finally {
        settled.resolve(false);
        await stopping;
      }
    }
  );

  it("a legacy void settlement still waits and cleans late recovery without granting proof", async () => {
    const entered = Promise.withResolvers<void>();
    const settled = Promise.withResolvers<void>();
    const neutralize = h.historyService.neutralizeCompactionRecoveryUnderHistoryLock.bind(
      h.historyService
    );
    const cleanup = spyOn(
      h.historyService,
      "neutralizeCompactionRecoveryUnderHistoryLock"
    ).mockImplementation(async (...args) => {
      const result = await neutralize(...args);
      entered.resolve();
      return result;
    });
    const stopping = state.cancel({ settled: settled.promise });
    try {
      await entered.promise;
      expect(state.blocksRecovery).toBe(true);
      expect(cleanup).toHaveBeenCalledTimes(1);
      expect(
        (
          await foreign.writePartial(
            workspaceId,
            createMuxMessage("late", "assistant", "summary", {
              muxMetadata: { type: "compaction-summary", pendingFollowUp: followUp() },
            })
          )
        ).success
      ).toBe(true);
      expect(cleanup).toHaveBeenCalledTimes(1);
      settled.resolve();
      expect(await stopping).toBe("applied");
      expect(cleanup).toHaveBeenCalledTimes(2);
      expect((await foreign.readPartial(workspaceId))?.metadata?.muxMetadata).toEqual({
        type: "compaction-summary",
      });
      expect(await storage.read()).toMatchObject({ version: 1, scope: { kind: "unresolved" } });
      expect((await storage.read())?.settledGeneration).toBeUndefined();
    } finally {
      settled.resolve();
      await stopping;
    }
  });

  it("a failed settled-proof write retains unresolved Stop debt until retry", async () => {
    const rename = nodeFs.renameSync;
    let publications = 0;
    const failure = spyOn(nodeFs, "renameSync").mockImplementation((source, destination) => {
      if (destination === storage.path && ++publications === 2) {
        throw new Error("settled proof write failed");
      }
      return rename(source, destination);
    });
    await assert.rejects(
      state.cancel({ settled: Promise.resolve(true) }),
      /settled proof write failed/
    );
    expect(publications).toBe(2);
    const stopped = await storage.read();
    assert(stopped);
    expect(stopped.version).toBe(1);
    expect(state.blocksRecovery).toBe(true);
    failure.mockRestore();
    expect(await state.retry()).toBe("applied");
    expect(await storage.read()).toEqual({
      ...stopped,
      version: 2,
      settledGeneration: await h.historyService
        .getContinuousCompactionJournal(workspaceId)
        .captureGeneration(),
    });
    expect(state.blocksRecovery).toBe(false);
  });

  it("a displaced settled-proof write preserves a foreign Stop and generation", async () => {
    const successor = { ...record("foreign-successor"), retainUntilReplacement: true };
    const generationPath = path.join(sessionDir, CONTINUOUS_COMPACTION_GENERATION_FILE);
    const lockPath = historyWriteLockPath(h.config.rootDir, workspaceId);
    let stages = 0;
    afterCompactionStaging(storage.path, () => {
      if (++stages !== 2) return;
      nodeFs.writeFileSync(lockPath, `${process.pid}:foreign-holder`);
      nodeFs.writeFileSync(storage.path, JSON.stringify(successor));
      nodeFs.writeFileSync(generationPath, "foreign-generation");
    });
    await assert.rejects(state.cancel({ settled: Promise.resolve(true) }), /no longer owned/);
    expect(stages).toBe(2);
    expect(state.blocksRecovery).toBe(true);
    expect(await storage.read()).toEqual(successor);
    expect(await fs.readFile(generationPath, "utf8")).toBe("foreign-generation");
  });

  it.each([
    ["nonce", false],
    ["generation", false],
    ["nonce", true],
    ["generation", true],
  ] as const)(
    "post-settlement cleanup cannot overwrite a newer %s (retained=%s)",
    async (successorKind, retainUntilReplacement) => {
      const firstCleanup = Promise.withResolvers<void>();
      const settled = Promise.withResolvers<boolean>();
      const neutralize = h.historyService.neutralizeCompactionRecoveryUnderHistoryLock.bind(
        h.historyService
      );
      spyOn(h.historyService, "neutralizeCompactionRecoveryUnderHistoryLock").mockImplementation(
        async (...args) => {
          const result = await neutralize(...args);
          firstCleanup.resolve();
          return result;
        }
      );
      const stopping = state.cancel({ retainUntilReplacement, settled: settled.promise });
      try {
        await firstCleanup.promise;
        expect(state.blocksRecovery).toBe(true);
        // These real writes acquire the same locks: waiting for physical settlement must release them.
        if (successorKind === "nonce") {
          await new CompactionCancellation(
            new FileCompactionCancellationStorage(foreign, workspaceId)
          ).cancel({ retainUntilReplacement: true });
        } else {
          await foreign.withCompactionStorageLock(workspaceId, async (_dir, checkLock) => {
            await foreign
              .getContinuousCompactionJournal(workspaceId)
              .advanceGenerationUnderHistoryLock(undefined, checkLock);
          });
        }
        const successor = await storage.read();
        const partial = createMuxMessage("successor", "assistant", "new summary", {
          muxMetadata: { type: "compaction-summary", pendingFollowUp: followUp("new request") },
        });
        expect((await foreign.writePartial(workspaceId, partial)).success).toBe(true);
        const before = await foreign.readPartial(workspaceId);
        settled.resolve(true);
        expect(await stopping).toBe("superseded");
        expect(await foreign.readPartial(workspaceId)).toEqual(before);
        expect(await storage.read()).toEqual(successor);
      } finally {
        settled.resolve(true);
        await stopping;
      }
    }
  );

  it.each(["first absent", "first existing", "second"] as const)(
    "failed cleanup preserves %s durable frontier and retries exact debt",
    async (phase) => {
      if (phase === "first existing") await state.cancel();
      const predecessor = await storage.read();
      const initial = Promise.withResolvers<void>();
      const settled = Promise.withResolvers<boolean>();
      const neutralize = h.historyService.neutralizeCompactionRecoveryUnderHistoryLock.bind(
        h.historyService
      );
      let calls = 0;
      const cleanup = spyOn(
        h.historyService,
        "neutralizeCompactionRecoveryUnderHistoryLock"
      ).mockImplementation(async (...args) => {
        if (++calls === (phase === "second" ? 2 : 1)) {
          initial.resolve();
          throw new Error("legacy cleanup unavailable");
        }
        return await neutralize(...args);
      });
      const stopping = state.cancel({
        retainUntilReplacement: true,
        settled: settled.promise,
        onCaptured: () => initial.resolve(),
      });
      const failed = assert.rejects(stopping, /legacy cleanup unavailable/);
      try {
        await initial.promise;
        const durable = await storage.read();
        if (phase === "second") expect(durable).toMatchObject({ retainUntilReplacement: true });
        else expect(durable).toEqual(predecessor);
        expect(
          (
            await foreign.writePartial(
              workspaceId,
              createMuxMessage("late", "assistant", "summary", {
                muxMetadata: { type: "compaction-summary", pendingFollowUp: followUp() },
              })
            )
          ).success
        ).toBe(true);
        settled.resolve(true);
        await failed;
        expect(state.needsPersistence).toBe(true);
        expect(state.blocksRecovery).toBe(true);
        expect(await storage.read()).toEqual(durable);
        cleanup.mockRestore();
        expect(await state.retry()).toBe("applied");
        expect(state.needsPersistence).toBe(false);
        if (phase === "second") expect(await storage.read()).toEqual(durable);
        else expect((await storage.read())?.nonce).not.toBe(predecessor?.nonce);
        expect((await foreign.readPartial(workspaceId))?.metadata?.muxMetadata).toEqual({
          type: "compaction-summary",
        });
      } finally {
        settled.resolve(true);
        await failed;
      }
    }
  );

  it("a failed prepublication cleanup cannot retry over a foreign successor", async () => {
    const failure = spyOn(
      h.historyService,
      "neutralizeCompactionRecoveryUnderHistoryLock"
    ).mockRejectedValueOnce(new Error("cleanup unavailable"));
    const captured = mock(() => undefined);
    await assert.rejects(state.cancel({ onCaptured: captured }), /cleanup unavailable/);
    expect(captured).not.toHaveBeenCalled();
    expect(await storage.read()).toBeNull();
    failure.mockRestore();
    const successor = new CompactionCancellation(
      new FileCompactionCancellationStorage(foreign, workspaceId)
    );
    expect(await successor.cancel({ retainUntilReplacement: true })).toBe("applied");
    const successorBytes = await fs.readFile(storage.path);
    const row = createMuxMessage("foreign-summary", "assistant", "new summary", {
      muxMetadata: { type: "compaction-summary", pendingFollowUp: followUp("new request") },
    });
    expect((await foreign.appendToHistory(workspaceId, row)).success).toBe(true);
    const before = await fs.readFile(path.join(sessionDir, "chat.jsonl"));
    expect(await state.retry()).toBe("superseded");
    expect(await fs.readFile(storage.path)).toEqual(successorBytes);
    expect(await fs.readFile(path.join(sessionDir, "chat.jsonl"))).toEqual(before);
    expect(captured).not.toHaveBeenCalled();
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
      let targetCommitted = phase !== "publish";
      const rename = nodeFs.renameSync;
      spyOn(nodeFs, "renameSync").mockImplementation((from, to) => {
        rename(from, to);
        if (to === storage.path) targetCommitted = true;
      });
      spyOn(fs, "open").mockImplementation(async (...args: Parameters<typeof open>) => {
        const handle = await open(...args);
        if (args[0] === sessionDir && fail && targetCommitted) {
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
      fail = false;
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
        const open = nodeFs.promises.open;
        spyOn(nodeFs.promises, "open").mockImplementation(
          async (...args: Parameters<typeof open>) => {
            const handle = await open(...args);
            if (args[0] === storage.path) {
              const close = handle.close.bind(handle);
              spyOn(handle, "close").mockImplementation(async () => {
                await close();
                if (!displaced) displace();
              });
            }
            return handle;
          }
        );
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

  it.each(["future", "oversized"] as const)(
    "explicit Stop preserves history and installs a retained fence over %s bytes",
    async (kind) => {
      const history = await h.historyService.getHistoryFromLatestBoundary(workspaceId);
      const journal = h.historyService.getContinuousCompactionJournal(workspaceId);
      const generation = await journal.captureGeneration();
      const bytes =
        kind === "future"
          ? JSON.stringify({ ...record("future"), version: 2 })
          : " ".repeat(SESSION_HISTORY_MAX_LINE_BYTES + 1);
      await fs.writeFile(storage.path, bytes);
      expect(await state.cancel()).toBe("applied");
      expect(await storage.read()).toMatchObject({
        version: 1,
        retainUntilReplacement: true,
        scope: { kind: "unresolved" },
      });
      expect(await journal.captureGeneration()).not.toBe(generation);
      expect(await h.historyService.getHistoryFromLatestBoundary(workspaceId)).toEqual(history);
    }
  );

  it.each(["newer", "oversized", "oversized newer"] as const)(
    "preserves %s cancellation and recovery bytes through automatic refusal paths",
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
        () => state.read(),
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

  it.each(["limit", "oversized", "malformed", "read error"] as const)(
    "bounds short descriptor reads and closes the handle for %s sidecars",
    async (kind) => {
      const valid = JSON.stringify(record("bounded"));
      const contents =
        kind === "malformed"
          ? "{invalid"
          : valid.padEnd(SESSION_HISTORY_MAX_LINE_BYTES * (kind === "oversized" ? 2 : 1), " ");
      await fs.writeFile(storage.path, contents);
      let reads = 0;
      let totalRead = 0;
      let largestBuffer = 0;
      let closed = false;
      const open = nodeFs.promises.open;
      spyOn(nodeFs.promises, "open").mockImplementation(
        async (...args: Parameters<typeof open>) => {
          const handle = await open(...args);
          if (args[0] === storage.path) {
            const close = handle.close.bind(handle);
            spyOn(handle, "close").mockImplementation(async () => {
              await close();
              closed = true;
            });
            const read = handle.read.bind(handle);
            spyOn(handle, "read").mockImplementation((async (
              buffer: Buffer,
              offset: number,
              length: number,
              position: number
            ) => {
              reads++;
              largestBuffer = Math.max(largestBuffer, buffer.byteLength);
              if (kind === "read error") throw new Error("descriptor read failed");
              // Exercise legal short reads; a single read must not mistake them for EOF.
              const result = await read(
                buffer,
                offset,
                Math.min(length, SESSION_HISTORY_MAX_LINE_BYTES / 16),
                position
              );
              totalRead += result.bytesRead;
              return result;
            }) as typeof handle.read);
          }
          return handle;
        }
      );
      if (kind === "limit") expect(await storage.read()).toEqual(record("bounded"));
      else
        await assert.rejects(
          storage.read(),
          kind === "oversized"
            ? CompactionCancellationReadRefusedError
            : kind === "malformed"
              ? MalformedCompactionCancellationError
              : /descriptor read failed/
        );
      expect(reads).toBeGreaterThan(kind === "read error" ? 0 : 1);
      expect(totalRead).toBeLessThanOrEqual(SESSION_HISTORY_MAX_LINE_BYTES + 1);
      expect(largestBuffer).toBeLessThanOrEqual(SESSION_HISTORY_MAX_LINE_BYTES + 1);
      expect(closed).toBe(true);
      expect(await fs.readFile(storage.path, "utf8")).toBe(contents);
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

  it.each([false, true])(
    "narrowing cannot downgrade a peer-settled Stop (settled=%s)",
    async (settled) => {
      const peer = new CompactionCancellation(
        foreign.getCompactionCancellationStorage(workspaceId)
      );
      const published = Promise.withResolvers<void>();
      const finish = Promise.withResolvers<boolean>();
      const stopping = peer.cancel({
        settled: finish.promise,
        onCaptured: () => published.resolve(),
      });
      await published.promise;
      const captured = await state.read();
      assert(captured?.version === 1);
      if (settled) {
        finish.resolve(true);
        await stopping;
      }
      const before = await fs.readFile(storage.path);
      try {
        await state.narrow(captured.nonce, summary);
        if (settled) expect(await fs.readFile(storage.path)).toEqual(before);
        else expect((await storage.read())?.scope).toEqual({ kind: "summary", ...summary });
      } finally {
        finish.resolve(false);
        await stopping;
      }
    }
  );

  it.each([false, true])(
    "retirement advances only the original admission version (mixed=%s)",
    async (mixed) => {
      state = new CompactionCancellation(
        h.historyService.getCompactionCancellationStorage(workspaceId)
      );
      const published = Promise.withResolvers<void>();
      const finish = Promise.withResolvers<boolean>();
      const stopping = state.cancel({
        settled: finish.promise,
        onCaptured: () => published.resolve(),
      });
      await published.promise;
      const early = await h.historyService.captureCompactionReplacement(workspaceId);
      assert(early.success);
      finish.resolve(true);
      await stopping;
      const fresh = await foreign.captureCompactionReplacement(workspaceId);
      assert(fresh.success);
      const queue = new MessageQueue();
      for (const captured of [mixed ? early.data : fresh.data, fresh.data])
        queue.add("queued", undefined, {
          acceptanceOrigin: "automatic",
          readCompactionAdmission: () => Promise.resolve(Ok(captured)),
        });
      const accepted = await h.historyService.acceptCompactionReplacement(
        workspaceId,
        fresh.data,
        {
          kind: "append",
          messages: [createMuxMessage("replacement", "user", "accepted fresh input")],
        },
        { isCurrent: () => true, onCommitted: () => undefined }
      );
      assert(accepted.success && accepted.data.kind === "accepted" && accepted.data.witness);
      expect(
        await state.retireReplacement(
          accepted.data.witness,
          (before, after) => {
            queue.advanceCompactionAdmission(before, after);
            return undefined;
          },
          fresh.data
        )
      ).toBe("applied");
      expect(await storage.read()).toBeNull();
      const captured = await queue.dequeueNext().internal?.readCompactionAdmission?.();
      if (mixed) expect(captured?.success).toBe(false);
      else expect(captured).toEqual(Ok({ nonce: null, generation: fresh.data.generation }));
    }
  );

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
      Promise.resolve(() => Promise.resolve(false))
    );
    await assert.rejects(
      refusing.mutate(mutation, () => true, mutationCommitted),
      /not verified/
    );
    expect(await storage.read()).toEqual(retained);
    let current = true;
    const verifying = new FileCompactionCancellationStorage(foreign, workspaceId, (witness) => {
      expect(witness.nonce).toBe(retained.nonce);
      expect(nodeFs.existsSync(historyWriteLockPath(h.config.rootDir, workspaceId))).toBe(false);
      return Promise.resolve(async () => {
        expect(
          await fs.readFile(historyWriteLockPath(h.config.rootDir, workspaceId), "utf8")
        ).not.toBe("");
        current = false;
        return true;
      });
    });
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

  it("overlapping Stop during generation staging returns superseded and preserves its successor", async () => {
    let successor: ReturnType<typeof state.cancel> | undefined;
    afterCompactionStaging(path.join(sessionDir, CONTINUOUS_COMPACTION_GENERATION_FILE), () => {
      successor ??= state.cancel();
    });
    const first = await state.cancel().catch((error: unknown) => error);
    expect(first).toBe("superseded");
    expect(await successor).toBe("applied");
    expect(await storage.read()).toEqual(await state.read());
    expect((await storage.read())?.nonce).toBeDefined();
  });

  it.each(["Stop", "generation"] as const)(
    "unsupported-record publication retries cannot adopt a foreign %s",
    async (change) => {
      await fs.writeFile(storage.path, JSON.stringify({ ...record("future"), version: 2 }));
      const mutation = publication("stale-intervention");
      const rename = nodeFs.renameSync;
      const failingRename = spyOn(nodeFs, "renameSync").mockImplementation(
        (source, destination) => {
          if (destination === storage.path) throw new Error("cancellation rename failed");
          return rename(source, destination);
        }
      );
      await assert.rejects(
        storage.mutate(mutation, () => true, mutationCommitted),
        /cancellation rename failed/
      );
      failingRename.mockRestore();
      if (change === "Stop") {
        await new CompactionCancellation(
          new FileCompactionCancellationStorage(foreign, workspaceId)
        ).cancel();
      } else {
        await foreign.getContinuousCompactionJournal(workspaceId).advanceGeneration();
      }
      const generationPath = path.join(sessionDir, CONTINUOUS_COMPACTION_GENERATION_FILE);
      const before = await fs.readFile(storage.path);
      const generation = await fs.readFile(generationPath);
      mutation.publication.attempts++;
      expect(await storage.mutate(mutation, () => true, mutationCommitted)).toBe("superseded");
      expect(await fs.readFile(storage.path)).toEqual(before);
      expect(await fs.readFile(generationPath)).toEqual(generation);
    }
  );

  it("a locally superseded publication cannot rename its staged cancellation", async () => {
    let current = true;
    const journal = h.historyService.getContinuousCompactionJournal(workspaceId);
    const advance = journal.advanceGenerationUnderHistoryLock.bind(journal);
    spyOn(journal, "advanceGenerationUnderHistoryLock").mockImplementationOnce(async (...args) => {
      const result = await advance(...args);
      current = false;
      return result;
    });
    expect(await storage.mutate(publication("stale"), () => current, mutationCommitted)).toBe(
      "superseded"
    );
    expect(await storage.read()).toBeNull();
    expect((await fs.readdir(sessionDir)).some((file) => file.includes(".continuous-"))).toBe(
      false
    );
  });

  it("Stop preserves absence when real truncate recovery cannot read its marker", async () => {
    await fs.mkdir(path.join(sessionDir, "chat-archive.jsonl.truncate.json"));
    expect(
      (
        await h.historyService.appendToHistory(
          workspaceId,
          createMuxMessage("blocked", "user", "blocked")
        )
      ).success
    ).toBe(false);
    await assert.rejects(state.cancel(), /EISDIR/);
    expect(await storage.read()).toBeNull();
    expect(state.needsPersistence).toBe(true);
    await fs.rmdir(path.join(sessionDir, "chat-archive.jsonl.truncate.json"));
    expect(await state.retry()).toBe("applied");
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
    "repairs unusable partials while retaining cancellation on protected or unreadable bytes (%s)",
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
      if (damage === "JSON" || damage === "schema") {
        expect(await state.read()).toBeNull();
        expect(state.repairRevision).toBe(1);
        expect(nodeFs.existsSync(partialPath)).toBe(false);
        expect(nodeFs.existsSync(storage.path)).toBe(false);
        return;
      }
      await assert.rejects(state.read());
      expect(await fs.readFile(storage.path, "utf8")).toBe("{broken cancellation");
      expect(state.repairRevision).toBe(0);
      if (damage !== "I/O") expect(await fs.readFile(partialPath, "utf8")).toBe(contents);
    }
  );

  it.each(["local generation", "physical lease"] as const)(
    "a corrupt-partial cleanup displaced by %s preserves successor bytes",
    async (displacement) => {
      const partialPath = path.join(sessionDir, "partial.json");
      const lockPath = historyWriteLockPath(h.config.rootDir, workspaceId);
      await fs.writeFile(partialPath, "{broken partial");
      const successor = createMuxMessage("successor", "assistant", "new summary", {
        muxMetadata: { type: "compaction-summary", pendingFollowUp: followUp("new request") },
      });
      let current = true;
      let displaced = false;
      const read = fs.readFile;
      spyOn(fs, "readFile").mockImplementation((async (...args: Parameters<typeof read>) => {
        const result = await read(...args);
        if (args[0] === partialPath && !displaced) {
          displaced = true;
          // Model a successor arriving during the last read; cleanup must validate after I/O.
          if (displacement === "physical lease")
            nodeFs.writeFileSync(lockPath, `${process.pid}:successor-partial-holder`);
          else current = false;
          nodeFs.writeFileSync(partialPath, JSON.stringify(successor));
        }
        return result;
      }) as typeof read);
      try {
        const stopping = storage.mutate(publication("old-stop"), () => current, mutationCommitted);
        if (displacement === "physical lease") await assert.rejects(stopping, /no longer owned/);
        else expect(await stopping).toBe("superseded");
        expect(displaced).toBe(true);
        expect(await fs.readFile(partialPath, "utf8")).toBe(JSON.stringify(successor));
        expect(await storage.read()).toBeNull();
      } finally {
        if (displacement === "physical lease") await fs.rm(lockPath, { force: true });
      }
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
      const result = await advance(...args);
      current = false;
      return result;
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
      // Failed legacy neutralization cannot publish a new Stop over the preserved predecessor.
      await assert.rejects(state.readForReplacement(), /Cannot safely neutralize/);
      expect(await fs.readFile(storage.path, "utf8")).toBe("{damaged cancellation");
      expect(state.blocksRecovery).toBe(true);
    }
  );

  it("full deletion fences malformed rows without inheriting Stop's row-wise repair debt", async () => {
    const row = createMuxMessage("damaged", "assistant", "summary", {
      muxMetadata: { type: "compaction-summary", pendingFollowUp: followUp() },
    });
    const chatPath = path.join(sessionDir, "chat.jsonl");
    const raw = JSON.stringify({ ...row, parts: null }) + "\n";
    await fs.writeFile(chatPath, raw);
    await assert.rejects(state.cancel(), /Cannot safely neutralize/);
    expect(state.blocksRecovery).toBe(true);
    const journal = foreign.getContinuousCompactionJournal(workspaceId);
    const before = await journal.captureGeneration();
    expect(await state.cancel({ fullHistoryDeletion: { percentage: 1 } })).toBe("applied");
    expect(await storage.read()).toMatchObject({ retainUntilReplacement: true });
    expect(await journal.captureGeneration()).not.toBe(before);
    expect(state.blocksRecovery).toBe(false);
    // Full-delete authorization removes malformed bytes before publishing its fence.
    await assert.rejects(fs.stat(chatPath), { code: "ENOENT" });
    // The exception belongs to one mutation and must never change ordinary Stop/repair.
    await fs.writeFile(chatPath, raw);
    await assert.rejects(state.cancel(), /Cannot safely neutralize/);
    expect(await fs.readFile(chatPath, "utf8")).toBe(raw);
  });

  it("full deletion removes downgrade recovery and foreign partial before sidecar publication", async () => {
    const row = createMuxMessage("legacy-summary", "assistant", "summary", {
      muxMetadata: { type: "compaction-summary", pendingFollowUp: followUp() },
    });
    expect((await h.historyService.appendToHistory(workspaceId, row)).success).toBe(true);
    const paths = ["chat.jsonl", "chat-archive.jsonl", "partial.json"].map((name) =>
      path.join(sessionDir, name)
    );
    await fs.copyFile(paths[0], paths[1]);
    expect(
      (await foreign.writePartial(workspaceId, { ...row, id: "foreign-partial" })).success
    ).toBe(true);
    let receipt: number[] | undefined;
    const rename = nodeFs.renameSync;
    let checked = false;
    spyOn(nodeFs, "renameSync").mockImplementation((from, to) => {
      if (to === storage.path) {
        checked = true;
        for (const file of paths) expect(nodeFs.existsSync(file)).toBe(false);
        expect(receipt).toEqual([0, 1, 0, 1]);
      }
      rename(from, to);
    });
    expect(
      await state.cancel({
        fullHistoryDeletion: {
          percentage: 1,
          onCommitted: (sequences) => {
            receipt = sequences;
            return undefined;
          },
        },
      })
    ).toBe("applied");
    expect(checked).toBe(true);
    const restarted = new HistoryService(h.config);
    expect(await restarted.getLastMessages(workspaceId, 1)).toEqual({ success: true, data: [] });
    expect(await restarted.readPartial(workspaceId)).toBeNull();
  });

  it("full deletion retries only the sidecar after its receipt and preserves newer ordinary history", async () => {
    expect(
      (await h.historyService.appendToHistory(workspaceId, createMuxMessage("old", "user", "old")))
        .success
    ).toBe(true);
    const onCommitted = mock(() => undefined);
    const rename = nodeFs.renameSync;
    const failure = spyOn(nodeFs, "renameSync").mockImplementation((from, to) => {
      if (to === storage.path) throw new Error("sidecar unavailable");
      rename(from, to);
    });
    await assert.rejects(
      state.cancel({ fullHistoryDeletion: { percentage: 1, onCommitted } }),
      /sidecar unavailable/
    );
    expect(onCommitted).toHaveBeenCalledTimes(1);
    expect(await storage.read()).toBeNull();
    failure.mockRestore();
    expect(
      (await foreign.appendToHistory(workspaceId, createMuxMessage("new", "user", "new"))).success
    ).toBe(true);
    const chatPath = path.join(sessionDir, "chat.jsonl");
    const bytes = await fs.readFile(chatPath);
    expect(await state.retry()).toBe("applied");
    expect(await fs.readFile(chatPath)).toEqual(bytes);
    expect(onCommitted).toHaveBeenCalledTimes(1);
  });

  it("a throwing deletion observer cannot repeat the committed transaction", async () => {
    expect(
      (await h.historyService.appendToHistory(workspaceId, createMuxMessage("old", "user", "old")))
        .success
    ).toBe(true);
    const onCommitted = mock(() => {
      throw new Error("observer failed");
    });
    await assert.rejects(
      state.cancel({ fullHistoryDeletion: { percentage: 1, onCommitted } }),
      /observer failed/
    );
    expect(await storage.read()).toBeNull();
    expect(
      (await foreign.appendToHistory(workspaceId, createMuxMessage("new", "user", "new"))).success
    ).toBe(true);
    const chatPath = path.join(sessionDir, "chat.jsonl");
    const bytes = await fs.readFile(chatPath);
    expect(await state.retry()).toBe("applied");
    expect(await fs.readFile(chatPath)).toEqual(bytes);
    expect(onCommitted).toHaveBeenCalledTimes(1);
  });

  it.skipIf(process.platform === "win32").each([false, true])(
    "uncertain deletion durability never authorizes retry over a foreign append (archive=%s)",
    async (archive) => {
      expect(
        (
          await h.historyService.appendToHistory(
            workspaceId,
            createMuxMessage("old", "user", "old")
          )
        ).success
      ).toBe(true);
      const chatPath = path.join(sessionDir, "chat.jsonl");
      if (archive) await fs.copyFile(chatPath, path.join(sessionDir, "chat-archive.jsonl"));
      const onCommitted = mock(() => undefined);
      const sync = nodeFs.fsyncSync;
      const failure = spyOn(nodeFs, "fsyncSync").mockImplementation((fd) => {
        if (!nodeFs.existsSync(chatPath)) throw new Error("delete sync failed");
        sync(fd);
      });
      await assert.rejects(
        state.cancel({ fullHistoryDeletion: { percentage: 1, onCommitted } }),
        /delete sync failed/
      );
      expect(onCommitted).not.toHaveBeenCalled();
      expect(await storage.read()).toBeNull();
      failure.mockRestore();
      expect(
        (await foreign.appendToHistory(workspaceId, createMuxMessage("new", "user", "new"))).success
      ).toBe(true);
      const bytes = await fs.readFile(chatPath);
      await assert.rejects(state.retry(), /new explicit clear/);
      expect(await fs.readFile(chatPath)).toEqual(bytes);
      expect(state.blocksRecovery).toBe(true);
    }
  );

  it("a full-deletion scope that became partial cannot erase history", async () => {
    for (let i = 0; i < 5; i++)
      expect(
        (
          await h.historyService.appendToHistory(
            workspaceId,
            createMuxMessage(String(i), "user", "message ".repeat(50))
          )
        ).success
      ).toBe(true);
    const chatPath = path.join(sessionDir, "chat.jsonl");
    const before = await fs.readFile(chatPath);
    const receipt = mock(() => undefined);
    await assert.rejects(
      state.cancel({ fullHistoryDeletion: { percentage: 0.1, onCommitted: receipt } }),
      /leave messages/
    );
    expect(await fs.readFile(chatPath)).toEqual(before);
    expect(receipt).not.toHaveBeenCalled();
    expect(await storage.read()).toBeNull();
  });

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

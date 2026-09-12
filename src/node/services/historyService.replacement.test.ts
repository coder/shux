import { afterEach, beforeEach, describe, expect, it, mock, spyOn } from "bun:test";
import assert from "node:assert/strict";
import * as fs from "node:fs/promises";
import * as nodeFs from "node:fs";
import * as path from "node:path";
import * as atomicWrite from "write-file-atomic";
import { createMuxMessage, type MuxMessage } from "@/common/types/message";
import { Ok } from "@/common/types/result";
import { createContextBudgetRejectedMessage } from "@/common/utils/messages/contextBudgetRejection";
import { MuxMessageSchema } from "@/common/orpc/schemas/message";
import { workspaceFileLocks } from "@/node/utils/concurrency/workspaceFileLocks";
import { acquireProcessFileLock } from "@/node/utils/concurrency/fileLock";
import { CONTINUOUS_COMPACTION_GENERATION_FILE } from "@/constants/continuousCompaction";
import { SESSION_HISTORY_MAX_LINE_BYTES } from "@/common/constants/contextBudget";
import type { ContinuousCompactionJournal } from "@/common/orpc/schemas/continuousCompaction";
import {
  CompactionCancellation,
  type CompactionReplacementOperation,
} from "./compactionCancellation";
import { HistoryService } from "./historyService";
import { createTestHistoryService } from "./testHistoryService";
import { historyWriteLockPath } from "./workspaceRemoval";
import { HistoryAppendProvenance } from "./historyAppendProvenance";

const workspaceId = "replacement";
const noObserver = { isCurrent: () => true, onCommitted: () => undefined };

describe("compaction replacement acceptance", () => {
  let fixture: Awaited<ReturnType<typeof createTestHistoryService>>;
  let history: HistoryService;
  let stop: CompactionCancellation;
  let chatPath: string;

  beforeEach(async () => {
    fixture = await createTestHistoryService();
    history = fixture.historyService;
    stop = new CompactionCancellation(history.getCompactionCancellationStorage(workspaceId));
    chatPath = path.join(fixture.config.sessionsDir, workspaceId, "chat.jsonl");
    await history.appendToHistory(workspaceId, createMuxMessage("prior", "user", "question"));
  });
  afterEach(async () => {
    mock.restore();
    await fixture.cleanup();
  });

  async function capture() {
    const result = await history.captureCompactionReplacement(workspaceId);
    assert(result.success);
    return result.data;
  }
  async function rows() {
    const result = await history.getLastMessages(workspaceId, 20);
    assert(result.success);
    return result.data;
  }
  it("admission captures repaired malformed state before a waiting foreign Stop", async () => {
    const storage = history.getCompactionCancellationStorage(workspaceId);
    await fs.writeFile(storage.path, "{malformed cancellation");
    const entered = Promise.withResolvers<void>();
    const release = Promise.withResolvers<void>();
    const neutralize = history.neutralizeCompactionRecoveryUnderHistoryLock.bind(history);
    spyOn(history, "neutralizeCompactionRecoveryUnderHistoryLock").mockImplementationOnce(
      async (...args) => {
        entered.resolve();
        await release.promise;
        return neutralize(...args);
      }
    );
    const repaired = mock(() => undefined);
    const acquiring = history.captureCompactionReplacement(workspaceId, { onRepaired: repaired });
    await entered.promise;
    const foreign = new CompactionCancellation(
      new HistoryService(fixture.config).getCompactionCancellationStorage(workspaceId)
    );
    const stopping = foreign.cancel();
    release.resolve();
    const acquired = await acquiring;
    await stopping;
    assert(acquired.success);
    expect(acquired.data.nonce).toBeNull();
    expect(repaired).toHaveBeenCalledTimes(1);
    expect(await capture()).not.toEqual(acquired.data);
    expect(
      await history.acceptCompactionReplacement(
        workspaceId,
        acquired.data,
        {
          kind: "append",
          messages: [createMuxMessage("stale", "user", "older request")],
        },
        noObserver
      )
    ).toEqual(Ok({ kind: "superseded" }));
    expect((await rows()).map((row) => row.id)).toEqual(["prior"]);
  });

  it.each([false, true])(
    "admission capture retains unsupported bytes unless replacement is explicit (manual=%s)",
    async (manual) => {
      const storage = history.getCompactionCancellationStorage(workspaceId);
      const unsupported = JSON.stringify({
        version: 999,
        nonce: "future",
        scope: { kind: "unresolved" },
      });
      await fs.writeFile(storage.path, unsupported);
      const repaired = mock(() => undefined);
      const acquired = await history.captureCompactionReplacement(workspaceId, {
        onRepaired: repaired,
        replaceUnreadable: manual,
      });
      if (!manual) {
        expect(acquired.success).toBe(false);
        expect(await fs.readFile(storage.path, "utf8")).toBe(unsupported);
        expect(repaired).not.toHaveBeenCalled();
      } else {
        assert(acquired.success);
        expect(await storage.read()).toMatchObject({
          nonce: acquired.data.nonce,
          retainUntilReplacement: true,
        });
        expect(acquired.data.generation).toBeDefined();
        expect(repaired).toHaveBeenCalledTimes(1);
      }
    }
  );

  it.each(["stamps", "flush"] as const)(
    "superseding locked witness %s returns superseded after disposal",
    async (phase) => {
      await stop.cancel({ retainUntilReplacement: true });
      const expected = await capture();
      const accepted = await history.acceptCompactionReplacement(
        workspaceId,
        expected,
        await operation("single"),
        noObserver
      );
      assert(accepted.success && accepted.data.kind === "accepted" && accepted.data.witness);
      const entered = Promise.withResolvers<void>();
      const release = Promise.withResolvers<void>();
      let locked = false;
      let armed = true;
      let opened = 0;
      let closed = 0;
      const hold = async () => {
        if (!locked || !armed) return;
        armed = false;
        entered.resolve();
        await release.promise;
      };
      const lock = history.withCompactionStorageLock.bind(history);
      spyOn(history, "withCompactionStorageLock").mockImplementation((id, callback) =>
        lock(id, async (...args) => {
          locked = true;
          try {
            return await callback(...args);
          } finally {
            locked = false;
          }
        })
      );
      const stamps = HistoryAppendProvenance.prototype.stamps; // eslint-disable-line @typescript-eslint/unbound-method -- original receiver retained
      spyOn(HistoryAppendProvenance.prototype, "stamps").mockImplementation(async function (
        this: HistoryAppendProvenance
      ) {
        const result = await stamps.call(this);
        if (phase === "stamps") await hold();
        return result;
      });
      const open = fs.open;
      spyOn(fs, "open").mockImplementation(async (...args: Parameters<typeof open>) => {
        const handle = await open(...args);
        if (args[0] === chatPath && args[1] === "r+") {
          opened++;
          const sync = handle.sync.bind(handle);
          const close = handle.close.bind(handle);
          spyOn(handle, "sync").mockImplementation(async () => {
            await sync();
            if (phase === "flush") await hold();
          });
          spyOn(handle, "close").mockImplementation(async () => {
            await close();
            closed++;
          });
        }
        return handle;
      });
      const retiring = stop.retireReplacement(accepted.data.witness).then(
        (result) => result,
        (error: unknown) => error
      );
      await entered.promise;
      const successor = stop.cancel({ retainUntilReplacement: true });
      release.resolve();
      const [retired, published] = await Promise.all([retiring, successor]);
      expect(retired).toBe("superseded");
      expect(published).toBe("applied");
      expect(closed).toBe(opened);
      if (phase === "flush") expect(opened).toBeGreaterThan(0);
      expect((await capture()).nonce).not.toBe(expected.nonce);
      expect((await rows()).some((row) => row.id === "accepted")).toBe(true);
    }
  );

  it("a current locked witness flush error remains a failure with retry debt", async () => {
    await stop.cancel({ retainUntilReplacement: true });
    const expected = await capture();
    const accepted = await history.acceptCompactionReplacement(
      workspaceId,
      expected,
      await operation("single"),
      noObserver
    );
    assert(accepted.success && accepted.data.kind === "accepted" && accepted.data.witness);
    const failure = new Error("injected current witness flush error");
    const open = fs.open;
    const probe = spyOn(fs, "open").mockImplementation(async (...args: Parameters<typeof open>) => {
      const handle = await open(...args);
      if (args[0] === chatPath && args[1] === "r+")
        spyOn(handle, "sync").mockRejectedValueOnce(failure);
      return handle;
    });
    await assert.rejects(
      stop.retireReplacement(accepted.data.witness),
      (error) => error === failure
    );
    expect(stop.needsPersistence).toBe(true);
    expect((await capture()).nonce).toBe(expected.nonce);
    probe.mockRestore();
    expect(await stop.retry()).toBe("applied");
    expect((await capture()).nonce).toBeNull();
  });

  it.each(["chat", "archive", "giant archive"] as const)(
    "same nonce on a different eligible identity in %s cannot retire Stop",
    async (artifact) => {
      await stop.cancel({ retainUntilReplacement: true });
      const expected = await capture();
      assert(expected.nonce);
      const accepted = await history.acceptCompactionReplacement(
        workspaceId,
        expected,
        await operation("single"),
        noObserver
      );
      assert(accepted.success && accepted.data.kind === "accepted" && accepted.data.witness);
      const second = createMuxMessage(
        "second-identity",
        "user",
        artifact === "giant archive"
          ? "x".repeat(SESSION_HISTORY_MAX_LINE_BYTES + 1)
          : "other input",
        { historySequence: 99, compactionReplacementNonce: expected.nonce }
      );
      const file =
        artifact === "chat" ? chatPath : path.join(path.dirname(chatPath), "chat-archive.jsonl");
      await fs.appendFile(file, JSON.stringify(second) + "\n");
      const bytes = await fs.readFile(file);
      expect(await history.findCompactionReplacementWitness(workspaceId, expected.nonce)).toEqual(
        Ok(null)
      );
      await assert.rejects(stop.retireReplacement(accepted.data.witness), /not verified/);
      expect((await capture()).nonce).toBe(expected.nonce);
      expect(await fs.readFile(file)).toEqual(bytes);
    }
  );

  it.each(["append", "resume"] as const)(
    "an ineligible legacy system stamp does not consume a fresh %s replacement",
    async (intent) => {
      await stop.cancel({ retainUntilReplacement: true });
      const expected = await capture();
      assert(expected.nonce);
      const invalid =
        JSON.stringify({
          ...createMuxMessage("old-system-stamp", "user", "legacy context", {
            historySequence: 99,
            compactionReplacementNonce: expected.nonce,
          }),
          role: ["system"],
        }) + "\n";
      await fs.appendFile(chatPath, invalid);
      const replacement: CompactionReplacementOperation =
        intent === "append"
          ? await operation("single")
          : { kind: "resume", message: (await rows()).find((row) => row.id === "prior")! };
      const accepted = await history.acceptCompactionReplacement(
        workspaceId,
        expected,
        replacement,
        noObserver
      );
      assert(accepted.success && accepted.data.kind === "accepted" && accepted.data.witness);
      expect((await fs.readFile(chatPath, "utf8")).includes(invalid.trimEnd())).toBe(true);
      expect(await history.findCompactionReplacementWitness(workspaceId, expected.nonce)).toEqual(
        Ok({ nonce: expected.nonce })
      );
      expect(await stop.retireReplacement(accepted.data.witness)).toBe("applied");
      expect((await capture()).nonce).toBeNull();
    }
  );

  it("an ineligible system stamp still occupies its identity", async () => {
    await stop.cancel({ retainUntilReplacement: true });
    const expected = await capture();
    await fs.appendFile(
      chatPath,
      JSON.stringify({
        ...createMuxMessage("occupied", "user", "legacy context", {
          historySequence: 99,
          compactionReplacementNonce: expected.nonce!,
        }),
        role: ["system"],
      }) + "\n"
    );
    const before = await fs.readFile(chatPath);
    expect(
      await history.acceptCompactionReplacement(
        workspaceId,
        expected,
        {
          kind: "append",
          messages: [createMuxMessage("occupied", "user", "new input")],
        },
        noObserver
      )
    ).toEqual(Ok({ kind: "skipped" }));
    expect(await fs.readFile(chatPath)).toEqual(before);
    expect((await capture()).nonce).toBe(expected.nonce);
  });

  it.each(["system", "user", "assistant"] as const)(
    "legacy array role %s preserves its existing replacement authority",
    async (role) => {
      await stop.cancel({ retainUntilReplacement: true });
      const expected = await capture();
      assert(expected.nonce);
      const target = {
        ...createMuxMessage("legacy-role", "user", "legacy row", { historySequence: 1 }),
        role: [role],
      };
      await fs.appendFile(chatPath, JSON.stringify(target) + "\n");
      const before = await fs.readFile(chatPath);
      const persisted = (await rows()).find((row) => row.id === target.id);
      assert(persisted);
      const accepted = await history.acceptCompactionReplacement(
        workspaceId,
        expected,
        { kind: "resume", message: persisted },
        noObserver
      );
      if (role === "system") {
        expect(accepted).toEqual(Ok({ kind: "skipped" }));
        expect(await fs.readFile(chatPath)).toEqual(before);
        expect(await history.findCompactionReplacementWitness(workspaceId, expected.nonce)).toEqual(
          Ok(null)
        );
        expect((await stop.read())?.nonce).toBe(expected.nonce);
      } else {
        assert(accepted.success && accepted.data.kind === "accepted" && accepted.data.witness);
        expect(await stop.retireReplacement(accepted.data.witness)).toBe("applied");
      }
    }
  );

  it.each(["user", "assistant"] as const)(
    "retains a resumed legacy %s receipt through a separately read history update and restart",
    async (role) => {
      await stop.cancel({ retainUntilReplacement: true });
      const expected = await capture();
      assert(expected.nonce);
      await fs.appendFile(
        chatPath,
        JSON.stringify({
          ...createMuxMessage("legacy-update", role, "interrupted", { historySequence: 1 }),
          role: [role],
        }) + "\n"
      );
      const original = (await rows()).at(-1)!;
      const accepted = await history.acceptCompactionReplacement(
        workspaceId,
        expected,
        { kind: "resume", message: original },
        noObserver
      );
      assert(accepted.success && accepted.data.kind === "accepted" && accepted.data.witness);
      const update = (await rows()).at(-1)!;
      const persistedRole: unknown = update.role;
      expect(persistedRole).toEqual([role]);
      expect(update.role).not.toBe(original.role);
      // A later finalizer need not carry the receipt; the accepted disk occurrence owns it.
      delete update.metadata?.compactionReplacementNonce;
      expect(await history.updateHistory(workspaceId, update)).toEqual(Ok(undefined));
      const restarted = new HistoryService(fixture.config);
      expect(await restarted.findCompactionReplacementWitness(workspaceId, expected.nonce)).toEqual(
        Ok({ nonce: expected.nonce })
      );
      const recoveredStop = new CompactionCancellation(
        restarted.getCompactionCancellationStorage(workspaceId)
      );
      expect((await recoveredStop.read())?.nonce).toBe(expected.nonce);
      expect(await recoveredStop.retireReplacement({ nonce: expected.nonce })).toBe("applied");
      expect(await recoveredStop.read()).toBeNull();
    }
  );

  it.each([
    { name: "assistant", role: ["assistant"] },
    { name: "system", role: ["system"] },
    { name: "invalid", role: { legacy: "user" } },
  ])(
    "changing a legacy user role to $name cannot inherit its resumed receipt",
    async ({ role }) => {
      await stop.cancel({ retainUntilReplacement: true });
      const expected = await capture();
      assert(expected.nonce);
      await fs.appendFile(
        chatPath,
        JSON.stringify({
          ...createMuxMessage("changed-role", "user", "interrupted", { historySequence: 1 }),
          role: ["user"],
        }) + "\n"
      );
      const original = (await rows()).at(-1)!;
      const accepted = await history.acceptCompactionReplacement(
        workspaceId,
        expected,
        { kind: "resume", message: original },
        noObserver
      );
      assert(accepted.success && accepted.data.kind === "accepted" && accepted.data.witness);
      const update = (await rows()).at(-1)!;
      delete update.metadata?.compactionReplacementNonce;
      Object.assign(update, { role });
      expect(await history.updateHistory(workspaceId, update)).toEqual(Ok(undefined));
      const restarted = new HistoryService(fixture.config);
      expect(await restarted.findCompactionReplacementWitness(workspaceId, expected.nonce)).toEqual(
        Ok(null)
      );
      const recoveredStop = new CompactionCancellation(
        restarted.getCompactionCancellationStorage(workspaceId)
      );
      expect((await recoveredStop.read())?.nonce).toBe(expected.nonce);
      await assert.rejects(
        recoveredStop.retireReplacement({ nonce: expected.nonce }),
        /not verified/
      );
      expect((await restarted.getCompactionCancellationStorage(workspaceId).read())?.nonce).toBe(
        expected.nonce
      );
    }
  );

  it("pre-stamped legacy system rows cannot authorize Stop retirement", async () => {
    await stop.cancel({ retainUntilReplacement: true });
    const expected = await capture();
    assert(expected.nonce);
    for (const size of [8, SESSION_HISTORY_MAX_LINE_BYTES + 1]) {
      await fs.writeFile(
        chatPath,
        JSON.stringify({
          ...createMuxMessage("stamped-system", "user", "x".repeat(size), {
            historySequence: 1,
            compactionReplacementNonce: expected.nonce,
          }),
          role: ["system"],
        }) + "\n"
      );
      expect(await history.findCompactionReplacementWitness(workspaceId, expected.nonce)).toEqual(
        Ok(null)
      );
      await assert.rejects(stop.retireReplacement({ nonce: expected.nonce }), /not verified/);
      expect((await history.getCompactionCancellationStorage(workspaceId).read())?.nonce).toBe(
        expected.nonce
      );
    }
  });

  it.each([1, 2])(
    "superseding retirement %s times stops giant-row verification and disposes its handles",
    async (count) => {
      await stop.cancel({ retainUntilReplacement: true });
      const expected = await capture();
      const accepted = await history.acceptCompactionReplacement(
        workspaceId,
        expected,
        await operation("single"),
        noObserver
      );
      assert(accepted.success && accepted.data.kind === "accepted" && accepted.data.witness);
      const archivePath = path.join(path.dirname(chatPath), "chat-archive.jsonl");
      await fs.writeFile(
        archivePath,
        JSON.stringify(
          createMuxMessage("giant", "assistant", "x".repeat(8 * 1024 * 1024), {
            historySequence: 99,
          })
        ) + "\n"
      );
      const successors: Array<ReturnType<CompactionCancellation["cancel"]>> = [];
      const entered = Promise.withResolvers<void>();
      const release = Promise.withResolvers<void>();
      let reads = 0;
      let opens = 0;
      let closes = 0;
      const open = fs.open;
      spyOn(fs, "open").mockImplementation(async (...args: Parameters<typeof open>) => {
        const handle = await open(...args);
        if (args[0] !== archivePath || args[1] !== "r") return handle;
        opens++;
        const read = handle.read.bind(handle);
        const close = handle.close.bind(handle);
        spyOn(handle, "close").mockImplementation(async () => {
          closes++;
          await close();
        });
        spyOn(handle, "read").mockImplementation(
          new Proxy(read, {
            async apply(target, receiver, args: Parameters<typeof read>) {
              const result = await (Reflect.apply(target, receiver, args) as ReturnType<
                typeof read
              >);
              if (++reads === 1) {
                entered.resolve();
                await release.promise;
              }
              return result;
            },
          })
        );
        return handle;
      });
      let successorSawDisposedScanner = false;
      const lock = history.withCompactionStorageLock.bind(history);
      spyOn(history, "withCompactionStorageLock").mockImplementation(async (...args) => {
        if (successors.length > 0) successorSawDisposedScanner = closes === opens;
        return lock(...args);
      });
      const retiring = stop.retireReplacement(accepted.data.witness);
      await entered.promise;
      try {
        for (let i = 0; i < count; i++)
          successors.push(stop.cancel({ retainUntilReplacement: true }));
      } finally {
        release.resolve();
      }
      expect(await retiring).toBe("superseded");
      expect(await Promise.all(successors)).toEqual(
        Array.from({ length: count }, (_, i) => (i === count - 1 ? "applied" : "superseded"))
      );
      expect(reads).toBe(1);
      expect(opens).toBeGreaterThan(0);
      expect(closes).toBe(opens);
      expect(successorSawDisposedScanner).toBe(true);
      expect((await stop.read())?.nonce).not.toBe(expected.nonce);
      expect((await capture()).nonce).toEqual((await stop.read())?.nonce ?? null);
      expect((await rows()).some((row) => row.id === "accepted")).toBe(true);
    }
  );

  async function operation(
    kind: "single" | "batch" | "resume"
  ): Promise<CompactionReplacementOperation> {
    if (kind === "resume") return { kind, message: (await rows()).at(-1)! };
    const messages = [createMuxMessage("accepted", "user", "new input")];
    if (kind === "batch") messages.unshift(createMuxMessage("payload", "assistant", "context"));
    return { kind: "append", messages };
  }
  function afterStaging(action: () => void | Promise<void>) {
    const open = fs.open;
    spyOn(fs, "open").mockImplementation(async (...args: Parameters<typeof open>) => {
      const handle = await open(...args);
      if (args[0] === chatPath && args[1] === "a") {
        try {
          await action();
        } catch (error) {
          await handle.close();
          throw error;
        }
      }
      return handle;
    });
    const atomic = atomicWrite.default;
    spyOn(atomicWrite, "default").mockImplementation(
      new Proxy(atomic, {
        async apply(target, _thisArg, args: Parameters<typeof atomic>) {
          const result = await target(...args);
          if (String(args[0]).startsWith(`${chatPath}.publication-`)) await action();
          return result;
        },
      })
    );
  }

  it.each(["chat", "archive", "oversized"] as const)(
    "one Stop cannot accept a second replacement before retirement (%s)",
    async (location) => {
      await stop.cancel({ retainUntilReplacement: true });
      const expected = await capture();
      const first = await history.acceptCompactionReplacement(
        workspaceId,
        expected,
        {
          kind: "append",
          messages: [
            createMuxMessage(
              "first-replacement",
              "user",
              location === "oversized" ? "x".repeat(SESSION_HISTORY_MAX_LINE_BYTES + 1) : "first"
            ),
          ],
        },
        noObserver
      );
      assert(first.success && first.data.kind === "accepted" && first.data.witness);
      if (location === "archive") {
        await fs.rename(chatPath, path.join(path.dirname(chatPath), "chat-archive.jsonl"));
      }
      const foreign = new HistoryService(fixture.config);
      expect(await foreign.captureCompactionReplacement(workspaceId)).toEqual(Ok(expected));
      const observed = mock(() => undefined);
      const second = await foreign.acceptCompactionReplacement(
        workspaceId,
        expected,
        { kind: "append", messages: [createMuxMessage("second-replacement", "user", "second")] },
        { isCurrent: () => true, onCommitted: observed }
      );
      expect(second).toEqual(Ok({ kind: "skipped" }));
      expect(observed).not.toHaveBeenCalled();
      expect((await rows()).some((row) => row.id === "second-replacement")).toBe(false);
      expect(await stop.retireReplacement(first.data.witness)).toBe("applied");
      const successor = await capture();
      expect(successor).toEqual({ ...expected, nonce: null });
      const later = await foreign.acceptCompactionReplacement(
        workspaceId,
        successor,
        { kind: "append", messages: [createMuxMessage("later", "user", "after retirement")] },
        noObserver
      );
      expect(later).toEqual(Ok({ kind: "accepted", witness: null }));
    }
  );

  it("a consumed nonce refuses another Resume but permits ordinary preserve-mode input", async () => {
    await stop.cancel({ retainUntilReplacement: true });
    const expected = await capture();
    const original = (await rows())[0];
    const first = await history.acceptCompactionReplacement(
      workspaceId,
      expected,
      { kind: "append", messages: [createMuxMessage("replacement", "user", "new input")] },
      noObserver
    );
    assert(first.success && first.data.kind === "accepted" && first.data.witness);
    const before = await fs.readFile(chatPath);
    expect(
      await history.acceptCompactionReplacement(
        workspaceId,
        expected,
        { kind: "resume", message: original },
        noObserver
      )
    ).toEqual(Ok({ kind: "skipped" }));
    expect(await fs.readFile(chatPath)).toEqual(before);
    expect(
      await history.acceptCompactionReplacement(
        workspaceId,
        expected,
        {
          kind: "append",
          messages: [createMuxMessage("ordinary", "user", "ordinary input")],
          preserveCancellation: true,
        },
        noObserver
      )
    ).toEqual(Ok({ kind: "accepted", witness: null }));
    expect(await capture()).toEqual(expected);
    expect((await rows()).at(-1)?.metadata?.compactionReplacementNonce).toBeUndefined();
    expect(await stop.retireReplacement(first.data.witness)).toBe("applied");
  });

  it.each(["single", "batch"] as const)(
    "publication bookkeeping uses the original %s array references after staging",
    async (kind) => {
      await stop.cancel({ retainUntilReplacement: true });
      const expected = await capture();
      const input = await operation(kind);
      assert(input.kind === "append");
      const original = [...input.messages];
      const added = createMuxMessage("not-in-batch", "user", "late input");
      afterStaging(() => {
        input.messages.unshift(added);
      });
      const committed = mock(() => undefined);
      const result = await history.acceptCompactionReplacement(workspaceId, expected, input, {
        isCurrent: () => true,
        onCommitted: committed,
      });
      expect(result).toEqual(Ok({ kind: "accepted", witness: { nonce: expected.nonce! } }));
      expect(committed).toHaveBeenCalledTimes(1);
      expect(added.metadata?.historySequence).toBeUndefined();
      const saved = await rows();
      expect(saved.some((row) => row.id === added.id)).toBe(false);
      for (const message of original) {
        expect(message.metadata?.historySequence).toBe(
          saved.find((row) => row.id === message.id)?.metadata?.historySequence
        );
      }
      expect(await stop.retireReplacement({ nonce: expected.nonce! })).toBe("applied");
    }
  );

  it.each([
    { kind: "single", rejected: false },
    { kind: "single", rejected: true },
    { kind: "single", rejected: "capsule" },
    { kind: "batch", rejected: false },
    { kind: "batch", rejected: true },
    { kind: "batch", rejected: "capsule" },
  ] as const)(
    "$kind ordinary acceptance preserves scoped Stop bytes without a witness (rejected=$rejected)",
    async ({ kind, rejected }) => {
      await stop.cancel();
      const expected = await capture();
      await stop.narrow(expected.nonce!, {
        id: "old-summary",
        sequence: 0,
        pendingFollowUp: { text: "old request" },
      });
      const stopPath = history.getCompactionCancellationStorage(workspaceId).path;
      const before = await fs.readFile(stopPath);
      const input = await operation(kind);
      assert(input.kind === "append");
      input.preserveCancellation = true;
      input.messages.at(-1)!.metadata = {
        compactionReplacementNonce: expected.nonce!,
        ...(rejected ? { contextBudgetRejected: true } : {}),
      };
      const originalTrigger = input.messages.at(-1)!;
      if (rejected === "capsule")
        input.messages[input.messages.length - 1] =
          createContextBudgetRejectedMessage(originalTrigger);
      // Mutation after preparation must not turn ordinary input into replacement authority.
      afterStaging(() => {
        delete input.preserveCancellation;
      });
      const committed = mock((receipt: { witness: unknown }) => {
        expect(receipt.witness).toBeNull();
        expect(nodeFs.readFileSync(chatPath, "utf8")).toContain('"id":"accepted"');
        throw new Error("notification failed after commit");
      });
      expect(
        await history.acceptCompactionReplacement(workspaceId, expected, input, {
          isCurrent: () => true,
          onCommitted: committed,
        })
      ).toEqual(Ok({ kind: "accepted", witness: null }));
      expect(committed).toHaveBeenCalledTimes(1);
      expect(await fs.readFile(stopPath)).toEqual(before);
      const persisted = (await rows()).at(-1)!;
      expect(persisted.metadata?.compactionReplacementNonce).toBeUndefined();
      expect(persisted.metadata?.contextBudgetRejected === true).toBe(Boolean(rejected));
      if (rejected === "capsule") {
        expect(persisted.role).toBe("assistant");
        expect(persisted.parts).toEqual([]);
        expect(persisted.metadata?.contextBudgetRejectedMessage?.parts).toEqual(
          originalTrigger.parts
        );
      }
      expect(
        await new HistoryService(fixture.config).findCompactionReplacementWitness(
          workspaceId,
          expected.nonce!
        )
      ).toEqual(Ok(null));
    }
  );

  it.each([
    { kind: "single", capsule: false },
    { kind: "single", capsule: true },
    { kind: "resume", capsule: false },
    { kind: "resume", capsule: true },
  ] as const)(
    "$kind replacement refuses budget-rejected input without changing Stop or history (capsule=$capsule)",
    async ({ kind, capsule }) => {
      let rejected = createMuxMessage("rejected", "user", "over budget");
      rejected.metadata = { contextBudgetRejected: true };
      if (capsule) rejected = createContextBudgetRejectedMessage(rejected);
      if (kind === "resume")
        expect((await history.appendToHistory(workspaceId, rejected)).success).toBe(true);
      await stop.cancel({ retainUntilReplacement: true });
      const expected = await capture();
      const input: CompactionReplacementOperation =
        kind === "resume"
          ? { kind, message: (await rows()).at(-1)! }
          : { kind: "append", messages: [rejected] };
      const before = await fs.readFile(chatPath);
      const stopPath = history.getCompactionCancellationStorage(workspaceId).path;
      const stopBefore = await fs.readFile(stopPath);
      const committed = mock(() => undefined);
      expect(
        await history.acceptCompactionReplacement(workspaceId, expected, input, {
          isCurrent: () => true,
          onCommitted: committed,
        })
      ).toEqual(Ok({ kind: "skipped" }));
      expect(committed).not.toHaveBeenCalled();
      expect(await fs.readFile(chatPath)).toEqual(before);
      expect(await fs.readFile(stopPath)).toEqual(stopBefore);
    }
  );

  it.each([
    { role: "assistant", rejected: false },
    { role: "system", rejected: true },
  ] as const)(
    "ordinary acceptance refuses unrelated $role triggers",
    async ({ role, rejected }) => {
      await stop.cancel();
      const expected = await capture();
      const message = { ...createMuxMessage("unrelated", "assistant", "payload"), role };
      if (rejected) message.metadata = { contextBudgetRejected: true };
      const before = await fs.readFile(chatPath);
      const committed = mock(() => undefined);
      expect(
        await history.acceptCompactionReplacement(
          workspaceId,
          expected,
          { kind: "append", messages: [message], preserveCancellation: true },
          { isCurrent: () => true, onCommitted: committed }
        )
      ).toEqual(Ok({ kind: "skipped" }));
      expect(committed).not.toHaveBeenCalled();
      expect(await fs.readFile(chatPath)).toEqual(before);
      expect(await capture()).toEqual(expected);
    }
  );

  it.each(["single", "batch"] as const)(
    "%s ordinary acceptance issues no receipt on staging failure",
    async (kind) => {
      await stop.cancel();
      const expected = await capture();
      const stopPath = history.getCompactionCancellationStorage(workspaceId).path;
      const before = await fs.readFile(stopPath);
      const chatBefore = await fs.readFile(chatPath);
      const input = await operation(kind);
      assert(input.kind === "append");
      input.preserveCancellation = true;
      afterStaging(() => {
        throw new Error("ordinary staging failed");
      });
      const committed = mock(() => undefined);
      const result = await history.acceptCompactionReplacement(workspaceId, expected, input, {
        isCurrent: () => true,
        onCommitted: committed,
      });
      expect(result.success).toBe(false);
      expect(committed).not.toHaveBeenCalled();
      expect(await fs.readFile(chatPath)).toEqual(chatBefore);
      expect(await fs.readFile(stopPath)).toEqual(before);
    }
  );

  it.each([
    { change: "nonce", rejected: false },
    { change: "nonce", rejected: true },
    { change: "nonce", rejected: "capsule" },
    { change: "generation", rejected: false },
    { change: "generation", rejected: true },
    { change: "generation", rejected: "capsule" },
  ] as const)(
    "ordinary acceptance refuses a held foreign $change change (rejected=$rejected)",
    async ({ change, rejected }) => {
      if (change === "nonce") await stop.cancel();
      const expected = await capture();
      const before = await fs.readFile(chatPath);
      const input = await operation("single");
      assert(input.kind === "append");
      input.preserveCancellation = true;
      if (rejected) input.messages.at(-1)!.metadata = { contextBudgetRejected: true };
      if (rejected === "capsule")
        input.messages[0] = createContextBudgetRejectedMessage(input.messages[0]);
      const entered = Promise.withResolvers<void>();
      const release = Promise.withResolvers<void>();
      const withLock = workspaceFileLocks.withLock.bind(workspaceFileLocks);
      spyOn(workspaceFileLocks, "withLock").mockImplementationOnce(async (key, operation) => {
        entered.resolve();
        await release.promise;
        return withLock(key, operation);
      });
      const committed = mock(() => undefined);
      const accepting = history.acceptCompactionReplacement(workspaceId, expected, input, {
        isCurrent: () => true,
        onCommitted: committed,
      });
      await entered.promise;
      const foreign = new CompactionCancellation(
        new HistoryService(fixture.config).getCompactionCancellationStorage(workspaceId)
      );
      try {
        await foreign.cancel();
        const record = await foreign.read();
        assert(record);
        if (change === "generation") await foreign.retire(record.nonce);
      } finally {
        release.resolve();
      }
      expect(await accepting).toEqual(Ok({ kind: "superseded" }));
      expect(committed).not.toHaveBeenCalled();
      expect(await fs.readFile(chatPath)).toEqual(before);
      const current = await capture();
      expect(current.generation).not.toBe(expected.generation);
      if (change === "generation") expect(current.nonce).toBe(expected.nonce);
      else expect(current.nonce).not.toBe(expected.nonce);
    }
  );

  it.each(["original", "schema", "signed-schema", "dated-signed-schema"] as const)(
    "accepts a %s resume target without its persistence envelope",
    async (shape) => {
      const original = {
        ...createMuxMessage("resume-target", "assistant", "interrupted"),
        ...(shape === "dated-signed-schema" ? { createdAt: new Date("2026-09-11T00:00:00Z") } : {}),
      };
      if (shape === "signed-schema" || shape === "dated-signed-schema") {
        original.parts.unshift({
          type: "reasoning",
          text: "thinking",
          signature: "provider-signature",
        });
        original.metadata = { enqueuedAtMs: 123, goalId: "goal-scope" };
      }
      expect((await history.appendToHistory(workspaceId, original)).success).toBe(true);
      const target =
        shape === "original"
          ? original
          : MuxMessageSchema.parse({
              ...(await rows()).at(-1)!,
              ...(original.createdAt ? { createdAt: original.createdAt } : {}),
            });
      await stop.cancel({ retainUntilReplacement: true });
      const expected = await capture();
      for (const changed of [
        { ...target, parts: [{ type: "text" as const, text: "different content" }] },
        { ...target, metadata: { ...target.metadata, partial: true } },
        { ...target, metadata: { ...target.metadata, goalId: "different-goal" } },
        {
          ...target,
          parts: [
            { type: "reasoning" as const, text: "thinking", signature: "different-signature" },
            ...target.parts.slice(1),
          ],
        },
      ]) {
        expect(
          await history.acceptCompactionReplacement(
            workspaceId,
            expected,
            { kind: "resume", message: changed },
            noObserver
          )
        ).toEqual(Ok({ kind: "skipped" }));
      }
      expect(
        await history.acceptCompactionReplacement(
          workspaceId,
          expected,
          { kind: "resume", message: target },
          noObserver
        )
      ).toEqual(Ok({ kind: "accepted", witness: { nonce: expected.nonce! } }));
      const persisted = (await rows()).at(-1)!;
      if (original.createdAt) {
        const persistedRaw = JSON.parse(
          (await fs.readFile(chatPath, "utf8")).trimEnd().split("\n").at(-1)!
        ) as { createdAt?: string };
        expect(persistedRaw.createdAt).toBe(original.createdAt.toISOString());
      }
      expect(persisted.parts).toEqual(original.parts);
      expect(persisted.metadata).toMatchObject(original.metadata!);
      const fresh = new HistoryService(fixture.config);
      expect(await fresh.findCompactionReplacementWitness(workspaceId, expected.nonce!)).toEqual(
        Ok({ nonce: expected.nonce! })
      );
      expect(await stop.retireReplacement({ nonce: expected.nonce! })).toBe("applied");
    }
  );

  it.each([
    { kind: "single", value: "bigint" },
    { kind: "single", value: "circular" },
    { kind: "resume", value: "bigint" },
    { kind: "resume", value: "circular" },
  ] as const)(
    "returns an Err for $kind $value serialization without changing history",
    async ({ kind, value }) => {
      await stop.cancel({ retainUntilReplacement: true });
      const expected = await capture();
      const input = await operation(kind);
      const message = input.kind === "append" ? input.messages[0] : input.message;
      const circular: { self?: unknown } = {};
      circular.self = circular;
      message.parts.push({
        type: "dynamic-tool",
        toolName: "test",
        toolCallId: "call",
        state: "output-available",
        input: {},
        output: value === "bigint" ? 1n : circular,
      });
      const before = await fs.readFile(chatPath);
      const stopPath = history.getCompactionCancellationStorage(workspaceId).path;
      const stopBefore = await fs.readFile(stopPath);
      const onCommitted = mock(() => undefined);
      const result = await history.acceptCompactionReplacement(workspaceId, expected, input, {
        isCurrent: () => true,
        onCommitted,
      });
      expect(result.success).toBe(false);
      assert(!result.success);
      expect(result.error).toContain("Failed to accept compaction replacement:");
      expect(onCommitted).not.toHaveBeenCalled();
      expect(await fs.readFile(chatPath)).toEqual(before);
      expect(await fs.readFile(stopPath)).toEqual(stopBefore);
    }
  );

  it.each([false, true])(
    "recognizes an unterminated archive replay after repair=%s",
    async (repair) => {
      await stop.cancel({ retainUntilReplacement: true });
      const expected = await capture();
      await history.acceptCompactionReplacement(
        workspaceId,
        expected,
        await operation("single"),
        noObserver
      );
      const active = await fs.readFile(chatPath, "utf8");
      const committed = active.trimEnd().split("\n").at(-1)!;
      const archivePath = path.join(path.dirname(chatPath), "chat-archive.jsonl");
      // Archive append stopped after the complete JSON object, before its final delimiter.
      await fs.writeFile(archivePath, committed);
      if (repair) {
        expect(
          (
            await history.appendToHistory(
              workspaceId,
              createMuxMessage("boundary", "assistant", "summary", {
                compacted: "user",
                compactionBoundary: true,
                compactionEpoch: 1,
              })
            )
          ).success
        ).toBe(true);
        const archived = (await fs.readFile(archivePath, "utf8")).trimEnd().split("\n");
        expect(archived.filter((line) => line === committed)).toHaveLength(2);
      }
      const fresh = new HistoryService(fixture.config);
      expect(await fresh.findCompactionReplacementWitness(workspaceId, expected.nonce!)).toEqual(
        Ok({ nonce: expected.nonce! })
      );
      const freshStop = new CompactionCancellation(
        fresh.getCompactionCancellationStorage(workspaceId)
      );
      expect((await freshStop.read())?.nonce).toBe(expected.nonce!);
      expect(await freshStop.retireReplacement({ nonce: expected.nonce! })).toBe("applied");
      expect(await freshStop.read()).toBeNull();
    }
  );

  it.each([false, true])(
    "resume rewrites history only when stamping a retained Stop (Stop=%s)",
    async (canceled) => {
      if (canceled) await stop.cancel({ retainUntilReplacement: true });
      const expected = await capture();
      const input = await operation("resume");
      const before = await fs.readFile(chatPath);
      const original = await fs.stat(chatPath);
      const committed = mock(() => {
        const persisted = JSON.parse(nodeFs.readFileSync(chatPath, "utf8").trim()) as MuxMessage;
        expect(persisted.metadata?.compactionReplacementNonce ?? null).toBe(expected.nonce);
        // Notification failure cannot revoke acceptance of an existing durable row either.
        throw new Error("observer failed");
      });
      const accepted = await history.acceptCompactionReplacement(workspaceId, expected, input, {
        isCurrent: () => true,
        onCommitted: committed,
      });
      expect(accepted).toEqual(
        Ok({ kind: "accepted", witness: canceled ? { nonce: expected.nonce! } : null })
      );
      expect(committed).toHaveBeenCalledTimes(1);
      expect((await fs.stat(chatPath)).ino === original.ino).toBe(!canceled);
      if (!canceled) expect(await fs.readFile(chatPath)).toEqual(before);
      expect(await capture()).toEqual(expected);
    }
  );

  it.each([false, true])(
    "a held absent-nonce resume refuses a foreign Stop even after retirement (retire=%s)",
    async (retire) => {
      const expected = await capture();
      const input = await operation("resume");
      const before = await fs.readFile(chatPath);
      const entered = Promise.withResolvers<void>();
      const release = Promise.withResolvers<void>();
      const withLock = workspaceFileLocks.withLock.bind(workspaceFileLocks);
      spyOn(workspaceFileLocks, "withLock").mockImplementationOnce(async (key, operation) => {
        entered.resolve();
        await release.promise;
        return withLock(key, operation);
      });
      const committed = mock(() => undefined);
      const accepting = history.acceptCompactionReplacement(workspaceId, expected, input, {
        isCurrent: () => true,
        onCommitted: committed,
      });
      await entered.promise;
      const foreign = new CompactionCancellation(
        new HistoryService(fixture.config).getCompactionCancellationStorage(workspaceId)
      );
      try {
        await foreign.cancel();
        const stopped = await foreign.read();
        assert(stopped);
        if (retire) await foreign.retire(stopped.nonce);
      } finally {
        release.resolve();
      }
      expect(await accepting).toEqual(Ok({ kind: "superseded" }));
      expect(committed).not.toHaveBeenCalled();
      expect(await fs.readFile(chatPath)).toEqual(before);
      const current = await capture();
      expect(current.generation).not.toBe(expected.generation);
      if (retire) expect(current.nonce).toBeNull();
      else expect(current.nonce).not.toBeNull();
    }
  );

  it.each(["admission", "lease"] as const)(
    "absent-nonce resume rechecks %s after its exact-target read",
    async (lost) => {
      const expected = await capture();
      const input = await operation("resume");
      const before = await fs.readFile(chatPath);
      const entered = Promise.withResolvers<void>();
      const release = Promise.withResolvers<void>();
      const readFile = fs.readFile;
      let armed = true;
      spyOn(fs, "readFile").mockImplementation(
        new Proxy(readFile, {
          async apply(target, thisArg, args: Parameters<typeof readFile>) {
            const bytes = await Reflect.apply(target, thisArg, args);
            if (armed && args[0] === chatPath) {
              armed = false;
              entered.resolve();
              await release.promise;
            }
            return bytes;
          },
        })
      );
      let current = true;
      const committed = mock(() => undefined);
      const accepting = history.acceptCompactionReplacement(workspaceId, expected, input, {
        isCurrent: () => current,
        onCommitted: committed,
      });
      const lockPath = historyWriteLockPath(fixture.config.rootDir, workspaceId);
      await entered.promise;
      try {
        if (lost === "admission") current = false;
        else await fs.writeFile(lockPath, "foreign-owner");
      } finally {
        release.resolve();
      }
      const result = await accepting;
      if (lost === "admission") expect(result).toEqual(Ok({ kind: "superseded" }));
      else {
        expect(result.success).toBe(false);
        await fs.rm(lockPath);
      }
      expect(committed).not.toHaveBeenCalled();
      expect(await fs.readFile(chatPath)).toEqual(before);
    }
  );

  it("absent-nonce resume still requires an exact unique eligible target", async () => {
    const expected = await capture();
    const target = (await rows())[0];
    const original = await fs.readFile(chatPath);
    const committed = mock(() => undefined);
    for (const message of [
      { ...target, id: "missing" },
      { ...target, parts: [{ type: "text", text: "changed" }] },
      { ...target, metadata: { ...target.metadata, historySequence: undefined } },
    ] satisfies MuxMessage[]) {
      expect(
        await history.acceptCompactionReplacement(
          workspaceId,
          expected,
          { kind: "resume", message },
          { isCurrent: () => true, onCommitted: committed }
        )
      ).toEqual(Ok({ kind: "skipped" }));
    }
    for (const extra of [
      { ...target, id: "same-sequence" },
      { ...target, metadata: { ...target.metadata, historySequence: 10 } },
    ]) {
      await fs.writeFile(
        chatPath,
        Buffer.concat([original, Buffer.from(JSON.stringify(extra) + "\n")])
      );
      const before = await fs.readFile(chatPath);
      expect(
        await history.acceptCompactionReplacement(
          workspaceId,
          expected,
          { kind: "resume", message: target },
          { isCurrent: () => true, onCommitted: committed }
        )
      ).toEqual(Ok({ kind: "skipped" }));
      expect(await fs.readFile(chatPath)).toEqual(before);
    }
    expect(committed).not.toHaveBeenCalled();
  });

  it.each([false, true])(
    "single acceptance preserves append-only history (Stop=%s)",
    async (canceled) => {
      if (canceled) await stop.cancel({ retainUntilReplacement: true });
      const expected = await capture();
      const before = await fs.readFile(chatPath);
      const original = await fs.stat(chatPath);
      const accepted = await history.acceptCompactionReplacement(
        workspaceId,
        expected,
        await operation("single"),
        noObserver
      );
      expect(accepted).toEqual(
        Ok({ kind: "accepted", witness: canceled ? { nonce: expected.nonce! } : null })
      );
      expect((await fs.stat(chatPath)).ino).toBe(original.ino);
      expect((await fs.readFile(chatPath)).subarray(0, before.length)).toEqual(before);
    }
  );

  it("partial single-row writes issue no receipt and the next append repairs the torn tail", async () => {
    await stop.cancel({ retainUntilReplacement: true });
    const expected = await capture();
    const before = await fs.readFile(chatPath);
    const committed = mock(() => undefined);
    let writes = 0;
    const write = nodeFs.writeSync;
    spyOn(nodeFs, "writeSync").mockImplementation(
      new Proxy(write, {
        apply(target, receiver, args: unknown[]) {
          if (writes++ > 0) throw new Error("partial append failed");
          args[3] = 11;
          return Reflect.apply(target, receiver, args) as ReturnType<typeof write>;
        },
      })
    );
    const failed = await history.acceptCompactionReplacement(
      workspaceId,
      expected,
      await operation("single"),
      {
        isCurrent: () => true,
        onCommitted: committed,
      }
    );
    expect(failed.success).toBe(false);
    expect(committed).not.toHaveBeenCalled();
    const torn = await fs.readFile(chatPath);
    expect(torn.length).toBe(before.length + 11);
    expect(torn.subarray(0, before.length)).toEqual(before);
    expect(await history.findCompactionReplacementWitness(workspaceId, expected.nonce!)).toEqual(
      Ok(null)
    );
    expect((await stop.read())?.retainUntilReplacement).toBe(true);
    mock.restore();
    expect(
      await history.acceptCompactionReplacement(
        workspaceId,
        await capture(),
        {
          kind: "append",
          messages: [createMuxMessage("retry", "user", "new input")],
        },
        noObserver
      )
    ).toEqual(Ok({ kind: "accepted", witness: { nonce: expected.nonce! } }));
    expect((await fs.readFile(chatPath)).subarray(0, torn.length)).toEqual(torn);
    expect(await history.findCompactionReplacementWitness(workspaceId, expected.nonce!)).toEqual(
      Ok({ nonce: expected.nonce! })
    );
  });

  it("a missing final delimiter agrees with restart witnessing and cannot duplicate on retry", async () => {
    await stop.cancel({ retainUntilReplacement: true });
    const expected = await capture();
    const input = await operation("single");
    const committed = mock(() => undefined);
    let writes = 0;
    const write = nodeFs.writeSync;
    spyOn(nodeFs, "writeSync").mockImplementation(
      new Proxy(write, {
        apply(target, receiver, args: unknown[]) {
          if (writes++ > 0) throw new Error("delimiter write failed");
          assert(typeof args[3] === "number");
          args[3]--;
          return Reflect.apply(target, receiver, args) as ReturnType<typeof write>;
        },
      })
    );
    const accepted = await history.acceptCompactionReplacement(workspaceId, expected, input, {
      isCurrent: () => true,
      onCommitted: committed,
    });
    expect(accepted).toEqual(Ok({ kind: "accepted", witness: { nonce: expected.nonce! } }));
    expect(committed).toHaveBeenCalledTimes(1);
    mock.restore();
    const bytes = await fs.readFile(chatPath);
    expect(bytes.at(-1)).not.toBe(10);
    const restarted = new HistoryService(fixture.config);
    expect(await restarted.findCompactionReplacementWitness(workspaceId, expected.nonce!)).toEqual(
      Ok({ nonce: expected.nonce! })
    );
    expect(
      await history.acceptCompactionReplacement(workspaceId, expected, input, noObserver)
    ).toEqual(Ok({ kind: "skipped" }));
    expect(await fs.readFile(chatPath)).toEqual(bytes);
    expect((await rows()).map((row) => row.id)).toEqual(["prior", "accepted"]);
  });

  it.skipIf(process.platform === "win32").each([false, true])(
    "new chat acceptance requires directory durability (flush fails=%s)",
    async (fails) => {
      await stop.cancel({ retainUntilReplacement: true });
      await fs.rm(chatPath);
      const expected = await capture();
      let directorySynced = false;
      let syncedBeforeReceipt = false;
      const sync = nodeFs.fsyncSync;
      spyOn(nodeFs, "fsyncSync").mockImplementation((fd) => {
        if (nodeFs.fstatSync(fd).isDirectory()) {
          if (fails) throw new Error("new chat directory unavailable");
          directorySynced = true;
        }
        return sync(fd);
      });
      const committed = mock(() => {
        syncedBeforeReceipt = directorySynced;
        return undefined;
      });
      const result = await history.acceptCompactionReplacement(
        workspaceId,
        expected,
        await operation("single"),
        {
          isCurrent: () => true,
          onCommitted: committed,
        }
      );
      expect(result.success).toBe(!fails);
      expect(committed).toHaveBeenCalledTimes(fails ? 0 : 1);
      if (!fails) expect(syncedBeforeReceipt).toBe(true);
      expect(await stop.read()).toMatchObject({
        nonce: expected.nonce,
        retainUntilReplacement: true,
      });
    }
  );

  it("flushes the exact open append descriptor before publishing acceptance", async () => {
    const open = fs.open;
    let appendFd: number | undefined;
    let flushed = false;
    spyOn(fs, "open").mockImplementation(async (...args: Parameters<typeof open>) => {
      const handle = await open(...args);
      if (args[0] === chatPath && args[1] === "a") appendFd = handle.fd;
      return handle;
    });
    const sync = nodeFs.fsyncSync;
    spyOn(nodeFs, "fsyncSync").mockImplementation((fd) => {
      expect(fd).toBe(appendFd!);
      sync(fd);
      flushed = true;
    });
    const accepted = await history.acceptCompactionReplacement(
      workspaceId,
      await capture(),
      await operation("single"),
      {
        isCurrent: () => true,
        onCommitted: () => {
          expect(flushed).toBe(true);
        },
      }
    );
    expect(accepted).toEqual(Ok({ kind: "accepted", witness: null }));
  });

  it.each([false, true])(
    "failed append flush retains Stop through restart verification (missing LF=%s)",
    async (missingLf) => {
      await stop.cancel({ retainUntilReplacement: true });
      const expected = await capture();
      const input = await operation("single");
      const committed = mock(() => undefined);
      if (missingLf) {
        let writes = 0;
        const write = nodeFs.writeSync;
        spyOn(nodeFs, "writeSync").mockImplementation(
          new Proxy(write, {
            apply(target, receiver, args: unknown[]) {
              if (writes++ > 0) throw new Error("delimiter write failed");
              assert(typeof args[3] === "number");
              args[3]--;
              return Reflect.apply(target, receiver, args) as ReturnType<typeof write>;
            },
          })
        );
      }
      spyOn(nodeFs, "fsyncSync").mockImplementation(() => {
        throw new Error("History flush unavailable");
      });
      const open = fs.open;
      spyOn(fs, "open").mockImplementation(async (...args: Parameters<typeof open>) => {
        const handle = await open(...args);
        if (args[0] === chatPath)
          spyOn(handle, "sync").mockRejectedValue(new Error("History flush unavailable"));
        return handle;
      });
      const failed = await history.acceptCompactionReplacement(workspaceId, expected, input, {
        isCurrent: () => true,
        onCommitted: committed,
      });
      expect(failed.success).toBe(false);
      expect(committed).not.toHaveBeenCalled();
      const appended = await fs.readFile(chatPath);
      expect((await rows()).filter((row) => row.id === "accepted")).toHaveLength(1);
      expect(
        await history.acceptCompactionReplacement(workspaceId, expected, input, noObserver)
      ).toEqual(Ok({ kind: "skipped" }));
      expect(await fs.readFile(chatPath)).toEqual(appended);
      const restarted = new HistoryService(fixture.config);
      expect(
        (await restarted.findCompactionReplacementWitness(workspaceId, expected.nonce!)).success
      ).toBe(false);
      const freshStop = new CompactionCancellation(
        restarted.getCompactionCancellationStorage(workspaceId)
      );
      await freshStop.read();
      expect(
        await freshStop
          .retireReplacement({ nonce: expected.nonce! })
          .catch((error: unknown) => error)
      ).toBeInstanceOf(Error);
      expect(
        (
          await new CompactionCancellation(
            restarted.getCompactionCancellationStorage(workspaceId)
          ).read()
        )?.nonce
      ).toBe(expected.nonce!);
      mock.restore();
      const witness = await restarted.findCompactionReplacementWitness(
        workspaceId,
        expected.nonce!
      );
      expect(witness).toEqual(Ok({ nonce: expected.nonce! }));
      expect(await freshStop.retry()).toBe("applied");
      expect(
        await new CompactionCancellation(
          restarted.getCompactionCancellationStorage(workspaceId)
        ).read()
      ).toBeNull();
      expect(await fs.readFile(chatPath)).toEqual(appended);
    }
  );

  it.skipIf(process.platform === "win32").each(["batch", "resume"] as const)(
    "%s flushes the renamed history directory before issuing acceptance",
    async (kind) => {
      await stop.cancel({ retainUntilReplacement: true });
      const expected = await capture();
      const input = await operation(kind);
      const directoryFds = new Set<number>();
      const open = fs.open;
      spyOn(fs, "open").mockImplementation(async (...args: Parameters<typeof open>) => {
        const handle = await open(...args);
        if (args[0] === path.dirname(chatPath)) directoryFds.add(handle.fd);
        return handle;
      });
      let directoryFlushed = false;
      const sync = nodeFs.fsyncSync;
      spyOn(nodeFs, "fsyncSync").mockImplementation((fd) => {
        sync(fd);
        if (directoryFds.has(fd)) {
          expect(nodeFs.readFileSync(chatPath, "utf8")).toContain(expected.nonce!);
          directoryFlushed = true;
        }
      });
      let flushedAtCommit = false;
      const committed = mock(() => {
        flushedAtCommit = directoryFlushed;
        return undefined;
      });
      expect(
        await history.acceptCompactionReplacement(workspaceId, expected, input, {
          isCurrent: () => true,
          onCommitted: committed,
        })
      ).toEqual(Ok({ kind: "accepted", witness: { nonce: expected.nonce! } }));
      expect(committed).toHaveBeenCalledTimes(1);
      expect(flushedAtCommit).toBe(true);
    }
  );

  it.skipIf(process.platform === "win32").each(["batch", "resume"] as const)(
    "%s directory flush failure retains Stop through fresh-reader recovery",
    async (kind) => {
      await stop.cancel({ retainUntilReplacement: true });
      const expected = await capture();
      const input = await operation(kind);
      const committed = mock(() => undefined);
      let renamed = false;
      const rename = nodeFs.renameSync;
      spyOn(nodeFs, "renameSync").mockImplementation((from, to) => {
        rename(from, to);
        if (to === chatPath) renamed = true;
      });
      const open = fs.open;
      spyOn(fs, "open").mockImplementation(async (...args: Parameters<typeof open>) => {
        const handle = await open(...args);
        if (args[0] === path.dirname(chatPath)) {
          const sync = handle.sync.bind(handle);
          spyOn(handle, "sync").mockImplementation(async () => {
            if (renamed) throw new Error("Directory flush unavailable");
            await sync();
          });
        }
        return handle;
      });
      const sync = nodeFs.fsyncSync;
      spyOn(nodeFs, "fsyncSync").mockImplementation((fd) => {
        if (renamed && nodeFs.fstatSync(fd).isDirectory())
          throw new Error("Directory flush unavailable");
        sync(fd);
      });
      expect(
        (
          await history.acceptCompactionReplacement(workspaceId, expected, input, {
            isCurrent: () => true,
            onCommitted: committed,
          })
        ).success
      ).toBe(false);
      expect(committed).not.toHaveBeenCalled();
      const published = await fs.readFile(chatPath);
      expect(published.toString()).toContain(expected.nonce!);
      expect(
        (await history.acceptCompactionReplacement(workspaceId, expected, input, noObserver))
          .success
      ).toBe(false);
      expect(await fs.readFile(chatPath)).toEqual(published);
      const restarted = new HistoryService(fixture.config);
      expect(
        (await restarted.findCompactionReplacementWitness(workspaceId, expected.nonce!)).success
      ).toBe(false);
      const freshStop = new CompactionCancellation(
        restarted.getCompactionCancellationStorage(workspaceId)
      );
      expect((await freshStop.read())?.nonce).toBe(expected.nonce!);
      expect(
        await freshStop
          .retireReplacement({ nonce: expected.nonce! })
          .catch((error: unknown) => error)
      ).toBeInstanceOf(Error);
      expect(
        (
          await new CompactionCancellation(
            restarted.getCompactionCancellationStorage(workspaceId)
          ).read()
        )?.nonce
      ).toBe(expected.nonce!);
      mock.restore();
      expect(
        await history.acceptCompactionReplacement(workspaceId, expected, input, noObserver)
      ).toEqual(Ok({ kind: "skipped" }));
      expect(
        await restarted.findCompactionReplacementWitness(workspaceId, expected.nonce!)
      ).toEqual(Ok({ nonce: expected.nonce! }));
      expect(await freshStop.retry()).toBe("applied");
      expect(
        await new CompactionCancellation(
          restarted.getCompactionCancellationStorage(workspaceId)
        ).read()
      ).toBeNull();
      expect(await fs.readFile(chatPath)).toEqual(published);
    }
  );

  it.each([
    ["lookup", "file"],
    ["retire", "file"],
    ...(process.platform === "win32"
      ? []
      : [
          ["lookup", "directory"],
          ["retire", "directory"],
        ]),
  ])("revalidates %s witness evidence after the %s durability flush", async (use, artifact) => {
    await stop.cancel({ retainUntilReplacement: true });
    const expected = await capture();
    await history.acceptCompactionReplacement(
      workspaceId,
      expected,
      await operation("single"),
      noObserver
    );
    const open = fs.open;
    let changed = false;
    let fileFlushed = false;
    spyOn(fs, "open").mockImplementation(async (...args: Parameters<typeof open>) => {
      const handle = await open(...args);
      if (args[0] === chatPath || args[0] === path.dirname(chatPath)) {
        const sync = handle.sync.bind(handle);
        spyOn(handle, "sync").mockImplementation(async () => {
          await sync();
          if (args[0] === chatPath) fileFlushed = true;
          if (
            !changed &&
            fileFlushed &&
            args[0] === (artifact === "file" ? chatPath : path.dirname(chatPath))
          ) {
            changed = true;
            await fs.appendFile(
              chatPath,
              JSON.stringify(
                createMuxMessage("successor", "user", "later", { historySequence: 2 })
              ) + "\n"
            );
          }
        });
      }
      return handle;
    });
    if (use === "lookup")
      expect(
        (await history.findCompactionReplacementWitness(workspaceId, expected.nonce!)).success
      ).toBe(false);
    else
      expect(
        await stop.retireReplacement({ nonce: expected.nonce! }).catch((error: unknown) => error)
      ).toBeInstanceOf(Error);
    expect(changed).toBe(true);
    expect(
      (
        await new CompactionCancellation(
          history.getCompactionCancellationStorage(workspaceId)
        ).read()
      )?.nonce
    ).toBe(expected.nonce!);
  });

  it.each(process.platform === "win32" ? ["file"] : ["file", "directory"])(
    "does not issue a lookup witness after lease reclamation during its %s flush",
    async (artifact) => {
      await stop.cancel({ retainUntilReplacement: true });
      const expected = await capture();
      await history.acceptCompactionReplacement(
        workspaceId,
        expected,
        await operation("single"),
        noObserver
      );
      const open = fs.open;
      let fileFlushed = false;
      let successor: Awaited<ReturnType<typeof acquireProcessFileLock>> | undefined;
      spyOn(fs, "open").mockImplementation(async (...args: Parameters<typeof open>) => {
        const handle = await open(...args);
        if (args[0] === chatPath || args[0] === path.dirname(chatPath)) {
          const sync = handle.sync.bind(handle);
          spyOn(handle, "sync").mockImplementation(async () => {
            await sync();
            if (args[0] === chatPath) fileFlushed = true;
            if (
              !successor &&
              fileFlushed &&
              args[0] === (artifact === "file" ? chatPath : path.dirname(chatPath))
            ) {
              const lockPath = historyWriteLockPath(fixture.config.rootDir, workspaceId);
              const token = await fs.readFile(lockPath, "utf8");
              await fs.writeFile(lockPath, token.split(":").slice(0, 2).join(":"));
              await fs.utimes(lockPath, new Date(0), new Date(0));
              successor = await acquireProcessFileLock({
                lockPath,
                timeoutMs: 1000,
                label: "witness successor",
              });
            }
          });
        }
        return handle;
      });
      try {
        expect(
          (await history.findCompactionReplacementWitness(workspaceId, expected.nonce!)).success
        ).toBe(false);
        assert(successor);
        await successor.assertStillOwned();
        expect(
          (
            await new CompactionCancellation(
              history.getCompactionCancellationStorage(workspaceId)
            ).read()
          )?.nonce
        ).toBe(expected.nonce!);
      } finally {
        await successor?.[Symbol.asyncDispose]();
      }
    }
  );

  it.each(["sync", "close", "certification"] as const)(
    "single acceptance survives post-publication %s failure",
    async (phase) => {
      await stop.cancel({ retainUntilReplacement: true });
      const expected = await capture();
      let committed = false;
      const open = fs.open;
      spyOn(fs, "open").mockImplementation(async (...args: Parameters<typeof open>) => {
        const handle = await open(...args);
        if (args[0] === chatPath && phase === "close" && args[1] === "a") {
          const close = handle.close.bind(handle);
          spyOn(handle, "close").mockImplementationOnce(async () => {
            await close();
            throw new Error("close failed");
          });
        }
        if (args[0] === chatPath && phase === "sync" && committed)
          spyOn(handle, "sync").mockRejectedValueOnce(new Error("sync failed"));
        return handle;
      });
      if (phase === "certification") {
        const stamps = HistoryAppendProvenance.prototype.stamps; // eslint-disable-line @typescript-eslint/unbound-method -- called with the original receiver
        spyOn(HistoryAppendProvenance.prototype, "stamps").mockImplementation(function (
          this: HistoryAppendProvenance
        ) {
          if (committed) return Promise.reject(new Error("certification failed"));
          return stamps.call(this);
        });
      }
      const result = await history.acceptCompactionReplacement(
        workspaceId,
        expected,
        await operation("single"),
        {
          isCurrent: () => !committed,
          onCommitted: () => {
            committed = true;
          },
        }
      );
      expect(committed).toBe(true);
      expect(result).toEqual(Ok({ kind: "accepted", witness: { nonce: expected.nonce! } }));
      mock.restore();
      expect(await history.findCompactionReplacementWitness(workspaceId, expected.nonce!)).toEqual(
        Ok({ nonce: expected.nonce! })
      );
    }
  );

  it("close failure cannot turn superseded append preparation into acceptance", async () => {
    const expected = await capture();
    const before = await fs.readFile(chatPath);
    let current = true;
    const committed = mock(() => undefined);
    const open = fs.open;
    spyOn(fs, "open").mockImplementation(async (...args: Parameters<typeof open>) => {
      const handle = await open(...args);
      if (args[0] === chatPath && args[1] === "a") {
        current = false;
        const close = handle.close.bind(handle);
        spyOn(handle, "close").mockImplementationOnce(async () => {
          await close();
          throw new Error("close failed");
        });
      }
      return handle;
    });
    expect(
      await history.acceptCompactionReplacement(workspaceId, expected, await operation("single"), {
        isCurrent: () => current,
        onCommitted: committed,
      })
    ).toEqual(Ok({ kind: "superseded" }));
    expect(committed).not.toHaveBeenCalled();
    expect(await fs.readFile(chatPath)).toEqual(before);
  });

  function beforeFileRead(filePath: string, action: (args: unknown[]) => void | Promise<void>) {
    const open = fs.open;
    spyOn(fs, "open").mockImplementation(async (...args: Parameters<typeof open>) => {
      const handle = await open(...args);
      if (args[0] === filePath) {
        const read = handle.read.bind(handle);
        spyOn(handle, "read").mockImplementation(
          new Proxy(read, {
            async apply(target, thisArg, args: unknown[]) {
              await action(args);
              return Reflect.apply(target, thisArg, args) as ReturnType<typeof read>;
            },
          })
        );
      }
      return handle;
    });
  }

  it.each(["none", "terminated", "unterminated", "repeated"] as const)(
    "accepts a stamped Resume after failed retirement and %s archive replay without rewriting its row",
    async (replay) => {
      const storage = history.getCompactionCancellationStorage(workspaceId);
      stop = new CompactionCancellation(storage);
      await stop.cancel({ retainUntilReplacement: true });
      const expected = await capture();
      const first = await history.acceptCompactionReplacement(
        workspaceId,
        expected,
        await operation("resume"),
        noObserver
      );
      assert(first.success && first.data.kind === "accepted" && first.data.witness);
      spyOn(storage, "mutate").mockRejectedValueOnce(new Error("retirement unavailable"));
      const retirement = await stop
        .retireReplacement(first.data.witness)
        .catch((error: unknown) => error);
      expect(retirement).toEqual(new Error("retirement unavailable"));
      mock.restore();
      const archivePath = path.join(path.dirname(chatPath), "chat-archive.jsonl");
      const stampedRow = (await fs.readFile(chatPath, "utf8")).trimEnd().split("\n").at(-1)!;
      if (replay !== "none")
        await fs.writeFile(
          archivePath,
          replay === "terminated"
            ? stampedRow + "\n"
            : replay === "repeated"
              ? stampedRow + "\n" + stampedRow
              : stampedRow
        );
      const archiveBefore = replay === "none" ? null : await fs.readFile(archivePath);

      history = new HistoryService(fixture.config);
      const freshStop = new CompactionCancellation(
        history.getCompactionCancellationStorage(workspaceId)
      );
      await freshStop.read();
      expect(await capture()).toEqual(expected);
      const before = await fs.readFile(chatPath);
      const committed = mock(() => undefined);
      const retried = await history.acceptCompactionReplacement(
        workspaceId,
        expected,
        await operation("resume"),
        { isCurrent: () => true, onCommitted: committed }
      );
      expect(retried).toEqual(first);
      expect(committed).toHaveBeenCalledTimes(1);
      expect(await fs.readFile(chatPath)).toEqual(before);
      assert(retried.success && retried.data.kind === "accepted" && retried.data.witness);
      expect(await freshStop.retireReplacement(retried.data.witness)).toBe("applied");
      expect(await freshStop.read()).toBeNull();
      if (archiveBefore) expect(await fs.readFile(archivePath)).toEqual(archiveBefore);
    }
  );

  it.each(["flush failure", "supersession"] as const)(
    "refuses a stamped Resume after witness %s",
    async (failure) => {
      await stop.cancel({ retainUntilReplacement: true });
      const expected = await capture();
      const first = await history.acceptCompactionReplacement(
        workspaceId,
        expected,
        await operation("resume"),
        noObserver
      );
      assert(first.success && first.data.kind === "accepted");
      const input = await operation("resume");
      const before = await fs.readFile(chatPath);
      let current = true;
      const open = fs.open;
      spyOn(fs, "open").mockImplementation(async (...args: Parameters<typeof open>) => {
        const handle = await open(...args);
        if (args[0] === chatPath && args[1] === "r+") {
          const sync = handle.sync.bind(handle);
          spyOn(handle, "sync").mockImplementation(async () => {
            if (failure === "flush failure") throw new Error("witness flush unavailable");
            await sync();
            current = false;
          });
        }
        return handle;
      });
      const committed = mock(() => undefined);
      const result = await history.acceptCompactionReplacement(workspaceId, expected, input, {
        isCurrent: () => current,
        onCommitted: committed,
      });
      if (failure === "flush failure") {
        expect(result.success).toBe(false);
        assert(!result.success);
        expect(result.error).toContain("witness flush unavailable");
      } else expect(result).toEqual(Ok({ kind: "superseded" }));
      expect(committed).not.toHaveBeenCalled();
      expect(await fs.readFile(chatPath)).toEqual(before);
    }
  );

  it.each([
    "changed",
    "duplicate",
    "archive",
    "archive nonce",
    "archive id",
    "archive sequence",
    "archive formatting",
    "foreign",
    "stale",
  ] as const)("refuses a stamped Resume with %s evidence", async (conflict) => {
    await stop.cancel({ retainUntilReplacement: true });
    const expected = await capture();
    const first = await history.acceptCompactionReplacement(
      workspaceId,
      expected,
      await operation("resume"),
      noObserver
    );
    assert(first.success && first.data.kind === "accepted");
    const input = await operation("resume");
    assert(input.kind === "resume");
    if (conflict === "changed") input.message.parts = [{ type: "text", text: "different" }];
    const persisted = (await fs.readFile(chatPath, "utf8")).trimEnd().split("\n").at(-1)!;
    if (conflict === "duplicate") await fs.appendFile(chatPath, persisted + "\n");
    if (conflict.startsWith("archive ")) {
      const archived = JSON.parse(persisted) as MuxMessage;
      if (conflict === "archive nonce") archived.metadata!.compactionReplacementNonce = "foreign";
      if (conflict === "archive id") archived.id = "foreign-id";
      if (conflict === "archive sequence") archived.metadata!.historySequence! += 1;
      await fs.writeFile(
        path.join(path.dirname(chatPath), "chat-archive.jsonl"),
        (conflict === "archive formatting" ? " " + persisted : JSON.stringify(archived)) + "\n"
      );
    }
    if (conflict === "archive")
      await fs.writeFile(
        path.join(path.dirname(chatPath), "chat-archive.jsonl"),
        JSON.stringify({ ...input.message, parts: [{ type: "text", text: "collision" }] }) + "\n"
      );
    if (conflict === "foreign") await stop.cancel({ retainUntilReplacement: true });
    const before = await fs.readFile(chatPath);
    const committed = mock(() => undefined);
    expect(
      await history.acceptCompactionReplacement(workspaceId, expected, input, {
        isCurrent: () => conflict !== "stale",
        onCommitted: committed,
      })
    ).toEqual(
      Ok({ kind: conflict === "foreign" || conflict === "stale" ? "superseded" : "skipped" })
    );
    expect(committed).not.toHaveBeenCalled();
    expect(await fs.readFile(chatPath)).toEqual(before);
  });

  it("refuses an unstamped Resume with an exact archive replay", async () => {
    await stop.cancel({ retainUntilReplacement: true });
    const expected = await capture();
    const input = await operation("resume");
    const before = await fs.readFile(chatPath);
    await fs.writeFile(path.join(path.dirname(chatPath), "chat-archive.jsonl"), before);
    const committed = mock(() => undefined);
    expect(
      await history.acceptCompactionReplacement(workspaceId, expected, input, {
        isCurrent: () => true,
        onCommitted: committed,
      })
    ).toEqual(Ok({ kind: "skipped" }));
    expect(committed).not.toHaveBeenCalled();
    expect(await fs.readFile(chatPath)).toEqual(before);
    expect(await capture()).toEqual(expected);
  });

  it("keeps an accepted receipt verifiable after repeated budget rejection and restart", async () => {
    await stop.cancel({ retainUntilReplacement: true });
    const expected = await capture();
    const input = await operation("single");
    const accepted = await history.acceptCompactionReplacement(
      workspaceId,
      expected,
      input,
      noObserver
    );
    assert(accepted.success && accepted.data.kind === "accepted" && accepted.data.witness);
    const unlink = nodeFs.rmSync;
    const cancellationPath = history.getCompactionCancellationStorage(workspaceId).path;
    spyOn(nodeFs, "rmSync").mockImplementation((file, options) => {
      if (file === cancellationPath) throw new Error("injected unlink failure");
      return unlink(file, options);
    });
    const retirement = await stop
      .retireReplacement(accepted.data.witness)
      .catch((error: unknown) => error);
    expect(retirement).toBeInstanceOf(Error);
    mock.restore();
    for (let attempt = 0; attempt < 2; attempt++) {
      const rejected = await history.rejectContextBudgetRequest(
        workspaceId,
        (await rows()).at(-1)!
      );
      assert(rejected.success);
      const fresh = new HistoryService(fixture.config);
      expect(await fresh.findCompactionReplacementWitness(workspaceId, expected.nonce!)).toEqual(
        Ok({ nonce: expected.nonce! })
      );
    }
    const freshStop = new CompactionCancellation(
      new HistoryService(fixture.config).getCompactionCancellationStorage(workspaceId)
    );
    await freshStop.read();
    expect(await freshStop.retireReplacement(accepted.data.witness)).toBe("applied");
  });

  it.each([false, true])(
    "exhausts short reads while distinguishing ambiguous same-nonce witnesses (%s)",
    async (sameNonce) => {
      await stop.cancel({ retainUntilReplacement: true });
      const expected = await capture();
      const message = createMuxMessage("ambiguous", "user", "bad occurrence", {
        historySequence: 10,
        compactionReplacementNonce: sameNonce ? expected.nonce! : "unrelated-nonce",
      });
      const valid = createMuxMessage("later", "user", "🙂 valid occurrence", {
        historySequence: 11,
        compactionReplacementNonce: expected.nonce!,
      });
      await fs.writeFile(
        chatPath,
        [message, message, valid].map((row) => JSON.stringify(row)).join("\n")
      );
      let reads = 0;
      beforeFileRead(chatPath, (args) => {
        if (typeof args[2] === "number") args[2] = Math.min(args[2], 17);
        reads++;
      });
      expect(await history.findCompactionReplacementWitness(workspaceId, expected.nonce!)).toEqual(
        Ok(sameNonce ? null : { nonce: expected.nonce! })
      );
      expect(reads).toBeGreaterThan(10);
      const collected: string[] = [];
      expect(
        (
          await history.iterateFullHistory(workspaceId, "forward", (rows) => {
            collected.push(...rows.map((row) => row.id));
          })
        ).success
      ).toBe(true);
      expect(collected).toEqual([message.id, message.id, valid.id]);
    }
  );

  it("reports a forward visitor failure at an unterminated tail instead of success", async () => {
    await fs.writeFile(chatPath, JSON.stringify(createMuxMessage("tail", "user", "input")));
    const result = await history.iterateFullHistory(workspaceId, "forward", () =>
      Promise.reject(new Error("visitor I/O failed"))
    );
    expect(result.success).toBe(false);
    if (!result.success) expect(result.error).toContain("visitor I/O failed");
  });

  it("refuses truncated streaming evidence instead of treating unread bytes as absence", async () => {
    await stop.cancel({ retainUntilReplacement: true });
    const expected = await capture();
    let truncated = false;
    beforeFileRead(chatPath, async () => {
      if (!truncated) {
        truncated = true;
        await fs.truncate(chatPath, 0);
      }
    });
    expect(
      (await history.findCompactionReplacementWitness(workspaceId, expected.nonce!)).success
    ).toBe(false);
  });

  it.each(["accept", "lookup", "retire"] as const)(
    "%s scans a multi-chunk archive without whole-file allocation",
    async (use) => {
      const archivePath = path.join(path.dirname(chatPath), "chat-archive.jsonl");
      await fs.writeFile(
        archivePath,
        Array.from(
          { length: 128 },
          (_, index) =>
            JSON.stringify(
              createMuxMessage(`old-${index}`, "assistant", "x".repeat(8192), {
                historySequence: index + 100,
              })
            ) + "\n"
        ).join("")
      );
      await stop.cancel({ retainUntilReplacement: true });
      const expected = await capture();
      if (use !== "accept")
        await history.acceptCompactionReplacement(
          workspaceId,
          expected,
          await operation("single"),
          noObserver
        );
      const read = fs.readFile;
      spyOn(fs, "readFile").mockImplementation(
        new Proxy(read, {
          apply(target, thisArg, args: Parameters<typeof read>) {
            if (args[0] === archivePath) throw new Error("whole-file archive allocation refused");
            return Reflect.apply(target, thisArg, args);
          },
        })
      );
      if (use === "accept")
        expect(
          (
            await history.acceptCompactionReplacement(
              workspaceId,
              expected,
              await operation("single"),
              noObserver
            )
          ).success
        ).toBe(true);
      else if (use === "lookup")
        expect(
          await history.findCompactionReplacementWitness(workspaceId, expected.nonce!)
        ).toEqual(Ok({ nonce: expected.nonce! }));
      else expect(await stop.retireReplacement({ nonce: expected.nonce! })).toBe("applied");
    }
  );

  it.each(["accept", "lookup", "retire"] as const)(
    "%s streams giant archive evidence without whole-row allocation",
    async (use) => {
      await stop.cancel({ retainUntilReplacement: true });
      const expected = await capture();
      const archivePath = path.join(path.dirname(chatPath), "chat-archive.jsonl");
      const archived = createMuxMessage(
        "giant-archive",
        "user",
        "x".repeat(3 * SESSION_HISTORY_MAX_LINE_BYTES),
        {
          historySequence: 10,
          ...(use === "accept" ? {} : { compactionReplacementNonce: expected.nonce! }),
        }
      );
      await fs.writeFile(archivePath, JSON.stringify(archived));
      const input = await operation("single");
      // Ordinary append's sequence allocation remains outside this witness-reader change.
      // Keep the acceptance guard active throughout preparation, before its real write lock.
      let lockDepth = 0;
      const withLock = workspaceFileLocks.withLock.bind(workspaceFileLocks);
      spyOn(workspaceFileLocks, "withLock").mockImplementation((key, body) =>
        withLock(key, async () => {
          lockDepth++;
          try {
            return await body();
          } finally {
            lockDepth--;
          }
        })
      );
      const mustStream = () => use !== "accept" || lockDepth === 0;
      const parse = JSON.parse;
      const concat = Buffer.concat.bind(Buffer);
      spyOn(JSON, "parse").mockImplementation((...args: Parameters<typeof parse>) => {
        if (mustStream() && Buffer.byteLength(args[0]) > SESSION_HISTORY_MAX_LINE_BYTES)
          throw new Error("whole-row parse refused");
        return parse(...args) as unknown;
      });
      spyOn(Buffer, "concat").mockImplementation((...args: Parameters<typeof concat>) => {
        if (
          mustStream() &&
          args[0].reduce((sum, chunk) => sum + chunk.byteLength, 0) > SESSION_HISTORY_MAX_LINE_BYTES
        )
          throw new Error("whole-row concatenation refused");
        return concat(...args);
      });
      if (use === "accept")
        expect(
          await history.acceptCompactionReplacement(workspaceId, expected, input, noObserver)
        ).toEqual(Ok({ kind: "accepted", witness: { nonce: expected.nonce! } }));
      else if (use === "lookup")
        expect(
          await history.findCompactionReplacementWitness(workspaceId, expected.nonce!)
        ).toEqual(Ok({ nonce: expected.nonce! }));
      else expect(await stop.retireReplacement({ nonce: expected.nonce! })).toBe("applied");
    }
  );

  it.each([
    "id",
    "sequence",
    "invalid-utf8",
    "protected",
    "invalid-parts",
    "malformed",
    "replay",
  ] as const)("retains giant identity collision accounting for %s rows", async (conflict) => {
    await stop.cancel({ retainUntilReplacement: true });
    const expected = await capture();
    const id = "identity-" + "x".repeat(SESSION_HISTORY_MAX_LINE_BYTES);
    const candidate = createMuxMessage(id, "user", "candidate", {
      historySequence: 10,
      compactionReplacementNonce: expected.nonce!,
    });
    await fs.writeFile(chatPath, JSON.stringify(candidate));
    const other = createMuxMessage(
      conflict === "sequence" ? "other" : id,
      "user",
      conflict === "sequence" ? "x".repeat(SESSION_HISTORY_MAX_LINE_BYTES) : "collision",
      {
        historySequence: conflict === "sequence" ? 10 : 11,
        ...(conflict === "protected" ? { contextBoundaryKind: "reset" as const } : {}),
      }
    );
    let raw = Buffer.from(JSON.stringify(other));
    if (conflict === "invalid-parts")
      raw = Buffer.from(raw.toString().replace('"type":"text"', '"type":"bad"'));
    if (conflict === "malformed") raw = raw.subarray(0, raw.length - 1);
    if (conflict === "invalid-utf8")
      raw = Buffer.concat([
        raw.subarray(0, -1),
        Buffer.from(',"extra":"'),
        Buffer.from([255]),
        Buffer.from('"}'),
      ]);
    if (conflict === "replay")
      raw = Buffer.from(JSON.stringify(candidate) + "\n" + JSON.stringify(candidate));
    await fs.writeFile(path.join(path.dirname(chatPath), "chat-archive.jsonl"), raw);
    expect(await history.findCompactionReplacementWitness(workspaceId, expected.nonce!)).toEqual(
      Ok(
        conflict === "invalid-parts" || conflict === "malformed" || conflict === "replay"
          ? { nonce: expected.nonce! }
          : null
      )
    );
  });

  it.each([
    "commit",
    "foreign-before",
    "foreign-after",
    "flush-failure",
    "observer-failure",
    "acceptance-observer-failure",
  ] as const)(
    "owned reset successor is authorized only by its history receipt (%s)",
    async (phase) => {
      const expected = await capture();
      const foreign = new CompactionCancellation(
        new HistoryService(fixture.config).getCompactionCancellationStorage(workspaceId)
      );
      if (phase === "foreign-before") await foreign.cancel({ retainUntilReplacement: true });
      if (phase === "flush-failure") {
        const sync = nodeFs.fsyncSync;
        spyOn(nodeFs, "fsyncSync").mockImplementation((fd) => {
          if (nodeFs.readFileSync(chatPath, "utf8").includes('"id":"trigger"'))
            throw new Error("history flush failed");
          sync(fd);
        });
      }
      let acceptedReceipt = false;
      let receiptPrecededReset = false;
      let predecessor: Awaited<ReturnType<typeof capture>> | undefined;
      let successor: Awaited<ReturnType<typeof capture>> | undefined;
      const result = await history.acceptCompactionReplacement(
        workspaceId,
        expected,
        {
          kind: "append",
          preserveCancellation: true,
          messages: [
            createMuxMessage("reset", "assistant", "", { contextBoundaryKind: "reset" }),
            createMuxMessage("trigger", "user", "New context"),
          ],
        },
        {
          isCurrent: () => true,
          onCommitted: () => {
            acceptedReceipt = true;
            if (phase === "acceptance-observer-failure")
              throw new Error("accepted observer failed");
          },
          onContextResetCommitted: (before, after) => {
            receiptPrecededReset = acceptedReceipt;
            predecessor = before;
            successor = after;
            if (phase === "observer-failure") throw new Error("observer failed");
          },
        }
      );
      if (phase === "foreign-before" || phase === "flush-failure") {
        expect(successor).toBeUndefined();
        expect(acceptedReceipt).toBe(false);
        if (phase === "flush-failure") {
          expect(result.success).toBe(false);
          expect(await fs.readFile(chatPath, "utf8")).toContain('"id":"trigger"');
        } else expect(result).toEqual(Ok({ kind: "superseded" }));
        return;
      }
      expect(result).toEqual(Ok({ kind: "accepted", witness: null }));
      expect(receiptPrecededReset).toBe(true);
      expect(predecessor).toEqual(expected);
      assert(successor);
      expect(successor.nonce).toBe(expected.nonce);
      expect(successor.generation).not.toBe(expected.generation);
      expect(await capture()).toEqual(successor);
      if (phase === "foreign-after") await foreign.cancel({ retainUntilReplacement: true });
      const next = await history.acceptCompactionReplacement(
        workspaceId,
        successor,
        {
          kind: "append",
          preserveCancellation: true,
          messages: [createMuxMessage("next", "user", "Queued input")],
        },
        noObserver
      );
      expect(next).toEqual(
        Ok(phase === "foreign-after" ? { kind: "superseded" } : { kind: "accepted", witness: null })
      );
      expect((await rows()).some((row) => row.id === "next")).toBe(phase !== "foreign-after");
    }
  );

  it.each(["staging", "lease check"] as const)(
    "a replacement reset losing logical ownership during generation %s leaves its frontier unchanged",
    async (phase) => {
      await stop.cancel({ retainUntilReplacement: true });
      const expected = await capture();
      const journal = history.getContinuousCompactionJournal(workspaceId);
      const generation = await journal.captureGeneration();
      const before = await fs.readFile(chatPath);
      let current = true;
      const atomic = atomicWrite.default;
      spyOn(atomicWrite, "default").mockImplementation(
        new Proxy(atomic, {
          async apply(target, _thisArg, args: Parameters<typeof atomic>) {
            const result = await target(...args);
            if (String(args[0]).includes(`${CONTINUOUS_COMPACTION_GENERATION_FILE}.continuous-`)) {
              if (phase === "staging") current = false;
              else {
                const read = fs.readFile;
                spyOn(fs, "readFile").mockImplementation(
                  new Proxy(read, {
                    async apply(target, thisArg, args: Parameters<typeof read>) {
                      const result = await Reflect.apply(target, thisArg, args);
                      if (args[0] === historyWriteLockPath(fixture.config.rootDir, workspaceId))
                        current = false;
                      return result;
                    },
                  })
                );
              }
            }
            return result;
          },
        })
      );
      const result = await history.acceptCompactionReplacement(
        workspaceId,
        expected,
        {
          kind: "append",
          messages: [
            createMuxMessage("reset", "assistant", "", { contextBoundaryKind: "reset" }),
            createMuxMessage("trigger", "user", "New context"),
          ],
        },
        { isCurrent: () => current, onCommitted: () => undefined }
      );
      expect(result).toEqual(Ok({ kind: "superseded" }));
      expect(await journal.captureGeneration()).toBe(generation);
      expect(await fs.readFile(chatPath)).toEqual(before);
    }
  );

  it("a reset refused after its generation fence preserves user history and permits fresh replacement", async () => {
    await stop.cancel({ retainUntilReplacement: true });
    const expected = await capture();
    const nonce = expected.nonce;
    assert(nonce);
    const journal = history.getContinuousCompactionJournal(workspaceId);
    const prepared: ContinuousCompactionJournal = {
      version: 1,
      publicationGeneration: expected.generation,
      boundary: createMuxMessage("summary", "assistant", "Prepared summary", {
        compactionBoundary: true,
        compactionEpoch: 1,
      }),
      staticCopies: [],
      liveTailCopySpec: {
        sourceMessageId: "live",
        sourceHistorySequence: 1,
        copyId: "copy",
        partIndex: 0,
        metadataTemplate: { synthetic: true, rlmPreservedTailCopy: true },
      },
      postCompactionAttachments: [],
      prefixSourceRows: await rows(),
      systemPrefix: [],
      cacheEnabled: false,
      preparation: {
        modelString: "anthropic:test",
        providerForMessages: "anthropic",
        effectiveThinkingLevel: "off",
        effectiveAgentId: "exec",
        toolNamesForSentinel: [],
      },
      providerFamily: "anthropic",
      parentModel: "anthropic:test",
      summaryModel: "anthropic:test",
      headFingerprint: "head",
      sourceFingerprint: "source",
      headEnd: { id: "prior", sequence: 0 },
      epoch: 0,
      streamMessageId: "live",
      streamHistorySequence: 1,
      stepNumber: 0,
      firstTailToolCallId: "tool",
    };
    assert(
      await journal.write(prepared, [{ role: "user", content: "Prepared prefix" }], () => true)
    );
    assert(await journal.read(), "The old journal must be usable before the reset fence");
    const archivePath = path.join(path.dirname(chatPath), "chat-archive.jsonl");
    await fs.writeFile(
      archivePath,
      JSON.stringify(createMuxMessage("archived", "user", "Older input", { historySequence: 7 })) +
        "\n"
    );
    const beforeChat = await fs.readFile(chatPath);
    const beforeArchive = await fs.readFile(archivePath);
    let current = true;
    let staged = false;
    afterStaging(() => {
      staged = true;
      current = false;
    });
    const committed = mock(() => undefined);
    const resetCommitted = mock(() => undefined);
    const replacement = () => ({
      kind: "append" as const,
      messages: [
        createMuxMessage("reset", "assistant", "", { contextBoundaryKind: "reset" }),
        createMuxMessage("trigger", "user", "New context"),
      ],
    });
    expect(
      await history.acceptCompactionReplacement(workspaceId, expected, replacement(), {
        isCurrent: () => current,
        onCommitted: committed,
        onContextResetCommitted: resetCommitted,
      })
    ).toEqual(Ok({ kind: "superseded" }));
    expect(resetCommitted).not.toHaveBeenCalled();
    expect(staged).toBe(true);
    expect(await journal.captureGeneration()).not.toBe(expected.generation);
    expect(await fs.readFile(chatPath)).toEqual(beforeChat);
    expect(await fs.readFile(archivePath)).toEqual(beforeArchive);
    expect(committed).not.toHaveBeenCalled();
    expect(await history.findCompactionReplacementWitness(workspaceId, nonce)).toEqual(Ok(null));
    expect((await history.getCompactionCancellationStorage(workspaceId).read())?.nonce).toBe(nonce);
    expect(stop.blocksRecovery).toBe(false);
    expect((await stop.read())?.retainUntilReplacement).toBe(true);
    expect(await journal.read()).toBeNull();
    expect(await journal.write(prepared, [], () => true)).toBeNull();
    mock.restore();
    const fresh = await capture();
    expect(fresh.generation).not.toBe(expected.generation);
    const accepted = await history.acceptCompactionReplacement(
      workspaceId,
      fresh,
      replacement(),
      noObserver
    );
    assert(accepted.success && accepted.data.kind === "accepted" && accepted.data.witness);
    expect(await stop.retireReplacement(accepted.data.witness)).toBe("applied");
    expect(await stop.read()).toBeNull();
    expect((await rows()).at(-1)?.id).toBe("trigger");
  });

  for (const kind of ["single", "batch", "resume"] as const) {
    it(`${kind} commits the receipt with the row before observers run`, async () => {
      await stop.cancel({ retainUntilReplacement: true });
      const expected = await capture();
      const input = await operation(kind);
      let commits = 0;
      const accepted = await history.acceptCompactionReplacement(workspaceId, expected, input, {
        isCurrent: () => true,
        onCommitted: (receipt) => {
          commits++;
          const committed = nodeFs
            .readFileSync(chatPath, "utf8")
            .trim()
            .split("\n")
            .map((line) => JSON.parse(line) as MuxMessage);
          expect(committed.at(-1)?.metadata?.compactionReplacementNonce).toBe(expected.nonce!);
          expect(receipt.witness?.nonce).toBe(expected.nonce!);
          // Notification cannot mutate the internal receipt or turn publication into failure.
          Object.assign(receipt.witness!, { nonce: "changed by observer" });
          throw new Error("observer failed");
        },
      });
      expect(accepted).toEqual(Ok({ kind: "accepted", witness: { nonce: expected.nonce! } }));
      expect(commits).toBe(1);
      expect(await history.getCompactionCancellationStorage(workspaceId).read()).not.toBeNull();
      const loaded = await rows();
      expect(loaded).toHaveLength(kind === "batch" ? 3 : kind === "single" ? 2 : 1);
      if (input.kind === "append")
        expect(input.messages.at(-1)?.metadata?.historySequence).toBe(
          loaded.at(-1)?.metadata?.historySequence
        );
      const foreign = new HistoryService(fixture.config);
      expect(await foreign.findCompactionReplacementWitness(workspaceId, expected.nonce!)).toEqual(
        Ok({ nonce: expected.nonce! })
      );
      expect(await stop.retireReplacement({ nonce: expected.nonce! })).toBe("applied");
    });

    it(`${kind} distinguishes local supersession from staging I/O failure`, async () => {
      await stop.cancel({ retainUntilReplacement: true });
      const expected = await capture();
      const before = await fs.readFile(chatPath);
      let current = true;
      let commits = 0;
      afterStaging(() => {
        current = false;
      });
      expect(
        await history.acceptCompactionReplacement(workspaceId, expected, await operation(kind), {
          isCurrent: () => current,
          onCommitted: () => {
            commits++;
          },
        })
      ).toEqual(Ok({ kind: "superseded" }));
      expect(await fs.readFile(chatPath)).toEqual(before);
      mock.restore();
      afterStaging(() => {
        throw new Error("disk failed");
      });
      const failed = await history.acceptCompactionReplacement(
        workspaceId,
        expected,
        await operation(kind),
        {
          isCurrent: () => true,
          onCommitted: () => {
            commits++;
          },
        }
      );
      assert(!failed.success);
      expect(failed.error).toContain("disk failed");
      expect(commits).toBe(0);
      expect(await fs.readFile(chatPath)).toEqual(before);
      expect(await history.findCompactionReplacementWitness(workspaceId, expected.nonce!)).toEqual(
        Ok(null)
      );
      expect(await stop.read()).toMatchObject({
        nonce: expected.nonce,
        retainUntilReplacement: true,
      });
    });
  }

  it("accepts proven absence, but rejects a Stop/retirement ABA and a foreign newer Stop", async () => {
    const absent = await capture();
    expect(
      await history.acceptCompactionReplacement(
        workspaceId,
        absent,
        await operation("single"),
        noObserver
      )
    ).toEqual(Ok({ kind: "accepted", witness: null }));
    await stop.cancel();
    const first = await capture();
    await stop.retire(first.nonce!);
    expect((await capture()).nonce).toBeNull();
    expect(
      await history.acceptCompactionReplacement(
        workspaceId,
        absent,
        await operation("single"),
        noObserver
      )
    ).toEqual(Ok({ kind: "superseded" }));
    await stop.cancel({ retainUntilReplacement: true });
    const stale = await capture();
    const foreign = new CompactionCancellation(
      new HistoryService(fixture.config).getCompactionCancellationStorage(workspaceId)
    );
    await foreign.cancel();
    expect(
      await history.acceptCompactionReplacement(
        workspaceId,
        stale,
        await operation("single"),
        noObserver
      )
    ).toEqual(Ok({ kind: "superseded" }));
    expect(await rows()).toHaveLength(2);
  });

  it("does not reinterpret cancellation or generation read failures as absence", async () => {
    const expected = await capture();
    const sidecar = history.getCompactionCancellationStorage(workspaceId).path;
    await fs.mkdir(sidecar);
    expect((await captureFailure()).success).toBe(false);
    expect(
      (
        await history.acceptCompactionReplacement(
          workspaceId,
          expected,
          await operation("single"),
          noObserver
        )
      ).success
    ).toBe(false);
    await fs.rmdir(sidecar);
    await fs.mkdir(path.join(path.dirname(chatPath), CONTINUOUS_COMPACTION_GENERATION_FILE));
    expect((await captureFailure()).success).toBe(false);
    expect(
      (
        await history.acceptCompactionReplacement(
          workspaceId,
          expected,
          await operation("single"),
          noObserver
        )
      ).success
    ).toBe(false);
    expect(await rows()).toHaveLength(1);
    function captureFailure() {
      return history.captureCompactionReplacement(workspaceId);
    }
  });

  it("skips empty acceptance and missing, changed, or ambiguous resume rows without retiring retained Stop", async () => {
    await stop.cancel({ retainUntilReplacement: true });
    const expected = await capture();
    const target = (await rows())[0];
    for (const input of [
      { kind: "append", messages: [] },
      { kind: "resume", message: { ...target, id: "missing" } },
      { kind: "resume", message: { ...target, parts: [{ type: "text", text: "changed" }] } },
      {
        kind: "resume",
        message: { ...target, metadata: { ...target.metadata, historySequence: undefined } },
      },
    ] satisfies CompactionReplacementOperation[]) {
      expect(
        await history.acceptCompactionReplacement(workspaceId, expected, input, noObserver)
      ).toEqual(Ok({ kind: "skipped" }));
    }
    const original = await fs.readFile(chatPath);
    for (const extra of [
      target,
      { ...target, id: "same-sequence" },
      { ...target, metadata: { ...target.metadata, historySequence: 10 } },
    ]) {
      await fs.writeFile(
        chatPath,
        Buffer.concat([original, Buffer.from(JSON.stringify(extra) + "\n")])
      );
      const before = await fs.readFile(chatPath);
      expect(
        await history.acceptCompactionReplacement(
          workspaceId,
          expected,
          { kind: "resume", message: target },
          noObserver
        )
      ).toEqual(Ok({ kind: "skipped" }));
      expect(await fs.readFile(chatPath)).toEqual(before);
    }
    await history.clearHistory(workspaceId);
    expect(await history.findCompactionReplacementWitness(workspaceId, expected.nonce!)).toEqual(
      Ok(null)
    );
    expect(await stop.retire(expected.nonce!)).toBeUndefined();
    expect(await stop.read()).toMatchObject({
      nonce: expected.nonce,
      retainUntilReplacement: true,
    });
  });

  it("keeps accepted outcomes across real lock completion errors and cancellation unlink failure", async () => {
    await stop.cancel({ retainUntilReplacement: true });
    const expected = await capture();
    const input = await operation("single");
    const withLock = workspaceFileLocks.withLock.bind(workspaceFileLocks);
    spyOn(workspaceFileLocks, "withLock").mockImplementationOnce(async (key, operation) => {
      await withLock(key, operation);
      throw new Error("outer lock completion failed");
    });
    expect(
      await history.acceptCompactionReplacement(workspaceId, expected, input, noObserver)
    ).toEqual(Ok({ kind: "accepted", witness: { nonce: expected.nonce! } }));
    spyOn(nodeFs, "rmSync").mockImplementationOnce(() => {
      throw new Error("unlink failed");
    });
    expect(stop.retireReplacement({ nonce: expected.nonce! })).rejects.toThrow("unlink failed");
    expect(await history.findCompactionReplacementWitness(workspaceId, expected.nonce!)).toEqual(
      Ok({ nonce: expected.nonce! })
    );
    await stop.cancel();
    const newer = await capture();
    expect(newer.nonce).not.toBe(expected.nonce);
    expect(
      await history.getCompactionCancellationStorage(workspaceId).mutate(
        { kind: "retire", nonce: expected.nonce!, replacementWitness: { nonce: expected.nonce! } },
        () => true,
        () => undefined
      )
    ).toBe("superseded");
    expect((await capture()).nonce).toBe(newer.nonce);
  });

  it("verifies archived receipts after same-row finalization and rejects ambiguous or forged witnesses", async () => {
    await stop.cancel({ retainUntilReplacement: true });
    const expected = await capture();
    const input = await operation("resume");
    await history.acceptCompactionReplacement(workspaceId, expected, input, noObserver);
    assert(input.kind === "resume");
    await history.updateHistory(workspaceId, {
      ...input.message,
      parts: [{ type: "text", text: "finalized" }],
    });
    await history.appendToHistory(
      workspaceId,
      createMuxMessage("boundary", "assistant", "summary", {
        compacted: "user",
        compactionBoundary: true,
        compactionEpoch: 1,
      })
    );
    expect(
      await fs.readFile(path.join(path.dirname(chatPath), "chat-archive.jsonl"), "utf8")
    ).toContain(expected.nonce!);
    const foreign = new HistoryService(fixture.config);
    expect(await foreign.findCompactionReplacementWitness(workspaceId, expected.nonce!)).toEqual(
      Ok({ nonce: expected.nonce! })
    );
    const storage = foreign.getCompactionCancellationStorage(workspaceId);
    expect(
      storage.mutate(
        { kind: "retire", nonce: expected.nonce!, replacementWitness: { nonce: "forged" } },
        () => true,
        () => undefined
      )
    ).rejects.toThrow("not verified");
    await fs.appendFile(chatPath, JSON.stringify({ ...input.message, id: "collision" }) + "\n");
    expect(await foreign.findCompactionReplacementWitness(workspaceId, expected.nonce!)).toEqual(
      Ok(null)
    );
    expect(await storage.read()).toMatchObject({ nonce: expected.nonce! });
  });

  it("waits on the real cross-instance lock and rejects a reclaimed lease before publication", async () => {
    const expected = await capture();
    const lockPath = historyWriteLockPath(fixture.config.rootDir, workspaceId);
    const held = await acquireProcessFileLock({
      lockPath,
      timeoutMs: 1000,
      label: "foreign writer",
    });
    const writing = history.acceptCompactionReplacement(
      workspaceId,
      expected,
      await operation("single"),
      noObserver
    );
    await fs.writeFile(
      history.getCompactionCancellationStorage(workspaceId).path,
      JSON.stringify({ version: 1, nonce: "foreign", scope: { kind: "unresolved" } })
    );
    await held[Symbol.asyncDispose]();
    expect(await writing).toEqual(Ok({ kind: "superseded" }));
    const current = await capture();
    afterStaging(async () => {
      await fs.writeFile(lockPath, "foreign-owner");
    });
    const before = await fs.readFile(chatPath);
    let commits = 0;
    const rejected = await history.acceptCompactionReplacement(
      workspaceId,
      current,
      await operation("single"),
      {
        isCurrent: () => true,
        onCommitted: () => {
          commits++;
        },
      }
    );
    expect(rejected.success).toBe(false);
    expect(commits).toBe(0);
    expect(await fs.readFile(chatPath)).toEqual(before);
    await fs.rm(lockPath);
  });

  it.each([
    ["active", "trigger"],
    ["archive", "trigger"],
    ["active", "payload"],
    ["archive", "payload"],
  ] as const)(
    "refuses a receipt for an append identity already in %s (%s)",
    async (location, collision) => {
      if (location === "archive")
        await history.appendToHistory(
          workspaceId,
          createMuxMessage("boundary", "assistant", "summary", {
            compacted: "user",
            compactionBoundary: true,
            compactionEpoch: 1,
          })
        );
      await stop.cancel({ retainUntilReplacement: true });
      const expected = await capture();
      const result = await history.acceptCompactionReplacement(
        workspaceId,
        expected,
        {
          kind: "append",
          messages:
            collision === "trigger"
              ? [createMuxMessage("prior", "user", "another occurrence")]
              : [
                  createMuxMessage("prior", "assistant", "conflicting payload"),
                  createMuxMessage("new-trigger", "user", "new input"),
                ],
        },
        noObserver
      );
      expect(result).toEqual(Ok({ kind: "skipped" }));
      expect(await history.findCompactionReplacementWitness(workspaceId, expected.nonce!)).toEqual(
        Ok(null)
      );
    }
  );

  it("recognizes archive replays while rejecting conflicting rows or duplicate active rows", async () => {
    await stop.cancel({ retainUntilReplacement: true });
    const expected = await capture();
    await history.acceptCompactionReplacement(
      workspaceId,
      expected,
      await operation("single"),
      noObserver
    );
    const active = await fs.readFile(chatPath, "utf8");
    const committed = active.trimEnd().split("\n").at(-1)! + "\n";
    const archivePath = path.join(path.dirname(chatPath), "chat-archive.jsonl");
    await fs.writeFile(archivePath, committed);
    const foreign = new HistoryService(fixture.config);
    expect(await foreign.findCompactionReplacementWitness(workspaceId, expected.nonce!)).toEqual(
      Ok({ nonce: expected.nonce! })
    );
    const conflicting = JSON.parse(committed) as MuxMessage;
    conflicting.parts = [{ type: "text", text: "different occurrence bytes" }];
    await fs.writeFile(archivePath, JSON.stringify(conflicting) + "\n");
    expect(await foreign.findCompactionReplacementWitness(workspaceId, expected.nonce!)).toEqual(
      Ok(null)
    );
    await fs.writeFile(archivePath, committed + committed + committed);
    expect(await foreign.findCompactionReplacementWitness(workspaceId, expected.nonce!)).toEqual(
      Ok({ nonce: expected.nonce! })
    );
    await fs.writeFile(archivePath, "");
    await fs.appendFile(chatPath, committed);
    expect(await foreign.findCompactionReplacementWitness(workspaceId, expected.nonce!)).toEqual(
      Ok(null)
    );
    await fs.writeFile(chatPath, active);
    await fs.writeFile(archivePath, committed);
    expect(await stop.retireReplacement({ nonce: expected.nonce! })).toBe("applied");
  });

  it("keeps lifetime archive reads outside the history lock for lookup and witnessed retirement", async () => {
    await stop.cancel({ retainUntilReplacement: true });
    const expected = await capture();
    await history.acceptCompactionReplacement(
      workspaceId,
      expected,
      await operation("single"),
      noObserver
    );
    const archivePath = path.join(path.dirname(chatPath), "chat-archive.jsonl");
    const archived =
      Array.from({ length: 2000 }, (_, i) =>
        JSON.stringify(
          createMuxMessage(`archived-${i}`, "assistant", "x".repeat(1024), {
            historySequence: i + 2,
          })
        )
      ).join("\n") + "\n";
    await fs.writeFile(archivePath, archived);
    let holdingLock = false;
    let archiveBytesReadUnderLock = 0;
    const withLock = workspaceFileLocks.withLock.bind(workspaceFileLocks);
    spyOn(workspaceFileLocks, "withLock").mockImplementation((key, operation) =>
      withLock(key, async () => {
        holdingLock = true;
        try {
          return await operation();
        } finally {
          holdingLock = false;
        }
      })
    );
    beforeFileRead(archivePath, (args) => {
      if (holdingLock && typeof args[2] === "number") archiveBytesReadUnderLock += args[2];
    });
    expect(await history.findCompactionReplacementWitness(workspaceId, expected.nonce!)).toEqual(
      Ok({ nonce: expected.nonce! })
    );
    expect(await stop.retireReplacement({ nonce: expected.nonce! })).toBe("applied");
    expect(archiveBytesReadUnderLock).toBe(0);
  });

  it.each(["Stop", "append"] as const)(
    "lets a foreign %s finish during witnessed retirement's archive scan",
    async (change) => {
      await stop.cancel({ retainUntilReplacement: true });
      const expected = await capture();
      await history.acceptCompactionReplacement(
        workspaceId,
        expected,
        await operation("single"),
        noObserver
      );
      const archivePath = path.join(path.dirname(chatPath), "chat-archive.jsonl");
      await fs.writeFile(
        archivePath,
        JSON.stringify(
          createMuxMessage("archive", "assistant", "old", {
            historySequence: 99,
          })
        ) + "\n"
      );
      const entered = Promise.withResolvers<void>();
      const release = Promise.withResolvers<void>();
      let armed = true;
      beforeFileRead(archivePath, async () => {
        if (armed) {
          armed = false;
          entered.resolve();
          await release.promise;
        }
      });
      const retiring = stop.retireReplacement({ nonce: expected.nonce! }).then(
        (result) => result,
        (error: unknown) => error
      );
      await entered.promise;
      const foreign = new HistoryService(fixture.config);
      const foreignStop = new CompactionCancellation(
        foreign.getCompactionCancellationStorage(workspaceId)
      );
      try {
        expect(nodeFs.existsSync(historyWriteLockPath(fixture.config.rootDir, workspaceId))).toBe(
          false
        );
        if (change === "Stop") await foreignStop.cancel({ retainUntilReplacement: true });
        else
          await foreign.appendToHistory(
            workspaceId,
            createMuxMessage("foreign", "assistant", "concurrent input")
          );
      } finally {
        release.resolve();
        await retiring;
      }
      if (change === "Stop") {
        expect(await retiring).toBe("superseded");
        expect((await foreignStop.read())?.nonce).not.toBe(expected.nonce);
        expect((await history.getCompactionCancellationStorage(workspaceId).read())?.nonce).toBe(
          (await foreignStop.read())?.nonce
        );
      } else {
        expect(await retiring).toBeInstanceOf(Error);
        expect(stop.needsPersistence).toBe(true);
        expect(stop.blocksRecovery).toBe(false);
        expect((await foreignStop.read())?.nonce).toBe(expected.nonce!);
        expect(await stop.retry()).toBe("applied");
        expect(await foreignStop.read()).toBeNull();
      }
    }
  );

  it.each([
    ["append", "lookup"],
    ["rotate", "lookup"],
    ["reset", "lookup"],
    ["append", "accept"],
  ] as const)(
    "%s between %s evidence preparation and locking invalidates evidence without claiming absence",
    async (mutation, use) => {
      await stop.cancel({ retainUntilReplacement: true });
      const expected = await capture();
      await history.acceptCompactionReplacement(
        workspaceId,
        expected,
        await operation("single"),
        noObserver
      );
      const foreign = new HistoryService(fixture.config);
      const withLock = workspaceFileLocks.withLock.bind(workspaceFileLocks);
      let armed = true;
      spyOn(workspaceFileLocks, "withLock").mockImplementation(async (key, operation) => {
        if (armed) {
          armed = false;
          if (mutation === "reset") await foreign.clearHistory(workspaceId);
          else
            await foreign.appendToHistory(
              workspaceId,
              createMuxMessage(
                "foreign",
                "assistant",
                "changed",
                mutation === "rotate"
                  ? {
                      compacted: "user",
                      compactionBoundary: true,
                      compactionEpoch: 1,
                    }
                  : undefined
              )
            );
        }
        return withLock(key, operation);
      });
      const finding =
        use === "lookup"
          ? await history.findCompactionReplacementWitness(workspaceId, expected.nonce!)
          : await history.acceptCompactionReplacement(
              workspaceId,
              expected,
              {
                kind: "append",
                messages: [createMuxMessage("next-trigger", "user", "next input")],
              },
              noObserver
            );
      expect(finding.success).toBe(false);
      expect((await rows()).some((row) => row.id === "next-trigger")).toBe(false);
      expect((await history.getCompactionCancellationStorage(workspaceId).read())?.nonce).toBe(
        expected.nonce!
      );
      const refreshed = await history.findCompactionReplacementWitness(
        workspaceId,
        expected.nonce!
      );
      expect(refreshed).toEqual(Ok(mutation === "reset" ? null : { nonce: expected.nonce! }));
    }
  );

  it.each([0, 1])("acceptance and lookup agree at the row limit plus %d byte(s)", async (extra) => {
    await stop.cancel({ retainUntilReplacement: true });
    const expected = await capture();
    const message = createMuxMessage("limit", "user", "x");
    message.parts = [{ type: "text", text: "" }];
    const representation = {
      ...message,
      workspaceId,
      metadata: {
        ...message.metadata,
        compactionReplacementNonce: expected.nonce!,
        historySequence: 1,
      },
    };
    message.parts = [
      {
        type: "text",
        text: "x".repeat(
          SESSION_HISTORY_MAX_LINE_BYTES + extra - Buffer.byteLength(JSON.stringify(representation))
        ),
      },
    ];
    let commits = 0;
    const result = await history.acceptCompactionReplacement(
      workspaceId,
      expected,
      { kind: "append", messages: [message] },
      {
        isCurrent: () => true,
        onCommitted: () => {
          commits++;
        },
      }
    );
    expect(result).toEqual(Ok({ kind: "accepted", witness: { nonce: expected.nonce! } }));
    expect(commits).toBe(1);
    const committedLine = (await fs.readFile(chatPath, "utf8")).trimEnd().split("\n").at(-1)!;
    expect(Buffer.byteLength(committedLine)).toBe(SESSION_HISTORY_MAX_LINE_BYTES + extra);
    const fresh = new HistoryService(fixture.config);
    expect(await fresh.findCompactionReplacementWitness(workspaceId, expected.nonce!)).toEqual(
      Ok({ nonce: expected.nonce! })
    );
    expect(
      await fresh.getCompactionCancellationStorage(workspaceId).mutate(
        {
          kind: "retire",
          nonce: expected.nonce!,
          replacementWitness: { nonce: expected.nonce! },
        },
        () => true,
        () => undefined
      )
    ).toBe("applied");
    if (extra > 0) {
      // The witness check does not gratuitously restrict ordinary large history inputs.
      const absentWorkspace = "large-without-stop";
      const absent = await history.captureCompactionReplacement(absentWorkspace);
      assert(absent.success);
      expect(
        await history.acceptCompactionReplacement(
          absentWorkspace,
          absent.data,
          {
            kind: "append",
            messages: [
              { ...message, metadata: { ...message.metadata, historySequence: undefined } },
            ],
          },
          noObserver
        )
      ).toEqual(Ok({ kind: "accepted", witness: null }));
    }
  });

  it.each(["update", "boundary"] as const)(
    "preserves a resumed assistant receipt through stale %s finalization",
    async (writer) => {
      await history.appendToHistory(
        workspaceId,
        createMuxMessage("assistant", "assistant", "interrupted")
      );
      const original = (await rows()).at(-1)!;
      await stop.cancel({ retainUntilReplacement: true });
      const old = await capture();
      await history.acceptCompactionReplacement(
        workspaceId,
        old,
        { kind: "resume", message: original },
        noObserver
      );
      const stale = (await rows()).at(-1)!;
      await stop.cancel({ retainUntilReplacement: true });
      const expected = await capture();
      await history.acceptCompactionReplacement(
        workspaceId,
        expected,
        { kind: "resume", message: stale },
        noObserver
      );
      if (writer === "update")
        expect(await history.updateHistory(workspaceId, stale)).toEqual(Ok(undefined));
      else
        expect(
          await history.persistBoundaryWithTailCopies(
            workspaceId,
            {
              ...stale,
              metadata: {
                ...stale.metadata,
                compacted: "user",
                compactionBoundary: true,
                compactionEpoch: 1,
              },
            },
            [],
            true
          )
        ).toEqual(Ok(undefined));
      expect(await history.findCompactionReplacementWitness(workspaceId, expected.nonce!)).toEqual(
        Ok({ nonce: expected.nonce! })
      );
      expect(await stop.retireReplacement({ nonce: expected.nonce! })).toBe("applied");
    }
  );

  it("preserves raw protected history and refuses to issue a receipt from a protected trigger", async () => {
    const protectedRow = createMuxMessage(
      "raw-floor",
      "user",
      "x".repeat(SESSION_HISTORY_MAX_LINE_BYTES),
      {
        contextBoundaryKind: "reset",
      }
    );
    await history.appendToHistory(workspaceId, protectedRow);
    const original = await fs.readFile(chatPath);
    await stop.cancel({ retainUntilReplacement: true });
    const expected = await capture();
    let commits = 0;
    const failed = await history.acceptCompactionReplacement(
      workspaceId,
      expected,
      {
        kind: "append",
        messages: [
          { ...protectedRow, id: "new-floor", metadata: { contextBoundaryKind: "reset" } },
        ],
      },
      {
        isCurrent: () => true,
        onCommitted: () => {
          commits++;
        },
      }
    );
    expect(failed.success).toBe(false);
    expect(commits).toBe(0);
    expect(await fs.readFile(chatPath)).toEqual(original);
    expect(await history.findCompactionReplacementWitness(workspaceId, expected.nonce!)).toEqual(
      Ok(null)
    );
    const next = await capture();
    expect(
      await history.acceptCompactionReplacement(
        workspaceId,
        next,
        await operation("single"),
        noObserver
      )
    ).toEqual(Ok({ kind: "accepted", witness: { nonce: next.nonce! } }));
    expect((await fs.readFile(chatPath)).subarray(0, original.length)).toEqual(original);
  });
});

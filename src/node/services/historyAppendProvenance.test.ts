import assert from "node:assert";
import nodeFs from "node:fs";
import { afterEach, beforeEach, describe, expect, test, spyOn } from "bun:test";
import * as fs from "node:fs/promises";
import * as path from "node:path";
import { spawnSync } from "node:child_process";
import { createMuxMessage, type MuxMessage } from "@/common/types/message";
import { createTestHistoryService } from "./testHistoryService";
import { HistoryService } from "./historyService";
import {
  HistoryAppendProvenance,
  HISTORY_PROVENANCE_MAX_RECEIPT_BYTES,
  type HistoryAppendReceipt,
} from "./historyAppendProvenance";
import type { HistoryScanState } from "./historyCursor";
import {
  SESSION_HISTORY_MAX_SCAN_BYTES,
  SESSION_HISTORY_MAX_SCAN_ROWS,
} from "@/common/constants/contextBudget";
import { acquireProcessFileLock } from "@/node/utils/concurrency/fileLock";
import { historyWriteLockPath, removeSessionDirUnderMemoryLocks } from "./workspaceRemoval";

let fixture: Awaited<ReturnType<typeof createTestHistoryService>>;
let store: HistoryAppendProvenance;
const ws = "provenance-test";
const privateMethods = HistoryAppendProvenance.prototype as unknown as {
  publish(receipt: HistoryAppendReceipt): Promise<void>;
};
async function startCursor(): Promise<HistoryScanState> {
  let seen = 0;
  const scan = await fixture.historyService.scanHistoryBounded(ws, { visit: () => ++seen < 2 });
  expect(scan.cursor).toBeDefined();
  return scan.cursor!;
}
async function resume(
  cursor: HistoryScanState,
  service = fixture.historyService
): Promise<MuxMessage[]> {
  const rows: MuxMessage[] = [];
  let next: HistoryScanState | undefined = cursor;
  let pages = 0;
  while (next) {
    const result = await service.scanHistoryBounded(ws, {
      cursor: next,
      visit: ({ message }) => {
        rows.push(message);
        return true;
      },
    });
    expect(result.bytesRead).toBeLessThanOrEqual(SESSION_HISTORY_MAX_SCAN_BYTES);
    expect(result.rowsScanned).toBeLessThanOrEqual(SESSION_HISTORY_MAX_SCAN_ROWS);
    next = result.cursor;
    expect(++pages).toBeLessThan(15);
  }
  return rows;
}
async function assertStale(cursor: HistoryScanState) {
  const error = await resume(cursor).then(
    () => null,
    (error: unknown) => error
  );
  expect(error).toMatchObject({ message: "stale_cursor" });
}
function child(source: string) {
  const imports = `import {Config} from ${JSON.stringify(path.resolve("src/node/config/index.ts"))};
import {HistoryService} from ${JSON.stringify(path.resolve("src/node/services/historyService.ts"))};
import {HistoryAppendProvenance} from ${JSON.stringify(path.resolve("src/node/services/historyAppendProvenance.ts"))};
import {createMuxMessage} from ${JSON.stringify(path.resolve("src/common/types/message.ts"))};
const config = new Config(${JSON.stringify(fixture.tempDir)}); const service = new HistoryService(config);
const ws = ${JSON.stringify(ws)};`;
  const result = spawnSync(process.execPath, ["--eval", imports + source], {
    cwd: process.cwd(),
    encoding: "utf8",
    timeout: 20_000,
  });
  if (result.status !== 0) throw new Error(result.stderr || String(result.error));
}

beforeEach(async () => {
  fixture = await createTestHistoryService();
  store = new HistoryAppendProvenance(path.join(fixture.config.sessionsDir, ws));
  for (let i = 0; i < 3; i++)
    expect(
      (
        await fixture.historyService.appendToHistory(
          ws,
          createMuxMessage(`row-${i}`, "assistant", `facts ${i}`)
        )
      ).success
    ).toBe(true);
});
afterEach(async () => {
  await fixture.cleanup();
});

describe("history append provenance", () => {
  test("bootstraps privately without an existing receipt and uses exact bigint stamps", async () => {
    await fs.rm(store.receiptPath);
    const cursor = await startCursor();
    const loaded = await store.read();
    expect(loaded.receipt?.state).toBe("stable");
    expect(loaded.receipt?.epoch).toBe(cursor.provenanceEpoch);
    const stat = await fs.stat(store.chatPath, { bigint: true });
    expect(loaded.receipt?.files.chat).toEqual({
      dev: String(stat.dev),
      ino: String(stat.ino),
      size: String(stat.size),
      mtimeNs: String(stat.mtimeNs),
      ctimeNs: String(stat.ctimeNs),
    });
    if (process.platform !== "win32")
      expect((await fs.stat(store.receiptPath)).mode & 0o777).toBe(0o600);
  });

  test("an empty session can bootstrap a bounded receipt", async () => {
    const result = await fixture.historyService.scanHistoryBounded("empty-session", {
      visit: () => true,
    });
    expect(result.cursor).toBeUndefined();
    const empty = new HistoryAppendProvenance(
      path.join(fixture.config.sessionsDir, "empty-session")
    );
    expect((await empty.read()).receipt?.files).toEqual({ chat: null, archive: null });
  });

  test.skipIf(process.platform === "win32")(
    "a FIFO receipt cannot block history reads or writes",
    async () => {
      const cursor = await startCursor();
      await fs.rm(store.receiptPath);
      const fifo = spawnSync("mkfifo", [store.receiptPath], { encoding: "utf8" });
      expect(fifo.status).toBe(0);
      // Bound a regression's blocking open in a child so it cannot wedge the test runner.
      child(`
const provenance = new HistoryAppendProvenance(${JSON.stringify(store.sessionDir)});
if ((await provenance.read()).receipt !== null) throw new Error("FIFO was trusted");
const result = await service.appendToHistory(ws, createMuxMessage("after-fifo", "assistant", "still writable"));
if (!result.success) throw new Error(result.error);
`);
      expect((await fs.lstat(store.receiptPath)).isFile()).toBe(true);
      expect((await store.read()).receipt?.state).toBe("stable");
      await assertStale(cursor);
    },
    30_000
  );

  test("receipt symlinks are not trusted or followed when reconciling", async () => {
    if (process.platform === "win32") return;
    const cursor = await startCursor();
    const outside = path.join(fixture.tempDir, "unrelated-file");
    await fs.writeFile(outside, "do not modify");
    await fs.rm(store.receiptPath);
    await fs.symlink(outside, store.receiptPath);
    await assertStale(cursor);
    await startCursor();
    expect(await fs.readFile(outside, "utf8")).toBe("do not modify");
    expect((await fs.lstat(store.receiptPath)).isSymbolicLink()).toBe(false);
  });

  test("truncation recovery invalidates even when it restores the same archived bytes", async () => {
    await fixture.historyService.appendToHistory(
      ws,
      createMuxMessage("summary", "assistant", "summary", {
        compacted: true,
        compactionBoundary: true,
        compactionEpoch: 1,
      })
    );
    await fixture.historyService.appendToHistory(
      ws,
      createMuxMessage("after-summary", "assistant", "later")
    );
    const cursor = await startCursor();
    await fs.rename(store.archivePath, `${store.archivePath}.truncate`);
    await assertStale(cursor);
    expect((await fixture.historyService.getHistoryFromLatestBoundary(ws)).success).toBe(true);
    expect((await store.read()).receipt?.epoch).not.toBe(cursor.provenanceEpoch);
    await assertStale(cursor);
  });

  test("removal deletes tracking and forbids cold-scan resurrection", async () => {
    const cursor = await startCursor();
    await removeSessionDirUnderMemoryLocks({
      rootDir: fixture.config.rootDir,
      sessionDir: store.sessionDir,
      workspaceId: ws,
      attemptId: "receipt-removal",
    });
    await assertStale(cursor);
    expect(
      await fixture.historyService.scanHistoryBounded(ws, { visit: () => true }).then(
        () => null,
        (error: unknown) => error
      )
    ).toMatchObject({ message: "stale_cursor" });
    expect(
      await fs.stat(store.sessionDir).then(
        () => true,
        () => false
      )
    ).toBe(false);
  });

  test("service, second-process and atomic batch appends preserve epoch and fixed snapshot", async () => {
    const cursor = await startCursor();
    await fixture.historyService.appendToHistory(
      ws,
      createMuxMessage("single", "assistant", "later")
    );
    child(
      'const r = await service.appendToHistory(ws, createMuxMessage("foreign", "assistant", "foreign later")); if (!r.success) throw new Error(r.error);'
    );
    const inode = (await fs.stat(store.chatPath)).ino;
    await fixture.historyService.appendManyToHistory(ws, [
      createMuxMessage("batch-a", "assistant", "a"),
      createMuxMessage("batch-b", "user", "b"),
    ]);
    expect((await fs.stat(store.chatPath)).ino).not.toBe(inode);
    expect((await store.read()).receipt?.epoch).toBe(cursor.provenanceEpoch);
    expect((await resume(cursor, new HistoryService(fixture.config))).map((row) => row.id)).toEqual(
      ["row-1", "row-2"]
    );
  });

  test("tool-result commitPartial certifies append but invalidates an update", async () => {
    const cursor = await startCursor();
    const partial = createMuxMessage("tool-result", "assistant", "", { historySequence: 3 }, [
      {
        type: "dynamic-tool",
        toolCallId: "history-call",
        toolName: "session_history",
        state: "output-available",
        input: {},
        output: { success: true },
      },
    ]);
    expect((await fixture.historyService.writePartial(ws, partial)).success).toBe(true);
    expect((await fixture.historyService.commitPartial(ws)).success).toBe(true);
    expect((await resume(cursor)).map((row) => row.id)).toEqual(["row-1", "row-2"]);
    const after = await startCursor();
    partial.parts.push({ type: "text", text: "update committed output" });
    expect((await fixture.historyService.writePartial(ws, partial)).success).toBe(true);
    expect((await fixture.historyService.commitPartial(ws)).success).toBe(true);
    await assertStale(after);
  });

  test.each(["missing", "corrupt", "oversized", "pending", "mismatched"] as const)(
    "resumed cursors reject a %s receipt, then cold scans reconcile",
    async (kind) => {
      const cursor = await startCursor();
      const old = (await store.read()).receipt!;
      if (kind === "missing") await fs.rm(store.receiptPath);
      else if (kind === "corrupt") await fs.writeFile(store.receiptPath, "not-json");
      else if (kind === "oversized")
        await fs.writeFile(store.receiptPath, "x".repeat(HISTORY_PROVENANCE_MAX_RECEIPT_BYTES + 1));
      else if (kind === "pending")
        await fs.writeFile(store.receiptPath, JSON.stringify({ ...old, state: "pending" }));
      else
        await fs.writeFile(
          store.receiptPath,
          JSON.stringify({
            ...old,
            files: { ...old.files, chat: { ...old.files.chat, size: "0" } },
          })
        );
      await assertStale(cursor);
      const fresh = await startCursor();
      expect(fresh.provenanceEpoch).not.toBe(cursor.provenanceEpoch);
      expect((await resume(fresh)).length).toBe(2);
    }
  );

  test("untracked appends cannot be blessed by the next cooperative append", async () => {
    const cursor = await startCursor();
    await fs.appendFile(
      store.chatPath,
      JSON.stringify(createMuxMessage("external", "assistant", "external")) + "\n"
    );
    await fixture.historyService.appendToHistory(
      ws,
      createMuxMessage("cooperative", "assistant", "later")
    );
    await assertStale(cursor);
  });

  test("ordinary append retries delimit partial writes and invalidate any torn-tail scan epoch", async () => {
    const cursor = await startCursor();
    const append = fs.appendFile;
    const failure = spyOn(fs, "appendFile").mockImplementationOnce(
      async (target, data, options) => {
        expect(Buffer.isBuffer(data)).toBe(true);
        assert(Buffer.isBuffer(data));
        await append(target, data.subarray(0, data.length - 3), options);
        throw new Error("partial append failure");
      }
    );
    try {
      const failed = await fixture.historyService.appendToHistory(
        ws,
        createMuxMessage("failed", "user", "failed input")
      );
      expect(failed.success).toBe(false);
      if (!failed.success) expect(failed.error).toContain("partial append failure");
      expect(failure).toHaveBeenCalledTimes(1);
    } finally {
      failure.mockRestore();
    }
    await assertStale(cursor);
    const afterFailure = await startCursor();
    const before = await fs.readFile(store.chatPath);
    expect(before.at(-1)).not.toBe(10);
    expect(
      (
        await fixture.historyService.appendToHistory(
          ws,
          createMuxMessage("accepted", "user", "accepted retry")
        )
      ).success
    ).toBe(true);
    expect(
      (
        await fixture.historyService.appendToHistory(
          ws,
          createMuxMessage("result", "assistant", "accepted result")
        )
      ).success
    ).toBe(true);
    expect((await fs.readFile(store.chatPath)).subarray(0, before.length)).toEqual(before);
    await assertStale(afterFailure);
    const rows = await fixture.historyService.getHistoryFromLatestBoundary(ws);
    expect(rows.success).toBe(true);
    if (!rows.success) throw new Error(rows.error);
    expect(rows.data.map((row) => row.id)).toEqual([
      "row-0",
      "row-1",
      "row-2",
      "accepted",
      "result",
    ]);
  });

  test("atomic batches preserve corrupt UTF-8 bytes but invalidate torn-tail repair", async () => {
    await fs.appendFile(store.chatPath, Buffer.from([0xff, 0xfe, 10]));
    const cursor = await startCursor();
    const before = await fs.readFile(store.chatPath);
    await fixture.historyService.appendManyToHistory(ws, [
      createMuxMessage("binary-tail", "assistant", "later"),
    ]);
    const after = await fs.readFile(store.chatPath);
    expect(after.subarray(0, before.length).equals(before)).toBe(true);
    expect((await resume(cursor)).map((row) => row.id)).toEqual(["row-1", "row-2"]);
    await fs.appendFile(store.chatPath, "torn-tail");
    const torn = await startCursor();
    expect(
      (
        await fixture.historyService.appendManyToHistory(ws, [
          createMuxMessage("healed", "assistant", "healed"),
        ])
      ).success
    ).toBe(true);
    await assertStale(torn);
  });

  test.each(["update", "delete", "truncate", "rotate", "clear", "copy"] as const)(
    "%s changes invalidate the epoch",
    async (mutation) => {
      const cursor = await startCursor();
      if (mutation === "update")
        await fixture.historyService.updateHistory(
          ws,
          createMuxMessage("row-1", "assistant", "changed", { historySequence: 1 })
        );
      else if (mutation === "delete") await fixture.historyService.deleteMessage(ws, "row-1");
      else if (mutation === "truncate")
        await fixture.historyService.truncateAfterMessage(ws, "row-1");
      else if (mutation === "rotate")
        await fixture.historyService.appendToHistory(
          ws,
          createMuxMessage("rollover", "assistant", "", { contextBoundaryKind: "reset" })
        );
      else if (mutation === "clear") await fixture.historyService.clearHistory(ws);
      else {
        await fixture.historyService.appendToHistory(
          "source",
          createMuxMessage("copy", "assistant", "copy")
        );
        await fixture.historyService.copyHistorySnapshotToNewWorkspace("source", ws);
      }
      await assertStale(cursor);
    }
  );

  test("pending crash evidence survives process exit and restart", async () => {
    const cursor = await startCursor();
    child(`const store = new HistoryAppendProvenance(config.sessionsDir + "/" + ws);
      await store.runMutation(async () => { await store.appendChat(Buffer.from(JSON.stringify(createMuxMessage("crash", "assistant", "durable append")) + "\\n")); process.exit(0); });`);
    expect((await store.read()).receipt?.state).toBe("pending");
    await assertStale(cursor);
    const fresh = await startCursor();
    expect((await resume(fresh)).map((row) => row.id)).toContain("crash");
  });

  test("a completed append followed by an I/O error is not reported as unpersisted", async () => {
    const cursor = await startCursor();
    const append = fs.appendFile;
    const failed = spyOn(fs, "appendFile").mockImplementationOnce(async (target, data, options) => {
      await append(target, data, options);
      throw new Error("late append completion error");
    });
    try {
      expect(
        (
          await fixture.historyService.appendToHistory(
            ws,
            createMuxMessage("late-error", "assistant", "persisted")
          )
        ).success
      ).toBe(true);
    } finally {
      failed.mockRestore();
    }
    await assertStale(cursor);
    expect((await fs.readFile(store.chatPath, "utf8")).match(/"id":"late-error"/g)?.length).toBe(1);
  });

  test("an atomic rollover batch published before a rename error remains accepted once", async () => {
    // write-file-atomic resolves symlinked temp roots before renaming an existing file.
    const chatPath = await fs.realpath(store.chatPath);
    const rename = nodeFs.rename;
    let publishedRenames = 0;
    const failed = spyOn(nodeFs, "rename").mockImplementation(
      Object.assign(
        (...[source, target, callback]: Parameters<typeof nodeFs.rename>) => {
          rename(source, target, (error) => {
            if (!error && target === chatPath) {
              publishedRenames++;
              callback(new Error("post-rename error"));
            } else callback(error);
          });
        },
        { __promisify__: rename.__promisify__ }
      )
    );
    try {
      const result = await fixture.historyService.appendManyToHistory(ws, [
        createMuxMessage("late-boundary", "assistant", "", { contextBoundaryKind: "reset" }),
        createMuxMessage("late-continuation", "user", "continue"),
      ]);
      expect(result.success).toBe(true);
      expect(publishedRenames).toBeGreaterThan(0);
    } finally {
      failed.mockRestore();
    }
    const messages: MuxMessage[] = [];
    await fixture.historyService.iterateFullHistory(ws, "forward", (rows) => {
      messages.push(...rows);
    });
    expect(messages.filter((row) => row.id === "late-continuation").length).toBe(1);
  });

  test("post-append certification failure preserves success but expires the epoch", async () => {
    const cursor = await startCursor();
    const stamps = HistoryAppendProvenance.prototype.stamps.bind(store);
    let calls = 0;
    const failed = spyOn(HistoryAppendProvenance.prototype, "stamps").mockImplementation(function (
      this: HistoryAppendProvenance
    ) {
      return ++calls === 3 ? Promise.reject(new Error("post-append stat failure")) : stamps();
    });
    try {
      expect(
        (
          await fixture.historyService.appendToHistory(
            ws,
            createMuxMessage("accepted-without-certificate", "assistant", "accepted")
          )
        ).success
      ).toBe(true);
    } finally {
      failed.mockRestore();
    }
    await assertStale(cursor);
    expect(await fs.readFile(store.chatPath, "utf8")).toContain("accepted-without-certificate");
  });

  test("stable receipt failure never reports an already-persisted append as failed", async () => {
    const cursor = await startCursor();
    const publish = privateMethods.publish.bind(store);
    const failed = spyOn(privateMethods, "publish").mockImplementation(function (
      this: HistoryAppendProvenance,
      receipt
    ) {
      return receipt.state === "stable"
        ? Promise.reject(new Error("receipt disk failure"))
        : publish(receipt);
    });
    try {
      const result = await fixture.historyService.appendToHistory(
        ws,
        createMuxMessage("accepted", "assistant", "accepted once")
      );
      expect(result.success).toBe(true);
      expect((await fs.readFile(store.chatPath, "utf8")).match(/"id":"accepted"/g)?.length).toBe(1);
      expect((await store.read()).receipt?.state).toBe("pending");
    } finally {
      failed.mockRestore();
    }
    await assertStale(cursor);
  });

  test("pending publication failure may continue only after receipt invalidation", async () => {
    const cursor = await startCursor();
    const failed = spyOn(privateMethods, "publish").mockImplementation(() =>
      Promise.reject(new Error("pending unavailable"))
    );
    try {
      expect(
        (
          await fixture.historyService.appendToHistory(
            ws,
            createMuxMessage("accepted-untracked", "assistant", "accepted")
          )
        ).success
      ).toBe(true);
      expect((await store.read()).receipt).toBeNull();
    } finally {
      failed.mockRestore();
    }
    await assertStale(cursor);
  });

  test("if pending publication and invalidation fail, no history bytes are mutated", async () => {
    const cursor = await startCursor();
    const before = await fs.readFile(store.chatPath);
    const originalRm = fs.rm;
    const failedPublish = spyOn(privateMethods, "publish").mockImplementation(() =>
      Promise.reject(new Error("pending unavailable"))
    );
    const failedRemoval = spyOn(fs, "rm").mockImplementation((target, options) =>
      target === store.receiptPath
        ? Promise.reject(new Error("receipt cannot be invalidated"))
        : originalRm(target, options)
    );
    try {
      expect(
        (
          await fixture.historyService.appendToHistory(
            ws,
            createMuxMessage("not-accepted", "assistant", "blocked")
          )
        ).success
      ).toBe(false);
      expect((await fs.readFile(store.chatPath)).equals(before)).toBe(true);
    } finally {
      failedPublish.mockRestore();
      failedRemoval.mockRestore();
    }
    expect((await resume(cursor)).length).toBe(2);
  });

  test("failed append attempts and unknown writes inside a transaction invalidate", async () => {
    const cursor = await startCursor();
    const failed = spyOn(fs, "appendFile").mockImplementationOnce(() =>
      Promise.reject(new Error("append failed"))
    );
    try {
      expect(
        (
          await fixture.historyService.appendToHistory(
            ws,
            createMuxMessage("failed", "assistant", "failed")
          )
        ).success
      ).toBe(false);
    } finally {
      failed.mockRestore();
    }
    await assertStale(cursor);
    // Real same-tick writes can retain identical nanosecond stamps. Seed an old
    // mtime before the cursor so this same-size rewrite deterministically changes
    // observable metadata; stamp-only provenance cannot detect identical stamps.
    const oldTime = new Date("2000-01-01T00:00:00Z");
    await fs.utimes(store.chatPath, oldTime, oldTime);
    const next = await startCursor();
    await using _lock = await acquireProcessFileLock({
      lockPath: historyWriteLockPath(fixture.config.rootDir, ws),
      timeoutMs: 5000,
      label: "test unknown rewrite",
    });
    await store.runMutation(async () => {
      const before = (await store.stamps()).chat!;
      const text = await fs.readFile(store.chatPath, "utf8");
      const rewritten = text.replace("facts 1", "reset 1");
      expect(rewritten).not.toBe(text);
      await fs.writeFile(store.chatPath, rewritten);
      expect(await fs.readFile(store.chatPath, "utf8")).toBe(rewritten);
      const after = (await store.stamps()).chat!;
      expect(after.size).toBe(before.size);
      expect(after.mtimeNs).not.toBe(before.mtimeNs);
      await store.appendChat(
        Buffer.from(JSON.stringify(createMuxMessage("after-unknown", "assistant", "append")) + "\n")
      );
    });
    expect((await store.read()).receipt?.epoch).not.toBe(next.provenanceEpoch);
  });
});

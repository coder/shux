import { afterEach, beforeEach, expect, spyOn, test } from "bun:test";
import * as fs from "node:fs/promises";
import * as path from "node:path";
import { createMuxMessage } from "@/common/types/message";
import { createTestHistoryService } from "./testHistoryService";
import type { HistoryScanState } from "./historyCursor";
import { HistoryAppendProvenance } from "./historyAppendProvenance";
import { workspaceFileLocks } from "@/node/utils/concurrency/workspaceFileLocks";
import { acquireProcessFileLock } from "@/node/utils/concurrency/fileLock";
import { historyWriteLockPath } from "./workspaceRemoval";

let fixture: Awaited<ReturnType<typeof createTestHistoryService>>;
const workspaceId = "scan-control";
const ids = ["first", "second", "third"];

beforeEach(async () => {
  fixture = await createTestHistoryService();
  expect(
    (
      await fixture.historyService.appendManyToHistory(
        workspaceId,
        ids.map((id) => createMuxMessage(id, "user", id))
      )
    ).success
  ).toBe(true);
});
afterEach(async () => {
  await fixture.cleanup();
});

// Real reads still run. Only synchronization/clock transitions are injected, and
// every opened transcript handle must have closed before a scan settles.
function interceptReads(onRead: () => void) {
  const open = fs.open;
  const restores: Array<() => void> = [];
  const closed: Array<() => boolean> = [];
  const opened = spyOn(fs, "open").mockImplementation(async (...args) => {
    const handle = await open(...args);
    if (String(args[0]).endsWith(".jsonl")) {
      const read = handle.read.bind(handle);
      // The scanner uses the positional Buffer overload, not read(options).
      const observedRead = async (
        buffer: Buffer,
        offset: number,
        length: number,
        position: number
      ) => {
        const result = await read(buffer, offset, length, position);
        if (result.bytesRead > 128) onRead();
        return result;
      };
      const reads = spyOn(handle, "read").mockImplementation(observedRead as fs.FileHandle["read"]);
      const close = spyOn(handle, "close");
      closed.push(() => close.mock.calls.length === 1);
      restores.push(() => {
        reads.mockRestore();
        close.mockRestore();
      });
    }
    return handle;
  });
  return {
    assertClosed: () => {
      expect(closed.length).toBeGreaterThan(0);
      expect(closed.every((isClosed) => isClosed())).toBe(true);
    },
    restore: () => {
      opened.mockRestore();
      restores.forEach((restore) => restore());
    },
  };
}

async function atPhase(phase: HistoryScanState["phase"], recentFirst: boolean) {
  let cursor: HistoryScanState | undefined;
  for (let page = 0; page < 15; page++) {
    const result = await fixture.historyService.scanHistoryBounded(workspaceId, {
      cursor,
      recentFirst,
      budget: { maxBytes: 2 * 1024 * 1024, maxRows: 1 },
      visit: () => false,
    });
    cursor = result.cursor;
    if (cursor?.phase === phase) return cursor;
  }
  throw new Error(`did not reach ${phase}`);
}

test.each([false, true])(
  "deadline immediately before/after delivery neither skips nor repeats rows (reverse=%s)",
  async (recentFirst) => {
    const cursor = await atPhase(recentFirst ? "deliver" : "browse", recentFirst);
    for (const before of [true, false]) {
      let now = 0;
      const clock = spyOn(performance, "now").mockImplementation(() => now);
      const reads = interceptReads(() => {
        if (before) now = 10;
      });
      const delivered: string[] = [];
      try {
        const paused = await fixture.historyService.scanHistoryBounded(workspaceId, {
          cursor,
          recentFirst,
          deadline: 10,
          visit: ({ message }) => {
            delivered.push(message.id);
            now = 10;
            return true;
          },
        });
        reads.assertClosed();
        expect(delivered).toHaveLength(before ? 0 : 1);
        expect(paused.cursor).toBeDefined();
        reads.restore();
        clock.mockRestore();
        const resumed = await fixture.historyService.scanHistoryBounded(workspaceId, {
          cursor: paused.cursor,
          recentFirst,
          visit: ({ message }) => {
            delivered.push(message.id);
            return true;
          },
        });
        expect(resumed.cursor).toBeUndefined();
        expect(delivered).toEqual(recentFirst ? ids.toReversed() : ids);
      } finally {
        reads.restore();
        clock.mockRestore();
      }
    }
  }
);

test.each(["floor", "append", "probe", "deliver"] as const)(
  "deadline and cancellation during %s close files and release locks",
  async (phase) => {
    const recentFirst = phase === "probe" || phase === "deliver";
    const cursor = await atPhase(phase === "append" ? "browse" : phase, recentFirst);
    if (phase === "append")
      expect(
        (
          await fixture.historyService.appendToHistory(
            workspaceId,
            createMuxMessage("appended", "user", "new")
          )
        ).success
      ).toBe(true);
    for (const abort of [false, true]) {
      const controller = new AbortController();
      const reason = new Error(`cancel ${phase}`);
      let now = 0;
      const clock = spyOn(performance, "now").mockImplementation(() => now);
      const reads = interceptReads(() => {
        if (abort) controller.abort(reason);
        else now = 10;
      });
      const validate = spyOn(HistoryAppendProvenance.prototype, "validatePage");
      try {
        const operation = fixture.historyService.scanHistoryBounded(workspaceId, {
          cursor,
          recentFirst,
          deadline: 10,
          abortSignal: controller.signal,
          visit: () => {
            throw new Error("must pause before disclosure");
          },
        });
        if (abort) expect(await operation.catch((error: unknown) => error)).toBe(reason);
        else {
          const paused = await operation;
          expect(paused.cursor).toBeDefined();
          expect(validate.mock.calls.length).toBe(1);
          reads.assertClosed();
          reads.restore();
          clock.mockRestore();
          const delivered: string[] = [];
          const resumed = await fixture.historyService.scanHistoryBounded(workspaceId, {
            cursor: paused.cursor,
            recentFirst,
            visit: ({ message }) => {
              delivered.push(message.id);
              return true;
            },
          });
          expect(resumed.cursor).toBeUndefined();
          expect(delivered).toEqual(recentFirst ? ids.toReversed() : ids);
        }
        if (abort) reads.assertClosed();
      } finally {
        reads.restore();
        validate.mockRestore();
        clock.mockRestore();
      }
      // Reacquire both real locks after either exit path.
      await fixture.historyService.withHistoryScanLocks(workspaceId, () => Promise.resolve());
    }
  }
);

test.each(["local", "process"] as const)(
  "abort while waiting for the %s lock releases without scanning",
  async (kind) => {
    const controller = new AbortController();
    const reason = new Error("cancel lock wait");
    const reads = spyOn(fixture.historyService, "scanHistoryBoundedUnderLocks");
    let release!: () => void;
    const held = new Promise<void>((resolve) => {
      release = resolve;
    });
    let acquired!: () => void;
    const ready = new Promise<void>((resolve) => {
      acquired = resolve;
    });
    const holder =
      kind === "local"
        ? workspaceFileLocks.withLock(workspaceId, async () => {
            acquired();
            await held;
          })
        : (async () => {
            await using _lock = await acquireProcessFileLock({
              lockPath: historyWriteLockPath(fixture.config.rootDir, workspaceId),
              timeoutMs: 5000,
              label: "test lock wait",
            });
            acquired();
            await held;
          })();
    await ready;
    let attempted!: () => void;
    const attempt = new Promise<void>((resolve) => {
      attempted = resolve;
    });
    const link = fs.link;
    const linked = spyOn(fs, "link").mockImplementation((...args) => {
      if (args[1] === historyWriteLockPath(fixture.config.rootDir, workspaceId)) attempted();
      return link(...args);
    });
    try {
      const operation = fixture.historyService.scanHistoryBounded(workspaceId, {
        abortSignal: controller.signal,
        visit: () => true,
      });
      const outcome = operation.catch((error: unknown) => error);
      if (kind === "process") await attempt;
      controller.abort(reason);
      release();
      await holder;
      expect(await outcome).toBe(reason);
      expect(reads.mock.calls).toHaveLength(0);
      await fixture.historyService.withHistoryScanLocks(workspaceId, () => Promise.resolve());
    } finally {
      release();
      await holder;
      linked.mockRestore();
      reads.mockRestore();
    }
  }
);

test("deadline interrupting an oversized reset probe preserves the privacy floor", async () => {
  const dir = path.join(fixture.config.sessionsDir, workspaceId);
  const reset =
    '{"metadata":{"contextBoundaryKind":"reset"},"padding":"' +
    "x".repeat(2 * 1024 * 1024) +
    '"}\n';
  await fs.writeFile(
    path.join(dir, "chat.jsonl"),
    JSON.stringify(createMuxMessage("hidden", "user", "secret")) +
      "\n" +
      reset +
      JSON.stringify(createMuxMessage("visible", "user", "public")) +
      "\n"
  );
  let now = 0;
  let chunks = 0;
  const clock = spyOn(performance, "now").mockImplementation(() => now);
  const reads = interceptReads(() => {
    if (++chunks === 20) now = 10;
  });
  try {
    const paused = await fixture.historyService.scanHistoryBounded(workspaceId, {
      deadline: 10,
      visit: () => {
        throw new Error("floor not proven");
      },
    });
    expect(paused.cursor?.skippingOversized).toBe(true);
    reads.assertClosed();
    reads.restore();
    clock.mockRestore();
    const visible: string[] = [];
    let cursor = paused.cursor;
    do {
      const page = await fixture.historyService.scanHistoryBounded(workspaceId, {
        cursor,
        visit: ({ message }) => {
          visible.push(message.id);
          return true;
        },
      });
      cursor = page.cursor;
    } while (cursor);
    expect(visible).toEqual(["visible"]);
  } finally {
    reads.restore();
    clock.mockRestore();
  }
});

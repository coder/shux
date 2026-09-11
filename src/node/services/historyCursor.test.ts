import { describe, expect, spyOn, test } from "bun:test";
import {
  SESSION_HISTORY_CURSOR_MAX_BYTES,
  SESSION_HISTORY_CURSOR_MAX_ENTRIES,
  SESSION_HISTORY_CURSOR_TTL_MS,
} from "@/common/constants/contextBudget";
import { createMuxMessage } from "@/common/types/message";
import { HistoryCursorStore, type HistoryCursor } from "./historyCursor";
import { createTestHistoryService } from "./testHistoryService";

const binding = { workspaceId: "caller", action: "search", query: "query-hash" } as const;
const cursor: HistoryCursor = { ...binding, scan: null, authorization: null };

describe("HistoryCursorStore", () => {
  test("count eviction is LRU and tokens are retryable", () => {
    const store = new HistoryCursorStore();
    const retained = store.save(cursor);
    const evicted = store.save(cursor);
    for (let i = 2; i < SESSION_HISTORY_CURSOR_MAX_ENTRIES; i++) store.save(cursor);
    expect(store.load(retained, binding)).toEqual({ scan: null, authorization: null });
    const newest = store.save(cursor);
    expect(() => store.load(evicted, binding)).toThrow("invalid_cursor");
    expect(store.load(retained, binding)).toEqual(store.load(newest, binding));
    expect(retained).not.toBe(newest);
  });

  test("serialized metadata eviction applies independently of entry count", () => {
    const store = new HistoryCursorStore();
    // Oversized test binding reaches the byte quota before the count quota.
    const large = { ...cursor, query: "q".repeat(32 * 1024) };
    const size = Buffer.byteLength(JSON.stringify(large));
    const count = Math.floor(SESSION_HISTORY_CURSOR_MAX_BYTES / size);
    expect(count).toBeLessThan(SESSION_HISTORY_CURSOR_MAX_ENTRIES);
    const first = store.save(large);
    for (let i = 1; i < count; i++) store.save(large);
    const newest = store.save(large);
    expect(() => store.load(first, large)).toThrow("invalid_cursor");
    expect(store.load(newest, large)).toEqual({ scan: null, authorization: null });
    expect(() =>
      store.save({ ...cursor, query: "q".repeat(SESSION_HISTORY_CURSOR_MAX_BYTES) })
    ).toThrow();
  });

  test("TTL expires lazily without refreshing on reads", () => {
    const clock = spyOn(performance, "now");
    try {
      clock.mockReturnValue(100);
      const store = new HistoryCursorStore();
      const token = store.save(cursor);
      clock.mockReturnValue(100 + SESSION_HISTORY_CURSOR_TTL_MS - 1);
      expect(store.load(token, binding)).toEqual({ scan: null, authorization: null });
      clock.mockReturnValue(100 + SESSION_HISTORY_CURSOR_TTL_MS + 1);
      expect(() => store.load(token, binding)).toThrow("invalid_cursor");
    } finally {
      clock.mockRestore();
    }
  });

  test("missing, tampered, retired-format and wrong-binding handles fail identically", () => {
    const store = new HistoryCursorStore();
    const token = store.save(cursor);
    for (const value of [
      "unknown",
      token + "x",
      Buffer.from(JSON.stringify(cursor)).toString("base64url"),
    ])
      expect(() => store.load(value, binding)).toThrow("invalid_cursor");
    for (const changed of [
      { ...binding, workspaceId: "other" },
      { ...binding, action: "list_items" as const },
      { ...binding, query: "other" },
    ])
      expect(() => store.load(token, changed)).toThrow("invalid_cursor");
    expect(() => new HistoryCursorStore().load(token, binding)).toThrow("invalid_cursor");
  });

  test("save and load detach nested scan and authorization state", async () => {
    const fixture = await createTestHistoryService();
    try {
      await fixture.historyService.appendToHistory(
        "caller",
        createMuxMessage("row", "user", "facts")
      );
      const { cursor: scan } = await fixture.historyService.scanHistoryBounded("caller", {
        visit: () => false,
      });
      expect(scan).toBeDefined();
      const value: HistoryCursor = {
        ...binding,
        scan: scan!,
        authorization: { branchRoot: "child", scan: scan!, proven: true },
      };
      const original = structuredClone(value);
      const store = new HistoryCursorStore();
      const token = store.save(value);
      value.scan!.byteOffset++;
      value.authorization!.proven = false;
      const loaded = store.load(token, binding);
      expect(loaded).toEqual({ scan: original.scan, authorization: original.authorization });
      loaded.authorization!.scan.byteOffset++;
      loaded.scan!.snapshots.chat.headHash = "mutated";
      expect(store.load(token, binding)).toEqual({
        scan: original.scan,
        authorization: original.authorization,
      });
    } finally {
      await fixture.cleanup();
    }
  });
});

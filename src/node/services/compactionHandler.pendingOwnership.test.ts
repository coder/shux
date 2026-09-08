import { afterEach, beforeEach, describe, expect, it, mock, spyOn } from "bun:test";
import { EventEmitter } from "events";
import * as fs from "fs/promises";
import * as path from "path";
import { createMuxMessage } from "@/common/types/message";
import assert from "@/common/utils/assert";
import { CompactionHandler } from "./compactionHandler";
import { createTestHistoryService } from "./testHistoryService";

const workspaceId = "pending-consumers";
const followUp = { text: "wake", model: "openai:gpt-4o", agentId: "exec" };

describe("exact pending snapshot consumption", () => {
  let store: Awaited<ReturnType<typeof createTestHistoryService>>;
  let handler: CompactionHandler;
  let sessionDir: string;
  let pendingPath: string;

  function restart() {
    return new CompactionHandler({
      workspaceId,
      historyService: store.historyService,
      sessionDir,
      emitter: new EventEmitter(),
    });
  }

  beforeEach(async () => {
    store = await createTestHistoryService();
    sessionDir = path.join(store.tempDir, "pending");
    pendingPath = path.join(sessionDir, "post-compaction.json");
    handler = restart();
  });

  afterEach(async () => {
    mock.restore();
    await store.cleanup();
  });

  async function publish(id?: string) {
    if (id) {
      const message = createMuxMessage(id, "assistant", "");
      message.parts = [
        {
          type: "dynamic-tool",
          toolCallId: id,
          toolName: "file_read",
          state: "output-available",
          input: { path: `/${id}.ts` },
          output: { success: true },
        },
      ];
      await store.historyService.appendToHistory(workspaceId, message);
    }
    expect(
      (
        await handler.appendHeartbeatContextResetBoundary({
          boundaryText: "reset",
          pendingFollowUp: followUp,
        })
      ).success
    ).toBe(true);
    const state = await handler.peekPendingState();
    assert(state, "Expected published state");
    return state;
  }

  it.each(
    (["ack", "discard"] as const).flatMap((action) =>
      [false, true].map((reload) => ({ action, reload }))
    )
  )(
    "late $action preserves an identical-byte successor (reload=$reload)",
    async ({ action, reload }) => {
      spyOn(Date, "now").mockReturnValue(1234);
      await publish();
      if (reload) handler = restart();
      const consumed = await handler.peekPendingState();
      const previous = await fs.readFile(pendingPath, "utf8");
      await publish();
      expect(await fs.readFile(pendingPath, "utf8")).toBe(previous);
      if (action === "ack") await handler.ackPendingStateConsumed(consumed);
      else await handler.discardPendingState("context_exceeded", consumed);
      expect(await handler.peekPendingState()).not.toBeNull();
      expect(await fs.readFile(pendingPath, "utf8")).toBe(previous);
    }
  );

  it.each(["ack", "discard"] as const)(
    "%s unlink finishes before a successor write",
    async (action) => {
      const consumed = await publish("a");
      const entered = Promise.withResolvers<void>();
      const release = Promise.withResolvers<void>();
      const unlink = fs.unlink;
      spyOn(fs, "unlink").mockImplementationOnce(async (target) => {
        entered.resolve();
        await release.promise;
        return unlink(target);
      });
      const cleanup =
        action === "ack"
          ? handler.ackPendingStateConsumed(consumed)
          : handler.discardPendingState("context_exceeded", consumed);
      let replacement: ReturnType<typeof publish> | undefined;
      try {
        await entered.promise;
        // Observe the real persistence call after B's cache update; keep A's physical unlink held.
        const persistence = handler as unknown as {
          persistPendingStateBestEffort(...args: unknown[]): Promise<void>;
        };
        const persist = persistence.persistPendingStateBestEffort.bind(handler);
        const writeRequested = Promise.withResolvers<void>();
        spyOn(persistence, "persistPendingStateBestEffort").mockImplementation((...args) => {
          const result = persist(...args);
          writeRequested.resolve();
          return result;
        });
        const mkdir = spyOn(fs, "mkdir");
        replacement = publish("b");
        await writeRequested.promise;
        expect(mkdir.mock.calls.some(([dir]) => String(dir) === sessionDir)).toBe(false);
        release.resolve();
        await cleanup;
        await replacement;
        expect((await handler.peekPendingState())?.readFiles).toContain("/b.ts");
        expect((await restart().peekPendingState())?.readFiles).toContain("/b.ts");
      } finally {
        release.resolve();
        await cleanup;
        await replacement;
      }
    }
  );

  it.each(["ack", "discard"] as const)(
    "%s retires older bytes after a failed pending write",
    async (action) => {
      await publish("a");
      const previous = await fs.readFile(pendingPath, "utf8");
      const mkdir = fs.mkdir;
      const failure = spyOn(fs, "mkdir").mockImplementation((async (
        ...args: Parameters<typeof fs.mkdir>
      ) => {
        if (String(args[0]) === sessionDir) throw new Error("pending mkdir failed");
        return mkdir(...args);
      }) as typeof fs.mkdir);
      let consumed: Awaited<ReturnType<typeof publish>>;
      try {
        consumed = await publish("b");
        expect(failure.mock.calls.some(([dir]) => String(dir) === sessionDir)).toBe(true);
      } finally {
        failure.mockRestore();
      }
      expect(await fs.readFile(pendingPath, "utf8")).toBe(previous);
      if (action === "ack") await handler.ackPendingStateConsumed(consumed);
      else await handler.discardPendingState("context_exceeded", consumed);
      expect(await handler.peekPendingState()).toBeNull();
      expect(await restart().peekPendingState()).toBeNull();
    }
  );

  it("repeated peeks share consumption authority and a later discard clears retained carryover", async () => {
    const first = await publish("a");
    const second = await handler.peekPendingState();
    await handler.ackPendingStateConsumed(first);
    await handler.discardPendingState("context_exceeded", second);
    const next = await publish("b");
    expect(next.readFiles).toEqual(["/b.ts"]);
  });

  it("a failed unlink cannot let a retried old acknowledgement remove its successor", async () => {
    const consumed = await publish("a");
    spyOn(fs, "unlink").mockRejectedValueOnce(new Error("pending unlink failed"));
    await handler.ackPendingStateConsumed(consumed);
    expect(await fs.readFile(pendingPath, "utf8")).toContain("/a.ts");
    await publish("b");
    await handler.ackPendingStateConsumed(consumed);
    expect((await handler.peekPendingState())?.readFiles).toContain("/b.ts");
    expect((await restart().peekPendingState())?.readFiles).toContain("/b.ts");
  });
});

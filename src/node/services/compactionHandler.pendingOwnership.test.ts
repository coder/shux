import { afterEach, beforeEach, describe, expect, it, mock, spyOn } from "bun:test";
import { EventEmitter } from "events";
import * as fs from "fs/promises";
import * as path from "path";
import { createMuxMessage } from "@/common/types/message";
import * as syncFs from "node:fs";
import assert from "@/common/utils/assert";
import { CompactionHandler } from "./compactionHandler";
import { createTestHistoryService } from "./testHistoryService";
import { historyWriteLockPath } from "./workspaceRemoval";

const workspaceId = "pending-consumers";
const followUp = { text: "wake", model: "openai:gpt-4o", agentId: "exec" };

function readMessage(id: string) {
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
  return message;
}

describe("exact pending snapshot consumption", () => {
  let store: Awaited<ReturnType<typeof createTestHistoryService>>;
  let handler: CompactionHandler;
  let sessionDir: string;
  let pendingPath: string;
  let emitter: EventEmitter;

  function restart() {
    return new CompactionHandler({
      workspaceId,
      historyService: store.historyService,
      sessionDir,
      emitter,
    });
  }

  beforeEach(async () => {
    store = await createTestHistoryService();
    sessionDir = path.join(store.tempDir, "pending");
    pendingPath = path.join(sessionDir, "post-compaction.json");
    emitter = new EventEmitter();
    handler = restart();
  });

  afterEach(async () => {
    mock.restore();
    await store.cleanup();
  });

  function failRename(target: string) {
    const rename = syncFs.renameSync;
    return spyOn(syncFs, "renameSync").mockImplementation((from, to) => {
      if (to === target) throw new Error("Publication unavailable");
      rename(from, to);
    });
  }

  async function publish(id?: string) {
    if (id) {
      await store.historyService.appendToHistory(workspaceId, readMessage(id));
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
    "late $action preserves a successor with identical attachments (reload=$reload)",
    async ({ action, reload }) => {
      spyOn(Date, "now").mockReturnValue(1234);
      await publish();
      if (reload) handler = restart();
      const consumed = await handler.peekPendingState();
      const previous = await fs.readFile(pendingPath, "utf8");
      await publish();
      const successor = JSON.parse(await fs.readFile(pendingPath, "utf8")) as { writeId: string };
      expect(successor.writeId).not.toBe((JSON.parse(previous) as { writeId: string }).writeId);
      if (action === "ack") await handler.ackPendingStateConsumed(consumed);
      else await handler.discardPendingState("context_exceeded", consumed);
      expect(await handler.peekPendingState()).not.toBeNull();
      expect(JSON.parse(await fs.readFile(pendingPath, "utf8"))).toMatchObject({
        writeId: successor.writeId,
      });
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
        const begin = handler.beginPreparation.bind(handler);
        const requested = Promise.withResolvers<void>();
        spyOn(handler, "beginPreparation").mockImplementation((guard) => {
          const result = begin(guard);
          requested.resolve();
          return result;
        });
        replacement = publish();
        await requested.promise;
        release.resolve();
        await cleanup;
        await replacement;
        expect(await handler.peekPendingState()).not.toBeNull();
        expect(await restart().peekPendingState()).not.toBeNull();
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
      const failure = failRename(pendingPath);
      let consumed: Awaited<ReturnType<typeof publish>>;
      try {
        consumed = await publish("b");
        expect(failure.mock.calls.some(([, target]) => target === pendingPath)).toBe(true);
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
    const unlink = fs.unlink;
    const failure = spyOn(fs, "unlink").mockImplementation(async (target) => {
      if (target === pendingPath) throw new Error("pending unlink failed");
      await unlink(target);
    });
    await handler.ackPendingStateConsumed(consumed);
    expect(await fs.readFile(pendingPath, "utf8")).toContain("/a.ts");
    failure.mockRestore();
    await publish("b");
    await handler.ackPendingStateConsumed(consumed);
    expect((await handler.peekPendingState())?.readFiles).toContain("/b.ts");
    expect((await restart().peekPendingState())?.readFiles).toContain("/b.ts");
  });

  it("a failed manual boundary cannot expose uncommitted successor state", async () => {
    const consumed = await publish("a");
    await store.historyService.appendToHistory(workspaceId, readMessage("b"));
    await store.historyService.appendToHistory(
      workspaceId,
      createMuxMessage("compact-b", "user", "compact", {
        muxMetadata: { type: "compaction-request", rawCommand: "/compact", parsed: {} },
      })
    );
    failRename(path.join(store.config.sessionsDir, workspaceId, "chat.jsonl"));
    expect(
      await handler.handleCompletion({
        type: "stream-end",
        workspaceId,
        messageId: "b-summary",
        metadata: { model: followUp.model },
        parts: [{ type: "text", text: "B summary" }],
      })
    ).toBe(false);

    const history = await store.historyService.getHistoryFromLatestBoundary(workspaceId);
    assert(history.success, "Expected readable history after failed boundary");
    expect(history.data.some((message) => message.metadata?.compacted === "user")).toBe(false);
    expect((await handler.peekPendingState())?.readFiles).toEqual(["/a.ts"]);
    await handler.ackPendingStateConsumed(consumed);
    expect(await handler.peekPendingState()).toBeNull();
    expect(await restart().peekPendingState()).toBeNull();
  });

  it.each(
    (["ack", "discard"] as const).flatMap((action) =>
      [false, true].map((failedRestore) => ({ action, failedRestore }))
    )
  )(
    "request A can $action after continuous rollback (failed rewrite=$failedRestore)",
    async ({ action, failedRestore }) => {
      const consumed = await publish("a");
      const rename = syncFs.renameSync;
      let pendingWrites = 0;
      const failure = spyOn(syncFs, "renameSync").mockImplementation((from, to) => {
        if (to === pendingPath && ++pendingWrites > 1 && failedRestore)
          throw new Error("Restore unavailable");
        rename(from, to);
      });
      const preparation = handler.beginPreparation(() => true);
      const publication = {
        generation: await store.historyService
          .getContinuousCompactionJournal(workspaceId)
          .captureGeneration(),
      };
      expect(
        await handler.persistContinuousCompaction({
          preparation,
          publication,
          attachmentMessages: [readMessage("b")],
          messages: [readMessage("b")],
          tail: [],
          text: "B",
          model: followUp.model,
          systemMessageTokens: 0,
          attachmentTokens: 0,
          shouldPersist: () => false,
        })
      ).toBe(false);
      failure.mockRestore();
      expect((await handler.peekPendingState())?.readFiles).toEqual(["/a.ts"]);
      if (action === "ack") await handler.ackPendingStateConsumed(consumed);
      else await handler.discardPendingState("context_exceeded", consumed);
      expect(await handler.peekPendingState()).toBeNull();
      expect(await restart().peekPendingState()).toBeNull();
    }
  );

  it.each(
    (["failed append", "contention rollback"] as const).flatMap((outcome) =>
      (["ack", "discard"] as const).flatMap((action) =>
        [false, true].map((failedRestore) => ({ outcome, action, failedRestore }))
      )
    )
  )(
    "request A can $action after heartbeat $outcome (failed rewrite=$failedRestore)",
    async ({ outcome, action, failedRestore }) => {
      const consumed = await publish("a");
      await store.historyService.appendToHistory(workspaceId, readMessage("b"));
      let restore: ReturnType<typeof failRename> | undefined;
      function failRestoreIfRequested() {
        if (failedRestore) restore = failRename(pendingPath);
      }

      try {
        if (outcome === "failed append") {
          const rename = syncFs.renameSync;
          let failedBoundary = false;
          restore = spyOn(syncFs, "renameSync").mockImplementation((from, to) => {
            if (to === path.join(store.config.sessionsDir, workspaceId, "chat.jsonl")) {
              failedBoundary = true;
              throw new Error("heartbeat B append failed");
            }
            if (to === pendingPath && failedBoundary && failedRestore)
              throw new Error("Restore unavailable");
            rename(from, to);
          });
          expect(
            (
              await handler.appendHeartbeatContextResetBoundary({
                boundaryText: "B reset",
                pendingFollowUp: followUp,
              })
            ).success
          ).toBe(false);
        } else {
          const boundary = await handler.appendHeartbeatContextResetBoundary({
            boundaryText: "B reset",
            pendingFollowUp: followUp,
          });
          assert(boundary.success, "Expected durable B before contention rollback");
          const rows = await store.historyService.getLastMessages(workspaceId, 1);
          assert(rows.success, "Expected readable heartbeat boundary");
          const message = rows.data[0];
          assert(message?.id === boundary.data.summaryMessageId, "Expected B's durable row");
          failRestoreIfRequested();
          expect((await handler.rollbackHeartbeatContextResetBoundary(message)).success).toBe(true);
          const history = await store.historyService.getLastMessages(workspaceId, 10);
          assert(history.success, "Expected readable history after rollback");
          expect(history.data.some((row) => row.id === message.id)).toBe(false);
        }
        if (failedRestore) {
          expect(restore?.mock.calls.some(([, target]) => target === pendingPath)).toBe(true);
        }
      } finally {
        restore?.mockRestore();
      }
      expect((await handler.peekPendingState())?.readFiles).toEqual(["/a.ts"]);
      if (action === "ack") await handler.ackPendingStateConsumed(consumed);
      else await handler.discardPendingState("context_exceeded", consumed);
      expect(await handler.peekPendingState()).toBeNull();
      expect(await restart().peekPendingState()).toBeNull();
    }
  );

  it.each([false, true])(
    "committed heartbeat rollback restores its snapshot after admission changes (prior state=%s)",
    async (hasPrevious) => {
      const previous = hasPrevious ? await publish("a") : null;
      await publish("b");
      const rows = await store.historyService.getLastMessages(workspaceId, 1);
      assert(rows.success && rows.data.length === 1, "Expected B boundary");
      const historyPath = path.join(store.config.sessionsDir, workspaceId, "chat.jsonl");
      const lockPath = historyWriteLockPath(store.config.rootDir, workspaceId);
      const unlink = fs.unlink;
      let current = true;
      spyOn(fs, "unlink").mockImplementation(async (target) => {
        if (
          String(target) === lockPath &&
          current &&
          (await fs.readFile(historyPath)).length === 0
        ) {
          // Admission changes during real lock release, after the boundary deletion committed.
          expect((await fs.readFile(historyPath)).length).toBe(0);
          current = false;
        }
        return unlink(target);
      });
      const emitted = spyOn(emitter, "emit");
      expect(
        await handler.rollbackHeartbeatContextResetBoundary(rows.data[0], () => current)
      ).toEqual({ success: true, data: "applied" });
      expect(current).toBe(false);
      expect(await handler.peekPendingState()).toEqual(previous);
      expect(await restart().peekPendingState()).toEqual(previous);
      expect(emitted).toHaveBeenCalledWith("chat-event", {
        workspaceId,
        message: { type: "delete", historySequences: [rows.data[0].metadata?.historySequence] },
      });
    }
  );

  it.each(["before-delete", "after-delete"] as const)(
    "held heartbeat cleanup preserves successor pending state (%s)",
    async (phase) => {
      await publish("a");
      const rows = await store.historyService.getLastMessages(workspaceId, 1);
      assert(rows.success, "Expected A boundary");
      const entered = Promise.withResolvers<void>();
      const release = Promise.withResolvers<void>();
      const cleanup = store.historyService.cleanupCompactionFollowUp.bind(store.historyService);
      spyOn(store.historyService, "cleanupCompactionFollowUp").mockImplementationOnce(
        async (...args) => {
          const result = phase === "after-delete" ? await cleanup(...args) : undefined;
          entered.resolve();
          await release.promise;
          return result ?? cleanup(...args);
        }
      );
      let current = true;
      const rollback = handler.rollbackHeartbeatContextResetBoundary(rows.data[0], () => current);
      try {
        await entered.promise;
        const successor = await publish("b");
        const bytes = await fs.readFile(pendingPath, "utf8");
        const emitted = spyOn(emitter, "emit");
        current = false;
        release.resolve();
        expect(await rollback).toEqual({
          success: true,
          data: phase === "before-delete" ? "skipped" : "applied",
        });
        if (phase === "before-delete") expect(emitted).not.toHaveBeenCalled();
        else
          expect(emitted).toHaveBeenCalledWith("chat-event", {
            workspaceId,
            message: { type: "delete", historySequences: [rows.data[0].metadata?.historySequence] },
          });
        expect(await fs.readFile(pendingPath, "utf8")).toBe(bytes);
        expect(await handler.peekPendingState()).toEqual(successor);
        expect(await restart().peekPendingState()).toEqual(successor);
      } finally {
        release.resolve();
        await rollback;
      }
    }
  );
});

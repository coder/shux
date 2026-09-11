import { afterEach, describe, expect, it, mock, spyOn } from "bun:test";
import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import * as fs from "node:fs/promises";
import * as path from "node:path";
import { CONTINUOUS_COMPACTION_GENERATION_FILE } from "@/constants/continuousCompaction";
import { createMuxMessage } from "@/common/types/message";
import type { StreamEndEvent } from "@/common/types/stream";
import { CompactionHandler } from "./compactionHandler";
import { HistoryService } from "./historyService";
import { createTestHistoryService } from "./testHistoryService";

afterEach(() => mock.restore());

describe("runtime compaction preparation admission", () => {
  it("rejects a foreign generation reset while the first history read is held", async () => {
    const h = await createTestHistoryService();
    const workspaceId = "classification-generation-reset";
    const sessionDir = path.join(h.config.sessionsDir, workspaceId);
    const entered = Promise.withResolvers<void>();
    const release = Promise.withResolvers<void>();
    let operation: Promise<boolean> | undefined;
    try {
      assert(
        (
          await h.historyService.appendToHistory(
            workspaceId,
            createMuxMessage("request", "user", "Compact", {
              muxMetadata: { type: "compaction-request", rawCommand: "/compact", parsed: {} },
            })
          )
        ).success
      );
      const handler = new CompactionHandler({
        workspaceId,
        historyService: h.historyService,
        sessionDir,
        emitter: new EventEmitter(),
      });
      const read = h.historyService.getHistoryFromLatestBoundary.bind(h.historyService);
      spyOn(h.historyService, "getHistoryFromLatestBoundary").mockImplementationOnce(async (id) => {
        const history = await read(id);
        entered.resolve();
        await release.promise;
        return history;
      });
      operation = handler.handleCompletion(
        {
          type: "stream-end",
          workspaceId,
          messageId: "summary",
          metadata: { model: "openai:gpt-4o" },
          parts: [{ type: "text", text: "Summary from before the reset" }],
        },
        "request"
      );
      await entered.promise;
      const historyPath = path.join(sessionDir, "chat.jsonl");
      const historyBytes = await fs.readFile(historyPath);
      // A foreign destructive fence can advance without changing the already-read rows.
      const foreign = new HistoryService(h.config);
      await foreign.getContinuousCompactionJournal(workspaceId).advanceGeneration();
      expect(await fs.readFile(historyPath)).toEqual(historyBytes);
      release.resolve();
      expect(await operation).toBe(false);
      const history = await read(workspaceId);
      assert(history.success);
      expect(history.data.map((row) => row.id)).toEqual(["request"]);
      expect(await handler.peekPendingState()).toBeNull();
    } finally {
      release.resolve();
      await operation;
      await h.cleanup();
    }
  });

  it("refuses compaction publication with an unreadable generation", async () => {
    const h = await createTestHistoryService();
    const workspaceId = "unreadable-generation";
    const sessionDir = path.join(h.config.sessionsDir, workspaceId);
    try {
      assert(
        (
          await h.historyService.appendToHistory(
            workspaceId,
            createMuxMessage("request", "user", "Compact", {
              muxMetadata: { type: "compaction-request", rawCommand: "/compact", parsed: {} },
            })
          )
        ).success
      );
      const handler = new CompactionHandler({
        workspaceId,
        historyService: h.historyService,
        sessionDir,
        emitter: new EventEmitter(),
      });
      await fs.mkdir(path.join(sessionDir, CONTINUOUS_COMPACTION_GENERATION_FILE));
      const failure = await handler
        .handleCompletion(
          {
            type: "stream-end",
            workspaceId,
            messageId: "summary",
            metadata: { model: "openai:gpt-4o" },
            parts: [{ type: "text", text: "Must not publish without a generation fence" }],
          },
          "request"
        )
        .catch((error: unknown) => error);
      assert(failure instanceof Error && "code" in failure);
      expect(failure.code).toBe("EISDIR");
      const history = await h.historyService.getHistoryFromLatestBoundary(workspaceId);
      assert(history.success);
      expect(history.data.map((row) => row.id)).toEqual(["request"]);
      expect(await handler.peekPendingState()).toBeNull();
    } finally {
      await h.cleanup();
    }
  });

  it.each(
    (["manual", "idle", "heartbeat"] as const).flatMap((route) =>
      (["none", "admission", "generation"] as const).map((superseded) => ({ route, superseded }))
    )
  )(
    "$route captures immutable input before its first await (superseded=$superseded)",
    async ({ route, superseded }) => {
      const h = await createTestHistoryService();
      const workspaceId = "preparation-entry";
      const entered = Promise.withResolvers<void>();
      const release = Promise.withResolvers<void>();
      let operation: Promise<boolean> | undefined;
      try {
        assert(
          (
            await h.historyService.appendToHistory(
              workspaceId,
              createMuxMessage("request", "user", "Compact", {
                muxMetadata: {
                  type: "compaction-request",
                  rawCommand: "/compact",
                  parsed: {},
                  ...(route === "idle" && { source: "idle-compaction" }),
                },
              })
            )
          ).success
        );
        const handler = new CompactionHandler({
          workspaceId,
          historyService: h.historyService,
          sessionDir: path.join(h.config.sessionsDir, workspaceId),
          emitter: new EventEmitter(),
        });
        const journal = h.historyService.getContinuousCompactionJournal(workspaceId);
        const capture = journal.captureGeneration.bind(journal);
        spyOn(journal, "captureGeneration").mockImplementationOnce(async () => {
          const generation = await capture();
          entered.resolve();
          await release.promise;
          return generation;
        });
        const event: StreamEndEvent = {
          type: "stream-end",
          workspaceId,
          messageId: "summary",
          metadata: { model: "openai:gpt-4o" },
          parts: [{ type: "text", text: "Captured summary" }],
        };
        const heartbeat = {
          boundaryText: "Captured summary",
          pendingFollowUp: { text: "Resume", model: "openai:gpt-4o", agentId: "exec" },
        };
        operation =
          route === "heartbeat"
            ? handler
                .appendHeartbeatContextResetBoundary(heartbeat)
                .then((result) => result.success)
            : handler.handleCompletion(event, "request");
        await entered.promise;
        event.parts = [{ type: "text", text: "Caller changed summary" }];
        heartbeat.boundaryText = "Caller changed summary";
        heartbeat.pendingFollowUp.text = "Caller changed continuation";
        if (superseded === "admission") {
          // A failed successor still owns the newer admission; A cannot revive afterward.
          expect(await handler.handleCompletion(event, "missing-request")).toBe(false);
        } else if (superseded === "generation") {
          // Unchanged history cannot revive a publication from before a destructive reset.
          await journal.advanceGeneration();
        }
        release.resolve();
        expect(await operation).toBe(superseded === "none");
        const history = await h.historyService.getHistoryFromLatestBoundary(workspaceId);
        assert(history.success);
        if (superseded !== "none") {
          expect(history.data.map((row) => row.id)).toEqual(["request"]);
          expect(await handler.peekPendingState()).toBeNull();
        } else {
          expect(history.data[0].parts).toMatchObject([{ type: "text", text: "Captured summary" }]);
          expect(history.data[0].metadata?.compactionBoundary).toBe(true);
          if (route === "heartbeat")
            expect(history.data[0].metadata?.muxMetadata).toMatchObject({
              pendingFollowUp: { text: "Resume" },
            });
          expect(await handler.peekPendingState()).not.toBeNull();
        }
      } finally {
        release.resolve();
        await operation;
        await h.cleanup();
      }
    }
  );
});

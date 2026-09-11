import { afterEach, beforeEach, describe, expect, it, mock, spyOn } from "bun:test";
import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import * as fs from "node:fs/promises";
import * as path from "node:path";
import { createMuxMessage } from "@/common/types/message";
import { CompactionHandler } from "./compactionHandler";
import { createTestHistoryService } from "./testHistoryService";

describe("compaction partial recovery", () => {
  const workspaceId = "partial-recovery";
  let h: Awaited<ReturnType<typeof createTestHistoryService>>;
  let handler: CompactionHandler;
  let partialPath: string;

  beforeEach(async () => {
    h = await createTestHistoryService();
    const sessionDir = path.join(h.config.sessionsDir, workspaceId);
    partialPath = path.join(sessionDir, "partial.json");
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
    handler = new CompactionHandler({
      workspaceId,
      historyService: h.historyService,
      sessionDir,
      emitter: new EventEmitter(),
    });
  });

  afterEach(async () => {
    mock.restore();
    await h.cleanup();
  });

  async function compact(route: "manual" | "heartbeat" | "continuous") {
    if (route === "heartbeat")
      return (
        await handler.appendHeartbeatContextResetBoundary({
          boundaryText: "Summary",
          pendingFollowUp: { text: "Resume", model: "openai:gpt-4o", agentId: "exec" },
        })
      ).success;
    if (route === "manual")
      return handler.handleCompletion(
        {
          type: "stream-end",
          workspaceId,
          messageId: "summary",
          metadata: { model: "openai:gpt-4o" },
          parts: [{ type: "text", text: "Summary" }],
        },
        "request"
      );
    const preparation = handler.beginPreparation(() => true);
    const history = await h.historyService.getHistoryFromLatestBoundary(workspaceId);
    assert(history.success);
    return handler.persistContinuousCompaction({
      preparation,
      publication: {
        generation: await h.historyService
          .getContinuousCompactionJournal(workspaceId)
          .captureGeneration(),
      },
      attachmentMessages: history.data,
      messages: history.data,
      tail: [],
      text: "Summary",
      model: "openai:gpt-4o",
      systemMessageTokens: 0,
      attachmentTokens: 0,
      shouldPersist: () => true,
    });
  }

  it.each(
    (["manual", "heartbeat", "continuous"] as const).flatMap((route) =>
      (["missing", "malformed", "directory"] as const).map((partial) => ({ route, partial }))
    )
  )("$route publishes after partial recovery ($partial)", async ({ route, partial }) => {
    if (partial === "malformed") await fs.writeFile(partialPath, "{");
    if (partial === "directory") await fs.mkdir(partialPath);
    expect(await compact(route)).toBe(true);
    const history = await h.historyService.getHistoryFromLatestBoundary(workspaceId);
    assert(history.success);
    expect(history.data).toHaveLength(1);
    expect(history.data[0].metadata?.compactionBoundary).toBe(true);
    expect(await handler.peekPendingState()).not.toBeNull();
    expect(await fs.stat(partialPath).catch(() => undefined)).toBeUndefined();
  });

  it.each(["manual", "heartbeat", "continuous"] as const)(
    "%s preserves unrelated partial read failures and refuses publication",
    async (route) => {
      await fs.writeFile(partialPath, "{");
      const readFile = fs.readFile;
      spyOn(fs, "readFile").mockImplementation((async (...args: Parameters<typeof fs.readFile>) => {
        if (args[0] === partialPath)
          throw Object.assign(new Error("Partial read denied"), { code: "EACCES" });
        return readFile(...args);
      }) as typeof fs.readFile);
      expect(await compact(route)).toBe(false);
      mock.restore();
      expect(await fs.readFile(partialPath, "utf8")).toBe("{");
      const history = await h.historyService.getHistoryFromLatestBoundary(workspaceId);
      assert(history.success);
      expect(history.data.map((row) => row.id)).toEqual(["request"]);
      expect(await handler.peekPendingState()).toBeNull();
    }
  );
});

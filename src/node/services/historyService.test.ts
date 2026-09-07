import * as path from "path";
import { describe, it, expect, beforeEach, afterEach, spyOn } from "bun:test";
import { CONTEXT_BOUNDARY_KINDS } from "@/common/constants/contextBoundary";
import { HistoryService } from "./historyService";
import type { Config } from "@/node/config";
import { createTestHistoryService } from "./testHistoryService";
import { updateSubagentTranscriptArtifactsFile } from "./subagentTranscriptArtifacts";
import { createMuxMessage, type MuxMessage } from "@/common/types/message";
import assert from "node:assert";
import { createHash } from "node:crypto";
import * as fs from "fs/promises";
import { acquireProcessFileLock } from "@/node/utils/concurrency/fileLock";
import {
  historyWriteLockPath,
  workspaceRemovalTombstonePath,
} from "@/node/services/workspaceRemoval";

/** Collect all messages via iterateFullHistory (replaces removed getFullHistory). */
async function collectFullHistory(service: HistoryService, workspaceId: string) {
  const messages: MuxMessage[] = [];
  const result = await service.iterateFullHistory(workspaceId, "forward", (chunk) => {
    messages.push(...chunk);
  });
  assert(result.success, `collectFullHistory failed: ${result.success ? "" : result.error}`);
  return messages;
}

async function writeHistoryLines(
  config: Config,
  workspaceId: string,
  lines: string[]
): Promise<void> {
  const workspaceDir = path.join(config.sessionsDir, workspaceId);
  await fs.mkdir(workspaceDir, { recursive: true });
  await fs.writeFile(path.join(workspaceDir, "chat.jsonl"), lines.join("\n") + "\n");
}

function messageLine(workspaceId: string, message: MuxMessage): string {
  return JSON.stringify({ ...message, workspaceId });
}

async function appendNumberedMessages(
  service: HistoryService,
  workspaceId: string,
  count: number
): Promise<void> {
  for (let i = 0; i < count; i++) {
    await service.appendToHistory(
      workspaceId,
      createMuxMessage(`msg-${i}`, "user", `Message ${i}`)
    );
  }
}

describe("HistoryService", () => {
  let service: HistoryService;
  let config: Config;
  let cleanup: () => Promise<void>;

  beforeEach(async () => {
    const testService = await createTestHistoryService();
    service = testService.historyService;
    config = testService.config;
    cleanup = testService.cleanup;
  });

  afterEach(async () => {
    await cleanup();
  });

  describe("getHistory", () => {
    it("should return empty array when no history exists", async () => {
      const messages = await collectFullHistory(service, "workspace1");
      expect(messages).toEqual([]);
    });

    it("should read messages from chat.jsonl", async () => {
      const workspaceId = "workspace1";
      await writeHistoryLines(config, workspaceId, [
        messageLine(workspaceId, createMuxMessage("msg1", "user", "Hello", { historySequence: 0 })),
        messageLine(
          workspaceId,
          createMuxMessage("msg2", "assistant", "Hi there", { historySequence: 1 })
        ),
      ]);

      const messages = await collectFullHistory(service, workspaceId);
      expect(messages).toHaveLength(2);
      expect(messages[0].id).toBe("msg1");
      expect(messages[1].id).toBe("msg2");
    });

    it("should skip malformed JSON lines", async () => {
      const workspaceId = "workspace1";
      await writeHistoryLines(config, workspaceId, [
        messageLine(workspaceId, createMuxMessage("msg1", "user", "Hello", { historySequence: 0 })),
        "invalid json line",
        messageLine(workspaceId, createMuxMessage("msg2", "user", "World", { historySequence: 1 })),
      ]);

      const messages = await collectFullHistory(service, workspaceId);
      expect(messages).toHaveLength(2);
      expect(messages[0].id).toBe("msg1");
      expect(messages[1].id).toBe("msg2");
    });

    it("hydrates legacy cmuxMetadata entries", async () => {
      const workspaceId = "workspace-legacy";
      const legacyMessage = createMuxMessage("msg-legacy", "user", "legacy", {
        historySequence: 0,
      });
      (legacyMessage.metadata as Record<string, unknown>).cmuxMetadata = { type: "normal" };
      await writeHistoryLines(config, workspaceId, [messageLine(workspaceId, legacyMessage)]);

      const messages = await collectFullHistory(service, workspaceId);
      expect(messages[0].metadata?.muxMetadata?.type).toBe("normal");
    });
    it("should handle empty lines in history file", async () => {
      const workspaceId = "workspace1";
      await writeHistoryLines(config, workspaceId, [
        messageLine(workspaceId, createMuxMessage("msg1", "user", "Hello", { historySequence: 0 })),
        "",
        "",
      ]);

      const messages = await collectFullHistory(service, workspaceId);
      expect(messages).toHaveLength(1);
      expect(messages[0].id).toBe("msg1");
    });
  });

  describe("appendToHistory", () => {
    it("should create workspace directory if it doesn't exist", async () => {
      const workspaceId = "workspace1";
      const msg = createMuxMessage("msg1", "user", "Hello");

      const result = await service.appendToHistory(workspaceId, msg);

      expect(result.success).toBe(true);
      const workspaceDir = path.join(config.sessionsDir, workspaceId);
      const exists = await fs
        .access(workspaceDir)
        .then(() => true)
        .catch(() => false);
      expect(exists).toBe(true);
    });

    it("should assign historySequence to message without metadata", async () => {
      const workspaceId = "workspace1";
      const msg = createMuxMessage("msg1", "user", "Hello");

      const result = await service.appendToHistory(workspaceId, msg);

      expect(result.success).toBe(true);

      const messages = await collectFullHistory(service, workspaceId);
      expect(messages[0].metadata?.historySequence).toBe(0);
    });

    it("should assign sequential historySequence numbers", async () => {
      const workspaceId = "workspace1";
      const msg1 = createMuxMessage("msg1", "user", "Hello");
      const msg2 = createMuxMessage("msg2", "assistant", "Hi");
      const msg3 = createMuxMessage("msg3", "user", "How are you?");

      await service.appendToHistory(workspaceId, msg1);
      await service.appendToHistory(workspaceId, msg2);
      await service.appendToHistory(workspaceId, msg3);

      const messages = await collectFullHistory(service, workspaceId);
      expect(messages).toHaveLength(3);
      expect(messages[0].metadata?.historySequence).toBe(0);
      expect(messages[1].metadata?.historySequence).toBe(1);
      expect(messages[2].metadata?.historySequence).toBe(2);
    });

    it("should preserve existing historySequence if provided", async () => {
      const workspaceId = "workspace1";
      const msg = createMuxMessage("msg1", "user", "Hello", { historySequence: 5 });

      const result = await service.appendToHistory(workspaceId, msg);

      expect(result.success).toBe(true);

      const messages = await collectFullHistory(service, workspaceId);
      expect(messages[0].metadata?.historySequence).toBe(5);
    });

    it("should reject malformed provided historySequence values", async () => {
      const workspaceId = "workspace1";
      const msg = createMuxMessage("msg1", "user", "Hello", { historySequence: 5.5 });

      const result = await service.appendToHistory(workspaceId, msg);

      expect(result.success).toBe(false);
      if (!result.success) {
        expect(result.error).toContain("non-negative integer");
      }
    });

    it("should update sequence counter when message has higher sequence", async () => {
      const workspaceId = "workspace1";
      const msg1 = createMuxMessage("msg1", "user", "Hello", { historySequence: 10 });
      const msg2 = createMuxMessage("msg2", "user", "World");

      await service.appendToHistory(workspaceId, msg1);
      await service.appendToHistory(workspaceId, msg2);

      const messages = await collectFullHistory(service, workspaceId);
      expect(messages[0].metadata?.historySequence).toBe(10);
      expect(messages[1].metadata?.historySequence).toBe(11);
    });

    it("should initialize sequence counter from max historySequence after restart", async () => {
      const workspaceId = "workspace-out-of-order-tail";
      const workspaceDir = path.join(config.sessionsDir, workspaceId);
      await fs.mkdir(workspaceDir, { recursive: true });

      const messages = [
        createMuxMessage("msg-low", "user", "low", { historySequence: 0 }),
        createMuxMessage("msg-high", "assistant", "high", { historySequence: 100 }),
        createMuxMessage("msg-stale-tail", "assistant", "stale", { historySequence: 10 }),
      ];
      const chatPath = path.join(workspaceDir, "chat.jsonl");
      await fs.writeFile(
        chatPath,
        messages.map((msg) => JSON.stringify({ ...msg, workspaceId }) + "\n").join("")
      );

      const restartedService = new HistoryService(config);
      const nextMessage = createMuxMessage("msg-next", "user", "next");
      const appendResult = await restartedService.appendToHistory(workspaceId, nextMessage);

      expect(appendResult.success).toBe(true);
      expect(nextMessage.metadata?.historySequence).toBe(101);
    });

    it("should reject stale provided historySequence after restart", async () => {
      const workspaceId = "workspace-stale-provided-sequence";
      await service.appendToHistory(
        workspaceId,
        createMuxMessage("msg-low", "user", "low", { historySequence: 0 })
      );
      await service.appendToHistory(
        workspaceId,
        createMuxMessage("msg-high", "assistant", "high", { historySequence: 100 })
      );

      const restartedService = new HistoryService(config);
      const staleMessage = createMuxMessage("msg-stale", "assistant", "stale", {
        historySequence: 10,
      });
      const staleResult = await restartedService.appendToHistory(workspaceId, staleMessage);

      expect(staleResult.success).toBe(false);
      if (!staleResult.success) {
        expect(staleResult.error).toContain("stale historySequence 10");
      }

      const nextMessage = createMuxMessage("msg-next", "user", "next");
      const nextResult = await restartedService.appendToHistory(workspaceId, nextMessage);
      expect(nextResult.success).toBe(true);
      expect(nextMessage.metadata?.historySequence).toBe(101);
    });

    it("should preserve other metadata fields", async () => {
      const workspaceId = "workspace1";
      const msg = createMuxMessage("msg1", "user", "Hello", {
        timestamp: 123456,
        model: "claude-opus-4",
        providerMetadata: { test: "data" },
      });

      await service.appendToHistory(workspaceId, msg);

      const messages = await collectFullHistory(service, workspaceId);
      expect(messages[0].metadata?.timestamp).toBe(123456);
      expect(messages[0].metadata?.model).toBe("claude-opus-4");
      expect(messages[0].metadata?.providerMetadata).toEqual({ test: "data" });
      expect(messages[0].metadata?.historySequence).toBeDefined();
    });

    it("should include workspaceId in persisted message", async () => {
      const workspaceId = "workspace1";
      const msg = createMuxMessage("msg1", "user", "Hello");

      await service.appendToHistory(workspaceId, msg);

      const workspaceDir = path.join(config.sessionsDir, workspaceId);
      const chatPath = path.join(workspaceDir, "chat.jsonl");
      const content = await fs.readFile(chatPath, "utf-8");
      const persisted = JSON.parse(content.trim()) as {
        workspaceId: string;
        id: string;
        role: string;
      };

      expect(persisted.workspaceId).toBe(workspaceId);
    });
  });

  describe("appendToHistoryIfTailMatches", () => {
    it("appends when the expected tail is still current", async () => {
      const workspaceId = "workspace1";
      await service.appendToHistory(workspaceId, createMuxMessage("msg1", "user", "Hello"));
      await service.appendToHistory(workspaceId, createMuxMessage("msg2", "assistant", "Hi"));

      const result = await service.appendToHistoryIfTailMatches(
        workspaceId,
        createMuxMessage("msg3", "user", "Guarded"),
        "msg2"
      );

      expect(result.success).toBe(true);
      expect(result.success && result.data).toBe("appended");
      const messages = await collectFullHistory(service, workspaceId);
      expect(messages.map((m) => m.id)).toEqual(["msg1", "msg2", "msg3"]);
      expect(messages[2].metadata?.historySequence).toBe(2);
    });

    it("skips the append when another row landed first", async () => {
      const workspaceId = "workspace1";
      await service.appendToHistory(workspaceId, createMuxMessage("msg1", "user", "Hello"));
      await service.appendToHistory(workspaceId, createMuxMessage("msg2", "assistant", "Hi"));

      const result = await service.appendToHistoryIfTailMatches(
        workspaceId,
        createMuxMessage("msg3", "user", "Guarded"),
        "msg1"
      );

      expect(result.success).toBe(true);
      expect(result.success && result.data).toBe("tail-mismatch");
      const messages = await collectFullHistory(service, workspaceId);
      expect(messages.map((m) => m.id)).toEqual(["msg1", "msg2"]);
    });

    it("skips the append when the workspace has no history", async () => {
      const result = await service.appendToHistoryIfTailMatches(
        "workspace-empty",
        createMuxMessage("msg1", "user", "Guarded"),
        "missing"
      );

      expect(result.success).toBe(true);
      expect(result.success && result.data).toBe("tail-mismatch");
    });
  });

  describe("appendManyToHistory", () => {
    it("terminates a torn crash tail so every batch row survives intact (r50)", async () => {
      const workspaceId = "workspace1";
      const workspaceDir = path.join(config.sessionsDir, workspaceId);
      await fs.mkdir(workspaceDir, { recursive: true });
      // A crash mid-write can leave chat.jsonl ending in an unterminated JSON
      // fragment. Without healing, the first batch row glues onto those bytes
      // and the self-healing reader drops payload+corruption as ONE malformed
      // line while KEEPING the trigger — a durable trigger referencing an
      // absent payload.
      const intact = messageLine(
        workspaceId,
        createMuxMessage("msg1", "user", "Hello", { historySequence: 0 })
      );
      await fs.writeFile(
        path.join(workspaceDir, "chat.jsonl"),
        intact + "\n" + '{"id":"torn-row","role":"assis'
      );

      const result = await service.appendManyToHistory(workspaceId, [
        createMuxMessage("payload-1", "assistant", "family payload"),
        createMuxMessage("trigger-1", "user", "family trigger"),
      ]);
      expect(result.success).toBe(true);

      const messages = await collectFullHistory(service, workspaceId);
      expect(messages.map((m) => m.id)).toEqual(["msg1", "payload-1", "trigger-1"]);
    });

    it("waits on the cross-process append lock before replacing the file (r50)", async () => {
      const workspaceId = "workspace1";
      const seeded = await service.appendToHistory(
        workspaceId,
        createMuxMessage("msg1", "user", "Hello")
      );
      expect(seeded.success).toBe(true);

      // A foreign backend (XUM_ALLOW_MULTIPLE_INSTANCES=1) holds the
      // session-dir append lock: the batch's read+replace must wait, or its
      // replacement — built from contents read before the foreign append —
      // would silently delete the foreign row.
      const foreign = await acquireProcessFileLock({
        // r63: the history write lock lives outside the session directory so
        // removal can hold it across its tombstone+delete critical section.
        lockPath: historyWriteLockPath(config.rootDir, workspaceId),
        timeoutMs: 5_000,
        label: "test foreign backend",
      });
      const batch = service.appendManyToHistory(workspaceId, [
        createMuxMessage("payload-1", "assistant", "family payload"),
        createMuxMessage("trigger-1", "user", "family trigger"),
      ]);
      const sentinel = Symbol("still-pending");
      expect(
        await Promise.race([
          batch,
          new Promise((resolve) => setTimeout(() => resolve(sentinel), 250)),
        ])
      ).toBe(sentinel);

      await foreign[Symbol.asyncDispose]();
      const result = await batch;
      expect(result.success).toBe(true);
      const messages = await collectFullHistory(service, workspaceId);
      expect(messages.map((m) => m.id)).toEqual(["msg1", "payload-1", "trigger-1"]);
    });

    it("refuses partial writes for a removed workspace without recreating its session dir (r66)", async () => {
      // A foreign backend's active stream keeps flushing partials after the
      // remover's process-local cancellation; the flush's ensurePrivateDir
      // must not resurrect the deleted session directory.
      const workspaceId = "removed-partial-workspace";
      const tombstonePath = workspaceRemovalTombstonePath(config.rootDir, workspaceId);
      await fs.mkdir(path.dirname(tombstonePath), { recursive: true });
      await fs.writeFile(tombstonePath, JSON.stringify({ workspaceId, removedAt: Date.now() }));

      const result = await service.writePartial(
        workspaceId,
        createMuxMessage("late-partial", "assistant", "must not land")
      );
      expect(result.success).toBe(false);
      if (!result.success) expect(result.error).toContain("was removed");
      const sessionDirExists = await fs.stat(path.join(config.sessionsDir, workspaceId)).then(
        () => true,
        () => false
      );
      expect(sessionDirExists).toBe(false);
    });

    it("read-path truncation recovery waits on the cross-process lock (r64)", async () => {
      const workspaceId = "workspace1";
      const seeded = await service.appendToHistory(
        workspaceId,
        createMuxMessage("msg1", "user", "Hello")
      );
      expect(seeded.success).toBe(true);

      // Simulate another backend's IN-FLIGHT truncation: the marker and the
      // archive tombstone exist while it holds the write lock. An unlocked
      // read-path recovery cannot tell this from a crash and would roll the
      // live transaction back mid-flight — restoring the old archive between
      // the foreign writer's archive and chat writes, so discarded history
      // reappears with mismatched archive/chat state.
      const sessionDir = path.join(config.sessionsDir, workspaceId);
      const archivePath = path.join(sessionDir, "chat-archive.jsonl");
      const tombstonePath = `${archivePath}.truncate`;
      const markerPath = `${archivePath}.truncate.json`;
      const oldArchiveRow = `${JSON.stringify({ id: "old-archive-row" })}\n`;
      await fs.writeFile(tombstonePath, oldArchiveRow);
      await fs.writeFile(
        markerPath,
        JSON.stringify({ finalArchiveHash: "in-flight", finalChatHash: "in-flight" })
      );

      const foreign = await acquireProcessFileLock({
        lockPath: historyWriteLockPath(config.rootDir, workspaceId),
        timeoutMs: 5_000,
        label: "test foreign truncation",
      });
      const read = service.iterateFullHistory(workspaceId, "forward", () => undefined);
      const sentinel = Symbol("still-pending");
      expect(
        await Promise.race([
          read,
          new Promise((resolve) => setTimeout(() => resolve(sentinel), 250)),
        ])
      ).toBe(sentinel);
      // The live transaction's artifacts were not rolled back while the
      // foreign lock was held.
      const exists = (p: string) =>
        fs.stat(p).then(
          () => true,
          () => false
        );
      expect(await exists(markerPath)).toBe(true);
      expect(await exists(tombstonePath)).toBe(true);

      await foreign[Symbol.asyncDispose]();
      const result = await read;
      expect(result.success).toBe(true);
      // Once the lock was released, recovery ran under it: rollback restored
      // the archive from the tombstone and consumed the marker.
      expect(await exists(markerPath)).toBe(false);
      expect(await exists(tombstonePath)).toBe(false);
      expect(await fs.readFile(archivePath, "utf8")).toBe(oldArchiveRow);
    });

    it("refuses history mutations for a removed workspace without recreating its session dir (r63)", async () => {
      // A foreign backend's in-flight stream survives the remover's
      // process-local cancellation; once removal's tombstone is durable, a
      // late append must fail instead of recreating the deleted session
      // directory via ensurePrivateDir.
      const workspaceId = "removed-history-workspace";
      const tombstonePath = workspaceRemovalTombstonePath(config.rootDir, workspaceId);
      await fs.mkdir(path.dirname(tombstonePath), { recursive: true });
      await fs.writeFile(tombstonePath, JSON.stringify({ workspaceId, removedAt: Date.now() }));

      const result = await service.appendToHistory(
        workspaceId,
        createMuxMessage("late-append", "assistant", "must not land")
      );
      expect(result.success).toBe(false);
      if (!result.success) expect(result.error).toContain("removed");
      expect(
        await fs.access(path.join(config.sessionsDir, workspaceId)).then(
          () => true,
          () => false
        )
      ).toBe(false);
    });

    it("advances the sequence counter past foreign rows under the write lock (r51)", async () => {
      const workspaceId = "workspace1";
      // Cache a counter in this instance (msg1 takes sequence 0, counter -> 1).
      const seeded = await service.appendToHistory(
        workspaceId,
        createMuxMessage("msg1", "user", "Hello")
      );
      expect(seeded.success).toBe(true);
      // A foreign backend (XUM_ALLOW_MULTIPLE_INSTANCES=1) appends a row with
      // a higher sequence from its own counter.
      const foreignLine = messageLine(
        workspaceId,
        createMuxMessage("foreign-1", "assistant", "foreign row", { historySequence: 7 })
      );
      await fs.appendFile(
        path.join(config.sessionsDir, workspaceId, "chat.jsonl"),
        foreignLine + "\n"
      );
      // Without the in-lock counter refresh this batch would assign stale
      // sequences from the cached counter; updateHistory replaces the FIRST
      // row matching a sequence, so a duplicate would let a later stream
      // finalization overwrite an unrelated foreign row.
      const result = await service.appendManyToHistory(workspaceId, [
        createMuxMessage("payload-1", "assistant", "family payload"),
        createMuxMessage("trigger-1", "user", "family trigger"),
      ]);
      expect(result.success).toBe(true);
      const messages = await collectFullHistory(service, workspaceId);
      const seqById = new Map(messages.map((m) => [m.id, m.metadata?.historySequence]));
      expect(seqById.get("payload-1")).toBe(8);
      expect(seqById.get("trigger-1")).toBe(9);
    });
  });

  describe("persistBoundaryWithTailCopies", () => {
    it("advances the sequence counter past foreign rows before assigning tail copies (r52)", async () => {
      const workspaceId = "workspace1";
      const seeded = await service.appendToHistory(
        workspaceId,
        createMuxMessage("msg1", "user", "Hello")
      );
      expect(seeded.success).toBe(true);
      // A foreign backend appended a higher-sequence row after this process
      // cached its counter; the boundary path assigns fresh sequences to the
      // summary and every tail copy, so it needs the same in-lock refresh as
      // the append family.
      const foreignLine = messageLine(
        workspaceId,
        createMuxMessage("foreign-1", "assistant", "foreign row", { historySequence: 7 })
      );
      await fs.appendFile(
        path.join(config.sessionsDir, workspaceId, "chat.jsonl"),
        foreignLine + "\n"
      );

      const summary = createMuxMessage("summary-1", "assistant", "compaction summary");
      const tailCopy = createMuxMessage("tail-1", "user", "preserved tail");
      const result = await service.persistBoundaryWithTailCopies(
        workspaceId,
        summary,
        [tailCopy],
        false
      );
      expect(result.success).toBe(true);
      expect(summary.metadata?.historySequence).toBe(8);
      expect(tailCopy.metadata?.historySequence).toBe(9);
    });
  });

  describe("updateHistory", () => {
    it("should update message by historySequence", async () => {
      const workspaceId = "workspace1";
      const msg1 = createMuxMessage("msg1", "user", "Hello");
      const msg2 = createMuxMessage("msg2", "assistant", "Hi");

      await service.appendToHistory(workspaceId, msg1);
      await service.appendToHistory(workspaceId, msg2);

      const messages = await collectFullHistory(service, workspaceId);
      const updatedMsg = createMuxMessage("msg1", "user", "Updated Hello", {
        historySequence: messages[0].metadata?.historySequence,
      });

      const result = await service.updateHistory(workspaceId, updatedMsg);
      expect(result.success).toBe(true);

      const newMessages = await collectFullHistory(service, workspaceId);
      expect(newMessages[0].parts[0]).toMatchObject({
        type: "text",
        text: "Updated Hello",
      });
      expect(newMessages[0].metadata?.historySequence).toBe(0);
    });

    it("should return error if message has no historySequence", async () => {
      const workspaceId = "workspace1";
      const msg = createMuxMessage("msg1", "user", "Hello");

      const result = await service.updateHistory(workspaceId, msg);

      expect(result.success).toBe(false);
      if (!result.success) {
        expect(result.error).toContain("without historySequence");
      }
    });

    it("should return error if message with historySequence not found", async () => {
      const workspaceId = "workspace1";
      const msg1 = createMuxMessage("msg1", "user", "Hello");

      await service.appendToHistory(workspaceId, msg1);

      const msg2 = createMuxMessage("msg2", "user", "Not found", { historySequence: 99 });
      const result = await service.updateHistory(workspaceId, msg2);

      expect(result.success).toBe(false);
      if (!result.success) {
        expect(result.error).toContain("No message found");
      }
    });

    it("should preserve historySequence when updating", async () => {
      const workspaceId = "workspace1";
      const msg = createMuxMessage("msg1", "user", "Hello");

      await service.appendToHistory(workspaceId, msg);

      const messages = await collectFullHistory(service, workspaceId);
      const originalSequence = messages[0].metadata?.historySequence;
      const updatedMsg = createMuxMessage("msg1", "user", "Updated", {
        historySequence: originalSequence,
      });

      await service.updateHistory(workspaceId, updatedMsg);

      const newMessages = await collectFullHistory(service, workspaceId);
      expect(newMessages[0].metadata?.historySequence).toBe(originalSequence);
    });

    it("preserves durable compaction metadata across late in-place rewrites", async () => {
      const workspaceId = "workspace1";
      const placeholder = createMuxMessage("summary-msg", "assistant", "", {
        model: "openai:gpt-5",
      });

      await service.appendToHistory(workspaceId, placeholder);

      const messagesAfterAppend = await collectFullHistory(service, workspaceId);

      const sequence = messagesAfterAppend[0]?.metadata?.historySequence;
      expect(typeof sequence).toBe("number");
      if (typeof sequence !== "number") {
        return;
      }

      // Simulate compaction finishing first and upgrading the streamed placeholder in place.
      const compactionSummary = createMuxMessage("summary-msg", "assistant", "Compacted summary", {
        historySequence: sequence,
        compacted: "user",
        compactionBoundary: true,
        compactionEpoch: 1,
        muxMetadata: { type: "compaction-summary" },
      });
      const compactionUpdateResult = await service.updateHistory(workspaceId, compactionSummary);
      expect(compactionUpdateResult.success).toBe(true);

      // Simulate a late stream rewrite (e.g., simulateToolPolicyNoop path) that omits
      // compaction metadata. The durable boundary markers must survive this rewrite.
      const lateRewrite = createMuxMessage(
        "summary-msg",
        "assistant",
        "Tool execution skipped because the requested tool is disabled by policy.",
        {
          historySequence: sequence,
          model: "openai:gpt-5",
        }
      );
      const lateRewriteResult = await service.updateHistory(workspaceId, lateRewrite);
      expect(lateRewriteResult.success).toBe(true);

      const finalMessages = await collectFullHistory(service, workspaceId);
      expect(finalMessages).toHaveLength(1);
      const finalMessage = finalMessages[0];
      expect(finalMessage.parts[0]).toMatchObject({
        type: "text",
        text: "Tool execution skipped because the requested tool is disabled by policy.",
      });
      expect(finalMessage.metadata?.compacted).toBe("user");
      expect(finalMessage.metadata?.compactionBoundary).toBe(true);
      expect(finalMessage.metadata?.compactionEpoch).toBe(1);
      expect(finalMessage.metadata?.muxMetadata).toEqual({ type: "compaction-summary" });
    });

    it("self-heals by not preserving malformed compaction boundary metadata", async () => {
      const workspaceId = "workspace1";
      const placeholder = createMuxMessage("summary-msg", "assistant", "", {
        model: "openai:gpt-5",
      });

      await service.appendToHistory(workspaceId, placeholder);

      const messagesAfterAppend = await collectFullHistory(service, workspaceId);

      const sequence = messagesAfterAppend[0]?.metadata?.historySequence;
      expect(typeof sequence).toBe("number");
      if (typeof sequence !== "number") {
        return;
      }

      // Simulate malformed persisted boundary metadata (invalid epoch).
      const malformedCompactionSummary = createMuxMessage(
        "summary-msg",
        "assistant",
        "Compacted summary",
        {
          historySequence: sequence,
          compacted: "user",
          compactionBoundary: true,
          compactionEpoch: 0,
        }
      );
      const malformedUpdateResult = await service.updateHistory(
        workspaceId,
        malformedCompactionSummary
      );
      expect(malformedUpdateResult.success).toBe(true);

      const lateRewrite = createMuxMessage("summary-msg", "assistant", "Late rewrite", {
        historySequence: sequence,
        model: "openai:gpt-5",
      });
      const lateRewriteResult = await service.updateHistory(workspaceId, lateRewrite);
      expect(lateRewriteResult.success).toBe(true);

      const finalMessages = await collectFullHistory(service, workspaceId);
      const finalMessage = finalMessages[0];
      expect(finalMessage.metadata?.compactionBoundary).toBeUndefined();
      expect(finalMessage.metadata?.compactionEpoch).toBeUndefined();
    });

    it("self-heals by not preserving malformed compacted markers in compaction boundaries", async () => {
      const workspaceId = "workspace1";
      const placeholder = createMuxMessage("summary-msg", "assistant", "", {
        model: "openai:gpt-5",
      });

      await service.appendToHistory(workspaceId, placeholder);

      const messagesAfterAppend = await collectFullHistory(service, workspaceId);

      const sequence = messagesAfterAppend[0]?.metadata?.historySequence;
      expect(typeof sequence).toBe("number");
      if (typeof sequence !== "number") {
        return;
      }

      const malformedCompactionSummary = createMuxMessage(
        "summary-msg",
        "assistant",
        "Compacted summary",
        {
          historySequence: sequence,
          compactionBoundary: true,
          compactionEpoch: 1,
        }
      );
      if (malformedCompactionSummary.metadata) {
        (malformedCompactionSummary.metadata as Record<string, unknown>).compacted = "corrupt";
      }

      const malformedUpdateResult = await service.updateHistory(
        workspaceId,
        malformedCompactionSummary
      );
      expect(malformedUpdateResult.success).toBe(true);

      const lateRewrite = createMuxMessage("summary-msg", "assistant", "Late rewrite", {
        historySequence: sequence,
        model: "openai:gpt-5",
      });
      const lateRewriteResult = await service.updateHistory(workspaceId, lateRewrite);
      expect(lateRewriteResult.success).toBe(true);

      const finalMessages = await collectFullHistory(service, workspaceId);
      const finalMessage = finalMessages[0];
      expect(finalMessage.metadata?.compacted).toBeUndefined();
      expect(finalMessage.metadata?.compactionBoundary).toBeUndefined();
      expect(finalMessage.metadata?.compactionEpoch).toBeUndefined();
    });
  });

  describe("deleteMessage", () => {
    it("should remove only the targeted message and preserve subsequent messages", async () => {
      const workspaceId = "workspace1";
      const msg1 = createMuxMessage("msg1", "user", "First");
      const msg2 = createMuxMessage("msg2", "assistant", "Second");
      const msg3 = createMuxMessage("msg3", "user", "Third");

      await service.appendToHistory(workspaceId, msg1);
      await service.appendToHistory(workspaceId, msg2);
      await service.appendToHistory(workspaceId, msg3);

      const result = await service.deleteMessage(workspaceId, "msg2");
      expect(result.success).toBe(true);

      const messages = await collectFullHistory(service, workspaceId);
      expect(messages).toHaveLength(2);
      expect(messages.map((message) => message.id)).toEqual(["msg1", "msg3"]);

      const msg4 = createMuxMessage("msg4", "assistant", "Fourth");
      await service.appendToHistory(workspaceId, msg4);

      const messagesAfterAppend = await collectFullHistory(service, workspaceId);
      const msg3Seq = messagesAfterAppend.find((message) => message.id === "msg3")?.metadata
        ?.historySequence;
      const msg4Seq = messagesAfterAppend.find((message) => message.id === "msg4")?.metadata
        ?.historySequence;

      expect(msg3Seq).toBeDefined();
      expect(msg4Seq).toBeDefined();
      expect(msg4Seq).toBeGreaterThan(msg3Seq ?? -1);
    });

    it("should return error if message not found", async () => {
      const workspaceId = "workspace1";
      const msg = createMuxMessage("msg1", "user", "Hello");

      await service.appendToHistory(workspaceId, msg);

      const result = await service.deleteMessage(workspaceId, "nonexistent");

      expect(result.success).toBe(false);
      if (!result.success) {
        expect(result.error).toContain("not found");
      }
    });
  });

  describe("deleteMessages", () => {
    it("atomically removes only targeted rows and preserves later concurrent rows", async () => {
      const workspaceId = "workspace-delete-messages";
      await service.appendToHistory(workspaceId, createMuxMessage("before", "assistant", "Before"));
      await service.appendToHistory(
        workspaceId,
        createMuxMessage("wake-snapshot", "user", "Snapshot")
      );
      await service.appendToHistory(workspaceId, createMuxMessage("wake", "user", "Wake"));
      await service.appendToHistory(
        workspaceId,
        createMuxMessage("pause-boundary", "user", "Goal paused")
      );

      const result = await service.deleteMessages(workspaceId, ["wake-snapshot", "wake"]);
      expect(result.success).toBe(true);

      const messages = await collectFullHistory(service, workspaceId);
      expect(messages.map((message) => message.id)).toEqual(["before", "pause-boundary"]);
    });

    it("does not rewrite history when any target is missing", async () => {
      const workspaceId = "workspace-delete-messages-missing";
      await service.appendToHistory(workspaceId, createMuxMessage("wake", "user", "Wake"));
      await service.appendToHistory(workspaceId, createMuxMessage("later", "user", "Later"));

      const result = await service.deleteMessages(workspaceId, ["wake", "missing"]);
      expect(result.success).toBe(false);

      const messages = await collectFullHistory(service, workspaceId);
      expect(messages.map((message) => message.id)).toEqual(["wake", "later"]);
    });
  });

  describe("truncateAfterMessage", () => {
    it("should remove message and all subsequent messages", async () => {
      const workspaceId = "workspace1";
      const msg1 = createMuxMessage("msg1", "user", "First");
      const msg2 = createMuxMessage("msg2", "assistant", "Second");
      const msg3 = createMuxMessage("msg3", "user", "Third");
      const msg4 = createMuxMessage("msg4", "assistant", "Fourth");

      await service.appendToHistory(workspaceId, msg1);
      await service.appendToHistory(workspaceId, msg2);
      await service.appendToHistory(workspaceId, msg3);
      await service.appendToHistory(workspaceId, msg4);

      const result = await service.truncateAfterMessage(workspaceId, "msg2");

      expect(result.success).toBe(true);

      const messages = await collectFullHistory(service, workspaceId);
      expect(messages).toHaveLength(1);
      expect(messages[0].id).toBe("msg1");
    });

    it("should update sequence counter after truncation", async () => {
      const workspaceId = "workspace1";
      const msg1 = createMuxMessage("msg1", "user", "First");
      const msg2 = createMuxMessage("msg2", "assistant", "Second");
      const msg3 = createMuxMessage("msg3", "user", "Third");

      await service.appendToHistory(workspaceId, msg1);
      await service.appendToHistory(workspaceId, msg2);
      await service.appendToHistory(workspaceId, msg3);

      await service.truncateAfterMessage(workspaceId, "msg2");

      // Append a new message and check its sequence
      const msg4 = createMuxMessage("msg4", "user", "New message");
      await service.appendToHistory(workspaceId, msg4);

      const messages = await collectFullHistory(service, workspaceId);
      expect(messages).toHaveLength(2);
      expect(messages[0].metadata?.historySequence).toBe(0);
      expect(messages[1].metadata?.historySequence).toBe(1);
    });

    it("should reset sequence counter when truncating all messages", async () => {
      const workspaceId = "workspace1";
      const msg1 = createMuxMessage("msg1", "user", "First");
      const msg2 = createMuxMessage("msg2", "assistant", "Second");

      await service.appendToHistory(workspaceId, msg1);
      await service.appendToHistory(workspaceId, msg2);

      await service.truncateAfterMessage(workspaceId, "msg1");

      const msg3 = createMuxMessage("msg3", "user", "New");
      await service.appendToHistory(workspaceId, msg3);

      const messages = await collectFullHistory(service, workspaceId);
      expect(messages).toHaveLength(1);
      expect(messages[0].metadata?.historySequence).toBe(0);
    });

    it("should return error if message not found", async () => {
      const workspaceId = "workspace1";
      const msg = createMuxMessage("msg1", "user", "Hello");

      await service.appendToHistory(workspaceId, msg);

      const result = await service.truncateAfterMessage(workspaceId, "nonexistent");

      expect(result.success).toBe(false);
      if (!result.success) {
        expect(result.error).toContain("not found");
      }
    });
  });

  describe("truncateAfterMessage keepTargetMessage", () => {
    it("should retain the target message when requested", async () => {
      const workspaceId = "workspace1";
      const msg1 = createMuxMessage("msg1", "user", "First");
      const msg2 = createMuxMessage("msg2", "assistant", "Second");
      const msg3 = createMuxMessage("msg3", "user", "Third");

      await service.appendToHistory(workspaceId, msg1);
      await service.appendToHistory(workspaceId, msg2);
      await service.appendToHistory(workspaceId, msg3);

      const result = await service.truncateAfterMessage(workspaceId, "msg2", {
        keepTargetMessage: true,
      });

      expect(result.success).toBe(true);

      const messages = await collectFullHistory(service, workspaceId);
      expect(messages).toHaveLength(2);
      expect(messages[0].id).toBe("msg1");
      expect(messages[1].id).toBe("msg2");
    });
  });

  describe("clearHistory", () => {
    it("should delete chat.jsonl file", async () => {
      const workspaceId = "workspace1";
      const msg = createMuxMessage("msg1", "user", "Hello");

      await service.appendToHistory(workspaceId, msg);

      const result = await service.clearHistory(workspaceId);

      expect(result.success).toBe(true);

      const workspaceDir = path.join(config.sessionsDir, workspaceId);
      const chatPath = path.join(workspaceDir, "chat.jsonl");
      const exists = await fs
        .access(chatPath)
        .then(() => true)
        .catch(() => false);
      expect(exists).toBe(false);
    });

    it("should reset sequence counter", async () => {
      const workspaceId = "workspace1";
      const msg1 = createMuxMessage("msg1", "user", "Hello");

      await service.appendToHistory(workspaceId, msg1);
      await service.clearHistory(workspaceId);

      const msg2 = createMuxMessage("msg2", "user", "New message");
      await service.appendToHistory(workspaceId, msg2);

      const messages = await collectFullHistory(service, workspaceId);
      expect(messages[0].metadata?.historySequence).toBe(0);
    });

    it("should succeed when clearing non-existent history", async () => {
      const workspaceId = "workspace-no-history";

      const result = await service.clearHistory(workspaceId);

      expect(result.success).toBe(true);
    });

    it("should reset sequence counter even when file doesn't exist", async () => {
      const workspaceId = "workspace-no-history";

      await service.clearHistory(workspaceId);

      const msg = createMuxMessage("msg1", "user", "First");
      await service.appendToHistory(workspaceId, msg);

      const messages = await collectFullHistory(service, workspaceId);
      expect(messages[0].metadata?.historySequence).toBe(0);
    });
  });

  describe("sequence number initialization", () => {
    it("should initialize sequence from existing history", async () => {
      const workspaceId = "workspace1";
      const workspaceDir = path.join(config.sessionsDir, workspaceId);
      await fs.mkdir(workspaceDir, { recursive: true });

      // Manually create history with specific sequences
      const msg1 = createMuxMessage("msg1", "user", "Hello", { historySequence: 0 });
      const msg2 = createMuxMessage("msg2", "assistant", "Hi", { historySequence: 1 });

      const chatPath = path.join(workspaceDir, "chat.jsonl");
      await fs.writeFile(
        chatPath,
        JSON.stringify({ ...msg1, workspaceId }) +
          "\n" +
          JSON.stringify({ ...msg2, workspaceId }) +
          "\n"
      );

      // Create new service instance to ensure fresh initialization
      const newService = new HistoryService(config);

      // Append a new message - should get sequence 2
      const msg3 = createMuxMessage("msg3", "user", "How are you?");
      await newService.appendToHistory(workspaceId, msg3);

      const messages = await collectFullHistory(newService, workspaceId);
      expect(messages).toHaveLength(3);
      expect(messages[2].metadata?.historySequence).toBe(2);
    });

    it("should ignore malformed persisted numeric sequences when initializing counters", async () => {
      const workspaceId = "workspace-with-malformed-sequences";
      const workspaceDir = path.join(config.sessionsDir, workspaceId);
      await fs.mkdir(workspaceDir, { recursive: true });

      const validMessage = createMuxMessage("msg-valid", "user", "Hello", { historySequence: 3 });
      const malformedMessage = createMuxMessage("msg-malformed", "assistant", "Hi", {
        historySequence: 42,
      });
      if (malformedMessage.metadata) {
        (malformedMessage.metadata as Record<string, unknown>).historySequence = 99.5;
      }

      const chatPath = path.join(workspaceDir, "chat.jsonl");
      await fs.writeFile(
        chatPath,
        JSON.stringify({ ...validMessage, workspaceId }) +
          "\n" +
          JSON.stringify({ ...malformedMessage, workspaceId }) +
          "\n"
      );

      const newService = new HistoryService(config);
      const msg3 = createMuxMessage("msg3", "user", "How are you?");
      const appendResult = await newService.appendToHistory(workspaceId, msg3);
      expect(appendResult.success).toBe(true);

      const messages = await collectFullHistory(newService, workspaceId);
      expect(messages).toHaveLength(3);
      const appended = messages.find((msg) => msg.id === "msg3");
      expect(appended?.metadata?.historySequence).toBe(4);
    });

    it("should start from 0 for new workspace", async () => {
      const workspaceId = "new-workspace";
      const msg = createMuxMessage("msg1", "user", "First message");

      await service.appendToHistory(workspaceId, msg);

      const messages = await collectFullHistory(service, workspaceId);
      expect(messages[0].metadata?.historySequence).toBe(0);
    });
  });

  // ── Optimized read path tests ──────────────────────────────────────────────

  /**
   * Helper: write a chat.jsonl file with messages that include a compaction boundary.
   * Returns { preBoundaryIds, boundaryId, postBoundaryIds }.
   */
  async function writeChatWithBoundary(
    cfg: Config,
    workspaceId: string,
    opts: { preBoundaryCount: number; postBoundaryCount: number; epoch?: number }
  ) {
    const workspaceDir = path.join(cfg.sessionsDir, workspaceId);
    await fs.mkdir(workspaceDir, { recursive: true });

    const epoch = opts.epoch ?? 1;
    const lines: string[] = [];
    const preBoundaryIds: string[] = [];
    const postBoundaryIds: string[] = [];
    let seq = 0;

    // Pre-boundary messages
    for (let i = 0; i < opts.preBoundaryCount; i++) {
      const id = `pre-${i}`;
      preBoundaryIds.push(id);
      lines.push(
        JSON.stringify({
          ...createMuxMessage(id, "user", `message ${i}`, { historySequence: seq++ }),
          workspaceId,
        })
      );
    }

    // Compaction boundary message
    const boundaryId = `boundary-${epoch}`;
    lines.push(
      JSON.stringify({
        ...createMuxMessage(boundaryId, "assistant", "Compaction summary", {
          historySequence: seq++,
          compactionBoundary: true,
          compacted: "user",
          compactionEpoch: epoch,
        }),
        workspaceId,
      })
    );

    // Post-boundary messages
    for (let i = 0; i < opts.postBoundaryCount; i++) {
      const id = `post-${i}`;
      postBoundaryIds.push(id);
      lines.push(
        JSON.stringify({
          ...createMuxMessage(id, "user", `post message ${i}`, { historySequence: seq++ }),
          workspaceId,
        })
      );
    }

    await fs.writeFile(path.join(workspaceDir, "chat.jsonl"), lines.join("\n") + "\n");
    return { preBoundaryIds, boundaryId, postBoundaryIds };
  }

  describe("getHistoryFromLatestBoundary", () => {
    it("should return full history when no boundary exists", async () => {
      const workspaceId = "ws-no-boundary";
      const workspaceDir = path.join(config.sessionsDir, workspaceId);
      await fs.mkdir(workspaceDir, { recursive: true });

      const msg1 = createMuxMessage("msg1", "user", "Hello", { historySequence: 0 });
      const msg2 = createMuxMessage("msg2", "assistant", "Hi", { historySequence: 1 });
      await fs.writeFile(
        path.join(workspaceDir, "chat.jsonl"),
        JSON.stringify({ ...msg1, workspaceId }) +
          "\n" +
          JSON.stringify({ ...msg2, workspaceId }) +
          "\n"
      );

      const result = await service.getHistoryFromLatestBoundary(workspaceId);
      expect(result.success).toBe(true);
      if (result.success) {
        expect(result.data).toHaveLength(2);
        expect(result.data[0].id).toBe("msg1");
        expect(result.data[1].id).toBe("msg2");
      }
    });

    it("should return empty array when no history exists", async () => {
      const result = await service.getHistoryFromLatestBoundary("nonexistent");
      expect(result.success).toBe(true);
      if (result.success) {
        expect(result.data).toEqual([]);
      }
    });

    it("should return only messages from the latest boundary onward", async () => {
      const workspaceId = "ws-with-boundary";
      const { boundaryId, postBoundaryIds } = await writeChatWithBoundary(config, workspaceId, {
        preBoundaryCount: 5,
        postBoundaryCount: 3,
      });

      const result = await service.getHistoryFromLatestBoundary(workspaceId);
      expect(result.success).toBe(true);
      if (result.success) {
        // Should include boundary + post-boundary messages
        expect(result.data).toHaveLength(4); // 1 boundary + 3 post
        expect(result.data[0].id).toBe(boundaryId);
        for (let i = 0; i < postBoundaryIds.length; i++) {
          expect(result.data[i + 1].id).toBe(postBoundaryIds[i]);
        }
      }
    });

    it("should find the latest boundary with multiple compaction epochs", async () => {
      const workspaceId = "ws-multi-epoch";
      const workspaceDir = path.join(config.sessionsDir, workspaceId);
      await fs.mkdir(workspaceDir, { recursive: true });

      const lines: string[] = [];
      let seq = 0;

      // Epoch 1 messages + boundary
      lines.push(
        JSON.stringify({
          ...createMuxMessage("e1-user", "user", "msg", { historySequence: seq++ }),
          workspaceId,
        })
      );
      lines.push(
        JSON.stringify({
          ...createMuxMessage("e1-boundary", "assistant", "Summary 1", {
            historySequence: seq++,
            compactionBoundary: true,
            compacted: "user",
            compactionEpoch: 1,
          }),
          workspaceId,
        })
      );

      // Epoch 2 messages + boundary
      lines.push(
        JSON.stringify({
          ...createMuxMessage("e2-user", "user", "msg", { historySequence: seq++ }),
          workspaceId,
        })
      );
      lines.push(
        JSON.stringify({
          ...createMuxMessage("e2-boundary", "assistant", "Summary 2", {
            historySequence: seq++,
            compactionBoundary: true,
            compacted: "idle",
            compactionEpoch: 2,
          }),
          workspaceId,
        })
      );

      // Post-epoch-2 message
      lines.push(
        JSON.stringify({
          ...createMuxMessage("post-e2", "user", "after both", { historySequence: seq++ }),
          workspaceId,
        })
      );

      await fs.writeFile(path.join(workspaceDir, "chat.jsonl"), lines.join("\n") + "\n");

      // Default skip=0: reads from the latest boundary
      const result = await service.getHistoryFromLatestBoundary(workspaceId);
      expect(result.success).toBe(true);
      if (result.success) {
        expect(result.data).toHaveLength(2); // epoch-2 boundary + post message
        expect(result.data[0].id).toBe("e2-boundary");
        expect(result.data[1].id).toBe("post-e2");
      }

      // skip=1: reads from the penultimate boundary
      const penultimate = await service.getHistoryFromLatestBoundary(workspaceId, 1);
      expect(penultimate.success).toBe(true);
      if (penultimate.success) {
        expect(penultimate.data).toHaveLength(4);
        expect(penultimate.data[0].id).toBe("e1-boundary");
        expect(penultimate.data[1].id).toBe("e2-user");
        expect(penultimate.data[2].id).toBe("e2-boundary");
        expect(penultimate.data[3].id).toBe("post-e2");
      }
    });

    it("should skip malformed lines in boundary region", async () => {
      const workspaceId = "ws-malformed";
      const workspaceDir = path.join(config.sessionsDir, workspaceId);
      await fs.mkdir(workspaceDir, { recursive: true });

      const boundary = createMuxMessage("boundary", "assistant", "Summary", {
        historySequence: 0,
        compactionBoundary: true,
        compacted: "user",
        compactionEpoch: 1,
      });
      const post = createMuxMessage("post", "user", "after", { historySequence: 1 });

      await fs.writeFile(
        path.join(workspaceDir, "chat.jsonl"),
        JSON.stringify({ ...boundary, workspaceId }) +
          "\n" +
          "MALFORMED LINE\n" +
          JSON.stringify({ ...post, workspaceId }) +
          "\n"
      );

      const result = await service.getHistoryFromLatestBoundary(workspaceId);
      expect(result.success).toBe(true);
      if (result.success) {
        expect(result.data).toHaveLength(2); // boundary + post (malformed skipped)
        expect(result.data[0].id).toBe("boundary");
        expect(result.data[1].id).toBe("post");
      }
    });
  });

  describe("getHistoryBoundaryWindow", () => {
    it("returns one older boundary window at a time and reports hasOlder", async () => {
      const workspaceId = "ws-boundary-window";
      const workspaceDir = path.join(config.sessionsDir, workspaceId);
      await fs.mkdir(workspaceDir, { recursive: true });

      const lines: string[] = [];
      let seq = 0;

      lines.push(
        JSON.stringify({
          ...createMuxMessage("e1-user", "user", "epoch 1 user", { historySequence: seq++ }),
          workspaceId,
        })
      );
      lines.push(
        JSON.stringify({
          ...createMuxMessage("e1-boundary", "assistant", "summary 1", {
            historySequence: seq++,
            compactionBoundary: true,
            compacted: "user",
            compactionEpoch: 1,
          }),
          workspaceId,
        })
      );
      lines.push(
        JSON.stringify({
          ...createMuxMessage("e2-user", "user", "epoch 2 user", { historySequence: seq++ }),
          workspaceId,
        })
      );
      lines.push(
        JSON.stringify({
          ...createMuxMessage("e2-boundary", "assistant", "summary 2", {
            historySequence: seq++,
            compactionBoundary: true,
            compacted: "idle",
            compactionEpoch: 2,
          }),
          workspaceId,
        })
      );
      lines.push(
        JSON.stringify({
          ...createMuxMessage("post-e2", "user", "latest message", { historySequence: seq++ }),
          workspaceId,
        })
      );

      await fs.writeFile(path.join(workspaceDir, "chat.jsonl"), lines.join("\n") + "\n");

      const firstWindow = await service.getHistoryBoundaryWindow(workspaceId, 3);
      expect(firstWindow.success).toBe(true);
      if (firstWindow.success) {
        expect(firstWindow.data.messages.map((message) => message.id)).toEqual([
          "e1-boundary",
          "e2-user",
        ]);
        expect(firstWindow.data.hasOlder).toBe(true);
      }

      const secondWindow = await service.getHistoryBoundaryWindow(workspaceId, 1);
      expect(secondWindow.success).toBe(true);
      if (secondWindow.success) {
        expect(secondWindow.data.messages.map((message) => message.id)).toEqual(["e1-user"]);
        expect(secondWindow.data.hasOlder).toBe(false);
      }
    });
  });

  describe("getMessagesForCompactionEpoch", () => {
    it("returns evidence rows between the previous boundary and the new summary", async () => {
      const workspaceId = "ws-compaction-epoch";
      const workspaceDir = path.join(config.sessionsDir, workspaceId);
      await fs.mkdir(workspaceDir, { recursive: true });

      const lines = [
        messageLine(
          workspaceId,
          createMuxMessage("old-boundary", "assistant", "old summary", {
            historySequence: 0,
            compactionBoundary: true,
            compacted: "user",
            compactionEpoch: 1,
          })
        ),
        messageLine(
          workspaceId,
          createMuxMessage("kept-user", "user", "durable preference", { historySequence: 1 })
        ),
        messageLine(
          workspaceId,
          createMuxMessage("compact-request", "user", "Please compact", {
            historySequence: 2,
            muxMetadata: { type: "compaction-request", rawCommand: "/compact", parsed: {} },
          })
        ),
        messageLine(
          workspaceId,
          createMuxMessage("new-summary", "assistant", "new summary", {
            historySequence: 3,
            compactionBoundary: true,
            compacted: "user",
            compactionEpoch: 2,
          })
        ),
      ];
      await fs.writeFile(path.join(workspaceDir, "chat.jsonl"), lines.join("\n") + "\n");

      const result = await service.getMessagesForCompactionEpoch(workspaceId, {
        workspaceId,
        summaryMessageId: "new-summary",
        summaryHistorySequence: 3,
        compactionEpoch: 2,
        previousBoundaryHistorySequence: 0,
        compactionRequestMessageId: "compact-request",
      });

      expect(result.success).toBe(true);
      if (result.success) {
        expect(result.data.messages.map((message) => message.id)).toEqual(["kept-user"]);
        expect(result.data.summary.id).toBe("new-summary");
      }
    });

    it("deduplicates rotation replay rows across archive and active history", async () => {
      const workspaceId = "ws-compaction-epoch-rotation-replay";
      const workspaceDir = path.join(config.sessionsDir, workspaceId);
      await fs.mkdir(workspaceDir, { recursive: true });

      const replayedPrefix = [
        messageLine(
          workspaceId,
          createMuxMessage("old-boundary", "assistant", "old summary", {
            historySequence: 0,
            compactionBoundary: true,
            compacted: "user",
            compactionEpoch: 1,
          })
        ),
        messageLine(
          workspaceId,
          createMuxMessage("kept-user", "user", "durable preference", { historySequence: 1 })
        ),
        messageLine(
          workspaceId,
          createMuxMessage("compact-request", "user", "Please compact", {
            historySequence: 2,
            muxMetadata: { type: "compaction-request", rawCommand: "/compact", parsed: {} },
          })
        ),
      ];
      const summary = messageLine(
        workspaceId,
        createMuxMessage("new-summary", "assistant", "new summary", {
          historySequence: 3,
          compactionBoundary: true,
          compacted: "user",
          compactionEpoch: 2,
        })
      );

      await fs.writeFile(
        path.join(workspaceDir, "chat-archive.jsonl"),
        replayedPrefix.join("\n") + "\n"
      );
      await fs.writeFile(
        path.join(workspaceDir, "chat.jsonl"),
        [...replayedPrefix, summary].join("\n") + "\n"
      );

      const result = await service.getMessagesForCompactionEpoch(workspaceId, {
        workspaceId,
        summaryMessageId: "new-summary",
        summaryHistorySequence: 3,
        compactionEpoch: 2,
        previousBoundaryHistorySequence: 0,
        compactionRequestMessageId: "compact-request",
      });

      expect(result.success).toBe(true);
      if (result.success) {
        expect(result.data.messages.map((message) => message.id)).toEqual(["kept-user"]);
        expect(result.data.summary.id).toBe("new-summary");
      }
    });

    it("holds the workspace lock while scanning archive and active history", async () => {
      const workspaceId = "ws-compaction-epoch-lock";
      await writeHistoryLines(config, workspaceId, [
        messageLine(
          workspaceId,
          createMuxMessage("old-boundary", "assistant", "old summary", {
            historySequence: 0,
            compactionBoundary: true,
            compacted: "user",
            compactionEpoch: 1,
          })
        ),
        messageLine(
          workspaceId,
          createMuxMessage("kept-user", "user", "durable preference", { historySequence: 1 })
        ),
        messageLine(
          workspaceId,
          createMuxMessage("compact-request", "user", "Please compact", {
            historySequence: 2,
            muxMetadata: { type: "compaction-request", rawCommand: "/compact", parsed: {} },
          })
        ),
        messageLine(
          workspaceId,
          createMuxMessage("summary", "assistant", "summary", {
            historySequence: 3,
            compactionBoundary: true,
            compacted: "user",
            compactionEpoch: 2,
          })
        ),
      ]);

      let releaseScan!: () => void;
      const scanReleased = new Promise<void>((resolve) => {
        releaseScan = resolve;
      });
      let markScanStarted!: () => void;
      const scanStarted = new Promise<void>((resolve) => {
        markScanStarted = resolve;
      });
      const internal = service as unknown as {
        iterateFullHistoryUnlocked: HistoryService["iterateFullHistory"];
      };
      const originalIterateFullHistory = internal.iterateFullHistoryUnlocked.bind(service);
      internal.iterateFullHistoryUnlocked = async (workspaceIdArg, direction, visitor) => {
        markScanStarted();
        await scanReleased;
        return originalIterateFullHistory(workspaceIdArg, direction, visitor);
      };

      const scan = service.getMessagesForCompactionEpoch(workspaceId, {
        workspaceId,
        summaryMessageId: "summary",
        summaryHistorySequence: 3,
        compactionEpoch: 2,
        previousBoundaryHistorySequence: 0,
        compactionRequestMessageId: "compact-request",
      });
      await scanStarted;

      interface WorkspaceLockProbe {
        fileLocks: {
          withLock<T>(key: string, operation: () => Promise<T>): Promise<T>;
        };
      }
      const { fileLocks } = service as unknown as WorkspaceLockProbe;
      let probeStarted = false;
      const probe = fileLocks.withLock(workspaceId, () => {
        probeStarted = true;
        return Promise.resolve();
      });
      await Promise.resolve();

      expect(probeStarted).toBe(false);
      releaseScan();

      const result = await scan;
      await probe;

      expect(result.success).toBe(true);
      expect(probeStarted).toBe(true);
    });

    it("uses reset boundaries as lower bounds and excludes the reset marker", async () => {
      const workspaceId = "ws-compaction-reset-epoch";
      await writeHistoryLines(config, workspaceId, [
        messageLine(
          workspaceId,
          createMuxMessage("stale-user", "user", "old preference", { historySequence: 0 })
        ),
        messageLine(
          workspaceId,
          createMuxMessage("reset", "assistant", "Context reset", {
            historySequence: 1,
            contextBoundaryKind: CONTEXT_BOUNDARY_KINDS.RESET,
          })
        ),
        messageLine(
          workspaceId,
          createMuxMessage("kept-user", "user", "new preference", { historySequence: 2 })
        ),
        messageLine(
          workspaceId,
          createMuxMessage("compact-request", "user", "Please compact", {
            historySequence: 3,
            muxMetadata: { type: "compaction-request", rawCommand: "/compact", parsed: {} },
          })
        ),
        messageLine(
          workspaceId,
          createMuxMessage("summary", "assistant", "summary", {
            historySequence: 4,
            compactionBoundary: true,
            compacted: "user",
            compactionEpoch: 1,
          })
        ),
      ]);

      const result = await service.getMessagesForCompactionEpoch(workspaceId, {
        workspaceId,
        summaryMessageId: "summary",
        summaryHistorySequence: 4,
        compactionEpoch: 1,
        previousBoundaryHistorySequence: 1,
        compactionRequestMessageId: "compact-request",
      });

      expect(result.success).toBe(true);
      if (result.success) {
        expect(result.data.messages.map((message) => message.id)).toEqual(["kept-user"]);
      }
    });

    it("does not treat malformed compactionBoundary rows as structural boundaries", async () => {
      const workspaceId = "ws-compaction-malformed-boundary";
      await writeHistoryLines(config, workspaceId, [
        messageLine(
          workspaceId,
          createMuxMessage("valid-boundary", "assistant", "old summary", {
            historySequence: 0,
            compactionBoundary: true,
            compacted: "user",
            compactionEpoch: 1,
          })
        ),
        messageLine(
          workspaceId,
          createMuxMessage("before-malformed", "user", "valid evidence before malformed row", {
            historySequence: 1,
          })
        ),
        messageLine(
          workspaceId,
          createMuxMessage("malformed-boundary", "user", "corrupt boundary-like row", {
            historySequence: 2,
            compactionBoundary: true,
          })
        ),
        messageLine(
          workspaceId,
          createMuxMessage("after-malformed", "user", "valid evidence after malformed row", {
            historySequence: 3,
          })
        ),
        messageLine(
          workspaceId,
          createMuxMessage("compact-request", "user", "Please compact", {
            historySequence: 4,
            muxMetadata: { type: "compaction-request", rawCommand: "/compact", parsed: {} },
          })
        ),
        messageLine(
          workspaceId,
          createMuxMessage("summary", "assistant", "summary", {
            historySequence: 5,
            compactionBoundary: true,
            compacted: "user",
            compactionEpoch: 2,
          })
        ),
      ]);

      const result = await service.getMessagesForCompactionEpoch(workspaceId, {
        workspaceId,
        summaryMessageId: "summary",
        summaryHistorySequence: 5,
        compactionEpoch: 2,
        previousBoundaryHistorySequence: 0,
        compactionRequestMessageId: "compact-request",
      });

      expect(result.success).toBe(true);
      if (result.success) {
        expect(result.data.messages.map((message) => message.id)).toEqual([
          "before-malformed",
          "malformed-boundary",
          "after-malformed",
        ]);
      }
    });
  });

  describe("getLastMessages", () => {
    it("should return empty array when no history exists", async () => {
      const result = await service.getLastMessages("nonexistent", 5);
      expect(result.success).toBe(true);
      if (result.success) {
        expect(result.data).toEqual([]);
      }
    });

    const getLastMessagesCases = [
      {
        name: "should return the last N messages in chronological order",
        workspaceId: "ws-last-n",
        totalMessages: 10,
        requestedCount: 3,
        expectedIds: ["msg-7", "msg-8", "msg-9"],
      },
      {
        name: "should return all messages when N exceeds total count",
        workspaceId: "ws-last-all",
        totalMessages: 3,
        requestedCount: 100,
        expectedIds: ["msg-0", "msg-1", "msg-2"],
      },
      {
        name: "should return exactly 1 message when requested",
        workspaceId: "ws-last-1",
        totalMessages: 5,
        requestedCount: 1,
        expectedIds: ["msg-4"],
      },
    ];

    for (const testCase of getLastMessagesCases) {
      it(testCase.name, async () => {
        await writeHistoryLines(
          config,
          testCase.workspaceId,
          Array.from({ length: testCase.totalMessages }, (_, i) =>
            messageLine(
              testCase.workspaceId,
              createMuxMessage(`msg-${i}`, "user", `message ${i}`, { historySequence: i })
            )
          )
        );

        const result = await service.getLastMessages(testCase.workspaceId, testCase.requestedCount);
        expect(result.success).toBe(true);
        if (result.success) {
          expect(result.data.map((message) => message.id)).toEqual(testCase.expectedIds);
        }
      });
    }

    it("should skip malformed lines", async () => {
      const workspaceId = "ws-last-malformed";
      await writeHistoryLines(config, workspaceId, [
        messageLine(workspaceId, createMuxMessage("msg1", "user", "Hello", { historySequence: 0 })),
        "BAD LINE",
        messageLine(
          workspaceId,
          createMuxMessage("msg2", "assistant", "Hi", { historySequence: 1 })
        ),
      ]);

      const result = await service.getLastMessages(workspaceId, 2);
      expect(result.success).toBe(true);
      if (result.success) {
        expect(result.data.map((message) => message.id)).toEqual(["msg1", "msg2"]);
      }
    });
  });

  describe("multi-byte UTF-8 handling", () => {
    it("should correctly find boundary and read messages with non-ASCII content", async () => {
      const workspaceId = "ws-utf8";
      const workspaceDir = path.join(config.sessionsDir, workspaceId);
      await fs.mkdir(workspaceDir, { recursive: true });

      // Use multi-byte UTF-8 characters (emoji, CJK) in message content
      // to verify byte offset calculations handle non-ASCII correctly.
      const lines: string[] = [];
      let seq = 0;

      // Pre-boundary: message with emoji (4-byte UTF-8 chars)
      lines.push(
        JSON.stringify({
          ...createMuxMessage("emoji-msg", "user", "Hello 🌍🔥💻 world", {
            historySequence: seq++,
          }),
          workspaceId,
        })
      );

      // Boundary with CJK characters (3-byte UTF-8 chars)
      lines.push(
        JSON.stringify({
          ...createMuxMessage("boundary-utf8", "assistant", "要約：会話の概要", {
            historySequence: seq++,
            compactionBoundary: true,
            compacted: "user",
            compactionEpoch: 1,
          }),
          workspaceId,
        })
      );

      // Post-boundary: message with mixed scripts
      lines.push(
        JSON.stringify({
          ...createMuxMessage("post-utf8", "user", "Ñoño café résumé über 日本語", {
            historySequence: seq++,
          }),
          workspaceId,
        })
      );

      await fs.writeFile(path.join(workspaceDir, "chat.jsonl"), lines.join("\n") + "\n");

      // getHistoryFromLatestBoundary should find the boundary correctly
      const boundaryResult = await service.getHistoryFromLatestBoundary(workspaceId);
      expect(boundaryResult.success).toBe(true);
      if (boundaryResult.success) {
        expect(boundaryResult.data).toHaveLength(2); // boundary + post
        expect(boundaryResult.data[0].id).toBe("boundary-utf8");
        expect(boundaryResult.data[1].id).toBe("post-utf8");
      }

      // getLastMessages should also handle multi-byte content correctly
      const lastResult = await service.getLastMessages(workspaceId, 2);
      expect(lastResult.success).toBe(true);
      if (lastResult.success) {
        expect(lastResult.data).toHaveLength(2);
        expect(lastResult.data[0].id).toBe("boundary-utf8");
        expect(lastResult.data[1].id).toBe("post-utf8");
      }
    });

    it("should handle messages where all content is multi-byte", async () => {
      const workspaceId = "ws-utf8-all";
      const workspaceDir = path.join(config.sessionsDir, workspaceId);
      await fs.mkdir(workspaceDir, { recursive: true });

      const lines: string[] = [];
      // Every message uses multi-byte characters exclusively
      for (let i = 0; i < 5; i++) {
        lines.push(
          JSON.stringify({
            ...createMuxMessage(`utf8-${i}`, "user", `メッセージ ${i} 🎯`, {
              historySequence: i,
            }),
            workspaceId,
          })
        );
      }
      await fs.writeFile(path.join(workspaceDir, "chat.jsonl"), lines.join("\n") + "\n");

      const result = await service.getLastMessages(workspaceId, 3);
      expect(result.success).toBe(true);
      if (result.success) {
        expect(result.data).toHaveLength(3);
        expect(result.data[0].id).toBe("utf8-2");
        expect(result.data[1].id).toBe("utf8-3");
        expect(result.data[2].id).toBe("utf8-4");
      }
    });
  });

  describe("hasHistory", () => {
    it("should return false when no history file exists", async () => {
      const result = await service.hasHistory("nonexistent");
      expect(result).toBe(false);
    });

    it("should return false for empty file", async () => {
      const workspaceId = "ws-empty";
      const workspaceDir = path.join(config.sessionsDir, workspaceId);
      await fs.mkdir(workspaceDir, { recursive: true });
      await fs.writeFile(path.join(workspaceDir, "chat.jsonl"), "");

      const result = await service.hasHistory(workspaceId);
      expect(result).toBe(false);
    });

    it("should return true when history exists", async () => {
      const workspaceId = "ws-has-history";
      const workspaceDir = path.join(config.sessionsDir, workspaceId);
      await fs.mkdir(workspaceDir, { recursive: true });

      const msg = createMuxMessage("msg1", "user", "Hello", { historySequence: 0 });
      await fs.writeFile(
        path.join(workspaceDir, "chat.jsonl"),
        JSON.stringify({ ...msg, workspaceId }) + "\n"
      );

      const result = await service.hasHistory(workspaceId);
      expect(result).toBe(true);
    });
  });

  describe("iterateFullHistory", () => {
    const wsId = "workspace1";

    it("should iterate forward in chronological order", async () => {
      await appendNumberedMessages(service, wsId, 5);

      const collected: MuxMessage[] = [];
      const result = await service.iterateFullHistory(wsId, "forward", (chunk) => {
        collected.push(...chunk);
      });
      expect(result.success).toBe(true);
      expect(collected.length).toBe(5);
      expect(collected.map((m) => m.id)).toEqual(["msg-0", "msg-1", "msg-2", "msg-3", "msg-4"]);
    });

    it("should iterate backward with newest first", async () => {
      await appendNumberedMessages(service, wsId, 5);

      const collected: MuxMessage[] = [];
      const result = await service.iterateFullHistory(wsId, "backward", (chunk) => {
        collected.push(...chunk);
      });
      expect(result.success).toBe(true);
      expect(collected.length).toBe(5);
      // Backward: newest first
      expect(collected.map((m) => m.id)).toEqual(["msg-4", "msg-3", "msg-2", "msg-1", "msg-0"]);
    });

    it("should support early exit by returning false", async () => {
      await appendNumberedMessages(service, wsId, 10);

      let found: MuxMessage | undefined;
      await service.iterateFullHistory(wsId, "forward", (chunk) => {
        for (const msg of chunk) {
          if (msg.id === "msg-3") {
            found = msg;
            return false; // stop early
          }
        }
      });
      expect(found).toBeTruthy();
      expect(found!.id).toBe("msg-3");
    });

    it("should support early exit in backward direction", async () => {
      await appendNumberedMessages(service, wsId, 10);

      // Find the first message encountered when reading backward (should be msg-9)
      let firstSeen: MuxMessage | undefined;
      await service.iterateFullHistory(wsId, "backward", (chunk) => {
        firstSeen = chunk[0];
        return false; // stop after first chunk
      });
      expect(firstSeen).toBeTruthy();
      expect(firstSeen!.id).toBe("msg-9");
    });

    it("should return success for empty history", async () => {
      const collected: MuxMessage[] = [];
      const result = await service.iterateFullHistory(wsId, "forward", (chunk) => {
        collected.push(...chunk);
      });
      expect(result.success).toBe(true);
      expect(collected.length).toBe(0);
    });

    it("should skip malformed lines during iteration", async () => {
      await writeHistoryLines(config, wsId, [
        "not valid json",
        messageLine(wsId, createMuxMessage("valid-1", "user", "Valid message")),
        "{malformed",
      ]);

      const collected: MuxMessage[] = [];
      const result = await service.iterateFullHistory(wsId, "forward", (chunk) => {
        collected.push(...chunk);
      });
      expect(result.success).toBe(true);
      expect(collected.length).toBe(1);
      expect(collected[0].id).toBe("valid-1");
    });
  });

  describe("sealed history rotation", () => {
    const wsId = "ws-rotation";

    function boundaryMessage(id: string, epoch: number): MuxMessage {
      return createMuxMessage(id, "assistant", `Summary ${epoch}`, {
        compactionBoundary: true,
        compacted: "user",
        compactionEpoch: epoch,
      });
    }

    async function readJsonlFile(filePath: string): Promise<MuxMessage[]> {
      const data = await fs.readFile(filePath, "utf-8");
      return data
        .split("\n")
        .filter((line) => line.trim())
        .map((line) => JSON.parse(line) as MuxMessage);
    }

    function chatPath(workspaceId: string): string {
      return path.join(config.sessionsDir, workspaceId, "chat.jsonl");
    }

    function archivePath(workspaceId: string): string {
      return path.join(config.sessionsDir, workspaceId, "chat-archive.jsonl");
    }

    function rolloverBatch(): MuxMessage[] {
      return [
        createMuxMessage("rollover", "assistant", "", {
          contextBoundaryKind: "reset",
          synthetic: true,
          muxMetadata: {
            type: "context-window-rollover",
            rolloverId: "rollover-1",
            reason: "on-send",
            previousWindowId: "w:0",
            flushOpportunity: false,
            contextTokens: 1000,
            maxTokens: 1000,
          },
        }),
        createMuxMessage("lead-in", "assistant", "prior context notes", {
          synthetic: true,
          muxMetadata: { type: "context-window-lead-in", rolloverId: "rollover-1" },
        }),
        createMuxMessage("continuation", "user", "Resume the previous task", { synthetic: true }),
      ];
    }

    it("batch publication eagerly seals history even after the lazy rotation check", async () => {
      await appendNumberedMessages(service, wsId, 2);
      expect((await service.getHistoryFromLatestBoundary(wsId)).success).toBe(true);
      const batch = rolloverBatch();
      expect(
        (
          await service.appendManyToHistory(wsId, [
            boundaryMessage("interim-boundary", 1),
            ...batch,
          ])
        ).success
      ).toBe(true);
      expect((await readJsonlFile(chatPath(wsId))).map((message) => message.id)).toEqual(
        batch.map((message) => message.id)
      );
      const archived = await readJsonlFile(archivePath(wsId));
      expect(archived.map((message) => message.id)).toEqual(["msg-0", "msg-1", "interim-boundary"]);
      const latest = await service.getHistoryFromLatestBoundary(wsId);
      assert(latest.success);
      expect(latest.data).toMatchObject(batch);
      const full = await collectFullHistory(service, wsId);
      expect(full.map((message) => message.metadata?.historySequence)).toEqual([0, 1, 2, 3, 4, 5]);
      expect(full.map((message) => message.id)).toEqual([
        "msg-0",
        "msg-1",
        "interim-boundary",
        ...batch.map((message) => message.id),
      ]);
      const archivedBytes = await fs.readFile(archivePath(wsId), "utf8");
      expect(
        (
          await service.updateHistory(wsId, {
            ...batch[1],
            parts: [{ type: "text", text: "updated notes" }],
          })
        ).success
      ).toBe(true);
      expect(await fs.readFile(archivePath(wsId), "utf8")).toBe(archivedBytes);
      expect((await readJsonlFile(chatPath(wsId))).map((message) => message.id)).toEqual(
        batch.map((message) => message.id)
      );
      const updated = await service.getHistoryFromLatestBoundary(wsId);
      assert(updated.success);
      expect(updated.data[1].parts).toEqual([{ type: "text", text: "updated notes" }]);
    });

    it("a post-publication rotation failure does not report a failed or partial batch", async () => {
      await appendNumberedMessages(service, wsId, 2);
      expect((await service.getHistoryFromLatestBoundary(wsId)).success).toBe(true);
      const internals = service as unknown as {
        rotateSealedHistoryUnlocked(workspaceId: string): Promise<void>;
      };
      const rotation = spyOn(internals, "rotateSealedHistoryUnlocked").mockImplementationOnce(() =>
        Promise.reject(new Error("archive storage unavailable"))
      );
      const batch = rolloverBatch();
      try {
        expect((await service.appendManyToHistory(wsId, batch)).success).toBe(true);
        expect(rotation).toHaveBeenCalledTimes(1);
        expect((await readJsonlFile(chatPath(wsId))).map((message) => message.id)).toEqual([
          "msg-0",
          "msg-1",
          ...batch.map((message) => message.id),
        ]);
      } finally {
        rotation.mockRestore();
      }
      expect(
        (await service.appendToHistory(wsId, boundaryMessage("later-boundary", 1))).success
      ).toBe(true);
      const full = await collectFullHistory(service, wsId);
      expect(full.map((message) => message.id)).toEqual([
        "msg-0",
        "msg-1",
        ...batch.map((message) => message.id),
        "later-boundary",
      ]);
      expect(full.map((message) => message.metadata?.historySequence)).toEqual([0, 1, 2, 3, 4, 5]);
    });

    it("rotates the sealed prefix into the archive when a boundary is appended", async () => {
      await appendNumberedMessages(service, wsId, 3); // seq 0..2
      await service.appendToHistory(wsId, boundaryMessage("boundary-1", 1)); // seq 3
      await service.appendToHistory(wsId, createMuxMessage("post-0", "user", "after")); // seq 4

      // Active file holds only the latest epoch; sealed rows moved to the archive.
      const chatRows = await readJsonlFile(chatPath(wsId));
      expect(chatRows.map((m) => m.id)).toEqual(["boundary-1", "post-0"]);
      const archiveRows = await readJsonlFile(archivePath(wsId));
      expect(archiveRows.map((m) => m.id)).toEqual(["msg-0", "msg-1", "msg-2"]);

      // Hot-path read returns the active epoch.
      const latest = await service.getHistoryFromLatestBoundary(wsId);
      expect(latest.success).toBe(true);
      if (latest.success) {
        expect(latest.data.map((m) => m.id)).toEqual(["boundary-1", "post-0"]);
      }

      // Full iteration still sees everything in order.
      const full = await collectFullHistory(service, wsId);
      expect(full.map((m) => m.id)).toEqual(["msg-0", "msg-1", "msg-2", "boundary-1", "post-0"]);

      // Paging into the sealed window still works.
      const window = await service.getHistoryBoundaryWindow(wsId, 3);
      expect(window.success).toBe(true);
      if (window.success) {
        expect(window.data.messages.map((m) => m.id)).toEqual(["msg-0", "msg-1", "msg-2"]);
        expect(window.data.hasOlder).toBe(false);
      }
    });

    it("lazily rotates legacy files with a mid-file boundary on first read", async () => {
      const lines = [
        messageLine(wsId, createMuxMessage("old-0", "user", "old", { historySequence: 0 })),
        messageLine(wsId, {
          ...boundaryMessage("boundary-1", 1),
          metadata: { ...boundaryMessage("boundary-1", 1).metadata, historySequence: 1 },
        }),
        messageLine(wsId, createMuxMessage("post-0", "user", "after", { historySequence: 2 })),
      ];
      await writeHistoryLines(config, wsId, lines);

      const latest = await service.getHistoryFromLatestBoundary(wsId);
      expect(latest.success).toBe(true);
      if (latest.success) {
        expect(latest.data.map((m) => m.id)).toEqual(["boundary-1", "post-0"]);
      }

      // The read migrated the sealed prefix out of chat.jsonl.
      const chatRows = await readJsonlFile(chatPath(wsId));
      expect(chatRows.map((m) => m.id)).toEqual(["boundary-1", "post-0"]);
      const archiveRows = await readJsonlFile(archivePath(wsId));
      expect(archiveRows.map((m) => m.id)).toEqual(["old-0"]);
    });

    it("reads boundary windows across the archive seam (skip + paging)", async () => {
      await service.appendToHistory(wsId, createMuxMessage("e1-user", "user", "msg")); // seq 0
      await service.appendToHistory(wsId, boundaryMessage("boundary-1", 1)); // seq 1
      await service.appendToHistory(wsId, createMuxMessage("e2-user", "user", "msg")); // seq 2
      await service.appendToHistory(wsId, boundaryMessage("boundary-2", 2)); // seq 3
      await service.appendToHistory(wsId, createMuxMessage("post", "user", "after")); // seq 4

      // Both sealed epochs live in the archive now.
      const archiveRows = await readJsonlFile(archivePath(wsId));
      expect(archiveRows.map((m) => m.id)).toEqual(["e1-user", "boundary-1", "e2-user"]);

      // skip=1 spans archive tail + entire active file.
      const penultimate = await service.getHistoryFromLatestBoundary(wsId, 1);
      expect(penultimate.success).toBe(true);
      if (penultimate.success) {
        expect(penultimate.data.map((m) => m.id)).toEqual([
          "boundary-1",
          "e2-user",
          "boundary-2",
          "post",
        ]);
      }

      // Page one: the boundary-1 window from the archive.
      const page1 = await service.getHistoryBoundaryWindow(wsId, 3);
      expect(page1.success).toBe(true);
      if (page1.success) {
        expect(page1.data.messages.map((m) => m.id)).toEqual(["boundary-1", "e2-user"]);
        expect(page1.data.hasOlder).toBe(true);
      }

      // Page two: pre-boundary rows, no older history.
      const page2 = await service.getHistoryBoundaryWindow(wsId, 1);
      expect(page2.success).toBe(true);
      if (page2.success) {
        expect(page2.data.messages.map((m) => m.id)).toEqual(["e1-user"]);
        expect(page2.data.hasOlder).toBe(false);
      }
    });

    it("initializes the sequence counter from the archive when chat.jsonl is missing", async () => {
      await appendNumberedMessages(service, wsId, 3); // seq 0..2
      await service.appendToHistory(wsId, boundaryMessage("boundary-1", 1)); // seq 3

      // Simulate hand-deletion of the active file; archived sequences must not be reused.
      await fs.rm(chatPath(wsId));

      const restarted = new HistoryService(config);
      const msg = createMuxMessage("new-msg", "user", "fresh");
      const appendResult = await restarted.appendToHistory(wsId, msg);
      expect(appendResult.success).toBe(true);
      expect(msg.metadata?.historySequence).toBe(3);
    });

    it("deduplicates rows when a crash replays the sealed prefix", async () => {
      await appendNumberedMessages(service, wsId, 3); // seq 0..2 → archived after boundary
      await service.appendToHistory(wsId, boundaryMessage("boundary-1", 1)); // seq 3
      await service.appendToHistory(wsId, createMuxMessage("post-0", "user", "after")); // seq 4

      // Simulate a crash between the archive append and the chat.jsonl rewrite:
      // the sealed prefix reappears at the head of chat.jsonl while the archive
      // already contains it.
      const archived = await fs.readFile(archivePath(wsId), "utf-8");
      const active = await fs.readFile(chatPath(wsId), "utf-8");
      await fs.writeFile(chatPath(wsId), archived + active);

      // A fresh process triggers the lazy rotation check on first read.
      const restarted = new HistoryService(config);
      const latest = await restarted.getHistoryFromLatestBoundary(wsId);
      expect(latest.success).toBe(true);

      const archiveRows = await readJsonlFile(archivePath(wsId));
      expect(archiveRows.map((m) => m.id)).toEqual(["msg-0", "msg-1", "msg-2"]);

      const full = await collectFullHistory(restarted, wsId);
      expect(full.map((m) => m.id)).toEqual(["msg-0", "msg-1", "msg-2", "boundary-1", "post-0"]);
    });

    it("deduplicates verified reset copies while preserving their post-reset archive", async () => {
      await appendNumberedMessages(service, wsId, 2);
      await service.appendToHistory(
        wsId,
        createMuxMessage("manual-reset", "assistant", "", { contextBoundaryKind: "reset" })
      );
      await service.appendToHistory(
        wsId,
        createMuxMessage("after-reset", "user", "still recoverable")
      );
      await service.appendToHistory(wsId, boundaryMessage("later-boundary", 1));
      const archived = await fs.readFile(archivePath(wsId), "utf8");
      const active = await fs.readFile(chatPath(wsId), "utf8");
      await fs.writeFile(chatPath(wsId), archived + active);
      const restarted = new HistoryService(config);
      expect((await restarted.getHistoryFromLatestBoundary(wsId)).success).toBe(true);
      expect(await fs.readFile(archivePath(wsId), "utf8")).toBe(archived);
      expect((await collectFullHistory(restarted, wsId)).map((message) => message.id)).toEqual([
        "msg-0",
        "msg-1",
        "manual-reset",
        "after-reset",
        "later-boundary",
      ]);
    });

    it("returns the tail across the archive seam from getLastMessages", async () => {
      await appendNumberedMessages(service, wsId, 3); // seq 0..2
      await service.appendToHistory(wsId, boundaryMessage("boundary-1", 1)); // seq 3
      await service.appendToHistory(wsId, createMuxMessage("post-0", "user", "after")); // seq 4

      const result = await service.getLastMessages(wsId, 4);
      expect(result.success).toBe(true);
      if (result.success) {
        // chat.jsonl only has 2 rows; the older two must come from the archive.
        expect(result.data.map((m) => m.id)).toEqual(["msg-1", "msg-2", "boundary-1", "post-0"]);
      }
    });

    it("truncates after an archived message and collapses the archive", async () => {
      await appendNumberedMessages(service, wsId, 3); // msg-0..2, seq 0..2
      await service.appendToHistory(wsId, boundaryMessage("boundary-1", 1)); // seq 3
      await service.appendToHistory(wsId, createMuxMessage("post-0", "user", "after")); // seq 4

      const truncateResult = await service.truncateAfterMessage(wsId, "msg-1", {
        keepTargetMessage: true,
      });
      expect(truncateResult.success).toBe(true);

      const full = await collectFullHistory(service, wsId);
      expect(full.map((m) => m.id)).toEqual(["msg-0", "msg-1"]);

      // The archive was collapsed back into chat.jsonl.
      expect(
        await fs.stat(archivePath(wsId)).then(
          () => true,
          () => false
        )
      ).toBe(false);

      // The sequence counter continues from the cut point.
      const msg = createMuxMessage("new-msg", "user", "fresh");
      await service.appendToHistory(wsId, msg);
      expect(msg.metadata?.historySequence).toBe(2);
    });

    it("never reuses archived sequences after truncating the whole active epoch", async () => {
      await appendNumberedMessages(service, wsId, 3); // msg-0..2, seq 0..2 → archived
      await service.appendToHistory(wsId, boundaryMessage("boundary-1", 1)); // seq 3
      await service.appendToHistory(wsId, createMuxMessage("post-0", "user", "after")); // seq 4

      // Truncate at the boundary itself (without keeping it) — the active file
      // becomes empty while the archive still holds seq 0..2.
      const truncateResult = await service.truncateAfterMessage(wsId, "boundary-1");
      expect(truncateResult.success).toBe(true);

      const msg = createMuxMessage("new-msg", "user", "fresh");
      await service.appendToHistory(wsId, msg);
      expect(msg.metadata?.historySequence).toBe(3);
    });

    it("deletes archived rows via deleteMessage", async () => {
      await appendNumberedMessages(service, wsId, 3);
      await service.appendToHistory(wsId, boundaryMessage("boundary-1", 1));

      const deleteResult = await service.deleteMessage(wsId, "msg-1");
      expect(deleteResult.success).toBe(true);

      const archiveRows = await readJsonlFile(archivePath(wsId));
      expect(archiveRows.map((m) => m.id)).toEqual(["msg-0", "msg-2"]);

      const full = await collectFullHistory(service, wsId);
      expect(full.map((m) => m.id)).toEqual(["msg-0", "msg-2", "boundary-1"]);
    });

    it("clearHistory removes the archive too", async () => {
      await appendNumberedMessages(service, wsId, 3);
      await service.appendToHistory(wsId, boundaryMessage("boundary-1", 1));

      const clearResult = await service.clearHistory(wsId);
      expect(clearResult.success).toBe(true);
      if (clearResult.success) {
        // All rows (archived + active) are reported as deleted.
        expect(clearResult.data).toEqual([0, 1, 2, 3]);
      }

      expect(await service.hasHistory(wsId)).toBe(false);
      expect(
        await fs.stat(archivePath(wsId)).then(
          () => true,
          () => false
        )
      ).toBe(false);
    });

    it("never reuses archived sequences after deleting the whole active epoch in a fresh process", async () => {
      await appendNumberedMessages(service, wsId, 3); // seq 0..2 → archived
      await service.appendToHistory(wsId, boundaryMessage("boundary-1", 1)); // seq 3

      // Fresh process: no cached sequence counter. Deleting the lone active row
      // must not cache a counter below the archived rows.
      const restarted = new HistoryService(config);
      const deleteResult = await restarted.deleteMessage(wsId, "boundary-1");
      expect(deleteResult.success).toBe(true);

      const msg = createMuxMessage("new-msg", "user", "fresh");
      await restarted.appendToHistory(wsId, msg);
      expect(msg.metadata?.historySequence).toBe(3);
    });

    it("seeds the counter from the archive when renaming an archive-only session", async () => {
      await appendNumberedMessages(service, wsId, 3); // seq 0..2 → archived
      await service.appendToHistory(wsId, boundaryMessage("boundary-1", 1)); // seq 3
      // Archive-only session: the active file is gone but sealed rows remain.
      await fs.rm(chatPath(wsId));

      const newWsId = "ws-rotation-renamed";
      await fs.rename(path.join(config.sessionsDir, wsId), path.join(config.sessionsDir, newWsId));

      // Fresh process: no cached counter for either workspace ID.
      const restarted = new HistoryService(config);
      const migrateResult = await restarted.migrateWorkspaceId(wsId, newWsId);
      expect(migrateResult.success).toBe(true);

      const msg = createMuxMessage("new-msg", "user", "fresh");
      await restarted.appendToHistory(newWsId, msg);
      expect(msg.metadata?.historySequence).toBe(3);
    });

    it("keeps the archive intact on a no-op percentage truncation", async () => {
      await appendNumberedMessages(service, wsId, 3);
      await service.appendToHistory(wsId, boundaryMessage("boundary-1", 1));

      const chatBefore = await fs.readFile(chatPath(wsId), "utf-8");
      const archiveBefore = await fs.readFile(archivePath(wsId), "utf-8");

      const truncateResult = await service.truncateHistory(wsId, 0);
      expect(truncateResult.success).toBe(true);
      if (truncateResult.success) {
        expect(truncateResult.data).toEqual([]);
      }

      // No-op truncation must not collapse the archive back into chat.jsonl.
      expect(await fs.readFile(chatPath(wsId), "utf-8")).toBe(chatBefore);
      expect(await fs.readFile(archivePath(wsId), "utf-8")).toBe(archiveBefore);
    });

    it("refuseFullDelete refuses a partial truncation that would remove every message", async () => {
      await appendNumberedMessages(service, wsId, 1);
      const chatBefore = await fs.readFile(chatPath(wsId), "utf-8");

      // The caller classified this request as non-emptying; the locked recomputation says it
      // empties (an overlapping truncation shrank history in between). Refuse instead of
      // taking the full-delete fast path without the caller's full-clear guards.
      const refused = await service.truncateHistory(wsId, 0.9, { refuseFullDelete: true });
      expect(refused.success).toBe(false);
      if (!refused.success) {
        expect(refused.error).toContain("full clear");
      }
      expect(await fs.readFile(chatPath(wsId), "utf-8")).toBe(chatBefore);

      // Without the guard the same request takes the fast path and empties history.
      const emptied = await service.truncateHistory(wsId, 0.9);
      expect(emptied.success).toBe(true);
      expect(await service.getHistoryFromLatestBoundary(wsId)).toEqual({ success: true, data: [] });
    });

    it("refuseRowRemoval refuses a truncation whose recomputed budget removes messages", async () => {
      await appendNumberedMessages(service, wsId, 1);
      const chatBefore = await fs.readFile(chatPath(wsId), "utf-8");

      // The caller classified this request as a no-op (and skipped its row-removal guards),
      // but the locked recomputation reaches real rows. Refuse instead of removing them.
      const refused = await service.truncateHistory(wsId, 0.9, { refuseRowRemoval: true });
      expect(refused.success).toBe(false);
      if (!refused.success) {
        expect(refused.error).toContain("no-op");
      }
      expect(await fs.readFile(chatPath(wsId), "utf-8")).toBe(chatBefore);

      // A genuine no-op stays a silent success under the same flag.
      const noop = await service.truncateHistory(wsId, 0.0001, { refuseRowRemoval: true });
      expect(noop.success).toBe(true);
      expect(await fs.readFile(chatPath(wsId), "utf-8")).toBe(chatBefore);
    });

    it("requireFullDelete refuses a truncation whose recomputed budget leaves messages", async () => {
      await appendNumberedMessages(service, wsId, 8);
      const chatBefore = await fs.readFile(chatPath(wsId), "utf-8");

      // The caller classified this request as emptying (and applies full-clear-only side
      // effects after the rewrite), but history grew between that unserialized read and the
      // locked rewrite so rows would survive. Refuse instead of leaving survivors behind a
      // "full clear".
      const refused = await service.truncateHistory(wsId, 0.5, { requireFullDelete: true });
      expect(refused.success).toBe(false);
      if (!refused.success) {
        expect(refused.error).toContain("leave messages");
      }
      expect(await fs.readFile(chatPath(wsId), "utf-8")).toBe(chatBefore);

      // A truncation that does empty history stays a success under the same flag.
      const emptied = await service.truncateHistory(wsId, 0.99, { requireFullDelete: true });
      expect(emptied.success).toBe(true);
      expect(await service.getHistoryFromLatestBoundary(wsId)).toEqual({ success: true, data: [] });
    });

    it("does not reseed usage from before a partial prefix truncation", async () => {
      await appendNumberedMessages(service, wsId, 8);
      await service.appendToHistory(
        wsId,
        createMuxMessage("assistant-usage", "assistant", "reply", {
          contextUsage: { inputTokens: 95_000, outputTokens: 100, totalTokens: 95_100 },
          contextProviderMetadata: { openai: {} },
          model: "openai:gpt-4o",
        })
      );
      await service.appendToHistory(
        wsId,
        createMuxMessage("assistant-provider-metadata", "assistant", "reply", {
          contextProviderMetadata: { openai: {} },
          model: "openai:gpt-4o",
        })
      );

      const truncateResult = await service.truncateHistory(wsId, 0.5);
      expect(truncateResult.success).toBe(true);

      const restarted = new HistoryService(config);
      const remaining = await restarted.getHistoryFromLatestBoundary(wsId);
      expect(remaining.success).toBe(true);
      if (remaining.success) {
        const retainedAssistant = remaining.data.find(
          (message) => message.id === "assistant-usage"
        );
        expect(retainedAssistant).toBeDefined();
        expect(retainedAssistant?.metadata?.contextUsage).toBeUndefined();
        expect(retainedAssistant?.metadata?.contextProviderMetadata).toBeUndefined();
        const providerMetadataOnly = remaining.data.find(
          (message) => message.id === "assistant-provider-metadata"
        );
        expect(providerMetadataOnly).toBeDefined();
        expect(providerMetadataOnly?.metadata?.contextProviderMetadata).toBeUndefined();
      }
    });

    async function expectWorkflowDisplayTruncationPreservesUsage(withResetBoundary: boolean) {
      if (withResetBoundary) {
        await appendNumberedMessages(service, wsId, 12);
        await service.appendToHistory(
          wsId,
          createMuxMessage("reset-boundary", "assistant", "", {
            contextBoundaryKind: CONTEXT_BOUNDARY_KINDS.RESET,
          })
        );
      }
      await service.appendToHistory(
        wsId,
        createMuxMessage(
          "workflow-display",
          "user",
          `workflow trigger display ${"x".repeat(2_000)}`,
          { muxMetadata: { type: "workflow-trigger-display", rawCommand: "/wf", runId: "run-1" } }
        )
      );
      await service.appendToHistory(wsId, createMuxMessage("user-active", "user", "prompt"));
      await service.appendToHistory(
        wsId,
        createMuxMessage("assistant-active", "assistant", "active reply", {
          contextUsage: { inputTokens: 95_000, outputTokens: 100, totalTokens: 95_100 },
          model: "openai:gpt-4o",
        })
      );

      expect((await service.truncateHistory(wsId, 0.5)).success).toBe(true);

      const active = await service.getHistoryFromLatestBoundary(wsId);
      expect(active.success).toBe(true);
      if (active.success) {
        expect(active.data.find((message) => message.id === "workflow-display")).toBeUndefined();
        const retainedAssistant = active.data.find((message) => message.id === "assistant-active");
        expect(retainedAssistant).toBeDefined();
        expect(retainedAssistant?.metadata?.contextUsage).toMatchObject({ inputTokens: 95_000 });
      }
    }

    it("preserves active usage when uncompacted truncation removes only workflow display rows", () =>
      expectWorkflowDisplayTruncationPreservesUsage(false));

    it("preserves active usage when truncation removes only workflow display rows", () =>
      expectWorkflowDisplayTruncationPreservesUsage(true));

    it("preserves active usage when truncation removes only sealed rows", async () => {
      await appendNumberedMessages(service, wsId, 8);
      await service.appendToHistory(wsId, boundaryMessage("boundary-1", 1));
      await service.appendToHistory(
        wsId,
        createMuxMessage("active-usage", "assistant", "reply", {
          contextUsage: { inputTokens: 95_000, outputTokens: 100, totalTokens: 95_100 },
          model: "openai:gpt-4o",
        })
      );

      expect((await service.truncateHistory(wsId, 0.2)).success).toBe(true);

      const active = await service.getHistoryFromLatestBoundary(wsId);
      expect(active.success).toBe(true);
      if (active.success) {
        expect(
          active.data.find((message) => message.id === "active-usage")?.metadata?.contextUsage
        ).toBeDefined();
      }
    });

    it("restores a markerless archive tombstone left by an older truncation", async () => {
      await appendNumberedMessages(service, wsId, 3);
      await service.appendToHistory(wsId, boundaryMessage("boundary-1", 1));
      await service.appendToHistory(wsId, createMuxMessage("post-0", "user", "after"));
      await fs.rename(archivePath(wsId), `${archivePath(wsId)}.truncate`);

      const restarted = new HistoryService(config);
      const full = await collectFullHistory(restarted, wsId);
      expect(full.map((message) => message.id)).toEqual([
        "msg-0",
        "msg-1",
        "msg-2",
        "boundary-1",
        "post-0",
      ]);
    });

    it("restores an interrupted archive tombstone when only the final chat matches", async () => {
      await appendNumberedMessages(service, wsId, 3);
      await service.appendToHistory(wsId, boundaryMessage("boundary-1", 1));
      await service.appendToHistory(wsId, createMuxMessage("post-0", "user", "after"));
      const chatContents = await fs.readFile(chatPath(wsId), "utf-8");
      const hash = (contents: string) => createHash("sha256").update(contents).digest("hex");
      await fs.writeFile(
        `${archivePath(wsId)}.truncate.json`,
        JSON.stringify({
          phase: "prepared",
          finalArchiveHash: hash("replacement archive\n"),
          finalChatHash: hash(chatContents),
        })
      );
      await fs.rename(archivePath(wsId), `${archivePath(wsId)}.truncate`);

      const restarted = new HistoryService(config);
      const full = await collectFullHistory(restarted, wsId);
      expect(full.map((message) => message.id)).toEqual([
        "msg-0",
        "msg-1",
        "msg-2",
        "boundary-1",
        "post-0",
      ]);
    });

    it("recovers the source transaction before copying a fork snapshot", async () => {
      const targetWorkspaceId = "forked-workspace";
      await appendNumberedMessages(service, wsId, 3);
      await service.appendToHistory(wsId, boundaryMessage("boundary-1", 1));
      await service.appendToHistory(wsId, createMuxMessage("post-0", "user", "after"));
      const chatContents = await fs.readFile(chatPath(wsId), "utf-8");
      const hash = (contents: string) => createHash("sha256").update(contents).digest("hex");
      await fs.writeFile(
        `${archivePath(wsId)}.truncate.json`,
        JSON.stringify({
          finalArchiveHash: hash("replacement archive\n"),
          finalChatHash: hash(chatContents),
        })
      );
      await fs.rename(archivePath(wsId), `${archivePath(wsId)}.truncate`);

      const result = await service.copyHistorySnapshotToNewWorkspace(wsId, targetWorkspaceId);
      expect(result.success).toBe(true);
      expect(
        (await collectFullHistory(service, targetWorkspaceId)).map((message) => message.id)
      ).toEqual(["msg-0", "msg-1", "msg-2", "boundary-1", "post-0"]);
    });

    it("does not restore a committed archive tombstone before appending", async () => {
      await appendNumberedMessages(service, wsId, 3);
      await service.appendToHistory(wsId, boundaryMessage("boundary-1", 1));
      await service.appendToHistory(wsId, createMuxMessage("post-0", "user", "after"));
      await fs.writeFile(
        `${archivePath(wsId)}.truncate.json`,
        JSON.stringify({ finalArchiveHash: null, finalChatHash: null })
      );
      await fs.rename(archivePath(wsId), `${archivePath(wsId)}.truncate`);
      await fs.rm(chatPath(wsId));

      const restarted = new HistoryService(config);
      const message = createMuxMessage("new-msg", "user", "fresh");
      expect((await restarted.appendToHistory(wsId, message)).success).toBe(true);
      expect(message.metadata?.historySequence).toBe(0);
      expect((await collectFullHistory(restarted, wsId)).map((item) => item.id)).toEqual([
        "new-msg",
      ]);
    });

    it("hasHistory sees archive-only workspaces", async () => {
      await appendNumberedMessages(service, wsId, 1);
      await service.appendToHistory(wsId, boundaryMessage("boundary-1", 1));
      await fs.rm(chatPath(wsId));

      expect(await service.hasHistory(wsId)).toBe(true);
    });
  });
  describe("getSubagentTranscript", () => {
    const dependencies = {
      taskService: {
        isDescendantAgentTask: () => Promise.resolve(false),
        listDescendantAgentTasks: () => [],
      },
      aiService: {
        getWorkspaceMetadata: () => Promise.resolve({ success: false as const, error: "unused" }),
      },
    };

    async function writeArtifact(
      ownerId: string,
      taskId: string,
      chatLines: string[] | null,
      partial: MuxMessage
    ): Promise<void> {
      const ownerDir = path.join(config.sessionsDir, ownerId);
      const transcriptDir = path.join(ownerDir, "subagent-transcripts", taskId);
      const chatPath = path.join(transcriptDir, "chat.jsonl");
      const partialPath = path.join(transcriptDir, "partial.json");
      await fs.mkdir(transcriptDir, { recursive: true });
      if (chatLines) await fs.writeFile(chatPath, chatLines.join("\n") + "\n");
      await fs.writeFile(partialPath, JSON.stringify(partial));
      await updateSubagentTranscriptArtifactsFile({
        workspaceId: ownerId,
        workspaceSessionDir: ownerDir,
        update: (file) => {
          file.artifactsByChildTaskId[taskId] = {
            childTaskId: taskId,
            parentWorkspaceId: ownerId,
            createdAtMs: 1,
            updatedAtMs: 1,
            model: " openai:gpt-5 ",
            thinkingLevel: "high",
            chatPath,
            partialPath,
          };
        },
      });
    }

    it("reads cross-session fixtures, filters malformed lines, and merges partials", async () => {
      const committed = createMuxMessage("committed", "assistant", "old", { historySequence: 1 });
      const next = createMuxMessage("next", "user", "next", { historySequence: 2 });
      const partial = createMuxMessage("partial", "assistant", "new", { historySequence: 1 });
      partial.parts?.push({ type: "text", text: "continued" });
      await writeArtifact(
        "owner",
        "merged-task",
        [JSON.stringify(committed), "bad", JSON.stringify(next)],
        partial
      );

      const merged = await service.getSubagentTranscript(
        { taskId: "merged-task", requestingWorkspaceId: null },
        dependencies
      );
      expect(merged.messages.map((message) => message.id)).toEqual(["partial", "next"]);
      expect(merged).toMatchObject({ model: "openai:gpt-5", thinkingLevel: "high" });

      const partialOnly = createMuxMessage("partial-only", "assistant", "saved", {
        historySequence: 3,
      });
      await writeArtifact("owner", "missing-chat-task", null, partialOnly);
      expect(
        (
          await service.getSubagentTranscript(
            { taskId: "missing-chat-task", requestingWorkspaceId: null },
            dependencies
          )
        ).messages.map((message) => message.id)
      ).toEqual(["partial-only"]);
    });

    it("reports a cross-session miss", async () => {
      const error = await service
        .getSubagentTranscript(
          { taskId: "missing-task", requestingWorkspaceId: null },
          dependencies
        )
        .catch((caught: unknown) => caught);
      expect(error).toHaveProperty("message", "No transcript found for task missing-task");
    });
  });
});

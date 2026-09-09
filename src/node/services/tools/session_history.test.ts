import {
  HistoryAppendProvenance,
  HISTORY_PROVENANCE_MAX_RECEIPT_BYTES,
} from "@/node/services/historyAppendProvenance";
import { acquireProcessFileLock } from "@/node/utils/concurrency/fileLock";
import {
  historyWriteLockPath,
  workspaceRemovalTombstonePath,
} from "@/node/services/workspaceRemoval";
import type { TaskService } from "@/node/services/taskService";
import { createRolloverPrefix } from "@/node/services/contextWindowRollover";
import { hasRawResetMarker } from "@/node/services/historyScanner";
import { createHash } from "node:crypto";
import { appendFileSync } from "node:fs";
import { afterEach, beforeEach, describe, expect, spyOn, test } from "bun:test";
import * as fs from "node:fs/promises";
import * as path from "node:path";
import { createMuxMessage, type MuxMessage, type MuxMetadata } from "@/common/types/message";
import {
  SESSION_HISTORY_MAX_RESULT_BYTES,
  SESSION_HISTORY_MAX_ID_CHARS,
  SESSION_HISTORY_MAX_CURSOR_CHARS,
  SESSION_HISTORY_MAX_SCAN_BYTES,
  SESSION_HISTORY_MAX_SCAN_ROWS,
  SESSION_HISTORY_SCAN_CHUNK_BYTES,
  SESSION_HISTORY_ANCHOR_BYTES,
  SESSION_HISTORY_MAX_LINE_BYTES,
} from "@/common/constants/contextBudget";
import { TOOL_DEFINITIONS } from "@/common/utils/tools/toolDefinitions";
import { createTestHistoryService } from "@/node/services/testHistoryService";
import { createTestToolConfig, mockToolCallOptions } from "./testHelpers";
import {
  createSessionHistoryTool,
  type SessionHistoryArgs,
  type SessionHistoryResult,
} from "./session_history";

let fixture: Awaited<ReturnType<typeof createTestHistoryService>>;
const workspaceId = "history-browser";
let chatPath: string;
let archivePath: string;
let call: (input: SessionHistoryArgs, workspace?: string) => Promise<SessionHistoryResult>;
async function append(
  id: string,
  text: string,
  metadata?: MuxMetadata,
  parts?: MuxMessage["parts"]
) {
  const message = createMuxMessage(id, "assistant", text, metadata, parts);
  expect((await fixture.historyService.appendToHistory(workspaceId, message)).success).toBe(true);
  return message;
}
// Malformed-row fixtures intentionally use the same cooperative append receipt
// contract as production while bypassing message-shape normalization only.
async function appendTrackedHistory(filePath: string, data: string | Buffer): Promise<void> {
  const store = new HistoryAppendProvenance(path.dirname(filePath));
  await using _lock = await acquireProcessFileLock({
    lockPath: historyWriteLockPath(fixture.config.rootDir, workspaceId),
    timeoutMs: 5000,
    label: "test history append",
  });
  await store.runMutation(() => store.appendChat(Buffer.isBuffer(data) ? data : Buffer.from(data)));
}

async function pages(input: SessionHistoryArgs) {
  const results: SessionHistoryResult[] = [];
  let cursor: string | undefined;
  do {
    const result = await call({ ...input, cursor });
    if (input.action === "read_item" && result.error === "item_not_found") {
      expect(result).toMatchObject({ success: false, exhausted: true, items: [] });
      expect(result.nextCursor).toBeUndefined();
    } else {
      expect(result.success).toBe(true);
    }
    expect(result.bytesRead).toBeLessThanOrEqual(SESSION_HISTORY_MAX_SCAN_BYTES);
    expect(result.rowsScanned).toBeLessThanOrEqual(SESSION_HISTORY_MAX_SCAN_ROWS);
    expect(Buffer.byteLength(JSON.stringify(result))).toBeLessThanOrEqual(
      SESSION_HISTORY_MAX_RESULT_BYTES
    );
    for (const item of result.items ?? []) {
      expect(item.itemId.length).toBeLessThanOrEqual(SESSION_HISTORY_MAX_ID_CHARS);
      expect(item.windowId.length).toBeLessThanOrEqual(SESSION_HISTORY_MAX_ID_CHARS);
    }
    for (const window of result.windows ?? []) {
      expect(window.windowId.length).toBeLessThanOrEqual(SESSION_HISTORY_MAX_ID_CHARS);
    }
    if (result.nextCursor)
      expect(result.nextCursor.length).toBeLessThanOrEqual(SESSION_HISTORY_MAX_CURSOR_CHARS);
    results.push(result);
    cursor = result.nextCursor;
    expect(results.length).toBeLessThan(40);
  } while (cursor);
  return results;
}
const rollover: MuxMetadata = {
  contextBoundaryKind: "reset",
  synthetic: true,
  muxMetadata: {
    type: "context-window-rollover",
    rolloverId: "roll",
    reason: "on-send",
    previousWindowId: "w:0",
    flushOpportunity: false,
    contextTokens: 5000,
    maxTokens: 6000,
  },
};

beforeEach(async () => {
  fixture = await createTestHistoryService();
  chatPath = path.join(fixture.config.sessionsDir, workspaceId, "chat.jsonl");
  archivePath = path.join(fixture.config.sessionsDir, workspaceId, "chat-archive.jsonl");
  call = async (input, workspace = workspaceId) => {
    const config = createTestToolConfig(fixture.tempDir, { workspaceId: workspace });
    config.historyService = fixture.historyService;
    const tool = createSessionHistoryTool(config);
    return TOOL_DEFINITIONS.session_history.resultSchema.parse(
      await tool.execute!(input, mockToolCallOptions)
    );
  };
  await append("first", "opening facts");
});
afterEach(async () => {
  await fixture.cleanup();
});

describe("session_history real disk recovery", () => {
  test("an interior same-length rewrite followed by append cannot retain cursor trust", async () => {
    const victim = JSON.stringify(createMuxMessage("rewrite-victim", "assistant", "x".repeat(600)));
    const offset = (await fs.stat(chatPath)).size;
    await fs.appendFile(
      chatPath,
      victim +
        "\n" +
        [
          createMuxMessage("private-after-victim", "assistant", "private facts"),
          createMuxMessage("anchor-padding", "assistant", "z".repeat(500)),
        ]
          .map((row) => JSON.stringify(row))
          .join("\n") +
        "\n"
    );
    const first = await call({ action: "search", query: "facts", limit: 1 });
    expect(first.nextCursor).toBeString();
    const reset = JSON.stringify(
      createMuxMessage("new-manual-reset", "assistant", "", { contextBoundaryKind: "reset" })
    );
    const handle = await fs.open(chatPath, "r+");
    try {
      await handle.write(Buffer.from(reset.padEnd(victim.length)), 0, victim.length, offset);
    } finally {
      await handle.close();
    }
    await fs.appendFile(
      chatPath,
      JSON.stringify(createMuxMessage("untracked-append", "assistant", "new row")) + "\n"
    );
    expect((await call({ action: "search", query: "facts", cursor: first.nextCursor })).error).toBe(
      "stale_cursor"
    );
  });

  for (const targetArtifact of ["active", "archive"] as const) {
    for (const resetPosition of ["before", "after"] as const) {
      test.each([false, true])(
        `${targetArtifact} edit/fork (keep target: %s) preserves a fragmented reset ${resetPosition} the cut`,
        async (keepTargetMessage) => {
          const privateBoundary = await append("private-summary", "private summary", {
            compacted: true,
            compactionBoundary: true,
            compactionEpoch: 1,
          });
          await append("manual-reset", "", { contextBoundaryKind: "reset" });
          const target = await append("cut-target", "target facts");
          const tail = await append("cut-tail", "tail facts");
          // Standalone JSON strings parse, but are still unreadable reset fragments.
          const reset = Buffer.concat([
            Buffer.from(' {\n"contextBoundaryKind"\n:\n"reset"\n'),
            Buffer.from([0xff]),
            Buffer.from("\r\n}\n"),
          ]);
          const targetLine = Buffer.from(JSON.stringify(target) + "\n");
          const tailLine = Buffer.from(JSON.stringify(tail) + "\n");
          await fs.writeFile(
            chatPath,
            Buffer.concat(
              resetPosition === "before"
                ? [reset, targetLine, tailLine]
                : [targetLine, reset, tailLine]
            )
          );
          if (targetArtifact === "archive") {
            await append("later-boundary", "public summary", {
              compacted: true,
              compactionBoundary: true,
              compactionEpoch: 2,
            });
          }
          const result = await fixture.historyService.truncateAfterMessage(workspaceId, target.id, {
            keepTargetMessage,
          });
          expect(result.success).toBe(true);
          if (!result.success) throw new Error(result.error);
          expect(result.data.removedMessages.some((row) => row.id === target.id)).toBe(
            !keepTargetMessage
          );
          expect(result.data.removedMessages.some((row) => row.id === tail.id)).toBe(true);
          const retained = Buffer.concat([
            targetArtifact === "archive" ? Buffer.alloc(0) : await fs.readFile(archivePath),
            await fs.readFile(chatPath),
          ]);
          expect(retained.includes(reset)).toBe(true);
          expect(retained.includes(Buffer.from("opening facts"))).toBe(true);
          expect(
            (await pages({ action: "search", query: "opening facts" })).flatMap(
              (page) => page.items ?? []
            )
          ).toEqual([]);
          expect((await pages({ action: "read_item", item_id: "0" })).at(-1)?.error).toBe(
            "item_not_found"
          );
          expect(
            (await pages({ action: "list_windows" }))
              .flatMap((page) => page.windows ?? [])
              .some(
                (window) =>
                  window.windowId === `w:${String(privateBoundary.metadata!.historySequence)}`
              )
          ).toBe(false);
        }
      );
    }
  }

  test.each([false, true])(
    "archived edit/fork (keep target: %s) retains an unreadable floor from the discarded active epoch",
    async (keepTargetMessage) => {
      const target = await append("archived-cut", "target facts");
      await append("later-boundary", "public summary", {
        compacted: true,
        compactionBoundary: true,
        compactionEpoch: 1,
      });
      const reset = Buffer.from('{"metadata":{"contextBoundaryKind":"reset"},broken\n');
      await fs.writeFile(chatPath, reset);
      await append("discarded-active", "public facts");
      const result = await fixture.historyService.truncateAfterMessage(workspaceId, target.id, {
        keepTargetMessage,
      });
      expect(result.success).toBe(true);
      const retained = await fs.readFile(chatPath);
      expect(retained.includes(reset)).toBe(true);
      expect(retained.includes(Buffer.from("opening facts"))).toBe(true);
      expect(retained.includes(Buffer.from("discarded-active"))).toBe(false);
      expect((await pages({ action: "read_item", item_id: "0" })).at(-1)?.error).toBe(
        "item_not_found"
      );
    }
  );

  test("archived fork keeps an unterminated target separate from retained active reset fragments", async () => {
    const target = await append("unterminated-target", "retained target facts");
    await append("later-boundary", "public summary", {
      compacted: true,
      compactionBoundary: true,
      compactionEpoch: 1,
    });
    const archived = await fs.readFile(archivePath);
    expect(archived.at(-1)).toBe(10);
    await fs.writeFile(archivePath, archived.subarray(0, -1));
    await fs.writeFile(chatPath, '{"metadata":{"contextBoundaryKind":"reset"},broken\n');
    expect(
      (
        await fixture.historyService.truncateAfterMessage(workspaceId, target.id, {
          keepTargetMessage: true,
        })
      ).success
    ).toBe(true);
    const retained = await fixture.historyService.getLastMessages(workspaceId, 10);
    expect(retained.success).toBe(true);
    if (!retained.success) throw new Error(retained.error);
    expect(retained.data.map((row) => row.id)).toContain(target.id);
    expect((await pages({ action: "read_item", item_id: "0" })).at(-1)?.error).toBe(
      "item_not_found"
    );
  });

  test.each([
    '{"id":"bad","role":"user"}',
    '{"id":"bad","role":"user","parts":[null]}',
    '{"id":"bad","role":"user","parts":[{"type":"text","text":42}]}',
  ])(
    "percentage truncation keeps invalid parsed rows raw without typed admission: %s",
    async (row) => {
      const invalid = Buffer.from(row + "\n");
      await fs.writeFile(chatPath, Buffer.concat([invalid, await fs.readFile(chatPath)]));
      await append("last", "retained facts");
      const result = await fixture.historyService.truncateHistory(workspaceId, 0.2);
      expect(result.success).toBe(true);
      if (!result.success) throw new Error(result.error);
      expect(result.data.length).toBeGreaterThan(0);
      expect((await fs.readFile(chatPath)).includes(invalid)).toBe(true);
      expect(
        (await pages({ action: "search", query: "retained facts" })).flatMap(
          (page) => page.items ?? []
        ).length
      ).toBe(1);
    }
  );

  test.each(["active", "archive"])(
    "partial truncation delimits an unterminated %s floor before future appends",
    async (artifact) => {
      const reset = Buffer.from('{"metadata":{"contextBoundaryKind":"reset"},torn');
      if (artifact === "active") {
        const target = await append("cut-target", "discarded");
        await fs.appendFile(chatPath, reset);
        expect(
          (await fixture.historyService.truncateAfterMessage(workspaceId, target.id)).success
        ).toBe(true);
      } else {
        await fs.writeFile(archivePath, Buffer.concat([await fs.readFile(chatPath), reset]));
        const rows = [
          createMuxMessage("large-first", "user", "public context ".repeat(2000)),
          createMuxMessage("large-last", "user", "public context ".repeat(2000)),
        ];
        await fs.writeFile(chatPath, rows.map((row) => JSON.stringify(row)).join("\n") + "\n");
        expect((await fixture.historyService.truncateHistory(workspaceId, 0.5)).success).toBe(true);
      }
      const rewritten = await fs.readFile(artifact === "active" ? chatPath : archivePath);
      expect(rewritten.includes(reset)).toBe(true);
      const accepted = createMuxMessage("accepted-after-rewrite", "user", "accepted facts");
      expect((await fixture.historyService.appendToHistory(workspaceId, accepted)).success).toBe(
        true
      );
      if (artifact === "archive") {
        await append("next-boundary", "new summary", {
          compacted: true,
          compactionBoundary: true,
          compactionEpoch: 1,
        });
        const archived = await fs.readFile(archivePath, "utf8");
        expect(archived.split("\n").some((line) => line.startsWith('{"id":"large-last"'))).toBe(
          true
        );
      }
      expect(
        (await pages({ action: "search", query: "accepted facts" })).flatMap(
          (page) => page.items ?? []
        ).length
      ).toBe(1);
      expect(
        (await pages({ action: "read_item", item_id: String(accepted.metadata!.historySequence) }))
          .flatMap((page) => page.items ?? [])
          .map((item) => item.text)
      ).toEqual(["accepted facts"]);
    }
  );

  test("partial percentage truncation keeps an archive containing only unreadable reset fragments", async () => {
    await append("manual-reset", "", { contextBoundaryKind: "reset" });
    const reset = Buffer.from(' {\n"contextBoundaryKind"\n:\n"reset"\n}\n');
    await fs.writeFile(chatPath, reset);
    await append("later-boundary", "public summary", {
      compacted: true,
      compactionBoundary: true,
      compactionEpoch: 1,
    });
    await append("large-first", "public context ".repeat(2000));
    await append("large-last", "public context ".repeat(2000));
    const result = await fixture.historyService.truncateHistory(workspaceId, 0.5);
    expect(result.success).toBe(true);
    expect(await fs.readFile(archivePath)).toEqual(reset);
    expect(
      (await pages({ action: "search", query: "public" })).flatMap((page) => page.items ?? [])
        .length
    ).toBeGreaterThan(0);
  });

  test("truncation recovery hashes preserved invalid UTF-8 as bytes before retiring its tombstone", async () => {
    const reset = Buffer.concat([
      Buffer.from('{"metadata":{"contextBoundaryKind":"reset"},'),
      Buffer.from([0xff]),
      Buffer.from("\n"),
    ]);
    const active = Buffer.from(
      JSON.stringify(createMuxMessage("public", "assistant", "public facts")) + "\n"
    );
    await fs.writeFile(archivePath, reset);
    await fs.writeFile(chatPath, active);
    await fs.writeFile(
      `${archivePath}.truncate`,
      JSON.stringify(createMuxMessage("private", "assistant", "private facts")) + "\n"
    );
    await fs.writeFile(
      `${archivePath}.truncate.json`,
      JSON.stringify({
        finalArchiveHash: createHash("sha256").update(reset.toString("utf8")).digest("hex"),
        finalChatHash: createHash("sha256").update(active.toString("utf8")).digest("hex"),
        rawHashes: {
          version: 1,
          finalArchiveHash: createHash("sha256").update(reset).digest("hex"),
          finalChatHash: createHash("sha256").update(active).digest("hex"),
        },
      })
    );
    expect((await fixture.historyService.getLastMessages(workspaceId, 1)).success).toBe(true);
    expect(await fs.readFile(archivePath)).toEqual(reset);
    expect(
      (await pages({ action: "search", query: "private facts" })).flatMap(
        (page) => page.items ?? []
      )
    ).toEqual([]);
    expect(
      await fs.stat(`${archivePath}.truncate`).then(
        () => true,
        () => false
      )
    ).toBe(false);
  });

  test.each(["active", "archive"])(
    "partial percentage truncation preserves malformed reset bytes in %s history",
    async (resetArtifact) => {
      for (let index = 0; index < 12; index++)
        await append(`private-${index}`, "old context ".repeat(40));
      const secret = await append("private-secret", "private facts");
      await append("manual-reset", "", { contextBoundaryKind: "reset" });
      const reset = Buffer.concat([
        Buffer.from(' {"metadata":{"contextBoundaryKind"\n:\n"reset"},'),
        Buffer.from([0xff]),
        Buffer.from("\r\n"),
      ]);
      await fs.writeFile(chatPath, reset);
      for (let index = 0; index < 8; index++)
        await append(`public-${index}`, "public facts ".repeat(40));
      if (resetArtifact === "archive") {
        await append("later-boundary", "public summary", {
          compacted: true,
          compactionBoundary: true,
          compactionEpoch: 1,
        });
      }
      const result = await fixture.historyService.truncateHistory(workspaceId, 0.05);
      expect(result.success).toBe(true);
      if (!result.success) throw new Error(result.error);
      expect(result.data.length).toBeGreaterThan(0);
      const retained = Buffer.concat([await fs.readFile(archivePath), await fs.readFile(chatPath)]);
      expect(retained.includes(reset)).toBe(true);
      expect(retained.includes(Buffer.from("private facts"))).toBe(true);
      expect(
        (await pages({ action: "search", query: "private facts" })).flatMap(
          (page) => page.items ?? []
        )
      ).toEqual([]);
      expect(
        (
          await pages({ action: "read_item", item_id: String(secret.metadata!.historySequence) })
        ).at(-1)?.error
      ).toBe("item_not_found");
      expect(
        (await pages({ action: "search", query: "public facts" })).flatMap(
          (page) => page.items ?? []
        ).length
      ).toBeGreaterThan(0);
      expect((await fixture.historyService.clearHistory(workspaceId)).success).toBe(true);
      expect(
        (await pages({ action: "search", query: "facts" })).flatMap((page) => page.items ?? [])
      ).toEqual([]);
    }
  );

  test.each([
    "stream update",
    "partial commit",
    "boundary update",
    "boundary append",
    "single cleanup",
    "batch cleanup",
    "archive cleanup",
    "workspace migration",
    "rotation",
  ])("automatic %s preserves unreadable reset bytes and archive privacy", async (operation) => {
    const privateBoundary = await append("private-summary", "private summary", {
      compacted: true,
      compactionBoundary: true,
      compactionEpoch: 1,
    });
    await append("manual-reset", "", { contextBoundaryKind: "reset" });
    const cleanup = await append("cleanup", "temporary payload");
    const reply = await append("reply", "public facts");
    const raw = await fs.readFile(chatPath);
    const malformed = Buffer.concat([
      Buffer.from(' \t{"metadata":{"contextBoundaryKind"\n:\n"reset"},'),
      Buffer.from([0xff]),
      Buffer.from(" \r\n\n"),
      // Parseable but unreadable as a history message; migration must not normalize it.
      Buffer.from(' {"role":"assistant", "metadata":{"contextBoundaryKind":"reset"}} \r\n'),
      // JSON.parse succeeds but drops the first metadata field and its reset evidence.
      Buffer.from(
        '{"id":"duplicate","role":"assistant","parts":[],"metadata":{"contextBoundaryKind":"reset"},"metadata":{}}\n'
      ),
    ]);
    await fs.writeFile(chatPath, Buffer.concat([malformed, raw.subarray(raw.indexOf(10) + 1)]));
    const boundary = createMuxMessage("summary", "assistant", "public summary", {
      compacted: "user",
      compactionBoundary: true,
      compactionEpoch: 1,
    });
    if (operation === "stream update") {
      expect((await fixture.historyService.updateHistory(workspaceId, reply)).success).toBe(true);
    } else if (operation === "partial commit") {
      await fixture.historyService.writePartial(workspaceId, reply);
      expect((await fixture.historyService.commitPartial(workspaceId)).success).toBe(true);
    } else if (operation === "boundary update" || operation === "boundary append") {
      const updateExisting = operation === "boundary update";
      if (updateExisting) {
        boundary.id = reply.id;
        boundary.metadata = {
          ...boundary.metadata,
          historySequence: reply.metadata!.historySequence,
        };
      }
      expect(
        (
          await fixture.historyService.persistBoundaryWithTailCopies(
            workspaceId,
            boundary,
            [createMuxMessage("tail", "user", "public tail")],
            updateExisting
          )
        ).success
      ).toBe(true);
    } else if (operation === "batch cleanup") {
      expect((await fixture.historyService.deleteMessages(workspaceId, [cleanup.id])).success).toBe(
        true
      );
    } else if (operation === "single cleanup" || operation === "archive cleanup") {
      if (operation === "archive cleanup") {
        expect((await fixture.historyService.appendToHistory(workspaceId, boundary)).success).toBe(
          true
        );
      }
      expect((await fixture.historyService.deleteMessage(workspaceId, cleanup.id)).success).toBe(
        true
      );
    } else if (operation === "workspace migration") {
      expect(
        (await fixture.historyService.migrateWorkspaceId("previous-id", workspaceId)).success
      ).toBe(true);
    } else {
      expect((await fixture.historyService.appendToHistory(workspaceId, boundary)).success).toBe(
        true
      );
    }
    const retained = Buffer.concat([await fs.readFile(archivePath), await fs.readFile(chatPath)]);
    expect(retained.includes(malformed)).toBe(true);
    expect(
      (await pages({ action: "search", query: "opening facts" })).flatMap(
        (page) => page.items ?? []
      )
    ).toEqual([]);
    expect((await pages({ action: "read_item", item_id: "0" })).at(-1)?.error).toBe(
      "item_not_found"
    );
    expect(
      (await pages({ action: "list_windows" }))
        .flatMap((page) => page.windows ?? [])
        .every(
          (window) => window.windowId !== `w:${String(privateBoundary.metadata!.historySequence)}`
        )
    ).toBe(true);
    expect(
      (await pages({ action: "search", query: "public" })).flatMap((page) => page.items ?? [])
        .length
    ).toBeGreaterThan(0);
  });

  test.each([
    "stream update",
    "boundary update",
    "budget rejection",
    "single cleanup",
    "batch cleanup",
  ])("a targeted %s cannot normalize away hidden reset evidence", async (operation) => {
    await append("manual-reset", "", { contextBoundaryKind: "reset" });
    const trigger = createMuxMessage("trigger", "user", "Request");
    expect((await fixture.historyService.appendToHistory(workspaceId, trigger)).success).toBe(true);
    const raw = Buffer.from(
      JSON.stringify(trigger).replace(
        '"metadata":',
        '"metadata":{"contextBoundaryKind":"reset"},"metadata":'
      ) + "\n"
    );
    await fs.writeFile(chatPath, raw);
    const result =
      operation === "stream update"
        ? await fixture.historyService.updateHistory(workspaceId, trigger)
        : operation === "boundary update"
          ? await fixture.historyService.persistBoundaryWithTailCopies(
              workspaceId,
              {
                ...trigger,
                role: "assistant",
                metadata: {
                  ...trigger.metadata,
                  compacted: true,
                  compactionBoundary: true,
                  compactionEpoch: 1,
                },
              },
              [],
              true
            )
          : operation === "single cleanup"
            ? await fixture.historyService.deleteMessage(workspaceId, trigger.id)
            : operation === "batch cleanup"
              ? await fixture.historyService.deleteMessages(workspaceId, [trigger.id])
              : await fixture.historyService.rejectContextBudgetRequest(workspaceId, trigger);
    expect(result.success).toBe(false);
    expect(await fs.readFile(chatPath)).toEqual(raw);
    expect((await pages({ action: "read_item", item_id: "0" })).at(-1)?.error).toBe(
      "item_not_found"
    );
  });

  test("budget rejection preserves unreadable reset floors and unrelated raw bytes", async () => {
    await append("manual-reset", "", { contextBoundaryKind: "reset" });
    const payload = createMuxMessage("rejected-payload", "assistant", "Rejected payload", {
      synthetic: true,
    });
    const trigger = createMuxMessage("rejected-trigger", "user", "Rejected request", {
      requestPreludeMessageIds: [payload.id],
    });
    expect(
      (await fixture.historyService.appendManyToHistory(workspaceId, [payload, trigger])).success
    ).toBe(true);
    const raw = await fs.readFile(chatPath);
    const boundaryEnd = raw.indexOf(10) + 1;
    expect(boundaryEnd).toBeGreaterThan(0);
    const malformed = Buffer.concat([
      Buffer.from('{"role":"assistant","metadata":{"contextBoundaryKind":"reset"},'),
      Buffer.from([0xff]),
      Buffer.from("\n\n"),
    ]);
    await fs.writeFile(chatPath, Buffer.concat([malformed, raw.subarray(boundaryEnd)]));
    expect(
      (await pages({ action: "search", query: "opening facts" })).flatMap(
        (page) => page.items ?? []
      )
    ).toEqual([]);
    expect(
      (await fixture.historyService.rejectContextBudgetRequest(workspaceId, trigger)).success
    ).toBe(true);
    const after = await fs.readFile(chatPath);
    expect(after.subarray(0, malformed.length)).toEqual(malformed);
    expect(
      (await pages({ action: "search", query: "opening facts" })).flatMap(
        (page) => page.items ?? []
      )
    ).toEqual([]);
    expect(
      (await pages({ action: "search", query: "Rejected" })).flatMap((page) => page.items ?? [])
    ).toEqual([]);
    const read = (await pages({ action: "read_item", item_id: "0" })).at(-1)!;
    expect(read.error).toBe("item_not_found");
  });

  for (const scenario of [
    { name: "oversized legacy ID", id: "x".repeat(20 * 1024), sequence: undefined },
    {
      name: "oversized ID with an invalid sequence",
      id: "x".repeat(20 * 1024),
      sequence: Number.MAX_SAFE_INTEGER + 1,
    },
    { name: "JSON-expanded control-character ID", id: "\u0000".repeat(1000), sequence: undefined },
  ]) {
    test(`search and exact read recover ${scenario.name} without prefix aliasing`, async () => {
      const addressablePrefix = scenario.id.slice(0, 100);
      await appendTrackedHistory(
        chatPath,
        [
          createMuxMessage(scenario.id, "assistant", "match unaddressable", {
            historySequence: scenario.sequence,
          }),
          createMuxMessage(addressablePrefix, "assistant", "match addressable prefix"),
          createMuxMessage("later", "assistant", "match later"),
        ]
          .map((message) => JSON.stringify(message))
          .join("\n") + "\n"
      );
      const result = (await pages({ action: "search", query: "match", limit: 1 })).flatMap(
        (page) => page.items ?? []
      );
      expect(result.map((item) => item.text)).toEqual([
        "match unaddressable",
        "match addressable prefix",
        "match later",
      ]);
      expect(
        (
          await pages({
            action: "read_item",
            item_id: result[0].itemId,
            window_id: result[0].windowId,
          })
        )
          .flatMap((page) => page.items ?? [])
          .map((item) => item.text)
      ).toEqual(["match unaddressable"]);
      expect(
        (await pages({ action: "read_item", item_id: `m:${addressablePrefix}` }))
          .flatMap((page) => page.items ?? [])
          .map((item) => item.text)
      ).toEqual(["match addressable prefix"]);
      expect(
        (await pages({ action: "read_item", item_id: "0" }))
          .flatMap((page) => page.items ?? [])
          .map((item) => item.text)
      ).toEqual(["opening facts"]);
    });
  }

  test.each([
    { manualReset: false, id: "b".repeat(20 * 1024) },
    { manualReset: true, id: "b".repeat(20 * 1024) },
    { manualReset: false, id: "\u0000".repeat(1000) },
    { manualReset: true, id: "\u0000".repeat(1000) },
  ])(
    "unaddressable legacy window IDs allow cursor progress without crossing a reset",
    async ({ manualReset, id }) => {
      const boundary = createMuxMessage(
        id,
        "assistant",
        "",
        manualReset
          ? { contextBoundaryKind: "reset", synthetic: true }
          : { compacted: true, compactionBoundary: true, compactionEpoch: 1 }
      );
      const rows = [
        boundary,
        ...Array.from({ length: 650 }, (_, i) =>
          createMuxMessage(
            `unaddressable-window-${i}`,
            "assistant",
            "facts in unaddressable window"
          )
        ),
        createMuxMessage("addressable-boundary", "assistant", "", rollover),
        createMuxMessage("public", "assistant", "public facts"),
      ];
      await appendTrackedHistory(
        chatPath,
        rows.map((message) => JSON.stringify(message)).join("\n") + "\n"
      );
      const windows = await pages({ action: "list_windows", limit: 1 });
      expect(windows.length).toBeGreaterThan(2);
      expect(
        windows.flatMap((page) => page.windows ?? []).map((window) => window.windowId)
      ).toEqual(manualReset ? ["w:m:addressable-boundary"] : ["w:0", "w:m:addressable-boundary"]);
      const matches = await pages({ action: "search", query: "facts", limit: 1 });
      expect(matches.flatMap((page) => page.items ?? []).map((item) => item.text)).toEqual(
        manualReset ? ["public facts"] : ["opening facts", "public facts"]
      );
      const older = await pages({ action: "read_item", item_id: "0" });
      if (manualReset) {
        expect(older.at(-1)?.error).toBe("item_not_found");
      } else {
        expect(older.flatMap((page) => page.items ?? []).map((item) => item.text)).toEqual([
          "opening facts",
        ]);
      }
    }
  );

  test("negative persisted sequences use legacy IDs without invalidating the next cursor", async () => {
    await appendTrackedHistory(
      chatPath,
      [
        createMuxMessage("negative-sequence", "assistant", "match negative", {
          historySequence: -1,
        }),
        createMuxMessage("after-negative", "assistant", "match after"),
      ]
        .map((message) => JSON.stringify(message))
        .join("\n") + "\n"
    );
    const found = (await pages({ action: "search", query: "match", limit: 1 })).flatMap(
      (page) => page.items ?? []
    );
    expect(found.map((item) => item.text)).toEqual(["match negative", "match after"]);
    expect(found[0].itemId).not.toBe(found[1].itemId);
    for (const [id, text] of [
      ["negative-sequence", "match negative"],
      ["after-negative", "match after"],
    ]) {
      expect((await call({ action: "read_item", item_id: `m:${id}` })).items?.[0]?.text).toBe(text);
    }
  });

  test("oversized persisted IDs remain addressable through safe sequences", async () => {
    const id = "s".repeat(20 * 1024);
    await appendTrackedHistory(
      chatPath,
      [
        createMuxMessage(id, "assistant", "", {
          compacted: true,
          compactionBoundary: true,
          compactionEpoch: 1,
          historySequence: 42,
        }),
        createMuxMessage(id + "-item", "assistant", "sequenced facts", { historySequence: 43 }),
      ]
        .map((message) => JSON.stringify(message))
        .join("\n") + "\n"
    );
    expect(
      (await pages({ action: "list_windows", limit: 1 }))
        .flatMap((page) => page.windows ?? [])
        .map((window) => window.windowId)
    ).toEqual(["w:0", "w:42"]);
    expect(
      (await pages({ action: "read_item", item_id: "43" })).flatMap((page) => page.items ?? [])
    ).toMatchObject([{ windowId: "w:42", role: "assistant", text: "sequenced facts" }]);
  });

  test("scanner fails closed when a reset races a page or a truncate is unresolved", async () => {
    expect(
      await fixture.historyService
        .scanHistoryBounded(workspaceId, {
          visit: () => {
            appendFileSync(
              chatPath,
              JSON.stringify(
                createMuxMessage("racing-reset", "assistant", "", { contextBoundaryKind: "reset" })
              ) + "\n"
            );
            return true;
          },
        })
        .then(
          () => null,
          (error: unknown) => error
        )
    ).toMatchObject({ message: "stale_cursor" });
    await fs.writeFile(`${archivePath}.truncate`, "pending transaction");
    expect((await call({ action: "search", query: "opening facts" })).error).toBe("stale_cursor");
  });

  test("bounded append validation advances across pages without exposing newly appended rows", async () => {
    await append("one", "match one");
    await append("two", "match two");
    const first = await call({ action: "search", query: "match", limit: 1 });
    const tail = Array.from({ length: 650 }, (_, i) =>
      createMuxMessage(`append-${i}`, "assistant", "match" + "z".repeat(4096))
    );
    await appendTrackedHistory(
      chatPath,
      tail.map((message) => JSON.stringify(message)).join("\n") + "\n"
    );
    let cursor = first.nextCursor;
    const results: SessionHistoryResult[] = [];
    do {
      const page = await call({ action: "search", query: "match", limit: 1, cursor });
      expect(page.success).toBe(true);
      expect(page.bytesRead).toBeLessThanOrEqual(SESSION_HISTORY_MAX_SCAN_BYTES);
      expect(page.rowsScanned).toBeLessThanOrEqual(SESSION_HISTORY_MAX_SCAN_ROWS);
      results.push(page);
      cursor = page.nextCursor;
      expect(results.length).toBeLessThan(10);
    } while (cursor);
    expect(results[0].items).toEqual([]);
    expect(results.flatMap((page) => page.items ?? []).map((item) => item.text)).toEqual([
      "match two",
    ]);
  });

  test("malformed lines do not hide surviving rows and a legacy reset still protects older IDs", async () => {
    await appendTrackedHistory(chatPath, "not-json\nnull\n");
    await appendTrackedHistory(
      chatPath,
      JSON.stringify(
        createMuxMessage("legacy-reset", "assistant", "", { contextBoundaryKind: "reset" })
      ) + "\n"
    );
    await appendTrackedHistory(
      chatPath,
      "broken-json\n" +
        JSON.stringify(createMuxMessage("after-legacy-reset", "assistant", "recoverable")) +
        "\n"
    );
    const result = await call({ action: "search", query: "recoverable" });
    expect(result.items?.[0]).toMatchObject({
      windowId: "w:m:legacy-reset",
    });
    expect(
      (await call({ action: "read_item", item_id: "m:after-legacy-reset" })).items?.[0]?.text
    ).toBe("recoverable");
    expect(result.malformedLines).toBeGreaterThan(0);
    expect((await call({ action: "read_item", item_id: "0" })).error).toBe("item_not_found");
  });

  test.each([
    '{"id":"broken-reset","role":"assistant","metadata":{"contextBoundaryKind" : "reset"},"parts":[',
    '{"role":"assistant","metadata":{"contextBoundaryKind":"reset"},"parts":[]}',
  ])("unreadable reset rows below the size cap protect list/search/read: %s", async (resetLine) => {
    const olderWindow = await append("private-boundary", "private summary", {
      compacted: true,
      compactionBoundary: true,
      compactionEpoch: 1,
    });
    const hidden = await append("private-item", "private-before-malformed-reset");
    await appendTrackedHistory(chatPath, resetLine + "\n");
    const publicBoundary = createMuxMessage("public-boundary", "assistant", "", {
      ...rollover,
      historySequence: 100,
    });
    await appendTrackedHistory(
      chatPath,
      [
        JSON.stringify(publicBoundary),
        "unrelated malformed row",
        JSON.stringify(
          createMuxMessage("public-item", "assistant", "public facts", { historySequence: 101 })
        ),
      ].join("\n") + "\n"
    );
    const windows = (await pages({ action: "list_windows" })).flatMap((page) => page.windows ?? []);
    expect(windows.map((window) => window.windowId)).toEqual(["w:100"]);
    expect(
      windows.some(
        (window) => window.windowId === `w:${String(olderWindow.metadata!.historySequence)}`
      )
    ).toBe(false);
    expect(
      (await pages({ action: "search", query: "private" })).flatMap((page) => page.items ?? [])
    ).toEqual([]);
    expect(
      (await pages({ action: "read_item", item_id: String(hidden.metadata!.historySequence) })).at(
        -1
      )?.error
    ).toBe("item_not_found");
    expect(
      (await pages({ action: "search", query: "public facts" }))
        .flatMap((page) => page.items ?? [])
        .map((item) => item.text)
    ).toEqual(["public facts"]);
  });

  const validRollover = {
    type: "context-window-rollover" as const,
    rolloverId: "validated-rollover",
    reason: "on-send" as const,
    previousWindowId: "w:0",
    flushOpportunity: false,
    contextTokens: 5000,
    maxTokens: 6000,
  };
  const resetCandidates = [
    { name: "user-role reset", role: "user", metadata: { contextBoundaryKind: "reset" } },
    {
      name: "user-role rollover",
      role: "user",
      metadata: { contextBoundaryKind: "reset", muxMetadata: validRollover },
    },
    { name: "invalid-role reset", role: "damaged", metadata: { contextBoundaryKind: "reset" } },
    {
      name: "array-shaped reset metadata",
      role: "assistant",
      metadata: [{ contextBoundaryKind: "reset" }],
    },
    {
      name: "type-only rollover",
      role: "assistant",
      metadata: { contextBoundaryKind: "reset", muxMetadata: { type: "context-window-rollover" } },
    },
    ...[
      { contextBudgetRejected: true },
      { contextBudgetRejected: "damaged" },
      { contextBudgetRejectedMessage: {} },
      { rlmPreservedTailCopy: true },
      { partial: true },
    ].map((conflict) => ({
      name: `rollover with conflicting ${Object.keys(conflict)[0]}`,
      role: "assistant",
      metadata: { contextBoundaryKind: "reset", muxMetadata: validRollover, ...conflict },
    })),
    ...Object.keys(validRollover).map((field) => {
      const partial: Record<string, unknown> = { ...validRollover };
      delete partial[field];
      return {
        name: `rollover missing ${field}`,
        role: "assistant",
        metadata: { contextBoundaryKind: "reset", muxMetadata: partial },
      };
    }),
    ...[
      { rolloverId: "" },
      { previousWindowId: "" },
      { reason: "unexpected" },
      { flushOpportunity: "yes" },
      { contextTokens: -1 },
      { contextTokens: "5000" },
      { maxTokens: 0 },
    ].map((invalid) => ({
      name: `rollover with invalid ${Object.keys(invalid)[0]}`,
      role: "assistant",
      metadata: { contextBoundaryKind: "reset", muxMetadata: { ...validRollover, ...invalid } },
    })),
  ];
  for (const candidate of resetCandidates) {
    test(`${candidate.name} remains a privacy floor for direct and resumed scans`, async () => {
      const privateBoundary = await append("private-boundary", "summary", {
        compacted: true,
        compactionBoundary: true,
        compactionEpoch: 1,
      });
      const hidden = await append("private-item", "private facts");
      const first = await call({ action: "search", query: "facts", limit: 1 });
      expect(first.nextCursor).toBeString();
      // Decoded JSON keys/values must agree with compact raw-marker detection,
      // including when malformed message/metadata shape makes the row unreadable.
      const resetLine = JSON.stringify({ id: "candidate-reset", parts: [], ...candidate }).replace(
        '"contextBoundaryKind":"reset"',
        '"contextBoundary\\u004bind" \t: "r\\u0065set"'
      );
      await appendTrackedHistory(
        chatPath,
        resetLine +
          "\n" +
          JSON.stringify(createMuxMessage("after-candidate", "assistant", "public facts")) +
          "\n"
      );
      expect(
        (await call({ action: "search", query: "facts", cursor: first.nextCursor })).error
      ).toBe("stale_cursor");
      expect(
        (await pages({ action: "search", query: "facts" }))
          .flatMap((page) => page.items ?? [])
          .map((item) => item.text)
      ).toEqual(["public facts"]);
      expect(
        (
          await pages({ action: "read_item", item_id: String(hidden.metadata!.historySequence) })
        ).at(-1)?.error
      ).toBe("item_not_found");
      expect(
        (await pages({ action: "list_windows" }))
          .flatMap((page) => page.windows ?? [])
          .some(
            (window) => window.windowId === `w:${String(privateBoundary.metadata!.historySequence)}`
          )
      ).toBe(false);
    });
  }

  test("genuine persisted rollovers retain their exemption with writer-added envelope metadata", async () => {
    await append("private-before-genuine", "earlier facts");
    const [boundary, leadIn] = createRolloverPrefix(validRollover);
    boundary.metadata = {
      ...boundary.metadata,
      model: "openai:gpt-4o",
      partial: false,
      rlmPreservedTailCopy: false,
    };
    expect(
      (await fixture.historyService.appendManyToHistory(workspaceId, [boundary, leadIn])).success
    ).toBe(true);
    expect((await fs.readFile(chatPath, "utf8")).includes('"workspaceId":')).toBe(true);
    expect(boundary.metadata?.historySequence).toBeNumber();
    const found = (await pages({ action: "search", query: "facts" })).flatMap(
      (page) => page.items ?? []
    );
    expect(found.map((item) => item.text)).toEqual(["opening facts", "earlier facts"]);
  });

  test("deep parseable reset metadata cannot lose privacy during canonicalization", async () => {
    const resetLine =
      '{"id":"deep-reset","role":"user","parts":[],"metadata":{"contextBoundary\\u004bind":"reset"},"extra":' +
      "[".repeat(10000) +
      "0" +
      "]".repeat(10000) +
      "}";
    await appendTrackedHistory(chatPath, resetLine + "\n");
    expect((await pages({ action: "read_item", item_id: "0" })).at(-1)?.error).toBe(
      "item_not_found"
    );
  });

  test("a populated reset row cannot impersonate a complete rollover boundary", async () => {
    await appendTrackedHistory(
      chatPath,
      JSON.stringify(
        createMuxMessage("populated-rollover", "assistant", "not a boundary-only row", {
          contextBoundaryKind: "reset",
          muxMetadata: validRollover,
        })
      ) + "\n"
    );
    expect((await pages({ action: "read_item", item_id: "0" })).at(-1)?.error).toBe(
      "item_not_found"
    );
  });

  test("complete production rollover boundaries remain traversable in initial and appended scans", async () => {
    await append("private-item", "older facts");
    const first = await call({ action: "search", query: "facts", limit: 1 });
    const [boundary, leadIn] = createRolloverPrefix(validRollover);
    await appendTrackedHistory(
      chatPath,
      [boundary, leadIn, createMuxMessage("after-rollover", "assistant", "newer facts")]
        .map((message) => JSON.stringify(message))
        .join("\n") + "\n"
    );
    const resumed = await call({ action: "search", query: "facts", cursor: first.nextCursor });
    expect(resumed.success).toBe(true);
    expect(resumed.items?.map((item) => item.text)).toEqual(["older facts"]);
    expect(
      (await pages({ action: "search", query: "facts" }))
        .flatMap((page) => page.items ?? [])
        .map((item) => item.text)
    ).toEqual(["opening facts", "older facts", "newer facts"]);
  });

  test("an appended malformed reset invalidates an existing cursor", async () => {
    await append("one", "match one");
    await append("two", "match two");
    const first = await call({ action: "search", query: "match", limit: 1 });
    expect(first.nextCursor).toBeString();
    await appendTrackedHistory(chatPath, '{"metadata":{"contextBoundaryKind":"reset"},"parts":[\n');
    expect((await call({ action: "search", query: "match", cursor: first.nextCursor })).error).toBe(
      "stale_cursor"
    );
  });

  test("lists root, sequenced compactions, heartbeat/rollover windows and legacy IDs", async () => {
    const compact = await append("compact", "summary", {
      compacted: "user",
      compactionBoundary: true,
      compactionEpoch: 1,
    });
    const heartbeat = await append("heartbeat", "heartbeat summary", {
      compacted: "heartbeat",
      compactionBoundary: true,
      compactionEpoch: 2,
    });
    const roll = await append("roll", "", rollover);
    await append("recent", "recent facts");
    // Legacy imported rows predate historySequence; real disk fixture is needed
    // because appendToHistory correctly assigns a sequence to all new writes.
    const legacy = createMuxMessage("legacy-boundary", "assistant", "legacy summary", {
      compacted: true,
      compactionBoundary: true,
      compactionEpoch: 3,
    });
    await appendTrackedHistory(
      chatPath,
      JSON.stringify(legacy) +
        "\n" +
        JSON.stringify(createMuxMessage("legacy-item", "assistant", "legacy facts")) +
        "\n"
    );
    const windows = (await pages({ action: "list_windows", limit: 1 })).flatMap(
      (page) => page.windows ?? []
    );
    expect(windows).toEqual([
      { windowId: "w:0", boundaryKind: "root" },
      { windowId: `w:${String(compact.metadata!.historySequence)}`, boundaryKind: "compaction" },
      { windowId: `w:${String(heartbeat.metadata!.historySequence)}`, boundaryKind: "compaction" },
      { windowId: `w:${String(roll.metadata!.historySequence)}`, boundaryKind: "reset" },
      { windowId: "w:m:legacy-boundary", boundaryKind: "compaction" },
    ]);
    expect((await call({ action: "read_item", item_id: "m:legacy-item" })).items?.[0]?.text).toBe(
      "legacy facts"
    );
    expect(
      (
        await call({
          action: "search",
          query: "facts",
          window_id: `w:${String(roll.metadata!.historySequence)}`,
        })
      ).items?.map((item) => item.text)
    ).toEqual(["recent facts"]);
  });

  for (const readable of [true, false]) {
    test.each([1, SESSION_HISTORY_MAX_SCAN_ROWS - 2])(
      `post-reset windows retain only verified boundary metadata (readable: ${readable}, rows: %s)`,
      async (tailLength) => {
        const reset = readable
          ? JSON.stringify(
              createMuxMessage("manual-reset", "assistant", "", {
                contextBoundaryKind: "reset",
                historySequence: 42,
              })
            )
          : '{"metadata":{"contextBoundaryKind":"reset"},broken';
        await appendTrackedHistory(
          chatPath,
          [
            reset,
            ...Array.from({ length: tailLength }, (_, index) =>
              JSON.stringify(createMuxMessage(`post-reset-${index}`, "assistant", "public facts"))
            ),
            JSON.stringify(
              createMuxMessage("later-compaction", "assistant", "public summary", {
                compacted: true,
                compactionBoundary: true,
                compactionEpoch: 1,
                historySequence: 1000,
              })
            ),
          ].join("\n") + "\n"
        );
        const listed = await pages({ action: "list_windows", limit: 1 });
        if (tailLength > 1) {
          // The reverse scan reaches its row cap at the floor; its boundary
          // metadata must survive the signed cursor before any browse row runs.
          expect(listed[0].windows).toEqual([]);
          expect(listed[0].nextCursor).toBeString();
        }
        expect(listed.flatMap((page) => page.windows ?? [])).toEqual([
          { windowId: readable ? "w:42" : "w:0", boundaryKind: readable ? "reset" : "root" },
          { windowId: "w:1000", boundaryKind: "compaction" },
        ]);
        expect((await pages({ action: "read_item", item_id: "0" })).at(-1)?.error).toBe(
          "item_not_found"
        );
        expect(
          (await pages({ action: "search", query: "opening facts" })).flatMap(
            (page) => page.items ?? []
          )
        ).toEqual([]);
      }
    );
  }

  test("plain manual reset is a privacy floor even for arbitrary IDs and multi-page floor discovery", async () => {
    const hidden = await append("hidden", "private-before-reset");
    await append("reset", "", { contextBoundaryKind: "reset", synthetic: true });
    const tail = Array.from({ length: 650 }, (_, i) =>
      createMuxMessage(`tail-${i}`, "assistant", `public-${i}`, { historySequence: 1000 + i })
    );
    await appendTrackedHistory(
      chatPath,
      tail.map((message) => JSON.stringify(message)).join("\n") + "\n"
    );
    const first = await call({
      action: "read_item",
      item_id: String(hidden.metadata!.historySequence),
    });
    expect(first.items).toEqual([]);
    expect(first.nextCursor).toBeString();
    expect(first.exhausted).toBe(false);
    const all = await pages({ action: "search", query: "private-before-reset", window_id: "w:0" });
    expect(all.flatMap((page) => page.items ?? [])).toEqual([]);
    expect(all.at(-1)?.exhausted).toBe(true);
    expect(
      (await pages({ action: "read_item", item_id: String(hidden.metadata!.historySequence) })).at(
        -1
      )?.error
    ).toBe("item_not_found");
    const envelope = JSON.parse(Buffer.from(first.nextCursor!, "base64url").toString()) as {
      data: string;
      signature: string;
    };
    const forged = JSON.parse(envelope.data) as {
      scan: { phase: string; artifact: string; byteOffset: number };
    };
    forged.scan.phase = "browse";
    forged.scan.artifact = "archive";
    forged.scan.byteOffset = 0;
    envelope.data = JSON.stringify(forged);
    expect(
      (
        await call({
          action: "read_item",
          item_id: String(hidden.metadata!.historySequence),
          cursor: Buffer.from(JSON.stringify(envelope)).toString("base64url"),
        })
      ).error
    ).toBe("invalid_cursor");
  });

  test("search and read retain media-shaped ordinary tool JSON and literal data URLs", async () => {
    const records = ["file", "image", "image_url", "audio", "video", "media"].map((type) => ({
      type,
      content: `ordinary-${type} facts 🧭`,
    }));
    const input = {
      type: "file",
      mediaType: "text/plain",
      data: "ordinary input facts",
      example: { type: "media", mediaType: "image/png", data: "ordinary argument bytes" },
    };
    const output = {
      nested: records,
      image: { type: "image", image: "ordinary image payload" },
      file: { type: "file", mediaType: "image/png", url: "data:image/png;base64,ordinary literal" },
    };
    const message = await append("media-lookalikes", "", undefined, [
      {
        type: "dynamic-tool",
        toolCallId: "ordinary-json",
        toolName: "bash",
        state: "output-available",
        input,
        output,
      },
    ]);
    for (const query of [
      ...records.map((record) => record.content),
      input.data,
      input.example.data,
      output.file.url,
    ]) {
      const found = (await pages({ action: "search", query })).flatMap((page) => page.items ?? []);
      expect(found).toHaveLength(1);
      expect(found[0].text).toContain(query);
    }
    let offset: number | undefined = 0;
    const chunks: string[] = [];
    while (offset !== undefined) {
      const read = await call({
        action: "read_item",
        item_id: String(message.metadata!.historySequence),
        offset_chars: offset,
        limit_chars: 37,
      });
      expect(read.success).toBe(true);
      expect(read.exhausted).toBe(true);
      expect(read.nextCursor).toBeUndefined();
      const item = read.items![0];
      expect(Buffer.from(item.text).toString("utf8")).toBe(item.text);
      chunks.push(item.text);
      offset = item.nextCharOffset;
      expect(chunks.length).toBeLessThan(40);
    }
    expect(JSON.parse(chunks.join(""))).toMatchObject({ input, output });
  });

  test.each([false, true])(
    "missing item references fail only after scan exhaustion (stale physical reference: %s)",
    async (stale) => {
      const target = await append("reference-target", "before rewrite");
      const reference = await call({
        action: "read_item",
        item_id: String(target.metadata!.historySequence),
      });
      expect(reference.success).toBe(true);
      const itemId = stale ? reference.items![0].itemId : "m:missing";
      const raw = await fs.readFile(chatPath, "utf8");
      await fs.writeFile(chatPath, raw.replace("before rewrite", "after rewriting"));
      await appendTrackedHistory(
        chatPath,
        Array.from({ length: SESSION_HISTORY_MAX_SCAN_ROWS + 1 }, (_, index) =>
          JSON.stringify(createMuxMessage(`padding-${index}`, "assistant", "padding"))
        ).join("\n") + "\n"
      );
      const results: SessionHistoryResult[] = [];
      let cursor: string | undefined;
      do {
        const page = await call({ action: "read_item", item_id: itemId, cursor });
        results.push(page);
        cursor = page.nextCursor;
        expect(page.items).toEqual([]);
        expect(results.length).toBeLessThan(10);
        if (cursor) {
          expect(page.success).toBe(true);
          expect(page.exhausted).toBe(false);
          expect(page.error).toBeUndefined();
        }
      } while (cursor);
      expect(results.length).toBeGreaterThan(1);
      expect(results.at(-1)).toMatchObject({
        success: false,
        exhausted: true,
        error: "item_not_found",
      });
    }
  );

  test("suppresses hidden synthetic requests, copied tails and reasoning; redacts media and nested history", async () => {
    await append("hidden", "private needle", { synthetic: true });
    await append("rejected", "private needle", { contextBudgetRejected: true });
    await append("copy", "private needle", { rlmPreservedTailCopy: true });
    await append("compact-request", "private needle", {
      muxMetadata: { type: "compaction-request", rawCommand: "/compact", parsed: {} },
    });
    await append("visible", "visible needle", { synthetic: true, uiVisible: true });
    const mixed = await append("mixed", "normal needle", undefined, [
      { type: "reasoning", text: "private needle" },
      { type: "file", mediaType: "image/png", url: "data:image/png;base64,private needle" },
      {
        type: "dynamic-tool",
        toolCallId: "ptc",
        toolName: "code_execution",
        state: "output-available",
        input: {},
        nestedCalls: [
          {
            toolCallId: "nested-media",
            toolName: "attach_file",
            state: "output-available",
            input: { type: "file", content: "nested ordinary needle" },
            output: { type: "media", mediaType: "image/png", data: "private needle" },
          },
        ],
        output: {
          nestedCalls: [
            { toolName: "session_history", output: "private needle" },
            {
              toolName: "attach_file",
              output: {
                type: "content",
                value: [
                  { type: "media", mediaType: "image/png", data: "private needle" },
                  { type: "display_file", mediaType: "application/zip", data: "private needle" },
                ],
              },
            },
          ],
          stdout: "safe",
        },
      },
    ]);
    expect((await call({ action: "search", query: "private needle" })).items).toEqual([]);
    expect((await call({ action: "search", query: "NEEDLE" })).items?.length).toBe(2);
    const read = await call({
      action: "read_item",
      item_id: String(mixed.metadata!.historySequence),
    });
    expect(read.items?.[0]?.text).toContain("safe");
    expect(read.items?.[0]?.text).toContain("nested ordinary needle");
    expect(read.items?.[0]?.text).not.toContain("private needle");
  });

  test("search is literal, pages matches without duplicates, and read_item pages characters", async () => {
    const first = await append("literal", "A [x].* literal");
    await append("other", "another [X].* value");
    await append("regex-decoy", "xZZZ value");
    const all = (await pages({ action: "search", query: "[x].*", limit: 1 })).flatMap(
      (page) => page.items ?? []
    );
    expect(all.map((item) => item.text)).toEqual(["A [x].* literal", "another [X].* value"]);
    const read = await call({
      action: "read_item",
      item_id: String(first.metadata!.historySequence),
      offset_chars: 2,
      limit_chars: 5,
    });
    expect(read.items?.[0]?.text).toBe("[x].*");
    expect(read.items?.[0]?.nextCharOffset).toBe(7);
  });

  test.each([false, true])(
    "same-window duplicate sequences expose exact row IDs (same message ID: %s)",
    async (sameId) => {
      const first = createMuxMessage("duplicate-first", "assistant", "needle first payload", {
        historySequence: 7,
      });
      const text = "needle second payload " + "distinct second-row content ".repeat(400);
      const second = createMuxMessage(sameId ? first.id : "duplicate-second", "assistant", text, {
        historySequence: 7,
      });
      await appendTrackedHistory(
        chatPath,
        [first, second].map((row) => JSON.stringify(row)).join("\n") + "\n"
      );
      const found = (await pages({ action: "search", query: "needle", limit: 1 })).flatMap(
        (page) => page.items ?? []
      );
      expect(found).toHaveLength(2);
      expect(found[0].windowId).toBe(found[1].windowId);
      expect(found[0].itemId).not.toBe(found[1].itemId);
      const chunks: string[] = [];
      let offset: number | undefined = 0;
      while (offset !== undefined) {
        const result = await call({
          action: "read_item",
          item_id: found[1].itemId,
          window_id: found[1].windowId,
          offset_chars: offset,
          limit_chars: 4000,
        });
        expect(result.success).toBe(true);
        expect(result.items).toHaveLength(1);
        expect(result.items![0].itemId).toBe(found[1].itemId);
        chunks.push(result.items![0].text);
        const previousOffset = offset;
        offset = result.items![0].nextCharOffset;
        if (offset !== undefined) {
          expect(offset).toBeGreaterThan(previousOffset);
          expect(chunks.length).toBeLessThan(10);
          // An ordinary append must not move the physical identity between read pages.
          await append(`after-page-${chunks.length}`, "later unrelated row");
        }
      }
      expect(chunks.join("")).toBe(text);
      const legacy = await call({ action: "read_item", item_id: "7" });
      expect(legacy.items?.[0]?.text).toBe("needle first payload");
    }
  );

  test("an exact row ID does not resolve to a rewritten payload or cross a later reset", async () => {
    const original = createMuxMessage("original", "assistant", "needle before rewrite", {
      historySequence: 8,
    });
    await appendTrackedHistory(chatPath, JSON.stringify(original) + "\n");
    const found = (await pages({ action: "search", query: "needle" })).flatMap(
      (page) => page.items ?? []
    )[0];
    const raw = await fs.readFile(chatPath, "utf8");
    await fs.writeFile(chatPath, raw.replace("needle before rewrite", "needle after rewriting"));
    expect((await pages({ action: "read_item", item_id: found.itemId })).at(-1)?.error).toBe(
      "item_not_found"
    );
    const current = (await pages({ action: "search", query: "needle" })).flatMap(
      (page) => page.items ?? []
    )[0];
    await appendTrackedHistory(
      chatPath,
      JSON.stringify(
        createMuxMessage("manual-reset", "assistant", "", { contextBoundaryKind: "reset" })
      ) + "\n"
    );
    expect((await pages({ action: "read_item", item_id: current.itemId })).at(-1)?.error).toBe(
      "item_not_found"
    );
  });

  test("identical physical copies have distinct references that expire after a rewrite", async () => {
    const row =
      JSON.stringify(
        createMuxMessage("identical", "assistant", "needle identical payload", {
          historySequence: 9,
        })
      ) + "\n";
    await fs.writeFile(chatPath, row + row);
    const found = (await pages({ action: "search", query: "needle", limit: 1 })).flatMap(
      (page) => page.items ?? []
    );
    expect(found).toHaveLength(2);
    expect(found[0].itemId).not.toBe(found[1].itemId);
    for (const item of found) {
      expect((await call({ action: "read_item", item_id: item.itemId })).items?.[0]?.text).toBe(
        "needle identical payload"
      );
    }
    // Removing the first physical copy moves identical bytes onto its old offset.
    await fs.writeFile(chatPath, row);
    for (const item of found) {
      expect((await pages({ action: "read_item", item_id: item.itemId })).at(-1)?.error).toBe(
        "item_not_found"
      );
    }
    const current = (await pages({ action: "search", query: "needle" })).flatMap(
      (page) => page.items ?? []
    )[0];
    expect((await call({ action: "read_item", item_id: current.itemId })).items?.[0]?.text).toBe(
      "needle identical payload"
    );
  });

  test("rotation expires exact references without hiding the relocated row from a new search", async () => {
    await append("relocated", "needle archived payload");
    const previous = (await pages({ action: "search", query: "needle" })).flatMap(
      (page) => page.items ?? []
    )[0];
    await append("rotate", "summary", {
      compacted: true,
      compactionBoundary: true,
      compactionEpoch: 1,
    });
    expect((await pages({ action: "read_item", item_id: previous.itemId })).at(-1)?.error).toBe(
      "item_not_found"
    );
    const current = (await pages({ action: "search", query: "needle" })).flatMap(
      (page) => page.items ?? []
    )[0];
    expect((await call({ action: "read_item", item_id: current.itemId })).items?.[0]?.text).toBe(
      "needle archived payload"
    );
  });

  test("empty queries are rejected and zero-width regexp syntax remains literal", async () => {
    expect((await call({ action: "search", query: "" })).error).toBe("query_required");
    await append("literal-zero-width", "literal ^ $ (?=x) \\b markers");
    await append("zero-width-decoy", "x ordinary text");
    for (const query of ["^", "$", "(?=x)", "\\b"]) {
      expect(
        (await pages({ action: "search", query }))
          .flatMap((page) => page.items ?? [])
          .map((item) => item.text)
      ).toEqual(["literal ^ $ (?=x) \\b markers"]);
    }
  });

  test("literal case-insensitive snippets use original offsets after expanding Unicode lowercases", async () => {
    const query = "[NeEdLe].*\\(x)?";
    const text = "İ".repeat(300) + query + " trailing context";
    await append("unicode-prefix", text);
    await append("regex-decoy", "İ".repeat(300) + "needleZZZx");
    const found = (await pages({ action: "search", query: query.toLowerCase() })).flatMap(
      (page) => page.items ?? []
    );
    expect(found).toHaveLength(1);
    expect(found[0].text).toContain(query);
    expect(found[0].text).toBe(text.slice(180));
  });

  test.each([1, 2, 3])(
    "UTF-16 character pages preserve astral pairs with limit %s",
    async (limit) => {
      const text = "😀A🧑B🚀C😀";
      const message = await append("astral-pages", text);
      let offset: number | undefined = 0;
      let recovered = "";
      let count = 0;
      while (offset !== undefined) {
        const page = await call({
          action: "read_item",
          item_id: String(message.metadata!.historySequence),
          offset_chars: offset,
          limit_chars: limit,
        });
        expect(page.success).toBe(true);
        expect(page.items).toHaveLength(1);
        const item = page.items![0];
        expect(Buffer.from(item.text, "utf8").toString("utf8")).toBe(item.text);
        expect(item.text.length).toBeGreaterThan(0);
        recovered += item.text;
        if (item.nextCharOffset !== undefined) {
          expect(item.nextCharOffset).toBeGreaterThan(offset);
          expect(item.nextCharOffset).toBe(recovered.length);
        }
        offset = item.nextCharOffset;
        expect(++count).toBeLessThan(20);
      }
      expect(recovered).toBe(text);
    }
  );

  test("manual offsets inside a surrogate pair round back and EOF offsets finish", async () => {
    const message = await append("manual-astral-offset", "A😀B");
    const inside = await call({
      action: "read_item",
      item_id: String(message.metadata!.historySequence),
      offset_chars: 2,
      limit_chars: 1,
    });
    expect(inside.items?.[0]?.text).toBe("😀");
    expect(inside.items?.[0]?.nextCharOffset).toBe(3);
    for (const offset of [4, 100]) {
      const end = await call({
        action: "read_item",
        item_id: String(message.metadata!.historySequence),
        offset_chars: offset,
        limit_chars: 1,
      });
      expect(end.items?.[0]?.text).toBe("");
      expect(end.items?.[0]?.nextCharOffset).toBeUndefined();
      expect(end.nextCursor).toBeUndefined();
      expect(end.exhausted).toBe(true);
    }
    const empty = await append("empty-page", "");
    const end = await call({
      action: "read_item",
      item_id: String(empty.metadata!.historySequence),
      limit_chars: 1,
    });
    expect(end.nextCursor).toBeUndefined();
    expect(end.exhausted).toBe(true);
  });

  test("JSON-budget shrinking preserves emoji pairs and exact continuation offsets", async () => {
    const text = '"\\'.repeat(100) + "😀".repeat(4501);
    const message = await append("budget-astral", text);
    let offset: number | undefined = 0;
    let recovered = "";
    let shrank = false;
    while (offset !== undefined) {
      const page = await call({
        action: "read_item",
        item_id: String(message.metadata!.historySequence),
        offset_chars: offset,
        limit_chars: 16000,
      });
      expect(Buffer.byteLength(JSON.stringify(page))).toBeLessThanOrEqual(
        SESSION_HISTORY_MAX_RESULT_BYTES
      );
      const item = page.items![0];
      expect(Buffer.from(item.text, "utf8").toString("utf8")).toBe(item.text);
      expect(item.text.length).toBeGreaterThan(0);
      recovered += item.text;
      shrank ||= page.truncated === true;
      if (item.nextCharOffset !== undefined) {
        expect(item.nextCharOffset).toBeGreaterThan(offset);
        expect(item.nextCharOffset).toBe(recovered.length);
      }
      offset = item.nextCharOffset;
    }
    expect(shrank).toBe(true);
    expect(recovered).toBe(text);
  });

  test("search snippet boundaries cannot split surrogate pairs", async () => {
    const starts = "x".repeat(100) + "😀" + "x".repeat(119) + "needle";
    const ends = "needle" + "x".repeat(493) + "😀tail";
    await append("astral-snippet-start", starts);
    await append("astral-snippet-end", ends);
    const found = (await pages({ action: "search", query: "needle" })).flatMap(
      (page) => page.items ?? []
    );
    expect(found).toHaveLength(2);
    for (const item of found) {
      expect(Buffer.from(item.text, "utf8").toString("utf8")).toBe(item.text);
      expect(item.text).toContain("needle");
    }
    expect(found[0].text).toBe(starts.slice(100));
    expect(found[1].nextCharOffset).toBe(499);
    expect(
      (
        await call({
          action: "read_item",
          item_id: found[1].itemId,
          offset_chars: found[1].nextCharOffset,
          limit_chars: 1,
        })
      ).items?.[0]?.text
    ).toBe("😀");
  });

  test("already-unpaired stored surrogates are replaced only in output without shifting offsets", async () => {
    const message = await append("unpaired-source", "\ud800A\udc00😀");
    const before = await fs.readFile(chatPath);
    const page = await call({
      action: "read_item",
      item_id: String(message.metadata!.historySequence),
      limit_chars: 3,
    });
    expect(page.items?.[0]?.text).toBe("\ufffdA\ufffd");
    expect(page.items?.[0]?.nextCharOffset).toBe(3);
    expect(await fs.readFile(chatPath)).toEqual(before);
  });

  test("default read returns 8000 fitting ASCII characters and snake-case inputs resume the remainder", async () => {
    const text = "a".repeat(8000) + "remaining".repeat(250);
    const message = await append("paged-item", text);
    const first = await call({
      action: "read_item",
      item_id: String(message.metadata!.historySequence),
      window_id: null,
      offset_chars: null,
      limit_chars: null,
      cursor: null,
      limit: null,
    });
    expect(first.items?.[0]?.text).toBe(text.slice(0, 8000));
    expect(first.items?.[0]?.nextCharOffset).toBe(8000);
    expect(first.exhausted).toBe(true);
    expect(first.skipped_oversized_rows).toBe(0);
    const second = await call({
      action: "read_item",
      item_id: first.items![0].itemId,
      window_id: first.items![0].windowId,
      offset_chars: first.items![0].nextCharOffset,
    });
    expect(second.items?.[0]?.text).toBe(text.slice(8000));
    expect(second.items?.[0]?.nextCharOffset).toBeUndefined();
    expect(second.exhausted).toBe(true);
    expect(
      (
        await call({
          action: "read_item",
          item_id: first.items![0].itemId,
          window_id: "w:missing",
        })
      ).error
    ).toBe("item_not_found");
    expect(Buffer.byteLength(JSON.stringify(first))).toBeLessThanOrEqual(
      SESSION_HISTORY_MAX_RESULT_BYTES
    );
  });

  test("oversized rows consume bounded bytes and resume mid-line, then recover newer data", async () => {
    await appendTrackedHistory(
      chatPath,
      JSON.stringify(
        createMuxMessage("giant", "assistant", "", undefined, [
          {
            type: "dynamic-tool",
            toolCallId: "giant-tool",
            toolName: "bash",
            state: "output-available",
            input: {},
            output: { stdout: "x".repeat(5 * 1024 * 1024) },
          },
        ])
      ) + "\n"
    );
    await appendTrackedHistory(
      chatPath,
      JSON.stringify(createMuxMessage("after", "assistant", "recover me")) + "\n"
    );
    const all = await pages({ action: "search", query: "recover me" });
    expect(all.length).toBeGreaterThanOrEqual(3);
    expect(all.reduce((sum, page) => sum + page.skipped_oversized_rows, 0)).toBe(2);
    expect(all.flatMap((page) => page.items ?? []).map((item) => item.text)).toEqual([
      "recover me",
    ]);
    const size = (await fs.stat(chatPath)).size;
    expect(all.reduce((sum, page) => sum + (page.bytesRead ?? 0), 0)).toBeLessThan(
      size * 2 + 1024 * 1024 + 128 * 1024
    );
    expect(
      (await pages({ action: "search", query: "opening facts" }))
        .flatMap((page) => page.items ?? [])
        .map((item) => item.text)
    ).toEqual(["opening facts"]);
  });

  for (const junk of [
    "X",
    "???/#",
    "unexpected words",
    "[]{}=,",
    "😀",
    "printable-junk".repeat(200000),
  ]) {
    test(`malformed separator ${junk.slice(0, 24)} preserves initial and appended reset privacy`, async () => {
      await append("private", "private facts");
      const first = await call({ action: "search", query: "facts", limit: 1 });
      const key =
        junk.length > 1000 ? unicodeEscapes("contextBoundaryKind") : "contextBoundaryKind";
      const value = junk.length > 1000 ? unicodeEscapes("reset") : "reset";
      await appendTrackedHistory(
        chatPath,
        `{"id":"junk-reset","role":"assistant","metadata":{"${key}"${junk}:${junk}"${value}"},"parts":[]}\n` +
          JSON.stringify(createMuxMessage("after-junk-reset", "assistant", "public facts")) +
          "\n"
      );
      let cursor = first.nextCursor;
      let result: SessionHistoryResult;
      let pageCount = 0;
      do {
        result = await call({ action: "search", query: "facts", cursor });
        if (result.success) {
          expect(result.items).toEqual([]);
          expect(result.bytesRead).toBeLessThanOrEqual(SESSION_HISTORY_MAX_SCAN_BYTES);
          expect(result.rowsScanned).toBeLessThanOrEqual(SESSION_HISTORY_MAX_SCAN_ROWS);
        }
        expect(Buffer.byteLength(JSON.stringify(result))).toBeLessThanOrEqual(
          SESSION_HISTORY_MAX_RESULT_BYTES
        );
        cursor = result.nextCursor;
        expect(++pageCount).toBeLessThan(12);
      } while (cursor);
      expect(result.error).toBe("stale_cursor");
      expect(
        (await pages({ action: "search", query: "facts" }))
          .flatMap((page) => page.items ?? [])
          .map((item) => item.text)
      ).toEqual(["public facts"]);
      expect((await pages({ action: "read_item", item_id: "0" })).at(-1)?.error).toBe(
        "item_not_found"
      );
    });
  }

  test("valid non-reset fields cannot be joined by the malformed-token recognizer", async () => {
    await appendTrackedHistory(
      chatPath,
      JSON.stringify(
        createMuxMessage("not-a-reset", "assistant", "facts remain readable", {
          contextBoundaryKind: undefined,
        })
      ).replace('"metadata":{}', '"metadata":{"contextBoundaryKind":"normal","other":"reset"}') +
        "\n"
    );
    expect(
      (await pages({ action: "read_item", item_id: "0" }))
        .flatMap((page) => page.items ?? [])
        .map((item) => item.text)
    ).toEqual(["opening facts"]);
  });

  test.each([
    '"reset" junk : junk "contextBoundaryKind"',
    '"contextBoundaryKinds" junk : junk "reset"',
    '"contextBoundaryKind" junk : junk "resume"',
  ])("unrelated malformed tokens do not create a reset: %s", async (fragment) => {
    await appendTrackedHistory(chatPath, fragment + "\n");
    expect(
      (await pages({ action: "read_item", item_id: "0" }))
        .flatMap((page) => page.items ?? [])
        .map((item) => item.text)
    ).toEqual(["opening facts"]);
  });

  for (const separator of [
    String.fromCharCode(0),
    String.fromCharCode(11),
    String.fromCharCode(12),
    String.fromCharCode(31),
    String.fromCharCode(127),
    "\\u0000",
  ]) {
    test(`control separator ${separator.charCodeAt(0)} cannot hide a reset in initial or appended scans`, async () => {
      await append("private", "private facts");
      const first = await call({ action: "search", query: "facts", limit: 1 });
      const marker = `"contextBoundaryKind"${separator}:${separator}"reset"`;
      await appendTrackedHistory(
        chatPath,
        `{"id":"control-reset","role":"assistant","parts":[],"metadata":{${marker}}}\n` +
          JSON.stringify(createMuxMessage("public", "assistant", "public facts")) +
          "\n"
      );
      expect(
        (await call({ action: "search", query: "facts", cursor: first.nextCursor })).error
      ).toBe("stale_cursor");
      expect(
        (await pages({ action: "search", query: "facts" }))
          .flatMap((page) => page.items ?? [])
          .map((item) => item.text)
      ).toEqual(["public facts"]);
      expect((await pages({ action: "read_item", item_id: "0" })).at(-1)?.error).toBe(
        "item_not_found"
      );
    });
  }

  test.each([String.fromCharCode(0), "\\u0000"])(
    "oversized control separators retain a bounded reset probe across pages",
    async (separator) => {
      await append("private", "private facts");
      const first = await call({ action: "search", query: "facts", limit: 1 });
      const marker =
        '"contextBoundaryKind"' +
        separator.repeat(Math.ceil(SESSION_HISTORY_MAX_SCAN_BYTES / separator.length)) +
        ':"' +
        unicodeEscapes("reset") +
        '"';
      await appendTrackedHistory(
        chatPath,
        `{"id":"giant-control-reset","role":"assistant","parts":[],"metadata":{${marker}},"padding":"${"x".repeat(SESSION_HISTORY_MAX_SCAN_BYTES)}"}\n`
      );
      let cursor = first.nextCursor;
      let result: SessionHistoryResult;
      let pageCount = 0;
      do {
        result = await call({ action: "search", query: "facts", cursor });
        if (result.success) {
          expect(result.items).toEqual([]);
          expect(result.bytesRead).toBeLessThanOrEqual(SESSION_HISTORY_MAX_SCAN_BYTES);
          expect(result.rowsScanned).toBeLessThanOrEqual(SESSION_HISTORY_MAX_SCAN_ROWS);
        }
        cursor = result.nextCursor;
        expect(++pageCount).toBeLessThan(10);
      } while (cursor);
      expect(result.error).toBe("stale_cursor");
      expect((await pages({ action: "read_item", item_id: "0" })).at(-1)?.error).toBe(
        "item_not_found"
      );
    }
  );

  test("rotation does not normalize away raw reset evidence in a sequence-covered row", async () => {
    await append("private", "private facts");
    await append("sealed-boundary", "summary", {
      compacted: true,
      compactionBoundary: true,
      compactionEpoch: 1,
    });
    const original = (await fs.readFile(archivePath, "utf8")).split("\n")[0];
    const repaired = original.replace(
      '"metadata":',
      '"metadata":{"contextBoundaryKind":"reset"},"metadata":'
    );
    await appendTrackedHistory(chatPath, repaired + "\n");
    expect((await pages({ action: "read_item", item_id: "0" })).at(-1)?.error).toBe(
      "item_not_found"
    );
    await fixture.historyService.appendToHistory(
      workspaceId,
      createRolloverPrefix(validRollover)[0]
    );
    expect((await pages({ action: "read_item", item_id: "0" })).at(-1)?.error).toBe(
      "item_not_found"
    );
  });

  for (const mode of ["append", "batch", "lazy", "update"] as const) {
    test(`${mode} rotation preserves a manual reset below the archive sequence watermark`, async () => {
      await append("private", "private facts");
      await append("sealed-boundary", "summary", {
        compacted: true,
        compactionBoundary: true,
        compactionEpoch: 1,
      });
      const reset = createMuxMessage(
        mode === "batch" ? "first" : "repaired-reset",
        "assistant",
        "",
        {
          contextBoundaryKind: "reset",
          historySequence: 0,
        }
      );
      await appendTrackedHistory(chatPath, JSON.stringify(reset) + "\n");
      expect((await pages({ action: "read_item", item_id: "0" })).at(-1)?.error).toBe(
        "item_not_found"
      );
      const [boundary, leadIn] = createRolloverPrefix(validRollover);
      if (mode === "append") await fixture.historyService.appendToHistory(workspaceId, boundary);
      else if (mode === "batch")
        await fixture.historyService.appendManyToHistory(workspaceId, [boundary, leadIn]);
      else if (mode === "lazy") {
        boundary.metadata = { ...boundary.metadata, historySequence: 3 };
        await appendTrackedHistory(chatPath, JSON.stringify(boundary) + "\n");
        expect(
          (await fixture.historyService.getHistoryFromLatestBoundary(workspaceId)).success
        ).toBe(true);
      } else {
        const pending = await append("pending-boundary", "pending");
        expect(
          (
            await fixture.historyService.updateHistory(workspaceId, {
              ...boundary,
              id: pending.id,
              metadata: {
                ...boundary.metadata,
                historySequence: pending.metadata!.historySequence,
              },
            })
          ).success
        ).toBe(true);
      }
      await append("public-after-rotation", "public facts");
      const archivedRows = (await fs.readFile(archivePath, "utf8"))
        .trim()
        .split("\n")
        .map((line) => JSON.parse(line) as MuxMessage);
      expect(
        archivedRows.find(
          (row) => row.id === reset.id && row.metadata?.contextBoundaryKind === "reset"
        )
      ).toMatchObject(reset);
      expect(
        (await pages({ action: "search", query: "facts" }))
          .flatMap((page) => page.items ?? [])
          .map((item) => item.text)
      ).toEqual(["public facts"]);
      expect((await pages({ action: "read_item", item_id: "0" })).at(-1)?.error).toBe(
        "item_not_found"
      );
    });
  }

  for (const [name, marker] of [
    ["value", '"contextBoundaryKind":"res\\x65t"'],
    ["key", '"\\x63ontextBoundaryKind":"reset"'],
    ["colon", '"contextBoundaryKind"\\x3a"reset"'],
    ["quotes", "\\x22contextBoundaryKind\\x22:\\x22reset\\x22"],
    ["mixed escapes", '\\x22context\\u0042oundaryKind\\x22\\x3A"res\\x65t"'],
    ["whitespace", '"contextBoundaryKind"\\x20:\\x09"res\\x65t"'],
  ]) {
    test(`hex-escaped reset ${name} protects direct/resumed retrieval and raw rewrites`, async () => {
      await append("private", "private facts");
      const first = await call({ action: "search", query: "facts", limit: 1 });
      expect(first.nextCursor).toBeString();
      const raw = Buffer.from(
        `{"id":"hex-reset","role":"assistant","parts":[],"metadata":{${marker}}}\n`
      );
      await appendTrackedHistory(chatPath, raw);
      const current = await append("public", "public facts");
      const cut = await append("cut", "discarded tail");
      expect(
        (await call({ action: "search", query: "facts", cursor: first.nextCursor })).error
      ).toBe("stale_cursor");
      expect(
        (await pages({ action: "search", query: "facts" }))
          .flatMap((page) => page.items ?? [])
          .map((item) => item.text)
      ).toEqual(["public facts"]);
      expect(hasRawResetMarker(raw.toString("utf8"))).toBe(true);
      expect((await fixture.historyService.updateHistory(workspaceId, current)).success).toBe(true);
      expect((await pages({ action: "read_item", item_id: "0" })).at(-1)?.error).toBe(
        "item_not_found"
      );
      expect((await fixture.historyService.truncateAfterMessage(workspaceId, cut.id)).success).toBe(
        true
      );
      expect((await fs.readFile(chatPath)).includes(raw)).toBe(true);
      expect(
        (await pages({ action: "search", query: "facts" }))
          .flatMap((page) => page.items ?? [])
          .map((item) => item.text)
      ).toEqual(["public facts"]);
    });
  }

  test.each([
    '"contextBoundaryKinds":"res\\x65t"',
    '"contextBoundaryKind":"re\\x73ume"',
    `"contextBoundaryKind":${JSON.stringify(String.raw`res\x65t`)}`,
  ])("non-reset hex data remains traversable: %s", async (marker) => {
    const row = `{"id":"not-reset","role":"assistant","parts":[],"metadata":{${marker}}}\n`;
    await appendTrackedHistory(chatPath, row);
    expect(hasRawResetMarker(row)).toBe(false);
    expect(
      (await pages({ action: "read_item", item_id: "0" }))
        .flatMap((page) => page.items ?? [])
        .map((item) => item.text)
    ).toEqual(["opening facts"]);
  });

  const fragmentedResetMarkers = [
    { name: "after the key", marker: '"contextBoundaryKind"\n:"reset"' },
    { name: "after the colon", marker: '"contextBoundaryKind":\n"reset"' },
    { name: "at both lexical gaps", marker: '"contextBoundaryKind"\r\n \t:\r\n "reset"' },
    {
      name: "with escaped tokens",
      marker: `"${unicodeEscapes("contextBoundaryKind")}"\n:\n"${unicodeEscapes("reset")}"`,
    },
    {
      name: "with hex-escaped fragments",
      marker: '"\\x63ontextBoundaryKind"\n\\x3A\n"res\\x65t"',
    },
    {
      name: "across a row-budget page",
      marker:
        '"contextBoundaryKind"\n' + " \t\n".repeat(SESSION_HISTORY_MAX_SCAN_ROWS + 3) + ':"reset"',
    },
    {
      name: "across a byte-budget page",
      marker:
        `"${unicodeEscapes("contextBoundaryKind")}"\n` +
        " ".repeat(SESSION_HISTORY_MAX_SCAN_BYTES + 256) +
        `:\n"${unicodeEscapes("reset")}"`,
    },
  ];
  for (const fragment of fragmentedResetMarkers) {
    test(`reset fragmented ${fragment.name} blocks initial and resumed recovery`, async () => {
      const hidden = await append("private", "private facts");
      const first = await call({ action: "search", query: "facts", limit: 1 });
      await appendTrackedHistory(
        chatPath,
        `{"id":"fragmented-reset","role":"assistant","parts":[],"metadata":{${fragment.marker}}}\n` +
          JSON.stringify(createMuxMessage("public-after-fragments", "assistant", "public facts")) +
          "\n"
      );
      let cursor = first.nextCursor;
      let result: SessionHistoryResult;
      let pageCount = 0;
      do {
        result = await call({ action: "search", query: "facts", cursor });
        if (result.success) {
          expect(result.items).toEqual([]);
          expect(result.bytesRead).toBeLessThanOrEqual(SESSION_HISTORY_MAX_SCAN_BYTES);
          expect(result.rowsScanned).toBeLessThanOrEqual(SESSION_HISTORY_MAX_SCAN_ROWS);
        }
        expect(Buffer.byteLength(JSON.stringify(result))).toBeLessThanOrEqual(
          SESSION_HISTORY_MAX_RESULT_BYTES
        );
        cursor = result.nextCursor;
        expect(++pageCount).toBeLessThan(12);
      } while (cursor);
      expect(result.error).toBe("stale_cursor");
      expect(
        (await pages({ action: "search", query: "facts" }))
          .flatMap((page) => page.items ?? [])
          .map((item) => item.text)
      ).toEqual(["public facts"]);
      expect(
        (
          await pages({ action: "read_item", item_id: String(hidden.metadata!.historySequence) })
        ).at(-1)?.error
      ).toBe("item_not_found");
    });
  }

  test("valid-row isolation does not discard a raw reset hidden by duplicate keys", async () => {
    await appendTrackedHistory(
      chatPath,
      '{"id":"duplicate-reset","role":"assistant","parts":[],"metadata":{"contextBoundaryKind":"reset","contextBoundaryKind":"normal"}}\n'
    );
    expect((await pages({ action: "read_item", item_id: "0" })).at(-1)?.error).toBe(
      "item_not_found"
    );
  });

  const rolloverJson = JSON.stringify(rollover);
  const rolloverDetailsJson = JSON.stringify(rollover.muxMetadata);
  for (const [name, metadataFields] of [
    [
      "duplicate root metadata",
      `"metadata":{"contextBoundaryKind":"reset"},"metadata":${rolloverJson}`,
    ],
    [
      "escaped equivalent root key",
      `"metadata":{"contextBoundaryKind":"reset"},"${unicodeEscapes("metadata")}":${rolloverJson}`,
    ],
    [
      "duplicate nested metadata",
      `"metadata":{"contextBoundaryKind":"reset","muxMetadata":{"type":"manual"},"muxMetadata":${rolloverDetailsJson}}`,
    ],
    [
      "duplicate nested leaf",
      `"metadata":${rolloverJson.replace('"maxTokens":6000', '"maxTokens":0,"maxTokens":6000')}`,
    ],
    [
      "escaped equivalent nested key",
      `"metadata":${rolloverJson.replace('"reason":"on-send"', `"reason":"manual","${unicodeEscapes("reason")}":"on-send"`)}`,
    ],
  ]) {
    test(`${name} cannot disguise a manual reset as a rollover in direct or resumed recovery`, async () => {
      await append("private", "private facts");
      const first = await call({ action: "search", query: "facts", limit: 1 });
      expect(first.nextCursor).toBeString();
      const ambiguousRow = `{"id":"ambiguous-reset","role":"assistant","parts":[],${metadataFields}}\n`;
      await appendTrackedHistory(
        chatPath,
        ambiguousRow +
          JSON.stringify(createMuxMessage("public-after-ambiguous", "assistant", "public facts")) +
          "\n"
      );
      expect(
        (await call({ action: "search", query: "facts", cursor: first.nextCursor })).error
      ).toBe("stale_cursor");
      const direct = await pages({ action: "search", query: "facts" });
      expect(direct.flatMap((page) => page.items ?? []).map((item) => item.text)).toEqual([
        "public facts",
      ]);
      expect(direct.reduce((sum, page) => sum + (page.malformedLines ?? 0), 0)).toBeGreaterThan(0);
      expect((await pages({ action: "read_item", item_id: "0" })).at(-1)?.error).toBe(
        "item_not_found"
      );
      // Rewriting metadata must not turn the same raw floor into a valid rollover.
      expect((await fixture.historyService.migrateWorkspaceId("old-id", workspaceId)).success).toBe(
        true
      );
      expect((await fs.readFile(chatPath)).includes(Buffer.from(ambiguousRow))).toBe(true);
      expect(
        (await pages({ action: "search", query: "private facts" })).flatMap(
          (page) => page.items ?? []
        )
      ).toEqual([]);
    });
  }

  test("valid rollovers allow repeated key names in distinct objects and string values", async () => {
    await append("private", "private facts");
    const first = await call({ action: "search", query: "facts", limit: 1 });
    await appendTrackedHistory(
      chatPath,
      JSON.stringify({
        id: "unambiguous-rollover",
        role: "assistant",
        parts: [],
        metadata: {
          ...rollover,
          probes: [{ metadata: 1, "\\u006detadata": 2 }, { metadata: 2 }],
          quoted: '"metadata":0,"metadata":1',
        },
      }) + "\n"
    );
    const resumed = await call({ action: "search", query: "facts", cursor: first.nextCursor });
    expect(resumed.success).toBe(true);
    expect(resumed.items?.map((item) => item.text)).toEqual(["private facts"]);
    expect(
      (await pages({ action: "read_item", item_id: "0" }))
        .flatMap((page) => page.items ?? [])
        .map((item) => item.text)
    ).toEqual(["opening facts"]);
  });

  test("a fully pretty-printed reset still protects the earlier transcript", async () => {
    await appendTrackedHistory(
      chatPath,
      JSON.stringify(
        createMuxMessage("pretty-reset", "assistant", "", { contextBoundaryKind: "reset" }),
        null,
        2
      ) +
        "\n" +
        JSON.stringify(createMuxMessage("after-pretty-reset", "assistant", "public facts")) +
        "\n"
    );
    expect(
      (await pages({ action: "search", query: "facts" }))
        .flatMap((page) => page.items ?? [])
        .map((item) => item.text)
    ).toEqual(["public facts"]);
    expect((await pages({ action: "read_item", item_id: "0" })).at(-1)?.error).toBe(
      "item_not_found"
    );
  });

  test("a new append cannot finish an older malformed reset without expiring the cursor", async () => {
    await append("private", "private facts");
    await appendTrackedHistory(
      chatPath,
      '{"id":"cross-snapshot-reset","role":"assistant","parts":[],"metadata":{"contextBoundaryKind"\n'
    );
    const first = await call({ action: "search", query: "facts", limit: 1 });
    await appendTrackedHistory(chatPath, ':"reset"}}\n');
    expect((await call({ action: "search", query: "facts", cursor: first.nextCursor })).error).toBe(
      "stale_cursor"
    );
  });

  test.each([false, true])(
    "valid rows break malformed-fragment continuity (rollover: %s)",
    async (useRollover) => {
      await append("private", "private facts");
      const first = await call({ action: "search", query: "facts", limit: 1 });
      const separatingRow = useRollover
        ? createRolloverPrefix(validRollover)[0]
        : createMuxMessage("separator", "assistant", "ordinary data");
      await appendTrackedHistory(
        chatPath,
        '"contextBoundaryKind"\n' + JSON.stringify(separatingRow) + '\n:"reset"\n'
      );
      const resumed = await call({ action: "search", query: "facts", cursor: first.nextCursor });
      expect(resumed.success).toBe(true);
      expect(resumed.items?.map((item) => item.text)).toEqual(["private facts"]);
      expect(
        (await pages({ action: "read_item", item_id: "0" }))
          .flatMap((page) => page.items ?? [])
          .map((item) => item.text)
      ).toEqual(["opening facts"]);
    }
  );

  function unicodeEscapes(text: string): string {
    return [...text]
      .map((character) => `\\u${character.charCodeAt(0).toString(16).padStart(4, "0")}`)
      .join("");
  }

  for (const [name, key, value] of [
    ["escaped key", unicodeEscapes("contextBoundaryKind"), "reset"],
    ["escaped value", "contextBoundaryKind", unicodeEscapes("reset")],
    ["escaped key and value", unicodeEscapes("contextBoundaryKind"), unicodeEscapes("reset")],
    [
      "uppercase hex digits",
      unicodeEscapes("contextBoundaryKind").replace(/[a-f]/g, (hex) => hex.toUpperCase()),
      unicodeEscapes("reset"),
    ],
  ]) {
    test(`oversized ${name} preserves privacy across whitespace and appended pages`, async () => {
      await append("private", "private facts");
      const first = await call({ action: "search", query: "facts", limit: 1 });
      const marker = `"${key}"` + " \t".repeat(SESSION_HISTORY_MAX_SCAN_BYTES) + ` : "${value}"`;
      const row = `{"id":"escaped-reset","role":"assistant","metadata":{${marker}},"parts":[],"padding":"${"x".repeat(SESSION_HISTORY_MAX_SCAN_BYTES)}"}\n`;
      await appendTrackedHistory(
        chatPath,
        row +
          JSON.stringify(createMuxMessage("after-escaped-reset", "assistant", "public facts")) +
          "\n"
      );
      let cursor = first.nextCursor;
      let result: SessionHistoryResult;
      let pageCount = 0;
      do {
        result = await call({ action: "search", query: "facts", cursor });
        expect(Buffer.byteLength(JSON.stringify(result))).toBeLessThanOrEqual(
          SESSION_HISTORY_MAX_RESULT_BYTES
        );
        if (result.success) {
          expect(result.items).toEqual([]);
          expect(result.bytesRead).toBeLessThanOrEqual(SESSION_HISTORY_MAX_SCAN_BYTES);
          expect(result.rowsScanned).toBeLessThanOrEqual(SESSION_HISTORY_MAX_SCAN_ROWS);
        }
        cursor = result.nextCursor;
        expect(++pageCount).toBeLessThan(10);
      } while (cursor);
      expect(pageCount).toBeGreaterThan(1);
      expect(result.error).toBe("stale_cursor");
      expect((await pages({ action: "read_item", item_id: "0" })).at(-1)?.error).toBe(
        "item_not_found"
      );
      expect(
        (await pages({ action: "search", query: "facts" }))
          .flatMap((page) => page.items ?? [])
          .map((item) => item.text)
      ).toEqual(["public facts"]);
    });
  }

  for (const [name, key, value] of [
    [
      "different value",
      `"${unicodeEscapes("contextBoundaryKind")}"`,
      `"${unicodeEscapes("resume")}"`,
    ],
    [
      "different key",
      `"${unicodeEscapes("contextBoundaryKinds")}"`,
      `"${unicodeEscapes("reset")}"`,
    ],
    [
      "literal escaped key",
      JSON.stringify(unicodeEscapes("contextBoundaryKind")),
      `"${unicodeEscapes("reset")}"`,
    ],
  ]) {
    test(`oversized Unicode data with ${name} remains traversable`, async () => {
      await appendTrackedHistory(
        chatPath,
        `{"id":"not-reset","role":"assistant","metadata":{${key}:${value}},"parts":[],"padding":"${"x".repeat(2 * SESSION_HISTORY_MAX_LINE_BYTES)}"}\n`
      );
      expect(
        (await pages({ action: "read_item", item_id: "0" }))
          .flatMap((page) => page.items ?? [])
          .map((item) => item.text)
      ).toEqual(["opening facts"]);
    });
  }

  for (const mode of ["chunk", "initial page", "appended page"] as const) {
    for (const split of [1, 2, 3, 4, 5]) {
      test.each(
        [
          {
            name: "value",
            prefix: '","metadata":{"contextBoundaryKind":"',
            escape: "\\u0072",
            suffix: 'eset"},"tail":"',
          },
          {
            name: "colon",
            prefix: '","metadata":{"contextBoundaryKind"',
            escape: "\\u003a",
            suffix: '"reset"},"tail":"',
          },
          {
            name: "uppercase colon",
            prefix: '","metadata":{"contextBoundaryKind"',
            escape: "\\u003A",
            suffix: '"reset"},"tail":"',
          },
          {
            name: "hex value",
            prefix: '","metadata":{"contextBoundaryKind":"res',
            escape: "\\x65",
            suffix: 't"},"tail":"',
          },
          {
            name: "hex key",
            prefix: '","metadata":{"',
            escape: "\\x63",
            suffix: 'ontextBoundaryKind":"reset"},"tail":"',
          },
          {
            name: "hex colon",
            prefix: '","metadata":{"contextBoundaryKind"',
            escape: "\\x3A",
            suffix: '"reset"},"tail":"',
          },
          {
            name: "hex quote",
            prefix: '","metadata":{',
            escape: "\\x22",
            suffix: 'contextBoundaryKind":"reset"},"tail":"',
          },
        ]
          .filter((token) => split < token.escape.length)
          .map((token) => [token.name, token] as const)
      )(
        `escaped reset %s split after byte ${split} across a ${mode} boundary remains private`,
        async (_name, token) => {
          const appended = mode === "appended page";
          const saved = appended
            ? (await fixture.historyService.scanHistoryBounded(workspaceId, { visit: () => false }))
                .cursor
            : undefined;
          // Initial scans read one chat snapshot; resumed append checks read four.
          // Verify the resulting cursor offset below so fixture alignment is explicit.
          const distance =
            mode === "chunk"
              ? SESSION_HISTORY_SCAN_CHUNK_BYTES
              : SESSION_HISTORY_MAX_SCAN_BYTES -
                2 * HISTORY_PROVENANCE_MAX_RECEIPT_BYTES -
                SESSION_HISTORY_ANCHOR_BYTES * (appended ? 8 : 2);
          const publicLine =
            JSON.stringify(createMuxMessage("public-after-split", "assistant", "public facts")) +
            "\n";
          const suffix = token.suffix;
          const end = '"}\n' + publicLine;
          const padding = distance - (token.escape.length - split + suffix.length + end.length);
          const row =
            '{"id":"split-reset","role":"assistant","parts":[],"padding":"' +
            "x".repeat(2 * SESSION_HISTORY_MAX_LINE_BYTES) +
            token.prefix +
            token.escape +
            suffix +
            "x".repeat(padding) +
            end;
          await appendTrackedHistory(chatPath, row);
          const emitted: string[] = [];
          const visit = ({ message }: { message: MuxMessage }) => {
            emitted.push(message.id);
            return true;
          };
          const first = await fixture.historyService.scanHistoryBounded(workspaceId, {
            cursor: saved,
            visit,
          });
          expect(first.bytesRead).toBeLessThanOrEqual(SESSION_HISTORY_MAX_SCAN_BYTES);
          expect(first.cursor).toBeDefined();
          if (mode === "chunk") expect(first.cursor?.possibleReset).toBe(true);
          else {
            const position = appended ? first.cursor?.appendCheck : first.cursor;
            expect(position?.byteOffset).toBe((await fs.stat(chatPath)).size - distance);
            expect(position?.possibleReset).toBe(false);
          }
          let cursor = first.cursor;
          let stale = false;
          let pageCount = 0;
          while (cursor) {
            try {
              const next = await fixture.historyService.scanHistoryBounded(workspaceId, {
                cursor,
                visit,
              });
              expect(next.bytesRead).toBeLessThanOrEqual(SESSION_HISTORY_MAX_SCAN_BYTES);
              expect(next.rowsScanned).toBeLessThanOrEqual(SESSION_HISTORY_MAX_SCAN_ROWS);
              cursor = next.cursor;
            } catch (error) {
              expect(error).toMatchObject({ message: "stale_cursor" });
              stale = true;
              break;
            }
            expect(++pageCount).toBeLessThan(10);
          }
          expect(stale).toBe(appended);
          expect(emitted).toEqual(appended ? [] : ["public-after-split"]);
        }
      );
    }
  }

  test("oversized reset markers are a privacy floor, regardless of nested rollover metadata", async () => {
    const reset = createMuxMessage("oversized-reset", "assistant", "x".repeat(5 * 1024 * 1024), {
      contextBoundaryKind: "reset",
      muxMetadata: rollover.muxMetadata,
    });
    const raw = JSON.stringify(reset).replace(
      '"contextBoundaryKind":"reset"',
      '"contextBoundaryKind"' + " ".repeat(3 * 1024 * 1024) + '\t:  "reset"'
    );
    await appendTrackedHistory(
      chatPath,
      raw +
        "\n" +
        JSON.stringify(createMuxMessage("new", "assistant", "public after oversized reset")) +
        "\n"
    );
    const hidden = await pages({ action: "read_item", item_id: "0" });
    expect(hidden.flatMap((page) => page.items ?? [])).toEqual([]);
    expect(hidden.at(-1)?.error).toBe("item_not_found");
    expect(
      (await pages({ action: "search", query: "public" }))
        .flatMap((page) => page.items ?? [])
        .map((item) => item.text)
    ).toEqual(["public after oversized reset"]);
  });

  test("appending the tool's own result preserves a fixed cursor snapshot; rotation expires it", async () => {
    await append("one", "match one");
    await append("two", "match two");
    const first = await call({ action: "search", query: "match", limit: 1 });
    expect(first.nextCursor).toBeString();
    await append("tool-result", "", undefined, [
      {
        type: "dynamic-tool",
        toolCallId: "history",
        toolName: "session_history",
        state: "output-available",
        input: { action: "search" },
        output: first,
      },
    ]);
    const second = await call({
      action: "search",
      query: "match",
      limit: 1,
      cursor: first.nextCursor,
    });
    expect(second.success).toBe(true);
    expect(second.items?.[0]?.text).toBe("match two");
    expect(second.nextCursor).toBeUndefined();
    expect(second.exhausted).toBe(true);
    await append("roll", "", rollover);
    expect((await call({ action: "search", query: "match", cursor: first.nextCursor })).error).toBe(
      "stale_cursor"
    );
  });

  test("cursor binds workspace, action and query and detects in-place anchor mutation", async () => {
    await append("one", "match one");
    await append("two", "match two");
    const first = await call({ action: "search", query: "match", limit: 1 });
    const cursor = first.nextCursor;
    expect(
      (await call({ action: "search", query: "match", cursor }, "other-workspace")).error
    ).toBe("invalid_cursor");
    expect((await call({ action: "list_windows", query: "match", cursor })).error).toBe(
      "invalid_cursor"
    );
    expect((await call({ action: "search", query: "other", cursor })).error).toBe("invalid_cursor");
    const handle = await fs.open(chatPath, "r+");
    try {
      await handle.write(Buffer.from("!"), 0, 1, 0);
    } finally {
      await handle.close();
    }
    expect((await call({ action: "search", query: "match", cursor })).error).toBe("stale_cursor");
  });

  test("appended manual reset invalidates an otherwise append-stable cursor", async () => {
    await append("one", "match one");
    await append("two", "match two");
    const first = await call({ action: "search", query: "match", limit: 1 });
    // Simulate a cross-process append without rotation: the reset must still
    // invalidate privacy, rather than relying on inode replacement as the gate.
    await appendTrackedHistory(
      chatPath,
      JSON.stringify(createMuxMessage("reset", "assistant", "", { contextBoundaryKind: "reset" })) +
        "\n"
    );
    expect((await call({ action: "search", query: "match", cursor: first.nextCursor })).error).toBe(
      "stale_cursor"
    );
  });

  test("below-watermark repaired and imported active rows survive bounded recovery pages", async () => {
    const archived = await append("repaired-id", "archived facts");
    await append("archive-high", "higher archived facts");
    const boundary = await append("active-boundary", "summary", {
      compacted: true,
      compactionBoundary: true,
      compactionEpoch: 1,
    });
    const repaired = createMuxMessage(archived.id, "assistant", "repaired facts", {
      historySequence: archived.metadata!.historySequence,
    });
    const imported = createMuxMessage("unique-import", "assistant", "imported facts", {
      historySequence: 0,
    });
    await appendTrackedHistory(
      chatPath,
      [repaired, imported].map((row) => JSON.stringify(row)).join("\n") + "\n"
    );
    const recovered = await pages({ action: "search", query: "facts", limit: 1 });
    expect(recovered.length).toBeGreaterThan(1);
    expect(recovered.flatMap((page) => page.items ?? []).map((item) => item.text)).toEqual([
      "opening facts",
      "archived facts",
      "higher archived facts",
      "repaired facts",
      "imported facts",
    ]);
    const activeWindow = `w:${String(boundary.metadata!.historySequence)}`;
    for (const [message, expected] of [
      [repaired, "repaired facts"],
      [imported, "imported facts"],
    ] as const) {
      expect(
        (
          await pages({
            action: "read_item",
            item_id: String(message.metadata!.historySequence),
            window_id: activeWindow,
          })
        )
          .flatMap((page) => page.items ?? [])
          .map((item) => item.text)
      ).toEqual([expected]);
    }
  });

  test.each([false, true])(
    "rotation retries preserve a torn archive tail and every complete row (reset evidence: %s)",
    async (resetEvidence) => {
      await append("sealed", "sealed facts");
      if (resetEvidence) {
        await fs.writeFile(
          archivePath,
          Buffer.concat([
            Buffer.from(
              JSON.stringify(
                createMuxMessage("older-private", "assistant", "private archived facts")
              ) + "\n"
            ),
            Buffer.from(' {"metadata":{"contextBoundaryKind" : "reset"},'),
            Buffer.from([0xff]),
          ])
        );
      }
      const originalOpen = fs.open;
      let crashed = false;
      const writes: Array<{ mockRestore(): void }> = [];
      const opened = spyOn(fs, "open").mockImplementation(async (...args) => {
        const handle = await originalOpen(...args);
        if (args[0] === archivePath && (args[1] === "a" || args[1] === "a+")) {
          const originalWrite = handle.writeFile.bind(handle);
          writes.push(
            spyOn(handle, "writeFile").mockImplementation(async (data, options) => {
              if (!crashed && Buffer.isBuffer(data)) {
                crashed = true;
                await originalWrite(data.subarray(0, data.indexOf(10) - 1), options);
                throw new Error("simulated partial archive publication");
              }
              return originalWrite(data, options);
            })
          );
        }
        return handle;
      });
      try {
        await append("first-boundary", "summary", {
          compacted: true,
          compactionBoundary: true,
          compactionEpoch: 1,
        });
      } finally {
        for (const write of writes) write.mockRestore();
        opened.mockRestore();
      }
      expect(crashed).toBe(true);
      expect((await fs.readFile(chatPath, "utf8")).includes('"id":"first"')).toBe(true);
      const tornArchive = await fs.readFile(archivePath);
      expect(tornArchive.at(-1)).not.toBe(10);
      await append("retry-boundary", "latest summary", {
        compacted: true,
        compactionBoundary: true,
        compactionEpoch: 2,
      });
      const archived = await fs.readFile(archivePath);
      expect(archived.subarray(0, tornArchive.length)).toEqual(tornArchive);
      expect((await fs.readFile(chatPath, "utf8")).includes('"id":"first"')).toBe(false);
      expect(
        (await pages({ action: "search", query: "facts" }))
          .flatMap((page) => page.items ?? [])
          .map((item) => item.text)
      ).toEqual(["opening facts", "sealed facts"]);
      const full: MuxMessage[] = [];
      expect(
        (
          await fixture.historyService.iterateFullHistory(workspaceId, "forward", (rows) => {
            full.push(...rows);
          })
        ).success
      ).toBe(true);
      for (const id of ["first", "sealed", "first-boundary", "retry-boundary"])
        expect(full.some((row) => row.id === id)).toBe(true);
    }
  );

  test("a readable structured tool result containing reset data does not hide earlier recovery rows", async () => {
    await append("tool-data", "", undefined, [
      {
        type: "dynamic-tool",
        toolCallId: "data",
        toolName: "bash",
        state: "output-available",
        input: {},
        output: { contextBoundaryKind: "reset", value: "tool facts" },
      },
    ]);
    await append("after-tool", "later facts");
    const found = (await pages({ action: "search", query: "facts" })).flatMap(
      (page) => page.items ?? []
    );
    expect(found.map((item) => item.text)).toContain("opening facts");
    expect(found.some((item) => item.text.includes("tool facts"))).toBe(true);
    expect(found.map((item) => item.text)).toContain("later facts");
  });

  test.each([false, true])(
    "ordinary append retry preserves accepted rows and raw reset privacy (reset: %s)",
    async (reset) => {
      await append("earlier", "earlier facts");
      const originalAppend = fs.appendFile;
      const torn = reset
        ? Buffer.concat([
            Buffer.from('{"metadata":{"contextBoundaryKind" : "reset"},'),
            Buffer.from([0xff]),
          ])
        : Buffer.from('{"id":"failed","role":"user","parts":[');
      const failed = spyOn(fs, "appendFile").mockImplementationOnce(async (target) => {
        await originalAppend(target, torn);
        throw new Error("simulated torn ordinary append");
      });
      try {
        expect(
          (
            await fixture.historyService.appendToHistory(
              workspaceId,
              createMuxMessage("failed", "user", "failed input")
            )
          ).success
        ).toBe(false);
      } finally {
        failed.mockRestore();
      }
      const before = await fs.readFile(chatPath);
      const accepted = createMuxMessage("accepted", "user", "accepted facts");
      expect((await fixture.historyService.appendToHistory(workspaceId, accepted)).success).toBe(
        true
      );
      await append("accepted-result", "result facts");
      expect((await fs.readFile(chatPath)).subarray(0, before.length)).toEqual(before);
      const history = await fixture.historyService.getHistoryFromLatestBoundary(workspaceId);
      expect(history.success).toBe(true);
      if (!history.success) throw new Error(history.error);
      expect(history.data.map((row) => row.id)).toEqual(
        reset
          ? ["accepted", "accepted-result"]
          : ["first", "earlier", "accepted", "accepted-result"]
      );
      expect(
        (await pages({ action: "search", query: "facts" }))
          .flatMap((page) => page.items ?? [])
          .map((item) => item.text)
      ).toEqual(
        reset
          ? ["accepted facts", "result facts"]
          : ["opening facts", "earlier facts", "accepted facts", "result facts"]
      );
    }
  );

  test("potential crash replays remain visible without exact duplicate proof", async () => {
    await append("same-one", "identical content");
    await append("same-two", "identical content");
    const sealed = await fs.readFile(chatPath, "utf8");
    await append("boundary", "summary", {
      compacted: true,
      compactionBoundary: true,
      compactionEpoch: 1,
    });
    await fs.writeFile(chatPath, sealed + (await fs.readFile(chatPath, "utf8")));
    expect((await fs.stat(archivePath)).size).toBeGreaterThan(0);
    // A sequence watermark cannot prove these are exact replays. Conservatively
    // return both physical copies rather than hiding repaired/imported rows.
    const recovered = await pages({ action: "search", query: "identical content", limit: 1 });
    expect(recovered.length).toBeGreaterThan(1);
    expect(recovered.flatMap((page) => page.items ?? []).length).toBe(4);
  });

  test("aggregate encoded result, cursor, Unicode, and markers fit the output budget", async () => {
    const text = '"\\\n\t界'.repeat(6000);
    const message = await append("big", text);
    const read = await call({
      action: "read_item",
      item_id: String(message.metadata!.historySequence),
      limit_chars: 16000,
    });
    expect(read.success).toBe(true);
    expect(read.items?.[0]?.nextCharOffset).toBeGreaterThan(0);
    expect(Buffer.byteLength(JSON.stringify(read))).toBeLessThanOrEqual(
      SESSION_HISTORY_MAX_RESULT_BYTES
    );
    for (let i = 0; i < 30; i++) await append(`result-${i}`, `needle${text.slice(0, 600)}`);
    const all = await pages({ action: "search", query: "needle", limit: 25 });
    expect(all.flatMap((page) => page.items ?? []).length).toBe(30);
  });
});

describe("session_history item listing and filters", () => {
  const toolPart = (
    toolName: string,
    extra?: {
      input?: unknown;
      output?: unknown;
      nestedCalls?: Array<{ toolCallId: string; toolName: string; state: "output-available" }>;
    }
  ): MuxMessage["parts"][number] => {
    const part: MuxMessage["parts"][number] = {
      type: "dynamic-tool",
      toolCallId: `${toolName}-call`,
      toolName,
      state: "output-available",
      input: extra?.input ?? {},
      output: extra?.output ?? { ok: true },
      nestedCalls: extra?.nestedCalls,
    };
    return part;
  };

  test("unfiltered listing pages rows in persisted order and every ID round-trips", async () => {
    const user = createMuxMessage("ask", "user", "please list");
    expect((await fixture.historyService.appendToHistory(workspaceId, user)).success).toBe(true);
    await append("reply", "listed");
    await append("reset", "", { contextBoundaryKind: "reset", synthetic: true });
    await append("after", "post reset");
    const all = (await pages({ action: "list_items", limit: 1 })).flatMap(
      (page) => page.items ?? []
    );
    // "first" is seeded by beforeEach; the manual reset hides everything before it.
    expect(all.map((item) => item.text)).toEqual(["post reset"]);
    const rooted = (await pages({ action: "list_items", window_id: "w:0", limit: 1 })).flatMap(
      (page) => page.items ?? []
    );
    expect(rooted).toEqual([]);
    for (const item of all) {
      const read = await call({ action: "read_item", item_id: item.itemId });
      expect(read.items?.[0]).toMatchObject({ itemId: item.itemId, role: item.role });
    }
  });

  test("listing preserves order and roles without a reset", async () => {
    const user = createMuxMessage("ask", "user", "please list");
    expect((await fixture.historyService.appendToHistory(workspaceId, user)).success).toBe(true);
    await append("reply", "listed");
    const all = (await pages({ action: "list_items", limit: 2 })).flatMap(
      (page) => page.items ?? []
    );
    expect(all.map((item) => [item.role, item.text])).toEqual([
      ["assistant", "opening facts"],
      ["user", "please list"],
      ["assistant", "listed"],
    ]);
  });

  test("role, exact tool name, nested tool and query filters combine with AND semantics", async () => {
    const user = createMuxMessage("ask", "user", "run bash now");
    expect((await fixture.historyService.appendToHistory(workspaceId, user)).success).toBe(true);
    await append("bash-row", "ran bash", undefined, [
      { type: "text", text: "ran bash" },
      toolPart("bash"),
    ]);
    await append("bashful-row", "ran other", undefined, [toolPart("bash_extra")]);
    await append("nested-row", "nested", undefined, [
      toolPart("code_execution", {
        nestedCalls: [{ toolCallId: "n1", toolName: "file_read", state: "output-available" }],
      }),
    ]);
    await append("decoy-row", "decoy", undefined, [
      toolPart("bash_other", {
        input: { toolName: "file_read" },
        output: { nestedCalls: [{ toolName: "file_read" }], value: '{"toolName":"file_read"}' },
      }),
    ]);
    await append("history-row", "", undefined, [toolPart("session_history")]);
    await append("hidden-row", "", { synthetic: true }, [toolPart("bash")]);
    const texts = async (input: SessionHistoryArgs) =>
      (await pages(input)).flatMap((page) => page.items ?? []).map((item) => item.text);
    expect(await texts({ action: "list_items", role: "user" })).toEqual(["run bash now"]);
    expect(await texts({ action: "list_items", role: "system" })).toEqual([]);
    const bashRows = await texts({ action: "list_items", tool_name: "bash" });
    expect(bashRows).toHaveLength(1);
    expect(bashRows[0]).toContain("ran bash");
    const nestedRows = await texts({ action: "list_items", tool_name: "file_read" });
    expect(nestedRows).toHaveLength(1);
    expect(nestedRows[0]).toContain("code_execution");
    expect(await texts({ action: "list_items", tool_name: "session_history" })).toEqual([]);
    expect(await texts({ action: "list_items", tool_name: "bash", role: "user" })).toEqual([]);
    const searchedBash = await texts({ action: "search", query: "bash", tool_name: "bash" });
    expect(searchedBash).toHaveLength(1);
    expect(searchedBash[0]).toContain("ran bash");
    expect(await texts({ action: "search", query: "bash", role: "user" })).toEqual([
      "run bash now",
    ]);
    expect(await texts({ action: "search", query: "nested", tool_name: "bash" })).toEqual([]);
  });

  test("max_chars_per_item bounds snippets, keeps matches visible, and continues via read_item", async () => {
    const row = await append("long", `${"a".repeat(300)}NEEDLE${"b".repeat(300)}`);
    const listed = await call({ action: "list_items", max_chars_per_item: 10 });
    expect(listed.items?.map((item) => item.text)).toEqual(["opening fa", "a".repeat(10)]);
    expect(listed.items?.[1]?.nextCharOffset).toBe(10);
    const searched = await call({ action: "search", query: "needle", max_chars_per_item: 8 });
    expect(searched.items).toHaveLength(1);
    expect(searched.items![0].text).toBe("aaaaNEED");
    expect(searched.items![0].nextCharOffset).toBe(304);
    const wide = await call({ action: "search", query: "needle" });
    expect(wide.items![0].text.indexOf("NEEDLE")).toBe(120);
    await append("emoji", "😀".repeat(4));
    // A one-unit allowance at an astral character still returns the whole pair.
    const paired = await call({ action: "list_items", max_chars_per_item: 1 });
    expect(paired.items?.map((item) => item.text)).toEqual(["o", "a", "😀"]);
    expect(paired.items?.at(-1)?.nextCharOffset).toBe(2);
    const rest = await call({
      action: "read_item",
      item_id: String(row.metadata!.historySequence),
      offset_chars: 10,
      limit_chars: 290,
    });
    expect(rest.items?.[0]?.text).toBe("a".repeat(290));
    expect(rest.items?.[0]?.nextCharOffset).toBe(300);
  });

  test("filters are rejected on actions that cannot honor them", async () => {
    for (const input of [
      { action: "list_windows", role: "user" },
      { action: "list_windows", max_chars_per_item: 5 },
      { action: "read_item", item_id: "1", tool_name: "bash" },
      { action: "read_item", item_id: "1", max_chars_per_item: 5 },
    ] as SessionHistoryArgs[]) {
      expect(await call(input)).toMatchObject({ success: false, error: "filters_unsupported" });
    }
    expect(() =>
      TOOL_DEFINITIONS.session_history.schema.parse({ action: "list_items", tool_name: "" })
    ).toThrow();
    expect(() =>
      TOOL_DEFINITIONS.session_history.schema.parse({ action: "list_items", role: "tool" })
    ).toThrow();
  });

  test("cursors bind filters and snippet size; sparse filters page without materializing", async () => {
    const rows = Array.from({ length: 1200 }, (_, i) =>
      createMuxMessage(`row-${i}`, i === 1150 ? "user" : "assistant", `row ${i}`, {
        historySequence: 100 + i,
      })
    );
    await appendTrackedHistory(
      chatPath,
      rows.map((message) => JSON.stringify(message)).join("\n") + "\n"
    );
    const results = await pages({ action: "list_items", role: "user" });
    expect(results.length).toBeGreaterThan(1);
    expect(results.slice(0, -1).some((page) => page.items?.length === 0)).toBe(true);
    expect(results.flatMap((page) => page.items ?? []).map((item) => item.text)).toEqual([
      "row 1150",
    ]);
    expect(results.at(-1)?.exhausted).toBe(true);
    const first = await call({ action: "list_items", role: "assistant", limit: 1 });
    const cursor = first.nextCursor;
    expect(cursor).toBeString();
    expect((await call({ action: "list_items", role: "user", cursor })).error).toBe(
      "invalid_cursor"
    );
    expect((await call({ action: "list_items", tool_name: "bash", cursor })).error).toBe(
      "invalid_cursor"
    );
    expect(
      (await call({ action: "list_items", role: "assistant", max_chars_per_item: 5, cursor })).error
    ).toBe("invalid_cursor");
    expect((await call({ action: "search", query: "row", cursor })).error).toBe("invalid_cursor");
    // Resuming with the identical binding delivers rows in order; bounded pages
    // (floor discovery over 1200 rows) may be empty progress pages in between.
    const nextItem = async (from: string | undefined) => {
      let page = await call({ action: "list_items", role: "assistant", limit: 1, cursor: from });
      for (let hops = 0; page.items?.length === 0 && page.nextCursor; hops++) {
        expect(hops).toBeLessThan(10);
        page = await call({
          action: "list_items",
          role: "assistant",
          limit: 1,
          cursor: page.nextCursor,
        });
      }
      expect(page.success).toBe(true);
      return { text: page.items?.[0]?.text, cursor: page.nextCursor };
    };
    const opening = await nextItem(cursor);
    const second = await nextItem(opening.cursor);
    expect([opening.text, second.text]).toEqual(["opening facts", "row 0"]);
  });
});

describe("session_history newest-first browsing", () => {
  const row = (
    id: string,
    text: string,
    metadata?: MuxMetadata,
    role: "user" | "assistant" = "assistant"
  ) => JSON.stringify(createMuxMessage(id, role, text, metadata));
  const compaction = (epoch: number, sequence?: number): MuxMetadata => ({
    compacted: true,
    compactionBoundary: true,
    compactionEpoch: epoch,
    ...(sequence === undefined ? {} : { historySequence: sequence }),
  });
  /**
   * Archive + active files with a manual reset floor, rollover and compaction
   * boundaries, malformed and oversized rows, an unaddressable window, and a
   * window (C1) that starts in the archive and continues into the active file.
   */
  async function writeMixedFixture() {
    await fs.writeFile(
      archivePath,
      [
        row("private", "private before reset", { historySequence: 1 }),
        row("manual-reset", "", {
          contextBoundaryKind: "reset",
          synthetic: true,
          historySequence: 10,
        }),
        row("a1", "alpha one", { historySequence: 11 }, "user"),
        "{broken",
        row("r1", "", { ...rollover, historySequence: 20 }),
        row("a4", "alpha two", { historySequence: 21 }),
        row("a5", "x".repeat(SESSION_HISTORY_MAX_LINE_BYTES + 16), { historySequence: 22 }),
        row("c1", "summary one", compaction(1, 30)),
        row("a7", "beta", { historySequence: 31 }, "user"),
      ].join("\n") + "\n"
    );
    await fs.writeFile(
      chatPath,
      [
        row("ch1", "gamma", { historySequence: 32 }),
        row("u".repeat(SESSION_HISTORY_MAX_ID_CHARS + 8), "unaddressable summary", compaction(2)),
        row("hidden", "hidden in unaddressable window", { historySequence: 40 }),
        row("c3", "summary three", compaction(3, 50)),
        row("d1", "delta", { historySequence: 51 }, "user"),
        row("e1", "epsilon", { historySequence: 52 }),
      ].join("\n") +
        "\n" +
        // A torn trailing row (crash mid-append) is malformed in both directions.
        '{"id":"torn","role":"assistant","metadata":{"historySequence":53},"parts":[{"type":"text","text":"to'
    );
  }
  const collect = async (input: SessionHistoryArgs) => {
    const results = await pages(input);
    return {
      pages: results,
      items: results.flatMap((page) => page.items ?? []),
      windows: results.flatMap((page) => page.windows ?? []),
    };
  };

  test("reverse listing, search and windows equal the reversed forward walk on a mixed fixture", async () => {
    await writeMixedFixture();
    const forward = await collect({ action: "list_items", limit: 3 });
    expect(forward.items.map((item) => item.text)).toEqual([
      "alpha one",
      "alpha two",
      "summary one",
      "beta",
      "gamma",
      "summary three",
      "delta",
      "epsilon",
    ]);
    expect(forward.items.map((item) => item.windowId)).toEqual([
      "w:10",
      "w:20",
      "w:30",
      "w:30",
      "w:30",
      "w:50",
      "w:50",
      "w:50",
    ]);
    const reverse = await collect({ action: "list_items", limit: 3, recent_first: true });
    expect(reverse.items).toEqual([...forward.items].reverse());
    // Floor discovery, span discovery and delivery each re-read the oversized row.
    expect(reverse.pages.length).toBeGreaterThan(1);
    expect(reverse.pages.at(-1)?.exhausted).toBe(true);
    const forwardWindows = await collect({ action: "list_windows", limit: 2 });
    const reverseWindows = await collect({ action: "list_windows", limit: 2, recent_first: true });
    expect(forwardWindows.windows).toEqual([
      { windowId: "w:10", boundaryKind: "reset" },
      { windowId: "w:20", boundaryKind: "reset" },
      { windowId: "w:30", boundaryKind: "compaction" },
      { windowId: "w:50", boundaryKind: "compaction" },
    ]);
    expect(reverseWindows.windows).toEqual([...forwardWindows.windows].reverse());
    const forwardSearch = await collect({ action: "search", query: "a", role: "user", limit: 1 });
    const reverseSearch = await collect({
      action: "search",
      query: "a",
      role: "user",
      limit: 1,
      recent_first: true,
    });
    expect(reverseSearch.items).toEqual([...forwardSearch.items].reverse());
    expect(reverseSearch.items.map((item) => item.text)).toEqual(["delta", "beta", "alpha one"]);
    const scoped = await collect({ action: "list_items", window_id: "w:30", recent_first: true });
    expect(scoped.items.map((item) => item.text)).toEqual(["gamma", "beta", "summary one"]);
    for (const item of reverse.items) {
      const read = (await collect({ action: "read_item", item_id: item.itemId })).items;
      expect(read).toHaveLength(1);
      expect(read[0]).toMatchObject({ itemId: item.itemId, windowId: item.windowId });
    }
    expect(
      (await collect({ action: "search", query: "private", recent_first: true })).items
    ).toEqual([]);
    expect(
      (await collect({ action: "search", query: "hidden in", recent_first: true })).items
    ).toEqual([]);
  });

  test("a window larger than one scan page is discovered before any of its rows are delivered", async () => {
    const boundary = createMuxMessage("big-window", "assistant", "big summary", compaction(1, 100));
    const tail = Array.from({ length: SESSION_HISTORY_MAX_SCAN_ROWS + 100 }, (_, i) =>
      createMuxMessage(`tail-${i}`, "assistant", `public-${i}`, { historySequence: 101 + i })
    );
    await appendTrackedHistory(
      chatPath,
      [boundary, ...tail].map((message) => JSON.stringify(message)).join("\n") + "\n"
    );
    const results = await pages({ action: "list_items", limit: 25, recent_first: true });
    const items = results.flatMap((page) => page.items ?? []);
    // Floor discovery and span discovery each need more than one page before delivery starts.
    expect(results.slice(0, 2).every((page) => page.items?.length === 0 && page.nextCursor)).toBe(
      true
    );
    expect(items).toHaveLength(tail.length + 2);
    expect(items[0]).toMatchObject({ text: `public-${tail.length - 1}`, windowId: "w:100" });
    expect(items.at(-2)).toMatchObject({ text: "big summary", windowId: "w:100" });
    expect(items.at(-1)).toMatchObject({ text: "opening facts", windowId: "w:0" });
    for (let i = 0; i < items.length - 1; i++)
      expect(
        items[i].windowId === items[i + 1].windowId || items[i + 1].text === "opening facts"
      ).toBe(true);
    const windows = (await pages({ action: "list_windows", recent_first: true })).flatMap(
      (page) => page.windows ?? []
    );
    expect(windows).toEqual([
      { windowId: "w:100", boundaryKind: "compaction" },
      { windowId: "w:0", boundaryKind: "root" },
    ]);
  });

  test("reverse cursors bind direction, freeze the snapshot, and expire on resets, rewrites and rotation", async () => {
    await append("two", "second");
    await append("three", "third");
    const first = await call({ action: "list_items", limit: 1, recent_first: true });
    expect(first.items?.map((item) => item.text)).toEqual(["third"]);
    const cursor = first.nextCursor!;
    expect(cursor).toBeString();
    expect((await call({ action: "list_items", limit: 1, cursor })).error).toBe("invalid_cursor");
    expect((await call({ action: "list_items", recent_first: false, cursor })).error).toBe(
      "invalid_cursor"
    );
    // Ordinary appends keep the retrieval snapshot fixed: the new row is not exposed.
    await append("four", "fourth");
    const second = await call({ action: "list_items", limit: 1, recent_first: true, cursor });
    expect(second.items?.map((item) => item.text)).toEqual(["second"]);
    const third = await call({
      action: "list_items",
      limit: 1,
      recent_first: true,
      cursor: second.nextCursor,
    });
    expect(third.items?.map((item) => item.text)).toEqual(["opening facts"]);
    expect(third.exhausted).toBe(true);
    expect(third.nextCursor).toBeUndefined();
    // A fresh newest-first scan sees the appended row first.
    expect(
      (await call({ action: "list_items", limit: 1, recent_first: true })).items?.[0]?.text
    ).toBe("fourth");
    const paused = await call({ action: "list_items", limit: 1, recent_first: true });
    await append("reset", "", { contextBoundaryKind: "reset", synthetic: true });
    expect(
      (
        await call({
          action: "list_items",
          limit: 1,
          recent_first: true,
          cursor: paused.nextCursor,
        })
      ).error
    ).toBe("stale_cursor");
    const afterReset = await call({ action: "list_items", limit: 1, recent_first: true });
    expect(afterReset.items).toEqual([]);
    expect(afterReset.exhausted).toBe(true);
    await append("five", "fifth");
    await append("six", "sixth");
    const rotated = await call({ action: "list_items", limit: 1, recent_first: true });
    expect(rotated.items?.map((item) => item.text)).toEqual(["sixth"]);
    expect(rotated.nextCursor).toBeString();
    await append("rotate", "summary", compaction(1));
    expect(
      (
        await call({
          action: "list_items",
          limit: 1,
          recent_first: true,
          cursor: rotated.nextCursor,
        })
      ).error
    ).toBe("stale_cursor");
    const rewound = await call({ action: "list_items", limit: 1, recent_first: true });
    const handle = await fs.open(chatPath, "r+");
    try {
      await handle.write(Buffer.from("!"), 0, 1, 0);
    } finally {
      await handle.close();
    }
    expect(
      (
        await call({
          action: "list_items",
          limit: 1,
          recent_first: true,
          cursor: rewound.nextCursor,
        })
      ).error
    ).toBe("stale_cursor");
    expect(await call({ action: "read_item", item_id: "1", recent_first: true })).toMatchObject({
      success: false,
      error: "filters_unsupported",
    });
  });
});

describe("session_history descendant task history", () => {
  const childId = "child-task";
  const grandchildId = "grandchild-task";
  const removedChildId = "removed-child";
  // Ancestry itself is TaskService's contract; the tool must consult it on every foreign
  // call, treat anything but a live branch as denied/unavailable, and then prove that the
  // caller's current privacy segment created the branch root.
  const relation = (ancestor: string, task: string) => {
    if (ancestor !== workspaceId) return { status: "unrelated" as const };
    if (task === childId || task === grandchildId)
      return { status: "live" as const, branchRootTaskId: childId };
    if (task === removedChildId) return { status: "removed" as const };
    return { status: "unrelated" as const };
  };
  const taskService = {
    resolveDescendantAgentTaskBranchRoot: (ancestor: string, task: string) =>
      Promise.resolve(relation(ancestor, task)),
  } as unknown as TaskService;
  const callAs = async (
    input: SessionHistoryArgs,
    options?: { caller?: string; taskService?: TaskService | null }
  ) => {
    const config = createTestToolConfig(fixture.tempDir, {
      workspaceId: options?.caller ?? workspaceId,
    });
    config.historyService = fixture.historyService;
    if (options?.taskService !== null) config.taskService = options?.taskService ?? taskService;
    const tool = createSessionHistoryTool(config);
    return TOOL_DEFINITIONS.session_history.resultSchema.parse(
      await tool.execute!(input, mockToolCallOptions)
    );
  };
  const pagesAs = async (input: SessionHistoryArgs) => {
    const results: SessionHistoryResult[] = [];
    let cursor: string | undefined;
    do {
      const result = await callAs({ ...input, cursor });
      expect(result.success).toBe(true);
      expect(result.bytesRead ?? 0).toBeLessThanOrEqual(SESSION_HISTORY_MAX_SCAN_BYTES);
      expect(result.rowsScanned ?? 0).toBeLessThanOrEqual(SESSION_HISTORY_MAX_SCAN_ROWS);
      results.push(result);
      cursor = result.nextCursor;
      expect(results.length).toBeLessThan(40);
    } while (cursor);
    return results;
  };
  const appendTo = async (workspace: string, id: string, text: string, metadata?: MuxMetadata) => {
    const message = createMuxMessage(id, "assistant", text, metadata);
    expect((await fixture.historyService.appendToHistory(workspace, message)).success).toBe(true);
    return message;
  };
  const appendChild = (id: string, text: string, metadata?: MuxMetadata) =>
    appendTo(childId, id, text, metadata);
  const taskPart = (
    toolName: string,
    output: unknown,
    nested = false
  ): MuxMessage["parts"][number] =>
    nested
      ? {
          type: "dynamic-tool",
          toolCallId: "ptc",
          toolName: "code_execution",
          state: "output-available",
          input: {},
          output: {},
          nestedCalls: [{ toolCallId: "nested", toolName, state: "output-available", output }],
        }
      : {
          type: "dynamic-tool",
          toolCallId: `${toolName}-call`,
          toolName,
          state: "output-available",
          input: {},
          output,
        };
  // A canonical `task` creation receipt in the caller's transcript.
  const appendSpawnPart = async (part: MuxMessage["parts"][number], workspace = workspaceId) => {
    const message = createMuxMessage(`spawn-${Math.random()}`, "assistant", "", undefined, [part]);
    expect((await fixture.historyService.appendToHistory(workspace, message)).success).toBe(true);
  };
  const spawn = (taskIds: string[], nested = false, workspace = workspaceId) =>
    appendSpawnPart(
      taskPart("task", { status: "completed", taskIds, note: "done" }, nested),
      workspace
    );
  const sessionDir = (id: string) => path.join(fixture.config.sessionsDir, id);
  const expectNoSession = async (id: string) =>
    expect(
      await fs.stat(sessionDir(id)).then(
        () => "exists",
        (error: NodeJS.ErrnoException) => error.code
      )
    ).toBe("ENOENT");

  test("reads a descendant's retained history behind its own reset floor and never the caller's rows", async () => {
    await spawn([childId]);
    await appendChild("child-private", "child private facts");
    await appendChild("child-reset", "", { contextBoundaryKind: "reset", synthetic: true });
    const visible = await appendChild("child-public", "child public facts");
    const listed = await callAs({ action: "list_items", task_id: childId });
    expect(listed.success).toBe(true);
    expect(listed.items?.map((item) => item.text)).toEqual(["child public facts"]);
    expect(
      (await callAs({ action: "search", query: "facts", task_id: childId })).items
    ).toHaveLength(1);
    expect(
      (await callAs({ action: "search", query: "child private", task_id: childId })).items
    ).toEqual([]);
    const read = await callAs({
      action: "read_item",
      task_id: childId,
      item_id: String(visible.metadata!.historySequence),
    });
    expect(read.items?.[0]?.text).toBe("child public facts");
    expect(
      (await callAs({ action: "list_items", task_id: childId, recent_first: true })).items?.map(
        (item) => item.text
      )
    ).toEqual(["child public facts"]);
    // The caller's own history is unaffected by the target parameter.
    const own = (await callAs({ action: "list_items" })).items?.map((item) => item.text);
    expect(own).toEqual(["opening facts", expect.stringContaining("child-task")]);
    expect(
      (await callAs({ action: "list_items", task_id: workspaceId })).items?.map((item) => item.text)
    ).toEqual(own);
  });

  test("a caller reset revokes earlier branches; grandchildren and PTC-nested receipts are covered", async () => {
    await appendChild("child-row", "child facts from the old segment");
    await appendTo(grandchildId, "grandchild-row", "grandchild facts");
    await spawn([childId]);
    expect((await callAs({ action: "list_items", task_id: childId })).success).toBe(true);
    // Grandchild: only the branch root (the child) needs a receipt in the caller's transcript.
    expect(
      (await callAs({ action: "list_items", task_id: grandchildId })).items?.map((i) => i.text)
    ).toEqual(["grandchild facts"]);
    await append("caller-reset", "", { contextBoundaryKind: "reset", synthetic: true });
    for (const target of [childId, grandchildId])
      expect(await callAs({ action: "list_items", task_id: target })).toMatchObject({
        success: false,
        error: "task_not_found",
      });
    // Mentions that are not creation receipts never authorize.
    await append("mention", `see ${childId}`);
    await appendSpawnPart(taskPart("task_list", { tasks: [{ taskId: childId }] }));
    await appendSpawnPart(taskPart("task_await", { results: [{ taskId: childId }] }));
    expect(await callAs({ action: "list_items", task_id: childId })).toMatchObject({
      success: false,
      error: "task_not_found",
    });
    await spawn(["other-task", childId], true);
    expect(
      (await callAs({ action: "list_items", task_id: childId })).items?.map((item) => item.text)
    ).toEqual(["child facts from the old segment"]);
    // Archive-only retained history is still readable.
    await fs.rename(
      path.join(sessionDir(childId), "chat.jsonl"),
      path.join(sessionDir(childId), "chat-archive.jsonl")
    );
    expect(
      (await callAs({ action: "list_items", task_id: childId })).items?.map((item) => item.text)
    ).toEqual(["child facts from the old segment"]);
  });

  test("authorization is proven in bounded pages and revalidated before later target pages", async () => {
    const filler = Array.from({ length: SESSION_HISTORY_MAX_SCAN_ROWS + 50 }, (_, i) =>
      createMuxMessage(`filler-${i}`, "assistant", `filler ${i}`, { historySequence: 100 + i })
    );
    await appendTrackedHistory(
      chatPath,
      filler.map((message) => JSON.stringify(message)).join("\n") + "\n"
    );
    await spawn([childId]);
    await appendChild("child-one", "child one");
    await appendChild("child-two", "child two");
    const results = await pagesAs({ action: "list_items", task_id: childId, limit: 1 });
    // The caller's floor discovery and receipt search need more than one page.
    expect(results[0]).toMatchObject({ success: true, exhausted: false, items: [] });
    expect(results[0].nextCursor).toBeString();
    expect(results.flatMap((page) => page.items ?? []).map((item) => item.text)).toEqual([
      "child one",
      "child two",
    ]);
    // A proven cursor keeps working across ordinary caller appends, but a caller reset
    // appended between pages expires it, and a fresh call is denied.
    const first = await pagesAs({ action: "list_items", task_id: childId, limit: 1 });
    const partial = first.find((page) => page.items?.length === 1 && page.nextCursor)!;
    expect(partial).toBeDefined();
    await append("caller-later", "later caller row");
    const continued = await callAs({
      action: "list_items",
      task_id: childId,
      limit: 1,
      cursor: partial.nextCursor,
    });
    expect(continued.items?.map((item) => item.text)).toEqual(["child two"]);
    const paused = await pagesAs({ action: "list_items", task_id: childId, limit: 1 });
    const cursor = paused.find((page) => page.items?.length === 1 && page.nextCursor)!.nextCursor;
    await append("caller-reset", "", { contextBoundaryKind: "reset", synthetic: true });
    expect((await callAs({ action: "list_items", task_id: childId, limit: 1, cursor })).error).toBe(
      "stale_cursor"
    );
    expect(await callAs({ action: "list_items", task_id: childId })).toMatchObject({
      success: false,
      error: "task_not_found",
    });
  });

  test("in-flight, legacy PTC and deeply nested receipts are handled without unbounded recursion", async () => {
    await appendChild("child-row", "child facts");
    // Same-turn spawn: the receipt lives only in the caller's partial message until stream end.
    const inFlight = createMuxMessage("in-flight", "assistant", "", undefined, [
      taskPart("task", { status: "running", taskId: childId, note: "await it" }),
    ]);
    await fixture.historyService.writePartial(workspaceId, inFlight);
    const first = await callAs({ action: "list_items", task_id: childId, limit: 1 });
    expect(first.items?.map((item) => item.text)).toEqual(["child facts"]);
    await appendChild("child-two", "child two");
    // Once the turn settles the receipt is persisted and the bounded scan takes over.
    await fixture.historyService.deletePartial(workspaceId);
    expect(await callAs({ action: "list_items", task_id: childId })).toMatchObject({
      success: false,
      error: "task_not_found",
    });
    // Legacy PTC persistence: nested calls only inside code_execution's output.toolCalls.
    await appendSpawnPart(
      taskPart("code_execution", {
        toolCalls: [
          { toolName: "task", duration_ms: 3, result: { status: "completed", taskId: childId } },
        ],
      })
    );
    expect(
      (await callAs({ action: "list_items", task_id: childId })).items?.map((item) => item.text)
    ).toEqual(["child facts", "child two"]);
    // A pathologically nested row neither authorizes nor crashes the scan.
    let deep: Record<string, unknown> = { toolName: "task", output: { taskId: grandchildId } };
    for (let i = 0; i < 200; i++)
      deep = {
        toolCallId: `n${i}`,
        toolName: "code_execution",
        state: "output-available",
        nestedCalls: [deep],
      };
    await appendSpawnPart(deep as unknown as MuxMessage["parts"][number]);
    await appendTo(grandchildId, "grandchild-row", "grandchild facts");
    // grandchild resolves to the child branch root, which IS proven; the deep row is just skipped.
    expect(
      (await callAs({ action: "list_items", task_id: grandchildId })).items?.map((i) => i.text)
    ).toEqual(["grandchild facts"]);
    expect((await callAs({ action: "list_items", task_id: childId })).success).toBe(true);
  });

  test("foreign toolCalls, oversized partials and cross-backend resets never disclose rows", async () => {
    await appendChild("child-row", "child facts");
    // Legacy toolCalls only count inside code_execution results; other tools' output is data.
    await appendSpawnPart(
      taskPart("mcp_structured", {
        toolCalls: [{ toolName: "task", duration_ms: 1, result: { taskId: childId } }],
      })
    );
    expect(await callAs({ action: "list_items", task_id: childId })).toMatchObject({
      success: false,
      error: "task_not_found",
    });
    // A partial larger than the page budget is not loaded; proof waits for the settled scan.
    const huge = createMuxMessage(
      "huge",
      "assistant",
      "x".repeat(SESSION_HISTORY_MAX_SCAN_BYTES),
      undefined,
      [taskPart("task", { status: "running", taskId: childId })]
    );
    await fixture.historyService.writePartial(workspaceId, huge);
    const skipped = await callAs({ action: "list_items", task_id: childId });
    expect(skipped).toMatchObject({ success: false, error: "task_not_found" });
    await fixture.historyService.deletePartial(workspaceId);
    // A reset appended to the caller (by another backend) between the authorization scan and
    // the target scan is caught by the post-scan revalidation: nothing is disclosed.
    await spawn([childId]);
    const original = fixture.historyService.scanHistoryBounded.bind(fixture.historyService);
    const spy = spyOn(fixture.historyService, "scanHistoryBounded").mockImplementation(
      async (workspace, options) => {
        if (workspace === childId)
          await append("foreign-reset", "", { contextBoundaryKind: "reset", synthetic: true });
        return original(workspace, options);
      }
    );
    try {
      const raced = await callAs({ action: "list_items", task_id: childId });
      expect(raced).toMatchObject({ success: false, error: "stale_cursor" });
      expect(raced.items ?? []).toEqual([]);
    } finally {
      spy.mockRestore();
    }
    expect(await callAs({ action: "list_items", task_id: childId })).toMatchObject({
      success: false,
      error: "task_not_found",
    });
  });

  test("large caller appends between proven pages resume the append check as progress pages", async () => {
    await spawn([childId]);
    await appendChild("child-one", "child one");
    await appendChild("child-two", "child two");
    const first = await callAs({ action: "list_items", task_id: childId, limit: 1 });
    expect(first.items?.map((item) => item.text)).toEqual(["child one"]);
    const rows = Array.from({ length: SESSION_HISTORY_MAX_SCAN_ROWS + 100 }, (_, i) =>
      createMuxMessage(`later-${i}`, "assistant", `later ${i}`, { historySequence: 5000 + i })
    );
    await appendTrackedHistory(chatPath, rows.map((row) => JSON.stringify(row)).join("\n") + "\n");
    const checking = await callAs({
      action: "list_items",
      task_id: childId,
      limit: 1,
      cursor: first.nextCursor,
    });
    expect(checking).toMatchObject({ success: true, exhausted: false, items: [] });
    expect(checking.nextCursor).toBeString();
    const resumed = await callAs({
      action: "list_items",
      task_id: childId,
      limit: 1,
      cursor: checking.nextCursor,
    });
    expect(resumed.items?.map((item) => item.text)).toEqual(["child two"]);
  });

  test("unauthorized, unknown and unavailable targets fail closed without creating sessions", async () => {
    await spawn([childId, removedChildId, "sibling-workspace", "unknown"]);
    await appendChild("child-row", "child facts");
    for (const target of ["sibling-workspace", "unknown"]) {
      expect(await callAs({ action: "list_items", task_id: target })).toMatchObject({
        success: false,
        error: "task_not_found",
      });
      await expectNoSession(target);
    }
    // A sibling caller cannot use the parent's descendant, and no taskService means no access.
    expect(
      await callAs({ action: "list_items", task_id: childId }, { caller: "sibling-workspace" })
    ).toMatchObject({ success: false, error: "task_not_found" });
    expect(
      await callAs({ action: "list_items", task_id: childId }, { taskService: null })
    ).toMatchObject({ success: false, error: "task_not_found" });
    const failing = {
      resolveDescendantAgentTaskBranchRoot: () => Promise.reject(new Error("config unavailable")),
    } as unknown as TaskService;
    expect(
      await callAs({ action: "list_items", task_id: childId }, { taskService: failing })
    ).toMatchObject({ success: false, error: "task_not_found" });
    // Removed descendant (tombstone/report evidence only): distinguishable, never created.
    expect(await callAs({ action: "list_items", task_id: removedChildId })).toMatchObject({
      success: false,
      error: "session_unavailable",
    });
    await expectNoSession(removedChildId);
    // A live descendant whose files are gone is unavailable too, and never created.
    await fs.rm(sessionDir(grandchildId), { recursive: true, force: true });
    expect(await callAs({ action: "list_items", task_id: grandchildId })).toMatchObject({
      success: false,
      error: "session_unavailable",
    });
    await expectNoSession(grandchildId);
  });

  test("cursors bind caller and target, and removal during pagination fails closed", async () => {
    await spawn([childId]);
    await appendChild("child-one", "child one");
    await appendChild("child-two", "child two");
    await append("own-two", "own second");
    const own = await callAs({ action: "list_items", limit: 1 });
    expect(own.nextCursor).toBeString();
    const first = await callAs({ action: "list_items", task_id: childId, limit: 1 });
    expect(first.items?.map((item) => item.text)).toEqual(["child one"]);
    const cursor = first.nextCursor!;
    expect(cursor).toBeString();
    expect((await callAs({ action: "list_items", limit: 1, cursor })).error).toBe("invalid_cursor");
    expect(
      (await callAs({ action: "list_items", task_id: childId, limit: 1, cursor: own.nextCursor }))
        .error
    ).toBe("invalid_cursor");
    // Another caller with its own receipt for the same child still cannot replay this cursor.
    const otherParent = {
      resolveDescendantAgentTaskBranchRoot: () =>
        Promise.resolve({ status: "live", branchRootTaskId: childId }),
    } as unknown as TaskService;
    await spawn([childId], false, "other-parent");
    expect(
      (
        await callAs(
          { action: "list_items", task_id: childId, limit: 1, cursor },
          { caller: "other-parent", taskService: otherParent }
        )
      ).error
    ).toBe("invalid_cursor");
    // Removal publishes its tombstone under the history lock before deleting files.
    await fs.mkdir(path.dirname(workspaceRemovalTombstonePath(fixture.config.rootDir, childId)), {
      recursive: true,
    });
    await fs.writeFile(
      workspaceRemovalTombstonePath(fixture.config.rootDir, childId),
      JSON.stringify({ workspaceId: childId, removedAt: Date.now(), attemptId: "test" })
    );
    expect(
      await callAs({ action: "list_items", task_id: childId, limit: 1, cursor })
    ).toMatchObject({ success: false, error: "session_unavailable" });
    await fs.rm(sessionDir(childId), { recursive: true, force: true });
    expect(await callAs({ action: "list_items", task_id: childId })).toMatchObject({
      success: false,
      error: "session_unavailable",
    });
    await expectNoSession(childId);
  });
});

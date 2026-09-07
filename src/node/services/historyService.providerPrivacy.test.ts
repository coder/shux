import { afterEach, beforeEach, describe, expect, spyOn, test } from "bun:test";
import * as fs from "node:fs/promises";
import * as path from "node:path";
import { createMuxMessage, type MuxMessage } from "@/common/types/message";
import {
  SESSION_HISTORY_MAX_LINE_BYTES,
  SESSION_HISTORY_MAX_SCAN_BYTES,
  SESSION_HISTORY_MAX_SCAN_ROWS,
  SESSION_HISTORY_SCAN_CHUNK_BYTES,
} from "@/common/constants/contextBudget";
import { createTestHistoryService } from "./testHistoryService";
import { prepareProviderRequestMessages } from "./turnContextAssembler";

const workspaceId = "provider-raw-floor";
const line = (message: MuxMessage) => JSON.stringify(message) + "\n";
const old = createMuxMessage("private", "user", "private before reset");
const publicArchive = createMuxMessage("public-archive", "user", "public archive tail");
const publicChat = createMuxMessage("public-chat", "user", "public active tail");
const boundary = createMuxMessage("summary", "assistant", "summary", {
  compactionBoundary: true,
  compacted: true,
  compactionEpoch: 1,
});
const rollover = {
  contextBoundaryKind: "reset",
  muxMetadata: {
    type: "context-window-rollover",
    rolloverId: "r",
    reason: "on-send",
    previousWindowId: "w:0",
    flushOpportunity: false,
    contextTokens: 100,
    maxTokens: 200,
  },
};

describe("HistoryService provider-only raw privacy floors", () => {
  let h: Awaited<ReturnType<typeof createTestHistoryService>>;
  let chatPath: string;
  let archivePath: string;
  beforeEach(async () => {
    h = await createTestHistoryService();
    chatPath = path.join(h.config.sessionsDir, workspaceId, "chat.jsonl");
    archivePath = path.join(h.config.sessionsDir, workspaceId, "chat-archive.jsonl");
    expect((await h.historyService.appendToHistory(workspaceId, { ...old })).success).toBe(true);
    // Finish the existing lazy rotation before injecting disk corruption.
    expect((await h.historyService.getHistoryFromLatestBoundary(workspaceId)).success).toBe(true);
  });
  afterEach(async () => {
    await h.cleanup();
  });

  async function providerIds(skip = 0): Promise<string[]> {
    const history = await h.historyService.getHistoryFromLatestBoundary(workspaceId, skip);
    expect(history.success).toBe(true);
    if (!history.success) throw new Error(history.error);
    return prepareProviderRequestMessages(
      history.data,
      "openai",
      "off"
    ).providerRequestMessages.map((message) => message.id);
  }

  for (const [name, raw] of [
    ["noncompact", '{"metadata":{"contextBoundaryKind" : "reset"},broken\n'],
    ["escaped", '{"metadata":{"contextBoundaryKind"\\x20\\u003A"res\\x65t"},broken\n'],
    ["fragmented", ' {\n"contextBoundaryKind"\n:\n"reset"\n}\n'],
    ["control separators", '{"metadata":{"contextBoundaryKind"\u0000:\u0001"reset"},broken\n'],
    [
      "array-shaped metadata",
      '{"id":"damaged","role":"assistant","parts":[],"metadata":[{"contextBoundaryKind":"reset"}]}\n',
    ],
    [
      "duplicate rollover metadata",
      `{"id":"ambiguous","role":"assistant","parts":[],"metadata":{"contextBoundaryKind":"reset"},"metadata":${JSON.stringify(rollover)}}\n`,
    ],
    [
      "oversized",
      '{"metadata":{"contextBoundaryKind"' +
        " ".repeat(SESSION_HISTORY_MAX_LINE_BYTES + SESSION_HISTORY_SCAN_CHUNK_BYTES) +
        ':"reset"},broken\n',
    ],
  ]) {
    test.each(["chat", "archive"])(
      `${name} floor clamps %s history before provider assembly without hiding UI history`,
      async (artifact) => {
        await fs.writeFile(
          archivePath,
          line(old) + (artifact === "archive" ? raw + line(publicArchive) : "")
        );
        await fs.writeFile(
          chatPath,
          (artifact === "chat" ? line(old) + raw : "") + line(publicChat)
        );
        const beforeChat = await fs.readFile(chatPath);
        const beforeArchive = await fs.readFile(archivePath);
        for (const skip of [0, 1, 20]) {
          const history = await h.historyService.getHistoryFromLatestBoundary(workspaceId, skip);
          expect(history.success).toBe(true);
          if (!history.success) throw new Error(history.error);
          const expected =
            artifact === "chat" ? [publicChat.id] : [publicArchive.id, publicChat.id];
          expect(history.data.map((message) => message.id)).toEqual(expected);
          expect(
            prepareProviderRequestMessages(
              history.data,
              "openai",
              "off"
            ).providerRequestMessages.map((message) => message.id)
          ).toEqual(expected);
        }
        const control = await h.historyService.getControlEvidenceFromLatestBoundary(workspaceId);
        expect(control.success).toBe(true);
        if (!control.success) throw new Error(control.error);
        expect(control.data.map((row) => row.id)).toEqual(
          artifact === "chat" ? [publicChat.id] : [publicArchive.id, publicChat.id]
        );
        const full: MuxMessage[] = [];
        expect(
          (
            await h.historyService.iterateFullHistory(workspaceId, "forward", (rows) => {
              full.push(...rows);
            })
          ).success
        ).toBe(true);
        expect(full.some((message) => message.id === old.id)).toBe(true);
        const uiHistory = await h.historyService.getLastMessages(workspaceId, 20);
        expect(uiHistory.success).toBe(true);
        if (!uiHistory.success) throw new Error(uiHistory.error);
        expect(uiHistory.data.some((message) => message.id === old.id)).toBe(true);
        expect(await fs.readFile(chatPath)).toEqual(beforeChat);
        expect(await fs.readFile(archivePath)).toEqual(beforeArchive);
      }
    );
  }

  test("control evidence preserves malformed IDs and parts in order without widening provider reads", async () => {
    const correlation = {
      type: "workspace-turn-task",
      taskHandleId: "handle",
      ownerWorkspaceId: "owner",
      turnId: "turn",
    };
    const rows = [
      old,
      { role: "user" },
      { id: null, role: "user", parts: null },
      { id: 42, role: "user", parts: [] },
      { id: "bad-parts", role: "user", parts: [null], metadata: { synthetic: true } },
      {
        ...createMuxMessage("legacy", "user", "valid legacy input"),
        metadata: { cmuxMetadata: correlation },
      },
      { id: "wrong-role", role: "other", parts: [] },
      { id: "wrong-metadata", role: "user", metadata: [] },
      null,
    ];
    await fs.writeFile(chatPath, rows.map((row) => JSON.stringify(row)).join("\n") + "\n");
    const evidence = await h.historyService.getControlEvidenceFromLatestBoundary(workspaceId);
    expect(evidence.success).toBe(true);
    if (!evidence.success) throw new Error(evidence.error);
    expect(evidence.data.map((row) => row.id)).toEqual([
      old.id,
      undefined,
      null,
      42,
      "bad-parts",
      "legacy",
      "wrong-metadata",
    ]);
    expect(evidence.data[1]).not.toHaveProperty("id");
    expect(evidence.data.every((row) => !("parts" in row))).toBe(true);
    expect(evidence.data.find((row) => row.id === "legacy")?.metadata?.muxMetadata).toEqual(
      correlation
    );
    expect(evidence.data.find((row) => row.id === "legacy")?.metadata).not.toHaveProperty(
      "cmuxMetadata"
    );
    expect(evidence.data.find((row) => row.id === "wrong-metadata")).not.toHaveProperty("metadata");
    expect(await providerIds()).toEqual([old.id, "legacy"]);
  });

  test.each(["chat", "archive"])(
    "readable manual reset in %s cannot be skipped toward an older compaction",
    async (artifact) => {
      const reset = createMuxMessage("manual-reset", "assistant", "", {
        contextBoundaryKind: "reset",
      });
      const resetTail = line(reset) + line(publicArchive);
      await fs.writeFile(
        archivePath,
        line(boundary) + line(old) + (artifact === "archive" ? resetTail : "")
      );
      await fs.writeFile(chatPath, (artifact === "chat" ? resetTail : "") + line(publicChat));
      for (const skip of [0, 1, 2, 99]) {
        const history = await h.historyService.getHistoryFromLatestBoundary(workspaceId, skip);
        expect(history.success).toBe(true);
        if (!history.success) throw new Error(history.error);
        expect(history.data.map((message) => message.id)).toEqual([
          reset.id,
          publicArchive.id,
          publicChat.id,
        ]);
        expect(await providerIds(skip)).toEqual([publicArchive.id, publicChat.id]);
      }
    }
  );

  test("skips legal rollovers and compactions but stop at the preceding manual reset", async () => {
    const reset = createMuxMessage("manual-reset", "assistant", "", {
      contextBoundaryKind: "reset",
    });
    await fs.writeFile(archivePath, line(boundary) + line(old) + line(reset) + line(publicArchive));
    await fs.writeFile(
      chatPath,
      JSON.stringify({
        id: "automatic-rollover",
        role: "assistant",
        parts: [],
        metadata: rollover,
      }) +
        "\n" +
        line({ ...boundary, id: "new-summary" }) +
        line(publicChat)
    );
    for (const [skip, expected] of [
      [0, ["new-summary", publicChat.id]],
      [1, ["automatic-rollover", "new-summary", publicChat.id]],
      [2, [reset.id, publicArchive.id, "automatic-rollover", "new-summary", publicChat.id]],
      [99, [reset.id, publicArchive.id, "automatic-rollover", "new-summary", publicChat.id]],
    ] as const) {
      const history = await h.historyService.getHistoryFromLatestBoundary(workspaceId, skip);
      expect(history.success).toBe(true);
      if (!history.success) throw new Error(history.error);
      expect(history.data.map((message) => message.id)).toEqual([...expected]);
      expect(await providerIds(skip)).toEqual(["new-summary", publicChat.id]);
    }
  });

  test("skip falls back within the newest malformed floor instead of an older archive boundary", async () => {
    await fs.writeFile(archivePath, line(boundary) + line(old));
    const raw = '{"metadata":{"contextBoundaryKind" : "reset"},broken\n';
    await fs.writeFile(
      chatPath,
      raw + line(publicArchive) + line({ ...boundary, id: "new-summary" }) + line(publicChat)
    );
    expect(await providerIds()).toEqual(["new-summary", publicChat.id]);
    for (const skip of [1, 30]) {
      const history = await h.historyService.getHistoryFromLatestBoundary(workspaceId, skip);
      expect(history.success).toBe(true);
      if (!history.success) throw new Error(history.error);
      expect(history.data.map((message) => message.id)).toEqual([
        publicArchive.id,
        "new-summary",
        publicChat.id,
      ]);
      expect(await providerIds(skip)).toEqual(["new-summary", publicChat.id]);
    }
  });

  test("a reset escape split across a reverse-read chunk remains a hard floor", async () => {
    const suffix = 't"},broken\n';
    const publicLine = line(publicChat);
    const padding = SESSION_HISTORY_SCAN_CHUNK_BYTES - (2 + suffix.length + publicLine.length);
    await fs.writeFile(
      chatPath,
      line(old) +
        '{"metadata":{"contextBoundaryKind":"res\\x65' +
        suffix +
        " ".repeat(padding) +
        publicLine
    );
    expect(await providerIds(10)).toEqual([publicChat.id]);
  });

  test("provider reads retain more than tool scan budgets and oversized ordinary messages", async () => {
    const rows = Array.from({ length: SESSION_HISTORY_MAX_SCAN_ROWS + 10 }, (_, i) =>
      createMuxMessage(`public-${i}`, "user", "facts ".repeat(800))
    );
    rows.push(createMuxMessage("large", "user", "a".repeat(SESSION_HISTORY_MAX_LINE_BYTES + 1)));
    const contents = line(boundary) + rows.map(line).join("");
    expect(Buffer.byteLength(contents)).toBeGreaterThan(SESSION_HISTORY_MAX_SCAN_BYTES);
    await fs.writeFile(chatPath, contents);
    expect(await providerIds()).toEqual([boundary.id, ...rows.map((message) => message.id)]);
  });

  test.each(["text", "tool"])(
    "readable nested %s reset data is not a provider privacy floor",
    async (kind) => {
      const data = { contextBoundaryKind: "reset", value: "ordinary data" };
      const message =
        kind === "text"
          ? createMuxMessage("marker-data", "assistant", JSON.stringify(data))
          : createMuxMessage("marker-data", "assistant", "", undefined, [
              {
                type: "dynamic-tool",
                toolCallId: "payload",
                toolName: "bash",
                state: "output-available",
                input: {},
                output: data,
              },
            ]);
      await fs.writeFile(archivePath, line(old));
      await fs.writeFile(chatPath, line(message) + line(publicChat));
      const history = await h.historyService.getHistoryFromLatestBoundary(workspaceId);
      expect(history.success).toBe(true);
      if (!history.success) throw new Error(history.error);
      expect(history.data.map((row) => row.id)).toEqual([old.id, message.id, publicChat.id]);
      expect(await providerIds()).toEqual([old.id, message.id, publicChat.id]);
    }
  );

  test("ordinary reset-like payloads remain rewritable but cannot replace a manual boundary", async () => {
    const parts: MuxMessage["parts"] = [
      {
        type: "dynamic-tool",
        toolCallId: "payload",
        toolName: "bash",
        state: "output-available",
        input: {},
        output: { contextBoundaryKind: "reset" },
      },
    ];
    const ordinary = createMuxMessage("ordinary", "assistant", "", undefined, parts);
    expect((await h.historyService.appendToHistory(workspaceId, ordinary)).success).toBe(true);
    expect(
      (
        await h.historyService.updateHistory(workspaceId, {
          ...ordinary,
          parts: [{ type: "text", text: "updated data" }],
        })
      ).success
    ).toBe(true);
    expect(await providerIds()).toEqual([old.id, ordinary.id]);
    const reset = createMuxMessage("manual", "assistant", "", { contextBoundaryKind: "reset" });
    expect((await h.historyService.appendToHistory(workspaceId, reset)).success).toBe(true);
    expect(
      (
        await h.historyService.updateHistory(workspaceId, {
          ...reset,
          metadata: { historySequence: reset.metadata!.historySequence },
          parts,
        })
      ).success
    ).toBe(false);
    expect(await providerIds()).toEqual([]);
  });

  test("valid rollover boundaries stay readable while malformed trailing rows are filtered", async () => {
    const marker =
      JSON.stringify({ id: "rollover", role: "assistant", parts: [], metadata: rollover }) + "\n";
    await fs.writeFile(archivePath, line(old));
    await fs.writeFile(
      chatPath,
      marker + line(publicChat) + '{"id":"invalid","role":"user"}\nnull\n'
    );
    const history = await h.historyService.getHistoryFromLatestBoundary(workspaceId);
    expect(history.success).toBe(true);
    if (!history.success) throw new Error(history.error);
    expect(history.data.map((message) => message.id)).toEqual(["rollover", publicChat.id]);
    expect(await providerIds()).toEqual([publicChat.id]);
  });

  test("a normal latest-boundary read does not scan sealed archive contents", async () => {
    await fs.writeFile(archivePath, line(old).repeat(1000));
    await fs.writeFile(chatPath, line(boundary) + line(publicChat));
    const originalOpen = fs.open;
    const archiveReads: Array<{ mock: { calls: unknown[] }; mockRestore(): void }> = [];
    const opened = spyOn(fs, "open").mockImplementation(async (...args) => {
      const handle = await originalOpen(...args);
      if (args[0] === archivePath) archiveReads.push(spyOn(handle, "read"));
      return handle;
    });
    try {
      expect(await providerIds()).toEqual([boundary.id, publicChat.id]);
      expect(archiveReads.length).toBeGreaterThan(0);
      expect(archiveReads.every((read) => read.mock.calls.length === 0)).toBe(true);
    } finally {
      for (const read of archiveReads) read.mockRestore();
      opened.mockRestore();
    }
  });

  test("provider rows fail closed when a pathname is replaced after raw offset discovery", async () => {
    await fs.writeFile(chatPath, line(old) + line(publicChat));
    const replacement = `${chatPath}.replacement`;
    await fs.writeFile(
      replacement,
      line(old) + '{"metadata":{"contextBoundaryKind" : "reset"},broken\n' + line(publicChat)
    );
    const originalStat = fs.stat;
    let replaced = false;
    const racingStat = spyOn(fs, "stat").mockImplementation((async (
      ...args: Parameters<typeof fs.stat>
    ) => {
      if (args[0] === chatPath && !replaced) {
        replaced = true;
        await fs.rename(replacement, chatPath);
      }
      return originalStat(...args);
    }) as typeof fs.stat);
    try {
      const history = await h.historyService.getHistoryFromLatestBoundary(workspaceId);
      expect(replaced).toBe(true);
      expect(history.success).toBe(false);
    } finally {
      racingStat.mockRestore();
    }
    expect(await providerIds()).toEqual([publicChat.id]);
  });

  test("valid boundary skip/fallback remains unchanged without an unreadable floor", async () => {
    await fs.writeFile(archivePath, line(boundary) + line(publicArchive));
    await fs.writeFile(chatPath, line({ ...boundary, id: "new-summary" }) + line(publicChat));
    expect(await providerIds()).toEqual(["new-summary", publicChat.id]);
    for (const skip of [1, 99]) {
      const history = await h.historyService.getHistoryFromLatestBoundary(workspaceId, skip);
      expect(history.success).toBe(true);
      if (!history.success) throw new Error(history.error);
      expect(history.data.map((message) => message.id)).toEqual([
        "summary",
        publicArchive.id,
        "new-summary",
        publicChat.id,
      ]);
      expect(await providerIds(skip)).toEqual(["new-summary", publicChat.id]);
    }
  });
});

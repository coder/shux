import { afterEach, beforeEach, expect, spyOn, test } from "bun:test";
import * as fs from "node:fs/promises";
import * as path from "node:path";
import { createMuxMessage, type MuxMessage } from "@/common/types/message";
import {
  SESSION_HISTORY_MAX_ID_CHARS,
  SESSION_HISTORY_MAX_RESULT_BYTES,
} from "@/common/constants/contextBudget";
import type { TaskService } from "@/node/services/taskService";
import { createRolloverPrefix } from "@/node/services/contextWindowRollover";
import { createTestHistoryService } from "@/node/services/testHistoryService";
import { TOOL_DEFINITIONS } from "@/common/utils/tools/toolDefinitions";
import { createSessionHistoryTool, type SessionHistoryArgs } from "./session_history";
import { createTestToolConfig, mockToolCallOptions } from "./testHelpers";

let fixture: Awaited<ReturnType<typeof createTestHistoryService>>;
const workspaceId = "budget-history";
const serialize = (messages: MuxMessage[]) =>
  messages.map((row) => JSON.stringify(row) + "\n").join("");

beforeEach(async () => {
  fixture = await createTestHistoryService();
});
afterEach(async () => {
  await fixture.cleanup();
});

async function seed(chat: MuxMessage[], archive: MuxMessage[] = [], workspace = workspaceId) {
  const dir = path.join(fixture.config.sessionsDir, workspace);
  await fs.mkdir(dir, { recursive: true });
  await fs.writeFile(path.join(dir, "chat.jsonl"), serialize(chat));
  await fs.writeFile(path.join(dir, "chat-archive.jsonl"), serialize(archive));
}

async function call(args: SessionHistoryArgs, abortSignal?: AbortSignal) {
  const config = createTestToolConfig(fixture.tempDir, { workspaceId });
  config.historyService = fixture.historyService;
  config.taskService = {
    resolveDescendantAgentTaskBranchRoot: () =>
      Promise.resolve({ status: "live", branchRootTaskId: "child" }),
  } as unknown as TaskService;
  return TOOL_DEFINITIONS.session_history.resultSchema.parse(
    await createSessionHistoryTool(config).execute!(args, { ...mockToolCallOptions, abortSignal })
  );
}

test("a 15.5MiB rollover-only archive needs no discovery-page chase", async () => {
  const prefixAt = (index: number) => {
    const prefix = createRolloverPrefix({
      type: "context-window-rollover",
      rolloverId: `rollover-${index}`,
      reason: "on-send",
      previousWindowId: index === 0 ? "w:0" : `w:${(index - 248) * 3}`,
      flushOpportunity: false,
      contextTokens: 150_000,
      maxTokens: 200_000,
    });
    prefix.forEach((row, offset) => {
      row.id = `prefix-${index}-${offset}`;
      row.metadata = { ...row.metadata, timestamp: 1, historySequence: index * 3 + offset };
    });
    return prefix;
  };
  const archive: MuxMessage[] = [];
  for (let index = 0; index < 1240; index++) {
    if (index % 248 === 0) archive.push(...prefixAt(index));
    archive.push(
      createMuxMessage(
        `archive-${index}`,
        index % 40 === 0 ? "user" : "assistant",
        "x".repeat(13_000),
        {
          timestamp: 1,
          historySequence: index * 3 + 2,
        }
      )
    );
  }
  const bytes = Buffer.byteLength(serialize(archive));
  expect(bytes).toBeGreaterThan(15 * 1024 * 1024);
  expect(bytes).toBeLessThan(16 * 1024 * 1024);
  const recent = ["first recent request", "second recent request", "latest request"];
  await seed(
    [
      ...prefixAt(1240),
      ...recent.map((text, index) =>
        createMuxMessage(`recent-${index}`, "user", text, {
          timestamp: 1,
          historySequence: 3722 + index,
        })
      ),
    ],
    archive
  );

  const windows = await call({ action: "list_windows" });
  expect(windows).toMatchObject({ success: true, status: "complete", exhausted: true });
  expect(windows.nextCursor).toBeUndefined();
  expect(windows.windows?.map((window) => window.windowId)).toEqual([
    "w:0",
    "w:744",
    "w:1488",
    "w:2232",
    "w:2976",
    "w:3720",
  ]);
  const messages = await call({ action: "list_items", role: "user", recent_first: true, limit: 3 });
  expect(messages.success).toBe(true);
  expect(messages.items?.map((item) => item.text)).toEqual(recent.toReversed());
  for (const result of [windows, messages]) {
    expect(result.bytesRead).toBeLessThanOrEqual(32 * 1024 * 1024);
    expect(result.rowsScanned).toBeLessThanOrEqual(10_000);
  }
});

test.each([false, true])(
  "production row exhaustion and sparse filtering preserve exact order (reverse=%s)",
  async (recentFirst) => {
    const rows = Array.from({ length: 10_040 }, (_, index) =>
      createMuxMessage(`row-${index}`, index % 1000 === 0 ? "user" : "assistant", `row ${index}`)
    );
    await seed(rows);
    let cursor: string | undefined;
    const contents: string[] = [];
    let pageCount = 0;
    do {
      const page = await call({
        action: "list_items",
        role: "user",
        recent_first: recentFirst,
        cursor,
      });
      expect(page.success).toBe(true);
      expect(page.rowsScanned).toBeLessThanOrEqual(10_000);
      expect(page.bytesRead).toBeLessThan(32 * 1024 * 1024);
      if (pageCount === 0) {
        expect(page.status).toBe("scanning");
        expect(page.rowsScanned).toBe(10_000);
      }
      contents.push(...(page.items ?? []).map((item) => item.text));
      cursor = page.nextCursor;
      expect(++pageCount).toBeLessThan(10);
    } while (cursor);
    const expected = rows
      .filter((row) => row.role === "user")
      .map((row) => row.parts[0])
      .map((part) => (part.type === "text" ? part.text : ""));
    expect(contents).toEqual(recentFirst ? expected.toReversed() : expected);
  }
);

test.each([false, true])(
  "production byte exhaustion preserves sparse results (reverse=%s)",
  async (recentFirst) => {
    const rows = Array.from({ length: 80 }, (_, index) =>
      createMuxMessage(
        `large-${index}`,
        index % 39 === 0 ? "user" : "assistant",
        index % 39 === 0 ? `request ${index}` : "x".repeat(450_000)
      )
    );
    await seed(rows);
    let cursor: string | undefined;
    const contents: string[] = [];
    let pages = 0;
    do {
      const page = await call({
        action: "list_items",
        role: "user",
        recent_first: recentFirst,
        cursor,
      });
      expect(page.success).toBe(true);
      expect(page.rowsScanned).toBeLessThan(10_000);
      expect(page.bytesRead).toBeLessThanOrEqual(32 * 1024 * 1024);
      if (pages === 0) {
        expect(page.status).toBe("scanning");
        expect(page.bytesRead).toBeGreaterThan(31 * 1024 * 1024);
      }
      contents.push(...(page.items ?? []).map((item) => item.text));
      cursor = page.nextCursor;
      expect(++pages).toBeLessThan(10);
    } while (cursor);
    expect(contents).toEqual(
      recentFirst
        ? ["request 78", "request 39", "request 0"]
        : ["request 0", "request 39", "request 78"]
    );
  }
);

test("short-token reserve fits worst-case escaped metadata and preserves Unicode character pages", async () => {
  const id = "\u0000".repeat(Math.floor((SESSION_HISTORY_MAX_ID_CHARS - 6) / 6));
  const boundary = createMuxMessage(id, "assistant", "", {
    compactionBoundary: true,
    compacted: true,
    compactionEpoch: 1,
  });
  const text = '🧪\u0000\\"'.repeat(4_000);
  await seed([
    boundary,
    createMuxMessage("large", "user", text),
    createMuxMessage("next", "user", text),
  ]);
  const first = await call({ action: "list_items", max_chars_per_item: 16_000 });
  expect(first).toMatchObject({ success: true, status: "partial" });
  expect(Buffer.byteLength(JSON.stringify(first))).toBeLessThanOrEqual(
    SESSION_HISTORY_MAX_RESULT_BYTES
  );
  // Short handles leave the former cursor reserve available for useful payload.
  expect(Buffer.byteLength(JSON.stringify(first))).toBeGreaterThan(8 * 1024);
  expect(first.items?.[0]?.text.length).toBeGreaterThan(0);
  const item = first.items![0];
  expect(item.windowId).toBe(`w:m:${id}`);
  let recovered = item.text;
  let offset = item.nextCharOffset;
  while (offset !== undefined) {
    const page = await call({
      action: "read_item",
      item_id: item.itemId,
      offset_chars: offset,
      limit_chars: 16_000,
    });
    expect(page.success).toBe(true);
    expect(Buffer.byteLength(JSON.stringify(page))).toBeLessThanOrEqual(
      SESSION_HISTORY_MAX_RESULT_BYTES
    );
    recovered += page.items![0].text;
    offset = page.items![0].nextCharOffset;
  }
  expect(recovered).toBe(text);
});

function receipt() {
  return createMuxMessage("spawn", "assistant", "", undefined, [
    {
      type: "dynamic-tool",
      toolName: "task",
      toolCallId: "spawn-child",
      state: "output-available",
      input: {},
      output: { taskId: "child" },
    },
  ]);
}

test.each(["rows", "bytes"] as const)(
  "descendant authorization and target share the production %s limit",
  async (limit) => {
    const callerCount = limit === "rows" ? 4_000 : 20;
    const targetCount = limit === "rows" ? 3_000 : 50;
    const text = "x".repeat(limit === "rows" ? 10 : 400_000);
    const bulk = (count: number) =>
      Array.from({ length: count }, (_, index) =>
        createMuxMessage(`bulk-${index}`, "assistant", text)
      );
    await seed([...bulk(callerCount), receipt()]);
    await seed(
      [createMuxMessage("wanted", "user", "child request"), ...bulk(targetCount)],
      [],
      "child"
    );
    const args = { action: "list_items", role: "user", task_id: "child" } as const;
    const page = await call(args);
    expect(page).toMatchObject({ success: true, status: "scanning", items: [] });
    expect(page.rowsScanned).toBeLessThanOrEqual(10_000);
    expect(page.bytesRead).toBeLessThanOrEqual(32 * 1024 * 1024);
    if (limit === "rows") expect(page.rowsScanned).toBe(10_000);
    else expect(page.bytesRead).toBeGreaterThan(31 * 1024 * 1024);
    let cursor = page.nextCursor;
    const texts: string[] = [];
    let pages = 0;
    while (cursor) {
      const next = await call({ ...args, cursor });
      expect(next.success).toBe(true);
      expect(next.rowsScanned).toBeLessThanOrEqual(10_000);
      expect(next.bytesRead).toBeLessThanOrEqual(32 * 1024 * 1024);
      texts.push(...(next.items ?? []).map((item) => item.text));
      cursor = next.nextCursor;
      expect(++pages).toBeLessThan(10);
    }
    expect(texts).toEqual(["child request"]);
  }
);

test.each(["deadline", "caller abort", "target abort"] as const)(
  "descendant scans share %s without converting cancellation to an error result",
  async (mode) => {
    await seed([receipt()]);
    await seed([createMuxMessage("wanted", "user", "child request")], [], "child");
    const controller = new AbortController();
    const reason = new Error("cancel descendant");
    let now = 0;
    let validations = 0;
    const clock = spyOn(performance, "now").mockImplementation(() => now);
    const scan = fixture.historyService.scanHistoryBoundedUnderLocks.bind(fixture.historyService);
    const validate = spyOn(
      fixture.historyService,
      "scanHistoryBoundedUnderLocks"
    ).mockImplementation(async (...args) => {
      const result = await scan(...args);
      validations++;
      if (mode === "deadline") now = 2_001;
      else if (validations === (mode === "caller abort" ? 1 : 2)) controller.abort(reason);
      return result;
    });
    try {
      const operation = call({ action: "list_items", task_id: "child" }, controller.signal);
      if (mode === "deadline") {
        const page = await operation;
        expect(page).toMatchObject({ success: true, status: "scanning", items: [] });
        expect(validations).toBe(1);
        validate.mockRestore();
        clock.mockRestore();
        expect(
          (
            await call({ action: "list_items", task_id: "child", cursor: page.nextCursor })
          ).items?.map((item) => item.text)
        ).toEqual(["child request"]);
      } else expect(await operation.catch((error: unknown) => error)).toBe(reason);
    } finally {
      validate.mockRestore();
      clock.mockRestore();
    }
    // Neither authorization nor target cancellation may leak either lock.
    expect(
      (await call({ action: "list_items", task_id: "child" })).items?.map((item) => item.text)
    ).toEqual(["child request"]);
  }
);

test("an already-aborted tool call propagates cancellation rather than history_unavailable", async () => {
  await seed([createMuxMessage("row", "user", "private")]);
  const controller = new AbortController();
  const reason = new Error("cancel history");
  controller.abort(reason);
  expect(
    await call({ action: "list_items" }, controller.signal).catch((error: unknown) => error)
  ).toBe(reason);
  expect((await call({ action: "list_items" })).items?.[0]?.text).toBe("private");
});

test("tool deadline returns resumable progress and still validates provenance", async () => {
  await seed([createMuxMessage("row", "user", "visible")]);
  let now = 0;
  const clock = spyOn(performance, "now").mockImplementation(() => (now += 2_001));
  try {
    const page = await call({ action: "list_items" });
    expect(page).toMatchObject({ success: true, status: "scanning", items: [] });
    clock.mockRestore();
    const resumed = await call({ action: "list_items", cursor: page.nextCursor });
    expect(resumed).toMatchObject({ success: true, status: "complete" });
    expect(resumed.items?.map((item) => item.text)).toEqual(["visible"]);
  } finally {
    clock.mockRestore();
  }
});

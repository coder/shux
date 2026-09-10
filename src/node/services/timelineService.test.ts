import * as path from "path";
import { afterEach, beforeEach, describe, expect, spyOn, test } from "bun:test";
import { existsSync } from "fs";
import * as fs from "fs/promises";
import { TIMELINE_FILE_NAME } from "@/common/constants/paths";
import {
  TIMELINE_TEXT_MAX_LENGTH,
  type TimelineEvent,
  type TimelineEventDraft,
} from "@/common/orpc/schemas/timeline";
import type { MuxMessage } from "@/common/types/message";
import { createTestHistoryService } from "@/node/services/testHistoryService";
import { TimelineService } from "./timelineService";

const WORKSPACE_ID = "timeline-test-workspace";

function draft(key: string, kind = "agent.event"): TimelineEventDraft {
  return {
    kind,
    source: { system: "agent", key },
    data: { description: key },
  };
}

function message(
  id: string,
  role: "user" | "assistant",
  text: string,
  metadata: MuxMessage["metadata"] = {}
): MuxMessage {
  return {
    id,
    role,
    parts: [{ type: "text", text }],
    metadata,
  };
}

describe("TimelineService", () => {
  let enabled: boolean;
  let service: TimelineService;
  let historyService: Awaited<ReturnType<typeof createTestHistoryService>>["historyService"];
  let config: Awaited<ReturnType<typeof createTestHistoryService>>["config"];
  let cleanup: () => Promise<void>;

  beforeEach(async () => {
    enabled = true;
    const testHistory = await createTestHistoryService();
    historyService = testHistory.historyService;
    config = testHistory.config;
    cleanup = testHistory.cleanup;
    service = new TimelineService(config, historyService, {
      isExperimentEnabled: () => enabled,
    });
  });

  afterEach(async () => {
    await service.flush();
    await cleanup();
  });

  function timelinePath(workspaceId = WORKSPACE_ID): string {
    return path.join(config.sessionsDir, workspaceId, TIMELINE_FILE_NAME);
  }

  test("continues monotonic sequences after service restart", async () => {
    service.record(WORKSPACE_ID, draft("first"));
    service.record(WORKSPACE_ID, draft("second"));
    await service.flush();

    service = new TimelineService(config, historyService, {
      isExperimentEnabled: () => enabled,
    });
    service.record(WORKSPACE_ID, draft("third"));
    await service.flush();

    const page = await service.list(WORKSPACE_ID, {});
    expect(page.events.map((event) => event.seq)).toEqual([3, 2, 1]);
  });

  test("paginates backward from newest events", async () => {
    for (let index = 1; index <= 5; index++) {
      service.record(WORKSPACE_ID, draft(`event-${index}`));
    }
    await service.flush();

    const first = await service.list(WORKSPACE_ID, { limit: 2 });
    expect(first.events.map((event) => event.seq)).toEqual([5, 4]);
    expect(first.nextCursor).toBe(4);
    expect(first.hasOlder).toBe(true);

    const second = await service.list(WORKSPACE_ID, {
      cursor: first.nextCursor ?? undefined,
      limit: 2,
    });
    expect(second.events.map((event) => event.seq)).toEqual([3, 2]);
    expect(second.nextCursor).toBe(2);
    expect(second.hasOlder).toBe(true);

    const last = await service.list(WORKSPACE_ID, {
      cursor: second.nextCursor ?? undefined,
      limit: 2,
    });
    expect(last.events.map((event) => event.seq)).toEqual([1]);
    expect(last.nextCursor).toBeNull();
    expect(last.hasOlder).toBe(false);
  });

  test("skips corrupt lines while reading", async () => {
    service.record(WORKSPACE_ID, draft("valid-1"));
    await service.flush();
    await fs.appendFile(timelinePath(), "{not-json\n", "utf-8");
    service.record(WORKSPACE_ID, draft("valid-2"));
    await service.flush();

    const page = await service.list(WORKSPACE_ID, {});
    expect(page.events.map((event) => event.data?.description)).toEqual(["valid-2", "valid-1"]);
  });

  test("preserves unknown event kinds", async () => {
    const unknownEvent: TimelineEvent = {
      v: 1,
      seq: 1,
      id: "unknown-event",
      ts: 100,
      kind: "future.event.kind",
      source: { system: "agent" },
    };
    await fs.mkdir(path.join(config.sessionsDir, WORKSPACE_ID), { recursive: true });
    await fs.writeFile(timelinePath(), `${JSON.stringify(unknownEvent)}\n`, "utf-8");

    const page = await service.list(WORKSPACE_ID, {});
    expect(page.events).toEqual([unknownEvent]);
  });

  test("hides retired rows without reusing their sequence numbers", async () => {
    // Legacy tool.call rows carry payload fields this build no longer declares.
    const retired = {
      v: 1,
      seq: 7,
      id: "retired-event",
      ts: 100,
      kind: "tool.call",
      source: { system: "chat" },
      data: { toolName: "bash", durationMs: 40, digest: "git status" },
    };
    await fs.mkdir(path.join(config.sessionsDir, WORKSPACE_ID), { recursive: true });
    await fs.writeFile(timelinePath(), `${JSON.stringify(retired)}\n`, "utf-8");

    service.record(WORKSPACE_ID, draft("after-retired"));
    await service.flush();

    const page = await service.list(WORKSPACE_ID, {});
    expect(page.events.map((event) => [event.kind, event.seq])).toEqual([["agent.event", 8]]);
  });

  test("keeps rows carrying payload fields from a newer build", async () => {
    const forwardCompatible = {
      v: 1,
      seq: 1,
      id: "future-payload",
      ts: 100,
      kind: "agent.event",
      source: { system: "agent" },
      data: { description: "Landed the slice", unknownFutureField: "keep me readable" },
    };
    await fs.mkdir(path.join(config.sessionsDir, WORKSPACE_ID), { recursive: true });
    await fs.writeFile(timelinePath(), `${JSON.stringify(forwardCompatible)}\n`, "utf-8");

    const page = await service.list(WORKSPACE_ID, {});
    expect(page.events.map((event) => event.data?.description)).toEqual(["Landed the slice"]);
  });

  test("bounds every free-text field, not just the digest", async () => {
    const huge = "x".repeat(TIMELINE_TEXT_MAX_LENGTH * 4);
    service.record(WORKSPACE_ID, {
      kind: "turn.failed",
      source: { system: "chat", key: "huge-error" },
      status: "failed",
      data: { reason: huge, digest: huge, description: huge, title: huge },
    });
    await service.flush();

    const page = await service.list(WORKSPACE_ID, {});
    const data = page.events[0]?.data;
    const truncated = `${"x".repeat(TIMELINE_TEXT_MAX_LENGTH - 3)}...`;
    expect([data?.reason, data?.digest, data?.description, data?.title]).toEqual([
      truncated,
      truncated,
      truncated,
      truncated,
    ]);
  });

  test("stamps a draft without a timestamp at record time, not when its write drains", async () => {
    const realAppendFile = fs.appendFile;
    const stallMs = 60;
    const appendFile = spyOn(fs, "appendFile").mockImplementationOnce(
      async (file, data, options) => {
        await new Promise((resolve) => setTimeout(resolve, stallMs));
        await realAppendFile(file, data, options);
      }
    );

    service.record(WORKSPACE_ID, draft("first"));
    service.record(WORKSPACE_ID, draft("second"));
    const recordedAt = Date.now();
    try {
      await service.flush();
    } finally {
      // Every test file shares one bun process, so a spy that outlives a failure here would stall
      // appends in unrelated suites.
      appendFile.mockRestore();
    }

    const page = await service.list(WORKSPACE_ID, {});
    const second = page.events.find((event) => event.data?.description === "second");
    expect(second?.ts).toBeLessThanOrEqual(recordedAt);
  });

  test("keeps rows whose source and anchor carry values from a newer build", async () => {
    const forwardCompatible = {
      v: 1,
      seq: 1,
      id: "future-nested",
      ts: 100,
      kind: "workflow.attached",
      source: { system: "workflow", key: "run-1", origin: "future" },
      anchor: { messageId: "message-1", stepId: "future-step" },
      status: "queued",
    };
    await fs.mkdir(path.join(config.sessionsDir, WORKSPACE_ID), { recursive: true });
    await fs.writeFile(timelinePath(), `${JSON.stringify(forwardCompatible)}\n`, "utf-8");

    const page = await service.list(WORKSPACE_ID, {});
    expect(page.events.map((event) => event.id)).toEqual(["future-nested"]);
    expect(page.events[0]?.anchor?.messageId).toBe("message-1");
  });

  test("previews a tool anchor with its readable input field", async () => {
    await historyService.appendToHistory(WORKSPACE_ID, {
      id: "assistant-tool",
      role: "assistant",
      parts: [
        {
          type: "dynamic-tool",
          toolCallId: "call-1",
          toolName: "task",
          state: "output-available",
          input: { title: "Investigate retry backoff", run_in_background: false },
          output: { taskId: "task-1", reportMarkdown: "long report" },
        },
      ],
      metadata: {},
    });

    const preview = await service.previewAnchor(WORKSPACE_ID, { toolCallId: "call-1" });
    expect(preview).toEqual({ role: "assistant", textExcerpt: "Investigate retry backoff" });
  });

  test("does not create a file when the experiment is off", async () => {
    enabled = false;
    service.record(WORKSPACE_ID, draft("disabled"));
    await service.flush();

    let error: unknown;
    try {
      await fs.stat(timelinePath());
    } catch (caught) {
      error = caught;
    }
    expect(error).toMatchObject({ code: "ENOENT" });
  });

  test("rejects an invalid draft without consuming a sequence number", async () => {
    service.record(WORKSPACE_ID, {
      kind: "turn.user",
      source: { system: "chat", key: "invalid-anchor" },
      anchor: { messageId: "" },
    });
    service.record(WORKSPACE_ID, draft("after-invalid"));
    await service.flush();

    const page = await service.list(WORKSPACE_ID, {});
    expect(page.events.map((event) => [event.data?.description, event.seq])).toEqual([
      ["after-invalid", 1],
    ]);
  });

  test("drops duplicate recent source keys", async () => {
    service.record(WORKSPACE_ID, draft("same-key"));
    service.record(WORKSPACE_ID, draft("same-key"));
    await service.flush();

    const page = await service.list(WORKSPACE_ID, {});
    expect(page.events).toHaveLength(1);
  });

  test("releases a source key when its append fails so the event can be recorded again", async () => {
    const appendFile = spyOn(fs, "appendFile").mockImplementationOnce(() => {
      throw new Error("disk full");
    });

    service.record(WORKSPACE_ID, draft("retryable"));
    await service.flush();
    expect(appendFile).toHaveBeenCalledTimes(1);

    service.record(WORKSPACE_ID, draft("retryable"));
    await service.flush();
    appendFile.mockRestore();

    const page = await service.list(WORKSPACE_ID, {});
    expect(page.events.map((event) => event.source.key)).toEqual(["retryable"]);
  });

  test("releases a source key when a write fails before the append itself", async () => {
    // mkdir runs before the append, so this only passes if the whole queued write releases the key.
    const mkdir = spyOn(fs, "mkdir").mockImplementationOnce(() => {
      throw new Error("permission denied");
    });

    service.record(WORKSPACE_ID, draft("retryable-early"));
    await service.flush();
    expect(mkdir).toHaveBeenCalledTimes(1);
    mkdir.mockRestore();

    service.record(WORKSPACE_ID, draft("retryable-early"));
    await service.flush();

    const page = await service.list(WORKSPACE_ID, {});
    expect(page.events.map((event) => event.source.key)).toEqual(["retryable-early"]);
  });

  test("skips a row whose timestamp Date cannot represent, keeping the rest of the feed", async () => {
    service.record(WORKSPACE_ID, draft("valid"));
    await service.flush();
    // 9e15 exceeds the maximum Date value, so rendering it would throw a RangeError.
    await fs.appendFile(
      timelinePath(),
      `${JSON.stringify({
        v: 1,
        seq: 2,
        id: "out-of-range",
        ts: 9e15,
        kind: "turn.user",
        source: { system: "chat" },
      })}\n`,
      "utf-8"
    );

    const page = await service.list(WORKSPACE_ID, {});
    expect(page.events.map((event) => event.source.key)).toEqual(["valid"]);
  });

  test("drops records for a closed workspace so a late append cannot recreate its session dir", async () => {
    service.record(WORKSPACE_ID, draft("before-close"));
    await service.closeWorkspace(WORKSPACE_ID);
    await fs.rm(path.join(config.sessionsDir, WORKSPACE_ID), { recursive: true, force: true });

    service.record(WORKSPACE_ID, draft("after-close"));
    await service.flush();

    expect(existsSync(path.join(config.sessionsDir, WORKSPACE_ID))).toBe(false);
  });

  test("keeps a new event readable after an interrupted write left an unterminated line", async () => {
    service.record(WORKSPACE_ID, draft("first"));
    await service.flush();
    // Simulate a crash mid-append: a partial record with no trailing newline.
    await fs.appendFile(timelinePath(), '{"v":1,"seq":2,"id":"partial"', "utf-8");

    service.record(WORKSPACE_ID, draft("after-crash"));
    await service.flush();

    const page = await service.list(WORKSPACE_ID, {});
    expect(page.events.map((event) => event.source.key)).toEqual(["after-crash", "first"]);
  });

  test("bounds an unbounded digest before it reaches the append-only log", async () => {
    service.record(WORKSPACE_ID, {
      kind: "task.reported",
      source: { system: "task", key: "huge-report" },
      data: { digest: "x".repeat(5000) },
    });
    await service.flush();

    const page = await service.list(WORKSPACE_ID, {});
    const digest = page.events[0].data?.digest ?? "";
    expect(digest).toHaveLength(TIMELINE_TEXT_MAX_LENGTH);
    expect(digest.endsWith("...")).toBe(true);
  });

  test("does not scan history for anchors without transcript targets", async () => {
    const iterateFullHistory = spyOn(historyService, "iterateFullHistory");

    expect(
      await service.previewAnchor(WORKSPACE_ID, { childWorkspaceId: "child-workspace" })
    ).toBeNull();
    expect(iterateFullHistory).not.toHaveBeenCalled();
  });

  test("previews a message stored only in the sealed archive", async () => {
    await historyService.appendToHistory(
      WORKSPACE_ID,
      message("target", "user", "Archived target text", { timestamp: 123 })
    );
    await historyService.appendToHistory(
      WORKSPACE_ID,
      message("newer-user", "user", "Newer qualifying text", { timestamp: 124 })
    );
    await historyService.appendToHistory(
      WORKSPACE_ID,
      message("boundary", "assistant", "Summary", {
        compactionBoundary: true,
        compacted: "user",
        compactionEpoch: 1,
      })
    );

    const preview = await service.previewAnchor(WORKSPACE_ID, { messageId: "target" });
    expect(preview).toEqual({
      role: "user",
      textExcerpt: "Archived target text",
    });

    const archived = await fs.readFile(
      path.join(config.sessionsDir, WORKSPACE_ID, "chat-archive.jsonl"),
      "utf-8"
    );
    expect(archived).toContain('"id":"target"');
    const active = await fs.readFile(
      path.join(config.sessionsDir, WORKSPACE_ID, "chat.jsonl"),
      "utf-8"
    );
    expect(active).not.toContain('"id":"target"');
  });

  test("history compaction leaves the timeline bytes unchanged", async () => {
    service.record(WORKSPACE_ID, draft("durable"));
    await service.flush();
    const before = await fs.readFile(timelinePath());

    await historyService.appendToHistory(WORKSPACE_ID, message("user", "user", "Before boundary"));
    await historyService.appendToHistory(
      WORKSPACE_ID,
      message("boundary", "assistant", "Summary", {
        compactionBoundary: true,
        compacted: "user",
        compactionEpoch: 1,
      })
    );

    const after = await fs.readFile(timelinePath());
    expect(after.equals(before)).toBe(true);
  });
});

import { describe, expect, test } from "bun:test";
import {
  applyChatEvent,
  createTranscriptState,
  getVisibleMessages,
  type WorkspaceChatMessage,
} from "./transcript";

const start: Extract<WorkspaceChatMessage, { type: "stream-start" }> = {
  type: "stream-start",
  workspaceId: "w",
  messageId: "a",
  model: "test:model",
  historySequence: 2,
  startTime: 10,
};
const delta = (
  text: string,
  type: "stream-delta" | "reasoning-delta" = "stream-delta"
): WorkspaceChatMessage => ({
  type,
  workspaceId: "w",
  messageId: "a",
  delta: text,
  tokens: 1,
  timestamp: 12,
});
const row = (id: string, historySequence: number, text: string): WorkspaceChatMessage => ({
  type: "message",
  id,
  role: "user",
  parts: [{ type: "text", text }],
  metadata: { historySequence },
});
const replay = (...events: WorkspaceChatMessage[]) =>
  events.reduce(applyChatEvent, createTranscriptState());
const tool: Extract<WorkspaceChatMessage, { type: "tool-call-start" }> = {
  type: "tool-call-start",
  workspaceId: "w",
  messageId: "a",
  toolCallId: "t",
  toolName: "bash",
  args: { script: "pwd" },
  tokens: 3,
  timestamp: 13,
};
const toolEnd: Extract<WorkspaceChatMessage, { type: "tool-call-end" }> = {
  type: "tool-call-end",
  workspaceId: "w",
  messageId: "a",
  toolCallId: "t",
  toolName: "bash",
  result: { output: "/project" },
  timestamp: 14,
};

describe("mobile transcript", () => {
  test("visibility preserves raw hidden tool events, partial recovery and explicit notices", () => {
    const state = replay(
      start,
      tool,
      {
        type: "message",
        id: "a",
        role: "assistant",
        parts: [],
        metadata: { historySequence: 2, synthetic: true, partial: true },
      },
      tool,
      toolEnd,
      {
        type: "stream-abort",
        workspaceId: "w",
        messageId: "a",
        abortReason: "system",
      }
    );
    expect(getVisibleMessages(state.messages)).toEqual([]);
    expect(state.messages[0].parts[0]).toMatchObject({
      toolCallId: "t",
      input: tool.args,
      output: toolEnd.result,
      state: "output-available",
    });
    expect(state.messages[0].metadata).toMatchObject({ partial: true, historySequence: 2 });
    expect(state.streaming).toBe(false);
    const notice = applyChatEvent(state, {
      ...state.messages[0],
      type: "message",
      metadata: { ...state.messages[0].metadata, uiVisible: true },
    });
    expect(getVisibleMessages(notice.messages)).toEqual(notice.messages);
    const result = applyChatEvent(notice, {
      ...notice.messages[0],
      type: "message",
      metadata: {
        ...notice.messages[0].metadata,
        muxMetadata: { type: "workflow-result", rawCommand: "/run", runId: "wfr_test" },
      },
    });
    expect(getVisibleMessages(result.messages)).toEqual([]);
    expect(
      getVisibleMessages(
        replay(...result.messages.map((message) => ({ ...message, type: "message" as const })))
          .messages
      )
    ).toEqual([]);
  });

  test.each(["user", "system", "startup"] as const)(
    "records %s abort intent without suppressing involuntary recovery",
    (abortReason) => {
      const stopped = replay(start, delta("partial"), {
        type: "stream-abort",
        workspaceId: "w",
        messageId: "a",
        abortReason,
      });
      expect(stopped.messages[0].metadata?.userStopped).toBe(
        abortReason === "user" ? true : undefined
      );
      const replayed = replay({ ...stopped.messages[0], type: "message" });
      expect(replayed.messages[0].metadata?.userStopped).toBe(
        stopped.messages[0].metadata?.userStopped
      );
      const resumed = applyChatEvent(stopped, start);
      expect(resumed.messages[0].metadata?.userStopped).toBeUndefined();
    }
  );

  test("replaces authoritative snapshots by ID and sorts by server sequence", () => {
    const state = replay(row("b", 3, "later"), row("u", 1, "old"), row("u", 1, "edited"), {
      type: "caught-up",
      replay: "full",
      hasOlderHistory: true,
    });
    expect(state.messages.map((m) => m.id)).toEqual(["u", "b"]);
    expect(state.messages[0].parts).toEqual([{ type: "text", text: "edited" }]);
    expect(state.caughtUp).toBe(true);
    expect(state.hasOlderHistory).toBe(true);
    expect(state.streaming).toBe(false);
  });

  test("preserves text/reasoning/tool temporal order without mutating prior state", () => {
    const before = replay(row("u", 1, "hi"), start, delta("think", "reasoning-delta"));
    const snapshot = structuredClone(before);
    const state = [
      delta(" more", "reasoning-delta"),
      { type: "reasoning-end", workspaceId: "w", messageId: "a" } satisfies WorkspaceChatMessage,
      delta("Hello"),
      delta(" world"),
      tool,
      toolEnd,
      delta(" done"),
    ].reduce(applyChatEvent, before);
    expect(before).toEqual(snapshot);
    expect(state.streaming).toBe(true);
    expect(state.messages[1].parts).toMatchObject([
      { type: "reasoning", text: "think more" },
      { type: "text", text: "Hello world" },
      {
        type: "dynamic-tool",
        toolCallId: "t",
        input: { script: "pwd" },
        state: "output-available",
        output: { output: "/project" },
      },
      { type: "text", text: " done" },
    ]);
  });

  test("tool argument deltas do not replace parsed args, duplicate starts do not duplicate tools", () => {
    const state = replay(
      start,
      { ...tool, type: "tool-call-delta", delta: '{"script":' },
      tool,
      {
        type: "tool-call-execution-start",
        workspaceId: "w",
        messageId: "a",
        toolCallId: "t",
        timestamp: 20,
      },
      toolEnd,
      tool
    );
    expect(state.messages[0].parts).toHaveLength(1);
    expect(state.messages[0].parts[0]).toMatchObject({
      input: { script: "pwd" },
      state: "output-available",
      executionStartedAt: 20,
    });
  });

  test("nested tools remain in their parent and retain completed output", () => {
    const state = replay(
      start,
      tool,
      { ...tool, toolCallId: "child", parentToolCallId: "t" },
      { ...toolEnd, toolCallId: "child", parentToolCallId: "t" }
    );
    expect(state.messages[0].parts).toHaveLength(1);
    expect(state.messages[0].parts[0]).toMatchObject({
      nestedCalls: [{ toolCallId: "child", state: "output-available", output: toolEnd.result }],
    });
  });

  test("stream-end replaces deltas with authoritative parts and preserves ordering metadata", () => {
    const end: WorkspaceChatMessage = {
      type: "stream-end",
      workspaceId: "w",
      messageId: "a",
      metadata: { model: "other:model" },
      parts: [{ type: "text", text: "final" }],
    };
    const state = replay(start, delta("draft"), end, delta("late"));
    expect(state.messages[0].parts).toEqual(end.parts);
    expect(state.messages[0].metadata).toMatchObject({
      historySequence: 2,
      model: "other:model",
      partial: false,
    });
    expect(state.streaming).toBe(false);
    expect(replay(end).messages[0].parts).toEqual(end.parts);
  });

  test("interruption keeps partial text, abandonment removes it", () => {
    const abort: WorkspaceChatMessage = {
      type: "stream-abort",
      workspaceId: "w",
      messageId: "a",
      abortReason: "user",
    };
    const state = replay(start, delta("partial"), tool, abort);
    expect(state.streaming).toBe(false);
    expect(state.messages[0].metadata?.partial).toBe(true);
    expect(state.messages[0].parts).toHaveLength(2);
    expect(applyChatEvent(state, { ...abort, abandonPartial: true }).messages).toEqual([]);
  });

  test("errors terminate output, later start clears the error, stale terminal events do not stop a newer stream", () => {
    const state = replay(start, delta("partial"), {
      type: "stream-error",
      messageId: "a",
      error: "provider failed",
      errorType: "unknown",
    });
    expect(state.error).toBe("provider failed");
    expect(state.streaming).toBe(false);
    expect(state.messages[0].metadata?.partial).toBe(true);
    const next = applyChatEvent(state, { ...start, messageId: "next", historySequence: 3 });
    expect(next.error).toBeNull();
    expect(
      applyChatEvent(next, { type: "stream-abort", workspaceId: "w", messageId: "a" }).streaming
    ).toBe(true);
  });

  test("full replay resets old history and does not duplicate streamed text on reconnect", () => {
    const first = replay(row("deleted", 1, "gone"), start, delta("old"));
    expect(first.messages).toHaveLength(2);
    const second = replay(
      row("a", 2, "partial snapshot"),
      { ...start, replay: true },
      delta("fresh"),
      { type: "caught-up", replay: "full" }
    );
    expect(second.messages.map((m) => m.id)).toEqual(["a"]);
    expect(second.messages[0].parts).toMatchObject([{ type: "text", text: "fresh" }]);
    expect(second.streaming).toBe(true);
  });

  test("deletion/truncation drops server sequences and the active stream without resurrecting it", () => {
    const state = replay(
      row("u", 1, "keep"),
      start,
      delta("remove"),
      { type: "delete", historySequences: [2] },
      delta("late")
    );
    expect(state.messages.map((m) => m.id)).toEqual(["u"]);
    expect(state.streaming).toBe(false);
  });

  test("preparing/completing stay busy and terminal lifecycle is idle", () => {
    const state = replay(
      { type: "stream-lifecycle", workspaceId: "w", phase: "preparing", hadAnyOutput: false },
      { type: "caught-up", replay: "full" }
    );
    expect(state.streaming).toBe(true);
    expect(state.caughtUp).toBe(true);
    expect(
      applyChatEvent(state, {
        type: "stream-lifecycle",
        workspaceId: "w",
        phase: "failed",
        hadAnyOutput: false,
      }).streaming
    ).toBe(false);
  });
});

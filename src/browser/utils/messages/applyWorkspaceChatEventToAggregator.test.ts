import { describe, expect, test } from "bun:test";

import { CUSTOM_EVENTS } from "@/common/constants/events";
import type { DeleteMessage, StreamErrorMessage, WorkspaceChatMessage } from "@/common/orpc/types";
import type {
  ReasoningDeltaEvent,
  ReasoningEndEvent,
  RuntimeStatusEvent,
  StreamAbortEvent,
  StreamDeltaEvent,
  StreamEndEvent,
  StreamStartEvent,
  StreamMetadataEvent,
  ToolCallDeltaEvent,
  ToolCallEndEvent,
  ToolCallExecutionStartEvent,
  ToolCallStartEvent,
  UsageDeltaEvent,
} from "@/common/types/stream";

import {
  applyWorkspaceChatEventToAggregator,
  type WorkspaceChatEventAggregator,
} from "./applyWorkspaceChatEventToAggregator";

class StubAggregator implements WorkspaceChatEventAggregator {
  readonly calls: string[] = [];

  handleStreamStart(data: StreamStartEvent): void {
    this.calls.push(`handleStreamStart:${data.messageId}`);
  }

  handleStreamMetadata(data: StreamMetadataEvent): void {
    this.calls.push(`handleStreamMetadata:${data.messageId}`);
  }

  handleStreamDelta(data: StreamDeltaEvent): void {
    this.calls.push(`handleStreamDelta:${data.messageId}`);
  }

  handleStreamEnd(data: StreamEndEvent): void {
    this.calls.push(`handleStreamEnd:${data.messageId}`);
  }

  handleStreamAbort(data: StreamAbortEvent): void {
    this.calls.push(`handleStreamAbort:${data.messageId}`);
  }

  handleStreamError(data: StreamErrorMessage): void {
    this.calls.push(`handleStreamError:${data.messageId}`);
  }

  handleStreamLifecycle(data: Extract<WorkspaceChatMessage, { type: "stream-lifecycle" }>): void {
    this.calls.push(`handleStreamLifecycle:${data.phase}`);
  }
  handleToolCallStart(data: ToolCallStartEvent): void {
    this.calls.push(`handleToolCallStart:${data.toolCallId}`);
  }

  handleToolCallExecutionStart(data: ToolCallExecutionStartEvent): void {
    this.calls.push(`handleToolCallExecutionStart:${data.toolCallId}`);
  }

  handleToolCallDelta(data: ToolCallDeltaEvent): void {
    this.calls.push(`handleToolCallDelta:${data.toolCallId}`);
  }

  handleToolCallEnd(data: ToolCallEndEvent): void {
    this.calls.push(`handleToolCallEnd:${data.toolCallId}`);
  }

  handleReasoningDelta(data: ReasoningDeltaEvent): void {
    this.calls.push(`handleReasoningDelta:${data.messageId}`);
  }

  handleReasoningEnd(data: ReasoningEndEvent): void {
    this.calls.push(`handleReasoningEnd:${data.messageId}`);
  }

  handleUsageDelta(data: UsageDeltaEvent): void {
    this.calls.push(`handleUsageDelta:${data.messageId}`);
  }

  handleDeleteMessage(data: DeleteMessage): void {
    this.calls.push(`handleDeleteMessage:${data.historySequences.join(",")}`);
  }

  handleMessage(data: WorkspaceChatMessage): void {
    this.calls.push(`handleMessage:${data.type}`);
  }

  handleRuntimeStatus(data: RuntimeStatusEvent): void {
    this.calls.push(`handleRuntimeStatus:${data.phase}:${data.runtimeType}`);
  }

  clearTokenState(messageId: string): void {
    this.calls.push(`clearTokenState:${messageId}`);
  }
}

describe("applyWorkspaceChatEventToAggregator", () => {
  function withDispatchSpy<T>(run: (dispatched: Event[]) => T): T {
    const originalWindow = globalThis.window;
    const originalCustomEvent = globalThis.CustomEvent;
    const dispatched: Event[] = [];

    // CI bun environment may lack CustomEvent (it was previously provided by happy-dom).
    // createCustomEvent() in src/common/constants/events.ts uses `new CustomEvent(...)`.
    if (typeof globalThis.CustomEvent === "undefined") {
      // Minimal polyfill: only needs to carry .type and .detail for our assertions.
      globalThis.CustomEvent = class CustomEvent extends Event {
        detail: unknown;

        constructor(type: string, init?: CustomEventInit) {
          super(type, init);
          this.detail = init?.detail;
        }
      } as typeof globalThis.CustomEvent;
    }

    globalThis.window = {
      dispatchEvent: (event: Event) => {
        dispatched.push(event);
        return true;
      },
    } as unknown as Window & typeof globalThis;

    try {
      return run(dispatched);
    } finally {
      globalThis.window = originalWindow;
      globalThis.CustomEvent = originalCustomEvent;
    }
  }

  test("stream-start routes to handleStreamStart", () => {
    const aggregator = new StubAggregator();

    const event: WorkspaceChatMessage = {
      type: "stream-start",
      workspaceId: "ws-1",
      messageId: "msg-1",
      historySequence: 1,
      model: "test-model",
      startTime: 0,
    };

    const hint = applyWorkspaceChatEventToAggregator(aggregator, event);

    expect(hint).toBe("immediate");
    expect(aggregator.calls).toEqual(["handleStreamStart:msg-1"]);
  });

  test("stream-delta routes to handleStreamDelta and is throttled", () => {
    const aggregator = new StubAggregator();

    const event: WorkspaceChatMessage = {
      type: "stream-delta",
      workspaceId: "ws-1",
      messageId: "msg-1",
      delta: "hi",
      tokens: 1,
      timestamp: 1,
    };

    const hint = applyWorkspaceChatEventToAggregator(aggregator, event);

    expect(hint).toBe("throttled");
    expect(aggregator.calls).toEqual(["handleStreamDelta:msg-1"]);
  });

  test("stream-end routes to handleStreamEnd and clears token state", () => {
    const aggregator = new StubAggregator();

    const event: WorkspaceChatMessage = {
      type: "stream-end",
      workspaceId: "ws-1",
      messageId: "msg-1",
      metadata: { model: "test-model" },
      parts: [],
    };

    const hint = applyWorkspaceChatEventToAggregator(aggregator, event);

    expect(hint).toBe("immediate");
    expect(aggregator.calls).toEqual(["handleStreamEnd:msg-1", "clearTokenState:msg-1"]);
  });

  test("runtime-status routes to handleRuntimeStatus", () => {
    const aggregator = new StubAggregator();

    const event: WorkspaceChatMessage = {
      type: "runtime-status",
      workspaceId: "ws-1",
      phase: "starting",
      runtimeType: "ssh",
      detail: "Starting Coder workspace...",
    };

    const hint = applyWorkspaceChatEventToAggregator(aggregator, event);

    expect(hint).toBe("immediate");
    expect(aggregator.calls).toEqual(["handleRuntimeStatus:starting:ssh"]);
  });
  test("goal-budget-limited child events dispatch a toast without mutating messages", () => {
    withDispatchSpy((dispatched) => {
      const aggregator = new StubAggregator();
      const event: WorkspaceChatMessage = {
        type: "goal-budget-limited",
        workspaceId: "parent-1",
        goalId: "goal-1",
        causedByChild: true,
        childWorkspaceId: "child-1",
        message: "Child workspace exceeded the parent's goal budget.",
      };

      const hint = applyWorkspaceChatEventToAggregator(aggregator, event);

      expect(hint).toBe("ignored");
      expect(aggregator.calls).toEqual([]);
      expect(dispatched).toHaveLength(1);
      expect(dispatched[0]?.type).toBe(CUSTOM_EVENTS.GOAL_CHILD_BUDGET_TOAST);
      expect((dispatched[0] as CustomEvent).detail).toEqual({
        workspaceId: "parent-1",
        message: "Child workspace exceeded the parent's goal budget.",
      });
    });
  });

  test("stream-abort clears token state before calling handleStreamAbort", () => {
    const aggregator = new StubAggregator();

    const event: WorkspaceChatMessage = {
      type: "stream-abort",
      workspaceId: "ws-1",
      messageId: "msg-1",
      metadata: {},
    };

    const hint = applyWorkspaceChatEventToAggregator(aggregator, event);

    expect(hint).toBe("immediate");
    expect(aggregator.calls).toEqual(["clearTokenState:msg-1", "handleStreamAbort:msg-1"]);
  });

  test("stream-error clears token state after calling handleStreamError", () => {
    const aggregator = new StubAggregator();

    const event: WorkspaceChatMessage = {
      type: "stream-error",
      messageId: "msg-1",
      error: "boom",
      errorType: "network",
    };

    const hint = applyWorkspaceChatEventToAggregator(aggregator, event);

    expect(hint).toBe("immediate");
    // Without the clearTokenState call, the next stream's TPS/token-count
    // calculation could draw from the errored message's leaked deltaHistory.
    expect(aggregator.calls).toEqual(["handleStreamError:msg-1", "clearTokenState:msg-1"]);
  });

  test("tool-call-delta routes to handleToolCallDelta and is throttled", () => {
    const aggregator = new StubAggregator();

    const event: WorkspaceChatMessage = {
      type: "tool-call-delta",
      workspaceId: "ws-1",
      messageId: "msg-1",
      toolCallId: "tool-1",
      toolName: "bash",
      delta: { chunk: "..." },
      tokens: 1,
      timestamp: 1,
    };

    const hint = applyWorkspaceChatEventToAggregator(aggregator, event);

    expect(hint).toBe("throttled");
    expect(aggregator.calls).toEqual(["handleToolCallDelta:tool-1"]);
  });

  test("message routes to handleMessage", () => {
    const aggregator = new StubAggregator();

    const event: WorkspaceChatMessage = {
      type: "message",
      id: "msg-1",
      role: "user",
      parts: [{ type: "text", text: "hi" }],
      metadata: { historySequence: 1, timestamp: 0 },
    };

    const hint = applyWorkspaceChatEventToAggregator(aggregator, event);

    expect(hint).toBe("immediate");
    expect(aggregator.calls).toEqual(["handleMessage:message"]);
  });

  test("queued-message-changed is ignored", () => {
    const aggregator = new StubAggregator();

    const event: WorkspaceChatMessage = {
      type: "queued-message-changed",
      workspaceId: "ws-1",
      queuedMessages: ["a"],
      displayText: "queued",
    };

    const hint = applyWorkspaceChatEventToAggregator(aggregator, event);

    expect(hint).toBe("ignored");
    expect(aggregator.calls).toEqual([]);
  });

  test("unsupported event types are ignored (forward-compatible)", () => {
    const aggregator = new StubAggregator();

    const event: WorkspaceChatMessage = {
      type: "error",
      workspaceId: "ws-1",
      messageId: "msg-1",
      error: "boom",
      errorType: "unknown",
    };

    const hint = applyWorkspaceChatEventToAggregator(aggregator, event);

    expect(hint).toBe("ignored");
    expect(aggregator.calls).toEqual([]);
  });

  test("throws when aggregator is missing", () => {
    const event: WorkspaceChatMessage = {
      type: "caught-up",
    };

    expect(() =>
      applyWorkspaceChatEventToAggregator(null as unknown as WorkspaceChatEventAggregator, event)
    ).toThrow();
  });
});

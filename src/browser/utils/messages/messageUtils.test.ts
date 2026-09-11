import { describe, it, expect } from "@jest/globals";

import {
  shouldShowInterruptedBarrier,
  mergeConsecutiveStreamErrors,
  computeBashOutputGroupInfos,
  shouldBypassDeferredMessages,
  type BashOutputGroupInfo,
} from "./messageUtils";
import type { DisplayedMessage } from "@/common/types/message";

/** Test-only convenience wrapper: compute group info for a single index. */
function computeBashOutputGroupInfo(
  messages: DisplayedMessage[],
  index: number
): BashOutputGroupInfo | undefined {
  if (index < 0 || index >= messages.length) {
    return undefined;
  }
  return computeBashOutputGroupInfos(messages)[index];
}

describe("shouldShowInterruptedBarrier", () => {
  it("returns false for executing ask_user_question", () => {
    const msg: DisplayedMessage = {
      type: "tool",
      id: "tool-1",
      historyId: "assistant-1",
      toolName: "ask_user_question",
      toolCallId: "call-1",
      args: { questions: [] },
      status: "executing",
      isPartial: true,
      historySequence: 2,
      isLastPartOfMessage: true,
    };

    expect(shouldShowInterruptedBarrier(msg)).toBe(false);
  });

  it("returns false for decorative compaction boundary rows", () => {
    const msg: DisplayedMessage = {
      type: "compaction-boundary",
      id: "boundary-1",
      historySequence: 2,
      position: "start",
    };

    expect(shouldShowInterruptedBarrier(msg)).toBe(false);
  });

  it("returns true for interrupted tool (non ask_user_question)", () => {
    const msg: DisplayedMessage = {
      type: "tool",
      id: "tool-1",
      historyId: "assistant-1",
      toolName: "bash",
      toolCallId: "call-1",
      args: { script: "echo hi", timeout_secs: 1, display_name: "test" },
      status: "interrupted",
      isPartial: true,
      historySequence: 2,
      isLastPartOfMessage: true,
    };

    expect(shouldShowInterruptedBarrier(msg)).toBe(true);
  });

  it("suppresses interrupted barrier while transcript hydration is rebuilding state", () => {
    const msg: DisplayedMessage = {
      type: "tool",
      id: "tool-1",
      historyId: "assistant-1",
      toolName: "bash",
      toolCallId: "call-1",
      args: { script: "echo hi", timeout_secs: 1, display_name: "test" },
      status: "interrupted",
      isPartial: true,
      historySequence: 2,
      isLastPartOfMessage: true,
    };

    expect(shouldShowInterruptedBarrier(msg, { isHydratingTranscript: true })).toBe(false);
  });

  it("suppresses interrupted barrier while auto-retry is already underway", () => {
    const msg: DisplayedMessage = {
      type: "tool",
      id: "tool-1",
      historyId: "assistant-1",
      toolName: "bash",
      toolCallId: "call-1",
      args: { script: "echo hi", timeout_secs: 1, display_name: "test" },
      status: "interrupted",
      isPartial: true,
      historySequence: 2,
      isLastPartOfMessage: true,
    };

    expect(shouldShowInterruptedBarrier(msg, { isAutoRetryActive: true })).toBe(false);
  });
});
describe("shouldBypassDeferredMessages", () => {
  const executingBash: DisplayedMessage = {
    type: "tool",
    id: "t-executing",
    historyId: "h-tool",
    toolCallId: "call-1",
    toolName: "bash",
    args: { script: "echo hi", timeout_secs: 10, display_name: "test" },
    status: "executing",
    isPartial: false,
    historySequence: 1,
  };

  const completedBash: DisplayedMessage = {
    ...executingBash,
    id: "t-completed",
    status: "completed",
    result: { success: true, output: "hi", exitCode: 0, wall_duration_ms: 5 },
  };

  const runningInit: DisplayedMessage = {
    type: "workspace-init",
    id: "workspace-init",
    historySequence: -1,
    status: "running",
    hookPath: "/tmp/project/.mux/init",
    lines: [{ line: "Installing dependencies...", isError: false }],
    progress: null,
    exitCode: null,
    timestamp: 1,
    durationMs: null,
  };

  const completedInit: DisplayedMessage = {
    ...runningInit,
    status: "success",
    exitCode: 0,
    durationMs: 2_000,
  };

  it("returns true when immediate snapshot has active rows", () => {
    expect(shouldBypassDeferredMessages([executingBash], [executingBash])).toBe(true);
  });

  it("returns true when deferred snapshot is stale and still executing", () => {
    // Regression scenario: immediate list is completed, but deferred list still has
    // stale executing tool state from the previous render.
    expect(shouldBypassDeferredMessages([completedBash], [executingBash])).toBe(true);
  });

  it("returns true when deferred length is out of sync", () => {
    expect(shouldBypassDeferredMessages([completedBash], [])).toBe(true);
  });

  it("returns true when snapshots have same length but different row identity/order", () => {
    const userRow: DisplayedMessage = {
      type: "user",
      id: "u-1",
      historyId: "h-user",
      content: "hello",
      historySequence: 0,
    };

    expect(shouldBypassDeferredMessages([completedBash, userRow], [userRow, completedBash])).toBe(
      true
    );
  });

  it("returns true when the deferred snapshot still belongs to the previous workspace", () => {
    expect(
      shouldBypassDeferredMessages([completedBash], [completedBash], {
        immediateWorkspaceId: "workspace-b",
        deferredWorkspaceId: "workspace-a",
      })
    ).toBe(true);
  });

  it("returns true when init output is still running", () => {
    expect(shouldBypassDeferredMessages([runningInit], [runningInit])).toBe(true);
  });

  it("returns true when the deferred snapshot still shows a running init hook", () => {
    // Regression scenario: reconnect replay completed the init hook, but the deferred
    // snapshot is still holding on to the older running row from before catch-up.
    expect(shouldBypassDeferredMessages([completedInit], [runningInit])).toBe(true);
  });

  it("returns false when both snapshots are settled and in sync", () => {
    expect(shouldBypassDeferredMessages([completedBash], [completedBash])).toBe(false);
  });
});

describe("mergeConsecutiveStreamErrors", () => {
  it("returns empty array for empty input", () => {
    const result = mergeConsecutiveStreamErrors([]);
    expect(result).toEqual([]);
  });

  it("leaves non-error messages unchanged", () => {
    const messages: DisplayedMessage[] = [
      {
        type: "user",
        id: "1",
        historyId: "h1",
        content: "test",
        historySequence: 1,
      },
      {
        type: "assistant",
        id: "2",
        historyId: "h2",
        content: "response",
        historySequence: 2,
        isStreaming: false,
        isPartial: false,
        isCompacted: false,
        isIdleCompacted: false,
      },
    ];

    const result = mergeConsecutiveStreamErrors(messages);
    expect(result).toEqual(messages);
  });

  it("merges consecutive identical stream errors", () => {
    const messages: DisplayedMessage[] = [
      {
        type: "stream-error",
        id: "e1",
        historyId: "h1",
        error: "Connection timeout",
        errorType: "network",
        historySequence: 1,
      },
      {
        type: "stream-error",
        id: "e2",
        historyId: "h2",
        error: "Connection timeout",
        errorType: "network",
        historySequence: 2,
      },
      {
        type: "stream-error",
        id: "e3",
        historyId: "h3",
        error: "Connection timeout",
        errorType: "network",
        historySequence: 3,
      },
    ];

    const result = mergeConsecutiveStreamErrors(messages);

    expect(result).toHaveLength(1);
    expect(result[0]).toMatchObject({
      type: "stream-error",
      error: "Connection timeout",
      errorType: "network",
      errorCount: 3,
    });
  });

  it("does not merge errors with different content", () => {
    const messages: DisplayedMessage[] = [
      {
        type: "stream-error",
        id: "e1",
        historyId: "h1",
        error: "Connection timeout",
        errorType: "network",
        historySequence: 1,
      },
      {
        type: "stream-error",
        id: "e2",
        historyId: "h2",
        error: "Rate limit exceeded",
        errorType: "rate_limit",
        historySequence: 2,
      },
    ];

    const result = mergeConsecutiveStreamErrors(messages);

    expect(result).toHaveLength(2);
    expect(result[0]).toMatchObject({
      error: "Connection timeout",
      errorCount: 1,
    });
    expect(result[1]).toMatchObject({
      error: "Rate limit exceeded",
      errorCount: 1,
    });
  });

  it("does not merge errors with different error types", () => {
    const messages: DisplayedMessage[] = [
      {
        type: "stream-error",
        id: "e1",
        historyId: "h1",
        error: "Error occurred",
        errorType: "network",
        historySequence: 1,
      },
      {
        type: "stream-error",
        id: "e2",
        historyId: "h2",
        error: "Error occurred",
        errorType: "rate_limit",
        historySequence: 2,
      },
    ];

    const result = mergeConsecutiveStreamErrors(messages);

    expect(result).toHaveLength(2);
    const first = result[0];
    const second = result[1];
    expect(first.type).toBe("stream-error");
    expect(second.type).toBe("stream-error");
    if (first.type === "stream-error" && second.type === "stream-error") {
      expect(first.errorCount).toBe(1);
      expect(second.errorCount).toBe(1);
    }
  });

  it("creates separate merged groups for non-consecutive identical errors", () => {
    const messages: DisplayedMessage[] = [
      {
        type: "stream-error",
        id: "e1",
        historyId: "h1",
        error: "Connection timeout",
        errorType: "network",
        historySequence: 1,
      },
      {
        type: "stream-error",
        id: "e2",
        historyId: "h2",
        error: "Connection timeout",
        errorType: "network",
        historySequence: 2,
      },
      {
        type: "user",
        id: "u1",
        historyId: "hu1",
        content: "retry",
        historySequence: 3,
      },
      {
        type: "stream-error",
        id: "e3",
        historyId: "h3",
        error: "Connection timeout",
        errorType: "network",
        historySequence: 4,
      },
    ];

    const result = mergeConsecutiveStreamErrors(messages);

    expect(result).toHaveLength(3);
    expect(result[0]).toMatchObject({
      type: "stream-error",
      errorCount: 2,
    });
    expect(result[1]).toMatchObject({
      type: "user",
    });
    expect(result[2]).toMatchObject({
      type: "stream-error",
      errorCount: 1,
    });
  });

  it("handles mixed messages with error sequences", () => {
    const messages: DisplayedMessage[] = [
      {
        type: "user",
        id: "u1",
        historyId: "hu1",
        content: "test",
        historySequence: 1,
      },
      {
        type: "stream-error",
        id: "e1",
        historyId: "h1",
        error: "Error A",
        errorType: "network",
        historySequence: 2,
      },
      {
        type: "stream-error",
        id: "e2",
        historyId: "h2",
        error: "Error A",
        errorType: "network",
        historySequence: 3,
      },
      {
        type: "assistant",
        id: "a1",
        historyId: "ha1",
        content: "response",
        historySequence: 4,
        isStreaming: false,
        isPartial: false,
        isCompacted: false,
        isIdleCompacted: false,
      },
      {
        type: "stream-error",
        id: "e3",
        historyId: "h3",
        error: "Error B",
        errorType: "rate_limit",
        historySequence: 5,
      },
    ];

    const result = mergeConsecutiveStreamErrors(messages);

    expect(result).toHaveLength(4);
    expect(result[0].type).toBe("user");
    expect(result[1]).toMatchObject({
      type: "stream-error",
      error: "Error A",
      errorCount: 2,
    });
    expect(result[2].type).toBe("assistant");
    expect(result[3]).toMatchObject({
      type: "stream-error",
      error: "Error B",
      errorCount: 1,
    });
  });

  it("preserves other message properties when merging", () => {
    const messages: DisplayedMessage[] = [
      {
        type: "stream-error",
        id: "e1",
        historyId: "h1",
        error: "Test error",
        errorType: "network",
        historySequence: 1,
        timestamp: 1234567890,
        model: "test-model",
      },
      {
        type: "stream-error",
        id: "e2",
        historyId: "h2",
        error: "Test error",
        errorType: "network",
        historySequence: 2,
      },
    ];

    const result = mergeConsecutiveStreamErrors(messages);

    expect(result).toHaveLength(1);
    expect(result[0]).toMatchObject({
      id: "e1",
      historyId: "h1",
      error: "Test error",
      errorType: "network",
      historySequence: 1,
      timestamp: 1234567890,
      model: "test-model",
      errorCount: 2,
    });
  });
});

describe("computeBashOutputGroupInfo", () => {
  // Helper to create a bash_output tool message
  function createBashOutputMessage(
    id: string,
    processId: string,
    historySequence: number
  ): DisplayedMessage {
    return {
      type: "tool",
      id,
      historyId: `h-${id}`,
      toolCallId: `tc-${id}`,
      toolName: "bash_output",
      args: { process_id: processId, timeout_secs: 0 },
      result: { success: true, status: "running", output: `output-${id}` },
      status: "completed",
      isPartial: false,
      historySequence,
    };
  }

  it("returns undefined for non-bash_output messages", () => {
    const messages: DisplayedMessage[] = [
      {
        type: "user",
        id: "1",
        historyId: "h1",
        content: "test",
        historySequence: 1,
      },
      {
        type: "tool",
        id: "2",
        historyId: "h2",
        toolCallId: "tc2",
        toolName: "file_read",
        args: { filePath: "/test" },
        status: "completed",
        isPartial: false,
        historySequence: 2,
      },
    ];

    expect(computeBashOutputGroupInfo(messages, 0)).toBeUndefined();
    expect(computeBashOutputGroupInfo(messages, 1)).toBeUndefined();
  });

  it("returns undefined for 1-2 consecutive bash_output calls", () => {
    const messages: DisplayedMessage[] = [
      createBashOutputMessage("1", "bash_1", 1),
      createBashOutputMessage("2", "bash_1", 2),
    ];

    // Groups of 1-2 don't need grouping
    expect(computeBashOutputGroupInfo(messages, 0)).toBeUndefined();
    expect(computeBashOutputGroupInfo(messages, 1)).toBeUndefined();
  });

  it("returns correct group info for 3+ consecutive bash_output calls", () => {
    const messages: DisplayedMessage[] = [
      createBashOutputMessage("1", "bash_1", 1),
      createBashOutputMessage("2", "bash_1", 2),
      createBashOutputMessage("3", "bash_1", 3),
      createBashOutputMessage("4", "bash_1", 4),
    ];

    // First position
    expect(computeBashOutputGroupInfo(messages, 0)).toMatchObject({
      position: "first",
      totalCount: 4,
      collapsedCount: 2,
      processId: "bash_1",
    });

    // Middle positions
    expect(computeBashOutputGroupInfo(messages, 1)).toMatchObject({
      position: "middle",
      totalCount: 4,
      collapsedCount: 2,
      processId: "bash_1",
    });
    expect(computeBashOutputGroupInfo(messages, 2)).toMatchObject({
      position: "middle",
      totalCount: 4,
      collapsedCount: 2,
      processId: "bash_1",
    });

    // Last position
    expect(computeBashOutputGroupInfo(messages, 3)).toMatchObject({
      position: "last",
      totalCount: 4,
      collapsedCount: 2,
      processId: "bash_1",
    });
  });

  it("does not group bash_output calls to different processes", () => {
    const messages: DisplayedMessage[] = [
      createBashOutputMessage("1", "bash_1", 1),
      createBashOutputMessage("2", "bash_1", 2),
      createBashOutputMessage("3", "bash_2", 3), // Different process
      createBashOutputMessage("4", "bash_1", 4),
    ];

    // No grouping should occur (max consecutive same-process is 2)
    expect(computeBashOutputGroupInfo(messages, 0)).toBeUndefined();
    expect(computeBashOutputGroupInfo(messages, 1)).toBeUndefined();
    expect(computeBashOutputGroupInfo(messages, 2)).toBeUndefined();
    expect(computeBashOutputGroupInfo(messages, 3)).toBeUndefined();
  });

  it("handles multiple separate groups", () => {
    const messages: DisplayedMessage[] = [
      createBashOutputMessage("1", "bash_1", 1),
      createBashOutputMessage("2", "bash_1", 2),
      createBashOutputMessage("3", "bash_1", 3),
      {
        type: "user",
        id: "u1",
        historyId: "hu1",
        content: "check other",
        historySequence: 4,
      },
      createBashOutputMessage("4", "bash_2", 5),
      createBashOutputMessage("5", "bash_2", 6),
      createBashOutputMessage("6", "bash_2", 7),
    ];

    // First group
    expect(computeBashOutputGroupInfo(messages, 0)?.position).toBe("first");
    expect(computeBashOutputGroupInfo(messages, 1)?.position).toBe("middle");
    expect(computeBashOutputGroupInfo(messages, 2)?.position).toBe("last");

    // User message (not grouped)
    expect(computeBashOutputGroupInfo(messages, 3)).toBeUndefined();

    // Second group
    expect(computeBashOutputGroupInfo(messages, 4)?.position).toBe("first");
    expect(computeBashOutputGroupInfo(messages, 4)?.processId).toBe("bash_2");
    expect(computeBashOutputGroupInfo(messages, 5)?.position).toBe("middle");
    expect(computeBashOutputGroupInfo(messages, 6)?.position).toBe("last");
  });

  it("handles exactly 3 consecutive calls (minimum for grouping)", () => {
    const messages: DisplayedMessage[] = [
      createBashOutputMessage("1", "bash_1", 1),
      createBashOutputMessage("2", "bash_1", 2),
      createBashOutputMessage("3", "bash_1", 3),
    ];

    expect(computeBashOutputGroupInfo(messages, 0)).toMatchObject({
      position: "first",
      collapsedCount: 1,
    });
    expect(computeBashOutputGroupInfo(messages, 1)).toMatchObject({
      position: "middle",
      collapsedCount: 1,
    });
    expect(computeBashOutputGroupInfo(messages, 2)).toMatchObject({
      position: "last",
      collapsedCount: 1,
    });
  });

  it("correctly identifies process_id in group info", () => {
    const messages: DisplayedMessage[] = [
      createBashOutputMessage("1", "my-special-process", 1),
      createBashOutputMessage("2", "my-special-process", 2),
      createBashOutputMessage("3", "my-special-process", 3),
    ];

    const groupInfo = computeBashOutputGroupInfo(messages, 0);
    expect(groupInfo?.processId).toBe("my-special-process");
  });

  it("includes firstIndex for all positions in group", () => {
    const messages: DisplayedMessage[] = [
      createBashOutputMessage("1", "proc", 1),
      createBashOutputMessage("2", "proc", 2),
      createBashOutputMessage("3", "proc", 3),
      createBashOutputMessage("4", "proc", 4),
    ];

    // All positions should report firstIndex as 0
    expect(computeBashOutputGroupInfo(messages, 0)?.firstIndex).toBe(0); // first
    expect(computeBashOutputGroupInfo(messages, 1)?.firstIndex).toBe(0); // middle
    expect(computeBashOutputGroupInfo(messages, 2)?.firstIndex).toBe(0); // middle
    expect(computeBashOutputGroupInfo(messages, 3)?.firstIndex).toBe(0); // last
  });

  it("precomputes per-index group info in one pass", () => {
    const messages: DisplayedMessage[] = [
      createBashOutputMessage("1", "bash_1", 1),
      createBashOutputMessage("2", "bash_1", 2),
      createBashOutputMessage("3", "bash_1", 3),
      {
        type: "user",
        id: "u1",
        historyId: "hu1",
        content: "between groups",
        historySequence: 4,
      },
      createBashOutputMessage("4", "bash_2", 5),
      createBashOutputMessage("5", "bash_2", 6),
      createBashOutputMessage("6", "bash_2", 7),
      createBashOutputMessage("7", "bash_2", 8),
    ];

    const precomputed = computeBashOutputGroupInfos(messages);
    expect(precomputed).toHaveLength(messages.length);

    for (let index = 0; index < messages.length; index++) {
      expect(precomputed[index]).toEqual(computeBashOutputGroupInfo(messages, index));
    }
  });
});

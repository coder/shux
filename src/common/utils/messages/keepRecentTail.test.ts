import { describe, expect, it } from "bun:test";

import { createMuxMessage, type MuxMessage, type MuxMessageMetadata } from "@/common/types/message";

import {
  estimateMuxMessageTokens,
  excludeKeepRecentTailForCompactionRequest,
  getKeepRecentTailStartHistorySequence,
  selectKeepRecentTailStartIndex,
} from "./keepRecentTail";

function userMessage(id: string, text: string, historySequence: number): MuxMessage {
  return createMuxMessage(id, "user", text, { historySequence, timestamp: 1 });
}

function assistantMessage(id: string, text: string, historySequence: number): MuxMessage {
  return createMuxMessage(id, "assistant", text, { historySequence, timestamp: 1 });
}

function compactionRequestMetadata(startHistorySequence?: number): MuxMessageMetadata {
  const metadata: MuxMessageMetadata = {
    type: "compaction-request",
    rawCommand: "/compact",
    parsed: {},
    ...(startHistorySequence !== undefined ? { keepRecentTail: { startHistorySequence } } : {}),
  };
  return metadata;
}

describe("estimateMuxMessageTokens", () => {
  it("grows with message content size", () => {
    const small = estimateMuxMessageTokens(createMuxMessage("s", "user", "hi"));
    const large = estimateMuxMessageTokens(createMuxMessage("l", "user", "x".repeat(4_000)));
    expect(small).toBeGreaterThan(0);
    expect(large).toBeGreaterThan(small + 500);
  });
});

describe("selectKeepRecentTailStartIndex", () => {
  it("selects the oldest user turn whose suffix fits under the floor", () => {
    const big = "x".repeat(40_000); // ~10k tokens
    const messages = [
      userMessage("u0", big, 0),
      assistantMessage("a0", big, 1),
      userMessage("u1", "small question", 2),
      assistantMessage("a1", "small answer", 3),
      userMessage("u2", "another question", 4),
      assistantMessage("a2", "another answer", 5),
    ];

    // Floor of 1k tokens fits both trailing small turns but not the big head.
    expect(selectKeepRecentTailStartIndex(messages, 1_000)).toBe(2);
  });

  it("never starts a tail mid-turn (only user rows are safe boundaries)", () => {
    const messages = [
      userMessage("u0", "x".repeat(4_000), 0),
      assistantMessage("a0", "x".repeat(4_000), 1),
      userMessage("u1", "x".repeat(4_000), 2),
      assistantMessage("a1", "tail-sized answer", 3),
    ];

    // Floor covers only the trailing assistant row; its user turn does not
    // fit, so no safe boundary exists and the tail is clamped away.
    expect(selectKeepRecentTailStartIndex(messages, 100)).toBe(-1);
  });

  it("clamps the tail away when even the newest turn exceeds the floor", () => {
    const messages = [
      userMessage("u0", "start", 0),
      assistantMessage("a0", "reply", 1),
      userMessage("u1", "question", 2),
      assistantMessage("a1", "x".repeat(400_000), 3),
    ];

    expect(selectKeepRecentTailStartIndex(messages, 20_000)).toBe(-1);
  });

  it("skips synthetic user rows as tail starts", () => {
    const synthetic = createMuxMessage("cont", "user", "[CONTINUE]", {
      historySequence: 2,
      synthetic: true,
    });
    const messages = [
      userMessage("u0", "start", 0),
      assistantMessage("a0", "reply", 1),
      synthetic,
      assistantMessage("a1", "reply 2", 3),
    ];

    expect(selectKeepRecentTailStartIndex(messages, 20_000)).toBe(-1);
  });

  it("skips user rows without a valid historySequence", () => {
    const noSeq = createMuxMessage("u1", "user", "question", { timestamp: 1 });
    const messages = [
      userMessage("u0", "start", 0),
      assistantMessage("a0", "reply", 1),
      noSeq,
      assistantMessage("a1", "answer", 3),
    ];

    expect(selectKeepRecentTailStartIndex(messages, 20_000)).toBe(-1);
  });

  it("extends the boundary backward over the turn's snapshot cluster", () => {
    // @file / skill / MCP snapshots are synthetic user rows persisted
    // immediately before the real user row they expand; stranding them in the
    // summarized head would give the provider the request without its content.
    const snapshot = createMuxMessage("snap-1", "user", "snapshot: file contents", {
      historySequence: 2,
      synthetic: true,
      fileAtMentionSnapshot: ["src/foo.ts"],
    });
    const messages = [
      userMessage("u0", "x".repeat(40_000), 0),
      assistantMessage("a0", "big reply", 1),
      snapshot,
      userMessage("u1", "@src/foo.ts what does this do?", 3),
      assistantMessage("a1", "it does things", 4),
    ];

    // The safe boundary is u1 (index 3), but the tail must start at the
    // snapshot row (index 2) so the kept turn retains its content.
    expect(selectKeepRecentTailStartIndex(messages, 1_000)).toBe(2);
  });

  it("counts the snapshot cluster against the floor", () => {
    const bigSnapshot = createMuxMessage("snap-1", "user", "x".repeat(40_000), {
      historySequence: 2,
      synthetic: true,
      fileAtMentionSnapshot: ["src/big.ts"],
    });
    const messages = [
      userMessage("u0", "start", 0),
      assistantMessage("a0", "reply", 1),
      bigSnapshot,
      userMessage("u1", "@src/big.ts summarize", 3),
      assistantMessage("a1", "summary", 4),
    ];

    // The user turn alone fits under the floor, but WITH its ~10k-token
    // snapshot it does not: a tail that would strand the snapshot is refused.
    expect(selectKeepRecentTailStartIndex(messages, 1_000)).toBe(-1);
  });

  it("rejects a candidate whose snapshot cluster reaches index 0 (empty head)", () => {
    // A snapshot at messages[0] belongs to the first turn's cluster; the
    // cluster scan must inspect index 0 so the empty-head check rejects the
    // candidate — otherwise the tail starts at the real user row and the
    // snapshot content the preserved turn depends on is summarized away.
    const snapshot = createMuxMessage("snap-0", "user", "snapshot: file contents", {
      historySequence: 0,
      synthetic: true,
      fileAtMentionSnapshot: ["src/foo.ts"],
    });
    const messages = [
      snapshot,
      userMessage("u0", "@src/foo.ts what does this do?", 1),
      assistantMessage("a0", "it does things", 2),
      userMessage("u1", "and this?", 3),
      assistantMessage("a1", "more things", 4),
    ];

    // With a floor covering everything, the first-turn candidate (u0) must be
    // rejected (its cluster consumes the whole head); the later turn (u1,
    // index 3) is the correct boundary.
    expect(selectKeepRecentTailStartIndex(messages, 20_000)).toBe(3);
  });

  it("requires a provider-eligible head so the summarizer has content", () => {
    const boundary = createMuxMessage("summary-1", "assistant", "prior summary", {
      compacted: "user",
      compactionBoundary: true,
      compactionEpoch: 1,
      historySequence: 0,
    });
    const messages = [
      boundary,
      userMessage("u1", "question", 1),
      assistantMessage("a1", "answer", 2),
    ];

    // The prior summary is provider-eligible, so the tail can start right
    // after it.
    expect(selectKeepRecentTailStartIndex(messages, 20_000)).toBe(1);
  });

  it("token estimate of the selected tail respects the floor", () => {
    const messages: MuxMessage[] = [];
    for (let turn = 0; turn < 10; turn++) {
      messages.push(userMessage(`u${turn}`, "q".repeat(2_000), turn * 2));
      messages.push(assistantMessage(`a${turn}`, "a".repeat(2_000), turn * 2 + 1));
    }

    const floor = 5_000;
    const startIndex = selectKeepRecentTailStartIndex(messages, floor);
    expect(startIndex).toBeGreaterThan(0);

    const tailTokens = messages
      .slice(startIndex)
      .reduce((sum, message) => sum + estimateMuxMessageTokens(message), 0);
    expect(tailTokens).toBeLessThanOrEqual(floor);

    // Maximality: including one more turn would blow the floor.
    const widerTokens = messages
      .slice(startIndex - 2)
      .reduce((sum, message) => sum + estimateMuxMessageTokens(message), 0);
    expect(widerTokens).toBeGreaterThan(floor);
  });
});

describe("getKeepRecentTailStartHistorySequence", () => {
  it("returns the stamped sequence for compaction requests", () => {
    expect(getKeepRecentTailStartHistorySequence(compactionRequestMetadata(7))).toBe(7);
  });

  it("returns undefined for unstamped or malformed metadata", () => {
    expect(getKeepRecentTailStartHistorySequence(undefined)).toBeUndefined();
    expect(getKeepRecentTailStartHistorySequence(compactionRequestMetadata())).toBeUndefined();
    expect(getKeepRecentTailStartHistorySequence(compactionRequestMetadata(-1))).toBeUndefined();
    expect(getKeepRecentTailStartHistorySequence({ type: "normal" })).toBeUndefined();
  });
});

describe("excludeKeepRecentTailForCompactionRequest", () => {
  it("returns the same reference when the request is unstamped (RLM off)", () => {
    const messages = [
      userMessage("u0", "start", 0),
      assistantMessage("a0", "reply", 1),
      createMuxMessage("req", "user", "/compact", {
        historySequence: 2,
        muxMetadata: compactionRequestMetadata(),
      }),
    ];

    expect(excludeKeepRecentTailForCompactionRequest(messages)).toBe(messages);
  });

  it("drops stamped tail rows before the request but keeps later rows", () => {
    const request = createMuxMessage("req", "user", "/compact", {
      historySequence: 4,
      muxMetadata: compactionRequestMetadata(2),
    });
    const streamedSummary = assistantMessage("summary", "streamed summary", 5);
    const messages = [
      userMessage("u0", "head", 0),
      assistantMessage("a0", "head reply", 1),
      userMessage("u1", "tail turn", 2),
      assistantMessage("a1", "tail reply", 3),
      request,
      streamedSummary,
    ];

    const filtered = excludeKeepRecentTailForCompactionRequest(messages);
    expect(filtered.map((message) => message.id)).toEqual(["u0", "a0", "req", "summary"]);
  });

  it("keeps rows without a valid historySequence (self-healing)", () => {
    const noSeq = createMuxMessage("no-seq", "assistant", "no sequence", { timestamp: 1 });
    const messages = [
      userMessage("u0", "head", 0),
      noSeq,
      userMessage("u1", "tail", 2),
      createMuxMessage("req", "user", "/compact", {
        historySequence: 3,
        muxMetadata: compactionRequestMetadata(2),
      }),
    ];

    const filtered = excludeKeepRecentTailForCompactionRequest(messages);
    expect(filtered.map((message) => message.id)).toEqual(["u0", "no-seq", "req"]);
  });

  it("ignores non-compaction last user rows", () => {
    const messages = [
      userMessage("u0", "head", 0),
      assistantMessage("a0", "reply", 1),
      userMessage("u1", "normal question", 2),
    ];

    expect(excludeKeepRecentTailForCompactionRequest(messages)).toBe(messages);
  });
});

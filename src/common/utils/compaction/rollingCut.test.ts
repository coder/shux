import { describe, expect, test } from "bun:test";
import { createMuxMessage, type MuxMessage } from "@/common/types/message";
import { estimateMuxMessageTokens } from "@/common/utils/messages/keepRecentTail";
import { selectRollingCut, type RollingCutBudget } from "./rollingCut";

const budget: RollingCutBudget = {
  contextWindowTokens: 50_000,
  summaryTokens: 1_000,
  attachmentTokens: 500,
  forceThresholdTokens: 37_500,
};

function message(id: string, role: "user" | "assistant", chars: number): MuxMessage {
  return createMuxMessage(id, role, "x".repeat(chars));
}

function oldHead(): MuxMessage[] {
  return [message("old-user", "user", 100), message("old-answer", "assistant", 40_000)];
}

function steppedAnswer(charsPerStep: number, starts: number[] | undefined = [0, 1, 2]): MuxMessage {
  return {
    id: "steps",
    role: "assistant",
    metadata: { stepStartPartIndices: starts },
    parts: Array.from({ length: 3 }, (_, i) => ({
      type: "dynamic-tool",
      toolCallId: `call-${i}`,
      toolName: "bash",
      state: "output-available",
      input: { script: "pwd" },
      output: "x".repeat(charsPerStep),
    })),
  };
}

function snapshot(id: string, chars = 100): MuxMessage {
  return {
    ...message(id, "user", chars),
    metadata: {
      synthetic: true,
      fileAtMentionSnapshot: ["file.ts"],
    },
  };
}

function tokens(rows: MuxMessage[]): number {
  return rows.reduce((sum, row) => sum + estimateMuxMessageTokens(row), 0);
}

describe("selectRollingCut", () => {
  test("keeps the largest whole-turn suffix and its preceding snapshots", () => {
    const rows = [
      ...oldHead(),
      snapshot("file"),
      snapshot("skill"),
      message("recent-user", "user", 100),
      message("recent-answer", "assistant", 16_000),
      message("last-user", "user", 100),
      message("last-answer", "assistant", 16_000),
    ];
    const cut = selectRollingCut(rows, null, budget);
    expect(cut?.head).toEqual(rows.slice(0, 2));
    expect(cut?.tail).toEqual(rows.slice(2));
    expect(cut?.headTokens).toBe(tokens(cut!.head));
    expect(cut?.tailTokens).toBe(tokens(cut!.tail));
    expect(cut?.stepCut).toBeUndefined();
  });

  test("counts snapshots against the cap instead of separating them from their user", () => {
    const rows = [
      ...oldHead(),
      snapshot("large-file", 40_000),
      message("user", "user", 10),
      message("answer", "assistant", 100),
    ];
    expect(selectRollingCut(rows, null, budget)?.tail).toEqual([]);
  });

  test("splits consecutive tool-only steps only at recorded boundaries and duplicates the user cluster", () => {
    const answer = steppedAnswer(18_000);
    const rows = [...oldHead(), snapshot("file"), message("user", "user", 100), answer];
    const before = structuredClone(rows);
    const cut = selectRollingCut(rows, null, budget);
    expect(cut?.stepCut).toEqual({
      messageId: "steps",
      partIndex: 1,
      firstTailToolCallId: "call-1",
    });
    expect(cut?.head.at(-1)?.parts).toEqual(answer.parts.slice(0, 1));
    expect(cut?.tail.slice(0, 2)).toEqual(rows.slice(2, 4));
    expect(cut?.tail.at(-1)?.parts).toEqual(answer.parts.slice(1));
    expect(cut?.tail.at(-1)?.metadata?.stepStartPartIndices).toEqual([0, 1]);
    expect(cut?.headTokens).toBe(tokens(cut!.head));
    expect(cut?.tailTokens).toBe(tokens(cut!.tail));
    expect(rows).toEqual(before);
  });

  test("keeps reasoning and all tools within a recorded step together", () => {
    const answer = steppedAnswer(20_000, [0, 2]);
    answer.parts.splice(1, 0, { type: "reasoning", text: "reason", signature: "signed" });
    answer.metadata = { stepStartPartIndices: [0, 3] };
    const cut = selectRollingCut([...oldHead(), message("user", "user", 10), answer], null, budget);
    expect(cut?.stepCut?.partIndex).toBe(3);
    expect(cut?.head.at(-1)?.parts).toEqual(answer.parts.slice(0, 3));
    expect(cut?.tail.at(-1)?.parts).toEqual(answer.parts.slice(3));
  });

  test.each(
    [undefined, [], [1, 2], [0, 2, 1], [0, 1, 1], [0, 4], [0, 1.5]].map((starts) => ({ starts }))
  )("does not infer boundaries from legacy or malformed metadata $starts", ({ starts }) => {
    const answer = steppedAnswer(18_000);
    answer.metadata = { stepStartPartIndices: starts };
    const rows = [...oldHead(), message("user", "user", 100), answer];
    expect(selectRollingCut(rows, null, budget)?.tail).toEqual([]);
  });

  test("uses live indices rather than stale committed metadata, ignoring the terminal sentinel", () => {
    const answer = steppedAnswer(18_000, [0]);
    const cut = selectRollingCut(
      [...oldHead(), message("user", "user", 100), answer],
      { messageId: answer.id, stepStartIndices: [0, 1, 2, 3] },
      budget
    );
    expect(cut?.stepCut?.partIndex).toBe(1);
    expect(cut?.tail.at(-1)?.metadata?.stepStartPartIndices).toEqual([0, 1]);
  });

  test("retains only the mandatory last completed step mid-stream when every suffix exceeds the cap", () => {
    const answer = steppedAnswer(44_000);
    const rows = [...oldHead(), snapshot("file"), message("user", "user", 100), answer];
    const cut = selectRollingCut(
      rows,
      { messageId: answer.id, stepStartIndices: [0, 1, 2] },
      budget
    );
    expect(cut?.stepCut?.partIndex).toBe(2);
    expect(cut?.tail.slice(0, 2)).toEqual(rows.slice(2, 4));
    expect(cut?.tail.at(-1)?.parts).toEqual(answer.parts.slice(2));
    expect(cut?.tailTokens).toBeGreaterThan(10_000);
    expect(selectRollingCut(rows, null, budget)?.tail).toEqual([]);
  });

  test("rejects an oversized mandatory tail at the force threshold including summary and attachments", () => {
    const answer = steppedAnswer(44_000);
    const rows = [...oldHead(), message("user", "user", 100), answer];
    const inFlight = { messageId: answer.id, stepStartIndices: [0, 1, 2] };
    const cut = selectRollingCut(rows, inFlight, budget)!;
    const forceThresholdTokens = cut.tailTokens + budget.summaryTokens + budget.attachmentTokens;
    expect(selectRollingCut(rows, inFlight, { ...budget, forceThresholdTokens })).toBeNull();
    expect(
      selectRollingCut(rows, inFlight, {
        ...budget,
        forceThresholdTokens: forceThresholdTokens + 1,
      })
    ).not.toBeNull();
  });

  test("waits when the live snapshot has no completed step", () => {
    const rows = [...oldHead(), message("user", "user", 100), message("live", "assistant", 0)];
    rows.at(-1)!.parts = [];
    expect(selectRollingCut(rows, { messageId: "live", stepStartIndices: [0] }, budget)).toBeNull();
  });

  test.each([
    { window: 10_000, recentChars: 12_000 },
    { window: 1_000_000, recentChars: 200_000 },
  ])("clamps the tail budget for a $window-token window", ({ window, recentChars }) => {
    const rows = [
      ...oldHead(),
      message("earlier-user", "user", 100),
      message("earlier-answer", "assistant", recentChars),
      message("last-user", "user", 100),
      message("last-answer", "assistant", recentChars),
    ];
    const cut = selectRollingCut(rows, null, { ...budget, contextWindowTokens: window });
    expect(cut?.tail).toEqual(rows.slice(-2));
  });

  test("requires a meaningful head even when the whole history could fit in the tail", () => {
    expect(selectRollingCut([], null, budget)).toBeNull();
    expect(selectRollingCut([message("small", "user", 100)], null, budget)).toBeNull();
    const rows = [message("head", "user", 4_000), message("tail", "user", 100)];
    expect(selectRollingCut(rows, null, { ...budget, contextWindowTokens: 10_000 })?.tail).toEqual(
      rows.slice(1)
    );
    expect(selectRollingCut(rows, null, budget)).toBeNull();
  });
});

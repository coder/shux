import { describe, expect, it } from "bun:test";

import { createMuxMessage } from "@/common/types/message";

import {
  compactionClosingPolicyEpoch,
  duplicateUserMessageIds,
  epochHasPriorTurnRows,
  findLatestCompactionBoundaryIndex,
  findLatestContextBoundaryIndex,
  hasProviderEligibleMessages,
  sliceMessagesForProviderFromLatestContextBoundary,
  sliceMessagesFromLatestCompactionBoundary,
  workspaceMemoryPolicyEpochOf,
} from "./compactionBoundary";

describe("workspaceMemoryPolicyEpochOf", () => {
  const boundary = (id: string, historySequence: number) =>
    createMuxMessage(id, "assistant", "summary", {
      compacted: "user",
      compactionBoundary: true,
      compactionEpoch: 1,
      historySequence,
    });

  it("is -1 before any boundary for legacy and first-segment rows", () => {
    expect(workspaceMemoryPolicyEpochOf([])).toBe(-1);
    expect(
      workspaceMemoryPolicyEpochOf([
        createMuxMessage("u1", "user", "a", { historySequence: 0 }),
        createMuxMessage("u2", "user", "b", { historySequence: 1, historySegment: 0 }),
      ])
    ).toBe(-1);
  });

  it("derives a segment-unique boundary-less identity from the segment stamp", () => {
    // Rows of a later segment (after a full clear) never share the cleared
    // segment's -1; any subset of the segment yields the same identity.
    const rows = [
      createMuxMessage("u1", "user", "a", { historySequence: 7, historySegment: 7 }),
      createMuxMessage("a1", "assistant", "b", { historySequence: 8, historySegment: 7 }),
    ];
    expect(workspaceMemoryPolicyEpochOf(rows)).toBe(-8);
    expect(workspaceMemoryPolicyEpochOf(rows.slice(1))).toBe(-8);
    // A row that lost its stamp (rewritten in place by an older build)
    // cannot pull the segment back to the legacy identity.
    expect(
      workspaceMemoryPolicyEpochOf([
        ...rows,
        createMuxMessage("a2", "assistant", "c", { historySequence: 9 }),
      ])
    ).toBe(-8);
  });

  it("ignores malformed stamps and prefers the latest boundary's sequence", () => {
    expect(
      workspaceMemoryPolicyEpochOf([
        createMuxMessage("u1", "user", "a", {
          historySequence: 3,
          historySegment: -4 as unknown as number,
        }),
        createMuxMessage("u2", "user", "b", { historySequence: 4, historySegment: 2.5 }),
      ])
    ).toBe(-1);
    expect(
      workspaceMemoryPolicyEpochOf([
        boundary("s1", 5),
        createMuxMessage("u1", "user", "a", { historySequence: 6, historySegment: 5 }),
      ])
    ).toBe(5);
  });
});

describe("duplicateUserMessageIds", () => {
  it("names ids shared by several user rows and makes them prior turns", () => {
    const rows = [
      createMuxMessage("u1", "user", "first", { historySequence: 0 }),
      createMuxMessage("a1", "assistant", "reply", { historySequence: 1 }),
      createMuxMessage("u1", "user", "same id again", { historySequence: 2 }),
    ];
    expect([...duplicateUserMessageIds(rows)]).toEqual(["u1"]);
    expect(duplicateUserMessageIds(rows.slice(0, 2)).size).toBe(0);
    // The current batch is matched by id: the duplicated id would hide the
    // earlier row from the prior-turn check, so it counts as one.
    expect(epochHasPriorTurnRows(rows, new Set(["u1"]))).toBe(true);
    expect(epochHasPriorTurnRows(rows.slice(0, 2), new Set(["u1"]))).toBe(false);
  });
});

describe("compactionClosingPolicyEpoch", () => {
  it("prefers the recorded closing epoch and falls back to the legacy identity", () => {
    expect(
      compactionClosingPolicyEpoch({ closingPolicyEpoch: -8, previousBoundaryHistorySequence: 3 })
    ).toBe(-8);
    expect(compactionClosingPolicyEpoch({ previousBoundaryHistorySequence: 3 })).toBe(3);
    expect(compactionClosingPolicyEpoch({})).toBe(-1);
  });
});

describe("findLatestCompactionBoundaryIndex", () => {
  it("returns the newest compaction boundary via reverse scan", () => {
    const messages = [
      createMuxMessage("u0", "user", "before"),
      createMuxMessage("summary-1", "assistant", "first summary", {
        compacted: "user",
        compactionBoundary: true,
        compactionEpoch: 1,
      }),
      createMuxMessage("u1", "user", "middle"),
      createMuxMessage("summary-2", "assistant", "second summary", {
        compacted: "user",
        compactionBoundary: true,
        compactionEpoch: 2,
      }),
      createMuxMessage("u2", "user", "latest"),
    ];

    expect(findLatestCompactionBoundaryIndex(messages)).toBe(3);
  });

  it("treats heartbeat reset boundaries as durable compaction boundaries", () => {
    const messages = [
      createMuxMessage("u0", "user", "before"),
      createMuxMessage("heartbeat-reset", "assistant", "heartbeat reset", {
        compacted: "heartbeat",
        compactionBoundary: true,
        compactionEpoch: 1,
      }),
      createMuxMessage("u1", "user", "after"),
    ];

    expect(findLatestCompactionBoundaryIndex(messages)).toBe(1);
  });

  it("returns -1 when only legacy compacted summaries exist", () => {
    const messages = [
      createMuxMessage("u0", "user", "before"),
      createMuxMessage("legacy-summary", "assistant", "legacy summary", {
        compacted: "user",
      }),
      createMuxMessage("u1", "user", "after"),
    ];

    expect(findLatestCompactionBoundaryIndex(messages)).toBe(-1);
  });

  it("ignores boundary markers that are missing compactionEpoch", () => {
    const messages = [
      createMuxMessage("u0", "user", "before"),
      createMuxMessage("summary-valid", "assistant", "valid summary", {
        compacted: "user",
        compactionBoundary: true,
        compactionEpoch: 1,
      }),
      createMuxMessage("u1", "user", "middle"),
      createMuxMessage("summary-missing-epoch", "assistant", "malformed summary", {
        compacted: "user",
        compactionBoundary: true,
        // Corrupted/normalized persisted metadata: missing epoch must not be durable.
      }),
      createMuxMessage("u2", "user", "after"),
    ];

    expect(findLatestCompactionBoundaryIndex(messages)).toBe(1);
  });

  it("skips malformed boundary markers and keeps scanning for the latest durable boundary", () => {
    const messages = [
      createMuxMessage("u0", "user", "before"),
      createMuxMessage("summary-valid", "assistant", "valid summary", {
        compacted: "user",
        compactionBoundary: true,
        compactionEpoch: 1,
      }),
      createMuxMessage("u1", "user", "middle"),
      createMuxMessage("summary-malformed", "assistant", "malformed summary", {
        // Corrupted persisted metadata: looks like a boundary but is not a compacted summary.
        compacted: false,
        compactionBoundary: true,
        compactionEpoch: 2,
      }),
      createMuxMessage("u2", "user", "after"),
    ];

    expect(findLatestCompactionBoundaryIndex(messages)).toBe(1);
  });
  it("ignores boundary markers with malformed compacted values", () => {
    const malformedCompactedBoundary = createMuxMessage(
      "summary-malformed-compacted",
      "assistant",
      "malformed summary",
      {
        compactionBoundary: true,
        compactionEpoch: 99,
      }
    );
    if (malformedCompactedBoundary.metadata) {
      (malformedCompactedBoundary.metadata as Record<string, unknown>).compacted = "corrupt";
    }

    const messages = [
      createMuxMessage("u0", "user", "before"),
      createMuxMessage("summary-valid", "assistant", "valid summary", {
        compacted: "user",
        compactionBoundary: true,
        compactionEpoch: 1,
      }),
      malformedCompactedBoundary,
      createMuxMessage("u1", "user", "after"),
    ];

    expect(findLatestCompactionBoundaryIndex(messages)).toBe(1);
  });

  it("ignores user-role messages with boundary-like metadata", () => {
    const messages = [
      createMuxMessage("u0", "user", "before"),
      createMuxMessage("summary-valid", "assistant", "valid summary", {
        compacted: "user",
        compactionBoundary: true,
        compactionEpoch: 1,
      }),
      createMuxMessage("u1", "user", "not-a-summary", {
        compacted: "user",
        compactionBoundary: true,
        compactionEpoch: 2,
      }),
      createMuxMessage("u2", "user", "after"),
    ];

    expect(findLatestCompactionBoundaryIndex(messages)).toBe(1);
  });
});

describe("context boundary helpers", () => {
  it("recognizes context reset boundaries as latest context boundary", () => {
    const messages = [
      createMuxMessage("u0", "user", "before"),
      createMuxMessage("reset", "assistant", "", { contextBoundaryKind: "reset" }),
      createMuxMessage("u1", "user", "after"),
    ];

    expect(findLatestContextBoundaryIndex(messages)).toBe(1);
    expect(findLatestCompactionBoundaryIndex(messages)).toBe(-1);
  });

  it("excludes reset boundaries and pre-reset messages from provider slices", () => {
    const messages = [
      createMuxMessage("u0", "user", "before"),
      createMuxMessage("a0", "assistant", "before reply"),
      createMuxMessage("reset", "assistant", "", { contextBoundaryKind: "reset" }),
      createMuxMessage("u1", "user", "after"),
      createMuxMessage("a1", "assistant", "after reply"),
    ];

    const sliced = sliceMessagesForProviderFromLatestContextBoundary(messages);

    expect(sliced.map((msg) => msg.id)).toEqual(["u1", "a1"]);
  });

  it("keeps compaction summaries provider-visible in context slices", () => {
    const messages = [
      createMuxMessage("u0", "user", "before"),
      createMuxMessage("summary", "assistant", "summary text", {
        compacted: "user",
        compactionBoundary: true,
        compactionEpoch: 1,
      }),
      createMuxMessage("u1", "user", "after"),
    ];

    const sliced = sliceMessagesForProviderFromLatestContextBoundary(messages);

    expect(sliced.map((msg) => msg.id)).toEqual(["summary", "u1"]);
  });

  it("uses the latest boundary across mixed compaction and reset histories", () => {
    const messages = [
      createMuxMessage("u0", "user", "before"),
      createMuxMessage("summary", "assistant", "summary text", {
        compacted: "user",
        compactionBoundary: true,
        compactionEpoch: 1,
      }),
      createMuxMessage("u1", "user", "middle"),
      createMuxMessage("reset", "assistant", "", { contextBoundaryKind: "reset" }),
      createMuxMessage("u2", "user", "latest"),
    ];

    expect(findLatestContextBoundaryIndex(messages)).toBe(3);
    expect(
      sliceMessagesForProviderFromLatestContextBoundary(messages).map((msg) => msg.id)
    ).toEqual(["u2"]);
  });

  it("does not count reset boundaries as provider-eligible messages", () => {
    expect(
      hasProviderEligibleMessages([
        createMuxMessage("reset", "assistant", "", { contextBoundaryKind: "reset" }),
      ])
    ).toBe(false);
    expect(hasProviderEligibleMessages([createMuxMessage("u1", "user", "after")])).toBe(true);
  });

  it("optionally counts reasoning while excluding rejected payloads and reset markers", () => {
    const reasoning = createMuxMessage("thinking", "assistant", "");
    reasoning.parts = [{ type: "reasoning", text: "Preserved thinking" }];
    expect(hasProviderEligibleMessages([reasoning])).toBe(false);
    expect(hasProviderEligibleMessages([reasoning], { preserveReasoningOnly: true })).toBe(true);
    for (const metadata of [
      { contextBudgetRejected: true as const },
      { contextBoundaryKind: "reset" as const },
    ]) {
      expect(
        hasProviderEligibleMessages([{ ...reasoning, metadata }], {
          preserveReasoningOnly: true,
        })
      ).toBe(false);
    }
    expect(
      hasProviderEligibleMessages([createMuxMessage("empty", "assistant", "")], {
        preserveReasoningOnly: true,
      })
    ).toBe(false);
  });
});

describe("sliceMessagesFromLatestCompactionBoundary", () => {
  it("slices request payload history from the latest compaction boundary", () => {
    const messages = [
      createMuxMessage("u0", "user", "before"),
      createMuxMessage("summary-1", "assistant", "first summary", {
        compacted: "user",
        compactionBoundary: true,
        compactionEpoch: 1,
      }),
      createMuxMessage("u1", "user", "middle"),
      createMuxMessage("summary-2", "assistant", "second summary", {
        compacted: "user",
        compactionBoundary: true,
        compactionEpoch: 2,
      }),
      createMuxMessage("u2", "user", "latest"),
      createMuxMessage("a2", "assistant", "reply"),
    ];

    const sliced = sliceMessagesFromLatestCompactionBoundary(messages);

    expect(sliced.map((msg) => msg.id)).toEqual(["summary-2", "u2", "a2"]);
    expect(sliced[0]?.metadata?.compactionBoundary).toBe(true);
  });

  it("slices from heartbeat reset boundaries", () => {
    const messages = [
      createMuxMessage("u0", "user", "before"),
      createMuxMessage("heartbeat-reset", "assistant", "heartbeat reset", {
        compacted: "heartbeat",
        compactionBoundary: true,
        compactionEpoch: 1,
      }),
      createMuxMessage("u1", "user", "after"),
      createMuxMessage("a1", "assistant", "reply"),
    ];

    const sliced = sliceMessagesFromLatestCompactionBoundary(messages);

    expect(sliced.map((msg) => msg.id)).toEqual(["heartbeat-reset", "u1", "a1"]);
  });

  it("falls back to full history when no durable boundary exists", () => {
    const messages = [
      createMuxMessage("u0", "user", "before"),
      createMuxMessage("legacy-summary", "assistant", "legacy summary", {
        compacted: "user",
      }),
      createMuxMessage("u1", "user", "after"),
    ];

    const sliced = sliceMessagesFromLatestCompactionBoundary(messages);

    expect(sliced).toBe(messages);
    expect(sliced.map((msg) => msg.id)).toEqual(["u0", "legacy-summary", "u1"]);
  });

  it("treats missing compactionEpoch boundary markers as non-boundaries", () => {
    const messages = [
      createMuxMessage("u0", "user", "before"),
      createMuxMessage("summary-missing-epoch", "assistant", "malformed summary", {
        compacted: "user",
        compactionBoundary: true,
        // Schema normalization can drop malformed epochs to undefined.
      }),
      createMuxMessage("u1", "user", "after"),
    ];

    const sliced = sliceMessagesFromLatestCompactionBoundary(messages);

    expect(sliced).toBe(messages);
    expect(sliced.map((msg) => msg.id)).toEqual(["u0", "summary-missing-epoch", "u1"]);
  });

  it("treats malformed compacted boundary markers as non-boundaries", () => {
    const malformedCompactedBoundary = createMuxMessage(
      "summary-malformed-compacted",
      "assistant",
      "malformed summary",
      {
        compactionBoundary: true,
        compactionEpoch: 2,
      }
    );
    if (malformedCompactedBoundary.metadata) {
      (malformedCompactedBoundary.metadata as Record<string, unknown>).compacted = "corrupt";
    }

    const messages = [
      createMuxMessage("u0", "user", "before"),
      malformedCompactedBoundary,
      createMuxMessage("u1", "user", "after"),
    ];

    const sliced = sliceMessagesFromLatestCompactionBoundary(messages);

    expect(sliced).toBe(messages);
    expect(sliced.map((msg) => msg.id)).toEqual(["u0", "summary-malformed-compacted", "u1"]);
  });

  it("does not slice from user-role messages with boundary-like metadata", () => {
    const messages = [
      createMuxMessage("u0", "user", "before"),
      createMuxMessage("summary-valid", "assistant", "valid summary", {
        compacted: "user",
        compactionBoundary: true,
        compactionEpoch: 1,
      }),
      createMuxMessage("u1", "user", "not-a-summary", {
        compacted: "user",
        compactionBoundary: true,
        compactionEpoch: 2,
      }),
      createMuxMessage("a1", "assistant", "after"),
    ];

    const sliced = sliceMessagesFromLatestCompactionBoundary(messages);

    expect(sliced.map((msg) => msg.id)).toEqual(["summary-valid", "u1", "a1"]);
    expect(sliced[0]?.id).toBe("summary-valid");
  });

  it("treats malformed boundary markers as non-boundaries instead of crashing", () => {
    const messages = [
      createMuxMessage("u0", "user", "before"),
      createMuxMessage("summary-malformed", "assistant", "malformed summary", {
        compacted: "user",
        compactionBoundary: true,
        // Corrupted persisted metadata: invalid epoch should not brick request assembly.
        compactionEpoch: 0,
      }),
      createMuxMessage("u1", "user", "after"),
    ];

    const sliced = sliceMessagesFromLatestCompactionBoundary(messages);

    expect(sliced).toBe(messages);
    expect(sliced.map((msg) => msg.id)).toEqual(["u0", "summary-malformed", "u1"]);
  });
});

describe("epochHasPriorTurnRows", () => {
  const current = new Set(["u-now", "p-now"]);
  const withRows = (...rows: Array<Parameters<typeof createMuxMessage>>) =>
    epochHasPriorTurnRows(
      rows.map((args) => createMuxMessage(...args)),
      current
    );

  it("counts an earlier user turn but not the batch being started", () => {
    expect(withRows(["u-now", "user", "now"], ["p-now", "user", "prelude"])).toBe(false);
    expect(withRows(["u-old", "user", "earlier"], ["u-now", "user", "now"])).toBe(true);
    expect(withRows(["a-old", "assistant", "answer"], ["u-now", "user", "now"])).toBe(false);
  });

  it("ignores rows that are no turn of the epoch: compaction requests, tail copies, token-budget internals", () => {
    expect(
      withRows(
        [
          "req",
          "user",
          "/compact",
          { muxMetadata: { type: "compaction-request", rawCommand: "/compact", parsed: {} } },
        ],
        ["u-now", "user", "now"]
      )
    ).toBe(false);
    expect(
      withRows(
        ["copy", "user", "earlier", { rlmPreservedTailCopy: true }],
        ["u-now", "user", "now"]
      )
    ).toBe(false);
    expect(
      withRows(
        [
          "lead",
          "user",
          "lead-in",
          { muxMetadata: { type: "context-window-lead-in", rolloverId: "r1" } },
        ],
        [
          "warn",
          "user",
          "warning",
          {
            muxMetadata: {
              type: "context-budget-warning",
              contextTokens: 1,
              maxTokens: 2,
              budgetTokens: 2,
            },
          },
        ],
        ["u-now", "user", "now"]
      )
    ).toBe(false);
  });
});

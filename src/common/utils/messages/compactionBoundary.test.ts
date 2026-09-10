import { describe, expect, it } from "bun:test";

import { createMuxMessage } from "@/common/types/message";

import {
  epochHasPriorTurnRows,
  findLatestCompactionBoundaryIndex,
  findLatestContextBoundaryIndex,
  hasProviderEligibleMessages,
  sliceMessagesForProviderFromLatestContextBoundary,
  sliceMessagesFromLatestCompactionBoundary,
} from "./compactionBoundary";

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
          { muxMetadata: { type: "context-budget-warning", contextTokens: 1, maxTokens: 2 } },
        ],
        ["u-now", "user", "now"]
      )
    ).toBe(false);
  });
});

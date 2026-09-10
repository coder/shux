import { describe, expect, test } from "bun:test";
import { MuxMessageSchema } from "@/common/orpc/schemas/message";
import { createMuxMessage } from "@/common/types/message";
import { StreamingMessageAggregator } from "./StreamingMessageAggregator";

const CREATED_AT = "2026-01-01T00:00:00.000Z";

describe("continuous compaction replay", () => {
  test("keeps visible tail copies in order after the boundary without exposing model-only rows", () => {
    const summary = createMuxMessage("summary", "assistant", "Older context summary", {
      historySequence: 10,
      compacted: true,
      compactionBoundary: true,
      compactionEpoch: 3,
      muxMetadata: { type: "compaction-summary", strategy: "continuous" },
    });
    const request = "Keep this recent request";
    const reply = "Recent answer verbatim";
    const user = createMuxMessage("tail-user", "user", request, {
      historySequence: 11,
      synthetic: true,
      uiVisible: true,
    });
    const assistant = createMuxMessage("tail-assistant", "assistant", reply, {
      historySequence: 12,
      synthetic: true,
      uiVisible: true,
      stepStartPartIndices: [0],
    });
    const hidden = createMuxMessage("hidden", "user", "Model-only context", {
      historySequence: 13,
      synthetic: true,
    });

    const aggregator = new StreamingMessageAggregator(CREATED_AT);
    aggregator.loadHistoricalMessages(
      [summary, user, assistant, hidden].map((message) => MuxMessageSchema.parse(message)),
      false
    );
    const displayed = aggregator.getDisplayedMessages();
    expect(displayed.map((message) => message.type)).toEqual([
      "compaction-boundary",
      "assistant",
      "user",
      "assistant",
    ]);
    expect(displayed[0]).toMatchObject({
      strategy: "continuous",
      compactionEpoch: 3,
      historySequence: 10,
    });
    expect(displayed[2]).toMatchObject({ historyId: user.id, content: request });
    expect(displayed[3]).toMatchObject({ historyId: assistant.id, content: reply });
    expect(aggregator.getActiveStreamMessageId()).toBeUndefined();
  });
});

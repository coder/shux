import { describe, expect, test, spyOn } from "bun:test";

import { StreamEndEventSchema } from "@/common/orpc/schemas/stream";
import { createMuxMessage, type MuxMetadata } from "@/common/types/message";
import type { StreamEndEvent, StreamStartEvent } from "@/common/types/stream";
import { createTestHistoryService } from "@/node/services/testHistoryService";
import {
  simulateContextLimitError,
  simulateToolPolicyNoop,
  type SimulationContext,
} from "./streamSimulation";

interface CapturedEvent {
  event: string;
  data: unknown;
}

function createSimulationContext(events: CapturedEvent[]): SimulationContext {
  return {
    workspaceId: "workspace-1",
    assistantMessageId: "assistant-1",
    canonicalModelString: "openai:gpt-5.5",
    routedThroughGateway: false,
    historySequence: 1,
    systemMessageTokens: 123,
    effectiveAgentId: "exec",
    effectiveMode: "exec",
    metadataMode: "exec",
    effectiveThinkingLevel: "low",
    emit: (event, data) => events.push({ event, data }),
  };
}

function getCapturedEvent<T extends { type: string }>(events: CapturedEvent[], type: T["type"]): T {
  const match = events.find((event) => event.event === type);
  expect(match).toBeDefined();
  if (!match) {
    throw new Error(`Expected captured ${type} event`);
  }
  return match.data as T;
}

describe("streamSimulation", () => {
  test("persists legacy mode metadata for simulated context-limit partials", async () => {
    const { historyService, cleanup } = await createTestHistoryService();
    try {
      const events: CapturedEvent[] = [];
      const ctx = createSimulationContext(events);

      await simulateContextLimitError(ctx, historyService);

      const streamStart = getCapturedEvent<StreamStartEvent>(events, "stream-start");
      expect(streamStart.mode).toBe("exec");
      const partial = await historyService.readPartial(ctx.workspaceId);
      expect(partial?.metadata?.agentId).toBe("exec");
      expect(partial?.metadata?.mode).toBe("exec");
    } finally {
      await cleanup();
    }
  });

  test("persists legacy mode metadata for simulated noop stream completion", async () => {
    const { historyService, cleanup } = await createTestHistoryService();
    try {
      const events: CapturedEvent[] = [];
      const ctx = createSimulationContext(events);

      const appendResult = await historyService.appendToHistory(
        ctx.workspaceId,
        createMuxMessage(ctx.assistantMessageId, "assistant", "", {
          historySequence: ctx.historySequence,
        })
      );
      expect(appendResult.success).toBe(true);

      await simulateToolPolicyNoop(ctx, undefined, historyService);

      const streamEnd = getCapturedEvent<StreamEndEvent>(events, "stream-end");
      const streamEndMetadata = streamEnd.metadata as StreamEndEvent["metadata"] &
        Pick<MuxMetadata, "mode">;
      expect(streamEndMetadata.agentId).toBe("exec");
      expect(streamEndMetadata.mode).toBe("exec");

      const parsedStreamEnd = StreamEndEventSchema.parse(streamEnd);
      expect(parsedStreamEnd.metadata.mode).toBe("exec");

      const historyResult = await historyService.getLastMessages(ctx.workspaceId, 1);
      expect(historyResult.success).toBe(true);
      if (!historyResult.success) return;
      expect(historyResult.data[0]?.metadata?.agentId).toBe("exec");
      expect(historyResult.data[0]?.metadata?.mode).toBe("exec");
    } finally {
      await cleanup();
    }
  });
  test("returns its terminal payload only after final history while preserving raw emission order", async () => {
    const { historyService, cleanup } = await createTestHistoryService();
    const entered = Promise.withResolvers<void>();
    const release = Promise.withResolvers<void>();
    const events: CapturedEvent[] = [];
    const ctx = createSimulationContext(events);
    let run: Promise<StreamEndEvent> | undefined;
    try {
      await historyService.appendToHistory(
        ctx.workspaceId,
        createMuxMessage(ctx.assistantMessageId, "assistant", "", {
          historySequence: ctx.historySequence,
        })
      );
      const update = historyService.updateHistory.bind(historyService);
      spyOn(historyService, "updateHistory").mockImplementationOnce(async (id, message) => {
        entered.resolve();
        await release.promise;
        return update(id, message);
      });
      let finished = false;
      run = simulateToolPolicyNoop(ctx, undefined, historyService);
      const observed = run.then(() => {
        finished = true;
      });
      await entered.promise;
      expect(events.map((event) => event.event)).toEqual([
        "stream-start",
        "stream-delta",
        "stream-end",
      ]);
      expect(finished).toBe(false);
      release.resolve();
      const terminal = await run;
      await observed;
      expect(terminal).toBe(getCapturedEvent<StreamEndEvent>(events, "stream-end"));
      const history = await historyService.getHistoryFromLatestBoundary(ctx.workspaceId);
      if (!history.success) throw new Error(history.error);
      expect(history.data[0].parts).toEqual(terminal.parts);
    } finally {
      release.resolve();
      await run;
      await cleanup();
    }
  });
});

/**
 * Round-trip contract test for the onChat since-mode reconnect cursor.
 *
 * Server persistence writes one part per streaming delta, while the client
 * aggregator compacts parts on append and keeps its own assembled representation
 * at stream-end. The reconnect cursor contract must therefore be independent of
 * the client's in-memory representation: the client reuses the server-issued
 * cursor verbatim instead of recomputing fingerprints locally.
 *
 * This test drives the real server replay path (AgentSession + real
 * HistoryService) against the real client aggregator, mirroring the
 * WorkspaceStore caught-up handling. It fails on client-side fingerprint
 * recomputation (silent since→full downgrade after ≥2 live-streamed turns).
 */
import { describe, expect, it, mock, afterEach } from "bun:test";
import type { MuxMessage } from "@/common/types/message";
import {
  isMuxMessage,
  type CaughtUpMessage,
  type OnChatMode,
  type WorkspaceChatMessage,
} from "@/common/orpc/types";
import { StreamingMessageAggregator } from "@/browser/utils/messages/StreamingMessageAggregator";
import type { AgentSession } from "./agentSession";
import { createAgentSessionHarness } from "./agentSession.testHarness";
import type { HistoryService } from "./historyService";

const TEST_MODEL = "anthropic:claude-test";

async function createContractHarness(workspaceId: string) {
  const replayStream = mock((_workspaceId: string, _opts?: { afterTimestamp?: number }) =>
    Promise.resolve()
  );
  const replayInit = mock((_workspaceId: string) => Promise.resolve());
  return await createAgentSessionHarness({
    workspaceId,
    aiServiceOverrides: {
      getStreamInfo: mock((_workspaceId: string) => undefined),
      replayStream,
    },
    initStateManagerOverrides: { replayInit },
  });
}

/** Assistant row exactly as streamManager persists it: one text part per delta. */
function perDeltaAssistantMessage(id: string, deltas: string[], baseTimestamp: number): MuxMessage {
  return {
    id,
    role: "assistant",
    parts: deltas.map((text, index) => ({
      type: "text" as const,
      text,
      timestamp: baseTimestamp + index,
    })),
    metadata: { timestamp: baseTimestamp, model: TEST_MODEL },
  };
}

interface ReplayCapture {
  events: WorkspaceChatMessage[];
  rows: MuxMessage[];
  caughtUp: CaughtUpMessage;
}

/**
 * Run a full/since replay against the session and apply it to the aggregator the
 * same way WorkspaceStore.handleChatMessage does: buffer rows, then load them on
 * caught-up with replace (full) or append (since) semantics.
 */
async function replayIntoAggregator(
  session: AgentSession,
  aggregator: StreamingMessageAggregator,
  mode?: OnChatMode
): Promise<ReplayCapture> {
  const events: WorkspaceChatMessage[] = [];
  await session.replayHistory(({ message }: { message: WorkspaceChatMessage }) => {
    events.push(message);
  }, mode);

  const caughtUp = events.find(
    (event): event is CaughtUpMessage => "type" in event && event.type === "caught-up"
  );
  if (!caughtUp) {
    throw new Error("Expected caught-up event from replayHistory");
  }

  const rows = events.filter(isMuxMessage);
  const replay = caughtUp.replay ?? "full";
  if (replay === "since") {
    if (mode?.type !== "since") {
      throw new Error("Server reported since replay without a since request");
    }
    aggregator.reconcileSinceReplay({
      requestedAnchorSequence: mode.cursor.history.historySequence,
      messages: rows,
      hasActiveStream: false,
    });
  } else {
    aggregator.loadHistoricalMessages(rows, false, { mode: "replace" });
  }
  // Mirror WorkspaceStore caught-up handling: reuse the server-issued cursor verbatim.
  aggregator.setServerHistoryCursor(caughtUp.cursor?.history ?? null);

  return { events, rows, caughtUp };
}

async function readPersisted(
  historyService: HistoryService,
  workspaceId: string,
  messageId: string
): Promise<MuxMessage> {
  const historyResult = await historyService.getHistoryFromLatestBoundary(workspaceId);
  if (!historyResult.success) {
    throw new Error(`Failed to read history: ${historyResult.error}`);
  }
  const persisted = historyResult.data.find((message) => message.id === messageId);
  if (!persisted || persisted.metadata?.historySequence === undefined) {
    throw new Error(`Expected persisted row with historySequence for ${messageId}`);
  }
  return persisted;
}

describe("onChat since-mode reconnect cursor contract", () => {
  let historyCleanup: (() => Promise<void>) | undefined;
  afterEach(async () => {
    await historyCleanup?.();
  });

  it("reconnects incrementally after two live-streamed turns", async () => {
    const workspaceId = "ws-since-cursor-contract";
    const harness = await createContractHarness(workspaceId);
    const { session, historyService } = harness;
    historyCleanup = harness.cleanup;

    const aggregator = new StreamingMessageAggregator("2024-01-01T00:00:00.000Z");

    // --- Turn 1: fully persisted before the client connects. ---
    expect(
      (
        await historyService.appendToHistory(
          workspaceId,
          perDeltaAssistantMessage("assistant-1", ["Hel", "lo"], 1_000)
        )
      ).success
    ).toBe(true);

    const first = await replayIntoAggregator(session, aggregator, { type: "full" });
    expect(first.caughtUp.replay).toBe("full");

    // --- Turns 2 and 3: streamed live while the client is watching. ---
    // The server persists one part per delta; the client assembles compacted parts
    // from stream events. Both live-assembled rows end up below the next cursor
    // anchor, which is exactly the divergence that broke fingerprint recomputation.
    const liveTurns: Array<{ id: string; deltas: string[]; baseTimestamp: number }> = [
      { id: "assistant-2", deltas: ["foo ", "bar"], baseTimestamp: 2_000 },
      { id: "assistant-3", deltas: ["baz ", "qux"], baseTimestamp: 3_000 },
    ];

    for (const turn of liveTurns) {
      expect(
        (
          await historyService.appendToHistory(
            workspaceId,
            perDeltaAssistantMessage(turn.id, turn.deltas, turn.baseTimestamp)
          )
        ).success
      ).toBe(true);
      const persisted = await readPersisted(historyService, workspaceId, turn.id);
      const historySequence = persisted.metadata?.historySequence;
      if (historySequence === undefined) {
        throw new Error("Expected persisted historySequence");
      }

      aggregator.handleStreamStart({
        type: "stream-start",
        workspaceId,
        messageId: turn.id,
        historySequence,
        model: TEST_MODEL,
        startTime: turn.baseTimestamp,
      });
      for (const [index, delta] of turn.deltas.entries()) {
        aggregator.handleStreamDelta({
          type: "stream-delta",
          workspaceId,
          messageId: turn.id,
          delta,
          tokens: 1,
          timestamp: turn.baseTimestamp + index,
        });
      }
      // Client keeps its own assembled (compacted) parts at stream-end; only tool
      // outputs are adopted from the event's parts. The persisted row keeps one part
      // per delta — exactly the representation divergence under test.
      aggregator.handleStreamEnd({
        type: "stream-end",
        workspaceId,
        messageId: turn.id,
        metadata: {
          model: TEST_MODEL,
          historySequence,
          timestamp: turn.baseTimestamp,
        },
        parts: [],
      });
    }

    // --- Switch away and back: reconnect with the client's cursor. ---
    const cursor = aggregator.getOnChatCursor();
    expect(cursor?.history).toBeDefined();
    if (!cursor?.history) {
      throw new Error("Expected a history cursor for since reconnect");
    }

    const second = await replayIntoAggregator(session, aggregator, {
      type: "since",
      cursor: { history: cursor.history, stream: cursor.stream },
    });

    // The money assertions: reconnect must stay incremental.
    expect(second.caughtUp.downgradeReason).toBeUndefined();
    expect(second.caughtUp.replay).toBe("since");

    // Only rows at/above the requested anchor are re-sent.
    const anchorSequence = cursor.history.historySequence;
    for (const row of second.rows) {
      const rowSequence = row.metadata?.historySequence;
      expect(rowSequence).toBeDefined();
      expect(rowSequence!).toBeGreaterThanOrEqual(anchorSequence);
    }

    // The client transcript converges exactly to persisted state (no ghosts, no dupes).
    const historyResult = await historyService.getHistoryFromLatestBoundary(workspaceId);
    if (!historyResult.success) {
      throw new Error(`Failed to read history: ${historyResult.error}`);
    }
    const persistedIds = historyResult.data.map((message) => message.id);
    expect(aggregator.getAllMessages().map((message) => message.id)).toEqual(persistedIds);
  });
});

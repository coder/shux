/**
 * CI determinism net for "model-visible ⟹ logged" (see replayVerify.ts).
 *
 * The committed fixture session is a frozen golden snapshot of the request
 * pipeline's bytes (chat.jsonl + turn-envelope rows + blobs + the recorded
 * devtools.jsonl requests). If anyone reintroduces request-time injection of
 * live state into the pipeline, the rebuilt request bytes differ from the
 * recorded golden bytes and these tests fail.
 *
 * Regenerate (only for intentional pipeline changes):
 *   MUX_REGENERATE_REPLAY_FIXTURE=1 bun test src/node/services/replay/replayVerify.fixture.test.ts
 */

import { beforeAll, describe, expect, test } from "bun:test";
import * as path from "node:path";
import type { MuxMessage } from "@/common/types/message";
import { createDisplayUsage } from "@/common/utils/tokens/displayUsage";
import { HistoryService } from "@/node/services/historyService";
import { auditCacheBusts } from "./cacheAudit";
import {
  generateReplayFixtureSession,
  REPLAY_FIXTURE_DIR,
  REPLAY_FIXTURE_WORKSPACE_ID,
} from "./replayFixture";
import { buildReplayRequest, type ReplayRequestInputs } from "./replayRequestBuilder";
import {
  collectAssistantTurns,
  collectFullHistory,
  replayVerifySession,
  type TurnEnvelopeEvent,
} from "./replayVerify";
import { DurableEventJournal } from "@/node/utils/journal/durableEventJournal";

async function readFixtureHistory(): Promise<MuxMessage[]> {
  const historyService = new HistoryService({
    getSessionDir: () => REPLAY_FIXTURE_DIR,
    rootDir: path.dirname(REPLAY_FIXTURE_DIR),
  });
  const result = await collectFullHistory(historyService, REPLAY_FIXTURE_WORKSPACE_ID);
  if (!result.success) {
    throw new Error(`fixture history read failed: ${result.error}`);
  }
  return result.data;
}

async function readFixtureEnvelopes(): Promise<TurnEnvelopeEvent[]> {
  const journal = new DurableEventJournal(REPLAY_FIXTURE_DIR);
  const events = await journal.read();
  return events.filter((event): event is TurnEnvelopeEvent => event.kind === "turn-envelope");
}

beforeAll(async () => {
  if (process.env.MUX_REGENERATE_REPLAY_FIXTURE === "1") {
    await generateReplayFixtureSession();
  }
});

describe("replay fixture session", () => {
  test("every recorded request is reconstructible byte-for-byte from the logs", async () => {
    const historyMessages = await readFixtureHistory();
    const result = await replayVerifySession({
      sessionDir: REPLAY_FIXTURE_DIR,
      workspaceId: REPLAY_FIXTURE_WORKSPACE_ID,
      historyMessages,
    });

    expect(result.notes).toEqual([]);
    expect(result.turns.length).toBeGreaterThanOrEqual(3);
    for (const turn of result.turns) {
      // On FAIL, surface the divergence in the assertion message.
      expect({
        turnIndex: turn.turnIndex,
        status: turn.status,
        divergence: turn.divergence,
        toolsetDiff: turn.toolsetDiff,
        reason: turn.reason,
      }).toEqual({
        turnIndex: turn.turnIndex,
        status: "PASS",
        divergence: undefined,
        toolsetDiff: undefined,
        reason: undefined,
      });
    }
  });

  test("building the request twice from the same log is byte-identical", async () => {
    const historyMessages = await readFixtureHistory();
    const envelopes = await readFixtureEnvelopes();
    const journal = new DurableEventJournal(REPLAY_FIXTURE_DIR);
    const lastEnvelope = envelopes[envelopes.length - 1];
    const turns = collectAssistantTurns(historyMessages);
    const lastTurn = turns[turns.length - 1];
    const systemPrompt = await journal.blobs.getText(lastEnvelope.data.systemPromptHash);
    if (systemPrompt == null) {
      throw new Error("fixture system prompt blob missing");
    }

    const inputs: ReplayRequestInputs = {
      historyMessages: historyMessages.filter(
        (message) => (message.metadata?.historySequence ?? 0) <= lastTurn.requestHistorySequence
      ),
      systemPrompt,
      modelString: lastEnvelope.data.modelString,
      thinkingLevel: "off",
      effectiveAgentId: "exec",
      toolNamesForSentinel: lastEnvelope.data.toolsetManifest.map((entry) => entry.name),
      workspaceId: REPLAY_FIXTURE_WORKSPACE_ID,
    };

    const first = await buildReplayRequest(inputs);
    const second = await buildReplayRequest(inputs);
    expect(JSON.stringify(second.lmPrompt)).toBe(JSON.stringify(first.lmPrompt));
    expect(JSON.stringify(second.messages)).toBe(JSON.stringify(first.messages));
  });

  test("cache-audit attributes the fixture's prefix invalidations", async () => {
    const historyMessages = await readFixtureHistory();
    const envelopes = await readFixtureEnvelopes();
    const turns = collectAssistantTurns(historyMessages);
    const usageByTurn = turns.map((turn) => {
      const metadata = turn.message.metadata;
      if (metadata?.usage == null || metadata.model == null) {
        return undefined;
      }
      return createDisplayUsage(
        metadata.usage,
        metadata.model,
        metadata.providerMetadata,
        metadata.metadataModel
      );
    });

    const audit = auditCacheBusts(envelopes, usageByTurn);
    expect(audit).toHaveLength(3);

    // Turn 0 is the baseline; turn 1 keeps the exact same prefix.
    expect(audit[0].causes).toEqual([]);
    expect(audit[1].causes).toEqual([]);
    expect(audit[1].approxBustedTokens).toBeUndefined();

    // Turn 2 changed the system prompt AND added a tool.
    const causeKinds = audit[2].causes.map((cause) => cause.kind).sort();
    expect(causeKinds).toEqual(["system-prompt", "toolset"]);
    const toolsetCause = audit[2].causes.find((cause) => cause.kind === "toolset");
    expect(toolsetCause?.detail).toBe("added:bash");
    // input(1400) - cacheCreate(1300) = 100 fresh + 1300 cache-write.
    expect(audit[2].approxBustedTokens).toBe(1400);
  });
});

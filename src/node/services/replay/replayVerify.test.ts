/**
 * Behavior tests for replayVerifySession's pairing and failure isolation:
 * compacted histories, missing assistant rows, devtools toggling, retries,
 * corrupted turns, and the turn-envelope round-trip of request-time inputs
 * (plan-transition content, post-compaction attachments, per-send cache TTL).
 *
 * Sessions are generated in temp dirs through the same fixture harness the
 * committed golden fixture uses (appendReplayFixtureTurn), so the recorded
 * requests mirror the production pipeline's bytes.
 */

import * as fs from "node:fs/promises";
import { describe, expect, test } from "bun:test";
import { tool, type Tool } from "ai";
import { z } from "zod";
import { createMuxMessage } from "@/common/types/message";
import { DisposableTempDir } from "@/node/services/tempDir";
import { emitTurnEnvelope } from "@/node/services/turnEnvelope";
import {
  appendReplayFixtureCompactionBoundary,
  appendReplayFixtureTurn,
  createReplayFixtureSessionContext,
  flushReplayFixtureDevtools,
  REPLAY_FIXTURE_MODEL,
  type ReplayFixtureSessionContext,
} from "./replayFixture";
import {
  collectFullHistory,
  replayVerifySession,
  type ReplayVerifySessionResult,
} from "./replayVerify";

const SYSTEM_PROMPT = "You are a temp replay session agent.";

function tools(): Record<string, Tool> {
  return {
    file_read: tool({
      description: "Read a file",
      inputSchema: z.object({ path: z.string() }),
    }),
  };
}

async function verify(ctx: ReplayFixtureSessionContext): Promise<ReplayVerifySessionResult> {
  await flushReplayFixtureDevtools(ctx);
  const historyResult = await collectFullHistory(ctx.historyService, ctx.workspaceId);
  if (!historyResult.success) {
    throw new Error(`history read failed: ${historyResult.error}`);
  }
  return replayVerifySession({
    sessionDir: ctx.sessionDir,
    workspaceId: ctx.workspaceId,
    historyMessages: historyResult.data,
  });
}

describe("replayVerifySession pairing", () => {
  test("verifies turns across a compaction boundary from the full history", async () => {
    using tmp = new DisposableTempDir("replay-verify-compaction");
    const ctx = createReplayFixtureSessionContext(tmp.path);

    await appendReplayFixtureTurn(ctx, {
      userText: "Before compaction.",
      assistantText: "Answer one.",
      systemPrompt: SYSTEM_PROMPT,
      tools: tools(),
    });
    await appendReplayFixtureCompactionBoundary(ctx, "Summary of the session so far.", 1);
    await appendReplayFixtureTurn(ctx, {
      userText: "After compaction.",
      assistantText: "Answer two.",
      systemPrompt: SYSTEM_PROMPT,
      tools: tools(),
      // Post-compaction attachments are injected into the request and must be
      // reconstructible from the envelope blob alone.
      postCompactionAttachments: [
        {
          type: "plan_file_reference",
          planFilePath: "/tmp/plan.md",
          planContent: "1. do the thing",
        },
      ],
    });

    const result = await verify(ctx);
    expect(result.turns.map((turn) => ({ status: turn.status, reason: turn.reason }))).toEqual([
      { status: "PASS", reason: undefined },
      { status: "PASS", reason: undefined },
    ]);

    // Guard against a vacuous pass: the injected attachment content must
    // actually be model-visible in the recorded request.
    const devtoolsRaw = ctx.devtoolsLines.join("\n");
    expect(devtoolsRaw).toContain("1. do the thing");
  });

  test("a turn without an assistant row skips only itself", async () => {
    using tmp = new DisposableTempDir("replay-verify-missing-assistant");
    const ctx = createReplayFixtureSessionContext(tmp.path);

    await appendReplayFixtureTurn(ctx, {
      userText: "First.",
      assistantText: "One.",
      systemPrompt: SYSTEM_PROMPT,
      tools: tools(),
    });
    // Stream failed before appending the assistant row: envelope + recorded
    // request exist, chat.jsonl has only the user row.
    await appendReplayFixtureTurn(ctx, {
      userText: "Second (stream died).",
      systemPrompt: SYSTEM_PROMPT,
      tools: tools(),
    });
    await appendReplayFixtureTurn(ctx, {
      userText: "Third.",
      assistantText: "Three.",
      systemPrompt: SYSTEM_PROMPT,
      tools: tools(),
    });

    const result = await verify(ctx);
    expect(result.turns.map((turn) => turn.status)).toEqual(["PASS", "SKIPPED", "PASS"]);
    expect(result.turns[1].reason).toContain("no assistant row");
  });

  test("a turn without a recorded devtools request skips only itself", async () => {
    using tmp = new DisposableTempDir("replay-verify-devtools-off");
    const ctx = createReplayFixtureSessionContext(tmp.path);

    await appendReplayFixtureTurn(ctx, {
      userText: "First.",
      assistantText: "One.",
      systemPrompt: SYSTEM_PROMPT,
      tools: tools(),
    });
    await appendReplayFixtureTurn(ctx, {
      userText: "Second (devtools off).",
      assistantText: "Two.",
      systemPrompt: SYSTEM_PROMPT,
      tools: tools(),
      recordDevtools: false,
    });
    await appendReplayFixtureTurn(ctx, {
      userText: "Third.",
      assistantText: "Three.",
      systemPrompt: SYSTEM_PROMPT,
      tools: tools(),
    });

    const result = await verify(ctx);
    expect(result.turns.map((turn) => turn.status)).toEqual(["PASS", "SKIPPED", "PASS"]);
    expect(result.turns[1].reason).toContain("no recorded devtools request");
  });

  test("retried attempts are superseded; the final attempt verifies", async () => {
    using tmp = new DisposableTempDir("replay-verify-retry");
    const ctx = createReplayFixtureSessionContext(tmp.path);

    await appendReplayFixtureTurn(ctx, {
      userText: "Retry me.",
      assistantText: "Done on the second attempt.",
      systemPrompt: SYSTEM_PROMPT,
      tools: tools(),
      extraEnvelopeAttempts: 1,
    });

    const result = await verify(ctx);
    expect(result.turns.map((turn) => turn.status)).toEqual(["SKIPPED", "PASS"]);
    expect(result.turns[0].reason).toContain("superseded by a later attempt");
  });

  test("a corrupted turn FAILs with the error and later turns still verify", async () => {
    using tmp = new DisposableTempDir("replay-verify-corrupt-turn");
    const ctx = createReplayFixtureSessionContext(tmp.path);

    await appendReplayFixtureTurn(ctx, {
      userText: "First.",
      assistantText: "One.",
      systemPrompt: SYSTEM_PROMPT,
      tools: tools(),
    });

    // Hand-build a turn whose envelope carries an EMPTY system prompt blob:
    // buildReplayRequest asserts on it, and the assertion must become a FAIL
    // for this turn instead of crashing the whole verification (and the CLI).
    const userMessage = createMuxMessage("user-corrupt", "user", "Corrupted turn.", {
      timestamp: 1_700_000_500_000,
    });
    const appendUser = await ctx.historyService.appendToHistory(ctx.workspaceId, userMessage);
    expect(appendUser.success).toBe(true);
    const seq = userMessage.metadata?.historySequence;
    if (seq == null) throw new Error("user row missing historySequence");
    await emitTurnEnvelope({
      journal: ctx.journal,
      workspaceId: ctx.workspaceId,
      systemMessage: "",
      tools: tools(),
      modelString: REPLAY_FIXTURE_MODEL,
      thinkingLevel: "off",
      providerOptions: { anthropic: {} },
      requestHistorySequence: seq,
      wireProviderName: "anthropic",
    });
    ctx.devtoolsLines.push(
      JSON.stringify({
        type: "run",
        run: {
          id: "run-corrupt",
          workspaceId: ctx.workspaceId,
          startedAt: new Date(1_700_000_501_000).toISOString(),
          requestHistorySequence: seq,
        },
      }),
      JSON.stringify({
        type: "step",
        step: {
          id: "step-corrupt",
          runId: "run-corrupt",
          stepNumber: 0,
          type: "stream",
          modelId: REPLAY_FIXTURE_MODEL,
          provider: "anthropic",
          startedAt: new Date(1_700_000_501_000).toISOString(),
          durationMs: 1,
          input: { prompt: [], tools: [] },
          output: null,
          usage: null,
          error: null,
          rawRequest: null,
          requestHeaders: null,
          responseHeaders: null,
          rawResponse: null,
          rawChunks: null,
        },
      })
    );
    const assistantMessage = createMuxMessage("assistant-corrupt", "assistant", "Oops.", {
      timestamp: 1_700_000_502_000,
      model: REPLAY_FIXTURE_MODEL,
      agentId: "exec",
      thinkingLevel: "off",
      requestHistorySequence: seq,
    });
    const appendAssistant = await ctx.historyService.appendToHistory(
      ctx.workspaceId,
      assistantMessage
    );
    expect(appendAssistant.success).toBe(true);
    ctx.turnCounter += 1;

    await appendReplayFixtureTurn(ctx, {
      userText: "Third.",
      assistantText: "Three.",
      systemPrompt: SYSTEM_PROMPT,
      tools: tools(),
    });

    const result = await verify(ctx);
    expect(result.turns.map((turn) => turn.status)).toEqual(["PASS", "FAIL", "PASS"]);
    expect(result.turns[1].reason).toContain("system prompt");
  });

  test("plan-transition content and per-send cache TTL are log-derivable", async () => {
    using tmp = new DisposableTempDir("replay-verify-plan-transition");
    const ctx = createReplayFixtureSessionContext(tmp.path);

    await appendReplayFixtureTurn(ctx, {
      userText: "Please plan this.",
      assistantText: "Here is the plan.",
      agentId: "plan",
      systemPrompt: SYSTEM_PROMPT,
      tools: tools(),
    });
    // plan → exec handoff: injectAgentTransition embeds the plan content into
    // the request; the envelope blob must be enough to rebuild those bytes.
    await appendReplayFixtureTurn(ctx, {
      userText: "Plan accepted, implement it.",
      assistantText: "Implemented.",
      agentId: "exec",
      systemPrompt: SYSTEM_PROMPT,
      tools: tools(),
      planContentForTransition: "Step 1: add the feature.\nStep 2: test it.",
      planFilePath: "/plans/feature.md",
      anthropicCacheTtl: "1h",
    });

    const result = await verify(ctx);
    expect(result.turns.map((turn) => ({ status: turn.status, reason: turn.reason }))).toEqual([
      { status: "PASS", reason: undefined },
      { status: "PASS", reason: undefined },
    ]);

    // Guard against a vacuous pass: the plan content and the non-default TTL
    // must actually be model-visible in the recorded request.
    const devtoolsRaw = await fs.readFile(`${tmp.path}/devtools.jsonl`, "utf-8");
    expect(devtoolsRaw).toContain("Step 1: add the feature.");
    expect(devtoolsRaw).toContain("/plans/feature.md");
    expect(devtoolsRaw).toContain('"ttl":"1h"');
  });

  test("refusal-fallback partial continuation is log-derivable", async () => {
    using tmp = new DisposableTempDir("replay-verify-partial-continuation");
    const ctx = createReplayFixtureSessionContext(tmp.path);

    // A refusal fallback appends the refused attempt's partial output to the
    // request as a synthetic assistant continuation. It never reaches
    // chat.jsonl at this turn's requestHistorySequence (the surviving
    // assistant row lands later), so the envelope blob must be enough to
    // rebuild the request bytes.
    const continuation = createMuxMessage(
      "assistant-partial-refusal",
      "assistant",
      "Partial output before the refusal.",
      { timestamp: 1_700_000_005_000 }
    );
    await appendReplayFixtureTurn(ctx, {
      userText: "Trigger a refusal fallback.",
      assistantText: "Fallback model finished the job.",
      systemPrompt: SYSTEM_PROMPT,
      tools: tools(),
      partialContinuation: continuation,
    });

    const result = await verify(ctx);
    expect(result.turns.map((turn) => ({ status: turn.status, reason: turn.reason }))).toEqual([
      { status: "PASS", reason: undefined },
    ]);

    // Guard against a vacuous pass: the continuation text must actually be
    // model-visible in the recorded request.
    const devtoolsRaw = await fs.readFile(`${tmp.path}/devtools.jsonl`, "utf-8");
    expect(devtoolsRaw).toContain("Partial output before the refusal.");
  });
});

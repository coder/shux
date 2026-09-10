import * as path from "node:path";
import { defaultConfig } from "@/node/config";
import { HistoryService } from "@/node/services/historyService";
import { ProviderService } from "@/node/services/providerService";
import {
  REPLAY_FIXTURE_DIR,
  REPLAY_FIXTURE_WORKSPACE_ID,
} from "@/node/services/replay/replayFixture";
import { collectFullHistory, replayVerifySession } from "@/node/services/replay/replayVerify";

/**
 * The committed fixture session lives in the repo, not under ~/.mux/sessions;
 * map its well-known workspace ID so both replay debug commands can be
 * exercised without a real recorded session.
 */
export function resolveReplaySessionDir(workspaceId: string): {
  sessionDir: string;
  historyService: HistoryService;
} {
  if (workspaceId === REPLAY_FIXTURE_WORKSPACE_ID) {
    return {
      sessionDir: REPLAY_FIXTURE_DIR,
      historyService: new HistoryService({
        getSessionDir: () => REPLAY_FIXTURE_DIR,
        // Read-only verification: rootDir only locates write locks/tombstones.
        rootDir: path.dirname(REPLAY_FIXTURE_DIR),
      }),
    };
  }
  return {
    sessionDir: path.join(defaultConfig.sessionsDir, workspaceId),
    historyService: new HistoryService(defaultConfig),
  };
}

/**
 * Debug command: rebuild every turn's provider request from durable session
 * logs (chat.jsonl + turn-envelope rows + blob store) and byte-compare it
 * against the recorded request in devtools.jsonl (requires llmDebugLogs).
 *
 * Guarantee scope: same log + same config + same binary.
 * Usage: bun debug replay-verify <workspace-id>
 * (use the workspace ID "replay-fixture" to run against the committed fixture)
 */
export async function replayVerifyCommand(workspaceId: string): Promise<void> {
  const { sessionDir, historyService } = resolveReplaySessionDir(workspaceId);
  // Full history (all compaction epochs): envelopes and recorded requests span
  // the whole session, so a boundary-sliced read would misalign the pairing.
  const historyResult = await collectFullHistory(historyService, workspaceId);
  if (!historyResult.success) {
    console.error(`Failed to read chat history: ${historyResult.error}`);
    process.exitCode = 1;
    return;
  }

  const result = await replayVerifySession({
    sessionDir,
    workspaceId,
    historyMessages: historyResult.data,
    // Same provider config view the live request build saw: aliases, custom
    // provider metadata, and cross-typed Coder instances change cache
    // wrapping and message preparation, and omitting them yields false
    // prompt divergences.
    providersConfig: new ProviderService(defaultConfig).getConfig(),
  });

  console.log(`\n=== Replay verification for workspace: ${workspaceId} ===\n`);
  for (const note of result.notes) {
    console.log(`note: ${note}\n`);
  }
  if (result.turns.length === 0) {
    console.log(
      "No verifiable turns found. Replay verification needs turn-envelope rows " +
        "(durable-events.jsonl) AND recorded requests (devtools.jsonl via llmDebugLogs)."
    );
    return;
  }

  let failures = 0;
  for (const turn of result.turns) {
    const label = `turn ${turn.turnIndex} (envelope seq ${turn.envelopeSeq}, run ${turn.runId || "n/a"})`;
    if (turn.status === "SKIPPED") {
      console.log(`SKIP  ${label}: ${turn.reason ?? ""}`);
      continue;
    }
    if (turn.status === "PASS") {
      console.log(`PASS  ${label}`);
      continue;
    }
    failures++;
    console.log(`FAIL  ${label}`);
    if (turn.reason) {
      console.log(`      reason: ${turn.reason}`);
    }
    if (turn.systemPromptMatch === false) {
      console.log("      system prompt: recorded request differs from envelope blob");
    }
    if (turn.toolsetMatch === false) {
      console.log(`      toolset: ${turn.toolsetDiff ?? "manifest mismatch"}`);
    }
    if (turn.divergence) {
      console.log(`      first divergence at ${turn.divergence.path}`);
      console.log(`        rebuilt:  ${JSON.stringify(turn.divergence.expected)?.slice(0, 200)}`);
      console.log(`        recorded: ${JSON.stringify(turn.divergence.actual)?.slice(0, 200)}`);
    }
  }

  const passed = result.turns.filter((turn) => turn.status === "PASS").length;
  const skipped = result.turns.filter((turn) => turn.status === "SKIPPED").length;
  console.log(`\n${passed} PASS, ${failures} FAIL, ${skipped} SKIPPED\n`);
  if (failures > 0) {
    process.exitCode = 1;
  }
}

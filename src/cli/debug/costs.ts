import * as path from "path";
import * as fs from "fs";
import { defaultConfig } from "@/node/config";
import type { MuxMessage } from "@/common/types/message";
import { calculateTokenStats } from "@/common/utils/tokens/tokenStatsCalculator";
import { defaultModel } from "@/common/utils/ai/models";
import { getToolAvailabilityOptions } from "@/common/utils/tools/toolAvailability";

/**
 * Debug command to display cost/token statistics for a workspace
 * Usage: bun debug costs <workspace-id>
 */
export async function costsCommand(workspaceId: string) {
  console.log(`\n=== Cost Statistics for workspace: ${workspaceId} ===\n`);

  // Load chat history
  const sessionDir = path.join(defaultConfig.sessionsDir, workspaceId);
  const chatHistoryPath = path.join(sessionDir, "chat.jsonl");

  if (!fs.existsSync(chatHistoryPath)) {
    console.log(`No chat history found at: ${chatHistoryPath}`);
    return;
  }

  // Read and parse messages
  const data = fs.readFileSync(chatHistoryPath, "utf-8");
  const messages: MuxMessage[] = data
    .split("\n")
    .filter((line) => line.trim())
    .map((line) => JSON.parse(line) as MuxMessage);

  if (messages.length === 0) {
    console.log("No messages in chat history");
    return;
  }

  // Detect model from first assistant message
  const firstAssistantMessage = messages.find((msg) => msg.role === "assistant");
  const model = firstAssistantMessage?.metadata?.model ?? defaultModel;

  // Resolve parent workspace context so child workspaces correctly include
  // agent_report tool-definition tokens in accounting.
  const workspaceInfo = defaultConfig.findWorkspace(workspaceId);
  const parentWorkspaceId = workspaceInfo?.parentWorkspaceId ?? null;

  // Calculate stats using shared logic (now synchronous)
  const stats = await calculateTokenStats(
    messages,
    model,
    null,
    getToolAvailabilityOptions({ workspaceId, parentWorkspaceId })
  );

  // Display results
  console.log(`Model: ${stats.model}`);
  console.log(`Tokenizer encoding: ${stats.tokenizerName}`);
  console.log(`\nTotal Messages: ${messages.length}`);
  console.log(`\nContent Tokens (Estimated): ${stats.totalTokens.toLocaleString()}`);
  console.log(`(Actual API costs include system overhead)\n`);

  // Display last actual usage from API if available
  const lastUsage = stats.usageHistory[stats.usageHistory.length - 1];
  if (lastUsage) {
    const totalTokens =
      lastUsage.input.tokens +
      lastUsage.cached.tokens +
      lastUsage.output.tokens +
      lastUsage.reasoning.tokens;

    console.log(`Last API Response:`);
    console.log(`  Input Tokens:      ${lastUsage.input.tokens.toLocaleString()}`);
    console.log(`  Cached Tokens:     ${lastUsage.cached.tokens.toLocaleString()}`);
    console.log(`  Output Tokens:     ${lastUsage.output.tokens.toLocaleString()}`);
    if (lastUsage.reasoning.tokens > 0) {
      console.log(`  Reasoning Tokens:  ${lastUsage.reasoning.tokens.toLocaleString()}`);
    }
    console.log(`  Total Tokens:      ${totalTokens.toLocaleString()}`);
    console.log();
  }

  console.log("Breakdown by Consumer:");
  const maxNameLength = Math.max(...stats.consumers.map((c) => c.name.length), 10);

  for (const consumer of stats.consumers) {
    // Add indicator for web_search to show it's approximate
    const displayName = consumer.name === "web_search" ? `${consumer.name} ⓘ` : consumer.name;
    const namepadded = displayName.padEnd(maxNameLength + (consumer.name === "web_search" ? 2 : 0));

    // Format token display - show k for thousands with 1 decimal, include breakdown in separate columns
    const tokenDisplay =
      consumer.tokens >= 1000
        ? `${(consumer.tokens / 1000).toFixed(1)}k`
        : consumer.tokens.toString();

    const tokensFormatted = tokenDisplay.padStart(7);
    const percentageFormatted = `(${consumer.percentage.toFixed(1)}%)`.padStart(8);

    // Add breakdown info if both fixed and variable exist
    const breakdownInfo =
      consumer.fixedTokens && consumer.variableTokens
        ? ` [${consumer.fixedTokens} def + ${consumer.variableTokens} usage]`
        : "";

    // Create simple bar chart (each █ = 2%)
    const barLength = Math.round(consumer.percentage / 2);
    const bar = "█".repeat(barLength);

    console.log(
      `  ${namepadded}  ${tokensFormatted} ${percentageFormatted} ${bar}${breakdownInfo}`
    );
  }

  // Add note about web_search approximation if it's present
  if (stats.consumers.some((c) => c.name === "web_search")) {
    console.log("\n  ⓘ web_search tokens are approximate (encrypted content)");
  }

  // Display message breakdown
  const userMessages = messages.filter((m) => m.role === "user").length;
  const assistantMessages = messages.filter((m) => m.role === "assistant").length;
  const toolCalls = messages
    .filter((m) => m.role === "assistant")
    .reduce((count, msg) => {
      return (
        count +
        msg.parts.filter((p) => p.type === "dynamic-tool" && p.type === "dynamic-tool").length
      );
    }, 0);

  console.log(`\nRaw Data:`);
  console.log(`  - User messages: ${userMessages}`);
  console.log(`  - Assistant messages: ${assistantMessages}`);
  console.log(`  - Tool calls: ${toolCalls}`);
  console.log();
}

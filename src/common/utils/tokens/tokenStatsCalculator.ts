/**
 * Main-process-only token statistics calculation logic
 * Used by backend (debug commands) and worker threads
 *
 * IMPORTANT: This file imports tokenizer and should ONLY be used in main process.
 * For renderer-safe usage utilities, use displayUsage.ts instead.
 */

import type { MuxMessage } from "@/common/types/message";
import type { ProvidersConfigMap } from "@/common/orpc/types";
import { extractToolFilePath } from "@/common/utils/tools/toolInputFilePath";
import type { ChatStats, TokenConsumer } from "@/common/types/chatStats";
import {
  getTokenizerForModel,
  countTokensForData,
  getToolDefinitionTokens,
  type Tokenizer,
} from "@/node/utils/main/tokenizer";
import { resolveModelForMetadata } from "@/common/utils/providers/modelEntries";
import { createDisplayUsage } from "./displayUsage";
import type { ChatUsageDisplay } from "./usageAggregator";

// Re-export for backward compatibility
export { createDisplayUsage };

/**
 * Helper Functions for Token Counting
 * (Exported for testing)
 */

/**
 * Extracts the actual data from nested tool output structure
 * Tool results have nested structure: { type: "json", value: {...} }
 */
export function extractToolOutputData(output: unknown): unknown {
  if (typeof output === "object" && output !== null && "value" in output) {
    return (output as { value: unknown }).value;
  }
  return output;
}

/**
 * Checks if the given data is encrypted web_search results
 */
export function isEncryptedWebSearch(toolName: string, data: unknown): boolean {
  if (toolName !== "web_search" || !Array.isArray(data)) {
    return false;
  }

  return data.some(
    (item: unknown): item is { encryptedContent: string } =>
      item !== null &&
      typeof item === "object" &&
      "encryptedContent" in item &&
      typeof (item as Record<string, unknown>).encryptedContent === "string"
  );
}

/**
 * Calculates tokens for encrypted web_search content using heuristic
 * Encrypted content is base64 encoded and then encrypted/compressed
 * Apply reduction factors:
 * 1. Remove base64 overhead (multiply by 0.75)
 * 2. Apply an estimated token reduction factor of 4
 */
export function countEncryptedWebSearchTokens(data: unknown[]): number {
  let encryptedChars = 0;
  for (const item of data) {
    if (
      item !== null &&
      typeof item === "object" &&
      "encryptedContent" in item &&
      typeof (item as Record<string, unknown>).encryptedContent === "string"
    ) {
      encryptedChars += (item as { encryptedContent: string }).encryptedContent.length;
    }
  }

  // Use heuristic: encrypted chars * 0.75 for token estimation
  return Math.ceil(encryptedChars * 0.75);
}

/**
 * Derive the consumer label for a tool call.
 *
 * Most tools use their tool name as-is. Some tools (like `task`) are a union of
 * multiple behaviors, so we split them into more useful buckets.
 */
export function getConsumerInfoForToolCall(
  toolName: string,
  _input: unknown
): { consumer: string; toolNameForDefinition: string } {
  if (toolName === "task") {
    return {
      consumer: "task",
      toolNameForDefinition: "task",
    };
  }

  return { consumer: toolName, toolNameForDefinition: toolName };
}

/**
 * Counts tokens for tool output, handling special cases like encrypted web_search
 */
async function countToolOutputTokens(
  part: { type: "dynamic-tool"; toolName: string; state: string; output?: unknown },
  tokenizer: Tokenizer
): Promise<number> {
  if (part.state !== "output-available" || !part.output) {
    return 0;
  }

  const outputData = extractToolOutputData(part.output);

  // Special handling for web_search encrypted content
  if (isEncryptedWebSearch(part.toolName, outputData)) {
    return countEncryptedWebSearchTokens(outputData as unknown[]);
  }

  // Normal tool results
  return countTokensForData(outputData, tokenizer);
}

/** Tools that operate on files - canonical input uses `path` (with legacy `file_path` fallback). */
const FILE_PATH_TOOLS = new Set([
  "file_read",
  "file_edit_insert",
  "file_edit_replace_string",
  "file_edit_replace_lines",
]);

/**
 * Extracts file path from tool input for file operations.
 */
function extractFilePathFromToolInput(toolName: string, input: unknown): string | undefined {
  if (!FILE_PATH_TOOLS.has(toolName)) {
    return undefined;
  }

  return extractToolFilePath(input);
}

/**
 * Represents a single token counting operation
 */
export interface TokenCountJob {
  /** Display name / grouping key in the consumer breakdown */
  consumer: string;
  /** Optional tool name used to attribute tool-definition overhead.
   *
   * This lets us split a single tool into multiple consumer buckets
   * (e.g., `task (bash)` vs `task (agent)`) while still counting the
   * *single* tool definition only once.
   */
  toolNameForDefinition?: string;
  /** File path for file operations (file_read, file_edit_*) */
  filePath?: string;
  promise: Promise<number>;
}

/**
 * Creates all token counting jobs from messages
 * Jobs are executed immediately (promises start running)
 */
function createTokenCountingJobs(messages: MuxMessage[], tokenizer: Tokenizer): TokenCountJob[] {
  const jobs: TokenCountJob[] = [];

  for (const message of messages) {
    if (message.role === "user") {
      // User message text - batch all text parts together
      const textParts = message.parts.filter((p) => p.type === "text");
      if (textParts.length > 0) {
        const allText = textParts.map((p) => p.text).join("");
        jobs.push({
          consumer: "User",
          promise: tokenizer.countTokens(allText),
        });
      }
    } else if (message.role === "assistant") {
      // Assistant text parts - batch together
      const textParts = message.parts.filter((p) => p.type === "text");
      if (textParts.length > 0) {
        const allText = textParts.map((p) => p.text).join("");
        jobs.push({
          consumer: "Assistant",
          promise: tokenizer.countTokens(allText),
        });
      }

      // Reasoning parts - batch together
      const reasoningParts = message.parts.filter((p) => p.type === "reasoning");
      if (reasoningParts.length > 0) {
        const allReasoning = reasoningParts.map((p) => p.text).join("");
        jobs.push({
          consumer: "Reasoning",
          promise: tokenizer.countTokens(allReasoning),
        });
      }

      // Tool parts - count arguments and results separately
      for (const part of message.parts) {
        if (part.type === "dynamic-tool") {
          const consumerInfo = getConsumerInfoForToolCall(part.toolName, part.input);
          const filePath = extractFilePathFromToolInput(part.toolName, part.input);

          // Tool arguments
          jobs.push({
            consumer: consumerInfo.consumer,
            toolNameForDefinition: consumerInfo.toolNameForDefinition,
            filePath,
            promise: countTokensForData(part.input, tokenizer),
          });

          // Tool results (if available)
          jobs.push({
            consumer: consumerInfo.consumer,
            toolNameForDefinition: consumerInfo.toolNameForDefinition,
            filePath,
            promise: countToolOutputTokens(part, tokenizer),
          });
        }
      }
    }
  }

  return jobs;
}

/**
 * Collects all unique tool names from messages
 */
export function collectUniqueToolNames(messages: MuxMessage[]): Set<string> {
  const toolNames = new Set<string>();

  for (const message of messages) {
    if (message.role === "assistant") {
      for (const part of message.parts) {
        if (part.type === "dynamic-tool") {
          toolNames.add(part.toolName);
        }
      }
    }
  }

  return toolNames;
}

/**
 * Fetches all tool definitions in parallel
 * Returns a map of tool name to token count
 */
export async function fetchAllToolDefinitions(
  toolNames: Set<string>,
  model: string,
  metadataModelOverride: string | undefined,
  availableToolsOptions: Parameters<typeof getToolDefinitionTokens>[3]
): Promise<Map<string, number>> {
  const entries = await Promise.all(
    Array.from(toolNames).map(async (toolName) => {
      const tokens = await getToolDefinitionTokens(
        toolName,
        model,
        metadataModelOverride,
        availableToolsOptions
      );
      return [toolName, tokens] as const;
    })
  );

  return new Map(entries);
}

/**
 * Metadata that doesn't require async token counting
 */
interface SyncMetadata {
  systemMessageTokens: number;
  usageHistory: ChatUsageDisplay[];
}

/**
 * Extracts synchronous metadata from messages (no token counting needed)
 */
export function extractSyncMetadata(
  messages: MuxMessage[],
  model: string,
  providersConfig: ProvidersConfigMap | null = null
): SyncMetadata {
  let systemMessageTokens = 0;
  const usageHistory: ChatUsageDisplay[] = [];

  for (const message of messages) {
    if (message.role === "assistant") {
      // Accumulate system message tokens
      if (message.metadata?.systemMessageTokens) {
        systemMessageTokens += message.metadata.systemMessageTokens;
      }

      // Store usage history for comparison with estimates
      if (message.metadata?.usage) {
        const runtimeModel = message.metadata.model ?? model; // Use actual model from request
        const metadataModel = resolveModelForMetadata(runtimeModel, providersConfig);
        const usage = createDisplayUsage(
          message.metadata.usage,
          runtimeModel,
          message.metadata.providerMetadata,
          metadataModel
        );
        if (usage) {
          usageHistory.push(usage);
        }
      }
    }
  }

  return { systemMessageTokens, usageHistory };
}

/** Accumulated data for a consumer */
interface ConsumerAccumulator {
  fixed: number;
  variable: number;
  /** File path -> token count (for file operations) */
  filePathTokens: Map<string, number>;
}

/**
 * Merges token counting results into consumer map
 * Adds tool definition tokens only once per tool
 */
export function mergeResults(
  jobs: TokenCountJob[],
  results: number[],
  toolDefinitions: Map<string, number>,
  systemMessageTokens: number
): Map<string, ConsumerAccumulator> {
  const consumerMap = new Map<string, ConsumerAccumulator>();
  const toolsWithDefinitions = new Set<string>();

  // Process all job results
  for (let i = 0; i < jobs.length; i++) {
    const job = jobs[i];
    const tokenCount = results[i];

    if (tokenCount === 0) {
      continue; // Skip empty results
    }

    const existing = consumerMap.get(job.consumer) ?? {
      fixed: 0,
      variable: 0,
      filePathTokens: new Map<string, number>(),
    };

    const toolNameForDefinition = job.toolNameForDefinition ?? job.consumer;

    // Add tool definition tokens if this is the first time we see this tool
    let fixedTokens = existing.fixed;
    if (
      toolDefinitions.has(toolNameForDefinition) &&
      !toolsWithDefinitions.has(toolNameForDefinition)
    ) {
      fixedTokens += toolDefinitions.get(toolNameForDefinition)!;
      toolsWithDefinitions.add(toolNameForDefinition);
    }

    // Add variable tokens
    const variableTokens = existing.variable + tokenCount;

    // Track file path tokens
    if (job.filePath) {
      const existingFileTokens = existing.filePathTokens.get(job.filePath) ?? 0;
      existing.filePathTokens.set(job.filePath, existingFileTokens + tokenCount);
    }

    consumerMap.set(job.consumer, {
      fixed: fixedTokens,
      variable: variableTokens,
      filePathTokens: existing.filePathTokens,
    });
  }

  // Add system message tokens as a consumer if present
  if (systemMessageTokens > 0) {
    consumerMap.set("System", {
      fixed: 0,
      variable: systemMessageTokens,
      filePathTokens: new Map<string, number>(),
    });
  }

  return consumerMap;
}

/**
 * Calculate token statistics from raw XumMessages
 * This is the single source of truth for token counting
 *
 * @param messages - Array of XumMessages from chat history
 * @param model - Model string (e.g., "anthropic:claude-opus-4-1")
 * @returns ChatStats with token breakdown by consumer and usage history
 */
export async function calculateTokenStats(
  messages: MuxMessage[],
  model: string,
  providersConfig: ProvidersConfigMap | null,
  availableToolsOptions: Parameters<typeof getToolDefinitionTokens>[3]
): Promise<ChatStats> {
  if (messages.length === 0) {
    return {
      consumers: [],
      totalTokens: 0,
      model,
      tokenizerName: "No messages",
      usageHistory: [],
    };
  }

  performance.mark("calculateTokenStatsStart");

  const metadataModel = resolveModelForMetadata(model, providersConfig);
  const tokenizer = await getTokenizerForModel(
    model,
    metadataModel !== model ? metadataModel : undefined
  );

  // Phase 1: Fetch all tool definitions in parallel (first await point)
  const toolNames = collectUniqueToolNames(messages);
  const toolDefinitions = await fetchAllToolDefinitions(
    toolNames,
    model,
    metadataModel !== model ? metadataModel : undefined,
    availableToolsOptions
  );

  // Phase 2: Extract sync metadata (no awaits)
  const { systemMessageTokens, usageHistory } = extractSyncMetadata(
    messages,
    model,
    providersConfig
  );

  // Phase 3: Create all token counting jobs (promises start immediately)
  const jobs = createTokenCountingJobs(messages, tokenizer);

  // Phase 4: Execute all jobs in parallel (second await point)
  const results = await Promise.all(jobs.map((j) => j.promise));

  // Phase 5: Merge results (no awaits)
  const consumerMap = mergeResults(jobs, results, toolDefinitions, systemMessageTokens);

  // Calculate total tokens
  const totalTokens = Array.from(consumerMap.values()).reduce(
    (sum, val) => sum + val.fixed + val.variable,
    0
  );

  // Aggregate file paths across all consumers for top-level breakdown
  const aggregatedFilePaths = new Map<string, number>();
  for (const counts of consumerMap.values()) {
    for (const [path, tokens] of counts.filePathTokens) {
      aggregatedFilePaths.set(path, (aggregatedFilePaths.get(path) ?? 0) + tokens);
    }
  }

  // Build top 10 file paths (aggregated across all file tools)
  const topFilePaths =
    aggregatedFilePaths.size > 0
      ? Array.from(aggregatedFilePaths.entries())
          .map(([path, tokens]) => ({ path, tokens }))
          .sort((a, b) => b.tokens - a.tokens)
          .slice(0, 10)
      : undefined;

  // Create sorted consumer array (descending by token count)
  const consumers: TokenConsumer[] = Array.from(consumerMap.entries())
    .map(([name, counts]) => {
      const total = counts.fixed + counts.variable;
      return {
        name,
        tokens: total,
        percentage: totalTokens > 0 ? (total / totalTokens) * 100 : 0,
        fixedTokens: counts.fixed > 0 ? counts.fixed : undefined,
        variableTokens: counts.variable > 0 ? counts.variable : undefined,
      };
    })
    .sort((a, b) => b.tokens - a.tokens);

  return {
    consumers,
    totalTokens,
    model,
    tokenizerName: tokenizer.encoding,
    usageHistory,
    topFilePaths,
  };
}

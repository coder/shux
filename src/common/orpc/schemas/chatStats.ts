import { z } from "zod";

/** Top file path entry for file_read/file_edit consumers */
export const TopFilePathSchema = z.object({
  path: z.string().meta({ description: "File path (relative or absolute)" }),
  tokens: z.number().meta({ description: "Token count for this file" }),
});

export const TokenConsumerSchema = z.object({
  name: z.string().meta({ description: '"User", "Assistant", "bash", "readFile", etc.' }),
  tokens: z.number().meta({ description: "Total token count for this consumer" }),
  percentage: z.number().meta({ description: "% of total tokens" }),
  fixedTokens: z
    .number()
    .optional()
    .meta({ description: "Fixed overhead (e.g., tool definitions)" }),
  variableTokens: z
    .number()
    .optional()
    .meta({ description: "Variable usage (e.g., actual tool calls, text)" }),
});

export const ChatUsageComponentSchema = z.object({
  tokens: z.number(),
  cost_usd: z.number().optional(),
});

export const ChatUsageDisplaySchema = z.object({
  input: ChatUsageComponentSchema,
  cached: ChatUsageComponentSchema,
  cacheCreate: ChatUsageComponentSchema,
  output: ChatUsageComponentSchema,
  reasoning: ChatUsageComponentSchema,
  model: z.string().optional(),
  costsIncluded: z.boolean().optional(),
});

export const ChatStatsSchema = z.object({
  consumers: z.array(TokenConsumerSchema).meta({ description: "Sorted descending by token count" }),
  totalTokens: z.number(),
  model: z.string(),
  tokenizerName: z.string().meta({ description: 'e.g., "o200k_base", "claude"' }),
  usageHistory: z
    .array(ChatUsageDisplaySchema)
    .meta({ description: "Ordered array of actual usage statistics from API responses" }),
  topFilePaths: z
    .array(TopFilePathSchema)
    .optional()
    .meta({ description: "Top 10 files by token count aggregated across all file tools" }),
});

/**
 * Cached token statistics for consumer/file breakdown in the Costs tab.
 *
 * Stored inside session-usage.json to avoid re-tokenizing on every app start.
 */
export const SessionUsageTokenStatsCacheSchema = z.object({
  version: z.literal(1),
  computedAt: z.number().meta({ description: "Unix timestamp (ms) when this cache was computed" }),
  providersConfigVersion: z
    .number()
    .optional()
    .meta({ description: "Stable provider-config fingerprint used for this cache" }),
  model: z
    .string()
    .meta({ description: "Model used for tokenization (affects tokenizer + tool definitions)" }),
  tokenizerName: z.string().meta({ description: 'e.g., "o200k_base", "claude"' }),
  history: z.object({
    messageCount: z.number().meta({ description: "Number of messages used to compute this cache" }),
    maxHistorySequence: z
      .number()
      .optional()
      .meta({ description: "Max MuxMessage.metadata.historySequence seen in the message list" }),
  }),
  consumers: z.array(TokenConsumerSchema).meta({ description: "Sorted descending by token count" }),
  totalTokens: z.number(),
  topFilePaths: z
    .array(TopFilePathSchema)
    .optional()
    .meta({ description: "Top 10 files by token count aggregated across all file tools" }),
});

export const RolledUpChildEntrySchema = z.object({
  totalTokens: z.number(),
  inputTokens: z.number().optional(),
  outputTokens: z.number().optional(),
  reasoningTokens: z.number().optional(),
  cachedTokens: z.number().optional(),
  cacheCreateTokens: z.number().optional(),
  contextTokens: z.number().optional(), // input + cached + cacheCreate (for compaction estimates)
  totalCostUsd: z.number().optional(),
  agentType: z.string().optional(),
  model: z.string().optional(),
  rolledUpAtMs: z.number(),
});
export type RolledUpChildEntry = z.infer<typeof RolledUpChildEntrySchema>;

/**
 * Cumulative session usage file format.
 * Stored in ~/.xum/sessions/{workspaceId}/session-usage.json
 */
export const SessionUsageFileSchema = z.object({
  byModel: z.record(z.string(), ChatUsageDisplaySchema),
  lastRequest: z
    .object({
      model: z.string(),
      usage: ChatUsageDisplaySchema,
      timestamp: z.number(),
    })
    .optional(),
  /**
   * Idempotency ledger for rolled-up sub-agent usage.
   * Key: child workspaceId, value: true (legacy) or enriched roll-up metadata.
   */
  rolledUpFrom: z
    .record(z.string(), z.union([z.literal(true), RolledUpChildEntrySchema]))
    .optional(),
  tokenStatsCache: SessionUsageTokenStatsCacheSchema.optional(),
  version: z.literal(1),
});

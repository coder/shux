import { z } from "zod";

// ── Reusable row schemas (used by both oRPC output AND worker query validation) ──

/** Single row from DuckDB, validated before crossing worker→main boundary */
export const SummaryRowSchema = z.object({
  total_spend_usd: z.number(),
  today_spend_usd: z.number(),
  avg_daily_spend_usd: z.number(),
  cache_hit_ratio: z.number(),
  total_tokens: z.number(),
  total_responses: z.number(),
});
export type SummaryRow = z.infer<typeof SummaryRowSchema>;

export const SpendOverTimeRowSchema = z.object({
  bucket: z.string(),
  model: z.string(),
  cost_usd: z.number(),
});
export type SpendOverTimeRow = z.infer<typeof SpendOverTimeRowSchema>;

export const SpendByProjectRowSchema = z.object({
  project_name: z.string(),
  project_path: z.string(),
  cost_usd: z.number(),
  token_count: z.number(),
});
export type SpendByProjectRow = z.infer<typeof SpendByProjectRowSchema>;

export const SpendByModelRowSchema = z.object({
  model: z.string(),
  cost_usd: z.number(),
  token_count: z.number(),
  response_count: z.number(),
});
export type SpendByModelRow = z.infer<typeof SpendByModelRowSchema>;

export const TokensByModelRowSchema = z.object({
  model: z.string(),
  input_tokens: z.number(),
  cached_tokens: z.number(),
  cache_create_tokens: z.number(),
  output_tokens: z.number(),
  reasoning_tokens: z.number(),
  total_tokens: z.number(),
  request_count: z.number(),
});
export type TokensByModelRow = z.infer<typeof TokensByModelRowSchema>;

export const TimingPercentilesRowSchema = z.object({
  p50: z.number(),
  p90: z.number(),
  p99: z.number(),
});
export type TimingPercentilesRow = z.infer<typeof TimingPercentilesRowSchema>;

export const HistogramBucketSchema = z.object({
  bucket: z.number(),
  count: z.number(),
});
export type HistogramBucket = z.infer<typeof HistogramBucketSchema>;

export const AgentCostRowSchema = z.object({
  agent_id: z.string(),
  cost_usd: z.number(),
  token_count: z.number(),
  response_count: z.number(),
});
export type AgentCostRow = z.infer<typeof AgentCostRowSchema>;

export const ProviderCacheHitModelRowSchema = z.object({
  model: z.string(),
  cached_tokens: z.number(),
  total_prompt_tokens: z.number(),
  response_count: z.number(),
});
export type ProviderCacheHitModelRow = z.infer<typeof ProviderCacheHitModelRowSchema>;

export const DelegationSummaryTotalsRowSchema = z.object({
  total_children: z.number(),
  total_tokens_consumed: z.number(),
  total_report_tokens: z.number(),
  compression_ratio: z.number(),
  total_cost_delegated: z.number(),
});
export type DelegationSummaryTotalsRow = z.infer<typeof DelegationSummaryTotalsRowSchema>;

export const DelegationAgentBreakdownRowSchema = z.object({
  agent_type: z.string(),
  delegation_count: z.number(),
  total_tokens: z.number(),
  input_tokens: z.number(),
  output_tokens: z.number(),
  reasoning_tokens: z.number(),
  cached_tokens: z.number(),
  cache_create_tokens: z.number(),
});
export type DelegationAgentBreakdownRow = z.infer<typeof DelegationAgentBreakdownRowSchema>;

export const AgentTypeTokenBreakdownSchema = z.object({
  agentType: z.string(),
  count: z.number(),
  totalTokens: z.number(),
  inputTokens: z.number(),
  outputTokens: z.number(),
  reasoningTokens: z.number(),
  cachedTokens: z.number(),
  cacheCreateTokens: z.number(),
});

export const SavedQuerySchema = z.object({
  id: z.string(),
  label: z.string(),
  sql: z.string(),
  chartType: z.string().nullable(),
  order: z.number(),
  createdAt: z.string(),
});

export const RawQueryColumnSchema = z.object({
  name: z.string(),
  type: z.string(),
});
export type RawQueryColumn = z.infer<typeof RawQueryColumnSchema>;

export const RawQueryResultSchema = z.object({
  columns: z.array(RawQueryColumnSchema),
  rows: z.array(z.record(z.string(), z.unknown())),
  truncated: z.boolean(),
  rowCount: z.number(),
  rowCountExact: z.boolean(),
  durationMs: z.number(),
});
export type RawQueryResult = z.infer<typeof RawQueryResultSchema>;
/** ETL input validation — each row extracted from chat.jsonl is validated before insert */
export const EventRowSchema = z.object({
  workspace_id: z.string(),
  project_path: z.string().nullable(),
  project_name: z.string().nullable(),
  workspace_name: z.string().nullable(),
  parent_workspace_id: z.string().nullable(),
  agent_id: z.string().nullable(),
  timestamp: z.number().nullable(), // unix ms
  model: z.string().nullable(),
  tool_name: z.string().nullable(),
  thinking_level: z.string().nullable(),
  input_tokens: z.number().default(0),
  output_tokens: z.number().default(0),
  reasoning_tokens: z.number().default(0),
  cached_tokens: z.number().default(0),
  cache_create_tokens: z.number().default(0),
  input_cost_usd: z.number().default(0),
  output_cost_usd: z.number().default(0),
  reasoning_cost_usd: z.number().default(0),
  cached_cost_usd: z.number().default(0),
  total_cost_usd: z.number().default(0),
  duration_ms: z.number().nullable(),
  ttft_ms: z.number().nullable(),
  streaming_ms: z.number().nullable(),
  tool_execution_ms: z.number().nullable(),
  output_tps: z.number().nullable(),
  response_index: z.number().nullable(),
  is_sub_agent: z.boolean().default(false),
  // Refusal-fallback downgrade metadata, populated only on the main turn row
  // (tool_name IS NULL) when the turn was answered by a fallback model.
  requested_model: z.string().nullable().default(null),
  refused_models_json: z.string().nullable().default(null),
});
export type EventRow = z.infer<typeof EventRowSchema>;

// ── oRPC procedure schemas (camelCase for API contract) ──

export const analytics = {
  getSummary: {
    input: z.object({
      projectPath: z.string().nullish(),
      from: z.coerce.date().nullish(),
      to: z.coerce.date().nullish(),
    }),
    output: z.object({
      totalSpendUsd: z.number(),
      todaySpendUsd: z.number(),
      avgDailySpendUsd: z.number(),
      cacheHitRatio: z.number(),
      totalTokens: z.number(),
      totalResponses: z.number(),
    }),
  },
  getSpendOverTime: {
    input: z.object({
      projectPath: z.string().nullish(),
      granularity: z.enum(["hour", "day", "week"]),
      from: z.coerce.date().nullish(),
      to: z.coerce.date().nullish(),
      timeZone: z.string().nullish(),
    }),
    output: z.array(
      z.object({
        bucket: z.string(),
        costUsd: z.number(),
        model: z.string(),
      })
    ),
  },
  getSpendByProject: {
    input: z.object({
      from: z.coerce.date().nullish(),
      to: z.coerce.date().nullish(),
    }),
    output: z.array(
      z.object({
        projectName: z.string(),
        projectPath: z.string(),
        costUsd: z.number(),
        tokenCount: z.number(),
      })
    ),
  },
  getSpendByModel: {
    input: z.object({
      projectPath: z.string().nullish(),
      from: z.coerce.date().nullish(),
      to: z.coerce.date().nullish(),
    }),
    output: z.array(
      z.object({
        model: z.string(),
        costUsd: z.number(),
        tokenCount: z.number(),
        responseCount: z.number(),
      })
    ),
  },
  getTokensByModel: {
    input: z.object({
      projectPath: z.string().nullish(),
      from: z.coerce.date().nullish(),
      to: z.coerce.date().nullish(),
    }),
    output: z.array(
      z.object({
        model: z.string(),
        inputTokens: z.number(),
        cachedTokens: z.number(),
        cacheCreateTokens: z.number(),
        outputTokens: z.number(),
        reasoningTokens: z.number(),
        totalTokens: z.number(),
        requestCount: z.number(),
      })
    ),
  },
  getTimingDistribution: {
    input: z.object({
      metric: z.enum(["ttft", "duration", "tps"]),
      projectPath: z.string().nullish(),
      from: z.coerce.date().nullish(),
      to: z.coerce.date().nullish(),
    }),
    output: z.object({
      p50: z.number(),
      p90: z.number(),
      p99: z.number(),
      histogram: z.array(z.object({ bucket: z.number(), count: z.number() })),
    }),
  },
  getAgentCostBreakdown: {
    input: z.object({
      projectPath: z.string().nullish(),
      from: z.coerce.date().nullish(),
      to: z.coerce.date().nullish(),
    }),
    output: z.array(
      z.object({
        agentId: z.string(),
        costUsd: z.number(),
        tokenCount: z.number(),
        responseCount: z.number(),
      })
    ),
  },
  getCacheHitRatioByProvider: {
    input: z.object({
      projectPath: z.string().nullish(),
      from: z.coerce.date().nullish(),
      to: z.coerce.date().nullish(),
    }),
    output: z.array(
      z.object({
        provider: z.string(),
        cacheHitRatio: z.number(),
        responseCount: z.number(),
      })
    ),
  },
  getDelegationSummary: {
    input: z.object({
      projectPath: z.string().nullish(),
      from: z.coerce.date().nullish(),
      to: z.coerce.date().nullish(),
    }),
    output: z.object({
      totalChildren: z.number(),
      totalTokensConsumed: z.number(),
      totalReportTokens: z.number(),
      compressionRatio: z.number(),
      totalCostDelegated: z.number(),
      byAgentType: z.array(AgentTypeTokenBreakdownSchema),
    }),
  },
  executeRawQuery: {
    input: z.object({
      sql: z.string(),
    }),
    output: RawQueryResultSchema,
  },
  getSavedQueries: {
    input: z.void(),
    output: z.object({ queries: z.array(SavedQuerySchema) }),
  },
  saveQuery: {
    input: z.object({
      label: z.string(),
      sql: z.string(),
      chartType: z.string().nullish(),
    }),
    output: SavedQuerySchema,
  },
  updateSavedQuery: {
    input: z.object({
      id: z.string(),
      label: z.string().nullish(),
      sql: z.string().nullish(),
      chartType: z.string().nullish(),
      order: z.number().nullish(),
    }),
    output: SavedQuerySchema,
  },
  deleteSavedQuery: {
    input: z.object({ id: z.string() }),
    output: z.object({ success: z.boolean() }),
  },
  rebuildDatabase: {
    input: z.object({}),
    output: z.object({ success: z.boolean(), workspacesIngested: z.number() }),
  },
};

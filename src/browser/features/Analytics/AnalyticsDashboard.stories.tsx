/** Analytics dashboard (stats page) story. */

import { APIProvider, type APIClient } from "@/browser/contexts/API";
import { ProjectProvider } from "@/browser/contexts/ProjectContext";
import { RouterProvider } from "@/browser/contexts/RouterContext";
import type {
  AgentCostItem,
  DelegationSummary,
  ProviderCacheHitRatioItem,
  SpendByModelItem,
  SpendByProjectItem,
  SpendOverTimeItem,
  Summary,
  TimingDistribution,
  TokensByModelItem,
} from "@/browser/hooks/useAnalytics";
import { lightweightMeta } from "@/browser/stories/meta.js";
import { NOW, createWorkspace, groupWorkspacesByProject } from "@/browser/stories/mocks/workspaces";
import { createMockORPCClient } from "@/browser/stories/mocks/orpc";
import assert from "@/common/utils/assert";
import type { Meta, StoryObj } from "@storybook/react-vite";
import { userEvent, waitFor, within } from "@storybook/test";
import React from "react";
import { AnalyticsDashboard } from "./AnalyticsDashboard.js";

const meta = {
  ...lightweightMeta,
  title: "Analytics/AnalyticsDashboard",
  component: AnalyticsDashboard,
} satisfies Meta<typeof AnalyticsDashboard>;

export default meta;
type Story = StoryObj<typeof meta>;

const PROJECT_PATHS = {
  atlas: "/home/user/projects/atlas-api",
  orbit: "/home/user/projects/orbit-web",
  docs: "/home/user/projects/docs-site",
} as const;

type AnalyticsProjectPath = (typeof PROJECT_PATHS)[keyof typeof PROJECT_PATHS];
type TimingMetric = "ttft" | "duration" | "tps";

/** Return a UTC ISO date string (YYYY-MM-DD) for N days ago. */
function daysAgo(n: number): string {
  const d = new Date(NOW);
  d.setUTCDate(d.getUTCDate() - n);
  return d.toISOString().split("T")[0];
}

interface StoryAnalyticsNamespace {
  getSummary: (input: { projectPath?: string | null }) => Promise<Summary>;
  getSpendOverTime: (input: {
    projectPath?: string | null;
    granularity: "hour" | "day" | "week";
    from?: Date | null;
    to?: Date | null;
    timeZone?: string | null;
  }) => Promise<SpendOverTimeItem[]>;
  getSpendByProject: (_input: Record<string, never>) => Promise<SpendByProjectItem[]>;
  getSpendByModel: (input: { projectPath?: string | null }) => Promise<SpendByModelItem[]>;
  getTokensByModel: (input: { projectPath?: string | null }) => Promise<TokensByModelItem[]>;
  getTimingDistribution: (input: {
    metric: TimingMetric;
    projectPath?: string | null;
  }) => Promise<TimingDistribution>;
  getAgentCostBreakdown: (input: { projectPath?: string | null }) => Promise<AgentCostItem[]>;
  getCacheHitRatioByProvider: (input: {
    projectPath?: string | null;
    from?: Date | null;
    to?: Date | null;
  }) => Promise<ProviderCacheHitRatioItem[]>;
  getDelegationSummary: (input: {
    projectPath?: string | null;
    from?: Date | null;
    to?: Date | null;
  }) => Promise<DelegationSummary>;
  executeRawQuery: (input: { sql: string }) => Promise<{
    columns: Array<{ name: string; type: string }>;
    rows: Array<Record<string, unknown>>;
    truncated: boolean;
    rowCount: number;
    rowCountExact: boolean;
    durationMs: number;
  }>;
  rebuildDatabase: (_input: Record<string, never>) => Promise<{
    success: boolean;
    workspacesIngested: number;
  }>;
}

interface ScopedSpendOverTimeRow extends SpendOverTimeItem {
  projectPath: AnalyticsProjectPath;
}

interface ScopedSpendByModelRow extends SpendByModelItem {
  projectPath: AnalyticsProjectPath;
}

const KNOWN_PROJECT_PATHS = new Set<AnalyticsProjectPath>(Object.values(PROJECT_PATHS));

const SUMMARY_BY_PROJECT = new Map<AnalyticsProjectPath | null, Summary>([
  [
    null,
    {
      totalSpendUsd: 184.73,
      todaySpendUsd: 6.42,
      avgDailySpendUsd: 4.11,
      cacheHitRatio: 0.43,
      totalTokens: 8_420_000,
      totalResponses: 1_286,
    },
  ],
  [
    PROJECT_PATHS.atlas,
    {
      totalSpendUsd: 91.42,
      todaySpendUsd: 3.24,
      avgDailySpendUsd: 2.98,
      cacheHitRatio: 0.47,
      totalTokens: 4_120_000,
      totalResponses: 602,
    },
  ],
  [
    PROJECT_PATHS.orbit,
    {
      totalSpendUsd: 63.18,
      todaySpendUsd: 2.11,
      avgDailySpendUsd: 2.14,
      cacheHitRatio: 0.41,
      totalTokens: 2_780_000,
      totalResponses: 421,
    },
  ],
  [
    PROJECT_PATHS.docs,
    {
      totalSpendUsd: 30.13,
      todaySpendUsd: 1.07,
      avgDailySpendUsd: 1.05,
      cacheHitRatio: 0.35,
      totalTokens: 1_520_000,
      totalResponses: 263,
    },
  ],
]);

const SPEND_BY_PROJECT: SpendByProjectItem[] = [
  {
    projectName: "atlas-api",
    projectPath: PROJECT_PATHS.atlas,
    costUsd: 91.42,
    tokenCount: 4_120_000,
  },
  {
    projectName: "orbit-web",
    projectPath: PROJECT_PATHS.orbit,
    costUsd: 63.18,
    tokenCount: 2_780_000,
  },
  {
    projectName: "docs-site",
    projectPath: PROJECT_PATHS.docs,
    costUsd: 30.13,
    tokenCount: 1_520_000,
  },
];

const SPEND_BY_MODEL_ROWS: ScopedSpendByModelRow[] = [
  {
    projectPath: PROJECT_PATHS.atlas,
    model: "openai:gpt-5-mini",
    costUsd: 39.6,
    tokenCount: 1_940_000,
    responseCount: 302,
  },
  {
    projectPath: PROJECT_PATHS.atlas,
    model: "anthropic:claude-sonnet-4-20250514",
    costUsd: 29.2,
    tokenCount: 1_300_000,
    responseCount: 196,
  },
  {
    projectPath: PROJECT_PATHS.atlas,
    model: "openai:gpt-4.1",
    costUsd: 22.62,
    tokenCount: 880_000,
    responseCount: 104,
  },
  {
    projectPath: PROJECT_PATHS.orbit,
    model: "anthropic:claude-sonnet-4-20250514",
    costUsd: 26.8,
    tokenCount: 1_140_000,
    responseCount: 161,
  },
  {
    projectPath: PROJECT_PATHS.orbit,
    model: "openai:gpt-5-mini",
    costUsd: 21.9,
    tokenCount: 960_000,
    responseCount: 145,
  },
  {
    projectPath: PROJECT_PATHS.orbit,
    model: "xai:grok-4-fast",
    costUsd: 14.48,
    tokenCount: 680_000,
    responseCount: 115,
  },
  {
    projectPath: PROJECT_PATHS.docs,
    model: "openai:gpt-4.1",
    costUsd: 8.58,
    tokenCount: 620_000,
    responseCount: 97,
  },
  {
    projectPath: PROJECT_PATHS.docs,
    model: "anthropic:claude-sonnet-4-20250514",
    costUsd: 6.9,
    tokenCount: 260_000,
    responseCount: 38,
  },
  {
    projectPath: PROJECT_PATHS.docs,
    model: "xai:grok-4-fast",
    costUsd: 6.05,
    tokenCount: 340_000,
    responseCount: 45,
  },
  {
    projectPath: PROJECT_PATHS.docs,
    model: "openai:gpt-5-mini",
    costUsd: 8.6,
    tokenCount: 300_000,
    responseCount: 83,
  },
];

const TOKENS_BY_MODEL: TokensByModelItem[] = [
  {
    model: "openai:gpt-5-mini",
    inputTokens: 1_320_000,
    cachedTokens: 740_000,
    cacheCreateTokens: 220_000,
    outputTokens: 660_000,
    reasoningTokens: 260_000,
    totalTokens: 3_200_000,
    requestCount: 530,
  },
  {
    model: "anthropic:claude-sonnet-4-20250514",
    inputTokens: 1_020_000,
    cachedTokens: 620_000,
    cacheCreateTokens: 180_000,
    outputTokens: 520_000,
    reasoningTokens: 360_000,
    totalTokens: 2_700_000,
    requestCount: 395,
  },
  {
    model: "openai:gpt-4.1",
    inputTokens: 670_000,
    cachedTokens: 280_000,
    cacheCreateTokens: 90_000,
    outputTokens: 330_000,
    reasoningTokens: 130_000,
    totalTokens: 1_500_000,
    requestCount: 201,
  },
  {
    model: "xai:grok-4-fast",
    inputTokens: 430_000,
    cachedTokens: 210_000,
    cacheCreateTokens: 70_000,
    outputTokens: 220_000,
    reasoningTokens: 90_000,
    totalTokens: 1_020_000,
    requestCount: 160,
  },
];

for (const row of TOKENS_BY_MODEL) {
  const summedTokens =
    row.inputTokens +
    row.cachedTokens +
    row.cacheCreateTokens +
    row.outputTokens +
    row.reasoningTokens;

  assert(
    summedTokens === row.totalTokens,
    `Token breakdown fixture must sum to totalTokens for ${row.model}`
  );
}

const SPEND_OVER_TIME_ROWS: ScopedSpendOverTimeRow[] = [
  {
    projectPath: PROJECT_PATHS.atlas,
    bucket: daysAgo(7),
    model: "openai:gpt-5-mini",
    costUsd: 6.2,
  },
  {
    projectPath: PROJECT_PATHS.atlas,
    bucket: daysAgo(7),
    model: "anthropic:claude-sonnet-4-20250514",
    costUsd: 3.8,
  },
  {
    projectPath: PROJECT_PATHS.atlas,
    bucket: daysAgo(6),
    model: "openai:gpt-5-mini",
    costUsd: 7.1,
  },
  {
    projectPath: PROJECT_PATHS.atlas,
    bucket: daysAgo(6),
    model: "anthropic:claude-sonnet-4-20250514",
    costUsd: 4.4,
  },
  { projectPath: PROJECT_PATHS.atlas, bucket: daysAgo(5), model: "openai:gpt-4.1", costUsd: 2.1 },
  {
    projectPath: PROJECT_PATHS.atlas,
    bucket: daysAgo(4),
    model: "openai:gpt-5-mini",
    costUsd: 6.8,
  },
  {
    projectPath: PROJECT_PATHS.orbit,
    bucket: daysAgo(7),
    model: "anthropic:claude-sonnet-4-20250514",
    costUsd: 4.2,
  },
  {
    projectPath: PROJECT_PATHS.orbit,
    bucket: daysAgo(6),
    model: "openai:gpt-5-mini",
    costUsd: 3.5,
  },
  {
    projectPath: PROJECT_PATHS.orbit,
    bucket: daysAgo(5),
    model: "xai:grok-4-fast",
    costUsd: 2.8,
  },
  { projectPath: PROJECT_PATHS.orbit, bucket: daysAgo(3), model: "openai:gpt-4.1", costUsd: 2.4 },
  {
    projectPath: PROJECT_PATHS.orbit,
    bucket: daysAgo(1),
    model: "openai:gpt-5-mini",
    costUsd: 3.9,
  },
  { projectPath: PROJECT_PATHS.docs, bucket: daysAgo(7), model: "openai:gpt-4.1", costUsd: 1.4 },
  { projectPath: PROJECT_PATHS.docs, bucket: daysAgo(6), model: "xai:grok-4-fast", costUsd: 1.1 },
  {
    projectPath: PROJECT_PATHS.docs,
    bucket: daysAgo(5),
    model: "anthropic:claude-sonnet-4-20250514",
    costUsd: 1.6,
  },
  {
    projectPath: PROJECT_PATHS.docs,
    bucket: daysAgo(4),
    model: "openai:gpt-5-mini",
    costUsd: 1.3,
  },
  { projectPath: PROJECT_PATHS.docs, bucket: daysAgo(3), model: "openai:gpt-4.1", costUsd: 1.2 },
  { projectPath: PROJECT_PATHS.docs, bucket: daysAgo(2), model: "xai:grok-4-fast", costUsd: 1.0 },
  {
    projectPath: PROJECT_PATHS.docs,
    bucket: daysAgo(1),
    model: "anthropic:claude-sonnet-4-20250514",
    costUsd: 1.5,
  },
];

const BASE_TIMING_DISTRIBUTION: Record<TimingMetric, TimingDistribution> = {
  ttft: {
    p50: 390,
    p90: 840,
    p99: 1_450,
    histogram: [
      { bucket: 200, count: 101 },
      { bucket: 350, count: 218 },
      { bucket: 500, count: 179 },
      { bucket: 700, count: 109 },
      { bucket: 1_000, count: 44 },
      { bucket: 1_400, count: 16 },
    ],
  },
  duration: {
    p50: 2_400,
    p90: 6_100,
    p99: 12_900,
    histogram: [
      { bucket: 1_000, count: 88 },
      { bucket: 2_000, count: 196 },
      { bucket: 3_000, count: 152 },
      { bucket: 5_000, count: 104 },
      { bucket: 8_000, count: 51 },
      { bucket: 12_000, count: 19 },
    ],
  },
  tps: {
    p50: 38,
    p90: 82,
    p99: 118,
    histogram: [
      { bucket: 12, count: 23 },
      { bucket: 24, count: 85 },
      { bucket: 36, count: 173 },
      { bucket: 48, count: 158 },
      { bucket: 72, count: 94 },
      { bucket: 108, count: 26 },
    ],
  },
};

const TIMING_SCALING: Record<
  AnalyticsProjectPath,
  { percentileScale: number; countScale: number }
> = {
  [PROJECT_PATHS.atlas]: { percentileScale: 0.92, countScale: 1.15 },
  [PROJECT_PATHS.orbit]: { percentileScale: 1.08, countScale: 0.9 },
  [PROJECT_PATHS.docs]: { percentileScale: 1.18, countScale: 0.58 },
};

const BASE_AGENT_COST_BREAKDOWN: AgentCostItem[] = [
  { agentId: "exec", costUsd: 72.11, tokenCount: 3_010_000, responseCount: 426 },
  { agentId: "plan", costUsd: 38.42, tokenCount: 1_540_000, responseCount: 219 },
  { agentId: "explore", costUsd: 26.71, tokenCount: 1_190_000, responseCount: 178 },
  { agentId: "compact", costUsd: 17.58, tokenCount: 970_000, responseCount: 126 },
  { agentId: "docs", costUsd: 12.95, tokenCount: 710_000, responseCount: 101 },
  { agentId: "research", costUsd: 9.04, tokenCount: 490_000, responseCount: 71 },
  { agentId: "review", costUsd: 7.92, tokenCount: 390_000, responseCount: 57 },
];

const AGENT_SCALING: Record<AnalyticsProjectPath, { costScale: number; tokenScale: number }> = {
  [PROJECT_PATHS.atlas]: { costScale: 0.52, tokenScale: 0.54 },
  [PROJECT_PATHS.orbit]: { costScale: 0.36, tokenScale: 0.35 },
  [PROJECT_PATHS.docs]: { costScale: 0.18, tokenScale: 0.19 },
};

const BASE_PROVIDER_CACHE_HIT_RATIOS: ProviderCacheHitRatioItem[] = [
  { provider: "anthropic", cacheHitRatio: 0.56, responseCount: 512 },
  { provider: "openai", cacheHitRatio: 0.43, responseCount: 463 },
  { provider: "google", cacheHitRatio: 0.37, responseCount: 201 },
  { provider: "unknown", cacheHitRatio: 0.21, responseCount: 110 },
];

const PROVIDER_CACHE_HIT_SCALING: Record<
  AnalyticsProjectPath,
  { ratioScale: number; responseScale: number }
> = {
  [PROJECT_PATHS.atlas]: { ratioScale: 1.06, responseScale: 0.55 },
  [PROJECT_PATHS.orbit]: { ratioScale: 0.94, responseScale: 0.35 },
  [PROJECT_PATHS.docs]: { ratioScale: 0.82, responseScale: 0.2 },
};

const DELEGATION_SUMMARY_BY_PROJECT = new Map<AnalyticsProjectPath | null, DelegationSummary>([
  [
    null,
    {
      totalChildren: 286,
      totalTokensConsumed: 2_710_000,
      totalReportTokens: 296_000,
      compressionRatio: 9.2,
      totalCostDelegated: 58.34,
      byAgentType: [
        {
          agentType: "explore",
          count: 108,
          totalTokens: 870_000,
          inputTokens: 430_000,
          outputTokens: 300_000,
          reasoningTokens: 90_000,
          cachedTokens: 40_000,
          cacheCreateTokens: 10_000,
        },
        {
          agentType: "exec",
          count: 136,
          totalTokens: 1_430_000,
          inputTokens: 700_000,
          outputTokens: 500_000,
          reasoningTokens: 150_000,
          cachedTokens: 60_000,
          cacheCreateTokens: 20_000,
        },
        {
          agentType: "plan",
          count: 42,
          totalTokens: 410_000,
          inputTokens: 210_000,
          outputTokens: 120_000,
          reasoningTokens: 50_000,
          cachedTokens: 20_000,
          cacheCreateTokens: 10_000,
        },
      ],
    },
  ],
  [
    PROJECT_PATHS.atlas,
    {
      totalChildren: 144,
      totalTokensConsumed: 1_410_000,
      totalReportTokens: 150_000,
      compressionRatio: 9.4,
      totalCostDelegated: 31.12,
      byAgentType: [
        {
          agentType: "explore",
          count: 56,
          totalTokens: 440_000,
          inputTokens: 220_000,
          outputTokens: 150_000,
          reasoningTokens: 40_000,
          cachedTokens: 20_000,
          cacheCreateTokens: 10_000,
        },
        {
          agentType: "exec",
          count: 69,
          totalTokens: 760_000,
          inputTokens: 360_000,
          outputTokens: 280_000,
          reasoningTokens: 70_000,
          cachedTokens: 35_000,
          cacheCreateTokens: 15_000,
        },
        {
          agentType: "plan",
          count: 19,
          totalTokens: 210_000,
          inputTokens: 110_000,
          outputTokens: 60_000,
          reasoningTokens: 20_000,
          cachedTokens: 15_000,
          cacheCreateTokens: 5_000,
        },
      ],
    },
  ],
  [
    PROJECT_PATHS.orbit,
    {
      totalChildren: 96,
      totalTokensConsumed: 935_000,
      totalReportTokens: 107_000,
      compressionRatio: 8.7,
      totalCostDelegated: 19.57,
      byAgentType: [
        {
          agentType: "explore",
          count: 33,
          totalTokens: 300_000,
          inputTokens: 150_000,
          outputTokens: 100_000,
          reasoningTokens: 30_000,
          cachedTokens: 15_000,
          cacheCreateTokens: 5_000,
        },
        {
          agentType: "exec",
          count: 48,
          totalTokens: 490_000,
          inputTokens: 240_000,
          outputTokens: 170_000,
          reasoningTokens: 45_000,
          cachedTokens: 25_000,
          cacheCreateTokens: 10_000,
        },
        {
          agentType: "plan",
          count: 15,
          totalTokens: 145_000,
          inputTokens: 70_000,
          outputTokens: 45_000,
          reasoningTokens: 15_000,
          cachedTokens: 10_000,
          cacheCreateTokens: 5_000,
        },
      ],
    },
  ],
  [
    PROJECT_PATHS.docs,
    {
      totalChildren: 46,
      totalTokensConsumed: 365_000,
      totalReportTokens: 39_000,
      compressionRatio: 9.4,
      totalCostDelegated: 7.65,
      byAgentType: [
        {
          agentType: "explore",
          count: 19,
          totalTokens: 130_000,
          inputTokens: 65_000,
          outputTokens: 40_000,
          reasoningTokens: 15_000,
          cachedTokens: 7_000,
          cacheCreateTokens: 3_000,
        },
        {
          agentType: "exec",
          count: 19,
          totalTokens: 180_000,
          inputTokens: 85_000,
          outputTokens: 60_000,
          reasoningTokens: 20_000,
          cachedTokens: 10_000,
          cacheCreateTokens: 5_000,
        },
        {
          agentType: "plan",
          count: 8,
          totalTokens: 55_000,
          inputTokens: 25_000,
          outputTokens: 18_000,
          reasoningTokens: 7_000,
          cachedTokens: 3_000,
          cacheCreateTokens: 2_000,
        },
      ],
    },
  ],
]);

for (const [projectPath, summary] of DELEGATION_SUMMARY_BY_PROJECT.entries()) {
  const childCountByAgentType = summary.byAgentType.reduce(
    (total, breakdown) => total + breakdown.count,
    0
  );
  assert(
    childCountByAgentType === summary.totalChildren,
    `Delegation fixture child counts must sum to totalChildren for ${projectPath ?? "all"}`
  );

  const tokenCountByAgentType = summary.byAgentType.reduce(
    (total, breakdown) => total + breakdown.totalTokens,
    0
  );
  assert(
    tokenCountByAgentType === summary.totalTokensConsumed,
    `Delegation fixture token counts must sum to totalTokensConsumed for ${projectPath ?? "all"}`
  );

  for (const breakdown of summary.byAgentType) {
    const tokenTotal =
      breakdown.inputTokens +
      breakdown.cachedTokens +
      breakdown.cacheCreateTokens +
      breakdown.outputTokens +
      breakdown.reasoningTokens;

    assert(
      tokenTotal === breakdown.totalTokens,
      `Delegation fixture token categories must sum to totalTokens for ${projectPath ?? "all"} (${breakdown.agentType})`
    );
  }

  const expectedCompressionRatio = Number(
    (summary.totalTokensConsumed / Math.max(1, summary.totalReportTokens)).toFixed(1)
  );
  assert(
    Math.abs(summary.compressionRatio - expectedCompressionRatio) <= 0.1,
    `Delegation fixture compressionRatio must match derived ratio for ${projectPath ?? "all"}`
  );
}

function normalizeProjectPath(projectPath: string | null | undefined): AnalyticsProjectPath | null {
  if (projectPath == null) {
    return null;
  }

  assert(
    KNOWN_PROJECT_PATHS.has(projectPath as AnalyticsProjectPath),
    `Unexpected analytics projectPath: ${projectPath}`
  );

  return projectPath as AnalyticsProjectPath;
}

function getSpendOverTimeRows(input: {
  projectPath: AnalyticsProjectPath | null;
  from: Date | null;
  to: Date | null;
}): SpendOverTimeItem[] {
  const rows =
    input.projectPath === null
      ? SPEND_OVER_TIME_ROWS
      : SPEND_OVER_TIME_ROWS.filter((row) => row.projectPath === input.projectPath);

  const aggregatedRows = new Map<string, SpendOverTimeItem>();
  // Skip date-range filtering: story uses deterministic dates from storyTime.ts that predate the component's live 30-day window.
  for (const row of rows) {
    const key = `${row.bucket}|${row.model}`;
    const current = aggregatedRows.get(key);
    if (current) {
      current.costUsd += row.costUsd;
      continue;
    }

    aggregatedRows.set(key, {
      bucket: row.bucket,
      model: row.model,
      costUsd: row.costUsd,
    });
  }

  return Array.from(aggregatedRows.values()).sort((left, right) => {
    if (left.bucket === right.bucket) {
      return left.model.localeCompare(right.model);
    }

    return left.bucket.localeCompare(right.bucket);
  });
}

function getSpendByModelRows(projectPath: AnalyticsProjectPath | null): SpendByModelItem[] {
  const rows =
    projectPath === null
      ? SPEND_BY_MODEL_ROWS
      : SPEND_BY_MODEL_ROWS.filter((row) => row.projectPath === projectPath);

  const byModel = new Map<string, SpendByModelItem>();
  for (const row of rows) {
    const current = byModel.get(row.model);
    if (current) {
      current.costUsd += row.costUsd;
      current.tokenCount += row.tokenCount;
      current.responseCount += row.responseCount;
      continue;
    }

    byModel.set(row.model, {
      model: row.model,
      costUsd: row.costUsd,
      tokenCount: row.tokenCount,
      responseCount: row.responseCount,
    });
  }

  return Array.from(byModel.values()).sort((left, right) => right.costUsd - left.costUsd);
}

function scaleTimingDistribution(
  distribution: TimingDistribution,
  percentileScale: number,
  countScale: number
): TimingDistribution {
  return {
    p50: Math.round(distribution.p50 * percentileScale),
    p90: Math.round(distribution.p90 * percentileScale),
    p99: Math.round(distribution.p99 * percentileScale),
    histogram: distribution.histogram.map((bucket) => ({
      bucket: bucket.bucket,
      count: Math.max(1, Math.round(bucket.count * countScale)),
    })),
  };
}

function getTimingDistribution(
  metric: TimingMetric,
  projectPath: AnalyticsProjectPath | null
): TimingDistribution {
  const base = BASE_TIMING_DISTRIBUTION[metric];
  if (projectPath === null) {
    return base;
  }

  const scaling = TIMING_SCALING[projectPath];
  return scaleTimingDistribution(base, scaling.percentileScale, scaling.countScale);
}

function getAgentCostBreakdown(projectPath: AnalyticsProjectPath | null): AgentCostItem[] {
  if (projectPath === null) {
    return BASE_AGENT_COST_BREAKDOWN;
  }

  const scaling = AGENT_SCALING[projectPath];
  return BASE_AGENT_COST_BREAKDOWN.map((row) => ({
    agentId: row.agentId,
    costUsd: Number((row.costUsd * scaling.costScale).toFixed(2)),
    tokenCount: Math.round(row.tokenCount * scaling.tokenScale),
    responseCount: Math.max(1, Math.round(row.responseCount * scaling.costScale)),
  })).filter((row) => row.costUsd > 1.5);
}

function getProviderCacheHitRatios(
  projectPath: AnalyticsProjectPath | null
): ProviderCacheHitRatioItem[] {
  if (projectPath === null) {
    return BASE_PROVIDER_CACHE_HIT_RATIOS;
  }

  const scaling = PROVIDER_CACHE_HIT_SCALING[projectPath];
  return BASE_PROVIDER_CACHE_HIT_RATIOS.map((row) => ({
    provider: row.provider,
    cacheHitRatio: Math.max(
      0,
      Math.min(0.98, Number((row.cacheHitRatio * scaling.ratioScale).toFixed(3)))
    ),
    responseCount: Math.max(1, Math.round(row.responseCount * scaling.responseScale)),
  })).filter((row) => row.responseCount >= 12);
}

function setupAnalyticsMockClient(): APIClient {
  const workspaces = [
    createWorkspace({
      id: "ws-analytics-atlas",
      name: "feature/observability-rollup",
      projectName: "atlas-api",
      projectPath: PROJECT_PATHS.atlas,
    }),
    createWorkspace({
      id: "ws-analytics-orbit",
      name: "feature/checkout-funnel",
      projectName: "orbit-web",
      projectPath: PROJECT_PATHS.orbit,
    }),
    createWorkspace({
      id: "ws-analytics-docs",
      name: "docs/launch-playbook",
      projectName: "docs-site",
      projectPath: PROJECT_PATHS.docs,
    }),
  ];

  const baseClient = createMockORPCClient({
    projects: groupWorkspacesByProject(workspaces),
    workspaces,
  });

  const analytics: StoryAnalyticsNamespace = {
    getSummary: (input) => {
      const projectPath = normalizeProjectPath(input.projectPath ?? null);
      const summary = SUMMARY_BY_PROJECT.get(projectPath);

      assert(
        summary != null,
        `Missing analytics summary fixture for scope ${projectPath ?? "all"}`
      );
      return Promise.resolve(summary);
    },
    getSpendOverTime: (input) => {
      assert(
        input.granularity === "hour" || input.granularity === "day" || input.granularity === "week",
        `Unsupported granularity for analytics story: ${input.granularity}`
      );

      const projectPath = normalizeProjectPath(input.projectPath ?? null);
      return Promise.resolve(
        getSpendOverTimeRows({
          projectPath,
          from: input.from ?? null,
          to: input.to ?? null,
        })
      );
    },
    getSpendByProject: () => Promise.resolve(SPEND_BY_PROJECT),
    getSpendByModel: (input) => {
      const projectPath = normalizeProjectPath(input.projectPath ?? null);
      return Promise.resolve(getSpendByModelRows(projectPath));
    },
    getTokensByModel: (input) => {
      normalizeProjectPath(input.projectPath ?? null);
      return Promise.resolve(TOKENS_BY_MODEL);
    },
    getTimingDistribution: (input) => {
      const projectPath = normalizeProjectPath(input.projectPath ?? null);
      return Promise.resolve(getTimingDistribution(input.metric, projectPath));
    },
    getAgentCostBreakdown: (input) => {
      const projectPath = normalizeProjectPath(input.projectPath ?? null);
      return Promise.resolve(getAgentCostBreakdown(projectPath));
    },
    getCacheHitRatioByProvider: (input) => {
      const projectPath = normalizeProjectPath(input.projectPath ?? null);
      return Promise.resolve(getProviderCacheHitRatios(projectPath));
    },
    getDelegationSummary: (input) => {
      const projectPath = normalizeProjectPath(input.projectPath ?? null);
      const summary = DELEGATION_SUMMARY_BY_PROJECT.get(projectPath);

      assert(
        summary != null,
        `Missing delegation summary fixture for scope ${projectPath ?? "all"}`
      );

      return Promise.resolve(summary);
    },
    executeRawQuery: (input) => {
      assert(
        typeof input.sql === "string",
        "Analytics raw-query story mock expects SQL text input"
      );

      return Promise.resolve({
        columns: [
          { name: "model", type: "VARCHAR" },
          { name: "total_cost", type: "DOUBLE" },
        ],
        rows: [
          { model: "openai:gpt-5-mini", total_cost: 72.1 },
          { model: "anthropic:claude-sonnet-4-20250514", total_cost: 51.3 },
        ],
        truncated: false,
        rowCount: 2,
        rowCountExact: true,
        durationMs: 12,
      });
    },
    rebuildDatabase: () =>
      Promise.resolve({
        success: true,
        workspacesIngested: workspaces.length,
      }),
  };

  const client = baseClient as Omit<APIClient, "analytics"> & { analytics: unknown };
  client.analytics = analytics;

  return client as APIClient;
}

function AnalyticsDashboardStory() {
  const client = React.useRef(setupAnalyticsMockClient()).current;

  return (
    <APIProvider client={client}>
      <RouterProvider>
        <ProjectProvider>
          <AnalyticsDashboard
            leftSidebarCollapsed={false}
            onToggleLeftSidebarCollapsed={() => {
              /* noop */
            }}
          />
        </ProjectProvider>
      </RouterProvider>
    </APIProvider>
  );
}

export const StatsDashboardPhone: Story = {
  render: () => <AnalyticsDashboardStory />,
  globals: {
    viewport: { value: "mobile1", isRotated: false },
  },
  parameters: {
    pixel: {
      matrix: { themes: ["dark", "light"], viewports: ["phone"] },
    },
  },
  decorators: [
    (Story) => (
      <div
        data-testid="analytics-phone-container"
        style={{ width: 390, height: 844, overflow: "hidden" }}
      >
        <Story />
      </div>
    ),
  ],
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement);
    const container = canvasElement.querySelector('[data-testid="analytics-phone-container"]');
    if (!(container instanceof HTMLElement)) {
      throw new Error("Analytics phone story container not found");
    }

    await canvas.findByText("Total Spend");
    await canvas.findByRole("button", { name: "Local" });
    await canvas.findByRole("button", { name: "UTC" });
    await canvas.findByRole("button", { name: "7D" });
    await canvas.findByRole("button", { name: "All" });

    await new Promise<void>((resolve) =>
      requestAnimationFrame(() => requestAnimationFrame(() => resolve()))
    );
    if (container.scrollWidth > container.clientWidth + 1) {
      throw new Error(
        `Analytics header overflowed its ${container.clientWidth}px container by ` +
          `${container.scrollWidth - container.clientWidth}px`
      );
    }
  },
};

export const StatsDashboard: Story = {
  render: () => <AnalyticsDashboardStory />,
  play: async ({ canvasElement }: { canvasElement: HTMLElement }) => {
    const canvas = within(canvasElement);

    await canvas.findByText("Total Spend");
    await canvas.findByText("$184.73");

    const localTimeButton = await canvas.findByRole("button", { name: "Local" });
    const utcButton = await canvas.findByRole("button", { name: "UTC" });
    if (localTimeButton.getAttribute("aria-pressed") !== "true") {
      await userEvent.click(localTimeButton);
      await waitFor(() => {
        if (localTimeButton.getAttribute("aria-pressed") !== "true") {
          throw new Error("Expected local timezone mode to become selected");
        }
      });
    }

    await userEvent.click(utcButton);
    await waitFor(() => {
      if (utcButton.getAttribute("aria-pressed") !== "true") {
        throw new Error("Expected UTC timezone mode to become selected");
      }
    });

    await canvas.findByRole("heading", { name: /spend over time/i });
    await canvas.findByRole("heading", { name: /spend by project/i });
    await canvas.findByRole("heading", { name: /spend by model/i });
    await canvas.findByRole("heading", { name: /timing distribution/i });
    await canvas.findByRole("heading", { name: /cache hit ratio by provider/i });
    await canvas.findByRole("heading", { name: /agent cost breakdown/i });

    await waitFor(() => {
      if (canvas.queryByText(/No spend data for the selected filters/i)) {
        throw new Error("Expected spend-over-time chart to render populated data");
      }

      if (canvas.queryByText(/No project spend data yet/i)) {
        throw new Error("Expected spend-by-project chart to render populated data");
      }

      if (canvas.queryByText(/No model spend data yet/i)) {
        throw new Error("Expected spend-by-model chart to render populated data");
      }

      if (canvas.queryByText(/No timing data available yet/i)) {
        throw new Error("Expected timing distribution chart to render populated data");
      }

      if (canvas.queryByText(/No provider cache hit data available/i)) {
        throw new Error("Expected provider cache-hit chart to render populated data");
      }

      if (canvas.queryByText(/No agent-level spend data available/i)) {
        throw new Error("Expected agent-cost chart to render populated data");
      }
    });
  },
};

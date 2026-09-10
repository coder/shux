import assert from "node:assert/strict";
import { afterEach, describe, expect, test } from "bun:test";
import { DuckDBInstance, type DuckDBConnection } from "@duckdb/node-api";
import { z } from "zod";
import {
  HistogramBucketSchema,
  SpendByModelRowSchema,
  SpendOverTimeRowSchema,
  SummaryRowSchema,
  TimingPercentilesRowSchema,
  TokensByModelRowSchema,
} from "@/common/orpc/schemas/analytics";
import { executeNamedQuery } from "./queries";
import { CREATE_EVENTS_TABLE_SQL } from "./schemaSql";

const duckDbHandlesToClose: Array<{ instance: DuckDBInstance; conn: DuckDBConnection }> = [];

interface EventSeed {
  workspaceId: string;
  date: string;
  timestamp: number | bigint;
  model: string;
  toolName?: string | null;
  inputTokens: number;
  outputTokens: number;
  reasoningTokens?: number;
  cachedTokens?: number;
  cacheCreateTokens?: number;
  totalCostUsd: number;
  durationMs?: number | null;
  ttftMs?: number | null;
  outputTps?: number | null;
}

async function createTestConn(): Promise<DuckDBConnection> {
  const instance = await DuckDBInstance.create(":memory:");
  const conn = await instance.connect();
  duckDbHandlesToClose.push({ instance, conn });

  await conn.run(CREATE_EVENTS_TABLE_SQL);
  await conn.run("ALTER TABLE events ADD COLUMN IF NOT EXISTS tool_name VARCHAR");

  return conn;
}

async function insertEvent(conn: DuckDBConnection, seed: EventSeed): Promise<void> {
  await conn.run(
    `INSERT INTO events (
      workspace_id,
      date,
      timestamp,
      model,
      tool_name,
      input_tokens,
      output_tokens,
      reasoning_tokens,
      cached_tokens,
      cache_create_tokens,
      total_cost_usd,
      duration_ms,
      ttft_ms,
      output_tps,
      is_sub_agent
    ) VALUES (
      ?, CAST(? AS DATE), ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?
    )`,
    [
      seed.workspaceId,
      seed.date,
      seed.timestamp,
      seed.model,
      seed.toolName ?? null,
      seed.inputTokens,
      seed.outputTokens,
      seed.reasoningTokens ?? 0,
      seed.cachedTokens ?? 0,
      seed.cacheCreateTokens ?? 0,
      seed.totalCostUsd,
      seed.durationMs ?? null,
      seed.ttftMs ?? null,
      seed.outputTps ?? null,
      false,
    ]
  );
}

afterEach(() => {
  for (const { conn, instance } of duckDbHandlesToClose.splice(0).reverse()) {
    try {
      conn.closeSync();
    } catch {
      // Ignore close failures in test cleanup.
    }

    try {
      instance.closeSync();
    } catch {
      // Ignore close failures in test cleanup.
    }
  }
});

describe("analytics queries", () => {
  test("includes tool rows in spend and token totals while excluding them from response counts and timing", async () => {
    const conn = await createTestConn();
    const workspaceId = "ws-tool-query-analytics";
    const date = "2026-04-20";

    await insertEvent(conn, {
      workspaceId,
      date,
      timestamp: 1,
      model: "openai:gpt-4",
      inputTokens: 10,
      outputTokens: 5,
      totalCostUsd: 1,
      durationMs: 100,
      ttftMs: 20,
      outputTps: 50,
    });
    await insertEvent(conn, {
      workspaceId,
      date,
      timestamp: 2,
      model: "openai:gpt-4",
      toolName: "bash",
      inputTokens: 3,
      outputTokens: 2,
      totalCostUsd: 0.2,
      durationMs: 900,
      ttftMs: 500,
      outputTps: 2,
    });
    await insertEvent(conn, {
      workspaceId,
      date,
      timestamp: 3,
      model: "anthropic:claude-sonnet-4-20250514",
      inputTokens: 20,
      outputTokens: 10,
      totalCostUsd: 2,
      durationMs: 300,
      ttftMs: 60,
      outputTps: 100 / 3,
    });
    await insertEvent(conn, {
      workspaceId,
      date,
      timestamp: 4,
      model: "anthropic:claude-opus-4-20250514",
      toolName: "advisor",
      inputTokens: 7,
      outputTokens: 1,
      totalCostUsd: 0.7,
      durationMs: 1_200,
      ttftMs: 800,
      outputTps: 0.5,
    });

    const summary = SummaryRowSchema.parse(await executeNamedQuery(conn, "getSummary", {}));
    expect(summary.total_spend_usd).toBeCloseTo(3.9, 12);
    expect(summary.total_tokens).toBe(58);
    expect(summary.total_responses).toBe(2);

    const spendByModel = z
      .array(SpendByModelRowSchema)
      .parse(await executeNamedQuery(conn, "getSpendByModel", {}));
    const spendByModelMap = new Map(spendByModel.map((row) => [row.model, row]));
    expect(spendByModelMap.get("openai:gpt-4")).toMatchObject({
      cost_usd: 1.2,
      token_count: 20,
      response_count: 1,
    });
    expect(spendByModelMap.get("anthropic:claude-sonnet-4-20250514")).toMatchObject({
      cost_usd: 2,
      token_count: 30,
      response_count: 1,
    });
    expect(spendByModelMap.get("anthropic:claude-opus-4-20250514")).toMatchObject({
      cost_usd: 0.7,
      token_count: 8,
      response_count: 0,
    });

    const tokensByModel = z
      .array(TokensByModelRowSchema)
      .parse(await executeNamedQuery(conn, "getTokensByModel", {}));
    const tokensByModelMap = new Map(tokensByModel.map((row) => [row.model, row]));
    expect(tokensByModelMap.get("openai:gpt-4")).toMatchObject({
      total_tokens: 20,
      request_count: 1,
    });
    expect(tokensByModelMap.get("anthropic:claude-sonnet-4-20250514")).toMatchObject({
      total_tokens: 30,
      request_count: 1,
    });
    expect(tokensByModelMap.get("anthropic:claude-opus-4-20250514")).toMatchObject({
      total_tokens: 8,
      request_count: 0,
    });

    const timing = z
      .object({
        percentiles: TimingPercentilesRowSchema,
        histogram: z.array(HistogramBucketSchema),
      })
      .parse(await executeNamedQuery(conn, "getTimingDistribution", { metric: "duration" }));
    expect(timing.percentiles.p50).toBeCloseTo(200, 12);

    const histogramCount = timing.histogram.reduce((sum, bucket) => {
      return sum + bucket.count;
    }, 0);
    assert(Number.isInteger(histogramCount), "histogramCount should remain integral");
    expect(histogramCount).toBe(2);
  });
});

describe("spend over time timezone buckets", () => {
  test("uses the selected timezone for daily buckets and date filters", async () => {
    const conn = await createTestConn();
    const workspaceId = "ws-timezone-boundary";

    await insertEvent(conn, {
      workspaceId,
      date: "2026-08-12",
      timestamp: BigInt(Date.parse("2026-08-12T03:30:00.000Z")),
      model: "openai:gpt-4",
      inputTokens: 1,
      outputTokens: 1,
      totalCostUsd: 100,
    });
    await insertEvent(conn, {
      workspaceId,
      date: "2026-08-12",
      timestamp: BigInt(Date.parse("2026-08-12T05:30:00.000Z")),
      model: "openai:gpt-4",
      inputTokens: 1,
      outputTokens: 1,
      totalCostUsd: 200,
    });

    const rows = z.array(SpendOverTimeRowSchema).parse(
      await executeNamedQuery(conn, "getSpendOverTime", {
        granularity: "day",
        from: "2026-08-11",
        to: "2026-08-11",
        timeZone: "America/New_York",
      })
    );

    expect(rows).toEqual([
      {
        bucket: "2026-08-11",
        model: "openai:gpt-4",
        cost_usd: 100,
      },
    ]);
  });

  test("uses UTC when the timezone is omitted", async () => {
    const conn = await createTestConn();
    const workspaceId = "ws-timezone-default";

    await insertEvent(conn, {
      workspaceId,
      date: "2026-08-12",
      timestamp: BigInt(Date.parse("2026-08-12T03:30:00.000Z")),
      model: "openai:gpt-4",
      inputTokens: 1,
      outputTokens: 1,
      totalCostUsd: 100,
    });

    const rows = z.array(SpendOverTimeRowSchema).parse(
      await executeNamedQuery(conn, "getSpendOverTime", {
        granularity: "day",
        timeZone: "UTC",
      })
    );

    expect(rows).toEqual([
      {
        bucket: "2026-08-12",
        model: "openai:gpt-4",
        cost_usd: 100,
      },
    ]);
  });
});

import assert from "node:assert/strict";
import type { DuckDBConnection, DuckDBValue } from "@duckdb/node-api";
import type { z } from "zod";
import {
  AgentCostRowSchema,
  DelegationAgentBreakdownRowSchema,
  DelegationSummaryTotalsRowSchema,
  HistogramBucketSchema,
  ProviderCacheHitModelRowSchema,
  SpendByModelRowSchema,
  SpendByProjectRowSchema,
  SpendOverTimeRowSchema,
  SummaryRowSchema,
  TimingPercentilesRowSchema,
  TokensByModelRowSchema,
  type AgentCostRow,
  type DelegationAgentBreakdownRow,
  type DelegationSummaryTotalsRow,
  type HistogramBucket,
  type ProviderCacheHitModelRow,
  type SpendByModelRow,
  type SpendByProjectRow,
  type SpendOverTimeRow,
  type SummaryRow,
  type TimingPercentilesRow,
  type TokensByModelRow,
} from "@/common/orpc/schemas/analytics";
import { toUtcDateString } from "@/node/services/analytics/dateUtils";

const MAX_SAFE_BIGINT = BigInt(Number.MAX_SAFE_INTEGER);
const MIN_SAFE_BIGINT = BigInt(Number.MIN_SAFE_INTEGER);

type Granularity = "hour" | "day" | "week";
type TimingMetric = "ttft" | "duration" | "tps";

const NON_TOOL_EVENTS_PREDICATE = "tool_name IS NULL";

interface TimingDistributionResult {
  percentiles: TimingPercentilesRow;
  histogram: HistogramBucket[];
}

interface DelegationSummaryResult {
  totals: DelegationSummaryTotalsRow;
  breakdown: DelegationAgentBreakdownRow[];
}

function normalizeDuckDbValue(value: unknown): unknown {
  if (typeof value === "bigint") {
    assert(
      value <= MAX_SAFE_BIGINT && value >= MIN_SAFE_BIGINT,
      `DuckDB bigint out of JS safe integer range: ${value}`
    );
    return Number(value);
  }

  if (value instanceof Date) {
    return value.toISOString();
  }

  return value;
}

function normalizeDuckDbRow(row: Record<string, unknown>): Record<string, unknown> {
  const normalized: Record<string, unknown> = {};

  for (const [key, value] of Object.entries(row)) {
    normalized[key] = normalizeDuckDbValue(value);
  }

  return normalized;
}

async function typedQuery<T>(
  conn: DuckDBConnection,
  sql: string,
  params: DuckDBValue[],
  schema: z.ZodType<T>
): Promise<T[]> {
  const result = await conn.run(sql, params);
  const rows = await result.getRowObjectsJS();

  return rows.map((row) => schema.parse(normalizeDuckDbRow(row)));
}

async function typedQueryOne<T>(
  conn: DuckDBConnection,
  sql: string,
  params: DuckDBValue[],
  schema: z.ZodType<T>
): Promise<T> {
  const rows = await typedQuery(conn, sql, params, schema);
  assert(rows.length === 1, `Expected one row, got ${rows.length}`);
  return rows[0];
}

function parseOptionalString(value: unknown): string | null {
  if (typeof value !== "string") {
    return null;
  }

  const trimmed = value.trim();
  return trimmed.length > 0 ? trimmed : null;
}

function parseDateFilter(value: unknown): string | null {
  if (value === null || value === undefined) {
    return null;
  }

  if (value instanceof Date) {
    assert(Number.isFinite(value.getTime()), "Invalid Date provided for analytics filter");
    return toUtcDateString(value);
  }

  if (typeof value === "string") {
    const trimmed = value.trim();
    if (!trimmed) {
      return null;
    }

    // Accept either full ISO timestamps or YYYY-MM-DD and normalize to YYYY-MM-DD.
    const parsed = new Date(trimmed);
    assert(Number.isFinite(parsed.getTime()), `Invalid date filter value: ${trimmed}`);
    return toUtcDateString(parsed);
  }

  throw new Error("Unsupported analytics date filter type");
}

function parseGranularity(value: unknown): Granularity {
  assert(
    value === "hour" || value === "day" || value === "week",
    `Invalid granularity: ${String(value)}`
  );
  return value;
}

function parseTimeZone(value: unknown): string {
  if (value == null) {
    return "UTC";
  }

  assert(typeof value === "string", "Analytics timeZone must be a string");
  const timeZone = value.trim();
  assert(timeZone.length > 0, "Analytics timeZone must not be empty");

  try {
    new Intl.DateTimeFormat("en-US", { timeZone }).format();
  } catch {
    throw new Error(`Invalid analytics timeZone: ${timeZone}`);
  }

  return timeZone;
}

function parseTimingMetric(value: unknown): TimingMetric {
  assert(
    value === "ttft" || value === "duration" || value === "tps",
    `Invalid timing metric: ${String(value)}`
  );
  return value;
}

function getTodayUtcDateString(now: Date = new Date()): string {
  assert(Number.isFinite(now.getTime()), "Invalid Date while computing analytics summary date");
  return toUtcDateString(now);
}

async function querySummary(
  conn: DuckDBConnection,
  params: {
    projectPath: string | null;
    from: string | null;
    to: string | null;
  }
): Promise<SummaryRow> {
  // events.date is derived from message timestamps via UTC date buckets, so
  // summary "today" must use a UTC date key instead of DuckDB local CURRENT_DATE.
  const todayUtcDate = getTodayUtcDateString();

  return typedQueryOne(
    conn,
    `
    SELECT
      COALESCE(SUM(total_cost_usd), 0) AS total_spend_usd,
      COALESCE(SUM(CASE WHEN date = CAST(? AS DATE) THEN total_cost_usd ELSE 0 END), 0) AS today_spend_usd,
      COALESCE(
        COALESCE(SUM(total_cost_usd), 0) / NULLIF(COUNT(DISTINCT date), 0),
        0
      ) AS avg_daily_spend_usd,
      COALESCE(
        SUM(cached_tokens)::DOUBLE / NULLIF(SUM(input_tokens + cached_tokens + cache_create_tokens), 0),
        0
      ) AS cache_hit_ratio,
      COALESCE(
        SUM(input_tokens + output_tokens + reasoning_tokens + cached_tokens + cache_create_tokens),
        0
      ) AS total_tokens,
      COALESCE(COUNT(*) FILTER (WHERE ${NON_TOOL_EVENTS_PREDICATE}), 0) AS total_responses
    FROM events
    WHERE (? IS NULL OR project_path = ?)
      AND (? IS NULL OR date >= CAST(? AS DATE))
      AND (? IS NULL OR date <= CAST(? AS DATE))
    `,
    [
      todayUtcDate,
      params.projectPath,
      params.projectPath,
      params.from,
      params.from,
      params.to,
      params.to,
    ],
    SummaryRowSchema
  );
}

async function querySpendOverTime(
  conn: DuckDBConnection,
  params: {
    granularity: Granularity;
    projectPath: string | null;
    from: string | null;
    to: string | null;
    timeZone: string;
  }
): Promise<SpendOverTimeRow[]> {
  const bucketExpression: Record<Granularity, string> = {
    hour: "DATE_TRUNC('hour', localized_timestamp)",
    day: "CAST(calendar_date AS DATE)",
    week: "CAST(DATE_TRUNC('week', calendar_date) AS DATE)",
  };

  const bucketExpr = bucketExpression[params.granularity];
  const bucketNullFilter =
    params.granularity === "hour"
      ? "AND localized_timestamp IS NOT NULL"
      : "AND calendar_date IS NOT NULL";

  return typedQuery(
    conn,
    `
    WITH event_times AS (
      SELECT
        events.*,
        CASE
          WHEN timestamp IS NOT NULL THEN timezone(?, to_timestamp(timestamp / 1000.0))
          ELSE NULL
        END AS localized_timestamp
      FROM events
    ), localized_events AS (
      SELECT
        event_times.*,
        COALESCE(CAST(localized_timestamp AS DATE), date) AS calendar_date
      FROM event_times
    )
    SELECT
      CAST(${bucketExpr} AS VARCHAR) AS bucket,
      COALESCE(model, 'unknown') AS model,
      COALESCE(SUM(total_cost_usd), 0) AS cost_usd
    FROM localized_events
    WHERE
      (? IS NULL OR project_path = ?)
      AND (? IS NULL OR calendar_date >= CAST(? AS DATE))
      AND (? IS NULL OR calendar_date <= CAST(? AS DATE))
      ${bucketNullFilter}
    GROUP BY 1, 2
    ORDER BY 1 ASC, 2 ASC
    `,
    [
      params.timeZone,
      params.projectPath,
      params.projectPath,
      params.from,
      params.from,
      params.to,
      params.to,
    ],
    SpendOverTimeRowSchema
  );
}

async function querySpendByProject(
  conn: DuckDBConnection,
  params: { from: string | null; to: string | null }
): Promise<SpendByProjectRow[]> {
  return typedQuery(
    conn,
    `
    SELECT
      COALESCE(project_name, 'unknown') AS project_name,
      COALESCE(project_path, 'unknown') AS project_path,
      COALESCE(SUM(total_cost_usd), 0) AS cost_usd,
      COALESCE(
        SUM(input_tokens + output_tokens + reasoning_tokens + cached_tokens + cache_create_tokens),
        0
      ) AS token_count
    FROM events
    WHERE (? IS NULL OR date >= CAST(? AS DATE))
      AND (? IS NULL OR date <= CAST(? AS DATE))
    GROUP BY 1, 2
    ORDER BY cost_usd DESC
    `,
    [params.from, params.from, params.to, params.to],
    SpendByProjectRowSchema
  );
}

async function querySpendByModel(
  conn: DuckDBConnection,
  projectPath: string | null,
  from: string | null,
  to: string | null
): Promise<SpendByModelRow[]> {
  return typedQuery(
    conn,
    `
    SELECT
      COALESCE(model, 'unknown') AS model,
      COALESCE(SUM(total_cost_usd), 0) AS cost_usd,
      COALESCE(
        SUM(input_tokens + output_tokens + reasoning_tokens + cached_tokens + cache_create_tokens),
        0
      ) AS token_count,
      COALESCE(COUNT(*) FILTER (WHERE ${NON_TOOL_EVENTS_PREDICATE}), 0) AS response_count
    FROM events
    WHERE (? IS NULL OR project_path = ?)
      AND (? IS NULL OR date >= CAST(? AS DATE))
      AND (? IS NULL OR date <= CAST(? AS DATE))
    GROUP BY 1
    ORDER BY cost_usd DESC
    `,
    [projectPath, projectPath, from, from, to, to],
    SpendByModelRowSchema
  );
}

async function queryTokensByModel(
  conn: DuckDBConnection,
  projectPath: string | null,
  from: string | null,
  to: string | null
): Promise<TokensByModelRow[]> {
  return typedQuery(
    conn,
    `
    SELECT
      COALESCE(model, 'unknown') AS model,
      COALESCE(SUM(input_tokens), 0) AS input_tokens,
      COALESCE(SUM(cached_tokens), 0) AS cached_tokens,
      COALESCE(SUM(cache_create_tokens), 0) AS cache_create_tokens,
      COALESCE(SUM(output_tokens), 0) AS output_tokens,
      COALESCE(SUM(reasoning_tokens), 0) AS reasoning_tokens,
      COALESCE(SUM(
        COALESCE(input_tokens, 0) + COALESCE(cached_tokens, 0) + COALESCE(cache_create_tokens, 0)
        + COALESCE(output_tokens, 0) + COALESCE(reasoning_tokens, 0)
      ), 0) AS total_tokens,
      COALESCE(COUNT(*) FILTER (WHERE ${NON_TOOL_EVENTS_PREDICATE}), 0) AS request_count
    FROM events
    WHERE (? IS NULL OR project_path = ?)
      AND (? IS NULL OR date >= CAST(? AS DATE))
      AND (? IS NULL OR date <= CAST(? AS DATE))
    GROUP BY 1
    ORDER BY total_tokens DESC
    LIMIT 10
    `,
    [projectPath, projectPath, from, from, to, to],
    TokensByModelRowSchema
  );
}

async function queryTimingDistribution(
  conn: DuckDBConnection,
  metric: TimingMetric,
  projectPath: string | null,
  from: string | null,
  to: string | null
): Promise<TimingDistributionResult> {
  const columnByMetric: Record<TimingMetric, string> = {
    ttft: "ttft_ms",
    duration: "duration_ms",
    tps: "output_tps",
  };

  const column = columnByMetric[metric];

  const percentiles = await typedQueryOne(
    conn,
    `
    SELECT
      COALESCE(PERCENTILE_CONT(0.5) WITHIN GROUP (ORDER BY ${column}), 0) AS p50,
      COALESCE(PERCENTILE_CONT(0.9) WITHIN GROUP (ORDER BY ${column}), 0) AS p90,
      COALESCE(PERCENTILE_CONT(0.99) WITHIN GROUP (ORDER BY ${column}), 0) AS p99
    FROM events
    WHERE ${column} IS NOT NULL
      AND ${NON_TOOL_EVENTS_PREDICATE}
      AND (? IS NULL OR project_path = ?)
      AND (? IS NULL OR date >= CAST(? AS DATE))
      AND (? IS NULL OR date <= CAST(? AS DATE))
    `,
    [projectPath, projectPath, from, from, to, to],
    TimingPercentilesRowSchema
  );

  // Histogram emits real metric values (e.g. ms, tok/s) as bucket labels,
  // not abstract 1..20 indices. This way the chart x-axis maps directly to
  // meaningful units and percentile reference lines land correctly.
  //
  // Cap the histogram range at p99 so a single extreme outlier does not flatten
  // the distribution for the other 99% of responses. If p99 collapses to min
  // (for near-constant datasets), fall back to raw max to preserve bucket spread.
  const histogram = await typedQuery(
    conn,
    `
    WITH raw_stats AS (
      SELECT
        MIN(${column}) AS min_value,
        PERCENTILE_CONT(0.99) WITHIN GROUP (ORDER BY ${column}) AS p99_value,
        MAX(${column}) AS raw_max_value
      FROM events
      WHERE ${column} IS NOT NULL
        AND ${NON_TOOL_EVENTS_PREDICATE}
        AND (? IS NULL OR project_path = ?)
        AND (? IS NULL OR date >= CAST(? AS DATE))
        AND (? IS NULL OR date <= CAST(? AS DATE))
    ),
    stats AS (
      SELECT
        min_value,
        CASE
          -- If p99 collapses to the minimum (e.g. >99% identical values),
          -- fall back to the raw max so outliers do not get forced into bucket 1.
          WHEN p99_value = min_value AND raw_max_value > p99_value THEN raw_max_value
          ELSE p99_value
        END AS max_value
      FROM raw_stats
    ),
    bucketed AS (
      SELECT
        CASE
          WHEN stats.min_value IS NULL OR stats.max_value IS NULL THEN NULL
          WHEN stats.max_value = stats.min_value THEN 1
          ELSE LEAST(
            20,
            GREATEST(
              1,
              CAST(
                FLOOR(
                  ((events.${column} - stats.min_value) / NULLIF(stats.max_value - stats.min_value, 0)) * 20
                ) AS INTEGER
              ) + 1
            )
          )
        END AS bucket_id
      FROM events
      CROSS JOIN stats
      WHERE events.${column} IS NOT NULL
        AND ${NON_TOOL_EVENTS_PREDICATE}
        AND (? IS NULL OR events.project_path = ?)
        AND (? IS NULL OR events.date >= CAST(? AS DATE))
        AND (? IS NULL OR events.date <= CAST(? AS DATE))
    )
    SELECT
      COALESCE(
        ROUND(
          (SELECT min_value FROM stats) +
          (bucket_id - 0.5) * (
            NULLIF((SELECT max_value FROM stats) - (SELECT min_value FROM stats), 0) / 20.0
          ),
          2
        ),
        -- When min == max (single distinct value), NULLIF produces NULL.
        -- Fall back to the actual value so the bucket label is meaningful.
        ROUND((SELECT min_value FROM stats), 2)
      ) AS bucket,
      COUNT(*) AS count
    FROM bucketed
    WHERE bucket_id IS NOT NULL
    GROUP BY bucket_id
    ORDER BY bucket_id
    `,
    [projectPath, projectPath, from, from, to, to, projectPath, projectPath, from, from, to, to],
    HistogramBucketSchema
  );

  return {
    percentiles,
    histogram,
  };
}

async function queryAgentCostBreakdown(
  conn: DuckDBConnection,
  projectPath: string | null,
  from: string | null,
  to: string | null
): Promise<AgentCostRow[]> {
  return typedQuery(
    conn,
    `
    SELECT
      COALESCE(agent_id, 'unknown') AS agent_id,
      COALESCE(SUM(total_cost_usd), 0) AS cost_usd,
      COALESCE(
        SUM(input_tokens + output_tokens + reasoning_tokens + cached_tokens + cache_create_tokens),
        0
      ) AS token_count,
      COALESCE(COUNT(*) FILTER (WHERE ${NON_TOOL_EVENTS_PREDICATE}), 0) AS response_count
    FROM events
    WHERE (? IS NULL OR project_path = ?)
      AND (? IS NULL OR date >= CAST(? AS DATE))
      AND (? IS NULL OR date <= CAST(? AS DATE))
    GROUP BY 1
    ORDER BY cost_usd DESC
    `,
    [projectPath, projectPath, from, from, to, to],
    AgentCostRowSchema
  );
}

async function queryCacheHitRatioByProvider(
  conn: DuckDBConnection,
  projectPath: string | null,
  from: string | null,
  to: string | null
): Promise<ProviderCacheHitModelRow[]> {
  return typedQuery(
    conn,
    `
    SELECT
      COALESCE(model, 'unknown') AS model,
      COALESCE(SUM(cached_tokens), 0) AS cached_tokens,
      COALESCE(SUM(input_tokens + cached_tokens + cache_create_tokens), 0) AS total_prompt_tokens,
      COALESCE(COUNT(*) FILTER (WHERE ${NON_TOOL_EVENTS_PREDICATE}), 0) AS response_count
    FROM events
    WHERE (? IS NULL OR project_path = ?)
      AND (? IS NULL OR date >= CAST(? AS DATE))
      AND (? IS NULL OR date <= CAST(? AS DATE))
    GROUP BY 1
    ORDER BY response_count DESC
    `,
    [projectPath, projectPath, from, from, to, to],
    ProviderCacheHitModelRowSchema
  );
}

async function queryDelegationSummary(
  conn: DuckDBConnection,
  params: { projectPath: string | null; from: string | null; to: string | null }
): Promise<DelegationSummaryResult> {
  const filterParams: DuckDBValue[] = [
    params.projectPath,
    params.projectPath,
    params.from,
    params.from,
    params.to,
    params.to,
  ];

  const whereClause = `
    WHERE (? IS NULL OR project_path = ?)
      AND (? IS NULL OR date >= CAST(? AS DATE))
      AND (? IS NULL OR date <= CAST(? AS DATE))
  `;

  const totals = await typedQueryOne(
    conn,
    `
    SELECT
      COALESCE(COUNT(*), 0) AS total_children,
      COALESCE(SUM(total_tokens), 0) AS total_tokens_consumed,
      COALESCE(SUM(report_token_estimate), 0) AS total_report_tokens,
      COALESCE(
        CASE
          WHEN SUM(CASE WHEN report_token_estimate > 0 THEN report_token_estimate ELSE 0 END) = 0 THEN 0
          ELSE SUM(CASE WHEN report_token_estimate > 0 THEN total_tokens ELSE 0 END)::DOUBLE
               / SUM(CASE WHEN report_token_estimate > 0 THEN report_token_estimate ELSE 0 END)
        END,
        0
      ) AS compression_ratio,
      COALESCE(SUM(total_cost_usd), 0) AS total_cost_delegated
    FROM delegation_rollups
    ${whereClause}
    `,
    [...filterParams],
    DelegationSummaryTotalsRowSchema
  );

  const breakdown = await typedQuery(
    conn,
    `
    SELECT
      COALESCE(agent_type, 'unknown') AS agent_type,
      COALESCE(COUNT(*), 0) AS delegation_count,
      COALESCE(SUM(total_tokens), 0) AS total_tokens,
      COALESCE(SUM(input_tokens), 0) AS input_tokens,
      COALESCE(SUM(output_tokens), 0) AS output_tokens,
      COALESCE(SUM(reasoning_tokens), 0) AS reasoning_tokens,
      COALESCE(SUM(cached_tokens), 0) AS cached_tokens,
      COALESCE(SUM(cache_create_tokens), 0) AS cache_create_tokens
    FROM delegation_rollups
    ${whereClause}
    GROUP BY agent_type
    ORDER BY total_tokens DESC
    `,
    [...filterParams],
    DelegationAgentBreakdownRowSchema
  );

  return { totals, breakdown };
}

export async function executeNamedQuery(
  conn: DuckDBConnection,
  queryName: string,
  params: Record<string, unknown>
): Promise<unknown> {
  switch (queryName) {
    case "getSummary": {
      return querySummary(conn, {
        projectPath: parseOptionalString(params.projectPath),
        from: parseDateFilter(params.from),
        to: parseDateFilter(params.to),
      });
    }

    case "getSpendOverTime": {
      return querySpendOverTime(conn, {
        granularity: parseGranularity(params.granularity),
        projectPath: parseOptionalString(params.projectPath),
        from: parseDateFilter(params.from),
        to: parseDateFilter(params.to),
        timeZone: parseTimeZone(params.timeZone),
      });
    }

    case "getSpendByProject": {
      return querySpendByProject(conn, {
        from: parseDateFilter(params.from),
        to: parseDateFilter(params.to),
      });
    }

    case "getSpendByModel": {
      return querySpendByModel(
        conn,
        parseOptionalString(params.projectPath),
        parseDateFilter(params.from),
        parseDateFilter(params.to)
      );
    }

    case "getTokensByModel": {
      return queryTokensByModel(
        conn,
        parseOptionalString(params.projectPath),
        parseDateFilter(params.from),
        parseDateFilter(params.to)
      );
    }

    case "getTimingDistribution": {
      return queryTimingDistribution(
        conn,
        parseTimingMetric(params.metric),
        parseOptionalString(params.projectPath),
        parseDateFilter(params.from),
        parseDateFilter(params.to)
      );
    }

    case "getAgentCostBreakdown": {
      return queryAgentCostBreakdown(
        conn,
        parseOptionalString(params.projectPath),
        parseDateFilter(params.from),
        parseDateFilter(params.to)
      );
    }

    case "getCacheHitRatioByProvider": {
      return queryCacheHitRatioByProvider(
        conn,
        parseOptionalString(params.projectPath),
        parseDateFilter(params.from),
        parseDateFilter(params.to)
      );
    }

    case "getDelegationSummary": {
      return queryDelegationSummary(conn, {
        projectPath: parseOptionalString(params.projectPath),
        from: parseDateFilter(params.from),
        to: parseDateFilter(params.to),
      });
    }

    default:
      throw new Error(`Unknown analytics query: ${queryName}`);
  }
}

export const RAW_QUERY_ROW_LIMIT = 10_000;

export interface RawQueryColumn {
  name: string;
  type: string;
}

export interface RawQueryResult {
  columns: RawQueryColumn[];
  rows: Array<Record<string, unknown>>;
  truncated: boolean;
  // When rowCountExact is false, this is a lower bound ("at least this many rows").
  rowCount: number;
  rowCountExact: boolean;
  durationMs: number;
}

const RAW_QUERY_DISALLOWED_PATTERNS: RegExp[] = [
  /"?\bread_csv\b"?\s*\(/i,
  /"?\bread_csv_auto\b"?\s*\(/i,
  /"?\bread_parquet\b"?\s*\(/i,
  /"?\bread_json\b"?\s*\(/i,
  /"?\bread_json_auto\b"?\s*\(/i,
  /"?\bread_ndjson\b"?\s*\(/i,
  /"?\bread_ndjson_auto\b"?\s*\(/i,
  /"?\bread_blob\b"?\s*\(/i,
  /"?\bread_text\b"?\s*\(/i,
  /"?\bhttp_get\b"?\s*\(/i,
  /"?\bhttp_post\b"?\s*\(/i,
  /"?\bglob\b"?\s*\(/i,
  /"?\blist_files\b"?\s*\(/i,
  /"?\bduckdb_tables\b"?\s*\(/i,
  /"?\bduckdb_columns\b"?\s*\(/i,
  /"?\bduckdb_views\b"?\s*\(/i,
  /"?\bduckdb_indexes\b"?\s*\(/i,
  /"?\bduckdb_constraints\b"?\s*\(/i,
  /"?\bduckdb_dependencies\b"?\s*\(/i,
  /"?\bduckdb_functions\b"?\s*\(/i,
  /"?\bduckdb_keywords\b"?\s*\(/i,
  /"?\bduckdb_types\b"?\s*\(/i,
  /"?\bduckdb_settings\b"?\s*\(/i,
  /"?\bduckdb_databases\b"?\s*\(/i,
  /"?\bduckdb_schemas\b"?\s*\(/i,
  /"?\bduckdb_sequences\b"?\s*\(/i,
  /"?\bduckdb_extensions\b"?\s*\(/i,
  /(?:"?\binformation_schema\b"?)\s*\./i,
  /(?:"?\bpg_catalog\b"?)\s*\./i,
  /"?\bgenerate_series\b"?\s*\(/i,
  /"?\b[a-zA-Z_][a-zA-Z0-9_]*_scan\b"?\s*\(/i,
  /(^|[;(])\s*copy\b/i,
  /(^|[;(])\s*export\b/i,
  /(^|[;(])\s*import\b/i,
  /(^|[;(])\s*attach\b/i,
  /(^|[;(])\s*detach\b/i,
  /(^|[;(])\s*install\b/i,
  /(^|[;(])\s*load\b/i,
  /(^|[;(])\s*pragma\b/i,
  /(^|[;(])\s*set\b/i,
];

const RAW_QUERY_REPLACEMENT_SCAN_DIRECT_PATTERN = /\b(?:FROM|JOIN)\s+'/i;
const RAW_QUERY_REPLACEMENT_SCAN_CLAUSE_TERMINATORS = new Set([
  "WHERE",
  "GROUP",
  "HAVING",
  "ORDER",
  "LIMIT",
  "QUALIFY",
  "WINDOW",
  "UNION",
  "EXCEPT",
  "INTERSECT",
]);

function isRawQueryIdentifierCharacter(character: string | undefined): boolean {
  return character !== undefined && /[a-zA-Z0-9_$]/.test(character);
}

function isRawQueryKeywordStartCharacter(character: string | undefined): boolean {
  return character !== undefined && /[a-zA-Z_]/.test(character);
}

function parseRawQueryKeyword(
  sql: string,
  startIndex: number
): { keyword: string; endIndex: number } | null {
  if (isRawQueryIdentifierCharacter(sql[startIndex - 1])) {
    return null;
  }

  const firstCharacter = sql[startIndex];
  if (!isRawQueryKeywordStartCharacter(firstCharacter)) {
    return null;
  }

  let endIndex = startIndex + 1;
  while (isRawQueryIdentifierCharacter(sql[endIndex])) {
    endIndex += 1;
  }

  return {
    keyword: sql.slice(startIndex, endIndex).toUpperCase(),
    endIndex,
  };
}

function findNextRawQueryNonWhitespaceIndex(sql: string, startIndex: number): number {
  let index = startIndex;
  while (index < sql.length && /\s/.test(sql[index])) {
    index += 1;
  }

  return index;
}

function skipRawQuerySingleQuotedLiteral(sql: string, startIndex: number): number {
  assert(sql[startIndex] === "'", "Expected to skip a single-quoted SQL literal");

  let index = startIndex + 1;
  while (index < sql.length) {
    if (sql[index] === "'" && sql[index + 1] === "'") {
      index += 2;
      continue;
    }

    if (sql[index] === "'") {
      return index + 1;
    }

    index += 1;
  }

  return index;
}

function hasRawQueryReplacementScanInFromClause(
  sql: string,
  fromClauseStartIndex: number,
  fromClauseDepth: number
): boolean {
  let depth = fromClauseDepth;
  let index = findNextRawQueryNonWhitespaceIndex(sql, fromClauseStartIndex);

  if (sql[index] === "'") {
    return true;
  }

  while (index < sql.length) {
    const character = sql[index];

    if (character === "'") {
      index = skipRawQuerySingleQuotedLiteral(sql, index);
      continue;
    }

    if (character === "(") {
      depth += 1;
      index += 1;
      continue;
    }

    if (character === ")") {
      if (depth === fromClauseDepth) {
        return false;
      }
      depth -= 1;
      index += 1;
      continue;
    }

    if (depth === fromClauseDepth) {
      if (character === ";") {
        return false;
      }

      if (character === ",") {
        const sourceStartIndex = findNextRawQueryNonWhitespaceIndex(sql, index + 1);
        if (sql[sourceStartIndex] === "'") {
          return true;
        }
      }

      const keywordMatch = parseRawQueryKeyword(sql, index);
      if (keywordMatch !== null) {
        if (keywordMatch.keyword === "JOIN") {
          const sourceStartIndex = findNextRawQueryNonWhitespaceIndex(sql, keywordMatch.endIndex);
          if (sql[sourceStartIndex] === "'") {
            return true;
          }
        }

        if (RAW_QUERY_REPLACEMENT_SCAN_CLAUSE_TERMINATORS.has(keywordMatch.keyword)) {
          return false;
        }

        index = keywordMatch.endIndex;
        continue;
      }
    }

    index += 1;
  }

  return false;
}

function hasRawQueryReplacementScan(sql: string): boolean {
  if (RAW_QUERY_REPLACEMENT_SCAN_DIRECT_PATTERN.test(sql)) {
    return true;
  }

  let depth = 0;
  let index = 0;

  while (index < sql.length) {
    const character = sql[index];

    if (character === "'") {
      index = skipRawQuerySingleQuotedLiteral(sql, index);
      continue;
    }

    if (character === "(") {
      depth += 1;
      index += 1;
      continue;
    }

    if (character === ")") {
      depth = Math.max(0, depth - 1);
      index += 1;
      continue;
    }

    const keywordMatch = parseRawQueryKeyword(sql, index);
    if (keywordMatch?.keyword === "FROM") {
      if (hasRawQueryReplacementScanInFromClause(sql, keywordMatch.endIndex, depth)) {
        return true;
      }
      index = keywordMatch.endIndex;
      continue;
    }

    index += 1;
  }

  return false;
}

function maskRawQueryLiteralsAndComments(
  sql: string,
  options: { maskStrings: boolean } = { maskStrings: true }
): string {
  const characters = Array.from(sql);
  let index = 0;
  const shouldMaskStrings = options.maskStrings;

  while (index < characters.length) {
    const char = characters[index];
    const nextChar = characters[index + 1];

    if (char === "'") {
      if (shouldMaskStrings) {
        characters[index] = " ";
      }
      index += 1;
      while (index < characters.length) {
        const current = characters[index];
        const following = characters[index + 1];
        if (shouldMaskStrings) {
          characters[index] = " ";
        }
        if (current === "'" && following === "'") {
          if (shouldMaskStrings) {
            characters[index + 1] = " ";
          }
          index += 2;
          continue;
        }

        index += 1;
        if (current === "'") {
          break;
        }
      }
      continue;
    }

    if (char === "-" && nextChar === "-") {
      characters[index] = " ";
      characters[index + 1] = " ";
      index += 2;
      while (index < characters.length && characters[index] !== "\n") {
        characters[index] = " ";
        index += 1;
      }
      continue;
    }

    if (char === "/" && nextChar === "*") {
      characters[index] = " ";
      characters[index + 1] = " ";
      index += 2;
      while (index < characters.length) {
        if (characters[index] === "*" && characters[index + 1] === "/") {
          characters[index] = " ";
          characters[index + 1] = " ";
          index += 2;
          break;
        }

        characters[index] = " ";
        index += 1;
      }
      continue;
    }

    index += 1;
  }

  return characters.join("");
}

/**
 * Security model for raw analytics SQL validation:
 * 1) mask comments while preserving string literals,
 * 2) block DuckDB replacement scans that use string literals as table sources,
 * 3) mask string literals/comments before regex matching,
 * 4) block dangerous functions/statements via RAW_QUERY_DISALLOWED_PATTERNS,
 * 5) rely on executeRawQuery subquery wrapping plus read-only DuckDB connections.
 */
function validateRawQuerySql(cleanSql: string): void {
  const commentMaskedSql = maskRawQueryLiteralsAndComments(cleanSql, {
    maskStrings: false,
  });

  // Keep quote delimiters while masking literal contents so replacement-scan detection
  // catches FROM/JOIN and comma-separated FROM sources without false positives from
  // keywords embedded inside literal text.
  const replacementScanMaskedSql = commentMaskedSql.replace(/'(?:[^']|'')*'/g, (literal) => {
    assert(literal.length >= 2, "Single-quoted SQL literal must include delimiters");
    return `'${" ".repeat(literal.length - 2)}'`;
  });

  if (hasRawQueryReplacementScan(replacementScanMaskedSql)) {
    throw new Error(
      "String literals cannot be used as table sources (DuckDB replacement scans are not allowed)"
    );
  }

  const fullyMaskedSql = maskRawQueryLiteralsAndComments(commentMaskedSql);

  for (const pattern of RAW_QUERY_DISALLOWED_PATTERNS) {
    if (pattern.test(fullyMaskedSql)) {
      throw new Error(`Query contains disallowed SQL: ${pattern.source.replace(/\b/g, "")}`);
    }
  }
}

/**
 * Execute arbitrary user SQL as a read-only subquery with a hard row cap.
 * Wrapping the statement in a subquery prevents DML/DDL execution,
 * validateRawQuerySql blocks dangerous functions/statements, and
 * the DuckDB connection remains read-only.
 */
export async function executeRawQuery(
  conn: DuckDBConnection,
  sql: string
): Promise<RawQueryResult> {
  assert(
    typeof sql === "string" && sql.trim().length > 0,
    "executeRawQuery requires non-empty SQL"
  );

  const cleanSql = sql.trim().replace(/;+$/, "").trim();
  assert(cleanSql.length > 0, "executeRawQuery requires SQL with at least one statement");

  validateRawQuerySql(cleanSql);

  const fetchLimit = RAW_QUERY_ROW_LIMIT + 1;
  const wrappedSql = `SELECT * FROM (\n${cleanSql}\n) AS __q LIMIT ${fetchLimit}`;

  const startMs = performance.now();
  const result = await conn.run(wrappedSql);
  const rawRows = await result.getRowObjectsJS();
  const durationMs = Math.round(performance.now() - startMs);

  const columns: RawQueryColumn[] = [];
  for (let index = 0; index < result.columnCount; index += 1) {
    columns.push({
      name: result.columnName(index),
      type: String(result.columnType(index)),
    });
  }

  const rowCount = rawRows.length;
  const truncated = rowCount > RAW_QUERY_ROW_LIMIT;
  const rows = truncated ? rawRows.slice(0, RAW_QUERY_ROW_LIMIT) : rawRows;
  const rowCountExact = !truncated;

  assert(
    rowCount <= fetchLimit,
    `Raw query row count (${rowCount}) exceeded fetch limit (${fetchLimit})`
  );

  return {
    columns,
    rows: rows.map(normalizeDuckDbRow),
    truncated,
    rowCount,
    rowCountExact,
    durationMs,
  };
}

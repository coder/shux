import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { describe, test } from "bun:test";
import { CREATE_EVENTS_TABLE_SQL } from "@/common/analytics/schemaSql";
import { SAMPLE_QUERIES } from "./SqlExplorer";

const SAMPLE_QUERY_RUNNER_PAYLOAD_ENV = "SQL_EXPLORER_SAMPLE_QUERY_PAYLOAD";
const SAMPLE_QUERY_RUNNER_PATH = fileURLToPath(
  new URL("./sqlExplorerSampleQueryRunner.cjs", import.meta.url)
);

const SEED_EVENTS_ROW_SQL = `
INSERT INTO events (
  workspace_id,
  model,
  total_cost_usd,
  date,
  agent_id,
  duration_ms,
  thinking_level,
  input_tokens,
  output_tokens,
  reasoning_tokens,
  cached_tokens,
  cache_create_tokens,
  tool_name,
  requested_model,
  refused_models_json
) VALUES
  -- Ordinary committed turn.
  ('workspace-1', 'openai:gpt-4.1', 1.25, DATE '2026-03-01', 'agent-1', 520, 'high',
   100, 50, 10, 5, 2, NULL, NULL, NULL),
  -- Downgraded turn: answered by the fallback model, downgrade metadata on the main row.
  ('workspace-1', 'openai:gpt-4.1', 0.42, DATE '2026-03-02', 'agent-1', 610, 'high',
   80, 40, 0, 0, 0, NULL, 'anthropic:fable-1', '["anthropic:fable-1"]'),
  -- Refused fallback hop recorded on the committed downgraded turn.
  ('workspace-1', 'anthropic:fable-1', 0, DATE '2026-03-02', 'agent-1', NULL, 'high',
   12, 0, 0, 0, 0, 'model_fallback_refusal', NULL, NULL),
  -- Zero-usage terminal refusal on a turn that never committed.
  ('workspace-1', 'anthropic:fable-1', 0, DATE '2026-03-03', 'agent-1', NULL, NULL,
   0, 0, 0, 0, 0, 'headless:refused_stream', NULL, NULL)
`;

type SampleQuery = (typeof SAMPLE_QUERIES)[number];

interface SampleQueryRunnerPayload {
  createEventsTableSql: string;
  seedEventsRowSql: string;
  sample: SampleQuery;
}

function runSampleQuery(sample: SampleQuery): void {
  assert(
    typeof sample.label === "string" && sample.label.trim().length > 0,
    "Sample query label must be a non-empty string"
  );
  assert(
    typeof sample.sql === "string" && sample.sql.trim().length > 0,
    "Sample query sql must be a non-empty string"
  );

  const payload: SampleQueryRunnerPayload = {
    createEventsTableSql: CREATE_EVENTS_TABLE_SQL,
    seedEventsRowSql: SEED_EVENTS_ROW_SQL,
    sample,
  };

  // Bun cannot load @duckdb/node-api in this environment because the native
  // binding depends on libstdc++. Run the DuckDB execution under Node while
  // keeping the SQL setup and assertions in this test file.
  const runner = spawnSync("node", [SAMPLE_QUERY_RUNNER_PATH], {
    env: {
      ...process.env,
      [SAMPLE_QUERY_RUNNER_PAYLOAD_ENV]: JSON.stringify(payload),
    },
    encoding: "utf8",
  });

  const output = `${runner.stdout ?? ""}${runner.stderr ?? ""}`.trim();
  assert(
    runner.status === 0,
    output.length > 0 ? output : `Sample query "${sample.label}" failed without diagnostic output`
  );
}

describe("SAMPLE_QUERIES", () => {
  for (const sample of SAMPLE_QUERIES) {
    test(`executes sample query: ${sample.label}`, () => {
      runSampleQuery(sample);
    });
  }
});

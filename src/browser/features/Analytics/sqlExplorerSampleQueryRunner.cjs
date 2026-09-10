"use strict";

const assert = require("node:assert/strict");
const { DuckDBInstance } = require("@duckdb/node-api");

const SAMPLE_QUERY_RUNNER_PAYLOAD_ENV = "SQL_EXPLORER_SAMPLE_QUERY_PAYLOAD";

function parseRunnerPayload() {
  const payloadJson = process.env[SAMPLE_QUERY_RUNNER_PAYLOAD_ENV] ?? "";
  assert(payloadJson.length > 0, `${SAMPLE_QUERY_RUNNER_PAYLOAD_ENV} must be set`);

  const payload = JSON.parse(payloadJson);
  assert(payload && typeof payload === "object", "Runner payload must decode to an object");

  assert(
    typeof payload.createEventsTableSql === "string" && payload.createEventsTableSql.trim().length > 0,
    "Runner payload must include a createEventsTableSql string"
  );
  assert(
    typeof payload.seedEventsRowSql === "string" && payload.seedEventsRowSql.trim().length > 0,
    "Runner payload must include a seedEventsRowSql string"
  );
  assert(payload.sample && typeof payload.sample === "object", "Runner payload must include sample");
  assert(
    typeof payload.sample.label === "string" && payload.sample.label.trim().length > 0,
    "Sample query label must be a non-empty string"
  );
  assert(
    typeof payload.sample.sql === "string" && payload.sample.sql.trim().length > 0,
    "Sample query sql must be a non-empty string"
  );

  return payload;
}

async function runSampleQuery() {
  const payload = parseRunnerPayload();
  const instance = await DuckDBInstance.create(":memory:");
  const conn = await instance.connect();

  try {
    await conn.run(payload.createEventsTableSql);
    await conn.run(payload.seedEventsRowSql);
    const result = await conn.run(payload.sample.sql);
    const rows = await result.getRowObjectsJS();
    // Every sample query must return data against the seeded fixture rows —
    // an empty result means the query no longer matches what the ETL writes.
    assert(rows.length > 0, `Sample query "${payload.sample.label}" returned no rows against the seed`);
  } finally {
    conn.closeSync();
    instance.closeSync();
  }
}

runSampleQuery().catch((error) => {
  const message = error instanceof Error ? error.message : String(error);
  process.stderr.write(`${message}\n`);
  process.exit(1);
});

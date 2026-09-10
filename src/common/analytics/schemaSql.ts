export const CREATE_EVENTS_TABLE_SQL = `
CREATE TABLE IF NOT EXISTS events (
  workspace_id VARCHAR NOT NULL,
  project_path VARCHAR,
  project_name VARCHAR,
  workspace_name VARCHAR,
  parent_workspace_id VARCHAR,
  agent_id VARCHAR,
  timestamp BIGINT,
  date DATE,
  model VARCHAR,
  thinking_level VARCHAR,
  input_tokens INTEGER DEFAULT 0,
  output_tokens INTEGER DEFAULT 0,
  reasoning_tokens INTEGER DEFAULT 0,
  cached_tokens INTEGER DEFAULT 0,
  cache_create_tokens INTEGER DEFAULT 0,
  input_cost_usd DOUBLE DEFAULT 0,
  output_cost_usd DOUBLE DEFAULT 0,
  reasoning_cost_usd DOUBLE DEFAULT 0,
  cached_cost_usd DOUBLE DEFAULT 0,
  total_cost_usd DOUBLE DEFAULT 0,
  duration_ms DOUBLE,
  ttft_ms DOUBLE,
  streaming_ms DOUBLE,
  tool_execution_ms DOUBLE,
  output_tps DOUBLE,
  response_index INTEGER,
  is_sub_agent BOOLEAN DEFAULT false,
  tool_name TEXT,
  requested_model VARCHAR,
  refused_models_json VARCHAR
)
`;

/**
 * Small key/value side table for ingest bookkeeping that is not per-workspace.
 * Currently stores the pricing-table fingerprint: event costs are computed at
 * ingest time, so when the bundled pricing tables change (e.g. a new model's
 * pricing lands in an app upgrade), previously ingested rows keep stale $0
 * costs until a full rebuild reprices them.
 */
export const CREATE_INGEST_META_TABLE_SQL = `
CREATE TABLE IF NOT EXISTS ingest_meta (
  key VARCHAR PRIMARY KEY,
  value VARCHAR NOT NULL
)
`;

export const CREATE_WATERMARK_TABLE_SQL = `
CREATE TABLE IF NOT EXISTS ingest_watermarks (
  workspace_id VARCHAR PRIMARY KEY,
  last_sequence BIGINT NOT NULL,
  last_modified DOUBLE NOT NULL
)
`;

export const CREATE_DELEGATION_ROLLUPS_TABLE_SQL = `
CREATE TABLE IF NOT EXISTS delegation_rollups (
  parent_workspace_id VARCHAR NOT NULL,
  child_workspace_id VARCHAR NOT NULL,
  project_path VARCHAR,
  project_name VARCHAR,
  agent_type VARCHAR,
  model VARCHAR,
  total_tokens INTEGER DEFAULT 0,
  context_tokens INTEGER DEFAULT 0,
  input_tokens INTEGER DEFAULT 0,
  output_tokens INTEGER DEFAULT 0,
  reasoning_tokens INTEGER DEFAULT 0,
  cached_tokens INTEGER DEFAULT 0,
  cache_create_tokens INTEGER DEFAULT 0,
  report_token_estimate INTEGER DEFAULT 0,
  total_cost_usd DOUBLE DEFAULT 0,
  rolled_up_at_ms BIGINT,
  date DATE,
  PRIMARY KEY (parent_workspace_id, child_workspace_id)
)
`;

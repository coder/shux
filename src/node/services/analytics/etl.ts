import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import type { Dirent } from "node:fs";
import * as fs from "node:fs/promises";
import * as path from "node:path";
import type { LanguageModelV2Usage } from "@ai-sdk/provider";
import { DuckDBAppender, DuckDBDateValue, type DuckDBConnection } from "@duckdb/node-api";
import { EventRowSchema, type EventRow } from "@/common/orpc/schemas/analytics";
import { normalizeToCanonical } from "@/common/utils/ai/models";
import { getErrorMessage } from "@/common/utils/errors";
import { createDisplayUsage } from "@/common/utils/tokens/displayUsage";
import modelsData from "@/common/utils/tokens/models.json";
import { modelsExtra } from "@/common/utils/tokens/models-extra";
import { log } from "@/node/services/log";
import { toUtcDateString } from "@/node/services/analytics/dateUtils";
import {
  CHAT_FILE_NAME,
  CHAT_ARCHIVE_FILE_NAME,
  HEADLESS_USAGE_FILE_NAME,
} from "@/common/constants/paths";

// Re-export the canonical chat history filename (defined in constants/paths.ts)
// so existing analytics consumers (workspaceDiscovery, tests) can keep importing
// it from this module without duplicating the "chat.jsonl" literal.
export { CHAT_FILE_NAME };

/**
 * Sealed pre-boundary history rotates from chat.jsonl into chat-archive.jsonl
 * (see HistoryService). Analytics must consider both files or pre-compaction
 * usage/events would silently disappear after the first rotation.
 *
 * Returns null only when NEITHER file exists (no workspace history) — an
 * archive-only session must keep its analytics state.
 *
 * - `mtimeMs` is the max across both files; use it for "which copy is newer"
 *   recency comparisons (rebuild dedup winners).
 * - `changeSignal` additionally folds in each file's size and presence, so the
 *   watermark staleness check still fires when a file disappears even if the
 *   surviving file's mtime equals the previously stored max (e.g. same-tick
 *   writes followed by deleting chat.jsonl).
 * - The headless-usage sidecar also feeds `changeSignal` (but not `mtimeMs`,
 *   which stays chat-only for rebuild dedup recency): startup syncCheck
 *   compares stored watermark signals against disk, so a sidecar line
 *   appended right before an app exit must shift the signal or that spend
 *   strands until an unrelated ingest. Present-only (no missing-file marker):
 *   the sidecar is append-only, and a marker would drift the signal for every
 *   sidecar-less workspace on upgrade.
 *
 * Exported for the analytics worker's startup syncCheck.
 */
export async function statSessionChatHistory(
  sessionDir: string
): Promise<{ mtimeMs: number; changeSignal: number } | null> {
  let mtimeMs: number | null = null;
  let changeSignal = 0;
  for (const fileName of [CHAT_FILE_NAME, CHAT_ARCHIVE_FILE_NAME]) {
    try {
      const stat = await fs.stat(path.join(sessionDir, fileName));
      mtimeMs = mtimeMs === null ? stat.mtimeMs : Math.max(mtimeMs, stat.mtimeMs);
      changeSignal += stat.mtimeMs + stat.size;
    } catch (error) {
      if (!(isRecord(error) && error.code === "ENOENT")) {
        throw error;
      }
      changeSignal -= 1; // presence marker: distinguishes a missing file
    }
  }

  try {
    const stat = await fs.stat(path.join(sessionDir, HEADLESS_USAGE_FILE_NAME));
    changeSignal += stat.mtimeMs + stat.size;
  } catch (error) {
    if (!(isRecord(error) && error.code === "ENOENT")) {
      throw error;
    }
  }

  return mtimeMs === null ? null : { mtimeMs, changeSignal };
}

/**
 * Read full workspace history: sealed archive (older) followed by chat.jsonl.
 * Either file may be missing (uncompacted or archive-only sessions).
 */
async function readSessionChatHistoryContents(sessionDir: string): Promise<string> {
  let contents = "";
  for (const fileName of [CHAT_ARCHIVE_FILE_NAME, CHAT_FILE_NAME]) {
    try {
      contents += await fs.readFile(path.join(sessionDir, fileName), "utf-8");
    } catch (error) {
      if (!(isRecord(error) && error.code === "ENOENT")) {
        throw error;
      }
    }
  }

  return contents;
}
const METADATA_FILE_NAME = "metadata.json";
const SUBAGENT_TRANSCRIPTS_DIR_NAME = "subagent-transcripts";
const SESSION_USAGE_FILE_NAME = "session-usage.json";
const SUBAGENT_REPORTS_FILE_NAME = "subagent-reports.json";

/**
 * Maximum number of workspace directories to parse in parallel during rebuildAll.
 * Balances disk throughput against file-descriptor pressure.
 */
const REBUILD_CONCURRENCY = 16;

const INSERT_EVENT_SQL = `
INSERT INTO events (
  workspace_id,
  project_path,
  project_name,
  workspace_name,
  parent_workspace_id,
  agent_id,
  timestamp,
  date,
  model,
  tool_name,
  thinking_level,
  input_tokens,
  output_tokens,
  reasoning_tokens,
  cached_tokens,
  cache_create_tokens,
  input_cost_usd,
  output_cost_usd,
  reasoning_cost_usd,
  cached_cost_usd,
  total_cost_usd,
  duration_ms,
  ttft_ms,
  streaming_ms,
  tool_execution_ms,
  output_tps,
  response_index,
  is_sub_agent,
  requested_model,
  refused_models_json
) VALUES (
  ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?,
  ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?,
  ?, ?, ?, ?, ?, ?, ?, ?
)
`;

/**
 * Make a JS number safe for untyped DuckDB parameter binding.
 *
 * @duckdb/node-api's typeForValue() infers EVERY integral JS number as INT32,
 * so binding unix-ms timestamps or change signals (> 2^31-1) via
 * conn.run(sql, params) silently wraps them (e.g. 1700000000000 →
 * -807049216) regardless of the target column type. Convert large integers
 * to BigInt so inference picks a wide integer type and DuckDB casts to the
 * target column (BIGINT or DOUBLE) losslessly. Fractional numbers already
 * infer as DOUBLE and small integers fit INT32.
 */
function toBindableNumber(value: number | null): number | bigint | null {
  if (value === null || !Number.isInteger(value) || Math.abs(value) <= 0x7fffffff) {
    return value;
  }
  return BigInt(value);
}

/** Insert one events row via INSERT_EVENT_SQL with bind-safe numeric params. */
async function insertEventRow(
  conn: DuckDBConnection,
  row: EventRow,
  date: string | null
): Promise<void> {
  await conn.run(INSERT_EVENT_SQL, [
    row.workspace_id,
    row.project_path,
    row.project_name,
    row.workspace_name,
    row.parent_workspace_id,
    row.agent_id,
    toBindableNumber(row.timestamp),
    date,
    row.model,
    row.tool_name,
    row.thinking_level,
    row.input_tokens,
    row.output_tokens,
    row.reasoning_tokens,
    row.cached_tokens,
    row.cache_create_tokens,
    row.input_cost_usd,
    row.output_cost_usd,
    row.reasoning_cost_usd,
    row.cached_cost_usd,
    row.total_cost_usd,
    toBindableNumber(row.duration_ms),
    toBindableNumber(row.ttft_ms),
    toBindableNumber(row.streaming_ms),
    toBindableNumber(row.tool_execution_ms),
    row.output_tps,
    row.response_index,
    row.is_sub_agent,
    row.requested_model,
    row.refused_models_json,
  ]);
}

function appendVarcharOrNull(appender: DuckDBAppender, value: string | null | undefined): void {
  if (value != null) {
    appender.appendVarchar(value);
  } else {
    appender.appendNull();
  }
}

function appendDoubleOrNull(appender: DuckDBAppender, value: number | null | undefined): void {
  if (value != null) {
    appender.appendDouble(value);
  } else {
    appender.appendNull();
  }
}

function appendIntegerOrNull(appender: DuckDBAppender, value: number | null | undefined): void {
  if (value != null) {
    appender.appendInteger(value);
  } else {
    appender.appendNull();
  }
}

function appendBigIntOrNull(appender: DuckDBAppender, value: number | null | undefined): void {
  if (value != null) {
    appender.appendBigInt(BigInt(Math.trunc(value)));
  } else {
    appender.appendNull();
  }
}

function appendDateOrNull(appender: DuckDBAppender, dateStr: string | null | undefined): void {
  if (dateStr == null) {
    appender.appendNull();
    return;
  }

  const [y, m, d] = dateStr.split("-").map(Number);
  assert(
    Number.isFinite(y) && Number.isFinite(m) && Number.isFinite(d),
    `appendDateOrNull: invalid date "${dateStr}"`
  );
  appender.appendDate(DuckDBDateValue.fromParts({ year: y, month: m, day: d }));
}

export async function appendEvents(conn: DuckDBConnection, events: IngestEvent[]): Promise<void> {
  assert(INSERT_EVENT_SQL.length > 0, "appendEvents: expected INSERT_EVENT_SQL to remain defined");

  if (events.length === 0) {
    return;
  }

  const appender = await conn.createAppender("events");

  try {
    assert(
      appender instanceof DuckDBAppender,
      "appendEvents: expected createAppender to return a DuckDBAppender"
    );

    for (const event of events) {
      const row = event.row;
      appendVarcharOrNull(appender, row.workspace_id);
      appendVarcharOrNull(appender, row.project_path);
      appendVarcharOrNull(appender, row.project_name);
      appendVarcharOrNull(appender, row.workspace_name);
      appendVarcharOrNull(appender, row.parent_workspace_id);
      appendVarcharOrNull(appender, row.agent_id);
      appendBigIntOrNull(appender, row.timestamp);
      appendDateOrNull(appender, event.date);
      appendVarcharOrNull(appender, row.model);
      appendVarcharOrNull(appender, row.thinking_level);
      appender.appendInteger(row.input_tokens);
      appender.appendInteger(row.output_tokens);
      appender.appendInteger(row.reasoning_tokens);
      appender.appendInteger(row.cached_tokens);
      appender.appendInteger(row.cache_create_tokens);
      appender.appendDouble(row.input_cost_usd);
      appender.appendDouble(row.output_cost_usd);
      appender.appendDouble(row.reasoning_cost_usd);
      appender.appendDouble(row.cached_cost_usd);
      appender.appendDouble(row.total_cost_usd);
      appendDoubleOrNull(appender, row.duration_ms);
      appendDoubleOrNull(appender, row.ttft_ms);
      appendDoubleOrNull(appender, row.streaming_ms);
      appendDoubleOrNull(appender, row.tool_execution_ms);
      appendDoubleOrNull(appender, row.output_tps);
      appendIntegerOrNull(appender, row.response_index);
      appender.appendBoolean(row.is_sub_agent);
      appendVarcharOrNull(appender, row.tool_name);
      appendVarcharOrNull(appender, row.requested_model);
      appendVarcharOrNull(appender, row.refused_models_json);
      appender.endRow();
    }

    appender.flushSync();
  } finally {
    appender.closeSync();
  }
}

const INSERT_DELEGATION_ROLLUP_SQL = `
INSERT OR REPLACE INTO delegation_rollups (
  parent_workspace_id, child_workspace_id, project_path, project_name,
  agent_type, model, total_tokens, context_tokens,
  input_tokens, output_tokens, reasoning_tokens, cached_tokens, cache_create_tokens,
  report_token_estimate, total_cost_usd, rolled_up_at_ms, date
) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
`;

interface WorkspaceMeta {
  projectPath?: string;
  projectName?: string;
  workspaceName?: string;
  parentWorkspaceId?: string;
}

type WorkspaceMetaById = Record<string, WorkspaceMeta>;

interface IngestWatermark {
  lastSequence: number;
  lastModified: number;
}

interface IngestEvent {
  row: EventRow;
  sequence: number;
  date: string | null;
}

interface IngestEventContext {
  workspaceId: string;
  workspaceMeta: WorkspaceMeta;
  agentId: string | null;
  thinkingLevel: string | null;
  /** Null for headless-usage rows so replaceEventsByResponseIndex never touches them. */
  responseIndex: number | null;
  isSubAgent: boolean;
}

function buildIngestEventRow(params: {
  inheritedContext: IngestEventContext;
  model: string | null;
  metadataModel?: string;
  usage: LanguageModelV2Usage;
  providerMetadata?: Record<string, unknown>;
  toolName: string | null;
  timestamp: number | null;
  durationMs: number | null;
  ttftMs: number | null;
  outputTps: number | null;
  /** Refusal-fallback downgrade metadata; main turn rows only. */
  requestedModel?: string | null;
  refusedModelsJson?: string | null;
}): {
  parsed: ReturnType<typeof EventRowSchema.safeParse>;
  date: string | null;
} {
  const displayUsage = createDisplayUsage(
    params.usage,
    params.model ?? "unknown",
    params.providerMetadata,
    params.metadataModel
  );
  assert(displayUsage, "createDisplayUsage should return data for parsed usage payloads");

  const cachedCostUsd =
    (displayUsage.cached.cost_usd ?? 0) + (displayUsage.cacheCreate.cost_usd ?? 0);
  return {
    parsed: EventRowSchema.safeParse({
      workspace_id: params.inheritedContext.workspaceId,
      project_path: params.inheritedContext.workspaceMeta.projectPath ?? null,
      project_name: params.inheritedContext.workspaceMeta.projectName ?? null,
      workspace_name: params.inheritedContext.workspaceMeta.workspaceName ?? null,
      parent_workspace_id: params.inheritedContext.workspaceMeta.parentWorkspaceId ?? null,
      agent_id: params.inheritedContext.agentId,
      timestamp: params.timestamp,
      model: analyticsAttributionModel(params.model, params.metadataModel),
      tool_name: params.toolName,
      thinking_level: params.inheritedContext.thinkingLevel,
      input_tokens: displayUsage.input.tokens,
      output_tokens: displayUsage.output.tokens,
      reasoning_tokens: displayUsage.reasoning.tokens,
      cached_tokens: displayUsage.cached.tokens,
      cache_create_tokens: displayUsage.cacheCreate.tokens,
      input_cost_usd: displayUsage.input.cost_usd ?? 0,
      output_cost_usd: displayUsage.output.cost_usd ?? 0,
      reasoning_cost_usd: displayUsage.reasoning.cost_usd ?? 0,
      cached_cost_usd: cachedCostUsd,
      total_cost_usd:
        (displayUsage.input.cost_usd ?? 0) +
        (displayUsage.output.cost_usd ?? 0) +
        (displayUsage.reasoning.cost_usd ?? 0) +
        cachedCostUsd,
      duration_ms: params.durationMs,
      ttft_ms: params.ttftMs,
      streaming_ms: null,
      tool_execution_ms: null,
      output_tps: params.outputTps,
      response_index: params.inheritedContext.responseIndex,
      is_sub_agent: params.inheritedContext.isSubAgent,
      requested_model: params.requestedModel ?? null,
      refused_models_json: params.refusedModelsJson ?? null,
    }),
    date: dateBucketFromTimestamp(params.timestamp),
  };
}

interface DelegationRollupRaw {
  usageData: Record<string, unknown> | null;
  reportTokenByChildId: Map<string, number>;
}

interface ParsedWorkspaceData {
  workspaceId: string;
  sessionDir: string;
  events: IngestEvent[];
  stat: { mtimeMs: number; changeSignal: number };
  workspaceMeta: WorkspaceMeta;
  delegationRollupRaw: DelegationRollupRaw;
  archivedTranscripts: ParsedWorkspaceData[];
}

interface EventHeadSignatureParts {
  timestamp: number | null;
  model: string | null;
  totalCostUsd: number | null;
}

interface PersistedMessage {
  role?: unknown;
  createdAt?: unknown;
  metadata?: unknown;
}

const TTFT_FIELD_CANDIDATES = [
  "ttftMs",
  "ttft_ms",
  "timeToFirstTokenMs",
  "time_to_first_token_ms",
  "timeToFirstToken",
  "time_to_first_token",
  "firstTokenMs",
  "first_token_ms",
] as const;

const TIMING_RECORD_CANDIDATES = [
  "providerMetadata",
  "timing",
  "timings",
  "metrics",
  "latency",
  "performance",
] as const;

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}

function toFiniteNumber(value: unknown): number | null {
  // DuckDB returns BIGINT columns as JS bigint — coerce to number when safe.
  if (typeof value === "bigint") {
    const coerced = Number(value);
    return Number.isFinite(coerced) ? coerced : null;
  }

  if (typeof value !== "number" || !Number.isFinite(value)) {
    return null;
  }

  return value;
}

function toFiniteInteger(value: unknown): number | null {
  const parsed = toFiniteNumber(value);
  if (parsed === null || !Number.isInteger(parsed)) {
    return null;
  }

  return parsed;
}

function toOptionalString(value: unknown): string | undefined {
  if (typeof value !== "string") {
    return undefined;
  }

  const trimmed = value.trim();
  return trimmed.length > 0 ? trimmed : undefined;
}

/**
 * Parse metadata.modelFallback (ModelFallbackRecord: { requestedModel,
 * refusedModels }) into the events downgrade columns. Populated only when
 * requestedModel is a non-empty string AND refusedModels is a non-empty array
 * whose EVERY entry is a trimmed non-empty string; any malformed record or
 * entry yields nulls for both columns (the row is still ingested). Partially
 * valid arrays are rejected wholesale — silently dropping bad hops would emit
 * a truncated chain that reads as valid history.
 */
function parseModelFallback(rawModelFallback: unknown): {
  requestedModel: string | null;
  refusedModelsJson: string | null;
} {
  const MALFORMED = { requestedModel: null, refusedModelsJson: null };
  if (!isRecord(rawModelFallback)) {
    return MALFORMED;
  }

  const requestedModel = toOptionalString(rawModelFallback.requestedModel);
  const rawRefusedModels = rawModelFallback.refusedModels;
  if (!requestedModel || !Array.isArray(rawRefusedModels) || rawRefusedModels.length === 0) {
    return MALFORMED;
  }

  const refusedModels: string[] = [];
  for (const entry of rawRefusedModels) {
    const refusedModel = toOptionalString(entry);
    if (!refusedModel) {
      return MALFORMED;
    }
    refusedModels.push(refusedModel);
  }

  // ModelFallbackRecord invariant: the requested model is always the first
  // refused entry (the writer canonicalizes both with the same helper). A
  // mismatch means corrupted history — reject the record rather than report
  // an A→answered downgrade while the stored chain claims B refused.
  if (refusedModels[0] !== requestedModel) {
    return MALFORMED;
  }

  return { requestedModel, refusedModelsJson: JSON.stringify(refusedModels) };
}

/**
 * Analytics attribution key for events.model, mirroring
 * SessionUsageService.recordHeadlessUsageLocked (and StreamManager's
 * usageAttributionModel): Coder identities use the record-time pinned
 * metadata identity — the raw coder: string is a mutable instance route the
 * ETL cannot re-resolve — and every other identity canonicalizes gateway
 * strings. Without one shared key, answered main rows, refusal hop rows, and
 * headless sidecar rows would split a single configured model across several
 * buckets in GROUP BY model queries (e.g. coder:prod/opus vs anthropic:opus).
 * Coder rows without a persisted metadataModel keep the raw identity — it is
 * their only durable key.
 */
function analyticsAttributionModel(
  model: string | null,
  metadataModel: string | undefined
): string | null {
  if (model === null) {
    return null;
  }
  if (model.startsWith("coder:")) {
    return metadataModel ?? model;
  }
  return normalizeToCanonical(model);
}

function parseCreatedAtTimestamp(value: unknown): number | null {
  if (value instanceof Date && Number.isFinite(value.getTime())) {
    return value.getTime();
  }

  if (typeof value !== "string") {
    return null;
  }

  const parsed = Date.parse(value);
  return Number.isFinite(parsed) ? parsed : null;
}

function dateBucketFromTimestamp(timestampMs: number | null): string | null {
  if (timestampMs === null) {
    return null;
  }

  const date = new Date(timestampMs);
  if (!Number.isFinite(date.getTime())) {
    return null;
  }

  return toUtcDateString(date);
}

function parseUsage(rawUsage: unknown): LanguageModelV2Usage | undefined {
  if (!isRecord(rawUsage)) {
    return undefined;
  }

  const inputTokens = toFiniteNumber(rawUsage.inputTokens) ?? undefined;
  const outputTokens = toFiniteNumber(rawUsage.outputTokens) ?? undefined;
  const totalTokens = toFiniteNumber(rawUsage.totalTokens) ?? undefined;
  const reasoningTokens = toFiniteNumber(rawUsage.reasoningTokens) ?? undefined;
  const cachedInputTokens = toFiniteNumber(rawUsage.cachedInputTokens) ?? undefined;

  if (
    inputTokens === undefined &&
    outputTokens === undefined &&
    totalTokens === undefined &&
    reasoningTokens === undefined &&
    cachedInputTokens === undefined
  ) {
    return undefined;
  }

  return {
    inputTokens,
    outputTokens,
    totalTokens,
    reasoningTokens,
    cachedInputTokens,
  };
}

function readFirstFiniteMetric(
  source: Record<string, unknown>,
  keys: readonly string[]
): number | null {
  for (const key of keys) {
    const parsed = toFiniteNumber(source[key]);
    if (parsed !== null) {
      return parsed;
    }
  }

  return null;
}

function collectTimingMetricSources(
  metadata: Record<string, unknown>
): Array<Record<string, unknown>> {
  const visited = new Set<Record<string, unknown>>();
  const sources: Array<Record<string, unknown>> = [];

  const enqueueRecord = (value: unknown): void => {
    if (!isRecord(value) || visited.has(value)) {
      return;
    }

    visited.add(value);
    sources.push(value);
  };

  const enqueueKnownTimingCandidates = (value: unknown): void => {
    if (!isRecord(value)) {
      return;
    }

    enqueueRecord(value);

    for (const key of TIMING_RECORD_CANDIDATES) {
      enqueueRecord(value[key]);
    }
  };

  enqueueKnownTimingCandidates(metadata);

  const providerMetadata = metadata.providerMetadata;
  enqueueKnownTimingCandidates(providerMetadata);

  if (isRecord(providerMetadata)) {
    for (const nestedProviderMetadata of Object.values(providerMetadata)) {
      enqueueKnownTimingCandidates(nestedProviderMetadata);
    }
  }

  return sources;
}

function extractTtftMs(metadata: Record<string, unknown>): number | null {
  const timingSources = collectTimingMetricSources(metadata);
  assert(timingSources.length > 0, "extractTtftMs: expected at least one timing source");

  for (const source of timingSources) {
    const ttftMs = readFirstFiniteMetric(source, TTFT_FIELD_CANDIDATES);
    if (ttftMs !== null) {
      return ttftMs;
    }
  }

  return null;
}

function deriveProjectName(projectPath: string | undefined): string | undefined {
  if (!projectPath) {
    return undefined;
  }

  const basename = path.basename(projectPath);
  return basename.length > 0 ? basename : undefined;
}

function parseWorkspaceMetaFromUnknown(value: unknown): WorkspaceMeta {
  if (!isRecord(value)) {
    return {};
  }

  return {
    projectPath: toOptionalString(value.projectPath),
    projectName: toOptionalString(value.projectName),
    workspaceName: toOptionalString(value.name),
    parentWorkspaceId: toOptionalString(value.parentWorkspaceId),
  };
}

async function readWorkspaceMetaFromDisk(sessionDir: string): Promise<WorkspaceMeta> {
  const metadataPath = path.join(sessionDir, METADATA_FILE_NAME);

  try {
    const raw = await fs.readFile(metadataPath, "utf-8");
    return parseWorkspaceMetaFromUnknown(JSON.parse(raw) as unknown);
  } catch (error) {
    if (isRecord(error) && error.code === "ENOENT") {
      return {};
    }

    log.warn("[analytics-etl] Failed to read workspace metadata", {
      metadataPath,
      error: getErrorMessage(error),
    });
    return {};
  }
}

function mergeWorkspaceMeta(
  sessionMeta: WorkspaceMeta,
  overrideMeta: WorkspaceMeta
): WorkspaceMeta {
  const projectPath = overrideMeta.projectPath ?? sessionMeta.projectPath;

  return {
    projectPath,
    projectName:
      overrideMeta.projectName ?? sessionMeta.projectName ?? deriveProjectName(projectPath),
    workspaceName: overrideMeta.workspaceName ?? sessionMeta.workspaceName,
    parentWorkspaceId: overrideMeta.parentWorkspaceId ?? sessionMeta.parentWorkspaceId,
  };
}

function parsePersistedMessage(
  line: string,
  workspaceId: string,
  lineNumber: number
): PersistedMessage | null {
  try {
    const parsed = JSON.parse(line) as unknown;
    return isRecord(parsed) ? (parsed as PersistedMessage) : null;
  } catch (error) {
    log.warn("[analytics-etl] Skipping malformed chat.jsonl line", {
      workspaceId,
      lineNumber,
      error: getErrorMessage(error),
    });
    return null;
  }
}

function extractIngestEvents(params: {
  workspaceId: string;
  workspaceMeta: WorkspaceMeta;
  message: PersistedMessage;
  lineNumber: number;
  responseIndex: number;
}): IngestEvent[] {
  if (params.message.role !== "assistant") {
    return [];
  }

  const metadata = isRecord(params.message.metadata) ? params.message.metadata : null;
  if (!metadata) {
    return [];
  }

  const usage = parseUsage(metadata.usage);
  const sequence = toFiniteInteger(metadata.historySequence) ?? params.lineNumber;
  const timestamp =
    toFiniteNumber(metadata.timestamp) ?? parseCreatedAtTimestamp(params.message.createdAt) ?? null;
  const durationMs = toFiniteNumber(metadata.duration);
  const inheritedContext: IngestEventContext = {
    workspaceId: params.workspaceId,
    workspaceMeta: params.workspaceMeta,
    agentId: toOptionalString(metadata.agentId) ?? null,
    thinkingLevel: toOptionalString(metadata.thinkingLevel) ?? null,
    responseIndex: params.responseIndex,
    isSubAgent: (params.workspaceMeta.parentWorkspaceId ?? "").length > 0,
  };
  const events: IngestEvent[] = [];

  // Tool usage snapshots can survive even when the parent assistant usage payload is missing.
  // Keep ingesting those rows so malformed or partial history does not drop tool costs.
  if (usage) {
    // Downgrade metadata rides the main turn row only (tool rows stay null):
    // the `model` column is the answering model, requested_model the original.
    // Interrupted fallback turns commit with partial: true — they are billed
    // attempts but not answered downgrades, so the columns stay null there.
    const modelFallback =
      metadata.partial === true
        ? { requestedModel: null, refusedModelsJson: null }
        : parseModelFallback(metadata.modelFallback);
    const parentRow = buildIngestEventRow({
      inheritedContext,
      model: toOptionalString(metadata.model) ?? null,
      metadataModel: toOptionalString(metadata.metadataModel),
      usage,
      providerMetadata: isRecord(metadata.providerMetadata) ? metadata.providerMetadata : undefined,
      toolName: null,
      timestamp,
      durationMs,
      ttftMs: extractTtftMs(metadata),
      outputTps: null,
      requestedModel: modelFallback.requestedModel,
      refusedModelsJson: modelFallback.refusedModelsJson,
    });
    if (!parentRow.parsed.success) {
      log.warn("[analytics-etl] Skipping invalid analytics row", {
        workspaceId: params.workspaceId,
        lineNumber: params.lineNumber,
        issues: parentRow.parsed.error.issues,
      });
    } else {
      if (durationMs !== null && durationMs > 0) {
        parentRow.parsed.data.output_tps =
          parentRow.parsed.data.output_tokens / (durationMs / 1000);
      }

      events.push({
        row: parentRow.parsed.data,
        sequence,
        date: parentRow.date,
      });
    }
  }

  const toolModelUsages = metadata.toolModelUsages;
  if (!Array.isArray(toolModelUsages)) {
    return events;
  }

  for (const rawToolModelUsage of toolModelUsages) {
    if (!isRecord(rawToolModelUsage)) {
      continue;
    }

    const toolName = toOptionalString(rawToolModelUsage.toolName);
    const toolModel = toOptionalString(rawToolModelUsage.model);
    const toolUsage = parseUsage(rawToolModelUsage.usage);
    if (!toolName || !toolModel || !toolUsage) {
      continue;
    }

    const toolRow = buildIngestEventRow({
      inheritedContext,
      model: toolModel,
      metadataModel: toOptionalString(rawToolModelUsage.metadataModel),
      usage: toolUsage,
      providerMetadata: isRecord(rawToolModelUsage.providerMetadata)
        ? rawToolModelUsage.providerMetadata
        : undefined,
      toolName,
      timestamp: toFiniteNumber(rawToolModelUsage.timestamp) ?? timestamp,
      durationMs: null,
      ttftMs: null,
      outputTps: null,
    });
    if (!toolRow.parsed.success) {
      log.warn("[analytics-etl] Skipping invalid tool analytics row", {
        workspaceId: params.workspaceId,
        lineNumber: params.lineNumber,
        issues: toolRow.parsed.error.issues,
      });
      continue;
    }

    events.push({
      row: toolRow.parsed.data,
      sequence,
      date: toolRow.date,
    });
  }

  return events;
}

async function readWatermark(
  conn: DuckDBConnection,
  workspaceId: string
): Promise<IngestWatermark> {
  const result = await conn.run(
    `SELECT last_sequence, last_modified FROM ingest_watermarks WHERE workspace_id = ?`,
    [workspaceId]
  );
  const rows = await result.getRowObjectsJS();

  if (rows.length === 0) {
    return { lastSequence: -1, lastModified: 0 };
  }

  const row = rows[0];
  const lastSequence = toFiniteNumber(row.last_sequence) ?? -1;
  const lastModified = toFiniteNumber(row.last_modified) ?? 0;

  return {
    lastSequence,
    lastModified,
  };
}

async function readWorkspaceEventRowCount(
  conn: DuckDBConnection,
  workspaceId: string
): Promise<number> {
  // Chat-derived rows only (headless sidecar rows use a NULL response_index):
  // the truncation check compares this count against parsed chat.jsonl events,
  // so counting headless rows would fake a truncation after sidecar growth
  // and force needless full-workspace rebuilds.
  const result = await conn.run(
    `SELECT COUNT(*) AS row_count FROM events WHERE workspace_id = ? AND response_index IS NOT NULL`,
    [workspaceId]
  );
  const rows = await result.getRowObjectsJS();
  assert(rows.length === 1, "readWorkspaceEventRowCount: expected exactly one COUNT(*) result row");

  const rowCount = toFiniteInteger(rows[0].row_count);
  assert(
    rowCount !== null && rowCount >= 0,
    "readWorkspaceEventRowCount: expected non-negative integer row_count"
  );

  return rowCount;
}

export async function clearWorkspaceAnalyticsState(
  conn: DuckDBConnection,
  workspaceId: string
): Promise<void> {
  assert(workspaceId.trim().length > 0, "clearWorkspaceAnalyticsState: workspaceId is required");

  await conn.run("BEGIN TRANSACTION");
  try {
    await conn.run("DELETE FROM events WHERE workspace_id = ?", [workspaceId]);
    await conn.run("DELETE FROM ingest_watermarks WHERE workspace_id = ?", [workspaceId]);
    await conn.run("DELETE FROM delegation_rollups WHERE parent_workspace_id = ?", [workspaceId]);
    await conn.run("COMMIT");
  } catch (error) {
    await conn.run("ROLLBACK");
    throw error;
  }
}

const CORRUPT_IDENTIFIER_MAX_LENGTH = 1024;

/**
 * Self-healing sweep for a rare native-layer corruption class: a phantom row
 * can materialize whose every VARCHAR column is the concatenation of that
 * column's non-null values across an entire batch of inserted rows (observed
 * once in the wild: a 17KB "model" string spanning ~670 events, which then
 * wallpapered the Analytics dashboard as one giant legend entry). The donor
 * rows are written correctly, so deleting rows with impossible string lengths
 * loses no real data.
 *
 * Two evidence classes, both structural (unbounded columns like model,
 * paths, and workspace names are never deletion evidence on their own, since
 * custom-provider model IDs etc. have no schema max length):
 *
 * 1. Identifier length beyond the legal construction maximum. New workspace
 *    IDs are short hex; migrated legacy IDs are
 *    `${projectBasename}-${workspaceBasename}` (config.generateLegacyId),
 *    each basename bounded by the filesystem's NAME_MAX (255 bytes), so 511
 *    is the construction ceiling. Agent IDs also derive from basenames.
 *    CORRUPT_IDENTIFIER_MAX_LENGTH doubles that ceiling for headroom.
 *    agent_type is excluded: legacy workspace metadata and rollup entries
 *    accept unbounded agent-type strings, so length there is not evidence.
 *
 * 2. Workspace identity unknown to ingest_watermarks. A concatenation of two
 *    or more workspace IDs can never equal a real workspace ID, no matter how
 *    small the corrupted batch. This evidence is only safe at init, before
 *    any ingest of the session (prior-session rows either have watermarks or
 *    are orphans the first syncCheck re-ingests from disk), or right after a
 *    rebuild that reports the workspaces whose ingest failed before their
 *    watermark write via preserveWorkspaceIds. Running it after ordinary
 *    ingests deletes real rows of workspaces whose ingest keeps failing on a
 *    poison record, so callers must not sweep there.
 *    delegation_rollups joins on parent_workspace_id only;
 *    child_workspace_id may legitimately reference a removed child workspace.
 */
export async function deleteCorruptAnalyticsRows(
  conn: DuckDBConnection,
  preserveWorkspaceIds: ReadonlySet<string> = new Set()
): Promise<number> {
  // Length evidence stays authoritative for preserved workspaces; only the
  // watermark-membership evidence is exempted for them.
  const preserveList = [...preserveWorkspaceIds]
    .map((id) => `'${id.replaceAll("'", "''")}'`)
    .join(", ");

  const eventsResult = await conn.run(`
    DELETE FROM events
    WHERE LENGTH(workspace_id) > ${CORRUPT_IDENTIFIER_MAX_LENGTH}
       OR LENGTH(parent_workspace_id) > ${CORRUPT_IDENTIFIER_MAX_LENGTH}
       OR LENGTH(agent_id) > ${CORRUPT_IDENTIFIER_MAX_LENGTH}
       OR (NOT EXISTS (
         SELECT 1 FROM ingest_watermarks w WHERE w.workspace_id = events.workspace_id
       )${preserveList ? ` AND events.workspace_id NOT IN (${preserveList})` : ""})
  `);

  const rollupsResult = await conn.run(`
    DELETE FROM delegation_rollups
    WHERE LENGTH(parent_workspace_id) > ${CORRUPT_IDENTIFIER_MAX_LENGTH}
       OR LENGTH(child_workspace_id) > ${CORRUPT_IDENTIFIER_MAX_LENGTH}
       OR (NOT EXISTS (
         SELECT 1 FROM ingest_watermarks w
         WHERE w.workspace_id = delegation_rollups.parent_workspace_id
       )${preserveList ? ` AND delegation_rollups.parent_workspace_id NOT IN (${preserveList})` : ""})
  `);

  return eventsResult.rowsChanged + rollupsResult.rowsChanged;
}

function serializeHeadSignatureValue(value: string | number | null): string {
  if (value === null) {
    return "null";
  }

  return `${typeof value}:${String(value)}`;
}

function createEventHeadSignature(parts: EventHeadSignatureParts): string {
  return [
    serializeHeadSignatureValue(parts.timestamp),
    serializeHeadSignatureValue(parts.model),
    serializeHeadSignatureValue(parts.totalCostUsd),
  ].join("|");
}

function createEventHeadSignatureFromParsedEvent(event: IngestEvent): string {
  const row = event.row;
  assert(
    Number.isFinite(row.total_cost_usd),
    "createEventHeadSignatureFromParsedEvent: expected finite total_cost_usd"
  );

  return createEventHeadSignature({
    timestamp: row.timestamp,
    model: row.model,
    totalCostUsd: row.total_cost_usd,
  });
}

export async function readPersistedWorkspaceHeadSignature(
  conn: DuckDBConnection,
  workspaceId: string
): Promise<string | null> {
  const result = await conn.run(
    `
    SELECT timestamp, model, total_cost_usd
    FROM events
    WHERE workspace_id = ? AND response_index IS NOT NULL
    ORDER BY
      response_index ASC,
      CASE WHEN tool_name IS NULL THEN 0 ELSE 1 END ASC,
      timestamp ASC
    LIMIT 1
    `,
    [workspaceId]
  );
  const rows = await result.getRowObjectsJS();

  if (rows.length === 0) {
    return null;
  }

  assert(
    rows.length === 1,
    "readPersistedWorkspaceHeadSignature: expected zero or one persisted head row"
  );

  const row = rows[0] as Record<string, unknown>;
  const timestamp = toFiniteNumber(row.timestamp);
  assert(
    timestamp !== null || row.timestamp === null,
    "readPersistedWorkspaceHeadSignature: expected timestamp to be finite number or null"
  );

  const model = row.model;
  assert(
    model === null || typeof model === "string",
    "readPersistedWorkspaceHeadSignature: expected model to be string or null"
  );

  const totalCostUsd = toFiniteNumber(row.total_cost_usd);
  assert(
    totalCostUsd !== null || row.total_cost_usd === null,
    "readPersistedWorkspaceHeadSignature: expected total_cost_usd to be finite number or null"
  );

  return createEventHeadSignature({
    timestamp,
    model,
    totalCostUsd,
  });
}

function hasPersistedWatermark(watermark: IngestWatermark): boolean {
  return watermark.lastSequence >= 0 || watermark.lastModified > 0;
}

async function writeWatermark(
  conn: DuckDBConnection,
  workspaceId: string,
  watermark: IngestWatermark
): Promise<void> {
  await conn.run(
    `
    INSERT INTO ingest_watermarks (workspace_id, last_sequence, last_modified)
    VALUES (?, ?, ?)
    ON CONFLICT(workspace_id) DO UPDATE
      SET last_sequence = excluded.last_sequence,
          last_modified = excluded.last_modified
    `,
    // toBindableNumber: lastSequence targets BIGINT and lastModified (change
    // signal, mtime+size sums > 2^31) targets DOUBLE — untyped binding would
    // truncate both to int32.
    [
      workspaceId,
      toBindableNumber(watermark.lastSequence),
      toBindableNumber(watermark.lastModified),
    ]
  );
}

async function replaceEventsByResponseIndex(
  conn: DuckDBConnection,
  workspaceId: string,
  events: IngestEvent[]
): Promise<void> {
  if (events.length === 0) {
    return;
  }

  const responseIndexes: number[] = [];
  const seenResponseIndexes = new Set<number>();

  for (const event of events) {
    const row = event.row;
    assert(
      row.workspace_id === workspaceId,
      "replaceEventsByResponseIndex: all rows must belong to the target workspace"
    );
    const responseIndex = row.response_index;
    assert(responseIndex !== null, "replaceEventsByResponseIndex: response_index must be present");
    assert(
      Number.isInteger(responseIndex),
      "replaceEventsByResponseIndex: response_index must be an integer"
    );
    if (seenResponseIndexes.has(responseIndex)) {
      continue;
    }

    seenResponseIndexes.add(responseIndex);
    responseIndexes.push(responseIndex);
  }

  assert(
    responseIndexes.length > 0,
    "replaceEventsByResponseIndex: non-empty events must include response indexes"
  );

  const placeholders = responseIndexes.map(() => "?").join(", ");

  await conn.run("BEGIN TRANSACTION");
  try {
    await conn.run(
      `DELETE FROM events WHERE workspace_id = ? AND response_index IN (${placeholders})`,
      [workspaceId, ...responseIndexes]
    );

    for (const event of events) {
      await insertEventRow(conn, event.row, event.date);
    }

    await conn.run("COMMIT");
  } catch (error) {
    await conn.run("ROLLBACK");
    throw error;
  }
}

async function replaceWorkspaceEvents(
  conn: DuckDBConnection,
  workspaceId: string,
  events: IngestEvent[]
): Promise<void> {
  await conn.run("BEGIN TRANSACTION");
  try {
    await conn.run("DELETE FROM events WHERE workspace_id = ?", [workspaceId]);

    for (const event of events) {
      assert(
        event.row.workspace_id === workspaceId,
        "replaceWorkspaceEvents: all rows must belong to the target workspace"
      );
      await insertEventRow(conn, event.row, event.date);
    }

    await conn.run("COMMIT");
  } catch (error) {
    await conn.run("ROLLBACK");
    throw error;
  }
}

function getMaxSequence(events: IngestEvent[]): number | null {
  if (events.length === 0) {
    return null;
  }

  let maxSequence = Number.NEGATIVE_INFINITY;
  for (const event of events) {
    maxSequence = Math.max(maxSequence, event.sequence);
  }

  assert(Number.isFinite(maxSequence), "getMaxSequence: expected finite max sequence");
  return maxSequence;
}

function shouldRebuildWorkspaceForSequenceRegression(params: {
  watermark: IngestWatermark;
  parsedMaxSequence: number | null;
  hasTruncation: boolean;
  hasHeadMismatch: boolean;
}): boolean {
  if (params.hasTruncation || params.hasHeadMismatch) {
    return true;
  }

  if (!hasPersistedWatermark(params.watermark)) {
    return false;
  }

  if (params.parsedMaxSequence === null) {
    return true;
  }

  return params.parsedMaxSequence < params.watermark.lastSequence;
}

export async function ingestWorkspace(
  conn: DuckDBConnection,
  workspaceId: string,
  sessionDir: string,
  meta: WorkspaceMeta
): Promise<void> {
  assert(workspaceId.trim().length > 0, "ingestWorkspace: workspaceId is required");
  assert(sessionDir.trim().length > 0, "ingestWorkspace: sessionDir is required");

  const stat = await statSessionChatHistory(sessionDir);
  if (stat === null) {
    // Remove stale analytics state when the workspace history file no longer exists.
    await clearWorkspaceAnalyticsState(conn, workspaceId);
    return;
  }

  const watermark = await readWatermark(conn, workspaceId);
  const persistedMeta = await readWorkspaceMetaFromDisk(sessionDir);
  const workspaceMeta = mergeWorkspaceMeta(persistedMeta, meta);

  // Keep delegation rollups fresh even when chat.jsonl is unchanged.
  await ingestDelegationRollups(conn, workspaceId, sessionDir, workspaceMeta);

  // Also ingest archived sub-agent transcripts stored in this workspace's
  // session dir. This recovers sub-agent data that was cleared when the
  // child workspace was removed (clearWorkspace deletes child rows, but
  // the archived chat.jsonl in the parent dir is the source of truth).
  // This must run BEFORE the changeSignal early-return below: child deletion
  // archives the transcript without touching the parent's own chat files, so
  // gating recovery on a parent chat change would strand the child's spend
  // until the parent happens to stream again. Watermark dedup makes repeated
  // calls cheap (stat + comparison only).
  await ingestArchivedSubagentTranscripts(conn, sessionDir, workspaceMeta, workspaceId);

  // Skip only when the combined change signal (mtimes + sizes + presence) is
  // unchanged. Any append/rewrite/rotation/file-deletion changes the signal, so
  // ingestion re-runs and the rebuild path can drop stale rows — even when the
  // surviving file's mtime equals the previously stored value.
  if (stat.changeSignal === watermark.lastModified) {
    // Headless usage (status generation, memory sweeps) accrues without
    // touching chat files, so it must ingest even when chat is unchanged.
    await ingestHeadlessUsage(conn, workspaceId, sessionDir, workspaceMeta);
    return;
  }

  const chatContents = await readSessionChatHistoryContents(sessionDir);
  const lines = chatContents.split("\n").filter((line) => line.trim().length > 0);

  let responseIndex = 0;
  const parsedEvents: IngestEvent[] = [];

  for (let i = 0; i < lines.length; i++) {
    const lineNumber = i + 1;
    const message = parsePersistedMessage(lines[i], workspaceId, lineNumber);
    if (!message) {
      continue;
    }

    const events = extractIngestEvents({
      workspaceId,
      workspaceMeta,
      message,
      lineNumber,
      responseIndex,
    });
    if (events.length === 0) {
      continue;
    }

    for (const event of events) {
      assert(
        Number.isInteger(event.sequence),
        "ingestWorkspace: expected assistant event sequence to be an integer"
      );
      parsedEvents.push(event);
    }

    responseIndex += 1;
  }

  const parsedMaxSequence = getMaxSequence(parsedEvents);
  const hasExistingWatermark = hasPersistedWatermark(watermark);
  const persistedEventRowCount = await readWorkspaceEventRowCount(conn, workspaceId);
  // Sequence-only checks miss truncations when the tail keeps the previous max
  // historySequence. If fewer assistant events are parsed than currently stored,
  // stale deleted rows remain unless we force a full workspace rebuild.
  const hasTruncation = hasExistingWatermark && parsedEvents.length < persistedEventRowCount;
  const persistedHeadSignature = hasExistingWatermark
    ? await readPersistedWorkspaceHeadSignature(conn, workspaceId)
    : null;
  const parsedHeadSignature =
    parsedEvents.length > 0 ? createEventHeadSignatureFromParsedEvent(parsedEvents[0]) : null;
  // Count checks can miss head truncation + append rewrites where assistant row
  // totals recover. Head signature drift reveals shifted response indexes.
  const hasHeadMismatch =
    hasExistingWatermark &&
    persistedHeadSignature !== null &&
    parsedHeadSignature !== null &&
    persistedHeadSignature !== parsedHeadSignature;

  const shouldRebuild = shouldRebuildWorkspaceForSequenceRegression({
    watermark,
    parsedMaxSequence,
    hasTruncation,
    hasHeadMismatch,
  });
  let newLastSequence: number;
  if (shouldRebuild) {
    // Rebuild on truncation, head mismatch, or max-sequence rewinds. This removes
    // stale rows, including the zero-assistant-event truncation case.
    await replaceWorkspaceEvents(conn, workspaceId, parsedEvents);
    newLastSequence = parsedMaxSequence ?? -1;
  } else {
    let maxSequence = watermark.lastSequence;
    const eventsToInsert: IngestEvent[] = [];
    for (const event of parsedEvents) {
      maxSequence = Math.max(maxSequence, event.sequence);

      // Include the current watermark sequence so in-place rewrites with the same
      // historySequence refresh stale analytics rows instead of getting skipped forever.
      if (event.sequence < watermark.lastSequence) {
        continue;
      }

      eventsToInsert.push(event);
    }

    await replaceEventsByResponseIndex(conn, workspaceId, eventsToInsert);
    newLastSequence = maxSequence;
  }

  // Headless ingestion runs AFTER the chat-row writes (the rebuild path
  // deletes all of this workspace's rows, including headless ones) but
  // BEFORE the watermark advances: the watermark's change signal covers the
  // sidecar too, so a crash between watermark write and headless commit
  // would make the next syncCheck see the sidecar as current and strand
  // that spend. Failing before the watermark keeps ingestion retryable.
  await ingestHeadlessUsage(conn, workspaceId, sessionDir, workspaceMeta);

  await writeWatermark(conn, workspaceId, {
    lastSequence: newLastSequence,
    lastModified: stat.changeSignal,
  });
}

/**
 * Ingest the headless-usage.jsonl sidecar (status generation, memory sweeps —
 * AI spend with no chat.jsonl assistant row) into the events table.
 *
 * Idempotent delete + reinsert scoped to `tool_name LIKE 'headless:%'`:
 * headless rows use a NULL response_index, so the chat-row refresh paths
 * (replaceEventsByResponseIndex) never touch them, and this function never
 * touches chat-derived rows. The sidecar stays small (one line per background
 * call), so a full re-read per ingest pass is cheap — mirroring how
 * delegation rollups stay fresh on every pass.
 */
async function ingestHeadlessUsage(
  conn: DuckDBConnection,
  workspaceId: string,
  sessionDir: string,
  workspaceMeta: WorkspaceMeta
): Promise<void> {
  let contents: string;
  try {
    contents = await fs.readFile(path.join(sessionDir, HEADLESS_USAGE_FILE_NAME), "utf-8");
  } catch (error) {
    if (isRecord(error) && error.code === "ENOENT") {
      // Sidecar gone: mirror the delete+reinsert idempotency below with an
      // empty reinsert. Without this, a deleted sidecar (with chat.jsonl
      // intact) leaves stale headless rows behind while the caller advances
      // the watermark to the no-sidecar signal — permanently reporting
      // deleted spend. Cheap no-op for the common never-had-a-sidecar case.
      await conn.run("DELETE FROM events WHERE workspace_id = ? AND tool_name LIKE 'headless:%'", [
        workspaceId,
      ]);
      return;
    }
    throw error;
  }

  const inheritedContext: IngestEventContext = {
    workspaceId,
    workspaceMeta,
    agentId: null,
    thinkingLevel: null,
    responseIndex: null,
    // Match chat-row derivation: archived sub-agent sidecars flow through
    // here too (via ingestArchivedSubagentTranscripts → ingestWorkspace).
    isSubAgent: (workspaceMeta.parentWorkspaceId ?? "").length > 0,
  };

  const rows: EventRow[] = [];
  const lines = contents.split("\n");
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i].trim();
    if (line.length === 0) {
      continue;
    }
    let record: unknown;
    try {
      record = JSON.parse(line);
    } catch {
      log.warn("[analytics-etl] Skipping malformed headless-usage line", {
        workspaceId,
        lineNumber: i + 1,
      });
      continue;
    }
    if (!isRecord(record)) {
      continue;
    }
    const source = toOptionalString(record.source);
    const model = toOptionalString(record.model);
    const usage = parseUsage(record.usage);
    if (!source || !model || !usage) {
      continue;
    }

    const built = buildIngestEventRow({
      inheritedContext,
      model,
      metadataModel: toOptionalString(record.metadataModel),
      usage,
      providerMetadata: isRecord(record.providerMetadata) ? record.providerMetadata : undefined,
      toolName: `headless:${source}`,
      timestamp: toFiniteNumber(record.timestamp) ?? null,
      durationMs: null,
      ttftMs: null,
      outputTps: null,
    });
    if (!built.parsed.success) {
      log.warn("[analytics-etl] Skipping invalid headless-usage row", {
        workspaceId,
        lineNumber: i + 1,
      });
      continue;
    }
    rows.push(built.parsed.data);
  }

  await conn.run("BEGIN TRANSACTION");
  try {
    await conn.run("DELETE FROM events WHERE workspace_id = ? AND tool_name LIKE 'headless:%'", [
      workspaceId,
    ]);
    for (const row of rows) {
      await insertEventRow(
        conn,
        row,
        row.timestamp != null ? toUtcDateString(new Date(row.timestamp)) : null
      );
    }
    await conn.run("COMMIT");
  } catch (error) {
    await conn.run("ROLLBACK");
    throw error;
  }
}

/**
 * Scan a workspace's archived sub-agent transcripts and ingest each one.
 * The archive is flat: existing rollup logic in workspaceService copies
 * grandchild directories up to the parent level, so all descendants appear
 * as siblings under subagent-transcripts/.
 */
async function ingestArchivedSubagentTranscripts(
  conn: DuckDBConnection,
  sessionDir: string,
  parentMeta: WorkspaceMeta,
  parentWorkspaceId: string
): Promise<number> {
  const transcriptsDir = path.join(sessionDir, SUBAGENT_TRANSCRIPTS_DIR_NAME);

  let entries: Dirent[];
  try {
    entries = await fs.readdir(transcriptsDir, { withFileTypes: true });
  } catch (error) {
    if (isRecord(error) && error.code === "ENOENT") {
      // No archived transcripts directory — nothing to ingest.
      return 0;
    }

    log.warn("[analytics-etl] Failed to read archived sub-agent transcripts directory", {
      transcriptsDir,
      error: getErrorMessage(error),
    });
    return 0;
  }

  let ingested = 0;
  for (const entry of entries) {
    if (!entry.isDirectory()) {
      continue;
    }

    const childWorkspaceId = entry.name;
    const archivedSessionDir = path.join(transcriptsDir, childWorkspaceId);

    try {
      const archivedWorkspaceMeta = await readWorkspaceMetaFromDisk(archivedSessionDir);
      const overrideMeta: WorkspaceMeta = {
        projectPath: parentMeta.projectPath,
        projectName: parentMeta.projectName,
        workspaceName: archivedWorkspaceMeta.workspaceName,
      };

      // Archived transcripts created before workspace metadata persisted
      // parentWorkspaceId still represent sub-agent sessions. Only inject a
      // parent fallback when metadata is missing so we do not clobber the
      // correct parent for flattened descendants.
      if (!archivedWorkspaceMeta.parentWorkspaceId) {
        overrideMeta.parentWorkspaceId = parentWorkspaceId;
      }

      // Pass parent's projectPath/projectName so the child inherits
      // project-level attribution even if its own metadata.json is incomplete.
      await ingestWorkspace(conn, childWorkspaceId, archivedSessionDir, overrideMeta);
      ingested += 1;
    } catch (error) {
      log.warn("[analytics-etl] Failed to ingest archived sub-agent transcript", {
        childWorkspaceId,
        sessionDir,
        error: getErrorMessage(error),
      });
    }
  }

  return ingested;
}

/**
 * Core DB-write logic for delegation rollups.
 * Both ingestDelegationRollups (file-based) and writeDelegationRollupsFromParsed
 * (pre-read data) delegate to this function.
 */
async function writeDelegationRollupEntries(
  conn: DuckDBConnection,
  workspaceId: string,
  usageData: Record<string, unknown> | null,
  reportTokenByChildId: Map<string, number>,
  workspaceMeta: WorkspaceMeta
): Promise<void> {
  if (usageData == null) {
    await conn.run("DELETE FROM delegation_rollups WHERE parent_workspace_id = ?", [workspaceId]);
    return;
  }

  const rolledUpFrom = usageData.rolledUpFrom;
  if (!isRecord(rolledUpFrom) || Object.keys(rolledUpFrom).length === 0) {
    await conn.run("DELETE FROM delegation_rollups WHERE parent_workspace_id = ?", [workspaceId]);
    return;
  }

  await conn.run("BEGIN TRANSACTION");
  try {
    await conn.run("DELETE FROM delegation_rollups WHERE parent_workspace_id = ?", [workspaceId]);

    for (const [childId, entry] of Object.entries(rolledUpFrom)) {
      // Skip legacy boolean entries
      if (entry === true || !isRecord(entry)) continue;

      const totalTokens = toFiniteInteger(entry.totalTokens) ?? 0;
      const contextTokens = toFiniteInteger(entry.contextTokens) ?? 0;
      const inputTokens = toFiniteInteger(entry.inputTokens) ?? 0;
      const outputTokens = toFiniteInteger(entry.outputTokens) ?? 0;
      const reasoningTokens = toFiniteInteger(entry.reasoningTokens) ?? 0;
      const cachedTokens = toFiniteInteger(entry.cachedTokens) ?? 0;
      const cacheCreateTokens = toFiniteInteger(entry.cacheCreateTokens) ?? 0;
      const totalCostUsd = toFiniteNumber(entry.totalCostUsd) ?? 0;
      const agentType = toOptionalString(entry.agentType) ?? null;
      const model = toOptionalString(entry.model) ?? null;
      const rolledUpAtMs = toFiniteNumber(entry.rolledUpAtMs) ?? null;
      const reportTokenEstimate = reportTokenByChildId.get(childId) ?? 0;
      const dateBucket = dateBucketFromTimestamp(rolledUpAtMs);

      await conn.run(INSERT_DELEGATION_ROLLUP_SQL, [
        workspaceId,
        childId,
        workspaceMeta.projectPath ?? null,
        workspaceMeta.projectName ?? null,
        agentType,
        model,
        totalTokens,
        contextTokens,
        inputTokens,
        outputTokens,
        reasoningTokens,
        cachedTokens,
        cacheCreateTokens,
        reportTokenEstimate,
        totalCostUsd,
        // Unix-ms value: untyped binding truncates large integers to int32.
        toBindableNumber(rolledUpAtMs),
        dateBucket,
      ]);
    }
    await conn.run("COMMIT");
  } catch (error) {
    await conn.run("ROLLBACK");
    throw error;
  }
}

/** Read session-usage.json and subagent-reports.json, then insert delegation_rollups rows. */
async function ingestDelegationRollups(
  conn: DuckDBConnection,
  workspaceId: string,
  sessionDir: string,
  workspaceMeta: WorkspaceMeta
): Promise<void> {
  const usagePath = path.join(sessionDir, SESSION_USAGE_FILE_NAME);
  let usageData: Record<string, unknown> | null = null;

  try {
    const usageRaw = await fs.readFile(usagePath, "utf-8");
    const parsed: unknown = JSON.parse(usageRaw);
    if (isRecord(parsed)) {
      usageData = parsed;
    }
  } catch (error) {
    if (!(isRecord(error) && error.code === "ENOENT")) {
      log.warn("[analytics-etl] Failed to read session-usage.json for delegation rollups", {
        workspaceId,
        error: getErrorMessage(error),
      });
    }
    // usageData stays null -> writeDelegationRollupEntries clears stale rows.
  }

  // Read subagent-reports.json for reportTokenEstimate lookup.
  const reportTokenByChildId = await readReportTokenEstimates(sessionDir);
  await writeDelegationRollupEntries(
    conn,
    workspaceId,
    usageData,
    reportTokenByChildId,
    workspaceMeta
  );
}

async function readReportTokenEstimates(sessionDir: string): Promise<Map<string, number>> {
  const result = new Map<string, number>();
  const reportsPath = path.join(sessionDir, SUBAGENT_REPORTS_FILE_NAME);
  try {
    const raw = await fs.readFile(reportsPath, "utf-8");
    const parsed = JSON.parse(raw) as unknown;
    if (!isRecord(parsed)) return result;
    const artifacts = parsed.artifactsByChildTaskId;
    if (!isRecord(artifacts)) return result;
    for (const [childId, artifact] of Object.entries(artifacts)) {
      if (!isRecord(artifact)) continue;
      const estimate = toFiniteInteger(artifact.reportTokenEstimate);
      if (estimate != null && estimate > 0) {
        result.set(childId, estimate);
      }
    }
  } catch {
    // Missing or invalid file — not an error, just no report data.
  }
  return result;
}

async function readDelegationRollupFilesFromDisk(sessionDir: string): Promise<DelegationRollupRaw> {
  const usagePath = path.join(sessionDir, SESSION_USAGE_FILE_NAME);
  let usageData: Record<string, unknown> | null = null;
  try {
    const raw = await fs.readFile(usagePath, "utf-8");
    const parsed: unknown = JSON.parse(raw);
    if (isRecord(parsed)) {
      usageData = parsed;
    }
  } catch {
    // ENOENT or parse error → null
  }

  const reportTokenByChildId = await readReportTokenEstimates(sessionDir);
  return { usageData, reportTokenByChildId };
}

async function writeDelegationRollupsFromParsed(
  conn: DuckDBConnection,
  workspaceId: string,
  delegationRollupRaw: DelegationRollupRaw,
  workspaceMeta: WorkspaceMeta
): Promise<void> {
  assert(
    workspaceId.trim().length > 0,
    "writeDelegationRollupsFromParsed: workspaceId is required"
  );

  await writeDelegationRollupEntries(
    conn,
    workspaceId,
    delegationRollupRaw.usageData,
    delegationRollupRaw.reportTokenByChildId,
    workspaceMeta
  );
}

async function parseArchivedTranscriptsFromDisk(
  sessionDir: string,
  parentMeta: WorkspaceMeta,
  parentWorkspaceId: string
): Promise<ParsedWorkspaceData[]> {
  const transcriptsDir = path.join(sessionDir, SUBAGENT_TRANSCRIPTS_DIR_NAME);

  let entries: Dirent[];
  try {
    entries = await fs.readdir(transcriptsDir, { withFileTypes: true });
  } catch (error) {
    if (isRecord(error) && error.code === "ENOENT") {
      return [];
    }
    log.warn("[analytics-etl] Failed to read archived sub-agent transcripts directory", {
      transcriptsDir,
      error: getErrorMessage(error),
    });
    return [];
  }

  const results: ParsedWorkspaceData[] = [];
  for (const entry of entries) {
    if (!entry.isDirectory()) {
      continue;
    }

    const childWorkspaceId = entry.name;
    const archivedSessionDir = path.join(transcriptsDir, childWorkspaceId);

    try {
      const archivedWorkspaceMeta = await readWorkspaceMetaFromDisk(archivedSessionDir);
      const overrideMeta: WorkspaceMeta = {
        projectPath: parentMeta.projectPath,
        projectName: parentMeta.projectName,
        workspaceName: archivedWorkspaceMeta.workspaceName,
      };

      if (!archivedWorkspaceMeta.parentWorkspaceId) {
        overrideMeta.parentWorkspaceId = parentWorkspaceId;
      }

      const parsed = await parseWorkspaceFromDisk(
        childWorkspaceId,
        archivedSessionDir,
        overrideMeta
      );
      if (parsed) {
        results.push(parsed);
      }
    } catch (error) {
      log.warn("[analytics-etl] Failed to parse archived sub-agent transcript", {
        childWorkspaceId,
        sessionDir,
        error: getErrorMessage(error),
      });
    }
  }

  return results;
}

export async function parseWorkspaceFromDisk(
  workspaceId: string,
  sessionDir: string,
  suppliedMeta: WorkspaceMeta
): Promise<ParsedWorkspaceData | null> {
  assert(workspaceId.trim().length > 0, "parseWorkspaceFromDisk: workspaceId is required");
  assert(sessionDir.trim().length > 0, "parseWorkspaceFromDisk: sessionDir is required");

  const stat = await statSessionChatHistory(sessionDir);
  if (stat === null) {
    return null;
  }

  const persistedMeta = await readWorkspaceMetaFromDisk(sessionDir);
  const workspaceMeta = mergeWorkspaceMeta(persistedMeta, suppliedMeta);

  const chatContents = await readSessionChatHistoryContents(sessionDir);
  const lines = chatContents.split("\n").filter((line) => line.trim().length > 0);

  let responseIndex = 0;
  const events: IngestEvent[] = [];
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    assert(line != null, "parseWorkspaceFromDisk: line should not be null after filter");
    const message = parsePersistedMessage(line, workspaceId, i + 1);
    if (!message) {
      continue;
    }

    const extractedEvents = extractIngestEvents({
      workspaceId,
      workspaceMeta,
      message,
      lineNumber: i + 1,
      responseIndex,
    });
    if (extractedEvents.length === 0) {
      continue;
    }

    responseIndex += 1;
    events.push(...extractedEvents);
  }

  const delegationRollupRaw = await readDelegationRollupFilesFromDisk(sessionDir);
  const archivedTranscripts = await parseArchivedTranscriptsFromDisk(
    sessionDir,
    workspaceMeta,
    workspaceId
  );

  return {
    workspaceId,
    sessionDir,
    events,
    stat: { mtimeMs: stat.mtimeMs, changeSignal: stat.changeSignal },
    workspaceMeta,
    delegationRollupRaw,
    archivedTranscripts,
  };
}

interface CollectedEvents {
  eventsByWorkspace: Map<string, IngestEvent[]>;
  /** Tracks the chat.jsonl mtime of the dedup winner per workspace ID. */
  winnerMtimes: Map<string, number>;
}

/** Collect parsed workspaces (including archived transcripts) into deduplicated workspace event groups. */
function collectAllEvents(parsed: ParsedWorkspaceData[]): CollectedEvents {
  // Workspace-level dedup with recency: if the same workspace_id appears from multiple
  // sources (e.g. top-level session + archived sub-agent transcript), keep the
  // freshest occurrence by mtime so traversal order does not affect rebuild output.
  const eventsByWorkspace = new Map<string, IngestEvent[]>();
  const winnerMtimes = new Map<string, number>();

  function collect(workspaces: ParsedWorkspaceData[]): void {
    for (const workspace of workspaces) {
      const existingMtime = winnerMtimes.get(workspace.workspaceId);
      if (existingMtime == null || workspace.stat.mtimeMs >= existingMtime) {
        eventsByWorkspace.set(workspace.workspaceId, workspace.events);
        winnerMtimes.set(workspace.workspaceId, workspace.stat.mtimeMs);
      }

      if (workspace.archivedTranscripts.length > 0) {
        collect(workspace.archivedTranscripts);
      }
    }
  }

  collect(parsed);
  return { eventsByWorkspace, winnerMtimes };
}

const PRICING_FINGERPRINT_META_KEY = "pricing_fingerprint";

let cachedPricingFingerprint: string | undefined;

/**
 * Fingerprint of the bundled pricing tables. Event costs are computed at
 * ingest time from these tables, so a fingerprint change means previously
 * ingested rows may carry stale costs (typically $0 for models that were
 * unknown at ingest time) and need a full rebuild to reprice.
 *
 * Cached per process: the tables are compiled into the bundle and cannot
 * change while the worker is running.
 */
export function getCurrentPricingFingerprint(): string {
  cachedPricingFingerprint ??= createHash("sha256")
    .update(JSON.stringify(modelsExtra))
    .update(JSON.stringify(modelsData))
    .digest("hex");
  return cachedPricingFingerprint;
}

export async function readStoredPricingFingerprint(conn: DuckDBConnection): Promise<string | null> {
  const result = await conn.run("SELECT value FROM ingest_meta WHERE key = ?", [
    PRICING_FINGERPRINT_META_KEY,
  ]);
  const rows = await result.getRowObjectsJS();
  const value = rows[0]?.value;
  return typeof value === "string" && value.length > 0 ? value : null;
}

export async function storePricingFingerprint(conn: DuckDBConnection): Promise<void> {
  await conn.run("INSERT OR REPLACE INTO ingest_meta (key, value) VALUES (?, ?)", [
    PRICING_FINGERPRINT_META_KEY,
    getCurrentPricingFingerprint(),
  ]);
}

const ETL_SEMANTICS_META_KEY = "etl_semantics_version";

/**
 * Bump when the ETL starts deriving NEW columns/semantics from data that
 * already exists in chat.jsonl: previously ingested rows lack the new fields,
 * so a version mismatch forces one full rebuild to backfill them from the
 * durable source. Same read → decide → store-after-success flow as the
 * pricing fingerprint above.
 *
 * refusal-analytics-v1: requested_model / refused_models_json columns from
 * metadata.modelFallback.
 * refusal-analytics-v2: events.model keyed by analyticsAttributionModel,
 * downgrade columns gated on non-partial turns, strict modelFallback chain
 * validation.
 */
export const CURRENT_ETL_SEMANTICS_VERSION = "refusal-analytics-v2";

export async function readStoredEtlSemanticsVersion(
  conn: DuckDBConnection
): Promise<string | null> {
  const result = await conn.run("SELECT value FROM ingest_meta WHERE key = ?", [
    ETL_SEMANTICS_META_KEY,
  ]);
  const rows = await result.getRowObjectsJS();
  const value = rows[0]?.value;
  return typeof value === "string" && value.length > 0 ? value : null;
}

export async function storeEtlSemanticsVersion(conn: DuckDBConnection): Promise<void> {
  await conn.run("INSERT OR REPLACE INTO ingest_meta (key, value) VALUES (?, ?)", [
    ETL_SEMANTICS_META_KEY,
    CURRENT_ETL_SEMANTICS_VERSION,
  ]);
}

export async function rebuildAll(
  conn: DuckDBConnection,
  sessionsDir: string,
  workspaceMetaById: WorkspaceMetaById = {}
): Promise<{ workspacesIngested: number; failedWorkspaceIds: Set<string> }> {
  assert(sessionsDir.trim().length > 0, "rebuildAll: sessionsDir is required");
  assert(
    isRecord(workspaceMetaById) && !Array.isArray(workspaceMetaById),
    "rebuildAll: workspaceMetaById must be an object"
  );

  await conn.run("BEGIN TRANSACTION");
  try {
    // Reset analytics tables atomically so a crash cannot leave empty events with
    // stale watermarks or stale delegation rollups that suppress rebuild accuracy.
    await conn.run("DELETE FROM events");
    await conn.run("DELETE FROM ingest_watermarks");
    await conn.run("DELETE FROM delegation_rollups");
    await conn.run("COMMIT");
  } catch (error) {
    await conn.run("ROLLBACK");
    throw error;
  }

  let entries: Dirent[] | null = null;
  try {
    entries = await fs.readdir(sessionsDir, { withFileTypes: true });
  } catch (error) {
    if (isRecord(error) && error.code === "ENOENT") {
      return { workspacesIngested: 0, failedWorkspaceIds: new Set() };
    }

    throw error;
  }

  assert(entries, "rebuildAll expected a directory listing");

  const directoryEntries = entries.filter((entry) => entry.isDirectory());

  const allParsed: ParsedWorkspaceData[] = [];
  for (let i = 0; i < directoryEntries.length; i += REBUILD_CONCURRENCY) {
    const batch = directoryEntries.slice(i, i + REBUILD_CONCURRENCY);

    const results = await Promise.allSettled(
      batch.map((entry) => {
        const workspaceId = entry.name;
        const sessionDir = path.join(sessionsDir, workspaceId);
        const suppliedWorkspaceMeta = workspaceMetaById[workspaceId] ?? {};
        return parseWorkspaceFromDisk(workspaceId, sessionDir, suppliedWorkspaceMeta);
      })
    );

    for (let j = 0; j < results.length; j++) {
      const result = results[j];
      const batchEntry = batch[j];
      assert(result, "rebuildAll: Promise.allSettled result should always be present");

      if (result.status === "fulfilled") {
        if (result.value != null) {
          allParsed.push(result.value);
        }
        continue;
      }

      log.warn("[analytics-etl] Failed to parse workspace during rebuild", {
        workspaceId: batchEntry?.name,
        error: getErrorMessage(result.reason),
      });
    }
  }

  // Phase 2a: Per-workspace bulk-append with isolation.
  // Keep rebuild resilient: a malformed event batch in one workspace should not
  // prevent unrelated workspace analytics data from being rebuilt.
  const { eventsByWorkspace, winnerMtimes } = collectAllEvents(allParsed);
  const failedWorkspaceIds = new Set<string>();
  for (const [workspaceId, events] of eventsByWorkspace) {
    try {
      await appendEvents(conn, events);
    } catch (error) {
      failedWorkspaceIds.add(workspaceId);
      log.warn("[analytics-etl] Failed to append events for workspace during rebuild", {
        workspaceId,
        error: getErrorMessage(error),
      });
    }
  }

  async function writeWorkspaceMetadata(
    workspaces: ParsedWorkspaceData[],
    failedWorkspaceIds: Set<string>,
    winnerMtimes: Map<string, number>
  ): Promise<void> {
    for (const workspace of workspaces) {
      try {
        // Only write metadata for the dedup winner instance (matching mtime)
        // that also appended successfully. This prevents stale duplicates with
        // the same workspaceId from overwriting fresh winner metadata.
        const winnerMtime = winnerMtimes.get(workspace.workspaceId);
        const isDedupeWinner = winnerMtime != null && workspace.stat.mtimeMs === winnerMtime;
        const shouldWriteMetadata =
          isDedupeWinner && !failedWorkspaceIds.has(workspace.workspaceId);

        if (shouldWriteMetadata) {
          // Rebuild wiped all events rows up front, so re-ingest the
          // headless-usage sidecar for dedup winners. Must run BEFORE the
          // watermark write: the watermark's change signal covers the sidecar,
          // so a crash after the watermark but before this commit would strand
          // the sidecar spend as "current" on the next syncCheck.
          await ingestHeadlessUsage(
            conn,
            workspace.workspaceId,
            workspace.sessionDir,
            workspace.workspaceMeta
          );

          const maxSequence = getMaxSequence(workspace.events) ?? -1;
          await writeWatermark(conn, workspace.workspaceId, {
            lastSequence: maxSequence,
            // Watermark staleness compares against the combined change signal,
            // not the raw mtime (which is only used for dedup-winner recency).
            lastModified: workspace.stat.changeSignal,
          });

          await writeDelegationRollupsFromParsed(
            conn,
            workspace.workspaceId,
            workspace.delegationRollupRaw,
            workspace.workspaceMeta
          );
        }
      } catch (error) {
        // The workspace's chat rows are already appended but its watermark may
        // not be written; report it failed so the post-rebuild sweep's
        // missing-watermark evidence does not delete those rows.
        failedWorkspaceIds.add(workspace.workspaceId);
        log.warn("[analytics-etl] Failed to write metadata during rebuild", {
          workspaceId: workspace.workspaceId,
          error: getErrorMessage(error),
        });
      }

      // Always recurse into archived children regardless of parent metadata
      // write eligibility so successful child workspaces still get metadata.
      if (workspace.archivedTranscripts.length > 0) {
        await writeWorkspaceMetadata(
          workspace.archivedTranscripts,
          failedWorkspaceIds,
          winnerMtimes
        );
      }
    }
  }

  // Phase 2b: Write metadata only for dedup winners that appended successfully.
  await writeWorkspaceMetadata(allParsed, failedWorkspaceIds, winnerMtimes);

  let workspacesIngested = 0;
  for (const workspace of allParsed) {
    if (!failedWorkspaceIds.has(workspace.workspaceId)) {
      workspacesIngested += 1;
    }
  }

  return { workspacesIngested, failedWorkspaceIds };
}

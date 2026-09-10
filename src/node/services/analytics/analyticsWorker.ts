import assert from "node:assert/strict";
import { parentPort } from "node:worker_threads";
import { DuckDBInstance, type DuckDBConnection } from "@duckdb/node-api";
import { getErrorMessage } from "@/common/utils/errors";
import { log } from "@/node/services/log";
import { decideSyncPlan, type SyncAction } from "./backfillDecision";
import { shouldCheckpointAfterSync } from "./checkpointDecision";
import {
  CURRENT_ETL_SEMANTICS_VERSION,
  clearWorkspaceAnalyticsState,
  deleteCorruptAnalyticsRows,
  getCurrentPricingFingerprint,
  ingestWorkspace,
  readStoredEtlSemanticsVersion,
  readStoredPricingFingerprint,
  rebuildAll,
  statSessionChatHistory,
  storeEtlSemanticsVersion,
  storePricingFingerprint,
} from "./etl";
import {
  CREATE_DELEGATION_ROLLUPS_TABLE_SQL,
  CREATE_EVENTS_TABLE_SQL,
  CREATE_INGEST_META_TABLE_SQL,
  CREATE_WATERMARK_TABLE_SQL,
} from "./schemaSql";
import { discoverAllWorkspaces } from "./workspaceDiscovery";
import { executeNamedQuery, executeRawQuery, type RawQueryResult } from "./queries";

interface WorkerTaskRequest {
  messageId: number;
  taskName: string;
  data: unknown;
}

interface WorkerShutdownRequest {
  type: "shutdown";
}

type WorkerRequest = WorkerTaskRequest | WorkerShutdownRequest;

interface WorkerSuccessResponse {
  messageId: number;
  result: unknown;
}

interface WorkerErrorResponse {
  messageId: number;
  error: {
    message: string;
    stack?: string;
  };
}

interface InitData {
  dbPath: string;
}

interface WorkspaceMeta {
  projectPath?: string;
  projectName?: string;
  workspaceName?: string;
  parentWorkspaceId?: string;
}

interface IngestData {
  workspaceId: string;
  sessionDir: string;
  meta?: WorkspaceMeta;
}

interface RebuildAllData {
  sessionsDir: string;
  workspaceMetaById?: Record<string, WorkspaceMeta>;
}

interface SyncCheckData {
  sessionsDir: string;
  workspaceMetaById: Record<string, WorkspaceMeta>;
}

interface SyncCheckResult {
  action: SyncAction;
  workspacesIngested: number;
  workspacesPurged: number;
}

interface ClearWorkspaceData {
  workspaceId: string;
}

interface QueryData {
  queryName: string;
  params: Record<string, unknown>;
}

interface RawQueryData {
  sql: string;
}

const EVENTS_COLUMN_MIGRATIONS_SQL = [
  "ALTER TABLE events ADD COLUMN IF NOT EXISTS tool_name TEXT",
  // Refusal-fallback downgrade columns: order must match CREATE_EVENTS_TABLE_SQL
  // so migrated and fresh DBs share the physical column order the appender uses.
  "ALTER TABLE events ADD COLUMN IF NOT EXISTS requested_model VARCHAR",
  "ALTER TABLE events ADD COLUMN IF NOT EXISTS refused_models_json VARCHAR",
] as const;

const DELEGATION_ROLLUPS_COLUMN_MIGRATIONS_SQL = [
  "ALTER TABLE delegation_rollups ADD COLUMN IF NOT EXISTS input_tokens INTEGER DEFAULT 0",
  "ALTER TABLE delegation_rollups ADD COLUMN IF NOT EXISTS output_tokens INTEGER DEFAULT 0",
  "ALTER TABLE delegation_rollups ADD COLUMN IF NOT EXISTS reasoning_tokens INTEGER DEFAULT 0",
  "ALTER TABLE delegation_rollups ADD COLUMN IF NOT EXISTS cached_tokens INTEGER DEFAULT 0",
  "ALTER TABLE delegation_rollups ADD COLUMN IF NOT EXISTS cache_create_tokens INTEGER DEFAULT 0",
] as const;

let instance: DuckDBInstance | null = null;
let conn: DuckDBConnection | null = null;
let readOnlyConn: DuckDBConnection | null = null;
let isShuttingDown = false;

function getConn(): DuckDBConnection {
  assert(conn, "analytics worker has not been initialized");
  return conn;
}

function getReadOnlyConn(): DuckDBConnection {
  assert(readOnlyConn, "analytics worker read-only connection has not been initialized");
  return readOnlyConn;
}

async function handleInit(data: InitData): Promise<void> {
  assert(data.dbPath.trim().length > 0, "init requires a non-empty dbPath");
  assert(
    instance == null && conn == null && readOnlyConn == null,
    "analytics worker init must only run once per process"
  );

  const createdInstance = await DuckDBInstance.create(data.dbPath);
  instance = createdInstance;
  conn = await createdInstance.connect();
  readOnlyConn = await createdInstance.connect();

  // DuckDB access_mode is immutable after opening a database handle. We still
  // keep a dedicated connection for raw queries, and enforce read-only behavior
  // in executeRawQuery by wrapping user SQL in a SELECT subquery.

  const activeConn = getConn();
  await activeConn.run(CREATE_EVENTS_TABLE_SQL);
  await activeConn.run(CREATE_WATERMARK_TABLE_SQL);
  await activeConn.run(CREATE_DELEGATION_ROLLUPS_TABLE_SQL);
  await activeConn.run(CREATE_INGEST_META_TABLE_SQL);
  for (const migrationSql of EVENTS_COLUMN_MIGRATIONS_SQL) {
    await activeConn.run(migrationSql);
  }
  for (const migrationSql of DELEGATION_ROLLUPS_COLUMN_MIGRATIONS_SQL) {
    await activeConn.run(migrationSql);
  }

  await sweepCorruptRows("init");
}

/**
 * Delete corruption-class rows and log when anything was actually removed.
 * Best-effort: a failed sweep must never reject init (which would cache a
 * worker error and disable analytics until restart), so errors are logged
 * and swallowed. Runs only at init and after rebuilds: missing-watermark
 * evidence is unsafe after ordinary ingests (see deleteCorruptAnalyticsRows).
 */
async function sweepCorruptRows(
  context: string,
  preserveWorkspaceIds?: ReadonlySet<string>
): Promise<void> {
  try {
    const deleted = await deleteCorruptAnalyticsRows(getConn(), preserveWorkspaceIds);
    if (deleted > 0) {
      log.info(`[analytics-worker] Deleted ${deleted} corrupt analytics row(s) (${context})`);
    }
  } catch (error) {
    log.warn(`[analytics-worker] Corrupt-row sweep failed (${context}): ${getErrorMessage(error)}`);
  }
}

async function handleIngest(data: IngestData): Promise<void> {
  assert(data.workspaceId.trim().length > 0, "ingest requires workspaceId");
  assert(data.sessionDir.trim().length > 0, "ingest requires sessionDir");

  await ingestWorkspace(getConn(), data.workspaceId, data.sessionDir, data.meta ?? {});
}

async function handleRebuildAll(data: RebuildAllData): Promise<{ workspacesIngested: number }> {
  assert(data.sessionsDir.trim().length > 0, "rebuildAll requires sessionsDir");
  if (data.workspaceMetaById != null) {
    assert(
      isRecord(data.workspaceMetaById) && !Array.isArray(data.workspaceMetaById),
      "rebuildAll workspaceMetaById must be an object when provided"
    );
  }

  const result = await rebuildAll(getConn(), data.sessionsDir, data.workspaceMetaById ?? {});
  await sweepCorruptRows("rebuildAll", result.failedWorkspaceIds);
  // A completed rebuild priced everything with the current tables and derived
  // all current ETL columns; refresh the fingerprint and semantics version so
  // the next sync check does not schedule a redundant rebuild.
  await storePricingFingerprint(getConn());
  await storeEtlSemanticsVersion(getConn());
  return { workspacesIngested: result.workspacesIngested };
}

async function handleClearWorkspace(data: ClearWorkspaceData): Promise<void> {
  assert(data.workspaceId.trim().length > 0, "clearWorkspace requires workspaceId");
  await clearWorkspaceAnalyticsState(getConn(), data.workspaceId);
}

async function handleQuery(data: QueryData): Promise<unknown> {
  assert(data.queryName.trim().length > 0, "query requires queryName");
  return executeNamedQuery(getConn(), data.queryName, data.params);
}

async function handleRawQuery(data: RawQueryData): Promise<RawQueryResult> {
  assert(
    typeof data.sql === "string" && data.sql.trim().length > 0,
    "rawQuery requires non-empty sql"
  );
  return executeRawQuery(getReadOnlyConn(), data.sql);
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}

function parseNonNegativeInteger(value: unknown): number | null {
  if (typeof value === "bigint") {
    const parsed = Number(value);
    if (!Number.isSafeInteger(parsed) || parsed < 0) {
      return null;
    }

    return parsed;
  }

  if (typeof value !== "number" || !Number.isInteger(value) || value < 0) {
    return null;
  }

  return value;
}

function parseBooleanLike(value: unknown): boolean | null {
  if (typeof value === "boolean") {
    return value;
  }

  const parsed = parseNonNegativeInteger(value);
  if (parsed === 0) {
    return false;
  }

  if (parsed === 1) {
    return true;
  }

  return null;
}

function parseNonEmptyString(value: unknown): string | null {
  if (typeof value !== "string") {
    return null;
  }

  if (value.trim().length === 0) {
    return null;
  }

  return value;
}

/** Watermarked workspace IDs mapped to their stored change signal (last_modified). */
async function listWatermarkSignalsById(): Promise<Map<string, number>> {
  const result = await getConn().run("SELECT workspace_id, last_modified FROM ingest_watermarks");
  const rows = await result.getRowObjectsJS();

  const watermarkSignalsById = new Map<string, number>();
  for (const row of rows) {
    const workspaceId = parseNonEmptyString(row.workspace_id);
    assert(
      workspaceId !== null,
      "syncCheck expected ingest_watermarks rows to have non-empty workspace_id"
    );
    assert(
      typeof row.last_modified === "number" && Number.isFinite(row.last_modified),
      "syncCheck expected ingest_watermarks rows to have a finite last_modified"
    );
    watermarkSignalsById.set(workspaceId, row.last_modified);
  }

  return watermarkSignalsById;
}

async function checkpointIfNeeded(
  action: SyncAction,
  workspacesIngested: number,
  workspacesPurged: number
): Promise<void> {
  if (!shouldCheckpointAfterSync(action, workspacesIngested, workspacesPurged)) {
    return;
  }

  try {
    await getConn().run("CHECKPOINT");
  } catch (error) {
    // Non-fatal: DuckDB will auto-checkpoint eventually or on next clean shutdown.
    process.stderr.write(
      `[analytics-worker] Post-sync checkpoint failed (non-fatal): ${getErrorMessage(error)}\n`
    );
  }
}

async function handleSyncCheck(data: SyncCheckData): Promise<SyncCheckResult> {
  assert(data.sessionsDir.trim().length > 0, "syncCheck requires sessionsDir");
  assert(
    isRecord(data.workspaceMetaById) && !Array.isArray(data.workspaceMetaById),
    "syncCheck workspaceMetaById must be an object"
  );

  const syncStartMs = performance.now();

  const result = await getConn().run(`
    SELECT
      (SELECT COUNT(*) FROM events) AS event_count,
      (SELECT COUNT(*) FROM ingest_watermarks) AS watermark_count,
      (SELECT EXISTS(SELECT 1 FROM ingest_watermarks WHERE last_sequence >= 0))
        AS has_any_watermark_at_or_above_zero
  `);
  const rows = await result.getRowObjectsJS();
  assert(rows.length === 1, "syncCheck should return exactly one row");

  const eventCount = parseNonNegativeInteger(rows[0].event_count);
  assert(eventCount !== null, "syncCheck expected a non-negative integer event_count");

  const watermarkCount = parseNonNegativeInteger(rows[0].watermark_count);
  assert(watermarkCount !== null, "syncCheck expected a non-negative integer watermark_count");

  const hasAnyWatermarkAtOrAboveZero = parseBooleanLike(rows[0].has_any_watermark_at_or_above_zero);
  assert(
    hasAnyWatermarkAtOrAboveZero !== null,
    "syncCheck expected boolean has_any_watermark_at_or_above_zero"
  );

  const discoveredWorkspacesById = await discoverAllWorkspaces(data.sessionsDir);
  const knownWorkspaceIds = new Set(discoveredWorkspacesById.keys());

  const watermarkSignalsById = await listWatermarkSignalsById();
  const watermarkWorkspaceIds = new Set(watermarkSignalsById.keys());
  assert(
    watermarkWorkspaceIds.size === watermarkCount,
    "syncCheck expected watermark_count to match ingest_watermarks workspace IDs"
  );

  // Watermarked workspaces whose on-disk signal drifted since the last ingest:
  // writes (chat or headless-usage sidecar) that landed after the last worker
  // pass but before an app exit. An ID-only diff would noop and strand that
  // spend until an unrelated ingest touches the workspace.
  const changedSignalWorkspaceIds = new Set<string>();
  for (const [workspaceId, discovered] of discoveredWorkspacesById) {
    const storedSignal = watermarkSignalsById.get(workspaceId);
    if (storedSignal === undefined) {
      continue; // No watermark — already covered by the ID diff below.
    }
    try {
      const stat = await statSessionChatHistory(discovered.sessionDir);
      if (stat !== null && stat.changeSignal !== storedSignal) {
        changedSignalWorkspaceIds.add(workspaceId);
      }
    } catch (error) {
      process.stderr.write(
        `[analytics-worker] Failed to stat workspace during sync check (${workspaceId}): ${getErrorMessage(error)}\n`
      );
    }
  }

  // Event costs are computed at ingest time; when the bundled pricing tables
  // change (app upgrade), rows priced under the old tables — typically $0 for
  // then-unknown models — must be repriced via a full rebuild.
  const storedPricingFingerprint = await readStoredPricingFingerprint(getConn());
  const pricingFingerprintChanged = storedPricingFingerprint !== getCurrentPricingFingerprint();

  // ETL semantics version: rows ingested before a new derived column existed
  // (e.g. refusal-downgrade metadata) must be backfilled via a full rebuild.
  const storedEtlSemanticsVersion = await readStoredEtlSemanticsVersion(getConn());
  const semanticsVersionChanged = storedEtlSemanticsVersion !== CURRENT_ETL_SEMANTICS_VERSION;

  const plan = decideSyncPlan({
    eventCount,
    watermarkCount,
    knownWorkspaceIds,
    watermarkWorkspaceIds,
    hasAnyWatermarkAtOrAboveZero,
    pricingFingerprintChanged,
    semanticsVersionChanged,
    changedSignalWorkspaceIds,
  });

  // Persist the current fingerprint for noop/incremental plans where nothing
  // was stale (empty events table or unchanged pricing) so the mismatch does
  // not linger. For full rebuilds, store only after the rebuild succeeds so a
  // crashed repricing rebuild re-triggers on the next sync check.
  if (pricingFingerprintChanged && plan.action !== "full_rebuild") {
    await storePricingFingerprint(getConn());
  }
  // Same store-after-success policy for the ETL semantics version.
  if (semanticsVersionChanged && plan.action !== "full_rebuild") {
    await storeEtlSemanticsVersion(getConn());
  }

  if (plan.action === "noop") {
    const elapsedMs = Math.round(performance.now() - syncStartMs);
    process.stderr.write(
      `[analytics-worker] syncCheck: plan=noop, workspacesOnDisk=${knownWorkspaceIds.size}, watermarksInDB=${watermarkWorkspaceIds.size} (${elapsedMs}ms)\n`
    );

    return {
      action: "noop",
      workspacesIngested: 0,
      workspacesPurged: 0,
    };
  }

  if (plan.action === "full_rebuild") {
    const { workspacesIngested, failedWorkspaceIds } = await rebuildAll(
      getConn(),
      data.sessionsDir,
      data.workspaceMetaById
    );
    await sweepCorruptRows("syncCheck full_rebuild", failedWorkspaceIds);
    if (pricingFingerprintChanged) {
      await storePricingFingerprint(getConn());
    }
    if (semanticsVersionChanged) {
      await storeEtlSemanticsVersion(getConn());
    }
    await checkpointIfNeeded(plan.action, workspacesIngested, 0);

    const elapsedMs = Math.round(performance.now() - syncStartMs);
    process.stderr.write(
      `[analytics-worker] syncCheck: plan=full_rebuild, workspacesIngested=${workspacesIngested}, workspacesOnDisk=${knownWorkspaceIds.size}, repricedForPricingChange=${pricingFingerprintChanged} (${elapsedMs}ms)\n`
    );

    return {
      action: "full_rebuild",
      workspacesIngested,
      workspacesPurged: 0,
    };
  }

  let workspacesIngested = 0;
  for (const workspaceId of plan.workspaceIdsToIngest) {
    const discoveredWorkspace = discoveredWorkspacesById.get(workspaceId);
    assert(
      discoveredWorkspace != null,
      `syncCheck expected discovered workspace entry for ${workspaceId}`
    );

    let workspaceMeta = data.workspaceMetaById[workspaceId];
    if (workspaceMeta == null && discoveredWorkspace.parentWorkspaceId != null) {
      // Archived subagent workspaces are keyed under their parent workspace IDs in config
      // metadata. Inherit parent project metadata to match rebuildAll behavior.
      const parentMeta = data.workspaceMetaById[discoveredWorkspace.parentWorkspaceId];
      if (parentMeta != null) {
        workspaceMeta = {
          projectPath: parentMeta.projectPath,
          projectName: parentMeta.projectName,
        };
      }
    }
    workspaceMeta ??= {};

    try {
      await ingestWorkspace(getConn(), workspaceId, discoveredWorkspace.sessionDir, workspaceMeta);
      workspacesIngested += 1;
    } catch (error) {
      process.stderr.write(
        `[analytics-worker] Failed to ingest workspace during sync check (${workspaceId}): ${getErrorMessage(error)}\n`
      );
    }
  }

  let workspacesPurged = 0;
  for (const workspaceId of plan.workspaceIdsToPurge) {
    try {
      await clearWorkspaceAnalyticsState(getConn(), workspaceId);
      workspacesPurged += 1;
    } catch (error) {
      process.stderr.write(
        `[analytics-worker] Failed to purge workspace during sync check (${workspaceId}): ${getErrorMessage(error)}\n`
      );
    }
  }

  await checkpointIfNeeded(plan.action, workspacesIngested, workspacesPurged);

  const elapsedMs = Math.round(performance.now() - syncStartMs);
  process.stderr.write(
    `[analytics-worker] syncCheck: plan=incremental, ingested=${workspacesIngested}, purged=${workspacesPurged}, toIngest=${plan.workspaceIdsToIngest.length}, toPurge=${plan.workspaceIdsToPurge.length} (${elapsedMs}ms)\n`
  );

  return {
    action: "incremental",
    workspacesIngested,
    workspacesPurged,
  };
}

function isWorkerTaskRequest(message: unknown): message is WorkerTaskRequest {
  if (!isRecord(message)) {
    return false;
  }

  const messageId = message.messageId;
  if (typeof messageId !== "number" || !Number.isInteger(messageId) || messageId < 0) {
    return false;
  }

  const taskName = message.taskName;
  return typeof taskName === "string" && taskName.trim().length > 0;
}

function isWorkerShutdownRequest(message: unknown): message is WorkerShutdownRequest {
  return isRecord(message) && message.type === "shutdown";
}

function closeDuckDb(): void {
  const activeReadOnlyConn = readOnlyConn;
  const activeConn = conn;
  const activeInstance = instance;
  readOnlyConn = null;
  conn = null;
  instance = null;

  try {
    if (activeReadOnlyConn != null) {
      activeReadOnlyConn.disconnectSync();
    }
  } finally {
    try {
      if (activeConn != null) {
        activeConn.disconnectSync();
      }
    } finally {
      if (activeInstance != null) {
        activeInstance.closeSync();
      }
    }
  }
}

// Shutdown runs in the serialized message queue, so we only close DuckDB
// after earlier ETL/query tasks have completed on this worker thread.
function handleShutdown(): void {
  if (isShuttingDown) {
    return;
  }

  isShuttingDown = true;
  let exitCode = 0;

  try {
    process.stderr.write("[analytics-worker] Shutting down, closing DuckDB\n");
    closeDuckDb();
  } catch (error) {
    exitCode = 1;
    process.stderr.write(
      `[analytics-worker] Failed to close DuckDB during shutdown: ${getErrorMessage(error)}\n`
    );
  }

  // Bun's worker_threads shim used by UI tests can expose a parentPort without the
  // full EventEmitter cleanup surface. Treat listener removal/port close as best-effort
  // so shutdown still completes after the transcript-layout regression tests exercise
  // repeated app harness teardown.
  workerParentPort.removeAllListeners?.("message");
  workerParentPort.close?.();
  process.exit(exitCode);
}

async function dispatchTask(taskName: string, data: unknown): Promise<unknown> {
  switch (taskName) {
    case "init":
      return handleInit(data as InitData);
    case "ingest":
      return handleIngest(data as IngestData);
    case "rebuildAll":
      return handleRebuildAll(data as RebuildAllData);
    case "clearWorkspace":
      return handleClearWorkspace(data as ClearWorkspaceData);
    case "query":
      return handleQuery(data as QueryData);
    case "rawQuery":
      return handleRawQuery(data as RawQueryData);
    case "syncCheck":
      return handleSyncCheck(data as SyncCheckData);
    default:
      throw new Error(`Unknown analytics worker task: ${taskName}`);
  }
}

function requireParentPort(): NonNullable<typeof parentPort> {
  if (parentPort == null) {
    throw new Error("analytics worker requires a parentPort");
  }

  return parentPort;
}

const workerParentPort = requireParentPort();

function toResponseMessageId(message: WorkerTaskRequest): number {
  if (Number.isInteger(message.messageId) && message.messageId >= 0) {
    return message.messageId;
  }

  return -1;
}

function postWorkerResponse(response: WorkerSuccessResponse | WorkerErrorResponse): void {
  try {
    workerParentPort.postMessage(response);
  } catch (error) {
    process.stderr.write(
      `[analytics-worker] Failed to post worker response: ${getErrorMessage(error)}\n`
    );
  }
}

async function processMessage(message: WorkerTaskRequest): Promise<void> {
  const responseMessageId = toResponseMessageId(message);

  try {
    assert(
      Number.isInteger(message.messageId) && message.messageId >= 0,
      "analytics worker message must include a non-negative integer messageId"
    );
    assert(
      typeof message.taskName === "string" && message.taskName.trim().length > 0,
      "analytics worker message requires taskName"
    );

    const result = await dispatchTask(message.taskName, message.data);
    const response: WorkerSuccessResponse = {
      messageId: responseMessageId,
      result,
    };
    postWorkerResponse(response);
  } catch (error) {
    const response: WorkerErrorResponse = {
      messageId: responseMessageId,
      error: {
        message: getErrorMessage(error),
        stack: error instanceof Error ? error.stack : undefined,
      },
    };
    postWorkerResponse(response);
  }
}

let messageQueue: Promise<void> = Promise.resolve();

workerParentPort.on("message", (message: WorkerRequest) => {
  // Serialize ETL/query tasks and shutdown so dispose can wait for in-flight
  // DuckDB work to finish before we disconnect and close the database.
  if (isWorkerShutdownRequest(message)) {
    messageQueue = messageQueue.then(
      () => handleShutdown(),
      () => handleShutdown()
    );
    return;
  }

  if (!isWorkerTaskRequest(message)) {
    process.stderr.write("[analytics-worker] Dropping invalid worker message payload\n");
    return;
  }

  messageQueue = messageQueue.then(
    () => processMessage(message),
    () => processMessage(message)
  );
});

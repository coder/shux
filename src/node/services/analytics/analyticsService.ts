import { ORPCError } from "@orpc/server";
import { getErrorMessage } from "@/common/utils/errors";
import assert from "node:assert/strict";
import * as fs from "node:fs/promises";
import * as path from "node:path";
import * as crypto from "node:crypto";
import { Worker } from "node:worker_threads";
import writeFileAtomic from "write-file-atomic";
import { toUtcDateString } from "@/node/services/analytics/dateUtils";
import type {
  AgentCostRow,
  DelegationAgentBreakdownRow,
  DelegationSummaryTotalsRow,
  HistogramBucket,
  ProviderCacheHitModelRow,
  SpendByModelRow,
  SpendByProjectRow,
  SpendOverTimeRow,
  SummaryRow,
  TimingPercentilesRow,
  TokensByModelRow,
} from "@/common/orpc/schemas/analytics";
import type { SavedQuery } from "@/common/types/savedQueries";
import { getModelProvider } from "@/common/utils/ai/models";
import { ensurePrivateDir } from "@/node/utils/fs";
import type { Config } from "@/node/config";
import { PlatformPaths } from "@/common/utils/paths";
import { log } from "@/node/services/log";
import type { RawQueryResult } from "./queries";

interface WorkerRequest {
  messageId: number;
  taskName: string;
  data: unknown;
}

interface WorkerShutdownMessage {
  type: "shutdown";
}

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

type WorkerResponse = WorkerSuccessResponse | WorkerErrorResponse;

type AnalyticsQueryName =
  | "getSummary"
  | "getSpendOverTime"
  | "getSpendByProject"
  | "getSpendByModel"
  | "getTokensByModel"
  | "getTimingDistribution"
  | "getAgentCostBreakdown"
  | "getCacheHitRatioByProvider"
  | "getDelegationSummary";

export interface IngestWorkspaceMeta {
  projectPath: string | undefined;
  projectName: string | undefined;
  workspaceName: string | undefined;
  parentWorkspaceId: string | undefined;
}

// stream-end ingestion is the first analytics write for newly spawned sub-agent
// workspaces, so callers that have config access must explicitly thread every
// metadata field (including intentional undefined values). This turns future
// metadata additions into compile-time errors instead of silent NULL regressions.
const EMPTY_INGEST_WORKSPACE_META: IngestWorkspaceMeta = {
  projectPath: undefined,
  projectName: undefined,
  workspaceName: undefined,
  parentWorkspaceId: undefined,
};

interface TimingDistributionRow {
  percentiles: TimingPercentilesRow;
  histogram: HistogramBucket[];
}

interface DelegationSummaryQueryResult {
  totals: DelegationSummaryTotalsRow;
  breakdown: DelegationAgentBreakdownRow[];
}

interface RebuildAllResult {
  workspacesIngested: number;
}

interface RebuildAllData {
  sessionsDir: string;
  workspaceMetaById: Record<string, IngestWorkspaceMeta>;
}

function toOptionalNonEmptyString(value: string | undefined): string | undefined {
  if (value == null) {
    return undefined;
  }

  const trimmed = value.trim();
  return trimmed.length > 0 ? trimmed : undefined;
}

function toDateFilterString(value: Date | null | undefined): string | null {
  if (value == null) {
    return null;
  }

  assert(Number.isFinite(value.getTime()), "Analytics date filter must be a valid Date");
  return toUtcDateString(value);
}

interface ProviderCacheHitTotals {
  cachedTokens: number;
  totalPromptTokens: number;
  responseCount: number;
}

function normalizeProviderName(model: string): string {
  const provider = getModelProvider(model).trim().toLowerCase();
  return provider.length > 0 ? provider : "unknown";
}

/**
 * Roll model-level cache metrics into provider buckets using the same provider
 * parser as the rest of the app (handles mux-gateway prefixes and malformed
 * model strings consistently).
 */
export function aggregateProviderCacheHitRows(
  rows: ProviderCacheHitModelRow[]
): Array<{ provider: string; cacheHitRatio: number; responseCount: number }> {
  const totalsByProvider = new Map<string, ProviderCacheHitTotals>();

  for (const row of rows) {
    assert(typeof row.model === "string", "Provider cache hit aggregation requires a string model");
    assert(
      Number.isFinite(row.cached_tokens) && row.cached_tokens >= 0,
      "Provider cache hit aggregation requires non-negative cached_tokens"
    );
    assert(
      Number.isFinite(row.total_prompt_tokens) && row.total_prompt_tokens >= 0,
      "Provider cache hit aggregation requires non-negative total_prompt_tokens"
    );
    assert(
      Number.isFinite(row.response_count) && row.response_count >= 0,
      "Provider cache hit aggregation requires non-negative response_count"
    );

    const provider = normalizeProviderName(row.model);
    const current = totalsByProvider.get(provider);

    if (current) {
      current.cachedTokens += row.cached_tokens;
      current.totalPromptTokens += row.total_prompt_tokens;
      current.responseCount += row.response_count;
      continue;
    }

    totalsByProvider.set(provider, {
      cachedTokens: row.cached_tokens,
      totalPromptTokens: row.total_prompt_tokens,
      responseCount: row.response_count,
    });
  }

  return Array.from(totalsByProvider.entries())
    .map(([provider, totals]) => ({
      provider,
      cacheHitRatio:
        totals.totalPromptTokens > 0 ? totals.cachedTokens / totals.totalPromptTokens : 0,
      responseCount: totals.responseCount,
    }))
    .sort((left, right) => {
      if (right.cacheHitRatio !== left.cacheHitRatio) {
        return right.cacheHitRatio - left.cacheHitRatio;
      }

      if (right.responseCount !== left.responseCount) {
        return right.responseCount - left.responseCount;
      }

      return left.provider.localeCompare(right.provider);
    });
}

interface AnalyticsFilterInput {
  projectPath?: string | null;
  from?: Date | null;
  to?: Date | null;
}

export class AnalyticsService {
  private worker: Worker | null = null;
  private workerExited = false;
  private messageIdCounter = 0;
  private readonly pendingPromises = new Map<
    number,
    { resolve: (value: unknown) => void; reject: (error: Error) => void }
  >();
  private workerError: Error | null = null;
  private initPromise: Promise<void> | null = null;
  private disposePromise: Promise<void> | null = null;
  private isDisposed = false;
  private _savedQueryMutex: Promise<void> = Promise.resolve();

  constructor(private readonly config: Config) {}

  private rejectPending(error: Error): void {
    for (const pending of this.pendingPromises.values()) {
      pending.reject(error);
    }
    this.pendingPromises.clear();
  }

  private resolveWorkerPath(): string {
    const currentDir = path.dirname(__filename);
    const pathParts = currentDir.split(path.sep);
    const hasDist = pathParts.includes("dist");
    const srcIndex = pathParts.lastIndexOf("src");

    let workerDir = currentDir;
    let workerFile = "analyticsWorker.js";

    // eslint-disable-next-line local/no-chained-type-assertions -- grandfathered when the rule was introduced; fix the underlying type instead of copying this pattern
    const isBun = !!(process as unknown as { isBun?: boolean }).isBun;
    if (isBun && path.extname(__filename) === ".ts") {
      workerFile = "analyticsWorker.ts";
    } else if (srcIndex !== -1 && !hasDist) {
      pathParts[srcIndex] = "dist";
      workerDir = pathParts.join(path.sep);
    }

    return path.join(workerDir, workerFile);
  }

  private buildRebuildWorkspaceMetaById(): Record<string, IngestWorkspaceMeta> {
    const configSnapshot = this.config.loadConfigOrDefault();
    const workspaceMetaById: Record<string, IngestWorkspaceMeta> = {};

    for (const [projectPath, projectConfig] of configSnapshot.projects) {
      const normalizedProjectPath = toOptionalNonEmptyString(projectPath);
      if (!normalizedProjectPath) {
        log.warn("[AnalyticsService] Skipping rebuild metadata for empty project path");
        continue;
      }

      const projectName = PlatformPaths.getProjectName(normalizedProjectPath);

      for (const workspace of projectConfig.workspaces) {
        const workspaceId = toOptionalNonEmptyString(workspace.id);
        if (!workspaceId) {
          continue;
        }

        if (workspaceMetaById[workspaceId]) {
          log.warn(
            "[AnalyticsService] Duplicate workspace ID in config while building rebuild metadata",
            {
              workspaceId,
              projectPath: normalizedProjectPath,
            }
          );
          continue;
        }

        workspaceMetaById[workspaceId] = {
          projectPath: normalizedProjectPath,
          projectName,
          workspaceName: toOptionalNonEmptyString(workspace.name),
          parentWorkspaceId: toOptionalNonEmptyString(workspace.parentWorkspaceId),
        };
      }
    }

    return workspaceMetaById;
  }

  private buildRebuildAllData(): RebuildAllData {
    assert(
      this.config.sessionsDir.trim().length > 0,
      "Analytics rebuild requires a non-empty sessionsDir"
    );

    return {
      sessionsDir: this.config.sessionsDir,
      workspaceMetaById: this.buildRebuildWorkspaceMetaById(),
    };
  }

  private readonly onWorkerMessage = (response: WorkerResponse): void => {
    const pending = this.pendingPromises.get(response.messageId);
    if (!pending) {
      log.error("[AnalyticsService] No pending promise for message", {
        messageId: response.messageId,
      });
      return;
    }

    this.pendingPromises.delete(response.messageId);

    if ("error" in response) {
      const error = new Error(response.error.message);
      error.stack = response.error.stack;
      pending.reject(error);
      return;
    }

    pending.resolve(response.result);
  };

  private readonly onWorkerError = (error: Error): void => {
    this.workerError = error;
    this.rejectPending(error);
    log.error("[AnalyticsService] Worker error", { error: getErrorMessage(error) });
  };

  private readonly onWorkerExit = (code: number): void => {
    this.workerExited = true;
    if (code === 0) {
      return;
    }

    const error = new Error(`Analytics worker exited with code ${code}`);
    this.workerError = error;
    this.rejectPending(error);
    log.error("[AnalyticsService] Worker exited unexpectedly", { code });
  };

  private async startWorker(): Promise<void> {
    assert(!this.isDisposed, "Analytics worker cannot start after service disposal");

    const dbDir = path.join(this.config.rootDir, "analytics");
    await ensurePrivateDir(dbDir);

    if (this.isDisposed) {
      throw new Error("Analytics worker start aborted because service is disposing");
    }

    const workerPath = this.resolveWorkerPath();
    this.worker = new Worker(workerPath);
    this.worker.unref();

    this.worker.on("message", this.onWorkerMessage);
    this.worker.on("error", this.onWorkerError);
    this.worker.on("exit", this.onWorkerExit);

    const dbPath = path.join(dbDir, "analytics.db");
    await this.dispatch("init", { dbPath });

    // Sync analytics state with on-disk workspace history when worker starts.
    // Worker decides whether this is a noop, incremental sync, or full rebuild.
    // Awaited so first query observes complete startup state.
    try {
      await this.dispatch("syncCheck", {
        sessionsDir: this.config.sessionsDir,
        workspaceMetaById: this.buildRebuildWorkspaceMetaById(),
      });
    } catch (error) {
      // Non-fatal: queries still work but may show partial historical data
      // until incremental stream-end ingestion fills gaps.
      log.warn("[AnalyticsService] Initial sync check failed (non-fatal)", {
        error: getErrorMessage(error),
      });
    }
  }

  private ensureWorker(): Promise<void> {
    if (this.isDisposed) {
      return Promise.reject(new Error("Analytics service has been disposed"));
    }

    if (this.workerError) {
      return Promise.reject(this.workerError);
    }

    this.initPromise ??= this.startWorker().catch((error: unknown) => {
      const normalizedError = error instanceof Error ? error : new Error(getErrorMessage(error));
      this.workerError = normalizedError;
      this.initPromise = null;
      throw normalizedError;
    });

    return this.initPromise;
  }

  private dispatch<T>(taskName: string, data: unknown): Promise<T> {
    if (this.workerError) {
      return Promise.reject(this.workerError);
    }

    const worker = this.worker;
    assert(worker, `Analytics worker is unavailable for task '${taskName}'`);

    const request: WorkerRequest = {
      messageId: this.messageIdCounter,
      taskName,
      data,
    };

    this.messageIdCounter += 1;

    return new Promise<T>((resolve, reject) => {
      this.pendingPromises.set(request.messageId, {
        resolve: resolve as (value: unknown) => void,
        reject,
      });

      try {
        worker.postMessage(request);
      } catch (error) {
        this.pendingPromises.delete(request.messageId);
        reject(error instanceof Error ? error : new Error(getErrorMessage(error)));
      }
    });
  }

  private async executeQuery<T>(
    queryName: AnalyticsQueryName,
    params: Record<string, unknown>
  ): Promise<T> {
    await this.ensureWorker();
    return this.dispatch<T>("query", { queryName, params });
  }

  private get savedQueriesPath(): string {
    return path.join(this.config.rootDir, "analytics", "saved-queries.json");
  }

  private withSavedQueryLock<T>(fn: () => Promise<T>): Promise<T> {
    assert(typeof fn === "function", "withSavedQueryLock requires a mutation callback");

    // Serialize all saved-query read-modify-write mutations so concurrent callers
    // cannot clobber one another by writing stale snapshots.
    const result = this._savedQueryMutex.then(fn, fn);
    this._savedQueryMutex = result.then(
      () => undefined,
      () => undefined
    );
    return result;
  }

  private async readSavedQueries(): Promise<SavedQuery[]> {
    try {
      const contents = await fs.readFile(this.savedQueriesPath, "utf8");
      const parsed = JSON.parse(contents) as { queries?: unknown };

      assert(parsed && typeof parsed === "object", "Saved queries file must contain a JSON object");
      assert(Array.isArray(parsed.queries), "Saved queries file must contain a queries array");

      const queries: SavedQuery[] = [];
      for (const query of parsed.queries) {
        if (!query || typeof query !== "object") {
          continue;
        }

        const candidate = query as Partial<SavedQuery>;
        if (
          typeof candidate.id !== "string" ||
          typeof candidate.label !== "string" ||
          typeof candidate.sql !== "string" ||
          (candidate.chartType !== null && typeof candidate.chartType !== "string") ||
          typeof candidate.order !== "number" ||
          !Number.isFinite(candidate.order) ||
          typeof candidate.createdAt !== "string"
        ) {
          continue;
        }

        queries.push({
          id: candidate.id,
          label: candidate.label,
          sql: candidate.sql,
          chartType: candidate.chartType,
          order: candidate.order,
          createdAt: candidate.createdAt,
        });
      }

      return queries;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") {
        return [];
      }

      log.warn("[AnalyticsService] Failed to read saved queries file; recovering with empty list", {
        path: this.savedQueriesPath,
        error: getErrorMessage(error),
      });
      return [];
    }
  }

  private async writeSavedQueries(queries: SavedQuery[]): Promise<void> {
    assert(Array.isArray(queries), "writeSavedQueries requires an array of queries");
    await fs.mkdir(path.dirname(this.savedQueriesPath), { recursive: true });
    await writeFileAtomic(this.savedQueriesPath, `${JSON.stringify({ queries }, null, 2)}\n`);
  }

  async getSavedQueries(): Promise<{ queries: SavedQuery[] }> {
    const queries = await this.readSavedQueries();
    return {
      queries: [...queries].sort((left, right) => left.order - right.order),
    };
  }

  async saveQuery(input: {
    label: string;
    sql: string;
    chartType?: string | null;
  }): Promise<SavedQuery> {
    assert(input.label.trim().length > 0, "saveQuery requires a non-empty label");
    assert(input.sql.trim().length > 0, "saveQuery requires non-empty SQL");

    return this.withSavedQueryLock(async () => {
      const queries = await this.readSavedQueries();
      const nextOrder =
        queries.length === 0 ? 0 : Math.max(...queries.map((query) => query.order)) + 1;

      const savedQuery: SavedQuery = {
        id: crypto.randomUUID(),
        label: input.label,
        sql: input.sql,
        chartType: input.chartType ?? null,
        order: nextOrder,
        createdAt: new Date().toISOString(),
      };

      queries.push(savedQuery);
      await this.writeSavedQueries(queries);
      return savedQuery;
    });
  }

  async updateSavedQuery(input: {
    id: string;
    label?: string | null;
    sql?: string | null;
    chartType?: string | null;
    order?: number | null;
  }): Promise<SavedQuery> {
    assert(input.id.trim().length > 0, "updateSavedQuery requires a non-empty id");

    return this.withSavedQueryLock(async () => {
      const queries = await this.readSavedQueries();
      const index = queries.findIndex((query) => query.id === input.id);
      assert(index >= 0, `Saved query not found for id '${input.id}'`);

      const current = queries[index];
      const updatedQuery: SavedQuery = { ...current };

      if (input.label != null) {
        assert(
          input.label.trim().length > 0,
          "updateSavedQuery requires a non-empty label when provided"
        );
        updatedQuery.label = input.label;
      }

      if (input.sql != null) {
        assert(
          input.sql.trim().length > 0,
          "updateSavedQuery requires non-empty SQL when provided"
        );
        updatedQuery.sql = input.sql;
      }

      if (input.chartType !== undefined) {
        assert(
          input.chartType === null || input.chartType.trim().length > 0,
          "updateSavedQuery requires non-empty chartType when provided"
        );
        updatedQuery.chartType = input.chartType;
      }

      if (input.order != null) {
        assert(
          Number.isInteger(input.order) && input.order >= 0,
          "updateSavedQuery requires a non-negative integer order when provided"
        );
        updatedQuery.order = input.order;
      }

      queries[index] = updatedQuery;
      await this.writeSavedQueries(queries);
      return updatedQuery;
    });
  }

  async deleteSavedQuery(input: { id: string }): Promise<{ success: boolean }> {
    assert(input.id.trim().length > 0, "deleteSavedQuery requires a non-empty id");

    return this.withSavedQueryLock(async () => {
      const queries = await this.readSavedQueries();
      const nextQueries = queries.filter((query) => query.id !== input.id);
      const success = nextQueries.length !== queries.length;

      if (success) {
        await this.writeSavedQueries(nextQueries);
      }

      return { success };
    });
  }

  async getSummary(params: AnalyticsFilterInput): Promise<{
    totalSpendUsd: number;
    todaySpendUsd: number;
    avgDailySpendUsd: number;
    cacheHitRatio: number;
    totalTokens: number;
    totalResponses: number;
  }> {
    const row = await this.executeQuery<SummaryRow>("getSummary", {
      projectPath: params.projectPath ?? null,
      from: toDateFilterString(params.from),
      to: toDateFilterString(params.to),
    });

    return {
      totalSpendUsd: row.total_spend_usd,
      todaySpendUsd: row.today_spend_usd,
      avgDailySpendUsd: row.avg_daily_spend_usd,
      cacheHitRatio: row.cache_hit_ratio,
      totalTokens: row.total_tokens,
      totalResponses: row.total_responses,
    };
  }

  async getSpendOverTime(params: {
    granularity: "hour" | "day" | "week";
    projectPath?: string | null;
    from?: Date | null;
    to?: Date | null;
    timeZone?: string | null;
  }): Promise<Array<{ bucket: string; model: string; costUsd: number }>> {
    const rows = await this.executeQuery<SpendOverTimeRow[]>("getSpendOverTime", {
      granularity: params.granularity,
      projectPath: params.projectPath ?? null,
      from: toDateFilterString(params.from),
      to: toDateFilterString(params.to),
      timeZone: params.timeZone ?? "UTC",
    });

    return rows.map((row) => ({
      bucket: row.bucket,
      model: row.model,
      costUsd: row.cost_usd,
    }));
  }

  async getSpendByProject(
    from?: Date | null,
    to?: Date | null
  ): Promise<
    Array<{ projectName: string; projectPath: string; costUsd: number; tokenCount: number }>
  > {
    const rows = await this.executeQuery<SpendByProjectRow[]>("getSpendByProject", {
      from: toDateFilterString(from),
      to: toDateFilterString(to),
    });

    return rows.map((row) => ({
      projectName: row.project_name,
      projectPath: row.project_path,
      costUsd: row.cost_usd,
      tokenCount: row.token_count,
    }));
  }

  async getSpendByModel(
    params: AnalyticsFilterInput
  ): Promise<Array<{ model: string; costUsd: number; tokenCount: number; responseCount: number }>> {
    const rows = await this.executeQuery<SpendByModelRow[]>("getSpendByModel", {
      projectPath: params.projectPath ?? null,
      from: toDateFilterString(params.from),
      to: toDateFilterString(params.to),
    });

    return rows.map((row) => ({
      model: row.model,
      costUsd: row.cost_usd,
      tokenCount: row.token_count,
      responseCount: row.response_count,
    }));
  }

  async getTokensByModel(params: AnalyticsFilterInput): Promise<
    Array<{
      model: string;
      inputTokens: number;
      cachedTokens: number;
      cacheCreateTokens: number;
      outputTokens: number;
      reasoningTokens: number;
      totalTokens: number;
      requestCount: number;
    }>
  > {
    const rows = await this.executeQuery<TokensByModelRow[]>("getTokensByModel", {
      projectPath: params.projectPath ?? null,
      from: toDateFilterString(params.from),
      to: toDateFilterString(params.to),
    });

    return rows.map((row) => ({
      model: row.model,
      inputTokens: row.input_tokens,
      cachedTokens: row.cached_tokens,
      cacheCreateTokens: row.cache_create_tokens,
      outputTokens: row.output_tokens,
      reasoningTokens: row.reasoning_tokens,
      totalTokens: row.total_tokens,
      requestCount: row.request_count,
    }));
  }

  async getTimingDistribution(
    params: AnalyticsFilterInput & { metric: "ttft" | "duration" | "tps" }
  ): Promise<{
    p50: number;
    p90: number;
    p99: number;
    histogram: Array<{ bucket: number; count: number }>;
  }> {
    const row = await this.executeQuery<TimingDistributionRow>("getTimingDistribution", {
      metric: params.metric,
      projectPath: params.projectPath ?? null,
      from: toDateFilterString(params.from),
      to: toDateFilterString(params.to),
    });

    return {
      p50: row.percentiles.p50,
      p90: row.percentiles.p90,
      p99: row.percentiles.p99,
      histogram: row.histogram.map((bucket) => ({
        bucket: bucket.bucket,
        count: bucket.count,
      })),
    };
  }

  async getAgentCostBreakdown(
    params: AnalyticsFilterInput
  ): Promise<
    Array<{ agentId: string; costUsd: number; tokenCount: number; responseCount: number }>
  > {
    const rows = await this.executeQuery<AgentCostRow[]>("getAgentCostBreakdown", {
      projectPath: params.projectPath ?? null,
      from: toDateFilterString(params.from),
      to: toDateFilterString(params.to),
    });

    return rows.map((row) => ({
      agentId: row.agent_id,
      costUsd: row.cost_usd,
      tokenCount: row.token_count,
      responseCount: row.response_count,
    }));
  }

  async getCacheHitRatioByProvider(
    params: AnalyticsFilterInput
  ): Promise<Array<{ provider: string; cacheHitRatio: number; responseCount: number }>> {
    const rows = await this.executeQuery<ProviderCacheHitModelRow[]>("getCacheHitRatioByProvider", {
      projectPath: params.projectPath ?? null,
      from: toDateFilterString(params.from),
      to: toDateFilterString(params.to),
    });

    return aggregateProviderCacheHitRows(rows);
  }

  async getDelegationSummary(params: AnalyticsFilterInput): Promise<{
    totalChildren: number;
    totalTokensConsumed: number;
    totalReportTokens: number;
    compressionRatio: number;
    totalCostDelegated: number;
    byAgentType: Array<{
      agentType: string;
      count: number;
      totalTokens: number;
      inputTokens: number;
      outputTokens: number;
      reasoningTokens: number;
      cachedTokens: number;
      cacheCreateTokens: number;
    }>;
  }> {
    const result = await this.executeQuery<DelegationSummaryQueryResult>("getDelegationSummary", {
      projectPath: params.projectPath ?? null,
      from: toDateFilterString(params.from),
      to: toDateFilterString(params.to),
    });

    return {
      totalChildren: result.totals.total_children,
      totalTokensConsumed: result.totals.total_tokens_consumed,
      totalReportTokens: result.totals.total_report_tokens,
      compressionRatio: result.totals.compression_ratio,
      totalCostDelegated: result.totals.total_cost_delegated,
      byAgentType: result.breakdown.map((row) => ({
        agentType: row.agent_type,
        count: row.delegation_count,
        totalTokens: row.total_tokens,
        inputTokens: row.input_tokens,
        outputTokens: row.output_tokens,
        reasoningTokens: row.reasoning_tokens,
        cachedTokens: row.cached_tokens,
        cacheCreateTokens: row.cache_create_tokens,
      })),
    };
  }

  async executeRawQuery(sql: string): Promise<RawQueryResult> {
    assert(
      typeof sql === "string" && sql.trim().length > 0,
      "executeRawQuery requires non-empty SQL"
    );
    await this.ensureWorker();
    return this.dispatch<RawQueryResult>("rawQuery", { sql });
  }

  async rebuildAll(): Promise<{ success: boolean; workspacesIngested: number }> {
    await this.ensureWorker();
    const result = await this.dispatch<RebuildAllResult>("rebuildAll", this.buildRebuildAllData());

    return {
      success: true,
      workspacesIngested: result.workspacesIngested,
    };
  }

  dispose(): Promise<void> {
    this.disposePromise ??= Promise.resolve().then(() => this.disposeInternal());
    return this.disposePromise;
  }

  private async disposeInternal(): Promise<void> {
    this.isDisposed = true;

    const disposedError = new Error("Analytics service is shutting down");
    this.workerError = disposedError;
    this.initPromise = null;

    this.rejectPending(disposedError);

    const worker = this.worker;
    if (worker == null) {
      return;
    }

    this.worker = null;
    worker.off("message", this.onWorkerMessage);
    worker.off("error", this.onWorkerError);
    worker.off("exit", this.onWorkerExit);

    // A worker that already exited (crash or clean stop) has nothing left to close.
    if (this.workerExited) {
      return;
    }

    // Shut down DuckDB from inside the worker thread first. The worker is unref'd, so the
    // process would not wait for it on its own; wait for its actual exit here because the
    // worker closes DuckDB only after in-flight ETL finishes, and exiting the process mid-sync
    // (e.g. Ctrl-C during the startup sync) tears the thread down inside native DuckDB code and
    // aborts the whole process. Deliberately unbounded: an ETL that outlives a local timeout
    // would still be mid-query when the caller exits, so the hard-exit decision belongs to the
    // outer quit budgets in cli/server.ts and desktop/main.ts, which race the whole dispose.
    // Keep an error listener until exit: onWorkerError was detached above, and a worker
    // `error` with no listener is rethrown by the parent EventEmitter, which would turn a
    // failing DuckDB close into a crash of the shutting-down process.
    worker.on("error", (error: Error) => {
      log.warn("[AnalyticsService] Analytics worker error during shutdown", {
        error: getErrorMessage(error),
      });
    });
    const exited = new Promise<void>((resolve) => {
      worker.once("exit", () => resolve());
    });
    try {
      worker.postMessage({ type: "shutdown" } satisfies WorkerShutdownMessage);
    } catch (error) {
      log.warn("[AnalyticsService] Failed to post graceful shutdown message to analytics worker", {
        error: getErrorMessage(error),
      });
      return;
    }
    await exited;
  }

  clearWorkspace(
    workspaceId: string,
    options?: {
      /**
       * Re-ingest this workspace right after the clear completes (same promise
       * chain, so it cannot race ahead of the clear and get purged). Used when
       * a removed sub-agent child archived its transcript into the parent's
       * session dir: re-ingesting the parent restores the child's spend from
       * the archive immediately instead of waiting for the parent's next
       * stream-end, which may never come for finished coordinators.
       */
      reingestAfterClear?: { workspaceId: string; sessionDir: string; meta: IngestWorkspaceMeta };
    }
  ): void {
    if (workspaceId.trim().length === 0) {
      log.warn("[AnalyticsService] Skipping workspace clear due to missing workspaceId", {
        workspaceId,
      });
      return;
    }

    const reingestAfterClear = options?.reingestAfterClear;
    const runClear = () => {
      this.ensureWorker()
        .then(() => this.dispatch<void>("clearWorkspace", { workspaceId }))
        .then(() => {
          if (reingestAfterClear == null) {
            return;
          }
          return this.dispatch("ingest", reingestAfterClear).then(() => undefined);
        })
        .catch((error) => {
          log.warn("[AnalyticsService] Failed to clear workspace analytics state", {
            workspaceId,
            error: getErrorMessage(error),
          });
        });
    };

    // Workspace-removal hooks can fire before analytics is ever opened in this
    // process. If analytics DB does not exist yet, skip bootstrapping worker.
    // If DB does exist (from prior runs), bootstrap and clear so stale rows are
    // removed immediately after workspace deletion.
    if (this.worker == null && this.initPromise == null && this.workerError == null) {
      const dbPath = path.join(this.config.rootDir, "analytics", "analytics.db");
      void fs
        .access(dbPath)
        .then(() => {
          runClear();
        })
        .catch((error) => {
          if ((error as NodeJS.ErrnoException).code === "ENOENT") {
            return;
          }

          // For non-ENOENT access failures, attempt best-effort cleanup anyway.
          runClear();
        });
      return;
    }

    runClear();
  }

  recordGoalLifecycleEvent(
    event: string,
    properties: Record<string, string | number | boolean | null>
  ): void {
    log.debug("[AnalyticsService] goal lifecycle event", { event, properties });
  }

  ingestWorkspace(
    workspaceId: string,
    sessionDir: string,
    meta: IngestWorkspaceMeta = EMPTY_INGEST_WORKSPACE_META
  ): void {
    if (workspaceId.trim().length === 0 || sessionDir.trim().length === 0) {
      log.warn("[AnalyticsService] Skipping ingest due to missing workspace information", {
        workspaceId,
        sessionDir,
      });
      return;
    }

    this.ensureWorker()
      .then(() => this.dispatch("ingest", { workspaceId, sessionDir, meta }))
      .catch((error) => {
        log.warn("[AnalyticsService] Failed to ingest workspace", {
          workspaceId,
          error: getErrorMessage(error),
        });
      });
  }
}

const RAW_QUERY_USER_ERROR_PATTERNS = [
  /^parser error:/i,
  /^binder error:/i,
  /^catalog error:/i,
  /^conversion error:/i,
  /^invalid input error:/i,
  /^out of range error:/i,
  /^not implemented error:/i,
  /query contains disallowed sql/i,
  /string literals cannot be used as table sources/i,
] as const;

export async function executeRawQueryForApi(service: AnalyticsService, sql: string) {
  try {
    return await service.executeRawQuery(sql);
  } catch (error) {
    if (error instanceof ORPCError) throw error;
    const message = getErrorMessage(error);
    if (!RAW_QUERY_USER_ERROR_PATTERNS.some((pattern) => pattern.test(message))) throw error;
    throw new ORPCError("BAD_REQUEST", { message, cause: error });
  }
}

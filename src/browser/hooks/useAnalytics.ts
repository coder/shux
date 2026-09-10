import assert from "@/common/utils/assert";
import type React from "react";
import { useEffect, useRef, useState } from "react";
import type { z } from "zod";
import type { APIClient } from "@/browser/contexts/API";
import { useAPI } from "@/browser/contexts/API";
import type { analytics } from "@/common/orpc/schemas/analytics";
import type { SavedQuery } from "@/common/types/savedQueries";
import { getErrorMessage } from "@/common/utils/errors";

export type Summary = z.infer<typeof analytics.getSummary.output>;
export type SpendOverTimeItem = z.infer<typeof analytics.getSpendOverTime.output>[number];
export type SpendByProjectItem = z.infer<typeof analytics.getSpendByProject.output>[number];
export type SpendByModelItem = z.infer<typeof analytics.getSpendByModel.output>[number];
export type TokensByModelItem = z.infer<typeof analytics.getTokensByModel.output>[number];
export type TimingDistribution = z.infer<typeof analytics.getTimingDistribution.output>;
export type AgentCostItem = z.infer<typeof analytics.getAgentCostBreakdown.output>[number];
export type ProviderCacheHitRatioItem = z.infer<
  typeof analytics.getCacheHitRatioByProvider.output
>[number];
export type DelegationSummary = z.infer<typeof analytics.getDelegationSummary.output>;

export interface AsyncState<T> {
  data: T | null;
  loading: boolean;
  error: string | null;
}

type SummaryInput = z.input<typeof analytics.getSummary.input>;
type SpendOverTimeInput = z.input<typeof analytics.getSpendOverTime.input>;
type SpendByProjectInput = z.input<typeof analytics.getSpendByProject.input>;
type SpendByModelInput = z.input<typeof analytics.getSpendByModel.input>;
type TokensByModelInput = z.input<typeof analytics.getTokensByModel.input>;
type TimingDistributionInput = z.input<typeof analytics.getTimingDistribution.input>;
type AgentCostBreakdownInput = z.input<typeof analytics.getAgentCostBreakdown.input>;
type ProviderCacheHitRatioInput = z.input<typeof analytics.getCacheHitRatioByProvider.input>;
type DelegationSummaryInput = z.input<typeof analytics.getDelegationSummary.input>;

interface DateFilterParams {
  from?: Date | null;
  to?: Date | null;
}

interface AnalyticsNamespace {
  getSummary: (input: SummaryInput) => Promise<Summary>;
  getSpendOverTime: (input: SpendOverTimeInput) => Promise<SpendOverTimeItem[]>;
  getSpendByProject: (input: SpendByProjectInput) => Promise<SpendByProjectItem[]>;
  getSpendByModel: (input: SpendByModelInput) => Promise<SpendByModelItem[]>;
  getTokensByModel: (input: TokensByModelInput) => Promise<TokensByModelItem[]>;
  getTimingDistribution: (input: TimingDistributionInput) => Promise<TimingDistribution>;
  getAgentCostBreakdown: (input: AgentCostBreakdownInput) => Promise<AgentCostItem[]>;
  getCacheHitRatioByProvider: (
    input: ProviderCacheHitRatioInput
  ) => Promise<ProviderCacheHitRatioItem[]>;
  getDelegationSummary: (input: DelegationSummaryInput) => Promise<DelegationSummary>;
  executeRawQuery?: (input: {
    sql: string;
  }) => Promise<z.infer<typeof analytics.executeRawQuery.output>>;
  getSavedQueries?: () => Promise<z.infer<typeof analytics.getSavedQueries.output>>;
  saveQuery?: (input: z.input<typeof analytics.saveQuery.input>) => Promise<SavedQuery>;
  updateSavedQuery?: (
    input: z.input<typeof analytics.updateSavedQuery.input>
  ) => Promise<SavedQuery>;
  deleteSavedQuery?: (
    input: z.input<typeof analytics.deleteSavedQuery.input>
  ) => Promise<z.infer<typeof analytics.deleteSavedQuery.output>>;
}

const ANALYTICS_UNAVAILABLE_MESSAGE = "Analytics backend is not available in this build.";

function getAnalyticsNamespace(api: APIClient): AnalyticsNamespace | null {
  const candidate = (api as { analytics?: unknown }).analytics;
  // ORPC client namespaces can be proxy objects or callable proxy functions
  // depending on transport/runtime shape. Accept both so we don't
  // misclassify a valid analytics backend as unavailable.
  if (!candidate || (typeof candidate !== "object" && typeof candidate !== "function")) {
    return null;
  }

  const maybeNamespace = candidate as Partial<AnalyticsNamespace>;
  if (
    typeof maybeNamespace.getSummary !== "function" ||
    typeof maybeNamespace.getSpendOverTime !== "function" ||
    typeof maybeNamespace.getSpendByProject !== "function" ||
    typeof maybeNamespace.getSpendByModel !== "function" ||
    typeof maybeNamespace.getTokensByModel !== "function" ||
    typeof maybeNamespace.getTimingDistribution !== "function" ||
    typeof maybeNamespace.getAgentCostBreakdown !== "function" ||
    typeof maybeNamespace.getCacheHitRatioByProvider !== "function" ||
    typeof maybeNamespace.getDelegationSummary !== "function"
  ) {
    return null;
  }

  return maybeNamespace as AnalyticsNamespace;
}

/**
 * Shared effect body for analytics data-fetching hooks.
 * Handles API readiness check, cancellation on unmount/re-render, and error handling.
 * Returns the effect cleanup function (or undefined for early-exit paths).
 */
function runAnalyticsEffect<T>(
  api: APIClient | null,
  setState: React.Dispatch<React.SetStateAction<AsyncState<T>>>,
  fetcher: (analyticsApi: AnalyticsNamespace) => Promise<T>
): (() => void) | undefined {
  if (!api) {
    setState((previousState) => ({
      data: previousState.data,
      loading: true,
      error: null,
    }));
    return;
  }

  const analyticsApi = getAnalyticsNamespace(api);
  if (!analyticsApi) {
    setState({ data: null, loading: false, error: ANALYTICS_UNAVAILABLE_MESSAGE });
    return;
  }

  let ignore = false;
  setState((previousState) => ({
    data: previousState.data,
    loading: true,
    error: null,
  }));

  void fetcher(analyticsApi)
    .then((data) => {
      if (ignore) {
        return;
      }
      setState({ data, loading: false, error: null });
    })
    .catch((error: unknown) => {
      if (ignore) {
        return;
      }
      setState((previousState) => ({
        data: previousState.data,
        loading: false,
        error: getErrorMessage(error),
      }));
    });

  return () => {
    ignore = true;
  };
}

export function useAnalyticsSummary(
  projectPath?: string | null,
  dateFilters?: DateFilterParams
): AsyncState<Summary> {
  const fromMs = dateFilters?.from?.getTime() ?? null;
  const toMs = dateFilters?.to?.getTime() ?? null;

  const { api } = useAPI();
  const [state, setState] = useState<AsyncState<Summary>>({
    data: null,
    loading: true,
    error: null,
  });

  useEffect(() => {
    const fromDate = fromMs == null ? null : new Date(fromMs);
    const toDate = toMs == null ? null : new Date(toMs);
    return runAnalyticsEffect(api, setState, (analyticsApi) =>
      analyticsApi.getSummary({ projectPath: projectPath ?? null, from: fromDate, to: toDate })
    );
  }, [api, projectPath, fromMs, toMs]);

  return state;
}

export function useAnalyticsSpendOverTime(params: {
  projectPath?: string | null;
  granularity: "hour" | "day" | "week";
  from?: Date | null;
  to?: Date | null;
  timeZone?: string | null;
}): AsyncState<SpendOverTimeItem[]> {
  assert(
    params.granularity === "hour" || params.granularity === "day" || params.granularity === "week",
    "useAnalyticsSpendOverTime requires a valid granularity"
  );

  const fromMs = params.from?.getTime() ?? null;
  const toMs = params.to?.getTime() ?? null;

  const { api } = useAPI();
  const [state, setState] = useState<AsyncState<SpendOverTimeItem[]>>({
    data: null,
    loading: true,
    error: null,
  });

  useEffect(() => {
    const fromDate = fromMs == null ? null : new Date(fromMs);
    const toDate = toMs == null ? null : new Date(toMs);
    return runAnalyticsEffect(api, setState, (analyticsApi) =>
      analyticsApi.getSpendOverTime({
        projectPath: params.projectPath ?? null,
        granularity: params.granularity,
        from: fromDate,
        to: toDate,
        timeZone: params.timeZone ?? null,
      })
    );
  }, [api, params.projectPath, params.granularity, params.timeZone, fromMs, toMs]);

  return state;
}

export function useAnalyticsSpendByProject(
  dateFilters?: DateFilterParams
): AsyncState<SpendByProjectItem[]> {
  const fromMs = dateFilters?.from?.getTime() ?? null;
  const toMs = dateFilters?.to?.getTime() ?? null;

  const { api } = useAPI();
  const [state, setState] = useState<AsyncState<SpendByProjectItem[]>>({
    data: null,
    loading: true,
    error: null,
  });

  useEffect(() => {
    const fromDate = fromMs == null ? null : new Date(fromMs);
    const toDate = toMs == null ? null : new Date(toMs);
    return runAnalyticsEffect(api, setState, (analyticsApi) =>
      analyticsApi.getSpendByProject({ from: fromDate, to: toDate })
    );
  }, [api, fromMs, toMs]);

  return state;
}

export function useAnalyticsSpendByModel(
  projectPath?: string | null,
  dateFilters?: DateFilterParams
): AsyncState<SpendByModelItem[]> {
  const fromMs = dateFilters?.from?.getTime() ?? null;
  const toMs = dateFilters?.to?.getTime() ?? null;

  const { api } = useAPI();
  const [state, setState] = useState<AsyncState<SpendByModelItem[]>>({
    data: null,
    loading: true,
    error: null,
  });

  useEffect(() => {
    const fromDate = fromMs == null ? null : new Date(fromMs);
    const toDate = toMs == null ? null : new Date(toMs);
    return runAnalyticsEffect(api, setState, (analyticsApi) =>
      analyticsApi.getSpendByModel({ projectPath: projectPath ?? null, from: fromDate, to: toDate })
    );
  }, [api, projectPath, fromMs, toMs]);

  return state;
}

export function useAnalyticsTokensByModel(
  projectPath?: string | null,
  dateFilters?: DateFilterParams
): AsyncState<TokensByModelItem[]> {
  const fromMs = dateFilters?.from?.getTime() ?? null;
  const toMs = dateFilters?.to?.getTime() ?? null;

  const { api } = useAPI();
  const [state, setState] = useState<AsyncState<TokensByModelItem[]>>({
    data: null,
    loading: true,
    error: null,
  });

  useEffect(() => {
    const fromDate = fromMs == null ? null : new Date(fromMs);
    const toDate = toMs == null ? null : new Date(toMs);
    return runAnalyticsEffect(api, setState, (analyticsApi) =>
      analyticsApi.getTokensByModel({
        projectPath: projectPath ?? null,
        from: fromDate,
        to: toDate,
      })
    );
  }, [api, projectPath, fromMs, toMs]);

  return state;
}

export function useAnalyticsTimingDistribution(
  metric: "ttft" | "duration" | "tps",
  projectPath?: string | null,
  dateFilters?: DateFilterParams
): AsyncState<TimingDistribution> {
  assert(
    metric === "ttft" || metric === "duration" || metric === "tps",
    "useAnalyticsTimingDistribution requires a valid metric"
  );

  const fromMs = dateFilters?.from?.getTime() ?? null;
  const toMs = dateFilters?.to?.getTime() ?? null;

  const { api } = useAPI();
  const [state, setState] = useState<AsyncState<TimingDistribution>>({
    data: null,
    loading: true,
    error: null,
  });

  useEffect(() => {
    const fromDate = fromMs == null ? null : new Date(fromMs);
    const toDate = toMs == null ? null : new Date(toMs);
    return runAnalyticsEffect(api, setState, (analyticsApi) =>
      analyticsApi.getTimingDistribution({
        metric,
        projectPath: projectPath ?? null,
        from: fromDate,
        to: toDate,
      })
    );
  }, [api, metric, projectPath, fromMs, toMs]);

  return state;
}

export function useAnalyticsProviderCacheHitRatio(
  projectPath?: string | null,
  dateFilters?: DateFilterParams
): AsyncState<ProviderCacheHitRatioItem[]> {
  const fromMs = dateFilters?.from?.getTime() ?? null;
  const toMs = dateFilters?.to?.getTime() ?? null;

  const { api } = useAPI();
  const [state, setState] = useState<AsyncState<ProviderCacheHitRatioItem[]>>({
    data: null,
    loading: true,
    error: null,
  });

  useEffect(() => {
    const fromDate = fromMs == null ? null : new Date(fromMs);
    const toDate = toMs == null ? null : new Date(toMs);
    return runAnalyticsEffect(api, setState, (analyticsApi) =>
      analyticsApi.getCacheHitRatioByProvider({
        projectPath: projectPath ?? null,
        from: fromDate,
        to: toDate,
      })
    );
  }, [api, projectPath, fromMs, toMs]);

  return state;
}

export function useAnalyticsAgentCostBreakdown(
  projectPath?: string | null,
  dateFilters?: DateFilterParams
): AsyncState<AgentCostItem[]> {
  const fromMs = dateFilters?.from?.getTime() ?? null;
  const toMs = dateFilters?.to?.getTime() ?? null;

  const { api } = useAPI();
  const [state, setState] = useState<AsyncState<AgentCostItem[]>>({
    data: null,
    loading: true,
    error: null,
  });

  useEffect(() => {
    const fromDate = fromMs == null ? null : new Date(fromMs);
    const toDate = toMs == null ? null : new Date(toMs);
    return runAnalyticsEffect(api, setState, (analyticsApi) =>
      analyticsApi.getAgentCostBreakdown({
        projectPath: projectPath ?? null,
        from: fromDate,
        to: toDate,
      })
    );
  }, [api, projectPath, fromMs, toMs]);

  return state;
}

export function useAnalyticsDelegationSummary(
  projectPath?: string | null,
  dateFilters?: DateFilterParams
): AsyncState<DelegationSummary> {
  const fromMs = dateFilters?.from?.getTime() ?? null;
  const toMs = dateFilters?.to?.getTime() ?? null;

  const { api } = useAPI();
  const [state, setState] = useState<AsyncState<DelegationSummary>>({
    data: null,
    loading: true,
    error: null,
  });

  useEffect(() => {
    const fromDate = fromMs == null ? null : new Date(fromMs);
    const toDate = toMs == null ? null : new Date(toMs);
    return runAnalyticsEffect(api, setState, (analyticsApi) =>
      analyticsApi.getDelegationSummary({
        projectPath: projectPath ?? null,
        from: fromDate,
        to: toDate,
      })
    );
  }, [api, projectPath, fromMs, toMs]);

  return state;
}

export type RawQueryResult = z.infer<typeof analytics.executeRawQuery.output>;

export function useAnalyticsRawQuery() {
  const { api } = useAPI();
  const [state, setState] = useState<AsyncState<RawQueryResult>>({
    data: null,
    loading: false,
    error: null,
  });
  // Saved panels auto re-run when the dashboard date range changes, so rapid
  // toggles can leave multiple raw queries in flight. Track a monotonic
  // execution id and drop completions of superseded requests so a slower
  // older query cannot overwrite the newest result.
  const executionIdRef = useRef(0);

  const executeQuery = async (sql: string) => {
    if (!api) {
      setState({ data: null, loading: false, error: "API client not initialized" });
      return;
    }

    const namespace = getAnalyticsNamespace(api);
    if (!namespace || typeof namespace.executeRawQuery !== "function") {
      setState({ data: null, loading: false, error: ANALYTICS_UNAVAILABLE_MESSAGE });
      return;
    }

    const executionId = ++executionIdRef.current;
    setState((prev) => ({ ...prev, loading: true, error: null }));
    try {
      const result = await namespace.executeRawQuery({ sql });
      if (executionId === executionIdRef.current) {
        setState({ data: result, loading: false, error: null });
      }
    } catch (err) {
      if (executionId === executionIdRef.current) {
        setState({ data: null, loading: false, error: getErrorMessage(err) });
      }
    }
  };

  const clearResults = () => {
    // Invalidate in-flight executions so a late completion cannot resurrect
    // results the caller explicitly cleared.
    executionIdRef.current += 1;
    setState({ data: null, loading: false, error: null });
  };

  return { ...state, executeQuery, clearResults };
}

async function loadSavedQueries(
  api: APIClient | null,
  setQueries: React.Dispatch<React.SetStateAction<SavedQuery[]>>,
  setLoading: React.Dispatch<React.SetStateAction<boolean>>
): Promise<void> {
  setLoading(true);

  if (!api) {
    setLoading(false);
    return;
  }

  const namespace = getAnalyticsNamespace(api);
  if (!namespace || typeof namespace.getSavedQueries !== "function") {
    setLoading(false);
    return;
  }

  try {
    const result = await namespace.getSavedQueries();
    setQueries(result.queries);
  } catch {
    // Silently degrade — dashboard renders without saved panels.
  } finally {
    setLoading(false);
  }
}

interface UseSavedQueriesOptions {
  // Rationale: chat analytics cards may only need save(), so skipping the mount load avoids
  // one getSavedQueries IPC round-trip per card until the caller explicitly refreshes.
  skipLoad?: boolean;
}

export function useSavedQueries(options: UseSavedQueriesOptions = {}) {
  const skipLoadOption = options.skipLoad;
  assert(
    skipLoadOption == null || typeof skipLoadOption === "boolean",
    "useSavedQueries skipLoad must be a boolean when provided"
  );

  const skipLoad = skipLoadOption ?? false;
  const { api } = useAPI();
  const [queries, setQueries] = useState<SavedQuery[]>([]);
  const [loading, setLoading] = useState(!skipLoad);

  const refresh = async () => {
    await loadSavedQueries(api, setQueries, setLoading);
  };

  useEffect(() => {
    if (skipLoad) {
      setLoading(false);
      return;
    }

    void loadSavedQueries(api, setQueries, setLoading);
  }, [api, skipLoad]);

  const save = async (input: { label: string; sql: string; chartType?: string | null }) => {
    if (!api) {
      return null;
    }

    const namespace = getAnalyticsNamespace(api);
    if (!namespace || typeof namespace.saveQuery !== "function") {
      return null;
    }

    const saved = await namespace.saveQuery(input);
    await refresh();
    return saved;
  };

  const update = async (input: {
    id: string;
    label?: string;
    sql?: string;
    chartType?: string | null;
    order?: number;
  }) => {
    if (!api) {
      return null;
    }

    const namespace = getAnalyticsNamespace(api);
    if (!namespace || typeof namespace.updateSavedQuery !== "function") {
      return null;
    }

    const updated = await namespace.updateSavedQuery(input);
    await refresh();
    return updated;
  };

  const remove = async (id: string) => {
    if (!api) {
      return;
    }

    const namespace = getAnalyticsNamespace(api);
    if (!namespace || typeof namespace.deleteSavedQuery !== "function") {
      return;
    }

    await namespace.deleteSavedQuery({ id });
    await refresh();
  };

  return { queries, loading, save, update, remove, refresh };
}

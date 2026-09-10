import { useEffect, useState } from "react";
import { ArrowLeft, Menu } from "lucide-react";
import { useProjectContext } from "@/browser/contexts/ProjectContext";
import { useRouter } from "@/browser/contexts/RouterContext";
import {
  useAnalyticsAgentCostBreakdown,
  useAnalyticsDelegationSummary,
  useAnalyticsProviderCacheHitRatio,
  useAnalyticsSpendByModel,
  useAnalyticsSpendByProject,
  useAnalyticsSpendOverTime,
  useAnalyticsSummary,
  useAnalyticsTimingDistribution,
  useAnalyticsTokensByModel,
  useSavedQueries,
} from "@/browser/hooks/useAnalytics";
import { DESKTOP_TITLEBAR_HEIGHT_CLASS, isDesktopMode } from "@/browser/hooks/useDesktopTitlebar";
import { usePersistedState } from "@/browser/hooks/usePersistedState";
import { isEditableElement, KEYBINDS, matchesKeybind } from "@/browser/utils/ui/keybinds";
import { ToggleGroup } from "@/browser/components/ToggleGroup/ToggleGroup";
import { Button } from "@/browser/components/Button/Button";
import { cn } from "@/common/lib/utils";
import { AgentCostChart } from "./AgentCostChart";
import { DelegationChart } from "./DelegationChart";
import { SavedQueryPanel } from "./SavedQueryPanel";
import { SqlExplorer } from "./SqlExplorer";
import { ProviderCacheHitChart } from "./ProviderCacheHitChart";
import { ModelBreakdown } from "./ModelBreakdown";
import { SpendChart } from "./SpendChart";
import { SummaryCards } from "./SummaryCards";
import { TimingChart } from "./TimingChart";
import { TokensByModelChart } from "./TokensByModelChart";
import { formatProjectDisplayName } from "./analyticsUtils";
import { buildTimeFilterPredicate } from "./sqlTimeFilter";

interface AnalyticsDashboardProps {
  leftSidebarCollapsed: boolean;
  onToggleLeftSidebarCollapsed: () => void;
}

type TimeRange = "7d" | "30d" | "90d" | "all";
type TimingMetric = "ttft" | "duration" | "tps";
type TimeZoneMode = "local" | "utc";

const VALID_TIME_RANGES = new Set<string>(["7d", "30d", "90d", "all"]);
const VALID_TIMING_METRICS = new Set<string>(["ttft", "duration", "tps"]);

const VALID_TIME_ZONE_MODES = new Set<string>(["local", "utc"]);
const ANALYTICS_TIME_RANGE_STORAGE_KEY = "analytics:timeRange";
const ANALYTICS_TIMING_METRIC_STORAGE_KEY = "analytics:timingMetric";
const ANALYTICS_TIME_ZONE_MODE_STORAGE_KEY = "analytics:timeZoneMode";

/** Coerce a persisted value to a known TimeRange, falling back to "30d" if stale/corrupted. */
function normalizeTimeRange(value: unknown): TimeRange {
  return typeof value === "string" && VALID_TIME_RANGES.has(value) ? (value as TimeRange) : "30d";
}

/** Coerce a persisted value to a known TimingMetric, falling back to "duration" if stale/corrupted. */
function normalizeTimingMetric(value: unknown): TimingMetric {
  return typeof value === "string" && VALID_TIMING_METRICS.has(value)
    ? (value as TimingMetric)
    : "duration";
}

/** Build a calendar-date boundary for the selected timezone. */
function getDateKeyInTimeZone(date: Date, timeZone: string): string {
  const parts = new Intl.DateTimeFormat("en-US", {
    timeZone,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  }).formatToParts(date);
  const values = new Map(parts.map((part) => [part.type, part.value]));
  const year = values.get("year");
  const month = values.get("month");
  const day = values.get("day");
  if (year == null || month == null || day == null) {
    throw new Error(`Unable to format date for timezone ${timeZone}`);
  }

  return `${year}-${month}-${day}`;
}

function dateFromDateKey(dateKey: string): Date {
  const [year, month, day] = dateKey.split("-").map(Number);
  return new Date(Date.UTC(year, month - 1, day));
}

function daysAgoInTimeZone(days: number, timeZone: string): Date {
  const dateKey = getDateKeyInTimeZone(new Date(), timeZone);
  const date = dateFromDateKey(dateKey);
  date.setUTCDate(date.getUTCDate() - days);
  return date;
}

function computeDateRange(
  timeRange: TimeRange,
  timeZone: string
): {
  from: Date | null;
  to: Date | null;
  granularity: "hour" | "day" | "week";
} {
  switch (timeRange) {
    case "7d":
      return { from: daysAgoInTimeZone(6, timeZone), to: null, granularity: "day" };
    case "30d":
      return { from: daysAgoInTimeZone(29, timeZone), to: null, granularity: "day" };
    case "90d":
      return { from: daysAgoInTimeZone(89, timeZone), to: null, granularity: "week" };
    case "all":
      return { from: null, to: null, granularity: "week" };
    default:
      // Self-heal: unknown persisted value → safe default.
      return { from: daysAgoInTimeZone(29, timeZone), to: null, granularity: "day" };
  }
}

/** Coerce a persisted value to a supported timezone mode. */
function normalizeTimeZoneMode(value: unknown): TimeZoneMode {
  return typeof value === "string" && VALID_TIME_ZONE_MODES.has(value)
    ? (value as TimeZoneMode)
    : "local";
}

function getBrowserTimeZone(): string {
  return Intl.DateTimeFormat().resolvedOptions().timeZone || "UTC";
}

export function AnalyticsDashboard(props: AnalyticsDashboardProps) {
  const { navigateFromAnalytics } = useRouter();
  const { userProjects } = useProjectContext();

  const [projectPath, setProjectPath] = useState<string | null>(null);
  const [rawTimeRange, setTimeRange] = usePersistedState<TimeRange>(
    ANALYTICS_TIME_RANGE_STORAGE_KEY,
    "30d"
  );
  const [rawTimingMetric, setTimingMetric] = usePersistedState<TimingMetric>(
    ANALYTICS_TIMING_METRIC_STORAGE_KEY,
    "duration"
  );
  const [rawTimeZoneMode, setTimeZoneMode] = usePersistedState<TimeZoneMode>(
    ANALYTICS_TIME_ZONE_MODE_STORAGE_KEY,
    "local"
  );

  // Coerce persisted values to known enums — stale/corrupted localStorage
  // entries self-heal to defaults instead of crashing the dashboard.
  const timeRange = normalizeTimeRange(rawTimeRange);
  const timingMetric = normalizeTimingMetric(rawTimingMetric);
  const timeZoneMode = normalizeTimeZoneMode(rawTimeZoneMode);
  const timeZone = timeZoneMode === "utc" ? "UTC" : getBrowserTimeZone();

  const dateRange = computeDateRange(timeRange, "UTC");
  const spendDateRange = computeDateRange(timeRange, timeZone);
  // SQL predicate substituted for the time-filter placeholder in saved panels
  // and the SQL explorer, so user-authored queries can opt into the header's
  // date-range selection.
  const timeFilterSql = buildTimeFilterPredicate(dateRange.from, dateRange.to);

  const summary = useAnalyticsSummary(projectPath, {
    from: dateRange.from,
    to: dateRange.to,
  });
  const spendOverTime = useAnalyticsSpendOverTime({
    projectPath,
    granularity: spendDateRange.granularity,
    from: spendDateRange.from,
    to: spendDateRange.to,
    timeZone,
  });
  const spendByProject = useAnalyticsSpendByProject({
    from: dateRange.from,
    to: dateRange.to,
  });
  const spendByModel = useAnalyticsSpendByModel(projectPath, {
    from: dateRange.from,
    to: dateRange.to,
  });
  const tokensByModel = useAnalyticsTokensByModel(projectPath, {
    from: dateRange.from,
    to: dateRange.to,
  });
  const timingDistribution = useAnalyticsTimingDistribution(timingMetric, projectPath, {
    from: dateRange.from,
    to: dateRange.to,
  });
  const providerCacheHitRatios = useAnalyticsProviderCacheHitRatio(projectPath, {
    from: dateRange.from,
    to: dateRange.to,
  });
  const agentCosts = useAnalyticsAgentCostBreakdown(projectPath, {
    from: dateRange.from,
    to: dateRange.to,
  });
  const delegationSummary = useAnalyticsDelegationSummary(projectPath, {
    from: dateRange.from,
    to: dateRange.to,
  });

  const {
    queries: savedQueries,
    save: saveQuery,
    update: updateSavedQuery,
    remove: removeSavedQuery,
  } = useSavedQueries();

  const projectRows = Array.from(userProjects.entries())
    .map(([path]) => ({
      path,
      label: formatProjectDisplayName(path),
    }))
    .sort((a, b) => a.label.localeCompare(b.label));

  const desktopMode = isDesktopMode();

  // Close analytics on Escape. Uses bubble phase so inner surfaces (Select dropdowns,
  // Popover) that call stopPropagation/preventDefault on Escape get first
  // right of refusal—only an unclaimed Escape navigates away from analytics.
  useEffect(() => {
    const onKeyDown = (e: KeyboardEvent) => {
      if (!matchesKeybind(e, KEYBINDS.CANCEL)) return;
      if (e.defaultPrevented) return;
      if (isEditableElement(e.target)) return;

      e.preventDefault();
      e.stopPropagation();
      navigateFromAnalytics();
    };

    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
  }, [navigateFromAnalytics]);

  return (
    <div className="bg-surface-primary flex min-h-0 flex-1 flex-col overflow-hidden">
      <div
        data-testid="analytics-header"
        className={cn(
          `bg-surface-primary border-border-light titlebar-safe-right 
          titlebar-safe-right-gutter-3 flex shrink-0 items-center gap-2 border-b px-3`,
          desktopMode
            ? `${DESKTOP_TITLEBAR_HEIGHT_CLASS} titlebar-drag flex-nowrap`
            : "flex-wrap py-2 md:h-8 md:flex-nowrap md:py-0"
        )}
      >
        <div
          className={cn(
            "flex min-w-0 items-center gap-2",
            desktopMode ? "w-auto titlebar-no-drag" : "w-full md:w-auto"
          )}
        >
          {props.leftSidebarCollapsed && (
            <Button
              variant="ghost"
              size="icon"
              onClick={props.onToggleLeftSidebarCollapsed}
              title="Open sidebar"
              aria-label="Open sidebar"
              // The left sidebar is fully off-canvas on narrow viewports, so this route must
              // expose the shared mobile menu control instead of hiding its only opener.
              className="mobile-menu-btn text-muted hover:text-foreground hidden h-6 w-6 md:inline-flex"
            >
              <Menu className="h-4 w-4" />
            </Button>
          )}
          <Button
            variant="ghost"
            size="sm"
            onClick={navigateFromAnalytics}
            className="text-muted hover:text-foreground h-6 gap-1 px-2 text-xs"
            title="Back"
            aria-label="Back to previous view"
          >
            <ArrowLeft className="h-3.5 w-3.5" />
            Back
          </Button>
          <h1 className="text-foreground text-sm font-semibold">Analytics</h1>
        </div>

        <div
          className={cn(
            desktopMode
              ? "titlebar-no-drag ml-auto flex min-w-fit items-center gap-2"
              : "flex w-full min-w-0 flex-wrap items-center gap-2 md:ml-auto md:w-auto md:min-w-fit md:flex-nowrap"
          )}
        >
          {/* Keep the project control labeled on mobile for screen readers while
              keeping the compact mobile header visually uncluttered. */}
          <label
            className="text-muted sr-only text-xs md:not-sr-only md:inline"
            htmlFor="analytics-project-filter"
          >
            Project
          </label>
          <select
            id="analytics-project-filter"
            value={projectPath ?? "__all"}
            onChange={(event) => {
              const nextValue = event.target.value;
              setProjectPath(nextValue === "__all" ? null : nextValue);
            }}
            className="border-border-medium bg-separator text-foreground h-6 min-w-0 flex-1 rounded border px-2 text-xs md:max-w-56 md:flex-none"
          >
            <option value="__all">All projects</option>
            {projectRows.map((project) => (
              <option key={project.path} value={project.path}>
                {project.label}
              </option>
            ))}
          </select>

          <div className="flex shrink-0 items-center gap-1">
            <span className="text-muted text-xs">Timezone</span>
            <ToggleGroup
              options={[
                { value: "local", label: "Local" },
                { value: "utc", label: "UTC" },
              ]}
              value={timeZoneMode}
              onChange={setTimeZoneMode}
            />
          </div>

          <div className="border-border-medium bg-background ml-auto flex shrink-0 items-center gap-1 rounded-md border p-1">
            {(
              [
                ["7d", "7D"],
                ["30d", "30D"],
                ["90d", "90D"],
                ["all", "All"],
              ] as const
            ).map(([range, label]) => (
              <Button
                key={range}
                variant={timeRange === range ? "secondary" : "ghost"}
                size="sm"
                className="h-6 px-2 text-xs"
                onClick={() => setTimeRange(range)}
              >
                {label}
              </Button>
            ))}
          </div>
        </div>
      </div>

      <div className="flex-1 overflow-y-auto p-4">
        <div className="mx-auto flex w-full max-w-6xl flex-col gap-4">
          <SummaryCards data={summary.data} loading={summary.loading} error={summary.error} />
          <SpendChart
            data={spendOverTime.data}
            loading={spendOverTime.loading}
            error={spendOverTime.error}
            granularity={spendDateRange.granularity}
            timeZoneMode={timeZoneMode}
          />
          <ModelBreakdown spendByProject={spendByProject} spendByModel={spendByModel} />
          <TokensByModelChart
            data={tokensByModel.data}
            loading={tokensByModel.loading}
            error={tokensByModel.error}
          />
          <TimingChart
            data={timingDistribution.data}
            loading={timingDistribution.loading}
            error={timingDistribution.error}
            metric={timingMetric}
            onMetricChange={setTimingMetric}
          />
          <ProviderCacheHitChart
            data={providerCacheHitRatios.data}
            loading={providerCacheHitRatios.loading}
            error={providerCacheHitRatios.error}
          />
          <AgentCostChart
            data={agentCosts.data}
            loading={agentCosts.loading}
            error={agentCosts.error}
          />
          <DelegationChart
            data={delegationSummary.data}
            loading={delegationSummary.loading}
            error={delegationSummary.error}
          />
          {savedQueries.length > 0 && (
            <div className="flex flex-col gap-4">
              {savedQueries.map((query) => (
                <SavedQueryPanel
                  key={query.id}
                  query={query}
                  timeFilterSql={timeFilterSql}
                  onDelete={removeSavedQuery}
                  onUpdate={updateSavedQuery}
                />
              ))}
            </div>
          )}
          <SqlExplorer onSaveQuery={saveQuery} timeFilterSql={timeFilterSql} />
        </div>
      </div>
    </div>
  );
}

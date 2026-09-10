import {
  Bar,
  BarChart,
  CartesianGrid,
  Legend,
  ResponsiveContainer,
  Tooltip,
  XAxis,
  YAxis,
} from "recharts";
import { Skeleton } from "@/browser/components/Skeleton/Skeleton";
import type { SpendOverTimeItem } from "@/browser/hooks/useAnalytics";
import {
  ANALYTICS_CHART_COLORS,
  CHART_AXIS_STROKE,
  CHART_AXIS_TICK,
  CHART_TOOLTIP_CONTENT_STYLE,
  formatBucketLabel,
  formatBucketTooltipLabel,
  formatUsd,
} from "./analyticsUtils";

interface SpendChartProps {
  data: SpendOverTimeItem[] | null;
  loading: boolean;
  error: string | null;
  granularity: "hour" | "day" | "week";
  timeZoneMode: "local" | "utc";
}

interface SpendChartRow {
  bucket: string;
  totalCostUsd: number;
  [model: string]: string | number;
}

export function SpendChart(props: SpendChartProps) {
  if (props.error) {
    return (
      <div className="bg-background-secondary border-danger-soft rounded-lg border p-4">
        <h2 className="text-foreground text-sm font-semibold">Spend over time</h2>
        <p className="text-danger mt-2 text-xs">Failed to load chart data: {props.error}</p>
      </div>
    );
  }

  const rowsByBucket = new Map<string, SpendChartRow>();
  const models: string[] = [];

  for (const item of props.data ?? []) {
    if (!models.includes(item.model)) {
      models.push(item.model);
    }

    const existingRow = rowsByBucket.get(item.bucket) ?? {
      bucket: item.bucket,
      totalCostUsd: 0,
    };

    const currentModelCost =
      typeof existingRow[item.model] === "number" ? Number(existingRow[item.model]) : 0;

    existingRow[item.model] = currentModelCost + item.costUsd;
    existingRow.totalCostUsd += item.costUsd;

    rowsByBucket.set(item.bucket, existingRow);
  }

  const rows = Array.from(rowsByBucket.values()).sort((a, b) => a.bucket.localeCompare(b.bucket));

  return (
    <div className="bg-background-secondary border-border-medium rounded-lg border p-4">
      <h2 className="text-foreground text-sm font-semibold">Spend over time</h2>
      <p className="text-muted mt-1 text-xs">
        {props.granularity === "week"
          ? "Model-attributed weekly spend."
          : props.granularity === "hour"
            ? "Model-attributed hourly spend."
            : "Model-attributed daily spend."}{" "}
        ({props.timeZoneMode === "utc" ? "UTC" : "local time"})
      </p>

      {props.loading ? (
        <div className="mt-3">
          <Skeleton variant="shimmer" className="h-80 w-full" />
        </div>
      ) : rows.length === 0 ? (
        <div className="text-muted mt-3 rounded border border-dashed px-3 py-10 text-center text-sm">
          No spend data for the selected filters.
        </div>
      ) : (
        <div className="mt-3 h-80 w-full">
          <ResponsiveContainer width="100%" height="100%">
            <BarChart data={rows} margin={{ top: 8, right: 12, left: 4, bottom: 0 }}>
              <CartesianGrid strokeDasharray="3 3" stroke={CHART_AXIS_STROKE} />
              <XAxis
                dataKey="bucket"
                minTickGap={24}
                tick={CHART_AXIS_TICK}
                tickFormatter={formatBucketLabel}
                stroke={CHART_AXIS_STROKE}
              />
              <YAxis
                tick={CHART_AXIS_TICK}
                tickFormatter={(value: number) => formatUsd(Number(value))}
                width={64}
                stroke={CHART_AXIS_STROKE}
              />
              <Tooltip
                labelFormatter={(value) =>
                  formatBucketTooltipLabel(String(value), props.granularity)
                }
                formatter={(value: number, key: string) => [formatUsd(Number(value)), key]}
                cursor={{ fill: "var(--color-hover)" }}
                contentStyle={CHART_TOOLTIP_CONTENT_STYLE}
              />
              <Legend wrapperStyle={{ fontSize: "11px" }} />
              {models.map((model, index) => (
                <Bar
                  key={model}
                  dataKey={model}
                  stackId="model-spend"
                  fill={ANALYTICS_CHART_COLORS[index % ANALYTICS_CHART_COLORS.length]}
                  radius={index === models.length - 1 ? [4, 4, 0, 0] : [0, 0, 0, 0]}
                />
              ))}
            </BarChart>
          </ResponsiveContainer>
        </div>
      )}
    </div>
  );
}

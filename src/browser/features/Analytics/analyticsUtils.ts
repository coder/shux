import assert from "@/common/utils/assert";

// Shared color palette for all analytics charts.
// Uses theme tokens so colors remain legible in both dark and light themes.
export const ANALYTICS_CHART_COLORS = [
  "var(--color-plan-mode)",
  "var(--color-exec-mode)",
  "var(--color-task-mode)",
  "var(--color-success)",
  "var(--color-warning)",
  "var(--color-danger)",
  "var(--color-info)",
  "var(--color-ask-mode)",
] as const;

/** Token category colors shared across charts (TokensByModel, Delegation). */
export const TOKEN_CATEGORY_COLORS = {
  inputTokens: "var(--color-plan-mode)",
  cachedTokens: "var(--color-info)",
  cacheCreateTokens: "var(--color-ask-mode)",
  outputTokens: "var(--color-exec-mode)",
  reasoningTokens: "var(--color-task-mode)",
} as const;
// Shared recharts styling constants so each chart component stays DRY.
// These match the project's CSS custom-property theme tokens.

/** Axis tick label style shared by all analytics charts. */
export const CHART_AXIS_TICK = { fill: "var(--color-muted)", fontSize: 11 } as const;

/** Axis / grid stroke colour. */
export const CHART_AXIS_STROKE = "var(--color-border-light)";

/** Tooltip content style shared by charts that use recharts `<Tooltip>`. */
export const CHART_TOOLTIP_CONTENT_STYLE = {
  borderColor: "var(--color-border-medium)",
  backgroundColor: "var(--color-background-secondary)",
  borderRadius: "8px",
} as const;

const usdFormatter = new Intl.NumberFormat("en-US", {
  style: "currency",
  currency: "USD",
  minimumFractionDigits: 2,
  maximumFractionDigits: 2,
});

const compactNumberFormatter = new Intl.NumberFormat("en-US", {
  notation: "compact",
  maximumFractionDigits: 1,
});

const BUCKET_TIME_COMPONENT_PATTERN = /(?:^|[ T])\d{2}:\d{2}(?::\d{2}(?:\.\d+)?)?/;
const BUCKET_DATE_TIME_PATTERN =
  /^(\d{4})-(\d{2})-(\d{2})[ T](\d{2}):(\d{2})(?::(\d{2})(?:\.\d+)?)?/;

function parseBucketWallTime(bucket: string): {
  year: number;
  month: number;
  day: number;
  hour: number;
  minute: number;
} | null {
  const match = BUCKET_DATE_TIME_PATTERN.exec(bucket);
  if (!match) {
    return null;
  }

  const [, year, month, day, hour, minute] = match;
  return {
    year: Number(year),
    month: Number(month),
    day: Number(day),
    hour: Number(hour),
    minute: Number(minute),
  };
}

function formatBucketWallTime(bucket: string): string | null {
  const parts = parseBucketWallTime(bucket);
  if (!parts) {
    return null;
  }

  const date = new Date(Date.UTC(parts.year, parts.month - 1, parts.day));
  if (!Number.isFinite(date.getTime())) {
    return null;
  }

  return (
    date.toLocaleDateString(undefined, {
      month: "short",
      day: "numeric",
      timeZone: "UTC",
    }) +
    `, ${parts.hour % 12 || 12}:${String(parts.minute).padStart(2, "0")} ${parts.hour >= 12 ? "PM" : "AM"}`
  );
}

export function formatUsd(amount: number): string {
  if (!Number.isFinite(amount)) {
    return "$0.00";
  }
  return usdFormatter.format(amount);
}

export function formatPercent(ratio: number): string {
  if (!Number.isFinite(ratio)) {
    return "0.0%";
  }

  const normalizedRatio = ratio <= 1 ? ratio * 100 : ratio;
  return `${normalizedRatio.toFixed(1)}%`;
}

export function formatCompactNumber(value: number): string {
  if (!Number.isFinite(value)) {
    return "0";
  }
  return compactNumberFormatter.format(value);
}

export function formatProjectDisplayName(projectPath: string): string {
  assert(typeof projectPath === "string", "projectPath must be a string");
  const pathSegments = projectPath.split(/[\\/]/).filter(Boolean);
  return pathSegments[pathSegments.length - 1] ?? projectPath;
}

export function formatBucketLabel(bucket: string): string {
  const includesTime = BUCKET_TIME_COMPONENT_PATTERN.test(bucket);
  if (includesTime) {
    return formatBucketWallTime(bucket) ?? bucket;
  }

  const parsedDate = new Date(bucket);
  if (!Number.isFinite(parsedDate.getTime())) {
    return bucket;
  }

  // Date-only buckets (YYYY-MM-DD) are UTC midnight. Render with
  // timeZone: "UTC" so west-of-UTC locales don't shift the displayed day
  // (e.g. 2026-02-01 showing as "Jan 31" in PST).
  return parsedDate.toLocaleDateString(undefined, {
    month: "short",
    day: "numeric",
    timeZone: "UTC",
  });
}

/** Granularity-aware label for tooltip headers.
 *  Weekly buckets render as a date range (e.g. "Feb 23 – Mar 1");
 *  all other granularities delegate to `formatBucketLabel`. */
export function formatBucketTooltipLabel(
  bucket: string,
  granularity: "hour" | "day" | "week"
): string {
  if (granularity !== "week") return formatBucketLabel(bucket);

  const start = new Date(bucket);
  if (!Number.isFinite(start.getTime())) return bucket;

  const end = new Date(start);
  end.setUTCDate(end.getUTCDate() + 6);

  const opts: Intl.DateTimeFormatOptions = { month: "short", day: "numeric", timeZone: "UTC" };
  return `${start.toLocaleDateString(undefined, opts)} – ${end.toLocaleDateString(undefined, opts)}`;
}

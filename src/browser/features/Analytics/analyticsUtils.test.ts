import { describe, expect, test } from "bun:test";
import { formatBucketLabel, formatBucketTooltipLabel } from "./analyticsUtils";

describe("formatBucketLabel", () => {
  test("formats date-only bucket as short date", () => {
    expect(formatBucketLabel("2026-02-23")).toBe("Feb 23");
  });

  test("formats time-containing bucket with hour", () => {
    const result = formatBucketLabel("2026-02-23 14:00:00");
    expect(result).toContain("Feb");
    expect(result).toContain("23");
  });

  test("keeps the hour in a localized hourly bucket", () => {
    const result = formatBucketLabel("2026-02-23 14:00:00");
    expect(result).toMatch(/Feb 23, 2:00 PM/);
  });

  test("returns raw string for unparseable input", () => {
    expect(formatBucketLabel("not-a-date")).toBe("not-a-date");
  });
});

describe("formatBucketTooltipLabel", () => {
  test("renders week range for weekly buckets", () => {
    const result = formatBucketTooltipLabel("2026-02-23", "week");
    // Start of week → end of week (Mon–Sun): Feb 23 – Mar 1
    expect(result).toContain("Feb 23");
    expect(result).toContain("Mar 1");
    expect(result).toContain("–");
  });

  test("renders range spanning same month for weekly buckets", () => {
    const result = formatBucketTooltipLabel("2026-02-02", "week");
    expect(result).toContain("Feb 2");
    expect(result).toContain("Feb 8");
    expect(result).toContain("–");
  });

  test("falls back to single bucket label for daily granularity", () => {
    expect(formatBucketTooltipLabel("2026-02-23", "day")).toBe("Feb 23");
  });

  test("falls back to single bucket label for hourly granularity", () => {
    const result = formatBucketTooltipLabel("2026-02-23 14:00:00", "hour");
    expect(result).toContain("Feb");
    expect(result).toContain("23");
  });

  test("returns raw string for unparseable input in week mode", () => {
    expect(formatBucketTooltipLabel("not-a-date", "week")).toBe("not-a-date");
  });
});

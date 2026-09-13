import type { AdvisorCallCompletedPayload } from "@/common/telemetry/payload";
import { roundToBase2 } from "@/common/telemetry/utils";
import type { ModelMessage } from "@/common/types/message";
import type { AiSdkUsageLike } from "@/common/utils/tokens/usageHelpers";
import { getModelStats, resolveRawModelEntry } from "@/common/utils/tokens/modelStats";

function record(value: unknown): Record<string, unknown> | undefined {
  return value != null && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : undefined;
}

function count(value: unknown): number | null {
  return typeof value === "number" && Number.isFinite(value) && value >= 0 ? value : null;
}

function rounded(value: number | null): number | null {
  return value == null ? null : Math.sign(value) * roundToBase2(Math.abs(value));
}

/** Inspect explicit request markers without sending their content or cache keys. */
export function advisorCachePolicy(messages: ModelMessage[], providerOptions?: unknown) {
  return advisorWireCachePolicy({ messages, providerOptions });
}

/** Inspect effective wire markers after provider cache injection and TTL overrides. */
export function advisorWireCachePolicy(requestBody: unknown) {
  let markerCount = 0;
  const ttls = new Set<"5m" | "1h" | "unknown">();
  const inspect = (value: unknown) => {
    const marker = record(value);
    if (!marker) return;
    markerCount++;
    ttls.add(
      marker.ttl == null || marker.ttl === "5m" ? "5m" : marker.ttl === "1h" ? "1h" : "unknown"
    );
  };
  const pending: unknown[] = [requestBody];
  while (pending.length > 0) {
    const value = pending.pop();
    if (Array.isArray(value)) {
      for (const item of value) pending.push(item);
      continue;
    }
    const entry = record(value);
    if (!entry) continue;
    inspect(entry.cache_control);
    inspect(record(record(entry.providerOptions)?.anthropic)?.cacheControl);
    // Do not treat tool input schemas or tool results as request cache markers.
    for (const key of ["system", "messages", "prompt", "tools", "content"]) {
      if (Array.isArray(entry[key])) pending.push(entry[key]);
    }
  }
  const ttl: AdvisorCallCompletedPayload["cache_ttl"] =
    ttls.size > 1 ? "mixed" : (ttls.values().next().value ?? "unknown");
  return { cache_marker_count: markerCount, cache_ttl: ttl };
}

/** Compare cache premiums with read savings before privacy rounding. */
export function advisorUsageTelemetry(
  model: string,
  usage: AiSdkUsageLike | undefined,
  metadata: Record<string, unknown> | undefined,
  ttl: AdvisorCallCompletedPayload["cache_ttl"]
) {
  // Catalog membership prevents custom aliases and endpoint names from entering PostHog.
  const safeModel = resolveRawModelEntry(model)?.key ?? "unknown";
  const input = count(usage?.inputTokens);
  const read = count(usage?.inputTokenDetails?.cacheReadTokens ?? usage?.cachedInputTokens);
  const write = count(
    usage?.inputTokenDetails?.cacheWriteTokens ??
      record(metadata?.anthropic)?.cacheCreationInputTokens
  );
  const uncached =
    input != null && read != null && write != null ? Math.max(0, input - read - write) : null;
  let cost: number | null = null;
  let premium: number | null = null;
  let savings: number | null = null;
  const stats = safeModel === "unknown" ? undefined : getModelStats(safeModel);
  // Unknown TTLs, routes, or token details cannot support reliable cache cost estimates.
  if (
    (model.startsWith("anthropic:") || model.startsWith("anthropic/")) &&
    stats &&
    input != null &&
    uncached != null &&
    read != null &&
    write != null &&
    (ttl === "5m" || ttl === "1h")
  ) {
    const high =
      stats.tiered_pricing_threshold_tokens != null &&
      input > stats.tiered_pricing_threshold_tokens;
    const inputRate = high
      ? (stats.input_cost_per_token_above_200k_tokens ?? stats.input_cost_per_token)
      : stats.input_cost_per_token;
    const readRate = high
      ? (stats.cache_read_input_token_cost_above_200k_tokens ?? stats.cache_read_input_token_cost)
      : stats.cache_read_input_token_cost;
    const writeRate =
      ttl === "1h"
        ? 2 * inputRate
        : high
          ? (stats.cache_creation_input_token_cost_above_200k_tokens ??
            stats.cache_creation_input_token_cost)
          : stats.cache_creation_input_token_cost;
    if (readRate != null && writeRate != null) {
      cost = uncached * inputRate + read * readRate + write * writeRate;
      premium = write * (writeRate - inputRate);
      savings = read * (inputRate - readRate);
    }
  }
  return {
    model: safeModel,
    usage_available: usage != null,
    input_tokens_b2: rounded(input),
    uncached_input_tokens_b2: rounded(uncached),
    cache_read_tokens_b2: rounded(read),
    cache_write_tokens_b2: rounded(write),
    output_tokens_b2: rounded(count(usage?.outputTokens)),
    input_cost_usd_b2: rounded(cost),
    cache_write_premium_usd_b2: rounded(premium),
    cache_read_savings_usd_b2: rounded(savings),
    cache_net_savings_usd_b2: rounded(
      premium != null && savings != null ? savings - premium : null
    ),
  };
}

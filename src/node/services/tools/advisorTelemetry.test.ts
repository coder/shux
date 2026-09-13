import { describe, expect, it } from "bun:test";
import type { ModelMessage } from "@/common/types/message";
import { advisorCachePolicy, advisorUsageTelemetry } from "./advisorTelemetry";

const MODEL = "anthropic:claude-sonnet-4-20250514";

function usage(input: number, read: number, write: number) {
  return {
    inputTokens: input,
    outputTokens: 0,
    inputTokenDetails: { cacheReadTokens: read, cacheWriteTokens: write },
  };
}

function marker(ttl?: string) {
  return { anthropic: { cacheControl: { type: "ephemeral", ...(ttl ? { ttl } : {}) } } };
}

describe("advisorUsageTelemetry", () => {
  it("excludes private model names and unsupported cost estimates", () => {
    const event = advisorUsageTelemetry(
      "private-provider:customer-secret-model",
      usage(100, 50, 25),
      undefined,
      "5m"
    );
    expect(event.model).toBe("unknown");
    expect(JSON.stringify(event)).not.toContain("customer-secret");
    expect(event.input_tokens_b2).toBe(128);
    expect(event.input_cost_usd_b2).toBeNull();
    expect(event.cache_net_savings_usd_b2).toBeNull();
  });

  it("distinguishes missing usage from measured zero usage", () => {
    const missing = advisorUsageTelemetry(MODEL, undefined, undefined, "5m");
    expect(missing.usage_available).toBe(false);
    expect(missing.input_tokens_b2).toBeNull();
    expect(missing.output_tokens_b2).toBeNull();
    expect(missing.cache_read_tokens_b2).toBeNull();
    expect(missing.cache_write_tokens_b2).toBeNull();
    expect(missing.uncached_input_tokens_b2).toBeNull();
    expect(missing.input_cost_usd_b2).toBeNull();

    const zero = advisorUsageTelemetry(MODEL, usage(0, 0, 0), undefined, "5m");
    expect(zero.usage_available).toBe(true);
    expect(zero.input_tokens_b2).toBe(0);
    expect(zero.output_tokens_b2).toBe(0);
    expect(zero.cache_read_tokens_b2).toBe(0);
    expect(zero.cache_write_tokens_b2).toBe(0);
    expect(zero.uncached_input_tokens_b2).toBe(0);
    expect(zero.input_cost_usd_b2).toBe(0);
    expect(zero.cache_net_savings_usd_b2).toBe(0);
  });

  it("keeps absent cache details unknown when input usage exists", () => {
    const event = advisorUsageTelemetry(
      MODEL,
      { inputTokens: 100, outputTokens: 0 },
      undefined,
      "5m"
    );
    expect(event.usage_available).toBe(true);
    expect(event.cache_read_tokens_b2).toBeNull();
    expect(event.cache_write_tokens_b2).toBeNull();
    expect(event.uncached_input_tokens_b2).toBeNull();
    expect(event.input_cost_usd_b2).toBeNull();
  });

  it("preserves the sign of cache savings and write premiums", () => {
    const reads = advisorUsageTelemetry(MODEL, usage(1000, 1000, 0), undefined, "5m");
    const writes = advisorUsageTelemetry(MODEL, usage(1000, 0, 1000), undefined, "5m");
    expect(reads.model).toBe("claude-sonnet-4-20250514");
    expect(reads.cache_net_savings_usd_b2).toBeGreaterThan(0);
    expect(writes.cache_net_savings_usd_b2).toBeLessThan(0);
    expect(writes.cache_write_premium_usd_b2).toBeGreaterThan(0);
    expect(reads.cache_write_premium_usd_b2).toBe(0);
    expect(writes.cache_read_savings_usd_b2).toBe(0);
  });

  it("charges the long TTL write rate instead of the short TTL rate", () => {
    const short = advisorUsageTelemetry(MODEL, usage(1000, 0, 1000), undefined, "5m");
    const long = advisorUsageTelemetry(MODEL, usage(1000, 0, 1000), undefined, "1h");
    // These buckets distinguish the catalog write rate from the long TTL rate.
    expect(short.input_cost_usd_b2).toBe(2 ** -8);
    expect(long.input_cost_usd_b2).toBe(2 ** -7);
    expect(long.cache_write_premium_usd_b2).toBe(2 ** -8);
    expect(long.cache_net_savings_usd_b2).toBe(-(2 ** -8));
  });

  it.each(["unknown", "mixed"] as const)("omits cost estimates for %s TTL", (ttl) => {
    const event = advisorUsageTelemetry(MODEL, usage(1000, 500, 500), undefined, ttl);
    expect(event.input_cost_usd_b2).toBeNull();
    expect(event.cache_write_premium_usd_b2).toBeNull();
    expect(event.cache_read_savings_usd_b2).toBeNull();
    expect(event.cache_net_savings_usd_b2).toBeNull();
  });
});

describe("advisorCachePolicy", () => {
  it.each([
    [undefined, "5m"],
    ["5m", "5m"],
    ["1h", "1h"],
    ["unsupported", "unknown"],
  ] as const)("detects marker TTL %s", (ttl, expected) => {
    expect(advisorCachePolicy([], marker(ttl))).toEqual({
      cache_marker_count: 1,
      cache_ttl: expected,
    });
  });

  it("counts request, message, and content markers without inspecting text", () => {
    const messages: ModelMessage[] = [
      {
        role: "user",
        providerOptions: marker(),
        content: [
          { type: "text", text: "Private content", providerOptions: marker("1h") },
          { type: "text", text: "cacheControl ttl 1h" },
        ],
      },
    ];
    expect(advisorCachePolicy(messages, marker("5m"))).toEqual({
      cache_marker_count: 3,
      cache_ttl: "mixed",
    });
  });

  it("does not infer cache markers from message text", () => {
    expect(advisorCachePolicy([{ role: "user", content: "cacheControl ttl 1h" }])).toEqual({
      cache_marker_count: 0,
      cache_ttl: "unknown",
    });
  });
});

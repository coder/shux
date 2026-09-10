import { describe, test, expect } from "bun:test";
import { createDisplayUsage, recomputeUsageCosts } from "./displayUsage";
import type { LanguageModelV2Usage } from "@ai-sdk/provider";

describe("createDisplayUsage", () => {
  describe("AI SDK v6: unified cached token subtraction", () => {
    // AI SDK v6 changed semantics: ALL providers now report inputTokens INCLUSIVE
    // of cached tokens. We always subtract cachedInputTokens + cacheCreateTokens
    // to get the true non-cached input.

    test("subtracts cached tokens for OpenAI model", () => {
      const openAIUsage: LanguageModelV2Usage = {
        inputTokens: 108200, // Includes 71600 cached
        outputTokens: 227,
        totalTokens: 108427,
        cachedInputTokens: 71600,
      };

      const result = createDisplayUsage(openAIUsage, "openai:gpt-5.2");

      expect(result).toBeDefined();
      expect(result!.cached.tokens).toBe(71600);
      // Input = raw minus cached: 108200 - 71600 = 36600
      expect(result!.input.tokens).toBe(36600);
    });

    test("subtracts cached tokens for gateway OpenAI model", () => {
      const openAIUsage: LanguageModelV2Usage = {
        inputTokens: 108200,
        outputTokens: 227,
        totalTokens: 108427,
        cachedInputTokens: 71600,
      };

      const result = createDisplayUsage(openAIUsage, "mux-gateway:openai/gpt-5.2");

      expect(result).toBeDefined();
      expect(result!.cached.tokens).toBe(71600);
      // Input = raw minus cached: 108200 - 71600 = 36600
      expect(result!.input.tokens).toBe(36600);
    });

    test("subtracts cached tokens for Anthropic model (v6 semantics)", () => {
      // In v6, Anthropic now reports inputTokens INCLUSIVE of cached tokens
      // (matching OpenAI/Google behavior). inputTokens = input + cache_read + cache_write.
      const anthropicUsage: LanguageModelV2Usage = {
        inputTokens: 108200, // 36600 non-cached + 71600 cache_read
        outputTokens: 227,
        totalTokens: 108427,
        cachedInputTokens: 71600,
      };

      const result = createDisplayUsage(anthropicUsage, "anthropic:claude-opus-4-6");

      expect(result).toBeDefined();
      expect(result!.cached.tokens).toBe(71600);
      // Input = raw minus cached: 108200 - 71600 = 36600 (non-cached only)
      expect(result!.input.tokens).toBe(36600);
    });

    test("subtracts cached tokens for gateway Anthropic model", () => {
      const anthropicUsage: LanguageModelV2Usage = {
        inputTokens: 108200,
        outputTokens: 227,
        totalTokens: 108427,
        cachedInputTokens: 71600,
      };

      const result = createDisplayUsage(anthropicUsage, "mux-gateway:anthropic/claude-opus-4-6");

      expect(result).toBeDefined();
      expect(result!.cached.tokens).toBe(71600);
      // Input = raw minus cached: 108200 - 71600 = 36600
      expect(result!.input.tokens).toBe(36600);
    });

    test("subtracts both cached and cache-create for Anthropic with cache creation", () => {
      // Anthropic with both cache_read and cache_creation tokens
      // inputTokens = 500 non-cached + 100000 cache_read + 5000 cache_write = 105500
      const usage: LanguageModelV2Usage = {
        inputTokens: 105500,
        outputTokens: 1000,
        totalTokens: 106500,
        cachedInputTokens: 100000,
      };

      const result = createDisplayUsage(usage, "anthropic:claude-opus-4-6", {
        anthropic: { cacheCreationInputTokens: 5000 },
      });

      expect(result).toBeDefined();
      expect(result!.input.tokens).toBe(500); // 105500 - 100000 - 5000
      expect(result!.cached.tokens).toBe(100000);
      expect(result!.cacheCreate.tokens).toBe(5000);
      expect(result!.output.tokens).toBe(1000);

      // Total should match actual context (no double counting)
      const total =
        result!.input.tokens +
        result!.cached.tokens +
        result!.cacheCreate.tokens +
        result!.output.tokens;
      expect(total).toBe(106500);
    });

    test("subtracts cached tokens for Google model", () => {
      const googleUsage: LanguageModelV2Usage = {
        inputTokens: 74300, // Includes 42600 cached
        outputTokens: 1600,
        totalTokens: 75900,
        cachedInputTokens: 42600,
      };

      const result = createDisplayUsage(googleUsage, "google:gemini-3-pro-preview");

      expect(result).toBeDefined();
      expect(result!.cached.tokens).toBe(42600);
      // Input = raw minus cached: 74300 - 42600 = 31700
      expect(result!.input.tokens).toBe(31700);
    });

    test("subtracts cached tokens for gateway Google model", () => {
      const googleUsage: LanguageModelV2Usage = {
        inputTokens: 74300,
        outputTokens: 1600,
        totalTokens: 75900,
        cachedInputTokens: 42600,
      };

      const result = createDisplayUsage(googleUsage, "mux-gateway:google/gemini-3-pro-preview");

      expect(result).toBeDefined();
      expect(result!.cached.tokens).toBe(42600);
      // Input = raw minus cached: 74300 - 42600 = 31700
      expect(result!.input.tokens).toBe(31700);
    });
  });

  describe("backward compatibility with pre-v6 data", () => {
    test("clamps to 0 when pre-v6 Anthropic data has inputTokens excluding cache", () => {
      // Pre-v6 historical data: inputTokens excluded cache, so subtracting
      // would go negative. Math.max(0, ...) ensures no negative values.
      const oldFormatUsage: LanguageModelV2Usage = {
        inputTokens: 500, // Pre-v6: non-cached only
        outputTokens: 227,
        totalTokens: 72327,
        cachedInputTokens: 71600,
      };

      const result = createDisplayUsage(oldFormatUsage, "anthropic:claude-sonnet-4-5");

      expect(result).toBeDefined();
      // Input clamps to 0 (500 - 71600 would be negative)
      expect(result!.input.tokens).toBe(0);
      expect(result!.cached.tokens).toBe(71600);
      // Total is approximately correct (off by 500 non-cached, acceptable for old data)
    });

    test("uses outputTokens directly when smaller than reasoningTokens (reasoning-exclusive rows)", () => {
      // Historical Gemini-via-gateway rows persisted outputTokens exclusive of
      // reasoning (candidatesTokenCount), so output < reasoning. The display must
      // show the text tokens, not clamp to 0.
      const usage: LanguageModelV2Usage = {
        inputTokens: 9416,
        outputTokens: 1,
        totalTokens: 9417,
        reasoningTokens: 37,
      };

      const result = createDisplayUsage(usage, "google:gemini-3.6-flash");

      expect(result).toBeDefined();
      expect(result!.output.tokens).toBe(1);
      expect(result!.reasoning.tokens).toBe(37);
    });

    test("still subtracts reasoning from inclusive outputTokens", () => {
      const usage: LanguageModelV2Usage = {
        inputTokens: 1000,
        outputTokens: 500,
        totalTokens: 1500,
        reasoningTokens: 200,
      };

      const result = createDisplayUsage(usage, "openai:gpt-5.2");

      expect(result).toBeDefined();
      expect(result!.output.tokens).toBe(300);
      expect(result!.reasoning.tokens).toBe(200);
    });
  });

  test("returns undefined for undefined usage", () => {
    expect(createDisplayUsage(undefined, "openai:gpt-5.2")).toBeUndefined();
  });

  test("handles zero cached tokens", () => {
    const usage: LanguageModelV2Usage = {
      inputTokens: 1000,
      outputTokens: 500,
      totalTokens: 1500,
      cachedInputTokens: 0,
    };

    const result = createDisplayUsage(usage, "openai:gpt-5.2");

    expect(result).toBeDefined();
    expect(result!.input.tokens).toBe(1000);
    expect(result!.cached.tokens).toBe(0);
  });

  test("handles missing cachedInputTokens field", () => {
    const usage: LanguageModelV2Usage = {
      inputTokens: 1000,
      outputTokens: 500,
      totalTokens: 1500,
    };

    const result = createDisplayUsage(usage, "openai:gpt-5.2");

    expect(result).toBeDefined();
    expect(result!.input.tokens).toBe(1000);
    expect(result!.cached.tokens).toBe(0);
  });

  test("separates GPT-5.6 input, cache reads, and cache writes with 0.1x read / 1.25x write rates", () => {
    // OpenAI explicit-caching accounting: inputTokens is inclusive of cache
    // reads and writes; writes arrive through the legacy provider-neutral
    // `anthropic.cacheCreationInputTokens` metadata key (withCacheWriteMetadata
    // re-injects it from AI SDK 7 usage.inputTokenDetails.cacheWriteTokens).
    const usage: LanguageModelV2Usage = {
      inputTokens: 105500, // 500 uncached + 100000 cache-read + 5000 cache-write
      outputTokens: 1000,
      totalTokens: 106500,
      cachedInputTokens: 100000,
    };

    const result = createDisplayUsage(usage, "openai:gpt-5.6-luna", {
      anthropic: { cacheCreationInputTokens: 5000 },
    });

    expect(result).toBeDefined();
    expect(result!.input.tokens).toBe(500);
    expect(result!.cached.tokens).toBe(100000);
    expect(result!.cacheCreate.tokens).toBe(5000);
    // Luna base rates: $0.20/M input, $0.02/M cache read (0.1x), $0.25/M cache
    // write (1.25x), $1.20/M output. These land near 1e-3, so the default
    // toBeCloseTo precision of 2 would accept any of them; pin it explicitly.
    expect(result!.input.cost_usd).toBeCloseTo(0.0001, 10);
    expect(result!.cached.cost_usd).toBeCloseTo(0.002, 10);
    expect(result!.cacheCreate.cost_usd).toBeCloseTo(0.00125, 10);
    expect(result!.output.cost_usd).toBeCloseTo(0.0012, 10);
  });

  test("reconciles Grok usage to xAI's exact billed cost", () => {
    const usage: LanguageModelV2Usage = {
      inputTokens: 1000,
      outputTokens: 500,
      reasoningTokens: 100,
      totalTokens: 1500,
    };

    const result = createDisplayUsage(usage, "xai:grok-4.5", {
      xai: { costInUsdTicks: 50_000_000 }, // $0.005 exact billed cost
    });

    expect(result).toBeDefined();
    const totalCost =
      result!.input.cost_usd! +
      result!.cached.cost_usd! +
      result!.cacheCreate.cost_usd! +
      result!.output.cost_usd! +
      result!.reasoning.cost_usd!;
    expect(totalCost).toBeCloseTo(0.005, 12);
  });

  describe("tiered long-context pricing", () => {
    test("keeps GPT-5.5 on base rates at the published 272K boundary", () => {
      const usage: LanguageModelV2Usage = {
        inputTokens: 272000,
        outputTokens: 1000,
        totalTokens: 273000,
      };

      const result = createDisplayUsage(usage, "openai:gpt-5.5");

      expect(result).toBeDefined();
      expect(result!.input.cost_usd).toBeCloseTo(1.36);
      expect(result!.output.cost_usd).toBeCloseTo(0.03);
    });

    test("switches GPT-5.5 to long-context rates above 272K including cache reads", () => {
      const usage: LanguageModelV2Usage = {
        inputTokens: 300000,
        outputTokens: 1000,
        totalTokens: 301000,
        cachedInputTokens: 100000,
      };

      const result = createDisplayUsage(usage, "openai:gpt-5.5");

      expect(result).toBeDefined();
      expect(result!.input.tokens).toBe(200000);
      expect(result!.cached.tokens).toBe(100000);
      expect(result!.input.cost_usd).toBeCloseTo(2);
      expect(result!.cached.cost_usd).toBeCloseTo(0.1);
      expect(result!.output.cost_usd).toBeCloseTo(0.045);
    });

    test("falls back to LiteLLM's default 200K threshold for existing tiered models", () => {
      const usage: LanguageModelV2Usage = {
        inputTokens: 250000,
        outputTokens: 1000,
        totalTokens: 251000,
      };

      const result = createDisplayUsage(usage, "google:gemini-3.1-pro-preview");

      expect(result).toBeDefined();
      expect(result!.input.cost_usd).toBeCloseTo(1);
      expect(result!.output.cost_usd).toBeCloseTo(0.018);
    });

    test("keeps Claude Sonnet 4.6 on standard pricing across the native 1M context window", () => {
      const usage: LanguageModelV2Usage = {
        inputTokens: 250000,
        outputTokens: 1000,
        totalTokens: 251000,
      };

      const result = createDisplayUsage(usage, "anthropic:claude-sonnet-4-6");

      expect(result).toBeDefined();
      expect(result!.input.cost_usd).toBeCloseTo(0.75);
      expect(result!.output.cost_usd).toBeCloseTo(0.015);
    });

    test("switches Claude Sonnet 4.5 to premium long-context pricing above 200K", () => {
      const usage: LanguageModelV2Usage = {
        inputTokens: 250000,
        outputTokens: 1000,
        totalTokens: 251000,
      };

      const result = createDisplayUsage(usage, "anthropic:claude-sonnet-4-5");

      expect(result).toBeDefined();
      expect(result!.input.cost_usd).toBeCloseTo(1.5);
      expect(result!.output.cost_usd).toBeCloseTo(0.0225);
    });

    test("preserves aggregate GPT-5.5 totals during repricing and flags them as approximate", () => {
      const aggregate = {
        input: { tokens: 200000, cost_usd: 1 },
        cached: { tokens: 100000, cost_usd: 0.05 },
        cacheCreate: { tokens: 0, cost_usd: 0 },
        output: { tokens: 1000, cost_usd: 0.03 },
        reasoning: { tokens: 0, cost_usd: 0 },
        model: "openai:gpt-5.5",
      };

      const result = recomputeUsageCosts(aggregate, "openai:gpt-5.5", {
        aggregatedUsage: true,
      });

      expect(result).toEqual({
        ...aggregate,
        hasUnknownCosts: true,
      });
    });

    test("recomputes persisted GPT-5.5 Pro usage with the higher long-context tier", () => {
      const result = recomputeUsageCosts(
        {
          input: { tokens: 280000 },
          cached: { tokens: 0 },
          cacheCreate: { tokens: 0 },
          output: { tokens: 1000 },
          reasoning: { tokens: 500 },
          model: "openai:gpt-5.5-pro",
        },
        "openai:gpt-5.5-pro"
      );

      expect(result.input.cost_usd).toBeCloseTo(16.8);
      expect(result.output.cost_usd).toBeCloseTo(0.27);
      expect(result.reasoning.cost_usd).toBeCloseTo(0.135);
    });
  });

  describe("Legacy subscription-covered usage costs", () => {
    test("returns $0 costs when providerMetadata.mux.costsIncluded is true", () => {
      const usage: LanguageModelV2Usage = {
        inputTokens: 1000, // OpenAI includes cached tokens
        outputTokens: 500,
        totalTokens: 1500,
        cachedInputTokens: 200,
      };

      const result = createDisplayUsage(usage, "openai:gpt-5.2", {
        mux: { costsIncluded: true },
      });

      expect(result).toBeDefined();
      // Token handling remains unchanged
      expect(result!.input.tokens).toBe(800);
      expect(result!.cached.tokens).toBe(200);

      expect(result!.input.cost_usd).toBe(0);
      expect(result!.cached.cost_usd).toBe(0);
      expect(result!.cacheCreate.cost_usd).toBe(0);
      expect(result!.output.cost_usd).toBe(0);
      expect(result!.reasoning.cost_usd).toBe(0);
    });

    test("preserves zero costs for historical Codex usage marked as included", () => {
      const usage: LanguageModelV2Usage = {
        inputTokens: 1500, // includes cached input tokens
        outputTokens: 450,
        reasoningTokens: 150,
        totalTokens: 1950,
        cachedInputTokens: 500,
      };

      const result = createDisplayUsage(usage, "openai:gpt-5.3-codex", {
        mux: { costsIncluded: true },
      });

      expect(result).toBeDefined();
      // Token accounting still happens for display/analytics.
      expect(result!.input.tokens).toBe(1000);
      expect(result!.cached.tokens).toBe(500);
      expect(result!.output.tokens).toBe(300);
      expect(result!.reasoning.tokens).toBe(150);

      expect(result!.input.cost_usd).toBe(0);
      expect(result!.cached.cost_usd).toBe(0);
      expect(result!.cacheCreate.cost_usd).toBe(0);
      expect(result!.output.cost_usd).toBe(0);
      expect(result!.reasoning.cost_usd).toBe(0);
    });

    test("gpt-5.3-codex routed through API key never gets force-reset to $0", () => {
      const usage: LanguageModelV2Usage = {
        inputTokens: 1500, // includes cached input tokens
        outputTokens: 450,
        reasoningTokens: 150,
        totalTokens: 1950,
        cachedInputTokens: 500,
      };

      const result = createDisplayUsage(usage, "openai:gpt-5.3-codex", {
        mux: { costsIncluded: false },
      });

      expect(result).toBeDefined();
      expect(result!.costsIncluded).toBeUndefined();

      expect(result!.input.cost_usd).toBeGreaterThan(0);
      expect(result!.cached.cost_usd).toBeGreaterThan(0);
      expect(result!.output.cost_usd).toBeGreaterThan(0);
      expect(result!.reasoning.cost_usd).toBeGreaterThan(0);
    });

    test("returns $0 costs even when model pricing is unknown", () => {
      const usage: LanguageModelV2Usage = {
        inputTokens: 100,
        outputTokens: 50,
        totalTokens: 150,
      };

      const result = createDisplayUsage(usage, "openai:some-unknown-model", {
        mux: { costsIncluded: true },
      });

      expect(result).toBeDefined();
      expect(result!.input.cost_usd).toBe(0);
      expect(result!.cached.cost_usd).toBe(0);
      expect(result!.cacheCreate.cost_usd).toBe(0);
      expect(result!.output.cost_usd).toBe(0);
      expect(result!.reasoning.cost_usd).toBe(0);
    });
  });
  describe("Anthropic cache creation tokens from providerMetadata", () => {
    // Cache creation tokens are Anthropic-specific and only available in
    // providerMetadata.anthropic.cacheCreationInputTokens, not in LanguageModelV2Usage.
    // This is critical for liveUsage display during streaming.

    test("extracts cacheCreationInputTokens from providerMetadata", () => {
      const usage: LanguageModelV2Usage = {
        inputTokens: 1000,
        outputTokens: 50,
        totalTokens: 1050,
      };

      const result = createDisplayUsage(usage, "anthropic:claude-sonnet-4-20250514", {
        anthropic: { cacheCreationInputTokens: 800 },
      });

      expect(result).toBeDefined();
      expect(result!.cacheCreate.tokens).toBe(800);
    });

    test("cacheCreate is 0 when providerMetadata is undefined", () => {
      const usage: LanguageModelV2Usage = {
        inputTokens: 1000,
        outputTokens: 50,
        totalTokens: 1050,
      };

      const result = createDisplayUsage(usage, "anthropic:claude-sonnet-4-20250514");

      expect(result).toBeDefined();
      expect(result!.cacheCreate.tokens).toBe(0);
    });

    test("cacheCreate is 0 when anthropic metadata lacks cacheCreationInputTokens", () => {
      const usage: LanguageModelV2Usage = {
        inputTokens: 1000,
        outputTokens: 50,
        totalTokens: 1050,
      };

      const result = createDisplayUsage(usage, "anthropic:claude-sonnet-4-20250514", {
        anthropic: { someOtherField: 123 },
      });

      expect(result).toBeDefined();
      expect(result!.cacheCreate.tokens).toBe(0);
    });

    test("handles gateway Anthropic model with cache creation", () => {
      const usage: LanguageModelV2Usage = {
        inputTokens: 2000,
        outputTokens: 100,
        totalTokens: 2100,
      };

      const result = createDisplayUsage(usage, "mux-gateway:anthropic/claude-sonnet-4-5", {
        anthropic: { cacheCreationInputTokens: 1500 },
      });

      expect(result).toBeDefined();
      expect(result!.cacheCreate.tokens).toBe(1500);
    });
  });
});

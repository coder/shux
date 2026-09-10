import { describe, test, expect } from "bun:test";
import { checkAutoCompaction, type AutoCompactionUsageState } from "./autoCompactionCheck";
import type { ChatUsageDisplay } from "@/common/utils/tokens/usageAggregator";
import { KNOWN_MODELS } from "@/common/constants/knownModels";

const BETA_SONNET_MODEL = "anthropic:claude-sonnet-4-5";

// Helper to create a mock usage entry
// The tokens parameter represents CONTEXT tokens (input + cached + cacheCreate).
// Output and reasoning are set separately since they don't count toward context.
const createUsageEntry = (
  contextTokens: number,
  model: string = BETA_SONNET_MODEL
): ChatUsageDisplay => {
  // Distribute context tokens (only these count toward compaction threshold)
  const inputTokens = Math.floor(contextTokens * 0.9); // 90% input
  const cachedTokens = Math.floor(contextTokens * 0.1); // 10% cached

  return {
    input: { tokens: inputTokens },
    cached: { tokens: cachedTokens },
    cacheCreate: { tokens: 0 },
    output: { tokens: 1_000 }, // Some output (doesn't affect context calculation)
    reasoning: { tokens: 0 },
    model,
  };
};

// Helper to create mock AutoCompactionUsageState
const createMockUsage = (
  lastEntryTokens: number,
  _historicalTokens?: number, // Kept for backward compat but unused (session-usage.json handles historical)
  model: string = BETA_SONNET_MODEL,
  liveUsage?: ChatUsageDisplay
): AutoCompactionUsageState => {
  // Create lastContextUsage representing the most recent context window state
  const lastContextUsage = createUsageEntry(lastEntryTokens, model);

  return { lastContextUsage, totalTokens: 0, liveUsage };
};

describe("checkAutoCompaction", () => {
  const SONNET_MAX_TOKENS = 200_000;
  const SONNET_70_PERCENT = SONNET_MAX_TOKENS * 0.7; // 140,000
  const SONNET_60_PERCENT = SONNET_MAX_TOKENS * 0.6; // 120,000

  test("exposes raw context and model limit even when proactive compaction is disabled", () => {
    const result = checkAutoCompaction(
      createMockUsage(50000, undefined, BETA_SONNET_MODEL, createUsageEntry(60000)),
      BETA_SONNET_MODEL,
      false,
      1
    );
    expect(result.contextTokens).toBe(60000);
    expect(result.maxTokens).toBe(200000);
    expect(result.shouldForceCompact).toBe(false);
    const unknown = checkAutoCompaction(createMockUsage(50000), "unknown-model", false);
    expect(unknown.contextTokens).toBe(50000);
    expect(unknown.maxTokens).toBeUndefined();
  });

  describe("Basic Functionality", () => {
    test("returns false when no usage data (first message)", () => {
      const result = checkAutoCompaction(undefined, BETA_SONNET_MODEL, false);

      expect(result.shouldShowWarning).toBe(false);
      expect(result.usagePercentage).toBe(0);
      expect(result.thresholdPercentage).toBe(70);
    });

    test("returns false when no context usage data", () => {
      const usage: AutoCompactionUsageState = { totalTokens: 0 };
      const result = checkAutoCompaction(usage, BETA_SONNET_MODEL, false);

      expect(result.shouldShowWarning).toBe(false);
      expect(result.usagePercentage).toBe(0);
      expect(result.thresholdPercentage).toBe(70);
    });

    test("returns false when model has no max_input_tokens (unknown model)", () => {
      const usage = createMockUsage(50_000);
      const result = checkAutoCompaction(usage, "unknown-model", false);

      expect(result.shouldShowWarning).toBe(false);
      expect(result.usagePercentage).toBe(0);
      expect(result.thresholdPercentage).toBe(70);
    });

    test("uses custom context overrides for unknown models", () => {
      const usage = createMockUsage(80_000, undefined, "openai:custom-context-model");
      const result = checkAutoCompaction(usage, "openai:custom-context-model", false, 0.7, 10, {
        openai: {
          apiKeySet: true,
          isEnabled: true,
          isConfigured: true,
          models: [{ id: "custom-context-model", contextWindowTokens: 100_000 }],
        },
      });

      expect(result.shouldShowWarning).toBe(true);
      expect(result.shouldForceCompact).toBe(true);
      expect(result.usagePercentage).toBe(80);
      expect(result.thresholdPercentage).toBe(70);
    });

    test("returns false when usage is low (10%)", () => {
      const usage = createMockUsage(20_000); // 10% of 200k
      const result = checkAutoCompaction(usage, BETA_SONNET_MODEL, false);

      expect(result.shouldShowWarning).toBe(false);
      expect(result.usagePercentage).toBe(10);
      expect(result.thresholdPercentage).toBe(70);
    });

    test("returns true at warning threshold (60% with default 10% advance)", () => {
      const usage = createMockUsage(SONNET_60_PERCENT);
      const result = checkAutoCompaction(usage, BETA_SONNET_MODEL, false);

      expect(result.shouldShowWarning).toBe(true);
      expect(result.usagePercentage).toBe(60);
      expect(result.thresholdPercentage).toBe(70);
    });

    test("returns true at compaction threshold (70%)", () => {
      const usage = createMockUsage(SONNET_70_PERCENT);
      const result = checkAutoCompaction(usage, BETA_SONNET_MODEL, false);

      expect(result.shouldShowWarning).toBe(true);
      expect(result.usagePercentage).toBe(70);
      expect(result.thresholdPercentage).toBe(70);
    });

    test("returns true above threshold (80%)", () => {
      const usage = createMockUsage(160_000); // 80% of 200k
      const result = checkAutoCompaction(usage, BETA_SONNET_MODEL, false);

      expect(result.shouldShowWarning).toBe(true);
      expect(result.usagePercentage).toBe(80);
      expect(result.thresholdPercentage).toBe(70);
    });
  });

  describe("Usage Calculation (Critical for infinite loop fix)", () => {
    test("uses last usage entry tokens, not cumulative sum", () => {
      const usage = createMockUsage(10_000); // Only 5% of context
      const result = checkAutoCompaction(usage, BETA_SONNET_MODEL, false);

      // Should be 5%, not counting historical
      expect(result.usagePercentage).toBe(5);
      expect(result.shouldShowWarning).toBe(false);
    });

    test("handles historical usage correctly - ignores it in calculation", () => {
      // Scenario: After compaction, historical = 70K, recent = 5K
      // Should calculate based on 5K (2.5%), not 75K (37.5%)
      const usage = createMockUsage(5_000, 70_000);
      const result = checkAutoCompaction(usage, BETA_SONNET_MODEL, false);

      expect(result.usagePercentage).toBe(2.5);
      expect(result.shouldShowWarning).toBe(false);
    });

    test("includes cacheCreate in context calculation (prompt caching)", () => {
      // For Anthropic prompt caching, cacheCreate tokens represent cached prefix tokens.
      // They are still part of the request's total input tokens and count toward context.
      const usageEntry = {
        input: { tokens: 10_000 },
        cached: { tokens: 5_000 },
        cacheCreate: { tokens: 2_000 },
        output: { tokens: 3_000 },
        reasoning: { tokens: 1_000 },
        model: BETA_SONNET_MODEL,
      };
      const usage: AutoCompactionUsageState = {
        lastContextUsage: usageEntry,
        totalTokens: 0,
      };

      const result = checkAutoCompaction(usage, BETA_SONNET_MODEL, false);

      // Context = input + cached + cacheCreate = 10k + 5k + 2k = 17k tokens = 8.5%
      // Output and reasoning are excluded (they're response tokens, not context)
      expect(result.usagePercentage).toBe(8.5);
    });

    test("excludes output and reasoning tokens from context calculation (prevents compaction loops)", () => {
      // Extended Thinking can generate 50k+ reasoning tokens. These should NOT
      // count toward context window limits or trigger compaction loops.
      const usageEntry = {
        input: { tokens: 20_000 }, // Low actual context
        cached: { tokens: 0 },
        cacheCreate: { tokens: 0 },
        output: { tokens: 5_000 },
        reasoning: { tokens: 50_000 }, // High reasoning from Extended Thinking
        model: BETA_SONNET_MODEL,
      };
      const usage: AutoCompactionUsageState = {
        lastContextUsage: usageEntry,
        totalTokens: 0,
      };

      const result = checkAutoCompaction(usage, BETA_SONNET_MODEL, false);

      // Only input tokens count: 20k = 10% of 200k context
      // NOT 75k (37.5%) which would incorrectly trigger compaction
      expect(result.usagePercentage).toBe(10);
      expect(result.shouldShowWarning).toBe(false);
      expect(result.shouldForceCompact).toBe(false);
    });
  });

  describe("1M Context Mode", () => {
    test("uses 1M tokens when use1M=true and model supports it (Sonnet 4)", () => {
      const usage = createMockUsage(600_000); // 60% of 1M
      const result = checkAutoCompaction(usage, BETA_SONNET_MODEL, true);

      expect(result.usagePercentage).toBe(60);
      expect(result.shouldShowWarning).toBe(true);
    });

    test("uses 1M tokens for Sonnet with use1M=true (model is claude-sonnet-4-5)", () => {
      const usage = createMockUsage(700_000); // 70% of 1M
      const result = checkAutoCompaction(usage, BETA_SONNET_MODEL, true);

      expect(result.usagePercentage).toBe(70);
      expect(result.shouldShowWarning).toBe(true);
    });

    test("uses standard max_input_tokens when use1M=false", () => {
      const usage = createMockUsage(140_000); // 70% of 200k
      const result = checkAutoCompaction(usage, BETA_SONNET_MODEL, false);

      expect(result.usagePercentage).toBe(70);
      expect(result.shouldShowWarning).toBe(true);
    });

    test("uses Claude Sonnet 4.6's native 1M limit without relying on the beta toggle", () => {
      const usage = createMockUsage(600_000, undefined, KNOWN_MODELS.SONNET.id);
      const result = checkAutoCompaction(usage, KNOWN_MODELS.SONNET.id, false);

      expect(result.usagePercentage).toBe(60);
      expect(result.shouldShowWarning).toBe(true);
    });

    test("uses GPT-5.5's native 1.05M limit without relying on the 1M toggle", () => {
      // Pin to the literal model string: gpt-5.5's 1.05M native window remains in
      // production even though KNOWN_MODELS.GPT now points at gpt-5.6-sol (1M).
      const usage = createMockUsage(600_000, undefined, "openai:gpt-5.5");
      const result = checkAutoCompaction(usage, "openai:gpt-5.5", false);

      expect(result.usagePercentage).toBeCloseTo(57.14, 2);
      expect(result.shouldShowWarning).toBe(false);
    });

    test("ignores use1M for models that don't support it (GPT)", () => {
      const usage = createMockUsage(100_000, undefined, KNOWN_MODELS.GPT_MINI.id);
      // GPT Mini has 272k context, so 100k = 36.76%
      const result = checkAutoCompaction(usage, KNOWN_MODELS.GPT_MINI.id, true);

      // Should use standard 272k, not 1M (use1M ignored for GPT)
      expect(result.usagePercentage).toBeCloseTo(36.76, 1);
      expect(result.shouldShowWarning).toBe(false);
    });
  });

  describe("Edge Cases", () => {
    test("single context usage entry works correctly", () => {
      const usage = createMockUsage(140_000);
      const result = checkAutoCompaction(usage, BETA_SONNET_MODEL, false);

      expect(result.shouldShowWarning).toBe(true);
      expect(result.usagePercentage).toBe(70);
    });

    test("custom threshold parameter (80%)", () => {
      const usage = createMockUsage(140_000); // 70% of context
      const result = checkAutoCompaction(usage, BETA_SONNET_MODEL, false, 0.8); // 80% threshold

      // At 70%, should NOT show warning for 80% threshold (needs 70% advance = 10%)
      expect(result.shouldShowWarning).toBe(true); // 70% >= (80% - 10% = 70%)
      expect(result.usagePercentage).toBe(70);
      expect(result.thresholdPercentage).toBe(80);
    });

    test("custom warning advance (5% instead of 10%)", () => {
      const usage = createMockUsage(130_000); // 65% of context
      const result = checkAutoCompaction(usage, BETA_SONNET_MODEL, false, 0.7, 5);

      // At 65%, should show warning with 5% advance (70% - 5% = 65%)
      expect(result.shouldShowWarning).toBe(true);
      expect(result.usagePercentage).toBe(65);
      expect(result.thresholdPercentage).toBe(70);
    });

    test("handles zero tokens gracefully", () => {
      const zeroEntry = {
        input: { tokens: 0 },
        cached: { tokens: 0 },
        cacheCreate: { tokens: 0 },
        output: { tokens: 0 },
        reasoning: { tokens: 0 },
        model: BETA_SONNET_MODEL,
      };
      const usage: AutoCompactionUsageState = {
        lastContextUsage: zeroEntry,
        totalTokens: 0,
      };

      const result = checkAutoCompaction(usage, BETA_SONNET_MODEL, false);

      expect(result.shouldShowWarning).toBe(false);
      expect(result.usagePercentage).toBe(0);
    });

    test("handles usage at exactly 100% of context", () => {
      const usage = createMockUsage(SONNET_MAX_TOKENS);
      const result = checkAutoCompaction(usage, BETA_SONNET_MODEL, false);

      expect(result.shouldShowWarning).toBe(true);
      expect(result.usagePercentage).toBe(100);
      expect(result.thresholdPercentage).toBe(70);
    });

    test("handles usage beyond 100% of context", () => {
      const usage = createMockUsage(SONNET_MAX_TOKENS + 50_000);
      const result = checkAutoCompaction(usage, BETA_SONNET_MODEL, false);

      expect(result.shouldShowWarning).toBe(true);
      expect(result.usagePercentage).toBe(125);
      expect(result.thresholdPercentage).toBe(70);
    });
  });

  describe("Percentage Calculation Accuracy", () => {
    test("calculates percentage correctly for various token counts", () => {
      // Test specific percentages
      const testCases = [
        { tokens: 20_000, expectedPercent: 10 },
        { tokens: 40_000, expectedPercent: 20 },
        { tokens: 100_000, expectedPercent: 50 },
        { tokens: 120_000, expectedPercent: 60 },
        { tokens: 140_000, expectedPercent: 70 },
        { tokens: 160_000, expectedPercent: 80 },
        { tokens: 180_000, expectedPercent: 90 },
      ];

      for (const { tokens, expectedPercent } of testCases) {
        const usage = createMockUsage(tokens);
        const result = checkAutoCompaction(usage, BETA_SONNET_MODEL, false);
        expect(result.usagePercentage).toBe(expectedPercent);
      }
    });

    test("handles fractional percentages correctly", () => {
      const usage = createMockUsage(123_456); // 61.728%
      const result = checkAutoCompaction(usage, BETA_SONNET_MODEL, false);

      expect(result.usagePercentage).toBeCloseTo(61.728, 2);
      expect(result.shouldShowWarning).toBe(true); // Above 60%
    });
  });

  describe("Force Compaction (threshold + 5% buffer)", () => {
    // Force-compact triggers at threshold + 5%
    // With default 70% threshold, force-compact at 75%

    test("shouldForceCompact is false when usage just below force threshold", () => {
      // 74% usage, threshold 70%, force at 75% - should NOT trigger
      const usage = createMockUsage(148_000); // 74%
      const result = checkAutoCompaction(usage, BETA_SONNET_MODEL, false);

      expect(result.shouldForceCompact).toBe(false);
    });

    test("shouldForceCompact is true when usage at force threshold", () => {
      // 75% usage, threshold 70%, force at 75% - should trigger
      const usage = createMockUsage(150_000); // 75%
      const result = checkAutoCompaction(usage, BETA_SONNET_MODEL, false);

      expect(result.shouldForceCompact).toBe(true);
    });

    test("shouldForceCompact is true when usage above force threshold", () => {
      // 80% usage, threshold 70%, force at 75% - should trigger
      const usage = createMockUsage(160_000); // 80%
      const result = checkAutoCompaction(usage, BETA_SONNET_MODEL, false);

      expect(result.shouldForceCompact).toBe(true);
    });

    test("shouldForceCompact uses liveUsage when available", () => {
      // lastUsage at 50%, liveUsage at 75% - should trigger based on live
      const liveUsage = createUsageEntry(150_000); // 75%
      const usage = createMockUsage(100_000, undefined, BETA_SONNET_MODEL, liveUsage);
      const result = checkAutoCompaction(usage, BETA_SONNET_MODEL, false);

      expect(result.shouldForceCompact).toBe(true);
      expect(result.usagePercentage).toBe(75); // usagePercentage reflects live when streaming
    });

    test("shouldForceCompact respects custom threshold", () => {
      // 55% usage with 50% threshold - force at 55%, should trigger
      const usage = createMockUsage(110_000); // 55%
      const result = checkAutoCompaction(usage, BETA_SONNET_MODEL, false, 0.5);

      expect(result.shouldForceCompact).toBe(true);
    });

    test("shouldForceCompact respects 1M context mode", () => {
      // 75% of 1M = 750k tokens
      const liveUsage = createUsageEntry(750_000);
      const usage = createMockUsage(50_000, undefined, BETA_SONNET_MODEL, liveUsage);
      const result = checkAutoCompaction(usage, BETA_SONNET_MODEL, true);

      expect(result.shouldForceCompact).toBe(true);
    });

    test("shouldForceCompact triggers with liveUsage at force threshold (no lastContextUsage)", () => {
      const liveUsage = createUsageEntry(150_000); // 75%
      const usage: AutoCompactionUsageState = {
        totalTokens: 0,
        liveUsage,
      };
      const result = checkAutoCompaction(usage, BETA_SONNET_MODEL, false);

      expect(result.shouldForceCompact).toBe(true);
      expect(result.usagePercentage).toBe(75); // usagePercentage reflects live
    });

    test("shouldShowWarning uses live usage when no lastContextUsage exists", () => {
      // No lastContextUsage, liveUsage at 65% - should show warning (65% >= 60%)
      const liveUsage = createUsageEntry(130_000); // 65%
      const usage: AutoCompactionUsageState = {
        totalTokens: 0,
        liveUsage,
      };
      const result = checkAutoCompaction(usage, BETA_SONNET_MODEL, false);

      expect(result.shouldShowWarning).toBe(true);
      expect(result.shouldForceCompact).toBe(false); // 65% < 75%
    });

    test("shouldShowWarning uses max of last and live usage", () => {
      // lastUsage at 50% (below warning), liveUsage at 72% (above warning)
      const liveUsage = createUsageEntry(144_000); // 72%
      const usage = createMockUsage(100_000, undefined, BETA_SONNET_MODEL, liveUsage);
      const result = checkAutoCompaction(usage, BETA_SONNET_MODEL, false);

      expect(result.shouldShowWarning).toBe(true); // 72% >= 60%
      expect(result.shouldForceCompact).toBe(false); // 72% < 75%
    });

    test("shouldForceCompact is false when auto-compaction disabled", () => {
      const usage = createMockUsage(190_000); // 95% - would trigger if enabled
      const result = checkAutoCompaction(usage, BETA_SONNET_MODEL, false, 1.0); // disabled

      expect(result.shouldForceCompact).toBe(false);
    });
  });
});

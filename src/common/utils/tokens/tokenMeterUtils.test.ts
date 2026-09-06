import { describe, expect, test } from "bun:test";
import type { ProvidersConfigMap } from "@/common/orpc/types";
import { calculateTokenMeterData, formatTokens } from "./tokenMeterUtils";

const SAMPLE_USAGE = {
  input: { tokens: 10_000 },
  cached: { tokens: 500 },
  cacheCreate: { tokens: 0 },
  output: { tokens: 250 },
  reasoning: { tokens: 250 },
} as const;

describe("formatTokens", () => {
  test("formats small numbers as-is with locale formatting", () => {
    expect(formatTokens(0)).toBe("0");
    expect(formatTokens(500)).toBe("500");
    expect(formatTokens(999)).toBe("999");
  });

  test("formats thousands with k suffix", () => {
    expect(formatTokens(1000)).toBe("1.0k");
    expect(formatTokens(1500)).toBe("1.5k");
    expect(formatTokens(58507)).toBe("58.5k");
    expect(formatTokens(999_999)).toBe("1000.0k");
  });

  test("formats millions with M suffix", () => {
    expect(formatTokens(1_000_000)).toBe("1.0M");
    expect(formatTokens(1_500_000)).toBe("1.5M");
    expect(formatTokens(58_507_900)).toBe("58.5M");
    expect(formatTokens(4_133_000)).toBe("4.1M");
  });
});

describe("calculateTokenMeterData", () => {
  const providerConfigWithOverride: ProvidersConfigMap = {
    anthropic: {
      apiKeySet: false,
      isEnabled: true,
      isConfigured: true,
      models: [{ id: "claude-sonnet-4-20250514", contextWindowTokens: 100_000 }],
    },
  };

  test("keeps the accepted limit during live usage and uses current settings when idle", () => {
    const changedConfig: ProvidersConfigMap = {
      openai: {
        apiKeySet: true,
        isEnabled: true,
        isConfigured: true,
        codexOauthDefaultAuth: "apiKey",
        models: [{ id: "gpt-5.5", contextWindowTokens: 500_000 }],
      },
    };
    const live = calculateTokenMeterData(
      SAMPLE_USAGE,
      "openai:gpt-5.5",
      false,
      false,
      changedConfig,
      { codexOauthAccountId: "different-account" },
      272_000
    );
    const idle = calculateTokenMeterData(
      SAMPLE_USAGE,
      "openai:gpt-5.5",
      false,
      false,
      changedConfig
    );
    expect(live.maxTokens).toBe(272_000);
    expect(live.totalPercentage).toBeCloseTo((11_000 / 272_000) * 100);
    expect(idle.maxTokens).toBe(500_000);
    expect(idle.totalPercentage).toBeCloseTo(2.2);
  });

  test.each([272_000, null])("keeps the accepted limit before usage arrives: %s", (limit) => {
    const result = calculateTokenMeterData(
      undefined,
      "anthropic:claude-sonnet-4-20250514",
      true,
      false,
      providerConfigWithOverride,
      undefined,
      limit
    );
    expect(result.maxTokens).toBe(limit ?? undefined);
    expect(result.totalTokens).toBe(0);
    expect(result.totalPercentage).toBe(0);
  });

  test("keeps an unknown accepted limit despite a current model override", () => {
    const result = calculateTokenMeterData(
      SAMPLE_USAGE,
      "anthropic:claude-sonnet-4-20250514",
      true,
      false,
      providerConfigWithOverride,
      undefined,
      null
    );
    expect(result.maxTokens).toBeUndefined();
  });

  test("uses custom context override for beta Sonnet models", () => {
    const result = calculateTokenMeterData(
      SAMPLE_USAGE,
      "anthropic:claude-sonnet-4-20250514",
      false,
      false,
      providerConfigWithOverride
    );

    expect(result.maxTokens).toBe(100_000);
    expect(result.totalTokens).toBe(11_000);
    expect(result.totalPercentage).toBeCloseTo(11);
  });

  test("keeps unknown models relative when no override is configured", () => {
    const result = calculateTokenMeterData(SAMPLE_USAGE, "anthropic:claude-sonnet-4-0", false);

    expect(result.maxTokens).toBeUndefined();
    expect(result.totalTokens).toBe(11_000);
  });

  test("1M toggle overrides custom context limit for beta-only Anthropic models", () => {
    const result = calculateTokenMeterData(
      SAMPLE_USAGE,
      "anthropic:claude-sonnet-4-20250514",
      true,
      false,
      providerConfigWithOverride
    );

    expect(result.maxTokens).toBe(1_000_000);
    expect(result.totalPercentage).toBeCloseTo(1.1);
  });

  test("keeps the OAuth cap for an unavailable global account and a connected project account", () => {
    const providersConfig: ProvidersConfigMap = {
      openai: {
        apiKeySet: true,
        isEnabled: true,
        isConfigured: true,
        codexOauthSet: true,
        codexOauthDefaultAccountId: "missing",
        codexOauthAccounts: [{ id: "work", label: "Work" }],
      },
    };
    const globalMeter = calculateTokenMeterData(
      SAMPLE_USAGE,
      "openai:gpt-5.5",
      false,
      false,
      providersConfig
    );
    const projectMeter = calculateTokenMeterData(
      SAMPLE_USAGE,
      "openai:gpt-5.5",
      false,
      false,
      providersConfig,
      { codexOauthAccountId: "work" }
    );
    expect(projectMeter.maxTokens).toBe(272_000);
    expect(globalMeter.maxTokens).toBe(projectMeter.maxTokens);
    expect(projectMeter.totalPercentage).toBe(globalMeter.totalPercentage);
  });

  test("uses the Codex OAuth cap for GPT-5.5 token meter percentages", () => {
    const result = calculateTokenMeterData(SAMPLE_USAGE, "openai:gpt-5.5", false, false, {
      openai: {
        apiKeySet: false,
        isEnabled: true,
        isConfigured: true,
        codexOauthSet: true,
      },
    });

    expect(result.maxTokens).toBe(272_000);
    expect(result.totalPercentage).toBeCloseTo((11_000 / 272_000) * 100);
  });

  test("uses the Codex OAuth cap for GPT-5.6 token meter percentages", () => {
    const result = calculateTokenMeterData(SAMPLE_USAGE, "openai:gpt-5.6-sol", false, false, {
      openai: {
        apiKeySet: false,
        isEnabled: true,
        isConfigured: true,
        codexOauthSet: true,
      },
    });

    expect(result.maxTokens).toBe(372_000);
    expect(result.totalPercentage).toBeCloseTo((11_000 / 372_000) * 100);
  });

  test("uses Claude Sonnet 4.6's native 1M context even when the beta toggle is off", () => {
    const result = calculateTokenMeterData(SAMPLE_USAGE, "anthropic:claude-sonnet-4-6", false);

    expect(result.maxTokens).toBe(1_000_000);
    expect(result.totalPercentage).toBeCloseTo(1.1);
  });
});

import type { LanguageModelV2Usage } from "@ai-sdk/provider";
import { describe, expect, test } from "bun:test";
import type { ProvidersConfigMap } from "@/common/orpc/types";
import type { ChatUsageDisplay } from "@/common/utils/tokens/usageAggregator";
import { CompactionMonitor, type CompactionStatusEvent } from "./compactionMonitor";

const BETA_SONNET_MODEL = "anthropic:claude-sonnet-4-5";

function createUsageDisplay(contextTokens: number, model = BETA_SONNET_MODEL): ChatUsageDisplay {
  const inputTokens = Math.floor(contextTokens * 0.9);
  const cachedTokens = contextTokens - inputTokens;

  return {
    input: { tokens: inputTokens },
    cached: { tokens: cachedTokens },
    cacheCreate: { tokens: 0 },
    output: { tokens: 0 },
    reasoning: { tokens: 0 },
    model,
  };
}

function createMidStreamUsage(inputTokens: number, cachedInputTokens = 0): LanguageModelV2Usage {
  return {
    inputTokens,
    outputTokens: 0,
    totalTokens: inputTokens + cachedInputTokens,
    cachedInputTokens,
  };
}

function createMonitor() {
  const statusEvents: CompactionStatusEvent[] = [];
  const monitor = new CompactionMonitor("workspace-1", (event) => {
    statusEvents.push(event);
  });

  return { monitor, statusEvents };
}

describe("CompactionMonitor", () => {
  test("checkBeforeSend returns auto-compaction result based on threshold", () => {
    const { monitor } = createMonitor();

    const lowResult = monitor.checkBeforeSend({
      model: BETA_SONNET_MODEL,
      usage: { lastContextUsage: createUsageDisplay(120_000) },
      use1MContext: false,
      providersConfig: null,
    });
    expect(lowResult.shouldForceCompact).toBe(false);
    expect(lowResult.usagePercentage).toBe(60);

    const forceResult = monitor.checkBeforeSend({
      model: BETA_SONNET_MODEL,
      usage: { lastContextUsage: createUsageDisplay(150_000) },
      use1MContext: false,
      providersConfig: null,
    });
    expect(forceResult.shouldForceCompact).toBe(true);
    expect(forceResult.usagePercentage).toBe(75);

    monitor.setThreshold(0.8);
    const customThresholdResult = monitor.checkBeforeSend({
      model: BETA_SONNET_MODEL,
      usage: { lastContextUsage: createUsageDisplay(150_000) },
      use1MContext: false,
      providersConfig: null,
    });
    expect(customThresholdResult.thresholdPercentage).toBe(80);
    expect(customThresholdResult.shouldForceCompact).toBe(false);
  });

  test("checkMidStream triggers once when usage exceeds force threshold", () => {
    const { monitor, statusEvents } = createMonitor();

    expect(
      monitor.checkMidStream({
        model: BETA_SONNET_MODEL,
        usage: createMidStreamUsage(140_000),
        use1MContext: false,
        providersConfig: null,
      })
    ).toBe(false);
    expect(statusEvents).toHaveLength(0);

    expect(
      monitor.checkMidStream({
        model: BETA_SONNET_MODEL,
        usage: createMidStreamUsage(150_000),
        use1MContext: false,
        providersConfig: null,
      })
    ).toBe(true);
    expect(statusEvents).toEqual([
      {
        type: "auto-compaction-triggered",
        reason: "mid-stream",
        usagePercent: 75,
      },
    ]);

    expect(
      monitor.checkMidStream({
        model: BETA_SONNET_MODEL,
        usage: createMidStreamUsage(160_000),
        use1MContext: false,
        providersConfig: null,
      })
    ).toBe(false);
    expect(statusEvents).toHaveLength(1);
  });

  test("checkMidStream applies the request wire format to the Codex OAuth cap", () => {
    // API key + OAuth preferred: Responses requests route OAuth (272K cap), while a
    // request-level Chat Completions selection falls back to the API key (1.05M).
    const providersConfig: ProvidersConfigMap = {
      openai: {
        apiKeySet: true,
        isEnabled: true,
        isConfigured: true,
        codexOauthSet: true,
        codexOauthDefaultAuth: "oauth",
      },
    };
    const usage = createMidStreamUsage(260_000);

    const { monitor: oauthMonitor } = createMonitor();
    expect(
      oauthMonitor.checkMidStream({
        model: "openai:gpt-5.5",
        usage,
        use1MContext: false,
        providersConfig,
      })
    ).toBe(true);

    const { monitor: apiKeyMonitor } = createMonitor();
    expect(
      apiKeyMonitor.checkMidStream({
        model: "openai:gpt-5.5",
        usage,
        use1MContext: false,
        providersConfig,
        openaiWireFormat: "chatCompletions",
      })
    ).toBe(false);
  });

  test("checkMidStream stays disabled when threshold is set to 1.0", () => {
    const { monitor, statusEvents } = createMonitor();
    monitor.setThreshold(1);

    expect(
      monitor.checkMidStream({
        model: BETA_SONNET_MODEL,
        usage: createMidStreamUsage(210_000),
        use1MContext: false,
        providersConfig: null,
      })
    ).toBe(false);
    expect(statusEvents).toHaveLength(0);
  });

  test("checkMidStream ignores malformed non-positive context limits", () => {
    const { monitor, statusEvents } = createMonitor();

    const malformedProvidersConfig = {
      openai: {
        models: [{ id: "gpt-4o", contextWindowTokens: -1 }],
      },
    } as unknown as ProvidersConfigMap;

    expect(
      monitor.checkMidStream({
        model: "openai:gpt-4o",
        usage: createMidStreamUsage(42),
        use1MContext: false,
        providersConfig: malformedProvidersConfig,
      })
    ).toBe(false);
    expect(statusEvents).toHaveLength(0);
  });

  test("checkMidStream does not double-count cachedInputTokens", () => {
    const { monitor, statusEvents } = createMonitor();

    // Force threshold is 75% with defaults (70% + 5% buffer).
    // 145k / 200k = 72.5%, so this should NOT trigger even when
    // cachedInputTokens is present.
    expect(
      monitor.checkMidStream({
        model: BETA_SONNET_MODEL,
        usage: createMidStreamUsage(145_000, 10_000),
        use1MContext: false,
        providersConfig: null,
      })
    ).toBe(false);
    expect(statusEvents).toHaveLength(0);
  });

  test("resetForNewStream allows a new mid-stream trigger", () => {
    const { monitor, statusEvents } = createMonitor();

    expect(
      monitor.checkMidStream({
        model: BETA_SONNET_MODEL,
        usage: createMidStreamUsage(150_000),
        use1MContext: false,
        providersConfig: null,
      })
    ).toBe(true);
    expect(statusEvents).toHaveLength(1);

    monitor.resetForNewStream();

    expect(
      monitor.checkMidStream({
        model: BETA_SONNET_MODEL,
        usage: createMidStreamUsage(160_000),
        use1MContext: false,
        providersConfig: null,
      })
    ).toBe(true);
    expect(statusEvents).toHaveLength(2);
  });

  test("setThreshold enforces valid bounds", () => {
    const { monitor } = createMonitor();

    expect(() => monitor.setThreshold(0)).toThrow("invalid threshold");
    expect(() => monitor.setThreshold(1.01)).toThrow("invalid threshold");
    expect(() => monitor.setThreshold(Number.NaN)).toThrow("threshold must be finite");

    monitor.setThreshold(0.55);
    expect(monitor.getThreshold()).toBe(0.55);
  });
});

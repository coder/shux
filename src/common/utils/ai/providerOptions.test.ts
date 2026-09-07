/**
 * Tests for provider options builder
 */

import { createOpenAI, type OpenAIResponsesProviderOptions } from "@ai-sdk/openai";
import { generateText, streamText } from "ai";
import type { ProvidersConfigMap } from "@/common/orpc/types";
import { createMuxMessage } from "@/common/types/message";
import { createOpenAICachedSystemMessage } from "./cacheStrategy";
import { describe, test, expect, mock } from "bun:test";
import { openaiDirectProviderOptionsAvailable } from "./openaiProviderOptionsAvailability";
import {
  buildProviderOptions,
  buildRequestHeaders,
  isAnthropic1MEffectivelyEnabled,
  openaiProModeAvailable,
  preserveAnthropic1MContextForFollowUp,
  resolveProviderOptionsNamespaceKey,
  ANTHROPIC_1M_CONTEXT_HEADER,
  MUX_WORKSPACE_ID_HEADER,
} from "./providerOptions";

// Mock the log module to avoid console noise
void mock.module("@/node/services/log", () => ({
  log: {
    debug: (): void => undefined,
    info: (): void => undefined,
    warn: (): void => undefined,
    error: (): void => undefined,
  },
}));

function createMockProvidersConfig(mappings: Record<string, string>): ProvidersConfigMap {
  const config: ProvidersConfigMap = {};

  for (const [customModelId, baseModelId] of Object.entries(mappings)) {
    const [provider, modelId] = customModelId.split(":", 2);
    if (!provider || !modelId) {
      continue;
    }

    const existingProviderConfig = config[provider];
    config[provider] = {
      apiKeySet: existingProviderConfig?.apiKeySet ?? false,
      isEnabled: existingProviderConfig?.isEnabled ?? true,
      isConfigured: existingProviderConfig?.isConfigured ?? true,
      models: [
        ...(existingProviderConfig?.models ?? []),
        { id: modelId, mappedToModel: baseModelId },
      ],
    };
  }

  return config;
}

describe("resolveProviderOptionsNamespaceKey", () => {
  test("returns the canonical provider for direct routing", () => {
    expect(resolveProviderOptionsNamespaceKey("openai")).toBe("openai");
  });

  test("returns the canonical provider for same-provider routing", () => {
    expect(resolveProviderOptionsNamespaceKey("openai", "openai")).toBe("openai");
  });

  test("returns the canonical provider for passthrough gateways", () => {
    expect(resolveProviderOptionsNamespaceKey("openai", "mux-gateway")).toBe("openai");
  });

  test("returns the route provider for non-passthrough OpenRouter routing", () => {
    expect(resolveProviderOptionsNamespaceKey("openai", "openrouter")).toBe("openrouter");
  });

  test("returns the route provider for non-passthrough Copilot routing", () => {
    expect(resolveProviderOptionsNamespaceKey("openai", "github-copilot")).toBe("github-copilot");
  });
});

const baseAnthropicOptions = {
  disableParallelToolUse: false,
  sendReasoning: true,
};

function anthropicProviderOptions(
  result: ReturnType<typeof buildProviderOptions>
): Record<string, unknown> {
  return (result as Record<string, unknown>).anthropic as Record<string, unknown>;
}

describe("buildProviderOptions - Anthropic", () => {
  describe("Opus 4.5 (effort parameter)", () => {
    for (const { model, thinking, budgetTokens, effort } of [
      { model: "claude-opus-4-5", thinking: "medium", budgetTokens: 10000, effort: "medium" },
      { model: "claude-opus-4-5-20251101", thinking: "high", budgetTokens: 20000, effort: "high" },
    ] as const) {
      test(`uses effort and thinking parameters for ${model}`, () => {
        expect(buildProviderOptions(`anthropic:${model}`, thinking)).toEqual({
          anthropic: {
            ...baseAnthropicOptions,
            thinking: { type: "enabled", budgetTokens },
            effort,
          },
        });
      });
    }

    test("should use effort 'low' with no thinking when off for Opus 4.5", () => {
      expect(buildProviderOptions("anthropic:claude-opus-4-5", "off")).toEqual({
        anthropic: { ...baseAnthropicOptions, effort: "low" },
      });
    });
  });

  // Non-native-xhigh adaptive models: xhigh falls back to "max" effort and
  // adaptive thinking carries no `display` field.
  for (const model of ["claude-opus-4-6", "claude-sonnet-4-6"] as const) {
    describe(`${model} (adaptive thinking + effort)`, () => {
      for (const { thinking, expectedThinking, effort } of [
        { thinking: "medium", expectedThinking: { type: "adaptive" }, effort: "medium" },
        { thinking: "xhigh", expectedThinking: { type: "adaptive" }, effort: "max" },
        { thinking: "off", expectedThinking: { type: "disabled" }, effort: "low" },
      ] as const) {
        test(`maps ${thinking} to ${effort} effort`, () => {
          const anthropic = anthropicProviderOptions(
            buildProviderOptions(`anthropic:${model}`, thinking)
          );

          if (thinking === "medium") {
            expect(anthropic.disableParallelToolUse).toBe(false);
            expect(anthropic.sendReasoning).toBe(true);
          }
          expect(anthropic.thinking).toEqual(expectedThinking);
          expect(anthropic.effort).toBe(effort);
        });
      }
    });
  }

  // Native-xhigh models (Opus 4.7+ / Sonnet 5+): xhigh is a distinct native
  // effort and adaptive thinking requires `display: "summarized"` to return
  // thinking content.
  for (const model of ["claude-opus-4-7", "claude-opus-5", "claude-sonnet-5"] as const) {
    describe(`${model} (native xhigh effort + summarized display)`, () => {
      for (const { thinking, expectedThinking, effort } of [
        {
          thinking: "medium",
          expectedThinking: { type: "adaptive", display: "summarized" },
          effort: "medium",
        },
        {
          thinking: "xhigh",
          expectedThinking: { type: "adaptive", display: "summarized" },
          effort: "xhigh",
        },
        {
          thinking: "max",
          expectedThinking: { type: "adaptive", display: "summarized" },
          effort: "max",
        },
        { thinking: "off", expectedThinking: { type: "disabled" }, effort: "low" },
      ] as const) {
        test(`maps ${thinking} to ${effort} effort`, () => {
          const anthropic = anthropicProviderOptions(
            buildProviderOptions(`anthropic:${model}`, thinking)
          );

          expect(anthropic.thinking).toEqual(expectedThinking);
          expect(anthropic.effort).toBe(effort);
        });
      }
    });
  }

  describe("claude-fable-5 (Mythos-class: API rejects disabled thinking)", () => {
    test("maps medium to adaptive thinking like other adaptive models", () => {
      const anthropic = anthropicProviderOptions(
        buildProviderOptions("anthropic:claude-fable-5", "medium")
      );
      // Mythos-class models are native-xhigh tier, so adaptive thinking carries
      // the summarized display flag.
      expect(anthropic.thinking).toEqual({ type: "adaptive", display: "summarized" });
      expect(anthropic.effort).toBe("medium");
      // Fable 5.1 rides the same Mythos-class wildcard matcher.
      const anthropic51 = anthropicProviderOptions(
        buildProviderOptions("anthropic:claude-fable-5-1", "medium")
      );
      expect(anthropic51.thinking).toEqual({ type: "adaptive", display: "summarized" });
      expect(anthropic51.effort).toBe("medium");
      // Mythos 5.1 does too.
      const mythos51 = anthropicProviderOptions(
        buildProviderOptions("anthropic:claude-mythos-5-1", "medium")
      );
      expect(mythos51.thinking).toEqual({ type: "adaptive", display: "summarized" });
      expect(mythos51.effort).toBe("medium");
    });

    test("omits thinking instead of sending disabled when off", () => {
      // The API errors on `thinking: { type: "disabled" }` for Mythos-class models;
      // omitting the field lets it default to adaptive. "off" can still reach here
      // when no thinking level was provided upstream (defaults to off).
      expect(buildProviderOptions("anthropic:claude-fable-5", "off")).toEqual({
        anthropic: { ...baseAnthropicOptions, effort: "low" },
      });
      expect(buildProviderOptions("anthropic:claude-fable-5-1", "off")).toEqual({
        anthropic: { ...baseAnthropicOptions, effort: "low" },
      });
      expect(buildProviderOptions("anthropic:claude-mythos-5-1", "off")).toEqual({
        anthropic: { ...baseAnthropicOptions, effort: "low" },
      });
    });
  });

  describe("Other Anthropic models (thinking/budgetTokens)", () => {
    for (const { model, thinking, budgetTokens } of [
      { model: "claude-sonnet-4-5", thinking: "medium", budgetTokens: 10000 },
      { model: "claude-opus-4-1", thinking: "high", budgetTokens: 20000 },
      { model: "claude-haiku-4-5", thinking: "low", budgetTokens: 4000 },
    ] as const) {
      test(`should use thinking.budgetTokens for ${model}`, () => {
        expect(buildProviderOptions(`anthropic:${model}`, thinking)).toEqual({
          anthropic: {
            ...baseAnthropicOptions,
            thinking: { type: "enabled", budgetTokens },
          },
        });
      });
    }

    test("should omit thinking when thinking is off for non-Opus 4.5", () => {
      expect(buildProviderOptions("anthropic:claude-sonnet-4-5", "off")).toEqual({
        anthropic: baseAnthropicOptions,
      });
    });
  });

  describe("Anthropic cache TTL overrides", () => {
    for (const { name, model, thinking, cacheTtl, expected } of [
      {
        name: "should omit top-level cacheControl even when cache TTL is configured",
        model: "claude-sonnet-4-5",
        thinking: "off",
        cacheTtl: "1h",
        expected: baseAnthropicOptions,
      },
      {
        name: "should preserve Opus 4.6 reasoning options without top-level cacheControl",
        model: "claude-opus-4-6",
        thinking: "medium",
        cacheTtl: "5m",
        expected: { ...baseAnthropicOptions, thinking: { type: "adaptive" }, effort: "medium" },
      },
    ] as const) {
      test(name, () => {
        expect(
          buildProviderOptions(`anthropic:${model}`, thinking, undefined, undefined, {
            anthropic: { cacheTtl },
          })
        ).toEqual({ anthropic: expected });
      });
    }
  });

  describe("disableBetaFeatures", () => {
    for (const disableBetaFeatures of [true, false] as const) {
      test(`keeps omitting top-level cacheControl when disableBetaFeatures is ${disableBetaFeatures}`, () => {
        const anthropic = anthropicProviderOptions(
          buildProviderOptions("anthropic:claude-sonnet-4-5", "medium", undefined, undefined, {
            anthropic: { cacheTtl: "1h", disableBetaFeatures },
          })
        );

        expect(anthropic.cacheControl).toBeUndefined();
        expect(anthropic.sendReasoning).toBe(true);
      });
    }
  });
});

describe("buildProviderOptions - mappedToModel resolution", () => {
  test("resolves custom alias to claude-sonnet-4-5 for thinking budget", () => {
    const providersConfig = createMockProvidersConfig({
      "anthropic:claude/sonnet": "anthropic:claude-sonnet-4-5-20250514",
    });

    const result = buildProviderOptions(
      "anthropic:claude/sonnet",
      "medium",
      undefined,
      undefined,
      undefined,
      undefined,
      undefined,
      providersConfig
    );

    expect(result).toEqual({
      anthropic: {
        disableParallelToolUse: false,
        sendReasoning: true,
        thinking: {
          type: "enabled",
          budgetTokens: 10000,
        },
      },
    });
  });

  test("resolves custom alias to claude-opus-4-6 for adaptive thinking", () => {
    const providersConfig = createMockProvidersConfig({
      "anthropic:claude/opus": "anthropic:claude-opus-4-6-20260219",
    });

    const result = buildProviderOptions(
      "anthropic:claude/opus",
      "high",
      undefined,
      undefined,
      undefined,
      undefined,
      undefined,
      providersConfig
    );
    const anthropic = (result as Record<string, unknown>).anthropic as Record<string, unknown>;

    expect(anthropic.thinking).toEqual({ type: "adaptive" });
    expect(anthropic.effort).toBe("high");
  });

  test("works without providersConfig (backward compat)", () => {
    const result = buildProviderOptions("anthropic:claude-sonnet-4-5-20250514", "medium");

    expect(result).toEqual({
      anthropic: {
        disableParallelToolUse: false,
        sendReasoning: true,
        thinking: {
          type: "enabled",
          budgetTokens: 10000,
        },
      },
    });
  });

  test("buildRequestHeaders resolves alias for 1M beta context header", () => {
    const providersConfig = createMockProvidersConfig({
      "anthropic:claude/sonnet": "anthropic:claude-sonnet-4-5-20250929",
    });

    const result = buildRequestHeaders(
      "anthropic:claude/sonnet",
      { anthropic: { use1MContext: true } },
      undefined,
      providersConfig
    );

    expect(result).toEqual({ "anthropic-beta": ANTHROPIC_1M_CONTEXT_HEADER });
  });
});

describe("Coder gateway-scoped models (wire-canonical option building)", () => {
  // coder:<instance>/<model> strings that stay gateway-scoped (custom-named
  // instances, non-canonical types) must build the same options/headers as
  // the identical model on a default-named instance: the wire is derived
  // from the instance's TYPE, not the "coder" prefix.
  const coderProvidersConfig: ProvidersConfigMap = {
    coder: {
      apiKeySet: false,
      isEnabled: true,
      isConfigured: true,
      discoveredProviders: [
        { name: "prod-anthropic", type: "anthropic" },
        { name: "llm-proxy", type: "openai-compat" },
      ],
    },
  };

  test("custom-named anthropic instance gets Anthropic thinking options", () => {
    const viaCustom = buildProviderOptions(
      "coder:prod-anthropic/claude-opus-4-5",
      "high",
      undefined,
      undefined,
      undefined,
      undefined,
      undefined,
      coderProvidersConfig,
      "coder"
    );
    const viaDefault = buildProviderOptions(
      "coder:anthropic/claude-opus-4-5",
      "high",
      undefined,
      undefined,
      undefined,
      undefined,
      undefined,
      coderProvidersConfig,
      "coder"
    );
    expect(viaCustom).toEqual(viaDefault);
    expect(viaCustom).toHaveProperty("anthropic");
  });

  test("openai-compat instance gets OpenAI-shaped options, not none", () => {
    const options = buildProviderOptions(
      "coder:llm-proxy/gpt-5",
      "medium",
      undefined,
      undefined,
      undefined,
      undefined,
      undefined,
      coderProvidersConfig,
      "coder"
    );
    expect(options).toHaveProperty("openai");
  });

  test("user-declared additionalProviders resolve the wire too", () => {
    const options = buildProviderOptions(
      "coder:wif-anthropic/claude-opus-4-5",
      "high",
      undefined,
      undefined,
      undefined,
      undefined,
      undefined,
      {
        coder: {
          apiKeySet: false,
          isEnabled: true,
          isConfigured: true,
          additionalProviders: [{ name: "wif-anthropic", type: "anthropic" }],
        },
      },
      "coder"
    );
    expect(options).toHaveProperty("anthropic");
  });

  test("unknown instance names build no options", () => {
    const options = buildProviderOptions(
      "coder:mystery/some-model",
      "medium",
      undefined,
      undefined,
      undefined,
      undefined,
      undefined,
      coderProvidersConfig,
      "coder"
    );
    expect(options).toEqual({});
  });

  test("custom-named anthropic instance gets the 1M beta header", () => {
    const headers = buildRequestHeaders(
      "coder:prod-anthropic/claude-sonnet-4-5",
      { anthropic: { use1MContext: true } },
      undefined,
      coderProvidersConfig,
      "coder"
    );
    expect(headers).toEqual({ "anthropic-beta": ANTHROPIC_1M_CONTEXT_HEADER });
  });

  test("bedrock-typed instance resolves 1M capability through its metadata identity", () => {
    // The wire-canonical string mangles metadata-divergent instances
    // (anthropic:anthropic.claude-* fails the anchored Claude patterns);
    // capability must resolve from the raw identity via the instance type
    // (bedrock:anthropic.claude-* → anthropic:claude-*), with intent keyed
    // by the raw string like the UI's per-model toggles.
    const config: ProvidersConfigMap = {
      coder: {
        apiKeySet: false,
        isEnabled: true,
        isConfigured: true,
        discoveredProviders: [{ name: "bedrock", type: "bedrock" }],
      },
    };
    const headers = buildRequestHeaders(
      "coder:bedrock/anthropic.claude-sonnet-4-5",
      {
        anthropic: { use1MContextModels: ["coder:bedrock/anthropic.claude-sonnet-4-5"] },
      },
      undefined,
      config,
      "coder"
    );
    expect(headers).toEqual({ "anthropic-beta": ANTHROPIC_1M_CONTEXT_HEADER });
  });

  test("non-Anthropic wires never get the 1M beta header", () => {
    // A vercel-typed instance maps Claude vendor models to anthropic:* for
    // metadata, but speaks openai-chat on the wire: the anthropic-beta header
    // cannot be carried, so 1M intent must not attach it.
    const config: ProvidersConfigMap = {
      coder: {
        apiKeySet: false,
        isEnabled: true,
        isConfigured: true,
        discoveredProviders: [{ name: "vercel", type: "vercel" }],
      },
    };
    const headers = buildRequestHeaders(
      "coder:vercel/anthropic/claude-sonnet-4-5",
      {
        anthropic: { use1MContextModels: ["coder:vercel/anthropic/claude-sonnet-4-5"] },
      },
      undefined,
      config,
      "coder"
    );
    expect(headers).toBeUndefined();
  });

  // Discovered metadata must win over the instance NAME: a valid instance can
  // use a canonical route name with a different type, and normalizing the name
  // before consulting metadata would emit options for the wrong wire.
  describe("canonical-named instance with a different type", () => {
    const crossTypedConfig: ProvidersConfigMap = {
      coder: {
        apiKeySet: false,
        isEnabled: true,
        isConfigured: true,
        discoveredProviders: [
          { name: "openai", type: "anthropic" },
          { name: "anthropic", type: "openai-compat" },
        ],
      },
    };

    test("anthropic-typed instance named openai gets Anthropic options", () => {
      const options = buildProviderOptions(
        "coder:openai/claude-opus-4-5",
        "high",
        undefined,
        undefined,
        undefined,
        undefined,
        undefined,
        crossTypedConfig,
        "coder"
      );
      expect(options).toHaveProperty("anthropic");
      expect(options).not.toHaveProperty("openai");
    });

    test("anthropic-typed instance named openai gets the 1M beta header", () => {
      const headers = buildRequestHeaders(
        "coder:openai/claude-sonnet-4-5",
        { anthropic: { use1MContext: true } },
        undefined,
        crossTypedConfig,
        "coder"
      );
      expect(headers).toEqual({ "anthropic-beta": ANTHROPIC_1M_CONTEXT_HEADER });
    });

    test("openai-compat-typed instance named anthropic gets OpenAI options", () => {
      const options = buildProviderOptions(
        "coder:anthropic/gpt-5",
        "medium",
        undefined,
        undefined,
        undefined,
        undefined,
        undefined,
        crossTypedConfig,
        "coder"
      );
      expect(options).toHaveProperty("openai");
      expect(options).not.toHaveProperty("anthropic");
    });
  });

  test("custom OpenAI-compatible provider named coder shadows gateway wire treatment", () => {
    const options = buildProviderOptions(
      "coder:anthropic/claude-opus-4-5",
      "high",
      undefined,
      undefined,
      undefined,
      undefined,
      undefined,
      {
        coder: {
          apiKeySet: true,
          isEnabled: true,
          isConfigured: true,
          providerType: "openai-compatible",
          baseUrl: "https://proxy.example.com/v1",
        },
      },
      "coder"
    );
    // The string is the custom provider's identity; it must not be rewritten
    // to anthropic:<model> by name convention or gateway metadata.
    expect(options).not.toHaveProperty("anthropic");
  });
});

describe("isAnthropic1MEffectivelyEnabled", () => {
  test("returns true for beta-only Sonnet models with global 1M flag", () => {
    expect(
      isAnthropic1MEffectivelyEnabled("anthropic:claude-sonnet-4-5", {
        anthropic: { use1MContext: true },
      })
    ).toBe(true);
  });

  test("returns true when use1MContextModels includes an alias mapped to a beta-only model", () => {
    const providersConfig = createMockProvidersConfig({
      "anthropic:claude/sonnet": "anthropic:claude-sonnet-4-5-20250929",
    });

    expect(
      isAnthropic1MEffectivelyEnabled(
        "anthropic:claude/sonnet",
        {
          anthropic: { use1MContextModels: ["anthropic:claude/sonnet"] },
        },
        providersConfig
      )
    ).toBe(true);
  });

  test("returns false when beta features are disabled", () => {
    expect(
      isAnthropic1MEffectivelyEnabled("anthropic:claude-sonnet-4-5", {
        anthropic: { use1MContext: true, disableBetaFeatures: true },
      })
    ).toBe(false);
  });

  test("returns false for native 1M models that no longer need the beta header", () => {
    expect(
      isAnthropic1MEffectivelyEnabled("anthropic:claude-opus-4-6", {
        anthropic: { use1MContext: true },
      })
    ).toBe(false);
  });

  test("returns false for unsupported models", () => {
    expect(
      isAnthropic1MEffectivelyEnabled("anthropic:claude-opus-4-1", {
        anthropic: { use1MContext: true },
      })
    ).toBe(false);
  });

  test("returns false when no 1M intent was provided", () => {
    expect(
      isAnthropic1MEffectivelyEnabled("anthropic:claude-sonnet-4-5", {
        anthropic: {},
      })
    ).toBe(false);
  });

  test("returns false when provider options are missing", () => {
    expect(isAnthropic1MEffectivelyEnabled("anthropic:claude-sonnet-4-5")).toBe(false);
  });
});

describe("preserveAnthropic1MContextForFollowUp", () => {
  test("preserves beta 1M for alias source model when providersConfig resolves to a beta-only model", () => {
    const providersConfig = createMockProvidersConfig({
      "anthropic:claude/sonnet": "anthropic:claude-sonnet-4-5-20250929",
    });

    const result = preserveAnthropic1MContextForFollowUp(
      "anthropic:claude/sonnet",
      "anthropic:claude-sonnet-4-5",
      {
        anthropic: {
          use1MContextModels: ["anthropic:claude/sonnet"],
        },
      },
      providersConfig
    );

    expect(result?.anthropic?.use1MContext).toBe(true);
  });

  test("does not preserve beta 1M for alias source model without providersConfig", () => {
    const result = preserveAnthropic1MContextForFollowUp(
      "anthropic:claude/sonnet",
      "anthropic:claude-sonnet-4-5",
      {
        anthropic: {
          use1MContextModels: ["anthropic:claude/sonnet"],
        },
      }
    );

    expect(result?.anthropic?.use1MContext).not.toBe(true);
  });
});

describe("buildProviderOptions - OpenAI", () => {
  // Helper to extract OpenAI options from the result
  const getOpenAIOptions = (
    result: ReturnType<typeof buildProviderOptions>
  ): OpenAIResponsesProviderOptions | undefined => {
    if ("openai" in result) {
      return result.openai;
    }
    return undefined;
  };

  test("keeps provider-level parallel tool calls enabled for Responses models", () => {
    const result = buildProviderOptions("openai:gpt-5.2", "medium", undefined, undefined, {
      openai: { wireFormat: "responses" },
    });
    const openai = getOpenAIOptions(result);

    expect(openai).toBeDefined();
    expect(openai!.parallelToolCalls).toBe(true);
  });

  describe("store option", () => {
    test("should include store: false when muxProviderOptions sets store to false", () => {
      const result = buildProviderOptions("openai:gpt-5", "medium", undefined, undefined, {
        openai: { store: false },
      });
      const openai = (result as Record<string, unknown>).openai as Record<string, unknown>;
      expect(openai.store).toBe(false);
    });

    test("should not include store key when muxProviderOptions.openai.store is undefined", () => {
      const result = buildProviderOptions("openai:gpt-5", "medium", undefined, undefined, {
        openai: {},
      });
      const openai = (result as Record<string, unknown>).openai as Record<string, unknown>;
      expect("store" in openai).toBe(false);
    });

    test("should include store: true when explicitly set", () => {
      const result = buildProviderOptions("openai:gpt-5", "medium", undefined, undefined, {
        openai: { store: true },
      });
      const openai = (result as Record<string, unknown>).openai as Record<string, unknown>;
      expect(openai.store).toBe(true);
    });
  });

  describe("serviceTier option", () => {
    test("should not include serviceTier key when muxProviderOptions is omitted", () => {
      const result = buildProviderOptions("openai:gpt-5", "medium");
      const openai = getOpenAIOptions(result);

      expect(openai).toBeDefined();
      expect("serviceTier" in openai!).toBe(false);
    });

    test("should not include serviceTier key when muxProviderOptions.openai.serviceTier is undefined", () => {
      const result = buildProviderOptions("openai:gpt-5", "medium", undefined, undefined, {
        openai: { serviceTier: undefined },
      });
      const openai = getOpenAIOptions(result);

      expect(openai).toBeDefined();
      expect("serviceTier" in openai!).toBe(false);
    });

    test("should include serviceTier: auto when explicitly set", () => {
      const result = buildProviderOptions("openai:gpt-5", "medium", undefined, undefined, {
        openai: { serviceTier: "auto" },
      });
      const openai = getOpenAIOptions(result);

      expect(openai).toBeDefined();
      expect("serviceTier" in openai!).toBe(true);
      expect(openai!.serviceTier).toBe("auto");
    });

    test("should include explicit non-auto serviceTier", () => {
      const result = buildProviderOptions("openai:gpt-5", "medium", undefined, undefined, {
        openai: { serviceTier: "flex" },
      });
      const openai = getOpenAIOptions(result);

      expect(openai).toBeDefined();
      expect("serviceTier" in openai!).toBe(true);
      expect(openai!.serviceTier).toBe("flex");
    });
  });

  describe("promptCacheKey derivation", () => {
    test("should prefer promptCacheScope over workspaceId for promptCacheKey", () => {
      const result = buildProviderOptions(
        "openai:gpt-5.2",
        "off",
        undefined,
        undefined,
        undefined,
        "workspace-abc123",
        undefined,
        undefined,
        undefined,
        "my-project-deadbeef"
      );
      const openai = getOpenAIOptions(result);

      expect(openai).toBeDefined();
      expect(openai!.promptCacheKey).toBe("mux-v1-my-project-deadbeef");
      expect(openai!.truncation).toBe("disabled");
    });

    test("should fall back to workspaceId when projectName is not provided", () => {
      const result = buildProviderOptions(
        "openai:gpt-5.2",
        "off",
        undefined,
        undefined,
        undefined,
        "abc123"
      );
      const openai = getOpenAIOptions(result);

      expect(openai).toBeDefined();
      expect(openai!.promptCacheKey).toBe("mux-v1-abc123");
      expect(openai!.truncation).toBe("disabled");
    });

    test("should allow auto truncation when explicitly enabled", () => {
      const result = buildProviderOptions(
        "openai:gpt-5.2",
        "off",
        undefined,
        undefined,
        undefined,
        "compaction-workspace",
        "auto"
      );
      const openai = getOpenAIOptions(result);

      expect(openai).toBeDefined();
      expect(openai!.truncation).toBe("auto");
    });
    test("should derive promptCacheKey for gateway OpenAI model with promptCacheScope", () => {
      const result = buildProviderOptions(
        "mux-gateway:openai/gpt-5.2",
        "off",
        undefined,
        undefined,
        undefined,
        "workspace-xyz",
        undefined,
        undefined,
        undefined,
        "gateway-project-cafebabe"
      );
      const openai = getOpenAIOptions(result);

      expect(openai).toBeDefined();
      expect(openai!.promptCacheKey).toBe("mux-v1-gateway-project-cafebabe");
      expect(openai!.truncation).toBe("disabled");
    });
  });

  describe("GPT-5.6 Chat Completions promptCacheKey", () => {
    const chatWireFormat = { openai: { wireFormat: "chatCompletions" as const } };
    const directOpenAIConfig: ProvidersConfigMap = {
      openai: { apiKeySet: true, isEnabled: true, isConfigured: true },
    };

    function buildChatOptions(
      model: string,
      opts?: {
        providersConfig?: ProvidersConfigMap;
        routeProvider?: Parameters<typeof buildProviderOptions>[8];
      }
    ): OpenAIResponsesProviderOptions | undefined {
      return getOpenAIOptions(
        buildProviderOptions(
          model,
          "medium",
          undefined,
          undefined,
          chatWireFormat,
          "workspace-1",
          undefined,
          opts?.providersConfig ?? directOpenAIConfig,
          opts?.routeProvider,
          "project-scope"
        )
      );
    }

    test("direct GPT-5.6 Chat Completions receives the stable cache key", () => {
      const openai = buildChatOptions("openai:gpt-5.6-luna", { routeProvider: "openai" });

      expect(openai?.promptCacheKey).toBe("mux-v1-project-scope");
      // Responses-only fields stay omitted on Chat Completions.
      expect(openai?.truncation).toBeUndefined();
      expect(openai?.include).toBeUndefined();
      expect(openai?.reasoningSummary).toBeUndefined();
    });

    test("mapped GPT-5.6 aliases inherit the cache key; non-GPT-5.6 aliases do not", () => {
      const aliasConfig: ProvidersConfigMap = {
        openai: {
          apiKeySet: true,
          isEnabled: true,
          isConfigured: true,
          models: [
            { id: "team-sol", mappedToModel: "openai:gpt-5.6-sol" },
            { id: "team-old", mappedToModel: "openai:gpt-5.2" },
          ],
        },
      };

      expect(
        buildChatOptions("openai:team-sol", {
          providersConfig: aliasConfig,
          routeProvider: "openai",
        })?.promptCacheKey
      ).toBe("mux-v1-project-scope");
      expect(
        buildChatOptions("openai:team-old", {
          providersConfig: aliasConfig,
          routeProvider: "openai",
        })?.promptCacheKey
      ).toBeUndefined();
    });

    test("older models, missing routes, gateways, Codex OAuth, and custom endpoints get no key", () => {
      // Older model on the eligible route.
      expect(
        buildChatOptions("openai:gpt-5.2", { routeProvider: "openai" })?.promptCacheKey
      ).toBeUndefined();
      // Missing route metadata fails closed.
      expect(buildChatOptions("openai:gpt-5.6-luna")?.promptCacheKey).toBeUndefined();
      // Passthrough gateway route fails closed.
      expect(
        buildChatOptions("openai:gpt-5.6-luna", { routeProvider: "mux-gateway" })?.promptCacheKey
      ).toBeUndefined();
      // Codex OAuth wins the auth path.
      expect(
        buildChatOptions("openai:gpt-5.6-luna", {
          routeProvider: "openai",
          providersConfig: {
            openai: { apiKeySet: false, isEnabled: true, isConfigured: true, codexOauthSet: true },
          },
        })?.promptCacheKey
      ).toBeUndefined();
      // Custom base URL fails closed.
      expect(
        buildChatOptions("openai:gpt-5.6-luna", {
          routeProvider: "openai",
          providersConfig: {
            openai: {
              apiKeySet: true,
              isEnabled: true,
              isConfigured: true,
              baseUrl: "https://proxy.example.com/v1",
            },
          },
        })?.promptCacheKey
      ).toBeUndefined();
    });

    test("GPT-5.6 Responses keeps the legacy broader key behavior unchanged", () => {
      // Route-absent Responses request: legacy behavior still derives the key.
      const routeAbsent = getOpenAIOptions(
        buildProviderOptions(
          "openai:gpt-5.6-luna",
          "medium",
          undefined,
          undefined,
          undefined,
          "workspace-1",
          undefined,
          undefined,
          undefined,
          "project-scope"
        )
      );
      expect(routeAbsent?.promptCacheKey).toBe("mux-v1-project-scope");

      // Passthrough gateway Responses request: legacy behavior still applies.
      const passthrough = getOpenAIOptions(
        buildProviderOptions(
          "mux-gateway:openai/gpt-5.6-luna",
          "medium",
          undefined,
          undefined,
          undefined,
          "workspace-1",
          undefined,
          undefined,
          "mux-gateway",
          "project-scope"
        )
      );
      expect(passthrough?.promptCacheKey).toBe("mux-v1-project-scope");
    });
  });

  describe("route provider format selection", () => {
    test("uses the transforming route provider format for gateway-routed OpenAI models", () => {
      const result = buildProviderOptions(
        "mux-gateway:openai/gpt-5.2",
        "medium",
        undefined,
        undefined,
        undefined,
        undefined,
        undefined,
        undefined,
        "openrouter"
      );

      expect(result).toEqual({
        openrouter: {
          reasoning: {
            enabled: true,
            effort: "medium",
            exclude: false,
          },
        },
      });
    });

    test("falls back to the canonical origin provider format when routeProvider is absent", () => {
      const result = buildProviderOptions("mux-gateway:openai/gpt-5.2", "medium");
      const openai = getOpenAIOptions(result);

      expect(openai).toBeDefined();
      expect(openai!.reasoningEffort).toBe("medium");
      expect("openrouter" in result).toBe(false);
    });

    test("uses the resolved gateway namespace for Copilot-routed OpenAI reasoning controls", () => {
      const result = buildProviderOptions(
        "openai:gpt-5.2",
        "medium",
        undefined,
        undefined,
        undefined,
        undefined,
        undefined,
        undefined,
        "github-copilot"
      );

      expect(result).toEqual({
        "github-copilot": {
          reasoningEffort: "medium",
        },
      });
    });

    test("returns no Copilot-routed OpenAI provider options when thinking is off", () => {
      const result = buildProviderOptions(
        "openai:gpt-5.2",
        "off",
        undefined,
        undefined,
        undefined,
        undefined,
        undefined,
        undefined,
        "github-copilot"
      );

      expect(result).toEqual({});
    });

    test("omits Responses-only OpenAI fields for Copilot-routed OpenAI models", () => {
      const result = buildProviderOptions(
        "openai:gpt-5.2",
        "medium",
        undefined,
        undefined,
        undefined,
        "workspace-copilot",
        "auto",
        undefined,
        "github-copilot"
      ) as Record<string, unknown>;
      const copilotOptions = result["github-copilot"] as Record<string, unknown> | undefined;

      expect(copilotOptions).toEqual({ reasoningEffort: "medium" });
      expect(copilotOptions?.truncation).toBeUndefined();
      expect(copilotOptions?.reasoningSummary).toBeUndefined();
      expect(copilotOptions?.include).toBeUndefined();
      expect(copilotOptions?.promptCacheKey).toBeUndefined();
    });
  });

  describe("reasoning summary compatibility", () => {
    test("should include reasoningSummary for supported OpenAI reasoning models", () => {
      const result = buildProviderOptions("openai:gpt-5.2", "medium");
      const openai = getOpenAIOptions(result);

      expect(openai).toBeDefined();
      expect(openai!.reasoningEffort).toBe("medium");
      expect(openai!.reasoningSummary).toBe("detailed");
      expect(openai!.include).toEqual(["reasoning.encrypted_content"]);
    });

    test("should disable reasoningSummary for gpt-5.3-codex-spark", () => {
      const result = buildProviderOptions("openai:gpt-5.3-codex-spark", "medium");
      const openai = getOpenAIOptions(result);

      expect(openai).toBeDefined();
      expect(openai!.reasoningEffort).toBe("medium");
      // AI SDK 7 defaults reasoningSummary to "detailed" when reasoningEffort
      // is set; models that reject the parameter must opt out with null.
      expect(openai!.reasoningSummary).toBeNull();
      expect(openai!.include).toEqual(["reasoning.encrypted_content"]);
    });
  });

  describe("GPT-5.6 Sol native max reasoning effort", () => {
    test("maps ThinkingLevel max to the native max effort on Sol", () => {
      const result = buildProviderOptions("openai:gpt-5.6-sol", "max");
      const openai = getOpenAIOptions(result);

      expect(openai).toBeDefined();
      expect(openai!.reasoningEffort).toBe("max");
    });

    test("keeps xhigh distinct from max on Sol", () => {
      const result = buildProviderOptions("openai:gpt-5.6-sol", "xhigh");
      const openai = getOpenAIOptions(result);

      expect(openai).toBeDefined();
      expect(openai!.reasoningEffort).toBe("xhigh");
    });

    test("maps max to the native effort across the GPT-5.6 family", () => {
      for (const model of ["openai:gpt-5.6-terra", "openai:gpt-5.6-luna"]) {
        const result = buildProviderOptions(model, "max");
        const openai = getOpenAIOptions(result);

        expect(openai).toBeDefined();
        expect(openai!.reasoningEffort).toBe("max");
      }
    });

    test("keeps max -> xhigh for pre-5.6 OpenAI models", () => {
      const result = buildProviderOptions("openai:gpt-5.5-pro", "max");
      const openai = getOpenAIOptions(result);

      expect(openai).toBeDefined();
      expect(openai!.reasoningEffort).toBe("xhigh");
    });

    test("sends the explicit none effort for GPT-5.6 off (omission defaults to medium)", () => {
      const result = buildProviderOptions("openai:gpt-5.6-sol", "off");
      const openai = getOpenAIOptions(result);

      expect(openai).toBeDefined();
      // Live-verified: effort-less GPT-5.6 requests run at medium; none + summary coexist.
      expect(openai!.reasoningEffort).toBe("none");
    });

    test("keeps omitting reasoning options for pre-5.6 OpenAI off", () => {
      const result = buildProviderOptions("openai:gpt-5.5", "off");
      const openai = getOpenAIOptions(result);

      expect(openai).toBeDefined();
      expect(openai!.reasoningEffort).toBeUndefined();
    });

    test("omits the effort for GPT-5.6 off on the Copilot gateway (none unpublished upstream)", () => {
      const result = buildProviderOptions(
        "openai:gpt-5.6-sol",
        "off",
        undefined,
        undefined,
        undefined,
        undefined,
        undefined,
        undefined,
        "github-copilot"
      );

      expect(result).toEqual({});
    });

    test("preserves native max on the chatCompletions wire format", () => {
      // @ai-sdk/openai 4.0.11 added "max" to its Chat Completions schema.
      const result = buildProviderOptions("openai:gpt-5.6-sol", "max", undefined, undefined, {
        openai: { wireFormat: "chatCompletions" },
      });
      const openai = getOpenAIOptions(result);

      expect(openai).toBeDefined();
      expect(openai!.reasoningEffort).toBe("max");
    });

    test("degrades native max to xhigh through the Copilot-routed gateway call site", () => {
      // Copilot's Chat Completions upstream has not published native-max
      // support, so the gateway path degrades to the pre-5.6 top effort.
      const result = buildProviderOptions(
        "openai:gpt-5.6-sol",
        "max",
        undefined,
        undefined,
        undefined,
        undefined,
        undefined,
        undefined,
        "github-copilot"
      );

      expect(result).toEqual({
        "github-copilot": {
          reasoningEffort: "xhigh",
        },
      });
    });

    // Mapped aliases inherit capabilities from their target like the other
    // capability checks (resolveModelForMetadata), so a custom entry mapped to
    // Sol must also get the native max effort.
    test("resolves mapped aliases to the target for native max effort", () => {
      const providersConfig = createMockProvidersConfig({
        "openai:team-sol": "openai:gpt-5.6-sol",
      });

      const result = buildProviderOptions(
        "openai:team-sol",
        "max",
        undefined,
        undefined,
        undefined,
        undefined,
        undefined,
        providersConfig
      );
      const openai = getOpenAIOptions(result);

      expect(openai).toBeDefined();
      expect(openai!.reasoningEffort).toBe("max");
    });
  });

  describe("Coder Pro mode", () => {
    const providersConfig: ProvidersConfigMap = {
      // Direct OpenAI settings must not disable Coder's independent Responses route.
      openai: {
        apiKeySet: false,
        isEnabled: true,
        isConfigured: true,
        codexOauthSet: true,
        wireFormat: "chatCompletions",
        models: [{ id: "team-astra", mappedToModel: "openai:gpt-6-astra" }],
      },
      coder: {
        apiKeySet: false,
        isEnabled: true,
        isConfigured: true,
        discoveredProviders: [
          { name: "prod-openai", type: "openai" },
          { name: "compat", type: "openai-compat" },
        ],
      },
      openrouter: { apiKeySet: true, isEnabled: true, isConfigured: true },
    };

    test.each([
      ["coder:openai/gpt-6-astra", true],
      ["coder:prod-openai/gpt-6-astra", true],
      ["openai:gpt-6-astra", true],
      ["openai:team-astra", true],
      ["coder:prod-openai/team-astra", true],
      ["coder:openai/gpt-5.6-sol", true],
      ["coder:openai/gpt-6-astra-mini", false],
      ["coder:compat/gpt-6-astra", false],
      ["coder:unknown/gpt-6-astra", false],
      ["openrouter:openai/gpt-6-astra", false],
    ] as const)("gates the picker and request consistently for %s", (model, available) => {
      expect(
        openaiProModeAvailable(model, { providersConfig, resolvedRouteProvider: "coder" })
      ).toBe(available);
      // The request builder pins wireFormat to the Coder instance's protocol.
      const options = buildProviderOptions(
        model,
        "high",
        undefined,
        undefined,
        { openai: { wireFormat: "responses" } },
        undefined,
        undefined,
        providersConfig,
        "coder",
        undefined,
        "pro"
      );
      expect(getOpenAIOptions(options)?.reasoningMode).toBe(available ? "pro" : undefined);
      // Pro eligibility must not broaden the shared direct-only Fast mode gate.
      expect(
        openaiDirectProviderOptionsAvailable(model, {
          providersConfig,
          resolvedRouteProvider: "coder",
        })
      ).toBe(false);
    });

    test.each([
      { scoped: "openai:gpt-6-astra", upstream: "openai:gpt-5.2", type: "openai", pro: true },
      { scoped: "openai:gpt-5.2", upstream: "openai:gpt-6-astra", type: "openai", pro: false },
      {
        scoped: "openai:gpt-6-astra",
        upstream: "openai:gpt-6-astra",
        type: "openai-compat",
        pro: false,
      },
    ])("scoped aliases control capabilities, not Coder's wire: %j", (testCase) => {
      const model = "coder:prod-openai/team-astra";
      const config: ProvidersConfigMap = {
        openai: {
          apiKeySet: true,
          isEnabled: true,
          isConfigured: true,
          models: [{ id: "team-astra", mappedToModel: testCase.upstream }],
        },
        coder: {
          apiKeySet: false,
          isEnabled: true,
          isConfigured: true,
          discoveredProviders: [{ name: "prod-openai", type: testCase.type }],
          models: [{ id: "prod-openai/team-astra", mappedToModel: testCase.scoped }],
        },
      };
      expect(openaiProModeAvailable(model, { providersConfig: config })).toBe(testCase.pro);
      const options = buildProviderOptions(
        model,
        "high",
        undefined,
        undefined,
        { openai: { wireFormat: "responses" } },
        undefined,
        undefined,
        config,
        "coder",
        undefined,
        "pro"
      );
      expect(getOpenAIOptions(options)?.reasoningMode).toBe(testCase.pro ? "pro" : undefined);
    });

    const fallbackAvailability: Array<Partial<NonNullable<ProvidersConfigMap["coder"]>>> = [
      { isEnabled: false, isConfigured: true },
      { isEnabled: true, isConfigured: false },
      { isEnabled: true, isConfigured: true, discoveredModels: [] },
      { isEnabled: true, isConfigured: true, removedModels: ["prod-openai/gpt-6-astra"] },
    ];
    test.each(fallbackAvailability)(
      "preserves Pro on custom-instance direct fallback (%j)",
      (availability) => {
        const config: ProvidersConfigMap = {
          ...providersConfig,
          openai: { apiKeySet: true, isEnabled: true, isConfigured: true },
          coder: { ...providersConfig.coder, ...availability },
        };
        const model = "coder:prod-openai/gpt-6-astra";
        expect(
          openaiProModeAvailable(model, {
            providersConfig: config,
            resolvedRouteProvider: "direct",
          })
        ).toBe(true);
        expect(
          openaiProModeAvailable(model, {
            providersConfig: config,
            resolvedRouteProvider: "mux-gateway",
          })
        ).toBe(false);
        expect(
          openaiProModeAvailable(model, {
            providersConfig: config,
            resolvedRouteProvider: "direct",
            openaiWireFormat: "chatCompletions",
          })
        ).toBe(false);
        expect(
          openaiProModeAvailable(model, {
            providersConfig: { ...config, openai: { ...config.openai, codexOauthSet: true } },
            resolvedRouteProvider: "direct",
          })
        ).toBe(false);
      }
    );

    test.each(["compat", "unknown"])(
      "does not invent an upstream for %s on fallback",
      (instance) => {
        expect(
          openaiProModeAvailable(`coder:${instance}/gpt-6-astra`, {
            providersConfig: {
              ...providersConfig,
              openai: { apiKeySet: true, isEnabled: true, isConfigured: true },
              coder: { ...providersConfig.coder, isEnabled: false },
            },
            resolvedRouteProvider: "direct",
          })
        ).toBe(false);
      }
    );

    test.each(["anthropic", "openai-compat"])(
      "does not trust an OpenAI-named instance whose type is %s",
      (type) => {
        const config = {
          ...providersConfig,
          coder: {
            ...providersConfig.coder,
            discoveredProviders: [{ name: "openai", type }],
          },
        };
        expect(
          openaiProModeAvailable("coder:openai/gpt-6-astra", { providersConfig: config })
        ).toBe(false);
      }
    );

    test("does not treat a custom provider shadowing coder as the gateway", () => {
      expect(
        openaiProModeAvailable("coder:openai/gpt-6-astra", {
          providersConfig: {
            coder: {
              ...providersConfig.coder,
              providerType: "openai-responses",
            },
          },
          resolvedRouteProvider: "coder",
        })
      ).toBe(false);
    });
  });

  describe("native pro reasoning mode", () => {
    const buildWithMode = (
      model: string,
      reasoningMode: Parameters<typeof buildProviderOptions>[10],
      options?: {
        thinkingLevel?: Parameters<typeof buildProviderOptions>[1];
        muxProviderOptions?: Parameters<typeof buildProviderOptions>[4];
        providersConfig?: Parameters<typeof buildProviderOptions>[7];
        routeProvider?: Parameters<typeof buildProviderOptions>[8];
      }
    ): OpenAIResponsesProviderOptions | undefined =>
      getOpenAIOptions(
        buildProviderOptions(
          model,
          options?.thinkingLevel ?? "off",
          undefined,
          undefined,
          options?.muxProviderOptions,
          undefined,
          undefined,
          options?.providersConfig,
          options?.routeProvider,
          undefined,
          reasoningMode
        )
      );

    test("sets the native Responses option independently of reasoning effort", () => {
      const openai = buildWithMode("openai:gpt-5.6-sol", "pro", { thinkingLevel: "max" });

      expect(openai?.reasoningEffort).toBe("max");
      expect(openai?.reasoningMode).toBe("pro");
    });

    test("supports pro mode across the GPT-5.6 family", () => {
      for (const model of [
        "openai:gpt-5.6",
        "openai:gpt-5.6-sol",
        "openai:gpt-5.6-terra",
        "openai:gpt-5.6-luna",
      ]) {
        expect(buildWithMode(model, "pro")?.reasoningMode).toBe("pro");
      }
    });

    test("omits pro mode for standard mode, unsupported models, gateways, and Chat Completions", () => {
      const cases = [
        buildWithMode("openai:gpt-5.6-sol", "standard"),
        buildWithMode("openai:gpt-6-astra", "standard"),
        buildWithMode("openai:gpt-6-astra", undefined),
        buildWithMode("openai:gpt-6-astra", "pro", { routeProvider: "mux-gateway" }),
        buildWithMode("openai:gpt-6-astra", "pro", {
          muxProviderOptions: { openai: { wireFormat: "chatCompletions" } },
        }),
        buildWithMode("openai:gpt-5.5-pro", "pro"),
        buildWithMode("openai:gpt-5.6-sol", "pro", { routeProvider: "mux-gateway" }),
        buildWithMode("openai:gpt-5.6-sol", "pro", {
          muxProviderOptions: { openai: { wireFormat: "chatCompletions" } },
        }),
      ];

      for (const openai of cases) {
        expect(openai?.reasoningMode).toBeUndefined();
      }
    });

    test("resolves mapped aliases before applying the pro-mode capability gate", () => {
      const providersConfig = createMockProvidersConfig({
        "openai:team-sol": "openai:gpt-5.6-sol",
      });

      expect(buildWithMode("openai:team-sol", "pro", { providersConfig })?.reasoningMode).toBe(
        "pro"
      );
    });

    test.each([
      ["gpt-5.6-sol", "openai"],
      ["gpt-6-astra", "openai"],
      ["gpt-6-astra", "coder"],
    ] as const)(
      "serializes native max and pro for %s via %s through the OpenAI SDK",
      async (model, routeProvider) => {
        const capturedBodies: Array<Record<string, unknown>> = [];
        const captureFetch = Object.assign(
          (
            input: Parameters<typeof fetch>[0],
            init?: Parameters<typeof fetch>[1]
          ): Promise<Response> => {
            if (typeof init?.body !== "string") {
              throw new Error("Expected the OpenAI provider to send a JSON string body");
            }
            capturedBodies.push(JSON.parse(init.body) as Record<string, unknown>);
            const url =
              typeof input === "string"
                ? input
                : input instanceof URL
                  ? input.toString()
                  : input.url;
            const responseBody = url.endsWith("/responses")
              ? {
                  id: "resp_test",
                  model: model,
                  output: [],
                  usage: { input_tokens: 1, output_tokens: 0 },
                }
              : {
                  id: "chat_test",
                  model: model,
                  choices: [
                    {
                      index: 0,
                      message: { role: "assistant", content: "ok" },
                      finish_reason: "stop",
                    },
                  ],
                  usage: { prompt_tokens: 1, completion_tokens: 1, total_tokens: 2 },
                };
            return Promise.resolve(
              new Response(JSON.stringify(responseBody), {
                status: 200,
                headers: { "content-type": "application/json" },
              })
            );
          },
          { preconnect: fetch.preconnect.bind(fetch) }
        );
        const openai = createOpenAI({
          apiKey: "test",
          baseURL: "https://example.test/v1",
          fetch: captureFetch,
        });
        const responsesOptions = buildWithMode(
          routeProvider === "coder" ? `coder:openai/${model}` : `openai:${model}`,
          "pro",
          { thinkingLevel: "max", routeProvider }
        );
        if (!responsesOptions) {
          throw new Error("Expected OpenAI Responses provider options");
        }

        const chatOptions = getOpenAIOptions(
          buildProviderOptions(`openai:${model}`, "max", undefined, undefined, {
            openai: { wireFormat: "chatCompletions" },
          })
        );
        if (!chatOptions) {
          throw new Error("Expected OpenAI Chat Completions provider options");
        }

        await generateText({
          model: openai.responses(model),
          prompt: "Return ok.",
          providerOptions: { openai: responsesOptions },
          maxRetries: 0,
        });
        await generateText({
          model: openai.chat(model),
          prompt: "Return ok.",
          providerOptions: { openai: chatOptions },
          maxRetries: 0,
        });

        expect(capturedBodies[0].reasoning).toEqual({
          effort: "max",
          summary: "detailed",
          mode: "pro",
        });
        expect(capturedBodies[1].reasoning_effort).toBe("max");
      }
    );
  });

  // Astra supports Pro independently of native max effort, but still rejects "none".
  describe("GPT-6 Astra reasoning options", () => {
    test("maps max to the native max effort and clamps off to low instead of none", () => {
      expect(getOpenAIOptions(buildProviderOptions("openai:gpt-6-astra", "max"))).toMatchObject({
        reasoningEffort: "max",
        reasoningSummary: "detailed",
        include: ["reasoning.encrypted_content"],
      });
      expect(getOpenAIOptions(buildProviderOptions("openai:gpt-6-astra", "xhigh"))).toMatchObject({
        reasoningEffort: "xhigh",
      });
      expect(getOpenAIOptions(buildProviderOptions("openai:gpt-6-astra", "off"))).toMatchObject({
        reasoningEffort: "low",
      });
    });

    test("preserves native max on the chatCompletions wire format", () => {
      const result = buildProviderOptions("openai:gpt-6-astra", "max", undefined, undefined, {
        openai: { wireFormat: "chatCompletions" },
      });
      expect(getOpenAIOptions(result)?.reasoningEffort).toBe("max");
    });

    test("degrades max to xhigh and keeps the low clamp through the Copilot-routed gateway", () => {
      const build = (level: Parameters<typeof buildProviderOptions>[1]) =>
        buildProviderOptions(
          "openai:gpt-6-astra",
          level,
          undefined,
          undefined,
          undefined,
          undefined,
          undefined,
          undefined,
          "github-copilot"
        );
      expect(build("max")).toEqual({ "github-copilot": { reasoningEffort: "xhigh" } });
      expect(build("off")).toEqual({ "github-copilot": { reasoningEffort: "low" } });
    });

    test("delivers pro mode independently of effort on the direct Responses route", () => {
      const result = buildProviderOptions(
        "openai:gpt-6-astra",
        "max",
        undefined,
        undefined,
        undefined,
        undefined,
        undefined,
        undefined,
        undefined,
        undefined,
        "pro"
      );
      const openai = getOpenAIOptions(result);
      expect(openai?.reasoningEffort).toBe("max");
      expect(openai?.reasoningMode).toBe("pro");
    });

    test("resolves mapped aliases to Astra for the native effort mapping", () => {
      const providersConfig = createMockProvidersConfig({
        "openai:team-astra": "openai:gpt-6-astra",
      });
      const build = (level: Parameters<typeof buildProviderOptions>[1]) =>
        getOpenAIOptions(
          buildProviderOptions(
            "openai:team-astra",
            level,
            undefined,
            undefined,
            undefined,
            undefined,
            undefined,
            providersConfig
          )
        );
      expect(build("max")?.reasoningEffort).toBe("max");
      expect(build("off")?.reasoningEffort).toBe("low");
    });

    test("keeps named Astra variants on the legacy OpenAI mapping", () => {
      expect(
        getOpenAIOptions(buildProviderOptions("openai:gpt-6-astra-mini", "max"))
      ).toMatchObject({ reasoningEffort: "xhigh" });
      expect(
        getOpenAIOptions(buildProviderOptions("openai:gpt-6-astra-mini", "off"))?.reasoningEffort
      ).toBeUndefined();
    });
  });

  describe("GPT-5.6 explicit prompt caching serialization", () => {
    // Production-path wire test: createOpenAI + capture fetch + streamText
    // (the same streaming parser Xum uses), not intermediate TS objects.
    const providersConfig: ProvidersConfigMap = {
      openai: { apiKeySet: true, isEnabled: true, isConfigured: true },
    };

    function sseResponse(events: unknown[]): Response {
      const body =
        events.map((event) => `data: ${JSON.stringify(event)}\n\n`).join("") + "data: [DONE]\n\n";
      return new Response(body, {
        status: 200,
        headers: { "content-type": "text/event-stream" },
      });
    }

    // Synthetic usage: 1200 input = 48 uncached + 1024 cache-read + 128 cache-write.
    const responsesSse = [
      {
        type: "response.created",
        response: { id: "resp_1", created_at: 0, model: "gpt-5.6-luna" },
      },
      {
        type: "response.completed",
        response: {
          usage: {
            input_tokens: 1200,
            input_tokens_details: { cached_tokens: 1024, cache_write_tokens: 128 },
            output_tokens: 5,
            output_tokens_details: { reasoning_tokens: 0 },
          },
        },
      },
    ];
    const chatCompletionsSse = [
      {
        id: "chat_1",
        object: "chat.completion.chunk",
        created: 0,
        model: "gpt-5.6-luna",
        choices: [{ index: 0, delta: { role: "assistant", content: "ok" }, finish_reason: null }],
      },
      {
        id: "chat_1",
        object: "chat.completion.chunk",
        created: 0,
        model: "gpt-5.6-luna",
        choices: [{ index: 0, delta: {}, finish_reason: "stop" }],
        usage: {
          prompt_tokens: 1200,
          completion_tokens: 5,
          total_tokens: 1205,
          prompt_tokens_details: { cached_tokens: 1024, cache_write_tokens: 128 },
        },
      },
    ];

    test("serializes the breakpoint and cache key without disabling implicit mode on both wire formats", async () => {
      const capturedBodies: Array<Record<string, unknown>> = [];
      const captureFetch = Object.assign(
        (
          input: Parameters<typeof fetch>[0],
          init?: Parameters<typeof fetch>[1]
        ): Promise<Response> => {
          if (typeof init?.body !== "string") {
            throw new Error("Expected the OpenAI provider to send a JSON string body");
          }
          capturedBodies.push(JSON.parse(init.body) as Record<string, unknown>);
          const url =
            typeof input === "string" ? input : input instanceof URL ? input.toString() : input.url;
          return Promise.resolve(
            sseResponse(url.endsWith("/responses") ? responsesSse : chatCompletionsSse)
          );
        },
        { preconnect: fetch.preconnect.bind(fetch) }
      );
      const openai = createOpenAI({ apiKey: "test", fetch: captureFetch });

      // Production system-message shape from the cache strategy helper.
      const cachedSystem = createOpenAICachedSystemMessage(
        "You are Xum.",
        "openai:gpt-5.6-luna",
        "openai",
        providersConfig
      );
      if (!cachedSystem) {
        throw new Error("Expected an eligible cached system message");
      }

      const responsesOptions = getOpenAIOptions(
        buildProviderOptions(
          "openai:gpt-5.6-luna",
          "medium",
          undefined,
          undefined,
          undefined,
          "workspace-1",
          undefined,
          providersConfig,
          "openai",
          "test-scope"
        )
      );
      const chatOptions = getOpenAIOptions(
        buildProviderOptions(
          "openai:gpt-5.6-luna",
          "medium",
          undefined,
          undefined,
          { openai: { wireFormat: "chatCompletions" } },
          "workspace-1",
          undefined,
          providersConfig,
          "openai",
          "test-scope"
        )
      );
      if (!responsesOptions || !chatOptions) {
        throw new Error("Expected OpenAI provider options for both wire formats");
      }

      const responsesResult = streamText({
        model: openai.responses("gpt-5.6-luna"),
        system: cachedSystem,
        prompt: "hi",
        providerOptions: { openai: responsesOptions },
        maxRetries: 0,
      });
      for await (const _part of responsesResult.fullStream) {
        // Fully consume the stream so usage resolves through the SSE parser.
      }
      const responsesUsage = await responsesResult.usage;

      const chatResult = streamText({
        model: openai.chat("gpt-5.6-luna"),
        system: cachedSystem,
        prompt: "hi",
        providerOptions: { openai: chatOptions },
        maxRetries: 0,
      });
      for await (const _part of chatResult.fullStream) {
        // Fully consume the stream so usage resolves through the SSE parser.
      }
      const chatUsage = await chatResult.usage;

      // Responses wire format: input_text block carrying the breakpoint.
      const responsesBody = capturedBodies[0];
      const responsesInput = responsesBody.input as Array<Record<string, unknown>>;
      const responsesSystem = responsesInput.find(
        (message) => message.role === "system" || message.role === "developer"
      );
      expect(responsesSystem?.content).toEqual([
        {
          type: "input_text",
          text: "You are Xum.",
          prompt_cache_breakpoint: { mode: "explicit" },
        },
      ]);
      expect(responsesBody.prompt_cache_key).toBe("mux-v1-test-scope");
      expect(responsesBody.prompt_cache_options).toBeUndefined();

      // Chat Completions wire format: text block carrying the breakpoint.
      const chatBody = capturedBodies[1];
      const chatMessages = chatBody.messages as Array<Record<string, unknown>>;
      const chatSystem = chatMessages.find(
        (message) => message.role === "system" || message.role === "developer"
      );
      expect(chatSystem?.content).toEqual([
        {
          type: "text",
          text: "You are Xum.",
          prompt_cache_breakpoint: { mode: "explicit" },
        },
      ]);
      expect(chatBody.prompt_cache_key).toBe("mux-v1-test-scope");
      expect(chatBody.prompt_cache_options).toBeUndefined();

      // Both parsers expose cache reads and writes on nested v7 usage details.
      expect(responsesUsage.inputTokenDetails?.cacheReadTokens).toBe(1024);
      expect(responsesUsage.inputTokenDetails?.cacheWriteTokens).toBe(128);
      expect(chatUsage.inputTokenDetails?.cacheReadTokens).toBe(1024);
      expect(chatUsage.inputTokenDetails?.cacheWriteTokens).toBe(128);
    });
  });

  describe("OpenAI conversation state management", () => {
    test("does not reuse previousResponseId when Xum already sends explicit GPT-5.5 history", () => {
      const messages = [
        createMuxMessage("assistant-1", "assistant", "", {
          model: "mux-gateway:openai/gpt-5.5",
          providerMetadata: { openai: { responseId: "resp_123" } },
        }),
      ];
      const result = buildProviderOptions("mux-gateway:openai/gpt-5.5", "medium", messages);
      const openai = getOpenAIOptions(result);

      expect(openai).toBeDefined();
      expect(openai!.previousResponseId).toBeUndefined();
    });
  });
  describe("wireFormat gating", () => {
    test("includes Responses-only fields by default when wireFormat is unset", () => {
      const result = buildProviderOptions(
        "openai:gpt-5.2",
        "off",
        undefined,
        undefined,
        undefined,
        "workspace-default"
      );
      const openai = getOpenAIOptions(result);

      expect(openai).toBeDefined();
      expect(openai!.truncation).toBe("disabled");
      expect(openai!.promptCacheKey).toBe("mux-v1-workspace-default");
    });

    test("includes Responses-only fields when wireFormat is responses", () => {
      const result = buildProviderOptions(
        "openai:gpt-5.2",
        "off",
        undefined,
        undefined,
        {
          openai: { wireFormat: "responses" },
        },
        "workspace-responses"
      );
      const openai = getOpenAIOptions(result);

      expect(openai).toBeDefined();
      expect(openai!.truncation).toBe("disabled");
      expect(openai!.promptCacheKey).toBe("mux-v1-workspace-responses");
    });

    test("omits Responses-only truncation and promptCacheKey when wireFormat is chatCompletions", () => {
      const result = buildProviderOptions(
        "openai:gpt-5.2",
        "off",
        undefined,
        undefined,
        {
          openai: { wireFormat: "chatCompletions" },
        },
        "workspace-chat"
      );
      const openai = getOpenAIOptions(result);

      expect(openai).toBeDefined();
      expect(openai!.truncation).toBeUndefined();
      expect(openai!.promptCacheKey).toBeUndefined();
    });

    test("omits previousResponseId when wireFormat is chatCompletions", () => {
      const messages = [
        createMuxMessage("assistant-1", "assistant", "", {
          model: "openai:gpt-5.2",
          providerMetadata: { openai: { responseId: "resp_chat_123" } },
        }),
      ];
      const result = buildProviderOptions("openai:gpt-5.2", "medium", messages, undefined, {
        openai: { wireFormat: "chatCompletions" },
      });
      const openai = getOpenAIOptions(result);

      expect(openai).toBeDefined();
      expect(openai!.previousResponseId).toBeUndefined();
    });

    test("omits Responses-only reasoning fields but keeps reasoningEffort when wireFormat is chatCompletions", () => {
      const result = buildProviderOptions("openai:gpt-5.2", "medium", undefined, undefined, {
        openai: { wireFormat: "chatCompletions" },
      });
      const openai = getOpenAIOptions(result);

      expect(openai).toBeDefined();
      expect(openai!.reasoningEffort).toBe("medium");
      expect(openai!.reasoningSummary).toBeUndefined();
      expect(openai!.include).toBeUndefined();
    });
  });
});

describe("buildProviderOptions - Google", () => {
  test("maps Gemini 3.5 Flash off to minimal thinking without thoughts", () => {
    expect(buildProviderOptions("google:gemini-3.5-flash", "off")).toEqual({
      google: {
        thinkingConfig: {
          thinkingLevel: "minimal",
        },
      },
    });
  });

  test("maps gateway Gemini 3.5 Flash off to minimal thinking without thoughts", () => {
    expect(buildProviderOptions("mux-gateway:google/gemini-3.5-flash", "off")).toEqual({
      google: {
        thinkingConfig: {
          thinkingLevel: "minimal",
        },
      },
    });
  });

  test("maps namespaced Gemini 3.5 Flash off to minimal thinking without thoughts", () => {
    expect(buildProviderOptions("google:models/gemini-3.5-flash", "off")).toEqual({
      google: {
        thinkingConfig: {
          thinkingLevel: "minimal",
        },
      },
    });
  });

  test("maps versioned Gemini 3.5 Flash off to minimal thinking without thoughts", () => {
    expect(buildProviderOptions("google:gemini-3.5-flash-001", "off")).toEqual({
      google: {
        thinkingConfig: {
          thinkingLevel: "minimal",
        },
      },
    });
  });

  test("maps Gemini 3.6 Flash off to minimal thinking without thoughts", () => {
    expect(buildProviderOptions("google:gemini-3.6-flash", "off")).toEqual({
      google: {
        thinkingConfig: {
          thinkingLevel: "minimal",
        },
      },
    });
  });

  test("maps Gemini 3.6 Flash medium to thinkingLevel medium with thoughts", () => {
    expect(buildProviderOptions("google:gemini-3.6-flash", "medium")).toEqual({
      google: {
        thinkingConfig: {
          includeThoughts: true,
          thinkingLevel: "medium",
        },
      },
    });
  });

  test("maps Gemini 3.7 Flash off to minimal thinking without thoughts", () => {
    expect(buildProviderOptions("google:gemini-3.7-flash", "off")).toEqual({
      google: {
        thinkingConfig: {
          thinkingLevel: "minimal",
        },
      },
    });
  });

  test("maps Gemini 3.7 Flash medium to thinkingLevel medium with thoughts", () => {
    expect(buildProviderOptions("google:gemini-3.7-flash", "medium")).toEqual({
      google: {
        thinkingConfig: {
          includeThoughts: true,
          thinkingLevel: "medium",
        },
      },
    });
  });

  test("clamps Gemini 3.8 Flash off to low thinking because the API rejects minimal", () => {
    // Policy already excludes "off" for 3.8 Flash; this guards callers that bypass it.
    expect(buildProviderOptions("google:gemini-3.8-flash", "off")).toEqual({
      google: {
        thinkingConfig: {
          includeThoughts: true,
          thinkingLevel: "low",
        },
      },
    });
    // Older Flash tiers keep the minimal mapping.
    expect(buildProviderOptions("google:gemini-3.7-flash", "off")).toEqual({
      google: { thinkingConfig: { thinkingLevel: "minimal" } },
    });
  });

  test("maps Gemini 3.8 Flash low/medium/high to the matching thinkingLevel with thoughts", () => {
    for (const level of ["low", "medium", "high"] as const) {
      expect(buildProviderOptions("google:gemini-3.8-flash", level)).toEqual({
        google: {
          thinkingConfig: {
            includeThoughts: true,
            thinkingLevel: level,
          },
        },
      });
    }
  });

  test("maps gateway-routed Gemini 3.8 Flash to thinkingLevel config", () => {
    expect(buildProviderOptions("mux-gateway:google/gemini-3.8-flash", "high")).toEqual({
      google: {
        thinkingConfig: {
          includeThoughts: true,
          thinkingLevel: "high",
        },
      },
    });
  });

  test("maps Gemini 3.5 Flash medium to thinkingLevel medium with thoughts", () => {
    expect(buildProviderOptions("mux-gateway:google/gemini-3.5-flash", "medium")).toEqual({
      google: {
        thinkingConfig: {
          includeThoughts: true,
          thinkingLevel: "medium",
        },
      },
    });
  });

  test("uses mapped model capabilities for custom Gemini 3.5 Flash aliases", () => {
    const providersConfig = createMockProvidersConfig({
      "google:custom-flash": "google:gemini-3.5-flash",
    });

    expect(
      buildProviderOptions(
        "google:custom-flash",
        "off",
        undefined,
        undefined,
        undefined,
        undefined,
        undefined,
        providersConfig
      )
    ).toEqual({
      google: {
        thinkingConfig: {
          thinkingLevel: "minimal",
        },
      },
    });
  });

  test("maps non-preview Gemini 3 Flash off to minimal thinking without thoughts", () => {
    expect(buildProviderOptions("google:gemini-3-flash", "off")).toEqual({
      google: {
        thinkingConfig: {
          thinkingLevel: "minimal",
        },
      },
    });
  });

  test("maps Gemini 3 Flash Preview off to minimal thinking without thoughts", () => {
    expect(buildProviderOptions("google:gemini-3-flash-preview", "off")).toEqual({
      google: {
        thinkingConfig: {
          thinkingLevel: "minimal",
        },
      },
    });
  });

  test("maps versioned Gemini 3 Flash Preview off to minimal thinking without thoughts", () => {
    expect(buildProviderOptions("google:gemini-3-flash-preview-latest", "off")).toEqual({
      google: {
        thinkingConfig: {
          thinkingLevel: "minimal",
        },
      },
    });
  });

  test("defensively maps unsupported Gemini 3.5 Flash xhigh to high", () => {
    expect(buildProviderOptions("google:gemini-3.5-flash", "xhigh")).toEqual({
      google: {
        thinkingConfig: {
          includeThoughts: true,
          thinkingLevel: "high",
        },
      },
    });
  });

  test("passes Gemini 3.1 Pro low through as thinkingLevel low with thoughts", () => {
    expect(buildProviderOptions("google:gemini-3.1-pro-preview", "low")).toEqual({
      google: {
        thinkingConfig: {
          includeThoughts: true,
          thinkingLevel: "low",
        },
      },
    });
  });

  test("defensively maps unsupported Gemini 3.5 Flash max to high", () => {
    expect(buildProviderOptions("google:gemini-3.5-flash", "max")).toEqual({
      google: {
        thinkingConfig: {
          includeThoughts: true,
          thinkingLevel: "high",
        },
      },
    });
  });

  test("keeps Gemini 3.1 Pro off without provider thinking config", () => {
    expect(buildProviderOptions("google:gemini-3.1-pro-preview", "off")).toEqual({
      google: {
        thinkingConfig: undefined,
      },
    });
  });
});

describe("buildProviderOptions - Moonshot", () => {
  test("sends the explicit max reasoning effort for direct Kimi K3", () => {
    expect(buildProviderOptions("moonshotai:kimi-k3", "max")).toEqual({
      moonshotai: { reasoningEffort: "max" },
    });
  });

  test("emits no provider options for other Moonshot models", () => {
    expect(buildProviderOptions("moonshotai:kimi-k2.5", "medium")).toEqual({});
  });
});

describe("buildProviderOptions - Z.ai", () => {
  test("enables thinking and maps every GLM 5.3 policy level", () => {
    for (const [level, reasoningEffort] of [
      ["low", "low"],
      ["high", "high"],
      ["max", "max"],
    ] as const) {
      expect(buildProviderOptions("zai:glm-5.3-flash", level)).toEqual({
        zai: {
          thinking: { type: "enabled" },
          reasoningEffort,
          toolStream: true,
        },
      });
    }
  });

  test("does not apply forced GLM 5.3 options to other Z.ai models", () => {
    expect(buildProviderOptions("zai:glm-4.7-flash", "high")).toEqual({});
  });
});

describe("buildProviderOptions - OpenRouter", () => {
  test("sends the explicit max effort for OpenRouter-routed Kimi K3", () => {
    // `enabled: true` alone falls back to OpenRouter's default (medium) effort,
    // which K3 does not support, so the effort must be sent explicitly.
    const result = buildProviderOptions(
      "moonshotai:kimi-k3",
      "max",
      undefined,
      undefined,
      undefined,
      undefined,
      undefined,
      undefined,
      "openrouter"
    );
    expect(result).toEqual({
      openrouter: {
        reasoning: {
          enabled: true,
          effort: "max",
          exclude: false,
        },
      },
    });
  });

  test("maps thinking levels to effort for other OpenRouter reasoning models", () => {
    expect(buildProviderOptions("openrouter:z-ai/glm-4.6", "medium")).toEqual({
      openrouter: {
        reasoning: {
          enabled: true,
          effort: "medium",
          exclude: false,
        },
      },
    });

    expect(buildProviderOptions("openrouter:z-ai/glm-4.6", "off")).toEqual({});
  });
});

describe("buildProviderOptions - xAI", () => {
  test("maps Grok 4.5 thinking levels to reasoning effort without deprecated search defaults", () => {
    // store:false is the default so ZDR and non-ZDR orgs share one request path.
    expect(buildProviderOptions("xai:grok-4.5", "medium")).toEqual({
      xai: { reasoningEffort: "medium", store: false },
    });
    expect(buildProviderOptions("xai:grok-4.5", "max")).toEqual({
      xai: { reasoningEffort: "high", store: false },
    });
  });

  test("passes native xhigh through for Grok 4.6 while Grok 4.5 clamps to high", () => {
    expect(buildProviderOptions("xai:grok-4.6", "xhigh")).toEqual({
      xai: { reasoningEffort: "xhigh", store: false },
    });
    expect(buildProviderOptions("xai:grok-4.6", "max")).toEqual({
      xai: { reasoningEffort: "xhigh", store: false },
    });
    expect(buildProviderOptions("xai:grok-4.6", "medium")).toEqual({
      xai: { reasoningEffort: "medium", store: false },
    });
    expect(buildProviderOptions("xai:grok-4.5", "xhigh")).toEqual({
      xai: { reasoningEffort: "high", store: false },
    });
  });

  test("omits deprecated search parameters and strips service tier from Grok 4.5 SDK options", () => {
    expect(
      buildProviderOptions("xai:grok-4.5", "high", undefined, undefined, {
        xai: {
          serviceTier: "priority",
          searchParameters: { mode: "off" },
        },
      })
    ).toEqual({
      xai: {
        reasoningEffort: "high",
        store: false,
      },
    });
  });

  test("defaults Grok 4.5 store to false without an explicit override", () => {
    expect(
      buildProviderOptions("xai:grok-4.5", "medium", undefined, undefined, { xai: {} })
    ).toEqual({
      xai: {
        reasoningEffort: "medium",
        store: false,
      },
    });
  });

  test("allows explicit store: true escape hatch on Grok 4.5", () => {
    expect(
      buildProviderOptions("xai:grok-4.5", "medium", undefined, undefined, {
        xai: { store: true },
      })
    ).toEqual({
      xai: {
        reasoningEffort: "medium",
        store: true,
      },
    });
  });

  test("does not force store on legacy non-Grok-4.5 xAI chat models", () => {
    const result = buildProviderOptions("xai:grok-4-1-fast", "off");
    const xai = (result as { xai?: Record<string, unknown> }).xai;
    expect(xai).toBeDefined();
    expect("store" in xai!).toBe(false);
  });
});

describe("buildRequestHeaders", () => {
  for (const { name, model, options, expected } of [
    {
      name: "should return anthropic-beta header for beta-only Sonnet models with use1MContext",
      model: "anthropic:claude-sonnet-4-5",
      options: { anthropic: { use1MContext: true } },
      expected: { "anthropic-beta": ANTHROPIC_1M_CONTEXT_HEADER },
    },
    {
      name: "should return anthropic-beta header for gateway-routed beta Anthropic model",
      model: "mux-gateway:anthropic/claude-sonnet-4-5",
      options: { anthropic: { use1MContext: true } },
      expected: { "anthropic-beta": ANTHROPIC_1M_CONTEXT_HEADER },
    },
    {
      name: "should return undefined for native 1M Anthropic models even when use1MContext is set",
      model: "anthropic:claude-opus-4-6",
      options: { anthropic: { use1MContext: true } },
      expected: undefined,
    },
    {
      name: "should return undefined when disableBetaFeatures is true even with use1MContext",
      model: "anthropic:claude-sonnet-4-5",
      options: { anthropic: { use1MContext: true, disableBetaFeatures: true } },
      expected: undefined,
    },
    {
      name: "should still return header when disableBetaFeatures is false",
      model: "anthropic:claude-sonnet-4-5",
      options: { anthropic: { use1MContext: true, disableBetaFeatures: false } },
      expected: { "anthropic-beta": ANTHROPIC_1M_CONTEXT_HEADER },
    },
    {
      name: "should return undefined for non-Anthropic model",
      model: "openai:gpt-5.2",
      options: { anthropic: { use1MContext: true } },
      expected: undefined,
    },
    {
      name: "should return undefined when use1MContext is false",
      model: "anthropic:claude-sonnet-4-5",
      options: { anthropic: { use1MContext: false } },
      expected: undefined,
    },
    {
      name: "should return undefined for unsupported model even with use1MContext",
      model: "anthropic:claude-opus-4-1",
      options: { anthropic: { use1MContext: true } },
      expected: undefined,
    },
    {
      name: "should return header when model is in use1MContextModels list",
      model: "anthropic:claude-sonnet-4-5",
      options: { anthropic: { use1MContextModels: ["anthropic:claude-sonnet-4-5"] } },
      expected: { "anthropic-beta": ANTHROPIC_1M_CONTEXT_HEADER },
    },
  ] as const) {
    test(name, () => {
      expect(
        buildRequestHeaders(model, options as Parameters<typeof buildRequestHeaders>[1])
      ).toEqual(expected);
    });
  }

  // Native xhigh effort no longer needs a Xum-internal override header: the
  // SDK accepts effort "xhigh" directly (see buildProviderOptions tests above),
  // so buildRequestHeaders is thinking-level-independent.
  test("does not emit any Xum-internal effort header for native-xhigh models", () => {
    expect(buildRequestHeaders("anthropic:claude-opus-4-7")).toBeUndefined();
    expect(buildRequestHeaders("anthropic:claude-sonnet-5")).toBeUndefined();
  });

  describe("openaiDirectProviderOptionsAvailable", () => {
    test("allows fast mode for direct OpenAI models without requiring Pro capability", () => {
      expect(
        openaiDirectProviderOptionsAvailable("openai:gpt-5.5-pro", {
          resolvedRouteProvider: "direct",
        })
      ).toBe(true);
      expect(
        openaiDirectProviderOptionsAvailable("anthropic:claude-opus-4-8", {
          resolvedRouteProvider: "direct",
        })
      ).toBe(false);
    });

    test("fails closed for gateways and Codex OAuth routes", () => {
      expect(
        openaiDirectProviderOptionsAvailable("openai:gpt-5.5-pro", {
          resolvedRouteProvider: "openrouter",
        })
      ).toBe(false);
      expect(
        openaiDirectProviderOptionsAvailable("openrouter:openai/gpt-5.5-pro", {
          providersConfig: {
            openai: { apiKeySet: true, isEnabled: true, isConfigured: true },
            openrouter: { apiKeySet: true, isEnabled: true, isConfigured: true },
          },
          resolvedRouteProvider: "direct",
        })
      ).toBe(false);
      expect(
        openaiDirectProviderOptionsAvailable("openai:gpt-5.6-sol", {
          providersConfig: {
            openai: {
              apiKeySet: false,
              codexOauthSet: true,
              isEnabled: true,
              isConfigured: true,
            },
          },
          resolvedRouteProvider: "direct",
        })
      ).toBe(false);
    });
  });

  describe("openaiProModeAvailable", () => {
    // UI gating must mirror provider-option delivery: direct OpenAI and Coder
    // Responses surface the toggle; other gateways still drop or reject it.
    const cases: Array<[string, boolean]> = [
      ["openai:gpt-5.6-sol", true],
      ["openai:gpt-5.6-terra", true],
      // Pro mode is family-wide at GA (including Luna and the bare alias).
      ["openai:gpt-5.6-luna", true],
      ["openai:gpt-5.6", true],
      ["openai:gpt-6-astra", true],
      ["openai:gpt-6-astra-2026-09-03", true],
      ["mux-gateway:openai/gpt-6-astra", false],
      ["openai:gpt-6-astra-mini", false],
      // Other gateways fail closed — mux-gateway drops the field server-side.
      ["mux-gateway:openai/gpt-5.6-sol", false],
      ["openrouter:openai/gpt-5.6-sol", false],
      ["github-copilot:gpt-5.6-sol", false],
      // Non-pro-capable models.
      ["openai:gpt-5.5-pro", false],
      ["anthropic:claude-opus-4-8", false],
      ["", false],
    ];

    for (const [model, expected] of cases) {
      test(`${JSON.stringify(model)} -> ${expected}`, () => {
        expect(openaiProModeAvailable(model)).toBe(expected);
      });
    }

    // Explicit gateway prefixes hide the toggle only while that gateway can
    // win the route. When the gateway is disabled/unconfigured the backend
    // (resolveModelString) falls back to the settings-resolved route, which
    // may be direct OpenAI — where the send path delivers pro mode.
    describe("explicit gateway prefix with route fallback", () => {
      const openaiDirect = {
        apiKeySet: true,
        isEnabled: true,
        isConfigured: true,
      };

      test("fails closed while the explicit gateway is configured and enabled", () => {
        const providersConfig: ProvidersConfigMap = {
          openai: openaiDirect,
          openrouter: { apiKeySet: true, isEnabled: true, isConfigured: true },
        };
        expect(
          openaiProModeAvailable("openrouter:openai/gpt-5.6-sol", {
            providersConfig,
            resolvedRouteProvider: "direct",
          })
        ).toBe(false);
      });

      test("allows pro mode when the gateway is unavailable and the route falls back to direct", () => {
        // openrouter absent from config (unconfigured) — backend routing falls
        // back to direct OpenAI, so the toggle must stay visible.
        const unconfigured: ProvidersConfigMap = { openai: openaiDirect };
        expect(
          openaiProModeAvailable("openrouter:openai/gpt-5.6-sol", {
            providersConfig: unconfigured,
            resolvedRouteProvider: "direct",
          })
        ).toBe(true);

        // Disabled gateway behaves the same as unconfigured.
        const disabled: ProvidersConfigMap = {
          openai: openaiDirect,
          openrouter: { apiKeySet: true, isEnabled: false, isConfigured: true },
        };
        expect(
          openaiProModeAvailable("openrouter:openai/gpt-5.6-sol", {
            providersConfig: disabled,
            resolvedRouteProvider: "direct",
          })
        ).toBe(true);
      });

      test("still fails closed when the fallback route is another gateway", () => {
        const providersConfig: ProvidersConfigMap = { openai: openaiDirect };
        expect(
          openaiProModeAvailable("openrouter:openai/gpt-5.6-sol", {
            providersConfig,
            resolvedRouteProvider: "mux-gateway",
          })
        ).toBe(false);
      });
    });

    // Mapped aliases (models: [{ id, mappedToModel }]) inherit pro capability
    // from their target via resolveModelForMetadata, matching the send path.
    test("mapped aliases inherit pro capability from their target", () => {
      const providersConfig = createMockProvidersConfig({
        "openai:team-sol": "openai:gpt-5.6-sol",
        "openai:team-pro": "openai:gpt-5.5-pro",
      });

      expect(openaiProModeAvailable("openai:team-sol", { providersConfig })).toBe(true);
      // Targets without pro capability stay hidden.
      expect(openaiProModeAvailable("openai:team-pro", { providersConfig })).toBe(false);
      // Without a mapping the custom id fails closed.
      expect(openaiProModeAvailable("openai:team-sol")).toBe(false);
    });

    // Pro mode is Responses-only: chatCompletions wire format disables it even
    // for pro-capable models on passthrough routes.
    test("chatCompletions wire format disables pro mode", () => {
      expect(
        openaiProModeAvailable("openai:gpt-5.6-sol", { openaiWireFormat: "chatCompletions" })
      ).toBe(false);
      expect(openaiProModeAvailable("openai:gpt-5.6-sol", { openaiWireFormat: "responses" })).toBe(
        true
      );
      expect(openaiProModeAvailable("openai:gpt-5.6-sol", { openaiWireFormat: null })).toBe(true);
    });

    // Canonical model strings can be routed to a non-passthrough gateway by
    // routing settings; the resolved route must gate availability like the
    // send path gates the header.
    test("settings-resolved route gates canonical model strings", () => {
      const route = (r: string) =>
        openaiProModeAvailable("openai:gpt-5.6-sol", { resolvedRouteProvider: r });
      expect(route("direct")).toBe(true);
      // mux-gateway drops the field server-side today — fail closed.
      expect(route("mux-gateway")).toBe(false);
      expect(route("openrouter")).toBe(false);
      expect(route("github-copilot")).toBe(false);
      // Unknown route names fail closed.
      expect(route("some-future-gateway")).toBe(false);
    });

    // Codex OAuth routes compose the fetch wrapper with inject:false (the
    // ChatGPT backend is stricter than the public API), so when OAuth is the
    // effective auth path pro mode must be unavailable.
    test("Codex OAuth as the effective auth path disables pro mode", () => {
      const withOpenAI = (openai: Partial<NonNullable<ProvidersConfigMap["openai"]>>) =>
        openaiProModeAvailable("openai:gpt-5.6-sol", {
          providersConfig: {
            openai: { isEnabled: true, isConfigured: true, apiKeySet: false, ...openai },
          },
        });

      // OAuth-only: routes through Codex OAuth.
      expect(withOpenAI({ apiKeySet: false, codexOauthSet: true })).toBe(false);
      // Both auth methods, default prefers OAuth (unset -> oauth).
      expect(withOpenAI({ apiKeySet: true, codexOauthSet: true })).toBe(false);
      // Both auth methods, user prefers the API key: pro stays available.
      expect(
        withOpenAI({ apiKeySet: true, codexOauthSet: true, codexOauthDefaultAuth: "apiKey" })
      ).toBe(true);
      // API key only: no OAuth routing.
      expect(withOpenAI({ apiKeySet: true, codexOauthSet: false })).toBe(true);
    });
  });

  for (const { name, model, options, workspaceId, expected } of [
    {
      name: "should include X-Mux-Workspace-Id for non-Anthropic provider when workspaceId provided",
      model: "openai:gpt-5.2",
      options: undefined,
      workspaceId: "a1b2c3d4e5",
      expected: { [MUX_WORKSPACE_ID_HEADER]: "a1b2c3d4e5" },
    },
    {
      name: "should include X-Mux-Workspace-Id for mux-gateway routes",
      model: "mux-gateway:openai/gpt-5.2",
      options: undefined,
      workspaceId: "a1b2c3d4e5",
      expected: { [MUX_WORKSPACE_ID_HEADER]: "a1b2c3d4e5" },
    },
    {
      name: "should encode non-header-safe workspace IDs before attaching request header",
      model: "openai:gpt-5.2",
      options: undefined,
      workspaceId: "workspace-😀",
      expected: {
        [MUX_WORKSPACE_ID_HEADER]: `b64:${Buffer.from("workspace-😀", "utf8").toString("base64url")}`,
      },
    },
    {
      name: "should include both X-Mux-Workspace-Id and anthropic-beta when both apply",
      model: "anthropic:claude-sonnet-4-20250514",
      options: { anthropic: { use1MContext: true } },
      workspaceId: "a1b2c3d4e5",
      expected: {
        [MUX_WORKSPACE_ID_HEADER]: "a1b2c3d4e5",
        "anthropic-beta": ANTHROPIC_1M_CONTEXT_HEADER,
      },
    },
    {
      name: "should include X-Mux-Workspace-Id but not anthropic-beta for Anthropic without beta 1M intent",
      model: "anthropic:claude-sonnet-4-20250514",
      options: undefined,
      workspaceId: "deadbeef00",
      expected: { [MUX_WORKSPACE_ID_HEADER]: "deadbeef00" },
    },
  ] as const) {
    test(name, () => {
      const headers = buildRequestHeaders(model, options, workspaceId);
      expect(headers).toEqual(expected);
      expect(headers?.["X-Xum-Workspace-Id"]).toBeUndefined();
    });
  }

  test("workspace correlation header uses the mux wire name, not Xum", () => {
    expect(MUX_WORKSPACE_ID_HEADER).toBe("X-Mux-Workspace-Id");
    const headers = buildRequestHeaders("openai:gpt-5.2", undefined, "ws-id");
    expect(headers?.["X-Mux-Workspace-Id"]).toBe("ws-id");
    expect(headers?.["X-Xum-Workspace-Id"]).toBeUndefined();
  });

  test("should return undefined when no workspaceId and no provider-specific headers apply", () => {
    expect(buildRequestHeaders("openai:gpt-5.2")).toBeUndefined();
  });

  test("should return undefined when no muxProviderOptions provided", () => {
    expect(buildRequestHeaders("anthropic:claude-sonnet-4-5")).toBeUndefined();
  });
});

describe("custom provider wire origins", () => {
  const customConfig = (
    providerType: "openai-compatible" | "openai-responses" | "anthropic-messages"
  ): ProvidersConfigMap => ({
    zen: {
      apiKeySet: true,
      isEnabled: true,
      isConfigured: true,
      isCustom: true,
      providerType,
    },
  });

  test("anthropic-messages providers get Anthropic thinking options", () => {
    const result = buildProviderOptions(
      "zen:claude-sonnet-4-5",
      "medium",
      undefined,
      undefined,
      undefined,
      undefined,
      undefined,
      customConfig("anthropic-messages")
    );

    expect(result).toEqual({
      anthropic: {
        disableParallelToolUse: false,
        sendReasoning: true,
        thinking: {
          type: "enabled",
          budgetTokens: 10000,
        },
      },
    });
  });

  test("openai-responses providers get OpenAI reasoning options", () => {
    const result = buildProviderOptions(
      "zen:gpt-5",
      "medium",
      undefined,
      undefined,
      undefined,
      undefined,
      undefined,
      customConfig("openai-responses")
    );

    const openai = "openai" in result ? result.openai : undefined;
    expect(openai).toBeDefined();
    expect(openai!.reasoningEffort).toBe("medium");
    expect("anthropic" in result).toBe(false);
  });

  test("resolves mappedToModel aliases from the raw custom identity", () => {
    const providersConfig: ProvidersConfigMap = {
      zen: {
        apiKeySet: true,
        isEnabled: true,
        isConfigured: true,
        isCustom: true,
        providerType: "anthropic-messages",
        models: [{ id: "my-opus", mappedToModel: "anthropic:claude-opus-4-6-20260219" }],
      },
    };

    const result = buildProviderOptions(
      "zen:my-opus",
      "high",
      undefined,
      undefined,
      undefined,
      undefined,
      undefined,
      providersConfig
    );
    const anthropic = (result as Record<string, unknown>).anthropic as Record<string, unknown>;

    // The alias maps to an adaptive-thinking model; resolving metadata from
    // the wire-remapped identity would miss the mapping and emit legacy
    // budget-based thinking instead.
    expect(anthropic.thinking).toEqual({ type: "adaptive" });
    expect(anthropic.effort).toBe("high");
  });

  test("openai-compatible providers keep their own wire identity", () => {
    const result = buildProviderOptions(
      "zen:claude-sonnet-4-5",
      "medium",
      undefined,
      undefined,
      undefined,
      undefined,
      undefined,
      customConfig("openai-compatible")
    );

    expect("anthropic" in result).toBe(false);
    expect("openai" in result).toBe(false);
  });
});

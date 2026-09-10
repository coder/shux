import { describe, expect, test } from "bun:test";
import type { ProvidersConfigMap } from "@/common/orpc/types";
import { KNOWN_MODELS } from "@/common/constants/knownModels";
import { getModelStats, getModelStatsResolved, type ModelStats } from "./modelStats";

const DEFAULT_IMAGE_MODEL = "openai:gpt-image-2";
const PINNED_IMAGE_MODEL = "openai:gpt-image-2-2026-04-21";

function expectStats(modelString: string): ModelStats {
  const stats = getModelStats(modelString);
  expect(stats).not.toBeNull();
  return stats!;
}

describe("getModelStats", () => {
  test("resolves representative known models by canonical id", () => {
    expect(expectStats(KNOWN_MODELS.OPUS.id).max_input_tokens).toBeGreaterThan(0);
    expect(expectStats(KNOWN_MODELS.GPT.id).max_input_tokens).toBeGreaterThan(0);
  });

  test("prefers models-extra overrides over models.json when both sources define a model", () => {
    // gpt-5.2-codex exists in both sources; the 272k context proves the override won.
    expect(expectStats("openai:gpt-5.2-codex").max_input_tokens).toBe(272000);
  });

  test.each([
    ["openai:gpt-5.5-2026-04-23", "openai:gpt-5.5"],
    ["mux-gateway:openai/gpt-5.5-pro-2026-04-23", "openai:gpt-5.5-pro"],
    ["mux-gateway:openai/gpt-5.4-mini-2026-03-11", "openai:gpt-5.4-mini"],
    ["mux-gateway:openai/gpt-5.4-nano-2026-03-17", "openai:gpt-5.4-nano"],
    ["openai:gpt-5.6-sol-2026-07-09", "openai:gpt-5.6-sol"],
  ])("falls back from %s to the published %s family entry", (datedModel, canonicalModel) => {
    expect(expectStats(datedModel)).toEqual(expectStats(canonicalModel));
  });

  test("resolves the bare gpt-5.6 alias to Sol's stats", () => {
    // The bare alias is a servable id that OpenAI routes to Sol; without its
    // own entry, token meters/compaction/pricing would treat it as unknown.
    expect(expectStats("openai:gpt-5.6")).toEqual(expectStats("openai:gpt-5.6-sol"));
  });

  test("resolves Grok 4.6 family aliases and case variants for usage meters", () => {
    const grok = expectStats(KNOWN_MODELS.GROK_46.id);
    expect(grok.max_input_tokens).toBe(500000);
    expect(grok.max_output_tokens).toBeUndefined();
    expect(expectStats("xai:grok-4.6-latest")).toEqual(grok);
    expect(expectStats("XAI:Grok-4.6")).toEqual(grok);
  });

  test("resolves Grok 4.6 pricing with its higher cached-input rate", () => {
    const grok46 = expectStats("xai:grok-4.6");
    expect(grok46.input_cost_per_token).toBe(0.000002);
    expect(grok46.output_cost_per_token).toBe(0.000006);
    expect(grok46.cache_read_input_token_cost).toBe(0.0000005);
    expect(grok46.input_cost_per_token_above_200k_tokens).toBe(0.000004);
    expect(grok46.output_cost_per_token_above_200k_tokens).toBe(0.000012);
    expect(grok46.cache_read_input_token_cost_above_200k_tokens).toBe(0.000001);

    // Grok 4.5 keeps its distinct cheaper cache rate.
    const grok45 = expectStats("xai:grok-4.5");
    expect(grok45.cache_read_input_token_cost).toBe(0.0000003);
  });

  test("keeps mixed-case LiteLLM catalog ids before lowercase fallbacks", () => {
    // models.json ships mixed-case DeepInfra ids; lowercasing the probe key would miss them.
    expect(expectStats("deepinfra:Qwen/Qwen3-14B").max_input_tokens).toBeGreaterThan(0);
  });

  test.each([
    // [model, input, output, cacheRead, cacheCreation]
    ["openai:gpt-5.6-sol", 0.000005, 0.00003, 0.0000005, 0.00000625],
    ["openai:gpt-5.6-terra", 0.000002, 0.000012, 0.0000002, 0.0000025],
    ["openai:gpt-5.6-luna", 0.0000002, 0.0000012, 0.00000002, 0.00000025],
    ["openai:gpt-6-astra", 0.00001, 0.00005, 0.000001, 0.0000125],
  ] as const)(
    "resolves %s with the GA pricing and limits",
    (model, input, output, cacheRead, cacheCreation) => {
      const stats = expectStats(model);
      expect(stats.input_cost_per_token).toBe(input);
      expect(stats.output_cost_per_token).toBe(output);
      expect(stats.cache_read_input_token_cost).toBe(cacheRead);
      expect(stats.cache_creation_input_token_cost).toBe(cacheCreation);
      // GA model pages list a 1.05M context window / 128K max output for every tier
      // (Luna's 400K launch figure was stale and caused premature compaction).
      expect(stats.max_input_tokens).toBe(1050000);
      expect(stats.max_output_tokens).toBe(128000);
      // Long-context tier: >272K prompt tokens bill the full request at 2x
      // input / 1.5x output, with cache writes at 1.25x the active input rate
      // (so 2x their base rate). Assert the multipliers, not fresh constants.
      expect(stats.tiered_pricing_threshold_tokens).toBe(272000);
      expect(stats.input_cost_per_token_above_200k_tokens).toBeCloseTo(input * 2, 12);
      expect(stats.output_cost_per_token_above_200k_tokens).toBeCloseTo(output * 1.5, 12);
      expect(stats.cache_read_input_token_cost_above_200k_tokens).toBeCloseTo(cacheRead * 2, 12);
      expect(stats.cache_creation_input_token_cost_above_200k_tokens).toBeCloseTo(
        cacheCreation * 2,
        12
      );
    }
  );

  test("resolves GPT-6 Astra by alias, dated snapshot, and gateway prefix", () => {
    const astra = expectStats(KNOWN_MODELS.GPT_6_ASTRA.id);
    expect(expectStats("openai:gpt-6-astra-2026-09-30")).toEqual(astra);
    expect(expectStats("mux-gateway:openai/gpt-6-astra")).toEqual(astra);
    // OpenAI has published no Astra variants; do not resolve unknown ids to it.
    expect(getModelStats("openai:gpt-6-astra-mini")).toBeNull();
  });

  test("resolves GPT-5.4 nano with the published limits and pricing", () => {
    const stats = expectStats(KNOWN_MODELS.GPT_54_NANO.id);
    expect(stats.max_input_tokens).toBe(400000);
    expect(stats.max_output_tokens).toBe(128000);
    expect(stats.input_cost_per_token).toBe(0.0000002);
    expect(stats.cache_read_input_token_cost).toBe(0.00000002);
    expect(stats.output_cost_per_token).toBe(0.00000125);
    expect(stats.tiered_pricing_threshold_tokens).toBeUndefined();
  });

  test("resolves Gemini 3.8 Flash with the billed introductory pricing and limits", () => {
    const stats = expectStats(KNOWN_MODELS.GEMINI_FLASH.id);
    expect(stats.max_input_tokens).toBe(1048576);
    expect(stats.max_output_tokens).toBe(65536);
    expect(stats.input_cost_per_token).toBe(0.00000075);
    expect(stats.output_cost_per_token).toBe(0.00000375);
    expect(stats.cache_read_input_token_cost).toBe(0.000000075);
  });

  test("keeps Gemini 3.7 Flash resolvable as a custom model string with its introductory pricing", () => {
    const stats = expectStats("google:gemini-3.7-flash");
    expect(stats.max_input_tokens).toBe(1048576);
    expect(stats.max_output_tokens).toBe(65536);
    expect(stats.input_cost_per_token).toBe(0.00000075);
    expect(stats.output_cost_per_token).toBe(0.00000375);
    expect(stats.cache_read_input_token_cost).toBe(0.000000075);
  });

  test("defaults tiered pricing threshold to 200K when metadata only ships *_above_200k rates", () => {
    const stats = expectStats("google:gemini-3.1-pro-preview");
    expect(stats.tiered_pricing_threshold_tokens).toBe(200000);
    expect(stats.input_cost_per_token_above_200k_tokens).toBe(0.000004);
    expect(stats.output_cost_per_token_above_200k_tokens).toBe(0.000018);
  });

  test("normalizes mux-gateway provider/model ids before lookup", () => {
    expect(expectStats("mux-gateway:anthropic/claude-sonnet-4-5")).toEqual(
      expectStats("anthropic:claude-sonnet-4-5")
    );
  });

  test("supports bare model ids without a provider prefix", () => {
    expect(expectStats("gpt-5.2")).toEqual(expectStats("openai:gpt-5.2"));
  });

  test("resolves size-suffixed Ollama models via base/cloud fallback keys", () => {
    expect(expectStats("ollama:gpt-oss:20b").max_input_tokens).toBeGreaterThan(0);
  });

  test("uses provider-specific GitHub Copilot metadata and defaults missing costs to zero", () => {
    const stats = expectStats("github-copilot:gpt-4.1");
    expect(stats.input_cost_per_token).toBe(0);
    expect(stats.output_cost_per_token).toBe(0);
  });

  test("preserves cache fields only when metadata provides them", () => {
    const cached = expectStats(KNOWN_MODELS.OPUS.id);
    expect(cached.cache_creation_input_token_cost).toBeDefined();
    expect(cached.cache_read_input_token_cost).toBeDefined();

    const uncached = expectStats("ollama:llama3.1");
    expect(uncached.cache_creation_input_token_cost).toBeUndefined();
    expect(uncached.cache_read_input_token_cost).toBeUndefined();
  });

  test("resolves DeepSeek V4 pricing and limits via direct and gateway forms", () => {
    // Direct provider id wires up to the modelsExtra entry.
    const pro = expectStats("deepseek:deepseek-v4-pro");
    expect(pro.max_input_tokens).toBe(1_000_000);
    expect(pro.max_output_tokens).toBe(384_000);
    expect(pro.input_cost_per_token).toBe(0.00000174);
    expect(pro.output_cost_per_token).toBe(0.00000348);
    expect(pro.cache_read_input_token_cost).toBe(0.000000174);

    // OpenRouter routes "deepseek/deepseek-v4-pro" back to the direct DeepSeek
    // entry via normalizeToCanonical, so pricing must match the direct lookup.
    expect(expectStats("openrouter:deepseek/deepseek-v4-pro")).toEqual(pro);

    const flash = expectStats("deepseek:deepseek-v4-flash");
    expect(flash.input_cost_per_token).toBe(0.00000014);
    expect(flash.output_cost_per_token).toBe(0.00000028);
    expect(flash.cache_read_input_token_cost).toBe(0.000000014);
  });

  test("resolves Kimi K3 pricing and limits via direct and gateway forms", () => {
    const stats = expectStats("moonshotai:kimi-k3");
    expect(stats.max_input_tokens).toBe(1_048_576);
    expect(stats.max_output_tokens).toBe(131_072);
    expect(stats.input_cost_per_token).toBe(0.000003);
    expect(stats.output_cost_per_token).toBe(0.000015);
    expect(stats.cache_read_input_token_cost).toBe(0.0000003);

    // The legacy OpenRouter form canonicalizes back to the direct Moonshot entry.
    expect(expectStats("openrouter:moonshotai/kimi-k3")).toEqual(stats);
  });

  test("resolves GLM 5.3 Flash limits, list pricing, and supported inputs", () => {
    const stats = expectStats("zai:glm-5.3-flash");

    expect(stats.max_input_tokens).toBe(1_048_576);
    expect(stats.max_output_tokens).toBe(131_072);
    expect(stats.input_cost_per_token).toBe(0.00000015);
    expect(stats.output_cost_per_token).toBe(0.0000005);
    expect(stats.cache_read_input_token_cost).toBe(0.00000003);
  });

  test("resolves the default image generation model pricing", () => {
    const stats = expectStats(DEFAULT_IMAGE_MODEL);

    expect(stats.input_cost_per_token).toBe(0.000005);
    expect(stats.cache_read_input_token_cost).toBe(0.00000125);
    expect(stats.output_cost_per_token).toBe(0.00003);
    expect(expectStats(PINNED_IMAGE_MODEL)).toEqual(stats);
  });

  test("returns null for unknown models across direct and gateway forms", () => {
    expect(getModelStats("unknown:fake-model-9000")).toBeNull();
    expect(getModelStats("ollama:this-model-does-not-exist")).toBeNull();
    expect(getModelStats("mux-gateway:anthropic/unknown-model-xyz")).toBeNull();
  });
});

describe("getModelStatsResolved", () => {
  test("returns mapped model stats when mapping exists", () => {
    const config: ProvidersConfigMap = {
      ollama: {
        apiKeySet: false,
        isEnabled: true,
        isConfigured: true,
        models: [{ id: "custom", mappedToModel: KNOWN_MODELS.SONNET.id }],
      },
    };

    expect(getModelStatsResolved("ollama:custom", config)).toEqual(
      expectStats(KNOWN_MODELS.SONNET.id)
    );
  });

  test("returns null for unmapped unknown models", () => {
    expect(getModelStatsResolved("ollama:custom", null)).toBeNull();
  });

  // Gateway-scoped Coder models must price/size as their upstream: otherwise
  // budgeted goals reject them as unpriced and context limits stay unknown.
  test("resolves gateway-scoped Coder models through the instance type", () => {
    const sonnetModelId = KNOWN_MODELS.SONNET.id.split(":")[1];
    const config: ProvidersConfigMap = {
      coder: {
        apiKeySet: false,
        isEnabled: true,
        isConfigured: true,
        discoveredProviders: [{ name: "prod-anthropic", type: "anthropic" }],
      },
    };

    expect(getModelStatsResolved(`coder:prod-anthropic/${sonnetModelId}`, config)).toEqual(
      expectStats(KNOWN_MODELS.SONNET.id)
    );
    // Without instance metadata the name === type default still applies.
    expect(getModelStatsResolved(`coder:anthropic/${sonnetModelId}`, config)).toEqual(
      expectStats(KNOWN_MODELS.SONNET.id)
    );
  });
});

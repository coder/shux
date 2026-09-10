/**
 * Integration tests for the curated known-model registry.
 */

import { describe, test, expect } from "@jest/globals";
import {
  KNOWN_MODELS,
  MODEL_ABBREVIATIONS,
  TOKENIZER_MODEL_OVERRIDES,
} from "@/common/constants/knownModels";
import modelsJson from "@/common/utils/tokens/models.json";
import { findMissingKnownModels } from "@/common/utils/tokens/updateModelsData";

describe("Known Models Integration", () => {
  test("all known models exist in token metadata", () => {
    const missingModels = findMissingKnownModels(modelsJson);

    if (missingModels.length > 0) {
      throw new Error(
        `The following known models are missing from token metadata:\n${missingModels.join("\n")}\n\n` +
          `Run 'make update-models' to refresh models.json from LiteLLM.`
      );
    }
  });

  test("gemini-flash resolves to the stable Gemini 3.8 Flash model", () => {
    expect(MODEL_ABBREVIATIONS["gemini-flash"]).toBe("google:gemini-3.8-flash");
  });

  test("gpt alias tracks the GPT-5.6 flagship tier alongside the tier aliases", () => {
    expect(MODEL_ABBREVIATIONS.gpt).toBe("openai:gpt-5.6-sol");
    expect(MODEL_ABBREVIATIONS.sol).toBe("openai:gpt-5.6-sol");
    expect(MODEL_ABBREVIATIONS.terra).toBe("openai:gpt-5.6-terra");
    expect(MODEL_ABBREVIATIONS.luna).toBe("openai:gpt-5.6-luna");
    // The bare gpt-5.5 alias retired with the entry; openai:gpt-5.5 still
    // resolves as a custom model string via models-extra stats.
    expect(MODEL_ABBREVIATIONS["gpt-5.5"]).toBeUndefined();
  });

  test("astra aliases resolve to the GPT-6 Astra entry without moving gpt", () => {
    expect(MODEL_ABBREVIATIONS.astra).toBe("openai:gpt-6-astra");
    expect(MODEL_ABBREVIATIONS["gpt-6-astra"]).toBe("openai:gpt-6-astra");
    // Astra is additive: the flagship alias keeps tracking the cheaper GPT-5.6
    // Sol, and Astra is not warmed at startup (its tokenizer is warmed via GPT).
    expect(MODEL_ABBREVIATIONS.gpt).toBe(KNOWN_MODELS.GPT.id);
    expect(KNOWN_MODELS.GPT_6_ASTRA.warm).toBeUndefined();
    // Sol must stay ahead of Astra: compaction "switch model" suggestions pick the
    // first registry entry with the largest context, and both assume 1.05M.
    const ids = Object.values(KNOWN_MODELS).map((model) => model.id);
    expect(ids.indexOf(KNOWN_MODELS.GPT.id)).toBeLessThan(ids.indexOf(KNOWN_MODELS.GPT_6_ASTRA.id));
    // Approximate tokenizer: GPT-6's tokenizer is unpublished, so reuse gpt-5.
    expect(TOKENIZER_MODEL_OVERRIDES["openai:gpt-6-astra"]).toBe("openai/gpt-5");
  });

  test("grok aliases resolve only to Grok 4.6 in the curated registry", () => {
    expect(MODEL_ABBREVIATIONS.grok).toBe("xai:grok-4.6");
    expect(MODEL_ABBREVIATIONS["grok-4.6"]).toBe("xai:grok-4.6");
    expect(MODEL_ABBREVIATIONS["grok-4.5"]).toBeUndefined();
    expect(MODEL_ABBREVIATIONS["grok-4.1"]).toBeUndefined();
    expect(MODEL_ABBREVIATIONS["grok-code"]).toBeUndefined();
    expect(Object.values(KNOWN_MODELS).filter((model) => model.provider === "xai")).toEqual([
      KNOWN_MODELS.GROK_46,
    ]);
  });

  test("kimi aliases resolve to the direct Moonshot Kimi K3 model", () => {
    expect(MODEL_ABBREVIATIONS.kimi).toBe("moonshotai:kimi-k3");
    expect(MODEL_ABBREVIATIONS.k3).toBe("moonshotai:kimi-k3");
  });

  test("glm aliases resolve only to the direct Z.ai GLM 5.3 Flash model", () => {
    expect(MODEL_ABBREVIATIONS.glm).toBe("zai:glm-5.3-flash");
    expect(MODEL_ABBREVIATIONS["glm-flash"]).toBe("zai:glm-5.3-flash");
    expect(Object.values(KNOWN_MODELS).filter((model) => model.provider === "zai")).toEqual([
      KNOWN_MODELS.GLM_53_FLASH,
    ]);
  });

  test("known model ids and aliases stay unique across the curated registry", () => {
    const seenIds = new Set<string>();
    const seenAliases = new Set<string>();

    for (const model of Object.values(KNOWN_MODELS)) {
      expect(seenIds.has(model.id)).toBe(false);
      seenIds.add(model.id);

      for (const alias of model.aliases ?? []) {
        expect(seenAliases.has(alias)).toBe(false);
        seenAliases.add(alias);
        expect(MODEL_ABBREVIATIONS[alias]).toBe(model.id);
      }
    }
  });
});

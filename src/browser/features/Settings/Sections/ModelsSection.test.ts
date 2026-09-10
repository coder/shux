import { describe, expect, test } from "bun:test";
import { KNOWN_MODELS } from "@/common/constants/knownModels";
import { shouldAllowRouteOverrideInSettings, shouldShowModelInSettings } from "./ModelsSection";

describe("shouldShowModelInSettings", () => {
  test("hides OAuth-required Codex model when OpenAI OAuth is not configured", () => {
    expect(shouldShowModelInSettings(KNOWN_MODELS.GPT_53_CODEX_SPARK.id, false)).toBe(false);
  });

  test("shows OAuth-required Codex model when OpenAI OAuth is configured", () => {
    expect(shouldShowModelInSettings(KNOWN_MODELS.GPT_53_CODEX_SPARK.id, true)).toBe(true);
  });

  test("shows OAuth-required Codex model without OAuth when a gateway route is configured", () => {
    expect(shouldShowModelInSettings(KNOWN_MODELS.GPT_53_CODEX_SPARK.id, false, true)).toBe(true);
    expect(shouldShowModelInSettings(KNOWN_MODELS.GPT_53_CODEX_SPARK.id, false, false)).toBe(false);
  });

  test("shows GPT-5.5 when OpenAI OAuth is not configured", () => {
    expect(shouldShowModelInSettings(KNOWN_MODELS.GPT.id, false)).toBe(true);
  });

  test("shows GPT-5.5 Pro when OpenAI OAuth is not configured", () => {
    expect(shouldShowModelInSettings(KNOWN_MODELS.GPT_PRO.id, false)).toBe(true);
  });

  test("does not gate non-OpenAI models that share the same model id", () => {
    expect(shouldShowModelInSettings("openrouter:gpt-5.3-codex-spark", false)).toBe(true);
  });

  test("keeps gpt-5.3-codex visible without OAuth", () => {
    expect(shouldShowModelInSettings(KNOWN_MODELS.GPT_53_CODEX.id, false)).toBe(true);
  });
});

describe("shouldAllowRouteOverrideInSettings", () => {
  test("disables route overrides for explicit gateway rows", () => {
    expect(shouldAllowRouteOverrideInSettings("openrouter:openai/gpt-5")).toBe(false);
  });

  test("keeps route overrides enabled for canonical rows", () => {
    expect(shouldAllowRouteOverrideInSettings("openai:gpt-5")).toBe(true);
  });

  test("keeps route overrides enabled for direct custom providers", () => {
    expect(shouldAllowRouteOverrideInSettings("ollama:gpt-oss:20b")).toBe(true);
  });
});

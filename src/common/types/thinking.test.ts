import { describe, expect, test } from "bun:test";
import {
  coerceThinkingLevel,
  getOpenAIReasoningEffort,
  getThinkingDisplayLabel,
  getThinkingOptionLabel,
  isGpt6AstraModel,
  openaiRejectsDisabledReasoning,
  openaiSupportsNativeMaxEffort,
  openaiSupportsProMode,
  parseThinkingInput,
} from "./thinking";

describe("getThinkingDisplayLabel", () => {
  test("returns MAX for xhigh/max on Anthropic models", () => {
    expect(getThinkingDisplayLabel("xhigh", "anthropic:claude-opus-4-6")).toBe("MAX");
    expect(getThinkingDisplayLabel("max", "anthropic:claude-opus-4-6")).toBe("MAX");
    expect(getThinkingDisplayLabel("xhigh", "mux-gateway:anthropic/claude-opus-4-6")).toBe("MAX");
    expect(getThinkingDisplayLabel("xhigh", "anthropic:claude-opus-4-5")).toBe("MAX");
  });

  test("returns XHIGH for xhigh/max on OpenAI models", () => {
    expect(getThinkingDisplayLabel("xhigh", "openai:gpt-5.2")).toBe("XHIGH");
    expect(getThinkingDisplayLabel("max", "openai:gpt-5.2")).toBe("XHIGH");
    expect(getThinkingDisplayLabel("xhigh", "mux-gateway:openai/gpt-5.2")).toBe("XHIGH");
    expect(getThinkingDisplayLabel("max", "mux-gateway:openai/gpt-5.2")).toBe("XHIGH");
  });

  test("returns MAX for max on the GPT-5.6 family (native max effort), XHIGH for xhigh", () => {
    expect(getThinkingDisplayLabel("max", "openai:gpt-5.6-sol")).toBe("MAX");
    expect(getThinkingDisplayLabel("xhigh", "openai:gpt-5.6-sol")).toBe("XHIGH");
    expect(getThinkingDisplayLabel("max", "mux-gateway:openai/gpt-5.6-sol")).toBe("MAX");
    expect(getThinkingDisplayLabel("max", "openai:gpt-5.6-terra")).toBe("MAX");
    expect(getThinkingDisplayLabel("max", "openai:gpt-5.6-luna")).toBe("MAX");
    // Pre-5.6 OpenAI models keep the max -> XHIGH display.
    expect(getThinkingDisplayLabel("max", "openai:gpt-5.5-pro")).toBe("XHIGH");
  });

  test("returns MAX for max on GPT-6 Astra (native max effort), XHIGH for xhigh", () => {
    expect(getThinkingDisplayLabel("max", "openai:gpt-6-astra")).toBe("MAX");
    expect(getThinkingDisplayLabel("max", "mux-gateway:openai/gpt-6-astra")).toBe("MAX");
    expect(getThinkingDisplayLabel("xhigh", "openai:gpt-6-astra")).toBe("XHIGH");
    // Unpublished variants keep the legacy display.
    expect(getThinkingDisplayLabel("max", "openai:gpt-6-astra-mini")).toBe("XHIGH");
  });

  test("returns XHIGH for xhigh on Grok 4.6 (native effort), MAX on Grok 4.5", () => {
    expect(getThinkingDisplayLabel("xhigh", "xai:grok-4.6")).toBe("XHIGH");
    expect(getThinkingDisplayLabel("xhigh", "mux-gateway:xai/grok-4.6")).toBe("XHIGH");
    expect(getThinkingDisplayLabel("xhigh", "xai:grok-4.5")).toBe("MAX");
  });

  test("returns MAX for xhigh/max when no model specified (default)", () => {
    expect(getThinkingDisplayLabel("xhigh")).toBe("MAX");
    expect(getThinkingDisplayLabel("max")).toBe("MAX");
  });

  test("returns standard labels for non-xhigh levels regardless of model", () => {
    expect(getThinkingDisplayLabel("off", "anthropic:claude-opus-4-6")).toBe("OFF");
    expect(getThinkingDisplayLabel("low", "anthropic:claude-opus-4-6")).toBe("LOW");
    expect(getThinkingDisplayLabel("medium", "anthropic:claude-opus-4-6")).toBe("MED");
    expect(getThinkingDisplayLabel("high", "anthropic:claude-opus-4-6")).toBe("HIGH");
  });
});

describe("getThinkingOptionLabel", () => {
  test("renders max for xhigh on Anthropic models", () => {
    expect(getThinkingOptionLabel("xhigh", "anthropic:claude-opus-4-6")).toBe("max");
  });

  test("renders xhigh for xhigh/max on OpenAI models", () => {
    expect(getThinkingOptionLabel("xhigh", "openai:gpt-5.2")).toBe("xhigh");
    expect(getThinkingOptionLabel("max", "openai:gpt-5.2")).toBe("xhigh");
  });

  test("renders distinct max/xhigh options on GPT-5.6 Sol", () => {
    expect(getThinkingOptionLabel("max", "openai:gpt-5.6-sol")).toBe("max");
    expect(getThinkingOptionLabel("xhigh", "openai:gpt-5.6-sol")).toBe("xhigh");
  });

  test("preserves non-xhigh labels", () => {
    expect(getThinkingOptionLabel("medium", "anthropic:claude-opus-4-6")).toBe("medium");
  });
});

describe("openaiSupportsNativeMaxEffort", () => {
  test("matches the GPT-5.6 family including prefixed and dated variants", () => {
    expect(openaiSupportsNativeMaxEffort("openai:gpt-5.6-sol")).toBe(true);
    expect(openaiSupportsNativeMaxEffort("gpt-5.6-sol")).toBe(true);
    expect(openaiSupportsNativeMaxEffort("mux-gateway:openai/gpt-5.6-sol")).toBe(true);
    expect(openaiSupportsNativeMaxEffort("openai:gpt-5.6-sol-2026-07-09")).toBe(true);
    expect(openaiSupportsNativeMaxEffort("openai:gpt-5.6-terra")).toBe(true);
    expect(openaiSupportsNativeMaxEffort("openai:gpt-5.6-luna")).toBe(true);
    // The bare alias routes to Sol and shares the family capabilities.
    expect(openaiSupportsNativeMaxEffort("openai:gpt-5.6")).toBe(true);
  });

  test("rejects other models and named variants", () => {
    expect(openaiSupportsNativeMaxEffort("openai:gpt-5.6-sol-mini")).toBe(false);
    expect(openaiSupportsNativeMaxEffort("openai:gpt-5.5")).toBe(false);
    expect(openaiSupportsNativeMaxEffort("openai:gpt-5.5-pro")).toBe(false);
    expect(openaiSupportsNativeMaxEffort("openai:gpt-5.61")).toBe(false);
  });

  test("matches GPT-6 Astra including prefixed and dated variants", () => {
    expect(openaiSupportsNativeMaxEffort("openai:gpt-6-astra")).toBe(true);
    expect(openaiSupportsNativeMaxEffort("gpt-6-astra")).toBe(true);
    expect(openaiSupportsNativeMaxEffort("mux-gateway:openai/gpt-6-astra")).toBe(true);
    expect(openaiSupportsNativeMaxEffort("openai:gpt-6-astra-2026-09-30")).toBe(true);
    expect(openaiSupportsNativeMaxEffort("openai:gpt-6-astra-20260930")).toBe(true);
  });

  test("does not extend the Astra matcher to named variants or other GPT-6 ids", () => {
    expect(isGpt6AstraModel("openai:gpt-6-astra-mini")).toBe(false);
    expect(isGpt6AstraModel("openai:gpt-6-astra.1")).toBe(false);
    expect(isGpt6AstraModel("openai:gpt-6-astral")).toBe(false);
    expect(isGpt6AstraModel("openai:gpt-6")).toBe(false);
    expect(isGpt6AstraModel("openai:gpt-6-sol")).toBe(false);
    expect(isGpt6AstraModel("openai:gpt-5.6-sol")).toBe(false);
    expect(openaiSupportsNativeMaxEffort("openai:gpt-6")).toBe(false);
  });

  test("accepts only dated Astra snapshots, not numeric-prefixed qualifiers", () => {
    expect(isGpt6AstraModel("gpt-6-astra-2026-09-30")).toBe(true);
    expect(isGpt6AstraModel("gpt-6-astra-20260930")).toBe(true);
    // Numeric-prefixed qualifiers are not dated snapshots and must not inherit
    // Astra's reasoning surface.
    expect(isGpt6AstraModel("gpt-6-astra-2-mini")).toBe(false);
    expect(isGpt6AstraModel("gpt-6-astra-2026-preview")).toBe(false);
    expect(isGpt6AstraModel("gpt-6-astra-2026-09-30-preview")).toBe(false);
    expect(isGpt6AstraModel("gpt-6-astra-2026")).toBe(false);
    expect(openaiSupportsNativeMaxEffort("openai:gpt-6-astra-2-mini")).toBe(false);
  });
});

describe("openaiSupportsProMode", () => {
  test("matches the GPT-5.6 family including prefixed and dated variants", () => {
    expect(openaiSupportsProMode("openai:gpt-5.6-sol")).toBe(true);
    expect(openaiSupportsProMode("openai:gpt-5.6-terra")).toBe(true);
    expect(openaiSupportsProMode("openai:gpt-5.6-luna")).toBe(true);
    expect(openaiSupportsProMode("mux-gateway:openai/gpt-5.6-sol")).toBe(true);
    expect(openaiSupportsProMode("gpt-5.6-terra-2026-07-09")).toBe(true);
    // The bare alias routes to Sol and shares the family capabilities.
    expect(openaiSupportsProMode("openai:gpt-5.6")).toBe(true);
  });

  test("rejects older models and named variants", () => {
    expect(openaiSupportsProMode("openai:gpt-5.5-pro")).toBe(false);
    expect(openaiSupportsProMode("openai:gpt-5.6-sol-mini")).toBe(false);
    expect(openaiSupportsProMode("openai:gpt-5.61")).toBe(false);
    expect(openaiSupportsProMode("anthropic:claude-opus-4-7")).toBe(false);
  });

  test("supports Astra and dated snapshots without enabling unpublished variants", () => {
    for (const model of [
      "openai:gpt-6-astra",
      "mux-gateway:openai/gpt-6-astra",
      "openai:gpt-6-astra-2026-09-03",
      "gpt-6-astra-20260903",
    ]) {
      expect(openaiSupportsProMode(model)).toBe(true);
    }
    for (const model of ["gpt-6", "gpt-6-astra-mini", "gpt-6-astra-2026-preview"]) {
      expect(openaiSupportsProMode(model)).toBe(false);
    }
  });
});

describe("getOpenAIReasoningEffort", () => {
  test("maps max to the native max effort on the GPT-5.6 family only", () => {
    expect(getOpenAIReasoningEffort("max", "openai:gpt-5.6-sol")).toBe("max");
    expect(getOpenAIReasoningEffort("xhigh", "openai:gpt-5.6-sol")).toBe("xhigh");
    expect(getOpenAIReasoningEffort("max", "openai:gpt-5.6-terra")).toBe("max");
    expect(getOpenAIReasoningEffort("max", "openai:gpt-5.6-luna")).toBe("max");
    expect(getOpenAIReasoningEffort("max", "openai:gpt-5.5-pro")).toBe("xhigh");
  });

  test("maps off to the explicit none effort on GPT-5.6 (omission defaults to medium)", () => {
    expect(getOpenAIReasoningEffort("off", "openai:gpt-5.6-sol")).toBe("none");
    expect(getOpenAIReasoningEffort("off", "openai:gpt-5.6-luna")).toBe("none");
    // Pre-5.6 models keep the omit-on-off behavior.
    expect(getOpenAIReasoningEffort("off", "openai:gpt-5.5")).toBeUndefined();
  });

  test("keeps the standard mapping for lower levels", () => {
    expect(getOpenAIReasoningEffort("high", "openai:gpt-5.6-sol")).toBe("high");
    expect(getOpenAIReasoningEffort("low", "openai:gpt-5.6-sol")).toBe("low");
  });

  test("gives GPT-6 Astra native max but clamps off to low (it rejects none)", () => {
    expect(openaiRejectsDisabledReasoning("openai:gpt-6-astra")).toBe(true);
    expect(openaiRejectsDisabledReasoning("openai:gpt-5.6-sol")).toBe(false);
    expect(getOpenAIReasoningEffort("max", "openai:gpt-6-astra")).toBe("max");
    expect(getOpenAIReasoningEffort("xhigh", "openai:gpt-6-astra")).toBe("xhigh");
    expect(getOpenAIReasoningEffort("off", "openai:gpt-6-astra")).toBe("low");
    expect(getOpenAIReasoningEffort("off", "mux-gateway:openai/gpt-6-astra-2026-09-03")).toBe(
      "low"
    );
    expect(getOpenAIReasoningEffort("medium", "mux-gateway:openai/gpt-6-astra")).toBe("medium");
    // Unpublished variants keep the legacy mapping.
    expect(getOpenAIReasoningEffort("max", "openai:gpt-6-astra-mini")).toBe("xhigh");
    expect(getOpenAIReasoningEffort("off", "openai:gpt-6-astra-mini")).toBeUndefined();
  });
});

describe("coerceThinkingLevel", () => {
  test("normalizes shorthand aliases", () => {
    expect(coerceThinkingLevel("med")).toBe("medium");
  });

  test("passes through all canonical levels including max", () => {
    expect(coerceThinkingLevel("off")).toBe("off");
    expect(coerceThinkingLevel("low")).toBe("low");
    expect(coerceThinkingLevel("medium")).toBe("medium");
    expect(coerceThinkingLevel("high")).toBe("high");
    expect(coerceThinkingLevel("xhigh")).toBe("xhigh");
    expect(coerceThinkingLevel("max")).toBe("max");
  });

  test("returns undefined for invalid values", () => {
    expect(coerceThinkingLevel("invalid")).toBeUndefined();
    expect(coerceThinkingLevel(42)).toBeUndefined();
    expect(coerceThinkingLevel(null)).toBeUndefined();
  });
});

describe("parseThinkingInput", () => {
  test.each([
    ["off", "off"],
    ["low", "low"],
    ["med", "medium"],
    ["medium", "medium"],
    ["high", "high"],
    ["max", "max"],
    ["xhigh", "xhigh"],
    ["OFF", "off"],
    ["MED", "medium"],
    ["High", "high"],
  ] as const)("parses named level %s → %s", (input, expected) => {
    expect(parseThinkingInput(input)).toBe(expected);
  });

  // Numeric indices are returned as raw numbers (resolved against model policy at send time)
  test.each([
    ["0", 0],
    ["1", 1],
    ["2", 2],
    ["3", 3],
    ["4", 4],
    ["9", 9],
  ] as const)("parses numeric level %s → %s", (input, expected) => {
    expect(parseThinkingInput(input)).toBe(expected);
  });

  test.each(["-1", "10", "99", "foo", "mediun", "1.5", "", "  "])(
    "returns undefined for invalid input %j",
    (input) => {
      expect(parseThinkingInput(input)).toBeUndefined();
    }
  );

  test("trims whitespace", () => {
    expect(parseThinkingInput("  high  ")).toBe("high");
    // Numeric with whitespace returns a number
    expect(parseThinkingInput(" 2 ")).toBe(2);
  });
});

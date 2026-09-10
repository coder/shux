import { describe, expect, it } from "bun:test";
import type { ProvidersConfig } from "@/common/config/schemas/providersConfig";
import { resolveModelParameterOverrides } from "./modelParameterOverrides";

function withAnthropicModelParameters(
  modelParameters: Record<string, Record<string, unknown>>
): ProvidersConfig {
  return asProvidersConfig({
    anthropic: {
      modelParameters,
    },
  });
}

function withOllamaModelParameters(
  modelParameters: Record<string, Record<string, unknown>>
): ProvidersConfig {
  return asProvidersConfig({
    ollama: {
      modelParameters,
    },
  });
}

function withGoogleModelParameters(
  modelParameters: Record<string, Record<string, unknown>>
): ProvidersConfig {
  return asProvidersConfig({
    google: {
      modelParameters,
    },
  });
}

function asProvidersConfig(value: unknown): ProvidersConfig {
  return value as ProvidersConfig;
}

describe("resolveModelParameterOverrides", () => {
  it("returns empty standard when providersConfig is null", () => {
    const result = resolveModelParameterOverrides(null, "anthropic", "anthropic:claude-sonnet-4-5");

    expect(result).toEqual({ standard: {} });
  });

  it("returns empty standard when provider has no modelParameters", () => {
    const providersConfig: ProvidersConfig = {
      anthropic: {},
    };

    const result = resolveModelParameterOverrides(
      providersConfig,
      "anthropic",
      "anthropic:claude-sonnet-4-5"
    );

    expect(result).toEqual({ standard: {} });
  });

  it("resolves canonical model match", () => {
    const providersConfig = withAnthropicModelParameters({
      "claude-sonnet-4-5": {
        max_output_tokens: 16384,
        temperature: 0.7,
      },
    });

    const result = resolveModelParameterOverrides(
      providersConfig,
      "anthropic",
      "anthropic:claude-sonnet-4-5"
    );

    expect(result).toEqual({
      standard: {
        maxOutputTokens: 16384,
        temperature: 0.7,
      },
    });
  });

  it("falls back to wildcard entry when model does not have a direct override", () => {
    const providersConfig = withAnthropicModelParameters({
      "*": {
        max_output_tokens: 4096,
        temperature: 0.3,
      },
    });

    const result = resolveModelParameterOverrides(
      providersConfig,
      "anthropic",
      "anthropic:claude-opus-4-1"
    );

    expect(result).toEqual({
      standard: {
        maxOutputTokens: 4096,
        temperature: 0.3,
      },
    });
  });

  it("prefers per-model entry over wildcard", () => {
    const providersConfig = withAnthropicModelParameters({
      "claude-sonnet-4-5": {
        max_output_tokens: 8192,
      },
      "*": {
        max_output_tokens: 2048,
      },
    });

    const result = resolveModelParameterOverrides(
      providersConfig,
      "anthropic",
      "anthropic:claude-sonnet-4-5"
    );

    expect(result).toEqual({
      standard: {
        maxOutputTokens: 8192,
      },
    });
  });

  it("gives effective model entry priority when it differs from canonical model", () => {
    const providersConfig = withAnthropicModelParameters({
      "claude-sonnet-4-5": {
        temperature: 0.8,
      },
      "claude-sonnet-4-5-20250929": {
        temperature: 0.2,
      },
      "*": {
        temperature: 0.6,
      },
    });

    const result = resolveModelParameterOverrides(
      providersConfig,
      "anthropic",
      "anthropic:claude-sonnet-4-5",
      "anthropic:claude-sonnet-4-5-20250929"
    );

    expect(result).toEqual({
      standard: {
        temperature: 0.2,
      },
    });
  });

  it("falls back from effective model to canonical model when effective has no override", () => {
    const providersConfig = withAnthropicModelParameters({
      "claude-sonnet-4-5": {
        temperature: 0.8,
      },
      "*": {
        temperature: 0.6,
      },
    });

    const result = resolveModelParameterOverrides(
      providersConfig,
      "anthropic",
      "anthropic:claude-sonnet-4-5",
      "anthropic:claude-sonnet-4-5-20250929"
    );

    expect(result).toEqual({
      standard: {
        temperature: 0.8,
      },
    });
  });

  it("matches exact colon-suffix model IDs", () => {
    const providersConfig = withOllamaModelParameters({
      "gpt-oss:20b": {
        temperature: 0.35,
      },
    });

    const result = resolveModelParameterOverrides(providersConfig, "ollama", "ollama:gpt-oss:20b");

    expect(result).toEqual({
      standard: {
        temperature: 0.35,
      },
    });
  });

  it("gives effective model entry priority for colon-suffix model IDs", () => {
    const providersConfig = withOllamaModelParameters({
      "gpt-oss:20b": {
        temperature: 0.8,
      },
      "gpt-oss:120b": {
        temperature: 0.2,
      },
      "*": {
        temperature: 0.6,
      },
    });

    const result = resolveModelParameterOverrides(
      providersConfig,
      "ollama",
      "ollama:gpt-oss:20b",
      "ollama:gpt-oss:120b"
    );

    expect(result).toEqual({
      standard: {
        temperature: 0.2,
      },
    });
  });

  it("falls back to wildcard for colon-suffix model IDs", () => {
    const providersConfig = withOllamaModelParameters({
      "*": {
        top_p: 0.4,
      },
    });

    const result = resolveModelParameterOverrides(providersConfig, "ollama", "ollama:gpt-oss:20b");

    expect(result).toEqual({
      standard: {
        topP: 0.4,
      },
    });
  });

  it("strips provider prefix from canonical model string", () => {
    const providersConfig = withAnthropicModelParameters({
      "claude-sonnet-4-5": {
        top_p: 0.9,
      },
    });

    const result = resolveModelParameterOverrides(
      providersConfig,
      "anthropic",
      "anthropic:claude-sonnet-4-5"
    );

    expect(result).toEqual({
      standard: {
        topP: 0.9,
      },
    });
  });

  it("returns unknown keys as providerExtras while still mapping standard keys", () => {
    const providersConfig = withAnthropicModelParameters({
      "claude-sonnet-4-5": {
        transforms: ["middle-out"],
        max_output_tokens: 8192,
      },
    });

    const result = resolveModelParameterOverrides(
      providersConfig,
      "anthropic",
      "anthropic:claude-sonnet-4-5"
    );

    expect(result).toEqual({
      standard: {
        maxOutputTokens: 8192,
      },
      providerExtras: {
        transforms: ["middle-out"],
      },
    });
  });

  it("omits providerExtras when all keys are standard", () => {
    const providersConfig = withAnthropicModelParameters({
      "claude-sonnet-4-5": {
        max_output_tokens: 8192,
        temperature: 0.4,
      },
    });

    const result = resolveModelParameterOverrides(
      providersConfig,
      "anthropic",
      "anthropic:claude-sonnet-4-5"
    );

    expect(result).toEqual({
      standard: {
        maxOutputTokens: 8192,
        temperature: 0.4,
      },
    });
    expect(Object.hasOwn(result, "providerExtras")).toBe(false);
  });

  it("ignores out-of-range standard values while keeping valid standard keys", () => {
    const providersConfig = withAnthropicModelParameters({
      "claude-sonnet-4-5": {
        max_output_tokens: -1,
        top_p: 1.5,
        temperature: 0.3,
      },
    });

    const result = resolveModelParameterOverrides(
      providersConfig,
      "anthropic",
      "anthropic:claude-sonnet-4-5"
    );

    expect(result).toEqual({
      standard: {
        temperature: 0.3,
      },
    });
  });

  it("ignores malformed non-numeric values for standard keys", () => {
    const providersConfig = asProvidersConfig({
      anthropic: {
        modelParameters: {
          "claude-sonnet-4-5": {
            max_output_tokens: "not-a-number",
          },
        },
      },
    });

    const result = resolveModelParameterOverrides(
      providersConfig,
      "anthropic",
      "anthropic:claude-sonnet-4-5"
    );

    expect(result).toEqual({
      standard: {},
    });
  });

  it("ignores malformed string entry for canonical model", () => {
    const providersConfig = asProvidersConfig({
      anthropic: {
        modelParameters: {
          "claude-sonnet-4-5": "bad-entry",
        },
      },
    });

    const result = resolveModelParameterOverrides(
      providersConfig,
      "anthropic",
      "anthropic:claude-sonnet-4-5"
    );

    expect(result).toEqual({ standard: {} });
  });

  it("skips malformed effective entry and falls back to canonical plain-object entry", () => {
    const providersConfig = asProvidersConfig({
      anthropic: {
        modelParameters: {
          "claude-sonnet-4-5": { temperature: 0.6 },
          "claude-sonnet-4-5-20250929": "bad-entry",
        },
      },
    });

    const result = resolveModelParameterOverrides(
      providersConfig,
      "anthropic",
      "anthropic:claude-sonnet-4-5",
      "anthropic:claude-sonnet-4-5-20250929"
    );

    expect(result).toEqual({
      standard: { temperature: 0.6 },
    });
  });

  it("ignores NaN and Infinity values for standard keys", () => {
    const providersConfig = asProvidersConfig({
      anthropic: {
        modelParameters: {
          "claude-sonnet-4-5": {
            temperature: Number.NaN,
            top_p: Number.POSITIVE_INFINITY,
          },
        },
      },
    });

    const result = resolveModelParameterOverrides(
      providersConfig,
      "anthropic",
      "anthropic:claude-sonnet-4-5"
    );

    expect(result).toEqual({
      standard: {},
    });
  });

  it("returns empty standard when modelParameters exists but is empty", () => {
    const providersConfig = withAnthropicModelParameters({});

    const result = resolveModelParameterOverrides(
      providersConfig,
      "anthropic",
      "anthropic:claude-sonnet-4-5"
    );

    expect(result).toEqual({ standard: {} });
  });

  it("strips deprecated sampling parameters for Gemini 3.6 Flash", () => {
    const providersConfig = withGoogleModelParameters({
      "*": {
        max_output_tokens: 32768,
        temperature: 0.7,
        top_p: 0.9,
        top_k: 40,
      },
    });

    const result = resolveModelParameterOverrides(
      providersConfig,
      "google",
      "google:gemini-3.6-flash"
    );

    expect(result).toEqual({
      standard: {
        maxOutputTokens: 32768,
      },
    });
  });

  it("strips deprecated sampling parameters for Gemini 3.7 Flash", () => {
    const providersConfig = withGoogleModelParameters({
      "*": {
        max_output_tokens: 32768,
        temperature: 0.7,
        top_p: 0.9,
        top_k: 40,
      },
    });

    const result = resolveModelParameterOverrides(
      providersConfig,
      "google",
      "google:gemini-3.7-flash"
    );

    expect(result).toEqual({
      standard: {
        maxOutputTokens: 32768,
      },
    });
  });

  it("strips deprecated sampling parameters for Gemini 3.8 Flash", () => {
    const providersConfig = withGoogleModelParameters({
      "*": {
        max_output_tokens: 32768,
        temperature: 0.7,
        top_p: 0.9,
        top_k: 40,
      },
    });

    const result = resolveModelParameterOverrides(
      providersConfig,
      "google",
      "google:gemini-3.8-flash"
    );

    expect(result).toEqual({
      standard: {
        maxOutputTokens: 32768,
      },
    });
  });

  it("strips deprecated sampling parameters for Gemini 3.5 Flash-Lite", () => {
    const providersConfig = withGoogleModelParameters({
      "gemini-3.5-flash-lite": {
        temperature: 0.5,
        seed: 42,
      },
    });

    const result = resolveModelParameterOverrides(
      providersConfig,
      "google",
      "google:gemini-3.5-flash-lite"
    );

    expect(result).toEqual({
      standard: {
        seed: 42,
      },
    });
  });

  it("strips sampling parameters based on the gateway-routed effective model", () => {
    const providersConfig = withGoogleModelParameters({
      "*": {
        temperature: 0.7,
      },
    });

    const result = resolveModelParameterOverrides(
      providersConfig,
      "google",
      "google:gemini-3.8-flash",
      "mux-gateway:google/gemini-3.8-flash"
    );

    expect(result).toEqual({ standard: {} });
  });

  it("strips sampling parameters for custom entries mapped to a sampling-rejecting model", () => {
    const providersConfig = asProvidersConfig({
      google: {
        models: [{ id: "team-flash", mappedToModel: "google:gemini-3.8-flash" }],
        modelParameters: {
          "*": {
            temperature: 0.7,
            max_output_tokens: 4096,
          },
        },
      },
    });

    const result = resolveModelParameterOverrides(providersConfig, "google", "google:team-flash");

    expect(result).toEqual({
      standard: {
        maxOutputTokens: 4096,
      },
    });
  });

  it("keeps sampling parameters for Gemini models that still support them", () => {
    const providersConfig = withGoogleModelParameters({
      "*": {
        temperature: 0.7,
        top_k: 40,
      },
    });

    const result = resolveModelParameterOverrides(
      providersConfig,
      "google",
      "google:gemini-3.5-flash"
    );

    expect(result).toEqual({
      standard: {
        temperature: 0.7,
        topK: 40,
      },
    });
  });

  it("treats prototype-collision keys as providerExtras", () => {
    const providersConfig = withAnthropicModelParameters({
      "claude-sonnet-4-5": {
        toString: "custom-value",
        constructor: "another-value",
        max_output_tokens: 1024,
      },
    });

    const result = resolveModelParameterOverrides(
      providersConfig,
      "anthropic",
      "anthropic:claude-sonnet-4-5"
    );

    expect(result).toEqual({
      standard: { maxOutputTokens: 1024 },
      providerExtras: { toString: "custom-value", constructor: "another-value" },
    });
  });
});

import { describe, expect, test } from "bun:test";
import { SUPPORTED_PROVIDERS } from "@/common/constants/providers";
import type { ProvidersConfig } from "@/common/config/schemas/providersConfig";
import {
  CUSTOM_PROVIDER_TYPES,
  formatProviderDisplayName,
  getCustomProviderIds,
  getShadowedCustomProviderIds,
  isBuiltInProvider,
  isCustomProviderConfig,
  isValidCustomProviderId,
  validateCustomProviderBaseUrl,
  validateCustomProviderId,
} from "./customProviders";

describe("custom provider id validation", () => {
  test("accepts valid custom provider ids", () => {
    for (const id of ["local-vllm", "llama_cpp", "lm-studio", "proxy1", "123"]) {
      expect(isValidCustomProviderId(id)).toBe(true);
      expect(validateCustomProviderId(id)).toEqual({ ok: true });
    }
  });

  test("rejects invalid custom provider ids", () => {
    const invalidIds = [
      "",
      "Local-VLLM",
      "-local-vllm",
      "local.vllm",
      "local:vllm",
      "local/vllm",
      "local vllm",
      "__proto__",
      "prototype",
      "constructor",
      "hasOwnProperty",
    ];

    for (const id of invalidIds) {
      expect(isValidCustomProviderId(id)).toBe(false);

      const validation = validateCustomProviderId(id);
      expect(validation.ok).toBe(false);
      if (!validation.ok) {
        expect(validation.reason.length).toBeGreaterThan(0);
      }
    }
  });

  test("rejects built-in provider ids", () => {
    for (const provider of SUPPORTED_PROVIDERS) {
      expect(isValidCustomProviderId(provider)).toBe(false);
      expect(validateCustomProviderId(provider).ok).toBe(false);
      expect(isBuiltInProvider(provider)).toBe(true);
    }
  });
});

describe("custom provider base URL validation", () => {
  test("accepts http(s) base URLs with optional paths", () => {
    for (const baseUrl of [
      "http://localhost:8000",
      "http://localhost:8000/",
      "https://api.example.com/v1",
      "https://proxy.example/anthropic",
      // Percent-encoded delimiters stay path bytes under raw suffixing.
      "https://api.example.com/v1%3Ftoken",
    ]) {
      expect(validateCustomProviderBaseUrl(baseUrl)).toEqual({ ok: true });
    }
  });

  test("rejects empty and non-http(s) base URLs", () => {
    for (const baseUrl of ["", "   ", "not a url", "ftp://api.example.com/v1", "localhost:8000"]) {
      const validation = validateCustomProviderBaseUrl(baseUrl);
      expect(validation.ok).toBe(false);
      if (!validation.ok) {
        expect(validation.reason.length).toBeGreaterThan(0);
      }
    }
  });

  test("rejects base URLs carrying a query string or fragment", () => {
    for (const baseUrl of [
      "https://proxy.example/anthropic?token=x",
      "https://api.example.com/v1?api-version=2024-01-01",
      "http://localhost:8000#tag",
      // A bare trailing "?" parses to an empty URL.search but still breaks
      // raw suffixing, so the contract is on the raw characters.
      "http://localhost:8000/v1?",
    ]) {
      const validation = validateCustomProviderBaseUrl(baseUrl);
      expect(validation.ok).toBe(false);
      if (!validation.ok) {
        expect(validation.reason).toContain("query");
      }
    }
  });
});

describe("isCustomProviderConfig", () => {
  test("returns true for every custom provider API format", () => {
    for (const providerType of CUSTOM_PROVIDER_TYPES) {
      expect(
        isCustomProviderConfig({
          providerType,
          baseUrl: "http://localhost:8000/v1",
        })
      ).toBe(true);
    }
  });

  test("returns false for non-custom provider config", () => {
    expect(isCustomProviderConfig({ apiKey: "key" })).toBe(false);
    expect(isCustomProviderConfig({ providerType: "unknown-format" })).toBe(false);
    expect(isCustomProviderConfig(null)).toBe(false);
  });
});

describe("getCustomProviderIds", () => {
  test("returns custom providers in config key order", () => {
    const providersConfig: ProvidersConfig = {
      openai: { providerType: "openai-compatible", apiKey: "key" },
      "legacy-custom": { apiKey: "legacy-key" },
      "local-vllm": {
        providerType: "openai-responses",
        baseUrl: "http://localhost:8000/v1",
      },
      "llama-cpp": {
        providerType: "anthropic-messages",
        baseUrl: "http://localhost:8080/v1",
      },
    };

    expect(getCustomProviderIds(providersConfig)).toEqual(["openai", "local-vllm", "llama-cpp"]);
    expect(getShadowedCustomProviderIds(providersConfig)).toEqual(["openai"]);
  });
});

describe("formatProviderDisplayName", () => {
  test("prefers shadowed custom display name over built-in display name for every format", () => {
    for (const providerType of CUSTOM_PROVIDER_TYPES) {
      expect(
        formatProviderDisplayName("openai", {
          providerType,
          displayName: "Shadowed OpenAI",
        })
      ).toBe("Shadowed OpenAI");
    }
  });

  test("uses built-in provider display names", () => {
    expect(formatProviderDisplayName("openai")).toBe("OpenAI");
    expect(formatProviderDisplayName("github-copilot")).toBe("GitHub Copilot");
  });

  test("uses custom display name when present", () => {
    expect(formatProviderDisplayName("local-vllm", { displayName: "Local vLLM" })).toBe(
      "Local vLLM"
    );
  });

  test("falls back to custom provider id for an empty display name", () => {
    expect(formatProviderDisplayName("local-vllm", { displayName: "" })).toBe("local-vllm");
  });

  test("falls back to custom provider id", () => {
    expect(formatProviderDisplayName("local-vllm")).toBe("local-vllm");
  });
});

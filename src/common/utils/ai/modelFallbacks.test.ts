import { describe, expect, it } from "bun:test";

import {
  DEFAULT_MODEL_FALLBACKS,
  MODEL_FALLBACK_CHAIN_LIMIT,
  normalizeFallbackModelKey,
  resolveModelFallbackChain,
  sanitizeModelFallbackChain,
  sanitizeModelFallbacks,
} from "./modelFallbacks";

const SOURCE = "anthropic:claude-sonnet-4-5";
const FALLBACK_A = "openai:gpt-5.5";
const FALLBACK_B = "google:gemini-3-pro";
const FALLBACK_C = "xai:grok-4-1-fast";
const FALLBACK_D = "openai:gpt-5.5-pro";

describe("sanitizeModelFallbackChain", () => {
  it("preserves order while dropping self-fallbacks and duplicates", () => {
    expect(
      sanitizeModelFallbackChain(SOURCE, [FALLBACK_A, SOURCE, FALLBACK_A, FALLBACK_B])
    ).toEqual([FALLBACK_A, FALLBACK_B]);
  });

  it("caps the chain length", () => {
    expect(
      sanitizeModelFallbackChain(SOURCE, [FALLBACK_A, FALLBACK_B, FALLBACK_C, FALLBACK_D])
    ).toEqual([FALLBACK_A, FALLBACK_B, FALLBACK_C].slice(0, MODEL_FALLBACK_CHAIN_LIMIT));
  });

  it("canonicalizes gateway-prefixed entries (and self-checks against the canonical form)", () => {
    expect(
      sanitizeModelFallbackChain(SOURCE, [
        "mux-gateway:openai/gpt-5.5",
        "mux-gateway:anthropic/claude-sonnet-4-5", // self via gateway prefix
      ])
    ).toEqual([FALLBACK_A]);
  });

  it("skips non-string and empty entries", () => {
    expect(sanitizeModelFallbackChain(SOURCE, [42, "", "  ", FALLBACK_A])).toEqual([FALLBACK_A]);
  });
});

describe("resolveModelFallbackChain", () => {
  it("returns [] when the map is undefined or has no entry", () => {
    expect(resolveModelFallbackChain(undefined, SOURCE)).toEqual([]);
    expect(resolveModelFallbackChain({}, SOURCE)).toEqual([]);
  });

  it("returns the sanitized chain in configured order", () => {
    expect(
      resolveModelFallbackChain({ [SOURCE]: { models: [FALLBACK_B, FALLBACK_A] } }, SOURCE)
    ).toEqual([FALLBACK_B, FALLBACK_A]);
  });

  it("returns [] when the entry is disabled", () => {
    expect(
      resolveModelFallbackChain({ [SOURCE]: { enabled: false, models: [FALLBACK_A] } }, SOURCE)
    ).toEqual([]);
  });

  it("returns [] when triggers exclude model_refusal", () => {
    expect(
      resolveModelFallbackChain({ [SOURCE]: { triggers: [], models: [FALLBACK_A] } }, SOURCE)
    ).toEqual([]);
    expect(
      resolveModelFallbackChain(
        { [SOURCE]: { triggers: ["model_refusal"], models: [FALLBACK_A] } },
        SOURCE
      )
    ).toEqual([FALLBACK_A]);
  });

  it("looks up gateway-prefixed source models by canonical key", () => {
    expect(
      resolveModelFallbackChain(
        { [SOURCE]: { models: [FALLBACK_A] } },
        "mux-gateway:anthropic/claude-sonnet-4-5"
      )
    ).toEqual([FALLBACK_A]);
  });
});

describe("Coder gateway fallback keys", () => {
  // {name: "openai", type: "anthropic"}: the selection routes through the
  // gateway on the Anthropic wire — its refusal chain must be independent
  // of chains configured for direct OpenAI.
  const crossTypedConfig = {
    coder: {
      apiKeySet: false,
      isEnabled: true,
      isConfigured: true,
      discoveredProviders: [{ name: "openai", type: "anthropic" }],
    },
  };

  it("normalizeFallbackModelKey keeps cross-typed selections gateway-scoped", () => {
    expect(normalizeFallbackModelKey("coder:openai/claude-opus-4-5", crossTypedConfig)).toBe(
      "coder:openai/claude-opus-4-5"
    );
    // Default-typed (or metadata-less) canonical routes share the direct key.
    expect(normalizeFallbackModelKey("coder:anthropic/claude-opus-4-5", crossTypedConfig)).toBe(
      "anthropic:claude-opus-4-5"
    );
    expect(normalizeFallbackModelKey("coder:openai/gpt-5.5")).toBe("openai:gpt-5.5");
    // Non-canonical instance names are already gateway-scoped.
    expect(normalizeFallbackModelKey("coder:prod-anthropic/claude-opus-4-5")).toBe(
      "coder:prod-anthropic/claude-opus-4-5"
    );
  });

  it("cross-typed selections never resolve the direct provider's chain", () => {
    const fallbacks = { "openai:claude-opus-4-5": { models: [FALLBACK_A] } };
    expect(
      resolveModelFallbackChain(fallbacks, "coder:openai/claude-opus-4-5", crossTypedConfig)
    ).toEqual([]);
  });

  it("gateway-scoped chains resolve for the raw selection", () => {
    const fallbacks = { "coder:openai/claude-opus-4-5": { models: [FALLBACK_A] } };
    expect(
      resolveModelFallbackChain(fallbacks, "coder:openai/claude-opus-4-5", crossTypedConfig)
    ).toEqual([FALLBACK_A]);
    // Raw-first: the stored gateway-scoped chain stays reachable even when
    // instance metadata is unavailable (e.g. logged out).
    expect(resolveModelFallbackChain(fallbacks, "coder:openai/claude-opus-4-5")).toEqual([
      FALLBACK_A,
    ]);
  });

  it("default-typed canonical-route selections share the direct provider's chain", () => {
    const fallbacks = { [SOURCE]: { models: [FALLBACK_A] } };
    expect(
      resolveModelFallbackChain(fallbacks, "coder:anthropic/claude-sonnet-4-5", crossTypedConfig)
    ).toEqual([FALLBACK_A]);
  });

  it("sanitize preserves Coder keys and chain entries verbatim", () => {
    // Sanitize runs on every config read where metadata may be missing;
    // rewriting coder: strings by name there would merge a gateway-scoped
    // chain into the direct provider's.
    expect(
      sanitizeModelFallbacks({
        "coder:openai/claude-opus-4-5": { models: ["coder:openai/gpt-5.5", FALLBACK_B] },
      })
    ).toEqual({
      "coder:openai/claude-opus-4-5": { models: ["coder:openai/gpt-5.5", FALLBACK_B] },
    });
  });
});

describe("sanitizeModelFallbacks", () => {
  it("drops entries whose chains are empty after sanitization", () => {
    expect(
      sanitizeModelFallbacks({
        [SOURCE]: { models: [SOURCE] }, // self-only chain collapses to empty
        [FALLBACK_A]: { models: [SOURCE] },
      })
    ).toEqual({ [FALLBACK_A]: { models: [SOURCE] } });
  });

  it("canonicalizes keys and preserves enabled/triggers", () => {
    expect(
      sanitizeModelFallbacks({
        "mux-gateway:anthropic/claude-sonnet-4-5": {
          enabled: true,
          triggers: ["model_refusal"],
          models: [FALLBACK_A],
        },
      })
    ).toEqual({
      [SOURCE]: { enabled: true, triggers: ["model_refusal"], models: [FALLBACK_A] },
    });
  });
});

describe("DEFAULT_MODEL_FALLBACKS", () => {
  it("survives sanitization unchanged", () => {
    // The config seed writes the constant verbatim while every read path
    // sanitizes; a default that violates chain invariants (self-fallback,
    // non-canonical key, over-limit chain) would be silently dropped on read,
    // turning the shipped default into a no-op.
    expect(sanitizeModelFallbacks(DEFAULT_MODEL_FALLBACKS)).toEqual(DEFAULT_MODEL_FALLBACKS);
  });

  it("is deeply frozen so shared references cannot be mutated in place", () => {
    for (const [sourceModel, entry] of Object.entries(DEFAULT_MODEL_FALLBACKS)) {
      expect(() => entry.models.push(sourceModel)).toThrow();
      expect(() => {
        entry.enabled = false;
      }).toThrow();
    }
  });
});

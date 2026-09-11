import { describe, expect, test } from "bun:test";

import type { ProvidersConfigMap } from "@/common/orpc/types";
import { isModelServableWithProvidersConfig } from "./modelAvailability";

const MODEL = "anthropic:claude-haiku-4-5";

function providers(entry: { isConfigured: boolean; isEnabled?: boolean }): ProvidersConfigMap {
  return { anthropic: entry } as unknown as ProvidersConfigMap;
}

describe("isModelServableWithProvidersConfig", () => {
  test("serves a model whose direct provider is configured", () => {
    expect(
      isModelServableWithProvidersConfig({
        canonicalModel: MODEL,
        routePriority: ["direct"],
        providersConfig: providers({ isConfigured: true }),
      })
    ).toBe(true);
  });

  test("a custom provider shadowing a built-in gateway id is not catalog-gated", () => {
    // The factory hands arbitrary model ids straight to a custom adapter, so
    // its non-exhaustive `models` list must not reject a class model the same
    // send-path would serve. The built-in gateway keeps its authoritative rule.
    const custom = {
      "github-copilot": {
        providerType: "openai-compatible",
        isConfigured: true,
        isEnabled: true,
        models: [{ id: "listed-model" }],
      },
    } as unknown as ProvidersConfigMap;
    expect(
      isModelServableWithProvidersConfig({
        canonicalModel: "github-copilot:team-model",
        routePriority: ["direct"],
        providersConfig: custom,
      })
    ).toBe(true);
    const builtIn = {
      "github-copilot": {
        isConfigured: true,
        isEnabled: true,
        models: [{ id: "listed-model" }],
      },
    } as unknown as ProvidersConfigMap;
    expect(
      isModelServableWithProvidersConfig({
        canonicalModel: "github-copilot:team-model",
        routePriority: ["direct"],
        providersConfig: builtIn,
      })
    ).toBe(false);
  });

  test("rejects a model whose provider is not configured", () => {
    expect(
      isModelServableWithProvidersConfig({
        canonicalModel: MODEL,
        routePriority: ["direct"],
        providersConfig: providers({ isConfigured: false }),
      })
    ).toBe(false);
  });

  test("a disabled provider does not count as configured", () => {
    expect(
      isModelServableWithProvidersConfig({
        canonicalModel: MODEL,
        routePriority: ["direct"],
        providersConfig: providers({ isConfigured: true, isEnabled: false }),
      })
    ).toBe(false);
  });

  test("the direct fallback serves a configured provider even outside the priority list", () => {
    // resolveRoute exhausts the priority list and then falls back to direct,
    // so an ordinary send succeeds whenever the direct provider is
    // credentialed — availability must agree, or the class gate would reject
    // a model the same send-path serves.
    expect(
      isModelServableWithProvidersConfig({
        canonicalModel: MODEL,
        routePriority: [],
        providersConfig: providers({ isConfigured: true }),
      })
    ).toBe(true);
  });

  test("the direct fallback still requires the provider to be configured", () => {
    expect(
      isModelServableWithProvidersConfig({
        canonicalModel: MODEL,
        routePriority: [],
        providersConfig: providers({ isConfigured: false }),
      })
    ).toBe(false);
  });

  test("route priority defaults to direct when omitted", () => {
    expect(
      isModelServableWithProvidersConfig({
        canonicalModel: MODEL,
        providersConfig: providers({ isConfigured: true }),
      })
    ).toBe(true);
  });

  describe("coder gateway identities", () => {
    test("a known-but-unmappable instance never falls back through its name", () => {
      // The instance is NAMED "anthropic" but typed openai-compat: the
      // factory keeps the raw coder seed and fails the send when Coder is
      // unavailable, so availability must not pass it through configured
      // direct Anthropic via the name-parsed canonical.
      expect(
        isModelServableWithProvidersConfig({
          canonicalModel: "coder:anthropic/claude-haiku-4-5",
          routePriority: ["direct"],
          providersConfig: {
            coder: {
              isConfigured: false,
              discoveredProviders: [{ name: "anthropic", type: "openai-compat" }],
            },
            anthropic: { isConfigured: true },
          } as unknown as ProvidersConfigMap,
        })
      ).toBe(false);
    });

    test("the coder gateway itself serves its models when configured", () => {
      expect(
        isModelServableWithProvidersConfig({
          canonicalModel: "coder:anthropic/claude-haiku-4-5",
          routePriority: ["direct"],
          providersConfig: {
            coder: {
              isConfigured: true,
              discoveredProviders: [{ name: "anthropic", type: "openai-compat" }],
            },
          } as unknown as ProvidersConfigMap,
        })
      ).toBe(true);
    });

    test("metadata identity beats the name-parsed canonical for the fallback", () => {
      // Instance NAMED "openai" but TYPED anthropic: the fallback route is
      // anthropic:<model>, so configured OpenAI alone must not claim it…
      const crossTyped = {
        coder: {
          isConfigured: false,
          discoveredProviders: [{ name: "openai", type: "anthropic" }],
        },
        openai: { isConfigured: true, apiKeySet: true },
      };
      expect(
        isModelServableWithProvidersConfig({
          canonicalModel: "coder:openai/claude-haiku-4-5",
          routePriority: ["direct"],
          providersConfig: crossTyped as unknown as ProvidersConfigMap,
        })
      ).toBe(false);
      // …while configured Anthropic does.
      expect(
        isModelServableWithProvidersConfig({
          canonicalModel: "coder:openai/claude-haiku-4-5",
          routePriority: ["direct"],
          providersConfig: {
            ...crossTyped,
            anthropic: { isConfigured: true },
          } as unknown as ProvidersConfigMap,
        })
      ).toBe(true);
    });

    test("an unknown instance falls back generically like the factory's seed", () => {
      // No discovered/additional providers: the factory seeds the
      // name-parsed canonical, so availability mirrors that leniency.
      expect(
        isModelServableWithProvidersConfig({
          canonicalModel: "coder:anthropic/claude-haiku-4-5",
          routePriority: ["direct"],
          providersConfig: {
            coder: { isConfigured: false },
            anthropic: { isConfigured: true },
          } as unknown as ProvidersConfigMap,
        })
      ).toBe(true);
    });
  });

  describe("direct OpenAI credential gating", () => {
    function openaiProviders(entry: Record<string, unknown>): ProvidersConfigMap {
      return { openai: { isConfigured: true, ...entry } } as unknown as ProvidersConfigMap;
    }

    test("an OAuth-only config cannot serve an OAuth-ineligible model directly", () => {
      // gpt-5.5-pro is not in the Codex OAuth allowed set: with no API key the
      // factory would reject the direct route (api_key_not_found), so
      // availability must not claim it.
      expect(
        isModelServableWithProvidersConfig({
          canonicalModel: "openai:gpt-5.5-pro",
          routePriority: ["direct"],
          providersConfig: openaiProviders({ codexOauthSet: true }),
        })
      ).toBe(false);
    });

    test("an OAuth-only config serves OAuth-allowed models directly", () => {
      expect(
        isModelServableWithProvidersConfig({
          canonicalModel: "openai:gpt-5.5",
          routePriority: ["direct"],
          providersConfig: openaiProviders({ codexOauthSet: true }),
        })
      ).toBe(true);
    });

    test("an OAuth-only config pinned to chatCompletions cannot serve OAuth-allowed models directly", () => {
      // Codex OAuth only speaks the Responses endpoint: the factory rejects
      // chatCompletions + OAuth-only with api_key_not_found, so direct must
      // not claim the model (a configured gateway should win instead).
      expect(
        isModelServableWithProvidersConfig({
          canonicalModel: "openai:gpt-5.5",
          routePriority: ["direct"],
          providersConfig: openaiProviders({ codexOauthSet: true, wireFormat: "chatCompletions" }),
        })
      ).toBe(false);
    });

    test("a request-level chatCompletions wire format gates an OAuth-only direct route too", () => {
      // With no stored wire format the factory honors the request's own
      // (providerOptions.openai.wireFormat) and rejects OAuth-only credentials
      // for it; the class verdict must judge the same request, while an API
      // key still serves the Chat Completions send.
      expect(
        isModelServableWithProvidersConfig({
          canonicalModel: "openai:gpt-5.5",
          routePriority: ["direct"],
          providersConfig: openaiProviders({ codexOauthSet: true }),
          openaiWireFormat: "chatCompletions",
        })
      ).toBe(false);
      expect(
        isModelServableWithProvidersConfig({
          canonicalModel: "openai:gpt-5.5",
          routePriority: ["direct"],
          providersConfig: openaiProviders({ apiKeySet: true }),
          openaiWireFormat: "chatCompletions",
        })
      ).toBe(true);
    });

    test("an API key serves OAuth-ineligible models directly", () => {
      expect(
        isModelServableWithProvidersConfig({
          canonicalModel: "openai:gpt-5.5-pro",
          routePriority: ["direct"],
          providersConfig: openaiProviders({ apiKeySet: true }),
        })
      ).toBe(true);
    });

    test("a custom openai-compatible provider shadowing the openai id is exempt from OAuth gating", () => {
      // Keyless custom endpoints authenticate on their own terms; built-in
      // OpenAI credential rules must not mark their models unavailable.
      expect(
        isModelServableWithProvidersConfig({
          canonicalModel: "openai:gpt-5.5-pro",
          routePriority: ["direct"],
          providersConfig: openaiProviders({ providerType: "openai-compatible" }),
        })
      ).toBe(true);
    });

    test("an API key serves OAuth-preferred models too (factory falls back to the key)", () => {
      expect(
        isModelServableWithProvidersConfig({
          canonicalModel: "openai:gpt-5.3-codex-spark",
          routePriority: ["direct"],
          providersConfig: openaiProviders({ apiKeySet: true }),
        })
      ).toBe(true);
    });
  });
});

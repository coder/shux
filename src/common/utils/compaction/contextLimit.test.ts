import { describe, expect, test } from "bun:test";
import { KNOWN_MODELS } from "@/common/constants/knownModels";
import type { ProvidersConfigMap } from "@/common/orpc/types";
import { getModelStats } from "@/common/utils/tokens/modelStats";
import { getEffectiveContextLimit } from "./contextLimit";

type ProviderConfigInfo = NonNullable<ProvidersConfigMap[string]>;

function providersWithOpenAI(overrides: Partial<ProviderConfigInfo>): ProvidersConfigMap {
  return {
    openai: {
      apiKeySet: false,
      isEnabled: true,
      isConfigured: true,
      ...overrides,
    },
  };
}

describe("getEffectiveContextLimit", () => {
  test("uses mapped model metadata for context limits", () => {
    const config: ProvidersConfigMap = {
      ollama: {
        apiKeySet: false,
        isEnabled: true,
        isConfigured: true,
        models: [{ id: "custom", mappedToModel: KNOWN_MODELS.SONNET.id }],
      },
    };

    const mappedStats = getModelStats(KNOWN_MODELS.SONNET.id);
    expect(mappedStats).not.toBeNull();

    const limit = getEffectiveContextLimit("ollama:custom", false, config);
    expect(limit).toBe(mappedStats?.max_input_tokens ?? null);
  });

  test("does not inherit the Anthropic beta toggle from a mapped model", () => {
    const config: ProvidersConfigMap = {
      ollama: {
        apiKeySet: false,
        isEnabled: true,
        isConfigured: true,
        models: [{ id: "custom", mappedToModel: KNOWN_MODELS.SONNET.id }],
      },
    };

    // Optional Anthropic beta 1M remains a runtime capability, not something a custom
    // runtime inherits just because its metadata maps to a Claude family. Native 1M models
    // still contribute their published context window through metadata.
    const mappedStats = getModelStats(KNOWN_MODELS.SONNET.id);
    const limit = getEffectiveContextLimit("ollama:custom", true, config);
    expect(limit).toBe(mappedStats?.max_input_tokens ?? null);
  });

  test("uses GPT-5.5's native 1.05M context without the 1M toggle", () => {
    const baseLimit = getEffectiveContextLimit("openai:gpt-5.5", false, null);
    const toggledLimit = getEffectiveContextLimit("openai:gpt-5.5", true, null);

    expect(baseLimit).toBe(1_050_000);
    expect(toggledLimit).toBe(1_050_000);
  });

  test("uses frontier Grok's published 500K context window", () => {
    expect(getEffectiveContextLimit(KNOWN_MODELS.GROK_46.id, false, null)).toBe(500_000);
    expect(getEffectiveContextLimit("xai:grok-4.6-latest", false, null)).toBe(500_000);
    expect(getEffectiveContextLimit("xai:grok-4.5", false, null)).toBe(500_000);
  });

  test("caps GPT-5.5 at the Codex OAuth context window when OAuth is the active auth route", () => {
    const oauthOnlyLimit = getEffectiveContextLimit(
      "openai:gpt-5.5",
      false,
      providersWithOpenAI({ codexOauthSet: true })
    );
    expect(oauthOnlyLimit).toBe(272_000);

    const defaultOauthLimit = getEffectiveContextLimit(
      "openai:gpt-5.5",
      false,
      providersWithOpenAI({ apiKeySet: true, codexOauthSet: true })
    );
    expect(defaultOauthLimit).toBe(272_000);
  });

  test("inherits the Codex OAuth context cap from a mapped OpenAI model", () => {
    const limit = getEffectiveContextLimit(
      "openai:team-gpt",
      false,
      providersWithOpenAI({
        codexOauthSet: true,
        models: [{ id: "team-gpt", mappedToModel: "gpt-5.5" }],
      })
    );

    expect(limit).toBe(272_000);
  });

  test("caps the GPT-5.6 family at each tier's Codex OAuth context window", () => {
    const contextLimits = {
      "gpt-5.6": 372_000,
      "gpt-5.6-sol": 372_000,
      "gpt-5.6-terra": 372_000,
      "gpt-5.6-luna": 372_000,
    } as const;

    for (const [model, contextLimit] of Object.entries(contextLimits)) {
      const oauthOnlyLimit = getEffectiveContextLimit(
        `openai:${model}`,
        false,
        providersWithOpenAI({ codexOauthSet: true })
      );
      expect(oauthOnlyLimit).toBe(contextLimit);
    }
  });

  test("caps GPT-6 Astra on the OAuth route but keeps the API window for API-key auth", () => {
    const oauthOnlyLimit = getEffectiveContextLimit(
      "openai:gpt-6-astra",
      false,
      providersWithOpenAI({ codexOauthSet: true })
    );
    expect(oauthOnlyLimit).toBe(372_000);

    const apiKeyLimit = getEffectiveContextLimit(
      "openai:gpt-6-astra",
      false,
      providersWithOpenAI({
        apiKeySet: true,
        codexOauthSet: true,
        codexOauthDefaultAuth: "apiKey",
      })
    );
    expect(apiKeyLimit).toBe(1_050_000);
  });

  test("does not apply the GPT-5.5 OAuth cap to gateway-routed models", () => {
    const limit = getEffectiveContextLimit(
      "openrouter:openai/gpt-5.5",
      false,
      providersWithOpenAI({ codexOauthSet: true })
    );

    expect(limit).toBe(1_050_000);
  });

  test("keeps GPT-5.5's API context window when API key auth is selected", () => {
    const limit = getEffectiveContextLimit(
      "openai:gpt-5.5",
      false,
      providersWithOpenAI({
        apiKeySet: true,
        codexOauthSet: true,
        codexOauthDefaultAuth: "apiKey",
      })
    );

    expect(limit).toBe(1_050_000);
  });

  test("keeps the API window for Chat Completions when an API key exists, even if OAuth is preferred", () => {
    // Mirrors providerModelFactory: Codex OAuth serves only the Responses API.
    const limit = getEffectiveContextLimit(
      "openai:gpt-5.5",
      false,
      providersWithOpenAI({
        apiKeySet: true,
        codexOauthSet: true,
        codexOauthDefaultAuth: "oauth",
        wireFormat: "chatCompletions",
      })
    );
    expect(limit).toBe(1_050_000);

    // Without an API key there is nothing to fall back to; the OAuth cap stays.
    const oauthOnlyLimit = getEffectiveContextLimit(
      "openai:gpt-5.5",
      false,
      providersWithOpenAI({ codexOauthSet: true, wireFormat: "chatCompletions" })
    );
    expect(oauthOnlyLimit).toBe(272_000);
  });

  test("honors a request-level Chat Completions wire format, with the stored value winning", () => {
    const bothCredsOauthPreferred = providersWithOpenAI({
      apiKeySet: true,
      codexOauthSet: true,
      codexOauthDefaultAuth: "oauth",
    });
    // Stored config leaves wireFormat unset; the request selects Chat Completions,
    // so the factory uses the API key and the OAuth cap must not apply.
    expect(
      getEffectiveContextLimit("openai:gpt-5.5", false, bothCredsOauthPreferred, {
        openaiWireFormat: "chatCompletions",
      })
    ).toBe(1_050_000);

    // A stored Responses wire format wins over the request-level value.
    expect(
      getEffectiveContextLimit(
        "openai:gpt-5.5",
        false,
        providersWithOpenAI({
          apiKeySet: true,
          codexOauthSet: true,
          codexOauthDefaultAuth: "oauth",
          wireFormat: "responses",
        }),
        { openaiWireFormat: "chatCompletions" }
      )
    ).toBe(272_000);

    // OAuth only: no API key to fall back to, so the OAuth cap stays.
    expect(
      getEffectiveContextLimit(
        "openai:gpt-5.5",
        false,
        providersWithOpenAI({ codexOauthSet: true }),
        {
          openaiWireFormat: "chatCompletions",
        }
      )
    ).toBe(272_000);
  });

  test("does not treat unresolved API-key files as active API-key auth", () => {
    const limit = getEffectiveContextLimit(
      "openai:gpt-5.5",
      false,
      providersWithOpenAI({
        apiKeyFile: "/missing/openai-key",
        codexOauthSet: true,
        codexOauthDefaultAuth: "apiKey",
      })
    );

    expect(limit).toBe(272_000);
  });

  test("uses GPT-5.5's API context window for resolved API-key files", () => {
    const limit = getEffectiveContextLimit(
      "openai:gpt-5.5",
      false,
      providersWithOpenAI({
        apiKeyFile: "/readable/openai-key",
        apiKeySource: "file",
        codexOauthSet: true,
        codexOauthDefaultAuth: "apiKey",
      })
    );

    expect(limit).toBe(1_050_000);
  });

  test("detects env-sourced API keys when deciding GPT-5.5 Codex OAuth routing", () => {
    const limit = getEffectiveContextLimit(
      "openai:gpt-5.5",
      false,
      providersWithOpenAI({
        apiKeySource: "env",
        codexOauthSet: true,
        codexOauthDefaultAuth: "apiKey",
      })
    );

    expect(limit).toBe(1_050_000);
  });

  test("uses Claude Sonnet 4.6's native 1M context without the beta toggle", () => {
    const baseLimit = getEffectiveContextLimit(KNOWN_MODELS.SONNET.id, false, null);
    const toggledLimit = getEffectiveContextLimit(KNOWN_MODELS.SONNET.id, true, null);

    expect(baseLimit).toBe(1_000_000);
    expect(toggledLimit).toBe(1_000_000);
  });

  test("prefers custom context overrides over mapped model stats", () => {
    const config: ProvidersConfigMap = {
      ollama: {
        apiKeySet: false,
        isEnabled: true,
        isConfigured: true,
        models: [
          {
            id: "custom",
            contextWindowTokens: 123_456,
            mappedToModel: KNOWN_MODELS.SONNET.id,
          },
        ],
      },
    };

    const limit = getEffectiveContextLimit("ollama:custom", false, config);
    expect(limit).toBe(123_456);
  });
});

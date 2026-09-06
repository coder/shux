import { describe, expect, mock, test } from "bun:test";

import type { APIClient } from "@/browser/contexts/API";
import {
  applyFastModeServiceTierChange,
  getFastModeProvider,
  getFastModeServiceTierChange,
} from "./fastModeServiceTier";

type ProviderConfigWriter = Pick<APIClient["providers"], "setProviderConfig">;

function createWriter() {
  const setProviderConfig = mock((_input: unknown) =>
    Promise.resolve({ success: true as const, data: undefined })
  );
  return {
    providers: { setProviderConfig } as unknown as ProviderConfigWriter,
    setProviderConfig,
  };
}

describe("fast mode service tier", () => {
  test("uses the project account and preserves the API-key preference", () => {
    const providersConfig = {
      openai: {
        apiKeySet: true,
        isEnabled: true,
        isConfigured: true,
        codexOauthSet: true,
        codexOauthAccounts: [{ id: "work", label: "Work" }],
      },
    };
    expect(
      getFastModeProvider("openai:gpt-5.5", {
        providersConfig,
        codexOauthAccountId: "work",
      })
    ).toBeNull();
    expect(
      getFastModeProvider("openai:gpt-5.5", {
        providersConfig: { openai: { ...providersConfig.openai, codexOauthDefaultAuth: "apiKey" } },
        codexOauthAccountId: "work",
      })
    ).toBe("openai");
  });

  test("resolves direct native providers and rejects gateway routes", () => {
    expect(getFastModeProvider("openai:gpt-5.6-sol", { resolvedRouteProvider: "direct" })).toBe(
      "openai"
    );
    expect(getFastModeProvider("xai:grok-4.6", { resolvedRouteProvider: "direct" })).toBe("xai");
    expect(getFastModeProvider("xai:grok-4.5", { resolvedRouteProvider: "direct" })).toBe("xai");
    expect(getFastModeProvider("xai:grok-4.6", { resolvedRouteProvider: "openrouter" })).toBeNull();
    expect(
      getFastModeProvider("xai:team-grok", {
        resolvedRouteProvider: "direct",
        providersConfig: {
          xai: {
            apiKeySet: true,
            isEnabled: true,
            isConfigured: true,
            models: [{ id: "team-grok", mappedToModel: "xai:grok-4.5" }],
          },
        },
      })
    ).toBe("xai");
    expect(
      getFastModeProvider("xai:grok-code-fast-1", { resolvedRouteProvider: "direct" })
    ).toBeNull();
    expect(getFastModeProvider("anthropic:claude-sonnet-4-5")).toBeNull();
  });

  test("restores flex from the shared provider config", () => {
    expect(getFastModeServiceTierChange("openai", "priority", "flex")).toEqual({
      apiValue: "flex",
      serviceTier: "flex",
      previousServiceTier: undefined,
    });
  });

  test("persists the restore tier before enabling Fast mode", async () => {
    const { providers, setProviderConfig } = createWriter();

    const change = await applyFastModeServiceTierChange(providers, "openai", "flex");

    expect(change).toEqual({
      apiValue: "priority",
      serviceTier: "priority",
      previousServiceTier: "flex",
    });
    expect(setProviderConfig.mock.calls).toEqual([
      [
        {
          provider: "openai",
          keyPath: ["fastModePreviousServiceTier"],
          value: "flex",
        },
      ],
      [
        {
          provider: "openai",
          keyPath: ["serviceTier"],
          value: "priority",
        },
      ],
    ]);
  });

  test("restores and clears the shared tier when disabling Fast mode", async () => {
    const { providers, setProviderConfig } = createWriter();

    const change = await applyFastModeServiceTierChange(providers, "openai", "priority", "default");

    expect(change).toEqual({
      apiValue: "default",
      serviceTier: "default",
      previousServiceTier: undefined,
    });
    expect(setProviderConfig.mock.calls).toEqual([
      [
        {
          provider: "openai",
          keyPath: ["serviceTier"],
          value: "default",
        },
      ],
      [
        {
          provider: "openai",
          keyPath: ["fastModePreviousServiceTier"],
          value: "",
        },
      ],
    ]);
  });

  test("restores an unset tier with the backend removal value", async () => {
    const { providers, setProviderConfig } = createWriter();

    const change = await applyFastModeServiceTierChange(providers, "openai", "priority", "unset");

    expect(change?.serviceTier).toBeUndefined();
    expect(setProviderConfig.mock.calls[0]).toEqual([
      {
        provider: "openai",
        keyPath: ["serviceTier"],
        value: "",
      },
    ]);
  });

  test("uses provider-valid fallbacks for legacy priority config without a restore tier", () => {
    expect(getFastModeServiceTierChange("openai", "priority").serviceTier).toBe("auto");
    expect(getFastModeServiceTierChange("xai", "priority").serviceTier).toBe("default");
  });

  test("writes xAI fast mode to the xAI provider config", async () => {
    const { providers, setProviderConfig } = createWriter();

    await applyFastModeServiceTierChange(providers, "xai", "default");

    expect(setProviderConfig.mock.calls).toEqual([
      [
        {
          provider: "xai",
          keyPath: ["fastModePreviousServiceTier"],
          value: "default",
        },
      ],
      [
        {
          provider: "xai",
          keyPath: ["serviceTier"],
          value: "priority",
        },
      ],
    ]);
  });
});

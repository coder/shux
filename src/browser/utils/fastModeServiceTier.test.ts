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

  test("offers the shared OpenAI tier on explicit and preference-routed gateways", () => {
    for (const route of ["coder", "openrouter", "mux-gateway", "github-copilot"]) {
      const providersConfig = {
        [route]: { apiKeySet: true, isConfigured: true, isEnabled: true },
        openai: { apiKeySet: false, isEnabled: true, isConfigured: false, codexOauthSet: true },
      };
      expect(
        getFastModeProvider("openai:gpt-6-astra", { resolvedRouteProvider: route, providersConfig })
      ).toBe("openai");
      const modelId = route === "github-copilot" ? "gpt-6-astra" : "openai/gpt-6-astra";
      expect(getFastModeProvider(`${route}:${modelId}`, { providersConfig })).toBe("openai");
    }
  });

  test("uses Coder instance types rather than names or capability mappings", () => {
    const provider = (name: string, type?: string) =>
      getFastModeProvider(`coder:${name}/gpt-6-astra`, {
        resolvedRouteProvider: "coder",
        providersConfig: {
          coder: {
            apiKeySet: false,
            isEnabled: true,
            isConfigured: true,
            discoveredProviders: type ? [{ name, type }] : [],
            models: [{ id: `${name}/gpt-6-astra`, mappedToModel: "openai:gpt-6-astra" }],
          },
        },
      });
    expect(provider("prod-ai", "openai")).toBe("openai");
    expect(provider("chat-proxy", "openai-compat")).toBe("openai");
    expect(provider("openai", "anthropic")).toBeNull();
    expect(provider("openai", "google")).toBeNull();
    expect(provider("openai", "copilot")).toBeNull();
    expect(provider("unknown-instance")).toBeNull();
  });

  test("excludes only the actual Codex OAuth transport", () => {
    const providersConfig = {
      openai: { apiKeySet: false, isEnabled: true, isConfigured: true, codexOauthSet: true },
      coder: { apiKeySet: false, isConfigured: true, isEnabled: false },
    };
    expect(getFastModeProvider("openai:gpt-6-astra", { providersConfig })).toBeNull();
    expect(
      getFastModeProvider("coder:openai/gpt-6-astra", {
        providersConfig,
        resolvedRouteProvider: "direct",
      })
    ).toBeNull();
    expect(
      getFastModeProvider("openai:gpt-6-astra", {
        providersConfig: {
          openai: { ...providersConfig.openai, apiKeySet: true, wireFormat: "chatCompletions" },
        },
      })
    ).toBe("openai");
  });

  test("follows a custom-named Coder instance's fallback without treating mappings as routes", () => {
    const providersConfig = {
      coder: {
        apiKeySet: false,
        isConfigured: true,
        isEnabled: false,
        discoveredProviders: [{ name: "prod-ai", type: "openai" }],
      },
    };
    expect(
      getFastModeProvider("coder:prod-ai/gpt-6-astra", {
        providersConfig,
        resolvedRouteProvider: "direct",
      })
    ).toBe("openai");
    for (const model of [
      "openrouter:anthropic/claude-sonnet-4-5",
      "github-copilot:claude-sonnet-4.5",
      "github-copilot:gemini-3-pro",
    ]) {
      expect(getFastModeProvider(model)).toBeNull();
    }
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

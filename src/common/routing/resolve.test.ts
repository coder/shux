import { describe, expect, test } from "bun:test";

import { isCopilotModelAccessible } from "../utils/copilot/modelRouting";

import { availableRoutes, isModelAvailable, resolveRoute } from "./resolve";

const MODEL = "anthropic:claude-opus-4-6";
const OPENAI_MODEL = "openai:gpt-5.5";

const EXPLICIT_GATEWAY_MODEL = "openrouter:openai/gpt-5";
const EXPLICIT_COPILOT_MODEL = "github-copilot:gpt-5.5";

function createIsConfigured(configuredProviders: string[]): (provider: string) => boolean {
  const configuredSet = new Set(configuredProviders);
  return (provider: string): boolean => configuredSet.has(provider);
}

function createIsGatewayModelAccessible(
  inaccessibleGatewayModels: Array<[gateway: string, modelId: string]>
): (gateway: string, modelId: string) => boolean {
  const inaccessibleSet = new Set(
    inaccessibleGatewayModels.map(([gateway, modelId]) => `${gateway}:${modelId}`)
  );
  return (gateway: string, modelId: string): boolean =>
    !inaccessibleSet.has(`${gateway}:${modelId}`);
}

function createIsGatewayModelAccessibleFromCopilotCatalog(
  availableCopilotModels: string[]
): (gateway: string, modelId: string) => boolean {
  return (gateway: string, modelId: string): boolean =>
    gateway !== "github-copilot" || isCopilotModelAccessible(modelId, availableCopilotModels);
}

function isModelAvailableForRoutes(options: {
  modelId: string;
  configuredProviders: string[];
  routePriority: string[];
  routeOverrides?: Record<string, string>;
  isGatewayModelAccessible?: (gateway: string, modelId: string) => boolean;
}): boolean {
  return isModelAvailable(
    options.modelId,
    options.routePriority,
    options.routeOverrides ?? {},
    createIsConfigured(options.configuredProviders),
    options.isGatewayModelAccessible
  );
}

describe("resolveRoute", () => {
  test("walks route priority: mux-gateway, then openrouter, then direct", () => {
    const routePriority = ["mux-gateway", "openrouter", "direct"];

    const firstConfigured = resolveRoute(
      MODEL,
      routePriority,
      {},
      createIsConfigured(["mux-gateway", "openrouter", "anthropic"])
    );
    expect(firstConfigured.routeProvider).toBe("mux-gateway");
    expect(firstConfigured.routeModelId).toBe("anthropic/claude-opus-4-6");

    const secondConfigured = resolveRoute(
      MODEL,
      routePriority,
      {},
      createIsConfigured(["openrouter", "anthropic"])
    );
    expect(secondConfigured.routeProvider).toBe("openrouter");
    expect(secondConfigured.routeModelId).toBe("anthropic/claude-opus-4-6");

    const thirdConfigured = resolveRoute(
      MODEL,
      routePriority,
      {},
      createIsConfigured(["anthropic"])
    );
    expect(thirdConfigured.routeProvider).toBe("anthropic");
    expect(thirdConfigured.routeModelId).toBe("claude-opus-4-6");
  });

  test("falls through to the next route when a gateway rejects the model", () => {
    const resolved = resolveRoute(
      OPENAI_MODEL,
      ["github-copilot", "direct"],
      {},
      createIsConfigured(["github-copilot", "openai"]),
      createIsGatewayModelAccessible([["github-copilot", "gpt-5.5"]])
    );

    expect(resolved.routeProvider).toBe("openai");
    expect(resolved.routeModelId).toBe("gpt-5.5");
  });

  test("selects GitHub Copilot when the gateway accepts the model", () => {
    const resolved = resolveRoute(
      OPENAI_MODEL,
      ["github-copilot", "direct"],
      {},
      createIsConfigured(["github-copilot", "openai"]),
      createIsGatewayModelAccessible([])
    );

    expect(resolved.routeProvider).toBe("github-copilot");
    expect(resolved.routeModelId).toBe("gpt-5.5");
  });

  test("routes Anthropic models through GitHub Copilot when the catalog stores a dot-form model ID", () => {
    const resolved = resolveRoute(
      MODEL,
      ["github-copilot", "direct"],
      {},
      createIsConfigured(["github-copilot", "anthropic"]),
      createIsGatewayModelAccessibleFromCopilotCatalog(["claude-opus-4.6"])
    );

    expect(resolved.routeProvider).toBe("github-copilot");
    expect(resolved.routeModelId).toBe("claude-opus-4-6");
  });

  test("routes OpenAI models through GitHub Copilot without adding a prefix when no callback is provided", () => {
    const resolved = resolveRoute(
      OPENAI_MODEL,
      ["github-copilot", "direct"],
      {},
      createIsConfigured(["github-copilot", "openai"])
    );

    expect(resolved.routeProvider).toBe("github-copilot");
    expect(resolved.routeModelId).toBe("gpt-5.5");
  });

  test("preserves explicit gateway-scoped OpenAI routes without double-prefixing", () => {
    const resolved = resolveRoute(
      EXPLICIT_GATEWAY_MODEL,
      ["openrouter", "direct"],
      {},
      createIsConfigured(["openrouter"])
    );

    expect(resolved.routeProvider).toBe("openrouter");
    expect(resolved.routeModelId).toBe("openai/gpt-5");
  });

  test("falls back from explicit gateway to mux-gateway when explicit is unconfigured", () => {
    const resolved = resolveRoute(
      EXPLICIT_GATEWAY_MODEL,
      ["openrouter", "mux-gateway", "direct"],
      {},
      createIsConfigured(["mux-gateway"])
    );

    expect(resolved.routeProvider).toBe("mux-gateway");
    expect(resolved.routeModelId).toBe("openai/gpt-5");
  });

  test("explicit gateway input uses canonical route override on fallback", () => {
    const route = resolveRoute(
      EXPLICIT_GATEWAY_MODEL,
      ["direct"],
      { "openai:gpt-5": "mux-gateway" },
      createIsConfigured(["mux-gateway"])
    );

    expect(route).not.toBeNull();
    expect(route.routeProvider).toBe("mux-gateway");
    expect(route.canonical).toBe("openai:gpt-5");
  });

  test("falls back to direct for explicit gateway when nothing is configured", () => {
    const resolved = resolveRoute(
      EXPLICIT_GATEWAY_MODEL,
      ["openrouter", "mux-gateway", "direct"],
      {},
      () => false
    );

    expect(resolved.routeProvider).toBe("openai");
    expect(resolved.routeModelId).toBe("gpt-5");
  });

  test("falls back from explicit gateway input when the explicit route rejects the model", () => {
    const resolved = resolveRoute(
      EXPLICIT_GATEWAY_MODEL,
      ["direct"],
      {},
      createIsConfigured(["openrouter", "openai"]),
      createIsGatewayModelAccessible([["openrouter", "openai/gpt-5"]])
    );

    expect(resolved.routeProvider).toBe("openai");
    expect(resolved.routeModelId).toBe("gpt-5");
  });

  test("supports per-model override to specific gateway", () => {
    const resolved = resolveRoute(
      MODEL,
      ["mux-gateway", "direct"],
      { [MODEL]: "openrouter" },
      createIsConfigured(["openrouter", "mux-gateway", "anthropic"])
    );

    expect(resolved.routeProvider).toBe("openrouter");
    expect(resolved.routeModelId).toBe("anthropic/claude-opus-4-6");
  });

  test("supports per-model override to GitHub Copilot for OpenAI models", () => {
    const resolved = resolveRoute(
      OPENAI_MODEL,
      ["direct"],
      { [OPENAI_MODEL]: "github-copilot" },
      createIsConfigured(["github-copilot"])
    );

    expect(resolved.routeProvider).toBe("github-copilot");
    expect(resolved.routeModelId).toBe("gpt-5.5");
  });

  test("direct override still resolves directly when origin is configured", () => {
    const resolved = resolveRoute(
      MODEL,
      ["mux-gateway", "openrouter"],
      { [MODEL]: "direct" },
      createIsConfigured(["mux-gateway", "openrouter", "anthropic"])
    );

    expect(resolved.routeProvider).toBe("anthropic");
    expect(resolved.routeModelId).toBe("claude-opus-4-6");
  });

  test("direct override falls through when origin is not configured", () => {
    const resolved = resolveRoute(
      MODEL,
      ["mux-gateway", "openrouter", "direct"],
      { [MODEL]: "direct" },
      createIsConfigured(["mux-gateway", "openrouter"])
    );

    expect(resolved.routeProvider).toBe("mux-gateway");
    expect(resolved.routeModelId).toBe("anthropic/claude-opus-4-6");
  });

  test("origin-name override falls through when origin is not configured", () => {
    const resolved = resolveRoute(
      MODEL,
      ["openrouter", "direct"],
      { [MODEL]: "anthropic" },
      createIsConfigured(["openrouter"])
    );

    expect(resolved.routeProvider).toBe("openrouter");
    expect(resolved.routeModelId).toBe("anthropic/claude-opus-4-6");
  });

  test("falls through priority list when override gateway is unconfigured", () => {
    const resolved = resolveRoute(
      MODEL,
      ["mux-gateway", "direct"],
      { [MODEL]: "openrouter" },
      createIsConfigured(["mux-gateway", "anthropic"])
    );

    expect(resolved.routeProvider).toBe("mux-gateway");
  });

  test("empty overrides ignores per-model override and walks priority list", () => {
    // With the override, resolves to openrouter:
    const withOverride = resolveRoute(
      MODEL,
      ["direct", "openrouter"],
      { [MODEL]: "openrouter" },
      createIsConfigured(["anthropic", "openrouter"])
    );
    expect(withOverride.routeProvider).toBe("openrouter");

    // With empty overrides (Auto), walks priority and picks direct:
    const withoutOverride = resolveRoute(
      MODEL,
      ["direct", "openrouter"],
      {},
      createIsConfigured(["anthropic", "openrouter"])
    );
    expect(withoutOverride.routeProvider).toBe("anthropic");
    expect(withoutOverride.routeModelId).toBe("claude-opus-4-6");
  });

  test('matches "direct" route entry when origin is configured', () => {
    const resolved = resolveRoute(
      MODEL,
      ["direct", "openrouter"],
      {},
      createIsConfigured(["anthropic", "openrouter"])
    );

    expect(resolved.routeProvider).toBe("anthropic");
    expect(resolved.routeModelId).toBe("claude-opus-4-6");
  });

  test("falls through when GitHub Copilot rejects an Anthropic model", () => {
    const resolved = resolveRoute(
      MODEL,
      ["github-copilot", "direct"],
      {},
      createIsConfigured(["github-copilot", "anthropic"]),
      createIsGatewayModelAccessible([["github-copilot", "claude-opus-4-6"]])
    );

    expect(resolved.routeProvider).toBe("anthropic");
    expect(resolved.routeModelId).toBe("claude-opus-4-6");
  });

  test("falls back to direct when nothing is configured", () => {
    const resolved = resolveRoute(MODEL, ["mux-gateway", "openrouter", "direct"], {}, () => false);

    expect(resolved.routeProvider).toBe("anthropic");
    expect(resolved.routeModelId).toBe("claude-opus-4-6");
  });

  test("routes Anthropic models through Bedrock with dot-separated format", () => {
    const resolved = resolveRoute(
      MODEL,
      ["bedrock", "direct"],
      {},
      createIsConfigured(["bedrock", "anthropic"])
    );

    expect(resolved.routeProvider).toBe("bedrock");
    expect(resolved.routeModelId).toBe("anthropic.claude-opus-4-6");
  });
});

describe("isModelAvailable", () => {
  test("returns true when direct route is configured", () => {
    expect(
      isModelAvailableForRoutes({
        modelId: MODEL,
        configuredProviders: ["anthropic"],
        routePriority: ["direct"],
      })
    ).toBe(true);
  });

  test("returns true for explicit gateway-scoped models when only the direct provider is configured", () => {
    expect(
      isModelAvailableForRoutes({
        modelId: EXPLICIT_GATEWAY_MODEL,
        configuredProviders: ["openai"],
        routePriority: ["direct"],
      })
    ).toBe(true);
  });

  test("returns true for explicit gateway-scoped models when the gateway is configured", () => {
    expect(
      isModelAvailableForRoutes({
        modelId: EXPLICIT_GATEWAY_MODEL,
        configuredProviders: ["openrouter"],
        routePriority: ["openrouter", "direct"],
      })
    ).toBe(true);
  });

  test("returns true for explicit gateway models when a fallback route is configured", () => {
    expect(
      isModelAvailableForRoutes({
        modelId: EXPLICIT_GATEWAY_MODEL,
        configuredProviders: ["mux-gateway"],
        routePriority: ["openrouter", "mux-gateway", "direct"],
      })
    ).toBe(true);
  });

  test("returns false for explicit gateway models when the configured gateway rejects the model", () => {
    expect(
      isModelAvailableForRoutes({
        modelId: EXPLICIT_COPILOT_MODEL,
        configuredProviders: ["github-copilot"],
        routePriority: ["direct"],
        isGatewayModelAccessible: createIsGatewayModelAccessible([["github-copilot", "gpt-5.5"]]),
      })
    ).toBe(false);
  });

  test("returns true when gateway route is configured", () => {
    expect(
      isModelAvailableForRoutes({
        modelId: MODEL,
        configuredProviders: ["openrouter"],
        routePriority: ["openrouter", "direct"],
      })
    ).toBe(true);
  });

  test("returns true when Bedrock can route the model", () => {
    expect(
      isModelAvailableForRoutes({
        modelId: MODEL,
        configuredProviders: ["bedrock"],
        routePriority: ["bedrock", "direct"],
      })
    ).toBe(true);
  });

  test("returns true when GitHub Copilot can route an OpenAI model", () => {
    expect(
      isModelAvailableForRoutes({
        modelId: OPENAI_MODEL,
        configuredProviders: ["github-copilot"],
        routePriority: ["github-copilot", "direct"],
      })
    ).toBe(true);
  });

  test("returns false when a configured gateway is absent from routePriority", () => {
    expect(
      isModelAvailableForRoutes({
        modelId: MODEL,
        configuredProviders: ["openrouter"],
        routePriority: ["direct"],
      })
    ).toBe(false);
  });

  test("returns false when the only gateway route rejects the model", () => {
    expect(
      isModelAvailableForRoutes({
        modelId: OPENAI_MODEL,
        configuredProviders: ["github-copilot"],
        routePriority: ["github-copilot"],
        isGatewayModelAccessible: createIsGatewayModelAccessible([["github-copilot", "gpt-5.5"]]),
      })
    ).toBe(false);
  });

  test("returns true when an override selects a configured gateway outside routePriority", () => {
    expect(
      isModelAvailableForRoutes({
        modelId: MODEL,
        configuredProviders: ["openrouter"],
        routePriority: ["direct"],
        routeOverrides: { [MODEL]: "openrouter" },
      })
    ).toBe(true);
  });

  test("falls through an unconfigured override to a viable priority route", () => {
    expect(
      isModelAvailableForRoutes({
        modelId: MODEL,
        configuredProviders: ["bedrock"],
        routePriority: ["bedrock", "direct"],
        routeOverrides: { [MODEL]: "openrouter" },
      })
    ).toBe(true);
  });

  test("returns false when no route is configured", () => {
    expect(
      isModelAvailableForRoutes({
        modelId: MODEL,
        configuredProviders: [],
        routePriority: ["mux-gateway", "openrouter", "direct"],
      })
    ).toBe(false);
  });
  test("explicit gateway model finds canonical route override on fallback", () => {
    expect(
      isModelAvailableForRoutes({
        modelId: EXPLICIT_GATEWAY_MODEL,
        configuredProviders: ["mux-gateway"],
        routePriority: ["direct"],
        routeOverrides: { "openai:gpt-5": "mux-gateway" },
      })
    ).toBe(true);
  });

  test("explicit bedrock model falls back to direct anthropic when bedrock is unconfigured", () => {
    expect(
      isModelAvailableForRoutes({
        modelId: "bedrock:anthropic.claude-opus-4-6",
        configuredProviders: ["anthropic"],
        routePriority: ["direct"],
      })
    ).toBe(true);
  });

  test("explicit bedrock model falls back to mux-gateway when bedrock is unconfigured", () => {
    expect(
      isModelAvailableForRoutes({
        modelId: "bedrock:anthropic.claude-opus-4-6",
        configuredProviders: ["mux-gateway"],
        routePriority: ["mux-gateway", "direct"],
      })
    ).toBe(true);
  });
});

describe("availableRoutes", () => {
  test("includes GitHub Copilot for OpenAI models when configured", () => {
    const routes = availableRoutes(OPENAI_MODEL, createIsConfigured(["github-copilot"]));

    expect(routes).toEqual([
      {
        route: "mux-gateway",
        displayName: "Xum Gateway",
        isConfigured: false,
      },
      {
        route: "openrouter",
        displayName: "OpenRouter",
        isConfigured: false,
      },
      {
        route: "github-copilot",
        displayName: "GitHub Copilot",
        isConfigured: true,
      },
      {
        route: "coder",
        displayName: "Coder",
        isConfigured: false,
      },
      {
        route: "direct",
        displayName: "Direct (OpenAI)",
        isConfigured: false,
      },
    ]);
  });

  test("includes GitHub Copilot for built-in Anthropic models when Copilot is configured and accepts the model", () => {
    const routes = availableRoutes(
      MODEL,
      createIsConfigured(["anthropic", "github-copilot"]),
      createIsGatewayModelAccessibleFromCopilotCatalog(["claude-opus-4.6"])
    );

    expect(routes).toContainEqual({
      route: "github-copilot",
      displayName: "GitHub Copilot",
      isConfigured: true,
    });
    expect(routes).toContainEqual({
      route: "direct",
      displayName: "Direct (Anthropic)",
      isConfigured: true,
    });
  });

  test("excludes GitHub Copilot for Anthropic models when the catalog rejects the model", () => {
    const routes = availableRoutes(
      MODEL,
      createIsConfigured(["anthropic", "github-copilot"]),
      createIsGatewayModelAccessibleFromCopilotCatalog(["claude-sonnet-4.5"])
    );

    expect(routes.some((route) => route.route === "github-copilot")).toBe(false);
    expect(routes).toContainEqual({
      route: "direct",
      displayName: "Direct (Anthropic)",
      isConfigured: true,
    });
  });

  test("returns all eligible gateways plus direct with configuration status", () => {
    const routes = availableRoutes(MODEL, createIsConfigured(["openrouter", "bedrock"]));

    expect(routes).toEqual([
      {
        route: "mux-gateway",
        displayName: "Xum Gateway",
        isConfigured: false,
      },
      {
        route: "openrouter",
        displayName: "OpenRouter",
        isConfigured: true,
      },
      {
        route: "github-copilot",
        displayName: "GitHub Copilot",
        isConfigured: false,
      },
      {
        route: "coder",
        displayName: "Coder",
        isConfigured: false,
      },
      {
        route: "bedrock",
        displayName: "Bedrock",
        isConfigured: true,
      },
      {
        route: "direct",
        displayName: "Direct (Anthropic)",
        isConfigured: false,
      },
    ]);
  });

  test("excludes direct routes for explicit gateway models that the catalog rejects", () => {
    const routes = availableRoutes(
      EXPLICIT_COPILOT_MODEL,
      createIsConfigured(["github-copilot"]),
      createIsGatewayModelAccessible([["github-copilot", "gpt-5.5"]])
    );

    expect(routes).toEqual([]);
  });

  test("excludes gateway routes that cannot access the model", () => {
    const routes = availableRoutes(
      OPENAI_MODEL,
      createIsConfigured(["github-copilot"]),
      // Coder is excluded via its own catalog entry to prove the gate applies
      // to every gateway, not just Copilot.
      createIsGatewayModelAccessible([
        ["github-copilot", "gpt-5.5"],
        ["coder", "openai/gpt-5.5"],
      ])
    );

    expect(routes).toEqual([
      {
        route: "mux-gateway",
        displayName: "Xum Gateway",
        isConfigured: false,
      },
      {
        route: "openrouter",
        displayName: "OpenRouter",
        isConfigured: false,
      },
      {
        route: "direct",
        displayName: "Direct (OpenAI)",
        isConfigured: false,
      },
    ]);
  });
});

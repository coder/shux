import { afterAll, afterEach, beforeEach, describe, expect, mock, test } from "bun:test";
import { act, cleanup, renderHook, waitFor } from "@testing-library/react";
import * as APIModule from "@/browser/contexts/API";
import * as PolicyContextModule from "@/browser/contexts/PolicyContext";
import * as ProvidersConfigModule from "@/browser/hooks/useProvidersConfig";
import * as RoutingModule from "@/browser/hooks/useRouting";
import { installDom } from "../../../tests/ui/dom";
import {
  filterHiddenModels,
  getDefaultModel,
  getSuggestedModels,
  useModelsFromSettings,
} from "./useModelsFromSettings";
import { DEFAULT_HIDDEN_MODELS, KNOWN_MODELS } from "@/common/constants/knownModels";
import type {
  EffectivePolicy,
  ProviderConfigInfo,
  ProviderModelEntry,
  ProvidersConfigMap,
} from "@/common/orpc/types";
import { updatePersistedState } from "./usePersistedState";
import { shouldShowModelInSettings } from "@/browser/features/Settings/Sections/ModelsSection";
import { DEFAULT_MODEL_KEY, HIDDEN_MODELS_KEY } from "@/common/constants/storage";

function countOccurrences(haystack: string[], needle: string): number {
  return haystack.filter((v) => v === needle).length;
}

let providersConfig: ProvidersConfigMap | null = null;
let routePriority: string[] = ["direct"];
let routeOverrides: Record<string, string> = {};

const OPENROUTER_OPENAI_CUSTOM_MODEL = "openrouter:openai/gpt-5";

// Seed a couple of non-built-in OpenAI entries so these tests exercise real filtering logic
// instead of vacuous "not present because it was never suggested" assertions.
const SEEDED_OPENAI_CUSTOM_MODELS = ["gpt-5.2-codex", "gpt-5.2-pro"];

function customOpenAICompatibleProviderConfig(
  models: ProviderModelEntry[] = []
): ProviderConfigInfo {
  return {
    apiKeySet: true,
    isEnabled: true,
    isConfigured: true,
    isCustom: true,
    providerType: "openai-compatible",
    models,
  };
}

interface TestApi {
  config?: {
    updateModelPreferences?: (patch: {
      defaultModel?: string;
      hiddenModels?: string[];
    }) => Promise<unknown>;
  };
  providers?: {
    getConfig?: () => Promise<ProvidersConfigMap>;
    setModels?: (input: { provider: string; models: string[] }) => Promise<unknown>;
  };
}

let apiMock: TestApi | null = null;
// null = policy disabled (the default); a value = enforced policy.
let enforcedPolicy: EffectivePolicy | null = null;

function buildEnforcedPolicy(
  providerAccess: NonNullable<EffectivePolicy["providerAccess"]>
): EffectivePolicy {
  return {
    policyFormatVersion: "0.1",
    providerAccess,
    mcp: { allowUserDefined: { stdio: true, remote: true } },
    runtimes: null,
  };
}

const useProvidersConfigMock = mock(() => ({
  config: providersConfig,
  refresh: () => Promise.resolve(),
}));

const useRoutingMock = mock(() => ({
  routePriority,
  routeOverrides,
  resolveRoute: () => ({ route: "direct", isAuto: true, displayName: "Direct" }),
  resolveEffectiveRoute: () => "direct",
  availableRoutes: () => [],
  setRoutePreferences: () => {
    /* noop */
  },
  setRoutePriority: () => {
    /* noop */
  },
  setRouteOverride: () => {
    /* noop */
  },
}));

const actualProvidersConfigModule = { ...ProvidersConfigModule };
const actualRoutingModule = { ...RoutingModule };
const actualAPIModule = { ...APIModule };
const actualPolicyContextModule = { ...PolicyContextModule };

// Specifiers mocked by this suite, shared by install/restore so the two helpers can never
// drift: a path that gets mocked but not restored would silently re-introduce the
// cross-suite leakage these helpers exist to prevent.
const PROVIDERS_CONFIG_MODULE = "@/browser/hooks/useProvidersConfig";
const ROUTING_MODULE = "@/browser/hooks/useRouting";
const API_MODULE = "@/browser/contexts/API";
const POLICY_CONTEXT_MODULE = "@/browser/contexts/PolicyContext";

async function installUseModelsModuleMocks() {
  await mock.module(PROVIDERS_CONFIG_MODULE, () => ({
    ...actualProvidersConfigModule,
    useProvidersConfig: useProvidersConfigMock,
  }));
  await mock.module(ROUTING_MODULE, () => ({
    ...actualRoutingModule,
    useRouting: useRoutingMock,
  }));
  await mock.module(API_MODULE, () => ({
    ...actualAPIModule,
    useAPI: () => ({ api: apiMock }),
  }));
  await mock.module(POLICY_CONTEXT_MODULE, () => ({
    ...actualPolicyContextModule,
    usePolicy: () =>
      enforcedPolicy
        ? { status: { state: "enforced" as const }, policy: enforcedPolicy }
        : { status: { state: "disabled" as const }, policy: null },
  }));
}

async function restoreUseModelsModuleMocks() {
  // Bun's mock.module() has no disposer, and mock.restore() does not undo module mocks.
  // Restore the real modules so this file cannot poison later tests in the same process.
  await mock.module(PROVIDERS_CONFIG_MODULE, () => actualProvidersConfigModule);
  await mock.module(ROUTING_MODULE, () => actualRoutingModule);
  await mock.module(API_MODULE, () => actualAPIModule);
  await mock.module(POLICY_CONTEXT_MODULE, () => actualPolicyContextModule);
}

let cleanupDom: (() => void) | null = null;

async function setupUseModelsHookTest() {
  cleanupDom = installDom();
  window.localStorage.clear();
  providersConfig = null;
  routePriority = ["direct"];
  routeOverrides = {};
  apiMock = null;
  enforcedPolicy = null;
  await installUseModelsModuleMocks();
}

async function cleanupUseModelsHookTest() {
  cleanup();
  await restoreUseModelsModuleMocks();
  mock.restore();
  cleanupDom?.();
  cleanupDom = null;
  apiMock = null;
}

afterAll(async () => {
  await restoreUseModelsModuleMocks();
});

describe("getSuggestedModels", () => {
  test("returns custom models first, then built-ins (deduped)", () => {
    const firstBuiltIn = Object.values(KNOWN_MODELS)[0];
    if (!firstBuiltIn) {
      throw new Error("KNOWN_MODELS unexpectedly empty");
    }
    const builtIn = firstBuiltIn.id;
    const [builtInProvider, builtInModelId] = builtIn.split(":", 2);
    if (!builtInProvider || !builtInModelId) {
      throw new Error(`Unexpected built-in model id: ${builtIn}`);
    }

    const config: ProvidersConfigMap = {
      openai: { apiKeySet: true, isEnabled: true, isConfigured: true, models: ["my-team-model"] },
      [builtInProvider]: {
        apiKeySet: true,
        isEnabled: true,
        isConfigured: true,
        models: [builtInModelId],
      },
      "mux-gateway": {
        apiKeySet: true,
        isEnabled: true,
        isConfigured: true,
        couponCodeSet: true,
        models: ["ignored"],
      },
    };

    const suggested = getSuggestedModels(config);

    // Custom models are listed first (in config order)
    expect(suggested[0]).toBe("openai:my-team-model");
    expect(suggested[1]).toBe(`${builtInProvider}:${builtInModelId}`);

    // mux-gateway models should never appear as selectable entries
    expect(suggested.some((m) => m.startsWith("mux-gateway:"))).toBe(false);

    // Built-ins should be present, but deduped against any custom entry
    expect(countOccurrences(suggested, builtIn)).toBe(1);
  });

  test("skips custom models from disabled providers", () => {
    const config: ProvidersConfigMap = {
      openai: {
        apiKeySet: true,
        isEnabled: false,
        isConfigured: false,
        models: ["disabled-custom"],
      },
      anthropic: {
        apiKeySet: true,
        isEnabled: true,
        isConfigured: true,
        models: ["enabled-custom"],
      },
    };

    const suggested = getSuggestedModels(config);

    expect(suggested).toContain("anthropic:enabled-custom");
    expect(suggested).not.toContain("openai:disabled-custom");
  });
});

describe("filterHiddenModels", () => {
  test("filters out hidden models", () => {
    expect(filterHiddenModels(["a", "b", "c"], ["b"])).toEqual(["a", "c"]);
  });
});

describe("useModelsFromSettings selected model preservation", () => {
  beforeEach(setupUseModelsHookTest);
  afterEach(cleanupUseModelsHookTest);

  test("getDefaultModel preserves explicit gateway-scoped defaults", () => {
    const gatewayModel = "openrouter:openai/gpt-5";
    globalThis.window.localStorage.setItem(DEFAULT_MODEL_KEY, JSON.stringify(gatewayModel));

    expect(getDefaultModel()).toBe(gatewayModel);
  });

  test("setDefaultModel persists explicit gateway-scoped defaults", async () => {
    const updateModelPreferences = mock(() => Promise.resolve(undefined));
    apiMock = {
      config: { updateModelPreferences },
    };

    const { result } = renderHook(() => useModelsFromSettings());

    act(() => {
      result.current.setDefaultModel("openrouter:openai/gpt-5");
    });

    await waitFor(() => expect(result.current.defaultModel).toBe("openrouter:openai/gpt-5"));
    expect(globalThis.window.localStorage.getItem(DEFAULT_MODEL_KEY)).toBe(
      JSON.stringify("openrouter:openai/gpt-5")
    );
    expect(updateModelPreferences).toHaveBeenCalledWith({
      defaultModel: "openrouter:openai/gpt-5",
    });
  });

  test("ensureModelInSettings skips syncing explicit gateway-scoped selections", () => {
    const setModels = mock(() => Promise.resolve(undefined));
    providersConfig = {
      anthropic: { apiKeySet: true, isEnabled: true, isConfigured: true, models: [] },
    };
    apiMock = {
      providers: {
        getConfig: () => Promise.resolve(providersConfig ?? {}),
        setModels,
      },
    };

    const { result } = renderHook(() => useModelsFromSettings());

    act(() => {
      result.current.ensureModelInSettings("openrouter:anthropic/custom-model");
      result.current.ensureModelInSettings("mux-gateway:anthropic/custom-model");
    });

    expect(setModels).not.toHaveBeenCalled();
  });

  test("ensureModelInSettings syncs custom OpenAI-compatible provider models", async () => {
    const setModels = mock(() => Promise.resolve(undefined));
    providersConfig = {
      "local-vllm": customOpenAICompatibleProviderConfig(),
    };
    apiMock = {
      providers: {
        getConfig: () => Promise.resolve(providersConfig ?? {}),
        setModels,
      },
    };

    const { result } = renderHook(() => useModelsFromSettings());

    act(() => {
      result.current.ensureModelInSettings("local-vllm:any-model");
    });

    await waitFor(() =>
      expect(setModels).toHaveBeenCalledWith({
        provider: "local-vllm",
        models: ["any-model"],
      })
    );
  });

  test("ensureModelInSettings skips unknown provider models", async () => {
    const setModels = mock(() => Promise.resolve(undefined));
    providersConfig = {
      "local-vllm": customOpenAICompatibleProviderConfig(),
    };
    apiMock = {
      providers: {
        getConfig: () => Promise.resolve(providersConfig ?? {}),
        setModels,
      },
    };

    const { result } = renderHook(() => useModelsFromSettings());

    act(() => {
      result.current.ensureModelInSettings("missing-provider:any-model");
    });
    await Promise.resolve();

    expect(setModels).not.toHaveBeenCalled();
  });

  test("ensureModelInSettings still syncs direct-provider custom models", async () => {
    const setModels = mock(() => Promise.resolve(undefined));
    providersConfig = {
      anthropic: { apiKeySet: true, isEnabled: true, isConfigured: true, models: [] },
    };
    apiMock = {
      providers: {
        getConfig: () => Promise.resolve(providersConfig ?? {}),
        setModels,
      },
    };

    const { result } = renderHook(() => useModelsFromSettings());

    act(() => {
      result.current.ensureModelInSettings("anthropic:custom-model");
    });

    await waitFor(() =>
      expect(setModels).toHaveBeenCalledWith({
        provider: "anthropic",
        models: ["custom-model"],
      })
    );
  });
});

describe("useModelsFromSettings OpenAI Codex OAuth gating", () => {
  beforeEach(setupUseModelsHookTest);
  afterEach(cleanupUseModelsHookTest);

  test("codex oauth only: shows OAuth-routable OpenAI models and hides API-key-only ones", () => {
    providersConfig = {
      openai: {
        apiKeySet: false,
        isEnabled: true,
        isConfigured: true,
        codexOauthSet: true,
        models: [
          ...SEEDED_OPENAI_CUSTOM_MODELS,
          { id: "team-codex", mappedToModel: KNOWN_MODELS.GPT_53_CODEX.id },
        ],
      },
    };

    const { result } = renderHook(() => useModelsFromSettings());

    expect(result.current.models).toContain(KNOWN_MODELS.GPT.id);
    expect(result.current.models).not.toContain(KNOWN_MODELS.GPT_PRO.id);
    expect(result.current.models).toContain("openai:gpt-5.2-codex");
    expect(result.current.models).toContain(KNOWN_MODELS.GPT_53_CODEX.id);
    expect(result.current.models).toContain("openai:gpt-5.3-codex-spark");
    expect(result.current.models).toContain("openai:team-codex");
    expect(result.current.models).not.toContain("openai:gpt-5.2-pro");
  });

  test("api key only: hides only OAuth-required OpenAI models", () => {
    providersConfig = {
      openai: {
        apiKeySet: true,
        isEnabled: true,
        isConfigured: true,
        codexOauthSet: false,
        models: SEEDED_OPENAI_CUSTOM_MODELS,
      },
    };

    const { result } = renderHook(() => useModelsFromSettings());

    expect(result.current.models).toContain(KNOWN_MODELS.GPT_PRO.id);
    expect(result.current.models).toContain("openai:gpt-5.2-codex");
    expect(result.current.models).toContain("openai:gpt-5.2-pro");
    expect(result.current.models).toContain(KNOWN_MODELS.GPT_53_CODEX.id);
    expect(result.current.models).toContain(KNOWN_MODELS.GPT.id);
    expect(result.current.models).not.toContain("openai:gpt-5.3-codex-spark");
  });

  test("api key + codex oauth: allows all OpenAI models", () => {
    providersConfig = {
      openai: {
        apiKeySet: true,
        isEnabled: true,
        isConfigured: true,
        codexOauthSet: true,
        models: SEEDED_OPENAI_CUSTOM_MODELS,
      },
    };

    const { result } = renderHook(() => useModelsFromSettings());

    expect(result.current.models).toContain(KNOWN_MODELS.GPT_PRO.id);
    expect(result.current.models).toContain("openai:gpt-5.2-codex");
    expect(result.current.models).toContain("openai:gpt-5.2-pro");
    expect(result.current.models).toContain(KNOWN_MODELS.GPT_53_CODEX.id);
    expect(result.current.models).toContain(KNOWN_MODELS.GPT.id);
    expect(result.current.models).toContain("openai:gpt-5.3-codex-spark");
  });

  test("neither auth mode: still hides only OAuth-required OpenAI models", () => {
    providersConfig = {
      openai: {
        apiKeySet: false,
        isEnabled: true,
        isConfigured: true,
        codexOauthSet: false,
        models: SEEDED_OPENAI_CUSTOM_MODELS,
      },
    };

    const { result } = renderHook(() => useModelsFromSettings());

    expect(result.current.models).toContain(KNOWN_MODELS.GPT_PRO.id);
    expect(result.current.models).toContain("openai:gpt-5.2-codex");
    expect(result.current.models).toContain("openai:gpt-5.2-pro");
    expect(result.current.models).toContain(KNOWN_MODELS.GPT_53_CODEX.id);
    expect(result.current.models).toContain(KNOWN_MODELS.GPT.id);
    expect(result.current.models).not.toContain("openai:gpt-5.3-codex-spark");
  });

  test("codex oauth only: a gateway route bypasses the OpenAI auth gate", () => {
    providersConfig = {
      openai: {
        apiKeySet: false,
        isEnabled: true,
        isConfigured: true,
        codexOauthSet: true,
        models: SEEDED_OPENAI_CUSTOM_MODELS,
      },
      "mux-gateway": {
        apiKeySet: false,
        isEnabled: true,
        isConfigured: true,
        couponCodeSet: true,
      },
    };
    routePriority = ["mux-gateway", "direct"];

    const { result } = renderHook(() => useModelsFromSettings());

    // The gateway supplies its own credentials, so API-key-only models stay visible.
    expect(result.current.models).toContain(KNOWN_MODELS.GPT_PRO.id);
    expect(result.current.models).toContain("openai:gpt-5.2-pro");
    expect(result.current.models).toContain(KNOWN_MODELS.GPT.id);
    expect(result.current.hiddenModelsForSelector).not.toContain(KNOWN_MODELS.GPT_PRO.id);
  });

  test("codex oauth only: a per-model gateway override bypasses the gate for that model only", () => {
    providersConfig = {
      openai: {
        apiKeySet: false,
        isEnabled: true,
        isConfigured: true,
        codexOauthSet: true,
        models: SEEDED_OPENAI_CUSTOM_MODELS,
      },
      "mux-gateway": {
        apiKeySet: false,
        isEnabled: true,
        isConfigured: true,
        couponCodeSet: true,
      },
    };
    routePriority = ["direct", "mux-gateway"];
    routeOverrides = { [KNOWN_MODELS.GPT_PRO.id]: "mux-gateway" };

    const { result } = renderHook(() => useModelsFromSettings());

    expect(result.current.models).toContain(KNOWN_MODELS.GPT_PRO.id);
    // Direct-routed models keep the OAuth-only gate.
    expect(result.current.models).not.toContain("openai:gpt-5.2-pro");
  });

  test("oauth disconnected: requiresCodexOauth follows the active route", () => {
    providersConfig = {
      openai: {
        apiKeySet: false,
        isEnabled: true,
        isConfigured: false,
        codexOauthSet: false,
      },
      "mux-gateway": {
        apiKeySet: false,
        isEnabled: true,
        isConfigured: true,
        couponCodeSet: true,
      },
    };
    routePriority = ["mux-gateway", "direct"];

    const { result } = renderHook(() => useModelsFromSettings());

    // The gateway serves the OAuth-required model, so it is selectable and the
    // ChatInput warning must not ask the user to connect OpenAI.
    expect(result.current.models).toContain("openai:gpt-5.3-codex-spark");
    expect(result.current.requiresCodexOauth("openai:gpt-5.3-codex-spark")).toBe(false);
    // A gateway-less model still resolves to direct, so the warning stays.
    routePriority = ["direct"];
    const { result: directOnly } = renderHook(() => useModelsFromSettings());
    expect(directOnly.current.requiresCodexOauth("openai:gpt-5.3-codex-spark")).toBe(true);
  });

  test("codex oauth only: a policy-blocked gateway model does not bypass the gate", () => {
    providersConfig = {
      openai: {
        apiKeySet: false,
        isEnabled: true,
        isConfigured: true,
        codexOauthSet: true,
        models: SEEDED_OPENAI_CUSTOM_MODELS,
      },
      "mux-gateway": {
        apiKeySet: false,
        isEnabled: true,
        isConfigured: true,
        couponCodeSet: true,
      },
    };
    routePriority = ["mux-gateway", "direct"];
    // The policy allows the canonical OpenAI models but lets the gateway serve
    // only Sol. The backend then routes GPT Pro direct, where OAuth-only auth
    // fails, so the picker must keep the gate for it.
    enforcedPolicy = buildEnforcedPolicy([
      { id: "openai", allowedModels: null },
      { id: "mux-gateway", allowedModels: [`openai/${KNOWN_MODELS.GPT.providerModelId}`] },
    ]);

    const { result } = renderHook(() => useModelsFromSettings());

    expect(result.current.models).toContain(KNOWN_MODELS.GPT.id);
    expect(result.current.models).not.toContain(KNOWN_MODELS.GPT_PRO.id);
    expect(result.current.models).not.toContain("openai:gpt-5.2-pro");
  });

  test("policy-hidden Coder metadata does not expose Coder models or routes", () => {
    providersConfig = {
      openai: { apiKeySet: true, isEnabled: true, isConfigured: true },
      coder: {
        apiKeySet: false,
        isEnabled: false,
        isConfigured: false,
        discoveredProviders: [{ name: "prod-openai", type: "openai" }],
      },
    };
    routePriority = ["coder", "direct"];
    enforcedPolicy = buildEnforcedPolicy([{ id: "openai", allowedModels: null }]);
    const { result } = renderHook(() => useModelsFromSettings());
    expect(result.current.models).toContain(KNOWN_MODELS.GPT_6_ASTRA.id);
    expect(result.current.models.some((model) => model.startsWith("coder:"))).toBe(false);
    expect(getSuggestedModels(providersConfig).some((model) => model.startsWith("coder:"))).toBe(
      false
    );
    expect(result.current.isAllowedByPolicyOnActiveRoute("coder:prod-openai/gpt-6-astra")).toBe(
      false
    );
  });

  test("a gateway-only policy keeps models whose active route is that gateway", () => {
    providersConfig = {
      openai: {
        apiKeySet: true,
        isEnabled: true,
        isConfigured: true,
        models: SEEDED_OPENAI_CUSTOM_MODELS,
      },
      "mux-gateway": {
        apiKeySet: false,
        isEnabled: true,
        isConfigured: true,
        couponCodeSet: true,
      },
    };
    // The policy lists only the gateway. The backend checks the resolved route
    // identity (mux-gateway:openai/...), so the picker must keep those models
    // while the gateway is their active route.
    enforcedPolicy = buildEnforcedPolicy([{ id: "mux-gateway", allowedModels: null }]);

    routePriority = ["mux-gateway", "direct"];
    const viaGateway = renderHook(() => useModelsFromSettings());
    expect(viaGateway.result.current.models).toContain(KNOWN_MODELS.GPT_PRO.id);
    expect(viaGateway.result.current.models).toContain(KNOWN_MODELS.GPT.id);
    expect(viaGateway.result.current.isAllowedByPolicyOnActiveRoute(KNOWN_MODELS.GPT_PRO.id)).toBe(
      true
    );

    // Direct-only routing resolves to openai:*, which this policy does not allow.
    routePriority = ["direct"];
    const direct = renderHook(() => useModelsFromSettings());
    expect(direct.result.current.models).not.toContain(KNOWN_MODELS.GPT_PRO.id);
    expect(direct.result.current.models).not.toContain(KNOWN_MODELS.GPT.id);
    expect(direct.result.current.isAllowedByPolicyOnActiveRoute(KNOWN_MODELS.GPT_PRO.id)).toBe(
      false
    );
  });

  test("exposes OpenAI auth state flags", () => {
    providersConfig = {
      openai: { apiKeySet: false, isEnabled: true, isConfigured: true, codexOauthSet: true },
    };

    const { result } = renderHook(() => useModelsFromSettings());

    expect(result.current.openaiApiKeySet).toBe(false);
    expect(result.current.codexOauthSet).toBe(true);
  });

  test("returns false OpenAI auth state flags when openai provider is missing", () => {
    providersConfig = {};

    const { result } = renderHook(() => useModelsFromSettings());

    expect(result.current.openaiApiKeySet).toBe(false);
    expect(result.current.codexOauthSet).toBe(false);
  });

  test("returns null OpenAI auth state flags when provider config is unknown", () => {
    providersConfig = null;

    const { result } = renderHook(() => useModelsFromSettings());

    expect(result.current.openaiApiKeySet).toBeNull();
    expect(result.current.codexOauthSet).toBeNull();
  });
});

describe("useModelsFromSettings provider availability gating", () => {
  beforeEach(setupUseModelsHookTest);
  afterEach(cleanupUseModelsHookTest);

  test("hides models from unconfigured providers", () => {
    providersConfig = {
      anthropic: { apiKeySet: false, isEnabled: true, isConfigured: false },
      openai: { apiKeySet: true, isEnabled: true, isConfigured: true },
    };

    const { result } = renderHook(() => useModelsFromSettings());

    expect(result.current.models).not.toContain(KNOWN_MODELS.OPUS.id);
    expect(result.current.models).not.toContain(KNOWN_MODELS.SONNET.id);
    expect(result.current.models).not.toContain(KNOWN_MODELS.HAIKU.id);

    expect(result.current.hiddenModelsForSelector).toContain(KNOWN_MODELS.OPUS.id);
    expect(result.current.hiddenModelsForSelector).toContain(KNOWN_MODELS.SONNET.id);

    expect(result.current.models).toContain(KNOWN_MODELS.GPT.id);
  });

  test("keeps routed provider models visible when a gateway route is active", () => {
    providersConfig = {
      anthropic: { apiKeySet: false, isEnabled: true, isConfigured: false },
      "mux-gateway": {
        apiKeySet: false,
        isEnabled: true,
        isConfigured: true,
        couponCodeSet: true,
      },
    };
    routePriority = ["mux-gateway", "direct"];
    routeOverrides = {};

    const { result } = renderHook(() => useModelsFromSettings());

    // Routing availability is provider-level: a configured mux-gateway makes
    // all built-in Anthropic models visible, not just a per-model allowlist.
    expect(result.current.models).toContain(KNOWN_MODELS.OPUS.id);
    expect(result.current.models).toContain(KNOWN_MODELS.SONNET.id);
    expect(result.current.models).toContain(KNOWN_MODELS.HAIKU.id);

    expect(result.current.hiddenModelsForSelector).not.toContain(KNOWN_MODELS.OPUS.id);
    expect(result.current.hiddenModelsForSelector).not.toContain(KNOWN_MODELS.SONNET.id);
    expect(result.current.hiddenModelsForSelector).not.toContain(KNOWN_MODELS.HAIKU.id);
  });

  test("does not treat custom gateway model entries as an exhaustive route catalog", () => {
    providersConfig = {
      openai: { apiKeySet: false, isEnabled: true, isConfigured: false },
      openrouter: {
        apiKeySet: true,
        isEnabled: true,
        isConfigured: true,
        models: [OPENROUTER_OPENAI_CUSTOM_MODEL],
      },
    };
    routePriority = ["openrouter", "direct"];

    const { result } = renderHook(() => useModelsFromSettings());

    expect(result.current.models).toContain(KNOWN_MODELS.GPT.id);
    expect(result.current.hiddenModelsForSelector).not.toContain(KNOWN_MODELS.GPT.id);
  });

  test("hides models that a configured gateway does not expose", () => {
    providersConfig = {
      openai: { apiKeySet: false, isEnabled: true, isConfigured: false },
      "github-copilot": {
        apiKeySet: true,
        isEnabled: true,
        isConfigured: true,
        models: [KNOWN_MODELS.GPT_54_MINI.providerModelId],
      },
    };
    routePriority = ["github-copilot", "direct"];

    const { result } = renderHook(() => useModelsFromSettings());

    expect(result.current.models).not.toContain(KNOWN_MODELS.GPT.id);
    expect(result.current.hiddenModelsForSelector).toContain(KNOWN_MODELS.GPT.id);
  });

  test("keeps Copilot catalogs authoritative without surfacing selector entries", () => {
    providersConfig = {
      openai: { apiKeySet: false, isEnabled: true, isConfigured: false },
      "github-copilot": {
        apiKeySet: true,
        isEnabled: true,
        isConfigured: true,
        models: [KNOWN_MODELS.GPT_54_MINI.providerModelId],
      },
    };
    routePriority = ["github-copilot", "direct"];

    const { result } = renderHook(() => useModelsFromSettings());

    expect(result.current.customModels.some((model) => model.startsWith("github-copilot:"))).toBe(
      false
    );
    expect(
      result.current.hiddenModelsForSelector.some((model) => model.startsWith("github-copilot:"))
    ).toBe(false);
    expect(result.current.models).not.toContain(KNOWN_MODELS.GPT.id);
    expect(result.current.hiddenModelsForSelector).toContain(KNOWN_MODELS.GPT.id);
  });

  test("keeps models visible when a configured gateway exposes them", () => {
    providersConfig = {
      openai: { apiKeySet: false, isEnabled: true, isConfigured: false },
      "github-copilot": {
        apiKeySet: true,
        isEnabled: true,
        isConfigured: true,
        models: [KNOWN_MODELS.GPT.providerModelId],
      },
    };
    routePriority = ["github-copilot", "direct"];

    const { result } = renderHook(() => useModelsFromSettings());

    expect(result.current.models).toContain(KNOWN_MODELS.GPT.id);
    expect(result.current.hiddenModelsForSelector).not.toContain(KNOWN_MODELS.GPT.id);
  });

  test("keeps Anthropic models visible when Copilot catalog contains dot-form IDs", () => {
    providersConfig = {
      anthropic: { apiKeySet: false, isEnabled: true, isConfigured: false },
      "github-copilot": {
        apiKeySet: true,
        isEnabled: true,
        isConfigured: true,
        models: ["claude-haiku-4.5"],
      },
    };
    routePriority = ["github-copilot", "direct"];

    const { result } = renderHook(() => useModelsFromSettings());

    expect(result.current.models).toContain(KNOWN_MODELS.HAIKU.id);
    expect(result.current.hiddenModelsForSelector).not.toContain(KNOWN_MODELS.HAIKU.id);
    expect(result.current.customModels.some((model) => model.startsWith("github-copilot:"))).toBe(
      false
    );
  });

  test("keeps gateway-routed models visible when no gateway model list is present", () => {
    providersConfig = {
      openai: { apiKeySet: false, isEnabled: true, isConfigured: false },
      "github-copilot": {
        apiKeySet: true,
        isEnabled: true,
        isConfigured: true,
      },
    };
    routePriority = ["github-copilot", "direct"];

    const { result } = renderHook(() => useModelsFromSettings());

    expect(result.current.models).toContain(KNOWN_MODELS.GPT.id);
    expect(result.current.hiddenModelsForSelector).not.toContain(KNOWN_MODELS.GPT.id);
  });

  test("excludes OAuth-gated OpenAI models from hidden bucket when unconfigured", () => {
    // OpenAI is unconfigured and neither API key nor OAuth is set.
    providersConfig = {
      openai: { apiKeySet: false, isEnabled: true, isConfigured: false, codexOauthSet: false },
    };

    const { result } = renderHook(() => useModelsFromSettings());

    // OAuth-required models (currently Spark) should NOT appear in either list
    // because selecting them from "Show all models…" would fail at send time.
    expect(result.current.models).not.toContain("openai:gpt-5.3-codex-spark");
    expect(result.current.hiddenModelsForSelector).not.toContain("openai:gpt-5.3-codex-spark");

    // Non-OAuth-required OpenAI models should still be in the hidden bucket
    // when the provider is unconfigured.
    expect(result.current.hiddenModelsForSelector).toContain("openai:gpt-5.3-codex");
    expect(result.current.hiddenModelsForSelector).toContain(KNOWN_MODELS.GPT.id);
  });

  test("shows explicit OpenRouter custom models when only the direct provider is configured", () => {
    providersConfig = {
      openrouter: {
        apiKeySet: false,
        isEnabled: true,
        isConfigured: false,
        models: ["openai/gpt-5"],
      },
      openai: { apiKeySet: true, isEnabled: true, isConfigured: true },
    };

    const { result } = renderHook(() => useModelsFromSettings());

    expect(result.current.models).toContain(OPENROUTER_OPENAI_CUSTOM_MODEL);
    expect(result.current.hiddenModelsForSelector).not.toContain(OPENROUTER_OPENAI_CUSTOM_MODEL);
  });

  test("shows explicit OpenRouter custom models once OpenRouter is configured", () => {
    providersConfig = {
      openrouter: {
        apiKeySet: true,
        isEnabled: true,
        isConfigured: true,
        models: ["openai/gpt-5"],
      },
      openai: { apiKeySet: true, isEnabled: true, isConfigured: true },
    };

    const { result } = renderHook(() => useModelsFromSettings());

    expect(result.current.models).toContain(OPENROUTER_OPENAI_CUSTOM_MODEL);
    expect(result.current.hiddenModelsForSelector).not.toContain(OPENROUTER_OPENAI_CUSTOM_MODEL);
  });

  test("shows explicit OpenRouter custom models when OpenRouter is unavailable but mux-gateway is configured", () => {
    providersConfig = {
      openrouter: {
        apiKeySet: false,
        isEnabled: true,
        isConfigured: false,
        models: ["openai/gpt-5"],
      },
      openai: { apiKeySet: true, isEnabled: true, isConfigured: true },
      "mux-gateway": { apiKeySet: false, isEnabled: true, isConfigured: true },
    };
    routePriority = ["openrouter", "mux-gateway", "direct"];

    const { result } = renderHook(() => useModelsFromSettings());

    expect(result.current.models).toContain(OPENROUTER_OPENAI_CUSTOM_MODEL);
    expect(result.current.hiddenModelsForSelector).not.toContain(OPENROUTER_OPENAI_CUSTOM_MODEL);
  });

  test("hides models from disabled providers", () => {
    providersConfig = {
      anthropic: { apiKeySet: true, isEnabled: false, isConfigured: true },
      openai: { apiKeySet: true, isEnabled: true, isConfigured: true },
    };

    const { result } = renderHook(() => useModelsFromSettings());

    expect(result.current.models).not.toContain(KNOWN_MODELS.OPUS.id);
    expect(result.current.hiddenModelsForSelector).toContain(KNOWN_MODELS.OPUS.id);
    expect(result.current.models).toContain(KNOWN_MODELS.GPT.id);
  });

  test("keeps persisted hiddenModels separate from provider-hidden models", () => {
    globalThis.window.localStorage.setItem(
      HIDDEN_MODELS_KEY,
      JSON.stringify([KNOWN_MODELS.GPT.id])
    );

    providersConfig = {
      anthropic: { apiKeySet: false, isEnabled: true, isConfigured: false },
      openai: { apiKeySet: true, isEnabled: true, isConfigured: true },
    };

    const { result } = renderHook(() => useModelsFromSettings());

    expect(result.current.hiddenModels).toEqual([KNOWN_MODELS.GPT.id]);
    expect(result.current.hiddenModels).not.toContain(KNOWN_MODELS.OPUS.id);

    expect(result.current.hiddenModelsForSelector).toContain(KNOWN_MODELS.GPT.id);
    expect(result.current.hiddenModelsForSelector).toContain(KNOWN_MODELS.OPUS.id);
  });

  test("shows all built-in provider models when config is null", () => {
    providersConfig = null;

    const { result } = renderHook(() => useModelsFromSettings());

    expect(result.current.models).toContain(KNOWN_MODELS.OPUS.id);
    expect(result.current.models).toContain(KNOWN_MODELS.GPT.id);
    expect(result.current.hiddenModelsForSelector).toEqual(DEFAULT_HIDDEN_MODELS);
  });

  test("gateway-prefixed custom model stays available via canonical route override when gateway is unavailable", () => {
    routePriority = ["direct"];
    routeOverrides = { "openai:gpt-5": "mux-gateway" };

    providersConfig = {
      openrouter: {
        apiKeySet: false,
        isEnabled: true,
        isConfigured: false,
        models: ["openai/gpt-5"],
      },
      openai: { apiKeySet: false, isEnabled: true, isConfigured: false },
      "mux-gateway": {
        apiKeySet: false,
        isEnabled: true,
        isConfigured: true,
        couponCodeSet: true,
      },
    };

    const { result } = renderHook(() => useModelsFromSettings());

    expect(result.current.models).toContain(OPENROUTER_OPENAI_CUSTOM_MODEL);
    expect(result.current.hiddenModelsForSelector).not.toContain(OPENROUTER_OPENAI_CUSTOM_MODEL);
  });

  test("provider missing from config is treated as unavailable without a route", () => {
    providersConfig = {
      anthropic: { apiKeySet: true, isEnabled: true, isConfigured: true },
    };

    const { result } = renderHook(() => useModelsFromSettings());

    expect(result.current.models).toContain(KNOWN_MODELS.OPUS.id);
    expect(result.current.models).not.toContain(KNOWN_MODELS.GPT.id);
    expect(result.current.hiddenModelsForSelector).toContain(KNOWN_MODELS.GPT.id);
  });
});

describe("useModelsFromSettings hidden-model gateway identity", () => {
  beforeEach(setupUseModelsHookTest);
  afterEach(cleanupUseModelsHookTest);

  test("hiding an explicit Coder gateway model hides that entry, not the direct model", async () => {
    // Cross-typed instance: name "openai", type "anthropic". Name-only
    // canonicalization would persist openai:claude-opus-4-1, leaving the
    // Coder entry visible and hiding the distinct direct OpenAI model.
    providersConfig = {
      coder: {
        apiKeySet: false,
        isEnabled: true,
        isConfigured: true,
        models: ["openai/claude-opus-4-1"],
      },
      openai: {
        apiKeySet: true,
        isEnabled: true,
        isConfigured: true,
        models: ["claude-opus-4-1"],
      },
    };

    const { result } = renderHook(() => useModelsFromSettings());

    expect(result.current.models).toContain("coder:openai/claude-opus-4-1");
    expect(result.current.models).toContain("openai:claude-opus-4-1");

    act(() => {
      result.current.hideModel("coder:openai/claude-opus-4-1");
    });

    await waitFor(() => {
      expect(result.current.hiddenModels).toContain("coder:openai/claude-opus-4-1");
    });
    expect(result.current.models).not.toContain("coder:openai/claude-opus-4-1");
    // The distinct direct model must stay visible.
    expect(result.current.models).toContain("openai:claude-opus-4-1");

    act(() => {
      result.current.unhideModel("coder:openai/claude-opus-4-1");
    });

    await waitFor(() => {
      expect(result.current.models).toContain("coder:openai/claude-opus-4-1");
    });
  });
});

describe("Daybreak settings and selector visibility", () => {
  beforeEach(setupUseModelsHookTest);
  afterEach(cleanupUseModelsHookTest);

  test.each([
    ["openai:daybreak-blue-latest", "openai:daybreak-red-latest"],
    ["openai:daybreak-red-latest", "openai:daybreak-blue-latest"],
  ])("enables %s independently and preserves visibility across reload", async (first, second) => {
    providersConfig = { openai: { apiKeySet: true, isEnabled: true, isConfigured: true } };
    const persist = mock(() => Promise.resolve());
    apiMock = { config: { updateModelPreferences: persist } };
    updatePersistedState(DEFAULT_MODEL_KEY, KNOWN_MODELS.GPT.id);
    let hook = renderHook(() => useModelsFromSettings());
    for (const id of [first, second]) {
      expect(
        getSuggestedModels(providersConfig).filter((m) => shouldShowModelInSettings(m, false))
      ).toContain(id);
      expect(hook.result.current.models).not.toContain(id);
      expect(hook.result.current.hiddenModels).toContain(id);
    }
    act(() => hook.result.current.hideModel(KNOWN_MODELS.GPT_PRO.id));
    act(() => hook.result.current.unhideModel(first));
    await waitFor(() => expect(hook.result.current.models).toContain(first));
    expect(hook.result.current.models).not.toContain(second);
    expect(persist).toHaveBeenLastCalledWith({ hiddenModels: [second, KNOWN_MODELS.GPT_PRO.id] });

    hook.unmount();
    hook = renderHook(() => useModelsFromSettings());
    expect(hook.result.current.models).toContain(first);
    expect(hook.result.current.models).not.toContain(second);
    expect(hook.result.current.defaultModel).toBe(KNOWN_MODELS.GPT.id);
    expect(hook.result.current.hiddenModels).toContain(KNOWN_MODELS.GPT_PRO.id);

    act(() => hook.result.current.unhideModel(second));
    await waitFor(() => expect(hook.result.current.models).toContain(second));
    act(() => hook.result.current.hideModel(first));
    await waitFor(() => expect(hook.result.current.models).not.toContain(first));
    expect(hook.result.current.models).toContain(second);
  });
});

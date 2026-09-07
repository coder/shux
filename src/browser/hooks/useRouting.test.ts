import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { act, cleanup, renderHook, waitFor } from "@testing-library/react";
import { GlobalWindow } from "happy-dom";
import React from "react";

import { APIProvider, type APIClient } from "@/browser/contexts/API";
import { PolicyProvider } from "@/browser/contexts/PolicyContext";
import { KNOWN_MODELS } from "@/common/constants/knownModels";
import type { PolicyGetResponse, ProvidersConfigMap } from "@/common/orpc/types";
import { getAppConfigStore } from "@/browser/stores/AppConfigStore";
import { getProvidersConfigStore } from "@/browser/stores/ProvidersConfigStore";

import { useRouting } from "./useRouting";
import { openaiProModeAvailable } from "@/common/utils/ai/proMode";

let providersConfig: ProvidersConfigMap | null = null;
let routePriority: string[] = ["direct"];
let routeOverrides: Record<string, string> = {};
let configGetConfig: () => Promise<{
  routePriority: string[];
  routeOverrides: Record<string, string>;
}>;
let updateRoutePreferencesImpl: () => Promise<undefined>;
const POLICY_DISABLED: PolicyGetResponse = {
  source: "none",
  status: { state: "disabled" },
  policy: null,
};
let policyResponse: PolicyGetResponse = POLICY_DISABLED;

async function* emptyStream() {
  await Promise.resolve();
  for (const item of [] as unknown[]) {
    yield item;
  }
}

function createStubApiClient(): APIClient {
  return {
    providers: {
      getConfig: () => Promise.resolve(providersConfig),
      onConfigChanged: () => Promise.resolve(emptyStream()),
    },
    config: {
      getConfig: () => configGetConfig(),
      onConfigChanged: () => Promise.resolve(emptyStream()),
      updateRoutePreferences: () => updateRoutePreferencesImpl(),
    },
    policy: {
      get: () => Promise.resolve(policyResponse),
      onChanged: () => Promise.resolve(emptyStream()),
    },
  } as unknown as APIClient;
}

const stubClient = createStubApiClient();

// useRouting reads the policy (like AppLoader provides in the real app), so the
// hook test tree needs a PolicyProvider under the API provider.
const wrapper: React.FC<{ children: React.ReactNode }> = (props) =>
  React.createElement(
    APIProvider,
    { client: stubClient } as React.ComponentProps<typeof APIProvider>,
    React.createElement(PolicyProvider, null, props.children)
  );

describe("useRouting", () => {
  let previousWindow: typeof globalThis.window;
  let previousDocument: typeof globalThis.document;
  let testWindow: GlobalWindow | null = null;

  beforeEach(() => {
    previousWindow = globalThis.window;
    previousDocument = globalThis.document;
    testWindow = new GlobalWindow({ url: "https://mux.example.com/" });
    globalThis.window = testWindow as unknown as Window & typeof globalThis;
    globalThis.document = globalThis.window.document;
    providersConfig = null;
    routePriority = ["direct"];
    routeOverrides = {};
    configGetConfig = () => Promise.resolve({ routePriority, routeOverrides });
    updateRoutePreferencesImpl = () => Promise.resolve(undefined);
    policyResponse = POLICY_DISABLED;
  });

  afterEach(() => {
    cleanup();
    getProvidersConfigStore().setClient(null);
    getAppConfigStore().setClient(null);
    testWindow?.close();
    testWindow = null;
    globalThis.window = previousWindow;
    globalThis.document = previousDocument;
  });

  test("resolveRoute and availableRoutes honor gateway model accessibility", async () => {
    providersConfig = {
      openai: { apiKeySet: true, isEnabled: true, isConfigured: true },
      "github-copilot": {
        apiKeySet: true,
        isEnabled: true,
        isConfigured: true,
        models: [KNOWN_MODELS.GPT_54_MINI.providerModelId],
      },
    };

    // useProvidersConfig/useRouting read the shared stores (wired by
    // AppLoader in the real app); this hook test bypasses AppLoader, so wire
    // them manually AFTER the stubbed config is in place so the stores' fetch
    // observes it.
    getProvidersConfigStore().setClient(stubClient);
    getAppConfigStore().setClient(stubClient);

    const { result } = renderHook(() => useRouting(), { wrapper });

    await waitFor(() => {
      expect(
        result.current
          .availableRoutes(KNOWN_MODELS.GPT.id)
          .some((route) => route.route === "github-copilot")
      ).toBe(false);
    });

    expect(result.current.resolveRoute(KNOWN_MODELS.GPT.id)).toEqual({
      route: "direct",
      isAuto: true,
      displayName: "Direct",
    });
  });

  test("an enforced policy that blocks the gateway model removes that route", async () => {
    providersConfig = {
      openai: { apiKeySet: true, isEnabled: true, isConfigured: true },
      "mux-gateway": {
        apiKeySet: false,
        isEnabled: true,
        isConfigured: true,
        couponCodeSet: true,
      },
    };
    routePriority = ["mux-gateway", "direct"];
    // The policy allows the canonical OpenAI models but lets the gateway serve
    // only Sol. The backend rejects the gateway for GPT Pro at send time, so the
    // UI must not offer or resolve that route either.
    policyResponse = {
      source: "env",
      status: { state: "enforced" },
      policy: {
        policyFormatVersion: "0.1",
        providerAccess: [
          { id: "openai", allowedModels: null },
          { id: "mux-gateway", allowedModels: [`openai/${KNOWN_MODELS.GPT.providerModelId}`] },
        ],
        mcp: { allowUserDefined: { stdio: true, remote: true } },
        runtimes: null,
      },
    };
    getProvidersConfigStore().setClient(stubClient);
    getAppConfigStore().setClient(stubClient);

    const { result } = renderHook(() => useRouting(), { wrapper });

    const viaGateway = (modelId: string) =>
      result.current.availableRoutes(modelId).some((route) => route.route === "mux-gateway");
    await waitFor(() => {
      expect(viaGateway(KNOWN_MODELS.GPT_PRO.id)).toBe(false);
      expect(result.current.resolveRoute(KNOWN_MODELS.GPT_PRO.id).route).toBe("direct");
      expect(viaGateway(KNOWN_MODELS.GPT.id)).toBe(true);
      expect(result.current.resolveRoute(KNOWN_MODELS.GPT.id).route).toBe("mux-gateway");
    });
  });

  const coderFallbackCases: Array<{
    availability: Partial<NonNullable<ProvidersConfigMap["coder"]>>;
    override?: string;
    expected: string;
  }> = [
    { availability: { isEnabled: false }, override: undefined, expected: "mux-gateway" },
    {
      availability: { discoveredModels: [], models: [] },
      override: undefined,
      expected: "mux-gateway",
    },
    {
      availability: { removedModels: ["prod-openai/gpt-6-astra"] },
      override: undefined,
      expected: "mux-gateway",
    },
    { availability: { isEnabled: false }, override: "direct", expected: "direct" },
    { availability: {}, override: "direct", expected: "coder" },
  ];
  test.each(coderFallbackCases)(
    "resolves Pro's effective custom-instance route: %j",
    async (testCase) => {
      const model = "coder:prod-openai/gpt-6-astra";
      providersConfig = {
        openai: { apiKeySet: true, isEnabled: true, isConfigured: true },
        "mux-gateway": { apiKeySet: true, isEnabled: true, isConfigured: true },
        coder: {
          apiKeySet: false,
          isEnabled: true,
          isConfigured: true,
          discoveredProviders: [{ name: "prod-openai", type: "openai" }],
          // Capability overrides must not change the fallback's provider or route key.
          models: [{ id: "prod-openai/gpt-6-astra", mappedToModel: "anthropic:claude-opus-4-6" }],
          ...testCase.availability,
        },
      };
      routePriority = ["mux-gateway", "direct"];
      if (testCase.override) routeOverrides = { "openai:gpt-6-astra": testCase.override };
      getProvidersConfigStore().setClient(stubClient);
      getAppConfigStore().setClient(stubClient);
      const { result } = renderHook(() => useRouting(), { wrapper });
      await waitFor(() => expect(result.current.routePriority).toEqual(routePriority));
      expect(result.current.resolveEffectiveRoute(model)).toBe(testCase.expected);
    }
  );

  test("Pro honors policy rejection even when Coder's catalog lists the model", async () => {
    const model = "coder:openai/gpt-6-astra";
    providersConfig = {
      openai: { apiKeySet: true, isEnabled: true, isConfigured: true },
      "mux-gateway": { apiKeySet: true, isEnabled: true, isConfigured: true },
      coder: {
        apiKeySet: false,
        isEnabled: true,
        isConfigured: true,
        models: ["openai/gpt-6-astra"],
        discoveredModels: ["openai/gpt-6-astra"],
      },
    };
    routePriority = ["coder", "mux-gateway", "direct"];
    policyResponse = {
      source: "env",
      status: { state: "enforced" },
      policy: {
        policyFormatVersion: "0.1",
        providerAccess: [
          { id: "openai", allowedModels: null },
          { id: "coder", allowedModels: [] },
          { id: "mux-gateway", allowedModels: null },
        ],
        mcp: { allowUserDefined: { stdio: true, remote: true } },
        runtimes: null,
      },
    };
    getProvidersConfigStore().setClient(stubClient);
    getAppConfigStore().setClient(stubClient);
    const { result } = renderHook(() => useRouting(), { wrapper });
    await waitFor(() => expect(result.current.resolveEffectiveRoute(model)).toBe("mux-gateway"));
    expect(
      openaiProModeAvailable(model, {
        providersConfig,
        effectiveRouteProvider: result.current.resolveEffectiveRoute(model),
      })
    ).toBe(false);
  });

  test("hook instances share one config fetch via the AppConfigStore", async () => {
    routeOverrides = { "openai:gpt-5.4": "mux-gateway" };
    let configFetchCount = 0;
    const baseGetConfig = configGetConfig;
    configGetConfig = () => {
      configFetchCount++;
      return baseGetConfig();
    };
    getProvidersConfigStore().setClient(stubClient);
    getAppConfigStore().setClient(stubClient);

    // Regression: each useRouting instance used to issue its own
    // config.getConfig fetch + onConfigChanged subscription, so surfaces with
    // one picker per row fanned out O(rows) backend reads.
    const first = renderHook(() => useRouting(), { wrapper });
    const second = renderHook(() => useRouting(), { wrapper });

    await waitFor(() => {
      expect(first.result.current.routeOverrides).toEqual(routeOverrides);
      expect(second.result.current.routeOverrides).toEqual(routeOverrides);
    });
    expect(configFetchCount).toBe(1);
  });

  test("failed route persistence refreshes the shared store from the backend", async () => {
    // The optimistic update lands in the SINGLETON store, so a failed write
    // must re-fetch: otherwise the stale route survives navigation and every
    // picker keeps gating on state the backend never accepted.
    updateRoutePreferencesImpl = () => Promise.reject(new Error("write failed"));
    getProvidersConfigStore().setClient(stubClient);
    getAppConfigStore().setClient(stubClient);

    const { result } = renderHook(() => useRouting(), { wrapper });
    await waitFor(() => expect(result.current.routePriority).toEqual(["direct"]));

    act(() => {
      result.current.setRoutePriority(["mux-gateway", "direct"]);
    });
    expect(result.current.routePriority).toEqual(["mux-gateway", "direct"]);

    await waitFor(() => expect(result.current.routePriority).toEqual(["direct"]));
  });
});

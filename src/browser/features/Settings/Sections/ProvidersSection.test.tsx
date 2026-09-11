import type React from "react";
import { cleanup, fireEvent, render, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterAll, afterEach, beforeEach, describe, expect, mock, spyOn, test } from "bun:test";
import { installDom } from "../../../../../tests/ui/dom";
import { createSelectPrimitiveDouble } from "../../../../../tests/ui/selectPrimitiveDouble";
import type { APIClient } from "@/browser/contexts/API";
import * as ActualSelectPrimitiveModule from "@/browser/components/SelectPrimitive/SelectPrimitive";
import * as ActualRoutingModule from "@/browser/hooks/useRouting";
import * as SettingsContextModule from "@/browser/contexts/SettingsContext";
import type * as WorkspaceStoreModule from "@/browser/stores/WorkspaceStore";
import type * as WorkspaceContextModule from "@/browser/contexts/WorkspaceContext";
import type {
  AddCustomProviderInput,
  ProviderConfigInfo,
  ProvidersConfigMap,
} from "@/common/orpc/types";

function installTestDoubles() {
  // Bun mock.module registrations are global across files, so keep this test
  // insulated from incomplete WorkspaceStore mocks registered by earlier files.
  /* eslint-disable @typescript-eslint/no-require-imports */
  const actualWorkspaceStore =
    require("@/browser/stores/WorkspaceStore?real=1") as typeof WorkspaceStoreModule;
  /* eslint-enable @typescript-eslint/no-require-imports */

  void mock.module("@/browser/stores/WorkspaceStore", () => ({
    ...actualWorkspaceStore,
  }));
}

let repairRemovedProviderMock = mock(
  (_provider: string, _workspaceIds: Iterable<string>) => undefined
);

// Radix Select portals its dropdown content, which happy-dom cannot render;
// swap in the conditional-rendering double so option clicks work.
void mock.module("@/browser/components/SelectPrimitive/SelectPrimitive", () =>
  createSelectPrimitiveDouble()
);

void mock.module("@/browser/utils/modelPreferenceRepair", () => ({
  repairLocalModelPreferencesForRemovedProvider: (
    provider: string,
    workspaceIds: Iterable<string>
  ) => repairRemovedProviderMock(provider, workspaceIds),
}));

let providersConfigMock: ProvidersConfigMap | null = null;
let apiMock: APIClient | null = null;
const providersRefreshMock = mock(() => Promise.resolve());
const updateOptimisticallyMock = mock((provider: string, updates: Partial<ProviderConfigInfo>) => {
  if (!providersConfigMock?.[provider]) {
    return;
  }
  providersConfigMock[provider] = { ...providersConfigMock[provider], ...updates };
});

void mock.module("@/browser/hooks/useProvidersConfig", () => ({
  useProvidersConfig: () => ({
    config: providersConfigMock,
    loading: false,
    refresh: providersRefreshMock,
    updateOptimistically: updateOptimisticallyMock,
  }),
}));

const actualRoutingModule = { ...ActualRoutingModule };
afterAll(async () => {
  await mock.module("@/browser/hooks/useRouting", () => actualRoutingModule);
});

void mock.module("@/browser/hooks/useRouting", () => ({
  useRouting: () => ({
    routePriority: ["direct"],
    routeOverrides: {},
    // Consumed by ModelClassesEditor's warning gate; bun mock.module leaks
    // across test files, so this stub must stay shape-complete for suites
    // that run after this file in the same process.
    loaded: true,
    resolveRoute: () => ({ route: "direct", isAuto: true, displayName: "Direct" }),
    resolveEffectiveRoute: () => "direct",
    availableRoutes: () => [],
    setRoutePreferences: () => undefined,
    setRoutePriority: () => undefined,
    setRouteOverride: () => undefined,
  }),
}));

void mock.module("@/browser/contexts/API", () => ({
  useAPI: () => ({ api: apiMock }),
}));

void mock.module("@/browser/contexts/PolicyContext", () => ({
  usePolicy: () => ({
    status: { state: "disabled" as const },
    policy: null,
  }),
}));

/* eslint-disable @typescript-eslint/no-require-imports */
const actualWorkspaceContext =
  require("@/browser/contexts/WorkspaceContext?real=1") as typeof WorkspaceContextModule;
/* eslint-enable @typescript-eslint/no-require-imports */

void mock.module("@/browser/contexts/WorkspaceContext", () => ({
  ...actualWorkspaceContext,
  WorkspaceProvider: ({ children }: { children: React.ReactNode }) => <>{children}</>,
  useWorkspaceContext: () => ({
    workspaceMetadata: new Map(),
    selectedWorkspace: null,
    refreshWorkspaceMetadata: () => Promise.resolve(),
  }),
}));

import { ProvidersSection } from "./ProvidersSection";
import { SettingsSectionStory, setupSettingsStory } from "./settingsStoryUtils";

const CUSTOM_PROVIDER_ID = "acme-openai";

function createProvidersConfig(): ProvidersConfigMap {
  return {
    openai: {
      apiKeySet: true,
      isEnabled: true,
      isConfigured: true,
    },
    xai: {
      apiKeySet: true,
      isEnabled: true,
      isConfigured: true,
    },
    [CUSTOM_PROVIDER_ID]: {
      apiKeySet: true,
      isEnabled: true,
      isConfigured: true,
      baseUrl: "https://api.acme.test/v1",
      displayName: "Acme OpenAI",
      isCustom: true,
      providerType: "openai-compatible",
      models: ["acme-chat"],
    },
  };
}

function emptyConfigChangeIterator(): AsyncIterator<void> & AsyncIterable<void> {
  const iterator: AsyncIterator<void> & AsyncIterable<void> = {
    next: () => new Promise<IteratorResult<void>>(() => undefined),
    return: () => Promise.resolve({ done: true, value: undefined }),
    [Symbol.asyncIterator]: () => iterator,
  };
  return iterator;
}

function patchProviderMethods(client: APIClient, providersConfig: ProvidersConfigMap) {
  const getConfig = mock(() => Promise.resolve({ ...providersConfig }));
  const addCustomProvider = mock((input: AddCustomProviderInput) => {
    const providerInfo: ProviderConfigInfo = {
      apiKeySet: input.apiKey != null,
      isEnabled: true,
      isConfigured: true,
      apiKeyFile: input.apiKeyFile,
      baseUrl: input.baseUrl,
      displayName: input.displayName ?? input.provider,
      isCustom: true,
      providerType: input.providerType ?? "openai-compatible",
      models: input.models,
    };
    providersConfig[input.provider] = providerInfo;
    return Promise.resolve({ success: true as const, data: providerInfo });
  });
  const removeCustomProvider = mock<APIClient["providers"]["removeCustomProvider"]>((input) => {
    delete providersConfig[input.provider];
    return Promise.resolve({ success: true as const, data: undefined });
  });
  const setProviderConfig = mock<APIClient["providers"]["setProviderConfig"]>((input) => {
    const provider = providersConfig[input.provider];
    if (provider) {
      const key = input.keyPath[0] as keyof ProviderConfigInfo | undefined;
      if (key) {
        if (input.value === "") {
          delete provider[key];
        } else {
          Object.assign(provider, { [key]: input.value });
        }
      }
    }
    return Promise.resolve({ success: true as const, data: undefined });
  });
  const onConfigChanged = mock(() => Promise.resolve(emptyConfigChangeIterator()));

  Object.assign(client.providers, {
    getConfig,
    addCustomProvider,
    removeCustomProvider,
    setProviderConfig,
    onConfigChanged,
  });

  return {
    addCustomProvider,
    getConfig,
    removeCustomProvider,
    setProviderConfig,
  };
}

function renderProvidersSection() {
  const providersConfig = createProvidersConfig();
  providersConfigMock = providersConfig;
  const client = setupSettingsStory({ providersConfig: {} });
  apiMock = client;
  const providerMocks = patchProviderMethods(client, providersConfig);
  const view = render(
    <SettingsSectionStory setup={() => client}>
      <ProvidersSection />
    </SettingsSectionStory>
  );

  return { ...view, ...providerMocks, providersConfig };
}

function getProviderCard(button: HTMLElement): HTMLElement {
  const card = button.parentElement;
  if (!card) {
    throw new Error("Provider button was not rendered inside a card");
  }
  return card;
}

describe("ProvidersSection", () => {
  let restoreDom: (() => void) | null = null;

  beforeEach(() => {
    restoreDom = installDom();
    // Re-register per test because afterEach restores the real module.
    void mock.module("@/browser/components/SelectPrimitive/SelectPrimitive", () =>
      createSelectPrimitiveDouble()
    );
    installTestDoubles();
    repairRemovedProviderMock = mock(
      (_provider: string, _workspaceIds: Iterable<string>) => undefined
    );
    providersConfigMock = null;
    apiMock = null;
    providersRefreshMock.mockClear();
    updateOptimisticallyMock.mockClear();
  });

  afterEach(() => {
    cleanup();
    mock.restore();
    // mock.module registrations are global across files in one bun run;
    // restore the real SelectPrimitive for other test files.
    void mock.module(
      "@/browser/components/SelectPrimitive/SelectPrimitive",
      () => ActualSelectPrimitiveModule
    );
    providersConfigMock = null;
    apiMock = null;
    restoreDom?.();
    restoreDom = null;
  });

  test("renders built-in and custom providers in separate groups", async () => {
    const view = renderProvidersSection();

    const directHeading = await view.findByText("Direct Providers");
    const customHeading = await view.findByText("Custom providers");

    expect(directHeading.parentElement?.textContent).toContain("OpenAI");
    expect(customHeading.parentElement?.textContent).toContain("Acme OpenAI");
  });

  test("renders a custom provider display name with fallback icon support", async () => {
    const view = renderProvidersSection();

    expect(await view.findByRole("button", { name: /Acme OpenAI/ })).toBeTruthy();
  });

  test("shows OpenAI-compatible custom provider fields when expanded", async () => {
    const view = renderProvidersSection();
    const customButton = await view.findByRole("button", { name: /Acme OpenAI/ });

    fireEvent.click(customButton);

    const customCard = getProviderCard(customButton);
    expect(within(customCard).getByText("Display name")).toBeTruthy();
    expect(within(customCard).getByText("API key")).toBeTruthy();
    expect(within(customCard).getByText("API key file")).toBeTruthy();
    expect(within(customCard).getByText("Base URL")).toBeTruthy();
  });

  test("persists API format changes for an existing custom provider", async () => {
    const view = renderProvidersSection();
    const customButton = await view.findByRole("button", { name: /Acme OpenAI/ });
    fireEvent.click(customButton);

    const customCard = getProviderCard(customButton);
    fireEvent.pointerDown(within(customCard).getByRole("combobox", { name: "API format" }));
    fireEvent.click(await within(customCard).findByRole("button", { name: "Anthropic Messages" }));

    // The write is queued behind the per-provider chain (a microtask).
    await waitFor(() => {
      expect(view.setProviderConfig).toHaveBeenCalledWith({
        provider: CUSTOM_PROVIDER_ID,
        keyPath: ["providerType"],
        value: "anthropic-messages",
      });
    });
  });

  test("resyncs from the backend when API format persistence fails", async () => {
    const view = renderProvidersSection();
    view.setProviderConfig.mockImplementationOnce(() =>
      Promise.resolve({ success: false as const, error: "policy denied" })
    );

    const customButton = await view.findByRole("button", { name: /Acme OpenAI/ });
    fireEvent.click(customButton);

    const customCard = getProviderCard(customButton);
    fireEvent.pointerDown(within(customCard).getByRole("combobox", { name: "API format" }));
    fireEvent.click(await within(customCard).findByRole("button", { name: "Anthropic Messages" }));

    // The optimistic format must not survive a failed persistence: the UI
    // restores the previous value (refresh alone is best-effort and keeps
    // optimistic state when the refetch fails) and refetches backend truth.
    await waitFor(() => {
      expect(updateOptimisticallyMock).toHaveBeenCalledWith(CUSTOM_PROVIDER_ID, {
        providerType: "openai-compatible",
      });
      expect(providersRefreshMock).toHaveBeenCalled();
    });
  });

  test("ignores a stale API-format failure after a newer selection", async () => {
    const view = renderProvidersSection();
    let rejectFirstWrite: ((error: Error) => void) | undefined;
    view.setProviderConfig.mockImplementationOnce(
      () =>
        new Promise((_resolve, reject) => {
          rejectFirstWrite = reject;
        })
    );

    const customButton = await view.findByRole("button", { name: /Acme OpenAI/ });
    fireEvent.click(customButton);
    const customCard = getProviderCard(customButton);

    // First selection: write held pending.
    fireEvent.pointerDown(within(customCard).getByRole("combobox", { name: "API format" }));
    fireEvent.click(await within(customCard).findByRole("button", { name: "Anthropic Messages" }));
    // Second selection while the first write is still in flight.
    fireEvent.pointerDown(within(customCard).getByRole("combobox", { name: "API format" }));
    fireEvent.click(await within(customCard).findByRole("button", { name: "OpenAI Responses" }));

    updateOptimisticallyMock.mockClear();
    rejectFirstWrite?.(new Error("late failure"));

    // The stale failure must not roll back the newer selection: the queued
    // second write persists and no reconciliation fires.
    await waitFor(() => {
      expect(view.setProviderConfig).toHaveBeenCalledWith({
        provider: CUSTOM_PROVIDER_ID,
        keyPath: ["providerType"],
        value: "openai-responses",
      });
    });
    expect(updateOptimisticallyMock).not.toHaveBeenCalledWith(CUSTOM_PROVIDER_ID, {
      providerType: "openai-compatible",
    });
    expect(providersRefreshMock).not.toHaveBeenCalled();
  });

  test("validates custom provider IDs in the add form", async () => {
    const view = renderProvidersSection();

    fireEvent.click(await view.findByRole("button", { name: "Add provider" }));

    expect(view.queryByText("Custom provider id is required.")).toBeNull();

    const providerIdInput = view.getByPlaceholderText("acme-openai") as HTMLInputElement;
    await userEvent.type(providerIdInput, "openai");

    await waitFor(() => {
      expect(providerIdInput.value).toBe("openai");
      expect(
        view.getByText('Custom provider id "openai" conflicts with a built-in provider.')
      ).toBeTruthy();
    });
  });

  test("submits and closes the custom provider add form", async () => {
    const view = renderProvidersSection();

    fireEvent.click(await view.findByRole("button", { name: "Add provider" }));

    await userEvent.type(view.getByPlaceholderText("acme-openai"), "team-openai");
    await userEvent.type(view.getByPlaceholderText("Acme OpenAI"), "Team OpenAI");
    await userEvent.type(
      view.getByPlaceholderText("https://api.acme.test/v1"),
      "https://team.example/v1"
    );
    await userEvent.type(view.getByPlaceholderText("gpt-4o-mini"), "qwen3-coder");
    fireEvent.click(view.getByRole("button", { name: "Add custom provider" }));

    await waitFor(() => {
      expect(view.addCustomProvider).toHaveBeenCalledWith({
        provider: "team-openai",
        providerType: "openai-compatible",
        displayName: "Team OpenAI",
        baseUrl: "https://team.example/v1",
        apiKey: undefined,
        apiKeyFile: undefined,
        models: ["qwen3-coder"],
      });
    });
    await waitFor(() => {
      expect(view.queryByRole("button", { name: "Add custom provider" })).toBeNull();
    });
    expect(view.getByRole("button", { name: "Add provider" })).toBeTruthy();
  });

  test("closes the add form and shows a notice when refresh fails after add", async () => {
    providersRefreshMock.mockImplementationOnce(() => Promise.reject(new Error("refresh failed")));
    const view = renderProvidersSection();

    fireEvent.click(await view.findByRole("button", { name: "Add provider" }));

    await userEvent.type(view.getByPlaceholderText("acme-openai"), "team-openai");
    await userEvent.type(view.getByPlaceholderText("Acme OpenAI"), "Team OpenAI");
    await userEvent.type(
      view.getByPlaceholderText("https://api.acme.test/v1"),
      "https://team.example/v1"
    );
    fireEvent.click(view.getByRole("button", { name: "Add custom provider" }));

    await waitFor(() => {
      expect(view.addCustomProvider).toHaveBeenCalled();
    });
    await waitFor(() => {
      expect(view.queryByRole("button", { name: "Add custom provider" })).toBeNull();
    });
    expect(view.queryByText("Failed to add custom provider.")).toBeNull();
    expect(
      await view.findByText(
        "Provider added, but refreshing the provider list failed. It may appear after reopening settings."
      )
    ).toBeTruthy();
  });

  test("shows and persists the OpenAI WebSocket transport toggle", async () => {
    const view = renderProvidersSection();
    const openAiButton = await view.findByRole("button", { name: /^OpenAI\b/ });

    fireEvent.click(openAiButton);

    const openAiCard = getProviderCard(openAiButton);
    const webSocketToggle = within(openAiCard).getByRole("switch", {
      name: /WebSocket transport/i,
    });
    expect(webSocketToggle).toBeTruthy();

    fireEvent.click(webSocketToggle);

    await waitFor(() => {
      expect(view.setProviderConfig).toHaveBeenCalledWith({
        provider: "openai",
        keyPath: ["webSocketTransportEnabled"],
        value: true,
      });
    });
  });

  test("clears the OpenAI WebSocket transport preference when toggled off", async () => {
    const view = renderProvidersSection();
    view.providersConfig.openai.webSocketTransportEnabled = true;
    const openAiButton = await view.findByRole("button", { name: /^OpenAI\b/ });

    fireEvent.click(openAiButton);

    const openAiCard = getProviderCard(openAiButton);
    const webSocketToggle = within(openAiCard).getByRole("switch", {
      name: /WebSocket transport/i,
    });

    fireEvent.click(webSocketToggle);

    await waitFor(() => {
      expect(view.setProviderConfig).toHaveBeenCalledWith({
        provider: "openai",
        keyPath: ["webSocketTransportEnabled"],
        value: "",
      });
    });
  });

  test("shows the OpenAI WebSocket transport toggle when Codex OAuth is the active default", async () => {
    const view = renderProvidersSection();
    view.providersConfig.openai.codexOauthSet = true;
    view.providersConfig.openai.apiKeySet = false;
    view.providersConfig.openai.webSocketTransportEnabled = true;
    const openAiButton = await view.findByRole("button", { name: /^OpenAI\b/ });

    fireEvent.click(openAiButton);

    const openAiCard = getProviderCard(openAiButton);
    expect(
      within(openAiCard).getByRole("switch", {
        name: /WebSocket transport/i,
      })
    ).toBeTruthy();
    expect(view.providersConfig.openai.webSocketTransportEnabled).toBe(true);
  });

  test("shows the OpenAI WebSocket transport toggle when OpenAI uses a custom base URL", async () => {
    const view = renderProvidersSection();
    view.providersConfig.openai.baseUrl = "https://proxy.openai.test/v1";
    view.providersConfig.openai.webSocketTransportEnabled = true;
    const openAiButton = await view.findByRole("button", { name: /^OpenAI\b/ });

    fireEvent.click(openAiButton);

    const openAiCard = getProviderCard(openAiButton);
    expect(
      within(openAiCard).getByRole("switch", {
        name: /WebSocket transport/i,
      })
    ).toBeTruthy();
    expect(view.providersConfig.openai.webSocketTransportEnabled).toBe(true);
  });

  test("hides the OpenAI WebSocket transport toggle for Chat Completions without clearing it", async () => {
    const view = renderProvidersSection();
    view.providersConfig.openai.wireFormat = "chatCompletions";
    view.providersConfig.openai.webSocketTransportEnabled = true;
    const openAiButton = await view.findByRole("button", { name: /^OpenAI\b/ });

    fireEvent.click(openAiButton);

    const openAiCard = getProviderCard(openAiButton);
    expect(
      within(openAiCard).queryByRole("switch", {
        name: /WebSocket transport/i,
      })
    ).toBeNull();
    expect(within(openAiCard).queryByText("WebSocket transport")).toBeNull();
    expect(view.providersConfig.openai.webSocketTransportEnabled).toBe(true);
    expect(view.setProviderConfig).not.toHaveBeenCalledWith(
      expect.objectContaining({ keyPath: ["webSocketTransportEnabled"], value: "" })
    );
  });

  test("shows remove only for expanded custom provider cards", async () => {
    const view = renderProvidersSection();
    const customButton = await view.findByRole("button", { name: /Acme OpenAI/ });

    fireEvent.click(customButton);
    expect(
      within(getProviderCard(customButton)).getByRole("button", { name: "Remove" })
    ).toBeTruthy();

    const openAiButton = view.getByRole("button", { name: /^OpenAI\b/ });
    fireEvent.click(openAiButton);
    expect(
      within(getProviderCard(openAiButton)).queryByRole("button", { name: "Remove" })
    ).toBeNull();
  });

  test("removes the custom provider row and warns when config repair fails", async () => {
    const view = renderProvidersSection();
    const confirmMock = mock(() => true);
    window.confirm = confirmMock;
    view.removeCustomProvider.mockImplementationOnce((input: { provider: string }) => {
      delete view.providersConfig[input.provider];
      return Promise.resolve({
        success: false as const,
        error: {
          code: "config_repair_failed" as const,
          message: "Provider removed, but saved model references could not be repaired.",
        },
      });
    });

    const customButton = await view.findByRole("button", { name: /Acme OpenAI/ });
    fireEvent.click(customButton);
    fireEvent.click(within(getProviderCard(customButton)).getByRole("button", { name: "Remove" }));

    await waitFor(() => {
      expect(view.removeCustomProvider).toHaveBeenCalledWith({ provider: CUSTOM_PROVIDER_ID });
    });
    await waitFor(() => {
      expect(view.queryByRole("button", { name: /Acme OpenAI/ })).toBeNull();
    });
    expect(
      await view.findByText(
        "Provider removed, but updating saved preferences failed. You may need to clear stale model defaults manually."
      )
    ).toBeTruthy();
  });

  test("calls the custom provider remove mutation after confirmation", async () => {
    const view = renderProvidersSection();
    const confirmMock = mock(() => true);
    window.confirm = confirmMock;

    const customButton = await view.findByRole("button", { name: /Acme OpenAI/ });
    fireEvent.click(customButton);
    fireEvent.click(within(getProviderCard(customButton)).getByRole("button", { name: "Remove" }));

    await waitFor(() => {
      expect(view.removeCustomProvider).toHaveBeenCalledWith({ provider: CUSTOM_PROVIDER_ID });
    });
    expect(confirmMock).toHaveBeenCalledTimes(1);
    expect(repairRemovedProviderMock).toHaveBeenCalledWith(CUSTOM_PROVIDER_ID, expect.any(Set));
  });

  test("invalidates queued format writes when the provider is removed", async () => {
    const view = renderProvidersSection();
    window.confirm = mock(() => true);
    let resolveFirstWrite: ((value: { success: true; data: undefined }) => void) | undefined;
    view.setProviderConfig.mockImplementationOnce(
      () =>
        new Promise((resolve) => {
          resolveFirstWrite = resolve;
        })
    );

    const customButton = await view.findByRole("button", { name: /Acme OpenAI/ });
    fireEvent.click(customButton);
    const customCard = getProviderCard(customButton);

    // First selection blocks in flight; second queues behind it.
    fireEvent.pointerDown(within(customCard).getByRole("combobox", { name: "API format" }));
    fireEvent.click(await within(customCard).findByRole("button", { name: "Anthropic Messages" }));
    await waitFor(() => {
      expect(view.setProviderConfig).toHaveBeenCalledTimes(1);
    });
    fireEvent.pointerDown(within(customCard).getByRole("combobox", { name: "API format" }));
    fireEvent.click(await within(customCard).findByRole("button", { name: "OpenAI Responses" }));

    // Removal invalidates the queue, then the in-flight write completes.
    fireEvent.click(within(customCard).getByRole("button", { name: "Remove" }));
    await waitFor(() => {
      expect(view.removeCustomProvider).toHaveBeenCalledWith({ provider: CUSTOM_PROVIDER_ID });
    });
    resolveFirstWrite?.({ success: true, data: undefined });
    await Promise.resolve();

    // The queued write must never fire: it would recreate the removed entry.
    expect(view.setProviderConfig).toHaveBeenCalledTimes(1);
  });

  /**
   * Browser-mode Coder login harness: no window.api (browser, not desktop), a
   * configured deployment URL, and a fetch double standing in for the Xum
   * server's /auth/coder/start route. Returns the recorded start requests and
   * the waitForDesktopFlow mock the flow continues on.
   */
  function setupBrowserCoderLogin(opts: { hint: boolean }) {
    const providersConfig = createProvidersConfig();
    providersConfig.coder = {
      apiKeySet: false,
      isEnabled: true,
      isConfigured: true,
      deploymentUrl: "https://coder.example.com",
    };
    providersConfigMock = providersConfig;
    const client = setupSettingsStory({ providersConfig: {} });
    apiMock = client;

    const startDesktopFlow = mock((_input: { deploymentUrl: string; flowId?: string }) =>
      Promise.resolve({
        success: true as const,
        data: { flowId: "flow", authorizeUrl: "https://coder.example.com/oauth2/authorize" },
      })
    );
    const waitForDesktopFlow = mock(
      // Never resolves — the user would complete the login in the browser.
      (_input: { flowId: string }) => new Promise<never>(() => undefined)
    );
    (client as unknown as Record<string, unknown>).coderOauth = {
      startDesktopFlow,
      waitForDesktopFlow,
      cancelDesktopFlow: () => Promise.resolve(undefined),
    };

    const startRequests: URL[] = [];
    const fetchDouble = (input: RequestInfo | URL) => {
      const url = new URL(typeof input === "string" ? input : (input as URL).toString());
      startRequests.push(url);
      return Promise.resolve(
        new Response(
          JSON.stringify({
            flowId: url.searchParams.get("flowId"),
            authorizeUrl: "https://coder.example.com/oauth2/authorize",
          }),
          { status: 200, headers: { "Content-Type": "application/json" } }
        )
      );
    };
    spyOn(globalThis, "fetch").mockImplementation(
      Object.assign(fetchDouble, { preconnect: () => undefined }) as typeof fetch
    );

    // Stateful hint: true until the section consumes it, so re-renders after
    // consumption do not re-trigger the login.
    let startCoderLoginHint = opts.hint;
    const setProvidersStartCoderLogin = mock((start: boolean) => {
      startCoderLoginHint = start;
    });
    spyOn(SettingsContextModule, "useSettings").mockImplementation(() => ({
      isOpen: true,
      activeSection: "providers",
      open: () => undefined,
      close: () => undefined,
      setActiveSection: () => undefined,
      registerOnClose: () => () => undefined,
      providersExpandedProvider: opts.hint ? null : "coder",
      setProvidersExpandedProvider: () => undefined,
      providersStartCoderLogin: startCoderLoginHint,
      setProvidersStartCoderLogin,
      runtimesProjectPath: null,
      setRuntimesProjectPath: () => undefined,
      secretsProjectPath: null,
      setSecretsProjectPath: () => undefined,
      instructionsProjectPath: null,
      setInstructionsProjectPath: () => undefined,
    }));

    const view = render(
      <SettingsSectionStory setup={() => client}>
        <ProvidersSection />
      </SettingsSectionStory>
    );
    return {
      view,
      startDesktopFlow,
      waitForDesktopFlow,
      startRequests,
      setProvidersStartCoderLogin,
    };
  }

  test("startCoderLogin hint launches the Coder OAuth flow against the configured deployment", async () => {
    // Regression: the "Settings: Login with Coder" palette command passes a
    // one-shot startCoderLogin hint through SettingsContext; ProvidersSection
    // must consume it by actually starting the OAuth flow, not just opening
    // the Providers list. The hint is injected by spying on useSettings
    // (a full-plumbing variant that clicked through a live SettingsProvider
    // proved order-fragile in the monolithic CI process).
    const { startDesktopFlow, waitForDesktopFlow, startRequests, setProvidersStartCoderLogin } =
      setupBrowserCoderLogin({ hint: true });

    await waitFor(() => {
      expect(startRequests).toHaveLength(1);
    });
    // The hint is one-shot: consumed (cleared) exactly once, one flow started.
    expect(setProvidersStartCoderLogin).toHaveBeenCalledWith(false);
    // Browser mode: the server-hosted flow, not the desktop loopback one.
    expect(startDesktopFlow).not.toHaveBeenCalled();
    expect(startRequests[0].pathname).toBe("/auth/coder/start");
    expect(startRequests[0].searchParams.get("deploymentUrl")).toBe("https://coder.example.com");
    // The flow then continues on the shared oRPC wait with the started flow ID.
    await waitFor(() => {
      expect(waitForDesktopFlow).toHaveBeenCalledTimes(1);
    });
    const startedFlowId = startRequests[0].searchParams.get("flowId");
    expect(startedFlowId).toBeTruthy();
    expect(waitForDesktopFlow.mock.calls[0][0].flowId).toBe(startedFlowId!);
    expect(startRequests).toHaveLength(1);
  });

  test("offers Login with Coder on a remote Xum server and starts the server-hosted flow", async () => {
    // Regression: remote browsers used to get an explanation instead of the
    // login control ("the OAuth callback must reach this machine"). The
    // callback now lands on the server's own origin, so the control renders
    // and the start request targets that origin.
    (window as unknown as { happyDOM: { setURL: (url: string) => void } }).happyDOM.setURL(
      "https://xum.example.com/"
    );
    const { view, startRequests } = setupBrowserCoderLogin({ hint: false });

    const loginButton = await view.findByRole("button", { name: "Login with Coder" });
    expect(view.queryByText(/requires the desktop app/)).toBeNull();

    fireEvent.click(loginButton);

    await waitFor(() => {
      expect(startRequests).toHaveLength(1);
    });
    expect(startRequests[0].origin).toBe("https://xum.example.com");
    expect(startRequests[0].pathname).toBe("/auth/coder/start");
    await view.findByText("Waiting for authorization...");
  });
});

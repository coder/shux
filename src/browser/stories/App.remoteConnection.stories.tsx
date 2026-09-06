import { expect, fn, userEvent, waitFor, within } from "@storybook/test";
import { appMeta, AppWithMocks, type AppStory } from "./meta.js";
import { expandLeftSidebar } from "./helpers/uiState";
import { setupSettingsStory } from "@/browser/features/Settings/Sections/settingsStoryUtils";
import { REMOTE_CONNECTION_ORIGIN_KEY } from "@/browser/features/Settings/Sections/RemoteConnectionSection";
import { readPersistedState, updatePersistedState } from "@/browser/hooks/usePersistedState";
import {
  parseRemoteConnectionUrl,
  type RemoteConnectionApi,
  type RemoteConnectionState,
} from "@/common/types/remoteConnection";

const SAVED_ORIGIN = "https://saved.example.com";
const SERVER_ORIGIN = "https://remote.example.com";
const TOKEN_URL = SERVER_ORIGIN + "/?token=transient-secret#private-fragment";

function createRemoteBridge() {
  let state: RemoteConnectionState = { origin: null, status: "disconnected" };
  const listeners = new Set<(next: RemoteConnectionState) => void>();
  const publish = (next: RemoteConnectionState) => {
    state = next;
    for (const listener of listeners) listener(next);
  };
  const bridge = {
    getState: fn(() => Promise.resolve(state)),
    connect: fn((url: string) => {
      publish({ origin: parseRemoteConnectionUrl(url).origin, status: "connecting" });
      return Promise.resolve();
    }),
    disconnect: fn(() => {
      publish({ origin: null, status: "disconnected" });
      return Promise.resolve();
    }),
    onStateChanged: fn((listener: (next: RemoteConnectionState) => void) => {
      listeners.add(listener);
      return () => {
        listeners.delete(listener);
      };
    }),
  } satisfies RemoteConnectionApi;
  return { bridge, publish, listeners };
}

let remote = createRemoteBridge();

export default {
  ...appMeta,
  title: "App/RemoteConnection",
  beforeEach: () => {
    const previousApi = window.api;
    const previousOrigin = readPersistedState<unknown>(REMOTE_CONNECTION_ORIGIN_KEY, undefined);
    remote = createRemoteBridge();
    window.api = {
      platform: "linux",
      versions: {},
      ...previousApi,
      remoteConnection: remote.bridge,
    };
    updatePersistedState(REMOTE_CONNECTION_ORIGIN_KEY, SAVED_ORIGIN);
    return () => {
      window.api = previousApi;
      updatePersistedState(REMOTE_CONNECTION_ORIGIN_KEY, previousOrigin);
    };
  },
};

function setupRemoteSettings() {
  expandLeftSidebar();
  return setupSettingsStory({});
}

async function openSettings(canvasElement: HTMLElement) {
  const canvas = within(canvasElement);
  await userEvent.click(await canvas.findByTestId("settings-button", {}, { timeout: 10000 }));
  return canvas;
}

async function openRemoteSettings(canvasElement: HTMLElement) {
  const canvas = await openSettings(canvasElement);
  await userEvent.click(await canvas.findByRole("button", { name: "Remote Connection" }));
  return within(await canvas.findByRole("region", { name: "Remote connection" }));
}

async function exerciseConnection(canvasElement: HTMLElement) {
  const canvas = within(canvasElement);
  const section = await openRemoteSettings(canvasElement);
  await waitFor(() => expect(section.getByRole("status")).toHaveTextContent("Disconnected"));
  const input = section.getByRole("textbox", { name: "Server URL" });
  await expect(input).toHaveValue(SAVED_ORIGIN);
  await expect(remote.bridge.connect).not.toHaveBeenCalled();

  // Invalid schemes and embedded passwords never reach the bridge or saved preferences.
  for (const invalidUrl of [
    "ftp://remote.example.com",
    "https://user:password@remote.example.com",
  ]) {
    await userEvent.clear(input);
    await userEvent.type(input, invalidUrl + "{Enter}");
    await expect(await section.findByRole("alert")).toBeVisible();
    await expect(remote.bridge.connect).not.toHaveBeenCalled();
    await expect(readPersistedState(REMOTE_CONNECTION_ORIGIN_KEY, "")).toBe(SAVED_ORIGIN);
  }

  remote.bridge.connect.mockRejectedValueOnce(new Error("The remote server is unavailable."));
  await userEvent.clear(input);
  await userEvent.type(input, "https://offline.example.com/?token=failed-secret{Enter}");
  await expect(await section.findByRole("alert")).toHaveTextContent(
    "The remote server is unavailable."
  );
  await expect(section.getByRole("button", { name: "Connect" })).toBeEnabled();
  await expect(readPersistedState(REMOTE_CONNECTION_ORIGIN_KEY, "")).toBe(
    "https://offline.example.com"
  );

  await userEvent.clear(input);
  await userEvent.type(input, TOKEN_URL);
  await expect(readPersistedState(REMOTE_CONNECTION_ORIGIN_KEY, "")).toBe(
    "https://offline.example.com"
  );
  await userEvent.keyboard("{Enter}");
  await waitFor(() => expect(remote.bridge.connect).toHaveBeenLastCalledWith(TOKEN_URL));
  await expect(section.getByRole("button", { name: "Connecting…" })).toBeDisabled();
  await expect(readPersistedState(REMOTE_CONNECTION_ORIGIN_KEY, "")).toBe(SERVER_ORIGIN);
  await expect(input).toHaveValue(SERVER_ORIGIN);
  await expect(section.queryByRole("alert")).toBeNull();

  remote.publish({ origin: SERVER_ORIGIN, status: "connected" });
  await waitFor(() => expect(section.getByRole("status")).toHaveTextContent("Connected"));
  const disconnect = section.getByRole("button", { name: "Disconnect" });
  disconnect.focus();
  await userEvent.keyboard("{Enter}");
  await waitFor(() => expect(remote.bridge.disconnect).toHaveBeenCalledTimes(1));
  await expect(disconnect).toBeDisabled();

  await userEvent.click(canvas.getByRole("button", { name: "General" }));
  await expect(remote.listeners.size).toBe(0);
  await userEvent.click(canvas.getByRole("button", { name: "Remote Connection" }));
  const restored = within(await canvas.findByRole("region", { name: "Remote connection" }));
  await expect(restored.getByRole("textbox", { name: "Server URL" })).toHaveValue(SERVER_ORIGIN);
  await expect(remote.bridge.connect).toHaveBeenCalledTimes(2);
  await expect(remote.listeners.size).toBe(1);

  // The test-runner ignores viewport globals. Pixel runs this contract at the pinned phone width.
  if (window.innerWidth < 768) {
    const region = canvas.getByRole("region", { name: "Remote connection" });
    await expect(region.scrollWidth).toBeLessThanOrEqual(region.clientWidth);
    for (const control of restored.getAllByRole("button")) {
      await expect(control.getBoundingClientRect().right).toBeLessThanOrEqual(window.innerWidth);
    }
  }
}

export const Desktop: AppStory = {
  globals: { viewport: { value: "desktop", isRotated: false } },
  parameters: { pixel: { matrix: { themes: ["dark", "light"], viewports: ["desktop"] } } },
  render: () => <AppWithMocks setup={setupRemoteSettings} />,
  play: async ({ canvasElement }) => exerciseConnection(canvasElement),
};

export const Phone: AppStory = {
  ...Desktop,
  globals: { viewport: { value: "mobile1", isRotated: false } },
  parameters: { pixel: { matrix: { themes: ["dark", "light"], viewports: ["phone"] } } },
  play: async ({ canvasElement, parameters }) => {
    // Keep the narrow capture when the story matrix changes.
    await expect(parameters.pixel).toMatchObject({ matrix: { viewports: ["phone"] } });
    await exerciseConnection(canvasElement);
  },
};

export const NewerStateWins: AppStory = {
  render: () => <AppWithMocks setup={setupRemoteSettings} />,
  play: async ({ canvasElement }) => {
    // Deliver an event while the initial snapshot is pending.
    let resolveSnapshot!: (state: RemoteConnectionState) => void;
    remote.bridge.getState.mockImplementationOnce(
      () =>
        new Promise((resolve) => {
          resolveSnapshot = resolve;
        })
    );
    const section = await openRemoteSettings(canvasElement);
    await waitFor(() => expect(remote.bridge.getState).toHaveBeenCalled());
    remote.publish({ origin: SERVER_ORIGIN, status: "connected" });
    resolveSnapshot({ origin: null, status: "disconnected" });
    await waitFor(() => expect(section.getByRole("status")).toHaveTextContent("Connected"));
    await expect(section.getByRole("button", { name: "Disconnect" })).toBeEnabled();
    await expect(section.getByRole("button", { name: "Connect" })).toBeDisabled();
    await expect(remote.bridge.connect).not.toHaveBeenCalled();
  },
};

export const InvalidSavedOrigin: AppStory = {
  beforeEach: () => {
    updatePersistedState(REMOTE_CONNECTION_ORIGIN_KEY, { invalid: true });
  },
  render: () => <AppWithMocks setup={setupRemoteSettings} />,
  play: async ({ canvasElement }) => {
    const section = await openRemoteSettings(canvasElement);
    await expect(section.getByRole("textbox", { name: "Server URL" })).toHaveValue("");
    await expect(section.getByRole("button", { name: "Connect" })).toBeDisabled();
    await expect(remote.bridge.connect).not.toHaveBeenCalled();
  },
};

export const BrowserWithoutBridge: AppStory = {
  beforeEach: () => {
    delete window.api;
  },
  render: () => <AppWithMocks setup={setupRemoteSettings} />,
  play: async ({ canvasElement }) => {
    const canvas = await openSettings(canvasElement);
    await expect(await canvas.findByRole("button", { name: "Server Access" })).toBeVisible();
    await expect(canvas.queryByRole("button", { name: "Remote Connection" })).toBeNull();
  },
};

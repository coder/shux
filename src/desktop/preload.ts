/**
 * Electron Preload Script
 *
 * This script bridges the renderer process with the main process via ORPC over MessagePort.
 *
 * Key responsibilities:
 * 1) Forward MessagePort from renderer to main process for ORPC transport setup
 * 2) Expose minimal platform info to renderer via contextBridge
 *
 * The ORPC connection flow:
 * - Renderer creates MessageChannel, posts "start-orpc-client" with serverPort
 * - Preload intercepts, forwards serverPort to main via ipcRenderer.postMessage
 * - Main process upgrades the port with RPCHandler for bidirectional RPC
 *
 * Build: `bun build src/desktop/preload.ts --format=cjs --target=node --external=electron`
 */

import { resolveXumEnvironmentValue } from "@/common/compat/legacyMux";
import { contextBridge, ipcRenderer } from "electron";
import type { DeepLinkPayload } from "@/common/types/deepLink";
import type { RemoteConnectionApi, RemoteConnectionState } from "@/common/types/remoteConnection";
import { REMOTE_CONNECTION_CHANNELS } from "@/common/constants/remoteConnection";

const getXumEnv = (suffix: string): string | undefined =>
  resolveXumEnvironmentValue(suffix, process.env);

// xum:// and legacy mux:// deep links can arrive before the React app subscribes.
// Buffer them here so the renderer can consume them on mount.
const pendingDeepLinks: DeepLinkPayload[] = [];
const deepLinkSubscribers = new Set<(payload: DeepLinkPayload) => void>();

ipcRenderer.on("mux:deep-link", (_event: unknown, payload: DeepLinkPayload) => {
  if (deepLinkSubscribers.size === 0) {
    pendingDeepLinks.push(payload);
  }

  for (const subscriber of deepLinkSubscribers) {
    try {
      subscriber(payload);
    } catch (error) {
      // Best-effort: a renderer bug shouldn't break deep link delivery.
      console.debug("[deep-link] Renderer subscriber threw:", error);
    }
  }
});

function getEnableTutorialsInSandbox(): boolean | undefined {
  const raw = getXumEnv("ENABLE_TUTORIALS_IN_SANDBOX");
  if (raw == null) {
    return undefined;
  }

  return raw === "1";
}

// Forward ORPC MessagePort from renderer to main process
window.addEventListener("message", (event) => {
  if (event.source === window && event.data === "start-orpc-client" && event.ports?.[0]) {
    ipcRenderer.postMessage("start-orpc-server", null, [...event.ports]);
  }
});

const remoteConnection: RemoteConnectionApi = {
  getState: () => ipcRenderer.invoke(REMOTE_CONNECTION_CHANNELS.getState),
  connect: (url) => ipcRenderer.invoke(REMOTE_CONNECTION_CHANNELS.connect, url),
  disconnect: () => ipcRenderer.invoke(REMOTE_CONNECTION_CHANNELS.disconnect),
  onStateChanged: (callback) => {
    const listener = (_event: unknown, state: RemoteConnectionState) => callback(state);
    ipcRenderer.on(REMOTE_CONNECTION_CHANNELS.stateChanged, listener);
    return () => ipcRenderer.off(REMOTE_CONNECTION_CHANNELS.stateChanged, listener);
  },
};

contextBridge.exposeInMainWorld("api", {
  remoteConnection,
  platform: process.platform,
  versions: {
    node: process.versions.node,
    chrome: process.versions.chrome,
    electron: process.versions.electron,
  },
  isE2E: getXumEnv("E2E") === "1",
  enableReactPerfProfile: getXumEnv("PROFILE_REACT") === "1",
  enableTelemetryInDev: getXumEnv("ENABLE_TELEMETRY_IN_DEV") === "1",
  enableTutorialsInSandbox: getEnableTutorialsInSandbox(),
  // Note: When debugging LLM requests, we also want to see synthetic/request-only
  // messages in the chat history so the UI matches what was sent to the provider.
  debugLlmRequest: getXumEnv("DEBUG_LLM_REQUEST") === "1",
  // NOTE: This is intentionally async so the preload script does not rely on Node builtins
  // like `child_process` (which can break in hardened/sandboxed environments).
  getIsRosetta: () => ipcRenderer.invoke("mux:get-is-rosetta"),
  getIsWindowsWslShell: () => ipcRenderer.invoke("mux:get-is-windows-wsl-shell"),
  // Register a callback for notification clicks (navigates to workspace)
  // Returns an unsubscribe function.
  onNotificationClicked: (callback: (data: { workspaceId: string }) => void) => {
    const listener = (_event: unknown, data: { workspaceId: string }) => callback(data);
    ipcRenderer.on("mux:notification-clicked", listener);
    return () => {
      ipcRenderer.off("mux:notification-clicked", listener);
    };
  },
  consumePendingDeepLinks: () => pendingDeepLinks.splice(0, pendingDeepLinks.length),
  onDeepLink: (callback: (payload: DeepLinkPayload) => void) => {
    deepLinkSubscribers.add(callback);
    return () => {
      deepLinkSubscribers.delete(callback);
    };
  },
});

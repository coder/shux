import type { RouterClient } from "@orpc/server";
import type { AppRouter } from "@/node/orpc/router";
import type { DeepLinkPayload } from "@/common/types/deepLink";
import type { RemoteConnectionApi } from "@/common/types/remoteConnection";

declare global {
  interface WindowApi {
    platform: NodeJS.Platform;
    versions: {
      node?: string;
      chrome?: string;
      electron?: string;
    };
    // Debug flags (dev-only, passed through preload)
    debugLlmRequest?: boolean;
    // Allow maintainers to opt into telemetry while running the dev server.
    enableTelemetryInDev?: boolean;
    // E2E test mode flag - used to adjust UI behavior (e.g., longer toast durations)
    isE2E?: boolean;
    // Enables in-app React render capture for dev profiling and automated perf tests.
    enableReactPerfProfile?: boolean;
    // Sandbox launchers default tutorials off unless explicitly re-enabled by env.
    enableTutorialsInSandbox?: boolean;
    // True if running under Rosetta 2 translation on Apple Silicon (storybook/tests may set this)
    isRosetta?: boolean;
    // Async getter (used in Electron) for environments where preload cannot use Node builtins
    getIsRosetta?: () => Promise<boolean>;
    // True if Windows appears to be configured to use WSL as the default shell.
    isWindowsWslShell?: boolean;
    // Async getter (Electron) for Windows environments where WSL may win PATH.
    getIsWindowsWslShell?: () => Promise<boolean>;
    // Register a callback for notification clicks (navigates to workspace)
    // Returns an unsubscribe function.
    onNotificationClicked?: (callback: (data: { workspaceId: string }) => void) => () => void;
    // Consume any mux:// deep links received before the renderer subscribed.
    consumePendingDeepLinks?: () => DeepLinkPayload[];
    // Subscribe to mux:// deep links as they arrive. Returns an unsubscribe function.
    onDeepLink?: (callback: (payload: DeepLinkPayload) => void) => () => void;
    // Only the local desktop renderer can control remote windows.
    remoteConnection?: RemoteConnectionApi;
    // Optional ORPC-backed API surfaces populated in tests/storybook mocks
    tokenizer?: unknown;
    providers?: unknown;
    nameGeneration?: unknown;
    workspace?: unknown;
    projects?: unknown;
    window?: unknown;
    terminal?: unknown;
    update?: unknown;
    server?: unknown;
  }

  interface Window {
    api?: WindowApi;
    __ORPC_CLIENT__?: RouterClient<AppRouter>;
    process?: {
      env?: Record<string, string | undefined>;
    };
    /**
     * Optional localhost proxy URI template injected into browser-mode SPA HTML.
     * Uses VS Code/Coder-style placeholders (e.g. "{{port}}", "{{host}}").
     */
    __MUX_PROXY_URI_TEMPLATE__?: string | null;
  }

  /**
   * Optional tutorial sandbox override injected either by Vite (`define`) in browser-mode sandboxes
   * or by Electron preload. `null`/`undefined` means normal tutorial behavior.
   */
  var __MUX_ENABLE_TUTORIALS_IN_SANDBOX__: boolean | null | undefined;
}

export {};

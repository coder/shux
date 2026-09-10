/**
 * Terminal utilities for managing terminal sessions and windows.
 *
 * Consolidates common terminal operations used across:
 * - useOpenTerminal hook (new pop-out terminals)
 * - RightSidebar (integrated terminals, pop-out existing)
 */

import type { RouterClient } from "@orpc/server";
import type { AppRouter } from "@/node/orpc/router";
import { resolveBrowserAssetUrl } from "@/browser/utils/frontendBasePath";

type APIClient = RouterClient<AppRouter>;

/** Default terminal size used when creating sessions before the terminal is mounted */

export interface TerminalSessionCreateOptions {
  /** Optional command to run immediately after terminal creation */
  initialCommand?: string;
}
export const DEFAULT_TERMINAL_SIZE = { cols: 80, rows: 24 };

/**
 * Open a terminal in a pop-out window.
 *
 * Handles both browser mode (window.open) and Electron mode (terminal.openWindow).
 * In browser mode, opens the window client-side since the backend can't open windows.
 * In Electron mode, the backend opens a BrowserWindow.
 *
 * Returns the underlying `api.terminal.openWindow` promise so callers can observe and
 * surface backend failures. Without this, an Electron-side `terminalWindowManager` reject
 * would become an unhandled promise rejection — the same silent-freeze symptom we are
 * trying to fix on the Run-button path. The browser-mode `window.open` call is synchronous
 * and not part of the returned promise.
 *
 * @param api - The API client
 * @param workspaceId - Workspace ID
 * @param sessionId - Terminal session ID (required)
 */
export function openTerminalPopout(
  api: APIClient,
  workspaceId: string,
  sessionId: string,
  initialTitle?: string
): Promise<void> {
  const isBrowser = !window.api;

  if (isBrowser) {
    // In browser mode, we must open the window client-side
    // The backend cannot open a window on the user's client
    const params = new URLSearchParams({ workspaceId, sessionId });
    if (initialTitle) {
      params.set("title", initialTitle);
    }
    const terminalUrl = resolveBrowserAssetUrl(`terminal.html?${params.toString()}`);
    window.open(
      terminalUrl,
      `terminal-${workspaceId}-${Date.now()}`,
      "width=1000,height=600,popup=yes"
    );
  }

  // Open via backend (Electron pops up BrowserWindow, browser already opened above).
  // Returned to the caller so a backend rejection can be observed instead of vanishing
  // into an unhandled promise rejection.
  return api.terminal.openWindow({ workspaceId, sessionId, initialTitle });
}

/**
 * Create a new terminal session with default size.
 *
 * @param api - The API client
 * @param workspaceId - Workspace ID
 * @returns The created session with sessionId
 */
export async function createTerminalSession(
  api: APIClient,
  workspaceId: string,
  options?: TerminalSessionCreateOptions
): Promise<{ sessionId: string; workspaceId: string; cols: number; rows: number }> {
  return api.terminal.create({
    workspaceId,
    cols: DEFAULT_TERMINAL_SIZE.cols,
    rows: DEFAULT_TERMINAL_SIZE.rows,
    initialCommand: options?.initialCommand,
  });
}

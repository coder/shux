/**
 * Terminal Window Manager
 *
 * Manages pop-out terminal windows for workspaces.
 * Each workspace can have multiple terminal windows open simultaneously.
 */

import { app, BrowserWindow, shell, type BrowserWindowConstructorOptions } from "electron";
import * as path from "path";
import { resolveXumEnvironmentValue } from "@/common/compat/legacyMux";
import { normalizeAndValidateExternalUrl } from "@/desktop/utils/normalizeAndValidateExternalUrl";
import { log } from "@/node/services/log";
import type { Config } from "@/node/config";

// XUM_PROXY_URI explicitly overrides VSCODE_PROXY_URI for localhost external-link rewrites.
const xumProxyUri = resolveXumEnvironmentValue("PROXY_URI", process.env)?.trim();
const localhostProxyTemplate =
  // eslint-disable-next-line @typescript-eslint/prefer-nullish-coalescing -- empty/whitespace-only env vars should be treated as unset
  xumProxyUri || process.env.VSCODE_PROXY_URI?.trim() || undefined;

export class TerminalWindowManager {
  private windows = new Map<string, Set<BrowserWindow>>(); // workspaceId -> Set of windows
  private windowCount = 0; // Counter for unique window IDs
  private readonly config: Config;

  constructor(
    config: Config,
    private readonly createWindow: (options: BrowserWindowConstructorOptions) => BrowserWindow = (
      options
    ) => new BrowserWindow(options)
  ) {
    this.config = config;
  }

  /**
   * Open a new terminal window for a workspace
   * Multiple windows can be open for the same workspace
   * @param sessionId Optional session ID to reattach to (for pop-out handoff from embedded terminal)
   */
  async openTerminalWindow(
    workspaceId: string,
    sessionId?: string,
    initialTitle?: string
  ): Promise<void> {
    this.windowCount++;
    const windowId = this.windowCount;

    // Look up workspace metadata to get project and branch names
    const allWorkspaces = await this.config.getAllWorkspaceMetadata();
    const workspace = allWorkspaces.find((ws) => ws.id === workspaceId);

    let title: string;
    if (workspace) {
      title = `Terminal ${windowId} — ${workspace.projectName} (${workspace.name})`;
    } else {
      // Fallback if workspace not found
      title = `Terminal ${windowId} — ${workspaceId}`;
    }

    const terminalWindow = this.createWindow({
      width: 1000,
      height: 600,
      title,
      webPreferences: {
        nodeIntegration: false,
        contextIsolation: true,
        // __dirname is dist/services/ but preload.js is in dist/
        preload: path.join(__dirname, "../preload.js"),
        // Disable spellcheck to match the main window; terminal content is code.
        spellcheck: false,
      },
      backgroundColor: "#1e1e1e",
    });

    const openExternalUrl = (url: string): void => {
      const externalUrl = normalizeAndValidateExternalUrl({
        url,
        localhostProxyTemplate,
      });
      if (externalUrl != null) {
        void shell.openExternal(externalUrl);
      }
    };

    // Open all external links in default browser.
    terminalWindow.webContents.setWindowOpenHandler(({ url }) => {
      openExternalUrl(url);
      return { action: "deny" };
    });

    terminalWindow.webContents.on("will-navigate", (event, url) => {
      const currentOrigin = new URL(terminalWindow.webContents.getURL()).origin;
      const targetOrigin = new URL(url).origin;
      // Prevent navigation away from app origin, open externally instead.
      if (targetOrigin !== currentOrigin) {
        event.preventDefault();
        openExternalUrl(url);
      }
    });

    // Track the window
    if (!this.windows.has(workspaceId)) {
      this.windows.set(workspaceId, new Set());
    }
    this.windows.get(workspaceId)!.add(terminalWindow);

    // Clean up when window is closed
    terminalWindow.on("closed", () => {
      const windowSet = this.windows.get(workspaceId);
      if (windowSet) {
        windowSet.delete(terminalWindow);
        if (windowSet.size === 0) {
          this.windows.delete(workspaceId);
        }
      }
      log.info(`Terminal window ${windowId} closed for workspace: ${workspaceId}`);
    });

    // Load the terminal page
    // Match main window logic: use dev server unless packaged or XUM_E2E_LOAD_DIST=1
    const forceDistLoad = resolveXumEnvironmentValue("E2E_LOAD_DIST", process.env) === "1";
    const useDevServer = !app.isPackaged && !forceDistLoad;

    // Build query params including optional sessionId for session handoff
    const queryParams: Record<string, string> = { workspaceId };
    if (sessionId) {
      queryParams.sessionId = sessionId;
    }
    if (initialTitle) {
      queryParams.title = initialTitle;
    }

    if (useDevServer) {
      // Development mode - load from Vite dev server
      const params = new URLSearchParams(queryParams);
      await terminalWindow.loadURL(`http://localhost:5173/terminal.html?${params.toString()}`);
      terminalWindow.webContents.openDevTools();
    } else {
      // Production mode (or E2E dist mode) - load from built files
      await terminalWindow.loadFile(path.join(__dirname, "../terminal.html"), {
        query: queryParams,
      });
    }

    log.info(`Terminal window ${windowId} opened for workspace: ${workspaceId}`);
  }

  /**
   * Close all terminal windows for a workspace
   */
  closeTerminalWindow(workspaceId: string): void {
    const windowSet = this.windows.get(workspaceId);
    if (windowSet) {
      for (const window of windowSet) {
        if (!window.isDestroyed()) {
          window.close();
        }
      }
      this.windows.delete(workspaceId);
    }
  }

  /**
   * Close all terminal windows for all workspaces
   */
  closeAll(): void {
    for (const [workspaceId, windowSet] of this.windows.entries()) {
      for (const window of windowSet) {
        if (!window.isDestroyed()) {
          window.close();
        }
      }
      this.windows.delete(workspaceId);
    }
  }
}

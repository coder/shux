import type { BrowserWindow, BrowserWindowConstructorOptions, Event } from "electron";
import { createHash } from "node:crypto";
import {
  REMOTE_CONNECTION_GESTURE_WORLD_ID,
  REMOTE_CONNECTION_LOAD_TIMEOUT_MS,
  REMOTE_CONNECTION_RETURN_KEY,
} from "@/common/constants/remoteConnection";
import {
  parseRemoteConnectionUrl,
  type RemoteConnectionState,
} from "@/common/types/remoteConnection";
import { raceWithAbortAndTimeout } from "@/node/utils/concurrency/withTimeout";

interface RemoteWindowEntry {
  window: BrowserWindow;
  origin: string;
  abort: AbortController;
  loaded: Promise<void>;
  popup: BrowserWindow | "opening" | null;
}

interface RemoteWindowOptions {
  createWindow(options: BrowserWindowConstructorOptions): BrowserWindow;
  onConnected(): void;
  onDisconnected(): void;
  onStateChanged(state: RemoteConnectionState): void;
  openExternal(url: string): void;
}

const REMOTE_WEB_PREFERENCES = {
  sandbox: true,
  nodeIntegration: false,
  contextIsolation: true,
  webviewTag: false,
  spellcheck: false,
};

/** Owns remote windows, never the local backend or its running tasks. */
export class RemoteConnectionManager {
  private entry: RemoteWindowEntry | null = null;
  private state: RemoteConnectionState = { status: "disconnected", origin: null };
  private disposed = false;

  constructor(private readonly options: RemoteWindowOptions) {}

  getState(): RemoteConnectionState {
    return this.state;
  }

  async connect(input: string): Promise<void> {
    if (this.disposed) throw new Error("Remote connections are shutting down.");
    const url = parseRemoteConnectionUrl(input);
    const existing = this.entry;
    if (existing) {
      if (existing.origin !== url.origin) {
        throw new Error("Disconnect the current remote server first.");
      }
      await existing.loaded;
      if (this.entry === existing) {
        if (existing.window.isMinimized()) existing.window.restore();
        existing.window.show();
        existing.window.focus();
      }
      return;
    }

    // SECURITY AUDIT: remote HTML must never receive the local preload or local session credentials.
    // A partition per origin also isolates servers that share a hostname but use different ports.
    const partition = "persist:xum-remote-" + createHash("sha256").update(url.origin).digest("hex");
    const window = this.options.createWindow({
      width: 1200,
      height: 800,
      title: "Xum — " + url.host,
      show: false,
      webPreferences: {
        ...REMOTE_WEB_PREFERENCES,
        partition,
      },
    });
    const entry: RemoteWindowEntry = {
      window,
      origin: url.origin,
      abort: new AbortController(),
      loaded: Promise.resolve(),
      popup: null,
    };
    this.entry = entry;
    this.setState({ status: "connecting", origin: url.origin });
    this.guardWindow(entry);
    // Reserve the window before loading. Duplicate requests share its completion.
    entry.loaded = this.loadWindow(entry, url.href);
    await entry.loaded;
  }

  private guardWindow(entry: RemoteWindowEntry): void {
    const contents = entry.window.webContents;
    contents.session.setPermissionCheckHandler(() => false);
    contents.session.setPermissionRequestHandler((requester, permission, callback, details) => {
      if (
        permission !== "clipboard-sanitized-write" ||
        requester !== contents ||
        !details.isMainFrame
      ) {
        callback(false);
        return;
      }
      this.allowClipboardWrite(entry, details.requestingUrl).then(callback, () => callback(false));
    });
    this.installInputHandler(entry, entry.window);
    contents.on("will-attach-webview", (event) => event.preventDefault());
    contents.on("will-prevent-unload", (event) => event.preventDefault());
    const guardNavigation = (event: Event, target: string): void => {
      try {
        if (parseRemoteConnectionUrl(target).origin === entry.origin) return;
      } catch {
        // Malformed URLs and non-HTTP schemes cannot navigate remote windows.
      }
      event.preventDefault();
    };
    contents.on("will-navigate", guardNavigation);
    contents.on("will-redirect", guardNavigation);
    contents.setWindowOpenHandler(({ url }) => {
      // Browser OAuth flows retain a blank popup handle before fetching the authorization URL.
      if (url === "about:blank" && this.entry === entry && entry.popup == null) {
        entry.popup = "opening";
        return {
          action: "allow",
          overrideBrowserWindowOptions: {
            webPreferences: { ...REMOTE_WEB_PREFERENCES, session: contents.session },
          },
        };
      }
      try {
        const target = parseRemoteConnectionUrl(url);
        this.options.openExternal(target.href);
      } catch {
        // Remote content cannot launch local programs through custom URL schemes.
      }
      return { action: "deny" };
    });
    contents.on("did-create-window", (popup) => this.guardAuthPopup(entry, popup));
    contents.on("render-process-gone", () => {
      this.finish(entry, "The remote window stopped. Connect again to retry.");
    });
    contents.on("did-fail-load", (_event, errorCode, _description, _url, isMainFrame) => {
      // Ignore cancelled navigation and subresource errors.
      if (isMainFrame && errorCode !== -3) {
        this.finish(entry, "Cannot load the remote server. Check its URL and network connection.");
      }
    });
    entry.window.on("closed", () => this.finish(entry));
  }

  private installInputHandler(entry: RemoteWindowEntry, window: BrowserWindow): void {
    window.webContents.on("before-input-event", (event, input) => {
      const modifier =
        process.platform === "darwin" ? input.meta && !input.control : input.control && !input.meta;
      if (this.entry !== entry || input.type !== "keyDown" || !modifier || input.alt) return;
      if (input.shift && input.key.toUpperCase() === REMOTE_CONNECTION_RETURN_KEY) {
        // Return remains available even when remote content handles its own shortcuts.
        event.preventDefault();
        this.disconnect();
      } else if (input.key.toLowerCase() === "v") {
        // Native paste sends clipboardData to inputs and terminals without granting background reads.
        event.preventDefault();
        window.webContents.paste();
      }
    });
  }

  private async allowClipboardWrite(
    entry: RemoteWindowEntry,
    requestingUrl: string
  ): Promise<boolean> {
    const isActiveRequest = (): boolean =>
      this.entry === entry &&
      !entry.window.isDestroyed() &&
      entry.window.isFocused() &&
      entry.window.webContents.getURL() === requestingUrl;
    if (!isActiveRequest() || parseRemoteConnectionUrl(requestingUrl).origin !== entry.origin)
      return false;
    // SECURITY AUDIT: the page can replace its own navigator properties, but not this isolated world's properties.
    const activated: unknown = await entry.window.webContents.executeJavaScriptInIsolatedWorld(
      REMOTE_CONNECTION_GESTURE_WORLD_ID,
      [{ code: "navigator.userActivation.isActive" }]
    );
    return activated === true && isActiveRequest();
  }

  private guardAuthPopup(entry: RemoteWindowEntry, popup: BrowserWindow): void {
    if (this.entry !== entry) {
      popup.destroy();
      return;
    }
    entry.popup = popup;
    this.installInputHandler(entry, popup);
    popup.on("closed", () => {
      if (entry.popup === popup) entry.popup = null;
    });
    // OAuth redirects cross origins. They retain only the remote session, never local IPC access.
    const guardNavigation = (event: Event, target: string): void => {
      if (target === "about:blank") return;
      try {
        parseRemoteConnectionUrl(target);
      } catch {
        event.preventDefault();
      }
    };
    popup.webContents.on("will-navigate", guardNavigation);
    popup.webContents.on("will-redirect", guardNavigation);
    popup.webContents.on("will-attach-webview", (event) => event.preventDefault());
    popup.webContents.on("will-prevent-unload", (event) => event.preventDefault());
    popup.webContents.setWindowOpenHandler(() => ({ action: "deny" }));
  }

  private async loadWindow(entry: RemoteWindowEntry, url: string): Promise<void> {
    let error = "Cannot load the remote server. Check its URL and network connection.";
    try {
      const result = await raceWithAbortAndTimeout(entry.window.loadURL(url), {
        signal: entry.abort.signal,
        timeoutMs: REMOTE_CONNECTION_LOAD_TIMEOUT_MS,
      });
      if (result.kind === "aborted" || this.entry !== entry) return;
      if (result.kind === "timeout") {
        error = "The remote server did not respond in time. Connect again to retry.";
        throw new Error(error);
      }
      entry.window.show();
      entry.window.focus();
      // Hide only the local window. Local agents and their renderer state remain alive.
      this.options.onConnected();
      this.setState({ status: "connected", origin: entry.origin });
    } catch {
      // Electron errors can include URL tokens. Report only a credential-free error.
      if (this.entry !== entry) return;
      this.finish(entry, error);
      throw new Error(error);
    }
  }

  private setState(state: RemoteConnectionState): void {
    this.state = state;
    this.options.onStateChanged(state);
  }

  private finish(entry: RemoteWindowEntry, error?: string): void {
    if (this.entry !== entry) return;
    this.entry = null;
    entry.abort.abort();
    const popup = entry.popup;
    if (popup && popup !== "opening" && !popup.isDestroyed()) popup.destroy();
    if (!entry.window.isDestroyed()) entry.window.destroy();
    this.setState({ status: "disconnected", origin: null, ...(error ? { error } : {}) });
    if (!this.disposed) this.options.onDisconnected();
  }

  disconnect(): void {
    if (this.entry) this.finish(this.entry);
  }

  dispose(): void {
    this.disposed = true;
    this.disconnect();
  }
}

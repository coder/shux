import type { BrowserWindow, BrowserWindowConstructorOptions, Event, Session } from "electron";
import { createHash } from "node:crypto";
import { getAppProxyBasePathFromPathname } from "@/common/appProxyBasePath";
import {
  REMOTE_CONNECTION_EDITOR_FRAME_NAME_PREFIX,
  REMOTE_CONNECTION_GESTURE_WORLD_ID,
  REMOTE_CONNECTION_LOAD_TIMEOUT_MS,
  REMOTE_CONNECTION_RETURN_KEY,
} from "@/common/constants/remoteConnection";
import {
  parseRemoteConnectionUrl,
  getRemoteConnectionServerUrl,
  type RemoteConnectionState,
} from "@/common/types/remoteConnection";
import { raceWithAbortAndTimeout } from "@/node/utils/concurrency/withTimeout";

type RemotePopupKind = "app" | "attachment" | "auth";

interface RemoteWindowEntry {
  window: BrowserWindow;
  session: Session;
  serverUrl: string;
  abort: AbortController;
  loaded: Promise<void>;
  authPopup: BrowserWindow | "opening" | null;
  popups: Map<BrowserWindow, RemotePopupKind>;
  microphoneRequests: Set<BrowserWindow>;
}

interface RemoteWindowOptions {
  createWindow(options: BrowserWindowConstructorOptions): BrowserWindow;
  onConnected(): void;
  onDisconnected(): void;
  onStateChanged(state: RemoteConnectionState): void;
  openExternal(url: string): void;
  requestMicrophoneAccess(
    window: BrowserWindow,
    serverUrl: string,
    signal: AbortSignal
  ): Promise<boolean>;
}

const REMOTE_WEB_PREFERENCES = {
  sandbox: true,
  nodeIntegration: false,
  contextIsolation: true,
  webviewTag: false,
  spellcheck: false,
};

function isRemoteNavigationAllowed(serverUrl: string, target: string): boolean {
  const server = parseRemoteConnectionUrl(serverUrl);
  const destination = parseRemoteConnectionUrl(target);
  if (server.origin !== destination.origin) return false;
  const serverAppPath = getAppProxyBasePathFromPathname(server.pathname);
  const targetAppPath = getAppProxyBasePathFromPathname(destination.pathname);
  // Coder login redirects can leave the app path, but must not enter another proxied app.
  return serverAppPath == null || targetAppPath == null || serverAppPath === targetAppPath;
}

function isRemoteAppUrl(serverUrl: string, target: string): boolean {
  const server = parseRemoteConnectionUrl(serverUrl);
  const destination = parseRemoteConnectionUrl(target);
  if (server.origin !== destination.origin) return false;
  if (
    getAppProxyBasePathFromPathname(server.pathname) !==
    getAppProxyBasePathFromPathname(destination.pathname)
  )
    return false;
  const basePath = server.pathname.replace(/[/]$/, "");
  return destination.pathname === basePath || destination.pathname.startsWith(basePath + "/");
}

function isRemoteBlobUrl(serverUrl: string, target: string): boolean {
  const destination = new URL(target);
  return destination.protocol === "blob:" && destination.origin === new URL(serverUrl).origin;
}

/** Owns remote windows, never the local backend or its running tasks. */
export class RemoteConnectionManager {
  private entry: RemoteWindowEntry | null = null;
  private state: RemoteConnectionState = { status: "disconnected", serverUrl: null };
  private disposed = false;

  constructor(private readonly options: RemoteWindowOptions) {}

  getState(): RemoteConnectionState {
    return this.state;
  }

  async connect(input: string): Promise<void> {
    if (this.disposed) throw new Error("Remote connections are shutting down.");
    const url = parseRemoteConnectionUrl(input);
    const serverUrl = getRemoteConnectionServerUrl(input);
    const existing = this.entry;
    if (existing) {
      if (existing.serverUrl !== serverUrl) {
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
    // App-proxy paths need separate storage because browser localStorage only isolates by origin.
    const partition = "persist:xum-remote-" + createHash("sha256").update(serverUrl).digest("hex");
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
      session: window.webContents.session,
      serverUrl,
      abort: new AbortController(),
      loaded: Promise.resolve(),
      authPopup: null,
      popups: new Map(),
      microphoneRequests: new Set(),
    };
    this.entry = entry;
    this.setState({ status: "connecting", serverUrl });
    this.guardWindow(entry);
    // Reserve the window before loading. Duplicate requests share its completion.
    entry.loaded = this.loadWindow(entry, url.href);
    await entry.loaded;
  }

  private guardWindow(entry: RemoteWindowEntry): void {
    const contents = entry.window.webContents;
    // Do not cache grants. Each capture request needs consent, including requests after a denial.
    contents.session.setPermissionCheckHandler(() => false);
    contents.session.setPermissionRequestHandler((requester, permission, callback, details) => {
      const window =
        requester === contents
          ? entry.window
          : [...entry.popups].find(
              ([popup, kind]) => kind === "app" && popup.webContents === requester
            )?.[0];
      if (!window || !details.isMainFrame) {
        callback(false);
        return;
      }
      if (permission === "clipboard-sanitized-write") {
        this.allowClipboardWrite(entry, window, details.requestingUrl).then(callback, () =>
          callback(false)
        );
      } else if (
        permission === "media" &&
        "mediaTypes" in details &&
        details.mediaTypes?.length === 1 &&
        details.mediaTypes[0] === "audio"
      ) {
        this.allowMicrophoneAccess(
          entry,
          window,
          details.requestingUrl,
          details.securityOrigin
        ).then(callback, () => callback(false));
      } else {
        callback(false);
      }
    });
    this.guardAppWindow(entry, entry.window);
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

  private guardAppWindow(entry: RemoteWindowEntry, window: BrowserWindow): void {
    this.guardChildWindow(entry, window);
    const contents = window.webContents;
    const guardNavigation = (event: Event, target: string): void => {
      try {
        if (isRemoteNavigationAllowed(entry.serverUrl, target)) return;
      } catch {
        // Malformed URLs and non-HTTP schemes cannot navigate app windows.
      }
      event.preventDefault();
    };
    contents.on("will-navigate", guardNavigation);
    contents.on("will-redirect", guardNavigation);
    contents.setWindowOpenHandler(({ url, frameName }) => {
      // Reject editor launches before the browser renderer records a durable editor-open marker.
      if (
        this.entry !== entry ||
        frameName.startsWith(REMOTE_CONNECTION_EDITOR_FRAME_NAME_PREFIX)
      ) {
        return { action: "deny" };
      }
      const kind = this.getPopupKind(entry, window, url);
      if (kind && (kind !== "auth" || entry.authPopup == null)) {
        // Browser OAuth flows reserve a blank popup before fetching the authorization URL.
        if (kind === "auth") entry.authPopup = "opening";
        return {
          action: "allow",
          overrideBrowserWindowOptions: {
            webPreferences: { ...REMOTE_WEB_PREFERENCES, session: contents.session },
          },
        };
      }
      try {
        this.options.openExternal(parseRemoteConnectionUrl(url).href);
      } catch {
        // Remote content cannot launch local programs through custom URL schemes.
      }
      return { action: "deny" };
    });
    contents.on("did-create-window", (popup, details) => {
      this.registerPopup(entry, window, popup, details.url);
    });
  }

  private getPopupKind(
    entry: RemoteWindowEntry,
    source: BrowserWindow,
    url: string
  ): RemotePopupKind | null {
    try {
      // Login pages share the origin, but cannot create app or attachment windows.
      if (!isRemoteAppUrl(entry.serverUrl, source.webContents.getURL())) return null;
      if (url === "about:blank") return "auth";
      if (isRemoteBlobUrl(entry.serverUrl, url)) return "attachment";
      if (isRemoteAppUrl(entry.serverUrl, url)) return "app";
    } catch {
      // Reject malformed URLs and unsupported schemes.
    }
    return null;
  }

  private guardChildWindow(entry: RemoteWindowEntry, window: BrowserWindow): void {
    this.installInputHandler(entry, window);
    window.webContents.on("will-attach-webview", (event) => event.preventDefault());
    window.webContents.on("will-prevent-unload", (event) => event.preventDefault());
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
    window: BrowserWindow,
    requestingUrl: string
  ): Promise<boolean> {
    const isActiveRequest = (): boolean =>
      this.entry === entry &&
      (window === entry.window || entry.popups.get(window) === "app") &&
      !window.isDestroyed() &&
      window.isFocused() &&
      window.webContents.getURL() === requestingUrl;
    if (!isActiveRequest() || !isRemoteAppUrl(entry.serverUrl, requestingUrl)) return false;
    // SECURITY AUDIT: the page can replace its own navigator properties, but not this isolated world's properties.
    const activated: unknown = await window.webContents.executeJavaScriptInIsolatedWorld(
      REMOTE_CONNECTION_GESTURE_WORLD_ID,
      [{ code: "navigator.userActivation.isActive" }]
    );
    return activated === true && isActiveRequest();
  }

  private async allowMicrophoneAccess(
    entry: RemoteWindowEntry,
    window: BrowserWindow,
    requestingUrl: string,
    securityOrigin: string | undefined
  ): Promise<boolean> {
    const contents = window.webContents;
    const isCurrentRequest = (): boolean =>
      this.entry === entry &&
      this.state.status === "connected" &&
      (window === entry.window || entry.popups.get(window) === "app") &&
      !window.isDestroyed() &&
      !contents.isDestroyed() &&
      contents.getURL() === requestingUrl;
    if (
      !isCurrentRequest() ||
      !window.isFocused() ||
      entry.microphoneRequests.has(window) ||
      !isRemoteAppUrl(entry.serverUrl, requestingUrl) ||
      securityOrigin == null ||
      new URL(securityOrigin).origin !== new URL(entry.serverUrl).origin
    ) {
      return false;
    }

    // A URL can survive a reload. Cancel consent when the requesting document leaves instead.
    const abort = new AbortController();
    const cancel = (): void => abort.abort();
    const onNavigation = (event: { isMainFrame: boolean }): void => {
      if (event.isMainFrame) cancel();
    };
    const signal = AbortSignal.any([entry.abort.signal, abort.signal]);
    entry.microphoneRequests.add(window);
    contents.on("did-start-navigation", onNavigation);
    // A request can arrive after navigation starts but before the new document commits.
    contents.on("did-navigate", cancel);
    contents.on("render-process-gone", cancel);
    window.on("closed", cancel);
    try {
      // Chromium still enforces secure contexts. This grants only the remote page's audio request.
      const result = await raceWithAbortAndTimeout(
        this.options.requestMicrophoneAccess(window, entry.serverUrl, signal),
        { signal }
      );
      return result.kind === "ok" && result.value && !signal.aborted && isCurrentRequest();
    } finally {
      contents.removeListener("did-start-navigation", onNavigation);
      contents.removeListener("did-navigate", cancel);
      contents.removeListener("render-process-gone", cancel);
      window.removeListener("closed", cancel);
      entry.microphoneRequests.delete(window);
    }
  }

  private registerPopup(
    entry: RemoteWindowEntry,
    source: BrowserWindow,
    popup: BrowserWindow,
    url: string
  ): void {
    const kind = this.getPopupKind(entry, source, url);
    if (this.entry !== entry || !kind) {
      popup.destroy();
      return;
    }
    entry.popups.set(popup, kind);
    if (kind === "auth") entry.authPopup = popup;
    popup.on("closed", () => {
      entry.popups.delete(popup);
      if (entry.authPopup === popup) entry.authPopup = null;
    });
    if (kind === "app") {
      this.guardAppWindow(entry, popup);
      return;
    }
    this.guardChildWindow(entry, popup);
    const guardNavigation = (event: Event, target: string): void => {
      try {
        if (kind === "auth") {
          // OAuth redirects cross origins but retain only the isolated remote session.
          if (target === "about:blank") return;
          const destination = parseRemoteConnectionUrl(target);
          if (
            destination.origin !== new URL(entry.serverUrl).origin ||
            isRemoteNavigationAllowed(entry.serverUrl, target)
          )
            return;
        }
        if (isRemoteBlobUrl(entry.serverUrl, target)) return;
      } catch {
        // Attachments cannot navigate to websites or launch local programs.
      }
      event.preventDefault();
    };
    popup.webContents.on("will-navigate", guardNavigation);
    popup.webContents.on("will-redirect", guardNavigation);
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
      this.setState({ status: "connected", serverUrl: entry.serverUrl });
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
    // Persistent sessions must stay closed after disconnect, without retaining the old entry.
    entry.session.setPermissionCheckHandler(() => false);
    entry.session.setPermissionRequestHandler((_requester, _permission, callback) =>
      callback(false)
    );
    for (const popup of entry.popups.keys()) {
      if (!popup.isDestroyed()) popup.destroy();
    }
    if (!entry.window.isDestroyed()) entry.window.destroy();
    this.setState({ status: "disconnected", serverUrl: null, ...(error ? { error } : {}) });
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

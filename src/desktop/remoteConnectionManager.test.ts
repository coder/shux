import { afterEach, describe, expect, mock, test } from "bun:test";
import type { BrowserWindow, BrowserWindowConstructorOptions } from "electron";
import { EventEmitter } from "node:events";
import type { RemoteConnectionState } from "@/common/types/remoteConnection";
import { RemoteConnectionManager } from "./remoteConnectionManager";

class TestWindow extends EventEmitter {
  destroyed = false;
  minimized = false;
  focused = true;
  url = "";
  loading = Promise.resolve();
  webContents = Object.assign(new EventEmitter(), {
    getURL: () => this.url,
    paste: mock(() => undefined),
    executeJavaScriptInIsolatedWorld: mock<
      (worldId: number, scripts: Array<{ code: string }>) => Promise<unknown>
    >(() => Promise.resolve(true)),
    session: {
      setPermissionRequestHandler:
        mock<
          (
            handler: (
              contents: unknown,
              permission: string,
              callback: (allow: boolean) => void,
              details: { isMainFrame: boolean; requestingUrl: string }
            ) => void
          ) => void
        >(),
      setPermissionCheckHandler: mock<(handler: () => boolean) => void>(),
    },
    setWindowOpenHandler: mock<
      (
        handler: (details: { url: string }) => {
          action: string;
          overrideBrowserWindowOptions?: BrowserWindowConstructorOptions;
        }
      ) => void
    >(),
  });
  isDestroyed = () => this.destroyed;
  isMinimized = () => this.minimized;
  isFocused = () => this.focused;
  restore = mock(() => {
    this.minimized = false;
  });
  show = mock(() => undefined);
  focus = mock(() => undefined);
  loadURL = mock((url: string) => {
    this.url = url;
    return this.loading;
  });
  destroy = mock(() => {
    this.destroyed = true;
    this.emit("closed");
  });
  close = () => {
    this.destroyed = true;
    this.emit("closed");
  };
}

const managers: RemoteConnectionManager[] = [];
afterEach(() => {
  for (const manager of managers.splice(0)) manager.dispose();
});

function setup(loading = Promise.resolve()) {
  const windows: TestWindow[] = [];
  const options: BrowserWindowConstructorOptions[] = [];
  const onConnected = mock(() => undefined);
  const onDisconnected = mock(() => undefined);
  const onStateChanged = mock<(state: RemoteConnectionState) => void>();
  const openExternal = mock<(url: string) => void>();
  const manager = new RemoteConnectionManager({
    createWindow: (windowOptions) => {
      const window = new TestWindow();
      window.loading = loading;
      windows.push(window);
      options.push(windowOptions);
      // Electron is the host boundary. Keep this fake local to avoid global module mocks.
      return window as unknown as BrowserWindow;
    },
    onConnected,
    onDisconnected,
    onStateChanged,
    openExternal,
  });
  managers.push(manager);
  return {
    manager,
    windows,
    options,
    onConnected,
    onDisconnected,
    onStateChanged,
    openExternal,
    setLoading: (promise: Promise<void>) => {
      loading = promise;
    },
  };
}

function deferred() {
  let resolve!: () => void;
  let reject!: (error: Error) => void;
  const promise = new Promise<void>((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
}

describe("RemoteConnectionManager", () => {
  test("keeps the local window until load completes and shares duplicate connections", async () => {
    const load = deferred();
    const { manager, windows, onConnected, onStateChanged } = setup(load.promise);
    const first = manager.connect("https://example.com/?token=first");
    const duplicate = manager.connect("https://example.com/?token=second");
    expect(windows).toHaveLength(1);
    expect(windows[0].loadURL).toHaveBeenCalledTimes(1);
    expect(windows[0].show).not.toHaveBeenCalled();
    expect(onConnected).not.toHaveBeenCalled();
    expect(manager.getState()).toEqual({ status: "connecting", serverUrl: "https://example.com" });
    load.resolve();
    await Promise.all([first, duplicate]);
    expect(onConnected).toHaveBeenCalledTimes(1);
    expect(windows[0].show).toHaveBeenCalled();
    expect(windows[0].focus).toHaveBeenCalled();
    expect(onStateChanged.mock.calls.map(([state]) => state.status)).toEqual([
      "connecting",
      "connected",
    ]);
    windows[0].minimized = true;
    await manager.connect("https://example.com/");
    expect(windows[0].restore).toHaveBeenCalledTimes(1);
    expect(windows[0].minimized).toBe(false);
    expect(windows).toHaveLength(1);
    expect(onConnected).toHaveBeenCalledTimes(1);
  });

  test.each([false, true])(
    "rejects another origin without replacing the current window (loaded=%s)",
    async (loaded) => {
      const load = deferred();
      const { manager, windows } = setup(load.promise);
      const pending = manager.connect("https://example.com/");
      if (loaded) {
        load.resolve();
        await pending;
      }
      expect(manager.connect("https://other.example.com/")).rejects.toThrow();
      expect(windows).toHaveLength(1);
      expect(windows[0].destroyed).toBe(false);
      expect(manager.getState().serverUrl).toBe("https://example.com");
      load.resolve();
      await pending;
    }
  );

  test.each(["resolve", "reject"] as const)(
    "disconnects pending duplicates before load settles: %s",
    async (completion) => {
      const load = deferred();
      const { manager, windows, onConnected, onDisconnected } = setup(load.promise);
      const first = manager.connect("https://example.com/");
      const duplicate = manager.connect("https://example.com/");
      manager.disconnect();
      await Promise.all([first, duplicate]);
      expect(manager.getState()).toEqual({ status: "disconnected", serverUrl: null });
      expect(onDisconnected).toHaveBeenCalledTimes(1);
      expect(windows[0].destroyed).toBe(true);
      if (completion === "resolve") load.resolve();
      else load.reject(new Error("late failure"));
      await load.promise.catch(() => undefined);
      expect(onConnected).not.toHaveBeenCalled();
      expect(windows[0].show).not.toHaveBeenCalled();
      manager.disconnect();
      expect(onDisconnected).toHaveBeenCalledTimes(1);
    }
  );

  test.each(["resolve", "reject"] as const)(
    "ignores old load completion and events after a new connection: %s",
    async (completion) => {
      const oldLoad = deferred();
      const newLoad = deferred();
      const { manager, windows, onConnected, onDisconnected, setLoading } = setup(oldLoad.promise);
      const oldConnection = manager.connect("https://old.example.com/");
      manager.disconnect();
      await oldConnection;
      setLoading(newLoad.promise);
      const newConnection = manager.connect("https://new.example.com/");
      newLoad.resolve();
      await newConnection;
      if (completion === "resolve") oldLoad.resolve();
      else oldLoad.reject(new Error("old failure"));
      await oldLoad.promise.catch(() => undefined);
      windows[0].emit("closed");
      windows[0].webContents.emit("render-process-gone");
      windows[0].webContents.emit(
        "did-fail-load",
        {},
        -105,
        "failure",
        "https://old.example.com/",
        true
      );
      expect(manager.getState()).toEqual({
        status: "connected",
        serverUrl: "https://new.example.com",
      });
      expect(onConnected).toHaveBeenCalledTimes(1);
      expect(onDisconnected).toHaveBeenCalledTimes(1);
      expect(windows[1].destroyed).toBe(false);
      expect(windows[0].show).not.toHaveBeenCalled();
    }
  );

  test.each(["closed", "crash", "failure"])(
    "restores the local window once after %s",
    async (event) => {
      const { manager, windows, onDisconnected } = setup();
      await manager.connect("https://example.com/");
      const window = windows[0];
      if (event === "closed") window.close();
      else if (event === "crash") window.webContents.emit("render-process-gone");
      else
        window.webContents.emit("did-fail-load", {}, -105, "failure", "https://example.com/", true);
      expect(manager.getState().status).toBe("disconnected");
      expect(window.destroyed).toBe(true);
      expect(onDisconnected).toHaveBeenCalledTimes(1);
      window.webContents.emit("render-process-gone");
      window.emit("closed");
      manager.disconnect();
      expect(onDisconnected).toHaveBeenCalledTimes(1);
    }
  );

  test.each(["closed", "crash", "failure"])(
    "restores local state when a pending window stops: %s",
    async (event) => {
      const load = deferred();
      const { manager, windows, onConnected, onDisconnected } = setup(load.promise);
      const pending = manager.connect("https://example.com/?token=private-token");
      const window = windows[0];
      if (event === "closed") window.close();
      else if (event === "crash") window.webContents.emit("render-process-gone");
      else
        window.webContents.emit(
          "did-fail-load",
          {},
          -105,
          "private-token",
          "https://example.com/?token=private-token",
          true
        );
      await pending;
      expect(manager.getState().status).toBe("disconnected");
      expect(JSON.stringify(manager.getState())).not.toContain("private-token");
      expect(onDisconnected).toHaveBeenCalledTimes(1);
      expect(window.destroyed).toBe(true);
      load.resolve();
      await load.promise;
      expect(onConnected).not.toHaveBeenCalled();
      expect(window.show).not.toHaveBeenCalled();
    }
  );

  test("ignores cancelled navigation and subframe failures", async () => {
    const { manager, windows, onDisconnected } = setup();
    await manager.connect("https://example.com/");
    windows[0].webContents.emit("did-fail-load", {}, -3, "aborted", "https://example.com/", true);
    windows[0].webContents.emit(
      "did-fail-load",
      {},
      -105,
      "subframe",
      "https://example.com/",
      false
    );
    expect(manager.getState().status).toBe("connected");
    expect(windows[0].destroyed).toBe(false);
    expect(onDisconnected).not.toHaveBeenCalled();
  });

  test("sanitizes rejected load errors and restores the local window", async () => {
    const load = deferred();
    const token = "secret-load-token";
    const url = "https://example.com/?token=" + token;
    const { manager, windows, options, onConnected, onDisconnected, onStateChanged } = setup(
      load.promise
    );
    const pending = manager.connect(url);
    load.reject(new Error("Cannot load " + url));
    expect(pending).rejects.toThrow();
    expect(windows[0].loadURL).toHaveBeenCalledWith(url);
    expect(windows[0].destroyed).toBe(true);
    expect(onConnected).not.toHaveBeenCalled();
    expect(onDisconnected).toHaveBeenCalledTimes(1);
    expect(manager.getState().error).toBeTruthy();
    expect(JSON.stringify(onStateChanged.mock.calls)).not.toContain(token);
    expect(JSON.stringify(options)).not.toContain(token);
    await pending.catch((error: unknown) => {
      expect(String(error)).not.toContain(token);
    });
  });

  test.each([false, true])("dispose suppresses local restoration (loaded=%s)", async (loaded) => {
    const load = deferred();
    const { manager, windows, onConnected, onDisconnected } = setup(load.promise);
    const pending = manager.connect("https://example.com/");
    if (loaded) {
      load.resolve();
      await pending;
    }
    manager.dispose();
    await pending;
    load.resolve();
    await load.promise;
    expect(windows[0].destroyed).toBe(true);
    expect(onDisconnected).not.toHaveBeenCalled();
    expect(onConnected).toHaveBeenCalledTimes(loaded ? 1 : 0);
    expect(manager.connect("https://example.com/")).rejects.toThrow();
    expect(windows).toHaveLength(1);
  });

  test("keeps path-mounted server identities and sessions separate on one origin", async () => {
    const load = deferred();
    const { manager, windows, options, onStateChanged } = setup(load.promise);
    const address = "https://example.com/mounted/first/?token=private-token#private-session";
    const first = manager.connect(address);
    const duplicate = manager.connect("https://EXAMPLE.com:443/mounted/first?token=other-token");
    expect(windows).toHaveLength(1);
    expect(windows[0].loadURL).toHaveBeenCalledWith(address);
    expect(manager.getState()).toEqual({
      status: "connecting",
      serverUrl: "https://example.com/mounted/first",
    });
    const otherServer = manager.connect("https://example.com/mounted/second").then(
      () => undefined,
      (error: unknown) => error
    );
    expect(windows).toHaveLength(1);
    load.resolve();
    await Promise.all([first, duplicate]);
    expect(await otherServer).toBeInstanceOf(Error);
    expect(manager.getState()).toEqual({
      status: "connected",
      serverUrl: "https://example.com/mounted/first",
    });
    manager.disconnect();
    await manager.connect("https://example.com/mounted/first");
    expect(options[1].webPreferences?.partition).toBe(options[0].webPreferences?.partition);
    manager.disconnect();
    await manager.connect("https://example.com/mounted/second");
    expect(options[2].webPreferences?.partition).not.toBe(options[0].webPreferences?.partition);
    expect(manager.getState().serverUrl).toBe("https://example.com/mounted/second");
    for (const secret of ["private-token", "private-session", "other-token"]) {
      expect(JSON.stringify(options)).not.toContain(secret);
      expect(JSON.stringify(onStateChanged.mock.calls)).not.toContain(secret);
    }
  });

  test.each(["will-navigate", "will-redirect"])(
    "allows Coder login and return but blocks sibling app %s",
    async (event) => {
      const { manager, windows } = setup();
      await manager.connect(
        "https://example.com/@alice/workspace/apps/xum/workspaces/one?token=private-token"
      );
      const contents = windows[0].webContents;
      for (const url of [
        "https://example.com/login?redirect=%2F%40alice%2Fworkspace%2Fapps%2Fxum",
        "https://example.com/",
        "https://example.com/@alice/workspace/apps/xum",
        "https://example.com/@alice/workspace/apps/xum/workspaces/two?token=next#message",
      ]) {
        const preventDefault = mock(() => undefined);
        contents.emit(event, { preventDefault }, url);
        expect(preventDefault).not.toHaveBeenCalled();
      }
      for (const url of [
        "https://example.com/@alice/workspace/apps/other",
        "https://example.com/@alice/workspace/apps/xum-sibling",
        "https://example.com/@alice/other/apps/xum/",
        "https://example.com/@bob/workspace/apps/xum/",
        "https://other.example.com/@alice/workspace/apps/xum/",
        "https://user:password@example.com/@alice/workspace/apps/xum/",
      ]) {
        const preventDefault = mock(() => undefined);
        contents.emit(event, { preventDefault }, url);
        expect(preventDefault).toHaveBeenCalledTimes(1);
      }
    }
  );

  test.each(["https://example.com/", "https://example.com/mounted/xum"])(
    "retains same-origin navigation outside Coder mounts: %s",
    async (serverUrl) => {
      const { manager, windows } = setup();
      await manager.connect(serverUrl);
      for (const event of ["will-navigate", "will-redirect"]) {
        for (const url of [
          "https://example.com/login",
          "https://example.com/mounted/other",
          "https://example.com/@alice/workspace/apps/other",
        ]) {
          const preventDefault = mock(() => undefined);
          windows[0].webContents.emit(event, { preventDefault }, url);
          expect(preventDefault).not.toHaveBeenCalled();
        }
        const preventDefault = mock(() => undefined);
        windows[0].webContents.emit(event, { preventDefault }, "https://other.example.com/login");
        expect(preventDefault).toHaveBeenCalledTimes(1);
      }
    }
  );

  test("isolates origin sessions without a preload or URL tokens", async () => {
    const { manager, options, onStateChanged, windows } = setup();
    const urls = [
      "https://example.com/path?token=private-token#private-session",
      "https://EXAMPLE.com:443/path/?token=other-token",
      "http://example.com/",
      "https://example.com:8443/",
      "https://other.example.com/",
    ];
    for (const url of urls) {
      await manager.connect(url);
      manager.disconnect();
    }
    const partitions = options.map((option) => option.webPreferences?.partition);
    expect(partitions[0]).toBe(partitions[1]);
    expect(new Set(partitions).size).toBe(4);
    for (const option of options) {
      expect(option.show).toBe(false);
      expect(option.webPreferences).toMatchObject({
        sandbox: true,
        nodeIntegration: false,
        contextIsolation: true,
        webviewTag: false,
      });
      expect(option.webPreferences?.preload).toBeUndefined();
      expect(option.webPreferences?.partition).toBeTruthy();
    }
    expect(windows[0].loadURL).toHaveBeenCalledWith(urls[0]);
    for (const secret of ["private-token", "private-session", "other-token"]) {
      expect(JSON.stringify(options)).not.toContain(secret);
      expect(JSON.stringify(onStateChanged.mock.calls)).not.toContain(secret);
    }
  });

  test.each(["file:///etc/passwd", "https://user:password@example.com/", "not a URL"])(
    "rejects invalid input before creating a window: %s",
    (url) => {
      const { manager, windows, onConnected, onStateChanged } = setup();
      expect(manager.connect(url)).rejects.toThrow();
      expect(windows).toHaveLength(0);
      expect(manager.getState()).toEqual({ status: "disconnected", serverUrl: null });
      expect(onConnected).not.toHaveBeenCalled();
      expect(onStateChanged).not.toHaveBeenCalled();
    }
  );

  test.each(["will-navigate", "will-redirect"])(
    "restricts %s to credential-free URLs on the server origin",
    async (event) => {
      const { manager, windows } = setup();
      await manager.connect("https://example.com/");
      for (const url of [
        "https://example.com/path?token=next",
        "https://EXAMPLE.com:443/other#hash",
      ]) {
        const preventDefault = mock(() => undefined);
        windows[0].webContents.emit(event, { preventDefault }, url);
        expect(preventDefault).not.toHaveBeenCalled();
      }
      for (const url of [
        "https://other.example.com/",
        "https://example.com:8443/",
        "http://example.com/",
        "file:///etc/passwd",
        "javascript:alert(1)",
        "data:text/html,hello",
        "about:blank",
        "xum://open",
        "https://user:password@example.com/",
        "invalid",
      ]) {
        const preventDefault = mock(() => undefined);
        windows[0].webContents.emit(event, { preventDefault }, url);
        expect(preventDefault).toHaveBeenCalledTimes(1);
      }
    }
  );

  test("blocks webviews and lets the host close pages with unload handlers", async () => {
    const { manager, windows } = setup();
    await manager.connect("https://example.com/");
    for (const event of ["will-attach-webview", "will-prevent-unload"]) {
      const preventDefault = mock(() => undefined);
      windows[0].webContents.emit(event, { preventDefault });
      expect(preventDefault).toHaveBeenCalledTimes(1);
    }
  });

  test("allows one blank auth popup with the remote session and no preload", async () => {
    const { manager, windows, onDisconnected, openExternal } = setup();
    await manager.connect("https://example.com/");
    const contents = windows[0].webContents;
    const openWindow = contents.setWindowOpenHandler.mock.calls[0][0];
    const first = openWindow({ url: "about:blank" });
    expect(first.action).toBe("allow");
    expect(first.overrideBrowserWindowOptions?.webPreferences).toMatchObject({
      sandbox: true,
      nodeIntegration: false,
      contextIsolation: true,
      webviewTag: false,
    });
    expect(first.overrideBrowserWindowOptions?.webPreferences?.preload).toBeUndefined();
    expect(
      Object.is(first.overrideBrowserWindowOptions?.webPreferences?.session, contents.session)
    ).toBe(true);
    expect(openWindow({ url: "about:blank" })).toEqual({ action: "deny" });
    const popup = new TestWindow();
    contents.emit("did-create-window", popup);
    expect(openWindow({ url: "about:blank" })).toEqual({ action: "deny" });
    popup.close();
    expect(manager.getState().status).toBe("connected");
    expect(onDisconnected).not.toHaveBeenCalled();
    expect(openExternal).not.toHaveBeenCalled();
    expect(openWindow({ url: "about:blank" }).action).toBe("allow");
  });

  test("allows HTTP auth redirects but blocks privileged navigation and nested popups", async () => {
    const { manager, windows, openExternal } = setup();
    await manager.connect("https://example.com/");
    const contents = windows[0].webContents;
    contents.setWindowOpenHandler.mock.calls[0][0]({ url: "about:blank" });
    const popup = new TestWindow();
    contents.emit("did-create-window", popup);
    for (const event of ["will-navigate", "will-redirect"]) {
      for (const url of [
        "about:blank",
        "https://auth.example.com/login",
        "http://localhost:8080/callback",
        "https://example.com/callback",
      ]) {
        const preventDefault = mock(() => undefined);
        popup.webContents.emit(event, { preventDefault }, url);
        expect(preventDefault).not.toHaveBeenCalled();
      }
      for (const url of [
        "file:///etc/passwd",
        "javascript:alert(1)",
        "data:text/html,hello",
        "xum://open",
        "https://user:password@example.com/",
        "invalid",
      ]) {
        const preventDefault = mock(() => undefined);
        popup.webContents.emit(event, { preventDefault }, url);
        expect(preventDefault).toHaveBeenCalledTimes(1);
      }
    }
    for (const event of ["will-attach-webview", "will-prevent-unload"]) {
      const preventDefault = mock(() => undefined);
      popup.webContents.emit(event, { preventDefault });
      expect(preventDefault).toHaveBeenCalledTimes(1);
    }
    const openNested = popup.webContents.setWindowOpenHandler.mock.calls[0][0];
    for (const url of ["about:blank", "https://example.com/", "xum://open"]) {
      expect(openNested({ url })).toEqual({ action: "deny" });
    }
    expect(openExternal).not.toHaveBeenCalled();
  });

  test.each(["disconnect", "dispose"] as const)(
    "destroys an auth popup during %s",
    async (action) => {
      const { manager, windows, onDisconnected } = setup();
      await manager.connect("https://example.com/");
      const contents = windows[0].webContents;
      contents.setWindowOpenHandler.mock.calls[0][0]({ url: "about:blank" });
      const popup = new TestWindow();
      contents.emit("did-create-window", popup);
      manager[action]();
      expect(popup.destroyed).toBe(true);
      expect(windows[0].destroyed).toBe(true);
      expect(onDisconnected).toHaveBeenCalledTimes(action === "disconnect" ? 1 : 0);
    }
  );

  test("destroys a late auth popup without changing a new connection", async () => {
    const { manager, windows, onDisconnected } = setup();
    await manager.connect("https://old.example.com/");
    const oldContents = windows[0].webContents;
    oldContents.setWindowOpenHandler.mock.calls[0][0]({ url: "about:blank" });
    manager.disconnect();
    await manager.connect("https://new.example.com/");
    const popup = new TestWindow();
    oldContents.emit("did-create-window", popup);
    expect(popup.destroyed).toBe(true);
    expect(windows[1].destroyed).toBe(false);
    expect(manager.getState()).toEqual({
      status: "connected",
      serverUrl: "https://new.example.com",
    });
    expect(onDisconnected).toHaveBeenCalledTimes(1);
  });

  test.each([
    "allowed",
    "no gesture",
    "truthy gesture",
    "unfocused",
    "wrong requester",
    "subframe",
    "wrong origin",
    "wrong URL",
    "failed check",
  ])("gates clipboard writes on an active main-frame request: %s", async (scenario) => {
    const { manager, windows } = setup();
    await manager.connect("https://example.com/");
    const window = windows[0];
    const contents = window.webContents;
    const details = { isMainFrame: true, requestingUrl: window.url };
    let requester = contents;
    if (scenario === "no gesture")
      contents.executeJavaScriptInIsolatedWorld.mockResolvedValueOnce(false);
    if (scenario === "truthy gesture")
      contents.executeJavaScriptInIsolatedWorld.mockResolvedValueOnce("true");
    if (scenario === "unfocused") window.focused = false;
    if (scenario === "wrong requester") requester = new TestWindow().webContents;
    if (scenario === "subframe") details.isMainFrame = false;
    if (scenario === "wrong URL") details.requestingUrl += "other";
    if (scenario === "wrong origin") {
      window.url = "https://other.example.com/";
      details.requestingUrl = window.url;
    }
    if (scenario === "failed check")
      contents.executeJavaScriptInIsolatedWorld.mockRejectedValueOnce(
        new Error("renderer stopped")
      );
    const request = contents.session.setPermissionRequestHandler.mock.calls[0][0];
    const allowed = await new Promise<boolean>((resolve) => {
      request(requester, "clipboard-sanitized-write", resolve, details);
    });
    expect(allowed).toBe(scenario === "allowed");
    if (scenario === "allowed") {
      // An isolated world prevents page scripts from replacing the activation getter.
      expect(contents.executeJavaScriptInIsolatedWorld.mock.calls[0][0]).toBeGreaterThan(0);
    }
  });

  test.each(["disconnect", "unfocus", "navigate", "destroy"])(
    "denies clipboard writes after pending activation changes: %s",
    async (action) => {
      const { manager, windows } = setup();
      await manager.connect("https://example.com/");
      const window = windows[0];
      const contents = window.webContents;
      const activation = deferred();
      contents.executeJavaScriptInIsolatedWorld.mockImplementation(async () => {
        await activation.promise;
        return true;
      });
      const request = contents.session.setPermissionRequestHandler.mock.calls[0][0];
      const allowed = new Promise<boolean>((resolve) => {
        request(contents, "clipboard-sanitized-write", resolve, {
          isMainFrame: true,
          requestingUrl: window.url,
        });
      });
      if (action === "disconnect") manager.disconnect();
      if (action === "unfocus") window.focused = false;
      if (action === "navigate") window.url += "new";
      if (action === "destroy") window.destroy();
      activation.resolve();
      expect(await allowed).toBe(false);
    }
  );

  test("uses native paste for the platform shortcut without granting clipboard reads", async () => {
    const { manager, windows } = setup();
    await manager.connect("https://example.com/");
    const contents = windows[0].webContents;
    const modifier =
      process.platform === "darwin"
        ? { meta: true, control: false }
        : { control: true, meta: false };
    for (const key of ["v", "V"]) {
      const preventDefault = mock(() => undefined);
      contents.emit(
        "before-input-event",
        { preventDefault },
        { type: "keyDown", key, alt: false, ...modifier }
      );
      expect(preventDefault).toHaveBeenCalledTimes(1);
    }
    expect(contents.paste).toHaveBeenCalledTimes(2);
    for (const change of [
      { type: "keyUp" },
      { key: "c" },
      { alt: true },
      { meta: true, control: true },
      { meta: false, control: false },
    ]) {
      const preventDefault = mock(() => undefined);
      contents.emit(
        "before-input-event",
        { preventDefault },
        { type: "keyDown", key: "v", alt: false, ...modifier, ...change }
      );
      expect(preventDefault).not.toHaveBeenCalled();
    }
    expect(contents.paste).toHaveBeenCalledTimes(2);
    const request = contents.session.setPermissionRequestHandler.mock.calls[0][0];
    const allowed = await new Promise<boolean>((resolve) => {
      request(contents, "clipboard-read", resolve, {
        isMainFrame: true,
        requestingUrl: windows[0].url,
      });
    });
    expect(allowed).toBe(false);
  });

  test.each(["remote", "auth popup"])(
    "returns to local with the platform shortcut from %s",
    async (target) => {
      const { manager, windows, onDisconnected } = setup();
      await manager.connect("https://example.com/");
      const remote = windows[0];
      const popup = new TestWindow();
      remote.webContents.setWindowOpenHandler.mock.calls[0][0]({ url: "about:blank" });
      remote.webContents.emit("did-create-window", popup);
      const contents = target === "remote" ? remote.webContents : popup.webContents;
      const modifier =
        process.platform === "darwin"
          ? { meta: true, control: false }
          : { control: true, meta: false };
      for (const change of [
        { type: "keyUp" },
        { shift: false },
        { alt: true },
        { meta: true, control: true },
        { meta: false, control: false },
      ]) {
        const preventDefault = mock(() => undefined);
        contents.emit(
          "before-input-event",
          { preventDefault },
          { type: "keyDown", key: "l", shift: true, alt: false, ...modifier, ...change }
        );
        expect(preventDefault).not.toHaveBeenCalled();
        expect(manager.getState().status).toBe("connected");
      }
      const preventDefault = mock(() => undefined);
      contents.emit(
        "before-input-event",
        { preventDefault },
        { type: "keyDown", key: "l", shift: true, alt: false, ...modifier }
      );
      expect(preventDefault).toHaveBeenCalledTimes(1);
      expect(remote.destroyed).toBe(true);
      expect(popup.destroyed).toBe(true);
      expect(onDisconnected).toHaveBeenCalledTimes(1);
      expect(manager.getState()).toEqual({ status: "disconnected", serverUrl: null });
    }
  );

  test("denies permissions and popups, opening only HTTP links externally", async () => {
    const { manager, windows, openExternal } = setup();
    await manager.connect("https://example.com/");
    const contents = windows[0].webContents;
    const permissionRequest = contents.session.setPermissionRequestHandler.mock.calls[0][0];
    const permissionCheck = contents.session.setPermissionCheckHandler.mock.calls[0][0];
    for (const permission of [
      "media",
      "geolocation",
      "notifications",
      "clipboard-read",
      "unknown",
    ]) {
      const callback = mock<(allow: boolean) => void>();
      permissionRequest(contents, permission, callback, {
        isMainFrame: true,
        requestingUrl: "https://example.com/",
      });
      expect(callback).toHaveBeenCalledWith(false);
    }
    expect(permissionCheck()).toBe(false);
    const openWindow = contents.setWindowOpenHandler.mock.calls[0][0];
    for (const url of ["https://example.com/help", "http://external.example.com/help"]) {
      expect(openWindow({ url })).toEqual({ action: "deny" });
      expect(openExternal).toHaveBeenLastCalledWith(url);
    }
    for (const url of [
      "file:///etc/passwd",
      "javascript:alert(1)",
      "data:text/html,hello",
      "xum://open",
      "mailto:user@example.com",
      "https://user:password@example.com/",
      "invalid",
    ]) {
      expect(openWindow({ url })).toEqual({ action: "deny" });
    }
    expect(openExternal).toHaveBeenCalledTimes(2);
  });
});

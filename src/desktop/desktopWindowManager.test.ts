import { afterEach, describe, expect, mock, test } from "bun:test";
import type { BrowserWindow, BrowserWindowConstructorOptions } from "electron";
import { EventEmitter } from "node:events";
import { runInNewContext } from "node:vm";
import { DesktopWindowManager } from "./desktopWindowManager";

class TestWindow extends EventEmitter {
  destroyed = false;
  forced = false;
  minimized = false;
  url = "";
  loading = Promise.resolve();
  webContents = Object.assign(new EventEmitter(), {
    setWindowOpenHandler: mock<(handler: () => { action: string }) => void>(),
    getURL: () => this.url,
    executeJavaScript: mock<(script: string) => Promise<unknown>>(() => {
      this.close();
      return Promise.resolve(true);
    }),
  });
  isDestroyed = () => this.destroyed;
  isMinimized = () => this.minimized;
  restore = mock(() => {
    this.minimized = false;
  });
  focus = mock(() => undefined);
  loadURL = (url: string) => {
    this.url = url;
    return this.loading;
  };
  close = () => {
    let prevented = false;
    this.emit("close", {
      preventDefault: () => {
        prevented = true;
      },
    });
    if (!prevented) {
      this.destroyed = true;
      this.emit("closed");
    }
  };
  destroy = () => {
    this.forced = true;
    this.destroyed = true;
    this.emit("closed");
  };
}

interface CloseRequest {
  instanceId: string;
  handled: boolean;
  completion?: Promise<void>;
}

function executeCloseScript(
  window: TestWindow,
  script: string,
  onRequest: (request: CloseRequest) => void
): Promise<unknown> {
  const result: unknown = runInNewContext(script, {
    location: { href: window.url },
    CustomEvent: class {
      detail: CloseRequest;
      constructor(_type: string, options: { detail: CloseRequest }) {
        this.detail = options.detail;
      }
    },
    window: { dispatchEvent: (event: { detail: CloseRequest }) => onRequest(event.detail) },
  });
  return Promise.resolve(result);
}

function setup(isPackaged = false) {
  const windows: TestWindow[] = [];
  const options: BrowserWindowConstructorOptions[] = [];
  let loading = Promise.resolve();
  const manager = new DesktopWindowManager((windowOptions) => {
    const window = new TestWindow();
    window.loading = loading;
    windows.push(window);
    options.push(windowOptions);
    // Electron is the foreign host boundary; no global module mocking can leak into other suites.
    return window as unknown as BrowserWindow;
  }, isPackaged);
  return {
    manager,
    windows,
    options,
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

const originalEnv = { ...process.env };
afterEach(() => {
  for (const key of ["XUM_DEVSERVER_HOST", "XUM_DEVSERVER_PORT", "XUM_E2E_LOAD_DIST"]) {
    if (originalEnv[key] === undefined) delete process.env[key];
    else process.env[key] = originalEnv[key];
  }
});

describe("DesktopWindowManager", () => {
  test("uses the sandbox origin, encodes identities, and isolates the preload", async () => {
    process.env.XUM_DEVSERVER_HOST = "localhost";
    process.env.XUM_DEVSERVER_PORT = "54321";
    process.env.XUM_E2E_LOAD_DIST = "0";
    const { manager, windows, options } = setup();
    await manager.openWindow("workspace & one", "instance?two");
    const url = new URL(windows[0].url);
    expect(url.origin).toBe("http://localhost:54321");
    expect(url.pathname).toBe("/desktop.html");
    expect(url.searchParams.get("workspaceId")).toBe("workspace & one");
    expect(url.searchParams.get("instanceId")).toBe("instance?two");
    expect(options[0].webPreferences).toMatchObject({
      nodeIntegration: false,
      contextIsolation: true,
    });
    expect(options[0].webPreferences?.preload).toEndWith("preload.js");
    await manager.closeAll();
  });

  test.each([false, true])(
    "blocks navigation to other origins, files, app pages, or instances (packaged=%s)",
    async (packaged) => {
      process.env.XUM_E2E_LOAD_DIST = "0";
      const { manager, windows } = setup(packaged);
      await manager.openWindow("workspace", "instance");
      const window = windows[0];
      const trusted = new URL(window.url);
      const otherPage = new URL("./index.html", trusted).href;
      const otherInstance = new URL(trusted);
      otherInstance.searchParams.set("instanceId", "replacement");
      const forbidden = [
        "https://example.com",
        "file:///etc/passwd",
        otherPage,
        otherInstance.href,
        "javascript:alert(1)",
        "not a URL",
      ];
      for (const eventName of ["will-navigate", "will-redirect"]) {
        for (const url of forbidden) {
          const preventDefault = mock(() => undefined);
          window.webContents.emit(eventName, { preventDefault }, url);
          expect(preventDefault).toHaveBeenCalledTimes(1);
        }
        const preventDefault = mock(() => undefined);
        window.webContents.emit(eventName, { preventDefault }, `${window.url}#viewer`);
        expect(preventDefault).not.toHaveBeenCalled();
      }
      const handler = window.webContents.setWindowOpenHandler.mock.calls[0][0];
      expect(handler()).toEqual({ action: "deny" });
      const preventDefault = mock(() => undefined);
      window.webContents.emit("will-attach-webview", { preventDefault });
      expect(preventDefault).toHaveBeenCalledTimes(1);
      await manager.closeAll();
    }
  );

  test("forced dist mode never contacts the dev server", async () => {
    process.env.XUM_E2E_LOAD_DIST = "1";
    const { manager, windows } = setup();
    await manager.openWindow("workspace", "instance");
    expect(new URL(windows[0].url).protocol).toBe("file:");
    await manager.closeAll();
  });

  test("racing opens focus and return the original instance, even while loading", async () => {
    const { manager, windows, setLoading } = setup();
    const gate = deferred();
    setLoading(gate.promise);
    const first = manager.openWindow("workspace", "first");
    windows[0].minimized = true;
    const second = manager.openWindow("workspace", "second");
    expect(windows).toHaveLength(1);
    expect(manager.getWindow("workspace")).toEqual({ instanceId: "first" });
    expect(windows[0].focus).toHaveBeenCalledTimes(1);
    expect(windows[0].minimized).toBe(false);
    gate.resolve();
    expect(await first).toEqual({ instanceId: "first" });
    expect(await second).toEqual({ instanceId: "first" });
    await manager.closeWindow("workspace", "second");
    expect(windows[0].destroyed).toBe(false);
    await manager.closeWindow("workspace", "first");
    expect(manager.getWindow("workspace")).toBeNull();
  });

  test("failed loading releases the window and permits a retry", async () => {
    const { manager, windows, setLoading } = setup();
    const gate = deferred();
    setLoading(gate.promise);
    const first = manager.openWindow("workspace", "failed").catch((error: unknown) => error);
    const duplicate = manager.openWindow("workspace", "duplicate").catch((error: unknown) => error);
    gate.reject(new Error("load failed"));
    expect(await first).toEqual(new Error("load failed"));
    expect(await duplicate).toEqual(new Error("load failed"));
    expect(windows[0].destroyed).toBe(true);
    expect(manager.getWindow("workspace")).toBeNull();
    setLoading(Promise.resolve());
    expect(await manager.openWindow("workspace", "retry")).toEqual({ instanceId: "retry" });
    await manager.closeAll();
  });

  test("closing a loading window cannot resurrect it or remove its replacement", async () => {
    const { manager, windows, setLoading } = setup();
    const gate = deferred();
    setLoading(gate.promise);
    const pending = manager.openWindow("workspace", "old").catch((error: unknown) => error);
    await manager.closeWorkspace("workspace");
    setLoading(Promise.resolve());
    await manager.openWindow("workspace", "new");
    windows[0].emit("closed");
    gate.resolve();
    expect(await pending).toBeInstanceOf(Error);
    await manager.closeWindow("workspace", "old");
    expect(manager.getWindow("workspace")).toEqual({ instanceId: "new" });
    await manager.closeAll();
  });

  test("renderer crashes and main-frame load failures release manager truth", async () => {
    const { manager, windows } = setup();
    await manager.openWindow("workspace", "crashing");
    windows[0].webContents.emit("render-process-gone");
    expect(manager.getWindow("workspace")).toBeNull();
    expect(windows[0].destroyed).toBe(true);
    await manager.openWindow("workspace", "reloading");
    windows[1].webContents.emit("did-fail-load", {}, -3, "aborted", "", true);
    windows[1].webContents.emit("did-fail-load", {}, -2, "subframe failed", "", false);
    expect(manager.getWindow("workspace")).toEqual({ instanceId: "reloading" });
    windows[1].webContents.emit("did-fail-load", {}, -2, "reload failed", "", true);
    expect(manager.getWindow("workspace")).toBeNull();
    expect(windows[1].destroyed).toBe(true);
  });

  test("constructor failure leaves no reservation", async () => {
    const manager = new DesktopWindowManager(() => {
      throw new Error("constructor failed");
    }, false);
    expect(
      await manager.openWindow("workspace", "instance").catch((error: unknown) => error)
    ).toEqual(new Error("constructor failed"));
    expect(manager.getWindow("workspace")).toBeNull();
  });

  test.each(["manager", "native"])(
    "%s close waits for renderer cleanup and refuses duplicate opens",
    async (source) => {
      const { manager, windows } = setup();
      await manager.openWindow("workspace", "viewer");
      const cleanup = deferred();
      windows[0].webContents.executeJavaScript.mockImplementation(async () => {
        await cleanup.promise;
        return true;
      });
      if (source === "native") windows[0].close();
      const closing = manager.closeWorkspace("workspace");
      // A repeated titlebar close cannot bypass an in-flight input release.
      windows[0].close();
      expect(manager.closeWorkspace("workspace")).toBe(closing);
      expect(manager.getWindow("workspace")).toEqual({ instanceId: "viewer" });
      expect(
        await manager.openWindow("workspace", "replacement").catch((error: unknown) => error)
      ).toBeInstanceOf(Error);
      let settled = false;
      const finished = closing.then(() => {
        settled = true;
      });
      await Promise.resolve();
      expect(settled).toBe(false);
      expect(windows[0].destroyed).toBe(false);
      cleanup.resolve();
      await finished;
      expect(windows[0].forced).toBe(false);
      expect(manager.getWindow("workspace")).toBeNull();
    }
  );

  test("bounds a hung renderer and does not leave a closing reservation", async () => {
    const { manager, windows } = setup();
    await manager.openWindow("workspace", "hung");
    windows[0].webContents.executeJavaScript.mockImplementation(() => new Promise(() => undefined));
    await manager.closeWorkspace("workspace");
    expect(windows[0].forced).toBe(true);
    expect(manager.getWindow("workspace")).toBeNull();
    await manager.openWindow("workspace", "replacement");
    await manager.closeAll();
  });

  test("only executes cleanup in the exact trusted viewer and JSON-encodes its identity", async () => {
    const { manager, windows } = setup();
    const instanceId = `viewer'); throw new Error('injected'); //`;
    await manager.openWindow("workspace", instanceId);
    let received: unknown;
    windows[0].webContents.executeJavaScript.mockImplementation((script) =>
      executeCloseScript(windows[0], script, (request) => {
        received = request.instanceId;
        request.handled = true;
        request.completion = Promise.resolve();
        windows[0].close();
      })
    );
    await manager.closeWorkspace("workspace");
    expect(received).toBe(instanceId);
    expect(windows[0].forced).toBe(false);
    await manager.openWindow("other", "viewer");
    windows[1].url = "https://untrusted.example/desktop.html";
    await manager.closeWorkspace("other");
    expect(windows[1].webContents.executeJavaScript).not.toHaveBeenCalled();
    expect(windows[1].forced).toBe(true);
  });

  test("closes all viewers in parallel rather than stacking their cleanup deadlines", async () => {
    const { manager, windows } = setup();
    await manager.openWindow("one", "one");
    await manager.openWindow("two", "two");
    for (const window of windows) window.webContents.executeJavaScript.mockResolvedValue(true);
    const closing = manager.closeAll();
    await Promise.resolve();
    expect(
      windows.every((window) => window.webContents.executeJavaScript.mock.calls.length === 1)
    ).toBe(true);
    expect(
      await manager.openWindow("three", "three").catch((error: unknown) => error)
    ).toBeInstanceOf(Error);
    for (const window of windows) window.close();
    await closing;
    expect(windows.every((window) => !window.forced)).toBe(true);
  });

  test("shutdown closes every workspace and rejects new opens", async () => {
    const { manager, windows } = setup();
    await manager.openWindow("one", "one");
    await manager.openWindow("two", "two");
    await manager.closeAll();
    expect(windows.every((window) => window.destroyed)).toBe(true);
    expect(manager.getWindow("one")).toBeNull();
    expect(await manager.openWindow("one", "new").catch((error: unknown) => error)).toBeInstanceOf(
      Error
    );
    expect(windows).toHaveLength(2);
  });
});

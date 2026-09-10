import type { BrowserWindow, BrowserWindowConstructorOptions, Event } from "electron";
import assert from "node:assert/strict";
import * as path from "node:path";
import { pathToFileURL } from "node:url";
import { resolveXumEnvironmentValue } from "@/common/compat/legacyMux";
import {
  DESKTOP_POPOUT_CLOSE_EVENT,
  DESKTOP_VIEWER_DISCONNECT_TIMEOUT_MS,
} from "@/common/constants/desktop";

interface DesktopWindowEntry {
  window: BrowserWindow;
  instanceId: string;
  loaded: Promise<void>;
  trustedUrl: string;
  closing?: Promise<void>;
  allowClose: boolean;
}

/** One desktop viewer per workspace; closing the viewer never stops the desktop session. */
export class DesktopWindowManager {
  private readonly windows = new Map<string, DesktopWindowEntry>();
  private disposed = false;

  constructor(
    private readonly createWindow: (options: BrowserWindowConstructorOptions) => BrowserWindow,
    private readonly isPackaged: boolean
  ) {}

  async openWindow(workspaceId: string, instanceId: string): Promise<{ instanceId: string }> {
    assert(workspaceId.length > 0 && instanceId.length > 0, "Desktop window IDs must be non-empty");
    if (this.disposed) throw new Error("Desktop windows are shutting down");

    const existing = this.windows.get(workspaceId);
    if (existing && !existing.window.isDestroyed()) {
      if (existing.closing) throw new Error("Desktop window is closing");
      if (existing.window.isMinimized()) existing.window.restore();
      existing.window.focus();
      await existing.loaded;
      this.assertCurrent(workspaceId, existing);
      return { instanceId: existing.instanceId };
    }

    const getEnv = (suffix: string) => resolveXumEnvironmentValue(suffix, process.env);
    const useDevServer = !this.isPackaged && getEnv("E2E_LOAD_DIST") !== "1";
    const url = useDevServer
      ? new URL(
          `http://${getEnv("DEVSERVER_HOST") ?? "127.0.0.1"}:${getEnv("DEVSERVER_PORT") ?? "5173"}/desktop.html`
        )
      : pathToFileURL(path.join(__dirname, "../desktop.html"));
    url.search = new URLSearchParams({ workspaceId, instanceId }).toString();

    const window = this.createWindow({
      width: 1100,
      height: 800,
      title: "Desktop",
      webPreferences: {
        nodeIntegration: false,
        contextIsolation: true,
        preload: path.join(__dirname, "../preload.js"),
        spellcheck: false,
      },
    });
    const entry: DesktopWindowEntry = {
      window,
      instanceId,
      loaded: Promise.resolve(),
      trustedUrl: url.href,
      allowClose: false,
    };
    // Reserve before loadURL yields so duplicate opens share this exact instance.
    this.windows.set(workspaceId, entry);

    try {
      // SECURITY AUDIT: the preload exposes privileged IPC. Same-origin is insufficient for
      // file: URLs or other app pages; only this viewer's exact path/query may navigate.
      const guardNavigation = (event: Event, target: string): void => {
        try {
          const destination = new URL(target);
          destination.hash = "";
          if (destination.href === url.href) return;
        } catch {
          // Malformed targets are untrusted too.
        }
        event.preventDefault();
      };
      window.webContents.setWindowOpenHandler(() => ({ action: "deny" }));
      window.webContents.on("will-navigate", guardNavigation);
      window.webContents.on("will-redirect", guardNavigation);
      window.webContents.on("will-attach-webview", (event) => event.preventDefault());
      const closeFailedWindow = (): void => {
        if (this.windows.get(workspaceId) === entry) window.destroy();
      };
      // Manager truth must release a crashed/failed viewer so the embedded viewer can recover.
      window.webContents.on("render-process-gone", closeFailedWindow);
      window.webContents.on(
        "did-fail-load",
        (_event, errorCode, _description, _url, isMainFrame) => {
          // ERR_ABORTED also occurs when a normal reload supersedes an in-flight navigation.
          if (isMainFrame && errorCode !== -3) closeFailedWindow();
        }
      );
      window.on("close", (event) => {
        if (entry.allowClose) return;
        // Native/titlebar close and the renderer's early window.close both wait for input
        // cleanup. Only this manager may retry the close after observing completion.
        event.preventDefault();
        this.closeWorkspace(workspaceId).catch(closeFailedWindow);
      });
      window.on("closed", () => {
        if (this.windows.get(workspaceId) === entry) this.windows.delete(workspaceId);
      });
      entry.loaded = window.loadURL(url.href);
      await entry.loaded;
      this.assertCurrent(workspaceId, entry);
      return { instanceId };
    } catch (error) {
      if (!entry.closing) {
        if (this.windows.get(workspaceId) === entry) this.windows.delete(workspaceId);
        if (!window.isDestroyed()) window.destroy();
      }
      throw error;
    }
  }

  private assertCurrent(workspaceId: string, entry: DesktopWindowEntry): void {
    if (this.windows.get(workspaceId) !== entry || entry.window.isDestroyed() || entry.closing) {
      throw new Error(`Desktop window for ${workspaceId} was closed while opening`);
    }
  }

  getWindow(workspaceId: string): { instanceId: string } | null {
    const entry = this.windows.get(workspaceId);
    return entry && !entry.window.isDestroyed() ? { instanceId: entry.instanceId } : null;
  }

  closeWindow(workspaceId: string, instanceId: string): Promise<void> {
    return this.windows.get(workspaceId)?.instanceId === instanceId
      ? this.closeWorkspace(workspaceId)
      : Promise.resolve();
  }

  closeWorkspace(workspaceId: string): Promise<void> {
    const entry = this.windows.get(workspaceId);
    if (!entry || entry.window.isDestroyed()) return Promise.resolve();
    // Reserve before dispatch so a racing open cannot reuse a viewer returning its input.
    entry.closing ??= Promise.resolve().then(() => this.closeEntry(entry));
    return entry.closing;
  }

  private async closeEntry(entry: DesktopWindowEntry): Promise<void> {
    const window = entry.window;
    if (window.isDestroyed()) return;
    let onClosed!: () => void;
    const closed = new Promise<void>((resolve) => {
      onClosed = resolve;
      window.once("closed", onClosed);
    });
    // Leave room for the renderer's bounded VNC disconnect before forcing a stuck viewer.
    const timeout = setTimeout(() => {
      if (!window.isDestroyed()) window.destroy();
      onClosed();
    }, DESKTOP_VIEWER_DISCONNECT_TIMEOUT_MS * 2);
    timeout.unref?.();
    try {
      // SECURITY AUDIT: only the exact trusted viewer may receive this fixed cleanup program.
      // All interpolated data is JSON-encoded; recheck inside the renderer to close navigation races.
      const script = `(async () => {
        if (location.href.split("#")[0] !== ${JSON.stringify(entry.trustedUrl)}) return false;
        const request = { instanceId: ${JSON.stringify(entry.instanceId)}, handled: false };
        window.dispatchEvent(new CustomEvent(${JSON.stringify(DESKTOP_POPOUT_CLOSE_EVENT)}, { detail: request }));
        if (!request.handled || !request.completion) return false;
        await request.completion;
        return true;
      })()`;
      if (window.webContents.getURL().split("#")[0] !== entry.trustedUrl) {
        window.destroy();
        return;
      }
      await Promise.race([
        closed,
        window.webContents.executeJavaScript(script).then((completed: unknown) => {
          if (!window.isDestroyed()) {
            if (completed === true) {
              entry.allowClose = true;
              window.close();
            } else {
              window.destroy();
            }
          }
          return closed;
        }),
      ]);
    } catch {
      // A dead renderer or a viewer without its cleanup handler cannot release input itself.
      if (!window.isDestroyed()) window.destroy();
    } finally {
      clearTimeout(timeout);
      window.off("closed", onClosed);
    }
  }

  async closeAll(): Promise<void> {
    this.disposed = true;
    await Promise.all(
      Array.from(this.windows.keys(), (workspaceId) => this.closeWorkspace(workspaceId))
    );
  }
}

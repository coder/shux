// CDM-01-007: Restrict all file/directory creation to owner-only permissions.
// Must be set before any filesystem operations occur.
process.umask(0o077);

import { installEpipeGuard, isEpipeError } from "./utils/epipeGuard";

// When the launching terminal exits (packaged Linux/AppImage), stdout/stderr
// become dead pipes and every console write raises EPIPE. Swallow those before
// anything logs so they can never crash the app or loop the error dialog (#3082).
installEpipeGuard(process.stdout);
installEpipeGuard(process.stderr);

// Enable source map support for better error stack traces in production
import "@/node/compat/installLegacyMuxEnvironment";
import "source-map-support/register";
import { promises as fsPromises } from "node:fs";
import * as path from "node:path";
import { createRequire } from "node:module";
import { pathToFileURL } from "node:url";
import { cleanupObsoleteXumBinArtifacts, getXumHome } from "@/common/constants/paths";
import { getElectronAppIdentity } from "@/common/compat/electronAppIdentity";
import {
  SUPPORTED_XUM_PROTOCOL_SCHEMES,
  resolveXumEnvironmentValue,
} from "@/common/compat/legacyMux";
import { XUM_PRODUCT_DESCRIPTION } from "@/common/constants/product";
import {
  initializeXumHomeTransition,
  initializeXumUserDataTransition,
} from "@/node/compat/xumTransition";

// Fix PATH on macOS when launched from Finder (not terminal).
// GUI apps inherit minimal PATH from launchd, missing Homebrew tools like git-lfs.
// Must run before any child process spawns. Failures are silently ignored.
if (process.platform === "darwin") {
  try {
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    (require("fix-path") as { default: () => void }).default();
  } catch (e) {
    // App works with existing PATH; debug log for troubleshooting
    console.debug("[fix-path] Failed to enrich PATH:", e);
  }
}

import { DesktopWindowManager } from "./desktopWindowManager";
import { RemoteConnectionManager } from "./remoteConnectionManager";
import {
  REMOTE_CONNECTION_CHANNELS,
  REMOTE_CONNECTION_RETURN_ACCELERATOR,
} from "@/common/constants/remoteConnection";
import { randomBytes } from "crypto";
import { RPCHandler } from "@orpc/server/message-port";
import { onError } from "@orpc/server";
import { router } from "../node/orpc/router";
import { formatOrpcError } from "../node/orpc/formatOrpcError";
import { ServerLockfile } from "../node/services/serverLockfile";
import "disposablestack/auto";

import type {
  BrowserWindowConstructorOptions,
  Event as ElectronEvent,
  IpcMainEvent,
  IpcMainInvokeEvent,
  MenuItemConstructorOptions,
  MessageBoxOptions,
  WebContents,
} from "electron";
import {
  app,
  crashReporter,
  BrowserWindow,
  ipcMain as electronIpcMain,
  Menu,
  Tray,
  dialog,
  nativeImage,
  nativeTheme,
  screen,
  shell,
} from "electron";

const getXumEnv = (suffix: string): string | undefined =>
  resolveXumEnvironmentValue(suffix, process.env);

const isE2ETest = getXumEnv("E2E") === "1";
const forceDistLoad = getXumEnv("E2E_LOAD_DIST") === "1";

// Split display name from desktop/userData identity before Electron creates windows.
// Linux keeps the lowercase slug for WM_CLASS / Wayland app_id; other platforms use "Xum"
// so app.getName() (and the macOS application menu) stay display-cased. userData is set
// explicitly to the slug directory later so setName() cannot fork storage casing.
const electronAppIdentity = getElectronAppIdentity(process.platform);
app.setName(electronAppIdentity.appName);
if (electronAppIdentity.chromeDesktop != null) {
  // sanitizeXumChildEnv strips CHROME_DESKTOP from child processes launched in terminals.
  process.env.CHROME_DESKTOP = electronAppIdentity.chromeDesktop;
}

async function isUsableDirectory(candidatePath: string): Promise<boolean> {
  try {
    return (await fsPromises.stat(candidatePath)).isDirectory();
  } catch {
    return false;
  }
}

/**
 * Home and userData transitions must finish before crashReporter, the single-instance
 * lock, services, or windows. Electron is already imported (CJS hoists requires), but
 * app.setPath("userData") still has to complete before those later APIs run.
 */
async function initializeXumDesktopStorage(): Promise<void> {
  try {
    const transition = await initializeXumHomeTransition();
    cleanupObsoleteXumBinArtifacts(transition.activePath);
    for (const issue of transition.issues) {
      console.debug("[xum-transition]", issue);
    }
  } catch (error) {
    // Startup initialization must never crash the app.
    console.debug("[xum-transition] Failed home transition:", error);
  }

  if (isE2ETest) {
    // E2E state remains inside the explicitly isolated XUM_ROOT/MUX_ROOT directory.
    const e2eUserData = path.join(getXumHome(), "user-data");
    try {
      await fsPromises.mkdir(e2eUserData, { recursive: true });
      app.setPath("userData", e2eUserData);
      console.log("Using test userData directory:", e2eUserData);
    } catch (error) {
      console.warn("Failed to prepare test userData directory:", error);
    }
    return;
  }

  const appDataDir = app.getPath("appData");
  const canonicalUserData = path.join(appDataDir, electronAppIdentity.userDataDirName);
  try {
    const transition = await initializeXumUserDataTransition({
      appDataDir,
      platform: process.platform,
    });
    if (await isUsableDirectory(transition.activePath)) {
      app.setPath("userData", transition.activePath);
    } else {
      console.debug(
        "[xum-transition] Refusing to set userData to a non-directory:",
        transition.activePath
      );
    }
    for (const issue of transition.issues) {
      console.debug("[xum-transition]", issue);
    }
  } catch (error) {
    // Never fall back to Electron's name-derived userData: display-cased setName("Xum")
    // would otherwise create a parallel Xum/ directory beside the canonical xum/ slug.
    // Also never point userData at an obstructing file or broken alias.
    console.debug("[xum-transition] Failed Electron userData transition:", error);
    if (await isUsableDirectory(canonicalUserData)) {
      app.setPath("userData", canonicalUserData);
    } else {
      console.debug(
        "[xum-transition] Refusing to set userData to a non-directory:",
        canonicalUserData
      );
    }
  }
}

// Increase renderer V8 heap limit from default ~4GB to 8GB.
// At ~3.9GB usage, the default limit causes frequent Mark-Compact GC cycles
// with low mutator utilization (~39%), degrading UI responsiveness.
// Must be called before app.whenReady().
app.commandLine.appendSwitch("js-flags", "--max-old-space-size=8192");

import type { Config } from "../node/config";
import type { ServiceContainer } from "../node/services/serviceContainer";
import { VERSION } from "../version";
import type { DeepLinkPayload } from "../common/types/deepLink";
import type { UpdateStatus } from "../common/orpc/types";
import { parseXumDeepLink } from "../common/utils/deepLink";

import { normalizeAndValidateExternalUrl } from "./utils/normalizeAndValidateExternalUrl";
import { hasSameOrigin } from "./utils/hasSameOrigin";
import assert from "../common/utils/assert";
import { setOpenSSHHostKeyPolicyMode } from "@/node/runtime/sshConnectionPool";
import { loadTokenizerModules } from "../node/utils/main/tokenizer";
import { isBashAvailable } from "../node/utils/main/bashPath";
import windowStateKeeper from "electron-window-state";
import { getTitleBarOptions } from "./titleBarOptions";
import { isUpdateInstallInProgress } from "./updateInstallState";
import {
  getXumDeepLinksFromArgv,
  getXumProtocolClientRegistration,
} from "./utils/xumProtocolRegistration";
import { getErrorMessage } from "@/common/utils/errors";
import { log } from "@/node/services/log";

// React DevTools for development profiling
// Using dynamic import() to avoid loading electron-devtools-installer at module init time

// IMPORTANT: Lazy-load heavy dependencies to maintain fast startup time
//
// To keep startup time under 4s, avoid importing AI SDK packages at the top level.
// These files MUST use dynamic import():
//   - main.ts, config.ts, preload.ts (startup-critical)
//
// ✅ GOOD: const { createAnthropic } = await import("@ai-sdk/anthropic");
// ❌ BAD:  import { createAnthropic } from "@ai-sdk/anthropic";
//
// Enforcement: scripts/check_eager_imports.sh validates this in CI
//
// Lazy-load Config and ServiceContainer to avoid loading heavy AI SDK dependencies at startup
// These will be loaded on-demand when createWindow() is called
let config: Config | null = null;
let services: ServiceContainer | null = null;
let remoteConnectionManager: RemoteConnectionManager | null = null;
const localIpcWindows = new Map<WebContents, URL>();

function isTrustedLocalUrl(target: string, expected: URL): boolean {
  try {
    const url = new URL(target);
    return expected.protocol === "file:"
      ? url.protocol === "file:" && url.host === expected.host && url.pathname === expected.pathname
      : url.origin === expected.origin;
  } catch {
    return false;
  }
}

function createLocalWindow(
  options: BrowserWindowConstructorOptions,
  page: "index.html" | "terminal.html" | "desktop.html" = "index.html"
): BrowserWindow {
  const window = new BrowserWindow(options);
  const contents = window.webContents;
  const expected =
    !app.isPackaged && !forceDistLoad
      ? new URL(
          page === "terminal.html"
            ? "http://localhost:5173"
            : "http://" + (getXumEnv("DEVSERVER_HOST") ?? "127.0.0.1") + ":" + devServerPort
        )
      : pathToFileURL(path.join(__dirname, "..", page));
  localIpcWindows.set(contents, expected);
  contents.once("destroyed", () => localIpcWindows.delete(contents));
  // Redirects and other packaged files must not retain this window's privileged preload.
  const guardNavigation = (event: ElectronEvent, target: string): void => {
    if (!isTrustedLocalUrl(target, expected)) event.preventDefault();
  };
  contents.on("will-navigate", guardNavigation);
  contents.on("will-redirect", guardNavigation);
  return window;
}

function isLocalIpcSender(event: IpcMainEvent | IpcMainInvokeEvent): boolean {
  const expected = localIpcWindows.get(event.sender);
  return (
    expected != null &&
    event.senderFrame === event.sender.mainFrame &&
    isTrustedLocalUrl(event.senderFrame.url, expected)
  );
}

const requireDesktopModule = createRequire(__filename);

// XUM_PROXY_URI is canonical; the transition layer mirrors legacy MUX_PROXY_URI.
const localhostProxyTemplate =
  // eslint-disable-next-line @typescript-eslint/prefer-nullish-coalescing -- intentional: empty/whitespace-only env vars should be treated as unset
  getXumEnv("PROXY_URI")?.trim() || process.env.VSCODE_PROXY_URI?.trim() || undefined;

const devServerPort = getXumEnv("DEVSERVER_PORT") ?? "5173";

console.log(
  `Xum starting - version: ${(VERSION as { git?: string; buildTime?: string }).git ?? "(dev)"} (built: ${(VERSION as { git?: string; buildTime?: string }).buildTime ?? "dev-mode"})`
);
console.log("Main process starting...");

// Debug: abort immediately if XUM_DEBUG_START_TIME (or legacy MUX_DEBUG_START_TIME) is set.
// This is used to measure baseline startup time without full initialization.
if (getXumEnv("DEBUG_START_TIME") === "1") {
  console.log("XUM_DEBUG_START_TIME is set - aborting immediately");
  process.exit(0);
}

// Global error handlers for better error reporting
process.on("uncaughtException", (error: unknown) => {
  console.error("Uncaught Exception:", error);

  const message = getErrorMessage(error);
  const stack = error instanceof Error ? error.stack : undefined;

  console.error("Stack:", stack);

  // Show error dialog in production. EPIPE never warrants a modal: it means a
  // pipe reader went away (defense-in-depth for streams the guard above misses).
  if (app.isPackaged && !isEpipeError(error)) {
    dialog.showErrorBox(
      "Application Error",
      `An unexpected error occurred:\n\n${message}\n\nStack trace:\n${stack ?? "No stack trace available"}`
    );
  }
});

process.on("unhandledRejection", (reason, promise) => {
  console.error("Unhandled Rejection at:", promise);
  console.error("Reason:", reason);

  if (app.isPackaged && !isEpipeError(reason)) {
    const message = getErrorMessage(reason);
    const stack = reason instanceof Error ? reason.stack : undefined;
    dialog.showErrorBox(
      "Unhandled Promise Rejection",
      `An unhandled promise rejection occurred:\n\n${message}\n\nStack trace:\n${stack ?? "No stack trace available"}`
    );
  }
});

// Single-instance locking can be disabled for development with XUM_ALLOW_MULTIPLE_INSTANCES=1.
// The compatibility layer also accepts MUX_ and the older CMUX_ spelling.
const allowMultipleInstances = getXumEnv("ALLOW_MULTIPLE_INSTANCES") === "1";

let mainWindow: BrowserWindow | null = null;
let splashWindow: BrowserWindow | null = null;
let tray: Tray | null = null;
let isQuitting = false;
let latestUpdateStatus: UpdateStatus = { type: "idle" };
let isUpdateClosePromptOpen = false;

// xum:// and legacy mux:// deep links can arrive before the main window finishes loading.
const bufferedXumDeepLinks: DeepLinkPayload[] = [];
let mainWindowFinishedLoading = false;

function focusMainWindow() {
  if (!mainWindow) return;
  if (mainWindow.isMinimized()) mainWindow.restore();
  // Closing Xum on Windows hides to tray; show it again when a second-instance launch occurs.
  mainWindow.show();
  mainWindow.focus();
}

function flushBufferedXumDeepLinks() {
  if (!mainWindow || !mainWindowFinishedLoading) return;

  while (bufferedXumDeepLinks.length > 0) {
    const payload = bufferedXumDeepLinks[0];
    try {
      mainWindow.webContents.send("mux:deep-link", payload);
      bufferedXumDeepLinks.shift();
    } catch (error) {
      // Best-effort: never crash startup if the renderer isn't ready.
      console.debug("[deep-link] Failed to send xum/mux deep-link payload:", error);
      return;
    }
  }
}

function handleXumDeepLink(raw: string) {
  try {
    const payload = parseXumDeepLink(raw);
    if (!payload) return;

    // Buffer until the renderer has finished loading.
    if (!mainWindow || !mainWindowFinishedLoading) {
      bufferedXumDeepLinks.push(payload);
      return;
    }

    mainWindow.webContents.send("mux:deep-link", payload);
  } catch (error) {
    // Best-effort: never crash startup if argv parsing/protocol handling is weird.
    console.debug(`[deep-link] Failed to handle xum/mux deep link: ${raw}`, error);
  }
}

function handleArgvXumDeepLinks(argv: string[]) {
  for (const arg of getXumDeepLinksFromArgv(argv)) {
    handleXumDeepLink(arg);
  }
}

// macOS deep links arrive via open-url (must be registered before ready)
if (process.platform === "darwin") {
  app.on("open-url", (event, url) => {
    event.preventDefault();
    handleXumDeepLink(url);
    focusMainWindow();
  });
}

// Initial launch: Windows/Linux deep links are passed in argv.
try {
  handleArgvXumDeepLinks(process.argv);
} catch (error) {
  console.debug("[deep-link] Failed to parse initial argv for xum/mux deep links:", error);
}

function registerXumProtocolClients() {
  try {
    const registration = getXumProtocolClientRegistration({
      platform: process.platform,
      isPackaged: app.isPackaged,
      defaultApp: process.defaultApp,
      argv: process.argv,
      execPath: process.execPath,
    });

    for (const scheme of SUPPORTED_XUM_PROTOCOL_SCHEMES) {
      if (registration) {
        app.setAsDefaultProtocolClient(scheme, registration.executable, registration.args);
      } else {
        app.setAsDefaultProtocolClient(scheme);
      }
    }
  } catch (error) {
    // Best-effort: never crash startup if protocol registration fails.
    console.debug("[deep-link] Failed to register xum:// and mux:// handlers:", error);
  }
}

/**
 * Format timestamp as HH:MM:SS.mmm for readable logging
 */
function timestamp(): string {
  const now = new Date();
  const hours = String(now.getHours()).padStart(2, "0");
  const minutes = String(now.getMinutes()).padStart(2, "0");
  const seconds = String(now.getSeconds()).padStart(2, "0");
  const ms = String(now.getMilliseconds()).padStart(3, "0");
  return `${hours}:${minutes}:${seconds}.${ms}`;
}

function initializeRemoteConnections(): void {
  const manager = new RemoteConnectionManager({
    createWindow: (options) => new BrowserWindow(options),
    onConnected: () => mainWindow?.hide(),
    onDisconnected: () => {
      if (!isQuitting) openXumFromTray();
    },
    onStateChanged: (state) => {
      if (mainWindow && !mainWindow.isDestroyed()) {
        mainWindow.webContents.send(REMOTE_CONNECTION_CHANNELS.stateChanged, state);
      }
      const returnItem = Menu.getApplicationMenu()?.getMenuItemById("return-to-local");
      if (returnItem) returnItem.enabled = state.status !== "disconnected";
    },
    openExternal: (url) => {
      shell.openExternal(url).catch(() => {
        log.warn("Cannot open the remote server link in the browser.");
      });
    },
  });
  remoteConnectionManager = manager;

  // Keep desktop connection controls off the network API and out of remote pages.
  const assertLocalController = (event: IpcMainInvokeEvent): void => {
    if (!isLocalIpcSender(event) || event.sender !== mainWindow?.webContents) {
      throw new Error("Remote connection controls require the local desktop window.");
    }
  };
  electronIpcMain.handle(REMOTE_CONNECTION_CHANNELS.getState, (event) => {
    assertLocalController(event);
    return manager.getState();
  });
  electronIpcMain.handle(REMOTE_CONNECTION_CHANNELS.connect, (event, url: unknown) => {
    assertLocalController(event);
    if (typeof url !== "string") throw new Error("Enter a valid server URL.");
    return manager.connect(url);
  });
  electronIpcMain.handle(REMOTE_CONNECTION_CHANNELS.disconnect, (event) => {
    assertLocalController(event);
    manager.disconnect();
  });
}

function createMenu() {
  const template: MenuItemConstructorOptions[] = [
    {
      label: "Edit",
      submenu: [
        { role: "undo" },
        { role: "redo" },
        { type: "separator" },
        { role: "cut" },
        { role: "copy" },
        { role: "paste" },
        { role: "selectAll" },
      ],
    },
    {
      label: "View",
      submenu: [
        // Reload without Ctrl+R shortcut (reserved for Code Review refresh)
        {
          label: "Reload",
          click: (_item, focusedWindow) => {
            if (focusedWindow && "reload" in focusedWindow) {
              (focusedWindow as BrowserWindow).reload();
            }
          },
        },
        { role: "forceReload" },
        { role: "toggleDevTools" },
        { type: "separator" },
        { role: "resetZoom" },
        // Bind zoom-in to Ctrl/Cmd+= so the standard shortcut works without requiring Shift.
        { role: "zoomIn", accelerator: "CommandOrControl+=" },
        { role: "zoomOut" },
        { type: "separator" },
        {
          role: "togglefullscreen",
          accelerator: process.platform === "darwin" ? "Ctrl+Command+F" : "F11",
        },
      ],
    },
    {
      label: "Window",
      submenu: [
        { role: "minimize" },
        { role: "close" },
        { type: "separator" },
        {
          id: "return-to-local",
          label: "Return to Local",
          accelerator: REMOTE_CONNECTION_RETURN_ACCELERATOR,
          enabled:
            remoteConnectionManager?.getState().status !== "disconnected" &&
            remoteConnectionManager != null,
          click: () => remoteConnectionManager?.disconnect(),
        },
      ],
    },
  ];

  if (process.platform === "darwin") {
    template.unshift({
      label: app.getName(),
      submenu: [
        { role: "about" },
        { type: "separator" },
        {
          label: "Settings...",
          accelerator: "Cmd+,",
          click: () => {
            openXumFromTray();
            services?.menuEventService.emitOpenSettings();
          },
        },
        { type: "separator" },
        { role: "services", submenu: [] },
        { type: "separator" },
        { role: "hide" },
        { role: "hideOthers" },
        { role: "unhide" },
        { type: "separator" },
        { role: "quit" },
      ],
    });
  }

  const menu = Menu.buildFromTemplate(template);
  Menu.setApplicationMenu(menu);
}

/**
 * System tray (Windows/Linux) / menu bar (macOS) icon.
 *
 * - macOS: use a template image (always the black asset) so the system
 *   automatically adapts to light/dark menu bar appearances.
 * - Windows/Linux: switch between black/white assets based on the OS theme.
 *
 * Tray icon assets are expected in the built dist root (copied from /public),
 * alongside splash.html.
 */
function getTrayIconPath(): string {
  if (process.platform === "darwin") {
    return path.join(__dirname, "../tray-icon-black.png");
  }

  const fileName = nativeTheme.shouldUseDarkColors ? "tray-icon-white.png" : "tray-icon-black.png";
  return path.join(__dirname, `../${fileName}`);
}

function loadTrayIconImage() {
  const iconPath = getTrayIconPath();

  // Tray icons are 24×24 PNGs with cropped viewBox. We manually add @2x and
  // @3x representations so macOS picks the sharpest variant for the display's
  // scale factor. Electron auto-detects @2x from the path naming convention
  // but only when both files exist – and it doesn't look for @3x at all.
  const image = nativeImage.createFromPath(iconPath);

  if (image.isEmpty()) {
    console.warn(`[${timestamp()}] [tray] Tray icon missing or unreadable: ${iconPath}`);
    return null;
  }

  for (const scaleFactor of [2, 3] as const) {
    const hqPath = iconPath.replace(/\.png$/, `@${scaleFactor}x.png`);
    const hqImage = nativeImage.createFromPath(hqPath);
    if (!hqImage.isEmpty()) {
      image.addRepresentation({ scaleFactor, buffer: hqImage.toPNG() });
    }
  }

  if (process.platform === "darwin") {
    image.setTemplateImage(true);
  }

  return image;
}

function openXumFromTray() {
  if (mainWindow) {
    if (mainWindow.isMinimized()) mainWindow.restore();
    mainWindow.show();
    mainWindow.focus();
    return;
  }

  // A remote window can keep the app open after the local window closes.
  if (services) createWindow();
}

function updateTrayIcon() {
  if (!tray) return;

  const image = loadTrayIconImage();
  if (!image) {
    return;
  }

  tray.setImage(image);
}

function createTray() {
  if (tray) return;

  const image = loadTrayIconImage();
  if (!image) {
    console.warn(`[${timestamp()}] [tray] Skipping tray creation (icon unavailable)`);
    return;
  }

  try {
    tray = new Tray(image);
  } catch (error) {
    console.warn(`[${timestamp()}] [tray] Failed to create tray:`, error);
    tray = null;
    return;
  }

  const menu = Menu.buildFromTemplate([
    {
      label: "Open Xum",
      click: () => {
        openXumFromTray();
      },
    },
    {
      label: "Exit",
      click: () => {
        app.quit();
      },
    },
  ]);

  tray.setContextMenu(menu);

  // Best-effort: update tray icon when OS appearance changes.
  nativeTheme.on("updated", () => {
    updateTrayIcon();
  });
}

/**
 * Create and show splash screen - instant visual feedback (<100ms)
 *
 * Shows a lightweight native window with static HTML while services load.
 * No IPC, no React, no heavy dependencies - just immediate user feedback.
 */
async function showSplashScreen() {
  const startTime = Date.now();
  console.log(`[${timestamp()}] Showing splash screen...`);

  splashWindow = new BrowserWindow({
    width: 400,
    height: 300,
    frame: false,
    transparent: false,
    backgroundColor: "#0a0a0b", // Match surface-primary - prevents flash
    alwaysOnTop: true,
    center: true,
    resizable: false,
    show: false, // Don't show until HTML is loaded
    webPreferences: {
      nodeIntegration: false,
      contextIsolation: true,
    },
  });

  // Wait for splash HTML to load
  await splashWindow.loadFile(path.join(__dirname, "../splash.html"));

  // Wait for the window to actually be shown and rendered before continuing
  // This ensures the splash is visible before we block the event loop with heavy work
  await new Promise<void>((resolve) => {
    splashWindow!.once("show", () => {
      const loadTime = Date.now() - startTime;
      console.log(`[${timestamp()}] Splash screen shown (${loadTime}ms)`);
      // Give one more event loop tick for the window to actually paint
      setImmediate(resolve);
    });
    splashWindow!.show();
  });

  splashWindow.on("closed", () => {
    console.log(`[${timestamp()}] Splash screen closed event`);
    splashWindow = null;
  });
}

/**
 * Close splash screen
 */
function closeSplashScreen() {
  if (splashWindow) {
    console.log(`[${timestamp()}] Closing splash screen...`);
    splashWindow.close();
    splashWindow = null;
  }
}

/**
 * Load backend services (Config, ServiceContainer, AI SDK, tokenizer)
 *
 * Heavy initialization (~100ms) happens here while splash is visible.
 * Note: Spinner may freeze briefly during this phase. This is acceptable since
 * the splash still provides visual feedback that the app is loading.
 */
async function loadServices(): Promise<void> {
  if (config && services) return; // Already loaded

  const startTime = Date.now();
  console.log(`[${timestamp()}] Loading services...`);

  /* eslint-disable no-restricted-syntax */
  // Dynamic imports are justified here for performance:
  // - ServiceContainer transitively imports the entire AI SDK (ai, @ai-sdk/anthropic, etc.)
  // - These are large modules (~100ms load time) that would block splash from appearing
  // - Loading happens once, then cached
  const [
    { createConfigStores },
    { ServiceContainer: ServiceContainerClass },
    { TerminalWindowManager: TerminalWindowManagerClass },
  ] = await Promise.all([
    import("../node/config"),
    import("../node/services/serviceContainer"),
    import("./terminalWindowManager"),
  ]);
  /* eslint-enable no-restricted-syntax */
  const stores = createConfigStores();
  config = stores.config;

  services = new ServiceContainerClass(stores);
  // Desktop bootstrap owns interactive host-key trust policy
  setOpenSSHHostKeyPolicyMode("strict");
  await services.initialize();
  // Keep the latest update status in main so close-to-tray can prompt for installs.
  services.updateService.onStatus((status) => {
    latestUpdateStatus = status;
  });

  // Generate auth token (use env var or random per-session)
  const authToken = getXumEnv("SERVER_AUTH_TOKEN") ?? randomBytes(32).toString("hex");

  // Store auth token so the API server can be restarted via Settings.
  services.serverService.setApiAuthToken(authToken);

  // Keep PATH-related recovery honest: Settings can re-check the current process view, but
  // shell/profile changes made after launch still need a full app relaunch to rerun startup PATH setup.
  services.windowService.setRestartAppHandler(() => {
    assert(app, "Electron app must be available to restart xum");
    app.relaunch();
    app.quit();
  });

  // Single router instance with auth middleware - used for both MessagePort and HTTP/WS
  const orpcRouter = router(authToken);

  const orpcHandler = new RPCHandler(orpcRouter, {
    interceptors: [
      onError((error, options) => {
        const formatted = formatOrpcError(error, options);
        console.error(formatted.message);
      }),
    ],
  });

  const orpcContext = services.toORPCContext();

  electronIpcMain.handle("mux:get-is-rosetta", async () => {
    if (process.platform !== "darwin") {
      return false;
    }

    try {
      // Intentionally lazy import to keep startup fast and avoid bundling concerns.
      // eslint-disable-next-line no-restricted-syntax -- main-process-only builtin
      const { execSync } = await import("node:child_process");
      const result = execSync("sysctl -n sysctl.proc_translated", { encoding: "utf8" }).trim();
      return result === "1";
    } catch {
      return false;
    }
  });
  electronIpcMain.handle("mux:get-is-windows-wsl-shell", async () => {
    if (process.platform !== "win32") return false;

    const normalize = (p: string) => p.replace(/\//g, "\\").toLowerCase();
    const isWslLauncher = (p: string) => {
      const base = path.win32.basename(p);
      return (
        p === "wsl" ||
        base === "wsl.exe" ||
        p === "bash" ||
        p === "bash.exe" ||
        p.endsWith("\\windows\\system32\\bash.exe")
      );
    };

    // Check if the default shell appears to be WSL.
    let looksLikeWsl = false;

    const envShell = process.env.SHELL?.trim();
    if (envShell && isWslLauncher(normalize(envShell))) {
      looksLikeWsl = true;
    } else {
      try {
        // Intentionally lazy import to keep startup fast and avoid bundling concerns.
        // eslint-disable-next-line no-restricted-syntax -- main-process-only builtin
        const { execSync } = await import("node:child_process");
        const result = execSync("where bash", {
          encoding: "utf8",
          stdio: ["pipe", "pipe", "ignore"],
          windowsHide: true,
        });
        const firstPath = result
          .split(/\r?\n/)
          .map((line) => line.trim())
          .find((line) => line.length > 0);

        looksLikeWsl = firstPath ? isWslLauncher(normalize(firstPath)) : false;
      } catch {
        // Ignore
      }
    }

    // Even if WSL is the default, don't warn if Git for Windows bash is available
    // (Xum will use that instead).
    if (looksLikeWsl && isBashAvailable()) {
      return false;
    }

    return looksLikeWsl;
  });

  electronIpcMain.on("start-orpc-server", (event) => {
    // SECURITY AUDIT: only registered local main frames can receive the local bearer credential.
    if (!isLocalIpcSender(event)) {
      for (const port of event.ports) port.close();
      return;
    }
    const [serverPort] = event.ports;
    if (!serverPort) return;
    // Use Object.defineProperties to copy all property descriptors from
    // orpcContext as own-properties (required by oRPC's internal property
    // enumeration) while preserving any getters that must resolve lazily
    // rather than being snapshotted at construction.
    const messagePortContext = Object.defineProperties(
      {} as typeof orpcContext & { headers: { authorization: string } },
      {
        ...Object.getOwnPropertyDescriptors(orpcContext),
        headers: {
          value: { authorization: `Bearer ${authToken}` },
          enumerable: true,
          configurable: true,
          writable: true,
        },
      }
    );

    orpcHandler.upgrade(serverPort, {
      context: messagePortContext,
    });
    serverPort.start();
  });

  // Start HTTP/WS API server for CLI access (unless explicitly disabled)
  if (getXumEnv("NO_API_SERVER") !== "1") {
    const lockfile = new ServerLockfile(config.rootDir);
    const existing = await lockfile.read();

    if (existing) {
      console.log(`[${timestamp()}] API server already running at ${existing.baseUrl}, skipping`);
    } else {
      try {
        const loadedConfig = config.loadConfigOrDefault();
        const configuredBindHost =
          typeof loadedConfig.apiServerBindHost === "string" &&
          loadedConfig.apiServerBindHost.trim()
            ? loadedConfig.apiServerBindHost.trim()
            : undefined;
        const serveStatic = loadedConfig.apiServerServeWebUi === true;
        const configuredPort = loadedConfig.apiServerPort;

        const envServerPort = getXumEnv("SERVER_PORT");
        const envPortRaw = envServerPort ? Number.parseInt(envServerPort, 10) : undefined;
        const envPort =
          envPortRaw !== undefined && Number.isFinite(envPortRaw) ? envPortRaw : undefined;

        const port = envPort ?? configuredPort ?? 0;
        const host = configuredBindHost ?? "127.0.0.1";

        const serverInfo = await services.serverService.startServer({
          xumHome: config.rootDir,
          context: orpcContext,
          router: orpcRouter,
          authToken,
          host,
          serveStatic,
          port,
        });
        console.log(`[${timestamp()}] API server started at ${serverInfo.baseUrl}`);
      } catch (error) {
        console.error(`[${timestamp()}] Failed to start API server:`, error);
        // Non-fatal - continue without API server
      }
    }
  }

  // Set TerminalWindowManager for desktop mode (pop-out terminal windows)
  const terminalWindowManager = new TerminalWindowManagerClass(config, (options) =>
    createLocalWindow(options, "terminal.html")
  );
  services.setProjectDirectoryPicker(async (initialPath) => {
    const win = BrowserWindow.getFocusedWindow();
    if (!win) return null;

    // If the caller provided an existing directory, seed the picker there so the
    // user starts inside (or alongside) the path they already typed/selected.
    let defaultPath: string | undefined;
    if (initialPath && initialPath.trim().length > 0) {
      try {
        const stat = await fsPromises.stat(initialPath);
        if (stat.isDirectory()) {
          defaultPath = initialPath;
        }
      } catch {
        // Path doesn't exist or isn't accessible — let Electron pick a default.
      }
    }

    const res = await dialog.showOpenDialog(win, {
      // Hide hidden entries so the new-project picker stays focused on visible folders.
      properties: ["openDirectory", "createDirectory"],
      title: "Select Project Directory",
      buttonLabel: "Select Project",
      defaultPath,
    });

    return res.canceled || res.filePaths.length === 0 ? null : res.filePaths[0];
  });

  services.setDesktopWindowManager(
    new DesktopWindowManager(
      (options) => createLocalWindow(options, "desktop.html"),
      app.isPackaged
    )
  );
  services.setTerminalWindowManager(terminalWindowManager);

  loadTokenizerModules().catch((error) => {
    console.error("Failed to preload tokenizer modules:", error);
  });

  // Initialize updater service in packaged builds or when DEBUG_UPDATER is set
  // Moved to UpdateService (services.updateService)

  const loadTime = Date.now() - startTime;
  console.log(`[${timestamp()}] Services loaded in ${loadTime}ms`);
}

function createWindow() {
  assert(services, "Services must be loaded before creating window");

  mainWindowFinishedLoading = false;

  const useDevServer = (isE2ETest && !forceDistLoad) || (!app.isPackaged && !forceDistLoad);
  const devHost = getXumEnv("DEVSERVER_HOST") ?? "127.0.0.1";
  const devServerUrl = `http://${devHost}:${devServerPort}`;
  let devServerRetryTimeout: ReturnType<typeof setTimeout> | null = null;
  let devServerRetryAttempt = 0;

  const clearDevServerRetry = (): void => {
    if (devServerRetryTimeout !== null) {
      clearTimeout(devServerRetryTimeout);
      devServerRetryTimeout = null;
    }
  };

  const loadFromDevServer = (): void => {
    console.log(`[${timestamp()}] [window] Loading from dev server: ${devServerUrl}`);
    void mainWindow?.loadURL(devServerUrl);
  };

  // `make start` rebuilds the desktop entrypoints before launching Electron, which can briefly
  // interrupt an already-running Vite server. Keep retrying so Electron still latches on.
  const scheduleDevServerReload = (): void => {
    if (
      !useDevServer ||
      mainWindow == null ||
      mainWindow.isDestroyed() ||
      devServerRetryTimeout !== null
    ) {
      return;
    }

    const delayMs = Math.min(1000, 250 * 2 ** devServerRetryAttempt);
    devServerRetryAttempt += 1;
    console.warn(
      `[${timestamp()}] [window] Dev server unavailable, retrying in ${delayMs}ms: ${devServerUrl}`
    );

    devServerRetryTimeout = setTimeout(() => {
      devServerRetryTimeout = null;
      if (mainWindow == null || mainWindow.isDestroyed()) {
        return;
      }
      loadFromDevServer();
    }, delayMs);
  };

  // Calculate default window size (80% of screen)
  const primaryDisplay = screen.getPrimaryDisplay();
  const { width: screenWidth, height: screenHeight } = primaryDisplay.workArea;

  // Load saved window state with fallback to defaults
  const windowState = windowStateKeeper({
    defaultWidth: Math.max(1200, Math.floor(screenWidth * 0.8)),
    defaultHeight: Math.max(800, Math.floor(screenHeight * 0.8)),
  });

  console.log(`[${timestamp()}] [window] Creating BrowserWindow...`);

  mainWindow = createLocalWindow({
    x: windowState.x,
    y: windowState.y,
    width: windowState.width,
    height: windowState.height,
    backgroundColor: "#0a0a0b",
    webPreferences: {
      nodeIntegration: false,
      contextIsolation: true,
      preload: path.join(__dirname, "../preload.js"),
      // Disable the native spellchecker: xum is a coding tool where inputs are
      // full of code, paths, and identifiers that trigger noisy red squiggles.
      spellcheck: false,
    },
    title: XUM_PRODUCT_DESCRIPTION,
    // Hide menu bar on Linux by default (like VS Code)
    // User can press Alt to toggle it
    autoHideMenuBar: process.platform === "linux",
    show: false, // Don't show until ready-to-show event
    // On Linux, explicitly set the window icon so the taskbar/window-switcher
    // shows the app icon even without desktop integration (e.g. AppImageLauncher).
    // macOS uses the .icns from the app bundle; Windows uses the .exe icon resource.
    ...(process.platform === "linux" ? { icon: path.join(__dirname, "../icon.png") } : {}),
    // VSCode-like integrated titlebar (hidden native titlebar with native window controls)
    ...getTitleBarOptions(),
  });

  // Track window state (handles resize, move, maximize, fullscreen)
  windowState.manage(mainWindow);

  // Register window service with the main window
  console.log(`[${timestamp()}] [window] Registering window service...`);
  services.windowService.setMainWindow(mainWindow);

  mainWindow.on("close", (event) => {
    // Close-to-tray behavior: when the user closes the main window, keep xum
    // running in the tray/menu bar so it can be re-opened from there.
    //
    // Only hide when the tray exists to avoid trapping the user with no UI path
    // to restore the app.
    if (isQuitting || isUpdateInstallInProgress() || !tray) {
      return;
    }

    if (latestUpdateStatus.type === "downloaded") {
      // If an update is ready, prompt before hiding to tray so users can install immediately.
      event.preventDefault();

      if (isUpdateClosePromptOpen) {
        return;
      }

      isUpdateClosePromptOpen = true;
      const messageBoxOptions: MessageBoxOptions = {
        type: "question",
        buttons: ["Install & restart", "Later", "Cancel"],
        defaultId: 0,
        cancelId: 2,
        message: "An update is ready to install.",
        detail: "Install now to restart and apply the update, or keep Xum running in the tray.",
      };

      const promptWindow = mainWindow;
      const prompt = promptWindow
        ? dialog.showMessageBox(promptWindow, messageBoxOptions)
        : dialog.showMessageBox(messageBoxOptions);

      void prompt
        .then(({ response }) => {
          if (response === 0) {
            return services?.updateService.install();
          }

          if (response === 1) {
            mainWindow?.hide();
          }
        })
        .finally(() => {
          isUpdateClosePromptOpen = false;
        });
      return;
    }

    event.preventDefault();
    mainWindow?.hide();
  });

  // Show window once it's ready and close splash
  console.time("main window startup");
  mainWindow.once("ready-to-show", () => {
    console.log(`[${timestamp()}] Main window ready to show`);
    mainWindow?.show();
    closeSplashScreen();
    console.timeEnd("main window startup");
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
  mainWindow.webContents.setWindowOpenHandler(({ url }) => {
    openExternalUrl(url);
    return { action: "deny" };
  });

  mainWindow.webContents.on("will-navigate", (event, url) => {
    const currentOrigin = new URL(mainWindow!.webContents.getURL()).origin;
    const targetOrigin = new URL(url).origin;
    // Prevent navigation away from app origin, open externally instead.
    if (targetOrigin !== currentOrigin) {
      event.preventDefault();
      openExternalUrl(url);
    }
  });

  // Load from dev server in development, built files in production
  // app.isPackaged is true when running from a built .app/.exe, false in development
  console.log(`[${timestamp()}] [window] Loading content...`);
  console.time("[window] Content load");
  if (useDevServer) {
    // Development mode: load from vite dev server
    loadFromDevServer();
    if (!isE2ETest) {
      mainWindow.webContents.once("did-finish-load", () => {
        mainWindow?.webContents.openDevTools();
      });
    }
  } else {
    // Production mode: load built files
    const htmlPath = path.join(__dirname, "../index.html");
    console.log(`[${timestamp()}] [window] Loading from file: ${htmlPath}`);
    void mainWindow.loadFile(htmlPath);
  }

  // Track when content finishes loading
  mainWindow.webContents.once("did-finish-load", () => {
    clearDevServerRetry();
    devServerRetryAttempt = 0;
    console.timeEnd("[window] Content load");
    console.log(`[${timestamp()}] [window] Content finished loading`);

    mainWindowFinishedLoading = true;
    flushBufferedXumDeepLinks();

    // NOTE: Tokenizer modules are NOT loaded at startup anymore!
    // The Proxy in tokenizer.ts loads them on-demand when first accessed.
    // This reduces startup time from ~8s to <1s.
    // First token count will use approximation, accurate count caches in background.
  });

  // Diagnostic crash hooks — log only, no recovery side effects.
  // Crash behavior is left unmodified so the root cause can be observed.
  // Uses log.* (not console.*) so entries reach the log file and Output Tab.
  mainWindow.webContents.on("render-process-gone", (_event, details) => {
    log.error("[diag] render-process-gone", {
      reason: details.reason,
      exitCode: details.exitCode,
      url: mainWindow?.webContents.getURL(),
    });
  });

  mainWindow.webContents.on(
    "did-fail-load",
    (_event, errorCode, errorDescription, validatedURL, isMainFrame) => {
      if (isMainFrame) {
        log.error("[diag] did-fail-load", {
          errorCode,
          errorDescription,
          url: validatedURL,
        });
      }

      if (
        isMainFrame &&
        useDevServer &&
        errorCode !== -3 &&
        hasSameOrigin(validatedURL, devServerUrl)
      ) {
        scheduleDevServerReload();
      }
    }
  );

  mainWindow.webContents.on("unresponsive", () => {
    log.warn("[diag] renderer unresponsive");
  });

  // Forward renderer console errors to the log service so they reach the log
  // file (~/.xum/logs/mux.log) and Output Tab even when the UI is white/blank.
  // The renderer's global error handlers (window.addEventListener("error")) log
  // to console.error, but that stays in renderer memory only — the main process
  // never sees it without this hook.
  mainWindow.webContents.on("console-message", (_event, level, message, line, sourceId) => {
    // level: 0=debug, 1=info, 2=warning, 3=error
    if (level >= 2) {
      const source = sourceId ? `${sourceId}:${line}` : undefined;
      if (level >= 3) {
        log.error("[renderer]", message, ...(source ? [{ source }] : []));
      } else {
        log.warn("[renderer]", message, ...(source ? [{ source }] : []));
      }
    }
  });

  mainWindow.on("closed", () => {
    clearDevServerRetry();
    mainWindow = null;
    mainWindowFinishedLoading = false;
  });
}

async function maybeRunAttachFileSmokeTest(): Promise<boolean> {
  const pngPath = getXumEnv("ATTACH_FILE_SMOKE_TEST_PNG_PATH")?.trim();
  const jpegPath = getXumEnv("ATTACH_FILE_SMOKE_TEST_JPEG_PATH")?.trim();
  if ((pngPath == null || pngPath.length === 0) && (jpegPath == null || jpegPath.length === 0)) {
    return false;
  }

  try {
    const { runAttachFileSmokeTest } = requireDesktopModule("./attachFileSmokeTest") as {
      runAttachFileSmokeTest: () => Promise<void>;
    };
    await runAttachFileSmokeTest();
    app.exit(0);
  } catch (error) {
    console.error("[attach-file-smoke] failed:", error);
    app.exit(1);
  }

  return true;
}

void startDesktopAfterStorage().catch((error) => {
  // Startup initialization must never crash the app.
  console.debug("[xum-transition] Failed desktop storage bootstrap:", error);
});

async function startDesktopAfterStorage(): Promise<void> {
  await initializeXumDesktopStorage();
  // Enable local crash dump collection after userData points at canonical xum storage.
  // No crash data leaves the machine.
  crashReporter.start({ uploadToServer: false });

  const gotTheLock = allowMultipleInstances || app.requestSingleInstanceLock();
  console.log("Single instance lock acquired:", gotTheLock);

  if (!gotTheLock) {
    console.log("Another instance is already running, quitting...");
    app.quit();
    return;
  }

  console.log("This is the primary instance");
  app.on("second-instance", (_event, argv) => {
    console.log("Second instance attempted to start");

    try {
      handleArgvXumDeepLinks(argv);
    } catch (error) {
      console.debug(
        "[deep-link] Failed to parse second-instance argv for xum/mux deep links:",
        error
      );
    }

    focusMainWindow();
  });

  void app.whenReady().then(async () => {
    try {
      console.log("App ready, creating window...");

      if (await maybeRunAttachFileSmokeTest()) {
        return;
      }

      registerXumProtocolClients();

      // Install React DevTools in development
      if (!app.isPackaged) {
        try {
          const { default: installExtension, REACT_DEVELOPER_TOOLS } =
            // eslint-disable-next-line no-restricted-syntax -- dev-only dependency, intentionally lazy-loaded
            await import("electron-devtools-installer");
          const extension = await installExtension(REACT_DEVELOPER_TOOLS, {
            loadExtensionOptions: { allowFileAccess: true },
          });
          console.log(`✅ React DevTools installed: ${extension.name} (id: ${extension.id})`);
        } catch (err) {
          console.log("❌ Error installing React DevTools:", err);
        }
      }

      createMenu();

      // Three-phase startup:
      // 1. Show splash immediately (<100ms) and wait for it to load
      // 2. Load services while splash visible (fast - ~100ms)
      // 3. Create window and start loading content (splash stays visible)
      // 4. When window ready-to-show: close splash, show main window
      //
      // Skip splash in E2E tests to avoid app.firstWindow() grabbing the wrong window
      if (!isE2ETest) {
        await showSplashScreen(); // Wait for splash to actually load
      }
      await loadServices();
      initializeRemoteConnections();
      createWindow();
      createTray();
      // Note: splash closes in ready-to-show event handler

      // Tokenizer modules load in background after did-finish-load event (see createWindow())
    } catch (error) {
      console.error(`[${timestamp()}] Startup failed:`, error);

      closeSplashScreen();

      // Show error dialog to user
      const errorMessage =
        error instanceof Error ? `${error.message}\n\n${error.stack ?? ""}` : String(error);

      dialog.showErrorBox(
        "Startup Failed",
        `The application failed to start:\n\n${errorMessage}\n\nPlease check the console for details.`
      );

      // Quit after showing error
      app.quit();
    }
  });

  // Track if we're in the middle of disposing to prevent re-entry
  let isDisposing = false;

  app.on("before-quit", (event) => {
    // Ensure window close handlers don't block an explicit quit.
    // IMPORTANT: must be set before any early returns.
    isQuitting = true;
    remoteConnectionManager?.dispose();
    if (isUpdateInstallInProgress()) {
      // Don't block updater-driven quitAndInstall() — let Electron quit immediately
      // so the platform installer can take over. Best-effort cleanup only.
      if (services && !isDisposing) {
        isDisposing = true;
        void services.dispose().catch((err) => {
          console.error("Error during ServiceContainer dispose (update install):", err);
        });
      }
      return;
    }

    // Skip if already disposing or no services to clean up
    if (isDisposing || !services) {
      return;
    }

    // Prevent quit, clean up, then quit again
    event.preventDefault();
    isDisposing = true;

    // Race dispose against timeout to ensure app quits even if disposal hangs
    const disposePromise = services.dispose().catch((err) => {
      console.error("Error during ServiceContainer dispose:", err);
    });
    const timeoutPromise = new Promise<void>((resolve) => setTimeout(resolve, 5000));

    void Promise.race([disposePromise, timeoutPromise]).finally(() => {
      app.quit();
    });
  });

  app.on("child-process-gone", (_event, details) => {
    if (details.type === "GPU") {
      log.error(
        `[window] GPU process gone: reason=${details.reason}, exitCode=${details.exitCode}`
      );
    }
  });

  app.on("window-all-closed", () => {
    if (process.platform !== "darwin") {
      app.quit();
    }
  });

  app.on("before-quit", () => {
    console.log(`[${timestamp()}] App before-quit - cleaning up...`);
    if (services) {
      void services.serverService.stopServer();
      void services.shutdown();
    }
  });

  app.on("activate", () => {
    // Skip splash on reactivation - services already loaded, window creation is fast.
    // Clicking the Dock icon should also re-open the existing window if it was
    // hidden by close-to-tray.
    // Guard: services must be loaded (prevents race if activate fires during startup).
    if (app.isReady() && services) {
      openXumFromTray();
    }
  });
}

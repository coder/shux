import assert from "node:assert/strict";
import { writeFile } from "node:fs/promises";
import { Config } from "../../../src/node/config";
import {
  test as browserTest,
  type BrowserContext,
  type Page,
  type TestInfo,
} from "@playwright/test";
import { electronTest as test, electronExpect as expect } from "../electronTest";

type HandoffEvent = { type: "send"; bytes: number[] } | { type: "disconnect" | "connect" };

interface DesktopRecoveryProbe {
  events: HandoffEvent[];
  releaseBringBack?: () => void;
}

type RecoveryProbeWindow = Window & {
  __desktopReadyDropped?: boolean;
  __desktopRecoveryProbe?: DesktopRecoveryProbe;
};

interface KeyEvent {
  keysym: number;
  down: boolean;
}
interface Connection {
  keys: KeyEvent[];
  pointerMasks: number[];
  closed: boolean;
}

function readKeyEvent(bytes: Uint8Array): KeyEvent | undefined {
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  if (bytes.length === 8 && bytes[0] === 4) {
    return { keysym: view.getUint32(4), down: bytes[1] !== 0 };
  }
  if (bytes.length === 12 && bytes[0] === 255 && bytes[1] === 0) {
    return { keysym: view.getUint32(4), down: view.getUint16(2) !== 0 };
  }
  return undefined;
}

function observeDesktopConnections(page: Page): Connection[] {
  const connections: Connection[] = [];
  page.on("websocket", (socket) => {
    if (!new URL(socket.url()).pathname.endsWith("/desktop/ws")) return;
    const connection: Connection = { keys: [], pointerMasks: [], closed: false };
    connections.push(connection);
    socket.on("close", () => {
      connection.closed = true;
    });
    // noVNC flushes each RFB key message separately. Accept both ordinary RFB
    // and QEMU extended key events, depending on the real server's negotiation.
    socket.on("framesent", ({ payload }) => {
      const bytes = Buffer.isBuffer(payload) ? payload : Buffer.from(payload);
      if ((bytes.length === 6 || bytes.length === 7) && bytes[0] === 5) {
        connection.pointerMasks.push(bytes[1] & 0x7f);
      }
      const key = readKeyEvent(bytes);
      if (key) connection.keys.push(key);
    });
  });
  return connections;
}

async function enableRealDesktop(page: Page, workspaceId: string) {
  await page.waitForFunction(() => Boolean(window.__ORPC_CLIENT__));
  const capability = await page.evaluate(async (id) => {
    const api = window.__ORPC_CLIENT__;
    if (!api) throw new Error("E2E API client not initialized");
    await api.experiments.setOverride({ experimentId: "portable-desktop", enabled: true });
    return api.desktop.getCapability({ workspaceId: id });
  }, workspaceId);
  if (!capability.available) {
    // Startup failures on an installed runtime must fail, not silently skip regressions.
    expect(capability.reason).not.toBe("startup_failed");
    test.skip(true, `Real PortableDesktop unavailable: ${capability.reason}`);
  }
  // Experiment subscriptions are refreshed on app startup.
  await page.reload();
}

const viewport = (page: Page) => page.locator("[data-desktop-viewport] canvas");

async function expectConnectedViewOnly(page: Page) {
  await expect(viewport(page)).toBeVisible({ timeout: 30_000 });
  await expect(page.getByRole("button", { name: "Take control", exact: true })).toBeEnabled();
  await expect(page.getByRole("button", { name: "Take control", exact: true })).toHaveAttribute(
    "aria-pressed",
    "false"
  );
}

async function screenshot(page: Page, testInfo: TestInfo, name: string) {
  // RFB's connect event precedes its first framebuffer update; a visible canvas
  // alone can still produce an empty screenshot of an otherwise healthy viewer.
  await expect
    .poll(
      () =>
        viewport(page).evaluate((canvas: HTMLCanvasElement) => {
          if (canvas.width === 0 || canvas.height === 0) return false;
          const pixel = canvas
            .getContext("2d")
            ?.getImageData(Math.floor(canvas.width / 2), Math.floor(canvas.height / 2), 1, 1);
          return (pixel?.data[3] ?? 0) > 0;
        }),
      { message: `${name}: waiting for a decoded desktop framebuffer`, timeout: 30_000 }
    )
    .toBe(true);
  const path = testInfo.outputPath(`${name}.png`);
  await page.screenshot({ path });
  await testInfo.attach(name, { path, contentType: "image/png" });
}

type DesktopCloseEvent =
  | HandoffEvent
  | { type: "socket-closed"; clean: boolean; code: number }
  | { type: "window-close" };
type DesktopCloseProbeWindow = Window & { __desktopCloseEvents?: DesktopCloseEvent[] };

async function observePopoutCleanup(context: BrowserContext, page: Page) {
  const channelName = `desktop-e2e-close:${crypto.randomUUID()}`;
  await page.evaluate((name) => {
    const events: DesktopCloseEvent[] = [];
    (window as DesktopCloseProbeWindow).__desktopCloseEvents = events;
    const observer = new BroadcastChannel(name);
    observer.onmessage = (event: MessageEvent<DesktopCloseEvent>) => events.push(event.data);
  }, channelName);
  await context.addInitScript((name) => {
    // Browser popup init can precede its desktop URL; filter sockets, not the initial page URL.
    const observer = new BroadcastChannel(name);
    const openerEvents = (window.opener as DesktopCloseProbeWindow | null)?.__desktopCloseEvents;
    const record = (event: DesktopCloseEvent) => {
      // A browser popup can disappear before its final DevTools events arrive;
      // retain synchronous observations in the same-origin opener that survives it.
      if (openerEvents) openerEvents.push(event);
      else observer.postMessage(event);
    };
    const NativeWebSocket = window.WebSocket;
    // Observe the real socket before noVNC's close listener; Playwright can lose
    // final frame/close notifications once Electron destroys the child target.
    window.WebSocket = new Proxy(NativeWebSocket, {
      construct(target, args, newTarget) {
        const socket = Reflect.construct(target, args, newTarget) as WebSocket;
        if (new URL(socket.url).pathname.endsWith("/desktop/ws")) {
          socket.addEventListener("close", (event) =>
            record({
              type: "socket-closed",
              clean: event.wasClean,
              code: event.code,
            })
          );
        }
        return socket;
      },
    });
    const send = NativeWebSocket.prototype.send;
    NativeWebSocket.prototype.send = function (data) {
      send.call(this, data);
      if (!new URL(this.url).pathname.endsWith("/desktop/ws")) return;
      if (typeof data === "string" || data instanceof Blob) return;
      const bytes = ArrayBuffer.isView(data)
        ? new Uint8Array(data.buffer, data.byteOffset, data.byteLength)
        : new Uint8Array(data);
      record({ type: "send", bytes: Array.from(bytes) });
    };
    const close = NativeWebSocket.prototype.close;
    NativeWebSocket.prototype.close = function (...args) {
      if (new URL(this.url).pathname.endsWith("/desktop/ws")) record({ type: "disconnect" });
      close.apply(this, args);
    };
    const closeWindow = window.close.bind(window);
    window.close = () => {
      record({ type: "window-close" });
      closeWindow();
    };
  }, channelName);
  return () => page.evaluate(() => (window as DesktopCloseProbeWindow).__desktopCloseEvents ?? []);
}

async function holdDesktopInput(child: Page, readEvents: () => Promise<DesktopCloseEvent[]>) {
  await child.getByRole("button", { name: "Take control", exact: true }).click();
  await viewport(child).click();
  await child.keyboard.down("Shift");
  await child.mouse.down();
  await expect
    .poll(async () =>
      (await readEvents()).some((event) => {
        if (event.type !== "send") return false;
        const key = readKeyEvent(new Uint8Array(event.bytes));
        return key?.keysym === 0xffe1 && key.down;
      })
    )
    .toBe(true);
  await expect
    .poll(async () => {
      const pointer = (await readEvents()).findLast(
        (event) => event.type === "send" && event.bytes[0] === 5
      );
      return pointer?.type === "send" ? pointer.bytes[1] : undefined;
    })
    .toBe(1);
}

function expectReleasedBeforeDisconnect(events: DesktopCloseEvent[]) {
  const keyUp = events.findIndex((event) => {
    if (event.type !== "send") return false;
    const key = readKeyEvent(new Uint8Array(event.bytes));
    return key?.keysym === 0xffe1 && !key.down;
  });
  // Ignore the earlier focus click: only release after the final held press counts.
  const pointerDown = events.findLastIndex(
    (event) => event.type === "send" && event.bytes[0] === 5 && event.bytes[1] === 1
  );
  const pointerUp = events.findIndex(
    (event, index) =>
      index > pointerDown && event.type === "send" && event.bytes[0] === 5 && event.bytes[1] === 0
  );
  const disconnect = events.findIndex((event) => event.type === "disconnect");
  const socketClosed = events.findIndex((event) => event.type === "socket-closed");
  expect(keyUp).toBeGreaterThanOrEqual(0);
  expect(pointerUp).toBeGreaterThan(pointerDown);
  expect(disconnect).toBeGreaterThan(Math.max(keyUp, pointerUp));
  expect(socketClosed).toBeGreaterThan(disconnect);
  expect(events[socketClosed]).toEqual({ type: "socket-closed", clean: true, code: 1005 });
}

function expectReleasedBeforeClose(events: DesktopCloseEvent[]) {
  expectReleasedBeforeDisconnect(events);
  expect(events.findIndex((event) => event.type === "window-close")).toBeGreaterThan(
    events.findIndex((event) => event.type === "socket-closed")
  );
}

test.describe("Electron desktop", () => {
  // No VNC stubs: these scenarios require a real PortableDesktop installation and a
  // display for Electron (e.g. xvfb-run). Missing prerequisites are skips, not passes.
  test.skip(({ browserName }) => browserName !== "chromium", "Electron requires Chromium");
  test.skip(process.platform !== "linux", "Portable Desktop is currently enabled on Linux only");
  test.skip(!process.env.DISPLAY, "Electron desktop E2E requires DISPLAY (run under xvfb-run)");

  test("real VNC is view-only until opted in, releases modifiers, and zoom does not reconnect", async ({
    app,
    page,
    ui,
    workspace,
  }, testInfo) => {
    await enableRealDesktop(page, workspace.demoProject.workspaceId);
    await ui.projects.openFirstWorkspace();
    const connections = observeDesktopConnections(page);
    await ui.metaSidebar.selectTab("Desktop");
    await expectConnectedViewOnly(page);
    expect(connections).toHaveLength(1);
    const connection = connections[0];
    assert(connection);
    const canvas = viewport(page);
    const geometry = await canvas.evaluate((element: HTMLCanvasElement) => ({
      width: element.width,
      height: element.height,
    }));

    await canvas.click();
    await page.keyboard.press("a");
    await page.getByRole("button", { name: "Zoom to 100%", exact: true }).click();
    await expect(page.getByRole("button", { name: "Zoom to fit", exact: true })).toBeVisible();
    expect(await canvas.evaluate((element) => element.getBoundingClientRect().width)).toBe(
      geometry.width
    );
    expect(await canvas.evaluate((element) => element.getBoundingClientRect().height)).toBe(
      geometry.height
    );
    const screen = canvas.locator("..");
    expect(await screen.evaluate((element) => element.scrollWidth > element.clientWidth)).toBe(
      true
    );
    await screen.evaluate((element) => {
      element.scrollLeft = 80;
    });
    expect(await screen.evaluate((element) => element.scrollLeft)).toBeGreaterThan(0);
    await screen.evaluate((element) => {
      element.scrollLeft = 0;
    });
    await canvas.hover({ position: { x: 40, y: 40 } });
    await page.mouse.wheel(160, 0);
    await expect.poll(() => screen.evaluate((element) => element.scrollLeft)).toBeGreaterThan(0);
    await screenshot(page, testInfo, "native-one-to-one-scrolled");
    await page.getByRole("button", { name: "Zoom to fit", exact: true }).click();
    expect(
      await canvas.evaluate((element: HTMLCanvasElement) => ({
        width: element.width,
        height: element.height,
      }))
    ).toEqual(geometry);
    expect(connection.keys).toEqual([]);
    expect(connection.closed).toBe(false);
    expect(connections).toHaveLength(1);

    await page.getByRole("button", { name: "Take control", exact: true }).click();
    await canvas.click();
    await expect(page.getByRole("button", { name: "Release control", exact: true })).toBeVisible();
    const modifiers = [
      { key: "Shift", keysym: 0xffe1 },
      { key: "Control", keysym: 0xffe3 },
    ];
    for (const modifier of modifiers) {
      await page.keyboard.down(modifier.key);
      await expect
        .poll(() => connection.keys.some((key) => key.keysym === modifier.keysym && key.down))
        .toBe(true);
    }
    await page.getByRole("button", { name: "Release control", exact: true }).click();
    for (const modifier of modifiers) {
      await expect
        .poll(() => connection.keys.some((key) => key.keysym === modifier.keysym && !key.down))
        .toBe(true);
      await page.keyboard.up(modifier.key);
    }
    await expectConnectedViewOnly(page);

    await page.getByRole("button", { name: "Take control", exact: true }).click();
    await canvas.hover();
    await page.mouse.down();
    await expect.poll(() => connection.pointerMasks.at(-1)).toBe(1);
    // Disable Playwright's per-renderer focus emulation so a real second native
    // window can exercise window-blur release instead of leaving every page focused.
    const nativeFocus = await page.context().newCDPSession(page);
    await nativeFocus.send("Emulation.setFocusEmulationEnabled", { enabled: false });
    const otherWindow = await app.evaluateHandle(
      ({ BrowserWindow }) => new BrowserWindow({ show: false, width: 300, height: 200 })
    );
    try {
      await otherWindow.evaluate(async (window) => {
        await window.loadURL("about:blank");
        window.show();
        window.focus();
      });
      await expect.poll(() => page.evaluate(() => document.hasFocus())).toBe(false);
      await expect.poll(() => connection.pointerMasks.at(-1)).toBe(0);
    } finally {
      await page.mouse.up();
      await otherWindow.evaluate((window) => window.destroy());
      await otherWindow.dispose();
      await nativeFocus.send("Emulation.setFocusEmulationEnabled", { enabled: true });
      await nativeFocus.detach();
    }
    await page.bringToFront();
    await expectConnectedViewOnly(page);
    await screenshot(page, testInfo, "inline-view-only-after-release");
  });

  test("real Electron popout survives remount and returns one view-only connection on bring-back or close", async ({
    app,
    page,
    ui,
    workspace,
  }, testInfo) => {
    await enableRealDesktop(page, workspace.demoProject.workspaceId);
    await ui.projects.openFirstWorkspace();
    const inlineConnections = observeDesktopConnections(page);
    await ui.metaSidebar.selectTab("Desktop");
    await expectConnectedViewOnly(page);
    const originalConnection = inlineConnections[0];
    assert(originalConnection);
    const existingWindows = app.windows().length;
    await page.getByRole("button", { name: "Take control", exact: true }).click();
    await viewport(page).hover();
    await page.mouse.down();
    await expect.poll(() => originalConnection.pointerMasks.at(-1)).toBe(1);

    const childReady = app.waitForEvent("window");
    // Keyboard activation preserves the held mouse button until disconnect releases it.
    await page.getByRole("button", { name: "Detach", exact: true }).focus();
    await page.keyboard.press("Enter");
    const child = await childReady;
    await expectConnectedViewOnly(child);
    await expect(viewport(page)).toHaveCount(0);
    await expect.poll(() => originalConnection.closed).toBe(true);
    expect(originalConnection.pointerMasks.at(-1)).toBe(0);
    await page.mouse.up();
    expect(app.windows()).toHaveLength(existingWindows + 1);
    await screenshot(child, testInfo, "real-detached-desktop");
    await child.setViewportSize({ width: 375, height: 812 });
    const toolbar = child.getByRole("toolbar", { name: "Desktop controls" });
    await expect(toolbar).toBeVisible();
    expect(await toolbar.evaluate((element) => element.scrollWidth <= element.clientWidth)).toBe(
      true
    );
    await screenshot(child, testInfo, "narrow-desktop-controls");
    await child.setViewportSize({ width: 1100, height: 800 });

    await ui.metaSidebar.selectTab("Stats");
    await ui.metaSidebar.selectTab("Desktop");
    await expect(page.getByRole("button", { name: "Bring back", exact: true })).toBeVisible();
    await expect(viewport(page)).toHaveCount(0);
    expect(inlineConnections).toHaveLength(1);
    expect(app.windows()).toHaveLength(existingWindows + 1);

    const childClosed = child.waitForEvent("close");
    await child.getByRole("button", { name: "Bring back", exact: true }).click();
    await childClosed;
    await expectConnectedViewOnly(page);
    expect(inlineConnections).toHaveLength(2);
    await screenshot(page, testInfo, "inline-after-bring-back");

    const readEvents = await observePopoutCleanup(app.context(), page);
    const nextChildReady = app.waitForEvent("window");
    await page.getByRole("button", { name: "Detach", exact: true }).click();
    const nextChild = await nextChildReady;
    await expectConnectedViewOnly(nextChild);
    const nativeWindow = await app.browserWindow(nextChild);
    const forced = await nativeWindow.evaluateHandle((window) => {
      const observation = { calls: 0 };
      const destroy = window.destroy.bind(window);
      window.destroy = () => {
        observation.calls += 1;
        destroy();
      };
      return observation;
    });
    await holdDesktopInput(nextChild, readEvents);
    await screenshot(nextChild, testInfo, "held-input-before-native-close");
    const nextClosed = nextChild.waitForEvent("close");
    // BrowserWindow.close() follows the titlebar path, not the Bring back protocol.
    await nativeWindow.evaluate((window) => window.close());
    await nextClosed;
    await expect
      .poll(async () => (await readEvents()).some((event) => event.type === "window-close"))
      .toBe(true);
    const events = await readEvents();
    expectReleasedBeforeClose(events);
    const forceDestroyCalls = await forced.evaluate((observation) => observation.calls);
    expect(forceDestroyCalls).toBe(0);
    const wirePath = testInfo.outputPath("native-close-wire.json");
    await writeFile(wirePath, JSON.stringify({ events, forceDestroyCalls }, null, 2));
    await testInfo.attach("native-close-wire", { path: wirePath, contentType: "application/json" });
    await forced.dispose();
    await nativeWindow.dispose();
    await page.bringToFront();
    await expectConnectedViewOnly(page);
    expect(inlineConnections).toHaveLength(3);
    expect(inlineConnections.filter((connection) => !connection.closed)).toHaveLength(1);
    expect(app.windows()).toHaveLength(existingWindows);
    await screenshot(page, testInfo, "inline-after-native-close");
  });

  test("removing a shared borrower releases held input before closing its popout and preserves the owner", async ({
    app,
    page,
    ui,
    workspace,
  }, testInfo) => {
    const ownerId = workspace.demoProject.workspaceId;
    await enableRealDesktop(page, ownerId);
    await page.waitForFunction(() => Boolean(window.__ORPC_CLIENT__));
    const borrower = await page.evaluate(async (projectPath) => {
      const api = window.__ORPC_CLIENT__;
      if (!api) throw new Error("E2E API client not initialized");
      await api.projects.setTrust({ projectPath, trusted: true });
      const result = await api.workspace.create({
        projectPath,
        branchName: "desktop-borrower",
        runtimeConfig: { type: "local" },
      });
      if (!result.success) throw new Error(result.error);
      return result.metadata;
    }, workspace.demoProject.projectPath);
    // Seed the real shared-task binding without launching an unrelated LLM turn.
    await new Config(workspace.configRoot).editConfig((config) => {
      const entry = config.projects
        .get(workspace.demoProject.projectPath)
        ?.workspaces.find((item) => item.id === borrower.id);
      assert(entry, "Created borrower must be registered");
      entry.parentWorkspaceId = ownerId;
      entry.taskDesktopOwnerWorkspaceId = ownerId;
      return config;
    });
    await page.reload();
    await ui.projects.openFirstWorkspace();
    await page.keyboard.press("F4");
    await page.getByRole("combobox", { name: "Command palette" }).fill(borrower.name);
    await page.getByRole("option", { name: borrower.title ?? borrower.name, exact: true }).click();
    await ui.metaSidebar.selectTab("Desktop");
    await expectConnectedViewOnly(page);
    const capability = await page.evaluate(async (workspaceId) => {
      const api = window.__ORPC_CLIENT__;
      if (!api) throw new Error("E2E API client not initialized");
      return api.desktop.getCapability({ workspaceId });
    }, borrower.id);
    assert(capability.available);
    expect(capability.sharedDesktop?.ownerWorkspaceId).toBe(ownerId);

    const readEvents = await observePopoutCleanup(app.context(), page);
    const opening = app.waitForEvent("window");
    await page.getByRole("button", { name: "Detach", exact: true }).click();
    const child = await opening;
    await expectConnectedViewOnly(child);
    const nativeChild = await app.browserWindow(child);
    const forced = await nativeChild.evaluateHandle((window) => {
      const observation = { calls: 0 };
      const destroy = window.destroy.bind(window);
      window.destroy = () => {
        observation.calls += 1;
        destroy();
      };
      return observation;
    });

    // Keep an owner connection alive throughout removal: a restarted owner session
    // or owner-scoped bridge revocation must fail, not be hidden by reconnection.
    const ownerConnections = observeDesktopConnections(page);
    await page.locator(`[data-workspace-id="${ownerId}"][role="button"]`).click();
    await ui.metaSidebar.selectTab("Desktop");
    await expectConnectedViewOnly(page);
    expect(ownerConnections).toHaveLength(1);
    const ownerConnection = ownerConnections[0];
    assert(ownerConnection);
    await page.keyboard.press("Control+Shift+P");
    await page.getByRole("combobox", { name: "Command palette" }).fill(">Remove Workspace");
    await page.getByRole("option", { name: "Remove Workspace…", exact: true }).click();
    await page.getByRole("combobox", { name: "Select workspace" }).fill(borrower.name);
    await page.getByRole("option", { name: `demo-repo/${borrower.name}`, exact: true }).click();
    const confirmation = page.getByRole("dialog", {
      name: `Remove workspace demo-repo/${borrower.name}?`,
    });
    await expect(confirmation).toBeVisible();

    await holdDesktopInput(child, readEvents);
    await screenshot(child, testInfo, "shared-borrower-held-input-before-removal");
    const closed = child.waitForEvent("close");
    await confirmation.getByRole("button", { name: "Remove", exact: true }).click();
    await closed;
    await expect
      .poll(() =>
        page.evaluate(async (workspaceId) => {
          const api = window.__ORPC_CLIENT__;
          if (!api) throw new Error("E2E API client not initialized");
          return (await api.workspace.list()).some((entry) => entry.id === workspaceId);
        }, borrower.id)
      )
      .toBe(false);
    await expect
      .poll(async () => (await readEvents()).some((event) => event.type === "window-close"))
      .toBe(true);
    const events = await readEvents();
    expectReleasedBeforeClose(events);
    const forceDestroyCalls = await forced.evaluate((observation) => observation.calls);
    expect(forceDestroyCalls).toBe(0);
    expect(ownerConnection.closed).toBe(false);
    expect(ownerConnections).toHaveLength(1);
    await expectConnectedViewOnly(page);
    await page.getByRole("button", { name: "Take control", exact: true }).click();
    await viewport(page).click();
    await page.keyboard.press("a");
    await expect
      .poll(() => ownerConnection.keys.some((key) => key.keysym === 0x61 && key.down))
      .toBe(true);
    await page.getByRole("button", { name: "Release control", exact: true }).click();
    await screenshot(page, testInfo, "shared-owner-alive-after-borrower-removal");
    const wirePath = testInfo.outputPath("borrower-removal-wire.json");
    await writeFile(
      wirePath,
      JSON.stringify(
        { events, forceDestroyCalls, ownerConnected: !ownerConnection.closed },
        null,
        2
      )
    );
    await testInfo.attach("borrower-removal-wire", {
      path: wirePath,
      contentType: "application/json",
    });
    await forced.dispose();
    await nativeChild.dispose();
  });

  test("Electron reload recovers a lost ready and Reconnect here waits for responsive input release", async ({
    app,
    page,
    ui,
    workspace,
  }, testInfo) => {
    await enableRealDesktop(page, workspace.demoProject.workspaceId);
    await ui.projects.openFirstWorkspace();
    const inlineConnections = observeDesktopConnections(page);
    await ui.metaSidebar.selectTab("Desktop");
    await expectConnectedViewOnly(page);

    // Lose only the readiness packet; the real child, manager, and VNC transport remain intact.
    await app.context().addInitScript(() => {
      if (!window.location.pathname.endsWith("/desktop.html")) return;
      const send = BroadcastChannel.prototype.postMessage;
      BroadcastChannel.prototype.postMessage = function (message: unknown) {
        const target = window as RecoveryProbeWindow;
        if (
          !target.__desktopReadyDropped &&
          typeof message === "object" &&
          message !== null &&
          "type" in message &&
          message.type === "ready"
        ) {
          target.__desktopReadyDropped = true;
          return;
        }
        send.call(this, message);
      };
    });
    const opening = app.waitForEvent("window");
    await page.getByRole("button", { name: "Detach", exact: true }).click();
    const child = await opening;
    const childConnections = observeDesktopConnections(child);
    await child.waitForFunction(() => (window as RecoveryProbeWindow).__desktopReadyDropped);
    await expect(viewport(child)).toHaveCount(0);
    expect(childConnections).toHaveLength(0);

    await page.reload();
    await ui.projects.openFirstWorkspace();
    await ui.metaSidebar.selectTab("Desktop");
    await expectConnectedViewOnly(child);
    await expect(viewport(page)).toHaveCount(0);
    expect(childConnections).toHaveLength(1);
    expect(inlineConnections).toHaveLength(1);
    await screenshot(child, testInfo, "electron-lost-ready-recovered-after-parent-reload");

    const nativeChild = await app.browserWindow(child);
    const forceDestroy = await nativeChild.evaluateHandle((window) => {
      const observation = { calls: 0 };
      const destroy = window.destroy.bind(window);
      window.destroy = () => {
        observation.calls += 1;
        destroy();
      };
      return observation;
    });
    const probeChannel = `desktop-e2e-release:${crypto.randomUUID()}`;
    await page.evaluate((name) => {
      const probe: DesktopRecoveryProbe = { events: [] };
      (window as RecoveryProbeWindow).__desktopRecoveryProbe = probe;
      const observer = new BroadcastChannel(name);
      observer.onmessage = (event: MessageEvent<HandoffEvent>) => probe.events.push(event.data);
      const send = BroadcastChannel.prototype.postMessage;
      BroadcastChannel.prototype.postMessage = function (message: unknown) {
        if (
          !probe.releaseBringBack &&
          typeof message === "object" &&
          message !== null &&
          "type" in message &&
          message.type === "bring-back"
        ) {
          // Hold delivery, not cleanup: a responsive child must stay alive until it
          // can consume the request, rather than being force-destroyed by the manager.
          probe.releaseBringBack = () => send.call(this, message);
          return;
        }
        send.call(this, message);
      };
    }, probeChannel);
    await child.evaluate((name) => {
      const observer = new BroadcastChannel(name);
      const send = WebSocket.prototype.send;
      const close = WebSocket.prototype.close;
      WebSocket.prototype.send = function (data) {
        send.call(this, data);
        if (!new URL(this.url).pathname.endsWith("/desktop/ws")) return;
        if (typeof data === "string" || data instanceof Blob) return;
        const bytes = ArrayBuffer.isView(data)
          ? new Uint8Array(data.buffer, data.byteOffset, data.byteLength)
          : new Uint8Array(data);
        observer.postMessage({ type: "send", bytes: Array.from(bytes) });
      };
      WebSocket.prototype.close = function (...args) {
        close.apply(this, args);
        if (new URL(this.url).pathname.endsWith("/desktop/ws"))
          observer.postMessage({ type: "disconnect" });
      };
    }, probeChannel);
    await child.getByRole("button", { name: "Take control", exact: true }).click();
    await viewport(child).click();
    await child.keyboard.down("Shift");
    const connection = childConnections[0];
    assert(connection);
    await expect
      .poll(() => connection.keys.some((key) => key.keysym === 0xffe1 && key.down))
      .toBe(true);

    const closed = child.waitForEvent("close");
    await page.getByRole("button", { name: "Reconnect here", exact: true }).click();
    await page.waitForFunction(() =>
      Boolean((window as RecoveryProbeWindow).__desktopRecoveryProbe?.releaseBringBack)
    );
    // The read-only manager query is an IPC barrier after the recovery request.
    const managed = await page.evaluate(async (workspaceId) => {
      const api = window.__ORPC_CLIENT__;
      if (!api) throw new Error("E2E API client not initialized");
      return api.desktop.getWindow({ workspaceId });
    }, workspace.demoProject.workspaceId);
    expect(managed).not.toBeNull();
    expect(child.isClosed()).toBe(false);
    expect(await forceDestroy.evaluate((observation) => observation.calls)).toBe(0);
    await page.evaluate(() =>
      (window as RecoveryProbeWindow).__desktopRecoveryProbe?.releaseBringBack?.()
    );
    await closed;
    await expectConnectedViewOnly(page);
    const probe = await page.evaluate(() => {
      const value = (window as RecoveryProbeWindow).__desktopRecoveryProbe;
      if (!value) throw new Error("Missing recovery probe");
      return { events: value.events };
    });
    const up = probe.events.findIndex((event) => {
      if (event.type !== "send") return false;
      const key = readKeyEvent(new Uint8Array(event.bytes));
      return key?.keysym === 0xffe1 && !key.down;
    });
    expect(up).toBeGreaterThanOrEqual(0);
    expect(probe.events.findIndex((event) => event.type === "disconnect")).toBeGreaterThan(up);
    const forceDestroyCalls = await forceDestroy.evaluate((observation) => observation.calls);
    expect(forceDestroyCalls).toBe(0);
    expect(inlineConnections).toHaveLength(2);
    const wirePath = testInfo.outputPath("electron-responsive-recovery-wire.json");
    await writeFile(wirePath, JSON.stringify({ ...probe, forceDestroyCalls }, null, 2));
    await testInfo.attach("electron-responsive-recovery-wire", {
      path: wirePath,
      contentType: "application/json",
    });
    await screenshot(page, testInfo, "electron-inline-after-responsive-reconnect");
    await forceDestroy.dispose();
    await nativeChild.dispose();
  });
});

// Set both variables to a dedicated, unauthenticated local sandbox from this branch.
// This does not launch or mutate the user's normal Xum instance.
const browserUrl = process.env.XUM_DESKTOP_E2E_URL;
const browserWorkspaceId = process.env.XUM_DESKTOP_E2E_WORKSPACE_ID;
const browserRoot = process.env.XUM_DESKTOP_E2E_ROOT;

browserTest.describe("browser desktop", () => {
  browserTest.skip(
    !browserUrl || !browserWorkspaceId,
    "Set XUM_DESKTOP_E2E_URL and XUM_DESKTOP_E2E_WORKSPACE_ID for an isolated real-VNC server"
  );

  browserTest(
    "server-side shared borrower removal releases browser popout input without closing the owner",
    async ({ page, context }, testInfo) => {
      browserTest.skip(
        !browserRoot,
        "Set XUM_DESKTOP_E2E_ROOT to the isolated browser server root"
      );
      assert(browserUrl && browserWorkspaceId && browserRoot);
      await page.goto(`${browserUrl}/workspace/${encodeURIComponent(browserWorkspaceId)}`);
      await enableRealDesktop(page, browserWorkspaceId);
      await page.waitForFunction(() => Boolean(window.__ORPC_CLIENT__));
      const { borrower, owner } = await page.evaluate(async (ownerId) => {
        const api = window.__ORPC_CLIENT__;
        if (!api) throw new Error("E2E API client not initialized");
        const owner = (await api.workspace.list()).find((entry) => entry.id === ownerId);
        if (!owner) throw new Error("Browser fixture owner must exist");
        await api.projects.setTrust({ projectPath: owner.projectPath, trusted: true });
        const result = await api.workspace.create({
          projectPath: owner.projectPath,
          branchName: `browser-borrower-${crypto.randomUUID().slice(0, 8)}`,
          runtimeConfig: { type: "local" },
        });
        if (!result.success) throw new Error(result.error);
        return { borrower: result.metadata, owner };
      }, browserWorkspaceId);
      // Setup only: bind a real child to the owner without launching an unrelated agent turn.
      await new Config(browserRoot).editConfig((config) => {
        const entry = config.projects
          .get(owner.projectPath)
          ?.workspaces.find((item) => item.id === borrower.id);
        assert(entry, "Created browser borrower must be registered");
        entry.parentWorkspaceId = owner.id;
        entry.taskDesktopOwnerWorkspaceId = owner.id;
        return config;
      });
      await page.goto(`${browserUrl}/workspace/${encodeURIComponent(borrower.id)}`);
      await page.getByRole("tab", { name: "Desktop", exact: true }).click();
      await expectConnectedViewOnly(page);
      const capability = await page.evaluate(async (workspaceId) => {
        const api = window.__ORPC_CLIENT__;
        if (!api) throw new Error("E2E API client not initialized");
        return api.desktop.getCapability({ workspaceId });
      }, borrower.id);
      assert(capability.available);
      expect(capability.sharedDesktop?.ownerWorkspaceId).toBe(owner.id);
      const readEvents = await observePopoutCleanup(context, page);
      const opening = page.waitForEvent("popup");
      await page.getByRole("button", { name: "Detach", exact: true }).click();
      const popup = await opening;
      await expectConnectedViewOnly(popup);

      // Navigate within the surviving opener, preserving its synchronous wire recorder.
      const ownerConnections = observeDesktopConnections(page);
      await page.keyboard.press("F4");
      await page.getByRole("combobox", { name: "Command palette" }).fill(owner.name);
      await page.getByRole("option", { name: owner.title ?? owner.name, exact: true }).click();
      await page.getByRole("tab", { name: "Desktop", exact: true }).click();
      await expectConnectedViewOnly(page);
      expect(ownerConnections).toHaveLength(1);
      const ownerConnection = ownerConnections[0];
      assert(ownerConnection);
      await page.keyboard.press("F4");
      await page.getByRole("combobox", { name: "Command palette" }).fill(">Remove Workspace");
      await page.getByRole("option", { name: "Remove Workspace…", exact: true }).click();
      await page.getByRole("combobox", { name: "Select workspace" }).fill(borrower.name);
      await page
        .getByRole("option", { name: `${owner.projectName}/${borrower.name}`, exact: true })
        .click();
      const confirmation = page.getByRole("dialog", {
        name: `Remove workspace ${owner.projectName}/${borrower.name}?`,
      });
      await expect(confirmation).toBeVisible();
      await holdDesktopInput(popup, readEvents);
      await screenshot(popup, testInfo, "browser-borrower-held-input-before-removal");
      // The parent initiates backend removal; no Bring back or direct popup-close request.
      await confirmation.getByRole("button", { name: "Remove", exact: true }).click();
      await expect
        .poll(() =>
          page.evaluate(async (workspaceId) => {
            const api = window.__ORPC_CLIENT__;
            if (!api) throw new Error("E2E API client not initialized");
            return (await api.workspace.list()).some((entry) => entry.id === workspaceId);
          }, borrower.id)
        )
        .toBe(false);
      await expect
        .poll(async () => (await readEvents()).some((event) => event.type === "socket-closed"))
        .toBe(true);
      const events = await readEvents();
      expectReleasedBeforeDisconnect(events);
      expect(ownerConnection.closed).toBe(false);
      expect(ownerConnections).toHaveLength(1);
      await expectConnectedViewOnly(page);
      await page.getByRole("button", { name: "Take control", exact: true }).click();
      await viewport(page).click();
      await page.keyboard.press("a");
      await expect
        .poll(() => ownerConnection.keys.some((key) => key.keysym === 0x61 && key.down))
        .toBe(true);
      await page.getByRole("button", { name: "Release control", exact: true }).click();
      await screenshot(page, testInfo, "browser-owner-alive-after-borrower-removal");
      const wirePath = testInfo.outputPath("browser-borrower-removal-wire.json");
      await writeFile(
        wirePath,
        JSON.stringify({ events, ownerConnected: !ownerConnection.closed }, null, 2)
      );
      await testInfo.attach("browser-borrower-removal-wire", {
        path: wirePath,
        contentType: "application/json",
      });
      if (!popup.isClosed()) await popup.close();
    }
  );

  browserTest(
    "real browser popup preserves exclusivity across parent reload and recovery",
    async ({ page }, testInfo) => {
      assert(browserUrl && browserWorkspaceId);
      const workspaceUrl = `${browserUrl.replace(/\/$/, "")}/workspace/${encodeURIComponent(browserWorkspaceId)}`;
      await page.goto(workspaceUrl);
      await enableRealDesktop(page, browserWorkspaceId);
      const connections = observeDesktopConnections(page);
      await page.getByRole("tab", { name: "Desktop", exact: true }).click();
      await expectConnectedViewOnly(page);
      const originalConnection = connections[0];
      assert(originalConnection);

      const popupReady = page.waitForEvent("popup");
      await page.getByRole("button", { name: "Detach", exact: true }).click();
      const popup = await popupReady;
      const popupConnections = observeDesktopConnections(popup);
      await expectConnectedViewOnly(popup);
      expect(popupConnections).toHaveLength(1);
      const popupConnection = popupConnections[0];
      assert(popupConnection);
      await expect(viewport(page)).toHaveCount(0);
      await expect.poll(() => originalConnection.closed).toBe(true);
      await screenshot(popup, testInfo, "browser-real-popout");

      await page.reload();
      await page.getByRole("tab", { name: "Desktop", exact: true }).click();
      await expect(page.getByRole("button", { name: "Reconnect here", exact: true })).toBeVisible();
      await expect(viewport(page)).toHaveCount(0);
      expect(connections).toHaveLength(1);
      await expect(viewport(popup)).toBeVisible();
      // Popup destruction can discard its final DevTools socket/frame events. Record
      // native send/close calls synchronously in the surviving same-origin opener;
      // all calls still reach the real browser WebSocket and real VNC server.
      await page.evaluate(() => {
        const events: HandoffEvent[] = [];
        (window as Window & { __desktopHandoffEvents?: HandoffEvent[] }).__desktopHandoffEvents =
          events;
        const NativeWebSocket = window.WebSocket;
        // Preserve the native prototype; noVNC validates its immediate method properties.
        window.WebSocket = new Proxy(NativeWebSocket, {
          construct(target, args, newTarget) {
            const socket = Reflect.construct(target, args, newTarget) as WebSocket;
            if (new URL(socket.url).pathname.endsWith("/desktop/ws"))
              events.push({ type: "connect" });
            return socket;
          },
        });
      });
      await popup.evaluate(() => {
        const events = (window.opener as Window & { __desktopHandoffEvents?: HandoffEvent[] })
          .__desktopHandoffEvents;
        if (!events) throw new Error("Missing opener handoff recorder");
        const originalSend = WebSocket.prototype.send;
        const originalClose = WebSocket.prototype.close;
        WebSocket.prototype.send = function (data) {
          originalSend.call(this, data);
          if (!new URL(this.url).pathname.endsWith("/desktop/ws")) return;
          if (typeof data === "string" || data instanceof Blob) return;
          const bytes = ArrayBuffer.isView(data)
            ? new Uint8Array(data.buffer, data.byteOffset, data.byteLength)
            : new Uint8Array(data);
          events.push({ type: "send", bytes: Array.from(bytes) });
        };
        WebSocket.prototype.close = function (...args) {
          originalClose.apply(this, args);
          if (new URL(this.url).pathname.endsWith("/desktop/ws"))
            events.push({ type: "disconnect" });
        };
      });
      await popup.getByRole("button", { name: "Take control", exact: true }).click();
      await viewport(popup).click();
      await expect(
        popup.getByRole("button", { name: "Release control", exact: true })
      ).toBeVisible();
      await popup.keyboard.down("Shift");
      await expect
        .poll(() => popupConnection.keys.some((key) => key.keysym === 0xffe1 && key.down))
        .toBe(true);

      const closed = popup.waitForEvent("close");
      await page.getByRole("button", { name: "Reconnect here", exact: true }).click();
      await closed;
      await expectConnectedViewOnly(page);
      const events = await page.evaluate(
        () =>
          (window as Window & { __desktopHandoffEvents?: HandoffEvent[] }).__desktopHandoffEvents
      );
      assert(events);
      const evidencePath = testInfo.outputPath("browser-handoff-wire.json");
      await writeFile(evidencePath, JSON.stringify(events, null, 2));
      await testInfo.attach("browser-handoff-wire", {
        path: evidencePath,
        contentType: "application/json",
      });
      const keyIndex = (down: boolean) =>
        events.findIndex((event) => {
          if (event.type !== "send") return false;
          const key = readKeyEvent(new Uint8Array(event.bytes));
          return key?.keysym === 0xffe1 && key.down === down;
        });
      const disconnectIndex = events.findIndex((event) => event.type === "disconnect");
      expect(keyIndex(true)).toBeGreaterThanOrEqual(0);
      expect(keyIndex(false)).toBeGreaterThan(keyIndex(true));
      expect(disconnectIndex).toBeGreaterThan(keyIndex(false));
      expect(events.findIndex((event) => event.type === "connect")).toBeGreaterThan(
        disconnectIndex
      );
      expect(popupConnections).toHaveLength(1);
      expect(connections).toHaveLength(2);
      expect(connections.filter((connection) => !connection.closed)).toHaveLength(1);
      await screenshot(page, testInfo, "browser-recovered-after-parent-reload");
    }
  );
});

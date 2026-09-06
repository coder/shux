import assert from "node:assert/strict";
import type { BrowserWindow, Clipboard } from "electron";
import { once } from "node:events";
import { createServer } from "node:http";
import { electronTest, electronExpect as expect } from "../electronTest";

const test = electronTest.extend<{ remoteServer: { url: string; requests: string[] } }>({
  remoteServer: async ({ workspace }, use) => {
    assert(workspace.configRoot);
    const requests: string[] = [];
    let authUrl = "";
    const server = createServer((request, response) => {
      requests.push(request.url ?? "");
      if (request.url === "/auth-url") {
        response.writeHead(200, { "Content-Type": "text/plain" });
        response.end(authUrl);
        return;
      }
      response.writeHead(200, { "Content-Type": "text/html; charset=utf-8" });
      if (request.url === "/callback") {
        response.end(
          '<!doctype html><h1>Auth callback</h1><button id="finish">Finish sign in</button>' +
            '<script>document.getElementById("finish").onclick = () => {' +
            'window.opener.postMessage({ type: "auth-complete" }, location.origin); window.close();' +
            "};</script>"
        );
        return;
      }
      response.end(
        '<!doctype html><h1>Remote server</h1><button id="login">Sign in</button><p id="status"></p>' +
          '<button id="copy">Copy text</button><p id="copied"></p>' +
          '<textarea aria-label="Paste target"></textarea><p id="pasted"></p>' +
          '<script>document.getElementById("copy").onclick = async () => {' +
          'try { await navigator.clipboard.writeText("remote-copy-value"); document.getElementById("copied").textContent = "Copied"; }' +
          'catch (error) { document.getElementById("copied").textContent = String(error); }};' +
          'document.querySelector("textarea").onpaste = (event) => {' +
          'document.getElementById("pasted").textContent = event.clipboardData.getData("text/plain"); };' +
          'let popup; document.getElementById("login").onclick = async () => {' +
          'popup = window.open("about:blank", "auth");' +
          'const response = await fetch("/auth-url"); popup.location.href = await response.text();' +
          '}; window.addEventListener("message", (event) => {' +
          'if (event.origin === location.origin && event.source === popup && event.data.type === "auth-complete") {' +
          'document.getElementById("status").textContent = "Signed in";' +
          "}});</script>"
      );
    });
    server.listen(0, "127.0.0.1");
    await once(server, "listening");
    const address = server.address();
    assert(address && typeof address !== "string");
    const url = "http://127.0.0.1:" + address.port;
    // A separate port proves that auth redirects can cross origins.
    const authServer = createServer((_request, response) => {
      response.writeHead(302, { Location: url + "/callback" });
      response.end();
    });
    try {
      authServer.listen(0, "127.0.0.1");
      await once(authServer, "listening");
      const authAddress = authServer.address();
      assert(authAddress && typeof authAddress !== "string");
      authUrl = "http://127.0.0.1:" + authAddress.port + "/authorize";
      await use({ url, requests });
    } finally {
      await Promise.all(
        [server, authServer].map(async (activeServer) => {
          const closed = new Promise<void>((resolve, reject) => {
            activeServer.close((error) => (error ? reject(error) : resolve()));
          });
          activeServer.closeAllConnections();
          await closed;
        })
      );
    }
  },
});

test("remote connection isolates the page and returns to the same local renderer", async ({
  app,
  page,
  ui,
  workspace,
  remoteServer,
}) => {
  // The Electron fixture creates a separate root and checks the child process environment.
  expect(workspace.configRoot).not.toBe("");
  await page.waitForFunction(() => Boolean(window.__ORPC_CLIENT__));
  const localProjects = await page.evaluate(async () => {
    const api = window.__ORPC_CLIENT__;
    if (!api) throw new Error("Local API is unavailable");
    return api.projects.list();
  });
  expect(localProjects.length).toBeGreaterThan(0);
  await ui.settings.open();
  await page.getByRole("button", { name: "Remote Connection", exact: true }).click();
  const localWindow = await app.browserWindow(page);
  const localRenderer = await page.evaluateHandle(() => document.documentElement);
  const url = remoteServer.url + "/?token=e2e-private-token";
  await page.getByLabel("Server URL", { exact: true }).fill(url);
  const remoteOpened = app.waitForEvent("window");
  await page.getByRole("button", { name: "Connect", exact: true }).click();
  const remote = await remoteOpened;
  await expect(remote.getByRole("heading", { name: "Remote server" })).toBeVisible();
  expect(remoteServer.requests).toContain("/?token=e2e-private-token");
  expect(
    await remote.evaluate(() => ({
      api: typeof window.api,
      require: typeof Reflect.get(window, "require"),
      process: typeof Reflect.get(window, "process"),
    }))
  ).toEqual({ api: "undefined", require: "undefined", process: "undefined" });
  await expect
    .poll(() => localWindow.evaluate((window: BrowserWindow) => window.isVisible()))
    .toBe(false);
  await expect
    .poll(() => page.evaluate(() => window.api?.remoteConnection?.getState()))
    .toEqual({
      status: "connected",
      serverUrl: remoteServer.url,
    });
  const previousClipboard = await app.evaluate(({ clipboard }: { clipboard: Clipboard }) =>
    clipboard.readText()
  );
  try {
    await remote.getByRole("button", { name: "Copy text", exact: true }).click();
    await expect(remote.locator("#copied")).toHaveText("Copied");
    expect(
      await app.evaluate(({ clipboard }: { clipboard: Clipboard }) => clipboard.readText())
    ).toBe("remote-copy-value");
    await remote.getByRole("textbox", { name: "Paste target" }).click();
    await remote.keyboard.press("ControlOrMeta+v");
    await expect(remote.getByRole("textbox", { name: "Paste target" })).toHaveValue(
      "remote-copy-value"
    );
    await expect(remote.locator("#pasted")).toHaveText("remote-copy-value");
    expect(
      await remote.evaluate(() =>
        navigator.clipboard.readText().then(
          () => false,
          () => true
        )
      )
    ).toBe(true);
  } finally {
    await app.evaluate(
      ({ clipboard }: { clipboard: Clipboard }, text) => clipboard.writeText(text),
      previousClipboard
    );
  }
  const popupOpened = app.waitForEvent("window");
  await remote.getByRole("button", { name: "Sign in", exact: true }).click();
  const popup = await popupOpened;
  await expect(popup.getByRole("heading", { name: "Auth callback" })).toBeVisible();
  expect(
    await popup.evaluate(() => ({
      api: typeof window.api,
      require: typeof Reflect.get(window, "require"),
    }))
  ).toEqual({ api: "undefined", require: "undefined" });
  await Promise.all([
    popup.waitForEvent("close"),
    popup.getByRole("button", { name: "Finish sign in", exact: true }).click(),
  ]);
  await expect(remote.getByText("Signed in", { exact: true })).toBeVisible();
  // A remote connection must not stop the local backend or replace its renderer.
  expect(
    await page.evaluate(async () => {
      const api = window.__ORPC_CLIENT__;
      if (!api) throw new Error("Local API is unavailable while hidden");
      return api.projects.list();
    })
  ).toEqual(localProjects);
  await remote.close();
  await expect
    .poll(() => localWindow.evaluate((window: BrowserWindow) => window.isVisible()))
    .toBe(true);
  await expect
    .poll(() => page.evaluate(() => window.api?.remoteConnection?.getState()))
    .toEqual({
      status: "disconnected",
      serverUrl: null,
    });
  expect(await localRenderer.evaluate((element) => element === document.documentElement)).toBe(
    true
  );
  expect(app.windows()).toEqual([page]);
  await expect(page.getByLabel("Server URL", { exact: true })).toHaveValue(remoteServer.url);
  const reconnectOpened = app.waitForEvent("window");
  await page.getByRole("button", { name: "Connect", exact: true }).click();
  const reconnected = await reconnectOpened;
  await expect(reconnected.getByRole("heading", { name: "Remote server" })).toBeVisible();
  const reconnectedWindow = await app.browserWindow(reconnected);
  await Promise.all([
    reconnected.waitForEvent("close"),
    // Use Electron input events to exercise before-input-event, not the CDP keyboard path.
    reconnectedWindow.evaluate((window: BrowserWindow) => {
      window.focus();
      window.webContents.sendInputEvent({
        type: "keyDown",
        keyCode: "L",
        modifiers: process.platform === "darwin" ? ["meta", "shift"] : ["control", "shift"],
      });
    }),
  ]);
  await reconnectedWindow.dispose();
  await expect
    .poll(() => localWindow.evaluate((window: BrowserWindow) => window.isVisible()))
    .toBe(true);
  expect(await localRenderer.evaluate((element) => element === document.documentElement)).toBe(
    true
  );
  await localRenderer.dispose();
  await localWindow.dispose();
});

test("Coder path-mounted servers retain their URL and isolate sibling sessions", async ({
  app,
  page,
  ui,
  remoteServer,
}) => {
  await ui.settings.open();
  await page.getByRole("button", { name: "Remote Connection", exact: true }).click();
  const firstServerUrl = remoteServer.url + "/@alice/first/apps/xum";
  const secondServerUrl = remoteServer.url + "/@alice/second/apps/xum";
  const connections = [
    {
      url: firstServerUrl + "/workspaces/one?token=path-token",
      serverUrl: firstServerUrl,
      cookie: "",
    },
    { url: firstServerUrl, serverUrl: firstServerUrl, cookie: "remote-session=kept" },
    { url: secondServerUrl, serverUrl: secondServerUrl, cookie: "" },
  ];
  for (const [index, connection] of connections.entries()) {
    const input = page.getByLabel("Server URL", { exact: true });
    if (index !== 1) await input.fill(connection.url);
    else await expect(input).toHaveValue(firstServerUrl);
    const opened = app.waitForEvent("window");
    await page.getByRole("button", { name: "Connect", exact: true }).click();
    const remote = await opened;
    await expect(remote.getByRole("heading", { name: "Remote server" })).toBeVisible();
    expect(remote.url()).toBe(connection.url);
    await expect
      .poll(() => page.evaluate(() => window.api?.remoteConnection?.getState()))
      .toEqual({
        status: "connected",
        serverUrl: connection.serverUrl,
      });
    expect(await remote.evaluate(() => document.cookie)).toBe(connection.cookie);
    if (index === 0) {
      expect(remoteServer.requests).toContain(
        "/@alice/first/apps/xum/workspaces/one?token=path-token"
      );
      // A root-path cookie detects session sharing between servers on the same origin.
      await remote.evaluate(() => {
        document.cookie = "remote-session=kept; Path=/; SameSite=Lax";
      });
    }
    await remote.close();
    await expect
      .poll(() => page.evaluate(() => window.api?.remoteConnection?.getState()))
      .toEqual({
        status: "disconnected",
        serverUrl: null,
      });
    await expect(input).toHaveValue(connection.serverUrl);
  }
});

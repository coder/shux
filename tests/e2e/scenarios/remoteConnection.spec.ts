import assert from "node:assert/strict";
import type {
  BaseWindow,
  BrowserWindow,
  Clipboard,
  Dialog,
  MessageBoxOptions,
  MessageBoxReturnValue,
  SystemPreferences,
} from "electron";
import type { ElectronApplication, Frame, JSHandle, Page } from "playwright";
import { once } from "node:events";
import { createServer } from "node:http";
import { electronTest, electronExpect as expect } from "../electronTest";
import { REMOTE_CONNECTION_EDITOR_FRAME_NAME_PREFIX } from "../../../src/common/constants/remoteConnection";

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
test("remote app popups and blob attachments retain isolation and close on disconnect", async ({
  app,
  page,
  remoteServer,
}) => {
  await page.waitForFunction(() => Boolean(window.api?.remoteConnection));
  const base = remoteServer.url + "/@user/workspace/apps/xum/";
  const opened = app.waitForEvent("window");
  await page.evaluate((url) => window.api!.remoteConnection!.connect(url), base);
  const remote = await opened;
  await expect(remote.getByRole("heading", { name: "Remote server" })).toBeVisible();
  await remote.evaluate(() => {
    // A browser pop-out needs the remote session's token and cookies, not the local session.
    window.localStorage.setItem("popout-auth", "remote-session-token");
    document.cookie = "popout-cookie=remote-session-cookie; path=/";
  });
  expect(
    await remote.evaluate(
      (prefix) => window.open("about:blank", prefix + "e2e") === null,
      REMOTE_CONNECTION_EDITOR_FRAME_NAME_PREFIX
    )
  ).toBe(true);
  const popups = [];
  for (const path of ["terminal.html?terminalId=one", "desktop.html?workspaceId=two"]) {
    const popupOpened = app.waitForEvent("window");
    expect(await remote.evaluate((url) => Boolean(window.open(url, "_blank")), base + path)).toBe(
      true
    );
    const popup = await popupOpened;
    await popup.waitForURL(base + path);
    expect(
      await popup.evaluate(() => ({
        api: typeof window.api,
        require: typeof Reflect.get(window, "require"),
        token: window.localStorage.getItem("popout-auth"),
        cookie: document.cookie,
      }))
    ).toEqual({
      api: "undefined",
      require: "undefined",
      token: "remote-session-token",
      cookie: "popout-cookie=remote-session-cookie",
    });
    const popupWindow = await app.browserWindow(popup);
    expect(
      await popupWindow.evaluate((window) => {
        const preferences = window.webContents.getLastWebPreferences();
        return {
          sandbox: preferences.sandbox,
          nodeIntegration: preferences.nodeIntegration,
          preload: preferences.preload,
        };
      })
    ).toMatchObject({ sandbox: true, nodeIntegration: false, preload: undefined });
    await popupWindow.evaluate((window) => window.focus());
    await popup.getByRole("button", { name: "Copy text" }).click();
    await expect(popup.locator("#copied")).toHaveText("Copied");
    popups.push(popup);
  }
  const blobOpened = app.waitForEvent("window");
  expect(
    await remote.evaluate(() => {
      const url = URL.createObjectURL(new Blob(["Attachment content"], { type: "text/plain" }));
      return Boolean(window.open(url, "_blank"));
    })
  ).toBe(true);
  const attachment = await blobOpened;
  await expect(attachment.locator("body")).toContainText("Attachment content");
  expect(await attachment.evaluate(() => typeof window.api)).toBe("undefined");
  expect(
    await attachment.evaluate(() => window.open("https://example.com/", "_blank") === null)
  ).toBe(true);
  const returned = Promise.all(
    [remote, ...popups, attachment].map((window) => window.waitForEvent("close"))
  );
  await page.evaluate(() => window.api!.remoteConnection!.disconnect());
  await returned;
  expect(await page.evaluate(() => window.localStorage.getItem("popout-auth"))).toBeNull();
});

interface NativeMediaState {
  prompts: Array<{
    windowId: number;
    signal: AbortSignal | undefined;
    respond: (allow: boolean) => void;
  }>;
  status: ReturnType<SystemPreferences["getMediaAccessStatus"]>;
  statusFailure: boolean;
  osApproval: boolean;
  statusRequests: string[];
  osRequests: string[];
  restore: () => void;
}

const microphoneTest = test.extend<{ nativeMedia: JSHandle<NativeMediaState> }>({
  nativeMedia: async ({ app }, use) => {
    const state = await app.evaluateHandle(
      ({ dialog, systemPreferences }: { dialog: Dialog; systemPreferences: SystemPreferences }) => {
        const originalDialog = dialog.showMessageBox;
        const originalStatus = systemPreferences.getMediaAccessStatus;
        const originalRequest = systemPreferences.askForMediaAccess;
        const state: NativeMediaState = {
          prompts: [],
          status: "granted",
          statusFailure: false,
          osApproval: true,
          statusRequests: [],
          osRequests: [],
          restore: () => {
            for (const prompt of state.prompts) prompt.respond(false);
            dialog.showMessageBox = originalDialog;
            systemPreferences.getMediaAccessStatus = originalStatus;
            systemPreferences.askForMediaAccess = originalRequest;
          },
        };
        // Stub native boundaries only. Chromium still runs the installed permission handlers.
        dialog.showMessageBox = (
          owner: BaseWindow | MessageBoxOptions,
          options?: MessageBoxOptions
        ): Promise<MessageBoxReturnValue> => {
          if (!("id" in owner) || !options || options.buttons?.length !== 2) {
            throw new Error("Microphone consent needs a parent window and two buttons");
          }
          if (options.cancelId !== 0 || options.defaultId !== 0) {
            throw new Error("Microphone consent must default to denial");
          }
          return new Promise((resolve) => {
            state.prompts.push({
              windowId: owner.id,
              signal: options.signal,
              // Leave aborted dialogs pending to test late native responses.
              respond: (allow) => resolve({ response: allow ? 1 : 0, checkboxChecked: false }),
            });
          });
        };
        systemPreferences.getMediaAccessStatus = (mediaType) => {
          state.statusRequests.push(mediaType);
          if (state.statusFailure) throw new Error("Test OS status failure");
          return state.status;
        };
        systemPreferences.askForMediaAccess = (mediaType) => {
          state.osRequests.push(mediaType);
          return Promise.resolve(state.osApproval);
        };
        return state;
      }
    );
    try {
      await use(state);
    } finally {
      await state.evaluate((state) => state.restore());
      await state.dispose();
    }
  },
});

async function connectForMicrophone(
  app: ElectronApplication,
  local: Page,
  url: string
): Promise<Page> {
  await local.waitForFunction(() => Boolean(window.api?.remoteConnection));
  const opened = app.waitForEvent("window");
  await local.evaluate((url) => window.api!.remoteConnection!.connect(url), url);
  const remote = await opened;
  await expect(remote.getByRole("heading", { name: "Remote server" })).toBeVisible();
  await focusNativeWindow(app, remote);
  return remote;
}

async function focusNativeWindow(app: ElectronApplication, page: Page): Promise<void> {
  const window = await app.browserWindow(page);
  try {
    await window.evaluate((window) => window.focus());
    await expect.poll(() => window.evaluate((window) => window.isFocused())).toBe(true);
  } finally {
    await window.dispose();
  }
}

async function requestMedia(target: Page | Frame, constraints: MediaStreamConstraints) {
  return target.evaluate(async (constraints) => {
    try {
      const stream = await navigator.mediaDevices.getUserMedia(constraints);
      Reflect.set(window, "__testMicrophoneStream", stream);
      return {
        allowed: true,
        tracks: stream.getTracks().map((track) => ({ kind: track.kind, state: track.readyState })),
        error: null,
      };
    } catch (error) {
      return {
        allowed: false,
        tracks: [],
        error: error instanceof Error ? error.name : String(error),
      };
    }
  }, constraints);
}

async function stopMicrophone(page: Page): Promise<void> {
  expect(
    await page.evaluate(() => {
      const stream: unknown = Reflect.get(window, "__testMicrophoneStream");
      if (!(stream instanceof MediaStream)) throw new Error("No active test microphone stream");
      for (const track of stream.getTracks()) track.stop();
      return stream.getTracks().map((track) => track.readyState);
    })
  ).toEqual(["ended"]);
}

async function respondToMicrophone(
  state: JSHandle<NativeMediaState>,
  index: number,
  allow: boolean
): Promise<void> {
  await expect.poll(() => state.evaluate((state) => state.prompts.length)).toBe(index + 1);
  await state.evaluate((state, response) => state.prompts[response.index].respond(response.allow), {
    index,
    allow,
  });
}

microphoneTest.describe("remote microphone permissions", () => {
  microphoneTest.use({ fakeMediaDevices: true });

  microphoneTest(
    "non-loopback HTTP keeps microphone access unavailable",
    async ({ app, page, nativeMedia }) => {
      const url = "http://microphone.invalid/";
      // Intercept HTTP content without changing Chromium's secure-context rules or host flags.
      await app.context().route(url, (route) =>
        route.fulfill({
          contentType: "text/html",
          body: "<!doctype html><h1>Remote server</h1>",
        })
      );
      try {
        const remote = await connectForMicrophone(app, page, url);
        expect(remote.url()).toBe(url);
        expect(await remote.evaluate(() => window.isSecureContext)).toBe(false);
        expect(await requestMedia(remote, { audio: true })).toMatchObject({ allowed: false });
        expect(await nativeMedia.evaluate((state) => state.prompts.length)).toBe(0);
      } finally {
        await app.context().unroute(url);
      }
    }
  );

  microphoneTest(
    "audio needs consent on approval, denial, and retry; local access remains available",
    async ({ app, page, remoteServer, nativeMedia }) => {
      expect(await requestMedia(page, { audio: true })).toMatchObject({ allowed: true });
      await stopMicrophone(page);
      const remote = await connectForMicrophone(app, page, remoteServer.url);
      for (const [index, allow] of [true, false, true].entries()) {
        await focusNativeWindow(app, remote);
        const previousAccessRequests = await nativeMedia.evaluate(
          (state) => state.statusRequests.length + state.osRequests.length
        );
        const capture = requestMedia(remote, { audio: true });
        await expect
          .poll(() => nativeMedia.evaluate((state) => state.prompts.length))
          .toBe(index + 1);
        // OS access starts only after the user approves the native dialog.
        expect(
          await nativeMedia.evaluate(
            (state) => state.statusRequests.length + state.osRequests.length
          )
        ).toBe(previousAccessRequests);
        await respondToMicrophone(nativeMedia, index, allow);
        if (allow) {
          expect(await capture).toEqual({
            allowed: true,
            tracks: [{ kind: "audio", state: "live" }],
            error: null,
          });
          // Permission checks never expose a reusable grant, even during active capture.
          expect(
            await remote.evaluate(async () => {
              const permission = await navigator.permissions.query({
                name: "microphone" as PermissionName,
              });
              return permission.state;
            })
          ).toBe("denied");
          await stopMicrophone(remote);
        } else {
          expect(await capture).toMatchObject({ allowed: false, error: "NotAllowedError" });
          expect(
            await nativeMedia.evaluate(
              (state) => state.statusRequests.length + state.osRequests.length
            )
          ).toBe(previousAccessRequests);
        }
      }
      await remote.close();
      await expect
        .poll(() => page.evaluate(() => window.api!.remoteConnection!.getState()))
        .toMatchObject({ status: "disconnected" });
      expect(await requestMedia(page, { audio: true })).toMatchObject({ allowed: true });
      await stopMicrophone(page);
      expect(await nativeMedia.evaluate((state) => state.prompts.length)).toBe(3);
      expect(await page.evaluate(() => Boolean(window.__ORPC_CLIENT__))).toBe(true);
    }
  );

  microphoneTest(
    "camera, mixed media, subframes, auth, and attachments cannot request microphone consent",
    async ({ app, page, remoteServer, nativeMedia }) => {
      const base = remoteServer.url + "/@user/workspace/apps/xum/";
      const remote = await connectForMicrophone(app, page, base);
      for (const constraints of [{ video: true }, { audio: true, video: true }]) {
        expect(await requestMedia(remote, constraints)).toMatchObject({
          allowed: false,
          error: "NotAllowedError",
        });
      }
      await remote.evaluate(async (url) => {
        const frame = document.createElement("iframe");
        frame.name = "microphone-subframe";
        frame.allow = "microphone; camera";
        frame.src = url;
        const loaded = new Promise<void>((resolve) =>
          frame.addEventListener("load", () => resolve(), { once: true })
        );
        document.body.append(frame);
        await loaded;
      }, base + "embedded");
      const frame = remote.frame("microphone-subframe");
      assert(frame);
      expect(await requestMedia(frame, { audio: true })).toMatchObject({
        allowed: false,
        error: "NotAllowedError",
      });
      const authOpened = app.waitForEvent("window");
      await remote.getByRole("button", { name: "Sign in", exact: true }).click();
      const auth = await authOpened;
      await expect(auth.getByRole("heading", { name: "Auth callback" })).toBeVisible();
      await focusNativeWindow(app, auth);
      expect(await requestMedia(auth, { audio: true })).toMatchObject({
        allowed: false,
        error: "NotAllowedError",
      });
      // Auth windows stay ineligible after a redirect into the selected app.
      await auth.goto(base + "callback");
      expect(await requestMedia(auth, { audio: true })).toMatchObject({
        allowed: false,
        error: "NotAllowedError",
      });
      await auth.close();
      await focusNativeWindow(app, remote);
      const attachmentOpened = app.waitForEvent("window");
      await remote.evaluate(() => {
        const url = URL.createObjectURL(
          new Blob(["Microphone attachment"], { type: "text/plain" })
        );
        window.open(url, "_blank");
      });
      const attachment = await attachmentOpened;
      await expect(attachment.locator("body")).toContainText("Microphone attachment");
      await focusNativeWindow(app, attachment);
      expect(await requestMedia(attachment, { audio: true })).toMatchObject({
        allowed: false,
        error: "NotAllowedError",
      });
      await attachment.close();
      // A same-origin login page is not part of the selected path-mounted app.
      await remote.goto(remoteServer.url + "/login");
      await focusNativeWindow(app, remote);
      expect(await requestMedia(remote, { audio: true })).toMatchObject({
        allowed: false,
        error: "NotAllowedError",
      });
      expect(await nativeMedia.evaluate((state) => state.prompts.length)).toBe(0);
    }
  );

  microphoneTest(
    "only an initially focused app popup can request audio",
    async ({ app, page, remoteServer, nativeMedia }) => {
      const remote = await connectForMicrophone(app, page, remoteServer.url);
      const opened = app.waitForEvent("window");
      await remote.evaluate(() => window.open("/terminal.html?terminalId=microphone", "_blank"));
      const popup = await opened;
      await expect(popup.getByRole("heading", { name: "Remote server" })).toBeVisible();
      await focusNativeWindow(app, popup);
      expect(await requestMedia(remote, { audio: true })).toMatchObject({
        allowed: false,
        error: "NotAllowedError",
      });
      const capture = requestMedia(popup, { audio: true });
      await expect.poll(() => nativeMedia.evaluate((state) => state.prompts.length)).toBe(1);
      // Native consent can transfer focus away from the requesting window.
      const popupWindow = await app.browserWindow(popup);
      await popupWindow.evaluate((window) => window.blur());
      await expect.poll(() => popupWindow.evaluate((window) => window.isFocused())).toBe(false);
      await respondToMicrophone(nativeMedia, 0, true);
      expect(await capture).toMatchObject({
        allowed: true,
        tracks: [{ kind: "audio", state: "live" }],
      });
      expect(await nativeMedia.evaluate((state) => state.prompts[0].windowId)).toBe(
        await popupWindow.evaluate((window) => window.id)
      );
      await popupWindow.dispose();
      await stopMicrophone(popup);
    }
  );

  microphoneTest(
    "navigation and same-URL reload abort stale consent",
    async ({ app, page, remoteServer, nativeMedia }) => {
      const remote = await connectForMicrophone(app, page, remoteServer.url);
      for (const [index, reload] of [true, false].entries()) {
        const promptIndex = index * 2;
        const pending = requestMedia(remote, { audio: true }).catch(() => null);
        await expect
          .poll(() => nativeMedia.evaluate((state) => state.prompts.length))
          .toBe(promptIndex + 1);
        const previousUrl = remote.url();
        if (reload) {
          await remote.reload();
          expect(remote.url()).toBe(previousUrl);
        } else {
          await remote.goto(remoteServer.url + "/workspaces/other");
        }
        await expect
          .poll(() =>
            nativeMedia.evaluate(
              (state, index) => state.prompts[index].signal?.aborted,
              promptIndex
            )
          )
          .toBe(true);
        await respondToMicrophone(nativeMedia, promptIndex, true);
        expect((await pending)?.allowed).not.toBe(true);
        await focusNativeWindow(app, remote);
        const fresh = requestMedia(remote, { audio: true });
        await respondToMicrophone(nativeMedia, promptIndex + 1, true);
        expect(await fresh).toMatchObject({ allowed: true });
        await stopMicrophone(remote);
      }
    }
  );

  microphoneTest(
    "disconnect closes active capture and aborts pending consent before reconnect",
    async ({ app, page, remoteServer, nativeMedia }) => {
      const remote = await connectForMicrophone(app, page, remoteServer.url);
      const active = requestMedia(remote, { audio: true });
      await respondToMicrophone(nativeMedia, 0, true);
      expect(await active).toMatchObject({
        allowed: true,
        tracks: [{ kind: "audio", state: "live" }],
      });
      const pending = requestMedia(remote, { audio: true }).catch(() => null);
      await expect.poll(() => nativeMedia.evaluate((state) => state.prompts.length)).toBe(2);
      const closed = remote.waitForEvent("close");
      const remoteWindow = await app.browserWindow(remote);
      await page.evaluate(() => window.api!.remoteConnection!.disconnect());
      await closed;
      expect(await remoteWindow.evaluate((window) => window.isDestroyed())).toBe(true);
      await remoteWindow.dispose();
      await expect
        .poll(() => nativeMedia.evaluate((state) => state.prompts[1].signal?.aborted))
        .toBe(true);
      await respondToMicrophone(nativeMedia, 1, true);
      expect((await pending)?.allowed).not.toBe(true);
      expect(app.windows()).toEqual([page]);
      const reconnected = await connectForMicrophone(app, page, remoteServer.url);
      const fresh = requestMedia(reconnected, { audio: true });
      await respondToMicrophone(nativeMedia, 2, true);
      expect(await fresh).toMatchObject({ allowed: true });
      await stopMicrophone(reconnected);
    }
  );

  for (const lifecycle of ["close", "crash"] as const) {
    microphoneTest(
      lifecycle + " aborts pending microphone consent",
      async ({ app, page, remoteServer, nativeMedia }) => {
        const remote = await connectForMicrophone(app, page, remoteServer.url);
        const pending = requestMedia(remote, { audio: true }).catch(() => null);
        await expect.poll(() => nativeMedia.evaluate((state) => state.prompts.length)).toBe(1);
        if (lifecycle === "close") {
          await remote.close();
        } else {
          const window = await app.browserWindow(remote);
          await window.evaluate((window) => {
            // Terminate the renderer without waiting for its event loop or debugger.
            process.kill(window.webContents.getOSProcessId(), "SIGKILL");
          });
          await window.dispose();
        }
        await expect
          .poll(() => nativeMedia.evaluate((state) => state.prompts[0].signal?.aborted))
          .toBe(true);
        await respondToMicrophone(nativeMedia, 0, true);
        expect((await pending)?.allowed).not.toBe(true);
        await expect
          .poll(() => page.evaluate(() => window.api!.remoteConnection!.getState()))
          .toMatchObject({ status: "disconnected" });
      }
    );
  }

  microphoneTest.describe("platform microphone checks", () => {
    microphoneTest.skip(
      process.platform === "linux",
      "Linux does not expose microphone OS consent"
    );
    microphoneTest(
      "OS denial and status failures cannot grant remote audio",
      async ({ app, page, remoteServer, nativeMedia }) => {
        const remote = await connectForMicrophone(app, page, remoteServer.url);
        for (const [index, status] of (["denied", "restricted", "granted"] as const).entries()) {
          await nativeMedia.evaluate((state, status) => {
            state.status = status;
            state.statusFailure = status === "granted";
          }, status);
          const capture = requestMedia(remote, { audio: true });
          await respondToMicrophone(nativeMedia, index, true);
          expect(await capture).toMatchObject({ allowed: false, error: "NotAllowedError" });
        }
        expect(await nativeMedia.evaluate((state) => state.statusRequests)).toEqual([
          "microphone",
          "microphone",
          "microphone",
        ]);
        expect(await nativeMedia.evaluate((state) => state.osRequests)).toEqual([]);
        if (process.platform === "darwin") {
          await nativeMedia.evaluate((state) => {
            state.status = "not-determined";
            state.statusFailure = false;
            state.osApproval = false;
          });
          const capture = requestMedia(remote, { audio: true });
          await respondToMicrophone(nativeMedia, 3, true);
          expect(await capture).toMatchObject({ allowed: false, error: "NotAllowedError" });
          expect(await nativeMedia.evaluate((state) => state.osRequests)).toEqual(["microphone"]);
        }
      }
    );
  });
});

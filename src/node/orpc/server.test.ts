import { describe, expect, mock, test } from "bun:test";
import * as fs from "fs/promises";
import * as os from "os";
import * as path from "path";
import { WebSocket, WebSocketServer } from "ws";
import { RPCLink as HTTPRPCLink } from "@orpc/client/fetch";
import { createORPCClient } from "@orpc/client";
import type { RouterClient } from "@orpc/server";
import { createOrpcServer, DESKTOP_WS_PATH } from "./server";
import type { ORPCContext } from "./context";
import type { AppRouter } from "./router";

function getErrorCode(error: unknown): string | null {
  if (typeof error !== "object" || error === null) {
    return null;
  }

  if (!("code" in error)) {
    return null;
  }

  const code = (error as { code?: unknown }).code;
  return typeof code === "string" ? code : null;
}

async function waitForWebSocketOpen(ws: WebSocket): Promise<void> {
  await new Promise<void>((resolve, reject) => {
    const onOpen = () => {
      cleanup();
      resolve();
    };

    const onError = (error: Error) => {
      cleanup();
      reject(error);
    };

    const onClose = () => {
      cleanup();
      reject(new Error("WebSocket closed before opening"));
    };

    const cleanup = () => {
      ws.off("open", onOpen);
      ws.off("error", onError);
      ws.off("close", onClose);
    };

    ws.once("open", onOpen);
    ws.once("error", onError);
    ws.once("close", onClose);
  });
}

async function waitForWebSocketRejection(ws: WebSocket): Promise<void> {
  return new Promise<void>((resolve, reject) => {
    const timeout = setTimeout(() => {
      cleanup();
      reject(new Error("Expected WebSocket handshake to be rejected"));
    }, 5_000);

    const onError = () => {
      cleanup();
      resolve();
    };

    const onClose = () => {
      cleanup();
      resolve();
    };

    const onOpen = () => {
      cleanup();
      reject(new Error("Expected WebSocket handshake to be rejected"));
    };

    const cleanup = () => {
      clearTimeout(timeout);
      ws.off("error", onError);
      ws.off("close", onClose);
      ws.off("open", onOpen);
    };

    ws.once("error", onError);
    ws.once("close", onClose);
    ws.once("open", onOpen);
  });
}

async function closeWebSocket(ws: WebSocket): Promise<void> {
  if (ws.readyState === WebSocket.CLOSED) {
    return;
  }

  await new Promise<void>((resolve) => {
    ws.once("close", () => resolve());
    ws.close();
  });
}

function createHttpClient(
  baseUrl: string,
  headers?: Record<string, string>
): RouterClient<AppRouter> {
  const link = new HTTPRPCLink({
    origin: baseUrl,
    url: "/orpc",
    headers,
  });

  // eslint-disable-next-line @typescript-eslint/no-unnecessary-type-assertion -- test helper
  return createORPCClient(link) as RouterClient<AppRouter>;
}

async function withProxyUriTemplateEnv<T>(
  env: { muxProxyUri?: string; vscodeProxyUri?: string },
  run: () => Promise<T>
): Promise<T> {
  const previousMuxProxyUri = process.env.MUX_PROXY_URI;
  const previousVscodeProxyUri = process.env.VSCODE_PROXY_URI;

  if (env.muxProxyUri === undefined) {
    delete process.env.MUX_PROXY_URI;
  } else {
    process.env.MUX_PROXY_URI = env.muxProxyUri;
  }

  if (env.vscodeProxyUri === undefined) {
    delete process.env.VSCODE_PROXY_URI;
  } else {
    process.env.VSCODE_PROXY_URI = env.vscodeProxyUri;
  }

  try {
    return await run();
  } finally {
    if (previousMuxProxyUri === undefined) {
      delete process.env.MUX_PROXY_URI;
    } else {
      process.env.MUX_PROXY_URI = previousMuxProxyUri;
    }

    if (previousVscodeProxyUri === undefined) {
      delete process.env.VSCODE_PROXY_URI;
    } else {
      process.env.VSCODE_PROXY_URI = previousVscodeProxyUri;
    }
  }
}

const APP_PROXY_BASE_PATH = "/@u/ws/apps/mux";
const APP_PROXY_BASE_PATH_ALT = "/@alice/dev/apps/mux";

function countOccurrences(value: string, needle: string): number {
  return value.split(needle).length - 1;
}

function expectSlashlessRootRedirectBeforeBase(html: string, baseHref: string): void {
  const redirectIndex = html.indexOf("location.replace(location.origin+pathname");
  const baseIndex = html.indexOf(`<base href="${baseHref}"`);
  expect(redirectIndex).toBeGreaterThanOrEqual(0);
  expect(baseIndex).toBeGreaterThan(redirectIndex);
}

async function createStaticTestServer(
  options: {
    files?: Record<string, string>;
    context?: Partial<ORPCContext>;
    authToken?: string;
  } = {}
): Promise<{
  server: Awaited<ReturnType<typeof createOrpcServer>>;
  tempDir: string;
  close: () => Promise<void>;
}> {
  const tempDir = await fs.mkdtemp(path.join(os.tmpdir(), "mux-static-app-proxy-"));
  const files = {
    "index.html":
      "<!doctype html><html><head><title>mux</title></head><body><div>ok</div></body></html>",
    ...options.files,
  };

  for (const [filePath, contents] of Object.entries(files)) {
    const absolutePath = path.join(tempDir, filePath);
    await fs.mkdir(path.dirname(absolutePath), { recursive: true });
    await fs.writeFile(absolutePath, contents, "utf-8");
  }

  let server: Awaited<ReturnType<typeof createOrpcServer>> | null = null;
  try {
    server = await createOrpcServer({
      host: "127.0.0.1",
      port: 0,
      context: (options.context ?? {}) as ORPCContext,
      authToken: options.authToken,
      serveStatic: true,
      staticDir: tempDir,
    });
  } catch (error) {
    await fs.rm(tempDir, { recursive: true, force: true });
    throw error;
  }

  return {
    server,
    tempDir,
    close: async () => {
      await server?.close();
      await fs.rm(tempDir, { recursive: true, force: true });
    },
  };
}

type TestOrpcServer = Awaited<ReturnType<typeof createOrpcServer>>;

type ServerOptions = Omit<Parameters<typeof createOrpcServer>[0], "host" | "port" | "context">;

async function withTestOrpcServer<T>(
  run: (server: TestOrpcServer) => Promise<T>,
  options: ServerOptions = {}
): Promise<T> {
  const server = await createOrpcServer({
    host: "127.0.0.1",
    port: 0,
    // Tests in this file don't exercise context services unless explicitly supplied.
    // eslint-disable-next-line @typescript-eslint/consistent-type-assertions
    context: {} as ORPCContext,
    ...options,
  });

  try {
    return await run(server);
  } finally {
    await server.close();
  }
}

type OriginHeaders = Record<string, string> | ((server: TestOrpcServer) => Record<string, string>);

function resolveOriginHeaders(
  headers: OriginHeaders | undefined,
  server: TestOrpcServer
): Record<string, string> | undefined {
  return typeof headers === "function" ? headers(server) : headers;
}

async function expectHttpOriginCase(input: {
  headers?: OriginHeaders;
  status: number;
  allowOrigin?: string | null | ((server: TestOrpcServer) => string | null);
  allowHttpOrigin?: boolean;
}): Promise<void> {
  await withTestOrpcServer(
    async (server) => {
      const response = await fetch(`${server.baseUrl}/api/spec.json`, {
        headers: resolveOriginHeaders(input.headers, server),
      });

      expect(response.status).toBe(input.status);
      if (input.allowOrigin !== undefined) {
        const allowOrigin =
          typeof input.allowOrigin === "function" ? input.allowOrigin(server) : input.allowOrigin;
        expect(response.headers.get("access-control-allow-origin")).toBe(allowOrigin);
        if (allowOrigin != null) {
          expect(response.headers.get("access-control-allow-credentials")).toBe("true");
        }
      }
    },
    input.allowHttpOrigin ? { allowHttpOrigin: true } : {}
  );
}

async function expectWebSocketOriginCase(input: {
  headers?: OriginHeaders;
  accepted: boolean;
  allowHttpOrigin?: boolean;
}): Promise<void> {
  await withTestOrpcServer(
    async (server) => {
      const ws = new WebSocket(server.wsUrl, {
        headers: resolveOriginHeaders(input.headers, server),
      });

      try {
        if (input.accepted) {
          await waitForWebSocketOpen(ws);
          await closeWebSocket(ws);
        } else {
          await waitForWebSocketRejection(ws);
        }
      } finally {
        ws.terminate();
      }
    },
    input.allowHttpOrigin ? { allowHttpOrigin: true } : {}
  );
}

describe("createOrpcServer", () => {
  test("serveStatic fallback does not swallow /api routes", async () => {
    // Minimal context stub - router won't be exercised by this test.
    const stubContext: Partial<ORPCContext> = {};

    const tempDir = await fs.mkdtemp(path.join(os.tmpdir(), "mux-static-"));
    const indexHtml =
      "<!doctype html><html><head><title>mux</title></head><body><div>ok</div></body></html>";

    let server: Awaited<ReturnType<typeof createOrpcServer>> | null = null;

    try {
      await fs.writeFile(path.join(tempDir, "index.html"), indexHtml, "utf-8");

      server = await createOrpcServer({
        host: "127.0.0.1",
        port: 0,
        context: stubContext as ORPCContext,
        authToken: "test-token",
        serveStatic: true,
        staticDir: tempDir,
      });

      const uiRes = await fetch(`${server.baseUrl}/some/spa/route`);
      expect(uiRes.status).toBe(200);
      const uiText = await uiRes.text();
      expect(uiText).toContain("mux");
      expect(uiText).toContain('<base href="./../../"');

      const apiRes = await fetch(`${server.baseUrl}/api/not-a-real-route`);
      expect(apiRes.status).toBe(404);
    } finally {
      await server?.close();
      await fs.rm(tempDir, { recursive: true, force: true });
    }
  });

  test("serves SPA base href from the detected public base path per request", async () => {
    const { server, close } = await createStaticTestServer();

    try {
      const rootRes = await fetch(`${server.baseUrl}/`);
      expect(rootRes.status).toBe(200);
      const rootHtml = await rootRes.text();
      expect(countOccurrences(rootHtml, '<base href="./" />')).toBe(1);
      expectSlashlessRootRedirectBeforeBase(rootHtml, "./");

      const doubleSlashRes = await fetch(`${server.baseUrl}//attacker.example`);
      expect(doubleSlashRes.status).toBe(200);
      const doubleSlashHtml = await doubleSlashRes.text();
      expect(doubleSlashHtml).not.toContain("location.replace(location.origin+pathname");

      const deepRouteRes = await fetch(`${server.baseUrl}/some/spa/route`);
      expect(deepRouteRes.status).toBe(200);
      const deepRouteHtml = await deepRouteRes.text();
      expect(deepRouteHtml).toContain('<base href="./../../" />');
      expect(deepRouteHtml).not.toContain("location.replace(location.pathname");

      const directoryRouteRes = await fetch(`${server.baseUrl}/some/spa/route/`);
      expect(directoryRouteRes.status).toBe(200);
      expect(await directoryRouteRes.text()).toContain('<base href="./../../../" />');

      const forwardedPrefixRes = await fetch(`${server.baseUrl}/some/spa/route`, {
        headers: { "X-Forwarded-Prefix": APP_PROXY_BASE_PATH },
      });
      expect(forwardedPrefixRes.status).toBe(200);
      const forwardedPrefixHtml = await forwardedPrefixRes.text();
      expect(forwardedPrefixHtml).toContain(`<base href="${APP_PROXY_BASE_PATH}/" />`);

      const originalUriRes = await fetch(`${server.baseUrl}/`, {
        headers: { "X-Original-Uri": `${APP_PROXY_BASE_PATH}/` },
      });
      expect(originalUriRes.status).toBe(200);
      const originalUriHtml = await originalUriRes.text();
      expect(originalUriHtml).toContain(`<base href="${APP_PROXY_BASE_PATH}/" />`);

      const firstPrefixRes = await fetch(`${server.baseUrl}/one`, {
        headers: { "X-Forwarded-Prefix": APP_PROXY_BASE_PATH },
      });
      const secondPrefixRes = await fetch(`${server.baseUrl}/two`, {
        headers: { "X-Forwarded-Prefix": APP_PROXY_BASE_PATH_ALT },
      });
      expect(await firstPrefixRes.text()).toContain(`<base href="${APP_PROXY_BASE_PATH}/" />`);
      expect(await secondPrefixRes.text()).toContain(`<base href="${APP_PROXY_BASE_PATH_ALT}/" />`);
    } finally {
      await close();
    }
  });

  test("routes direct app-proxy HTTP requests to root-mounted handlers", async () => {
    const mainJs = "console.log('prefixed asset');";
    const authContext: Partial<ORPCContext> = {
      serverAuthService: {
        isGithubDeviceFlowEnabled: () => true,
      } as unknown as ORPCContext["serverAuthService"],
    };
    const { server, close } = await createStaticTestServer({
      files: { "assets/main.js": mainJs },
      context: authContext,
    });

    try {
      const rootAssetRes = await fetch(`${server.baseUrl}/assets/main.js`);
      const prefixedAssetRes = await fetch(
        `${server.baseUrl}${APP_PROXY_BASE_PATH}/assets/main.js`
      );
      expect(prefixedAssetRes.status).toBe(200);
      expect(await prefixedAssetRes.text()).toBe(await rootAssetRes.text());

      const prefixedRootRes = await fetch(`${server.baseUrl}${APP_PROXY_BASE_PATH}`);
      expect(prefixedRootRes.status).toBe(200);
      const prefixedRootHtml = await prefixedRootRes.text();
      expect(prefixedRootHtml).toContain(`<base href="${APP_PROXY_BASE_PATH}/" />`);
      expectSlashlessRootRedirectBeforeBase(prefixedRootHtml, `${APP_PROXY_BASE_PATH}/`);

      const coderUrlRes = await fetch(
        `${server.baseUrl}/@admin/mux-workspace-095801.main/apps/mux/?token=redacted`
      );
      expect(coderUrlRes.status).toBe(200);
      const coderUrlHtml = await coderUrlRes.text();
      expect(coderUrlHtml).toContain('<base href="/@admin/mux-workspace-095801.main/apps/mux/" />');
      expectSlashlessRootRedirectBeforeBase(
        coderUrlHtml,
        "/@admin/mux-workspace-095801.main/apps/mux/"
      );

      const prefixedSpaRes = await fetch(`${server.baseUrl}${APP_PROXY_BASE_PATH}/settings`);
      expect(prefixedSpaRes.status).toBe(200);
      expect(await prefixedSpaRes.text()).toContain(`<base href="${APP_PROXY_BASE_PATH}/" />`);

      const specRes = await fetch(`${server.baseUrl}${APP_PROXY_BASE_PATH}/api/spec.json`);
      expect(specRes.status).toBe(200);
      expect(specRes.headers.get("content-type")).toContain("application/json");
      const spec = (await specRes.json()) as { servers?: Array<{ url?: string }> };
      expect(spec.servers?.[0]?.url).toBe(`${APP_PROXY_BASE_PATH}/api`);

      const docsRes = await fetch(`${server.baseUrl}${APP_PROXY_BASE_PATH}/api/docs`);
      expect(docsRes.status).toBe(200);
      expect(await docsRes.text()).toContain(`${APP_PROXY_BASE_PATH}/api/spec.json`);

      const authRes = await fetch(
        `${server.baseUrl}${APP_PROXY_BASE_PATH}/auth/server-login/options`
      );
      expect(authRes.status).toBe(200);
      expect(await authRes.json()).toEqual({ githubDeviceFlowEnabled: true });

      const client = createHttpClient(`${server.baseUrl}${APP_PROXY_BASE_PATH}`);
      const pingResult = await Promise.resolve(client.general.ping("app-proxy"));
      expect(pingResult).toBe("Pong: app-proxy");

      const falsePositiveRes = await fetch(`${server.baseUrl}/projects/apps/other`);
      expect(falsePositiveRes.status).toBe(200);
      expect(await falsePositiveRes.text()).toContain('<base href="./../../" />');
    } finally {
      await close();
    }
  });

  test("keeps origin validation active after direct app-proxy prefix stripping", async () => {
    const stubContext: Partial<ORPCContext> = {};
    let server: Awaited<ReturnType<typeof createOrpcServer>> | null = null;

    try {
      server = await createOrpcServer({
        host: "127.0.0.1",
        port: 0,
        context: stubContext as ORPCContext,
      });

      const rootResponse = await fetch(`${server.baseUrl}/orpc`, {
        headers: { Origin: "https://evil.example.com" },
      });
      const prefixedResponse = await fetch(`${server.baseUrl}${APP_PROXY_BASE_PATH}/orpc`, {
        headers: { Origin: "https://evil.example.com" },
      });

      expect(rootResponse.status).toBe(403);
      expect(prefixedResponse.status).toBe(rootResponse.status);
    } finally {
      await server?.close();
    }
  });

  test("serves Scalar docs with request-specific spec URLs", async () => {
    const { server, close } = await createStaticTestServer();

    try {
      const rootDocsRes = await fetch(`${server.baseUrl}/api/docs`);
      expect(rootDocsRes.status).toBe(200);
      expect(await rootDocsRes.text()).toContain('url: "/api/spec.json"');

      const forwardedDocsRes = await fetch(`${server.baseUrl}/api/docs`, {
        headers: { "X-Forwarded-Prefix": APP_PROXY_BASE_PATH },
      });
      expect(forwardedDocsRes.status).toBe(200);
      expect(await forwardedDocsRes.text()).toContain(
        `url: "${APP_PROXY_BASE_PATH}/api/spec.json"`
      );

      const directDocsRes = await fetch(`${server.baseUrl}${APP_PROXY_BASE_PATH}/api/docs`);
      expect(directDocsRes.status).toBe(200);
      expect(await directDocsRes.text()).toContain(`url: "${APP_PROXY_BASE_PATH}/api/spec.json"`);
    } finally {
      await close();
    }
  });

  test("accepts direct app-proxy WebSocket upgrades", async () => {
    const stubContext: Partial<ORPCContext> = {};
    let server: Awaited<ReturnType<typeof createOrpcServer>> | null = null;
    let ws: WebSocket | null = null;

    try {
      server = await createOrpcServer({
        host: "127.0.0.1",
        port: 0,
        context: stubContext as ORPCContext,
      });

      ws = new WebSocket(
        `${server.baseUrl.replace(/^http/, "ws")}${APP_PROXY_BASE_PATH}/orpc/ws?token=test-token`
      );

      await waitForWebSocketOpen(ws);
      await closeWebSocket(ws);
      ws = null;
    } finally {
      ws?.terminate();
      await server?.close();
    }
  });

  test("includes app-proxy base paths in OAuth redirect and callback return URLs", async () => {
    let muxGatewayRedirectUri = "";
    const stubContext: Partial<ORPCContext> = {
      muxGatewayOauthService: {
        startServerFlow: (input: { redirectUri: string }) => {
          muxGatewayRedirectUri = input.redirectUri;
          return { authorizeUrl: "https://gateway.example.com/auth", state: "state-gateway" };
        },
        handleServerCallbackAndExchange: () => Promise.resolve({ success: true, data: undefined }),
      } as unknown as ORPCContext["muxGatewayOauthService"],
    };
    let server: Awaited<ReturnType<typeof createOrpcServer>> | null = null;

    try {
      server = await createOrpcServer({
        host: "127.0.0.1",
        port: 0,
        context: stubContext as ORPCContext,
        authToken: "test-token",
      });

      const startResponse = await fetch(`${server.baseUrl}/auth/mux-gateway/start`, {
        headers: {
          Authorization: "Bearer test-token",
          "X-Forwarded-Prefix": APP_PROXY_BASE_PATH,
        },
      });
      expect(startResponse.status).toBe(200);
      expect(muxGatewayRedirectUri).toBe(
        `${server.baseUrl}${APP_PROXY_BASE_PATH}/auth/mux-gateway/callback`
      );

      const callbackResponse = await fetch(
        `${server.baseUrl}${APP_PROXY_BASE_PATH}/auth/mux-gateway/callback?state=test&code=test`
      );
      expect(callbackResponse.status).toBe(200);
      const callbackHtml = await callbackResponse.text();
      expect(callbackHtml).toContain(`href="${APP_PROXY_BASE_PATH}/"`);
      expect(callbackHtml).toContain(`window.location.replace("${APP_PROXY_BASE_PATH}/")`);
    } finally {
      await server?.close();
    }
  });

  test("injects proxy URI template into SPA fallback HTML when env is set", async () => {
    const stubContext: Partial<ORPCContext> = {};

    const tempDir = await fs.mkdtemp(path.join(os.tmpdir(), "mux-static-proxy-template-"));
    const indexHtml =
      "<!doctype html><html><head><title>mux</title></head><body><div>ok</div></body></html>";
    const muxProxyUri = "https://proxy-{{port}}.example.test/path</script>";

    try {
      await fs.writeFile(path.join(tempDir, "index.html"), indexHtml, "utf-8");

      await withProxyUriTemplateEnv({ muxProxyUri }, async () => {
        const server = await createOrpcServer({
          host: "127.0.0.1",
          port: 0,
          context: stubContext as ORPCContext,
          authToken: "test-token",
          serveStatic: true,
          staticDir: tempDir,
        });

        try {
          const rootRes = await fetch(`${server.baseUrl}/`);
          expect(rootRes.status).toBe(200);
          const rootHtml = await rootRes.text();

          const uiRes = await fetch(`${server.baseUrl}/some/spa/route`);
          expect(uiRes.status).toBe(200);
          const uiText = await uiRes.text();

          expect(rootHtml).toContain('<base href="./"');
          expect(uiText).toContain('<base href="./../../"');

          for (const html of [rootHtml, uiText]) {
            expect(html).toContain("window.__MUX_PROXY_URI_TEMPLATE__ =");
            expect(html).toContain(
              'window.__MUX_PROXY_URI_TEMPLATE__ = "https://proxy-{{port}}.example.test/path\\u003c/script>";'
            );
          }
        } finally {
          await server.close();
        }
      });
    } finally {
      await fs.rm(tempDir, { recursive: true, force: true });
    }
  });

  test("injects null proxy URI template into SPA fallback HTML when env vars are absent", async () => {
    const stubContext: Partial<ORPCContext> = {};

    const tempDir = await fs.mkdtemp(path.join(os.tmpdir(), "mux-static-proxy-template-null-"));
    const indexHtml =
      "<!doctype html><html><head><title>mux</title></head><body><div>ok</div></body></html>";

    try {
      await fs.writeFile(path.join(tempDir, "index.html"), indexHtml, "utf-8");

      await withProxyUriTemplateEnv({}, async () => {
        const server = await createOrpcServer({
          host: "127.0.0.1",
          port: 0,
          context: stubContext as ORPCContext,
          authToken: "test-token",
          serveStatic: true,
          staticDir: tempDir,
        });

        try {
          const rootRes = await fetch(`${server.baseUrl}/`);
          expect(rootRes.status).toBe(200);
          const rootHtml = await rootRes.text();

          const uiRes = await fetch(`${server.baseUrl}/some/spa/route`);
          expect(uiRes.status).toBe(200);
          const uiText = await uiRes.text();

          for (const html of [rootHtml, uiText]) {
            expect(html).toContain("window.__MUX_PROXY_URI_TEMPLATE__ = null;");
          }
        } finally {
          await server.close();
        }
      });
    } finally {
      await fs.rm(tempDir, { recursive: true, force: true });
    }
  });

  test("does not apply origin validation to static and SPA fallback routes", async () => {
    // Static app shell must remain reachable even if proxy/header rewriting makes
    // request Origin values unexpected. API/WS/auth routes are validated separately.
    const stubContext: Partial<ORPCContext> = {};

    const tempDir = await fs.mkdtemp(path.join(os.tmpdir(), "mux-static-origin-"));
    const indexHtml =
      "<!doctype html><html><head><title>mux</title></head><body><div>ok</div></body></html>";
    const mainJs = "console.log('ok');";
    const mainCss = "body { color: #fff; }";

    let server: Awaited<ReturnType<typeof createOrpcServer>> | null = null;

    try {
      await fs.writeFile(path.join(tempDir, "index.html"), indexHtml, "utf-8");
      await fs.writeFile(path.join(tempDir, "main.js"), mainJs, "utf-8");
      await fs.writeFile(path.join(tempDir, "main.css"), mainCss, "utf-8");

      server = await createOrpcServer({
        host: "127.0.0.1",
        port: 0,
        context: stubContext as ORPCContext,
        authToken: "test-token",
        serveStatic: true,
        staticDir: tempDir,
      });

      const directIndexResponse = await fetch(`${server.baseUrl}/`, {
        headers: { Origin: "https://evil.example.com" },
      });
      expect(directIndexResponse.status).toBe(200);
      expect(directIndexResponse.headers.get("access-control-allow-origin")).toBeNull();

      const staticJsResponse = await fetch(`${server.baseUrl}/main.js`, {
        headers: { Origin: "https://evil.example.com" },
      });
      expect(staticJsResponse.status).toBe(200);
      expect(staticJsResponse.headers.get("access-control-allow-origin")).toBeNull();

      const staticCssResponse = await fetch(`${server.baseUrl}/main.css`, {
        headers: { Origin: "https://evil.example.com" },
      });
      expect(staticCssResponse.status).toBe(200);
      expect(staticCssResponse.headers.get("access-control-allow-origin")).toBeNull();

      const fallbackRouteResponse = await fetch(`${server.baseUrl}/some/spa/route`, {
        headers: { Origin: "https://evil.example.com" },
      });
      expect(fallbackRouteResponse.status).toBe(200);
      expect(fallbackRouteResponse.headers.get("access-control-allow-origin")).toBeNull();
    } finally {
      await server?.close();
      await fs.rm(tempDir, { recursive: true, force: true });
    }
  });

  test("reports whether GitHub device-flow login is enabled", async () => {
    async function runCase(enabled: boolean): Promise<void> {
      const stubContext: Partial<ORPCContext> = {
        serverAuthService: {
          isGithubDeviceFlowEnabled: () => enabled,
        } as unknown as ORPCContext["serverAuthService"],
      };

      let server: Awaited<ReturnType<typeof createOrpcServer>> | null = null;

      try {
        server = await createOrpcServer({
          host: "127.0.0.1",
          port: 0,
          context: stubContext as ORPCContext,
        });

        const response = await fetch(`${server.baseUrl}/auth/server-login/options`);
        expect(response.status).toBe(200);

        const payload = (await response.json()) as { githubDeviceFlowEnabled?: boolean };
        expect(payload.githubDeviceFlowEnabled).toBe(enabled);
      } finally {
        await server?.close();
      }
    }

    await runCase(false);
    await runCase(true);
  });

  test("returns 429 when GitHub device-flow start is rate limited", async () => {
    const stubContext: Partial<ORPCContext> = {
      serverAuthService: {
        startGithubDeviceFlow: () =>
          Promise.resolve({
            success: false,
            error: "Too many concurrent GitHub login attempts. Please wait and try again.",
          }),
      } as unknown as ORPCContext["serverAuthService"],
    };

    let server: Awaited<ReturnType<typeof createOrpcServer>> | null = null;

    try {
      server = await createOrpcServer({
        host: "127.0.0.1",
        port: 0,
        context: stubContext as ORPCContext,
      });

      const response = await fetch(`${server.baseUrl}/auth/server-login/github/start`, {
        method: "POST",
      });
      expect(response.status).toBe(429);
    } finally {
      await server?.close();
    }
  });

  test("uses HTTPS redirect URIs for OAuth start routes when allowHttpOrigin is enabled", async () => {
    let muxGatewayRedirectUri = "";
    let muxGovernorRedirectUri = "";

    const stubContext: Partial<ORPCContext> = {
      muxGatewayOauthService: {
        startServerFlow: (input: { redirectUri: string }) => {
          muxGatewayRedirectUri = input.redirectUri;
          return { authorizeUrl: "https://gateway.example.com/auth", state: "state-gateway" };
        },
      } as unknown as ORPCContext["muxGatewayOauthService"],
      muxGovernorOauthService: {
        startServerFlow: (input: { governorOrigin: string; redirectUri: string }) => {
          muxGovernorRedirectUri = input.redirectUri;
          return {
            success: true,
            data: { authorizeUrl: "https://governor.example.com/auth", state: "state-governor" },
          };
        },
      } as unknown as ORPCContext["muxGovernorOauthService"],
    };

    let server: Awaited<ReturnType<typeof createOrpcServer>> | null = null;

    try {
      server = await createOrpcServer({
        host: "127.0.0.1",
        port: 0,
        context: stubContext as ORPCContext,
        authToken: "test-token",
        allowHttpOrigin: true,
      });

      const sharedHeaders = {
        Authorization: "Bearer test-token",
        Origin: "https://mux-public.example.com",
        "X-Forwarded-Host": "mux-public.example.com:443",
        "X-Forwarded-Proto": "http",
      };

      const muxGatewayResponse = await fetch(`${server.baseUrl}/auth/mux-gateway/start`, {
        headers: sharedHeaders,
      });
      expect(muxGatewayResponse.status).toBe(200);

      const muxGovernorResponse = await fetch(
        `${server.baseUrl}/auth/mux-governor/start?governorUrl=${encodeURIComponent("https://governor.example.com")}`,
        {
          headers: sharedHeaders,
        }
      );
      expect(muxGovernorResponse.status).toBe(200);

      expect(muxGatewayRedirectUri).toBe(
        "https://mux-public.example.com/auth/mux-gateway/callback"
      );
      expect(muxGovernorRedirectUri).toBe(
        "https://mux-public.example.com/auth/mux-governor/callback"
      );
    } finally {
      await server?.close();
    }
  });

  test("uses HTTP redirect URIs for OAuth start routes when client-facing proto is HTTP", async () => {
    let muxGatewayRedirectUri = "";

    const stubContext: Partial<ORPCContext> = {
      muxGatewayOauthService: {
        startServerFlow: (input: { redirectUri: string }) => {
          muxGatewayRedirectUri = input.redirectUri;
          return { authorizeUrl: "https://gateway.example.com/auth", state: "state-gateway-http" };
        },
      } as unknown as ORPCContext["muxGatewayOauthService"],
    };

    let server: Awaited<ReturnType<typeof createOrpcServer>> | null = null;

    try {
      server = await createOrpcServer({
        host: "127.0.0.1",
        port: 0,
        context: stubContext as ORPCContext,
        authToken: "test-token",
      });

      const response = await fetch(`${server.baseUrl}/auth/mux-gateway/start`, {
        headers: {
          Authorization: "Bearer test-token",
          Origin: server.baseUrl,
          "X-Forwarded-Proto": "http,https",
        },
      });

      expect(response.status).toBe(200);
      expect(muxGatewayRedirectUri).toBe(`${server.baseUrl}/auth/mux-gateway/callback`);
    } finally {
      await server?.close();
    }
  });

  test("scopes mux_session cookie path to forwarded app base path", async () => {
    const stubContext: Partial<ORPCContext> = {
      serverAuthService: {
        waitForGithubDeviceFlow: () =>
          Promise.resolve({
            success: true,
            data: { sessionId: "session-1", sessionToken: "session-token-1" },
          }),
        cancelGithubDeviceFlow: () => {
          // no-op for this test
        },
      } as unknown as ORPCContext["serverAuthService"],
    };

    let server: Awaited<ReturnType<typeof createOrpcServer>> | null = null;

    try {
      server = await createOrpcServer({
        host: "127.0.0.1",
        port: 0,
        context: stubContext as ORPCContext,
      });

      const response = await fetch(`${server.baseUrl}/auth/server-login/github/wait`, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "X-Forwarded-Prefix": "/@test/workspace/apps/mux/",
        },
        body: JSON.stringify({ flowId: "flow-1" }),
      });

      expect(response.status).toBe(200);
      const cookieHeader = response.headers.get("set-cookie");
      expect(cookieHeader).toBeTruthy();
      expect(cookieHeader).toContain("mux_session=session-token-1");
      expect(cookieHeader).toContain("Path=/@test/workspace/apps/mux;");
    } finally {
      await server?.close();
    }
  });

  test("sets Secure mux_session cookie when allowHttpOrigin is enabled", async () => {
    const stubContext: Partial<ORPCContext> = {
      serverAuthService: {
        waitForGithubDeviceFlow: () =>
          Promise.resolve({
            success: true,
            data: { sessionId: "session-2", sessionToken: "session-token-compat" },
          }),
        cancelGithubDeviceFlow: () => {
          // no-op for this test
        },
      } as unknown as ORPCContext["serverAuthService"],
    };

    let server: Awaited<ReturnType<typeof createOrpcServer>> | null = null;

    try {
      server = await createOrpcServer({
        host: "127.0.0.1",
        port: 0,
        context: stubContext as ORPCContext,
        allowHttpOrigin: true,
      });

      const response = await fetch(`${server.baseUrl}/auth/server-login/github/wait`, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Origin: "https://mux-public.example.com",
          "X-Forwarded-Host": "mux-public.example.com:443",
          "X-Forwarded-Proto": "http",
        },
        body: JSON.stringify({ flowId: "flow-compat" }),
      });

      expect(response.status).toBe(200);
      const cookieHeader = response.headers.get("set-cookie");
      expect(cookieHeader).toBeTruthy();
      expect(cookieHeader).toContain("mux_session=session-token-compat");
      expect(cookieHeader).toContain("; Secure");
    } finally {
      await server?.close();
    }
  });

  test("does not set Secure mux_session cookie when client-facing proto is HTTP", async () => {
    const stubContext: Partial<ORPCContext> = {
      serverAuthService: {
        waitForGithubDeviceFlow: () =>
          Promise.resolve({
            success: true,
            data: { sessionId: "session-3", sessionToken: "session-token-http" },
          }),
        cancelGithubDeviceFlow: () => {
          // no-op for this test
        },
      } as unknown as ORPCContext["serverAuthService"],
    };

    let server: Awaited<ReturnType<typeof createOrpcServer>> | null = null;

    try {
      server = await createOrpcServer({
        host: "127.0.0.1",
        port: 0,
        context: stubContext as ORPCContext,
      });

      const response = await fetch(`${server.baseUrl}/auth/server-login/github/wait`, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Origin: server.baseUrl,
          "X-Forwarded-Proto": "http,https",
        },
        body: JSON.stringify({ flowId: "flow-http" }),
      });

      expect(response.status).toBe(200);
      const cookieHeader = response.headers.get("set-cookie");
      expect(cookieHeader).toBeTruthy();
      expect(cookieHeader).toContain("mux_session=session-token-http");
      expect(cookieHeader).not.toContain("; Secure");
    } finally {
      await server?.close();
    }
  });

  test("workspace.createMultiProject rejects direct IPC calls when the experiment is disabled", async () => {
    const createMultiProjectMock = mock(() => {
      throw new Error("workspaceService.createMultiProject should not be called");
    });
    const stubContext: Partial<ORPCContext> = {
      workspaceService: {
        createMultiProject: createMultiProjectMock,
      } as unknown as ORPCContext["workspaceService"],
      experimentsService: {
        isExperimentEnabled: () => false,
      } as unknown as ORPCContext["experimentsService"],
    };

    let server: Awaited<ReturnType<typeof createOrpcServer>> | null = null;

    try {
      server = await createOrpcServer({
        host: "127.0.0.1",
        port: 0,
        context: stubContext as ORPCContext,
        authToken: "test-token",
      });

      const client = createHttpClient(server.baseUrl, {
        Authorization: "Bearer test-token",
      });

      let error: unknown = null;
      try {
        await Promise.resolve(
          client.workspace.createMultiProject({
            projects: [
              { projectPath: "/tmp/project-a", projectName: "project-a" },
              { projectPath: "/tmp/project-b", projectName: "project-b" },
            ],
            branchName: "feature-disabled",
            trunkBranch: "main",
          })
        );
      } catch (caughtError) {
        error = caughtError;
      }

      expect(error).toBeTruthy();
      expect(createMultiProjectMock).not.toHaveBeenCalled();
      const message =
        error && typeof error === "object" && "message" in error
          ? (error as { message?: unknown }).message
          : "";
      expect(String(message)).toContain("Multi-project workspaces experiment is disabled");
    } finally {
      await server?.close();
    }
  });

  test("accepts ORPC requests authenticated via mux_session cookie", async () => {
    const stubContext: Partial<ORPCContext> = {
      serverAuthService: {
        validateSessionToken: (token: string) => {
          if (token === "valid-session-token") {
            return Promise.resolve({ sessionId: "session-1" });
          }
          return Promise.resolve(null);
        },
      } as unknown as ORPCContext["serverAuthService"],
    };

    let server: Awaited<ReturnType<typeof createOrpcServer>> | null = null;

    try {
      server = await createOrpcServer({
        host: "127.0.0.1",
        port: 0,
        context: stubContext as ORPCContext,
        authToken: "test-token",
      });

      const unauthenticatedClient = createHttpClient(server.baseUrl);

      let unauthenticatedError: unknown = null;
      try {
        await Promise.resolve(unauthenticatedClient.general.ping("cookie-auth"));
      } catch (error) {
        unauthenticatedError = error;
      }
      expect(unauthenticatedError).toBeTruthy();

      const duplicateCookieClient = createHttpClient(server.baseUrl, {
        Cookie: "mux_session=invalid-session-token; mux_session=valid-session-token",
      });
      const duplicateCookiePing = await Promise.resolve(
        duplicateCookieClient.general.ping("cookie-auth")
      );
      expect(duplicateCookiePing).toBe("Pong: cookie-auth");

      const cookieClient = createHttpClient(server.baseUrl, {
        Cookie: "mux_session=valid-session-token",
      });
      const authenticatedPing = await Promise.resolve(cookieClient.general.ping("cookie-auth"));
      expect(authenticatedPing).toBe("Pong: cookie-auth");
    } finally {
      await server?.close();
    }
  });

  test("OAuth callback routes accept POST redirects (query + form_post)", async () => {
    const stubContext: Partial<ORPCContext> = {
      muxGovernorOauthService: {
        handleServerCallbackAndExchange: () => Promise.resolve({ success: true, data: undefined }),
      } as unknown as ORPCContext["muxGovernorOauthService"],
    };

    let server: Awaited<ReturnType<typeof createOrpcServer>> | null = null;

    try {
      server = await createOrpcServer({
        host: "127.0.0.1",
        port: 0,
        context: stubContext as ORPCContext,
      });

      // Some OAuth providers issue 307/308 redirects which preserve POST.
      const queryRes = await fetch(
        `${server.baseUrl}/auth/mux-governor/callback?state=test-state&code=test-code`,
        { method: "POST" }
      );
      expect(queryRes.status).toBe(200);
      const queryText = await queryRes.text();
      expect(queryText).toContain("Enrollment complete");

      // response_mode=form_post delivers params in the request body.
      const formRes = await fetch(`${server.baseUrl}/auth/mux-governor/callback`, {
        method: "POST",
        headers: { "Content-Type": "application/x-www-form-urlencoded" },
        body: "state=test-state&code=test-code",
      });
      expect(formRes.status).toBe(200);
      const formText = await formRes.text();
      expect(formText).toContain("Enrollment complete");
    } finally {
      await server?.close();
    }
  });

  test("allows cross-origin POST requests on OAuth callback routes", async () => {
    const handleSuccessfulCallback = () => Promise.resolve({ success: true, data: undefined });
    const stubContext: Partial<ORPCContext> = {
      muxGatewayOauthService: {
        handleServerCallbackAndExchange: handleSuccessfulCallback,
      } as unknown as ORPCContext["muxGatewayOauthService"],
      muxGovernorOauthService: {
        handleServerCallbackAndExchange: handleSuccessfulCallback,
      } as unknown as ORPCContext["muxGovernorOauthService"],
      mcpOauthService: {
        handleServerCallbackAndExchange: handleSuccessfulCallback,
      } as unknown as ORPCContext["mcpOauthService"],
      coderOauthService: {
        handleServerCallback: handleSuccessfulCallback,
      } as unknown as ORPCContext["coderOauthService"],
    };

    let server: Awaited<ReturnType<typeof createOrpcServer>> | null = null;

    try {
      server = await createOrpcServer({
        host: "127.0.0.1",
        port: 0,
        context: stubContext as ORPCContext,
      });

      const callbackHeaders = {
        Origin: "https://evil.example.com",
        "Content-Type": "application/x-www-form-urlencoded",
      };

      const coderOauthResponse = await fetch(`${server.baseUrl}/auth/coder/callback`, {
        method: "POST",
        headers: callbackHeaders,
        body: "state=test-state&code=test-code",
      });
      expect(coderOauthResponse.status).toBe(200);
      expect(coderOauthResponse.headers.get("access-control-allow-origin")).toBeNull();

      const muxGatewayResponse = await fetch(`${server.baseUrl}/auth/mux-gateway/callback`, {
        method: "POST",
        headers: callbackHeaders,
        body: "state=test-state&code=test-code",
      });
      expect(muxGatewayResponse.status).toBe(200);
      expect(muxGatewayResponse.headers.get("access-control-allow-origin")).toBeNull();

      const muxGovernorResponse = await fetch(`${server.baseUrl}/auth/mux-governor/callback`, {
        method: "POST",
        headers: callbackHeaders,
        body: "state=test-state&code=test-code",
      });
      expect(muxGovernorResponse.status).toBe(200);
      expect(muxGovernorResponse.headers.get("access-control-allow-origin")).toBeNull();

      const mcpOauthResponse = await fetch(`${server.baseUrl}/auth/mcp-oauth/callback`, {
        method: "POST",
        headers: callbackHeaders,
        body: "state=test-state&code=test-code",
      });
      expect(mcpOauthResponse.status).toBe(200);
      expect(mcpOauthResponse.headers.get("access-control-allow-origin")).toBeNull();
    } finally {
      await server?.close();
    }
  });

  test("Coder OAuth start route builds a server-hosted redirect URI and the callback renders the flow outcome", async () => {
    const startCalls: Array<{ deploymentUrl: string; flowId?: string; redirectUri: string }> = [];
    const callbackCalls: Array<{
      state: string | null;
      code: string | null;
      error: string | null;
    }> = [];
    const stubContext: Partial<ORPCContext> = {
      coderOauthService: {
        startServerFlow: (input: {
          deploymentUrl: string;
          flowId?: string;
          redirectUri: string;
        }) => {
          startCalls.push(input);
          return Promise.resolve({
            success: true,
            data: {
              flowId: input.flowId ?? "generated",
              authorizeUrl: "https://coder.test/authorize",
            },
          });
        },
        handleServerCallback: (input: {
          state: string | null;
          code: string | null;
          error: string | null;
        }) => {
          callbackCalls.push(input);
          return Promise.resolve(
            input.state === "known-state"
              ? { success: true, data: undefined }
              : { success: false, error: "Unknown or expired OAuth state" }
          );
        },
      } as unknown as ORPCContext["coderOauthService"],
    };
    let server: Awaited<ReturnType<typeof createOrpcServer>> | null = null;

    try {
      server = await createOrpcServer({
        host: "127.0.0.1",
        port: 0,
        context: stubContext as ORPCContext,
        authToken: "test-token",
      });

      // Start requires auth: the route mints a registration on the deployment.
      const unauthenticated = await fetch(
        `${server.baseUrl}/auth/coder/start?deploymentUrl=https://coder.test`
      );
      expect(unauthenticated.status).toBe(401);
      expect(startCalls).toHaveLength(0);

      const missingDeployment = await fetch(`${server.baseUrl}/auth/coder/start`, {
        headers: { Authorization: "Bearer test-token" },
      });
      expect(missingDeployment.status).toBe(400);

      // The redirect URI is derived from the request (incl. app-proxy prefix),
      // never taken from the client.
      const startResponse = await fetch(
        `${server.baseUrl}/auth/coder/start?deploymentUrl=https://coder.test&flowId=flow-0123456789abcdef`,
        {
          headers: {
            Authorization: "Bearer test-token",
            "X-Forwarded-Prefix": APP_PROXY_BASE_PATH,
          },
        }
      );
      expect(startResponse.status).toBe(200);
      expect(await startResponse.json()).toEqual({
        flowId: "flow-0123456789abcdef",
        authorizeUrl: "https://coder.test/authorize",
      });
      expect(startCalls).toEqual([
        {
          deploymentUrl: "https://coder.test",
          flowId: "flow-0123456789abcdef",
          redirectUri: `${server.baseUrl}${APP_PROXY_BASE_PATH}/auth/coder/callback`,
        },
      ]);

      // Callback: unauthenticated navigation; outcome decides the page.
      const okResponse = await fetch(
        `${server.baseUrl}/auth/coder/callback?state=known-state&code=test-code`
      );
      expect(okResponse.status).toBe(200);
      const okHtml = await okResponse.text();
      expect(okHtml).toContain("Login complete");
      expect(okHtml).toContain('"type":"coder-oauth"');

      const failedResponse = await fetch(
        `${server.baseUrl}/auth/coder/callback?state=stale-state&code=test-code`
      );
      expect(failedResponse.status).toBe(400);
      expect(await failedResponse.text()).toContain("Unknown or expired OAuth state");
      expect(callbackCalls.map((c) => c.state)).toEqual(["known-state", "stale-state"]);
    } finally {
      await server?.close();
    }
  });

  test("brackets IPv6 hosts in returned URLs", async () => {
    // Minimal context stub - router won't be exercised by this test.
    const stubContext: Partial<ORPCContext> = {};

    let server: Awaited<ReturnType<typeof createOrpcServer>> | null = null;

    try {
      server = await createOrpcServer({
        host: "::1",
        port: 0,
        context: stubContext as ORPCContext,
        authToken: "test-token",
      });
    } catch (error) {
      const code = getErrorCode(error);

      // Some CI environments may not have IPv6 enabled.
      if (code === "EAFNOSUPPORT" || code === "EADDRNOTAVAIL") {
        return;
      }

      throw error;
    }

    try {
      expect(server.baseUrl).toMatch(/^http:\/\/\[::1\]:\d+$/);
      expect(server.wsUrl).toMatch(/^ws:\/\/\[::1\]:\d+\/orpc\/ws$/);
      expect(server.specUrl).toMatch(/^http:\/\/\[::1\]:\d+\/api\/spec\.json$/);
      expect(server.docsUrl).toMatch(/^http:\/\/\[::1\]:\d+\/api\/docs$/);
    } finally {
      await server.close();
    }
  });

  const httpOriginCases: Array<{
    name: string;
    headers?: OriginHeaders;
    status: number;
    allowOrigin?: string | null | ((server: TestOrpcServer) => string | null);
    allowHttpOrigin?: boolean;
  }> = [
    {
      name: "blocks cross-origin HTTP requests with Origin headers",
      headers: { Origin: "https://evil.example.com" },
      status: 403,
    },
    {
      name: "allows same-origin HTTP requests with Origin headers",
      headers: (server) => ({ Origin: server.baseUrl }),
      status: 200,
      allowOrigin: (server) => server.baseUrl,
    },
    {
      name: "allows same-origin HTTP requests when X-Forwarded-Host does not match",
      headers: (server) => ({
        Origin: server.baseUrl,
        "X-Forwarded-Host": "internal.proxy.local",
      }),
      status: 200,
      allowOrigin: (server) => server.baseUrl,
    },
    {
      name: "allows same-origin requests when X-Forwarded-Proto overrides inferred protocol",
      headers: (server) => ({
        Origin: server.baseUrl.replace(/^http:/, "https:"),
        "X-Forwarded-Proto": "https",
      }),
      status: 200,
      allowOrigin: (server) => server.baseUrl.replace(/^http:/, "https:"),
    },
    {
      name: "allows HTTP origins when X-Forwarded-Proto includes multiple hops with leading http",
      headers: (server) => ({
        Origin: server.baseUrl,
        "X-Forwarded-Proto": "http,https",
      }),
      status: 200,
      allowOrigin: (server) => server.baseUrl,
    },
    {
      name: "rejects HTTPS origins when X-Forwarded-Proto includes multiple hops with trailing https by default",
      headers: (server) => ({
        Origin: server.baseUrl.replace(/^http:/, "https:"),
        "X-Forwarded-Proto": "http,https",
      }),
      status: 403,
    },
    {
      name: "rejects HTTPS origins when X-Forwarded-Proto is overwritten to http by downstream proxy by default",
      headers: {
        Origin: "https://mux-public.example.com",
        "X-Forwarded-Host": "mux-public.example.com",
        "X-Forwarded-Proto": "http",
      },
      status: 403,
    },
    {
      name: "accepts HTTPS origins when allowHttpOrigin is enabled and X-Forwarded-Proto is overwritten to http by downstream proxy",
      headers: {
        Origin: "https://mux-public.example.com",
        "X-Forwarded-Host": "mux-public.example.com",
        "X-Forwarded-Proto": "http",
      },
      status: 200,
      allowOrigin: "https://mux-public.example.com",
      allowHttpOrigin: true,
    },
    {
      name: "allows HTTPS origins when allowHttpOrigin is enabled and overwritten proto uses forwarded host with explicit :443",
      headers: {
        Origin: "https://mux-public.example.com",
        "X-Forwarded-Host": "mux-public.example.com:443",
        "X-Forwarded-Proto": "http",
      },
      status: 200,
      allowOrigin: "https://mux-public.example.com",
      allowHttpOrigin: true,
    },
    {
      name: "rejects downgraded HTTP origins when X-Forwarded-Proto pins https",
      headers: (server) => ({
        Origin: server.baseUrl,
        "X-Forwarded-Proto": "https",
      }),
      status: 403,
    },
    {
      name: "rejects downgraded HTTP origins when X-Forwarded-Proto includes multiple hops",
      headers: (server) => ({
        Origin: server.baseUrl,
        "X-Forwarded-Proto": "https,http",
      }),
      status: 403,
    },
    {
      name: "allows HTTP requests without Origin headers",
      status: 200,
      allowOrigin: null,
    },
  ];

  for (const httpCase of httpOriginCases) {
    test(httpCase.name, async () => {
      await expectHttpOriginCase(httpCase);
    });
  }

  test("routes desktop WebSocket connections to the bridge server without ORPC origin validation", async () => {
    const stubContext: Partial<ORPCContext> = {};
    const desktopRelayServer = new WebSocketServer({ noServer: true });
    let desktopRelayServerStopped = false;
    const desktopRequests: Array<{ origin: string | null; url: string | undefined }> = [];
    const desktopBridgeServer = {
      handleUpgrade(
        req: Parameters<WebSocketServer["handleUpgrade"]>[0],
        socket: Parameters<WebSocketServer["handleUpgrade"]>[1],
        head: Parameters<WebSocketServer["handleUpgrade"]>[2]
      ) {
        desktopRelayServer.handleUpgrade(req, socket, head, (ws) => {
          desktopRelayServer.emit("connection", ws, req);
        });
      },
      async stop() {
        if (desktopRelayServerStopped) {
          return;
        }

        desktopRelayServerStopped = true;
        await new Promise<void>((resolve) => {
          desktopRelayServer.close(() => resolve());
        });
      },
    };

    desktopRelayServer.on("connection", (_ws, req) => {
      desktopRequests.push({
        origin: typeof req.headers.origin === "string" ? req.headers.origin : null,
        url: req.url,
      });
    });

    let server: Awaited<ReturnType<typeof createOrpcServer>> | null = null;
    let ws: WebSocket | null = null;

    try {
      server = await createOrpcServer({
        host: "127.0.0.1",
        port: 0,
        context: stubContext as ORPCContext,
        desktopBridgeServer,
      });

      ws = new WebSocket(
        `${server.baseUrl.replace(/^http/, "ws")}${DESKTOP_WS_PATH}?token=test-token`,
        {
          headers: { origin: "https://evil.example.com" },
        }
      );

      await waitForWebSocketOpen(ws);
      expect(desktopRequests).toEqual([
        {
          origin: "https://evil.example.com",
          url: `${DESKTOP_WS_PATH}?token=test-token`,
        },
      ]);

      await closeWebSocket(ws);
      ws = null;
    } finally {
      ws?.terminate();
      if (server) {
        await server.close();
      } else {
        await desktopBridgeServer.stop();
      }
    }
  });

  const webSocketOriginCases: Array<{
    name: string;
    headers?: OriginHeaders;
    accepted: boolean;
    allowHttpOrigin?: boolean;
  }> = [
    {
      name: "rejects cross-origin WebSocket connections",
      headers: { origin: "https://evil.example.com" },
      accepted: false,
    },
    {
      name: "accepts same-origin WebSocket connections",
      headers: (server) => ({ origin: server.baseUrl }),
      accepted: true,
    },
    {
      name: "accepts same-origin WebSocket connections when X-Forwarded-Host does not match",
      headers: (server) => ({
        origin: server.baseUrl,
        "x-forwarded-host": "internal.proxy.local",
      }),
      accepted: true,
    },
    {
      name: "accepts proxied HTTPS WebSocket origins when forwarded headers describe public app URL",
      headers: {
        origin: "https://mux-public.example.com",
        "x-forwarded-host": "mux-public.example.com",
        "x-forwarded-proto": "https",
      },
      accepted: true,
    },
    {
      name: "accepts HTTP WebSocket origins when X-Forwarded-Proto includes multiple hops with leading http",
      headers: (server) => ({
        origin: server.baseUrl,
        "x-forwarded-proto": "http,https",
      }),
      accepted: true,
    },
    {
      name: "rejects HTTPS WebSocket origins when X-Forwarded-Proto includes multiple hops with trailing https by default",
      headers: (server) => ({
        origin: server.baseUrl.replace(/^http:/, "https:"),
        "x-forwarded-proto": "http,https",
      }),
      accepted: false,
    },
    {
      name: "rejects HTTPS WebSocket origins when X-Forwarded-Proto is overwritten to http by downstream proxy by default",
      headers: {
        origin: "https://mux-public.example.com",
        "x-forwarded-host": "mux-public.example.com",
        "x-forwarded-proto": "http",
      },
      accepted: false,
    },
    {
      name: "accepts HTTPS WebSocket origins when allowHttpOrigin is enabled and X-Forwarded-Proto is overwritten to http by downstream proxy",
      headers: {
        origin: "https://mux-public.example.com",
        "x-forwarded-host": "mux-public.example.com",
        "x-forwarded-proto": "http",
      },
      accepted: true,
      allowHttpOrigin: true,
    },
    {
      name: "rejects downgraded WebSocket origins when X-Forwarded-Proto pins https",
      headers: (server) => ({
        origin: server.baseUrl,
        "x-forwarded-proto": "https",
      }),
      accepted: false,
    },
    {
      name: "rejects downgraded WebSocket origins when X-Forwarded-Proto includes multiple hops",
      headers: (server) => ({
        origin: server.baseUrl,
        "x-forwarded-proto": "https,http",
      }),
      accepted: false,
    },
    {
      name: "accepts WebSocket connections without Origin headers",
      accepted: true,
    },
  ];

  for (const wsCase of webSocketOriginCases) {
    test(wsCase.name, async () => {
      await expectWebSocketOriginCase(wsCase);
    });
  }

  test("returns restrictive CORS preflight headers for same-origin requests", async () => {
    const stubContext: Partial<ORPCContext> = {};

    let server: Awaited<ReturnType<typeof createOrpcServer>> | null = null;
    try {
      server = await createOrpcServer({
        host: "127.0.0.1",
        port: 0,
        context: stubContext as ORPCContext,
      });

      const response = await fetch(`${server.baseUrl}/api/spec.json`, {
        method: "OPTIONS",
        headers: {
          Origin: server.baseUrl,
          "Access-Control-Request-Method": "GET",
          "Access-Control-Request-Headers": "Authorization, Content-Type",
        },
      });

      expect(response.status).toBe(204);
      expect(response.headers.get("access-control-allow-origin")).toBe(server.baseUrl);
      expect(response.headers.get("access-control-allow-methods")).toBe(
        "GET, POST, PUT, DELETE, OPTIONS"
      );
      expect(response.headers.get("access-control-allow-headers")).toBe(
        "Authorization, Content-Type"
      );
      expect(response.headers.get("access-control-allow-credentials")).toBe("true");
      expect(response.headers.get("access-control-max-age")).toBe("86400");
    } finally {
      await server?.close();
    }
  });

  test("general.restartApp delegates to the window service restart hook", async () => {
    const restartApp = mock(() => Promise.resolve({ supported: true as const }));
    const stubContext: Partial<ORPCContext> = {
      windowService: {
        restartApp,
      } as unknown as ORPCContext["windowService"],
    };

    let server: Awaited<ReturnType<typeof createOrpcServer>> | null = null;
    try {
      server = await createOrpcServer({
        host: "127.0.0.1",
        port: 0,
        context: stubContext as ORPCContext,
      });

      const client = createHttpClient(server.baseUrl);
      const result = await Promise.resolve(client.general.restartApp());

      expect(restartApp).toHaveBeenCalledTimes(1);
      expect(result).toEqual({ supported: true });
    } finally {
      await server?.close();
    }
  });

  test("general.restartApp reports unsupported when no restart handler is registered", async () => {
    const stubContext: Partial<ORPCContext> = {
      windowService: {
        restartApp: mock(() =>
          Promise.resolve({
            supported: false as const,
            message: "Restart is only available in the desktop app.",
          })
        ),
      } as unknown as ORPCContext["windowService"],
    };

    let server: Awaited<ReturnType<typeof createOrpcServer>> | null = null;
    try {
      server = await createOrpcServer({
        host: "127.0.0.1",
        port: 0,
        context: stubContext as ORPCContext,
      });

      const client = createHttpClient(server.baseUrl);
      const result = await Promise.resolve(client.general.restartApp());

      expect(result).toEqual({
        supported: false,
        message: "Restart is only available in the desktop app.",
      });
    } finally {
      await server?.close();
    }
  });

  test("rejects CORS preflight requests from cross-origin callers", async () => {
    const stubContext: Partial<ORPCContext> = {};

    let server: Awaited<ReturnType<typeof createOrpcServer>> | null = null;
    try {
      server = await createOrpcServer({
        host: "127.0.0.1",
        port: 0,
        context: stubContext as ORPCContext,
      });

      const response = await fetch(`${server.baseUrl}/api/spec.json`, {
        method: "OPTIONS",
        headers: {
          Origin: "https://evil.example.com",
          "Access-Control-Request-Method": "GET",
        },
      });

      expect(response.status).toBe(403);
    } finally {
      await server?.close();
    }
  });
});

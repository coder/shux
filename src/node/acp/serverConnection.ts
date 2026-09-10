import assert from "node:assert/strict";
import * as crypto from "node:crypto";
import { createORPCClient, type ClientContext } from "@orpc/client";
import { RPCLink as WebSocketRPCLink } from "@orpc/client/websocket";
import type { RouterClient } from "@orpc/server";
import WebSocket from "ws";
import { getXumHome } from "@/common/constants/paths";
import { SERVICE_TEARDOWN_BUDGET_MS } from "@/constants/terminationTimeouts";
import { createConfigStores } from "@/node/config";
import type { AppRouter } from "@/node/orpc/router";
import { createOrpcServer } from "@/node/orpc/server";
import { ServiceContainer } from "@/node/services/serviceContainer";
import { ServerLockfile } from "@/node/services/serverLockfile";
import { raceWithAbortAndTimeout } from "@/node/utils/concurrency/withTimeout";

interface ConnectViaWebSocketResult {
  client: ORPCClient;
  websocket: WebSocket;
  baseUrl: string;
}

type InProcessOrpcServer = Awaited<ReturnType<typeof createOrpcServer>>;

export type ORPCClient = RouterClient<AppRouter>;

function createTypedClient(link: WebSocketRPCLink<ClientContext>): ORPCClient {
  return createORPCClient(link);
}

export interface ServerConnection {
  client: ORPCClient;
  inProcessServer?: InProcessOrpcServer;
  baseUrl: string;
  close(): Promise<void>;
}

export async function connectToServer(options: {
  serverUrl?: string;
  authToken?: string;
}): Promise<ServerConnection> {
  assert(options, "[connectToServer] options are required");

  const explicitServerUrl = normalizeServerUrl(options.serverUrl);
  const explicitAuthToken = normalizeToken(options.authToken);

  if (explicitServerUrl) {
    console.error("[acp] Connecting to explicit server:", explicitServerUrl);
    return connectToExistingServer({
      baseUrl: explicitServerUrl,
      authToken: explicitAuthToken,
    });
  }

  const lockfile = new ServerLockfile(getXumHome());
  const lockData = await lockfile.read();

  if (lockData?.baseUrl) {
    // The lockfile PID is alive but the WebSocket endpoint may be unreachable
    // (startup race, stale-but-live process, etc.).  Only fall back to the
    // in-process server for clearly unreachable endpoints; rethrow auth,
    // protocol, or other errors to avoid split-brain with a live server.
    console.error("[acp] Found lockfile, connecting to server at", lockData.baseUrl);
    try {
      return await connectToExistingServer({
        baseUrl: lockData.baseUrl,
        authToken: explicitAuthToken ?? normalizeToken(lockData.token),
      });
    } catch (error) {
      if (!isUnreachableError(error)) {
        throw error;
      }
      console.error("[acp] Lockfile endpoint unreachable, falling back to in-process server");
      // Lockfile endpoint unreachable — fall through to in-process server.
    }
  }

  console.error("[acp] Starting in-process server…");
  return connectToInProcessServer(explicitAuthToken);
}

/**
 * Network-level error codes that indicate the lockfile endpoint is genuinely
 * unreachable (not running, refused, timed out).  Auth errors, protocol
 * mismatches, and other failures are *not* included — those indicate a real
 * server is listening and we should surface the error rather than silently
 * starting a second server.
 */
const UNREACHABLE_ERROR_CODES = new Set([
  "ECONNREFUSED",
  "ECONNRESET",
  "ECONNABORTED",
  "ETIMEDOUT",
  "ENETUNREACH",
  "EHOSTUNREACH",
  "EPIPE",
]);

/**
 * WebSocket close codes that indicate the endpoint is effectively unreachable
 * during connection setup (as opposed to policy/auth/protocol rejections).
 */
const UNREACHABLE_PREOPEN_CLOSE_CODES = new Set([1005, 1006]);

function isUnreachableError(error: unknown): boolean {
  if (error == null || typeof error !== "object") {
    return false;
  }

  // Node.js network errors carry an errno `code` property.
  if ("code" in error && typeof (error as { code: unknown }).code === "string") {
    return UNREACHABLE_ERROR_CODES.has((error as { code: string }).code);
  }

  // ws WebSocket emits an error whose message starts with the error code or
  // wraps a Node network error in `.cause`.
  if ("cause" in error) {
    return isUnreachableError((error as { cause: unknown }).cause);
  }

  if (error instanceof Error) {
    // waitForWebSocketOpen emits this for handshake timeouts; treat as unreachable
    // so lockfile fallback can self-heal into in-process mode.
    if (error.message.includes("WebSocket open timed out")) {
      return true;
    }

    // waitForWebSocketOpen also emits this for pre-open closes. Distinguish
    // network-style abnormal closes from policy/auth/protocol rejections.
    const preOpenCloseMatch = /WebSocket closed before opening \((\d+)\)/.exec(error.message);
    if (preOpenCloseMatch != null) {
      const closeCode = Number(preOpenCloseMatch[1]);
      return Number.isInteger(closeCode) && UNREACHABLE_PREOPEN_CLOSE_CODES.has(closeCode);
    }
  }

  return false;
}

async function connectToExistingServer(options: {
  baseUrl: string;
  authToken?: string;
}): Promise<ServerConnection> {
  const connection = await connectViaWebSocket(options.baseUrl, options.authToken);

  return {
    client: connection.client,
    baseUrl: connection.baseUrl,
    close: async () => {
      await closeWebSocket(connection.websocket);
    },
  };
}

async function connectToInProcessServer(requestedAuthToken?: string): Promise<ServerConnection> {
  const authToken = requestedAuthToken ?? crypto.randomUUID();
  const stores = createConfigStores();
  const serviceContainer = new ServiceContainer(stores);

  let inProcessServer: InProcessOrpcServer | undefined;

  try {
    await serviceContainer.initialize();

    const context = serviceContainer.toORPCContext();
    inProcessServer = await createOrpcServer({
      host: "127.0.0.1",
      port: 0,
      authToken,
      context,
    });

    const activeServer = inProcessServer;
    assert(
      activeServer != null,
      "connectToInProcessServer: expected createOrpcServer to return a server instance"
    );

    const connection = await connectViaWebSocket(activeServer.baseUrl, authToken);

    return {
      client: connection.client,
      inProcessServer: activeServer,
      baseUrl: connection.baseUrl,
      close: async () => {
        let firstError: Error | undefined;

        const captureError = (error: unknown) => {
          firstError ??=
            error instanceof Error
              ? error
              : new Error("connectToInProcessServer: failed to close resources", {
                  cause: error,
                });
        };

        await closeWebSocket(connection.websocket).catch(captureError);
        await activeServer.close().catch(captureError);
        await serviceContainer.dispose().catch(captureError);

        if (firstError !== undefined) {
          throw firstError;
        }
      },
    };
  } catch (error) {
    if (inProcessServer) {
      await inProcessServer.close().catch(() => undefined);
    }

    // Also after a rejected initialize(): a startup step that failed — or timed out and is still
    // running as a plain promise (StartupStepTimeoutError) — must not leave half-started services
    // behind, and the stdio adapter must still exit if a teardown step hangs. dispose() is safe
    // on a container that never finished initializing.
    await raceWithAbortAndTimeout(
      serviceContainer.dispose().catch(() => undefined),
      {
        timeoutMs: SERVICE_TEARDOWN_BUDGET_MS,
      }
    );

    throw error;
  }
}

async function connectViaWebSocket(
  baseUrl: string,
  authToken?: string
): Promise<ConnectViaWebSocketResult> {
  const normalizedBaseUrl = normalizeServerUrl(baseUrl);
  assert(normalizedBaseUrl, "[connectViaWebSocket] baseUrl must be a valid URL");

  const wsUrl = buildWsUrl(normalizedBaseUrl);
  const headers = buildAuthHeaders(authToken);
  const websocket = new WebSocket(wsUrl, headers ? { headers } : undefined);

  await waitForWebSocketOpen(websocket, wsUrl);

  // oRPC expects a browser-like WebSocket surface; ws is compatible at runtime.
  // oRPC >=1.14 replaced the `websocket` option with a `connect` factory.
  const link = new WebSocketRPCLink({
    // eslint-disable-next-line local/no-chained-type-assertions -- grandfathered when the rule was introduced; fix the underlying type instead of copying this pattern
    connect: () => websocket as unknown as globalThis.WebSocket,
  });
  const client = createTypedClient(link);

  return {
    client,
    websocket,
    baseUrl: normalizedBaseUrl,
  };
}

function normalizeServerUrl(serverUrl: string | undefined): string | undefined {
  const trimmed = serverUrl?.trim();
  if (!trimmed) {
    return undefined;
  }

  let parsed: URL;
  try {
    parsed = new URL(trimmed);
  } catch (error) {
    throw new Error(`[serverConnection] Invalid server URL "${trimmed}"`, {
      cause: error,
    });
  }

  assert(
    parsed.protocol === "http:" || parsed.protocol === "https:",
    `[serverConnection] server URL must use http(s), got ${parsed.protocol}`
  );

  return parsed.toString().replace(/\/$/, "");
}

function normalizeToken(token: string | undefined): string | undefined {
  const trimmed = token?.trim();
  if (trimmed == null || trimmed.length === 0) {
    return undefined;
  }

  return trimmed;
}

function buildWsUrl(baseUrl: string): string {
  const url = new URL(baseUrl);
  url.protocol = url.protocol === "https:" ? "wss:" : "ws:";

  const basePath = url.pathname === "/" ? "" : url.pathname.replace(/\/+$/, "");
  url.pathname = `${basePath}/orpc/ws`;
  url.search = "";
  url.hash = "";

  return url.toString();
}

function buildAuthHeaders(authToken: string | undefined): Record<string, string> | undefined {
  const normalizedToken = normalizeToken(authToken);
  if (!normalizedToken) {
    return undefined;
  }

  return {
    Authorization: `Bearer ${normalizedToken}`,
  };
}

/** Maximum time to wait for a WebSocket connection to open (ms). */
const WS_OPEN_TIMEOUT_MS = 10_000;

async function waitForWebSocketOpen(websocket: WebSocket, wsUrl: string): Promise<void> {
  await new Promise<void>((resolve, reject) => {
    const cleanup = () => {
      clearTimeout(timer);
      websocket.off("open", onOpen);
      websocket.off("error", onError);
      websocket.off("close", onClose);
    };

    const timer = setTimeout(() => {
      cleanup();
      websocket.terminate();
      reject(
        new Error(
          `[serverConnection] WebSocket open timed out after ${WS_OPEN_TIMEOUT_MS}ms: ${wsUrl}`
        )
      );
    }, WS_OPEN_TIMEOUT_MS);

    const onOpen = () => {
      cleanup();
      resolve();
    };

    const onError = (error: Error) => {
      cleanup();
      reject(error);
    };

    const onClose = (code: number, reasonBuffer: Buffer) => {
      cleanup();

      const reason = reasonBuffer.toString("utf8").trim();
      const suffix = reason ? ` (${reason})` : "";
      reject(
        new Error(`[serverConnection] WebSocket closed before opening (${code})${suffix}: ${wsUrl}`)
      );
    };

    websocket.once("open", onOpen);
    websocket.once("error", onError);
    websocket.once("close", onClose);
  });
}

async function closeWebSocket(websocket: WebSocket): Promise<void> {
  if (websocket.readyState === WebSocket.CLOSED) {
    return;
  }

  await new Promise<void>((resolve) => {
    let finished = false;

    const finish = () => {
      if (finished) {
        return;
      }

      finished = true;
      clearTimeout(timeout);
      websocket.off("close", finish);
      websocket.off("error", finish);
      resolve();
    };

    const timeout = setTimeout(() => {
      try {
        websocket.terminate();
      } catch {
        // Best effort - socket may already be closing.
      }

      finish();
    }, 1000);

    websocket.once("close", finish);
    websocket.once("error", finish);

    try {
      websocket.close();
    } catch {
      finish();
    }
  });
}

import http from "node:http";
import type net from "node:net";
import type { Result } from "@/common/types/result";
import { Err, Ok } from "@/common/types/result";
import { closeServer, createDeferred, renderOAuthCallbackHtml } from "@/node/utils/oauthUtils";

/**
 * Shared loopback OAuth callback server.
 *
 * Four OAuth services (Gateway, Governor, Codex, MCP) spin up a local HTTP
 * server to receive the authorization code redirect. The pattern is identical
 * across all four — this module extracts that into a single reusable utility.
 */

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface LoopbackServerOptions {
  /** Port to listen on. 0 = random (default). Codex uses 1455. */
  port?: number;
  /** Host to bind to. Default: "127.0.0.1" */
  host?: string;
  /** Path to match for the OAuth callback. Default: "/callback" */
  callbackPath?: string;
  /** Expected state parameter value for CSRF validation. */
  expectedState: string;
  /** Whether to validate that remoteAddress is a loopback address. Default: false. Codex uses true. */
  validateLoopback?: boolean;
  /** Custom HTML renderer. If not provided, uses renderOAuthCallbackHtml with generic branding. */
  renderHtml?: (result: { success: boolean; error?: string }) => string;
  /**
   * Defer success-page rendering until the caller finishes token exchange.
   *
   * When true, a valid callback resolves `result` but does not immediately
   * respond to the browser tab. The caller must later call
   * `sendSuccessResponse()` or `sendFailureResponse()`.
   */
  deferSuccessResponse?: boolean;
}

export interface LoopbackCallbackResult {
  code: string;
  state: string;
}

export interface LoopbackServer {
  /** The full redirect URI (http://{host}:{port}{callbackPath}). */
  redirectUri: string;
  /** The underlying HTTP server (needed by OAuthFlowManager for cleanup). */
  server: http.Server;
  /**
   * Resolves when a valid callback is received (state matches `expectedState`).
   *
   * Note: Requests with an invalid/missing `state` respond 400 but are ignored
   * so unrelated localhost probes/scanners can't break an in-flight OAuth flow.
   */
  result: Promise<Result<LoopbackCallbackResult, string>>;
  /** Cancel and close the server. */
  cancel: () => Promise<void>;
  /** Close the server. */
  close: () => Promise<void>;
  /** Send a deferred success page to the callback browser tab. */
  sendSuccessResponse: () => void;
  /** Send a deferred failure page to the callback browser tab. */
  sendFailureResponse: (error: string) => void;
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/**
 * Check whether an address string is a loopback address.
 * Node may normalize IPv4 loopback to an IPv6-mapped address.
 *
 * Extracted from codexOauthService.ts where validateLoopback is used.
 */
function isLoopbackAddress(address: string | undefined): boolean {
  if (!address) return false;

  // Node may normalize IPv4 loopback to an IPv6-mapped address.
  if (address === "::ffff:127.0.0.1") {
    return true;
  }

  return address === "127.0.0.1" || address === "::1";
}

/**
 * Format a `server.listen()` host value for use inside a URL.
 *
 * - IPv6 literals must be wrapped in brackets (e.g. "::1" -> "[::1]")
 * - Zone identifiers must be percent-encoded ("%" -> "%25")
 */
function hostForRedirectUri(rawHost: string): string {
  const host = rawHost.startsWith("[") && rawHost.endsWith("]") ? rawHost.slice(1, -1) : rawHost;

  if (host.includes(":")) {
    // RFC 6874: zone identifiers use "%25" in URIs.
    return `[${host.replaceAll("%", "%25")}]`;
  }

  return host;
}

// ---------------------------------------------------------------------------
// Main
// ---------------------------------------------------------------------------

/**
 * Start a loopback HTTP server to receive an OAuth authorization code callback.
 *
 * Pattern extracted from the `http.createServer` blocks in Gateway, Governor,
 * Codex, and MCP OAuth services. The server:
 *
 * 1. Optionally validates the remote address is loopback (Codex).
 * 2. Matches only GET requests on `callbackPath`.
 * 3. Validates the `state` query parameter against `expectedState`.
 * 4. Extracts `code` from the query string.
 * 5. Responds with HTML (success or error) unless success is deferred.
 * 6. Resolves the result deferred — the caller then performs token exchange
 *    and calls `close()`.
 *
 * The server does NOT close itself after responding — the caller decides when
 * to close (matching the existing pattern where services call `closeServer`
 * after token exchange).
 */
export async function startLoopbackServer(options: LoopbackServerOptions): Promise<LoopbackServer> {
  const port = options.port ?? 0;
  const host = options.host ?? "127.0.0.1";
  // `server.listen()` expects IPv6 hosts without brackets, but callers may pass
  // "[::1]" since that's what URLs require.
  const listenHost = host.startsWith("[") && host.endsWith("]") ? host.slice(1, -1) : host;
  const callbackPath = options.callbackPath ?? "/callback";
  const validateLoopback = options.validateLoopback ?? false;
  const deferSuccessResponse = options.deferSuccessResponse ?? false;

  const deferred = createDeferred<Result<LoopbackCallbackResult, string>>();
  let deferredSuccessResponse: http.ServerResponse | null = null;

  const render =
    options.renderHtml ??
    ((r: { success: boolean; error?: string }) =>
      renderOAuthCallbackHtml({
        title: r.success ? "Login complete" : "Login failed",
        message: r.success
          ? "You can return to Xum. You may now close this tab."
          : (r.error ?? "Unknown error"),
        success: r.success,
      }));

  const clearDeferredSuccessResponse = (response: http.ServerResponse) => {
    if (deferredSuccessResponse === response) {
      deferredSuccessResponse = null;
    }
  };

  const sendDeferredResponse = (result: { success: boolean; error?: string }) => {
    const pendingResponse = deferredSuccessResponse;
    if (!pendingResponse || pendingResponse.writableEnded || pendingResponse.destroyed) {
      deferredSuccessResponse = null;
      return;
    }

    deferredSuccessResponse = null;
    pendingResponse.statusCode = result.success ? 200 : 400;
    pendingResponse.setHeader("Content-Type", "text/html");
    pendingResponse.end(render(result));
  };

  const sendSuccessResponse = () => {
    sendDeferredResponse({ success: true });
  };

  const sendFailureResponse = (error: string) => {
    sendDeferredResponse({ success: false, error });
  };

  const sendCancelledResponseIfPending = () => {
    sendFailureResponse("OAuth flow cancelled");
  };

  const server = http.createServer((req, res) => {
    // Optionally reject non-loopback connections (Codex sets validateLoopback: true).
    if (validateLoopback && !isLoopbackAddress(req.socket.remoteAddress)) {
      res.statusCode = 403;
      res.end("Forbidden");
      return;
    }

    const reqUrl = req.url ?? "/";
    const url = new URL(reqUrl, "http://localhost");

    if (req.method !== "GET" || url.pathname !== callbackPath) {
      res.statusCode = 404;
      res.end("Not found");
      return;
    }

    const state = url.searchParams.get("state");
    if (!state || state !== options.expectedState) {
      const errorMessage = "Invalid OAuth state";
      res.statusCode = 400;
      res.setHeader("Content-Type", "text/html");
      res.end(render({ success: false, error: errorMessage }));

      // Intentionally ignore invalid state callbacks. Unrelated localhost
      // probes/scanners can hit this endpoint and shouldn't break an in-flight
      // OAuth flow.
      return;
    }

    const code = url.searchParams.get("code");
    const error = url.searchParams.get("error");
    const errorDescription = url.searchParams.get("error_description") ?? undefined;

    if (error) {
      const errorMessage = errorDescription ? `${error}: ${errorDescription}` : error;
      res.setHeader("Content-Type", "text/html");
      res.statusCode = 400;
      res.end(render({ success: false, error: errorMessage }));
      deferred.resolve(Err(errorMessage));
      return;
    }

    if (!code) {
      const errorMessage = "Missing authorization code";
      res.setHeader("Content-Type", "text/html");
      res.statusCode = 400;
      res.end(render({ success: false, error: errorMessage }));
      deferred.resolve(Err(errorMessage));
      return;
    }

    if (deferSuccessResponse) {
      if (deferredSuccessResponse && !deferredSuccessResponse.writableEnded) {
        res.statusCode = 409;
        res.setHeader("Content-Type", "text/html");
        res.end(render({ success: false, error: "OAuth callback already received" }));
        return;
      }

      deferredSuccessResponse = res;
      res.once("close", () => clearDeferredSuccessResponse(res));
      deferred.resolve(Ok({ code, state }));
      return;
    }

    res.setHeader("Content-Type", "text/html");
    res.statusCode = 200;
    res.end(render({ success: true }));
    deferred.resolve(Ok({ code, state }));
  });

  // Track live connections: `server.close()` only stops accepting and then
  // waits for existing sockets to DRAIN — any localhost client that opened
  // the port and left an HTTP request incomplete (port scanners, half-open
  // probes) would park the close callback forever, pinning the awaited
  // cancellation RPC (Settings' Cancel) even though the flow itself ended.
  const openSockets = new Set<net.Socket>();
  server.on("connection", (socket) => {
    openSockets.add(socket);
    socket.once("close", () => openSockets.delete(socket));
  });

  // Ensure pending deferred browser responses are completed before server close,
  // even when callers close via the raw `server` handle (e.g. OAuthFlowManager),
  // and bound the shutdown by force-finishing every remaining connection.
  const originalClose = server.close.bind(server);
  server.close = ((callback?: (err?: Error) => void) => {
    sendCancelledResponseIfPending();
    const result = originalClose(callback);
    for (const socket of openSockets) {
      // end() flushes queued response bytes (the cancel/success page written
      // above) and sends FIN; the finish listener then destroys the socket
      // regardless of whether the client ever completes its side — undrained
      // or half-open connections cannot stall the close callback.
      socket.end();
      socket.once("finish", () => socket.destroy());
    }
    return result;
  }) as typeof server.close;

  // Listen on the specified host/port — mirrors the existing
  // `server.listen(port, host, () => resolve())` pattern.
  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(port, listenHost, () => resolve());
  });

  const address = server.address();
  if (!address || typeof address === "string") {
    await closeServer(server);
    throw new Error("Failed to determine OAuth callback listener port");
  }

  const redirectUri = `http://${hostForRedirectUri(listenHost)}:${address.port}${callbackPath}`;

  return {
    redirectUri,
    server,
    result: deferred.promise,
    cancel: async () => {
      deferred.resolve(Err("OAuth flow cancelled"));
      sendCancelledResponseIfPending();
      await closeServer(server);
    },
    close: async () => {
      sendCancelledResponseIfPending();
      await closeServer(server);
    },
    sendSuccessResponse,
    sendFailureResponse,
  };
}

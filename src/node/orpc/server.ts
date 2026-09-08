/**
 * oRPC Server factory for mux.
 * Serves oRPC router over HTTP and WebSocket.
 *
 * This module exports the server creation logic so it can be tested.
 * The CLI entry point (server.ts) uses this to start the server.
 */
import express, { type Express } from "express";
import * as fs from "fs/promises";
import * as http from "http";
import * as path from "path";
import { WebSocketServer, type WebSocket } from "ws";
import { RPCHandler } from "@orpc/server/node";
import { RPCHandler as ORPCWebSocketServerHandler } from "@orpc/server/websocket";
import { ORPCError, onError } from "@orpc/server";
import { OpenAPIGenerator } from "@orpc/openapi";
import { OpenAPIHandler } from "@orpc/openapi/node";
import { ZodToJsonSchemaConverter } from "@orpc/zod";
import { EffectSchemaToJsonSchemaConverter } from "@orpc/experimental-effect";

/**
 * Effect Schema inputs need their own JSON-schema converter alongside Zod's;
 * without it the generator silently emits operations with no
 * requestBody, producing a lossy /api/spec.json. Exported so tests can verify
 * the production converter set against Effect Schema procedures.
 */
export function createOpenAPIGenerator(): OpenAPIGenerator {
  return new OpenAPIGenerator({
    converters: [new ZodToJsonSchemaConverter(), new EffectSchemaToJsonSchemaConverter()],
  });
}
import { router, type AppRouter } from "@/node/orpc/router";
import type { ORPCContext } from "@/node/orpc/context";
import {
  authorizeWebSocketTicketHeaders,
  extractCookieValues,
  extractWsHeaders,
  safeEq,
} from "@/node/orpc/authMiddleware";
import { ORPC_WS_PROTOCOL } from "@/common/constants/webSocketAuth";
import { parseWebSocketTicketProtocols, WebSocketTicketStore } from "./webSocketTickets";
import { VERSION } from "@/version";
import { formatOrpcError } from "@/node/orpc/formatOrpcError";
import { BROWSER_BRIDGE_WS_PATH, DESKTOP_WS_PATH, ORPC_WS_PATH } from "@/node/orpc/wsPaths";
import { resolveXumEnvironmentValue } from "@/common/compat/legacyMux";
import { log } from "@/node/services/log";
import {
  SERVER_AUTH_SESSION_COOKIE_NAME,
  SERVER_AUTH_SESSION_MAX_AGE_SECONDS,
} from "@/node/services/serverAuthService";
import { attachStreamErrorHandler, isIgnorableStreamError } from "@/node/utils/streamErrors";
import { getErrorMessage } from "@/common/utils/errors";
import { escapeHtml } from "@/node/utils/oauthUtils";
import type { Result } from "@/common/types/result";
import {
  CODER_OAUTH_SERVER_CALLBACK_PATH,
  CODER_OAUTH_SERVER_START_PATH,
} from "@/common/constants/coderOAuth";
import { assert } from "@/common/utils/assert";
import { getAppProxyBasePathFromPathname, stripAppProxyBasePath } from "@/common/appProxyBasePath";

type AliveWebSocket = WebSocket & { isAlive?: boolean };

export { BROWSER_BRIDGE_WS_PATH, DESKTOP_WS_PATH, ORPC_WS_PATH };

const WS_HEARTBEAT_INTERVAL_MS = 30_000;

// --- Types ---

export interface OrpcServerOptions {
  /** Host to bind to (default: "127.0.0.1") */
  host?: string;
  /** Port to bind to (default: 0 for random available port) */
  port?: number;
  /** oRPC context with services */
  context: ORPCContext;
  /** Whether to serve static files and SPA fallback (default: false) */
  serveStatic?: boolean;
  /** Directory to serve static files from (default: dist/ relative to dist/node/orpc/) */
  staticDir?: string;
  /** Custom error handler for oRPC errors */
  onOrpcError?: (error: unknown, options: unknown) => void;
  /** Optional bearer token for HTTP auth (used if router not provided) */
  authToken?: string;
  /** Optional pre-created router (if not provided, creates router(authToken)) */
  router?: AppRouter;
  /** Desktop bridge upgrade/shutdown hooks for /desktop/ws */
  desktopBridgeServer?: Pick<ORPCContext["desktopBridgeServer"], "handleUpgrade" | "stop">;
  /** Browser bridge upgrade/shutdown hooks for /browser/ws */
  browserBridgeServer?: Pick<ORPCContext["browserBridgeServer"], "handleUpgrade" | "stop">;
  /**
   * Allow HTTPS browser origins when reverse proxies forward X-Forwarded-Proto=http.
   * Keep disabled by default and only enable when TLS is terminated before mux.
   */
  allowHttpOrigin?: boolean;
}

export interface OrpcServer {
  /** The HTTP server instance */
  httpServer: http.Server;
  /** The WebSocket server instance */
  wsServer: WebSocketServer;
  /** The Express app instance */
  app: Express;
  /** The port the server is listening on */
  port: number;
  /** Base URL for HTTP requests */
  baseUrl: string;
  /** WebSocket URL for WS connections */
  wsUrl: string;
  /** URL for OpenAPI spec JSON */
  specUrl: string;
  /** URL for Scalar API docs */
  docsUrl: string;
  /** Close the server and cleanup resources */
  close: () => Promise<void>;
}

// --- Server Factory ---

function formatHostForUrl(host: string): string {
  const trimmed = host.trim();

  // IPv6 URLs must be bracketed: http://[::1]:1234
  if (trimmed.includes(":")) {
    if (trimmed.startsWith("[") && trimmed.endsWith("]")) {
      return trimmed;
    }

    // If the host contains a zone index (e.g. fe80::1%en0), percent must be encoded.
    const escaped = trimmed.replaceAll("%", "%25");
    return `[${escaped}]`;
  }

  return trimmed;
}

function extractBearerToken(header: string | undefined): string | null {
  if (!header?.toLowerCase().startsWith("bearer ")) return null;
  const token = header.slice(7).trim();
  return token.length ? token : null;
}
function escapeHtmlAttribute(value: string): string {
  return value
    .replaceAll("&", "&amp;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&#39;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;");
}

const SLASHLESS_ROOT_REDIRECT_SCRIPT =
  '<script>(()=>{const pathname=location.pathname;if(pathname.startsWith("//")||pathname.endsWith("/"))return;location.replace(location.origin+pathname+"/"+location.search+location.hash);})();</script>';

function injectBaseHref(
  indexHtml: string,
  baseHref: string,
  options: { includeSlashlessRootRedirect?: boolean } = {}
): string {
  // Avoid double-injecting if the HTML already has a base tag.
  if (/<base\b/i.test(indexHtml)) {
    return indexHtml;
  }

  // The redirect must precede the base tag so slashless app-root URLs become
  // directory URLs before the browser resolves relative assets.
  const slashlessRootRedirect = options.includeSlashlessRootRedirect
    ? `\n    ${SLASHLESS_ROOT_REDIRECT_SCRIPT}`
    : "";

  // Insert immediately after the opening <head> tag (supports <head> and <head ...attrs>).
  const escapedBaseHref = escapeHtmlAttribute(baseHref);
  return indexHtml.replace(
    /<head[^>]*>/i,
    (match) => `${match}${slashlessRootRedirect}\n    <base href="${escapedBaseHref}" />`
  );
}

function escapeJsonForHtmlScript(value: unknown): string {
  // Prevent `</script>` injection when embedding untrusted strings in an inline <script>.
  return JSON.stringify(value).replaceAll("<", "\\u003c");
}

function getBrowserProxyUriTemplate(): string | null {
  const muxProxyUri = resolveXumEnvironmentValue("PROXY_URI", process.env)?.trim();
  if (muxProxyUri) {
    return muxProxyUri;
  }

  const vscodeProxyUri = process.env.VSCODE_PROXY_URI?.trim();
  return vscodeProxyUri?.length ? vscodeProxyUri : null;
}

function injectProxyUriTemplate(indexHtml: string, proxyUriTemplate: string | null): string {
  const templateJson = escapeJsonForHtmlScript(proxyUriTemplate);
  return indexHtml.replace(
    /<head[^>]*>/i,
    (match) => `${match}\n    <script>window.__MUX_PROXY_URI_TEMPLATE__ = ${templateJson};</script>`
  );
}

type OriginValidationRequest = Pick<http.IncomingMessage, "headers" | "socket"> & {
  protocol?: string;
};

function getFirstHeaderValue(
  req: Pick<http.IncomingMessage, "headers">,
  headerName: string
): string | null {
  const rawValue = req.headers[headerName.toLowerCase()];
  const value = Array.isArray(rawValue) ? rawValue[0] : rawValue;

  if (typeof value !== "string") {
    return null;
  }

  const firstValue = value.split(",")[0]?.trim();
  return firstValue?.length ? firstValue : null;
}

function normalizeProtocol(rawProtocol: string): "http" | "https" | null {
  const normalized = rawProtocol.trim().toLowerCase().replace(/:$/, "");
  if (normalized === "http" || normalized === "https") {
    return normalized;
  }

  return null;
}

function buildOrigin(protocol: string, host: string): string | null {
  const normalizedProtocol = normalizeProtocol(protocol);
  const normalizedHost = host.trim();

  if (!normalizedProtocol || normalizedHost.length === 0) {
    return null;
  }

  try {
    return new URL(`${normalizedProtocol}://${normalizedHost}`).origin;
  } catch {
    return null;
  }
}

function normalizeHostForProtocol(host: string, protocol: "http" | "https"): string | null {
  const trimmedHost = host.trim();
  if (!trimmedHost) {
    return null;
  }

  try {
    return new URL(`${protocol}://${trimmedHost}`).host.toLowerCase();
  } catch {
    return null;
  }
}

function inferProtocol(req: OriginValidationRequest): "http" | "https" {
  if (typeof req.protocol === "string") {
    const normalized = normalizeProtocol(req.protocol);
    if (normalized) {
      return normalized;
    }
  }

  return (req.socket as { encrypted?: boolean }).encrypted ? "https" : "http";
}

function getExpectedHosts(req: OriginValidationRequest): string[] {
  return [getFirstHeaderValue(req, "x-forwarded-host"), getFirstHeaderValue(req, "host")].filter(
    (value, index, values): value is string => value !== null && values.indexOf(value) === index
  );
}

function getFirstForwardedProtocol(req: OriginValidationRequest): "http" | "https" | null {
  const forwardedProtoHeader = getFirstHeaderValue(req, "x-forwarded-proto");
  if (!forwardedProtoHeader) {
    return null;
  }

  // Trust the client-facing hop. Additional values come from downstream/internal hops.
  const firstHop = forwardedProtoHeader.split(",")[0] ?? "";
  return normalizeProtocol(firstHop);
}

function getOriginProtocolOnExpectedHost(req: OriginValidationRequest): "http" | "https" | null {
  const normalizedOrigin = normalizeOrigin(getFirstHeaderValue(req, "origin"));
  if (!normalizedOrigin) {
    return null;
  }

  try {
    const parsedOrigin = new URL(normalizedOrigin);
    const originProtocol = normalizeProtocol(parsedOrigin.protocol);
    if (!originProtocol) {
      return null;
    }

    const originHost = parsedOrigin.host.toLowerCase();
    const hasExpectedHost = getExpectedHosts(req).some((host) => {
      const normalizedHost = normalizeHostForProtocol(host, originProtocol);
      return normalizedHost !== null && normalizedHost === originHost;
    });

    return hasExpectedHost ? originProtocol : null;
  } catch {
    return null;
  }
}

function getClientFacingProtocol(req: OriginValidationRequest): "http" | "https" {
  return getFirstForwardedProtocol(req) ?? inferProtocol(req);
}

function getExpectedProtocols(
  req: OriginValidationRequest,
  allowHttpOrigin = false
): Array<"http" | "https"> {
  const clientFacingProtocol = getClientFacingProtocol(req);
  const originProtocol = getOriginProtocolOnExpectedHost(req);

  // Compatibility path: some reverse proxies overwrite X-Forwarded-Proto to http
  // even when the browser-facing request is https. In that specific case, trust the
  // validated origin protocol for host-matched requests only when explicitly enabled.
  if (allowHttpOrigin && clientFacingProtocol === "http" && originProtocol === "https") {
    return ["https"];
  }

  return [clientFacingProtocol];
}

function getPreferredPublicProtocol(
  req: OriginValidationRequest,
  allowHttpOrigin = false
): "http" | "https" {
  const clientFacingProtocol = getClientFacingProtocol(req);
  const originProtocol = getOriginProtocolOnExpectedHost(req);

  if (allowHttpOrigin && clientFacingProtocol === "http" && originProtocol === "https") {
    return "https";
  }

  return clientFacingProtocol;
}

function getExpectedOrigins(req: OriginValidationRequest, allowHttpOrigin = false): string[] {
  const hosts = getExpectedHosts(req);

  if (hosts.length === 0) {
    return [];
  }

  const protocols = getExpectedProtocols(req, allowHttpOrigin);

  const expectedOrigins: string[] = [];
  for (const protocol of protocols) {
    for (const host of hosts) {
      const origin = buildOrigin(protocol, host);
      if (!origin || expectedOrigins.includes(origin)) {
        continue;
      }

      expectedOrigins.push(origin);
    }
  }

  return expectedOrigins;
}

function normalizeOrigin(raw: string | null | undefined): string | null {
  if (!raw) {
    return null;
  }

  try {
    const parsed = new URL(raw);
    const normalizedProtocol = normalizeProtocol(parsed.protocol);

    if (!normalizedProtocol) {
      return null;
    }

    return `${normalizedProtocol}://${parsed.host}`;
  } catch {
    return null;
  }
}

interface OriginIdentity {
  protocol: "http:" | "https:";
  port: string;
  hostname: string;
  isLoopback: boolean;
}

function normalizeHostnameForOriginCheck(hostname: string): string {
  const normalized = hostname.trim().toLowerCase();

  // URL.hostname may include brackets for IPv6 literals in some runtimes.
  if (normalized.startsWith("[") && normalized.endsWith("]")) {
    return normalized.slice(1, -1);
  }

  return normalized;
}

function isLoopbackHostname(hostname: string): boolean {
  const normalized = normalizeHostnameForOriginCheck(hostname);
  return normalized === "localhost" || normalized === "127.0.0.1" || normalized === "::1";
}

function parseOriginIdentity(rawOrigin: string): OriginIdentity | null {
  try {
    const parsed = new URL(rawOrigin);

    if (parsed.protocol !== "http:" && parsed.protocol !== "https:") {
      return null;
    }

    const hostname = normalizeHostnameForOriginCheck(parsed.hostname);
    return {
      protocol: parsed.protocol,
      port: parsed.port,
      hostname,
      isLoopback: isLoopbackHostname(hostname),
    };
  } catch {
    return null;
  }
}

// In local development, the browser and proxy may use loopback aliases interchangeably.
// Treat loopback host aliases as equivalent origins when protocol+port match.
function areEquivalentLoopbackOrigins(originA: string, originB: string): boolean {
  const identityA = parseOriginIdentity(originA);
  const identityB = parseOriginIdentity(originB);

  if (!identityA || !identityB) {
    return false;
  }

  return (
    identityA.protocol === identityB.protocol &&
    identityA.port === identityB.port &&
    identityA.isLoopback &&
    identityB.isLoopback
  );
}

function isOriginAllowed(
  req: OriginValidationRequest,
  expectedOrigins: readonly string[] = getExpectedOrigins(req)
): boolean {
  const origin = getFirstHeaderValue(req, "origin");
  if (!origin) {
    return true;
  }

  const normalizedOrigin = normalizeOrigin(origin);
  if (!normalizedOrigin || expectedOrigins.length === 0) {
    return false;
  }

  return expectedOrigins.some(
    (expectedOrigin) =>
      normalizedOrigin === expectedOrigin ||
      areEquivalentLoopbackOrigins(normalizedOrigin, expectedOrigin)
  );
}

const URL_PATHNAME_RE = /^[A-Za-z0-9._~!$&'()*+,;=:@%/-]+$/;
const PUBLIC_BASE_PATH_VARY_HEADERS = [
  "X-Forwarded-Prefix",
  "X-Forwarded-Uri",
  "X-Original-Uri",
  "X-Original-Url",
  "Referer",
] as const;

interface PublicBasePathLocals {
  publicBasePath?: string;
}

type PublicBasePathRequest = Pick<http.IncomingMessage, "headers" | "url"> & {
  originalUrl?: string;
};

function isValidUrlPathname(value: string): boolean {
  return (
    value.length > 0 &&
    value.startsWith("/") &&
    !value.startsWith("//") &&
    URL_PATHNAME_RE.test(value)
  );
}

function normalizePublicBasePath(value: string | null | undefined): string | null {
  if (!value) {
    return null;
  }

  const trimmed = value.trim();
  if (!trimmed || trimmed.startsWith("//")) {
    return null;
  }

  const withLeadingSlash = trimmed.startsWith("/") ? trimmed : `/${trimmed}`;
  const withoutTrailingSlash =
    withLeadingSlash === "/" ? withLeadingSlash : withLeadingSlash.replace(/\/+$/, "");

  return isValidUrlPathname(withoutTrailingSlash) ? withoutTrailingSlash : null;
}

function parsePathnameFromRequestValue(value: string | null | undefined): string | null {
  if (!value) {
    return null;
  }

  const trimmed = value.trim();
  if (!trimmed || trimmed.startsWith("//")) {
    return null;
  }

  try {
    const pathname = trimmed.startsWith("/")
      ? new URL(trimmed, "http://localhost").pathname
      : new URL(trimmed).pathname;
    return isValidUrlPathname(pathname) ? pathname : null;
  } catch {
    return null;
  }
}

function getPathnameFromRequestUrl(requestUrl: string | undefined): string | null {
  return parsePathnameFromRequestValue(requestUrl);
}

// Combines pathname parsing + app-proxy prefix detection so request-value
// shaped inputs (raw URLs, header values) can be classified in a single call.
function getAppProxyBasePathFromRequestValue(value: string | null | undefined): string | null {
  const pathname = parsePathnameFromRequestValue(value);
  return pathname ? getAppProxyBasePathFromPathname(pathname) : null;
}

function getRequestPublicBasePath(
  req: PublicBasePathRequest,
  options: { allowReferer?: boolean } = {}
): string {
  const forwardedPrefix = normalizePublicBasePath(getFirstHeaderValue(req, "x-forwarded-prefix"));
  if (forwardedPrefix) {
    return forwardedPrefix;
  }

  for (const headerName of ["x-forwarded-uri", "x-original-uri", "x-original-url"] as const) {
    const headerBasePath = getAppProxyBasePathFromRequestValue(
      getFirstHeaderValue(req, headerName)
    );
    if (headerBasePath) {
      return headerBasePath;
    }
  }

  for (const requestValue of [req.originalUrl, req.url]) {
    const requestBasePath = getAppProxyBasePathFromRequestValue(requestValue);
    if (requestBasePath) {
      return requestBasePath;
    }
  }

  // Browser mode requests include Referer by default, so this keeps cookie scope
  // and generated app links aligned when a proxy strips the public prefix.
  if (options.allowReferer) {
    const refererBasePath = getAppProxyBasePathFromRequestValue(
      getFirstHeaderValue(req, "referer")
    );
    if (refererBasePath) {
      return refererBasePath;
    }
  }

  return "/";
}

function setResponsePublicBasePath(res: express.Response, publicBasePath: string): void {
  (res.locals as PublicBasePathLocals).publicBasePath = publicBasePath;
}

function getResponsePublicBasePath(res: express.Response): string | null {
  const publicBasePath = (res.locals as PublicBasePathLocals).publicBasePath;
  return typeof publicBasePath === "string" ? publicBasePath : null;
}

function getPublicBasePathForRequest(
  req: express.Request,
  res: express.Response,
  options: { allowReferer?: boolean } = {}
): string {
  return getResponsePublicBasePath(res) ?? getRequestPublicBasePath(req, options);
}

function joinPublicBasePath(publicBasePath: string, routePathname: string): string {
  const normalizedBasePath = normalizePublicBasePath(publicBasePath) ?? "/";
  const normalizedRoutePathname = routePathname.startsWith("/")
    ? routePathname
    : `/${routePathname}`;

  return normalizedBasePath === "/"
    ? normalizedRoutePathname
    : `${normalizedBasePath}${normalizedRoutePathname}`;
}

function getDirectAppProxyHandlerPrefix(
  req: express.Request,
  routePrefix: `/${string}`
): `/${string}` {
  const directBasePath = getAppProxyBasePathFromRequestValue(req.originalUrl);
  return directBasePath
    ? (joinPublicBasePath(directBasePath, routePrefix) as `/${string}`)
    : routePrefix;
}

function getRelativeBaseHrefFromRoutePathname(routePathname: string): string {
  const pathname = routePathname.startsWith("/") ? routePathname : `/${routePathname}`;
  const segments = pathname.split("/").slice(1);
  const depth = Math.max(0, segments.length - 1);
  return depth === 0 ? "./" : `./${"../".repeat(depth)}`;
}

function shouldInjectSlashlessRootRedirect(req: express.Request): boolean {
  return getPathnameFromRequestUrl(req.url) === "/";
}

function getPublicBaseHref(req: express.Request, res: express.Response): string {
  const publicBasePath = getPublicBasePathForRequest(req, res, { allowReferer: true });
  if (publicBasePath !== "/") {
    return `${publicBasePath}/`;
  }

  // User rationale: when a reverse proxy strips the app prefix without forwarding
  // headers, a relative climb still lets the browser resolve assets from the
  // public app root. Root-hosted deep links resolve correctly too.
  return getRelativeBaseHrefFromRoutePathname(getPathnameFromRequestUrl(req.url) ?? "/");
}

function getPublicAppRootPath(req: express.Request, res: express.Response): string {
  return joinPublicBasePath(getPublicBasePathForRequest(req, res, { allowReferer: true }), "/");
}

function varyPublicBasePathHeaders(res: express.Response): void {
  for (const header of PUBLIC_BASE_PATH_VARY_HEADERS) {
    res.vary(header);
  }
}

function splitRequestUrlPathAndQuery(
  requestUrl: string | undefined
): { pathname: string; querySuffix: string } | null {
  if (!requestUrl) {
    return null;
  }

  const queryStart = requestUrl.indexOf("?");
  if (queryStart === -1) {
    return { pathname: requestUrl, querySuffix: "" };
  }

  return {
    pathname: requestUrl.slice(0, queryStart),
    querySuffix: requestUrl.slice(queryStart),
  };
}

function getNormalizedUpgradeRoute(
  requestUrl: string | undefined
): { routePathname: string; routeUrl: string } | null {
  const publicPathname = getPathnameFromRequestUrl(requestUrl);
  if (!publicPathname) {
    return null;
  }

  const { routePathname } = stripAppProxyBasePath(publicPathname);
  const querySuffix = splitRequestUrlPathAndQuery(requestUrl)?.querySuffix ?? "";
  return { routePathname, routeUrl: `${routePathname}${querySuffix}` };
}

function isSafeHttpHostHeader(host: string): boolean {
  if (host.trim().length === 0 || host.includes("/") || host.includes("\\")) {
    return false;
  }

  for (const character of host) {
    const codePoint = character.codePointAt(0);
    if (codePoint !== undefined && (codePoint < 0x20 || codePoint === 0x7f)) {
      return false;
    }
  }

  return true;
}

function getValidatedPublicHost(req: express.Request, protocol: "http" | "https"): string | null {
  for (const headerName of ["x-forwarded-host", "host"] as const) {
    const host = getFirstHeaderValue(req, headerName);
    if (!host || !isSafeHttpHostHeader(host)) {
      continue;
    }

    const normalizedHost = normalizeHostForProtocol(host, protocol);
    if (normalizedHost) {
      return normalizedHost;
    }
  }

  return null;
}

function buildPublicAbsoluteUrl(
  req: express.Request,
  routePathname: string,
  allowHttpOrigin: boolean
): string | null {
  const protocol = getPreferredPublicProtocol(req, allowHttpOrigin);
  const host = getValidatedPublicHost(req, protocol);
  if (!host) {
    return null;
  }

  const publicRoutePathname = joinPublicBasePath(
    getRequestPublicBasePath(req, { allowReferer: true }),
    routePathname
  );
  return `${protocol}://${host}${publicRoutePathname}`;
}

const OAUTH_CALLBACK_ORIGIN_BYPASS_PATHS = new Set<string>([
  "/auth/mux-gateway/callback",
  "/auth/mux-governor/callback",
  "/auth/mcp-oauth/callback",
  CODER_OAUTH_SERVER_CALLBACK_PATH,
]);

function isOAuthCallbackNavigationRequest(req: Pick<express.Request, "method" | "path">): boolean {
  return (
    (req.method === "GET" || req.method === "POST") &&
    OAUTH_CALLBACK_ORIGIN_BYPASS_PATHS.has(req.path)
  );
}

function shouldEnforceOriginValidation(req: Pick<express.Request, "path">): boolean {
  // User rationale: static HTML/CSS/JS must keep loading even when intermediaries rewrite
  // Origin/forwarded headers, while API and auth endpoints retain strict same-origin checks.
  return (
    req.path.startsWith("/orpc") || req.path.startsWith("/api") || req.path.startsWith("/auth/")
  );
}

/**
 * Create an oRPC server with HTTP and WebSocket endpoints.
 *
 * HTTP endpoint: /orpc
 * WebSocket endpoint: /orpc/ws
 * Desktop relay WebSocket endpoint: /desktop/ws
 * Browser relay WebSocket endpoint: /browser/ws
 * Health check: /health
 * Version: /version
 */
export async function createOrpcServer({
  host = "127.0.0.1",
  port = 0,
  authToken,
  context,
  serveStatic = false,
  allowHttpOrigin = false,
  // Default for non-bundled mode: from dist/node/orpc/, go up 2 levels to dist/.
  // In bundled mode (dist/runtime/), serverService computes the static dir.
  staticDir = path.join(__dirname, "../.."),
  onOrpcError = (error, options) => {
    // Auth failures are expected in browser mode while the user enters the token.
    // Avoid spamming error logs with stack traces on every unauthenticated request.
    if (error instanceof ORPCError && error.code === "UNAUTHORIZED") {
      log.debug("ORPC unauthorized request");
      return;
    }

    const formatted = formatOrpcError(error, options);
    log.error(formatted.message);

    if (log.isDebugMode()) {
      const suffix = Math.random().toString(16).slice(2);
      log.debug_obj(`orpc/${Date.now()}_${suffix}.json`, formatted.debugDump);
    }
  },
  router: existingRouter,
  desktopBridgeServer = context.desktopBridgeServer,
  browserBridgeServer = context.browserBridgeServer,
}: OrpcServerOptions): Promise<OrpcServer> {
  // authToken/router authentication is immutable for this server lifetime. Closing
  // the server destroys its ticket audience; no credential epoch or disk state is needed.
  const webSocketTickets = new WebSocketTicketStore();
  const ticketAuthenticatedRequests = new WeakSet<http.IncomingMessage>();
  // Express app setup
  const app = express();
  app.use((req, res, next) => {
    const requestPath = splitRequestUrlPathAndQuery(req.url);
    if (requestPath && isValidUrlPathname(requestPath.pathname)) {
      const { basePath, routePathname } = stripAppProxyBasePath(requestPath.pathname);
      if (basePath) {
        setResponsePublicBasePath(res, basePath);
        req.url = `${routePathname}${requestPath.querySuffix}`;
        next();
        return;
      }
    }

    const publicBasePath = getRequestPublicBasePath(req);
    if (publicBasePath !== "/") {
      setResponsePublicBasePath(res, publicBasePath);
    }

    next();
  });

  app.use((req, res, next) => {
    if (!shouldEnforceOriginValidation(req)) {
      next();
      return;
    }

    const originHeader = getFirstHeaderValue(req, "origin");

    if (!originHeader) {
      next();
      return;
    }

    const normalizedOrigin = normalizeOrigin(originHeader);
    const expectedOrigins = getExpectedOrigins(req, allowHttpOrigin);
    const allowedOrigin = isOriginAllowed(req, expectedOrigins) ? normalizedOrigin : null;
    const oauthCallbackNavigationRequest = isOAuthCallbackNavigationRequest(req);

    if (req.method === "OPTIONS") {
      if (!allowedOrigin) {
        log.warn("Blocked cross-origin CORS preflight request", {
          method: req.method,
          path: req.path,
          origin: originHeader,
          expectedOrigins,
        });
        res.sendStatus(403);
        return;
      }

      res.setHeader("Vary", "Origin");
      res.setHeader("Access-Control-Allow-Origin", allowedOrigin);
      res.setHeader("Access-Control-Allow-Methods", "GET, POST, PUT, DELETE, OPTIONS");
      res.setHeader("Access-Control-Allow-Headers", "Authorization, Content-Type");
      res.setHeader("Access-Control-Allow-Credentials", "true");
      res.setHeader("Access-Control-Max-Age", "86400");
      res.sendStatus(204);
      return;
    }

    if (!allowedOrigin) {
      // OAuth redirects can legitimately arrive from a different origin (including
      // response_mode=form_post). These callback handlers validate OAuth state
      // before exchanging codes, so allowing navigation requests here is safe.
      if (oauthCallbackNavigationRequest) {
        next();
        return;
      }

      log.warn("Blocked cross-origin HTTP request", {
        method: req.method,
        path: req.path,
        origin: originHeader,
        expectedOrigins,
      });
      res.sendStatus(403);
      return;
    }

    res.setHeader("Vary", "Origin");
    res.setHeader("Access-Control-Allow-Origin", allowedOrigin);
    res.setHeader("Access-Control-Allow-Credentials", "true");
    next();
  });

  // OAuth providers may use POST redirects (307/308) or response_mode=form_post.
  // Support both JSON API requests and form-encoded callback payloads.
  app.use(express.json({ limit: "50mb" }));
  app.use(express.urlencoded({ extended: false }));

  let rawSpaIndexHtml: string | null = null;

  // Static file serving (optional)
  if (serveStatic) {
    try {
      const indexHtmlPath = path.join(staticDir, "index.html");
      rawSpaIndexHtml = await fs.readFile(indexHtmlPath, "utf8");
    } catch (error) {
      log.error("Failed to read index.html for SPA fallback:", error);
    }

    // Serve JS/CSS/assets from disk, but never serve index.html — the SPA fallback
    // (below all API routes) serves the injected version with base href + proxy template.
    const serveStaticAssets = express.static(staticDir, { index: false });
    app.use((req, res, next) => {
      if (req.path === "/index.html") return next();
      serveStaticAssets(req, res, next);
    });
  }

  // Health check endpoint
  app.get("/health", (_req, res) => {
    res.json({ status: "ok" });
  });

  // Version endpoint
  app.get("/version", (_req, res) => {
    res.json({ ...VERSION, mode: "server" });
  });

  function getRequestIpAddress(
    req: Pick<express.Request, "headers" | "socket">
  ): string | undefined {
    const forwardedFor = getFirstHeaderValue(req, "x-forwarded-for");
    if (forwardedFor) {
      const first = forwardedFor.split(",")[0]?.trim();
      if (first) {
        return first;
      }
    }

    const remoteAddress = req.socket.remoteAddress?.trim();
    return remoteAddress?.length ? remoteAddress : undefined;
  }

  function isSecureRequest(req: OriginValidationRequest): boolean {
    return getPreferredPublicProtocol(req, allowHttpOrigin) === "https";
  }

  function getServerSessionCookiePath(req: express.Request): string {
    return getRequestPublicBasePath(req, { allowReferer: true });
  }

  function buildServerSessionCookie(
    sessionToken: string,
    secure: boolean,
    cookiePath: string
  ): string {
    const encoded = encodeURIComponent(sessionToken);
    return `${SERVER_AUTH_SESSION_COOKIE_NAME}=${encoded}; Path=${cookiePath}; HttpOnly; SameSite=Strict; Max-Age=${SERVER_AUTH_SESSION_MAX_AGE_SECONDS}${secure ? "; Secure" : ""}`;
  }

  async function isHttpRequestAuthenticated(req: express.Request): Promise<boolean> {
    if (!authToken?.trim()) {
      return true;
    }

    const expectedToken = authToken.trim();
    const presentedToken = extractBearerToken(req.header("authorization"));
    if (presentedToken && safeEq(presentedToken, expectedToken)) {
      return true;
    }

    const sessionTokens = extractCookieValues(req.headers.cookie, SERVER_AUTH_SESSION_COOKIE_NAME);
    if (sessionTokens.length === 0) {
      return false;
    }

    for (const sessionToken of sessionTokens) {
      const validation = await context.serverAuthService.validateSessionToken(sessionToken, {
        userAgent: req.header("user-agent") ?? undefined,
        ipAddress: getRequestIpAddress(req),
      });

      if (validation != null) {
        return true;
      }
    }

    return false;
  }

  function getStringParamFromQueryOrBody(req: express.Request, key: string): string | null {
    const queryValue = req.query[key];
    if (typeof queryValue === "string") return queryValue;

    const bodyRecord = req.body as Record<string, unknown> | undefined;
    const bodyValue = bodyRecord?.[key];
    return typeof bodyValue === "string" ? bodyValue : null;
  }
  app.get("/auth/server-login/options", (_req, res) => {
    res.json({ githubDeviceFlowEnabled: context.serverAuthService.isGithubDeviceFlowEnabled() });
  });

  app.post("/auth/server-login/github/start", async (_req, res) => {
    const startResult = await context.serverAuthService.startGithubDeviceFlow();
    if (!startResult.success) {
      const status = startResult.error.includes("Too many concurrent GitHub login attempts")
        ? 429
        : 400;
      res.status(status).json({ error: startResult.error });
      return;
    }

    res.json(startResult.data);
  });

  app.post("/auth/server-login/github/wait", async (req, res) => {
    const flowId = getStringParamFromQueryOrBody(req, "flowId");
    if (!flowId) {
      res.status(400).json({ error: "Missing flowId" });
      return;
    }

    let canceledByDisconnect = false;
    const cancelFlowForDisconnect = () => {
      if (canceledByDisconnect) {
        return;
      }

      canceledByDisconnect = true;
      context.serverAuthService.cancelGithubDeviceFlow(flowId);
    };

    const handleRequestAborted = () => {
      cancelFlowForDisconnect();
    };
    const handleRequestClose = () => {
      if (req.aborted && !res.writableEnded) {
        cancelFlowForDisconnect();
      }
    };
    const handleResponseClose = () => {
      if (!res.writableEnded) {
        cancelFlowForDisconnect();
      }
    };

    req.once("aborted", handleRequestAborted);
    req.once("close", handleRequestClose);
    res.once("close", handleResponseClose);

    try {
      const waitResult = await context.serverAuthService.waitForGithubDeviceFlow(flowId, {
        userAgent: req.header("user-agent") ?? undefined,
        ipAddress: getRequestIpAddress(req),
      });

      if (canceledByDisconnect || res.writableEnded) {
        return;
      }

      if (!waitResult.success) {
        res.status(400).json({ error: waitResult.error });
        return;
      }

      res.setHeader(
        "Set-Cookie",
        buildServerSessionCookie(
          waitResult.data.sessionToken,
          isSecureRequest(req),
          getServerSessionCookiePath(req)
        )
      );
      res.json({ ok: true });
    } finally {
      req.off("aborted", handleRequestAborted);
      req.off("close", handleRequestClose);
      res.off("close", handleResponseClose);
    }
  });

  /**
   * Browser-facing page for a server-hosted OAuth callback: reports the
   * outcome, posts it to the opener (the Settings tab), and closes itself on
   * success. Shared by every provider whose authorization redirect lands on
   * this server rather than on a desktop loopback listener.
   */
  function sendOAuthCallbackPage(
    req: express.Request,
    res: express.Response,
    input: { type: string; state: string | null; result: Result<void, string> }
  ): void {
    const payload = {
      type: input.type,
      state: input.state,
      ok: input.result.success,
      error: input.result.success ? null : input.result.error,
    };

    const payloadJson = escapeJsonForHtmlScript(payload);

    const title = input.result.success ? "Login complete" : "Login failed";
    const description = input.result.success
      ? "You can return to Xum. You may now close this tab."
      : payload.error
        ? escapeHtml(payload.error)
        : "An unknown error occurred.";
    const returnPath = getPublicAppRootPath(req, res);
    const returnPathJson = escapeJsonForHtmlScript(returnPath);
    const returnPathHref = escapeHtmlAttribute(returnPath);

    const html = `<!doctype html>
<html lang="en">
  <head>
    <meta charset="utf-8" />
    <meta name="viewport" content="width=device-width, initial-scale=1" />
    <meta name="color-scheme" content="dark light" />
    <meta name="theme-color" content="#0e0e0e" />
    <title>${title}</title>
    <link rel="stylesheet" href="https://gateway.mux.coder.com/static/css/site.css" />
  </head>
  <body>
    <div class="page">
      <header class="site-header">
        <div class="container">
          <div class="header-title">xum</div>
        </div>
      </header>

      <main class="site-main">
        <div class="container">
          <div class="content-surface">
            <h1>${title}</h1>
            <p>${description}</p>
            ${input.result.success ? '<p class="muted">This tab should close automatically.</p>' : ""}
            <p><a class="btn primary" href="${returnPathHref}">Return to Xum</a></p>
          </div>
        </div>
      </main>
    </div>

    <script>
      (() => {
        const payload = ${payloadJson};
        const ok = payload.ok === true;

        try {
          if (window.opener && typeof window.opener.postMessage === "function") {
            window.opener.postMessage(payload, "*");
          }
        } catch {
          // Ignore postMessage failures.
        }

        if (!ok) {
          return;
        }

        try {
          if (window.opener && typeof window.opener.focus === "function") {
            window.opener.focus();
          }
        } catch {
          // Ignore focus failures.
        }

        try {
          window.close();
        } catch {
          // Ignore close failures.
        }

        setTimeout(() => {
          try {
            window.close();
          } catch {
            // Ignore close failures.
          }
        }, 50);

        setTimeout(() => {
          try {
            window.location.replace(${returnPathJson});
          } catch {
            // Ignore navigation failures.
          }
        }, 150);
      })();
    </script>
  </body>
</html>`;

    res.status(input.result.success ? 200 : 400);
    res.setHeader("Content-Type", "text/html");
    res.send(html);
  }

  // --- Xum Gateway OAuth (unauthenticated bootstrap routes) ---
  // These are raw Express routes (not oRPC) because the OAuth provider cannot
  // send a mux Bearer token during the redirect callback.
  app.get("/auth/mux-gateway/start", async (req, res) => {
    if (!(await isHttpRequestAuthenticated(req))) {
      res.status(401).json({ error: "Invalid or missing auth token/session" });
      return;
    }

    const redirectUri = buildPublicAbsoluteUrl(req, "/auth/mux-gateway/callback", allowHttpOrigin);
    if (!redirectUri) {
      res.status(400).json({ error: "Missing or invalid Host header" });
      return;
    }
    const { authorizeUrl, state } = context.muxGatewayOauthService.startServerFlow({ redirectUri });
    res.json({ authorizeUrl, state });
  });

  app.all("/auth/mux-gateway/callback", async (req, res) => {
    // Some providers use 307/308 redirects that preserve POST, or response_mode=form_post.
    if (req.method !== "GET" && req.method !== "POST") {
      res.sendStatus(405);
      return;
    }

    const state = getStringParamFromQueryOrBody(req, "state");
    const code = getStringParamFromQueryOrBody(req, "code");
    const error = getStringParamFromQueryOrBody(req, "error");
    const errorDescription = getStringParamFromQueryOrBody(req, "error_description") ?? undefined;

    const result = await context.muxGatewayOauthService.handleServerCallbackAndExchange({
      state,
      code,
      error,
      errorDescription,
    });

    sendOAuthCallbackPage(req, res, { type: "mux-gateway-oauth", state, result });
  });

  // --- Xum Governor OAuth (unauthenticated bootstrap routes) ---
  // Similar to Xum Gateway OAuth but accepts user-provided governorUrl.
  app.get("/auth/mux-governor/start", async (req, res) => {
    if (!(await isHttpRequestAuthenticated(req))) {
      res.status(401).json({ error: "Invalid or missing auth token/session" });
      return;
    }

    const governorUrl = typeof req.query.governorUrl === "string" ? req.query.governorUrl : null;
    if (!governorUrl) {
      res.status(400).json({ error: "Missing governorUrl query parameter" });
      return;
    }

    const redirectUri = buildPublicAbsoluteUrl(req, "/auth/mux-governor/callback", allowHttpOrigin);
    if (!redirectUri) {
      res.status(400).json({ error: "Missing or invalid Host header" });
      return;
    }
    const result = context.muxGovernorOauthService.startServerFlow({
      governorOrigin: governorUrl,
      redirectUri,
    });

    if (!result.success) {
      res.status(400).json({ error: result.error });
      return;
    }

    res.json({ authorizeUrl: result.data.authorizeUrl, state: result.data.state });
  });

  app.all("/auth/mux-governor/callback", async (req, res) => {
    // Some providers use 307/308 redirects that preserve POST, or response_mode=form_post.
    if (req.method !== "GET" && req.method !== "POST") {
      res.sendStatus(405);
      return;
    }

    const state = getStringParamFromQueryOrBody(req, "state");
    const code = getStringParamFromQueryOrBody(req, "code");
    const error = getStringParamFromQueryOrBody(req, "error");
    const errorDescription = getStringParamFromQueryOrBody(req, "error_description") ?? undefined;

    log.debug("Governor OAuth callback received", {
      method: req.method,
      state,
      hasCode: typeof code === "string" && code.length > 0,
      hasError: typeof error === "string" && error.length > 0,
    });

    const result = await context.muxGovernorOauthService.handleServerCallbackAndExchange({
      state,
      code,
      error,
      errorDescription,
    });

    const payload = {
      type: "mux-governor-oauth",
      state,
      ok: result.success,
      error: result.success ? null : result.error,
    };

    const payloadJson = escapeJsonForHtmlScript(payload);

    const title = result.success ? "Enrollment complete" : "Enrollment failed";
    const description = result.success
      ? "You can return to Xum. You may now close this tab."
      : payload.error
        ? escapeHtml(payload.error)
        : "An unknown error occurred.";
    const returnPath = getPublicAppRootPath(req, res);
    const returnPathJson = escapeJsonForHtmlScript(returnPath);
    const returnPathHref = escapeHtmlAttribute(returnPath);

    const html = `<!doctype html>
<html lang="en">
  <head>
    <meta charset="utf-8" />
    <meta name="viewport" content="width=device-width, initial-scale=1" />
    <meta name="color-scheme" content="dark light" />
    <title>${title}</title>
    <style>
      body { font-family: system-ui, sans-serif; max-width: 600px; margin: 4rem auto; padding: 1rem; }
      h1 { margin-bottom: 1rem; }
      .muted { color: #666; }
      .btn { display: inline-block; padding: 0.5rem 1rem; background: #333; color: #fff; text-decoration: none; border-radius: 4px; }
    </style>
  </head>
  <body>
    <h1>${title}</h1>
    <p>${description}</p>
    ${result.success ? '<p class="muted">This tab should close automatically.</p>' : ""}
    <p><a class="btn" href="${returnPathHref}">Return to Xum</a></p>

    <script>
      (() => {
        const payload = ${payloadJson};
        const ok = payload.ok === true;

        try {
          if (window.opener && typeof window.opener.postMessage === "function") {
            window.opener.postMessage(payload, "*");
          }
        } catch {
          // Ignore postMessage failures.
        }

        if (!ok) {
          return;
        }

        try {
          if (window.opener && typeof window.opener.focus === "function") {
            window.opener.focus();
          }
        } catch {
          // Ignore focus failures.
        }

        try {
          window.close();
        } catch {
          // Ignore close failures.
        }

        setTimeout(() => {
          try {
            window.close();
          } catch {
            // Ignore close failures.
          }
        }, 50);

        setTimeout(() => {
          try {
            window.location.replace(${returnPathJson});
          } catch {
            // Ignore navigation failures.
          }
        }, 150);
      })();
    </script>
  </body>
</html>`;

    res.status(result.success ? 200 : 400);
    res.setHeader("Content-Type", "text/html");
    res.send(html);
  });

  // --- MCP OAuth (unauthenticated redirect callback) ---
  // The OAuth provider cannot attach a mux Bearer token during redirects.
  app.all("/auth/mcp-oauth/callback", async (req, res) => {
    // Some providers use 307/308 redirects that preserve POST, or response_mode=form_post.
    if (req.method !== "GET" && req.method !== "POST") {
      res.sendStatus(405);
      return;
    }

    const state = getStringParamFromQueryOrBody(req, "state");
    const code = getStringParamFromQueryOrBody(req, "code");
    const error = getStringParamFromQueryOrBody(req, "error");
    const errorDescription = getStringParamFromQueryOrBody(req, "error_description") ?? undefined;

    const result = await context.mcpOauthService.handleServerCallbackAndExchange({
      state,
      code,
      error,
      errorDescription,
    });

    sendOAuthCallbackPage(req, res, { type: "mcp-oauth", state, result });
  });

  // --- Coder OAuth ("Login with Coder", browser/server mode) ---
  // Desktop clients use the oRPC startDesktopFlow with a loopback listener; a
  // browser talking to a (possibly remote) Xum server cannot reach that
  // listener, so the redirect targets this server instead. Raw Express routes:
  // the start route needs the request's validated public host to build the
  // redirect URI (never accepted from the client), and the callback arrives
  // without a Bearer token. The flow itself is the shared one, so the client
  // keeps waiting/cancelling through oRPC.
  app.get(CODER_OAUTH_SERVER_START_PATH, async (req, res) => {
    if (!(await isHttpRequestAuthenticated(req))) {
      res.status(401).json({ error: "Invalid or missing auth token/session" });
      return;
    }

    const deploymentUrl =
      typeof req.query.deploymentUrl === "string" ? req.query.deploymentUrl : null;
    if (!deploymentUrl) {
      res.status(400).json({ error: "Missing deploymentUrl query parameter" });
      return;
    }
    const flowId = typeof req.query.flowId === "string" ? req.query.flowId : undefined;

    const redirectUri = buildPublicAbsoluteUrl(
      req,
      CODER_OAUTH_SERVER_CALLBACK_PATH,
      allowHttpOrigin
    );
    if (!redirectUri) {
      res.status(400).json({ error: "Missing or invalid Host header" });
      return;
    }
    const result = await context.coderOauthService.startServerFlow({
      deploymentUrl,
      flowId,
      redirectUri,
    });
    if (!result.success) {
      res.status(400).json({ error: result.error });
      return;
    }
    res.json(result.data);
  });

  app.all(CODER_OAUTH_SERVER_CALLBACK_PATH, async (req, res) => {
    // Some providers use 307/308 redirects that preserve POST, or response_mode=form_post.
    if (req.method !== "GET" && req.method !== "POST") {
      res.sendStatus(405);
      return;
    }

    const state = getStringParamFromQueryOrBody(req, "state");
    const code = getStringParamFromQueryOrBody(req, "code");
    const error = getStringParamFromQueryOrBody(req, "error");
    const errorDescription = getStringParamFromQueryOrBody(req, "error_description") ?? undefined;

    const result = await context.coderOauthService.handleServerCallback({
      state,
      code,
      error,
      errorDescription,
    });

    sendOAuthCallbackPage(req, res, { type: "coder-oauth", state, result });
  });

  const orpcRouter = existingRouter ?? router(authToken);

  // OpenAPI generator for spec endpoint
  const openAPIGenerator = createOpenAPIGenerator();

  // OpenAPI spec endpoint
  app.get("/api/spec.json", async (req, res) => {
    const versionRecord = VERSION as Record<string, unknown>;
    const gitDescribe =
      typeof versionRecord.git_describe === "string" ? versionRecord.git_describe : "unknown";
    const publicApiPath = joinPublicBasePath(
      getPublicBasePathForRequest(req, res, { allowReferer: true }),
      "/api"
    );

    // oRPC >=1.14 nests document fields under `base` instead of top-level options.
    const spec = await openAPIGenerator.generate(orpcRouter, {
      base: {
        info: {
          title: "Xum API",
          version: gitDescribe,
          description: "API for Xum",
        },
        servers: [{ url: publicApiPath }],
        security: authToken ? [{ bearerAuth: [] }] : undefined,
        components: authToken
          ? {
              securitySchemes: {
                bearerAuth: {
                  type: "http",
                  scheme: "bearer",
                },
              },
            }
          : undefined,
      },
    });
    varyPublicBasePathHeaders(res);
    res.json(spec);
  });

  // Scalar API reference UI
  app.get("/api/docs", (req, res) => {
    const specPath = joinPublicBasePath(
      getPublicBasePathForRequest(req, res, { allowReferer: true }),
      "/api/spec.json"
    );
    const specPathJson = escapeJsonForHtmlScript(specPath);
    const html = `<!doctype html>
<html>
  <head>
    <title>xum API Reference</title>
    <meta charset="utf-8" />
    <meta name="viewport" content="width=device-width, initial-scale=1" />
  </head>
  <body>
    <div id="app"></div>
    <script src="https://cdn.jsdelivr.net/npm/@scalar/api-reference"></script>
    <script>
      Scalar.createApiReference('#app', {
        url: ${specPathJson},
        ${authToken ? "authentication: { securitySchemes: { bearerAuth: { token: '' } } }," : ""}
      })
    </script>
  </body>
</html>`;
    varyPublicBasePathHeaders(res);
    res.setHeader("Content-Type", "text/html");
    res.setHeader("Cache-Control", "no-store");
    res.send(html);
  });

  // OpenAPI REST handler (for Scalar/OpenAPI clients)
  const openAPIHandler = new OpenAPIHandler(orpcRouter, {
    interceptors: [onError(onOrpcError)],
  });

  app.use("/api", async (req, res, next) => {
    // Skip spec.json and docs routes - they're handled above
    if (req.path === "/spec.json" || req.path === "/docs") {
      return next();
    }
    const { matched } = await openAPIHandler.handle(req, res, {
      prefix: getDirectAppProxyHandlerPrefix(req, "/api"),
      context: { ...context, headers: req.headers },
    });
    if (matched) return;
    next();
  });

  // oRPC HTTP handler
  const orpcHandler = new RPCHandler(orpcRouter, {
    interceptors: [onError(onOrpcError)],
  });

  // Mount ORPC handler on /orpc and all subpaths
  app.use("/orpc", async (req, res, next) => {
    const { matched } = await orpcHandler.handle(req, res, {
      prefix: getDirectAppProxyHandlerPrefix(req, "/orpc"),
      context: {
        ...context,
        headers: req.headers,
        issueWebSocketTicket:
          req.method === "POST"
            ? () => {
                res.setHeader("Cache-Control", "no-store");
                const issued = webSocketTickets.mint();
                if (!issued)
                  throw new ORPCError("TOO_MANY_REQUESTS", {
                    message: "WebSocket ticket capacity unavailable",
                  });
                return issued;
              }
            : undefined,
      },
    });
    if (matched) return;
    next();
  });

  // SPA fallback (optional, only for non-API routes)
  if (serveStatic) {
    app.use((req, res, next) => {
      // Don't swallow API/ORPC routes with index.html.
      if (req.path.startsWith("/orpc") || req.path.startsWith("/api")) {
        return next();
      }

      if (rawSpaIndexHtml !== null) {
        const spaIndexHtml = injectProxyUriTemplate(
          injectBaseHref(rawSpaIndexHtml, getPublicBaseHref(req, res), {
            includeSlashlessRootRedirect: shouldInjectSlashlessRootRedirect(req),
          }),
          getBrowserProxyUriTemplate()
        );
        varyPublicBasePathHeaders(res);
        res.setHeader("Content-Type", "text/html");
        res.setHeader("Cache-Control", "no-store");
        res.send(spaIndexHtml);
        return;
      }

      // If the server was started with serveStatic enabled but the frontend build
      // hasn't been generated (common in `make dev-server`), avoid throwing noisy
      // NotFoundError stack traces. Let the request fall through to a normal 404.
      next();
    });
  }

  const httpServer = http.createServer(app);

  // Avoid process crashes from unhandled socket/server errors.
  attachStreamErrorHandler(httpServer, "orpc-http-server", { logger: log });

  httpServer.on("clientError", (error, socket) => {
    if (isIgnorableStreamError(error)) {
      socket.destroy();
      return;
    }

    const message = getErrorMessage(error);
    const code =
      error && typeof error === "object" && "code" in error && typeof error.code === "string"
        ? error.code
        : undefined;

    log.warn("ORPC HTTP client error", { code, message });

    try {
      socket.end("HTTP/1.1 400 Bad Request\r\n\r\n");
    } catch {
      socket.destroy();
    }
  });

  // oRPC WebSocket handler
  const wsServer = new WebSocketServer({
    noServer: true,
    handleProtocols: (protocols, req) =>
      parseWebSocketTicketProtocols(req.headers["sec-websocket-protocol"]).type === "ticket"
        ? ORPC_WS_PROTOCOL
        : (protocols.values().next().value ?? false),
  });

  httpServer.on("upgrade", (req, socket, head) => {
    const normalizedRoute = getNormalizedUpgradeRoute(req.url);
    if (!normalizedRoute) {
      socket.destroy();
      return;
    }

    const { routePathname, routeUrl } = normalizedRoute;
    if (routePathname === ORPC_WS_PATH) {
      req.url = routeUrl;
      const expectedOrigins = getExpectedOrigins(req, allowHttpOrigin);
      if (!isOriginAllowed(req, expectedOrigins)) {
        log.warn("Blocked cross-origin WebSocket upgrade request", {
          origin: getFirstHeaderValue(req, "origin"),
          expectedOrigins,
          url: routePathname,
        });

        try {
          socket.write("HTTP/1.1 403 Forbidden\r\nConnection: close\r\n\r\n");
        } finally {
          socket.destroy();
        }

        return;
      }

      const ticket = parseWebSocketTicketProtocols(req.headers["sec-websocket-protocol"]);
      if (
        ticket.type === "invalid" ||
        (ticket.type === "ticket" && !webSocketTickets.isValid(ticket.ticket))
      ) {
        socket.end("HTTP/1.1 401 Unauthorized\r\nConnection: close\r\n\r\n", () =>
          socket.destroy()
        );
        return;
      }
      wsServer.handleUpgrade(req, socket, head, (ws) => {
        // No awaits: competing successful peeks must yield only one authorized
        // consumer, before any connection listener or oRPC context can observe it.
        if (ticket.type === "ticket") {
          if (!webSocketTickets.consume(ticket.ticket)) {
            ws.terminate();
            return;
          }
          ticketAuthenticatedRequests.add(req);
          req.headers["sec-websocket-protocol"] = ORPC_WS_PROTOCOL;
        }
        wsServer.emit("connection", ws, req);
      });
      return;
    }

    if (routePathname === BROWSER_BRIDGE_WS_PATH) {
      req.url = routeUrl;
      assert(
        routePathname === BROWSER_BRIDGE_WS_PATH,
        "Browser relay upgrades must use BROWSER_BRIDGE_WS_PATH"
      );
      assert(
        browserBridgeServer,
        "createOrpcServer requires browserBridgeServer for browser relay upgrades"
      );
      browserBridgeServer.handleUpgrade(req, socket, head);
      return;
    }

    if (routePathname === DESKTOP_WS_PATH) {
      req.url = routeUrl;
      assert(routePathname === DESKTOP_WS_PATH, "Desktop relay upgrades must use DESKTOP_WS_PATH");
      assert(
        desktopBridgeServer,
        "createOrpcServer requires desktopBridgeServer for desktop relay upgrades"
      );
      desktopBridgeServer.handleUpgrade(req, socket, head);
      return;
    }

    socket.destroy();
  });

  attachStreamErrorHandler(wsServer, "orpc-ws-server", { logger: log });

  // WebSocket heartbeat: proactively terminate half-open connections (common with NAT/proxy setups).
  // When a client is unresponsive, closing the socket forces the browser to reconnect.
  const heartbeatInterval = setInterval(() => {
    for (const ws of wsServer.clients) {
      const socket = ws as AliveWebSocket;
      if (socket.isAlive === false) {
        ws.terminate();
        continue;
      }

      socket.isAlive = false;
      try {
        ws.ping();
      } catch {
        // Best-effort - ws may already be closing.
      }
    }
  }, WS_HEARTBEAT_INTERVAL_MS);

  const orpcWsHandler = new ORPCWebSocketServerHandler(orpcRouter, {
    interceptors: [onError(onOrpcError)],
  });

  wsServer.on("connection", (ws, req) => {
    const terminate = () => {
      try {
        ws.terminate();
      } catch {
        // Best-effort.
      }
    };

    attachStreamErrorHandler(ws, "orpc-ws-connection", {
      logger: log,
      onIgnorable: terminate,
      onUnexpected: terminate,
    });
    const socket = ws as AliveWebSocket;
    socket.isAlive = true;
    ws.on("pong", () => {
      socket.isAlive = true;
    });

    const ticketAuthenticated = ticketAuthenticatedRequests.has(req);
    const headers = ticketAuthenticated ? { ...req.headers } : extractWsHeaders(req);
    if (ticketAuthenticated) authorizeWebSocketTicketHeaders(headers);
    // Use Object.defineProperties to copy all property descriptors from
    // the base context as own-properties (required by oRPC's internal
    // property enumeration) while preserving any lazily-resolving getters.
    const wsContext = Object.defineProperties({} as typeof context, {
      ...Object.getOwnPropertyDescriptors(context),
      issueWebSocketTicket: { value: undefined, enumerable: true, configurable: true },
      headers: {
        value: headers,
        enumerable: true,
        configurable: true,
        writable: true,
      },
    });
    void orpcWsHandler.upgrade(ws, { context: wsContext });
  });

  // Start listening
  await new Promise<void>((resolve, reject) => {
    const onListenError = (error: Error) => {
      httpServer.removeListener("error", onListenError);
      reject(error);
    };

    httpServer.once("error", onListenError);
    httpServer.listen(port, host, () => {
      httpServer.removeListener("error", onListenError);
      resolve();
    });
  });

  // Get actual port (useful when port=0)
  const address = httpServer.address();
  if (!address || typeof address === "string") {
    throw new Error("Failed to get server address");
  }
  const actualPort = address.port;

  // Wildcard addresses (0.0.0.0, ::) are not routable - convert to loopback for lockfile
  const connectableHost = host === "0.0.0.0" || host === "::" ? "127.0.0.1" : host;
  const connectableHostForUrl = formatHostForUrl(connectableHost);

  return {
    httpServer,
    wsServer,
    app,
    port: actualPort,
    baseUrl: `http://${connectableHostForUrl}:${actualPort}`,
    wsUrl: `ws://${connectableHostForUrl}:${actualPort}${ORPC_WS_PATH}`,
    specUrl: `http://${connectableHostForUrl}:${actualPort}/api/spec.json`,
    docsUrl: `http://${connectableHostForUrl}:${actualPort}/api/docs`,
    close: async () => {
      webSocketTickets.dispose();
      clearInterval(heartbeatInterval);
      for (const ws of wsServer.clients) {
        ws.terminate();
      }

      // Close ORPC WebSocket server first.
      await new Promise<void>((resolve) => {
        wsServer.close(() => resolve());
      });

      // Desktop relay upgrades are owned by the same HTTP server, so close them
      // before awaiting httpServer.close() to avoid shutdown hanging on upgraded sockets.
      if (desktopBridgeServer) {
        await desktopBridgeServer.stop();
      }
      if (browserBridgeServer) {
        await browserBridgeServer.stop();
      }

      // Then close HTTP server.
      httpServer.closeIdleConnections?.();
      httpServer.closeAllConnections?.();
      if (httpServer.listening) {
        await new Promise<void>((resolve, reject) => {
          httpServer.close((err) => (err ? reject(err) : resolve()));
        });
      }
    },
  };
}

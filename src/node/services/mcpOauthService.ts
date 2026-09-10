import * as crypto from "crypto";
import * as http from "http";
import type { IncomingHttpHeaders } from "http";
import * as path from "path";
import * as fsPromises from "fs/promises";
import writeFileAtomic from "write-file-atomic";
import {
  auth,
  type OAuthClientProvider,
  type OAuthDiscoveryState,
} from "@modelcontextprotocol/client";
import type { Config } from "@/node/config";
import type { MCPConfigService } from "@/node/services/mcpConfigService";
import type { WindowService } from "@/node/services/windowService";
import type { TelemetryService } from "@/node/services/telemetryService";
import { isProjectTrusted } from "@/node/utils/projectTrust";
import { log } from "@/node/services/log";
import type { Result } from "@/common/types/result";
import { Err, Ok } from "@/common/types/result";
import { roundToBase2 } from "@/common/telemetry/utils";
import type {
  MCPOAuthAuthStatus,
  MCPOAuthClientInformation,
  MCPOAuthPendingServerConfig,
  MCPOAuthStoredCredentials,
  MCPOAuthTokens,
} from "@/common/types/mcpOauth";
import { stripTrailingSlashes } from "@/node/utils/pathUtils";
import { MutexMap } from "@/node/utils/concurrency/mutexMap";
import { closeServer, createDeferred, renderOAuthCallbackHtml } from "@/node/utils/oauthUtils";
import { getErrorMessage } from "@/common/utils/errors";

const DEFAULT_DESKTOP_TIMEOUT_MS = 5 * 60 * 1000;
const DEFAULT_SERVER_TIMEOUT_MS = 10 * 60 * 1000;
const COMPLETED_FLOW_TTL_MS = 60 * 1000;
const STORE_FILE_NAME = "mcp-oauth.json";

interface McpOauthStoreFileV1 {
  version: 1;
  /** projectPath -> serverName -> stored credentials */
  entries: Record<string, Record<string, MCPOAuthStoredCredentials>>;
}

interface McpOauthStoreFileV2 {
  version: 2;
  /**
   * Global credentials store.
   *
   * Keyed by normalizeServerUrlForComparison(creds.serverUrl).
   */
  entries: Record<string, MCPOAuthStoredCredentials>;
}

type McpOauthStoreFile = McpOauthStoreFileV2;

function createEmptyStore(): McpOauthStoreFileV2 {
  return { version: 2, entries: {} };
}

// Exported for focused unit tests (WWW-Authenticate parsing) without requiring
// a real OAuth server.
export interface BearerChallenge {
  /** The full raw WWW-Authenticate header value (best-effort). */
  raw: string;
  scope?: string;
  resourceMetadataUrl?: URL;
}

interface OAuthFlowBase {
  flowId: string;
  projectPath: string;
  serverName: string;

  /**
   * The configured MCP server URL (hash stripped), used for OAuth discovery/authorization.
   *
   * Important: Do NOT normalize trailing slashes here. Some servers rely on a trailing
   * slash (e.g. /mcp/) so relative OAuth discovery URLs resolve under that base path.
   */
  serverUrlForDiscovery: string;

  /**
   * Normalized MCP server URL used only for credential keying and comparison.
   *
   * We treat /foo and /foo/ as equivalent for stored credentials, so we strip a
   * non-root trailing slash.
   */
  serverUrlForStoreKey: string;

  transport: "http" | "sse" | "auto";
  startedAtMs: number;

  /**
   * OAuth client information registered for this specific flow.
   *
   * We keep the per-flow client_id in memory for the subsequent authorization
   * code exchange.
   */
  clientInformation: MCPOAuthClientInformation | null;

  authorizeUrl: string;
  redirectUri: string;

  /** Optional values discovered from WWW-Authenticate. */
  scope?: string;
  resourceMetadataUrl?: URL;

  /** PKCE verifier for this flow (set by the MCP SDK auth()). */
  codeVerifier: string | null;
  discoveryState: OAuthDiscoveryState | undefined;

  timeout: ReturnType<typeof setTimeout>;
  cleanupTimeout: ReturnType<typeof setTimeout> | null;

  resultPromise: Promise<Result<void, string>>;
  resolveResult: (result: Result<void, string>) => void;
  settled: boolean;
}

interface DesktopFlow extends OAuthFlowBase {
  server: http.Server;
}

type ServerFlow = OAuthFlowBase;

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

function normalizeProjectPathKey(projectPath: string): string {
  // Keep keys stable across callers; config already strips trailing slashes.
  return stripTrailingSlashes(projectPath);
}

/**
 * Normalizes an MCP server URL only for keying/comparing stored credentials.
 *
 * Important: This MUST NOT be used for OAuth discovery/authorization requests.
 * Removing a trailing slash changes how relative URLs resolve (e.g. /mcp vs /mcp/).
 */
function normalizeServerUrlForComparison(serverUrl: string): string | null {
  try {
    const url = new URL(serverUrl);

    // Avoid accidental mismatch from an irrelevant hash.
    url.hash = "";

    // Normalize trailing slashes for comparison (treat /foo and /foo/ as equivalent).
    if (url.pathname.endsWith("/") && url.pathname !== "/") {
      url.pathname = url.pathname.slice(0, -1);
    }

    return url.toString();
  } catch {
    return null;
  }
}

/**
 * Sanitizes an MCP server URL for network requests.
 *
 * This intentionally does not normalize the pathname; we only strip the hash.
 */
function sanitizeServerUrlForRequest(serverUrl: string): string | null {
  try {
    const url = new URL(serverUrl);

    if (url.protocol !== "http:" && url.protocol !== "https:") {
      return null;
    }

    // Avoid accidental mismatch from an irrelevant hash.
    url.hash = "";

    return url.toString();
  } catch {
    return null;
  }
}

export function parseBearerWwwAuthenticate(header: string): BearerChallenge | null {
  const raw = header;

  // Minimal, spec-friendly extraction. We intentionally avoid implementing a full
  // RFC 7235 challenge parser; we only care about a subset of Bearer params.
  if (!/\bbearer\b/i.test(raw)) {
    return null;
  }

  const scopeMatch = /\bscope="([^"]*)"/i.exec(raw) ?? /\bscope=([^,\s]+)/i.exec(raw);
  const scope = scopeMatch ? scopeMatch[1] : undefined;

  const resourceMetadataMatch =
    /\bresource_metadata="([^"]*)"/i.exec(raw) ?? /\bresource_metadata=([^,\s]+)/i.exec(raw);

  let resourceMetadataUrl: URL | undefined;
  if (resourceMetadataMatch) {
    try {
      resourceMetadataUrl = new URL(resourceMetadataMatch[1]);
    } catch {
      // Ignore invalid URLs.
    }
  }

  return {
    raw,
    scope,
    resourceMetadataUrl,
  };
}

type BearerChallengeProbeTransport = OAuthFlowBase["transport"];

interface BearerChallengeProbeRequest {
  method: "GET" | "POST";
  headers: Record<string, string>;
  body?: string;
}

function getWwwAuthenticateHeader(response: Response): string | null {
  return response.headers.get("www-authenticate") ?? response.headers.get("WWW-Authenticate");
}

function getBearerChallengeProbeRequests(
  transport: BearerChallengeProbeTransport
): BearerChallengeProbeRequest[] {
  const sseRequest: BearerChallengeProbeRequest = {
    method: "GET",
    headers: {
      Accept: "text/event-stream",
    },
  };

  const httpRequest: BearerChallengeProbeRequest = {
    method: "POST",
    headers: {
      Accept: "application/json, text/event-stream",
      "Content-Type": "application/json",
    },
    // Mirror the HTTP transport's verb so POST-only MCP endpoints still emit their
    // Bearer challenge, but keep the payload tiny because we only need auth hints.
    body: "{}",
  };

  // Prefer the configured transport's verb first, then fall back to the other
  // remote verb so challenge discovery stays resilient across mixed deployments.
  return transport === "sse" ? [sseRequest, httpRequest] : [httpRequest, sseRequest];
}

export async function probeServerForBearerChallenge(options: {
  serverUrl: string;
  transport: BearerChallengeProbeTransport;
}): Promise<BearerChallenge | null> {
  const requestUrl = sanitizeServerUrlForRequest(options.serverUrl);
  if (!requestUrl) {
    return null;
  }

  const abortController = new AbortController();
  const timeout = setTimeout(() => abortController.abort(), 5_000);

  try {
    for (const request of getBearerChallengeProbeRequests(options.transport)) {
      try {
        const response = await fetch(requestUrl, {
          method: request.method,
          headers: request.headers,
          ...(request.body ? { body: request.body } : {}),
          redirect: "manual",
          signal: abortController.signal,
        });

        const header = getWwwAuthenticateHeader(response);
        if (!header) {
          continue;
        }

        const challenge = parseBearerWwwAuthenticate(header);
        if (challenge) {
          return challenge;
        }
      } catch {
        if (abortController.signal.aborted) {
          break;
        }
      }
    }

    return null;
  } finally {
    clearTimeout(timeout);
  }
}

/**
 * Resolve the OAuth scope to request for an authorization flow.
 *
 * The Bearer challenge's `scope=` wins when present. Otherwise we fall back to
 * the Protected Resource Metadata's `scopes_supported` (RFC 9728). The MCP SDK
 * fetches this same metadata to locate the authorization server but ignores its
 * advertised scopes, so without this a server that omits `scope=` from its 401
 * (e.g. Carta) grants only identity scopes and every resource call then fails
 * with a permission error.
 *
 * ponytail: re-fetches the PRM the SDK already fetched internally; the SDK does
 * not expose it, and this is one extra GET during an interactive flow.
 */
export async function resolveOAuthScope(
  challenge: BearerChallenge | null
): Promise<string | undefined> {
  if (challenge?.scope) {
    return challenge.scope;
  }
  if (!challenge?.resourceMetadataUrl) {
    return undefined;
  }
  const scopes = await fetchProtectedResourceScopes(challenge.resourceMetadataUrl);
  return scopes.length > 0 ? scopes.join(" ") : undefined;
}

async function fetchProtectedResourceScopes(url: URL): Promise<string[]> {
  try {
    const response = await fetch(url, {
      headers: { Accept: "application/json" },
      signal: AbortSignal.timeout(5_000),
    });
    if (!response.ok) {
      return [];
    }
    const json: unknown = await response.json();
    const scopes = isPlainObject(json) ? json.scopes_supported : undefined;
    return Array.isArray(scopes) ? scopes.filter((s): s is string => typeof s === "string") : [];
  } catch {
    return [];
  }
}

/**
 * Parses the legacy @ai-sdk/mcp authorization-server binding fields
 * (authorization_server / token_endpoint) from a stored credentials object.
 *
 * These MUST survive the store round-trip: the legacy @ai-sdk/mcp auth()
 * refused to use a stored refresh_token without them and instead invalidated
 * the tokens and demanded interactive re-login. The official SDK v2 ignores
 * these fields (it stamps `issuer` instead — see MCPOAuthTokens.issuer), but
 * we keep round-tripping them so downgrading Xum does not break token
 * refresh after an app restart.
 */
function parseAuthorizationServerBinding(value: {
  authorization_server?: unknown;
  token_endpoint?: unknown;
}): {
  authorization_server?: string;
  token_endpoint?: string;
} {
  // Defensive: only accept parseable http(s) URLs so a corrupted store value
  // cannot make the SDK's normalizeUrl()/new URL() throw during auth(), and
  // so SDK-invalid schemes (SafeUrlSchema rejects javascript:/data:/vbscript:)
  // are dropped for self-healing instead of surfacing as a metadata mismatch.
  // http(s)-only is stricter than SafeUrlSchema, which is fine: OAuth
  // authorization servers and token endpoints are always fetched over http(s).
  const asUrlString = (raw: unknown): string | undefined => {
    if (typeof raw !== "string" || !URL.canParse(raw)) {
      return undefined;
    }
    const protocol = new URL(raw).protocol;
    return protocol === "http:" || protocol === "https:" ? raw : undefined;
  };

  const authorizationServer = asUrlString(value.authorization_server);
  const tokenEndpoint = asUrlString(value.token_endpoint);

  // The SDK requires both to consider the binding usable; keep the pair atomic.
  if (!authorizationServer || !tokenEndpoint) {
    return {};
  }

  return { authorization_server: authorizationServer, token_endpoint: tokenEndpoint };
}

interface AuthorizationServerBinding {
  authorization_server: string;
  token_endpoint: string;
}

// Discovery is where both legacy binding fields are available for downgrade-compatible saves (#3823).
function deriveAuthorizationServerBinding(
  state: OAuthDiscoveryState | undefined
): AuthorizationServerBinding | undefined {
  const tokenEndpoint = state?.authorizationServerMetadata?.token_endpoint;
  if (!state?.authorizationServerUrl || !tokenEndpoint) {
    return undefined;
  }

  return {
    authorization_server: state.authorizationServerUrl,
    token_endpoint: tokenEndpoint,
  };
}

/**
 * Parses the official SDK v2 issuer stamp (SEP-2352 credential/issuer binding)
 * from a stored credentials object. Must survive the store round-trip:
 * dropping it would reactivate the SDK's unstamped-credential warning on every
 * request and defeat issuer binding. Same defensive http(s) validation as
 * parseAuthorizationServerBinding; a corrupted value is dropped for
 * self-healing (the SDK back-stamps on the next save).
 */
function parseIssuerStamp(value: Record<string, unknown>): { issuer?: string } {
  const raw = value.issuer;
  if (typeof raw !== "string" || !URL.canParse(raw)) {
    return {};
  }
  const protocol = new URL(raw).protocol;
  return protocol === "http:" || protocol === "https:" ? { issuer: raw } : {};
}

function parseStoredCredentials(value: unknown): MCPOAuthStoredCredentials | null {
  if (!isPlainObject(value)) {
    return null;
  }

  const serverUrlRaw = typeof value.serverUrl === "string" ? value.serverUrl : null;
  const updatedAtMs = typeof value.updatedAtMs === "number" ? value.updatedAtMs : null;

  if (!serverUrlRaw || updatedAtMs === null || !Number.isFinite(updatedAtMs)) {
    return null;
  }

  const serverUrl = normalizeServerUrlForComparison(serverUrlRaw);
  if (!serverUrl) {
    return null;
  }

  const clientInformationRaw = value.clientInformation;
  const clientInformation: MCPOAuthClientInformation | undefined = isPlainObject(
    clientInformationRaw
  )
    ? {
        client_id:
          typeof clientInformationRaw.client_id === "string" ? clientInformationRaw.client_id : "",
        client_secret:
          typeof clientInformationRaw.client_secret === "string"
            ? clientInformationRaw.client_secret
            : undefined,
        client_id_issued_at:
          typeof clientInformationRaw.client_id_issued_at === "number"
            ? clientInformationRaw.client_id_issued_at
            : undefined,
        client_secret_expires_at:
          typeof clientInformationRaw.client_secret_expires_at === "number"
            ? clientInformationRaw.client_secret_expires_at
            : undefined,
        ...parseAuthorizationServerBinding(clientInformationRaw),
        ...parseIssuerStamp(clientInformationRaw),
      }
    : undefined;

  if (clientInformation && !clientInformation.client_id) {
    // client_id is required if the object is present.
    return null;
  }

  const tokensRaw = value.tokens;
  const tokens: MCPOAuthTokens | undefined = isPlainObject(tokensRaw)
    ? {
        access_token: typeof tokensRaw.access_token === "string" ? tokensRaw.access_token : "",
        id_token: typeof tokensRaw.id_token === "string" ? tokensRaw.id_token : undefined,
        token_type: typeof tokensRaw.token_type === "string" ? tokensRaw.token_type : "",
        expires_in: typeof tokensRaw.expires_in === "number" ? tokensRaw.expires_in : undefined,
        scope: typeof tokensRaw.scope === "string" ? tokensRaw.scope : undefined,
        refresh_token:
          typeof tokensRaw.refresh_token === "string" ? tokensRaw.refresh_token : undefined,
        ...parseAuthorizationServerBinding(tokensRaw),
        ...parseIssuerStamp(tokensRaw),
      }
    : undefined;

  if (tokens && (!tokens.access_token || !tokens.token_type)) {
    return null;
  }

  return {
    serverUrl,
    clientInformation,
    tokens,
    updatedAtMs,
  };
}

function parseStoreFile(raw: string): McpOauthStoreFileV1 | McpOauthStoreFileV2 | null {
  try {
    const parsed = JSON.parse(raw) as unknown;
    if (!isPlainObject(parsed)) {
      return null;
    }

    const version = parsed.version;
    if (version !== 1 && version !== 2) {
      return null;
    }

    const entriesRaw = parsed.entries;
    if (!isPlainObject(entriesRaw)) {
      return null;
    }

    if (version === 1) {
      const entries: Record<string, Record<string, MCPOAuthStoredCredentials>> = {};

      for (const [projectPath, byServerRaw] of Object.entries(entriesRaw)) {
        if (!isPlainObject(byServerRaw)) {
          continue;
        }

        const byServer: Record<string, MCPOAuthStoredCredentials> = {};

        for (const [serverName, credRaw] of Object.entries(byServerRaw)) {
          const creds = parseStoredCredentials(credRaw);
          if (!creds) {
            continue;
          }

          byServer[serverName] = creds;
        }

        if (Object.keys(byServer).length > 0) {
          entries[projectPath] = byServer;
        }
      }

      return { version: 1, entries };
    }

    // v2
    const entries: Record<string, MCPOAuthStoredCredentials> = {};

    for (const credRaw of Object.values(entriesRaw)) {
      const creds = parseStoredCredentials(credRaw);
      if (!creds) {
        continue;
      }

      const serverUrlKey = creds.serverUrl;
      const existing = entries[serverUrlKey];

      if (!existing || creds.updatedAtMs > existing.updatedAtMs) {
        entries[serverUrlKey] = creds;
      }
    }

    return { version: 2, entries };
  } catch {
    return null;
  }
}

function migrateStoreV1ToV2(store: McpOauthStoreFileV1): McpOauthStoreFileV2 {
  const entries: Record<string, MCPOAuthStoredCredentials> = {};

  for (const byServer of Object.values(store.entries)) {
    for (const creds of Object.values(byServer)) {
      const serverUrlKey = normalizeServerUrlForComparison(creds.serverUrl);
      if (!serverUrlKey) {
        continue;
      }

      const existing = entries[serverUrlKey];
      if (!existing || creds.updatedAtMs > existing.updatedAtMs) {
        entries[serverUrlKey] = {
          ...creds,
          serverUrl: serverUrlKey,
        };
      }
    }
  }

  return { version: 2, entries };
}

export class McpOauthService {
  private readonly storeFilePath: string;
  private readonly storeLock = new MutexMap<string>();
  private store: McpOauthStoreFile | null = null;

  private readonly desktopFlows = new Map<string, DesktopFlow>();
  private readonly serverFlows = new Map<string, ServerFlow>();
  private readonly telemetryService?: TelemetryService;

  constructor(
    private readonly config: Config,
    private readonly mcpConfigService: MCPConfigService,
    private readonly windowService?: WindowService,
    telemetryService?: TelemetryService
  ) {
    this.telemetryService = telemetryService;
    this.storeFilePath = path.join(config.rootDir, STORE_FILE_NAME);
  }

  async dispose(): Promise<void> {
    // Best-effort: cancel all in-flight flows.
    const desktopFlowIds = [...this.desktopFlows.keys()];
    const serverFlowIds = [...this.serverFlows.keys()];

    await Promise.all([
      ...desktopFlowIds.map((id) => this.finishDesktopFlow(id, Err("App shutting down"))),
      ...serverFlowIds.map((id) => this.finishServerFlow(id, Err("App shutting down"))),
    ]);

    for (const flow of this.desktopFlows.values()) {
      clearTimeout(flow.timeout);
      if (flow.cleanupTimeout !== null) {
        clearTimeout(flow.cleanupTimeout);
      }
    }

    for (const flow of this.serverFlows.values()) {
      clearTimeout(flow.timeout);
      if (flow.cleanupTimeout !== null) {
        clearTimeout(flow.cleanupTimeout);
      }
    }

    this.desktopFlows.clear();
    this.serverFlows.clear();
  }

  async startDesktopFlowForApi(input: {
    projectPath?: string;
    serverName: string;
    pendingServer?: MCPOAuthPendingServerConfig;
  }): Promise<Result<{ flowId: string; authorizeUrl: string; redirectUri: string }, string>> {
    return this.startDesktopFlow({
      ...input,
      projectPath: input.projectPath ?? this.config.rootDir,
    });
  }

  async startServerFlowForApi(
    input: {
      projectPath?: string;
      serverName: string;
      pendingServer?: MCPOAuthPendingServerConfig;
    },
    headers?: IncomingHttpHeaders
  ): Promise<Result<{ flowId: string; authorizeUrl: string; redirectUri: string }, string>> {
    const projectPath = input.projectPath ?? this.config.rootDir;
    const origin = typeof headers?.origin === "string" ? headers.origin.trim() : "";
    if (origin) {
      try {
        const redirectUri = new URL("/auth/mcp-oauth/callback", origin).toString();
        return this.startServerFlow({ ...input, projectPath, redirectUri });
      } catch {
        // Fall back to Host header.
      }
    }

    const hostHeader = headers?.["x-forwarded-host"] ?? headers?.host;
    const host = typeof hostHeader === "string" ? hostHeader.split(",")[0]?.trim() : "";
    if (!host) {
      return Err("Missing Host header");
    }
    const protoHeader = headers?.["x-forwarded-proto"];
    const forwardedProto = typeof protoHeader === "string" ? protoHeader.split(",")[0]?.trim() : "";
    const proto = forwardedProto.length ? forwardedProto : "http";
    const redirectUri = `${proto}://${host}/auth/mcp-oauth/callback`;
    return this.startServerFlow({ ...input, projectPath, redirectUri });
  }

  async getProjectAuthStatus(input: {
    projectPath: string;
    serverName: string;
  }): Promise<MCPOAuthAuthStatus> {
    const servers = await this.mcpConfigService.listServers(
      input.projectPath,
      isProjectTrusted(this.config, input.projectPath)
    );
    const server = servers[input.serverName];
    if (!server || server.transport === "stdio") {
      return { isLoggedIn: false, hasRefreshToken: false };
    }
    return this.getAuthStatus({ serverUrl: server.url });
  }

  async logoutProjectServer(input: {
    projectPath: string;
    serverName: string;
  }): Promise<Result<void, string>> {
    const servers = await this.mcpConfigService.listServers(
      input.projectPath,
      isProjectTrusted(this.config, input.projectPath)
    );
    const server = servers[input.serverName];
    if (!server || server.transport === "stdio") {
      return Ok(undefined);
    }
    return this.logout({ serverUrl: server.url });
  }
  async getAuthStatus(input: { serverUrl: string }): Promise<MCPOAuthAuthStatus> {
    const normalizedServerUrl = normalizeServerUrlForComparison(input.serverUrl);
    if (!normalizedServerUrl) {
      return { isLoggedIn: false, hasRefreshToken: false };
    }

    const creds = await this.getValidStoredCredentials({ serverUrl: normalizedServerUrl });

    const tokens = creds?.tokens;
    return {
      serverUrl: normalizedServerUrl,
      isLoggedIn: Boolean(tokens),
      hasRefreshToken: Boolean(tokens?.refresh_token),
      scope: tokens?.scope,
      updatedAtMs: creds?.updatedAtMs,
    };
  }

  async logout(input: { serverUrl: string }): Promise<Result<void, string>> {
    const normalizedServerUrl = normalizeServerUrlForComparison(input.serverUrl);
    if (!normalizedServerUrl) {
      return Ok(undefined);
    }

    try {
      await this.storeLock.withLock(this.storeFilePath, async () => {
        const store = await this.ensureStoreLoadedLocked();
        if (!store.entries[normalizedServerUrl]) {
          return;
        }

        delete store.entries[normalizedServerUrl];
        await this.persistStoreLocked(store);
      });

      return Ok(undefined);
    } catch (error) {
      const message = getErrorMessage(error);
      return Err(message);
    }
  }

  /**
   * Returns a provider suitable for attaching to an MCP HTTP/SSE transport.
   *
   * Critical: This must never trigger user-interactive auth in the background.
   * Therefore we only return a provider when tokens exist and we ensure
   * redirectToAuthorization never opens a browser.
   */
  async getAuthProviderForServer(input: {
    serverUrl: string;
    serverName?: string;
  }): Promise<OAuthClientProvider | undefined> {
    const normalizedServerUrl = normalizeServerUrlForComparison(input.serverUrl);
    if (!normalizedServerUrl) {
      return undefined;
    }

    const creds = await this.getValidStoredCredentials({ serverUrl: normalizedServerUrl });

    if (!creds?.tokens || !creds.clientInformation) {
      return undefined;
    }

    return this.createBackgroundProvider({
      serverUrl: normalizedServerUrl,
      serverName: input.serverName,
    });
  }

  /**
   * Used by MCPServerManager caching to restart servers when auth state changes.
   */
  async hasAuthTokens(input: { serverUrl: string }): Promise<boolean> {
    const normalizedServerUrl = normalizeServerUrlForComparison(input.serverUrl);
    if (!normalizedServerUrl) {
      return false;
    }

    const creds = await this.getValidStoredCredentials({ serverUrl: normalizedServerUrl });
    return Boolean(creds?.tokens && creds.clientInformation);
  }

  private async resolveServerForOauthFlow(input: {
    projectPath: string;
    serverName: string;
    pendingServer?: MCPOAuthPendingServerConfig;
  }): Promise<
    Result<
      {
        serverUrlForDiscovery: string;
        serverUrlForStoreKey: string;
        transport: "http" | "sse" | "auto";
      },
      string
    >
  > {
    if (input.pendingServer) {
      // Defensive: pendingServer comes from user input (add-server form), so validate.
      const transport = input.pendingServer.transport;
      if (transport !== "http" && transport !== "sse" && transport !== "auto") {
        return Err("OAuth is only supported for remote (http/sse) MCP servers");
      }

      const serverUrlForDiscovery = sanitizeServerUrlForRequest(input.pendingServer.url);
      if (!serverUrlForDiscovery) {
        return Err("Invalid MCP server URL");
      }

      const serverUrlForStoreKey = normalizeServerUrlForComparison(serverUrlForDiscovery);
      if (!serverUrlForStoreKey) {
        return Err("Invalid MCP server URL");
      }

      return Ok({ serverUrlForDiscovery, serverUrlForStoreKey, transport });
    }

    const servers = await this.mcpConfigService.listServers(
      input.projectPath,
      isProjectTrusted(this.config, input.projectPath)
    );
    const server = servers[input.serverName];
    if (!server) {
      return Err("MCP server not found");
    }

    if (server.transport === "stdio") {
      return Err("OAuth is only supported for remote (http/sse) MCP servers");
    }

    const serverUrlForDiscovery = sanitizeServerUrlForRequest(server.url);
    if (!serverUrlForDiscovery) {
      return Err("Invalid MCP server URL");
    }

    const serverUrlForStoreKey = normalizeServerUrlForComparison(serverUrlForDiscovery);
    if (!serverUrlForStoreKey) {
      return Err("Invalid MCP server URL");
    }

    return Ok({ serverUrlForDiscovery, serverUrlForStoreKey, transport: server.transport });
  }

  async startDesktopFlow(input: {
    projectPath: string;
    serverName: string;
    pendingServer?: MCPOAuthPendingServerConfig;
  }): Promise<Result<{ flowId: string; authorizeUrl: string; redirectUri: string }, string>> {
    const serverConfig = await this.resolveServerForOauthFlow(input);
    if (!serverConfig.success) {
      return Err(serverConfig.error);
    }

    const serverUrlForDiscovery = serverConfig.data.serverUrlForDiscovery;
    const serverUrlForStoreKey = serverConfig.data.serverUrlForStoreKey;
    const transport = serverConfig.data.transport;

    const projectKey = normalizeProjectPathKey(input.projectPath);

    const flowId = crypto.randomUUID();
    const { promise: resultPromise, resolve: resolveResult } =
      createDeferred<Result<void, string>>();

    const serverListener = http.createServer((req, res) => {
      const reqUrl = req.url ?? "/";
      const url = new URL(reqUrl, "http://localhost");

      if (req.method !== "GET" || url.pathname !== "/callback") {
        res.statusCode = 404;
        res.end("Not found");
        return;
      }

      const state = url.searchParams.get("state");
      if (state !== flowId) {
        res.statusCode = 400;
        res.setHeader("Content-Type", "text/html");
        res.end("<h1>Invalid OAuth state</h1>");

        // Strict state validation: if we receive an OAuth callback that doesn't
        // match the active flow state, fail the flow rather than waiting for a timeout.
        //
        // Note: We only fail once the flow has an authorizeUrl to avoid cancelling
        // due to unrelated localhost probes against the ephemeral loopback port.
        const flow = this.desktopFlows.get(flowId);
        if (flow?.authorizeUrl && !flow?.settled) {
          void this.finishDesktopFlow(flowId, Err("Invalid OAuth state"));
        }
        return;
      }

      const code = url.searchParams.get("code");
      const error = url.searchParams.get("error");
      const errorDescription = url.searchParams.get("error_description") ?? undefined;

      void this.handleDesktopCallback({
        flowId,
        code,
        error,
        errorDescription,
        res,
      });
    });

    try {
      await new Promise<void>((resolve, reject) => {
        serverListener.once("error", reject);
        serverListener.listen(0, "127.0.0.1", () => resolve());
      });
    } catch (error) {
      const message = getErrorMessage(error);
      return Err(`Failed to start OAuth callback listener: ${message}`);
    }

    const address = serverListener.address();
    if (!address || typeof address === "string") {
      await closeServer(serverListener).catch(() => undefined);
      return Err("Failed to determine OAuth callback listener port");
    }

    const redirectUri = `http://127.0.0.1:${address.port}/callback`;

    // Best-effort probe for OAuth hints (scope/resource_metadata). If it fails,
    // the MCP SDK can still fall back to well-known discovery.
    const challenge = await probeServerForBearerChallenge({
      serverUrl: serverUrlForDiscovery,
      transport,
    });

    const flow: DesktopFlow = {
      flowId,
      projectPath: projectKey,
      serverName: input.serverName,
      serverUrlForDiscovery,
      serverUrlForStoreKey,
      transport,
      startedAtMs: Date.now(),
      clientInformation: null,
      authorizeUrl: "",
      redirectUri,
      scope: await resolveOAuthScope(challenge),
      resourceMetadataUrl: challenge?.resourceMetadataUrl,
      codeVerifier: null,
      discoveryState: undefined,
      server: serverListener,
      timeout: setTimeout(() => {
        void this.finishDesktopFlow(flowId, Err("Timed out waiting for OAuth callback"));
      }, DEFAULT_DESKTOP_TIMEOUT_MS),
      cleanupTimeout: null,
      resultPromise,
      resolveResult,
      settled: false,
    };

    this.desktopFlows.set(flowId, flow);

    this.captureTelemetry({
      event: "mcp_oauth_flow_started",
      properties: {
        transport: flow.transport,
        has_scope_hint: Boolean(flow.scope),
        has_resource_metadata_hint: Boolean(flow.resourceMetadataUrl),
      },
    });

    try {
      // Force a user-interactive flow by not exposing existing tokens.
      const provider = this.createFlowProvider(flow);

      const result = await auth(provider, {
        serverUrl: serverUrlForDiscovery,
        scope: flow.scope,
        resourceMetadataUrl: flow.resourceMetadataUrl,
      });

      if (result !== "REDIRECT" || !flow.authorizeUrl) {
        // If auth() completes without redirecting the user, treat it as a failure
        // and tear down the loopback listener.
        await this.finishDesktopFlow(flowId, Err("Failed to start OAuth authorization"));
        return Err("Failed to start OAuth authorization");
      }

      log.debug("[MCP OAuth] Desktop flow started", {
        flowId,
        projectPath: projectKey,
        serverName: input.serverName,
      });

      return Ok({ flowId, authorizeUrl: flow.authorizeUrl, redirectUri });
    } catch (error) {
      const message = getErrorMessage(error);
      await this.finishDesktopFlow(flowId, Err(message));
      return Err(message);
    }
  }

  async waitForDesktopFlow(
    flowId: string,
    opts?: { timeoutMs?: number }
  ): Promise<Result<void, string>> {
    const flow = this.desktopFlows.get(flowId);
    if (!flow) {
      return Err("OAuth flow not found");
    }

    const timeoutMs = opts?.timeoutMs ?? DEFAULT_DESKTOP_TIMEOUT_MS;

    let timeoutHandle: ReturnType<typeof setTimeout> | null = null;
    const timeoutPromise = new Promise<Result<void, string>>((resolve) => {
      timeoutHandle = setTimeout(() => {
        resolve(Err("Timed out waiting for OAuth callback"));
      }, timeoutMs);
    });

    const result = await Promise.race([flow.resultPromise, timeoutPromise]);

    if (timeoutHandle !== null) {
      clearTimeout(timeoutHandle);
    }

    if (!result.success) {
      void this.finishDesktopFlow(flowId, result);
    }

    return result;
  }

  async cancelDesktopFlow(flowId: string): Promise<void> {
    const flow = this.desktopFlows.get(flowId);
    if (!flow) return;

    log.debug("[MCP OAuth] Desktop flow cancelled", { flowId });
    await this.finishDesktopFlow(flowId, Err("OAuth flow cancelled"));
  }

  async startServerFlow(input: {
    projectPath: string;
    serverName: string;
    redirectUri: string;
    pendingServer?: MCPOAuthPendingServerConfig;
  }): Promise<Result<{ flowId: string; authorizeUrl: string; redirectUri: string }, string>> {
    const serverConfig = await this.resolveServerForOauthFlow(input);
    if (!serverConfig.success) {
      return Err(serverConfig.error);
    }

    const serverUrlForDiscovery = serverConfig.data.serverUrlForDiscovery;
    const serverUrlForStoreKey = serverConfig.data.serverUrlForStoreKey;
    const transport = serverConfig.data.transport;

    let redirectUri: URL;
    try {
      redirectUri = new URL(input.redirectUri);
    } catch {
      return Err("Invalid OAuth redirect URI");
    }

    if (redirectUri.protocol !== "http:" && redirectUri.protocol !== "https:") {
      return Err("OAuth redirect URI must be http(s)");
    }

    const projectKey = normalizeProjectPathKey(input.projectPath);

    const flowId = crypto.randomUUID();
    const { promise: resultPromise, resolve: resolveResult } =
      createDeferred<Result<void, string>>();

    // Best-effort probe for OAuth hints (scope/resource_metadata). If it fails,
    // the MCP SDK can still fall back to well-known discovery.
    const challenge = await probeServerForBearerChallenge({
      serverUrl: serverUrlForDiscovery,
      transport,
    });

    const flow: ServerFlow = {
      flowId,
      projectPath: projectKey,
      serverName: input.serverName,
      serverUrlForDiscovery,
      serverUrlForStoreKey,
      transport,
      startedAtMs: Date.now(),
      clientInformation: null,
      authorizeUrl: "",
      redirectUri: redirectUri.toString(),
      scope: await resolveOAuthScope(challenge),
      resourceMetadataUrl: challenge?.resourceMetadataUrl,
      codeVerifier: null,
      discoveryState: undefined,
      timeout: setTimeout(() => {
        void this.finishServerFlow(flowId, Err("Timed out waiting for OAuth callback"));
      }, DEFAULT_SERVER_TIMEOUT_MS),
      cleanupTimeout: null,
      resultPromise,
      resolveResult,
      settled: false,
    };

    this.serverFlows.set(flowId, flow);

    this.captureTelemetry({
      event: "mcp_oauth_flow_started",
      properties: {
        transport: flow.transport,
        has_scope_hint: Boolean(flow.scope),
        has_resource_metadata_hint: Boolean(flow.resourceMetadataUrl),
      },
    });

    try {
      // Force a user-interactive flow by not exposing existing tokens.
      const provider = this.createFlowProvider(flow);

      const result = await auth(provider, {
        serverUrl: serverUrlForDiscovery,
        scope: flow.scope,
        resourceMetadataUrl: flow.resourceMetadataUrl,
      });

      if (result !== "REDIRECT" || !flow.authorizeUrl) {
        await this.finishServerFlow(flowId, Err("Failed to start OAuth authorization"));
        return Err("Failed to start OAuth authorization");
      }

      log.debug("[MCP OAuth] Server flow started", {
        flowId,
        projectPath: projectKey,
        serverName: input.serverName,
      });

      return Ok({ flowId, authorizeUrl: flow.authorizeUrl, redirectUri: flow.redirectUri });
    } catch (error) {
      const message = getErrorMessage(error);
      await this.finishServerFlow(flowId, Err(message));
      return Err(message);
    }
  }

  async waitForServerFlow(
    flowId: string,
    opts?: { timeoutMs?: number }
  ): Promise<Result<void, string>> {
    const flow = this.serverFlows.get(flowId);
    if (!flow) {
      return Err("OAuth flow not found");
    }

    const timeoutMs = opts?.timeoutMs ?? DEFAULT_SERVER_TIMEOUT_MS;

    let timeoutHandle: ReturnType<typeof setTimeout> | null = null;
    const timeoutPromise = new Promise<Result<void, string>>((resolve) => {
      timeoutHandle = setTimeout(() => {
        resolve(Err("Timed out waiting for OAuth callback"));
      }, timeoutMs);
    });

    const result = await Promise.race([flow.resultPromise, timeoutPromise]);

    if (timeoutHandle !== null) {
      clearTimeout(timeoutHandle);
    }

    if (!result.success) {
      void this.finishServerFlow(flowId, result);
    }

    return result;
  }

  async cancelServerFlow(flowId: string): Promise<void> {
    const flow = this.serverFlows.get(flowId);
    if (!flow) return;

    log.debug("[MCP OAuth] Server flow cancelled", { flowId });
    await this.finishServerFlow(flowId, Err("OAuth flow cancelled"));
  }

  async handleServerCallbackAndExchange(input: {
    state: string | null;
    code: string | null;
    error: string | null;
    errorDescription?: string;
  }): Promise<Result<void, string>> {
    const state = input.state;
    if (!state) {
      return Err("Missing OAuth state");
    }

    const flow = this.serverFlows.get(state);
    if (!flow) {
      return Err("Unknown OAuth state");
    }

    if (flow.settled) {
      return Err("OAuth flow already completed");
    }

    log.debug("[MCP OAuth] Server callback received", { flowId: state });

    const result = await this.exchangeAuthorizationCode(flow, {
      code: input.code,
      error: input.error,
      errorDescription: input.errorDescription,
    });

    await this.finishServerFlow(state, result);

    return result;
  }

  private captureTelemetry(payload: Parameters<TelemetryService["capture"]>[0]): void {
    try {
      this.telemetryService?.capture(payload);
    } catch (error) {
      // Telemetry must never block or crash OAuth flows.
      log.debug("[MCP OAuth] Failed to capture telemetry", { error });
    }
  }

  private getOAuthFlowErrorCategory(
    error: string
  ): "timeout" | "cancelled" | "state_mismatch" | "provider_error" | "unknown" {
    const lower = error.toLowerCase();

    if (lower.includes("timed out")) {
      return "timeout";
    }

    if (lower.includes("cancelled")) {
      return "cancelled";
    }

    if (lower.includes("invalid oauth state")) {
      return "state_mismatch";
    }

    if (lower.includes("oauth")) {
      return "provider_error";
    }

    return "unknown";
  }

  private createFlowProvider(flow: OAuthFlowBase): OAuthClientProvider {
    return {
      tokens: () => Promise.resolve(undefined),
      saveTokens: async (tokens) => {
        await this.saveTokens({
          serverUrl: flow.serverUrlForStoreKey,
          // eslint-disable-next-line local/no-chained-type-assertions -- grandfathered when the rule was introduced; fix the underlying type instead of copying this pattern
          tokens: tokens as unknown as MCPOAuthTokens,
          legacyBinding: deriveAuthorizationServerBinding(flow.discoveryState),
        });
      },
      saveDiscoveryState: (state) => {
        flow.discoveryState = state;
      },
      // The SDK compares this redirect-leg issuer with callback discovery before
      // sending the authorization code and PKCE verifier to the token endpoint.
      discoveryState: () => Promise.resolve(flow.discoveryState),
      redirectToAuthorization: (authorizationUrl) => {
        flow.authorizeUrl = authorizationUrl.toString();
        return Promise.resolve();
      },
      saveCodeVerifier: (codeVerifier) => {
        flow.codeVerifier = codeVerifier;
        return Promise.resolve();
      },
      codeVerifier: () => {
        if (!flow.codeVerifier) {
          return Promise.reject(new Error("Missing PKCE code verifier"));
        }
        return Promise.resolve(flow.codeVerifier);
      },
      invalidateCredentials: async (scope) => {
        // "discovery" (SDK v2) refers to cached AS metadata, which Xum does
        // not persist; nothing to invalidate.
        if (scope === "discovery") {
          return;
        }
        await this.invalidateStoredCredentials({
          serverUrl: flow.serverUrlForStoreKey,
          scope,
        });
      },
      get redirectUrl() {
        return flow.redirectUri;
      },
      get clientMetadata() {
        return {
          redirect_uris: [flow.redirectUri],
          response_types: ["code"],
          grant_types: ["authorization_code", "refresh_token"],
          token_endpoint_auth_method: "none",
          client_name: "Xum",
          scope: flow.scope,
        };
      },
      clientInformation: () => {
        // We intentionally register an OAuth client per interactive flow because the
        // redirect URI may vary between environments (desktop loopback ports, proxied
        // server origins, etc.).
        return Promise.resolve(flow.clientInformation ?? undefined);
      },
      saveClientInformation: async (clientInformation) => {
        // eslint-disable-next-line local/no-chained-type-assertions -- grandfathered when the rule was introduced; fix the underlying type instead of copying this pattern
        const next = clientInformation as unknown as MCPOAuthClientInformation;
        flow.clientInformation = next;

        await this.saveClientInformation({
          serverUrl: flow.serverUrlForStoreKey,
          clientInformation: next,
          legacyBinding: deriveAuthorizationServerBinding(flow.discoveryState),
        });
      },
      state: () => Promise.resolve(flow.flowId),
    };
  }

  private createBackgroundProvider(input: {
    serverUrl: string;
    serverName?: string;
  }): OAuthClientProvider {
    let discoveryState: OAuthDiscoveryState | undefined;

    return {
      tokens: async () => {
        const creds = await this.getValidStoredCredentials({ serverUrl: input.serverUrl });
        // eslint-disable-next-line local/no-chained-type-assertions -- grandfathered when the rule was introduced; fix the underlying type instead of copying this pattern
        return creds?.tokens as unknown as MCPOAuthTokens | undefined;
      },
      saveTokens: async (tokens) => {
        await this.saveTokens({
          serverUrl: input.serverUrl,
          // eslint-disable-next-line local/no-chained-type-assertions -- grandfathered when the rule was introduced; fix the underlying type instead of copying this pattern
          tokens: tokens as unknown as MCPOAuthTokens,
          legacyBinding: deriveAuthorizationServerBinding(discoveryState),
        });
      },
      saveDiscoveryState: (state) => {
        // Cache only for downgrade-compatible writes; read-back would change SDK discovery behavior.
        discoveryState = state;
      },
      redirectToAuthorization: async () => {
        // Avoid any user-visible side effects during background tool calls.
        // If we end up here, the server requires interactive auth.
        await this.invalidateStoredCredentials({
          serverUrl: input.serverUrl,
          scope: "tokens",
        });
        throw new Error("MCP OAuth login required");
      },
      saveCodeVerifier: () => {
        // Background providers never start interactive flows.
        return Promise.resolve();
      },
      codeVerifier: () => Promise.reject(new Error("PKCE verifier is not available")),
      invalidateCredentials: async (scope) => {
        // "discovery" (SDK v2) refers to cached AS metadata, which Xum does
        // not persist; nothing to invalidate.
        if (scope === "discovery") {
          return;
        }
        await this.invalidateStoredCredentials({
          serverUrl: input.serverUrl,
          scope,
        });
      },
      get redirectUrl() {
        // Unused in background mode.
        return "http://127.0.0.1/";
      },
      get clientMetadata() {
        // Unused in background mode; must still be present for the interface.
        return {
          redirect_uris: ["http://127.0.0.1/"],
        };
      },
      clientInformation: async () => {
        const creds = await this.getValidStoredCredentials({ serverUrl: input.serverUrl });
        // eslint-disable-next-line local/no-chained-type-assertions -- grandfathered when the rule was introduced; fix the underlying type instead of copying this pattern
        return creds?.clientInformation as unknown as MCPOAuthClientInformation | undefined;
      },
      saveClientInformation: async (clientInformation) => {
        await this.saveClientInformation({
          serverUrl: input.serverUrl,
          // eslint-disable-next-line local/no-chained-type-assertions -- grandfathered when the rule was introduced; fix the underlying type instead of copying this pattern
          clientInformation: clientInformation as unknown as MCPOAuthClientInformation,
          legacyBinding: deriveAuthorizationServerBinding(discoveryState),
        });
      },
    };
  }

  private async handleDesktopCallback(input: {
    flowId: string;
    code: string | null;
    error: string | null;
    errorDescription?: string;
    res: http.ServerResponse;
  }): Promise<void> {
    const flow = this.desktopFlows.get(input.flowId);
    if (!flow || flow.settled) {
      input.res.statusCode = 409;
      input.res.setHeader("Content-Type", "text/html");
      input.res.end("<h1>OAuth flow already completed</h1>");
      return;
    }

    log.debug("[MCP OAuth] Callback received", { flowId: input.flowId });

    const result = await this.exchangeAuthorizationCode(flow, {
      code: input.code,
      error: input.error,
      errorDescription: input.errorDescription,
    });

    input.res.setHeader("Content-Type", "text/html");
    if (!result.success) {
      input.res.statusCode = 400;
    }

    input.res.end(
      renderOAuthCallbackHtml({
        title: result.success ? "Login complete" : "Login failed",
        message: result.success
          ? "You can return to Xum. You may now close this tab."
          : result.error,
        success: result.success,
      })
    );

    await this.finishDesktopFlow(input.flowId, result);
  }

  private async exchangeAuthorizationCode(
    flow: OAuthFlowBase,
    input: { code: string | null; error: string | null; errorDescription?: string }
  ): Promise<Result<void, string>> {
    if (input.error) {
      const message = input.errorDescription
        ? `${input.error}: ${input.errorDescription}`
        : input.error;
      return Err(`MCP OAuth error: ${message}`);
    }

    if (!input.code) {
      return Err("Missing OAuth code");
    }

    try {
      const provider = this.createFlowProvider(flow);

      const result = await auth(provider, {
        serverUrl: flow.serverUrlForDiscovery,
        authorizationCode: input.code,
        scope: flow.scope,
        resourceMetadataUrl: flow.resourceMetadataUrl,
      });

      if (result !== "AUTHORIZED") {
        return Err("OAuth exchange did not complete");
      }

      this.windowService?.focusMainWindow();

      return Ok(undefined);
    } catch (error) {
      const message = getErrorMessage(error);
      return Err(message);
    }
  }

  private async finishDesktopFlow(flowId: string, result: Result<void, string>): Promise<void> {
    const flow = this.desktopFlows.get(flowId);
    if (!flow || flow.settled) return;

    flow.settled = true;
    clearTimeout(flow.timeout);

    const durationMs = Math.max(0, Date.now() - flow.startedAtMs);
    const durationMsB2 = roundToBase2(durationMs);
    const hasScopeHint = Boolean(flow.scope);
    const hasResourceMetadataHint = Boolean(flow.resourceMetadataUrl);

    if (result.success) {
      this.captureTelemetry({
        event: "mcp_oauth_flow_completed",
        properties: {
          transport: flow.transport,
          duration_ms_b2: durationMsB2,
          has_scope_hint: hasScopeHint,
          has_resource_metadata_hint: hasResourceMetadataHint,
        },
      });
    } else {
      const errorCategory = this.getOAuthFlowErrorCategory(result.error);
      this.captureTelemetry({
        event: "mcp_oauth_flow_failed",
        properties: {
          transport: flow.transport,
          duration_ms_b2: durationMsB2,
          has_scope_hint: hasScopeHint,
          has_resource_metadata_hint: hasResourceMetadataHint,
          error_category: errorCategory,
        },
      });
    }

    try {
      flow.resolveResult(result);

      await closeServer(flow.server);
    } catch (error) {
      log.debug("[MCP OAuth] Failed to close OAuth callback listener", { error });
    } finally {
      if (flow.cleanupTimeout !== null) {
        clearTimeout(flow.cleanupTimeout);
      }
      flow.cleanupTimeout = setTimeout(() => {
        this.desktopFlows.delete(flowId);
      }, COMPLETED_FLOW_TTL_MS);
    }
  }

  private finishServerFlow(flowId: string, result: Result<void, string>): Promise<void> {
    const flow = this.serverFlows.get(flowId);
    if (!flow || flow.settled) {
      return Promise.resolve();
    }

    flow.settled = true;
    clearTimeout(flow.timeout);

    const durationMs = Math.max(0, Date.now() - flow.startedAtMs);
    const durationMsB2 = roundToBase2(durationMs);
    const hasScopeHint = Boolean(flow.scope);
    const hasResourceMetadataHint = Boolean(flow.resourceMetadataUrl);

    if (result.success) {
      this.captureTelemetry({
        event: "mcp_oauth_flow_completed",
        properties: {
          transport: flow.transport,
          duration_ms_b2: durationMsB2,
          has_scope_hint: hasScopeHint,
          has_resource_metadata_hint: hasResourceMetadataHint,
        },
      });
    } else {
      const errorCategory = this.getOAuthFlowErrorCategory(result.error);
      this.captureTelemetry({
        event: "mcp_oauth_flow_failed",
        properties: {
          transport: flow.transport,
          duration_ms_b2: durationMsB2,
          has_scope_hint: hasScopeHint,
          has_resource_metadata_hint: hasResourceMetadataHint,
          error_category: errorCategory,
        },
      });
    }

    try {
      flow.resolveResult(result);
    } finally {
      if (flow.cleanupTimeout !== null) {
        clearTimeout(flow.cleanupTimeout);
      }
      flow.cleanupTimeout = setTimeout(() => {
        this.serverFlows.delete(flowId);
      }, COMPLETED_FLOW_TTL_MS);
    }

    return Promise.resolve();
  }

  private async getValidStoredCredentials(input: {
    serverUrl: string;
  }): Promise<MCPOAuthStoredCredentials | null> {
    await this.ensureStoreLoaded();
    const store = this.store;
    if (!store) {
      return null;
    }

    const creds = store.entries[input.serverUrl];
    if (!creds) {
      return null;
    }

    // Defensive: Never use credentials bound to a different (normalized) URL.
    //
    // This shouldn't happen in a well-formed v2 store, but it can happen if the
    // store file is manually edited or corrupted.
    const storedUrlKey = normalizeServerUrlForComparison(creds.serverUrl);
    if (!storedUrlKey || storedUrlKey !== input.serverUrl) {
      await this.logout({ serverUrl: input.serverUrl });
      return null;
    }

    return creds;
  }

  private async invalidateStoredCredentials(input: {
    serverUrl: string;
    scope: "all" | "client" | "tokens" | "verifier";
  }): Promise<void> {
    await this.storeLock.withLock(this.storeFilePath, async () => {
      const store = await this.ensureStoreLoadedLocked();
      const creds = store.entries[input.serverUrl];
      if (!creds) {
        return;
      }

      if (input.scope === "tokens" || input.scope === "all") {
        creds.tokens = undefined;
      }

      if (input.scope === "client" || input.scope === "all") {
        creds.clientInformation = undefined;
      }

      // verifier is per-flow (in-memory) only.

      creds.updatedAtMs = Date.now();

      // If everything is gone, prune the entry.
      if (!creds.tokens && !creds.clientInformation) {
        delete store.entries[input.serverUrl];
      }

      await this.persistStoreLocked(store);
    });
  }

  private async saveTokens(input: {
    serverUrl: string;
    tokens: MCPOAuthTokens;
    legacyBinding?: AuthorizationServerBinding;
  }): Promise<void> {
    await this.storeLock.withLock(this.storeFilePath, async () => {
      const store = await this.ensureStoreLoadedLocked();
      const creds = (store.entries[input.serverUrl] ??= {
        serverUrl: input.serverUrl,
        updatedAtMs: Date.now(),
      });
      const serverMatches = normalizeServerUrlForComparison(creds.serverUrl) === input.serverUrl;
      // Do not carry a legacy binding across defensive server URL replacement.
      const legacyBinding =
        input.legacyBinding ??
        (serverMatches && creds.tokens ? parseAuthorizationServerBinding(creds.tokens) : undefined);

      // Defensive: Never keep tokens bound to a different URL.
      if (!serverMatches) {
        creds.clientInformation = undefined;
      }

      creds.serverUrl = input.serverUrl;
      creds.tokens = { ...input.tokens, ...legacyBinding };
      creds.updatedAtMs = Date.now();

      await this.persistStoreLocked(store);
    });
  }

  private async saveClientInformation(input: {
    serverUrl: string;
    clientInformation: MCPOAuthClientInformation;
    legacyBinding?: AuthorizationServerBinding;
  }): Promise<void> {
    await this.storeLock.withLock(this.storeFilePath, async () => {
      const store = await this.ensureStoreLoadedLocked();
      const creds = (store.entries[input.serverUrl] ??= {
        serverUrl: input.serverUrl,
        updatedAtMs: Date.now(),
      });
      const serverMatches = normalizeServerUrlForComparison(creds.serverUrl) === input.serverUrl;
      // Do not carry a legacy binding across defensive server URL replacement.
      const legacyBinding =
        input.legacyBinding ??
        (serverMatches && creds.clientInformation
          ? parseAuthorizationServerBinding(creds.clientInformation)
          : undefined);

      // Defensive: Never keep client info bound to a different URL.
      if (!serverMatches) {
        creds.tokens = undefined;
      }

      // Defensive: Refresh tokens are bound to a specific OAuth client_id.
      if (
        creds.clientInformation?.client_id &&
        creds.clientInformation.client_id !== input.clientInformation.client_id
      ) {
        creds.tokens = undefined;
      }

      creds.serverUrl = input.serverUrl;
      creds.clientInformation = { ...input.clientInformation, ...legacyBinding };
      creds.updatedAtMs = Date.now();

      await this.persistStoreLocked(store);
    });
  }

  private async ensureStoreLoaded(): Promise<void> {
    if (this.store) {
      return;
    }

    await this.storeLock.withLock(this.storeFilePath, async () => {
      await this.ensureStoreLoadedLocked();
    });
  }

  private async ensureStoreLoadedLocked(): Promise<McpOauthStoreFile> {
    if (this.store) {
      return this.store;
    }

    try {
      const raw = await fsPromises.readFile(this.storeFilePath, "utf-8");
      const parsed = parseStoreFile(raw);
      if (!parsed) {
        log.warn("[MCP OAuth] Invalid store file; resetting", { filePath: this.storeFilePath });
        this.store = createEmptyStore();
        await this.persistStoreBestEffortLocked(this.store);
        return this.store;
      }

      if (parsed.version === 1) {
        const migrated = migrateStoreV1ToV2(parsed);
        this.store = migrated;
        await this.persistStoreBestEffortLocked(migrated);
        return migrated;
      }

      this.store = parsed;
      return parsed;
    } catch (error) {
      if (error && typeof error === "object" && "code" in error && error.code === "ENOENT") {
        this.store = createEmptyStore();
        return this.store;
      }

      log.warn("[MCP OAuth] Failed to read store file; resetting", { error });
      this.store = createEmptyStore();
      await this.persistStoreBestEffortLocked(this.store);
      return this.store;
    }
  }

  private async persistStoreBestEffortLocked(store: McpOauthStoreFile): Promise<void> {
    try {
      await this.persistStoreLocked(store);
    } catch (error) {
      // Store read/repair must never crash the app at startup.
      log.warn("[MCP OAuth] Failed to persist store file; continuing with in-memory state", {
        error,
      });
    }
  }

  private async persistStoreLocked(store: McpOauthStoreFile): Promise<void> {
    // Ensure ~/.xum exists.
    await fsPromises.mkdir(this.config.rootDir, { recursive: true });

    await writeFileAtomic(this.storeFilePath, JSON.stringify(store, null, 2), {
      encoding: "utf-8",
      mode: 0o600,
    });
  }
}

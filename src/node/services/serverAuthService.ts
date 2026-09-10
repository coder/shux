import * as crypto from "crypto";
import * as fs from "fs/promises";
import * as path from "path";
import writeFileAtomic from "write-file-atomic";
import { Err, Ok, type Result } from "@/common/types/result";
import assert from "@/common/utils/assert";
import type { Config } from "@/node/config";
import { log } from "@/node/services/log";
import { AsyncMutex } from "@/node/utils/concurrency/asyncMutex";
import { getErrorMessage } from "@/common/utils/errors";

const GITHUB_DEVICE_CODE_URL = "https://github.com/login/device/code";
const GITHUB_ACCESS_TOKEN_URL = "https://github.com/login/oauth/access_token";
const GITHUB_USER_API_URL = "https://api.github.com/user";

// Xum-owned OAuth app client ID used for server-mode owner login.
const MUX_SERVER_GITHUB_CLIENT_ID = "Ov23liCVKFN3jOo9R7HS";
const GITHUB_DEVICE_FLOW_SCOPE = "read:user";

const DEFAULT_DEVICE_FLOW_TIMEOUT_MS = 5 * 60 * 1000;
const COMPLETED_FLOW_TTL_MS = 60 * 1000;
const DEVICE_FLOW_POLLING_SAFETY_MARGIN_MS = 3_000;

const SESSION_LAST_USED_PERSIST_INTERVAL_MS = 60 * 1000;

// Defensive cap: keep unauthenticated /auth/server-login/github/start traffic from
// allocating unbounded pending flows and outbound GitHub requests.
const MAX_CONCURRENT_GITHUB_DEVICE_FLOWS = 32;

export const SERVER_AUTH_SESSION_COOKIE_NAME = "mux_session";
export const SERVER_AUTH_SESSION_MAX_AGE_SECONDS = 30 * 24 * 60 * 60;
const SERVER_AUTH_SESSION_MAX_AGE_MS = SERVER_AUTH_SESSION_MAX_AGE_SECONDS * 1000;

interface PersistedServerAuthSession {
  id: string;
  tokenHash: string;
  createdAtMs: number;
  lastUsedAtMs: number;
  userAgent?: string;
  ipAddress?: string;
  label?: string;
}

interface PersistedServerAuthData {
  sessions: PersistedServerAuthSession[];
}

interface Deferred<T> {
  promise: Promise<T>;
  resolve: (value: T) => void;
}

interface GithubDeviceFlow {
  flowId: string;
  deviceCode: string;
  intervalSeconds: number;
  cancelled: boolean;
  pollingStarted: boolean;
  timeout: ReturnType<typeof setTimeout>;
  cleanupTimeout: ReturnType<typeof setTimeout> | null;
  resultPromise: Promise<Result<{ sessionId: string; sessionToken: string }, string>>;
  resolveResult: (result: Result<{ sessionId: string; sessionToken: string }, string>) => void;
  userAgent?: string;
  ipAddress?: string;
}

interface GithubDeviceCodeResponse {
  verification_uri: string;
  user_code: string;
  device_code: string;
  interval?: number;
}

interface GithubAccessTokenResponse {
  access_token?: string;
  error?: string;
  error_description?: string;
  interval?: number;
}

interface GithubUserResponse {
  login?: string;
}

export interface ServerAuthSessionView {
  id: string;
  label: string;
  createdAtMs: number;
  lastUsedAtMs: number;
  isCurrent: boolean;
}

export interface ValidateSessionTokenOptions {
  userAgent?: string;
  ipAddress?: string;
}

function createDeferred<T>(): Deferred<T> {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((res) => {
    resolve = res;
  });

  return { promise, resolve };
}

function normalizeOptionalString(value: unknown): string | undefined {
  if (typeof value !== "string") {
    return undefined;
  }

  const trimmed = value.trim();
  return trimmed.length > 0 ? trimmed : undefined;
}

function hashSessionToken(sessionToken: string): string {
  return crypto.createHash("sha256").update(sessionToken).digest("hex");
}

function normalizeIpAddress(ipAddress: string | undefined): string | undefined {
  const normalized = normalizeOptionalString(ipAddress);
  if (!normalized) {
    return undefined;
  }

  // Node may normalize IPv4 loopback as IPv6-mapped form.
  if (normalized === "::ffff:127.0.0.1") {
    return "127.0.0.1";
  }

  return normalized;
}

function detectBrowserFromUserAgent(userAgent: string): string | undefined {
  const lowerUserAgent = userAgent.toLowerCase();

  if (lowerUserAgent.includes("edg/")) return "Edge";
  if (lowerUserAgent.includes("opr/") || lowerUserAgent.includes("opera/")) return "Opera";
  if (lowerUserAgent.includes("firefox/")) return "Firefox";
  if (lowerUserAgent.includes("chrome/") && !lowerUserAgent.includes("chromium")) return "Chrome";
  if (lowerUserAgent.includes("safari/") && !lowerUserAgent.includes("chrome/")) return "Safari";

  return undefined;
}

function detectDeviceFromUserAgent(userAgent: string): string | undefined {
  const lowerUserAgent = userAgent.toLowerCase();

  if (lowerUserAgent.includes("iphone")) return "iPhone";
  if (lowerUserAgent.includes("ipad")) return "iPad";
  if (lowerUserAgent.includes("android")) return "Android";
  if (lowerUserAgent.includes("mac os x") || lowerUserAgent.includes("macintosh")) return "Mac";
  if (lowerUserAgent.includes("windows")) return "Windows";
  if (lowerUserAgent.includes("linux")) return "Linux";

  return undefined;
}

function buildSessionLabel(userAgent: string | undefined): string {
  const normalizedUserAgent = normalizeOptionalString(userAgent);
  if (!normalizedUserAgent) {
    return "Unknown device";
  }

  const browser = detectBrowserFromUserAgent(normalizedUserAgent);
  const device = detectDeviceFromUserAgent(normalizedUserAgent);

  if (browser && device) {
    return `${browser} on ${device}`;
  }

  if (browser) {
    return browser;
  }

  if (device) {
    return device;
  }

  return "Unknown device";
}

function parseGithubDeviceCodeResponse(data: unknown): GithubDeviceCodeResponse | null {
  if (!data || typeof data !== "object") {
    return null;
  }

  const record = data as Record<string, unknown>;
  const verificationUri = normalizeOptionalString(record.verification_uri);
  const userCode = normalizeOptionalString(record.user_code);
  const deviceCode = normalizeOptionalString(record.device_code);

  if (!verificationUri || !userCode || !deviceCode) {
    return null;
  }

  const intervalValue = record.interval;
  const interval =
    typeof intervalValue === "number" && Number.isFinite(intervalValue) && intervalValue > 0
      ? intervalValue
      : undefined;

  return {
    verification_uri: verificationUri,
    user_code: userCode,
    device_code: deviceCode,
    interval,
  };
}

function parseGithubAccessTokenResponse(data: unknown): GithubAccessTokenResponse {
  if (!data || typeof data !== "object") {
    return {};
  }

  const record = data as Record<string, unknown>;

  const intervalValue = record.interval;
  const interval =
    typeof intervalValue === "number" && Number.isFinite(intervalValue) && intervalValue > 0
      ? intervalValue
      : undefined;

  return {
    access_token: normalizeOptionalString(record.access_token),
    error: normalizeOptionalString(record.error),
    error_description: normalizeOptionalString(record.error_description),
    interval,
  };
}

function parseGithubUserResponse(data: unknown): GithubUserResponse {
  if (!data || typeof data !== "object") {
    return {};
  }

  const record = data as Record<string, unknown>;
  return {
    login: normalizeOptionalString(record.login),
  };
}

function sanitizeSession(value: unknown): PersistedServerAuthSession | null {
  if (!value || typeof value !== "object") {
    return null;
  }

  const record = value as Record<string, unknown>;

  const id = normalizeOptionalString(record.id);
  const tokenHash = normalizeOptionalString(record.tokenHash);

  const createdAtMs =
    typeof record.createdAtMs === "number" && Number.isFinite(record.createdAtMs)
      ? record.createdAtMs
      : null;
  const lastUsedAtMs =
    typeof record.lastUsedAtMs === "number" && Number.isFinite(record.lastUsedAtMs)
      ? record.lastUsedAtMs
      : null;

  if (!id || !tokenHash || createdAtMs == null || lastUsedAtMs == null) {
    return null;
  }

  return {
    id,
    tokenHash,
    createdAtMs,
    lastUsedAtMs,
    userAgent: normalizeOptionalString(record.userAgent),
    ipAddress: normalizeOptionalString(record.ipAddress),
    label: normalizeOptionalString(record.label),
  };
}

export class ServerAuthService {
  private readonly sessionsFilePath: string;
  private readonly sessionsMutex = new AsyncMutex();
  private readonly githubDeviceFlows = new Map<string, GithubDeviceFlow>();
  private githubDeviceFlowStartsInFlight = 0;

  constructor(private readonly config: Config) {
    this.sessionsFilePath = path.join(this.config.rootDir, "serverAuthSessions.json");
  }

  getAllowedGithubOwner(): string | undefined {
    return this.config.getServerAuthGithubOwner();
  }

  isGithubDeviceFlowEnabled(): boolean {
    return this.getAllowedGithubOwner() != null;
  }

  private getTrackedGithubDeviceFlowCount(): number {
    // Count all tracked flows (including canceled/completed ones waiting for cleanup)
    // so disconnect/cancel loops cannot bypass unauthenticated start throttling.
    return this.githubDeviceFlows.size;
  }

  async startGithubDeviceFlow(): Promise<
    Result<{ flowId: string; verificationUri: string; userCode: string }, string>
  > {
    const owner = this.getAllowedGithubOwner();
    if (!owner) {
      return Err("GitHub owner login is not configured");
    }

    const trackedFlows = this.getTrackedGithubDeviceFlowCount();
    if (trackedFlows + this.githubDeviceFlowStartsInFlight >= MAX_CONCURRENT_GITHUB_DEVICE_FLOWS) {
      return Err("Too many concurrent GitHub login attempts. Please wait and try again.");
    }

    this.githubDeviceFlowStartsInFlight += 1;

    const flowId = crypto.randomUUID();

    try {
      const response = await fetch(GITHUB_DEVICE_CODE_URL, {
        method: "POST",
        headers: {
          Accept: "application/json",
          "Content-Type": "application/x-www-form-urlencoded",
        },
        body: new URLSearchParams({
          client_id: MUX_SERVER_GITHUB_CLIENT_ID,
          scope: GITHUB_DEVICE_FLOW_SCOPE,
        }),
      });

      if (!response.ok) {
        const errorBody = await response.text().catch(() => "");
        return Err(
          `GitHub device-code request failed (${response.status})${errorBody ? `: ${errorBody}` : ""}`
        );
      }

      const json = (await response.json()) as unknown;
      const payload = parseGithubDeviceCodeResponse(json);
      if (!payload) {
        return Err("GitHub device-code endpoint returned an invalid response");
      }

      const deferred =
        createDeferred<Result<{ sessionId: string; sessionToken: string }, string>>();
      const timeout = setTimeout(() => {
        this.finishGithubDeviceFlow(flowId, Err("Timed out waiting for GitHub authorization"));
      }, DEFAULT_DEVICE_FLOW_TIMEOUT_MS);

      this.githubDeviceFlows.set(flowId, {
        flowId,
        deviceCode: payload.device_code,
        intervalSeconds: payload.interval ?? 5,
        cancelled: false,
        pollingStarted: false,
        timeout,
        cleanupTimeout: null,
        resultPromise: deferred.promise,
        resolveResult: deferred.resolve,
      });

      return Ok({
        flowId,
        verificationUri: payload.verification_uri,
        userCode: payload.user_code,
      });
    } catch (error) {
      const message = getErrorMessage(error);
      return Err(`Failed to start GitHub device flow: ${message}`);
    } finally {
      assert(
        this.githubDeviceFlowStartsInFlight > 0,
        "githubDeviceFlowStartsInFlight should be positive while startGithubDeviceFlow is running"
      );
      this.githubDeviceFlowStartsInFlight -= 1;
    }
  }

  async waitForGithubDeviceFlow(
    flowId: string,
    opts?: { timeoutMs?: number; userAgent?: string; ipAddress?: string }
  ): Promise<Result<{ sessionId: string; sessionToken: string }, string>> {
    const flow = this.githubDeviceFlows.get(flowId);
    if (!flow) {
      return Err("Device flow not found");
    }

    // Keep the first non-empty metadata from callers so the created session can be labeled.
    flow.userAgent ??= normalizeOptionalString(opts?.userAgent);
    flow.ipAddress ??= normalizeIpAddress(opts?.ipAddress);

    if (!flow.pollingStarted) {
      flow.pollingStarted = true;
      void this.pollGithubDeviceFlow(flow);
    }

    const timeoutMs = opts?.timeoutMs ?? DEFAULT_DEVICE_FLOW_TIMEOUT_MS;

    let timeoutHandle: ReturnType<typeof setTimeout> | null = null;
    const timeoutPromise = new Promise<Result<{ sessionId: string; sessionToken: string }, string>>(
      (resolve) => {
        timeoutHandle = setTimeout(() => {
          resolve(Err("Timed out waiting for GitHub authorization"));
        }, timeoutMs);
      }
    );

    const result = await Promise.race([flow.resultPromise, timeoutPromise]);

    if (timeoutHandle !== null) {
      clearTimeout(timeoutHandle);
    }

    if (!result.success) {
      this.finishGithubDeviceFlow(flowId, result);
    }

    return result;
  }

  cancelGithubDeviceFlow(flowId: string): void {
    void this.finishGithubDeviceFlow(flowId, Err("Device flow cancelled"));
  }

  async validateSessionToken(
    sessionToken: string,
    opts?: ValidateSessionTokenOptions
  ): Promise<{ sessionId: string } | null> {
    const normalizedToken = normalizeOptionalString(sessionToken);
    if (!normalizedToken) {
      return null;
    }

    const tokenHash = hashSessionToken(normalizedToken);
    const now = Date.now();
    const normalizedUserAgent = normalizeOptionalString(opts?.userAgent);
    const normalizedIpAddress = normalizeIpAddress(opts?.ipAddress);

    await using _lock = await this.sessionsMutex.acquire();

    const data = await this.loadPersistedSessionsLocked();
    const session = data.sessions.find((candidate) => candidate.tokenHash === tokenHash);
    if (!session) {
      return null;
    }

    const sessionAgeMs = now - session.createdAtMs;
    const sessionExpired =
      !Number.isFinite(session.createdAtMs) ||
      !Number.isFinite(sessionAgeMs) ||
      sessionAgeMs >= SERVER_AUTH_SESSION_MAX_AGE_MS;
    if (sessionExpired) {
      data.sessions = data.sessions.filter((candidate) => candidate.id !== session.id);

      try {
        await this.savePersistedSessionsLocked(data);
      } catch (error) {
        // Validation should still fail closed for expired sessions even if pruning
        // persistence fails.
        log.warn("Failed to prune expired server auth session", {
          sessionId: session.id,
          error: getErrorMessage(error),
        });
      }

      return null;
    }

    const shouldPersistLastUsed =
      !Number.isFinite(session.lastUsedAtMs) ||
      now - session.lastUsedAtMs >= SESSION_LAST_USED_PERSIST_INTERVAL_MS;

    const shouldPersistUserAgent = normalizedUserAgent && session.userAgent !== normalizedUserAgent;
    const shouldPersistIpAddress = normalizedIpAddress && session.ipAddress !== normalizedIpAddress;

    if (shouldPersistLastUsed || shouldPersistUserAgent || shouldPersistIpAddress) {
      session.lastUsedAtMs = now;
      if (normalizedUserAgent) {
        session.userAgent = normalizedUserAgent;
        session.label = buildSessionLabel(normalizedUserAgent);
      }
      if (normalizedIpAddress) {
        session.ipAddress = normalizedIpAddress;
      }

      try {
        await this.savePersistedSessionsLocked(data);
      } catch (error) {
        // Best-effort metadata update: auth should succeed as long as token validation passes.
        log.warn("Failed to persist server auth session metadata", {
          sessionId: session.id,
          error: getErrorMessage(error),
        });
      }
    }

    return { sessionId: session.id };
  }

  async listSessions(currentSessionId: string | null): Promise<ServerAuthSessionView[]> {
    await using _lock = await this.sessionsMutex.acquire();
    const data = await this.loadPersistedSessionsLocked();

    const now = Date.now();
    const unexpiredSessions = data.sessions.filter((session) => {
      const ageMs = now - session.createdAtMs;
      return (
        Number.isFinite(session.createdAtMs) &&
        Number.isFinite(ageMs) &&
        ageMs < SERVER_AUTH_SESSION_MAX_AGE_MS
      );
    });

    if (unexpiredSessions.length !== data.sessions.length) {
      const removedCount = data.sessions.length - unexpiredSessions.length;
      data.sessions = unexpiredSessions;

      try {
        await this.savePersistedSessionsLocked(data);
      } catch (error) {
        // Listing sessions should remain available even if cleanup persistence fails.
        log.warn("Failed to persist expired server auth session cleanup", {
          removedCount,
          error: getErrorMessage(error),
        });
      }
    }

    return unexpiredSessions
      .map((session) => ({
        id: session.id,
        label: session.label ?? buildSessionLabel(session.userAgent),
        createdAtMs: session.createdAtMs,
        lastUsedAtMs: session.lastUsedAtMs,
        isCurrent: currentSessionId != null && currentSessionId === session.id,
      }))
      .sort((a, b) => b.lastUsedAtMs - a.lastUsedAtMs);
  }

  async revokeSession(sessionId: string): Promise<boolean> {
    const normalizedSessionId = normalizeOptionalString(sessionId);
    if (!normalizedSessionId) {
      return false;
    }

    await using _lock = await this.sessionsMutex.acquire();
    const data = await this.loadPersistedSessionsLocked();

    const previousLength = data.sessions.length;
    data.sessions = data.sessions.filter((session) => session.id !== normalizedSessionId);

    if (data.sessions.length === previousLength) {
      return false;
    }

    await this.savePersistedSessionsLocked(data);
    return true;
  }

  async revokeOtherSessions(currentSessionId: string | null): Promise<number> {
    if (!currentSessionId) {
      return 0;
    }

    await using _lock = await this.sessionsMutex.acquire();
    const data = await this.loadPersistedSessionsLocked();

    const currentSessionExists = data.sessions.some((session) => session.id === currentSessionId);
    if (!currentSessionExists) {
      return 0;
    }

    const previousLength = data.sessions.length;
    data.sessions = data.sessions.filter((session) => session.id === currentSessionId);
    const removedCount = previousLength - data.sessions.length;

    if (removedCount > 0) {
      await this.savePersistedSessionsLocked(data);
    }

    return removedCount;
  }

  dispose(): void {
    for (const flow of this.githubDeviceFlows.values()) {
      flow.cancelled = true;
      clearTimeout(flow.timeout);
      if (flow.cleanupTimeout !== null) {
        clearTimeout(flow.cleanupTimeout);
      }

      try {
        flow.resolveResult(Err("Server auth service is shutting down"));
      } catch {
        // Result already resolved.
      }
    }

    this.githubDeviceFlows.clear();
  }

  private async pollGithubDeviceFlow(flow: GithubDeviceFlow): Promise<void> {
    while (!flow.cancelled) {
      try {
        const tokenResult = await this.pollGithubAccessToken(flow);
        if (flow.cancelled) {
          return;
        }

        if (!tokenResult.success) {
          this.finishGithubDeviceFlow(flow.flowId, Err(tokenResult.error));
          return;
        }

        if (tokenResult.data.type === "pending") {
          // Continue polling.
        } else if (tokenResult.data.type === "slow_down") {
          flow.intervalSeconds = tokenResult.data.intervalSeconds;
        } else if (tokenResult.data.type === "authorized") {
          const loginResult = await this.fetchGithubLogin(tokenResult.data.accessToken);
          if (flow.cancelled) {
            return;
          }

          if (!loginResult.success) {
            this.finishGithubDeviceFlow(flow.flowId, Err(loginResult.error));
            return;
          }

          const allowedOwner = this.getAllowedGithubOwner();
          if (!allowedOwner) {
            this.finishGithubDeviceFlow(
              flow.flowId,
              Err("GitHub owner login is no longer configured")
            );
            return;
          }

          if (loginResult.data.toLowerCase() !== allowedOwner.toLowerCase()) {
            this.finishGithubDeviceFlow(
              flow.flowId,
              Err(`GitHub user '${loginResult.data}' is not authorized for this server`)
            );
            return;
          }

          if (flow.cancelled) {
            return;
          }

          const sessionResult = await this.createSessionLocked({
            userAgent: flow.userAgent,
            ipAddress: flow.ipAddress,
          });

          if (flow.cancelled) {
            // The flow may be canceled while a session write is in progress.
            // Defensive cleanup avoids orphan sessions that have no delivered token.
            if (sessionResult.success) {
              const removed = await this.revokeSession(sessionResult.data.sessionId);
              if (!removed) {
                log.warn(
                  "Canceled GitHub device flow created a session that could not be revoked",
                  {
                    flowId: flow.flowId,
                    sessionId: sessionResult.data.sessionId,
                  }
                );
              }
            }
            return;
          }

          if (!sessionResult.success) {
            this.finishGithubDeviceFlow(flow.flowId, Err(sessionResult.error));
            return;
          }

          this.finishGithubDeviceFlow(flow.flowId, Ok(sessionResult.data));
          return;
        }
      } catch (error) {
        if (flow.cancelled) {
          return;
        }

        const message = getErrorMessage(error);
        log.warn("GitHub device-flow polling request failed; retrying", {
          flowId: flow.flowId,
          error: message,
        });
      }

      await new Promise((resolve) =>
        setTimeout(resolve, flow.intervalSeconds * 1000 + DEVICE_FLOW_POLLING_SAFETY_MARGIN_MS)
      );
    }
  }

  private async pollGithubAccessToken(
    flow: GithubDeviceFlow
  ): Promise<
    Result<
      | { type: "pending" }
      | { type: "slow_down"; intervalSeconds: number }
      | { type: "authorized"; accessToken: string },
      string
    >
  > {
    const response = await fetch(GITHUB_ACCESS_TOKEN_URL, {
      method: "POST",
      headers: {
        Accept: "application/json",
        "Content-Type": "application/x-www-form-urlencoded",
      },
      body: new URLSearchParams({
        client_id: MUX_SERVER_GITHUB_CLIENT_ID,
        device_code: flow.deviceCode,
        grant_type: "urn:ietf:params:oauth:grant-type:device_code",
      }),
    });

    if (!response.ok) {
      const body = await response.text().catch(() => "");
      return Err(`GitHub token polling failed (${response.status})${body ? `: ${body}` : ""}`);
    }

    const json = (await response.json()) as unknown;
    const payload = parseGithubAccessTokenResponse(json);

    if (payload.access_token) {
      return Ok({ type: "authorized", accessToken: payload.access_token });
    }

    if (payload.error === "authorization_pending") {
      return Ok({ type: "pending" });
    }

    if (payload.error === "slow_down") {
      const nextInterval = payload.interval ?? flow.intervalSeconds + 5;
      return Ok({ type: "slow_down", intervalSeconds: Math.max(1, nextInterval) });
    }

    if (payload.error === "expired_token") {
      return Err("GitHub device code expired. Start login again.");
    }

    if (payload.error === "access_denied") {
      return Err("GitHub authorization was denied.");
    }

    if (payload.error) {
      const descriptionSuffix = payload.error_description ? `: ${payload.error_description}` : "";
      return Err(`GitHub OAuth error: ${payload.error}${descriptionSuffix}`);
    }

    return Err("GitHub token polling returned an unexpected response");
  }

  private async fetchGithubLogin(accessToken: string): Promise<Result<string, string>> {
    const response = await fetch(GITHUB_USER_API_URL, {
      method: "GET",
      headers: {
        Accept: "application/vnd.github+json",
        Authorization: `Bearer ${accessToken}`,
        // Display/product attribution only; GitHub requires a UA but does not
        // parse this string as a mux wire contract.
        "User-Agent": "xum-server-auth",
      },
    });

    if (!response.ok) {
      const errorBody = await response.text().catch(() => "");
      return Err(
        `Failed to fetch GitHub user profile (${response.status})${
          errorBody ? `: ${errorBody}` : ""
        }`
      );
    }

    const json = (await response.json()) as unknown;
    const payload = parseGithubUserResponse(json);
    if (!payload.login) {
      return Err("GitHub user profile did not include a login name");
    }

    return Ok(payload.login);
  }

  private async createSessionLocked(opts?: {
    userAgent?: string;
    ipAddress?: string;
  }): Promise<Result<{ sessionId: string; sessionToken: string }, string>> {
    const sessionToken = crypto.randomBytes(32).toString("hex");
    const tokenHash = hashSessionToken(sessionToken);
    const now = Date.now();

    const userAgent = normalizeOptionalString(opts?.userAgent);
    const ipAddress = normalizeIpAddress(opts?.ipAddress);

    const session: PersistedServerAuthSession = {
      id: crypto.randomUUID(),
      tokenHash,
      createdAtMs: now,
      lastUsedAtMs: now,
      userAgent,
      ipAddress,
      label: buildSessionLabel(userAgent),
    };

    await using _lock = await this.sessionsMutex.acquire();
    const data = await this.loadPersistedSessionsLocked();
    data.sessions.push(session);
    await this.savePersistedSessionsLocked(data);

    return Ok({ sessionId: session.id, sessionToken });
  }

  private finishGithubDeviceFlow(
    flowId: string,
    result: Result<{ sessionId: string; sessionToken: string }, string>
  ): void {
    const flow = this.githubDeviceFlows.get(flowId);
    if (!flow || flow.cancelled) {
      return;
    }

    flow.cancelled = true;
    clearTimeout(flow.timeout);

    try {
      flow.resolveResult(result);
    } catch {
      // Result already resolved.
    }

    if (flow.cleanupTimeout !== null) {
      clearTimeout(flow.cleanupTimeout);
    }

    flow.cleanupTimeout = setTimeout(() => {
      this.githubDeviceFlows.delete(flowId);
    }, COMPLETED_FLOW_TTL_MS);
  }

  private async loadPersistedSessionsLocked(): Promise<PersistedServerAuthData> {
    try {
      const raw = await fs.readFile(this.sessionsFilePath, "utf-8");
      const parsed = JSON.parse(raw) as unknown;

      if (!parsed || typeof parsed !== "object") {
        return { sessions: [] };
      }

      const record = parsed as { sessions?: unknown };
      const rawSessions = Array.isArray(record.sessions) ? record.sessions : [];

      const sessions: PersistedServerAuthSession[] = [];
      for (const rawSession of rawSessions) {
        const session = sanitizeSession(rawSession);
        if (!session) {
          continue;
        }

        sessions.push(session);
      }

      return { sessions };
    } catch (error) {
      const err = error as NodeJS.ErrnoException;
      if (err?.code === "ENOENT") {
        return { sessions: [] };
      }

      log.warn("Failed to load server auth sessions. Using an empty session list.", { error });
      return { sessions: [] };
    }
  }

  private async savePersistedSessionsLocked(data: PersistedServerAuthData): Promise<void> {
    assert(Array.isArray(data.sessions), "server auth sessions must be an array");

    await fs.mkdir(this.config.rootDir, { recursive: true });
    await writeFileAtomic(this.sessionsFilePath, JSON.stringify(data, null, 2), {
      encoding: "utf-8",
      mode: 0o600,
    });
  }
}

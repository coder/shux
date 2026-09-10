import { describe, it, expect, beforeEach, afterEach } from "bun:test";
import * as crypto from "crypto";

import type { Result } from "@/common/types/result";
import { Err, Ok } from "@/common/types/result";
import type { FileLeaseManager, ProvidersConfig, ProvidersConfigStore } from "@/node/config";
import type { ProviderService } from "@/node/services/providerService";
import type { WindowService } from "@/node/services/windowService";
import type { ProviderModelEntry } from "@/common/config/schemas/providerModelEntry";
import type { CoderOauthAuth } from "@/node/utils/coderOauthAuth";
import type { PolicyService } from "@/node/services/policyService";
import { CODER_GATEWAY_DEFAULT_PROVIDER_NAMES } from "@/common/constants/coderOAuth";
import { CoderOauthService } from "./coderOauthService";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

const DEPLOYMENT_URL = "http://coder.test";

/** Build a valid CoderOauthAuth that expires far in the future. */
function validAuth(overrides?: Partial<CoderOauthAuth>): CoderOauthAuth {
  return {
    type: "oauth",
    sessionId: "session_test",
    deploymentUrl: DEPLOYMENT_URL,
    access: "at_test",
    refresh: "rt_test",
    expires: Date.now() + 3_600_000, // 1h from now
    clientId: "client_test",
    clientSecret: "secret_test",
    registrationAccessToken: "reg_token_test",
    registrationClientUri: `${DEPLOYMENT_URL}/oauth2/clients/client_test`,
    ...overrides,
  };
}

/** Build a CoderOauthAuth that is already expired. */
function expiredAuth(overrides?: Partial<CoderOauthAuth>): CoderOauthAuth {
  return validAuth({ expires: Date.now() - 60_000, ...overrides });
}

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "Content-Type": "application/json" },
  });
}

function discoveryResponse(): Response {
  return jsonResponse({
    issuer: DEPLOYMENT_URL,
    authorization_endpoint: `${DEPLOYMENT_URL}/oauth2/authorize`,
    token_endpoint: `${DEPLOYMENT_URL}/oauth2/tokens`,
    registration_endpoint: `${DEPLOYMENT_URL}/oauth2/register`,
    revocation_endpoint: `${DEPLOYMENT_URL}/oauth2/revoke`,
    code_challenge_methods_supported: ["S256"],
  });
}

/**
 * Authoritative AI Gateway provider listing with the classic two default
 * instances; keeps model discovery scoped to the anthropic/openai catalog
 * mocks the individual tests define.
 */
function aiProvidersResponse(): Response {
  return jsonResponse([
    { name: "anthropic", type: "anthropic", enabled: true },
    { name: "openai", type: "openai", enabled: true },
  ]);
}

function sha256Base64Url(value: string): string {
  return crypto.createHash("sha256").update(value).digest().toString("base64url");
}

/** Stringify a fetch input without tripping no-base-to-string on Request objects. */
function fetchUrl(input: RequestInfo | URL): string {
  if (typeof input === "string") return input;
  if (input instanceof URL) return input.toString();
  return input.url;
}

/** Extract a string/URLSearchParams request body for assertions. */
function fetchBodyText(init?: RequestInit): string {
  const body = init?.body;
  if (typeof body === "string") return body;
  if (body instanceof URLSearchParams) return body.toString();
  throw new Error(`Unexpected request body type: ${typeof body}`);
}

/** Poll until `predicate` holds; model discovery runs after the flow resolves. */
async function waitUntil(predicate: () => boolean, timeoutMs = 2000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (!predicate()) {
    if (Date.now() > deadline) {
      throw new Error("waitUntil: condition not met within timeout");
    }
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
}

// ---------------------------------------------------------------------------
// Mock dependencies
// ---------------------------------------------------------------------------

interface MockDeps {
  providersConfig: ProvidersConfig;
  setConfigValueCalls: Array<{ provider: string; keyPath: string[]; value: unknown }>;
  setModelsCalls: Array<{ provider: string; models: ProviderModelEntry[] }>;
  focusCalls: number;
  /** Listeners registered via onConfigChanged (fire to simulate external file changes). */
  configChangedListeners: Array<() => void>;
  /** Simulates the cross-process stored-client lease (true = held elsewhere). */
  coderClientLeaseHeld: boolean;
}

function createMockDeps(): MockDeps {
  return {
    providersConfig: {},
    setConfigValueCalls: [],
    setModelsCalls: [],
    focusCalls: 0,
    configChangedListeners: [],
    coderClientLeaseHeld: false,
  };
}

function createMockProvidersConfigStore(
  deps: MockDeps
): Pick<ProvidersConfigStore, "loadProvidersConfig" | "getProvidersFileFingerprint"> {
  return {
    loadProvidersConfig: () => deps.providersConfig,
    getProvidersFileFingerprint: () => JSON.stringify(deps.providersConfig),
  };
}

function createMockFileLeaseManager(
  deps: MockDeps,
  overrides?: Partial<FileLeaseManager>
): Pick<
  FileLeaseManager,
  "tryAcquireCoderOauthClientLease" | "withCoderOauthRefreshLock" | "withCoderOauthLoginCommitLock"
> {
  return {
    tryAcquireCoderOauthClientLease: () => {
      if (deps.coderClientLeaseHeld) {
        return null;
      }
      deps.coderClientLeaseHeld = true;
      return () => {
        deps.coderClientLeaseHeld = false;
      };
    },
    withCoderOauthRefreshLock: async <T>(fn: () => Promise<T> | T): Promise<T> => await fn(),
    withCoderOauthLoginCommitLock: async <T>(fn: () => Promise<T> | T): Promise<T> => await fn(),
    ...overrides,
  };
}

/**
 * A shared, serializing implementation of Config's cross-process locks
 * (withCoderOauthRefreshLock / withCoderOauthLoginCommitLock) for tests that
 * simulate two Xum processes contending on the same providers file.
 */
function createSharedCrossProcessLock(): <T>(fn: () => Promise<T> | T) => Promise<T> {
  let busy = false;
  const queue: Array<() => void> = [];
  return async <T>(fn: () => Promise<T> | T): Promise<T> => {
    while (busy) {
      await new Promise<void>((resolve) => queue.push(resolve));
    }
    busy = true;
    try {
      return await fn();
    } finally {
      busy = false;
      queue.shift()?.();
    }
  };
}

function mockSetConfigValue(
  deps: MockDeps,
  provider: string,
  keyPath: string[],
  value: unknown
): Promise<Result<void, string>> {
  deps.setConfigValueCalls.push({ provider, keyPath, value });
  // Also update the in-memory config so readStoredAuth()/getDeploymentUrl() see the write
  if (provider === "coder" && keyPath.length === 1) {
    deps.providersConfig.coder ??= {};
    if (value === undefined) {
      delete (deps.providersConfig.coder as Record<string, unknown>)[keyPath[0]];
    } else {
      (deps.providersConfig.coder as Record<string, unknown>)[keyPath[0]] = value;
    }
  }
  return Promise.resolve(Ok(undefined));
}

/** Mirrors ProviderService.updateConfigValue's read-predicate-write behavior. */
async function mockUpdateConfigValue(
  deps: MockDeps,
  provider: string,
  keyPath: string[],
  update: (current: unknown) => { value: unknown } | null
): Promise<Result<{ applied: boolean }, string>> {
  let current: unknown = (deps.providersConfig as Record<string, unknown>)[provider];
  for (const key of keyPath) {
    current =
      current !== null && typeof current === "object"
        ? (current as Record<string, unknown>)[key]
        : undefined;
  }
  const decision = update(current);
  if (!decision) {
    return Ok({ applied: false });
  }
  await mockSetConfigValue(deps, provider, keyPath, decision.value);
  return Ok({ applied: true });
}

/**
 * Mirrors ProviderService.updateProviderSection: applies the section update to
 * the in-memory config and records model-list changes in setModelsCalls so
 * tests can assert on catalog writes.
 */
function mockUpdateProviderSection(
  deps: MockDeps,
  provider: string,
  update: (
    section: Record<string, unknown> | undefined
  ) => { value: Record<string, unknown> } | null
): Promise<Result<{ applied: boolean }, string>> {
  const configRecord = deps.providersConfig as Record<string, Record<string, unknown> | undefined>;
  const section = configRecord[provider];
  const decision = update(section ? { ...section } : undefined);
  if (!decision) {
    return Promise.resolve(Ok({ applied: false }));
  }
  if (JSON.stringify(section?.models) !== JSON.stringify(decision.value.models)) {
    deps.setModelsCalls.push({
      provider,
      models: (decision.value.models ?? []) as ProviderModelEntry[],
    });
  }
  configRecord[provider] = decision.value;
  return Promise.resolve(Ok({ applied: true }));
}

function createMockProviderService(
  deps: MockDeps
): Pick<
  ProviderService,
  "setConfigValue" | "setModels" | "updateConfigValue" | "updateProviderSection" | "onConfigChanged"
> {
  return {
    setConfigValue: (provider, keyPath, value) =>
      mockSetConfigValue(deps, provider, keyPath, value),
    updateConfigValue: (provider, keyPath, update) =>
      mockUpdateConfigValue(deps, provider, keyPath, update),
    updateProviderSection: (provider, update) => mockUpdateProviderSection(deps, provider, update),
    setModels: (provider: string, models: ProviderModelEntry[]): Promise<Result<void, string>> => {
      deps.setModelsCalls.push({ provider, models });
      return Promise.resolve(Ok(undefined));
    },
    onConfigChanged: (callback: () => void) => {
      deps.configChangedListeners.push(callback);
      return () => {
        deps.configChangedListeners = deps.configChangedListeners.filter((l) => l !== callback);
      };
    },
  };
}

function createMockWindowService(deps: MockDeps): Pick<WindowService, "focusMainWindow"> {
  return {
    focusMainWindow: () => {
      deps.focusCalls++;
    },
  };
}

function createService(deps: MockDeps): CoderOauthService {
  return new CoderOauthService(
    createMockProvidersConfigStore(deps) as ProvidersConfigStore,
    createMockFileLeaseManager(deps) as FileLeaseManager,
    createMockProviderService(deps) as ProviderService,
    createMockWindowService(deps) as WindowService
  );
}

// Helper to mock globalThis.fetch without needing the `preconnect` property.
function mockFetch(fn: (input: RequestInfo | URL, init?: RequestInit) => Promise<Response>): void {
  globalThis.fetch = Object.assign(fn, {
    preconnect: (_url: string | URL) => {
      // no-op in tests
    },
  }) as typeof fetch;
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe("CoderOauthService", () => {
  let deps: MockDeps;
  let service: CoderOauthService;
  const originalFetch = globalThis.fetch;

  beforeEach(() => {
    deps = createMockDeps();
    service = createService(deps);
  });

  afterEach(async () => {
    globalThis.fetch = originalFetch;
    await service.dispose();
  });

  // -------------------------------------------------------------------------
  // getValidAuth
  // -------------------------------------------------------------------------

  describe("getValidAuth", () => {
    it("returns error when no auth is stored", async () => {
      const result = await service.getValidAuth();
      expect(result.success).toBe(false);
      if (!result.success) {
        expect(result.error).toContain("not configured");
      }
    });

    it("returns stored auth when token is not expired", async () => {
      const auth = validAuth();
      deps.providersConfig = { coder: { deploymentUrl: DEPLOYMENT_URL, coderOauth: auth } };

      const result = await service.getValidAuth();
      expect(result.success).toBe(true);
      if (result.success) {
        expect(result.data.access).toBe(auth.access);
      }
    });

    it("observes a cross-process credential change without a config-change notification", async () => {
      // Regression: the cached credential was only invalidated via the
      // config-change notification, which rides on fs.watch —
      // Config.watchProvidersFile degrades to a no-op on unsupported mounts
      // and can silently die after a watcher error. A long-lived headless
      // process would then keep serving a token another Xum process
      // disconnected or replaced until it expired. The cache must verify the
      // providers file fingerprint on every read, independent of watcher
      // delivery.
      const auth = validAuth();
      deps.providersConfig = { coder: { deploymentUrl: DEPLOYMENT_URL, coderOauth: auth } };

      // First read populates the cache.
      const first = await service.getValidAuth();
      expect(first.success).toBe(true);
      if (first.success) {
        expect(first.data.access).toBe(auth.access);
      }

      // Another process replaces the credential (re-login, same deployment).
      // NO notification is fired — simulating lost/unavailable fs.watch.
      const replaced = validAuth({ sessionId: "session_other", access: "at_other" });
      deps.providersConfig = { coder: { deploymentUrl: DEPLOYMENT_URL, coderOauth: replaced } };

      const second = await service.getValidAuth();
      expect(second.success).toBe(true);
      if (second.success) {
        expect(second.data.access).toBe("at_other");
      }

      // Another process disconnects entirely — again without notification.
      deps.providersConfig = { coder: { deploymentUrl: DEPLOYMENT_URL } };

      const third = await service.getValidAuth();
      expect(third.success).toBe(false);
      if (!third.success) {
        expect(third.error).toContain("not configured");
      }
    });

    it("refreshes an expired token and persists the rotated refresh token before resolving", async () => {
      const expired = expiredAuth({ refresh: "rt_old" });
      deps.providersConfig = { coder: { deploymentUrl: DEPLOYMENT_URL, coderOauth: expired } };

      let refreshBody: URLSearchParams | null = null;
      mockFetch((input, init) => {
        const url = fetchUrl(input);
        expect(url).toBe(`${DEPLOYMENT_URL}/oauth2/tokens`);
        refreshBody = new URLSearchParams(fetchBodyText(init));
        return Promise.resolve(
          jsonResponse({
            access_token: "at_new",
            refresh_token: "rt_rotated",
            expires_in: 3600,
            token_type: "Bearer",
          })
        );
      });

      const result = await service.getValidAuth();
      expect(result.success).toBe(true);
      if (result.success) {
        expect(result.data.access).toBe("at_new");
        expect(result.data.refresh).toBe("rt_rotated");
        // Client credentials carry over across refreshes.
        expect(result.data.clientId).toBe("client_test");
        expect(result.data.clientSecret).toBe("secret_test");
      }

      // Refresh request used the stored client + old refresh token.
      expect(refreshBody).not.toBeNull();
      expect(refreshBody!.get("grant_type")).toBe("refresh_token");
      expect(refreshBody!.get("client_id")).toBe("client_test");
      expect(refreshBody!.get("client_secret")).toBe("secret_test");
      expect(refreshBody!.get("refresh_token")).toBe("rt_old");

      // Coder rotates refresh tokens: the rotated token must be persisted by
      // the time getValidAuth resolves (persist-before-use).
      const storedSection = deps.providersConfig.coder as Record<string, unknown>;
      expect((storedSection.coderOauth as CoderOauthAuth).refresh).toBe("rt_rotated");
    });

    it("only triggers one refresh for concurrent getValidAuth calls with expired tokens", async () => {
      const expired = expiredAuth();
      deps.providersConfig = { coder: { deploymentUrl: DEPLOYMENT_URL, coderOauth: expired } };

      let fetchCallCount = 0;
      mockFetch(async () => {
        fetchCallCount++;
        // Simulate a small delay so all callers are waiting
        await new Promise((resolve) => setTimeout(resolve, 10));
        return jsonResponse({
          access_token: "at_new",
          refresh_token: "rt_rotated",
          expires_in: 3600,
        });
      });

      const results = await Promise.all([
        service.getValidAuth(),
        service.getValidAuth(),
        service.getValidAuth(),
      ]);

      expect(fetchCallCount).toBe(1);
      for (const result of results) {
        expect(result.success).toBe(true);
        if (result.success) {
          expect(result.data.access).toBe("at_new");
        }
      }
    });

    it("clears stored auth on invalid_grant refresh response", async () => {
      const expired = expiredAuth();
      deps.providersConfig = { coder: { deploymentUrl: DEPLOYMENT_URL, coderOauth: expired } };

      mockFetch(() => Promise.resolve(jsonResponse({ error: "invalid_grant" }, 400)));

      const result = await service.getValidAuth();
      expect(result.success).toBe(false);
      if (!result.success) {
        expect(result.error).toContain("Login with Coder");
      }

      const clearCall = deps.setConfigValueCalls.find(
        (c) => c.provider === "coder" && c.keyPath[0] === "coderOauth" && c.value === undefined
      );
      expect(clearCall).toBeDefined();

      // Subsequent calls see no stored auth.
      const second = await service.getValidAuth();
      expect(second.success).toBe(false);
      if (!second.success) {
        expect(second.error).toContain("not configured");
      }
    });

    it("keeps stored auth on transient refresh errors", async () => {
      const expired = expiredAuth();
      deps.providersConfig = { coder: { deploymentUrl: DEPLOYMENT_URL, coderOauth: expired } };

      mockFetch(() => Promise.resolve(new Response("upstream unavailable", { status: 502 })));

      const result = await service.getValidAuth();
      expect(result.success).toBe(false);

      const clearCall = deps.setConfigValueCalls.find(
        (c) => c.provider === "coder" && c.keyPath[0] === "coderOauth" && c.value === undefined
      );
      expect(clearCall).toBeUndefined();
    });

    it("fails when deployment URL is missing for refresh", async () => {
      const expired = expiredAuth();
      deps.providersConfig = { coder: { coderOauth: expired } };

      const result = await service.getValidAuth();
      expect(result.success).toBe(false);
      if (!result.success) {
        expect(result.error).toContain("deployment URL");
      }
    });

    it("does not overwrite a newer login with a refresh result from the old generation", async () => {
      const expired = expiredAuth({ refresh: "rt_old" });
      deps.providersConfig = { coder: { deploymentUrl: DEPLOYMENT_URL, coderOauth: expired } };

      const newerLogin = validAuth({ access: "at_new_login", refresh: "rt_new_login" });
      let revokeBody: URLSearchParams | null = null;
      mockFetch((input, init) => {
        const url = fetchUrl(input);
        if (url === `${DEPLOYMENT_URL}/oauth2/tokens`) {
          // A re-login completes while the refresh round-trip is in flight.
          deps.providersConfig = {
            coder: { deploymentUrl: DEPLOYMENT_URL, coderOauth: newerLogin },
          };
          return Promise.resolve(
            jsonResponse({
              access_token: "at_stale_rotation",
              refresh_token: "rt_stale_rotation",
              expires_in: 86400,
              token_type: "Bearer",
            })
          );
        }
        if (url === `${DEPLOYMENT_URL}/oauth2/revoke`) {
          revokeBody = new URLSearchParams(fetchBodyText(init));
          return Promise.resolve(new Response(null, { status: 200 }));
        }
        return Promise.resolve(new Response("unexpected", { status: 500 }));
      });

      const result = await service.getValidAuth();
      // The newer login wins; the stale rotation is never persisted.
      expect(result.success).toBe(true);
      if (result.success) {
        expect(result.data.access).toBe("at_new_login");
      }
      const staleWrite = deps.setConfigValueCalls.find(
        (c) =>
          c.keyPath[0] === "coderOauth" &&
          (c.value as CoderOauthAuth | undefined)?.access === "at_stale_rotation"
      );
      expect(staleWrite).toBeUndefined();
      // The orphaned rotation was revoked best-effort.
      expect(revokeBody).not.toBeNull();
      expect(revokeBody!.get("token")).toBe("rt_stale_rotation");
    });

    it("adopts a concurrently rotated credential instead of clearing it on invalid_grant", async () => {
      // The refresh mutex is process-local: another process (desktop vs CLI)
      // can consume our refresh token and persist the rotated one. Losing that
      // race must not wipe the winner's valid credential.
      const expired = expiredAuth({ refresh: "rt_loser" });
      deps.providersConfig = { coder: { deploymentUrl: DEPLOYMENT_URL, coderOauth: expired } };

      const winner = validAuth({ access: "at_winner", refresh: "rt_winner" });
      mockFetch((input) => {
        const url = fetchUrl(input);
        if (url === `${DEPLOYMENT_URL}/oauth2/tokens`) {
          // Simulate the other process having already rotated the tokens on disk.
          deps.providersConfig = { coder: { deploymentUrl: DEPLOYMENT_URL, coderOauth: winner } };
          return Promise.resolve(jsonResponse({ error: "invalid_grant" }, 400));
        }
        return Promise.resolve(new Response("unexpected", { status: 500 }));
      });

      const result = await service.getValidAuth();
      expect(result.success).toBe(true);
      if (result.success) {
        expect(result.data.access).toBe("at_winner");
      }
      // The winner's credential was NOT cleared.
      const cleared = deps.setConfigValueCalls.find(
        (c) => c.keyPath[0] === "coderOauth" && c.value === undefined
      );
      expect(cleared).toBeUndefined();
    });

    it("serializes cross-process refreshes so a losing invalid_grant cannot clear the winner's rotation", async () => {
      // Two Xum processes refresh the same expired credential. Without
      // cross-process serialization the loser's invalid_grant response can
      // arrive while the winner's rotation is still in flight; the loser's
      // compare-and-clear then deletes the (still-old) credential, the
      // winner's persist CAS fails, and both processes discard the only valid
      // token. With the shared refresh lock the loser blocks, re-reads the
      // winner's rotation from disk, and never sends a doomed request.
      deps.providersConfig = {
        coder: { deploymentUrl: DEPLOYMENT_URL, coderOauth: expiredAuth() },
      };

      const sharedLock = createSharedCrossProcessLock();
      const makeProcess = (): CoderOauthService =>
        new CoderOauthService(
          createMockProvidersConfigStore(deps) as ProvidersConfigStore,
          createMockFileLeaseManager(deps, {
            withCoderOauthRefreshLock: sharedLock,
          }) as FileLeaseManager,
          createMockProviderService(deps) as ProviderService,
          createMockWindowService(deps) as WindowService
        );
      const processA = makeProcess();
      const processB = makeProcess();

      let tokenRequests = 0;
      let releaseWinner!: () => void;
      const winnerGate = new Promise<void>((resolve) => (releaseWinner = resolve));

      mockFetch(async (input, init) => {
        const url = fetchUrl(input);
        if (url === `${DEPLOYMENT_URL}/oauth2/tokens`) {
          const request = ++tokenRequests;
          if (request === 1) {
            // The winner's rotation: stalled so the race window stays open.
            await winnerGate;
            return jsonResponse({
              access_token: "at_rotated",
              refresh_token: "rt_rotated",
              expires_in: 86400,
              token_type: "Bearer",
            });
          }
          // Any second request would be the loser reusing the consumed
          // refresh token — the exact doomed request the lock must prevent.
          return jsonResponse({ error: "invalid_grant" }, 400);
        }
        if (url === `${DEPLOYMENT_URL}/oauth2/revoke`) {
          return new Response(null, { status: 200 });
        }
        void init;
        return new Response(`unexpected url: ${url}`, { status: 500 });
      });

      const resultAPromise = processA.getValidAuth();
      // A holds the shared lock with its token request in flight; B must
      // queue on the lock rather than issue its own request.
      await waitUntil(() => tokenRequests === 1);
      const resultBPromise = processB.getValidAuth();
      await new Promise((resolve) => setTimeout(resolve, 25));
      expect(tokenRequests).toBe(1);

      releaseWinner();
      const [resultA, resultB] = await Promise.all([resultAPromise, resultBPromise]);

      // Both processes end up with the winner's rotation; B adopted it from
      // disk without ever sending a request with the consumed token.
      expect(resultA.success).toBe(true);
      if (resultA.success) expect(resultA.data.access).toBe("at_rotated");
      expect(resultB.success).toBe(true);
      if (resultB.success) expect(resultB.data.access).toBe("at_rotated");
      expect(tokenRequests).toBe(1);
      // The rotated credential is still on disk (never cleared).
      const storedAuth = (deps.providersConfig.coder as Record<string, unknown>)
        .coderOauth as CoderOauthAuth;
      expect(storedAuth.refresh).toBe("rt_rotated");

      await processA.dispose();
      await processB.dispose();
    });

    it("rejects tokens minted by a different deployment without any network call", async () => {
      // Even non-expired tokens must never be handed out for a different
      // deployment: the bearer token would leak to the new host.
      deps.providersConfig = {
        coder: { deploymentUrl: "http://other.coder.test", coderOauth: validAuth() },
      };

      let fetchCalls = 0;
      mockFetch(() => {
        fetchCalls++;
        return Promise.resolve(new Response("unexpected", { status: 500 }));
      });

      const result = await service.getValidAuth();
      expect(result.success).toBe(false);
      if (!result.success) {
        expect(result.error).toContain("deployment URL changed");
      }
      expect(fetchCalls).toBe(0);
    });

    it("rejects tokens when the deployment URL changes while waiting for the refresh lock", async () => {
      // The pre-lock issuer check reads the URL before the cross-process
      // refresh lock is acquired. A Settings edit landing in that window
      // must be seen by the post-lock re-read — otherwise the old
      // deployment's bearer token would still be served (long-lived model
      // wrappers pinned the old URL at creation, so their issuer check
      // would pass).
      const expired = expiredAuth();
      deps.providersConfig = { coder: { deploymentUrl: DEPLOYMENT_URL, coderOauth: expired } };

      const NEW_URL = "http://other.coder.test";
      const lockSimulatingEdit = async <T>(fn: () => Promise<T> | T): Promise<T> => {
        // The edit lands while this caller waits for the lock.
        (deps.providersConfig.coder as Record<string, unknown>).deploymentUrl = NEW_URL;
        return await fn();
      };
      service = new CoderOauthService(
        createMockProvidersConfigStore(deps) as ProvidersConfigStore,
        createMockFileLeaseManager(deps, {
          withCoderOauthRefreshLock: lockSimulatingEdit,
        }) as FileLeaseManager,
        createMockProviderService(deps) as ProviderService,
        createMockWindowService(deps) as WindowService
      );

      let refreshAttempted = false;
      mockFetch(() => {
        refreshAttempted = true;
        return Promise.resolve(new Response("should not be called", { status: 500 }));
      });

      const result = await service.getValidAuth();
      expect(result.success).toBe(false);
      if (!result.success) {
        expect(result.error).toContain("deployment URL changed");
      }
      // No refresh round-trip was sent for the mismatched issuer.
      expect(refreshAttempted).toBe(false);
      // The stored credential is untouched (a re-login will replace it).
      const stored = deps.providersConfig.coder as Record<string, unknown>;
      expect((stored.coderOauth as CoderOauthAuth).refresh).toBe(expired.refresh);
    });

    it("does not persist a rotation when the deployment URL changes mid-refresh", async () => {
      // The URL edit lands DURING the token round-trip (after the post-lock
      // recheck). Persisting the rotation would store a credential the new
      // configuration can never serve, keeping it alive unrevoked forever —
      // the persist predicate must refuse, and the orphaned rotation must be
      // revoked against the deployment that minted it.
      const expired = expiredAuth({ refresh: "rt_consumed" });
      deps.providersConfig = { coder: { deploymentUrl: DEPLOYMENT_URL, coderOauth: expired } };

      const NEW_URL = "http://other.coder.test";
      let revokedToken: string | null = null;
      mockFetch((input, init) => {
        const url = fetchUrl(input);
        if (url === `${DEPLOYMENT_URL}/oauth2/tokens`) {
          // The edit lands while the refresh round-trip is in flight.
          (deps.providersConfig.coder as Record<string, unknown>).deploymentUrl = NEW_URL;
          return Promise.resolve(
            jsonResponse({
              access_token: "at_orphaned",
              refresh_token: "rt_orphaned",
              expires_in: 3600,
              token_type: "Bearer",
            })
          );
        }
        if (url === `${DEPLOYMENT_URL}/oauth2/revoke`) {
          revokedToken = new URLSearchParams(fetchBodyText(init)).get("token");
          return Promise.resolve(new Response(null, { status: 200 }));
        }
        return Promise.resolve(new Response(`unexpected url: ${url}`, { status: 500 }));
      });

      const result = await service.getValidAuth();
      expect(result.success).toBe(false);
      if (!result.success) {
        expect(result.error).toContain("deployment URL changed");
      }

      // The rotation was NOT persisted; the stored blob still holds the old
      // (consumed) credential, and the orphaned rotation was revoked.
      const stored = deps.providersConfig.coder as Record<string, unknown>;
      expect((stored.coderOauth as CoderOauthAuth).refresh).toBe("rt_consumed");
      expect(revokedToken as string | null).toBe("rt_orphaned");
    });

    it("revokes the orphaned rotation when persisting the rotated tokens fails", async () => {
      // The token endpoint already consumed the stored refresh token when
      // persistence fails (providers.jsonc unwritable, lock timeout):
      // persist-before-use forbids handing the rotation out, so — like the
      // CAS-lost path — the freshly minted full-privilege tokens must be
      // revoked rather than left alive with nothing tracking them.
      const expired = expiredAuth({ refresh: "rt_consumed" });
      deps.providersConfig = { coder: { deploymentUrl: DEPLOYMENT_URL, coderOauth: expired } };

      const failingProviderService = {
        ...createMockProviderService(deps),
        updateProviderSection: () =>
          Promise.resolve(Err("Failed to update provider config: disk full")),
      };
      service = new CoderOauthService(
        createMockProvidersConfigStore(deps) as ProvidersConfigStore,
        createMockFileLeaseManager(deps) as FileLeaseManager,
        failingProviderService as unknown as ProviderService,
        createMockWindowService(deps) as WindowService
      );

      let revokedToken: string | null = null;
      mockFetch((input, init) => {
        const url = fetchUrl(input);
        if (url === `${DEPLOYMENT_URL}/oauth2/tokens`) {
          return Promise.resolve(
            jsonResponse({
              access_token: "at_orphaned",
              refresh_token: "rt_orphaned",
              expires_in: 3600,
              token_type: "Bearer",
            })
          );
        }
        if (url === `${DEPLOYMENT_URL}/oauth2/revoke`) {
          revokedToken = new URLSearchParams(fetchBodyText(init)).get("token");
          return Promise.resolve(new Response(null, { status: 200 }));
        }
        return Promise.resolve(new Response(`unexpected url: ${url}`, { status: 500 }));
      });

      const result = await service.getValidAuth();
      expect(result.success).toBe(false);
      if (!result.success) {
        expect(result.error).toContain("disk full");
      }
      // The unpersistable rotation was revoked against its issuer.
      expect(revokedToken as string | null).toBe("rt_orphaned");
    });

    it("serves credentials written by another process after a config-change notification", async () => {
      // Another Xum process sharing providers.jsonc re-logs in to the SAME
      // deployment: the deployment URL still matches, so only the config
      // change notification (file watcher) can tell this process its cached
      // token is stale. getValidAuth must serve the new on-disk credential,
      // not the cached one, until expiry.
      deps.providersConfig = {
        coder: { deploymentUrl: DEPLOYMENT_URL, coderOauth: validAuth() },
      };

      const first = await service.getValidAuth();
      expect(first.success).toBe(true);
      if (first.success) {
        expect(first.data.access).toBe("at_test");
      }

      deps.providersConfig = {
        coder: {
          deploymentUrl: DEPLOYMENT_URL,
          coderOauth: validAuth({
            sessionId: "session_other_process",
            access: "at_other",
            refresh: "rt_other",
          }),
        },
      };
      for (const listener of deps.configChangedListeners) {
        listener();
      }

      const second = await service.getValidAuth();
      expect(second.success).toBe(true);
      if (second.success) {
        expect(second.data.access).toBe("at_other");
      }
    });
  });

  // -------------------------------------------------------------------------
  // Desktop flow (full loopback round-trip with a fake deployment)
  // -------------------------------------------------------------------------

  describe("startDesktopFlow", () => {
    it("rejects invalid deployment URLs without network calls", async () => {
      let fetchCalled = false;
      mockFetch(() => {
        fetchCalled = true;
        return Promise.resolve(jsonResponse({}));
      });

      const result = await service.startDesktopFlow({ deploymentUrl: "not-a-url" });
      expect(result.success).toBe(false);
      expect(fetchCalled).toBe(false);
    });

    it("surfaces discovery failures with an experiments hint", async () => {
      mockFetch((input) => {
        const url = fetchUrl(input);
        if (url.endsWith("/api/v2/buildinfo")) {
          return Promise.resolve(jsonResponse({ version: "v2.99.0" }));
        }
        return Promise.resolve(new Response("not found", { status: 404 }));
      });

      const result = await service.startDesktopFlow({ deploymentUrl: DEPLOYMENT_URL });
      expect(result.success).toBe(false);
      if (!result.success) {
        expect(result.error).toContain("--experiments=oauth2");
      }
    });

    it("completes the full flow: DCR, PKCE exchange, persistence, and model fetch", async () => {
      const registerCalls: unknown[] = [];
      let exchangeBody: URLSearchParams | null = null;

      mockFetch((input, init) => {
        const url = fetchUrl(input);

        // Let the loopback callback request through to the real local server.
        if (url.startsWith("http://127.0.0.1")) {
          return originalFetch(input, init);
        }

        if (url === `${DEPLOYMENT_URL}/api/v2/buildinfo`) {
          return Promise.resolve(jsonResponse({ version: "v2.99.0" }));
        }
        if (url === `${DEPLOYMENT_URL}/.well-known/oauth-authorization-server`) {
          return Promise.resolve(discoveryResponse());
        }
        if (url === `${DEPLOYMENT_URL}/oauth2/register`) {
          const body = JSON.parse(fetchBodyText(init)) as Record<string, unknown>;
          registerCalls.push(body);
          return Promise.resolve(
            jsonResponse({
              client_id: "client_new",
              client_secret: "secret_new",
              registration_access_token: "reg_token_new",
              registration_client_uri: `${DEPLOYMENT_URL}/oauth2/clients/client_new`,
            })
          );
        }
        if (url === `${DEPLOYMENT_URL}/oauth2/tokens`) {
          exchangeBody = new URLSearchParams(fetchBodyText(init));
          return Promise.resolve(
            jsonResponse({
              access_token: "at_login",
              refresh_token: "rt_login",
              expires_in: 86400,
              token_type: "Bearer",
            })
          );
        }
        if (url === `${DEPLOYMENT_URL}/api/v2/ai/providers`) {
          return Promise.resolve(aiProvidersResponse());
        }
        if (url === `${DEPLOYMENT_URL}/api/v2/aibridge/anthropic/v1/models`) {
          return Promise.resolve(
            jsonResponse({ data: [{ id: "claude-sonnet-4-5" }, { id: "claude-opus-4-1" }] })
          );
        }
        if (url === `${DEPLOYMENT_URL}/api/v2/aibridge/openai/v1/models`) {
          // One upstream unavailable: must be tolerated.
          return Promise.resolve(new Response("aibridge not entitled", { status: 404 }));
        }
        return Promise.resolve(new Response(`unexpected url: ${url}`, { status: 500 }));
      });

      const startResult = await service.startDesktopFlow({
        // Extra path suffix + trailing slash must be normalized away.
        deploymentUrl: `${DEPLOYMENT_URL}/`,
      });
      expect(startResult.success).toBe(true);
      if (!startResult.success) return;

      const { flowId, authorizeUrl } = startResult.data;
      const authorize = new URL(authorizeUrl);
      expect(authorize.origin).toBe(DEPLOYMENT_URL);
      expect(authorize.pathname).toBe("/oauth2/authorize");
      expect(authorize.searchParams.get("response_type")).toBe("code");
      expect(authorize.searchParams.get("client_id")).toBe("client_new");
      expect(authorize.searchParams.get("state")).toBe(flowId);
      expect(authorize.searchParams.get("code_challenge_method")).toBe("S256");

      const redirectUri = authorize.searchParams.get("redirect_uri")!;
      expect(redirectUri).toMatch(/^http:\/\/127\.0\.0\.1:\d+\/callback$/);

      // DCR registered the exact loopback redirect URI (OAuth 2.1 exact matching).
      expect(registerCalls).toHaveLength(1);
      expect((registerCalls[0] as { redirect_uris: string[] }).redirect_uris).toEqual([
        redirectUri,
      ]);

      // Simulate the browser redirect back to the loopback server.
      const waitPromise = service.waitForDesktopFlow(flowId, { timeoutMs: 5000 });
      const callbackUrl = new URL(redirectUri);
      callbackUrl.searchParams.set("code", "auth_code_123");
      callbackUrl.searchParams.set("state", flowId);
      const callbackResponse = await originalFetch(callbackUrl);
      expect(callbackResponse.status).toBe(200);

      const waitResult = await waitPromise;
      expect(waitResult.success).toBe(true);

      // Exchange used PKCE: verifier hashes to the challenge from the authorize URL.
      expect(exchangeBody).not.toBeNull();
      expect(exchangeBody!.get("grant_type")).toBe("authorization_code");
      expect(exchangeBody!.get("code")).toBe("auth_code_123");
      expect(exchangeBody!.get("redirect_uri")).toBe(redirectUri);
      expect(exchangeBody!.get("client_secret")).toBe("secret_new");
      expect(sha256Base64Url(exchangeBody!.get("code_verifier")!)).toBe(
        authorize.searchParams.get("code_challenge")!
      );

      // Normalized deployment URL + full auth blob persisted (atomically, at
      // exchange time — flow start writes nothing).
      const coderSection = deps.providersConfig.coder as Record<string, unknown>;
      expect(coderSection.deploymentUrl).toBe(DEPLOYMENT_URL);
      const persistedAuth = coderSection.coderOauth as CoderOauthAuth;
      expect(persistedAuth.access).toBe("at_login");
      expect(persistedAuth.refresh).toBe("rt_login");
      expect(persistedAuth.sessionId).toBeTruthy();
      expect(persistedAuth.clientId).toBe("client_new");
      expect(persistedAuth.clientSecret).toBe("secret_new");
      expect(persistedAuth.registrationAccessToken).toBe("reg_token_new");

      // Model list fetched from the reachable upstream only (openai 404 is a
      // conclusive "unavailable", not a transient error). The exchange resets
      // the catalog to unknown atomically with the new auth (no models write
      // recorded — there was no previous catalog), then discovery (after the
      // flow resolves) persists the fresh one.
      await waitUntil(() => deps.setModelsCalls.length >= 1);
      const discoveryCall = deps.setModelsCalls[deps.setModelsCalls.length - 1];
      expect(discoveryCall.provider).toBe("coder");
      expect(discoveryCall.models).toEqual([
        "anthropic/claude-sonnet-4-5",
        "anthropic/claude-opus-4-1",
      ]);

      expect(deps.focusCalls).toBe(1);
    });

    it("updates the stored client's redirect URI via RFC 7592 instead of re-registering", async () => {
      deps.providersConfig = {
        coder: { deploymentUrl: DEPLOYMENT_URL, coderOauth: validAuth() },
      };

      let putRedirectUris: string[] | null = null;
      let registerCalled = false;

      mockFetch((input, init) => {
        const url = fetchUrl(input);
        if (url === `${DEPLOYMENT_URL}/api/v2/buildinfo`) {
          return Promise.resolve(jsonResponse({ version: "v2.99.0" }));
        }
        if (url === `${DEPLOYMENT_URL}/.well-known/oauth-authorization-server`) {
          return Promise.resolve(discoveryResponse());
        }
        if (url === `${DEPLOYMENT_URL}/oauth2/clients/client_test` && init?.method === "PUT") {
          const headers = new Headers(init.headers);
          expect(headers.get("Authorization")).toBe("Bearer reg_token_test");
          const body = JSON.parse(fetchBodyText(init)) as { redirect_uris: string[] };
          putRedirectUris = body.redirect_uris;
          return Promise.resolve(jsonResponse({ client_id: "client_test" }));
        }
        if (url === `${DEPLOYMENT_URL}/oauth2/register`) {
          registerCalled = true;
          return Promise.resolve(new Response("should not be called", { status: 500 }));
        }
        return Promise.resolve(new Response(`unexpected url: ${url}`, { status: 500 }));
      });

      const result = await service.startDesktopFlow({ deploymentUrl: DEPLOYMENT_URL });
      expect(result.success).toBe(true);
      if (!result.success) return;

      const redirectUri = new URL(result.data.authorizeUrl).searchParams.get("redirect_uri")!;
      // TS narrows the closure-assigned variable to its initializer type; widen for the assertion.
      expect(putRedirectUris as string[] | null).toEqual([redirectUri]);
      expect(registerCalled).toBe(false);
      // Reused the stored client id.
      expect(new URL(result.data.authorizeUrl).searchParams.get("client_id")).toBe("client_test");

      await service.cancelDesktopFlow(result.data.flowId);
    });

    it("falls back to fresh registration when the RFC 7592 update fails", async () => {
      deps.providersConfig = {
        coder: { deploymentUrl: DEPLOYMENT_URL, coderOauth: validAuth() },
      };

      mockFetch((input, init) => {
        const url = fetchUrl(input);
        if (url === `${DEPLOYMENT_URL}/api/v2/buildinfo`) {
          return Promise.resolve(jsonResponse({ version: "v2.99.0" }));
        }
        if (url === `${DEPLOYMENT_URL}/.well-known/oauth-authorization-server`) {
          return Promise.resolve(discoveryResponse());
        }
        if (url === `${DEPLOYMENT_URL}/oauth2/clients/client_test` && init?.method === "PUT") {
          // Client was deleted server-side.
          return Promise.resolve(jsonResponse({ error: "invalid_token" }, 401));
        }
        if (url === `${DEPLOYMENT_URL}/oauth2/register`) {
          return Promise.resolve(
            jsonResponse({
              client_id: "client_replacement",
              client_secret: "secret_replacement",
            })
          );
        }
        return Promise.resolve(new Response(`unexpected url: ${url}`, { status: 500 }));
      });

      const result = await service.startDesktopFlow({ deploymentUrl: DEPLOYMENT_URL });
      expect(result.success).toBe(true);
      if (!result.success) return;

      expect(new URL(result.data.authorizeUrl).searchParams.get("client_id")).toBe(
        "client_replacement"
      );

      await service.cancelDesktopFlow(result.data.flowId);
    });

    it("rejects login without any network call when policy denies the coder provider", async () => {
      // Regression: a deny-all/provider-restricted policy must stop direct
      // backend RPCs from registering OAuth clients or minting credentials —
      // not merely hide the login UI.
      service = new CoderOauthService(
        createMockProvidersConfigStore(deps) as ProvidersConfigStore,
        createMockFileLeaseManager(deps) as FileLeaseManager,
        createMockProviderService(deps) as ProviderService,
        createMockWindowService(deps) as WindowService,
        {
          isEnforced: () => true,
          isProviderAllowed: (provider: string) => provider !== "coder",
          getForcedBaseUrl: () => undefined,
        } as unknown as PolicyService
      );

      let fetchCalls = 0;
      mockFetch(() => {
        fetchCalls++;
        return Promise.resolve(new Response("should not be called", { status: 500 }));
      });

      const result = await service.startDesktopFlow({ deploymentUrl: DEPLOYMENT_URL });
      expect(result.success).toBe(false);
      if (!result.success) {
        expect(result.error).toContain("not allowed");
      }
      expect(fetchCalls).toBe(0);
    });

    it("refuses to commit a login when policy denies coder mid-flow", async () => {
      // Policy can refresh while the browser authorization is pending: a
      // flow started under a permissive policy must not persist a credential
      // after coder was denied, and the exchanged tokens must be revoked.
      let coderAllowed = true;
      service = new CoderOauthService(
        createMockProvidersConfigStore(deps) as ProvidersConfigStore,
        createMockFileLeaseManager(deps) as FileLeaseManager,
        createMockProviderService(deps) as ProviderService,
        createMockWindowService(deps) as WindowService,
        {
          isEnforced: () => true,
          isProviderAllowed: () => coderAllowed,
          getForcedBaseUrl: () => undefined,
        } as unknown as PolicyService
      );

      const revokedTokens: string[] = [];
      mockFetch(async (input, init) => {
        const url = fetchUrl(input);
        if (url.startsWith("http://127.0.0.1")) {
          return originalFetch(input, init);
        }
        if (url === `${DEPLOYMENT_URL}/api/v2/buildinfo`) {
          return jsonResponse({ version: "v2.99.0" });
        }
        if (url === `${DEPLOYMENT_URL}/.well-known/oauth-authorization-server`) {
          return discoveryResponse();
        }
        if (url === `${DEPLOYMENT_URL}/oauth2/register`) {
          return jsonResponse({ client_id: "client_new", client_secret: "secret_new" });
        }
        if (url === `${DEPLOYMENT_URL}/oauth2/tokens`) {
          return jsonResponse({
            access_token: "at_denied",
            refresh_token: "rt_denied",
            expires_in: 86400,
            token_type: "Bearer",
          });
        }
        if (url === `${DEPLOYMENT_URL}/oauth2/revoke`) {
          revokedTokens.push(new URLSearchParams(fetchBodyText(init)).get("token") ?? "");
          return new Response(null, { status: 200 });
        }
        return new Response(`unexpected url: ${url}`, { status: 500 });
      });

      const startResult = await service.startDesktopFlow({ deploymentUrl: DEPLOYMENT_URL });
      expect(startResult.success).toBe(true);
      if (!startResult.success) return;
      const { flowId, authorizeUrl } = startResult.data;

      // The policy flips to deny while the user is authorizing in the browser.
      coderAllowed = false;

      const callbackUrl = new URL(new URL(authorizeUrl).searchParams.get("redirect_uri")!);
      callbackUrl.searchParams.set("code", "auth_code_denied");
      callbackUrl.searchParams.set("state", flowId);
      const callbackResponse = await originalFetch(callbackUrl).catch(() => null);
      // The browser callback surfaces the failure (HTTP 400), not a success page.
      expect(callbackResponse?.status).toBe(400);

      const waitResult = await service.waitForDesktopFlow(flowId, { timeoutMs: 5000 });
      expect(waitResult.success).toBe(false);
      if (!waitResult.success) {
        expect(waitResult.error).toContain("not allowed");
      }

      // Nothing persisted, and the raced tokens were revoked.
      expect(
        (deps.providersConfig.coder as Record<string, unknown> | undefined)?.coderOauth
      ).toBeUndefined();
      await waitUntil(() => revokedTokens.includes("rt_denied"));
    });

    it("refuses to persist when policy denies coder while the write waits for the file lock", async () => {
      // Regression: the policy checks must run INSIDE the synchronous write
      // predicate, not merely before the mutation. Another process can hold
      // the providers-file lock for seconds, and the policy can refresh to
      // deny coder during that wait — checks done only before the mutation
      // would persist a credential under the obsolete policy.
      let coderAllowed = true;
      let releasePersist!: () => void;
      const persistGate = new Promise<void>((resolve) => (releasePersist = resolve));
      let persistStarted!: () => void;
      const persistStartedPromise = new Promise<void>((resolve) => (persistStarted = resolve));
      let sectionCalls = 0;

      // Gate BEFORE the mutation runs: models the file lock being held by
      // another process while this flow's persist waits.
      const gatedProviderService = {
        ...createMockProviderService(deps),
        updateProviderSection: async (
          provider: string,
          update: (
            section: Record<string, unknown> | undefined
          ) => { value: Record<string, unknown> } | null
        ) => {
          if (++sectionCalls === 1) {
            persistStarted();
            await persistGate;
          }
          return mockUpdateProviderSection(deps, provider, update);
        },
      };
      service = new CoderOauthService(
        createMockProvidersConfigStore(deps) as ProvidersConfigStore,
        createMockFileLeaseManager(deps) as FileLeaseManager,
        gatedProviderService as ProviderService,
        createMockWindowService(deps) as WindowService,
        {
          isEnforced: () => true,
          isProviderAllowed: () => coderAllowed,
          getForcedBaseUrl: () => undefined,
        } as unknown as PolicyService
      );

      const revokedTokens: string[] = [];
      mockFetch(async (input, init) => {
        const url = fetchUrl(input);
        if (url.startsWith("http://127.0.0.1")) {
          return originalFetch(input, init);
        }
        if (url === `${DEPLOYMENT_URL}/api/v2/buildinfo`) {
          return jsonResponse({ version: "v2.99.0" });
        }
        if (url === `${DEPLOYMENT_URL}/.well-known/oauth-authorization-server`) {
          return discoveryResponse();
        }
        if (url === `${DEPLOYMENT_URL}/oauth2/register`) {
          return jsonResponse({ client_id: "client_new", client_secret: "secret_new" });
        }
        if (url === `${DEPLOYMENT_URL}/oauth2/tokens`) {
          return jsonResponse({
            access_token: "at_lockwait",
            refresh_token: "rt_lockwait",
            expires_in: 86400,
            token_type: "Bearer",
          });
        }
        if (url === `${DEPLOYMENT_URL}/oauth2/revoke`) {
          revokedTokens.push(new URLSearchParams(fetchBodyText(init)).get("token") ?? "");
          return new Response(null, { status: 200 });
        }
        return new Response(`unexpected url: ${url}`, { status: 500 });
      });

      const startResult = await service.startDesktopFlow({ deploymentUrl: DEPLOYMENT_URL });
      expect(startResult.success).toBe(true);
      if (!startResult.success) return;
      const { flowId, authorizeUrl } = startResult.data;

      const callbackUrl = new URL(new URL(authorizeUrl).searchParams.get("redirect_uri")!);
      callbackUrl.searchParams.set("code", "auth_code_lockwait");
      callbackUrl.searchParams.set("state", flowId);
      const callbackPromise = originalFetch(callbackUrl).catch(() => null);

      // The persist is waiting on the "file lock"; policy refreshes to deny.
      await persistStartedPromise;
      coderAllowed = false;
      releasePersist();

      const callbackResponse = await callbackPromise;
      expect(callbackResponse?.status).toBe(400);
      const waitResult = await service.waitForDesktopFlow(flowId, { timeoutMs: 5000 });
      expect(waitResult.success).toBe(false);

      // Nothing persisted; the exchanged tokens were revoked.
      expect(
        (deps.providersConfig.coder as Record<string, unknown> | undefined)?.coderOauth
      ).toBeUndefined();
      await waitUntil(() => revokedTokens.includes("rt_lockwait"));
    });

    it("disconnect waits for a foreign commit's critical section before clearing", async () => {
      // Regression: a commit persists its login and announces success as ONE
      // critical section under the cross-process commit lock, but disconnect
      // used to write outside that lock — it could land between the foreign
      // write and the announcement, clearing and revoking the just-persisted
      // credential while the other process still reported the login as
      // connected. disconnect() must serialize on the same lock: it either
      // precedes the commit (tombstone refuses it) or follows it entirely.
      const priorAuth = validAuth({
        sessionId: "session_prior",
        access: "at_prior",
        refresh: "rt_prior",
      });
      deps.providersConfig = {
        coder: { deploymentUrl: DEPLOYMENT_URL, coderOauth: priorAuth },
      };

      // One shared cross-process commit lock for both "processes".
      const sharedCommitLock = createSharedCrossProcessLock();

      // Gate service A's persist AFTER its write lands: A then sits in the
      // post-write pre-announcement window while HOLDING the commit lock.
      let releasePersist!: () => void;
      const persistGate = new Promise<void>((resolve) => (releasePersist = resolve));
      let persistApplied!: () => void;
      const persistAppliedPromise = new Promise<void>((resolve) => (persistApplied = resolve));
      let sectionCalls = 0;

      const gatedProviderService = {
        ...createMockProviderService(deps),
        updateProviderSection: async (
          provider: string,
          update: (
            section: Record<string, unknown> | undefined
          ) => { value: Record<string, unknown> } | null
        ) => {
          const call = ++sectionCalls;
          const result = await mockUpdateProviderSection(deps, provider, update);
          if (call === 1) {
            persistApplied();
            await persistGate;
          }
          return result;
        },
      };
      const serviceA = new CoderOauthService(
        createMockProvidersConfigStore(deps) as ProvidersConfigStore,
        createMockFileLeaseManager(deps, {
          withCoderOauthLoginCommitLock: sharedCommitLock,
        }) as FileLeaseManager,
        gatedProviderService as ProviderService,
        createMockWindowService(deps) as WindowService
      );
      const serviceB = new CoderOauthService(
        createMockProvidersConfigStore(deps) as ProvidersConfigStore,
        createMockFileLeaseManager(deps, {
          withCoderOauthLoginCommitLock: sharedCommitLock,
        }) as FileLeaseManager,
        createMockProviderService(deps) as ProviderService,
        createMockWindowService(deps) as WindowService
      );

      const revokedTokens: string[] = [];
      mockFetch(async (input, init) => {
        const url = fetchUrl(input);
        if (url.startsWith("http://127.0.0.1")) {
          return originalFetch(input, init);
        }
        if (url === `${DEPLOYMENT_URL}/api/v2/buildinfo`) {
          return jsonResponse({ version: "v2.99.0" });
        }
        if (url === `${DEPLOYMENT_URL}/.well-known/oauth-authorization-server`) {
          return discoveryResponse();
        }
        if (url === `${DEPLOYMENT_URL}/oauth2/clients/client_test` && init?.method === "PUT") {
          return jsonResponse({ client_id: "client_test" });
        }
        if (url === `${DEPLOYMENT_URL}/oauth2/register`) {
          return jsonResponse({ client_id: "client_fresh", client_secret: "secret_fresh" });
        }
        if (url === `${DEPLOYMENT_URL}/oauth2/tokens`) {
          return jsonResponse({
            access_token: "at_foreign",
            refresh_token: "rt_foreign",
            expires_in: 86400,
            token_type: "Bearer",
          });
        }
        if (url === `${DEPLOYMENT_URL}/oauth2/revoke`) {
          revokedTokens.push(new URLSearchParams(fetchBodyText(init)).get("token") ?? "");
          return new Response(null, { status: 200 });
        }
        return new Response(`unexpected url: ${url}`, { status: 500 });
      });

      try {
        const startResult = await serviceA.startDesktopFlow({ deploymentUrl: DEPLOYMENT_URL });
        expect(startResult.success).toBe(true);
        if (!startResult.success) return;
        const { flowId, authorizeUrl } = startResult.data;

        const callbackUrl = new URL(new URL(authorizeUrl).searchParams.get("redirect_uri")!);
        callbackUrl.searchParams.set("code", "auth_code_foreign");
        callbackUrl.searchParams.set("state", flowId);
        const callbackPromise = originalFetch(callbackUrl).catch(() => null);

        // A has landed its write and is gated pre-announcement, holding the
        // commit lock. B's disconnect must BLOCK on that lock.
        await persistAppliedPromise;
        let disconnectResolved = false;
        const disconnectPromise = serviceB.disconnect().then((result) => {
          disconnectResolved = true;
          return result;
        });
        await new Promise((resolve) => setTimeout(resolve, 25));
        expect(disconnectResolved).toBe(false);

        // A finishes its critical section: the login is announced as a
        // SUCCESS (it completed before the disconnect in the serialized
        // history)...
        releasePersist();
        const callbackResponse = await callbackPromise;
        expect(callbackResponse?.status).toBe(200);
        const waitResult = await serviceA.waitForDesktopFlow(flowId, { timeoutMs: 5000 });
        expect(waitResult.success).toBe(true);

        // ...and only then does B's disconnect clear the fresh credential.
        const disconnectResult = await disconnectPromise;
        expect(disconnectResult.success).toBe(true);
        expect(
          (deps.providersConfig.coder as Record<string, unknown> | undefined)?.coderOauth
        ).toBeUndefined();
        await waitUntil(() => revokedTokens.includes("rt_foreign"));
      } finally {
        await serviceA.dispose();
        await serviceB.dispose();
      }
    });

    it("refuses to commit when the policy-forced deployment URL changes mid-flow", async () => {
      // Policy can refresh its forcedBaseUrl while the browser authorization
      // is pending: a credential minted by deployment A must not be persisted
      // once routing resolves against B — it would be stored, issuer-
      // mismatched, and reported as a successful login. The exchanged tokens
      // must be revoked against their own issuer instead.
      let forcedUrl: string | undefined = undefined;
      service = new CoderOauthService(
        createMockProvidersConfigStore(deps) as ProvidersConfigStore,
        createMockFileLeaseManager(deps) as FileLeaseManager,
        createMockProviderService(deps) as ProviderService,
        createMockWindowService(deps) as WindowService,
        {
          isEnforced: () => true,
          isProviderAllowed: () => true,
          getForcedBaseUrl: () => forcedUrl,
        } as unknown as PolicyService
      );

      const revokedTokens: string[] = [];
      mockFetch(async (input, init) => {
        const url = fetchUrl(input);
        if (url.startsWith("http://127.0.0.1")) {
          return originalFetch(input, init);
        }
        if (url === `${DEPLOYMENT_URL}/api/v2/buildinfo`) {
          return jsonResponse({ version: "v2.99.0" });
        }
        if (url === `${DEPLOYMENT_URL}/.well-known/oauth-authorization-server`) {
          return discoveryResponse();
        }
        if (url === `${DEPLOYMENT_URL}/oauth2/register`) {
          return jsonResponse({ client_id: "client_new", client_secret: "secret_new" });
        }
        if (url === `${DEPLOYMENT_URL}/oauth2/tokens`) {
          return jsonResponse({
            access_token: "at_forced_change",
            refresh_token: "rt_forced_change",
            expires_in: 86400,
            token_type: "Bearer",
          });
        }
        if (url === `${DEPLOYMENT_URL}/oauth2/revoke`) {
          revokedTokens.push(new URLSearchParams(fetchBodyText(init)).get("token") ?? "");
          return new Response(null, { status: 200 });
        }
        return new Response(`unexpected url: ${url}`, { status: 500 });
      });

      const startResult = await service.startDesktopFlow({ deploymentUrl: DEPLOYMENT_URL });
      expect(startResult.success).toBe(true);
      if (!startResult.success) return;
      const { flowId, authorizeUrl } = startResult.data;

      // The policy pins a DIFFERENT deployment while authorization is pending.
      forcedUrl = "https://locked-elsewhere.example.com";

      const callbackUrl = new URL(new URL(authorizeUrl).searchParams.get("redirect_uri")!);
      callbackUrl.searchParams.set("code", "auth_code_forced_change");
      callbackUrl.searchParams.set("state", flowId);
      const callbackResponse = await originalFetch(callbackUrl).catch(() => null);
      expect(callbackResponse?.status).toBe(400);

      const waitResult = await service.waitForDesktopFlow(flowId, { timeoutMs: 5000 });
      expect(waitResult.success).toBe(false);

      // Nothing persisted, and the mismatched credential was revoked.
      expect(
        (deps.providersConfig.coder as Record<string, unknown> | undefined)?.coderOauth
      ).toBeUndefined();
      await waitUntil(() => revokedTokens.includes("rt_forced_change"));
    });

    it("a disconnect in another process blocks a pending login's commit via the tombstone", async () => {
      // cancelAll/disconnectGeneration are process-local. Simulate two Xum
      // processes sharing providers.jsonc with two service instances over the
      // same deps: service A's login persist is gated mid-commit while
      // service B (a different "process": A's flow is invisible to it)
      // disconnects, stamping coderDisconnectedAt. A's commit must then
      // refuse via the tombstone, revoke its tokens, and leave the account
      // disconnected.
      const priorAuth = validAuth({
        sessionId: "session_prior",
        access: "at_prior",
        refresh: "rt_prior",
      });
      deps.providersConfig = {
        coder: { deploymentUrl: DEPLOYMENT_URL, coderOauth: priorAuth },
      };

      // Gate service A's persist BEFORE the mutation runs so B's disconnect
      // lands (and stamps the tombstone) first.
      let releasePersist!: () => void;
      const persistGate = new Promise<void>((resolve) => (releasePersist = resolve));
      let persistStarted!: () => void;
      const persistStartedPromise = new Promise<void>((resolve) => (persistStarted = resolve));
      let sectionCalls = 0;

      const gatedProviderService = {
        ...createMockProviderService(deps),
        updateProviderSection: async (
          provider: string,
          update: (
            section: Record<string, unknown> | undefined
          ) => { value: Record<string, unknown> } | null
        ) => {
          if (++sectionCalls === 1) {
            persistStarted();
            await persistGate;
          }
          return mockUpdateProviderSection(deps, provider, update);
        },
      };
      const serviceA = new CoderOauthService(
        createMockProvidersConfigStore(deps) as ProvidersConfigStore,
        createMockFileLeaseManager(deps) as FileLeaseManager,
        gatedProviderService as ProviderService,
        createMockWindowService(deps) as WindowService
      );
      const serviceB = new CoderOauthService(
        createMockProvidersConfigStore(deps) as ProvidersConfigStore,
        createMockFileLeaseManager(deps) as FileLeaseManager,
        createMockProviderService(deps) as ProviderService,
        createMockWindowService(deps) as WindowService
      );

      const revokedTokens: string[] = [];
      mockFetch(async (input, init) => {
        const url = fetchUrl(input);
        if (url.startsWith("http://127.0.0.1")) {
          return originalFetch(input, init);
        }
        if (url === `${DEPLOYMENT_URL}/api/v2/buildinfo`) {
          return jsonResponse({ version: "v2.99.0" });
        }
        if (url === `${DEPLOYMENT_URL}/.well-known/oauth-authorization-server`) {
          return discoveryResponse();
        }
        if (url === `${DEPLOYMENT_URL}/oauth2/clients/client_test` && init?.method === "PUT") {
          return jsonResponse({ client_id: "client_test" });
        }
        if (url === `${DEPLOYMENT_URL}/oauth2/register`) {
          return jsonResponse({ client_id: "client_fresh", client_secret: "secret_fresh" });
        }
        if (url === `${DEPLOYMENT_URL}/oauth2/tokens`) {
          return jsonResponse({
            access_token: "at_foreign",
            refresh_token: "rt_foreign",
            expires_in: 86400,
            token_type: "Bearer",
          });
        }
        if (url === `${DEPLOYMENT_URL}/oauth2/revoke`) {
          revokedTokens.push(new URLSearchParams(fetchBodyText(init)).get("token") ?? "");
          return new Response(null, { status: 200 });
        }
        return new Response(`unexpected url: ${url}`, { status: 500 });
      });

      try {
        const startResult = await serviceA.startDesktopFlow({ deploymentUrl: DEPLOYMENT_URL });
        expect(startResult.success).toBe(true);
        if (!startResult.success) return;
        const { flowId, authorizeUrl } = startResult.data;

        const callbackUrl = new URL(new URL(authorizeUrl).searchParams.get("redirect_uri")!);
        callbackUrl.searchParams.set("code", "auth_code_foreign");
        callbackUrl.searchParams.set("state", flowId);
        const callbackPromise = originalFetch(callbackUrl).catch(() => null);

        // A's persist is gated; B (unaware of A's flow) disconnects.
        await persistStartedPromise;
        const disconnectResult = await serviceB.disconnect();
        expect(disconnectResult.success).toBe(true);
        expect(revokedTokens).toContain("rt_prior");

        releasePersist();
        const callbackResponse = await callbackPromise;
        // A's commit refused via the tombstone: browser sees the failure.
        expect(callbackResponse?.status).toBe(400);

        const waitResult = await serviceA.waitForDesktopFlow(flowId, { timeoutMs: 5000 });
        expect(waitResult.success).toBe(false);

        // The account stays disconnected and A's raced tokens were revoked.
        expect(
          (deps.providersConfig.coder as Record<string, unknown> | undefined)?.coderOauth
        ).toBeUndefined();
        await waitUntil(() => revokedTokens.includes("rt_foreign"));
      } finally {
        await serviceA.dispose();
        await serviceB.dispose();
      }
    });

    it("logs in to the policy-forced deployment instead of the requested URL", async () => {
      const FORCED_URL = "http://locked.coder.test";
      service = new CoderOauthService(
        createMockProvidersConfigStore(deps) as ProvidersConfigStore,
        createMockFileLeaseManager(deps) as FileLeaseManager,
        createMockProviderService(deps) as ProviderService,
        createMockWindowService(deps) as WindowService,
        {
          isEnforced: () => true,
          isProviderAllowed: () => true,
          getForcedBaseUrl: (provider: string) =>
            provider === "coder" ? `${FORCED_URL}/` : undefined,
        } as unknown as PolicyService
      );

      let requestedHostCalls = 0;
      mockFetch((input) => {
        const url = fetchUrl(input);
        if (url.startsWith(DEPLOYMENT_URL)) {
          requestedHostCalls++;
          return Promise.resolve(new Response("should not be called", { status: 500 }));
        }
        if (url === `${FORCED_URL}/api/v2/buildinfo`) {
          return Promise.resolve(jsonResponse({ version: "v2.99.0" }));
        }
        if (url === `${FORCED_URL}/.well-known/oauth-authorization-server`) {
          return Promise.resolve(
            jsonResponse({
              authorization_endpoint: `${FORCED_URL}/oauth2/authorize`,
              token_endpoint: `${FORCED_URL}/oauth2/tokens`,
              registration_endpoint: `${FORCED_URL}/oauth2/register`,
              code_challenge_methods_supported: ["S256"],
            })
          );
        }
        if (url === `${FORCED_URL}/oauth2/register`) {
          return Promise.resolve(jsonResponse({ client_id: "c_locked", client_secret: "s" }));
        }
        return Promise.resolve(new Response(`unexpected url: ${url}`, { status: 500 }));
      });

      // User asks for DEPLOYMENT_URL; policy must reroute the login.
      const result = await service.startDesktopFlow({ deploymentUrl: DEPLOYMENT_URL });
      expect(result.success).toBe(true);
      if (!result.success) return;

      expect(requestedHostCalls).toBe(0);
      expect(new URL(result.data.authorizeUrl).origin).toBe(FORCED_URL);
      // Nothing persisted at flow start: the (forced) URL is committed
      // atomically with the auth blob only when the flow completes.
      const urlCall = deps.setConfigValueCalls.find((c) => c.keyPath[0] === "deploymentUrl");
      expect(urlCall).toBeUndefined();

      await service.cancelDesktopFlow(result.data.flowId);
    });

    it("registers a fresh client when logging in to a different deployment", async () => {
      // Client registered on the OLD deployment must not be reused (its RFC 7592
      // endpoint points at the old host).
      const oldDeployment = "http://old.coder.test";
      deps.providersConfig = {
        coder: {
          deploymentUrl: oldDeployment,
          coderOauth: validAuth({
            deploymentUrl: oldDeployment,
            registrationClientUri: `${oldDeployment}/oauth2/clients/client_test`,
          }),
        },
      };

      let oldHostCalls = 0;
      mockFetch((input) => {
        const url = fetchUrl(input);
        if (url.startsWith(oldDeployment)) {
          oldHostCalls++;
          return Promise.resolve(new Response("should not be called", { status: 500 }));
        }
        if (url === `${DEPLOYMENT_URL}/api/v2/buildinfo`) {
          return Promise.resolve(jsonResponse({ version: "v2.99.0" }));
        }
        if (url === `${DEPLOYMENT_URL}/.well-known/oauth-authorization-server`) {
          return Promise.resolve(discoveryResponse());
        }
        if (url === `${DEPLOYMENT_URL}/oauth2/register`) {
          return Promise.resolve(
            jsonResponse({ client_id: "client_fresh", client_secret: "secret_fresh" })
          );
        }
        return Promise.resolve(new Response(`unexpected url: ${url}`, { status: 500 }));
      });

      const result = await service.startDesktopFlow({ deploymentUrl: DEPLOYMENT_URL });
      expect(result.success).toBe(true);
      if (!result.success) return;

      expect(oldHostCalls).toBe(0);
      expect(new URL(result.data.authorizeUrl).searchParams.get("client_id")).toBe("client_fresh");

      await service.cancelDesktopFlow(result.data.flowId);
    });

    it("re-asserts its own deployment URL when finishing after a login to another deployment", async () => {
      // Overlapping flows: a login to deployment B starts (persisting B's URL)
      // while this flow for deployment A is mid-exchange. When A finishes
      // last, it must write its URL together with its auth — otherwise the
      // section would pair A's auth with B's URL and fail issuer validation.
      const OTHER_URL = "http://other.coder.test";

      mockFetch(async (input, init) => {
        const url = fetchUrl(input);
        if (url.startsWith("http://127.0.0.1")) {
          return originalFetch(input, init);
        }
        if (url === `${DEPLOYMENT_URL}/api/v2/buildinfo`) {
          return jsonResponse({ version: "v2.99.0" });
        }
        if (url === `${DEPLOYMENT_URL}/.well-known/oauth-authorization-server`) {
          return discoveryResponse();
        }
        if (url === `${DEPLOYMENT_URL}/oauth2/register`) {
          return jsonResponse({ client_id: "client_new", client_secret: "secret_new" });
        }
        if (url === `${DEPLOYMENT_URL}/oauth2/tokens`) {
          // A login to deployment B completes while A's exchange round-trip is
          // in flight, committing B's URL.
          deps.providersConfig.coder ??= {};
          (deps.providersConfig.coder as Record<string, unknown>).deploymentUrl = OTHER_URL;
          return jsonResponse({
            access_token: "at_slow_a",
            refresh_token: "rt_slow_a",
            expires_in: 86400,
            token_type: "Bearer",
          });
        }
        if (url.includes("/api/v2/aibridge/")) {
          return new Response("no catalog", { status: 404 });
        }
        return new Response(`unexpected url: ${url}`, { status: 500 });
      });

      const startResult = await service.startDesktopFlow({ deploymentUrl: DEPLOYMENT_URL });
      expect(startResult.success).toBe(true);
      if (!startResult.success) return;
      const { flowId, authorizeUrl } = startResult.data;

      const waitPromise = service.waitForDesktopFlow(flowId, { timeoutMs: 5000 });
      const callbackUrl = new URL(new URL(authorizeUrl).searchParams.get("redirect_uri")!);
      callbackUrl.searchParams.set("code", "auth_code_slow_a");
      callbackUrl.searchParams.set("state", flowId);
      await originalFetch(callbackUrl);
      const waitResult = await waitPromise;
      expect(waitResult.success).toBe(true);

      // The completed login owns a coherent section: URL matches auth issuer.
      const coderSection = deps.providersConfig.coder as Record<string, unknown>;
      expect(coderSection.deploymentUrl).toBe(DEPLOYMENT_URL);
      expect((coderSection.coderOauth as CoderOauthAuth).deploymentUrl).toBe(DEPLOYMENT_URL);
      expect((coderSection.coderOauth as CoderOauthAuth).access).toBe("at_slow_a");
    });

    it("does not persist tokens when the flow is cancelled during the exchange", async () => {
      let releaseExchange!: () => void;
      const exchangeGate = new Promise<void>((resolve) => (releaseExchange = resolve));
      let exchangeStarted!: () => void;
      const exchangeStartedPromise = new Promise<void>((resolve) => (exchangeStarted = resolve));
      let revokeBody: URLSearchParams | null = null;

      mockFetch(async (input, init) => {
        const url = fetchUrl(input);
        if (url.startsWith("http://127.0.0.1")) {
          return originalFetch(input, init);
        }
        if (url === `${DEPLOYMENT_URL}/api/v2/buildinfo`) {
          return jsonResponse({ version: "v2.99.0" });
        }
        if (url === `${DEPLOYMENT_URL}/.well-known/oauth-authorization-server`) {
          return discoveryResponse();
        }
        if (url === `${DEPLOYMENT_URL}/oauth2/register`) {
          return jsonResponse({ client_id: "client_new", client_secret: "secret_new" });
        }
        if (url === `${DEPLOYMENT_URL}/oauth2/tokens`) {
          // Hold the exchange round-trip open so the test can cancel mid-flight.
          exchangeStarted();
          await exchangeGate;
          return jsonResponse({
            access_token: "at_raced",
            refresh_token: "rt_raced",
            expires_in: 86400,
            token_type: "Bearer",
          });
        }
        if (url === `${DEPLOYMENT_URL}/oauth2/revoke`) {
          revokeBody = new URLSearchParams(fetchBodyText(init));
          return new Response(null, { status: 200 });
        }
        return new Response(`unexpected url: ${url}`, { status: 500 });
      });

      const startResult = await service.startDesktopFlow({ deploymentUrl: DEPLOYMENT_URL });
      expect(startResult.success).toBe(true);
      if (!startResult.success) return;
      const { flowId, authorizeUrl } = startResult.data;

      const waitPromise = service.waitForDesktopFlow(flowId, { timeoutMs: 5000 });

      // Trigger the callback but do NOT await the response: it only resolves
      // after the (gated) exchange settles.
      const callbackUrl = new URL(new URL(authorizeUrl).searchParams.get("redirect_uri")!);
      callbackUrl.searchParams.set("code", "auth_code_raced");
      callbackUrl.searchParams.set("state", flowId);
      const callbackPromise = originalFetch(callbackUrl).catch(() => null);

      await exchangeStartedPromise;
      await service.cancelDesktopFlow(flowId);
      releaseExchange();

      const waitResult = await waitPromise;
      expect(waitResult.success).toBe(false);
      await callbackPromise;

      // Give the detached exchange task a beat to run its post-cancel branch.
      await new Promise((resolve) => setTimeout(resolve, 50));

      // No credentials persisted; the raced tokens were revoked best-effort.
      const persisted = deps.setConfigValueCalls.find(
        (c) => c.keyPath[0] === "coderOauth" && c.value !== undefined
      );
      expect(persisted).toBeUndefined();
      expect(revokeBody).not.toBeNull();
      expect(revokeBody!.get("token")).toBe("rt_raced");
    });

    it("revokes exchanged tokens when persisting the login fails", async () => {
      // Token exchange succeeds but the provider-section write errors (e.g.
      // providers.jsonc unwritable or its lock timed out). The flow fails —
      // and the freshly minted tokens must be revoked, or they would stay
      // active and untracked on the deployment while the UI shows a failed
      // login.
      const failingProviderService = {
        ...createMockProviderService(deps),
        updateProviderSection: () =>
          Promise.resolve({ success: false as const, error: "providers.jsonc is unwritable" }),
      };
      service = new CoderOauthService(
        createMockProvidersConfigStore(deps) as ProvidersConfigStore,
        createMockFileLeaseManager(deps) as FileLeaseManager,
        failingProviderService as unknown as ProviderService,
        createMockWindowService(deps) as WindowService
      );

      let revokeBody: URLSearchParams | null = null;

      mockFetch(async (input, init) => {
        const url = fetchUrl(input);
        if (url.startsWith("http://127.0.0.1")) {
          return originalFetch(input, init);
        }
        if (url === `${DEPLOYMENT_URL}/api/v2/buildinfo`) {
          return jsonResponse({ version: "v2.99.0" });
        }
        if (url === `${DEPLOYMENT_URL}/.well-known/oauth-authorization-server`) {
          return discoveryResponse();
        }
        if (url === `${DEPLOYMENT_URL}/oauth2/register`) {
          return jsonResponse({ client_id: "client_new", client_secret: "secret_new" });
        }
        if (url === `${DEPLOYMENT_URL}/oauth2/tokens`) {
          return jsonResponse({
            access_token: "at_unpersisted",
            refresh_token: "rt_unpersisted",
            expires_in: 86400,
            token_type: "Bearer",
          });
        }
        if (url === `${DEPLOYMENT_URL}/oauth2/revoke`) {
          revokeBody = new URLSearchParams(fetchBodyText(init));
          return new Response(null, { status: 200 });
        }
        return new Response(`unexpected url: ${url}`, { status: 500 });
      });

      const startResult = await service.startDesktopFlow({ deploymentUrl: DEPLOYMENT_URL });
      expect(startResult.success).toBe(true);
      if (!startResult.success) return;
      const { flowId, authorizeUrl } = startResult.data;

      const waitPromise = service.waitForDesktopFlow(flowId, { timeoutMs: 5000 });
      const callbackUrl = new URL(new URL(authorizeUrl).searchParams.get("redirect_uri")!);
      callbackUrl.searchParams.set("code", "auth_code_failed_persist");
      callbackUrl.searchParams.set("state", flowId);
      await originalFetch(callbackUrl).catch(() => null);

      // The flow surfaces the persist failure...
      const waitResult = await waitPromise;
      expect(waitResult.success).toBe(false);
      if (!waitResult.success) {
        expect(waitResult.error).toContain("unwritable");
      }
      // ...and the exchanged (never persisted) tokens are revoked.
      await waitUntil(() => revokeBody !== null);
      expect(revokeBody!.get("token")).toBe("rt_unpersisted");
    });

    it("finishes the flow and revokes tokens when the cross-process commit lock fails", async () => {
      // The commit lock itself can reject (acquisition timeout, EACCES on the
      // lock directory). That rejection must not escape the detached flow
      // task: the flow must finish with the error immediately (not hang until
      // the five-minute timeout) and the exchanged tokens must be revoked.
      service = new CoderOauthService(
        createMockProvidersConfigStore(deps) as ProvidersConfigStore,
        createMockFileLeaseManager(deps, {
          withCoderOauthLoginCommitLock: <T>(_fn: () => Promise<T> | T): Promise<T> =>
            Promise.reject(new Error("EACCES: permission denied, mkdir lock")),
        }) as FileLeaseManager,
        createMockProviderService(deps) as ProviderService,
        createMockWindowService(deps) as WindowService
      );

      let revokeBody: URLSearchParams | null = null;

      mockFetch(async (input, init) => {
        const url = fetchUrl(input);
        if (url.startsWith("http://127.0.0.1")) {
          return originalFetch(input, init);
        }
        if (url === `${DEPLOYMENT_URL}/api/v2/buildinfo`) {
          return jsonResponse({ version: "v2.99.0" });
        }
        if (url === `${DEPLOYMENT_URL}/.well-known/oauth-authorization-server`) {
          return discoveryResponse();
        }
        if (url === `${DEPLOYMENT_URL}/oauth2/register`) {
          return jsonResponse({ client_id: "client_new", client_secret: "secret_new" });
        }
        if (url === `${DEPLOYMENT_URL}/oauth2/tokens`) {
          return jsonResponse({
            access_token: "at_lockfail",
            refresh_token: "rt_lockfail",
            expires_in: 86400,
            token_type: "Bearer",
          });
        }
        if (url === `${DEPLOYMENT_URL}/oauth2/revoke`) {
          revokeBody = new URLSearchParams(fetchBodyText(init));
          return new Response(null, { status: 200 });
        }
        return new Response(`unexpected url: ${url}`, { status: 500 });
      });

      const startResult = await service.startDesktopFlow({ deploymentUrl: DEPLOYMENT_URL });
      expect(startResult.success).toBe(true);
      if (!startResult.success) return;
      const { flowId, authorizeUrl } = startResult.data;

      const waitPromise = service.waitForDesktopFlow(flowId, { timeoutMs: 5000 });
      const callbackUrl = new URL(new URL(authorizeUrl).searchParams.get("redirect_uri")!);
      callbackUrl.searchParams.set("code", "auth_code_lockfail");
      callbackUrl.searchParams.set("state", flowId);
      await originalFetch(callbackUrl).catch(() => null);

      // The flow surfaces the lock failure without hanging...
      const waitResult = await waitPromise;
      expect(waitResult.success).toBe(false);
      if (!waitResult.success) {
        expect(waitResult.error).toContain("Failed to commit Coder login");
      }
      // ...and the exchanged tokens are revoked.
      await waitUntil(() => revokeBody !== null);
      expect(revokeBody!.get("token")).toBe("rt_lockfail");
      // Nothing was persisted.
      expect(deps.providersConfig.coder?.coderOauth).toBeUndefined();
    });

    it("revokes the credential a successful re-login replaced", async () => {
      // An already-connected account re-logs in: the previous OAuth blob is
      // replaced by the new one, and nothing else references it — Disconnect
      // only knows the new blob. The superseded refresh token must be revoked
      // after the commit, or it would stay valid forever untracked.
      const priorAuth = validAuth({
        sessionId: "session_prior",
        access: "at_prior",
        refresh: "rt_prior",
      });
      deps.providersConfig = {
        coder: { deploymentUrl: DEPLOYMENT_URL, coderOauth: priorAuth },
      };

      const revokedTokens: string[] = [];

      mockFetch(async (input, init) => {
        const url = fetchUrl(input);
        if (url.startsWith("http://127.0.0.1")) {
          return originalFetch(input, init);
        }
        if (url === `${DEPLOYMENT_URL}/api/v2/buildinfo`) {
          return jsonResponse({ version: "v2.99.0" });
        }
        if (url === `${DEPLOYMENT_URL}/.well-known/oauth-authorization-server`) {
          return discoveryResponse();
        }
        if (url === `${DEPLOYMENT_URL}/oauth2/clients/client_test` && init?.method === "PUT") {
          return jsonResponse({ client_id: "client_test" });
        }
        if (url === `${DEPLOYMENT_URL}/oauth2/tokens`) {
          return jsonResponse({
            access_token: "at_relogin",
            refresh_token: "rt_relogin",
            expires_in: 86400,
            token_type: "Bearer",
          });
        }
        if (url === `${DEPLOYMENT_URL}/oauth2/revoke`) {
          revokedTokens.push(new URLSearchParams(fetchBodyText(init)).get("token") ?? "");
          return new Response(null, { status: 200 });
        }
        if (url.includes("/api/v2/aibridge/")) {
          return new Response("aibridge not entitled", { status: 404 });
        }
        return new Response(`unexpected url: ${url}`, { status: 500 });
      });

      const startResult = await service.startDesktopFlow({ deploymentUrl: DEPLOYMENT_URL });
      expect(startResult.success).toBe(true);
      if (!startResult.success) return;
      const { flowId, authorizeUrl } = startResult.data;

      const waitPromise = service.waitForDesktopFlow(flowId, { timeoutMs: 5000 });
      const callbackUrl = new URL(new URL(authorizeUrl).searchParams.get("redirect_uri")!);
      callbackUrl.searchParams.set("code", "auth_code_relogin");
      callbackUrl.searchParams.set("state", flowId);
      await originalFetch(callbackUrl);
      const waitResult = await waitPromise;
      expect(waitResult.success).toBe(true);

      // The new login is persisted...
      const storedAuth = (deps.providersConfig.coder as Record<string, unknown>)
        .coderOauth as CoderOauthAuth;
      expect(storedAuth.access).toBe("at_relogin");
      // ...and the superseded credential was revoked (only that one).
      await waitUntil(() => revokedTokens.length > 0);
      expect(revokedTokens).toEqual(["rt_prior"]);
    });

    it("rolls back persisted credentials when cancelled during the persist write", async () => {
      // Gate the persist (setConfigValue) write so cancellation can land in the
      // window between the pre-persist liveness check and the flow commit.
      let releasePersist!: () => void;
      const persistGate = new Promise<void>((resolve) => (releasePersist = resolve));
      let persistStarted!: () => void;
      const persistStartedPromise = new Promise<void>((resolve) => (persistStarted = resolve));
      let revokeBody: URLSearchParams | null = null;

      const gatedProviderService = {
        ...createMockProviderService(deps),
        updateProviderSection: async (
          provider: string,
          update: (
            section: Record<string, unknown> | undefined
          ) => { value: Record<string, unknown> } | null
        ) => {
          // Gate credential writes (login persists route through updateProviderSection).
          persistStarted();
          await persistGate;
          return mockUpdateProviderSection(deps, provider, update);
        },
      };
      service = new CoderOauthService(
        createMockProvidersConfigStore(deps) as ProvidersConfigStore,
        createMockFileLeaseManager(deps) as FileLeaseManager,
        gatedProviderService as ProviderService,
        createMockWindowService(deps) as WindowService
      );

      mockFetch(async (input, init) => {
        const url = fetchUrl(input);
        if (url.startsWith("http://127.0.0.1")) {
          return originalFetch(input, init);
        }
        if (url === `${DEPLOYMENT_URL}/api/v2/buildinfo`) {
          return jsonResponse({ version: "v2.99.0" });
        }
        if (url === `${DEPLOYMENT_URL}/.well-known/oauth-authorization-server`) {
          return discoveryResponse();
        }
        if (url === `${DEPLOYMENT_URL}/oauth2/register`) {
          return jsonResponse({ client_id: "client_new", client_secret: "secret_new" });
        }
        if (url === `${DEPLOYMENT_URL}/oauth2/tokens`) {
          return jsonResponse({
            access_token: "at_persist_race",
            refresh_token: "rt_persist_race",
            expires_in: 86400,
            token_type: "Bearer",
          });
        }
        if (url === `${DEPLOYMENT_URL}/oauth2/revoke`) {
          revokeBody = new URLSearchParams(fetchBodyText(init));
          return new Response(null, { status: 200 });
        }
        return new Response(`unexpected url: ${url}`, { status: 500 });
      });

      const startResult = await service.startDesktopFlow({ deploymentUrl: DEPLOYMENT_URL });
      expect(startResult.success).toBe(true);
      if (!startResult.success) return;
      const { flowId, authorizeUrl } = startResult.data;

      const callbackUrl = new URL(new URL(authorizeUrl).searchParams.get("redirect_uri")!);
      callbackUrl.searchParams.set("code", "auth_code_persist_race");
      callbackUrl.searchParams.set("state", flowId);
      const callbackPromise = originalFetch(callbackUrl).catch(() => null);

      await persistStartedPromise;
      await service.cancelDesktopFlow(flowId);
      releasePersist();
      await callbackPromise;

      // Cancellation won while the persist waited: the in-lock liveness check
      // skips the write entirely and the raced tokens are revoked.
      await waitUntil(() => revokeBody !== null);
      expect((deps.providersConfig.coder as Record<string, unknown> | undefined)?.coderOauth).toBe(
        undefined
      );
      expect(revokeBody!.get("token")).toBe("rt_persist_race");
    });

    it("restores the prior login when a re-login is cancelled during its persist", async () => {
      // A connected account re-logs in; Cancel lands while the new login's
      // section mutation waits for the providers-file lock. The prior login
      // (auth + URL + catalog) must survive intact.
      const priorAuth = validAuth({
        sessionId: "session_prior",
        access: "at_prior",
        refresh: "rt_prior",
      });
      deps.providersConfig = {
        coder: {
          deploymentUrl: DEPLOYMENT_URL,
          coderOauth: priorAuth,
          models: ["anthropic/prior-model"],
        },
      };

      let releasePersist!: () => void;
      const persistGate = new Promise<void>((resolve) => (releasePersist = resolve));
      let persistStarted!: () => void;
      const persistStartedPromise = new Promise<void>((resolve) => (persistStarted = resolve));
      let revokeBody: URLSearchParams | null = null;

      const gatedProviderService = {
        ...createMockProviderService(deps),
        updateProviderSection: async (
          provider: string,
          update: (
            section: Record<string, unknown> | undefined
          ) => { value: Record<string, unknown> } | null
        ) => {
          persistStarted();
          await persistGate;
          return mockUpdateProviderSection(deps, provider, update);
        },
      };
      service = new CoderOauthService(
        createMockProvidersConfigStore(deps) as ProvidersConfigStore,
        createMockFileLeaseManager(deps) as FileLeaseManager,
        gatedProviderService as ProviderService,
        createMockWindowService(deps) as WindowService
      );

      mockFetch(async (input, init) => {
        const url = fetchUrl(input);
        if (url.startsWith("http://127.0.0.1")) {
          return originalFetch(input, init);
        }
        if (url === `${DEPLOYMENT_URL}/api/v2/buildinfo`) {
          return jsonResponse({ version: "v2.99.0" });
        }
        if (url === `${DEPLOYMENT_URL}/.well-known/oauth-authorization-server`) {
          return discoveryResponse();
        }
        if (url === `${DEPLOYMENT_URL}/oauth2/clients/client_test` && init?.method === "PUT") {
          return jsonResponse({ client_id: "client_test" });
        }
        if (url === `${DEPLOYMENT_URL}/oauth2/tokens`) {
          return jsonResponse({
            access_token: "at_relogin",
            refresh_token: "rt_relogin",
            expires_in: 86400,
            token_type: "Bearer",
          });
        }
        if (url === `${DEPLOYMENT_URL}/oauth2/revoke`) {
          revokeBody = new URLSearchParams(fetchBodyText(init));
          return new Response(null, { status: 200 });
        }
        return new Response(`unexpected url: ${url}`, { status: 500 });
      });

      const startResult = await service.startDesktopFlow({ deploymentUrl: DEPLOYMENT_URL });
      expect(startResult.success).toBe(true);
      if (!startResult.success) return;
      const { flowId, authorizeUrl } = startResult.data;

      const callbackUrl = new URL(new URL(authorizeUrl).searchParams.get("redirect_uri")!);
      callbackUrl.searchParams.set("code", "auth_code_relogin");
      callbackUrl.searchParams.set("state", flowId);
      const callbackPromise = originalFetch(callbackUrl).catch(() => null);

      await persistStartedPromise;
      await service.cancelDesktopFlow(flowId);
      releasePersist();
      // The deferred browser response must be ENDED by the cancelled commit
      // (HTTP 400), not left open: an open response pins server.close() and
      // with it the awaited cancel RPC. A hung fetch here fails the test.
      const callbackResponse = await callbackPromise;
      expect(callbackResponse?.status).toBe(400);

      // The cancelled re-login's tokens were revoked...
      await waitUntil(() => revokeBody !== null);
      expect(revokeBody!.get("token")).toBe("rt_relogin");
      // ...and the prior login survives untouched: auth, URL, and catalog.
      const coderSection = deps.providersConfig.coder as Record<string, unknown>;
      expect((coderSection.coderOauth as CoderOauthAuth).access).toBe("at_prior");
      expect(coderSection.deploymentUrl).toBe(DEPLOYMENT_URL);
      expect(coderSection.models).toEqual(["anthropic/prior-model"]);
    });

    it("keeps the persisted login unrevoked when a post-persist cancel's rollback write fails", async () => {
      // Cancellation wins right after the login section is persisted, and the
      // ROLLBACK write then fails (providers.jsonc unwritable, lock timeout):
      // the persisted section still holds the new tokens. Revoking them would
      // leave Settings reporting a connected account whose every request
      // fails — the tokens must stay alive instead (the stored blob keeps
      // them tracked; Disconnect or the next login revokes them).
      let releasePersist!: () => void;
      const persistGate = new Promise<void>((resolve) => (releasePersist = resolve));
      let persistApplied!: () => void;
      const persistAppliedPromise = new Promise<void>((resolve) => (persistApplied = resolve));
      let sectionCalls = 0;
      let rollbackAttempted = false;

      const gatedProviderService = {
        ...createMockProviderService(deps),
        updateProviderSection: async (
          provider: string,
          update: (
            section: Record<string, unknown> | undefined
          ) => { value: Record<string, unknown> } | null
        ) => {
          const call = ++sectionCalls;
          if (call === 1) {
            // The login persist: land the write, then hold the commit so the
            // cancellation deterministically hits the persist->commit window.
            const result = await mockUpdateProviderSection(deps, provider, update);
            persistApplied();
            await persistGate;
            return result;
          }
          // The rollback: the providers file has become unwritable.
          rollbackAttempted = true;
          return Err("Failed to update provider config: disk full");
        },
      };
      service = new CoderOauthService(
        createMockProvidersConfigStore(deps) as ProvidersConfigStore,
        createMockFileLeaseManager(deps) as FileLeaseManager,
        gatedProviderService as unknown as ProviderService,
        createMockWindowService(deps) as WindowService
      );

      const revokedTokens: string[] = [];
      mockFetch(async (input, init) => {
        const url = fetchUrl(input);
        if (url.startsWith("http://127.0.0.1")) {
          return originalFetch(input, init);
        }
        if (url === `${DEPLOYMENT_URL}/api/v2/buildinfo`) {
          return jsonResponse({ version: "v2.99.0" });
        }
        if (url === `${DEPLOYMENT_URL}/.well-known/oauth-authorization-server`) {
          return discoveryResponse();
        }
        if (url === `${DEPLOYMENT_URL}/oauth2/register`) {
          return jsonResponse({ client_id: "client_new", client_secret: "secret_new" });
        }
        if (url === `${DEPLOYMENT_URL}/oauth2/tokens`) {
          return jsonResponse({
            access_token: "at_rollback_fail",
            refresh_token: "rt_rollback_fail",
            expires_in: 86400,
            token_type: "Bearer",
          });
        }
        if (url === `${DEPLOYMENT_URL}/oauth2/revoke`) {
          revokedTokens.push(new URLSearchParams(fetchBodyText(init)).get("token") ?? "");
          return new Response(null, { status: 200 });
        }
        return new Response(`unexpected url: ${url}`, { status: 500 });
      });

      const startResult = await service.startDesktopFlow({ deploymentUrl: DEPLOYMENT_URL });
      expect(startResult.success).toBe(true);
      if (!startResult.success) return;
      const { flowId, authorizeUrl } = startResult.data;

      const callbackUrl = new URL(new URL(authorizeUrl).searchParams.get("redirect_uri")!);
      callbackUrl.searchParams.set("code", "auth_code_rollback_fail");
      callbackUrl.searchParams.set("state", flowId);
      const callbackPromise = originalFetch(callbackUrl).catch(() => null);

      await persistAppliedPromise;
      await service.cancelDesktopFlow(flowId);
      releasePersist();
      await callbackPromise;

      // The rollback was attempted and failed...
      await waitUntil(() => rollbackAttempted);
      // Give the (forbidden) revocation every chance to fire before asserting.
      await new Promise((resolve) => setTimeout(resolve, 50));
      // ...so the tokens stay UNREVOKED: they are still the persisted
      // credential, and the stored account keeps working.
      expect(revokedTokens).toEqual([]);
      const coderSection = deps.providersConfig.coder as Record<string, unknown>;
      expect((coderSection.coderOauth as CoderOauthAuth).access).toBe("at_rollback_fail");
      expect((coderSection.coderOauth as CoderOauthAuth).refresh).toBe("rt_rollback_fail");
    });

    it("disconnect cancels an in-flight re-login so it cannot commit afterwards", async () => {
      // Regression: disconnect must be authoritative over outstanding login
      // flows. A re-login that already exchanged its code (its persist is
      // waiting on the providers-file lock) must not commit a replacement
      // login after the user disconnected — that would silently reconnect
      // the account. disconnect() cancels active flows first, so the raced
      // flow's in-lock liveness check rejects its persist.
      const priorAuth = validAuth({
        sessionId: "session_prior",
        access: "at_prior",
        refresh: "rt_prior",
      });
      deps.providersConfig = {
        coder: {
          deploymentUrl: DEPLOYMENT_URL,
          coderOauth: priorAuth,
        },
      };

      // Gate only the FIRST section mutation (the re-login's persist); the
      // disconnect's clear must pass straight through while it is blocked.
      let releasePersist!: () => void;
      const persistGate = new Promise<void>((resolve) => (releasePersist = resolve));
      let persistStarted!: () => void;
      const persistStartedPromise = new Promise<void>((resolve) => (persistStarted = resolve));
      let sectionCalls = 0;

      const gatedProviderService = {
        ...createMockProviderService(deps),
        updateProviderSection: async (
          provider: string,
          update: (
            section: Record<string, unknown> | undefined
          ) => { value: Record<string, unknown> } | null
        ) => {
          if (++sectionCalls === 1) {
            persistStarted();
            await persistGate;
          }
          return mockUpdateProviderSection(deps, provider, update);
        },
      };
      service = new CoderOauthService(
        createMockProvidersConfigStore(deps) as ProvidersConfigStore,
        createMockFileLeaseManager(deps) as FileLeaseManager,
        gatedProviderService as ProviderService,
        createMockWindowService(deps) as WindowService
      );

      const revokedTokens: string[] = [];
      mockFetch(async (input, init) => {
        const url = fetchUrl(input);
        if (url.startsWith("http://127.0.0.1")) {
          return originalFetch(input, init);
        }
        if (url === `${DEPLOYMENT_URL}/api/v2/buildinfo`) {
          return jsonResponse({ version: "v2.99.0" });
        }
        if (url === `${DEPLOYMENT_URL}/.well-known/oauth-authorization-server`) {
          return discoveryResponse();
        }
        if (url === `${DEPLOYMENT_URL}/oauth2/clients/client_test` && init?.method === "PUT") {
          return jsonResponse({ client_id: "client_test" });
        }
        if (url === `${DEPLOYMENT_URL}/oauth2/tokens`) {
          return jsonResponse({
            access_token: "at_relogin",
            refresh_token: "rt_relogin",
            expires_in: 86400,
            token_type: "Bearer",
          });
        }
        if (url === `${DEPLOYMENT_URL}/oauth2/revoke`) {
          revokedTokens.push(new URLSearchParams(fetchBodyText(init)).get("token") ?? "");
          return new Response(null, { status: 200 });
        }
        return new Response(`unexpected url: ${url}`, { status: 500 });
      });

      const startResult = await service.startDesktopFlow({ deploymentUrl: DEPLOYMENT_URL });
      expect(startResult.success).toBe(true);
      if (!startResult.success) return;
      const { flowId, authorizeUrl } = startResult.data;

      const callbackUrl = new URL(new URL(authorizeUrl).searchParams.get("redirect_uri")!);
      callbackUrl.searchParams.set("code", "auth_code_disconnect_race");
      callbackUrl.searchParams.set("state", flowId);
      const callbackPromise = originalFetch(callbackUrl).catch(() => null);

      // The re-login's persist is now blocked mid-commit; disconnect.
      await persistStartedPromise;
      const disconnectResult = await service.disconnect();
      expect(disconnectResult.success).toBe(true);
      releasePersist();
      await callbackPromise;

      // The raced re-login's tokens are revoked (it must not stay alive)...
      await waitUntil(() => revokedTokens.includes("rt_relogin"));
      // ...alongside the disconnected prior credential.
      expect(revokedTokens).toContain("rt_prior");
      // And the account STAYS disconnected: no silent reconnect.
      const coderSection = deps.providersConfig.coder as Record<string, unknown>;
      expect(coderSection.coderOauth).toBeUndefined();
      // The cancelled flow resolves as an error for any waiter.
      const waitResult = await service.waitForDesktopFlow(flowId, { timeoutMs: 1000 });
      expect(waitResult.success).toBe(false);
    });

    it("disconnect aborts a login attempt still in its pre-registration probes", async () => {
      // Regression: cancelAll() only sees REGISTERED flows. An attempt still
      // awaiting validateDeployment/discoverEndpoints has no flow entry (and
      // disconnect does not know its caller-generated ID), so without the
      // disconnect-generation check it would resume after the credentials
      // were cleared, register normally, and could later commit a
      // replacement login — silently reconnecting the account.
      const priorAuth = validAuth({
        sessionId: "session_prior",
        access: "at_prior",
        refresh: "rt_prior",
      });
      deps.providersConfig = {
        coder: { deploymentUrl: DEPLOYMENT_URL, coderOauth: priorAuth },
      };

      // Gate the buildinfo probe so disconnect deterministically lands in
      // the pre-registration window.
      let releaseProbe!: () => void;
      const probeGate = new Promise<void>((resolve) => (releaseProbe = resolve));
      let probeStarted!: () => void;
      const probeStartedPromise = new Promise<void>((resolve) => (probeStarted = resolve));
      const revokedTokens: string[] = [];

      mockFetch(async (input, init) => {
        const url = fetchUrl(input);
        if (url === `${DEPLOYMENT_URL}/api/v2/buildinfo`) {
          probeStarted();
          await probeGate;
          return jsonResponse({ version: "v2.99.0" });
        }
        if (url === `${DEPLOYMENT_URL}/.well-known/oauth-authorization-server`) {
          return discoveryResponse();
        }
        if (url === `${DEPLOYMENT_URL}/oauth2/clients/client_test` && init?.method === "PUT") {
          return jsonResponse({ client_id: "client_test" });
        }
        if (url === `${DEPLOYMENT_URL}/oauth2/register`) {
          return jsonResponse({ client_id: "client_fresh", client_secret: "secret_fresh" });
        }
        if (url === `${DEPLOYMENT_URL}/oauth2/revoke`) {
          revokedTokens.push(new URLSearchParams(fetchBodyText(init)).get("token") ?? "");
          return new Response(null, { status: 200 });
        }
        return new Response(`unexpected url: ${url}`, { status: 500 });
      });

      const startPromise = service.startDesktopFlow({ deploymentUrl: DEPLOYMENT_URL });
      await probeStartedPromise;

      const disconnectResult = await service.disconnect();
      expect(disconnectResult.success).toBe(true);
      expect(revokedTokens).toContain("rt_prior");

      releaseProbe();
      const startResult = await startPromise;

      // The resumed attempt observes the disconnect and aborts — it never
      // opens a listener or hands out an authorize URL.
      expect(startResult.success).toBe(false);
      if (!startResult.success) {
        expect(startResult.error).toContain("cancelled");
      }
      // And the account stays disconnected.
      expect(
        (deps.providersConfig.coder as Record<string, unknown> | undefined)?.coderOauth
      ).toBeUndefined();
    });

    it("keeps the original login when two overlapping logins are both cancelled", async () => {
      // Regression: rollback snapshots must not compose across overlapping
      // flows. Without commit serialization, flow B snapshots flow A's
      // persisted-but-uncommitted login as its "previous section"; cancelling
      // A then B revokes A's tokens yet restores them over the original
      // login. The commit lock keeps B out of the persist->commit window
      // while A is mid-commit, so the original login must survive both
      // cancellations and both raced token sets must be revoked.
      const priorAuth = validAuth({
        sessionId: "session_prior",
        access: "at_prior",
        refresh: "rt_prior",
      });
      deps.providersConfig = {
        coder: {
          deploymentUrl: DEPLOYMENT_URL,
          coderOauth: priorAuth,
          models: ["anthropic/prior-model"],
        },
      };

      // Gate the first two section mutations AFTER their write lands so
      // cancellation deterministically hits the persist->commit window;
      // later mutations (rollbacks) pass straight through once released.
      const releases: Array<() => void> = [];
      const gates: Array<Promise<void>> = [
        new Promise<void>((resolve) => releases.push(resolve)),
        new Promise<void>((resolve) => releases.push(resolve)),
      ];
      let firstPersistApplied!: () => void;
      const firstPersistAppliedPromise = new Promise<void>(
        (resolve) => (firstPersistApplied = resolve)
      );
      let sectionCalls = 0;

      const gatedProviderService = {
        ...createMockProviderService(deps),
        updateProviderSection: async (
          provider: string,
          update: (
            section: Record<string, unknown> | undefined
          ) => { value: Record<string, unknown> } | null
        ) => {
          const call = ++sectionCalls;
          const result = await mockUpdateProviderSection(deps, provider, update);
          if (call === 1) {
            firstPersistApplied();
          }
          if (call <= gates.length) {
            await gates[call - 1];
          }
          return result;
        },
      };
      service = new CoderOauthService(
        createMockProvidersConfigStore(deps) as ProvidersConfigStore,
        createMockFileLeaseManager(deps) as FileLeaseManager,
        gatedProviderService as ProviderService,
        createMockWindowService(deps) as WindowService
      );

      const servedCodes = new Set<string>();
      const revokedTokens: string[] = [];

      mockFetch(async (input, init) => {
        const url = fetchUrl(input);
        if (url.startsWith("http://127.0.0.1")) {
          return originalFetch(input, init);
        }
        if (url === `${DEPLOYMENT_URL}/api/v2/buildinfo`) {
          return jsonResponse({ version: "v2.99.0" });
        }
        if (url === `${DEPLOYMENT_URL}/.well-known/oauth-authorization-server`) {
          return discoveryResponse();
        }
        if (url === `${DEPLOYMENT_URL}/oauth2/clients/client_test` && init?.method === "PUT") {
          return jsonResponse({ client_id: "client_test" });
        }
        // The second overlapping flow registers a fresh client instead of
        // updating the stored one (stored-client reservation).
        if (url === `${DEPLOYMENT_URL}/oauth2/register`) {
          return jsonResponse({ client_id: "client_fresh", client_secret: "secret_fresh" });
        }
        if (url === `${DEPLOYMENT_URL}/oauth2/tokens`) {
          const body = new URLSearchParams(fetchBodyText(init));
          const code = body.get("code") ?? "";
          servedCodes.add(code);
          const suffix = code === "code_flow1" ? "flow1" : "flow2";
          return jsonResponse({
            access_token: `at_${suffix}`,
            refresh_token: `rt_${suffix}`,
            expires_in: 86400,
            token_type: "Bearer",
          });
        }
        if (url === `${DEPLOYMENT_URL}/oauth2/revoke`) {
          revokedTokens.push(new URLSearchParams(fetchBodyText(init)).get("token") ?? "");
          return new Response(null, { status: 200 });
        }
        return new Response(`unexpected url: ${url}`, { status: 500 });
      });

      const start1 = await service.startDesktopFlow({ deploymentUrl: DEPLOYMENT_URL });
      const start2 = await service.startDesktopFlow({ deploymentUrl: DEPLOYMENT_URL });
      expect(start1.success && start2.success).toBe(true);
      if (!start1.success || !start2.success) return;

      const callbackFor = (authorizeUrl: string, state: string, code: string): URL => {
        const cb = new URL(new URL(authorizeUrl).searchParams.get("redirect_uri")!);
        cb.searchParams.set("code", code);
        cb.searchParams.set("state", state);
        return cb;
      };

      // Flow 1 persists its login and blocks mid-commit (gate 1).
      const cb1 = originalFetch(
        callbackFor(start1.data.authorizeUrl, start1.data.flowId, "code_flow1")
      ).catch(() => null);
      await firstPersistAppliedPromise;

      // Flow 2 exchanges its code; its commit then queues behind the lock.
      const cb2 = originalFetch(
        callbackFor(start2.data.authorizeUrl, start2.data.flowId, "code_flow2")
      ).catch(() => null);
      await waitUntil(() => servedCodes.has("code_flow2"));

      // Cancel both flows in order, then let the gated commits proceed.
      await service.cancelDesktopFlow(start1.data.flowId);
      await service.cancelDesktopFlow(start2.data.flowId);
      for (const release of releases) release();
      await Promise.all([cb1, cb2]);

      // Both raced logins' tokens are revoked...
      await waitUntil(
        () => revokedTokens.includes("rt_flow1") && revokedTokens.includes("rt_flow2")
      );
      // ...and the ORIGINAL login survives (not flow1's revoked tokens).
      const coderSection = deps.providersConfig.coder as Record<string, unknown>;
      expect((coderSection.coderOauth as CoderOauthAuth).access).toBe("at_prior");
      expect((coderSection.coderOauth as CoderOauthAuth).refresh).toBe("rt_prior");
      expect(coderSection.deploymentUrl).toBe(DEPLOYMENT_URL);
      expect(coderSection.models).toEqual(["anthropic/prior-model"]);
    });

    it("keeps the original login when overlapping logins in two processes are both cancelled", async () => {
      // Cross-process variant of the previous test: the rollback-snapshot
      // composure bug is not confined to one CoderOauthService instance —
      // process B persisting while process A is mid-commit captures A's
      // uncommitted auth as its previousSection just the same. The shared
      // commit lock must keep B's persist out of A's persist->commit window,
      // so the original login survives both cancellations.
      const priorAuth = validAuth({
        sessionId: "session_prior",
        access: "at_prior",
        refresh: "rt_prior",
      });
      deps.providersConfig = {
        coder: {
          deploymentUrl: DEPLOYMENT_URL,
          coderOauth: priorAuth,
          models: ["anthropic/prior-model"],
        },
      };

      const sharedCommitLock = createSharedCrossProcessLock();

      // Per-process provider services: process A's first section write is
      // gated AFTER it lands so A pauses inside its commit critical section;
      // process B's first write is gated the same way (only reached when the
      // shared lock is absent — under the fix B never persists at all).
      let releaseA!: () => void;
      const gateA = new Promise<void>((resolve) => (releaseA = resolve));
      let persistAApplied!: () => void;
      const persistAAppliedPromise = new Promise<void>((resolve) => (persistAApplied = resolve));
      let releaseB!: () => void;
      const gateB = new Promise<void>((resolve) => (releaseB = resolve));
      let sectionCallsA = 0;
      let sectionCallsB = 0;

      const makeProcess = (
        who: "A" | "B"
      ): { service: CoderOauthService; sectionCalls: () => number } => {
        const gatedProviderService = {
          ...createMockProviderService(deps),
          updateProviderSection: async (
            provider: string,
            update: (
              section: Record<string, unknown> | undefined
            ) => { value: Record<string, unknown> } | null
          ) => {
            const call = who === "A" ? ++sectionCallsA : ++sectionCallsB;
            const result = await mockUpdateProviderSection(deps, provider, update);
            if (who === "A" && call === 1) {
              persistAApplied();
              await gateA;
            }
            if (who === "B" && call === 1) {
              await gateB;
            }
            return result;
          },
        };
        const service = new CoderOauthService(
          createMockProvidersConfigStore(deps) as ProvidersConfigStore,
          createMockFileLeaseManager(deps, {
            withCoderOauthLoginCommitLock: sharedCommitLock,
          }) as FileLeaseManager,
          gatedProviderService as unknown as ProviderService,
          createMockWindowService(deps) as WindowService
        );
        return { service, sectionCalls: () => (who === "A" ? sectionCallsA : sectionCallsB) };
      };
      const processA = makeProcess("A");
      const processB = makeProcess("B");

      const servedCodes = new Set<string>();
      const revokedTokens: string[] = [];

      mockFetch(async (input, init) => {
        const url = fetchUrl(input);
        if (url.startsWith("http://127.0.0.1")) {
          return originalFetch(input, init);
        }
        if (url === `${DEPLOYMENT_URL}/api/v2/buildinfo`) {
          return jsonResponse({ version: "v2.99.0" });
        }
        if (url === `${DEPLOYMENT_URL}/.well-known/oauth-authorization-server`) {
          return discoveryResponse();
        }
        if (url === `${DEPLOYMENT_URL}/oauth2/clients/client_test` && init?.method === "PUT") {
          return jsonResponse({ client_id: "client_test" });
        }
        // Whichever process misses the client lease registers fresh.
        if (url === `${DEPLOYMENT_URL}/oauth2/register`) {
          return jsonResponse({ client_id: "client_fresh", client_secret: "secret_fresh" });
        }
        if (url === `${DEPLOYMENT_URL}/oauth2/tokens`) {
          const body = new URLSearchParams(fetchBodyText(init));
          const code = body.get("code") ?? "";
          servedCodes.add(code);
          const suffix = code === "code_flow1" ? "flow1" : "flow2";
          return jsonResponse({
            access_token: `at_${suffix}`,
            refresh_token: `rt_${suffix}`,
            expires_in: 86400,
            token_type: "Bearer",
          });
        }
        if (url === `${DEPLOYMENT_URL}/oauth2/revoke`) {
          revokedTokens.push(new URLSearchParams(fetchBodyText(init)).get("token") ?? "");
          return new Response(null, { status: 200 });
        }
        return new Response(`unexpected url: ${url}`, { status: 500 });
      });

      const start1 = await processA.service.startDesktopFlow({ deploymentUrl: DEPLOYMENT_URL });
      const start2 = await processB.service.startDesktopFlow({ deploymentUrl: DEPLOYMENT_URL });
      expect(start1.success && start2.success).toBe(true);
      if (!start1.success || !start2.success) return;

      const callbackFor = (authorizeUrl: string, state: string, code: string): URL => {
        const cb = new URL(new URL(authorizeUrl).searchParams.get("redirect_uri")!);
        cb.searchParams.set("code", code);
        cb.searchParams.set("state", state);
        return cb;
      };

      // Process A persists its login and blocks mid-commit.
      const cb1 = originalFetch(
        callbackFor(start1.data.authorizeUrl, start1.data.flowId, "code_flow1")
      ).catch(() => null);
      await persistAAppliedPromise;

      // Process B exchanges its code; its commit must queue on the shared
      // lock — it must NOT persist while A is mid-commit.
      const cb2 = originalFetch(
        callbackFor(start2.data.authorizeUrl, start2.data.flowId, "code_flow2")
      ).catch(() => null);
      await waitUntil(() => servedCodes.has("code_flow2"));
      await new Promise((resolve) => setTimeout(resolve, 25));
      expect(processB.sectionCalls()).toBe(0);

      // Cancel both flows in order, then release the gates.
      await processA.service.cancelDesktopFlow(start1.data.flowId);
      await processB.service.cancelDesktopFlow(start2.data.flowId);
      releaseA();
      releaseB();
      await Promise.all([cb1, cb2]);

      // Both raced logins' tokens are revoked...
      await waitUntil(
        () => revokedTokens.includes("rt_flow1") && revokedTokens.includes("rt_flow2")
      );
      // ...and the ORIGINAL login survives — B never restored A's revoked
      // auth over it.
      const coderSection = deps.providersConfig.coder as Record<string, unknown>;
      expect((coderSection.coderOauth as CoderOauthAuth).access).toBe("at_prior");
      expect((coderSection.coderOauth as CoderOauthAuth).refresh).toBe("rt_prior");
      expect(coderSection.deploymentUrl).toBe(DEPLOYMENT_URL);
      expect(coderSection.models).toEqual(["anthropic/prior-model"]);

      await processA.service.dispose();
      await processB.service.dispose();
    });

    it("aborts a stalled client registration when the flow ends", async () => {
      // The registration endpoint accepts the connection but never responds.
      // The flow is registered BEFORE that await, so ending the flow
      // (cancel/timeout/shutdown) aborts the in-flight RPC instead of leaving
      // the loopback listener and request pinned until the network gives up.
      let registerStarted!: () => void;
      const registerStartedPromise = new Promise<void>((resolve) => (registerStarted = resolve));
      let registerAborted = false;

      mockFetch((input, init) => {
        const url = fetchUrl(input);
        if (url === `${DEPLOYMENT_URL}/api/v2/buildinfo`) {
          return Promise.resolve(jsonResponse({ version: "v2.99.0" }));
        }
        if (url === `${DEPLOYMENT_URL}/.well-known/oauth-authorization-server`) {
          return Promise.resolve(discoveryResponse());
        }
        if (url === `${DEPLOYMENT_URL}/oauth2/register`) {
          registerStarted();
          return new Promise<Response>((_resolve, reject) => {
            init?.signal?.addEventListener("abort", () => {
              registerAborted = true;
              reject(new Error("The operation was aborted"));
            });
          });
        }
        return Promise.resolve(new Response(`unexpected url: ${url}`, { status: 500 }));
      });

      const startPromise = service.startDesktopFlow({ deploymentUrl: DEPLOYMENT_URL });
      await registerStartedPromise;

      // Shutdown stands in for any flow-ending event (cancel/timeout): it
      // finishes the registered flow, which must abort the stalled RPC.
      await service.dispose();

      const startResult = await startPromise;
      expect(registerAborted).toBe(true);
      expect(startResult.success).toBe(false);
      if (!startResult.success) {
        expect(startResult.error).toContain("registration failed");
      }
    });

    it("lets Cancel reach a stalled client registration via the caller-supplied flow ID", async () => {
      // The UI generates the flow ID before calling startDesktopFlow, so its
      // Cancel action can target the attempt even though start has not
      // returned yet. Cancelling that ID must abort the in-flight
      // registration RPC (and close the loopback listener), not just abandon
      // the frontend state until the five-minute flow timeout.
      const flowId = "ui-generated-flow-id-123";
      let registerStarted!: () => void;
      const registerStartedPromise = new Promise<void>((resolve) => (registerStarted = resolve));
      let registerAborted = false;

      mockFetch((input, init) => {
        const url = fetchUrl(input);
        if (url === `${DEPLOYMENT_URL}/api/v2/buildinfo`) {
          return Promise.resolve(jsonResponse({ version: "v2.99.0" }));
        }
        if (url === `${DEPLOYMENT_URL}/.well-known/oauth-authorization-server`) {
          return Promise.resolve(discoveryResponse());
        }
        if (url === `${DEPLOYMENT_URL}/oauth2/register`) {
          registerStarted();
          return new Promise<Response>((_resolve, reject) => {
            init?.signal?.addEventListener("abort", () => {
              registerAborted = true;
              reject(new Error("The operation was aborted"));
            });
          });
        }
        return Promise.resolve(new Response(`unexpected url: ${url}`, { status: 500 }));
      });

      const startPromise = service.startDesktopFlow({ deploymentUrl: DEPLOYMENT_URL, flowId });
      await registerStartedPromise;

      // The user's Cancel action: the flow is registered by now, so this
      // cancels it directly, which aborts the registration RPC.
      await service.cancelDesktopFlow(flowId);

      const startResult = await startPromise;
      expect(registerAborted).toBe(true);
      expect(startResult.success).toBe(false);
    });

    it("honors a Cancel that lands while the deployment probes are still in flight", async () => {
      // Before the flow is registered (buildinfo/discovery probes), Cancel
      // records a pre-cancellation; startDesktopFlow must consume it at its
      // next checkpoint and abort instead of continuing as an orphan attempt.
      const flowId = "ui-generated-flow-id-456";
      let probeStarted!: () => void;
      const probeStartedPromise = new Promise<void>((resolve) => (probeStarted = resolve));
      let releaseProbe!: () => void;
      const probeGate = new Promise<void>((resolve) => (releaseProbe = resolve));
      let registrationAttempted = false;

      mockFetch(async (input) => {
        const url = fetchUrl(input);
        if (url === `${DEPLOYMENT_URL}/api/v2/buildinfo`) {
          probeStarted();
          await probeGate;
          return jsonResponse({ version: "v2.99.0" });
        }
        if (url === `${DEPLOYMENT_URL}/.well-known/oauth-authorization-server`) {
          return discoveryResponse();
        }
        if (url === `${DEPLOYMENT_URL}/oauth2/register`) {
          registrationAttempted = true;
          return jsonResponse({ client_id: "client_fresh", client_secret: "secret_fresh" });
        }
        return new Response(`unexpected url: ${url}`, { status: 500 });
      });

      const startPromise = service.startDesktopFlow({ deploymentUrl: DEPLOYMENT_URL, flowId });
      await probeStartedPromise;
      await service.cancelDesktopFlow(flowId); // Flow not registered yet -> pre-cancel.
      releaseProbe();

      const startResult = await startPromise;
      expect(startResult.success).toBe(false);
      if (!startResult.success) {
        expect(startResult.error).toContain("cancelled");
      }
      // The attempt aborted before touching the registration endpoint.
      expect(registrationAttempted).toBe(false);
    });

    it("aborts a stalled token exchange when the flow is cancelled", async () => {
      // The token endpoint accepts the connection but never responds. The
      // exchange carries the flow's abort signal, so Cancel (or the flow
      // timeout) must kill the in-flight round-trip instead of leaking it as
      // a background request for up to the request timeout.
      let exchangeStarted!: () => void;
      const exchangeStartedPromise = new Promise<void>((resolve) => (exchangeStarted = resolve));
      let exchangeAborted = false;

      mockFetch((input, init) => {
        const url = fetchUrl(input);
        if (url.startsWith("http://127.0.0.1")) {
          return originalFetch(input, init);
        }
        if (url === `${DEPLOYMENT_URL}/api/v2/buildinfo`) {
          return Promise.resolve(jsonResponse({ version: "v2.99.0" }));
        }
        if (url === `${DEPLOYMENT_URL}/.well-known/oauth-authorization-server`) {
          return Promise.resolve(discoveryResponse());
        }
        if (url === `${DEPLOYMENT_URL}/oauth2/register`) {
          return Promise.resolve(
            jsonResponse({ client_id: "client_fresh", client_secret: "secret_fresh" })
          );
        }
        if (url === `${DEPLOYMENT_URL}/oauth2/tokens`) {
          exchangeStarted();
          return new Promise<Response>((_resolve, reject) => {
            init?.signal?.addEventListener("abort", () => {
              exchangeAborted = true;
              reject(new Error("The operation was aborted"));
            });
          });
        }
        return Promise.resolve(new Response(`unexpected url: ${url}`, { status: 500 }));
      });

      const start = await service.startDesktopFlow({ deploymentUrl: DEPLOYMENT_URL });
      expect(start.success).toBe(true);
      if (!start.success) return;

      const callbackUrl = new URL(
        new URL(start.data.authorizeUrl).searchParams.get("redirect_uri")!
      );
      callbackUrl.searchParams.set("code", "code_stalled");
      callbackUrl.searchParams.set("state", start.data.flowId);
      const callbackPromise = originalFetch(callbackUrl).catch(() => null);

      await exchangeStartedPromise;
      await service.cancelDesktopFlow(start.data.flowId);
      await callbackPromise;

      await waitUntil(() => exchangeAborted);
      // Nothing was persisted for the aborted exchange.
      expect(deps.providersConfig.coder?.coderOauth).toBeUndefined();
    });

    it("registers a fresh client when another process holds the stored-client lease", async () => {
      // The stored-client reservation is a cross-process filesystem lease:
      // a concurrent login flow in ANOTHER Xum process sharing providers.jsonc
      // would clobber the stored client's single redirect slot just like an
      // in-process one. When the lease is unavailable, the flow must fall
      // back to a fresh client and leave the stored client untouched.
      deps.providersConfig = {
        coder: { deploymentUrl: DEPLOYMENT_URL, coderOauth: validAuth() },
      };
      deps.coderClientLeaseHeld = true; // Held by "another process".

      let putAttempted = false;
      mockFetch((input, init) => {
        const url = fetchUrl(input);
        if (url === `${DEPLOYMENT_URL}/api/v2/buildinfo`) {
          return Promise.resolve(jsonResponse({ version: "v2.99.0" }));
        }
        if (url === `${DEPLOYMENT_URL}/.well-known/oauth-authorization-server`) {
          return Promise.resolve(discoveryResponse());
        }
        if (url === `${DEPLOYMENT_URL}/oauth2/clients/client_test` && init?.method === "PUT") {
          putAttempted = true;
          return Promise.resolve(jsonResponse({ client_id: "client_test" }));
        }
        if (url === `${DEPLOYMENT_URL}/oauth2/register`) {
          return Promise.resolve(
            jsonResponse({ client_id: "client_fresh", client_secret: "secret_fresh" })
          );
        }
        return Promise.resolve(new Response(`unexpected url: ${url}`, { status: 500 }));
      });

      const start = await service.startDesktopFlow({ deploymentUrl: DEPLOYMENT_URL });
      expect(start.success).toBe(true);
      if (!start.success) return;

      expect(putAttempted).toBe(false);
      expect(new URL(start.data.authorizeUrl).searchParams.get("client_id")).toBe("client_fresh");

      await service.cancelDesktopFlow(start.data.flowId);
      // The foreign lease is not released by this process's flow teardown.
      expect(deps.coderClientLeaseHeld).toBe(true);
    });

    it("retains the stored-client lease until a cancelled flow's redirect update settles", async () => {
      // Aborting a fetch does not retract a PUT the deployment may still
      // commit: if Cancel released the lease while the redirect update was in
      // flight, a replacement flow could acquire it and write redirect B
      // before the cancelled flow's delayed update lands with redirect A —
      // invalidating the replacement's authorization URL. The lease must be
      // held until the update settles.
      deps.providersConfig = {
        coder: { deploymentUrl: DEPLOYMENT_URL, coderOauth: validAuth() },
      };

      let releasePut!: (response: Response) => void;
      const putGate = new Promise<Response>((resolve) => (releasePut = resolve));
      let putStarted = false;
      mockFetch((input, init) => {
        const url = fetchUrl(input);
        if (url === `${DEPLOYMENT_URL}/api/v2/buildinfo`) {
          return Promise.resolve(jsonResponse({ version: "v2.99.0" }));
        }
        if (url === `${DEPLOYMENT_URL}/.well-known/oauth-authorization-server`) {
          return Promise.resolve(discoveryResponse());
        }
        if (url === `${DEPLOYMENT_URL}/oauth2/clients/client_test` && init?.method === "PUT") {
          putStarted = true;
          return putGate;
        }
        return Promise.resolve(new Response(`unexpected url: ${url}`, { status: 500 }));
      });

      const flowId = "flow_lease_settle_test";
      const startPromise = service.startDesktopFlow({ deploymentUrl: DEPLOYMENT_URL, flowId });
      await waitUntil(() => putStarted);

      // Cancel completes while the PUT is still in flight...
      await service.cancelDesktopFlow(flowId);
      // ...and the lease is NOT released yet: the mutation may still land.
      expect(deps.coderClientLeaseHeld).toBe(true);

      // Once the update settles with a definitive answer, the lease releases.
      releasePut(jsonResponse({ client_id: "client_test" }));
      const start = await startPromise;
      expect(start.success).toBe(false);
      await waitUntil(() => !deps.coderClientLeaseHeld);
    });

    it("keeps the stored-client lease reserved when the redirect update outcome is uncertain", async () => {
      // A PUT that fails without a server response (timeout / connection
      // error) may STILL be committed by the deployment later. Releasing the
      // lease on flow completion would let a replacement flow race that
      // orphaned mutation for the redirect slot — instead the lease is left
      // to expire via its stale TTL, and other flows register fresh clients.
      deps.providersConfig = {
        coder: { deploymentUrl: DEPLOYMENT_URL, coderOauth: validAuth() },
      };

      mockFetch((input, init) => {
        const url = fetchUrl(input);
        if (url === `${DEPLOYMENT_URL}/api/v2/buildinfo`) {
          return Promise.resolve(jsonResponse({ version: "v2.99.0" }));
        }
        if (url === `${DEPLOYMENT_URL}/.well-known/oauth-authorization-server`) {
          return Promise.resolve(discoveryResponse());
        }
        if (url === `${DEPLOYMENT_URL}/oauth2/clients/client_test` && init?.method === "PUT") {
          return Promise.reject(new TypeError("fetch failed"));
        }
        if (url === `${DEPLOYMENT_URL}/oauth2/register`) {
          return Promise.resolve(
            jsonResponse({ client_id: "client_fresh", client_secret: "secret_fresh" })
          );
        }
        return Promise.resolve(new Response(`unexpected url: ${url}`, { status: 500 }));
      });

      // The flow itself degrades to a fresh client and proceeds.
      const start = await service.startDesktopFlow({ deploymentUrl: DEPLOYMENT_URL });
      expect(start.success).toBe(true);
      if (!start.success) return;
      expect(new URL(start.data.authorizeUrl).searchParams.get("client_id")).toBe("client_fresh");

      await service.cancelDesktopFlow(start.data.flowId);
      // The lease is released only after the uncertain client generation is
      // QUARANTINED in the persisted blob: the orphaned PUT may land at any
      // later time, so the stored client's RFC 7592 fields must be gone
      // before any flow may reuse the redirect slot.
      await waitUntil(() => !deps.coderClientLeaseHeld);
      const storedAuth = (deps.providersConfig.coder as Record<string, unknown>)
        .coderOauth as Record<string, unknown>;
      expect(storedAuth.registrationAccessToken).toBeUndefined();
      expect(storedAuth.registrationClientUri).toBeUndefined();
      // The credential itself survives — only client reuse is disabled.
      expect(storedAuth.clientId).toBe("client_test");
      expect(storedAuth.refresh).toBeDefined();

      // A follow-up login registers a fresh client (no PUT to the
      // quarantined one) instead of racing the orphaned update.
      const secondStart = await service.startDesktopFlow({ deploymentUrl: DEPLOYMENT_URL });
      expect(secondStart.success).toBe(true);
      if (!secondStart.success) return;
      expect(new URL(secondStart.data.authorizeUrl).searchParams.get("client_id")).toBe(
        "client_fresh"
      );
      await service.cancelDesktopFlow(secondStart.data.flowId);
    });

    it("quarantines the stored client when the redirect update returns an ambiguous 5xx", async () => {
      // Regression: a reverse proxy can answer 502/504 AFTER forwarding the
      // PUT (and a server can fail after committing), so a 5xx response is
      // just as ambiguous as no response at all — the upstream mutation may
      // still land later. Treating it as definitive released the lease
      // without quarantining, letting the delayed update overwrite a
      // subsequent login's redirect URI on the same client.
      deps.providersConfig = {
        coder: { deploymentUrl: DEPLOYMENT_URL, coderOauth: validAuth() },
      };

      mockFetch((input, init) => {
        const url = fetchUrl(input);
        if (url === `${DEPLOYMENT_URL}/api/v2/buildinfo`) {
          return Promise.resolve(jsonResponse({ version: "v2.99.0" }));
        }
        if (url === `${DEPLOYMENT_URL}/.well-known/oauth-authorization-server`) {
          return Promise.resolve(discoveryResponse());
        }
        if (url === `${DEPLOYMENT_URL}/oauth2/clients/client_test` && init?.method === "PUT") {
          return Promise.resolve(new Response("bad gateway", { status: 502 }));
        }
        if (url === `${DEPLOYMENT_URL}/oauth2/register`) {
          return Promise.resolve(
            jsonResponse({ client_id: "client_fresh", client_secret: "secret_fresh" })
          );
        }
        return Promise.resolve(new Response(`unexpected url: ${url}`, { status: 500 }));
      });

      // The flow degrades to a fresh client and proceeds.
      const start = await service.startDesktopFlow({ deploymentUrl: DEPLOYMENT_URL });
      expect(start.success).toBe(true);
      if (!start.success) return;
      expect(new URL(start.data.authorizeUrl).searchParams.get("client_id")).toBe("client_fresh");

      await service.cancelDesktopFlow(start.data.flowId);
      // Same treatment as the no-response path: the stored client's RFC 7592
      // fields must be quarantined before the lease is released.
      await waitUntil(() => !deps.coderClientLeaseHeld);
      const storedAuth = (deps.providersConfig.coder as Record<string, unknown>)
        .coderOauth as Record<string, unknown>;
      expect(storedAuth.registrationAccessToken).toBeUndefined();
      expect(storedAuth.registrationClientUri).toBeUndefined();
      // The credential itself survives — only client reuse is disabled.
      expect(storedAuth.clientId).toBe("client_test");
    });

    it("does not quarantine the stored client on an authoritative 4xx refusal", async () => {
      // A 4xx is a definitive server decision that provably left the
      // registration unchanged; quarantining would needlessly discard the
      // stored client's RFC 7592 fields on every transient auth hiccup.
      deps.providersConfig = {
        coder: { deploymentUrl: DEPLOYMENT_URL, coderOauth: validAuth() },
      };

      mockFetch((input, init) => {
        const url = fetchUrl(input);
        if (url === `${DEPLOYMENT_URL}/api/v2/buildinfo`) {
          return Promise.resolve(jsonResponse({ version: "v2.99.0" }));
        }
        if (url === `${DEPLOYMENT_URL}/.well-known/oauth-authorization-server`) {
          return Promise.resolve(discoveryResponse());
        }
        if (url === `${DEPLOYMENT_URL}/oauth2/clients/client_test` && init?.method === "PUT") {
          return Promise.resolve(new Response("unauthorized", { status: 401 }));
        }
        if (url === `${DEPLOYMENT_URL}/oauth2/register`) {
          return Promise.resolve(
            jsonResponse({ client_id: "client_fresh", client_secret: "secret_fresh" })
          );
        }
        return Promise.resolve(new Response(`unexpected url: ${url}`, { status: 500 }));
      });

      const start = await service.startDesktopFlow({ deploymentUrl: DEPLOYMENT_URL });
      expect(start.success).toBe(true);
      if (!start.success) return;

      await service.cancelDesktopFlow(start.data.flowId);
      await waitUntil(() => !deps.coderClientLeaseHeld);
      // RFC 7592 fields survive: the refusal was authoritative.
      const storedAuth = (deps.providersConfig.coder as Record<string, unknown>)
        .coderOauth as Record<string, unknown>;
      expect(storedAuth.registrationAccessToken).toBeDefined();
      expect(storedAuth.registrationClientUri).toBeDefined();
    });

    it("keeps the lease reserved when the client quarantine cannot be persisted", async () => {
      // If the quarantine write fails (providers file unwritable), the lease
      // must stay held as the fallback guard: releasing would let another
      // flow PUT the stored client while the orphaned update may still land.
      deps.providersConfig = {
        coder: { deploymentUrl: DEPLOYMENT_URL, coderOauth: validAuth() },
      };

      const failingProviderService = {
        ...createMockProviderService(deps),
        updateProviderSection: () => Promise.resolve(Err("disk full")),
      };
      service = new CoderOauthService(
        createMockProvidersConfigStore(deps) as ProvidersConfigStore,
        createMockFileLeaseManager(deps) as FileLeaseManager,
        failingProviderService as unknown as ProviderService,
        createMockWindowService(deps) as WindowService
      );

      mockFetch((input, init) => {
        const url = fetchUrl(input);
        if (url === `${DEPLOYMENT_URL}/api/v2/buildinfo`) {
          return Promise.resolve(jsonResponse({ version: "v2.99.0" }));
        }
        if (url === `${DEPLOYMENT_URL}/.well-known/oauth-authorization-server`) {
          return Promise.resolve(discoveryResponse());
        }
        if (url === `${DEPLOYMENT_URL}/oauth2/clients/client_test` && init?.method === "PUT") {
          return Promise.reject(new TypeError("fetch failed"));
        }
        if (url === `${DEPLOYMENT_URL}/oauth2/register`) {
          return Promise.resolve(
            jsonResponse({ client_id: "client_fresh", client_secret: "secret_fresh" })
          );
        }
        return Promise.resolve(new Response(`unexpected url: ${url}`, { status: 500 }));
      });

      const start = await service.startDesktopFlow({ deploymentUrl: DEPLOYMENT_URL });
      expect(start.success).toBe(true);
      if (!start.success) return;
      await service.cancelDesktopFlow(start.data.flowId);

      // Give the release handler every chance to (wrongly) fire.
      await new Promise((resolve) => setTimeout(resolve, 50));
      expect(deps.coderClientLeaseHeld).toBe(true);
    });

    it("persists the complete discovered catalog even when a policy restricts models", async () => {
      // Policies refresh remotely: a temporarily restrictive policy must not
      // carve models out of the DURABLE catalog, or they would stay
      // unroutable until the next login even after the policy broadens.
      // Policy is applied at exposure time instead (getConfig filtering,
      // routing checks, per-model factory enforcement).
      service = new CoderOauthService(
        createMockProvidersConfigStore(deps) as ProvidersConfigStore,
        createMockFileLeaseManager(deps) as FileLeaseManager,
        createMockProviderService(deps) as ProviderService,
        createMockWindowService(deps) as WindowService,
        {
          isEnforced: () => true,
          isProviderAllowed: () => true,
          getForcedBaseUrl: () => undefined,
          isModelAllowed: (_provider: string, modelId: string) =>
            modelId === "anthropic/allowed-model",
        } as unknown as PolicyService
      );

      mockFetch(async (input, init) => {
        const url = fetchUrl(input);
        if (url.startsWith("http://127.0.0.1")) {
          return originalFetch(input, init);
        }
        if (url === `${DEPLOYMENT_URL}/api/v2/buildinfo`) {
          return jsonResponse({ version: "v2.99.0" });
        }
        if (url === `${DEPLOYMENT_URL}/.well-known/oauth-authorization-server`) {
          return discoveryResponse();
        }
        if (url === `${DEPLOYMENT_URL}/oauth2/register`) {
          return jsonResponse({ client_id: "client_new", client_secret: "secret_new" });
        }
        if (url === `${DEPLOYMENT_URL}/oauth2/tokens`) {
          return jsonResponse({
            access_token: "at_policy",
            refresh_token: "rt_policy",
            expires_in: 86400,
            token_type: "Bearer",
          });
        }
        if (url === `${DEPLOYMENT_URL}/api/v2/ai/providers`) {
          return Promise.resolve(aiProvidersResponse());
        }
        if (url === `${DEPLOYMENT_URL}/api/v2/aibridge/anthropic/v1/models`) {
          return jsonResponse({ data: [{ id: "allowed-model" }, { id: "blocked-model" }] });
        }
        if (url === `${DEPLOYMENT_URL}/api/v2/aibridge/openai/v1/models`) {
          return new Response("aibridge not entitled", { status: 404 });
        }
        return new Response(`unexpected url: ${url}`, { status: 500 });
      });

      const startResult = await service.startDesktopFlow({ deploymentUrl: DEPLOYMENT_URL });
      expect(startResult.success).toBe(true);
      if (!startResult.success) return;
      const { flowId, authorizeUrl } = startResult.data;

      const waitPromise = service.waitForDesktopFlow(flowId, { timeoutMs: 5000 });
      const callbackUrl = new URL(new URL(authorizeUrl).searchParams.get("redirect_uri")!);
      callbackUrl.searchParams.set("code", "auth_code_policy");
      callbackUrl.searchParams.set("state", flowId);
      await originalFetch(callbackUrl);
      const waitResult = await waitPromise;
      expect(waitResult.success).toBe(true);

      await waitUntil(() => {
        const section = deps.providersConfig.coder as Record<string, unknown> | undefined;
        return Array.isArray(section?.discoveredModels) && section.discoveredModels.length > 0;
      });
      const coderSection = deps.providersConfig.coder as Record<string, unknown>;
      // Both models persisted — including the one the current policy blocks.
      expect(coderSection.discoveredModels).toEqual([
        "anthropic/allowed-model",
        "anthropic/blocked-model",
      ]);
      expect(coderSection.models).toEqual(["anthropic/allowed-model", "anthropic/blocked-model"]);
    });

    it("does not resurrect user-removed discovered models on re-login", async () => {
      // The user removed a discovered model in Models settings (recorded in
      // removedModels by setModels). A re-login rebuilds the catalog from the
      // deployment — which still serves that model — but the merge must honor
      // the recorded exclusion instead of resurrecting the deleted entry.
      deps.providersConfig = {
        coder: {
          deploymentUrl: DEPLOYMENT_URL,
          coderOauth: validAuth({ sessionId: "session_prior" }),
          models: ["anthropic/kept-model"],
          discoveredModels: ["anthropic/kept-model", "anthropic/removed-model"],
          removedModels: ["anthropic/removed-model"],
        },
      };

      mockFetch(async (input, init) => {
        const url = fetchUrl(input);
        if (url.startsWith("http://127.0.0.1")) {
          return originalFetch(input, init);
        }
        if (url === `${DEPLOYMENT_URL}/api/v2/buildinfo`) {
          return jsonResponse({ version: "v2.99.0" });
        }
        if (url === `${DEPLOYMENT_URL}/.well-known/oauth-authorization-server`) {
          return discoveryResponse();
        }
        if (url === `${DEPLOYMENT_URL}/oauth2/clients/client_test` && init?.method === "PUT") {
          return jsonResponse({ client_id: "client_test" });
        }
        if (url === `${DEPLOYMENT_URL}/oauth2/tokens`) {
          return jsonResponse({
            access_token: "at_removed",
            refresh_token: "rt_removed",
            expires_in: 86400,
            token_type: "Bearer",
          });
        }
        if (url === `${DEPLOYMENT_URL}/oauth2/revoke`) {
          return new Response(null, { status: 200 });
        }
        if (url === `${DEPLOYMENT_URL}/api/v2/ai/providers`) {
          return Promise.resolve(aiProvidersResponse());
        }
        if (url === `${DEPLOYMENT_URL}/api/v2/aibridge/anthropic/v1/models`) {
          return jsonResponse({ data: [{ id: "kept-model" }, { id: "removed-model" }] });
        }
        if (url === `${DEPLOYMENT_URL}/api/v2/aibridge/openai/v1/models`) {
          return new Response("aibridge not entitled", { status: 404 });
        }
        return new Response(`unexpected url: ${url}`, { status: 500 });
      });

      const startResult = await service.startDesktopFlow({ deploymentUrl: DEPLOYMENT_URL });
      expect(startResult.success).toBe(true);
      if (!startResult.success) return;
      const { flowId, authorizeUrl } = startResult.data;

      const waitPromise = service.waitForDesktopFlow(flowId, { timeoutMs: 5000 });
      const callbackUrl = new URL(new URL(authorizeUrl).searchParams.get("redirect_uri")!);
      callbackUrl.searchParams.set("code", "auth_code_removed");
      callbackUrl.searchParams.set("state", flowId);
      await originalFetch(callbackUrl);
      const waitResult = await waitPromise;
      expect(waitResult.success).toBe(true);

      await waitUntil(() => {
        const section = deps.providersConfig.coder as Record<string, unknown> | undefined;
        return Array.isArray(section?.discoveredModels) && section.discoveredModels.length > 0;
      });
      const coderSection = deps.providersConfig.coder as Record<string, unknown>;
      // The removed model stays excluded from the visible list even though
      // the fresh catalog still contains it; the exclusion itself persists.
      expect(coderSection.models).toEqual(["anthropic/kept-model"]);
      expect(coderSection.discoveredModels).toEqual([
        "anthropic/kept-model",
        "anthropic/removed-model",
      ]);
      expect(coderSection.removedModels).toEqual(["anthropic/removed-model"]);
    });

    it("preserves user-edited settings on discovered models across a re-login", async () => {
      // A discovered model the user edited in Models settings (context window
      // override / model mapping) becomes an object entry while its ID stays
      // recorded in discoveredModels. Re-login + catalog merge must keep the
      // object (user-authored data), not collapse it back to a plain string.
      deps.providersConfig = {
        coder: {
          deploymentUrl: DEPLOYMENT_URL,
          coderOauth: validAuth({ sessionId: "session_prior" }),
          models: [
            { id: "anthropic/tuned-model", contextWindowTokens: 200_000 },
            "anthropic/plain-model",
          ],
          discoveredModels: ["anthropic/tuned-model", "anthropic/plain-model"],
        },
      };

      mockFetch(async (input, init) => {
        const url = fetchUrl(input);
        if (url.startsWith("http://127.0.0.1")) {
          return originalFetch(input, init);
        }
        if (url === `${DEPLOYMENT_URL}/api/v2/buildinfo`) {
          return jsonResponse({ version: "v2.99.0" });
        }
        if (url === `${DEPLOYMENT_URL}/.well-known/oauth-authorization-server`) {
          return discoveryResponse();
        }
        if (url === `${DEPLOYMENT_URL}/oauth2/clients/client_test` && init?.method === "PUT") {
          return jsonResponse({ client_id: "client_test" });
        }
        if (url === `${DEPLOYMENT_URL}/oauth2/tokens`) {
          return jsonResponse({
            access_token: "at_tuned",
            refresh_token: "rt_tuned",
            expires_in: 86400,
            token_type: "Bearer",
          });
        }
        if (url === `${DEPLOYMENT_URL}/oauth2/revoke`) {
          return new Response(null, { status: 200 });
        }
        if (url === `${DEPLOYMENT_URL}/api/v2/ai/providers`) {
          return Promise.resolve(aiProvidersResponse());
        }
        if (url === `${DEPLOYMENT_URL}/api/v2/aibridge/anthropic/v1/models`) {
          return jsonResponse({ data: [{ id: "tuned-model" }, { id: "plain-model" }] });
        }
        if (url === `${DEPLOYMENT_URL}/api/v2/aibridge/openai/v1/models`) {
          return new Response("aibridge not entitled", { status: 404 });
        }
        return new Response(`unexpected url: ${url}`, { status: 500 });
      });

      const startResult = await service.startDesktopFlow({ deploymentUrl: DEPLOYMENT_URL });
      expect(startResult.success).toBe(true);
      if (!startResult.success) return;
      const { flowId, authorizeUrl } = startResult.data;

      const waitPromise = service.waitForDesktopFlow(flowId, { timeoutMs: 5000 });
      const callbackUrl = new URL(new URL(authorizeUrl).searchParams.get("redirect_uri")!);
      callbackUrl.searchParams.set("code", "auth_code_tuned");
      callbackUrl.searchParams.set("state", flowId);
      await originalFetch(callbackUrl);
      const waitResult = await waitPromise;
      expect(waitResult.success).toBe(true);

      await waitUntil(() => {
        const section = deps.providersConfig.coder as Record<string, unknown> | undefined;
        return Array.isArray(section?.discoveredModels) && section.discoveredModels.length > 0;
      });
      const coderSection = deps.providersConfig.coder as Record<string, unknown>;
      // The edited entry survived (ahead of the fresh catalog, no duplicate);
      // the unedited discovered entry was reset to the plain catalog string.
      expect(coderSection.models).toEqual([
        { id: "anthropic/tuned-model", contextWindowTokens: 200_000 },
        "anthropic/plain-model",
      ]);
      expect(coderSection.discoveredModels).toEqual([
        "anthropic/tuned-model",
        "anthropic/plain-model",
      ]);
    });

    it("registers a fresh client for a second overlapping flow instead of re-updating the stored one", async () => {
      // The stored dynamic client has a single redirect_uris slot: if two
      // overlapping flows both PUT-updated it, the later update would clobber
      // the earlier flow's ephemeral loopback URI and its authorize URL would
      // be rejected for a redirect mismatch. Only the first active flow may
      // reuse the stored client; overlapping flows get fresh clients. Once
      // the owner finishes, the stored client becomes reusable again.
      deps.providersConfig = {
        coder: { deploymentUrl: DEPLOYMENT_URL, coderOauth: validAuth() },
      };

      const putRedirects: string[] = [];
      const registerRedirects: string[] = [];

      mockFetch((input, init) => {
        const url = fetchUrl(input);
        if (url === `${DEPLOYMENT_URL}/api/v2/buildinfo`) {
          return Promise.resolve(jsonResponse({ version: "v2.99.0" }));
        }
        if (url === `${DEPLOYMENT_URL}/.well-known/oauth-authorization-server`) {
          return Promise.resolve(discoveryResponse());
        }
        if (url === `${DEPLOYMENT_URL}/oauth2/clients/client_test` && init?.method === "PUT") {
          const body = JSON.parse(fetchBodyText(init)) as { redirect_uris?: string[] };
          putRedirects.push(...(body.redirect_uris ?? []));
          return Promise.resolve(jsonResponse({ client_id: "client_test" }));
        }
        if (url === `${DEPLOYMENT_URL}/oauth2/register`) {
          const body = JSON.parse(fetchBodyText(init)) as { redirect_uris?: string[] };
          registerRedirects.push(...(body.redirect_uris ?? []));
          return Promise.resolve(
            jsonResponse({ client_id: "client_fresh", client_secret: "secret_fresh" })
          );
        }
        return Promise.resolve(new Response(`unexpected url: ${url}`, { status: 500 }));
      });

      const start1 = await service.startDesktopFlow({ deploymentUrl: DEPLOYMENT_URL });
      const start2 = await service.startDesktopFlow({ deploymentUrl: DEPLOYMENT_URL });
      expect(start1.success && start2.success).toBe(true);
      if (!start1.success || !start2.success) return;

      const clientIdOf = (authorizeUrl: string): string =>
        new URL(authorizeUrl).searchParams.get("client_id")!;
      const redirectOf = (authorizeUrl: string): string =>
        new URL(authorizeUrl).searchParams.get("redirect_uri")!;

      // Flow 1 owns the stored client; flow 2 got a fresh, isolated client.
      expect(clientIdOf(start1.data.authorizeUrl)).toBe("client_test");
      expect(clientIdOf(start2.data.authorizeUrl)).toBe("client_fresh");
      // The stored client's registered redirect is flow 1's — flow 2 never
      // touched it (exactly one PUT), so flow 1's authorize URL stays valid.
      expect(putRedirects).toEqual([redirectOf(start1.data.authorizeUrl)]);
      expect(registerRedirects).toEqual([redirectOf(start2.data.authorizeUrl)]);

      // Once the owning flow finishes, the stored client is reusable again.
      await service.cancelDesktopFlow(start1.data.flowId);
      const start3 = await service.startDesktopFlow({ deploymentUrl: DEPLOYMENT_URL });
      expect(start3.success).toBe(true);
      if (!start3.success) return;
      expect(clientIdOf(start3.data.authorizeUrl)).toBe("client_test");
      expect(putRedirects).toHaveLength(2);
    });

    it("commits a new login while a cancelled flow's revocation is still stalled", async () => {
      // Cancellation after token exchange triggers best-effort revocation of
      // the raced tokens. That network call must not run under the login
      // commit lock: a stalled revocation endpoint would otherwise block
      // every later login from committing after browser authorization.
      let releaseExchangeA!: () => void;
      const exchangeGateA = new Promise<void>((resolve) => (releaseExchangeA = resolve));
      let exchangeAStarted!: () => void;
      const exchangeAStartedPromise = new Promise<void>((resolve) => (exchangeAStarted = resolve));
      let revokeAStarted = false;
      let releaseRevokeA!: () => void;
      const revokeGateA = new Promise<void>((resolve) => (releaseRevokeA = resolve));

      mockFetch(async (input, init) => {
        const url = fetchUrl(input);
        if (url.startsWith("http://127.0.0.1")) {
          return originalFetch(input, init);
        }
        if (url === `${DEPLOYMENT_URL}/api/v2/buildinfo`) {
          return jsonResponse({ version: "v2.99.0" });
        }
        if (url === `${DEPLOYMENT_URL}/.well-known/oauth-authorization-server`) {
          return discoveryResponse();
        }
        if (url === `${DEPLOYMENT_URL}/oauth2/register`) {
          return jsonResponse({ client_id: "client_fresh", client_secret: "secret_fresh" });
        }
        if (url === `${DEPLOYMENT_URL}/oauth2/tokens`) {
          const body = new URLSearchParams(fetchBodyText(init));
          if (body.get("code") === "code_a") {
            exchangeAStarted();
            await exchangeGateA;
            return jsonResponse({
              access_token: "at_a",
              refresh_token: "rt_a",
              expires_in: 86400,
              token_type: "Bearer",
            });
          }
          return jsonResponse({
            access_token: "at_b",
            refresh_token: "rt_b",
            expires_in: 86400,
            token_type: "Bearer",
          });
        }
        if (url === `${DEPLOYMENT_URL}/oauth2/revoke`) {
          if (new URLSearchParams(fetchBodyText(init)).get("token") === "rt_a") {
            revokeAStarted = true;
            await revokeGateA; // Stalled revocation endpoint.
          }
          return new Response(null, { status: 200 });
        }
        return new Response(`unexpected url: ${url}`, { status: 500 });
      });

      const callbackFor = (authorizeUrl: string, state: string, code: string): URL => {
        const cb = new URL(new URL(authorizeUrl).searchParams.get("redirect_uri")!);
        cb.searchParams.set("code", code);
        cb.searchParams.set("state", state);
        return cb;
      };

      // Flow A: callback arrives, exchange stalls, Cancel wins, then the
      // exchange resolves — commit sees the dead flow and starts revocation,
      // which hangs on the gated endpoint.
      const startA = await service.startDesktopFlow({ deploymentUrl: DEPLOYMENT_URL });
      expect(startA.success).toBe(true);
      if (!startA.success) return;
      const cbA = originalFetch(
        callbackFor(startA.data.authorizeUrl, startA.data.flowId, "code_a")
      ).catch(() => null);
      await exchangeAStartedPromise;
      await service.cancelDesktopFlow(startA.data.flowId);
      releaseExchangeA();
      await cbA;
      await waitUntil(() => revokeAStarted);

      // Flow B must be able to commit while A's revocation is still pending.
      const startB = await service.startDesktopFlow({ deploymentUrl: DEPLOYMENT_URL });
      expect(startB.success).toBe(true);
      if (!startB.success) return;
      await originalFetch(
        callbackFor(startB.data.authorizeUrl, startB.data.flowId, "code_b")
      ).catch(() => null);
      const waitB = await service.waitForDesktopFlow(startB.data.flowId, { timeoutMs: 3000 });
      expect(waitB.success).toBe(true);

      const coderSection = deps.providersConfig.coder as Record<string, unknown>;
      expect((coderSection.coderOauth as CoderOauthAuth).access).toBe("at_b");

      releaseRevokeA();
    });

    it("clears the persisted model catalog when the new deployment has no catalogs", async () => {
      mockFetch(async (input, init) => {
        const url = fetchUrl(input);
        if (url.startsWith("http://127.0.0.1")) {
          return originalFetch(input, init);
        }
        if (url === `${DEPLOYMENT_URL}/api/v2/buildinfo`) {
          return jsonResponse({ version: "v2.99.0" });
        }
        if (url === `${DEPLOYMENT_URL}/.well-known/oauth-authorization-server`) {
          return discoveryResponse();
        }
        if (url === `${DEPLOYMENT_URL}/oauth2/register`) {
          return jsonResponse({ client_id: "client_new", client_secret: "secret_new" });
        }
        if (url === `${DEPLOYMENT_URL}/oauth2/tokens`) {
          return jsonResponse({
            access_token: "at_no_catalog",
            refresh_token: "rt_no_catalog",
            expires_in: 86400,
            token_type: "Bearer",
          });
        }
        // Provider listing unavailable (member RBAC / older coderd): discovery
        // falls back to probing the default provider names.
        if (url === `${DEPLOYMENT_URL}/api/v2/ai/providers`) {
          return new Response("forbidden", { status: 403 });
        }
        // Every probed route absent (e.g. AI Gateway not entitled).
        if (url.includes("/api/v2/aibridge/")) {
          return new Response("aibridge not entitled", { status: 404 });
        }
        return new Response(`unexpected url: ${url}`, { status: 500 });
      });

      const startResult = await service.startDesktopFlow({ deploymentUrl: DEPLOYMENT_URL });
      expect(startResult.success).toBe(true);
      if (!startResult.success) return;
      const { flowId, authorizeUrl } = startResult.data;

      const waitPromise = service.waitForDesktopFlow(flowId, { timeoutMs: 5000 });
      const callbackUrl = new URL(new URL(authorizeUrl).searchParams.get("redirect_uri")!);
      callbackUrl.searchParams.set("code", "auth_code_no_catalog");
      callbackUrl.searchParams.set("state", flowId);
      await originalFetch(callbackUrl);
      const waitResult = await waitPromise;
      expect(waitResult.success).toBe(true);

      // A previous deployment's catalog must not survive the re-login: the
      // list is overwritten with the (empty) catalog of the new deployment.
      await waitUntil(() => deps.setModelsCalls.length > 0);
      expect(deps.setModelsCalls[0].provider).toBe("coder");
      expect(deps.setModelsCalls[0].models).toEqual([]);
    });

    it("preserves manually added models across a re-login and catalog refresh", async () => {
      // Users can append model IDs to the coder section's models list (see
      // docs/config/providers.mdx). Those entries are user-managed data:
      // a re-login resets only the DISCOVERED catalog (discoveredModels
      // bookkeeping), and the post-login discovery merges manual entries
      // ahead of the fresh catalog instead of overwriting the whole list.
      deps.providersConfig = {
        coder: {
          deploymentUrl: DEPLOYMENT_URL,
          coderOauth: validAuth({ sessionId: "session_prior" }),
          models: ["anthropic/my-manual-model", "anthropic/old-model"],
          discoveredModels: ["anthropic/old-model"],
        },
      };

      mockFetch(async (input, init) => {
        const url = fetchUrl(input);
        if (url.startsWith("http://127.0.0.1")) {
          return originalFetch(input, init);
        }
        if (url === `${DEPLOYMENT_URL}/api/v2/buildinfo`) {
          return jsonResponse({ version: "v2.99.0" });
        }
        if (url === `${DEPLOYMENT_URL}/.well-known/oauth-authorization-server`) {
          return discoveryResponse();
        }
        if (url === `${DEPLOYMENT_URL}/oauth2/clients/client_test` && init?.method === "PUT") {
          return jsonResponse({ client_id: "client_test" });
        }
        if (url === `${DEPLOYMENT_URL}/oauth2/tokens`) {
          return jsonResponse({
            access_token: "at_manual",
            refresh_token: "rt_manual",
            expires_in: 86400,
            token_type: "Bearer",
          });
        }
        if (url === `${DEPLOYMENT_URL}/oauth2/revoke`) {
          return new Response(null, { status: 200 });
        }
        if (url === `${DEPLOYMENT_URL}/api/v2/ai/providers`) {
          return Promise.resolve(aiProvidersResponse());
        }
        if (url === `${DEPLOYMENT_URL}/api/v2/aibridge/anthropic/v1/models`) {
          return jsonResponse({ data: [{ id: "claude-sonnet-4-5" }] });
        }
        if (url === `${DEPLOYMENT_URL}/api/v2/aibridge/openai/v1/models`) {
          return new Response("aibridge not entitled", { status: 404 });
        }
        return new Response(`unexpected url: ${url}`, { status: 500 });
      });

      const startResult = await service.startDesktopFlow({ deploymentUrl: DEPLOYMENT_URL });
      expect(startResult.success).toBe(true);
      if (!startResult.success) return;
      const { flowId, authorizeUrl } = startResult.data;

      const waitPromise = service.waitForDesktopFlow(flowId, { timeoutMs: 5000 });
      const callbackUrl = new URL(new URL(authorizeUrl).searchParams.get("redirect_uri")!);
      callbackUrl.searchParams.set("code", "auth_code_manual");
      callbackUrl.searchParams.set("state", flowId);
      await originalFetch(callbackUrl);
      const waitResult = await waitPromise;
      expect(waitResult.success).toBe(true);

      // The commit kept the manual entry (dropping only the old discovered
      // one), then discovery merged it ahead of the fresh catalog.
      await waitUntil(() => {
        const section = deps.providersConfig.coder as Record<string, unknown> | undefined;
        return Array.isArray(section?.discoveredModels) && section.discoveredModels.length > 0;
      });
      const coderSection = deps.providersConfig.coder as Record<string, unknown>;
      expect(coderSection.models).toEqual([
        "anthropic/my-manual-model",
        "anthropic/claude-sonnet-4-5",
      ]);
      expect(coderSection.discoveredModels).toEqual(["anthropic/claude-sonnet-4-5"]);
    });

    it("fetches origin catalogs concurrently so a stalled origin cannot starve a healthy one", async () => {
      // The anthropic catalog stalls until the openai catalog has been
      // REQUESTED: with the old sequential loop this deadlocks (openai was
      // only queried after anthropic resolved), so completion here proves the
      // healthy origin is fetched while the other is stalled. Each request
      // must also carry an abort signal (the per-request timeout that unwedges
      // a genuinely dead origin in production).
      let releaseAnthropic!: () => void;
      const anthropicGate = new Promise<void>((resolve) => (releaseAnthropic = resolve));
      const catalogSignals: Array<AbortSignal | null | undefined> = [];

      mockFetch(async (input, init) => {
        const url = fetchUrl(input);
        if (url.startsWith("http://127.0.0.1")) {
          return originalFetch(input, init);
        }
        if (url === `${DEPLOYMENT_URL}/api/v2/buildinfo`) {
          return jsonResponse({ version: "v2.99.0" });
        }
        if (url === `${DEPLOYMENT_URL}/.well-known/oauth-authorization-server`) {
          return discoveryResponse();
        }
        if (url === `${DEPLOYMENT_URL}/oauth2/register`) {
          return jsonResponse({ client_id: "client_new", client_secret: "secret_new" });
        }
        if (url === `${DEPLOYMENT_URL}/oauth2/tokens`) {
          return jsonResponse({
            access_token: "at_concurrent",
            refresh_token: "rt_concurrent",
            expires_in: 86400,
            token_type: "Bearer",
          });
        }
        if (url === `${DEPLOYMENT_URL}/api/v2/ai/providers`) {
          return Promise.resolve(aiProvidersResponse());
        }
        // Earlier tests can finish their OAuth flow before post-login catalog discovery settles.
        // Keep those stale requests from participating in this flow's concurrency gate.
        if (
          url.includes("/api/v2/aibridge/") &&
          new Headers(init?.headers).get("Authorization") !== "Bearer at_concurrent"
        ) {
          return new Response("stale test flow", { status: 404 });
        }
        if (url === `${DEPLOYMENT_URL}/api/v2/aibridge/anthropic/v1/models`) {
          catalogSignals.push(init?.signal);
          await anthropicGate; // Stalled until openai is queried.
          return jsonResponse({ data: [{ id: "claude-sonnet-4-5" }] });
        }
        if (url === `${DEPLOYMENT_URL}/api/v2/aibridge/openai/v1/models`) {
          catalogSignals.push(init?.signal);
          releaseAnthropic();
          return jsonResponse({ data: [{ id: "gpt-5" }] });
        }
        return new Response(`unexpected url: ${url}`, { status: 500 });
      });

      const startResult = await service.startDesktopFlow({ deploymentUrl: DEPLOYMENT_URL });
      expect(startResult.success).toBe(true);
      if (!startResult.success) return;
      const { flowId, authorizeUrl } = startResult.data;

      const waitPromise = service.waitForDesktopFlow(flowId, { timeoutMs: 5000 });
      const callbackUrl = new URL(new URL(authorizeUrl).searchParams.get("redirect_uri")!);
      callbackUrl.searchParams.set("code", "auth_code_concurrent");
      callbackUrl.searchParams.set("state", flowId);
      await originalFetch(callbackUrl);
      const waitResult = await waitPromise;
      expect(waitResult.success).toBe(true);

      // Both catalogs land, in deterministic origin order, despite the stall.
      // (The first models write is the login commit's atomic catalog clear.)
      await waitUntil(() => deps.setModelsCalls.some((call) => call.models.length > 0));
      const catalogWrite = deps.setModelsCalls.find((call) => call.models.length > 0)!;
      expect(catalogWrite.models).toEqual(["anthropic/claude-sonnet-4-5", "openai/gpt-5"]);
      // Every catalog request was time-bounded.
      expect(catalogSignals).toHaveLength(2);
      for (const signal of catalogSignals) {
        expect(signal).toBeInstanceOf(AbortSignal);
      }
    });

    it("leaves the catalog unknown when discovery keeps failing transiently", async () => {
      // A re-login where every /models request 500s: the commit resets the
      // catalog to unknown (deleting the previous deployment's list), and
      // discovery must retry, then SKIP the write — persisting [] would be
      // read as an authoritative empty catalog and block Coder routing until
      // the next login even after the bridge recovers.
      deps.providersConfig = {
        coder: {
          deploymentUrl: DEPLOYMENT_URL,
          coderOauth: validAuth({ sessionId: "session_prior" }),
          models: ["anthropic/prior-model"],
          discoveredModels: ["anthropic/prior-model"],
        },
      };

      let catalogRequests = 0;

      mockFetch(async (input, init) => {
        const url = fetchUrl(input);
        if (url.startsWith("http://127.0.0.1")) {
          return originalFetch(input, init);
        }
        if (url === `${DEPLOYMENT_URL}/api/v2/buildinfo`) {
          return jsonResponse({ version: "v2.99.0" });
        }
        if (url === `${DEPLOYMENT_URL}/.well-known/oauth-authorization-server`) {
          return discoveryResponse();
        }
        if (url === `${DEPLOYMENT_URL}/oauth2/clients/client_test` && init?.method === "PUT") {
          return jsonResponse({ client_id: "client_test" });
        }
        if (url === `${DEPLOYMENT_URL}/oauth2/tokens`) {
          return jsonResponse({
            access_token: "at_relogin",
            refresh_token: "rt_relogin",
            expires_in: 86400,
            token_type: "Bearer",
          });
        }
        if (url === `${DEPLOYMENT_URL}/oauth2/revoke`) {
          return new Response(null, { status: 200 });
        }
        if (url === `${DEPLOYMENT_URL}/api/v2/ai/providers`) {
          return aiProvidersResponse();
        }
        if (url.includes("/api/v2/aibridge/")) {
          catalogRequests++;
          return new Response("bridge overloaded", { status: 500 });
        }
        return new Response(`unexpected url: ${url}`, { status: 500 });
      });

      const startResult = await service.startDesktopFlow({ deploymentUrl: DEPLOYMENT_URL });
      expect(startResult.success).toBe(true);
      if (!startResult.success) return;
      const { flowId, authorizeUrl } = startResult.data;

      const waitPromise = service.waitForDesktopFlow(flowId, { timeoutMs: 5000 });
      const callbackUrl = new URL(new URL(authorizeUrl).searchParams.get("redirect_uri")!);
      callbackUrl.searchParams.set("code", "auth_code_transient");
      callbackUrl.searchParams.set("state", flowId);
      await originalFetch(callbackUrl);
      const waitResult = await waitPromise;
      expect(waitResult.success).toBe(true);

      // Each origin was retried (2 origins x 3 attempts).
      await waitUntil(() => catalogRequests >= 6, 5000);
      // The catalog stays UNKNOWN: the previous deployment's discovered list
      // is gone (reset by the commit) and no authoritative list was written.
      const coderSection = deps.providersConfig.coder as Record<string, unknown>;
      expect(coderSection.models).toBeUndefined();
      expect(coderSection.discoveredModels).toBeUndefined();
      expect((coderSection.coderOauth as CoderOauthAuth).access).toBe("at_relogin");
    });

    it("leaves the catalog unknown when discovery is rejected as unauthenticated", async () => {
      // /models returning 401 (token expired/revoked between exchange and
      // discovery) is NOT a conclusive catalog answer: persisting it as
      // authoritative (empty) would hide every valid Coder model until the
      // next login even after authentication recovers. Auth failures must be
      // classified like transient errors — retried, then skipped.
      deps.providersConfig = {
        coder: {
          deploymentUrl: DEPLOYMENT_URL,
          coderOauth: validAuth({ sessionId: "session_prior" }),
          models: ["anthropic/prior-model"],
          discoveredModels: ["anthropic/prior-model"],
        },
      };

      let catalogRequests = 0;
      mockFetch(async (input, init) => {
        const url = fetchUrl(input);
        if (url.startsWith("http://127.0.0.1")) {
          return originalFetch(input, init);
        }
        if (url === `${DEPLOYMENT_URL}/api/v2/buildinfo`) {
          return jsonResponse({ version: "v2.99.0" });
        }
        if (url === `${DEPLOYMENT_URL}/.well-known/oauth-authorization-server`) {
          return discoveryResponse();
        }
        if (url === `${DEPLOYMENT_URL}/oauth2/clients/client_test` && init?.method === "PUT") {
          return jsonResponse({ client_id: "client_test" });
        }
        if (url === `${DEPLOYMENT_URL}/oauth2/tokens`) {
          return jsonResponse({
            access_token: "at_unauth",
            refresh_token: "rt_unauth",
            expires_in: 86400,
            token_type: "Bearer",
          });
        }
        if (url === `${DEPLOYMENT_URL}/oauth2/revoke`) {
          return new Response(null, { status: 200 });
        }
        if (url === `${DEPLOYMENT_URL}/api/v2/ai/providers`) {
          return aiProvidersResponse();
        }
        if (url.includes("/api/v2/aibridge/")) {
          catalogRequests++;
          return new Response("Unauthorized", { status: 401 });
        }
        return new Response(`unexpected url: ${url}`, { status: 500 });
      });

      const startResult = await service.startDesktopFlow({ deploymentUrl: DEPLOYMENT_URL });
      expect(startResult.success).toBe(true);
      if (!startResult.success) return;
      const { flowId, authorizeUrl } = startResult.data;

      const waitPromise = service.waitForDesktopFlow(flowId, { timeoutMs: 5000 });
      const callbackUrl = new URL(new URL(authorizeUrl).searchParams.get("redirect_uri")!);
      callbackUrl.searchParams.set("code", "auth_code_unauth");
      callbackUrl.searchParams.set("state", flowId);
      await originalFetch(callbackUrl);
      const waitResult = await waitPromise;
      expect(waitResult.success).toBe(true);

      // Each origin was retried like other transient failures (2 x 3).
      await waitUntil(() => catalogRequests >= 6, 5000);
      // The catalog stays UNKNOWN (routing fails open): no authoritative
      // list was persisted from the rejected requests.
      const coderSection = deps.providersConfig.coder as Record<string, unknown>;
      expect(coderSection.discoveredModels).toBeUndefined();
      expect(coderSection.models).toBeUndefined();
      expect((coderSection.coderOauth as CoderOauthAuth).access).toBe("at_unauth");
    });

    it("skips the model catalog write when the login was superseded during discovery", async () => {
      // Gate the catalog fetch so a newer login can land while discovery runs.
      let releaseCatalog!: () => void;
      const catalogGate = new Promise<void>((resolve) => (releaseCatalog = resolve));
      let catalogStarted!: () => void;
      const catalogStartedPromise = new Promise<void>((resolve) => (catalogStarted = resolve));

      mockFetch(async (input, init) => {
        const url = fetchUrl(input);
        if (url.startsWith("http://127.0.0.1")) {
          return originalFetch(input, init);
        }
        if (url === `${DEPLOYMENT_URL}/api/v2/buildinfo`) {
          return jsonResponse({ version: "v2.99.0" });
        }
        if (url === `${DEPLOYMENT_URL}/.well-known/oauth-authorization-server`) {
          return discoveryResponse();
        }
        if (url === `${DEPLOYMENT_URL}/oauth2/register`) {
          return jsonResponse({ client_id: "client_new", client_secret: "secret_new" });
        }
        if (url === `${DEPLOYMENT_URL}/oauth2/tokens`) {
          return jsonResponse({
            access_token: "at_slow_login",
            refresh_token: "rt_slow_login",
            expires_in: 86400,
            token_type: "Bearer",
          });
        }
        if (url === `${DEPLOYMENT_URL}/api/v2/ai/providers`) {
          return aiProvidersResponse();
        }
        if (url.includes("/api/v2/aibridge/")) {
          catalogStarted();
          await catalogGate;
          return jsonResponse({ data: [{ id: "stale-model" }] });
        }
        return new Response(`unexpected url: ${url}`, { status: 500 });
      });

      const startResult = await service.startDesktopFlow({ deploymentUrl: DEPLOYMENT_URL });
      expect(startResult.success).toBe(true);
      if (!startResult.success) return;
      const { flowId, authorizeUrl } = startResult.data;

      const waitPromise = service.waitForDesktopFlow(flowId, { timeoutMs: 5000 });
      const callbackUrl = new URL(new URL(authorizeUrl).searchParams.get("redirect_uri")!);
      callbackUrl.searchParams.set("code", "auth_code_slow");
      callbackUrl.searchParams.set("state", flowId);
      await originalFetch(callbackUrl);
      const waitResult = await waitPromise;
      expect(waitResult.success).toBe(true);

      // While discovery is blocked, a newer login replaces the stored credential.
      await catalogStartedPromise;
      deps.providersConfig = {
        coder: {
          deploymentUrl: DEPLOYMENT_URL,
          coderOauth: validAuth({ access: "at_newer_login", refresh: "rt_newer_login" }),
        },
      };
      releaseCatalog();

      // The stale discovery must not commit its catalog over the newer login's.
      // (The exchange-time atomic clear writes [], but the stale-model list
      // fetched by the superseded discovery must never land.)
      await new Promise((resolve) => setTimeout(resolve, 100));
      const staleWrite = deps.setModelsCalls.find((c) =>
        (c.models as unknown as string[]).some((m) => String(m).includes("stale-model"))
      );
      expect(staleWrite).toBeUndefined();
    });
  });

  // -------------------------------------------------------------------------
  // startServerFlow / handleServerCallback (browser + remote Xum server)
  // -------------------------------------------------------------------------

  describe("startServerFlow", () => {
    const SERVER_REDIRECT_URI = "https://xum.example.com/auth/coder/callback";

    /** Deployment mocks for the server flow; `onTokens` customizes the exchange. */
    function mockServerFlowDeployment(opts: {
      registerCalls?: unknown[];
      onTokens?: (init?: RequestInit) => Promise<Response>;
      onRevoke?: (init?: RequestInit) => void;
    }): void {
      mockFetch(async (input, init) => {
        const url = fetchUrl(input);
        if (url === `${DEPLOYMENT_URL}/api/v2/buildinfo`) {
          return jsonResponse({ version: "v2.99.0" });
        }
        if (url === `${DEPLOYMENT_URL}/.well-known/oauth-authorization-server`) {
          return discoveryResponse();
        }
        if (url === `${DEPLOYMENT_URL}/oauth2/register`) {
          opts.registerCalls?.push(JSON.parse(fetchBodyText(init)));
          return jsonResponse({ client_id: "client_srv", client_secret: "secret_srv" });
        }
        if (url === `${DEPLOYMENT_URL}/oauth2/tokens`) {
          if (opts.onTokens) return opts.onTokens(init);
          return jsonResponse({
            access_token: "at_srv",
            refresh_token: "rt_srv",
            expires_in: 86400,
            token_type: "Bearer",
          });
        }
        if (url === `${DEPLOYMENT_URL}/oauth2/revoke`) {
          opts.onRevoke?.(init);
          return new Response(null, { status: 200 });
        }
        if (url === `${DEPLOYMENT_URL}/api/v2/ai/providers`) {
          return aiProvidersResponse();
        }
        if (url.startsWith(`${DEPLOYMENT_URL}/api/v2/aibridge/`)) {
          return jsonResponse({ data: [{ id: "claude-sonnet-4-5" }] });
        }
        // No loopback listener may be involved: any 127.0.0.1 request is a bug.
        return new Response(`unexpected url: ${url}`, { status: 500 });
      });
    }

    it("registers the server callback URL instead of a loopback listener and commits via handleServerCallback", async () => {
      const registerCalls: unknown[] = [];
      let exchangeBody: URLSearchParams | null = null;
      mockServerFlowDeployment({
        registerCalls,
        onTokens: (init) => {
          exchangeBody = new URLSearchParams(fetchBodyText(init));
          return Promise.resolve(
            jsonResponse({
              access_token: "at_srv",
              refresh_token: "rt_srv",
              expires_in: 86400,
              token_type: "Bearer",
            })
          );
        },
      });

      const flowId = "server-flow-0123456789abcdef";
      const startResult = await service.startServerFlow({
        deploymentUrl: DEPLOYMENT_URL,
        flowId,
        redirectUri: SERVER_REDIRECT_URI,
      });
      expect(startResult.success).toBe(true);
      if (!startResult.success) return;

      const authorize = new URL(startResult.data.authorizeUrl);
      expect(startResult.data.flowId).toBe(flowId);
      expect(authorize.searchParams.get("state")).toBe(flowId);
      // Exact redirect URI matching: the server route URL is what gets
      // registered and what the authorize request names.
      expect(authorize.searchParams.get("redirect_uri")).toBe(SERVER_REDIRECT_URI);
      expect((registerCalls[0] as { redirect_uris: string[] }).redirect_uris).toEqual([
        SERVER_REDIRECT_URI,
      ]);

      const waitPromise = service.waitForDesktopFlow(flowId, { timeoutMs: 5000 });

      // Unknown state is refused before any exchange.
      const unknown = await service.handleServerCallback({
        state: "not-a-registered-flow",
        code: "code",
        error: null,
      });
      expect(unknown.success).toBe(false);

      // The callback route's outcome is the committed login.
      const callbackResult = await service.handleServerCallback({
        state: flowId,
        code: "auth_code_srv",
        error: null,
      });
      expect(callbackResult).toEqual(Ok(undefined));
      expect(await waitPromise).toEqual(Ok(undefined));

      expect(exchangeBody!.get("code")).toBe("auth_code_srv");
      expect(exchangeBody!.get("redirect_uri")).toBe(SERVER_REDIRECT_URI);
      expect(sha256Base64Url(exchangeBody!.get("code_verifier")!)).toBe(
        authorize.searchParams.get("code_challenge")!
      );

      const coderSection = deps.providersConfig.coder as Record<string, unknown>;
      expect((coderSection.coderOauth as CoderOauthAuth).access).toBe("at_srv");
      expect(coderSection.deploymentUrl).toBe(DEPLOYMENT_URL);

      // An authorization code is single-use; so is its delivery. The finished
      // flow is gone from the manager, so a replayed redirect is refused.
      const replay = await service.handleServerCallback({
        state: flowId,
        code: "auth_code_srv",
        error: null,
      });
      expect(replay.success).toBe(false);
    });

    it("fails the flow when the redirect carries an OAuth error", async () => {
      mockServerFlowDeployment({});
      const startResult = await service.startServerFlow({
        deploymentUrl: DEPLOYMENT_URL,
        redirectUri: SERVER_REDIRECT_URI,
      });
      expect(startResult.success).toBe(true);
      if (!startResult.success) return;
      const { flowId } = startResult.data;
      const waitPromise = service.waitForDesktopFlow(flowId, { timeoutMs: 5000 });

      const callbackResult = await service.handleServerCallback({
        state: flowId,
        code: null,
        error: "access_denied",
        errorDescription: "User declined",
      });
      expect(callbackResult).toEqual(Err("access_denied: User declined"));
      expect(await waitPromise).toEqual(Err("access_denied: User declined"));
      expect(deps.providersConfig.coder?.coderOauth).toBeUndefined();
    });

    it("settles the pending callback request when the flow is cancelled mid-exchange", async () => {
      let releaseExchange!: () => void;
      const exchangeGate = new Promise<void>((resolve) => (releaseExchange = resolve));
      let exchangeStarted!: () => void;
      const exchangeStartedPromise = new Promise<void>((resolve) => (exchangeStarted = resolve));
      let revokeBody: URLSearchParams | null = null;
      mockServerFlowDeployment({
        onTokens: async () => {
          exchangeStarted();
          await exchangeGate;
          return jsonResponse({
            access_token: "at_raced",
            refresh_token: "rt_raced",
            expires_in: 86400,
            token_type: "Bearer",
          });
        },
        onRevoke: (init) => {
          revokeBody = new URLSearchParams(fetchBodyText(init));
        },
      });

      const startResult = await service.startServerFlow({
        deploymentUrl: DEPLOYMENT_URL,
        redirectUri: SERVER_REDIRECT_URI,
      });
      expect(startResult.success).toBe(true);
      if (!startResult.success) return;
      const { flowId } = startResult.data;

      // The Express route awaits this; Cancel must resolve it rather than
      // leave the browser tab hanging until the flow timeout.
      const callbackPromise = service.handleServerCallback({
        state: flowId,
        code: "auth_code_raced",
        error: null,
      });
      await exchangeStartedPromise;
      await service.cancelDesktopFlow(flowId);
      const callbackResult = await callbackPromise;
      expect(callbackResult.success).toBe(false);
      releaseExchange();

      await waitUntil(() => revokeBody !== null);
      expect(revokeBody!.get("token")).toBe("rt_raced");
      expect(deps.providersConfig.coder?.coderOauth).toBeUndefined();
    });

    it("rejects a non-http(s) redirect URI without network calls", async () => {
      mockFetch(() => Promise.reject(new Error("network must not be reached")));
      const result = await service.startServerFlow({
        deploymentUrl: DEPLOYMENT_URL,
        redirectUri: "javascript:alert(1)",
      });
      expect(result).toEqual(Err("Invalid OAuth redirect URI"));
    });
  });

  describe("cancelDesktopFlow", () => {
    it("resolves waitForDesktopFlow with cancellation error", async () => {
      mockFetch((input) => {
        const url = fetchUrl(input);
        if (url === `${DEPLOYMENT_URL}/api/v2/buildinfo`) {
          return Promise.resolve(jsonResponse({ version: "v2.99.0" }));
        }
        if (url === `${DEPLOYMENT_URL}/.well-known/oauth-authorization-server`) {
          return Promise.resolve(discoveryResponse());
        }
        if (url === `${DEPLOYMENT_URL}/oauth2/register`) {
          return Promise.resolve(jsonResponse({ client_id: "c", client_secret: "s" }));
        }
        return Promise.resolve(new Response("unexpected", { status: 500 }));
      });

      const startResult = await service.startDesktopFlow({ deploymentUrl: DEPLOYMENT_URL });
      expect(startResult.success).toBe(true);
      if (!startResult.success) return;

      const waitPromise = service.waitForDesktopFlow(startResult.data.flowId, {
        timeoutMs: 5000,
      });
      await service.cancelDesktopFlow(startResult.data.flowId);

      const result = await waitPromise;
      expect(result.success).toBe(false);
      if (!result.success) {
        expect(result.error).toContain("cancelled");
      }
    });
  });

  // -------------------------------------------------------------------------
  // refreshModels (manual AI Gateway re-discovery)
  // -------------------------------------------------------------------------

  describe("refreshModels", () => {
    it("fails without a stored credential", async () => {
      const result = await service.refreshModels();
      expect(result.success).toBe(false);
      if (!result.success) {
        expect(result.error).toContain("Login with Coder");
      }
    });

    it("serializes concurrent refresh runs so a slower run cannot commit stale results", async () => {
      deps.providersConfig = {
        coder: { deploymentUrl: DEPLOYMENT_URL, coderOauth: validAuth() },
      };

      // The first run's provider listing stalls until released; a concurrent
      // second run must queue behind the catalogRefreshMutex instead of
      // fetching (and later committing) in parallel.
      let releaseFirstListing!: () => void;
      const firstListingGate = new Promise<void>((resolve) => {
        releaseFirstListing = resolve;
      });
      let listingRequests = 0;
      mockFetch(async (input) => {
        const url = fetchUrl(input);
        if (url === `${DEPLOYMENT_URL}/api/v2/ai/providers`) {
          listingRequests++;
          if (listingRequests === 1) {
            await firstListingGate;
          }
          return jsonResponse([{ name: "prod-anthropic", type: "anthropic", enabled: true }]);
        }
        if (url === `${DEPLOYMENT_URL}/api/v2/aibridge/prod-anthropic/v1/models`) {
          return jsonResponse({ data: [{ id: "claude-sonnet-4-5" }] });
        }
        return new Response(`unexpected url: ${url}`, { status: 500 });
      });

      const first = service.refreshModels();
      const second = service.refreshModels();
      // Let both entry points resolve auth and reach the refresh body.
      await new Promise((resolve) => setTimeout(resolve, 20));
      expect(listingRequests).toBe(1);

      releaseFirstListing();
      const [firstResult, secondResult] = await Promise.all([first, second]);
      expect(firstResult.success).toBe(true);
      expect(secondResult.success).toBe(true);
      // The queued run re-fetched after the first committed.
      expect(listingRequests).toBe(2);
    });

    it("commits the catalog when the token rotates in the same session mid-refresh", async () => {
      deps.providersConfig = {
        coder: { deploymentUrl: DEPLOYMENT_URL, coderOauth: validAuth() },
      };

      mockFetch((input) => {
        const url = fetchUrl(input);
        if (url === `${DEPLOYMENT_URL}/api/v2/ai/providers`) {
          // An ordinary request refreshed the OAuth token while catalogs were
          // being fetched: rotations preserve sessionId (same login).
          (deps.providersConfig.coder as Record<string, unknown>).coderOauth = validAuth({
            access: "at_rotated",
            refresh: "rt_rotated",
          });
          return Promise.resolve(
            jsonResponse([{ name: "anthropic", type: "anthropic", enabled: true }])
          );
        }
        if (url === `${DEPLOYMENT_URL}/api/v2/aibridge/anthropic/v1/models`) {
          return Promise.resolve(jsonResponse({ data: [{ id: "claude-sonnet-4-5" }] }));
        }
        return Promise.resolve(new Response(`unexpected url: ${url}`, { status: 500 }));
      });

      const result = await service.refreshModels();
      expect(result.success).toBe(true);
      const coderSection = deps.providersConfig.coder as Record<string, unknown>;
      expect(coderSection.discoveredModels).toEqual(["anthropic/claude-sonnet-4-5"]);
    });

    it("reports failure when a newer login supersedes the refresh mid-fetch", async () => {
      deps.providersConfig = {
        coder: { deploymentUrl: DEPLOYMENT_URL, coderOauth: validAuth() },
      };

      mockFetch((input) => {
        const url = fetchUrl(input);
        if (url === `${DEPLOYMENT_URL}/api/v2/ai/providers`) {
          // A NEW login (fresh sessionId) replaced the credential: this
          // refresh's catalog must not commit, and the caller must not be
          // told models were refreshed.
          (deps.providersConfig.coder as Record<string, unknown>).coderOauth = validAuth({
            sessionId: "session_newer_login",
            access: "at_newer",
          });
          return Promise.resolve(
            jsonResponse([{ name: "anthropic", type: "anthropic", enabled: true }])
          );
        }
        if (url === `${DEPLOYMENT_URL}/api/v2/aibridge/anthropic/v1/models`) {
          return Promise.resolve(jsonResponse({ data: [{ id: "claude-sonnet-4-5" }] }));
        }
        return Promise.resolve(new Response(`unexpected url: ${url}`, { status: 500 }));
      });

      const result = await service.refreshModels();
      expect(result.success).toBe(false);
      if (!result.success) {
        expect(result.error).toContain("superseded");
      }
      const coderSection = deps.providersConfig.coder as Record<string, unknown>;
      expect(coderSection.discoveredModels).toBeUndefined();
    });

    it("refuses to commit when another process committed a catalog mid-flight", async () => {
      // The in-process catalogRefreshMutex cannot order refreshes from OTHER
      // Xum processes sharing providers.jsonc. The persisted
      // coderCatalogGeneration counter must: a refresh that began before
      // another process committed (same session, same deployment) would
      // otherwise overwrite the newer catalog with stale fetches.
      deps.providersConfig = {
        coder: { deploymentUrl: DEPLOYMENT_URL, coderOauth: validAuth() },
      };

      mockFetch((input) => {
        const url = fetchUrl(input);
        if (url === `${DEPLOYMENT_URL}/api/v2/ai/providers`) {
          // Another process finished its own refresh while this one was
          // fetching: it bumped the generation and persisted a newer catalog.
          const section = deps.providersConfig.coder as Record<string, unknown>;
          section.coderCatalogGeneration = 1;
          section.models = ["anthropic/claude-newer"];
          section.discoveredModels = ["anthropic/claude-newer"];
          return Promise.resolve(
            jsonResponse([{ name: "anthropic", type: "anthropic", enabled: true }])
          );
        }
        if (url === `${DEPLOYMENT_URL}/api/v2/aibridge/anthropic/v1/models`) {
          return Promise.resolve(jsonResponse({ data: [{ id: "claude-stale" }] }));
        }
        return Promise.resolve(new Response(`unexpected url: ${url}`, { status: 500 }));
      });

      const result = await service.refreshModels();
      expect(result.success).toBe(false);
      if (!result.success) {
        expect(result.error).toContain("concurrent refresh");
      }
      // The newer catalog stayed; the stale fetch never overwrote it.
      const coderSection = deps.providersConfig.coder as Record<string, unknown>;
      expect(coderSection.discoveredModels).toEqual(["anthropic/claude-newer"]);
      expect(coderSection.coderCatalogGeneration).toBe(1);
    });

    it("increments the persisted catalog generation on every commit", async () => {
      deps.providersConfig = {
        coder: {
          deploymentUrl: DEPLOYMENT_URL,
          coderOauth: validAuth(),
          // Hand-edited junk must sanitize to 0, not freeze the counter.
          coderCatalogGeneration: Number.MAX_VALUE,
        },
      };

      mockFetch((input) => {
        const url = fetchUrl(input);
        if (url === `${DEPLOYMENT_URL}/api/v2/ai/providers`) {
          return Promise.resolve(
            jsonResponse([{ name: "anthropic", type: "anthropic", enabled: true }])
          );
        }
        if (url === `${DEPLOYMENT_URL}/api/v2/aibridge/anthropic/v1/models`) {
          return Promise.resolve(jsonResponse({ data: [{ id: "claude-sonnet-4-5" }] }));
        }
        return Promise.resolve(new Response(`unexpected url: ${url}`, { status: 500 }));
      });

      const result = await service.refreshModels();
      expect(result.success).toBe(true);
      const coderSection = deps.providersConfig.coder as Record<string, unknown>;
      expect(coderSection.discoveredModels).toEqual(["anthropic/claude-sonnet-4-5"]);
      expect(coderSection.coderCatalogGeneration).toBe(1);
    });

    it("discovers custom-named provider instances from the authoritative listing", async () => {
      deps.providersConfig = {
        coder: { deploymentUrl: DEPLOYMENT_URL, coderOauth: validAuth() },
      };

      const catalogUrls: string[] = [];
      mockFetch((input) => {
        const url = fetchUrl(input);
        if (url === `${DEPLOYMENT_URL}/api/v2/ai/providers`) {
          return Promise.resolve(
            jsonResponse([
              { name: "prod-anthropic", type: "anthropic", enabled: true },
              { name: "llm-proxy", type: "openai-compat", enabled: true },
              // Disabled and Copilot instances must not be probed or persisted.
              { name: "old-openai", type: "openai", enabled: false },
              { name: "copilot", type: "copilot", enabled: true },
            ])
          );
        }
        if (url === `${DEPLOYMENT_URL}/api/v2/aibridge/prod-anthropic/v1/models`) {
          catalogUrls.push(url);
          return Promise.resolve(jsonResponse({ data: [{ id: "claude-sonnet-4-5" }] }));
        }
        if (url === `${DEPLOYMENT_URL}/api/v2/aibridge/llm-proxy/v1/models`) {
          catalogUrls.push(url);
          return Promise.resolve(jsonResponse({ data: [{ id: "llama-3.3-70b" }] }));
        }
        return Promise.resolve(new Response(`unexpected url: ${url}`, { status: 500 }));
      });

      const result = await service.refreshModels();
      expect(result.success).toBe(true);

      // Only the enabled, non-Copilot instances were probed.
      expect(catalogUrls).toHaveLength(2);
      const coderSection = deps.providersConfig.coder as Record<string, unknown>;
      expect(coderSection.discoveredModels).toEqual([
        "prod-anthropic/claude-sonnet-4-5",
        "llm-proxy/llama-3.3-70b",
      ]);
      expect(coderSection.discoveredProviders).toEqual([
        { name: "prod-anthropic", type: "anthropic" },
        { name: "llm-proxy", type: "openai-compat" },
      ]);
    });

    it("keeps a fresh catalog unknown when any provider fails transiently", async () => {
      // Fresh login state: discoveredModels absent (catalog unknown, routing
      // fails open). One provider succeeds, the other errors after retries.
      // Persisting the partial list as discoveredModels would read as an
      // authoritative catalog and block every model of the failed provider
      // until the next refresh; the authoritative marker must stay absent so
      // routing stays fail-open. The healthy provider's fetched entries stay
      // USER-VISIBLE in models (flagged via staleDiscoveredModels so they
      // remain classified as catalog data). The authoritative provider
      // LISTING is conclusive independently of the catalogs, so it is still
      // persisted — custom-named instances must stay resolvable for manually
      // added models.
      deps.providersConfig = {
        coder: { deploymentUrl: DEPLOYMENT_URL, coderOauth: validAuth() },
      };

      mockFetch((input) => {
        const url = fetchUrl(input);
        if (url === `${DEPLOYMENT_URL}/api/v2/ai/providers`) {
          return Promise.resolve(
            jsonResponse([
              { name: "prod-anthropic", type: "anthropic", enabled: true },
              { name: "openai", type: "openai", enabled: true },
            ])
          );
        }
        if (url === `${DEPLOYMENT_URL}/api/v2/aibridge/prod-anthropic/v1/models`) {
          return Promise.resolve(jsonResponse({ data: [{ id: "claude-sonnet-4-5" }] }));
        }
        if (url === `${DEPLOYMENT_URL}/api/v2/aibridge/openai/v1/models`) {
          return Promise.resolve(new Response("gateway overloaded", { status: 500 }));
        }
        return Promise.resolve(new Response(`unexpected url: ${url}`, { status: 500 }));
      });

      const result = await service.refreshModels();
      expect(result.success).toBe(false);

      const coderSection = deps.providersConfig.coder as Record<string, unknown>;
      expect(coderSection.discoveredModels).toBeUndefined();
      expect(coderSection.models).toEqual(["prod-anthropic/claude-sonnet-4-5"]);
      expect(coderSection.staleDiscoveredModels).toEqual(["prod-anthropic/claude-sonnet-4-5"]);
      expect(coderSection.discoveredProviders).toEqual([
        { name: "prod-anthropic", type: "anthropic" },
        { name: "openai", type: "openai" },
      ]);
    });

    it("persists the authoritative provider listing when every catalog fetch fails", async () => {
      // Fresh login + authoritative listing + all /models requests failing:
      // the listing is conclusive independently of the catalogs, so provider
      // metadata must still be persisted (custom-named instances stay
      // resolvable for manually added models) while the catalog stays
      // unknown (routing fails open).
      deps.providersConfig = {
        coder: { deploymentUrl: DEPLOYMENT_URL, coderOauth: validAuth() },
      };

      mockFetch((input) => {
        const url = fetchUrl(input);
        if (url === `${DEPLOYMENT_URL}/api/v2/ai/providers`) {
          return Promise.resolve(
            jsonResponse([{ name: "prod-anthropic", type: "anthropic", enabled: true }])
          );
        }
        if (url.includes("/api/v2/aibridge/")) {
          return Promise.resolve(new Response("gateway overloaded", { status: 500 }));
        }
        return Promise.resolve(new Response(`unexpected url: ${url}`, { status: 500 }));
      });

      const result = await service.refreshModels();
      expect(result.success).toBe(false);

      const coderSection = deps.providersConfig.coder as Record<string, unknown>;
      expect(coderSection.discoveredModels).toBeUndefined();
      expect(coderSection.discoveredProviders).toEqual([
        { name: "prod-anthropic", type: "anthropic" },
      ]);
    });

    it("flips the catalog to unknown when a newly listed provider's first fetch fails", async () => {
      // A KNOWN catalog + an admin-added provider whose first catalog fetch
      // errors: the new provider has no prior state to carry forward, so
      // persisting the other providers' lists would read as an authoritative
      // catalog that blocks every model of the new provider. The catalog
      // must flip to unknown (fail-open) — losing one refresh's worth of
      // data — while manual entries and the authoritative listing persist.
      deps.providersConfig = {
        coder: {
          deploymentUrl: DEPLOYMENT_URL,
          coderOauth: validAuth(),
          models: [
            { id: "anthropic/claude-old", contextWindowTokens: 100000 },
            "anthropic/claude-old-2",
          ],
          discoveredModels: ["anthropic/claude-old-2"],
          discoveredProviders: [{ name: "anthropic", type: "anthropic" }],
        },
      };

      mockFetch((input) => {
        const url = fetchUrl(input);
        if (url === `${DEPLOYMENT_URL}/api/v2/ai/providers`) {
          return Promise.resolve(
            jsonResponse([
              { name: "anthropic", type: "anthropic", enabled: true },
              { name: "vertex", type: "google", enabled: true },
            ])
          );
        }
        if (url === `${DEPLOYMENT_URL}/api/v2/aibridge/anthropic/v1/models`) {
          return Promise.resolve(jsonResponse({ data: [{ id: "claude-new" }] }));
        }
        if (url === `${DEPLOYMENT_URL}/api/v2/aibridge/vertex/v1/models`) {
          return Promise.resolve(new Response("gateway overloaded", { status: 500 }));
        }
        return Promise.resolve(new Response(`unexpected url: ${url}`, { status: 500 }));
      });

      const result = await service.refreshModels();
      expect(result.success).toBe(false);

      const coderSection = deps.providersConfig.coder as Record<string, unknown>;
      // Catalog unknown: vertex models stay reachable through fail-open routing.
      expect(coderSection.discoveredModels).toBeUndefined();
      // Manual (user-edited) entries survive, and the healthy provider's
      // fresh catalog stays user-visible (flagged stale so disconnect and
      // future refreshes keep classifying it as discovered data).
      expect(coderSection.models).toEqual([
        { id: "anthropic/claude-old", contextWindowTokens: 100000 },
        "anthropic/claude-new",
      ]);
      expect(coderSection.staleDiscoveredModels).toEqual(["anthropic/claude-new"]);
      // The authoritative listing (including the new instance) is persisted.
      expect(coderSection.discoveredProviders).toEqual([
        { name: "anthropic", type: "anthropic" },
        { name: "vertex", type: "google" },
      ]);
    });

    it("persists only probe-fetched models on an inconclusive fresh probe fallback", async () => {
      // Same fresh-unknown state, but the provider listing is forbidden:
      // probe-derived metadata is only the name === type default, which
      // routing applies without persistence — no provider metadata or
      // authoritative catalog to write. The healthy probe's fetched models
      // still become user-visible (flagged stale).
      deps.providersConfig = {
        coder: { deploymentUrl: DEPLOYMENT_URL, coderOauth: validAuth() },
      };

      mockFetch((input) => {
        const url = fetchUrl(input);
        if (url === `${DEPLOYMENT_URL}/api/v2/ai/providers`) {
          return Promise.resolve(new Response("forbidden", { status: 403 }));
        }
        if (url === `${DEPLOYMENT_URL}/api/v2/aibridge/anthropic/v1/models`) {
          return Promise.resolve(jsonResponse({ data: [{ id: "claude-sonnet-4-5" }] }));
        }
        if (url.includes("/api/v2/aibridge/")) {
          return Promise.resolve(new Response("gateway overloaded", { status: 500 }));
        }
        return Promise.resolve(new Response(`unexpected url: ${url}`, { status: 500 }));
      });

      const result = await service.refreshModels();
      expect(result.success).toBe(false);

      const coderSection = deps.providersConfig.coder as Record<string, unknown>;
      expect(coderSection.discoveredModels).toBeUndefined();
      expect(coderSection.discoveredProviders).toBeUndefined();
      expect(coderSection.models).toEqual(["anthropic/claude-sonnet-4-5"]);
      expect(coderSection.staleDiscoveredModels).toEqual(["anthropic/claude-sonnet-4-5"]);
    });

    it("keeps previously listed providers whose /models 404s when probing without a listing", async () => {
      // Probe path (listing member-forbidden): a 404 from a custom instance
      // recorded by an earlier authoritative listing proves only that its
      // upstream serves no /models route — not that the admin removed the
      // instance. Its metadata must stay resolvable (manually configured
      // coder:<custom>/<model> entries) and its prior catalog entries carry
      // forward like a transient error.
      deps.providersConfig = {
        coder: {
          deploymentUrl: DEPLOYMENT_URL,
          coderOauth: validAuth(),
          models: ["anthropic/claude-old", "llm/custom-model"],
          discoveredModels: ["anthropic/claude-old", "llm/custom-model"],
          discoveredProviders: [
            { name: "anthropic", type: "anthropic" },
            { name: "llm", type: "openai-compat" },
          ],
        },
      };

      mockFetch((input) => {
        const url = fetchUrl(input);
        if (url === `${DEPLOYMENT_URL}/api/v2/ai/providers`) {
          return Promise.resolve(new Response("forbidden", { status: 403 }));
        }
        if (url === `${DEPLOYMENT_URL}/api/v2/aibridge/anthropic/v1/models`) {
          return Promise.resolve(jsonResponse({ data: [{ id: "claude-new" }] }));
        }
        // llm (and every absent default route) serves no /models.
        if (url.includes("/api/v2/aibridge/")) {
          return Promise.resolve(new Response("not found", { status: 404 }));
        }
        return Promise.resolve(new Response(`unexpected url: ${url}`, { status: 500 }));
      });

      const result = await service.refreshModels();
      expect(result.success).toBe(true);

      const coderSection = deps.providersConfig.coder as Record<string, unknown>;
      expect(coderSection.discoveredModels).toEqual(["anthropic/claude-new", "llm/custom-model"]);
      expect(coderSection.discoveredProviders).toEqual([
        { name: "anthropic", type: "anthropic" },
        { name: "llm", type: "openai-compat" },
      ]);
    });

    it("retains stale display entries across consecutive inconclusive refreshes", async () => {
      // After an inconclusive refresh the authoritative catalog is gone and
      // only staleDiscoveredModels remains. A second refresh where the same
      // provider flakes again must keep those entries user-visible (Settings
      // and the selector) instead of dropping them: the stale marker is the
      // carry-forward source, while the catalog stays fail-open.
      deps.providersConfig = {
        coder: {
          deploymentUrl: DEPLOYMENT_URL,
          coderOauth: validAuth(),
          models: ["prod-anthropic/claude-sonnet-4-5", "openai/gpt-5"],
          staleDiscoveredModels: ["prod-anthropic/claude-sonnet-4-5", "openai/gpt-5"],
          discoveredProviders: [
            { name: "prod-anthropic", type: "anthropic" },
            { name: "openai", type: "openai" },
          ],
        },
      };

      mockFetch((input) => {
        const url = fetchUrl(input);
        if (url === `${DEPLOYMENT_URL}/api/v2/ai/providers`) {
          return Promise.resolve(
            jsonResponse([
              { name: "prod-anthropic", type: "anthropic", enabled: true },
              { name: "openai", type: "openai", enabled: true },
            ])
          );
        }
        if (url === `${DEPLOYMENT_URL}/api/v2/aibridge/prod-anthropic/v1/models`) {
          return Promise.resolve(jsonResponse({ data: [{ id: "claude-opus-4-6" }] }));
        }
        if (url === `${DEPLOYMENT_URL}/api/v2/aibridge/openai/v1/models`) {
          return Promise.resolve(new Response("gateway overloaded", { status: 500 }));
        }
        return Promise.resolve(new Response(`unexpected url: ${url}`, { status: 500 }));
      });

      const result = await service.refreshModels();
      expect(result.success).toBe(false);

      const coderSection = deps.providersConfig.coder as Record<string, unknown>;
      // Catalog still unknown (fail-open), but the healthy provider's fresh
      // list and the flaky provider's stale entries stay user-visible.
      expect(coderSection.discoveredModels).toBeUndefined();
      expect(coderSection.models).toEqual(["prod-anthropic/claude-opus-4-6", "openai/gpt-5"]);
      expect(coderSection.staleDiscoveredModels).toEqual([
        "prod-anthropic/claude-opus-4-6",
        "openai/gpt-5",
      ]);
    });

    it("clears stale-flagged catalog entries on disconnect", async () => {
      // Entries retained through an inconclusive refresh are catalog data,
      // not user-managed: without the stale marker they would classify as
      // manual and survive logout.
      deps.providersConfig = {
        coder: {
          deploymentUrl: DEPLOYMENT_URL,
          coderOauth: validAuth(),
          models: ["anthropic/my-manual-model", "anthropic/retained-model"],
          staleDiscoveredModels: ["anthropic/retained-model"],
        },
      };

      mockFetch((input) => {
        const url = fetchUrl(input);
        if (url === `${DEPLOYMENT_URL}/oauth2/revoke`) {
          return Promise.resolve(new Response(null, { status: 200 }));
        }
        return Promise.resolve(new Response("unexpected", { status: 500 }));
      });

      const result = await service.disconnect();
      expect(result.success).toBe(true);

      const coderSection = deps.providersConfig.coder as Record<string, unknown>;
      expect(coderSection.models).toEqual(["anthropic/my-manual-model"]);
      expect(coderSection.staleDiscoveredModels).toBeUndefined();
    });

    it("carries a provider's previous models forward through a transient catalog failure", async () => {
      // Per-provider conclusiveness: one provider's flake (or an upstream
      // without a real /models route, like Bedrock) must not wipe its
      // previously discovered entries, nor poison the healthy provider's
      // refresh. Conclusive 404s still clear their provider's entries.
      deps.providersConfig = {
        coder: {
          deploymentUrl: DEPLOYMENT_URL,
          coderOauth: validAuth(),
          models: ["anthropic/claude-sonnet-4-5", "openai/gpt-5-old"],
          discoveredModels: ["anthropic/claude-sonnet-4-5", "openai/gpt-5-old"],
          discoveredProviders: [
            { name: "anthropic", type: "anthropic" },
            { name: "openai", type: "openai" },
          ],
        },
      };

      mockFetch((input) => {
        const url = fetchUrl(input);
        if (url === `${DEPLOYMENT_URL}/api/v2/ai/providers`) {
          return Promise.resolve(aiProvidersResponse());
        }
        if (url === `${DEPLOYMENT_URL}/api/v2/aibridge/anthropic/v1/models`) {
          return Promise.resolve(jsonResponse({ data: [{ id: "claude-opus-4-6" }] }));
        }
        if (url === `${DEPLOYMENT_URL}/api/v2/aibridge/openai/v1/models`) {
          return Promise.resolve(new Response("gateway overloaded", { status: 500 }));
        }
        return Promise.resolve(new Response(`unexpected url: ${url}`, { status: 500 }));
      });

      const result = await service.refreshModels();
      expect(result.success).toBe(true);

      const coderSection = deps.providersConfig.coder as Record<string, unknown>;
      // anthropic replaced conclusively; openai carried forward.
      expect(coderSection.discoveredModels).toEqual([
        "anthropic/claude-opus-4-6",
        "openai/gpt-5-old",
      ]);
    });

    it("does not carry a provider's models forward when the authoritative type changed", async () => {
      // The admin re-pointed the "llm" instance from an Anthropic upstream to
      // an OpenAI-compatible one. Its first /models fetch flakes: carrying the
      // Anthropic-era IDs forward while persisting the new type would leave
      // stale entries selectable on the wrong wire, so the catalog must go
      // inconclusive (unknown) instead — new metadata persisted, old catalog
      // dropped, routing fails open until a successful refresh.
      deps.providersConfig = {
        coder: {
          deploymentUrl: DEPLOYMENT_URL,
          coderOauth: validAuth(),
          discoveredModels: ["llm/claude-sonnet-4-5", "anthropic/claude-opus-4-6"],
          discoveredProviders: [
            { name: "llm", type: "anthropic" },
            { name: "anthropic", type: "anthropic" },
          ],
        },
      };

      mockFetch((input) => {
        const url = fetchUrl(input);
        if (url === `${DEPLOYMENT_URL}/api/v2/ai/providers`) {
          return Promise.resolve(
            jsonResponse([
              { name: "llm", type: "openai-compat", enabled: true },
              { name: "anthropic", type: "anthropic", enabled: true },
            ])
          );
        }
        if (url === `${DEPLOYMENT_URL}/api/v2/aibridge/llm/v1/models`) {
          return Promise.resolve(new Response("gateway overloaded", { status: 500 }));
        }
        if (url === `${DEPLOYMENT_URL}/api/v2/aibridge/anthropic/v1/models`) {
          return Promise.resolve(jsonResponse({ data: [{ id: "claude-opus-4-6" }] }));
        }
        return Promise.resolve(new Response(`unexpected url: ${url}`, { status: 500 }));
      });

      const result = await service.refreshModels();
      // Inconclusive catalogs report the transient failure to the caller.
      expect(result.success).toBe(false);

      const coderSection = deps.providersConfig.coder as Record<string, unknown>;
      // Catalog stays unknown — no stale llm/* entries survive on the new wire.
      expect(coderSection.discoveredModels).toBeUndefined();
      // The authoritative listing is still persisted: the new type must win.
      expect(coderSection.discoveredProviders).toEqual([
        { name: "llm", type: "openai-compat" },
        { name: "anthropic", type: "anthropic" },
      ]);
    });

    it("falls back to probing default provider names when the listing is member-forbidden", async () => {
      deps.providersConfig = {
        coder: { deploymentUrl: DEPLOYMENT_URL, coderOauth: validAuth() },
      };

      const probedNames: string[] = [];
      mockFetch((input) => {
        const url = fetchUrl(input);
        if (url === `${DEPLOYMENT_URL}/api/v2/ai/providers`) {
          return Promise.resolve(new Response("forbidden", { status: 403 }));
        }
        const match = /\/api\/v2\/aibridge\/([^/]+)\/v1\/models$/.exec(url);
        if (match) {
          probedNames.push(match[1]);
          if (match[1] === "anthropic") {
            return Promise.resolve(jsonResponse({ data: [{ id: "claude-sonnet-4-5" }] }));
          }
          // Every other default route is absent on this deployment.
          return Promise.resolve(new Response("not found", { status: 404 }));
        }
        return Promise.resolve(new Response(`unexpected url: ${url}`, { status: 500 }));
      });

      const result = await service.refreshModels();
      expect(result.success).toBe(true);

      // All non-Copilot default names were probed...
      expect(probedNames.sort()).toEqual([...CODER_GATEWAY_DEFAULT_PROVIDER_NAMES].sort());
      // ...and only the present route contributed models + provider metadata.
      const coderSection = deps.providersConfig.coder as Record<string, unknown>;
      expect(coderSection.discoveredModels).toEqual(["anthropic/claude-sonnet-4-5"]);
      expect(coderSection.discoveredProviders).toEqual([{ name: "anthropic", type: "anthropic" }]);
    });

    it("sends the required anthropic-version header to Anthropic-wire providers only", async () => {
      // The gateway passes /v1/models straight through; Anthropic rejects the
      // request with a conclusive 400 without this header, which would read
      // as an authoritatively empty catalog and hide every Anthropic model.
      deps.providersConfig = {
        coder: { deploymentUrl: DEPLOYMENT_URL, coderOauth: validAuth() },
      };

      const versionHeaders = new Map<string, string | null>();
      mockFetch((input, init) => {
        const url = fetchUrl(input);
        if (url === `${DEPLOYMENT_URL}/api/v2/ai/providers`) {
          return Promise.resolve(
            jsonResponse([
              { name: "anthropic", type: "anthropic", enabled: true },
              { name: "aws", type: "bedrock", enabled: true },
              { name: "openai", type: "openai", enabled: true },
            ])
          );
        }
        const match = /\/api\/v2\/aibridge\/([^/]+)\/v1\/models$/.exec(url);
        if (match) {
          versionHeaders.set(match[1], new Headers(init?.headers).get("anthropic-version"));
          return Promise.resolve(jsonResponse({ data: [{ id: "m" }] }));
        }
        return Promise.resolve(new Response(`unexpected url: ${url}`, { status: 500 }));
      });

      const result = await service.refreshModels();
      expect(result.success).toBe(true);

      expect(versionHeaders.get("anthropic")).toBe("2023-06-01");
      expect(versionHeaders.get("aws")).toBe("2023-06-01");
      expect(versionHeaders.get("openai")).toBeNull();
    });

    it("probes user-declared additionalProviders when the listing is unavailable", async () => {
      deps.providersConfig = {
        coder: {
          deploymentUrl: DEPLOYMENT_URL,
          coderOauth: validAuth(),
          additionalProviders: [{ name: "llm-proxy", type: "openai-compat" }],
        },
      };

      mockFetch((input) => {
        const url = fetchUrl(input);
        if (url === `${DEPLOYMENT_URL}/api/v2/ai/providers`) {
          return Promise.resolve(new Response("forbidden", { status: 403 }));
        }
        if (url === `${DEPLOYMENT_URL}/api/v2/aibridge/llm-proxy/v1/models`) {
          return Promise.resolve(jsonResponse({ data: [{ id: "llama-3.3-70b" }] }));
        }
        if (url.includes("/api/v2/aibridge/")) {
          return Promise.resolve(new Response("not found", { status: 404 }));
        }
        return Promise.resolve(new Response(`unexpected url: ${url}`, { status: 500 }));
      });

      const result = await service.refreshModels();
      expect(result.success).toBe(true);

      const coderSection = deps.providersConfig.coder as Record<string, unknown>;
      expect(coderSection.discoveredModels).toEqual(["llm-proxy/llama-3.3-70b"]);
    });
  });

  // -------------------------------------------------------------------------
  // disconnect
  // -------------------------------------------------------------------------

  describe("disconnect", () => {
    it("revokes best-effort, clears stored auth, and clears models", async () => {
      deps.providersConfig = {
        coder: { deploymentUrl: DEPLOYMENT_URL, coderOauth: validAuth() },
      };

      let revokeBody: URLSearchParams | null = null;
      mockFetch((input, init) => {
        const url = fetchUrl(input);
        if (url === `${DEPLOYMENT_URL}/oauth2/revoke`) {
          revokeBody = new URLSearchParams(fetchBodyText(init));
          return Promise.resolve(new Response(null, { status: 200 }));
        }
        return Promise.resolve(new Response("unexpected", { status: 500 }));
      });

      const result = await service.disconnect();
      expect(result.success).toBe(true);

      expect(revokeBody).not.toBeNull();
      expect(revokeBody!.get("token")).toBe("rt_test");

      // Tokens and models are cleared in one atomic section write; the
      // now-empty discoveredModels stays present as the authoritative-empty
      // catalog marker.
      expect((deps.providersConfig.coder as Record<string, unknown>).coderOauth).toBeUndefined();
      expect(deps.setModelsCalls).toEqual([{ provider: "coder", models: [] }]);
      expect((deps.providersConfig.coder as Record<string, unknown>).discoveredModels).toEqual([]);
    });

    it("advances a malformed persisted disconnect generation so the tombstone self-heals", async () => {
      // Regression: providers.jsonc is hand-editable. With a finite-but-unsafe
      // persisted generation such as Number.MAX_VALUE, MAX_VALUE + 1 ===
      // MAX_VALUE — disconnect would not advance the shared tombstone, so an
      // in-flight login in another process would see its unchanged start-time
      // snapshot and commit after the credential was cleared. Malformed values
      // must be sanitized before incrementing so the counter provably moves.
      deps.providersConfig = {
        coder: {
          deploymentUrl: DEPLOYMENT_URL,
          coderOauth: validAuth(),
          coderDisconnectGeneration: Number.MAX_VALUE,
        },
      };

      mockFetch((input) => {
        const url = fetchUrl(input);
        if (url === `${DEPLOYMENT_URL}/oauth2/revoke`) {
          return Promise.resolve(new Response(null, { status: 200 }));
        }
        return Promise.resolve(new Response("unexpected", { status: 500 }));
      });

      const before = (deps.providersConfig.coder as Record<string, unknown>)
        .coderDisconnectGeneration;
      const result = await service.disconnect();
      expect(result.success).toBe(true);

      const after = (deps.providersConfig.coder as Record<string, unknown>)
        .coderDisconnectGeneration;
      // The persisted counter must actually move (MAX_VALUE + 1 would not)
      // and land back on a safe integer so future increments keep advancing.
      expect(after).not.toBe(before);
      expect(Number.isSafeInteger(after)).toBe(true);
      expect(after).toBe(1);
    });

    it("keeps manually added models when disconnecting", async () => {
      // Discovered catalog entries are meaningless without credentials, but
      // manually added ones are user-managed data and must survive.
      deps.providersConfig = {
        coder: {
          deploymentUrl: DEPLOYMENT_URL,
          coderOauth: validAuth(),
          models: ["anthropic/my-manual-model", "anthropic/discovered-model"],
          discoveredModels: ["anthropic/discovered-model"],
        },
      };

      mockFetch((input) => {
        const url = fetchUrl(input);
        if (url === `${DEPLOYMENT_URL}/oauth2/revoke`) {
          return Promise.resolve(new Response(null, { status: 200 }));
        }
        return Promise.resolve(new Response("unexpected", { status: 500 }));
      });

      const result = await service.disconnect();
      expect(result.success).toBe(true);

      const coderSection = deps.providersConfig.coder as Record<string, unknown>;
      expect(coderSection.models).toEqual(["anthropic/my-manual-model"]);
      expect(coderSection.discoveredModels).toEqual([]);
    });

    it("does not clear a newer login that completed while revocation was pending", async () => {
      const oldAuth = validAuth({ refresh: "rt_old" });
      deps.providersConfig = { coder: { deploymentUrl: DEPLOYMENT_URL, coderOauth: oldAuth } };

      // A newer LOGIN mints a new session lineage id (rotations of the same
      // login keep it; see the concurrent-rotation test below).
      const newAuth = validAuth({
        sessionId: "session_new",
        access: "at_new",
        refresh: "rt_new",
      });
      let revokedToken: string | null = null;
      mockFetch((input, init) => {
        const url = fetchUrl(input);
        if (url === `${DEPLOYMENT_URL}/oauth2/revoke`) {
          revokedToken = new URLSearchParams(fetchBodyText(init)).get("token");
          return Promise.resolve(new Response(null, { status: 200 }));
        }
        return Promise.resolve(new Response("unexpected", { status: 500 }));
      });

      // Inject the newer login just before the section update runs (i.e. the
      // re-login wins the race to the persisted state).
      const injectingProviderService = {
        ...createMockProviderService(deps),
        updateProviderSection: (
          provider: string,
          update: (
            section: Record<string, unknown> | undefined
          ) => { value: Record<string, unknown> } | null
        ) => {
          deps.providersConfig = { coder: { deploymentUrl: DEPLOYMENT_URL, coderOauth: newAuth } };
          return mockUpdateProviderSection(deps, provider, update);
        },
      };
      service = new CoderOauthService(
        createMockProvidersConfigStore(deps) as ProvidersConfigStore,
        createMockFileLeaseManager(deps) as FileLeaseManager,
        injectingProviderService as unknown as ProviderService,
        createMockWindowService(deps) as WindowService
      );

      const result = await service.disconnect();
      expect(result.success).toBe(true);

      // The new login's credential and models were left intact.
      expect(
        ((deps.providersConfig.coder as Record<string, unknown>).coderOauth as CoderOauthAuth)
          .access
      ).toBe("at_new");
      expect(deps.setModelsCalls).toHaveLength(0);
      // The disconnected (old) session's token was still revoked best-effort.
      // TS narrows the closure-assigned variable to its initializer type; widen.
      expect(revokedToken as string | null).toBe("rt_old");
    });

    it("clears a concurrent rotation of the same session (disconnect is authoritative)", async () => {
      // A refresh that rotates the tokens while disconnect awaits must NOT be
      // mistaken for a new login: same sessionId => still the session the user
      // asked to disconnect.
      const oldAuth = validAuth({ refresh: "rt_before_rotation" });
      deps.providersConfig = { coder: { deploymentUrl: DEPLOYMENT_URL, coderOauth: oldAuth } };

      const rotated = validAuth({ access: "at_rotated", refresh: "rt_rotated" });
      let revokedToken: string | null = null;
      mockFetch((input, init) => {
        const url = fetchUrl(input);
        if (url === `${DEPLOYMENT_URL}/oauth2/revoke`) {
          revokedToken = new URLSearchParams(fetchBodyText(init)).get("token");
          return Promise.resolve(new Response(null, { status: 200 }));
        }
        return Promise.resolve(new Response("unexpected", { status: 500 }));
      });

      const injectingProviderService = {
        ...createMockProviderService(deps),
        updateProviderSection: (
          provider: string,
          update: (
            section: Record<string, unknown> | undefined
          ) => { value: Record<string, unknown> } | null
        ) => {
          // The concurrent refresh persists its rotation first.
          deps.providersConfig = { coder: { deploymentUrl: DEPLOYMENT_URL, coderOauth: rotated } };
          return mockUpdateProviderSection(deps, provider, update);
        },
      };
      service = new CoderOauthService(
        createMockProvidersConfigStore(deps) as ProvidersConfigStore,
        createMockFileLeaseManager(deps) as FileLeaseManager,
        injectingProviderService as unknown as ProviderService,
        createMockWindowService(deps) as WindowService
      );

      const result = await service.disconnect();
      expect(result.success).toBe(true);

      // Despite the rotation, the session was cleared and its FRESHEST token revoked.
      expect((deps.providersConfig.coder as Record<string, unknown>).coderOauth).toBeUndefined();
      expect(revokedToken as string | null).toBe("rt_rotated");
    });

    it("still clears auth when revocation fails", async () => {
      deps.providersConfig = {
        coder: { deploymentUrl: DEPLOYMENT_URL, coderOauth: validAuth() },
      };

      mockFetch(() => Promise.reject(new Error("network down")));

      const result = await service.disconnect();
      expect(result.success).toBe(true);

      expect((deps.providersConfig.coder as Record<string, unknown>).coderOauth).toBeUndefined();
    });
  });
});

import { Config, FileLeaseManager, ProvidersConfigStore } from "@/node/config";
import * as fs from "fs";
import http from "node:http";
import * as os from "os";
import * as path from "path";
import { describe, it, expect, beforeEach, afterEach, spyOn } from "bun:test";

import { Err, Ok } from "@/common/types/result";
import { Effect } from "effect";
import {
  getCodexOauthAccounts,
  getCodexOauthAccountId,
  getCodexOauthAuth,
} from "@/node/utils/codexOauthAuth";
import { createDeferred } from "@/node/utils/oauthUtils";
import {
  CODEX_OAUTH_TOKEN_URL,
  CODEX_OAUTH_DEVICE_USERCODE_URL,
  CODEX_OAUTH_DEVICE_TOKEN_POLL_URL,
} from "@/common/constants/codexOAuth";
import type { ProvidersConfig } from "@/node/config";
import { ProviderService } from "@/node/services/providerService";
import type { WindowService } from "@/node/services/windowService";
import type { CodexOauthAuth } from "@/node/utils/codexOauthAuth";
import { CodexOauthService } from "./codexOauthService";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/** Encode a claims object into a fake JWT (header.payload.signature). */
function fakeJwt(claims: Record<string, unknown>): string {
  const header = Buffer.from(JSON.stringify({ alg: "none" })).toString("base64url");
  const payload = Buffer.from(JSON.stringify(claims)).toString("base64url");
  return `${header}.${payload}.fakesig`;
}

/** Build a valid CodexOauthAuth that expires far in the future. */
function validAuth(overrides?: Partial<CodexOauthAuth>): CodexOauthAuth {
  return {
    type: "oauth",
    credentialId: "1c9c50b0-d777-4dd2-998c-09c156ba9754",
    access: fakeJwt({ sub: "user" }),
    refresh: "rt_test",
    expires: Date.now() + 3_600_000, // 1h from now
    ...overrides,
  };
}

/** Build a CodexOauthAuth that is already expired. */
function expiredAuth(overrides?: Partial<CodexOauthAuth>): CodexOauthAuth {
  return validAuth({ expires: Date.now() - 60_000, ...overrides });
}

/** Build a mock fetch Response for token refresh. */
function mockRefreshResponse(body: Record<string, unknown>, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "Content-Type": "application/json" },
  });
}

// ---------------------------------------------------------------------------
// Mock dependencies
// ---------------------------------------------------------------------------

interface MockDeps {
  rootDir: string;
  providersConfig: ProvidersConfig;
  setConfigValueCalls: Array<{ provider: string; keyPath: string[]; value: unknown }>;
  focusCalls: number;
  onUpdate?: () => void;
  policyDenied?: boolean;
}

function createMockDeps(): MockDeps {
  return {
    rootDir: fs.mkdtempSync(path.join(os.tmpdir(), "xum-codex-oauth-")),
    providersConfig: {},
    setConfigValueCalls: [],
    focusCalls: 0,
  };
}

function createMockProvidersConfigStore(
  deps: MockDeps
): Pick<ProvidersConfigStore, "loadProvidersConfig" | "rootDir"> {
  return {
    rootDir: deps.rootDir,
    loadProvidersConfig: () => deps.providersConfig,
  };
}

function createMockProviderService(
  deps: MockDeps
): Pick<ProviderService, "setConfigValue" | "updateConfigValue" | "updateProviderSection"> {
  const setConfigValue: ProviderService["setConfigValue"] = (provider, keyPath, value) => {
    deps.setConfigValueCalls.push({ provider, keyPath, value });
    deps.providersConfig[provider] ??= {};
    let current = deps.providersConfig[provider] as Record<string, unknown>;
    for (const key of keyPath.slice(0, -1)) {
      current[key] ??= {};
      current = current[key] as Record<string, unknown>;
    }
    const key = keyPath[keyPath.length - 1];
    if (value === undefined) delete current[key];
    else current[key] = value;
    return Promise.resolve(Ok(undefined));
  };
  return {
    setConfigValue,
    updateProviderSection: (provider, update, options) => {
      if (options?.enforcePolicy && deps.policyDenied)
        return Promise.resolve(Err("Provider edits are disabled"));
      const next = update(deps.providersConfig[provider]);
      deps.onUpdate?.();
      if (!next) return Promise.resolve(Ok({ applied: false }));
      deps.providersConfig[provider] = next.value;
      deps.setConfigValueCalls.push({ provider, keyPath: [], value: next.value });
      return Promise.resolve(Ok({ applied: true }));
    },
    updateConfigValue: async (provider, keyPath, update, options) => {
      if (options?.enforcePolicy && deps.policyDenied) return Err("Provider edits are disabled");
      let current: unknown = deps.providersConfig[provider];
      for (const key of keyPath) {
        current =
          current !== null && typeof current === "object"
            ? (current as Record<string, unknown>)[key]
            : undefined;
      }
      const next = update(current);
      deps.onUpdate?.();
      if (!next) return Ok({ applied: false });
      await setConfigValue(provider, keyPath, next.value);
      return Ok({ applied: true });
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

function createService(
  deps: MockDeps,
  providerService = createMockProviderService(deps)
): CodexOauthService {
  return new CodexOauthService(
    createMockProvidersConfigStore(deps) as ProvidersConfigStore,
    providerService as ProviderService,
    createMockWindowService(deps) as WindowService
  );
}

function requestBody(init?: RequestInit): string {
  const body = init?.body;
  if (typeof body === "string") return body;
  if (body instanceof URLSearchParams) return body.toString();
  throw new Error("Expected a string or URLSearchParams request body");
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

describe("CodexOauthService", () => {
  let deps: MockDeps;
  let service: CodexOauthService;
  const originalFetch = globalThis.fetch;

  beforeEach(() => {
    deps = createMockDeps();
    service = createService(deps);
  });

  afterEach(async () => {
    globalThis.fetch = originalFetch;
    await service.dispose();
    fs.rmSync(deps.rootDir, { recursive: true, force: true });
  });

  // -------------------------------------------------------------------------
  // getValidAuth - basic
  // -------------------------------------------------------------------------

  describe("getValidAuth", () => {
    it("returns error when no auth is stored", async () => {
      const result = await service.getValidAuth();
      expect(result.success).toBe(false);
      if (!result.success) {
        expect(result.error).toContain("not configured");
      }
    });

    for (const credentialId of [undefined, "1c9c50b0-d777-4dd2-998c-09c156ba9754"]) {
      it(
        "refreshes a pinned " + (credentialId ? "identified" : "legacy") + " credential",
        async () => {
          const auth = expiredAuth({ credentialId });
          deps.providersConfig = { openai: { codexOauth: auth } };
          mockFetch(() =>
            Promise.resolve(
              mockRefreshResponse({
                access_token: "rotated-access",
                refresh_token: "rotated-refresh",
                expires_in: 3600,
              })
            )
          );
          const result = await service.getValidAuth("default", { credentialId });
          expect(result.success).toBe(true);
          if (result.success) {
            expect(result.data.access).toBe("rotated-access");
            expect(result.data.refresh).toBe("rotated-refresh");
            expect(result.data.credentialId).toBe(credentialId);
          }
        }
      );
    }

    it("does not let an invalid alias authorize a legacy snapshot", async () => {
      const auth = validAuth();
      for (const legacyCredentialId of [
        auth.credentialId,
        undefined,
        null,
        "invalid",
        42,
        "50e00a32-b964-4ce2-b131-6b53356ce2db",
      ]) {
        deps.providersConfig = { openai: { codexOauth: { ...auth, legacyCredentialId } } };
        const pinned = await service.getValidAuth("default", { credentialId: undefined });
        expect(pinned.success).toBe(legacyCredentialId === auth.credentialId);
        expect(
          (await service.getValidAuth("default", { credentialId: auth.credentialId })).success
        ).toBe(true);
        expect(
          (
            await service.getValidAuth("default", {
              credentialId: "81df6409-6a24-4a19-950e-7daf7ef47c4e",
            })
          ).success
        ).toBe(false);
      }
    });

    it("returns stored auth when token is not expired", async () => {
      const auth = validAuth();
      deps.providersConfig = { openai: { codexOauth: auth } };

      const result = await service.getValidAuth();
      expect(result.success).toBe(true);
      if (result.success) {
        expect(result.data.access).toBe(auth.access);
      }
    });
  });

  // -------------------------------------------------------------------------
  // Token refresh coalescing (AsyncMutex)
  // -------------------------------------------------------------------------

  describe("token refresh coalescing", () => {
    it("only triggers one refresh for concurrent getValidAuth calls with expired tokens", async () => {
      const expired = expiredAuth();
      deps.providersConfig = { openai: { codexOauth: expired } };

      let fetchCallCount = 0;
      const newAccessToken = fakeJwt({ sub: "refreshed" });

      mockFetch(async () => {
        fetchCallCount++;
        // Simulate a small delay so both callers are waiting
        await new Promise((resolve) => setTimeout(resolve, 10));
        return mockRefreshResponse({
          access_token: newAccessToken,
          refresh_token: "rt_new",
          expires_in: 3600,
        });
      });

      // Fire 3 concurrent calls
      const results = await Promise.all([
        service.getValidAuth(),
        service.getValidAuth(),
        service.getValidAuth(),
      ]);

      // Only ONE fetch should have happened thanks to AsyncMutex
      expect(fetchCallCount).toBe(1);

      // All three results should be successful with the refreshed token
      for (const result of results) {
        expect(result.success).toBe(true);
        if (result.success) {
          expect(result.data.access).toBe(newAccessToken);
        }
      }
    });

    it("after refresh, all callers get the updated token", async () => {
      const expired = expiredAuth();
      deps.providersConfig = { openai: { codexOauth: expired } };

      const newAccessToken = fakeJwt({ sub: "refreshed_user" });

      mockFetch(() =>
        Promise.resolve(
          mockRefreshResponse({
            access_token: newAccessToken,
            refresh_token: "rt_updated",
            expires_in: 7200,
          })
        )
      );

      const result = await service.getValidAuth();
      expect(result.success).toBe(true);
      if (result.success) {
        expect(result.data.access).toBe(newAccessToken);
        expect(result.data.refresh).toBe("rt_updated");
      }

      // Verify the auth was persisted
      const persistCall = deps.setConfigValueCalls.find(
        (c) => c.provider === "openai" && c.keyPath[0] === "codexOauth" && c.value !== undefined
      );
      expect(persistCall).toBeDefined();
    });
  });

  // -------------------------------------------------------------------------
  // Invalid grant cleanup
  // -------------------------------------------------------------------------

  describe("invalid grant marking", () => {
    it.each(["invalid_grant", "Token has been revoked"])(
      "retains credential identity after %s",
      async (error) => {
        const expired = expiredAuth();
        deps.providersConfig = { openai: { codexOauth: expired } };
        mockFetch(() => Promise.resolve(mockRefreshResponse({ error }, 400)));
        expect((await service.getValidAuth()).success).toBe(false);
        expect(getCodexOauthAuth(deps.providersConfig.openai)).toEqual({
          ...expired,
          invalidReason: "invalid_grant",
        });
        expect(getCodexOauthAccounts(deps.providersConfig.openai)).toHaveLength(1);
      }
    );

    it.each([false, true])(
      "never returns or refreshes marked credentials (expired=%s)",
      async (expired) => {
        const auth = expired
          ? expiredAuth({ invalidReason: "invalid_grant" })
          : validAuth({ invalidReason: "invalid_grant" });
        const legacy = validAuth({ access: "other" });
        deps.providersConfig = {
          openai: {
            codexOauth: legacy,
            codexOauthAccounts: { work: { label: "Work", credentials: auth } },
            codexOauthDefaultAccountId: "work",
          },
        };
        let fetchCount = 0;
        mockFetch(() => {
          fetchCount++;
          return Promise.reject(new Error("Must not refresh"));
        });
        expect((await service.getValidAuth()).success).toBe(false);
        expect((await service.getValidAuth("work")).success).toBe(false);
        expect(await service.getValidAuth("default")).toEqual(Ok(legacy));
        expect(fetchCount).toBe(0);
        expect(getCodexOauthAccounts(deps.providersConfig.openai)).toHaveLength(2);
        expect(await service.disconnect("work")).toEqual(Ok(undefined));
        expect(getCodexOauthAuth(deps.providersConfig.openai, "work")).toBeNull();
      }
    );

    it("rejects a marker after the local refresh mutex without refreshing again", async () => {
      deps.providersConfig = { openai: { codexOauth: expiredAuth() } };
      const started = createDeferred<void>();
      const response = createDeferred<Response>();
      let fetchCount = 0;
      mockFetch(() => {
        fetchCount++;
        started.resolve(undefined);
        return response.promise;
      });
      const first = service.getValidAuth();
      await started.promise;
      const second = service.getValidAuth();
      response.resolve(mockRefreshResponse({ error: "invalid_grant" }, 400));
      expect((await first).success).toBe(false);
      expect((await second).success).toBe(false);
      expect((await service.getValidAuth()).success).toBe(false);
      expect(fetchCount).toBe(1);
      expect(await service.disconnect()).toEqual(Ok(undefined));
      expect(getCodexOauthAuth(deps.providersConfig.openai)).toBeNull();
    });
  });

  // -------------------------------------------------------------------------
  // disconnect
  // -------------------------------------------------------------------------

  describe("disconnect", () => {
    it("clears stored codexOauth via providerService.setConfigValue", async () => {
      const result = await service.disconnect();
      expect(result.success).toBe(true);
      expect(deps.setConfigValueCalls).toHaveLength(1);
      expect(deps.setConfigValueCalls[0]).toEqual({
        provider: "openai",
        keyPath: ["codexOauth"],
        value: undefined,
      });
    });
  });

  // -------------------------------------------------------------------------
  // Desktop flow basics
  // -------------------------------------------------------------------------

  describe("startDesktopFlow", () => {
    it("starts HTTP server and returns flowId + authorizeUrl", async () => {
      const result = await service.startDesktopFlow();
      expect(result.success).toBe(true);
      if (result.success) {
        expect(result.data.flowId).toBeTruthy();
        expect(result.data.authorizeUrl).toContain("https://auth.openai.com/oauth/authorize");
        expect(result.data.authorizeUrl).toContain("state=");
        expect(result.data.authorizeUrl).toContain("code_challenge=");
        expect(result.data.authorizeUrl).toContain("code_challenge_method=S256");
      }
    });

    it("authorize URL contains correct parameters", async () => {
      const result = await service.startDesktopFlow();
      expect(result.success).toBe(true);
      if (result.success) {
        const url = new URL(result.data.authorizeUrl);
        expect(url.searchParams.get("response_type")).toBe("code");
        expect(url.searchParams.get("redirect_uri")).toBe("http://localhost:1455/auth/callback");
        expect(url.searchParams.get("state")).toBe(result.data.flowId);
        expect(url.searchParams.get("originator")).toBe("mux");
      }
    });

    it("each flow gets a unique flowId", async () => {
      const first = await service.startDesktopFlow();
      expect(first.success).toBe(true);
      // Clean up the first server so the second can use port 1455
      if (first.success) {
        await service.cancelDesktopFlow(first.data.flowId);
      }

      const second = await service.startDesktopFlow();
      expect(second.success).toBe(true);
      if (first.success && second.success) {
        expect(first.data.flowId).not.toBe(second.data.flowId);
      }
    });
  });

  describe("cancelDesktopFlow", () => {
    it("resolves waitForDesktopFlow with cancellation error", async () => {
      const startResult = await service.startDesktopFlow();
      expect(startResult.success).toBe(true);
      if (!startResult.success) return;

      const flowId = startResult.data.flowId;

      // Start waiting (don't await yet)
      const waitPromise = service.waitForDesktopFlow(flowId, { timeoutMs: 5000 });

      // Cancel the flow
      await service.cancelDesktopFlow(flowId);

      const result = await waitPromise;
      expect(result.success).toBe(false);
      if (!result.success) {
        expect(result.error).toContain("cancelled");
      }
    });
  });

  // -------------------------------------------------------------------------
  // Token refresh preserves accountId
  // -------------------------------------------------------------------------

  describe("refresh preserves accountId", () => {
    it("keeps previous accountId when refreshed token has no account info", async () => {
      const expired = expiredAuth({ accountId: "acct_original" });
      deps.providersConfig = { openai: { codexOauth: expired } };

      // Refreshed token has no account id in JWT claims
      const newAccessToken = fakeJwt({ sub: "user" });

      mockFetch(() =>
        Promise.resolve(
          mockRefreshResponse({
            access_token: newAccessToken,
            refresh_token: "rt_new",
            expires_in: 3600,
          })
        )
      );

      const result = await service.getValidAuth();
      expect(result.success).toBe(true);
      if (result.success) {
        expect(result.data.accountId).toBe("acct_original");
      }
    });
  });

  // -------------------------------------------------------------------------
  // Refresh keeps old refresh token when server doesn't rotate it
  // -------------------------------------------------------------------------

  describe("refresh token rotation", () => {
    it("keeps old refresh token when server does not return a new one", async () => {
      const expired = expiredAuth({ refresh: "rt_keep_me" });
      deps.providersConfig = { openai: { codexOauth: expired } };

      mockFetch(() =>
        Promise.resolve(
          mockRefreshResponse({
            access_token: fakeJwt({ sub: "user" }),
            expires_in: 3600,
            // No refresh_token in response
          })
        )
      );

      const result = await service.getValidAuth();
      expect(result.success).toBe(true);
      if (result.success) {
        expect(result.data.refresh).toBe("rt_keep_me");
      }
    });
  });
  describe("account selection", () => {
    it("uses the global selection and an explicit override without falling back", async () => {
      const legacy = validAuth({ access: "legacy" });
      const work = validAuth({ access: "work", accountId: "chatgpt-work" });
      deps.providersConfig = {
        openai: {
          codexOauth: legacy,
          codexOauthAccounts: { work: { label: "Work", credentials: work } },
          codexOauthDefaultAccountId: "work",
        },
      };
      expect(await service.getValidAuth()).toEqual(Ok(work));
      expect(await service.getValidAuth("default")).toEqual(Ok(legacy));
      expect((await service.getValidAuth("missing")).success).toBe(false);
      expect(await service.disconnect("work")).toEqual(Ok(undefined));
      expect((await service.getValidAuth()).success).toBe(false);
      expect(await service.getValidAuth("default")).toEqual(Ok(legacy));
    });

    it("renames each slot and selects defaults without changing credentials", async () => {
      const legacy = validAuth();
      const work = validAuth({ refresh: "work" });
      deps.providersConfig = {
        openai: {
          codexOauth: legacy,
          codexOauthAccounts: { work: { label: "Work", credentials: work } },
        },
      };
      expect(await Effect.runPromise(service.renameAccountEffect("default", " Personal "))).toEqual(
        Ok(undefined)
      );
      expect(await service.renameAccount("work", " Team ")).toEqual(Ok(undefined));
      expect(await Effect.runPromise(service.setDefaultAccountEffect("work"))).toEqual(
        Ok(undefined)
      );
      expect(getCodexOauthAccounts(deps.providersConfig.openai)).toEqual([
        { id: "default", label: "Personal", auth: legacy },
        { id: "work", label: "Team", auth: work },
      ]);
      expect(await service.getValidAuth()).toEqual(Ok(work));
      expect((await service.setDefaultAccount("missing")).success).toBe(false);
      expect((await service.renameAccount("missing", "Name")).success).toBe(false);
    });

    it("enforces policy for account edits and token refresh", async () => {
      const stored = expiredAuth();
      deps.providersConfig = { openai: { codexOauth: stored } };
      deps.policyDenied = true;
      expect((await service.setDefaultAccount("default")).success).toBe(false);
      expect((await service.renameAccount("default", "Renamed")).success).toBe(false);
      expect((await service.disconnect()).success).toBe(false);
      mockFetch(() =>
        Promise.resolve(mockRefreshResponse({ access_token: "refreshed", expires_in: 3600 }))
      );
      expect((await service.getValidAuth()).success).toBe(false);
      expect(getCodexOauthAuth(deps.providersConfig.openai)).toEqual(stored);
      expect(deps.setConfigValueCalls).toHaveLength(0);
    });

    it("enforces policy when a revoked refresh attempts to mark credentials", async () => {
      const stored = expiredAuth();
      deps.providersConfig = { openai: { codexOauth: stored } };
      deps.policyDenied = true;
      mockFetch(() => Promise.resolve(mockRefreshResponse({ error: "invalid_grant" }, 400)));
      expect((await service.getValidAuth()).success).toBe(false);
      expect(getCodexOauthAuth(deps.providersConfig.openai)).toEqual(stored);
      expect(deps.setConfigValueCalls).toHaveLength(0);
    });

    it("rejects unsafe slot IDs and invalid labels before storage writes", async () => {
      for (const id of ["", "__proto__", "constructor", "prototype", "../bad", "x".repeat(201)]) {
        expect((await service.disconnect(id)).success).toBe(false);
        expect((await service.setDefaultAccount(id)).success).toBe(false);
        expect((await service.renameAccount(id, "Name")).success).toBe(false);
        expect((await service.startDeviceFlow({ accountId: id })).success).toBe(false);
        expect((await service.startDesktopFlow({ accountId: id })).success).toBe(false);
      }
      for (const label of [" ", "x".repeat(101)]) {
        expect((await service.renameAccount("default", label)).success).toBe(false);
        expect((await service.startDeviceFlow({ label })).success).toBe(false);
      }
      expect((await service.startDeviceFlow({ accountId: "default", label: "Name" })).success).toBe(
        false
      );
      expect(deps.setConfigValueCalls).toHaveLength(0);
    });
  });

  describe("account refresh isolation", () => {
    it.each([
      { change: "rotation", accepted: true },
      { change: "replacement", accepted: false },
      { change: "expired replacement", accepted: false },
      { change: "dropped ID", accepted: false },
      { change: "legacy rotation", accepted: true },
      { change: "legacy stamp", accepted: false },
      { change: "marked", accepted: false },
      { change: "removed", accepted: false },
    ])("checks the pinned credential after lease wait: $change", async ({ change, accepted }) => {
      const initial = expiredAuth(change.startsWith("legacy") ? { credentialId: undefined } : {});
      const latest = validAuth({
        ...initial,
        access: "updated",
        expires: change === "expired replacement" ? Date.now() - 1000 : Date.now() + 3600000,
        credentialId:
          change.includes("replacement") || change === "legacy stamp"
            ? "50e00a32-b964-4ce2-b131-6b53356ce2db"
            : change === "dropped ID"
              ? undefined
              : initial.credentialId,
        invalidReason: change === "marked" ? "invalid_grant" : undefined,
      });
      const provider = new ProviderService(new Config(deps.rootDir));
      const store = provider.providersConfigStore;
      store.saveProvidersConfig({ openai: { codexOauth: initial } });
      const entered = createDeferred<void>();
      const release = createDeferred<void>();
      const attempted = createDeferred<void>();
      const holder = new FileLeaseManager(deps.rootDir).withCodexOauthRefreshLock(
        "default",
        async () => {
          entered.resolve(undefined);
          await release.promise;
        }
      );
      await entered.promise;
      class ObservedLeaseManager extends FileLeaseManager {
        override withCodexOauthRefreshLock<T>(
          accountId: string,
          fn: () => Promise<T> | T
        ): Promise<T> {
          attempted.resolve(undefined);
          return super.withCodexOauthRefreshLock(accountId, fn);
        }
      }
      const waiting = new CodexOauthService(
        store,
        provider,
        undefined,
        new ObservedLeaseManager(deps.rootDir)
      );
      let fetchCount = 0;
      mockFetch(() => {
        fetchCount++;
        return Promise.reject(new Error("Unexpected refresh"));
      });
      try {
        const pending = waiting.getValidAuth();
        await attempted.promise;
        store.saveProvidersConfig({ openai: change === "removed" ? {} : { codexOauth: latest } });
        release.resolve(undefined);
        await holder;
        const result = await pending;
        expect(result.success).toBe(accepted);
        if (accepted) expect(result).toEqual(Ok(latest));
        expect(fetchCount).toBe(0);
      } finally {
        release.resolve(undefined);
        await holder;
        await waiting.dispose();
      }
    });

    it("does not adopt a replaced credential after waiting for the local mutex", async () => {
      deps.providersConfig = { openai: { codexOauth: expiredAuth() } };
      const started = createDeferred<void>();
      const response = createDeferred<Response>();
      let fetchCount = 0;
      mockFetch(() => {
        fetchCount++;
        started.resolve(undefined);
        return response.promise;
      });
      const first = service.getValidAuth();
      await started.promise;
      const waiting = service.getValidAuth();
      deps.providersConfig.openai.codexOauth = validAuth({
        credentialId: "50e00a32-b964-4ce2-b131-6b53356ce2db",
      });
      response.resolve(mockRefreshResponse({ access_token: "old-rotation", expires_in: 3600 }));
      expect((await first).success).toBe(false);
      expect((await waiting).success).toBe(false);
      expect(fetchCount).toBe(1);
    });

    it("shares a refresh lease across service instances and persists the rotated token", async () => {
      const store = new ProvidersConfigStore(deps.rootDir);
      store.saveProvidersConfig({
        openai: {
          codexOauthAccounts: {
            work: { label: "Work", credentials: expiredAuth({ refresh: "old" }) },
          },
        },
      });
      const secondAttempt = createDeferred<void>();
      class ObservedLeaseManager extends FileLeaseManager {
        override withCodexOauthRefreshLock<T>(
          accountId: string,
          fn: () => Promise<T> | T
        ): Promise<T> {
          secondAttempt.resolve(undefined);
          return super.withCodexOauthRefreshLock(accountId, fn);
        }
      }
      const firstService = new CodexOauthService(
        store,
        new ProviderService(new Config(deps.rootDir))
      );
      const secondService = new CodexOauthService(
        new ProvidersConfigStore(deps.rootDir),
        new ProviderService(new Config(deps.rootDir)),
        undefined,
        new ObservedLeaseManager(deps.rootDir)
      );
      const refreshStarted = createDeferred<void>();
      const refreshResponse = createDeferred<Response>();
      let refreshCount = 0;
      mockFetch(() => {
        refreshCount++;
        refreshStarted.resolve(undefined);
        return refreshResponse.promise;
      });
      try {
        const first = firstService.getValidAuth("work");
        await refreshStarted.promise;
        const second = secondService.getValidAuth("work");
        await secondAttempt.promise;
        refreshResponse.resolve(
          mockRefreshResponse({
            access_token: "refreshed",
            refresh_token: "rotated",
            expires_in: 3600,
          })
        );
        const results = await Promise.all([first, second]);
        expect(results[0].success).toBe(true);
        expect(results[1]).toEqual(results[0]);
        expect(refreshCount).toBe(1);
        expect(
          getCodexOauthAuth(
            new ProvidersConfigStore(deps.rootDir).loadProvidersConfig()?.openai,
            "work"
          )?.refresh
        ).toBe("rotated");
      } finally {
        await firstService.dispose();
        await secondService.dispose();
      }
    });

    it("refreshes two accounts concurrently and keeps both writes", async () => {
      deps.providersConfig = {
        openai: {
          codexOauth: expiredAuth({ refresh: "legacy" }),
          codexOauthAccounts: {
            work: { label: "Work", credentials: expiredAuth({ refresh: "work" }) },
          },
        },
      };
      const bothStarted = createDeferred<void>();
      const release = createDeferred<void>();
      let count = 0;
      mockFetch(async (_input, init) => {
        if (++count === 2) bothStarted.resolve(undefined);
        await release.promise;
        const token = new URLSearchParams(requestBody(init)).get("refresh_token");
        return mockRefreshResponse({ access_token: token + "-new", expires_in: 3600 });
      });
      const legacy = service.getValidAuth();
      const work = service.getValidAuth("work");
      await bothStarted.promise;
      release.resolve(undefined);
      expect((await legacy).success).toBe(true);
      expect((await work).success).toBe(true);
      expect(getCodexOauthAuth(deps.providersConfig.openai, "default")?.access).toBe("legacy-new");
      expect(getCodexOauthAuth(deps.providersConfig.openai, "work")?.access).toBe("work-new");
    });

    it("pins the default while a refresh runs and preserves the ChatGPT identity", async () => {
      deps.providersConfig = {
        openai: {
          codexOauth: expiredAuth({ accountId: "chatgpt-original" }),
          codexOauthAccounts: {
            work: { label: "Work", credentials: validAuth({ access: "work" }) },
          },
        },
      };
      const started = createDeferred<void>();
      const response = createDeferred<Response>();
      mockFetch(() => {
        started.resolve(undefined);
        return response.promise;
      });
      const pending = service.getValidAuth();
      await started.promise;
      expect(await service.setDefaultAccount("work")).toEqual(Ok(undefined));
      response.resolve(
        mockRefreshResponse({
          access_token: fakeJwt({ chatgpt_account_id: "chatgpt-other" }),
          expires_in: 3600,
        })
      );
      const result = await pending;
      expect(result.success).toBe(true);
      if (result.success) expect(result.data.accountId).toBe("chatgpt-original");
      expect(getCodexOauthAuth(deps.providersConfig.openai, "work")?.access).toBe("work");
    });

    it.each([200, 400])(
      "does not overwrite a reconnect after an old refresh returns %s",
      async (status) => {
        deps.providersConfig = { openai: { codexOauth: expiredAuth() } };
        const started = createDeferred<void>();
        const response = createDeferred<Response>();
        mockFetch(() => {
          started.resolve(undefined);
          return response.promise;
        });
        const pending = service.getValidAuth();
        await started.promise;
        // A separate process changes the same slot without this service's revision map.
        const reconnected = validAuth({ access: "reconnected", refresh: "new-session" });
        deps.providersConfig.openai.codexOauth = reconnected;
        response.resolve(
          mockRefreshResponse(
            status === 200
              ? { access_token: "stale", expires_in: 3600 }
              : { error: "invalid_grant" },
            status
          )
        );
        expect((await pending).success).toBe(false);
        expect(await service.getValidAuth()).toEqual(Ok(reconnected));
      }
    );

    it.each(["refresh", "disconnect"] as const)(
      "serializes disconnect and refresh when %s persists first",
      async (first) => {
        deps.providersConfig = {
          openai: { codexOauthAccounts: { work: { label: "Work", credentials: expiredAuth() } } },
        };
        const provider = createMockProviderService(deps);
        service = createService(deps, provider);
        const entered = createDeferred<void>();
        const release = createDeferred<void>();
        const fetchStarted = createDeferred<void>();
        const mutationOrder: string[] = [];
        const originalUpdate = provider.updateConfigValue;
        let calls = 0;
        const update = spyOn(provider, "updateConfigValue").mockImplementation(async (...args) => {
          const isFirst = ++calls === 1;
          if (isFirst) {
            entered.resolve(undefined);
            await release.promise;
          }
          mutationOrder.push(isFirst ? first : first === "refresh" ? "disconnect" : "refresh");
          return originalUpdate(...args);
        });
        mockFetch(() => {
          fetchStarted.resolve(undefined);
          return Promise.resolve(
            mockRefreshResponse({ access_token: "rotated", expires_in: 3600 })
          );
        });
        try {
          const initial =
            first === "refresh" ? service.getValidAuth("work") : service.disconnect("work");
          await entered.promise;
          const waiting =
            first === "refresh" ? service.disconnect("work") : service.getValidAuth("work");
          await fetchStarted.promise;
          release.resolve(undefined);
          const [initialResult, waitingResult] = await Promise.all([initial, waiting]);
          const disconnected = first === "disconnect" ? initialResult : waitingResult;
          expect(disconnected).toEqual(Ok(undefined));
          expect(mutationOrder).toEqual(
            first === "refresh" ? ["refresh", "disconnect"] : ["disconnect", "refresh"]
          );
          if (first === "disconnect") expect(waitingResult.success).toBe(false);
          expect(getCodexOauthAuth(deps.providersConfig.openai, "work")).toBeNull();
        } finally {
          release.resolve(undefined);
          update.mockRestore();
        }
      }
    );

    it("does not restore a disconnected slot after refresh", async () => {
      const work = expiredAuth();
      const legacy = validAuth({ access: "legacy" });
      deps.providersConfig = {
        openai: {
          codexOauth: legacy,
          codexOauthAccounts: { work: { label: "Work", credentials: work } },
        },
      };
      const started = createDeferred<void>();
      const response = createDeferred<Response>();
      mockFetch(() => {
        started.resolve(undefined);
        return response.promise;
      });
      const pending = service.getValidAuth("work");
      await started.promise;
      await service.disconnect("work");
      response.resolve(mockRefreshResponse({ access_token: "stale", expires_in: 3600 }));
      expect((await pending).success).toBe(false);
      expect(getCodexOauthAuth(deps.providersConfig.openai, "work")).toBeNull();
      expect(await service.getValidAuth("default")).toEqual(Ok(legacy));
    });

    it("keeps a concurrent rename when refreshed credentials persist", async () => {
      deps.providersConfig = {
        openai: { codexOauthAccounts: { work: { label: "Work", credentials: expiredAuth() } } },
      };
      const started = createDeferred<void>();
      const response = createDeferred<Response>();
      mockFetch(() => {
        started.resolve(undefined);
        return response.promise;
      });
      const pending = service.getValidAuth("work");
      await started.promise;
      await service.renameAccount("work", "Team");
      response.resolve(mockRefreshResponse({ access_token: "new", expires_in: 3600 }));
      expect((await pending).success).toBe(true);
      expect(getCodexOauthAccounts(deps.providersConfig.openai)[0].label).toBe("Team");
    });
  });

  describe("login destinations", () => {
    function activeLoginSelectionCount(): number {
      // Inspect retained credentials without exposing internal state through the service API.
      // eslint-disable-next-line @typescript-eslint/dot-notation -- Bracket access permits private state checks in tests.
      return service["loginSelections"].size;
    }

    function deviceFetch(exchange?: (init?: RequestInit) => Promise<Response>): void {
      let nextCode = 0;
      mockFetch(async (input, init) => {
        const url = input instanceof Request ? input.url : input.toString();
        if (url === CODEX_OAUTH_DEVICE_USERCODE_URL) {
          return mockRefreshResponse({
            device_auth_id: "device-" + ++nextCode,
            user_code: "code",
            interval: 1,
            expires_in: 60,
          });
        }
        if (url === CODEX_OAUTH_DEVICE_TOKEN_POLL_URL) {
          const body = JSON.parse(requestBody(init)) as { device_auth_id: string };
          return mockRefreshResponse({
            authorization_code: body.device_auth_id,
            code_verifier: "verifier",
          });
        }
        if (url === CODEX_OAUTH_TOKEN_URL) {
          if (exchange) return exchange(init);
          return mockRefreshResponse({
            access_token: "access-" + new URLSearchParams(requestBody(init)).get("code"),
            refresh_token: "refresh",
            expires_in: 3600,
          });
        }
        throw new Error("Unexpected fetch URL");
      });
    }

    for (const kind of ["desktop", "device"] as const) {
      for (const terminal of ["cancelled", "expired", "failed"] as const) {
        it("releases " + terminal + " named " + kind + " login selections", async () => {
          deviceFetch(() => Promise.resolve(mockRefreshResponse({ error: "access_denied" }, 400)));
          const flow =
            kind === "desktop"
              ? await service.startDesktopFlow({ label: "Work" })
              : await service.startDeviceFlow({ label: "Work" });
          if (!flow.success) throw new Error(flow.error);
          // Terminal flows must release selections because they retain credentials.
          expect(activeLoginSelectionCount()).toBe(1);
          const flowId = flow.data.flowId;
          if (kind === "desktop") {
            // eslint-disable-next-line @typescript-eslint/dot-notation -- Await the private cleanup signal without timing assumptions.
            const completion = service["desktopFlows"].get(flowId)!.resultDeferred.promise;
            if (terminal === "cancelled") await service.cancelDesktopFlow(flowId);
            if (terminal === "failed") {
              const response = await originalFetch(
                "http://localhost:1455/auth/callback?error=access_denied&state=" + flowId
              );
              await response.text();
            }
            const result = await service.waitForDesktopFlow(flowId, { timeoutMs: 0 });
            expect(result.success).toBe(false);
            // The flow manager releases resources in a detached fiber after a waiter timeout.
            await completion;
          } else {
            if (terminal === "cancelled") await service.cancelDeviceFlow(flowId);
            const clock =
              terminal === "expired"
                ? spyOn(Date, "now").mockReturnValue(Date.now() + 120_000)
                : undefined;
            try {
              const result = await service.waitForDeviceFlow(flowId);
              expect(result.success).toBe(false);
              if (terminal === "expired" && !result.success)
                expect(result.error).toContain("expired");
            } finally {
              clock?.mockRestore();
            }
          }
          expect(activeLoginSelectionCount()).toBe(0);
          expect(getCodexOauthAccounts(deps.providersConfig.openai)).toEqual([]);
        });
      }

      it("keeps the newer selection when a superseded " + kind + " flow terminates", async () => {
        deps.providersConfig = {
          openai: { codexOauthAccounts: { work: { label: "Work", credentials: validAuth() } } },
        };
        deviceFetch();
        const first =
          kind === "desktop"
            ? await service.startDesktopFlow({ accountId: "work" })
            : await service.startDeviceFlow({ accountId: "work" });
        if (!first.success) throw new Error(first.error);
        const second = await service.startDeviceFlow({ accountId: "work" });
        if (!second.success) throw new Error(second.error);
        if (kind === "desktop") await service.cancelDesktopFlow(first.data.flowId);
        else await service.cancelDeviceFlow(first.data.flowId);
        expect(activeLoginSelectionCount()).toBe(1);
        expect(await service.waitForDeviceFlow(second.data.flowId)).toEqual(Ok(undefined));
        expect(activeLoginSelectionCount()).toBe(0);
        const auth = await service.getValidAuth("work");
        expect(auth.success).toBe(true);
        if (auth.success)
          expect(auth.data.access).toBe(kind === "desktop" ? "access-device-1" : "access-device-2");
      });
    }

    it("does not save login credentials when policy denies provider edits", async () => {
      deps.policyDenied = true;
      deviceFetch();
      const flow = await service.startDeviceFlow({ label: "Work" });
      if (!flow.success) throw new Error(flow.error);
      expect((await service.waitForDeviceFlow(flow.data.flowId)).success).toBe(false);
      expect(getCodexOauthAccounts(deps.providersConfig.openai)).toEqual([]);
      expect(deps.setConfigValueCalls).toHaveLength(0);
    });

    for (const action of ["rename", "refresh", "stamp", "reconnect"] as const) {
      it.each([undefined, 42, " ", " Work "])(
        "drops unsafe disk fields during " + action + " with label %s",
        async (label) => {
          const credentials = validAuth({
            credentialId: action === "stamp" ? undefined : validAuth().credentialId,
            expires: action === "refresh" ? 0 : Date.now() + 3_600_000,
          });
          const store = new ProvidersConfigStore(deps.rootDir);
          const document = {
            openai: {
              codexOauthAccounts: {
                work: { label, credentials, auth: { access: "unsafe-copy" } },
              },
            },
          };
          // Manual disk damage bypasses write validation. Loading must still permit account recovery.
          await fs.promises.writeFile(store.providersFile, JSON.stringify(document));
          service = new CodexOauthService(store, new ProviderService(new Config(deps.rootDir)));
          const expectedLabel = typeof label === "string" && label.trim() ? label.trim() : "work";
          expect(getCodexOauthAccounts(store.loadProvidersConfig()?.openai)).toEqual([
            { id: "work", label: expectedLabel, auth: credentials },
          ]);
          deviceFetch(() =>
            Promise.resolve(
              mockRefreshResponse({
                access_token: "updated",
                refresh_token: "updated-refresh",
                expires_in: 3600,
              })
            )
          );
          if (action === "rename") {
            expect(await service.renameAccount("work", "Renamed")).toEqual(Ok(undefined));
          } else if (action === "refresh") {
            expect(await service.getValidAuth("work")).toMatchObject({
              success: true,
              data: { access: "updated" },
            });
          } else {
            const flow = await service.startDeviceFlow({ accountId: "work" });
            if (!flow.success) throw new Error(flow.error);
            if (action === "stamp") await service.cancelDeviceFlow(flow.data.flowId);
            else expect(await service.waitForDeviceFlow(flow.data.flowId)).toEqual(Ok(undefined));
          }
          const saved = store.loadProvidersConfig()?.openai;
          expect(saved?.codexOauthAccounts).toEqual({
            work: {
              label: action === "rename" ? "Renamed" : expectedLabel,
              credentials: getCodexOauthAuth(saved, "work"),
            },
          });
          expect(await fs.promises.readFile(store.providersFile, "utf8")).not.toContain(
            "unsafe-copy"
          );
        }
      );
    }

    it("creates a named slot and selects the first account globally", async () => {
      deviceFetch();
      const flow = await service.startDeviceFlow({ label: " Personal " });
      if (!flow.success) throw new Error(flow.error);
      expect(await service.waitForDeviceFlow(flow.data.flowId)).toEqual(Ok(undefined));
      const accounts = getCodexOauthAccounts(deps.providersConfig.openai);
      expect(accounts).toHaveLength(1);
      expect(accounts[0].id).not.toBe("default");
      expect(accounts[0].label).toBe("Personal");
      // Persist one protected credential object, without a second token copy under auth.
      expect(deps.providersConfig.openai?.codexOauthAccounts).toEqual({
        [accounts[0].id]: { label: "Personal", credentials: accounts[0].auth },
      });
      expect(await service.getValidAuth()).toEqual(Ok(accounts[0].auth));
      expect(deps.providersConfig.openai?.codexOauth).toBeUndefined();
    });

    it("keeps concurrent named logins in separate slots", async () => {
      deps.providersConfig = { openai: { codexOauth: validAuth({ access: "legacy" }) } };
      deviceFetch();
      const first = await service.startDeviceFlow({ label: "One" });
      const second = await service.startDeviceFlow({ label: "Two" });
      if (!first.success || !second.success) throw new Error("Login start failed");
      expect(await service.setDefaultAccount("default")).toEqual(Ok(undefined));
      const results = await Promise.all([
        service.waitForDeviceFlow(first.data.flowId),
        service.waitForDeviceFlow(second.data.flowId),
      ]);
      expect(results.every((result) => result.success)).toBe(true);
      const accounts = getCodexOauthAccounts(deps.providersConfig.openai);
      expect(accounts).toHaveLength(3);
      expect(new Set(accounts.map((account) => account.id)).size).toBe(3);
      expect(accounts.map((account) => account.auth.access).sort()).toEqual([
        "access-device-1",
        "access-device-2",
        "legacy",
      ]);
      expect(getCodexOauthAuth(deps.providersConfig.openai)?.access).toBe("legacy");
    });

    it("selects one account when the first named logins finish concurrently", async () => {
      deviceFetch();
      const first = await service.startDeviceFlow({ label: "One" });
      const second = await service.startDeviceFlow({ label: "Two" });
      if (!first.success || !second.success) throw new Error("Login start failed");
      const results = await Promise.all([
        service.waitForDeviceFlow(first.data.flowId),
        service.waitForDeviceFlow(second.data.flowId),
      ]);
      expect(results.every((result) => result.success)).toBe(true);
      expect(getCodexOauthAccounts(deps.providersConfig.openai)).toHaveLength(2);
      expect((await service.getValidAuth()).success).toBe(true);
    });

    it("pins a named desktop login while the global default changes", async () => {
      const legacy = validAuth({ access: "legacy" });
      deps.providersConfig = { openai: { codexOauth: legacy } };
      mockFetch(() =>
        Promise.resolve(
          mockRefreshResponse({
            access_token: "desktop",
            refresh_token: "desktop-refresh",
            expires_in: 3600,
          })
        )
      );
      const flow = await service.startDesktopFlow({ label: "Desktop" });
      if (!flow.success) throw new Error(flow.error);
      await service.setDefaultAccount("default");
      const callback = await originalFetch(
        "http://localhost:1455/auth/callback?code=auth-code&state=" + flow.data.flowId
      );
      expect(callback.ok).toBe(true);
      await callback.text();
      expect(await service.waitForDesktopFlow(flow.data.flowId)).toEqual(Ok(undefined));
      const accounts = getCodexOauthAccounts(deps.providersConfig.openai);
      expect(accounts).toHaveLength(2);
      expect(accounts[1].auth.access).toBe("desktop");
      expect(accounts[1].label).toBe("Desktop");
      expect(await service.getValidAuth()).toEqual(Ok(legacy));
    });

    it("keeps no-argument login in the legacy slot despite a named default", async () => {
      const work = validAuth({ access: "work" });
      deps.providersConfig = {
        openai: {
          codexOauthAccounts: { work: { label: "Work", credentials: work } },
          codexOauthDefaultAccountId: "work",
        },
      };
      deviceFetch();
      const flow = await service.startDeviceFlow();
      if (!flow.success) throw new Error(flow.error);
      expect(await service.waitForDeviceFlow(flow.data.flowId)).toEqual(Ok(undefined));
      expect(getCodexOauthAuth(deps.providersConfig.openai, "default")?.access).toBe(
        "access-device-1"
      );
      expect(await service.getValidAuth()).toEqual(Ok(work));
    });

    it.each(["policy", "I/O"] as const)(
      "keeps pending refresh and reconnect valid after a failed %s disconnect",
      async (failure) => {
        const initial = expiredAuth();
        deps.providersConfig = {
          openai: { codexOauthAccounts: { work: { label: "Work", credentials: initial } } },
        };
        const provider = createMockProviderService(deps);
        service = createService(deps, provider);
        const refreshStarted = createDeferred<void>();
        const loginStarted = createDeferred<void>();
        const refreshResponse = createDeferred<Response>();
        const loginResponse = createDeferred<Response>();
        deviceFetch((init) => {
          if (new URLSearchParams(requestBody(init)).get("grant_type") === "refresh_token") {
            refreshStarted.resolve(undefined);
            return refreshResponse.promise;
          }
          loginStarted.resolve(undefined);
          return loginResponse.promise;
        });
        const flow = await service.startDeviceFlow({ accountId: "work" });
        if (!flow.success) throw new Error(flow.error);
        const login = service.waitForDeviceFlow(flow.data.flowId);
        await loginStarted.promise;
        const refresh = service.getValidAuth("work");
        await refreshStarted.promise;
        const update = spyOn(provider, "updateConfigValue");
        if (failure === "policy") deps.policyDenied = true;
        else update.mockRejectedValueOnce(new Error("Disk write failed"));
        const disconnected = await service.disconnect("work");
        const afterFailure = getCodexOauthAuth(deps.providersConfig.openai, "work");
        deps.policyDenied = false;
        update.mockRestore();
        refreshResponse.resolve(
          mockRefreshResponse({
            access_token: "rotated",
            refresh_token: "rotated-refresh",
            expires_in: 3600,
          })
        );
        const refreshed = await refresh;
        loginResponse.resolve(
          mockRefreshResponse({
            access_token: "reconnected",
            refresh_token: "reconnected-refresh",
            expires_in: 3600,
          })
        );
        const reconnected = await login;
        expect(disconnected).toEqual(
          Err(failure === "policy" ? "Provider edits are disabled" : "Disk write failed")
        );
        expect(afterFailure).toEqual(initial);
        expect(refreshed).toMatchObject({ success: true, data: { access: "rotated" } });
        expect(reconnected).toEqual(Ok(undefined));
        expect(getCodexOauthAuth(deps.providersConfig.openai, "work")?.access).toBe("reconnected");
      }
    );

    it.each(["disconnect", "cancel"])("does not persist an exchange after %s", async (action) => {
      deps.providersConfig = {
        openai: { codexOauthAccounts: { work: { label: "Work", credentials: validAuth() } } },
      };
      const started = createDeferred<void>();
      const response = createDeferred<Response>();
      deviceFetch(() => {
        started.resolve(undefined);
        return response.promise;
      });
      const flow = await service.startDeviceFlow({ accountId: "work" });
      if (!flow.success) throw new Error(flow.error);
      const pending = service.waitForDeviceFlow(flow.data.flowId);
      await started.promise;
      if (action === "disconnect") await service.disconnect("work");
      else await service.cancelDeviceFlow(flow.data.flowId);
      const writeCount = deps.setConfigValueCalls.length;
      const compared = createDeferred<void>();
      deps.onUpdate = () => compared.resolve(undefined);
      response.resolve(
        mockRefreshResponse({ access_token: "stale", refresh_token: "stale", expires_in: 3600 })
      );
      expect((await pending).success).toBe(false);
      await compared.promise;
      deps.onUpdate = undefined;
      expect(getCodexOauthAuth(deps.providersConfig.openai, "work")?.access).not.toBe("stale");
      if (action === "disconnect") expect(deps.setConfigValueCalls).toHaveLength(writeCount);
    });

    it("keeps refreshed credentials when a concurrent reconnect is cancelled", async () => {
      deps.providersConfig = {
        openai: {
          codexOauthAccounts: {
            work: { label: "Work", credentials: expiredAuth({ refresh: "old" }) },
          },
        },
      };
      const refreshStarted = createDeferred<void>();
      const refreshResponse = createDeferred<Response>();
      deviceFetch(() => {
        refreshStarted.resolve(undefined);
        return refreshResponse.promise;
      });
      const refresh = service.getValidAuth("work");
      await refreshStarted.promise;
      const flow = await service.startDeviceFlow({ accountId: "work" });
      if (!flow.success) throw new Error(flow.error);
      await service.cancelDeviceFlow(flow.data.flowId);
      refreshResponse.resolve(
        mockRefreshResponse({
          access_token: "refreshed",
          refresh_token: "rotated",
          expires_in: 3600,
        })
      );
      const result = await refresh;
      expect(result.success).toBe(true);
      expect(getCodexOauthAuth(deps.providersConfig.openai, "work")?.refresh).toBe("rotated");
      expect(await service.getValidAuth("work")).toEqual(result);
    });

    it("keeps refreshed credentials when reconnect startup fails", async () => {
      deps.providersConfig = { openai: { codexOauth: expiredAuth({ refresh: "old" }) } };
      const refreshStarted = createDeferred<void>();
      const refreshResponse = createDeferred<Response>();
      mockFetch((input) => {
        if (input === CODEX_OAUTH_DEVICE_USERCODE_URL)
          return Promise.reject(new Error("Request failed"));
        refreshStarted.resolve(undefined);
        return refreshResponse.promise;
      });
      const refresh = service.getValidAuth();
      await refreshStarted.promise;
      expect((await service.startDeviceFlow({ accountId: "default" })).success).toBe(false);
      refreshResponse.resolve(
        mockRefreshResponse({
          access_token: "refreshed",
          refresh_token: "rotated",
          expires_in: 3600,
        })
      );
      expect((await refresh).success).toBe(true);
      expect(getCodexOauthAuth(deps.providersConfig.openai)?.refresh).toBe("rotated");
    });

    it("lets only the latest reconnect attempt replace the same slot", async () => {
      deps.providersConfig = { openai: { codexOauth: validAuth() } };
      deviceFetch();
      const first = await service.startDeviceFlow({ accountId: "default" });
      const second = await service.startDeviceFlow({ accountId: "default" });
      if (!first.success || !second.success) throw new Error("Login start failed");
      expect((await service.waitForDeviceFlow(first.data.flowId)).success).toBe(false);
      expect(await service.waitForDeviceFlow(second.data.flowId)).toEqual(Ok(undefined));
      expect(getCodexOauthAuth(deps.providersConfig.openai)?.access).toBe("access-device-2");
    });

    function sharedServices(auth: CodexOauthAuth, accountId = "work") {
      const provider = new ProviderService(new Config(deps.rootDir));
      const store = provider.providersConfigStore;
      store.saveProvidersConfig({
        openai:
          accountId === "default"
            ? { codexOauth: auth }
            : { codexOauthAccounts: { [accountId]: { label: "Work", credentials: auth } } },
      });
      return {
        provider,
        store,
        first: new CodexOauthService(store, provider),
        second: new CodexOauthService(
          new ProvidersConfigStore(deps.rootDir),
          new ProviderService(new Config(deps.rootDir))
        ),
      };
    }

    it.each(["default", "work"])(
      "reconnects a %s credential with a malformed durable ID",
      async (accountId) => {
        const auth = expiredAuth({ credentialId: "damaged-id" });
        deps.providersConfig = {
          openai:
            accountId === "default"
              ? { codexOauth: auth }
              : { codexOauthAccounts: { work: { label: "Work", credentials: auth } } },
        };
        deviceFetch();
        const flow = await service.startDeviceFlow({ accountId });
        if (!flow.success) throw new Error(flow.error);
        const stamped = getCodexOauthAuth(deps.providersConfig.openai, accountId);
        expect(stamped?.credentialId).toBeDefined();
        expect(stamped?.credentialId).not.toBe(auth.credentialId);
        expect(await service.waitForDeviceFlow(flow.data.flowId)).toEqual(Ok(undefined));
        const reconnected = await service.getValidAuth(accountId);
        expect(reconnected.success).toBe(true);
        if (reconnected.success) {
          expect(reconnected.data.credentialId).not.toBe(stamped?.credentialId);
        }
      }
    );

    for (const kind of ["desktop", "device"] as const) {
      it.each(["cancelled", "expired", "completed"] as const)(
        "preserves pinned legacy identity until " + kind + " reconnect is %s",
        async (terminal) => {
          const { store, first, second } = sharedServices(
            validAuth({ credentialId: undefined }),
            "default"
          );
          const snapshot = {
            credentialId: getCodexOauthAuth(store.loadProvidersConfig()?.openai, "default")
              ?.credentialId,
          };
          expect(snapshot.credentialId).toBeUndefined();
          deviceFetch();
          try {
            expect((await second.getValidAuth("default", snapshot)).success).toBe(true);
            const flow =
              kind === "desktop"
                ? await first.startDesktopFlow({ accountId: "default" })
                : await first.startDeviceFlow({ accountId: "default" });
            if (!flow.success) throw new Error(flow.error);
            const duringLogin = await second.getValidAuth("default", snapshot);
            if (kind === "desktop") {
              if (terminal === "cancelled") await first.cancelDesktopFlow(flow.data.flowId);
              else if (terminal === "expired") {
                expect(
                  (await first.waitForDesktopFlow(flow.data.flowId, { timeoutMs: 0 })).success
                ).toBe(false);
              } else {
                const callback = await originalFetch(
                  "http://localhost:1455/auth/callback?code=code&state=" + flow.data.flowId
                );
                await callback.text();
                expect(await first.waitForDesktopFlow(flow.data.flowId)).toEqual(Ok(undefined));
              }
            } else if (terminal === "cancelled") {
              await first.cancelDeviceFlow(flow.data.flowId);
            } else if (terminal === "expired") {
              const clock = spyOn(Date, "now").mockReturnValue(Date.now() + 120_000);
              try {
                expect((await first.waitForDeviceFlow(flow.data.flowId)).success).toBe(false);
              } finally {
                clock.mockRestore();
              }
            } else {
              expect(await first.waitForDeviceFlow(flow.data.flowId)).toEqual(Ok(undefined));
            }
            expect(duringLogin.success).toBe(true);
            const pinned = await second.getValidAuth("default", snapshot);
            expect(pinned.success).toBe(terminal !== "completed");
            expect((await second.getValidAuth("default")).success).toBe(true);
          } finally {
            await first.dispose();
            await second.dispose();
          }
        }
      );
    }

    it("preserves the legacy snapshot through backfill and cross-process token rotation", async () => {
      const { store, first, second } = sharedServices(expiredAuth({ credentialId: undefined }));
      const snapshot = { credentialId: undefined };
      deviceFetch(() =>
        Promise.resolve(
          mockRefreshResponse({
            access_token: "rotated",
            refresh_token: "rotated-refresh",
            expires_in: 3600,
          })
        )
      );
      try {
        const flow = await first.startDeviceFlow({ accountId: "work" });
        if (!flow.success) throw new Error(flow.error);
        await first.cancelDeviceFlow(flow.data.flowId);
        const result = await second.getValidAuth("work", snapshot);
        expect(result).toMatchObject({
          success: true,
          data: { access: "rotated", refresh: "rotated-refresh" },
        });
        expect(
          getCodexOauthAuth(store.loadProvidersConfig()?.openai, "work")?.credentialId
        ).toBeDefined();
        expect(await first.getValidAuth("work", snapshot)).toEqual(result);
      } finally {
        await first.dispose();
        await second.dispose();
      }
    });

    it("reconnects a marked legacy credential that has no durable ID", async () => {
      deps.providersConfig = {
        openai: {
          codexOauth: expiredAuth({ credentialId: undefined, invalidReason: "invalid_grant" }),
        },
      };
      deviceFetch();
      const flow = await service.startDeviceFlow({ accountId: "default" });
      if (!flow.success) throw new Error(flow.error);
      const stamped = getCodexOauthAuth(deps.providersConfig.openai);
      expect(stamped?.credentialId).toBeDefined();
      expect(stamped?.invalidReason).toBe("invalid_grant");
      expect(await service.waitForDeviceFlow(flow.data.flowId)).toEqual(Ok(undefined));
      const reconnected = await service.getValidAuth();
      expect(reconnected.success).toBe(true);
      if (reconnected.success) {
        expect(reconnected.data.invalidReason).toBeUndefined();
        expect(reconnected.data.credentialId).not.toBe(stamped?.credentialId);
      }
    });

    it("completes cross-process reconnect over the same credential's invalid marker", async () => {
      const initial = expiredAuth();
      const { store, first, second } = sharedServices(initial);
      deviceFetch((init) =>
        Promise.resolve(
          new URLSearchParams(requestBody(init)).get("grant_type") === "refresh_token"
            ? mockRefreshResponse({ error: "invalid_grant" }, 400)
            : mockRefreshResponse({
                access_token: "reconnected",
                refresh_token: "new-login",
                expires_in: 3600,
              })
        )
      );
      try {
        const flow = await first.startDeviceFlow({ accountId: "work" });
        if (!flow.success) throw new Error(flow.error);
        expect((await second.getValidAuth("work")).success).toBe(false);
        expect(getCodexOauthAuth(store.loadProvidersConfig()?.openai, "work")).toEqual({
          ...initial,
          invalidReason: "invalid_grant",
        });
        expect(await first.waitForDeviceFlow(flow.data.flowId)).toEqual(Ok(undefined));
        const result = await first.getValidAuth("work");
        expect(result.success).toBe(true);
        if (result.success) {
          expect(result.data.credentialId).not.toBe(initial.credentialId);
          expect(result.data.invalidReason).toBeUndefined();
          expect(result.data.access).toBe("reconnected");
        }
      } finally {
        await first.dispose();
        await second.dispose();
      }
    });

    it("does not invalidate a completed reconnect when an older process refresh fails", async () => {
      const { store, first, second } = sharedServices(expiredAuth());
      const started = createDeferred<void>();
      const response = createDeferred<Response>();
      deviceFetch((init) => {
        if (new URLSearchParams(requestBody(init)).get("grant_type") === "refresh_token") {
          started.resolve(undefined);
          return response.promise;
        }
        return Promise.resolve(
          mockRefreshResponse({
            access_token: "reconnected",
            refresh_token: "new-login",
            expires_in: 3600,
          })
        );
      });
      try {
        const refresh = second.getValidAuth("work");
        await started.promise;
        const flow = await first.startDeviceFlow({ accountId: "work" });
        if (!flow.success) throw new Error(flow.error);
        expect(await first.waitForDeviceFlow(flow.data.flowId)).toEqual(Ok(undefined));
        const reconnected = getCodexOauthAuth(store.loadProvidersConfig()?.openai, "work");
        response.resolve(mockRefreshResponse({ error: "invalid_grant" }, 400));
        expect((await refresh).success).toBe(false);
        expect(getCodexOauthAuth(store.loadProvidersConfig()?.openai, "work")).toEqual(reconnected);
        expect((await first.getValidAuth("work")).success).toBe(true);
      } finally {
        await first.dispose();
        await second.dispose();
      }
    });

    it("completes reconnect after another service refreshes the same credential", async () => {
      const initial = expiredAuth();
      const { store, first, second } = sharedServices(initial);
      deviceFetch((init) =>
        Promise.resolve(
          mockRefreshResponse({
            access_token:
              new URLSearchParams(requestBody(init)).get("grant_type") === "refresh_token"
                ? "rotated-access"
                : "login-access",
            refresh_token: "new-refresh",
            expires_in: 3600,
          })
        )
      );
      try {
        const flow = await first.startDeviceFlow({ accountId: "work" });
        if (!flow.success) throw new Error(flow.error);
        const refreshed = await second.getValidAuth("work");
        expect(refreshed.success).toBe(true);
        expect(getCodexOauthAuth(store.loadProvidersConfig()?.openai, "work")?.credentialId).toBe(
          initial.credentialId
        );
        expect(await first.waitForDeviceFlow(flow.data.flowId)).toEqual(Ok(undefined));
        const reconnected = getCodexOauthAuth(store.loadProvidersConfig()?.openai, "work");
        expect(reconnected?.access).toBe("login-access");
        expect(reconnected?.credentialId).toBeDefined();
        expect(reconnected?.credentialId).not.toBe(initial.credentialId);
      } finally {
        await first.dispose();
        await second.dispose();
      }
    });

    it.each([undefined, "1c9c50b0-d777-4dd2-998c-09c156ba9754"])(
      "lets the first completed reconnect replace credential %s",
      async (credentialId) => {
        const { store, first, second } = sharedServices(validAuth({ credentialId }));
        deviceFetch();
        try {
          const older = await first.startDeviceFlow({ accountId: "work" });
          const newer = await second.startDeviceFlow({ accountId: "work" });
          if (!older.success || !newer.success) throw new Error("Login start failed");
          expect(await first.waitForDeviceFlow(older.data.flowId)).toEqual(Ok(undefined));
          const winner = getCodexOauthAuth(store.loadProvidersConfig()?.openai, "work");
          expect((await second.waitForDeviceFlow(newer.data.flowId)).success).toBe(false);
          expect(getCodexOauthAuth(store.loadProvidersConfig()?.openai, "work")).toEqual(winner);
        } finally {
          await first.dispose();
          await second.dispose();
        }
      }
    );

    it.each(["removed", "recreated", "older-client"])(
      "rejects stale login after external %s credentials",
      async (change) => {
        const initial = validAuth();
        const { provider, store, first, second } = sharedServices(initial);
        deviceFetch();
        try {
          const flow = await first.startDeviceFlow({ accountId: "work" });
          if (!flow.success) throw new Error(flow.error);
          if (change !== "older-client") {
            await provider.setConfigValue("openai", ["codexOauthAccounts", "work"], undefined);
          }
          if (change !== "removed") {
            await provider.setConfigValue("openai", ["codexOauthAccounts", "work"], {
              label: "Work",
              credentials: {
                ...initial,
                credentialId:
                  change === "recreated" ? "50e00a32-b964-4ce2-b131-6b53356ce2db" : undefined,
              },
            });
          }
          const current = store.loadProvidersConfig()?.openai;
          expect((await first.waitForDeviceFlow(flow.data.flowId)).success).toBe(false);
          expect(store.loadProvidersConfig()?.openai).toEqual(current);
        } finally {
          await first.dispose();
          await second.dispose();
        }
      }
    );

    it("waits for an old credential refresh before assigning its durable login ID", async () => {
      const initial = expiredAuth({ credentialId: undefined });
      const { store, provider, first, second } = sharedServices(initial);
      const leaseAttempt = createDeferred<void>();
      class ObservedLeaseManager extends FileLeaseManager {
        override withCodexOauthRefreshLock<T>(
          accountId: string,
          fn: () => Promise<T> | T
        ): Promise<T> {
          leaseAttempt.resolve(undefined);
          return super.withCodexOauthRefreshLock(accountId, fn);
        }
      }
      const reconnectService = new CodexOauthService(
        store,
        provider,
        undefined,
        new ObservedLeaseManager(deps.rootDir)
      );
      const refreshStarted = createDeferred<void>();
      const response = createDeferred<Response>();
      deviceFetch(() => {
        refreshStarted.resolve(undefined);
        return response.promise;
      });
      try {
        const refresh = second.getValidAuth("work");
        await refreshStarted.promise;
        const startup = reconnectService.startDeviceFlow({ accountId: "work" });
        await leaseAttempt.promise;
        expect(
          getCodexOauthAuth(store.loadProvidersConfig()?.openai, "work")?.credentialId
        ).toBeUndefined();
        response.resolve(
          mockRefreshResponse({
            access_token: "rotated-access",
            refresh_token: "rotated-refresh",
            expires_in: 3600,
          })
        );
        expect((await refresh).success).toBe(true);
        const flow = await startup;
        if (!flow.success) throw new Error(flow.error);
        const stamped = getCodexOauthAuth(store.loadProvidersConfig()?.openai, "work");
        expect(stamped?.access).toBe("rotated-access");
        expect(stamped?.refresh).toBe("rotated-refresh");
        expect(stamped?.credentialId).toBeDefined();
        await reconnectService.cancelDeviceFlow(flow.data.flowId);
        expect(await first.getValidAuth("work")).toEqual(Ok(stamped!));
      } finally {
        await reconnectService.dispose();
        await first.dispose();
        await second.dispose();
      }
    });

    for (const startup of ["device", "desktop"] as const) {
      it.each([undefined, "damaged-id"])(
        `keeps legacy requests usable after failed ${startup} startup with ID %s`,
        async (credentialId) => {
          const auth = validAuth({ credentialId });
          deps.providersConfig = { openai: { codexOauth: auth } };
          if (startup === "device") {
            mockFetch(() => Promise.reject(new Error("Device startup failed")));
          } else {
            spyOn(http, "createServer").mockImplementationOnce(() => {
              throw new Error("Listener startup failed");
            });
          }
          const result =
            startup === "device"
              ? await service.startDeviceFlow({ accountId: "default" })
              : await service.startDesktopFlow({ accountId: "default" });
          expect(result.success).toBe(false);
          expect(deps.providersConfig.openai?.codexOauth).toEqual(auth);
          expect((await service.getValidAuth("default", { credentialId: undefined })).success).toBe(
            true
          );
        }
      );
    }

    it("closes the listener when the credential changes before its ID write", async () => {
      const { store, provider, first, second } = sharedServices(
        validAuth({ credentialId: undefined })
      );
      const replacement = validAuth({ refresh: "replacement" });
      const update = provider.updateProviderSection.bind(provider);
      const write = spyOn(provider, "updateProviderSection").mockImplementationOnce(
        (name, transform, options) => {
          store.saveProvidersConfig({
            openai: { codexOauthAccounts: { work: { label: "Work", credentials: replacement } } },
          });
          return update(name, transform, options);
        }
      );
      try {
        expect((await first.startDesktopFlow({ accountId: "work" })).success).toBe(false);
        expect(getCodexOauthAuth(store.loadProvidersConfig()?.openai, "work")).toEqual(replacement);
        // A second bind proves failed startup releases the listener.
        const retry = await first.startDesktopFlow({ accountId: "work" });
        if (!retry.success) throw new Error(retry.error);
        await first.cancelDesktopFlow(retry.data.flowId);
      } finally {
        write.mockRestore();
        await first.dispose();
        await second.dispose();
      }
    });

    it("releases the listener when a legacy ID write fails", async () => {
      const auth = validAuth({ credentialId: undefined });
      deps.providersConfig = { openai: { codexOauth: auth } };
      deps.policyDenied = true;
      expect((await service.startDesktopFlow({ accountId: "default" })).success).toBe(false);
      expect((await service.getValidAuth("default", { credentialId: undefined })).success).toBe(
        true
      );
      expect(deps.providersConfig.openai?.codexOauth).toEqual(auth);
      deps.policyDenied = false;
      const retry = await service.startDesktopFlow({ accountId: "default" });
      if (!retry.success) throw new Error(retry.error);
      await service.cancelDesktopFlow(retry.data.flowId);
    });

    it("rejects a revoked account as a new global default", async () => {
      deps.providersConfig = {
        openai: {
          codexOauth: validAuth(),
          codexOauthDefaultAccountId: "default",
          codexOauthAccounts: {
            work: { label: "Work", credentials: validAuth({ invalidReason: "invalid_grant" }) },
          },
        },
      };
      expect((await service.setDefaultAccount("work")).success).toBe(false);
      expect(deps.providersConfig.openai?.codexOauthDefaultAccountId).toBe("default");
    });

    it.each(["default", "work"])(
      "rejects an older %s startup that completes after its retry",
      async (accountId) => {
        const auth = validAuth();
        deps.providersConfig = {
          openai:
            accountId === "default"
              ? { codexOauth: auth }
              : { codexOauthAccounts: { work: { label: "Work", credentials: auth } } },
        };
        deviceFetch();
        const fetch = globalThis.fetch;
        const firstStarted = createDeferred<void>();
        const firstResponse = createDeferred<Response>();
        let starts = 0;
        mockFetch((input, init) => {
          if (input === CODEX_OAUTH_DEVICE_USERCODE_URL && starts++ === 0) {
            firstStarted.resolve(undefined);
            return firstResponse.promise;
          }
          return fetch(input, init);
        });
        const older = service.startDeviceFlow({ accountId });
        await firstStarted.promise;
        const newer = await service.startDeviceFlow({ accountId });
        if (!newer.success) throw new Error(newer.error);
        firstResponse.resolve(
          mockRefreshResponse({ device_auth_id: "older", user_code: "OLD", interval: 1 })
        );
        expect((await older).success).toBe(false);
        expect(await service.waitForDeviceFlow(newer.data.flowId)).toEqual(Ok(undefined));
      }
    );

    it("keeps the active device login when a newer device startup fails", async () => {
      deps.providersConfig = { openai: { codexOauth: validAuth() } };
      deviceFetch();
      const first = await service.startDeviceFlow({ accountId: "default" });
      if (!first.success) throw new Error(first.error);
      const workingFetch = globalThis.fetch;
      mockFetch((input, init) =>
        input === CODEX_OAUTH_DEVICE_USERCODE_URL
          ? Promise.reject(new Error("Device startup failed"))
          : workingFetch(input, init)
      );
      expect((await service.startDeviceFlow({ accountId: "default" })).success).toBe(false);
      expect(await service.waitForDeviceFlow(first.data.flowId)).toEqual(Ok(undefined));
    });

    it("keeps the active desktop login when the new listener cannot start", async () => {
      deps.providersConfig = { openai: { codexOauth: validAuth() } };
      deviceFetch();
      const first = await service.startDesktopFlow({ accountId: "default" });
      if (!first.success) throw new Error(first.error);
      const createServer = spyOn(http, "createServer").mockImplementationOnce(() => {
        throw new Error("Callback listener unavailable");
      });
      try {
        expect((await service.startDesktopFlow({ accountId: "default" })).success).toBe(false);
      } finally {
        createServer.mockRestore();
      }
      const response = await originalFetch(
        "http://localhost:1455/auth/callback?code=code&state=" + first.data.flowId
      );
      await response.text();
      expect(response.ok).toBe(true);
      expect(await service.waitForDesktopFlow(first.data.flowId)).toEqual(Ok(undefined));
    });

    it("completes a reconnect after a concurrent refresh persists first", async () => {
      deps.providersConfig = {
        openai: {
          codexOauthAccounts: {
            work: { label: "Work", credentials: expiredAuth({ refresh: "old" }) },
          },
        },
      };
      const refreshStarted = createDeferred<void>();
      const refreshResponse = createDeferred<Response>();
      const exchangeStarted = createDeferred<void>();
      const exchangeResponse = createDeferred<Response>();
      deviceFetch((init) => {
        if (new URLSearchParams(requestBody(init)).get("grant_type") === "refresh_token") {
          refreshStarted.resolve(undefined);
          return refreshResponse.promise;
        }
        exchangeStarted.resolve(undefined);
        return exchangeResponse.promise;
      });
      const refresh = service.getValidAuth("work");
      await refreshStarted.promise;
      const flow = await service.startDeviceFlow({ accountId: "work" });
      if (!flow.success) throw new Error(flow.error);
      const reconnect = service.waitForDeviceFlow(flow.data.flowId);
      await exchangeStarted.promise;
      refreshResponse.resolve(
        mockRefreshResponse({
          access_token: "refreshed",
          refresh_token: "rotated",
          expires_in: 3600,
        })
      );
      expect((await refresh).success).toBe(true);
      exchangeResponse.resolve(
        mockRefreshResponse({
          access_token: "reconnected",
          refresh_token: "new-login",
          expires_in: 3600,
        })
      );
      expect(await reconnect).toEqual(Ok(undefined));
      expect(getCodexOauthAuth(deps.providersConfig.openai, "work")?.refresh).toBe("new-login");
    });

    it.each([{ accounts: [] }, { accounts: null }, { accounts: 42 }])(
      "repairs a malformed account map during named login: %j",
      async ({ accounts }) => {
        const provider = new ProviderService(new Config(deps.rootDir));
        const store = provider.providersConfigStore;
        store.saveProvidersConfig({ openai: { codexOauthAccounts: accounts, apiKey: "keep-key" } });
        const realService = new CodexOauthService(store, provider);
        deviceFetch();
        try {
          const flow = await realService.startDeviceFlow({ label: "Work" });
          if (!flow.success) throw new Error(flow.error);
          expect(await realService.waitForDeviceFlow(flow.data.flowId)).toEqual(Ok(undefined));
          const openai = store.loadProvidersConfig()?.openai;
          const connected = getCodexOauthAccounts(openai);
          expect(connected).toHaveLength(1);
          expect(getCodexOauthAccountId(openai)).toBe(connected[0].id);
          expect(openai?.apiKey).toBe("keep-key");
        } finally {
          await realService.dispose();
        }
      }
    );

    it("does not leave a partial first login when saving the selected account fails", async () => {
      const provider = new ProviderService(new Config(deps.rootDir));
      const store = provider.providersConfigStore;
      store.saveProvidersConfig({ openai: { apiKey: "keep-key" } });
      const save = store.saveProvidersConfig.bind(store);
      const saveSpy = spyOn(store, "saveProvidersConfig").mockImplementation((config) => {
        // Fail the write that makes the new account the selected account.
        const openai = config.openai;
        if (
          getCodexOauthAccounts(openai).some(
            (account) => account.id === getCodexOauthAccountId(openai)
          )
        ) {
          throw new Error("Disk unavailable");
        }
        save(config);
      });
      const realService = new CodexOauthService(store, provider);
      deviceFetch();
      try {
        const flow = await realService.startDeviceFlow({ label: "Work" });
        if (!flow.success) throw new Error(flow.error);
        expect((await realService.waitForDeviceFlow(flow.data.flowId)).success).toBe(false);
        expect(store.loadProvidersConfig()?.openai).toEqual({ apiKey: "keep-key" });
      } finally {
        saveSpy.mockRestore();
        await realService.dispose();
      }
    });

    it("keeps a successful reconnect when an older refresh completes", async () => {
      deps.providersConfig = {
        openai: {
          codexOauthAccounts: {
            work: { label: "Work", credentials: expiredAuth({ refresh: "old" }) },
          },
        },
      };
      const refreshStarted = createDeferred<void>();
      const refreshResponse = createDeferred<Response>();
      deviceFetch((init) => {
        const body = new URLSearchParams(requestBody(init));
        if (body.get("grant_type") === "refresh_token") {
          refreshStarted.resolve(undefined);
          return refreshResponse.promise;
        }
        return Promise.resolve(
          mockRefreshResponse({
            access_token: "reconnected",
            refresh_token: "new",
            expires_in: 3600,
          })
        );
      });
      const refresh = service.getValidAuth("work");
      await refreshStarted.promise;
      const flow = await service.startDeviceFlow({ accountId: "work" });
      if (!flow.success) throw new Error(flow.error);
      expect(await service.waitForDeviceFlow(flow.data.flowId)).toEqual(Ok(undefined));
      refreshResponse.resolve(mockRefreshResponse({ access_token: "stale", expires_in: 3600 }));
      expect((await refresh).success).toBe(false);
      expect(getCodexOauthAuth(deps.providersConfig.openai, "work")?.access).toBe("reconnected");
    });

    it("lets a reconnect replace credentials without changing its label or another slot", async () => {
      const legacy = validAuth({ access: "legacy" });
      deps.providersConfig = {
        openai: {
          codexOauth: legacy,
          codexOauthAccounts: { work: { label: "Work", credentials: validAuth() } },
        },
      };
      deviceFetch();
      const flow = await service.startDeviceFlow({ accountId: "work" });
      if (!flow.success) throw new Error(flow.error);
      await service.renameAccount("work", "Team");
      expect(await service.waitForDeviceFlow(flow.data.flowId)).toEqual(Ok(undefined));
      expect(getCodexOauthAccounts(deps.providersConfig.openai)[1].label).toBe("Team");
      expect(getCodexOauthAuth(deps.providersConfig.openai, "work")?.access).toBe(
        "access-device-1"
      );
      expect(await service.getValidAuth()).toEqual(Ok(legacy));
    });
  });
});

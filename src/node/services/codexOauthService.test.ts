import type { ProvidersConfigStore } from "@/node/config";
import { describe, it, expect, beforeEach, afterEach } from "bun:test";

import type { Result } from "@/common/types/result";
import { Ok } from "@/common/types/result";
import type { ProvidersConfig } from "@/node/config";
import type { ProviderService } from "@/node/services/providerService";
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
  providersConfig: ProvidersConfig;
  setConfigValueCalls: Array<{ provider: string; keyPath: string[]; value: unknown }>;
  focusCalls: number;
}

function createMockDeps(): MockDeps {
  return {
    providersConfig: {},
    setConfigValueCalls: [],
    focusCalls: 0,
  };
}

function createMockProvidersConfigStore(
  deps: MockDeps
): Pick<ProvidersConfigStore, "loadProvidersConfig"> {
  return {
    loadProvidersConfig: () => deps.providersConfig,
  };
}

function createMockProviderService(deps: MockDeps): Pick<ProviderService, "setConfigValue"> {
  return {
    setConfigValue: (
      provider: string,
      keyPath: string[],
      value: unknown
    ): Promise<Result<void, string>> => {
      deps.setConfigValueCalls.push({ provider, keyPath, value });
      // Also update the in-memory config so readStoredAuth() sees the write
      if (provider === "openai" && keyPath[0] === "codexOauth") {
        if (value === undefined) {
          const openai = deps.providersConfig.openai;
          if (openai) {
            delete openai.codexOauth;
          }
        } else {
          deps.providersConfig.openai ??= {};
          deps.providersConfig.openai.codexOauth = value;
        }
      }
      return Promise.resolve(Ok(undefined));
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

function createService(deps: MockDeps): CodexOauthService {
  return new CodexOauthService(
    createMockProvidersConfigStore(deps) as ProvidersConfigStore,
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

  describe("invalid grant cleanup", () => {
    it("calls disconnect + clears stored auth on invalid_grant response", async () => {
      const expired = expiredAuth();
      deps.providersConfig = { openai: { codexOauth: expired } };

      mockFetch(() =>
        Promise.resolve(
          new Response(JSON.stringify({ error: "invalid_grant" }), {
            status: 400,
            headers: { "Content-Type": "application/json" },
          })
        )
      );

      const result = await service.getValidAuth();
      expect(result.success).toBe(false);

      // Should have called setConfigValue to clear auth (disconnect)
      const clearCall = deps.setConfigValueCalls.find(
        (c) => c.provider === "openai" && c.keyPath[0] === "codexOauth" && c.value === undefined
      );
      expect(clearCall).toBeDefined();
    });

    it("clears auth when error text contains 'revoked'", async () => {
      const expired = expiredAuth();
      deps.providersConfig = { openai: { codexOauth: expired } };

      mockFetch(() =>
        Promise.resolve(
          new Response("Token has been revoked", {
            status: 401,
          })
        )
      );

      const result = await service.getValidAuth();
      expect(result.success).toBe(false);

      const clearCall = deps.setConfigValueCalls.find(
        (c) => c.provider === "openai" && c.keyPath[0] === "codexOauth" && c.value === undefined
      );
      expect(clearCall).toBeDefined();
    });

    it("subsequent getValidAuth returns error after invalid_grant cleanup", async () => {
      const expired = expiredAuth();
      deps.providersConfig = { openai: { codexOauth: expired } };

      mockFetch(() =>
        Promise.resolve(
          new Response(JSON.stringify({ error: "invalid_grant" }), {
            status: 400,
            headers: { "Content-Type": "application/json" },
          })
        )
      );

      // First call triggers disconnect
      await service.getValidAuth();

      // Second call should see no stored auth
      const result = await service.getValidAuth();
      expect(result.success).toBe(false);
      if (!result.success) {
        expect(result.error).toContain("not configured");
      }
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
});

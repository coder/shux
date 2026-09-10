import http from "node:http";
import { describe, it, expect, beforeEach, afterEach } from "bun:test";

import type { Result } from "@/common/types/result";
import { Ok } from "@/common/types/result";
import type { ProjectsConfig } from "@/common/types/project";
import type { Config } from "@/node/config";
import type { PolicyService } from "@/node/services/policyService";
import type { WindowService } from "@/node/services/windowService";
import { MuxGovernorOauthService } from "./muxGovernorOauthService";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/** Simple GET helper that returns { status, body }. */
async function httpGet(url: string): Promise<{ status: number; body: string }> {
  return new Promise((resolve, reject) => {
    http
      .get(url, (res) => {
        let body = "";
        res.on("data", (chunk: Buffer | Uint8Array) => {
          body += Buffer.from(chunk).toString();
        });
        res.on("end", () => resolve({ status: res.statusCode ?? 0, body }));
      })
      .on("error", reject);
  });
}

/** Build a mock JSON response. */
function jsonResponse(body: Record<string, unknown>, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "Content-Type": "application/json" },
  });
}

/**
 * Helper to mock globalThis.fetch without needing the `preconnect` property.
 */
function mockFetch(
  fn: (input: RequestInfo | URL, init?: RequestInit) => Response | Promise<Response>
): void {
  globalThis.fetch = Object.assign(fn, {
    preconnect: (_url: string | URL) => {
      // no-op in tests
    },
  }) as typeof fetch;
}

interface MockDeps {
  configState: ProjectsConfig;
  editConfigCalls: number;
  focusCalls: number;
  refreshCalls: number;
  refreshResult: Result<void, string>;
}

function createMockDeps(): MockDeps {
  return {
    configState: { projects: new Map() },
    editConfigCalls: 0,
    focusCalls: 0,
    refreshCalls: 0,
    refreshResult: Ok(undefined),
  };
}

function createMockConfig(deps: MockDeps): Pick<Config, "editConfig"> {
  return {
    editConfig: (fn: (config: ProjectsConfig) => ProjectsConfig) => {
      deps.configState = fn(deps.configState);
      deps.editConfigCalls++;
      return Promise.resolve();
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

function createMockPolicyService(deps: MockDeps): Pick<PolicyService, "refreshNow"> {
  return {
    refreshNow: () => {
      deps.refreshCalls++;
      return Promise.resolve(deps.refreshResult);
    },
  };
}

function createService(deps: MockDeps): MuxGovernorOauthService {
  return new MuxGovernorOauthService(
    createMockConfig(deps) as Config,
    createMockWindowService(deps) as WindowService,
    createMockPolicyService(deps) as PolicyService
  );
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe("MuxGovernorOauthService", () => {
  let deps: MockDeps;
  let service: MuxGovernorOauthService;
  const originalFetch = globalThis.fetch;

  beforeEach(() => {
    deps = createMockDeps();
    service = createService(deps);
  });

  afterEach(async () => {
    globalThis.fetch = originalFetch;
    await service.dispose();
  });

  describe("startDesktopFlow", () => {
    it("returns flowId, authorizeUrl, and redirectUri", async () => {
      const result = await service.startDesktopFlow({
        governorOrigin: "https://governor.example.com/admin?from=test",
      });
      expect(result.success).toBe(true);
      if (!result.success) return;

      expect(result.data.flowId).toBeTruthy();
      expect(result.data.redirectUri).toMatch(/^http:\/\/127\.0\.0\.1:\d+\/callback$/);

      const authorizeUrl = new URL(result.data.authorizeUrl);
      expect(`${authorizeUrl.origin}${authorizeUrl.pathname}`).toBe(
        "https://governor.example.com/oauth2/authorize"
      );
      expect(authorizeUrl.searchParams.get("response_type")).toBe("code");
      expect(authorizeUrl.searchParams.get("state")).toBe(result.data.flowId);
      expect(authorizeUrl.searchParams.get("redirect_uri")).toBe(result.data.redirectUri);

      await service.cancelDesktopFlow(result.data.flowId);
    });
  });

  describe("desktop callback flow", () => {
    it("callback with code + successful exchange resolves waitFor success and renders success HTML", async () => {
      let capturedUrl = "";
      let capturedBody = "";

      mockFetch((input, init) => {
        capturedUrl =
          typeof input === "string" ? input : input instanceof URL ? input.toString() : input.url;
        capturedBody =
          typeof init?.body === "string"
            ? init.body
            : init?.body instanceof URLSearchParams
              ? init.body.toString()
              : "";
        return jsonResponse({ access_token: "governor-token" });
      });

      const startResult = await service.startDesktopFlow({
        governorOrigin: "https://governor.example.com",
      });
      expect(startResult.success).toBe(true);
      if (!startResult.success) return;

      const flowId = startResult.data.flowId;
      const callbackUrl = `${startResult.data.redirectUri}?state=${flowId}&code=ok-code`;

      const waitPromise = service.waitForDesktopFlow(flowId, { timeoutMs: 5000 });
      const callbackResponsePromise = httpGet(callbackUrl);

      const [waitResult, callbackResponse] = await Promise.all([
        waitPromise,
        callbackResponsePromise,
      ]);

      expect(waitResult).toEqual(Ok(undefined));
      expect(callbackResponse.status).toBe(200);
      expect(callbackResponse.body).toContain("Enrollment complete");

      expect(capturedUrl).toBe("https://governor.example.com/api/v1/oauth2/exchange");
      expect(capturedBody).toContain("code=ok-code");

      expect(deps.editConfigCalls).toBe(1);
      expect(deps.configState.muxGovernorUrl).toBe("https://governor.example.com");
      expect(deps.configState.muxGovernorToken).toBe("governor-token");
      expect(deps.focusCalls).toBe(1);
      expect(deps.refreshCalls).toBe(1);
    });

    it("callback with code + failed exchange resolves waitFor error and renders failure HTML", async () => {
      let releaseExchange!: () => void;
      const exchangeStarted = new Promise<void>((resolveStarted) => {
        const exchangeBlocked = new Promise<void>((resolveBlocked) => {
          releaseExchange = () => resolveBlocked();
        });

        mockFetch(async () => {
          resolveStarted();
          await exchangeBlocked;
          return new Response("governor unavailable", { status: 502 });
        });
      });

      const startResult = await service.startDesktopFlow({
        governorOrigin: "https://governor.example.com",
      });
      expect(startResult.success).toBe(true);
      if (!startResult.success) return;

      const flowId = startResult.data.flowId;
      const callbackUrl = `${startResult.data.redirectUri}?state=${flowId}&code=bad-code`;

      const waitPromise = service.waitForDesktopFlow(flowId, { timeoutMs: 5000 });
      const callbackResponsePromise = httpGet(callbackUrl);

      await exchangeStarted;

      const callbackState = await Promise.race([
        callbackResponsePromise.then(() => "settled" as const),
        new Promise<"pending">((resolve) => setTimeout(() => resolve("pending"), 100)),
      ]);
      expect(callbackState).toBe("pending");

      releaseExchange();

      const [waitResult, callbackResponse] = await Promise.all([
        waitPromise,
        callbackResponsePromise,
      ]);

      expect(waitResult.success).toBe(false);
      if (!waitResult.success) {
        expect(waitResult.error).toContain("Xum Governor exchange failed (502)");
      }

      expect(callbackResponse.status).toBe(400);
      expect(callbackResponse.body).toContain("Enrollment failed");
      expect(callbackResponse.body).toContain(
        "Xum Governor exchange failed (502): governor unavailable"
      );

      expect(deps.editConfigCalls).toBe(0);
      expect(deps.focusCalls).toBe(0);
      expect(deps.refreshCalls).toBe(0);
      expect(deps.configState.muxGovernorUrl).toBeUndefined();
      expect(deps.configState.muxGovernorToken).toBeUndefined();
    });
  });
});

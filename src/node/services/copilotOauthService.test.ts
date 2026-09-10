import { describe, it, expect, beforeEach, afterEach } from "bun:test";

import type { ProviderModelEntry } from "@/common/orpc/types";
import type { Result } from "@/common/types/result";
import { Err, Ok } from "@/common/types/result";
import type { ProviderService } from "@/node/services/providerService";
import type { WindowService } from "@/node/services/windowService";
import { CopilotOauthService } from "./copilotOauthService";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/** Build a mock fetch Response with JSON body. */
function jsonResponse(body: Record<string, unknown>, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "Content-Type": "application/json" },
  });
}

/** Standard device code response from GitHub. */
function deviceCodeResponse(overrides?: Record<string, unknown>): Response {
  return jsonResponse({
    verification_uri: "https://github.com/login/device",
    user_code: "ABCD-1234",
    device_code: "dc_test_123",
    interval: 0,
    ...overrides,
  });
}

/** Token success response. */
function tokenSuccessResponse(token = "ghp_test_token"): Response {
  return jsonResponse({ access_token: token });
}

/** Polling "not yet" response. */
function authorizationPendingResponse(): Response {
  return jsonResponse({ error: "authorization_pending" });
}

/** Models list response from Copilot API. */
function modelsResponse(models: string[] = ["gpt-5", "claude-sonnet-4"]): Response {
  return jsonResponse({ data: models.map((id) => ({ id })) });
}

// Helper to mock globalThis.fetch without needing the `preconnect` property.
function mockFetch(
  fn: (input: string | URL, init?: RequestInit) => Response | Promise<Response>
): void {
  globalThis.fetch = Object.assign(fn, {
    preconnect: (_url: string | URL) => {
      // no-op in tests
    },
  }) as typeof fetch;
}

// ---------------------------------------------------------------------------
// Mock dependencies
// ---------------------------------------------------------------------------

interface MockDeps {
  setConfigCalls: Array<{ provider: string; keyPath: string[]; value: string }>;
  setConfigResult: Result<void, string>;
  setModelsCalls: Array<{ provider: string; models: ProviderModelEntry[] }>;
  setModelsResult: Result<void, string>;
  focusCalls: number;
}

function createMockDeps(): MockDeps {
  return {
    setConfigCalls: [],
    setConfigResult: Ok(undefined),
    setModelsCalls: [],
    setModelsResult: Ok(undefined),
    focusCalls: 0,
  };
}

function createMockProviderService(
  deps: MockDeps
): Pick<ProviderService, "setConfig" | "setModels"> {
  return {
    setConfig: (
      provider: string,
      keyPath: string[],
      value: string
    ): Promise<Result<void, string>> => {
      deps.setConfigCalls.push({ provider, keyPath, value });
      return Promise.resolve(deps.setConfigResult);
    },
    setModels: (provider: string, models: ProviderModelEntry[]): Promise<Result<void, string>> => {
      deps.setModelsCalls.push({ provider, models });
      return Promise.resolve(deps.setModelsResult);
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

function createService(deps: MockDeps): CopilotOauthService {
  return new CopilotOauthService(
    createMockProviderService(deps) as ProviderService,
    createMockWindowService(deps) as WindowService
  );
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe("CopilotOauthService", () => {
  let deps: MockDeps;
  let service: CopilotOauthService;
  const originalFetch = globalThis.fetch;

  beforeEach(() => {
    deps = createMockDeps();
    service = createService(deps);
  });

  afterEach(() => {
    globalThis.fetch = originalFetch;
    service.dispose();
  });

  // -------------------------------------------------------------------------
  // startDeviceFlow
  // -------------------------------------------------------------------------

  describe("startDeviceFlow", () => {
    it("returns flowId, verificationUri, and userCode on success", async () => {
      mockFetch(() => deviceCodeResponse());

      const result = await service.startDeviceFlow();
      expect(result.success).toBe(true);
      if (result.success) {
        expect(result.data.flowId).toBeTruthy();
        expect(result.data.verificationUri).toBe("https://github.com/login/device");
        expect(result.data.userCode).toBe("ABCD-1234");
      }
    });

    it("sends request to github.com device code endpoint", async () => {
      let capturedUrl = "";
      mockFetch((input) => {
        capturedUrl = String(input);
        return deviceCodeResponse();
      });

      await service.startDeviceFlow();
      expect(capturedUrl).toBe("https://github.com/login/device/code");
    });

    it("returns Err when fetch response is not ok", async () => {
      mockFetch(() => new Response("Server Error", { status: 500 }));

      const result = await service.startDeviceFlow();
      expect(result.success).toBe(false);
      if (!result.success) {
        expect(result.error).toContain("500");
      }
    });

    it("returns Err when fetch throws a network error", async () => {
      mockFetch(() => {
        throw new Error("DNS resolution failed");
      });

      const result = await service.startDeviceFlow();
      expect(result.success).toBe(false);
      if (!result.success) {
        expect(result.error).toContain("DNS resolution failed");
      }
    });

    it("returns Err when response is missing required fields", async () => {
      mockFetch(() => jsonResponse({ verification_uri: "https://example.com" }));

      const result = await service.startDeviceFlow();
      expect(result.success).toBe(false);
      if (!result.success) {
        expect(result.error).toContain("Invalid response");
      }
    });

    it("each flow gets a unique flowId", async () => {
      mockFetch(() => deviceCodeResponse());

      const first = await service.startDeviceFlow();
      const second = await service.startDeviceFlow();
      expect(first.success).toBe(true);
      expect(second.success).toBe(true);
      if (first.success && second.success) {
        expect(first.data.flowId).not.toBe(second.data.flowId);
      }
    });
  });

  // -------------------------------------------------------------------------
  // Happy path: poll → success
  // -------------------------------------------------------------------------

  describe("happy path: poll → success", () => {
    it("polls until access_token is returned, then persists it", async () => {
      // startDeviceFlow fetch
      let pollCount = 0;
      mockFetch((input) => {
        const url = String(input);
        if (url.includes("/login/device/code")) {
          return deviceCodeResponse();
        }
        if (url.includes("/models")) {
          return modelsResponse();
        }
        // Polling endpoint
        pollCount++;
        if (pollCount === 1) {
          return authorizationPendingResponse();
        }
        return tokenSuccessResponse("ghp_final_token");
      });

      const startResult = await service.startDeviceFlow();
      expect(startResult.success).toBe(true);
      if (!startResult.success) return;

      const waitResult = await service.waitForDeviceFlow(startResult.data.flowId, {
        timeoutMs: 30_000,
      });

      expect(waitResult.success).toBe(true);

      // Verify token was persisted
      const apiKeyCall = deps.setConfigCalls.find(
        (c) => c.provider === "github-copilot" && c.keyPath[0] === "apiKey"
      );
      expect(apiKeyCall).toBeDefined();
      expect(apiKeyCall!.value).toBe("ghp_final_token");
    });

    it("calls focusMainWindow after successful auth", async () => {
      mockFetch((input) => {
        const url = String(input);
        if (url.includes("/login/device/code")) {
          return deviceCodeResponse();
        }
        if (url.includes("/models")) {
          return modelsResponse();
        }
        return tokenSuccessResponse();
      });

      const startResult = await service.startDeviceFlow();
      expect(startResult.success).toBe(true);
      if (!startResult.success) return;

      await service.waitForDeviceFlow(startResult.data.flowId, { timeoutMs: 10_000 });

      expect(deps.focusCalls).toBe(1);
    });
  });

  // -------------------------------------------------------------------------
  // slow_down response
  // -------------------------------------------------------------------------

  describe("slow_down response", () => {
    it("respects slow_down and eventually succeeds", async () => {
      let pollCount = 0;
      mockFetch((input) => {
        const url = String(input);
        if (url.includes("/login/device/code")) {
          return deviceCodeResponse();
        }
        if (url.includes("/models")) {
          return modelsResponse();
        }
        pollCount++;
        if (pollCount === 1) {
          // slow_down: service should increase interval but continue
          return jsonResponse({ error: "slow_down", interval: 0 });
        }
        return tokenSuccessResponse("ghp_slow_token");
      });

      const startResult = await service.startDeviceFlow();
      expect(startResult.success).toBe(true);
      if (!startResult.success) return;

      const waitResult = await service.waitForDeviceFlow(startResult.data.flowId, {
        timeoutMs: 30_000,
      });

      expect(waitResult.success).toBe(true);

      const apiKeyCall = deps.setConfigCalls.find(
        (c) => c.provider === "github-copilot" && c.keyPath[0] === "apiKey"
      );
      expect(apiKeyCall).toBeDefined();
      expect(apiKeyCall!.value).toBe("ghp_slow_token");
    });
  });

  // -------------------------------------------------------------------------
  // Terminal error
  // -------------------------------------------------------------------------

  describe("terminal error", () => {
    it("resolves with Err on access_denied", async () => {
      mockFetch((input) => {
        const url = String(input);
        if (url.includes("/login/device/code")) {
          return deviceCodeResponse();
        }
        return jsonResponse({ error: "access_denied" });
      });

      const startResult = await service.startDeviceFlow();
      expect(startResult.success).toBe(true);
      if (!startResult.success) return;

      const waitResult = await service.waitForDeviceFlow(startResult.data.flowId, {
        timeoutMs: 10_000,
      });

      expect(waitResult.success).toBe(false);
      if (!waitResult.success) {
        expect(waitResult.error).toContain("access_denied");
      }

      // Token should NOT have been persisted
      const apiKeyCall = deps.setConfigCalls.find(
        (c) => c.provider === "github-copilot" && c.keyPath[0] === "apiKey"
      );
      expect(apiKeyCall).toBeUndefined();
    });

    it("resolves with Err on expired_token", async () => {
      mockFetch((input) => {
        const url = String(input);
        if (url.includes("/login/device/code")) {
          return deviceCodeResponse();
        }
        return jsonResponse({ error: "expired_token" });
      });

      const startResult = await service.startDeviceFlow();
      expect(startResult.success).toBe(true);
      if (!startResult.success) return;

      const waitResult = await service.waitForDeviceFlow(startResult.data.flowId, {
        timeoutMs: 10_000,
      });

      expect(waitResult.success).toBe(false);
      if (!waitResult.success) {
        expect(waitResult.error).toContain("expired_token");
      }
    });
  });

  // -------------------------------------------------------------------------
  // Cancellation
  // -------------------------------------------------------------------------

  describe("cancellation", () => {
    it("resolves waitForDeviceFlow with error when cancelled", async () => {
      // Make polling hang indefinitely with authorization_pending
      mockFetch((input) => {
        const url = String(input);
        if (url.includes("/login/device/code")) {
          return deviceCodeResponse();
        }
        return authorizationPendingResponse();
      });

      const startResult = await service.startDeviceFlow();
      expect(startResult.success).toBe(true);
      if (!startResult.success) return;

      const flowId = startResult.data.flowId;

      // Start waiting (don't await yet)
      const waitPromise = service.waitForDeviceFlow(flowId, { timeoutMs: 30_000 });

      // Give polling loop a tick to start
      await new Promise((resolve) => setTimeout(resolve, 10));

      // Cancel the flow
      service.cancelDeviceFlow(flowId);

      const result = await waitPromise;
      expect(result.success).toBe(false);
      if (!result.success) {
        expect(result.error).toContain("cancelled");
      }

      // Token should NOT have been persisted
      const apiKeyCall = deps.setConfigCalls.find(
        (c) => c.provider === "github-copilot" && c.keyPath[0] === "apiKey"
      );
      expect(apiKeyCall).toBeUndefined();
    });

    it("does not persist token if cancelled mid-request", async () => {
      // Control when the polling fetch resolves
      let resolvePollFetch!: (res: Response) => void;

      mockFetch((input) => {
        const url = String(input);
        if (url.includes("/login/device/code")) {
          return deviceCodeResponse();
        }
        // Hang the polling request until we resolve it manually
        return new Promise<Response>((resolve) => {
          resolvePollFetch = resolve;
        });
      });

      const startResult = await service.startDeviceFlow();
      expect(startResult.success).toBe(true);
      if (!startResult.success) return;

      const flowId = startResult.data.flowId;
      const waitPromise = service.waitForDeviceFlow(flowId, { timeoutMs: 30_000 });

      // Give polling loop a tick to start the fetch
      await new Promise((resolve) => setTimeout(resolve, 10));

      // Cancel while fetch is in-flight
      service.cancelDeviceFlow(flowId);

      // Now resolve the fetch with a valid token — it should be ignored
      // because flow.cancelled is checked after fetch returns
      resolvePollFetch(tokenSuccessResponse("ghp_should_not_persist"));

      const result = await waitPromise;
      expect(result.success).toBe(false);

      // Token should NOT have been persisted
      const apiKeyCall = deps.setConfigCalls.find(
        (c) => c.provider === "github-copilot" && c.keyPath[0] === "apiKey"
      );
      expect(apiKeyCall).toBeUndefined();
    });
  });

  // -------------------------------------------------------------------------
  // Transient network error recovery
  // -------------------------------------------------------------------------

  describe("transient network error recovery", () => {
    it("retries after a transient fetch error and eventually succeeds", async () => {
      let pollCount = 0;
      mockFetch((input) => {
        const url = String(input);
        if (url.includes("/login/device/code")) {
          return deviceCodeResponse();
        }
        if (url.includes("/models")) {
          return modelsResponse();
        }
        pollCount++;
        if (pollCount === 1) {
          throw new Error("ECONNRESET");
        }
        return tokenSuccessResponse("ghp_recovered");
      });

      const startResult = await service.startDeviceFlow();
      expect(startResult.success).toBe(true);
      if (!startResult.success) return;

      const waitResult = await service.waitForDeviceFlow(startResult.data.flowId, {
        timeoutMs: 30_000,
      });

      expect(waitResult.success).toBe(true);

      const apiKeyCall = deps.setConfigCalls.find(
        (c) => c.provider === "github-copilot" && c.keyPath[0] === "apiKey"
      );
      expect(apiKeyCall).toBeDefined();
      expect(apiKeyCall!.value).toBe("ghp_recovered");
    });
  });

  // -------------------------------------------------------------------------
  // Re-entrancy guard
  // -------------------------------------------------------------------------

  describe("re-entrancy guard", () => {
    it("only starts one polling loop even when waitForDeviceFlow is called twice", async () => {
      let pollCallCount = 0;
      mockFetch((input) => {
        const url = String(input);
        if (url.includes("/login/device/code")) {
          return deviceCodeResponse();
        }
        if (url.includes("/models")) {
          return modelsResponse();
        }
        pollCallCount++;
        return tokenSuccessResponse("ghp_single_poll");
      });

      const startResult = await service.startDeviceFlow();
      expect(startResult.success).toBe(true);
      if (!startResult.success) return;

      const flowId = startResult.data.flowId;

      // Call waitForDeviceFlow twice concurrently
      const [result1, result2] = await Promise.all([
        service.waitForDeviceFlow(flowId, { timeoutMs: 10_000 }),
        service.waitForDeviceFlow(flowId, { timeoutMs: 10_000 }),
      ]);

      // Both should succeed
      expect(result1.success).toBe(true);
      expect(result2.success).toBe(true);

      // Only one polling request should have been made (one poll loop)
      expect(pollCallCount).toBe(1);
    });
  });

  // -------------------------------------------------------------------------
  // Model fetching after successful auth
  // -------------------------------------------------------------------------

  describe("model fetching after successful auth", () => {
    it("fetches models from Copilot API and stores only allowed prefixes via setModels", async () => {
      let modelsUrl = "";
      let modelsAuthHeader = "";
      mockFetch((input, init) => {
        const url = String(input);
        if (url.includes("/login/device/code")) {
          return deviceCodeResponse();
        }
        if (url.includes("/models")) {
          modelsUrl = url;
          modelsAuthHeader = (init?.headers as Record<string, string>)?.Authorization ?? "";
          // Return a mix of matching and non-matching models
          return modelsResponse([
            "gpt-5",
            "claude-sonnet-4.5",
            "gpt-4o",
            "o3-mini",
            "gemini-3-pro-preview",
            "grok-code-mini",
          ]);
        }
        return tokenSuccessResponse("ghp_model_token");
      });

      const startResult = await service.startDeviceFlow();
      expect(startResult.success).toBe(true);
      if (!startResult.success) return;

      const waitResult = await service.waitForDeviceFlow(startResult.data.flowId, {
        timeoutMs: 10_000,
      });
      expect(waitResult.success).toBe(true);

      // Verify models endpoint was called with correct URL and auth
      expect(modelsUrl).toBe("https://api.githubcopilot.com/models");
      expect(modelsAuthHeader).toBe("Bearer ghp_model_token");

      // Verify only models matching allowed prefixes were stored
      expect(deps.setModelsCalls).toHaveLength(1);
      const call = deps.setModelsCalls[0];
      expect(call?.provider).toBe("github-copilot");
      expect(call?.models).toEqual([
        "gpt-5",
        "claude-sonnet-4.5",
        "gemini-3-pro-preview",
        "grok-code-mini",
      ]);
    });

    it("excludes models not matching any allowed prefix", async () => {
      mockFetch((input) => {
        const url = String(input);
        if (url.includes("/login/device/code")) {
          return deviceCodeResponse();
        }
        if (url.includes("/models")) {
          // All models are non-matching
          return modelsResponse(["gpt-4o", "o3-mini", "o1-preview"]);
        }
        return tokenSuccessResponse();
      });

      const startResult = await service.startDeviceFlow();
      expect(startResult.success).toBe(true);
      if (!startResult.success) return;

      const waitResult = await service.waitForDeviceFlow(startResult.data.flowId, {
        timeoutMs: 10_000,
      });
      expect(waitResult.success).toBe(true);

      // setModels should not be called when all models are filtered out
      expect(deps.setModelsCalls).toHaveLength(0);
    });

    it("login succeeds even if model fetch returns non-200", async () => {
      mockFetch((input) => {
        const url = String(input);
        if (url.includes("/login/device/code")) {
          return deviceCodeResponse();
        }
        if (url.includes("/models")) {
          return new Response("Internal Server Error", { status: 500 });
        }
        return tokenSuccessResponse();
      });

      const startResult = await service.startDeviceFlow();
      expect(startResult.success).toBe(true);
      if (!startResult.success) return;

      const waitResult = await service.waitForDeviceFlow(startResult.data.flowId, {
        timeoutMs: 10_000,
      });

      // Login should still succeed
      expect(waitResult.success).toBe(true);

      // No models should have been stored
      expect(deps.setModelsCalls).toHaveLength(0);
    });

    it("login succeeds even if model fetch throws a network error", async () => {
      mockFetch((input) => {
        const url = String(input);
        if (url.includes("/login/device/code")) {
          return deviceCodeResponse();
        }
        if (url.includes("/models")) {
          throw new Error("ECONNREFUSED");
        }
        return tokenSuccessResponse();
      });

      const startResult = await service.startDeviceFlow();
      expect(startResult.success).toBe(true);
      if (!startResult.success) return;

      const waitResult = await service.waitForDeviceFlow(startResult.data.flowId, {
        timeoutMs: 10_000,
      });

      // Login should still succeed despite model fetch failure
      expect(waitResult.success).toBe(true);

      // Token should still have been persisted
      const apiKeyCall = deps.setConfigCalls.find(
        (c) => c.provider === "github-copilot" && c.keyPath[0] === "apiKey"
      );
      expect(apiKeyCall).toBeDefined();

      // No models should have been stored
      expect(deps.setModelsCalls).toHaveLength(0);
    });

    it("does not call setModels when API returns empty model list", async () => {
      mockFetch((input) => {
        const url = String(input);
        if (url.includes("/login/device/code")) {
          return deviceCodeResponse();
        }
        if (url.includes("/models")) {
          return jsonResponse({ data: [] });
        }
        return tokenSuccessResponse();
      });

      const startResult = await service.startDeviceFlow();
      expect(startResult.success).toBe(true);
      if (!startResult.success) return;

      const waitResult = await service.waitForDeviceFlow(startResult.data.flowId, {
        timeoutMs: 10_000,
      });
      expect(waitResult.success).toBe(true);

      // Empty list — should not call setModels
      expect(deps.setModelsCalls).toHaveLength(0);
    });

    it("does not call setModels when API response has no data field", async () => {
      mockFetch((input) => {
        const url = String(input);
        if (url.includes("/login/device/code")) {
          return deviceCodeResponse();
        }
        if (url.includes("/models")) {
          return jsonResponse({ something_else: true });
        }
        return tokenSuccessResponse();
      });

      const startResult = await service.startDeviceFlow();
      expect(startResult.success).toBe(true);
      if (!startResult.success) return;

      const waitResult = await service.waitForDeviceFlow(startResult.data.flowId, {
        timeoutMs: 10_000,
      });
      expect(waitResult.success).toBe(true);

      expect(deps.setModelsCalls).toHaveLength(0);
    });
  });

  // -------------------------------------------------------------------------
  // Dispose cleanup
  // -------------------------------------------------------------------------

  describe("dispose", () => {
    it("resolves pending waitForDeviceFlow with error", async () => {
      mockFetch((input) => {
        const url = String(input);
        if (url.includes("/login/device/code")) {
          return deviceCodeResponse();
        }
        // Never return a token — keep it pending
        return authorizationPendingResponse();
      });

      const startResult = await service.startDeviceFlow();
      expect(startResult.success).toBe(true);
      if (!startResult.success) return;

      const waitPromise = service.waitForDeviceFlow(startResult.data.flowId, {
        timeoutMs: 30_000,
      });

      // Give polling loop a tick to start
      await new Promise((resolve) => setTimeout(resolve, 10));

      // Dispose the service
      service.dispose();

      const result = await waitPromise;
      expect(result.success).toBe(false);
      if (!result.success) {
        expect(result.error).toContain("shutting down");
      }

      // Token should NOT have been persisted
      const apiKeyCall = deps.setConfigCalls.find(
        (c) => c.provider === "github-copilot" && c.keyPath[0] === "apiKey"
      );
      expect(apiKeyCall).toBeUndefined();
    });

    it("clears all flows from the map", async () => {
      mockFetch((input) => {
        const url = String(input);
        if (url.includes("/login/device/code")) {
          return deviceCodeResponse();
        }
        return authorizationPendingResponse();
      });

      // Start two flows
      const flow1 = await service.startDeviceFlow();
      const flow2 = await service.startDeviceFlow();
      expect(flow1.success).toBe(true);
      expect(flow2.success).toBe(true);

      service.dispose();

      // After dispose, waitForDeviceFlow should return "not found"
      if (flow1.success) {
        const result = await service.waitForDeviceFlow(flow1.data.flowId);
        expect(result.success).toBe(false);
        if (!result.success) {
          expect(result.error).toContain("not found");
        }
      }
    });
  });

  // -------------------------------------------------------------------------
  // setConfig failure
  // -------------------------------------------------------------------------

  describe("setConfig failure", () => {
    it("propagates setConfig error to waitForDeviceFlow result", async () => {
      deps.setConfigResult = Err("disk full");

      mockFetch((input) => {
        const url = String(input);
        if (url.includes("/login/device/code")) {
          return deviceCodeResponse();
        }
        return tokenSuccessResponse();
      });

      const startResult = await service.startDeviceFlow();
      expect(startResult.success).toBe(true);
      if (!startResult.success) return;

      const waitResult = await service.waitForDeviceFlow(startResult.data.flowId, {
        timeoutMs: 10_000,
      });

      expect(waitResult.success).toBe(false);
      if (!waitResult.success) {
        expect(waitResult.error).toContain("disk full");
      }
    });
  });

  // -------------------------------------------------------------------------
  // waitForDeviceFlow edge cases
  // -------------------------------------------------------------------------

  describe("waitForDeviceFlow edge cases", () => {
    it("returns Err for unknown flowId", async () => {
      const result = await service.waitForDeviceFlow("nonexistent-flow-id");
      expect(result.success).toBe(false);
      if (!result.success) {
        expect(result.error).toContain("not found");
      }
    });

    it("cancelDeviceFlow is a no-op for unknown flowId", () => {
      // Should not throw
      service.cancelDeviceFlow("nonexistent-flow-id");
    });
  });
});

import http from "node:http";
import { afterEach, beforeEach, describe, expect, it } from "bun:test";

import {
  MUX_GATEWAY_AUTHORIZE_URL,
  MUX_GATEWAY_EXCHANGE_URL,
  MUX_GATEWAY_ORIGIN,
  MUX_GATEWAY_SESSION_EXPIRED_MESSAGE,
} from "@/common/constants/muxGatewayOAuth";
import { Err, Ok } from "@/common/types/result";
import type { ProvidersConfigStore } from "@/node/config";
import type { ProviderService } from "@/node/services/providerService";
import type { WindowService } from "@/node/services/windowService";
import { createDeferred } from "@/node/utils/oauthUtils";
import { MuxGatewayOauthService } from "./muxGatewayOauthService";

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

function jsonResponse(body: Record<string, unknown>, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "Content-Type": "application/json" },
  });
}

function mockFetch(
  fn: (input: RequestInfo | URL, init?: RequestInit) => Response | Promise<Response>
): void {
  globalThis.fetch = Object.assign(fn, { preconnect: () => undefined }) as typeof fetch;
}

function requestUrl(input: RequestInfo | URL): string {
  if (typeof input === "string") return input;
  return input instanceof URL ? input.toString() : input.url;
}

interface MockDeps {
  providersConfig: ReturnType<ProvidersConfigStore["loadProvidersConfig"]>;
  setConfigCalls: Array<{ provider: string; keyPath: string[]; value: string }>;
  focusCalls: number;
}

function createService(deps: MockDeps): MuxGatewayOauthService {
  const providersConfigStore: Pick<ProvidersConfigStore, "loadProvidersConfig"> = {
    loadProvidersConfig: () => deps.providersConfig,
  };
  const providerService: Pick<ProviderService, "setConfig"> = {
    setConfig: (provider, keyPath, value) => {
      deps.setConfigCalls.push({ provider, keyPath, value: String(value) });
      return Promise.resolve(Ok(undefined));
    },
  };
  const windowService: Pick<WindowService, "focusMainWindow"> = {
    focusMainWindow: () => {
      deps.focusCalls++;
    },
  };
  return new MuxGatewayOauthService(
    providersConfigStore,
    providerService as ProviderService,
    windowService as WindowService
  );
}

async function startFlow(service: MuxGatewayOauthService) {
  const result = await service.startDesktopFlow();
  if (!result.success) throw new Error(result.error);
  return result.data;
}

describe("MuxGatewayOauthService", () => {
  let deps: MockDeps;
  let service: MuxGatewayOauthService;
  const originalFetch = globalThis.fetch;

  beforeEach(() => {
    deps = {
      providersConfig: {},
      setConfigCalls: [],
      focusCalls: 0,
    };
    service = createService(deps);
  });

  afterEach(async () => {
    globalThis.fetch = originalFetch;
    await service.dispose();
  });

  describe("getAccountStatus", () => {
    beforeEach(() => {
      deps.providersConfig = { "mux-gateway": { couponCode: "gateway-token" } };
    });

    it("returns the validated balance with the configured credential", async () => {
      const balance = {
        remaining_microdollars: 12_345,
        ai_gateway_concurrent_requests_per_user: 7,
      };
      let request: { url: string; init?: RequestInit } | undefined;
      mockFetch((input, init) => {
        request = { url: requestUrl(input), init };
        return jsonResponse(balance);
      });
      expect(await service.getAccountStatus()).toEqual(Ok(balance));
      expect(request?.url).toBe(MUX_GATEWAY_ORIGIN + "/api/v1/balance");
      expect(request?.init?.headers).toEqual({
        Accept: "application/json",
        Authorization: "Bearer gateway-token",
      });
    });

    it("clears stored credentials on an expired session", async () => {
      mockFetch(() => new Response(null, { status: 401 }));
      expect(await service.getAccountStatus()).toEqual(Err(MUX_GATEWAY_SESSION_EXPIRED_MESSAGE));
      expect(deps.setConfigCalls).toEqual([
        { provider: "mux-gateway", keyPath: ["couponCode"], value: "" },
        { provider: "mux-gateway", keyPath: ["voucher"], value: "" },
      ]);
    });

    const errorCases: Array<[() => void, string]> = [
      [
        () => {
          deps.providersConfig = {};
        },
        "Xum Gateway is not logged in",
      ],
      [
        () => mockFetch(() => Promise.reject(new Error("offline"))),
        "Xum Gateway balance request failed: offline",
      ],
      [
        () => mockFetch(() => new Response("upstream exploded", { status: 503 })),
        "Xum Gateway balance request failed (HTTP 503): upstream exploded",
      ],
      [
        () => mockFetch(() => jsonResponse({ remaining_microdollars: -1 })),
        "Xum Gateway returned an invalid balance payload",
      ],
      [
        () => {
          const response = jsonResponse({});
          response.json = () => Promise.reject(new Error("broken JSON"));
          mockFetch(() => response);
        },
        "Xum Gateway balance response was not valid JSON: broken JSON",
      ],
    ];

    it.each(errorCases)("returns exact balance errors", async (arrange, error) => {
      arrange();
      expect(await service.getAccountStatus()).toEqual(Err(error));
    });
  });
  it("starts a desktop flow with the expected authorization URL", async () => {
    const flow = await startFlow(service);
    const authorizeUrl = new URL(flow.authorizeUrl);

    expect(flow.redirectUri).toMatch(/^http:\/\/127\.0\.0\.1:\d+\/callback$/);
    expect(authorizeUrl.origin + authorizeUrl.pathname).toBe(MUX_GATEWAY_AUTHORIZE_URL);
    expect(authorizeUrl.searchParams.get("response_type")).toBe("code");
    expect(authorizeUrl.searchParams.get("state")).toBe(flow.flowId);
    expect(authorizeUrl.searchParams.get("redirect_uri")).toBe(flow.redirectUri);
    await service.cancelDesktopFlow(flow.flowId);
  });

  it("exchanges a desktop callback code and persists the token", async () => {
    let capturedUrl = "";
    let capturedBody = "";
    mockFetch((input, init) => {
      capturedUrl = requestUrl(input);
      capturedBody = init?.body instanceof URLSearchParams ? init.body.toString() : "";
      return jsonResponse({ access_token: "gateway-token" });
    });

    const flow = await startFlow(service);
    const callback = httpGet(flow.redirectUri + "?state=" + flow.flowId + "&code=ok-code");
    expect(await service.waitForDesktopFlow(flow.flowId, { timeoutMs: 5000 })).toEqual(
      Ok(undefined)
    );
    const callbackResponse = await callback;

    expect(callbackResponse.status).toBe(200);
    expect(callbackResponse.body).toContain("Login complete");
    expect(capturedUrl).toBe(MUX_GATEWAY_EXCHANGE_URL);
    expect(capturedBody).toContain("code=ok-code");
    expect(deps.setConfigCalls).toEqual([
      { provider: "mux-gateway", keyPath: ["couponCode"], value: "gateway-token" },
    ]);
    expect(deps.focusCalls).toBe(1);
  });

  it("keeps the failure callback pending until the exchange finishes", async () => {
    const started = createDeferred<void>();
    const blocked = createDeferred<void>();
    mockFetch(async () => {
      started.resolve();
      await blocked.promise;
      return new Response("upstream exploded", { status: 500 });
    });

    const flow = await startFlow(service);
    const wait = service.waitForDesktopFlow(flow.flowId, { timeoutMs: 5000 });
    const callback = httpGet(flow.redirectUri + "?state=" + flow.flowId + "&code=bad-code");
    await started.promise;
    expect(
      await Promise.race([
        callback.then(() => "settled" as const),
        new Promise<"pending">((resolve) => setTimeout(() => resolve("pending"), 100)),
      ])
    ).toBe("pending");
    blocked.resolve();

    expect(await wait).toEqual(Err("Xum Gateway exchange failed (500): upstream exploded"));
    const callbackResponse = await callback;
    expect(callbackResponse.status).toBe(400);
    expect(callbackResponse.body).toContain("Login failed");
    expect(callbackResponse.body).toContain("Xum Gateway exchange failed (500): upstream exploded");
    expect(deps.setConfigCalls).toHaveLength(0);
    expect(deps.focusCalls).toBe(0);
  });
});

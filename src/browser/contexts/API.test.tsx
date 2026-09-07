import { VERSION } from "@/version";
import { act, cleanup, render, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, mock, spyOn, test } from "bun:test";
import { GlobalWindow } from "happy-dom";
import type { RecursivePartial } from "@/browser/testUtils";

// Mock WebSocket that we can control
class MockWebSocket {
  static instances: MockWebSocket[] = [];
  url: string;
  readyState = 0; // CONNECTING
  eventListeners = new Map<string, Array<(event?: unknown) => void>>();

  constructor(url: string) {
    this.url = url;
    MockWebSocket.instances.push(this);
  }

  addEventListener(event: string, handler: (event?: unknown) => void) {
    const handlers = this.eventListeners.get(event) ?? [];
    handlers.push(handler);
    this.eventListeners.set(event, handlers);
  }

  close() {
    this.readyState = 3; // CLOSED
  }

  // Test helpers
  simulateOpen() {
    this.readyState = 1; // OPEN
    this.eventListeners.get("open")?.forEach((h) => h());
  }

  simulateClose(code: number) {
    this.readyState = 3;
    this.eventListeners.get("close")?.forEach((h) => h({ code }));
  }

  simulateError() {
    this.eventListeners.get("error")?.forEach((h) => h());
  }
  simulateMessage(data: unknown = "data") {
    this.eventListeners.get("message")?.forEach((h) => h({ data }));
  }

  static reset() {
    MockWebSocket.instances = [];
  }

  static lastInstance(): MockWebSocket | undefined {
    return MockWebSocket.instances[MockWebSocket.instances.length - 1];
  }
}

const originalFetch = globalThis.fetch;
let fetchImpl: (input: RequestInfo | URL, init?: RequestInit) => Promise<Response> = () =>
  Promise.resolve({
    ok: false,
    json: () => Promise.resolve({}),
  } as unknown as Response);

// Mock orpc client
let pingImpl: () => Promise<string> = () => Promise.resolve("pong");
let storedAuthToken: string | null = null;
const getStoredAuthTokenMock = mock(() => storedAuthToken);
const setStoredAuthTokenMock = mock((token: string) => {
  storedAuthToken = token;
});
const clearStoredAuthTokenMock = mock(() => {
  storedAuthToken = null;
});

void mock.module("@/common/orpc/client", () => ({
  createClient: () => ({
    general: {
      ping: () => pingImpl(),
    },
  }),
}));

void mock.module("@orpc/client/websocket", () => ({
  RPCLink: class {},
}));

void mock.module("@orpc/client/message-port", () => ({
  RPCLink: class {},
}));

void mock.module("@/browser/components/AuthTokenModal/AuthTokenModal", () => ({
  // Note: Module mocks leak between bun test files.
  // Export all commonly-used symbols to avoid cross-test import errors.
  AuthTokenModal: () => null,
  getStoredAuthToken: getStoredAuthTokenMock,
  setStoredAuthToken: setStoredAuthTokenMock,
  clearStoredAuthToken: clearStoredAuthTokenMock,
}));

// Import the real API module types (not the mocked version)
import type {
  APIClient as _APIClient,
  UseAPIResult as _UseAPIResult,
  APIProvider as APIProviderType,
} from "./API";

// IMPORTANT: Other test files mock @/browser/contexts/API with a fake APIProvider.
// Module mocks leak between test files in bun (https://github.com/oven-sh/bun/issues/12823).
// The query string creates a distinct module cache key, bypassing any mocked version.
/* eslint-disable @typescript-eslint/no-require-imports, @typescript-eslint/no-unsafe-assignment */
const RealAPIModule: {
  APIProvider: typeof APIProviderType;
  useAPI: () => _UseAPIResult;
  useConnectionLatencyMs: () => number | null;
} = require("./API?real=1");
/* eslint-enable @typescript-eslint/no-require-imports, @typescript-eslint/no-unsafe-assignment */
const { APIProvider, useAPI, useConnectionLatencyMs } = RealAPIModule;
type APIClient = _APIClient;
type UseAPIResult = _UseAPIResult;

// Each observation carries the API context value by reference (apiState) plus the latency
// published through the separate latency context.
interface ObservedState {
  status: UseAPIResult["status"];
  apiState: UseAPIResult;
  latencyMs: number | null;
}

// Test component to observe API state
function APIStateObserver(props: { onState: (state: ObservedState) => void }) {
  const apiState = useAPI();
  const latencyMs = useConnectionLatencyMs();
  props.onState({ status: apiState.status, apiState, latencyMs });
  return null;
}

// Factory that creates MockWebSocket instances (injected via prop)
const createMockWebSocket = (url: string) => new MockWebSocket(url) as unknown as WebSocket;

describe("API reconnection", () => {
  beforeEach(() => {
    // Minimal DOM setup required by @testing-library/react.
    //
    // Happy DOM can default to an opaque origin ("null") in some modes (e.g. coverage).
    // That breaks URL construction in createBrowserClient(). Give it a stable http(s) origin.
    const happyWindow = new GlobalWindow({ url: "https://mux.example.com/" });
    globalThis.window = happyWindow as unknown as Window & typeof globalThis;
    globalThis.document = happyWindow.document as unknown as Document;
    fetchImpl = () =>
      Promise.resolve({
        ok: false,
        json: () => Promise.resolve({}),
      } as unknown as Response);

    globalThis.fetch = ((input: RequestInfo | URL, init?: RequestInit) =>
      fetchImpl(input, init)) as typeof globalThis.fetch;
    MockWebSocket.reset();
    pingImpl = () => Promise.resolve("pong");
    storedAuthToken = null;
    getStoredAuthTokenMock.mockClear();
    setStoredAuthTokenMock.mockClear();
    clearStoredAuthTokenMock.mockClear();
  });

  afterEach(() => {
    cleanup();
    MockWebSocket.reset();
    globalThis.fetch = originalFetch;
    globalThis.window = undefined as unknown as Window & typeof globalThis;
    globalThis.document = undefined as unknown as Document;
  });

  test("constructs WebSocket URL with app proxy prefix", () => {
    window.location.href = "https://coder.example.com/@u/ws/apps/mux/?token=abc";

    render(
      <APIProvider createWebSocket={createMockWebSocket}>
        <APIStateObserver onState={() => undefined} />
      </APIProvider>
    );

    const ws1 = MockWebSocket.lastInstance();
    expect(ws1).toBeDefined();
    expect(ws1!.url).toBe("wss://coder.example.com/@u/ws/apps/mux/orpc/ws?token=abc");
  });

  test("injected clients skip internal auth token setup", async () => {
    window.location.href = "https://mux.example.com/?token=injected-token";
    const states: string[] = [];
    const injectedClient: RecursivePartial<APIClient> = { general: {} };

    render(
      <APIProvider client={injectedClient as APIClient}>
        <APIStateObserver onState={(s) => states.push(s.status)} />
      </APIProvider>
    );

    await act(async () => {
      await Promise.resolve();
    });

    expect(states).toEqual(["connected"]);
    expect(getStoredAuthTokenMock.mock.calls).toHaveLength(0);
    expect(setStoredAuthTokenMock.mock.calls).toHaveLength(0);
    expect(window.location.search).toBe("?token=injected-token");
    expect(MockWebSocket.instances).toHaveLength(0);
  });

  test("injected clients keep internal connection controls disabled", async () => {
    const states: string[] = [];
    let latestState: UseAPIResult | null = null;
    const injectedClient: RecursivePartial<APIClient> = { general: {} };

    render(
      <APIProvider client={injectedClient as APIClient}>
        <APIStateObserver
          onState={(state) => {
            latestState = state.apiState;
            states.push(state.status);
          }}
        />
      </APIProvider>
    );

    await act(async () => {
      await Promise.resolve();
    });

    expect(latestState).not.toBeNull();

    act(() => {
      latestState!.retry();
      latestState!.authenticate("unused-token");
    });

    await act(async () => {
      await Promise.resolve();
    });

    expect(states).toEqual(["connected"]);
    expect(setStoredAuthTokenMock.mock.calls).toHaveLength(0);
    expect(MockWebSocket.instances).toHaveLength(0);
  });

  test.each(["changed", "rebuilt", "same", "unreachable", "malformed", "cross-origin"])(
    "checks the server version on reconnect: %s",
    async (scenario) => {
      if (scenario === "cross-origin") process.env.VITE_BACKEND_URL = "https://api.example.com";
      const reload = spyOn(window.location, "reload").mockImplementation(() => undefined);
      const requests: string[] = [];
      fetchImpl = (input) => {
        requests.push(
          typeof input === "string" ? input : input instanceof URL ? input.href : input.url
        );
        if (scenario === "unreachable") return Promise.reject(new Error("offline"));
        return Promise.resolve(
          new Response(
            JSON.stringify(
              scenario === "malformed"
                ? {}
                : {
                    git_commit:
                      scenario === "changed" ? "different-server-commit" : VERSION.git_commit,
                    git_describe: scenario === "rebuilt" ? "v9.9.9-rebuilt" : VERSION.git_describe,
                  }
            ),
            { status: 200 }
          )
        );
      };
      window.location.href = "https://coder.example.com/@u/ws/apps/mux/";
      let latestState: UseAPIResult | null = null;
      render(
        <APIProvider createWebSocket={createMockWebSocket}>
          <APIStateObserver
            onState={(s) => {
              latestState = s.apiState;
            }}
          />
        </APIProvider>
      );
      await act(async () => {
        MockWebSocket.lastInstance()!.simulateOpen();
        await Promise.resolve();
      });
      expect(latestState!.status).toBe("connected");
      expect(requests).toEqual([]);
      act(() => {
        latestState!.retry();
      });
      await act(async () => {
        MockWebSocket.lastInstance()!.simulateOpen();
        await Promise.resolve();
      });
      expect(requests).toEqual(
        scenario === "cross-origin" ? [] : ["https://coder.example.com/@u/ws/apps/mux/version"]
      );
      const reloads = scenario === "changed" || scenario === "rebuilt" ? 1 : 0;
      expect(reload).toHaveBeenCalledTimes(reloads);
      if (reloads === 0) expect(latestState!.status).toBe("connected");
      reload.mockRestore();
      delete process.env.VITE_BACKEND_URL;
    }
  );

  test("reconnects on close without showing auth_required when previously connected", async () => {
    const states: string[] = [];

    render(
      <APIProvider createWebSocket={createMockWebSocket}>
        <APIStateObserver onState={(s) => states.push(s.status)} />
      </APIProvider>
    );

    const ws1 = MockWebSocket.lastInstance();
    expect(ws1).toBeDefined();

    // Simulate successful connection (open + ping success)
    await act(async () => {
      ws1!.simulateOpen();
      // Wait for ping promise to resolve
      await new Promise((r) => setTimeout(r, 10));
    });

    expect(states).toContain("connected");

    // Simulate server restart (close code 1006 = abnormal closure)
    act(() => {
      ws1!.simulateClose(1006);
    });

    // Should be "reconnecting", NOT "auth_required"
    await waitFor(() => {
      expect(states).toContain("reconnecting");
    });

    expect(states.filter((s) => s === "auth_required")).toHaveLength(0);

    // New WebSocket should be created for reconnect attempt (after delay)
    await waitFor(() => {
      expect(MockWebSocket.instances.length).toBeGreaterThan(1);
    });
  });

  test("shows auth_required on close with auth error codes (4401)", async () => {
    const states: string[] = [];

    render(
      <APIProvider createWebSocket={createMockWebSocket}>
        <APIStateObserver onState={(s) => states.push(s.status)} />
      </APIProvider>
    );

    const ws1 = MockWebSocket.lastInstance();
    expect(ws1).toBeDefined();

    await act(async () => {
      ws1!.simulateOpen();
      await new Promise((r) => setTimeout(r, 10));
    });

    expect(states).toContain("connected");

    act(() => {
      ws1!.simulateClose(4401);
    });

    await waitFor(() => {
      expect(states).toContain("auth_required");
    });
  });

  test("shows auth_required on close with auth error codes (1008)", async () => {
    const states: string[] = [];

    render(
      <APIProvider createWebSocket={createMockWebSocket}>
        <APIStateObserver onState={(s) => states.push(s.status)} />
      </APIProvider>
    );

    const ws1 = MockWebSocket.lastInstance();
    expect(ws1).toBeDefined();

    await act(async () => {
      ws1!.simulateOpen();
      await new Promise((r) => setTimeout(r, 10));
    });

    expect(states).toContain("connected");

    act(() => {
      ws1!.simulateClose(1008);
    });

    await waitFor(() => {
      expect(states).toContain("auth_required");
    });
  });

  test("retries on first connection failure without showing auth_required", async () => {
    const states: string[] = [];

    render(
      <APIProvider createWebSocket={createMockWebSocket}>
        <APIStateObserver onState={(s) => states.push(s.status)} />
      </APIProvider>
    );

    const ws1 = MockWebSocket.lastInstance();
    expect(ws1).toBeDefined();

    // First connection fails - browser fires error then close.
    act(() => {
      ws1!.simulateError();
      ws1!.simulateClose(1006);
    });

    await waitFor(() => {
      expect(states).toContain("reconnecting");
    });

    expect(states.filter((s) => s === "auth_required")).toHaveLength(0);

    // Should create a new WebSocket for the reconnect attempt.
    await waitFor(() => {
      expect(MockWebSocket.instances.length).toBeGreaterThan(1);
    });
  });

  test("shows auth_required when the WS handshake fails but /api/spec.json requires auth", async () => {
    const states: string[] = [];
    fetchImpl = async () =>
      Promise.resolve({
        ok: true,
        json: () => Promise.resolve({ security: [{ bearerAuth: [] }] }),
      } as unknown as Response);

    render(
      <APIProvider createWebSocket={createMockWebSocket}>
        <APIStateObserver onState={(s) => states.push(s.status)} />
      </APIProvider>
    );

    const ws1 = MockWebSocket.lastInstance();
    expect(ws1).toBeDefined();

    act(() => {
      ws1!.simulateError();
      ws1!.simulateClose(1006);
    });

    await waitFor(() => {
      expect(states).toContain("auth_required");
    });

    expect(MockWebSocket.instances).toHaveLength(1);
  });

  test("does not hang startup when /api/spec.json probe stalls (schedules reconnect after timeout)", async () => {
    const states: string[] = [];

    fetchImpl = (_input, init) =>
      new Promise((_resolve, reject) => {
        init?.signal?.addEventListener("abort", () => {
          reject(new Error("aborted"));
        });
      });

    render(
      <APIProvider createWebSocket={createMockWebSocket}>
        <APIStateObserver onState={(s) => states.push(s.status)} />
      </APIProvider>
    );

    const ws1 = MockWebSocket.lastInstance();
    expect(ws1).toBeDefined();

    act(() => {
      ws1!.simulateError();
      ws1!.simulateClose(1006);
    });

    await waitFor(
      () => {
        expect(states).toContain("reconnecting");
      },
      { timeout: 5000 }
    );

    await waitFor(
      () => {
        expect(MockWebSocket.instances.length).toBeGreaterThan(1);
      },
      { timeout: 5000 }
    );
  });

  test("re-probes /api/spec.json after an inconclusive result and then shows auth_required", async () => {
    const states: string[] = [];
    let probeCalls = 0;

    fetchImpl = async () => {
      probeCalls++;
      if (probeCalls === 1) {
        return Promise.resolve({
          ok: false,
          json: () => Promise.resolve({}),
        } as unknown as Response);
      }

      return Promise.resolve({
        ok: true,
        json: () => Promise.resolve({ security: [{ bearerAuth: [] }] }),
      } as unknown as Response);
    };

    render(
      <APIProvider createWebSocket={createMockWebSocket}>
        <APIStateObserver onState={(s) => states.push(s.status)} />
      </APIProvider>
    );

    const ws1 = MockWebSocket.lastInstance();
    expect(ws1).toBeDefined();

    act(() => {
      ws1!.simulateError();
      ws1!.simulateClose(1006);
    });

    await waitFor(() => {
      expect(states).toContain("reconnecting");
    });

    await waitFor(() => {
      expect(MockWebSocket.instances.length).toBeGreaterThan(1);
    });

    const ws2 = MockWebSocket.lastInstance();
    expect(ws2).toBeDefined();
    expect(ws2).not.toBe(ws1);

    act(() => {
      ws2!.simulateError();
      ws2!.simulateClose(1006);
    });

    await waitFor(() => {
      expect(states).toContain("auth_required");
    });

    expect(probeCalls).toBeGreaterThanOrEqual(2);
    expect(MockWebSocket.instances).toHaveLength(2);
  });

  test("reconnects on connection loss when previously connected", async () => {
    const states: string[] = [];

    render(
      <APIProvider createWebSocket={createMockWebSocket}>
        <APIStateObserver onState={(s) => states.push(s.status)} />
      </APIProvider>
    );

    const ws1 = MockWebSocket.lastInstance();
    expect(ws1).toBeDefined();

    await act(async () => {
      ws1!.simulateOpen();
      await new Promise((r) => setTimeout(r, 10));
    });

    expect(states).toContain("connected");

    // Connection lost after being connected
    act(() => {
      ws1!.simulateError();
      ws1!.simulateClose(1006);
    });

    await waitFor(() => {
      expect(states).toContain("reconnecting");
    });

    const authRequiredAfterConnected = states.slice(states.indexOf("connected") + 1);
    expect(authRequiredAfterConnected.filter((s) => s === "auth_required")).toHaveLength(0);
  });

  // Liveness harness: the auth-check ping resolves immediately so the provider reaches
  // "connected"; every later (liveness) ping goes through `livenessPing`.
  function installLivenessPing(livenessPing: () => Promise<string>): () => number {
    let pingCallCount = 0;
    pingImpl = () => {
      pingCallCount++;
      return pingCallCount === 1 ? Promise.resolve("pong") : livenessPing();
    };
    return () => pingCallCount;
  }

  const delayedPong = (ms: number) => () =>
    new Promise<string>((resolve) => setTimeout(() => resolve("pong"), ms));

  const neverSettlingPong = () => new Promise<string>(() => undefined);

  async function connectFirstSocket(states: ObservedState[]): Promise<MockWebSocket> {
    render(
      <APIProvider createWebSocket={createMockWebSocket}>
        <APIStateObserver onState={(s) => states.push(s)} />
      </APIProvider>
    );

    const ws1 = MockWebSocket.lastInstance();
    expect(ws1).toBeDefined();

    act(() => {
      ws1!.simulateOpen();
    });

    await waitFor(() => {
      expect(states.some((s) => s.status === "connected")).toBe(true);
    });

    return ws1!;
  }

  function streamFramesEvery(ws: MockWebSocket, ms: number): () => void {
    const interval = setInterval(() => {
      ws.simulateMessage({ type: "stream-delta" });
    }, ms);
    return () => clearInterval(interval);
  }

  function latestDegraded(states: ObservedState[]): ObservedState {
    const degraded = states.filter((s) => s.status === "degraded");
    expect(degraded.length).toBeGreaterThan(0);
    return degraded[degraded.length - 1];
  }

  test(
    "marks the connection degraded when pongs are slow even while stream frames keep arriving",
    async () => {
      const states: ObservedState[] = [];
      installLivenessPing(delayedPong(3000));

      const ws1 = await connectFirstSocket(states);
      const stopFrames = streamFramesEvery(ws1, 250);

      try {
        await waitFor(
          () => {
            expect(states.some((s) => s.status === "degraded")).toBe(true);
          },
          { timeout: 20000 }
        );
      } finally {
        stopFrames();
      }

      expect(latestDegraded(states).latencyMs ?? 0).toBeGreaterThan(2000);
      expect(states.filter((s) => s.status === "reconnecting")).toHaveLength(0);
      expect(MockWebSocket.instances).toHaveLength(1);
    },
    { timeout: 25000 }
  );

  test(
    "returns to connected after one fast probe once the server speeds up",
    async () => {
      const states: ObservedState[] = [];
      let livenessPing: () => Promise<string> = delayedPong(3000);
      installLivenessPing(() => livenessPing());

      await connectFirstSocket(states);

      await waitFor(
        () => {
          expect(states.some((s) => s.status === "degraded")).toBe(true);
        },
        { timeout: 20000 }
      );

      livenessPing = () => Promise.resolve("pong");
      const degradedIndex = states.length;

      await waitFor(
        () => {
          expect(states.slice(degradedIndex).some((s) => s.status === "connected")).toBe(true);
        },
        { timeout: 12000 }
      );

      expect(MockWebSocket.instances).toHaveLength(1);
    },
    { timeout: 25000 }
  );

  test(
    "keeps one probe outstanding and grows the reported latency without republishing the API context while a ping stalls under stream traffic",
    async () => {
      const states: ObservedState[] = [];
      const pingCalls = installLivenessPing(neverSettlingPong);

      const ws1 = await connectFirstSocket(states);
      const stopFrames = streamFramesEvery(ws1, 250);

      try {
        await waitFor(
          () => {
            expect(states.some((s) => s.status === "degraded")).toBe(true);
          },
          { timeout: 20000 }
        );
        const firstLatency = latestDegraded(states).latencyMs ?? 0;

        await waitFor(
          () => {
            expect(latestDegraded(states).latencyMs ?? 0).toBeGreaterThan(firstLatency);
          },
          { timeout: 10000 }
        );
        // Latency ticks flow through the narrow latency context only: every degraded
        // observation shares one API context value, so useAPI() consumers do not re-render.
        const degradedObservations = states.filter((s) => s.status === "degraded");
        expect(new Set(degradedObservations.map((s) => s.latencyMs)).size).toBeGreaterThan(1);
        expect(new Set(degradedObservations.map((s) => s.apiState)).size).toBe(1);
      } finally {
        stopFrames();
      }

      // Auth-check plus exactly one liveness probe: a stalled probe is never re-sent before
      // it is abandoned, and inbound frames must not trigger a reconnect.
      expect(pingCalls()).toBe(2);
      expect(MockWebSocket.instances).toHaveLength(1);
    },
    { timeout: 25000 }
  );

  test(
    "reconnects only when a probe stalls with no inbound traffic at all",
    async () => {
      const states: ObservedState[] = [];
      installLivenessPing(neverSettlingPong);

      await connectFirstSocket(states);

      await waitFor(
        () => {
          expect(MockWebSocket.instances.length).toBe(2);
        },
        { timeout: 22000 }
      );

      // The forced reconnect must stay visible as "reconnecting" through the replacement
      // socket's handshake; "connecting" renders no banner and is reserved for the initial load.
      const statusesAfterConnected = states
        .map((s) => s.status)
        .slice(states.findIndex((s) => s.status === "connected") + 1);
      expect(statusesAfterConnected).toContain("reconnecting");
      expect(statusesAfterConnected).not.toContain("connecting");
      expect(statusesAfterConnected).not.toContain("auth_required");

      // The replacement socket's auth-check pong is the next ping call.
      pingImpl = () => Promise.resolve("pong");
      const reconnectIndex = states.length;
      act(() => {
        MockWebSocket.lastInstance()!.simulateOpen();
      });

      await waitFor(() => {
        expect(states.slice(reconnectIndex).some((s) => s.status === "connected")).toBe(true);
      });
    },
    { timeout: 25000 }
  );

  test(
    "reconnects on a late tick past the probe age limit instead of re-probing a silent socket",
    async () => {
      const states: ObservedState[] = [];
      const pingCalls = installLivenessPing(neverSettlingPong);
      const realNow = performance.now.bind(performance);

      try {
        await connectFirstSocket(states);
        await waitFor(() => {
          expect(pingCalls()).toBe(2);
        });

        // Emulate a throttled tab whose next interval fires long after the probe was sent.
        const skewMs = 31000;
        performance.now = () => realNow() + skewMs;

        await waitFor(
          () => {
            expect(MockWebSocket.instances.length).toBe(2);
          },
          { timeout: 8000 }
        );
      } finally {
        performance.now = realNow;
      }

      // The stalled probe was not replaced on the old socket before reconnecting.
      expect(pingCalls()).toBe(2);
    },
    { timeout: 20000 }
  );

  test(
    "still degrades on a stalled probe when the wall clock steps backwards",
    async () => {
      const states: ObservedState[] = [];
      installLivenessPing(neverSettlingPong);
      const realDateNow = Date.now;

      try {
        await connectFirstSocket(states);
        // A clock correction after the probe was sent must not make it look young.
        Date.now = () => realDateNow() - 60000;

        await waitFor(
          () => {
            expect(states.some((s) => s.status === "degraded")).toBe(true);
          },
          { timeout: 15000 }
        );
      } finally {
        Date.now = realDateNow;
      }
    },
    { timeout: 20000 }
  );

  test(
    "reconnects after repeated rejected probes so a lost session reaches auth_required",
    async () => {
      const states: ObservedState[] = [];
      installLivenessPing(() => Promise.reject(new Error("401 Unauthorized")));

      await connectFirstSocket(states);

      // Rejections are answers, not silence: the transport is alive, so only the rejected-probe
      // counter can drive this reconnect.
      await waitFor(
        () => {
          expect(MockWebSocket.instances.length).toBe(2);
        },
        { timeout: 16000 }
      );
      // Prompt rejections are not slowness either: no "slow to respond" indicator on the way.
      expect(states.some((s) => s.status === "degraded")).toBe(false);

      act(() => {
        MockWebSocket.lastInstance()!.simulateOpen();
      });

      await waitFor(() => {
        expect(states.some((s) => s.status === "auth_required")).toBe(true);
      });
      expect(clearStoredAuthTokenMock).toHaveBeenCalled();
    },
    { timeout: 25000 }
  );

  test(
    "keeps probing at the liveness interval while stream frames flow and pongs are fast",
    async () => {
      const states: ObservedState[] = [];
      const pingCalls = installLivenessPing(() => Promise.resolve("pong"));

      const ws1 = await connectFirstSocket(states);
      const stopFrames = streamFramesEvery(ws1, 250);

      try {
        // Auth-check, the immediate first probe, then one probe per interval.
        await waitFor(
          () => {
            expect(pingCalls()).toBeGreaterThanOrEqual(4);
          },
          { timeout: 15000 }
        );
      } finally {
        stopFrames();
      }

      expect(states.filter((s) => s.status === "degraded")).toHaveLength(0);
      expect(MockWebSocket.instances).toHaveLength(1);
    },
    { timeout: 25000 }
  );

  test("does not flicker into reconnecting when auth is rejected by ping", async () => {
    const states: string[] = [];
    pingImpl = () => Promise.reject(new Error("401 Unauthorized"));

    render(
      <APIProvider createWebSocket={createMockWebSocket}>
        <APIStateObserver onState={(s) => states.push(s.status)} />
      </APIProvider>
    );

    const ws1 = MockWebSocket.lastInstance();
    expect(ws1).toBeDefined();

    await act(async () => {
      ws1!.simulateOpen();
      await new Promise((r) => setTimeout(r, 10));
    });

    await waitFor(() => {
      expect(states).toContain("auth_required");
    });

    // Simulate a close after we decided auth is required (cleanup closes the socket in real life).
    act(() => {
      ws1!.simulateClose(1000);
    });

    // Give state a chance to update if a reconnect was scheduled.
    await new Promise((r) => setTimeout(r, 25));

    expect(states.filter((s) => s === "reconnecting")).toHaveLength(0);
    expect(MockWebSocket.instances).toHaveLength(1);
  });
});

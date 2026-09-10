import { SERVER_VERSION_CHECK_TIMEOUT_MS } from "@/constants/serverUpdate";
import { VERSION } from "@/version";
import {
  createContext,
  useContext,
  useEffect,
  useState,
  useCallback,
  useRef,
  useMemo,
} from "react";
import { createClient } from "@/common/orpc/client";
import { requestWebSocketTicket, WebSocketTicketError } from "@/common/orpc/webSocketTicket";
import { ORPC_WS_PROTOCOL, ORPC_WS_TICKET_PREFIX } from "@/common/constants/webSocketAuth";
import { RPCLink as WebSocketLink } from "@orpc/client/websocket";
import { RPCLink as MessagePortLink } from "@orpc/client/message-port";
import {
  getStoredAuthToken,
  setStoredAuthToken,
  clearStoredAuthToken,
} from "@/browser/components/AuthTokenModal/AuthTokenModal";
import { getBrowserBackendBaseUrl } from "@/browser/utils/backendBaseUrl";
import { getErrorMessage } from "@/common/utils/errors";

type APIClient = ReturnType<typeof createClient>;

export type { APIClient };

// Discriminated union for type-safe state handling
export type APIState =
  | { status: "connecting"; api: null; error: null }
  | { status: "connected"; api: APIClient; error: null }
  | { status: "degraded"; api: APIClient; error: null } // Connected but the backend answers slowly
  | { status: "reconnecting"; api: null; error: null; attempt: number }
  | { status: "auth_required"; api: null; error: string | null }
  | { status: "error"; api: null; error: string };

interface APIStateMethods {
  authenticate: (token: string) => void;
  retry: () => void;
}

// Union distributes over intersection, preserving discriminated union behavior
export type UseAPIResult = APIState & APIStateMethods;

// Internal state for the provider (includes cleanup)
type ConnectionState =
  | { status: "connecting" }
  | { status: "connected"; client: APIClient; cleanup: () => void }
  | { status: "degraded"; client: APIClient; cleanup: () => void } // Backend slow
  | { status: "reconnecting"; attempt: number }
  | { status: "auth_required"; error?: string }
  | { status: "error"; error: string };

// Reconnection constants
const MAX_RECONNECT_ATTEMPTS = 10;
const BASE_DELAY_MS = 100;
const MAX_DELAY_MS = 10000;

// Startup auth probe: if the initial WS handshake fails with an abnormal closure (1006),
// browsers often hide the underlying HTTP status (401/403). We fetch /api/spec.json to
// infer whether auth is required, but the probe must never block reconnect progress.
const AUTH_PROBE_TIMEOUT_MS = 2000;
// Token attempts include ticket acquisition, upgrade and the authenticated ping.
const TOKEN_CONNECTION_TIMEOUT_MS = 10_000;

// Liveness check constants. The probe measures backend round-trip time: a connection whose
// transport is alive but whose server answers slowly must still surface as degraded.
const LIVENESS_INTERVAL_MS = 5000;
// A probe whose RTT (or pending age at tick time) exceeds this is one "slow" observation.
const SLOW_RESPONSE_MS = 2000;
// A single slow ping is transient; require consecutive slow observations before degrading.
const SLOW_OBSERVATIONS_FOR_DEGRADED = 2;
// Browser WebSocket only: force reconnect when a probe has been outstanding this long AND no
// inbound frame of any kind arrived meanwhile (the socket may be half-open).
const SILENCE_FOR_RECONNECT_MS = 15000;
// Abandon an outstanding probe older than this so a single lost ping cannot pin the
// indicator on "degraded" after the backend recovers.
const MAX_PROBE_AGE_MS = 30000;
// Browser WebSocket only: a probe that is rejected outright (not slow) means the server is
// answering but refusing us, e.g. an expired session. Reconnect after this many in a row so
// the handshake's auth-check can surface auth_required instead of pinning "degraded".
const REJECTED_PROBES_FOR_RECONNECT = 3;

// Exported so hooks that need to tolerate being mounted outside an
// APIProvider (e.g., `useGoalDefaults`, `useGoalBoard`) can read the
// context directly and short-circuit gracefully when it's null. The
// canonical `useAPI()` below still throws — keep using it whenever
// API access is required, not optional.
export const APIContext = createContext<UseAPIResult | null>(null);

// The live latency figure changes on every liveness tick while degraded. It lives in its own
// context so those ticks re-render only the indicator, not every useAPI() consumer.
const ConnectionLatencyContext = createContext<number | null>(null);

interface APIProviderProps {
  children: React.ReactNode;
  /** Optional pre-created client. If provided, skips internal connection setup. */
  client?: APIClient;
  /** WebSocket factory for testing. Defaults to native WebSocket constructor. */
  createWebSocket?: (url: string, protocols?: string[]) => WebSocket;
}

const noopConnectionControl = (_token?: string) => undefined;

function closeWebSocketSafely(ws: WebSocket) {
  try {
    // readyState: 0 = CONNECTING, 1 = OPEN, 2 = CLOSING, 3 = CLOSED
    if (ws.readyState === 2 || ws.readyState === 3) return;
    ws.close();
  } catch {
    // Some browsers throw if close() is called while already closing/closed.
    // Since our cleanup can be invoked from multiple code paths, treat close as idempotent.
  }
}

function createElectronClient(): { client: APIClient; cleanup: () => void } {
  const { port1: clientPort, port2: serverPort } = new MessageChannel();
  window.postMessage("start-orpc-client", "*", [serverPort]);

  const link = new MessagePortLink({ port: clientPort });
  clientPort.start();

  return {
    client: createClient(link),
    cleanup: () => clientPort.close(),
  };
}

function createBrowserClient(
  protocols: string[] | undefined,
  createWebSocket: (url: string, protocols?: string[]) => WebSocket
): {
  client: APIClient;
  cleanup: () => void;
  ws: WebSocket;
} {
  const apiBaseUrl = getBrowserBackendBaseUrl();

  const wsUrl = new URL(`${apiBaseUrl}/orpc/ws`);
  wsUrl.protocol = wsUrl.protocol === "https:" ? "wss:" : "ws:";
  const ws = createWebSocket(wsUrl.toString(), protocols);
  // oRPC >=1.14 replaced the `websocket` option with a `connect` factory.
  const link = new WebSocketLink({ connect: () => ws });

  return {
    client: createClient(link),
    cleanup: () => closeWebSocketSafely(ws),
    ws,
  };
}

async function reloadIfServerBuildChanged(
  backendBaseUrl: string,
  isCurrentConnection: () => boolean
): Promise<void> {
  try {
    const response = await fetch(`${backendBaseUrl}/version`, {
      cache: "no-store",
      signal: AbortSignal.timeout(SERVER_VERSION_CHECK_TIMEOUT_MS),
    });
    const version: unknown = response.ok ? await response.json() : null;
    if (
      isCurrentConnection() &&
      version &&
      typeof version === "object" &&
      "git_commit" in version &&
      typeof version.git_commit === "string" &&
      version.git_commit.length > 0 &&
      (version.git_commit !== VERSION.git_commit ||
        ("git_describe" in version && version.git_describe !== VERSION.git_describe))
    ) {
      window.location.reload();
    }
  } catch {
    // Version discovery must not disturb an already reconnected client.
  }
}

function ManagedAPIProvider(props: Omit<APIProviderProps, "client">) {
  const [state, setState] = useState<ConnectionState>({ status: "connecting" });
  const [authToken, setAuthToken] = useState<string | null>(() => {
    const urlParams = new URLSearchParams(window.location.search);
    const urlToken = urlParams.get("token")?.trim();
    if (urlToken) {
      setStoredAuthToken(urlToken);
      // Strip token from URL so it doesn't leak into bookmarks, browser
      // history, PWA launch URLs, or Referer headers.
      const cleanUrl = new URL(window.location.href);
      cleanUrl.searchParams.delete("token");
      window.history.replaceState({}, "", cleanUrl.pathname + cleanUrl.search);
      return urlToken;
    }

    return getStoredAuthToken();
  });

  // Connection callbacks can schedule retries before React commits a token change.
  const authTokenRef = useRef(authToken);
  const cleanupRef = useRef<(() => void) | null>(null);
  const hasConnectedRef = useRef(false);
  const reconnectAttemptRef = useRef(0);
  const reconnectTimeoutRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const scheduleReconnectRef = useRef<(() => void) | null>(null);
  const consecutiveSlowProbesRef = useRef(0);
  const consecutiveRejectedProbesRef = useRef(0);
  const [latencyMs, setLatencyMs] = useState<number | null>(null);
  const connectionIdRef = useRef(0);
  const forceReconnectInProgressRef = useRef(false);
  // Probe ages, RTT, and silence use performance.now(): it is monotonic, whereas a wall-clock
  // correction could make a stalled probe look young or a slow probe look fast.
  const outstandingProbeRef = useRef<{ sentAt: number; connectionId: number } | null>(null);
  const lastInboundBrowserFrameAtRef = useRef(0);

  // When we decide the user needs to provide a token, stop the reconnect loop.
  //
  // Otherwise, the WebSocket close event (triggered by cleanup()) can schedule a reconnect
  // which immediately flips the UI back to "reconnecting", causing the AuthTokenModal
  // to flicker.
  const authRequiredRef = useRef(false);

  const authProbeAttemptedRef = useRef(false);
  const wsFactory = useMemo(
    () =>
      props.createWebSocket ??
      ((url: string, protocols?: string[]) => new WebSocket(url, protocols)),
    [props.createWebSocket]
  );

  const connect = useCallback(
    (token: string | null) => {
      const connectionId = ++connectionIdRef.current;
      // Reset per-connection liveness bookkeeping so a prior socket's frames or probes
      // cannot influence the next connection. Silence is measured from the connect time until
      // the first frame arrives.
      lastInboundBrowserFrameAtRef.current = performance.now();
      outstandingProbeRef.current = null;
      consecutiveSlowProbesRef.current = 0;
      consecutiveRejectedProbesRef.current = 0;
      setLatencyMs(null);

      authRequiredRef.current = false;

      // This connect() call supersedes any prior pending reconnect or active connection.
      if (reconnectTimeoutRef.current) {
        clearTimeout(reconnectTimeoutRef.current);
        reconnectTimeoutRef.current = null;
      }

      cleanupRef.current?.();
      cleanupRef.current = null;

      // Skip Electron detection if custom WebSocket factory provided (for testing)
      if (!props.createWebSocket && window.api) {
        const { client, cleanup } = createElectronClient();
        window.__ORPC_CLIENT__ = client;
        cleanupRef.current = cleanup;
        setState({ status: "connected", client, cleanup });
        return;
      }

      // Once a session has been connected, any new attempt is a reconnect from the user's
      // perspective: keep the "Reconnecting to server" banner up through the handshake instead
      // of dropping to "connecting", which renders nothing and is meant for the initial load.
      setState(
        hasConnectedRef.current
          ? { status: "reconnecting", attempt: Math.max(1, reconnectAttemptRef.current) }
          : { status: "connecting" }
      );
      const controller = new AbortController();
      let retired = false;
      let socketCleanup: () => void = () => undefined;
      let timeout: ReturnType<typeof setTimeout> | undefined;
      const isCurrent = () => !retired && connectionId === connectionIdRef.current;
      const cleanup = () => {
        if (retired) return;
        retired = true;
        clearTimeout(timeout);
        controller.abort();
        socketCleanup();
      };
      // Own pending HTTP/upgrade work before the first await, not only an authenticated socket.
      cleanupRef.current = cleanup;
      const failAttempt = (error: unknown) => {
        if (!isCurrent()) return;
        cleanup();
        forceReconnectInProgressRef.current = false;
        if (error instanceof WebSocketTicketError && error.reason === "authentication") {
          clearStoredAuthToken();
          authTokenRef.current = null;
          setAuthToken(null);
          // Auth may have been disabled, or an existing cookie may suffice. Try the
          // ordinary credential-free path once; its auth checks still own the modal.
          hasConnectedRef.current = false;
          authProbeAttemptedRef.current = false;
          reconnectAttemptRef.current = 0;
          scheduleReconnectRef.current?.();
        } else if (error instanceof WebSocketTicketError && error.reason === "unsupported") {
          setState({ status: "error", error: error.message });
        } else {
          scheduleReconnectRef.current?.();
        }
      };
      const openBrowserConnection = (protocols?: string[]) => {
        const { client, cleanup: closeSocket, ws } = createBrowserClient(protocols, wsFactory);
        socketCleanup = closeSocket;
        ws.addEventListener("message", () => {
          // Inbound frames prove the transport is alive, not that the backend is responsive:
          // they only suppress the total-silence reconnect and never skip or satisfy a probe.
          if (!isCurrent()) {
            return;
          }

          lastInboundBrowserFrameAtRef.current = performance.now();
        });

        ws.addEventListener("open", () => {
          // Ignore stale connections (can happen if we force reconnect while the old socket is mid-flight).
          if (!isCurrent()) {
            cleanup();
            return;
          }

          if (token && ws.protocol !== ORPC_WS_PROTOCOL) {
            failAttempt(new WebSocketTicketError("transient"));
            return;
          }

          client.general
            .ping("auth-check", { signal: controller.signal })
            .then(() => {
              // Ignore stale connections (e.g., auth-check returned after a new connect()).
              if (!isCurrent()) {
                cleanup();
                return;
              }

              clearTimeout(timeout);
              const reconnected = hasConnectedRef.current;
              authRequiredRef.current = false;
              hasConnectedRef.current = true;
              reconnectAttemptRef.current = 0;
              consecutiveSlowProbesRef.current = 0;
              forceReconnectInProgressRef.current = false;
              window.__ORPC_CLIENT__ = client;
              cleanupRef.current = cleanup;
              setState({ status: "connected", client, cleanup });
              // A reconnected socket may belong to a newer server than this loaded bundle. The probe
              // runs after the client is published so a slow /version never delays reconnection, and
              // only a bundle served by that server can be refreshed by reloading, so split-origin
              // setups (VITE_BACKEND_URL, extension webviews) skip it.
              const backendBaseUrl = getBrowserBackendBaseUrl();
              if (reconnected && new URL(backendBaseUrl).origin === window.location.origin) {
                void reloadIfServerBuildChanged(
                  backendBaseUrl,
                  () => connectionId === connectionIdRef.current
                );
              }
            })
            .catch((err: unknown) => {
              if (!isCurrent()) {
                cleanup();
                return;
              }

              forceReconnectInProgressRef.current = false;
              const errMsg = getErrorMessage(err);
              const errMsgLower = errMsg.toLowerCase();
              const isAuthError =
                errMsgLower.includes("unauthorized") ||
                errMsgLower.includes("401") ||
                errMsgLower.includes("auth token") ||
                errMsgLower.includes("authentication");

              if (isAuthError && !token) {
                authRequiredRef.current = true;
                clearStoredAuthToken();
                hasConnectedRef.current = false; // Reset - need fresh auth
                setState({ status: "auth_required", error: token ? "Invalid token" : undefined });
                cleanup();
                return;
              }

              cleanup();
              if (token) scheduleReconnectRef.current?.();
              else setState({ status: "error", error: errMsg });
            });
        });

        // Note: Browser fires 'error' before 'close', so we handle reconnection
        // only in 'close' to avoid double-scheduling. The 'error' event just
        // signals that something went wrong; 'close' provides the final state.
        ws.addEventListener("error", () => {
          // Error occurred - close event will follow and handle reconnection
          // We don't call cleanup() here since close handler will do it
        });

        ws.addEventListener("close", (event) => {
          const wasCurrent = isCurrent();
          cleanup();

          // Cleanup retires this attempt before a synchronous close callback can reconnect it.
          if (!wasCurrent) return;

          forceReconnectInProgressRef.current = false;

          // If we've already decided auth is required (e.g. via ping error), don't immediately
          // overwrite the modal with a reconnect attempt.
          // Auth-specific close codes
          if (!token && (event.code === 1008 || event.code === 4401)) {
            authRequiredRef.current = true;
            clearStoredAuthToken();
            hasConnectedRef.current = false; // Reset - need fresh auth
            setState({ status: "auth_required", error: "Authentication required" });
            return;
          }

          if (authRequiredRef.current) {
            return;
          }

          // If this is the initial connection attempt and the WS handshake failed, browsers often
          // collapse HTTP auth errors (401/403) into an abnormal closure (1006) with no status.
          //
          // If the backend is reachable over HTTP, we can use the OpenAPI spec to disambiguate:
          // the server includes a `security` stanza when a bearer token is required.
          if (
            !hasConnectedRef.current &&
            !token &&
            event.code === 1006 &&
            !authProbeAttemptedRef.current
          ) {
            authProbeAttemptedRef.current = true;

            const apiBaseUrl = getBrowserBackendBaseUrl();
            const specUrl = new URL(`${apiBaseUrl}/api/spec.json`);

            type AuthProbeResult = "requires_auth" | "no_auth" | "unknown";

            const controller = new AbortController();
            let timeoutId: ReturnType<typeof setTimeout> | null = null;

            // `fetch` has no builtin timeout, and some environments don't reliably reject on abort.
            // Use a race so the probe cannot hang the connection loop.
            const timeoutPromise = new Promise<AuthProbeResult>((resolve) => {
              timeoutId = setTimeout(() => {
                controller.abort();
                resolve("unknown");
              }, AUTH_PROBE_TIMEOUT_MS);
            });

            const fetchPromise: Promise<AuthProbeResult> = fetch(specUrl, {
              signal: controller.signal,
            })
              .then(async (res): Promise<AuthProbeResult> => {
                if (!res.ok) return "unknown";

                try {
                  const spec = (await res.json()) as { security?: unknown };
                  const requiresAuth = Array.isArray(spec.security) && spec.security.length > 0;
                  return requiresAuth ? "requires_auth" : "no_auth";
                } catch {
                  return "unknown";
                }
              })
              .catch((): AuthProbeResult => "unknown");

            void Promise.race([fetchPromise, timeoutPromise])
              .then((result) => {
                if (connectionId !== connectionIdRef.current) {
                  return;
                }

                if (result === "requires_auth") {
                  authRequiredRef.current = true;
                  clearStoredAuthToken();
                  hasConnectedRef.current = false; // Reset - need fresh auth
                  setState({ status: "auth_required", error: "Authentication required" });
                  return;
                }

                if (result === "unknown") {
                  // Probe was inconclusive (timeout, network error, non-OK, invalid JSON). Allow re-probe
                  // on a later initial-handshake failure.
                  authProbeAttemptedRef.current = false;
                }

                scheduleReconnectRef.current?.();
              })
              .finally(() => {
                if (timeoutId) {
                  clearTimeout(timeoutId);
                }
              });

            return;
          }
          // If we were previously connected, try to reconnect
          if (hasConnectedRef.current) {
            scheduleReconnectRef.current?.();
            return;
          }

          // First connection failed.
          // This can happen in dev-server mode if the UI boots before the backend is ready.
          // Prefer retry/backoff over forcing the auth modal (auth will be detected via ping/close codes).
          scheduleReconnectRef.current?.();
        });
      };
      if (token) {
        timeout = setTimeout(
          () => failAttempt(new WebSocketTicketError("transient")),
          TOKEN_CONNECTION_TIMEOUT_MS
        );
        requestWebSocketTicket(getBrowserBackendBaseUrl(), token, controller.signal)
          .then(({ ticket }) => {
            if (isCurrent())
              openBrowserConnection([ORPC_WS_PROTOCOL, `${ORPC_WS_TICKET_PREFIX}${ticket}`]);
          })
          .catch(failAttempt);
      } else {
        // Cookie-only browser sessions keep their existing handshake and auth probe.
        try {
          openBrowserConnection();
        } catch (error) {
          failAttempt(error);
        }
      }
    },
    [props.createWebSocket, wsFactory]
  );

  // Schedule reconnection with exponential backoff
  const scheduleReconnect = useCallback(() => {
    if (reconnectTimeoutRef.current) {
      clearTimeout(reconnectTimeoutRef.current);
    }

    const attempt = reconnectAttemptRef.current;
    if (attempt >= MAX_RECONNECT_ATTEMPTS) {
      const error = hasConnectedRef.current
        ? "Connection lost. Please refresh the page."
        : "Failed to connect to the Xum backend after multiple attempts.";
      setState({ status: "error", error });
      return;
    }

    const delay = Math.min(BASE_DELAY_MS * Math.pow(2, attempt), MAX_DELAY_MS);
    reconnectAttemptRef.current = attempt + 1;
    setState({ status: "reconnecting", attempt: attempt + 1 });

    reconnectTimeoutRef.current = setTimeout(() => {
      connect(authTokenRef.current);
    }, delay);
  }, [connect]);

  // Keep ref in sync with latest scheduleReconnect
  scheduleReconnectRef.current = scheduleReconnect;

  useEffect(() => {
    connect(authToken);
    return () => {
      connectionIdRef.current += 1;
      cleanupRef.current?.();
      if (reconnectTimeoutRef.current) {
        clearTimeout(reconnectTimeoutRef.current);
      }
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // Liveness check: probe the backend's round-trip time to detect a slow server, for both
  // browser WebSocket and Electron MessagePort clients. Keyed on the live client identity
  // rather than the whole state object: degraded <-> connected transitions keep the same
  // client, so per-tick latency updates must not restart the interval or the outstanding probe.
  const isLive = state.status === "connected" || state.status === "degraded";
  const liveClient = isLive ? state.client : null;
  const liveCleanup = isLive ? state.cleanup : null;
  useEffect(() => {
    if (!liveClient || !liveCleanup) return;
    const client = liveClient;
    const cleanup = liveCleanup;
    // Electron has no socket to reconnect and no inbound-frame signal, so it only gets
    // RTT-based degraded detection.
    const isBrowserWebSocket = Boolean(props.createWebSocket) || !window.api;
    let effectDisposed = false;

    const forceReconnect = (reason: string) => {
      if (!isBrowserWebSocket || forceReconnectInProgressRef.current) return false;
      forceReconnectInProgressRef.current = true;
      console.warn(`[APIProvider] ${reason}; reconnecting...`);
      cleanup();
      if (!effectDisposed) connect(authTokenRef.current);
      return true;
    };

    const recordSlowObservation = (observedLatencyMs: number) => {
      consecutiveSlowProbesRef.current += 1;
      if (consecutiveSlowProbesRef.current < SLOW_OBSERVATIONS_FOR_DEGRADED) return;
      setLatencyMs(observedLatencyMs);
      // Returning prev while already degraded keeps the API context value stable, so only the
      // latency context consumers re-render on later ticks.
      setState((prev) =>
        prev.status === "connected" && prev.client === client
          ? { status: "degraded", client, cleanup }
          : prev
      );
    };

    const recordFastObservation = () => {
      consecutiveSlowProbesRef.current = 0;
      forceReconnectInProgressRef.current = false;
      setLatencyMs(null);
      setState((prev) =>
        prev.status === "degraded" && prev.client === client
          ? { status: "connected", client, cleanup }
          : prev
      );
    };

    const sendProbe = () => {
      const probe = { sentAt: performance.now(), connectionId: connectionIdRef.current };
      outstandingProbeRef.current = probe;

      const settle = (resolved: boolean) => {
        // Ignore settlements from a superseded socket, a disposed effect, or an abandoned probe.
        if (
          effectDisposed ||
          probe.connectionId !== connectionIdRef.current ||
          outstandingProbeRef.current !== probe
        ) {
          return;
        }
        outstandingProbeRef.current = null;
        const rtt = performance.now() - probe.sentAt;
        if (resolved) {
          consecutiveRejectedProbesRef.current = 0;
          if (rtt <= SLOW_RESPONSE_MS) {
            recordFastObservation();
            return;
          }
          recordSlowObservation(rtt);
          return;
        }
        // A rejection is a prompt answer, not slowness: it never feeds the latency indicator.
        consecutiveRejectedProbesRef.current += 1;
        if (consecutiveRejectedProbesRef.current >= REJECTED_PROBES_FOR_RECONNECT) {
          forceReconnect(`Liveness probe rejected ${consecutiveRejectedProbesRef.current} times`);
        }
      };

      client.general.ping("liveness").then(
        () => settle(true),
        () => settle(false)
      );
    };

    const tick = () => {
      if (effectDisposed) return;
      const now = performance.now();
      const outstanding = outstandingProbeRef.current;

      if (outstanding) {
        const pendingMs = now - outstanding.sentAt;
        // Silence is checked before the probe is aged out: a throttled or suspended tab can
        // fire its next tick past MAX_PROBE_AGE_MS, and a half-open socket must reconnect on
        // that tick rather than merely re-probe.
        const silentMs = now - lastInboundBrowserFrameAtRef.current;
        if (
          pendingMs >= SILENCE_FOR_RECONNECT_MS &&
          silentMs >= SILENCE_FOR_RECONNECT_MS &&
          forceReconnect(`Liveness probe outstanding for ${pendingMs}ms with no inbound traffic`)
        ) {
          return;
        }
        if (pendingMs <= MAX_PROBE_AGE_MS) {
          // At most one probe in flight; a pending probe past the slow threshold is itself a
          // slow observation, with the pending age as the live latency figure.
          if (pendingMs > SLOW_RESPONSE_MS) {
            recordSlowObservation(pendingMs);
          }
          return;
        }
        // Presume the probe lost; its eventual settlement is ignored via the identity check.
        outstandingProbeRef.current = null;
      }

      sendProbe();
    };

    tick();
    const intervalId = setInterval(tick, LIVENESS_INTERVAL_MS);
    return () => {
      effectDisposed = true;
      clearInterval(intervalId);
      outstandingProbeRef.current = null;
    };
  }, [liveClient, liveCleanup, props.createWebSocket, connect]);

  const authenticate = useCallback(
    (token: string) => {
      authProbeAttemptedRef.current = false;
      authTokenRef.current = token;
      setStoredAuthToken(token);
      setAuthToken(token);
      connect(token);
    },
    [connect]
  );

  const retry = useCallback(() => {
    authProbeAttemptedRef.current = false;
    connect(authTokenRef.current);
  }, [connect]);

  // Convert internal state to the discriminated union API
  const value = useMemo((): UseAPIResult => {
    const base = { authenticate, retry };
    switch (state.status) {
      case "connecting":
        return { status: "connecting", api: null, error: null, ...base };
      case "connected":
        return { status: "connected", api: state.client, error: null, ...base };
      case "degraded":
        return { status: "degraded", api: state.client, error: null, ...base };
      case "reconnecting":
        return { status: "reconnecting", api: null, error: null, attempt: state.attempt, ...base };
      case "auth_required":
        return { status: "auth_required", api: null, error: state.error ?? null, ...base };
      case "error":
        return { status: "error", api: null, error: state.error, ...base };
    }
  }, [state, authenticate, retry]);

  // Always render children - consumers handle their own loading/error states
  return (
    <APIContext.Provider value={value}>
      <ConnectionLatencyContext.Provider value={latencyMs}>
        {props.children}
      </ConnectionLatencyContext.Provider>
    </APIContext.Provider>
  );
}

function InjectedClientAPIProvider(
  props: Pick<APIProviderProps, "children"> & { client: APIClient }
) {
  // User rationale: injected clients are already fully constructed, so wrapping them in the
  // browser liveness/reconnect state machine risks leaking async state updates into tests.
  window.__ORPC_CLIENT__ = props.client;

  return (
    <APIContext.Provider
      value={{
        status: "connected",
        api: props.client,
        error: null,
        authenticate: noopConnectionControl,
        retry: noopConnectionControl,
      }}
    >
      {props.children}
    </APIContext.Provider>
  );
}

export const APIProvider = (props: APIProviderProps) => {
  if (props.client) {
    return (
      <InjectedClientAPIProvider client={props.client}>{props.children}</InjectedClientAPIProvider>
    );
  }

  return (
    <ManagedAPIProvider createWebSocket={props.createWebSocket}>
      {props.children}
    </ManagedAPIProvider>
  );
};

export const useAPI = (): UseAPIResult => {
  const context = useContext(APIContext);
  if (!context) {
    throw new Error("useAPI must be used within an APIProvider");
  }
  return context;
};

/**
 * Like {@link useAPI} but returns null instead of throwing when there is no APIProvider.
 * Use this in best-effort hooks that may render outside an APIProvider (e.g. isolated
 * test harnesses) and should degrade gracefully rather than crash.
 */
export const useOptionalAPI = (): UseAPIResult | null => useContext(APIContext);

/** Last measured backend round-trip time while the connection is degraded, else null. */
export const useConnectionLatencyMs = (): number | null => useContext(ConnectionLatencyContext);

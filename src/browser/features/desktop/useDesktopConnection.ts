import { useEffect, useRef, useState, type RefObject } from "react";
import type RFB from "@novnc/novnc/lib/rfb";
import { useAPI } from "@/browser/contexts/API";
import { getBrowserBackendBaseUrl } from "@/browser/utils/backendBaseUrl";
import { DESKTOP_DEFAULTS, DESKTOP_VIEWER_DISCONNECT_TIMEOUT_MS } from "@/common/constants/desktop";
import type { DesktopCapability } from "@/common/types/desktop";
import { getErrorMessage } from "@/common/utils/errors";
import { trackDesktopInput } from "./desktopInput";

export type DesktopConnectionState =
  | "idle"
  | "checking"
  | "unavailable"
  | "connecting"
  | "connected"
  | "disconnected"
  | "error";

export interface UseDesktopConnectionResult {
  state: DesktopConnectionState;
  reason: string | null;
  rfbRef: RefObject<RFB>;
  containerRef: RefObject<HTMLDivElement>;
  connect: () => void;
  disconnect: () => void;
  /**
   * Disconnect and resolve once the transport closed. Giving the registration up is definitive
   * (no attachment grace) unless `keepGrace` is set: a popout closing on its own — titlebar,
   * pagehide, its own Bring back — may be handing the desktop to an inline pane whose lease is
   * still in flight, so only a close the parent requested after leasing is definitive.
   */
  disconnectAndWait: (options?: DesktopDisconnectOptions) => Promise<void>;
  /**
   * Close the RFB connection and stop reconnecting, but keep the viewer registration: used by
   * the inline pane while its desktop is shown in a popout, so the pane stays attached (the
   * backend keeps refusing agent-driven archives) across the handoff and the detached period.
   */
  suspend: () => void;
  /**
   * Register as a viewer without connecting: the popout coordinator calls this for a suspended
   * inline pane once a live detached child is confirmed (Electron manager truth, or a bring-back
   * in flight), so the inline registration covers the popout→inline handoff. A bare persisted
   * browser hint never registers: it is recovery UI, not proof that a popout is alive. Resolves
   * true once the backend reports the registration ready (immediately when one already is) and
   * false when no lease can be made (no API client, registration refused, pane not registering),
   * so the coordinator can refuse to close the child without a live lease; it never rejects.
   */
  register: () => Promise<boolean>;
  controlling: boolean;
  setControlling: (value: boolean) => void;
  scaleToFit: boolean;
  setScaleToFit: (value: boolean) => void;
  width: number;
  height: number;
  sharedDesktop: Extract<DesktopCapability, { available: true }>["sharedDesktop"] | null;
}

type DesktopUnavailableReason = Extract<DesktopCapability, { available: false }>["reason"];

const UNAVAILABLE_REASONS: Record<DesktopUnavailableReason, string> = {
  disabled: "Desktop sessions are disabled",
  unsupported_platform: "Desktop sessions are not supported on this platform",
  unsupported_runtime: "Desktop sessions are not supported in this runtime",
  startup_failed: "Desktop session failed to start",
  binary_not_found: "Desktop binary not found",
};

function assertDesktop(condition: unknown, message: string): asserts condition {
  if (!condition) {
    throw new Error(message);
  }
}

/**
 * Derive the base URL for the Desktop WebSocket bridge.
 *
 * In browser mode, getBrowserBackendBaseUrl() works correctly (respects
 * VITE_BACKEND_URL, app-proxy paths, and window.location.origin).
 *
 * In packaged Electron, window.location.origin may be "file://" or
 * "null", so we fall back to a localhost URL. The backend port in
 * Electron is available through window.api (the preload bridge).
 */
function getDesktopBridgeBaseUrl(): string {
  const backendUrl = getBrowserBackendBaseUrl();
  // getBrowserBackendBaseUrl checks VITE_BACKEND_URL first, which is
  // set in dev mode. In production browser mode it uses window.location.origin.
  // Both are valid — only packaged Electron (file:// origin) needs a fallback.
  if (!backendUrl || backendUrl === "null" || backendUrl.startsWith("file:")) {
    return "http://localhost";
  }

  try {
    const origin = new URL(backendUrl).origin;
    if (origin && origin !== "null") {
      return backendUrl;
    }
  } catch {
    // Packaged Electron can surface opaque or otherwise non-URL backend base strings.
    // Fall back to localhost so the desktop bridge still connects through the preload backend.
  }

  // Electron fallback: use localhost. In Electron, the backend URL is
  // provided via the preload bridge at window.api.
  return "http://localhost";
}

function buildDesktopBridgeUrl(
  bridgePath: string,
  token: string,
  localBridgeBaseUrl?: string
): string {
  assertDesktop(bridgePath.length > 0, "Desktop bootstrap response is missing a valid bridgePath.");
  assertDesktop(token.length > 0, "Desktop bootstrap response is missing a valid token.");

  const isDesktop = typeof window.api !== "undefined";
  const baseUrl =
    isDesktop && typeof localBridgeBaseUrl === "string" && localBridgeBaseUrl.length > 0
      ? localBridgeBaseUrl
      : getDesktopBridgeBaseUrl();
  // Concatenate base + bridgePath to preserve any app-proxy prefix
  // (e.g. /@user/ws/apps/mux + /desktop/ws → /@user/ws/apps/mux/desktop/ws)
  const fullUrl = baseUrl.endsWith("/")
    ? baseUrl + bridgePath.replace(/^\//, "")
    : baseUrl + bridgePath;
  const wsUrl = new URL(fullUrl);
  // Derive ws/wss from page protocol — in HTTPS deployments, a reverse proxy handles TLS
  // termination for the bridge.
  wsUrl.protocol = window.location.protocol === "https:" ? "wss:" : "ws:";
  wsUrl.searchParams.set("token", token);
  return wsUrl.toString();
}

export interface DesktopDisconnectOptions {
  keepGrace?: boolean;
}

export interface UseDesktopConnectionOptions {
  /**
   * Set by the Electron popout window: its lifetime is owned by DesktopWindowManager, whose
   * native cleanup handshake already releases held input before destruction, and a concurrent
   * cooperative-release registration would only race that handshake. Every other viewer
   * (browser inline/popout, Electron inline pane) registers with watchViewer so the backend
   * knows the pane is attached and can ask it to release input before closing the desktop.
   */
  nativeWindowCleanup?: boolean;
  /**
   * Consulted when the pane unmounts: true keeps the bounded attachment grace instead of giving
   * the registration up definitively. The inline pane uses it while its desktop is detaching to
   * a popout — the popup exists but connects only after the handoff's ready/grant exchange, so
   * an unmount in between (switching tabs) must not leave the desktop unattached meanwhile.
   */
  unmountKeepsGrace?: () => boolean;
}

export function useDesktopConnection(
  workspaceId: string,
  options?: UseDesktopConnectionOptions
): UseDesktopConnectionResult {
  const { api } = useAPI();
  // Background re-registration outlives the render that scheduled it and must talk to the
  // client the provider currently publishes, not the one captured when the timer was armed.
  const apiRef = useRef(api);
  apiRef.current = api;
  const registerViewer = !(
    options?.nativeWindowCleanup === true && typeof window.api !== "undefined"
  );
  const registerViewerRef = useRef(registerViewer);
  registerViewerRef.current = registerViewer;
  const [state, setState] = useState<DesktopConnectionState>("idle");
  const [reason, setReason] = useState<string | null>(null);
  const [width, setWidth] = useState<number>(DESKTOP_DEFAULTS.WIDTH);
  const [height, setHeight] = useState<number>(DESKTOP_DEFAULTS.HEIGHT);
  const [sharedDesktop, setSharedDesktop] =
    useState<UseDesktopConnectionResult["sharedDesktop"]>(null);

  const [controlling, setControllingState] = useState(false);
  const [scaleToFit, setScaleToFitState] = useState(true);
  const scaleToFitRef = useRef(true);
  const inputRef = useRef<ReturnType<typeof trackDesktopInput> | null>(null);
  const rfbRef = useRef<RFB | null>(null);
  const setControlling = (value: boolean) => {
    const rfb = rfbRef.current;
    // Human control needs a live release channel: without a ready viewer registration the
    // server cannot ask this pane to release held keys/buttons before closing the desktop, so
    // control stays off until re-registration succeeds.
    const allowed = value && rfb !== null && (!registerViewerRef.current || viewerReadyRef.current);
    if (!allowed) inputRef.current?.release();
    if (rfb) rfb.viewOnly = !allowed;
    setControllingState(allowed);
  };
  const setScaleToFit = (value: boolean) => {
    scaleToFitRef.current = value;
    if (rfbRef.current) rfbRef.current.scaleViewport = value;
    setScaleToFitState(value);
  };
  const containerRef = useRef<HTMLDivElement | null>(null);
  const hasEverConnectedRef = useRef(false);
  const reconnectTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const attemptRef = useRef(0);
  const generationRef = useRef(0);
  const isDisposedRef = useRef(false);
  const viewerRegistrationRef = useRef<AbortController | null>(null);
  // The registration is pane-scoped, not connection-scoped: it stays live through transient
  // RFB drops and the reconnect backoff so the backend keeps treating the mounted pane as an
  // attached viewer (its archive gate would otherwise see nobody attached between the socket
  // close and the reconnect). Ready is remembered so reconnects skip re-registering.
  const viewerReadyRef = useRef(false);
  const viewerIdRef = useRef<string | null>(null);
  const viewerReleasedRef = useRef(false);
  const reregisterTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const reregisterAttemptRef = useRef(0);
  // Set when the pane settles in a terminal unavailable/error state with no retry pending: a
  // background re-registration must not outlive that and re-attach a pane showing nothing.
  const terminalRef = useRef(false);
  // Ready registrations this pane lost to a subscription drop and replaced. Each left an
  // attachment grace on the backend that only a definitive outcome of this pane can retract.
  const supersededViewerIdsRef = useRef<string[]>([]);
  // A pane that registers no viewer (an Electron popout: its window is manager truth) still
  // names its bridge under a private id so giving it up (the window closing, which Electron
  // always routes through the manager's cleanup) retracts the bridge's grace all the same.
  const anonymousBridgeIdRef = useRef<string | null>(null);
  // Readiness of the current registration attempt, for register() callers that wait on it.
  const registrationReadyRef = useRef<Promise<boolean> | null>(null);
  const bootstrapViewerId = (): string | null => {
    if (registerViewer) return viewerIdRef.current;
    anonymousBridgeIdRef.current ??= crypto.randomUUID();
    return anonymousBridgeIdRef.current;
  };

  // Giving the registration up (terminal outcome, explicit disconnect, unmount) is definitive:
  // this pane will not reconnect, so tell the backend before the abort and the bridge close so
  // neither detachment leaves an attachment grace that keeps a pane showing nothing "attached".
  // The superseded registrations are reported too, for the graces they left.
  const detachViewerDefinitively = () => {
    const client = apiRef.current;
    const viewerId = viewerIdRef.current;
    const viewerIds = [...supersededViewerIdsRef.current];
    if (viewerId !== null && viewerRegistrationRef.current !== null) viewerIds.push(viewerId);
    if (anonymousBridgeIdRef.current !== null) viewerIds.push(anonymousBridgeIdRef.current);
    supersededViewerIdsRef.current = [];
    anonymousBridgeIdRef.current = null;
    if (!client) return;
    for (const id of viewerIds) {
      void client.desktop.detachViewer({ viewerId: id }).catch(() => undefined);
    }
  };

  const settleTerminal = () => {
    terminalRef.current = true;
  };

  const connectImplRef = useRef<() => void>(() => undefined);
  const disconnectImplRef = useRef<(options?: DesktopDisconnectOptions) => void>(() => undefined);
  const connectHandleRef = useRef<() => void>(() => connectImplRef.current());
  const disconnectHandleRef = useRef<(options?: DesktopDisconnectOptions) => void>((options) =>
    disconnectImplRef.current(options)
  );
  const scheduleReconnectRef = useRef<() => void>(() => undefined);

  const disconnectAndWait = (options?: DesktopDisconnectOptions): Promise<void> => {
    const rfb = rfbRef.current;
    if (!rfb) {
      disconnectHandleRef.current(options);
      return Promise.resolve();
    }
    return new Promise((resolve) => {
      const onDisconnect = () => {
        clearTimeout(timeout);
        rfb.removeEventListener("disconnect", onDisconnect);
        resolve();
      };
      const timeout = setTimeout(onDisconnect, DESKTOP_VIEWER_DISCONNECT_TIMEOUT_MS);
      rfb.addEventListener("disconnect", onDisconnect);
      // Release synchronously, but let the WebSocket drain before the popout disappears.
      disconnectHandleRef.current(options);
    });
  };

  const clearReconnectTimer = () => {
    if (reconnectTimerRef.current) {
      clearTimeout(reconnectTimerRef.current);
      reconnectTimerRef.current = null;
    }
  };

  const clearReregisterTimer = () => {
    if (reregisterTimerRef.current) {
      clearTimeout(reregisterTimerRef.current);
      reregisterTimerRef.current = null;
    }
  };

  const disconnectCurrentRfb = (options?: {
    keepViewerRegistration?: boolean;
    keepGrace?: boolean;
  }) => {
    setSharedDesktop(null);
    const currentRfb = rfbRef.current;
    const keepRegistration = options?.keepViewerRegistration === true;
    const registration = keepRegistration ? null : viewerRegistrationRef.current;
    if (!keepRegistration) {
      clearReregisterTimer();
      if (options?.keepGrace === true) {
        // The bounded grace the abort/bridge close leave behind is wanted here; forget the ids
        // so nothing retracts it later.
        supersededViewerIdsRef.current = [];
        anonymousBridgeIdRef.current = null;
      } else {
        detachViewerDefinitively();
      }
      viewerRegistrationRef.current = null;
      viewerReadyRef.current = false;
      viewerIdRef.current = null;
    }
    setControlling(false);
    inputRef.current?.dispose();
    inputRef.current = null;
    rfbRef.current = null;
    try {
      currentRfb?.disconnect();
    } catch {
      // noVNC disconnect can race with its own close handling; treat teardown as idempotent.
    } finally {
      // A normal disconnect/unmount unregisters only after releasing held guest input.
      registration?.abort();
    }
  };

  scheduleReconnectRef.current = () => {
    if (isDisposedRef.current) {
      return;
    }

    clearReconnectTimer();
    const delay = Math.min(
      DESKTOP_DEFAULTS.RECONNECT_BASE_DELAY_MS * 2 ** attemptRef.current,
      DESKTOP_DEFAULTS.RECONNECT_MAX_DELAY_MS
    );
    attemptRef.current += 1;
    reconnectTimerRef.current = setTimeout(() => {
      reconnectTimerRef.current = null;
      if (isDisposedRef.current) {
        return;
      }
      connectHandleRef.current();
    }, delay);
  };

  disconnectImplRef.current = (options) => {
    isDisposedRef.current = true;
    generationRef.current += 1;
    clearReconnectTimer();
    disconnectCurrentRfb({ keepGrace: options?.keepGrace });
    setState("idle");
    setReason(null);
  };

  const suspend = () => {
    // Bumping the generation retires in-flight attempts and reconnect timers without disposing
    // the hook, so the registration loop keeps delivering a release while suspended.
    generationRef.current += 1;
    clearReconnectTimer();
    disconnectCurrentRfb({ keepViewerRegistration: viewerReadyRef.current });
    setState("idle");
    setReason(null);
  };

  const register = (): Promise<boolean> => {
    if (!registerViewer || viewerReleasedRef.current || terminalRef.current) {
      return Promise.resolve(false);
    }
    if (viewerRegistrationRef.current !== null) {
      return registrationReadyRef.current ?? Promise.resolve(viewerReadyRef.current);
    }
    const client = apiRef.current;
    if (!client) {
      // The API provider may still be connecting; retry until a client is published.
      scheduleViewerReregistration();
      return Promise.resolve(false);
    }
    return registerViewerRegistration(client).then(
      () => true,
      () => {
        if (
          !isDisposedRef.current &&
          !terminalRef.current &&
          viewerRegistrationRef.current === null
        ) {
          scheduleViewerReregistration();
        }
        return false;
      }
    );
  };

  /**
   * Register this pane as a desktop viewer and resolve once the backend reports ready. The
   * subscription keeps running afterwards to receive the cooperative release; it is scoped to
   * the pane (viewerRegistrationRef), not to one RFB connection, so transient transport drops,
   * failed reconnect attempts, and the reconnect backoff all leave it live and the backend keeps
   * treating the mounted pane as attached (its archive gate would otherwise see nobody).
   */
  const registerViewerRegistration = (client: NonNullable<typeof api>): Promise<void> => {
    const registration = new AbortController();
    // Named up front: the backend registers this pane before its ready event arrives, so a pane
    // that unmounts or is disconnected in between must still be able to give the registration up
    // definitively instead of leaving a dropped-viewer grace behind.
    const viewerId = crypto.randomUUID();
    viewerRegistrationRef.current = registration;
    viewerReadyRef.current = false;
    viewerIdRef.current = viewerId;
    const isCurrent = () => viewerRegistrationRef.current === registration;
    const retire = () => {
      if (isCurrent()) {
        viewerRegistrationRef.current = null;
        viewerReadyRef.current = false;
        viewerIdRef.current = null;
      }
      registration.abort();
    };
    const ready = new Promise<void>((resolve, reject) => {
      void (async () => {
        let isReady = false;
        try {
          const events = await client.desktop.watchViewer(
            { workspaceId, viewerId },
            { signal: registration.signal }
          );
          if (registration.signal.aborted || isDisposedRef.current) {
            await events.return?.();
            throw new Error("Desktop viewer registration was cancelled.");
          }
          for await (const event of events) {
            if (registration.signal.aborted || isDisposedRef.current) break;
            if (event.type === "ready") {
              assertDesktop(!isReady, "Desktop viewer registered more than once.");
              assertDesktop(
                event.viewerId === viewerId,
                "Desktop viewer ready has no matching registration."
              );
              isReady = true;
              if (isCurrent()) viewerReadyRef.current = true;
              reregisterAttemptRef.current = 0;
              resolve();
              continue;
            }
            assertDesktop(
              viewerId === event.viewerId,
              "Desktop release has no matching registration."
            );
            viewerReleasedRef.current = true;
            // disconnectAndWait normally unregisters. Keep this subscription alive until ACK
            // so the server can still associate that acknowledgment with this viewer.
            viewerRegistrationRef.current = null;
            viewerReadyRef.current = false;
            viewerIdRef.current = null;
            const disconnected = disconnectAndWait();
            const stoppedGeneration = generationRef.current;
            try {
              await disconnected;
              await client.desktop.acknowledgeViewerRelease({ viewerId });
            } finally {
              registration.abort();
              if (generationRef.current === stoppedGeneration) {
                setState("unavailable");
                setReason("The desktop session was closed.");
              }
            }
            return;
          }
          if (!registration.signal.aborted) throw new Error("Desktop release subscription ended.");
        } catch (error) {
          if (!isReady) {
            // Never ready: the connection attempt awaiting us fails and owns the recovery. The
            // backend may have registered the pane anyway, so remember the id for the terminal
            // settlement or the next definitive detach to retract its grace.
            if (isCurrent()) supersededViewerIdsRef.current.push(viewerId);
            retire();
            reject(error instanceof Error ? error : new Error(getErrorMessage(error)));
            return;
          }
          if (!isCurrent() || isDisposedRef.current) {
            retire();
            return;
          }
          // Lost the release channel after ready. The server can no longer ask this pane to
          // release input, so drop control now, but keep the healthy VNC bridge (it still
          // marks the pane as attached) and re-register in the background.
          supersededViewerIdsRef.current.push(viewerId);
          retire();
          setControlling(false);
          scheduleViewerReregistration();
          return;
        }
        retire();
      })();
    });
    // register() hands the pending readiness to the popout coordinator; rejection is reported to
    // the caller of this function, so the shared copy only ever resolves.
    registrationReadyRef.current = ready.then(
      () => true,
      () => false
    );
    return ready;
  };

  const scheduleViewerReregistration = () => {
    clearReregisterTimer();
    // The first replacement is attempted immediately: while the pane has no bridge yet (ready
    // resolves before bootstrap opens the socket) the registration is its only attachment
    // signal, so the gap must be one round-trip, not a backoff. Only repeated failures back off.
    const attempt = reregisterAttemptRef.current;
    const delay =
      attempt === 0
        ? 0
        : Math.min(
            DESKTOP_DEFAULTS.RECONNECT_BASE_DELAY_MS * 2 ** (attempt - 1),
            DESKTOP_DEFAULTS.RECONNECT_MAX_DELAY_MS
          );
    reregisterAttemptRef.current += 1;
    reregisterTimerRef.current = setTimeout(() => {
      reregisterTimerRef.current = null;
      // A connection attempt started meanwhile registers on its own; do not race it. A pane
      // that settled in a terminal state must not re-attach either.
      if (
        isDisposedRef.current ||
        viewerReleasedRef.current ||
        terminalRef.current ||
        viewerRegistrationRef.current !== null
      ) {
        return;
      }
      const client = apiRef.current;
      if (!client) {
        // The API provider publishes null while it reconnects; keep retrying until it returns.
        scheduleViewerReregistration();
        return;
      }
      registerViewerRegistration(client).catch(() => {
        if (
          !isDisposedRef.current &&
          !terminalRef.current &&
          viewerRegistrationRef.current === null
        ) {
          scheduleViewerReregistration();
        }
      });
    }, delay);
  };

  connectImplRef.current = () => {
    if (viewerReleasedRef.current) return;
    void (async () => {
      const generation = generationRef.current + 1;
      generationRef.current = generation;
      isDisposedRef.current = false;
      terminalRef.current = false;
      clearReconnectTimer();
      // Only a registration that already reported ready is reusable; a still-pending one is
      // superseded by this attempt's own registration.
      const reuseViewerRegistration =
        viewerRegistrationRef.current !== null &&
        !viewerRegistrationRef.current.signal.aborted &&
        viewerReadyRef.current;
      disconnectCurrentRfb({ keepViewerRegistration: reuseViewerRegistration });
      setReason(null);

      if (!api) {
        // User rationale: the Desktop tab can mount while the API client is still reconnecting,
        // so treat a missing API client as transient and retry instead of wedging the hook in error.
        setState("connecting");
        reconnectTimerRef.current = setTimeout(() => {
          reconnectTimerRef.current = null;
          if (isDisposedRef.current || generationRef.current !== generation) {
            return;
          }
          connectHandleRef.current();
        }, DESKTOP_DEFAULTS.RECONNECT_BASE_DELAY_MS);
        return;
      }

      setState("checking");

      try {
        // Register before bootstrap: getBootstrap clears the backend's startup reservation, so
        // a registration made after it would leave a window in which nothing marks this pane
        // as attached and an agent-driven archive could close the desktop the pane is about to
        // show. A ready registration from before a transient drop is reused as is.
        if (registerViewer && !reuseViewerRegistration) {
          await registerViewerRegistration(api);
          if (generationRef.current !== generation || isDisposedRef.current) {
            return;
          }
        }

        // Shared-target metadata is display-only: the caller's bootstrap/token preserves the
        // backend's authorization and binding checks; never bootstrap the owner directly.
        // The registration is named so the bridge this bootstrap opens is attributed to it.
        const result = await api.desktop.getBootstrap({
          workspaceId,
          viewerId: bootstrapViewerId(),
        });
        if (generationRef.current !== generation || isDisposedRef.current) {
          return;
        }

        if (!result.capability.available) {
          if (hasEverConnectedRef.current) {
            // A prior successful session means bootstrap unavailability is part of the reconnect
            // loop, so keep retrying instead of wedging the panel in a permanent unavailable state.
            setState("disconnected");
            setReason(null);
            scheduleReconnectRef.current();
            return;
          }
          // Terminal: nothing to view, so give the registration up (disconnectCurrentRfb detaches
          // it definitively) and keep any in-flight re-registration from attaching it again.
          settleTerminal();
          disconnectCurrentRfb();
          setState("unavailable");
          setReason(UNAVAILABLE_REASONS[result.capability.reason]);
          return;
        }

        const bridgePath = result.bridgePath;
        assertDesktop(
          typeof bridgePath === "string" && bridgePath.length > 0,
          "Desktop bootstrap response is missing a valid bridgePath."
        );
        const token = result.token;
        assertDesktop(
          typeof token === "string" && token.length > 0,
          "Desktop bootstrap response is missing a valid token."
        );
        const wsUrl = buildDesktopBridgeUrl(bridgePath, token, result.localBridgeBaseUrl);
        setWidth(result.capability.width);
        setHeight(result.capability.height);

        const container = containerRef.current;
        assertDesktop(container, "Desktop panel container is not mounted.");

        // noVNC's CommonJS entry reaches a transitive dependency with top-level await,
        // so Vite dev mode must load it lazily instead of pre-bundling a static import.
        const { default: RFB } = await import("@novnc/novnc/lib/rfb");
        // Guard against stale connection after async import
        if (isDisposedRef.current || generation !== generationRef.current) {
          return;
        }
        const sharedTarget = result.capability.sharedDesktop ?? null;
        const connectRfb = () => {
          const rfb = new RFB(container, wsUrl);
          rfb.background = "var(--color-background)";
          rfb.viewOnly = true;
          rfb.scaleViewport = scaleToFitRef.current;
          rfb.resizeSession = false;

          const handleConnect = () => {
            if (generationRef.current !== generation || isDisposedRef.current) {
              return;
            }
            const canvas = container.querySelector("canvas");
            assertDesktop(canvas, "Connected desktop is missing its canvas.");
            inputRef.current = trackDesktopInput(canvas, () => !rfb.viewOnly);
            hasEverConnectedRef.current = true;
            attemptRef.current = 0;
            setState("connected");
            setReason(null);
          };

          const handleDisconnect = (event: CustomEvent<{ clean: boolean }>) => {
            if (generationRef.current !== generation || isDisposedRef.current) {
              return;
            }
            // A transport drop is not the pane going away: keep the viewer registered while
            // the reconnect backoff runs; the reconnect reuses it once ready. A drop before the
            // first connect is terminal (no retry follows), so the registration is given up.
            if (!hasEverConnectedRef.current) settleTerminal();
            disconnectCurrentRfb({ keepViewerRegistration: hasEverConnectedRef.current });
            if (hasEverConnectedRef.current) {
              setState("disconnected");
              setReason(null);
              scheduleReconnectRef.current();
              return;
            }
            const cleanSuffix = event.detail.clean ? " cleanly" : " unexpectedly";
            setState("error");
            setReason(`Desktop session disconnected${cleanSuffix} before it finished connecting.`);
          };

          const handleSecurityFailure = (
            event: CustomEvent<{ status: number; reason: string }>
          ) => {
            if (generationRef.current !== generation || isDisposedRef.current) {
              return;
            }
            settleTerminal();
            disconnectCurrentRfb();
            setState("error");
            const securityReason = event.detail.reason.trim();
            setReason(
              securityReason.length > 0
                ? `Desktop connection failed security checks: ${securityReason}`
                : "Desktop connection failed security checks."
            );
          };

          rfb.addEventListener("connect", handleConnect);
          rfb.addEventListener("disconnect", handleDisconnect);
          rfb.addEventListener("securityfailure", handleSecurityFailure);
          rfbRef.current = rfb;
          setSharedDesktop(sharedTarget);
          setState("connecting");
        };
        connectRfb();
      } catch (error) {
        if (generationRef.current !== generation || isDisposedRef.current) {
          return;
        }
        // A first attempt that fails is terminal (flagged before the abort below so no
        // background re-registration can re-attach the pane); a failed attempt inside the
        // reconnect loop keeps a ready registration instead: the pane is still mounted and
        // about to retry, so it must stay attached through the backoff.
        if (!hasEverConnectedRef.current) settleTerminal();
        disconnectCurrentRfb({
          keepViewerRegistration: hasEverConnectedRef.current && viewerReadyRef.current,
        });
        if (hasEverConnectedRef.current) {
          // A prior successful session means this is part of the reconnect loop, so keep the
          // exponential backoff running instead of wedging the panel in a permanent error state.
          setState("disconnected");
          setReason(null);
          scheduleReconnectRef.current();
          return;
        }
        setState("error");
        setReason(getErrorMessage(error));
      }
    })();
  };

  const unmountKeepsGraceRef = useRef(options?.unmountKeepsGrace);
  unmountKeepsGraceRef.current = options?.unmountKeepsGrace;

  useEffect(() => {
    const disconnect = () =>
      disconnectHandleRef.current({ keepGrace: unmountKeepsGraceRef.current?.() === true });
    const release = () => setControlling(false);
    const onWindowBlur = (event: FocusEvent) => {
      // Capture runs before noVNC's window blur handler, but also sees toolbar/canvas
      // focus changes. Moving focus into the guest must not revoke human control.
      if (event.target === window) release();
    };
    window.addEventListener("blur", onWindowBlur, true);
    const onVisibilityChange = () => {
      if (document.hidden) release();
    };
    document.addEventListener("visibilitychange", onVisibilityChange);
    return () => {
      window.removeEventListener("blur", onWindowBlur, true);
      document.removeEventListener("visibilitychange", onVisibilityChange);
      disconnect();
    };
  }, []);

  return {
    state,
    reason,
    rfbRef,
    containerRef,
    connect: connectHandleRef.current,
    disconnect: disconnectHandleRef.current,
    disconnectAndWait,
    suspend,
    register,
    controlling,
    setControlling,
    scaleToFit,
    setScaleToFit,
    width,
    height,
    sharedDesktop,
  };
}

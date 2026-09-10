import * as net from "node:net";
import type { IncomingMessage } from "node:http";
import type { Duplex } from "node:stream";
import { WebSocketServer, WebSocket, type RawData } from "ws";
import { DESKTOP_VIEWER_DISCONNECT_TIMEOUT_MS } from "@/common/constants/desktop";
import { assert } from "@/common/utils/assert";
import { log } from "@/node/services/log";
import type { DesktopSessionManager } from "./DesktopSessionManager";
import type { DesktopTokenManager } from "./DesktopTokenManager";

const INVALID_TOKEN_CLOSE_CODE = 4001;
const MISSING_SESSION_CLOSE_CODE = 4002;
const VNC_CONNECT_FAILURE_CLOSE_CODE = 4003;
const SERVER_STOPPING_CLOSE_CODE = 1001;
const VNC_HOST = "127.0.0.1";

interface BridgePair {
  ws: WebSocket;
  tcp: net.Socket | null;
  requesterWorkspaceId: string;
  ownerWorkspaceId: string;
  /** The requesting pane's viewer registration, when it bootstrapped with one. */
  viewerId: string | null;
  sessionId: string;
  vncPort: number;
  connectAbort: AbortController;
  unsubscribeClose?: () => void;
  closed: boolean;
}

export interface DesktopBridgeServerOptions {
  desktopSessionManager: Pick<
    DesktopSessionManager,
    "getLiveSessionConnection" | "onWorkspaceClose" | "watchWorkspaceConfig"
  > &
    Partial<Pick<DesktopSessionManager, "noteDetached">>;
  desktopTokenManager: Pick<DesktopTokenManager, "validate">;
}

function normalizeBinaryMessage(data: RawData): Buffer {
  if (Buffer.isBuffer(data)) {
    return data;
  }

  if (Array.isArray(data)) {
    return Buffer.concat(data);
  }

  return Buffer.from(data);
}

function closeWebSocket(ws: WebSocket, code: number, reason: string): void {
  try {
    if (ws.readyState === WebSocket.OPEN || ws.readyState === WebSocket.CONNECTING) {
      ws.close(code, reason);
      return;
    }

    if (ws.readyState !== WebSocket.CLOSED) {
      ws.terminate();
    }
  } catch (error) {
    log.debug("DesktopBridgeServer: WebSocket close failed", { code, reason, error });
  }
}

function rejectUpgrade(socket: Duplex): void {
  try {
    socket.write("HTTP/1.1 503 Service Unavailable\r\nConnection: close\r\n\r\n");
  } catch (error) {
    log.debug("DesktopBridgeServer: failed to write upgrade rejection response", { error });
  }

  try {
    socket.destroy();
  } catch (error) {
    log.debug("DesktopBridgeServer: failed to destroy rejected upgrade socket", { error });
  }
}

async function waitForWebSocketClose(ws: WebSocket, timeoutMs = 250): Promise<void> {
  if (ws.readyState === WebSocket.CLOSED) {
    return;
  }

  await new Promise<void>((resolve) => {
    const timeout = setTimeout(() => {
      cleanup();
      resolve();
    }, timeoutMs);
    timeout.unref?.();

    const onClose = () => {
      cleanup();
      resolve();
    };

    const cleanup = () => {
      clearTimeout(timeout);
      ws.off("close", onClose);
    };

    ws.once("close", onClose);
  });
}

export class DesktopBridgeServer {
  private readonly desktopSessionManager: Pick<
    DesktopSessionManager,
    "getLiveSessionConnection" | "onWorkspaceClose" | "watchWorkspaceConfig"
  > &
    Partial<Pick<DesktopSessionManager, "noteDetached">>;
  private readonly desktopTokenManager: Pick<DesktopTokenManager, "validate">;
  private readonly wss: WebSocketServer;
  private readonly activePairs = new Set<BridgePair>();
  private readonly drainingSockets = new Map<net.Socket, Promise<void>>();
  private stopConfigWatch: (() => void) | undefined;
  // Keep upgrade rejection aligned with stop() so httpServer.close() cannot hang on sockets
  // that reconnect after shutdown snapshots the current bridge clients.
  private isStopping = false;
  private stopPromise: Promise<void> | null = null;

  constructor(options: DesktopBridgeServerOptions) {
    assert(options.desktopSessionManager, "DesktopBridgeServer requires a DesktopSessionManager");
    assert(options.desktopTokenManager, "DesktopBridgeServer requires a DesktopTokenManager");

    this.desktopSessionManager = options.desktopSessionManager;
    this.desktopTokenManager = options.desktopTokenManager;
    this.wss = new WebSocketServer({ noServer: true });
  }

  public ensureReady(): void {
    assert(this.wss, "DesktopBridgeServer WebSocketServer must be initialized");
  }

  /**
   * Whether a VNC bridge WebSocket is attached for this workspace, as requester or as owner of
   * a shared desktop. Every viewer surface (inline browser pane, inline Electron pane, popout
   * windows) reaches the desktop through this bridge, so it is the ground truth that someone is
   * watching; the browser viewer registry alone misses the inline Electron pane, which skips
   * watchViewer. Pairs are registered synchronously with their admission lookup (which honors
   * the archive guard), so an archive gate observing no pair cannot be beaten by a connection
   * admitted earlier.
   */
  hasActiveBridge(
    workspaceId: string,
    // The owner captured at admission goes stale when a borrower is rebound before the config
    // watcher revalidates the pair; the manager re-resolves it so the new owner counts as
    // attached (and the old one no longer does) from the moment the binding changes.
    resolveOwner: (requesterWorkspaceId: string, capturedOwnerWorkspaceId: string) => string = (
      _requester,
      capturedOwner
    ) => capturedOwner
  ): boolean {
    assert(workspaceId.length > 0, "hasActiveBridge requires a workspaceId");
    for (const pair of this.activePairs) {
      if (
        pair.requesterWorkspaceId === workspaceId ||
        resolveOwner(pair.requesterWorkspaceId, pair.ownerWorkspaceId) === workspaceId
      ) {
        return true;
      }
    }
    return false;
  }

  public handleUpgrade(request: IncomingMessage, socket: Duplex, head: Buffer): void {
    this.ensureReady();
    if (this.isStopping) {
      log.debug("DesktopBridgeServer: rejecting upgrade while stopping", { url: request.url });
      rejectUpgrade(socket);
      return;
    }

    this.wss.handleUpgrade(request, socket, head, (ws) => {
      void this.handleUpgradedConnection(ws, request);
    });
  }

  async stop(): Promise<void> {
    if (this.stopPromise) {
      await this.stopPromise;
      return;
    }

    this.isStopping = true;
    const stopPromise = (async () => {
      const activePairs = Array.from(this.activePairs);
      const trackedWebSockets = new Set(activePairs.map((pair) => pair.ws));
      const activePairClosePromises = activePairs.map((pair) => waitForWebSocketClose(pair.ws));

      for (const pair of activePairs) {
        this.cleanupPair(pair, {
          closeCode: SERVER_STOPPING_CLOSE_CODE,
          closeReason: "server stopping",
        });
      }
      await Promise.allSettled(activePairClosePromises);

      const orphanClientClosePromises: Array<Promise<void>> = [];
      for (const ws of this.wss.clients) {
        if (trackedWebSockets.has(ws)) {
          continue;
        }

        orphanClientClosePromises.push(waitForWebSocketClose(ws));
        closeWebSocket(ws, SERVER_STOPPING_CLOSE_CODE, "server stopping");
      }
      await Promise.allSettled(orphanClientClosePromises);

      for (const ws of this.wss.clients) {
        if (ws.readyState !== WebSocket.CLOSED) {
          ws.terminate();
        }
      }

      await Promise.allSettled(this.drainingSockets.values());

      this.activePairs.clear();

      if (activePairs.length > 0 || orphanClientClosePromises.length > 0) {
        log.debug("DesktopBridgeServer: stopped", {
          activePairs: activePairs.length,
          orphanClients: orphanClientClosePromises.length,
        });
      }
    })();
    this.stopPromise = stopPromise;

    try {
      await stopPromise;
    } finally {
      this.stopPromise = null;
      this.isStopping = false;
    }
  }

  private async handleUpgradedConnection(ws: WebSocket, request: IncomingMessage): Promise<void> {
    const requestUrl = new URL(request.url ?? "/", `http://${VNC_HOST}`);
    const token = requestUrl.searchParams.get("token");
    if (!token) {
      log.warn("DesktopBridgeServer: rejecting upgrade with missing token", { url: request.url });
      closeWebSocket(ws, INVALID_TOKEN_CLOSE_CODE, "invalid token");
      return;
    }

    const payload = this.desktopTokenManager.validate(token);
    if (!payload) {
      log.warn("DesktopBridgeServer: rejecting upgrade with invalid token", {
        tokenPrefix: token.slice(0, 8),
      });
      closeWebSocket(ws, INVALID_TOKEN_CLOSE_CODE, "invalid token");
      return;
    }

    const liveSession = this.desktopSessionManager.getLiveSessionConnection(payload.workspaceId);
    if (!liveSession || liveSession.sessionId !== payload.sessionId) {
      log.warn("DesktopBridgeServer: rejecting upgrade with missing or mismatched session", {
        workspaceId: payload.workspaceId,
        expectedSessionId: payload.sessionId,
        actualSessionId: liveSession?.sessionId,
      });
      closeWebSocket(ws, MISSING_SESSION_CLOSE_CODE, "session unavailable");
      return;
    }

    // Subscribe before connecting: cleanup must revoke both established viewers and connections
    // still awaiting TCP, even when a borrower has no owned desktop session to close.
    const pair: BridgePair = {
      ws,
      tcp: null,
      requesterWorkspaceId: payload.workspaceId,
      ownerWorkspaceId: liveSession.ownerWorkspaceId,
      viewerId: payload.viewerId,
      sessionId: liveSession.sessionId,
      vncPort: liveSession.vncPort,
      connectAbort: new AbortController(),
      closed: false,
    };
    pair.unsubscribeClose = this.desktopSessionManager.onWorkspaceClose((workspaceId) => {
      if (
        workspaceId === null ||
        workspaceId === pair.requesterWorkspaceId ||
        workspaceId === pair.ownerWorkspaceId
      ) {
        this.cleanupPair(pair, {
          closeCode: MISSING_SESSION_CLOSE_CODE,
          closeReason: "session unavailable",
          // Renderer acknowledgment can beat the server's final WS close callback. If its
          // handshake already started, preserve accepted release frames on this path too.
          flushTcp:
            pair.ws.readyState === WebSocket.CLOSING || pair.ws.readyState === WebSocket.CLOSED,
        });
      }
    });
    this.activePairs.add(pair);
    ws.once("close", () =>
      this.cleanupPair(pair, { closeReason: "websocket closed", flushTcp: true })
    );
    ws.on("error", (error) => {
      log.error("DesktopBridgeServer: WebSocket bridge failed", {
        workspaceId: payload.workspaceId,
        error,
      });
      this.cleanupPair(pair, { closeReason: "websocket error" });
    });

    try {
      if (!this.stopConfigWatch) {
        try {
          this.stopConfigWatch = this.desktopSessionManager.watchWorkspaceConfig(
            () => this.revalidateConnections(),
            (error) => this.revokeForConfigWatchFailure(error)
          );
          // Catch a persisted change between the initial lookup and watcher installation,
          // even if the TCP connection would never finish to perform its later recheck.
          this.revalidateConnections();
          if (pair.closed) return;
        } catch (error) {
          this.revokeForConfigWatchFailure(error);
          return;
        }
      }
      const tcp = await this.connectToVnc(liveSession.vncPort, pair.connectAbort.signal);
      if (pair.closed) {
        tcp.destroy();
        return;
      }
      pair.tcp = tcp;
      // Tokens name the requester, not the owner: revalidate the current relationship after
      // connecting too, so an archive/removal during TCP setup cannot attach a stale borrower.
      const currentSession = this.desktopSessionManager.getLiveSessionConnection(
        payload.workspaceId
      );
      if (
        currentSession?.sessionId !== payload.sessionId ||
        currentSession.ownerWorkspaceId !== pair.ownerWorkspaceId ||
        currentSession.vncPort !== liveSession.vncPort
      ) {
        this.cleanupPair(pair, {
          closeCode: MISSING_SESSION_CLOSE_CODE,
          closeReason: "session unavailable",
        });
        return;
      }
      this.attachBridgeListeners(pair, payload.workspaceId, liveSession.sessionId);
      log.debug("DesktopBridgeServer: bridged desktop session", {
        workspaceId: payload.workspaceId,
        sessionId: liveSession.sessionId,
        vncPort: liveSession.vncPort,
      });

      if (ws.readyState !== WebSocket.OPEN) {
        this.cleanupPair(pair, { closeReason: "websocket closed before bridge finished" });
      }
    } catch (error) {
      if (pair.closed) return;
      log.warn("DesktopBridgeServer: failed to connect to VNC endpoint", {
        workspaceId: payload.workspaceId,
        sessionId: payload.sessionId,
        vncPort: liveSession.vncPort,
        error,
      });
      this.cleanupPair(pair, {
        closeCode: VNC_CONNECT_FAILURE_CLOSE_CODE,
        closeReason: "vnc connect failed",
      });
    }
  }

  private revalidateConnections(): void {
    try {
      const connections = new Map<
        string,
        ReturnType<DesktopSessionManager["getLiveSessionConnection"]>
      >();
      for (const pair of this.activePairs) {
        const mode = pair.tcp ? "established" : "admission";
        const key = `${mode}:${pair.requesterWorkspaceId}`;
        if (!connections.has(key)) {
          connections.set(
            key,
            this.desktopSessionManager.getLiveSessionConnection(pair.requesterWorkspaceId, mode)
          );
        }
        const current = connections.get(key);
        if (
          current?.ownerWorkspaceId !== pair.ownerWorkspaceId ||
          current.sessionId !== pair.sessionId ||
          current.vncPort !== pair.vncPort
        ) {
          this.cleanupPair(pair, {
            closeCode: MISSING_SESSION_CLOSE_CODE,
            closeReason: "session unavailable",
          });
        }
      }
    } catch (error) {
      this.revokeForConfigWatchFailure(error);
    }
  }

  private revokeForConfigWatchFailure(error: unknown): void {
    log.warn("DesktopBridgeServer: config watching failed; revoking viewers", { error });
    for (const pair of this.activePairs) {
      this.cleanupPair(pair, {
        closeCode: MISSING_SESSION_CLOSE_CODE,
        closeReason: "session unavailable",
      });
    }
  }

  private async connectToVnc(port: number, signal: AbortSignal): Promise<net.Socket> {
    assert(Number.isInteger(port), "DesktopBridgeServer VNC port must be an integer");
    assert(port > 0, "DesktopBridgeServer VNC port must be positive");

    return await new Promise<net.Socket>((resolve, reject) => {
      const tcp = net.createConnection({ host: VNC_HOST, port });
      let settled = false;

      const cleanup = () => {
        tcp.off("connect", onConnect);
        tcp.off("error", onError);
        tcp.off("close", onCloseBeforeConnect);
        signal.removeEventListener("abort", onAbort);
      };
      const onAbort = () => {
        if (settled) return;
        settled = true;
        cleanup();
        tcp.destroy();
        reject(new Error("VNC connection cancelled"));
      };

      const onConnect = () => {
        if (settled) {
          return;
        }
        settled = true;
        cleanup();
        resolve(tcp);
      };

      const onError = (error: Error) => {
        if (settled) {
          return;
        }
        settled = true;
        cleanup();
        tcp.destroy();
        reject(error);
      };

      const onCloseBeforeConnect = () => {
        if (settled) {
          return;
        }
        settled = true;
        cleanup();
        reject(new Error("VNC socket closed before connecting"));
      };

      tcp.once("connect", onConnect);
      tcp.once("error", onError);
      tcp.once("close", onCloseBeforeConnect);
      signal.addEventListener("abort", onAbort, { once: true });
      if (signal.aborted) onAbort();
    });
  }

  private attachBridgeListeners(pair: BridgePair, workspaceId: string, sessionId: string): void {
    const tcp = pair.tcp;
    assert(tcp, "Desktop bridge listeners require a connected TCP socket");
    pair.ws.on("message", (data, isBinary) => {
      if (pair.closed) {
        return;
      }

      if (!isBinary) {
        log.debug("DesktopBridgeServer: ignoring non-binary WebSocket frame", {
          workspaceId,
          sessionId,
        });
        return;
      }

      try {
        tcp.write(normalizeBinaryMessage(data));
      } catch (error) {
        log.error("DesktopBridgeServer: failed to forward client frame to VNC", {
          workspaceId,
          sessionId,
          error,
        });
        this.cleanupPair(pair, { closeReason: "tcp write failed" });
      }
    });

    tcp.on("data", (chunk) => {
      if (pair.closed) {
        return;
      }

      // A client close may race the last screen update. Let its close event drain pending
      // client→VNC key/button releases instead of destroying the socket from this read path.
      if (pair.ws.readyState !== WebSocket.OPEN) return;

      try {
        pair.ws.send(chunk, { binary: true });
      } catch (error) {
        log.error("DesktopBridgeServer: failed to forward VNC frame to WebSocket", {
          workspaceId,
          sessionId,
          error,
        });
        this.cleanupPair(pair, { closeReason: "websocket send failed" });
      }
    });

    tcp.on("end", () => {
      this.cleanupPair(pair, { closeReason: "tcp ended" });
    });

    tcp.on("close", () => {
      this.cleanupPair(pair, { closeReason: "tcp closed" });
    });

    tcp.on("error", (error) => {
      log.error("DesktopBridgeServer: TCP bridge failed", { workspaceId, sessionId, error });
      this.cleanupPair(pair, { closeReason: "tcp error" });
    });
  }

  private drainTcp(tcp: net.Socket): void {
    const drained = new Promise<void>((resolve) => {
      const timeout = setTimeout(() => tcp.destroy(), DESKTOP_VIEWER_DISCONNECT_TIMEOUT_MS);
      timeout.unref?.();
      tcp.once("close", () => {
        clearTimeout(timeout);
        this.drainingSockets.delete(tcp);
        resolve();
      });
    });
    this.drainingSockets.set(tcp, drained);
    // end() preserves buffered release frames; destroy() would discard unwritten bytes.
    tcp.end();
  }

  private cleanupPair(
    pair: BridgePair,
    options: { closeCode?: number; closeReason?: string; flushTcp?: boolean } = {}
  ): void {
    if (pair.closed) {
      return;
    }

    pair.closed = true;
    this.activePairs.delete(pair);
    // An established bridge was a known attachment: let the manager's archive gate keep the
    // requester and owner attached for the bounded grace while the client reconnects or hands
    // off. A pair that never reached VNC (admission/TCP/revalidation failure) never showed a
    // desktop, so its loss is not evidence of a viewer. Attributed to the pane's viewer
    // registration so a pane that gives that registration up definitively retracts this too.
    if (pair.tcp !== null) {
      this.desktopSessionManager.noteDetached?.(
        pair.requesterWorkspaceId,
        pair.ownerWorkspaceId,
        pair.viewerId ?? undefined
      );
    }
    if (this.activePairs.size === 0) {
      const stopConfigWatch = this.stopConfigWatch;
      this.stopConfigWatch = undefined;
      stopConfigWatch?.();
    }
    pair.unsubscribeClose?.();
    pair.connectAbort.abort();

    if (pair.tcp && !pair.tcp.destroyed) {
      try {
        if (options.flushTcp) this.drainTcp(pair.tcp);
        else pair.tcp.destroy();
      } catch (error) {
        pair.tcp.destroy();
        log.debug("DesktopBridgeServer: TCP cleanup failed", {
          error,
          reason: options.closeReason,
        });
      }
    }

    if (options.closeCode != null) {
      closeWebSocket(pair.ws, options.closeCode, options.closeReason ?? "closing");
      return;
    }

    try {
      if (pair.ws.readyState === WebSocket.OPEN || pair.ws.readyState === WebSocket.CONNECTING) {
        pair.ws.close();
        return;
      }

      if (pair.ws.readyState !== WebSocket.CLOSED) {
        pair.ws.terminate();
      }
    } catch (error) {
      log.debug("DesktopBridgeServer: WebSocket cleanup failed", {
        error,
        reason: options.closeReason,
      });
    }
  }
}

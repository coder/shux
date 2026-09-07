/**
 * TerminalSessionRouter - Centralized manager for terminal session streams
 *
 * Eliminates entire classes of bugs by enforcing:
 * 1. Exactly one ORPC stream per sessionId (no duplicate subscriptions)
 * 2. Explicit routing via Map lookup (no closure captures)
 * 3. Synchronous subscribe/unsubscribe (no timing races)
 * 4. Cached screenState for late subscribers
 *
 * Usage:
 * ```typescript
 * const router = new TerminalSessionRouter(api);
 * const unsubscribe = router.subscribe(sessionId, {
 *   onOutput: (data) => term.write(data),
 *   onScreenState: (state) => { term.clear(); term.write(state); },
 *   onExit: (code) => console.log('Exit:', code),
 * });
 * // Later:
 * unsubscribe();
 * ```
 */

import type { RouterClient } from "@orpc/server";
import type { AppRouter } from "@/node/orpc/router";
import { getErrorMessage } from "@/common/utils/errors";

type APIClient = RouterClient<AppRouter>;

export interface TerminalSubscriberCallbacks {
  onOutput: (data: string) => void;
  onScreenState: (state: string) => void;
  onExit: (code: number) => void;
}

interface SessionState {
  /** Unique subscriber ID → callbacks */
  subscribers: Map<number, TerminalSubscriberCallbacks>;
  /** Cached screen state (sent to new subscribers immediately) */
  screenState: string | null;
  /** Abort controller for the attach stream */
  abortController: AbortController;
  /** Whether the session has exited */
  exited: boolean;
  /** Exit code if exited */
  exitCode?: number;
}

let nextSubscriberId = 1;

export class TerminalSessionRouter {
  private readonly api: APIClient;
  private sessions = new Map<string, SessionState>();

  constructor(api: APIClient) {
    this.api = api;
  }

  /** Get the API client (for identity comparison when recreating router) */
  getApi(): APIClient {
    return this.api;
  }

  /**
   * Subscribe to a terminal session's output.
   *
   * If this is the first subscriber for the session, starts the ORPC stream.
   * If screenState is already cached (from a previous subscriber), delivers it immediately.
   *
   * @returns Unsubscribe function (call to stop receiving data)
   */
  subscribe(sessionId: string, callbacks: TerminalSubscriberCallbacks): () => void {
    const subscriberId = nextSubscriberId++;

    console.debug(`[TerminalRouter] Subscribe: session=${sessionId}, subscriberId=${subscriberId}`);

    let session = this.sessions.get(sessionId);
    if (!session) {
      // First subscriber - create session state and start stream
      console.debug(`[TerminalRouter] First subscriber for ${sessionId}, starting stream`);
      session = {
        subscribers: new Map(),
        screenState: null,
        abortController: new AbortController(),
        exited: false,
      };
      this.sessions.set(sessionId, session);
      this.startStream(sessionId, session);
    }

    // Add subscriber
    session.subscribers.set(subscriberId, callbacks);
    console.debug(
      `[TerminalRouter] Session ${sessionId} now has ${session.subscribers.size} subscribers`
    );

    // Deliver cached screenState if available (for late subscribers)
    if (session.screenState !== null) {
      // Use setTimeout to ensure this happens after the caller has finished setup
      setTimeout(() => {
        const currentSession = this.sessions.get(sessionId);
        const currentCallbacks = currentSession?.subscribers.get(subscriberId);
        if (currentCallbacks && currentSession && currentSession.screenState !== null) {
          currentCallbacks.onScreenState(currentSession.screenState);
        }
      }, 0);
    }

    // If session already exited, notify immediately
    if (session.exited && session.exitCode !== undefined) {
      setTimeout(() => {
        const currentSession = this.sessions.get(sessionId);
        const currentCallbacks = currentSession?.subscribers.get(subscriberId);
        if (currentCallbacks && currentSession?.exited && currentSession.exitCode !== undefined) {
          currentCallbacks.onExit(currentSession.exitCode);
        }
      }, 0);
    }

    // Return unsubscribe function
    return () => {
      console.debug(
        `[TerminalRouter] Unsubscribe: session=${sessionId}, subscriberId=${subscriberId}`
      );
      const currentSession = this.sessions.get(sessionId);
      if (!currentSession) {
        console.debug(`[TerminalRouter] Session ${sessionId} already removed`);
        return;
      }

      currentSession.subscribers.delete(subscriberId);
      console.debug(
        `[TerminalRouter] Session ${sessionId} now has ${currentSession.subscribers.size} subscribers`
      );

      // If no more subscribers, tear down the stream
      if (currentSession.subscribers.size === 0) {
        console.debug(`[TerminalRouter] No more subscribers for ${sessionId}, tearing down stream`);
        currentSession.abortController.abort();
        this.sessions.delete(sessionId);
      }
    };
  }

  /**
   * Intercept terminal color queries that ghostty-web might not respond to yet.
   *
   * OSC 10/11 queries (foreground/background) are used by some TUIs to theme themselves.
   */
  private handleTerminalQueries(sessionId: string, data: string) {
    if (data.includes("\x1b]11;?") || data.includes("\x1b]10;?")) {
      const styles = getComputedStyle(document.documentElement);
      if (data.includes("\x1b]11;?")) {
        const bg = styles.getPropertyValue("--color-terminal-bg").trim() || "#1e1e1e";
        this.sendInput(sessionId, `\x1b]11;${this.formatXtermColor(bg)}\x07`);
      }
      if (data.includes("\x1b]10;?")) {
        const fg = styles.getPropertyValue("--color-terminal-fg").trim() || "#d4d4d4";
        this.sendInput(sessionId, `\x1b]10;${this.formatXtermColor(fg)}\x07`);
      }
    }
  }

  private formatXtermColor(color: string): string {
    // OSC 10/11 responses are typically expected in xterm's `rgb:RRRR/GGGG/BBBB` form.
    //
    // Note: our theme vars often use HSL (see globals.css), so we must resolve to an RGB
    // value before responding.
    if (color.startsWith("#")) {
      const hex = color.slice(1);
      if (hex.length === 3) {
        const r16 = hex[0].repeat(4);
        const g16 = hex[1].repeat(4);
        const b16 = hex[2].repeat(4);
        return `rgb:${r16}/${g16}/${b16}`;
      }
      if (hex.length === 6) {
        const r8 = hex.slice(0, 2);
        const g8 = hex.slice(2, 4);
        const b8 = hex.slice(4, 6);
        return `rgb:${r8}${r8}/${g8}${g8}/${b8}${b8}`;
      }
    }

    const computedRgb = this.computeCssColorToRgb(color);
    if (!computedRgb) {
      return color;
    }

    const toHex2 = (value: number) => {
      const clamped = Math.max(0, Math.min(255, Math.round(value)));
      return clamped.toString(16).padStart(2, "0");
    };

    const r8 = toHex2(computedRgb.r);
    const g8 = toHex2(computedRgb.g);
    const b8 = toHex2(computedRgb.b);
    return `rgb:${r8}${r8}/${g8}${g8}/${b8}${b8}`;
  }

  private computeCssColorToRgb(color: string): { r: number; g: number; b: number } | null {
    // This is a rare path (only when a TUI queries OSC 10/11), but the terminal output
    // stream is performance sensitive. Be defensive: never throw.
    try {
      const el = document.createElement("div");
      el.style.color = color;

      // Some browsers won't fully resolve computed styles unless the element is in the DOM.
      // Use a hidden element and clean it up immediately.
      el.style.position = "absolute";
      el.style.left = "-9999px";
      el.style.top = "-9999px";

      const parent = document.body ?? document.documentElement;
      parent.appendChild(el);

      try {
        const computed = getComputedStyle(el).color;
        const match = /^rgba?\((.*)\)$/.exec(computed);
        if (!match) {
          return null;
        }

        const beforeSlash = match[1].split("/")[0] ?? "";
        const parts = beforeSlash
          .replace(/,/g, " ")
          .trim()
          .split(/\s+/)
          .filter((p) => p.length > 0);

        if (parts.length < 3) {
          return null;
        }

        const r = Number.parseFloat(parts[0] ?? "");
        const g = Number.parseFloat(parts[1] ?? "");
        const b = Number.parseFloat(parts[2] ?? "");

        if (!Number.isFinite(r) || !Number.isFinite(g) || !Number.isFinite(b)) {
          return null;
        }

        return { r, g, b };
      } finally {
        el.remove();
      }
    } catch {
      return null;
    }
  }

  /**
   * Send input to a terminal session.
   */
  sendInput(sessionId: string, data: string): void {
    void this.api.terminal.sendInput({ sessionId, data });
  }

  /**
   * Resize a terminal session.
   *
   * Returns a promise that resolves when the backend handler has completed.
   * (This is used by TerminalView to keep frontend and PTY dimensions in sync.)
   */
  resize(sessionId: string, cols: number, rows: number): Promise<void> {
    return this.api.terminal.resize({ sessionId, cols, rows });
  }

  /**
   * Clean up all sessions (call on unmount).
   */
  dispose(): void {
    for (const session of this.sessions.values()) {
      session.abortController.abort();
    }
    this.sessions.clear();
  }

  // ============================================================================
  // Private methods
  // ============================================================================

  private startStream(sessionId: string, session: SessionState): void {
    const { signal } = session.abortController;

    console.debug(`[TerminalRouter] Starting stream for session ${sessionId}`);

    // Start attach stream (fire-and-forget, but managed by abort controller)
    void (async () => {
      try {
        const iterator = await this.api.terminal.attach({ sessionId }, { signal });
        for await (const msg of iterator) {
          // Check if session was removed (unsubscribed)
          const currentSession = this.sessions.get(sessionId);
          if (!currentSession) {
            console.debug(`[TerminalRouter] Session ${sessionId} removed, stopping stream`);
            break;
          }

          if (msg.type === "screenState") {
            // Cache and broadcast
            currentSession.screenState = msg.data;
            console.debug(
              `[TerminalRouter] Broadcasting screenState for ${sessionId} to ${currentSession.subscribers.size} subscribers`
            );
            for (const callbacks of currentSession.subscribers.values()) {
              callbacks.onScreenState(msg.data);
            }
          } else if (msg.type === "output") {
            // Centralized shim for OSC 10/11 color queries that some TUIs rely on.
            this.handleTerminalQueries(sessionId, msg.data);

            // Broadcast to all subscribers
            for (const callbacks of currentSession.subscribers.values()) {
              callbacks.onOutput(msg.data);
            }
          }
        }
      } catch (err) {
        if (!signal.aborted) {
          console.error(`[TerminalRouter] Stream error for ${sessionId}:`, err);
        }
      }
    })();

    // Start exit stream
    void (async () => {
      try {
        const iterator = await this.api.terminal.onExit({ sessionId }, { signal });
        for await (const code of iterator) {
          const currentSession = this.sessions.get(sessionId);
          if (!currentSession) break;

          currentSession.exited = true;
          currentSession.exitCode = code;

          // Broadcast to all subscribers
          for (const callbacks of currentSession.subscribers.values()) {
            callbacks.onExit(code);
          }
          break; // Exit only happens once
        }
      } catch (err) {
        if (!signal.aborted) {
          // Ignore "session not found" errors for exit stream
          const errMsg = getErrorMessage(err);
          if (!errMsg.includes("isOpen") && !errMsg.includes("undefined")) {
            console.error(`[TerminalRouter] Exit stream error for ${sessionId}:`, err);
          }
        }
      }
    })();
  }
}

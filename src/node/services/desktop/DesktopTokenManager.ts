import { randomBytes } from "node:crypto";
import { DESKTOP_DEFAULTS } from "@/common/constants/desktop";
import { assert } from "@/common/utils/assert";
import { log } from "@/node/services/log";

interface TokenRecord {
  // Keep the requester even for a shared desktop: the bridge must revalidate its
  // current relationship to the owner, not authorize it as the owner directly.
  workspaceId: string;
  sessionId: string;
  /** The viewer registration the requesting pane holds, so its bridge can be attributed to it. */
  viewerId: string | null;
  expiresAtMs: number;
}

// Cleanup expired tokens every 60s.
const CLEANUP_INTERVAL_MS = 60_000;

export class DesktopTokenManager {
  private readonly tokens = new Map<string, TokenRecord>();
  private cleanupTimer: ReturnType<typeof setInterval> | null = null;

  constructor() {
    this.cleanupTimer = setInterval(() => this.cleanupExpired(), CLEANUP_INTERVAL_MS);

    // Don't keep the process alive just to clean up stale tokens.
    this.cleanupTimer.unref?.();
  }

  /**
   * Mint a new single-use token binding a workspace to a session.
   */
  mint(workspaceId: string, sessionId: string, viewerId: string | null = null): string {
    assert(workspaceId.length > 0, "DesktopTokenManager.mint requires non-empty workspaceId");
    assert(sessionId.length > 0, "DesktopTokenManager.mint requires non-empty sessionId");
    assert(viewerId !== "", "DesktopTokenManager.mint requires a non-empty viewerId or null");

    let token = "";
    do {
      token = randomBytes(32).toString("hex");
    } while (this.tokens.has(token));

    this.tokens.set(token, {
      workspaceId,
      sessionId,
      viewerId,
      expiresAtMs: Date.now() + DESKTOP_DEFAULTS.TOKEN_TTL_MS,
    });

    return token;
  }

  /**
   * Validate and consume a token. Returns the bound workspace/session info or
   * null if the token is invalid, expired, or already consumed.
   */
  validate(
    token: string
  ): { workspaceId: string; sessionId: string; viewerId: string | null } | null {
    const record = this.tokens.get(token);
    if (!record) {
      return null;
    }

    // Single-use tokens are consumed regardless of validation outcome.
    this.tokens.delete(token);

    if (Date.now() > record.expiresAtMs) {
      log.debug("DesktopTokenManager: token expired", { tokenPrefix: token.slice(0, 8) });
      return null;
    }

    return {
      workspaceId: record.workspaceId,
      sessionId: record.sessionId,
      viewerId: record.viewerId,
    };
  }

  /** Remove all expired tokens. Called periodically by the cleanup timer. */
  private cleanupExpired(): void {
    const now = Date.now();
    let cleaned = 0;

    for (const [token, record] of this.tokens) {
      if (now > record.expiresAtMs) {
        this.tokens.delete(token);
        cleaned += 1;
      }
    }

    if (cleaned > 0) {
      log.debug("DesktopTokenManager: cleaned up expired tokens", { count: cleaned });
    }
  }

  /** Stop the cleanup timer and clear all minted tokens. */
  dispose(): void {
    if (this.cleanupTimer !== null) {
      clearInterval(this.cleanupTimer);
      this.cleanupTimer = null;
    }

    this.tokens.clear();
  }
}

import assert from "node:assert/strict";
import type { RuntimeMode } from "@/common/types/runtime";
import type { NegotiatedCapabilities } from "./capabilities";

const KNOWN_RUNTIME_MODES: ReadonlySet<RuntimeMode> = new Set([
  "local",
  "worktree",
  "ssh",
  "docker",
  "devcontainer",
]);

export interface SessionRouting {
  workspaceId: string;
  runtimeMode: RuntimeMode;
  editorHandlesFs: boolean;
  editorHandlesTerminal: boolean;
}

export class SessionManager {
  private readonly sessions = new Map<string, SessionRouting>();
  private readonly workspaceToSession = new Map<string, string>();

  registerSession(
    sessionId: string,
    workspaceId: string,
    runtimeMode: RuntimeMode,
    negotiated?: NegotiatedCapabilities
  ): void {
    assert(sessionId.trim().length > 0, "[SessionManager] sessionId must be a non-empty string");
    assert(
      workspaceId.trim().length > 0,
      "[SessionManager] workspaceId must be a non-empty string"
    );
    assert(
      KNOWN_RUNTIME_MODES.has(runtimeMode),
      `[SessionManager] unsupported runtime mode: ${runtimeMode}`
    );

    const existingRouting = this.sessions.get(sessionId);
    if (existingRouting && existingRouting.workspaceId !== workspaceId) {
      this.workspaceToSession.delete(existingRouting.workspaceId);
    }

    const existingSessionId = this.workspaceToSession.get(workspaceId);
    if (existingSessionId && existingSessionId !== sessionId) {
      this.sessions.delete(existingSessionId);
    }

    const isLocal = runtimeMode === "local";
    this.sessions.set(sessionId, {
      workspaceId,
      runtimeMode,
      editorHandlesFs: isLocal && (negotiated?.editorSupportsFsWrite ?? false),
      editorHandlesTerminal: isLocal && (negotiated?.editorSupportsTerminal ?? false),
    });

    this.workspaceToSession.set(workspaceId, sessionId);
  }

  getRouting(sessionId: string): SessionRouting {
    const routing = this.sessions.get(sessionId);
    assert(routing, `[SessionManager] missing routing for sessionId "${sessionId}"`);
    return routing;
  }

  getWorkspaceId(sessionId: string): string {
    return this.getRouting(sessionId).workspaceId;
  }

  removeSession(sessionId: string): void {
    const routing = this.sessions.get(sessionId);
    if (!routing) {
      return;
    }

    this.sessions.delete(sessionId);

    const mappedSessionId = this.workspaceToSession.get(routing.workspaceId);
    if (mappedSessionId === sessionId) {
      this.workspaceToSession.delete(routing.workspaceId);
    }
  }

  getAllSessions(): ReadonlyMap<string, SessionRouting> {
    return this.sessions;
  }
}

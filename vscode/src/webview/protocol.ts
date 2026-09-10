/**
 * VS Code webview ↔ extension host message protocol.
 *
 * - Webview → extension: {@link WebviewToExtensionMessage} (includes oRPC call/cancel messages)
 * - Extension → webview: {@link ExtensionToWebviewMessage} (includes oRPC responses + chat updates)
 */

import type { WorkspaceChatMessage } from "xum/common/orpc/types";

export type UiWorkspaceRuntimeType = "local" | "worktree" | "ssh";

export interface UiWorkspace {
  id: string;

  // Split fields so the webview can render without parsing a formatted label.
  projectName: string;
  workspaceName: string;
  projectPath: string;

  streaming: boolean;
  runtimeType: UiWorkspaceRuntimeType;
  sshHost?: string | undefined;

  createdAt: string;
  unarchivedAt?: string | undefined;
}

export interface UiConnectionStatus {
  mode: "api" | "file";
  baseUrl?: string;
  error?: string;
}

export type OrpcCall = {
  type: "orpcCall";
  requestId: string;
  path: string[];
  input: unknown;
  lastEventId?: string | undefined;
};

export type OrpcCancel = {
  type: "orpcCancel";
  requestId: string;
};

export type OrpcStreamCancel = {
  type: "orpcStreamCancel";
  streamId: string;
};

export type OrpcResponse =
  | {
      type: "orpcResponse";
      requestId: string;
      ok: true;
      kind: "value";
      value: unknown;
    }
  | {
      type: "orpcResponse";
      requestId: string;
      ok: true;
      kind: "stream";
      streamId: string;
    }
  | {
      type: "orpcResponse";
      requestId: string;
      ok: false;
      error: string;
    };

export type OrpcStreamData = {
  type: "orpcStreamData";
  streamId: string;
  value: unknown;
};

export type OrpcStreamEnd = {
  type: "orpcStreamEnd";
  streamId: string;
};

export type OrpcStreamError = {
  type: "orpcStreamError";
  streamId: string;
  error: string;
};

export type WebviewToExtensionMessage =
  | { type: "ready" }
  | { type: "refreshWorkspaces" }
  | { type: "selectWorkspace"; workspaceId: string | null }
  | { type: "openWorkspace"; workspaceId: string }
  | { type: "configureConnection" }
  | { type: "debugLog"; message: string; data?: unknown }
  | { type: "copyDebugLog"; text: string }
  | OrpcCall
  | OrpcCancel
  | OrpcStreamCancel;

export type ExtensionToWebviewMessage =
  | { type: "connectionStatus"; status: UiConnectionStatus }
  | { type: "workspaces"; workspaces: UiWorkspace[] }
  | { type: "setSelectedWorkspace"; workspaceId: string | null }
  | { type: "chatReset"; workspaceId: string }
  | { type: "chatEvent"; workspaceId: string; event: WorkspaceChatMessage }
  | { type: "uiNotice"; level: "info" | "error"; message: string }
  | { type: "debugProbe"; attempt: number; sentAtMs: number }
  | OrpcResponse
  | OrpcStreamData
  | OrpcStreamEnd
  | OrpcStreamError;

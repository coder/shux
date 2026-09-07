import assert from "node:assert/strict";
import path from "node:path";
import { realpath } from "node:fs/promises";
import type { LoadSessionRequest, LoadSessionResponse } from "@agentclientprotocol/sdk";
import { isWorktreeRuntime, type RuntimeMode } from "@/common/types/runtime";
import type { NegotiatedCapabilities } from "../capabilities";
import { buildConfigOptions } from "../configOptions";
import { resolveAgentAiSettings, type ResolvedAiSettings } from "../resolveAgentAiSettings";
import type { ServerConnection } from "../serverConnection";
import type { SessionManager } from "../sessionManager";

type WorkspaceInfo = NonNullable<
  Awaited<ReturnType<ServerConnection["client"]["workspace"]["getInfo"]>>
>;

export interface ResumedSessionContext {
  sessionId: string;
  workspaceId: string;
  runtimeMode: RuntimeMode;
  agentId: string;
  aiSettings: ResolvedAiSettings;
  response: LoadSessionResponse;
}

export interface SessionResumeDependencies {
  server: ServerConnection;
  sessionManager: SessionManager;
  negotiatedCapabilities: NegotiatedCapabilities | null;
  defaultAgentId: string;
  // Keep the active draft together when reloading an existing ACP session.
  existingSessionState?: Pick<ResumedSessionContext, "agentId" | "aiSettings">;
}

function resolveRuntimeMode(workspace: WorkspaceInfo): RuntimeMode {
  if (isWorktreeRuntime(workspace.runtimeConfig)) {
    return "worktree";
  }

  return workspace.runtimeConfig.type;
}

function stripTrailingPathSeparators(value: string): string {
  const root = path.parse(value).root;
  let normalized = value;

  while (
    normalized.length > root.length &&
    (normalized.endsWith(path.posix.sep) || normalized.endsWith(path.win32.sep))
  ) {
    normalized = normalized.slice(0, -1);
  }

  return normalized;
}

function normalizePathCasingForComparison(value: string): string {
  return process.platform === "win32" ? value.toLowerCase() : value;
}

export async function canonicalizePathForWorkspaceMatch(value: string): Promise<string> {
  const trimmed = value.trim();
  assert(trimmed.length > 0, "canonicalizePathForWorkspaceMatch: value must be non-empty");

  const resolvedPath = stripTrailingPathSeparators(path.normalize(path.resolve(trimmed)));

  try {
    const realPathValue = await realpath(resolvedPath);
    return normalizePathCasingForComparison(
      stripTrailingPathSeparators(path.normalize(realPathValue))
    );
  } catch {
    // Best-effort canonicalization: unresolved paths (e.g., stale workspaces or
    // platform-specific virtualization) still compare via normalized absolute form.
    return normalizePathCasingForComparison(resolvedPath);
  }
}

export async function loadSessionFromWorkspace(
  params: LoadSessionRequest,
  deps: SessionResumeDependencies
): Promise<ResumedSessionContext> {
  const requestedSessionId = params.sessionId.trim();
  assert(requestedSessionId.length > 0, "loadSessionFromWorkspace: sessionId must be non-empty");

  const requestedCwd = params.cwd.trim();
  assert(requestedCwd.length > 0, "loadSessionFromWorkspace: cwd must be non-empty");

  const workspace = await deps.server.client.workspace.getInfo({ workspaceId: requestedSessionId });
  if (!workspace) {
    throw new Error(`loadSessionFromWorkspace: workspace '${requestedSessionId}' was not found`);
  }

  const [
    canonicalRequestedCwd,
    canonicalProjectPath,
    canonicalWorkspacePath,
    canonicalSubProjectPath,
  ] = await Promise.all([
    canonicalizePathForWorkspaceMatch(requestedCwd),
    canonicalizePathForWorkspaceMatch(workspace.projectPath),
    canonicalizePathForWorkspaceMatch(workspace.namedWorkspacePath),
    workspace.subProjectPath != null
      ? canonicalizePathForWorkspaceMatch(workspace.subProjectPath)
      : Promise.resolve(null),
  ]);

  const cwdMatchesWorkspace =
    canonicalProjectPath === canonicalRequestedCwd ||
    canonicalWorkspacePath === canonicalRequestedCwd ||
    canonicalSubProjectPath === canonicalRequestedCwd;
  assert(
    cwdMatchesWorkspace,
    `loadSessionFromWorkspace: workspace '${requestedSessionId}' is not in cwd '${requestedCwd}'`
  );

  const workspaceId = workspace.id;
  const runtimeMode = resolveRuntimeMode(workspace);

  deps.sessionManager.registerSession(
    requestedSessionId,
    workspaceId,
    runtimeMode,
    deps.negotiatedCapabilities ?? undefined
  );

  const agentId = deps.existingSessionState?.agentId ?? workspace.agentId ?? deps.defaultAgentId;
  const aiSettings =
    deps.existingSessionState?.aiSettings ??
    workspace.aiSettingsByAgent?.[agentId] ??
    workspace.aiSettings ??
    (await resolveAgentAiSettings(deps.server.client, agentId, workspaceId));

  const configOptions = await buildConfigOptions(deps.server.client, workspaceId, {
    activeAgentId: agentId,
    aiSettings,
  });

  return {
    sessionId: requestedSessionId,
    workspaceId,
    runtimeMode,
    agentId,
    aiSettings,
    response: {
      configOptions,
    },
  };
}

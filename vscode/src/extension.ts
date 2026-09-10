import * as vscode from "vscode";
import assert from "node:assert";
import { createHash, randomBytes } from "node:crypto";

import { formatRelativeTime } from "xum/browser/utils/ui/dateTime";
import {
  getAllWorkspacesFromFiles,
  getAllWorkspacesFromApi,
  getWorkspacePath,
  WorkspaceWithContext,
} from "./xumConfig";
import { checkAuth, checkServerReachable } from "./api/connectionCheck";
import { createApiClient, type ApiClient } from "./api/client";
import {
  clearAuthTokenOverride,
  discoverServerConfig,
  getConnectionModeSetting,
  storeAuthTokenOverride,
  type ConnectionMode,
} from "./api/discovery";
import type {
  ExtensionToWebviewMessage,
  UiConnectionStatus,
  UiWorkspace,
} from "./webview/protocol";
import { isAllowedOrpcPath } from "./orpcAllowlist";
import { parseWebviewToExtensionMessage } from "./parseWebviewToExtensionMessage";
import { openWorkspace } from "./workspaceOpener";

let sessionPreferredMode: "api" | "file" | null = null;
let didShowFallbackPrompt = false;

const ACTION_FIX_CONNECTION_CONFIG = "Fix connection config";
const ACTION_USE_LOCAL_FILES = "Use local file access";

const PENDING_AUTO_SELECT_STATE_KEY = "mux.pendingAutoSelectWorkspace";
const SELECTED_WORKSPACE_STATE_KEY = "mux.selectedWorkspaceId";
const PENDING_AUTO_SELECT_TTL_MS = 5 * 60_000;

interface PendingAutoSelectState {
  workspaceId: string;
  expectedWorkspaceUri: string;
  createdAtMs: number;
}

let xumLogChannel: vscode.LogOutputChannel | undefined;

function getXumLogChannel(): vscode.LogOutputChannel {
  if (!xumLogChannel) {
    xumLogChannel = vscode.window.createOutputChannel("Xum", { log: true });
  }

  return xumLogChannel;
}

function formatLogData(data: unknown): string {
  if (data === undefined) {
    return "";
  }

  try {
    return JSON.stringify(data);
  } catch {
    return String(data);
  }
}

function xumLog(
  level: "debug" | "info" | "warn" | "error",
  message: string,
  data?: unknown
): void {
  const channel = getXumLogChannel();
  const suffix = data === undefined ? "" : ` ${formatLogData(data)}`;

  switch (level) {
    case "debug":
      channel.debug(message + suffix);
      return;
    case "info":
      channel.info(message + suffix);
      return;
    case "warn":
      channel.warn(message + suffix);
      return;
    case "error":
      channel.error(message + suffix);
      return;
  }
}

function xumLogDebug(message: string, data?: unknown): void {
  xumLog("debug", message, data);
}

function xumLogInfo(message: string, data?: unknown): void {
  xumLog("info", message, data);
}

function xumLogWarn(message: string, data?: unknown): void {
  xumLog("warn", message, data);
}

function xumLogError(message: string, data?: unknown): void {
  xumLog("error", message, data);
}

function toUiWorkspace(workspace: WorkspaceWithContext): UiWorkspace {
  assert(workspace, "toUiWorkspace requires workspace");

  const isLegacyWorktree =
    workspace.runtimeConfig.type === "local" &&
    "srcBaseDir" in workspace.runtimeConfig &&
    Boolean(workspace.runtimeConfig.srcBaseDir);

  const runtimeType =
    workspace.runtimeConfig.type === "ssh"
      ? "ssh"
      : workspace.runtimeConfig.type === "worktree" || isLegacyWorktree
        ? "worktree"
        : "local";

  const sshHost = workspace.runtimeConfig.type === "ssh" ? workspace.runtimeConfig.host : undefined;
  const workspaceName = workspace.title ?? workspace.name;

  return {
    id: workspace.id,
    projectName: workspace.projectName,
    workspaceName,
    projectPath: workspace.projectPath,
    streaming: workspace.extensionMetadata?.streaming ?? false,
    runtimeType,
    sshHost,
    // Backend guarantees createdAt for new workspaces, but keep a stable fallback for legacy ones.
    createdAt: workspace.createdAt ?? new Date(0).toISOString(),
    unarchivedAt: workspace.unarchivedAt,
  };
}

function getNonce(): string {
  // Use a CSP nonce format that is known to work well in VS Code webviews.
  // (Hex avoids characters like "+" and "/" that can be awkward to debug.)
  return randomBytes(16).toString("hex");
}

function getOpenFolderUri(workspace: WorkspaceWithContext): vscode.Uri {
  assert(workspace, "getOpenFolderUri requires workspace");

  if (workspace.runtimeConfig.type === "ssh") {
    const host = workspace.runtimeConfig.host;
    const remotePath = getWorkspacePath(workspace);
    return vscode.Uri.parse(`vscode-remote://ssh-remote+${host}${remotePath}`);
  }

  const workspacePath = getWorkspacePath(workspace);
  return vscode.Uri.file(workspacePath);
}

async function setPendingAutoSelectWorkspace(
  context: vscode.ExtensionContext,
  workspace: WorkspaceWithContext
): Promise<void> {
  assert(context, "setPendingAutoSelectWorkspace requires context");
  assert(workspace, "setPendingAutoSelectWorkspace requires workspace");

  const expectedUri = getOpenFolderUri(workspace);
  const state: PendingAutoSelectState = {
    workspaceId: workspace.id,
    expectedWorkspaceUri: expectedUri.toString(),
    createdAtMs: Date.now(),
  };

  await context.globalState.update(PENDING_AUTO_SELECT_STATE_KEY, state);
}

async function getPendingAutoSelectWorkspace(
  context: vscode.ExtensionContext
): Promise<PendingAutoSelectState | null> {
  assert(context, "getPendingAutoSelectWorkspace requires context");

  const pending = context.globalState.get<PendingAutoSelectState>(PENDING_AUTO_SELECT_STATE_KEY);
  if (!pending) {
    return null;
  }

  if (
    typeof pending.workspaceId !== "string" ||
    typeof pending.expectedWorkspaceUri !== "string" ||
    typeof pending.createdAtMs !== "number"
  ) {
    await context.globalState.update(PENDING_AUTO_SELECT_STATE_KEY, undefined);
    return null;
  }

  if (Date.now() - pending.createdAtMs > PENDING_AUTO_SELECT_TTL_MS) {
    await context.globalState.update(PENDING_AUTO_SELECT_STATE_KEY, undefined);
    return null;
  }

  return pending;
}

async function clearPendingAutoSelectWorkspace(context: vscode.ExtensionContext): Promise<void> {
  assert(context, "clearPendingAutoSelectWorkspace requires context");
  await context.globalState.update(PENDING_AUTO_SELECT_STATE_KEY, undefined);
}

function getPrimaryWorkspaceFolderUri(): vscode.Uri | null {
  const folder = vscode.workspace.workspaceFolders?.[0];
  return folder?.uri ?? null;
}

async function revealChatView(): Promise<void> {
  try {
    await vscode.commands.executeCommand("workbench.view.extension.muxSecondary");
  } catch {
    // Ignore - command may not exist in older VS Code or if view container isn't registered.
  }

  try {
    await vscode.commands.executeCommand("mux.chatView.focus");
  } catch {
    // Ignore - focus command may not exist for webview views.
  }
}
const ACTION_CANCEL = "Cancel";

type ApiConnectionFailure =
  | { kind: "unreachable"; baseUrl: string; error: string }
  | { kind: "unauthorized"; baseUrl: string; error: string }
  | { kind: "error"; baseUrl: string; error: string };

function formatError(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function describeFailure(failure: ApiConnectionFailure): string {
  switch (failure.kind) {
    case "unreachable":
      return `xum server is not reachable at ${failure.baseUrl}`;
    case "unauthorized":
      return `xum server rejected the auth token at ${failure.baseUrl}`;
    case "error":
      return `xum server connection failed at ${failure.baseUrl}`;
  }
}

function getWarningSuffix(failure: ApiConnectionFailure): string {
  if (failure.kind === "unauthorized") {
    return "Using local file access while xum is running can cause inconsistencies.";
  }
  return "Using local file access can cause inconsistencies.";
}

async function tryGetApiClient(
  context: vscode.ExtensionContext
): Promise<{ client: ApiClient; baseUrl: string } | { failure: ApiConnectionFailure }> {
  assert(context, "tryGetApiClient requires context");

  xumLogDebug("xum: tryGetApiClient start");

  try {
    const discovery = await discoverServerConfig(context);

    xumLogDebug("xum: discovered server config", {
      baseUrl: discovery.baseUrl,
      baseUrlSource: discovery.baseUrlSource,
      authTokenSource: discovery.authTokenSource,
      hasAuthToken: Boolean(discovery.authToken),
    });

    const client = createApiClient({ baseUrl: discovery.baseUrl, authToken: discovery.authToken });

    const reachable = await checkServerReachable(discovery.baseUrl);
    xumLogDebug("xum: server reachable check", reachable);
    if (reachable.status !== "ok") {
      return {
        failure: {
          kind: "unreachable",
          baseUrl: discovery.baseUrl,
          error: reachable.error,
        },
      };
    }

    const auth = await checkAuth(client);
    xumLogDebug("xum: auth check", auth);

    if (auth.status === "unauthorized") {
      return {
        failure: {
          kind: "unauthorized",
          baseUrl: discovery.baseUrl,
          error: auth.error,
        },
      };
    }
    if (auth.status !== "ok") {
      return {
        failure: {
          kind: "error",
          baseUrl: discovery.baseUrl,
          error: auth.error,
        },
      };
    }

    xumLogDebug("xum: tryGetApiClient success", { baseUrl: discovery.baseUrl });

    return {
      client,
      baseUrl: discovery.baseUrl,
    };
  } catch (error) {
    xumLogError("xum: tryGetApiClient threw", { error: formatError(error) });

    return {
      failure: {
        kind: "error",
        baseUrl: "unknown",
        error: formatError(error),
      },
    };
  }
}

async function tryGetWorkspacesFromApi(
  context: vscode.ExtensionContext
): Promise<{ workspaces: WorkspaceWithContext[] } | { failure: ApiConnectionFailure }> {
  const api = await tryGetApiClient(context);
  if ("failure" in api) {
    return api;
  }

  const workspaces = await getAllWorkspacesFromApi(api.client);
  return { workspaces };
}

async function getWorkspacesForCommand(
  context: vscode.ExtensionContext
): Promise<WorkspaceWithContext[] | null> {
  const modeSetting: ConnectionMode = getConnectionModeSetting();

  if (modeSetting === "file-only" || sessionPreferredMode === "file") {
    sessionPreferredMode = "file";
    return getAllWorkspacesFromFiles();
  }

  const apiResult = await tryGetWorkspacesFromApi(context);
  if ("workspaces" in apiResult) {
    sessionPreferredMode = "api";
    return apiResult.workspaces;
  }

  const failure = apiResult.failure;

  if (modeSetting === "server-only") {
    const selection = await vscode.window.showErrorMessage(
      `xum: ${describeFailure(failure)}. (${failure.error})`,
      ACTION_FIX_CONNECTION_CONFIG
    );

    if (selection === ACTION_FIX_CONNECTION_CONFIG) {
      await configureConnectionCommand(context);
    }

    return null;
  }

  // modeSetting is auto.
  if (didShowFallbackPrompt) {
    sessionPreferredMode = "file";
    void vscode.window.showWarningMessage(
      `xum: ${describeFailure(failure)}. Falling back to local file access. Run "xum: Configure Connection" to fix.`
    );
    return getAllWorkspacesFromFiles();
  }

  const selection = await vscode.window.showWarningMessage(
    `xum: ${describeFailure(failure)}. ${getWarningSuffix(failure)}`,
    ACTION_FIX_CONNECTION_CONFIG,
    ACTION_USE_LOCAL_FILES,
    ACTION_CANCEL
  );

  if (!selection || selection === ACTION_CANCEL) {
    return null;
  }

  didShowFallbackPrompt = true;

  if (selection === ACTION_USE_LOCAL_FILES) {
    sessionPreferredMode = "file";
    return getAllWorkspacesFromFiles();
  }

  await configureConnectionCommand(context);

  const retry = await tryGetWorkspacesFromApi(context);
  if ("workspaces" in retry) {
    sessionPreferredMode = "api";
    return retry.workspaces;
  }

  // Still can't connect; fall back without prompting again.
  sessionPreferredMode = "file";
  void vscode.window.showWarningMessage(
    `xum: ${describeFailure(retry.failure)}. Falling back to local file access. (${retry.failure.error})`
  );
  return getAllWorkspacesFromFiles();
}

/**
 * Get the icon for a runtime type
 * - local (project-dir): $(folder) - simple folder, uses project directly
 * - worktree: $(git-branch) - git worktree isolation
 * - legacy local with srcBaseDir: $(git-branch) - treated as worktree
 * - ssh: $(remote) - remote execution
 */
function getRuntimeIcon(runtimeConfig: WorkspaceWithContext["runtimeConfig"]): string {
  if (runtimeConfig.type === "ssh") {
    return "$(remote)";
  }
  if (runtimeConfig.type === "worktree") {
    return "$(git-branch)";
  }
  // type === "local": check if it has srcBaseDir (legacy worktree) or not (project-dir)
  if ("srcBaseDir" in runtimeConfig && runtimeConfig.srcBaseDir) {
    return "$(git-branch)"; // Legacy worktree
  }
  return "$(folder)"; // Project-dir local
}

/**
 * Format workspace for display in QuickPick
 */
function formatWorkspaceLabel(workspace: WorkspaceWithContext): string {
  // Choose icon based on streaming status and runtime type
  const icon = workspace.extensionMetadata?.streaming
    ? "$(sync~spin)" // Spinning icon for active streaming
    : getRuntimeIcon(workspace.runtimeConfig);

  const baseName = `${icon} [${workspace.projectName}] ${workspace.name}`;

  // Add SSH host info if applicable
  if (workspace.runtimeConfig.type === "ssh") {
    return `${baseName} (ssh: ${workspace.runtimeConfig.host})`;
  }

  return baseName;
}

/**
 * Create QuickPick item for a workspace
 */
function createWorkspaceQuickPickItem(
  workspace: WorkspaceWithContext
): vscode.QuickPickItem & { workspace: WorkspaceWithContext } {
  const detailParts: string[] = [];

  // Prefer recency (last used) over created timestamp
  if (workspace.extensionMetadata?.recency) {
    detailParts.push(`Last used: ${formatRelativeTime(workspace.extensionMetadata.recency)}`);
  } else if (workspace.createdAt) {
    detailParts.push(`Created: ${new Date(workspace.createdAt).toLocaleDateString()}`);
  }

  const aiByAgent =
    workspace.aiSettingsByAgent ??
    workspace.aiSettingsByMode ??
    (workspace.aiSettings
      ? {
          plan: workspace.aiSettings,
          exec: workspace.aiSettings,
        }
      : undefined);
  const fallbackAgentId = workspace.agentId ?? workspace.agentType ?? "exec";
  const fallbackAiSettings = aiByAgent?.[fallbackAgentId];

  // Prefer activity-derived model/thinking ("last used") but fall back to workspace-scoped settings.
  const lastModel =
    workspace.extensionMetadata?.lastModel ??
    fallbackAiSettings?.model ??
    workspace.aiSettings?.model;
  if (lastModel) {
    detailParts.push(`Model: ${lastModel}`);
  }

  const lastThinkingLevel =
    workspace.extensionMetadata?.lastThinkingLevel ??
    fallbackAiSettings?.thinkingLevel ??
    workspace.aiSettings?.thinkingLevel;
  if (lastThinkingLevel) {
    detailParts.push(`Reasoning: ${lastThinkingLevel}`);
  }

  const detail = detailParts.length > 0 ? detailParts.join(" • ") : undefined;

  return {
    label: formatWorkspaceLabel(workspace),
    description: workspace.projectPath,
    detail,
    workspace,
  };
}

/**
 * Command: Open a xum workspace
 */
async function openWorkspaceCommand(
  context: vscode.ExtensionContext,
  options?: {
    chatViewProvider?: XumChatViewProvider;
  }
): Promise<void> {
  // Get all workspaces, this is intentionally not cached.
  const workspaces = await getWorkspacesForCommand(context);
  if (!workspaces) {
    return;
  }

  if (workspaces.length === 0) {
    const selection = await vscode.window.showInformationMessage(
      "No Xum workspaces found. Create a workspace in Xum first.",
      "Open Xum"
    );

    // User can't easily open Xum from VS Code, so just inform them
    if (selection === "Open Xum") {
      vscode.window.showInformationMessage(
        "Please open the Xum application to create workspaces."
      );
    }
    return;
  }

  // Create QuickPick items (already sorted by recency in getAllWorkspaces)
  const allItems = workspaces.map(createWorkspaceQuickPickItem);

  // Use createQuickPick for more control over sorting behavior
  const quickPick = vscode.window.createQuickPick<
    vscode.QuickPickItem & { workspace: WorkspaceWithContext }
  >();
  quickPick.placeholder = "Select a xum workspace to open";
  quickPick.matchOnDescription = true;
  quickPick.matchOnDetail = false;
  quickPick.items = allItems;

  // When user types, filter items but preserve recency order
  quickPick.onDidChangeValue((value) => {
    if (!value) {
      // No filter - show all items in recency order
      quickPick.items = allItems;
      return;
    }

    // Filter items manually to preserve recency order
    const lowerValue = value.toLowerCase();
    quickPick.items = allItems.filter((item) => {
      const labelMatch = item.label.toLowerCase().includes(lowerValue);
      const descMatch = item.description?.toLowerCase().includes(lowerValue);
      return labelMatch || descMatch;
    });
  });

  quickPick.show();

  // Wait for user selection
  const selected = await new Promise<
    (vscode.QuickPickItem & { workspace: WorkspaceWithContext }) | undefined
  >((resolve) => {
    quickPick.onDidAccept(() => {
      resolve(quickPick.selectedItems[0]);
      quickPick.dispose();
    });
    quickPick.onDidHide(() => {
      resolve(undefined);
      quickPick.dispose();
    });
  });

  if (!selected) {
    return;
  }

  if (options?.chatViewProvider) {
    await options.chatViewProvider.setSelectedWorkspaceId(selected.workspace.id);
    await revealChatView();
  }

  // Open the selected workspace
  await setPendingAutoSelectWorkspace(context, selected.workspace);
  await openWorkspace(selected.workspace);
}

async function configureConnectionCommand(context: vscode.ExtensionContext): Promise<void> {
  const config = vscode.workspace.getConfiguration("mux");

  // Small loop so users can set/clear both URL + token in one command.
  // Keep UX minimal: no nested quick picks or extra commands.
  for (;;) {
    const currentUrl = config.get<string>("serverUrl")?.trim() ?? "";
    const hasToken = (await context.secrets.get("mux.serverAuthToken")) !== undefined;

    const pick = await vscode.window.showQuickPick(
      [
        {
          label: "Set server URL",
          description: currentUrl ? `Current: ${currentUrl}` : "Current: auto-discover",
        },
        ...(currentUrl
          ? ([
              { label: "Clear server URL override", description: "Use env/lockfile/default" },
            ] as const)
          : ([] as const)),
        {
          label: "Set auth token",
          description: hasToken ? "Current: set" : "Current: none",
        },
        ...(hasToken ? ([{ label: "Clear auth token" }] as const) : ([] as const)),
        { label: "Done" },
      ],
      { placeHolder: "Configure xum server connection" }
    );

    if (!pick || pick.label === "Done") {
      return;
    }

    if (pick.label === "Set server URL") {
      const value = await vscode.window.showInputBox({
        title: "xum server URL",
        value: currentUrl,
        prompt: "Example: http://127.0.0.1:3000 (leave blank for auto-discovery)",
        validateInput(input) {
          const trimmed = input.trim();
          if (!trimmed) {
            return null;
          }
          try {
            const url = new URL(trimmed);
            if (url.protocol !== "http:" && url.protocol !== "https:") {
              return "URL must start with http:// or https://";
            }
            return null;
          } catch {
            return "Invalid URL";
          }
        },
      });

      if (value === undefined) {
        continue;
      }

      const trimmed = value.trim();
      await config.update(
        "serverUrl",
        trimmed ? trimmed : undefined,
        vscode.ConfigurationTarget.Global
      );
      continue;
    }

    if (pick.label === "Clear server URL override") {
      await config.update("serverUrl", undefined, vscode.ConfigurationTarget.Global);
      continue;
    }

    if (pick.label === "Set auth token") {
      const token = await vscode.window.showInputBox({
        title: "xum server auth token",
        prompt: "Paste the xum server auth token",
        password: true,
        validateInput(input) {
          return input.trim().length > 0 ? null : "Token cannot be empty";
        },
      });

      if (token === undefined) {
        continue;
      }

      await storeAuthTokenOverride(context, token.trim());
      continue;
    }

    if (pick.label === "Clear auth token") {
      await clearAuthTokenOverride(context);
      continue;
    }
  }
}

async function debugConnectionCommand(context: vscode.ExtensionContext): Promise<void> {
  assert(context, "debugConnectionCommand requires context");

  const output = getXumLogChannel();
  output.show(true);

  xumLogInfo("xum: debugConnection start");

  let discovery: Awaited<ReturnType<typeof discoverServerConfig>>;
  try {
    discovery = await discoverServerConfig(context);
  } catch (error) {
    xumLogError("xum: debugConnection discovery failed", { error: formatError(error) });
    void vscode.window.showErrorMessage(
      `xum: Failed to discover server config. (${formatError(error)})`
    );
    return;
  }

  xumLogInfo("xum: debugConnection discovered server config", {
    baseUrl: discovery.baseUrl,
    baseUrlSource: discovery.baseUrlSource,
    authTokenSource: discovery.authTokenSource,
    hasAuthToken: Boolean(discovery.authToken),
  });

  const reachable = await checkServerReachable(discovery.baseUrl, { timeoutMs: 2_000 });
  xumLogInfo("xum: debugConnection server reachable", reachable);

  if (reachable.status !== "ok") {
    void vscode.window.showErrorMessage(
      `xum: Server not reachable at ${discovery.baseUrl}. (${reachable.error})`
    );
    return;
  }

  const client = createApiClient({ baseUrl: discovery.baseUrl, authToken: discovery.authToken });

  const auth = await checkAuth(client, { timeoutMs: 2_000 });
  xumLogInfo("xum: debugConnection auth", auth);

  if (auth.status !== "ok") {
    const hint =
      auth.status === "unauthorized"
        ? ' Run "xum: Configure Connection" to update the auth token.'
        : "";

    void vscode.window.showErrorMessage(
      `xum: Failed to authenticate at ${discovery.baseUrl}. (${auth.error})${hint}`
    );
    return;
  }

  let workspaceCount: number | null = null;
  try {
    const workspaces = await getAllWorkspacesFromApi(client);
    workspaceCount = workspaces.length;
    xumLogInfo("xum: debugConnection listed workspaces", { count: workspaceCount });
  } catch (error) {
    xumLogWarn("xum: debugConnection list workspaces failed", { error: formatError(error) });
  }

  void vscode.window.showInformationMessage(
    workspaceCount === null
      ? `xum: Connected to ${discovery.baseUrl} (auth ok).`
      : `xum: Connected to ${discovery.baseUrl} (auth ok). Workspaces: ${workspaceCount}.`
  );
}

async function getWorkspacesForSidebar(
  context: vscode.ExtensionContext
): Promise<{ workspaces: WorkspaceWithContext[]; status: UiConnectionStatus }> {
  assert(context, "getWorkspacesForSidebar requires context");

  const modeSetting: ConnectionMode = getConnectionModeSetting();
  xumLogDebug("xum: getWorkspacesForSidebar", { modeSetting });

  const tryReadFromFiles = async (): Promise<
    { workspaces: WorkspaceWithContext[] } | { error: string }
  > => {
    try {
      return { workspaces: await getAllWorkspacesFromFiles() };
    } catch (error) {
      return { error: formatError(error) };
    }
  };

  if (modeSetting === "file-only") {
    const fileResult = await tryReadFromFiles();
    if ("error" in fileResult) {
      return {
        workspaces: [],
        status: {
          mode: "file",
          error: `Failed to read xum workspaces from local files. (${fileResult.error})`,
        },
      };
    }

    return { workspaces: fileResult.workspaces, status: { mode: "file" } };
  }

  const api = await tryGetApiClient(context);
  if ("failure" in api) {
    const failure = api.failure;

    if (modeSetting === "server-only") {
      return {
        workspaces: [],
        status: {
          mode: "file",
          baseUrl: failure.baseUrl,
          error: `${describeFailure(failure)}. (${failure.error})`,
        },
      };
    }

    const fileResult = await tryReadFromFiles();
    if ("error" in fileResult) {
      return {
        workspaces: [],
        status: {
          mode: "file",
          baseUrl: failure.baseUrl,
          error: `${describeFailure(failure)}. ${getWarningSuffix(failure)} (${failure.error}). Additionally, reading local workspaces failed. (${fileResult.error})`,
        },
      };
    }

    return {
      workspaces: fileResult.workspaces,
      status: {
        mode: "file",
        baseUrl: failure.baseUrl,
        error: `${describeFailure(failure)}. ${getWarningSuffix(failure)} (${failure.error})`,
      },
    };
  }

  try {
    const workspaces = await getAllWorkspacesFromApi(api.client);
    return {
      workspaces,
      status: {
        mode: "api",
        baseUrl: api.baseUrl,
      },
    };
  } catch (error) {
    const apiError = formatError(error);

    if (modeSetting === "server-only") {
      return {
        workspaces: [],
        status: {
          mode: "api",
          baseUrl: api.baseUrl,
          error: `Failed to list xum workspaces from server. (${apiError})`,
        },
      };
    }

    const fileResult = await tryReadFromFiles();
    if ("error" in fileResult) {
      return {
        workspaces: [],
        status: {
          mode: "api",
          baseUrl: api.baseUrl,
          error: `Failed to list xum workspaces from server. (${apiError}). Additionally, reading local workspaces failed. (${fileResult.error})`,
        },
      };
    }

    return {
      workspaces: fileResult.workspaces,
      status: {
        mode: "api",
        baseUrl: api.baseUrl,
        error: `Failed to list xum workspaces from server; falling back to local file access. (${apiError})`,
      },
    };
  }
}

function renderChatViewHtml(
  webview: vscode.Webview,
  extensionUri: vscode.Uri,
  traceId: string
): string {
  assert(typeof traceId === "string" && traceId.length > 0, "traceId must be a non-empty string");

  const scriptUri = webview.asWebviewUri(
    vscode.Uri.joinPath(extensionUri, "out", "xumChatView.js")
  );
  const styleUri = webview.asWebviewUri(
    vscode.Uri.joinPath(extensionUri, "out", "xumChatView.css")
  );
  const katexStyleUri = webview.asWebviewUri(
    vscode.Uri.joinPath(extensionUri, "out", "katex", "katex.min.css")
  );
  const nonce = getNonce();

  const csp = [
    "default-src 'none'",
    `img-src ${webview.cspSource} https: data:`,
    // Many xum components use inline styles (e.g., FileIcon).
    `style-src ${webview.cspSource} 'unsafe-inline'`,
    `script-src ${webview.cspSource} 'nonce-${nonce}'`,
    `font-src ${webview.cspSource} https: data:`,
    // Allow webview to fetch additional local assets (e.g. source maps, wasm) without
    // enabling arbitrary network access to the xum server.
    `connect-src ${webview.cspSource}`,
    // Shiki uses a Web Worker when available.
    `worker-src ${webview.cspSource} blob:`,
  ].join("; ");

  const html = `<!DOCTYPE html>
<html lang="en">
  <head>
    <meta charset="UTF-8" />
    <meta http-equiv="Content-Security-Policy" content="${csp}" />
    <meta name="viewport" content="width=device-width, initial-scale=1.0" />
    <link rel="stylesheet" href="${katexStyleUri}" />
    <link rel="stylesheet" href="${styleUri}" />
  </head>
  <body data-mux-trace-id="${traceId}">
    <div id="root"></div>
    <script nonce="${nonce}" type="module" src="${scriptUri}"></script>
  </body>
</html>`;

  const htmlHash = createHash("sha256").update(html).digest("hex").slice(0, 12);
  xumLogDebug("mux.chatView: renderChatViewHtml", {
    traceId,
    scriptUri: scriptUri.toString(),
    styleUri: styleUri.toString(),
    katexStyleUri: katexStyleUri.toString(),
    cspSource: webview.cspSource,
    nonceLength: nonce.length,
    noncePreview: nonce.slice(0, 8),
    htmlLength: html.length,
    htmlHash,
    csp,
  });

  return html;
}

class XumChatViewProvider implements vscode.WebviewViewProvider, vscode.Disposable {
  private view: vscode.WebviewView | undefined;

  private nextWebviewMessageSeq = 1;

  private traceId: string | null = null;

  private readyProbeInterval: ReturnType<typeof setInterval> | null = null;
  private readyProbeTimeouts: Array<ReturnType<typeof setTimeout>> = [];
  private isWebviewReady = false;

  private connectionStatus: UiConnectionStatus = { mode: "file" };
  private workspaces: WorkspaceWithContext[] = [];
  private workspacesById = new Map<string, WorkspaceWithContext>();

  private refreshWorkspacesGeneration = 0;

  private selectedWorkspaceId: string | null;

  private pendingOrpcCalls = new Map<string, AbortController>();
  private activeOrpcStreams = new Map<
    string,
    {
      controller: AbortController;
      iterator: AsyncIterator<unknown>;
    }
  >();
  private subscribedWorkspaceId: string | null = null;
  private subscriptionAbort: AbortController | null = null;

  constructor(private readonly context: vscode.ExtensionContext) {
    this.selectedWorkspaceId =
      context.workspaceState.get<string>(SELECTED_WORKSPACE_STATE_KEY) ?? null;
  }

  private clearReadyProbeInterval(): void {
    if (this.readyProbeInterval) {
      clearInterval(this.readyProbeInterval);
      this.readyProbeInterval = null;
    }

    for (const timeoutId of this.readyProbeTimeouts) {
      clearTimeout(timeoutId);
    }
    this.readyProbeTimeouts = [];
  }

  dispose(): void {
    this.clearReadyProbeInterval();

    this.subscriptionAbort?.abort();
    this.subscriptionAbort = null;
    this.subscribedWorkspaceId = null;

    for (const controller of this.pendingOrpcCalls.values()) {
      controller.abort();
    }
    this.pendingOrpcCalls.clear();

    for (const [streamId, stream] of this.activeOrpcStreams.entries()) {
      stream.controller.abort();
      // Best-effort: allow the iterator to clean up server-side.
      void stream.iterator.return?.().catch((error) => {
        xumLogWarn("mux.chatView: stream iterator return failed during dispose", {
          streamId,
          error: formatError(error),
        });
      });
    }
    this.activeOrpcStreams.clear();
  }

  async setSelectedWorkspaceId(workspaceId: string | null): Promise<void> {
    if (workspaceId !== null) {
      assert(typeof workspaceId === "string", "workspaceId must be string or null");
    }

    if (workspaceId === this.selectedWorkspaceId) {
      this.postMessage({ type: "setSelectedWorkspace", workspaceId });
      await this.updateChatSubscription();
      return;
    }

    this.selectedWorkspaceId = workspaceId;
    await this.context.workspaceState.update(
      SELECTED_WORKSPACE_STATE_KEY,
      workspaceId ? workspaceId : undefined
    );

    this.postMessage({ type: "setSelectedWorkspace", workspaceId });
    await this.updateChatSubscription();
  }

  resolveWebviewView(view: vscode.WebviewView): void {
    xumLogDebug("mux.chatView: resolveWebviewView", { visible: view.visible });

    // New view instance; clear any previous timers.
    this.clearReadyProbeInterval();

    this.traceId = randomBytes(8).toString("hex");
    xumLogDebug("mux.chatView: traceId assigned", { traceId: this.traceId });

    this.view = view;
    this.isWebviewReady = false;

    const viewDisposables: vscode.Disposable[] = [];

    try {
      view.webview.options = {
        enableScripts: true,
        localResourceRoots: [
          vscode.Uri.joinPath(this.context.extensionUri, "out"),
          vscode.Uri.joinPath(this.context.extensionUri, "media"),
        ],
      };

      xumLogDebug("mux.chatView: webview.options set", {
        enableScripts: view.webview.options.enableScripts ?? false,
        localResourceRoots: (view.webview.options.localResourceRoots ?? []).map((uri) =>
          uri.toString()
        ),
      });

      const visibilityDisposable = view.onDidChangeVisibility(async () => {
        xumLogDebug("mux.chatView: view visibility changed", { visible: view.visible });

        if (!view.visible) {
          return;
        }

        if (!this.isWebviewReady) {
          return;
        }

        await this.refreshWorkspaces();
      });
      viewDisposables.push(visibilityDisposable);

      // Register the message handler before setting HTML to avoid losing the initial
      // "ready" handshake due to a race.
      const messageDisposable = view.webview.onDidReceiveMessage((msg: unknown) => {
        const msgType =
          typeof msg === "object" &&
          msg !== null &&
          "type" in msg &&
          typeof (msg as { type?: unknown }).type === "string"
            ? (msg as { type: string }).type
            : undefined;

        const meta =
          typeof msg === "object" && msg !== null && "__muxMeta" in msg
            ? (msg as { __muxMeta?: unknown }).__muxMeta
            : undefined;

        xumLogDebug("mux.chatView: <- webview message", {
          traceId: this.traceId,
          type: msgType,
          meta,
        });

        void this.onWebviewMessage(msg).catch((error) => {
          xumLogError("mux.chatView: error handling webview message", {
            error: formatError(error),
          });
          console.error("mux.chatView: error handling webview message", error);
          this.postMessage({
            type: "uiNotice",
            level: "error",
            message: `Webview message error: ${formatError(error)}`,
          });
        });
      });
      viewDisposables.push(messageDisposable);

      view.onDidDispose(() => {
        xumLogDebug("mux.chatView: disposed");
        visibilityDisposable.dispose();
        messageDisposable.dispose();
        this.traceId = null;
        this.view = undefined;
        this.isWebviewReady = false;
        this.dispose();
      });

      const traceId = this.traceId;
      assert(
        typeof traceId === "string" && traceId.length > 0,
        "mux.chatView: traceId must be set before rendering webview"
      );

      const html = renderChatViewHtml(view.webview, this.context.extensionUri, traceId);
      xumLogDebug("mux.chatView: setting webview.html", { traceId, htmlLength: html.length });
      view.webview.html = html;

      // While debugging the stuck "Loading mux..." state, this sends a message to the webview
      // at a fixed interval until we get a "ready" message back.
      let probeAttempts = 0;
      this.readyProbeInterval = setInterval(() => {
        if (this.view !== view) {
          xumLogDebug("mux.chatView: stopping debugProbe (view changed)");
          this.clearReadyProbeInterval();
          return;
        }

        if (this.isWebviewReady) {
          xumLogDebug("mux.chatView: stopping debugProbe (ready received)");
          this.clearReadyProbeInterval();
          return;
        }

        probeAttempts += 1;
        const attempt = probeAttempts;
        const sentAtMs = Date.now();

        void view.webview.postMessage({ type: "debugProbe", attempt, sentAtMs }).then(
          (delivered) => {
            xumLogDebug("mux.chatView: -> debugProbe", {
              traceId: this.traceId,
              attempt,
              delivered,
            });
          },
          (error) => {
            xumLogWarn("mux.chatView: debugProbe postMessage failed", {
              traceId: this.traceId,
              attempt,
              error: formatError(error),
            });
          }
        );

        if (attempt >= 15) {
          xumLogWarn("mux.chatView: stopping debugProbe after max attempts", {
            maxAttempts: attempt,
          });
          this.clearReadyProbeInterval();
        }
      }, 1_000);

      const readyWarnTimeout = setTimeout(() => {
        if (this.view !== view) {
          return;
        }

        if (this.isWebviewReady) {
          return;
        }

        xumLogWarn("mux.chatView: webview has not sent ready after 2s", {
          traceId: this.traceId,
          visible: view.visible,
          cspSource: view.webview.cspSource,
          hint: "Open Webview Developer Tools and look for CSP/script errors; also check Output > Xum.",
        });
      }, 2_000);
      this.readyProbeTimeouts.push(readyWarnTimeout);

      const readyErrorTimeout = setTimeout(() => {
        if (this.view !== view) {
          return;
        }

        if (this.isWebviewReady) {
          return;
        }

        xumLogError("mux.chatView: webview has not sent ready after 10s", {
          traceId: this.traceId,
          visible: view.visible,
          cspSource: view.webview.cspSource,
          hint: "Open Webview Developer Tools and look for CSP/script errors; also check Output > Xum.",
        });
      }, 10_000);
      this.readyProbeTimeouts.push(readyErrorTimeout);
    } catch (error) {
      xumLogError("mux.chatView: resolveWebviewView failed", {
        traceId: this.traceId,
        error: formatError(error),
      });

      for (const disposable of viewDisposables) {
        disposable.dispose();
      }

      if (this.view === view) {
        this.view = undefined;
      }
      this.traceId = null;
      this.isWebviewReady = false;
      this.dispose();

      // Best-effort: show something in the UI even if the React bundle fails to load.
      try {
        view.webview.html =
          '<!DOCTYPE html><html lang="en"><body><h3>Failed to load xum chat view</h3><p>Check Output > Xum for details.</p></body></html>';
      } catch {
        // Ignore - best effort only.
      }
    }
  }

  private postMessage(message: ExtensionToWebviewMessage): void {
    const shouldLog = message.type !== "chatEvent" && message.type !== "orpcStreamData";

    if (!this.view) {
      if (shouldLog) {
        xumLogDebug("mux.chatView: -> drop postMessage (no view)", {
          traceId: this.traceId,
          type: message.type,
        });
      }
      return;
    }

    if (!this.isWebviewReady) {
      if (shouldLog) {
        xumLogDebug("mux.chatView: -> drop postMessage (webview not ready)", {
          traceId: this.traceId,
          type: message.type,
        });
      }
      return;
    }

    const seq = this.nextWebviewMessageSeq++;
    const meta = {
      traceId: this.traceId,
      seq,
      sentAtMs: Date.now(),
    };

    const envelope: Record<string, unknown> = { __muxMeta: meta, ...message };

    void this.view.webview.postMessage(envelope).then(
      (delivered) => {
        if (shouldLog) {
          xumLogDebug("mux.chatView: -> postMessage", {
            traceId: this.traceId,
            seq,
            type: message.type,
            delivered,
          });
        }
      },
      (error) => {
        xumLogWarn("mux.chatView: postMessage failed", {
          traceId: this.traceId,
          seq,
          type: message.type,
          error: formatError(error),
        });
      }
    );
  }

  private async onWebviewMessage(raw: unknown): Promise<void> {
    const msg = parseWebviewToExtensionMessage(raw);
    if (!msg) {
      return;
    }

    switch (msg.type) {
      case "debugLog":
        xumLogDebug(`mux.chatView(webview): ${msg.message}`, msg.data);
        return;

      case "copyDebugLog": {
        const text = msg.text;
        xumLogInfo("mux.chatView: copyDebugLog requested", {
          traceId: this.traceId,
          length: text.length,
        });

        await vscode.env.clipboard.writeText(text);
        this.postMessage({
          type: "uiNotice",
          level: "info",
          message: "Copied xum debug log to clipboard.",
        });
        return;
      }

      case "orpcCall": {
        if (this.pendingOrpcCalls.has(msg.requestId)) {
          this.postMessage({
            type: "orpcResponse",
            requestId: msg.requestId,
            ok: false,
            error: "Duplicate ORPC requestId",
          });
          return;
        }

        const controller = new AbortController();
        this.pendingOrpcCalls.set(msg.requestId, controller);

        await this.handleOrpcCall({
          requestId: msg.requestId,
          path: msg.path,
          input: msg.input,
          lastEventId: msg.lastEventId,
          controller,
        });
        return;
      }

      case "orpcCancel":
        this.handleOrpcCancel(msg.requestId);
        return;

      case "orpcStreamCancel":
        this.handleOrpcStreamCancel(msg.streamId);
        return;

      case "ready":
        xumLogDebug("mux.chatView: ready handshake received", { traceId: this.traceId });
        this.isWebviewReady = true;
        this.clearReadyProbeInterval();

        // Ensure the webview knows the currently selected workspace before we start
        // streaming chatReset/chatEvent messages for it.
        this.postMessage({ type: "setSelectedWorkspace", workspaceId: this.selectedWorkspaceId });

        await this.refreshWorkspaces();
        return;

      case "refreshWorkspaces":
        await this.refreshWorkspaces();
        return;

      case "selectWorkspace":
        await this.setSelectedWorkspaceId(msg.workspaceId);
        return;

      case "openWorkspace":
        await this.openWorkspaceFromView(msg.workspaceId);
        return;

      case "configureConnection":
        await configureConnectionCommand(this.context);
        await this.refreshWorkspaces();
        return;
    }
  }

  private async refreshWorkspaces(): Promise<void> {
    const startedAt = Date.now();
    const generation = ++this.refreshWorkspacesGeneration;
    xumLogDebug("mux.chatView: refreshWorkspaces start", { traceId: this.traceId, generation });

    try {
      const result = await getWorkspacesForSidebar(this.context);

      if (generation !== this.refreshWorkspacesGeneration) {
        xumLogDebug("mux.chatView: refreshWorkspaces stale result discarded", {
          traceId: this.traceId,
          generation,
        });
        return;
      }

      this.connectionStatus = result.status;
      this.workspaces = result.workspaces;
      this.workspacesById = new Map(this.workspaces.map((w) => [w.id, w]));

      this.postMessage({ type: "connectionStatus", status: this.connectionStatus });
      this.postMessage({ type: "workspaces", workspaces: this.workspaces.map(toUiWorkspace) });

      if (this.selectedWorkspaceId && !this.workspacesById.has(this.selectedWorkspaceId)) {
        await this.setSelectedWorkspaceId(null);
      }

      // Intentionally do not auto-select a workspace; the user must explicitly choose one.
      await this.updateChatSubscription();

      xumLogDebug("mux.chatView: refreshWorkspaces done", {
        traceId: this.traceId,
        durationMs: Date.now() - startedAt,
        workspaceCount: this.workspaces.length,
        connectionMode: this.connectionStatus.mode,
        hasError: Boolean(this.connectionStatus.error),
      });
    } catch (error) {
      xumLogError("mux.chatView: refreshWorkspaces failed", {
        traceId: this.traceId,
        durationMs: Date.now() - startedAt,
        error: formatError(error),
      });

      const message = `Failed to load xum workspaces. (${formatError(error)})`;

      this.connectionStatus = { mode: "file", error: message };
      this.workspaces = [];
      this.workspacesById = new Map();

      this.subscriptionAbort?.abort();
      this.subscriptionAbort = null;
      this.subscribedWorkspaceId = null;

      this.selectedWorkspaceId = null;
      await this.context.workspaceState.update(SELECTED_WORKSPACE_STATE_KEY, undefined);

      this.postMessage({ type: "connectionStatus", status: this.connectionStatus });
      this.postMessage({ type: "workspaces", workspaces: [] });
      this.postMessage({ type: "setSelectedWorkspace", workspaceId: null });
      this.postMessage({ type: "uiNotice", level: "error", message });
    }
  }

  private resolveOrpcProcedure(
    client: unknown,
    path: string[]
  ): ((input: unknown, options?: unknown) => Promise<unknown>) | null {
    let cursor: unknown = client;

    for (const segment of path) {
      if (segment === "__proto__" || segment === "prototype" || segment === "constructor") {
        return null;
      }

      if (!cursor || (typeof cursor !== "object" && typeof cursor !== "function")) {
        return null;
      }

      cursor = (cursor as Record<string, unknown>)[segment];
    }

    if (typeof cursor !== "function") {
      return null;
    }

    return cursor as (input: unknown, options?: unknown) => Promise<unknown>;
  }

  private handleOrpcCancel(requestId: string): void {
    const controller = this.pendingOrpcCalls.get(requestId);
    if (!controller) {
      return;
    }

    controller.abort();
    this.pendingOrpcCalls.delete(requestId);
  }

  private handleOrpcStreamCancel(streamId: string): void {
    const stream = this.activeOrpcStreams.get(streamId);
    if (!stream) {
      return;
    }

    stream.controller.abort();
    this.activeOrpcStreams.delete(streamId);

    void stream.iterator.return?.().catch((error) => {
      xumLogWarn("mux.chatView: stream iterator return failed", {
        streamId,
        error: formatError(error),
      });
    });
  }

  private isAsyncIterable(value: unknown): value is AsyncIterable<unknown> {
    return Boolean(
      value &&
      typeof value === "object" &&
      Symbol.asyncIterator in value &&
      typeof (value as { [Symbol.asyncIterator]?: unknown })[Symbol.asyncIterator] === "function"
    );
  }

  private async pumpOrpcStream(
    streamId: string,
    iterator: AsyncIterator<unknown>,
    controller: AbortController
  ): Promise<void> {
    try {
      for await (const value of {
        [Symbol.asyncIterator]() {
          return iterator;
        },
      } as AsyncIterable<unknown>) {
        if (controller.signal.aborted) {
          break;
        }

        this.postMessage({
          type: "orpcStreamData",
          streamId,
          value,
        });
      }

      this.postMessage({
        type: "orpcStreamEnd",
        streamId,
      });
    } catch (error) {
      if (controller.signal.aborted) {
        this.postMessage({
          type: "orpcStreamEnd",
          streamId,
        });
        return;
      }

      this.postMessage({
        type: "orpcStreamError",
        streamId,
        error: formatError(error),
      });
    } finally {
      this.activeOrpcStreams.delete(streamId);
    }
  }

  private async handleOrpcCall(args: {
    requestId: string;
    path: string[];
    input: unknown;
    lastEventId?: string | undefined;
    controller: AbortController;
  }): Promise<void> {
    const controller = args.controller;

    try {
      if (!isAllowedOrpcPath(args.path)) {
        this.postMessage({
          type: "orpcResponse",
          requestId: args.requestId,
          ok: false,
          error: `ORPC path not allowed: ${args.path.join(".")}`,
        });
        return;
      }

      if (this.connectionStatus.mode !== "api") {
        this.postMessage({
          type: "orpcResponse",
          requestId: args.requestId,
          ok: false,
          error: "xum server connection required",
        });
        return;
      }

      if (controller.signal.aborted) {
        return;
      }

      const api = await tryGetApiClient(this.context);

      if (controller.signal.aborted) {
        return;
      }

      if ("failure" in api) {
        this.postMessage({
          type: "orpcResponse",
          requestId: args.requestId,
          ok: false,
          error: `${describeFailure(api.failure)}. (${api.failure.error})`,
        });
        return;
      }

      const procedure = this.resolveOrpcProcedure(api.client, args.path);
      if (!procedure) {
        this.postMessage({
          type: "orpcResponse",
          requestId: args.requestId,
          ok: false,
          error: `Unknown ORPC procedure: ${args.path.join(".")}`,
        });
        return;
      }

      const result = await procedure(args.input, {
        signal: controller.signal,
        lastEventId: args.lastEventId,
      });

      if (controller.signal.aborted) {
        return;
      }

      if (this.isAsyncIterable(result)) {
        const streamId = randomBytes(16).toString("hex");
        const iterator = result[Symbol.asyncIterator]();

        this.activeOrpcStreams.set(streamId, {
          controller,
          iterator,
        });

        this.postMessage({
          type: "orpcResponse",
          requestId: args.requestId,
          ok: true,
          kind: "stream",
          streamId,
        });

        void this.pumpOrpcStream(streamId, iterator, controller);
        return;
      }

      this.postMessage({
        type: "orpcResponse",
        requestId: args.requestId,
        ok: true,
        kind: "value",
        value: result,
      });
    } catch (error) {
      if (controller.signal.aborted) {
        return;
      }

      this.postMessage({
        type: "orpcResponse",
        requestId: args.requestId,
        ok: false,
        error: formatError(error),
      });
    } finally {
      const pending = this.pendingOrpcCalls.get(args.requestId);
      if (pending === controller) {
        this.pendingOrpcCalls.delete(args.requestId);
      }
    }
  }

  private async updateChatSubscription(): Promise<void> {
    if (!this.isWebviewReady || !this.view) {
      return;
    }

    const workspaceId = this.selectedWorkspaceId;
    if (!workspaceId || this.connectionStatus.mode !== "api") {
      this.subscriptionAbort?.abort();
      this.subscriptionAbort = null;
      this.subscribedWorkspaceId = null;
      return;
    }

    if (
      this.subscribedWorkspaceId === workspaceId &&
      this.subscriptionAbort &&
      !this.subscriptionAbort.signal.aborted
    ) {
      return;
    }

    this.subscriptionAbort?.abort();

    const controller = new AbortController();
    this.subscriptionAbort = controller;
    this.subscribedWorkspaceId = workspaceId;

    this.postMessage({ type: "chatReset", workspaceId });

    const api = await tryGetApiClient(this.context);
    if ("failure" in api) {
      // Drop back to file mode (chat disabled).
      this.connectionStatus = {
        mode: "file",
        baseUrl: api.failure.baseUrl,
        error: `${describeFailure(api.failure)}. (${api.failure.error})`,
      };
      this.postMessage({ type: "connectionStatus", status: this.connectionStatus });
      this.postMessage({
        type: "uiNotice",
        level: "error",
        message: this.connectionStatus.error ?? "xum server unavailable",
      });

      controller.abort();
      if (this.subscriptionAbort === controller) {
        this.subscriptionAbort = null;
        this.subscribedWorkspaceId = null;
      }
      return;
    }

    try {
      const iterator = await api.client.workspace.onChat(
        { workspaceId },
        { signal: controller.signal }
      );

      for await (const event of iterator) {
        if (controller.signal.aborted) {
          return;
        }

        // Defensive: selection could change without abort (rare race).
        if (this.selectedWorkspaceId !== workspaceId) {
          return;
        }

        this.postMessage({ type: "chatEvent", workspaceId, event });
      }
    } catch (error) {
      if (controller.signal.aborted) {
        return;
      }

      this.postMessage({
        type: "uiNotice",
        level: "error",
        message: `Chat subscription error: ${formatError(error)}`,
      });
    } finally {
      if (this.subscriptionAbort === controller) {
        this.subscriptionAbort = null;
        this.subscribedWorkspaceId = null;
      }
    }
  }

  private async openWorkspaceFromView(workspaceId: string): Promise<void> {
    assert(typeof workspaceId === "string", "openWorkspaceFromView requires workspaceId");

    const workspace = this.workspacesById.get(workspaceId);
    if (!workspace) {
      this.postMessage({
        type: "uiNotice",
        level: "error",
        message: "Workspace not found. Refresh and try again.",
      });
      return;
    }

    await setPendingAutoSelectWorkspace(this.context, workspace);
    await openWorkspace(workspace);
  }
}

async function maybeAutoRevealChatViewFromPendingSelection(
  context: vscode.ExtensionContext,
  provider: XumChatViewProvider
): Promise<void> {
  const pending = await getPendingAutoSelectWorkspace(context);
  if (!pending) {
    return;
  }

  const folderUri = getPrimaryWorkspaceFolderUri();
  if (!folderUri) {
    return;
  }

  if (folderUri.toString() !== pending.expectedWorkspaceUri) {
    return;
  }

  await clearPendingAutoSelectWorkspace(context);
  await provider.setSelectedWorkspaceId(pending.workspaceId);
  await revealChatView();
}

/**
 * Activate the extension
 */
export async function activate(context: vscode.ExtensionContext): Promise<void> {
  xumLogInfo("xum: activate", {
    connectionMode: getConnectionModeSetting(),
    workspaceFolder: vscode.workspace.workspaceFolders?.[0]?.uri.toString() ?? null,
  });

  const chatViewProvider = new XumChatViewProvider(context);

  context.subscriptions.push(chatViewProvider);
  context.subscriptions.push(
    vscode.window.registerWebviewViewProvider("mux.chatView", chatViewProvider, {
      webviewOptions: {
        retainContextWhenHidden: true,
      },
    })
  );

  context.subscriptions.push(
    vscode.commands.registerCommand("mux.openWorkspace", () =>
      openWorkspaceCommand(context, { chatViewProvider: chatViewProvider })
    )
  );

  context.subscriptions.push(
    vscode.commands.registerCommand("mux.configureConnection", () =>
      configureConnectionCommand(context)
    )
  );

  context.subscriptions.push(
    vscode.commands.registerCommand("mux.debugConnection", () => debugConnectionCommand(context))
  );

  await maybeAutoRevealChatViewFromPendingSelection(context, chatViewProvider);
}

/**
 * Deactivate the extension
 */
export function deactivate() {}

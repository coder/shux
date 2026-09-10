import { readPersistedState } from "@/browser/hooks/usePersistedState";
import { REMOTE_CONNECTION_EDITOR_FRAME_NAME_PREFIX } from "@/common/constants/remoteConnection";
import {
  getEditorDeepLink,
  getDockerDeepLink,
  getDevcontainerDeepLink,
  isLocalhost,
  type DeepLinkEditor,
} from "@/browser/utils/editorDeepLinks";
import {
  DEFAULT_EDITOR_CONFIG,
  EDITOR_CONFIG_KEY,
  normalizeEditorConfig,
  type EditorConfig,
} from "@/common/constants/storage";
import type { RuntimeConfig } from "@/common/types/runtime";
import { isSSHRuntime, isDockerRuntime, isDevcontainerRuntime } from "@/common/types/runtime";
import type { APIClient } from "@/browser/contexts/API";

export interface OpenInEditorResult {
  success: boolean;
  error?: string;
}

// Browser mode: window.api is not set (only exists in Electron via preload). Evaluated at
// call time so tests can install a window; in production the preload bridge exists before
// any renderer code runs, so this is equivalent to a load-time constant.
function isBrowserModeNow(): boolean {
  return typeof window !== "undefined" && !window.api;
}

// Helper for opening URLs - allows testing in Node environment
function openUrl(url: string): void {
  if (typeof window !== "undefined" && window.open) {
    window.open(url, "_blank");
  }
}

function trimTrailingSlash(path: string): string {
  return path.length > 1 && path.endsWith("/") ? path.slice(0, -1) : path;
}

// Guarded token generator (mirrors createLayoutPresetId/createHeaderRowId): Crypto.randomUUID
// exists only in secure contexts, and Xum's browser UI can be served from a plain-HTTP remote
// origin. Throwing here would reject every built-in editor open before the recording RPC's
// try/catch; the fallback distinguishes placeholder frames and each launch's rollback.
function createEditorLaunchToken(): string {
  const maybeCrypto = globalThis.crypto;
  if (maybeCrypto && typeof maybeCrypto.randomUUID === "function") {
    return maybeCrypto.randomUUID();
  }
  return `editor_launch_${Date.now()}_${Math.random().toString(16).slice(2)}`;
}

function isAbsolutePath(path: string): boolean {
  return path.startsWith("/") || /^[A-Za-z]:[\\/]/.test(path);
}

function normalizePathSeparators(path: string): string {
  return path.replace(/\\/g, "/");
}

function mapHostPathToContainerPath(options: {
  hostWorkspacePath: string;
  containerWorkspacePath: string;
  targetPath: string;
}): string {
  // Normalize backslashes for Windows compatibility
  const hostWorkspacePath = trimTrailingSlash(normalizePathSeparators(options.hostWorkspacePath));
  const containerWorkspacePath = trimTrailingSlash(options.containerWorkspacePath);
  const targetPath = trimTrailingSlash(normalizePathSeparators(options.targetPath));

  if (targetPath === hostWorkspacePath) {
    return containerWorkspacePath || "/";
  }

  const prefix = `${hostWorkspacePath}/`;
  if (targetPath.startsWith(prefix)) {
    const relative = targetPath.slice(hostWorkspacePath.length);
    if (!relative) {
      return containerWorkspacePath || "/";
    }

    if (containerWorkspacePath === "/") {
      return relative;
    }

    return `${containerWorkspacePath}${relative}`;
  }

  return containerWorkspacePath || "/";
}

/**
 * Get parent directory from a path.
 */
function getParentDirectory(path: string): string {
  const lastSlash = path.lastIndexOf("/");
  const isRootLevelPath = lastSlash === 0; // e.g., /file.txt at root
  return isRootLevelPath ? "/" : path.substring(0, lastSlash) || "/";
}

interface OpenInEditorArgs {
  api: APIClient | null | undefined;
  openSettings?: (section?: string) => void;
  workspaceId: string;
  targetPath: string;
  runtimeConfig?: RuntimeConfig;
  /**
   * When true, indicates targetPath is a file.
   *
   * Some deep link formats (e.g. VS Code's Docker attached-container URI) can only
   * open folders/workspaces, so we fall back to opening the parent directory.
   */
  isFile?: boolean;
}

export async function openInEditor(args: OpenInEditorArgs): Promise<OpenInEditorResult> {
  const editorConfig = normalizeEditorConfig(
    readPersistedState<EditorConfig>(EDITOR_CONFIG_KEY, DEFAULT_EDITOR_CONFIG)
  );

  // Browser mode: window.open must run while the click's transient user activation is still
  // valid — the awaited backend lookups and the open-recording RPC below can outlast that
  // window, after which the deep link would be popup-blocked even though we would report
  // success and have persisted a durable editor-open marker. Open a blank placeholder
  // synchronously (before any await) and navigate it once admission succeeds; close it on
  // any refusal. If the placeholder itself is blocked, refuse now — before anything is
  // recorded — because the post-await fallback would be blocked too, silently: reporting
  // success then would persist a sticky editor-open marker for an editor that never opened,
  // permanently refusing model-driven snapshot/Coder-stop archives. Electron routes
  // window.open through the main-process window-open handler (no transient-activation
  // gating), and custom editors never deep-link, so neither needs a placeholder.
  let placeholder: Window | null = null;
  if (isBrowserModeNow() && editorConfig.editor !== "custom") {
    try {
      // Remote wrappers reject this frame before recording.
      // Unique names prevent ordinary browsers from reusing a previous editor window.
      const frameName = `${REMOTE_CONNECTION_EDITOR_FRAME_NAME_PREFIX}${createEditorLaunchToken()}`;
      placeholder =
        typeof window !== "undefined" && window.open ? window.open("about:blank", frameName) : null;
    } catch {
      placeholder = null;
    }
    if (placeholder == null) {
      return {
        success: false,
        error:
          "The browser blocked the editor window (popup blocked). Allow popups for this site and retry.",
      };
    }
  }
  let launched = false;

  // Record the open immediately before launching a deep link: external editors are
  // untrackable once open (deep links leave no process handle), so model-driven snapshot
  // archives consult this durable record — and an archive already in progress must refuse
  // the open. Called after every deterministic compatibility check so a refused open can
  // never persist a sticky marker that permanently gates future archives. Fail closed: a
  // transient client disconnect (api null while reconnecting) or a failed recording RPC
  // does not stop backend agents, so launching unrecorded would let a concurrent archive
  // remove the checkout under the new editor. Custom-editor opens are recorded by the
  // backend route instead.
  const recordOpenBeforeLaunch = async (): Promise<{ launchToken: string } | { error: string }> => {
    if (!args.api) {
      return {
        error:
          "Cannot open the editor while disconnected from Xum: the open must be recorded first so archive safety checks can see it. Retry once reconnected.",
      };
    }
    // Generated client-side BEFORE admission so it survives response loss: if the backend
    // commits the reservation but the connection drops before the response arrives, this
    // token is the only handle that can still redeem the rollback.
    const launchToken = createEditorLaunchToken();
    try {
      const recorded = await args.api.general.recordEditorOpen({
        workspaceId: args.workspaceId,
        launchToken,
      });
      if (!recorded.success) {
        return { error: recorded.error };
      }
      return { launchToken };
    } catch (error) {
      // Ambiguous outcome: the backend may have committed the reservation even though the
      // response was lost, and this open will not launch. Best-effort reconciliation with
      // the client-known token — an idempotent no-op if nothing was committed; if this
      // also fails, the durable marker stays (fail closed).
      try {
        await args.api.general.rollbackEditorOpen({
          workspaceId: args.workspaceId,
          launchToken,
        });
      } catch {
        // Fail closed.
      }
      return {
        error: `Cannot open the editor: recording the open failed (${error instanceof Error ? error.message : String(error)}), and archive safety checks depend on that record.`,
      };
    }
  };

  const placeholderClosedError =
    "The editor window was closed before the editor could open. Retry to reopen it.";
  // Read through a call so TypeScript cannot narrow the readonly `closed` across awaits —
  // the user can flip it at any time.
  const isPlaceholderClosed = (): boolean => placeholder?.closed === true;

  const recordThenLaunch = async (deepLink: string): Promise<OpenInEditorResult> => {
    // The user can close the blank placeholder during any await that ran before this point
    // (devcontainer/SSH discovery); refuse before recording so no marker needs rolling back.
    if (isPlaceholderClosed()) {
      return { success: false, error: placeholderClosedError };
    }
    const admission = await recordOpenBeforeLaunch();
    if ("error" in admission) {
      return { success: false, error: admission.error };
    }
    // Closed while the recording RPC was awaiting: navigating the dead WindowProxy would be
    // silently ignored, so no editor can open — redeem the launch token to roll the durable
    // marker back (best-effort: a failed rollback keeps the sticky marker, fail closed).
    if (isPlaceholderClosed()) {
      try {
        await args.api?.general.rollbackEditorOpen({
          workspaceId: args.workspaceId,
          launchToken: admission.launchToken,
        });
      } catch {
        // Fail closed: the marker stays until the next successful open or restart.
      }
      return { success: false, error: placeholderClosedError };
    }
    launched = true;
    if (placeholder != null) {
      placeholder.location.href = deepLink;
    } else {
      // Electron: no placeholder was needed.
      openUrl(deepLink);
    }
    return { success: true };
  };

  try {
    return await openInEditorWithLaunch(args, editorConfig, recordThenLaunch);
  } finally {
    if (placeholder != null && !launched) {
      placeholder.close();
    }
  }
}

async function openInEditorWithLaunch(
  args: OpenInEditorArgs,
  editorConfig: EditorConfig,
  launch: (deepLink: string) => Promise<OpenInEditorResult>
): Promise<OpenInEditorResult> {
  const isSSH = isSSHRuntime(args.runtimeConfig);
  const isDocker = isDockerRuntime(args.runtimeConfig);

  // For custom editor with no command configured, open settings (if available)
  if (editorConfig.editor === "custom" && !editorConfig.customCommand) {
    args.openSettings?.("general");
    return { success: false, error: "Please configure a custom editor command in Settings" };
  }

  // For SSH workspaces, validate the editor supports SSH connections
  if (isSSH) {
    if (editorConfig.editor === "custom") {
      return {
        success: false,
        error: "Custom editors do not support SSH connections for SSH workspaces",
      };
    }
  }

  // Docker workspaces always use deep links (VS Code connects to container remotely)
  if (isDocker && args.runtimeConfig?.type === "docker") {
    if (editorConfig.editor === "zed") {
      return { success: false, error: "Zed does not support Docker containers" };
    }
    if (editorConfig.editor === "custom") {
      return { success: false, error: "Custom editors do not support Docker containers" };
    }

    const containerName = args.runtimeConfig.containerName;
    if (!containerName) {
      return {
        success: false,
        error: "Container name not available. Try reopening the workspace.",
      };
    }

    // VS Code's attached-container URI scheme only supports opening folders as workspaces,
    // not individual files. Open the parent directory so the file is visible in the file tree.
    const targetDir = args.isFile ? getParentDirectory(args.targetPath) : args.targetPath;
    const deepLink = getDockerDeepLink({
      editor: editorConfig.editor as DeepLinkEditor,
      containerName,
      path: targetDir,
    });

    if (!deepLink) {
      return { success: false, error: `${editorConfig.editor} does not support Docker containers` };
    }

    return launch(deepLink);
  }

  // Devcontainer workspaces use deep links with container info from backend
  const isDevcontainer = isDevcontainerRuntime(args.runtimeConfig);
  if (isDevcontainer && args.runtimeConfig?.type === "devcontainer") {
    if (editorConfig.editor === "zed") {
      return { success: false, error: "Zed does not support Dev Containers" };
    }
    if (editorConfig.editor === "custom") {
      return { success: false, error: "Custom editors do not support Dev Containers" };
    }

    // Fetch container info from backend (on-demand discovery)
    const info = await args.api?.workspace.getDevcontainerInfo({ workspaceId: args.workspaceId });
    if (!info) {
      return {
        success: false,
        error: "Dev Container not running. Try reopening the workspace.",
      };
    }

    // VS Code's dev-container URI scheme only supports opening folders as workspaces,
    // not individual files. Open the parent directory so the file is visible in the file tree.
    const normalizedTargetPath = normalizePathSeparators(args.targetPath);
    const targetDir = args.isFile ? getParentDirectory(normalizedTargetPath) : normalizedTargetPath;

    const hostWorkspacePath = trimTrailingSlash(info.hostWorkspacePath);
    const containerPath = mapHostPathToContainerPath({
      hostWorkspacePath,
      containerWorkspacePath: info.containerWorkspacePath,
      targetPath: targetDir,
    });

    // Build the config file path if available
    const configFilePath = args.runtimeConfig.configPath
      ? isAbsolutePath(args.runtimeConfig.configPath)
        ? args.runtimeConfig.configPath
        : `${hostWorkspacePath}/${args.runtimeConfig.configPath}`
      : undefined;

    const deepLink = getDevcontainerDeepLink({
      editor: editorConfig.editor as DeepLinkEditor,
      containerName: info.containerName,
      hostPath: hostWorkspacePath,
      containerPath,
      configFilePath,
    });

    if (!deepLink) {
      return { success: false, error: `${editorConfig.editor} does not support Dev Containers` };
    }

    return launch(deepLink);
  }

  // VS Code / Cursor / Zed: always use deep links (works in browser + Electron)
  if (editorConfig.editor !== "custom") {
    // Determine SSH host for deep link
    let sshHost: string | undefined;
    if (isSSH && args.runtimeConfig?.type === "ssh") {
      // SSH workspace: use the configured SSH host
      sshHost = args.runtimeConfig.host;
      if (editorConfig.editor === "zed" && args.runtimeConfig.port != null) {
        sshHost = sshHost + ":" + args.runtimeConfig.port;
      }
    } else if (isBrowserModeNow() && !isLocalhost(window.location.hostname)) {
      // Remote server + local workspace: need SSH to reach server's files
      const serverSshHost = await args.api?.server.getSshHost();
      sshHost = serverSshHost ?? window.location.hostname;
    }
    // else: localhost access to local workspace → no SSH needed

    // VS Code/Cursor SSH deep links treat the path as a folder unless a line/column is present.
    const deepLink = getEditorDeepLink({
      editor: editorConfig.editor as DeepLinkEditor,
      path: args.targetPath,
      sshHost,
      line: args.isFile && sshHost ? 1 : undefined,
      column: args.isFile && sshHost ? 1 : undefined,
    });

    if (!deepLink) {
      return {
        success: false,
        error: `${editorConfig.editor} does not support SSH remote connections`,
      };
    }

    return launch(deepLink);
  }

  // Custom editor:
  // - Browser mode: can't spawn processes on the server
  // - Electron mode: spawn via backend API
  if (isBrowserModeNow()) {
    return {
      success: false,
      error: "Custom editors are not supported in browser mode. Use VS Code, Cursor, or Zed.",
    };
  }

  const result = await args.api?.general.openInEditor({
    workspaceId: args.workspaceId,
    targetPath: args.targetPath,
    editorConfig,
  });

  if (!result) {
    return { success: false, error: "API not available" };
  }

  if (!result.success) {
    return { success: false, error: result.error };
  }

  return { success: true };
}

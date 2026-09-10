/**
 * Editor deep link URL generation for browser mode.
 *
 * When running `xum server` and accessing via browser, we can't spawn editor
 * processes on the server. Instead, we generate deep link URLs that the browser
 * opens, triggering the user's locally installed editor.
 */

export type DeepLinkEditor = "vscode" | "cursor" | "zed";

export interface DeepLinkOptions {
  editor: DeepLinkEditor;
  path: string;
  sshHost?: string; // For SSH/remote workspaces
  line?: number;
  column?: number;
}

/**
 * Generate an editor deep link URL.
 *
 * @returns Deep link URL, or null if the editor doesn't support the requested config.
 */
export function getEditorDeepLink(options: DeepLinkOptions): string | null {
  const { editor, path, sshHost, line, column } = options;

  const scheme = editor; // vscode, cursor, zed all use their name as scheme

  if (sshHost) {
    // Zed remote-SSH deep links use a different format than VS Code/Cursor.
    // https://zed.dev/docs/remote-development
    if (editor === "zed") {
      let url = `${scheme}://ssh/${sshHost}${path}`;
      if (line != null) {
        url += `:${line}`;
        if (column != null) {
          url += `:${column}`;
        }
      }
      return url;
    }

    // VS Code/Cursor Remote-SSH format: vscode://vscode-remote/ssh-remote+host/path
    let url = `${scheme}://vscode-remote/ssh-remote+${encodeURIComponent(sshHost)}${path}`;
    if (line != null) {
      url += `:${line}`;
      if (column != null) {
        url += `:${column}`;
      }
    }
    return url;
  }

  // Local format: vscode://file/path
  //
  // Note: On Windows, callers may provide native paths like `C:\\Users\\...`.
  // VS Code/Cursor/Zed expect forward slashes and a leading `/` after `file`:
  //   vscode://file/C:/Users/...
  const normalizedPath = normalizeLocalPathForEditorDeepLink(path);

  let url = `${scheme}://file${normalizedPath}`;
  if (line != null) {
    url += `:${line}`;
    if (column != null) {
      url += `:${column}`;
    }
  }
  return url;
}

function normalizeContainerPathForDevcontainerDeepLink(path: string): string {
  const trimmed = path.trim();
  const unquoted =
    (trimmed.startsWith('"') && trimmed.endsWith('"')) ||
    (trimmed.startsWith("'") && trimmed.endsWith("'"))
      ? trimmed.slice(1, -1)
      : trimmed;

  const pathWithSlashes = unquoted.replace(/\\/g, "/");

  if (!pathWithSlashes) {
    return "/";
  }

  if (pathWithSlashes.startsWith("/")) {
    return pathWithSlashes;
  }

  return `/${pathWithSlashes}`;
}
function normalizeLocalPathForEditorDeepLink(path: string): string {
  const trimmed = path.trim();
  const unquoted =
    (trimmed.startsWith('"') && trimmed.endsWith('"')) ||
    (trimmed.startsWith("'") && trimmed.endsWith("'"))
      ? trimmed.slice(1, -1)
      : trimmed;

  const pathWithSlashes = unquoted.replace(/\\/g, "/");

  // Ensure the URL parses as `scheme://file/<path>`.
  if (pathWithSlashes.startsWith("/")) {
    return pathWithSlashes;
  }

  return `/${pathWithSlashes}`;
}

/**
 * Check if a hostname represents localhost.
 */
export function isLocalhost(hostname: string): boolean {
  return hostname === "localhost" || hostname === "127.0.0.1" || hostname === "::1";
}

/**
 * Convert a string to hex encoding (for VS Code remote URIs).
 */
function toHex(str: string): string {
  return Array.from(new TextEncoder().encode(str))
    .map((b) => b.toString(16).padStart(2, "0"))
    .join("");
}

/**
 * Generate a deep link URL to open a Docker container in VS Code/Cursor.
 * Uses the attached-container URI scheme.
 *
 * @returns Deep link URL, or null if the editor doesn't support Docker containers
 */
export function getDockerDeepLink(options: {
  editor: DeepLinkEditor;
  containerName: string;
  path: string;
}): string | null {
  const { editor, containerName, path } = options;

  // Only VS Code and Cursor support attached-container
  if (editor === "zed") {
    return null;
  }

  // Format: vscode-remote://attached-container+<hex_encoded_json>/<path>
  // The JSON must be: {"containerName":"/<container_name>"}
  // Use // before path to preserve leading / inside container
  const config = JSON.stringify({ containerName: `/${containerName}` });
  const hexConfig = toHex(config);
  return `${editor}://vscode-remote/attached-container+${hexConfig}/${path}`;
}

/**
 * Generate a deep link URL to open a devcontainer in VS Code/Cursor.
 * Uses the dev-container URI scheme with hex-encoded JSON config.
 *
 * @returns Deep link URL, or null if the editor doesn't support devcontainers
 */
export function getDevcontainerDeepLink(options: {
  editor: DeepLinkEditor;
  containerName: string;
  hostPath: string;
  containerPath: string;
  configFilePath?: string;
}): string | null {
  const { editor, containerName, hostPath, containerPath, configFilePath } = options;

  // Zed doesn't support devcontainers
  if (editor === "zed") {
    return null;
  }

  // VS Code dev-container URI format:
  // vscode://vscode-remote/dev-container+<hex_encoded_json>/<container_path>
  //
  // The JSON config contains:
  // - containerName: Docker container name with leading /
  // - hostPath: Path on the host machine to the workspace
  // - configFile: Optional devcontainer.json location
  // - localDocker: false (we're connecting to an existing container)
  const config: Record<string, unknown> = {
    containerName: `/${containerName}`,
    hostPath,
    localDocker: false,
  };

  if (configFilePath) {
    config.configFile = {
      path: configFilePath,
      scheme: "vscode-fileHost",
    };
  }

  const normalizedContainerPath = normalizeContainerPathForDevcontainerDeepLink(containerPath);
  const hexConfig = toHex(JSON.stringify(config));
  return `${editor}://vscode-remote/dev-container+${hexConfig}${normalizedContainerPath}`;
}

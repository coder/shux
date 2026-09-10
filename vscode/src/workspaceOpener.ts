import * as vscode from "vscode";
import { WorkspaceWithContext, getWorkspacePath } from "./xumConfig";

/**
 * Check if a Remote-SSH extension is installed
 * Supports both VS Code official and Anysphere (Cursor) Remote-SSH extensions
 */
function isRemoteSshInstalled(): boolean {
  return (
    vscode.extensions.getExtension("ms-vscode-remote.remote-ssh") !== undefined ||
    vscode.extensions.getExtension("anysphere.remote-ssh") !== undefined
  );
}

/**
 * Open an SSH workspace in a new VS Code window
 */
export async function openWorkspace(workspace: WorkspaceWithContext) {
  // Handle local runtimes: "local", "worktree", or legacy "local" with srcBaseDir
  if (workspace.runtimeConfig.type === "local" || workspace.runtimeConfig.type === "worktree") {
    const workspacePath = getWorkspacePath(workspace);
    const uri = vscode.Uri.file(workspacePath);

    await vscode.commands.executeCommand("vscode.openFolder", uri, {
      forceNewWindow: true,
    });
    return;
  }

  // Check if Remote-SSH is installed
  if (!isRemoteSshInstalled()) {
    const selection = await vscode.window.showErrorMessage(
      'xum: The "Remote - SSH" extension is required to open SSH workspaces. ' +
        "Please install it from the Extensions marketplace.",
      "Open Extensions"
    );

    if (selection === "Open Extensions") {
      // Search for the appropriate extension based on the editor
      const extensionId = vscode.env.appName.toLowerCase().includes("cursor")
        ? "anysphere.remote-ssh"
        : "ms-vscode-remote.remote-ssh";
      await vscode.commands.executeCommand("workbench.extensions.search", `@id:${extensionId}`);
    }
    return;
  }

  // At this point, it must be SSH (we handled local/worktree above)
  if (workspace.runtimeConfig.type !== "ssh") {
    // This should never happen given the early return above
    vscode.window.showErrorMessage("xum: Unknown workspace runtime type.");
    return;
  }

  const host = workspace.runtimeConfig.host;
  const remotePath = getWorkspacePath(workspace);

  // Format: vscode-remote://ssh-remote+<host><absolute-path>
  // Both ms-vscode-remote.remote-ssh and anysphere.remote-ssh use the same URI scheme
  // and vscode.openFolder command, so this works for both VS Code and Cursor
  const remoteUri = `vscode-remote://ssh-remote+${host}${remotePath}`;

  try {
    await vscode.commands.executeCommand("vscode.openFolder", vscode.Uri.parse(remoteUri), {
      forceNewWindow: true,
    });
  } catch (error) {
    const selection = await vscode.window.showErrorMessage(
      `xum: Failed to open SSH workspace on host "${host}". ` +
        `Make sure the host is configured in your ~/.ssh/config or in the Remote-SSH extension. ` +
        `Error: ${error instanceof Error ? error.message : String(error)}`,
      "Open SSH Config"
    );

    if (selection === "Open SSH Config") {
      await vscode.commands.executeCommand("remote-ssh.openConfigFile");
    }
  }
}

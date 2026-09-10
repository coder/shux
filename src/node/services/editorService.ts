import { spawn, spawnSync } from "child_process";
import * as fsPromises from "fs/promises";
import type { Config } from "@/node/config";
import type { WorkspaceService } from "@/node/services/workspaceService";
import { isDockerRuntime, isSSHRuntime, isDevcontainerRuntime } from "@/common/types/runtime";
import { log } from "@/node/services/log";
import { sanitizeXumChildEnv } from "@/node/runtime/childProcessEnv";
import { getErrorMessage } from "@/common/utils/errors";

/**
 * Quote a string for safe use in shell commands.
 *
 * IMPORTANT: Prefer spawning commands with an args array instead of building a
 * single shell string. This helper exists only for custom editor commands.
 */
function shellQuote(value: string): string {
  if (value.length === 0) return process.platform === "win32" ? '""' : "''";

  // cmd.exe: use double quotes (single quotes are treated as literal characters)
  if (process.platform === "win32") {
    return `"${value.replace(/"/g, '""')}"`;
  }

  // POSIX shells: single quotes with proper escaping for embedded single quotes.
  return "'" + value.replace(/'/g, "'\"'\"'") + "'";
}

function getExecutableFromShellCommand(command: string): string | null {
  const trimmed = command.trim();
  if (!trimmed) return null;

  const quote = trimmed[0];
  if (quote === '"' || quote === "'") {
    const endQuoteIndex = trimmed.indexOf(quote, 1);
    if (endQuoteIndex === -1) {
      return null;
    }
    return trimmed.slice(1, endQuoteIndex);
  }

  return trimmed.split(/\s+/)[0] ?? null;
}

function looksLikePath(command: string): boolean {
  return (
    command.startsWith("./") ||
    command.startsWith("../") ||
    command.includes("/") ||
    command.includes("\\") ||
    /^[A-Za-z]:/.test(command)
  );
}

export interface EditorConfig {
  editor: string;
  customCommand?: string;
}

export interface OpenInEditorInput {
  workspaceId: string;
  targetPath: string;
  editorConfig: EditorConfig;
}

type ExternalEditorOpenRecorder = Pick<WorkspaceService, "recordExternalEditorOpenForLaunch">;

/**
 * Service for opening workspaces in code editors.
 *
 * NOTE: VS Code/Cursor/Zed are opened via deep links in the renderer.
 * This service is only responsible for spawning the user's custom editor command.
 */
export class EditorService {
  constructor(
    private readonly config: Pick<Config, "getAllWorkspaceMetadata">,
    private readonly externalEditorOpenRecorder: ExternalEditorOpenRecorder
  ) {}

  async openInEditor(
    input: OpenInEditorInput
  ): Promise<{ success: true; data: void } | { success: false; error: string }> {
    // Detached editor processes cannot be tracked, so archive gating must record the open first.
    const recorded = await this.externalEditorOpenRecorder.recordExternalEditorOpenForLaunch(
      input.workspaceId
    );
    if (!recorded.success) {
      return recorded;
    }

    const result = await this.launchEditor(input);
    if (!result.success) {
      // Pre-spawn failures must not leave a marker that permanently blocks later archives.
      await recorded.data.rollbackAfterFailedLaunch();
    }
    return result;
  }

  private async launchEditor(
    input: OpenInEditorInput
  ): Promise<{ success: true; data: void } | { success: false; error: string }> {
    const { workspaceId, targetPath, editorConfig } = input;
    try {
      if (editorConfig.editor !== "custom") {
        return {
          success: false,
          error:
            "Built-in editors are opened via deep links. Select Custom editor to use a command.",
        };
      }

      const customCommand = editorConfig.customCommand?.trim();
      if (!customCommand) {
        return { success: false, error: "No editor command configured" };
      }

      const allMetadata = await this.config.getAllWorkspaceMetadata();
      const workspace = allMetadata.find((w) => w.id === workspaceId);

      if (!workspace) {
        return { success: false, error: `Workspace not found: ${workspaceId}` };
      }

      // Remote runtimes: custom commands run on the local machine and can't access remote paths.
      if (isSSHRuntime(workspace.runtimeConfig)) {
        return {
          success: false,
          error: "Custom editors do not support SSH connections for SSH workspaces",
        };
      }

      if (isDevcontainerRuntime(workspace.runtimeConfig)) {
        return { success: false, error: "Custom editors do not support Dev Containers" };
      }
      if (isDockerRuntime(workspace.runtimeConfig)) {
        return { success: false, error: "Custom editors do not support Docker containers" };
      }

      const executable = getExecutableFromShellCommand(customCommand);
      if (!executable) {
        return { success: false, error: `Invalid custom editor command: ${customCommand}` };
      }

      if (!(await this.isCommandAvailable(executable))) {
        return { success: false, error: `Editor command not found: ${executable}` };
      }

      // Local - expand tilde (shellQuote prevents shell expansion)
      const resolvedPath = targetPath.startsWith("~/")
        ? targetPath.replace("~", process.env.HOME ?? "~")
        : targetPath;

      const shellCmd = `${customCommand} ${shellQuote(resolvedPath)}`;
      log.info(`Opening local path in custom editor: ${shellCmd}`);
      const child = spawn(shellCmd, [], {
        detached: true,
        stdio: "ignore",
        shell: true,
        windowsHide: true,
        // Strip xum-internal vars (e.g. CHROME_DESKTOP, our Linux desktop
        // identity) so GUI editors don't inherit xum's window identity.
        // sanitizeXumChildEnv copies its input, so pass process.env directly.
        env: sanitizeXumChildEnv(process.env),
      });
      child.unref();

      return { success: true, data: undefined };
    } catch (err) {
      const message = getErrorMessage(err);
      log.error(`Failed to open in editor: ${message}`);
      return { success: false, error: message };
    }
  }

  /**
   * Check if a command is available in the system PATH.
   * Inherits enriched PATH from process.env (set by initShellEnv at startup).
   */
  private async isCommandAvailable(command: string): Promise<boolean> {
    try {
      if (looksLikePath(command)) {
        await fsPromises.access(command);
        return true;
      }

      const lookupCommand = process.platform === "win32" ? "where" : "which";
      const result = spawnSync(lookupCommand, [command], { encoding: "utf8" });
      return result.status === 0;
    } catch {
      return false;
    }
  }
}

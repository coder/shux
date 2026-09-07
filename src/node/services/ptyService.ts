/**
 * PTY Service - Manages terminal PTY sessions
 *
 * Handles local, SSH, SSH2, and Docker terminal sessions (node-pty + ssh2).
 * Uses callbacks for output/exit events to avoid circular dependencies.
 */

import { randomUUID } from "crypto";

import { log } from "@/node/services/log";
import type { Runtime } from "@/node/runtime/Runtime";
import type {
  TerminalSession,
  TerminalCreateParams,
  TerminalResizeParams,
} from "@/common/types/terminal";
import type { PtyHandle } from "@/node/runtime/transports";
import { spawnPtyProcess } from "@/node/runtime/ptySpawn";
import { SSHRuntime } from "@/node/runtime/SSHRuntime";
import { LocalBaseRuntime } from "@/node/runtime/LocalBaseRuntime";
import { resolveContainerCli } from "@/node/runtime/containerCli";
import { DockerRuntime } from "@/node/runtime/DockerRuntime";
import { DevcontainerRuntime } from "@/node/runtime/DevcontainerRuntime";
import { redactDevcontainerArgsForLog } from "@/node/runtime/devcontainerLogRedaction";
import type { RuntimeConfig } from "@/common/types/runtime";
import { access } from "fs/promises";
import { constants } from "fs";
import { resolveLocalPtyShell } from "@/node/utils/main/resolveLocalPtyShell";

function shellQuotePath(value: string): string {
  return `"${value.replace(/\\/g, "\\\\").replace(/"/g, '\\"')}"`;
}

interface SessionData {
  pty: PtyHandle;
  workspaceId: string;
  workspacePath: string;
  runtime: Runtime;
  runtimeLabel: string;
  onData: (data: string) => void;
  onExit: (exitCode: number) => void;
}

interface CreateSessionOptions {
  env?: NodeJS.ProcessEnv;
  /** User-configured default shell from config.json. */
  defaultShell?: string;
}

/**
 * Create a data handler that buffers incomplete escape sequences
 */
function createBufferedDataHandler(onData: (data: string) => void): (data: string) => void {
  let buffer = "";
  return (data: string) => {
    buffer += data;
    let sendUpTo = buffer.length;

    // Hold back incomplete escape sequences
    if (buffer.endsWith("\x1b")) {
      sendUpTo = buffer.length - 1;
    } else if (buffer.endsWith("\x1b[")) {
      sendUpTo = buffer.length - 2;
    } else {
      // eslint-disable-next-line no-control-regex, @typescript-eslint/prefer-regexp-exec
      const match = buffer.match(/\x1b\[[0-9;]*$/);
      if (match) {
        sendUpTo = buffer.length - match[0].length;
      }
    }

    if (sendUpTo > 0) {
      onData(buffer.substring(0, sendUpTo));
      buffer = buffer.substring(sendUpTo);
    }
  };
}

/**
 * PTYService - Manages terminal PTY sessions for workspaces
 *
 * Handles local, SSH, SSH2, and Docker terminal sessions (node-pty + ssh2).
 * Each workspace can have one or more terminal sessions.
 */
export class PTYService {
  private sessions = new Map<string, SessionData>();

  /**
   * Create a new terminal session for a workspace
   */
  async createSession(
    params: TerminalCreateParams,
    runtime: Runtime,
    workspacePath: string,
    onData: (data: string) => void,
    onExit: (exitCode: number) => void,
    runtimeConfig?: RuntimeConfig,
    options?: CreateSessionOptions
  ): Promise<TerminalSession> {
    // Include a random suffix to avoid collisions when creating multiple sessions quickly.
    // Collisions can cause two PTYs to appear "merged" under one sessionId.
    const sessionId = `${params.workspaceId}-${Date.now()}-${randomUUID().slice(0, 8)}`;
    let ptyProcess: PtyHandle | null = null;
    let runtimeLabel: string;

    if (runtime instanceof SSHRuntime) {
      ptyProcess = await runtime.createPtySession({
        workspacePath,
        cols: params.cols,
        rows: params.rows,
      });
      runtimeLabel = "SSH";
      log.info(`[PTY] SSH terminal for ${sessionId}: ssh ${runtime.getConfig().host}`);
    } else if (runtime instanceof DevcontainerRuntime) {
      // Must check before LocalBaseRuntime since DevcontainerRuntime extends it
      const devcontainerArgs = ["exec", "--workspace-folder", workspacePath];

      // Include config path for non-default devcontainer.json locations
      if (runtimeConfig?.type === "devcontainer" && runtimeConfig.configPath) {
        devcontainerArgs.push("--config", runtimeConfig.configPath);
      }

      // Forward the runtime's credential env (GIT_ASKPASS, CODER_*, etc.)
      // into the terminal session. The runtime owns the policy (shareCredentials gate);
      // ptyService just relays whatever the runtime computed.
      const containerEnv = runtime.getContainerEnv();
      for (const [key, value] of Object.entries(containerEnv)) {
        devcontainerArgs.push("--remote-env", `${key}=${value}`);
      }

      devcontainerArgs.push("--", "/bin/sh");
      runtimeLabel = "Devcontainer";
      const logArgs = redactDevcontainerArgsForLog(devcontainerArgs);
      log.info(`[PTY] Devcontainer terminal for ${sessionId}: devcontainer ${logArgs.join(" ")}`);

      ptyProcess = spawnPtyProcess({
        runtimeLabel,
        command: "devcontainer",
        args: devcontainerArgs,
        cwd: workspacePath,
        cols: params.cols,
        rows: params.rows,
        preferElectronBuild: false,
      });
    } else if (runtime instanceof LocalBaseRuntime) {
      try {
        await access(workspacePath, constants.F_OK);
      } catch {
        throw new Error(`Workspace path does not exist: ${workspacePath}`);
      }
      const shell = resolveLocalPtyShell({ configuredShell: options?.defaultShell });
      runtimeLabel = "Local";

      if (!shell.command.trim()) {
        throw new Error("Cannot spawn Local terminal: empty shell command");
      }

      const printableArgs = shell.args.length > 0 ? ` ${shell.args.join(" ")}` : "";
      log.info(
        `Spawning PTY: ${shell.command}${printableArgs}, cwd: ${workspacePath}, size: ${params.cols}x${params.rows}`
      );
      log.debug(`process.env.SHELL: ${process.env.SHELL ?? "undefined"}`);
      log.debug(`process.env.PATH: ${process.env.PATH ?? process.env.Path ?? "undefined"}`);

      ptyProcess = spawnPtyProcess({
        runtimeLabel,
        command: shell.command,
        args: shell.args,
        cwd: workspacePath,
        cols: params.cols,
        rows: params.rows,
        preferElectronBuild: true,
        env: options?.env,
        logLocalEnv: true,
      });
    } else if (runtime instanceof DockerRuntime) {
      const containerName = runtime.getContainerName();
      if (!containerName) {
        throw new Error("Docker container not initialized");
      }
      const dockerArgs = [
        "exec",
        "-it",
        containerName,
        "/bin/sh",
        "-c",
        `cd ${shellQuotePath(workspacePath)} && exec /bin/sh`,
      ];
      runtimeLabel = "Docker";
      const containerCli = await resolveContainerCli();
      log.info(`[PTY] Docker terminal for ${sessionId}: ${containerCli} ${dockerArgs.join(" ")}`);

      ptyProcess = spawnPtyProcess({
        runtimeLabel,
        command: containerCli,
        args: dockerArgs,
        cwd: process.cwd(),
        cols: params.cols,
        rows: params.rows,
        preferElectronBuild: false,
      });
    } else {
      throw new Error(`Unsupported runtime type: ${runtime.constructor.name}`);
    }

    log.info(
      `Creating terminal session ${sessionId} for workspace ${params.workspaceId} (${runtimeLabel})`
    );
    log.info(`[PTY] Terminal size: ${params.cols}x${params.rows}`);

    if (!ptyProcess) {
      throw new Error(`Failed to initialize ${runtimeLabel} terminal session`);
    }

    // Wire up handlers
    ptyProcess.onData(createBufferedDataHandler(onData));
    ptyProcess.onExit(({ exitCode }) => {
      log.info(`${runtimeLabel} terminal session ${sessionId} exited with code ${exitCode}`);
      this.sessions.delete(sessionId);
      onExit(exitCode);
    });

    this.sessions.set(sessionId, {
      pty: ptyProcess,
      workspaceId: params.workspaceId,
      workspacePath,
      runtime,
      runtimeLabel,
      onData,
      onExit,
    });

    return {
      sessionId,
      workspaceId: params.workspaceId,
      cols: params.cols,
      rows: params.rows,
    };
  }

  /**
   * Send input to a terminal session
   */
  sendInput(sessionId: string, data: string): void {
    const session = this.sessions.get(sessionId);
    if (!session?.pty) {
      log.info(`Cannot send input to session ${sessionId}: not found or no PTY`);
      return;
    }

    // Works for both local and SSH now
    session.pty.write(data);
  }

  /**
   * Resize a terminal session
   */
  resize(params: TerminalResizeParams): void {
    const session = this.sessions.get(params.sessionId);
    if (!session?.pty) {
      log.info(`Cannot resize terminal session ${params.sessionId}: not found or no PTY`);
      return;
    }

    // Now works for both local AND SSH! 🎉
    session.pty.resize(params.cols, params.rows);
    log.debug(
      `Resized terminal ${params.sessionId} (${session.runtimeLabel}) to ${params.cols}x${params.rows}`
    );
  }

  /**
   * Close a terminal session
   */
  closeSession(sessionId: string): void {
    const session = this.sessions.get(sessionId);
    if (!session) {
      log.info(`Cannot close terminal session ${sessionId}: not found`);
      return;
    }

    log.info(`Closing terminal session ${sessionId}`);

    if (session.pty) {
      // Works for both local and SSH
      session.pty.kill();
    }

    this.sessions.delete(sessionId);
  }

  /**
   * Get all session IDs for a workspace.
   * Used by frontend to discover existing sessions to reattach to after reload.
   */
  getWorkspaceSessionIds(workspaceId: string): string[] {
    return Array.from(this.sessions.entries())
      .filter(([, session]) => session.workspaceId === workspaceId)
      .map(([id]) => id);
  }

  /**
   * Close all terminal sessions for a workspace
   */
  closeWorkspaceSessions(workspaceId: string): void {
    const sessionIds = this.getWorkspaceSessionIds(workspaceId);

    log.info(`Closing ${sessionIds.length} terminal session(s) for workspace ${workspaceId}`);

    sessionIds.forEach((id) => this.closeSession(id));
  }

  /**
   * Close all terminal sessions.
   * Called during server shutdown to prevent orphan PTY processes.
   */
  closeAllSessions(): void {
    const sessionIds = Array.from(this.sessions.keys());
    log.info(`Closing all ${sessionIds.length} terminal session(s)`);
    sessionIds.forEach((id) => this.closeSession(id));
  }
}

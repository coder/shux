/**
 * Abstract base class for remote execution runtimes (SSH, Docker).
 *
 * Provides shared implementation for:
 * - exec() with streaming I/O, timeout/abort handling
 * - readFile(), writeFile(), stat() via exec
 * - normalizePath() for POSIX paths
 * - tempDir() returning /tmp
 *
 * Subclasses implement:
 * - spawnRemoteProcess() - how to spawn the external process (ssh/docker)
 * - getBasePath() - base directory for workspace operations
 * - quoteForRemote() - path quoting strategy
 */

import type { ChildProcess } from "child_process";
import * as path from "node:path";
import { Readable } from "stream";
import type {
  Runtime,
  ExecOptions,
  ExecStream,
  FileStat,
  WorkspaceCreationParams,
  WorkspaceCreationResult,
  WorkspaceInitParams,
  WorkspaceInitResult,
  WorkspaceForkParams,
  WorkspaceForkResult,
  EnsureReadyResult,
} from "./Runtime";
import { RuntimeError } from "./Runtime";
import { LEGACY_REMOTE_MUX_HOME } from "@/common/compat/legacyMux";
import { EXIT_CODE_ABORTED, EXIT_CODE_TIMEOUT } from "@/common/constants/exitCodes";
import { log } from "@/node/services/log";
import { attachStreamErrorHandler } from "@/node/utils/streamErrors";
import { NON_INTERACTIVE_ENV_VARS } from "@/common/constants/env";
import { DisposableProcess } from "@/node/utils/disposableExec";
import { shescape } from "./streamUtils";
import { getAtomicWriteTempPath } from "./atomicWriteTempPath";
import { buildShellExport, buildShellPathExport } from "./shellEnv";
import { raceWithAbortAndTimeout } from "@/node/utils/concurrency/withTimeout";
import {
  ensureDirViaExec,
  readFileViaExec,
  statViaExec,
  writeFileViaExec,
  STAT_VIA_EXEC_COMMAND,
} from "./execFileIO";

// Cap for the stderr side-buffer kept purely for error reporting on process
// failure. 16KB comfortably covers SSH/launch diagnostics while bounding memory
// on stderr-flooding commands.
const STDERR_ERROR_REPORTING_CAP_BYTES = 16 * 1024;

/**
 * Result from spawning a remote process.
 */
export interface SpawnResult {
  /** The spawned child process */
  process: ChildProcess;
  /** Optional transport-scoped exit handling (e.g., master-pool health accounting). */
  onExit?: (exitCode: number, stderr: string) => void;
  /** Optional close handling that must run even for synthetic abort/timeout exits. */
  onClose?: () => void;
  /** Optional transport-scoped spawn error handling. */
  onError?: (error: Error) => void;
}

/**
 * Abstract base class for remote execution runtimes.
 */
export abstract class RemoteRuntime implements Runtime {
  /**
   * Spawn the external process for command execution.
   * SSH spawns `ssh`, Docker spawns `docker exec`.
   *
   * @param fullCommand The full shell command to execute (already wrapped in bash -c)
   * @param options Original exec options
   * @returns The spawned process and optional transport lifecycle hooks
   */
  protected abstract spawnRemoteProcess(
    fullCommand: string,
    options: ExecOptions & { deadlineMs?: number }
  ): Promise<SpawnResult>;

  /**
   * Get the base path for file operations (used as cwd for file commands).
   * SSH returns srcBaseDir, Docker returns /src.
   */
  protected abstract getBasePath(): string;

  /**
   * Quote a path for use in remote shell commands.
   * SSH uses expandTildeForSSH (handles ~ expansion), Docker uses shescape.quote.
   */
  protected abstract quoteForRemote(path: string): string;

  /**
   * Build the cd command for the given cwd.
   * SSH needs special handling for ~, Docker uses simple quoting.
   */
  protected abstract cdCommand(cwd: string): string;

  /**
   * Command prefix (e.g., "SSH" or "Docker") for logging.
   */
  protected abstract readonly commandPrefix: string;

  /**
   * Execute command with streaming I/O.
   * Shared implementation that delegates process spawning to subclass.
   */
  async exec(command: string, options: ExecOptions): Promise<ExecStream> {
    const startTime = performance.now();

    // Short-circuit if already aborted
    if (options.abortSignal?.aborted) {
      throw new RuntimeError("Operation aborted before execution", "exec");
    }

    // Build command parts
    const parts: string[] = [];

    // Add cd command
    parts.push(this.cdCommand(options.cwd));

    // Add environment variable exports (user env first, then non-interactive overrides)
    const envVars = { ...options.env, ...NON_INTERACTIVE_ENV_VARS };
    for (const [key, value] of Object.entries(envVars)) {
      parts.push(buildShellExport(key, value, (envValue) => shescape.quote(envValue)));
    }
    for (const [key, value] of Object.entries(options.pathEnv ?? {})) {
      parts.push(buildShellPathExport(key, value, (envValue) => shescape.quote(envValue)));
    }

    // Add the actual command
    parts.push(command);

    // Join all parts with && to ensure each step succeeds before continuing
    let fullCommand = parts.join(" && ");

    // Wrap in bash for consistent shell behavior
    fullCommand = `bash -c ${shescape.quote(fullCommand)}`;

    // Optionally wrap with timeout
    if (options.timeout !== undefined) {
      const remoteTimeout = Math.ceil(options.timeout) + 1;
      fullCommand = `timeout -s KILL ${remoteTimeout} ${fullCommand}`;
    }

    // Spawn the remote process (SSH or Docker)
    const timeoutMs = options.timeout !== undefined ? options.timeout * 1000 : undefined;
    const deadlineMs = timeoutMs !== undefined ? Date.now() + timeoutMs : undefined;
    const spawnResult = await this.spawnRemoteProcess(fullCommand, {
      ...options,
      deadlineMs,
    });
    const { process: childProcess } = spawnResult;

    // Short-lived commands can close stdin before writes/close complete.
    if (childProcess.stdin) {
      attachStreamErrorHandler(childProcess.stdin, `${this.commandPrefix} stdin`, {
        logger: log,
      });
    }

    // Wrap in DisposableProcess for cleanup
    const disposable = new DisposableProcess(childProcess);

    // Track if we killed the process due to timeout or abort
    let timedOut = false;
    let aborted = false;

    // Declared here so it's captured by the exitCode promise closure,
    // but the data listener is added AFTER Readable.toWeb() to avoid
    // putting the stream in flowing mode prematurely.
    let stderrForErrorReporting = "";

    // Create promises for exit code and duration immediately.
    const exitCode = new Promise<number>((resolve, reject) => {
      childProcess.on("close", (code, signal) => {
        const finalExitCode =
          aborted || options.abortSignal?.aborted
            ? EXIT_CODE_ABORTED
            : timedOut
              ? EXIT_CODE_TIMEOUT
              : (code ?? (signal ? -1 : 0));

        if (finalExitCode !== EXIT_CODE_ABORTED && finalExitCode !== EXIT_CODE_TIMEOUT) {
          spawnResult.onExit?.(finalExitCode, stderrForErrorReporting);
        }
        spawnResult.onClose?.();

        resolve(finalExitCode);
      });

      childProcess.on("error", (err) => {
        spawnResult.onError?.(err);
        reject(
          new RuntimeError(
            `Failed to execute ${this.commandPrefix} command: ${err.message}`,
            "exec",
            err
          )
        );
      });
    });

    const duration = exitCode.then(() => performance.now() - startTime);

    // Handle abort signal
    if (options.abortSignal) {
      const abortSignal = options.abortSignal;
      const onAbort = () => {
        aborted = true;

        // For SSH/Docker, killing the local client too aggressively (SIGKILL) can leave the
        // remote command running. Prefer SIGTERM first so the runtime can tear down cleanly,
        // then hard-kill if it doesn't exit promptly.
        //
        // Note: SSH2's ChildProcess shim only sends a remote signal when an explicit signal
        // string is provided, so always pass SIGTERM.
        try {
          childProcess.kill("SIGTERM");
        } catch {
          // ignore
        }

        const hardKillHandle = setTimeout(() => {
          const hasExited = childProcess.exitCode !== null || childProcess.signalCode !== null;
          if (hasExited) {
            return;
          }
          disposable[Symbol.dispose]();
        }, 1000);
        hardKillHandle.unref();
      };

      abortSignal.addEventListener("abort", onAbort, { once: true });
      if (abortSignal.aborted) {
        onAbort();
      }

      // Avoid retaining closures on long-lived abort signals once the process exits.
      void exitCode
        .catch(() => undefined)
        .finally(() => abortSignal.removeEventListener("abort", onAbort));
    }

    // Handle timeout. Include connection acquisition time in the local deadline so
    // user-configured timeouts do not silently stretch while the runtime waits for SSH capacity.
    if (timeoutMs !== undefined) {
      const remainingTimeoutMs = Math.max(0, (deadlineMs ?? Date.now()) - Date.now());
      const timeoutHandle = setTimeout(() => {
        timedOut = true;

        try {
          childProcess.kill("SIGTERM");
        } catch {
          // ignore
        }

        const hardKillHandle = setTimeout(() => {
          const hasExited = childProcess.exitCode !== null || childProcess.signalCode !== null;
          if (hasExited) {
            return;
          }
          disposable[Symbol.dispose]();
        }, 1000);
        hardKillHandle.unref();
      }, remainingTimeoutMs);

      void exitCode.catch(() => undefined).finally(() => clearTimeout(timeoutHandle));
    }

    // Convert Node.js streams to Web Streams
    // eslint-disable-next-line local/no-chained-type-assertions -- grandfathered when the rule was introduced; fix the underlying type instead of copying this pattern
    const stdout = Readable.toWeb(childProcess.stdout!) as unknown as ReadableStream<Uint8Array>;
    // eslint-disable-next-line local/no-chained-type-assertions -- grandfathered when the rule was introduced; fix the underlying type instead of copying this pattern
    const stderr = Readable.toWeb(childProcess.stderr!) as unknown as ReadableStream<Uint8Array>;

    // Capture stderr for error reporting (e.g., SSH exit code 255 failures).
    // Must be AFTER Readable.toWeb() to avoid putting the stream in flowing mode prematurely.
    // Bounded: this side-buffer exists only for error diagnostics, and connection/launch
    // failures surface at the start of stderr. Without a cap, a command that floods stderr
    // (e.g. `yes >&2`) would grow this string without bound even when the caller reads the
    // stderr stream through a capped reader (execBuffered maxOutputBytes).
    childProcess.stderr?.on("data", (data: Buffer) => {
      if (stderrForErrorReporting.length < STDERR_ERROR_REPORTING_CAP_BYTES) {
        stderrForErrorReporting += data.toString(
          "utf-8",
          0,
          STDERR_ERROR_REPORTING_CAP_BYTES - stderrForErrorReporting.length
        );
      }
    });

    // Writable.toWeb(childProcess.stdin) is surprisingly easy to get into an invalid state
    // for short-lived remote commands (notably via SSH) where stdin may already be closed
    // by the time callers attempt `await stream.stdin.close()`.
    //
    // Wrap stdin ourselves so close() is idempotent.
    const stdin = new WritableStream<Uint8Array>({
      write: async (chunk) => {
        const nodeStdin = childProcess.stdin;
        if (!nodeStdin || nodeStdin.destroyed) {
          return;
        }

        await new Promise<void>((resolve, reject) => {
          const onError = (err: Error) => {
            nodeStdin.off("error", onError);
            reject(err);
          };
          nodeStdin.on("error", onError);

          nodeStdin.write(Buffer.from(chunk), (err) => {
            nodeStdin.off("error", onError);
            if (err) {
              reject(err);
              return;
            }
            resolve();
          });
        });
      },
      close: async () => {
        const nodeStdin = childProcess.stdin;
        if (!nodeStdin || nodeStdin.destroyed || nodeStdin.writableEnded) {
          return;
        }

        await new Promise<void>((resolve) => {
          const onError = () => {
            cleanup();
            resolve();
          };

          const onFinish = () => {
            cleanup();
            resolve();
          };

          const cleanup = () => {
            nodeStdin.removeListener("error", onError);
            nodeStdin.removeListener("finish", onFinish);
          };

          nodeStdin.once("error", onError);
          nodeStdin.once("finish", onFinish);

          try {
            nodeStdin.end();
          } catch {
            onError();
          }
        });
      },
      abort: () => {
        childProcess.stdin?.destroy();
      },
    });

    log.debug(`${this.commandPrefix} command: ${fullCommand}`);

    return { stdout, stderr, stdin, exitCode, duration };
  }

  private async resolveFilePath(filePath: string, abortSignal?: AbortSignal): Promise<string> {
    if (filePath === "~" || filePath.startsWith("~/")) {
      return this.resolveWithAbort(this.resolvePath(filePath), abortSignal);
    }
    if (path.posix.isAbsolute(filePath)) {
      return path.posix.normalize(filePath);
    }
    const basePath = await this.resolveWithAbort(this.resolvePath(this.getBasePath()), abortSignal);
    return path.posix.resolve(basePath, filePath);
  }

  /**
   * resolvePath has no signal path into its exec, so a canceled file operation
   * must not wait out the resolver (up to its 10s timeout): settle the caller
   * immediately and let the orphaned resolver finish in the background.
   */
  private async resolveWithAbort(
    resolution: Promise<string>,
    abortSignal?: AbortSignal
  ): Promise<string> {
    const result = await raceWithAbortAndTimeout(resolution, { signal: abortSignal });
    if (result.kind !== "ok") {
      resolution.catch(() => undefined);
      abortSignal?.throwIfAborted();
      throw new RuntimeError("Path resolution aborted", "file_io");
    }
    return result.value;
  }

  /**
   * Read file contents as a stream via exec.
   */
  readFile(filePath: string, abortSignal?: AbortSignal): ReadableStream<Uint8Array> {
    return readFileViaExec(
      filePath,
      async (signal) => {
        const resolvedPath = await this.resolveFilePath(filePath, signal);
        return this.exec(`cat ${this.quoteForRemote(resolvedPath)}`, {
          cwd: this.getBasePath(),
          timeout: 300,
          abortSignal: signal,
        });
      },
      abortSignal
    );
  }

  /**
   * Write file contents atomically via exec.
   * Uses temp file + mv for atomic write.
   */
  writeFile(filePath: string, abortSignal?: AbortSignal): WritableStream<Uint8Array> {
    return writeFileViaExec(
      filePath,
      async (signal) => {
        const resolvedPath = await this.resolveFilePath(filePath, signal);
        const quotedPath = this.quoteForRemote(resolvedPath);
        const quotedTempPath = this.quoteForRemote(getAtomicWriteTempPath(resolvedPath));
        return this.exec(this.buildWriteCommand(quotedPath, quotedTempPath), {
          cwd: this.getBasePath(),
          timeout: 300,
          abortSignal: signal,
        });
      },
      abortSignal
    );
  }

  /**
   * Build the write command for atomic file writes.
   * Can be overridden by subclasses for special handling (e.g., SSH symlink preservation).
   */
  protected buildWriteCommand(quotedPath: string, quotedTempPath: string): string {
    return `mkdir -p $(dirname ${quotedPath}) && cat > ${quotedTempPath} && mv ${quotedTempPath} ${quotedPath}`;
  }

  /**
   * Ensure a directory exists (mkdir -p semantics).
   */
  ensureDir(dirPath: string, abortSignal?: AbortSignal): Promise<void> {
    return ensureDirViaExec(dirPath, async () => {
      const resolvedPath = await this.resolveFilePath(dirPath, abortSignal);
      return this.exec(`mkdir -p ${this.quoteForRemote(resolvedPath)}`, {
        cwd: "/",
        timeout: 10,
        abortSignal,
      });
    });
  }

  /**
   * Get file statistics via exec.
   */
  stat(filePath: string, abortSignal?: AbortSignal): Promise<FileStat> {
    return statViaExec(filePath, async () => {
      const resolvedPath = await this.resolveFilePath(filePath, abortSignal);
      return this.exec(`${STAT_VIA_EXEC_COMMAND} ${this.quoteForRemote(resolvedPath)}`, {
        cwd: this.getBasePath(),
        timeout: 10,
        abortSignal,
      });
    });
  }

  /**
   * Normalize path for comparison (POSIX semantics).
   * Shared between SSH and Docker.
   */
  normalizePath(targetPath: string, basePath: string): string {
    const target = targetPath.trim();
    let base = basePath.trim();

    // Normalize base path - remove trailing slash (except for root "/")
    if (base.length > 1 && base.endsWith("/")) {
      base = base.slice(0, -1);
    }

    // Handle special case: current directory
    if (target === ".") {
      return base;
    }

    // Handle absolute paths and tilde
    if (target.startsWith("/") || target === "~" || target.startsWith("~/")) {
      let normalizedTarget = target;
      // Remove trailing slash for comparison (except for root "/")
      if (normalizedTarget.length > 1 && normalizedTarget.endsWith("/")) {
        normalizedTarget = normalizedTarget.slice(0, -1);
      }
      return normalizedTarget;
    }

    // Relative path - resolve against base
    const normalizedTarget = base.endsWith("/") ? base + target : base + "/" + target;

    // Remove trailing slash
    if (normalizedTarget.length > 1 && normalizedTarget.endsWith("/")) {
      return normalizedTarget.slice(0, -1);
    }

    return normalizedTarget;
  }

  /**
   * Return /tmp as the temp directory for remote runtimes.
   */
  tempDir(): Promise<string> {
    return Promise.resolve("/tmp");
  }

  getXumHome(): string {
    // Remote hosts cannot be migrated safely from local startup. Keep their established
    // home path centralized as a compatibility exception until remote provisioning owns it.
    return LEGACY_REMOTE_MUX_HOME;
  }

  // Abstract methods that subclasses must implement

  /**
   * Remote runtimes are always ready (SSH connections are re-established as needed).
   * Subclasses (CoderSSHRuntime, DockerRuntime) may override for provisioning checks.
   */
  ensureReady(): Promise<EnsureReadyResult> {
    return Promise.resolve({ ready: true });
  }

  abstract resolvePath(path: string): Promise<string>;
  abstract getWorkspacePath(projectPath: string, workspaceName: string): string;
  abstract createWorkspace(params: WorkspaceCreationParams): Promise<WorkspaceCreationResult>;
  abstract initWorkspace(params: WorkspaceInitParams): Promise<WorkspaceInitResult>;
  abstract renameWorkspace(
    projectPath: string,
    oldName: string,
    newName: string,
    abortSignal?: AbortSignal
  ): Promise<
    { success: true; oldPath: string; newPath: string } | { success: false; error: string }
  >;
  abstract deleteWorkspace(
    projectPath: string,
    workspaceName: string,
    force: boolean,
    abortSignal?: AbortSignal
  ): Promise<{ success: true; deletedPath: string } | { success: false; error: string }>;
  abstract forkWorkspace(params: WorkspaceForkParams): Promise<WorkspaceForkResult>;
}

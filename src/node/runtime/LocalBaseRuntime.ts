import { spawn } from "child_process";
import * as fs from "fs";
import * as fsPromises from "fs/promises";
import * as path from "path";
import { Readable, Writable } from "stream";

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
  InitLogger,
  EnsureReadyResult,
} from "./Runtime";
import { RuntimeError as RuntimeErrorClass } from "./Runtime";
import { NON_INTERACTIVE_ENV_VARS } from "@/common/constants/env";
import { getBashPath } from "@/node/utils/main/bashPath";
import { shellQuote } from "@/common/utils/shell";
import { EXIT_CODE_ABORTED, EXIT_CODE_TIMEOUT } from "@/common/constants/exitCodes";
import { DisposableProcess, forceCloseStdio, killProcessTree } from "@/node/utils/disposableExec";
import { expandTilde } from "./tildeExpansion";
import {
  createLineBufferedLoggers,
  findInitHookRelativePath,
  runWorkspaceInitHook,
} from "./initHook";
import { getErrorMessage } from "@/common/utils/errors";
import { getAtomicWriteTempPath } from "./atomicWriteTempPath";
import { buildShellExport } from "./shellEnv";
import { sanitizeXumChildEnv } from "./childProcessEnv";

/**
 * Abstract base class for local runtimes (both WorktreeRuntime and LocalRuntime).
 *
 * Provides shared implementation for:
 * - exec() - Command execution with streaming I/O
 * - readFile() - File reading with streaming
 * - writeFile() - Atomic file writes with streaming
 * - stat() - File statistics
 * - resolvePath() - Path resolution with tilde expansion
 * - normalizePath() - Path normalization
 *
 * Subclasses must implement workspace-specific methods:
 * - getWorkspacePath()
 * - createWorkspace()
 * - initWorkspace()
 * - deleteWorkspace()
 * - renameWorkspace()
 * - forkWorkspace()
 */
export abstract class LocalBaseRuntime implements Runtime {
  async exec(command: string, options: ExecOptions): Promise<ExecStream> {
    const startTime = performance.now();

    if (options.abortSignal?.aborted) {
      throw new RuntimeErrorClass("Operation aborted before execution", "exec");
    }

    // Use the specified working directory (must be a specific workspace path)
    const cwd = options.cwd;

    // Check if working directory exists before spawning
    // This prevents confusing ENOENT errors from spawn()
    try {
      await fsPromises.access(cwd);
    } catch (err) {
      throw new RuntimeErrorClass(`Working directory does not exist: ${cwd}`, "exec", err);
    }

    const bashPath = getBashPath();
    const spawnCommand = bashPath;

    // Match RemoteRuntime behavior: ensure non-interactive env vars are set inside the shell.
    //
    // Why not rely solely on `env`?
    // - On Windows, env var casing and shell startup state can be surprising.
    // - These are non-sensitive vars that we want to guarantee for git/editor safety.
    const nonInteractivePrelude = Object.entries(NON_INTERACTIVE_ENV_VARS)
      .map(([key, value]) => buildShellExport(key, value))
      .join("\n");

    // Expand host-side with the same semantics as local file I/O: expandTilde
    // routes ~/.xum (and legacy homes) through getXumHome, which in-shell $HOME
    // expansion would miss (XUM_ROOT, dev suffix), and relative values resolve
    // against the exec cwd, matching the shell's $PWD when the exports run.
    const pathEnvPrelude = Object.entries(options.pathEnv ?? {})
      .map(([key, value]) => buildShellExport(key, path.resolve(cwd, expandTilde(value))))
      .join("\n");
    const spawnArgs = ["-c", `${nonInteractivePrelude}\n${pathEnvPrelude}\n${command}`];

    const defaultPath = "/usr/local/bin:/usr/bin:/bin:/usr/sbin:/sbin";
    const mergedEnv = sanitizeXumChildEnv({
      ...process.env,
      ...(options.env ?? {}),
    });
    const basePath =
      (options.env?.PATH && options.env.PATH.length > 0
        ? mergedEnv.PATH
        : (mergedEnv.PATH ?? mergedEnv.Path)) ?? defaultPath;
    const effectivePath = basePath;

    const childProcess = spawn(spawnCommand, spawnArgs, {
      cwd,
      env: {
        ...mergedEnv,
        ...NON_INTERACTIVE_ENV_VARS,
        PATH: effectivePath,
      },
      stdio: ["pipe", "pipe", "pipe"],
      // CRITICAL: Spawn as detached process group leader to enable cleanup of background processes.
      // When a bash script spawns background processes (e.g., `sleep 100 &`), we need to kill
      // the entire process group (including all backgrounded children) via process.kill(-pid).
      // NOTE: detached:true does NOT cause bash to wait for background jobs when using 'exit' event
      // instead of 'close' event. The 'exit' event fires when bash exits, ignoring background children.
      detached: true,
      // Prevent console window from appearing on Windows (WSL bash spawns steal focus otherwise)
      windowsHide: true,
    });

    // Wrap in DisposableProcess for automatic cleanup
    const disposable = new DisposableProcess(childProcess);

    // Convert Node.js streams to Web Streams
    // eslint-disable-next-line local/no-chained-type-assertions -- grandfathered when the rule was introduced; fix the underlying type instead of copying this pattern
    const stdout = Readable.toWeb(childProcess.stdout) as unknown as ReadableStream<Uint8Array>;
    // eslint-disable-next-line local/no-chained-type-assertions -- grandfathered when the rule was introduced; fix the underlying type instead of copying this pattern
    const stderr = Readable.toWeb(childProcess.stderr) as unknown as ReadableStream<Uint8Array>;
    // eslint-disable-next-line local/no-chained-type-assertions -- grandfathered when the rule was introduced; fix the underlying type instead of copying this pattern
    const stdin = Writable.toWeb(childProcess.stdin) as unknown as WritableStream<Uint8Array>;

    // No stream cleanup in DisposableProcess - streams close naturally when process exits
    // bash.ts handles cleanup after waiting for exitCode

    // Track if we killed the process due to timeout or abort
    let timedOut = false;
    let aborted = false;

    // Create promises for exit code and duration
    // Uses special exit codes (EXIT_CODE_ABORTED, EXIT_CODE_TIMEOUT) for expected error conditions
    const exitCode = new Promise<number>((resolve, reject) => {
      // Use 'exit' event instead of 'close' to handle background processes correctly.
      // The 'close' event waits for ALL child processes (including background ones) to exit,
      // which causes hangs when users spawn background processes like servers.
      // The 'exit' event fires when the main bash process exits, which is what we want.
      childProcess.on("exit", (code) => {
        // Clean up any background processes (process group cleanup)
        // This prevents zombie processes when scripts spawn background tasks
        if (childProcess.pid !== undefined) {
          // Kill the full process tree to prevent hangs when scripts spawn background jobs.
          //
          // On Unix we can kill the whole group via process.kill(-pid).
          // On Windows we must use taskkill to avoid leaking child processes.
          killProcessTree(childProcess.pid);
        }

        // Check abort first (highest priority)
        if (aborted || options.abortSignal?.aborted) {
          resolve(EXIT_CODE_ABORTED);
          return;
        }
        // Check if we killed the process due to timeout
        if (timedOut) {
          resolve(EXIT_CODE_TIMEOUT);
          return;
        }
        resolve(code ?? 0);
        // Cleanup runs automatically via DisposableProcess
      });

      childProcess.on("error", (err) => {
        reject(new RuntimeErrorClass(`Failed to execute command: ${err.message}`, "exec", err));
      });
    });

    const duration = exitCode.then(() => performance.now() - startTime);

    // Avoid unhandled promise rejections in fire-and-forget exec() callsites.
    // Callers that await these promises will still observe the rejection.
    void exitCode.catch(() => undefined);
    void duration.catch(() => undefined);

    // Register process group cleanup with DisposableProcess
    // This ensures ALL background children are killed when process exits
    disposable.addCleanup(() => {
      if (childProcess.pid === undefined) return;

      // Kill the full process tree (see comment in exit handler).
      killProcessTree(childProcess.pid);

      forceCloseStdio(childProcess);
    });

    // Handle abort signal
    const onAbort = () => {
      aborted = true;
      disposable[Symbol.dispose](); // Kill process and run cleanup
    };
    options.abortSignal?.addEventListener("abort", onAbort, { once: true });
    void exitCode
      .catch(() => undefined)
      .finally(() => {
        options.abortSignal?.removeEventListener("abort", onAbort);
      });

    // Handle timeout
    if (options.timeout !== undefined) {
      const timeoutHandle = setTimeout(() => {
        timedOut = true;
        disposable[Symbol.dispose](); // Kill process and run cleanup
      }, options.timeout * 1000);

      // Clear timeout if process exits naturally
      void exitCode.catch(() => undefined).finally(() => clearTimeout(timeoutHandle));
    }

    return { stdout, stderr, stdin, exitCode, duration };
  }

  readFile(filePath: string, abortSignal?: AbortSignal): ReadableStream<Uint8Array> {
    const resolvedPath = path.resolve(expandTilde(filePath));
    const nodeStream = fs.createReadStream(resolvedPath);

    // Handle errors by wrapping in a transform
    // eslint-disable-next-line local/no-chained-type-assertions -- grandfathered when the rule was introduced; fix the underlying type instead of copying this pattern
    const webStream = Readable.toWeb(nodeStream) as unknown as ReadableStream<Uint8Array>;
    const reader = webStream.getReader();

    // r19: honor caller aborts (kernel deadline, workspace removal), not just
    // consumer cancellation — a FIFO or blocked network-mounted file can
    // stall before yielding enough bytes for a consumer-side ceiling to
    // cancel, leaving the pending read and its fd blocked forever. Aborting
    // cancels the inner reader, which destroys the node stream and settles
    // the pinned read.
    const onAbort = () => {
      void reader.cancel(abortSignal?.reason).catch(() => undefined);
    };
    if (abortSignal?.aborted) {
      onAbort();
    } else {
      abortSignal?.addEventListener("abort", onAbort, { once: true });
    }
    const cleanupAbortForwarder = () => {
      abortSignal?.removeEventListener("abort", onAbort);
    };

    // Pull-based (not an eager start loop): consumers control the read rate
    // (backpressure), and cancellation can reach the source — the old eager
    // loop had no cancel callback, so a cancelled wrapper (e.g. mux.load's
    // byte ceiling on /dev/zero) abandoned the reader and leaked the open
    // file handle (r18).
    return new ReadableStream<Uint8Array>({
      pull: async (controller: ReadableStreamDefaultController<Uint8Array>) => {
        try {
          const { done, value } = await reader.read();
          // reader.cancel() settles a pinned read as {done: true}; surface
          // the abort as an error rather than a clean EOF so consumers do
          // not mistake a truncated read for the whole file.
          if (abortSignal?.aborted) {
            cleanupAbortForwarder();
            controller.error(new RuntimeErrorClass(`Read of ${filePath} aborted`, "file_io"));
            return;
          }
          if (done) {
            cleanupAbortForwarder();
            controller.close();
            return;
          }
          controller.enqueue(value);
        } catch (err) {
          cleanupAbortForwarder();
          controller.error(
            new RuntimeErrorClass(
              `Failed to read file ${filePath}: ${getErrorMessage(err)}`,
              "file_io",
              err
            )
          );
        }
      },
      cancel: async (reason: unknown) => {
        cleanupAbortForwarder();
        // Destroys the underlying node stream and closes the fd.
        await reader.cancel(reason);
      },
    });
  }

  writeFile(filePath: string, _abortSignal?: AbortSignal): WritableStream<Uint8Array> {
    // Note: _abortSignal ignored for local operations (fast, no need for cancellation)
    const canonicalPath = path.resolve(expandTilde(filePath));
    let tempPath: string;
    let writer: WritableStreamDefaultWriter<Uint8Array>;
    let resolvedPath: string;
    let originalMode: number | undefined;

    return new WritableStream<Uint8Array>({
      async start() {
        // Resolve symlinks to write through them (preserves the symlink)
        try {
          resolvedPath = await fsPromises.realpath(canonicalPath);
          // Save original permissions to restore after write
          const stat = await fsPromises.stat(resolvedPath);
          originalMode = stat.mode;
        } catch {
          resolvedPath = canonicalPath;
          originalMode = undefined;
        }

        // Create parent directories if they don't exist
        const parentDir = path.dirname(resolvedPath);
        await fsPromises.mkdir(parentDir, { recursive: true });

        // Use a unique temp path so parallel writers never race on the same
        // intermediate file before the final atomic rename.
        tempPath = getAtomicWriteTempPath(resolvedPath);
        const nodeStream = fs.createWriteStream(tempPath);
        const webStream = Writable.toWeb(nodeStream) as WritableStream<Uint8Array>;
        writer = webStream.getWriter();
      },
      async write(chunk: Uint8Array) {
        await writer.write(chunk);
      },
      async close() {
        // Close the writer and rename to final location
        await writer.close();
        try {
          // If we have original permissions, apply them to temp file before rename
          if (originalMode !== undefined) {
            await fsPromises.chmod(tempPath, originalMode);
          }
          await fsPromises.rename(tempPath, resolvedPath);
        } catch (err) {
          throw new RuntimeErrorClass(
            `Failed to write file ${filePath}: ${getErrorMessage(err)}`,
            "file_io",
            err
          );
        }
      },
      async abort(reason?: unknown) {
        // Clean up temp file on abort
        await writer.abort();
        try {
          await fsPromises.unlink(tempPath);
        } catch {
          // Ignore errors cleaning up temp file
        }
        throw new RuntimeErrorClass(
          `Failed to write file ${filePath}: ${String(reason)}`,
          "file_io"
        );
      },
    });
  }

  async stat(filePath: string, _abortSignal?: AbortSignal): Promise<FileStat> {
    // Note: _abortSignal ignored for local operations (fast, no need for cancellation)
    const resolvedPath = path.resolve(expandTilde(filePath));
    try {
      const stats = await fsPromises.stat(resolvedPath);
      return {
        size: stats.size,
        modifiedTime: stats.mtime,
        isDirectory: stats.isDirectory(),
      };
    } catch (err) {
      throw new RuntimeErrorClass(
        `Failed to stat ${filePath}: ${getErrorMessage(err)}`,
        "file_io",
        err
      );
    }
  }

  async ensureDir(dirPath: string, abortSignal?: AbortSignal): Promise<void> {
    if (abortSignal?.aborted) {
      throw new RuntimeErrorClass("Operation aborted before directory creation", "file_io");
    }
    const resolvedPath = path.resolve(expandTilde(dirPath));
    try {
      await fsPromises.mkdir(resolvedPath, { recursive: true });
    } catch (err) {
      throw new RuntimeErrorClass(
        `Failed to create directory ${dirPath}: ${getErrorMessage(err)}`,
        "file_io",
        err
      );
    }
  }

  resolvePath(filePath: string): Promise<string> {
    // Expand tilde to actual home directory path
    const expanded = expandTilde(filePath);

    // Resolve to absolute path (handles relative paths like "./foo")
    return Promise.resolve(path.resolve(expanded));
  }

  normalizePath(targetPath: string, basePath: string): string {
    // For local runtime, use Node.js path resolution
    // Handle special case: current directory
    const target = targetPath.trim();
    if (target === ".") {
      return path.resolve(basePath);
    }
    // Expand tildes before resolving (~ is not expanded by path.resolve)
    const expanded = expandTilde(target);
    return path.resolve(basePath, expanded);
  }

  // Abstract methods that subclasses must implement
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

  /**
   * Get the runtime's temp directory.
   * Uses OS temp dir on local systems.
   */
  tempDir(): Promise<string> {
    // Use /tmp on Unix, or OS temp dir on Windows
    const isWindows = process.platform === "win32";
    return Promise.resolve(isWindows ? (process.env.TEMP ?? "C:\\Temp") : "/tmp");
  }

  getXumHome(): string {
    return "~/.xum";
  }

  /**
   * Local runtimes are always ready.
   */
  ensureReady(): Promise<EnsureReadyResult> {
    return Promise.resolve({ ready: true });
  }

  protected initLocalWorkspace(params: WorkspaceInitParams, runtimeType: "local" | "worktree") {
    return runWorkspaceInitHook({
      params,
      runtimeType,
      findHookRelativePath: () => findInitHookRelativePath(this, params.workspacePath),
      runHook: ({ hookRelativePath, xumEnv, initLogger, abortSignal }) =>
        this.runInitHook(
          params.workspacePath,
          this.normalizePath(hookRelativePath, params.workspacePath),
          xumEnv,
          initLogger,
          abortSignal
        ),
    });
  }

  /**
   * Helper to run .xum/init hook if it exists and is executable.
   * Shared between WorktreeRuntime and LocalRuntime.
   * @param workspacePath - Path to the workspace directory
   * @param xumEnv - Canonical XUM_ variables plus legacy MUX_ aliases
   * @param initLogger - Logger for streaming output
   * @param abortSignal - Optional abort signal
   */
  protected async runInitHook(
    workspacePath: string,
    hookPath: string,
    xumEnv: Record<string, string>,
    initLogger: InitLogger,
    abortSignal?: AbortSignal
  ): Promise<void> {
    initLogger.logStep(`Running init hook: ${hookPath}`);

    if (abortSignal?.aborted) {
      initLogger.logComplete(EXIT_CODE_ABORTED);
      return;
    }

    const loggers = createLineBufferedLoggers(initLogger);

    return new Promise<void>((resolve) => {
      const bashPath = getBashPath();
      const proc = spawn(bashPath, ["-c", shellQuote(hookPath)], {
        cwd: workspacePath,
        stdio: ["ignore", "pipe", "pipe"],
        env: {
          ...process.env,
          ...xumEnv,
        },
        // Prevent console window from appearing on Windows
        windowsHide: true,
        // Spawn as a detached process group leader so we can reliably cancel the hook.
        detached: true,
      });

      let aborted = false;

      const onAbort = () => {
        aborted = true;

        if (proc.pid !== undefined) {
          killProcessTree(proc.pid);
          return;
        }

        try {
          proc.kill("SIGKILL");
        } catch {
          // ignore
        }
      };

      abortSignal?.addEventListener("abort", onAbort, { once: true });
      if (abortSignal?.aborted) {
        onAbort();
      }

      proc.stdout.on("data", (data: Buffer) => {
        loggers.stdout.append(data.toString());
      });

      proc.stderr.on("data", (data: Buffer) => {
        loggers.stderr.append(data.toString());
      });

      proc.on("close", (code) => {
        abortSignal?.removeEventListener("abort", onAbort);

        // Flush any remaining buffered output
        loggers.stdout.flush();
        loggers.stderr.flush();

        initLogger.logComplete(aborted || abortSignal?.aborted ? EXIT_CODE_ABORTED : (code ?? 0));
        resolve();
      });

      proc.on("error", (err) => {
        abortSignal?.removeEventListener("abort", onAbort);

        if (aborted || abortSignal?.aborted) {
          initLogger.logComplete(EXIT_CODE_ABORTED);
          resolve();
          return;
        }

        initLogger.logStderr(`Error running init hook: ${err.message}`);
        initLogger.logComplete(-1);
        resolve();
      });
    });
  }
}

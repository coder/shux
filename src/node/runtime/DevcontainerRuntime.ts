import * as path from "path";
import { Readable, Writable } from "stream";
import type {
  RuntimeCreateFlags,
  WorkspaceCreationParams,
  WorkspaceCreationResult,
  WorkspaceForkParams,
  WorkspaceForkResult,
  WorkspaceInitParams,
  WorkspaceInitResult,
  ExecOptions,
  ExecStream,
  EnsureReadyResult,
  EnsureReadyOptions,
  FileStat,
} from "./Runtime";
import { RuntimeError, WORKSPACE_REPO_MISSING_ERROR } from "./Runtime";
import { buildShellPathExport } from "./shellEnv";
import { LocalBaseRuntime } from "./LocalBaseRuntime";
import { WorktreeManager } from "@/node/worktree/WorktreeManager";
import { shescape, streamToString } from "./streamUtils";
import {
  readHostGitconfig,
  resolveGhToken,
  resolveHostCredentialEnv,
  resolveCoderAgentMount,
  resolveGitdirMount,
  resolveSshAgentForwarding,
  type BindMount,
} from "./credentialForwarding";
import { devcontainerUp, devcontainerDown, spawnDevcontainer } from "./devcontainerCli";
import { findInitHookRelativePath, runInitHookOnRuntime, runWorkspaceInitHook } from "./initHook";
import { DisposableProcess, forceCloseStdio, killProcessTree } from "@/node/utils/disposableExec";
import { EXIT_CODE_ABORTED, EXIT_CODE_TIMEOUT } from "@/common/constants/exitCodes";
import { NON_INTERACTIVE_ENV_VARS } from "@/common/constants/env";
import { getErrorMessage } from "@/common/utils/errors";
import { log } from "@/node/services/log";
import { isGitRepository, stripTrailingSlashes } from "@/node/utils/pathUtils";
import { getAtomicWriteTempPath } from "./atomicWriteTempPath";
import {
  ensureDirViaExec,
  readFileViaExec,
  statViaExec,
  writeFileViaExec,
  STAT_VIA_EXEC_COMMAND,
} from "./execFileIO";

const FILE_PATH_ENV = "XUM_INTERNAL_FILE_PATH";
const TEMP_FILE_PATH_ENV = "XUM_INTERNAL_TEMP_FILE_PATH";

export interface DevcontainerRuntimeOptions {
  srcBaseDir: string;
  configPath: string;
  shareCredentials?: boolean;
}

/**
 * Devcontainer runtime implementation.
 *
 * This runtime creates git worktrees on the host and runs commands inside
 * a devcontainer built from the project's devcontainer.json configuration.
 *
 * Architecture:
 * - Worktree operations (create/delete/fork) → WorktreeManager (host filesystem)
 * - Command execution (exec) → devcontainer exec (inside container)
 * - File I/O → host fs (worktree is bind-mounted into container)
 * - ensureReady → devcontainer up (starts/rebuilds container as needed)
 */
export class DevcontainerRuntime extends LocalBaseRuntime {
  private readonly worktreeManager: WorktreeManager;
  private readonly configPath: string;

  // Cached env used for credential forwarding
  private lastCredentialEnv?: Record<string, string>;
  private readonly shareCredentials: boolean;

  // Cached container requirements (mounts + env), computed by computeContainerRequirements()
  private containerMounts: BindMount[] = [];
  private containerEnv: Record<string, string> = {};

  // Cached from devcontainer up output
  private remoteHomeDir?: string;
  private remoteWorkspaceFolder?: string;
  private remoteUser?: string;

  // Current workspace context (set during postCreateSetup/ensureReady)
  private currentWorkspacePath?: string;

  readonly createFlags: RuntimeCreateFlags = {
    deferredRuntimeAccess: true,
  };

  /**
   * Compute all mounts and env vars the container needs.
   * Called once during postCreateSetup() and ensureReady(); results cached
   * on this.containerMounts / this.containerEnv for use by exec() and getContainerEnv().
   *
   * Gitdir mount is always resolved (worktree correctness).
   * Credential env/mounts are gated behind shareCredentials.
   */
  private computeContainerRequirements(
    workspacePath: string,
    runtimeEnv?: Record<string, string>
  ): void {
    const mounts: BindMount[] = [];
    const env: Record<string, string> = {};

    // Always: bind-mount parent .git dir for worktree support.
    // Without this, git inside the container can't resolve the gitdir reference.
    const gitdirMount = resolveGitdirMount(workspacePath);
    if (gitdirMount) mounts.push(gitdirMount);

    if (this.shareCredentials) {
      // Forward host credential env (GIT_ASKPASS, GIT_SSH_COMMAND, CODER_*, git identity)
      Object.assign(env, resolveHostCredentialEnv());

      // Mount /.coder-agent/ so GIT_ASKPASS=/.coder-agent/coder resolves
      const coderMount = resolveCoderAgentMount();
      if (coderMount) mounts.push(coderMount);

      // SSH agent socket
      const ssh = resolveSshAgentForwarding("/tmp/ssh-agent.sock");
      if (ssh) {
        mounts.push({ source: ssh.hostSocketPath, target: ssh.targetSocketPath });
        env.SSH_AUTH_SOCK = ssh.targetSocketPath;
      }

      // GH_TOKEN
      const ghToken = resolveGhToken(runtimeEnv);
      if (ghToken) env.GH_TOKEN = ghToken;
    }

    this.containerMounts = mounts;
    this.containerEnv = env;
  }

  /**
   * Refresh cached container requirements from current runtime state.
   * Called at every entry boundary that may precede PTY/exec usage,
   * so credential env is always available regardless of lifecycle ordering.
   */
  private refreshContainerRequirements(
    runtimeEnv: Record<string, string> | undefined = this.lastCredentialEnv
  ): void {
    if (!this.currentWorkspacePath) {
      this.containerMounts = [];
      this.containerEnv = {};
      return;
    }

    this.computeContainerRequirements(this.currentWorkspacePath, runtimeEnv);
  }

  /**
   * Env vars that should be forwarded into devcontainer processes.
   * Consumed by ptyService for terminal sessions.
   */
  getContainerEnv(): Record<string, string> {
    if (this.currentWorkspacePath && Object.keys(this.containerEnv).length === 0) {
      this.refreshContainerRequirements();
    }

    return this.containerEnv;
  }

  private mapContainerPathToHost(containerPath: string): string | null {
    if (!this.remoteWorkspaceFolder || !this.currentWorkspacePath) return null;

    const remoteRoot = this.remoteWorkspaceFolder.replace(/\/+$/, "");
    if (containerPath !== remoteRoot && !containerPath.startsWith(`${remoteRoot}/`)) return null;

    const suffix = containerPath.slice(remoteRoot.length).replace(/^\/+/, "");
    return suffix.length === 0
      ? this.currentWorkspacePath
      : path.join(this.currentWorkspacePath, suffix);
  }

  private getContainerBasePath(): string {
    return this.remoteWorkspaceFolder ?? "/";
  }

  private resolveHostPathForMounted(filePath: string): string | null {
    if (this.currentWorkspacePath) {
      const normalizedFilePath = filePath.replaceAll("\\", "/");
      const normalizedHostRoot = stripTrailingSlashes(
        this.currentWorkspacePath.replaceAll("\\", "/")
      );
      if (
        normalizedFilePath === normalizedHostRoot ||
        normalizedFilePath.startsWith(`${normalizedHostRoot}/`)
      ) {
        return filePath;
      }
    }

    return this.mapContainerPathToHost(filePath);
  }

  /**
   * Expand tilde in file paths for container operations.
   * Returns unexpanded path when container user is unknown (before ensureReady).
   * Callers must check for unexpanded tilde and handle appropriately.
   */
  private expandTildeForContainer(filePath: string): string {
    if (filePath === "~" || filePath.startsWith("~/")) {
      // If we know the home directory, use it
      if (this.remoteHomeDir) {
        return filePath === "~" ? this.remoteHomeDir : this.remoteHomeDir + filePath.slice(1);
      }
      // If we know the user, derive home directory
      if (this.remoteUser !== undefined) {
        const homeDir = this.remoteUser === "root" ? "/root" : `/home/${this.remoteUser}`;
        return filePath === "~" ? homeDir : homeDir + filePath.slice(1);
      }
      // User unknown - return unexpanded to signal caller should handle
      return filePath;
    }
    return filePath;
  }

  /**
   * Check if a path contains unexpanded tilde (container user unknown).
   */
  private hasUnexpandedTilde(filePath: string): boolean {
    return filePath === "~" || filePath.startsWith("~/");
  }

  private async setupCredentials(
    env?: Record<string, string>,
    abortSignal?: AbortSignal
  ): Promise<void> {
    if (!this.shareCredentials) return;

    if (abortSignal?.aborted) {
      throw new RuntimeError("Operation aborted before credential setup", "exec");
    }

    const gitconfigContents = await readHostGitconfig();
    if (gitconfigContents) {
      const stream = await this.exec('cat > "$HOME/.gitconfig"', {
        cwd: this.getContainerBasePath(),
        timeout: 30,
        abortSignal,
      });
      const writer = stream.stdin.getWriter();
      try {
        await writer.write(gitconfigContents);
      } finally {
        writer.releaseLock();
      }
      await stream.stdin.close();
      const exitCode = await stream.exitCode;
      if (exitCode !== 0) {
        const stderr = await streamToString(stream.stderr);
        throw new RuntimeError(`Failed to copy gitconfig: ${stderr}`, "file_io");
      }
    }

    const ghToken = resolveGhToken(env);
    if (ghToken) {
      const stream = await this.exec("command -v gh >/dev/null && gh auth setup-git || true", {
        cwd: this.getContainerBasePath(),
        timeout: 30,
        env: { GH_TOKEN: ghToken },
        abortSignal,
      });
      await stream.stdin.close();
      await stream.exitCode;
    }
  }

  private async fetchRemoteHome(abortSignal?: AbortSignal): Promise<void> {
    if (!this.currentWorkspacePath) return;
    if (abortSignal?.aborted) return;
    try {
      const stream = await this.exec('printf "%s" "$HOME"', {
        cwd: this.remoteWorkspaceFolder ?? "/",
        timeout: 10,
        abortSignal,
      });
      await stream.stdin.close();
      const stdout = await streamToString(stream.stdout);
      const exitCode = await stream.exitCode;
      if (exitCode === 0 && stdout.trim()) {
        this.remoteHomeDir = stdout.trim();
      }
    } catch {
      // Best-effort; keep going if $HOME cannot be resolved
    }
  }

  private mapPathForExec(filePath: string): string {
    // Issue #3709: paths embedded in exec scripts must use the container namespace.
    return this.mapHostPathToContainer(filePath) ?? filePath;
  }

  private mapHostPathToContainer(hostPath: string): string | null {
    if (!this.remoteWorkspaceFolder || !this.currentWorkspacePath) return null;

    // Normalize to forward slashes for cross-platform comparison (Windows uses backslashes)
    const normalizedHostPath = hostPath.replaceAll("\\", "/");
    const hostRoot = this.currentWorkspacePath.replaceAll("\\", "/").replace(/\/+$/, "");
    if (normalizedHostPath !== hostRoot && !normalizedHostPath.startsWith(`${hostRoot}/`))
      return null;

    const suffix = normalizedHostPath.slice(hostRoot.length).replace(/^\/+/, "");
    return suffix.length === 0
      ? this.remoteWorkspaceFolder
      : path.posix.join(this.remoteWorkspaceFolder, suffix);
  }

  /**
   * Resolve cwd for container exec, filtering out unmappable host paths.
   * Only uses options.cwd if it looks like a valid container path (POSIX absolute, no Windows drive letters).
   */
  private resolveContainerCwd(optionsCwd: string | undefined, workspaceFolder: string): string {
    if (optionsCwd && this.looksLikeContainerPath(optionsCwd)) {
      return optionsCwd;
    }
    return this.remoteWorkspaceFolder ?? workspaceFolder;
  }

  /**
   * Check if a path looks like a valid container path (POSIX absolute, no Windows artifacts).
   */
  private looksLikeContainerPath(p: string): boolean {
    // Reject Windows drive letters (e.g., C:\, D:/)
    if (/^[A-Za-z]:/.test(p)) return false;
    // Reject backslashes (Windows path separators)
    if (p.includes("\\")) return false;
    // Must be absolute POSIX path
    return p.startsWith("/");
  }

  constructor(options: DevcontainerRuntimeOptions) {
    super();
    this.worktreeManager = new WorktreeManager(options.srcBaseDir);
    this.configPath = options.configPath;
    this.shareCredentials = options.shareCredentials ?? false;
  }

  getWorkspacePath(projectPath: string, workspaceName: string): string {
    return this.worktreeManager.getWorkspacePath(projectPath, workspaceName);
  }

  async createWorkspace(params: WorkspaceCreationParams): Promise<WorkspaceCreationResult> {
    return this.worktreeManager.createWorkspace({
      projectPath: params.projectPath,
      branchName: params.branchName,
      directoryName: params.directoryName,
      trunkBranch: params.trunkBranch,
      initLogger: params.initLogger,
      abortSignal: params.abortSignal,
      env: params.env,
      trusted: params.trusted,
    });
  }

  /**
   * Build and start the devcontainer after workspace creation.
   * This runs `devcontainer up` which builds the image and starts the container.
   */
  async postCreateSetup(params: WorkspaceInitParams): Promise<void> {
    const { workspacePath, initLogger, abortSignal, env } = params;

    initLogger.logStep("Building devcontainer...");

    this.lastCredentialEnv = env;
    this.currentWorkspacePath = workspacePath;
    this.refreshContainerRequirements(env);

    try {
      const result = await devcontainerUp({
        workspaceFolder: workspacePath,
        configPath: this.configPath,
        initLogger,
        abortSignal,
        additionalMounts: this.containerMounts.length > 0 ? this.containerMounts : undefined,
        remoteEnv: Object.keys(this.containerEnv).length > 0 ? this.containerEnv : undefined,
      });

      // Cache container info
      this.remoteWorkspaceFolder = result.remoteWorkspaceFolder;
      this.remoteUser = result.remoteUser;
      this.currentWorkspacePath = workspacePath;
      await this.fetchRemoteHome(abortSignal);

      await this.setupCredentials(env, abortSignal);

      initLogger.logStep("Devcontainer ready");
    } catch (error) {
      throw new Error(`Failed to start devcontainer: ${getErrorMessage(error)}`);
    }
  }

  /**
   * Run .xum/init hook inside the devcontainer.
   */
  async initWorkspace(params: WorkspaceInitParams): Promise<WorkspaceInitResult> {
    return runWorkspaceInitHook({
      params,
      runtimeType: "devcontainer",
      findHookRelativePath: () =>
        findInitHookRelativePath(this, this.remoteWorkspaceFolder ?? params.workspacePath),
      runHook: async ({ hookRelativePath, xumEnv, initLogger, abortSignal }) => {
        const containerWorkspacePath = this.remoteWorkspaceFolder ?? params.workspacePath;
        const hookPath = `${containerWorkspacePath}/${hookRelativePath}`;
        await runInitHookOnRuntime(
          this,
          hookPath,
          containerWorkspacePath,
          xumEnv,
          initLogger,
          abortSignal
        );
      },
    });
  }

  /**
   * Execute a command inside the devcontainer.
   * Overrides LocalBaseRuntime.exec() to use `devcontainer exec`.
   */
  override exec(command: string, options: ExecOptions): Promise<ExecStream> {
    const startTime = performance.now();

    // Short-circuit if already aborted
    if (options.abortSignal?.aborted) {
      throw new RuntimeError("Operation aborted before execution", "exec");
    }

    // Build devcontainer exec args
    const workspaceFolder = this.currentWorkspacePath;
    if (!workspaceFolder) {
      throw new RuntimeError("Devcontainer not initialized. Call ensureReady() first.", "exec");
    }

    const args = ["exec", "--workspace-folder", workspaceFolder];

    if (this.configPath) {
      args.push("--config", this.configPath);
    }

    // Merge cached container credential env + caller env + non-interactive vars.
    // Spread order: container env (lowest) < caller env < NON_INTERACTIVE (highest).
    const mappedPathEnv = Object.fromEntries(
      Object.entries(options.pathEnv ?? {}).map(([key, value]) => [key, this.mapPathForExec(value)])
    );
    const envVars = {
      ...this.containerEnv,
      ...options.env,
      ...mappedPathEnv,
      ...NON_INTERACTIVE_ENV_VARS,
    };
    for (const [key, value] of Object.entries(envVars)) {
      args.push("--remote-env", `${key}=${value}`);
    }

    // Build the full command with cd
    // Map host workspace path to container path; fall back to container workspace if unmappable
    const mappedCwd = options.cwd ? this.mapHostPathToContainer(options.cwd) : null;
    const cwd = mappedCwd ?? this.resolveContainerCwd(options.cwd, workspaceFolder);
    const pathEnvPrelude = Object.entries(mappedPathEnv)
      .map(([key, value]) =>
        buildShellPathExport(key, value, (envValue) => shescape.quote(envValue))
      )
      .join(" && ");
    const fullCommand = [`cd ${shescape.quote(cwd)}`, pathEnvPrelude, command]
      .filter(Boolean)
      .join(" && ");
    args.push("--", "bash", "-c", fullCommand);

    const childProcess = spawnDevcontainer(args, {
      stdio: ["pipe", "pipe", "pipe"],
      detached: true,
      windowsHide: true,
      cwd: workspaceFolder,
    });

    const disposable = new DisposableProcess(childProcess);

    // Register cleanup to kill process tree and force-close stdio on timeout/abort.
    disposable.addCleanup(() => {
      if (childProcess.pid === undefined) return;
      killProcessTree(childProcess.pid);
      forceCloseStdio(childProcess);
    });

    // Convert Node.js streams to Web Streams (casts required for ExecStream compatibility)
    // eslint-disable-next-line local/no-chained-type-assertions -- grandfathered when the rule was introduced; fix the underlying type instead of copying this pattern
    const stdout = Readable.toWeb(childProcess.stdout!) as unknown as ReadableStream<Uint8Array>;
    // eslint-disable-next-line local/no-chained-type-assertions -- grandfathered when the rule was introduced; fix the underlying type instead of copying this pattern
    const stderr = Readable.toWeb(childProcess.stderr!) as unknown as ReadableStream<Uint8Array>;
    // eslint-disable-next-line local/no-chained-type-assertions -- grandfathered when the rule was introduced; fix the underlying type instead of copying this pattern
    const stdin = Writable.toWeb(childProcess.stdin!) as unknown as WritableStream<Uint8Array>;

    let timedOut = false;
    let aborted = false;

    const exitCode = new Promise<number>((resolve, reject) => {
      childProcess.on("exit", (code) => {
        if (childProcess.pid !== undefined) {
          killProcessTree(childProcess.pid);
        }

        if (aborted || options.abortSignal?.aborted) {
          resolve(EXIT_CODE_ABORTED);
          return;
        }
        if (timedOut) {
          resolve(EXIT_CODE_TIMEOUT);
          return;
        }
        resolve(code ?? 0);
      });

      childProcess.on("error", (err) => {
        reject(
          new RuntimeError(`Failed to execute devcontainer exec: ${err.message}`, "exec", err)
        );
      });
    });

    const duration = exitCode.then(() => performance.now() - startTime);
    void exitCode.catch(() => undefined);
    void duration.catch(() => undefined);

    // Handle timeout
    let timeoutId: ReturnType<typeof setTimeout> | undefined;
    if (options.timeout && options.timeout > 0) {
      timeoutId = setTimeout(() => {
        timedOut = true;
        disposable[Symbol.dispose]();
      }, options.timeout * 1000);

      void exitCode
        .catch(() => undefined)
        .finally(() => {
          if (timeoutId) clearTimeout(timeoutId);
        });
    }

    // Handle abort signal
    const abortHandler = () => {
      aborted = true;
      disposable[Symbol.dispose]();
    };
    options.abortSignal?.addEventListener("abort", abortHandler, { once: true });
    if (options.abortSignal?.aborted) {
      abortHandler();
    }
    void exitCode
      .catch(() => undefined)
      .finally(() => {
        options.abortSignal?.removeEventListener("abort", abortHandler);
      });

    return Promise.resolve({
      stdout,
      stderr,
      stdin,
      exitCode,
      duration,
    });
  }

  override readFile(filePath: string, abortSignal?: AbortSignal): ReadableStream<Uint8Array> {
    const hostPath = this.resolveHostPathForMounted(filePath);
    if (hostPath) {
      return super.readFile(hostPath, abortSignal);
    }
    return readFileViaExec(
      filePath,
      (signal) =>
        this.exec(`cat "$${FILE_PATH_ENV}"`, {
          cwd: this.getContainerBasePath(),
          pathEnv: { [FILE_PATH_ENV]: filePath },
          timeout: 300,
          abortSignal: signal,
        }),
      abortSignal
    );
  }

  override writeFile(filePath: string, abortSignal?: AbortSignal): WritableStream<Uint8Array> {
    const hostPath = this.resolveHostPathForMounted(filePath);
    if (hostPath) {
      return super.writeFile(hostPath, abortSignal);
    }
    return writeFileViaExec(
      filePath,
      (signal) =>
        this.exec(
          `mkdir -p "$(dirname "$${FILE_PATH_ENV}")" && cat > "$${TEMP_FILE_PATH_ENV}" && mv "$${TEMP_FILE_PATH_ENV}" "$${FILE_PATH_ENV}"`,
          {
            cwd: this.getContainerBasePath(),
            pathEnv: {
              [FILE_PATH_ENV]: filePath,
              [TEMP_FILE_PATH_ENV]: getAtomicWriteTempPath(filePath),
            },
            timeout: 300,
            abortSignal: signal,
          }
        ),
      abortSignal
    );
  }

  override stat(filePath: string, abortSignal?: AbortSignal): Promise<FileStat> {
    const hostPath = this.resolveHostPathForMounted(filePath);
    if (hostPath) {
      return super.stat(hostPath, abortSignal);
    }
    return statViaExec(filePath, () =>
      this.exec(`${STAT_VIA_EXEC_COMMAND} "$${FILE_PATH_ENV}"`, {
        cwd: this.getContainerBasePath(),
        pathEnv: { [FILE_PATH_ENV]: filePath },
        timeout: 10,
        abortSignal,
      })
    );
  }

  override ensureDir(dirPath: string, abortSignal?: AbortSignal): Promise<void> {
    const hostPath = this.resolveHostPathForMounted(dirPath);
    if (hostPath) {
      return super.ensureDir(hostPath, abortSignal);
    }
    return ensureDirViaExec(dirPath, () =>
      this.exec(`mkdir -p "$${FILE_PATH_ENV}"`, {
        cwd: this.getContainerBasePath(),
        pathEnv: { [FILE_PATH_ENV]: dirPath },
        timeout: 10,
        abortSignal,
      })
    );
  }

  override async resolvePath(filePath: string): Promise<string> {
    let expanded = this.expandTildeForContainer(filePath);

    if (this.hasUnexpandedTilde(expanded)) {
      await this.fetchRemoteHome();
      if (this.remoteHomeDir) {
        expanded = filePath === "~" ? this.remoteHomeDir : this.remoteHomeDir + filePath.slice(1);
      } else {
        throw new RuntimeError(
          `Failed to resolve path ${filePath}: container home directory unavailable`,
          "exec"
        );
      }
    }

    // Resolve relative paths against container workspace (avoid host cwd leakage)
    if (!expanded.startsWith("/")) {
      const basePath = this.remoteWorkspaceFolder ?? "/";
      return path.posix.resolve(basePath, expanded);
    }

    // For absolute paths, resolve using posix (container is Linux)
    return path.posix.resolve(expanded);
  }

  override tempDir(): Promise<string> {
    const workspaceRoot = this.remoteWorkspaceFolder ?? this.currentWorkspacePath;
    if (!workspaceRoot) {
      return super.tempDir();
    }

    const tmpPath = this.remoteWorkspaceFolder
      ? path.posix.join(workspaceRoot, ".xum", "tmp")
      : path.join(workspaceRoot, ".xum", "tmp");
    return Promise.resolve(tmpPath);
  }

  /**
   * Ensure the devcontainer is ready for operations.
   * Runs `devcontainer up` which starts the container if stopped,
   * or rebuilds if the container was deleted.
   */
  override async ensureReady(options?: EnsureReadyOptions): Promise<EnsureReadyResult> {
    if (!this.currentWorkspacePath) {
      return {
        ready: false,
        error: "Workspace path not set. Call postCreateSetup() first.",
        errorType: "runtime_not_ready",
      };
    }

    const statusSink = options?.statusSink;
    statusSink?.({
      phase: "checking",
      runtimeType: "devcontainer",
      detail: "Checking repository...",
    });

    const hasRepo = await isGitRepository(this.currentWorkspacePath);
    if (!hasRepo) {
      statusSink?.({
        phase: "error",
        runtimeType: "devcontainer",
        detail: WORKSPACE_REPO_MISSING_ERROR,
      });
      return {
        ready: false,
        error: WORKSPACE_REPO_MISSING_ERROR,
        errorType: "runtime_not_ready",
      };
    }

    try {
      statusSink?.({
        phase: "starting",
        runtimeType: "devcontainer",
        detail: "Starting devcontainer...",
      });

      // Create a minimal logger for ensureReady (we don't want verbose output here)
      const silentLogger = {
        logStep: (_message: string) => {
          /* silent */
        },
        logStdout: (_line: string) => {
          /* silent */
        },
        logStderr: (line: string) => log.debug("devcontainer up stderr:", { line }),
        logComplete: (_exitCode: number) => {
          /* silent */
        },
      };

      this.refreshContainerRequirements();
      const result = await devcontainerUp({
        workspaceFolder: this.currentWorkspacePath,
        configPath: this.configPath,
        initLogger: silentLogger,
        abortSignal: options?.signal,
        additionalMounts: this.containerMounts.length > 0 ? this.containerMounts : undefined,
        remoteEnv: Object.keys(this.containerEnv).length > 0 ? this.containerEnv : undefined,
      });

      // Update cached info (container may have been rebuilt)
      this.remoteWorkspaceFolder = result.remoteWorkspaceFolder;
      this.remoteUser = result.remoteUser;
      await this.fetchRemoteHome(options?.signal);

      await this.setupCredentials(this.lastCredentialEnv, options?.signal);

      statusSink?.({ phase: "ready", runtimeType: "devcontainer" });
      return { ready: true };
    } catch (error) {
      const errorMsg = getErrorMessage(error);
      statusSink?.({ phase: "error", runtimeType: "devcontainer", detail: errorMsg });

      return {
        ready: false,
        error: errorMsg,
        errorType: "runtime_not_ready",
      };
    }
  }

  async renameWorkspace(
    projectPath: string,
    oldName: string,
    newName: string,
    _abortSignal?: AbortSignal,
    trusted?: boolean
  ): Promise<
    { success: true; oldPath: string; newPath: string } | { success: false; error: string }
  > {
    // Stop container before rename (container labels reference old path)
    const oldPath = this.getWorkspacePath(projectPath, oldName);
    await devcontainerDown(oldPath, this.configPath);

    // Rename worktree on host
    const result = await this.worktreeManager.renameWorkspace(
      projectPath,
      oldName,
      newName,
      trusted
    );

    if (result.success) {
      // Update current workspace path if this was the active workspace
      if (this.currentWorkspacePath === oldPath) {
        this.currentWorkspacePath = result.newPath;
      }
    }

    return result;
  }

  async deleteWorkspace(
    projectPath: string,
    workspaceName: string,
    force: boolean,
    _abortSignal?: AbortSignal,
    trusted?: boolean
  ): Promise<{ success: true; deletedPath: string } | { success: false; error: string }> {
    const workspacePath = this.getWorkspacePath(projectPath, workspaceName);

    // Stop and remove container (best-effort)
    try {
      await devcontainerDown(workspacePath, this.configPath);
    } catch (error) {
      log.debug("devcontainerDown failed (container may not exist):", { error });
    }

    // Delete worktree on host
    return this.worktreeManager.deleteWorkspace(projectPath, workspaceName, force, trusted);
  }

  async forkWorkspace(params: WorkspaceForkParams): Promise<WorkspaceForkResult> {
    // Fork creates a new worktree - container will be built on first ensureReady
    return this.worktreeManager.forkWorkspace(params);
  }

  /**
   * Set the current workspace path for exec operations.
   * Called by workspaceService when switching to an existing workspace.
   */
  setCurrentWorkspacePath(workspacePath: string): void {
    this.currentWorkspacePath = workspacePath;
    this.refreshContainerRequirements();
  }

  /**
   * Get the remote workspace folder path (inside container).
   */
  getRemoteWorkspaceFolder(): string | undefined {
    return this.remoteWorkspaceFolder;
  }
}

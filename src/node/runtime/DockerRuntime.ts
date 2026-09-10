/**
 * Docker runtime implementation that executes commands inside Docker containers.
 *
 * Features:
 * - Each workspace runs in its own container
 * - Container name derived from project+workspace name
 * - Uses docker exec for command execution
 * - Hardcoded paths: srcBaseDir=/src, bgOutputDir=/tmp/mux-bashes
 * - Managed lifecycle: container created/destroyed with workspace
 *
 * Extends RemoteRuntime for shared exec/file operations.
 */

import { spawn } from "child_process";
import { createHash } from "crypto";
import * as path from "path";
import * as fs from "fs/promises";
import * as os from "os";
import type {
  ExecOptions,
  WorkspaceCreationParams,
  WorkspaceCreationResult,
  WorkspaceInitParams,
  WorkspaceInitResult,
  WorkspaceForkParams,
  WorkspaceForkResult,
  InitLogger,
  EnsureReadyResult,
} from "./Runtime";
import { RuntimeError } from "./Runtime";
import { RemoteRuntime, type SpawnResult } from "./RemoteRuntime";
import { findInitHookRelativePath, runInitHookOnRuntime, runWorkspaceInitHook } from "./initHook";
import { getProjectName } from "@/node/utils/runtime/helpers";
import { getErrorMessage } from "@/common/utils/errors";
import { syncProjectViaGitBundle } from "./gitBundleSync";
import { gitNoHooksPrefix } from "@/node/utils/gitNoHooksEnv";
import {
  readHostGitconfig,
  resolveGhToken,
  resolveSshAgentForwarding,
} from "./credentialForwarding";
import { streamToString, shescape } from "./streamUtils";
import { syncRuntimeGitSubmodules } from "./submoduleSync";
import { resolveContainerCli } from "./containerCli";

/** Hardcoded source directory inside container */
const CONTAINER_SRC_DIR = "/src";

/**
 * Result of running a Docker command
 */
interface DockerCommandResult {
  exitCode: number;
  stdout: string;
  stderr: string;
}

/**
 * Sanitize container-provided uid/gid before embedding in host-side shell commands.
 * Container images can override `id`; only decimal numeric IDs are valid for chown.
 */
function sanitizeContainerUserId(rawValue: string): string {
  const trimmedValue = rawValue.trim();
  return /^\d+$/.test(trimmedValue) ? trimmedValue : "0";
}

interface ContainerUserInfo {
  uid: string;
  gid: string;
  home: string;
}

/** Result of checking if a container already exists and is valid for reuse */
type ContainerCheckResult =
  | { action: "skip" } // Valid forked container, skip setup
  | { action: "cleanup"; reason: string } // Exists but invalid, needs removal
  | { action: "create" }; // Doesn't exist, proceed to create

function runCommand(
  command: string,
  args: string[],
  options: { timeoutMs?: number; shell?: boolean; abortSignal?: AbortSignal } = {}
): Promise<DockerCommandResult> {
  return new Promise((resolve) => {
    let stdout = "";
    let stderr = "";
    let settled = false;

    if (options.abortSignal?.aborted) {
      resolve({ exitCode: -1, stdout, stderr: "Command aborted" });
      return;
    }

    const child = spawn(command, args, { shell: options.shell === true });

    const finish = (result: DockerCommandResult) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      options.abortSignal?.removeEventListener("abort", onAbort);
      resolve(result);
    };

    const timer = setTimeout(() => {
      child.kill();
      finish({ exitCode: -1, stdout, stderr: "Command timed out" });
    }, options.timeoutMs ?? 30000);

    const onAbort = () => {
      child.kill();
      finish({ exitCode: -1, stdout, stderr: "Command aborted" });
    };
    options.abortSignal?.addEventListener("abort", onAbort, { once: true });

    child.stdout?.on("data", (data: Buffer) => {
      stdout += data.toString();
    });

    child.stderr?.on("data", (data: Buffer) => {
      stderr += data.toString();
    });

    child.on("close", (code) => {
      finish({ exitCode: code ?? -1, stdout, stderr });
    });

    child.on("error", (err) => {
      finish({ exitCode: -1, stdout, stderr: err.message });
    });
  });
}

/**
 * Quote the container CLI for the host shell used by `shell: true`.
 * On Windows that shell is cmd.exe, where POSIX single quotes are literal
 * characters, so bare tokens (the common docker/podman case) pass through
 * unquoted and anything else is quoted per platform.
 */
function quoteCliForHostShell(cli: string): string {
  if (/^[A-Za-z0-9_.:/-]+$/.test(cli)) return cli;
  if (process.platform === "win32") {
    // cmd.exe expands %VAR% even in double quotes, so escape literal % as %%.
    return `"${cli.replace(/%/g, "%%").replace(/"/g, '""')}"`;
  }
  return shescape.quote(cli);
}

/**
 * Run a Docker-compatible CLI command and return result.
 * The command contains CLI arguments without the binary. Unlike execAsync, this always resolves
 * (never rejects) and returns the exit code.
 */
async function runDockerCommand(
  command: string,
  timeoutMs = 30000,
  abortSignal?: AbortSignal
): Promise<DockerCommandResult> {
  const cli = await resolveContainerCli();
  return runCommand(`${quoteCliForHostShell(cli)} ${command}`, [], {
    timeoutMs,
    shell: true,
    abortSignal,
  });
}

/** Run a container CLI command with array args to avoid shell interpolation for paths. */
async function runContainerSpawnCommand(
  args: string[],
  timeoutMs = 30000,
  abortSignal?: AbortSignal
): Promise<DockerCommandResult> {
  return runCommand(await resolveContainerCli(), args, { timeoutMs, abortSignal });
}

/**
 * Build Docker args for credential sharing.
 * Forwards SSH agent into the container.
 * Note: ~/.gitconfig is streamed into the container after creation so gh can modify it.
 * Uses agent forwarding only (no ~/.ssh mount) to avoid passphrase/permission issues.
 */
function buildCredentialArgs(): string[] {
  const args: string[] = [];

  // SSH agent forwarding (no ~/.ssh mount - causes passphrase/permission issues)
  const sshForwarding = resolveSshAgentForwarding("/ssh-agent");
  if (sshForwarding) {
    args.push("-v", `${sshForwarding.hostSocketPath}:${sshForwarding.targetSocketPath}:ro`);
    args.push("-e", `SSH_AUTH_SOCK=${sshForwarding.targetSocketPath}`);
  }

  // GitHub CLI auth via token
  const ghToken = resolveGhToken();
  if (ghToken) {
    args.push("-e", `GH_TOKEN=${ghToken}`);
  }

  return args;
}

/**
 * Run docker run with streaming output (for image pull progress).
 * Streams stdout/stderr to initLogger for visibility during image pulls.
 */
async function streamDockerRun(
  containerName: string,
  image: string,
  initLogger: InitLogger,
  options?: { abortSignal?: AbortSignal; shareCredentials?: boolean; timeoutMs?: number }
): Promise<DockerCommandResult> {
  const { abortSignal, shareCredentials, timeoutMs = 600000 } = options ?? {};
  const cli = await resolveContainerCli();

  return new Promise((resolve) => {
    let stdout = "";
    let stderr = "";
    let resolved = false;

    const finish = (result: DockerCommandResult) => {
      if (resolved) return;
      resolved = true;
      clearTimeout(timer);
      abortSignal?.removeEventListener("abort", abortHandler);
      resolve(result);
    };

    // Build docker run args
    const dockerArgs = ["run", "-d", "--name", containerName];
    if (shareCredentials) {
      dockerArgs.push(...buildCredentialArgs());
    }
    dockerArgs.push(image, "sleep", "infinity");

    // Use spawn for streaming output - array args don't need shell escaping
    const child = spawn(cli, dockerArgs);

    const timer = setTimeout(() => {
      child.kill();
      void runDockerCommand(`rm -f ${containerName}`, 10000);
      finish({ exitCode: -1, stdout, stderr: "Container creation timed out" });
    }, timeoutMs);

    const abortHandler = () => {
      child.kill();
      // Container might have been created before abort - clean it up
      void runDockerCommand(`rm -f ${containerName}`, 10000);
      finish({ exitCode: -1, stdout, stderr: "Aborted" });
    };
    abortSignal?.addEventListener("abort", abortHandler);

    child.stdout?.on("data", (data: Buffer) => {
      const text = data.toString();
      stdout += text;
      // docker run -d outputs container ID to stdout, not useful to stream
    });

    child.stderr?.on("data", (data: Buffer) => {
      const text = data.toString();
      stderr += text;
      // Stream pull progress to init logger
      for (const line of text.split("\n").filter((l) => l.trim())) {
        initLogger.logStdout(line);
      }
    });

    child.on("close", (code) => {
      finish({ exitCode: code ?? -1, stdout, stderr });
    });

    child.on("error", (err) => {
      finish({ exitCode: -1, stdout, stderr: err.message });
    });
  });
}

export interface DockerRuntimeConfig {
  /** Docker image to use (e.g., node:20) */
  image: string;
  /**
   * Container name for existing workspaces.
   * When creating a new workspace, this is computed during createWorkspace().
   * When recreating runtime for an existing workspace, this should be passed
   * to allow exec operations without calling createWorkspace again.
   */
  containerName?: string;
  /** Forward SSH agent and copy ~/.gitconfig into container */
  shareCredentials?: boolean;
}

/**
 * Sanitize a string for use in Docker container names.
 * Docker names must match: [a-zA-Z0-9][a-zA-Z0-9_.-]*
 */
function sanitizeContainerName(name: string): string {
  return name
    .replace(/[^a-zA-Z0-9_.-]/g, "-")
    .replace(/^[^a-zA-Z0-9]+/, "")
    .replace(/-+/g, "-");
}

/**
 * Generate container name from project path and workspace name.
 * Format: mux-{projectName}-{workspaceName}-{hash}
 * Hash suffix prevents collisions (e.g., feature/foo vs feature-foo)
 */
export function getContainerName(projectPath: string, workspaceName: string): string {
  const projectName = getProjectName(projectPath);
  const hash = createHash("sha256")
    .update(`${projectPath}:${workspaceName}`)
    .digest("hex")
    .slice(0, 6);
  // Reserve 7 chars for "-{hash}", leaving 56 for base
  const base = sanitizeContainerName(`mux-${projectName}-${workspaceName}`).slice(0, 56);
  return `${base}-${hash}`;
}

/**
 * Docker runtime implementation that executes commands inside Docker containers.
 * Extends RemoteRuntime for shared exec/file operations.
 */
export class DockerRuntime extends RemoteRuntime {
  private readonly config: DockerRuntimeConfig;
  /** Container name - set during construction (for existing) or createWorkspace (for new) */
  private containerName?: string;
  /** Container home - detected after container creation/start */
  private containerHome?: string;

  constructor(config: DockerRuntimeConfig) {
    super();
    this.config = config;
    // If container name is provided (existing workspace), store it
    if (config.containerName) {
      this.containerName = config.containerName;
    }
  }

  /**
   * Get the container name (if set)
   */
  public getContainerName(): string | undefined {
    return this.containerName;
  }

  /**
   * Get Docker image name
   */
  public getImage(): string {
    return this.config.image;
  }

  // ===== RemoteRuntime abstract method implementations =====

  protected readonly commandPrefix = "Docker";

  protected getBasePath(): string {
    return CONTAINER_SRC_DIR;
  }

  protected quoteForRemote(filePath: string): string {
    // Expand ~ to container user's home (detected at runtime, defaults to /root)
    const home = this.containerHome ?? "/root";
    const expanded = filePath.startsWith("~/")
      ? `${home}/${filePath.slice(2)}`
      : filePath === "~"
        ? home
        : filePath;
    return shescape.quote(expanded);
  }

  protected cdCommand(cwd: string): string {
    return `cd ${shescape.quote(cwd)}`;
  }

  protected async spawnRemoteProcess(
    fullCommand: string,
    _options: ExecOptions & { deadlineMs?: number }
  ): Promise<SpawnResult> {
    // Verify container name is available
    if (!this.containerName) {
      throw new RuntimeError(
        "Docker runtime not initialized with container name. " +
          "For existing workspaces, pass containerName in config. " +
          "For new workspaces, call createWorkspace first.",
        "exec"
      );
    }

    // Build docker exec args.
    //
    // Note: RemoteRuntime.exec() injects env vars via `export ...`, so we don't need `docker exec -e`
    // here (and avoiding `-e` keeps quoting behavior consistent with SSH).
    const dockerArgs: string[] = ["exec", "-i", this.containerName, "bash", "-c", fullCommand];

    // Spawn docker exec command
    const process = spawn(await resolveContainerCli(), dockerArgs, {
      stdio: ["pipe", "pipe", "pipe"],
      windowsHide: true,
    });

    return { process };
  }

  /**
   * Override buildWriteCommand to preserve symlinks and file permissions.
   *
   * This matches SSHRuntime behavior: write through the symlink to the final target,
   * while keeping the symlink itself intact.
   */
  protected buildWriteCommand(quotedPath: string, quotedTempPath: string): string {
    // Default to 644 (world-readable) for new files, particularly important for
    // plan files in /var/mux which need to be readable by VS Code Dev Containers
    return `RESOLVED=$(readlink -f ${quotedPath} 2>/dev/null || echo ${quotedPath}) && PERMS=$(stat -c '%a' "$RESOLVED" 2>/dev/null || echo 644) && mkdir -p $(dirname "$RESOLVED") && cat > ${quotedTempPath} && chmod "$PERMS" ${quotedTempPath} && mv ${quotedTempPath} "$RESOLVED"`;
  }
  // ===== Runtime interface implementations =====

  resolvePath(filePath: string): Promise<string> {
    // DockerRuntime uses a fixed workspace base (/src), but we still want reasonable shell-style
    // behavior for callers that pass "~" or "~/...".
    //
    // NOTE: Some base images (e.g., codercom/*-base) run as a non-root user (like "coder"), so
    // "~" should resolve to that user's home (e.g., /home/coder), not /root.
    const home = this.containerHome ?? "/root";

    if (filePath === "~") {
      return Promise.resolve(home);
    }
    if (filePath.startsWith("~/")) {
      return Promise.resolve(path.posix.join(home, filePath.slice(2)));
    }

    return Promise.resolve(
      filePath.startsWith("/") ? filePath : path.posix.join(CONTAINER_SRC_DIR, filePath)
    );
  }

  getWorkspacePath(_projectPath: string, _workspaceName: string): string {
    // For Docker, workspace path is always /src inside the container
    return CONTAINER_SRC_DIR;
  }

  async createWorkspace(params: WorkspaceCreationParams): Promise<WorkspaceCreationResult> {
    const { projectPath, directoryName } = params;

    // Container identity should follow the workspace entry name rather than the git branch.
    // The two are usually equal today, but the runtime contract keeps them distinct.
    const containerName = getContainerName(projectPath, directoryName);

    // Check if container already exists (collision detection)
    const checkResult = await runDockerCommand(`inspect ${containerName}`, 10000);
    if (checkResult.exitCode === 0) {
      return {
        success: false,
        error: `Workspace already exists: container ${containerName}`,
      };
    }
    // Distinguish "container doesn't exist" from actual Docker errors
    if (!checkResult.stderr.toLowerCase().includes("no such object")) {
      return {
        success: false,
        error: `Docker error: ${checkResult.stderr || checkResult.stdout || "unknown error"}`,
      };
    }

    // Store container name - actual container creation happens in postCreateSetup
    // so that image pull progress is visible in the init section
    this.containerName = containerName;

    return {
      success: true,
      workspacePath: CONTAINER_SRC_DIR,
    };
  }

  /**
   * Post-create setup: provision container OR detect fork and setup credentials.
   * Runs after mux persists workspace metadata so build logs stream to UI in real-time.
   *
   * Handles ALL environment setup:
   * - Fresh workspace: provisions container (create, sync, checkout, credentials)
   * - Fork: detects existing container, logs "from fork", sets up credentials
   * - Stale container: removes and re-provisions
   *
   * After this completes, the container is ready for initWorkspace() to run the hook.
   */
  async postCreateSetup(params: WorkspaceInitParams): Promise<void> {
    const {
      projectPath,
      branchName,
      trunkBranch,
      workspacePath,
      initLogger,
      abortSignal,
      env,
      skipInitHook,
    } = params;

    if (!this.containerName) {
      throw new Error("Container not initialized. Call createWorkspace first.");
    }
    const containerName = this.containerName;

    // Check if container already exists (e.g., from successful fork or aborted previous attempt)
    const containerCheck = await this.checkExistingContainer(
      containerName,
      workspacePath,
      branchName
    );
    switch (containerCheck.action) {
      case "skip":
        // Fork path: container already valid, just log and setup credentials
        initLogger.logStep(
          skipInitHook
            ? "Container already running (from fork), skipping init hook..."
            : "Container already running (from fork), running init hook..."
        );
        await this.ensureContainerUserInfo(containerName, abortSignal);
        await this.setupCredentials(env, abortSignal);
        return;
      case "cleanup":
        initLogger.logStep(containerCheck.reason);
        await runDockerCommand(`rm -f ${containerName}`, 10000);
        break;
      case "create":
        break;
    }

    // Provision container (throws on error - caller handles)
    await this.provisionContainer({
      containerName,
      projectPath,
      workspacePath,
      branchName,
      trunkBranch,
      initLogger,
      abortSignal,
      env,
      trusted: params.trusted,
    });
  }

  /**
   * Initialize workspace by running .xum/init hook.
   * Assumes postCreateSetup() has already been called to provision/prepare the container.
   *
   * This method ONLY runs the hook - all container provisioning and credential setup
   * is handled by postCreateSetup().
   */
  async initWorkspace(params: WorkspaceInitParams): Promise<WorkspaceInitResult> {
    if (!this.containerName) {
      return {
        success: false,
        error: "Container not initialized. Call createWorkspace first.",
      };
    }

    // Do NOT delete container on hook failure - user can debug.
    return runWorkspaceInitHook({
      params,
      runtimeType: "docker",
      findHookRelativePath: () => findInitHookRelativePath(this, params.workspacePath),
      runHook: async ({ hookRelativePath, xumEnv, initLogger, abortSignal }) => {
        const hookPath = `${params.workspacePath}/${hookRelativePath}`;
        await runInitHookOnRuntime(
          this,
          hookPath,
          params.workspacePath,
          xumEnv,
          initLogger,
          abortSignal
        );
      },
    });
  }

  /**
   * Check if a container already exists and whether it's valid for reuse.
   * Returns action to take: skip setup, cleanup invalid container, or create new.
   */
  protected async checkExistingContainer(
    containerName: string,
    workspacePath: string,
    branchName: string
  ): Promise<ContainerCheckResult> {
    const exists = await runDockerCommand(`inspect ${containerName}`, 10000);
    if (exists.exitCode !== 0) return { action: "create" };

    const isRunning = await runDockerCommand(
      `inspect -f '{{.State.Running}}' ${containerName}`,
      10000
    );
    if (isRunning.exitCode !== 0 || isRunning.stdout.trim() !== "true") {
      return { action: "cleanup", reason: "Removing stale container from previous attempt..." };
    }

    // Container running - validate it has an initialized git repo
    const gitCheck = await runDockerCommand(
      `exec ${containerName} test -d ${workspacePath}/.git`,
      5000
    );
    if (gitCheck.exitCode !== 0) {
      return {
        action: "cleanup",
        reason: "Container exists but repo not initialized, recreating...",
      };
    }

    // Verify correct branch is checked out
    // (handles edge case: crash after clone but before checkout left container on wrong branch)
    const branchCheck = await runDockerCommand(
      `exec ${containerName} git -C ${workspacePath} rev-parse --abbrev-ref HEAD`,
      5000
    );
    if (branchCheck.exitCode !== 0 || branchCheck.stdout.trim() !== branchName) {
      return { action: "cleanup", reason: "Container exists but wrong branch, recreating..." };
    }

    return { action: "skip" };
  }

  protected async detectContainerUser(
    containerName: string,
    abortSignal?: AbortSignal
  ): Promise<ContainerUserInfo> {
    const [uidResult, gidResult, homeResult] = await Promise.all([
      runDockerCommand(`exec ${containerName} id -u`, 5000, abortSignal),
      runDockerCommand(`exec ${containerName} id -g`, 5000, abortSignal),
      runDockerCommand(`exec ${containerName} sh -c 'echo $HOME'`, 5000, abortSignal),
    ]);

    return {
      uid: sanitizeContainerUserId(uidResult.stdout),
      gid: sanitizeContainerUserId(gidResult.stdout),
      home: homeResult.stdout.trim() || "/root",
    };
  }

  private async ensureContainerUserInfo(
    containerName: string,
    abortSignal?: AbortSignal
  ): Promise<void> {
    if (!this.containerHome) {
      this.storeContainerUserInfo(await this.detectContainerUser(containerName, abortSignal));
    }
  }

  private storeContainerUserInfo(userInfo: ContainerUserInfo): void {
    this.containerHome = userInfo.home;
  }

  private prepareWorkspaceDirectories(
    containerName: string,
    userInfo: ContainerUserInfo,
    abortSignal?: AbortSignal
  ): Promise<DockerCommandResult> {
    return runDockerCommand(
      `exec --user root ${containerName} sh -c 'mkdir -p ${CONTAINER_SRC_DIR} /var/mux/plans && chown ${userInfo.uid}:${userInfo.gid} ${CONTAINER_SRC_DIR} /var/mux /var/mux/plans'`,
      10000,
      abortSignal
    );
  }

  /**
   * Copy gitconfig and configure gh CLI credential helper in container.
   * Called for both new containers and reused forked containers.
   */
  private async setupCredentials(
    env?: Record<string, string>,
    abortSignal?: AbortSignal
  ): Promise<void> {
    if (!this.config.shareCredentials) return;

    if (abortSignal?.aborted) {
      throw new RuntimeError("Operation aborted before credential setup", "exec");
    }

    // Copy rather than mount so gh can modify the file. exec runs as the container's
    // default user, so $HOME and file ownership are correct for non-root images.
    const gitconfigContents = await readHostGitconfig();
    if (gitconfigContents) {
      const stream = await this.exec('cat > "$HOME/.gitconfig"', {
        cwd: "/",
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

    // Configure gh CLI as git credential helper if GH_TOKEN is available
    // GH_TOKEN can come from project secrets (env) or host environment (buildCredentialArgs)
    const ghToken = resolveGhToken(env);
    if (ghToken) {
      const stream = await this.exec("command -v gh >/dev/null && gh auth setup-git || true", {
        cwd: "/",
        timeout: 30,
        env: { GH_TOKEN: ghToken },
        abortSignal,
      });
      await stream.stdin.close();
      await stream.exitCode;
    }
  }

  /**
   * Provision container: create, sync project, checkout branch.
   * Throws on error (does not call logComplete - caller handles that).
   * Used by postCreateSetup() for streaming logs before initWorkspace().
   */
  private async provisionContainer(params: {
    containerName: string;
    projectPath: string;
    workspacePath: string;
    branchName: string;
    trunkBranch: string;
    initLogger: InitLogger;
    abortSignal?: AbortSignal;
    env?: Record<string, string>;
    trusted?: boolean;
  }): Promise<void> {
    const {
      containerName,
      projectPath,
      workspacePath,
      branchName,
      trunkBranch,
      initLogger,
      abortSignal,
      env,
    } = params;

    // 1. Create container (with image pull if needed)
    initLogger.logStep(`Creating container from ${this.config.image}...`);

    if (abortSignal?.aborted) {
      throw new Error("Workspace creation aborted");
    }

    // Create and start container with streaming output for image pull progress
    const runResult = await streamDockerRun(containerName, this.config.image, initLogger, {
      abortSignal,
      shareCredentials: this.config.shareCredentials,
    });
    if (runResult.exitCode !== 0) {
      await runDockerCommand(`rm -f ${containerName}`, 10000);
      throw new Error(`Failed to create container: ${runResult.stderr}`);
    }

    // Detect container's default user (may be non-root, e.g., codercom/enterprise-base runs as "coder")
    const containerUser = await this.detectContainerUser(containerName, abortSignal);
    this.storeContainerUserInfo(containerUser);

    // Create /src directory and /var/mux/plans in container.
    // /var/mux is used instead of ~/.xum because /root has 700 permissions,
    // which makes it inaccessible to VS Code Dev Containers (non-root user).
    initLogger.logStep("Preparing workspace directory...");
    const mkdirResult = await this.prepareWorkspaceDirectories(
      containerName,
      containerUser,
      abortSignal
    );
    if (mkdirResult.exitCode !== 0) {
      await runDockerCommand(`rm -f ${containerName}`, 10000);
      throw new Error(`Failed to create workspace directory: ${mkdirResult.stderr}`);
    }

    initLogger.logStep("Container ready");

    // Setup credentials (gitconfig + gh auth)
    await this.setupCredentials(env, abortSignal);

    // 2. Sync project to container using git bundle + docker cp
    initLogger.logStep("Syncing project files to container...");
    try {
      await this.syncProjectToContainer(
        projectPath,
        containerName,
        workspacePath,
        initLogger,
        abortSignal,
        params.trusted
      );
    } catch (error) {
      await runDockerCommand(`rm -f ${containerName}`, 10000);
      throw new Error(`Failed to sync project: ${getErrorMessage(error)}`);
    }
    initLogger.logStep("Files synced successfully");

    // 3. Checkout branch
    // Disable git hooks for untrusted projects (prevents post-checkout execution)
    const nhp = gitNoHooksPrefix(params.trusted);
    initLogger.logStep(`Checking out branch: ${branchName}`);
    const checkoutCmd = `${nhp}git checkout ${shescape.quote(branchName)} 2>/dev/null || ${nhp}git checkout -b ${shescape.quote(branchName)} ${shescape.quote(trunkBranch)}`;

    const checkoutStream = await this.exec(checkoutCmd, {
      cwd: workspacePath,
      timeout: 300,
      abortSignal,
    });

    const [stdout, stderr, exitCode] = await Promise.all([
      streamToString(checkoutStream.stdout),
      streamToString(checkoutStream.stderr),
      checkoutStream.exitCode,
    ]);

    if (exitCode !== 0) {
      await runDockerCommand(`rm -f ${containerName}`, 10000);
      throw new Error(`Failed to checkout branch: ${stderr || stdout}`);
    }
    initLogger.logStep("Branch checked out successfully");

    await this.materializeCheckedOutWorkspace({
      containerName,
      workspacePath,
      initLogger,
      abortSignal,
      env,
      trusted: params.trusted,
    });
  }

  private async materializeCheckedOutWorkspace(args: {
    containerName: string;
    workspacePath: string;
    initLogger: InitLogger;
    abortSignal?: AbortSignal;
    env?: Record<string, string>;
    trusted?: boolean;
  }): Promise<void> {
    try {
      // Container provisioning owns checkout completeness so initWorkspace can focus on
      // running repo-controlled hooks against an already-materialized source tree.
      await syncRuntimeGitSubmodules({
        runtime: this,
        workspacePath: args.workspacePath,
        initLogger: args.initLogger,
        abortSignal: args.abortSignal,
        env: args.env,
        trusted: args.trusted,
      });
    } catch (error) {
      try {
        await this.removeProvisioningContainer(args.containerName);
      } catch (cleanupError) {
        throw new Error(
          `${getErrorMessage(error)} (cleanup failed: ${getErrorMessage(cleanupError)})`
        );
      }
      throw error;
    }
  }

  private async removeProvisioningContainer(containerName: string): Promise<void> {
    const removeResult = await runDockerCommand(`rm -f ${containerName}`, 10000);
    if (removeResult.exitCode !== 0) {
      throw new Error(removeResult.stderr || removeResult.stdout || "docker rm failed");
    }
  }

  private async syncProjectToContainer(
    projectPath: string,
    containerName: string,
    workspacePath: string,
    initLogger: InitLogger,
    abortSignal?: AbortSignal,
    trusted?: boolean
  ): Promise<void> {
    const timestamp = Date.now();
    const bundleFilename = `mux-bundle-${timestamp}.bundle`;
    const remoteBundlePath = `/tmp/${bundleFilename}`;
    // Use os.tmpdir() for host path (Windows doesn't have /tmp)
    const localBundlePath = path.join(os.tmpdir(), bundleFilename);

    await syncProjectViaGitBundle({
      projectPath,
      workspacePath,
      remoteTmpDir: "/tmp",
      remoteBundlePath,
      exec: (command, options) => this.exec(command, options),
      quoteRemotePath: (path) => this.quoteForRemote(path),
      initLogger,
      abortSignal,
      cloneStep: "Cloning repository in container...",
      trusted,
      createRemoteBundle: async ({ remoteBundlePath, initLogger, abortSignal }) => {
        try {
          if (abortSignal?.aborted) {
            throw new Error("Sync operation aborted before starting");
          }

          const bundleResult = await runCommand(
            `git -C "${projectPath}" bundle create "${localBundlePath}" --all`,
            [],
            { timeoutMs: 300000, shell: true }
          );

          if (bundleResult.exitCode !== 0) {
            throw new Error(`Failed to create bundle: ${bundleResult.stderr}`);
          }

          initLogger.logStep("Copying bundle to container...");
          const copyResult = await runDockerCommand(
            `cp "${localBundlePath}" ${containerName}:${remoteBundlePath}`,
            300000
          );

          if (copyResult.exitCode !== 0) {
            throw new Error(`Failed to copy bundle: ${copyResult.stderr}`);
          }

          return {
            cleanupLocal: async () => {
              await fs.rm(localBundlePath, { force: true }).catch(() => undefined);
            },
          };
        } catch (error) {
          await fs.rm(localBundlePath, { force: true }).catch(() => undefined);
          throw error;
        }
      },
    });
  }

  // eslint-disable-next-line @typescript-eslint/require-await
  async renameWorkspace(
    _projectPath: string,
    _oldName: string,
    _newName: string,
    _abortSignal?: AbortSignal
  ): Promise<
    { success: true; oldPath: string; newPath: string } | { success: false; error: string }
  > {
    // For Docker, renaming means:
    // 1. Create new container with new name
    // 2. Copy /src from old container to new
    // 3. Remove old container
    // This is complex and error-prone, so we don't support it for now
    return {
      success: false,
      error:
        "Renaming Docker workspaces is not supported. Create a new workspace and delete the old one.",
    };
  }

  async deleteWorkspace(
    projectPath: string,
    workspaceName: string,
    force: boolean,
    abortSignal?: AbortSignal
  ): Promise<{ success: true; deletedPath: string } | { success: false; error: string }> {
    if (abortSignal?.aborted) {
      return { success: false, error: "Delete operation aborted" };
    }

    const containerName = getContainerName(projectPath, workspaceName);
    const deletedPath = CONTAINER_SRC_DIR;

    try {
      // Check if container exists
      const inspectResult = await runDockerCommand(`inspect ${containerName}`, 10000);

      if (inspectResult.exitCode !== 0) {
        // Only treat as "doesn't exist" if Docker says so
        if (inspectResult.stderr.toLowerCase().includes("no such object")) {
          return { success: true, deletedPath };
        }
        return {
          success: false,
          error: `Docker error: ${inspectResult.stderr || inspectResult.stdout || "unknown error"}`,
        };
      }

      if (!force) {
        // Check if container is already running before we start it
        const wasRunning = await runDockerCommand(
          `inspect -f '{{.State.Running}}' ${containerName}`,
          10000
        );
        const containerWasRunning =
          wasRunning.exitCode === 0 && wasRunning.stdout.trim() === "true";

        // Start container if stopped (docker start is idempotent - succeeds if already running)
        const startResult = await runDockerCommand(`start ${containerName}`, 30000);
        if (startResult.exitCode !== 0) {
          // Container won't start - skip dirty checks, allow deletion
          // (container is broken/orphaned, user likely wants to clean up)
        } else {
          // Helper to stop container if we started it (don't leave it running on check failure)
          const stopIfWeStartedIt = async () => {
            if (!containerWasRunning) {
              await runDockerCommand(`stop ${containerName}`, 10000);
            }
          };

          // Check for uncommitted changes
          const checkResult = await runDockerCommand(
            `exec ${containerName} bash -c 'cd ${CONTAINER_SRC_DIR} && git diff --quiet --exit-code && git diff --quiet --cached --exit-code'`,
            10000
          );

          if (checkResult.exitCode !== 0) {
            await stopIfWeStartedIt();
            return {
              success: false,
              error: "Workspace contains uncommitted changes. Use force flag to delete anyway.",
            };
          }

          // Check for unpushed commits (only if remotes exist - repos with no remotes would show all commits)
          const hasRemotes = await runDockerCommand(
            `exec ${containerName} bash -c 'cd ${CONTAINER_SRC_DIR} && git remote | grep -q .'`,
            10000
          );
          if (hasRemotes.exitCode === 0) {
            const unpushedResult = await runDockerCommand(
              `exec ${containerName} bash -c 'cd ${CONTAINER_SRC_DIR} && git log --branches --not --remotes --oneline'`,
              10000
            );

            if (unpushedResult.exitCode === 0 && unpushedResult.stdout.trim()) {
              await stopIfWeStartedIt();
              return {
                success: false,
                error: `Workspace contains unpushed commits:\n\n${unpushedResult.stdout.trim()}`,
              };
            }
          }
        }
      }

      // Stop and remove container
      const rmResult = await runDockerCommand(`rm -f ${containerName}`, 30000);

      if (rmResult.exitCode !== 0) {
        return {
          success: false,
          error: `Failed to remove container: ${rmResult.stderr}`,
        };
      }

      return { success: true, deletedPath };
    } catch (error) {
      return { success: false, error: `Failed to delete workspace: ${getErrorMessage(error)}` };
    }
  }

  async forkWorkspace(params: WorkspaceForkParams): Promise<WorkspaceForkResult> {
    const { projectPath, sourceWorkspaceName, newWorkspaceName, initLogger, abortSignal } = params;
    const throwIfAborted = () => {
      if (abortSignal?.aborted) {
        throw new Error("Docker workspace fork aborted");
      }
    };

    const srcContainerName = getContainerName(projectPath, sourceWorkspaceName);
    const destContainerName = getContainerName(projectPath, newWorkspaceName);
    const hostTempPath = path.join(os.tmpdir(), `mux-fork-${Date.now()}.bundle`);
    const containerBundlePath = "/tmp/fork.bundle";
    let destContainerCreated = false;
    let forkSucceeded = false;

    try {
      throwIfAborted();

      // 1. Verify source container exists
      const srcCheck = await runDockerCommand(`inspect ${srcContainerName}`, 10000, abortSignal);
      if (srcCheck.exitCode !== 0) {
        return {
          success: false,
          error: `Source workspace container not found: ${srcContainerName}`,
        };
      }

      // 2. Get current branch from source
      initLogger.logStep("Detecting source workspace branch...");
      throwIfAborted();
      const branchResult = await runDockerCommand(
        `exec ${srcContainerName} git -C ${CONTAINER_SRC_DIR} branch --show-current`,
        30000,
        abortSignal
      );
      const sourceBranch = branchResult.stdout.trim();
      if (branchResult.exitCode !== 0 || sourceBranch.length === 0) {
        return {
          success: false,
          error: "Failed to detect branch in source workspace (detached HEAD?)",
        };
      }

      // 3. Create git bundle inside source container
      initLogger.logStep("Creating git bundle from source...");
      throwIfAborted();
      const bundleResult = await runDockerCommand(
        `exec ${srcContainerName} git -C ${CONTAINER_SRC_DIR} bundle create ${containerBundlePath} --all`,
        300000,
        abortSignal
      );
      if (bundleResult.exitCode !== 0) {
        return { success: false, error: `Failed to create git bundle: ${bundleResult.stderr}` };
      }

      // 4. Transfer bundle to host
      initLogger.logStep("Copying bundle from source container...");
      throwIfAborted();
      const cpOutResult = await runContainerSpawnCommand(
        ["cp", `${srcContainerName}:${containerBundlePath}`, hostTempPath],
        300000,
        abortSignal
      );
      if (cpOutResult.exitCode !== 0) {
        return {
          success: false,
          error: `Failed to copy bundle from source: ${cpOutResult.stderr}`,
        };
      }

      // 5. Create destination container
      initLogger.logStep(`Creating container: ${destContainerName}...`);
      const dockerArgs = ["run", "-d", "--name", destContainerName];
      if (this.config.shareCredentials) {
        dockerArgs.push(...buildCredentialArgs());
      }
      dockerArgs.push(this.config.image, "sleep", "infinity");
      throwIfAborted();
      const runResult = await runContainerSpawnCommand(dockerArgs, 60000, abortSignal);
      if (runResult.exitCode !== 0) {
        // Handle TOCTOU race - container may have been created between check and run
        if (runResult.stderr.includes("already in use")) {
          return {
            success: false,
            error: `Workspace already exists: container ${destContainerName}`,
          };
        }
        return { success: false, error: `Failed to create container: ${runResult.stderr}` };
      }
      destContainerCreated = true;

      // 5b. Detect container user and prepare directories (may be non-root)
      throwIfAborted();
      const destUser = await this.detectContainerUser(destContainerName, abortSignal);
      const mkdirResult = await this.prepareWorkspaceDirectories(
        destContainerName,
        destUser,
        abortSignal
      );
      if (mkdirResult.exitCode !== 0) {
        return {
          success: false,
          error: `Failed to prepare workspace directory: ${mkdirResult.stderr}`,
        };
      }

      // 6. Copy bundle into destination and clone
      initLogger.logStep("Copying bundle to destination container...");
      throwIfAborted();
      const cpInResult = await runContainerSpawnCommand(
        ["cp", hostTempPath, `${destContainerName}:${containerBundlePath}`],
        300000,
        abortSignal
      );
      if (cpInResult.exitCode !== 0) {
        return {
          success: false,
          error: `Failed to copy bundle to destination: ${cpInResult.stderr}`,
        };
      }

      initLogger.logStep("Cloning repository in destination...");
      // Disable git hooks inside the container unless gitHooksAllowed (docker
      // exec has no shell, so the assignments need an explicit env wrapper).
      const cloneNhp = gitNoHooksPrefix(params.trusted);
      const noHooksEnvCmd = cloneNhp === "" ? "" : `env ${cloneNhp}`;
      throwIfAborted();
      const cloneResult = await runDockerCommand(
        `exec ${destContainerName} ${noHooksEnvCmd}git clone ${containerBundlePath} ${CONTAINER_SRC_DIR}`,
        300000,
        abortSignal
      );
      if (cloneResult.exitCode !== 0) {
        return { success: false, error: `Failed to clone from bundle: ${cloneResult.stderr}` };
      }

      // Ensure /src is owned by the container user (git clone may create as current user)
      const chownResult = await runDockerCommand(
        `exec --user root ${destContainerName} chown -R ${destUser.uid}:${destUser.gid} ${CONTAINER_SRC_DIR}`,
        30000,
        abortSignal
      );
      if (chownResult.exitCode !== 0) {
        return {
          success: false,
          error: `Failed to fix workspace ownership: ${chownResult.stderr}`,
        };
      }

      // Store user info for this runtime instance
      this.storeContainerUserInfo(destUser);

      // 7. Create local tracking branches (best-effort)
      initLogger.logStep("Creating local tracking branches...");
      try {
        const remotesResult = await runDockerCommand(
          `exec ${destContainerName} git -C ${CONTAINER_SRC_DIR} branch -r`,
          30000
        );
        if (remotesResult.exitCode === 0) {
          const remotes = remotesResult.stdout
            .split("\n")
            .map((b) => b.trim())
            .filter((b) => b.startsWith("origin/") && !b.includes("HEAD"));

          for (const remote of remotes) {
            const localName = remote.replace("origin/", "");
            await runDockerCommand(
              `exec ${destContainerName} git -C ${CONTAINER_SRC_DIR} branch ${shescape.quote(localName)} ${shescape.quote(remote)} 2>/dev/null || true`,
              10000
            );
          }
        }
      } catch {
        // Ignore - best-effort
      }

      // 8. Preserve origin URL (best-effort)
      try {
        const originResult = await runDockerCommand(
          `exec ${srcContainerName} git -C ${CONTAINER_SRC_DIR} remote get-url origin 2>/dev/null || true`,
          10000
        );
        const originUrl = originResult.stdout.trim();
        if (originUrl.length > 0) {
          await runDockerCommand(
            `exec ${destContainerName} git -C ${CONTAINER_SRC_DIR} remote set-url origin ${shescape.quote(originUrl)}`,
            10000
          );
        } else {
          await runDockerCommand(
            `exec ${destContainerName} git -C ${CONTAINER_SRC_DIR} remote remove origin 2>/dev/null || true`,
            10000
          );
        }
      } catch {
        // Ignore - best-effort
      }

      // 9. Checkout destination branch
      // Disable git hooks for untrusted projects (prevents post-checkout execution)
      const forkNhp = gitNoHooksPrefix(params.trusted);
      initLogger.logStep(`Checking out branch: ${newWorkspaceName}`);
      const checkoutCmd =
        `${forkNhp}git checkout ${shescape.quote(newWorkspaceName)} 2>/dev/null || ` +
        `${forkNhp}git checkout -b ${shescape.quote(newWorkspaceName)} ${shescape.quote(sourceBranch)}`;
      throwIfAborted();
      const checkoutResult = await runDockerCommand(
        `exec ${destContainerName} bash -c ${shescape.quote(`cd ${CONTAINER_SRC_DIR} && ${checkoutCmd}`)}`,
        120000,
        abortSignal
      );
      if (checkoutResult.exitCode !== 0) {
        return {
          success: false,
          error: `Failed to checkout forked branch: ${checkoutResult.stderr || checkoutResult.stdout}`,
        };
      }

      initLogger.logStep("Fork completed successfully");
      forkSucceeded = true;
      // Update containerName so subsequent initWorkspace() targets the forked container
      this.containerName = destContainerName;
      return { success: true, workspacePath: CONTAINER_SRC_DIR, sourceBranch };
    } catch (error) {
      return { success: false, error: getErrorMessage(error) };
    } finally {
      // 10. Cleanup (best-effort, ignore errors)
      /* eslint-disable @typescript-eslint/no-empty-function */
      // Clean up bundle in source container
      await runDockerCommand(`exec ${srcContainerName} rm -f ${containerBundlePath}`, 5000).catch(
        () => {}
      );
      // Clean up bundle in destination container (if it exists)
      if (destContainerCreated) {
        await runDockerCommand(
          `exec ${destContainerName} rm -f ${containerBundlePath}`,
          5000
        ).catch(() => {});
        // Remove orphaned destination container on failure
        if (!forkSucceeded) {
          await runDockerCommand(`rm -f ${destContainerName}`, 10000).catch(() => {});
        }
      }
      // Clean up host temp file
      await fs.unlink(hostTempPath).catch(() => {});
      /* eslint-enable @typescript-eslint/no-empty-function */
    }
  }

  /**
   * Ensure the Docker container is running.
   * `docker start` is idempotent - succeeds if already running, starts if stopped,
   * and waits if container is in a transitional state (starting/restarting).
   *
   * Returns typed error for retry decisions:
   * - runtime_not_ready: container missing or permanent failure
   * - runtime_start_failed: transient failure (daemon issue, etc.)
   */
  override async ensureReady(): Promise<EnsureReadyResult> {
    if (!this.containerName) {
      return {
        ready: false,
        error: "Container name not set",
        errorType: "runtime_not_ready",
      };
    }

    const result = await runDockerCommand(`start ${this.containerName}`, 30000);
    if (result.exitCode !== 0) {
      const stderr = result.stderr || "Failed to start container";

      // Classify error type based on stderr content
      const isContainerMissing =
        stderr.includes("No such container") || stderr.includes("not found");

      return {
        ready: false,
        error: stderr,
        errorType: isContainerMissing ? "runtime_not_ready" : "runtime_start_failed",
      };
    }

    // Detect container user info if not already set (e.g., runtime recreated for existing workspace)
    await this.ensureContainerUserInfo(this.containerName);

    return { ready: true };
  }

  /**
   * Docker uses /var/mux instead of ~/.xum because:
   * - /root has 700 permissions, inaccessible to VS Code Dev Containers (non-root user)
   * - /var/mux is world-readable by default
   */
  override getXumHome(): string {
    return "/var/mux";
  }
}

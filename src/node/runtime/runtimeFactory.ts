import * as fs from "fs/promises";
import * as path from "path";
import type { Runtime, WorkspaceInitParams, WorkspaceInitResult } from "./Runtime";
import { LocalRuntime } from "./LocalRuntime";
import { WorktreeRuntime } from "./WorktreeRuntime";
import { SSHRuntime } from "./SSHRuntime";
import { CoderSSHRuntime } from "./CoderSSHRuntime";
import { createSSHTransport } from "./transports";
import { DockerRuntime, getContainerName } from "./DockerRuntime";
import { DevcontainerRuntime } from "./DevcontainerRuntime";
import { XUM_PRODUCT_NAME } from "@/common/constants/product";
import type { RuntimeConfig, RuntimeMode, RuntimeAvailabilityStatus } from "@/common/types/runtime";
import { hasSrcBaseDir } from "@/common/types/runtime";
import { isIncompatibleRuntimeConfig } from "@/common/utils/runtimeCompatibility";
import { detectContainerEngine, isEngineResponsive } from "./containerCli";
import type { CoderService } from "@/node/services/coderService";
import { Config } from "@/node/config";
import { checkDevcontainerCliVersion } from "./devcontainerCli";
import { buildDevcontainerConfigInfo, scanDevcontainerConfigs } from "./devcontainerConfigs";
import { resolveCoderSSHHost } from "@/constants/coder";
import { getErrorMessage } from "@/common/utils/errors";

// Global CoderService singleton - set during app init so all createRuntime calls can use it
let globalCoderService: CoderService | undefined;

/**
 * Set the global CoderService instance for runtime factory.
 * Call this during app initialization so createRuntime() can create CoderSSHRuntime
 * without requiring callers to pass coderService explicitly.
 */
export function setGlobalCoderService(service: CoderService): void {
  globalCoderService = service;
}

/**
 * Run the full init sequence: postCreateSetup (if present) then initWorkspace.
 * Use this everywhere instead of calling initWorkspace directly to ensure
 * runtimes with provisioning steps (Docker, CoderSSH) work correctly.
 */
export async function runFullInit(
  runtime: Runtime,
  params: WorkspaceInitParams
): Promise<WorkspaceInitResult> {
  if (runtime.postCreateSetup) {
    await runtime.postCreateSetup(params);
  }
  return runtime.initWorkspace(params);
}

/**
 * Fire-and-forget init with standardized error handling.
 * Use this for background init after workspace creation (workspaceService, taskService).
 *
 * Returns a promise that SETTLES (never rejects) when init terminates, so
 * error paths that must tear down the checkout can await termination first —
 * deleting a worktree while init still runs against it races its writes and
 * open handles. Callers that never tear down may ignore it with `void`.
 */
export function runBackgroundInit(
  runtime: Runtime,
  params: WorkspaceInitParams,
  workspaceId: string,
  // eslint-disable-next-line local/no-object-parameters -- grandfathered when the rule was introduced; fix the underlying type instead of copying this pattern
  logger?: { error: (msg: string, ctx: object) => void }
): Promise<void> {
  return runFullInit(runtime, params).then(
    () => undefined,
    (error: unknown) => {
      const errorMsg = getErrorMessage(error);
      logger?.error(`Workspace init failed for ${workspaceId}:`, { error });
      params.initLogger.logStderr(`Initialization failed: ${errorMsg}`);
      params.initLogger.logComplete(-1);
    }
  );
}

function shouldUseSSH2Runtime(): boolean {
  // Windows always uses SSH2 (no native OpenSSH)
  if (process.platform === "win32") {
    return true;
  }
  // Other platforms: check config (defaults to OpenSSH)
  const config = new Config();
  return config.loadConfigOrDefault().useSSH2Transport ?? false;
}

/**
 * Error thrown when a workspace has an incompatible runtime configuration,
 * typically from a newer version of Xum that added new runtime types.
 */
export class IncompatibleRuntimeError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "IncompatibleRuntimeError";
  }
}

/**
 * Options for creating a runtime.
 */
export interface CreateRuntimeOptions {
  /**
   * Project path - required for project-dir local runtimes (type: "local" without srcBaseDir).
   * For Docker runtimes with existing workspaces, used together with workspaceName to derive container name.
   * For other runtime types, this is optional and used only for getWorkspacePath calculations.
   */
  projectPath?: string;
  /**
   * Workspace name - required for Docker runtimes when connecting to an existing workspace.
   * Used together with projectPath to derive the container name.
   */
  workspaceName?: string;
  /**
   * Persisted workspace path from config.json.
   * Used by devcontainer runtimes to preserve the exact host path from startup.
   */
  workspacePath?: string;
  /**
   * Coder service - required for SSH runtimes with Coder configuration.
   * When provided and config has coder field, returns a Coder SSH runtime (SSH/SSH2).
   */
  coderService?: CoderService;
}

/**
 * Create a Runtime instance based on the configuration.
 *
 * Handles runtime types:
 * - "local" without srcBaseDir: Project-dir runtime (no isolation) - requires projectPath in options
 * - "local" with srcBaseDir: Legacy worktree config (backward compat)
 * - "worktree": Explicit worktree runtime
 * - "ssh": Remote SSH runtime
 * - "docker": Docker container runtime
 */
export function createRuntime(config: RuntimeConfig, options?: CreateRuntimeOptions): Runtime {
  // Check for incompatible configs from newer versions
  if (isIncompatibleRuntimeConfig(config)) {
    throw new IncompatibleRuntimeError(
      `This workspace uses a runtime configuration from a newer version of ${XUM_PRODUCT_NAME}. ` +
        `Please upgrade ${XUM_PRODUCT_NAME} to use this workspace.`
    );
  }

  const runtimeIdentity = {
    projectPath: options?.projectPath,
    workspaceName: options?.workspaceName,
    workspacePath: options?.workspacePath,
  };

  switch (config.type) {
    case "local":
      // Check if this is legacy "local" with srcBaseDir (= worktree semantics)
      // or new "local" without srcBaseDir (= project-dir semantics)
      if (hasSrcBaseDir(config)) {
        // Legacy: "local" with srcBaseDir is treated as worktree
        return new WorktreeRuntime(config.srcBaseDir, runtimeIdentity);
      }
      // Project-dir: uses project path directly, no isolation
      if (!runtimeIdentity.projectPath) {
        throw new Error(
          "LocalRuntime requires projectPath in options for project-dir config (type: 'local' without srcBaseDir)"
        );
      }
      return new LocalRuntime(runtimeIdentity.projectPath);

    case "worktree":
      return new WorktreeRuntime(config.srcBaseDir, runtimeIdentity);

    case "ssh": {
      // Normalize Coder host before transport creation so both transport
      // and runtime use the canonical *.mux--coder hostname from the start.
      const sshHost = resolveCoderSSHHost(config.host, config.coder?.workspaceName);
      const sshConfig = {
        host: sshHost,
        srcBaseDir: config.srcBaseDir,
        bgOutputDir: config.bgOutputDir,
        identityFile: config.identityFile,
        port: config.port,
      };

      const useSSH2 = shouldUseSSH2Runtime();
      const transport = createSSHTransport(sshConfig, useSSH2);

      // Use a Coder SSH runtime for SSH+Coder when coderService is available (explicit or global)
      const coderService = options?.coderService ?? globalCoderService;

      if (config.coder) {
        if (!coderService) {
          throw new Error("Coder runtime requested but CoderService is not initialized");
        }
        return new CoderSSHRuntime(
          { ...sshConfig, coder: config.coder },
          transport,
          coderService,
          runtimeIdentity
        );
      }

      return new SSHRuntime(sshConfig, transport, runtimeIdentity);
    }

    case "docker": {
      // For existing workspaces, derive container name from project+workspace
      const containerName =
        runtimeIdentity.projectPath && runtimeIdentity.workspaceName
          ? getContainerName(runtimeIdentity.projectPath, runtimeIdentity.workspaceName)
          : config.containerName;
      return new DockerRuntime({
        image: config.image,
        containerName,
        shareCredentials: config.shareCredentials,
      });
    }

    case "devcontainer": {
      // Devcontainer uses worktrees on host + container exec
      // srcBaseDir sourced from config to honor MUX_ROOT and dev-mode suffixes
      const runtime = new DevcontainerRuntime({
        srcBaseDir: new Config().srcDir,
        configPath: config.configPath,
        shareCredentials: config.shareCredentials,
      });
      // Set workspace path for existing workspaces
      // For existing workspaces, prefer the persisted workspacePath — Docker labels
      // devcontainers by the exact host path from startup, so canonical reconstruction
      // can diverge for migrated/non-canonical entries.
      if (options?.workspacePath) {
        runtime.setCurrentWorkspacePath(options.workspacePath);
      } else if (runtimeIdentity.projectPath && runtimeIdentity.workspaceName) {
        runtime.setCurrentWorkspacePath(
          runtime.getWorkspacePath(runtimeIdentity.projectPath, runtimeIdentity.workspaceName)
        );
      }
      return runtime;
    }

    default: {
      const unknownConfig = config as { type?: string };
      throw new Error(`Unknown runtime type: ${unknownConfig.type ?? "undefined"}`);
    }
  }
}

/**
 * Check if a project has a .git directory (is a git repository).
 */
async function isGitRepository(projectPath: string): Promise<boolean> {
  try {
    const gitPath = path.join(projectPath, ".git");
    const stat = await fs.stat(gitPath);
    // .git can be a directory (normal repo) or a file (worktree)
    return stat.isDirectory() || stat.isFile();
  } catch {
    return false;
  }
}

type RuntimeAvailabilityMap = Record<RuntimeMode, RuntimeAvailabilityStatus>;

/**
 * Check availability of all runtime types for a given project.
 * Returns a record of runtime mode to availability status.
 */
export async function checkRuntimeAvailability(
  projectPath: string
): Promise<RuntimeAvailabilityMap> {
  const [isGit, containerEngine, dockerResponsive, devcontainerCliInfo, devcontainerConfigs] =
    await Promise.all([
      isGitRepository(projectPath),
      detectContainerEngine(),
      // The devcontainer CLI shells out to the literal `docker` binary regardless
      // of which engine the Docker runtime resolved (e.g. an XUM_CONTAINER_CLI
      // override), so Dev Container availability needs its own docker probe.
      isEngineResponsive("docker"),
      checkDevcontainerCliVersion(),
      scanDevcontainerConfigs(projectPath),
    ]);

  const devcontainerConfigInfo = buildDevcontainerConfigInfo(devcontainerConfigs);

  const gitRequiredReason = "Requires git repository";

  // Determine devcontainer availability
  let devcontainerAvailability: RuntimeAvailabilityStatus;
  if (!isGit) {
    devcontainerAvailability = { available: false, reason: gitRequiredReason };
  } else if (!devcontainerCliInfo) {
    devcontainerAvailability = {
      available: false,
      reason: "Dev Container CLI not installed. Run: npm install -g @devcontainers/cli",
    };
  } else if (!dockerResponsive) {
    devcontainerAvailability = {
      available: false,
      reason: "Dev Containers require Docker; Docker daemon not running",
    };
  } else if (devcontainerConfigInfo.length === 0) {
    devcontainerAvailability = { available: false, reason: "No devcontainer.json found" };
  } else {
    devcontainerAvailability = {
      available: true,
      configs: devcontainerConfigInfo,
      cliVersion: devcontainerCliInfo.version,
    };
  }

  return {
    local: { available: true },
    worktree: isGit ? { available: true } : { available: false, reason: gitRequiredReason },
    ssh: isGit ? { available: true } : { available: false, reason: gitRequiredReason },
    docker: !isGit
      ? { available: false, reason: gitRequiredReason }
      : !containerEngine.available
        ? { available: false, reason: containerEngine.reason }
        : { available: true },
    devcontainer: devcontainerAvailability,
  };
}

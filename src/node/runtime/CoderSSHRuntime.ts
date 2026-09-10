/**
 * CoderSSHRuntime - SSH runtime wrapper for Coder workspaces.
 *
 * Extends SSHRuntime to add Coder-specific provisioning via postCreateSetup():
 * - Creates Coder workspace (if not connecting to existing)
 * - Ensures mux-owned SSH config is present for Coder SSH proxying
 *
 * This ensures mux workspace metadata is persisted before the long-running
 * Coder build starts, allowing build logs to stream to init logs (like Docker).
 */

import type {
  RuntimeCreateFlags,
  WorkspaceCreationParams,
  WorkspaceCreationResult,
  WorkspaceForkParams,
  WorkspaceForkResult,
  WorkspaceInitParams,
  EnsureReadyOptions,
  EnsureReadyResult,
  RuntimeStatusEvent,
} from "./Runtime";
import { SSHRuntime, type SSHRuntimeConfig } from "./SSHRuntime";
import type { SSHTransport } from "./transports";
import type { CoderWorkspaceConfig, RuntimeConfig } from "@/common/types/runtime";
import { isSSHRuntime } from "@/common/types/runtime";
import { resolveCoderSSHHost } from "@/constants/coder";
import type { CoderService, WorkspaceStatusResult } from "@/node/services/coderService";
import type { Result } from "@/common/types/result";
import { Ok, Err } from "@/common/types/result";
import { log } from "@/node/services/log";
import { execBuffered } from "@/node/utils/runtime/helpers";
import { expandTildeForSSH } from "./tildeExpansion";
import * as path from "path";
import { getErrorMessage } from "@/common/utils/errors";

export interface CoderSSHRuntimeConfig extends SSHRuntimeConfig {
  /** Coder-specific configuration */
  coder: CoderWorkspaceConfig;
}

/**
 * Coder workspace name regex: ^[a-zA-Z0-9]+(?:-[a-zA-Z0-9]+)*$
 * - Must start with alphanumeric
 * - Can contain hyphens, but only between alphanumeric segments
 * - No underscores (unlike mux workspace names)
 */
const CODER_NAME_REGEX = /^[a-zA-Z0-9]+(?:-[a-zA-Z0-9]+)*$/;

/**
 * Transform a mux workspace name to be Coder-compatible.
 * - Replace underscores with hyphens
 * - Remove leading/trailing hyphens
 * - Collapse multiple consecutive hyphens
 */
function toCoderCompatibleName(name: string): string {
  return name
    .replace(/_/g, "-") // Replace underscores with hyphens
    .replace(/^-+|-+$/g, "") // Remove leading/trailing hyphens
    .replace(/-{2,}/g, "-"); // Collapse multiple hyphens
}

const CODER_INACTIVITY_THRESHOLD_MS = 5 * 60 * 1000;
const CODER_ENSURE_READY_TIMEOUT_MS = 120_000;
const CODER_STATUS_POLL_INTERVAL_MS = 2_000;

const coderLastActivityByService = new WeakMap<CoderService, Map<string, number>>();

function pruneCoderActivityMap(activityByWorkspace: Map<string, number>, now: number): void {
  for (const [workspaceName, lastActivityAtMs] of activityByWorkspace) {
    if (now - lastActivityAtMs >= CODER_INACTIVITY_THRESHOLD_MS) {
      activityByWorkspace.delete(workspaceName);
    }
  }
}

function getCoderActivityMap(coderService: CoderService): Map<string, number> {
  let activityByWorkspace = coderLastActivityByService.get(coderService);
  if (!activityByWorkspace) {
    activityByWorkspace = new Map();
    coderLastActivityByService.set(coderService, activityByWorkspace);
  }
  return activityByWorkspace;
}

/**
 * SSH runtime that handles Coder workspace provisioning.
 *
 * IMPORTANT: This extends SSHRuntime (rather than delegating) so other backend
 * code that checks `runtime instanceof SSHRuntime` (PTY, tools, path handling)
 * continues to behave correctly for Coder workspaces.
 */
export class CoderSSHRuntime extends SSHRuntime {
  private coderConfig: CoderWorkspaceConfig;
  private readonly coderService: CoderService;

  /**
   * Flags for WorkspaceService to customize create flow:
   * - deferredRuntimeAccess: skip srcBaseDir resolution (Coder host doesn't exist yet)
   * - configLevelCollisionDetection: use config-based collision check (can't reach host)
   */
  readonly createFlags: RuntimeCreateFlags = {
    deferredRuntimeAccess: true,
    configLevelCollisionDetection: true,
  };

  constructor(
    config: CoderSSHRuntimeConfig,
    transport: SSHTransport,
    coderService: CoderService,
    options?: {
      projectPath?: string;
      workspaceName?: string;
    }
  ) {
    if (!config || !coderService || !transport) {
      throw new Error("CoderSSHRuntime requires config, transport, and coderService");
    }

    const baseConfig: SSHRuntimeConfig = {
      host: resolveCoderSSHHost(config.host, config.coder?.workspaceName),
      srcBaseDir: config.srcBaseDir,
      bgOutputDir: config.bgOutputDir,
      identityFile: config.identityFile,
      port: config.port,
    };

    super(baseConfig, transport, options);
    this.coderConfig = config.coder;
    this.coderService = coderService;
  }

  private markActivity(workspaceName = this.coderConfig.workspaceName): void {
    if (!workspaceName) {
      return;
    }

    const now = Date.now();
    const activityByWorkspace = getCoderActivityMap(this.coderService);
    pruneCoderActivityMap(activityByWorkspace, now);
    activityByWorkspace.set(workspaceName, now);
  }

  private coderWorkspaceNotFound(workspaceName: string): EnsureReadyResult {
    return {
      ready: false,
      error: `Coder workspace "${workspaceName}" not found`,
      errorType: "runtime_not_ready",
    };
  }

  private async markReadyIfRepoPresent(
    workspaceName: string,
    options: EnsureReadyOptions | undefined,
    emitStatus: (phase: RuntimeStatusEvent["phase"], detail?: string) => void
  ): Promise<EnsureReadyResult> {
    const repoCheck = await this.checkWorkspaceRepo(options);
    if (repoCheck && !repoCheck.ready) {
      emitStatus("error", repoCheck.error);
      return repoCheck;
    }

    this.markActivity(workspaceName);
    emitStatus("ready");
    return { ready: true };
  }

  private isStoppingOrCanceling(status: WorkspaceStatusResult): boolean {
    return status.kind === "ok" && (status.status === "stopping" || status.status === "canceling");
  }

  private async waitForStoppingOrCancelingToClear(
    workspaceName: string,
    status: WorkspaceStatusResult,
    options: {
      abortSignal?: AbortSignal;
      timeoutMs?: () => number;
      isTimedOut?: () => boolean;
      onWait?: () => void;
    } = {}
  ): Promise<WorkspaceStatusResult> {
    if (!this.isStoppingOrCanceling(status)) {
      return status;
    }

    options.onWait?.();
    while (this.isStoppingOrCanceling(status)) {
      if (options.abortSignal?.aborted) {
        throw new Error("Aborted while waiting for Coder workspace to stop");
      }
      if (options.isTimedOut?.()) {
        return status;
      }

      await this.sleep(CODER_STATUS_POLL_INTERVAL_MS, options.abortSignal);
      status = await this.coderService.getWorkspaceStatus(workspaceName, {
        timeoutMs: options.timeoutMs?.(),
        signal: options.abortSignal,
      });
    }

    return status;
  }

  /** In-flight ensureReady promise to avoid duplicate start/wait sequences */
  private ensureReadyPromise: Promise<EnsureReadyResult> | null = null;

  /**
   * Check if runtime is ready for use.
   *
   * Behavior:
   * - If creation failed during postCreateSetup(), fail fast.
   * - If workspace is running: return ready.
   * - If workspace is stopped: auto-start and wait (blocking, ~120s timeout).
   * - If workspace is stopping: poll until stopped, then start.
   * - Emits runtime-status events via statusSink for UX feedback.
   *
   * Concurrency: shares an in-flight promise to avoid duplicate start sequences.
   */
  override async ensureReady(options?: EnsureReadyOptions): Promise<EnsureReadyResult> {
    const workspaceName = this.coderConfig.workspaceName;
    if (!workspaceName) {
      return {
        ready: false,
        error: "Coder workspace name not set",
        errorType: "runtime_not_ready",
      };
    }

    const now = Date.now();
    const activityByWorkspace = getCoderActivityMap(this.coderService);
    pruneCoderActivityMap(activityByWorkspace, now);
    const lastActivityAtMs = activityByWorkspace.get(workspaceName) ?? 0;

    // Fast path: recently active, skip expensive status check. This cache intentionally lives
    // outside the runtime instance because existing-workspace stream startup recreates runtimes,
    // and it prunes entries after the same 5-minute window to avoid unbounded workspace-name growth.
    if (lastActivityAtMs !== 0 && now - lastActivityAtMs < CODER_INACTIVITY_THRESHOLD_MS) {
      return { ready: true };
    }

    // Avoid duplicate start/wait sequences only for calls without request-local observers.
    // Abort signals and status sinks are per caller; sharing those would make cancellation/status
    // delivery depend on whichever caller happened to start the singleflight.
    if (options?.signal || options?.statusSink) {
      return this.doEnsureReady(workspaceName, options);
    }
    if (this.ensureReadyPromise) {
      return this.ensureReadyPromise;
    }

    this.ensureReadyPromise = this.doEnsureReady(workspaceName, options);
    try {
      return await this.ensureReadyPromise;
    } finally {
      this.ensureReadyPromise = null;
    }
  }

  /**
   * Core ensureReady logic - called once (protected by ensureReadyPromise).
   *
   * Flow:
   * 1. Check status via `coder list` - short-circuit for "running" or "not_found"
   * 2. If "stopping"/"canceling": poll until it clears (coder ssh can't autostart during these)
   * 3. Run `coder ssh --wait=yes -- true` which handles everything else:
   *    - stopped: auto-starts, streams build logs, waits for startup scripts
   *    - starting/pending: waits for build completion + startup scripts
   */
  private async doEnsureReady(
    workspaceName: string,
    options?: EnsureReadyOptions
  ): Promise<EnsureReadyResult> {
    const statusSink = options?.statusSink;
    const signal = options?.signal;
    const startTime = Date.now();

    const emitStatus = (phase: RuntimeStatusEvent["phase"], detail?: string) => {
      statusSink?.({ phase, runtimeType: "ssh", detail });
    };

    // Helper: check if we've exceeded overall timeout
    const isTimedOut = () => Date.now() - startTime > CODER_ENSURE_READY_TIMEOUT_MS;
    const remainingMs = () => Math.max(0, CODER_ENSURE_READY_TIMEOUT_MS - (Date.now() - startTime));

    // Step 1: Check current status for short-circuits
    emitStatus("checking");

    if (signal?.aborted) {
      emitStatus("error");
      return { ready: false, error: "Aborted", errorType: "runtime_start_failed" };
    }

    let statusResult = await this.coderService.getWorkspaceStatus(workspaceName, {
      timeoutMs: Math.min(remainingMs(), 10_000),
      signal,
    });

    // Short-circuit: already running
    if (statusResult.kind === "ok" && statusResult.status === "running") {
      return this.markReadyIfRepoPresent(workspaceName, options, emitStatus);
    }

    // Short-circuit: workspace doesn't exist
    if (statusResult.kind === "not_found") {
      emitStatus("error");
      return this.coderWorkspaceNotFound(workspaceName);
    }

    // For status check errors (timeout, auth issues), proceed optimistically
    // and let SSH fail naturally to avoid blocking the happy path
    if (statusResult.kind === "error") {
      if (signal?.aborted) {
        emitStatus("error");
        return { ready: false, error: "Aborted", errorType: "runtime_start_failed" };
      }
      log.debug("Coder workspace status unknown, proceeding optimistically", {
        workspaceName,
        error: statusResult.error,
      });
    }

    // Step 2: Wait for "stopping"/"canceling" to clear (coder ssh can't autostart during these)
    try {
      statusResult = await this.waitForStoppingOrCancelingToClear(workspaceName, statusResult, {
        abortSignal: signal,
        timeoutMs: () => Math.min(remainingMs(), 10_000),
        isTimedOut,
        onWait: () => emitStatus("waiting", "Waiting for Coder workspace to stop..."),
      });
    } catch (error) {
      if (signal?.aborted) {
        emitStatus("error");
        return { ready: false, error: "Aborted", errorType: "runtime_start_failed" };
      }
      throw error;
    }

    // Check for state changes during polling
    if (statusResult.kind === "ok" && statusResult.status === "running") {
      // Ensure setup failures (missing repo) surface before marking ready.
      return this.markReadyIfRepoPresent(workspaceName, options, emitStatus);
    }
    if (statusResult.kind === "not_found") {
      emitStatus("error");
      return this.coderWorkspaceNotFound(workspaceName);
    }
    if (isTimedOut() && this.isStoppingOrCanceling(statusResult)) {
      emitStatus("error");
      return {
        ready: false,
        error: "Coder workspace is still stopping... Please retry shortly.",
        errorType: "runtime_start_failed",
      };
    }

    // Step 3: Use coder ssh --wait=yes to handle all other states
    // This auto-starts stopped workspaces and waits for startup scripts
    emitStatus("starting", "Connecting to Coder workspace...");
    log.debug("Connecting to Coder workspace via SSH", { workspaceName });

    // Create abort signal that fires on timeout or user abort
    const controller = new AbortController();

    const checkInterval = setInterval(() => {
      if (isTimedOut() || signal?.aborted) {
        controller.abort();
        clearInterval(checkInterval);
      }
    }, 1000);
    controller.signal.addEventListener("abort", () => clearInterval(checkInterval), {
      once: true,
    });
    if (isTimedOut() || signal?.aborted) controller.abort();

    try {
      for await (const _line of this.coderService.waitForStartupScripts(
        workspaceName,
        controller.signal
      )) {
        // Consume output for timeout/abort handling
      }

      return this.markReadyIfRepoPresent(workspaceName, options, emitStatus);
    } catch (error) {
      const errorMsg = getErrorMessage(error);

      emitStatus("error");

      if (isTimedOut()) {
        return {
          ready: false,
          error: "Coder workspace start timed out",
          errorType: "runtime_start_failed",
        };
      }

      if (signal?.aborted) {
        return { ready: false, error: "Aborted", errorType: "runtime_start_failed" };
      }

      // Map "not found" errors to runtime_not_ready
      if (/not found|no access/i.test(errorMsg)) {
        return this.coderWorkspaceNotFound(workspaceName);
      }

      return {
        ready: false,
        error: `Failed to connect to Coder workspace: ${errorMsg}`,
        errorType: "runtime_start_failed",
      };
    } finally {
      clearInterval(checkInterval);
    }
  }

  /** Promise-based sleep helper */
  private sleep(ms: number, abortSignal?: AbortSignal): Promise<void> {
    if (abortSignal?.aborted) {
      return Promise.resolve();
    }

    return new Promise((resolve) => {
      const timeout = setTimeout(() => {
        abortSignal?.removeEventListener("abort", onAbort);
        resolve();
      }, ms);

      const onAbort = () => {
        clearTimeout(timeout);
        abortSignal?.removeEventListener("abort", onAbort);
        resolve();
      };

      abortSignal?.addEventListener("abort", onAbort, { once: true });
      if (abortSignal?.aborted) {
        onAbort();
      }
    });
  }

  /**
   * Finalize runtime config after collision handling.
   * Derives Coder workspace name from branch name and computes SSH host.
   */
  async finalizeConfig(
    finalBranchName: string,
    config: RuntimeConfig
  ): Promise<Result<RuntimeConfig, string>> {
    if (!isSSHRuntime(config) || !config.coder) {
      return Ok(config);
    }

    const coder = config.coder;
    let workspaceName = coder.workspaceName?.trim() ?? "";

    if (!coder.existingWorkspace) {
      // New workspace: derive name from mux workspace name if not provided
      if (!workspaceName) {
        workspaceName = `mux-${finalBranchName}`;
      }
      // Transform to Coder-compatible name (handles underscores, etc.)
      workspaceName = toCoderCompatibleName(workspaceName);

      // Validate against Coder's regex
      if (!CODER_NAME_REGEX.test(workspaceName)) {
        return Err(
          `Workspace name "${finalBranchName}" cannot be converted to a valid Coder name. ` +
            `Use only letters, numbers, and hyphens.`
        );
      }
    } else {
      // Existing workspace: name must be provided (selected from dropdown)
      if (!workspaceName) {
        return Err("Coder workspace name is required for existing workspaces");
      }
    }

    // Final validation
    if (!workspaceName) {
      return Err("Coder workspace name is required");
    }

    // Verify Coder auth before persisting workspace metadata.
    // Without this, existing-workspace flows skip all auth checks and can create
    // unusable entries when the user is logged out or their session has expired.
    try {
      await this.coderService.verifyAuthenticatedSession();
    } catch (error) {
      const message = getErrorMessage(error);
      return Err(
        `Failed to verify Coder authentication. ` +
          `Make sure you're logged in with the Coder CLI. ` +
          `(${message})`
      );
    }

    // Keep a provisioning session around for new workspaces so we can reuse the same token
    // when fetching template parameters during postCreateSetup.
    if (!coder.existingWorkspace) {
      try {
        await this.coderService.ensureProvisioningSession(workspaceName);
      } catch (error) {
        const message = getErrorMessage(error);
        return Err(
          `Failed to prepare Coder provisioning session. ` +
            `Make sure you're logged in with the Coder CLI. ` +
            `(${message})`
        );
      }
    }

    return Ok({
      ...config,
      host: resolveCoderSSHHost(config.host, workspaceName),
      coder: { ...coder, workspaceName },
    });
  }

  /**
   * Validate before persisting workspace metadata.
   * Checks if a Coder workspace with this name already exists.
   */
  async validateBeforePersist(
    _finalBranchName: string,
    config: RuntimeConfig
  ): Promise<Result<void, string>> {
    if (!isSSHRuntime(config) || !config.coder) {
      return Ok(undefined);
    }

    // Skip for "existing" mode - user explicitly selected an existing workspace
    if (config.coder.existingWorkspace) {
      return Ok(undefined);
    }

    const workspaceName = config.coder.workspaceName;
    if (!workspaceName) {
      return Ok(undefined);
    }

    const exists = await this.coderService.workspaceExists(workspaceName);

    if (exists) {
      await this.coderService.disposeProvisioningSession(workspaceName);
      return Err(
        `A Coder workspace named "${workspaceName}" already exists. ` +
          `Either switch to "Existing" mode to use it, delete/rename it in Coder, ` +
          `or choose a different mux workspace name.`
      );
    }

    return Ok(undefined);
  }

  /**
   * Create workspace (fast path only - no SSH needed).
   * The Coder workspace may not exist yet, so we can't reach the SSH host.
   * Just compute the workspace path locally.
   */
  override createWorkspace(params: WorkspaceCreationParams): Promise<WorkspaceCreationResult> {
    const workspacePath = this.getWorkspacePath(params.projectPath, params.directoryName);

    params.initLogger.logStep("Workspace path computed (Coder provisioning will follow)");

    return Promise.resolve({
      success: true,
      workspacePath,
    });
  }

  /**
   * Delete workspace: removes SSH files AND deletes Coder workspace (if Xum-managed).
   *
   * IMPORTANT: Only delete the Coder workspace once we're confident mux will commit
   * the deletion. In the non-force path, WorkspaceService.remove() aborts and keeps
   * workspace metadata when runtime.deleteWorkspace() fails.
   */
  override async deleteWorkspace(
    projectPath: string,
    workspaceName: string,
    force: boolean,
    abortSignal?: AbortSignal,
    trusted?: boolean
  ): Promise<{ success: true; deletedPath: string } | { success: false; error: string }> {
    // Deleting a Coder workspace is dangerous; CoderService refuses to delete workspaces
    // without the mux- prefix to avoid accidentally deleting user-owned Coder workspaces.

    // If this workspace is an existing Coder workspace that mux didn't create, just do SSH cleanup.
    if (this.coderConfig.existingWorkspace) {
      return super.deleteWorkspace(projectPath, workspaceName, force, abortSignal, trusted);
    }

    const coderWorkspaceName = this.coderConfig.workspaceName;

    if (!coderWorkspaceName) {
      log.warn("Coder workspace name not set, falling back to SSH-only deletion");
      return super.deleteWorkspace(projectPath, workspaceName, force, abortSignal, trusted);
    }

    // For force deletes ("cancel creation"), skip SSH cleanup and focus on deleting the
    // underlying Coder workspace. During provisioning, the SSH host may not be reachable yet.
    if (force) {
      const deleteResult = await this.coderService.deleteWorkspaceEventually(coderWorkspaceName, {
        timeoutMs: 60_000,
        signal: abortSignal,
        // Avoid races where coder create finishes server-side after we abort the local CLI.
        waitForExistence: true,
        // If the workspace never appears on the server within 10s, assume it was never created
        // and return early instead of waiting the full 60s timeout.
        waitForExistenceTimeoutMs: 10_000,
      });

      if (!deleteResult.success) {
        return { success: false, error: `Failed to delete Coder workspace: ${deleteResult.error}` };
      }

      return { success: true, deletedPath: this.getWorkspacePath(projectPath, workspaceName) };
    }

    // Check if Coder workspace still exists before attempting SSH operations.
    // If it's already gone, skip SSH cleanup (would hang trying to connect to non-existent host).
    const statusResult = await this.coderService.getWorkspaceStatus(coderWorkspaceName, {
      signal: abortSignal,
    });
    if (statusResult.kind === "not_found") {
      log.debug("Coder workspace already deleted, skipping SSH cleanup", { coderWorkspaceName });
      return { success: true, deletedPath: this.getWorkspacePath(projectPath, workspaceName) };
    }
    if (statusResult.kind === "error") {
      // API errors (auth, network): fall through to SSH cleanup, let it fail naturally
      log.warn("Could not check Coder workspace status, proceeding with SSH cleanup", {
        coderWorkspaceName,
        error: statusResult.error,
      });
    }
    if (statusResult.kind === "ok") {
      // If the workspace is stopped, avoid SSH entirely.
      //
      // IMPORTANT tradeoff: This intentionally skips the dirty/unpushed checks performed by
      // SSHRuntime.deleteWorkspace(). Any SSH connection can auto-start a stopped Coder
      // workspace, which is surprising during deletion.
      if (statusResult.status === "stopped") {
        if (abortSignal?.aborted && !force) {
          return { success: false, error: "Delete operation aborted" };
        }

        try {
          log.debug("Coder workspace is stopped; deleting without SSH cleanup", {
            coderWorkspaceName,
          });
          const deleteResult = await this.coderService.deleteWorkspaceEventually(
            coderWorkspaceName,
            {
              timeoutMs: 60_000,
              signal: abortSignal,
              waitForExistence: false,
            }
          );

          if (!deleteResult.success) {
            return {
              success: false,
              error: `Failed to delete Coder workspace: ${deleteResult.error}`,
            };
          }

          return {
            success: true,
            deletedPath: this.getWorkspacePath(projectPath, workspaceName),
          };
        } catch (error) {
          const message = getErrorMessage(error);
          log.error("Failed to delete stopped Coder workspace", {
            coderWorkspaceName,
            error: message,
          });
          return { success: false, error: `Failed to delete Coder workspace: ${message}` };
        }
      }

      // Workspace is being deleted or already deleted - skip SSH (would hang connecting to dying host)
      if (statusResult.status === "deleted" || statusResult.status === "deleting") {
        log.debug("Coder workspace is deleted/deleting, skipping SSH cleanup", {
          coderWorkspaceName,
          status: statusResult.status,
        });
        return { success: true, deletedPath: this.getWorkspacePath(projectPath, workspaceName) };
      }
    }

    const sshResult = await super.deleteWorkspace(
      projectPath,
      workspaceName,
      force,
      abortSignal,
      trusted
    );

    // In the normal (force=false) delete path, only delete the Coder workspace if the SSH delete
    // succeeded. If SSH delete failed (e.g., dirty workspace), WorkspaceService.remove() keeps the
    // workspace metadata and the user can retry.
    if (!sshResult.success && !force) {
      return sshResult;
    }

    try {
      log.debug(`Deleting Coder workspace "${coderWorkspaceName}"`);
      const deleteResult = await this.coderService.deleteWorkspaceEventually(coderWorkspaceName, {
        timeoutMs: 60_000,
        signal: abortSignal,
        waitForExistence: false,
      });

      if (!deleteResult.success) {
        throw new Error(deleteResult.error);
      }
    } catch (error) {
      const message = getErrorMessage(error);
      log.error("Failed to delete Coder workspace", {
        coderWorkspaceName,
        error: message,
      });

      if (sshResult.success) {
        return {
          success: false,
          error: `SSH delete succeeded, but failed to delete Coder workspace: ${message}`,
        };
      }

      return {
        success: false,
        error: `SSH delete failed: ${sshResult.error}; Coder delete also failed: ${message}`,
      };
    }

    return sshResult;
  }

  /**
   * Fork workspace: delegates to SSHRuntime, but marks both source and fork
   * as existingWorkspace=true so neither can delete the shared Coder workspace.
   *
   * IMPORTANT: Also updates this instance's coderConfig so that if postCreateSetup
   * runs on this same runtime instance (for the forked workspace), it won't attempt
   * to create a new Coder workspace.
   */
  override async forkWorkspace(params: WorkspaceForkParams): Promise<WorkspaceForkResult> {
    const result = await super.forkWorkspace(params);
    // Coder tasks must share the parent's VM - don't fall back to creating a new one
    if (!result.success) return { ...result, failureIsFatal: true };

    // Both workspaces now share the Coder workspace - mark as existing so
    // deleting either mux workspace won't destroy the underlying Coder workspace
    const sharedCoderConfig = { ...this.coderConfig, existingWorkspace: true };

    // Update this instance's config so postCreateSetup() skips coder create
    this.coderConfig = sharedCoderConfig;

    const sshConfig = this.getConfig();
    const sharedRuntimeConfig = { type: "ssh" as const, ...sshConfig, coder: sharedCoderConfig };

    return {
      ...result,
      forkedRuntimeConfig: sharedRuntimeConfig,
      sourceRuntimeConfig: sharedRuntimeConfig,
    };
  }

  /**
   * Post-create setup: provision Coder workspace and configure SSH.
   * This runs after mux persists workspace metadata, so build logs stream to UI.
   */
  async postCreateSetup(params: WorkspaceInitParams): Promise<void> {
    const { initLogger, abortSignal } = params;

    // Create Coder workspace if not connecting to an existing one
    if (!this.coderConfig.existingWorkspace) {
      // Validate required fields (workspaceName is set by finalizeConfig during workspace creation)
      const coderWorkspaceName = this.coderConfig.workspaceName;
      if (!coderWorkspaceName) {
        throw new Error("Coder workspace name is required (should be set by finalizeConfig)");
      }
      if (!this.coderConfig.template) {
        await this.coderService.disposeProvisioningSession(coderWorkspaceName);
        throw new Error("Coder template is required for new workspaces");
      }

      initLogger.logStep(`Creating Coder workspace "${coderWorkspaceName}"...`);

      const provisioningSession = this.coderService.takeProvisioningSession(coderWorkspaceName);

      try {
        for await (const line of this.coderService.createWorkspace(
          coderWorkspaceName,
          this.coderConfig.template,
          this.coderConfig.preset,
          abortSignal,
          this.coderConfig.templateOrg,
          provisioningSession
        )) {
          initLogger.logStdout(line);
        }
        initLogger.logStep("Coder workspace created successfully");

        // Wait for startup scripts to complete
        initLogger.logStep("Waiting for startup scripts...");
        for await (const line of this.coderService.waitForStartupScripts(
          coderWorkspaceName,
          abortSignal
        )) {
          initLogger.logStdout(line);
        }
      } catch (error) {
        const errorMsg = getErrorMessage(error);
        log.error("Failed to create Coder workspace", { error, config: this.coderConfig });
        initLogger.logStderr(`Failed to create Coder workspace: ${errorMsg}`);
        throw new Error(`Failed to create Coder workspace: ${errorMsg}`);
      } finally {
        if (provisioningSession) {
          await provisioningSession.dispose();
        }
      }
    } else if (this.coderConfig.workspaceName) {
      // For existing workspaces, wait for "stopping"/"canceling" to clear before SSH
      // (coder ssh --wait=yes can't autostart while a stop/cancel build is in progress)
      const workspaceName = this.coderConfig.workspaceName;
      const status = await this.coderService.getWorkspaceStatus(workspaceName, {
        signal: abortSignal,
      });
      await this.waitForStoppingOrCancelingToClear(workspaceName, status, {
        abortSignal,
        onWait: () =>
          initLogger.logStep(`Waiting for Coder workspace "${workspaceName}" to stop...`),
      });

      // waitForStartupScripts (coder ssh --wait=yes) handles all other states:
      // - stopped: auto-starts, streams build logs, waits for scripts
      // - starting/pending: waits for build + scripts
      // - running: waits for scripts (fast if already done)
      initLogger.logStep(`Connecting to Coder workspace "${workspaceName}"...`);
      try {
        for await (const line of this.coderService.waitForStartupScripts(
          workspaceName,
          abortSignal
        )) {
          initLogger.logStdout(line);
        }
      } catch (error) {
        const errorMsg = getErrorMessage(error);
        log.error("Failed waiting for Coder workspace", { error, config: this.coderConfig });
        initLogger.logStderr(`Failed connecting to Coder workspace: ${errorMsg}`);
        throw new Error(`Failed connecting to Coder workspace: ${errorMsg}`);
      }
    }

    // Ensure mux-owned SSH config is set up for Coder workspaces.
    initLogger.logStep("Configuring SSH for Coder...");
    try {
      await this.coderService.ensureMuxCoderSSHConfig();
    } catch (error) {
      const errorMsg = getErrorMessage(error);
      log.error("Failed to configure SSH for Coder", { error });
      initLogger.logStderr(`Failed to configure SSH: ${errorMsg}`);
      throw new Error(`Failed to configure SSH for Coder: ${errorMsg}`);
    }

    // Create parent directory for workspace (git clone won't create it)
    // This must happen after ensureXumCoderSSHConfig() so SSH is configured
    initLogger.logStep("Preparing workspace directory...");
    const parentDir = path.posix.dirname(params.workspacePath);
    const mkdirResult = await execBuffered(this, `mkdir -p ${expandTildeForSSH(parentDir)}`, {
      cwd: "/tmp",
      timeout: 10,
      abortSignal,
    });
    if (mkdirResult.exitCode !== 0) {
      const errorMsg = mkdirResult.stderr || mkdirResult.stdout || "Unknown error";
      log.error("Failed to create workspace parent directory", { parentDir, error: errorMsg });
      initLogger.logStderr(`Failed to prepare workspace directory: ${errorMsg}`);
      throw new Error(`Failed to prepare workspace directory: ${errorMsg}`);
    }
  }
}

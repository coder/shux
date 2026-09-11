import { randomUUID } from "crypto";
import * as fsPromises from "fs/promises";
import * as path from "path";
import type {
  PendingMaterialization,
  WorkspaceCreationResult,
  WorkspaceForkParams,
  WorkspaceForkResult,
  InitLogger,
} from "@/node/runtime/Runtime";
import { listLocalBranches, cleanStaleLock, getCurrentBranch } from "@/node/git";
import { execAsync, execFileAsync, type ExecFileAsyncOptions } from "@/node/utils/disposableExec";
import { getBashPath } from "@/node/utils/main/bashPath";
import { getProjectName } from "@/node/utils/runtime/helpers";
import { getErrorMessage } from "@/common/utils/errors";
import { shellQuote } from "@/common/utils/shell";
import { expandTilde } from "@/node/runtime/tildeExpansion";
import { toPosixPath } from "@/node/utils/paths";
import { log } from "@/node/services/log";
import {
  gitHooksAllowed,
  gitNoRepoAutomationEnv,
  gitNoRepoAutomationEnvForLocalRepo,
} from "@/node/utils/gitNoHooksEnv";
import {
  WORKTREE_CREATE_FETCH_TIMEOUT_MS,
  WORKTREE_DELETE_GIT_TIMEOUT_MS,
} from "@/constants/terminationTimeouts";
import { syncLocalGitSubmodules } from "@/node/runtime/submoduleSync";
import { syncXumignoreFiles } from "./xumignore";
import { GitProgressParser, isGitProgressLine } from "./gitProgress";

type GitExecOptions = Pick<ExecFileAsyncOptions, "env" | "signal" | "timeoutMs"> | undefined;

function isAbortError(_error: unknown, signal?: AbortSignal): boolean {
  return signal?.aborted ?? false;
}

const PROTECTED_BRANCH_NAMES = ["main", "master", "trunk", "develop", "default"];
const MISSING_WORKTREE_ERROR_PATTERNS = ["not a working tree", "does not exist", "no such file"];

export class WorktreeManager {
  private readonly srcBaseDir: string;
  private readonly fetchTimeoutMs: number;

  constructor(srcBaseDir: string, options?: { fetchTimeoutMs?: number }) {
    // Expand tilde to actual home directory path for local file system operations
    this.srcBaseDir = expandTilde(srcBaseDir);
    this.fetchTimeoutMs = options?.fetchTimeoutMs ?? WORKTREE_CREATE_FETCH_TIMEOUT_MS;
  }

  getWorkspacePath(projectPath: string, workspaceName: string): string {
    const projectName = getProjectName(projectPath);
    return path.join(this.srcBaseDir, projectName, workspaceName);
  }

  private async getGitExecOptions(
    projectPath: string,
    trusted?: boolean,
    signal?: AbortSignal
  ): Promise<GitExecOptions> {
    const env = gitHooksAllowed(trusted)
      ? undefined
      : await gitNoRepoAutomationEnvForLocalRepo(projectPath, signal);
    return env || signal ? { ...(env ? { env } : {}), ...(signal ? { signal } : {}) } : undefined;
  }

  private async pruneWorktreesBestEffort(
    projectPath: string,
    noHooksEnv: GitExecOptions
  ): Promise<void> {
    try {
      using pruneProc = execFileAsync("git", ["-C", projectPath, "worktree", "prune"], noHooksEnv);
      await pruneProc.result;
    } catch {
      // Ignore prune errors during cleanup/idempotent flows.
    }
  }

  private async forceRemoveWorkspaceDirectory(workspacePath: string): Promise<void> {
    // Use bash for rm -rf on Windows; shellQuote prevents injection from malicious paths.
    using rmProc = execAsync(`rm -rf ${shellQuote(toPosixPath(workspacePath))}`, {
      shell: getBashPath(),
    });
    await rmProc.result;
  }

  async createWorkspace(params: {
    projectPath: string;
    branchName: string;
    directoryName?: string;
    trunkBranch: string;
    startPoint?: string;
    skipRemoteSync?: boolean;
    workspacePathOverride?: string;
    initLogger: InitLogger;
    abortSignal?: AbortSignal;
    env?: Record<string, string>;
    trusted?: boolean;
    /** See WorkspaceCreationParams.deferMaterialization. */
    deferMaterialization?: boolean;
  }): Promise<WorkspaceCreationResult> {
    const { projectPath, branchName, trunkBranch, initLogger } = params;
    // Disable git hooks for untrusted projects (prevents post-checkout execution).
    // Filter discovery is fail-closed, but creation callers consume a
    // structured result, so translate preflight failures at this boundary.
    let noHooksEnv: GitExecOptions;
    try {
      noHooksEnv = await this.getGitExecOptions(projectPath, params.trusted, params.abortSignal);
    } catch (error) {
      return { success: false, error: getErrorMessage(error) };
    }
    const workspaceName = params.directoryName ?? branchName;
    const workspacePath =
      params.workspacePathOverride ?? this.getWorkspacePath(projectPath, workspaceName);
    const skipRemoteSync = params.skipRemoteSync === true;
    const trimmedStartPoint = params.startPoint?.trim();
    const startPoint =
      trimmedStartPoint && trimmedStartPoint.length > 0 ? trimmedStartPoint : undefined;
    let worktreeCreated = false;
    let createdBranch = false;

    // Clean up stale lock before git operations on main repo
    cleanStaleLock(projectPath);

    try {
      initLogger.logStep("Creating git worktree...");

      // Create parent directory if needed
      const parentDir = path.dirname(workspacePath);
      try {
        await fsPromises.access(parentDir);
      } catch {
        await fsPromises.mkdir(parentDir, { recursive: true });
      }

      // Check if workspace already exists
      try {
        await fsPromises.access(workspacePath);
        return {
          success: false,
          error: `Workspace already exists at ${workspacePath}`,
        };
      } catch {
        // Workspace doesn't exist, proceed with creation
      }

      // Check if branch exists locally
      const localBranches = await listLocalBranches(projectPath);
      const branchExists = localBranches.includes(branchName);

      // Remote configuration can select executable upload-pack/helper
      // commands. When repo automation is disallowed, stay entirely on local
      // refs instead of executing any repo-configured fetch behavior.
      const remoteSyncAllowed = !skipRemoteSync && gitHooksAllowed(params.trusted);
      if (!skipRemoteSync && !remoteSyncAllowed) {
        initLogger.logStep(
          "Skipping origin fetch while project automation is disabled; using local state."
        );
      }
      const fetchedOrigin = remoteSyncAllowed
        ? await this.fetchOriginTrunk(projectPath, trunkBranch, initLogger, noHooksEnv)
        : false;

      // Determine best base for new branches: use origin if local can fast-forward to it,
      // otherwise preserve local state (user may have unpushed work)
      const shouldUseOrigin =
        remoteSyncAllowed &&
        fetchedOrigin &&
        (await this.canFastForwardToOrigin(
          projectPath,
          trunkBranch,
          initLogger,
          params.abortSignal
        ));

      // Files are populated by a separate checkout (materializeWorkspace) so large repositories
      // can stream progress, and so callers may announce the workspace before populating it.
      // Restore flows may supply an exact saved commit instead of the current trunk.
      const newBranchBase = startPoint ?? (shouldUseOrigin ? `origin/${trunkBranch}` : trunkBranch);
      using addProc = execFileAsync(
        "git",
        [
          "-C",
          projectPath,
          "worktree",
          "add",
          "--no-checkout",
          ...(branchExists
            ? [workspacePath, branchName]
            : ["-b", branchName, workspacePath, newBranchBase]),
        ],
        noHooksEnv
      );
      const addResult = await addProc.result;
      createdBranch = !branchExists;
      worktreeCreated = true;
      // git reports routine progress ("Preparing worktree", "Updating files") on stderr;
      // failures surface through the thrown error below, so none of this is error output.
      for (const line of `${addResult.stdout}\n${addResult.stderr}`.split(/[\r\n]/)) {
        if (line) initLogger.logStdout(line);
      }

      // Fast-forward existing branches to origin only when local trunk can fast-forward too
      // (preserves unpushed work).
      const pending: PendingMaterialization = {
        fastForwardFromOrigin: !skipRemoteSync && shouldUseOrigin && branchExists,
      };
      if (params.deferMaterialization) {
        await this.persistWorkspaceBranchMapping(projectPath, workspaceName, branchName);
        return { success: true, workspacePath, pendingMaterialization: pending };
      }

      await this.materializeWorkspace(
        {
          projectPath,
          workspacePath,
          branchName,
          trunkBranch,
          initLogger,
          abortSignal: params.abortSignal,
          env: params.env,
          trusted: params.trusted,
        },
        pending
      );

      await this.persistWorkspaceBranchMapping(projectPath, workspaceName, branchName);
      return { success: true, workspacePath };
    } catch (error) {
      const errorMessage = getErrorMessage(error);
      if (!isAbortError(error, params.abortSignal)) {
        for (const line of errorMessage.split(/\r?\n/)) {
          if (line) initLogger.logStderr(line);
        }
      }

      if (!worktreeCreated) {
        return {
          success: false,
          error: errorMessage,
        };
      }

      try {
        await this.rollbackFailedWorkspaceCreation({
          projectPath,
          workspacePath,
          branchName,
          createdBranch,
          trusted: params.trusted,
        });
        return {
          success: false,
          error: errorMessage,
        };
      } catch (rollbackError) {
        return {
          success: false,
          error: `${errorMessage} (rollback failed: ${getErrorMessage(rollbackError)})`,
        };
      }
    }
  }

  /**
   * Populate a worktree reserved by createWorkspace: streamed checkout, .xumignore sync,
   * optional fast-forward, submodules. Throws on failure without touching the worktree; a
   * deferred checkout is already registered, so its owner decides what happens to it.
   * abortSignal cancels every phase; when checkoutAbortSignal is given it is the only signal
   * the file checkout honours, so an owner that keeps a cancelled worktree gets complete files
   * while everything after them still stops.
   */
  async materializeWorkspace(
    params: {
      projectPath: string;
      workspacePath: string;
      branchName: string;
      trunkBranch: string;
      initLogger: InitLogger;
      abortSignal?: AbortSignal;
      checkoutAbortSignal?: AbortSignal;
      env?: Record<string, string>;
      trusted?: boolean;
    },
    pending: PendingMaterialization
  ): Promise<void> {
    const { projectPath, workspacePath, branchName, trunkBranch, initLogger } = params;
    const noHooksEnv = await this.getGitExecOptions(
      projectPath,
      params.trusted,
      params.abortSignal
    );

    initLogger.logStep("Checking out files...");
    // Git's stderr mixes progress with diagnostics. Progress streams live; diagnostics are
    // held until the exit status is known so a failure is reported as error output once,
    // rather than streamed as output and then repeated as the error.
    const output: string[] = [];
    const progress = new GitProgressParser(
      (stage, percent) => initLogger.logProgress?.(stage, percent),
      (line) => output.push(line)
    );
    const stdout: string[] = [];
    const checkoutOptions = {
      ...noHooksEnv,
      onStderrData: (chunk: string) => progress.push(chunk),
      // Smudge filters and hooks inherit git's pipes; cancelling must not hang on them.
      killTreeOnTermination: true,
    };
    try {
      // Populate the files while HEAD still holds the branch, so no other worktree can claim it
      // for as long as the checkout streams. Hooks stay off here: the switch below reruns the
      // checkout for them.
      // Submodule repos do not exist yet in a linked worktree, so recursion would fail;
      // syncLocalGitSubmodules materializes them below, like `git worktree add` does.
      // No --force: a deferred checkout runs in an announced workspace, so anything written
      // there meanwhile (a terminal, an editor) must fail the checkout, not be overwritten.
      using populateProc = execFileAsync(
        "git",
        [
          "-C",
          workspacePath,
          "-c",
          "core.hooksPath=/dev/null",
          "checkout",
          "--quiet",
          "--progress",
          "--no-recurse-submodules",
          branchName,
        ],
        {
          ...checkoutOptions,
          signal: params.checkoutAbortSignal ?? params.abortSignal,
          // git delays progress output by 2s, which hides it for most checkouts.
          env: { ...noHooksEnv?.env, GIT_PROGRESS_DELAY: "0" },
        }
      );
      stdout.push((await populateProc.result).stdout);
      // The files are in place; switch onto the branch from an unborn ref so trusted
      // post-checkout hooks receive the same arguments as a plain `git worktree add` (null old
      // commit, new-worktree flag). Nothing is written, so the branch is unclaimed only for the
      // instant between these two commands.
      using unbornProc = execFileAsync(
        "git",
        ["-C", workspacePath, "symbolic-ref", "HEAD", `refs/heads/xum-unborn-${randomUUID()}`],
        noHooksEnv
      );
      await unbornProc.result;
      using switchProc = execFileAsync(
        "git",
        ["-C", workspacePath, "checkout", "--no-recurse-submodules", branchName],
        checkoutOptions
      );
      stdout.push((await switchProc.result).stdout);
      progress.flush();
      for (const line of [...output, ...stdout.flatMap((text) => text.split(/[\r\n]/))]) {
        if (line) initLogger.logStdout(line);
      }
    } catch (error) {
      progress.flush();
      // A retained (deferred) workspace must not be left on the placeholder ref or with the
      // empty pre-checkout index: a later commit would land on the placeholder or record every
      // tracked file as deleted. Put HEAD back on the branch and rebuild the index from it,
      // leaving the working tree alone. Runs without the caller's signal because an aborted
      // checkout needs the restore most.
      const restoreOptions = noHooksEnv?.env ? { env: noHooksEnv.env } : undefined;
      try {
        using restoreProc = execFileAsync(
          "git",
          ["-C", workspacePath, "symbolic-ref", "HEAD", `refs/heads/${branchName}`],
          restoreOptions
        );
        await restoreProc.result;
        using resetProc = execFileAsync(
          "git",
          ["-C", workspacePath, "reset", "--quiet"],
          restoreOptions
        );
        await resetProc.result;
      } catch {
        // The checkout error below is the one worth reporting.
      }
      const diagnostics = output.filter((line) => !isGitProgressLine(line));
      throw new Error(diagnostics.length > 0 ? diagnostics.join("\n") : getErrorMessage(error));
    }

    initLogger.logStep("Worktree created successfully");

    // Sync gitignored files declared in .xumignore (e.g. .env)
    // before init hooks run so they have access to secrets/config
    initLogger.logStep("Syncing .xumignore files...");
    await syncXumignoreFiles(projectPath, workspacePath);

    if (pending.fastForwardFromOrigin) {
      await this.fastForwardToOrigin(workspacePath, trunkBranch, initLogger, noHooksEnv);
    }

    // Worktree creation is responsible for materializing the checkout completely.
    // Skills, docs, and other repo-managed files may live inside submodules, so make
    // them available before any runtime-specific provisioning or init hooks run.
    await syncLocalGitSubmodules({
      workspacePath,
      initLogger,
      abortSignal: params.abortSignal,
      env: params.env,
      trusted: params.trusted,
    });
  }

  private async rollbackFailedWorkspaceCreation(args: {
    projectPath: string;
    workspacePath: string;
    branchName: string;
    createdBranch: boolean;
    trusted?: boolean;
  }): Promise<void> {
    const noHooksEnv = await this.getGitExecOptions(args.projectPath, args.trusted);

    try {
      using removeProc = execFileAsync(
        "git",
        ["-C", args.projectPath, "worktree", "remove", "--force", args.workspacePath],
        noHooksEnv
      );
      await removeProc.result;
    } catch {
      // If git refuses to remove a partially-initialized worktree (for example because a
      // submodule checkout left extra files behind), fall back to pruning metadata and
      // deleting the directory so retries do not get stuck behind a stale collision.
      await this.pruneWorktreesBestEffort(args.projectPath, noHooksEnv);
      await this.forceRemoveWorkspaceDirectory(args.workspacePath);
    }

    // Best-effort cleanup - branch deletion below will still refuse if metadata remains.
    await this.pruneWorktreesBestEffort(args.projectPath, noHooksEnv);

    if (!args.createdBranch) {
      return;
    }

    using deleteProc = execFileAsync(
      "git",
      ["-C", args.projectPath, "branch", "-D", args.branchName],
      noHooksEnv
    );
    await deleteProc.result;
  }

  /**
   * Fetch trunk branch from origin before worktree creation.
   * Returns true if fetch succeeded (origin is available for branching).
   */
  private async fetchOriginTrunk(
    projectPath: string,
    trunkBranch: string,
    initLogger: InitLogger,
    noHooksEnv: GitExecOptions
  ): Promise<boolean> {
    // A credential helper such as Coder's askpass can block the fetch indefinitely while it waits
    // for external authentication, and even a killed fetch leaves helpers holding the stdio pipes.
    // Bound the fetch separately from caller cancellation so a deadline falls back to the local
    // trunk while an explicit abort still cancels creation.
    const deadline = AbortSignal.timeout(this.fetchTimeoutMs);
    const callerSignal = noHooksEnv?.signal;
    try {
      initLogger.logStep(`Fetching latest from origin/${trunkBranch}...`);

      using fetchProc = execFileAsync("git", ["-C", projectPath, "fetch", "origin", trunkBranch], {
        ...noHooksEnv,
        signal: callerSignal ? AbortSignal.any([callerSignal, deadline]) : deadline,
        killTreeOnTermination: true,
      });
      await fetchProc.result;

      initLogger.logStep("Fetched latest from origin");
      return true;
    } catch (error) {
      if (isAbortError(error, callerSignal)) {
        throw error;
      }
      if (deadline.aborted) {
        const seconds = Math.round(this.fetchTimeoutMs / 1000);
        initLogger.logStderr(
          `Note: Fetch from origin did not finish within ${seconds}s (Git may be waiting on a credential helper or external authentication); using local branch state`
        );
        log.warn("Worktree creation fetch timed out; using local trunk", {
          projectPath,
          trunkBranch,
          timeoutMs: this.fetchTimeoutMs,
        });
        return false;
      }
      const errorMsg = getErrorMessage(error);
      // Branch doesn't exist on origin (common for subagent local-only branches)
      if (errorMsg.includes("couldn't find remote ref")) {
        initLogger.logStep(`Branch "${trunkBranch}" not found on origin; using local state.`);
      } else {
        initLogger.logStderr(
          `Note: Could not fetch from origin (${errorMsg}), using local branch state`
        );
      }
      return false;
    }
  }

  /**
   * Check if local trunk can fast-forward to origin/<trunk>.
   * Returns true if local is behind or equal to origin (safe to use origin).
   * Returns false if local is ahead or diverged (preserve local state).
   */
  private async canFastForwardToOrigin(
    projectPath: string,
    trunkBranch: string,
    initLogger: InitLogger,
    abortSignal?: AbortSignal
  ): Promise<boolean> {
    try {
      // Check if local trunk is an ancestor of origin/trunk
      // Exit code 0 = local is ancestor (can fast-forward), non-zero = cannot
      using proc = execFileAsync(
        "git",
        ["-C", projectPath, "merge-base", "--is-ancestor", trunkBranch, `origin/${trunkBranch}`],
        abortSignal ? { signal: abortSignal } : undefined
      );
      await proc.result;
      return true; // Local is behind or equal to origin
    } catch (error) {
      if (isAbortError(error, abortSignal)) {
        throw error;
      }
      // Local is ahead or diverged - preserve local state
      initLogger.logStderr(
        `Note: Local ${trunkBranch} is ahead of or diverged from origin, using local state`
      );
      return false;
    }
  }

  /**
   * Fast-forward merge to latest origin/<trunkBranch> after checkout.
   * Best-effort operation for existing branches that may be behind origin.
   */
  private async fastForwardToOrigin(
    workspacePath: string,
    trunkBranch: string,
    initLogger: InitLogger,
    noHooksEnv: GitExecOptions
  ): Promise<void> {
    try {
      initLogger.logStep("Fast-forward merging...");

      using mergeProc = execFileAsync(
        "git",
        ["-C", workspacePath, "merge", "--ff-only", `origin/${trunkBranch}`],
        noHooksEnv
      );
      await mergeProc.result;
      initLogger.logStep("Fast-forwarded to latest origin successfully");
    } catch (mergeError) {
      if (isAbortError(mergeError, noHooksEnv?.signal)) {
        throw mergeError;
      }
      // Fast-forward not possible (diverged branches) - just warn
      const errorMsg = getErrorMessage(mergeError);
      initLogger.logStderr(`Note: Fast-forward failed (${errorMsg}), using local branch state`);
    }
  }

  async renameWorkspace(
    projectPath: string,
    oldName: string,
    newName: string,
    trusted?: boolean
  ): Promise<
    { success: true; oldPath: string; newPath: string } | { success: false; error: string }
  > {
    // Clean up stale lock before git operations on main repo
    cleanStaleLock(projectPath);

    // Disable git hooks for untrusted projects
    let noHooksEnv: GitExecOptions;
    try {
      noHooksEnv = await this.getGitExecOptions(projectPath, trusted);
    } catch (error) {
      return { success: false, error: `Failed to rename workspace: ${getErrorMessage(error)}` };
    }

    // Compute workspace paths using canonical method
    const oldPath = this.getWorkspacePath(projectPath, oldName);
    const newPath = this.getWorkspacePath(projectPath, newName);

    try {
      // Move the worktree directory (updates git's internal worktree metadata)
      using moveProc = execFileAsync(
        "git",
        ["-C", projectPath, "worktree", "move", oldPath, newPath],
        noHooksEnv
      );
      await moveProc.result;

      // Rename the tracked branch only when workspace identity still follows the old workspace
      // name. Diverged workspaces keep their original branch and must not rename unrelated refs.
      const originalBranchName =
        (await this.getPersistedWorkspaceBranchName(projectPath, oldName)) ?? oldName;
      let renamedBranchName = originalBranchName;
      if (originalBranchName === oldName) {
        try {
          using branchProc = execFileAsync(
            "git",
            ["-C", newPath, "branch", "-m", oldName, newName],
            noHooksEnv
          );
          await branchProc.result;
          renamedBranchName = newName;
        } catch {
          // Branch rename failed - this is fine, the directory was still moved.
        }
      }

      await this.updateWorkspaceBranchMapping(projectPath, oldName, newName, renamedBranchName);
      return { success: true, oldPath, newPath };
    } catch (error) {
      return { success: false, error: `Failed to rename workspace: ${getErrorMessage(error)}` };
    }
  }

  async canDeleteWorkspaceWithoutForce(
    projectPath: string,
    workspaceName: string,
    trusted?: boolean
  ): Promise<{ success: true } | { success: false; error: string }> {
    // Match deleteWorkspace() semantics so preflight stays idempotent and non-destructive.
    cleanStaleLock(projectPath);

    const workspacePath = this.getWorkspacePath(projectPath, workspaceName);
    const isInPlace = projectPath === workspaceName;

    try {
      await fsPromises.access(workspacePath);
    } catch {
      return { success: true };
    }

    if (isInPlace) {
      return { success: true };
    }

    // Resolve the git environment only after the idempotent checks above:
    // repo-aware filter discovery fails closed when the main checkout is
    // missing or corrupted, and preflight must keep returning its declared
    // result so stale workspaces stay deletable (via force).
    let noHooksEnv: GitExecOptions;
    try {
      noHooksEnv = await this.getGitExecOptions(projectPath, trusted);
    } catch (error) {
      return {
        success: false,
        error: `Failed to inspect worktree before deletion: ${getErrorMessage(error)}`,
      };
    }

    try {
      const workspaceBlock = this.findWorktreeBlockByPath(
        await this.listWorktreeBlocks(projectPath, noHooksEnv),
        workspacePath
      );

      if (!workspaceBlock) {
        return {
          success: false,
          error: `Workspace is not registered as a git worktree: ${workspacePath}`,
        };
      }

      const isLocked = workspaceBlock.split("\n").some((line) => {
        const trimmed = line.trim();
        return trimmed === "locked" || trimmed.startsWith("locked ");
      });
      if (isLocked) {
        return {
          success: false,
          error: "Workspace is locked and requires force removal",
        };
      }
    } catch (error) {
      return {
        success: false,
        error: `Failed to inspect worktree before deletion: ${getErrorMessage(error)}`,
      };
    }

    try {
      using statusProc = execFileAsync(
        "git",
        ["-C", workspacePath, "status", "--porcelain", "--untracked-files=all"],
        noHooksEnv
      );
      const { stdout } = await statusProc.result;
      if (stdout.trim().length > 0) {
        return {
          success: false,
          error: "Workspace has uncommitted or untracked changes",
        };
      }
    } catch (error) {
      return {
        success: false,
        error: `Failed to inspect worktree before deletion: ${getErrorMessage(error)}`,
      };
    }

    return { success: true };
  }

  async deleteWorkspace(
    projectPath: string,
    workspaceName: string,
    force: boolean,
    trusted?: boolean
  ): Promise<{ success: true; deletedPath: string } | { success: false; error: string }> {
    // Clean up stale lock before git operations on main repo
    cleanStaleLock(projectPath);

    // Disable git hooks for untrusted projects and bound every git cleanup command.
    let repoInspectionError: string | null = null;
    let gitExecOptions: GitExecOptions;
    try {
      gitExecOptions = await this.getGitExecOptions(projectPath, trusted);
    } catch (error) {
      // Repo-aware filter discovery fails closed when the main checkout is
      // missing or corrupted. Cleanup must still work, so fall back to the
      // static automation-off environment; content-inspecting git commands
      // are skipped below while this error is set.
      repoInspectionError = getErrorMessage(error);
      gitExecOptions = { env: gitNoRepoAutomationEnv() };
    }
    const noHooksEnv: GitExecOptions = {
      ...gitExecOptions,
      timeoutMs: WORKTREE_DELETE_GIT_TIMEOUT_MS,
    };

    // In-place workspaces are identified by projectPath === workspaceName.
    // These are direct workspace directories (e.g., CLI/benchmark sessions), not git worktrees.
    const isInPlace = projectPath === workspaceName;
    const deletedPath = this.getWorkspacePath(projectPath, workspaceName);
    const branchName = isInPlace
      ? null
      : await this.getPersistedWorkspaceBranchName(projectPath, workspaceName);
    // Preserve legacy cleanup semantics for workspaces that predate branch-map persistence.
    // Those older workspaces always used workspaceName === branchName, so if this specific
    // workspace has no stored mapping we can safely fall back to the workspace name.
    const allowWorkspaceNameFallback = !branchName && !isInPlace;
    const branchDeleteArgs = {
      projectPath,
      workspaceName,
      branchName,
      force,
      isInPlace,
      noHooksEnv,
      allowWorkspaceNameFallback,
    };
    const deleteBranchAndSucceed = async (pruneWorktrees = false) => {
      if (pruneWorktrees) {
        await this.pruneWorktreesBestEffort(projectPath, noHooksEnv);
      }
      await this.deleteWorkspaceBranchIfSafe(branchDeleteArgs);
      await this.deletePersistedWorkspaceBranchMapping(projectPath, workspaceName);
      return { success: true as const, deletedPath };
    };

    try {
      await fsPromises.access(deletedPath);
    } catch {
      return deleteBranchAndSucceed(!isInPlace);
    }

    // For in-place workspaces, there's no worktree to remove.
    // The workspace directory itself is the user's real project checkout.
    if (isInPlace) {
      return { success: true, deletedPath };
    }

    if (repoInspectionError !== null) {
      // Without repo-aware filter overrides, git worktree remove must not run:
      // its dirty-worktree check refreshes the index, which can execute
      // repo-configured clean filters. Force removal bypasses git content
      // inspection entirely; non-force deletion reports the blocker instead.
      if (!force) {
        return { success: false, error: `Failed to remove worktree: ${repoInspectionError}` };
      }
      try {
        await this.pruneWorktreesBestEffort(projectPath, noHooksEnv);
        await this.forceRemoveWorkspaceDirectory(deletedPath);
        return deleteBranchAndSucceed();
      } catch (rmError) {
        return {
          success: false,
          error: `Failed to remove worktree via git and rm: ${getErrorMessage(rmError)}`,
        };
      }
    }

    try {
      await this.removeGitWorktree(projectPath, deletedPath, force, noHooksEnv);
      return deleteBranchAndSucceed();
    } catch (error) {
      const message = getErrorMessage(error);

      if (this.isMissingWorktreeError(message)) {
        return deleteBranchAndSucceed(true);
      }

      if (!force) {
        return { success: false, error: `Failed to remove worktree: ${message}` };
      }

      try {
        await this.pruneWorktreesBestEffort(projectPath, noHooksEnv);
        await this.forceRemoveWorkspaceDirectory(deletedPath);
        return deleteBranchAndSucceed();
      } catch (rmError) {
        return {
          success: false,
          error: `Failed to remove worktree via git and rm: ${getErrorMessage(rmError)}`,
        };
      }
    }
  }

  private async listWorktreeBlocks(
    projectPath: string,
    noHooksEnv: GitExecOptions
  ): Promise<string[]> {
    using worktreeProc = execFileAsync(
      "git",
      ["-C", projectPath, "worktree", "list", "--porcelain"],
      noHooksEnv
    );
    const { stdout } = await worktreeProc.result;
    return stdout.split("\n\n").filter((block) => block.trim().length > 0);
  }

  private findWorktreeBlockByPath(
    worktreeBlocks: string[],
    workspacePath: string
  ): string | undefined {
    const resolvedWorkspacePath = path.resolve(workspacePath);
    return worktreeBlocks.find((block) => {
      return block.split("\n").some((line) => {
        if (!line.startsWith("worktree ")) {
          return false;
        }
        return path.resolve(line.slice("worktree ".length).trim()) === resolvedWorkspacePath;
      });
    });
  }

  private getWorktreeBranchName(worktreeBlock: string): string | null {
    const branchLine = worktreeBlock
      .split("\n")
      .find((line) => line.startsWith("branch refs/heads/"));
    return branchLine ? branchLine.slice("branch refs/heads/".length).trim() || null : null;
  }

  private async persistWorkspaceBranchMapping(
    projectPath: string,
    workspaceName: string,
    branchName: string
  ): Promise<void> {
    // Divergent workspace and branch names rely on this mapping for safe stale-worktree
    // cleanup, so callers must see persistence failures instead of silently proceeding.
    const branchMap = await this.readWorkspaceBranchMap(projectPath);
    branchMap[workspaceName] = branchName;
    await this.writeWorkspaceBranchMap(projectPath, branchMap);
  }

  private async updateWorkspaceBranchMapping(
    projectPath: string,
    oldWorkspaceName: string,
    newWorkspaceName: string,
    branchName: string | null
  ): Promise<void> {
    // Rename can leave the branch name different from the workspace directory, so keep the
    // mapping update on the main control path rather than silently ignoring write failures.
    const branchMap = await this.readWorkspaceBranchMap(projectPath);
    const resolvedBranchName = branchName?.trim() ?? branchMap[oldWorkspaceName]?.trim();
    delete branchMap[oldWorkspaceName];
    if (resolvedBranchName) {
      branchMap[newWorkspaceName] = resolvedBranchName;
    }
    await this.writeWorkspaceBranchMap(projectPath, branchMap);
  }

  private async getPersistedWorkspaceBranchName(
    projectPath: string,
    workspaceName: string
  ): Promise<string | null> {
    const branchName = (await this.readWorkspaceBranchMap(projectPath))[workspaceName]?.trim();
    return branchName || null;
  }

  private async deletePersistedWorkspaceBranchMapping(
    projectPath: string,
    workspaceName: string
  ): Promise<void> {
    try {
      const branchMap = await this.readWorkspaceBranchMap(projectPath);
      if (!(workspaceName in branchMap)) {
        return;
      }
      delete branchMap[workspaceName];
      await this.writeWorkspaceBranchMap(projectPath, branchMap);
    } catch (error) {
      log.debug("Failed to delete workspace branch mapping", {
        projectPath,
        workspaceName,
        error: getErrorMessage(error),
      });
    }
  }

  private async readWorkspaceBranchMap(projectPath: string): Promise<Record<string, string>> {
    try {
      const contents = await fsPromises.readFile(
        await this.getWorkspaceBranchMapPath(projectPath),
        "utf8"
      );
      const parsed: unknown = JSON.parse(contents);
      if (typeof parsed !== "object" || parsed === null) {
        return {};
      }
      return Object.fromEntries(
        Object.entries(parsed).filter(([workspaceName, branchName]) => {
          return (
            workspaceName.trim().length > 0 &&
            typeof branchName === "string" &&
            branchName.trim().length > 0
          );
        })
      );
    } catch {
      return {};
    }
  }

  private async writeWorkspaceBranchMap(
    projectPath: string,
    branchMap: Record<string, string>
  ): Promise<void> {
    const branchMapPath = await this.getWorkspaceBranchMapPath(projectPath);
    if (Object.keys(branchMap).length === 0) {
      await fsPromises.rm(branchMapPath, { force: true });
      return;
    }
    await fsPromises.writeFile(branchMapPath, `${JSON.stringify(branchMap, null, 2)}\n`);
  }

  private async getWorkspaceBranchMapPath(projectPath: string): Promise<string> {
    const gitPath = path.join(projectPath, ".git");

    try {
      const gitPathStat = await fsPromises.stat(gitPath);
      if (gitPathStat.isDirectory()) {
        return path.join(gitPath, "mux-workspace-branches.json");
      }

      const gitDirRef = await fsPromises.readFile(gitPath, "utf8");
      const gitDirPrefix = "gitdir:";
      const gitDirLine = gitDirRef.trim();
      if (gitDirLine.startsWith(gitDirPrefix)) {
        return path.join(
          path.resolve(projectPath, gitDirLine.slice(gitDirPrefix.length).trim()),
          "mux-workspace-branches.json"
        );
      }
    } catch {
      // Fall through to the default .git path when git metadata is unavailable.
    }

    return path.join(gitPath, "mux-workspace-branches.json");
  }

  private async deleteWorkspaceBranchIfSafe(args: {
    projectPath: string;
    workspaceName: string;
    branchName: string | null;
    force: boolean;
    isInPlace: boolean;
    noHooksEnv: GitExecOptions;
    allowWorkspaceNameFallback: boolean;
  }): Promise<void> {
    // For git worktree workspaces, workspaceName is the branch name.
    // Now that archiving exists, deleting a workspace should also delete its local branch by default.
    if (args.isInPlace) {
      return;
    }

    const branchToDelete =
      args.branchName?.trim() ?? (args.allowWorkspaceNameFallback ? args.workspaceName.trim() : "");
    if (!branchToDelete) {
      log.debug("Skipping git branch deletion: workspace branch is unknown", {
        projectPath: args.projectPath,
        workspaceName: args.workspaceName,
      });
      return;
    }

    let localBranches: string[];
    try {
      localBranches = await listLocalBranches(args.projectPath, args.noHooksEnv);
    } catch (error) {
      log.debug("Failed to list local branches; skipping branch deletion", {
        projectPath: args.projectPath,
        workspaceName: branchToDelete,
        error: getErrorMessage(error),
      });
      return;
    }

    if (!localBranches.includes(branchToDelete)) {
      log.debug("Skipping git branch deletion: branch does not exist locally", {
        projectPath: args.projectPath,
        workspaceName: branchToDelete,
      });
      return;
    }

    const protectedBranches = await this.getProtectedBranches(
      args.projectPath,
      localBranches,
      args.noHooksEnv
    );
    if (protectedBranches.has(branchToDelete)) {
      log.debug("Skipping git branch deletion: protected branch", {
        projectPath: args.projectPath,
        workspaceName: branchToDelete,
      });
      return;
    }

    if (
      await this.isBranchCheckedOutByWorktree(args.projectPath, branchToDelete, args.noHooksEnv)
    ) {
      log.debug("Skipping git branch deletion: branch still checked out by a worktree", {
        projectPath: args.projectPath,
        workspaceName: branchToDelete,
      });
      return;
    }

    const deleteFlag = args.force ? "-D" : "-d";
    try {
      using deleteProc = execFileAsync(
        "git",
        ["-C", args.projectPath, "branch", deleteFlag, branchToDelete],
        args.noHooksEnv
      );
      await deleteProc.result;
    } catch (error) {
      // Best-effort: workspace deletion should not fail just because branch cleanup failed.
      log.debug("Failed to delete git branch after removing worktree", {
        projectPath: args.projectPath,
        workspaceName: branchToDelete,
        error: getErrorMessage(error),
      });
    }
  }

  private async getProtectedBranches(
    projectPath: string,
    localBranches: string[],
    noHooksEnv: GitExecOptions
  ): Promise<Set<string>> {
    const protectedBranches = new Set<string>(PROTECTED_BRANCH_NAMES);

    // If there's only one local branch, treat it as protected (likely trunk).
    if (localBranches.length === 1) {
      protectedBranches.add(localBranches[0]);
    }

    const currentBranch = await getCurrentBranch(projectPath, noHooksEnv);
    if (currentBranch) {
      protectedBranches.add(currentBranch);
    }

    // If origin/HEAD points at a local branch, also treat it as protected.
    try {
      using originHeadProc = execFileAsync(
        "git",
        ["-C", projectPath, "symbolic-ref", "refs/remotes/origin/HEAD"],
        noHooksEnv
      );
      const { stdout } = await originHeadProc.result;
      const ref = stdout.trim();
      const prefix = "refs/remotes/origin/";
      if (ref.startsWith(prefix)) {
        protectedBranches.add(ref.slice(prefix.length));
      }
    } catch {
      // No origin/HEAD (or not a git repo) - ignore.
    }

    return protectedBranches;
  }

  private async isBranchCheckedOutByWorktree(
    projectPath: string,
    branchName: string,
    noHooksEnv: GitExecOptions
  ): Promise<boolean> {
    try {
      const worktreeBlocks = await this.listWorktreeBlocks(projectPath, noHooksEnv);
      return worktreeBlocks.some((block) => this.getWorktreeBranchName(block) === branchName);
    } catch (error) {
      // If the worktree list fails, proceed anyway - git itself will refuse to delete a checked-out branch.
      log.debug("Failed to check worktree list before branch deletion; proceeding", {
        projectPath,
        workspaceName: branchName,
        error: getErrorMessage(error),
      });
      return false;
    }
  }

  private async removeGitWorktree(
    projectPath: string,
    workspacePath: string,
    force: boolean,
    noHooksEnv: GitExecOptions
  ): Promise<void> {
    const removeArgs = ["-C", projectPath, "worktree", "remove"];
    if (force) {
      removeArgs.push("--force");
    }
    removeArgs.push(workspacePath);

    using proc = execFileAsync("git", removeArgs, noHooksEnv);
    await proc.result;
  }

  private isMissingWorktreeError(message: string): boolean {
    const normalizedError = message.toLowerCase();
    return MISSING_WORKTREE_ERROR_PATTERNS.some((pattern) => normalizedError.includes(pattern));
  }

  async forkWorkspace(
    params: WorkspaceForkParams,
    options?: {
      /**
       * Explicit source checkout path. Overrides the name-derived path for sources whose
       * persisted path diverges from their name (e.g. isolation: "none" tasks sharing a parent
       * checkout). See WorktreeRuntime.forkWorkspace.
       */
      sourceWorkspacePath?: string;
    }
  ): Promise<WorkspaceForkResult> {
    const { projectPath, sourceWorkspaceName, newWorkspaceName, initLogger } = params;

    const sourceWorkspacePath =
      options?.sourceWorkspacePath ?? this.getWorkspacePath(projectPath, sourceWorkspaceName);

    // Get current branch from source workspace
    try {
      using proc = execFileAsync(
        "git",
        ["-C", sourceWorkspacePath, "branch", "--show-current"],
        params.abortSignal ? { signal: params.abortSignal } : undefined
      );
      const { stdout } = await proc.result;
      const sourceBranch = stdout.trim();

      if (!sourceBranch) {
        return {
          success: false,
          error: "Failed to detect branch in source workspace",
        };
      }

      // Use createWorkspace with sourceBranch as trunk to fork from source branch
      const createResult = await this.createWorkspace({
        projectPath,
        branchName: newWorkspaceName,
        directoryName: newWorkspaceName,
        trunkBranch: sourceBranch, // Fork from source branch instead of main/master
        initLogger,
        abortSignal: params.abortSignal,
        env: params.env,
        trusted: params.trusted,
      });

      if (!createResult.success || !createResult.workspacePath) {
        return {
          success: false,
          error: createResult.error ?? "Failed to create workspace",
        };
      }

      return {
        success: true,
        workspacePath: createResult.workspacePath,
        sourceBranch,
      };
    } catch (error) {
      return {
        success: false,
        error: getErrorMessage(error),
      };
    }
  }
}

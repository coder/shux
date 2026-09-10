import * as fs from "fs";
import * as path from "path";
import type { Config } from "@/node/config";
import type { RuntimeConfig } from "@/common/types/runtime";
import { execFileAsync, type ExecFileAsyncOptions } from "@/node/utils/disposableExec";
import { createRuntime } from "./runtime/runtimeFactory";
import { log } from "./services/log";
import { getErrorMessage } from "@/common/utils/errors";

/**
 * Remove stale .git/index.lock file if it exists and is old.
 *
 * Git creates index.lock during operations that modify the index. If a process
 * is killed mid-operation (user cancel, crash, terminal closed), the lock file
 * gets orphaned. This is common in Xum when git operations are interrupted.
 *
 * We only remove locks older than STALE_LOCK_AGE_MS to avoid removing locks
 * from legitimately running processes.
 */
const STALE_LOCK_AGE_MS = 5000; // 5 seconds

export function cleanStaleLock(repoPath: string): void {
  const lockPath = path.join(repoPath, ".git", "index.lock");
  try {
    const stat = fs.statSync(lockPath);
    const ageMs = Date.now() - stat.mtimeMs;
    if (ageMs > STALE_LOCK_AGE_MS) {
      fs.unlinkSync(lockPath);
      log.info(`Removed stale git index.lock (age: ${Math.round(ageMs / 1000)}s) at ${lockPath}`);
    }
  } catch {
    // Lock doesn't exist or can't be accessed - this is fine
  }
}

export interface WorktreeResult {
  success: boolean;
  path?: string;
  error?: string;
}

export interface CreateWorktreeOptions {
  trunkBranch: string;
  /** Directory name to use for the worktree (if not provided, uses branchName) */
  directoryName?: string;
  /** Runtime configuration (needed to compute workspace path) */
  runtimeConfig?: RuntimeConfig;
}

export async function listLocalBranches(
  projectPath: string,
  options?: ExecFileAsyncOptions
): Promise<string[]> {
  using proc = execFileAsync(
    "git",
    ["-C", projectPath, "for-each-ref", "--format=%(refname:short)", "refs/heads"],
    options
  );
  const { stdout } = await proc.result;
  return stdout
    .split("\n")
    .map((line) => line.trim())
    .filter((line) => line.length > 0)
    .sort((a, b) => a.localeCompare(b));
}

export async function getCurrentBranch(
  projectPath: string,
  options?: ExecFileAsyncOptions
): Promise<string | null> {
  try {
    using proc = execFileAsync(
      "git",
      ["-C", projectPath, "rev-parse", "--abbrev-ref", "HEAD"],
      options
    );
    const { stdout } = await proc.result;
    const branch = stdout.trim();
    if (!branch || branch === "HEAD") {
      return null;
    }
    return branch;
  } catch {
    return null;
  }
}

const FALLBACK_TRUNK_CANDIDATES = ["main", "master", "trunk", "develop", "default"];

export async function detectDefaultTrunkBranch(
  projectPath: string,
  branches?: string[]
): Promise<string> {
  const branchList = branches ?? (await listLocalBranches(projectPath));

  if (branchList.length === 0) {
    throw new Error(`No branches available in repository ${projectPath}`);
  }

  const branchSet = new Set(branchList);
  const currentBranch = await getCurrentBranch(projectPath);

  if (currentBranch && branchSet.has(currentBranch)) {
    return currentBranch;
  }

  for (const candidate of FALLBACK_TRUNK_CANDIDATES) {
    if (branchSet.has(candidate)) {
      return candidate;
    }
  }

  return branchList[0];
}

export async function createWorktree(
  config: Config,
  projectPath: string,
  branchName: string,
  options: CreateWorktreeOptions
): Promise<WorktreeResult> {
  // Clean up stale lock before git operations on main repo
  cleanStaleLock(projectPath);

  try {
    // Use directoryName if provided, otherwise fall back to branchName (legacy)
    const dirName = options.directoryName ?? branchName;
    // Compute workspace path using Runtime (single source of truth)
    const runtime = createRuntime(
      options.runtimeConfig ?? { type: "local", srcBaseDir: config.srcDir },
      { projectPath }
    );
    const workspacePath = runtime.getWorkspacePath(projectPath, dirName);
    const { trunkBranch } = options;
    const normalizedTrunkBranch = typeof trunkBranch === "string" ? trunkBranch.trim() : "";

    if (!normalizedTrunkBranch) {
      return {
        success: false,
        error: "Trunk branch is required to create a workspace",
      };
    }

    console.assert(
      normalizedTrunkBranch.length > 0,
      "Expected trunk branch to be validated before calling createWorktree"
    );

    // Create workspace directory if it doesn't exist
    if (!fs.existsSync(path.dirname(workspacePath))) {
      fs.mkdirSync(path.dirname(workspacePath), { recursive: true });
    }

    // Check if workspace already exists
    if (fs.existsSync(workspacePath)) {
      return {
        success: false,
        error: `Workspace already exists at ${workspacePath}`,
      };
    }

    const localBranches = await listLocalBranches(projectPath);

    // If branch already exists locally, reuse it instead of creating a new one
    if (localBranches.includes(branchName)) {
      using proc = execFileAsync("git", [
        "-C",
        projectPath,
        "worktree",
        "add",
        workspacePath,
        branchName,
      ]);
      await proc.result;
      return { success: true, path: workspacePath };
    }

    // Check if branch exists remotely (origin/<branchName>)
    using remoteBranchesProc = execFileAsync("git", ["-C", projectPath, "branch", "-a"]);
    const { stdout: remoteBranchesRaw } = await remoteBranchesProc.result;
    const branchExists = remoteBranchesRaw
      .split("\n")
      .map((b) => b.trim().replace(/^(\*)\s+/, ""))
      .some((b) => b === branchName || b === `remotes/origin/${branchName}`);

    if (branchExists) {
      using proc = execFileAsync("git", [
        "-C",
        projectPath,
        "worktree",
        "add",
        workspacePath,
        branchName,
      ]);
      await proc.result;
      return { success: true, path: workspacePath };
    }

    if (!localBranches.includes(normalizedTrunkBranch)) {
      return {
        success: false,
        error: `Trunk branch "${normalizedTrunkBranch}" does not exist locally`,
      };
    }

    using proc = execFileAsync("git", [
      "-C",
      projectPath,
      "worktree",
      "add",
      "-b",
      branchName,
      workspacePath,
      normalizedTrunkBranch,
    ]);
    await proc.result;

    return { success: true, path: workspacePath };
  } catch (error) {
    const message = getErrorMessage(error);
    return { success: false, error: message };
  }
}

/**
 * Get the main repository path from a worktree path
 * @param worktreePath Path to a git worktree
 * @returns Path to the main repository, or null if not found
 */
export async function getMainWorktreeFromWorktree(worktreePath: string): Promise<string | null> {
  try {
    // Get the worktree list from the worktree itself
    using proc = execFileAsync("git", ["-C", worktreePath, "worktree", "list", "--porcelain"]);
    const { stdout } = await proc.result;
    const lines = stdout.split("\n");

    // The first worktree in the list is always the main worktree
    for (const line of lines) {
      if (line.startsWith("worktree ")) {
        return line.slice("worktree ".length);
      }
    }

    return null;
  } catch {
    return null;
  }
}

export async function removeWorktree(
  projectPath: string,
  workspacePath: string,
  options: { force: boolean } = { force: false }
): Promise<WorktreeResult> {
  // Clean up stale lock before git operations on main repo
  cleanStaleLock(projectPath);

  try {
    // Remove the worktree (from the main repository context)
    const args = ["-C", projectPath, "worktree", "remove", workspacePath];
    if (options.force) {
      args.push("--force");
    }
    using proc = execFileAsync("git", args);
    await proc.result;
    return { success: true };
  } catch (error) {
    const message = getErrorMessage(error);
    return { success: false, error: message };
  }
}

export async function pruneWorktrees(projectPath: string): Promise<WorktreeResult> {
  // Clean up stale lock before git operations on main repo
  cleanStaleLock(projectPath);

  try {
    using proc = execFileAsync("git", ["-C", projectPath, "worktree", "prune"]);
    await proc.result;
    return { success: true };
  } catch (error) {
    const message = getErrorMessage(error);
    return { success: false, error: message };
  }
}

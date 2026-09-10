import type {
  EnsureReadyOptions,
  EnsureReadyResult,
  WorkspaceCreationParams,
  WorkspaceCreationResult,
  WorkspaceInitParams,
  WorkspaceInitResult,
  WorkspaceForkParams,
  WorkspaceForkResult,
} from "./Runtime";
import { WORKSPACE_REPO_MISSING_ERROR } from "./Runtime";
import { LocalBaseRuntime } from "./LocalBaseRuntime";
import { isGitRepository } from "@/node/utils/pathUtils";
import { WorktreeManager } from "@/node/worktree/WorktreeManager";

/**
 * Worktree runtime implementation that executes commands and file operations
 * directly on the host machine using Node.js APIs.
 *
 * This runtime uses git worktrees for workspace isolation:
 * - Workspaces are created in {srcBaseDir}/{projectName}/{workspaceName}
 * - Each workspace is a git worktree with its own branch
 */
export class WorktreeRuntime extends LocalBaseRuntime {
  private readonly worktreeManager: WorktreeManager;
  private readonly currentProjectPath?: string;
  private readonly currentWorkspaceName?: string;
  // Persisted checkout path for this runtime's own workspace. Set when a workspace's on-disk path
  // diverges from the name-derived worktree path — e.g. an isolation: "none" task that shares its
  // parent's checkout (its name is unique but its path points at the parent's worktree).
  private readonly currentWorkspacePath?: string;

  constructor(
    srcBaseDir: string,
    options?: {
      projectPath?: string;
      workspaceName?: string;
      workspacePath?: string;
    }
  ) {
    super();
    this.worktreeManager = new WorktreeManager(srcBaseDir);
    this.currentProjectPath = options?.projectPath;
    this.currentWorkspaceName = options?.workspaceName;
    this.currentWorkspacePath = options?.workspacePath;
  }

  getWorkspacePath(projectPath: string, workspaceName: string): string {
    // Honor an explicit persisted path for this runtime's own workspace so callers (cwd resolution,
    // ensureReady, agent discovery) land in the shared parent checkout instead of a name-derived
    // directory that was never created. Mirrors SSHRuntime.getWorkspacePath.
    if (
      this.currentWorkspacePath &&
      this.currentProjectPath === projectPath &&
      this.currentWorkspaceName === workspaceName
    ) {
      return this.currentWorkspacePath;
    }
    return this.worktreeManager.getWorkspacePath(projectPath, workspaceName);
  }

  override async ensureReady(options?: EnsureReadyOptions): Promise<EnsureReadyResult> {
    if (!this.currentProjectPath || !this.currentWorkspaceName) {
      return { ready: true };
    }

    const statusSink = options?.statusSink;
    statusSink?.({
      phase: "checking",
      runtimeType: "worktree",
      detail: "Checking repository...",
    });

    const workspacePath = this.getWorkspacePath(this.currentProjectPath, this.currentWorkspaceName);
    const hasRepo = await isGitRepository(workspacePath);
    if (!hasRepo) {
      statusSink?.({
        phase: "error",
        runtimeType: "worktree",
        detail: WORKSPACE_REPO_MISSING_ERROR,
      });
      return {
        ready: false,
        error: WORKSPACE_REPO_MISSING_ERROR,
        errorType: "runtime_not_ready",
      };
    }

    statusSink?.({ phase: "ready", runtimeType: "worktree" });
    return { ready: true };
  }

  async createWorkspace(params: WorkspaceCreationParams): Promise<WorkspaceCreationResult> {
    return this.worktreeManager.createWorkspace({
      projectPath: params.projectPath,
      branchName: params.branchName,
      directoryName: params.directoryName,
      trunkBranch: params.trunkBranch,
      startPoint: params.startPoint,
      skipRemoteSync: params.skipRemoteSync,
      workspacePathOverride: params.workspacePathOverride,
      initLogger: params.initLogger,
      abortSignal: params.abortSignal,
      env: params.env,
      trusted: params.trusted,
    });
  }

  async initWorkspace(params: WorkspaceInitParams): Promise<WorkspaceInitResult> {
    return this.initLocalWorkspace(params, "worktree");
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
    // Note: _abortSignal ignored for local operations (fast, no need for cancellation)
    return this.worktreeManager.renameWorkspace(projectPath, oldName, newName, trusted);
  }

  async canDeleteWorkspaceWithoutForce(
    projectPath: string,
    workspaceName: string,
    trusted?: boolean
  ): Promise<{ success: true } | { success: false; error: string }> {
    return this.worktreeManager.canDeleteWorkspaceWithoutForce(projectPath, workspaceName, trusted);
  }

  async deleteWorkspace(
    projectPath: string,
    workspaceName: string,
    force: boolean,
    _abortSignal?: AbortSignal,
    trusted?: boolean
  ): Promise<{ success: true; deletedPath: string } | { success: false; error: string }> {
    // Note: _abortSignal ignored for local operations (fast, no need for cancellation)
    return this.worktreeManager.deleteWorkspace(projectPath, workspaceName, force, trusted);
  }

  async forkWorkspace(params: WorkspaceForkParams): Promise<WorkspaceForkResult> {
    // Resolve the source path through this runtime's override-aware getWorkspacePath so forks
    // FROM a workspace with a persisted path override (e.g. an isolation: "none" task sharing
    // its parent's checkout) read the real source checkout, not a name-derived path.
    return this.worktreeManager.forkWorkspace(params, {
      sourceWorkspacePath: this.getWorkspacePath(params.projectPath, params.sourceWorkspaceName),
    });
  }
}

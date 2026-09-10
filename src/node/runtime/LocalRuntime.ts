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
import { getErrorMessage } from "@/common/utils/errors";
import { LocalBaseRuntime } from "./LocalBaseRuntime";

/**
 * Local runtime implementation that uses the project directory directly.
 *
 * Unlike WorktreeRuntime, this runtime:
 * - Does NOT create git worktrees or isolate workspaces
 * - Uses the project directory as the workspace path
 * - Cannot delete the project directory (deleteWorkspace is a no-op)
 * - Supports forking (creates new workspace entries pointing to same project directory)
 *
 * This is useful for users who want to work directly in their project
 * without the overhead of worktree management.
 */
export class LocalRuntime extends LocalBaseRuntime {
  private readonly projectPath: string;

  constructor(projectPath: string) {
    super();
    this.projectPath = projectPath;
  }

  /**
   * For LocalRuntime, the workspace path is always the project path itself.
   * The workspaceName parameter is ignored since there's only one workspace per project.
   */
  getWorkspacePath(_projectPath: string, _workspaceName: string): string {
    return this.projectPath;
  }

  override ensureReady(options?: EnsureReadyOptions): Promise<EnsureReadyResult> {
    const statusSink = options?.statusSink;
    statusSink?.({
      phase: "checking",
      runtimeType: "local",
      detail: "Checking repository...",
    });

    // Non-git projects are explicitly supported for LocalRuntime; avoid blocking readiness
    // on missing .git so local-only workflows continue to work.
    statusSink?.({ phase: "ready", runtimeType: "local" });
    return Promise.resolve({ ready: true });
  }

  /**
   * Creating a workspace is a no-op for LocalRuntime since we use the project directory directly.
   * We just verify the directory exists.
   */
  async createWorkspace(params: WorkspaceCreationParams): Promise<WorkspaceCreationResult> {
    const { initLogger } = params;

    try {
      initLogger.logStep("Using project directory directly (no worktree isolation)");

      // Verify the project directory exists
      try {
        await this.stat(this.projectPath);
      } catch {
        return {
          success: false,
          error: `Project directory does not exist: ${this.projectPath}`,
        };
      }

      initLogger.logStep("Project directory verified");

      return { success: true, workspacePath: this.projectPath };
    } catch (error) {
      return {
        success: false,
        error: getErrorMessage(error),
      };
    }
  }

  async initWorkspace(params: WorkspaceInitParams): Promise<WorkspaceInitResult> {
    return this.initLocalWorkspace(params, "local");
  }

  /**
   * Renaming is a no-op for LocalRuntime - the workspace path is always the project directory.
   * Returns success so the metadata (workspace name) can be updated in config.
   */
  // eslint-disable-next-line @typescript-eslint/require-await
  async renameWorkspace(
    _projectPath: string,
    _oldName: string,
    _newName: string,
    _abortSignal?: AbortSignal
  ): Promise<
    { success: true; oldPath: string; newPath: string } | { success: false; error: string }
  > {
    // No filesystem operation needed - path stays the same
    return { success: true, oldPath: this.projectPath, newPath: this.projectPath };
  }

  /**
   * Deleting is a no-op for LocalRuntime - we never delete the user's project directory.
   * Returns success so the workspace entry can be removed from config.
   */
  // eslint-disable-next-line @typescript-eslint/require-await
  async deleteWorkspace(
    _projectPath: string,
    _workspaceName: string,
    _force: boolean,
    _abortSignal?: AbortSignal
  ): Promise<{ success: true; deletedPath: string } | { success: false; error: string }> {
    // Return success but don't actually delete anything
    // The project directory should never be deleted
    return { success: true, deletedPath: this.projectPath };
  }

  /**
   * Fork for LocalRuntime creates a new workspace entry pointing to the same project directory.
   * Since LocalRuntime doesn't create separate directories, "forking" just means:
   * 1. A new workspace ID with the new name
   * 2. Copied chat history (handled by workspaceService)
   * 3. Same project directory as source
   *
   * This enables conversation branching without git worktree overhead.
   */
  async forkWorkspace(params: WorkspaceForkParams): Promise<WorkspaceForkResult> {
    const { initLogger } = params;

    initLogger.logStep("Creating conversation fork (no worktree isolation)");

    // Verify the project directory exists (same check as createWorkspace)
    try {
      await this.stat(this.projectPath);
    } catch {
      return {
        success: false,
        error: `Project directory does not exist: ${this.projectPath}`,
      };
    }

    initLogger.logStep("Project directory verified");

    // Return success - the workspace service will copy chat history
    // and create a new workspace entry pointing to this project directory
    return {
      success: true,
      workspacePath: this.projectPath,
      // sourceBranch is optional for LocalRuntime since no git operations are involved
    };
  }
}

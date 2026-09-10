import assert from "node:assert";
import type { RuntimeConfig } from "@/common/types/runtime";
import type { Result } from "@/common/types/result";
import { getErrorMessage } from "@/common/utils/errors";
import type { ContainerManager, ProjectWorkspaceEntry } from "@/node/multiProject/containerManager";
import type {
  EnsureReadyOptions,
  EnsureReadyResult,
  ExecOptions,
  ExecStream,
  FileStat,
  Runtime,
  RuntimeCreateFlags,
  WorkspaceCreationParams,
  WorkspaceCreationResult,
  WorkspaceForkParams,
  WorkspaceForkResult,
  WorkspaceInitParams,
  WorkspaceInitResult,
} from "./Runtime";

export interface MultiProjectRuntimeEntry {
  projectPath: string;
  projectName: string;
  runtime: Runtime;
}

export class MultiProjectRuntime implements Runtime {
  readonly createFlags?: RuntimeCreateFlags;
  readonly finalizeConfig?: (
    finalBranchName: string,
    config: RuntimeConfig
  ) => Promise<Result<RuntimeConfig, string>>;
  readonly validateBeforePersist?: (
    finalBranchName: string,
    config: RuntimeConfig
  ) => Promise<Result<void, string>>;
  readonly postCreateSetup?: (params: WorkspaceInitParams) => Promise<void>;

  public envResolver?: (projectPath: string) => Promise<Record<string, string> | undefined>;

  private readonly primaryRuntime: Runtime;
  private readonly containerPath: string;

  constructor(
    private readonly containerManager: ContainerManager,
    private readonly projectRuntimes: MultiProjectRuntimeEntry[],
    workspaceName: string
  ) {
    assert(projectRuntimes.length > 0, "MultiProjectRuntime requires at least one project runtime");

    this.primaryRuntime = projectRuntimes[0].runtime;
    this.containerPath = containerManager.getContainerPath(workspaceName);
    this.createFlags = this.primaryRuntime.createFlags;

    this.finalizeConfig = this.primaryRuntime.finalizeConfig?.bind(this.primaryRuntime);
    this.validateBeforePersist = this.primaryRuntime.validateBeforePersist?.bind(
      this.primaryRuntime
    );
    this.postCreateSetup = this.primaryRuntime.postCreateSetup?.bind(this.primaryRuntime);
  }

  async ensureReady(options?: EnsureReadyOptions): Promise<EnsureReadyResult> {
    for (const projectRuntime of this.projectRuntimes) {
      const readyResult = await projectRuntime.runtime.ensureReady(options);
      if (!readyResult.ready) {
        return readyResult;
      }
    }

    return { ready: true };
  }

  async createWorkspace(params: WorkspaceCreationParams): Promise<WorkspaceCreationResult> {
    const workspaceName = params.directoryName;
    const createdRuntimes: MultiProjectRuntimeEntry[] = [];
    const projectWorkspaces: ProjectWorkspaceEntry[] = [];

    for (const projectRuntime of this.projectRuntimes) {
      const createResult = await projectRuntime.runtime.createWorkspace({
        ...params,
        projectPath: projectRuntime.projectPath,
      });

      if (!createResult.success) {
        const rollbackErrors = await this.rollbackCreatedWorkspaces(
          createdRuntimes,
          workspaceName,
          params.abortSignal,
          params.trusted
        );

        return {
          success: false,
          error: this.withRollbackErrors(
            `Failed to create workspace for project ${projectRuntime.projectName}: ${
              createResult.error ?? "Unknown error"
            }`,
            rollbackErrors
          ),
        };
      }

      const createdWorkspacePath = createResult.workspacePath;
      if (!createdWorkspacePath) {
        const rollbackErrors = await this.rollbackCreatedWorkspaces(
          [...createdRuntimes, projectRuntime],
          workspaceName,
          params.abortSignal,
          params.trusted
        );

        return {
          success: false,
          error: this.withRollbackErrors(
            `Failed to create workspace for project ${projectRuntime.projectName}: runtime returned success without workspacePath`,
            rollbackErrors
          ),
        };
      }

      createdRuntimes.push(projectRuntime);
      projectWorkspaces.push({
        projectName: projectRuntime.projectName,
        workspacePath: createdWorkspacePath,
      });
    }

    try {
      await this.containerManager.createContainer(workspaceName, projectWorkspaces);
    } catch (error) {
      const rollbackErrors = await this.rollbackCreatedWorkspaces(
        createdRuntimes,
        workspaceName,
        params.abortSignal,
        params.trusted
      );

      return {
        success: false,
        error: this.withRollbackErrors(
          `Failed to create multi-project container: ${getErrorMessage(error)}`,
          rollbackErrors
        ),
      };
    }

    return {
      success: true,
      workspacePath: this.containerManager.getContainerPath(workspaceName),
    };
  }

  async initWorkspace(params: WorkspaceInitParams): Promise<WorkspaceInitResult> {
    const projectInitLogger = {
      ...params.initLogger,
      // Individual runtimes report completion; suppress per-project completion so the
      // multi-project workspace transitions out of initializing only after all runtimes finish.
      logComplete: (_exitCode: number) => undefined,
    };

    const initResults: WorkspaceInitResult[] = [];

    for (const projectRuntime of this.projectRuntimes) {
      const projectWorkspacePath = projectRuntime.runtime.getWorkspacePath(
        projectRuntime.projectPath,
        params.branchName
      );
      const projectEnv = (await this.envResolver?.(projectRuntime.projectPath)) ?? params.env;

      const initResult = await projectRuntime.runtime.initWorkspace({
        ...params,
        projectPath: projectRuntime.projectPath,
        workspacePath: projectWorkspacePath,
        initLogger: projectInitLogger,
        env: projectEnv,
      });

      initResults.push(initResult);
    }

    const firstFailure = initResults.find((result) => !result.success);
    if (firstFailure) {
      params.initLogger.logComplete(-1);
      return firstFailure;
    }

    params.initLogger.logComplete(0);
    return { success: true };
  }

  async deleteWorkspace(
    _projectPath: string,
    workspaceName: string,
    force: boolean,
    abortSignal?: AbortSignal,
    trusted?: boolean
  ): Promise<{ success: true; deletedPath: string } | { success: false; error: string }> {
    const errors: string[] = [];

    for (const projectRuntime of this.projectRuntimes) {
      try {
        const deleteResult = await projectRuntime.runtime.deleteWorkspace(
          projectRuntime.projectPath,
          workspaceName,
          force,
          abortSignal,
          trusted
        );

        if (!deleteResult.success) {
          errors.push(
            `[${projectRuntime.projectName}] ${deleteResult.error ?? "Unknown delete error"}`
          );
        }
      } catch (error) {
        errors.push(`[${projectRuntime.projectName}] ${getErrorMessage(error)}`);
      }
    }

    try {
      await this.containerManager.removeContainer(workspaceName);
    } catch (error) {
      errors.push(`[container] ${getErrorMessage(error)}`);
    }

    if (errors.length > 0) {
      return {
        success: false,
        error: `Failed to delete multi-project workspace: ${errors.join("; ")}`,
      };
    }

    return {
      success: true,
      deletedPath: this.containerManager.getContainerPath(workspaceName),
    };
  }

  async forkWorkspace(params: WorkspaceForkParams): Promise<WorkspaceForkResult> {
    const forkedRuntimes: MultiProjectRuntimeEntry[] = [];
    const projectWorkspaces: ProjectWorkspaceEntry[] = [];
    let primaryForkResult: WorkspaceForkResult | undefined;

    for (const [runtimeIndex, projectRuntime] of this.projectRuntimes.entries()) {
      const forkResult = await projectRuntime.runtime.forkWorkspace({
        ...params,
        projectPath: projectRuntime.projectPath,
      });

      if (runtimeIndex === 0) {
        primaryForkResult = forkResult;
      }

      if (!forkResult.success) {
        const rollbackErrors = await this.rollbackCreatedWorkspaces(
          forkedRuntimes,
          params.newWorkspaceName,
          params.abortSignal,
          params.trusted
        );

        return {
          success: false,
          error: this.withRollbackErrors(
            `Failed to fork project ${projectRuntime.projectName}: ${forkResult.error ?? "Unknown error"}`,
            rollbackErrors
          ),
          ...(forkResult.failureIsFatal !== undefined
            ? { failureIsFatal: forkResult.failureIsFatal }
            : {}),
          ...(forkResult.forkedRuntimeConfig
            ? { forkedRuntimeConfig: forkResult.forkedRuntimeConfig }
            : {}),
          ...(forkResult.sourceRuntimeConfig
            ? { sourceRuntimeConfig: forkResult.sourceRuntimeConfig }
            : {}),
        };
      }

      const forkedWorkspacePath = forkResult.workspacePath;
      if (!forkedWorkspacePath) {
        const rollbackErrors = await this.rollbackCreatedWorkspaces(
          [...forkedRuntimes, projectRuntime],
          params.newWorkspaceName,
          params.abortSignal,
          params.trusted
        );

        return {
          success: false,
          error: this.withRollbackErrors(
            `Failed to fork project ${projectRuntime.projectName}: runtime returned success without workspacePath`,
            rollbackErrors
          ),
        };
      }

      forkedRuntimes.push(projectRuntime);
      projectWorkspaces.push({
        projectName: projectRuntime.projectName,
        workspacePath: forkedWorkspacePath,
      });
    }

    assert(primaryForkResult, "Primary runtime fork result is required");
    assert(primaryForkResult.success, "Primary runtime fork should succeed when all forks succeed");

    try {
      await this.containerManager.createContainer(params.newWorkspaceName, projectWorkspaces);
    } catch (error) {
      const rollbackErrors = await this.rollbackCreatedWorkspaces(
        forkedRuntimes,
        params.newWorkspaceName,
        params.abortSignal,
        params.trusted
      );

      return {
        success: false,
        error: this.withRollbackErrors(
          `Failed to create child workspace container: ${getErrorMessage(error)}`,
          rollbackErrors
        ),
      };
    }

    return {
      success: true,
      workspacePath: this.containerManager.getContainerPath(params.newWorkspaceName),
      sourceBranch: primaryForkResult.sourceBranch,
      ...(primaryForkResult.forkedRuntimeConfig
        ? { forkedRuntimeConfig: primaryForkResult.forkedRuntimeConfig }
        : {}),
      ...(primaryForkResult.sourceRuntimeConfig
        ? { sourceRuntimeConfig: primaryForkResult.sourceRuntimeConfig }
        : {}),
    };
  }

  async renameWorkspace(
    _projectPath: string,
    oldName: string,
    newName: string,
    abortSignal?: AbortSignal,
    trusted?: boolean
  ): Promise<
    { success: true; oldPath: string; newPath: string } | { success: false; error: string }
  > {
    const renamedProjectWorkspaces: ProjectWorkspaceEntry[] = [];

    for (const projectRuntime of this.projectRuntimes) {
      const renameResult = await projectRuntime.runtime.renameWorkspace(
        projectRuntime.projectPath,
        oldName,
        newName,
        abortSignal,
        trusted
      );

      if (!renameResult.success) {
        return {
          success: false,
          error: `Failed to rename workspace for project ${projectRuntime.projectName}: ${renameResult.error}`,
        };
      }

      renamedProjectWorkspaces.push({
        projectName: projectRuntime.projectName,
        workspacePath: renameResult.newPath,
      });
    }

    try {
      await this.containerManager.removeContainer(oldName);
      await this.containerManager.createContainer(newName, renamedProjectWorkspaces);
    } catch (error) {
      return {
        success: false,
        error: `Failed to update multi-project container for rename: ${getErrorMessage(error)}`,
      };
    }

    return {
      success: true,
      oldPath: this.containerManager.getContainerPath(oldName),
      newPath: this.containerManager.getContainerPath(newName),
    };
  }

  getWorkspacePath(_projectPath: string, _workspaceName: string): string {
    return this.containerPath;
  }

  resolvePath(targetPath: string): Promise<string> {
    return this.primaryRuntime.resolvePath(targetPath);
  }

  normalizePath(targetPath: string, basePath: string): string {
    return this.primaryRuntime.normalizePath(targetPath, basePath);
  }

  exec(command: string, options: ExecOptions): Promise<ExecStream> {
    return this.primaryRuntime.exec(command, {
      ...options,
      cwd: options.cwd || this.containerPath,
    });
  }

  readFile(filePath: string, abortSignal?: AbortSignal): ReadableStream<Uint8Array> {
    return this.primaryRuntime.readFile(filePath, abortSignal);
  }

  writeFile(filePath: string, abortSignal?: AbortSignal): WritableStream<Uint8Array> {
    return this.primaryRuntime.writeFile(filePath, abortSignal);
  }

  stat(filePath: string, abortSignal?: AbortSignal): Promise<FileStat> {
    return this.primaryRuntime.stat(filePath, abortSignal);
  }

  ensureDir(dirPath: string, abortSignal?: AbortSignal): Promise<void> {
    return this.primaryRuntime.ensureDir(dirPath, abortSignal);
  }

  tempDir(): Promise<string> {
    return this.primaryRuntime.tempDir();
  }

  getXumHome(): string {
    return this.primaryRuntime.getXumHome();
  }

  private async rollbackCreatedWorkspaces(
    createdRuntimes: MultiProjectRuntimeEntry[],
    workspaceName: string,
    abortSignal?: AbortSignal,
    trusted?: boolean
  ): Promise<string[]> {
    const rollbackErrors: string[] = [];

    for (const projectRuntime of [...createdRuntimes].reverse()) {
      try {
        const deleteResult = await projectRuntime.runtime.deleteWorkspace(
          projectRuntime.projectPath,
          workspaceName,
          true,
          abortSignal,
          trusted
        );

        if (!deleteResult.success) {
          rollbackErrors.push(
            `[${projectRuntime.projectName}] ${deleteResult.error ?? "Unknown rollback error"}`
          );
        }
      } catch (error) {
        rollbackErrors.push(`[${projectRuntime.projectName}] ${getErrorMessage(error)}`);
      }
    }

    try {
      await this.containerManager.removeContainer(workspaceName);
    } catch (error) {
      rollbackErrors.push(`[container] ${getErrorMessage(error)}`);
    }

    return rollbackErrors;
  }

  private withRollbackErrors(errorMessage: string, rollbackErrors: string[]): string {
    if (rollbackErrors.length === 0) {
      return errorMessage;
    }

    return `${errorMessage} Rollback errors: ${rollbackErrors.join("; ")}`;
  }
}

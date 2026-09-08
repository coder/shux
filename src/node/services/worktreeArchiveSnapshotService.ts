import assert from "node:assert/strict";
import type { Dirent } from "node:fs";
import * as fsPromises from "node:fs/promises";
import * as path from "node:path";

import { STAGED_ATTACHMENT_DIRS } from "@/common/constants/stagedAttachments";
import { Err, Ok, type Result } from "@/common/types/result";
import type { ArchiveLossyUntrackedFilesConfirmation } from "@/common/orpc/schemas/api";
import type { WorkspaceMetadata } from "@/common/types/workspace";
import { getSrcBaseDir, isWorktreeRuntime } from "@/common/types/runtime";
import { getErrorMessage } from "@/common/utils/errors";
import type {
  WorktreeArchiveSnapshot,
  WorktreeArchiveSnapshotProject,
} from "@/common/schemas/project";
import type { Config } from "@/node/config";
import { detectDefaultTrunkBranch } from "@/node/git";
import { ContainerManager } from "@/node/multiProject/containerManager";
import { isGitRepository } from "@/node/utils/pathUtils";
import { createRuntime } from "@/node/runtime/runtimeFactory";
import type { InitLogger, Runtime } from "@/node/runtime/Runtime";
import { appendSubProjectRelativePath } from "@/node/runtime/runtimeHelpers";
import { coerceNonEmptyString, findWorkspaceEntry } from "@/node/services/taskUtils";
import {
  getWorkspaceProjectRepos,
  type WorkspaceProjectRepo,
} from "@/node/services/workspaceProjectRepos";
import { log } from "@/node/services/log";
import { ensureGitInfoExclude } from "@/node/utils/git/ensureGitInfoExclude";
import { execFileAsync } from "@/node/utils/disposableExec";
import { isErrnoWithCode } from "@/node/utils/fs";
import { GIT_NO_HOOKS_ENV } from "@/node/utils/gitNoHooksEnv";
import { isPathInsideDir } from "@/node/utils/pathUtils";

const SNAPSHOT_VERSION = 1;
const SNAPSHOT_DIR_NAME = "archive-state";
// Kept outside SNAPSHOT_DIR_NAME on purpose: an older build restoring a newer snapshot ignores
// stagedAttachmentDirs and deletes archive-state, so a sibling directory keeps the only copy of
// the uploads recoverable across a downgrade instead of destroying it. Entries are replaced and
// removed individually, so such orphans survive later captures and restores too.
const ATTACHMENTS_DIR_NAME = "archive-attachments";
const SNAPSHOT_METADATA_FILE_NAME = "metadata.json";
const NOOP_INIT_LOGGER: InitLogger = {
  logStep: () => undefined,
  logStdout: () => undefined,
  logStderr: () => undefined,
  logComplete: () => undefined,
  enterHookPhase: () => undefined,
};

type CaptureSnapshotForArchiveError = string | ArchiveLossyUntrackedFilesConfirmation;

// Container directory name to the staged attachment directory inside it (".xum" -> "user-attachments").
const STAGED_ATTACHMENT_CONTAINERS = new Map(
  STAGED_ATTACHMENT_DIRS.map((dir) => {
    const [container, ...rest] = dir.split("/");
    return [container, rest.join("/")] as const;
  })
);

/**
 * For a `git ls-files --directory` entry (trailing slash) named like a staged-attachment container,
 * the name of the staged attachment directory it may hold.
 */
function stagedAttachmentChildInContainer(untrackedPath: string): string | null {
  const segments = untrackedPath.replace(/\\/gu, "/").split("/");
  if (segments.at(-1) !== "") {
    return null;
  }
  return STAGED_ATTACHMENT_CONTAINERS.get(segments.at(-2) ?? "") ?? null;
}

interface CreatedRestoreWorkspace {
  projectPath: string;
  projectName: string;
  workspacePath: string;
}

function getPersistedWorkspaceName(workspace: { name?: string; path: string }): string | undefined {
  const explicitName = coerceNonEmptyString(workspace.name);
  if (explicitName) {
    return explicitName;
  }

  const pathBasename = path.basename(workspace.path.trim());
  return pathBasename.length > 0 ? pathBasename : undefined;
}

function findWorkspaceEntryByIdOrPath(
  config: Config,
  configSnapshot: ReturnType<Config["loadConfigOrDefault"]>,
  workspaceId: string
): ReturnType<typeof findWorkspaceEntry> {
  const directMatch = findWorkspaceEntry(configSnapshot, workspaceId);
  if (directMatch) {
    return directMatch;
  }

  const locatedWorkspace = config.findWorkspace(workspaceId);
  if (!locatedWorkspace) {
    return null;
  }

  const projectConfig = configSnapshot.projects.get(locatedWorkspace.projectPath);
  const workspace = projectConfig?.workspaces.find(
    (entry) => entry.path === locatedWorkspace.workspacePath
  );
  if (!workspace) {
    return null;
  }

  return {
    projectPath: locatedWorkspace.projectPath,
    workspace,
  };
}

export class WorktreeArchiveSnapshotService {
  constructor(private readonly config: Config) {}

  async preflightSnapshotForArchive(args: {
    workspaceId: string;
    workspaceMetadata: WorkspaceMetadata;
  }): Promise<Result<void>> {
    assert(
      args.workspaceId.trim().length > 0,
      "preflightSnapshotForArchive: workspaceId must be non-empty"
    );

    if (!isWorktreeRuntime(args.workspaceMetadata.runtimeConfig)) {
      return Err("Archive snapshots are only supported for worktree runtimes");
    }

    const configSnapshot = this.config.loadConfigOrDefault();
    const workspaceEntry = findWorkspaceEntryByIdOrPath(
      this.config,
      configSnapshot,
      args.workspaceId
    );
    if (!workspaceEntry) {
      return Err("Workspace not found in config");
    }

    const workspaceName = getPersistedWorkspaceName(workspaceEntry.workspace);
    if (!workspaceName) {
      return Err("Workspace is missing its persisted branch name");
    }

    const projectRepos = getWorkspaceProjectRepos({
      workspaceId: args.workspaceId,
      workspaceName,
      workspacePath: workspaceEntry.workspace.path,
      runtimeConfig: args.workspaceMetadata.runtimeConfig,
      projectPath: args.workspaceMetadata.projectPath,
      projectName: args.workspaceMetadata.projectName,
      projects: workspaceEntry.workspace.projects,
    });
    assert(
      projectRepos.length > 0,
      "preflightSnapshotForArchive: expected at least one project repo"
    );

    try {
      for (const projectRepo of projectRepos) {
        await this.ensureNoUnsupportedUntrackedFiles(projectRepo.repoCwd);
        await this.ensureNoDirtySubmodules(projectRepo.repoCwd);
      }
      return Ok(undefined);
    } catch (error) {
      return Err(`Failed to capture archive snapshot: ${getErrorMessage(error)}`);
    }
  }

  /**
   * Collect all unsupported untracked file paths across every project repo in the workspace.
   * Returns a flat sorted array of relative paths (each prefixed with the project name for
   * multi-project workspaces). Does not throw on untracked files — callers decide the policy.
   *
   * Other blockers (missing workspace, wrong runtime, dirty submodules) still produce `Err()`.
   */
  async getUnsupportedUntrackedPaths(args: {
    workspaceId: string;
    workspaceMetadata: WorkspaceMetadata;
  }): Promise<Result<string[]>> {
    assert(
      args.workspaceId.trim().length > 0,
      "getUnsupportedUntrackedPaths: workspaceId must be non-empty"
    );

    if (!isWorktreeRuntime(args.workspaceMetadata.runtimeConfig)) {
      return Err("Archive snapshots are only supported for worktree runtimes");
    }

    const configSnapshot = this.config.loadConfigOrDefault();
    const workspaceEntry = findWorkspaceEntryByIdOrPath(
      this.config,
      configSnapshot,
      args.workspaceId
    );
    if (!workspaceEntry) {
      return Err("Workspace not found in config");
    }

    const workspaceName = getPersistedWorkspaceName(workspaceEntry.workspace);
    if (!workspaceName) {
      return Err("Workspace is missing its persisted branch name");
    }

    const projectRepos = getWorkspaceProjectRepos({
      workspaceId: args.workspaceId,
      workspaceName,
      workspacePath: workspaceEntry.workspace.path,
      runtimeConfig: args.workspaceMetadata.runtimeConfig,
      projectPath: args.workspaceMetadata.projectPath,
      projectName: args.workspaceMetadata.projectName,
      projects: workspaceEntry.workspace.projects,
    });
    assert(
      projectRepos.length > 0,
      "getUnsupportedUntrackedPaths: expected at least one project repo"
    );

    try {
      // Dirty submodules are still a hard blocker — check them first.
      for (const projectRepo of projectRepos) {
        await this.ensureNoDirtySubmodules(projectRepo.repoCwd);
      }

      const allUntrackedPaths: string[] = [];
      for (const projectRepo of projectRepos) {
        const paths = await this.listUnsupportedUntrackedFiles(projectRepo.repoCwd);
        if (projectRepos.length > 1) {
          // Prefix with project name for disambiguation in multi-project workspaces.
          for (const p of paths) {
            allUntrackedPaths.push(`${projectRepo.projectName}/${p}`);
          }
        } else {
          allUntrackedPaths.push(...paths);
        }
      }

      return Ok(allUntrackedPaths.sort());
    } catch (error) {
      return Err(`Failed to check archive readiness: ${getErrorMessage(error)}`);
    }
  }

  async captureSnapshotForArchive(args: {
    workspaceId: string;
    workspaceMetadata: WorkspaceMetadata;
    /**
     * When provided, the capture re-verifies the current untracked-file set against these
     * acknowledged paths instead of throwing unconditionally. If the sets still match,
     * capture proceeds (lossy). If they diverge, capture fails safely.
     * When omitted, any untracked files cause the default strict failure.
     */
    acknowledgedUntrackedPaths?: string[];
  }): Promise<Result<WorktreeArchiveSnapshot, CaptureSnapshotForArchiveError>> {
    assert(
      args.workspaceId.trim().length > 0,
      "captureSnapshotForArchive: workspaceId must be non-empty"
    );

    if (!isWorktreeRuntime(args.workspaceMetadata.runtimeConfig)) {
      return Err("Archive snapshots are only supported for worktree runtimes");
    }

    const configSnapshot = this.config.loadConfigOrDefault();
    const workspaceEntry = findWorkspaceEntryByIdOrPath(
      this.config,
      configSnapshot,
      args.workspaceId
    );
    if (!workspaceEntry) {
      return Err("Workspace not found in config");
    }

    const workspaceName = getPersistedWorkspaceName(workspaceEntry.workspace);
    if (!workspaceName) {
      return Err("Workspace is missing its persisted branch name");
    }

    const sessionDir = path.join(this.config.sessionsDir, args.workspaceId);
    const stateDir = path.join(sessionDir, SNAPSHOT_DIR_NAME);
    const tempSuffix = `.tmp-${Date.now()}-${Math.random().toString(16).slice(2)}`;
    const tempStateDir = path.join(sessionDir, `${SNAPSHOT_DIR_NAME}${tempSuffix}`);
    const tempAttachmentsDir = path.join(sessionDir, `${ATTACHMENTS_DIR_NAME}${tempSuffix}`);

    await fsPromises.mkdir(sessionDir, { recursive: true });
    await fsPromises.rm(tempStateDir, { recursive: true, force: true });
    await fsPromises.mkdir(tempStateDir, { recursive: true });
    await fsPromises.rm(tempAttachmentsDir, { recursive: true, force: true });
    await fsPromises.mkdir(tempAttachmentsDir, { recursive: true });

    try {
      const projectRepos = getWorkspaceProjectRepos({
        workspaceId: args.workspaceId,
        workspaceName,
        workspacePath: workspaceEntry.workspace.path,
        runtimeConfig: args.workspaceMetadata.runtimeConfig,
        projectPath: args.workspaceMetadata.projectPath,
        projectName: args.workspaceMetadata.projectName,
        projects: workspaceEntry.workspace.projects,
      });
      assert(
        projectRepos.length > 0,
        "captureSnapshotForArchive: expected at least one project repo"
      );

      const taskBaseCommitShaByProjectPath = this.buildTaskBaseCommitShaByProjectPath({
        primaryProjectPath: args.workspaceMetadata.projectPath,
        taskBaseCommitSha: workspaceEntry.workspace.taskBaseCommitSha,
        taskBaseCommitShaByProjectPath: workspaceEntry.workspace.taskBaseCommitShaByProjectPath,
      });

      const projectSnapshots: WorktreeArchiveSnapshotProject[] = [];
      for (const projectRepo of projectRepos) {
        const currentUntracked = await this.listUnsupportedUntrackedFiles(projectRepo.repoCwd);
        if (args.acknowledgedUntrackedPaths != null) {
          // Re-verify untracked files at capture time to close the race window between
          // the preflight check and actual snapshot capture. Any files created after the
          // user reviewed the dialog are caught here.
          // Paths the user acknowledged but that no longer exist are harmless — only
          // new (unacknowledged) paths are dangerous.
          const acknowledgedSet = new Set(args.acknowledgedUntrackedPaths);
          const newPaths = currentUntracked.filter((p) => !acknowledgedSet.has(p));
          if (newPaths.length > 0) {
            return this.buildUntrackedConfirmationErr({
              workspaceId: args.workspaceId,
              workspaceMetadata: args.workspaceMetadata,
            });
          }
        } else if (currentUntracked.length > 0) {
          return this.buildUntrackedConfirmationErr({
            workspaceId: args.workspaceId,
            workspaceMetadata: args.workspaceMetadata,
          });
        }
        await this.ensureNoDirtySubmodules(projectRepo.repoCwd);

        const trunkBranch = await this.resolveTrunkBranch({
          taskTrunkBranch: workspaceEntry.workspace.taskTrunkBranch,
          projectPath: projectRepo.projectPath,
        });
        const branchName = await this.resolveSnapshotBranchName(projectRepo.repoCwd, workspaceName);
        const headSha = await this.gitStdout(projectRepo.repoCwd, ["rev-parse", "HEAD"]);
        const baseSha =
          taskBaseCommitShaByProjectPath[projectRepo.projectPath] ||
          (await this.gitStdout(projectRepo.repoCwd, ["merge-base", trunkBranch, "HEAD"]));

        const commitCount = Number(
          await this.gitStdout(projectRepo.repoCwd, [
            "rev-list",
            "--count",
            `${baseSha}..${headSha}`,
          ])
        );
        assert(
          Number.isFinite(commitCount) && commitCount >= 0,
          "captureSnapshotForArchive: invalid commit count"
        );

        let committedPatchPath: string | undefined;
        const committedPatch =
          commitCount > 0
            ? await this.runGitCommand(projectRepo.repoCwd, [
                "format-patch",
                "--stdout",
                "--binary",
                `${baseSha}..${headSha}`,
              ])
            : "";
        if (committedPatch.trim().length > 0) {
          committedPatchPath = await this.writeArtifact({
            sessionDir,
            stateDir: tempStateDir,
            fileName: `${projectRepo.storageKey}.series.mbox`,
            contents: committedPatch,
          });
        }

        const stagedPatch = await this.runGitCommand(projectRepo.repoCwd, [
          "diff",
          "--cached",
          "--binary",
        ]);
        const stagedPatchPath =
          stagedPatch.trim().length > 0
            ? await this.writeArtifact({
                sessionDir,
                stateDir: tempStateDir,
                fileName: `${projectRepo.storageKey}.staged.patch`,
                contents: stagedPatch,
              })
            : undefined;

        const unstagedPatch = await this.runGitCommand(projectRepo.repoCwd, ["diff", "--binary"]);
        const unstagedPatchPath =
          unstagedPatch.trim().length > 0
            ? await this.writeArtifact({
                sessionDir,
                stateDir: tempStateDir,
                fileName: `${projectRepo.storageKey}.unstaged.patch`,
                contents: unstagedPatch,
              })
            : undefined;

        const stagedAttachmentDirs = await this.captureStagedAttachments({
          workspaceMetadata: args.workspaceMetadata,
          workspaceName,
          projectRepo,
          sessionDir,
          tempAttachmentsDir,
        });

        projectSnapshots.push({
          projectPath: projectRepo.projectPath,
          projectName: projectRepo.projectName,
          storageKey: projectRepo.storageKey,
          branchName,
          trunkBranch,
          baseSha,
          headSha,
          committedPatchPath,
          stagedPatchPath,
          unstagedPatchPath,
          stagedAttachmentDirs,
        });
      }

      const snapshot: WorktreeArchiveSnapshot = {
        version: SNAPSHOT_VERSION,
        capturedAt: new Date().toISOString(),
        stateDirPath: SNAPSHOT_DIR_NAME,
        projects: projectSnapshots,
      };

      await fsPromises.writeFile(
        path.join(tempStateDir, SNAPSHOT_METADATA_FILE_NAME),
        JSON.stringify(snapshot, null, 2),
        "utf-8"
      );
      // Attachment entries land before the metadata rename (the commit point) so it never
      // references artifacts that are not in place yet.
      await this.commitStagedAttachmentArtifacts({
        sessionDir,
        tempAttachmentsDir,
        projects: projectSnapshots,
      });
      await fsPromises.rm(stateDir, { recursive: true, force: true });
      await fsPromises.rename(tempStateDir, stateDir);

      return Ok(snapshot);
    } catch (error) {
      return Err(`Failed to capture archive snapshot: ${getErrorMessage(error)}`);
    } finally {
      await fsPromises.rm(tempStateDir, { recursive: true, force: true });
      await fsPromises.rm(tempAttachmentsDir, { recursive: true, force: true });
    }
  }

  async restoreSnapshotAfterUnarchive(args: {
    workspaceId: string;
    workspaceMetadata: WorkspaceMetadata;
  }): Promise<Result<"restored" | "skipped">> {
    assert(
      args.workspaceId.trim().length > 0,
      "restoreSnapshotAfterUnarchive: workspaceId must be non-empty"
    );

    const configSnapshot = this.config.loadConfigOrDefault();
    const workspaceEntry = findWorkspaceEntryByIdOrPath(
      this.config,
      configSnapshot,
      args.workspaceId
    );
    if (!workspaceEntry) {
      return Err("Workspace not found in config");
    }

    const snapshot = workspaceEntry.workspace.worktreeArchiveSnapshot;
    if (!snapshot) {
      return Ok("skipped");
    }

    if (!isWorktreeRuntime(args.workspaceMetadata.runtimeConfig)) {
      return Err("Archive snapshot restore is only supported for worktree runtimes");
    }

    const persistedWorkspacePath = workspaceEntry.workspace.path;
    const workspaceName = getPersistedWorkspaceName(workspaceEntry.workspace);
    if (!workspaceName) {
      return Err("Workspace is missing its persisted branch name");
    }

    const createdWorkspaces: CreatedRestoreWorkspace[] = [];
    let containerCreated = false;
    let restoredCheckoutReadyForWriteback = false;

    try {
      if (await this.pathExists(persistedWorkspacePath)) {
        const existingProjectSnapshot =
          snapshot.projects.length === 1 ? snapshot.projects[0] : undefined;
        if (
          existingProjectSnapshot &&
          (await this.existingCheckoutMatchesSnapshot({
            workspaceId: args.workspaceId,
            workspaceName,
            workspacePath: persistedWorkspacePath,
            projectSnapshot: existingProjectSnapshot,
          }))
        ) {
          // The git checks above say nothing about ignored uploads, so put them back before the
          // snapshot (and with it their only other copy) is cleared.
          await this.restoreStagedAttachments({
            workspaceId: args.workspaceId,
            projectSnapshot: existingProjectSnapshot,
            workspacePath: persistedWorkspacePath,
            runtime: createRuntime(args.workspaceMetadata.runtimeConfig, {
              projectPath: existingProjectSnapshot.projectPath,
              workspaceName,
            }),
            tolerateMissingArtifacts: true,
          });
          await this.clearSnapshotState(args.workspaceId, snapshot);
          return Ok("skipped");
        }

        throw new Error(
          "Persisted workspace path already exists; snapshot restore will not discard saved recovery data until the checkout is reconciled manually."
        );
      }
      for (const projectSnapshot of snapshot.projects) {
        const restoreBranchName = await this.resolveRestoreBranchName({
          projectPath: projectSnapshot.projectPath,
          workspaceName,
          snapshotBranchName: projectSnapshot.branchName,
          snapshotHeadSha: projectSnapshot.headSha,
        });
        const branchRefSha = await this.tryGitStdout(projectSnapshot.projectPath, [
          "rev-parse",
          `refs/heads/${restoreBranchName}`,
        ]);
        if (branchRefSha && branchRefSha !== projectSnapshot.headSha) {
          throw new Error(
            `Refusing to restore ${projectSnapshot.projectName}: local branch ${restoreBranchName} no longer matches the archived snapshot.`
          );
        }

        const headShaAvailable = await this.gitCommitExists(
          projectSnapshot.projectPath,
          projectSnapshot.headSha
        );
        const startPoint = branchRefSha
          ? undefined
          : headShaAvailable
            ? projectSnapshot.headSha
            : projectSnapshot.baseSha;

        const trusted = configSnapshot.projects.get(projectSnapshot.projectPath)?.trusted === true;
        const runtime = createRuntime(args.workspaceMetadata.runtimeConfig, {
          projectPath: projectSnapshot.projectPath,
          workspaceName,
        });
        const restoreResult = await runtime.createWorkspace({
          projectPath: projectSnapshot.projectPath,
          branchName: restoreBranchName,
          trunkBranch: projectSnapshot.trunkBranch,
          directoryName: workspaceName,
          startPoint,
          skipRemoteSync: true,
          workspacePathOverride:
            snapshot.projects.length === 1 ? persistedWorkspacePath : undefined,
          initLogger: NOOP_INIT_LOGGER,
          trusted,
        });
        if (!restoreResult.success || !restoreResult.workspacePath) {
          throw new Error(
            `Failed to recreate ${projectSnapshot.projectName}: ${
              restoreResult.error ?? "runtime did not return a workspace path"
            }`
          );
        }

        createdWorkspaces.push({
          projectPath: projectSnapshot.projectPath,
          projectName: projectSnapshot.projectName,
          workspacePath: restoreResult.workspacePath,
        });

        if (!headShaAvailable) {
          const committedPatchPath = projectSnapshot.committedPatchPath
            ? this.resolveSessionRelativePath(
                path.join(this.config.sessionsDir, args.workspaceId),
                projectSnapshot.committedPatchPath
              )
            : undefined;
          const committedPatchAvailable =
            committedPatchPath !== undefined && (await this.pathExists(committedPatchPath));
          const committedHistoryWasCaptured = projectSnapshot.baseSha !== projectSnapshot.headSha;
          if (committedHistoryWasCaptured && !committedPatchAvailable) {
            throw new Error(
              `Failed to restore ${projectSnapshot.projectName}: archived committed history is unavailable.`
            );
          }
          if (committedPatchAvailable && committedPatchPath) {
            await this.runGitCommand(restoreResult.workspacePath, [
              "am",
              "--3way",
              committedPatchPath,
            ]);
          }
        }

        if (projectSnapshot.stagedPatchPath) {
          const stagedPatchPath = this.resolveSessionRelativePath(
            path.join(this.config.sessionsDir, args.workspaceId),
            projectSnapshot.stagedPatchPath
          );
          if (!(await this.pathExists(stagedPatchPath))) {
            throw new Error(
              `Failed to restore ${projectSnapshot.projectName}: staged patch artifact is unavailable.`
            );
          }
          await this.runGitCommand(restoreResult.workspacePath, [
            "apply",
            "--index",
            "--binary",
            stagedPatchPath,
          ]);
        }

        if (projectSnapshot.unstagedPatchPath) {
          const unstagedPatchPath = this.resolveSessionRelativePath(
            path.join(this.config.sessionsDir, args.workspaceId),
            projectSnapshot.unstagedPatchPath
          );
          if (!(await this.pathExists(unstagedPatchPath))) {
            throw new Error(
              `Failed to restore ${projectSnapshot.projectName}: unstaged patch artifact is unavailable.`
            );
          }
          await this.runGitCommand(restoreResult.workspacePath, [
            "apply",
            "--binary",
            unstagedPatchPath,
          ]);
        }

        await this.restoreStagedAttachments({
          workspaceId: args.workspaceId,
          projectSnapshot,
          workspacePath: restoreResult.workspacePath,
          runtime,
          tolerateMissingArtifacts: false,
        });
      }

      if (snapshot.projects.length > 1) {
        const srcBaseDir =
          getSrcBaseDir(args.workspaceMetadata.runtimeConfig) ?? this.config.srcDir;
        const containerManager = new ContainerManager(srcBaseDir);
        await containerManager.createContainer(
          workspaceName,
          createdWorkspaces.map((workspace) => ({
            projectName: workspace.projectName,
            workspacePath: workspace.workspacePath,
          }))
        );
        containerCreated = true;
      }

      restoredCheckoutReadyForWriteback = true;
      await this.clearSnapshotState(args.workspaceId, snapshot);
      return Ok("restored");
    } catch (error) {
      log.debug("Failed to restore worktree archive snapshot", {
        workspaceId: args.workspaceId,
        error: getErrorMessage(error),
      });
      if (!restoredCheckoutReadyForWriteback) {
        await this.cleanupFailedRestore({
          workspaceName,
          runtimeConfig: args.workspaceMetadata.runtimeConfig,
          createdWorkspaces,
          containerCreated,
        });
        return Err(`Failed to restore archive snapshot: ${getErrorMessage(error)}`);
      }

      log.debug("Keeping restored worktree despite snapshot cleanup/writeback failure", {
        workspaceId: args.workspaceId,
        error: getErrorMessage(error),
      });
      return Ok("restored");
    }
  }

  private buildTaskBaseCommitShaByProjectPath(args: {
    primaryProjectPath: string;
    taskBaseCommitSha?: string;
    taskBaseCommitShaByProjectPath?: Record<string, string>;
  }): Record<string, string> {
    const baseCommitShaByProjectPath: Record<string, string> = {};
    for (const [projectPath, value] of Object.entries(args.taskBaseCommitShaByProjectPath ?? {})) {
      const sha = value.trim();
      if (sha.length > 0) {
        baseCommitShaByProjectPath[projectPath] = sha;
      }
    }

    const primaryBaseSha = args.taskBaseCommitSha?.trim();
    if (primaryBaseSha) {
      baseCommitShaByProjectPath[args.primaryProjectPath] = primaryBaseSha;
    }

    return baseCommitShaByProjectPath;
  }

  private async resolveTrunkBranch(args: {
    taskTrunkBranch?: string;
    projectPath: string;
  }): Promise<string> {
    const configuredTrunkBranch = args.taskTrunkBranch?.trim();
    if (configuredTrunkBranch) {
      return configuredTrunkBranch;
    }

    return detectDefaultTrunkBranch(args.projectPath);
  }

  /**
   * Fetch the current untracked-file set for a workspace and return an
   * `Err` asking the user to re-confirm. Used by `captureSnapshotForArchive`
   * when untracked files are detected that the user hasn't acknowledged.
   */
  private async buildUntrackedConfirmationErr(args: {
    workspaceId: string;
    workspaceMetadata: WorkspaceMetadata;
  }): Promise<Result<never, CaptureSnapshotForArchiveError>> {
    const latestUntrackedResult = await this.getUnsupportedUntrackedPaths({
      workspaceId: args.workspaceId,
      workspaceMetadata: args.workspaceMetadata,
    });
    if (!latestUntrackedResult.success) {
      return Err(latestUntrackedResult.error);
    }
    assert(
      latestUntrackedResult.data.length > 0,
      "captureSnapshotForArchive: expected current untracked paths when confirmation is required"
    );
    return Err({
      kind: "confirm-lossy-untracked-files",
      paths: latestUntrackedResult.data,
    });
  }

  /**
   * List untracked files/directories in a repo that archive snapshots cannot preserve.
   * Returns a sorted, normalized array of relative paths.
   */
  private async listUnsupportedUntrackedFiles(repoCwd: string): Promise<string[]> {
    const listOthers = async (extraArgs: string[]) =>
      (
        await this.gitStdout(repoCwd, [
          "ls-files",
          "--others",
          "--exclude-standard",
          "--directory",
          ...extraArgs,
        ])
      )
        .split("\n")
        .map((line) => line.trim())
        .filter((line) => line.length > 0);
    const untrackedPaths = await listOthers([]);
    // `--directory` reports a directory whose only contents are ignored, which is exactly what
    // the staged-attachment container (`.xum/`, whose exclude targets the child directory) looks
    // like. Drop it only when it holds nothing but the uploads captureStagedAttachments
    // preserves; anything else in there (e.g. an ignored workspace MCP override or an empty
    // directory) is still lost with the worktree and keeps the warning, as does every other entry.
    const nonEmptyPaths = new Set(await listOthers(["--no-empty-directory"]));
    const lossyPaths: string[] = [];
    for (const untrackedPath of untrackedPaths) {
      if (
        !nonEmptyPaths.has(untrackedPath) &&
        (await this.holdsOnlyStagedAttachments(repoCwd, untrackedPath))
      ) {
        continue;
      }
      lossyPaths.push(untrackedPath);
    }
    return lossyPaths.sort();
  }

  /**
   * True when the container directory holds nothing but the staged attachment directory. Checked
   * on the filesystem rather than through git so ignored files and empty sibling directories,
   * which git omits, still keep the container in the lossy warning.
   */
  private async holdsOnlyStagedAttachments(
    repoCwd: string,
    containerPath: string
  ): Promise<boolean> {
    const stagedChild = stagedAttachmentChildInContainer(containerPath);
    if (stagedChild == null) {
      return false;
    }
    const entries = await fsPromises.readdir(path.join(repoCwd, containerPath));
    return entries.length === 1 && entries[0] === stagedChild;
  }

  private async ensureNoUnsupportedUntrackedFiles(repoCwd: string): Promise<void> {
    const untrackedPaths = await this.listUnsupportedUntrackedFiles(repoCwd);
    if (untrackedPaths.length > 0) {
      throw new Error(
        `Archive snapshot does not yet support untracked files: ${untrackedPaths.join(", ")}`
      );
    }
  }

  private async ensureNoDirtySubmodules(repoCwd: string): Promise<void> {
    const submoduleStatus = await this.tryGitStdout(repoCwd, [
      "submodule",
      "status",
      "--recursive",
    ]);
    if (!submoduleStatus) {
      return;
    }

    const submodulePaths = submoduleStatus
      .split("\n")
      .map((line) => line.trim())
      .filter((line) => line.length > 0)
      .map((line) => line.split(/\s+/)[1])
      .filter((submodulePath): submodulePath is string => typeof submodulePath === "string");

    for (const submodulePath of submodulePaths) {
      const absoluteSubmodulePath = path.join(repoCwd, submodulePath);
      const dirtyOutput = await this.tryGitStdout(absoluteSubmodulePath, [
        "status",
        "--porcelain",
        "--untracked-files=all",
      ]);
      if (dirtyOutput && dirtyOutput.trim().length > 0) {
        throw new Error(`Archive snapshot does not support dirty submodules yet: ${submodulePath}`);
      }
    }
  }

  private async resolveSnapshotBranchName(
    repoPath: string,
    fallbackWorkspaceName: string
  ): Promise<string> {
    assert(
      fallbackWorkspaceName.trim().length > 0,
      "resolveSnapshotBranchName: fallbackWorkspaceName must be non-empty"
    );

    const currentBranch = await this.tryGitStdout(repoPath, [
      "symbolic-ref",
      "--quiet",
      "--short",
      "HEAD",
    ]);
    const trimmedCurrentBranch = currentBranch?.trim();
    if (trimmedCurrentBranch) {
      return trimmedCurrentBranch;
    }

    return fallbackWorkspaceName;
  }

  private async resolveRestoreBranchName(args: {
    projectPath: string;
    workspaceName: string;
    snapshotBranchName: string;
    snapshotHeadSha: string;
  }): Promise<string> {
    if (args.snapshotBranchName !== args.workspaceName) {
      return args.snapshotBranchName;
    }

    const snapshotBranchSha = await this.tryGitStdout(args.projectPath, [
      "rev-parse",
      `refs/heads/${args.snapshotBranchName}`,
    ]);
    if (snapshotBranchSha === args.snapshotHeadSha) {
      return args.snapshotBranchName;
    }

    // Older snapshot captures stored the workspace name instead of the actual checked-out branch.
    // When a renamed workspace preserved its original branch, recover via the persisted mapping so
    // those already-archived workspaces remain restorable after upgrading.
    const mappedBranchName = await this.getPersistedWorkspaceBranchName(
      args.projectPath,
      args.workspaceName
    );
    if (!mappedBranchName || mappedBranchName === args.snapshotBranchName) {
      return args.snapshotBranchName;
    }

    const mappedBranchSha = await this.tryGitStdout(args.projectPath, [
      "rev-parse",
      `refs/heads/${mappedBranchName}`,
    ]);
    if (mappedBranchSha === args.snapshotHeadSha) {
      return mappedBranchName;
    }

    return args.snapshotBranchName;
  }

  private async getPersistedWorkspaceBranchName(
    projectPath: string,
    workspaceName: string
  ): Promise<string | null> {
    const branchName = (await this.readWorkspaceBranchMap(projectPath))[workspaceName]?.trim();
    return branchName || null;
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

  private async gitCommitExists(repoPath: string, sha: string): Promise<boolean> {
    return (await this.tryGitStdout(repoPath, ["cat-file", "-e", `${sha}^{commit}`])) !== undefined;
  }

  private async gitStdout(repoPath: string, args: string[]): Promise<string> {
    const trimmed = (await this.runGitCommand(repoPath, args)).trimEnd();
    return trimmed;
  }

  private async tryGitStdout(repoPath: string, args: string[]): Promise<string | undefined> {
    try {
      return await this.gitStdout(repoPath, args);
    } catch {
      return undefined;
    }
  }

  private async runGitCommand(repoPath: string, args: string[]): Promise<string> {
    const gitEnv =
      args[0] === "am"
        ? {
            ...GIT_NO_HOOKS_ENV,
            GIT_COMMITTER_NAME: "Xum Archive Restore",
            GIT_COMMITTER_EMAIL: "mux-archive-restore@local",
          }
        : GIT_NO_HOOKS_ENV;
    using proc = execFileAsync("git", ["-C", repoPath, ...args], { env: gitEnv });
    const { stdout } = await proc.result;
    return stdout;
  }

  private resolveSessionRelativePath(sessionDir: string, relativePath: string): string {
    assert(
      relativePath.trim().length > 0,
      "resolveSessionRelativePath: relativePath must be non-empty"
    );
    const absolutePath = path.resolve(sessionDir, relativePath);
    const isStrictChildPath =
      isPathInsideDir(sessionDir, absolutePath) && absolutePath !== sessionDir;
    assert(isStrictChildPath, `resolveSessionRelativePath: refusing to escape ${sessionDir}`);
    return absolutePath;
  }

  /**
   * Chat uploads are staged into git-excluded `.xum/user-attachments` (legacy `.mux/`) under the
   * workspace execution path, so the tracked-diff artifacts above never see them. Copy them into
   * the session dir so persisted chat/draft paths still resolve after the checkout is recreated.
   * Entries are written under tempAttachmentsDir and moved into place by
   * commitStagedAttachmentArtifacts once the whole capture succeeded.
   */
  private async captureStagedAttachments(args: {
    workspaceMetadata: WorkspaceMetadata;
    workspaceName: string;
    projectRepo: WorkspaceProjectRepo;
    sessionDir: string;
    tempAttachmentsDir: string;
  }): Promise<WorktreeArchiveSnapshotProject["stagedAttachmentDirs"]> {
    const runtime = createRuntime(args.workspaceMetadata.runtimeConfig, {
      projectPath: args.projectRepo.projectPath,
      workspaceName: args.workspaceName,
    });
    const stagingRoot = appendSubProjectRelativePath(
      args.workspaceMetadata,
      runtime,
      args.projectRepo.repoCwd
    );

    const captured: NonNullable<WorktreeArchiveSnapshotProject["stagedAttachmentDirs"]> = [];
    for (const relativeDir of STAGED_ATTACHMENT_DIRS) {
      const sourceDir = path.join(stagingRoot, relativeDir);
      if (!(await this.isExistingDirectory(sourceDir))) {
        continue;
      }
      // Copy from the resolved path: a symlinked staging directory must yield its contents, not
      // a link that dangles once the worktree is gone. A repo-controlled link that leaves the
      // checkout cannot be preserved either way (the link itself goes with the worktree), so
      // refuse to archive rather than report success for uploads that will not come back.
      const realSourceDir = await this.resolveContainedRealPath(
        args.projectRepo.repoCwd,
        sourceDir
      );
      if (realSourceDir == null) {
        throw new Error(
          `Staged attachments at ${relativeDir} resolve outside the ${args.projectRepo.projectName} checkout.`
        );
      }
      const repoRelativeDir = path.relative(args.projectRepo.repoCwd, sourceDir);

      const artifactRelativeDir = path.join(args.projectRepo.storageKey, repoRelativeDir);
      const tempArtifactDir = path.join(args.tempAttachmentsDir, artifactRelativeDir);
      assert(
        isPathInsideDir(args.sessionDir, tempArtifactDir),
        `captureStagedAttachments: artifact path escaped session dir (${tempArtifactDir})`
      );
      await fsPromises.cp(realSourceDir, tempArtifactDir, { recursive: true });
      captured.push({
        repoRelativeDir,
        artifactPath: path.join(ATTACHMENTS_DIR_NAME, artifactRelativeDir),
      });
    }
    return captured.length > 0 ? captured : undefined;
  }

  /**
   * Replaces exactly the entries this capture produced, so a stale copy at the same path (from a
   * failed capture or a downgrade cycle) cannot resurrect a deleted upload, while entries the
   * snapshot does not own are left alone.
   */
  private async commitStagedAttachmentArtifacts(args: {
    sessionDir: string;
    tempAttachmentsDir: string;
    projects: WorktreeArchiveSnapshotProject[];
  }): Promise<void> {
    for (const project of args.projects) {
      for (const entry of project.stagedAttachmentDirs ?? []) {
        const artifactDir = this.resolveSessionRelativePath(args.sessionDir, entry.artifactPath);
        const tempArtifactDir = path.join(
          args.tempAttachmentsDir,
          path.relative(ATTACHMENTS_DIR_NAME, entry.artifactPath)
        );
        await fsPromises.rm(artifactDir, { recursive: true, force: true });
        await fsPromises.mkdir(path.dirname(artifactDir), { recursive: true });
        await fsPromises.rename(tempArtifactDir, artifactDir);
      }
    }
  }

  private async restoreStagedAttachments(args: {
    workspaceId: string;
    projectSnapshot: WorktreeArchiveSnapshotProject;
    workspacePath: string;
    runtime: Runtime;
    /**
     * A fresh restore has no other copy, so a missing artifact fails it (like the patch
     * artifacts). Reconciling an existing checkout has nothing left to recover from a missing
     * artifact, so it skips the entry the same way missing tracked artifacts are treated there.
     */
    tolerateMissingArtifacts: boolean;
  }): Promise<void> {
    const sessionDir = path.join(this.config.sessionsDir, args.workspaceId);
    for (const entry of args.projectSnapshot.stagedAttachmentDirs ?? []) {
      const artifactDir = this.resolveSessionRelativePath(sessionDir, entry.artifactPath);
      if (!(await this.isExistingDirectory(artifactDir))) {
        if (args.tolerateMissingArtifacts) {
          continue;
        }
        throw new Error(
          `Failed to restore ${args.projectSnapshot.projectName}: staged attachments artifact is unavailable.`
        );
      }
      // repoRelativeDir comes from user-editable config and its ancestors from the repo, so the
      // copy target is checked through symlinks, not just lexically.
      const targetDir = await this.resolveContainedRealPath(
        args.workspacePath,
        path.join(args.workspacePath, entry.repoRelativeDir)
      );
      assert(
        targetDir != null,
        `restoreStagedAttachments: refusing to restore outside ${args.workspacePath}`
      );
      await fsPromises.cp(artifactDir, targetDir, { recursive: true });

      // The recreated worktree starts with an empty info/exclude, so re-exclude the directory or
      // the restored uploads would surface as untracked files.
      const excludeResult = await ensureGitInfoExclude({
        runtime: args.runtime,
        workspacePath: args.workspacePath,
        relativeDir: entry.repoRelativeDir,
      });
      if (excludeResult.status === "failed") {
        throw new Error(
          `Failed to restore ${args.projectSnapshot.projectName}: could not mark staged attachments as ignored: ${excludeResult.error}`
        );
      }
    }
  }

  /** Only genuine absence counts as "not a directory"; other stat failures must abort. */
  private async isExistingDirectory(targetPath: string): Promise<boolean> {
    try {
      return (await fsPromises.stat(targetPath)).isDirectory();
    } catch (error) {
      if (isErrnoWithCode(error, "ENOENT") || isErrnoWithCode(error, "ENOTDIR")) {
        return false;
      }
      throw error;
    }
  }

  /**
   * Symlink-aware containment: resolves targetPath through its deepest existing ancestor and
   * returns that real path, or null when it is not strictly inside rootDir, so a link anywhere
   * above the target cannot redirect reads or writes outside rootDir.
   */
  private async resolveContainedRealPath(
    rootDir: string,
    targetPath: string
  ): Promise<string | null> {
    const absoluteTarget = path.resolve(targetPath);
    let existing = absoluteTarget;
    while (!(await this.pathExists(existing))) {
      const parent = path.dirname(existing);
      if (parent === existing) {
        return null;
      }
      existing = parent;
    }
    const realTarget = path.join(
      await fsPromises.realpath(existing),
      path.relative(existing, absoluteTarget)
    );
    const realRoot = await fsPromises.realpath(rootDir);
    return realTarget !== realRoot && isPathInsideDir(realRoot, realTarget) ? realTarget : null;
  }

  /** Removes directories under root that hold nothing but empty directories, root included. */
  private async pruneEmptyDirs(root: string): Promise<boolean> {
    let entries: Dirent[];
    try {
      entries = await fsPromises.readdir(root, { withFileTypes: true });
    } catch (error) {
      if (isErrnoWithCode(error, "ENOENT")) {
        return true;
      }
      throw error;
    }
    let empty = true;
    for (const entry of entries) {
      if (!entry.isDirectory() || !(await this.pruneEmptyDirs(path.join(root, entry.name)))) {
        empty = false;
      }
    }
    if (empty) {
      await fsPromises.rmdir(root);
    }
    return empty;
  }

  private async writeArtifact(args: {
    sessionDir: string;
    stateDir: string;
    fileName: string;
    contents: string;
  }): Promise<string> {
    const artifactPath = path.join(args.stateDir, args.fileName);
    await fsPromises.writeFile(artifactPath, args.contents, "utf-8");

    assert(
      isPathInsideDir(args.sessionDir, artifactPath),
      `writeArtifact: artifact path escaped session dir (${artifactPath})`
    );

    const relativePath = path.join(SNAPSHOT_DIR_NAME, args.fileName);
    assert(!path.isAbsolute(relativePath), "writeArtifact: relativePath must stay relative");
    return relativePath;
  }

  private async clearSnapshotState(
    workspaceId: string,
    snapshot: WorktreeArchiveSnapshot
  ): Promise<void> {
    const sessionDir = path.join(this.config.sessionsDir, workspaceId);
    const stateDir = this.resolveSessionRelativePath(sessionDir, snapshot.stateDirPath);
    await fsPromises.rm(stateDir, { recursive: true, force: true });
    for (const project of snapshot.projects) {
      for (const entry of project.stagedAttachmentDirs ?? []) {
        await fsPromises.rm(this.resolveSessionRelativePath(sessionDir, entry.artifactPath), {
          recursive: true,
          force: true,
        });
      }
    }
    await this.pruneEmptyDirs(path.join(sessionDir, ATTACHMENTS_DIR_NAME));

    await this.config.editConfig((config) => {
      const workspaceEntry = findWorkspaceEntryByIdOrPath(this.config, config, workspaceId);
      if (workspaceEntry) {
        delete workspaceEntry.workspace.worktreeArchiveSnapshot;
      }
      return config;
    });
  }

  private async cleanupFailedRestore(args: {
    workspaceName: string;
    runtimeConfig: WorkspaceMetadata["runtimeConfig"];
    createdWorkspaces: CreatedRestoreWorkspace[];
    containerCreated: boolean;
  }): Promise<void> {
    if (args.containerCreated) {
      const srcBaseDir = getSrcBaseDir(args.runtimeConfig) ?? this.config.srcDir;
      await new ContainerManager(srcBaseDir)
        .removeContainer(args.workspaceName)
        .catch(() => undefined);
    }

    for (const createdWorkspace of [...args.createdWorkspaces].reverse()) {
      try {
        await this.removeRestoredWorktreePath(
          createdWorkspace.projectPath,
          createdWorkspace.workspacePath
        );
      } catch (error) {
        log.debug("Failed to clean up partially restored worktree snapshot", {
          projectPath: createdWorkspace.projectPath,
          workspacePath: createdWorkspace.workspacePath,
          error: getErrorMessage(error),
        });
      }
    }
  }

  private async existingCheckoutMatchesSnapshot(args: {
    workspaceId: string;
    workspaceName: string;
    workspacePath: string;
    projectSnapshot: WorktreeArchiveSnapshotProject;
  }): Promise<boolean> {
    const checkoutIsGitRepo = await isGitRepository(args.workspacePath);
    if (!checkoutIsGitRepo) {
      return false;
    }

    const expectedBranchName = await this.resolveRestoreBranchName({
      projectPath: args.projectSnapshot.projectPath,
      workspaceName: args.workspaceName,
      snapshotBranchName: args.projectSnapshot.branchName,
      snapshotHeadSha: args.projectSnapshot.headSha,
    });
    const checkoutBranch = await this.tryGitStdout(args.workspacePath, [
      "rev-parse",
      "--abbrev-ref",
      "HEAD",
    ]);
    if (checkoutBranch !== expectedBranchName) {
      return false;
    }

    const checkoutHeadSha = await this.tryGitStdout(args.workspacePath, ["rev-parse", "HEAD"]);
    if (checkoutHeadSha !== args.projectSnapshot.headSha) {
      return false;
    }

    const checkoutCommonDir = await this.tryGitStdout(args.workspacePath, [
      "rev-parse",
      "--path-format=absolute",
      "--git-common-dir",
    ]);
    const expectedCommonDir = path.resolve(args.projectSnapshot.projectPath, ".git");
    if (!checkoutCommonDir || path.resolve(checkoutCommonDir) !== expectedCommonDir) {
      return false;
    }

    const expectedStagedPatch = await this.readSnapshotPatchArtifact({
      workspaceId: args.workspaceId,
      artifactPath: args.projectSnapshot.stagedPatchPath,
    });
    const expectedUnstagedPatch = await this.readSnapshotPatchArtifact({
      workspaceId: args.workspaceId,
      artifactPath: args.projectSnapshot.unstagedPatchPath,
    });

    const stagedArtifactMissing =
      args.projectSnapshot.stagedPatchPath != null && expectedStagedPatch == null;
    const unstagedArtifactMissing =
      args.projectSnapshot.unstagedPatchPath != null && expectedUnstagedPatch == null;
    const hasTrackedArtifactReference =
      args.projectSnapshot.stagedPatchPath != null ||
      args.projectSnapshot.unstagedPatchPath != null;
    const allReferencedTrackedArtifactsMissing =
      hasTrackedArtifactReference &&
      (args.projectSnapshot.stagedPatchPath == null || stagedArtifactMissing) &&
      (args.projectSnapshot.unstagedPatchPath == null || unstagedArtifactMissing);
    if (allReferencedTrackedArtifactsMissing) {
      // A prior restore may have already deleted every tracked patch artifact before snapshot-state
      // writeback failed. Once the branch/head/common-dir checks pass, there is no remaining
      // recovery payload to preserve, so treat the checkout as reconciled and let retry clear
      // the stale snapshot metadata.
      return true;
    }

    const currentStagedPatch = await this.runGitCommand(args.workspacePath, [
      "diff",
      "--cached",
      "--binary",
    ]);
    const currentUnstagedPatch = await this.runGitCommand(args.workspacePath, ["diff", "--binary"]);

    const stagedMatches = stagedArtifactMissing
      ? true
      : currentStagedPatch === (expectedStagedPatch ?? "");
    const unstagedMatches = unstagedArtifactMissing
      ? true
      : currentUnstagedPatch === (expectedUnstagedPatch ?? "");
    return stagedMatches && unstagedMatches;
  }

  private async readSnapshotPatchArtifact(args: {
    workspaceId: string;
    artifactPath?: string;
  }): Promise<string | null> {
    if (!args.artifactPath) {
      return "";
    }

    try {
      return await fsPromises.readFile(
        this.resolveSessionRelativePath(
          path.join(this.config.sessionsDir, args.workspaceId),
          args.artifactPath
        ),
        "utf-8"
      );
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") {
        return null;
      }
      throw error;
    }
  }

  private async removeRestoredWorktreePath(
    projectPath: string,
    workspacePath: string
  ): Promise<void> {
    try {
      using removeProc = execFileAsync(
        "git",
        ["-C", projectPath, "worktree", "remove", "--force", workspacePath],
        { env: GIT_NO_HOOKS_ENV }
      );
      await removeProc.result;
      return;
    } catch {
      try {
        using pruneProc = execFileAsync("git", ["-C", projectPath, "worktree", "prune"], {
          env: GIT_NO_HOOKS_ENV,
        });
        await pruneProc.result;
      } catch {
        // Best-effort prune only; fall through to filesystem cleanup.
      }
    }

    await fsPromises.rm(workspacePath, { recursive: true, force: true });
  }

  private async pathExists(targetPath: string): Promise<boolean> {
    return fsPromises
      .access(targetPath)
      .then(() => true)
      .catch(() => false);
  }
}

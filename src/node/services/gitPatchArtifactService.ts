import * as path from "node:path";
import assert from "node:assert/strict";

import type { Config, ProjectsConfig } from "@/node/config";
import type {
  SubagentGitPatchArtifact,
  SubagentGitProjectPatchArtifact,
} from "@/common/utils/tools/toolDefinitions";
import { DEFAULT_RUNTIME_CONFIG } from "@/common/constants/workspace";
import type { ProjectRef } from "@/common/types/workspace";
import {
  coerceNonEmptyString,
  tryReadGitHeadCommitSha,
  findWorkspaceEntry,
} from "@/node/services/taskUtils";
import { log } from "@/node/services/log";
import { isActiveWorkspaceTurnTaskStatus } from "@/node/services/taskHandleStore";
import { readAgentDefinition } from "@/node/services/agentDefinitions/agentDefinitionsService";
import { resolveAgentInheritanceChain } from "@/node/services/agentDefinitions/resolveAgentInheritanceChain";
import { isExecLikeEditingCapableInResolvedChain } from "@/common/utils/agentTools";
import {
  createRuntimeContextForWorkspace,
  createRuntimeForWorkspace,
  type WorkspaceRuntimeContext,
} from "@/node/runtime/runtimeHelpers";
import { execBuffered } from "@/node/utils/runtime/helpers";
import { AgentIdSchema } from "@/common/orpc/schemas";
import { resolvePersistedAgentIdCandidates } from "@/common/utils/agentIds";
import {
  getSubagentGitPatchMboxPath,
  matchesProjectArtifactProjectPathForUpdate,
  readSubagentGitPatchArtifact,
  upsertSubagentGitPatchArtifact,
} from "@/node/services/subagentGitPatchArtifacts";
import { shellQuote } from "@/common/utils/shell";
import { getErrorMessage } from "@/common/utils/errors";
import { PlatformPaths } from "@/common/utils/paths";
import {
  getWorkspaceProjectRepos,
  getWorkspaceProjectStorageKeys,
} from "@/node/services/workspaceProjectRepos";
import { MutexMap } from "@/node/utils/concurrency/mutexMap";
import { taskGitPatchEngine } from "@/node/services/taskGitPatchEngine";

/** Callback invoked after patch generation completes (success or failure). */
export type OnPatchGenerationComplete = (childWorkspaceId: string) => Promise<void>;

function isPathInsideDir(dirPath: string, filePath: string): boolean {
  const resolvedDir = path.resolve(dirPath);
  const resolvedFile = path.resolve(filePath);
  const relativePath = path.relative(resolvedDir, resolvedFile);
  return (
    relativePath.length > 0 && !relativePath.startsWith("..") && !path.isAbsolute(relativePath)
  );
}

function getPrimaryProjectName(projectPath: string, projects?: ProjectRef[]): string {
  const matchingProjectName = projects
    ?.find((project) => project.projectPath.trim() === projectPath.trim())
    ?.projectName?.trim();
  return matchingProjectName && matchingProjectName.length > 0
    ? matchingProjectName
    : PlatformPaths.getProjectName(projectPath).trim();
}

function createAgentDiscoveryContext(
  entry: ReturnType<typeof findWorkspaceEntry>
): WorkspaceRuntimeContext | undefined {
  const workspace = entry?.workspace;
  const workspacePath = coerceNonEmptyString(workspace?.path);
  const workspaceName =
    coerceNonEmptyString(workspace?.name) ??
    (workspacePath == null ? undefined : PlatformPaths.getProjectName(workspacePath));
  if (entry == null || workspace == null || workspaceName == null) {
    return undefined;
  }

  const metadata = {
    runtimeConfig: workspace.runtimeConfig ?? DEFAULT_RUNTIME_CONFIG,
    projectPath: entry.projectPath,
    name: workspaceName,
    namedWorkspacePath: workspacePath,
  };

  try {
    return createRuntimeContextForWorkspace(metadata);
  } catch {
    // Older task records/tests can pair a project-dir local runtime with a child worktree path.
    // Fall back to the pre-existing persisted-path behavior rather than blocking patch cleanup.
    const runtime = createRuntimeForWorkspace(metadata);
    return {
      runtime,
      workspacePath: workspacePath ?? runtime.getWorkspacePath(entry.projectPath, workspaceName),
    };
  }
}

async function resolveAgentEditingCapability(args: {
  discoveryContexts: readonly WorkspaceRuntimeContext[];
  agentId: string;
  workspaceId: string;
}): Promise<{ editingCapable: boolean; projectScoped: boolean } | undefined> {
  const parsedAgentId = AgentIdSchema.safeParse(args.agentId);
  if (!parsedAgentId.success) {
    return undefined;
  }

  let fallbackChain: Awaited<ReturnType<typeof resolveAgentInheritanceChain>> | undefined;

  for (const discovery of args.discoveryContexts) {
    try {
      const agentDefinition = await readAgentDefinition(
        discovery.runtime,
        discovery.workspacePath,
        parsedAgentId.data
      );
      const chain = await resolveAgentInheritanceChain({
        runtime: discovery.runtime,
        workspacePath: discovery.workspacePath,
        agentId: agentDefinition.id,
        agentDefinition,
        workspaceId: args.workspaceId,
      });

      if (agentDefinition.scope === "project") {
        return {
          editingCapable: isExecLikeEditingCapableInResolvedChain(chain),
          projectScoped: true,
        };
      }
      fallbackChain ??= chain;
    } catch {
      // Try the next discovery context before falling back to global/built-in definitions.
    }
  }

  return fallbackChain == null
    ? undefined
    : {
        editingCapable: isExecLikeEditingCapableInResolvedChain(fallbackChain),
        projectScoped: false,
      };
}

function buildTaskBaseCommitShaByProjectPath(params: {
  projectPath: string;
  projects?: ProjectRef[];
  taskBaseCommitSha?: string;
  taskBaseCommitShaByProjectPath?: Record<string, string>;
}): Record<string, string> {
  const baseCommitShaByProjectPath = { ...(params.taskBaseCommitShaByProjectPath ?? {}) };
  if (params.taskBaseCommitSha?.trim()) {
    baseCommitShaByProjectPath[params.projectPath] = params.taskBaseCommitSha.trim();
  }

  if (Array.isArray(params.projects)) {
    for (const project of params.projects) {
      if (!project.projectPath.trim()) {
        continue;
      }
      if (!(project.projectPath in baseCommitShaByProjectPath)) {
        baseCommitShaByProjectPath[project.projectPath] = "";
      }
    }
  }

  return baseCommitShaByProjectPath;
}

function buildPendingProjectArtifacts(params: {
  projectPath: string;
  projects?: ProjectRef[];
  taskBaseCommitSha?: string;
  taskBaseCommitShaByProjectPath?: Record<string, string>;
}): SubagentGitProjectPatchArtifact[] {
  const baseCommitShaByProjectPath = buildTaskBaseCommitShaByProjectPath(params);
  const projectRefs =
    params.projects && params.projects.length > 0
      ? params.projects
      : [
          {
            projectPath: params.projectPath,
            projectName: getPrimaryProjectName(params.projectPath),
          },
        ];

  return getWorkspaceProjectStorageKeys({
    projectPath: params.projectPath,
    projectName: getPrimaryProjectName(params.projectPath),
    projects: projectRefs,
  }).map(
    (project) =>
      ({
        projectPath: project.projectPath,
        projectName: project.projectName,
        storageKey: project.storageKey,
        status: "pending",
        baseCommitSha: baseCommitShaByProjectPath[project.projectPath] || undefined,
      }) satisfies SubagentGitProjectPatchArtifact
  );
}

export function buildContinuationProjectArtifacts(params: {
  pendingProjectArtifacts: SubagentGitProjectPatchArtifact[];
  existingArtifact: SubagentGitPatchArtifact | null;
}): SubagentGitProjectPatchArtifact[] {
  return params.pendingProjectArtifacts.map((pendingProjectArtifact) => {
    const existingProjectArtifact = params.existingArtifact?.projectArtifacts.find((artifact) =>
      matchesProjectArtifactProjectPathForUpdate(artifact, pendingProjectArtifact.projectPath)
    );
    if (!existingProjectArtifact) {
      return pendingProjectArtifact;
    }

    // Persistent children keep one stable task ID across continuations. If the prior patch was
    // applied, hand back only commits made since that artifact's head; otherwise keep the original
    // base so the refreshed artifact remains cumulative and no unintegrated commits are lost.
    const baseCommitSha =
      existingProjectArtifact.appliedAtMs != null
        ? (existingProjectArtifact.headCommitSha ?? pendingProjectArtifact.baseCommitSha)
        : (existingProjectArtifact.baseCommitSha ?? pendingProjectArtifact.baseCommitSha);

    return {
      ...pendingProjectArtifact,
      baseCommitSha,
    };
  });
}

function buildPendingPatchArtifact(params: {
  childTaskId: string;
  parentWorkspaceId: string;
  createdAtMs: number;
  updatedAtMs: number;
  projectArtifacts: SubagentGitProjectPatchArtifact[];
}): SubagentGitPatchArtifact {
  return {
    childTaskId: params.childTaskId,
    parentWorkspaceId: params.parentWorkspaceId,
    createdAtMs: params.createdAtMs,
    updatedAtMs: params.updatedAtMs,
    status: "pending",
    projectArtifacts: params.projectArtifacts,
    readyProjectCount: 0,
    failedProjectCount: 0,
    skippedProjectCount: 0,
    totalCommitCount: 0,
  };
}

export function upsertProjectArtifact(params: {
  artifact: SubagentGitPatchArtifact;
  nextProjectArtifact: SubagentGitProjectPatchArtifact;
  updatedAtMs: number;
}): SubagentGitPatchArtifact {
  let didMatchExistingArtifact = false;
  const projectArtifacts = params.artifact.projectArtifacts.map((projectArtifact) => {
    if (
      !matchesProjectArtifactProjectPathForUpdate(
        projectArtifact,
        params.nextProjectArtifact.projectPath
      )
    ) {
      return projectArtifact;
    }

    didMatchExistingArtifact = true;
    return params.nextProjectArtifact;
  });

  return {
    ...params.artifact,
    updatedAtMs: params.updatedAtMs,
    projectArtifacts: didMatchExistingArtifact
      ? projectArtifacts
      : [...projectArtifacts, params.nextProjectArtifact],
  };
}

function failPendingProjectArtifacts(params: {
  artifact: SubagentGitPatchArtifact;
  error: string;
  updatedAtMs: number;
}): SubagentGitPatchArtifact {
  return {
    ...params.artifact,
    updatedAtMs: params.updatedAtMs,
    projectArtifacts: params.artifact.projectArtifacts.map((projectArtifact) =>
      projectArtifact.status === "pending"
        ? {
            ...projectArtifact,
            status: "failed",
            error: params.error,
          }
        : projectArtifact
    ),
  };
}

// ---------------------------------------------------------------------------
// GitPatchArtifactService
// ---------------------------------------------------------------------------

/**
 * Handles git-format-patch artifact generation for subagent tasks.
 *
 * Extracted from TaskService to keep patch-specific logic self-contained.
 */
export class GitPatchArtifactService {
  // Keep completion callbacks observable until they settle without making generation waiters depend
  // on cleanup callbacks that may need the same workspace event lock as a continuation refresh.
  private readonly completionCallbacksByTaskId = new Map<string, Promise<void>>();
  private readonly operationLocks = new MutexMap<string>();
  private readonly pendingJobsByTaskId = new Map<string, Promise<void>>();

  constructor(private readonly config: Config) {}

  withOperationLock<T>(childWorkspaceId: string, operation: () => Promise<T>): Promise<T> {
    assert(childWorkspaceId.length > 0, "withOperationLock: childWorkspaceId must be non-empty");
    return this.operationLocks.withLock(childWorkspaceId, operation);
  }

  async waitForGeneration(childWorkspaceId: string): Promise<void> {
    assert(childWorkspaceId.length > 0, "waitForGeneration: childWorkspaceId must be non-empty");
    await this.pendingJobsByTaskId.get(childWorkspaceId);
  }

  /**
   * If the child workspace is an exec-like agent, write a pending patch artifact
   * marker and kick off background `git format-patch` generation.
   *
   * @param onComplete - called after generation finishes (success *or* failure),
   *   typically used to trigger reported-leaf-task cleanup.
   * @param options.config - config snapshot to resolve the child/parent entries from; callers that
   *   iterate many tasks (startup recovery) pass one instead of reloading config.json per task.
   */
  async maybeStartGeneration(
    parentWorkspaceId: string,
    childWorkspaceId: string,
    onComplete: OnPatchGenerationComplete,
    options?: { refreshForContinuation?: boolean; config?: ProjectsConfig }
  ): Promise<void> {
    return await this.withOperationLock(childWorkspaceId, async () => {
      await this.maybeStartGenerationUnlocked(
        parentWorkspaceId,
        childWorkspaceId,
        onComplete,
        options
      );
    });
  }

  private async maybeStartGenerationUnlocked(
    parentWorkspaceId: string,
    childWorkspaceId: string,
    onComplete: OnPatchGenerationComplete,
    options?: { refreshForContinuation?: boolean; config?: ProjectsConfig }
  ): Promise<void> {
    assert(
      parentWorkspaceId.length > 0,
      "maybeStartGeneration: parentWorkspaceId must be non-empty"
    );
    assert(childWorkspaceId.length > 0, "maybeStartGeneration: childWorkspaceId must be non-empty");

    if (options?.refreshForContinuation === true) {
      // A continuation can finish while the initial report's format-patch job is still draining.
      // Wait for that generation before replacing its stable-task artifact. The tracked promise
      // excludes the cleanup callback, so this is safe from the child workspace event lock.
      await this.waitForGeneration(childWorkspaceId);
    }

    const parentSessionDir = path.join(this.config.sessionsDir, parentWorkspaceId);

    // Write a pending marker before we attempt cleanup, so the reported task workspace isn't deleted
    // while we're still reading commits from it.
    const nowMs = Date.now();
    const cfg = options?.config ?? this.config.loadConfigOrDefault();
    const childEntry = findWorkspaceEntry(cfg, childWorkspaceId);

    if (childEntry?.workspace.kind === "scratch") {
      return;
    }

    // Only exec-like subagents are expected to make commits that should be handed back to the parent.
    // NOTE: Custom agents can inherit from exec (base: exec). Those should also generate patches,
    // but read-only subagents (e.g. explore) should not.
    const childAgentIds = resolvePersistedAgentIdCandidates(childEntry?.workspace);
    if (childAgentIds.length === 0) {
      return;
    }

    const discoveryContexts = [
      createAgentDiscoveryContext(childEntry),
      createAgentDiscoveryContext(findWorkspaceEntry(cfg, parentWorkspaceId)),
    ].filter((context): context is WorkspaceRuntimeContext => context != null);

    let shouldGeneratePatch = false;
    for (const childAgentId of childAgentIds) {
      const editingCapability = await resolveAgentEditingCapability({
        discoveryContexts,
        agentId: childAgentId,
        workspaceId: childWorkspaceId,
      });
      if (editingCapability == null) {
        continue;
      }
      shouldGeneratePatch = editingCapability.editingCapable;
      break;
    }

    if (!shouldGeneratePatch || !childEntry) {
      return;
    }

    if (options?.config != null) {
      // The caller's snapshot can predate a client removing or reactivating this task. Only a
      // task with no artifact yet or a crash-left pending one would actually be generated below
      // (a completed artifact is left untouched), so re-read config for exactly those. A removed
      // task gets no artifact, and a reactivated one (live execution handle, so its checkout is
      // changing again) is left to the continuation refresh that runs when that execution settles.
      const existing = await readSubagentGitPatchArtifact(parentSessionDir, childWorkspaceId);
      if (existing == null || existing.status === "pending") {
        const live = findWorkspaceEntry(this.config.loadConfigOrDefault(), childWorkspaceId);
        if (live == null || isActiveWorkspaceTurnTaskStatus(live.workspace.taskExecutionStatus)) {
          return;
        }
      }
    }

    const pendingProjectArtifacts = buildPendingProjectArtifacts({
      projectPath: childEntry.projectPath,
      projects: childEntry.workspace.projects,
      taskBaseCommitSha: coerceNonEmptyString(childEntry.workspace.taskBaseCommitSha) ?? undefined,
      taskBaseCommitShaByProjectPath: childEntry.workspace.taskBaseCommitShaByProjectPath,
    });

    const artifact = await upsertSubagentGitPatchArtifact({
      workspaceId: parentWorkspaceId,
      workspaceSessionDir: parentSessionDir,
      childTaskId: childWorkspaceId,
      updater: (existing) => {
        if (options?.refreshForContinuation !== true) {
          if (existing && existing.status !== "pending") {
            return existing;
          }
          if (existing) {
            return existing;
          }
        }

        return buildPendingPatchArtifact({
          childTaskId: childWorkspaceId,
          parentWorkspaceId,
          createdAtMs: existing?.createdAtMs ?? nowMs,
          updatedAtMs: nowMs,
          projectArtifacts:
            options?.refreshForContinuation === true
              ? buildContinuationProjectArtifacts({
                  pendingProjectArtifacts,
                  existingArtifact: existing,
                })
              : pendingProjectArtifacts,
        });
      },
    });

    if (artifact.status !== "pending") {
      return;
    }

    if (this.pendingJobsByTaskId.has(childWorkspaceId)) {
      return;
    }

    let job: Promise<void>;
    try {
      job = this.generate(parentWorkspaceId, childWorkspaceId)
        .catch(async (error: unknown) => {
          log.error("Subagent git patch generation failed", {
            parentWorkspaceId,
            childWorkspaceId,
            error,
          });

          try {
            await upsertSubagentGitPatchArtifact({
              workspaceId: parentWorkspaceId,
              workspaceSessionDir: parentSessionDir,
              childTaskId: childWorkspaceId,
              updater: (existing) => {
                const failedAtMs = Date.now();
                const pendingArtifact =
                  existing ??
                  buildPendingPatchArtifact({
                    childTaskId: childWorkspaceId,
                    parentWorkspaceId,
                    createdAtMs: failedAtMs,
                    updatedAtMs: failedAtMs,
                    projectArtifacts: pendingProjectArtifacts,
                  });
                return failPendingProjectArtifacts({
                  artifact: pendingArtifact,
                  error: getErrorMessage(error),
                  updatedAtMs: failedAtMs,
                });
              },
            });
          } catch (updateError: unknown) {
            log.error("Failed to mark subagent git patch artifact as failed", {
              parentWorkspaceId,
              childWorkspaceId,
              error: updateError,
            });
          }
        })
        .finally(() => {
          this.pendingJobsByTaskId.delete(childWorkspaceId);
        });
    } catch (error: unknown) {
      await upsertSubagentGitPatchArtifact({
        workspaceId: parentWorkspaceId,
        workspaceSessionDir: parentSessionDir,
        childTaskId: childWorkspaceId,
        updater: (existing) => {
          const failedAtMs = Date.now();
          const pendingArtifact =
            existing ??
            buildPendingPatchArtifact({
              childTaskId: childWorkspaceId,
              parentWorkspaceId,
              createdAtMs: failedAtMs,
              updatedAtMs: failedAtMs,
              projectArtifacts: pendingProjectArtifacts,
            });
          return failPendingProjectArtifacts({
            artifact: pendingArtifact,
            error: getErrorMessage(error),
            updatedAtMs: failedAtMs,
          });
        },
      });
      return;
    }

    this.pendingJobsByTaskId.set(childWorkspaceId, job);
    const completionJob = job
      .then(() => onComplete(childWorkspaceId))
      .catch((error: unknown) => {
        log.error("Subagent git patch completion callback failed", {
          parentWorkspaceId,
          childWorkspaceId,
          error,
        });
      })
      .finally(() => {
        if (this.completionCallbacksByTaskId.get(childWorkspaceId) === completionJob) {
          this.completionCallbacksByTaskId.delete(childWorkspaceId);
        }
      });
    this.completionCallbacksByTaskId.set(childWorkspaceId, completionJob);
  }

  private async generate(parentWorkspaceId: string, childWorkspaceId: string): Promise<void> {
    assert(parentWorkspaceId.length > 0, "generate: parentWorkspaceId must be non-empty");
    assert(childWorkspaceId.length > 0, "generate: childWorkspaceId must be non-empty");

    const parentSessionDir = path.join(this.config.sessionsDir, parentWorkspaceId);

    const updateArtifact = async (
      updater: Parameters<typeof upsertSubagentGitPatchArtifact>[0]["updater"]
    ): Promise<SubagentGitPatchArtifact> => {
      return await upsertSubagentGitPatchArtifact({
        workspaceId: parentWorkspaceId,
        workspaceSessionDir: parentSessionDir,
        childTaskId: childWorkspaceId,
        updater,
      });
    };

    const nowMs = Date.now();

    try {
      const cfg = this.config.loadConfigOrDefault();
      const entry = findWorkspaceEntry(cfg, childWorkspaceId);

      if (!entry) {
        await updateArtifact((existing) =>
          failPendingProjectArtifacts({
            artifact:
              existing ??
              buildPendingPatchArtifact({
                childTaskId: childWorkspaceId,
                parentWorkspaceId,
                createdAtMs: nowMs,
                updatedAtMs: nowMs,
                projectArtifacts: [],
              }),
            error: "Task workspace not found in config.",
            updatedAtMs: nowMs,
          })
        );
        return;
      }

      const ws = entry.workspace;

      const workspacePath = coerceNonEmptyString(ws.path);
      if (!workspacePath) {
        await updateArtifact((existing) =>
          failPendingProjectArtifacts({
            artifact:
              existing ??
              buildPendingPatchArtifact({
                childTaskId: childWorkspaceId,
                parentWorkspaceId,
                createdAtMs: nowMs,
                updatedAtMs: nowMs,
                projectArtifacts: buildPendingProjectArtifacts({
                  projectPath: entry.projectPath,
                  projects: ws.projects,
                  taskBaseCommitSha: coerceNonEmptyString(ws.taskBaseCommitSha) ?? undefined,
                  taskBaseCommitShaByProjectPath: ws.taskBaseCommitShaByProjectPath,
                }),
              }),
            error: "Task workspace path missing.",
            updatedAtMs: nowMs,
          })
        );
        return;
      }

      if (!ws.runtimeConfig) {
        await updateArtifact((existing) =>
          failPendingProjectArtifacts({
            artifact:
              existing ??
              buildPendingPatchArtifact({
                childTaskId: childWorkspaceId,
                parentWorkspaceId,
                createdAtMs: nowMs,
                updatedAtMs: nowMs,
                projectArtifacts: buildPendingProjectArtifacts({
                  projectPath: entry.projectPath,
                  projects: ws.projects,
                  taskBaseCommitSha: coerceNonEmptyString(ws.taskBaseCommitSha) ?? undefined,
                  taskBaseCommitShaByProjectPath: ws.taskBaseCommitShaByProjectPath,
                }),
              }),
            error: "Task runtimeConfig missing.",
            updatedAtMs: nowMs,
          })
        );
        return;
      }

      const fallbackName = workspacePath.split("/").pop() ?? workspacePath.split("\\").pop() ?? "";
      const workspaceName = coerceNonEmptyString(ws.name) ?? coerceNonEmptyString(fallbackName);
      if (!workspaceName) {
        await updateArtifact((existing) =>
          failPendingProjectArtifacts({
            artifact:
              existing ??
              buildPendingPatchArtifact({
                childTaskId: childWorkspaceId,
                parentWorkspaceId,
                createdAtMs: nowMs,
                updatedAtMs: nowMs,
                projectArtifacts: buildPendingProjectArtifacts({
                  projectPath: entry.projectPath,
                  projects: ws.projects,
                  taskBaseCommitSha: coerceNonEmptyString(ws.taskBaseCommitSha) ?? undefined,
                  taskBaseCommitShaByProjectPath: ws.taskBaseCommitShaByProjectPath,
                }),
              }),
            error: "Task workspace name missing.",
            updatedAtMs: nowMs,
          })
        );
        return;
      }

      const runtime = createRuntimeForWorkspace({
        runtimeConfig: ws.runtimeConfig,
        projectPath: entry.projectPath,
        name: workspaceName,
      });

      const projectRepos = getWorkspaceProjectRepos({
        workspaceId: childWorkspaceId,
        workspaceName,
        workspacePath,
        runtimeConfig: ws.runtimeConfig,
        projectPath: entry.projectPath,
        projectName: getPrimaryProjectName(entry.projectPath, ws.projects),
        projects: ws.projects,
      });
      const taskBaseCommitShaByProjectPath = buildTaskBaseCommitShaByProjectPath({
        projectPath: entry.projectPath,
        projects: ws.projects,
        taskBaseCommitSha: coerceNonEmptyString(ws.taskBaseCommitSha) ?? undefined,
        taskBaseCommitShaByProjectPath: ws.taskBaseCommitShaByProjectPath,
      });

      const pendingArtifact = await readSubagentGitPatchArtifact(
        parentSessionDir,
        childWorkspaceId
      );

      const ensureProjectArtifact = async (
        nextProjectArtifact: SubagentGitProjectPatchArtifact
      ): Promise<void> => {
        await updateArtifact((existing) => {
          const pendingArtifact =
            existing ??
            buildPendingPatchArtifact({
              childTaskId: childWorkspaceId,
              parentWorkspaceId,
              createdAtMs: nowMs,
              updatedAtMs: nowMs,
              projectArtifacts: buildPendingProjectArtifacts({
                projectPath: entry.projectPath,
                projects: ws.projects,
                taskBaseCommitSha: coerceNonEmptyString(ws.taskBaseCommitSha) ?? undefined,
                taskBaseCommitShaByProjectPath: ws.taskBaseCommitShaByProjectPath,
              }),
            });
          return upsertProjectArtifact({
            artifact: pendingArtifact,
            nextProjectArtifact,
            updatedAtMs: Date.now(),
          });
        });
      };

      for (const projectRepo of projectRepos) {
        try {
          const pendingProjectArtifact = pendingArtifact?.projectArtifacts.find((artifact) =>
            matchesProjectArtifactProjectPathForUpdate(artifact, projectRepo.projectPath)
          );
          // Continuation refreshes can advance the handoff base after an earlier patch was applied.
          // Prefer the pending artifact's captured base over the task's original launch commit.
          let baseCommitSha =
            coerceNonEmptyString(pendingProjectArtifact?.baseCommitSha) ??
            coerceNonEmptyString(taskBaseCommitShaByProjectPath[projectRepo.projectPath]);
          if (!baseCommitSha) {
            const trunkBranch =
              coerceNonEmptyString(ws.taskTrunkBranch) ??
              coerceNonEmptyString(findWorkspaceEntry(cfg, parentWorkspaceId)?.workspace.name);

            if (!trunkBranch) {
              await ensureProjectArtifact({
                projectPath: projectRepo.projectPath,
                projectName: projectRepo.projectName,
                storageKey: projectRepo.storageKey,
                status: "failed",
                error:
                  "taskBaseCommitSha missing and could not determine trunk branch for merge-base fallback.",
              });
              continue;
            }

            const mergeBaseResult = await execBuffered(
              runtime,
              `git merge-base ${shellQuote(trunkBranch)} HEAD`,
              { cwd: projectRepo.repoCwd, timeout: 30 }
            );
            if (mergeBaseResult.exitCode !== 0) {
              await ensureProjectArtifact({
                projectPath: projectRepo.projectPath,
                projectName: projectRepo.projectName,
                storageKey: projectRepo.storageKey,
                status: "failed",
                error: `git merge-base failed: ${mergeBaseResult.stderr.trim() || "unknown error"}`,
              });
              continue;
            }

            baseCommitSha = mergeBaseResult.stdout.trim();
          }

          const headCommitSha = await tryReadGitHeadCommitSha(runtime, projectRepo.repoCwd);
          if (!headCommitSha) {
            await ensureProjectArtifact({
              projectPath: projectRepo.projectPath,
              projectName: projectRepo.projectName,
              storageKey: projectRepo.storageKey,
              status: "failed",
              baseCommitSha,
              error: "git rev-parse HEAD failed.",
            });
            continue;
          }

          const countResult = await execBuffered(
            runtime,
            `git rev-list --count ${baseCommitSha}..${headCommitSha}`,
            { cwd: projectRepo.repoCwd, timeout: 30 }
          );
          if (countResult.exitCode !== 0) {
            await ensureProjectArtifact({
              projectPath: projectRepo.projectPath,
              projectName: projectRepo.projectName,
              storageKey: projectRepo.storageKey,
              status: "failed",
              baseCommitSha,
              headCommitSha,
              error: `git rev-list failed: ${countResult.stderr.trim() || "unknown error"}`,
            });
            continue;
          }

          const commitCount = Number.parseInt(countResult.stdout.trim(), 10);
          if (!Number.isFinite(commitCount) || commitCount < 0) {
            await ensureProjectArtifact({
              projectPath: projectRepo.projectPath,
              projectName: projectRepo.projectName,
              storageKey: projectRepo.storageKey,
              status: "failed",
              baseCommitSha,
              headCommitSha,
              error: `Invalid commit count: ${countResult.stdout.trim()}`,
            });
            continue;
          }

          if (commitCount === 0) {
            await ensureProjectArtifact({
              projectPath: projectRepo.projectPath,
              projectName: projectRepo.projectName,
              storageKey: projectRepo.storageKey,
              status: "skipped",
              baseCommitSha,
              headCommitSha,
              commitCount,
            });
            continue;
          }

          const patchPath = getSubagentGitPatchMboxPath(
            parentSessionDir,
            childWorkspaceId,
            projectRepo.storageKey
          );

          if (!isPathInsideDir(parentSessionDir, patchPath)) {
            await ensureProjectArtifact({
              projectPath: projectRepo.projectPath,
              projectName: projectRepo.projectName,
              storageKey: projectRepo.storageKey,
              status: "failed",
              baseCommitSha,
              headCommitSha,
              commitCount,
              error: `Refusing to write patch outside session dir for storage key ${projectRepo.storageKey}.`,
            });
            continue;
          }

          const generation = await taskGitPatchEngine.generatePatch({
            runtime,
            repoCwd: projectRepo.repoCwd,
            baseCommitSha,
            headCommitSha,
            patchPath,
          });
          if (!generation.success) {
            await ensureProjectArtifact({
              projectPath: projectRepo.projectPath,
              projectName: projectRepo.projectName,
              storageKey: projectRepo.storageKey,
              status: "failed",
              baseCommitSha,
              headCommitSha,
              commitCount,
              error: generation.error,
            });
            continue;
          }

          await ensureProjectArtifact({
            projectPath: projectRepo.projectPath,
            projectName: projectRepo.projectName,
            storageKey: projectRepo.storageKey,
            status: "ready",
            baseCommitSha,
            headCommitSha,
            commitCount,
            mboxPath: patchPath,
          });
        } catch (error: unknown) {
          await ensureProjectArtifact({
            projectPath: projectRepo.projectPath,
            projectName: projectRepo.projectName,
            storageKey: projectRepo.storageKey,
            status: "failed",
            error: getErrorMessage(error),
          });
        }
      }
    } catch (error: unknown) {
      await updateArtifact((existing) =>
        failPendingProjectArtifacts({
          artifact:
            existing ??
            buildPendingPatchArtifact({
              childTaskId: childWorkspaceId,
              parentWorkspaceId,
              createdAtMs: nowMs,
              updatedAtMs: nowMs,
              projectArtifacts: [],
            }),
          error: getErrorMessage(error),
          updatedAtMs: Date.now(),
        })
      );
    }
  }
}

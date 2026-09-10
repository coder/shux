import assert from "node:assert/strict";
import * as fsPromises from "fs/promises";
import * as path from "node:path";

import type { z } from "zod";

import type { ToolConfiguration } from "@/common/utils/tools/tools";
import {
  TaskApplyGitPatchToolArgsSchema,
  type TaskApplyGitPatchToolResultSchema,
  type SubagentGitPatchArtifact,
  type SubagentGitProjectPatchArtifact,
} from "@/common/utils/tools/toolDefinitions";
import { shellQuote } from "@/common/utils/shell";
import { execBuffered } from "@/node/utils/runtime/helpers";
import {
  gitEnvPrefix,
  gitHooksAllowed,
  gitNoRepoAutomationEnvForRuntimeRepo,
} from "@/node/utils/gitNoHooksEnv";
import { isPathInsideDir } from "@/node/utils/pathUtils";
import {
  getSubagentGitPatchMboxPath,
  isSafeSubagentGitPatchPathComponent,
  markSubagentGitPatchArtifactApplied,
  matchesProjectArtifactProjectPath,
  readSubagentGitPatchArtifact,
} from "@/node/services/subagentGitPatchArtifacts";
import { log } from "@/node/services/log";
import { Config } from "@/node/config";
import { coerceNonEmptyString, findWorkspaceEntry } from "@/node/services/taskUtils";
import { getWorkspaceProjectRepos } from "@/node/services/workspaceProjectRepos";

import { streamToString } from "@/node/runtime/streamUtils";

export type TaskApplyGitPatchArgs = z.infer<typeof TaskApplyGitPatchToolArgsSchema>;
export type TaskApplyGitPatchResult = z.infer<typeof TaskApplyGitPatchToolResultSchema>;

export type TaskGitPatchApplyConfig = Pick<
  ToolConfiguration,
  "workspaceId" | "cwd" | "runtime" | "runtimeTempDir" | "workspaceSessionDir" | "trusted"
>;

export interface GitPatchArtifactLookup {
  artifact: SubagentGitPatchArtifact;
  artifactWorkspaceId: string;
  artifactSessionDir: string;
  relation: "direct" | "descendant" | "ancestor";
  note?: string;
}

export interface TaskGitPatchApplyOptions {
  abortSignal?: AbortSignal;
  allowAlreadyApplied?: boolean;
  allowedPathPrefixes?: string[];
  pendingGenerationWaitMs?: number;
  pendingGenerationPollIntervalMs?: number;
  pendingGenerationOnPoll?: () => void;
}

export interface GeneratePatchParams {
  runtime: ToolConfiguration["runtime"];
  repoCwd: string;
  baseCommitSha: string;
  headCommitSha: string;
  patchPath: string;
}

export type GeneratePatchResult = { success: true } | { success: false; error: string };

export interface TaskGitPatchEngine {
  applyPatch(
    config: TaskGitPatchApplyConfig,
    args: TaskApplyGitPatchArgs,
    options?: TaskGitPatchApplyOptions
  ): Promise<TaskApplyGitPatchResult>;
  findPatch(params: {
    workspaceId: string;
    workspaceSessionDir: string;
    childTaskId: string;
  }): Promise<GitPatchArtifactLookup | null>;
  generatePatch(params: GeneratePatchParams): Promise<GeneratePatchResult>;
}

interface AppliedCommit {
  subject: string;
  sha?: string;
}

interface TaskApplyGitPatchProjectResult {
  projectPath: string;
  projectName: string;
  status: "applied" | "failed" | "skipped";
  appliedCommits?: AppliedCommit[];
  headCommitSha?: string;
  error?: string;
  failedPatchSubject?: string;
  conflictPaths?: string[];
  note?: string;
}

async function copyLocalFileToRuntime(params: {
  runtime: ToolConfiguration["runtime"];
  localPath: string;
  remotePath: string;
  abortSignal?: AbortSignal;
}): Promise<void> {
  const writable = params.runtime.writeFile(params.remotePath, params.abortSignal);
  const writer = writable.getWriter();

  const fileHandle = await fsPromises.open(params.localPath, "r");
  try {
    const buffer = Buffer.alloc(64 * 1024);
    while (true) {
      const { bytesRead } = await fileHandle.read(buffer, 0, buffer.length, null);
      if (bytesRead <= 0) break;
      await writer.write(buffer.subarray(0, bytesRead));
    }

    await writer.close();
  } catch (error) {
    try {
      await writer.abort(error);
    } catch {
      // The stream may already be errored; cleanup still proceeds in the caller's finally block.
    }
    writer.releaseLock();
    throw error;
  } finally {
    await fileHandle.close();
  }
}

function mergeNotes(...notes: Array<string | undefined>): string | undefined {
  const parts = notes
    .map((note) => (typeof note === "string" ? note.trim() : ""))
    .filter((note) => note.length > 0);

  return parts.length > 0 ? parts.join("\n") : undefined;
}

async function gitNoRepoAutomationPrefixForRuntime(params: {
  runtime: ToolConfiguration["runtime"];
  cwd: string;
  trusted: boolean;
}): Promise<string> {
  if (gitHooksAllowed(params.trusted)) return "";

  return gitEnvPrefix(await gitNoRepoAutomationEnvForRuntimeRepo(params.runtime, params.cwd));
}

async function tryRevParseHead(params: {
  runtime: ToolConfiguration["runtime"];
  cwd: string;
  gitPrefix: string;
}): Promise<string | undefined> {
  try {
    const headResult = await execBuffered(params.runtime, `${params.gitPrefix}git rev-parse HEAD`, {
      cwd: params.cwd,
      timeout: 10,
    });
    if (headResult.exitCode !== 0) {
      return undefined;
    }
    const sha = headResult.stdout.trim();
    return sha.length > 0 ? sha : undefined;
  } catch {
    return undefined;
  }
}

async function getAppliedCommits(params: {
  runtime: ToolConfiguration["runtime"];
  cwd: string;
  beforeHeadSha: string | undefined;
  commitCountHint: number | undefined;
  includeSha: boolean;
  gitPrefix: string;
}): Promise<AppliedCommit[]> {
  const format = "%H%x00%s";

  async function tryGitLog(args: {
    cmd: string;
    includeSha: boolean;
  }): Promise<AppliedCommit[] | undefined> {
    try {
      const result = await execBuffered(params.runtime, params.gitPrefix + args.cmd, {
        cwd: params.cwd,
        timeout: 30,
      });
      if (result.exitCode !== 0) {
        log.debug("task_apply_git_patch: git log failed", {
          cwd: params.cwd,
          exitCode: result.exitCode,
          stderr: result.stderr.trim(),
          stdout: result.stdout.trim(),
        });
        return undefined;
      }

      const lines = result.stdout
        .split("\n")
        .map((line) => line.replace(/\r$/, ""))
        .filter((line) => line.length > 0);

      const commits: AppliedCommit[] = [];
      for (const line of lines) {
        const nulIndex = line.indexOf("\u0000");
        if (nulIndex === -1) {
          commits.push({ subject: line });
          continue;
        }

        const sha = line.slice(0, nulIndex);
        const subject = line.slice(nulIndex + 1);
        if (subject.length === 0) continue;

        if (args.includeSha && sha.length > 0) {
          commits.push({ sha, subject });
        } else {
          commits.push({ subject });
        }
      }

      return commits;
    } catch (error) {
      log.debug("task_apply_git_patch: git log threw", { cwd: params.cwd, error });
      return undefined;
    }
  }

  if (params.beforeHeadSha) {
    const rangeCmd = `git log --reverse --format=${format} ${params.beforeHeadSha}..HEAD`;
    const commits = await tryGitLog({ cmd: rangeCmd, includeSha: params.includeSha });
    if (commits) return commits;
  }

  if (typeof params.commitCountHint === "number" && params.commitCountHint > 0) {
    const countCmd = `git log -n ${params.commitCountHint} --reverse --format=${format} HEAD`;
    const commits = await tryGitLog({ cmd: countCmd, includeSha: params.includeSha });
    if (commits) return commits;
  }

  return [];
}

const MAX_PARENT_WORKSPACE_DEPTH = 32;

function inferMuxRootFromWorkspaceSessionDir(workspaceSessionDir: string): string | undefined {
  assert(
    workspaceSessionDir.length > 0,
    "inferMuxRootFromWorkspaceSessionDir: workspaceSessionDir must be non-empty"
  );

  const sessionsDir = path.dirname(workspaceSessionDir);
  if (path.basename(sessionsDir) !== "sessions") {
    return undefined;
  }

  return path.dirname(sessionsDir);
}

function parseFailedPatchSubjectFromGitAmOutput(output: string): string | undefined {
  const normalized = output.replace(/\r/g, "");

  const patchFailedMatch = /^Patch failed at \d+ (.+)$/m.exec(normalized);
  if (patchFailedMatch) {
    const subject = patchFailedMatch[1].trim();
    return subject.length > 0 ? subject : undefined;
  }

  const applyingMatches = Array.from(normalized.matchAll(/^Applying: (.+)$/gm));
  const subject = applyingMatches.at(-1)?.[1]?.trim();
  return subject && subject.length > 0 ? subject : undefined;
}

async function tryGetConflictPaths(params: {
  runtime: ToolConfiguration["runtime"];
  cwd: string;
  gitPrefix: string;
}): Promise<string[]> {
  assert(params.cwd.length > 0, "tryGetConflictPaths: cwd must be non-empty");

  try {
    const diffResult = await execBuffered(
      params.runtime,
      `${params.gitPrefix}git diff --name-only --diff-filter=U`,
      {
        cwd: params.cwd,
        timeout: 30,
      }
    );

    if (diffResult.exitCode !== 0) {
      log.debug("task_apply_git_patch: git diff --name-only --diff-filter=U failed", {
        cwd: params.cwd,
        exitCode: diffResult.exitCode,
        stderr: diffResult.stderr.trim(),
        stdout: diffResult.stdout.trim(),
      });
      return [];
    }

    const paths = diffResult.stdout
      .split("\n")
      .map((line) => line.replace(/\r$/, "").trim())
      .filter((line) => line.length > 0);

    return Array.from(new Set(paths));
  } catch (error) {
    log.debug("task_apply_git_patch: git diff --name-only --diff-filter=U threw", {
      cwd: params.cwd,
      error,
    });
    return [];
  }
}

async function isGitAmInProgress(params: {
  runtime: ToolConfiguration["runtime"];
  cwd: string;
  gitPrefix: string;
}): Promise<boolean> {
  assert(params.cwd.length > 0, "isGitAmInProgress: cwd must be non-empty");

  try {
    const checkResult = await execBuffered(
      params.runtime,
      `test -d "$(${params.gitPrefix}git rev-parse --git-path rebase-apply)"`,
      {
        cwd: params.cwd,
        timeout: 30,
      }
    );

    return checkResult.exitCode === 0;
  } catch (error) {
    log.debug("task_apply_git_patch: failed to detect git am progress state", {
      cwd: params.cwd,
      error,
    });
    return false;
  }
}

async function findPatch(params: {
  workspaceId: string;
  workspaceSessionDir: string;
  childTaskId: string;
}): Promise<GitPatchArtifactLookup | null> {
  assert(params.workspaceId.length > 0, "findPatch: workspaceId must be non-empty");
  assert(params.workspaceSessionDir.length > 0, "findPatch: workspaceSessionDir must be non-empty");
  assert(params.childTaskId.length > 0, "findPatch: childTaskId must be non-empty");

  const direct = await readSubagentGitPatchArtifact(params.workspaceSessionDir, params.childTaskId);
  if (direct) {
    return {
      artifact: direct,
      artifactWorkspaceId: params.workspaceId,
      relation: "direct",
      artifactSessionDir: params.workspaceSessionDir,
    };
  }

  const muxRootDir = inferMuxRootFromWorkspaceSessionDir(params.workspaceSessionDir);
  if (!muxRootDir) {
    log.debug(
      "task_apply_git_patch: workspaceSessionDir not under sessions/; skipping ancestor lookup",
      {
        workspaceId: params.workspaceId,
        workspaceSessionDir: params.workspaceSessionDir,
        childTaskId: params.childTaskId,
      }
    );
    return null;
  }

  const configService = new Config(muxRootDir);

  let cfg: ReturnType<Config["loadConfigOrDefault"]>;
  try {
    cfg = configService.loadConfigOrDefault();
  } catch (error) {
    log.debug("task_apply_git_patch: failed to load mux config for ancestor lookup", {
      workspaceId: params.workspaceId,
      muxRootDir,
      error,
    });
    return null;
  }

  const parentById = new Map<string, string | undefined>();
  for (const project of cfg.projects.values()) {
    for (const workspace of project.workspaces) {
      if (!workspace.id) continue;
      parentById.set(workspace.id, workspace.parentWorkspaceId);
    }
  }

  const childParentWorkspaceId = parentById.get(params.childTaskId);
  if (childParentWorkspaceId && childParentWorkspaceId !== params.workspaceId) {
    const descendantVisited = new Set<string>([params.childTaskId]);
    let currentDescendant = params.childTaskId;
    for (let i = 0; i < MAX_PARENT_WORKSPACE_DEPTH; i++) {
      const parent = parentById.get(currentDescendant);
      if (!parent) break;
      if (parent === params.workspaceId) {
        const artifactSessionDir = path.join(configService.sessionsDir, childParentWorkspaceId);
        const artifact = await readSubagentGitPatchArtifact(artifactSessionDir, params.childTaskId);
        if (artifact) {
          return {
            artifact,
            artifactWorkspaceId: childParentWorkspaceId,
            relation: "descendant",
            artifactSessionDir,
            note: `Patch artifact loaded from descendant parent workspace ${childParentWorkspaceId}.`,
          };
        }
        break;
      }
      if (descendantVisited.has(parent)) {
        log.warn(
          "task_apply_git_patch: possible parentWorkspaceId cycle during descendant lookup",
          {
            workspaceId: params.workspaceId,
            childTaskId: params.childTaskId,
            current: currentDescendant,
            parent,
          }
        );
        break;
      }
      descendantVisited.add(parent);
      currentDescendant = parent;
    }
  }

  const visited = new Set<string>();
  visited.add(params.workspaceId);

  let current = params.workspaceId;
  for (let i = 0; i < MAX_PARENT_WORKSPACE_DEPTH; i++) {
    const parent = parentById.get(current);
    if (!parent) {
      return null;
    }

    if (visited.has(parent)) {
      log.warn("task_apply_git_patch: possible parentWorkspaceId cycle during ancestor lookup", {
        workspaceId: params.workspaceId,
        childTaskId: params.childTaskId,
        current,
        parent,
      });
      return null;
    }

    visited.add(parent);

    const parentSessionDir = path.join(configService.sessionsDir, parent);
    const artifact = await readSubagentGitPatchArtifact(parentSessionDir, params.childTaskId);
    if (artifact) {
      return {
        artifact,
        artifactWorkspaceId: parent,
        relation: "ancestor",
        artifactSessionDir: parentSessionDir,
        note: `Patch artifact loaded from ancestor workspace ${parent}.`,
      };
    }

    current = parent;
  }

  log.warn("task_apply_git_patch: exceeded parentWorkspaceId depth during ancestor lookup", {
    workspaceId: params.workspaceId,
    childTaskId: params.childTaskId,
  });

  return null;
}

// A child task's report is delivered before its background `git format-patch`
// generation finishes, so a freshly completed task can briefly expose a
// "pending" patch artifact. Failing immediately misleads callers (e.g. workflow
// applyPatch steps treat the failure as an apply problem and may spawn
// conflict-resolution agents), so we wait for generation to settle instead.
const PENDING_PATCH_GENERATION_WAIT_MS = 120_000;
const PENDING_PATCH_GENERATION_POLL_INTERVAL_MS = 500;

function listRelevantProjectArtifacts(
  artifact: SubagentGitPatchArtifact,
  requestedProjectPath: string | null | undefined
): SubagentGitPatchArtifact["projectArtifacts"] {
  return requestedProjectPath != null
    ? artifact.projectArtifacts.filter((projectArtifact) =>
        matchesProjectArtifactProjectPath(projectArtifact, requestedProjectPath)
      )
    : artifact.projectArtifacts;
}

// Unlike the shared sleepWithAbort in @/node/utils/abort (which REJECTS on
// abort), this helper RESOLVES on abort so the wait loop can fall through to a
// structured tool result instead of throwing out of applyPatch.
async function sleepResolvingOnAbort(delayMs: number, abortSignal?: AbortSignal): Promise<void> {
  assert(delayMs > 0, "sleepResolvingOnAbort: delayMs must be positive");
  if (abortSignal?.aborted === true) {
    return;
  }
  await new Promise<void>((resolve) => {
    const onAbort = () => {
      clearTimeout(timer);
      resolve();
    };
    const timer = setTimeout(() => {
      abortSignal?.removeEventListener("abort", onAbort);
      resolve();
    }, delayMs);
    abortSignal?.addEventListener("abort", onAbort, { once: true });
  });
}

/**
 * Re-read the artifact until no relevant project artifact is still "pending"
 * (generation finished as ready/failed/skipped), the deadline passes, or the
 * caller aborts. Returns the freshest artifact observed.
 */
async function waitForPendingPatchGeneration(params: {
  artifact: SubagentGitPatchArtifact;
  artifactSessionDir: string;
  childTaskId: string;
  requestedProjectPath: string | null | undefined;
  waitMs: number;
  pollIntervalMs: number;
  abortSignal?: AbortSignal;
  onPoll?: () => void;
}): Promise<SubagentGitPatchArtifact> {
  assert(params.waitMs >= 0, "waitForPendingPatchGeneration: waitMs must be non-negative");
  assert(
    params.pollIntervalMs > 0,
    "waitForPendingPatchGeneration: pollIntervalMs must be positive"
  );

  let artifact = params.artifact;
  const deadlineMs = Date.now() + params.waitMs;
  const startedAtMs = Date.now();
  let waited = false;

  while (
    listRelevantProjectArtifacts(artifact, params.requestedProjectPath).some(
      (projectArtifact) => projectArtifact.status === "pending"
    ) &&
    Date.now() < deadlineMs &&
    params.abortSignal?.aborted !== true
  ) {
    waited = true;
    params.onPoll?.();
    await sleepResolvingOnAbort(params.pollIntervalMs, params.abortSignal);
    const refreshed = await readSubagentGitPatchArtifact(
      params.artifactSessionDir,
      params.childTaskId
    );
    if (refreshed != null) {
      artifact = refreshed;
    }
  }

  if (waited) {
    log.debug("task_apply_git_patch: waited for pending patch generation", {
      childTaskId: params.childTaskId,
      waitedMs: Date.now() - startedAtMs,
      // Log the statuses the loop actually waited on; the artifact-level
      // summary stays "pending" while filtered-out sibling projects generate.
      settledStatuses: listRelevantProjectArtifacts(artifact, params.requestedProjectPath).map(
        (projectArtifact) => projectArtifact.status
      ),
      requestedProjectPath: params.requestedProjectPath ?? null,
    });
  }

  return artifact;
}

function toLegacyFields(projectResults: TaskApplyGitPatchProjectResult[]): {
  appliedCommits?: AppliedCommit[];
  headCommitSha?: string;
  conflictPaths?: string[];
  failedPatchSubject?: string;
} {
  if (projectResults.length !== 1) {
    return {};
  }

  const [onlyProjectResult] = projectResults;
  return {
    ...(onlyProjectResult.appliedCommits
      ? { appliedCommits: onlyProjectResult.appliedCommits }
      : {}),
    ...(onlyProjectResult.headCommitSha ? { headCommitSha: onlyProjectResult.headCommitSha } : {}),
    ...(onlyProjectResult.conflictPaths ? { conflictPaths: onlyProjectResult.conflictPaths } : {}),
    ...(onlyProjectResult.failedPatchSubject
      ? { failedPatchSubject: onlyProjectResult.failedPatchSubject }
      : {}),
  };
}

function summarizeNonReadyProjectArtifact(params: {
  projectArtifact: SubagentGitProjectPatchArtifact;
}): TaskApplyGitPatchProjectResult {
  const noteByStatus: Record<string, string | undefined> = {
    pending: "Patch generation is still in progress for this project.",
    skipped: "Patch generation was skipped because this project produced no commits.",
    failed: undefined,
    ready: undefined,
  };

  return {
    projectPath: params.projectArtifact.projectPath,
    projectName: params.projectArtifact.projectName,
    status: params.projectArtifact.status === "failed" ? "failed" : "skipped",
    error:
      params.projectArtifact.error ??
      noteByStatus[params.projectArtifact.status] ??
      `Project patch status is ${params.projectArtifact.status}.`,
  };
}

function resolveCurrentWorkspaceRepoTargets(params: {
  workspaceId: string;
  workspaceSessionDir: string;
}): Map<string, { projectName: string; repoCwd: string }> {
  const muxRootDir = inferMuxRootFromWorkspaceSessionDir(params.workspaceSessionDir);
  if (!muxRootDir) {
    return new Map();
  }

  const configService = new Config(muxRootDir);
  let cfg: ReturnType<Config["loadConfigOrDefault"]>;
  try {
    cfg = configService.loadConfigOrDefault();
  } catch {
    return new Map();
  }

  const entry = findWorkspaceEntry(cfg, params.workspaceId);
  const workspace = entry?.workspace;
  const workspacePath = coerceNonEmptyString(workspace?.path);
  const workspaceName = coerceNonEmptyString(workspace?.name);
  if (!entry || !workspace?.runtimeConfig || !workspacePath || !workspaceName) {
    return new Map();
  }

  const projectRepos = getWorkspaceProjectRepos({
    workspaceId: params.workspaceId,
    workspaceName,
    workspacePath,
    runtimeConfig: workspace.runtimeConfig,
    projectPath: entry.projectPath,
    projectName:
      workspace.projects?.find((project) => project.projectPath === entry.projectPath)
        ?.projectName ??
      entry.projectPath.split("/").filter(Boolean).at(-1) ??
      entry.projectPath,
    projects: workspace.projects,
  });

  return new Map(
    projectRepos.map((projectRepo) => [
      projectRepo.projectPath,
      {
        projectName: projectRepo.projectName,
        repoCwd: projectRepo.repoCwd,
      },
    ])
  );
}

async function resolvePatchPath(params: {
  taskId: string;
  artifactSessionDir: string;
  projectArtifact: SubagentGitProjectPatchArtifact;
  artifactLookupNote?: string;
}): Promise<{ patchPath: string; note?: string } | { error: string; note?: string }> {
  const expectedPatchPath = getSubagentGitPatchMboxPath(
    params.artifactSessionDir,
    params.taskId,
    params.projectArtifact.storageKey
  );

  if (!isPathInsideDir(params.artifactSessionDir, expectedPatchPath)) {
    return {
      error: "Invalid task_id.",
      note: "task_id must not contain path traversal segments.",
    };
  }

  const safeMboxPath =
    typeof params.projectArtifact.mboxPath === "string" &&
    params.projectArtifact.mboxPath.length > 0
      ? isPathInsideDir(params.artifactSessionDir, params.projectArtifact.mboxPath)
        ? params.projectArtifact.mboxPath
        : undefined
      : undefined;

  let patchPathNote = mergeNotes(
    params.artifactLookupNote,
    params.projectArtifact.mboxPath && !safeMboxPath
      ? "Ignoring unsafe mboxPath in patch artifact metadata; using canonical patch location."
      : undefined
  );

  const patchCandidates = [safeMboxPath, expectedPatchPath].filter(
    (candidate): candidate is string => typeof candidate === "string"
  );

  let patchPath: string | null = null;
  for (const candidate of patchCandidates) {
    try {
      const stat = await fsPromises.stat(candidate);
      if (stat.isFile()) {
        patchPath = candidate;
        break;
      }
    } catch {
      // try next candidate
    }
  }

  if (!patchPath) {
    const checkedPaths = Array.from(new Set(patchCandidates))
      .map((candidate) =>
        isPathInsideDir(params.artifactSessionDir, candidate)
          ? path.relative(params.artifactSessionDir, candidate) || path.basename(candidate)
          : candidate
      )
      .join(", ");

    return {
      error: "Patch file is missing on disk.",
      note: mergeNotes(
        patchPathNote,
        checkedPaths.length > 0 ? `Checked patch locations: ${checkedPaths}` : undefined
      ),
    };
  }

  if (safeMboxPath && patchPath === expectedPatchPath && safeMboxPath !== expectedPatchPath) {
    patchPathNote = mergeNotes(
      patchPathNote,
      "Patch file not found at metadata mboxPath; using canonical patch location."
    );
  }

  return { patchPath, note: patchPathNote };
}

function validatePatchRuntimePathComponent(value: string, label: string): string | undefined {
  if (isSafeSubagentGitPatchPathComponent(value)) {
    return undefined;
  }
  return `${label} must be a safe path component.`;
}

function buildRuntimeTempPath(params: {
  runtimeTempDir: string;
  filename: string;
  purpose: string;
}): string {
  const runtimePath = path.posix.join(params.runtimeTempDir, params.filename);
  assert(
    isPathInsideDir(params.runtimeTempDir, runtimePath),
    `task_apply_git_patch ${params.purpose} path must stay inside runtimeTempDir`
  );
  return runtimePath;
}

interface GitStatusPorcelainEntry {
  path: string;
  status: string;
}

function parseGitStatusPorcelainZ(stdout: string): GitStatusPorcelainEntry[] {
  const entriesByPath: GitStatusPorcelainEntry[] = [];
  const entries = stdout.split("\0");
  for (let i = 0; i < entries.length; i += 1) {
    const entry = entries[i];
    if (entry.length < 4) continue;

    const status = entry.slice(0, 2);
    const filePath = entry.slice(3);
    if (filePath.length > 0) {
      entriesByPath.push({ path: filePath, status });
    }

    if (status.includes("R") || status.includes("C")) {
      i += 1;
      const sourcePath = entries[i];
      if (sourcePath != null && sourcePath.length > 0) {
        entriesByPath.push({ path: sourcePath, status });
      }
    }
  }
  return entriesByPath;
}

function parseGitApplyNumstatZ(stdout: string): string[] {
  return stdout
    .split("\0")
    .map((entry) => {
      const firstTabIndex = entry.indexOf("\t");
      const secondTabIndex = entry.indexOf("\t", firstTabIndex + 1);
      return secondTabIndex === -1 ? "" : entry.slice(secondTabIndex + 1);
    })
    .filter((filePath) => filePath.length > 0);
}

interface PatchMetadataPaths {
  renamePaths: string[];
  copySourcePaths: string[];
}

function parsePatchMetadataPaths(stdout: string): PatchMetadataPaths {
  const renamePaths: string[] = [];
  const copySourcePaths: string[] = [];
  for (const line of stdout.split(/\r?\n/)) {
    const renamePrefix = line.startsWith("rename from ")
      ? "rename from "
      : line.startsWith("rename to ")
        ? "rename to "
        : undefined;
    if (renamePrefix != null) {
      const filePath = parsePatchMetadataPath(line.slice(renamePrefix.length));
      if (filePath.length > 0) {
        renamePaths.push(filePath);
      }
      continue;
    }

    if (line.startsWith("copy from ")) {
      const filePath = parsePatchMetadataPath(line.slice("copy from ".length));
      if (filePath.length > 0) {
        copySourcePaths.push(filePath);
      }
    }
  }
  return { renamePaths, copySourcePaths };
}

function parseDiffGitHeaderPaths(stdout: string): string[] {
  const paths = new Set<string>();
  for (const line of stdout.split(/\r?\n/)) {
    if (!line.startsWith("diff --git ")) continue;
    for (const filePath of parseDiffGitHeaderLine(line.slice("diff --git ".length))) {
      paths.add(filePath);
    }
  }
  return [...paths].filter((filePath) => filePath.length > 0);
}

// Git C-quotes each side of the header independently, so a rename between an
// ASCII and a non-ASCII name yields a mixed quoted/unquoted path pair. An
// unquoted side never contains a literal quote (git would have quoted it), so
// a mid-line quote can only open a quoted b side.
function parseDiffGitHeaderLine(line: string): string[] {
  if (line.startsWith('"')) {
    const first = parseGitQuotedPath(line, 0);
    if (first == null) return [];
    let secondStartOffset = first.nextOffset;
    while (line[secondStartOffset] === " ") {
      secondStartOffset += 1;
    }
    const rest = line.slice(secondStartOffset);
    const second = rest.startsWith('"') ? parseGitQuotedPath(line, secondStartOffset)?.path : rest;
    return [stripDiffPathPrefix(first.path), stripDiffPathPrefix(second)].filter(
      (filePath): filePath is string => filePath != null && filePath.length > 0
    );
  }

  if (!line.startsWith("a/")) {
    return [];
  }

  const quoteIndex = line.indexOf('"');
  if (quoteIndex !== -1) {
    const second = parseGitQuotedPath(line, quoteIndex);
    if (second == null) return [];
    return [
      stripDiffPathPrefix(line.slice(0, quoteIndex).trimEnd()),
      stripDiffPathPrefix(second.path),
    ].filter((filePath): filePath is string => filePath != null && filePath.length > 0);
  }

  const paths = new Set<string>();
  let separatorIndex = line.indexOf(" b/", "a/".length);
  while (separatorIndex !== -1) {
    paths.add(line.slice("a/".length, separatorIndex));
    paths.add(line.slice(separatorIndex + " b/".length));
    separatorIndex = line.indexOf(" b/", separatorIndex + 1);
  }
  return [...paths];
}

function stripDiffPathPrefix(filePath: string | undefined): string | undefined {
  if (filePath == null) return undefined;
  return filePath.startsWith("a/") || filePath.startsWith("b/") ? filePath.slice(2) : filePath;
}

function parsePatchMetadataPath(value: string): string {
  if (!value.startsWith('"')) {
    return value;
  }
  return parseGitQuotedPath(value, 0)?.path ?? "";
}

function parseGitQuotedPath(
  value: string,
  startOffset: number
): { path: string; nextOffset: number } | undefined {
  if (value[startOffset] !== '"') {
    return undefined;
  }

  const bytes: number[] = [];
  const encoder = new TextEncoder();
  let offset = startOffset + 1;
  while (offset < value.length) {
    const char = value[offset];
    if (char === '"') {
      return { path: new TextDecoder().decode(Uint8Array.from(bytes)), nextOffset: offset + 1 };
    }

    if (char !== "\\") {
      const codePoint = value.codePointAt(offset);
      if (codePoint == null) {
        return undefined;
      }
      const codePointString = String.fromCodePoint(codePoint);
      bytes.push(...encoder.encode(codePointString));
      offset += codePointString.length;
      continue;
    }

    offset += 1;
    if (offset >= value.length) {
      return undefined;
    }

    const escaped = value[offset];
    if (/[0-7]/.test(escaped)) {
      let octal = escaped;
      offset += 1;
      while (offset < value.length && octal.length < 3 && /[0-7]/.test(value[offset])) {
        octal += value[offset];
        offset += 1;
      }
      bytes.push(Number.parseInt(octal, 8));
      continue;
    }

    const escapedByte = decodeGitQuotedEscapedByte(escaped);
    if (escapedByte == null) {
      bytes.push(...encoder.encode(escaped));
    } else {
      bytes.push(escapedByte);
    }
    offset += 1;
  }

  return undefined;
}

function decodeGitQuotedEscapedByte(char: string): number | undefined {
  switch (char) {
    case "a":
      return 0x07;
    case "b":
      return 0x08;
    case "t":
      return 0x09;
    case "n":
      return 0x0a;
    case "v":
      return 0x0b;
    case "f":
      return 0x0c;
    case "r":
      return 0x0d;
    case '"':
      return 0x22;
    case "\\":
      return 0x5c;
    default:
      return undefined;
  }
}

function extractGitPatchPaths(patchText: string): string[] {
  const paths = new Set<string>();
  for (const line of patchText.split(/\r?\n/)) {
    if (line.startsWith("diff --git ")) {
      const parsed = parseDiffGitHeaderLine(line.slice("diff --git ".length));
      if (parsed.length === 0) paths.add("<unparseable diff header>");
      parsed.forEach((filePath) => paths.add(filePath));
      continue;
    }
    const prefixes = ["--- ", "+++ ", "rename from ", "rename to ", "copy from ", "copy to "];
    const prefix = prefixes.find((candidate) => line.startsWith(candidate));
    if (prefix != null) {
      const filePath = normalizePatchPath(parsePatchMetadataPath(line.slice(prefix.length)));
      if (filePath != null) paths.add(filePath);
    }
  }
  return [...paths];
}

function normalizePatchPath(rawPath: string): string | undefined {
  let value = rawPath.trim();
  if (value.length === 0 || value === "/dev/null") return undefined;
  value = stripDiffPathPrefix(value) ?? value;
  const segments = value.split("/");
  if (path.posix.isAbsolute(value) || segments.includes("..")) return value;
  return segments.filter((segment) => segment.length > 0 && segment !== ".").join("/");
}

function isPatchPathAllowed(patchPath: string, allowedPrefixes: string[]): boolean {
  return allowedPrefixes.some((prefix) => {
    const normalizedPrefix = normalizePatchPath(prefix);
    return (
      normalizedPrefix != null &&
      (patchPath === normalizedPrefix || patchPath.startsWith(normalizedPrefix + "/"))
    );
  });
}

async function getAllowedPatchPathViolation(params: {
  taskId: string;
  artifactSessionDir: string;
  projectArtifacts: SubagentGitProjectPatchArtifact[];
  allowedPathPrefixes: string[];
}): Promise<string | undefined> {
  const violations = new Set<string>();
  for (const projectArtifact of params.projectArtifacts) {
    if (projectArtifact.status === "skipped") continue;
    if (projectArtifact.status !== "ready") {
      return (
        "Patch artifact for " +
        projectArtifact.projectName +
        " is " +
        projectArtifact.status +
        "; cannot validate allowedPathPrefixes."
      );
    }
    const resolution = await resolvePatchPath({
      taskId: params.taskId,
      artifactSessionDir: params.artifactSessionDir,
      projectArtifact,
    });
    if ("error" in resolution) return "Patch file is missing for task " + params.taskId;
    const patchText = await fsPromises.readFile(resolution.patchPath, "utf-8");
    for (const patchPath of extractGitPatchPaths(patchText)) {
      if (!isPatchPathAllowed(patchPath, params.allowedPathPrefixes)) violations.add(patchPath);
    }
  }
  return violations.size === 0
    ? undefined
    : "Patch touches paths outside allowed prefixes (" +
        params.allowedPathPrefixes.join(", ") +
        "): " +
        [...violations].join(", ");
}

function patchPathOverlapsDirtyPath(patchPath: string, dirtyPath: string): boolean {
  const normalizedPatchPath = patchPath.replace(/\/+$/, "");
  const normalizedDirtyPath = dirtyPath.replace(/\/+$/, "");
  return (
    normalizedPatchPath === normalizedDirtyPath ||
    normalizedPatchPath.startsWith(`${normalizedDirtyPath}/`) ||
    normalizedDirtyPath.startsWith(`${normalizedPatchPath}/`)
  );
}

async function checkDirtyPatchPathOverlap(params: {
  runtime: ToolConfiguration["runtime"];
  cwd: string;
  remotePatchPath: string;
  threeWay: boolean;
  gitPrefix: string;
}): Promise<{ error: string; conflictPaths?: string[] } | undefined> {
  const statusResult = await execBuffered(
    params.runtime,
    `${params.gitPrefix}git status --porcelain -z --untracked-files=all`,
    {
      cwd: params.cwd,
      timeout: 10,
    }
  );
  if (statusResult.exitCode !== 0) {
    return { error: statusResult.stderr.trim() || "git status failed" };
  }

  const dirtyEntries = parseGitStatusPorcelainZ(statusResult.stdout);
  if (dirtyEntries.length === 0) {
    return undefined;
  }

  const cachedResult = await execBuffered(
    params.runtime,
    `${params.gitPrefix}git diff-index --cached --name-only -z HEAD --`,
    {
      cwd: params.cwd,
      timeout: 10,
    }
  );
  if (cachedResult.exitCode !== 0) {
    return { error: cachedResult.stderr.trim() || "git diff-index failed" };
  }
  const stagedPaths = cachedResult.stdout
    .split("\0")
    .filter((filePath) => filePath.length > 0)
    .sort();
  if (stagedPaths.length > 0) {
    return {
      error: "Index has staged changes; git am requires a clean index.",
      conflictPaths: stagedPaths,
    };
  }

  const dirtyPaths = new Set(dirtyEntries.map((entry) => entry.path));

  const patchBodyCommand = `awk '/^From / { in_patch=0 } /^---$/ { in_patch=1; next } in_patch { print }' ${shellQuote(
    params.remotePatchPath
  )}`;
  const numstatResult = await execBuffered(
    params.runtime,
    `${patchBodyCommand} | ${params.gitPrefix}git apply --numstat -z`,
    {
      cwd: params.cwd,
      timeout: 30,
    }
  );
  const numstatPaths = parseGitApplyNumstatZ(numstatResult.stdout);

  const diffHeaderResult = await execBuffered(
    params.runtime,
    `awk '/^From / { in_patch=0 } /^---$/ { in_patch=1; next } in_patch && /^diff --git / { print }' ${shellQuote(
      params.remotePatchPath
    )}`,
    {
      cwd: params.cwd,
      timeout: 30,
    }
  );

  if (numstatResult.exitCode !== 0 && !numstatResult.stderr.includes("No valid patches")) {
    return {
      error:
        numstatResult.stderr.trim() ||
        numstatResult.stdout.trim() ||
        "Could not determine patch paths before applying in dirty worktree.",
    };
  }

  const metadataResult = await execBuffered(
    params.runtime,
    `awk '/^From / { in_patch=0; in_diff=0 } /^---$/ { in_patch=1; next } in_patch && /^diff --git / { in_diff=1; next } in_patch && in_diff && (/^rename from / || /^rename to / || /^copy from /) { print }' ${shellQuote(
      params.remotePatchPath
    )}`,
    {
      cwd: params.cwd,
      timeout: 30,
    }
  );
  const metadataPaths = parsePatchMetadataPaths(metadataResult.stdout);
  const patchPaths = new Set([
    ...(numstatResult.exitCode === 0
      ? numstatPaths
      : parseDiffGitHeaderPaths(diffHeaderResult.stdout)),
    ...metadataPaths.renamePaths,
  ]);
  const conflictPaths = [
    ...new Set([
      ...[...dirtyPaths].filter((dirtyPath) =>
        [...patchPaths].some((patchPath) => patchPathOverlapsDirtyPath(patchPath, dirtyPath))
      ),
      ...dirtyEntries
        .filter(
          (entry) => !params.threeWay || entry.status.includes("D") || entry.status.includes("T")
        )
        .filter((entry) =>
          metadataPaths.copySourcePaths.some((copySourcePath) =>
            patchPathOverlapsDirtyPath(copySourcePath, entry.path)
          )
        )
        .map((entry) => entry.path),
    ]),
  ].sort();
  if (conflictPaths.length === 0) {
    return undefined;
  }

  return {
    error: "Working tree has local changes that overlap patch paths.",
    conflictPaths,
  };
}

async function checkExpectedHead(params: {
  runtime: ToolConfiguration["runtime"];
  cwd: string;
  expectedHeadSha?: string;
  gitPrefix: string;
}): Promise<string | undefined> {
  if (params.expectedHeadSha == null) {
    return undefined;
  }
  const currentHeadSha = await tryRevParseHead({
    runtime: params.runtime,
    cwd: params.cwd,
    gitPrefix: params.gitPrefix,
  });
  if (currentHeadSha == null) {
    return "Could not determine current HEAD before applying patch.";
  }
  if (currentHeadSha !== params.expectedHeadSha) {
    return `Current HEAD ${currentHeadSha} does not match expected HEAD ${params.expectedHeadSha}.`;
  }
  return undefined;
}

async function applyProjectPatch(params: {
  taskId: string;
  workspaceId: string;
  runtime: ToolConfiguration["runtime"];
  runtimeTempDir: string;
  trusted: boolean;
  repoCwd: string;
  projectArtifact: SubagentGitProjectPatchArtifact;
  artifactWorkspaceId: string;
  artifactSessionDir: string;
  artifactLookupNote?: string;
  dryRun: boolean;
  threeWay: boolean;
  force: boolean;
  expectedHeadSha?: string;
  isReplay: boolean;
  abortSignal?: AbortSignal;
}): Promise<{ success: boolean; projectResult: TaskApplyGitPatchProjectResult }> {
  const taskIdError = validatePatchRuntimePathComponent(params.taskId, "task_id");
  const storageKeyError = validatePatchRuntimePathComponent(
    params.projectArtifact.storageKey,
    "storageKey"
  );
  if (taskIdError != null || storageKeyError != null) {
    return {
      success: false,
      projectResult: {
        projectPath: params.projectArtifact.projectPath,
        projectName: params.projectArtifact.projectName,
        status: "failed",
        error: taskIdError ?? storageKeyError,
      },
    };
  }

  const remotePatchPath = buildRuntimeTempPath({
    runtimeTempDir: params.runtimeTempDir,
    filename: `mux-task-${params.taskId}-${params.projectArtifact.storageKey}-series.mbox`,
    purpose: "patch copy",
  });

  await cleanupRuntimePatchFile({
    runtime: params.runtime,
    repoCwd: params.repoCwd,
    remotePatchPath,
    taskId: params.taskId,
    workspaceId: params.workspaceId,
  });

  const patchResolution = await resolvePatchPath({
    taskId: params.taskId,
    artifactSessionDir: params.artifactSessionDir,
    projectArtifact: params.projectArtifact,
    artifactLookupNote: params.artifactLookupNote,
  });
  if ("error" in patchResolution) {
    return {
      success: false,
      projectResult: {
        projectPath: params.projectArtifact.projectPath,
        projectName: params.projectArtifact.projectName,
        status: "failed",
        error: patchResolution.error,
        note: patchResolution.note,
      },
    };
  }

  const gitPrefix = await gitNoRepoAutomationPrefixForRuntime({
    runtime: params.runtime,
    cwd: params.repoCwd,
    trusted: params.trusted,
  });
  const expectedHeadError = await checkExpectedHead({
    runtime: params.runtime,
    cwd: params.repoCwd,
    expectedHeadSha: params.expectedHeadSha,
    gitPrefix,
  });
  if (expectedHeadError != null) {
    return {
      success: false,
      projectResult: {
        projectPath: params.projectArtifact.projectPath,
        projectName: params.projectArtifact.projectName,
        status: "failed",
        error: expectedHeadError,
        note: patchResolution.note,
      },
    };
  }

  try {
    await copyLocalFileToRuntime({
      runtime: params.runtime,
      localPath: patchResolution.patchPath,
      remotePath: remotePatchPath,
      abortSignal: params.abortSignal,
    });

    const flags: string[] = [];
    if (params.threeWay) flags.push("--3way");
    if (!gitHooksAllowed(params.trusted)) flags.push("--no-gpg-sign");

    if (params.dryRun) {
      const dryRunDirtyOverlap = await checkDirtyPatchPathOverlap({
        runtime: params.runtime,
        cwd: params.repoCwd,
        remotePatchPath,
        threeWay: params.threeWay,
        gitPrefix,
      });
      if (dryRunDirtyOverlap != null) {
        return {
          success: false,
          projectResult: {
            projectPath: params.projectArtifact.projectPath,
            projectName: params.projectArtifact.projectName,
            status: "failed",
            error: dryRunDirtyOverlap.error,
            conflictPaths: dryRunDirtyOverlap.conflictPaths,
            note: mergeNotes(
              patchResolution.note,
              "Commit or stash local changes on overlapping patch paths before applying. Unrelated dirty files can remain in place."
            ),
          },
        };
      }

      const dryRunHeadError = await checkExpectedHead({
        runtime: params.runtime,
        cwd: params.repoCwd,
        expectedHeadSha: params.expectedHeadSha,
        gitPrefix,
      });
      if (dryRunHeadError != null) {
        return {
          success: false,
          projectResult: {
            projectPath: params.projectArtifact.projectPath,
            projectName: params.projectArtifact.projectName,
            status: "failed",
            error: dryRunHeadError,
            note: patchResolution.note,
          },
        };
      }
      const dryRunId = `${Date.now().toString(16)}-${Math.random().toString(16).slice(2, 8)}`;
      const dryRunWorktreePath = buildRuntimeTempPath({
        runtimeTempDir: params.runtimeTempDir,
        filename: `mux-git-am-dry-run-${params.taskId}-${params.projectArtifact.storageKey}-${dryRunId}`,
        purpose: "dry-run worktree",
      });

      const addResult = await execBuffered(
        params.runtime,
        `${gitPrefix}git worktree add --detach ${shellQuote(dryRunWorktreePath)} HEAD`,
        { cwd: params.repoCwd, timeout: 60 }
      );
      if (addResult.exitCode !== 0) {
        return {
          success: false,
          projectResult: {
            projectPath: params.projectArtifact.projectPath,
            projectName: params.projectArtifact.projectName,
            status: "failed",
            error: addResult.stderr.trim() || addResult.stdout.trim() || "git worktree add failed",
          },
        };
      }

      try {
        const beforeHeadSha = await tryRevParseHead({
          runtime: params.runtime,
          cwd: dryRunWorktreePath,
          gitPrefix,
        });

        const amCmd = `${gitPrefix}git am ${flags.join(" ")} ${shellQuote(remotePatchPath)}`.trim();
        const amResult = await execBuffered(params.runtime, amCmd, {
          cwd: dryRunWorktreePath,
          timeout: 300,
        });

        if (amResult.exitCode !== 0) {
          const stderr = amResult.stderr.trim();
          const stdout = amResult.stdout.trim();
          const errorOutput = [stderr, stdout]
            .filter((s) => s.length > 0)
            .join("\n")
            .trim();

          const conflictPaths = await tryGetConflictPaths({
            runtime: params.runtime,
            cwd: dryRunWorktreePath,
            gitPrefix,
          });
          const failedPatchSubject = parseFailedPatchSubjectFromGitAmOutput(errorOutput);

          return {
            success: false,
            projectResult: {
              projectPath: params.projectArtifact.projectPath,
              projectName: params.projectArtifact.projectName,
              status: "failed",
              conflictPaths,
              failedPatchSubject,
              error:
                errorOutput.length > 0
                  ? errorOutput
                  : `git am failed (exitCode=${amResult.exitCode})`,
              note: mergeNotes(
                patchResolution.note,
                "Dry run failed; the patch does not apply cleanly against the current HEAD. If this is a parent integration workspace, do not attempt a real apply here; delegate conflict resolution to a sub-agent that can replay and resolve the patch. Dedicated reconciliation workspaces can proceed with real apply plus manual conflict resolution (`git am --continue` / `git am --abort`)."
              ),
            },
          };
        }

        const appliedCommits = await getAppliedCommits({
          runtime: params.runtime,
          cwd: dryRunWorktreePath,
          beforeHeadSha,
          commitCountHint: params.projectArtifact.commitCount,
          includeSha: false,
          gitPrefix,
        });

        return {
          success: true,
          projectResult: {
            projectPath: params.projectArtifact.projectPath,
            projectName: params.projectArtifact.projectName,
            status: "applied",
            appliedCommits,
            note: mergeNotes(patchResolution.note, "Dry run succeeded; no commits were applied."),
          },
        };
      } finally {
        try {
          const abortResult = await execBuffered(params.runtime, `${gitPrefix}git am --abort`, {
            cwd: dryRunWorktreePath,
            timeout: 30,
          });
          if (abortResult.exitCode !== 0) {
            log.debug("task_apply_git_patch: dry-run git am --abort failed", {
              taskId: params.taskId,
              workspaceId: params.workspaceId,
              cwd: params.repoCwd,
              dryRunWorktreePath,
              exitCode: abortResult.exitCode,
              stderr: abortResult.stderr.trim(),
              stdout: abortResult.stdout.trim(),
            });
          }
        } catch (error: unknown) {
          log.debug("task_apply_git_patch: dry-run git am --abort threw", {
            taskId: params.taskId,
            workspaceId: params.workspaceId,
            cwd: params.repoCwd,
            dryRunWorktreePath,
            error,
          });
        }

        try {
          const removeResult = await execBuffered(
            params.runtime,
            `${gitPrefix}git worktree remove --force ${shellQuote(dryRunWorktreePath)}`,
            { cwd: params.repoCwd, timeout: 60 }
          );
          if (removeResult.exitCode !== 0) {
            log.debug("task_apply_git_patch: dry-run git worktree remove failed", {
              taskId: params.taskId,
              workspaceId: params.workspaceId,
              cwd: params.repoCwd,
              dryRunWorktreePath,
              exitCode: removeResult.exitCode,
              stderr: removeResult.stderr.trim(),
              stdout: removeResult.stdout.trim(),
            });
          }
        } catch (error: unknown) {
          log.debug("task_apply_git_patch: dry-run git worktree remove threw", {
            taskId: params.taskId,
            workspaceId: params.workspaceId,
            cwd: params.repoCwd,
            dryRunWorktreePath,
            error,
          });
        }

        try {
          const pruneResult = await execBuffered(params.runtime, `${gitPrefix}git worktree prune`, {
            cwd: params.repoCwd,
            timeout: 60,
          });
          if (pruneResult.exitCode !== 0) {
            log.debug("task_apply_git_patch: dry-run git worktree prune failed", {
              taskId: params.taskId,
              workspaceId: params.workspaceId,
              cwd: params.repoCwd,
              exitCode: pruneResult.exitCode,
              stderr: pruneResult.stderr.trim(),
              stdout: pruneResult.stdout.trim(),
            });
          }
        } catch (error: unknown) {
          log.debug("task_apply_git_patch: dry-run git worktree prune threw", {
            taskId: params.taskId,
            workspaceId: params.workspaceId,
            cwd: params.repoCwd,
            error,
          });
        }
      }
    }

    // Let `git am --3way` handle unrelated dirty files, but reject dirty paths
    // that overlap the patch series before a multi-commit `git am` can partially
    // advance HEAD and then fail on a later commit.
    const dirtyOverlap = await checkDirtyPatchPathOverlap({
      runtime: params.runtime,
      cwd: params.repoCwd,
      remotePatchPath,
      threeWay: params.threeWay,
      gitPrefix,
    });
    if (dirtyOverlap != null) {
      return {
        success: false,
        projectResult: {
          projectPath: params.projectArtifact.projectPath,
          projectName: params.projectArtifact.projectName,
          status: "failed",
          error: dirtyOverlap.error,
          conflictPaths: dirtyOverlap.conflictPaths,
          note: mergeNotes(
            patchResolution.note,
            "Commit or stash local changes on overlapping patch paths before applying. Unrelated dirty files can remain in place."
          ),
        },
      };
    }

    const applyHeadError = await checkExpectedHead({
      runtime: params.runtime,
      cwd: params.repoCwd,
      expectedHeadSha: params.expectedHeadSha,
      gitPrefix,
    });
    if (applyHeadError != null) {
      return {
        success: false,
        projectResult: {
          projectPath: params.projectArtifact.projectPath,
          projectName: params.projectArtifact.projectName,
          status: "failed",
          error: applyHeadError,
          note: patchResolution.note,
        },
      };
    }

    const beforeHeadSha = await tryRevParseHead({
      runtime: params.runtime,
      cwd: params.repoCwd,
      gitPrefix,
    });

    const amCmd = `${gitPrefix}git am ${flags.join(" ")} ${shellQuote(remotePatchPath)}`.trim();
    const amResult = await execBuffered(params.runtime, amCmd, {
      cwd: params.repoCwd,
      timeout: 300,
    });

    if (amResult.exitCode !== 0) {
      const stderr = amResult.stderr.trim();
      const stdout = amResult.stdout.trim();
      const errorOutput = [stderr, stdout]
        .filter((s) => s.length > 0)
        .join("\n")
        .trim();

      const conflictPaths = await tryGetConflictPaths({
        runtime: params.runtime,
        cwd: params.repoCwd,
        gitPrefix,
      });
      const failedPatchSubject = parseFailedPatchSubjectFromGitAmOutput(errorOutput);
      const gitAmInProgress = await isGitAmInProgress({
        runtime: params.runtime,
        cwd: params.repoCwd,
        gitPrefix,
      });
      const conflictRecoveryNote =
        conflictPaths.length > 0 || gitAmInProgress
          ? "git am stopped in conflict-recovery state. Resolve conflicts/issues and run `git am --continue`, or run `git am --abort` to restore a clean working tree and delegate resolution to a sub-agent."
          : "git am failed before entering conflict-recovery state. Review the error output above and fix the patch/input before retrying.";

      return {
        success: false,
        projectResult: {
          projectPath: params.projectArtifact.projectPath,
          projectName: params.projectArtifact.projectName,
          status: "failed",
          conflictPaths,
          failedPatchSubject,
          error:
            errorOutput.length > 0 ? errorOutput : `git am failed (exitCode=${amResult.exitCode})`,
          note: mergeNotes(patchResolution.note, conflictRecoveryNote),
        },
      };
    }

    const headCommitSha = await tryRevParseHead({
      runtime: params.runtime,
      cwd: params.repoCwd,
      gitPrefix,
    });

    const appliedCommits = await getAppliedCommits({
      runtime: params.runtime,
      cwd: params.repoCwd,
      beforeHeadSha,
      commitCountHint: params.projectArtifact.commitCount,
      includeSha: true,
      gitPrefix,
    });

    if (!params.isReplay) {
      await markSubagentGitPatchArtifactApplied({
        workspaceId: params.artifactWorkspaceId,
        workspaceSessionDir: params.artifactSessionDir,
        childTaskId: params.taskId,
        projectPath: params.projectArtifact.projectPath,
        appliedAtMs: Date.now(),
      });
    }

    return {
      success: true,
      projectResult: {
        projectPath: params.projectArtifact.projectPath,
        projectName: params.projectArtifact.projectName,
        status: "applied",
        appliedCommits,
        headCommitSha,
        note: patchResolution.note,
      },
    };
  } finally {
    await cleanupRuntimePatchFile({
      runtime: params.runtime,
      repoCwd: params.repoCwd,
      remotePatchPath,
      taskId: params.taskId,
      workspaceId: params.workspaceId,
    });
  }
}

async function cleanupRuntimePatchFile(params: {
  runtime: ToolConfiguration["runtime"];
  repoCwd: string;
  remotePatchPath: string;
  taskId: string;
  workspaceId: string;
}): Promise<void> {
  try {
    const result = await execBuffered(
      params.runtime,
      `rm -f ${shellQuote(params.remotePatchPath)}`,
      {
        cwd: params.repoCwd,
        timeout: 30,
      }
    );
    if (result.exitCode !== 0) {
      log.debug("task_apply_git_patch: patch file cleanup failed", {
        taskId: params.taskId,
        workspaceId: params.workspaceId,
        remotePatchPath: params.remotePatchPath,
        exitCode: result.exitCode,
        stderr: result.stderr.trim(),
        stdout: result.stdout.trim(),
      });
    }
  } catch (error: unknown) {
    log.debug("task_apply_git_patch: patch file cleanup threw", {
      taskId: params.taskId,
      workspaceId: params.workspaceId,
      remotePatchPath: params.remotePatchPath,
      error,
    });
  }
}

async function applyPatch(
  config: TaskGitPatchApplyConfig,
  args: TaskApplyGitPatchArgs,
  options: TaskGitPatchApplyOptions = {}
): Promise<TaskApplyGitPatchResult> {
  assert(config.workspaceId, "taskGitPatchEngine.applyPatch requires workspaceId");
  const workspaceId = config.workspaceId;
  assert(config.cwd, "taskGitPatchEngine.applyPatch requires cwd");
  assert(config.runtimeTempDir, "taskGitPatchEngine.applyPatch requires runtimeTempDir");
  const workspaceSessionDir = config.workspaceSessionDir;
  assert(workspaceSessionDir, "taskGitPatchEngine.applyPatch requires workspaceSessionDir");

  const parsedArgs = TaskApplyGitPatchToolArgsSchema.parse(args);
  const taskId = parsedArgs.task_id;
  const dryRun = parsedArgs.dry_run === true;
  const threeWay = parsedArgs.three_way !== false;
  const force = parsedArgs.force === true;
  const expectedHeadSha = parsedArgs.expected_head_sha ?? undefined;

  if (!isSafeSubagentGitPatchPathComponent(taskId)) {
    return {
      success: false as const,
      taskId,
      dryRun,
      error: "Invalid task_id.",
      note: "task_id must be a safe path component.",
    };
  }

  await config.runtime.ensureDir(config.runtimeTempDir, options.abortSignal);

  const artifactLookup = await findPatch({
    workspaceId,
    workspaceSessionDir,
    childTaskId: taskId,
  });

  if (!artifactLookup) {
    return {
      success: false as const,
      taskId,
      dryRun,
      error: "No git patch artifact found for this taskId.",
    };
  }

  let artifact = artifactLookup.artifact;
  const artifactWorkspaceId = artifactLookup.artifactWorkspaceId;
  const artifactSessionDir = artifactLookup.artifactSessionDir;
  // Applying a descendant's patch from an ancestor is the canonical integration path and must
  // persist its applied watermark. Only applying an ancestor-owned artifact into a descendant is
  // replay behavior that leaves the source metadata unchanged.
  const isReplay = artifactLookup.relation === "ancestor";
  const artifactLookupNote = artifactLookup.note;

  if (artifact.parentWorkspaceId !== artifactWorkspaceId) {
    return {
      success: false as const,
      taskId,
      dryRun,
      error: "This patch artifact belongs to a different parent workspace.",
      note: mergeNotes(
        artifactLookupNote,
        `Expected parent workspace ${artifactWorkspaceId} but artifact metadata says ${artifact.parentWorkspaceId}.`
      ),
    };
  }

  const requestedProjectPath = parsedArgs.project_path;

  // Patch generation runs in the background after the child task reports, so
  // the artifact may still be "pending" when apply is requested right after
  // task completion. Wait for it to settle before deciding success/failure.
  artifact = await waitForPendingPatchGeneration({
    artifact,
    artifactSessionDir,
    childTaskId: taskId,
    requestedProjectPath,
    waitMs: options.pendingGenerationWaitMs ?? PENDING_PATCH_GENERATION_WAIT_MS,
    pollIntervalMs:
      options.pendingGenerationPollIntervalMs ?? PENDING_PATCH_GENERATION_POLL_INTERVAL_MS,
    abortSignal: options.abortSignal,
    onPoll: options.pendingGenerationOnPoll,
  });

  // The wait exits when aborted, but the artifact may have settled to "ready"
  // on its final re-read. Never start a (destructive) apply for a cancelled
  // call — bail before any repo mutation.
  if (options.abortSignal?.aborted === true) {
    return {
      success: false as const,
      taskId,
      dryRun,
      error: "Aborted while waiting for patch generation; the patch was not applied.",
      note: artifactLookupNote,
    };
  }

  const projectArtifacts = listRelevantProjectArtifacts(artifact, requestedProjectPath);

  if (parsedArgs.project_path != null && projectArtifacts.length === 0) {
    return {
      success: false as const,
      taskId,
      dryRun,
      error: `No project patch artifact found for ${parsedArgs.project_path}.`,
    };
  }

  if (projectArtifacts.length === 0) {
    return {
      success: false as const,
      taskId,
      dryRun,
      error: "This task has no project patch artifacts.",
    };
  }

  // Still-pending here means generation outlived the wait above. Do not
  // partially apply (ready siblings would land while the pending project's
  // commits silently drop, and workflows would checkpoint the step as
  // applied); fail atomically with a retryable, non-conflict error instead.
  if (projectArtifacts.some((projectArtifact) => projectArtifact.status === "pending")) {
    const pendingProjectResults = projectArtifacts.map((projectArtifact) =>
      projectArtifact.status === "ready"
        ? {
            projectPath: projectArtifact.projectPath,
            projectName: projectArtifact.projectName,
            status: "skipped" as const,
            error:
              "Not attempted because patch generation has not finished for another project in this task.",
          }
        : summarizeNonReadyProjectArtifact({ projectArtifact })
    );
    return {
      success: false as const,
      taskId,
      dryRun,
      projectResults: pendingProjectResults,
      error:
        "Patch generation has not finished for this task yet. This is not an apply conflict; retry task_apply_git_patch shortly.",
      note: artifactLookupNote,
      ...toLegacyFields(pendingProjectResults),
    };
  }

  if (options.allowedPathPrefixes != null && options.allowedPathPrefixes.length > 0) {
    const pathViolation = await getAllowedPatchPathViolation({
      taskId,
      artifactSessionDir,
      projectArtifacts,
      allowedPathPrefixes: options.allowedPathPrefixes,
    });
    if (pathViolation != null) {
      return { success: false as const, taskId, error: pathViolation };
    }
  }

  const repoTargetsByProjectPath = resolveCurrentWorkspaceRepoTargets({
    workspaceId,
    workspaceSessionDir,
  });
  const projectResults: TaskApplyGitPatchProjectResult[] = [];

  const readyProjectArtifacts = projectArtifacts.filter(
    (projectArtifact) => projectArtifact.status === "ready"
  );
  if (readyProjectArtifacts.length === 0) {
    for (const projectArtifact of projectArtifacts) {
      projectResults.push(summarizeNonReadyProjectArtifact({ projectArtifact }));
    }

    const legacyFields = toLegacyFields(projectResults);
    return {
      success: false as const,
      taskId,
      dryRun,
      projectResults,
      error: "This task has no ready project patch artifacts.",
      note: artifactLookupNote,
      ...legacyFields,
    };
  }

  let shouldStopAfterFailure = false;
  for (const projectArtifact of projectArtifacts) {
    if (shouldStopAfterFailure) {
      projectResults.push({
        projectPath: projectArtifact.projectPath,
        projectName: projectArtifact.projectName,
        status: "skipped",
        error: "Not attempted because an earlier project apply failed.",
      });
      continue;
    }

    if (projectArtifact.status !== "ready") {
      projectResults.push(summarizeNonReadyProjectArtifact({ projectArtifact }));
      if (parsedArgs.project_path != null) {
        shouldStopAfterFailure = true;
      }
      continue;
    }

    if (!isReplay && projectArtifact.appliedAtMs && !force) {
      const appliedAt = new Date(projectArtifact.appliedAtMs).toISOString();
      if (options.allowAlreadyApplied === true) {
        projectResults.push({
          projectPath: projectArtifact.projectPath,
          projectName: projectArtifact.projectName,
          status: "applied",
          note: `Patch already applied at ${appliedAt}; treating as applied for replay-safe workflow integration.`,
        });
        continue;
      }
      if (!dryRun) {
        projectResults.push({
          projectPath: projectArtifact.projectPath,
          projectName: projectArtifact.projectName,
          status: "failed",
          error: `Patch already applied at ${appliedAt}.`,
          note: "Re-run with force=true to apply again.",
        });
        shouldStopAfterFailure = true;
        continue;
      }
    }

    const repoTarget = repoTargetsByProjectPath.get(projectArtifact.projectPath);
    const repoCwd =
      repoTarget?.repoCwd ?? (artifact.projectArtifacts.length === 1 ? config.cwd : undefined);
    if (!repoCwd) {
      projectResults.push({
        projectPath: projectArtifact.projectPath,
        projectName: projectArtifact.projectName,
        status: "failed",
        error: "Could not resolve the current workspace repo root for this project.",
      });
      shouldStopAfterFailure = true;
      continue;
    }

    const applyResult = await applyProjectPatch({
      taskId,
      workspaceId,
      runtime: config.runtime,
      runtimeTempDir: config.runtimeTempDir,
      trusted: config.trusted === true,
      repoCwd,
      projectArtifact,
      artifactWorkspaceId,
      artifactSessionDir,
      artifactLookupNote,
      dryRun,
      threeWay,
      force,
      expectedHeadSha,
      isReplay,
      abortSignal: options.abortSignal,
    });
    projectResults.push(applyResult.projectResult);
    if (!applyResult.success) {
      shouldStopAfterFailure = true;
    }
  }

  const legacyFields = toLegacyFields(projectResults);
  const attemptedReadyCount = projectArtifacts.filter(
    (projectArtifact) => projectArtifact.status === "ready"
  ).length;
  const appliedReadyCount = projectResults.filter(
    (projectResult) => projectResult.status === "applied"
  ).length;
  const hasApplyFailure = projectResults.some(
    (projectResult, index) =>
      projectResult.status === "failed" && projectArtifacts[index]?.status === "ready"
  );
  const overallNote = mergeNotes(
    artifactLookupNote,
    projectResults
      .map((projectResult) => projectResult.note)
      .filter((note): note is string => typeof note === "string")
      .join("\n") || undefined
  );

  if (hasApplyFailure) {
    const firstFailedProject = projectResults.find(
      (projectResult) => projectResult.status === "failed"
    );
    return {
      success: false as const,
      taskId,
      dryRun,
      projectResults,
      error:
        firstFailedProject?.error ??
        `Failed while applying project patches (${appliedReadyCount}/${attemptedReadyCount} ready projects applied).`,
      note: overallNote,
      ...legacyFields,
    };
  }

  return {
    success: true as const,
    taskId,
    projectResults,
    dryRun,
    note: overallNote,
    ...(projectResults.length === 1 ? legacyFields : {}),
  };
}

async function writeReadableStreamToLocalFile(
  stream: ReadableStream<Uint8Array>,
  filePath: string
): Promise<void> {
  await fsPromises.mkdir(path.dirname(filePath), { recursive: true });
  const fileHandle = await fsPromises.open(filePath, "w");
  try {
    const reader = stream.getReader();
    try {
      while (true) {
        const { done, value } = await reader.read();
        if (done) break;
        if (value != null) await fileHandle.write(value);
      }
    } finally {
      reader.releaseLock();
    }
  } finally {
    await fileHandle.close();
  }
}

async function generatePatch(params: GeneratePatchParams): Promise<GeneratePatchResult> {
  const process = await params.runtime.exec(
    "git format-patch --stdout --binary " + params.baseCommitSha + ".." + params.headCommitSha,
    { cwd: params.repoCwd, timeout: 120 }
  );
  await process.stdin.close();
  const [exitCode, stderr] = await Promise.all([
    process.exitCode,
    streamToString(process.stderr),
    writeReadableStreamToLocalFile(process.stdout, params.patchPath),
  ]);
  if (exitCode === 0) return { success: true };
  await fsPromises.rm(params.patchPath, { force: true });
  return {
    success: false,
    error:
      "git format-patch failed (exitCode=" + exitCode + "): " + (stderr.trim() || "unknown error"),
  };
}

export const taskGitPatchEngine: TaskGitPatchEngine = { applyPatch, findPatch, generatePatch };

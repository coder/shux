/**
 * Small pure helpers shared by TaskService and GitPatchArtifactService.
 * Extracted to a standalone module to avoid circular imports.
 */
import assert from "node:assert/strict";
import type { Config, Workspace as WorkspaceConfigEntry } from "@/node/config";
import type { Runtime } from "@/node/runtime/Runtime";
import { execBuffered } from "@/node/utils/runtime/helpers";
import { shellQuote } from "@/common/utils/shell";
import { resolveModelFallbackChain } from "@/common/utils/ai/modelFallbacks";

export function coerceNonEmptyString(value: unknown): string | undefined {
  if (typeof value !== "string") return undefined;
  const trimmed = value.trim();
  return trimmed.length > 0 ? trimmed : undefined;
}

export async function tryReadGitHeadCommitSha(
  runtime: Runtime,
  workspacePath: string
): Promise<string | undefined> {
  assert(workspacePath.length > 0, "tryReadGitHeadCommitSha: workspacePath must be non-empty");

  try {
    const result = await execBuffered(runtime, "git rev-parse HEAD", {
      cwd: workspacePath,
      timeout: 10,
    });
    if (result.exitCode !== 0) {
      return undefined;
    }

    const sha = result.stdout.trim();
    return sha.length > 0 ? sha : undefined;
  } catch {
    return undefined;
  }
}

/**
 * Branch currently checked out in the workspace, or undefined when it cannot be
 * determined (no git, detached HEAD, unreachable runtime). Callers use this as
 * proof of a checkout's base branch, so "unknown" must stay distinguishable
 * from any real branch name.
 */
export async function tryReadGitCurrentBranch(
  runtime: Runtime,
  workspacePath: string
): Promise<string | undefined> {
  assert(workspacePath.length > 0, "tryReadGitCurrentBranch: workspacePath must be non-empty");

  try {
    const result = await execBuffered(runtime, "git rev-parse --abbrev-ref HEAD", {
      cwd: workspacePath,
      timeout: 10,
    });
    if (result.exitCode !== 0) {
      return undefined;
    }

    const branch = result.stdout.trim();
    // Detached HEAD reports the literal string "HEAD" — not a branch identity.
    if (branch.length === 0 || branch === "HEAD") {
      return undefined;
    }
    return branch;
  } catch {
    return undefined;
  }
}

/**
 * True when the checkout's HEAD commit matches its origin ref for the given
 * branch (or no origin ref exists, making local HEAD the only base candidate);
 * false when they differ; undefined when this cannot be determined. Worktree
 * creation may branch from origin/<branch> when the local branch can
 * fast-forward, so callers must not treat a stale local checkout as the
 * authoritative base commit.
 */
export async function tryReadGitBranchMatchesOrigin(
  runtime: Runtime,
  workspacePath: string,
  branch: string
): Promise<boolean | undefined> {
  assert(
    workspacePath.length > 0,
    "tryReadGitBranchMatchesOrigin: workspacePath must be non-empty"
  );
  assert(branch.length > 0, "tryReadGitBranchMatchesOrigin: branch must be non-empty");

  const headSha = await tryReadGitHeadCommitSha(runtime, workspacePath);
  if (headSha == null) {
    return undefined;
  }
  try {
    // SECURITY: branch names are repo-controlled input (a git-valid branch can contain
    // quotes); the full revision argument must be shell-quoted before interpolation.
    const revision = shellQuote(`origin/${branch}^{commit}`);
    const result = await execBuffered(runtime, `git rev-parse --verify --quiet ${revision}`, {
      cwd: workspacePath,
      timeout: 10,
    });
    if (result.exitCode !== 0) {
      // No origin ref for this branch: the local commit is the only candidate base.
      return true;
    }
    return result.stdout.trim() === headSha;
  } catch {
    return undefined;
  }
}

/**
 * True when the checkout has no uncommitted changes (including untracked AND
 * gitignored files — an ignored local file still shadows committed state for
 * discovery-style readers) under the given pathspecs; undefined when this cannot
 * be determined (no git, unreachable runtime). Callers use this as proof that the
 * committed base equals the working tree for those paths, so "unknown" must stay
 * distinguishable from "clean".
 */
export async function tryReadGitPathsClean(
  runtime: Runtime,
  workspacePath: string,
  pathspecs: readonly string[]
): Promise<boolean | undefined> {
  assert(workspacePath.length > 0, "tryReadGitPathsClean: workspacePath must be non-empty");
  assert(pathspecs.length > 0, "tryReadGitPathsClean: pathspecs must be non-empty");

  try {
    const quoted = pathspecs.map((pathspec) => shellQuote(pathspec)).join(" ");
    const result = await execBuffered(runtime, `git status --porcelain --ignored -- ${quoted}`, {
      cwd: workspacePath,
      timeout: 10,
    });
    if (result.exitCode !== 0) {
      return undefined;
    }
    return result.stdout.trim().length === 0;
  } catch {
    return undefined;
  }
}

/**
 * Resolve the effective refusal-fallback chain for a workspace's turn.
 * Task children can opt out via taskOnRefusal: "fail" (e.g. workflow verifier
 * steps that demand an honest terminal failure instead of a silent model
 * swap). Workspaces not found in config (non-task sends) keep the configured
 * chain.
 */
export function resolveWorkspaceModelFallbackChain(
  config: ReturnType<Config["loadConfigOrDefault"]>,
  workspaceId: string,
  modelString: string,
  providersConfig?: Record<string, unknown> | null
): string[] {
  assert(workspaceId.length > 0, "resolveWorkspaceModelFallbackChain: workspaceId required");
  const chain = resolveModelFallbackChain(config.modelFallbacks, modelString, providersConfig);
  if (chain.length === 0) {
    return chain;
  }
  const entry = findWorkspaceEntry(config, workspaceId);
  return entry?.workspace.taskOnRefusal === "fail" ? [] : chain;
}

export function findWorkspaceEntry(
  config: ReturnType<Config["loadConfigOrDefault"]>,
  workspaceId: string
): { projectPath: string; workspace: WorkspaceConfigEntry } | null {
  for (const [projectPath, project] of config.projects) {
    for (const workspace of project.workspaces) {
      if (workspace.id === workspaceId) {
        return { projectPath, workspace };
      }
    }
  }
  return null;
}

/**
 * Walk the parentWorkspaceId chain to compute task nesting depth.
 * Detects cycles (max 32 hops).
 */
export function getTaskDepthFromConfig(
  config: ReturnType<Config["loadConfigOrDefault"]>,
  workspaceId: string
): number {
  const parentById = new Map<string, string | undefined>();
  for (const project of config.projects.values()) {
    for (const workspace of project.workspaces) {
      if (!workspace.id) continue;
      parentById.set(workspace.id, workspace.parentWorkspaceId);
    }
  }

  let depth = 0;
  let current = workspaceId;
  for (let i = 0; i < 32; i++) {
    const parent = parentById.get(current);
    if (!parent) break;
    depth += 1;
    current = parent;
  }

  if (depth >= 32) {
    throw new Error(
      `getTaskDepthFromConfig: possible parentWorkspaceId cycle starting at ${workspaceId}`
    );
  }

  return depth;
}

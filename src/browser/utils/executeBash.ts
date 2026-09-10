import type { FrontendWorkspaceMetadata } from "@/common/types/workspace";

interface WorkspaceRelativeProjectMatch {
  normalizedPath: string;
  repoRelativePath?: string;
  projectPath: string;
}

function normalizePath(path: string | null | undefined): string {
  return path?.replaceAll("\\", "/").trim() ?? "";
}

/**
 * Git file paths may legitimately begin or end with whitespace (e.g. a file named
 * ".env "), so file-path normalization must not trim; trimming belongs only to
 * config-controlled project paths.
 */
function normalizeFilePath(path: string | null | undefined): string {
  return path?.replaceAll("\\", "/") ?? "";
}

function matchesRepoRootProjectPath(
  projectPath: string | null | undefined,
  normalizedRepoRootProjectPath: string
): boolean {
  return normalizePath(projectPath) === normalizedRepoRootProjectPath;
}

function resolveWorkspaceRelativeProjectMatch(
  workspaceMetadata: Pick<FrontendWorkspaceMetadata, "projects"> | null | undefined,
  workspaceRelativePath: string | null | undefined
): WorkspaceRelativeProjectMatch | undefined {
  const projects = workspaceMetadata?.projects;
  if (!projects || projects.length < 2 || !workspaceRelativePath) {
    return undefined;
  }

  const normalizedPath = normalizeFilePath(workspaceRelativePath);
  if (!normalizedPath) {
    return undefined;
  }

  const firstSlashIndex = normalizedPath.indexOf("/");
  const projectName =
    firstSlashIndex === -1 ? normalizedPath : normalizedPath.slice(0, firstSlashIndex).trim();
  if (!projectName) {
    return undefined;
  }

  const project = projects.find((candidate) => candidate.projectName === projectName);
  if (!project?.projectPath) {
    return undefined;
  }

  // No trim: the repo-relative remainder is a git file path whose edge whitespace
  // is significant.
  const repoRelativePath =
    firstSlashIndex === -1 ? undefined : normalizedPath.slice(firstSlashIndex + 1) || undefined;

  return {
    normalizedPath,
    repoRelativePath,
    projectPath: project.projectPath,
  };
}

function resolveProjectNameForRepoRoot(
  workspaceMetadata: Pick<FrontendWorkspaceMetadata, "projects"> | null | undefined,
  repoRootProjectPath?: string | null
): string | undefined {
  const projects = workspaceMetadata?.projects;
  const normalizedRepoRootProjectPath = normalizePath(repoRootProjectPath);
  if (!projects || projects.length < 2 || !normalizedRepoRootProjectPath) {
    return undefined;
  }

  return projects.find((candidate) =>
    matchesRepoRootProjectPath(candidate.projectPath, normalizedRepoRootProjectPath)
  )?.projectName;
}

/**
 * Resolve the owning project for a workspace-relative path when a multi-project workspace exposes
 * each repo under a top-level project-name directory inside the shared container root.
 */
export function resolveRepoRootProjectPath(
  workspaceMetadata: Pick<FrontendWorkspaceMetadata, "projects"> | null | undefined,
  workspaceRelativePath: string | null | undefined
): string | undefined {
  return resolveWorkspaceRelativeProjectMatch(workspaceMetadata, workspaceRelativePath)
    ?.projectPath;
}

/**
 * Repo-root git commands must strip any top-level sibling-project prefix once execution switches to
 * that repo checkout, otherwise git pathspecs like `project-b/src/file.ts` miss files under `src/`.
 */
export function normalizeRepoRootFilePath(
  workspaceMetadata: Pick<FrontendWorkspaceMetadata, "projects"> | null | undefined,
  workspaceRelativePath: string | null | undefined,
  repoRootProjectPath?: string | null
): string {
  const normalizedRepoRootProjectPath = normalizePath(repoRootProjectPath);
  const match = resolveWorkspaceRelativeProjectMatch(workspaceMetadata, workspaceRelativePath);
  if (!normalizedRepoRootProjectPath || !match) {
    return normalizeFilePath(workspaceRelativePath);
  }

  return matchesRepoRootProjectPath(match.projectPath, normalizedRepoRootProjectPath)
    ? (match.repoRelativePath ?? ".")
    : match.normalizedPath;
}

/**
 * Repo-root git output must be projected back onto the shared container root before downstream plain
 * reads use it, otherwise paths like `src/file.ts` miss sibling-project files that live under
 * `project-b/src/file.ts` in multi-project workspaces.
 */
export function reprojectRepoRootFilePath(
  workspaceMetadata: Pick<FrontendWorkspaceMetadata, "projects"> | null | undefined,
  repoRelativePath: string | null | undefined,
  repoRootProjectPath?: string | null
): string {
  const normalizedPath = normalizeFilePath(repoRelativePath);
  const normalizedRepoRootProjectPath = normalizePath(repoRootProjectPath);
  const projectName = resolveProjectNameForRepoRoot(
    workspaceMetadata,
    normalizedRepoRootProjectPath
  );
  if (!normalizedPath || !projectName) {
    return normalizedPath;
  }

  const workspaceRelativeMatch = resolveWorkspaceRelativeProjectMatch(
    workspaceMetadata,
    normalizedPath
  );
  if (
    workspaceRelativeMatch &&
    matchesRepoRootProjectPath(workspaceRelativeMatch.projectPath, normalizedRepoRootProjectPath)
  ) {
    return normalizedPath;
  }

  return `${projectName}/${normalizedPath}`;
}

/**
 * Repo-context scripts must opt into repo-root execution so multi-project workspaces can keep
 * default script mode on the shared container root without regressing git/file viewers.
 * Path-targeted callers can also point repo-root execution at the owning project checkout.
 */
export function repoRootBashOptions(
  timeout_secs?: number,
  repoRootProjectPath?: string | null
): {
  timeout_secs?: number;
  cwdMode: "repo-root";
  repoRootProjectPath?: string;
} {
  const options =
    timeout_secs == null
      ? { cwdMode: "repo-root" as const }
      : { timeout_secs, cwdMode: "repo-root" as const };
  const normalizedProjectPath = normalizePath(repoRootProjectPath);
  return normalizedProjectPath
    ? { ...options, repoRootProjectPath: normalizedProjectPath }
    : options;
}

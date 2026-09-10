import type { ProjectConfig } from "@/common/types/project";
import { PlatformPaths } from "@/common/utils/paths";

export function normalizeForDescendantComparison(value: string): string {
  const normalizedSeparators = value.replace(/\\/g, "/");
  const isWindowsPath =
    /^[a-z]:(?:\/|$)/i.test(normalizedSeparators) || normalizedSeparators.startsWith("//");
  const normalized = normalizedSeparators.replace(/\/+$/, "");
  // Windows paths are case-insensitive, and user input / persisted config can
  // differ in segment casing. Detect the platform form before trimming a drive
  // root separator so `C:/` and the dirname result `C:` stay equivalent.
  return isWindowsPath ? normalized.toLowerCase() : normalized;
}

export function isPathDescendant(parentPath: string, candidatePath: string): boolean {
  const parent = normalizeForDescendantComparison(parentPath);
  const candidate = normalizeForDescendantComparison(candidatePath);
  return candidate.startsWith(`${parent}/`) && candidate.length > parent.length + 1;
}

function getTopLevelAncestorProjectPath(
  projectPath: string,
  projectPaths: Iterable<string>
): string | null {
  let topLevelAncestorPath: string | null = null;
  for (const candidatePath of projectPaths) {
    if (!isPathDescendant(candidatePath, projectPath)) {
      continue;
    }

    if (topLevelAncestorPath === null || candidatePath.length < topLevelAncestorPath.length) {
      topLevelAncestorPath = candidatePath;
    }
  }

  return topLevelAncestorPath;
}

export function deriveProjectHierarchy(
  projects: Map<string, ProjectConfig>
): Map<string, ProjectConfig> {
  const next = new Map<string, ProjectConfig>();
  for (const [projectPath, projectConfig] of projects) {
    next.set(projectPath, {
      ...projectConfig,
      parentProjectPath: getTopLevelAncestorProjectPath(projectPath, projects.keys()) ?? undefined,
    });
  }

  return next;
}

export function getTopLevelProjectEntries(
  projects: Map<string, ProjectConfig>
): Array<[string, ProjectConfig]> {
  return Array.from(projects.entries()).filter(
    ([, projectConfig]) => !projectConfig.parentProjectPath
  );
}

export function getFirstTopLevelProjectPath(projects: Map<string, ProjectConfig>): string | null {
  for (const [projectPath, projectConfig] of projects) {
    if (!projectConfig.parentProjectPath) {
      return projectPath;
    }
  }
  return null;
}

export interface WorkspaceCreationScope {
  projectPath: string;
  subProjectPath: string | null;
}

export function resolveWorkspaceCreationScope(
  projectPath: string,
  projects: Map<string, ProjectConfig>,
  subProjectPath?: string | null
): WorkspaceCreationScope {
  const requestedProjectConfig = projects.get(projectPath);
  const owningProjectPath = requestedProjectConfig?.parentProjectPath ?? projectPath;
  const requestedSubProjectPath = requestedProjectConfig?.parentProjectPath
    ? projectPath
    : (subProjectPath ?? null);
  const requestedSubProjectConfig = requestedSubProjectPath
    ? projects.get(requestedSubProjectPath)
    : undefined;
  const normalizedSubProjectPath =
    requestedSubProjectConfig?.parentProjectPath === owningProjectPath
      ? requestedSubProjectPath
      : null;

  return {
    projectPath: owningProjectPath,
    subProjectPath: normalizedSubProjectPath,
  };
}

export function getSubProjectsForParent(
  parentProjectPath: string,
  projects: Map<string, ProjectConfig>
): Array<[string, ProjectConfig]> {
  return Array.from(projects.entries())
    .filter(([, projectConfig]) => projectConfig.parentProjectPath === parentProjectPath)
    .sort((left, right) =>
      getProjectDisplayName(left[0], left[1]).localeCompare(
        getProjectDisplayName(right[0], right[1]),
        undefined,
        { sensitivity: "base" }
      )
    );
}

export function getProjectDisplayName(projectPath: string, projectConfig?: ProjectConfig): string {
  const displayName = projectConfig?.displayName?.trim();
  return displayName && displayName.length > 0
    ? displayName
    : PlatformPaths.getProjectName(projectPath);
}

export function formatProjectHierarchyLabel(
  projectPath: string,
  projects: Map<string, ProjectConfig>
): string {
  const projectConfig = projects.get(projectPath);
  const parentProjectPath = projectConfig?.parentProjectPath;
  const projectName = getProjectDisplayName(projectPath, projectConfig);
  if (!parentProjectPath) {
    return projectName;
  }
  return `${getProjectDisplayName(parentProjectPath, projects.get(parentProjectPath))} / ${projectName}`;
}

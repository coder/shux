/**
 * Validates workspace name format
 * - Must be 1-64 characters long
 * - Can only contain: lowercase letters, digits, underscore, hyphen
 * - Pattern: [a-z0-9_-]{1,64}
 */
export function validateWorkspaceName(name: string): { valid: boolean; error?: string } {
  if (!name || name.length === 0) {
    return { valid: false, error: "Workspace name cannot be empty" };
  }

  if (name.length > 64) {
    return { valid: false, error: "Workspace name cannot exceed 64 characters" };
  }

  const validPattern = /^[a-z0-9_-]+$/;
  if (!validPattern.test(name)) {
    return {
      valid: false,
      // Workspace names become folder names, git branches, and session directories,
      // so they need to be filesystem-safe across platforms.
      error:
        "Workspace names can only contain lowercase letters, numbers, hyphens, and underscores",
    };
  }

  return { valid: true };
}

export function validateWorkspaceBranchName(name: string): { valid: boolean; error?: string } {
  if (!name || name.length === 0) {
    return { valid: false, error: "Branch name cannot be empty" };
  }

  if (name.length > 64) {
    return { valid: false, error: "Branch name cannot exceed 64 characters" };
  }

  const validPattern = /^[a-z0-9_-]+(?:\/[a-z0-9_-]+)*$/;
  if (!validPattern.test(name)) {
    return {
      valid: false,
      error:
        'Branch names can only contain lowercase letters, numbers, hyphens, underscores, and "/" separators',
    };
  }

  return { valid: true };
}

/** Valid branch names sanitize to valid workspace names without changing their length. */
export function sanitizeBranchNameForWorkspace(branchName: string): string {
  return branchName.replaceAll("/", "-");
}

export function formatBranchWorkspaceNameConflict(branchName: string): string {
  const workspaceName = sanitizeBranchNameForWorkspace(branchName);
  return `Branch "${branchName}" maps to workspace name "${workspaceName}", which conflicts with an existing workspace. Choose a different branch name.`;
}

export function getBranchWorkspaceNameConflict(
  branchName: string,
  existingWorkspaceNames: Iterable<string | undefined>
): string | undefined {
  const workspaceName = sanitizeBranchNameForWorkspace(branchName);
  if (branchName === workspaceName) {
    return undefined;
  }

  for (const existingName of existingWorkspaceNames) {
    if (existingName === workspaceName) {
      return formatBranchWorkspaceNameConflict(branchName);
    }
  }

  return undefined;
}

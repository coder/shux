import {
  shouldDeleteWorktreeOnArchive,
  type WorktreeArchiveBehavior,
} from "@/common/config/worktreeArchiveBehavior";
import type { FrontendWorkspaceMetadata, WorkspaceMetadata } from "@/common/types/workspace";
import { Ok, type Result } from "@/common/types/result";
import { isWorktreeRuntime as isCommonWorktreeRuntime } from "@/common/types/runtime";
import type { AfterArchiveHook } from "@/node/services/workspaceLifecycleHooks";
import { log } from "@/node/services/log";
import { removeManagedGitWorktree } from "@/node/worktree/removeManagedGitWorktree";

function hasNamedWorkspacePath(
  workspaceMetadata: WorkspaceMetadata
): workspaceMetadata is FrontendWorkspaceMetadata {
  return typeof (workspaceMetadata as FrontendWorkspaceMetadata).namedWorkspacePath === "string";
}

export const isWorktreeRuntime = isCommonWorktreeRuntime;

export function createWorktreeArchiveHook(options: {
  getWorktreeArchiveBehavior: () => WorktreeArchiveBehavior;
}): AfterArchiveHook {
  return async ({ workspaceMetadata, worktreeArchiveBehavior }): Promise<Result<void>> => {
    const runtimeConfig = workspaceMetadata.runtimeConfig;
    if (!isWorktreeRuntime(runtimeConfig)) {
      return Ok(undefined);
    }

    // isolation:none tasks point at an ancestor's checkout, so treating their path as a managed
    // child worktree would delete the parent's live workspace.
    if (workspaceMetadata.taskIsolation === "none") {
      return Ok(undefined);
    }

    // Prefer the archive operation's behavior snapshot: deciding deletion on a fresh config
    // read would let a keep→delete settings flip mid-archive delete a checkout that was never
    // snapshotted (the snapshot decision was made with the earlier value).
    const behavior = worktreeArchiveBehavior ?? options.getWorktreeArchiveBehavior();
    if (!shouldDeleteWorktreeOnArchive(behavior)) {
      return Ok(undefined);
    }

    if (
      behavior === "snapshot" &&
      Array.isArray(workspaceMetadata.projects) &&
      workspaceMetadata.projects.length > 1
    ) {
      log.debug("Skipping snapshot worktree cleanup for multi-project archive", {
        workspaceId: workspaceMetadata.id,
      });
      return Ok(undefined);
    }

    if (!hasNamedWorkspacePath(workspaceMetadata)) {
      log.debug(
        "Skipping managed worktree cleanup during archive because persisted path is missing",
        {
          workspaceId: workspaceMetadata.id,
        }
      );
      return Ok(undefined);
    }

    const managedPath = workspaceMetadata.namedWorkspacePath;

    try {
      // Use the persisted workspace path so archive cleanup also works for layouts like _workspaces.
      // Archive should stay non-blocking even if managed worktree cleanup fails.
      await removeManagedGitWorktree(workspaceMetadata.projectPath, managedPath);
    } catch (error) {
      log.debug("Failed to delete managed worktree during archive", {
        managedPath,
        error,
      });
    }

    return Ok(undefined);
  };
}

import type { CoderWorkspaceArchiveBehavior } from "@/common/config/coderArchiveBehavior";
import type { WorkspaceMetadata } from "@/common/types/workspace";
import type { WorktreeArchiveBehavior } from "@/common/config/worktreeArchiveBehavior";
import type { Result } from "@/common/types/result";
import { Ok, Err } from "@/common/types/result";
import { log } from "@/node/services/log";
import { getErrorMessage } from "@/common/utils/errors";

export interface BeforeArchiveHookArgs {
  workspaceId: string;
  workspaceMetadata: WorkspaceMetadata;
  /**
   * Coder archive-policy snapshot taken by the archive operation when it enforced its
   * remote-deletion guard. Hooks that stop/delete Coder workspaces must use this value (not a
   * fresh config read) so a concurrent settings flip cannot delete a remote workspace past a
   * caller that forbade it.
   */
  coderWorkspaceArchiveBehavior?: CoderWorkspaceArchiveBehavior;
  /**
   * Set by model-driven archives: a hook that would stop a running remote environment must
   * first verify that no detached background job survives on it (remote spawn records are
   * invisible to the host-local crash-orphan scans), failing closed when the probe cannot
   * prove absence. User-mediated archives leave this unset — they are the documented escape
   * hatch for over-refusals.
   */
  refuseStopUnderUnverifiedRemoteJobs?: boolean;
}

export type BeforeArchiveHook = (args: BeforeArchiveHookArgs) => Promise<Result<void>>;

export interface AfterArchiveHookArgs {
  workspaceId: string;
  workspaceMetadata: WorkspaceMetadata;
  /**
   * Behavior snapshot taken by the archive operation when it decided whether to capture a
   * worktree snapshot. Hooks that delete checkouts must use this value (not a fresh config
   * read) so a concurrent settings flip cannot delete a checkout that was never snapshotted.
   */
  worktreeArchiveBehavior?: WorktreeArchiveBehavior;
}

export type AfterArchiveHook = (args: AfterArchiveHookArgs) => Promise<Result<void>>;

export interface AfterUnarchiveHookArgs {
  workspaceId: string;
  workspaceMetadata: WorkspaceMetadata;
}

export type AfterUnarchiveHook = (args: AfterUnarchiveHookArgs) => Promise<Result<void>>;

function sanitizeErrorMessage(error: unknown): string {
  const raw = getErrorMessage(error);
  // Keep single-line, capped error messages to avoid leaking stack traces or long CLI output.
  const singleLine = raw.split("\n")[0]?.trim() ?? "";
  return singleLine.slice(0, 200) || "Unknown error";
}

/**
 * Backend registry for workspace lifecycle hooks.
 *
 * Hooks run in-process (sequentially).
 * - beforeArchive hooks may block the operation if they return Err.
 * - afterArchive hooks are best-effort and never block archive.
 * - afterUnarchive hooks are best-effort and never block unarchive.
 */
export class WorkspaceLifecycleHooks {
  private readonly beforeArchiveHooks: BeforeArchiveHook[] = [];
  private readonly afterArchiveHooks: AfterArchiveHook[] = [];
  private readonly afterUnarchiveHooks: AfterUnarchiveHook[] = [];

  registerBeforeArchive(hook: BeforeArchiveHook): void {
    this.beforeArchiveHooks.push(hook);
  }

  registerAfterArchive(hook: AfterArchiveHook): void {
    this.afterArchiveHooks.push(hook);
  }

  registerAfterUnarchive(hook: AfterUnarchiveHook): void {
    this.afterUnarchiveHooks.push(hook);
  }

  async runBeforeArchive(args: BeforeArchiveHookArgs): Promise<Result<void>> {
    for (const hook of this.beforeArchiveHooks) {
      try {
        const result = await hook(args);
        if (!result.success) {
          return Err(sanitizeErrorMessage(result.error));
        }
      } catch (error) {
        return Err(`beforeArchive hook threw: ${sanitizeErrorMessage(error)}`);
      }
    }

    return Ok(undefined);
  }

  async runAfterArchive(args: AfterArchiveHookArgs): Promise<void> {
    for (const hook of this.afterArchiveHooks) {
      try {
        const result = await hook(args);
        if (!result.success) {
          log.debug("afterArchive hook failed", {
            workspaceId: args.workspaceId,
            error: sanitizeErrorMessage(result.error),
          });
        }
      } catch (error) {
        log.debug("afterArchive hook threw", {
          workspaceId: args.workspaceId,
          error: sanitizeErrorMessage(error),
        });
      }
    }
  }

  async runAfterUnarchive(args: AfterUnarchiveHookArgs): Promise<void> {
    for (const hook of this.afterUnarchiveHooks) {
      try {
        const result = await hook(args);
        if (!result.success) {
          log.debug("afterUnarchive hook failed", {
            workspaceId: args.workspaceId,
            error: sanitizeErrorMessage(result.error),
          });
        }
      } catch (error) {
        log.debug("afterUnarchive hook threw", {
          workspaceId: args.workspaceId,
          error: sanitizeErrorMessage(error),
        });
      }
    }
  }
}

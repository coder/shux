import type { RuntimeConfig } from "@/common/types/runtime";

/**
 * Default runtime configuration for worktree workspaces.
 * Uses git worktrees for workspace isolation.
 * Used when no runtime config is specified.
 */
export const DEFAULT_RUNTIME_CONFIG: RuntimeConfig = {
  type: "worktree",
  srcBaseDir: "~/.xum/src",
} as const;

/**
 * Returned by `workspace.interruptStream` for a user Stop whose stream did stop but whose startup
 * abandon marker or monitor-attention retirement could not be written.
 */
export const STOP_UNRECORDED_MESSAGE =
  "Stop could not be recorded on disk, so the stopped work may resume on restart.";

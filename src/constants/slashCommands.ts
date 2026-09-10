/**
 * Slash command constants shared between suggestion filtering and command execution.
 */

/**
 * Command keys that only work in workspace context (not during creation).
 * These correspond to top-level slash command keys in the registry.
 */
export const WORKSPACE_ONLY_COMMAND_KEYS: ReadonlySet<string> = new Set([
  "clear",
  "compact",
  "dream",
  "refine",
  "fork",
  "new",
  "plan",
  "heartbeat",
]);

/**
 * Parsed command types that require an existing workspace context.
 * The literal union lets chatCommands narrow ParsedCommand with a type guard
 * so its dispatch switch stays compiler-checked exhaustive.
 */
export const WORKSPACE_ONLY_COMMAND_TYPE_LIST = [
  "clear",
  "compact",
  "dream",
  "refine",
  "fork",
  "new",
  "plan-show",
  "plan-open",
  "heartbeat-set",
  "goal-show",
  "goal-set",
  "goal-budget",
  "goal-pause",
  "goal-resume",
  "goal-complete",
  "goal-clear",
  "workflow-run",
] as const;

export type WorkspaceOnlyCommandType = (typeof WORKSPACE_ONLY_COMMAND_TYPE_LIST)[number];

// Typed as ReadonlySet<string> so callers can probe arbitrary command types.
export const WORKSPACE_ONLY_COMMAND_TYPES: ReadonlySet<string> = new Set(
  WORKSPACE_ONLY_COMMAND_TYPE_LIST
);

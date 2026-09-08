import { z } from "zod";
import { ThinkingLevelSchema } from "../../types/thinking";
import { RuntimeConfigSchema } from "./runtime";
import { WorkspaceAISettingsByAgentSchema, WorkspaceAISettingsSchema } from "./workspaceAiSettings";
import { GoalSnapshotSchema } from "./goal";
import {
  HEARTBEAT_CONTEXT_MODE_VALUES,
  HEARTBEAT_MAX_INTERVAL_MS,
  HEARTBEAT_MIN_INTERVAL_MS,
  HEARTBEAT_TRIGGER_VALUES,
  HEARTBEAT_WHEN_BUSY_VALUES,
} from "@/constants/heartbeat";

export const ProjectRefSchema = z.object({
  projectPath: z.string().meta({ description: "Absolute path to the project's main git repo" }),
  projectName: z
    .string()
    .meta({ description: "Display name for the project (typically derived from projectPath)" }),
});

export const BestOfGroupSchema = z.object({
  groupId: z.string().meta({
    description:
      "Stable identifier shared by sibling task workspaces spawned from the same grouped task request.",
  }),
  index: z.number().int().min(0).meta({
    description: "Zero-based sibling index within the grouped task request.",
  }),
  total: z.number().int().min(2).meta({
    description: "Total number of sibling tasks spawned in the grouped task request.",
  }),
});

/**
 * Sparse per-workspace override of the global `goalDefaults` block.
 *
 * Each field is independently nullable so a workspace can override (e.g.)
 * the default budget without also pinning the turn cap. A `null` value
 * means "follow the global default"; an explicit value means "use this
 * value for new goals in this workspace". A workspace with all three
 * fields null is semantically identical to no override at all — the
 * backend should drop the entire object in that case to keep
 * `~/.xum/config.json` tidy.
 *
 * Mirrors the heartbeat pattern (per-workspace override of a global
 * default, persisted inside `WorkspaceConfigSchema`) so the
 * frontend-visible metadata stream picks it up automatically.
 */
export const WorkspaceGoalDefaultsOverrideSchema = z.object({
  defaultBudgetCents: z.number().int().nonnegative().nullable().meta({
    description:
      "Per-workspace override for `goalDefaults.defaultBudgetCents`. `null` follows the global default.",
  }),
  defaultTurnCap: z.number().int().positive().nullable().meta({
    description:
      "Per-workspace override for `goalDefaults.defaultTurnCap`. `null` follows the global default (which itself may be null = no cap).",
  }),
  alwaysRequireExplicitBudget: z.boolean().nullable().meta({
    description:
      "Per-workspace override for `goalDefaults.alwaysRequireExplicitBudget`. `null` follows the global default.",
  }),
});

export const HeartbeatContextModeSchema = z.enum(HEARTBEAT_CONTEXT_MODE_VALUES);
export const HeartbeatTriggerSchema = z.enum(HEARTBEAT_TRIGGER_VALUES);
export const HeartbeatWhenBusySchema = z.enum(HEARTBEAT_WHEN_BUSY_VALUES);

export const WorkspaceHeartbeatSettingsSchema = z.object({
  enabled: z.boolean().meta({
    description: "Whether scheduled workspace heartbeats are enabled for this workspace.",
  }),
  intervalMs: z.number().int().min(HEARTBEAT_MIN_INTERVAL_MS).max(HEARTBEAT_MAX_INTERVAL_MS).meta({
    description: "Heartbeat interval in milliseconds for this workspace.",
  }),
  message: z.string().optional().meta({
    description:
      "Optional custom instruction body appended after the fixed workspace heartbeat lead-in.",
  }),
  contextMode: HeartbeatContextModeSchema.nullish().meta({
    description:
      'Whether heartbeats use the existing context ("normal"), perform a real compaction first ("compact"), or append a synthetic reset boundary first ("reset"). Missing values default to "normal" at read time for backward compatibility.',
  }),
  // No Zod .default() on trigger/whenBusy: defaults resolve at read time via
  // resolveHeartbeatSchedulePolicy (src/constants/heartbeat.ts) because the whenBusy default is
  // conditional on the resolved trigger and strict-mode tool providers send explicit null.
  trigger: HeartbeatTriggerSchema.nullish().meta({
    description:
      'How the heartbeat countdown is anchored: "idle" resets on workspace activity (fires only after a full quiet interval), "interval" is a fixed wall-clock cadence. Missing/null values default to "idle" at read time.',
  }),
  whenBusy: HeartbeatWhenBusySchema.nullish().meta({
    description:
      'What happens when a heartbeat fires while the workspace is busy: "skip" misses the slot, "tool-end" queues the heartbeat for the next tool boundary in the current turn, "turn-end" queues it as its own turn after the current one. Missing/null values default at read time to "skip" for the "idle" trigger and "turn-end" for the "interval" trigger.',
  }),
  // Server-managed (never a client input): stamped by setHeartbeatSettings when a
  // cadence-affecting field (enabled/intervalMs/resolved trigger) changes. Fixed-interval
  // restart anchoring uses max(last persisted firing, this) so a schedule edit is not
  // bypassed by a heartbeat that fired under the previous schedule.
  scheduleUpdatedAt: z.number().int().nonnegative().nullish().meta({
    description:
      "Timestamp (epoch ms) of the last cadence-affecting heartbeat settings edit. Server-managed.",
  }),
});

// Single source of truth for workflow task metadata on both persisted config
// entries (src/common/schemas/project.ts) and workspace metadata IPC. The runId
// stays a loose non-empty string (not WorkflowRunIdSchema) so a malformed
// persisted entry can never brick config/metadata parsing (self-healing rule).
export const WorkflowTaskMetadataSchema = z.object({
  runId: z.string().min(1).meta({ description: "Workflow run that spawned this task." }),
  stepId: z.string().min(1).meta({ description: "Workflow step that spawned this task." }),
  workflowName: z.string().min(1).optional().meta({
    description:
      "Human-readable workflow display name stamped at spawn time for sidebar grouping. Optional: absent on tasks created before this field existed.",
  }),
  outputSchema: z.unknown().optional().meta({
    description: "Optional JSON Schema subset required for this task's structured output.",
  }),
});

export const WorkspaceMetadataSchema = z.object({
  kind: z.literal("scratch").optional().meta({
    description: "Marks an app-owned project-less scratch chat workspace.",
  }),
  id: z.string().meta({
    description:
      "Stable unique identifier (10 hex chars for new workspaces, legacy format for old)",
  }),
  name: z.string().meta({
    description: 'Git branch / directory name (e.g., "plan-a1b2") - used for path computation',
  }),
  title: z.string().optional().meta({
    description:
      'Human-readable workspace title (e.g., "Fix plan mode over SSH") - optional for legacy workspaces',
  }),
  pendingAutoTitle: z.boolean().optional().meta({
    description:
      "True when a forked workspace is waiting to generate a title from its first accepted continue message.",
  }),
  forkFamilyBaseName: z.string().optional().meta({
    description:
      "Stable base workspace name used to continue auto-generated fork numbering without relying on title heuristics.",
  }),
  projectName: z
    .string()
    .meta({ description: "Project name extracted from project path (for display)" }),
  projectPath: z
    .string()
    .meta({ description: "Absolute path to the project (needed to compute workspace path)" }),
  createdAt: z.string().optional().meta({
    description:
      "ISO 8601 timestamp of when workspace was created (optional for backward compatibility)",
  }),
  aiSettingsByAgent: WorkspaceAISettingsByAgentSchema.optional().meta({
    description: "Per-agent AI settings persisted in config",
  }),
  runtimeConfig: RuntimeConfigSchema.meta({
    description: "Runtime configuration for this workspace (always set, defaults to local on load)",
  }),
  aiSettings: WorkspaceAISettingsSchema.optional().meta({
    description: "Workspace-scoped AI settings (model + thinking level) persisted in config",
  }),
  heartbeat: WorkspaceHeartbeatSettingsSchema.optional().meta({
    description: "Persisted heartbeat settings for this workspace.",
  }),
  goalDefaults: WorkspaceGoalDefaultsOverrideSchema.optional().meta({
    description:
      "Per-workspace overrides for goal creation defaults (budget, turn cap, explicit-budget). Layered on top of the global `goalDefaults` from app config.",
  }),
  parentWorkspaceId: z.string().optional().meta({
    description:
      "If set, this workspace is a child workspace spawned from the parent workspaceId (enables nesting in UI and backend orchestration).",
  }),
  agentType: z.string().optional().meta({
    description: 'If set, selects an agent preset for this workspace (e.g., "explore" or "exec").',
  }),
  agentId: z.string().optional().meta({
    description:
      'If set, selects an agent definition for this workspace (e.g., "explore" or "exec").',
  }),
  tags: z
    .record(z.string(), z.string())
    .optional()
    .meta({
      description:
        "Programmatic key/value tags (e.g. workItemKey) set via API/CLI/workflows; " +
        "not rendered in the UI. Stable identity for orchestration loops, unlike title/name.",
    }),
  workflowTask: WorkflowTaskMetadataSchema.optional().meta({
    description: "Workflow run/step metadata for workflow-spawned child tasks.",
  }),
  bestOf: BestOfGroupSchema.optional().meta({
    description: "Grouping metadata for child tasks spawned from the same parent tool call.",
  }),
  taskStatus: z
    .enum(["queued", "starting", "running", "awaiting_report", "interrupted", "reported"])
    .optional()
    .meta({
      description:
        "Agent task lifecycle status for child workspaces (queued|starting|running|awaiting_report|interrupted|reported).",
    }),
  taskPendingGuidance: z
    .array(
      z.object({
        id: z.string().min(1),
        message: z.string().min(1),
        queueDispatchMode: z.enum(["tool-end", "turn-end"]),
      })
    )
    .optional()
    .meta({
      description:
        "Parent guidance queued for replacement task turns but not yet accepted into chat history.",
    }),
  taskLaunchError: z.string().optional().meta({
    description: "Startup failure recorded before an agent task could begin streaming.",
  }),
  reportedAt: z.string().optional().meta({
    description: "ISO 8601 timestamp for when an agent task reported completion (optional).",
  }),
  taskModelString: z.string().optional().meta({
    description: "Model string used to run this agent task (used for restart-safe resumptions).",
  }),
  taskThinkingLevel: ThinkingLevelSchema.optional().meta({
    description: "Thinking level used for this agent task (used for restart-safe resumptions).",
  }),
  taskPrompt: z.string().optional().meta({
    description:
      "Initial prompt for a queued agent task (persisted only until the task actually starts).",
  }),
  taskBaseCommitSha: z.string().optional().meta({
    description:
      "Git commit SHA this agent task workspace started from (used for generating git-format-patch artifacts).",
  }),
  taskBaseCommitShaByProjectPath: z.record(z.string(), z.string()).optional().meta({
    description:
      "Per-project git HEAD SHAs captured when an agent task workspace starts (used for multi-project git-format-patch artifacts).",
  }),
  taskTrunkBranch: z.string().optional().meta({
    description:
      "Trunk branch used to create/init this agent task workspace (used for restart-safe init on queued tasks).",
  }),
  // Delegation changes the operator, not the computer; checkout isolation is independent.
  taskDesktopOwnerWorkspaceId: z.string().optional().meta({
    description:
      "Ancestor owning the shared desktop. Absent means this workspace owns its desktop.",
  }),
  taskIsolation: z.enum(["fork", "none"]).optional().meta({
    description:
      'Workspace isolation for an agent task. "none" shares an ancestor checkout and must never be treated as an independently managed worktree.',
  }),
  taskSticky: z.boolean().optional().meta({
    description: "Legacy ignored retention marker kept for on-disk downgrade compatibility.",
  }),
  taskExecutionId: z.string().optional().meta({
    description: "Latest internal execution handle for a reawakened persistent sub-agent.",
  }),
  taskExecutionStatus: z
    .enum(["queued", "starting", "running", "completed", "interrupted", "error"])
    .optional()
    .meta({ description: "Status of the latest internal reawakened sub-agent execution." }),
  archivedAt: z.string().optional().meta({
    description:
      "ISO 8601 timestamp when workspace was last archived. Workspace is considered archived if archivedAt > unarchivedAt (or unarchivedAt is absent).",
  }),
  unarchivedAt: z.string().optional().meta({
    description:
      "ISO 8601 timestamp when workspace was last unarchived. Used for recency calculation to bump restored workspaces to top.",
  }),
  pinnedAt: z.string().optional().meta({
    description:
      "ISO 8601 pin ordering key (not a reliable 'when pinned' record: reorderPinned re-deals existing values). Pinned workspaces sort to the top of their project in pinnedAt order (ascending). Cleared on archive.",
  }),
  projects: z
    .array(ProjectRefSchema)
    .optional()
    .meta({
      description:
        "For multi-project workspaces: list of included projects. " +
        "When >1 entry, this is a multi-project workspace. " +
        "projectPath/projectName reflect the primary project for backcompat.",
    }),
  subProjectPath: z.string().optional().meta({
    description:
      "Sub-project path that provides cwd and AGENTS.md context while sharing the parent project's worktree.",
  }),
});

export const FrontendWorkspaceMetadataSchema = WorkspaceMetadataSchema.extend({
  rootWorkspaceId: z.string().optional().meta({
    description: "Task-family root derived from complete metadata, including archived ancestors.",
  }),
  namedWorkspacePath: z
    .string()
    .meta({ description: "Worktree path (uses workspace name as directory)" }),
  incompatibleRuntime: z.string().optional().meta({
    description:
      "If set, this workspace has an incompatible runtime configuration (e.g., from a newer version of Xum). The workspace should be displayed but interactions should show this error message.",
  }),
  isRemoving: z.boolean().optional().meta({
    description: "True if this workspace is currently being deleted (deletion in progress).",
  }),
  isInitializing: z.boolean().optional().meta({
    description:
      "True if this workspace is currently initializing (postCreateSetup or initWorkspace running).",
  }),
  transcriptOnly: z.boolean().optional().meta({
    description:
      "True if this workspace's checkout directory is missing (worktree deleted). Chat history is available but the workspace cannot run commands.",
  }),
});

export const WorkspaceAgentStatusSchema = z.object({
  emoji: z.string(),
  message: z.string(),
  url: z.string().optional(),
});

export const WorkspaceActivitySnapshotSchema = z.object({
  recency: z.number().meta({ description: "Unix ms timestamp of last user interaction" }),
  streaming: z.boolean().meta({ description: "Whether workspace currently has an active stream" }),
  streamingGeneration: z.number().optional().meta({
    description: "Monotonic stream generation counter for distinguishing newer background turns",
  }),
  lastModel: z.string().nullable().meta({ description: "Last model sent from this workspace" }),
  lastThinkingLevel: ThinkingLevelSchema.nullable().meta({
    description: "Last thinking/reasoning level used in this workspace",
  }),
  displayStatus: WorkspaceAgentStatusSchema.nullable().optional().meta({
    description:
      "Transient non-todo status for system-driven background progress (for example executor routing).",
  }),
  todoStatus: WorkspaceAgentStatusSchema.nullable().optional().meta({
    description:
      "Persistent sidebar status. Set by the small-model AgentStatusService when available, with a todo-derived fallback.",
  }),
  hasTodos: z.boolean().optional().meta({
    description: "Whether the workspace still had todos when streaming last stopped",
  }),
  isCompaction: z.boolean().optional().meta({
    description:
      "Whether the current streaming activity is a compaction turn (transient UI classification)",
  }),
  isIdleCompaction: z.boolean().optional().meta({
    description: "Whether the current streaming activity is an idle (background) compaction",
  }),
  activeWorkflowRunIds: z.array(z.string().min(1)).optional().meta({
    description:
      "IDs of top-level workflow runs in this workspace that are pending, running, or backgrounded.",
  }),
  activeWorkflowRunCount: z.number().int().nonnegative().optional().meta({
    description:
      "Number of top-level workflow runs in this workspace that are pending, running, or backgrounded.",
  }),
  activeBashMonitorCount: z
    .number()
    .int()
    .nonnegative()
    .optional()
    .meta({
      description:
        "Number of running background bash processes with an armed wake-on-match monitor. " +
        "Signals the workspace is still waiting to be woken even though no stream is active.",
    }),
  goal: GoalSnapshotSchema.nullable().optional().meta({
    description: "Current workspace goal snapshot for sidebar indicators and the Goal tab",
  }),
  transientGoalOnly: z.boolean().optional().meta({
    description:
      "Internal frontend hint: merge only the goal field from this activity event; do not replace persisted activity fields.",
  }),
});

export const GitStatusSchema = z.object({
  /** Current HEAD branch name (empty string if detached HEAD or not a git repo) */
  branch: z.string(),
  /** Commit divergence relative to origin's primary branch */
  ahead: z.number(),
  behind: z.number(),
  dirty: z
    .boolean()
    .meta({ description: "Whether there are uncommitted changes (staged or unstaged)" }),

  /**
   * Line deltas for changes unique to this workspace.
   * Computed vs the merge-base with origin's primary branch.
   *
   * Note: outgoing includes committed changes + uncommitted changes (working tree).
   */
  outgoingAdditions: z.number(),
  outgoingDeletions: z.number(),

  /** Line deltas for changes that exist on origin's primary branch but not locally */
  incomingAdditions: z.number(),
  incomingDeletions: z.number(),
});

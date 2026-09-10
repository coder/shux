import { RuntimeConfigSchema } from "@/common/orpc/schemas/runtime";
import { WorkspaceMCPOverridesSchema } from "@/common/orpc/schemas/mcp";
import {
  BestOfGroupSchema,
  ProjectRefSchema,
  WorkflowTaskMetadataSchema,
  WorkspaceGoalDefaultsOverrideSchema,
  WorkspaceHeartbeatSettingsSchema,
} from "@/common/orpc/schemas/workspace";
import {
  WorkspaceAISettingsByAgentSchema,
  WorkspaceAISettingsSchema,
} from "@/common/orpc/schemas/workspaceAiSettings";
import { ThinkingLevelSchema } from "@/common/types/thinking";
import { BackgroundWorkAttentionPolicySchema } from "@/common/types/backgroundWorkAttention";
import { z } from "zod";

import { RuntimeEnablementIdSchema } from "./ids";
import { RuntimeEnablementOverridesSchema } from "./runtimeEnablement";

export const WorktreeArchiveSnapshotProjectSchema = z.object({
  projectPath: z.string().meta({
    description: "Absolute path to the project repo that this archive snapshot entry restores.",
  }),
  projectName: z.string().meta({ description: "Display name for the project repo." }),
  storageKey: z.string().meta({
    description: "Filesystem-safe per-project storage key for archive artifacts.",
  }),
  branchName: z.string().meta({ description: "Workspace branch name captured for this project." }),
  trunkBranch: z
    .string()
    .meta({ description: "Trunk branch used to compute merge-base fallback." }),
  baseSha: z.string().meta({ description: "Commit used as the restore base for patch replay." }),
  headSha: z.string().meta({ description: "HEAD commit SHA captured at archive time." }),
  committedPatchPath: z.string().optional().meta({
    description: "Session-dir-relative path to the git-format-patch mailbox for committed history.",
  }),
  stagedPatchPath: z.string().optional().meta({
    description: "Session-dir-relative path to the staged tracked diff artifact.",
  }),
  unstagedPatchPath: z.string().optional().meta({
    description: "Session-dir-relative path to the unstaged tracked diff artifact.",
  }),
});

export const WorktreeArchiveSnapshotSchema = z.object({
  version: z.literal(1).meta({ description: "Snapshot metadata schema version." }),
  capturedAt: z
    .string()
    .meta({ description: "ISO 8601 timestamp when the snapshot was captured." }),
  stateDirPath: z.string().meta({
    description: "Session-dir-relative path to the directory that stores snapshot artifacts.",
  }),
  projects: z.array(WorktreeArchiveSnapshotProjectSchema).min(1).meta({
    description: "Per-project restore metadata for the archived workspace snapshot.",
  }),
});

export const WorkspaceConfigSchema = z.object({
  path: z.string().meta({
    description: "Absolute path to workspace directory - REQUIRED for backward compatibility",
  }),
  kind: z.literal("scratch").optional().meta({
    description: "Marks an app-owned project-less scratch chat workspace.",
  }),
  id: z.string().optional().meta({
    description: "Stable workspace ID (10 hex chars for new workspaces) - optional for legacy",
  }),
  name: z.string().optional().meta({
    description: 'Git branch / directory name (e.g., "plan-a1b2") - optional for legacy',
  }),
  title: z.string().optional().meta({
    description:
      'Human-readable workspace title (e.g., "Fix plan mode over SSH") - optional for legacy',
  }),
  pendingAutoTitle: z.boolean().optional().meta({
    description:
      "True when a forked workspace is waiting to generate a title from its first accepted continue message.",
  }),
  forkFamilyBaseName: z.string().optional().meta({
    description:
      "Stable base workspace name used to continue auto-generated fork numbering without relying on title heuristics.",
  }),
  createdAt: z
    .string()
    .optional()
    .meta({ description: "ISO 8601 creation timestamp - optional for legacy" }),
  aiSettingsByAgent: WorkspaceAISettingsByAgentSchema.optional().meta({
    description: "Per-agent workspace-scoped AI settings",
  }),
  runtimeConfig: RuntimeConfigSchema.optional().meta({
    description: "Runtime configuration (local vs SSH) - optional, defaults to local",
  }),
  aiSettings: WorkspaceAISettingsSchema.optional().meta({
    description: "Workspace-scoped AI settings (model + thinking level)",
  }),
  heartbeat: WorkspaceHeartbeatSettingsSchema.optional().meta({
    description: "Persisted heartbeat settings for this workspace.",
  }),
  goalDefaults: WorkspaceGoalDefaultsOverrideSchema.optional().meta({
    description:
      "Per-workspace overrides for goal creation defaults. Sparse; each null field follows the global `goalDefaults`.",
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
        "Parent guidance queued for replacement task turns but not yet accepted into chat history. Persisted for restart recovery and stale-report suppression.",
    }),
  taskLaunchError: z.string().optional().meta({
    description: "Startup failure recorded before an agent task could begin streaming.",
  }),
  taskTimeoutFinalizationTokens: z.array(z.string().min(1)).optional().meta({
    description:
      "Idempotency tokens for workflow timeout finalization prompts already sent to this task.",
  }),
  taskRecoveryAttempts: z.number().int().nonnegative().optional().meta({
    description:
      "Completion-tool recovery prompts sent to this agent task since it last completed successfully. Persisted (not in-memory) so crash/restart recovery loops stay bounded; cleared on a successful report, on plan-to-exec handoff, and on user-initiated resume.",
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
  taskOnRefusal: z.enum(["fail", "fallback"]).optional().meta({
    description:
      "Model-refusal policy for this agent task: 'fail' opts out of configured model-fallback chains so refusals settle terminally (e.g. workflow verifier steps). Default behavior is 'fallback'.",
  }),
  taskPrompt: z.string().optional().meta({
    description:
      "Initial prompt for a queued agent task (persisted only until the task actually starts).",
  }),
  taskExperiments: z
    .preprocess(
      // Legacy alias: tasks stamped by builds where "PTC Exclusive Mode" was a
      // separate experiment may carry only programmaticToolCallingExclusive.
      // The merged PTC experiment activates exactly that posture, so the flag
      // must map onto programmaticToolCalling on resumption instead of being
      // stripped (which would silently drop PTC and make rlm inert). `true`
      // wins over an explicit programmaticToolCalling: false because the old
      // exclusive flag activated the posture regardless of the supplement flag.
      (value) =>
        typeof value === "object" &&
        value !== null &&
        (value as Record<string, unknown>).programmaticToolCallingExclusive === true
          ? { ...value, programmaticToolCalling: true }
          : value,
      z.object({
        programmaticToolCalling: z.boolean().optional(),
        // Downgrade-compat mirror (see toPersistedTaskExperiments): retained
        // through parsing and stamped alongside programmaticToolCalling so a
        // downgraded build resumes the task in its exclusive posture instead
        // of reading bare PTC as the removed (~2x cost) supplement mode.
        programmaticToolCallingExclusive: z.boolean().optional(),
        // RLM mode is stamped at spawn so child sessions keep RLM-gated features
        // (persistent sandbox kernel, family messaging tools) across app restarts
        // without depending on live frontend experiment state.
        rlm: z.boolean().optional(),
        advisorTool: z.boolean().optional(),
        dynamicWorkflows: z.boolean().optional(),
      })
    )
    .optional()
    .meta({
      description: "Experiments inherited from parent for restart-safe resumptions.",
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
  taskIsolation: z
    .enum(["fork", "none"])
    .optional()
    .meta({
      description:
        'Workspace isolation for an agent task. "none" means the task shares its parent workspace\'s ' +
        "checkout (no fork): its `path` points at the parent's checkout, init is skipped, and removal " +
        'must not delete that shared directory. Absent/"fork" is the isolated default.',
    }),
  taskSticky: z
    .boolean()
    .optional()
    .meta({
      description:
        "Strong retention for an agent-task workspace. Ordinary user-spawned tasks persist after " +
        "reporting. This legacy field is ignored by modern task lifecycle logic and retained only " +
        "for downgrade compatibility.",
    }),
  taskExecutionId: z.string().optional().meta({
    description:
      "Latest internal execution handle for a persistent sub-agent reawakened through task_send_message.",
  }),
  taskExecutionStatus: z
    .enum(["queued", "starting", "running", "completed", "interrupted", "error"])
    .optional()
    .meta({ description: "Status of the latest internal reawakened sub-agent execution." }),
  taskAttentionPolicy: BackgroundWorkAttentionPolicySchema.optional().meta({
    description:
      "How the owner workspace's stream-end treats this child task while it is active. " +
      '"notify_on_terminal" (background launches) does not force the owner to await; ' +
      '"blocking_until_terminal" (foreground/default, and missing/legacy records) does.',
  }),
  mcp: WorkspaceMCPOverridesSchema.optional().meta({
    description:
      "LEGACY: Per-workspace MCP overrides (migrated to <workspace>/.xum/mcp.local.jsonc)",
  }),
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
  worktreeArchiveSnapshot: WorktreeArchiveSnapshotSchema.optional().meta({
    description:
      "Durable restore metadata captured before archive-time worktree deletion. Present only while an archived snapshot is awaiting restore.",
  }),
  projects: z.array(ProjectRefSchema).optional(),
  subProjectPath: z.string().optional().meta({
    description:
      "Sub-project path that provides cwd and AGENTS.md context while sharing the parent project's worktree.",
  }),
});

export const ProjectConfigSchema = z.object({
  displayName: z.string().nullish().meta({
    description: "Custom display name for the project",
  }),
  color: z.string().optional().meta({
    description: "Project folder accent color (hex value like #5a9bd4 or preset name)",
  }),
  /**
   * Parent project path when this project is a one-level sub-project. Parentage is
   * re-derived from registered paths during project load/list so stale persisted
   * values never become the source of truth.
   */
  parentProjectPath: z.string().optional().meta({
    description: "Absolute path to the top-level parent project for one-level sub-projects",
  }),
  workspaces: z.array(WorkspaceConfigSchema),
  idleCompactionHours: z.number().min(1).nullable().optional().meta({
    description:
      "Hours of inactivity before auto-compacting workspaces. null/undefined = disabled.",
  }),
  runtimeEnablement: RuntimeEnablementOverridesSchema.optional().meta({
    description: "Runtime enablement overrides (store `false` only to keep config.json minimal)",
  }),
  runtimeOverridesEnabled: z.boolean().optional().meta({
    description: "Whether this project uses runtime overrides, even if no overrides are set",
  }),
  defaultRuntime: RuntimeEnablementIdSchema.optional().meta({
    description: "Default runtime override for new workspaces in this project",
  }),
  projectKind: z.enum(["user", "system"]).optional().meta({
    description:
      "Project classification. System projects are hidden from user-facing project lists unless explicitly requested.",
  }),
  trusted: z.boolean().optional().meta({
    description:
      "Whether the user has confirmed trust for this project. Untrusted projects cannot run hooks or user scripts.",
  }),
  customInstructions: z.string().optional().meta({
    description:
      "Custom system prompt appended for every workspace in this project (Settings → Instructions)",
  }),
  codeWorkspaceSyncPath: z.string().optional().meta({
    description:
      "Path to a VS Code .code-workspace file kept in sync with this project's active worktrees (relative paths resolve against the project root). Unset = sync disabled.",
  }),
});

export type WorktreeArchiveSnapshotProject = z.infer<typeof WorktreeArchiveSnapshotProjectSchema>;
export type WorktreeArchiveSnapshot = z.infer<typeof WorktreeArchiveSnapshotSchema>;

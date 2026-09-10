/**
 * Shared type definitions for AI tools
 * These types are used by both the tool implementations and UI components
 */

import type { z } from "zod";
import type { AgentSkillDescriptor, AgentSkillFrontmatter } from "@/common/types/agentSkill";
import type {
  AgentReportToolResultSchema,
  AgentSkillReadFileToolResultSchema,
  MCPPromptGetToolResultSchema,
  AgentSkillReadToolResultSchema,
  AskUserQuestionQuestionSchema,
  AskUserQuestionToolResultSchema,
  BashBackgroundListResultSchema,
  BashBackgroundTerminateResultSchema,
  BashOutputToolResultSchema,
  BashToolResultSchema,
  FileEditInsertToolResultSchema,
  FileEditReplaceStringToolResultSchema,
  XumConfigReadToolResultSchema,
  XumConfigWriteToolResultSchema,
  XumAgentsReadToolResultSchema,
  XumAgentsWriteToolResultSchema,
  FileReadToolResultSchema,
  HeartbeatToolResultSchema,
  MemoryToolResultSchema,
  IntuitionToolResultSchema,
  IntuitionMemorySchema,
  IntuitionCandidateSchema,
  IntuitionStatsSchema,
  AttachFileToolResultSchema,
  TaskToolResultSchema,
  TaskSendMessageToolResultSchema,
  TaskRetitleToolResultSchema,
  TaskAwaitToolResultSchema,
  TaskApplyGitPatchToolResultSchema,
  TaskListToolResultSchema,
  TaskStopToolResultSchema,
  TaskRemoveToolResultSchema,
  TaskTerminateToolArgsSchema,
  TaskWorkspaceLifecycleToolArgsSchema,
  TaskTerminateToolResultSchema,
  TaskWorkspaceLifecycleToolResultSchema,
  TimelineEventToolResultSchema,
  TOOL_DEFINITIONS,
  WebFetchToolResultSchema,
  WorkflowRunToolResultSchema,
  WorkflowResumeToolResultSchema,
} from "@/common/utils/tools/toolDefinitions";

// Bash Tool Types, derived from schema (avoid drift)
export type BashToolArgs = z.infer<typeof TOOL_DEFINITIONS.bash.schema>;

// BashToolResult derived from Zod schema (single source of truth)
export type BashToolResult = z.infer<typeof BashToolResultSchema>;

// File Read Tool Types, derived from schema (avoid drift)
export type FileReadToolArgs = z.infer<typeof TOOL_DEFINITIONS.file_read.schema>;

// Agent Skill Tool Types
// Args derived from schema (avoid drift)
export type AgentSkillReadToolArgs = z.infer<typeof TOOL_DEFINITIONS.agent_skill_read.schema>;
export type AgentSkillReadToolResult = z.infer<typeof AgentSkillReadToolResultSchema>;

export type AgentSkillReadFileToolArgs = z.infer<
  typeof TOOL_DEFINITIONS.agent_skill_read_file.schema
>;
export type AgentSkillReadFileToolResult = z.infer<typeof AgentSkillReadFileToolResultSchema>;
export type MCPPromptGetToolResult = z.infer<typeof MCPPromptGetToolResultSchema>;

// agent_skill_list args + result
export type AgentSkillListToolArgs = z.infer<typeof TOOL_DEFINITIONS.agent_skill_list.schema>;
export type AgentSkillListToolResult =
  | { success: true; skills: AgentSkillDescriptor[] }
  | { success: false; error: string };

// agent_skill_write result
export type AgentSkillWriteToolResult =
  | { success: true; diff: string; ui_only?: { file_edit?: { diff: string } } }
  | { success: false; error: string };

// agent_skill_delete result
export type AgentSkillDeleteToolResult =
  | { success: true; deleted: "file" | "skill" }
  | { success: false; error: string };

// refinement_rollback result (RLM mode only)
export type RefinementRollbackToolResult =
  | {
      success: true;
      /** Refinement row id that was rolled back. */
      rollbackOf: string;
      /** Envelope id of the journaled rollback row; null if journaling failed. */
      rollbackRowId: string | null;
      /** Files restored to their recorded prior contents. */
      restored: string[];
      /** Files deleted (the target row had created them). */
      deleted: string[];
      /** Rename that was undone. */
      renamed?: { from: string; to: string };
    }
  | { success: false; error: string };

// skills_catalog_search result
export interface SkillsCatalogSearchSkill {
  skillId: string;
  name: string;
  owner: string;
  repo: string;
  installs: number;
  url: string;
}

export type SkillsCatalogSearchToolResult =
  | {
      success: true;
      query: string;
      searchType: string;
      skills: SkillsCatalogSearchSkill[];
      count: number;
    }
  | { success: false; error: string };

// skills_catalog_read result
export type SkillsCatalogReadToolResult =
  | {
      success: true;
      skillId: string;
      owner: string;
      repo: string;
      path: string;
      frontmatter: AgentSkillFrontmatter;
      body: string;
      url: string;
    }
  | { success: false; error: string };

export interface AskUserQuestionUiOnlyPayload {
  questions: AskUserQuestionQuestion[];
  answers: Record<string, string>;
}

export interface FileEditUiOnlyPayload {
  diff: string;
}

export interface NotifyUiOnlyPayload {
  notifiedVia: "electron" | "browser";
  workspaceId?: string;
}

export interface ToolOutputUiOnly {
  ask_user_question?: AskUserQuestionUiOnlyPayload;
  file_edit?: FileEditUiOnlyPayload;
  notify?: NotifyUiOnlyPayload;
}

export interface ToolOutputUiOnlyFields {
  ui_only?: ToolOutputUiOnly;
}

// FileReadToolResult derived from Zod schema (single source of truth)
export type FileReadToolResult = z.infer<typeof FileReadToolResultSchema>;

// Heartbeat tool types, derived from schema (avoid drift)
export type HeartbeatToolArgs = z.infer<typeof TOOL_DEFINITIONS.heartbeat.schema>;
export type HeartbeatToolResult = z.infer<typeof HeartbeatToolResultSchema>;

// Timeline-event tool types, derived from schema (avoid drift)
export type TimelineEventToolArgs = z.infer<typeof TOOL_DEFINITIONS.timeline_event.schema>;
export type TimelineEventToolResult = z.infer<typeof TimelineEventToolResultSchema>;

// Memory tool types, derived from schema (avoid drift)
export type MemoryToolArgs = z.infer<typeof TOOL_DEFINITIONS.memory.schema>;
export type MemoryToolResult = z.infer<typeof MemoryToolResultSchema>;

export type IntuitionToolArgs = z.infer<typeof TOOL_DEFINITIONS.intuition.schema>;
export type IntuitionToolResult = z.infer<typeof IntuitionToolResultSchema>;
export type IntuitionMemory = z.infer<typeof IntuitionMemorySchema>;
export type IntuitionCandidate = z.infer<typeof IntuitionCandidateSchema>;
export type IntuitionStats = z.infer<typeof IntuitionStatsSchema>;
export type IntuitionReportToolArgs = z.infer<typeof TOOL_DEFINITIONS.intuition_report.schema>;

// AttachFileToolResult derived from Zod schema (single source of truth)
export type AttachFileToolResult = z.infer<typeof AttachFileToolResultSchema>;

// xum_config_read tool types
export type XumConfigReadToolArgs = z.infer<typeof TOOL_DEFINITIONS.mux_config_read.schema>;
export type XumConfigReadToolResult = z.infer<typeof XumConfigReadToolResultSchema>;

// xum_config_write tool types
export type XumConfigWriteToolArgs = z.infer<typeof TOOL_DEFINITIONS.mux_config_write.schema>;
export type XumConfigWriteToolResult = z.infer<typeof XumConfigWriteToolResultSchema>;

// xum_agents_read tool types
export type XumAgentsReadToolResult = z.infer<typeof XumAgentsReadToolResultSchema>;

// xum_agents_write tool types
export type XumAgentsWriteToolArgs = z.infer<typeof TOOL_DEFINITIONS.mux_agents_write.schema>;
export type XumAgentsWriteToolResult = z.infer<typeof XumAgentsWriteToolResultSchema>;

export interface FileEditDiffSuccessBase extends ToolOutputUiOnlyFields {
  success: true;
  diff: string;
  warning?: string;
}

export const FILE_EDIT_DIFF_OMITTED_MESSAGE =
  "[diff omitted in context - call file_read on the target file if needed]";

export interface FileEditErrorResult extends ToolOutputUiOnlyFields {
  success: false;
  error: string;
  note?: string; // Agent-only message (not displayed in UI)
}

// FileEditInsertToolArgs derived from schema (avoid drift)
export type FileEditInsertToolArgs = z.infer<typeof TOOL_DEFINITIONS.file_edit_insert.schema>;

// FileEditInsertToolResult derived from Zod schema (single source of truth)
export type FileEditInsertToolResult = z.infer<typeof FileEditInsertToolResultSchema>;

// FileEditReplaceStringToolArgs derived from schema (avoid drift)
export type FileEditReplaceStringToolArgs = z.infer<
  typeof TOOL_DEFINITIONS.file_edit_replace_string.schema
>;

// FileEditReplaceStringToolResult derived from Zod schema (single source of truth)
export type FileEditReplaceStringToolResult = z.infer<typeof FileEditReplaceStringToolResultSchema>;

// FileEditReplaceLinesToolArgs derived from schema (avoid drift)
export type FileEditReplaceLinesToolArgs = z.infer<
  typeof TOOL_DEFINITIONS.file_edit_replace_lines.schema
>;

export type FileEditReplaceLinesToolResult =
  | (FileEditDiffSuccessBase & {
      edits_applied: number;
      lines_replaced: number;
      line_delta: number;
    })
  | FileEditErrorResult;

export const FILE_EDIT_TOOL_NAMES = [
  "file_edit_replace_string",
  "file_edit_replace_lines",
  "file_edit_insert",
] as const;

/**
 * Read-flavored tools whose successful results mark a workspace file as
 * "already seen" for RLM post-compaction read tracking (paths only, never
 * contents).
 */
export const FILE_READ_TOOL_NAMES = ["file_read"] as const;

/**
 * Prefix for edit failure notes (agent-only messages).
 * This prefix signals to the agent that the file was not modified.
 */
export const EDIT_FAILED_NOTE_PREFIX = "EDIT FAILED - file was NOT modified.";

/**
 * Common note fragments for DRY error messages
 */
export const NOTE_READ_FILE_RETRY = "Read the file to get current content, then retry.";
export const NOTE_READ_FILE_FIRST_RETRY =
  "Read the file first to get the exact current content, then retry.";
export const NOTE_READ_FILE_AGAIN_RETRY = "Read the file again and retry.";

/**
 * Tool description warning for file edit tools
 */
export const TOOL_EDIT_WARNING =
  "Always check the tool result before proceeding with other operations.";

// Generic tool error shape emitted via streamManager on tool-error parts.
export interface ToolErrorResult extends ToolOutputUiOnlyFields {
  success: false;
  error: string;
}
// Ask User Question Tool Types
// Args derived from schema (avoid drift)
export type AskUserQuestionToolArgs = z.infer<typeof TOOL_DEFINITIONS.ask_user_question.schema>;

export type AskUserQuestionQuestion = z.infer<typeof AskUserQuestionQuestionSchema>;

export type AskUserQuestionToolSuccessResult = z.infer<typeof AskUserQuestionToolResultSchema>;

export type AskUserQuestionToolResult = AskUserQuestionToolSuccessResult | ToolErrorResult;

// Task Tool Types
export type TaskToolArgs = z.infer<typeof TOOL_DEFINITIONS.task.schema>;

export type TaskToolSuccessResult = z.infer<typeof TaskToolResultSchema>;

export type TaskToolResult = TaskToolSuccessResult | ToolErrorResult;

// Task Await Tool Types
export type TaskAwaitToolArgs = z.infer<typeof TOOL_DEFINITIONS.task_await.schema>;

export type TaskAwaitToolSuccessResult = z.infer<typeof TaskAwaitToolResultSchema>;

// Task Apply Git Patch Tool Types
export type TaskApplyGitPatchToolArgs = z.infer<
  typeof TOOL_DEFINITIONS.task_apply_git_patch.schema
>;

export type TaskApplyGitPatchToolSuccessResult = z.infer<typeof TaskApplyGitPatchToolResultSchema>;

export type TaskApplyGitPatchToolResult = TaskApplyGitPatchToolSuccessResult | ToolErrorResult;

// Task List Tool Types
export type TaskListToolArgs = z.infer<typeof TOOL_DEFINITIONS.task_list.schema>;

export type TaskListToolSuccessResult = z.infer<typeof TaskListToolResultSchema>;

// Task Send Message Tool Types
export type TaskSendMessageToolArgs = z.infer<typeof TOOL_DEFINITIONS.task_send_message.schema>;

export type TaskSendMessageToolSuccessResult = z.infer<typeof TaskSendMessageToolResultSchema>;

// Task Retitle Tool Types
export type TaskRetitleToolArgs = z.infer<typeof TOOL_DEFINITIONS.task_retitle.schema>;
export type TaskRetitleToolSuccessResult = z.infer<typeof TaskRetitleToolResultSchema>;

// Task Stop Tool Types
export type TaskStopToolArgs = z.infer<typeof TOOL_DEFINITIONS.task_stop.schema>;
export type TaskStopToolSuccessResult = z.infer<typeof TaskStopToolResultSchema>;

// Task Remove Tool Types
export type TaskRemoveToolArgs = z.infer<typeof TOOL_DEFINITIONS.task_remove.schema>;
export type TaskRemoveToolSuccessResult = z.infer<typeof TaskRemoveToolResultSchema>;

// Task Terminate Tool Types
export type TaskTerminateToolArgs = z.infer<typeof TaskTerminateToolArgsSchema>;

export type TaskTerminateToolSuccessResult = z.infer<typeof TaskTerminateToolResultSchema>;

// Task Workspace Lifecycle Tool Types (parent-owned archive/delete_worktree/remove)
export type TaskWorkspaceLifecycleToolArgs = z.infer<typeof TaskWorkspaceLifecycleToolArgsSchema>;

// Success shape is `{ results: [...] }` (no top-level `success`); a thrown execute()
// surfaces as ToolErrorResult, so the renderable result is the union of both.
export type TaskWorkspaceLifecycleToolSuccessResult = z.infer<
  typeof TaskWorkspaceLifecycleToolResultSchema
>;

// One per-target outcome row, discriminated on `status` (12 lifecycle states).
export type TaskWorkspaceLifecycleTargetResult =
  TaskWorkspaceLifecycleToolSuccessResult["results"][number];

export type TaskWorkspaceLifecycleStatus = TaskWorkspaceLifecycleTargetResult["status"];

// Workflow Definition Tool Types
// Workflow Run Tool Types
export type WorkflowRunToolArgs = z.infer<typeof TOOL_DEFINITIONS.workflow_run.schema>;

export type WorkflowRunToolSuccessResult = z.infer<typeof WorkflowRunToolResultSchema>;

export type WorkflowRunToolResult = WorkflowRunToolSuccessResult | ToolErrorResult;

// Workflow Resume Tool Types
export type WorkflowResumeToolArgs = z.infer<typeof TOOL_DEFINITIONS.workflow_resume.schema>;

export type WorkflowResumeToolSuccessResult = z.infer<typeof WorkflowResumeToolResultSchema>;

export type WorkflowResumeToolResult = WorkflowResumeToolSuccessResult | ToolErrorResult;

// Agent Report Tool Types
export type AgentReportToolArgs = z.infer<typeof TOOL_DEFINITIONS.agent_report.schema>;

export type AgentReportToolResult = z.infer<typeof AgentReportToolResultSchema> | ToolErrorResult;

// Propose Plan Tool Types
// Result type for file-based propose_plan tool
// Note: planContent is NOT included to save context - plan is visible via file_edit_* diffs
// and will be included in mode transition message when switching to exec mode
export interface ProposePlanToolResult {
  success: true;
  planPath: string;
  message: string;
}

// Error result when plan file not found
export interface ProposePlanToolError {
  success: false;
  error: string;
}

/**
 * @deprecated Legacy args type for backwards compatibility with old propose_plan tool calls.
 * Old sessions may have tool calls with title + plan args stored in chat history.
 */
export interface LegacyProposePlanToolArgs {
  title: string;
  plan: string;
}

/**
 * @deprecated Legacy result type for backwards compatibility.
 */
export interface LegacyProposePlanToolResult {
  success: true;
  title: string;
  plan: string;
  message: string;
}

// Todo Tool Types, derived from schema (avoid drift)
export type TodoWriteToolArgs = z.infer<typeof TOOL_DEFINITIONS.todo_write.schema>;
export type TodoItem = TodoWriteToolArgs["todos"][number];

export interface TodoWriteToolResult {
  success: true;
  count: number;
}

// Review Pane Tool Types, derived from schema (avoid drift)
export type ReviewPaneUpdateToolArgs = z.infer<typeof TOOL_DEFINITIONS.review_pane_update.schema>;

export interface ReviewPaneHunkEntry {
  /** Hunk filter in `path[:range]` form (e.g. "src/foo.ts:10-20"). */
  path: string;
  /** Optional agent comment explaining what to look at. */
  comment: string | null;
}

export interface ReviewPaneUpdateToolResult {
  success: true;
  operation: "add" | "replace";
  /** Resulting pinned set (post-merge + dedup). */
  hunks: ReviewPaneHunkEntry[];
  /** Original filter strings that failed to parse and were dropped. */
  rejected: string[];
}

export interface ReviewPaneGetToolResult {
  hunks: ReviewPaneHunkEntry[];
}

export interface StatusSetToolArgs {
  emoji: string;
  message: string;
  url?: string | null;
}

// Bash Output Tool Types, derived from schema (avoid drift)
export type BashOutputToolArgs = z.infer<typeof TOOL_DEFINITIONS.bash_output.schema>;

// BashOutputToolResult derived from Zod schema (single source of truth)
export type BashOutputToolResult = z.infer<typeof BashOutputToolResultSchema>;

// Bash Background Tool Types, derived from schema (avoid drift)
export type BashBackgroundTerminateArgs = z.infer<
  typeof TOOL_DEFINITIONS.bash_background_terminate.schema
>;

// BashBackgroundTerminateResult derived from Zod schema (single source of truth)
export type BashBackgroundTerminateResult = z.infer<typeof BashBackgroundTerminateResultSchema>;

// Bash Background List Tool Types
export type BashBackgroundListArgs = Record<string, never>;

// BashBackgroundListResult derived from Zod schema (single source of truth)
export type BashBackgroundListResult = z.infer<typeof BashBackgroundListResultSchema>;

// BashBackgroundListProcess extracted from result type for convenience
export type BashBackgroundListProcess = Extract<
  BashBackgroundListResult,
  { success: true }
>["processes"][number];

export type StatusSetToolResult =
  | {
      success: true;
      emoji: string;
      message: string;
      url?: string;
    }
  | {
      success: false;
      error: string;
    };

// Web Fetch Tool Types, derived from schema (avoid drift)
export type WebFetchToolArgs = z.infer<typeof TOOL_DEFINITIONS.web_fetch.schema>;

// WebFetchToolResult derived from Zod schema (single source of truth)
export type WebFetchToolResult = z.infer<typeof WebFetchToolResultSchema>;

// Tool Search Tool Types (tool-search experiment), derived from schema (avoid drift)
export type ToolSearchToolArgs = z.infer<typeof TOOL_DEFINITIONS.tool_catalog_search.schema>;

export interface ToolSearchToolResult {
  query: string;
  /** serverName is a bounded display label, not the raw server-config key. */
  matches: Array<{ name: string; description: string; serverName?: string }>;
  /** Total deferred-catalog size, so the model/UI can see there are more undiscovered tools. */
  totalDeferred: number;
}

// Notify Tool Types
export type NotifyToolResult =
  | (ToolOutputUiOnlyFields & {
      success: true;
      title: string;
      message?: string;
    })
  | {
      success: false;
      error: string;
    };

// ═══════════════════════════════════════════════════════════════════════════════
// Hook Output Types
// ═══════════════════════════════════════════════════════════════════════════════

/**
 * Tool results may include hook_output when a tool hook (pre/post) produced output.
 * This is added by withHooks.ts in the backend.
 */
export interface WithHookOutput {
  hook_output?: string;
  /** Total hook execution time (pre + post) in milliseconds */
  hook_duration_ms?: number;
  /** Path to the hook file that produced this output (helps the model investigate/modify) */
  hook_path?: string;
}

/**
 * Type utility to add hook_output to any tool result type.
 * Use this when you need to represent a result that may have hook output attached.
 */
export type MayHaveHookOutput<T> = T & WithHookOutput;

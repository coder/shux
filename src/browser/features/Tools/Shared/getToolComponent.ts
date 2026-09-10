/**
 * Unified tool component registry.
 *
 * Single source of truth for mapping tool names to their UI components.
 * Both ToolMessage.tsx and NestedToolRenderer.tsx use this to avoid duplication.
 */
import type { ComponentType } from "react";
import { z, type ZodSchema } from "zod";
import {
  TaskTerminateToolArgsSchema,
  TaskWorkspaceLifecycleToolArgsSchema,
  TOOL_DEFINITIONS,
  type ToolName,
} from "@/common/utils/tools/toolDefinitions";

import { AnalyticsQueryToolCall } from "../analyticsQuery/AnalyticsQueryToolCall";
import { AttachFileToolCall } from "../AttachFileToolCall";
import { AdvisorToolCall } from "../AdvisorToolCall";
import { GenericToolCall } from "../GenericToolCall";
import { BashToolCall } from "../BashToolCall";
import { DesktopActionToolCall } from "../DesktopActionToolCall";
import { DesktopScreenshotToolCall } from "../DesktopScreenshotToolCall";
import { FileEditToolCall } from "../FileEditToolCall";
import { AgentSkillReadToolCall } from "../AgentSkillReadToolCall";
import { AgentSkillReadFileToolCall } from "../AgentSkillReadFileToolCall";
import { AgentSkillListToolCall } from "../AgentSkillListToolCall";
import { FileReadToolCall } from "../FileReadToolCall";
import { MemoryToolCall } from "../MemoryToolCall";
import { IntuitionToolCall } from "../IntuitionToolCall";
import { WebFetchToolCall } from "../WebFetchToolCall";
import { WebSearchToolCall } from "../WebSearchToolCall";
import { GoogleSearchToolCall } from "../GoogleSearchToolCall";
import { AskUserQuestionToolCall } from "../AskUserQuestionToolCall";
import { ProposePlanToolCall } from "../ProposePlanToolCall";
import { TodoToolCall } from "../TodoToolCall";
import { StatusSetToolCall } from "../StatusSetToolCall";
import { NotifyToolCall } from "../NotifyToolCall";
import { ToolSearchToolCall } from "../ToolSearchToolCall";
import { ReviewPaneUpdateToolCall } from "../ReviewPaneUpdateToolCall";
import { ReviewPaneGetToolCall } from "../ReviewPaneGetToolCall";
import { BashBackgroundListToolCall } from "../BashBackgroundListToolCall";
import { BashBackgroundTerminateToolCall } from "../BashBackgroundTerminateToolCall";
import { BashOutputToolCall } from "../BashOutputToolCall";
import { AgentReportToolCall } from "../AgentReportToolCall";
import { CodeExecutionToolCall } from "../CodeExecutionToolCall";
import {
  TaskToolCall,
  TaskAwaitToolCall,
  TaskListToolCall,
  TaskSendMessageToolCall,
  TaskRetitleToolCall,
  TaskStopToolCall,
  TaskRemoveToolCall,
  TaskTerminateToolCall,
} from "../TaskToolCall";
import { TaskApplyGitPatchToolCall } from "../TaskApplyGitPatchToolCall";
import { WorkspaceLifecycleToolCall } from "../WorkspaceLifecycleToolCall";
import { SetGoalToolCall } from "../SetGoalToolCall";
import { GetGoalToolCall } from "../GetGoalToolCall";
import { HeartbeatToolCall } from "../HeartbeatToolCall";
import { TimelineEventToolCall } from "../TimelineEventToolCall";
import { WorkflowResumeToolCall, WorkflowRunToolCall } from "../WorkflowRunToolCall";
import { CompleteGoalToolCall } from "../CompleteGoalToolCall";

/**
 * Component type that accepts any props. We use this because:
 * 1. The registry validates args before returning the component
 * 2. Callers pass all possible extras; components pick what they need
 * 3. Type safety is enforced at the component level, not the registry level
 */
// eslint-disable-next-line @typescript-eslint/no-explicit-any
type AnyToolComponent = ComponentType<any>;

/** Component bindings stay separate because UI components are browser-only. */
const TOOL_REGISTRY: Record<string, AnyToolComponent> = {
  bash: BashToolCall,
  file_read: FileReadToolCall,
  memory: MemoryToolCall,
  intuition: IntuitionToolCall,
  attach_file: AttachFileToolCall,
  desktop_screenshot: DesktopScreenshotToolCall,
  desktop_move_mouse: DesktopActionToolCall,
  desktop_click: DesktopActionToolCall,
  desktop_double_click: DesktopActionToolCall,
  desktop_drag: DesktopActionToolCall,
  desktop_scroll: DesktopActionToolCall,
  desktop_type: DesktopActionToolCall,
  desktop_key_press: DesktopActionToolCall,
  agent_skill_read: AgentSkillReadToolCall,
  agent_skill_read_file: AgentSkillReadFileToolCall,
  agent_skill_list: AgentSkillListToolCall,
  file_edit_replace_string: FileEditToolCall,
  file_edit_replace_lines: FileEditToolCall,
  file_edit_insert: FileEditToolCall,
  ask_user_question: AskUserQuestionToolCall,
  propose_plan: ProposePlanToolCall,
  todo_write: TodoToolCall,
  status_set: StatusSetToolCall,
  notify: NotifyToolCall,
  tool_catalog_search: ToolSearchToolCall,
  tool_search: ToolSearchToolCall,
  analytics_query: AnalyticsQueryToolCall,
  advisor: AdvisorToolCall,
  web_fetch: WebFetchToolCall,
  bash_background_list: BashBackgroundListToolCall,
  bash_background_terminate: BashBackgroundTerminateToolCall,
  bash_output: BashOutputToolCall,
  code_execution: CodeExecutionToolCall,
  task: TaskToolCall,
  task_await: TaskAwaitToolCall,
  task_list: TaskListToolCall,
  task_send_message: TaskSendMessageToolCall,
  task_retitle: TaskRetitleToolCall,
  task_stop: TaskStopToolCall,
  task_remove: TaskRemoveToolCall,
  task_terminate: TaskTerminateToolCall,
  task_apply_git_patch: TaskApplyGitPatchToolCall,
  task_workspace_lifecycle: WorkspaceLifecycleToolCall,
  workflow_run: WorkflowRunToolCall,
  workflow_resume: WorkflowResumeToolCall,
  agent_report: AgentReportToolCall,
  set_goal: SetGoalToolCall,
  get_goal: GetGoalToolCall,
  complete_goal: CompleteGoalToolCall,
  heartbeat: HeartbeatToolCall,
  timeline_event: TimelineEventToolCall,
  review_pane_update: ReviewPaneUpdateToolCall,
  review_pane_get: ReviewPaneGetToolCall,
  web_search: WebSearchToolCall,
  "server:GOOGLE_SEARCH_WEB": GoogleSearchToolCall,
};

const legacyStatusSetSchema = z.object({
  emoji: z.string(),
  message: z.string(),
  url: z.string().url().optional().nullable(),
});

const legacyAgentReportFileArgsSchema = z
  .object({
    reportMarkdownPath: z.string().min(1).nullish(),
    structuredOutputPath: z.string().min(1).nullish(),
    title: z.string().nullish(),
  })
  .strict();

const TOOL_SCHEMA_OVERRIDES: Record<string, ZodSchema> = {
  // Legacy file-backed reports remain renderable from persisted transcripts.
  agent_report: z.union([TOOL_DEFINITIONS.agent_report.schema, legacyAgentReportFileArgsSchema]),
  // status_set is a removed dynamic tool that still appears in history.
  status_set: legacyStatusSetSchema,
  // tool_search is the historical wire name for tool_catalog_search.
  tool_search: TOOL_DEFINITIONS.tool_catalog_search.schema,
  // task_terminate is retained only for historical task transcripts.
  task_terminate: TaskTerminateToolArgsSchema,
  // Historical lifecycle transcripts include actions removed from the live input schema.
  task_workspace_lifecycle: TaskWorkspaceLifecycleToolArgsSchema,
  // Kernel-nested workflow_run calls can arrive with a __kernelBounded args marker
  // (oversized launch args); the card still renders from the attached durable run,
  // so don't bounce those to the generic JSON renderer.
  workflow_run: z.union([
    TOOL_DEFINITIONS.workflow_run.schema,
    z.object({ __kernelBounded: z.literal(true), script_path: z.string().nullish() }),
  ]),
  // Provider-executed web search tools have no catalog definition.
  web_search: z.object({ query: z.string().optional() }),
  // Pending Google search arguments can arrive before queries are parsed.
  "server:GOOGLE_SEARCH_WEB": z.object({ queries: z.array(z.string()).optional() }),
};

/**
 * Returns the appropriate tool component for a given tool name and args.
 * Validates args against Zod schemas; returns GenericToolCall if validation fails or tool unknown.
 */
export function getToolComponent(toolName: string, args: unknown): AnyToolComponent {
  // Object.hasOwn: toolName flows verbatim from persisted transcripts (attacker-controlled).
  // A bare index lookup returns truthy inherited members for names like "constructor",
  // which would then throw on .schema and brick the workspace view instead of degrading
  // to the generic renderer (self-healing invariant).
  const component = Object.hasOwn(TOOL_REGISTRY, toolName) ? TOOL_REGISTRY[toolName] : undefined;
  const schema = Object.hasOwn(TOOL_SCHEMA_OVERRIDES, toolName)
    ? TOOL_SCHEMA_OVERRIDES[toolName]
    : Object.hasOwn(TOOL_DEFINITIONS, toolName)
      ? TOOL_DEFINITIONS[toolName as ToolName].schema
      : undefined;
  if (!component || !schema?.safeParse(args).success) return GenericToolCall;
  return component;
}

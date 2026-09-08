import type { HistoryService } from "@/node/services/historyService";
import { createSessionHistoryTool } from "@/node/services/tools/session_history";
import { xai } from "@ai-sdk/xai";
import { type LanguageModel, type Tool } from "ai";
import type { LanguageModelV2Usage } from "@ai-sdk/provider";
import type { MuxProviderOptions } from "@/common/types/providerOptions";
import type { ProvidersConfigMap, SendMessageOptions } from "@/common/orpc/types";
import {
  isGrokFrontierModel,
  type OpenAIReasoningMode,
  type ThinkingLevel,
} from "@/common/types/thinking";
import type { ProviderName } from "@/common/constants/providers";
import type { BackgroundWorkAttentionPolicy } from "@/common/types/backgroundWorkAttention";
import { cloneToolPreservingDescriptors } from "@/common/utils/tools/cloneToolPreservingDescriptors";
import { createFileReadTool } from "@/node/services/tools/file_read";
import { createAttachFileTool } from "@/node/services/tools/attach_file";
import { createBashTool } from "@/node/services/tools/bash";
import { createBashOutputTool } from "@/node/services/tools/bash_output";
import { createBashBackgroundListTool } from "@/node/services/tools/bash_background_list";
import { createBashBackgroundTerminateTool } from "@/node/services/tools/bash_background_terminate";
import { createFileEditReplaceStringTool } from "@/node/services/tools/file_edit_replace_string";
// DISABLED: import { createFileEditReplaceLinesTool } from "@/node/services/tools/file_edit_replace_lines";
import { createFileEditInsertTool } from "@/node/services/tools/file_edit_insert";
import { createAskUserQuestionTool } from "@/node/services/tools/ask_user_question";
import { createIntuitionTool } from "@/node/services/tools/intuition";
import { createAdvisorTool } from "@/node/services/tools/advisor";
import { createProposePlanTool } from "@/node/services/tools/propose_plan";
import { createTodoWriteTool, createTodoReadTool } from "@/node/services/tools/todo";
import {
  createReviewPaneUpdateTool,
  createReviewPaneGetTool,
} from "@/node/services/tools/review_pane";
import { createHeartbeatTool } from "@/node/services/tools/heartbeat";
import { createSetGoalTool } from "@/node/services/tools/set_goal";
import { createGetGoalTool } from "@/node/services/tools/get_goal";
import { createCompleteGoalTool } from "@/node/services/tools/complete_goal";
import { createNotifyTool } from "@/node/services/tools/notify";
import { createTimelineEventTool } from "@/node/services/tools/timeline_event";
import { createToolSearchTool } from "@/node/services/tools/toolSearch";
import { createMcpPromptGetTool } from "@/node/services/tools/mcp_prompt_get";
import { createAnalyticsQueryTool } from "@/node/services/tools/analyticsQuery";
import { createDesktopTools } from "@/node/services/tools/desktopTools";
import type { XumToolScope } from "@/common/types/toolScope";
import { createTaskTool } from "@/node/services/tools/task";
import { createTaskApplyGitPatchTool } from "@/node/services/tools/task_apply_git_patch";
import { createTaskAwaitTool } from "@/node/services/tools/task_await";
import { createTaskSendMessageTool } from "@/node/services/tools/task_send_message";
import { createTaskMessageParentTool } from "@/node/services/tools/task_message_parent";
import { createTaskMessageSiblingTool } from "@/node/services/tools/task_message_sibling";
import { createTaskRetitleTool } from "@/node/services/tools/task_retitle";
import { createTaskStopTool } from "@/node/services/tools/task_stop";
import { createTaskRemoveTool } from "@/node/services/tools/task_remove";
import { createTaskWorkspaceLifecycleTool } from "@/node/services/tools/task_workspace_lifecycle";
import { createTaskListTool } from "@/node/services/tools/task_list";
import { createAgentSkillReadTool } from "@/node/services/tools/agent_skill_read";
import { createAgentSkillReadFileTool } from "@/node/services/tools/agent_skill_read_file";
import { createAgentSkillListTool } from "@/node/services/tools/agent_skill_list";
import { createAgentSkillWriteTool } from "@/node/services/tools/agent_skill_write";
import { createAgentSkillDeleteTool } from "@/node/services/tools/agent_skill_delete";
import { createSkillsCatalogSearchTool } from "@/node/services/tools/skills_catalog_search";
import { createSkillsCatalogReadTool } from "@/node/services/tools/skills_catalog_read";
import { createWebFetchTool } from "@/node/services/tools/web_fetch";
import { createXumAgentsReadTool } from "@/node/services/tools/xum_agents_read";
import { createXumAgentsWriteTool } from "@/node/services/tools/xum_agents_write";
import { createXumConfigReadTool } from "@/node/services/tools/xum_config_read";
import { createXumConfigWriteTool } from "@/node/services/tools/xum_config_write";
import { createWorkflowRunTool } from "@/node/services/tools/workflow_run";
import { createWorkflowResumeTool } from "@/node/services/tools/workflow_resume";
import { createAgentReportTool } from "@/node/services/tools/agent_report";
import { wrapWithInitWait } from "@/node/services/tools/wrapWithInitWait";
import { deriveToolHookConfig, withHooks } from "@/node/services/tools/withHooks";
import { log } from "@/node/services/log";
import { attachModelOnlyToolNotifications } from "@/common/utils/tools/internalToolResultFields";
import { NotificationEngine } from "@/node/services/agentNotifications/NotificationEngine";
import { TodoListReminderSource } from "@/node/services/agentNotifications/sources/TodoListReminderSource";
import {
  getAvailableTools,
  supportsGoogleNativeToolsWithFunctionTools,
} from "@/common/utils/tools/toolDefinitions";
import { sanitizeMCPToolsForOpenAI } from "@/common/utils/tools/schemaSanitizer";
import type { ToolSearchRuntime } from "@/common/utils/tools/toolCatalog";
import type { MCPPromptDescriptor } from "@/common/orpc/schemas/mcp";

import type { Result } from "@/common/types/result";
import type { Runtime } from "@/node/runtime/Runtime";
import type { InitStateManager } from "@/node/services/initStateManager";
import type { BackgroundProcessManager } from "@/node/services/backgroundProcessManager";
import type { DesktopSessionManager } from "@/node/services/desktop/DesktopSessionManager";
import type { TaskService } from "@/node/services/taskService";
import type { WorkspaceTurnManager } from "@/node/services/workspaceTurnManager";
import type { MemoryIndexEntry, MemoryService } from "@/node/services/memoryService";
import type { MemoryScopeAccess } from "@/common/constants/memory";
import { createMemoryTool } from "@/node/services/tools/memory";
import type { WorkspaceGoalService } from "@/node/services/workspaceGoalService";
import type { TimelineService } from "@/node/services/timelineService";
import type { WorkspaceChatMessage } from "@/common/orpc/types";
import type { FileState } from "@/node/services/agentSession";
import type { AgentDefinitionDescriptor } from "@/common/types/agentDefinition";
import type { AgentSkillDescriptor } from "@/common/types/agentSkill";
import type { ModelMessage } from "@/common/types/message";
import type { GoalDefaults } from "@/constants/goals";
import type { ProjectRef, WorkspaceMetadata } from "@/common/types/workspace";

export interface ToolModelUsageEvent {
  source: "tool";
  toolName: string;
  model: string;
  /** Pricing identity pinned by this invocation, independent of other creations of the same model. */
  metadataModel?: string;
  usage: LanguageModelV2Usage;
  providerMetadata?: Record<string, unknown>;
  toolCallId?: string;
  timestamp: number;
}

export interface AdvisorToolCallSnapshot {
  toolCallId: string;
  toolName: "advisor";
  input: Record<string, unknown>;
  stepText: string;
  stepReasoning: string;
}

export interface AdvisorStepCaptureRef {
  currentStepText: string;
  currentStepReasoning: string;
  frozenSnapshotsByToolCallId: Map<string, AdvisorToolCallSnapshot>;
}

export type WorkspaceHeartbeatSettings = NonNullable<WorkspaceMetadata["heartbeat"]>;
export type WorkspaceHeartbeatSettingsUpdate = Partial<WorkspaceHeartbeatSettings>;

export interface WorkspaceHeartbeatToolService {
  getHeartbeatSettings(workspaceId: string): WorkspaceHeartbeatSettings | null;
  setHeartbeatSettings(
    workspaceId: string,
    settings: WorkspaceHeartbeatSettingsUpdate
  ): Promise<Result<WorkspaceHeartbeatSettings, string>>;
  unsetHeartbeatSettings(workspaceId: string): Promise<Result<void, string>>;
}

/**
 * Configuration for tools that need runtime context
 */
export interface WorkflowServiceScriptInput {
  requestedScriptPath: string;
  canonicalScriptPath: string;
  source: string;
  sourceHash: string;
  sourceKind: "skill" | "workspace-file" | "inline" | "plugin";
}

export interface ToolConfiguration {
  /** Working directory for command execution - actual path in runtime's context (local or remote) */
  cwd: string;
  /** Runtime environment for executing commands and file operations */
  runtime: Runtime;
  /** Project roots in this workspace (single- or multi-project context for tool descriptions) */
  projects?: ProjectRef[];
  /** Environment secrets to inject (optional) */
  secrets?: Record<string, string>;
  /** MUX_ environment variables (MUX_PROJECT_PATH, MUX_RUNTIME) - set from init hook env */
  xumEnv?: Record<string, string>;
  /** Temporary directory for tool outputs in runtime's context (local or remote) */
  runtimeTempDir: string;
  /** Model used for capability checks when the runtime model is a configured alias. */
  capabilityModelString?: string;
  /** OpenAI wire format — webSearch requires "responses" */
  openaiWireFormat?: "responses" | "chatCompletions";
  /** Whether the resolved route supports xAI Responses-native tools. */
  xaiNativeToolsEnabled?: boolean;
  /** Legacy xAI Live Search settings translated to Responses native search tools. */
  xaiSearchParameters?: NonNullable<NonNullable<MuxProviderOptions["xai"]>["searchParameters"]>;
  /** Overflow policy for bash tool output (optional, not exposed to AI) */
  overflow_policy?: "truncate" | "tmpfile";
  /** Background process manager for bash tool (optional, AI-only) */
  backgroundProcessManager?: BackgroundProcessManager;
  /** When true, restrict edits to the plan file (plan agent behavior). */
  planFileOnly?: boolean;
  /** Plan file path - only this file can be edited when planFileOnly is true. */
  planFilePath?: string;
  /** Additional exact ancestor plan files surfaced in prompt context. */
  ancestorPlanFilePaths?: string[];
  /**
   * Optional callback for emitting UI-only workspace chat events.
   * Used for streaming bash stdout/stderr to the UI without sending it to the model.
   */
  emitChatEvent?: (event: WorkspaceChatMessage) => Promise<void> | void;
  /** Primary project path for workspace-scoped tools that need project-relative coordinates. */
  workspaceProjectPath?: string;
  /** Absolute cwd for workspace-scoped tools that accept execution-relative paths. */
  workspaceExecutionRootPath?: string;
  /** Workspace session directory (e.g. ~/.xum/sessions/<workspaceId>) for persistent tool state */
  workspaceSessionDir?: string;
  /** Workspace ID for tracking background processes and plan storage */
  workspaceId?: string;
  /** Resolved agent identity of the turn executing the tools (workflow wake provenance). */
  agentId?: string;
  /** The turn's strict-agent pin, persisted with workflow run provenance so wakes re-pin the launch agent. */
  strictAgentResolution?: SendMessageOptions["strictAgentResolution"];
  /** Pre-resolved mux-managed resource scope (global ~/.xum vs project root). */
  xumScope?: XumToolScope;
  /** Memory service for the memory tool (present only when the memory experiment is enabled). */
  historyService?: HistoryService;
  memoryService?: MemoryService;
  timelineService?: TimelineService;
  /** Per-scope memory write policy for the current agent (defaults to read-only). */
  memoryAccess?: MemoryScopeAccess;
  /** Callback to record file state for external edit detection (plan files) */
  recordFileState?: (filePath: string, state: FileState) => Promise<void>;
  /** Callback to notify that provider/config was written (triggers hot-reload). */
  onConfigChanged?: () => void;
  /** Best-effort callback for recording tool-initiated model usage in session totals. */
  reportModelUsage?: (event: ToolModelUsageEvent) => void;
  /** Task orchestration for sub-agent tasks */
  taskService?: TaskService;
  workspaceTurnManager?: WorkspaceTurnManager;
  /** Durable workflow lifecycle service for dynamic workflow tools. */
  workflowService?: {
    getRun?(input: { workspaceId: string; runId: string }): Promise<unknown>;
    listRuns?(input: { workspaceId: string }): Promise<unknown[]>;
    startWorkflowInBackground?(input: {
      script: WorkflowServiceScriptInput;
      workspaceId: string;
      projectTrusted: boolean;
      args: unknown;
      attentionPolicy?: BackgroundWorkAttentionPolicy;
      onRunCreated?: (event: {
        runId: string;
        status: "pending";
        result: null;
        run: unknown;
      }) => Promise<void> | void;
    }): Promise<{ runId: string; status: string; result: unknown }>;
    startWorkflow?(input: {
      script: WorkflowServiceScriptInput;
      workspaceId: string;
      projectTrusted: boolean;
      args: unknown;
      abortSignal?: AbortSignal;
      onRunCreated?: (event: {
        runId: string;
        status: "pending";
        result: null;
        run: unknown;
      }) => Promise<void> | void;
    }): Promise<{ runId: string; status: string; result: unknown }>;
    interruptRun?(input: { workspaceId: string; runId: string }): Promise<unknown>;
    resumeRun?(input: {
      workspaceId: string;
      runId: string;
      projectTrusted: boolean;
      abortSignal?: AbortSignal;
    }): Promise<{ runId: string; status: string; result: unknown }>;
    resumeRunInBackground?(input: {
      workspaceId: string;
      runId: string;
      projectTrusted: boolean;
    }): Promise<{ runId: string; status: string; result: unknown }>;
    retryRunFromCheckpoint?(input: {
      workspaceId: string;
      runId: string;
      projectTrusted: boolean;
      abortSignal?: AbortSignal;
    }): Promise<{ runId: string; status: string; result: unknown }>;
    retryRunFromCheckpointInBackground?(input: {
      workspaceId: string;
      runId: string;
      projectTrusted: boolean;
    }): Promise<{ runId: string; status: string; result: unknown }>;
  };
  /** Workspace heartbeat settings service for model-facing heartbeat configuration. */
  workspaceHeartbeatService?: WorkspaceHeartbeatToolService;
  /** Workspace goal lifecycle service for model-facing goal tools. */
  goalService?: WorkspaceGoalService;
  /** Effective goal defaults for model-created goals in this workspace. */
  goalDefaults?: GoalDefaults;
  /** Per-request goal tool gates derived from goal status and agent capabilities. */
  enableGoalTools?: {
    setGoal: boolean;
    getGoal: boolean;
    completeGoal: boolean;
  };
  /** Optional JSON Schema subset required by a workflow-spawned task report. */
  workflowAgentOutputSchema?: unknown;
  /** Allow pre-upgrade workflow child tasks with schemas now rejected by strict validation. */
  allowLegacyInvalidWorkflowAgentOutputSchema?: boolean;
  /** Enable agent_report tool (only valid for child task workspaces) */
  enableAgentReport?: boolean;
  /**
   * Enable RLM family messaging tools (task_message_parent / task_message_sibling).
   * Only valid for child task workspaces whose task record was stamped with the rlm
   * experiment at spawn.
   */
  enableFamilyMessaging?: boolean;
  /** Experiments inherited from parent (for subagent spawning) */
  experiments?: {
    programmaticToolCalling?: boolean;
    /** RLM mode: inherited to subagent spawns so children are stamped at spawn time. */
    rlm?: boolean;
    advisorTool?: boolean;
    dynamicWorkflows?: boolean;
    tokenBudget?: boolean;
    memory?: boolean;
    timeline?: boolean;
    workspaceHeartbeats?: boolean;
    toolSearch?: boolean;
    /** claude-skills-compat: discover skills from .claude/skills and ~/.claude/skills (read-only). */
    claudeSkillsCompat?: boolean;
    /** agent-plugins: discover Agent Plugins skills from .xum/plugins, .agents/plugins and their global counterparts (read-only). */
    agentPlugins?: boolean;
  };
  /** Available sub-agents for the task tool description (dynamic context) */
  availableSubagents?: AgentDefinitionDescriptor[];
  /** Available skills for the agent_skill_read tool description (dynamic context) */
  availableSkills?: AgentSkillDescriptor[];
  /**
   * Session-segment memory index for the memory tool description (dynamic
   * context, same disclosure mechanic as skills). Absent when no snapshot was
   * resolved (e.g. non-stream tool builds): the tool falls back to its base
   * description.
   */
  memoryIndexEntries?: Array<Pick<MemoryIndexEntry, "path" | "description">>;
  /** Whether the project is trusted for hook/script execution */
  trusted?: boolean;
  /** Analytics service for raw SQL queries against DuckDB analytics data */
  analyticsService?: {
    executeRawQuery(sql: string): Promise<unknown>;
  };
  /** Pinned, host-only recall runtime; present only for eligible parent turns. */
  intuitionRuntime?: {
    modelString: string;
    thinkingLevel?: ThinkingLevel;
    maxUsesPerTurn: number;
    /** Shared by every tool rebuild in this parent turn (including refusal fallback). */
    usesThisTurn: number;
    createModel: NonNullable<ToolConfiguration["advisorRuntime"]>["createModel"];
    resolveAgentBody: () => Promise<string | null>;
    abortSignal: AbortSignal;
  };
  /** Runtime bundle for the advisor tool (present only when advisor is eligible for this stream). */
  advisorRuntime?: {
    /** The advisor model string (e.g. "anthropic:claude-sonnet-4-20250514") */
    advisorModelString: string;
    /** Optional reasoning/thinking level metadata for the advisor request. */
    reasoningLevel?: string;
    /** Independent of the parent chat's reasoning mode and advisor effort. */
    reasoningMode?: OpenAIReasoningMode;
    /** Normalized max uses per turn: null = unlimited, positive integer = exact cap */
    maxUsesPerTurn: number | null;
    /** Normalized max output tokens cap for advisor responses: undefined = unlimited, positive integer = explicit cap */
    maxOutputTokens?: number;
    /** Returns the live conversation transcript up to the current tool call */
    getTranscriptSnapshot: () => ModelMessage[];
    /** Returns the frozen same-step capture snapshot for a specific advisor tool call, if available. */
    takeToolCallSnapshot: (toolCallId: string) => AdvisorToolCallSnapshot | undefined;
    /**
     * Creates a model and pins its request identity, route, and config together.
     * Coder identities retain their actual instance and scoped aliases; option
     * construction resolves their wire from this snapshot, never live config.
     */
    createModel: (modelString: string) => Promise<{
      model: LanguageModel;
      metadataModel?: string;
      optionsModelString: string;
      /**
       * Providers snapshot captured at model-creation time for option
       * construction. Required so buildProviderOptions can remap
       * custom-provider wire namespaces while still resolving mappedToModel
       * alias metadata from the raw custom identity.
       */
      optionsProvidersConfig: ProvidersConfigMap | null;
      /** Pinned wire/route options keep Pro restricted to supported Responses routes. */
      optionsMuxProviderOptions?: MuxProviderOptions;
      optionsRouteProvider?: ProviderName;
    }>;
    /** The abort signal from the parent stream */
    abortSignal: AbortSignal;
  };
  /**
   * Runtime holder for the tool_catalog_search tool (tool-search experiment; present
   * only when the experiment is enabled and MCP tools exist for this stream).
   * `state` is assigned by aiService after policy filtering builds the catalog.
   */
  toolSearchRuntime?: ToolSearchRuntime;
  /**
   * Runtime for the mcp_prompt_get tool (present only when connected MCP
   * servers advertise prompts for this stream). `prompts` is the descriptor
   * snapshot advertised in the tool description; `getPrompt` dispatches
   * through MCPServerManager so trust and refresh gates apply.
   */
  mcpPromptRuntime?: MCPPromptRuntime;
  /** Desktop session manager for desktop automation tools */
  desktopSessionManager?: DesktopSessionManager;
}

export interface MCPPromptRuntime {
  prompts: MCPPromptDescriptor[];
  /** Returned text is already UTF-8 byte-capped at the manager chokepoint. */
  getPrompt: (
    serverName: string,
    promptName: string,
    args: Record<string, string>,
    options?: { signal?: AbortSignal }
  ) => Promise<{ text: string; description?: string }>;
}

/**
 * Factory function interface for creating tools with configuration
 */
export type ToolFactory = (config: ToolConfiguration) => Tool;

/**
 * Augment a tool's description with additional instructions from "Tool: <name>" sections
 * Mutates the base tool in place to append the instructions to its description.
 * This preserves any provider-specific metadata or internal state on the tool object.
 * @param baseTool The original tool to augment
 * @param additionalInstructions Additional instructions to append to the description
 * @returns The same tool instance with the augmented description
 */
function augmentToolDescription(baseTool: Tool, additionalInstructions: string): Tool {
  // Access the tool as a record to get its properties
  // eslint-disable-next-line @typescript-eslint/no-explicit-any, local/no-chained-type-assertions -- grandfathered when the rule was introduced; fix the underlying type instead of copying this pattern
  const baseToolRecord = baseTool as any as Record<string, unknown>;
  const originalDescription =
    typeof baseToolRecord.description === "string" ? baseToolRecord.description : "";
  const augmentedDescription = `${originalDescription}\n\n${additionalInstructions}`;

  // Mutate the description in place to preserve other properties (e.g. provider metadata)
  baseToolRecord.description = augmentedDescription;

  return baseTool;
}

function wrapToolExecuteWithModelOnlyNotifications(
  toolName: string,
  baseTool: Tool,
  engine: NotificationEngine
): Tool {
  // Access the tool as a record to get its properties.
  // eslint-disable-next-line @typescript-eslint/no-explicit-any, local/no-chained-type-assertions -- grandfathered when the rule was introduced; fix the underlying type instead of copying this pattern
  const baseToolRecord = baseTool as any as Record<string, unknown>;
  const originalExecute = baseToolRecord.execute;

  if (typeof originalExecute !== "function") {
    return baseTool;
  }

  const executeFn = originalExecute as (this: unknown, args: unknown, options: unknown) => unknown;

  // Avoid mutating cached tools in place (e.g. MCP tools cached per workspace).
  // Repeated getToolsForModel() calls should not stack wrappers.
  const wrappedTool = cloneToolPreservingDescriptors(baseTool);
  // eslint-disable-next-line @typescript-eslint/no-explicit-any, local/no-chained-type-assertions -- grandfathered when the rule was introduced; fix the underlying type instead of copying this pattern
  const wrappedToolRecord = wrappedTool as any as Record<string, unknown>;

  wrappedToolRecord.execute = async (args: unknown, options: unknown) => {
    try {
      const result: unknown = await executeFn.call(baseTool, args, options);

      let notifications: string[] = [];
      try {
        notifications = await engine.pollAfterToolCall({
          toolName,
          toolSucceeded: true,
          now: Date.now(),
        });
      } catch (error) {
        log.debug("[getToolsForModel] notification poll failed", { error, toolName });
      }

      return attachModelOnlyToolNotifications(result, notifications);
    } catch (error) {
      try {
        await engine.pollAfterToolCall({
          toolName,
          toolSucceeded: false,
          now: Date.now(),
        });
      } catch (pollError) {
        log.debug("[getToolsForModel] notification poll failed", { pollError, toolName });
      }

      throw error;
    }
  };

  return wrappedTool;
}

function wrapToolsWithModelOnlyNotifications(
  tools: Record<string, Tool>,
  config: ToolConfiguration
): Record<string, Tool> {
  if (!config.workspaceSessionDir) {
    return tools;
  }

  const engine = new NotificationEngine([
    new TodoListReminderSource({ workspaceSessionDir: config.workspaceSessionDir }),
  ]);

  const wrappedTools: Record<string, Tool> = {};
  for (const [toolName, tool] of Object.entries(tools)) {
    wrappedTools[toolName] = wrapToolExecuteWithModelOnlyNotifications(toolName, tool, engine);
  }

  return wrappedTools;
}

export { deriveToolHookConfig } from "@/node/services/tools/withHooks";

/**
 * Wrap tools with hook support.
 *
 * If any of these exist, each tool execution is wrapped:
 * - `.xum/tool_pre` (pre-hook)
 * - `.xum/tool_post` (post-hook)
 * - `.xum/tool_hook` (legacy pre+post)
 */
function wrapToolsWithHooks(
  tools: Record<string, Tool>,
  config: ToolConfiguration
): Record<string, Tool> {
  const hookConfig = deriveToolHookConfig(config);
  if (hookConfig === null) {
    return tools;
  }

  const wrappedTools: Record<string, Tool> = {};
  for (const [toolName, tool] of Object.entries(tools)) {
    wrappedTools[toolName] = withHooks(toolName, tool, hookConfig);
  }

  return wrappedTools;
}

async function getDesktopTools(config: ToolConfiguration): Promise<Record<string, Tool>> {
  if (config.desktopSessionManager == null || config.workspaceId == null) {
    return {};
  }

  try {
    const capability = await config.desktopSessionManager.getCapability(config.workspaceId);
    if (!capability.available) {
      return {};
    }

    return createDesktopTools(config, config.desktopSessionManager);
  } catch (error) {
    log.warn("[getToolsForModel] failed to resolve desktop tool capability", {
      error,
      workspaceId: config.workspaceId,
    });
    return {};
  }
}

/**
 * Get tools available for a specific model with configuration
 *
 * Providers are lazy-loaded to reduce startup time. AI SDK providers are only
 * imported when actually needed for a specific model.
 *
 * @param modelString The model string in format "provider:model-id"
 * @param config Required configuration for tools
 * @param workspaceId Workspace ID for init state tracking (required for runtime tools)
 * @param initStateManager Init state manager for runtime tools to wait for initialization
 * @param toolInstructions Optional map of tool names to additional instructions from "Tool: <name>" sections
 * @returns Promise resolving to record of tools available for the model
 */
/**
 * Returns true when an Anthropic model supports webFetch_20250910 (Claude 4.6+).
 *
 * Two-segment IDs:    claude-{variant}-{major}-{minor} (e.g. claude-sonnet-4-6, claude-opus-4-8)
 * Pinned two-segment: claude-{variant}-{major}-{minor}-{date} (e.g. claude-opus-4-6-20260201)
 * Date-based pre-4.6: claude-{variant}-{major}-{date} (e.g. claude-sonnet-4-20250514)
 * Major-only IDs:     claude-{variant}-{major} (e.g. claude-sonnet-5, claude-fable-5,
 *                     claude-mythos-5) — the dateless naming adopted for the 5 generation.
 *
 * The minor segment is optional so major-only IDs (Sonnet 5, Fable 5, Mythos 5, future Opus 5+)
 * are recognized; those are all > 4 and qualify. The variant segment must be alphabetic so older
 * third-generation IDs like claude-3-5-sonnet-20241022 do not get misread as major=5. The \d{1,2}
 * constraint accepts 1-2 digit version numbers (1–99) while rejecting 8-digit date suffixes, so
 * date-based pre-4.6 IDs like claude-sonnet-4-20250514 parse as major=4 / no minor and correctly
 * stay unsupported. The (?:-|$) lookahead allows an optional pinned date to follow.
 */
export function supportsAnthropicNativeWebFetch(modelId: string): boolean {
  const match = /^claude-[a-z]+-(\d+)(?:-(\d{1,2}))?(?:-|$)/.exec(modelId);
  if (!match) return false;
  const major = parseInt(match[1], 10);
  const minor = match[2] != null ? parseInt(match[2], 10) : undefined;
  return major > 4 || (major === 4 && minor !== undefined && minor >= 6);
}

interface XaiWebSearchOptions {
  allowedDomains?: string[];
  excludedDomains?: string[];
}

interface XaiXSearchOptions {
  allowedXHandles?: string[];
  excludedXHandles?: string[];
  fromDate?: string;
  toDate?: string;
}

interface XaiSearchSourceRecord extends Record<string, unknown> {
  type: "web" | "x" | "news" | "rss";
}

function getXaiSearchSources(
  searchParameters: ToolConfiguration["xaiSearchParameters"]
): XaiSearchSourceRecord[] {
  const rawSources = (searchParameters as { sources?: unknown } | undefined)?.sources;
  if (!Array.isArray(rawSources)) {
    return [];
  }

  return rawSources.filter((source): source is XaiSearchSourceRecord => {
    if (typeof source !== "object" || source === null) return false;
    const type = (source as { type?: unknown }).type;
    return type === "web" || type === "x" || type === "news" || type === "rss";
  });
}

function readStringArray(value: unknown): string[] {
  return Array.isArray(value)
    ? value.filter((entry): entry is string => typeof entry === "string")
    : [];
}

function readIsoDate(value: unknown): string | undefined {
  if (typeof value !== "string" || !/^\d{4}-\d{2}-\d{2}$/.test(value)) {
    return undefined;
  }
  const parsed = new Date(`${value}T00:00:00.000Z`);
  return Number.isNaN(parsed.getTime()) || parsed.toISOString().slice(0, 10) !== value
    ? undefined
    : value;
}

function getXaiNativeSearchConfiguration(
  searchParameters: ToolConfiguration["xaiSearchParameters"]
): {
  webSearch?: XaiWebSearchOptions;
  xSearch?: XaiXSearchOptions;
} {
  if (searchParameters?.mode === "off") {
    return {};
  }

  const rawSearchParameters = searchParameters as Record<string, unknown> | undefined;
  const fromDate = readIsoDate(rawSearchParameters?.fromDate);
  const toDate = readIsoDate(rawSearchParameters?.toDate);
  const sources = getXaiSearchSources(searchParameters);
  const webSources = sources.filter((source) => source.type === "web");
  const newsSources = sources.filter((source) => source.type === "news");
  const xSources = sources.filter((source) => source.type === "x");
  const rssDomains = Array.from(
    new Set(
      sources
        .filter((source) => source.type === "rss")
        .flatMap((source) => readStringArray(source.links))
        .map((link) => {
          try {
            return new URL(link).hostname;
          } catch {
            return undefined;
          }
        })
        .filter((domain): domain is string => domain != null)
    )
  );
  const configuredAllowedDomains = Array.from(
    new Set([
      ...webSources.flatMap((source) => readStringArray(source.allowedWebsites)),
      ...rssDomains,
    ])
  );
  const configuredExcludedDomains = Array.from(
    new Set([
      ...webSources.flatMap((source) => readStringArray(source.excludedWebsites)),
      ...newsSources.flatMap((source) => readStringArray(source.excludedWebsites)),
    ])
  );
  const configuredAllowedXHandles = Array.from(
    new Set(
      xSources.flatMap((source) => {
        const included = readStringArray(source.includedXHandles);
        return included.length > 0 ? included : readStringArray(source.xHandles);
      })
    )
  );
  const configuredExcludedXHandles = Array.from(
    new Set(xSources.flatMap((source) => readStringArray(source.excludedXHandles)))
  );
  // Native search caps domain filters at five and X-handle filters at twenty. The
  // installed SDK is patched to match xAI's documented 20-handle limit. Allowed and
  // excluded filters are mutually exclusive, so an allowlist wins after subtracting
  // excluded entries. If a legacy config exceeds a cap, omit that restriction instead
  // of dropping only later source entries and creating a misleading partial translation.
  const effectiveAllowedDomains = configuredAllowedDomains.filter(
    (domain) => !configuredExcludedDomains.includes(domain)
  );
  const allowedDomains =
    effectiveAllowedDomains.length > 0 && effectiveAllowedDomains.length <= 5
      ? effectiveAllowedDomains
      : undefined;
  const excludedDomains =
    allowedDomains == null &&
    configuredExcludedDomains.length > 0 &&
    configuredExcludedDomains.length <= 5
      ? configuredExcludedDomains
      : undefined;
  const effectiveAllowedXHandles = configuredAllowedXHandles.filter(
    (handle) => !configuredExcludedXHandles.includes(handle)
  );
  const allowedXHandles =
    effectiveAllowedXHandles.length > 0 && effectiveAllowedXHandles.length <= 20
      ? effectiveAllowedXHandles
      : undefined;
  const excludedXHandles =
    allowedXHandles == null &&
    configuredExcludedXHandles.length > 0 &&
    configuredExcludedXHandles.length <= 20
      ? configuredExcludedXHandles
      : undefined;
  const hasExplicitSources = sources.length > 0;
  const enableWebSearch =
    !hasExplicitSources ||
    sources.some(
      (source) => source.type === "web" || source.type === "news" || source.type === "rss"
    );
  const enableXSearch = !hasExplicitSources || xSources.length > 0;

  return {
    ...(enableWebSearch && {
      webSearch: {
        ...(allowedDomains != null && { allowedDomains }),
        ...(excludedDomains != null && { excludedDomains }),
      },
    }),
    ...(enableXSearch && {
      xSearch: {
        ...(allowedXHandles != null && { allowedXHandles }),
        ...(excludedXHandles != null && { excludedXHandles }),
        ...(fromDate != null && { fromDate }),
        ...(toDate != null && { toDate }),
      },
    }),
  };
}

export function getForcedXaiSearchToolNames(
  modelString: string,
  searchParameters: ToolConfiguration["xaiSearchParameters"]
): string[] | undefined {
  if (!isGrokFrontierModel(modelString) || searchParameters?.mode !== "on") {
    return undefined;
  }

  const nativeSearch = getXaiNativeSearchConfiguration(searchParameters);
  const toolNames = [
    ...(nativeSearch.webSearch != null ? ["web_search"] : []),
    ...(nativeSearch.xSearch != null ? ["x_search"] : []),
  ];
  return toolNames.length > 0 ? toolNames : undefined;
}

export async function getToolsForModel(
  modelString: string,
  config: ToolConfiguration,
  workspaceId: string,
  initStateManager: InitStateManager,
  toolInstructions?: Record<string, string>,
  mcpTools?: Record<string, Tool>
): Promise<Record<string, Tool>> {
  const capabilityModelString = config.capabilityModelString ?? modelString;
  const [provider, modelId] = modelString.split(":");
  // Provider-native tool availability keys on the RESOLVED capability
  // identity so mappedToModel aliases inherit their base model's native
  // tools (web_search/web_fetch); the raw alias id says nothing about them.
  const capabilityModelId = capabilityModelString.split(":")[1] ?? modelId;

  // Helper to reduce repetition when wrapping runtime tools
  const wrap = <TParameters, TResult>(tool: Tool<TParameters, TResult>) =>
    wrapWithInitWait(tool, workspaceId, initStateManager);

  // Runtime-dependent tools need to wait for workspace initialization
  // Wrap them to handle init waiting centrally instead of in each tool
  const runtimeTools: Record<string, Tool> = {
    file_read: wrap(createFileReadTool(config)),
    attach_file: wrap(createAttachFileTool(config)),
    agent_skill_read: wrap(createAgentSkillReadTool(config)),
    agent_skill_read_file: wrap(createAgentSkillReadFileTool(config)),
    file_edit_replace_string: wrap(createFileEditReplaceStringTool(config)),
    file_edit_insert: wrap(createFileEditInsertTool(config)),
    // DISABLED: file_edit_replace_lines - causes models (particularly GPT-5-Codex)
    // to leave repository in broken state due to issues with concurrent file modifications
    // and line number miscalculations. Use file_edit_replace_string instead.
    // file_edit_replace_lines: wrap(createFileEditReplaceLinesTool(config)),

    // Sub-agent task orchestration (child workspaces)
    task: wrap(createTaskTool(config)),
    task_await: wrap(createTaskAwaitTool(config)),
    task_apply_git_patch: wrap(createTaskApplyGitPatchTool(config)),
    task_send_message: wrap(createTaskSendMessageTool(config)),
    task_retitle: wrap(createTaskRetitleTool(config)),
    task_stop: wrap(createTaskStopTool(config)),
    task_remove: wrap(createTaskRemoveTool(config)),
    task_workspace_lifecycle: wrap(createTaskWorkspaceLifecycleTool(config)),
    task_list: wrap(createTaskListTool(config)),

    // Bash execution (foreground/background). Manage background output via task_await/task_list/task_terminate.
    bash: wrap(createBashTool(config)),

    // Legacy bash process tools (deprecated)
    bash_output: wrap(createBashOutputTool(config)),
    bash_background_list: wrap(createBashBackgroundListTool(config)),
    bash_background_terminate: wrap(createBashBackgroundTerminateTool(config)),

    web_fetch: wrap(createWebFetchTool(config)),
    ...(config.experiments?.tokenBudget
      ? { session_history: wrap(createSessionHistoryTool(config)) }
      : {}),

    // Agent memory (experiment-gated; off => no tool, no context cost)
    ...(config.memoryService && config.experiments?.memory
      ? { memory: wrap(createMemoryTool(config)) }
      : {}),
  };

  // HeartbeatService intentionally skips child task workspaces, and the
  // workspace-heartbeats experiment gates every user-facing way to create schedules.
  const shouldExposeHeartbeatTool =
    config.workspaceHeartbeatService != null &&
    config.experiments?.workspaceHeartbeats === true &&
    !config.enableAgentReport;

  // Non-runtime tools execute immediately (no init wait needed)
  // Note: Tool availability is controlled by agent tool policy (allowlist), not mode checks here.
  const nonRuntimeTools: Record<string, Tool> = {
    mux_agents_read: createXumAgentsReadTool(config),
    mux_agents_write: createXumAgentsWriteTool(config),
    agent_skill_list: createAgentSkillListTool(config),
    agent_skill_write: createAgentSkillWriteTool(config),
    agent_skill_delete: createAgentSkillDeleteTool(config),
    mux_config_read: createXumConfigReadTool(config),
    mux_config_write: createXumConfigWriteTool(config),
    skills_catalog_search: createSkillsCatalogSearchTool(config),
    skills_catalog_read: createSkillsCatalogReadTool(config),
    ...(config.advisorRuntime ? { advisor: createAdvisorTool(config) } : {}),
    ...(config.intuitionRuntime ? { intuition: createIntuitionTool(config) } : {}),
    ...(config.toolSearchRuntime ? { tool_catalog_search: createToolSearchTool(config) } : {}),
    ...(config.mcpPromptRuntime ? { mcp_prompt_get: createMcpPromptGetTool(config) } : {}),
    ...(config.timelineService && config.experiments?.timeline
      ? { timeline_event: createTimelineEventTool(config) }
      : {}),
    ask_user_question: createAskUserQuestionTool(config),
    propose_plan: createProposePlanTool(config),
    // propose_name and propose_status are intentionally NOT registered here —
    // they are only used by the internal workspace-naming path
    // (workspaceTitleGenerator.ts) and the sidebar agent-status path
    // (workspaceStatusGenerator.ts), which create the tool inline. Exposing
    // them in the default toolset would let exec-derived agents see their
    // "call me immediately" descriptions.
    ...(config.workflowService && config.experiments?.dynamicWorkflows
      ? {
          workflow_run: createWorkflowRunTool(config),
          workflow_resume: createWorkflowResumeTool(config),
        }
      : {}),
    ...(config.enableAgentReport ? { agent_report: createAgentReportTool(config) } : {}),
    // RLM family messaging: children talk back to their parent and coordinate with
    // same-parent siblings. Absent unless the child was spawned under the rlm experiment.
    ...(config.enableFamilyMessaging
      ? {
          task_message_parent: createTaskMessageParentTool(config),
          task_message_sibling: createTaskMessageSiblingTool(config),
        }
      : {}),
    ...(shouldExposeHeartbeatTool ? { heartbeat: createHeartbeatTool(config) } : {}),
    ...(config.goalService && config.enableGoalTools?.setGoal
      ? { set_goal: createSetGoalTool(config) }
      : {}),
    ...(config.goalService && config.enableGoalTools?.getGoal
      ? { get_goal: createGetGoalTool(config) }
      : {}),
    ...(config.goalService && config.enableGoalTools?.completeGoal
      ? { complete_goal: createCompleteGoalTool(config) }
      : {}),
    todo_write: createTodoWriteTool(config),
    todo_read: createTodoReadTool(config),
    review_pane_update: createReviewPaneUpdateTool(config),
    review_pane_get: createReviewPaneGetTool(config),
    notify: createNotifyTool(config),
    ...(config.analyticsService
      ? {
          analytics_query: createAnalyticsQueryTool(config),
        }
      : {}),
  };

  const desktopTools = await getDesktopTools(config);

  // Base tools available for all models
  const baseTools: Record<string, Tool> = {
    ...runtimeTools,
    ...nonRuntimeTools,
    ...desktopTools,
  };

  // Try to add provider-specific web search tools if available
  // Lazy-load providers to avoid loading all AI SDKs at startup
  let allTools = { ...baseTools, ...(mcpTools ?? {}) };
  try {
    switch (provider) {
      case "anthropic": {
        const { anthropic } = await import("@ai-sdk/anthropic");

        // webFetch_20250910 was introduced with the Claude 4.6 generation.
        // Sending it to an older model (e.g. claude-sonnet-4-5) causes an API error,
        // so only override web_fetch when the model is >= 4.6.
        //
        // Known limitations when the native override is active:
        // - Cannot reach private/localhost URLs (Anthropic's servers can't see workspace network).
        // - Not bridgeable in the PTC sandbox because provider-native tools have no execute().
        // - Tool hooks (.xum/tool_pre/.xum/tool_post) are skipped because withHooks() returns
        //   early when execute() is absent — same limitation as web_search (provider-native).
        if (supportsAnthropicNativeWebFetch(capabilityModelId)) {
          allTools = {
            ...baseTools,
            ...(mcpTools ?? {}),
            // Provider-specific tool types are compatible with Tool at runtime
            web_search: anthropic.tools.webSearch_20250305({ maxUses: 1000 }) as Tool,
            web_fetch: anthropic.tools.webFetch_20250910({ maxUses: 1000 }) as Tool,
          };
        } else {
          allTools = {
            ...baseTools,
            ...(mcpTools ?? {}),
            web_search: anthropic.tools.webSearch_20250305({ maxUses: 1000 }) as Tool,
          };
        }
        break;
      }

      case "openai": {
        // Sanitize MCP tools for OpenAI's stricter JSON Schema validation.
        // OpenAI's Responses API doesn't support certain schema properties like
        // minLength, maximum, default, etc. that are valid JSON Schema but not
        // accepted by OpenAI's Structured Outputs implementation.
        const sanitizedMcpTools = mcpTools ? sanitizeMCPToolsForOpenAI(mcpTools) : {};

        const useResponsesTools = config.openaiWireFormat !== "chatCompletions";

        // Only add web search for models that support it
        if (
          useResponsesTools &&
          (capabilityModelId.includes("gpt-5") || capabilityModelId.includes("gpt-4"))
        ) {
          const { openai } = await import("@ai-sdk/openai");
          allTools = {
            ...baseTools,
            ...sanitizedMcpTools,
            // Provider-specific tool types are compatible with Tool at runtime
            web_search: openai.tools.webSearch({
              searchContextSize: "high",
            }) as Tool,
          };
        } else {
          // For other OpenAI models (o1, o3, etc.), still use sanitized MCP tools
          allTools = {
            ...baseTools,
            ...sanitizedMcpTools,
          };
        }
        break;
      }

      case "xai": {
        if (isGrokFrontierModel(capabilityModelString) && config.xaiNativeToolsEnabled !== false) {
          const nativeSearch = getXaiNativeSearchConfiguration(config.xaiSearchParameters);
          allTools = {
            ...baseTools,
            ...(mcpTools ?? {}),
            ...(nativeSearch.webSearch != null && {
              web_search: xai.tools.webSearch(nativeSearch.webSearch) as Tool,
            }),
            ...(nativeSearch.xSearch != null && {
              x_search: xai.tools.xSearch(nativeSearch.xSearch) as Tool,
            }),
          };
        }
        break;
      }

      case "google": {
        if (supportsGoogleNativeToolsWithFunctionTools(modelId)) {
          const { google } = await import("@ai-sdk/google");
          allTools = {
            ...baseTools,
            ...(mcpTools ?? {}),
            // Google exposes native Search and URL Context as provider-executed tools for
            // Gemini 3+. These coexist with Xum function tools in the standard streaming API.
            google_search: google.tools.googleSearch({}) as Tool,
            url_context: google.tools.urlContext({}) as Tool,
          };
        }
        break;
      }
    }
  } catch (error) {
    // If tools aren't available, just use base tools
    log.error(`No web search tools available for ${provider}:`, error);
  }

  // Filter tools to the canonical allowlist so system prompt + toolset stay in sync.
  // Include MCP tools even if they're not in getAvailableTools().
  const allowlistedToolNames = new Set(
    getAvailableTools(capabilityModelString, {
      enableAgentReport: config.enableAgentReport,
      enableFamilyMessaging: config.enableFamilyMessaging,
      enableAnalyticsQuery: Boolean(config.analyticsService),
      enableDynamicWorkflows: Boolean(
        config.workflowService && config.experiments?.dynamicWorkflows
      ),
      enableAdvisor: Boolean(config.advisorRuntime),
      enableIntuition: Boolean(config.intuitionRuntime),
      enableSessionHistory: config.experiments?.tokenBudget === true,
      enableMemory: Boolean(config.memoryService && config.experiments?.memory),
      enableTimelineEvent: Boolean(config.timelineService && config.experiments?.timeline),
      enableToolSearch: Boolean(config.toolSearchRuntime),
      enableMcpPromptGet: Boolean(config.mcpPromptRuntime),
      // The Review pane belongs to the user-facing parent workspace. config
      // .enableAgentReport is the canonical "is sub-agent" signal (set true iff
      // the workspace has a parentWorkspaceId), so withhold the review_pane_*
      // tools from sub-agents to keep the toolset in sync with the system prompt.
      enableReviewPane: !config.enableAgentReport,
      // Xum global tools are always created; tool policy (agent frontmatter)
      // controls which agents can actually use them.
      enableMuxGlobalAgentsTools: true,
    })
  );
  for (const toolName of Object.keys(mcpTools ?? {})) {
    allowlistedToolNames.add(toolName);
  }

  allTools = Object.fromEntries(
    Object.entries(allTools).filter(([toolName]) => allowlistedToolNames.has(toolName))
  );

  let finalTools = allTools;
  // Apply tool-specific instructions if provided
  if (toolInstructions) {
    const augmentedTools: Record<string, Tool> = {};
    for (const [toolName, baseTool] of Object.entries(allTools)) {
      const instructions = toolInstructions[toolName];
      if (instructions) {
        augmentedTools[toolName] = augmentToolDescription(baseTool, instructions);
      } else {
        augmentedTools[toolName] = baseTool;
      }
    }
    finalTools = augmentedTools;
  }

  // Apply hook wrapping first (hooks wrap each tool execution)
  finalTools = wrapToolsWithHooks(finalTools, config);

  // Then apply model-only notifications (adds notifications to results)
  finalTools = wrapToolsWithModelOnlyNotifications(finalTools, config);

  // Sort tool names so provider prompt cache prefixes stay byte-identical
  // across turns, even when tool composition sources are assembled in a
  // different order.
  return Object.fromEntries(Object.entries(finalTools).sort(([a], [b]) => a.localeCompare(b)));
}

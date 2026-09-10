import type { AgentSkillDescriptor, AgentSkillIssue } from "@/common/types/agentSkill";
import type {
  WorkspaceChatMessage,
  ChatMuxMessage,
  ProvidersConfigMap,
  WorkspaceStatsSnapshot,
} from "@/common/orpc/types";
import type { MuxMessage } from "@/common/types/message";
import type { ThinkingLevel } from "@/common/types/thinking";
import type { FrontendWorkspaceMetadata } from "@/common/types/workspace";
import type { BackgroundProcessInfo } from "@/common/orpc/schemas/api";
import type { TimelineEvent } from "@/common/orpc/schemas/timeline";
import type { AgentAiDefaults } from "@/common/types/agentAiDefaults";
import type { APIClient } from "@/browser/contexts/API";
import { DEFAULT_MODEL } from "@/common/constants/knownModels";
import { createWorkspace, groupWorkspacesByProject } from "../mocks/workspaces";
import { createStaticChatHandler, createStreamingChatHandler } from "../mocks/chatHandlers";
import type { GitStatusFixture } from "../mocks/git";
import { createMockORPCClient, type MockSessionUsage } from "@/browser/stories/mocks/orpc";
import { collapseRightSidebar, selectWorkspace } from "./uiState";
import { createGitStatusExecutor, type GitDiffFixture } from "./git";

// ═══════════════════════════════════════════════════════════════════════════════
// CHAT HANDLER ADAPTER
// ═══════════════════════════════════════════════════════════════════════════════
export type ChatHandler = (callback: (event: WorkspaceChatMessage) => void) => () => void;

/** Adapts callback-based chat handlers to ORPC onChat format */
export function createOnChatAdapter(chatHandlers: Map<string, ChatHandler>) {
  return (workspaceId: string, emit: (msg: WorkspaceChatMessage) => void) => {
    const handler = chatHandlers.get(workspaceId);
    if (handler) {
      return handler(emit);
    }
    // Default: emit caught-up immediately. Modern backends include hasOlderHistory
    // on full replays; default to false in stories to avoid phantom pagination UI.
    queueMicrotask(() => emit({ type: "caught-up", hasOlderHistory: false }));
    return undefined;
  };
}
// ═══════════════════════════════════════════════════════════════════════════════
// SIMPLE CHAT STORY SETUP
// ═══════════════════════════════════════════════════════════════════════════════

export type BackgroundProcessFixture = BackgroundProcessInfo;

export interface SimpleChatSetupOptions {
  workspaceId?: string;
  workspaceName?: string;
  projectName?: string;
  projectPath?: string;
  messages: ChatMuxMessage[];
  /** Additional child workspaces that should appear alongside the selected chat workspace. */
  additionalWorkspaces?: FrontendWorkspaceMetadata[];
  gitStatus?: GitStatusFixture;
  /** Git diff output for Review tab */
  gitDiff?: GitDiffFixture;
  providersConfig?: ProvidersConfigMap;
  agentAiDefaults?: AgentAiDefaults;
  backgroundProcesses?: BackgroundProcessFixture[];
  /** Session usage data for Costs tab */
  statsTabEnabled?: boolean;
  sessionUsage?: MockSessionUsage;
  /** Mock transcripts for workspace.getSubagentTranscript (taskId -> persisted transcript response). */
  subagentTranscripts?: Map<
    string,
    { messages: MuxMessage[]; model?: string; thinkingLevel?: ThinkingLevel }
  >;
  /** Optional custom chat handler for emitting additional events (e.g., queued-message-changed) */
  onChat?: (workspaceId: string, emit: (msg: WorkspaceChatMessage) => void) => void;
  /** Idle compaction hours for context meter (null = disabled) */
  idleCompactionHours?: number | null;
  /** Route priority for routing-aware stories */
  routePriority?: string[];
  /** Per-model route overrides for routing-aware stories */
  routeOverrides?: Record<string, string>;
  /** Custom executeBash mock (for file viewer stories) */
  executeBash?: (
    workspaceId: string,
    script: string
  ) => Promise<{ success: true; output: string; exitCode: number; wall_duration_ms: number }>;
  /** Available agent skills for the project */
  agentSkills?: AgentSkillDescriptor[];
  /** Agent skills that were discovered but couldn't be loaded (SKILL.md parse errors, etc.) */
  invalidAgentSkills?: AgentSkillIssue[];
  /** Mock log entries for Output tab */
  logEntries?: Array<{
    timestamp: number;
    level: "error" | "warn" | "info" | "debug";
    message: string;
    location: string;
  }>;
  /** Mock clearLogs result */
  clearLogsResult?: { success: boolean; error?: string | null };
  /** Full-width transcript preference returned by the mock config API. */
  chatTranscriptFullWidth?: boolean;
  /** Timeline events served by the mock workspace.timeline endpoints. */
  timelineEvents?: TimelineEvent[];
}

/**
 * Setup a simple chat story with one workspace and messages.
 * Returns an APIClient configured with the mock data.
 */
export function setupSimpleChatStory(opts: SimpleChatSetupOptions): APIClient {
  const workspaceId = opts.workspaceId ?? "ws-chat";
  const projectName = opts.projectName ?? "my-app";
  const projectPath = opts.projectPath ?? `/home/user/projects/${projectName}`;
  const workspaces = [
    createWorkspace({
      id: workspaceId,
      name: opts.workspaceName ?? "feature",
      projectName,
      projectPath,
    }),
    ...(opts.additionalWorkspaces ?? []),
  ];

  const chatHandlers = new Map([[workspaceId, createStaticChatHandler(opts.messages)]]);
  const gitStatus = opts.gitStatus
    ? new Map<string, GitStatusFixture>([[workspaceId, opts.gitStatus]])
    : undefined;
  const gitDiff = opts.gitDiff
    ? new Map<string, GitDiffFixture>([[workspaceId, opts.gitDiff]])
    : undefined;

  // Set localStorage for workspace selection and collapse right sidebar by default
  selectWorkspace(workspaces[0]);
  collapseRightSidebar();

  // Set up background processes map
  const bgProcesses = opts.backgroundProcesses
    ? new Map([[workspaceId, opts.backgroundProcesses]])
    : undefined;

  // Set up session usage map
  const sessionUsageMap = opts.sessionUsage
    ? new Map([[workspaceId, opts.sessionUsage]])
    : undefined;

  // Set up idle compaction hours map
  const idleCompactionHours =
    opts.idleCompactionHours !== undefined
      ? new Map([[projectPath, opts.idleCompactionHours]])
      : undefined;

  // Create onChat handler that combines static messages with custom handler
  const baseOnChat = createOnChatAdapter(chatHandlers);
  const onChat = opts.onChat
    ? (wsId: string, emit: (msg: WorkspaceChatMessage) => void) => {
        const cleanup = baseOnChat(wsId, emit);
        opts.onChat!(wsId, emit);
        return cleanup;
      }
    : baseOnChat;

  // Compose executeBash: use custom if provided, otherwise fall back to git status executor
  const gitStatusExecutor = createGitStatusExecutor(gitStatus, gitDiff);
  const executeBash = opts.executeBash
    ? async (wsId: string, script: string) => {
        // Try custom handler first, fall back to git status executor
        const customResult = await opts.executeBash!(wsId, script);
        if (customResult.output || customResult.exitCode !== 0) {
          return customResult;
        }
        // Fall back to git status executor for git commands
        return gitStatusExecutor(wsId, script);
      }
    : gitStatusExecutor;

  // Return ORPC client
  return createMockORPCClient({
    projects: groupWorkspacesByProject(workspaces),
    workspaces,
    onChat,
    executeBash,
    providersConfig: opts.providersConfig,
    agentAiDefaults: opts.agentAiDefaults,
    routePriority: opts.routePriority,
    routeOverrides: opts.routeOverrides,
    backgroundProcesses: bgProcesses,
    sessionUsage: sessionUsageMap,
    subagentTranscripts: opts.subagentTranscripts,
    idleCompactionHours,
    agentSkills: opts.agentSkills,
    invalidAgentSkills: opts.invalidAgentSkills,
    logEntries: opts.logEntries,
    clearLogsResult: opts.clearLogsResult,
    chatTranscriptFullWidth: opts.chatTranscriptFullWidth,
    timelineEvents: opts.timelineEvents,
  });
}

// ═══════════════════════════════════════════════════════════════════════════════
// STREAMING CHAT STORY SETUP
// ═══════════════════════════════════════════════════════════════════════════════

export interface StreamingChatSetupOptions {
  workspaceId?: string;
  workspaceName?: string;
  projectName?: string;
  messages: ChatMuxMessage[];
  streamingMessageId: string;
  model?: string;
  historySequence: number;
  streamText?: string;
  pendingTool?: { toolCallId: string; toolName: string; args: object };
  gitStatus?: GitStatusFixture;
  statsTabEnabled?: boolean;
}

/**
 * Setup a streaming chat story with active streaming state.
 * Returns an APIClient configured with the mock data.
 */
export function setupStreamingChatStory(opts: StreamingChatSetupOptions): APIClient {
  const workspaceId = opts.workspaceId ?? "ws-streaming";
  const workspaces = [
    createWorkspace({
      id: workspaceId,
      name: opts.workspaceName ?? "feature",
      projectName: opts.projectName ?? "my-app",
    }),
  ];

  const chatHandlers = new Map([
    [
      workspaceId,
      createStreamingChatHandler({
        messages: opts.messages,
        streamingMessageId: opts.streamingMessageId,
        model: opts.model ?? DEFAULT_MODEL,
        historySequence: opts.historySequence,
        streamText: opts.streamText,
        pendingTool: opts.pendingTool,
      }),
    ],
  ]);

  const gitStatus = opts.gitStatus
    ? new Map<string, GitStatusFixture>([[workspaceId, opts.gitStatus]])
    : undefined;

  // Set localStorage for workspace selection and collapse right sidebar by default
  selectWorkspace(workspaces[0]);
  collapseRightSidebar();

  const workspaceStatsSnapshots = new Map<string, WorkspaceStatsSnapshot>();
  if (opts.statsTabEnabled) {
    workspaceStatsSnapshots.set(workspaceId, {
      workspaceId,
      generatedAt: Date.now(),
      active: {
        messageId: opts.streamingMessageId,
        model: "openai:gpt-4o",
        elapsedMs: 2000,
        ttftMs: 200,
        toolExecutionMs: 0,
        modelTimeMs: 2000,
        streamingMs: 1800,
        outputTokens: 100,
        reasoningTokens: 0,
        liveTokenCount: 100,
        liveTPS: 50,
        invalid: false,
        anomalies: [],
      },
      session: {
        totalDurationMs: 0,
        totalToolExecutionMs: 0,
        totalStreamingMs: 0,
        totalTtftMs: 0,
        ttftCount: 0,
        responseCount: 0,
        totalOutputTokens: 0,
        totalReasoningTokens: 0,
        byModel: {},
      },
    });
  }

  // Return ORPC client
  return createMockORPCClient({
    projects: groupWorkspacesByProject(workspaces),
    workspaces,
    onChat: createOnChatAdapter(chatHandlers),
    executeBash: createGitStatusExecutor(gitStatus),
    workspaceStatsSnapshots,
  });
}

// ═══════════════════════════════════════════════════════════════════════════════
// CUSTOM CHAT HANDLER SETUP
// ═══════════════════════════════════════════════════════════════════════════════

export interface CustomChatSetupOptions {
  workspaceId?: string;
  workspaceName?: string;
  projectName?: string;
  providersConfig?: ProvidersConfigMap;
  chatHandler: ChatHandler;
}

/**
 * Setup a chat story with a custom chat handler for special scenarios
 * (e.g., stream errors, custom message sequences).
 * Returns an APIClient configured with the mock data.
 */
export function setupCustomChatStory(opts: CustomChatSetupOptions): APIClient {
  const workspaceId = opts.workspaceId ?? "ws-custom";
  const workspaces = [
    createWorkspace({
      id: workspaceId,
      name: opts.workspaceName ?? "feature",
      projectName: opts.projectName ?? "my-app",
    }),
  ];

  const chatHandlers = new Map([[workspaceId, opts.chatHandler]]);

  // Set localStorage for workspace selection and collapse right sidebar by default
  selectWorkspace(workspaces[0]);
  collapseRightSidebar();

  // Return ORPC client
  return createMockORPCClient({
    projects: groupWorkspacesByProject(workspaces),
    workspaces,
    onChat: createOnChatAdapter(chatHandlers),
    providersConfig: opts.providersConfig,
  });
}

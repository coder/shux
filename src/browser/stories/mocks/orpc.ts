/**
 * Mock ORPC client factory for Storybook stories.
 *
 * Creates a client that matches the AppRouter interface with configurable mock data.
 */
import { DEFAULT_GOAL_DEFAULTS, normalizeGoalDefaults, type GoalDefaults } from "@/constants/goals";
import type { GoalBoardSnapshot } from "@/common/types/goal";
import type { TimelineEvent } from "@/common/orpc/schemas/timeline";
import type {
  MemoryConsolidationRecordPayload,
  MemoryConsolidationStatusPayload,
  MemoryFileInfo,
} from "@/common/orpc/schemas/memory";
import type { APIClient } from "@/browser/contexts/API";
import type {
  AgentDefinitionDescriptor,
  AgentDefinitionPackage,
} from "@/common/types/agentDefinition";
import type { AgentSkillDescriptor, AgentSkillIssue } from "@/common/types/agentSkill";
import type {
  FrontendWorkspaceMetadata,
  WorkspaceActivitySnapshot,
} from "@/common/types/workspace";
import type { ProjectConfig } from "@/node/config";
import {
  DEFAULT_LAYOUT_PRESETS_CONFIG,
  normalizeLayoutPresetsConfig,
  type LayoutPresetsConfig,
} from "@/common/types/uiLayouts";
import type {
  WorkspaceChatMessage,
  ProvidersConfigMap,
  WorkspaceStatsSnapshot,
  ServerAuthSession,
  UpdateStatus,
} from "@/common/orpc/types";
import type { UpdateChannel } from "@/common/types/project";
import type { ProjectGitStatusResult as ApiProjectGitStatusResult } from "@/common/orpc/schemas/api";
import type { MuxMessage } from "@/common/types/message";
import type { ThinkingLevel } from "@/common/types/thinking";
import type { DebugLlmRequestSnapshot } from "@/common/types/debugLlmRequest";
import type { NameGenerationError } from "@/common/types/errors";
import type { Secret } from "@/common/types/secrets";
import type { MCPHttpServerInfo, MCPServerInfo } from "@/common/types/mcp";
import type {
  AgentPluginInstallPreview,
  AgentPluginListItem,
  AgentPluginUpdateCheck,
} from "@/common/orpc/schemas/agentPlugins";
import type { MCPOAuthAuthStatus } from "@/common/types/mcpOauth";
import type { ChatStats } from "@/common/types/chatStats";
import {
  normalizeRuntimeEnablement,
  RUNTIME_ENABLEMENT_IDS,
  type RuntimeEnablementId,
} from "@/common/types/runtime";
import { DEFAULT_RUNTIME_CONFIG } from "@/common/constants/workspace";
import {
  DEFAULT_TASK_SETTINGS,
  normalizeTaskSettings,
  type TaskSettings,
} from "@/common/types/tasks";
import { normalizeAgentAiDefaults, type AgentAiDefaults } from "@/common/types/agentAiDefaults";
import { createAsyncMessageQueue } from "@/common/utils/asyncMessageQueue";
import type {
  CoderInfo,
  CoderListPresetsResult,
  CoderListTemplatesResult,
  CoderListWorkspacesResult,
  CoderPreset,
  CoderTemplate,
  CoderWorkspace,
} from "@/common/orpc/schemas/coder";
import type { CoderWorkspaceArchiveBehavior } from "@/common/config/coderArchiveBehavior";
import type { WorktreeArchiveBehavior } from "@/common/config/worktreeArchiveBehavior";
import {
  normalizeUserPreferences,
  type UserPreferences,
} from "@/common/config/schemas/userPreferences";
import type { z } from "zod";
import type { ProjectRemoveErrorSchema } from "@/common/orpc/schemas/errors";
import { isWorkspaceArchived } from "@/common/utils/archive";
import { getProjectWorkspaceCounts } from "@/common/utils/projectRemoval";

/** Session usage data structure matching SessionUsageFileSchema */
export interface MockSessionUsage {
  byModel: Record<
    string,
    {
      input: { tokens: number; cost_usd?: number };
      cached: { tokens: number; cost_usd?: number };
      cacheCreate: { tokens: number; cost_usd?: number };
      output: { tokens: number; cost_usd?: number };
      reasoning: { tokens: number; cost_usd?: number };
      model?: string;
    }
  >;
  lastRequest?: {
    model: string;
    usage: {
      input: { tokens: number; cost_usd?: number };
      cached: { tokens: number; cost_usd?: number };
      cacheCreate: { tokens: number; cost_usd?: number };
      output: { tokens: number; cost_usd?: number };
      reasoning: { tokens: number; cost_usd?: number };
      model?: string;
    };
    timestamp: number;
  };
  version: 1;
}

export interface MockTerminalSession {
  sessionId: string;
  workspaceId: string;
  cols: number;
  rows: number;
  /** Initial snapshot returned by terminal.attach ({ type: "screenState" }). */
  screenState: string;
  /** Optional live output chunks yielded after screenState ({ type: "output" }). */
  outputChunks?: string[];
}

type MockBackupRoute = keyof APIClient["backup"];
type MockBackupRouteOutput<Route extends MockBackupRoute> = Awaited<
  ReturnType<APIClient["backup"][Route]>
>;
type MockBackupData<Route extends Exclude<MockBackupRoute, "getSettings">> = Extract<
  MockBackupRouteOutput<Route>,
  { success: true }
>["data"];
type MockBackupSettings = NonNullable<MockBackupRouteOutput<"getSettings">>;

type ProjectRemoveError = z.infer<typeof ProjectRemoveErrorSchema>;

export interface MockORPCClientOptions {
  /** Layout presets config for Settings → Layouts stories */
  layoutPresets?: LayoutPresetsConfig;
  /** Agent Plugin installer mock data (Settings → Plugins). */
  agentPlugins?: {
    items?: AgentPluginListItem[];
    updateChecks?: AgentPluginUpdateCheck[];
    /** Returned by agentPlugins.preview; omit to make preview fail. */
    preview?: AgentPluginInstallPreview;
  };
  projects?: Map<string, ProjectConfig>;
  workspaces?: FrontendWorkspaceMetadata[];
  /** Pre-seeded multi-project git status rows keyed by workspace ID. */
  projectGitStatusesByWorkspace?: Map<string, ApiProjectGitStatusResult[]>;
  /** Pre-seeded workspace activity snapshots for sidebar status/streaming stories. */
  workspaceActivitySnapshots?: Record<string, WorkspaceActivitySnapshot>;
  /** Initial backend-synced user preferences for config.getConfig. */
  userPreferences?: UserPreferences;
  /** Initial task settings for config.getConfig (e.g., Settings → Tasks section) */
  taskSettings?: Partial<TaskSettings>;
  /** Initial unified AI defaults for agents (plan/exec/compact + subagents) */
  agentAiDefaults?: AgentAiDefaults;
  /** Agent definitions to expose via agents.list */
  agentDefinitions?: AgentDefinitionDescriptor[];
  /** Coder lifecycle preferences for config.getConfig (e.g., Settings → Coder section) */
  coderWorkspaceArchiveBehavior?: CoderWorkspaceArchiveBehavior;
  /** What to do with xum-managed worktrees when archiving a chat. */
  worktreeArchiveBehavior?: WorktreeArchiveBehavior;
  /** Initial full-width transcript toggle for config.getConfig */
  chatTranscriptFullWidth?: boolean;
  /** Initial runtime enablement for config.getConfig */
  runtimeEnablement?: Record<string, boolean>;
  /** Initial default runtime for config.getConfig (global) */
  defaultRuntime?: RuntimeEnablementId | null;
  /** Initial global heartbeat default prompt for config.getConfig */
  heartbeatDefaultPrompt?: string;
  /** Initial global heartbeat default interval for config.getConfig */
  heartbeatDefaultIntervalMs?: number;
  /** Initial global goal defaults for config.getConfig */
  goalDefaults?: GoalDefaults;
  /**
   * Pre-seeded goal-board snapshots per workspaceId. Stories that want
   * the GoalTab's Upcoming / Completed / Archived sections to render
   * populated (rather than the default empty board) pass a snapshot here
   * keyed by the workspace ID the story uses.
   */
  goalBoardSnapshots?: Map<string, GoalBoardSnapshot>;
  /** Pre-seeded timeline events served to workspace.timeline.list/subscribe for every workspace. */
  timelineEvents?: TimelineEvent[];
  /**
   * Pre-seeded memory files for memory.list (Memory tab / Settings → Memory
   * stories). read/save/delete/setPinned operate on this in-memory set.
   */
  memoryFiles?: MemoryFileInfo[];
  /** Initial dream consolidation status for memory.consolidationStatus. */
  memoryConsolidationStatus?: MemoryConsolidationStatusPayload;
  /** Optional file contents for memory.read keyed by virtual path. */
  memoryFileContents?: Map<string, string>;
  /** Initial updater status for update.onStatus (About dialog stories). */
  updateStatus?: UpdateStatus;
  /** Release channel for update.getChannel. */
  updateChannel?: UpdateChannel;
  /** Initial route priority for config.getConfig */
  routePriority?: string[];
  /** Initial per-model route overrides for config.getConfig */
  routeOverrides?: Record<string, string>;
  /** Per-workspace chat callback. Return messages to emit, or use the callback for streaming. */
  onChat?: (workspaceId: string, emit: (msg: WorkspaceChatMessage) => void) => (() => void) | void;
  /** Mock for executeBash per workspace */
  executeBash?: (
    workspaceId: string,
    script: string
  ) => Promise<{ success: true; output: string; exitCode: number; wall_duration_ms: number }>;
  /** Provider configuration (API keys, base URLs, etc.) */
  providersConfig?: ProvidersConfigMap;
  /** List of available provider names */
  providersList?: string[];
  /** Server auth sessions for Settings → Server Access stories */
  serverAuthSessions?: ServerAuthSession[];
  /** Mock for projects.remove - return typed error to simulate failure */
  onProjectRemove?: (
    projectPath: string
  ) => { success: true; data: undefined } | { success: false; error: ProjectRemoveError };
  /** Override for nameGeneration.generate result (default: success) */
  nameGenerationResult?: { success: false; error: NameGenerationError };
  /** Background processes per workspace */
  backgroundProcesses?: Map<
    string,
    Array<{
      id: string;
      pid: number;
      script: string;
      displayName?: string;
      startTime: number;
      status: "running" | "exited" | "killed" | "failed";
      exitCode?: number;
    }>
  >;
  /** Chat Instructions scratchpads per workspace (Instructions tab / chat decoration). */
  additionalSystemContexts?: Map<string, { content: string; enabled: boolean }>;
  /** Session usage data per workspace (for Costs tab) */
  workspaceStatsSnapshots?: Map<string, WorkspaceStatsSnapshot>;
  /** Global secrets (Settings → Secrets → Global) */
  globalSecrets?: Secret[];
  /** Project secrets per project */
  projectSecrets?: Map<string, Secret[]>;
  /** Terminal sessions to expose via terminal.listSessions + terminal.attach */
  terminalSessions?: MockTerminalSession[];
  sessionUsage?: Map<string, MockSessionUsage>;
  /** Debug snapshot per workspace for the last LLM request modal */
  lastLlmRequestSnapshots?: Map<string, DebugLlmRequestSnapshot | null>;
  /** Mock transcripts for workspace.getSubagentTranscript (taskId -> persisted transcript response). */
  subagentTranscripts?: Map<
    string,
    { messages: MuxMessage[]; model?: string; thinkingLevel?: ThinkingLevel }
  >;
  /** Global MCP server configuration (Settings → MCP) */
  globalMcpServers?: Record<string, MCPServerInfo>;
  /** MCP server configuration per project */
  mcpServers?: Map<string, Record<string, MCPServerInfo>>;
  /** Optional OAuth auth status per MCP server URL (serverUrl -> status) */
  mcpOauthAuthStatus?: Map<string, MCPOAuthAuthStatus>;
  /** MCP workspace overrides per workspace */
  mcpOverrides?: Map<
    string,
    {
      disabledServers?: string[];
      enabledServers?: string[];
      toolAllowlist?: Record<string, string[]>;
    }
  >;
  /** MCP test results - maps server name to tools list or error */
  mcpTestResults?: Map<
    string,
    { success: true; tools: string[] } | { success: false; error: string }
  >;
  /** Custom listBranches implementation (for testing non-git repos) */
  listBranches?: (input: {
    projectPath: string;
  }) => Promise<{ branches: string[]; recommendedTrunk: string | null }>;
  /** Custom runtimeAvailability response (for testing non-git repos) */
  runtimeAvailability?: {
    local: { available: true } | { available: false; reason: string };
    worktree: { available: true } | { available: false; reason: string };
    ssh: { available: true } | { available: false; reason: string };
    docker: { available: true } | { available: false; reason: string };
    devcontainer:
      | { available: true; configs: Array<{ path: string; label: string }>; cliVersion?: string }
      | { available: false; reason: string };
  };
  /** Custom gitInit implementation (for testing git init flow) */
  gitInit?: (input: {
    projectPath: string;
  }) => Promise<{ success: true } | { success: false; error: string }>;
  /** Idle compaction hours per project (null = disabled) */
  idleCompactionHours?: Map<string, number | null>;
  /** Coder CLI availability info */
  coderInfo?: CoderInfo;
  /** Coder templates available for workspace creation */
  coderTemplates?: CoderTemplate[];
  /** Coder presets per template name */
  coderPresets?: Map<string, CoderPreset[]>;
  /** Existing Coder workspaces */
  coderWorkspaces?: CoderWorkspace[];
  /** Override Coder template list result (including error states) */
  coderTemplatesResult?: CoderListTemplatesResult;
  /** Override Coder preset list result per template (including error states) */
  coderPresetsResult?: Map<string, CoderListPresetsResult>;
  /** Override Coder workspace list result (including error states) */
  coderWorkspacesResult?: CoderListWorkspacesResult;
  /** Available agent skills (descriptors) */
  agentSkills?: AgentSkillDescriptor[];
  /** Agent skills that were discovered but couldn't be loaded (SKILL.md parse errors, etc.) */
  invalidAgentSkills?: AgentSkillIssue[];
  /** Xum Governor URL (null = not enrolled) */
  muxGovernorUrl?: string | null;
  /** Whether enrolled with Xum Governor */
  muxGovernorEnrolled?: boolean;
  /** Policy response for policy.get */
  policyResponse?: {
    source: "none" | "env" | "governor";
    status: { state: "disabled" | "enforced" | "blocked"; reason?: string };
    policy: unknown;
  };
  /** Mock log entries for Output tab (subscribeLogs snapshot) */
  logEntries?: Array<{
    timestamp: number;
    level: "error" | "warn" | "info" | "debug";
    message: string;
    location: string;
  }>;
  /** Mock clearLogs result (default: { success: true, error: null }) */
  clearLogsResult?: {
    success: boolean;
    error?: string | null;
  };
  backupSettings?: MockBackupSettings | null;
  backupValidation?: MockBackupData<"validate">;
  backupPreview?: MockBackupData<"preview">;
  backupPush?: MockBackupData<"push">;
  backupRestore?: MockBackupData<"restore">;
  /** Per-workspace runtime statuses for RuntimeStatusStore stories */
  runtimeStatuses?: Map<string, "running" | "stopped" | "unknown" | "unsupported">;
}

interface MockBackgroundProcess {
  id: string;
  pid: number;
  script: string;
  displayName?: string;
  startTime: number;
  status: "running" | "exited" | "killed" | "failed";
  exitCode?: number;
}

type MockMcpServers = Record<string, MCPServerInfo>;

interface MockMcpOverrides {
  disabledServers?: string[];
  enabledServers?: string[];
  toolAllowlist?: Record<string, string[]>;
}

type MockMcpTestResult = { success: true; tools: string[] } | { success: false; error: string };

/**
 * Creates a mock ORPC client for Storybook.
 *
 * Usage:
 * ```tsx
 * const client = createMockORPCClient({
 *   projects: new Map([...]),
 *   workspaces: [...],
 *   onChat: (wsId, emit) => {
 *     emit({ type: "caught-up" });
 *     // optionally return cleanup function
 *   },
 * });
 *
 * return <AppLoader client={client} />;
 * ```
 */
export function createMockORPCClient(options: MockORPCClientOptions = {}): APIClient {
  const {
    projects: providedProjects = new Map<string, ProjectConfig>(),
    workspaces = [],
    projectGitStatusesByWorkspace = new Map<string, ApiProjectGitStatusResult[]>(),
    workspaceActivitySnapshots = {},
    onChat,
    executeBash,
    providersConfig = { anthropic: { apiKeySet: true, isEnabled: true, isConfigured: true } },
    providersList = [],
    serverAuthSessions: initialServerAuthSessions = [],
    onProjectRemove,
    nameGenerationResult,
    backgroundProcesses = new Map<string, MockBackgroundProcess[]>(),
    sessionUsage = new Map<string, MockSessionUsage>(),
    lastLlmRequestSnapshots = new Map<string, DebugLlmRequestSnapshot | null>(),
    subagentTranscripts = new Map<
      string,
      { messages: MuxMessage[]; model?: string; thinkingLevel?: ThinkingLevel }
    >(),
    additionalSystemContexts = new Map<string, { content: string; enabled: boolean }>(),
    workspaceStatsSnapshots = new Map<string, WorkspaceStatsSnapshot>(),
    globalSecrets = [],
    projectSecrets = new Map<string, Secret[]>(),
    terminalSessions: initialTerminalSessions = [],
    globalMcpServers = {},
    agentPlugins: agentPluginsMock,
    mcpServers = new Map<string, MockMcpServers>(),
    mcpOverrides = new Map<string, MockMcpOverrides>(),
    mcpTestResults = new Map<string, MockMcpTestResult>(),
    mcpOauthAuthStatus = new Map<string, MCPOAuthAuthStatus>(),
    userPreferences: initialUserPreferences,
    taskSettings: initialTaskSettings,
    agentAiDefaults: initialAgentAiDefaults,
    coderWorkspaceArchiveBehavior: initialCoderWorkspaceArchiveBehavior = "stop",
    worktreeArchiveBehavior: initialWorktreeArchiveBehavior = "keep",
    chatTranscriptFullWidth: initialChatTranscriptFullWidth = false,
    runtimeEnablement: initialRuntimeEnablement,
    defaultRuntime: initialDefaultRuntime,
    heartbeatDefaultPrompt: initialHeartbeatDefaultPrompt,
    heartbeatDefaultIntervalMs: initialHeartbeatDefaultIntervalMs,
    goalDefaults: initialGoalDefaults,
    goalBoardSnapshots = new Map<string, GoalBoardSnapshot>(),
    timelineEvents = [],
    memoryFiles = [],
    memoryConsolidationStatus,
    memoryFileContents = new Map<string, string>(),
    updateStatus,
    updateChannel = "stable",
    routePriority: initialRoutePriority = ["direct"],
    routeOverrides: initialRouteOverrides = {},
    agentDefinitions: initialAgentDefinitions,
    listBranches: customListBranches,
    gitInit: customGitInit,
    runtimeAvailability: customRuntimeAvailability,
    coderInfo = { state: "unavailable" as const, reason: "missing" as const },
    coderTemplates = [],
    coderPresets = new Map<string, CoderPreset[]>(),
    coderWorkspaces = [],
    coderTemplatesResult,
    coderPresetsResult = new Map<string, CoderListPresetsResult>(),
    coderWorkspacesResult,
    layoutPresets: initialLayoutPresets,
    agentSkills = [],
    invalidAgentSkills = [],
    muxGovernorUrl = null,
    muxGovernorEnrolled = false,
    policyResponse = {
      source: "none" as const,
      status: { state: "disabled" as const },
      policy: null,
    },
    logEntries = [],
    backupSettings: initialBackupSettings,
    backupValidation,
    backupPreview,
    backupPush,
    backupRestore,
    clearLogsResult = { success: true, error: null },
    runtimeStatuses = new Map<string, "running" | "stopped" | "unknown" | "unsupported">(),
  } = options;

  const projects = new Map(providedProjects);
  const workspaceMap = new Map(workspaces.map((w) => [w.id, w]));

  // Terminal sessions are used by RightSidebar and TerminalView.
  // Stories can seed deterministic sessions (with screenState) to make the embedded terminal look
  // data-rich, while still keeping the default mock (no sessions) lightweight.
  const terminalSessionsById = new Map<string, MockTerminalSession>();
  const terminalSessionIdsByWorkspace = new Map<string, string[]>();

  const registerTerminalSession = (session: MockTerminalSession) => {
    terminalSessionsById.set(session.sessionId, session);
    const existing = terminalSessionIdsByWorkspace.get(session.workspaceId) ?? [];
    if (!existing.includes(session.sessionId)) {
      terminalSessionIdsByWorkspace.set(session.workspaceId, [...existing, session.sessionId]);
    }
  };

  for (const session of initialTerminalSessions) {
    registerTerminalSession(session);
  }

  let terminalSessionCounter = initialTerminalSessions.reduce((max, session) => {
    const match = /^mock-terminal-(\d+)$/.exec(session.sessionId);
    if (!match) {
      return max;
    }
    const parsed = Number.parseInt(match[1] ?? "", 10);
    return Number.isFinite(parsed) ? Math.max(max, parsed) : max;
  }, 0);
  const allocTerminalSessionId = () => {
    let nextSessionId = "";
    do {
      terminalSessionCounter += 1;
      nextSessionId = `mock-terminal-${terminalSessionCounter}`;
    } while (terminalSessionsById.has(nextSessionId));
    return nextSessionId;
  };

  let createdWorkspaceCounter = 0;

  const agentDefinitions: AgentDefinitionDescriptor[] =
    initialAgentDefinitions ??
    ([
      {
        id: "plan",
        scope: "built-in",
        name: "Plan",
        description: "Create a plan before coding",
        uiSelectable: true,
        subagentRunnable: false,
        base: "plan",
        uiColor: "var(--color-plan-mode)",
      },
      {
        id: "exec",
        scope: "built-in",
        name: "Exec",
        description: "Implement changes in the repository",
        uiSelectable: true,
        subagentRunnable: true,
        uiColor: "var(--color-exec-mode)",
      },
      {
        id: "compact",
        scope: "built-in",
        name: "Compact",
        description: "History compaction (internal)",
        uiSelectable: false,
        subagentRunnable: false,
      },
      {
        id: "explore",
        scope: "built-in",
        name: "Explore",
        description: "Read-only repository exploration",
        uiSelectable: false,
        subagentRunnable: true,
        base: "exec",
      },
    ] satisfies AgentDefinitionDescriptor[]);

  let userPreferences = normalizeUserPreferences(initialUserPreferences);
  let userPreferencesInitialized = initialUserPreferences !== undefined;
  let taskSettings = normalizeTaskSettings(initialTaskSettings ?? DEFAULT_TASK_SETTINGS);

  let agentAiDefaults = normalizeAgentAiDefaults(initialAgentAiDefaults ?? {});

  let muxGatewayEnabled: boolean | undefined = undefined;
  let muxGatewayModels: string[] | undefined = undefined;
  let coderWorkspaceArchiveBehavior = initialCoderWorkspaceArchiveBehavior;
  let worktreeArchiveBehavior = initialWorktreeArchiveBehavior;
  let chatTranscriptFullWidth = initialChatTranscriptFullWidth;
  let runtimeEnablement: Record<string, boolean> = initialRuntimeEnablement ?? {
    local: true,
    worktree: true,
    ssh: true,
    coder: true,
    docker: true,
    devcontainer: true,
  };

  let defaultRuntime: RuntimeEnablementId | null = initialDefaultRuntime ?? null;
  let heartbeatDefaultPrompt = initialHeartbeatDefaultPrompt;
  let heartbeatDefaultIntervalMs = initialHeartbeatDefaultIntervalMs;
  let goalDefaults = normalizeGoalDefaults(initialGoalDefaults ?? DEFAULT_GOAL_DEFAULTS);
  let routePriority = [...initialRoutePriority];
  let routeOverrides = { ...initialRouteOverrides };
  const configChangeSubscribers = new Set<(value: void) => void>();
  const notifyConfigChanged = () => {
    for (const push of configChangeSubscribers) {
      push(undefined);
    }
  };
  let globalSecretsState: Secret[] = [...globalSecrets];
  const getInjectedGlobalSecretKeys = (projectPath: string): string[] => {
    const normalizedProjectPath = projectPath.trim();
    if (!normalizedProjectPath) {
      return [];
    }

    const projectScopedSecrets = projectSecrets.get(normalizedProjectPath) ?? [];
    const projectScopedKeys = new Set(projectScopedSecrets.map((secret) => secret.key));

    // Match config semantics: for duplicate global keys, the latest entry decides injectAll.
    const latestGlobalByKey = new Map<string, Secret>();
    for (const secret of globalSecretsState) {
      latestGlobalByKey.set(secret.key, secret);
    }

    const injectedKeys: string[] = [];
    for (const [key, secret] of latestGlobalByKey) {
      if (secret.injectAll === true && !projectScopedKeys.has(key)) {
        injectedKeys.push(key);
      }
    }

    return injectedKeys;
  };

  const globalMcpServersState: MockMcpServers = { ...globalMcpServers };

  const defaultConsolidationRecord: MemoryConsolidationRecordPayload = {
    lastRunAt: Date.now() - 30 * 60 * 1000,
    trigger: "manual",
    summary: "Mock consolidation completed",
    ops: [],
  };
  let memoryConsolidationStatusState: MemoryConsolidationStatusPayload =
    memoryConsolidationStatus ?? {
      workspaceRecord: defaultConsolidationRecord,
      projectRecord: defaultConsolidationRecord,
      globalRecord: defaultConsolidationRecord,
      latestHarvestRecord: null,
      projectAvailable: true,
    };
  let memoryFilesState: MemoryFileInfo[] = memoryFiles.map((file) => ({ ...file }));
  const memoryContentsState = new Map<string, { content: string; sha256: string }>(
    [...memoryFileContents].map(([path, content]) => [path, { content, sha256: "mock-sha" }])
  );
  let serverAuthSessionsState: ServerAuthSession[] = initialServerAuthSessions.map((session) => ({
    ...session,
  }));

  let backupSettings: MockBackupSettings | null = initialBackupSettings ?? null;
  const backupValidationResult: MockBackupData<"validate"> = backupValidation ?? {
    reachable: true,
    empty: false,
    credential: "gh",
  };
  const backupPreviewResult: MockBackupData<"preview"> = backupPreview ?? {
    pushChanges: [],
    restoreChanges: [],
    localOnlyFiles: [],
    redactions: [],
    commandApprovals: [],
    projectImports: [],
    projectBundleSkipped: false,
    pushError: null,
  };
  const backupPushResult: MockBackupData<"push"> = backupPush ?? {
    commit: "abc1234",
    changed: true,
    credential: backupValidationResult.credential,
    redactions: [],
  };
  const backupRestoreResult: MockBackupData<"restore"> = backupRestore ?? {
    commit: "def5678",
    snapshotPath: "/tmp/mux-backup-snapshot",
    changedFiles: [],
    localOnlyFiles: [],
    projectImportResults: [],
    projectBundleSkipped: false,
    unapprovedProjectImports: [],
  };

  let layoutPresets = initialLayoutPresets ?? DEFAULT_LAYOUT_PRESETS_CONFIG;

  const mockStats: ChatStats = {
    consumers: [],
    totalTokens: 0,
    model: "mock-model",
    tokenizerName: "mock-tokenizer",
    usageHistory: [],
  };

  // MCP OAuth mock state (used by Settings → MCP OAuth UI)
  let mcpOauthFlowCounter = 0;
  const mcpOauthFlows = new Map<
    string,
    { projectPath: string; serverName: string; pendingServerUrl?: string }
  >();

  const getMcpServerUrl = (projectPath: string, serverName: string): string | undefined => {
    const server = mcpServers.get(projectPath)?.[serverName] ?? globalMcpServersState[serverName];
    if (!server || server.transport === "stdio") {
      return undefined;
    }
    return server.url;
  };

  const getMcpOauthStatus = (projectPath: string, serverName: string): MCPOAuthAuthStatus => {
    const serverUrl = getMcpServerUrl(projectPath, serverName);
    const status = serverUrl ? mcpOauthAuthStatus.get(serverUrl) : undefined;

    if (status) {
      return {
        ...status,
        // Prefer the stored serverUrl, but fall back to current config (helps stories stay minimal).
        serverUrl: status.serverUrl ?? serverUrl,
      };
    }

    return {
      serverUrl,
      isLoggedIn: false,
      hasRefreshToken: false,
    };
  };
  // Cast to ORPCClient - TypeScript can't fully validate the proxy structure
  return {
    tokenizer: {
      countTokens: () => Promise.resolve(0),
      countTokensBatch: (_input: { model: string; texts: string[] }) =>
        Promise.resolve(_input.texts.map(() => 0)),
      calculateStats: () => Promise.resolve(mockStats),
    },
    telemetry: {
      track: () => Promise.resolve(undefined),
      status: () => Promise.resolve({ enabled: true, explicit: false }),
    },
    splashScreens: {
      getViewedSplashScreens: () => Promise.resolve(["onboarding-wizard-v1"]),
      markSplashScreenViewed: () => Promise.resolve(undefined),
    },
    server: {
      getLaunchProject: () => Promise.resolve(null),
      getSshHost: () => Promise.resolve(null),
      setSshHost: () => Promise.resolve(undefined),
    },
    serverAuth: {
      listSessions: () =>
        Promise.resolve(
          [...serverAuthSessionsState]
            .map((session) => ({ ...session }))
            .sort((a, b) => b.lastUsedAtMs - a.lastUsedAtMs)
        ),
      revokeSession: (input: { sessionId: string }) => {
        const beforeCount = serverAuthSessionsState.length;
        serverAuthSessionsState = serverAuthSessionsState.filter(
          (session) => session.id !== input.sessionId
        );

        return Promise.resolve({ removed: serverAuthSessionsState.length < beforeCount });
      },
      revokeOtherSessions: () => {
        const currentSession = serverAuthSessionsState.find((session) => session.isCurrent);
        const beforeCount = serverAuthSessionsState.length;

        if (!currentSession) {
          return Promise.resolve({ revokedCount: 0 });
        }

        serverAuthSessionsState = serverAuthSessionsState.filter(
          (session) => session.id === currentSession.id
        );

        return Promise.resolve({ revokedCount: beforeCount - serverAuthSessionsState.length });
      },
    },
    backup: {
      getSettings: () => Promise.resolve(backupSettings),
      saveSettings: (input: Parameters<APIClient["backup"]["saveSettings"]>[0]) => {
        backupSettings = { ...input };
        notifyConfigChanged();
        return Promise.resolve({ success: true as const, data: backupSettings });
      },
      validate: (_input: Parameters<APIClient["backup"]["validate"]>[0]) =>
        Promise.resolve({ success: true as const, data: backupValidationResult }),
      preview: (_input: Parameters<APIClient["backup"]["preview"]>[0]) =>
        Promise.resolve({ success: true as const, data: backupPreviewResult }),
      push: (_input: Parameters<APIClient["backup"]["push"]>[0]) =>
        Promise.resolve({ success: true as const, data: backupPushResult }),
      restore: (_input: Parameters<APIClient["backup"]["restore"]>[0]) =>
        Promise.resolve({ success: true as const, data: backupRestoreResult }),
    },
    // Settings → Layouts (layout presets)
    // Stored in-memory for Storybook only.
    // Frontend code normalizes the response defensively, but we normalize here too so
    // stories remain stable even if they mutate the config.
    uiLayouts: {
      getAll: () => Promise.resolve(layoutPresets),
      saveAll: (input: { layoutPresets: unknown }) => {
        layoutPresets = normalizeLayoutPresetsConfig(input.layoutPresets);
        return Promise.resolve(undefined);
      },
    },
    config: {
      getConfig: () =>
        Promise.resolve({
          userPreferencesInitialized,
          userPreferences,
          taskSettings,
          muxGatewayEnabled,
          muxGatewayModels,
          routePriority,
          routeOverrides,
          coderWorkspaceArchiveBehavior,
          worktreeArchiveBehavior,
          runtimeEnablement,
          defaultRuntime,
          agentAiDefaults,
          muxGovernorUrl,
          heartbeatDefaultPrompt,
          heartbeatDefaultIntervalMs,
          goalDefaults,
          chatTranscriptFullWidth,
          muxGovernorEnrolled,
          llmDebugLogs: false,
        }),
      saveConfig: (input: {
        taskSettings?: unknown;
        userPreferences?: unknown;
        agentAiDefaults?: unknown;
      }) => {
        if (input.taskSettings != null) {
          taskSettings = normalizeTaskSettings(input.taskSettings);
        }

        if (input.userPreferences !== undefined) {
          userPreferences = normalizeUserPreferences(input.userPreferences);
          userPreferencesInitialized = true;
        }

        if (input.agentAiDefaults !== undefined) {
          agentAiDefaults = normalizeAgentAiDefaults(input.agentAiDefaults);
        }

        notifyConfigChanged();
        return Promise.resolve(undefined);
      },
      onConfigChanged: async function* (_input: void, options?: { signal?: AbortSignal }) {
        const { push, iterate, end } = createAsyncMessageQueue<void>();
        configChangeSubscribers.add(push);

        try {
          if (options?.signal?.aborted) {
            return;
          }

          const abort = () => end();
          options?.signal?.addEventListener("abort", abort, { once: true });
          yield* iterate();
          options?.signal?.removeEventListener("abort", abort);
        } finally {
          configChangeSubscribers.delete(push);
          end();
        }
      },
      updateAgentAiDefaults: (input: { agentAiDefaults: unknown }) => {
        agentAiDefaults = normalizeAgentAiDefaults(input.agentAiDefaults);
        notifyConfigChanged();
        return Promise.resolve(undefined);
      },
      updateMuxGatewayPrefs: (input: {
        muxGatewayEnabled: boolean;
        muxGatewayModels: string[];
      }) => {
        muxGatewayEnabled = input.muxGatewayEnabled ? undefined : false;
        muxGatewayModels = input.muxGatewayModels.length > 0 ? input.muxGatewayModels : undefined;
        notifyConfigChanged();
        return Promise.resolve(undefined);
      },
      updateRoutePreferences: (input: {
        routePriority: string[];
        routeOverrides?: Record<string, string>;
      }) => {
        routePriority = [...input.routePriority];
        routeOverrides = { ...(input.routeOverrides ?? {}) };
        notifyConfigChanged();
        return Promise.resolve(undefined);
      },
      updateChatTranscriptFullWidth: (input: { enabled: boolean }) => {
        chatTranscriptFullWidth = input.enabled;
        notifyConfigChanged();
        return Promise.resolve(undefined);
      },
      updateCoderPrefs: (input: {
        coderWorkspaceArchiveBehavior: CoderWorkspaceArchiveBehavior;
        worktreeArchiveBehavior: WorktreeArchiveBehavior;
      }) => {
        coderWorkspaceArchiveBehavior = input.coderWorkspaceArchiveBehavior;
        worktreeArchiveBehavior = input.worktreeArchiveBehavior;
        notifyConfigChanged();
        return Promise.resolve(undefined);
      },
      updateHeartbeatDefaultPrompt: (input: { defaultPrompt?: string | null }) => {
        heartbeatDefaultPrompt = input.defaultPrompt?.trim()
          ? input.defaultPrompt.trim()
          : undefined;
        notifyConfigChanged();
        return Promise.resolve(undefined);
      },
      updateHeartbeatDefaultIntervalMs: (input: { intervalMs?: number | null }) => {
        heartbeatDefaultIntervalMs = input.intervalMs ?? undefined;
        notifyConfigChanged();
        return Promise.resolve(undefined);
      },
      updateGoalDefaults: (input: { goalDefaults: GoalDefaults }) => {
        goalDefaults = normalizeGoalDefaults(input.goalDefaults);
        notifyConfigChanged();
        return Promise.resolve(undefined);
      },
      updateRuntimeEnablement: (input: {
        projectPath?: string | null;
        runtimeEnablement?: Record<string, boolean> | null;
        defaultRuntime?: RuntimeEnablementId | null;
        runtimeOverridesEnabled?: boolean | null;
      }) => {
        const shouldUpdateRuntimeEnablement = input.runtimeEnablement !== undefined;
        const shouldUpdateDefaultRuntime = input.defaultRuntime !== undefined;
        const shouldUpdateOverridesEnabled = input.runtimeOverridesEnabled !== undefined;
        const projectPath = input.projectPath?.trim();

        const runtimeEnablementOverrides =
          input.runtimeEnablement == null
            ? undefined
            : (() => {
                const normalized = normalizeRuntimeEnablement(input.runtimeEnablement);
                const disabled: Partial<Record<RuntimeEnablementId, false>> = {};

                for (const runtimeId of RUNTIME_ENABLEMENT_IDS) {
                  if (!normalized[runtimeId]) {
                    disabled[runtimeId] = false;
                  }
                }

                return Object.keys(disabled).length > 0 ? disabled : undefined;
              })();

        const runtimeOverridesEnabled = input.runtimeOverridesEnabled === true ? true : undefined;

        if (projectPath) {
          const project = projects.get(projectPath);
          if (project) {
            const nextProject = { ...project };
            if (shouldUpdateRuntimeEnablement) {
              if (runtimeEnablementOverrides) {
                nextProject.runtimeEnablement = runtimeEnablementOverrides;
              } else {
                delete nextProject.runtimeEnablement;
              }
            }

            if (shouldUpdateDefaultRuntime) {
              if (input.defaultRuntime !== null && input.defaultRuntime !== undefined) {
                nextProject.defaultRuntime = input.defaultRuntime;
              } else {
                delete nextProject.defaultRuntime;
              }
            }

            if (shouldUpdateOverridesEnabled) {
              if (runtimeOverridesEnabled) {
                nextProject.runtimeOverridesEnabled = true;
              } else {
                delete nextProject.runtimeOverridesEnabled;
              }
            }
            projects.set(projectPath, nextProject);
          }

          notifyConfigChanged();
          return Promise.resolve(undefined);
        }

        if (shouldUpdateRuntimeEnablement) {
          if (input.runtimeEnablement == null) {
            runtimeEnablement = normalizeRuntimeEnablement({});
          } else {
            runtimeEnablement = normalizeRuntimeEnablement(input.runtimeEnablement);
          }
        }

        if (shouldUpdateDefaultRuntime) {
          defaultRuntime = input.defaultRuntime ?? null;
        }

        notifyConfigChanged();
        return Promise.resolve(undefined);
      },
      unenrollMuxGovernor: () => Promise.resolve(undefined),
    },
    agents: {
      list: (_input: {
        projectPath?: string;
        workspaceId?: string;
        disableWorkspaceAgents?: boolean;
        includeDisabled?: boolean;
      }) => Promise.resolve(agentDefinitions),
      get: (input: {
        projectPath?: string;
        workspaceId?: string;
        disableWorkspaceAgents?: boolean;
        includeDisabled?: boolean;
        agentId: string;
      }) => {
        const descriptor =
          agentDefinitions.find((agent) => agent.id === input.agentId) ?? agentDefinitions[0];

        const agentPackage = {
          id: descriptor.id,
          scope: descriptor.scope,
          frontmatter: {
            name: descriptor.name,
            description: descriptor.description,
            base: descriptor.base,
            ui: { hidden: !descriptor.uiSelectable },
            subagent: { runnable: descriptor.subagentRunnable },
            ai: descriptor.aiDefaults,
            tools: descriptor.tools,
          },
          body: "",
        } satisfies AgentDefinitionPackage;

        return Promise.resolve(agentPackage);
      },
    },
    workflows: {
      // The tray's cold-mount discovery and nested-run liveness poll run in any
      // story that renders chat input; resolve empty so no groups are seeded.
      getRunStatuses: () => Promise.resolve([]),
      listActiveRuns: () => Promise.resolve([]),
    },
    agentSkills: {
      list: () => Promise.resolve(agentSkills),
      listDiagnostics: () =>
        Promise.resolve({ skills: agentSkills, invalidSkills: invalidAgentSkills }),
      get: () =>
        Promise.resolve({
          scope: "built-in" as const,
          directoryName: "mock-skill",
          frontmatter: { name: "mock-skill", description: "Mock skill" },
          body: "",
        }),
    },
    providers: {
      list: () => Promise.resolve(providersList),
      getConfig: () => Promise.resolve(providersConfig),
      setProviderConfig: () => Promise.resolve({ success: true, data: undefined }),
      setModels: () => Promise.resolve({ success: true, data: undefined }),
    },
    muxGateway: {
      getAccountStatus: () =>
        Promise.resolve({
          success: true,
          data: {
            remaining_microdollars: 134_598_127,
            ai_gateway_concurrent_requests_per_user: 20,
          },
        }),
    },
    analytics: {
      getDelegationSummary: (_input: {
        projectPath?: string | null;
        from?: Date | null;
        to?: Date | null;
      }) =>
        Promise.resolve({
          totalChildren: 142,
          totalTokensConsumed: 1_900_000,
          totalReportTokens: 210_000,
          compressionRatio: 9.05,
          totalCostDelegated: 37.42,
          byAgentType: [
            {
              agentType: "explore",
              count: 48,
              totalTokens: 640_000,
              inputTokens: 330_000,
              outputTokens: 220_000,
              reasoningTokens: 50_000,
              cachedTokens: 30_000,
              cacheCreateTokens: 10_000,
            },
            {
              agentType: "exec",
              count: 71,
              totalTokens: 1_010_000,
              inputTokens: 500_000,
              outputTokens: 350_000,
              reasoningTokens: 100_000,
              cachedTokens: 45_000,
              cacheCreateTokens: 15_000,
            },
            {
              agentType: "plan",
              count: 23,
              totalTokens: 250_000,
              inputTokens: 130_000,
              outputTokens: 75_000,
              reasoningTokens: 25_000,
              cachedTokens: 15_000,
              cacheCreateTokens: 5_000,
            },
          ],
        }),
    },
    general: {
      listDirectory: () => Promise.resolve({ entries: [], hasMore: false }),
      restartApp: () => Promise.resolve({ supported: true as const }),
      ping: (input: string) => Promise.resolve(`Pong: ${input}`),
      tick: async function* () {
        // No ticks in the mock, but keep the subscription open.
        yield* [];
        await new Promise<void>(() => undefined);
      },
      subscribeLogs: async function* (input: { level?: string | null }) {
        const LOG_LEVEL_PRIORITY: Record<string, number> = {
          error: 0,
          warn: 1,
          info: 2,
          debug: 3,
        };
        const minPriority = input.level != null ? (LOG_LEVEL_PRIORITY[input.level] ?? 3) : 3;
        const filtered = logEntries.filter(
          (entry) => (LOG_LEVEL_PRIORITY[entry.level] ?? 3) <= minPriority
        );
        yield { type: "snapshot" as const, epoch: 1, entries: filtered };
        await new Promise<void>(() => undefined);
      },
      clearLogs: () => Promise.resolve(clearLogsResult),
    },
    secrets: {
      get: (input?: { projectPath?: string }) => {
        const projectPath = typeof input?.projectPath === "string" ? input.projectPath.trim() : "";
        if (projectPath) {
          return Promise.resolve(projectSecrets.get(projectPath) ?? []);
        }

        return Promise.resolve(globalSecretsState);
      },
      getInjectedGlobals: (input: { projectPath: string }) =>
        Promise.resolve(getInjectedGlobalSecretKeys(input.projectPath)),
      update: (input: { projectPath?: string; secrets: Secret[] }) => {
        const projectPath = typeof input.projectPath === "string" ? input.projectPath.trim() : "";

        if (projectPath) {
          projectSecrets.set(projectPath, input.secrets);
        } else {
          globalSecretsState = input.secrets;
        }

        return Promise.resolve({ success: true, data: undefined });
      },
    },
    agentPlugins: {
      list: () => Promise.resolve({ success: true, data: agentPluginsMock?.items ?? [] }),
      containerLocation: () => Promise.resolve("~/.mux/plugins"),
      checkUpdates: () =>
        Promise.resolve({ success: true, data: agentPluginsMock?.updateChecks ?? [] }),
      preview: () =>
        agentPluginsMock?.preview
          ? Promise.resolve({ success: true, data: agentPluginsMock.preview })
          : Promise.resolve({ success: false, error: "No preview configured in this story" }),
      install: (input: { source: AgentPluginInstallPreview["source"]; expectedSha: string }) =>
        Promise.resolve({
          success: true,
          data: {
            name: agentPluginsMock?.preview?.manifest.name ?? "plugin",
            scope: "global" as const,
            source: input.source,
            lockedSha: input.expectedSha,
            installedAt: new Date().toISOString(),
          },
        }),
      uninstall: () => Promise.resolve({ success: true, data: undefined }),
      update: (input: { name: string }) =>
        Promise.resolve({ success: false, error: `No update mock for '${input.name}'` }),
    },
    mcp: {
      list: (input?: { projectPath?: string }) => {
        const projectPath = typeof input?.projectPath === "string" ? input.projectPath.trim() : "";
        if (projectPath) {
          return Promise.resolve(mcpServers.get(projectPath) ?? globalMcpServersState);
        }

        return Promise.resolve(globalMcpServersState);
      },
      add: (input: {
        name: string;
        transport?: "stdio" | "http" | "sse" | "auto";
        command?: string;
        url?: string;
        headers?: MCPHttpServerInfo["headers"];
      }) => {
        const transport = input.transport ?? "stdio";

        if (transport === "stdio") {
          globalMcpServersState[input.name] = {
            transport: "stdio",
            command: input.command ?? "",
            disabled: false,
          };
        } else {
          globalMcpServersState[input.name] = {
            transport,
            url: input.url ?? "",
            headers: input.headers,
            disabled: false,
          };
        }

        return Promise.resolve({ success: true, data: undefined });
      },
      remove: (input: { name: string }) => {
        delete globalMcpServersState[input.name];
        return Promise.resolve({ success: true, data: undefined });
      },
      test: (input: { projectPath?: string; name?: string }) => {
        if (input.name && mcpTestResults.has(input.name)) {
          return Promise.resolve(mcpTestResults.get(input.name)!);
        }

        // Default: return empty tools.
        return Promise.resolve({ success: true, tools: [] });
      },
      setEnabled: (input: { name: string; enabled: boolean }) => {
        const server = globalMcpServersState[input.name];
        if (server) {
          const disabled = !input.enabled;
          if (server.transport === "stdio") {
            globalMcpServersState[input.name] = { ...server, disabled };
          } else {
            globalMcpServersState[input.name] = { ...server, disabled };
          }
        }
        return Promise.resolve({ success: true, data: undefined });
      },
      setToolAllowlist: (input: { name: string; toolAllowlist: string[] }) => {
        const server = globalMcpServersState[input.name];
        if (server) {
          if (server.transport === "stdio") {
            globalMcpServersState[input.name] = { ...server, toolAllowlist: input.toolAllowlist };
          } else {
            globalMcpServersState[input.name] = { ...server, toolAllowlist: input.toolAllowlist };
          }
        }
        return Promise.resolve({ success: true, data: undefined });
      },
    },
    mcpOauth: {
      getAuthStatus: (input: { serverUrl: string }) => {
        const status = mcpOauthAuthStatus.get(input.serverUrl);
        return Promise.resolve(
          status ?? {
            serverUrl: input.serverUrl,
            isLoggedIn: false,
            hasRefreshToken: false,
          }
        );
      },
      startDesktopFlow: (input: {
        projectPath?: string;
        serverName: string;
        pendingServer?: { transport: "http" | "sse" | "auto"; url: string };
      }) => {
        mcpOauthFlowCounter += 1;
        const flowId = `mock-mcp-oauth-flow-${mcpOauthFlowCounter}`;

        mcpOauthFlows.set(flowId, {
          projectPath: input.projectPath ?? "",
          serverName: input.serverName,
          pendingServerUrl: input.pendingServer?.url,
        });

        return Promise.resolve({
          success: true,
          data: {
            flowId,
            authorizeUrl: `https://example.com/oauth/authorize?flowId=${encodeURIComponent(flowId)}`,
            redirectUri: "mux://oauth/callback",
          },
        });
      },
      waitForDesktopFlow: (input: { flowId: string; timeoutMs?: number }) => {
        const flow = mcpOauthFlows.get(input.flowId);
        if (!flow) {
          return Promise.resolve({ success: false as const, error: "OAuth flow not found." });
        }

        mcpOauthFlows.delete(input.flowId);

        const serverUrl =
          flow.pendingServerUrl ?? getMcpServerUrl(flow.projectPath, flow.serverName);
        if (serverUrl) {
          mcpOauthAuthStatus.set(serverUrl, {
            serverUrl,
            isLoggedIn: true,
            hasRefreshToken: true,
            updatedAtMs: Date.now(),
          });
        }

        return Promise.resolve({ success: true as const, data: undefined });
      },
      cancelDesktopFlow: (input: { flowId: string }) => {
        mcpOauthFlows.delete(input.flowId);
        return Promise.resolve(undefined);
      },
      startServerFlow: (input: {
        projectPath?: string;
        serverName: string;
        pendingServer?: { transport: "http" | "sse" | "auto"; url: string };
      }) => {
        mcpOauthFlowCounter += 1;
        const flowId = `mock-mcp-oauth-flow-${mcpOauthFlowCounter}`;

        mcpOauthFlows.set(flowId, {
          projectPath: input.projectPath ?? "",
          serverName: input.serverName,
          pendingServerUrl: input.pendingServer?.url,
        });

        return Promise.resolve({
          success: true,
          data: {
            flowId,
            authorizeUrl: `https://example.com/oauth/authorize?flowId=${encodeURIComponent(flowId)}`,
            redirectUri: "mux://oauth/callback",
          },
        });
      },
      waitForServerFlow: (input: { flowId: string; timeoutMs?: number }) => {
        const flow = mcpOauthFlows.get(input.flowId);
        if (!flow) {
          return Promise.resolve({ success: false as const, error: "OAuth flow not found." });
        }

        mcpOauthFlows.delete(input.flowId);

        const serverUrl =
          flow.pendingServerUrl ?? getMcpServerUrl(flow.projectPath, flow.serverName);
        if (serverUrl) {
          mcpOauthAuthStatus.set(serverUrl, {
            serverUrl,
            isLoggedIn: true,
            hasRefreshToken: true,
            updatedAtMs: Date.now(),
          });
        }

        return Promise.resolve({ success: true as const, data: undefined });
      },
      cancelServerFlow: (input: { flowId: string }) => {
        mcpOauthFlows.delete(input.flowId);
        return Promise.resolve(undefined);
      },
      logout: (input: { serverUrl: string }) => {
        mcpOauthAuthStatus.set(input.serverUrl, {
          serverUrl: input.serverUrl,
          isLoggedIn: false,
          hasRefreshToken: false,
          updatedAtMs: Date.now(),
        });

        return Promise.resolve({ success: true as const, data: undefined });
      },
    },
    projects: {
      // Mirror the server-side read projection: projects.list excludes archived
      // workspaces (the UI loads them on demand via workspace.list({archived:true})).
      list: () =>
        Promise.resolve(
          Array.from(projects.entries()).map(([projectPath, project]): [string, ProjectConfig] => [
            projectPath,
            {
              ...project,
              workspaces: project.workspaces.filter(
                (workspace) => !isWorkspaceArchived(workspace.archivedAt, workspace.unarchivedAt)
              ),
            },
          ])
        ),
      create: () =>
        Promise.resolve({
          success: true,
          data: { projectConfig: { workspaces: [] }, normalizedPath: "/mock/project" },
        }),
      pickDirectory: () => Promise.resolve(null),
      getDefaultProjectDir: () => Promise.resolve("~/.xum/projects"),
      setDefaultProjectDir: () => Promise.resolve(),
      clone: () =>
        Promise.resolve(
          (function* () {
            yield {
              type: "progress" as const,
              line: "Cloning into '/mock/cloned-project'...\n",
            };
            yield {
              type: "success" as const,
              projectConfig: { workspaces: [] },
              normalizedPath: "/mock/cloned-project",
            };
          })()
        ),
      listBranches: (input: { projectPath: string }) => {
        if (customListBranches) {
          return customListBranches(input);
        }
        return Promise.resolve({
          branches: ["main", "develop", "feature/new-feature"],
          recommendedTrunk: "main",
        });
      },
      runtimeAvailability: () =>
        Promise.resolve(
          customRuntimeAvailability ?? {
            local: { available: true },
            worktree: { available: true },
            ssh: { available: true },
            docker: { available: true },
            devcontainer: { available: false, reason: "No devcontainer.json found" },
          }
        ),
      gitInit: (input: { projectPath: string }) => {
        if (customGitInit) {
          return customGitInit(input);
        }
        return Promise.resolve({ success: true as const });
      },
      // Read-only preflight used by the delete confirmation dialog.
      getRemovalBlockers: (input: { projectPath: string }) => {
        const project = projects.get(input.projectPath);
        return Promise.resolve(getProjectWorkspaceCounts(project?.workspaces ?? []));
      },
      remove: (input: { projectPath: string; force?: boolean | null }) => {
        if (onProjectRemove) {
          return Promise.resolve(onProjectRemove(input.projectPath));
        }
        // Mirror the real backend: a non-forced removal of a project that still
        // has workspaces is rejected with authoritative blocker counts, which
        // the sidebar uses to populate the delete confirmation dialog.
        const project = projects.get(input.projectPath);
        const counts = getProjectWorkspaceCounts(project?.workspaces ?? []);
        if (input.force !== true && counts.activeCount + counts.archivedCount > 0) {
          return Promise.resolve({
            success: false,
            error: { type: "workspace_blockers", ...counts },
          });
        }
        return Promise.resolve({ success: true, data: undefined });
      },
      setTrust: (input: { projectPath: string; trusted: boolean }) => {
        const project = projects.get(input.projectPath);
        if (project) {
          project.trusted = input.trusted;
        }
        return Promise.resolve();
      },
      setDisplayName: (input: { projectPath: string; displayName?: string | null }) => {
        const project = projects.get(input.projectPath);
        if (project) {
          project.displayName = input.displayName ?? undefined;
        }
        return Promise.resolve();
      },
      setCustomInstructions: (input: {
        projectPath: string;
        customInstructions?: string | null;
      }) => {
        const project = projects.get(input.projectPath);
        if (project) {
          project.customInstructions = input.customInstructions?.trim()
            ? input.customInstructions
            : undefined;
        }
        return Promise.resolve();
      },
      secrets: {
        get: (input: { projectPath: string }) =>
          Promise.resolve(projectSecrets.get(input.projectPath) ?? []),
        update: (input: { projectPath: string; secrets: Secret[] }) => {
          projectSecrets.set(input.projectPath, input.secrets);
          return Promise.resolve({ success: true, data: undefined });
        },
      },
      mcp: {
        list: (input: { projectPath: string }) =>
          Promise.resolve(mcpServers.get(input.projectPath) ?? {}),
        add: () => Promise.resolve({ success: true, data: undefined }),
        remove: () => Promise.resolve({ success: true, data: undefined }),
        test: (input: { projectPath: string; name?: string }) => {
          if (input.name && mcpTestResults.has(input.name)) {
            return Promise.resolve(mcpTestResults.get(input.name)!);
          }
          // Default: return empty tools
          return Promise.resolve({ success: true, tools: [] });
        },
        setEnabled: () => Promise.resolve({ success: true, data: undefined }),
        setToolAllowlist: () => Promise.resolve({ success: true, data: undefined }),
      },
      mcpOauth: {
        getAuthStatus: (input: { projectPath: string; serverName: string }) =>
          Promise.resolve(getMcpOauthStatus(input.projectPath, input.serverName)),
        startDesktopFlow: (input: { projectPath: string; serverName: string }) => {
          mcpOauthFlowCounter += 1;
          const flowId = `mock-mcp-oauth-flow-${mcpOauthFlowCounter}`;

          mcpOauthFlows.set(flowId, {
            projectPath: input.projectPath,
            serverName: input.serverName,
          });

          return Promise.resolve({
            success: true,
            data: {
              flowId,
              authorizeUrl: `https://example.com/oauth/authorize?flowId=${encodeURIComponent(flowId)}`,
              redirectUri: "mux://oauth/callback",
            },
          });
        },
        waitForDesktopFlow: (input: { flowId: string; timeoutMs?: number }) => {
          const flow = mcpOauthFlows.get(input.flowId);
          if (!flow) {
            return Promise.resolve({ success: false as const, error: "OAuth flow not found." });
          }

          mcpOauthFlows.delete(input.flowId);

          const serverUrl = getMcpServerUrl(flow.projectPath, flow.serverName);
          if (serverUrl) {
            mcpOauthAuthStatus.set(serverUrl, {
              serverUrl,
              isLoggedIn: true,
              hasRefreshToken: true,
              updatedAtMs: Date.now(),
            });
          }

          return Promise.resolve({ success: true as const, data: undefined });
        },
        cancelDesktopFlow: (input: { flowId: string }) => {
          mcpOauthFlows.delete(input.flowId);
          return Promise.resolve(undefined);
        },
        logout: (input: { projectPath: string; serverName: string }) => {
          const serverUrl = getMcpServerUrl(input.projectPath, input.serverName);
          if (serverUrl) {
            mcpOauthAuthStatus.set(serverUrl, {
              serverUrl,
              isLoggedIn: false,
              hasRefreshToken: false,
              updatedAtMs: Date.now(),
            });
          }

          return Promise.resolve({ success: true as const, data: undefined });
        },
      },
      idleCompaction: {
        get: (input: { projectPath: string }) =>
          Promise.resolve({ hours: options.idleCompactionHours?.get(input.projectPath) ?? null }),
        set: (input: { projectPath: string; hours: number | null }) => {
          if (options.idleCompactionHours) {
            options.idleCompactionHours.set(input.projectPath, input.hours);
          }
          return Promise.resolve({ success: true, data: undefined });
        },
      },
    },
    workspace: {
      list: (input?: { archived?: boolean }) => {
        if (input?.archived) {
          return Promise.resolve(
            workspaces.filter((w) => isWorkspaceArchived(w.archivedAt, w.unarchivedAt))
          );
        }
        return Promise.resolve(
          workspaces.filter((w) => !isWorkspaceArchived(w.archivedAt, w.unarchivedAt))
        );
      },
      preflightArchive: () => Promise.resolve({ success: true, data: { kind: "ready" as const } }),
      archive: () => Promise.resolve({ success: true }),
      unarchive: () => Promise.resolve({ success: true }),
      // Goal mocks: storybook stories don't drive lifecycle, but mounted
      // settings/right-sidebar goal surfaces read current goal state.
      getGoal: () => Promise.resolve({ goal: null }),
      // Per-workspace goal-defaults override; stories don't drive it, but
      // the in-tab `GoalDefaultsSection` reads it on mount via api.workspace.goalDefaults.get.
      goalDefaults: {
        get: () => Promise.resolve(null),
        set: () => Promise.resolve({ success: true, data: undefined }),
      },
      timeline: {
        list: () => Promise.resolve({ events: timelineEvents, nextCursor: null, hasOlder: false }),
        subscribe: () =>
          Promise.resolve(
            (function* () {
              yield {
                type: "snapshot" as const,
                events: timelineEvents,
                nextCursor: null,
                hasOlder: false,
              };
            })()
          ),
        preview: () => Promise.resolve(null),
      },
      // Goal board (multi-goal queue) endpoints. Stories that want the
      // GoalTab's Upcoming / Completed / Archived sections populated
      // pass a snapshot via `goalBoardSnapshots` keyed by workspaceId;
      // everything else falls back to an empty board. The mutation
      // endpoints exist for stories that simulate user interactions
      // (currently none — they resolve voids).
      getGoalBoard: (input: { workspaceId: string }) =>
        Promise.resolve(goalBoardSnapshots.get(input.workspaceId) ?? { entries: [] }),
      addUpcomingGoal: () =>
        Promise.resolve({
          version: 1 as const,
          goalId: "00000000-0000-4000-8000-000000000000",
          objective: "stub",
          status: "paused" as const,
          budgetCents: null,
          turnCap: null,
          costCents: 0,
          turnsUsed: 0,
          attributedChildren: [],
          budgetLimitInjectedForGoalId: null,
          requireUserAcknowledgmentSinceMs: null,
          createdAtMs: Date.now(),
          updatedAtMs: Date.now(),
        }),
      archiveGoal: () => Promise.resolve(undefined),
      reviveArchivedGoal: () => Promise.resolve(undefined),
      reorderUpcomingGoals: () => Promise.resolve(undefined),
      promoteUpcomingGoal: () => Promise.resolve(null),
      updateUpcomingGoal: () => Promise.resolve(null),
      create: (input: { projectPath: string; branchName: string }) => {
        createdWorkspaceCounter += 1;

        return Promise.resolve({
          success: true,
          metadata: {
            id: `ws-created-${createdWorkspaceCounter}`,
            name: input.branchName,
            projectPath: input.projectPath,
            projectName: input.projectPath.split("/").pop() ?? "project",
            namedWorkspacePath: `/mock/workspace/${input.branchName}`,
            runtimeConfig: DEFAULT_RUNTIME_CONFIG,
          },
        });
      },
      createMultiProject: (input: {
        projects: Array<{ projectPath: string; projectName: string }>;
        branchName: string;
      }) => {
        createdWorkspaceCounter += 1;
        const primaryProject = input.projects[0];
        const projectName = input.projects.map((project) => project.projectName).join("+");
        return Promise.resolve({
          id: `ws-created-${createdWorkspaceCounter}`,
          name: input.branchName,
          projectPath: primaryProject?.projectPath ?? "",
          projectName,
          projects: input.projects,
          namedWorkspacePath: `/mock/workspace/_workspaces/${input.branchName}`,
          runtimeConfig: DEFAULT_RUNTIME_CONFIG,
        });
      },
      remove: () => Promise.resolve({ success: true }),
      updateAgentAISettings: () => Promise.resolve({ success: true, data: undefined }),
      updateModeAISettings: () => Promise.resolve({ success: true, data: undefined }),
      updateTitle: () => Promise.resolve({ success: true, data: undefined }),
      rename: (input: { workspaceId: string }) =>
        Promise.resolve({
          success: true,
          data: { newWorkspaceId: input.workspaceId },
        }),
      fork: () => Promise.resolve({ success: false, error: "Not implemented in mock" }),
      sendMessage: () => Promise.resolve({ success: true, data: undefined }),
      resumeStream: () => Promise.resolve({ success: true, data: { started: true } }),
      setAutoRetryEnabled: () =>
        Promise.resolve({
          success: true,
          data: { previousEnabled: true, enabled: true },
        }),
      getStartupAutoRetryModel: () => Promise.resolve({ success: true, data: null }),
      setAutoCompactionThreshold: () => Promise.resolve({ success: true, data: undefined }),
      interruptStream: () => Promise.resolve({ success: true, data: undefined }),
      setQueuedMessageDispatchMode: () => Promise.resolve({ success: true, data: true }),
      clearQueue: () => Promise.resolve({ success: true, data: undefined }),
      truncateHistory: () => Promise.resolve({ success: true, data: undefined }),
      replaceChatHistory: () => Promise.resolve({ success: true, data: undefined }),
      getInfo: (input: { workspaceId: string }) =>
        Promise.resolve(workspaceMap.get(input.workspaceId) ?? null),
      getLastLlmRequest: (input: { workspaceId: string }) =>
        Promise.resolve({
          success: true,
          data: lastLlmRequestSnapshots.get(input.workspaceId) ?? null,
        }),
      getSubagentTranscript: (input: { workspaceId?: string; taskId: string }) =>
        Promise.resolve(subagentTranscripts.get(input.taskId) ?? { messages: [] }),
      getPostCompactionState: () =>
        Promise.resolve({ planPath: null, trackedFilePaths: [], excludedItems: [] }),
      setPostCompactionExclusion: () =>
        Promise.resolve({ success: true as const, data: undefined }),
      executeBash: async (input: { workspaceId: string; script: string }) => {
        if (executeBash) {
          const result = await executeBash(input.workspaceId, input.script);
          return { success: true, data: result };
        }
        return {
          success: true,
          data: { success: true, output: "", exitCode: 0, wall_duration_ms: 0 },
        };
      },
      getRuntimeStatuses: (input: { workspaceIds: string[] }) => {
        const statuses: Record<string, "running" | "stopped" | "unknown" | "unsupported"> = {};
        for (const id of input.workspaceIds) {
          statuses[id] = runtimeStatuses.get(id) ?? "unsupported";
        }
        return Promise.resolve(statuses);
      },
      getProjectGitStatuses: (input: { workspaceId: string; baseRef?: string | null }) =>
        Promise.resolve(
          (projectGitStatusesByWorkspace.get(input.workspaceId) ?? []).map((row) => ({
            ...row,
            gitStatus: row.gitStatus ? { ...row.gitStatus } : row.gitStatus,
          }))
        ),
      stopRuntime: () => Promise.resolve({ success: true as const, data: undefined }),
      onChat: async function* (input: { workspaceId: string }, options?: { signal?: AbortSignal }) {
        if (!onChat) {
          // Default mock behavior: subscriptions should remain open.
          // If this ends, WorkspaceStore will retry and reset state, which flakes stories.
          const caughtUp: WorkspaceChatMessage = { type: "caught-up", hasOlderHistory: false };
          yield caughtUp;

          await new Promise<void>((resolve) => {
            if (options?.signal?.aborted) {
              resolve();
              return;
            }
            options?.signal?.addEventListener("abort", () => resolve(), { once: true });
          });
          return;
        }

        const { push, iterate, end } = createAsyncMessageQueue<WorkspaceChatMessage>();

        // Call the user's onChat handler
        const cleanup = onChat(input.workspaceId, push);

        try {
          yield* iterate();
        } finally {
          end();
          cleanup?.();
        }
      },
      onMetadata: async function* () {
        // No metadata updates in the mock, but keep the subscription open.
        yield* [];
        await new Promise<void>(() => undefined);
      },
      activity: {
        list: () => Promise.resolve(workspaceActivitySnapshots),
        subscribe: async function* () {
          yield* [];
          await new Promise<void>(() => undefined);
        },
      },
      backgroundBashes: {
        subscribe: async function* (input: { workspaceId: string }) {
          // Yield initial state
          yield {
            processes: backgroundProcesses.get(input.workspaceId) ?? [],
            foregroundToolCallIds: [],
          };
          // Then hang forever (like a real subscription)
          await new Promise<void>(() => undefined);
        },
        terminate: () => Promise.resolve({ success: true, data: undefined }),
        getOutput: (input: { fromOffset?: number }) => {
          // Return sample output on the initial tail read only; follow-up polls
          // (fromOffset set) return nothing so the dialog doesn't grow forever.
          const sample =
            input.fromOffset === undefined
              ? Array.from({ length: 120 }, (_, i) => `[dev] GET /api/items/${i} 200 in 12ms`).join(
                  "\n"
                )
              : "";
          return Promise.resolve({
            success: true,
            data: {
              status: "running" as const,
              output: sample,
              nextOffset: sample.length,
              truncatedStart: false,
            },
          });
        },
        sendToBackground: () => Promise.resolve({ success: true, data: undefined }),
      },
      stats: {
        subscribe: async function* (input: { workspaceId: string }) {
          const snapshot = workspaceStatsSnapshots.get(input.workspaceId);
          if (snapshot) {
            yield snapshot;
          }
          await new Promise<void>(() => undefined);
        },
        clear: (input: { workspaceId: string }) => {
          workspaceStatsSnapshots.delete(input.workspaceId);
          return Promise.resolve({ success: true, data: undefined });
        },
      },
      getSessionUsage: (input: { workspaceId: string }) =>
        Promise.resolve(sessionUsage.get(input.workspaceId)),
      getSessionUsageBatch: (input: { workspaceIds: string[] }) => {
        const result: Record<string, MockSessionUsage | undefined> = {};
        for (const id of input.workspaceIds) {
          result[id] = sessionUsage.get(id);
        }
        return Promise.resolve(result);
      },
      getInstructions: (input: { workspaceId: string; model?: string | null }) =>
        Promise.resolve({
          workspaceId: input.workspaceId,
          model: input.model ?? null,
          additionalSystemContext: additionalSystemContexts.get(input.workspaceId) ?? {
            content: "",
            enabled: true,
          },
          sources: { global: [], context: [] },
          files: [],
          totalTokens: null,
        }),
      getAdditionalSystemContext: (input: { workspaceId: string }) =>
        Promise.resolve(
          additionalSystemContexts.get(input.workspaceId) ?? { content: "", enabled: true }
        ),
      setAdditionalSystemContext: (input: {
        workspaceId: string;
        content: string;
        enabled: boolean;
      }) => {
        if (input.content.length === 0) {
          additionalSystemContexts.delete(input.workspaceId);
        } else {
          additionalSystemContexts.set(input.workspaceId, {
            content: input.content,
            enabled: input.enabled,
          });
        }
        return Promise.resolve({ content: input.content, enabled: input.enabled });
      },
      mcp: {
        get: (input: { workspaceId: string }) =>
          Promise.resolve({
            overrides: mcpOverrides.get(input.workspaceId) ?? {},
            revision: "mock-revision",
          }),
        set: (input: {
          workspaceId: string;
          overrides: MockMcpOverrides;
          expectedRevision: string;
        }) => {
          mcpOverrides.set(input.workspaceId, input.overrides);
          return Promise.resolve({ success: true, data: undefined });
        },
      },
      getFileCompletions: (input: { workspaceId: string; query: string; limit?: number }) => {
        // Mock file paths for storybook - simulate typical project structure
        const mockPaths = [
          "src/browser/features/ChatInput/index.tsx",
          "src/browser/features/ChatInput/CommandSuggestions.tsx",
          "src/browser/App.tsx",
          "src/browser/hooks/usePersistedState.ts",
          "src/browser/contexts/WorkspaceContext.tsx",
          "src/common/utils/atMentions.ts",
          "src/common/orpc/types.ts",
          "src/node/services/workspaceService.ts",
          "package.json",
          "tsconfig.json",
          "README.md",
        ];
        const query = input.query.toLowerCase();
        const filtered = mockPaths.filter((p) => p.toLowerCase().includes(query));
        return Promise.resolve({ paths: filtered.slice(0, input.limit ?? 20) });
      },
    },
    window: {
      setTitle: () => Promise.resolve(undefined),
    },
    coder: {
      getInfo: () => Promise.resolve(coderInfo),
      listTemplates: () =>
        Promise.resolve(coderTemplatesResult ?? { ok: true, templates: coderTemplates }),
      listPresets: (input: { template: string }) =>
        Promise.resolve(
          coderPresetsResult.get(input.template) ?? {
            ok: true,
            presets: coderPresets.get(input.template) ?? [],
          }
        ),
      listWorkspaces: () =>
        Promise.resolve(coderWorkspacesResult ?? { ok: true, workspaces: coderWorkspaces }),
    },
    nameGeneration: {
      generate: () => {
        if (nameGenerationResult) {
          return Promise.resolve(nameGenerationResult);
        }
        return Promise.resolve({
          success: true as const,
          data: { name: "generated-workspace", title: "Generated Workspace", modelUsed: "mock" },
        });
      },
    },
    terminal: {
      activity: {
        subscribe: async function* (_input?: void, opts?: { signal?: AbortSignal }) {
          yield { type: "snapshot" as const, workspaces: {} };
          await new Promise<void>((resolve) => {
            if (opts?.signal?.aborted) {
              resolve();
              return;
            }
            opts?.signal?.addEventListener("abort", () => resolve(), { once: true });
          });
        },
      },
      listSessions: (input: { workspaceId: string }) =>
        Promise.resolve(terminalSessionIdsByWorkspace.get(input.workspaceId) ?? []),
      create: (input: {
        workspaceId: string;
        cols: number;
        rows: number;
        initialCommand?: string;
      }) => {
        const sessionId = allocTerminalSessionId();
        registerTerminalSession({
          sessionId,
          workspaceId: input.workspaceId,
          cols: input.cols,
          rows: input.rows,
          // Leave the terminal visually empty by default; data-rich stories can override via
          // MockTerminalSession.screenState.
          screenState: "",
        });

        return Promise.resolve({
          sessionId,
          workspaceId: input.workspaceId,
          cols: input.cols,
          rows: input.rows,
        });
      },
      close: (input: { sessionId: string }) => {
        const session = terminalSessionsById.get(input.sessionId);
        if (session) {
          terminalSessionsById.delete(input.sessionId);
          const ids = terminalSessionIdsByWorkspace.get(session.workspaceId) ?? [];
          terminalSessionIdsByWorkspace.set(
            session.workspaceId,
            ids.filter((id) => id !== input.sessionId)
          );
        }
        return Promise.resolve(undefined);
      },
      resize: (input: { sessionId: string; cols: number; rows: number }) => {
        const session = terminalSessionsById.get(input.sessionId);
        if (session) {
          terminalSessionsById.set(input.sessionId, {
            ...session,
            cols: input.cols,
            rows: input.rows,
          });
        }
        return Promise.resolve(undefined);
      },
      sendInput: () => undefined,
      attach: async function* (input: { sessionId: string }, opts?: { signal?: AbortSignal }) {
        const session = terminalSessionsById.get(input.sessionId);
        yield { type: "screenState", data: session?.screenState ?? "" };

        for (const chunk of session?.outputChunks ?? []) {
          yield { type: "output", data: chunk };
        }

        // Keep the iterator alive until the caller aborts. The real backend streams output
        // indefinitely; Storybook uses abort to clean up on story change.
        if (opts?.signal) {
          if (opts.signal.aborted) {
            return;
          }
          await new Promise<void>((resolve) => {
            opts.signal?.addEventListener("abort", () => resolve(), { once: true });
          });
          return;
        }

        await new Promise<void>(() => undefined);
      },
      onExit: async function* (_input: { sessionId: string }, opts?: { signal?: AbortSignal }) {
        yield* [];
        if (opts?.signal) {
          if (opts.signal.aborted) {
            return;
          }
          await new Promise<void>((resolve) => {
            opts.signal?.addEventListener("abort", () => resolve(), { once: true });
          });
          return;
        }

        await new Promise<void>(() => undefined);
      },
      openWindow: () => Promise.resolve(undefined),
      closeWindow: () => Promise.resolve(undefined),
      openNative: () => Promise.resolve(undefined),
    },
    update: {
      check: () => Promise.resolve(undefined),
      download: () => Promise.resolve(undefined),
      install: () => Promise.resolve(undefined),
      onStatus: async function* () {
        if (updateStatus) yield updateStatus;
        await new Promise<void>(() => undefined);
      },
      getChannel: () => Promise.resolve(updateChannel),
      setChannel: () => Promise.resolve(undefined),
    },
    policy: {
      get: () => Promise.resolve(policyResponse),
      onChanged: async function* () {
        yield* [];
        await new Promise<void>(() => undefined);
      },
      refreshNow: () => Promise.resolve({ success: true as const, value: policyResponse }),
    },
    // Memory curation surfaces (Memory tab / Settings → Memory). Backed by
    // the `memoryFiles` option; mutations update the in-memory set so
    // pin/delete/save interactions render plausibly in Storybook.
    memory: {
      list: () =>
        Promise.resolve({
          success: true as const,
          data: { files: memoryFilesState.map((file) => ({ ...file })) },
        }),
      read: (input: { path: string }) =>
        Promise.resolve({
          success: true as const,
          data: memoryContentsState.get(input.path) ?? {
            content: `Mock memory content for ${input.path}\n`,
            sha256: "mock-sha",
          },
        }),
      save: (input: { path: string; content: string }) => {
        memoryContentsState.set(input.path, {
          content: input.content,
          sha256: `mock-sha-${memoryContentsState.size + 1}`,
        });
        return Promise.resolve({
          success: true as const,
          data: { sha256: memoryContentsState.get(input.path)!.sha256 },
        });
      },
      delete: (input: { path: string }) => {
        memoryFilesState = memoryFilesState.filter((file) => file.path !== input.path);
        return Promise.resolve({ success: true as const, data: undefined });
      },
      setPinned: (input: { path: string; pinned: boolean }) => {
        memoryFilesState = memoryFilesState.map((file) =>
          file.path === input.path ? { ...file, pinned: input.pinned } : file
        );
        return Promise.resolve({ success: true as const, data: undefined });
      },
      consolidationStatus: () =>
        Promise.resolve({
          success: true as const,
          data: memoryConsolidationStatusState,
        }),
      consolidate: () => {
        const record: MemoryConsolidationRecordPayload = {
          lastRunAt: Date.now(),
          trigger: "manual",
          summary: "Mock manual consolidation completed",
          ops: [],
        };
        memoryConsolidationStatusState = {
          workspaceRecord: record,
          projectRecord: memoryConsolidationStatusState.projectAvailable ? record : null,
          globalRecord: record,
          latestHarvestRecord: memoryConsolidationStatusState.latestHarvestRecord,
          projectAvailable: memoryConsolidationStatusState.projectAvailable,
        };
        return Promise.resolve({ success: true as const, data: record });
      },
      onChange: async function* () {
        yield* [];
        await new Promise<void>(() => undefined);
      },
    },
    muxGovernorOauth: {
      startDesktopFlow: () =>
        Promise.resolve({
          success: true as const,
          value: {
            flowId: "mock-flow-id",
            authorizeUrl: "https://governor.example.com/oauth/authorize",
            redirectUri: "http://localhost:12345/callback",
          },
        }),
      waitForDesktopFlow: () =>
        // Never resolves - user would complete in browser
        new Promise(() => undefined),
      cancelDesktopFlow: () => Promise.resolve(undefined),
    },
  } as unknown as APIClient;
}

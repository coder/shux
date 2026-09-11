import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import path from "node:path";
import type {
  Agent,
  AgentSideConnection,
  AuthenticateRequest,
  AuthenticateResponse,
  CancelNotification,
  ContentBlock,
  ForkSessionRequest,
  ForkSessionResponse,
  InitializeRequest,
  InitializeResponse,
  ListSessionsRequest,
  ListSessionsResponse,
  LoadSessionRequest,
  LoadSessionResponse,
  NewSessionRequest,
  NewSessionResponse,
  PromptRequest,
  PromptResponse,
  ResumeSessionRequest,
  ResumeSessionResponse,
  SetSessionConfigOptionRequest,
  SetSessionConfigOptionResponse,
  Usage,
} from "@agentclientprotocol/sdk";
import { RequestError } from "@agentclientprotocol/sdk";
import { resolveXumEnvironmentValue } from "@/common/compat/legacyMux";
import { XUM_PRODUCT_SLUG } from "@/common/constants/product";
import { STOP_UNRECORDED_MESSAGE } from "@/common/constants/workspace";
import {
  DEFAULT_COMPACTION_WORD_TARGET,
  WORDS_TO_TOKENS_RATIO,
  buildCompactionPrompt,
} from "@/common/constants/ui";
import { execFileAsync } from "@/node/utils/disposableExec";
import { RuntimeConfigSchema } from "@/common/orpc/schemas";
import type { OnChatMode, SendMessageOptions, WorkspaceChatMessage } from "@/common/orpc/types";
import type { AgentSkillDescriptor } from "@/common/types/agentSkill";
import type { CompactionRequestData } from "@/common/types/message";
import { buildAgentSkillMetadata } from "@/common/types/message";
import { isWorktreeRuntime, type RuntimeConfig, type RuntimeMode } from "@/common/types/runtime";
import type { ProjectConfig } from "@/common/types/project";
import {
  deriveProjectHierarchy,
  isPathDescendant,
  resolveWorkspaceCreationScope,
} from "@/common/utils/subProjects";
import { createAsyncMessageQueue } from "@/common/utils/asyncMessageQueue";
import { negotiateCapabilities, type NegotiatedCapabilities } from "./capabilities";
import { buildConfigOptions, handleSetConfigOption } from "./configOptions";
import { forkSessionFromWorkspace } from "./experimental/sessionFork";
import {
  canonicalizePathForWorkspaceMatch,
  loadSessionFromWorkspace,
} from "./experimental/sessionResume";
import { convertToAcpUsage } from "./experimental/sessionUsage";
import {
  resolveAcpAgentAiSettings,
  resolveAgentAiSettings,
  type ResolvedAiSettings,
} from "./resolveAgentAiSettings";
import { targetWorkspaceBucketToLayer } from "@/common/types/agentAiSettings";
import { InvalidExplicitAiSettingError } from "@/common/utils/ai/resolveAgentAiSettings";
import type { ServerConnection } from "./serverConnection";
import { SessionManager } from "./sessionManager";
import {
  buildAcpAvailableCommands,
  mapSkillsByName,
  parseAcpSlashCommand,
  type ParsedAcpSlashCommand,
} from "./slashCommands";
import { StreamTranslator } from "./streamTranslator";
import { ToolRouter } from "./toolRouter";

const DEFAULT_AGENT_ID = "exec";
const DEFAULT_BRANCH_PREFIX = "acp";
const DEFAULT_TRUNK_BRANCH = "main";
const DEFAULT_COMMAND_STOP_REASON: PromptResponse["stopReason"] = "end_turn";
const ON_CHAT_MODE_FULL: OnChatMode = { type: "full" };
const ON_CHAT_MODE_LIVE: OnChatMode = { type: "live" };
const SESSION_LIST_PAGE_SIZE = 100;

const ACP_PROMPT_CORRELATION_MUX_METADATA_KEY = "acpPromptId";
const ACP_DELEGATED_TOOLS_MUX_METADATA_KEY = "acpDelegatedTools";
const ACP_DELEGATION_CANDIDATE_TOOLS = [
  "file_read",
  "file_write",
  "file_edit_replace_string",
  "file_edit_insert",
  "bash",
] as const;
const DEFAULT_DISCONNECT_CLEANUP_MAX_WAIT_MS = 10_000;
/**
 * Xum does not implement the session/close RPC yet. Keep idle sessions bounded so
 * long-lived editor connections cannot leak subscriptions and per-session caches forever.
 */
const DEFAULT_SESSION_IDLE_TTL_MS = 30 * 60 * 1000;
const DEFAULT_MAX_TRACKED_SESSIONS = 24;
const DEFAULT_TURN_CORRELATION_TIMEOUT_MS = 30_000;

const MAX_BUFFERED_CHAT_EVENTS = 5_000;

interface MuxAgentOptions {
  disconnectCleanupMaxWaitMs?: number;
  sessionIdleTtlMs?: number;
  maxTrackedSessions?: number;
  turnCorrelationTimeoutMs?: number;
}

interface SessionState {
  workspaceId: string;
  runtimeMode: RuntimeMode;
  agentId: string;
  aiSettings: ResolvedAiSettings;
}

interface AcpWorkspaceCreationScope {
  projectPath: string;
  subProjectPath?: string;
}

interface NewSessionWorkspaceLifecycle {
  hasPromptActivity: boolean;
}

interface TurnResult {
  stopReason: PromptResponse["stopReason"];
  usage?: Usage;
}

interface TurnCompletion {
  resolve: (result: TurnResult) => void;
  reject: (error: Error) => void;
  /** Stable per-prompt correlation id injected into send options and stream events. */
  promptCorrelationId: string;
  /** Monotonic wall-clock when prompt() registered this turn. */
  startedAtMs: number;
  /**
   * Wall-clock when workspace.sendMessage was dispatched for this turn.
   * Used to avoid binding fallback stream-start events emitted before prompt dispatch.
   */
  dispatchedAtMs?: number;
  /** Inactivity timer so idle prompt turns cannot hang forever. */
  timeoutHandle: ReturnType<typeof setTimeout>;
  /** Set after stream-start; only this message id may resolve/reject the turn. */
  messageId?: string;
}

interface ParsedMuxMeta {
  projectPath?: string;
  branchName?: string;
  trunkBranch?: string;
  title?: string;
  runtimeConfig?: RuntimeConfig;
  agentId?: string;
  forkName?: string;
}

type MetaRecord = Record<string, unknown>;

type WorkspaceInfo = NonNullable<
  Awaited<ReturnType<ServerConnection["client"]["workspace"]["getInfo"]>>
>;
// NonNullable: the null read-failure signal is normalized to {} at the call site.
type WorkspaceActivityById = NonNullable<
  Awaited<ReturnType<ServerConnection["client"]["workspace"]["activity"]["list"]>>
>;

export class MuxAgent implements Agent {
  private readonly sessionManager = new SessionManager();
  private readonly streamTranslator: StreamTranslator;
  private readonly toolRouter: ToolRouter;

  private negotiatedCapabilities: NegotiatedCapabilities | null = null;
  private initialized = false;

  private readonly sessionStateById = new Map<string, SessionState>();
  /**
   * Tracks workspaces created by ACP session/new so disconnect cleanup can remove
   * untouched placeholders (no prompts/messages sent).
   */
  private readonly newSessionWorkspaceLifecycleById = new Map<
    string,
    NewSessionWorkspaceLifecycle
  >();
  private readonly sessionSkillsById = new Map<string, Map<string, AgentSkillDescriptor>>();
  /**
   * Persist each session's desired onChat mode so prompt() can recover dropped
   * subscriptions without changing replay semantics (full vs live).
   */
  private readonly onChatModeBySessionId = new Map<string, OnChatMode>();
  private readonly chatSubscriptions = new Map<string, Promise<void>>();
  /** Identity token for the currently active onChat subscription per session. */
  private readonly chatSubscriptionTokenBySessionId = new Map<string, symbol>();
  /** Resolves once `onChat` is connected for a session (shared across callers). */
  private readonly chatSubscriptionReady = new Map<string, Promise<void>>();
  /** Mode used for the currently active/connecting onChat subscription per session. */
  private readonly chatSubscriptionModeBySessionId = new Map<string, OnChatMode>();
  /** Async iterators for active onChat streams so we can cancel on mode switch/eviction. */
  private readonly chatIteratorsBySessionId = new Map<
    string,
    AsyncIterator<WorkspaceChatMessage>
  >();
  private readonly turnCompletions = new Map<string, TurnCompletion>();
  private readonly latestUsageBySessionId = new Map<string, Usage>();
  /** Last activity timestamp (Date.now) per session for idle eviction. */
  private readonly sessionLastTouchedAtById = new Map<string, number>();
  private inFlightNewSessionCount = 0;
  private disconnectCleanupPromise: Promise<void> | null = null;
  private readonly disconnectCleanupMaxWaitMs: number;
  private readonly sessionIdleTtlMs: number;
  private readonly maxTrackedSessions: number;
  private readonly turnCorrelationTimeoutMs: number;

  constructor(
    private readonly connection: AgentSideConnection,
    private readonly server: ServerConnection,
    options?: MuxAgentOptions
  ) {
    assert(connection != null, "MuxAgent: connection is required");
    assert(server != null, "MuxAgent: server connection is required");

    const configuredDisconnectCleanupMaxWaitMs = options?.disconnectCleanupMaxWaitMs;
    assert(
      configuredDisconnectCleanupMaxWaitMs == null ||
        (Number.isFinite(configuredDisconnectCleanupMaxWaitMs) &&
          configuredDisconnectCleanupMaxWaitMs >= 0),
      "MuxAgent: disconnectCleanupMaxWaitMs must be a finite non-negative number"
    );

    const configuredSessionIdleTtlMs = options?.sessionIdleTtlMs;
    assert(
      configuredSessionIdleTtlMs == null ||
        (Number.isFinite(configuredSessionIdleTtlMs) && configuredSessionIdleTtlMs > 0),
      "MuxAgent: sessionIdleTtlMs must be a finite positive number"
    );

    const configuredMaxTrackedSessions = options?.maxTrackedSessions;
    assert(
      configuredMaxTrackedSessions == null ||
        (Number.isInteger(configuredMaxTrackedSessions) && configuredMaxTrackedSessions > 0),
      "MuxAgent: maxTrackedSessions must be a positive integer"
    );

    const configuredTurnCorrelationTimeoutMs = options?.turnCorrelationTimeoutMs;
    assert(
      configuredTurnCorrelationTimeoutMs == null ||
        (Number.isFinite(configuredTurnCorrelationTimeoutMs) &&
          configuredTurnCorrelationTimeoutMs > 0),
      "MuxAgent: turnCorrelationTimeoutMs must be a finite positive number"
    );

    this.disconnectCleanupMaxWaitMs =
      configuredDisconnectCleanupMaxWaitMs ?? DEFAULT_DISCONNECT_CLEANUP_MAX_WAIT_MS;
    this.sessionIdleTtlMs = configuredSessionIdleTtlMs ?? DEFAULT_SESSION_IDLE_TTL_MS;
    this.maxTrackedSessions = configuredMaxTrackedSessions ?? DEFAULT_MAX_TRACKED_SESSIONS;
    this.turnCorrelationTimeoutMs =
      configuredTurnCorrelationTimeoutMs ?? DEFAULT_TURN_CORRELATION_TIMEOUT_MS;

    this.streamTranslator = new StreamTranslator(connection);
    this.toolRouter = new ToolRouter(connection);
  }

  initialize(params: InitializeRequest): Promise<InitializeResponse> {
    // The ACP SDK invokes the agent factory during AgentSideConnection
    // construction, before connection.signal is available. Defer installing
    // the abort listener until initialize() runs after construction completes.
    this.connection.signal.addEventListener(
      "abort",
      () => {
        const disconnectError = new Error("Xum ACP connection closed");
        const activeTurnSessionIds = [...this.turnCompletions.keys()];
        for (const sessionId of activeTurnSessionIds) {
          this.rejectTurn(sessionId, disconnectError);
        }

        this.disconnectCleanupPromise = (async () => {
          // Interrupt active streams before evicting session mappings. Otherwise,
          // session cleanup can remove workspace lookups that stream interruption
          // still depends on, leaving backend turns running after disconnect.
          await this.interruptActiveTurnStreamsOnDisconnect(activeTurnSessionIds);
          await Promise.all([
            this.cleanupNewSessionWorkspacesOnDisconnect(),
            this.cleanupTrackedSessionsOnDisconnect(),
          ]);
        })().catch((cleanupError) => {
          console.error("[acp] Failed during disconnect workspace cleanup", cleanupError);
        });
      },
      { once: true }
    );

    assert(params != null, "initialize: params are required");

    const negotiated = negotiateCapabilities(params.clientCapabilities);
    this.negotiatedCapabilities = negotiated;
    this.toolRouter.setEditorCapabilities(negotiated);
    this.initialized = true;

    return Promise.resolve({
      protocolVersion: params.protocolVersion,
      agentInfo: {
        name: XUM_PRODUCT_SLUG,
        version: resolveXumEnvironmentValue("VERSION", process.env) ?? "dev",
      },
      agentCapabilities: {
        loadSession: true,
        sessionCapabilities: {
          fork: {},
          list: {},
          resume: {},
        },
      },
    });
  }

  async newSession(params: NewSessionRequest): Promise<NewSessionResponse> {
    this.assertInitialized("newSession");

    this.inFlightNewSessionCount += 1;
    try {
      const meta = parseMuxMeta(params._meta);
      const requestedProjectPath = await resolveAcpNewSessionProjectPath(
        params.cwd,
        meta.projectPath
      );
      const workspaceScope = await this.ensureAcpProjectTrusted(requestedProjectPath);

      // When the ACP client doesn't supply a trunk branch (typical — editors only
      // send `cwd`, not mux-specific `_meta`), derive it from the project's git
      // repo.  Worktree/SSH runtimes require a trunk branch for workspace creation.
      let trunkBranch = meta.trunkBranch;
      if (trunkBranch == null || trunkBranch.trim().length === 0) {
        const branchInfo = await this.server.client.projects.listBranches({
          projectPath: workspaceScope.projectPath,
        });
        trunkBranch = branchInfo.recommendedTrunk ?? DEFAULT_TRUNK_BRANCH;
      }

      const createResult = await this.server.client.workspace.create({
        projectPath: workspaceScope.projectPath,
        branchName: meta.branchName ?? generateDefaultBranchName(),
        trunkBranch,
        title: meta.title,
        runtimeConfig: meta.runtimeConfig,
        subProjectPath: workspaceScope.subProjectPath,
      });

      if (!createResult.success) {
        throw new Error(`newSession: workspace.create failed: ${createResult.error}`);
      }

      const workspace = createResult.metadata;
      const sessionId = workspace.id;
      const workspaceId = workspace.id;
      this.newSessionWorkspaceLifecycleById.set(workspaceId, {
        hasPromptActivity: false,
      });

      const runtimeMode = runtimeModeFromConfig(workspace.runtimeConfig);

      this.sessionManager.registerSession(
        sessionId,
        workspaceId,
        runtimeMode,
        this.negotiatedCapabilities ?? undefined
      );

      this.toolRouter.registerSession(sessionId, runtimeMode);

      const agentId = meta.agentId ?? workspace.agentId ?? DEFAULT_AGENT_ID;
      const aiSettings = await resolveAgentAiSettings(this.server.client, agentId, workspaceId);

      this.sessionStateById.set(sessionId, {
        workspaceId,
        runtimeMode,
        agentId,
        aiSettings,
      });
      this.touchSession(sessionId);

      await this.ensureChatSubscription(sessionId, workspaceId, ON_CHAT_MODE_FULL);

      const response = {
        sessionId,
        configOptions: await buildConfigOptions(this.server.client, workspaceId, {
          activeAgentId: agentId,
          aiSettings,
        }),
      };

      this.scheduleSessionCommandsRefresh(sessionId, workspaceId);

      return response;
    } finally {
      this.inFlightNewSessionCount -= 1;
      assert(
        this.inFlightNewSessionCount >= 0,
        "newSession: inFlightNewSessionCount should never be negative"
      );
    }
  }

  async loadSession(params: LoadSessionRequest): Promise<LoadSessionResponse> {
    this.assertInitialized("loadSession");

    // Preserve unsent picker choices when reloading this adapter's active session.
    const existingState = this.sessionStateById.get(params.sessionId);
    const resumed = await loadSessionFromWorkspace(params, {
      server: this.server,
      sessionManager: this.sessionManager,
      negotiatedCapabilities: this.negotiatedCapabilities,
      defaultAgentId: DEFAULT_AGENT_ID,
      existingSessionState: existingState,
    });

    this.sessionStateById.set(resumed.sessionId, {
      workspaceId: resumed.workspaceId,
      runtimeMode: resumed.runtimeMode,
      agentId: resumed.agentId,
      aiSettings: resumed.aiSettings,
    });
    this.touchSession(resumed.sessionId);

    this.toolRouter.registerSession(resumed.sessionId, resumed.runtimeMode);

    await this.ensureChatSubscription(resumed.sessionId, resumed.workspaceId, ON_CHAT_MODE_FULL);

    this.scheduleSessionCommandsRefresh(resumed.sessionId, resumed.workspaceId);

    return resumed.response;
  }

  async listSessions(params: ListSessionsRequest): Promise<ListSessionsResponse> {
    this.assertInitialized("listSessions");
    assert(params != null, "listSessions: params are required");

    const normalizedCwd = normalizeOptionalPath(params.cwd);
    const offset = parseSessionListCursor(params.cursor);

    const [activeWorkspaces, archivedWorkspaces, workspaceActivityList] = await Promise.all([
      this.server.client.workspace.list({ archived: false }),
      this.server.client.workspace.list({ archived: true }),
      this.server.client.workspace.activity.list(),
    ]);
    // null = backend activity read failure; session ordering degrades to metadata-only.
    const workspaceActivity = workspaceActivityList ?? {};

    const allWorkspaces = dedupeWorkspacesById([...activeWorkspaces, ...archivedWorkspaces]);
    const filteredWorkspaces =
      normalizedCwd != null
        ? allWorkspaces.filter((workspace) => workspaceMatchesCwd(workspace, normalizedCwd))
        : allWorkspaces;

    const sortedWorkspaces = [...filteredWorkspaces].sort((left, right) =>
      compareSessionRecency(left, right, workspaceActivity)
    );

    const page = sortedWorkspaces.slice(offset, offset + SESSION_LIST_PAGE_SIZE);
    const nextOffset = offset + page.length;

    return {
      sessions: page.map((workspace) => ({
        sessionId: workspace.id,
        // Surface subProjectPath when present so ACP clients reconnecting from a
        // package/sub-project cwd can list and resume the session they created.
        cwd: workspace.subProjectPath ?? workspace.projectPath,
        title: workspace.title ?? workspace.name,
        updatedAt: toSessionUpdatedAt(workspace, workspaceActivity),
      })),
      nextCursor: nextOffset < sortedWorkspaces.length ? String(nextOffset) : undefined,
    };
  }

  async resumeSession(params: ResumeSessionRequest): Promise<ResumeSessionResponse> {
    this.assertInitialized("resumeSession");

    const sessionId = params.sessionId.trim();
    assert(sessionId.length > 0, "resumeSession: sessionId must be non-empty");

    const cwd = params.cwd.trim();
    assert(cwd.length > 0, "resumeSession: cwd must be non-empty");

    const existingState = this.sessionStateById.get(sessionId);
    const resumed = await loadSessionFromWorkspace(
      {
        sessionId,
        cwd,
        mcpServers: params.mcpServers ?? [],
        _meta: params._meta,
      },
      {
        server: this.server,
        sessionManager: this.sessionManager,
        negotiatedCapabilities: this.negotiatedCapabilities,
        defaultAgentId: DEFAULT_AGENT_ID,
        existingSessionState: existingState,
      }
    );

    this.sessionStateById.set(resumed.sessionId, {
      workspaceId: resumed.workspaceId,
      runtimeMode: resumed.runtimeMode,
      agentId: resumed.agentId,
      aiSettings: resumed.aiSettings,
    });
    this.touchSession(resumed.sessionId);

    this.toolRouter.registerSession(resumed.sessionId, resumed.runtimeMode);

    // ACP resume semantics require "continue from now" without replaying prior
    // transcript. Use onChat live mode (new backend capability) to follow only
    // active/future stream events.
    await this.ensureChatSubscription(resumed.sessionId, resumed.workspaceId, ON_CHAT_MODE_LIVE);

    this.scheduleSessionCommandsRefresh(resumed.sessionId, resumed.workspaceId);

    return resumed.response;
  }

  async unstable_forkSession(params: ForkSessionRequest): Promise<ForkSessionResponse> {
    this.assertInitialized("unstable_forkSession");

    const meta = parseMuxMeta(params._meta);
    const sourceWorkspaceId = this.sessionManager.getWorkspaceId(params.sessionId);
    const sourceWorkspace = await this.server.client.workspace.getInfo({
      workspaceId: sourceWorkspaceId,
    });
    if (!sourceWorkspace) {
      throw new Error(
        `unstable_forkSession: source workspace '${sourceWorkspaceId}' was not found`
      );
    }
    await this.ensureAcpProjectTrusted(sourceWorkspace.projectPath);

    // Pass the source session's active agent so forks inherit mode switches
    const sourceSessionState = this.sessionStateById.get(params.sessionId);
    const forked = await forkSessionFromWorkspace(
      params,
      {
        server: this.server,
        sessionManager: this.sessionManager,
        negotiatedCapabilities: this.negotiatedCapabilities,
        defaultAgentId: DEFAULT_AGENT_ID,
        sourceSessionAgentId: sourceSessionState?.agentId,
      },
      meta.forkName
    );

    this.sessionStateById.set(forked.sessionId, {
      workspaceId: forked.workspaceId,
      runtimeMode: forked.runtimeMode,
      agentId: forked.agentId,
      aiSettings: forked.aiSettings,
    });
    this.touchSession(forked.sessionId);

    this.toolRouter.registerSession(forked.sessionId, forked.runtimeMode);

    await this.ensureChatSubscription(forked.sessionId, forked.workspaceId, ON_CHAT_MODE_FULL);

    this.scheduleSessionCommandsRefresh(forked.sessionId, forked.workspaceId);

    return forked.response;
  }

  async prompt(params: PromptRequest): Promise<PromptResponse> {
    this.assertInitialized("prompt");

    const sessionId = params.sessionId.trim();
    assert(sessionId.length > 0, "prompt: sessionId must be non-empty");

    this.touchSession(sessionId);
    const workspaceId = this.sessionManager.getWorkspaceId(sessionId);
    const sessionState = await this.refreshSessionState(sessionId);
    const parsedPrompt = parsePromptBlocks(params.prompt);

    const slashCommandResponse = await this.tryHandleSlashCommand(
      sessionId,
      workspaceId,
      sessionState,
      parsedPrompt
    );
    if (slashCommandResponse != null) {
      return slashCommandResponse;
    }

    return this.sendWorkspaceMessageAndAwaitTurn({
      sessionId,
      workspaceId,
      message: parsedPrompt.text,
      options: {
        model: sessionState.aiSettings.model,
        thinkingLevel: sessionState.aiSettings.thinkingLevel,
        // The send path re-gates pro mode for the selected model and route.
        reasoningMode: sessionState.aiSettings.reasoningMode,
        agentId: sessionState.agentId,
      },
      fileParts: parsedPrompt.fileParts,
    });
  }

  async cancel(params: CancelNotification): Promise<void> {
    this.assertInitialized("cancel");

    const sessionId = params.sessionId.trim();
    assert(sessionId.length > 0, "cancel: sessionId must be non-empty");

    this.touchSession(sessionId);
    const workspaceId = this.sessionManager.getWorkspaceId(sessionId);
    const interruptResult = await this.server.client.workspace.interruptStream({
      workspaceId,
      options: { retireBashMonitorAttention: true },
    });

    // Resolve any pending prompt immediately after a successful interrupt request.
    // Backend abort events can be dropped or synthesized without a messageId when no
    // active stream exists; waiting exclusively for terminal chat events can leave
    // ACP prompt requests hanging indefinitely. STOP_UNRECORDED_MESSAGE reports a stream
    // that did stop (only its durable Stop records failed), so the prompt settles as
    // cancelled before that failure is reported below.
    if (interruptResult.success || interruptResult.error === STOP_UNRECORDED_MESSAGE) {
      this.resolveTurn(sessionId, {
        stopReason: "cancelled",
        usage: this.latestUsageBySessionId.get(sessionId),
      });
    }
    if (!interruptResult.success) {
      throw new Error(`cancel: workspace.interruptStream failed: ${interruptResult.error}`);
    }
  }

  async setSessionConfigOption(
    params: SetSessionConfigOptionRequest
  ): Promise<SetSessionConfigOptionResponse> {
    this.assertInitialized("setSessionConfigOption");

    const sessionId = params.sessionId.trim();
    assert(sessionId.length > 0, "setSessionConfigOption: sessionId must be non-empty");

    this.touchSession(sessionId);
    const workspaceId = this.sessionManager.getWorkspaceId(sessionId);
    const trimmedConfigId = params.configId.trim();
    assert(trimmedConfigId.length > 0, "setSessionConfigOption: configId must be non-empty");

    // ACP supports boolean config options since schema 0.13, but mux only
    // exposes select options; reject boolean values until one exists. Surface
    // a spec-correct InvalidParams (-32602) error — matching what pre-0.25 SDK
    // schemas returned for boolean values — instead of a generic internal error.
    if (typeof params.value !== "string") {
      throw RequestError.invalidParams(
        { configId: trimmedConfigId },
        `config option '${trimmedConfigId}' expects a select value`
      );
    }

    const sessionState = this.sessionStateById.get(sessionId);
    const configOptions = await handleSetConfigOption(
      this.server.client,
      workspaceId,
      params.configId,
      params.value,
      {
        activeAgentId: sessionState?.agentId,
        aiSettings: sessionState?.aiSettings,
        onAgentModeChanged: (agentId, aiSettings) => {
          this.updateSessionAgentState(sessionId, agentId, aiSettings);
        },
      }
    );

    return { configOptions };
  }

  authenticate(_params: AuthenticateRequest): Promise<AuthenticateResponse> {
    this.assertInitialized("authenticate");

    // Local mux server connections do not currently require ACP-level auth.
    return Promise.resolve({});
  }

  private async sendWorkspaceMessageAndAwaitTurn(args: {
    sessionId: string;
    workspaceId: string;
    message: string;
    options: SendMessageOptions;
    fileParts?: Array<{ url: string; mediaType: string }>;
  }): Promise<PromptResponse> {
    assert(
      args.sessionId.trim().length > 0,
      "sendWorkspaceMessageAndAwaitTurn: sessionId required"
    );
    assert(
      args.workspaceId.trim().length > 0,
      "sendWorkspaceMessageAndAwaitTurn: workspaceId required"
    );
    assert(args.message.trim().length > 0, "sendWorkspaceMessageAndAwaitTurn: message required");

    this.markNewSessionWorkspacePromptActivity(args.workspaceId);

    const promptCorrelationId = randomUUID();
    const turnPromise = this.beginTurn(args.sessionId, promptCorrelationId);

    // Attach a sink immediately so early stream failures cannot produce
    // unhandled rejections before this method awaits turnPromise.
    void turnPromise.catch(() => undefined);

    try {
      // Re-establish chat subscription if a prior one dropped (e.g., transient
      // websocket interruption). Register the turn first so subscription
      // failures can reject it instead of leaving prompt() hanging.
      await this.ensureChatSubscription(
        args.sessionId,
        args.workspaceId,
        this.getSessionOnChatMode(args.sessionId)
      );

      this.markTurnDispatched(args.sessionId, promptCorrelationId);

      const delegatedToolNames = this.getDelegatedToolNames(args.sessionId);
      const optionsWithPromptCorrelation = this.attachPromptCorrelationToSendOptions(
        args.options,
        promptCorrelationId,
        delegatedToolNames
      );

      const sendResult = await this.server.client.workspace.sendMessage({
        workspaceId: args.workspaceId,
        message: args.message,
        options: {
          ...optionsWithPromptCorrelation,
          fileParts:
            args.fileParts != null && args.fileParts.length > 0 ? args.fileParts : undefined,
        },
      });

      if (!sendResult.success) {
        throw new Error(
          `prompt: workspace.sendMessage failed: ${stringifyUnknown(sendResult.error)}`
        );
      }

      const turn = await turnPromise;
      const usage = turn.usage ?? this.latestUsageBySessionId.get(args.sessionId);
      this.latestUsageBySessionId.delete(args.sessionId);

      return {
        stopReason: turn.stopReason,
        usage,
      };
    } catch (error) {
      // workspace.sendMessage / subscription failures can happen before stream
      // events settle the turn promise. Clear turn state before rethrowing.
      this.takeTurnCompletion(args.sessionId);
      throw error;
    }
  }

  private attachPromptCorrelationToSendOptions(
    options: SendMessageOptions,
    promptCorrelationId: string,
    delegatedToolNames: readonly string[]
  ): SendMessageOptions {
    assert(
      promptCorrelationId.trim().length > 0,
      "attachPromptCorrelationToSendOptions: promptCorrelationId must be non-empty"
    );

    const existingMuxMetadata = isRecord(options.muxMetadata) ? options.muxMetadata : {};
    const muxMetadata: Record<string, unknown> = {
      ...existingMuxMetadata,
      [ACP_PROMPT_CORRELATION_MUX_METADATA_KEY]: promptCorrelationId,
    };

    if (delegatedToolNames.length > 0) {
      muxMetadata[ACP_DELEGATED_TOOLS_MUX_METADATA_KEY] = [...delegatedToolNames];
    } else {
      delete muxMetadata[ACP_DELEGATED_TOOLS_MUX_METADATA_KEY];
    }

    return {
      ...options,
      acpPromptId: promptCorrelationId,
      delegatedToolNames: delegatedToolNames.length > 0 ? [...delegatedToolNames] : undefined,
      muxMetadata,
    };
  }

  private getDelegatedToolNames(sessionId: string): string[] {
    const delegatedToolNames: string[] = [];

    for (const toolName of ACP_DELEGATION_CANDIDATE_TOOLS) {
      if (this.toolRouter.shouldDelegateToEditor(sessionId, toolName)) {
        delegatedToolNames.push(toolName);
      }
    }

    return delegatedToolNames;
  }
  private async tryHandleSlashCommand(
    sessionId: string,
    workspaceId: string,
    sessionState: SessionState,
    parsedPrompt: ParsedPrompt
  ): Promise<PromptResponse | null> {
    const trimmedPrompt = parsedPrompt.text.trim();
    if (!trimmedPrompt.startsWith("/")) {
      return null;
    }

    let skillsByName: ReadonlyMap<string, AgentSkillDescriptor>;
    try {
      skillsByName = await this.getSessionSkills(sessionId, workspaceId);
    } catch (error) {
      console.error("[acp] Failed to load skills for slash command parsing", error);
      // Built-in ACP slash commands (/clear, /compact, etc.) should
      // still work when skill discovery has a transient failure.
      skillsByName = new Map<string, AgentSkillDescriptor>();
    }

    const parsedCommand = parseAcpSlashCommand(parsedPrompt.text, skillsByName);
    if (parsedCommand == null) {
      return null;
    }

    return this.handleSlashCommand(
      sessionId,
      workspaceId,
      sessionState,
      parsedPrompt,
      parsedCommand
    );
  }

  private async handleSlashCommand(
    sessionId: string,
    workspaceId: string,
    sessionState: SessionState,
    parsedPrompt: ParsedPrompt,
    parsedCommand: ParsedAcpSlashCommand
  ): Promise<PromptResponse> {
    switch (parsedCommand.kind) {
      case "invalid":
        return this.respondToCommand(sessionId, parsedCommand.message);

      case "clear": {
        const clearResult = await this.server.client.workspace.truncateHistory({
          workspaceId,
          percentage: 1.0,
        });
        if (!clearResult.success) {
          return this.respondToCommand(
            sessionId,
            `Failed to clear chat history: ${clearResult.error ?? "unknown error"}`
          );
        }

        return this.respondToCommand(sessionId, "Cleared chat history.");
      }

      case "compact": {
        let compactionPayload: { message: string; options: SendMessageOptions };
        try {
          compactionPayload = await this.buildCompactionPayload(
            parsedCommand,
            parsedPrompt,
            sessionState,
            workspaceId
          );
        } catch (error) {
          if (error instanceof InvalidExplicitAiSettingError) {
            return this.respondToCommand(sessionId, error.message);
          }
          throw error;
        }

        return this.sendWorkspaceMessageAndAwaitTurn({
          sessionId,
          workspaceId,
          message: compactionPayload.message,
          options: compactionPayload.options,
        });
      }

      case "skill": {
        const options: SendMessageOptions = {
          model: sessionState.aiSettings.model,
          thinkingLevel: sessionState.aiSettings.thinkingLevel,
          reasoningMode: sessionState.aiSettings.reasoningMode,
          agentId: sessionState.agentId,
          muxMetadata: buildAgentSkillMetadata({
            rawCommand: parsedCommand.rawCommand,
            commandPrefix: parsedCommand.commandPrefix,
            skillName: parsedCommand.descriptor.name,
            scope: parsedCommand.descriptor.scope,
            arguments: parsedCommand.argumentText,
          }),
        };

        return this.sendWorkspaceMessageAndAwaitTurn({
          sessionId,
          workspaceId,
          message: parsedCommand.formattedMessage,
          options,
          fileParts: parsedPrompt.fileParts,
        });
      }

      case "fork": {
        const workspaceInfo = await this.server.client.workspace.getInfo({ workspaceId });
        if (workspaceInfo == null) {
          return this.respondToCommand(
            sessionId,
            "Failed to fork workspace: current workspace metadata is unavailable."
          );
        }
        await this.ensureAcpProjectTrusted(workspaceInfo.projectPath);

        const forkResult = await this.server.client.workspace.fork({
          sourceWorkspaceId: workspaceId,
          pendingAutoTitle:
            parsedCommand.startMessage != null && parsedCommand.startMessage.trim().length > 0,
        });
        if (!forkResult.success) {
          return this.respondToCommand(
            sessionId,
            `Failed to fork workspace: ${forkResult.error ?? "unknown error"}`
          );
        }

        const newWorkspaceId = forkResult.metadata.id;
        let response = `Created forked workspace \`${newWorkspaceId}\`.`;

        if (parsedCommand.startMessage != null && parsedCommand.startMessage.trim().length > 0) {
          const startMessageResult = await this.server.client.workspace.sendMessage({
            workspaceId: newWorkspaceId,
            message: parsedCommand.startMessage,
            options: {
              model: sessionState.aiSettings.model,
              thinkingLevel: sessionState.aiSettings.thinkingLevel,
              reasoningMode: sessionState.aiSettings.reasoningMode,
              agentId: sessionState.agentId,
            },
          });

          response += startMessageResult.success
            ? " Queued the optional start message in the forked workspace."
            : ` Could not queue the optional start message: ${stringifyUnknown(startMessageResult.error)}`;
        }

        return this.respondToCommand(sessionId, response);
      }

      case "new": {
        const workspaceInfo = await this.server.client.workspace.getInfo({ workspaceId });
        if (workspaceInfo == null) {
          return this.respondToCommand(
            sessionId,
            "Failed to create workspace: current workspace metadata is unavailable."
          );
        }

        const workspaceScope = await this.ensureAcpProjectTrusted(
          workspaceInfo.subProjectPath ?? workspaceInfo.projectPath
        );

        // Resolve trunk from project defaults — /new no longer accepts overrides
        // (it now mirrors /fork's seamless flow).
        const branchInfo = await this.server.client.projects.listBranches({
          projectPath: workspaceScope.projectPath,
        });
        const trunkBranch = branchInfo.recommendedTrunk ?? DEFAULT_TRUNK_BRANCH;

        const hasStartMessage =
          parsedCommand.startMessage != null && parsedCommand.startMessage.trim().length > 0;

        const createResult = await this.server.client.workspace.create({
          projectPath: workspaceScope.projectPath,
          // branchName intentionally omitted — backend auto-generates (like /fork).
          trunkBranch,
          // Mirror /fork: when a start message accompanies /new, defer the title
          // selection until the first message can drive LLM-based generation.
          pendingAutoTitle: hasStartMessage,
          subProjectPath: workspaceScope.subProjectPath,
        });

        if (!createResult.success) {
          return this.respondToCommand(
            sessionId,
            `Failed to create workspace: ${createResult.error ?? "unknown error"}`
          );
        }

        const newWorkspaceId = createResult.metadata.id;
        const displayName = createResult.metadata.title ?? createResult.metadata.name;
        let response = `Created workspace \`${displayName}\` (id: \`${newWorkspaceId}\`).`;

        if (hasStartMessage && parsedCommand.startMessage != null) {
          const startMessageResult = await this.server.client.workspace.sendMessage({
            workspaceId: newWorkspaceId,
            message: parsedCommand.startMessage,
            options: {
              model: sessionState.aiSettings.model,
              thinkingLevel: sessionState.aiSettings.thinkingLevel,
              reasoningMode: sessionState.aiSettings.reasoningMode,
              agentId: sessionState.agentId,
            },
          });

          response += startMessageResult.success
            ? " Queued the optional start message in the new workspace."
            : ` Could not queue the optional start message: ${stringifyUnknown(startMessageResult.error)}`;
        }

        return this.respondToCommand(sessionId, response);
      }

      default:
        return this.respondToCommand(sessionId, "This slash command is not supported in ACP yet.");
    }
  }

  private async buildCompactionPayload(
    command: Extract<ParsedAcpSlashCommand, { kind: "compact" }>,
    parsedPrompt: ParsedPrompt,
    sessionState: SessionState,
    workspaceId: string
  ): Promise<{ message: string; options: SendMessageOptions }> {
    const targetWords =
      command.maxOutputTokens != null
        ? Math.round(command.maxOutputTokens / WORDS_TO_TOKENS_RATIO)
        : DEFAULT_COMPACTION_WORD_TARGET;

    let message = buildCompactionPrompt(targetWords);

    const continueMessage = command.continueMessage?.trim() ?? "";
    if (continueMessage.length > 0) {
      message += `\n\nThe user wants to continue with: ${continueMessage}`;
    }

    const hasFollowUp = continueMessage.length > 0 || parsedPrompt.fileParts.length > 0;

    const followUpContent = hasFollowUp
      ? {
          text: continueMessage,
          fileParts: parsedPrompt.fileParts.length > 0 ? parsedPrompt.fileParts : undefined,
          model: sessionState.aiSettings.model,
          agentId: sessionState.agentId,
          thinkingLevel: sessionState.aiSettings.thinkingLevel,
          reasoningMode: sessionState.aiSettings.reasoningMode,
        }
      : undefined;

    // Unified resolution as agent "compact": the -m flag is an explicit
    // override (invalid values throw instead of silently falling back), the
    // workspace's compact bucket and configured compact defaults win over the
    // live session settings (parent runtime), and a model override reclamps
    // thinking against the compaction model.
    const workspace = await this.server.client.workspace.getInfo({ workspaceId });
    const compactBucket = workspace?.aiSettingsByAgent?.compact;
    const resolved = await resolveAcpAgentAiSettings(this.server.client, "compact", workspaceId, {
      explicit: { model: command.model ?? undefined },
      targetWorkspaceSettings: compactBucket
        ? targetWorkspaceBucketToLayer(compactBucket)
        : undefined,
      parentRuntime: {
        model: sessionState.aiSettings.model,
        thinkingLevel: sessionState.aiSettings.thinkingLevel,
        reasoningMode: sessionState.aiSettings.reasoningMode,
      },
    });
    const compactionModel = resolved.selected.model;

    const compactData: CompactionRequestData = {
      model: compactionModel,
      maxOutputTokens: command.maxOutputTokens,
      followUpContent,
    };

    const toolPolicy: NonNullable<SendMessageOptions["toolPolicy"]> = [
      {
        regex_match: ".*",
        action: "disable",
      },
    ];

    const options: SendMessageOptions = {
      model: compactionModel,
      thinkingLevel: resolved.effective.thinkingLevel,
      reasoningMode: resolved.selected.reasoningMode,
      agentId: "compact",
      maxOutputTokens: command.maxOutputTokens,
      skipAiSettingsPersistence: true,
      toolPolicy,
      muxMetadata: {
        type: "compaction-request",
        rawCommand: command.rawCommand,
        commandPrefix: "/compact",
        parsed: compactData,
        requestedModel: compactionModel,
      },
    };

    return {
      message,
      options,
    };
  }

  private async respondToCommand(sessionId: string, text: string): Promise<PromptResponse> {
    assert(sessionId.trim().length > 0, "respondToCommand: sessionId must be non-empty");
    assert(text.trim().length > 0, "respondToCommand: text must be non-empty");

    await this.connection.sessionUpdate({
      sessionId,
      update: {
        sessionUpdate: "agent_message_chunk",
        content: {
          type: "text",
          text,
        },
      },
    });

    return {
      stopReason: DEFAULT_COMMAND_STOP_REASON,
    };
  }

  private markNewSessionWorkspacePromptActivity(workspaceId: string): void {
    const lifecycle = this.newSessionWorkspaceLifecycleById.get(workspaceId);
    if (lifecycle == null) {
      return;
    }

    lifecycle.hasPromptActivity = true;
  }

  private async cleanupTrackedSessionsOnDisconnect(): Promise<void> {
    const sessionIds = new Set<string>([
      ...this.sessionStateById.keys(),
      ...this.sessionManager.getAllSessions().keys(),
      ...this.sessionLastTouchedAtById.keys(),
      ...this.chatSubscriptions.keys(),
    ]);

    for (const sessionId of sessionIds) {
      if (this.turnCompletions.has(sessionId)) {
        continue;
      }

      await this.evictSessionState(sessionId, "ACP connection closed");
    }
  }

  private async interruptActiveTurnStreamsOnDisconnect(
    sessionIds: readonly string[]
  ): Promise<void> {
    for (const sessionId of sessionIds) {
      let workspaceId: string;
      try {
        workspaceId = this.sessionManager.getWorkspaceId(sessionId);
      } catch {
        continue;
      }

      try {
        const interruptResult = await this.server.client.workspace.interruptStream({
          workspaceId,
          options: {
            abandonPartial: true,
          },
        });
        if (!interruptResult.success) {
          console.error(
            `[acp] Failed to interrupt active stream for session ${sessionId} during disconnect: ${stringifyUnknown(interruptResult.error)}`
          );
        }
      } catch (error) {
        console.error(
          `[acp] Failed to interrupt active stream for session ${sessionId} during disconnect`,
          error
        );
      }
    }
  }

  private async cleanupNewSessionWorkspacesOnDisconnect(): Promise<void> {
    const startedAt = Date.now();

    while (true) {
      const nextEntry = this.newSessionWorkspaceLifecycleById.entries().next();
      if (nextEntry.done) {
        // Disconnect can race in-flight session/new requests that haven't yet
        // registered their workspace lifecycle entry. Keep draining until all
        // in-flight creations settle so late registrations are still cleaned up.
        if (this.inFlightNewSessionCount === 0) {
          return;
        }

        const elapsedMs = Date.now() - startedAt;
        if (elapsedMs >= this.disconnectCleanupMaxWaitMs) {
          console.warn(
            `[acp] Timed out waiting for ${this.inFlightNewSessionCount} in-flight session/new request(s) during disconnect cleanup`
          );
          return;
        }

        await new Promise((resolve) => setTimeout(resolve, 0));
        continue;
      }

      const [workspaceId, lifecycle] = nextEntry.value;
      this.newSessionWorkspaceLifecycleById.delete(workspaceId);

      // If this ACP connection attempted any prompt in the workspace, keep it.
      // Users can intentionally prepare a workspace and disconnect mid-turn.
      if (lifecycle.hasPromptActivity) {
        continue;
      }

      try {
        const replay = await this.server.client.workspace.getFullReplay({ workspaceId });
        if (!isWorkspaceConversationEmpty(replay)) {
          continue;
        }

        const removeResult = await this.server.client.workspace.remove({
          workspaceId,
          options: { force: false },
        });
        if (!removeResult.success) {
          console.error(
            `[acp] Failed to remove untouched ACP workspace ${workspaceId} on disconnect: ${stringifyUnknown(removeResult.error)}`
          );
        }
      } catch (error) {
        console.error(
          `[acp] Failed to cleanup untouched ACP workspace ${workspaceId} on disconnect`,
          error
        );
      }
    }
  }

  private scheduleSessionCommandsRefresh(sessionId: string, workspaceId: string): void {
    // Some ACP clients (including Zed) can drop session/update notifications that
    // arrive before the corresponding session/new response is processed client-side.
    // Defer command advertisement to the next macrotask so the session is
    // established first, then publish available slash commands.
    setTimeout(() => {
      if (this.connection.signal.aborted) {
        return;
      }

      void this.refreshSessionCommands(sessionId, workspaceId);
    }, 0);
  }

  private async refreshSessionCommands(sessionId: string, workspaceId: string): Promise<void> {
    let advertisedSkills: AgentSkillDescriptor[];

    try {
      const skills = await this.server.client.agentSkills.list({ workspaceId });
      const skillsByName = mapSkillsByName(skills);
      this.sessionSkillsById.set(sessionId, skillsByName);
      advertisedSkills = skills;
    } catch (error) {
      // Command advertisement should not block session creation/loading.
      console.error("[acp] Failed to load skills while publishing slash commands", error);
      // Always publish built-in commands even if skills are temporarily unavailable.
      const cachedSkillsByName = this.sessionSkillsById.get(sessionId);
      advertisedSkills = cachedSkillsByName ? Array.from(cachedSkillsByName.values()) : [];
    }

    try {
      await this.connection.sessionUpdate({
        sessionId,
        update: {
          sessionUpdate: "available_commands_update",
          availableCommands: buildAcpAvailableCommands(advertisedSkills),
        },
      });
    } catch (error) {
      // Command advertisement should not block session creation/loading.
      console.error("[acp] Failed to publish available slash commands", error);
    }
  }

  private async getSessionSkills(
    sessionId: string,
    workspaceId: string
  ): Promise<ReadonlyMap<string, AgentSkillDescriptor>> {
    const cached = this.sessionSkillsById.get(sessionId);
    if (cached != null) {
      return cached;
    }

    const skills = await this.server.client.agentSkills.list({ workspaceId });
    const skillsByName = mapSkillsByName(skills);
    this.sessionSkillsById.set(sessionId, skillsByName);
    return skillsByName;
  }

  private touchSession(sessionId: string): void {
    assert(sessionId.trim().length > 0, "touchSession: sessionId must be non-empty");

    this.sessionLastTouchedAtById.set(sessionId, Date.now());
  }

  private async pruneTrackedSessionsIfNeeded(): Promise<void> {
    const trackedCount = this.sessionLastTouchedAtById.size;
    if (trackedCount === 0) {
      return;
    }

    const now = Date.now();
    const idleCandidates = Array.from(this.sessionLastTouchedAtById.entries())
      .filter(([, touchedAt]) => now - touchedAt >= this.sessionIdleTtlMs)
      .sort((left, right) => left[1] - right[1]);

    for (const [sessionId] of idleCandidates) {
      if (this.turnCompletions.has(sessionId)) {
        continue;
      }

      await this.evictSessionState(
        sessionId,
        `idle timeout (${Math.round(this.sessionIdleTtlMs / 1000)}s)`
      );
    }

    if (this.sessionLastTouchedAtById.size <= this.maxTrackedSessions) {
      return;
    }

    const lruCandidates = Array.from(this.sessionLastTouchedAtById.entries()).sort(
      (left, right) => left[1] - right[1]
    );

    for (const [sessionId] of lruCandidates) {
      if (this.sessionLastTouchedAtById.size <= this.maxTrackedSessions) {
        break;
      }
      if (this.turnCompletions.has(sessionId)) {
        continue;
      }

      await this.evictSessionState(
        sessionId,
        `LRU cap (${this.maxTrackedSessions} sessions) exceeded`
      );
    }
  }

  private async evictSessionState(sessionId: string, reason: string): Promise<void> {
    assert(sessionId.trim().length > 0, "evictSessionState: sessionId must be non-empty");

    if (this.turnCompletions.has(sessionId)) {
      return;
    }

    await this.stopChatSubscription(sessionId, reason);

    const workspaceId =
      this.sessionStateById.get(sessionId)?.workspaceId ??
      this.sessionManager.getAllSessions().get(sessionId)?.workspaceId;

    if (workspaceId != null) {
      this.newSessionWorkspaceLifecycleById.delete(workspaceId);
    }

    this.sessionManager.removeSession(sessionId);
    this.toolRouter.removeSession(sessionId);
    this.sessionStateById.delete(sessionId);
    this.sessionSkillsById.delete(sessionId);
    this.onChatModeBySessionId.delete(sessionId);
    this.chatSubscriptionModeBySessionId.delete(sessionId);
    this.latestUsageBySessionId.delete(sessionId);
    this.sessionLastTouchedAtById.delete(sessionId);

    this.streamTranslator.clearSession(sessionId);
  }

  private shouldLogSubscriptionTeardownWarning(reason: string): boolean {
    assert(
      reason.trim().length > 0,
      "shouldLogSubscriptionTeardownWarning: reason must be non-empty"
    );

    if (this.connection.signal.aborted) {
      return false;
    }

    return !(
      reason.startsWith("onChat mode switch") ||
      reason.startsWith("LRU cap") ||
      reason.startsWith("idle timeout")
    );
  }

  private async stopChatSubscription(sessionId: string, reason: string): Promise<void> {
    assert(sessionId.trim().length > 0, "stopChatSubscription: sessionId must be non-empty");

    const waitWithTimeout = async (
      promise: Promise<unknown>,
      timeoutMs: number
    ): Promise<"completed" | "timed_out"> => {
      let timeoutHandle: ReturnType<typeof setTimeout> | undefined;
      const timeoutPromise = new Promise<"timed_out">((resolve) => {
        timeoutHandle = setTimeout(() => resolve("timed_out"), timeoutMs);
        timeoutHandle.unref?.();
      });

      try {
        return await Promise.race([promise.then(() => "completed" as const), timeoutPromise]);
      } finally {
        if (timeoutHandle != null) {
          clearTimeout(timeoutHandle);
        }
      }
    };

    const iterator = this.chatIteratorsBySessionId.get(sessionId);
    if (iterator != null) {
      try {
        const iteratorReturn = iterator.return?.();
        if (iteratorReturn != null) {
          const iteratorResult = await waitWithTimeout(iteratorReturn, 100);
          if (iteratorResult === "timed_out" && this.shouldLogSubscriptionTeardownWarning(reason)) {
            console.warn(`[acp] Timed out stopping onChat iterator for session ${sessionId}`, {
              reason,
            });
          }
        }
      } catch (error) {
        if (this.shouldLogSubscriptionTeardownWarning(reason)) {
          console.warn(`[acp] Failed to stop onChat iterator for session ${sessionId}`, {
            reason,
            error,
          });
        }
      }
    }

    const subscription = this.chatSubscriptions.get(sessionId);
    if (subscription != null) {
      const waitResult = await waitWithTimeout(
        subscription.catch(() => undefined),
        200
      );
      if (waitResult === "timed_out" && this.shouldLogSubscriptionTeardownWarning(reason)) {
        console.warn(`[acp] Timed out waiting for onChat subscription shutdown`, {
          sessionId,
          reason,
        });
      }
    }

    this.chatIteratorsBySessionId.delete(sessionId);
    this.chatSubscriptions.delete(sessionId);
    this.chatSubscriptionReady.delete(sessionId);
    this.chatSubscriptionTokenBySessionId.delete(sessionId);
    this.chatSubscriptionModeBySessionId.delete(sessionId);
  }

  private getSessionOnChatMode(sessionId: string): OnChatMode {
    return this.onChatModeBySessionId.get(sessionId) ?? ON_CHAT_MODE_FULL;
  }

  private isActiveChatSubscriptionToken(sessionId: string, subscriptionToken: symbol): boolean {
    assert(
      sessionId.trim().length > 0,
      "isActiveChatSubscriptionToken: sessionId must be non-empty"
    );

    return this.chatSubscriptionTokenBySessionId.get(sessionId) === subscriptionToken;
  }

  /**
   * Ensure a chat subscription exists for the given session. Returns a promise
   * that resolves once the underlying `onChat` stream is connected (so callers
   * like `prompt()` can safely send messages without racing the subscription).
   */
  private async ensureChatSubscription(
    sessionId: string,
    workspaceId: string,
    onChatMode: OnChatMode
  ): Promise<void> {
    // Persist the latest desired replay mode so reconnects honor the caller's
    // intent (e.g., loadSession full vs resumeSession live).
    this.onChatModeBySessionId.set(sessionId, onChatMode);
    this.touchSession(sessionId);

    const existingReady = this.chatSubscriptionReady.get(sessionId);
    const existingMode = this.chatSubscriptionModeBySessionId.get(sessionId);
    if (existingReady != null) {
      if (existingMode != null && !areOnChatModesEqual(existingMode, onChatMode)) {
        await this.stopChatSubscription(
          sessionId,
          `onChat mode switch (${existingMode.type} -> ${onChatMode.type})`
        );
      } else {
        await existingReady;
        return;
      }
    }

    // `connectedPromise` resolves once `onChat` returns the async iterable,
    // signaling the subscription is live. If `onChat` fails before the stream
    // is established, reject so callers get a proper error instead of hanging.
    let onConnected!: () => void;
    let onConnectFailed!: (reason: unknown) => void;
    const connectedPromise = new Promise<void>((resolve, reject) => {
      onConnected = resolve;
      onConnectFailed = reject;
    });

    const subscriptionToken = Symbol(`onChat-subscription:${sessionId}`);
    this.chatSubscriptionReady.set(sessionId, connectedPromise);
    this.chatSubscriptionTokenBySessionId.set(sessionId, subscriptionToken);
    this.chatSubscriptionModeBySessionId.set(sessionId, onChatMode);

    const subscription = this.runChatSubscription(
      sessionId,
      workspaceId,
      onConnected,
      onChatMode,
      subscriptionToken
    )
      .catch((error) => {
        // Reject the connected promise in case it hasn't been settled yet
        // (e.g., `onChat` itself threw before calling `onConnected`).
        onConnectFailed(error);

        if (this.connection.signal.aborted) {
          return;
        }

        if (!this.isActiveChatSubscriptionToken(sessionId, subscriptionToken)) {
          return;
        }

        this.rejectTurn(sessionId, asError(error, "onChat subscription failed"));
      })
      .finally(() => {
        if (this.chatSubscriptions.get(sessionId) === subscription) {
          this.chatSubscriptions.delete(sessionId);
        }
        if (this.chatSubscriptionReady.get(sessionId) === connectedPromise) {
          this.chatSubscriptionReady.delete(sessionId);
        }

        const subscriptionWasCurrent =
          this.chatSubscriptions.get(sessionId) == null &&
          this.isActiveChatSubscriptionToken(sessionId, subscriptionToken);
        if (
          subscriptionWasCurrent &&
          areOnChatModesEqual(this.chatSubscriptionModeBySessionId.get(sessionId), onChatMode)
        ) {
          this.chatSubscriptionModeBySessionId.delete(sessionId);
        }
        if (subscriptionWasCurrent) {
          this.chatSubscriptionTokenBySessionId.delete(sessionId);
        }
      });

    this.chatSubscriptions.set(sessionId, subscription);
    await connectedPromise;
    await this.pruneTrackedSessionsIfNeeded();
  }

  private async runChatSubscription(
    sessionId: string,
    workspaceId: string,
    onConnected: () => void,
    onChatMode: OnChatMode,
    subscriptionToken: symbol
  ): Promise<void> {
    const chatStream = await this.server.client.workspace.onChat({
      workspaceId,
      mode: onChatMode,
    });
    onConnected();
    this.touchSession(sessionId);

    // Decouple turn resolution from sessionUpdate writes.
    // handleStreamEvent must fire for every event regardless of stdout
    // backpressure. Without this decoupling, stream-end can stall behind
    // a blocked sessionUpdate write, preventing resolveTurn from firing
    // and causing prompt() to hang indefinitely.
    //
    // Keep memory bounded without stalling terminal-event observation.
    //
    // If stdout backpressure saturates the forwarding queue and we block the
    // drain loop, stream-end/stream-abort can be delayed behind thousands of
    // queued deltas, making prompt() appear hung. Instead, once saturated we
    // drop only high-volume chunk/replay events while preserving lifecycle/
    // control events (caught-up, tool-call-end, etc.) so turn-completion and
    // translator state remain correct.
    const { push, iterate, end } = createAsyncMessageQueue<WorkspaceChatMessage>();
    let queuedEventCount = 0;
    let droppedNonTerminalEventCount = 0;
    let hasCaughtUp = onChatMode.type !== "full";

    const isTerminalStreamEvent = (event: WorkspaceChatMessage): boolean =>
      event.type === "stream-end" ||
      event.type === "stream-abort" ||
      event.type === "stream-error" ||
      event.type === "error";

    const isDroppableUnderBackpressure = (event: WorkspaceChatMessage): boolean => {
      const isReplayMessageEvent =
        event.type === "message" &&
        ((event as { replay?: boolean }).replay === true || !hasCaughtUp);

      return (
        event.type === "stream-delta" ||
        event.type === "reasoning-delta" ||
        event.type === "tool-call-delta" ||
        event.type === "usage-delta" ||
        event.type === "session-usage-delta" ||
        event.type === "advisor-output" ||
        event.type === "advisor-reasoning-output" ||
        event.type === "bash-output" ||
        event.type === "init-output" ||
        event.type === "init-progress" ||
        // Drop replay history messages under saturation, but keep live message
        // events so ACP clients do not miss real-time conversation updates.
        isReplayMessageEvent
      );
    };

    // Drain the oRPC stream: observe events for turn resolution, buffer
    // for translation. push() is non-blocking so handleStreamEvent always
    // runs immediately — even when consumeAndForward is blocked on stdout.
    //
    // We capture the async iterator explicitly so we can call .return() to
    // cancel the drain loop when consumeAndForward errors. Without this,
    // the drain loop would keep calling handleStreamEvent for stale events
    // (potentially duplicating tool execution via tool-call-start) and leak
    // the oRPC subscription until the server eventually closes it.
    const chatIterator = chatStream[Symbol.asyncIterator]();
    this.chatIteratorsBySessionId.set(sessionId, chatIterator);
    const chatIterable: AsyncIterable<WorkspaceChatMessage> = {
      [Symbol.asyncIterator]: () => chatIterator,
    };

    const isCurrentSubscription = (): boolean =>
      this.isActiveChatSubscriptionToken(sessionId, subscriptionToken);

    const drainPromise = (async () => {
      try {
        for await (const event of chatIterable) {
          // Subscription replacement is best-effort; stopChatSubscription can
          // time out waiting for the old iterator to unwind. Guard each event
          // so stale streams cannot mutate active turn state after mode-switch
          // or reconnect replacement.
          if (!isCurrentSubscription()) {
            break;
          }

          this.handleStreamEvent(sessionId, event);
          if (event.type === "caught-up") {
            hasCaughtUp = true;
          }
          // Skip heartbeats from the queue: they produce no sessionUpdate
          // output and are emitted periodically, so they would accumulate
          // unboundedly if the consumer is blocked on stdout backpressure.
          if (event.type !== "heartbeat") {
            const shouldDropForBackpressure =
              queuedEventCount >= MAX_BUFFERED_CHAT_EVENTS &&
              !isTerminalStreamEvent(event) &&
              isDroppableUnderBackpressure(event);
            if (shouldDropForBackpressure) {
              droppedNonTerminalEventCount += 1;
              if (
                droppedNonTerminalEventCount === 1 ||
                droppedNonTerminalEventCount % 1_000 === 0
              ) {
                console.warn(
                  `[acp] Dropping high-volume onChat events under stdout backpressure for session ${sessionId}`,
                  {
                    droppedNonTerminalEventCount,
                    bufferedEvents: queuedEventCount,
                    lastDroppedEventType: event.type,
                  }
                );
              }
              continue;
            }

            queuedEventCount += 1;
            push(event);
          }
        }
      } finally {
        end();
      }
    })();

    // Forward buffered events as ACP session updates (may block on
    // stdout backpressure — that's fine, the queue absorbs the gap).
    const forwardingIterable: AsyncIterable<WorkspaceChatMessage> = {
      async *[Symbol.asyncIterator](): AsyncGenerator<WorkspaceChatMessage> {
        for await (const queuedEvent of iterate()) {
          queuedEventCount = Math.max(queuedEventCount - 1, 0);

          // If this subscription has been replaced, drop any buffered backlog
          // from the stale stream so old replay/tool events cannot continue
          // draining into session updates after mode-switch/reconnect.
          if (!isCurrentSubscription()) {
            queuedEventCount = 0;
            break;
          }

          yield queuedEvent;
        }
      },
    };

    try {
      await this.streamTranslator.consumeAndForward(sessionId, forwardingIterable);
    } finally {
      // Signal the drain loop to stop producing events (idempotent if
      // already ended).
      end();
      // Cancel the underlying chat stream iterator so the drain loop
      // doesn't keep running with stale handleStreamEvent calls.
      // .return() causes the pending .next() to resolve {done: true},
      // breaking the for-await loop and running its finally block.
      await chatIterator.return?.();
      await drainPromise;
      if (this.chatIteratorsBySessionId.get(sessionId) === chatIterator) {
        this.chatIteratorsBySessionId.delete(sessionId);
      }
    }

    // If the stream ends without a terminal event (e.g., transient transport
    // closure), reject any pending turn so `prompt()` doesn't hang forever.
    //
    // Guard by subscription token so a stale teardown from an older onChat
    // loop cannot reject a newer turn that already moved to a replacement
    // subscription.
    if (this.isActiveChatSubscriptionToken(sessionId, subscriptionToken)) {
      this.rejectTurn(
        sessionId,
        new Error("Chat stream ended unexpectedly without a terminal event")
      );
    }
  }

  private handleStreamEvent(sessionId: string, event: WorkspaceChatMessage): void {
    const isReplayEvent = (event as { replay?: boolean }).replay === true;
    this.touchSession(sessionId);

    this.refreshTurnInactivityTimeoutFromEvent(sessionId, event);

    if (event.type === "usage-delta") {
      if (!this.isActiveTurnMessage(sessionId, event.messageId)) {
        return;
      }

      this.latestUsageBySessionId.set(sessionId, convertToAcpUsage(event.cumulativeUsage));
      return;
    }

    // Correlate the turn with the correct message. `stream-start` is emitted
    // once per assistant message and carries the definitive messageId.
    if (event.type === "stream-start") {
      const completion = this.turnCompletions.get(sessionId);
      if (completion == null || event.messageId.trim().length === 0) {
        return;
      }

      const hasMatchingCorrelation = event.acpPromptId === completion.promptCorrelationId;
      const canFallbackToUncorrelatedStart =
        completion.messageId == null &&
        completion.dispatchedAtMs != null &&
        !isReplayEvent &&
        event.acpPromptId == null &&
        Number.isFinite(event.startTime) &&
        event.startTime >= completion.dispatchedAtMs;

      if (!hasMatchingCorrelation && !canFallbackToUncorrelatedStart) {
        return;
      }

      if (canFallbackToUncorrelatedStart) {
        console.warn(
          `[acp] stream-start missing acpPromptId after prompt dispatch; using best-effort fallback for session ${sessionId}`,
          {
            promptCorrelationId: completion.promptCorrelationId,
            messageId: event.messageId,
            eventStartTime: event.startTime,
            turnDispatchedAtMs: completion.dispatchedAtMs,
          }
        );
        // Fallback stream-start lacks acpPromptId, so generic correlation
        // refresh cannot observe it. Refresh timeout explicitly when we
        // accept this start event for the active prompt.
        this.resetTurnInactivityTimeout(sessionId);
      }

      completion.messageId = event.messageId;
      return;
    }

    if (event.type === "tool-call-start") {
      if (isReplayEvent || !this.isActiveTurnMessage(sessionId, event.messageId)) {
        return;
      }

      void this.maybeDelegateToolCallToEditor(sessionId, event).catch((error) => {
        console.error("[acp] Failed to delegate tool call to editor", error);
      });
      return;
    }

    if (event.type === "stream-end") {
      // stream-end is a normal completion. Prefer exact message-id matching
      // once stream-start identifies the turn, but also allow correlation-id
      // fallback while pending so a dropped stream-start cannot hang prompt().
      //
      // Do not blanket-drop replay events here: during initial full replay,
      // a newly queued prompt can receive correlated stream terminal events
      // before caught-up. Correlation gates below ensure only the active turn
      // can complete.
      if (!this.isActiveTurnMessageOrPending(sessionId, event.messageId, event.acpPromptId)) {
        return;
      }
      const usage =
        event.metadata.usage != null
          ? convertToAcpUsage(event.metadata.usage)
          : this.latestUsageBySessionId.get(sessionId);
      this.resolveTurn(sessionId, { stopReason: "end_turn", usage });
      return;
    }

    if (event.type === "stream-abort") {
      // stream-abort can arrive before stream-start when the user cancels
      // immediately.  Always honour abort for any pending turn so prompt()
      // doesn't hang forever.
      if (!this.isActiveTurnMessageOrPending(sessionId, event.messageId, event.acpPromptId)) {
        return;
      }
      const usage =
        event.metadata?.usage != null
          ? convertToAcpUsage(event.metadata.usage)
          : this.latestUsageBySessionId.get(sessionId);
      this.resolveTurn(sessionId, { stopReason: "cancelled", usage });
      return;
    }

    if (event.type === "stream-error" || event.type === "error") {
      // Like abort, errors must be propagated even before stream-start to
      // prevent hanging turns.
      if (!this.isActiveTurnMessageOrPending(sessionId, event.messageId, event.acpPromptId)) {
        return;
      }
      this.rejectTurn(sessionId, new Error(`prompt stream failed: ${event.error}`));
    }
  }

  private async maybeDelegateToolCallToEditor(
    sessionId: string,
    event: Extract<WorkspaceChatMessage, { type: "tool-call-start" }>
  ): Promise<void> {
    if (!this.toolRouter.shouldDelegateToEditor(sessionId, event.toolName)) {
      return;
    }

    const workspaceId = this.sessionManager.getWorkspaceId(sessionId);

    let delegatedResult: unknown;
    try {
      if (!isRecord(event.args)) {
        throw new Error("tool-call-start args must be an object to delegate");
      }

      delegatedResult = await this.toolRouter.delegateToEditor(
        sessionId,
        event.toolName,
        event.args
      );
    } catch (error) {
      delegatedResult = {
        success: false,
        error: `Editor delegation failed for ${event.toolName}: ${stringifyUnknown(error)}`,
      };
    }

    const answerResult = await this.server.client.workspace.answerDelegatedToolCall({
      workspaceId,
      toolCallId: event.toolCallId,
      result: delegatedResult,
    });

    if (!answerResult.success) {
      // No-op when the server wasn't waiting for this call (e.g., non-delegated replay).
      console.error(
        `[acp] Failed to deliver delegated tool result for ${event.toolCallId}: ${stringifyUnknown(answerResult.error)}`
      );
    }
  }

  private createTurnInactivityTimeoutHandle(
    sessionId: string,
    promptCorrelationId: string
  ): ReturnType<typeof setTimeout> {
    const timeoutHandle = setTimeout(() => {
      const completion = this.turnCompletions.get(sessionId);
      if (completion?.promptCorrelationId !== promptCorrelationId) {
        return;
      }

      // Only guard the pre-correlation phase. Once stream-start binds a
      // messageId, long quiet stretches (e.g., tool execution) are valid and
      // must not be failed locally by a fixed inactivity watchdog.
      if (completion.messageId != null) {
        return;
      }

      this.rejectTurn(
        sessionId,
        new Error(
          `prompt turn timed out after ${this.turnCorrelationTimeoutMs}ms of inactivity (before stream correlation)`
        )
      );
    }, this.turnCorrelationTimeoutMs);
    timeoutHandle.unref?.();
    return timeoutHandle;
  }

  private resetTurnInactivityTimeout(sessionId: string): void {
    const completion = this.turnCompletions.get(sessionId);
    if (completion == null) {
      return;
    }

    clearTimeout(completion.timeoutHandle);
    completion.timeoutHandle = this.createTurnInactivityTimeoutHandle(
      sessionId,
      completion.promptCorrelationId
    );
  }

  private refreshTurnInactivityTimeoutFromEvent(
    sessionId: string,
    event: WorkspaceChatMessage
  ): void {
    const completion = this.turnCompletions.get(sessionId);
    if (completion == null) {
      return;
    }

    const maybeMessageId = (event as { messageId?: unknown }).messageId;
    const eventMessageId = typeof maybeMessageId === "string" ? maybeMessageId : undefined;
    const maybePromptCorrelationId = (event as { acpPromptId?: unknown }).acpPromptId;
    const eventPromptCorrelationId =
      typeof maybePromptCorrelationId === "string" ? maybePromptCorrelationId : undefined;

    if (completion.messageId != null) {
      const hasMatchingMessageId = eventMessageId === completion.messageId;
      const hasEmptyMessageIdWithMatchingCorrelation =
        (eventMessageId?.trim().length ?? -1) === 0 &&
        eventPromptCorrelationId === completion.promptCorrelationId;
      if (hasMatchingMessageId || hasEmptyMessageIdWithMatchingCorrelation) {
        this.resetTurnInactivityTimeout(sessionId);
      }
      return;
    }

    if (eventPromptCorrelationId === completion.promptCorrelationId) {
      this.resetTurnInactivityTimeout(sessionId);
    }
  }

  private beginTurn(sessionId: string, promptCorrelationId: string): Promise<TurnResult> {
    assert(
      !this.turnCompletions.has(sessionId),
      `prompt: session '${sessionId}' already has a running turn`
    );
    assert(
      promptCorrelationId.trim().length > 0,
      "beginTurn: promptCorrelationId must be non-empty"
    );

    // Replay events from loadSession can include historical usage deltas; clear stale usage before
    // starting a fresh turn so prompt responses only reflect the in-flight request.
    this.latestUsageBySessionId.delete(sessionId);
    this.touchSession(sessionId);

    const startedAtMs = Date.now();
    assert(Number.isFinite(startedAtMs), "beginTurn: startedAtMs must be finite");

    return new Promise<TurnResult>((resolve, reject) => {
      const timeoutHandle = this.createTurnInactivityTimeoutHandle(sessionId, promptCorrelationId);

      this.turnCompletions.set(sessionId, {
        resolve,
        reject,
        promptCorrelationId,
        startedAtMs,
        timeoutHandle,
      });
    });
  }
  private markTurnDispatched(sessionId: string, promptCorrelationId: string): void {
    const completion = this.turnCompletions.get(sessionId);
    if (completion?.promptCorrelationId !== promptCorrelationId) {
      return;
    }

    const dispatchedAtMs = Date.now();
    assert(Number.isFinite(dispatchedAtMs), "markTurnDispatched: dispatchedAtMs must be finite");
    completion.dispatchedAtMs = dispatchedAtMs;
  }

  /**
   * Check if a stream event's messageId matches the active turn.  Before
   * `stream-start` sets the turn's messageId, terminal events (stream-end,
   * stream-abort, stream-error) are ignored to prevent an older in-flight
   * message from prematurely resolving a freshly queued prompt.
   */
  private isActiveTurnMessage(sessionId: string, eventMessageId: string): boolean {
    const completion = this.turnCompletions.get(sessionId);
    if (completion == null) {
      return false;
    }
    // Until stream-start identifies the turn's message, reject all terminal
    // events so stale stream-end/abort from a prior message can't resolve
    // the new turn.
    if (completion.messageId == null) {
      return false;
    }
    return completion.messageId === eventMessageId;
  }
  /**
   * Like `isActiveTurnMessage` but also supports pre-stream terminal events.
   *
   * Pending turns (messageId not yet known) only accept terminal events that
   * carry a matching ACP prompt correlation id. This prevents unrelated streams
   * in shared workspaces from cancelling/rejecting the current prompt.
   */
  private isActiveTurnMessageOrPending(
    sessionId: string,
    eventMessageId: string,
    eventPromptCorrelationId?: string
  ): boolean {
    const completion = this.turnCompletions.get(sessionId);
    if (completion == null) {
      return false;
    }
    // Turn already identified — prefer exact message match.
    if (completion.messageId != null) {
      if (completion.messageId === eventMessageId) {
        return true;
      }

      // Defensive fallback: some synthetic terminal events can carry an empty
      // messageId. Allow correlation-id matching in that case so cancellation
      // and completion cannot hang when IDs are omitted in transit.
      return (
        eventMessageId.trim().length === 0 &&
        eventPromptCorrelationId != null &&
        eventPromptCorrelationId === completion.promptCorrelationId
      );
    }

    // Pending turn: require explicit correlation id match.
    return (
      eventPromptCorrelationId != null &&
      eventPromptCorrelationId === completion.promptCorrelationId
    );
  }

  private takeTurnCompletion(sessionId: string): TurnCompletion | undefined {
    const completion = this.turnCompletions.get(sessionId);
    if (!completion) {
      return undefined;
    }

    this.turnCompletions.delete(sessionId);
    clearTimeout(completion.timeoutHandle);
    return completion;
  }

  private resolveTurn(sessionId: string, result: TurnResult): void {
    const completion = this.takeTurnCompletion(sessionId);
    if (!completion) {
      return;
    }

    completion.resolve(result);
  }

  private rejectTurn(sessionId: string, error: Error): void {
    const completion = this.takeTurnCompletion(sessionId);
    if (!completion) {
      return;
    }

    completion.reject(error);
  }

  private updateSessionAgentState(
    sessionId: string,
    agentId: string,
    aiSettings: ResolvedAiSettings
  ): void {
    const normalizedAgentId = agentId.trim();
    assert(normalizedAgentId.length > 0, "updateSessionAgentState: agentId must be non-empty");

    const existingState = this.sessionStateById.get(sessionId);
    assert(
      existingState != null,
      `updateSessionAgentState: missing state for session '${sessionId}'`
    );

    this.sessionStateById.set(sessionId, {
      ...existingState,
      agentId: normalizedAgentId,
      aiSettings,
    });
  }

  private async refreshSessionState(sessionId: string): Promise<SessionState> {
    const workspaceId = this.sessionManager.getWorkspaceId(sessionId);
    const workspace = await this.server.client.workspace.getInfo({ workspaceId });

    if (!workspace) {
      throw new Error(`refreshSessionState: workspace '${workspaceId}' was not found`);
    }

    const runtimeMode = runtimeModeFromConfig(workspace.runtimeConfig);
    const existing = this.sessionStateById.get(sessionId);
    // Prefer the ACP session's agent selection over workspace metadata.
    // The user may have switched mode via session/set_config_option; that
    // selection lives in sessionStateById and must not be reverted by a
    // workspace.agentId value from the backend.
    const agentId = existing?.agentId ?? workspace.agentId ?? DEFAULT_AGENT_ID;
    // Picker choices remain session-local until the next user message sends them.
    const aiSettings =
      existing?.aiSettings ??
      workspace.aiSettingsByAgent?.[agentId] ??
      workspace.aiSettings ??
      (await resolveAgentAiSettings(this.server.client, agentId, workspaceId));

    const nextState: SessionState = {
      workspaceId,
      runtimeMode,
      agentId,
      aiSettings,
    };

    this.sessionStateById.set(sessionId, nextState);
    return nextState;
  }

  async waitForDisconnectCleanup(): Promise<void> {
    await this.disconnectCleanupPromise;
  }

  private async ensureAcpProjectTrusted(projectPath: string): Promise<AcpWorkspaceCreationScope> {
    const workspaceScope = await this.resolveAcpWorkspaceCreationScope(projectPath);
    const trustPaths =
      workspaceScope.subProjectPath != null
        ? [workspaceScope.subProjectPath, workspaceScope.projectPath]
        : [workspaceScope.projectPath];

    // Launching mux as an ACP adapter from an editor for a concrete cwd is an
    // explicit trust signal, matching other CLI-style ACP adapters that work in
    // the selected directory without a separate desktop approval step.  For
    // sub-projects, trust both the requested child entry (so it exists) and the
    // owning parent entry that workspace creation/fork gates on.
    for (const trustedProjectPath of trustPaths) {
      await this.server.client.projects.setTrust({
        projectPath: trustedProjectPath,
        trusted: true,
      });
    }

    return workspaceScope;
  }

  private async resolveAcpWorkspaceCreationScope(
    projectPath: string
  ): Promise<AcpWorkspaceCreationScope> {
    const normalizedProjectPath = normalizePathForWorkspaceMatch(projectPath);
    const projectEntries = await this.server.client.projects.list();
    const projects = deriveProjectHierarchy(new Map<string, ProjectConfig>(projectEntries));
    const existingProjectPath = findProjectPathByNormalizedPath(normalizedProjectPath, projects);

    if (existingProjectPath != null) {
      const scope = resolveWorkspaceCreationScope(existingProjectPath, projects);
      assert(
        scope.projectPath.trim().length > 0,
        "resolveAcpWorkspaceCreationScope: owning project path must be non-empty"
      );

      return {
        projectPath: scope.projectPath,
        subProjectPath: scope.subProjectPath ?? undefined,
      };
    }

    const parentProjectPath = findContainingTopLevelProjectPath(normalizedProjectPath, projects);
    if (
      parentProjectPath != null &&
      (await pathsShareGitTopLevel(parentProjectPath, normalizedProjectPath))
    ) {
      return await this.registerAcpSubProject(parentProjectPath, normalizedProjectPath);
    }

    const gitTopLevel = await readGitTopLevelForAcpScope(normalizedProjectPath);
    if (gitTopLevel != null && gitTopLevel !== normalizedProjectPath) {
      const existingGitRootProjectPath = findProjectPathByNormalizedPath(gitTopLevel, projects);
      const owningProjectPath =
        existingGitRootProjectPath ?? (await this.registerAcpTopLevelProject(gitTopLevel));
      return await this.registerAcpSubProject(owningProjectPath, normalizedProjectPath);
    }

    return { projectPath: normalizedProjectPath };
  }

  private async registerAcpTopLevelProject(projectPath: string): Promise<string> {
    const createProjectResult = await this.server.client.projects.create({ projectPath });
    if (!createProjectResult.success) {
      throw new Error(
        `resolveAcpWorkspaceCreationScope: failed to register project '${projectPath}': ${createProjectResult.error}`
      );
    }

    return createProjectResult.data.normalizedPath;
  }

  private async registerAcpSubProject(
    parentProjectPath: string,
    subProjectPath: string
  ): Promise<AcpWorkspaceCreationScope> {
    const createProjectResult = await this.server.client.projects.create({
      projectPath: subProjectPath,
    });
    if (!createProjectResult.success) {
      throw new Error(
        `resolveAcpWorkspaceCreationScope: failed to register sub-project '${subProjectPath}': ${createProjectResult.error}`
      );
    }

    return {
      projectPath: parentProjectPath,
      subProjectPath: createProjectResult.data.normalizedPath,
    };
  }

  private assertInitialized(methodName: string): void {
    assert(this.initialized, `${methodName}: initialize must be called first`);
  }
}

async function pathsShareGitTopLevel(leftPath: string, rightPath: string): Promise<boolean> {
  const [leftGitRoot, rightGitRoot] = await Promise.all([
    readGitTopLevelForAcpScope(leftPath),
    readGitTopLevelForAcpScope(rightPath),
  ]);

  return leftGitRoot != null && leftGitRoot === rightGitRoot;
}

async function readGitTopLevelForAcpScope(projectPath: string): Promise<string | null> {
  try {
    using proc = execFileAsync("git", ["-C", projectPath, "rev-parse", "--show-toplevel"]);
    const { stdout } = await proc.result;
    const trimmed = stdout.trim();
    return trimmed.length > 0 ? normalizePathForWorkspaceMatch(trimmed) : null;
  } catch {
    return null;
  }
}

function findProjectPathByNormalizedPath(
  normalizedProjectPath: string,
  projects: ReadonlyMap<string, ProjectConfig>
): string | undefined {
  for (const projectPath of projects.keys()) {
    if (normalizePathForWorkspaceMatch(projectPath) === normalizedProjectPath) {
      return projectPath;
    }
  }

  return undefined;
}

function findContainingTopLevelProjectPath(
  projectPath: string,
  projects: ReadonlyMap<string, ProjectConfig>
): string | undefined {
  let closestParentPath: string | undefined;

  for (const [candidatePath, candidateConfig] of projects) {
    if (candidateConfig.parentProjectPath != null) {
      continue;
    }

    if (!isPathDescendant(candidatePath, projectPath)) {
      continue;
    }

    if (closestParentPath == null || candidatePath.length > closestParentPath.length) {
      closestParentPath = candidatePath;
    }
  }

  return closestParentPath;
}

async function resolveAcpNewSessionProjectPath(
  cwd: string,
  metaProjectPath: string | undefined
): Promise<string> {
  const cwdProjectPath = cwd.trim();
  assert(cwdProjectPath.length > 0, "newSession: cwd must be non-empty");

  if (metaProjectPath == null) {
    return cwdProjectPath;
  }

  const [canonicalCwd, canonicalMetaProjectPath] = await Promise.all([
    canonicalizePathForWorkspaceMatch(cwdProjectPath),
    canonicalizePathForWorkspaceMatch(metaProjectPath),
  ]);
  assert(
    canonicalCwd === canonicalMetaProjectPath,
    "newSession: _meta.projectPath must match cwd before ACP can auto-trust the project"
  );

  return metaProjectPath;
}

function normalizeOptionalPath(value: string | null | undefined): string | undefined {
  if (value == null) {
    return undefined;
  }

  const trimmed = value.trim();
  if (trimmed.length === 0) {
    return undefined;
  }

  return normalizePathForWorkspaceMatch(trimmed);
}

function normalizePathForWorkspaceMatch(value: string): string {
  const resolved = path.normalize(path.resolve(value));
  const stripped = stripTrailingPathSeparators(resolved);
  return process.platform === "win32" ? stripped.toLowerCase() : stripped;
}

function stripTrailingPathSeparators(value: string): string {
  const root = path.parse(value).root;
  let normalized = value;

  while (
    normalized.length > root.length &&
    (normalized.endsWith(path.posix.sep) || normalized.endsWith(path.win32.sep))
  ) {
    normalized = normalized.slice(0, -1);
  }

  return normalized;
}

function parseSessionListCursor(cursor: string | null | undefined): number {
  if (cursor == null) {
    return 0;
  }

  const trimmed = cursor.trim();
  if (trimmed.length === 0) {
    return 0;
  }

  assert(/^\d+$/.test(trimmed), `listSessions: invalid cursor '${cursor}'`);

  const parsed = Number(trimmed);
  assert(Number.isSafeInteger(parsed), `listSessions: invalid cursor '${cursor}'`);
  return parsed;
}

function isWorkspaceConversationEmpty(events: WorkspaceChatMessage[]): boolean {
  return !events.some(
    (event) => event.type === "message" && (event.role === "assistant" || event.role === "user")
  );
}

function dedupeWorkspacesById(workspaces: WorkspaceInfo[]): WorkspaceInfo[] {
  const deduped = new Map<string, WorkspaceInfo>();
  for (const workspace of workspaces) {
    if (!deduped.has(workspace.id)) {
      deduped.set(workspace.id, workspace);
    }
  }
  return Array.from(deduped.values());
}

function workspaceMatchesCwd(workspace: WorkspaceInfo, cwd: string): boolean {
  // Match project, sub-project, and concrete workspace paths so clients can
  // filter by either their editor cwd or the runtime-specific working directory.
  const normalizedProjectPath = normalizePathForWorkspaceMatch(workspace.projectPath);
  const normalizedSubProjectPath =
    workspace.subProjectPath != null
      ? normalizePathForWorkspaceMatch(workspace.subProjectPath)
      : null;
  const normalizedWorkspacePath = normalizePathForWorkspaceMatch(workspace.namedWorkspacePath);
  return (
    normalizedProjectPath === cwd ||
    normalizedSubProjectPath === cwd ||
    normalizedWorkspacePath === cwd
  );
}

function compareSessionRecency(
  left: WorkspaceInfo,
  right: WorkspaceInfo,
  activityByWorkspaceId: WorkspaceActivityById
): number {
  const leftRecency = toSessionRecencyTimestamp(left, activityByWorkspaceId);
  const rightRecency = toSessionRecencyTimestamp(right, activityByWorkspaceId);

  if (leftRecency !== rightRecency) {
    return rightRecency - leftRecency;
  }

  return left.id.localeCompare(right.id);
}

function toSessionUpdatedAt(
  workspace: WorkspaceInfo,
  activityByWorkspaceId: WorkspaceActivityById
): string | null {
  const recency = toSessionRecencyTimestamp(workspace, activityByWorkspaceId);
  if (recency > 0) {
    return new Date(recency).toISOString();
  }

  return workspace.createdAt ?? null;
}

function toSessionRecencyTimestamp(
  workspace: WorkspaceInfo,
  activityByWorkspaceId: WorkspaceActivityById
): number {
  const workspaceActivity = activityByWorkspaceId[workspace.id];
  if (workspaceActivity?.recency != null) {
    return workspaceActivity.recency;
  }

  if (workspace.createdAt == null) {
    return 0;
  }

  const createdAtMs = Date.parse(workspace.createdAt);
  return Number.isFinite(createdAtMs) ? createdAtMs : 0;
}

function parseMuxMeta(rawMeta: MetaRecord | null | undefined): ParsedMuxMeta {
  const source = getMuxMetaSource(rawMeta);

  return {
    projectPath: readOptionalString(source, "projectPath"),
    branchName: readOptionalString(source, "branchName"),
    trunkBranch: readOptionalString(source, "trunkBranch"),
    title: readOptionalString(source, "title"),
    runtimeConfig: parseOptionalRuntimeConfig(source.runtimeConfig),
    agentId: readOptionalString(source, "agentId"),
    forkName:
      readOptionalString(source, "forkName") ??
      readOptionalString(source, "newName") ??
      readOptionalString(source, "title"),
  };
}

function getMuxMetaSource(rawMeta: MetaRecord | null | undefined): MetaRecord {
  if (!isRecord(rawMeta)) {
    return {};
  }

  const nestedMuxMeta = rawMeta.mux;
  if (isRecord(nestedMuxMeta)) {
    return nestedMuxMeta;
  }

  return rawMeta;
}

function parseOptionalRuntimeConfig(value: unknown): RuntimeConfig | undefined {
  if (value == null) {
    return undefined;
  }

  const parsed = RuntimeConfigSchema.safeParse(value);
  if (!parsed.success) {
    throw new Error(
      `invalid runtimeConfig in ACP _meta: ${parsed.error.issues[0]?.message ?? "unknown"}`
    );
  }

  return parsed.data;
}

function readOptionalString(record: MetaRecord, key: string): string | undefined {
  const value = record[key];
  if (typeof value !== "string") {
    return undefined;
  }

  const trimmed = value.trim();
  return trimmed.length > 0 ? trimmed : undefined;
}

function runtimeModeFromConfig(runtimeConfig: RuntimeConfig | undefined): RuntimeMode {
  if (!runtimeConfig) {
    return "worktree";
  }

  if (isWorktreeRuntime(runtimeConfig)) {
    return "worktree";
  }

  return runtimeConfig.type;
}

function generateDefaultBranchName(): string {
  const timestamp = Date.now().toString(36);
  const randomSuffix = Math.random().toString(36).slice(2, 8);
  return `${DEFAULT_BRANCH_PREFIX}-${timestamp}-${randomSuffix}`;
}

function areOnChatModesEqual(left: OnChatMode | undefined, right: OnChatMode | undefined): boolean {
  if (left == null || right == null) {
    return left === right;
  }

  if (left.type !== right.type) {
    return false;
  }

  if (left.type !== "since") {
    return true;
  }

  assert(right.type === "since", "areOnChatModesEqual: right mode must be 'since'");

  return JSON.stringify(left.cursor) === JSON.stringify(right.cursor);
}

interface ParsedPrompt {
  text: string;
  fileParts: Array<{ url: string; mediaType: string }>;
}

/**
 * Convert ACP ContentBlock[] to MUX sendMessage arguments.
 * - text/resource blocks → concatenated text
 * - image blocks → fileParts (data URIs) for multimodal support
 * - Unsupported types (audio, resource_link) → error rather than silent drop
 */
function parsePromptBlocks(blocks: ContentBlock[]): ParsedPrompt {
  assert(Array.isArray(blocks), "prompt: prompt blocks must be an array");

  const textParts: string[] = [];
  const fileParts: Array<{ url: string; mediaType: string }> = [];

  for (const block of blocks) {
    if (block.type === "text") {
      if (block.text.trim().length > 0) {
        textParts.push(block.text);
      }
      continue;
    }

    if (block.type === "resource") {
      const resource = block.resource;
      if ("text" in resource && resource.text.trim().length > 0) {
        textParts.push(resource.text);
      } else if ("blob" in resource && typeof resource.blob === "string") {
        // Binary resource embedded as base64 — treat as an image/file part.
        const mimeType =
          "mimeType" in resource && typeof resource.mimeType === "string"
            ? resource.mimeType
            : "application/octet-stream";
        fileParts.push({ url: `data:${mimeType};base64,${resource.blob}`, mediaType: mimeType });
      } else {
        // Opaque resource reference without inline content — pass URI as text
        // so the model has *some* context rather than silently dropping.
        textParts.push(`[resource: ${resource.uri}]`);
      }
      continue;
    }

    if (block.type === "image") {
      // Convert ACP image (base64 data + mimeType) to a MUX file part.
      const dataUri = `data:${block.mimeType};base64,${block.data}`;
      fileParts.push({ url: dataUri, mediaType: block.mimeType });
      continue;
    }

    // Unsupported content types — surface an error to the editor rather than
    // silently dropping content which leads to confusing model behavior.
    throw new Error(`prompt: unsupported content block type "${block.type}" is not yet supported`);
  }

  const text = textParts.join("\n\n").trim();
  return {
    text: text.length > 0 ? text : "[No textual prompt content provided]",
    fileParts,
  };
}

function isRecord(value: unknown): value is MetaRecord {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function asError(error: unknown, fallbackMessage: string): Error {
  if (error instanceof Error) {
    return error;
  }

  return new Error(fallbackMessage, { cause: error });
}

function stringifyUnknown(value: unknown): string {
  if (typeof value === "string") {
    return value;
  }

  try {
    return JSON.stringify(value);
  } catch {
    return String(value);
  }
}

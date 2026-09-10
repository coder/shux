import * as path from "path";
import { Context, Effect, Layer } from "effect";
import { DEFAULT_CODER_ARCHIVE_BEHAVIOR } from "@/common/config/coderArchiveBehavior";
import { DEFAULT_WORKTREE_ARCHIVE_BEHAVIOR } from "@/common/config/worktreeArchiveBehavior";
import { EXPERIMENT_IDS } from "@/common/constants/experiments";
import type {
  ErrorEvent,
  ReasoningDeltaEvent,
  StreamAbortEvent,
  StreamDeltaEvent,
  StreamEndEvent,
  StreamStartEvent,
  ToolCallDeltaEvent,
  ToolCallEndEvent,
  ToolCallStartEvent,
} from "@/common/types/stream";
import {
  createCoderArchiveHook,
  createCoderUnarchiveHook,
} from "@/node/runtime/coderLifecycleHooks";
import { setGlobalCoderService } from "@/node/runtime/runtimeFactory";
import {
  createRuntimeForWorkspace,
  resolveWorkspaceExecutionPath,
} from "@/node/runtime/runtimeHelpers";
import { setSshPromptService as setSSH2SshPromptService } from "@/node/runtime/SSH2ConnectionPool";
import { setSshPromptService } from "@/node/runtime/sshConnectionPool";
import { createWorktreeArchiveHook } from "@/node/runtime/worktreeLifecycleHooks";
import { AgentPluginInstallService } from "@/node/services/agentPlugins/installService";
import { AgentStatusService } from "@/node/services/agentStatusService";
import {
  AnalyticsService,
  type IngestWorkspaceMeta,
} from "@/node/services/analytics/analyticsService";
import { createBackupGitRepo, createBackupPayloadStore } from "@/node/services/backup/adapters";
import { BackupService } from "@/node/services/backup/backupService";
import { AgentBrowserSessionDiscoveryService } from "@/node/services/browser/AgentBrowserSessionDiscoveryService";
import { BrowserBridgeServer } from "@/node/services/browser/BrowserBridgeServer";
import { BrowserBridgeTokenManager } from "@/node/services/browser/BrowserBridgeTokenManager";
import { BrowserControlService } from "@/node/services/browser/BrowserControlService";
import { BrowserSessionStateHub } from "@/node/services/browser/BrowserSessionStateHub";
import { CoderOauthService } from "@/node/services/coderOauthService";
import { coderService as coderServiceSingleton } from "@/node/services/coderService";
import { CodexOauthService } from "@/node/services/codexOauthService";
import { CopilotOauthService } from "@/node/services/copilotOauthService";
import { DesktopBridgeServer } from "@/node/services/desktop/DesktopBridgeServer";
import { DesktopSessionManager } from "@/node/services/desktop/DesktopSessionManager";
import { DesktopTokenManager } from "@/node/services/desktop/DesktopTokenManager";
import { DevToolsService } from "@/node/services/devToolsService";
import { EffectRunnerTag } from "@/node/services/di/effectRunner";
import {
  AgentBrowserSessionDiscovery,
  AgentPluginInstall,
  AgentStatus,
  AI,
  Analytics,
  BackgroundProcessManagerTag,
  Backup,
  BrowserBridgeServerTag,
  BrowserBridgeTokenManagerTag,
  BrowserControl,
  BrowserSessionStateHubTag,
  Coder,
  CoderOauth,
  CodexOauth,
  ConfigTag,
  CopilotOauth,
  DesktopBridgeServerTag,
  DesktopSessionManagerTag,
  DesktopInputCoordinatorTag,
  DesktopTokenManagerTag,
  DevTools,
  Editor,
  Experiments,
  ExtensionMetadata,
  FileLeaseManagerTag,
  Heartbeat,
  History,
  IdleCompaction,
  IdleDispatcherTag,
  Instructions,
  MCPConfig,
  McpOauth,
  MCPServerManagerTag,
  Memory,
  MemoryConsolidation,
  MemoryMeta,
  MenuEvent,
  MuxGatewayOauth,
  MuxGovernorOauth,
  Policy,
  Project,
  Provider,
  ProvidersConfigStoreTag,
  PTY,
  QuickJSRuntimeFactoryTag,
  Refine,
  SecretsStoreTag,
  Server,
  ServerAuth,
  SessionTiming,
  SessionUsage,
  SshPrompt,
  Task,
  Telemetry,
  Terminal,
  Timeline,
  Tokenizer,
  TurnRequestBuilderBindingsTag,
  Update,
  Voice,
  WindowTag,
  Workspace,
  WorkspaceGoal,
  WorkspaceLifecycleHooksTag,
  WorkspaceMcpOverrides,
  WorktreeArchiveSnapshot,
  type BrowserTags,
  type CoreTags,
  type CrossCuttingTags,
  type DesktopBridgeTags,
  type DesktopTags,
  type MiscDesktopTags,
  type OauthTags,
  type StoreTags,
  type TerminalEditorTags,
  type WorkerTags,
} from "@/node/services/di/tags";
import { EditorService } from "@/node/services/editorService";
import { ExperimentsService } from "@/node/services/experimentsService";
import { HeartbeatService } from "@/node/services/heartbeatService";
import { IdleCompactionService } from "@/node/services/idleCompactionService";
import { InstructionsService } from "@/node/services/instructionsService";
import { McpOauthService } from "@/node/services/mcpOauthService";
import { MenuEventService } from "@/node/services/menuEventService";
import { MuxGatewayOauthService } from "@/node/services/muxGatewayOauthService";
import { MuxGovernorOauthService } from "@/node/services/muxGovernorOauthService";
import { PolicyService } from "@/node/services/policyService";
import { ProjectService } from "@/node/services/projectService";
import { QuickJSRuntimeFactory } from "@/node/services/ptc/quickjsRuntime";
import { PTYService } from "@/node/services/ptyService";
import { RefineService } from "@/node/services/refinement/refineService";
import { ServerAuthService } from "@/node/services/serverAuthService";
import { ServerService } from "@/node/services/serverService";
import { SessionTimingService } from "@/node/services/sessionTimingService";
import { SshPromptService } from "@/node/services/sshPromptService";
import { TelemetryService } from "@/node/services/telemetryService";
import { TerminalService } from "@/node/services/terminalService";
import { TimelineService } from "@/node/services/timelineService";
import { TokenizerService } from "@/node/services/tokenizerService";
import { UpdateService } from "@/node/services/updateService";
import { VoiceService } from "@/node/services/voiceService";
import { WindowService } from "@/node/services/windowService";
import { WorkspaceLifecycleHooks } from "@/node/services/workspaceLifecycleHooks";
import { WorkspaceMcpOverridesService } from "@/node/services/workspaceMcpOverridesService";
import { WorktreeArchiveSnapshotService } from "@/node/services/worktreeArchiveSnapshotService";
import { CoreOptionsTag } from "./core";

/**
 * Desktop/server-only layers (`ServiceContainer` roots; Effect migration
 * Phase 11).
 *
 * `CrossCuttingLive` and `CoreOptionsFromDesktopLive` sit beneath the core
 * graph (its options derive from them). The remaining desktop services are
 * built above the core graph by six **group layers** — one `Layer.effectContext`
 * per group, constructing several services in the order the `ServiceContainer`
 * constructor used — rather than one layer per service: cold build cost grows
 * with the number of layers, and the desktop tail has no per-service swap
 * needs. Groups that depend on each other are staged with
 * `Layer.provideMerge`; only true siblings share a `Layer.mergeAll`
 * (siblings may build in any order, so nothing relies on sibling order).
 * Bodies are synchronous and register no finalizers (DI contract in
 * `../appRuntime.ts`); teardown stays explicit in `ServiceContainer.dispose()`.
 *
 * The former constructor's post-construction wiring — setters, event
 * listeners, global registrations — is replayed, statement for statement in
 * its original order, by `DesktopWiringLive` once every service exists.
 */

/**
 * Cross-cutting services, built in the order the `ServiceContainer`
 * constructor used before they moved here. Their constructors only capture
 * arguments; `initialize()` stays with `ServiceContainer.initialize()`.
 */
export const CrossCuttingLive: Layer.Layer<CrossCuttingTags, never, ConfigTag> =
  Layer.effectContext(
    Effect.map(ConfigTag, (config) => {
      const policyService = new PolicyService(config);
      const telemetryService = new TelemetryService(config.rootDir);
      const experimentsService = new ExperimentsService({
        telemetryService,
        xumHome: config.rootDir,
      });
      const sessionTimingService = new SessionTimingService(config, telemetryService);
      const analyticsService = new AnalyticsService(config);
      const devToolsService = new DevToolsService(config);
      // Desktop passes WorkspaceMcpOverridesService explicitly so AIService uses
      // the persistent config rather than creating a default with an ephemeral one.
      const workspaceMcpOverridesService = new WorkspaceMcpOverridesService(config);
      return Context.empty().pipe(
        Context.add(Policy, policyService),
        Context.add(Telemetry, telemetryService),
        Context.add(Experiments, experimentsService),
        Context.add(SessionTiming, sessionTimingService),
        Context.add(Analytics, analyticsService),
        Context.add(DevTools, devToolsService),
        Context.add(WorkspaceMcpOverrides, workspaceMcpOverridesService)
      );
    })
  );

/**
 * The desktop's core graph options: every optional cross-cutting service
 * present. (`MemoryMeta` and `WorkspaceMcpOverrides` are core graph inputs in
 * their own right, read from their tags by the core layers.)
 */
export const CoreOptionsFromDesktopLive: Layer.Layer<
  CoreOptionsTag,
  never,
  ConfigTag | CrossCuttingTags
> = Layer.effect(
  CoreOptionsTag,
  Effect.gen(function* () {
    const config = yield* ConfigTag;
    return {
      extensionMetadataPath: path.join(config.rootDir, "extensionMetadata.json"),
      policyService: yield* Policy,
      telemetryService: yield* Telemetry,
      analyticsService: yield* Analytics,
      experimentsService: yield* Experiments,
      sessionTimingService: yield* SessionTiming,
      devToolsService: yield* DevTools,
    };
  })
);

// ---------------------------------------------------------------------------
// Desktop group layers. Requirements (the `R` annotations) are the DAG: the
// four base groups need only stores, cross-cutting and core services; OAuth
// additionally needs the WindowService (Misc); the workers need the
// WindowService (Misc) and the TokenizerService (TerminalEditor).
// ---------------------------------------------------------------------------

/** Browser automation bridge: token manager → discovery → control → state hub → server. */
export const BrowserLive: Layer.Layer<BrowserTags, never, ConfigTag> = Layer.effectContext(
  Effect.map(ConfigTag, (config) => {
    const browserBridgeTokenManager = new BrowserBridgeTokenManager();
    const browserSessionDiscoveryService = new AgentBrowserSessionDiscoveryService({
      resolveWorkspaceCandidatePathsFn: async (workspaceId: string) => {
        const allWorkspaceMetadata = await config.getAllWorkspaceMetadata();
        const workspaceMetadata =
          allWorkspaceMetadata.find((candidate) => candidate.id === workspaceId) ?? null;
        if (workspaceMetadata == null) {
          return [];
        }

        const runtime = createRuntimeForWorkspace(workspaceMetadata);
        const workspacePath = resolveWorkspaceExecutionPath(workspaceMetadata, runtime);
        return [workspaceMetadata.projectPath, workspacePath].filter(
          (candidatePath): candidatePath is string => candidatePath.trim().length > 0
        );
      },
    });
    const browserControlService = new BrowserControlService({
      browserSessionDiscoveryService,
      resolveSessionEnvFn: () => Promise.resolve(process.env),
    });
    const browserSessionStateHub = new BrowserSessionStateHub({
      browserControlService,
    });
    const browserBridgeServer = new BrowserBridgeServer({
      browserSessionDiscoveryService,
      browserBridgeTokenManager,
      browserSessionStateHub,
    });
    return Context.empty().pipe(
      Context.add(BrowserBridgeTokenManagerTag, browserBridgeTokenManager),
      Context.add(AgentBrowserSessionDiscovery, browserSessionDiscoveryService),
      Context.add(BrowserControl, browserControlService),
      Context.add(BrowserSessionStateHubTag, browserSessionStateHub),
      Context.add(BrowserBridgeServerTag, browserBridgeServer)
    );
  })
);

/** Desktop companion bridge: session manager → token manager → server. */
export const DesktopBridgeLive: Layer.Layer<
  DesktopBridgeTags,
  never,
  ConfigTag | Experiments | Workspace | DesktopInputCoordinatorTag
> = Layer.effectContext(
  Effect.gen(function* () {
    const desktopSessionManager = new DesktopSessionManager({
      inputCoordinator: yield* DesktopInputCoordinatorTag,
      config: yield* ConfigTag,
      experimentsService: yield* Experiments,
      workspaceService: yield* Workspace,
    });
    const desktopTokenManager = new DesktopTokenManager();
    const desktopBridgeServer = new DesktopBridgeServer({
      desktopSessionManager,
      desktopTokenManager,
    });
    desktopSessionManager.setBridgeConnectionProbe((workspaceId, resolveOwner) =>
      desktopBridgeServer.hasActiveBridge(workspaceId, resolveOwner)
    );
    return Context.empty().pipe(
      Context.add(DesktopSessionManagerTag, desktopSessionManager),
      Context.add(DesktopTokenManagerTag, desktopTokenManager),
      Context.add(DesktopBridgeServerTag, desktopBridgeServer)
    );
  })
);

/** Terminal (PTY → terminal), editor, and token budgeting (tokenizer → instructions). */
export const TerminalEditorLive: Layer.Layer<
  TerminalEditorTags,
  never,
  ConfigTag | SecretsStoreTag | Workspace | SessionUsage | AI | Provider
> = Layer.effectContext(
  Effect.gen(function* () {
    const config = yield* ConfigTag;
    const aiService = yield* AI;
    // Terminal services - PTYService is cross-platform
    const ptyService = new PTYService();
    const terminalService = new TerminalService(config, ptyService, yield* SecretsStoreTag);
    // Editor service for opening workspaces in code editors
    const editorService = new EditorService(config, yield* Workspace);
    const tokenizerService = new TokenizerService(yield* SessionUsage, aiService, yield* Provider);
    const instructionsService = new InstructionsService(config, aiService, tokenizerService);
    return Context.empty().pipe(
      Context.add(PTY, ptyService),
      Context.add(Terminal, terminalService),
      Context.add(Editor, editorService),
      Context.add(Tokenizer, tokenizerService),
      Context.add(Instructions, instructionsService)
    );
  })
);

/**
 * The remaining desktop services: leaves over the stores/core/cross-cutting
 * graph, plus `ProjectService` (needs `SshPromptService`, built first here).
 */
export const MiscDesktopLive: Layer.Layer<
  MiscDesktopTags,
  never,
  | ConfigTag
  | SecretsStoreTag
  | ProvidersConfigStoreTag
  | Experiments
  | Policy
  | Provider
  | MCPServerManagerTag
  | WorkspaceMcpOverrides
> = Layer.effectContext(
  Effect.gen(function* () {
    const config = yield* ConfigTag;
    const experimentsService = yield* Experiments;
    const policyService = yield* Policy;
    const providerService = yield* Provider;
    const providersConfigStore = yield* ProvidersConfigStoreTag;
    const workflowRuntimeFactory = new QuickJSRuntimeFactory();
    const sshPromptService = new SshPromptService();
    const windowService = new WindowService();
    const backupService = new BackupService(config, {
      gitRepo: createBackupGitRepo({
        cacheRoot: path.join(config.rootDir, "backup-cache"),
      }),
      payload: createBackupPayloadStore({ config }),
    });
    // Managed Agent Plugin installer (agent-plugins experiment). Gated on the
    // backend ExperimentsService exactly like the plugin MCP provider; the
    // MCP manager dependency lets update/uninstall recycle running plugin
    // servers whose content changed behind an unchanged command line.
    const agentPluginInstallService = new AgentPluginInstallService(config, {
      isEnabled: () => experimentsService.isExperimentEnabled(EXPERIMENT_IDS.AGENT_PLUGINS),
      mcpServerManager: yield* MCPServerManagerTag,
      workspaceMcpOverridesService: yield* WorkspaceMcpOverrides,
    });
    const projectService = new ProjectService(config, sshPromptService, yield* SecretsStoreTag);
    const updateService = new UpdateService(config);
    const serverService = new ServerService();
    const menuEventService = new MenuEventService();
    const voiceService = new VoiceService(
      config,
      providerService,
      policyService,
      providersConfigStore
    );
    const serverAuthService = new ServerAuthService(config);
    const workspaceLifecycleHooks = new WorkspaceLifecycleHooks();
    const worktreeArchiveSnapshotService = new WorktreeArchiveSnapshotService(config);
    return Context.empty().pipe(
      Context.add(QuickJSRuntimeFactoryTag, workflowRuntimeFactory),
      Context.add(SshPrompt, sshPromptService),
      Context.add(WindowTag, windowService),
      Context.add(Backup, backupService),
      Context.add(AgentPluginInstall, agentPluginInstallService),
      Context.add(Project, projectService),
      Context.add(Update, updateService),
      Context.add(Server, serverService),
      Context.add(MenuEvent, menuEventService),
      Context.add(Voice, voiceService),
      Context.add(Coder, coderServiceSingleton),
      Context.add(ServerAuth, serverAuthService),
      Context.add(WorkspaceLifecycleHooksTag, workspaceLifecycleHooks),
      Context.add(WorktreeArchiveSnapshot, worktreeArchiveSnapshotService)
    );
  })
);

/** OAuth flows; every one hands off to the browser through the WindowService (Misc). */
export const OauthLive: Layer.Layer<
  OauthTags,
  never,
  | ConfigTag
  | ProvidersConfigStoreTag
  | FileLeaseManagerTag
  | MCPConfig
  | Provider
  | Policy
  | Telemetry
  | WindowTag
> = Layer.effectContext(
  Effect.gen(function* () {
    const config = yield* ConfigTag;
    const windowService = yield* WindowTag;
    const providersConfigStore = yield* ProvidersConfigStoreTag;
    const providerService = yield* Provider;
    const policyService = yield* Policy;
    const mcpOauthService = new McpOauthService(
      config,
      yield* MCPConfig,
      windowService,
      yield* Telemetry
    );
    const muxGatewayOauthService = new MuxGatewayOauthService(
      providersConfigStore,
      providerService,
      windowService
    );
    const muxGovernorOauthService = new MuxGovernorOauthService(
      config,
      windowService,
      policyService
    );
    const codexOauthService = new CodexOauthService(
      providersConfigStore,
      providerService,
      windowService
    );
    const coderOauthService = new CoderOauthService(
      providersConfigStore,
      yield* FileLeaseManagerTag,
      providerService,
      windowService,
      // Policy-aware: an enforced forcedBaseUrl overrides the deployment URL
      // for logins, refreshes, and issuer checks.
      policyService
    );
    const copilotOauthService = new CopilotOauthService(providerService, windowService);
    return Context.empty().pipe(
      Context.add(McpOauth, mcpOauthService),
      Context.add(MuxGatewayOauth, muxGatewayOauthService),
      Context.add(MuxGovernorOauth, muxGovernorOauthService),
      Context.add(CodexOauth, codexOauthService),
      Context.add(CoderOauth, coderOauthService),
      Context.add(CopilotOauth, copilotOauthService)
    );
  })
);

/**
 * Clock-driven workers (through the runtime's `EffectRunner`) and the
 * timeline/refine pair: idle compaction → heartbeat → timeline → refine →
 * agent status. `start()`/`stop()` stay with `ServiceContainer`.
 */
export const WorkersLive: Layer.Layer<
  WorkerTags,
  never,
  | ConfigTag
  | EffectRunnerTag
  | Experiments
  | History
  | ExtensionMetadata
  | Workspace
  | Task
  | IdleDispatcherTag
  | Memory
  | MemoryMeta
  | AI
  | SessionUsage
  | Tokenizer
  | WindowTag
> = Layer.effectContext(
  Effect.gen(function* () {
    const config = yield* ConfigTag;
    // Clock-driven workers run their lifecycle fibers through the runtime's
    // context-bound runner (unsupervised; see di/effectRunner.ts).
    const effectRunner = yield* EffectRunnerTag;
    const experimentsService = yield* Experiments;
    const historyService = yield* History;
    const extensionMetadata = yield* ExtensionMetadata;
    const workspaceService = yield* Workspace;
    const aiService = yield* AI;
    const sessionUsageService = yield* SessionUsage;
    // Idle compaction service - auto-compacts workspaces after configured idle period
    const idleCompactionService = new IdleCompactionService(
      config,
      historyService,
      extensionMetadata,
      (workspaceId) => workspaceService.executeIdleCompaction(workspaceId),
      effectRunner
    );
    // IdleDispatcher + goal continuation bridge are owned by the core graph
    // so the wiring works for `xum run` too. Share the same dispatcher with
    // HeartbeatService — its priority ordering ensures an active goal
    // suppresses background heartbeats.
    const heartbeatService = new HeartbeatService(
      config,
      extensionMetadata,
      workspaceService,
      yield* Task,
      yield* IdleDispatcherTag,
      effectRunner
    );
    const timelineService = new TimelineService(config, historyService, experimentsService);
    // /refine trajectory distillation (RLM r11). Chat emission routes through
    // WorkspaceService so a live session renders the appended summary row
    // immediately (the row itself is already durable in chat.jsonl).
    const refineService = new RefineService(
      config,
      yield* Memory,
      yield* MemoryMeta,
      historyService,
      aiService,
      experimentsService,
      {
        timelineService,
        sessionUsageService,
        emitChatMessage: (workspaceId, message) =>
          workspaceService.emitChatEvent(workspaceId, { ...message, type: "message" }),
        // r40: refine row publication and apply mutations must not interleave
        // with a concurrent turn's PREPARING snapshot or split its
        // user/assistant pair — hold the session's turn-admission block while
        // they land, failing closed when a turn is active.
        acquireTurnExclusion: (workspaceId) =>
          workspaceService.acquireIdleTurnExclusion(workspaceId),
      }
    );
    // AgentStatusService depends on tokenizer + window focus state; instantiate
    // after both are constructed so the small-model status loop can run with
    // accurate token budgeting and focus-aware cadence.
    const agentStatusService = new AgentStatusService(
      config,
      historyService,
      yield* Tokenizer,
      extensionMetadata,
      workspaceService,
      yield* WindowTag,
      aiService,
      // Status generation spends tokens outside StreamManager; give it a cost
      // telemetry sink so that spend shows up in per-workspace usage, and an
      // ingest trigger so the headless-usage sidecar reaches dashboard totals
      // even when the workspace has no further stream activity.
      {
        sessionUsageService,
        requestAnalyticsIngest: (workspaceId) => {
          workspaceService.emit("analyticsIngest", { workspaceId });
        },
      }
    );
    return Context.empty().pipe(
      Context.add(IdleCompaction, idleCompactionService),
      Context.add(Heartbeat, heartbeatService),
      Context.add(Timeline, timelineService),
      Context.add(Refine, refineService),
      Context.add(AgentStatus, agentStatusService)
    );
  })
);

// ---------------------------------------------------------------------------
// Wiring — the former `ServiceContainer` constructor's post-construction
// statements (setters, event listeners, global registrations), in their
// original order, once every desktop service exists. Runs after `CoreLive`'s
// wiring, so the analytics listeners below keep their position after the core
// listeners. Synchronous statements only: no finalizers, no forks (I5).
// ---------------------------------------------------------------------------

export const DesktopWiringLive: Layer.Layer<
  never,
  never,
  ConfigTag | CrossCuttingTags | CoreTags | DesktopTags
> = Layer.effectDiscard(
  Effect.gen(function* () {
    const config = yield* ConfigTag;
    const analyticsService = yield* Analytics;
    const sessionTimingService = yield* SessionTiming;
    const turnRequestBuilderBindings = yield* TurnRequestBuilderBindingsTag;
    const aiService = yield* AI;
    const workspaceService = yield* Workspace;
    const taskService = yield* Task;
    const workspaceGoalService = yield* WorkspaceGoal;
    const mcpServerManager = yield* MCPServerManagerTag;
    const memoryConsolidationService = yield* MemoryConsolidation;
    const backgroundProcessManager = yield* BackgroundProcessManagerTag;
    const coderService = yield* Coder;
    const backupService = yield* Backup;
    const memoryService = yield* Memory;
    const projectService = yield* Project;
    const sshPromptService = yield* SshPrompt;
    const desktopSessionManager = yield* DesktopSessionManagerTag;
    const idleCompactionService = yield* IdleCompaction;
    const heartbeatService = yield* Heartbeat;
    const timelineService = yield* Timeline;
    const refineService = yield* Refine;
    const mcpOauthService = yield* McpOauth;
    const codexOauthService = yield* CodexOauth;
    const coderOauthService = yield* CoderOauth;
    const terminalService = yield* Terminal;
    const workspaceLifecycleHooks = yield* WorkspaceLifecycleHooksTag;
    const worktreeArchiveSnapshotService = yield* WorktreeArchiveSnapshot;

    turnRequestBuilderBindings.analyticsService = analyticsService;

    projectService.setWorkspaceService(workspaceService);
    projectService.setWorkspaceMetadataRefresher(workspaceService);
    projectService.setMcpServerManager(mcpServerManager);
    // Backup restores register approved project imports through the same create() path the
    // UI uses; setter injection because BackupService is constructed before ProjectService.
    backupService.setProjectService(projectService);
    // Restored project memory is written directly, so the service announces it through
    // MemoryService for the memory browser's change subscription.
    backupService.setMemoryNotifier(memoryService);
    turnRequestBuilderBindings.desktopSessionManager = desktopSessionManager;

    // Forward terminal idle-compaction outcomes so the loop stops re-attempting a
    // persistently failing workspace (immediately on model_not_found, otherwise after
    // two consecutive failures).
    workspaceService.setIdleCompactionOutcomeListener((workspaceId, outcome) =>
      idleCompactionService.recordOutcome(workspaceId, outcome)
    );

    // Removal must be able to abort + drain a running /refine pass before it
    // deletes the session directory (post-construction wiring: RefineService
    // is built after WorkspaceService).
    workspaceService.setRefinePassCanceller(refineService);
    workspaceService.setTimelineRecorder(timelineService);
    taskService.setTimelineRecorder(timelineService);
    heartbeatService.setTimelineRecorder(timelineService);
    workspaceGoalService.setTimelineRecorder(timelineService);
    turnRequestBuilderBindings.timelineService = timelineService;
    timelineService.subscribeToWorkspace(workspaceService);

    mcpServerManager.setMcpOauthService(mcpOauthService);
    turnRequestBuilderBindings.codexOauthService = codexOauthService;
    turnRequestBuilderBindings.coderOauthService = coderOauthService;

    // Wire terminal service to workspace service for cleanup on removal
    workspaceService.setTerminalService(terminalService);
    workspaceService.setDesktopSessionManager(desktopSessionManager);
    // Plugin-override pruning is wired inside the core graph (shared with
    // headless CLI registration), using the WorkspaceMcpOverridesService.

    workspaceService.setWorktreeArchiveSnapshotService(worktreeArchiveSnapshotService);
    const getArchiveBehavior = () =>
      config.loadConfigOrDefault().coderWorkspaceArchiveBehavior ?? DEFAULT_CODER_ARCHIVE_BEHAVIOR;
    workspaceLifecycleHooks.registerBeforeArchive(
      createCoderArchiveHook({
        coderService,
        getArchiveBehavior,
        // Model-driven archives probe the remote spawn-record layout before stopping a
        // running Coder workspace: detached jobs surviving an unclean Xum exit live only in
        // those records, which the host-local crash-orphan scans cannot see.
        hasUnsettledRemoteBackgroundJobs: async (workspaceMetadata) => {
          const runtime = createRuntimeForWorkspace(workspaceMetadata);
          return await backgroundProcessManager.hasUnsettledRemoteSpawnRecords(
            runtime,
            workspaceMetadata.id
          );
        },
      })
    );
    workspaceLifecycleHooks.registerAfterUnarchive(
      createCoderUnarchiveHook({
        coderService,
        getArchiveBehavior,
      })
    );
    const getWorktreeArchiveBehavior = () =>
      config.loadConfigOrDefault().worktreeArchiveBehavior ?? DEFAULT_WORKTREE_ARCHIVE_BEHAVIOR;
    workspaceLifecycleHooks.registerAfterArchive(
      createWorktreeArchiveHook({ getWorktreeArchiveBehavior })
    );
    workspaceService.setWorkspaceLifecycleHooks(workspaceLifecycleHooks);

    // Register globally so all createRuntime calls can create CoderSSHRuntime
    setGlobalCoderService(coderService);
    setSshPromptService(sshPromptService);
    setSSH2SshPromptService(sshPromptService);

    // Backend timing stats.
    aiService.on("stream-start", (data: StreamStartEvent) =>
      sessionTimingService.handleStreamStart(data)
    );
    aiService.on("stream-delta", (data: StreamDeltaEvent) =>
      sessionTimingService.handleStreamDelta(data)
    );
    aiService.on("reasoning-delta", (data: ReasoningDeltaEvent) =>
      sessionTimingService.handleReasoningDelta(data)
    );
    aiService.on("tool-call-start", (data: ToolCallStartEvent) =>
      sessionTimingService.handleToolCallStart(data)
    );
    aiService.on("tool-call-delta", (data: ToolCallDeltaEvent) =>
      sessionTimingService.handleToolCallDelta(data)
    );
    aiService.on("tool-call-end", (data: ToolCallEndEvent) =>
      sessionTimingService.handleToolCallEnd(data)
    );
    // Newly created sub-agent workspaces are ingested here before a full rebuild,
    // so keep workspaceName + parentWorkspaceId to avoid NULL analytics attribution.
    // Multi-project workspaces stay stored under _multi in config, but analytics should
    // still attribute spend to the workspace's first real project path.
    const ingestWorkspaceAnalytics = (workspaceId: string) => {
      const workspaceLookup = config.findWorkspace(workspaceId);
      const sessionDir = path.join(config.sessionsDir, workspaceId);
      const analyticsProjectPath =
        workspaceLookup?.attributionProjectPath ?? workspaceLookup?.projectPath;
      analyticsService.ingestWorkspace(workspaceId, sessionDir, {
        projectPath: analyticsProjectPath,
        projectName: analyticsProjectPath ? path.basename(analyticsProjectPath) : undefined,
        workspaceName: workspaceLookup?.workspaceName,
        parentWorkspaceId: workspaceLookup?.parentWorkspaceId,
      });
    };
    aiService.on("stream-end", (data: StreamEndEvent) => {
      sessionTimingService.handleStreamEnd(data);
      ingestWorkspaceAnalytics(data.workspaceId);
    });
    // Billable usage persisted outside StreamManager stream-end requests its
    // own incremental ingest pass.
    workspaceService.on("analyticsIngest", (event) => {
      ingestWorkspaceAnalytics(event.workspaceId);
    });
    // Memory consolidation/harvest spend rides the headless-usage sidecar
    // without any chat activity; ingest promptly so background sweeps reach
    // dashboard totals instead of stranding until an unrelated stream-end
    // or app restart.
    memoryConsolidationService.on("analyticsIngest", (event: { workspaceId: string }) => {
      ingestWorkspaceAnalytics(event.workspaceId);
    });
    // WorkspaceService emits metadata:null after successful remove().
    // Clear analytics rows immediately so deleted workspaces disappear from stats
    // without waiting for a future ingest pass.
    workspaceService.on("metadata", (event) => {
      if (event.metadata !== null) {
        return;
      }

      // Removed sub-agent children archive their transcript into the parent's
      // session dir before this event fires. Re-ingest the parent (chained after
      // the clear) so the child's spend is restored from the archive instead of
      // vanishing from analytics until the parent's next stream-end.
      let reingestAfterClear:
        | { workspaceId: string; sessionDir: string; meta: IngestWorkspaceMeta }
        | undefined;
      const parentWorkspaceId = event.removedParentWorkspaceId;
      if (parentWorkspaceId) {
        const parentLookup = config.findWorkspace(parentWorkspaceId);
        const parentProjectPath = parentLookup?.attributionProjectPath ?? parentLookup?.projectPath;
        reingestAfterClear = {
          workspaceId: parentWorkspaceId,
          sessionDir: path.join(config.sessionsDir, parentWorkspaceId),
          meta: {
            projectPath: parentProjectPath,
            projectName: parentProjectPath ? path.basename(parentProjectPath) : undefined,
            workspaceName: parentLookup?.workspaceName,
            parentWorkspaceId: parentLookup?.parentWorkspaceId,
          },
        };
      }

      analyticsService.clearWorkspace(event.workspaceId, { reingestAfterClear });
    });

    aiService.on("stream-abort", (data: StreamAbortEvent) => {
      sessionTimingService.handleStreamAbort(data);
      // Aborted turns persist their spend before this event fires (same async
      // chain): normal aborts commit the usage-stamped partial to chat.jsonl
      // (or the headless sidecar for non-commit-worthy partials); abandoned
      // aborts (edit/discard) write only the sidecar. Ingest both, or the
      // interrupted turn's spend stays out of dashboards until the next
      // stream-end.
      ingestWorkspaceAnalytics(data.workspaceId);
    });
    // Errored turns whose partial would be dropped at commit time route their
    // usage to the headless sidecar (persistStreamError). The sidecar write
    // precedes this event in the same async chain, so ingest here keeps the
    // dashboard current instead of waiting for the next stream or restart.
    aiService.on("error", (data: ErrorEvent) => {
      ingestWorkspaceAnalytics(data.workspaceId);
    });
  })
);

// ---------------------------------------------------------------------------
// Staged composition (the group DAG). Base groups are true siblings: none of
// their constructors takes another desktop service (audited per constructor;
// only `CoderOauthService` subscribes to a collaborator — the core
// ProviderService — in its constructor, and the two token managers start their
// own unref'd cleanup intervals). OAuth and the workers need base services.
// ---------------------------------------------------------------------------

const DesktopBase = Layer.mergeAll(
  MiscDesktopLive,
  BrowserLive,
  DesktopBridgeLive,
  TerminalEditorLive
);
const DesktopUpper = Layer.mergeAll(OauthLive, WorkersLive).pipe(Layer.provideMerge(DesktopBase));

/**
 * Every desktop-only service, wired. Built above the core graph: it needs the
 * stores, the runtime's `EffectRunner`, the cross-cutting services and every
 * core tag (`AppLive` in ./app.ts provides them beneath).
 */
export const DesktopLive: Layer.Layer<
  DesktopTags,
  never,
  StoreTags | EffectRunnerTag | CrossCuttingTags | CoreTags
> = DesktopWiringLive.pipe(Layer.provideMerge(DesktopUpper));

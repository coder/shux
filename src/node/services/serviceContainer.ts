import type { RestartBlocker } from "@/common/orpc/types";
import { inFlightProcedureCount } from "@/node/orpc/inFlightProcedures";
import { inProcessWorkflowWorkspaceCount } from "@/node/services/workflows/workflowArchiveAdmission";
import assert from "@/common/utils/assert";
import { log } from "@/node/services/log";
import type { Config, ConfigStores, WorkspaceSessionLocator } from "@/node/config";
import type { FileLeaseManager, ProvidersConfigStore, SecretsStore } from "@/node/config";
import { SLOW_STARTUP_WARN_THRESHOLD_MS } from "@/constants/startup";
import {
  STARTUP_HOUSEKEEPING_JOIN_TIMEOUT_MS,
  STARTUP_STEP_TIMEOUT_MS,
} from "@/constants/terminationTimeouts";
import type { CoreServices } from "@/node/services/coreServices";
import type { DesktopWindowManager } from "@/desktop/desktopWindowManager";
import type { TerminalWindowManager } from "@/desktop/terminalWindowManager";
import type { ProjectService } from "@/node/services/projectService";
import type { MuxGatewayOauthService } from "@/node/services/muxGatewayOauthService";
import type { MuxGovernorOauthService } from "@/node/services/muxGovernorOauthService";
import type { CodexOauthService } from "@/node/services/codexOauthService";
import type { CoderOauthService } from "@/node/services/coderOauthService";
import type { CopilotOauthService } from "@/node/services/copilotOauthService";
import type { TerminalService } from "@/node/services/terminalService";
import type { BackupService } from "@/node/services/backup/backupService";
import type { EditorService } from "@/node/services/editorService";
import type { WindowService } from "@/node/services/windowService";
import type { UpdateService } from "@/node/services/updateService";
import type { TokenizerService } from "@/node/services/tokenizerService";
import type { InstructionsService } from "@/node/services/instructionsService";
import type { ServerService } from "@/node/services/serverService";
import type { MenuEventService } from "@/node/services/menuEventService";
import type { VoiceService } from "@/node/services/voiceService";
import type { TelemetryService } from "@/node/services/telemetryService";
import type { BrowserBridgeServer } from "@/node/services/browser/BrowserBridgeServer";
import type { AgentBrowserSessionDiscoveryService } from "@/node/services/browser/AgentBrowserSessionDiscoveryService";
import type { BrowserBridgeTokenManager } from "@/node/services/browser/BrowserBridgeTokenManager";
import type { BrowserControlService } from "@/node/services/browser/BrowserControlService";
import type { BrowserSessionStateHub } from "@/node/services/browser/BrowserSessionStateHub";
import type { DevToolsService } from "@/node/services/devToolsService";
import type { SessionTimingService } from "@/node/services/sessionTimingService";
import type { TimelineService } from "@/node/services/timelineService";
import type { AnalyticsService } from "@/node/services/analytics/analyticsService";
import type { ExperimentsService } from "@/node/services/experimentsService";
import type { WorkspaceMcpOverridesService } from "@/node/services/workspaceMcpOverridesService";
import type { AgentPluginInstallService } from "@/node/services/agentPlugins/installService";
import type { McpOauthService } from "@/node/services/mcpOauthService";
import type { HeartbeatService } from "@/node/services/heartbeatService";
import type { AgentStatusService } from "@/node/services/agentStatusService";
import type { IdleCompactionService } from "@/node/services/idleCompactionService";
import type { IdleDispatcher } from "@/node/services/idleDispatcher";
import type { CoderService } from "@/node/services/coderService";
import type { SshPromptService } from "@/node/services/sshPromptService";
import type { QuickJSRuntimeFactory } from "@/node/services/ptc/quickjsRuntime";
import type { RefineService } from "@/node/services/refinement/refineService";
import type { PolicyService } from "@/node/services/policyService";
import type { ServerAuthService } from "@/node/services/serverAuthService";
import type { DesktopBridgeServer } from "@/node/services/desktop/DesktopBridgeServer";
import type { DesktopSessionManager } from "@/node/services/desktop/DesktopSessionManager";
import type { DesktopTokenManager } from "@/node/services/desktop/DesktopTokenManager";
import type { ORPCContext } from "@/node/orpc/context";
import { Duration, Effect } from "effect";
import type { Scope } from "effect";
import { AppFiberScopeTag } from "@/node/services/di/appFiberScope";
import {
  closeScopeBounded,
  disposeAppRuntime,
  makeAppRuntime,
  type AppRuntime,
} from "@/node/services/di/appRuntime";
import { AppLive } from "@/node/services/di/layers/app";
import { shutdownStep } from "@/node/services/shutdownStep";
import { raceWithAbortAndTimeout } from "@/node/utils/concurrency/withTimeout";
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
  InitStateManagerTag,
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
  QuickJSRuntimeFactoryTag,
  Refine,
  SecretsStoreTag,
  Server,
  ServerAuth,
  SessionLocatorTag,
  SessionTiming,
  SessionUsage,
  SshPrompt,
  StreamManagerTag,
  Task,
  Telemetry,
  Terminal,
  Timeline,
  Tokenizer,
  Update,
  Voice,
  WindowTag,
  Workspace,
  WorkspaceGoal,
  WorkspaceMcpOverrides,
  WorkspaceTurnManagerTag,
  type AppTags,
} from "@/node/services/di/tags";

/**
 * A hard startup step of `ServiceContainer.initializeCore()` did not settle
 * within `STARTUP_STEP_TIMEOUT_MS`. Rejects `initializeCore()` like any other
 * step failure, so the roots' existing startup-failure paths apply unchanged;
 * `name` is set explicitly so their default `Error` formatting (desktop
 * "Startup Failed" dialog, `Failed to initialize server:` line) shows the
 * class together with the step.
 */
export class StartupStepTimeoutError extends Error {
  constructor(
    readonly step: string,
    readonly timeoutMs: number
  ) {
    super(`${step} exceeded ${timeoutMs} ms`);
    this.name = "StartupStepTimeoutError";
  }
}

interface StartupStep {
  /** `stepDurationsMs` key of the startup completion log and `StartupStepTimeoutError.step`. */
  readonly name: string;
  readonly run: () => Promise<void>;
}

/**
 * ServiceContainer - Central dependency container for all backend services.
 *
 * Every service is built by the Effect Layer graph (`di/layers/app.ts`: the
 * stores, the runtime seams, the cross-cutting services, the core graph shared
 * with the CLI roots, and the desktop group layers with their wiring). The
 * constructor builds that graph once, eagerly and synchronously, and exposes
 * the services as plain fields for the ORPC context; startup (`initialize()`)
 * and the hand-ordered teardown (`dispose()`/`shutdown()`) stay here (DI
 * contract in `di/appRuntime.ts`).
 */
export class ServiceContainer {
  public readonly runtime: AppRuntime<AppTags>;
  /**
   * Supervised fiber scope owned by the runtime (`di/appFiberScope.ts`).
   * Closed early in `dispose()`; no production occupant yet.
   */
  public readonly appFiberScope: Scope.Closeable;
  public readonly workflowRuntimeFactory: QuickJSRuntimeFactory;
  public readonly config: Config;
  public readonly sessionLocator: WorkspaceSessionLocator;
  public readonly providersConfigStore: ProvidersConfigStore;
  public readonly secretsStore: SecretsStore;
  public readonly fileLeaseManager: FileLeaseManager;
  // Core services — built by the shared core graph layer (`di/layers/core.ts`;
  // the same definitions back the `xum run`/`xum workflow` roots)
  private readonly historyService: CoreServices["historyService"];
  public readonly aiService: CoreServices["aiService"];
  public readonly streamManager: CoreServices["streamManager"];
  public readonly initStateManager: CoreServices["initStateManager"];
  public readonly workspaceService: CoreServices["workspaceService"];
  public readonly taskService: CoreServices["taskService"];
  public readonly workspaceTurnManager: CoreServices["workspaceTurnManager"];
  public readonly providerService: CoreServices["providerService"];
  public readonly mcpConfigService: CoreServices["mcpConfigService"];
  public readonly mcpServerManager: CoreServices["mcpServerManager"];
  public readonly sessionUsageService: CoreServices["sessionUsageService"];
  public readonly workspaceGoalService: CoreServices["workspaceGoalService"];
  public readonly memoryService: CoreServices["memoryService"];
  public readonly memoryMetaService: CoreServices["memoryMetaService"];
  public readonly memoryConsolidationService: CoreServices["memoryConsolidationService"];
  public readonly refineService: RefineService;
  private readonly extensionMetadata: CoreServices["extensionMetadata"];
  public readonly backgroundProcessManager: CoreServices["backgroundProcessManager"];
  // Desktop-only services (`di/layers/desktop.ts`)
  public readonly projectService: ProjectService;
  public readonly muxGatewayOauthService: MuxGatewayOauthService;
  public readonly muxGovernorOauthService: MuxGovernorOauthService;
  public readonly codexOauthService: CodexOauthService;
  public readonly coderOauthService: CoderOauthService;
  public readonly copilotOauthService: CopilotOauthService;
  public readonly backupService: BackupService;
  public readonly terminalService: TerminalService;
  public readonly editorService: EditorService;
  public readonly windowService: WindowService;
  public readonly updateService: UpdateService;
  public readonly tokenizerService: TokenizerService;
  public readonly instructionsService: InstructionsService;
  public readonly serverService: ServerService;
  public readonly menuEventService: MenuEventService;
  public readonly voiceService: VoiceService;
  public readonly mcpOauthService: McpOauthService;
  public readonly workspaceMcpOverridesService: WorkspaceMcpOverridesService;
  public readonly agentPluginInstallService: AgentPluginInstallService;
  public readonly telemetryService: TelemetryService;
  public readonly sessionTimingService: SessionTimingService;
  public readonly timelineService: TimelineService;
  public readonly devToolsService: DevToolsService;
  public readonly browserSessionDiscoveryService: AgentBrowserSessionDiscoveryService;
  public readonly browserBridgeTokenManager: BrowserBridgeTokenManager;
  public readonly browserBridgeServer: BrowserBridgeServer;
  public readonly browserControlService: BrowserControlService;
  public readonly browserSessionStateHub: BrowserSessionStateHub;
  public readonly analyticsService: AnalyticsService;
  public readonly experimentsService: ExperimentsService;
  public readonly policyService: PolicyService;
  public readonly coderService: CoderService;
  public readonly serverAuthService: ServerAuthService;
  public readonly desktopSessionManager: DesktopSessionManager;
  public readonly desktopTokenManager: DesktopTokenManager;
  public readonly desktopBridgeServer: DesktopBridgeServer;
  public readonly sshPromptService: SshPromptService;
  public readonly idleCompactionService: IdleCompactionService;
  public readonly idleDispatcher: IdleDispatcher;
  public readonly heartbeatService: HeartbeatService;
  public readonly agentStatusService: AgentStatusService;
  // Shared between initializeCore() and runStartupHousekeeping() so the completion log still
  // reports every step and the total wall time from the start of core init.
  private startupStartedAt: number | undefined;
  private readonly startupStepDurationsMs: Record<string, number> = {};
  // Aborted by dispose(): background startup housekeeping must stop at its next step boundary
  // and never start periodic services against services that are being torn down.
  private readonly startupHousekeepingAbort = new AbortController();
  // Retained so dispose() can wait for the in-flight housekeeping step to settle (bounded)
  // before tearing down the services it is using.
  private startupHousekeepingSettled: Promise<void> | null = null;

  /**
   * The in-flight (or completed) `dispose()` teardown. Every caller shares it,
   * so a concurrent or repeated dispose() (the desktop's two before-quit
   * paths, tests' dispose-then-shutdown) awaits the one sequence instead of
   * re-running steps — in particular it cannot observe the AppFiberScope as
   * already closed and start tearing down dependencies while the first call
   * is still awaiting the scope's fibers.
   */
  private disposePromise: Promise<void> | null = null;

  constructor(stores: ConfigStores) {
    // Built eagerly and synchronously: a layer body that throws fails the
    // constructor, like any service constructor did before the graph existed.
    this.runtime = makeAppRuntime(AppLive(stores));
    const get = this.runtime.get;
    this.appFiberScope = get(AppFiberScopeTag);
    this.workflowRuntimeFactory = get(QuickJSRuntimeFactoryTag);
    this.config = get(ConfigTag);
    this.sessionLocator = get(SessionLocatorTag);
    this.providersConfigStore = get(ProvidersConfigStoreTag);
    this.secretsStore = get(SecretsStoreTag);
    this.fileLeaseManager = get(FileLeaseManagerTag);
    this.historyService = get(History);
    this.aiService = get(AI);
    this.streamManager = get(StreamManagerTag);
    this.initStateManager = get(InitStateManagerTag);
    this.workspaceService = get(Workspace);
    this.taskService = get(Task);
    this.workspaceTurnManager = get(WorkspaceTurnManagerTag);
    this.providerService = get(Provider);
    this.mcpConfigService = get(MCPConfig);
    this.mcpServerManager = get(MCPServerManagerTag);
    this.sessionUsageService = get(SessionUsage);
    this.workspaceGoalService = get(WorkspaceGoal);
    this.memoryService = get(Memory);
    this.memoryMetaService = get(MemoryMeta);
    this.memoryConsolidationService = get(MemoryConsolidation);
    this.refineService = get(Refine);
    this.extensionMetadata = get(ExtensionMetadata);
    this.backgroundProcessManager = get(BackgroundProcessManagerTag);
    this.projectService = get(Project);
    this.muxGatewayOauthService = get(MuxGatewayOauth);
    this.muxGovernorOauthService = get(MuxGovernorOauth);
    this.codexOauthService = get(CodexOauth);
    this.coderOauthService = get(CoderOauth);
    this.copilotOauthService = get(CopilotOauth);
    this.backupService = get(Backup);
    this.terminalService = get(Terminal);
    this.editorService = get(Editor);
    this.windowService = get(WindowTag);
    this.updateService = get(Update);
    this.tokenizerService = get(Tokenizer);
    this.instructionsService = get(Instructions);
    this.serverService = get(Server);
    this.menuEventService = get(MenuEvent);
    this.voiceService = get(Voice);
    this.mcpOauthService = get(McpOauth);
    this.workspaceMcpOverridesService = get(WorkspaceMcpOverrides);
    this.agentPluginInstallService = get(AgentPluginInstall);
    this.telemetryService = get(Telemetry);
    this.sessionTimingService = get(SessionTiming);
    this.timelineService = get(Timeline);
    this.devToolsService = get(DevTools);
    this.browserSessionDiscoveryService = get(AgentBrowserSessionDiscovery);
    this.browserBridgeTokenManager = get(BrowserBridgeTokenManagerTag);
    this.browserBridgeServer = get(BrowserBridgeServerTag);
    this.browserControlService = get(BrowserControl);
    this.browserSessionStateHub = get(BrowserSessionStateHubTag);
    this.analyticsService = get(Analytics);
    this.experimentsService = get(Experiments);
    this.policyService = get(Policy);
    this.coderService = get(Coder);
    this.serverAuthService = get(ServerAuth);
    this.desktopSessionManager = get(DesktopSessionManagerTag);
    this.desktopTokenManager = get(DesktopTokenManagerTag);
    this.desktopBridgeServer = get(DesktopBridgeServerTag);
    this.sshPromptService = get(SshPrompt);
    this.idleCompactionService = get(IdleCompaction);
    this.idleDispatcher = get(IdleDispatcherTag);
    this.heartbeatService = get(Heartbeat);
    this.agentStatusService = get(AgentStatus);
    assert(
      new Set(this.startupCoreSteps.map((step) => step.name)).size === this.startupCoreSteps.length,
      "startupCoreSteps names must be unique (they key stepDurationsMs)"
    );
  }

  async initialize(): Promise<void> {
    await this.initializeCore();
    await this.runStartupHousekeeping();
  }

  private async recordStartupStep<T>(name: string, fn: () => Promise<T>): Promise<T> {
    const stepStartedAt = Date.now();
    try {
      return await fn();
    } finally {
      this.startupStepDurationsMs[name] = Date.now() - stepStartedAt;
    }
  }

  /**
   * The hard startup steps, in order: everything request handling depends on, plus agent-task
   * restart recovery. All five are mandatory — a failure stops startup — and every name is a
   * `stepDurationsMs` key of the `[startup] ServiceContainer.initialize completed` line (and the
   * `step` of a `StartupStepTimeoutError`), so names and order are an observability contract.
   * Downgrading a step to best-effort is runStartupHousekeeping()'s policy, not a change here.
   */
  private readonly startupCoreSteps: readonly StartupStep[] = [
    { name: "extensionMetadata.initialize", run: () => this.extensionMetadata.initialize() },
    { name: "telemetryService.initialize", run: () => this.telemetryService.initialize() },
    // Startup gating
    { name: "policyService.initialize", run: () => this.policyService.initialize() },
    { name: "experimentsService.initialize", run: () => this.experimentsService.initialize() },
    {
      name: "taskService.recoverInterruptedTasks",
      run: () => this.taskService.recoverInterruptedTasks(),
    },
  ];

  /**
   * Runs `startupCoreSteps` on the app runtime (startup contract in di/appRuntime.ts). The
   * server entry point awaits this before binding its listener: task recovery must finish before
   * any client can stop, resume, or send to a task (see TaskService.recoverInterruptedTasks), and
   * it is bounded by the number of active tasks rather than by deployment size. The per-workspace
   * housekeeping lives in runStartupHousekeeping().
   *
   * Rejects with the failing step's own error (identity preserved — a synchronous throw included)
   * or with a `StartupStepTimeoutError` once a step exceeds `STARTUP_STEP_TIMEOUT_MS` on the
   * runtime clock; later steps do not run. A timed-out step keeps running as a plain promise
   * (nothing here observes its result afterwards), which is why every root runs the bounded
   * `dispose()` before exiting on a rejected startup. Not re-entrancy guarded: a second call
   * re-runs the steps, as the plain promise chain did.
   */
  async initializeCore(): Promise<void> {
    assert(this.disposePromise === null, "ServiceContainer.initializeCore() after dispose()");
    await this.runtime.managed.runPromise(this.startupCoreEffect());
  }

  private startupCoreEffect(): Effect.Effect<void, unknown> {
    // eslint-disable-next-line @typescript-eslint/no-this-alias -- Effect.gen generator bodies do not inherit `this`
    const self = this;
    return Effect.gen(function* () {
      self.startupStartedAt = Date.now();
      log.info("[startup] ServiceContainer.initialize starting");
      for (const step of self.startupCoreSteps) {
        yield* self.timedStartupStep(step);
      }
    });
  }

  /**
   * One startup step as an effect. `tryPromise` with an identity catch keeps the rejection
   * reason as the failure; the `async` thunk turns a synchronous throw into the same path.
   * `timeoutOrElse` (not `timeout` + `catchTag`: the error channel is `unknown`, which
   * `catchTag` cannot narrow) races the wait against the runtime clock and interrupts only the
   * wait — the zero-arity thunk gets no AbortSignal, so the promise keeps running and its
   * eventual settlement is a no-op on the exited fiber (`tryPromise` keeps a rejection handler
   * attached, so a late rejection is never unhandled). The duration is recorded when the wait
   * ends — settled, failed, or abandoned at the timeout — never by the abandoned step later.
   */
  private timedStartupStep(step: StartupStep): Effect.Effect<void, unknown> {
    return Effect.suspend(() => {
      const stepStartedAt = Date.now();
      return Effect.tryPromise({
        try: async () => step.run(),
        catch: (error: unknown) => error,
      }).pipe(
        Effect.timeoutOrElse({
          duration: Duration.millis(STARTUP_STEP_TIMEOUT_MS),
          // Fatal on purpose — the same exit path a throwing step already takes on every root
          // (desktop "Startup Failed" dialog, server/ACP log-and-exit). These are the hard steps
          // request handling depends on (#4058): continuing past a timed-out step would, e.g., let
          // the server accept task operations while task recovery is still running. The
          // "startup must never crash the app" rule governs the best-effort work in
          // runStartupHousekeeping(), which stays non-fatal; this bound only turns an indefinite
          // hang (splash pinned, listener never bound, no dispose) into the existing failure path.
          orElse: () =>
            Effect.fail(new StartupStepTimeoutError(step.name, STARTUP_STEP_TIMEOUT_MS)),
        }),
        Effect.ensuring(
          Effect.sync(() => {
            this.startupStepDurationsMs[step.name] = Date.now() - stepStartedAt;
          })
        )
      );
    });
  }

  /**
   * Startup housekeeping that scales with the number of workspaces (chat restart retries and
   * orphan sweeps, reported-task patch and cleanup passes, terminal-attention sweeps), then the
   * periodic services. The server runs it after its listener is bound, so every step re-checks
   * live state before mutating; dispose() cancels it at the next step boundary and waits
   * (bounded) for the step in flight to settle.
   */
  runStartupHousekeeping(): Promise<void> {
    const housekeeping = this.runStartupHousekeepingSteps();
    this.startupHousekeepingSettled = housekeeping.then(
      () => undefined,
      () => undefined
    );
    return housekeeping;
  }

  private async runStartupHousekeepingSteps(): Promise<void> {
    const signal = this.startupHousekeepingAbort.signal;
    // Housekeeping is best-effort and may run while the server is already serving requests: a
    // failing step must not skip the periodic services below (startup-time rule: never let
    // background housekeeping take the app down).
    // Kick off non-task chat restart recovery eagerly; task workspaces recover in TaskService.
    try {
      await this.recordStartupStep("workspaceService.initialize", () =>
        this.workspaceService.initialize({ signal })
      );
    } catch (error: unknown) {
      log.error("[startup] WorkspaceService recovery failed", { error });
    }
    if (signal.aborted) {
      log.info("[startup] Startup housekeeping cancelled by dispose before task housekeeping");
      return;
    }
    try {
      await this.recordStartupStep("taskService.runStartupHousekeeping", () =>
        this.taskService.runStartupHousekeeping({ signal })
      );
    } catch (error: unknown) {
      log.error("[startup] TaskService housekeeping failed", { error });
    }
    if (signal.aborted) {
      log.info("[startup] Startup housekeeping cancelled by dispose before periodic services");
      return;
    }

    const idleCompactionStartedAt = Date.now();
    // Start idle compaction checker
    this.idleCompactionService.start();
    this.startupStepDurationsMs["idleCompactionService.start"] =
      Date.now() - idleCompactionStartedAt;

    const heartbeatStartedAt = Date.now();
    this.heartbeatService.start();
    this.startupStepDurationsMs["heartbeatService.start"] = Date.now() - heartbeatStartedAt;

    const agentStatusStartedAt = Date.now();
    this.agentStatusService.start();
    this.startupStepDurationsMs["agentStatusService.start"] = Date.now() - agentStatusStartedAt;

    // Dream launch sweep (PRD #3534): consolidate memory for workspaces idle
    // ≥24h with writes since their last run. Fire-and-forget after the await
    // chain — startup must never block or crash on background housekeeping.
    void this.extensionMetadata
      .getAllSnapshots()
      .then((snapshots) => {
        const recencyByWorkspace = new Map<string, number>();
        for (const [workspaceId, snapshot] of snapshots) {
          recencyByWorkspace.set(workspaceId, snapshot.recency);
        }
        return this.memoryConsolidationService.runLaunchSweep(recencyByWorkspace);
      })
      .catch((error: unknown) => {
        log.warn("[MemoryConsolidation] launch sweep failed", { error });
      });

    // Refresh xum-owned Coder SSH config in background (handles binary path changes on restart)
    // Skip getCoderInfo() to avoid caching "unavailable" if coder isn't installed yet
    void this.coderService.ensureMuxCoderSSHConfig().catch((error: unknown) => {
      log.warn("Background xum SSH config setup failed", { error });
    });

    const totalMs = Date.now() - (this.startupStartedAt ?? Date.now());
    const completedPayload = { totalMs, stepDurationsMs: this.startupStepDurationsMs };
    if (totalMs > SLOW_STARTUP_WARN_THRESHOLD_MS) {
      log.warn("[startup] ServiceContainer.initialize completed", completedPayload);
    } else {
      log.info("[startup] ServiceContainer.initialize completed", completedPayload);
    }
  }

  /**
   * Build the ORPCContext from this container's services.
   * Centralizes the ServiceContainer → ORPCContext mapping so callers
   * (desktop/main.ts, cli/server.ts) don't duplicate a 30-field spread.
   */
  toORPCContext(): Omit<ORPCContext, "headers"> {
    return {
      // The runtime's built service context, consumed by Effect-native oRPC
      // handlers (`yield* MemoryMeta`; see src/node/orpc/effectContext.ts).
      "effect/context": this.runtime.context,
      workflowRuntimeFactory: this.workflowRuntimeFactory,
      config: this.config,
      sessionLocator: this.sessionLocator,
      providersConfigStore: this.providersConfigStore,
      secretsStore: this.secretsStore,
      fileLeaseManager: this.fileLeaseManager,
      aiService: this.aiService,
      historyService: this.historyService,
      streamManager: this.streamManager,
      initStateManager: this.initStateManager,
      projectService: this.projectService,
      workspaceService: this.workspaceService,
      taskService: this.taskService,
      providerService: this.providerService,
      muxGatewayOauthService: this.muxGatewayOauthService,
      muxGovernorOauthService: this.muxGovernorOauthService,
      codexOauthService: this.codexOauthService,
      coderOauthService: this.coderOauthService,
      copilotOauthService: this.copilotOauthService,
      backupService: this.backupService,
      terminalService: this.terminalService,
      editorService: this.editorService,
      windowService: this.windowService,
      updateService: this.updateService,
      tokenizerService: this.tokenizerService,
      instructionsService: this.instructionsService,
      serverService: this.serverService,
      menuEventService: this.menuEventService,
      voiceService: this.voiceService,
      mcpConfigService: this.mcpConfigService,
      mcpOauthService: this.mcpOauthService,
      workspaceMcpOverridesService: this.workspaceMcpOverridesService,
      mcpServerManager: this.mcpServerManager,
      agentPluginInstallService: this.agentPluginInstallService,
      sessionTimingService: this.sessionTimingService,
      timelineService: this.timelineService,
      telemetryService: this.telemetryService,
      analyticsService: this.analyticsService,
      experimentsService: this.experimentsService,
      sessionUsageService: this.sessionUsageService,
      workspaceGoalService: this.workspaceGoalService,
      memoryService: this.memoryService,
      memoryMetaService: this.memoryMetaService,
      memoryConsolidationService: this.memoryConsolidationService,
      refineService: this.refineService,
      devToolsService: this.devToolsService,
      browserSessionDiscoveryService: this.browserSessionDiscoveryService,
      browserBridgeTokenManager: this.browserBridgeTokenManager,
      browserBridgeServer: this.browserBridgeServer,
      browserControlService: this.browserControlService,
      browserSessionStateHub: this.browserSessionStateHub,
      policyService: this.policyService,
      coderService: this.coderService,
      serverAuthService: this.serverAuthService,
      sshPromptService: this.sshPromptService,
      desktopSessionManager: this.desktopSessionManager,
      desktopTokenManager: this.desktopTokenManager,
      desktopBridgeServer: this.desktopBridgeServer,
    };
  }

  /**
   * Shutdown services that need cleanup
   */
  async shutdown(): Promise<void> {
    // Viewers must release held input before their VNC bridge is revoked.
    await this.desktopSessionManager.closeAll();
    await this.desktopBridgeServer.stop();
    this.desktopTokenManager.dispose();
    this.heartbeatService.stop();
    this.agentStatusService.stop();
    this.idleCompactionService.stop();
    await this.browserBridgeServer.stop();
    this.browserSessionStateHub.dispose();
    this.browserBridgeTokenManager.dispose();
    await this.timelineService.flush();
    await this.analyticsService.dispose();
    await this.telemetryService.shutdown();
  }

  setProjectDirectoryPicker(picker: (initialPath?: string | null) => Promise<string | null>): void {
    this.projectService.setDirectoryPicker(picker);
  }

  setDesktopWindowManager(manager: DesktopWindowManager): void {
    this.desktopSessionManager.setDesktopWindowManager(manager);
  }

  setTerminalWindowManager(manager: TerminalWindowManager): void {
    this.terminalService.setTerminalWindowManager(manager);
  }

  /** Background process statuses refresh lazily, so refresh them before a blocker snapshot. */
  async refreshRestartBlockers(): Promise<void> {
    await this.backgroundProcessManager.list();
  }

  collectRestartBlockers(): RestartBlocker[] {
    const blockers = this.workspaceService.collectRestartBlockers();
    const counts: Array<[RestartBlocker["kind"], number]> = [
      ["active-streams", this.streamManager.getActiveStreams().length],
      ["workflows", inProcessWorkflowWorkspaceCount()],
      ["projects", this.projectService.getMutationCount()],
      ["requests", inFlightProcedureCount()],
      ["terminals", this.terminalService.getOpenSessionCount()],
      ["desktop-sessions", this.desktopSessionManager.getSessionCount()],
      ["background-processes", this.backgroundProcessManager.getRunningProcessCount()],
    ];
    for (const [kind, count] of counts) {
      if (count > 0) {
        const existing = blockers.find((blocker) => blocker.kind === kind);
        if (existing) existing.count += count;
        else blockers.push({ kind, count });
      }
    }
    return blockers;
  }

  /**
   * Dispose all services. Called on app quit to clean up resources.
   * Terminates all background processes to prevent orphans. Idempotent:
   * concurrent and repeated calls share one teardown (see `disposePromise`).
   */
  dispose(): Promise<void> {
    this.disposePromise ??= this.disposeOnce();
    return this.disposePromise;
  }

  /**
   * The §5 teardown order (di/appRuntime.ts). Every step reports its duration
   * as a `[shutdown]` debug line via `shutdownStep` (synchronous steps without
   * a suspension point), so a quit transcript localizes a slow or hung step;
   * `closeScopeBounded`/`disposeAppRuntime` write their own lines.
   */
  private async disposeOnce(): Promise<void> {
    const disposeStartedAt = performance.now();
    log.debug("[shutdown] ServiceContainer.dispose starting");
    // Must run before any session teardown, including the recovery-session sweep below:
    // AgentSession.dispose() triggers backgroundProcessManager.cleanup(), which would otherwise
    // erase the persisted armed-monitor registry records that drive post-restart "monitor lost"
    // wakes.
    shutdownStep("backgroundProcessManager.beginShutdown", () =>
      this.backgroundProcessManager.beginShutdown()
    );
    // Background startup housekeeping (server mode) must not start periodic services or keep
    // issuing work against the services torn down below. Its steps only observe the abort at
    // their boundaries, so give the one in flight a bounded chance to settle first.
    this.startupHousekeepingAbort.abort();
    // Chat recovery that housekeeping scheduled runs past its own promise and observes neither the
    // abort nor the join, so latch every session before the wait: nothing may start a stream inside
    // it, and nothing may dispatch through the provider/runtime services torn down below.
    shutdownStep("serverService.beginShutdown", () => this.serverService.beginShutdown());
    shutdownStep("workspaceService.beginShutdown", () => this.workspaceService.beginShutdown());
    shutdownStep("terminalService.beginShutdown", () => this.terminalService.beginShutdown());
    shutdownStep("projectService.beginShutdown", () => this.projectService.beginShutdown());
    await shutdownStep("updateService.beginShutdown", () => this.updateService.beginShutdown());
    const housekeepingSettled = this.startupHousekeepingSettled;
    if (housekeepingSettled != null) {
      await shutdownStep("startupHousekeeping.join", async () => {
        const joined = await raceWithAbortAndTimeout(housekeepingSettled, {
          timeoutMs: STARTUP_HOUSEKEEPING_JOIN_TIMEOUT_MS,
        });
        if (joined.kind === "timeout") {
          log.warn("[shutdown] startup housekeeping still running; teardown continues", {
            timeoutMs: STARTUP_HOUSEKEEPING_JOIN_TIMEOUT_MS,
          });
        }
      });
    }
    // Interrupt and await the runtime's supervised fibers — the stream engine's
    // per-stream supervisors (StreamManager.superviseEngine): every in-flight
    // stream is aborted as "system" and its partial committed to chat.jsonl —
    // while every dependency they touch during finalization is still alive.
    // Fixed here (before the explicit teardown) so clients still receive the
    // stream-abort over the bridges; bounded and idempotent, and never rejects
    // (di/appRuntime.ts).
    await closeScopeBounded(this.appFiberScope);
    // Viewers must release held input before their VNC bridge is revoked.
    await shutdownStep("desktopSessionManager.closeAll", () =>
      this.desktopSessionManager.closeAll()
    );
    await shutdownStep("desktopBridgeServer.stop", () => this.desktopBridgeServer.stop());
    shutdownStep("desktopTokenManager.dispose", () => this.desktopTokenManager.dispose());
    // Stop the periodic AgentStatusService loop here too (not just in
    // shutdown()): dispose() is the path used by the desktop before-quit
    // and ACP in-process close handlers, and the ref'd setInterval would
    // otherwise keep the process alive and continue calling
    // generateWorkspaceStatus against services that are about to be torn
    // down below.
    shutdownStep("agentStatusService.stop", () => this.agentStatusService.stop());
    await shutdownStep("browserBridgeServer.stop", () => this.browserBridgeServer.stop());
    shutdownStep("browserSessionStateHub.dispose", () => this.browserSessionStateHub.dispose());
    shutdownStep("browserBridgeTokenManager.dispose", () =>
      this.browserBridgeTokenManager.dispose()
    );
    await shutdownStep("analyticsService.dispose", () => this.analyticsService.dispose());
    shutdownStep("policyService.dispose", () => this.policyService.dispose());
    shutdownStep("mcpServerManager.dispose", () => this.mcpServerManager.dispose());
    await shutdownStep("mcpOauthService.dispose", () => this.mcpOauthService.dispose());
    await shutdownStep("muxGatewayOauthService.dispose", () =>
      this.muxGatewayOauthService.dispose()
    );
    await shutdownStep("muxGovernorOauthService.dispose", () =>
      this.muxGovernorOauthService.dispose()
    );
    await shutdownStep("codexOauthService.dispose", () => this.codexOauthService.dispose());
    await shutdownStep("coderOauthService.dispose", () => this.coderOauthService.dispose());

    shutdownStep("copilotOauthService.dispose", () => this.copilotOauthService.dispose());
    shutdownStep("serverAuthService.dispose", () => this.serverAuthService.dispose());
    shutdownStep("providerService.dispose", () => this.providerService.dispose());
    await shutdownStep("backgroundProcessManager.terminateAll", () =>
      this.backgroundProcessManager.terminateAll()
    );
    await shutdownStep("timelineService.flush", () => this.timelineService.flush());
    // Last: close the Effect runtime's scope. No layer owns finalizers yet, so
    // this only releases the runtime; the position (after every explicit
    // teardown step) is fixed now for later scope-owned occupants.
    await disposeAppRuntime(this.runtime.managed);
    log.debug("[shutdown] ServiceContainer.dispose completed", {
      totalMs: Math.round(performance.now() - disposeStartedAt),
    });
  }
}

import * as path from "path";
import { EventEmitter } from "events";
import { createAgentSessionHarness } from "./agentSession.testHarness";
import type { AgentSession } from "./agentSession";
import * as fs from "fs";
import * as os from "os";
import { afterEach, beforeEach, describe, expect, it, spyOn } from "bun:test";
import { Context, Duration, Effect, Layer } from "effect";
import { TestClock } from "effect/testing";
import { MULTI_PROJECT_CONFIG_KEY } from "@/common/constants/multiProject";
import { createConfigStores, type Config, type ConfigStores } from "@/node/config";
import type { ORPCContext } from "@/node/orpc/context";
import { createRuntime } from "@/node/runtime/runtimeFactory";
import { isInteractiveHostKeyApprovalAvailable } from "@/node/runtime/sshConnectionPool";
import { AppFiberScopeTag } from "@/node/services/di/appFiberScope";
import { EffectRunnerTag } from "@/node/services/di/effectRunner";
import * as appLayers from "@/node/services/di/layers/app";
import { CoreOptionsTag } from "@/node/services/di/layers/core";
import { STARTUP_STEP_TIMEOUT_MS } from "@/constants/terminationTimeouts";
import {
  AgentBrowserSessionDiscovery,
  AgentPluginInstall,
  AI,
  Analytics,
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
  FileLeaseManagerTag,
  History,
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
  TurnRequestBuilderBindingsTag,
  Update,
  Voice,
  WindowTag,
  Workspace,
  WorkspaceGoal,
  WorkspaceLifecycleHooksTag,
  WorkspaceMcpOverrides,
  WorktreeArchiveSnapshot,
  type AppTags,
} from "@/node/services/di/tags";
import { ServiceContainer, StartupStepTimeoutError } from "./serviceContainer";
import type {
  BackgroundProcessMonitorState,
  MonitorArmedPayload,
} from "./backgroundProcessManager";
import type {
  BashMonitorWakeDispatch,
  BashMonitorWakeDispatchOutcome,
  BashMonitorWakeReconciler,
} from "./bashMonitorWakeReconciler";
import type { BashMonitorRegistryStore } from "./bashMonitorRegistryStore";
import type { TurnCoordinator } from "@/node/services/turnCoordinator";
import { registerInProcessWorkflowRun } from "@/node/services/workflows/workflowArchiveAdmission";

/**
 * Independent field → tag listing for every ORPC context field (the production
 * mapping lives in the Layer files); `Record<keyof …>` keeps it exhaustive, so
 * a field added to `ORPCContext` without a tag fails to compile here.
 */
const ORPC_FIELD_TAGS: Record<
  keyof Omit<ORPCContext, "headers" | "effect/context" | "effect/wrap">,
  Context.Key<AppTags, unknown>
> = {
  config: ConfigTag,
  sessionLocator: SessionLocatorTag,
  providersConfigStore: ProvidersConfigStoreTag,
  secretsStore: SecretsStoreTag,
  fileLeaseManager: FileLeaseManagerTag,
  aiService: AI,
  historyService: History,
  streamManager: StreamManagerTag,
  initStateManager: InitStateManagerTag,
  projectService: Project,
  workspaceService: Workspace,
  taskService: Task,
  providerService: Provider,
  muxGatewayOauthService: MuxGatewayOauth,
  muxGovernorOauthService: MuxGovernorOauth,
  codexOauthService: CodexOauth,
  coderOauthService: CoderOauth,
  copilotOauthService: CopilotOauth,
  backupService: Backup,
  terminalService: Terminal,
  editorService: Editor,
  windowService: WindowTag,
  updateService: Update,
  tokenizerService: Tokenizer,
  serverService: Server,
  menuEventService: MenuEvent,
  voiceService: Voice,
  mcpConfigService: MCPConfig,
  mcpOauthService: McpOauth,
  workspaceMcpOverridesService: WorkspaceMcpOverrides,
  mcpServerManager: MCPServerManagerTag,
  agentPluginInstallService: AgentPluginInstall,
  sessionTimingService: SessionTiming,
  timelineService: Timeline,
  telemetryService: Telemetry,
  experimentsService: Experiments,
  memoryService: Memory,
  memoryMetaService: MemoryMeta,
  memoryConsolidationService: MemoryConsolidation,
  refineService: Refine,
  sessionUsageService: SessionUsage,
  instructionsService: Instructions,
  workspaceGoalService: WorkspaceGoal,
  devToolsService: DevTools,
  browserSessionDiscoveryService: AgentBrowserSessionDiscovery,
  browserBridgeTokenManager: BrowserBridgeTokenManagerTag,
  browserBridgeServer: BrowserBridgeServerTag,
  browserControlService: BrowserControl,
  browserSessionStateHub: BrowserSessionStateHubTag,
  policyService: Policy,
  coderService: Coder,
  serverAuthService: ServerAuth,
  sshPromptService: SshPrompt,
  analyticsService: Analytics,
  desktopSessionManager: DesktopSessionManagerTag,
  desktopTokenManager: DesktopTokenManagerTag,
  desktopBridgeServer: DesktopBridgeServerTag,
  workflowRuntimeFactory: QuickJSRuntimeFactoryTag,
};

describe("ServiceContainer", () => {
  let tempDir: string;
  let config: Config;
  let stores: ConfigStores;
  let services: ServiceContainer | undefined;

  beforeEach(() => {
    tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "mux-service-container-test-"));
    stores = createConfigStores(tempDir);
    config = stores.config;
  });

  afterEach(async () => {
    if (services) {
      await services.dispose();
      await services.shutdown();
      services = undefined;
    }
    fs.rmSync(tempDir, { recursive: true, force: true });
  });

  async function createRestartMonitor() {
    services = new ServiceContainer(stores);
    const internal = services.workspaceService as unknown as {
      bashMonitorRecoveryPromise: Promise<void>;
      bashMonitorRegistryStore: BashMonitorRegistryStore;
      bashMonitorWakeReconciler: BashMonitorWakeReconciler;
      dispatchBashMonitorWake(
        dispatch: BashMonitorWakeDispatch
      ): Promise<BashMonitorWakeDispatchOutcome>;
      drainBashMonitorPersistence(workspaceId: string): Promise<void>;
      scheduleBashMonitorWakeReconcile(workspaceId: string): void;
    };
    await internal.bashMonitorRecoveryPromise;
    spyOn(internal, "scheduleBashMonitorWakeReconcile").mockImplementation(() => undefined);
    const armed: MonitorArmedPayload = {
      workspaceId: "restart-owner",
      processId: "restart-monitor",
      taskId: "bash:restart-monitor",
      createdAt: new Date().toISOString(),
      filter: "READY",
      filterExclude: false,
      script: "watch",
    };
    const monitor: BackgroundProcessMonitorState = {
      armMetadata: armed,
      filter: armed.filter,
      pattern: new RegExp(armed.filter),
      exclude: armed.filterExclude,
      cooldownMs: 1000,
      wakeOnExit: true,
      matchesCount: 0,
      pendingLines: [],
      droppedLines: 0,
      totalDroppedLines: 0,
      lastLines: [],
      lastReadOffset: 0,
      matchedThroughOffset: 0,
      retainedMatches: [],
      pollIntervalMs: 1000,
      incompleteLineBuffer: "",
      stopped: false,
      probeFailures: {},
      settled: false,
    };
    const process = {
      id: armed.processId,
      workspaceId: armed.workspaceId,
      script: armed.script,
      startTime: Date.parse(armed.createdAt),
      shownThroughOffset: 0,
      terminalStatusShownToAgent: false,
      status: "running",
      isForeground: false,
      monitor,
      handle: { getExitCode: () => Promise.resolve(null) },
    };
    const manager = services.backgroundProcessManager as unknown as {
      processes: Map<string, typeof process>;
      emitMonitorMatch(proc: typeof process, monitor: BackgroundProcessMonitorState): void;
    };
    manager.processes.set(process.id, process);
    return {
      container: services,
      internal,
      process,
      armed,
      processes: manager.processes,
      flush: () => manager.emitMonitorMatch(process, monitor),
    };
  }

  it("exempts only durably registered, armed background monitor generations from restart", async () => {
    const { container, internal, process, armed, processes } = await createRestartMonitor();
    const registry = internal.bashMonitorRegistryStore;
    const blocked = [{ kind: "background-processes" as const, count: 1 }];
    try {
      await container.refreshRestartBlockers();
      expect(container.collectRestartBlockers()).toEqual(blocked);

      await registry.upsert({ ...armed, createdAt: "older-generation" });
      await container.refreshRestartBlockers();
      expect(container.collectRestartBlockers()).toEqual(blocked);

      container.backgroundProcessManager.emit("monitor:armed", armed.workspaceId, armed);
      await internal.drainBashMonitorPersistence(armed.workspaceId);
      await container.refreshRestartBlockers();
      expect(container.collectRestartBlockers()).toEqual([]);

      process.isForeground = true;
      expect(container.collectRestartBlockers()).toEqual(blocked);
      process.isForeground = false;
      process.monitor.stopped = true;
      expect(container.collectRestartBlockers()).toEqual(blocked);
      process.monitor.stopped = false;
      process.monitor.armMetadata = { ...armed, createdAt: "newer-generation" };
      expect(container.collectRestartBlockers()).toEqual(blocked);
      process.monitor.armMetadata = armed;

      await registry.recordLost(armed.workspaceId, armed.processId, armed.createdAt, {
        reason: "runtime-failure",
        failedAt: new Date().toISOString(),
      });
      await container.refreshRestartBlockers();
      expect(container.collectRestartBlockers()).toEqual(blocked);
      await registry.upsert(armed);
      await registry.recordTerminal(armed.workspaceId, armed.processId, armed.createdAt, {
        status: "exited",
        settledAt: new Date().toISOString(),
        wakeOnExit: true,
        terminalStatusShown: false,
      });
      await container.refreshRestartBlockers();
      expect(container.collectRestartBlockers()).toEqual(blocked);

      await registry.upsert(armed);
      await container.refreshRestartBlockers();
      expect(container.collectRestartBlockers()).toEqual([]);
      await registry.remove(armed.workspaceId, armed.processId, armed.createdAt);
      await container.refreshRestartBlockers();
      expect(container.collectRestartBlockers()).toEqual(blocked);
    } finally {
      processes.clear();
    }
  });

  it("blocks restart for unflushed monitor matches until already-shown output is flushed", async () => {
    const { container, internal, process, armed, processes, flush } = await createRestartMonitor();
    try {
      await internal.bashMonitorRegistryStore.upsert(armed);
      await container.refreshRestartBlockers();
      expect(container.collectRestartBlockers()).toEqual([]);

      process.monitor.pendingLines.push("READY");
      process.monitor.matchesCount = 1;
      process.monitor.matchedThroughOffset = 6;
      expect(container.collectRestartBlockers()).toEqual([
        { kind: "background-processes", count: 1 },
      ]);

      process.shownThroughOffset = 6;
      flush();
      expect(container.collectRestartBlockers()).toEqual([]);
    } finally {
      processes.clear();
    }
  });

  it.each(["deferred", "in-flight"] as const)(
    "blocks restart for a %s monitor wake until acceptance",
    async (outcome) => {
      const { container, internal, process, armed, processes, flush } =
        await createRestartMonitor();
      const dispatches: BashMonitorWakeDispatch[] = [];
      const dispatch = spyOn(internal, "dispatchBashMonitorWake").mockImplementation((wake) => {
        dispatches.push(wake);
        return Promise.resolve(outcome);
      });
      try {
        await internal.bashMonitorRegistryStore.upsert(armed);
        await container.refreshRestartBlockers();
        expect(container.collectRestartBlockers()).toEqual([]);

        process.monitor.pendingLines.push("READY");
        process.monitor.matchesCount = 1;
        process.monitor.matchedThroughOffset = 6;
        flush();
        expect(process.monitor.pendingLines).toEqual([]);
        const blocked = [{ kind: "background-processes" as const, count: 1 }];
        expect(container.collectRestartBlockers()).toEqual(blocked);

        await internal.bashMonitorWakeReconciler.reconcile(armed.workspaceId);
        expect(dispatches).toHaveLength(1);
        expect(container.collectRestartBlockers()).toEqual(blocked);
        await container.refreshRestartBlockers();
        expect(container.collectRestartBlockers()).toEqual(blocked);

        await dispatches[0].onAccepted();
        await internal.bashMonitorWakeReconciler.reconcile(armed.workspaceId);
        expect(container.collectRestartBlockers()).toEqual([]);
        expect(dispatches).toHaveLength(1);
      } finally {
        dispatch.mockRestore();
        processes.clear();
      }
    }
  );

  it("keeps failed and stalled monitor arm writes blocking without waiting for them", async () => {
    const { container, internal, armed, processes } = await createRestartMonitor();
    const registry = internal.bashMonitorRegistryStore;
    const upsert = spyOn(registry, "upsert");
    let releaseWrite: (() => void) | undefined;
    try {
      upsert.mockRejectedValueOnce(new Error("registry write failed"));
      container.backgroundProcessManager.emit("monitor:armed", armed.workspaceId, armed);
      await internal.drainBashMonitorPersistence(armed.workspaceId);
      await container.refreshRestartBlockers();
      expect(container.collectRestartBlockers()).toEqual([
        { kind: "background-processes", count: 1 },
      ]);

      const writeGate = new Promise<void>((resolve) => {
        releaseWrite = resolve;
      });
      upsert.mockImplementationOnce(() => writeGate);
      container.backgroundProcessManager.emit("monitor:armed", armed.workspaceId, armed);
      await container.refreshRestartBlockers();
      expect(container.collectRestartBlockers()).toEqual([
        { kind: "background-processes", count: 1 },
      ]);
    } finally {
      releaseWrite?.();
      await internal.drainBashMonitorPersistence(armed.workspaceId);
      upsert.mockRestore();
      processes.clear();
    }
  });

  it("fails closed on failed or stalled registry reads without applying late exemptions", async () => {
    const { container, internal, armed, processes } = await createRestartMonitor();
    const registry = internal.bashMonitorRegistryStore;
    const listAll = spyOn(registry, "listAll");
    let releaseRead: (() => void) | undefined;
    try {
      await registry.upsert(armed);
      await container.refreshRestartBlockers();
      expect(container.collectRestartBlockers()).toEqual([]);
      const records = await registry.listAll(armed.workspaceId);
      listAll.mockRejectedValueOnce(new Error("registry read failed"));
      await container.refreshRestartBlockers();
      expect(container.collectRestartBlockers()).toEqual([
        { kind: "background-processes", count: 1 },
      ]);

      const readGate = new Promise<void>((resolve) => {
        releaseRead = resolve;
      });
      listAll.mockImplementationOnce(async () => {
        await readGate;
        return records;
      });
      await container.refreshRestartBlockers();
      expect(container.collectRestartBlockers()).toEqual([
        { kind: "background-processes", count: 1 },
      ]);
      releaseRead?.();
      await readGate;
      expect(container.collectRestartBlockers()).toEqual([
        { kind: "background-processes", count: 1 },
      ]);
    } finally {
      releaseRead?.();
      listAll.mockRestore();
      processes.clear();
    }
  });

  it("collects restart blockers from live sessions, including pre-stream work", () => {
    services = new ServiceContainer(stores);
    expect(services.collectRestartBlockers()).toEqual([]);
    const session = services.workspaceService.getOrCreateSession("restart-test");
    const { coordinator } = session as unknown as { coordinator: TurnCoordinator };
    const admission = coordinator.prepare({
      kind: "fresh",
      intent: "handoff",
      expectedTurnId: coordinator.turnId,
    });
    if (admission.status !== "admitted") throw new Error("Expected turn admission");
    const turn = admission.turnId;
    expect(services.collectRestartBlockers()).toContainEqual({ kind: "pending-turns", count: 1 });
    coordinator.finishPreparation(turn);
    session.queueMessage("queued for later");
    expect(services.collectRestartBlockers()).toEqual([{ kind: "queued-messages", count: 1 }]);
    session.clearQueue();
    const retry = coordinator.beginRetry();
    expect(services.collectRestartBlockers()).toEqual([{ kind: "auto-retries", count: 1 }]);
    coordinator.finishRetry(retry);
    expect(services.collectRestartBlockers()).toEqual([]);
  });

  it("counts server-wide streams, terminal starts, and foreground or background processes", () => {
    services = new ServiceContainer(stores);
    const streams = services.streamManager as unknown as { workspaceStreams: Map<string, unknown> };
    const terminals = services.terminalService as unknown as {
      pendingSessionCreations: Map<string, number>;
    };
    const processes = services.backgroundProcessManager as unknown as {
      processes: Map<string, { status: string; isForeground: boolean }>;
    };
    const desktop = services.desktopSessionManager as unknown as {
      sessions: Map<string, unknown>;
      startupPromises: Map<string, Promise<unknown>>;
    };
    const project = services.projectService as unknown as { activeGitInits: Set<string> };
    let releaseWorkflow: (() => void) | undefined;
    const workspace = services.workspaceService as unknown as {
      preflightSendCounts: Map<string, number>;
      preflightExecCounts: Map<string, number>;
      initSettlementPromises: Map<string, Promise<void>>;
      initAbortControllers: Map<string, AbortController>;
      removingWorkspaces: Set<string>;
      archivingWorkspaces: Set<string>;
      renamingWorkspaces: Set<string>;
    };
    try {
      streams.workspaceStreams.set("streaming", {});
      workspace.initSettlementPromises.set("initializing", new Promise<void>(() => undefined));
      workspace.initAbortControllers.set("initializing", new AbortController());
      workspace.initAbortControllers.set("provisioning", new AbortController());
      // Controller and settlement already released; the final status write has not landed.
      services.initStateManager.startInit("finishing", "/tmp/finishing/.xum/init");
      workspace.removingWorkspaces.add("removing");
      workspace.archivingWorkspaces.add("archiving");
      workspace.archivingWorkspaces.add("removing");
      workspace.renamingWorkspaces.add("renaming");
      releaseWorkflow = registerInProcessWorkflowRun("workflow-workspace");
      desktop.sessions.set("desktop-live", { isAlive: () => true });
      desktop.sessions.set("desktop-exited", { isAlive: () => false });
      desktop.startupPromises.set("desktop-starting", new Promise(() => undefined));
      project.activeGitInits.add("/tmp/new-project");
      terminals.pendingSessionCreations.set("terminal-starting", 2);
      processes.processes.set("running", { status: "running", isForeground: false });
      processes.processes.set("foreground", { status: "running", isForeground: true });
      processes.processes.set("finished", { status: "exited", isForeground: false });
      workspace.preflightSendCounts.set("preflight", 1);
      workspace.preflightExecCounts.set("executing", 1);
      expect(services.collectRestartBlockers()).toEqual([
        { kind: "pending-turns", count: 1 },
        { kind: "workspace-inits", count: 3 },
        { kind: "workspace-lifecycle", count: 3 },
        { kind: "background-processes", count: 3 },
        { kind: "active-streams", count: 1 },
        { kind: "workflows", count: 1 },
        { kind: "projects", count: 1 },
        { kind: "terminals", count: 2 },
        { kind: "desktop-sessions", count: 2 },
      ]);
    } finally {
      streams.workspaceStreams.clear();
      terminals.pendingSessionCreations.clear();
      processes.processes.clear();
      workspace.preflightSendCounts.clear();
      workspace.preflightExecCounts.clear();
      workspace.initSettlementPromises.clear();
      workspace.initAbortControllers.clear();
      services.initStateManager.clearInMemoryState("finishing");
      workspace.removingWorkspaces.clear();
      workspace.archivingWorkspaces.clear();
      workspace.renamingWorkspaces.clear();
      releaseWorkflow?.();
      desktop.sessions.clear();
      desktop.startupPromises.clear();
      project.activeGitInits.clear();
    }
    expect(services.collectRestartBlockers()).toEqual([]);
  });

  it("refuses new sessions, commands, and terminals synchronously during disposal", async () => {
    services = new ServiceContainer(stores);
    expect(services.serverService.isShuttingDown()).toBe(false);
    const disposal = services.dispose();
    expect(services.serverService.isShuttingDown()).toBe(true);
    expect(() => services!.workspaceService.getOrCreateSession("cold-workspace")).toThrow(
      "shutting down"
    );
    expect(await services.workspaceService.executeBash("cold-workspace", "echo not-run")).toEqual({
      success: false,
      error: "Server is shutting down",
    });
    let terminalError: unknown;
    try {
      await services.terminalService.create({ workspaceId: "cold-workspace", cols: 80, rows: 24 });
    } catch (error) {
      terminalError = error;
    }
    expect(terminalError).toBeInstanceOf(Error);
    expect(String(terminalError)).toContain("shutting down");
    await disposal;
  });

  it("attributes multi-project stream-end analytics to the primary project path", async () => {
    const primaryProjectPath = "/fake/project-a";
    const secondaryProjectPath = "/fake/project-b";
    const workspaceId = "workspace-1";
    const workspaceName = "feature-branch";
    const workspacePath = path.join(config.srcDir, "project-a+project-b", workspaceName);

    await config.editConfig((cfg) => {
      cfg.projects.set(MULTI_PROJECT_CONFIG_KEY, {
        workspaces: [
          {
            path: workspacePath,
            id: workspaceId,
            name: workspaceName,
            parentWorkspaceId: "parent-workspace",
            projects: [
              { projectName: "project-a", projectPath: primaryProjectPath },
              { projectName: "project-b", projectPath: secondaryProjectPath },
            ],
            runtimeConfig: { type: "local" },
          },
        ],
      });
      return cfg;
    });

    services = new ServiceContainer(stores);
    const ingestWorkspaceSpy = spyOn(
      services.analyticsService,
      "ingestWorkspace"
    ).mockImplementation(() => undefined);

    services.aiService.emit("stream-end", {
      type: "stream-end",
      workspaceId,
      messageId: "message-1",
      metadata: { model: "openai:gpt-4o" },
      parts: [],
    });

    expect(ingestWorkspaceSpy).toHaveBeenCalledWith(
      workspaceId,
      path.join(config.sessionsDir, workspaceId),
      {
        projectPath: primaryProjectPath,
        projectName: path.basename(primaryProjectPath),
        workspaceName,
        parentWorkspaceId: "parent-workspace",
      }
    );
  });

  it("initializeCore completes task recovery and leaves housekeeping to runStartupHousekeeping", async () => {
    services = new ServiceContainer(stores);
    const callOrder: string[] = [];
    let releaseTaskRecovery: (() => void) | undefined;
    let taskRecoveryCalled: (() => void) | undefined;
    const taskRecoveryCalledPromise = new Promise<void>((resolve) => {
      taskRecoveryCalled = resolve;
    });
    const recoverTasksSpy = spyOn(
      services.taskService,
      "recoverInterruptedTasks"
    ).mockImplementation(() => {
      callOrder.push("recoverTasks");
      taskRecoveryCalled?.();
      return new Promise<void>((resolve) => {
        releaseTaskRecovery = resolve;
      });
    });
    const workspaceInitializeSpy = spyOn(
      services.workspaceService,
      "initialize"
    ).mockImplementation(() => {
      callOrder.push("workspace");
      return Promise.resolve();
    });
    const taskHousekeepingSpy = spyOn(
      services.taskService,
      "runStartupHousekeeping"
    ).mockImplementation(() => {
      callOrder.push("taskHousekeeping");
      return Promise.resolve();
    });

    let coreSettled = false;
    const core = services.initializeCore().then(() => {
      coreSettled = true;
    });
    await taskRecoveryCalledPromise;
    // The listener must wait for task recovery (clients may otherwise race its transitions)...
    expect(recoverTasksSpy).toHaveBeenCalledTimes(1);
    expect(coreSettled).toBe(false);
    releaseTaskRecovery?.();
    await core;
    // ...but not for the O(workspaces) housekeeping, which runs only when the caller asks for it.
    expect(workspaceInitializeSpy).not.toHaveBeenCalled();
    expect(taskHousekeepingSpy).not.toHaveBeenCalled();

    await services.runStartupHousekeeping();
    expect(callOrder).toEqual(["recoverTasks", "workspace", "taskHousekeeping"]);
    expect(workspaceInitializeSpy.mock.calls[0]?.[0]?.signal).toBeInstanceOf(AbortSignal);
    expect(taskHousekeepingSpy.mock.calls[0]?.[0]?.signal).toBeInstanceOf(AbortSignal);
  });

  it("dispose cancels in-flight startup housekeeping before the periodic services start", async () => {
    services = new ServiceContainer(stores);
    spyOn(services.taskService, "recoverInterruptedTasks").mockImplementation(() =>
      Promise.resolve()
    );
    spyOn(services.workspaceService, "initialize").mockImplementation(() => Promise.resolve());
    let releaseTaskHousekeeping: (() => void) | undefined;
    let housekeepingSignal: AbortSignal | undefined;
    let taskHousekeepingCalled: (() => void) | undefined;
    const taskHousekeepingCalledPromise = new Promise<void>((resolve) => {
      taskHousekeepingCalled = resolve;
    });
    spyOn(services.taskService, "runStartupHousekeeping").mockImplementation((options) => {
      housekeepingSignal = options?.signal;
      taskHousekeepingCalled?.();
      return new Promise<void>((release) => {
        releaseTaskHousekeeping = release;
      });
    });
    const heartbeatStart = spyOn(services.heartbeatService, "start");
    const idleCompactionStart = spyOn(services.idleCompactionService, "start");
    const beginShutdown = spyOn(
      (services as unknown as { backgroundProcessManager: { beginShutdown: () => void } })
        .backgroundProcessManager,
      "beginShutdown"
    );
    const disposeRecoverySessions = spyOn(services.workspaceService, "beginShutdown");

    await services.initializeCore();
    const housekeeping = services.runStartupHousekeeping();
    await taskHousekeepingCalledPromise;
    // Task housekeeping is mid-flight when the process shuts down.
    const disposed = services.dispose();
    expect(housekeepingSignal?.aborted).toBe(true);
    // Both latches are set synchronously, ahead of the join: no session disposed during shutdown
    // can erase registry records, and no recovery chain still running under the join can start a
    // stream. Only then does teardown wait for the in-flight housekeeping step to settle.
    expect(beginShutdown).toHaveBeenCalledTimes(1);
    expect(disposeRecoverySessions).toHaveBeenCalledTimes(1);
    releaseTaskHousekeeping?.();
    await housekeeping;
    await disposed;

    expect(beginShutdown).toHaveBeenCalledTimes(1);
    expect(heartbeatStart).not.toHaveBeenCalled();
    expect(idleCompactionStart).not.toHaveBeenCalled();
  });

  it("runStartupHousekeeping starts the periodic services even when task housekeeping rejects", async () => {
    services = new ServiceContainer(stores);
    spyOn(services.taskService, "recoverInterruptedTasks").mockImplementation(() =>
      Promise.resolve()
    );
    spyOn(services.workspaceService, "initialize").mockImplementation(() => Promise.resolve());
    spyOn(services.taskService, "runStartupHousekeeping").mockImplementation(() =>
      Promise.reject(new Error("terminal-attention store unreadable"))
    );
    const idleCompactionStart = spyOn(services.idleCompactionService, "start");
    const heartbeatStart = spyOn(services.heartbeatService, "start");
    const agentStatusStart = spyOn(services.agentStatusService, "start");

    await services.initializeCore();
    await services.runStartupHousekeeping();

    expect(idleCompactionStart).toHaveBeenCalledTimes(1);
    expect(heartbeatStart).toHaveBeenCalledTimes(1);
    expect(agentStatusStart).toHaveBeenCalledTimes(1);
  });

  const CORE_STEP_NAMES = [
    "extensionMetadata.initialize",
    "telemetryService.initialize",
    "policyService.initialize",
    "experimentsService.initialize",
    "taskService.recoverInterruptedTasks",
  ];

  /** The container's private startup bookkeeping, read for assertions only. */
  function startupInternals(container: ServiceContainer) {
    return container as unknown as {
      extensionMetadata: { initialize: () => Promise<void> };
      startupStepDurationsMs: Record<string, number>;
    };
  }

  /** The rejection reason of `promise` as-is (identity assertions), or a marker if it resolved. */
  function rejectionOf(promise: Promise<unknown>): Promise<unknown> {
    return promise.then(
      () => "<resolved>",
      (reason: unknown) => reason
    );
  }

  it("initializeCore times out a hung step on the runtime clock and skips the later steps", async () => {
    // TestClock beneath the real graph: the per-step bound must sleep on the runtime's clock
    // (the effect runs through the ManagedRuntime, not a global Effect.runPromise).
    const realAppLive = appLayers.AppLive;
    const appLiveSpy = spyOn(appLayers, "AppLive").mockImplementation((appStores) =>
      realAppLive(appStores).pipe(Layer.provideMerge(TestClock.layer()))
    );
    try {
      services = new ServiceContainer(stores);
    } finally {
      appLiveSpy.mockRestore();
    }
    const runtime = services.runtime.managed;
    spyOn(startupInternals(services).extensionMetadata, "initialize").mockResolvedValue(undefined);
    spyOn(services.telemetryService, "initialize").mockResolvedValue(undefined);
    let policyCalled: (() => void) | undefined;
    const policyCalledPromise = new Promise<void>((resolve) => {
      policyCalled = resolve;
    });
    let rejectAbandonedStep: ((error: unknown) => void) | undefined;
    spyOn(services.policyService, "initialize").mockImplementation(() => {
      policyCalled?.();
      return new Promise<void>((_resolve, reject) => {
        rejectAbandonedStep = reject;
      });
    });
    const experimentsInitialize = spyOn(services.experimentsService, "initialize");
    const recoverTasks = spyOn(services.taskService, "recoverInterruptedTasks");

    let outcome: { settled: boolean; error?: unknown } = { settled: false };
    const core = services.initializeCore().then(
      () => {
        outcome = { settled: true };
      },
      (error: unknown) => {
        outcome = { settled: true, error };
      }
    );
    await policyCalledPromise;

    // One millisecond short of the budget the wait is still pending...
    await runtime.runPromise(TestClock.adjust(Duration.millis(STARTUP_STEP_TIMEOUT_MS - 1)));
    await new Promise<void>((resolve) => setTimeout(resolve, 0));
    expect(outcome.settled).toBe(false);
    // ...and exactly at the budget the step is abandoned.
    await runtime.runPromise(TestClock.adjust(Duration.millis(1)));
    await core;
    expect(outcome.error).toBeInstanceOf(StartupStepTimeoutError);
    const timeoutError = outcome.error as StartupStepTimeoutError;
    expect(timeoutError.step).toBe("policyService.initialize");
    expect(timeoutError.timeoutMs).toBe(STARTUP_STEP_TIMEOUT_MS);
    // The roots' default Error formatting (dialog / log line) names the class and the step.
    expect(String(timeoutError)).toMatch(/^StartupStepTimeoutError: policyService\.initialize /);
    expect(experimentsInitialize).not.toHaveBeenCalled();
    expect(recoverTasks).not.toHaveBeenCalled();
    const durations = startupInternals(services).startupStepDurationsMs;
    expect(Object.keys(durations)).toEqual(CORE_STEP_NAMES.slice(0, 3));
    const durationsAtTimeout = { ...durations };

    // The abandoned step keeps running as a plain promise: its late rejection is neither
    // unhandled nor a late side effect on the container.
    const unhandled: unknown[] = [];
    const onUnhandledRejection = (reason: unknown) => {
      unhandled.push(reason);
    };
    process.on("unhandledRejection", onUnhandledRejection);
    try {
      rejectAbandonedStep?.(new Error("late policy failure"));
      await new Promise<void>((resolve) => setTimeout(resolve, 0));
      await new Promise<void>((resolve) => setTimeout(resolve, 0));
    } finally {
      process.off("unhandledRejection", onUnhandledRejection);
    }
    expect(unhandled).toEqual([]);
    expect(durations).toEqual(durationsAtTimeout);
    expect(experimentsInitialize).not.toHaveBeenCalled();
    expect(recoverTasks).not.toHaveBeenCalled();
  });

  it("initializeCore rejects with the failing step's own error and skips the later steps", async () => {
    services = new ServiceContainer(stores);
    const boom = new Error("policy endpoint unreachable");
    spyOn(services.policyService, "initialize").mockImplementation(() => Promise.reject(boom));
    const experimentsInitialize = spyOn(services.experimentsService, "initialize");
    const recoverTasks = spyOn(services.taskService, "recoverInterruptedTasks");

    // Identity, not a wrapped copy: roots log/print the object they receive.
    expect(await rejectionOf(services.initializeCore())).toBe(boom);
    expect(experimentsInitialize).not.toHaveBeenCalled();
    expect(recoverTasks).not.toHaveBeenCalled();
  });

  it("initializeCore rejects with a synchronously thrown step error", async () => {
    services = new ServiceContainer(stores);
    const boom = new Error("policy store corrupt");
    spyOn(services.policyService, "initialize").mockImplementation(() => {
      throw boom;
    });
    const recoverTasks = spyOn(services.taskService, "recoverInterruptedTasks");

    expect(await rejectionOf(services.initializeCore())).toBe(boom);
    expect(recoverTasks).not.toHaveBeenCalled();
  });

  it("initializeCore records the five core steps and re-runs them when called again", async () => {
    services = new ServiceContainer(stores);
    const recoverTasks = spyOn(services.taskService, "recoverInterruptedTasks").mockResolvedValue(
      undefined
    );

    await services.initializeCore();
    expect(Object.keys(startupInternals(services).startupStepDurationsMs)).toEqual(CORE_STEP_NAMES);
    // Not re-entrancy guarded (parity with the plain promise chain it replaced).
    await services.initializeCore();
    expect(recoverTasks).toHaveBeenCalledTimes(2);
  });

  it("initializeCore after dispose() fails fast without running a step", async () => {
    services = new ServiceContainer(stores);
    const recoverTasks = spyOn(services.taskService, "recoverInterruptedTasks");
    await services.dispose();

    // A disposed ManagedRuntime would otherwise reject with a bare "ManagedRuntime disposed"
    // defect string from inside the first step.
    const rejection = await rejectionOf(services.initializeCore());
    expect(rejection).toBeInstanceOf(Error);
    expect((rejection as Error).message).toContain("after dispose()");
    expect(recoverTasks).not.toHaveBeenCalled();
  });

  it("exposes desktopSessionManager in the ORPC context", () => {
    services = new ServiceContainer(stores);

    const context = services.toORPCContext();

    expect(context.desktopSessionManager).toBe(services.desktopSessionManager);
  });

  it("closes desktop sessions during shutdown", async () => {
    services = new ServiceContainer(stores);
    const closeAllSpy = spyOn(services.desktopSessionManager, "closeAll").mockImplementation(() =>
      Promise.resolve(undefined)
    );

    await services.shutdown();

    expect(closeAllSpy).toHaveBeenCalledTimes(1);
  });

  it("closes desktop sessions during dispose", async () => {
    services = new ServiceContainer(stores);
    const closeAllSpy = spyOn(services.desktopSessionManager, "closeAll").mockImplementation(() =>
      Promise.resolve(undefined)
    );

    await services.dispose();

    expect(closeAllSpy).toHaveBeenCalledTimes(1);
  });

  it("serves the layer-built MemoryMetaService through both the field and the Effect context", () => {
    services = new ServiceContainer(stores);

    const effectContext = services.toORPCContext()["effect/context"];

    // One instance: constructor-wired consumers (memoryService, refineService)
    // and Effect-native oRPC handlers (`yield* MemoryMeta`) must share state.
    expect(Context.get(effectContext, MemoryMeta)).toBe(services.memoryMetaService);
    expect(services.runtime.get(MemoryMeta)).toBe(services.memoryMetaService);
  });

  it("closes the Effect runtime as the last dispose step", async () => {
    services = new ServiceContainer(stores);
    const container = services;
    let runtimeAliveAtLastExplicitStep: boolean | undefined;
    // timelineService.flush() is the final explicit teardown step; the runtime
    // must still be alive when it runs and gone once dispose() resolves.
    const flushSpy = spyOn(services.timelineService, "flush").mockImplementation(() => {
      runtimeAliveAtLastExplicitStep = container.runtime.managed.cachedContext !== undefined;
      return Promise.resolve(undefined);
    });

    await services.dispose();

    expect(flushSpy).toHaveBeenCalledTimes(1);
    expect(runtimeAliveAtLastExplicitStep).toBe(true);
    // ManagedRuntime clears its cached context when its scope closes.
    expect(services.runtime.managed.cachedContext).toBeUndefined();
    // The afterEach dispose()+shutdown() pair then exercises the latched path.
  });

  it("exposes the runtime seams through the field and the Effect context", () => {
    services = new ServiceContainer(stores);

    const effectContext = services.toORPCContext()["effect/context"];

    expect(Context.get(effectContext, AppFiberScopeTag)).toBe(services.appFiberScope);
    expect(services.appFiberScope.state._tag).not.toBe("Closed");
    expect(Context.get(effectContext, EffectRunnerTag)).toBe(services.runtime.get(EffectRunnerTag));
  });

  it("closes the AppFiberScope (interrupt + await) before the explicit teardown steps", async () => {
    services = new ServiceContainer(stores);
    const steps: string[] = [];
    // An I/O-suspended occupant: never resolves on its own, records its cancel
    // path and finalizer. Supervised fibers must be gone before any explicit
    // teardown step so they can still use their dependencies while finalizing.
    services.runtime.managed.runSync(
      Effect.forkIn(
        Effect.callback<void>(() =>
          Effect.sync(() => {
            steps.push("occupant-cancelled");
          })
        ).pipe(Effect.ensuring(Effect.sync(() => steps.push("occupant-finalized")))),
        services.appFiberScope
      )
    );
    // Bridge teardown must still follow supervised-fiber finalization and viewer cleanup.
    const bridgeStopSpy = spyOn(services.desktopBridgeServer, "stop").mockImplementation(() => {
      steps.push("bridge-stop");
      return Promise.resolve(undefined);
    });

    await services.dispose();

    expect(bridgeStopSpy).toHaveBeenCalledTimes(1);
    expect(steps).toEqual(["occupant-cancelled", "occupant-finalized", "bridge-stop"]);
    expect(services.appFiberScope.state._tag).toBe("Closed");
  });

  it.each([false, true])(
    "dispose() joins engine and session policy before bridge teardown (session=%s)",
    async (throughSession) => {
      // The AppFiberScope occupant end to end: a real stream on the container's
      // StreamManager (wired with the runtime's scope), its provider stubbed to
      // flow one delta and then block until the stream's AbortSignal fires.
      // dispose() must abort it as "system", let AIService commit the partial
      // into chat.jsonl and delete partial.json, and only then stop the bridge.
      services = new ServiceContainer(stores);
      const workspaceId = "dispose-in-flight-stream-workspace";
      const messageId = "dispose-in-flight-stream-message";
      const steps: string[] = [];
      Reflect.set(services.streamManager, "tokenTracker", {
        setModel: () => Promise.resolve(undefined),
        countTokens: () => Promise.resolve(0),
      });
      Reflect.set(
        services.streamManager,
        "createStreamResult",
        (_request: unknown, abortController: AbortController) => ({
          fullStream: (async function* () {
            yield { type: "text-delta", text: "hello from a stream shutdown must not lose" };
            await new Promise<void>((resolve) => {
              if (abortController.signal.aborted) return resolve();
              abortController.signal.addEventListener("abort", () => resolve(), { once: true });
            });
          })(),
          totalUsage: Promise.resolve(undefined),
          usage: Promise.resolve(undefined),
          providerMetadata: Promise.resolve(undefined),
          steps: Promise.resolve([]),
        })
      );
      Reflect.set(services.streamManager, "createTempDirForStream", () =>
        Promise.resolve(path.join(tempDir, "stream-tempdir"))
      );
      Reflect.set(services.streamManager, "cleanupStreamTempDir", () => undefined);
      services.aiService.on("stream-abort", (event: { abortReason?: string }) => {
        steps.push(`stream-abort:${event.abortReason ?? "none"}`);
      });
      const bridgeStopSpy = spyOn(services.desktopBridgeServer, "stop").mockImplementation(() => {
        steps.push("bridge-stop");
        return Promise.resolve(undefined);
      });

      const historyService = services.runtime.get(History);
      const partialWritten = Promise.withResolvers<void>();
      const writePartial = historyService.writePartial.bind(historyService);
      spyOn(historyService, "writePartial").mockImplementation(async (...args) => {
        const result = await writePartial(...args);
        partialWritten.resolve();
        return result;
      });
      const startEngine = async () => {
        const appendResult = await historyService.appendToHistory(workspaceId, {
          id: messageId,
          role: "assistant",
          metadata: { historySequence: 1, partial: true },
          parts: [],
        });
        expect(appendResult.success).toBe(true);
        return services!.streamManager.startStream({
          workspaceId,
          messageId,
          model: {
            specificationVersion: "v3",
            provider: "test",
            modelId: "dispose-model",
            supportedUrls: {},
            doGenerate: () => Promise.reject(new Error("unused")),
            doStream: () => Promise.reject(new Error("unused")),
          },
          messages: [{ role: "user", content: "hello" }],
          modelString: "openai:gpt-4.1-mini",
          historySequence: 1,
          system: "system",
          runtime: createRuntime({ type: "local", srcBaseDir: tempDir }),
          providedRuntimeTempDir: "",
        });
      };
      const policyEntered = Promise.withResolvers<void>();
      const releasePolicy = Promise.withResolvers<void>();
      const handleDelivered = Promise.withResolvers<Awaited<ReturnType<typeof startEngine>>>();
      let session: AgentSession | undefined;
      if (throughSession) {
        const emitter = new EventEmitter();
        for (const event of ["stream-start", "stream-abort", "stream-end", "stream-error"]) {
          services.aiService.on(event, (payload: unknown) => emitter.emit(event, payload));
        }
        const h = await createAgentSessionHarness({
          workspaceId,
          historyService,
          aiEmitter: emitter,
          streamManager: services.streamManager,
          effectRunner: services.runtime.get(EffectRunnerTag),
          appFiberScope: services.appFiberScope,
          aiServiceOverrides: {
            streamMessage: async () => {
              const result = await startEngine();
              handleDelivered.resolve(result);
              return result;
            },
          },
        });
        session = h.session;
        services.workspaceService.registerSession(workspaceId, session);
        // Hold only session policy. The actual engine still aborts, retires partial.json,
        // and delivers its independent completion while the app guardian is closing.
        const policy = session as unknown as {
          recordGoalAccountingFromUsage(input: unknown): Promise<void>;
        };
        const record = policy.recordGoalAccountingFromUsage.bind(session);
        spyOn(policy, "recordGoalAccountingFromUsage").mockImplementation(async (input) => {
          policyEntered.resolve();
          await releasePolicy.promise;
          await record(input);
        });
        session.onChatEvent(({ message }) => {
          if (message.type === "stream-abort") steps.push("renderer-abort");
        });
        expect(
          (await session.sendMessage("hello", { model: "openai:gpt-4.1-mini", agentId: "exec" }))
            .success
        ).toBe(true);
      } else {
        handleDelivered.resolve(await startEngine());
      }
      const started = await handleDelivered.promise;
      expect(started.success).toBe(true);
      if (!started.success) throw new Error("expected the stream to start");
      // Signal after real disk persistence, so shutdown starts with a partial worth committing.
      await partialWritten.promise;
      expect(services.streamManager.isStreaming(workspaceId)).toBe(true);

      const disposing = services.dispose();
      try {
        if (throughSession) {
          await policyEntered.promise;
          expect(await started.data.completion).toMatchObject({
            status: "aborted",
            abortReason: "system",
          });
          expect(bridgeStopSpy).not.toHaveBeenCalled();
          expect(await historyService.readPartial(workspaceId)).toBeNull();
        }
      } finally {
        releasePolicy.resolve();
        await disposing;
      }

      expect(bridgeStopSpy).toHaveBeenCalledTimes(1);
      expect(steps).toEqual(
        throughSession
          ? ["stream-abort:system", "renderer-abort", "bridge-stop"]
          : ["stream-abort:system", "bridge-stop"]
      );
      expect(await started.data.completion).toMatchObject({
        status: "aborted",
        abortReason: "system",
      });
      expect(services.streamManager.isStreaming(workspaceId)).toBe(false);
      // Durable outcome at the moment the bridge stopped: partial.json gone, the
      // interrupted assistant message (still flagged partial, as every
      // interrupted turn is) committed to chat.jsonl with its streamed text —
      // instead of an empty placeholder row plus an orphan partial.json that only
      // the next load would reconcile.
      expect(await historyService.readPartial(workspaceId)).toBeNull();
      const history = await historyService.getHistoryFromLatestBoundary(workspaceId);
      expect(history.success).toBe(true);
      if (!history.success) throw new Error(history.error);
      const committed = history.data.find((message) => message.id === messageId);
      expect(
        committed?.parts.some(
          (part) =>
            part.type === "text" && part.text === "hello from a stream shutdown must not lose"
        )
      ).toBe(true);
    }
  );

  it("joins cleanup enqueued by a closing session callback before dependency teardown", async () => {
    services = new ServiceContainer(stores);
    const session = services.workspaceService.getOrCreateSession("late-cleanup-owner");
    const { coordinator } = session as unknown as { coordinator: TurnCoordinator };
    const lease = coordinator.enterExecution();
    const cleanupEntered = Promise.withResolvers<void>();
    const cleanupRelease = Promise.withResolvers<void>();
    const backgroundEntered = Promise.withResolvers<void>();
    const backgroundRelease = Promise.withResolvers<void>();
    spyOn(services.backgroundProcessManager, "cleanup").mockImplementationOnce(async () => {
      backgroundEntered.resolve();
      await backgroundRelease.promise;
    });
    const bridge = spyOn(services.desktopBridgeServer, "stop").mockResolvedValue(undefined);
    const disposed = services.dispose();
    try {
      // The still-leased producer registers cleanup after the shutdown snapshot.
      services.workspaceService.deferWorkspaceCleanup(async () => {
        cleanupEntered.resolve();
        await cleanupRelease.promise;
      });
      lease[Symbol.dispose]();
      await Promise.all([cleanupEntered.promise, backgroundEntered.promise]);
      expect(bridge).not.toHaveBeenCalled();
      backgroundRelease.resolve();
      await session.dispose();
      expect(bridge).not.toHaveBeenCalled();
      cleanupRelease.resolve();
      await disposed;
      expect(bridge).toHaveBeenCalledTimes(1);
    } finally {
      lease[Symbol.dispose]();
      backgroundRelease.resolve();
      cleanupRelease.resolve();
      await disposed;
    }
  });

  it.each(["stop", "drain"] as const)(
    "a rejected session %s cannot skip held background or deferred cleanup",
    async (failure) => {
      services = new ServiceContainer(stores);
      const session = services.workspaceService.getOrCreateSession(`shutdown-${failure}-failure`);
      const { coordinator } = session as unknown as { coordinator: TurnCoordinator };
      if (failure === "stop")
        spyOn(services.streamManager, "stopStream").mockRejectedValueOnce(
          new Error("adapter stop failure")
        );
      else spyOn(coordinator, "drain").mockRejectedValueOnce(new Error("scope drain failure"));
      const backgroundEntered = Promise.withResolvers<void>();
      const backgroundRelease = Promise.withResolvers<void>();
      const cleanupRelease = Promise.withResolvers<void>();
      spyOn(services.backgroundProcessManager, "cleanup").mockImplementationOnce(async () => {
        backgroundEntered.resolve();
        await backgroundRelease.promise;
      });
      services.workspaceService.deferWorkspaceCleanup(() => cleanupRelease.promise);
      const bridge = spyOn(services.desktopBridgeServer, "stop").mockResolvedValue(undefined);
      const disposed = services.dispose();
      try {
        await backgroundEntered.promise;
        expect(bridge).not.toHaveBeenCalled();
        backgroundRelease.resolve();
        await session.dispose();
        expect(bridge).not.toHaveBeenCalled();
        cleanupRelease.resolve();
        await disposed;
        expect(bridge).toHaveBeenCalledTimes(1);
      } finally {
        backgroundRelease.resolve();
        cleanupRelease.resolve();
        await disposed;
      }
    }
  );

  it("shares one teardown across concurrent dispose() calls", async () => {
    services = new ServiceContainer(stores);
    const steps: string[] = [];
    // An occupant whose finalization is asynchronous: the first dispose() is
    // still awaiting it when the second dispose() arrives. Without a shared
    // teardown the second call would find the scope already marked closed and
    // proceed to the explicit steps while this finalizer is still running.
    services.runtime.managed.runSync(
      Effect.forkIn(
        Effect.callback<void>(() => Effect.void).pipe(
          Effect.ensuring(
            Effect.promise(() => new Promise<void>((resolve) => setTimeout(resolve, 30))).pipe(
              Effect.andThen(Effect.sync(() => steps.push("occupant-finalized")))
            )
          )
        ),
        services.appFiberScope
      )
    );
    const bridgeStopSpy = spyOn(services.desktopBridgeServer, "stop").mockImplementation(() => {
      steps.push("bridge-stop");
      return Promise.resolve(undefined);
    });

    await Promise.all([services.dispose(), services.dispose()]);

    expect(bridgeStopSpy).toHaveBeenCalledTimes(1);
    expect(steps).toEqual(["occupant-finalized", "bridge-stop"]);
  });

  it("runs the clock-driven workers on the runtime's clock", async () => {
    // Inject a TestClock beneath the real graph: EffectRunnerLive captures it,
    // so the workers' lifecycle fibers sleep on virtual time if (and only if)
    // the container hands them the runtime's runner.
    const realAppLive = appLayers.AppLive;
    const appLiveSpy = spyOn(appLayers, "AppLive").mockImplementation((appStores) =>
      realAppLive(appStores).pipe(Layer.provideMerge(TestClock.layer()))
    );
    try {
      services = new ServiceContainer(stores);
    } finally {
      appLiveSpy.mockRestore();
    }
    const runtime = services.runtime.managed;
    // IdleCompactionService.checkAllWorkspaces reads the config synchronously
    // at the start of every check.
    const loadConfigSpy = spyOn(services.config, "loadConfigOrDefault");
    // HeartbeatService's observable lifecycle contract: the scheduler fiber is
    // held in `startupTimeout` during the startup delay and moves to
    // `checkInterval` once ticking (same shape heartbeatService.test.ts pins).
    const heartbeatInternals = services.heartbeatService as unknown as {
      startupTimeout: unknown;
      checkInterval: unknown;
    };

    services.idleCompactionService.start();
    services.heartbeatService.start();
    expect(loadConfigSpy).not.toHaveBeenCalled();
    expect(heartbeatInternals.startupTimeout).not.toBeNull();
    expect(heartbeatInternals.checkInterval).toBeNull();

    // Both workers wait one minute before their first tick.
    await runtime.runPromise(TestClock.adjust(Duration.minutes(1)));

    expect(loadConfigSpy).toHaveBeenCalledTimes(1);
    expect(heartbeatInternals.startupTimeout).toBeNull();
    expect(heartbeatInternals.checkInterval).not.toBeNull();

    services.heartbeatService.stop();
    services.idleCompactionService.stop();
  });

  it("serves every ORPC context field through its tag (one instance each)", () => {
    services = new ServiceContainer(stores);
    const orpcContext = services.toORPCContext();
    const effectContext = orpcContext["effect/context"];

    for (const [field, tag] of Object.entries(ORPC_FIELD_TAGS) as Array<
      [keyof typeof ORPC_FIELD_TAGS, Context.Key<AppTags, unknown>]
    >) {
      expect(Context.get(effectContext, tag)).toBe(orpcContext[field]);
    }
    expect(services.runtime.get(IdleDispatcherTag)).toBe(services.idleDispatcher);
    expect(services.runtime.get(StreamManagerTag).effectRunner).toBe(
      services.runtime.get(EffectRunnerTag)
    );
    // The core graph's options are derived from the layer-built cross-cutting
    // instances, so core constructors received the same objects the fields expose.
    const coreOptions = services.runtime.get(CoreOptionsTag);
    expect(coreOptions.policyService).toBe(services.policyService);
    expect(coreOptions.experimentsService).toBe(services.experimentsService);
  });

  it("wires the desktop services like the constructor did (each line has an observable effect)", () => {
    services = new ServiceContainer(stores);

    // turnRequestBuilderBindings: the desktop-only collaborators.
    const bindings = services.runtime.get(TurnRequestBuilderBindingsTag);
    expect(bindings.analyticsService).toBe(services.analyticsService);
    expect(bindings.desktopSessionManager).toBe(services.desktopSessionManager);
    expect(bindings.timelineService).toBe(services.timelineService);
    expect(bindings.codexOauthService).toBe(services.codexOauthService);
    expect(bindings.coderOauthService).toBe(services.coderOauthService);

    // Setter-provided collaborators (the former `set*` lines).
    const workspaceInternals = services.workspaceService as unknown as {
      terminalService?: unknown;
      desktopSessionManager?: unknown;
      refinePassCanceller?: unknown;
      timelineRecorder?: unknown;
      worktreeArchiveSnapshotService?: unknown;
      workspaceLifecycleHooks?: unknown;
    };
    expect(workspaceInternals.terminalService).toBe(services.terminalService);
    expect(workspaceInternals.desktopSessionManager).toBe(services.desktopSessionManager);
    expect(workspaceInternals.refinePassCanceller).toBe(services.refineService);
    expect(workspaceInternals.timelineRecorder).toBe(services.timelineService);
    expect(workspaceInternals.worktreeArchiveSnapshotService).toBe(
      services.runtime.get(WorktreeArchiveSnapshot)
    );
    expect(workspaceInternals.workspaceLifecycleHooks).toBe(
      services.runtime.get(WorkspaceLifecycleHooksTag)
    );
    for (const recorderOwner of [
      services.taskService,
      services.heartbeatService,
      services.workspaceGoalService,
    ]) {
      expect((recorderOwner as unknown as { timelineRecorder?: unknown }).timelineRecorder).toBe(
        services.timelineService
      );
    }
    const projectInternals = services.projectService as unknown as {
      workspaceService?: unknown;
      workspaceMetadataRefresher?: unknown;
      mcpServerManager?: unknown;
    };
    expect(projectInternals.workspaceService).toBe(services.workspaceService);
    expect(projectInternals.workspaceMetadataRefresher).toBe(services.workspaceService);
    expect(projectInternals.mcpServerManager).toBe(services.mcpServerManager);
    expect(
      (services.mcpServerManager as unknown as { mcpOauthService?: unknown }).mcpOauthService
    ).toBe(services.mcpOauthService);
    const backupInternals = services.backupService as unknown as {
      projectRegistrar?: unknown;
      memoryNotifier?: unknown;
    };
    expect(backupInternals.projectRegistrar).toBe(services.projectService);
    expect(backupInternals.memoryNotifier).toBe(services.memoryService);

    // Idle-compaction outcomes reach the idle compaction service.
    const recordOutcomeSpy = spyOn(services.idleCompactionService, "recordOutcome");
    const outcomeListener = (
      services.workspaceService as unknown as {
        idleCompactionOutcomeListener?: (workspaceId: string, outcome: unknown) => void;
      }
    ).idleCompactionOutcomeListener;
    outcomeListener?.("ws-1", { success: true });
    expect(recordOutcomeSpy).toHaveBeenCalledWith("ws-1", { success: true });

    // Global registrations: the SSH connection pools consult this container's
    // prompt service for interactive host-key approval.
    const responderSpy = spyOn(services.sshPromptService, "hasInteractiveResponder");
    responderSpy.mockReturnValue(true);
    expect(isInteractiveHostKeyApprovalAvailable()).toBe(true);
    responderSpy.mockReturnValue(false);
    expect(isInteractiveHostKeyApprovalAvailable()).toBe(false);

    // Timeline subscribed to the workspace service, and the workers' timing
    // listeners registered: a stream-start reaches the session timing service.
    const timingSpy = spyOn(services.sessionTimingService, "handleStreamStart").mockImplementation(
      () => undefined
    );
    services.aiService.emit("stream-start", {
      type: "stream-start",
      workspaceId: "ws-1",
      messageId: "m-1",
      model: "openai:gpt-4o",
      historySequence: 1,
      startTime: Date.now(),
      mode: "exec",
    });
    expect(timingSpy).toHaveBeenCalledTimes(1);
  });

  it("tears down in the fixed dispose() and shutdown() order", async () => {
    const order: string[] = [];
    const record = (step: string) => () => {
      order.push(step);
      return Promise.resolve(undefined);
    };
    services = new ServiceContainer(stores);
    spyOn(services.desktopBridgeServer, "stop").mockImplementation(record("bridge.stop"));
    spyOn(services.desktopSessionManager, "closeAll").mockImplementation(
      record("sessions.closeAll")
    );
    spyOn(services.browserBridgeServer, "stop").mockImplementation(record("browserBridge.stop"));
    spyOn(services.analyticsService, "dispose").mockImplementation(record("analytics.dispose"));
    spyOn(services.timelineService, "flush").mockImplementation(record("timeline.flush"));
    spyOn(services.telemetryService, "shutdown").mockImplementation(record("telemetry.shutdown"));

    await services.dispose();
    // Release desktop input before stopping its bridge; browser bridge precedes analytics.
    expect(order).toEqual([
      "sessions.closeAll",
      "bridge.stop",
      "browserBridge.stop",
      "analytics.dispose",
      "timeline.flush",
    ]);

    order.length = 0;
    await services.shutdown();
    expect(order).toEqual([
      "sessions.closeAll",
      "bridge.stop",
      "browserBridge.stop",
      "timeline.flush",
      "analytics.dispose",
      "telemetry.shutdown",
    ]);
  });

  it("surfaces a throwing layer as a synchronous constructor throw", () => {
    const realAppLive = appLayers.AppLive;
    const appLiveSpy = spyOn(appLayers, "AppLive").mockImplementation((appStores) =>
      Layer.sync(MemoryMeta, () => {
        throw new Error("layer boom");
      }).pipe(Layer.provideMerge(realAppLive(appStores)))
    );
    try {
      // Same shape as a throwing service constructor, so the entry points'
      // existing startup catch paths (dialog / log-and-exit) apply unchanged.
      expect(() => new ServiceContainer(stores)).toThrow("layer boom");
    } finally {
      appLiveSpy.mockRestore();
    }
  });
});

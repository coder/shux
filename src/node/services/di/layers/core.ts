import {
  readPluginMcpPolicy,
  PLUGIN_REGISTRY_FILE_NAME,
} from "@/node/services/agentPlugins/registry";
import { readPersistedExperimentEnabled } from "@/node/services/experimentsService";
import { ClaudeDesignService } from "@/node/services/claudeDesignService";
import * as os from "os";
import * as path from "path";
import { Context, Effect, Layer } from "effect";
import { EXPERIMENT_IDS } from "@/common/constants/experiments";
import { secretsToRecord } from "@/common/types/secrets";
import { isMultiProject } from "@/common/utils/multiProject";
import {
  acquirePluginMutationLock,
  STAGING_DIR_NAME,
  readMutationEpochToken,
} from "@/node/services/agentPlugins/journals";
import {
  PLUGIN_SERVER_KEY_PREFIX,
  createAgentPluginsMcpProvider,
} from "@/node/services/agentPlugins/mcpConfig";
import { AIService } from "@/node/services/aiService";
import { BackgroundProcessManager } from "@/node/services/backgroundProcessManager";
import type { CoreOptions, CoreServices, CoreServicesOptions } from "@/node/services/coreServices";
import { AppFiberScopeLive, AppFiberScopeTag } from "@/node/services/di/appFiberScope";
import { EffectRunnerLive, EffectRunnerTag } from "@/node/services/di/effectRunner";
import {
  AI,
  BackgroundProcessManagerTag,
  ConfigTag,
  ExtensionMetadata,
  FileLeaseManagerTag,
  History,
  IdleDispatcherTag,
  InitStateManagerTag,
  MCPConfig,
  MCPServerManagerTag,
  Memory,
  MemoryConsolidation,
  MemoryMeta,
  Provider,
  ProvidersConfigStoreTag,
  SecretsStoreTag,
  SessionLocatorTag,
  SessionUsage,
  StreamManagerTag,
  Task,
  DesktopInputCoordinatorTag,
  TerminalAttentionStoreTag,
  TurnRequestBuilderBindingsTag,
  Workspace,
  WorkspaceGoal,
  WorkspaceMcpOverrides,
  WorkspaceTurnManagerTag,
  type CoreRootTags,
  type CoreTags,
  type StoreTags,
} from "@/node/services/di/tags";
import { ExtensionMetadataService } from "@/node/services/ExtensionMetadataService";
import { HistoryService } from "@/node/services/historyService";
import { IdleDispatcher } from "@/node/services/idleDispatcher";
import { InitStateManager } from "@/node/services/initStateManager";
import { log } from "@/node/services/log";
import { MCPConfigService } from "@/node/services/mcpConfigService";
import { MCPServerManager } from "@/node/services/mcpServerManager";
import { MemoryConsolidationService } from "@/node/services/memoryConsolidationService";
import { MemoryMetaService } from "@/node/services/memoryMeta";
import { MemoryService } from "@/node/services/memoryService";
import { ProviderService } from "@/node/services/providerService";
import { SessionUsageService } from "@/node/services/sessionUsageService";
import { StreamManager } from "@/node/services/streamManager";
import { DesktopInputCoordinator } from "@/node/services/desktop/DesktopInputCoordinator";
import { TaskService } from "@/node/services/taskService";
import { TerminalAttentionStore } from "@/node/services/terminalAttentionStore";
import type { TurnRequestBuilderBindings } from "@/node/services/turnRequestBuilder";
import { mergeMultiProjectSecrets } from "@/node/services/utils/multiProjectSecrets";
import { WorkspaceGoalService } from "@/node/services/workspaceGoalService";
import {
  MCP_OVERRIDES_READ_TIMEOUT_MS,
  readWorkspaceOverridesEpochToken,
  WorkspaceMcpOverridesService,
} from "@/node/services/workspaceMcpOverridesService";
import { WorkspaceService } from "@/node/services/workspaceService";
import { WorkspaceTurnManager } from "@/node/services/workspaceTurnManager";
import { StoresFromCoreOptionsLive } from "./stores";

/**
 * Layers for the core service graph shared by the desktop/server app and the
 * headless CLI roots (Effect migration Phase 11).
 *
 * Every `*Live` below is a thin adapter around an existing constructor with
 * its existing argument list; the bodies stay synchronous (DI contract in
 * `../appRuntime.ts`) and register no finalizers. Dependencies are expressed
 * only through what a body yields, and build order only through the explicit
 * stages at the bottom of this file (`Layer.provideMerge` between stages;
 * `Layer.mergeAll` for true siblings within a stage — siblings may build in
 * any order, so nothing may rely on sibling order). The former imperative
 * body's setter/listener wiring is replayed, in its original order, by
 * `CoreWiringLive` once every service exists.
 */

/** The core graph's inputs other than the stores (`CoreOptions` in coreServices.ts). */
export class CoreOptionsTag extends Context.Service<CoreOptionsTag, CoreOptions>()(
  "xum/CoreOptions"
) {}

/**
 * What the roots must provide beneath `CoreLive`: the stores, the options,
 * the runtime seams (the base of both roots: `EffectRunner`, through which
 * StreamManager's clock-driven fibers run, and `AppFiberScope`, which
 * supervises its stream engine), and the two always-present collaborators the
 * desktop builds elsewhere (`MemoryMetaLive`; `WorkspaceMcpOverrides` from
 * `CrossCuttingLive`). CLI roots supply the defaults (`MemoryMetaLive`,
 * `WorkspaceMcpOverridesDefaultLive`).
 */
export type CoreInputTags =
  | StoreTags
  | CoreOptionsTag
  | EffectRunnerTag
  | AppFiberScopeTag
  | MemoryMeta
  | WorkspaceMcpOverrides;

/** Memory metadata sidecar; scope root derives from the xum home (`config.rootDir`). */
export const MemoryMetaLive: Layer.Layer<MemoryMeta, never, ConfigTag> = Layer.effect(
  MemoryMeta,
  Effect.map(ConfigTag, (config) => new MemoryMetaService(config.rootDir))
);

/**
 * Default for roots without a desktop `CrossCuttingLive`: workspace MCP
 * override reads AND registration-time plugin-override sanitization must work
 * in every process that can register workspaces, not just desktop.
 */
export const WorkspaceMcpOverridesDefaultLive: Layer.Layer<
  WorkspaceMcpOverrides,
  never,
  ConfigTag | CoreOptionsTag
> = Layer.effect(
  WorkspaceMcpOverrides,
  Effect.gen(function* () {
    const config = yield* ConfigTag;
    const opts = yield* CoreOptionsTag;
    // The override epoch and writer locks must live where a sibling backend
    // looks for them: `xum run` registers under a disposable root while its
    // MCP configuration (and the desktop/server backend's) is the persistent
    // home, so coordinate under the latter.
    return new WorkspaceMcpOverridesService(config, {
      coordinationRootDir: (opts.mcpConfig ?? config).rootDir,
    });
  })
);

// ---------------------------------------------------------------------------
// S1 — leaves: depend only on the graph inputs.
// ---------------------------------------------------------------------------

export const HistoryLive = Layer.effect(
  History,
  Effect.map(SessionLocatorTag, (sessionLocator) => new HistoryService(sessionLocator))
);

export const InitStateManagerLive = Layer.effect(
  InitStateManagerTag,
  Effect.map(ConfigTag, (config) => new InitStateManager(config))
);

export const ProviderLive = Layer.effect(
  Provider,
  Effect.gen(function* () {
    const opts = yield* CoreOptionsTag;
    return new ProviderService(
      yield* ConfigTag,
      opts.policyService,
      yield* ProvidersConfigStoreTag,
      yield* FileLeaseManagerTag
    );
  })
);

export const BackgroundProcessManagerLive = Layer.sync(
  BackgroundProcessManagerTag,
  () => new BackgroundProcessManager(path.join(os.tmpdir(), "mux-bashes"))
);

export const ExtensionMetadataLive = Layer.effect(
  ExtensionMetadata,
  Effect.map(CoreOptionsTag, (opts) => new ExtensionMetadataService(opts.extensionMetadataPath))
);

// Agent memory (memory experiment): scope roots derive from Config (xum home
// + session dirs); experiment gating happens per stream in AIService.
export const MemoryLive = Layer.effect(
  Memory,
  Effect.gen(function* () {
    return new MemoryService(yield* ConfigTag, yield* MemoryMeta);
  })
);

export const DesktopInputCoordinatorLive = Layer.effect(
  DesktopInputCoordinatorTag,
  Effect.map(ConfigTag, (config) => new DesktopInputCoordinator(config))
);

export const TerminalAttentionStoreLive = Layer.effect(
  TerminalAttentionStoreTag,
  Effect.map(ConfigTag, (config) => new TerminalAttentionStore(config))
);

// Goal continuation bridge lives at the core scope so every codepath that
// uses the core graph (xum run, xum server via ServiceContainer, tests)
// gets a working dispatcher. Without this, requestContinuationAfterStreamEnd
// is a no-op and the auto-continuation loop never fires. The dispatcher is
// also exposed so ServiceContainer can share it with HeartbeatService. Its
// consumer is registered by `CoreWiringLive` once Task/Workspace exist.
export const IdleDispatcherLive = Layer.sync(IdleDispatcherTag, () => new IdleDispatcher());

/** One mutable record per graph build (`sync`, not `succeed`); filled by `CoreWiringLive`. */
export const TurnRequestBuilderBindingsLive = Layer.sync(
  TurnRequestBuilderBindingsTag,
  (): TurnRequestBuilderBindings => ({})
);

// ---------------------------------------------------------------------------
// S2a — need S1 leaves.
// ---------------------------------------------------------------------------

// Providers config accessor enables mappedToModel alias resolution for
// headless usage pricing (status generation and memory sweeps).
export const SessionUsageLive = Layer.effect(
  SessionUsage,
  Effect.gen(function* () {
    const providerService = yield* Provider;
    return new SessionUsageService(yield* ConfigTag, yield* History, () =>
      providerService.getConfig()
    );
  })
);

export const WorkspaceGoalLive = Layer.effect(
  WorkspaceGoal,
  Effect.gen(function* () {
    const opts = yield* CoreOptionsTag;
    return new WorkspaceGoalService(
      yield* ConfigTag,
      yield* History,
      yield* ExtensionMetadata,
      opts.analyticsService,
      opts.goalServiceOptions,
      yield* ProvidersConfigStoreTag
    );
  })
);

// ---------------------------------------------------------------------------
// S2b — StreamManager needs SessionUsage (S2a).
// ---------------------------------------------------------------------------

export const StreamManagerLive = Layer.effect(
  StreamManagerTag,
  Effect.gen(function* () {
    const providerService = yield* Provider;
    return new StreamManager(
      yield* History,
      yield* SessionUsage,
      () => providerService.getConfig(),
      // Default event sink: AIService installs itself as the sink (S3).
      undefined,
      yield* EffectRunnerTag,
      // The stream engine is the AppFiberScope's occupant: dispose() closes the
      // scope before the explicit teardown steps, which aborts and awaits every
      // in-flight stream (StreamManager.superviseEngine).
      yield* AppFiberScopeTag
    );
  })
);

// ---------------------------------------------------------------------------
// S3 — AIService needs StreamManager (S2b). Its constructor installs itself as
// the stream manager's event sink and subscribes to provider config changes —
// both on declared constructor dependencies (I6).
// ---------------------------------------------------------------------------

export const AILive = Layer.effect(
  AI,
  Effect.gen(function* () {
    const opts = yield* CoreOptionsTag;
    return new AIService(
      yield* ConfigTag,
      yield* History,
      yield* InitStateManagerTag,
      yield* Provider,
      yield* BackgroundProcessManagerTag,
      yield* SessionUsage,
      yield* WorkspaceMcpOverrides,
      opts.policyService,
      opts.telemetryService,
      opts.devToolsService,
      opts.experimentsService,
      yield* StreamManagerTag,
      yield* TurnRequestBuilderBindingsTag,
      yield* ProvidersConfigStoreTag,
      yield* SecretsStoreTag
    );
  })
);

// ---------------------------------------------------------------------------
// S4 — need AIService (S3).
// ---------------------------------------------------------------------------

// Background dream consolidation (memory-consolidation experiment). Without
// an ExperimentsService (CLI/test contexts) the service stays inert.
export const MemoryConsolidationLive = Layer.effect(
  MemoryConsolidation,
  Effect.gen(function* () {
    const opts = yield* CoreOptionsTag;
    return new MemoryConsolidationService(
      yield* ConfigTag,
      yield* Memory,
      yield* MemoryMeta,
      yield* History,
      yield* AI,
      opts.experimentsService ?? { isExperimentEnabled: () => false },
      yield* SessionUsage
    );
  })
);

export const MCPConfigLive = Layer.effect(
  MCPConfig,
  Effect.gen(function* () {
    const opts = yield* CoreOptionsTag;
    const config = yield* ConfigTag;
    // MCP: allow callers to override which Config provides server definitions
    const mcpConfig = opts.mcpConfig ?? config;
    // Agent Plugins (agent-plugins experiment): read-only plugin MCP servers are
    // merged into listings; without an ExperimentsService the provider is inert.
    return new MCPConfigService(mcpConfig, {
      claudeDesign: new ClaudeDesignService({
        rootDir: mcpConfig.rootDir,
        readEnabled: () =>
          readPersistedExperimentEnabled(EXPERIMENT_IDS.CLAUDE_DESIGN_MCP, {
            xumHome: mcpConfig.rootDir,
          }),
        isEnabled: () =>
          opts.experimentsService?.isExperimentEnabled(EXPERIMENT_IDS.CLAUDE_DESIGN_MCP) === true,
      }),
      agentPluginsMcpProvider: createAgentPluginsMcpProvider({
        xumHome: mcpConfig.rootDir,
        isEnabled: () =>
          opts.experimentsService?.isExperimentEnabled(EXPERIMENT_IDS.AGENT_PLUGINS) === true,
      }),
      policyService: opts.policyService,
      telemetryService: opts.telemetryService,
      workspaceMetadataProvider: yield* AI,
    });
  })
);

// ---------------------------------------------------------------------------
// S5 — MCPServerManager needs MCPConfig (S4).
// ---------------------------------------------------------------------------

export const MCPServerManagerLive = Layer.effect(
  MCPServerManagerTag,
  Effect.gen(function* () {
    const opts = yield* CoreOptionsTag;
    const config = yield* ConfigTag;
    const mcpConfig = opts.mcpConfig ?? config;
    const workspaceMcpOverridesService = yield* WorkspaceMcpOverrides;
    return new MCPServerManager(
      yield* MCPConfig,
      {
        // A plugin update/uninstall in a sibling process (desktop app alongside
        // `xum server`) bumps the installer's mutation epoch; managers retire
        // cached plugin instances before serving them again. The sibling's
        // uninstall also pruned plugin keys from workspace override files, so
        // the sweep refreshes cached override snapshots from disk.
        config,
        telemetryService: opts.telemetryService,
        pluginInvalidation: {
          keyPrefix: PLUGIN_SERVER_KEY_PREFIX,
          readComponentPolicy: () =>
            readPluginMcpPolicy(path.join(mcpConfig.rootDir, PLUGIN_REGISTRY_FILE_NAME)),
          tryAcquireComponentPolicyLock: (options) =>
            acquirePluginMutationLock(mcpConfig.rootDir, { timeoutMs: 0, ...options }),
          readToken: () => readMutationEpochToken(path.join(mcpConfig.rootDir, STAGING_DIR_NAME)),
          // Bounded/cancellable like the send path's own read: a distrusted or
          // cold serve re-reads through here, and an unreachable SSH/Docker
          // parent must not pin the send for the remote command timeout.
          readWorkspaceOverrides: async (workspaceId, options) => {
            const read = await workspaceMcpOverridesService.getOverridesForWorkspace(workspaceId, {
              timeoutMs: options?.timeoutMs ?? MCP_OVERRIDES_READ_TIMEOUT_MS,
              ...(options?.signal !== undefined ? { signal: options.signal } : {}),
            });
            // undefined = not disk-authoritative; the manager keeps its fallbacks.
            return read.authoritative ? read.overrides : undefined;
          },
          // A sibling backend's override save/prune bumps this; the manager
          // refreshes or evicts its cached snapshots on the next serve.
          readOverridesEpoch: () => readWorkspaceOverridesEpochToken(mcpConfig.rootDir),
          // Served tool calls fence their dispatch against sibling-process
          // override writes with the writer's own lock.
          acquireOverridesLock: (options) =>
            workspaceMcpOverridesService.acquireExclusiveLock(options),
        },
        ...opts.mcpServerManagerOptions,
      },
      opts.policyService
    );
  })
);

// ---------------------------------------------------------------------------
// S6 — WorkspaceService. Its constructor needs nothing beyond S3 (the MCP
// manager and memory consolidation collaborators arrive through setters in
// CoreWiringLive); it is staged after MCPServerManager only to keep the former
// body's construction order, not because of a dependency.
// ---------------------------------------------------------------------------

// The constructor subscribes to its declared dependencies (backgroundProcessManager,
// aiService, initStateManager, extensionMetadata) and starts the bash-monitor
// recovery pass; it touches none of its setter-provided collaborators (I6).
export const WorkspaceLive = Layer.effect(
  Workspace,
  Effect.gen(function* () {
    const opts = yield* CoreOptionsTag;
    return new WorkspaceService(
      yield* ConfigTag,
      yield* History,
      yield* AI,
      yield* InitStateManagerTag,
      yield* ExtensionMetadata,
      yield* BackgroundProcessManagerTag,
      yield* SessionUsage,
      opts.policyService,
      opts.telemetryService,
      opts.experimentsService,
      opts.sessionTimingService,
      yield* StreamManagerTag,
      yield* SecretsStoreTag,
      yield* ProvidersConfigStoreTag,
      yield* DesktopInputCoordinatorTag,
      yield* EffectRunnerTag,
      yield* AppFiberScopeTag
    );
  })
);

// ---------------------------------------------------------------------------
// S7 — TaskService needs Workspace (S6).
// ---------------------------------------------------------------------------

// The constructor subscribes to aiService stream events after WorkspaceService's
// own subscriptions — guaranteed by staging, since it depends on Workspace (I6).
export const TaskLive = Layer.effect(
  Task,
  Effect.gen(function* () {
    return new TaskService(
      yield* ConfigTag,
      yield* History,
      yield* AI,
      yield* Workspace,
      yield* InitStateManagerTag,
      yield* SessionUsage,
      yield* WorkspaceGoal,
      yield* SecretsStoreTag,
      yield* TerminalAttentionStoreTag,
      yield* DesktopInputCoordinatorTag
    );
  })
);

// ---------------------------------------------------------------------------
// S8 — WorkspaceTurnManager needs TaskService (S7).
// ---------------------------------------------------------------------------

export const WorkspaceTurnManagerLive = Layer.effect(
  WorkspaceTurnManagerTag,
  Effect.gen(function* () {
    return new WorkspaceTurnManager(
      yield* ConfigTag,
      yield* History,
      yield* AI,
      yield* Workspace,
      yield* InitStateManagerTag,
      yield* Task,
      yield* TerminalAttentionStoreTag,
      yield* StreamManagerTag,
      yield* DesktopInputCoordinatorTag
    );
  })
);

// ---------------------------------------------------------------------------
// Wiring — the former construction body's setter/listener lines, in their
// original order, once every service exists. Synchronous statements only: no
// finalizers, no forks (I5), so `dispose()` order stays explicit elsewhere.
// ---------------------------------------------------------------------------

export const CoreWiringLive: Layer.Layer<
  never,
  never,
  CoreTags | ConfigTag | SecretsStoreTag | CoreOptionsTag | WorkspaceMcpOverrides
> = Layer.effectDiscard(
  Effect.gen(function* () {
    const config = yield* ConfigTag;
    const opts = yield* CoreOptionsTag;
    const secretsStore = yield* SecretsStoreTag;
    const extensionMetadata = yield* ExtensionMetadata;
    const workspaceGoalService = yield* WorkspaceGoal;
    const workspaceMcpOverridesService = yield* WorkspaceMcpOverrides;
    const turnRequestBuilderBindings = yield* TurnRequestBuilderBindingsTag;
    const streamManager = yield* StreamManagerTag;
    const aiService = yield* AI;
    const memoryService = yield* Memory;
    const memoryConsolidationService = yield* MemoryConsolidation;
    const mcpServerManager = yield* MCPServerManagerTag;
    const workspaceService = yield* Workspace;
    const taskService = yield* Task;
    const workspaceTurnManager = yield* WorkspaceTurnManagerTag;
    const idleDispatcher = yield* IdleDispatcherTag;

    // Write tombstones are process-local removal knowledge; the shared config
    // is the authority (with XUM_ALLOW_MULTIPLE_INSTANCES a downgraded backend
    // can legitimately re-register a deterministic legacy id this process
    // pruned). Without this probe, a tombstoned id that becomes active again
    // would have every metadata write and broadcast suppressed until an
    // activity bootstrap happens to run. Raw view first (cheap; complete when
    // every persisted entry carries an inline id); only id-less legacy entries
    // require the authoritative enumeration. Throws propagate: unknowable
    // registration keeps the tombstone.
    extensionMetadata.setRegistrationProbe(async (workspaceId) => {
      const evidence = config.readPersistedWorkspaceIdEvidence();
      if (evidence.ids.has(workspaceId)) {
        return true;
      }
      if (!evidence.hasWorkspaceEntriesWithoutIds) {
        return false;
      }
      // Targeted lenient positive first: a POSITIVE identity match needs no
      // completeness, so a re-registered workspace whose own compatibility
      // metadata is healthy must not stay write-suppressed because an
      // UNRELATED legacy entry's metadata is malformed (the strict
      // enumeration below throws on the first such entry, and the tombstone
      // would then pin every one of the target's writes as transient
      // indefinitely). A lenient scan only skips unreadable entries — it
      // never fabricates a match.
      if (config.findWorkspace(workspaceId) != null) {
        return true;
      }
      // Negatives keep requiring the complete strict view: a lenient miss is
      // indistinguishable from an identity hidden by a read failure. Alias
      // ids: a second resolvable compatibility file's identity stays
      // registered for findWorkspace even though it is not any entry's
      // primary id — refusing its writes/deletions requires knowing it here.
      const legacyAliasIds = new Set<string>();
      const registered = (
        await config.getAllWorkspaceMetadata({ throwOnError: true, legacyAliasIds })
      ).some((metadata) => metadata.id === workspaceId);
      return registered || legacyAliasIds.has(workspaceId);
    });

    turnRequestBuilderBindings.memoryService = memoryService;

    turnRequestBuilderBindings.mcpServerManager = mcpServerManager;
    streamManager.setMCPServerManager(mcpServerManager);
    // Recorded prompt options can hold stale secret snapshots, so prompt refreshes
    // resolve credentials from current configuration.
    mcpServerManager.setSecretsResolver(async (workspaceId, projectPath) => {
      const metadataResult = await aiService.getWorkspaceMetadata(workspaceId);
      const metadata = metadataResult.success ? metadataResult.data : null;
      const secrets =
        metadata && isMultiProject(metadata)
          ? mergeMultiProjectSecrets(metadata, secretsStore)
          : secretsStore.getEffectiveSecrets(projectPath);
      return secretsToRecord(secrets);
    });

    turnRequestBuilderBindings.workspaceHeartbeatService = workspaceService;
    // Tool-started workflows share the same sidebar activity cache as ORPC-started workflows,
    // so terminal updates must prune active run counts regardless of launch path.
    turnRequestBuilderBindings.onWorkflowRunStatusChanged = (event) =>
      workspaceService.emitWorkflowRunActivity(event);
    turnRequestBuilderBindings.workflowResultContinuationSender = workspaceService;
    workspaceService.setMemoryConsolidationService(memoryConsolidationService);
    if (opts.devToolsService) {
      // DevTools debug-log cleanup when workspaces are archived/removed.
      workspaceService.setDevToolsService(opts.devToolsService);
    }
    workspaceService.setMCPServerManager(mcpServerManager);
    // Plugin override keys must be pruned from a workspace's override files when
    // registering a preserved checkout (desktop create/fork, task
    // materialization, and headless `xum run`/`xum workflow` registration) and
    // during removal: a stale enable in a kept .xum/mcp.local.jsonc could
    // otherwise re-activate a same-name reinstall's server.
    workspaceService.setWorkspaceMcpOverridesService(workspaceMcpOverridesService);
    workspaceService.setWorkspaceGoalService(workspaceGoalService);
    workspaceGoalService.setOnActivityChange((workspaceId, snapshot) => {
      workspaceService.emitWorkspaceActivity(workspaceId, snapshot);
    });
    // Wire user-initiated `promoteUpcomingGoal` through `interruptStream`
    // so promoting mid-stream cleanly aborts the in-flight turn before
    // the new active goal lands. Without this, the goal service would
    // proceed without aborting and the tail of the current stream could
    // leak token usage into the newly-promoted goal's accounting (the
    // earlier Codex P1 concern). Soft hand-off here means a queued
    // message stays in the user's input box; the next `sendMessage`
    // will start fresh against the promoted goal.
    workspaceGoalService.setStreamInterrupter(async (workspaceId) => {
      const result = await workspaceService.interruptStream(workspaceId);
      if (!result.success) {
        // The goal service logs + falls back; we just surface a warning
        // here so production paths flag the rare error.
        log.warn("coreServices: promote interrupt failed", { workspaceId, error: result.error });
      }
    });

    taskService.setWorkspaceTurnManager(workspaceTurnManager);
    turnRequestBuilderBindings.taskService = taskService;
    turnRequestBuilderBindings.workspaceTurnManager = workspaceTurnManager;
    workspaceService.setAgentTaskIntegration(taskService);

    workspaceGoalService.registerGoalContinuationConsumer(idleDispatcher, {
      hasActiveDescendantTasks: (workspaceId) =>
        taskService.hasActiveDescendantAgentTasksForWorkspace(workspaceId),
      getRuntimeState: (workspaceId) =>
        workspaceService.getGoalContinuationRuntimeState(workspaceId),
      executeGoalContinuation: (input) => workspaceService.executeGoalContinuation(input),
      getKickoffSendOptions: (workspaceId) =>
        workspaceService.getGoalContinuationKickoffSendOptions(workspaceId),
    });
  })
);

// ---------------------------------------------------------------------------
// Staged composition. Each stage depends only on stages above it; `provideMerge`
// keeps both sides exposed, so the final context carries every core tag.
// ---------------------------------------------------------------------------

const S1 = Layer.mergeAll(
  HistoryLive,
  InitStateManagerLive,
  ProviderLive,
  BackgroundProcessManagerLive,
  ExtensionMetadataLive,
  MemoryLive,
  TerminalAttentionStoreLive,
  DesktopInputCoordinatorLive,
  IdleDispatcherLive,
  TurnRequestBuilderBindingsLive
);
const S2a = Layer.mergeAll(SessionUsageLive, WorkspaceGoalLive).pipe(Layer.provideMerge(S1));
const S2b = StreamManagerLive.pipe(Layer.provideMerge(S2a));
const S3 = AILive.pipe(Layer.provideMerge(S2b));
const S4 = Layer.mergeAll(MemoryConsolidationLive, MCPConfigLive).pipe(Layer.provideMerge(S3));
const S5 = MCPServerManagerLive.pipe(Layer.provideMerge(S4));
const S6 = WorkspaceLive.pipe(Layer.provideMerge(S5));
const S7 = TaskLive.pipe(Layer.provideMerge(S6));
const S8 = WorkspaceTurnManagerLive.pipe(Layer.provideMerge(S7));

/**
 * The whole core graph, wired. The roots provide `CoreInputTags` beneath it
 * (`MemoryMeta` is one of them, hence excluded from the outputs here; the
 * root's merged context still carries every `CoreTags` entry).
 */
export const CoreLive: Layer.Layer<
  Exclude<CoreTags, MemoryMeta>,
  never,
  CoreInputTags
> = CoreWiringLive.pipe(Layer.provideMerge(S8));

/** Tagged context → the plain `CoreServices` object the roots hand out. */
export function coreServicesFromContext(context: Context.Context<CoreTags>): CoreServices {
  return {
    historyService: Context.get(context, History),
    initStateManager: Context.get(context, InitStateManagerTag),
    providerService: Context.get(context, Provider),
    backgroundProcessManager: Context.get(context, BackgroundProcessManagerTag),
    sessionUsageService: Context.get(context, SessionUsage),
    workspaceGoalService: Context.get(context, WorkspaceGoal),
    idleDispatcher: Context.get(context, IdleDispatcherTag),
    aiService: Context.get(context, AI),
    streamManager: Context.get(context, StreamManagerTag),
    mcpConfigService: Context.get(context, MCPConfig),
    mcpServerManager: Context.get(context, MCPServerManagerTag),
    extensionMetadata: Context.get(context, ExtensionMetadata),
    workspaceService: Context.get(context, Workspace),
    taskService: Context.get(context, Task),
    workspaceTurnManager: Context.get(context, WorkspaceTurnManagerTag),
    memoryService: Context.get(context, Memory),
    memoryMetaService: Context.get(context, MemoryMeta),
    memoryConsolidationService: Context.get(context, MemoryConsolidation),
    turnRequestBuilderBindings: Context.get(context, TurnRequestBuilderBindingsTag),
  };
}

/**
 * Full Layer graph for a headless CLI root (`xum run`, `xum workflow`): the
 * core graph over the caller's options with the CLI defaults for the two
 * desktop-built inputs, and the runtime seams at the base exactly as in
 * `AppLive` (`./app.ts`). Composition direction is
 * `consumer.pipe(Layer.provideMerge(provider))`; every tag stays exposed.
 */
export function CoreRootLive(opts: CoreServicesOptions): Layer.Layer<CoreRootTags> {
  // The stores travel under their own tags (StoresFromCoreOptionsLive).
  const {
    config,
    sessionLocator,
    providersConfigStore,
    secretsStore,
    fileLeaseManager,
    ...coreOptions
  } = opts;
  const runtimeSeams = AppFiberScopeLive.pipe(
    Layer.provideMerge(EffectRunnerLive.pipe(Layer.provideMerge(StoresFromCoreOptionsLive(opts))))
  );
  return CoreLive.pipe(
    // True siblings: both derive from the config alone.
    Layer.provideMerge(Layer.mergeAll(MemoryMetaLive, WorkspaceMcpOverridesDefaultLive)),
    Layer.provideMerge(Layer.succeed(CoreOptionsTag)(coreOptions)),
    Layer.provideMerge(runtimeSeams)
  );
}

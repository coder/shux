/**
 * Effect service tags for the app dependency graph (Effect migration Phase 11).
 *
 * One tag per service class provided by the Layer graph in `./layers/*`. The
 * service classes are imported as types only, so this module has no runtime
 * dependency on them and can be imported from anywhere (layers, oRPC handlers,
 * tests) without creating import cycles.
 *
 * Naming: the class name minus a trailing `Service` (`MemoryMeta` for
 * `MemoryMetaService`); classes without that suffix, or whose bare name would
 * collide with the exported class, take a `Tag` suffix (`ConfigTag`). Ids are
 * `"xum/<Name>"`.
 */
import { Context } from "effect";
import type {
  Config,
  FileLeaseManager,
  ProvidersConfigStore,
  SecretsStore,
  WorkspaceSessionLocator,
} from "@/node/config";
import type { AgentPluginInstallService } from "@/node/services/agentPlugins/installService";
import type { AgentStatusService } from "@/node/services/agentStatusService";
import type { AIService } from "@/node/services/aiService";
import type { AnalyticsService } from "@/node/services/analytics/analyticsService";
import type { BackgroundProcessManager } from "@/node/services/backgroundProcessManager";
import type { BackupService } from "@/node/services/backup/backupService";
import type { AgentBrowserSessionDiscoveryService } from "@/node/services/browser/AgentBrowserSessionDiscoveryService";
import type { BrowserBridgeServer } from "@/node/services/browser/BrowserBridgeServer";
import type { BrowserBridgeTokenManager } from "@/node/services/browser/BrowserBridgeTokenManager";
import type { BrowserControlService } from "@/node/services/browser/BrowserControlService";
import type { BrowserSessionStateHub } from "@/node/services/browser/BrowserSessionStateHub";
import type { CoderOauthService } from "@/node/services/coderOauthService";
import type { CoderService } from "@/node/services/coderService";
import type { CodexOauthService } from "@/node/services/codexOauthService";
import type { CopilotOauthService } from "@/node/services/copilotOauthService";
import type { DesktopBridgeServer } from "@/node/services/desktop/DesktopBridgeServer";
import type { DesktopInputCoordinator } from "@/node/services/desktop/DesktopInputCoordinator";
import type { DesktopSessionManager } from "@/node/services/desktop/DesktopSessionManager";
import type { DesktopTokenManager } from "@/node/services/desktop/DesktopTokenManager";
import type { DevToolsService } from "@/node/services/devToolsService";
import type { EditorService } from "@/node/services/editorService";
import type { ExperimentsService } from "@/node/services/experimentsService";
import type { ExtensionMetadataService } from "@/node/services/ExtensionMetadataService";
import type { HeartbeatService } from "@/node/services/heartbeatService";
import type { HistoryService } from "@/node/services/historyService";
import type { IdleCompactionService } from "@/node/services/idleCompactionService";
import type { IdleDispatcher } from "@/node/services/idleDispatcher";
import type { InitStateManager } from "@/node/services/initStateManager";
import type { InstructionsService } from "@/node/services/instructionsService";
import type { MCPConfigService } from "@/node/services/mcpConfigService";
import type { McpOauthService } from "@/node/services/mcpOauthService";
import type { MCPServerManager } from "@/node/services/mcpServerManager";
import type { MemoryConsolidationService } from "@/node/services/memoryConsolidationService";
import type { MemoryMetaService } from "@/node/services/memoryMeta";
import type { MemoryService } from "@/node/services/memoryService";
import type { MenuEventService } from "@/node/services/menuEventService";
import type { MuxGatewayOauthService } from "@/node/services/muxGatewayOauthService";
import type { MuxGovernorOauthService } from "@/node/services/muxGovernorOauthService";
import type { PolicyService } from "@/node/services/policyService";
import type { ProjectService } from "@/node/services/projectService";
import type { ProviderService } from "@/node/services/providerService";
import type { QuickJSRuntimeFactory } from "@/node/services/ptc/quickjsRuntime";
import type { PTYService } from "@/node/services/ptyService";
import type { RefineService } from "@/node/services/refinement/refineService";
import type { ServerAuthService } from "@/node/services/serverAuthService";
import type { ServerService } from "@/node/services/serverService";
import type { SessionTimingService } from "@/node/services/sessionTimingService";
import type { SessionUsageService } from "@/node/services/sessionUsageService";
import type { SshPromptService } from "@/node/services/sshPromptService";
import type { StreamManager } from "@/node/services/streamManager";
import type { TaskService } from "@/node/services/taskService";
import type { TelemetryService } from "@/node/services/telemetryService";
import type { TerminalAttentionStore } from "@/node/services/terminalAttentionStore";
import type { TerminalService } from "@/node/services/terminalService";
import type { TimelineService } from "@/node/services/timelineService";
import type { TokenizerService } from "@/node/services/tokenizerService";
import type { TurnRequestBuilderBindings } from "@/node/services/turnRequestBuilder";
import type { UpdateService } from "@/node/services/updateService";
import type { VoiceService } from "@/node/services/voiceService";
import type { WindowService } from "@/node/services/windowService";
import type { WorkspaceGoalService } from "@/node/services/workspaceGoalService";
import type { WorkspaceLifecycleHooks } from "@/node/services/workspaceLifecycleHooks";
import type { WorkspaceMcpOverridesService } from "@/node/services/workspaceMcpOverridesService";
import type { WorkspaceService } from "@/node/services/workspaceService";
import type { WorkspaceTurnManager } from "@/node/services/workspaceTurnManager";
import type { WorktreeArchiveSnapshotService } from "@/node/services/worktreeArchiveSnapshotService";
import type { AppFiberScopeTag } from "./appFiberScope";
import type { EffectRunnerTag } from "./effectRunner";
import type { CoreOptionsTag } from "./layers/core";

export class ConfigTag extends Context.Service<ConfigTag, Config>()("xum/Config") {}
export class SessionLocatorTag extends Context.Service<
  SessionLocatorTag,
  WorkspaceSessionLocator
>()("xum/SessionLocator") {}
export class ProvidersConfigStoreTag extends Context.Service<
  ProvidersConfigStoreTag,
  ProvidersConfigStore
>()("xum/ProvidersConfigStore") {}
export class SecretsStoreTag extends Context.Service<SecretsStoreTag, SecretsStore>()(
  "xum/SecretsStore"
) {}
export class FileLeaseManagerTag extends Context.Service<FileLeaseManagerTag, FileLeaseManager>()(
  "xum/FileLeaseManager"
) {}

/** Host-local sidecar for user-owned memory metadata (pins + usage stats). */
export class MemoryMeta extends Context.Service<MemoryMeta, MemoryMetaService>()(
  "xum/MemoryMeta"
) {}

// Core service graph (`CoreServices` in coreServices.ts), shared by the desktop
// app and the headless CLI roots. One tag per `CoreServices` field.
export class History extends Context.Service<History, HistoryService>()("xum/History") {}
export class InitStateManagerTag extends Context.Service<InitStateManagerTag, InitStateManager>()(
  "xum/InitStateManager"
) {}
export class Provider extends Context.Service<Provider, ProviderService>()("xum/Provider") {}
export class BackgroundProcessManagerTag extends Context.Service<
  BackgroundProcessManagerTag,
  BackgroundProcessManager
>()("xum/BackgroundProcessManager") {}
export class SessionUsage extends Context.Service<SessionUsage, SessionUsageService>()(
  "xum/SessionUsage"
) {}
export class WorkspaceGoal extends Context.Service<WorkspaceGoal, WorkspaceGoalService>()(
  "xum/WorkspaceGoal"
) {}
export class IdleDispatcherTag extends Context.Service<IdleDispatcherTag, IdleDispatcher>()(
  "xum/IdleDispatcher"
) {}
export class AI extends Context.Service<AI, AIService>()("xum/AI") {}
export class StreamManagerTag extends Context.Service<StreamManagerTag, StreamManager>()(
  "xum/StreamManager"
) {}
export class MCPConfig extends Context.Service<MCPConfig, MCPConfigService>()("xum/MCPConfig") {}
export class MCPServerManagerTag extends Context.Service<MCPServerManagerTag, MCPServerManager>()(
  "xum/MCPServerManager"
) {}
export class ExtensionMetadata extends Context.Service<
  ExtensionMetadata,
  ExtensionMetadataService
>()("xum/ExtensionMetadata") {}
export class Workspace extends Context.Service<Workspace, WorkspaceService>()("xum/Workspace") {}
export class Task extends Context.Service<Task, TaskService>()("xum/Task") {}
export class WorkspaceTurnManagerTag extends Context.Service<
  WorkspaceTurnManagerTag,
  WorkspaceTurnManager
>()("xum/WorkspaceTurnManager") {}
export class Memory extends Context.Service<Memory, MemoryService>()("xum/Memory") {}
export class MemoryConsolidation extends Context.Service<
  MemoryConsolidation,
  MemoryConsolidationService
>()("xum/MemoryConsolidation") {}
/** Shared input gates are available before task/workspace construction (no desktop-session dependency). */
export class DesktopInputCoordinatorTag extends Context.Service<
  DesktopInputCoordinatorTag,
  DesktopInputCoordinator
>()("xum/DesktopInputCoordinator") {}
/** Terminal attention records; built by the core graph for Task/TurnManager (not a `CoreServices` field). */
export class TerminalAttentionStoreTag extends Context.Service<
  TerminalAttentionStoreTag,
  TerminalAttentionStore
>()("xum/TerminalAttentionStore") {}
/** Late-bound collaborators of the turn request builder (a mutable record, filled by wiring). */
export class TurnRequestBuilderBindingsTag extends Context.Service<
  TurnRequestBuilderBindingsTag,
  TurnRequestBuilderBindings
>()("xum/TurnRequestBuilderBindings") {}

// Desktop cross-cutting services that the core graph's options derive from
// (`CrossCuttingLive` in ./layers/desktop.ts).
export class Policy extends Context.Service<Policy, PolicyService>()("xum/Policy") {}
export class Telemetry extends Context.Service<Telemetry, TelemetryService>()("xum/Telemetry") {}
export class Experiments extends Context.Service<Experiments, ExperimentsService>()(
  "xum/Experiments"
) {}
export class SessionTiming extends Context.Service<SessionTiming, SessionTimingService>()(
  "xum/SessionTiming"
) {}
export class Analytics extends Context.Service<Analytics, AnalyticsService>()("xum/Analytics") {}
export class DevTools extends Context.Service<DevTools, DevToolsService>()("xum/DevTools") {}
export class WorkspaceMcpOverrides extends Context.Service<
  WorkspaceMcpOverrides,
  WorkspaceMcpOverridesService
>()("xum/WorkspaceMcpOverrides") {}

// Desktop/server-only services (`DesktopLive` group layers in ./layers/desktop.ts).
// Browser automation bridge.
export class BrowserBridgeTokenManagerTag extends Context.Service<
  BrowserBridgeTokenManagerTag,
  BrowserBridgeTokenManager
>()("xum/BrowserBridgeTokenManager") {}
export class AgentBrowserSessionDiscovery extends Context.Service<
  AgentBrowserSessionDiscovery,
  AgentBrowserSessionDiscoveryService
>()("xum/AgentBrowserSessionDiscovery") {}
export class BrowserControl extends Context.Service<BrowserControl, BrowserControlService>()(
  "xum/BrowserControl"
) {}
export class BrowserSessionStateHubTag extends Context.Service<
  BrowserSessionStateHubTag,
  BrowserSessionStateHub
>()("xum/BrowserSessionStateHub") {}
export class BrowserBridgeServerTag extends Context.Service<
  BrowserBridgeServerTag,
  BrowserBridgeServer
>()("xum/BrowserBridgeServer") {}
// Desktop companion bridge.
export class DesktopSessionManagerTag extends Context.Service<
  DesktopSessionManagerTag,
  DesktopSessionManager
>()("xum/DesktopSessionManager") {}
export class DesktopTokenManagerTag extends Context.Service<
  DesktopTokenManagerTag,
  DesktopTokenManager
>()("xum/DesktopTokenManager") {}
export class DesktopBridgeServerTag extends Context.Service<
  DesktopBridgeServerTag,
  DesktopBridgeServer
>()("xum/DesktopBridgeServer") {}
// Terminal, editor and token budgeting.
export class PTY extends Context.Service<PTY, PTYService>()("xum/PTY") {}
export class Terminal extends Context.Service<Terminal, TerminalService>()("xum/Terminal") {}
export class Editor extends Context.Service<Editor, EditorService>()("xum/Editor") {}
export class Tokenizer extends Context.Service<Tokenizer, TokenizerService>()("xum/Tokenizer") {}
export class Instructions extends Context.Service<Instructions, InstructionsService>()(
  "xum/Instructions"
) {}
// Leaves and the remaining desktop services.
/** `WindowTag`: the bare name would shadow the DOM `Window` global. */
export class WindowTag extends Context.Service<WindowTag, WindowService>()("xum/Window") {}
export class SshPrompt extends Context.Service<SshPrompt, SshPromptService>()("xum/SshPrompt") {}
export class QuickJSRuntimeFactoryTag extends Context.Service<
  QuickJSRuntimeFactoryTag,
  QuickJSRuntimeFactory
>()("xum/QuickJSRuntimeFactory") {}
export class Backup extends Context.Service<Backup, BackupService>()("xum/Backup") {}
export class AgentPluginInstall extends Context.Service<
  AgentPluginInstall,
  AgentPluginInstallService
>()("xum/AgentPluginInstall") {}
export class Project extends Context.Service<Project, ProjectService>()("xum/Project") {}
export class Update extends Context.Service<Update, UpdateService>()("xum/Update") {}
export class Server extends Context.Service<Server, ServerService>()("xum/Server") {}
export class MenuEvent extends Context.Service<MenuEvent, MenuEventService>()("xum/MenuEvent") {}
export class Voice extends Context.Service<Voice, VoiceService>()("xum/Voice") {}
/** The module singleton `coderService`, provided under a tag like every other field. */
export class Coder extends Context.Service<Coder, CoderService>()("xum/Coder") {}
export class ServerAuth extends Context.Service<ServerAuth, ServerAuthService>()(
  "xum/ServerAuth"
) {}
export class WorkspaceLifecycleHooksTag extends Context.Service<
  WorkspaceLifecycleHooksTag,
  WorkspaceLifecycleHooks
>()("xum/WorkspaceLifecycleHooks") {}
export class WorktreeArchiveSnapshot extends Context.Service<
  WorktreeArchiveSnapshot,
  WorktreeArchiveSnapshotService
>()("xum/WorktreeArchiveSnapshot") {}
// OAuth flows (all need the WindowService for the browser hand-off).
export class McpOauth extends Context.Service<McpOauth, McpOauthService>()("xum/McpOauth") {}
export class MuxGatewayOauth extends Context.Service<MuxGatewayOauth, MuxGatewayOauthService>()(
  "xum/MuxGatewayOauth"
) {}
export class MuxGovernorOauth extends Context.Service<MuxGovernorOauth, MuxGovernorOauthService>()(
  "xum/MuxGovernorOauth"
) {}
export class CodexOauth extends Context.Service<CodexOauth, CodexOauthService>()(
  "xum/CodexOauth"
) {}
export class CoderOauth extends Context.Service<CoderOauth, CoderOauthService>()(
  "xum/CoderOauth"
) {}
export class CopilotOauth extends Context.Service<CopilotOauth, CopilotOauthService>()(
  "xum/CopilotOauth"
) {}
// Clock-driven workers and the timeline/refine pair they record into.
export class IdleCompaction extends Context.Service<IdleCompaction, IdleCompactionService>()(
  "xum/IdleCompaction"
) {}
export class Heartbeat extends Context.Service<Heartbeat, HeartbeatService>()("xum/Heartbeat") {}
export class Timeline extends Context.Service<Timeline, TimelineService>()("xum/Timeline") {}
export class Refine extends Context.Service<Refine, RefineService>()("xum/Refine") {}
export class AgentStatus extends Context.Service<AgentStatus, AgentStatusService>()(
  "xum/AgentStatus"
) {}

/** The process's config stores (`ConfigStores`), one tag per store. */
export type StoreTags =
  | ConfigTag
  | SessionLocatorTag
  | ProvidersConfigStoreTag
  | SecretsStoreTag
  | FileLeaseManagerTag;

/**
 * The runtime seams provided at the base of every graph (`./effectRunner.ts`,
 * `./appFiberScope.ts`); their tags live next to their layers.
 */
export type RuntimeSeamTags = EffectRunnerTag | AppFiberScopeTag;

/**
 * Everything `CoreLive` (./layers/core.ts) provides: every `CoreServices`
 * field plus the graph-internal `TerminalAttentionStore`.
 */
export type CoreTags =
  | History
  | InitStateManagerTag
  | Provider
  | BackgroundProcessManagerTag
  | SessionUsage
  | WorkspaceGoal
  | IdleDispatcherTag
  | AI
  | StreamManagerTag
  | MCPConfig
  | MCPServerManagerTag
  | ExtensionMetadata
  | Workspace
  | Task
  | WorkspaceTurnManagerTag
  | Memory
  | MemoryMeta
  | MemoryConsolidation
  | DesktopInputCoordinatorTag
  | TerminalAttentionStoreTag
  | TurnRequestBuilderBindingsTag;

/**
 * Everything a headless CLI root (`createCoreServices`) provides; the CLI
 * default `WorkspaceMcpOverrides` stands in for the desktop's cross-cutting one.
 */
export type CoreRootTags =
  | StoreTags
  | RuntimeSeamTags
  | CoreOptionsTag
  | WorkspaceMcpOverrides
  | CoreTags;

/** The desktop cross-cutting services provided by `CrossCuttingLive`. */
export type CrossCuttingTags =
  | Policy
  | Telemetry
  | Experiments
  | SessionTiming
  | Analytics
  | DevTools
  | WorkspaceMcpOverrides;

/** The desktop-only services provided by the `DesktopLive` group layers, by group. */
export type BrowserTags =
  | BrowserBridgeTokenManagerTag
  | AgentBrowserSessionDiscovery
  | BrowserControl
  | BrowserSessionStateHubTag
  | BrowserBridgeServerTag;
export type DesktopBridgeTags =
  | DesktopSessionManagerTag
  | DesktopTokenManagerTag
  | DesktopBridgeServerTag;
export type TerminalEditorTags = PTY | Terminal | Editor | Tokenizer | Instructions;
export type MiscDesktopTags =
  | WindowTag
  | SshPrompt
  | QuickJSRuntimeFactoryTag
  | Backup
  | AgentPluginInstall
  | Project
  | Update
  | Server
  | MenuEvent
  | Voice
  | Coder
  | ServerAuth
  | WorkspaceLifecycleHooksTag
  | WorktreeArchiveSnapshot;
export type OauthTags =
  | McpOauth
  | MuxGatewayOauth
  | MuxGovernorOauth
  | CodexOauth
  | CoderOauth
  | CopilotOauth;
export type WorkerTags = IdleCompaction | Heartbeat | Timeline | Refine | AgentStatus;
export type DesktopTags =
  | BrowserTags
  | DesktopBridgeTags
  | TerminalEditorTags
  | MiscDesktopTags
  | OauthTags
  | WorkerTags;

/** Every service the desktop/server app graph (`AppLive`) provides. */
export type AppTags = CoreRootTags | CrossCuttingTags | DesktopTags;

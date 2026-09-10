/**
 * Core service graph shared by `xum run`/`xum workflow` (CLI) and
 * `ServiceContainer` (desktop): the options every root passes in and the
 * plain service bundle every root hands out.
 *
 * The graph itself is built by the staged Effect Layers in
 * `di/layers/core.ts` (`CoreLive`, Effect migration Phase 11) — one adapter
 * layer per constructor, composed in explicit dependency stages, with the
 * setter/listener wiring replayed by `CoreWiringLive`. The roots are
 * `createCoreServices` (`./coreServicesRoot.ts`, CLI) and `AppLive`
 * (`di/layers/app.ts`, desktop).
 */

import type {
  Config,
  ConfigStores,
  FileLeaseManager,
  ProvidersConfigStore,
  SecretsStore,
  WorkspaceSessionLocator,
} from "@/node/config";
import type { HistoryService } from "@/node/services/historyService";
import type { IdleDispatcher } from "@/node/services/idleDispatcher";
import type { InitStateManager } from "@/node/services/initStateManager";
import type { ProviderService } from "@/node/services/providerService";
import type { AIService } from "@/node/services/aiService";
import type { TurnRequestBuilderBindings } from "@/node/services/turnRequestBuilder";
import type { StreamManager } from "@/node/services/streamManager";
import type { BackgroundProcessManager } from "@/node/services/backgroundProcessManager";
import type { SessionUsageService } from "@/node/services/sessionUsageService";
import type {
  WorkspaceGoalService,
  GoalLifecycleAnalyticsSink,
  WorkspaceGoalServiceOptions,
} from "@/node/services/workspaceGoalService";
import type { MCPConfigService } from "@/node/services/mcpConfigService";
import type { MCPServerManager, MCPServerManagerOptions } from "@/node/services/mcpServerManager";
import type { ExtensionMetadataService } from "@/node/services/ExtensionMetadataService";
import type { WorkspaceService } from "@/node/services/workspaceService";
import type { TaskService } from "@/node/services/taskService";
import type { WorkspaceTurnManager } from "@/node/services/workspaceTurnManager";
import type { PolicyService } from "@/node/services/policyService";
import type { TelemetryService } from "@/node/services/telemetryService";
import type { ExperimentsService } from "@/node/services/experimentsService";
import type { MemoryService } from "@/node/services/memoryService";
import type { MemoryConsolidationService } from "@/node/services/memoryConsolidationService";
import type { MemoryMetaService } from "@/node/services/memoryMeta";
import type { SessionTimingService } from "@/node/services/sessionTimingService";
import type { DevToolsService } from "@/node/services/devToolsService";

export interface CoreServicesOptions {
  config: Config;
  sessionLocator?: WorkspaceSessionLocator;
  providersConfigStore?: ProvidersConfigStore;
  secretsStore?: SecretsStore;
  fileLeaseManager?: FileLeaseManager;
  extensionMetadataPath: string;
  /** Overrides config for MCPConfigService; CLI passes its persistent realConfig. */
  mcpConfig?: Config;
  mcpServerManagerOptions?: MCPServerManagerOptions;
  /** Optional cross-cutting services (desktop creates before core services). */
  policyService?: PolicyService;
  telemetryService?: TelemetryService;
  analyticsService?: GoalLifecycleAnalyticsSink;
  goalServiceOptions?: WorkspaceGoalServiceOptions;
  experimentsService?: ExperimentsService;
  sessionTimingService?: SessionTimingService;
  devToolsService?: DevToolsService;
}

/**
 * The graph's inputs other than the stores (`CoreOptionsTag` in
 * `di/layers/core.ts`). The optional cross-cutting services stay optional here
 * (present in the desktop graph, absent in CLI roots), so core constructors
 * see exactly the arguments they saw before.
 */
export type CoreOptions = Omit<CoreServicesOptions, keyof ConfigStores>;

export interface CoreServices {
  historyService: HistoryService;
  initStateManager: InitStateManager;
  providerService: ProviderService;
  backgroundProcessManager: BackgroundProcessManager;
  sessionUsageService: SessionUsageService;
  workspaceGoalService: WorkspaceGoalService;
  /**
   * Shared with HeartbeatService (when the desktop ServiceContainer wires it
   * up) so an active goal naturally suppresses background heartbeats via
   * priority dispatch ordering.
   */
  idleDispatcher: IdleDispatcher;
  aiService: AIService;
  streamManager: StreamManager;
  mcpConfigService: MCPConfigService;
  mcpServerManager: MCPServerManager;
  extensionMetadata: ExtensionMetadataService;
  workspaceService: WorkspaceService;
  taskService: TaskService;
  workspaceTurnManager: WorkspaceTurnManager;
  memoryService: MemoryService;
  memoryMetaService: MemoryMetaService;
  memoryConsolidationService: MemoryConsolidationService;
  turnRequestBuilderBindings: TurnRequestBuilderBindings;
}

import type { IJSRuntimeFactory } from "@/node/services/ptc/runtime";
import type { IncomingHttpHeaders } from "http";
import type {
  Config,
  FileLeaseManager,
  ProvidersConfigStore,
  SecretsStore,
  WorkspaceSessionLocator,
} from "@/node/config";
import type { AIService } from "@/node/services/aiService";
import type { HistoryService } from "@/node/services/historyService";
import type { InitStateManager } from "@/node/services/initStateManager";
import type { StreamManager } from "@/node/services/streamManager";
import type { ProjectService } from "@/node/services/projectService";
import type { WorkspaceService } from "@/node/services/workspaceService";
import type { MuxGatewayOauthService } from "@/node/services/muxGatewayOauthService";
import type { MuxGovernorOauthService } from "@/node/services/muxGovernorOauthService";
import type { CodexOauthService } from "@/node/services/codexOauthService";
import type { CoderOauthService } from "@/node/services/coderOauthService";
import type { CopilotOauthService } from "@/node/services/copilotOauthService";
import type { BackupService } from "@/node/services/backup/backupService";
import type { ProviderService } from "@/node/services/providerService";
import type { TerminalService } from "@/node/services/terminalService";
import type { EditorService } from "@/node/services/editorService";
import type { WindowService } from "@/node/services/windowService";
import type { UpdateService } from "@/node/services/updateService";
import type { TokenizerService } from "@/node/services/tokenizerService";
import type { ServerService } from "@/node/services/serverService";
import type { MenuEventService } from "@/node/services/menuEventService";
import type { VoiceService } from "@/node/services/voiceService";
import type { MCPConfigService } from "@/node/services/mcpConfigService";
import type { McpOauthService } from "@/node/services/mcpOauthService";
import type { ExperimentsService } from "@/node/services/experimentsService";
import type { MemoryService } from "@/node/services/memoryService";
import type { MemoryConsolidationService } from "@/node/services/memoryConsolidationService";
import type { MemoryMetaService } from "@/node/services/memoryMeta";
import type { RefineService } from "@/node/services/refinement/refineService";
import type { WorkspaceMcpOverridesService } from "@/node/services/workspaceMcpOverridesService";
import type { MCPServerManager } from "@/node/services/mcpServerManager";
import type { AgentPluginInstallService } from "@/node/services/agentPlugins/installService";
import type { TelemetryService } from "@/node/services/telemetryService";
import type { SessionTimingService } from "@/node/services/sessionTimingService";
import type { TimelineService } from "@/node/services/timelineService";
import type { SessionUsageService } from "@/node/services/sessionUsageService";
import type { InstructionsService } from "@/node/services/instructionsService";
import type { WorkspaceGoalService } from "@/node/services/workspaceGoalService";
import type { TaskService } from "@/node/services/taskService";
import type { BrowserBridgeServer } from "@/node/services/browser/BrowserBridgeServer";
import type { AgentBrowserSessionDiscoveryService } from "@/node/services/browser/AgentBrowserSessionDiscoveryService";
import type { BrowserBridgeTokenManager } from "@/node/services/browser/BrowserBridgeTokenManager";
import type { BrowserControlService } from "@/node/services/browser/BrowserControlService";
import type { BrowserSessionStateHub } from "@/node/services/browser/BrowserSessionStateHub";
import type { DevToolsService } from "@/node/services/devToolsService";
import type { PolicyService } from "@/node/services/policyService";
import type { CoderService } from "@/node/services/coderService";
import type { ServerAuthService } from "@/node/services/serverAuthService";
import type { SshPromptService } from "@/node/services/sshPromptService";
import type { AnalyticsService } from "@/node/services/analytics/analyticsService";
import type { DesktopBridgeServer } from "@/node/services/desktop/DesktopBridgeServer";
import type { DesktopSessionManager } from "@/node/services/desktop/DesktopSessionManager";
import type { DesktopTokenManager } from "@/node/services/desktop/DesktopTokenManager";
import type { WithEffectContext } from "@orpc/experimental-effect";
import type { OrpcEffectServices } from "@/node/orpc/effectContext";

/**
 * `WithEffectContext` adds the `"effect/context"` key carrying the Effect
 * services available to Effect-native handlers (the app runtime's built
 * service context, `ServiceContainer.runtime.context`).
 */
export interface ORPCContext extends WithEffectContext<OrpcEffectServices> {
  config: Config;
  sessionLocator: WorkspaceSessionLocator;
  providersConfigStore: ProvidersConfigStore;
  secretsStore: SecretsStore;
  fileLeaseManager: FileLeaseManager;
  aiService: AIService;
  historyService: HistoryService;
  streamManager: StreamManager;
  initStateManager: InitStateManager;
  projectService: ProjectService;
  workspaceService: WorkspaceService;
  taskService: TaskService;
  providerService: ProviderService;
  muxGatewayOauthService: MuxGatewayOauthService;
  muxGovernorOauthService: MuxGovernorOauthService;
  codexOauthService: CodexOauthService;
  coderOauthService: CoderOauthService;
  copilotOauthService: CopilotOauthService;
  backupService: BackupService;
  terminalService: TerminalService;
  editorService: EditorService;
  windowService: WindowService;
  updateService: UpdateService;
  tokenizerService: TokenizerService;
  serverService: ServerService;
  menuEventService: MenuEventService;
  voiceService: VoiceService;
  mcpConfigService: MCPConfigService;
  mcpOauthService: McpOauthService;
  workspaceMcpOverridesService: WorkspaceMcpOverridesService;
  mcpServerManager: MCPServerManager;
  agentPluginInstallService: AgentPluginInstallService;
  sessionTimingService: SessionTimingService;
  timelineService: TimelineService;
  telemetryService: TelemetryService;
  experimentsService: ExperimentsService;
  memoryService: MemoryService;
  memoryMetaService: MemoryMetaService;
  memoryConsolidationService: MemoryConsolidationService;
  refineService: RefineService;
  sessionUsageService: SessionUsageService;
  instructionsService: InstructionsService;
  workspaceGoalService: WorkspaceGoalService;
  devToolsService: DevToolsService;
  browserSessionDiscoveryService: AgentBrowserSessionDiscoveryService;
  browserBridgeTokenManager: BrowserBridgeTokenManager;
  browserBridgeServer: BrowserBridgeServer;
  browserControlService: BrowserControlService;
  browserSessionStateHub: BrowserSessionStateHub;
  policyService: PolicyService;
  coderService: CoderService;
  serverAuthService: ServerAuthService;
  sshPromptService: SshPromptService;
  analyticsService: AnalyticsService;
  desktopSessionManager: DesktopSessionManager;
  desktopTokenManager: DesktopTokenManager;
  desktopBridgeServer: DesktopBridgeServer;
  workflowRuntimeFactory: IJSRuntimeFactory;
  headers?: IncomingHttpHeaders;
}

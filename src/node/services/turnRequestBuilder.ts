import { execBuffered } from "@/node/utils/runtime/helpers";
import { shellQuote } from "@/common/utils/shell";
import type { OnStepSettled } from "./streamManager";
import { checkAssembledRequestBudgetForModel } from "./contextBudgetCounting";
import { ContextBudgetExceededError } from "./contextBudgetError";
import { getEffectiveContextLimit } from "@/common/utils/compaction/contextLimit";
import { isAnthropic1MEffectivelyEnabled } from "@/common/utils/ai/providerOptions";
import * as path from "path";
import { resolveXumEnvironmentValue } from "@/common/compat/legacyMux";
import { MEMORY_INTUITION_MAX_USES_PER_TURN } from "@/common/constants/memory";
import {
  resolveHeadlessAgentDefinition,
  resolveHeadlessAgentSettings,
} from "@/node/services/memoryConsolidationService";
import { EXPERIMENT_IDS } from "@/common/constants/experiments";
import assert from "@/common/utils/assert";
import { type LanguageModel, type Tool } from "ai";

import type { ProvidersConfigMap, SendMessageOptions } from "@/common/orpc/types";
import type { Result } from "@/common/types/result";
import { Err, Ok } from "@/common/types/result";
import type { WorkspaceMetadata } from "@/common/types/workspace";
import { projectAutomationDisabled } from "@/node/utils/projectAutomation";

import {
  ADVISOR_DEFAULT_MAX_USES_PER_TURN,
  resolveAdvisorEnabledForAgent,
} from "@/common/constants/advisor";
import type { DebugLlmRequestSnapshot } from "@/common/types/debugLlmRequest";

import type { SendMessageError } from "@/common/types/errors";
import type { GoalRecordV1 } from "@/common/types/goal";
import type { ModelMessage, MuxMessage, MuxMessageMetadata } from "@/common/types/message";
import { createMuxMessage } from "@/common/types/message";
import type { MuxProviderOptions } from "@/common/types/providerOptions";
import { secretsToRecord } from "@/common/types/secrets";
import type { XumToolScope } from "@/common/types/toolScope";
import { getGoalToolAvailability } from "@/common/utils/tools/toolAvailability";
import {
  deriveToolHookConfig,
  getForcedXaiSearchToolNames,
  getToolsForModel,
  type AdvisorStepCaptureRef,
  type MCPPromptRuntime,
  type ToolConfiguration,
} from "@/common/utils/tools/tools";
import type { Config, ProvidersConfigStore, SecretsStore } from "@/node/config";
import { getRuntimeType, getXumEnv } from "@/node/runtime/initHook";
import { type WorkspaceRuntimeContext } from "@/node/runtime/runtimeHelpers";
import { isAgentEffectivelyDisabled } from "@/node/services/agentDefinitions/agentEnablement";
import { prepareWorkspaceRequestHooks } from "./agentPlugins/requestHooks";
import type { RequestAssemblySnapshot } from "./events/eventSpine";
import { resolveAgentPluginsMcpContext } from "@/node/services/agentPlugins/mcpConfig";
import type { BackgroundProcessManager } from "@/node/services/backgroundProcessManager";
import { isRlmModeEnabled } from "@/node/services/branchSummary";
import type { PolicyService } from "@/node/services/policyService";
import type { ProviderService } from "@/node/services/providerService";
import { mergeMultiProjectSecrets } from "@/node/services/utils/multiProjectSecrets";
import { type DurableEventJournal } from "@/node/utils/journal/durableEventJournal";
import type { InitStateManager } from "./initStateManager";
import { runLanguageModelCleanup } from "./languageModelCleanup";
import { log } from "./log";
import type { StreamManager } from "./streamManager";
import {
  type ModelFallbackOptions,
  type StreamTextOnChunk,
  type TurnCompletion,
  type TurnExecutionOptions,
  type TurnStreamHandle,
} from "./streamManager";
import { emitTurnEnvelope } from "./turnEnvelope";

import { normalizeToCanonical } from "@/common/utils/ai/models";
import { extractChunkDeltaText } from "@/common/utils/ai/streamChunks";
import { createDisplayUsage } from "@/common/utils/tokens/displayUsage";
import { getTotalCost, sumUsageHistory } from "@/common/utils/tokens/usageAggregator";
import type { DesktopSessionManager } from "@/node/services/desktop/DesktopSessionManager";
import type { DevToolsService } from "@/node/services/devToolsService";
import type { ExperimentsService } from "@/node/services/experimentsService";
import { findWorkspaceEntry, resolveWorkspaceModelFallbackChain } from "@/node/services/taskUtils";
import type { TelemetryService } from "@/node/services/telemetryService";
import {
  effectiveAdditionalSystemContext,
  mergeAdditionalSystemInstructions,
  readAdditionalSystemContext,
} from "./additionalSystemContext";
import type { HistoryService } from "./historyService";
import type { SessionUsageService } from "./sessionUsageService";
import { readToolInstructions } from "./systemMessage";
import { createAssistantMessageId } from "./utils/messageIds";
import { createErrorEvent, formatSendMessageError } from "./utils/sendMessageError";

import type { ProvidersConfig } from "@/common/config/schemas/providersConfig";
import {
  coderGatewayWireProtocol,
  resolveCoderWireCanonicalModel,
} from "@/common/constants/coderOAuth";
import { PROVIDER_DEFINITIONS, type ProviderName } from "@/common/constants/providers";
import type { WorkspaceMCPOverrides } from "@/common/types/mcp";
import { isExecLikeEditingCapableInResolvedChain } from "@/common/utils/agentTools";
import { resolveModelParameterOverrides } from "@/common/utils/ai/modelParameterOverrides";
import {
  buildProviderOptions,
  buildRequestHeaders,
  resolveProviderOptionsNamespaceKey,
} from "@/common/utils/ai/providerOptions";
import { uniqueSuffix } from "@/common/utils/hasher";
import { isPlainObject } from "@/common/utils/isPlainObject";
import { getProjects, isMultiProject } from "@/common/utils/multiProject";
import { resolveCoderGatewayMetadataModel } from "@/common/utils/providers/coderGatewayMetadata";
import {
  customProviderWireOrigin,
  isCustomProviderConfig,
} from "@/common/utils/providers/customProviders";
import type { MCPServerManager, MCPWorkspaceStats } from "@/node/services/mcpServerManager";
import { type MemoryService, type MemorySessionContext } from "@/node/services/memoryService";
import { sharedWorkspaceMemoryPeerSessionDirs } from "@/node/services/memoryWorkspaceOwner";
import { memoryScopeContextFromToolConfig } from "@/node/services/tools/memory";
import type { TaskService } from "@/node/services/taskService";
import { READ_ONLY_ACCESS, resolveMemoryAccessPolicy } from "@/node/services/tools/memory";
import { isWorkspaceTrustedForSharedExecution } from "@/node/services/utils/workspaceTrust";
import type { WorkspaceMcpOverridesService } from "./workspaceMcpOverridesService";

import { MULTI_PROJECT_CONFIG_KEY } from "@/common/constants/multiProject";
import {
  THINKING_LEVEL_OFF,
  type OpenAIReasoningMode,
  type ThinkingLevel,
} from "@/common/types/thinking";
import { mergeGoalDefaults } from "@/common/utils/goals/resolveGoalSetIntent";
import {
  enforceThinkingPolicy,
  isXaiGrokFastVariantSwap,
  lookupMinThinkingLevelOverride,
  resolveEffectiveThinkingLevel,
  resolveMinimumThinkingLevel,
} from "@/common/utils/thinking/policy";
import { DEFAULT_GOAL_DEFAULTS, normalizeGoalDefaults } from "@/constants/goals";
import type {
  RebuildFirstStepForThinkingLevel,
  RebuildProviderOptionsForThinkingLevel,
} from "@/node/services/thinkingOverride";

import { isTerminalWorkflowRunStatus } from "@/common/types/workflow";
import { getErrorMessage } from "@/common/utils/errors";
import {
  normalizeUsageModelKey,
  resolveModelForMetadata,
} from "@/common/utils/providers/modelEntries";
import {
  computeActiveToolNames,
  prepareToolSearch,
  rebuildToolSearchState,
  seedToolSearchActivationsFromMessages,
  TOOL_SEARCH_TOOL_NAME,
  type ToolSearchRuntime,
} from "@/common/utils/tools/toolCatalog";
import {
  buildWorkflowResultContextMessage,
  WORKFLOW_RESULT_METADATA_TYPE,
} from "@/common/utils/workflowRunMessages";
import { resolveSkillStorageContext } from "@/node/services/agentSkills/skillStorageContext";
import { eventSpine, type RequestAssembleContext } from "@/node/services/events/eventSpine";
import { QuickJSRuntimeFactory } from "@/node/services/ptc/quickjsRuntime";
import type { PTCEventWithParent } from "@/node/services/tools/code_execution";
import { createKernelFileLoader } from "@/node/services/tools/kernelFileLoad";
import { WorkflowRunStore } from "@/node/services/workflows/WorkflowRunStore";
import { resolveWorkflowScript } from "@/node/services/workflows/workflowScriptResolver";
import {
  WorkflowService,
  type WorkflowRunStatusChangedEvent,
} from "@/node/services/workflows/WorkflowService";
import {
  DEFAULT_WORKFLOW_AGENT_ID,
  WorkflowTaskServiceAdapter,
} from "@/node/services/workflows/WorkflowTaskServiceAdapter";
import { getTokenizerForModel } from "@/node/utils/main/tokenizer";
import { isWorkspaceProjectTrusted } from "@/node/utils/projectTrust";
import { getAnthropicCacheTtl } from "@/common/utils/ai/cacheStrategy";
import { getLegacyModeForAgentMetadata, resolveAgentForStream } from "./agentResolution";
import { DEVTOOLS_RUN_METADATA_ID_HEADER } from "./devToolsHeaderCapture";
import type { OauthServiceBindings, ProviderModelFactory } from "./providerModelFactory";
import {
  assemblePromptPayload,
  buildPlanInstructions,
  buildStreamSystemContext,
  formatMcpWarningPrefix,
  prepareProviderRequestMessages,
  removeIntuitionGuidance,
} from "./turnContextAssembler";
export { prepareProviderRequestMessages };
import {
  simulateContextLimitError,
  simulateToolPolicyNoop,
  type SimulationContext,
} from "./streamSimulation";
import {
  applyToolPolicyAndExperiments,
  captureMcpToolTelemetry,
  resolveBackendGatedPtcExperiments,
} from "./toolAssembly";

const STREAM_STARTUP_DIAGNOSTIC_THRESHOLD_MS = 1_000;

export function resolveMuxProjectRootForHostFs(
  metadata: WorkspaceMetadata,
  workspacePath: string
): string {
  const runtimeType = metadata.runtimeConfig.type;
  return runtimeType === "ssh" || runtimeType === "docker" ? metadata.projectPath : workspacePath;
}

export function resolveXumToolScope(
  config: Config,
  metadata: WorkspaceMetadata,
  workspacePath: string,
  checkoutRoot?: string | null
): XumToolScope {
  const projectConfig = config.loadConfigOrDefault().projects.get(metadata.projectPath);
  if (
    projectConfig?.projectKind === "system" &&
    metadata.projectPath !== MULTI_PROJECT_CONFIG_KEY
  ) {
    return { type: "global", xumHome: config.rootDir };
  }
  const runtimeType = metadata.runtimeConfig.type;
  return {
    type: "project",
    xumHome: config.rootDir,
    projectRoot: resolveMuxProjectRootForHostFs(metadata, workspacePath),
    projectStorageAuthority:
      runtimeType === "ssh" || runtimeType === "docker" ? "runtime" : "host-local",
    ...(checkoutRoot != null ? { checkoutRoot } : {}),
  };
}

import type { PostCompactionAttachment } from "@/common/types/attachment";
import type { ErrorEvent } from "@/common/types/stream";
import { isMemoryToolDisabled, type ToolPolicy } from "@/common/utils/tools/toolPolicy";
import type { FileState } from "@/node/services/agentSession";
import type { ActiveTurnThinkingOverride } from "@/node/services/thinkingOverride";
import type { WorkspaceGoalService } from "@/node/services/workspaceGoalService";

/** Options used to prepare and execute a turn. */
export interface StreamMessageOptions {
  messages: MuxMessage[];
  workspaceId: string;
  modelString: string;
  thinkingLevel?: ThinkingLevel;
  /** OpenAI pro reasoning mode; delivered via provider options (inert for unsupported models). */
  reasoningMode?: OpenAIReasoningMode;
  toolPolicy?: ToolPolicy;
  abortSignal?: AbortSignal;
  /** Live workspace scratchpad snapshot from the renderer; when present it wins over disk. */
  additionalSystemContext?: string;
  additionalSystemInstructions?: string;
  maxOutputTokens?: number;
  muxProviderOptions?: MuxProviderOptions;
  /** Internal-only flag for Copilot billing attribution; never sourced from IPC schemas. */
  agentInitiated?: boolean;
  agentId?: string;
  /** See SendMessageOptionsSchema.strictAgentResolution: explicit-agent sends fail loudly instead of falling back to exec. */
  strictAgentResolution?: SendMessageOptions["strictAgentResolution"];
  /** ACP prompt correlation id used to match stream events to a specific request. */
  acpPromptId?: string;
  /** Invoked with each fatal pre-start error event this call emits before returning Err. */
  onPreStartError?: (event: ErrorEvent) => void;
  /** Synchronous registration of the facade's handleless startup notification identity. */
  onStreamStarting?: (messageId: string) => void;
  /** Tool names that should be delegated back to ACP clients for this request. */
  delegatedToolNames?: string[];
  recordFileState?: (filePath: string, state: FileState) => Promise<void>;
  postCompactionAttachments?: PostCompactionAttachment[] | null;
  /**
   * Resolver for the session-segment memory context (memory experiment):
   * index snapshot for the memory tool description + hot-memories block.
   * AgentSession caches the result per model/session segment because hot-memory
   * selection is token-budgeted with the active model tokenizer. A callback
   * (not a pre-resolved value) because it must be computed after
   * runtime.ensureReady(): project-scope listing on a
   * stopped Docker/remote workspace would otherwise cache an empty/partial
   * context for the whole segment.
   */
  resolveMemoryContext?: (
    modelString: string,
    options?: { includeHotMemories?: boolean }
  ) => Promise<MemorySessionContext | undefined>;
  experiments?: SendMessageOptions["experiments"];
  allowAgentSetGoal?: boolean;
  workspaceGoalService?: WorkspaceGoalService;
  /** Candidate admission previews tool availability only; executions keep the real goal service. */
  prospectiveGoalStatusForToolAvailability?: GoalRecordV1["status"] | null;
  disableWorkspaceAgents?: boolean;
  hasQueuedMessages?: (dispatchMode?: "tool-end" | "turn-end") => boolean;
  onStepSettled?: OnStepSettled;
  /** Internal rollover admission contract; never serialized into send options/history. */
  requestAssemblySnapshot?: RequestAssemblySnapshot;
  muxMetadata?: MuxMessageMetadata;
  openaiTruncationModeOverride?: "auto" | "disabled";
  /**
   * Model floor already resolved by AgentSession (config.json
   * minThinkingLevelByModel → resolveMinimumThinkingLevel). Passed down so
   * mid-turn overrides clamp against the same floor as the send-time level;
   * internal callers may omit it (re-resolved from defaults).
   */
  minThinkingLevel?: ThinkingLevel;
  /**
   * Session-owned per-turn holder for mid-turn thinking-level overrides.
   * When absent (compaction, sub-agent paths), the feature is inert for the
   * stream. See src/node/services/thinkingOverride.ts.
   */
  activeTurnThinkingOverride?: ActiveTurnThinkingOverride;
}

// Exported for the replay builder: fallback requests append the refusal's
// partial continuation the same way production does.
export function replaceOrAppendMessageById(
  messages: MuxMessage[],
  replacement: MuxMessage
): MuxMessage[] {
  const index = messages.findIndex((message) => message.id === replacement.id);
  if (index === -1) {
    return [...messages, replacement];
  }

  const next = [...messages];
  next[index] = replacement;
  return next;
}

// ---------------------------------------------------------------------------
// streamMessage options
// ---------------------------------------------------------------------------

/**
 * Recursively merge user-provided provider extras under Xum-built provider options.
 * Xum values win on leaf conflicts; both sides' non-conflicting nested fields are preserved.
 */
function mergeProviderExtrasUnderMux(
  providerExtras: Record<string, unknown>,
  muxProviderNamespace: Record<string, unknown>
): Record<string, unknown> {
  const merged: Record<string, unknown> = { ...providerExtras };

  for (const [key, muxValue] of Object.entries(muxProviderNamespace)) {
    const extraValue = merged[key];
    merged[key] =
      isPlainObject(extraValue) && isPlainObject(muxValue)
        ? mergeProviderExtrasUnderMux(extraValue, muxValue)
        : muxValue;
  }

  return merged;
}

const WORKFLOW_CONTINUATION_RETRY_DELAY_MS = 1_000;
const WORKSPACE_BUSY_IDLE_ONLY_SEND_MESSAGE = "Workspace is busy; idle-only send was skipped.";

function isWorkspaceBusyIdleOnlySend(error: SendMessageError): boolean {
  return error.type === "unknown" && error.raw.includes(WORKSPACE_BUSY_IDLE_ONLY_SEND_MESSAGE);
}

function waitForWorkflowContinuationRetry(): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, WORKFLOW_CONTINUATION_RETRY_DELAY_MS));
}

/**
 * Pin the factory-resolved Coder instance type into a providers-config view.
 *
 * Every request builder (message prep, options, headers, overrides,
 * capability lookups, mid-turn rebuild closures) consumes ONE snapshot per
 * request instead of re-reading ProviderService. Pinning closes the residual
 * race between the factory's own config read and this capture: a concurrent
 * authoritative catalog refresh that rewrites the selected instance's type
 * would otherwise make the builders resolve a different wire than the
 * already-created SDK model. additionalProviders is the highest-precedence
 * metadata source (resolveCoderGatewayProvider consults it first), so the
 * pinned entry wins over any concurrently rewritten discovered metadata.
 * Pinning keys on the RAW selection's instance (coderSelectedInstance), not
 * on the effective route: a coder: selection that FELL BACK to a direct
 * provider still has builders resolving the raw model string (capability
 * lookups, override identity, option/header rebuilds), and a concurrent
 * retag between the factory's read and this capture would otherwise hand
 * the already-created fallback model another type's options. Non-coder
 * selections, shadowed prefixes, and unknown instances have no snapshot and
 * keep the view untouched.
 */
function pinCoderInstanceProvidersConfig(
  view: ProvidersConfigMap,
  rawModelString: string,
  instance: { name: string; type: string } | undefined
): ProvidersConfigMap {
  if (!instance || !rawModelString.startsWith("coder:")) {
    return view;
  }
  return {
    ...view,
    coder: {
      ...(view.coder ?? { apiKeySet: false, isEnabled: true, isConfigured: true }),
      additionalProviders: [{ name: instance.name, type: instance.type }],
    },
  };
}

/**
 * Raw providers.jsonc counterpart of pinCoderInstanceProvidersConfig for
 * consumers that need file-shaped config (modelParameters lookups). Same
 * rationale: additionalProviders is the highest-precedence metadata source,
 * so pinning the factory-resolved instance there keeps metadata-dependent
 * decisions (mappedToModel aliases, sampling gates) on the type the SDK
 * model was created for.
 */
function pinCoderInstanceRawProvidersConfig(
  view: ProvidersConfig | null,
  rawModelString: string,
  instance: { name: string; type: string } | undefined
): ProvidersConfig | null {
  if (!view || !instance || !rawModelString.startsWith("coder:")) {
    return view;
  }
  return {
    ...view,
    coder: {
      ...(view.coder ?? {}),
      additionalProviders: [{ name: instance.name, type: instance.type }],
    },
  };
}

/** Shared assembly path for primary, fallback, and thinking-rebuild provider attempts. */
export async function assembleBudgetCheckedPromptPayload(
  options: Parameters<typeof assemblePromptPayload>[0],
  budget: {
    enabled: boolean;
    providerOptions?: MuxProviderOptions;
    activeTools?: readonly string[];
  }
): Promise<Awaited<ReturnType<typeof assemblePromptPayload>> & { contextBudgetLimit?: number }> {
  const payload = await assemblePromptPayload(options);
  let contextBudgetLimit: number | undefined;
  // Check after provider transforms and system/schema assembly: history-only
  // estimates cannot prevent oversized requests from reaching the provider.
  if (budget.enabled) {
    contextBudgetLimit =
      getEffectiveContextLimit(
        options.modelString,
        isAnthropic1MEffectivelyEnabled(
          options.modelString,
          budget.providerOptions,
          options.providersConfig
        ),
        options.providersConfig,
        { openaiWireFormat: budget.providerOptions?.openai?.wireFormat }
      ) ?? undefined;
    if (contextBudgetLimit == null) {
      log.warn("Context budget preflight unavailable: model context limit is unknown", {
        workspaceId: options.workspaceId,
        model: options.modelString,
      });
    }
    const exceeded = await checkAssembledRequestBudgetForModel(payload, {
      model: options.modelString,
      metadataModel: resolveModelForMetadata(options.modelString, options.providersConfig ?? null),
      modelContextLimit: contextBudgetLimit,
      activeTools: budget.activeTools,
    });
    if (exceeded) throw new ContextBudgetExceededError(exceeded);
  }
  return { ...payload, contextBudgetLimit };
}

function derivePromptCacheScope(metadata: WorkspaceMetadata): string {
  return `${metadata.projectName}-${uniqueSuffix([metadata.projectPath])}`;
}

interface WorkflowResultContinuationSender {
  isWorkflowInvocationCurrent(workspaceId: string, runId: string): Promise<boolean>;
  sendMessage(
    workspaceId: string,
    message: string,
    options: SendMessageOptions,
    internal?: {
      skipAutoResumeReset?: boolean;
      synthetic?: boolean;
      agentInitiated?: boolean;
      /** When true, reject instead of queueing if the workspace is busy. */
      requireIdle?: boolean;
      startStreamInBackground?: boolean;
    }
  ): Promise<Result<void, SendMessageError>>;
}

interface TurnRequestBuildStartupState {
  pendingRunMetadataId: string | null;
  logSlowStreamStartup?: (details: Record<string, unknown>) => void;
}

export interface TurnRequestBuildContext {
  abortSignal: AbortSignal;
  syntheticMessageId: string;
  startTime: number;
  startupPhaseTimingsMs: Record<string, number>;
  startupState: TurnRequestBuildStartupState;
  recordStartupPhaseTiming: (phase: string, phaseStartedAt: number) => void;
  admissionOnly?: boolean;
}

type TurnRequestBuildOutcome =
  | { type: "finished"; result: Result<TurnStreamHandle, SendMessageError> }
  | {
      type: "ready";
      turnExecutionOptions: TurnExecutionOptions;
      assistantMessageId: string;
      deleteAbortedPlaceholder: (messageId: string) => Promise<void>;
      logStartOutcome: (outcome: "started" | "stream_start_failed", errorType?: string) => void;
      /**
       * Durable side effects that must only land once the stream has actually
       * started (a granted memory harvest permission): every earlier exit —
       * append failure, late abort, thinking rebuild, stream start failure —
       * then leaves nothing behind. Awaited by the caller after startStream.
       */
      onStreamStarted?: () => Promise<void>;
    };

export interface PreparedStreamMessage extends AsyncDisposable {
  start(options: StreamMessageOptions): Promise<Result<TurnStreamHandle, SendMessageError>>;
}

export interface PreparedTurnRequest extends AsyncDisposable {
  start(thinkingOverride?: ActiveTurnThinkingOverride): Promise<TurnRequestBuildOutcome>;
}

/** Turn refused because a memory-policy DENY could not be made durable (see persistWorkspaceMemoryWritable). */
const WORKSPACE_MEMORY_POLICY_PERSIST_ERROR =
  "Could not persist this workspace's read-only memory policy; refusing to start the turn so a restart cannot fall back to a stale write permission. Retry once the config directory is writable.";

type PreparedTurnRequestOutcome =
  | Extract<TurnRequestBuildOutcome, { type: "finished" }>
  | { type: "prepared"; request: PreparedTurnRequest };

export interface TurnRequestBuilderBindings extends OauthServiceBindings {
  mcpServerManager?: MCPServerManager;
  taskService?: TaskService;
  workspaceTurnManager?: ToolConfiguration["workspaceTurnManager"];
  memoryService?: MemoryService;
  timelineService?: ToolConfiguration["timelineService"];
  extraTools?: Record<string, Tool>;
  onWorkflowRunStatusChanged?: (event: WorkflowRunStatusChangedEvent) => Promise<void> | void;
  workflowResultContinuationSender?: WorkflowResultContinuationSender;
  workspaceHeartbeatService?: ToolConfiguration["workspaceHeartbeatService"];
  /**
   * Receives each normal turn's workspace-memory write policy and persists it
   * (see WorkspaceService.recordWorkspaceMemoryWritable); resolves false when
   * the value could not be confirmed durable.
   */
  workspaceMemoryPolicySink?: {
    recordWorkspaceMemoryWritable(workspaceId: string, writable: boolean): Promise<boolean>;
  };
  analyticsService?: { executeRawQuery(sql: string): Promise<unknown> };
  desktopSessionManager?: DesktopSessionManager;
}

interface TurnRequestBuilderDependencies {
  config: Config;
  providersConfigStore: ProvidersConfigStore;
  secretsStore: Pick<SecretsStore, "getEffectiveSecrets">;
  historyService: HistoryService;
  initStateManager: InitStateManager;
  providerService: ProviderService;
  providerModelFactory: ProviderModelFactory;
  streamManager: StreamManager;
  workspaceMcpOverridesService: WorkspaceMcpOverridesService;
  policyService?: PolicyService;
  telemetryService?: TelemetryService;
  backgroundProcessManager?: BackgroundProcessManager;
  sessionUsageService?: SessionUsageService;
  devToolsService?: DevToolsService;
  experimentsService?: ExperimentsService;
  lastLlmRequestByWorkspace: Map<string, DebugLlmRequestSnapshot>;
  bindings: TurnRequestBuilderBindings;
  emit: (event: string, ...args: unknown[]) => boolean;
  createAbortedTurnHandle: (messageId: string, signal?: AbortSignal) => TurnStreamHandle;
  createSettledTurnHandle: (messageId: string, completion: TurnCompletion) => TurnStreamHandle;
  getWorkspaceMetadata: (workspaceId: string) => Promise<Result<WorkspaceMetadata>>;
  createWorkspaceRuntimeContext: (
    workspaceId: string,
    metadata: WorkspaceMetadata
  ) => Result<
    WorkspaceRuntimeContext & {
      hostCheckoutRoot: string | null;
      projectCheckoutRoot: string | null;
    },
    SendMessageError
  >;
  isClaudeSkillsCompatEnabled: () => boolean;
  isAgentPluginsEnabled: () => boolean;
  wrapToolsForDelegation: (
    workspaceId: string,
    tools: Record<string, Tool>,
    delegatedToolNames?: string[]
  ) => Record<string, Tool>;
  durableEventJournalFor: (workspaceId: string) => DurableEventJournal;
  shouldAllowLegacyInvalidWorkflowAgentOutputSchema: (
    metadata: WorkspaceMetadata
  ) => Promise<boolean>;
  isStreaming: (workspaceId: string) => boolean;
  trackPendingDevToolsRunMetadata: (
    messageId: string,
    workspaceId: string,
    metadataId: string
  ) => void;
}

export interface PrepareModelAttemptOptions {
  rawModelString: string;
  canonicalModelString: string;
  canonicalProviderName: string;
  effectiveModelString: string;
  optionsModelString: string;
  wireProviderName: string;
  routeProvider?: ProviderName;
  effectiveThinkingLevel: ThinkingLevel;
  minThinkingLevel: ThinkingLevel;
  providerRequestMessages: MuxMessage[];
  muxProviderOptions: MuxProviderOptions;
  workspaceId: string;
  truncationMode: Parameters<typeof buildProviderOptions>[6];
  providersConfigSnapshot: ProvidersConfigMap;
  coderSelectedInstance?: { name: string; type: string };
  promptCacheScope: string;
  reasoningMode: Parameters<typeof buildProviderOptions>[10];
  recordStartupPhaseTiming?: (phase: string, phaseStartedAt: number) => void;
}

interface PreparedModelAttempt {
  providerOptions: Record<string, unknown>;
  requestHeaders: Record<string, string> | undefined;
  resolvedOverrides: ReturnType<typeof resolveModelParameterOverrides>;
  currentEffectiveLevelRef: { current: ThinkingLevel };
  computeRebuiltProviderOptions: (
    level: ThinkingLevel,
    currentLevel: ThinkingLevel
  ) => { effectiveLevel: ThinkingLevel; providerOptions: Record<string, unknown> } | null;
  rebuildProviderOptionsForThinkingLevel: RebuildProviderOptionsForThinkingLevel;
}

export class TurnRequestBuilder {
  constructor(private readonly dependencies: TurnRequestBuilderDependencies) {}

  private resolveOverridesIdentity(
    rawModelString: string,
    canonical: string,
    canonicalProvider: string,
    providersConfig: ProvidersConfigMap
  ): { providerName: string; modelString: string; coderDerived: boolean } {
    if (rawModelString.startsWith("coder:")) {
      const metadataCanonical = resolveCoderGatewayMetadataModel(rawModelString, providersConfig);
      if (metadataCanonical != null) {
        const separator = metadataCanonical.indexOf(":");
        return {
          providerName: separator > 0 ? metadataCanonical.slice(0, separator) : canonicalProvider,
          modelString: metadataCanonical,
          coderDerived: true,
        };
      }
      const coderSection = providersConfig.coder;
      if (!isCustomProviderConfig(coderSection)) {
        const wire = resolveCoderWireCanonicalModel(
          rawModelString.slice("coder:".length),
          coderSection as
            | { discoveredProviders?: unknown; additionalProviders?: unknown }
            | undefined
        );
        if (wire) {
          return { providerName: "coder", modelString: rawModelString, coderDerived: false };
        }
      }
    }
    const separator = canonical.indexOf(":");
    return {
      providerName: separator > 0 ? canonical.slice(0, separator) : canonicalProvider,
      modelString: canonical,
      coderDerived: false,
    };
  }

  prepareModelAttempt(options: PrepareModelAttemptOptions): PreparedModelAttempt {
    const buildProviderOptionsStartedAt = Date.now();
    const providerOptions = buildProviderOptions(
      options.optionsModelString,
      options.effectiveThinkingLevel,
      options.providerRequestMessages,
      (id) => this.dependencies.streamManager.isResponseIdLost(id),
      options.muxProviderOptions,
      options.workspaceId,
      options.truncationMode,
      options.providersConfigSnapshot,
      options.routeProvider,
      options.promptCacheScope,
      options.reasoningMode
    ) as Record<string, unknown>;
    options.recordStartupPhaseTiming?.("buildProviderOptionsMs", buildProviderOptionsStartedAt);
    const buildRequestConfigStartedAt = Date.now();
    const requestHeaders = buildRequestHeaders(
      options.optionsModelString,
      options.muxProviderOptions,
      options.workspaceId,
      options.providersConfigSnapshot,
      options.routeProvider
    );
    const overridesIdentity = this.resolveOverridesIdentity(
      options.rawModelString,
      options.canonicalModelString,
      options.canonicalProviderName,
      options.providersConfigSnapshot
    );
    const resolvedOverrides = resolveModelParameterOverrides(
      pinCoderInstanceRawProvidersConfig(
        this.dependencies.providersConfigStore.loadProvidersConfig(),
        options.rawModelString,
        options.coderSelectedInstance
      ),
      overridesIdentity.providerName,
      overridesIdentity.modelString,
      options.effectiveModelString
    );
    const namespaceKey = resolveProviderOptionsNamespaceKey(
      options.wireProviderName,
      options.routeProvider
    );
    const extrasWireCompatible =
      !overridesIdentity.coderDerived || overridesIdentity.providerName === namespaceKey;
    const mergeExtras = (builtOptions: Record<string, unknown>): Record<string, unknown> => {
      if (!resolvedOverrides.providerExtras || !extrasWireCompatible) {
        return builtOptions;
      }
      const muxProviderNamespace = builtOptions[namespaceKey];
      return {
        ...builtOptions,
        [namespaceKey]: isPlainObject(muxProviderNamespace)
          ? mergeProviderExtrasUnderMux(resolvedOverrides.providerExtras, muxProviderNamespace)
          : resolvedOverrides.providerExtras,
      };
    };
    const currentEffectiveLevelRef = { current: options.effectiveThinkingLevel };
    const computeRebuiltProviderOptions = (
      level: ThinkingLevel,
      currentLevel: ThinkingLevel
    ): { effectiveLevel: ThinkingLevel; providerOptions: Record<string, unknown> } | null => {
      const clamped = enforceThinkingPolicy(
        options.rawModelString,
        level,
        options.minThinkingLevel,
        options.providersConfigSnapshot
      );
      const effective = resolveEffectiveThinkingLevel(
        options.rawModelString,
        clamped,
        options.providersConfigSnapshot
      );
      if (
        effective === currentLevel ||
        isXaiGrokFastVariantSwap(options.canonicalModelString, currentLevel, effective)
      ) {
        return null;
      }
      const rebuilt = buildProviderOptions(
        options.optionsModelString,
        effective,
        options.providerRequestMessages,
        (id) => this.dependencies.streamManager.isResponseIdLost(id),
        options.muxProviderOptions,
        options.workspaceId,
        options.truncationMode,
        options.providersConfigSnapshot,
        options.routeProvider,
        options.promptCacheScope,
        options.reasoningMode
      ) as Record<string, unknown>;
      return { effectiveLevel: effective, providerOptions: mergeExtras(rebuilt) };
    };
    const rebuildProviderOptionsForThinkingLevel: RebuildProviderOptionsForThinkingLevel = (
      level
    ) => {
      const result = computeRebuiltProviderOptions(level, currentEffectiveLevelRef.current);
      if (result != null) {
        currentEffectiveLevelRef.current = result.effectiveLevel;
      }
      return result;
    };
    options.recordStartupPhaseTiming?.("buildRequestConfigMs", buildRequestConfigStartedAt);
    return {
      providerOptions: mergeExtras(providerOptions),
      requestHeaders,
      resolvedOverrides,
      currentEffectiveLevelRef,
      computeRebuiltProviderOptions,
      rebuildProviderOptionsForThinkingLevel,
    };
  }

  async build(
    opts: StreamMessageOptions,
    context: TurnRequestBuildContext
  ): Promise<TurnRequestBuildOutcome> {
    const prepared = await this.prepare(opts, context);
    if (prepared.type === "finished") return prepared;
    await using request = prepared.request;
    return await request.start(opts.activeTurnThinkingOverride);
  }

  async prepare(
    opts: StreamMessageOptions,
    context: TurnRequestBuildContext
  ): Promise<PreparedTurnRequestOutcome> {
    const resources: { model?: LanguageModel; cleanupTemp?: () => Promise<void> } = {};
    let retained = false;
    let transferred = false;
    const dispose = async () => {
      if (transferred) return;
      transferred = true;
      runLanguageModelCleanup(resources.model);
      try {
        await resources.cleanupTemp?.();
      } catch (error) {
        log.warn("Failed to clean up unstarted request", { error });
      }
    };
    await using _preparation = {
      [Symbol.asyncDispose]: async () => {
        if (!retained) await dispose();
      },
    };
    const {
      messages,
      workspaceId,
      modelString,
      thinkingLevel,
      reasoningMode,
      toolPolicy,
      additionalSystemContext,
      additionalSystemInstructions,
      maxOutputTokens,
      muxProviderOptions,
      agentInitiated,
      agentId,
      strictAgentResolution,
      acpPromptId,
      onPreStartError,
      delegatedToolNames,
      recordFileState,
      postCompactionAttachments,
      resolveMemoryContext,
      experiments: experimentsFromOptions,
      allowAgentSetGoal,
      workspaceGoalService,
      disableWorkspaceAgents,
      hasQueuedMessages,
      onStepSettled,
      requestAssemblySnapshot,
      openaiTruncationModeOverride,
      muxMetadata,
      minThinkingLevel: providedMinThinkingLevel,
    } = opts;
    let activeTurnThinkingOverride = opts.activeTurnThinkingOverride;
    const experiments: StreamMessageOptions["experiments"] = resolveBackendGatedPtcExperiments(
      experimentsFromOptions,
      (experimentId) =>
        this.dependencies.experimentsService?.isExperimentEnabled(experimentId) === true
    );
    const combinedAbortSignal = context.abortSignal;
    const syntheticMessageId = context.syntheticMessageId;
    const startTime = context.startTime;
    const startupPhaseTimingsMs = context.startupPhaseTimingsMs;
    const recordStartupPhaseTiming = context.recordStartupPhaseTiming;
    let pendingRunMetadataId: string | null = context.startupState.pendingRunMetadataId;

    const deleteAbortedPlaceholder = async (messageId: string): Promise<void> => {
      const deleteResult = await this.dependencies.historyService.deleteMessage(
        workspaceId,
        messageId
      );
      if (!deleteResult.success) {
        log.error(
          "Failed to delete aborted assistant placeholder (" +
            messageId +
            "): " +
            deleteResult.error
        );
      }
    };
    // Mode (plan|exec|compact) is derived from the selected agent definition.
    const effectiveMuxProviderOptions: MuxProviderOptions = muxProviderOptions ?? {};
    const userOpenAIWireFormat = effectiveMuxProviderOptions.openai?.wireFormat;

    const resolveToolsIdentity = (
      raw: string,
      effective: string,
      canonical: string,
      // The factory's wire snapshot — resolved from the SAME config read
      // that created the SDK model. Re-reading the providers config here
      // instead would race authoritative catalog refreshes: a mid-request
      // type change would assemble another wire's tools/options for the
      // already-created model. Shadowed prefixes and unknown instances have
      // no snapshot, and their canonical form is the raw string.
      coderWire:
        | { origin: "anthropic" | "openai"; modelId: string; providerType: string }
        | undefined,
      // Snapshot the identity is resolved against; the refusal-fallback
      // path passes ITS pinned snapshot, not the primary request's.
      providersConfigSnapshot: ProvidersConfigMap
    ): { modelString: string; openaiWireFormat?: "chatCompletions" | "responses" } => {
      // Custom providers own their raw prefix (including shadowed built-in
      // ids) and speak the wire their providerType selects: tool assembly
      // must key on that wire so Responses-bound MCP schemas are sanitized
      // and provider-native tools are offered. Chat-completions custom
      // providers keep their generic identity.
      const rawSeparator = raw.indexOf(":");
      const rawPrefix = rawSeparator > 0 ? raw.slice(0, rawSeparator) : "";
      const rawCustomEntry = rawPrefix ? providersConfigSnapshot[rawPrefix] : undefined;
      if (isCustomProviderConfig(rawCustomEntry)) {
        const wireOrigin = customProviderWireOrigin(rawCustomEntry.providerType);
        if (wireOrigin === "openai") {
          // The factory always creates provider.responses() for this type.
          return {
            modelString: `openai:${raw.slice(rawSeparator + 1)}`,
            openaiWireFormat: "responses",
          };
        }
        if (wireOrigin === "anthropic") {
          return { modelString: `anthropic:${raw.slice(rawSeparator + 1)}` };
        }
        return { modelString: raw };
      }
      if (!raw.startsWith("coder:")) {
        return { modelString: raw };
      }
      if (!effective.startsWith("coder:")) {
        // Fallback away from Coder. A PASSTHROUGH gateway fallback
        // (mux-gateway:anthropic/x) must normalize to the canonical wire
        // identity: getToolsForModel only runs Anthropic/OpenAI-specific
        // assembly (native web tools, MCP schema sanitization) for direct
        // provider prefixes, and passthrough gateways forward origin-shaped
        // payloads. Transforming gateways (openrouter) keep their own
        // identity, same as a direct selection of that gateway.
        const separator = effective.indexOf(":");
        const effectiveProvider = separator > 0 ? effective.slice(0, separator) : "";
        const definition = Object.hasOwn(PROVIDER_DEFINITIONS, effectiveProvider)
          ? PROVIDER_DEFINITIONS[effectiveProvider as ProviderName]
          : undefined;
        const passthroughGateway =
          definition?.kind === "gateway" &&
          "passthrough" in definition &&
          definition.passthrough === true;
        return {
          modelString: passthroughGateway ? normalizeToCanonical(effective) : effective,
        };
      }
      if (!coderWire) {
        return { modelString: canonical };
      }
      // The factory creates Coder instances from the wire alone (openai
      // type → provider.responses, openai-chat types → provider.chat), so
      // BOTH OpenAI wire kinds must override any pre-existing wireFormat:
      // a refusal chain that starts on direct OpenAI Chat Completions and
      // falls back to an openai-typed Coder instance would otherwise build
      // Chat Completions tools/options for a Responses request.
      const wireProtocol = coderGatewayWireProtocol(coderWire.providerType);
      return {
        modelString: `${coderWire.origin}:${coderWire.modelId}`,
        ...(wireProtocol === "openai-chat"
          ? { openaiWireFormat: "chatCompletions" as const }
          : wireProtocol === "openai-responses"
            ? { openaiWireFormat: "responses" as const }
            : {}),
      };
    };
    const prepareModelSeed = async (options: {
      rawModelString: string;
      requestedThinkingLevel: ThinkingLevel | undefined;
      minimumThinkingLevelOverride: ThinkingLevel | undefined;
      enforceMinimum: boolean;
      recordTiming?: boolean;
    }) => {
      if (
        options.enforceMinimum &&
        effectiveMuxProviderOptions.openai?.wireFormat !== userOpenAIWireFormat
      ) {
        effectiveMuxProviderOptions.openai = {
          ...(effectiveMuxProviderOptions.openai ?? {}),
          wireFormat: userOpenAIWireFormat,
        };
      }

      const requestedThinkingLevel = options.requestedThinkingLevel ?? THINKING_LEVEL_OFF;
      const preliminaryProvidersConfig = this.dependencies.providerService.getConfig();
      const preliminaryMinThinkingLevel = resolveMinimumThinkingLevel(
        options.rawModelString,
        options.minimumThinkingLevelOverride,
        preliminaryProvidersConfig
      );
      const preliminaryThinkingLevel = options.enforceMinimum
        ? enforceThinkingPolicy(
            options.rawModelString,
            requestedThinkingLevel,
            preliminaryMinThinkingLevel,
            preliminaryProvidersConfig
          )
        : resolveEffectiveThinkingLevel(
            options.rawModelString,
            requestedThinkingLevel,
            preliminaryProvidersConfig
          );

      const resolveAndCreateModelStartedAt = Date.now();
      const resolved = await this.dependencies.providerModelFactory.resolveAndCreateModel(
        options.rawModelString,
        preliminaryThinkingLevel,
        effectiveMuxProviderOptions,
        { agentInitiated, workspaceId }
      );
      if (options.recordTiming) {
        recordStartupPhaseTiming("resolveAndCreateModelMs", resolveAndCreateModelStartedAt);
      }
      if (!resolved.success) {
        return resolved;
      }

      const providersConfig = pinCoderInstanceProvidersConfig(
        this.dependencies.providerService.getConfig(),
        options.rawModelString,
        resolved.data.coderSelectedInstance
      );
      const minThinkingLevel = resolveMinimumThinkingLevel(
        options.rawModelString,
        options.minimumThinkingLevelOverride,
        providersConfig
      );
      const effectiveThinkingLevel = options.enforceMinimum
        ? enforceThinkingPolicy(
            options.rawModelString,
            requestedThinkingLevel,
            minThinkingLevel,
            providersConfig
          )
        : resolveEffectiveThinkingLevel(
            options.rawModelString,
            requestedThinkingLevel,
            providersConfig
          );
      const toolsIdentity = resolveToolsIdentity(
        options.rawModelString,
        resolved.data.effectiveModelString,
        resolved.data.canonicalModelString,
        resolved.data.coderWire,
        providersConfig
      );
      const optionsModelString =
        options.rawModelString.startsWith("coder:") &&
        !resolved.data.effectiveModelString.startsWith("coder:")
          ? toolsIdentity.modelString
          : options.rawModelString;
      if (toolsIdentity.openaiWireFormat != null) {
        effectiveMuxProviderOptions.openai = {
          ...(effectiveMuxProviderOptions.openai ?? {}),
          wireFormat: toolsIdentity.openaiWireFormat,
        };
      }

      return Ok({
        ...resolved.data,
        rawModelString: options.rawModelString,
        providersConfig,
        minThinkingLevel,
        effectiveThinkingLevel,
        capabilityModelString: resolveModelForMetadata(
          options.rawModelString.startsWith("coder:")
            ? options.rawModelString
            : resolved.data.canonicalModelString,
          providersConfig
        ),
        toolsModelString: toolsIdentity.modelString,
        optionsModelString,
      });
    };

    const modelResult = await prepareModelSeed({
      rawModelString: modelString,
      requestedThinkingLevel: thinkingLevel,
      minimumThinkingLevelOverride: providedMinThinkingLevel,
      enforceMinimum: false,
      recordTiming: true,
    });
    if (!modelResult.success) {
      return { type: "finished", result: Err(modelResult.error) };
    }
    resources.model = modelResult.data.model;
    const {
      canonicalModelString,
      canonicalProviderName,
      wireProviderName,
      routedThroughGateway,
      routeProvider,
      providersConfig: requestProvidersConfig,
      effectiveThinkingLevel,
      capabilityModelString,
    } = modelResult.data;

    log.debug_obj(`${workspaceId}/1_original_messages.json`, messages);

    // Context Boundary request slicing happens before empty-assistant filtering so
    // provider-invisible reset rows can still bound the active context window.
    // Message preparation keys on the WIRE provider (wireProviderName), not
    // the config identity: a gateway-scoped coder:<instance>/<model> request
    // sends Anthropic/OpenAI-shaped bytes, so wire-specific transforms must
    // still run for it.
    const { activeContextMessages, providerRequestMessages, contextBoundarySlicedCount } =
      prepareProviderRequestMessages(messages, wireProviderName, effectiveThinkingLevel);
    if (contextBoundarySlicedCount > 0) {
      log.debug("Prepared provider history window", {
        workspaceId,
        originalCount: messages.length,
        contextBoundarySlicedCount,
        activeContextCount: activeContextMessages.length,
      });
    }
    log.debug_obj(`${workspaceId}/1a_active_context_messages.json`, activeContextMessages);
    log.debug(
      `Filtered ${activeContextMessages.length - providerRequestMessages.length} empty assistant messages`
    );
    log.debug_obj(`${workspaceId}/1b_provider_request_messages.json`, providerRequestMessages);

    // OpenAI-specific: Keep reasoning parts in history so each request can
    // carry forward reasoning context without relying on previous_response_id.
    if (wireProviderName === "openai") {
      log.debug("Keeping reasoning parts for OpenAI (managed via explicit history)");
    }
    const getWorkspaceMetadataStartedAt = Date.now();
    const metadataResult = await this.dependencies.getWorkspaceMetadata(workspaceId);
    recordStartupPhaseTiming("getWorkspaceMetadataMs", getWorkspaceMetadataStartedAt);
    if (!metadataResult.success) {
      return { type: "finished", result: Err({ type: "unknown", raw: metadataResult.error }) };
    }

    const metadata = metadataResult.data;

    if (this.dependencies.policyService?.isEnforced()) {
      if (!this.dependencies.policyService.isRuntimeAllowed(metadata.runtimeConfig)) {
        return {
          type: "finished",
          result: Err({
            type: "policy_denied",
            message: "Workspace runtime is not allowed by policy",
          }),
        };
      }
    }
    const workspaceLog = log.withFields({ workspaceId, workspaceName: metadata.name });
    const logSlowStreamStartup = (details: Record<string, unknown>): void => {
      const totalMs = Date.now() - startTime;
      if (totalMs < STREAM_STARTUP_DIAGNOSTIC_THRESHOLD_MS) {
        return;
      }

      workspaceLog.info("[stream-startup] Slow pre-stream preparation", {
        workspaceId,
        modelString,
        totalMs,
        startupPhaseTimingsMs,
        ...details,
      });
    };
    // Exposed so the caller's catch path can log slow startups that fail after build().
    context.startupState.logSlowStreamStartup = logSlowStreamStartup;

    const emitStartupBreadcrumb = (
      startupStage:
        | "waiting_for_init"
        | "checking_runtime"
        | "loading_workspace_context"
        | "loading_tools"
        | "preparing_request"
        | "starting_stream"
    ): void => {
      const breadcrumb =
        startupStage === "waiting_for_init"
          ? {
              phase: "waiting" as const,
              detail: "Waiting for workspace initialization...",
            }
          : startupStage === "checking_runtime"
            ? {
                phase: "starting" as const,
                detail: "Checking workspace runtime...",
              }
            : startupStage === "loading_workspace_context"
              ? {
                  phase: "starting" as const,
                  detail: "Loading workspace context...",
                }
              : startupStage === "loading_tools"
                ? {
                    phase: "starting" as const,
                    detail: "Loading tools...",
                  }
                : startupStage === "preparing_request"
                  ? {
                      phase: "starting" as const,
                      detail: "Preparing model request...",
                    }
                  : {
                      phase: "starting" as const,
                      detail: "Starting model stream...",
                    };

      workspaceLog.info("[stream-startup] Breadcrumb", {
        startupStage,
        phase: breadcrumb.phase,
        detail: breadcrumb.detail,
        elapsedMs: Date.now() - startTime,
      });
      if (!context.admissionOnly)
        this.dependencies.emit("runtime-status", {
          type: "runtime-status",
          workspaceId,
          phase: breadcrumb.phase,
          runtimeType: metadata.runtimeConfig.type,
          source: "startup",
          detail: breadcrumb.detail,
        });
    };

    const runtimeContextResult = this.dependencies.createWorkspaceRuntimeContext(
      workspaceId,
      metadata
    );
    if (!runtimeContextResult.success) {
      return { type: "finished", result: Err(runtimeContextResult.error) };
    }
    const { runtime, workspacePath, hostCheckoutRoot, projectCheckoutRoot } =
      runtimeContextResult.data;

    // Wait for init to complete before any runtime I/O operations
    // (SSH/devcontainer may not be ready until init finishes pulling the container)
    emitStartupBreadcrumb("waiting_for_init");
    const waitForInitStartedAt = Date.now();
    await this.dependencies.initStateManager.waitForInit(workspaceId, combinedAbortSignal);
    recordStartupPhaseTiming("waitForInitMs", waitForInitStartedAt);
    if (combinedAbortSignal.aborted) {
      return {
        type: "finished",
        result: Ok(
          this.dependencies.createAbortedTurnHandle(syntheticMessageId, combinedAbortSignal)
        ),
      };
    }

    // Verify runtime is actually reachable after init completes.
    // For Docker workspaces, this checks the container exists and starts it if stopped.
    // For Coder workspaces, this may start a stopped workspace and wait for it.
    // If init failed during container creation, ensureReady() will return an error.
    emitStartupBreadcrumb("checking_runtime");
    const ensureReadyStartedAt = Date.now();
    const readyResult = await runtime.ensureReady({
      signal: combinedAbortSignal,
      statusSink: (status) => {
        // Emit runtime-status events for frontend UX (StreamingBarrier)
        if (!context.admissionOnly)
          this.dependencies.emit("runtime-status", {
            type: "runtime-status",
            workspaceId,
            phase: status.phase,
            runtimeType: status.runtimeType,
            source: "runtime",
            detail: status.detail,
          });
      },
    });
    recordStartupPhaseTiming("ensureReadyMs", ensureReadyStartedAt);
    if (!readyResult.ready) {
      // Generate message ID for the error event (frontend needs this for synthetic message)
      const errorMessageId = createAssistantMessageId();
      const runtimeType = metadata.runtimeConfig?.type ?? "local";
      const runtimeLabel = runtimeType === "docker" ? "Container" : "Runtime";
      const errorMessage = readyResult.error || `${runtimeLabel} unavailable.`;

      const errorType = readyResult.errorType;

      // Emit error event so frontend receives it via stream subscription.
      // This mirrors the context_exceeded pattern - the fire-and-forget sendMessage
      // call in useCreationWorkspace.ts won't see the returned Err, but will receive
      // this event through the workspace chat subscription.
      const errorEvent = createErrorEvent(workspaceId, {
        messageId: errorMessageId,
        error: errorMessage,
        errorType,
        acpPromptId,
      });
      if (!context.admissionOnly) this.dependencies.emit("error", errorEvent);
      onPreStartError?.(errorEvent);

      logSlowStreamStartup({
        outcome: "runtime_not_ready",
        runtimeType,
        errorType,
        errorMessage,
      });

      return {
        type: "finished",
        result: Err({
          type: errorType,
          message: errorMessage,
        }),
      };
    }

    // Memory context (memory experiment): resolved only after ensureReady so
    // project-scope listing sees a running runtime (a stopped Docker/remote
    // workspace would yield an empty/partial context, and AgentSession caches
    // the result per model/session segment).
    const memoryContext = resolveMemoryContext
      ? await resolveMemoryContext(modelString, { includeHotMemories: false })
      : undefined;

    const cfg = this.dependencies.config.loadConfigOrDefault();
    const advisorExperimentEnabled =
      experiments?.advisorTool ??
      this.dependencies.experimentsService?.isExperimentEnabled(EXPERIMENT_IDS.ADVISOR_TOOL) ===
        true;
    const dynamicWorkflowsExperimentEnabled =
      experiments?.dynamicWorkflows ??
      this.dependencies.experimentsService?.isExperimentEnabled(
        EXPERIMENT_IDS.DYNAMIC_WORKFLOWS
      ) === true;
    const memoryExperimentEnabled =
      experiments?.memory ??
      this.dependencies.experimentsService?.isExperimentEnabled(EXPERIMENT_IDS.MEMORY) === true;
    const isExperimentEnabled = (id: Parameters<ExperimentsService["isExperimentEnabled"]>[0]) =>
      this.dependencies.experimentsService?.isExperimentEnabled(id) === true;
    const sessionHistoryEnabled =
      experiments?.tokenBudget ?? isExperimentEnabled(EXPERIMENT_IDS.TOKEN_BUDGET);
    const timelineExperimentEnabled =
      this.dependencies.experimentsService?.isExperimentEnabled(EXPERIMENT_IDS.TIMELINE) === true;
    const workspaceHeartbeatsExperimentEnabled =
      experiments?.workspaceHeartbeats ??
      this.dependencies.experimentsService?.isExperimentEnabled(
        EXPERIMENT_IDS.WORKSPACE_HEARTBEATS
      ) === true;
    const toolSearchExperimentEnabled =
      experiments?.toolSearch ??
      this.dependencies.experimentsService?.isExperimentEnabled(EXPERIMENT_IDS.TOOL_SEARCH) ===
        true;
    const memoryIntuitionExperimentEnabled =
      experiments?.memoryIntuition ??
      this.dependencies.experimentsService?.isExperimentEnabled(EXPERIMENT_IDS.MEMORY_INTUITION) ===
        true;
    const memoryHotSetExperimentEnabled =
      this.dependencies.experimentsService?.isExperimentEnabled(EXPERIMENT_IDS.MEMORY_HOT_SET) ===
      true;
    // claude-skills-compat is host-evaluated (like memory-hot-set): sub-agents share the
    // host ExperimentsService, so it is not inherited through SendMessageOptions.experiments.
    const claudeSkillsCompatExperimentEnabled = this.dependencies.isClaudeSkillsCompatEnabled();
    const agentPluginsExperimentEnabled = this.dependencies.isAgentPluginsEnabled();
    // Once final tool policy keeps the memory tool, upgrade the index-only
    // memory context (resolved pre-policy with includeHotMemories: false) to
    // the token-budgeted hot block for the model that will actually stream.
    // Returns the unchanged pre-policy `memoryContext` reference when hot
    // preloading is off or the memory tool was stripped, so callers can use
    // identity comparison to decide whether the system prompt must be rebuilt.
    const upgradeMemoryContextForModel = async (
      memoryToolAvailableForModel: boolean,
      modelStringForContext: string
    ): Promise<MemorySessionContext | undefined> =>
      memoryToolAvailableForModel &&
      memoryHotSetExperimentEnabled &&
      resolveMemoryContext !== undefined
        ? await resolveMemoryContext(modelStringForContext, { includeHotMemories: true })
        : memoryContext;
    emitStartupBreadcrumb("loading_workspace_context");
    const resolveAgentForStreamStartedAt = Date.now();
    const agentResult = await resolveAgentForStream({
      workspaceId,
      metadata,
      runtime,
      workspacePath,
      requestedAgentId: agentId,
      strictAgentResolution,
      disableWorkspaceAgents: disableWorkspaceAgents ?? false,
      callerToolPolicy: toolPolicy,
      cfg,
      emitError: (event) => {
        if (!context.admissionOnly) this.dependencies.emit("error", event);
        onPreStartError?.(event);
      },
      isAdvisorExperimentEnabled: advisorExperimentEnabled,
      includeAgentPlugins: agentPluginsExperimentEnabled,
    });
    recordStartupPhaseTiming("resolveAgentForStreamMs", resolveAgentForStreamStartedAt);
    if (!agentResult.success) {
      return { type: "finished", result: Err(agentResult.error) };
    }
    const {
      effectiveAgentId,
      agentDefinition,
      agentDiscoveryRuntime,
      agentDiscoveryPath,
      isSubagentWorkspace,
      agentInheritanceChain,
      agentIsPlanLike,
      effectiveMode,
      taskSettings,
      taskDepth,
      shouldDisableTaskToolsForDepth,
      effectiveToolPolicy,
    } = agentResult.data;
    // Explicit summaries remain recovery operations, not token-budget turns.
    // Inspect this request's last effective user row, never an older compact command.
    const latestUserMessage = providerRequestMessages.findLast(
      (message) => message.role === "user"
    );
    const isCompactionRequest =
      effectiveAgentId === "compact" ||
      muxMetadata?.type === "compaction-request" ||
      latestUserMessage?.metadata?.muxMetadata?.type === "compaction-request";
    const tokenBudgetEnabled =
      !isCompactionRequest &&
      sessionHistoryEnabled &&
      !(
        experiments?.continuousCompaction ??
        isExperimentEnabled(EXPERIMENT_IDS.CONTINUOUS_COMPACTION)
      ) &&
      !isRlmModeEnabled(experiments, isExperimentEnabled);
    const legacyModeForMetadata = getLegacyModeForAgentMetadata(effectiveAgentId, effectiveMode);
    const memoryAccess = resolveMemoryAccessPolicy({
      planLike: agentIsPlanLike,
      editingCapable: isExecLikeEditingCapableInResolvedChain(agentInheritanceChain),
    });
    // Post-compaction harvest writes to /memories/workspace on the agent's
    // behalf; it must honor exactly what the memory tool enforces: the scope
    // access AND the tool's presence in the final toolset. The tool exists
    // only with the experiment + service (tools.ts) and survives only if the
    // effective policy keeps it (applied later in tool assembly, mirrored
    // here); request.assemble middleware can still strip it, so the FINAL
    // check happens against the toolset of the request actually started (see
    // persistWorkspaceMemoryWritable). The compaction turn itself runs the
    // "compact" agent, so only normal turns record their policy (the session
    // attaches it to the compaction completion).
    const workspaceMemoryWritable =
      memoryAccess.workspace === "readwrite" &&
      memoryExperimentEnabled &&
      this.dependencies.bindings.memoryService !== undefined &&
      !isMemoryToolDisabled(effectiveToolPolicy);
    // Persisting the harvest permission is asymmetric because the two values
    // fail differently when the turn then never streams: a stale DENY only
    // fails closed (the preceding transcript is not harvested), a stale GRANT
    // would let the preceding read-only transcript harvest into the (shared)
    // workspace notebook after a restart. So a deny is persisted inside
    // `start` before anything else (and refuses the turn when it cannot be
    // made durable), while a grant is persisted only once the stream has
    // actually started (onStreamStarted) — never at preparation time, where
    // an admission-only candidate (prepareStreamMessage) may be rejected or
    // disposed without running. Awaited (a config write happens only when
    // the value changes). Returns false when a deny could not be persisted.
    const persistWorkspaceMemoryWritable = async (writable: boolean): Promise<boolean> => {
      const sink = this.dependencies.bindings.workspaceMemoryPolicySink;
      if (isCompactionRequest || !sink) return true;
      if (await sink.recordWorkspaceMemoryWritable(workspaceId, writable)) return true;
      if (!writable) return false;
      log.warn("Workspace memory write policy could not be persisted; harvests will fail closed", {
        workspaceId,
      });
      return true;
    };
    const projectTrusted = isWorkspaceProjectTrusted(this.dependencies.config, metadata);
    // projectAutomationDisabled: benchmark harnesses opt out of automatic
    // repo hook execution (tool_env/tool_pre/tool_post) while keeping
    // config trust for sub-agent delegation.
    const sharedExecutionTrusted =
      isWorkspaceTrustedForSharedExecution(metadata, cfg.projects) && !projectAutomationDisabled();
    const agentAdvisorEnabled = resolveAdvisorEnabledForAgent(
      effectiveAgentId,
      cfg.agentAiDefaults?.[effectiveAgentId]?.advisorEnabled
    );
    const advisorModelString = cfg.advisorModelString?.trim() ?? "";
    const advisorToolEligible =
      advisorExperimentEnabled && agentAdvisorEnabled && advisorModelString.length > 0;

    // Goals graduated to GA: tools are gated solely on the workspace's
    // current goal status + agent capability, not on an experiment flag.
    let currentGoalForTools: GoalRecordV1 | null = null;
    if (workspaceGoalService) {
      currentGoalForTools = await workspaceGoalService.getGoal(workspaceId);
    }
    const effectiveGoalDefaults = mergeGoalDefaults(
      normalizeGoalDefaults(cfg.goalDefaults ?? DEFAULT_GOAL_DEFAULTS),
      metadata.goalDefaults ?? null
    );
    const goalToolAvailability = getGoalToolAvailability({
      goalStatus:
        opts.prospectiveGoalStatusForToolAvailability !== undefined
          ? opts.prospectiveGoalStatusForToolAvailability
          : (currentGoalForTools?.status ?? null),
      parentWorkspaceId: metadata.parentWorkspaceId,
      allowAgentSetGoal,
      agentInheritanceChain,
    });

    // Fetch workspace MCP overrides (for filtering servers and tools)
    // NOTE: Stored in <workspace>/.xum/mcp.local.jsonc (not ~/.xum/config.json).
    let mcpOverrides: WorkspaceMCPOverrides | undefined;
    const loadWorkspaceMcpOverridesStartedAt = Date.now();
    try {
      mcpOverrides = (
        await this.dependencies.workspaceMcpOverridesService.getOverridesForWorkspace(workspaceId)
      ).overrides;
    } catch (error) {
      log.warn("[MCP] Failed to load workspace MCP overrides; continuing without overrides", {
        workspaceId,
        error,
      });
      mcpOverrides = undefined;
    }
    recordStartupPhaseTiming("loadWorkspaceMcpOverridesMs", loadWorkspaceMcpOverridesStartedAt);

    // Agent Plugins: discovery follows the active checkout and is disabled
    // for workspaces that exec off-host (SSH/Docker/devcontainer).
    const agentPluginsMcpContext = hostCheckoutRoot
      ? resolveAgentPluginsMcpContext(metadata, hostCheckoutRoot)
      : null;

    // Tier-1 plugin hooks (agent-plugins experiment): reconcile discovered
    // hooks.js modules with the event spine BEFORE request assembly so both
    // request.assemble and tool.execute middleware are in place for this
    // turn. Failure posture: a broken plugin never blocks a send.
    if (!requestAssemblySnapshot) {
      await prepareWorkspaceRequestHooks({
        config: this.dependencies.config,
        metadata,
        hostCheckoutRoot,
        journal: this.dependencies.durableEventJournalFor(workspaceId),
        enabled: this.dependencies.isAgentPluginsEnabled(),
      });
    }

    const listMcpServersStartedAt = Date.now();
    const mcpServers = this.dependencies.bindings.mcpServerManager
      ? await this.dependencies.bindings.mcpServerManager.listServers(
          metadata.projectPath,
          mcpOverrides,
          projectTrusted,
          agentPluginsMcpContext
        )
      : undefined;
    recordStartupPhaseTiming("listMcpServersMs", listMcpServersStartedAt);

    const loadAdditionalSystemContextStartedAt = Date.now();
    let workspaceAdditionalSystemContext = additionalSystemContext;
    if (workspaceAdditionalSystemContext == null) {
      try {
        // Fall back to disk only when the renderer did not send a live snapshot.
        // `effectiveAdditionalSystemContext` honors the `enabled` toggle: when
        // the user has disabled the scratchpad, the persisted content is
        // intentionally not injected.
        const record = await readAdditionalSystemContext(this.dependencies.config, workspaceId);
        workspaceAdditionalSystemContext = effectiveAdditionalSystemContext(record);
      } catch (error) {
        // The scratchpad is user-editable state, so a transient read failure should not block a send.
        log.warn("Failed to load workspace additional system context; continuing without it", {
          workspaceId,
          error,
        });
        workspaceAdditionalSystemContext = "";
      }
    }
    const scratchpadAdditionalSystemInstructions = mergeAdditionalSystemInstructions(
      workspaceAdditionalSystemContext,
      additionalSystemInstructions
    );
    recordStartupPhaseTiming("loadAdditionalSystemContextMs", loadAdditionalSystemContextStartedAt);

    // Build plan-aware instructions and determine plan→exec transition content.
    // IMPORTANT: Derive this from the same boundary-sliced message payload that is sent to
    // the model so plan hints/handoffs cannot be suppressed by pre-boundary history.
    const buildPlanInstructionsStartedAt = Date.now();
    const { effectiveAdditionalInstructions, planFilePath, planContentForTransition } =
      await buildPlanInstructions({
        runtime,
        metadata,
        workspaceId,
        workspacePath,
        effectiveMode,
        effectiveAgentId,
        agentIsPlanLike,
        agentDiscoveryRuntime,
        agentDiscoveryPath,
        additionalSystemInstructions: scratchpadAdditionalSystemInstructions,
        shouldDisableTaskToolsForDepth,
        taskDepth,
        taskSettings,
        requestPayloadMessages: providerRequestMessages,
      });
    recordStartupPhaseTiming("buildPlanInstructionsMs", buildPlanInstructionsStartedAt);

    const xumScope = resolveXumToolScope(
      this.dependencies.config,
      metadata,
      workspacePath,
      projectCheckoutRoot
    );

    const workflowSkillStorageContext = resolveSkillStorageContext({
      runtime,
      workspacePath,
      xumScope,
      includeAgentPlugins: this.dependencies.isAgentPluginsEnabled(),
    });

    const desktopSessionManager = this.dependencies.bindings.desktopSessionManager;
    let desktopCapabilityPromise: ReturnType<DesktopSessionManager["getCapability"]> | undefined;
    const loadDesktopCapability =
      desktopSessionManager == null
        ? undefined
        : () => {
            // Reuse the same capability probe for every desktop-gated agent discovered during
            // this request so discovery cannot trigger one desktop startup attempt per agent.
            desktopCapabilityPromise ??= desktopSessionManager.getCapability(workspaceId);
            return desktopCapabilityPromise;
          };

    // modelStringForSystem lets the refusal-fallback prepare() rebuild the
    // system prompt for the fallback model (model-keyed instruction sections).
    // Memory index eligibility mirrors memory tool registration (experiment +
    // service); tool policy may still strip the tool, which forces a rebuild
    // below so the prompt never advertises an absent tool.
    const memoryToolEligible =
      memoryExperimentEnabled && this.dependencies.bindings.memoryService !== undefined;
    // Gate and execute the same global-only definition snapshot: edits during
    // turn assembly must not swap the body after its enablement was checked.
    const intuitionDefinition =
      memoryToolEligible && memoryIntuitionExperimentEnabled && !isSubagentWorkspace
        ? await resolveHeadlessAgentDefinition(this.dependencies.config.rootDir, "intuition")
        : null;
    const intuitionToolEligible =
      intuitionDefinition !== null &&
      !isAgentEffectivelyDisabled({
        cfg,
        agentId: "intuition",
        resolvedFrontmatter: intuitionDefinition.frontmatter,
      });
    const intuitionSettings = intuitionToolEligible
      ? resolveHeadlessAgentSettings(
          this.dependencies.config,
          workspaceId,
          "intuition",
          modelString,
          intuitionDefinition.frontmatter.ai
        )
      : undefined;
    const buildStreamSystemContextForToolset = (
      toolset: {
        advisorToolAvailable: boolean;
        memoryToolAvailable: boolean;
        intuitionToolAvailable: boolean;
      },
      modelStringForSystem: string = modelString,
      contextForModel: MemorySessionContext | undefined = memoryContext
    ) =>
      buildStreamSystemContext({
        runtime,
        metadata,
        workspacePath,
        workspaceId,
        agentDefinition,
        effectiveMode,
        agentDiscoveryRuntime,
        agentDiscoveryPath,
        isSubagentWorkspace,
        effectiveAdditionalInstructions,
        planFilePath,
        modelString: modelStringForSystem,
        cfg,
        providersConfig: this.dependencies.providerService.getConfig(),
        mcpServers,
        xumScope,
        loadDesktopCapability,
        advisorToolAvailable: toolset.advisorToolAvailable,
        memoryToolAvailable: toolset.memoryToolAvailable,
        tokenBudgetEnabled,
        workspaceMemoryWritable: memoryAccess.workspace === "readwrite",
        intuitionToolAvailable: toolset.intuitionToolAvailable,
        hotMemoriesBlock: contextForModel?.hotMemoriesBlock ?? undefined,
        claudeSkillsCompatEnabled: claudeSkillsCompatExperimentEnabled,
        agentPluginsEnabled: agentPluginsExperimentEnabled,
      });

    // Build provisional agent context before tool policy finalizes the toolset.
    // The final system prompt is rebuilt after policy application so advisor guidance cannot
    // survive when the resolved toolset strips the advisor tool.
    const buildStreamSystemContextStartedAt = Date.now();
    const prePolicyStreamSystemContext = await buildStreamSystemContextForToolset({
      advisorToolAvailable: advisorToolEligible,
      memoryToolAvailable: memoryToolEligible,
      intuitionToolAvailable: intuitionToolEligible,
    });
    recordStartupPhaseTiming("buildStreamSystemContextMs", buildStreamSystemContextStartedAt);
    const { agentSystemPromptSections, agentDefinitions, availableSkills, ancestorPlanFilePaths } =
      prePolicyStreamSystemContext;
    let systemMessageTokens = prePolicyStreamSystemContext.systemMessageTokens;
    let systemMessage = prePolicyStreamSystemContext.systemMessage;

    const projectSecrets = isMultiProject(metadata)
      ? mergeMultiProjectSecrets(metadata, this.dependencies.secretsStore)
      : this.dependencies.secretsStore.getEffectiveSecrets(metadata.projectPath);

    const streamToken = this.dependencies.streamManager.generateStreamToken();

    let mcpTools: Record<string, Tool> | undefined;
    let mcpToolServerNames: Record<string, string> | undefined;
    let mcpStats: MCPWorkspaceStats | undefined;
    let mcpPromptRuntime: MCPPromptRuntime | undefined;
    let mcpSetupDurationMs = 0;

    if (this.dependencies.bindings.mcpServerManager) {
      const mcpServerManager = this.dependencies.bindings.mcpServerManager;
      const mcpToolSetupStartedAt = Date.now();
      try {
        const result = await mcpServerManager.getToolsForWorkspace({
          workspaceId,
          projectPath: metadata.projectPath,
          runtime,
          workspacePath,
          trusted: projectTrusted,
          overrides: mcpOverrides,
          projectSecrets: await secretsToRecord(projectSecrets),
          agentPlugins: agentPluginsMcpContext,
        });

        mcpTools = result.tools;
        mcpToolServerNames = result.toolServerNames;
        mcpStats = result.stats;
        // Omit the tool when no prompts exist to avoid adding unused schema context.
        if (result.promptDescriptors.length > 0) {
          mcpPromptRuntime = {
            prompts: result.promptDescriptors,
            getPrompt: (serverName, promptName, args, options) =>
              mcpServerManager.getPrompt(workspaceId, serverName, promptName, args, options),
          };
        }
      } catch (error) {
        workspaceLog.error("Failed to start MCP servers", { error });
      } finally {
        mcpSetupDurationMs = Date.now() - mcpToolSetupStartedAt;
        startupPhaseTimingsMs.mcpToolSetupMs = mcpSetupDurationMs;
      }
    }

    // Tool search (tool-search experiment): assembly-time gate. The runtime
    // holder makes getToolsForModel create the tool_catalog_search tool; its `state`
    // is assigned only after policy filtering builds the deferred catalog
    // (see prepareToolSearch below). Without MCP tools there is nothing to
    // defer, so the feature stays fully inactive.
    const toolSearchRuntime: ToolSearchRuntime | undefined =
      toolSearchExperimentEnabled && Object.keys(mcpTools ?? {}).length > 0 ? {} : undefined;

    const createTempDirForStreamStartedAt = Date.now();
    const runtimeTempDir = await this.dependencies.streamManager.createTempDirForStream(
      streamToken,
      runtime
    );
    resources.cleanupTemp = async () => {
      const removed = await execBuffered(
        runtime,
        `rm -rf ${shellQuote(path.basename(runtimeTempDir))}`,
        {
          cwd: path.dirname(runtimeTempDir),
          timeout: 10,
        }
      );
      if (removed.exitCode !== 0)
        log.warn("Failed to remove unstarted request directory", {
          runtimeTempDir,
          stderr: removed.stderr,
        });
    };
    recordStartupPhaseTiming("createTempDirForStreamMs", createTempDirForStreamStartedAt);

    const readToolInstructionsStartedAt = Date.now();
    const toolInstructions = await readToolInstructions(
      metadata,
      runtime,
      workspacePath,
      capabilityModelString,
      agentSystemPromptSections,
      cfg.projects,
      claudeSkillsCompatExperimentEnabled
    );
    recordStartupPhaseTiming("readToolInstructionsMs", readToolInstructionsStartedAt);

    // Calculate cumulative session costs for MUX_COSTS_USD env var
    let sessionCostsUsd: number | undefined;
    const loadSessionUsageStartedAt = Date.now();
    if (this.dependencies.sessionUsageService) {
      const sessionUsage = await this.dependencies.sessionUsageService.getSessionUsage(workspaceId);
      if (sessionUsage) {
        const allUsage = sumUsageHistory(Object.values(sessionUsage.byModel));
        sessionCostsUsd = getTotalCost(allUsage);
      }
    }
    recordStartupPhaseTiming("loadSessionUsageMs", loadSessionUsageStartedAt);

    emitStartupBreadcrumb("loading_tools");
    assert(workspaceId.trim().length > 0, "streamMessage requires a non-empty workspaceId");
    if (advisorExperimentEnabled && agentAdvisorEnabled && advisorModelString.length === 0) {
      workspaceLog.warn("Advisor tool enabled for agent without advisorModelString; suppressing", {
        effectiveAgentId,
      });
    }
    if (advisorToolEligible) {
      assert(
        advisorModelString.length > 0,
        "advisorModelString must be non-empty when advisor is eligible"
      );
    }
    // Mutable ref updated by StreamManager.prepareStep so the advisor tool reads the live
    // transcript lazily at execute time instead of capturing a stale snapshot here.
    const advisorTranscriptRef: { messages?: ModelMessage[] } = {};
    const advisorStepCaptureRef: AdvisorStepCaptureRef = {
      currentStepText: "",
      currentStepReasoning: "",
      frozenSnapshotsByToolCallId: new Map(),
    };
    const onAdvisorChunk: StreamTextOnChunk = ({ chunk }) => {
      switch (chunk.type) {
        case "text-delta": {
          // Providers/SDKs can stream advisor text deltas under different field names.
          const chunkText = extractChunkDeltaText(chunk as Record<string, unknown>, [
            "textDelta",
            "delta",
            "text",
          ]);
          if (chunkText.length > 0) {
            advisorStepCaptureRef.currentStepText += chunkText;
          }
          return;
        }
        case "reasoning-delta": {
          // Anthropic signature updates can arrive as reasoning deltas without text.
          const chunkText = extractChunkDeltaText(chunk as Record<string, unknown>, [
            "text",
            "textDelta",
            "delta",
          ]);
          if (chunkText.length > 0) {
            advisorStepCaptureRef.currentStepReasoning += chunkText;
          }
          return;
        }
        case "tool-call": {
          if (chunk.toolName !== "advisor") {
            return;
          }
          const toolCallId = chunk.toolCallId?.trim?.() ?? "";
          // Skip malformed tool calls defensively — the normal tool-error
          // path will handle bad input; crashing the stream callback would
          // be worse than missing the snapshot.
          if (
            toolCallId.length === 0 ||
            !isPlainObject(chunk.input) ||
            advisorStepCaptureRef.frozenSnapshotsByToolCallId.has(toolCallId)
          ) {
            return;
          }
          advisorStepCaptureRef.frozenSnapshotsByToolCallId.set(toolCallId, {
            toolCallId,
            toolName: "advisor",
            input: { ...chunk.input },
            stepText: advisorStepCaptureRef.currentStepText,
            stepReasoning: advisorStepCaptureRef.currentStepReasoning,
          });
          return;
        }
        default:
          return;
      }
    };
    // Normalize: undefined -> default, null -> unlimited, positive int -> exact cap.
    const advisorMaxUses =
      cfg.advisorMaxUsesPerTurn === null
        ? null
        : (cfg.advisorMaxUsesPerTurn ?? ADVISOR_DEFAULT_MAX_USES_PER_TURN);
    assert(
      cfg.advisorMaxOutputTokens == null ||
        (Number.isInteger(cfg.advisorMaxOutputTokens) && cfg.advisorMaxOutputTokens > 0),
      "advisorMaxOutputTokens must be null, undefined, or a positive integer"
    );
    const advisorMaxOutputTokens =
      cfg.advisorMaxOutputTokens != null && cfg.advisorMaxOutputTokens > 0
        ? cfg.advisorMaxOutputTokens
        : undefined;
    // Clamp the persisted advisor thinking level so the tool metadata matches the
    // providerOptions actually sent to generateText().
    const advisorReasoningLevel = enforceThinkingPolicy(
      advisorModelString,
      cfg.advisorThinkingLevel ?? THINKING_LEVEL_OFF,
      undefined,
      this.dependencies.providerService.getConfig()
    );
    const runtimeType = getRuntimeType(metadata.runtimeConfig);
    const xumEnv = getXumEnv(metadata.projectPath, runtimeType, metadata.name, {
      workspaceId,
      modelString,
      thinkingLevel: thinkingLevel ?? "off",
      costsUsd: sessionCostsUsd,
    });
    const getWorkflowProjectTrusted = () =>
      isWorkspaceProjectTrusted(this.dependencies.config, metadata);

    const workflowService =
      dynamicWorkflowsExperimentEnabled && this.dependencies.bindings.taskService != null
        ? new WorkflowService({
            runStore: new WorkflowRunStore({
              sessionDir: path.join(this.dependencies.config.sessionsDir, workspaceId),
            }),
            // This build's settled markers are keyed by the run's terminal generation, so
            // a resumed run re-arms attention by itself; only the downgrade-compat stable
            // marker needs clearing when the run leaves terminal state.
            onRunStatusChanged: async (event) => {
              if (!isTerminalWorkflowRunStatus(event.status)) {
                await this.dependencies.bindings.taskService?.clearWorkflowRunDowngradeSettlement({
                  ownerWorkspaceId: event.workspaceId,
                  runId: event.runId,
                });
              }
              await this.dependencies.bindings.onWorkflowRunStatusChanged?.(event);
            },
            runtimeFactory: new QuickJSRuntimeFactory(),
            taskAdapterFactory: (runId, workflowName) =>
              new WorkflowTaskServiceAdapter({
                taskService: this.dependencies.bindings.taskService!,
                parentWorkspaceId: workspaceId,
                workflowRunId: runId,
                workflowName,
                defaultAgentId: DEFAULT_WORKFLOW_AGENT_ID,
                patchToolConfig: {
                  workspaceId,
                  cwd: workspacePath,
                  runtime,
                  runtimeTempDir,
                  workspaceSessionDir: path.join(this.dependencies.config.sessionsDir, workspaceId),
                  trusted: getWorkflowProjectTrusted(),
                },
                getProjectTrusted: getWorkflowProjectTrusted,
                experiments: {
                  ...experiments,
                  dynamicWorkflows: dynamicWorkflowsExperimentEnabled,
                  workspaceHeartbeats: workspaceHeartbeatsExperimentEnabled,
                },
              }),
            resolveWorkflowScript: (scriptPath) =>
              resolveWorkflowScript({
                scriptPath,
                runtime,
                workspacePath,
                projectSearchRoot: projectCheckoutRoot ?? workspacePath,
                projectTrusted: getWorkflowProjectTrusted(),
                includeAgentPlugins: this.dependencies.isAgentPluginsEnabled(),
                skillStorageContext: workflowSkillStorageContext,
              }),
            // Background workflow tools outlive the model turn that started them. Feed the
            // terminal result back as a hidden user turn so the parent agent continues
            // instead of leaving the user staring at the workflow report payload.
            onBackgroundRunTerminal: async ({ runId, status, result, run }) => {
              if (run.parentWorkflow != null) {
                return;
              }
              if (this.dependencies.bindings.taskService != null) {
                this.dependencies.bindings.taskService.noteWorkflowRunTerminalAttention({
                  ownerWorkspaceId: workspaceId,
                  runId,
                  status,
                });
                return;
              }

              const continuationSender =
                this.dependencies.bindings.workflowResultContinuationSender;
              if (continuationSender == null) {
                log.warn("Workflow completed but no continuation sender is configured", {
                  workspaceId,
                  runId,
                });
                return;
              }

              const scriptPath = run.workflow.sourcePath ?? run.workflow.name;
              const rawCommand = `workflow_run ${scriptPath}`;
              const workflowResultMessage = buildWorkflowResultContextMessage({
                rawCommand,
                name: scriptPath,
                runId,
                status,
                result,
                run,
              });
              for (;;) {
                const invocationCurrent = await continuationSender.isWorkflowInvocationCurrent(
                  workspaceId,
                  runId
                );
                if (!invocationCurrent) {
                  if (this.dependencies.isStreaming(workspaceId)) {
                    await waitForWorkflowContinuationRetry();
                    continue;
                  }
                  log.debug("Skipping superseded workflow continuation", { workspaceId, runId });
                  return;
                }

                const sendResult = await continuationSender.sendMessage(
                  workspaceId,
                  workflowResultMessage,
                  {
                    model: modelString,
                    thinkingLevel: effectiveThinkingLevel,
                    // Carry the turn's pro mode so the workflow-result
                    // continuation does not silently drop back to standard.
                    reasoningMode,
                    agentId: effectiveAgentId,
                    toolPolicy: effectiveToolPolicy,
                    additionalSystemInstructions: scratchpadAdditionalSystemInstructions,
                    maxOutputTokens,
                    providerOptions: effectiveMuxProviderOptions,
                    experiments: {
                      ...experiments,
                      dynamicWorkflows: dynamicWorkflowsExperimentEnabled,
                      workspaceHeartbeats: workspaceHeartbeatsExperimentEnabled,
                    },
                    skipAiSettingsPersistence: true,
                    muxMetadata: {
                      type: WORKFLOW_RESULT_METADATA_TYPE,
                      rawCommand,
                      commandPrefix: "workflow_run",
                      runId,
                      requestedModel: modelString,
                    },
                  },
                  {
                    skipAutoResumeReset: true,
                    synthetic: true,
                    agentInitiated: true,
                    requireIdle: true,
                    startStreamInBackground: true,
                  }
                );
                if (sendResult.success) {
                  return;
                }
                if (!isWorkspaceBusyIdleOnlySend(sendResult.error)) {
                  log.warn("Failed to continue agent after workflow completion", {
                    workspaceId,
                    runId,
                    error: sendResult.error,
                  });
                  return;
                }
                await waitForWorkflowContinuationRetry();
              }
            },
            getCurrentProjectTrusted: () =>
              isWorkspaceProjectTrusted(this.dependencies.config, metadata),
            runnerId: `workflow-runner:${workspaceId}`,
          })
        : undefined;

    // Create assistant message ID early so tool-side usage reporting and nested tool events
    // stay scoped to this specific assistant turn. The placeholder is appended to history below
    // (after the abort check).
    const assistantMessageId = createAssistantMessageId();
    const allowLegacyInvalidWorkflowAgentOutputSchema =
      await this.dependencies.shouldAllowLegacyInvalidWorkflowAgentOutputSchema(metadata);
    // Share creation-time provider/pricing snapshots for both headless tools.
    const createToolModel = async (ms: string, toolThinkingLevel?: ThinkingLevel) => {
      const toolModelString = ms.trim();
      assert(
        toolModelString.length > 0,
        "tool model string must be non-empty when creating a tool model"
      );
      const created = await this.dependencies.providerModelFactory.createModelWithPinnedOptions(
        toolModelString,
        { thinkingLevel: toolThinkingLevel, workspaceId, agentInitiated: true }
      );
      if (!created.success) {
        throw new Error(`Failed to create tool model: ${getErrorMessage(created.error)}`);
      }
      return created.data;
    };
    // Hoisted so refusal fallback can rebuild tools without changing their context.
    const toolsForModelConfig: ToolConfiguration = {
      cwd: workspacePath,
      runtime,
      projects: getProjects(metadata),
      secrets: await secretsToRecord(projectSecrets),
      xumEnv,
      runtimeTempDir,
      ...(advisorToolEligible
        ? {
            advisorRuntime: {
              advisorModelString,
              reasoningLevel: advisorReasoningLevel,
              reasoningMode: cfg.advisorReasoningMode,
              maxUsesPerTurn: advisorMaxUses,
              maxOutputTokens: advisorMaxOutputTokens,
              getTranscriptSnapshot: () => {
                const messages = advisorTranscriptRef.messages;
                assert(
                  messages != null,
                  "advisor transcript ref must be populated before advisor execution"
                );
                return messages;
              },
              takeToolCallSnapshot: (toolCallId) => {
                const normalizedToolCallId = toolCallId.trim();
                assert(normalizedToolCallId.length > 0, "advisor toolCallId must be non-empty");
                const snapshot =
                  advisorStepCaptureRef.frozenSnapshotsByToolCallId.get(normalizedToolCallId);
                if (snapshot == null) {
                  return undefined;
                }
                const didDelete =
                  advisorStepCaptureRef.frozenSnapshotsByToolCallId.delete(normalizedToolCallId);
                assert(didDelete, "advisor tool-call snapshot must be deleted when consumed");
                assert(snapshot.toolName === "advisor", "advisor snapshot must belong to advisor");
                return snapshot;
              },
              createModel: createToolModel,
              abortSignal: combinedAbortSignal,
            },
          }
        : {}),
      ...(intuitionSettings
        ? {
            intuitionRuntime: {
              modelString: intuitionSettings.model,
              thinkingLevel: intuitionSettings.thinkingLevel,
              maxUsesPerTurn: MEMORY_INTUITION_MAX_USES_PER_TURN,
              usesThisTurn: 0,
              createModel: (ms) => createToolModel(ms, intuitionSettings.thinkingLevel),
              resolveAgentBody: () => Promise.resolve(intuitionDefinition?.body ?? null),
              abortSignal: combinedAbortSignal,
            },
          }
        : {}),
      ...(toolSearchRuntime ? { toolSearchRuntime } : {}),
      capabilityModelString,
      openaiWireFormat: effectiveMuxProviderOptions?.openai?.wireFormat,
      xaiNativeToolsEnabled: routeProvider === "xai",
      xaiSearchParameters: effectiveMuxProviderOptions.xai?.searchParameters,
      backgroundProcessManager: this.dependencies.backgroundProcessManager,
      // Plan agent configuration for plan file access.
      // - read: plan file is readable in all agents (useful context)
      // - write: allowed in all agents; plan agents still lock other edits to the exact plan path
      planFileOnly: agentIsPlanLike,
      emitChatEvent: (event) => {
        // Defensive: tools should only emit events for the workspace they belong to.
        if ("workspaceId" in event && event.workspaceId !== workspaceId) {
          return;
        }
        if (event.type === "workflow-run-attached") {
          return this.dependencies.streamManager.attachWorkflowRunToToolCall(event).then(() => {
            this.dependencies.emit(event.type, event as never);
          });
        }
        this.dependencies.emit(event.type, event as never);
      },
      workspaceProjectPath: metadata.projectPath,
      workspaceExecutionRootPath: metadata.subProjectPath ?? metadata.projectPath,
      workspaceSessionDir: path.join(this.dependencies.config.sessionsDir, workspaceId),
      planFilePath,
      ancestorPlanFilePaths,
      workspaceId,
      agentId: effectiveAgentId,
      strictAgentResolution,
      xumScope,
      timelineService: timelineExperimentEnabled
        ? this.dependencies.bindings.timelineService
        : undefined,
      workspaceHeartbeatService: this.dependencies.bindings.workspaceHeartbeatService,
      workflowService,
      goalService: workspaceGoalService,
      goalDefaults: effectiveGoalDefaults,
      enableGoalTools: goalToolAvailability,
      // Only child workspaces (tasks) can report to a parent.
      enableAgentReport: Boolean(metadata.parentWorkspaceId),
      // RLM family messaging: gate on the flags persisted on the task record at
      // spawn — NOT the live send-options experiments — so a child spawned under RLM
      // keeps task_message_parent/task_message_sibling across app restarts and
      // frontend experiment toggles. Uses the full RLM predicate (rlm AND a PTC
      // parent) rather than the bare rlm bit: the hidden sub-flag can stay true
      // after its parent is disabled, and such children run outside RLM. Workflow-
      // owned workers are excluded: they hand results to WorkflowRunner through the
      // journal path.
      enableFamilyMessaging:
        Boolean(metadata.parentWorkspaceId) &&
        metadata.workflowTask == null &&
        isRlmModeEnabled(
          findWorkspaceEntry(cfg, workspaceId)?.workspace.taskExperiments,
          undefined
        ),
      workflowAgentOutputSchema: metadata.workflowTask?.outputSchema,
      allowLegacyInvalidWorkflowAgentOutputSchema,
      recordFileState,
      reportModelUsage: (event) => {
        try {
          const eventModel = event.model.trim();
          assert(eventModel.length > 0, "tool model usage event model must be non-empty");
          // Persist tool-side model usage under its own model bucket so session costs keep
          // advisor/system-side pricing separate from the parent chat model.
          const providerMetadata = event.providerMetadata;
          // Prefer the creation-time identity captured when the tool model
          // was created; models not created through the tool runtime fall
          // back to live resolution (their identity is not coder-scoped).
          const pinnedMetadataModel = event.metadataModel;
          const metadataModel =
            pinnedMetadataModel ??
            resolveModelForMetadata(eventModel, this.dependencies.providerService.getConfig());
          this.dependencies.streamManager.recordToolModelUsage(workspaceId, assistantMessageId, {
            toolName: event.toolName,
            toolCallId: event.toolCallId,
            timestamp: event.timestamp,
            model: eventModel,
            metadataModel,
            usage: event.usage,
            ...(providerMetadata != null ? { providerMetadata } : {}),
          });
          void (async () => {
            try {
              if (!this.dependencies.sessionUsageService) {
                return;
              }
              const displayUsage = createDisplayUsage(
                event.usage,
                eventModel,
                providerMetadata,
                metadataModel
              );
              if (!displayUsage) {
                return;
              }
              // Ledger keys resolve Coder identities to their record-time
              // metadata identity — the CREATION-TIME pin when available,
              // mirroring StreamManager.recordSessionUsage. Non-coder
              // models keep the canonical key (their metadata identity can
              // be a mappedToModel pricing alias, not the ledger bucket).
              const canonicalModel =
                eventModel.startsWith("coder:") && pinnedMetadataModel
                  ? pinnedMetadataModel
                  : normalizeUsageModelKey(
                      eventModel,
                      this.dependencies.providerService.getConfig()
                    );
              await this.dependencies.sessionUsageService.recordUsage(
                workspaceId,
                canonicalModel,
                displayUsage
              );
              this.dependencies.emit("session-usage-delta", {
                type: "session-usage-delta" as const,
                workspaceId,
                sourceWorkspaceId: workspaceId,
                byModelDelta: { [canonicalModel]: displayUsage },
                timestamp: Date.now(),
              });
            } catch (error) {
              log.warn("Failed to record tool model usage", {
                error,
                workspaceId,
                toolName: event.toolName,
                model: event.model,
              });
            }
          })();
        } catch (error) {
          log.warn("Failed to record tool model usage", {
            error,
            workspaceId,
            toolName: event.toolName,
            model: event.model,
          });
        }
      },
      onConfigChanged: () => this.dependencies.providerService.notifyConfigChanged(),
      taskService: this.dependencies.bindings.taskService,
      workspaceTurnManager: this.dependencies.bindings.workspaceTurnManager,
      analyticsService: this.dependencies.bindings.analyticsService,
      desktopSessionManager: this.dependencies.bindings.desktopSessionManager,
      // Agent memory (memory experiment): per-scope write policy derived from
      // the agent class (exec-like / plan-like / read-only). Project memory is
      // host-local under xumHome, keyed by the stable project identity.
      historyService: this.dependencies.historyService,
      memoryService: this.dependencies.bindings.memoryService,
      memoryAccess,
      // Experiments for inheritance to subagents and workflow tool gating.
      experiments: {
        ...experiments,
        dynamicWorkflows: dynamicWorkflowsExperimentEnabled,
        memory: memoryExperimentEnabled,
        timeline: timelineExperimentEnabled,
        workspaceHeartbeats: workspaceHeartbeatsExperimentEnabled,
        toolSearch: toolSearchExperimentEnabled,
        claudeSkillsCompat: claudeSkillsCompatExperimentEnabled,
        agentPlugins: agentPluginsExperimentEnabled,
      },
      // Dynamic context for tool descriptions (moved from system prompt for better model attention)
      availableSubagents: agentDefinitions,
      availableSkills,
      mcpPromptRuntime,
      // Session-segment memory index advertised in the memory tool
      // description (same disclosure mechanic as skills).
      memoryIndexEntries: memoryContext?.indexEntries,
      // Trust gating: only run hooks/scripts when the full shared workspace runtime is trusted.
      trusted: sharedExecutionTrusted,
    };
    const emitNestedPtcToolEvent = (event: PTCEventWithParent) => {
      if (event.type === "tool-call-start" || event.type === "tool-call-end") {
        this.dependencies.streamManager.emitNestedToolEvent(workspaceId, assistantMessageId, event);
      }
    };
    const kernelFileLoader = createKernelFileLoader({
      cwd: toolsForModelConfig.cwd,
      runtime: toolsForModelConfig.runtime,
      hooks: deriveToolHookConfig(toolsForModelConfig) ?? undefined,
    });
    const ptcEnabled = experiments?.programmaticToolCalling === true;
    const mcpWarningPrefix = mcpStats
      ? formatMcpWarningPrefix(mcpStats.failedServerCount, mcpStats.failedServerNames)
      : undefined;
    if (mcpWarningPrefix != null) {
      workspaceLog.warn("MCP servers failed to start", {
        failedNames: mcpStats?.failedServerNames.join(", "),
      });
    }

    type ModelSeed = typeof modelResult.data;
    const prepareModelRequest = async (options: {
      seed: ModelSeed;
      sourceMessages: MuxMessage[];
      providerRequestMessages?: MuxMessage[];
      initializeToolSearch: boolean;
      reusePrePolicySystemContext: boolean;
      requestHistorySequence: () => number;
      partialContinuationMessage?: MuxMessage;
      recordTimings?: boolean;
      cleanupModelOnError?: boolean;
    }) => {
      const { seed } = options;
      try {
        const attemptProviderRequestMessages =
          options.providerRequestMessages ??
          prepareProviderRequestMessages(
            options.sourceMessages,
            seed.wireProviderName,
            seed.effectiveThinkingLevel
          ).providerRequestMessages;

        const getToolsStartedAt = Date.now();
        const allTools = await getToolsForModel(
          seed.toolsModelString,
          {
            ...toolsForModelConfig,
            capabilityModelString: seed.capabilityModelString,
            openaiWireFormat: effectiveMuxProviderOptions.openai?.wireFormat,
            xaiNativeToolsEnabled: seed.routeProvider === "xai",
          },
          workspaceId,
          this.dependencies.initStateManager,
          toolInstructions,
          mcpTools
        );
        if (options.recordTimings) {
          recordStartupPhaseTiming("getToolsForModelMs", getToolsStartedAt);
        }

        // A sub-agent's workspace-scope memory rows point into its task-tree
        // owner's session dir; rollback must admit that root (and only that),
        // and announce its direct-to-disk writes through MemoryService so the
        // shared store's readers refresh.
        const memoryService = this.dependencies.bindings.memoryService;
        const memoryOwnerId =
          memoryService?.resolveWorkspaceMemoryOwnerId(workspaceId) ?? workspaceId;
        const sharedWorkspaceMemorySessionDir =
          memoryOwnerId === workspaceId
            ? undefined
            : path.join(this.dependencies.config.sessionsDir, memoryOwnerId);
        // Resolved per rollback (not per turn): tree membership changes as
        // sub-agents are spawned and removed while the tool instance lives.
        const listSharedWorkspaceMemoryPeerSessionDirs =
          memoryService === undefined
            ? undefined
            : () =>
                sharedWorkspaceMemoryPeerSessionDirs(
                  this.dependencies.config.loadConfigOrDefault(),
                  this.dependencies.config.sessionsDir,
                  workspaceId
                );
        // Built anew for EVERY attempt (prepareModelRequest runs per primary /
        // fallback request) from the never-mutated policy: refinement_rollback
        // reads it by reference, and the request.assemble demotion below only
        // touches this attempt's object, so a fallback whose middleware keeps
        // `memory` starts writable again.
        const attemptSandboxMemory =
          memoryService === undefined
            ? undefined
            : {
                service: memoryService,
                ctx: memoryScopeContextFromToolConfig(toolsForModelConfig),
                access: memoryAccess,
              };
        const applyPolicyStartedAt = Date.now();
        let attemptTools = await applyToolPolicyAndExperiments({
          allTools: this.dependencies.wrapToolsForDelegation(
            workspaceId,
            allTools,
            delegatedToolNames
          ),
          extraTools: this.dependencies.bindings.extraTools,
          effectiveToolPolicy,
          experiments,
          emitNestedToolEvent: emitNestedPtcToolEvent,
          sandbox: {
            workspaceId,
            sessionDir: path.join(this.dependencies.config.sessionsDir, workspaceId),
            sharedWorkspaceMemorySessionDir,
            listSharedWorkspaceMemoryPeerSessionDirs,
            memory: attemptSandboxMemory,
            kernelFileLoader,
          },
        });
        if (options.recordTimings) {
          recordStartupPhaseTiming("applyToolPolicyAndExperimentsMs", applyPolicyStartedAt);
        }

        // Intuition's internal memory_read must not bypass a policy denying memory.
        if (attemptTools.memory === undefined) delete attemptTools.intuition;

        if (toolSearchRuntime) {
          if (options.initializeToolSearch) {
            const preparedSearch = prepareToolSearch({
              tools: attemptTools,
              mcpToolNames: Object.keys(mcpTools ?? {}),
              mcpToolServers: mcpToolServerNames,
              toolPolicy: effectiveToolPolicy,
              ptcEnabled,
            });
            attemptTools = preparedSearch.tools;
            if (preparedSearch.state) {
              toolSearchRuntime.state = preparedSearch.state;
            }
          } else if (toolSearchRuntime.state) {
            attemptTools = rebuildToolSearchState(toolSearchRuntime.state, {
              tools: attemptTools,
              mcpToolNames: Object.keys(mcpTools ?? {}),
              mcpToolServers: mcpToolServerNames,
              toolPolicy: effectiveToolPolicy,
              ptcEnabled,
            }).tools;
          } else if (!(mcpTools && TOOL_SEARCH_TOOL_NAME in mcpTools)) {
            const { [TOOL_SEARCH_TOOL_NAME]: _removed, ...rest } = attemptTools;
            attemptTools = rest;
          }
        }

        const intuitionToolAvailable = attemptTools.intuition !== undefined;
        const advisorToolAvailable = attemptTools.advisor !== undefined;
        const memoryToolAvailable = attemptTools.memory !== undefined;
        const memoryContextForModel = await upgradeMemoryContextForModel(
          memoryToolAvailable,
          seed.rawModelString
        );
        const canReuseSystemContext =
          options.reusePrePolicySystemContext &&
          advisorToolAvailable === advisorToolEligible &&
          memoryToolAvailable === memoryToolEligible &&
          intuitionToolAvailable === intuitionToolEligible &&
          memoryContextForModel === memoryContext;
        const rebuildSystemStartedAt = Date.now();
        const systemContext = canReuseSystemContext
          ? prePolicyStreamSystemContext
          : await buildStreamSystemContextForToolset(
              { advisorToolAvailable, memoryToolAvailable, intuitionToolAvailable },
              seed.rawModelString,
              memoryContextForModel
            );
        if (options.recordTimings && !canReuseSystemContext) {
          recordStartupPhaseTiming("rebuildStreamSystemContextMs", rebuildSystemStartedAt);
        }
        let attemptSystem = systemContext.systemMessage;
        let attemptSystemTokens = systemContext.systemMessageTokens;
        if (mcpWarningPrefix != null) {
          attemptSystem = mcpWarningPrefix + attemptSystem;
          const tokenizer = await getTokenizerForModel(
            seed.rawModelString,
            seed.capabilityModelString
          );
          attemptSystemTokens = await tokenizer.countTokens(attemptSystem);
        }

        if (requestAssemblySnapshot || eventSpine.hasMiddleware("request.assemble")) {
          const assembleCtx: RequestAssembleContext = {
            workspaceId,
            modelString: seed.rawModelString,
            systemMessage: attemptSystem,
            tools: attemptTools,
          };
          // An admitted rollover must never drift back to the live registry, including fallbacks.
          if (requestAssemblySnapshot) await requestAssemblySnapshot.run(assembleCtx);
          else await eventSpine.run("request.assemble", assembleCtx);
          attemptTools = assembleCtx.tools;
          if (toolSearchRuntime?.state) {
            attemptTools = rebuildToolSearchState(toolSearchRuntime.state, {
              tools: attemptTools,
              mcpToolNames: Object.keys(mcpTools ?? {}),
              mcpToolServers: mcpToolServerNames,
              toolPolicy: effectiveToolPolicy,
              ptcEnabled,
            }).tools;
          }
          // Middleware may filter tools too, but must not restore policy-denied
          // recall or leave its private memory reader available without memory.
          if (!intuitionToolAvailable || attemptTools.memory === undefined) {
            delete attemptTools.intuition;
          }
          // Nor may it leave refinement_rollback (RLM) as a side door into the
          // notebook once `memory` is gone: the tool reads its memory policy
          // from this per-attempt object by reference, so demote it to
          // view-only the same way tool assembly does for policy-denied memory.
          if (attemptTools.memory === undefined && attemptSandboxMemory !== undefined) {
            attemptSandboxMemory.access = READ_ONLY_ACCESS;
          }
          if (attemptTools.intuition === undefined) {
            assembleCtx.systemMessage = removeIntuitionGuidance(
              assembleCtx.systemMessage,
              attemptTools.memory !== undefined,
              memoryContextForModel?.hotMemoriesBlock
            );
          }
          if (assembleCtx.systemMessage !== attemptSystem) {
            attemptSystem = assembleCtx.systemMessage;
            const tokenizer = await getTokenizerForModel(
              seed.rawModelString,
              seed.capabilityModelString
            );
            attemptSystemTokens = await tokenizer.countTokens(attemptSystem);
          }
        }

        if (options.initializeToolSearch && toolSearchRuntime?.state) {
          seedToolSearchActivationsFromMessages(
            toolSearchRuntime.state,
            attemptProviderRequestMessages
          );
        }
        const toolNamesForSentinel = (
          computeActiveToolNames(toolSearchRuntime?.state) ?? Object.keys(attemptTools)
        ).sort();
        const preparedAttempt = this.prepareModelAttempt({
          rawModelString: seed.rawModelString,
          canonicalModelString: seed.canonicalModelString,
          canonicalProviderName: seed.canonicalProviderName,
          effectiveModelString: seed.effectiveModelString,
          optionsModelString: seed.optionsModelString,
          wireProviderName: seed.wireProviderName,
          routeProvider: seed.routeProvider,
          effectiveThinkingLevel: seed.effectiveThinkingLevel,
          minThinkingLevel: seed.minThinkingLevel,
          providerRequestMessages: attemptProviderRequestMessages,
          muxProviderOptions: effectiveMuxProviderOptions,
          workspaceId,
          truncationMode: openaiTruncationModeOverride,
          providersConfigSnapshot: seed.providersConfig,
          coderSelectedInstance: seed.coderSelectedInstance,
          promptCacheScope: derivePromptCacheScope(metadata),
          reasoningMode,
          ...(options.recordTimings ? { recordStartupPhaseTiming } : {}),
        });
        // Manual cache markers must honor a TTL set through per-model
        // providerOptions extras when the dedicated mux-level setting is
        // unset, matching the pre-assembler request-config behavior.
        const effectiveAnthropicCacheTtl =
          effectiveMuxProviderOptions.anthropic?.cacheTtl ??
          getAnthropicCacheTtl(preparedAttempt.providerOptions);
        const forcedFirstStepToolNames =
          seed.routeProvider === "xai"
            ? getForcedXaiSearchToolNames(
                seed.capabilityModelString,
                effectiveMuxProviderOptions.xai?.searchParameters
              )?.filter((toolName) => toolName in attemptTools)
            : undefined;
        const firstStepToolNames = new Set(
          forcedFirstStepToolNames?.length ? forcedFirstStepToolNames : toolNamesForSentinel
        );
        // Shared by the initial build and thinking rebuilds so their assembly
        // inputs cannot drift apart mid-turn.
        const assemblePayloadForThinkingLevel = (level: ThinkingLevel) =>
          assembleBudgetCheckedPromptPayload(
            {
              history: options.sourceMessages,
              systemMessage: attemptSystem,
              tools: attemptTools,
              modelString: seed.rawModelString,
              routeProvider: seed.routeProvider,
              openaiWireFormat: effectiveMuxProviderOptions.openai?.wireFormat,
              providerForMessages: seed.wireProviderName,
              effectiveThinkingLevel: level,
              effectiveAgentId,
              toolNamesForSentinel,
              planContentForTransition,
              planFilePath,
              postCompactionAttachments,
              providersConfig: seed.providersConfig,
              anthropicCacheTtl: effectiveAnthropicCacheTtl,
              workspaceId,
            },
            {
              enabled: tokenBudgetEnabled,
              providerOptions: effectiveMuxProviderOptions,
              activeTools: [...firstStepToolNames],
            }
          );
        const prepareMessagesForProviderStartedAt = Date.now();
        const attemptPayload = await assemblePayloadForThinkingLevel(seed.effectiveThinkingLevel);
        if (options.recordTimings) {
          recordStartupPhaseTiming(
            "prepareMessagesForProviderMs",
            prepareMessagesForProviderStartedAt
          );
        }
        const finalMessages = attemptPayload.messages;
        const emitEnvelopeWith = async (
          level: string,
          providerOptionsForEnvelope: unknown
        ): Promise<void> => {
          await emitTurnEnvelope({
            journal: this.dependencies.durableEventJournalFor(workspaceId),
            workspaceId,
            systemMessage: attemptSystem,
            tools: Object.fromEntries(
              Object.entries(attemptTools).filter(([name]) => firstStepToolNames.has(name))
            ),
            modelString: seed.rawModelString,
            thinkingLevel: level,
            providerOptions: providerOptionsForEnvelope,
            requestHistorySequence: options.requestHistorySequence(),
            sentinelToolNames: toolNamesForSentinel,
            wireProviderName: seed.wireProviderName,
            anthropicCacheTtl: effectiveAnthropicCacheTtl,
            planContentForTransition,
            planFilePath,
            postCompactionAttachments,
            partialContinuationMessage: options.partialContinuationMessage,
          });
        };
        const rebuildMessagesForThinkingLevel = async (level: ThinkingLevel) => {
          const rebuiltPayload = await assemblePayloadForThinkingLevel(level);
          return rebuiltPayload.messages;
        };
        const rebuildFirstStepForThinkingLevel: RebuildFirstStepForThinkingLevel = async (
          level,
          providerOptionsForEnvelope
        ) => {
          const rebuiltMessages = await rebuildMessagesForThinkingLevel(level);
          await emitEnvelopeWith(level, providerOptionsForEnvelope);
          return rebuiltMessages;
        };

        return {
          ...seed,
          providerRequestMessages: attemptProviderRequestMessages,
          messages: finalMessages,
          system: attemptSystem,
          engineSystem: attemptPayload.system,
          contextBudgetLimit: attemptPayload.contextBudgetLimit,
          systemMessageTokens: attemptSystemTokens,
          tools: attemptTools,
          contextBudgetMemoryWritable:
            memoryAccess.workspace === "readwrite" && attemptTools.memory !== undefined,
          engineTools: attemptPayload.tools ?? attemptTools,
          toolNamesForSentinel,
          forcedFirstStepToolNames,
          providerOptions: preparedAttempt.providerOptions,
          headers: preparedAttempt.requestHeaders,
          resolvedOverrides: preparedAttempt.resolvedOverrides,
          currentEffectiveLevelRef: preparedAttempt.currentEffectiveLevelRef,
          computeRebuiltProviderOptions: preparedAttempt.computeRebuiltProviderOptions,
          rebuildProviderOptionsForThinkingLevel:
            preparedAttempt.rebuildProviderOptionsForThinkingLevel,
          rebuildMessagesForThinkingLevel,
          emitEnvelopeWith,
          onStreamConstructed: () =>
            emitEnvelopeWith(seed.effectiveThinkingLevel, preparedAttempt.providerOptions),
          rebuildFirstStepForThinkingLevel,
        };
      } catch (error) {
        if (options.cleanupModelOnError) {
          runLanguageModelCleanup(options.seed.model);
        }
        throw error;
      }
    };

    let requestHistorySequence = providerRequestMessages.reduce(
      (latest, message) => Math.max(latest, message.metadata?.historySequence ?? -1),
      -1
    );
    emitStartupBreadcrumb("preparing_request");
    let primaryRequest: Awaited<ReturnType<typeof prepareModelRequest>>;
    try {
      primaryRequest = await prepareModelRequest({
        seed: modelResult.data,
        sourceMessages: messages,
        providerRequestMessages,
        initializeToolSearch: true,
        reusePrePolicySystemContext: true,
        requestHistorySequence: () => requestHistorySequence,
        recordTimings: true,
      });
    } catch (error) {
      if (error instanceof ContextBudgetExceededError) {
        runLanguageModelCleanup(modelResult.data.model);
        return { type: "finished", result: Err(error.details) };
      }
      throw error;
    }
    const tools = primaryRequest.tools;
    systemMessage = primaryRequest.system;
    systemMessageTokens = primaryRequest.systemMessageTokens;
    const finalMessages = primaryRequest.messages;
    // Debug sinks pair systemMessage with the message list, so when the
    // assembler embedded the system prompt as a leading cached row
    // (engineSystem undefined), drop that row to keep the system prompt
    // single-sourced in captures.
    const debugViewMessages =
      primaryRequest.engineSystem == null && finalMessages[0]?.role === "system"
        ? finalMessages.slice(1)
        : finalMessages;

    captureMcpToolTelemetry({
      telemetryService: this.dependencies.telemetryService,
      mcpStats,
      mcpTools,
      tools,
      mcpSetupDurationMs,
      workspaceId,
      modelString,
      effectiveAgentId,
      metadata,
      effectiveToolPolicy,
    });

    if (combinedAbortSignal.aborted) {
      return {
        type: "finished",
        result: Ok(
          this.dependencies.createAbortedTurnHandle(assistantMessageId, combinedAbortSignal)
        ),
      };
    }

    let started = false;
    const start = async (
      thinkingOverride?: ActiveTurnThinkingOverride
    ): Promise<TurnRequestBuildOutcome> => {
      assert(!started && !transferred, "Prepared request must be started once before disposal");
      started = true;
      activeTurnThinkingOverride = thinkingOverride;
      if (context.admissionOnly)
        requestHistorySequence = messages.reduce(
          (latest, row) => Math.max(latest, row.metadata?.historySequence ?? -1),
          -1
        );
      if (combinedAbortSignal.aborted)
        return {
          type: "finished",
          result: Ok(
            this.dependencies.createAbortedTurnHandle(assistantMessageId, combinedAbortSignal)
          ),
        };
      // Final toolset of the request being started: request.assemble
      // middleware ran inside prepareModelRequest, and `memory` is a built-in
      // that tool search never defers, so its absence means denied. The deny
      // lands now; the grant waits for onStreamStarted (see
      // persistWorkspaceMemoryWritable).
      const finalWorkspaceMemoryWritable = workspaceMemoryWritable && tools.memory !== undefined;
      if (!finalWorkspaceMemoryWritable && !(await persistWorkspaceMemoryWritable(false))) {
        const errorEvent = createErrorEvent(workspaceId, {
          messageId: createAssistantMessageId(),
          error: WORKSPACE_MEMORY_POLICY_PERSIST_ERROR,
          errorType: "unknown",
          acpPromptId,
        });
        if (!context.admissionOnly) this.dependencies.emit("error", errorEvent);
        onPreStartError?.(errorEvent);
        return {
          type: "finished",
          result: Err({ type: "unknown", raw: WORKSPACE_MEMORY_POLICY_PERSIST_ERROR }),
        };
      }
      const assistantMessage = createMuxMessage(assistantMessageId, "assistant", "", {
        ...(requestHistorySequence >= 0 ? { requestHistorySequence } : {}),
        timestamp: Date.now(),
        model: canonicalModelString,
        routedThroughGateway,
        systemMessageTokens,
        agentId: effectiveAgentId,
      });

      const appendResult = await this.dependencies.historyService.appendToHistory(
        workspaceId,
        assistantMessage
      );
      if (!appendResult.success) {
        return { type: "finished", result: Err({ type: "unknown", raw: appendResult.error }) };
      }

      const historySequence = assistantMessage.metadata?.historySequence ?? 0;

      // Handle simulated stream scenarios (OpenAI SDK testing features).
      // These emit synthetic stream events without calling an AI provider.
      const forceContextLimitError =
        modelString.startsWith("openai:") &&
        effectiveMuxProviderOptions.openai?.forceContextLimitError === true;
      const simulateToolPolicyNoopFlag =
        modelString.startsWith("openai:") &&
        effectiveMuxProviderOptions.openai?.simulateToolPolicyNoop === true;

      if (forceContextLimitError || simulateToolPolicyNoopFlag) {
        const simulationCtx: SimulationContext = {
          workspaceId,
          assistantMessageId,
          canonicalModelString,
          routedThroughGateway,
          ...(routeProvider != null ? { routeProvider } : {}),
          historySequence,
          systemMessageTokens,
          effectiveAgentId,
          effectiveMode,
          metadataMode: legacyModeForMetadata,
          effectiveThinkingLevel,
          emit: (event, data) => this.dependencies.emit(event, data),
        };

        // Simulations emit their synthetic events before returning, so the
        // handle settles immediately with the matching terminal outcome.
        if (forceContextLimitError) {
          const streamError = await simulateContextLimitError(
            simulationCtx,
            this.dependencies.historyService
          );
          return {
            type: "finished",
            result: Ok(
              this.dependencies.createSettledTurnHandle(assistantMessageId, {
                status: "failed",
                streamError,
              })
            ),
          };
        }
        const streamEnd = await simulateToolPolicyNoop(
          simulationCtx,
          effectiveToolPolicy,
          this.dependencies.historyService
        );
        return {
          type: "finished",
          result: Ok(
            this.dependencies.createSettledTurnHandle(assistantMessageId, {
              status: "completed",
              streamEnd,
            })
          ),
        };
      }

      let requestHeaders = primaryRequest.headers;
      const mergedProviderOptions = primaryRequest.providerOptions;
      const resolvedOverrides = primaryRequest.resolvedOverrides;
      const currentEffectiveLevelRef = primaryRequest.currentEffectiveLevelRef;
      const computeRebuiltProviderOptions = primaryRequest.computeRebuiltProviderOptions;
      const rebuildProviderOptionsForThinkingLevel =
        primaryRequest.rebuildProviderOptionsForThinkingLevel;
      // Debug dump: Log the complete LLM request when MUX_DEBUG_LLM_REQUEST is set
      if (resolveXumEnvironmentValue("DEBUG_LLM_REQUEST", process.env) === "1") {
        log.info(
          `[MUX_DEBUG_LLM_REQUEST] Full LLM request:\n${JSON.stringify(
            {
              workspaceId,
              model: modelString,
              systemMessage,
              messages: debugViewMessages,
              tools: Object.fromEntries(
                Object.entries(tools).map(([n, t]) => [
                  n,
                  { description: t.description, inputSchema: t.inputSchema },
                ])
              ),
              providerOptions: mergedProviderOptions,
              thinkingLevel: effectiveThinkingLevel,
              maxOutputTokens,
              mode: legacyModeForMetadata,
              agentId: effectiveAgentId,
              toolPolicy: effectiveToolPolicy,
            },
            null,
            2
          )}`
        );

        if (resolvedOverrides.standard && Object.keys(resolvedOverrides.standard).length > 0) {
          log.debug("Model parameter overrides (standard):", resolvedOverrides.standard);
        }
        if (resolvedOverrides.providerExtras) {
          log.debug(
            "Model parameter overrides (provider extras):",
            resolvedOverrides.providerExtras
          );
        }
      }

      if (combinedAbortSignal.aborted) {
        await deleteAbortedPlaceholder(assistantMessageId);
        return {
          type: "finished",
          result: Ok(
            this.dependencies.createAbortedTurnHandle(assistantMessageId, combinedAbortSignal)
          ),
        };
      }

      const snapshot: DebugLlmRequestSnapshot = {
        capturedAt: Date.now(),
        workspaceId,
        messageId: assistantMessageId,
        model: modelString,
        providerName: canonicalProviderName,
        thinkingLevel: effectiveThinkingLevel,
        mode: legacyModeForMetadata,
        agentId: effectiveAgentId,
        maxOutputTokens,
        systemMessage,
        messages: debugViewMessages,
      };

      try {
        this.dependencies.lastLlmRequestByWorkspace.set(workspaceId, structuredClone(snapshot));
      } catch (error) {
        const errMsg = getErrorMessage(error);
        workspaceLog.warn("Failed to capture debug LLM request snapshot", { error: errMsg });
      }
      const toolsForStream = primaryRequest.engineTools;

      const devToolsService = this.dependencies.devToolsService;
      const canQueueDevToolsRunMetadata =
        devToolsService?.enabled === true &&
        typeof modelResult.data.model !== "string" &&
        modelResult.data.model.specificationVersion === "v4";

      if (canQueueDevToolsRunMetadata) {
        // Correlate pending run metadata with the specific request that reaches
        // DevTools middleware to avoid cross-request policy leakage. Queue only
        // when middleware is guaranteed to run (LanguageModelV3).
        pendingRunMetadataId = String(streamToken);
        context.startupState.pendingRunMetadataId = pendingRunMetadataId;
        devToolsService.setPendingRunMetadata(workspaceId, pendingRunMetadataId, {
          toolPolicy:
            effectiveToolPolicy != null && effectiveToolPolicy.length > 0
              ? effectiveToolPolicy
              : undefined,
          // Join key for the replay verifier: re-anchors this recorded run to
          // its turn-envelope row and assistant message (see DevToolsRun).
          ...(requestHistorySequence >= 0 ? { requestHistorySequence } : {}),
        });
        this.dependencies.trackPendingDevToolsRunMetadata(
          assistantMessageId,
          workspaceId,
          pendingRunMetadataId
        );
        requestHeaders = {
          ...requestHeaders,
          [DEVTOOLS_RUN_METADATA_ID_HEADER]: pendingRunMetadataId,
        };
      }

      // --- Refusal fallback chain ---
      // Resolved from app config by the RAW selection (metadata-aware inside):
      // a cross-typed Coder instance (coder:openai/x, type anthropic) must use
      // its own gateway-scoped chain, never the direct provider's. Task
      // children can opt out via taskOnRefusal: "fail" (see
      // resolveWorkspaceModelFallbackChain).
      const modelFallbackChain = resolveWorkspaceModelFallbackChain(
        this.dependencies.config.loadConfigOrDefault(),
        workspaceId,
        modelString,
        this.dependencies.providerService.getConfig()
      );

      // Lazily rebuilds the per-model slice of this pipeline (model creation,
      // provider-specific message prep, provider options, headers, parameter
      // overrides) when StreamManager swaps to a fallback model after a
      // refusal. Reusing the original request verbatim would leak
      // provider-specific options/messages across providers.
      const modelFallback: ModelFallbackOptions | undefined =
        modelFallbackChain.length > 0
          ? {
              chain: modelFallbackChain,
              prepare: async (nextModelString, prepareOptions) => {
                const sourceMessages = prepareOptions?.continuation
                  ? replaceOrAppendMessageById(
                      messages,
                      prepareOptions.continuation.assistantMessage
                    )
                  : messages;
                const requestedThinkingLevel =
                  prepareOptions?.thinkingLevelOverride ?? effectiveThinkingLevel;
                const nextSeedResult = await prepareModelSeed({
                  rawModelString: nextModelString,
                  requestedThinkingLevel,
                  minimumThinkingLevelOverride: lookupMinThinkingLevelOverride(
                    this.dependencies.config.loadConfigOrDefault().minThinkingLevelByModel,
                    nextModelString
                  ),
                  enforceMinimum: true,
                });
                if (!nextSeedResult.success) {
                  return Err(formatSendMessageError(nextSeedResult.error).message);
                }

                let nextRequest: Awaited<ReturnType<typeof prepareModelRequest>>;
                try {
                  nextRequest = await prepareModelRequest({
                    seed: nextSeedResult.data,
                    sourceMessages,
                    initializeToolSearch: false,
                    reusePrePolicySystemContext: false,
                    requestHistorySequence: () => requestHistorySequence,
                    partialContinuationMessage: prepareOptions?.continuation?.assistantMessage,
                    cleanupModelOnError: true,
                  });
                } catch (error) {
                  if (error instanceof ContextBudgetExceededError) return Err(error.details);
                  throw error;
                }
                // The fallback runs its own request.assemble pass, which may
                // strip or keep `memory` independently of the primary; the
                // persisted harvest permission must follow the request
                // actually streamed, in both directions. The stream is
                // already running here, so a grant may land immediately.
                if (
                  !(await persistWorkspaceMemoryWritable(
                    workspaceMemoryWritable && nextRequest.tools.memory !== undefined
                  ))
                ) {
                  runLanguageModelCleanup(nextRequest.model);
                  return Err(WORKSPACE_MEMORY_POLICY_PERSIST_ERROR);
                }
                let nextHeaders = nextRequest.headers;
                if (pendingRunMetadataId != null) {
                  nextHeaders = {
                    ...nextHeaders,
                    [DEVTOOLS_RUN_METADATA_ID_HEADER]: pendingRunMetadataId,
                  };
                }

                return Ok({
                  onStreamConstructed: nextRequest.onStreamConstructed,
                  rebuildFirstStepForThinkingLevel: nextRequest.rebuildFirstStepForThinkingLevel,
                  model: nextRequest.model,
                  modelString: nextModelString,
                  messages: nextRequest.messages,
                  system: nextRequest.engineSystem,
                  tools: nextRequest.engineTools,
                  contextBudgetMemoryWritable: nextRequest.contextBudgetMemoryWritable,
                  contextBudgetLimit: nextRequest.contextBudgetLimit,
                  providerOptions: nextRequest.providerOptions,
                  headers: nextHeaders,
                  callSettingsOverrides: nextRequest.resolvedOverrides.standard,
                  thinkingLevel: nextRequest.effectiveThinkingLevel,
                  forcedFirstStepToolNames: nextRequest.forcedFirstStepToolNames,
                  rebuildProviderOptionsForThinkingLevel:
                    nextRequest.rebuildProviderOptionsForThinkingLevel,
                  providersConfig: nextRequest.providersConfig,
                  initialMetadataPatch: {
                    routedThroughGateway: nextRequest.routedThroughGateway,
                    ...(nextRequest.routeProvider != null
                      ? { routeProvider: nextRequest.routeProvider }
                      : {}),
                    systemMessageTokens: nextRequest.systemMessageTokens,
                  },
                });
              },
            }
          : undefined;

      const forcedFirstStepToolNames = primaryRequest.forcedFirstStepToolNames;

      // Fold PREPARING-window pending thinking overrides into the ACTUAL
      // request build, not just the envelope: message preparation is
      // thinking-level-dependent (Anthropic signed-reasoning transforms), so
      // recording the new level while streaming old-level messages would make
      // wire and replay diverge — or send an invalid extended-thinking
      // request. Consuming pending here (applied set below) is safe:
      // createStreamAtomically seeds streamInfo.thinkingLevel from `applied`,
      // and prepareStep simply sees no pending to re-apply.
      // Loop until pending is quiescent: setActiveTurnThinkingLevel can write
      // a NEW pending while the awaited message rebuild runs, and stamping the
      // first level after the await would leave step 0 rebuilding only
      // provider options while the messages stay at the stale level.
      let streamThinkingLevel = effectiveThinkingLevel;
      let streamProviderOptions = mergedProviderOptions;
      let streamFinalMessages = finalMessages;
      while (activeTurnThinkingOverride?.pending != null) {
        const pendingPreparingLevel = activeTurnThinkingOverride.pending;
        activeTurnThinkingOverride.pending = undefined;
        const folded = computeRebuiltProviderOptions(pendingPreparingLevel, streamThinkingLevel);
        if (folded == null) {
          // No-op fold (same effective level / non-foldable variant swap):
          // re-check pending — a change may have raced the previous rebuild.
          continue;
        }
        try {
          streamFinalMessages = await primaryRequest.rebuildMessagesForThinkingLevel(
            folded.effectiveLevel
          );
        } catch (error) {
          if (error instanceof ContextBudgetExceededError) {
            runLanguageModelCleanup(modelResult.data.model);
            await deleteAbortedPlaceholder(assistantMessageId);
            return { type: "finished", result: Err(error.details) };
          }
          throw error;
        }
        streamProviderOptions = folded.providerOptions;
        streamThinkingLevel = folded.effectiveLevel;
        activeTurnThinkingOverride.applied = folded.effectiveLevel;
        // Keep the mid-turn rebuild baseline in sync so a later identical
        // request is correctly treated as a no-op.
        currentEffectiveLevelRef.current = folded.effectiveLevel;
        // Loop re-checks pending: a change during the awaits above re-folds
        // against the level just applied.
      }

      const emitPrimaryEnvelope = (): Promise<void> =>
        primaryRequest.emitEnvelopeWith(streamThinkingLevel, streamProviderOptions);
      emitStartupBreadcrumb("starting_stream");
      const turnExecutionOptions: TurnExecutionOptions = {
        workspaceId,
        messages: streamFinalMessages,
        model: modelResult.data.model,
        modelString,
        historySequence,
        system: primaryRequest.engineSystem,
        runtime,
        messageId: assistantMessageId,
        abortSignal: combinedAbortSignal,
        tools: toolsForStream,
        contextBudgetMemoryWritable: primaryRequest.contextBudgetMemoryWritable,
        contextBudgetLimit: primaryRequest.contextBudgetLimit,
        initialMetadata: {
          ...(requestHistorySequence >= 0 ? { requestHistorySequence } : {}),
          systemMessageTokens,
          timestamp: Date.now(),
          agentId: effectiveAgentId,
          ...(legacyModeForMetadata != null ? { mode: legacyModeForMetadata } : {}),
          routedThroughGateway,
          ...(routeProvider != null ? { routeProvider } : {}),
          ...(muxMetadata !== undefined ? { muxMetadata } : {}),
          ...(acpPromptId != null ? { acpPromptId } : {}),
        },
        providerOptions: streamProviderOptions,
        maxOutputTokens,
        toolPolicy: effectiveToolPolicy,
        providedStreamToken: streamToken,
        hasQueuedMessages,
        onStepSettled,
        workspaceName: metadata.name,
        thinkingLevel: streamThinkingLevel,
        headers: requestHeaders,
        callSettingsOverrides: resolvedOverrides.standard,
        onChunk: advisorToolEligible ? onAdvisorChunk : undefined,
        onStepMessages: advisorToolEligible
          ? (stepMessages) => {
              advisorTranscriptRef.messages = stepMessages;
              advisorStepCaptureRef.currentStepText = "";
              advisorStepCaptureRef.currentStepReasoning = "";
              advisorStepCaptureRef.frozenSnapshotsByToolCallId.clear();
            }
          : undefined,
        providedRuntimeTempDir: runtimeTempDir,
        modelFallback,
        toolSearchState: toolSearchRuntime?.state,
        thinkingOverrideState: activeTurnThinkingOverride,
        rebuildProviderOptionsForThinkingLevel,
        forcedFirstStepToolNames,
        providersConfigSnapshot: requestProvidersConfig,
        onStreamConstructed: emitPrimaryEnvelope,
        rebuildFirstStepForThinkingLevel: primaryRequest.rebuildFirstStepForThinkingLevel,
      };

      const logStartOutcome = (
        outcome: "started" | "stream_start_failed",
        errorType?: string
      ): void => {
        logSlowStreamStartup({
          outcome,
          providerName: canonicalProviderName,
          routeProvider,
          agentId: effectiveAgentId,
          mode: legacyModeForMetadata,
          runtimeType: metadata.runtimeConfig.type,
          ...(errorType != null ? { errorType } : {}),
          toolCount: Object.keys(toolsForStream).length,
          mcpToolCount: Object.keys(mcpTools ?? {}).length,
          mcpFailedServerCount: mcpStats?.failedServerCount ?? 0,
          providerRequestMessageCount: providerRequestMessages.length,
          finalMessageCount: finalMessages.length,
        });
      };

      transferred = true;
      return {
        type: "ready",
        turnExecutionOptions,
        assistantMessageId,
        deleteAbortedPlaceholder,
        logStartOutcome,
        ...(finalWorkspaceMemoryWritable
          ? {
              // Best-effort once streaming: the turn really runs with a
              // writable memory tool, so an unpersisted grant only fails the
              // harvest closed (persistWorkspaceMemoryWritable warns).
              onStreamStarted: async () => {
                await persistWorkspaceMemoryWritable(true);
              },
            }
          : {}),
      };
    };
    retained = true;
    return { type: "prepared", request: { start, [Symbol.asyncDispose]: dispose } };
  }
}

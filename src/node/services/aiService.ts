import * as path from "path";
import { EventEmitter } from "events";
import * as fs from "fs/promises";

import { resolveXumEnvironmentValue } from "@/common/compat/legacyMux";
import assert from "@/common/utils/assert";
import { type LanguageModel, type Tool } from "ai";

import type { ProvidersConfigMap } from "@/common/orpc/types";
import type { Result } from "@/common/types/result";
import { Err, Ok } from "@/common/types/result";
import type { WorkspaceMetadata } from "@/common/types/workspace";
import { ensurePrivateDir } from "@/node/utils/fs";
import {
  TurnRequestBuilder,
  type TurnRequestBuilderBindings,
  resolveMuxProjectRootForHostFs,
  resolveXumToolScope,
  type StreamMessageOptions,
} from "./turnRequestBuilder";
export { replaceOrAppendMessageById } from "./turnRequestBuilder";
export type { StreamMessageOptions } from "./turnRequestBuilder";

import { EXPERIMENT_IDS, type ExperimentId } from "@/common/constants/experiments";
import type { DebugLlmRequestSnapshot } from "@/common/types/debugLlmRequest";

import type { SendMessageError } from "@/common/types/errors";
import type { MuxProviderOptions } from "@/common/types/providerOptions";
import { getSrcBaseDir, isSSHRuntime } from "@/common/types/runtime";
import type { XumToolScope } from "@/common/types/toolScope";
import { cloneToolPreservingDescriptors } from "@/common/utils/tools/cloneToolPreservingDescriptors";
import { ProvidersConfigStore, SecretsStore, type Config } from "@/node/config";
import { ContainerManager } from "@/node/multiProject/containerManager";
import { MultiProjectRuntime } from "@/node/runtime/multiProjectRuntime";
import type { Runtime } from "@/node/runtime/Runtime";
import { createRuntime } from "@/node/runtime/runtimeFactory";
import {
  createRuntimeContextForWorkspace,
  createRuntimeForWorkspace,
  resolveWorkspaceExecutionPath,
  resolveWorkspaceRootPath,
  type WorkspaceRuntimeContext,
} from "@/node/runtime/runtimeHelpers";
import type { BackgroundProcessManager } from "@/node/services/backgroundProcessManager";
import type { PolicyService } from "@/node/services/policyService";
import type { ProviderService } from "@/node/services/providerService";
import { getWorkspacePathHintForProject } from "@/node/services/workspaceProjectRepos";
import {
  sharedDurableEventJournal,
  type DurableEventJournal,
} from "@/node/utils/journal/durableEventJournal";
import type { InitStateManager } from "./initStateManager";
import { log } from "./log";
import {
  StreamManager,
  type TurnCompletion,
  type TurnEngineEvent,
  type TurnStreamHandle,
} from "./streamManager";

import { normalizeToCanonical } from "@/common/utils/ai/models";
import type { DevToolsService } from "@/node/services/devToolsService";
import type { ExperimentsService } from "@/node/services/experimentsService";
import type { TelemetryService } from "@/node/services/telemetryService";
import { delegatedToolCallManager } from "./delegatedToolCallManager";
import type { HistoryService } from "./historyService";
import type { SessionUsageService } from "./sessionUsageService";

import type { ProvidersConfig } from "@/common/config/schemas/providersConfig";
import type { ModelRoutingSnapshot } from "./modelRoutingSnapshot";
import { getCodexOauthProjectPath } from "@/common/utils/providers/codexOauthRouting";
import { getCodexOauthAccountId } from "@/node/utils/codexOauthAuth";
import { getProjects, isMultiProject } from "@/common/utils/multiProject";
import {
  resolveMemoryProjectIdentity,
  type MemorySessionContext,
} from "@/node/services/memoryService";
import { formatHotMemoriesBlock } from "@/node/services/memoryHotSet";
import { WorkspaceMcpOverridesService } from "./workspaceMcpOverridesService";

import type { StreamAbortReason } from "@/common/types/stream";
import { getErrorMessage } from "@/common/utils/errors";
import { validateJsonSchemaSubsetSchema } from "@/common/utils/jsonSchemaSubset";
import { resolveModelForMetadata } from "@/common/utils/providers/modelEntries";
import { WorkflowRunStore } from "@/node/services/workflows/WorkflowRunStore";
import { getTokenizerForModel } from "@/node/utils/main/tokenizer";
import { MockAiStreamPlayer } from "./mock/mockAiStreamPlayer";
import { ProviderModelFactory } from "./providerModelFactory";

export { resolveMuxProjectRootForHostFs };

interface ToolExecutionContext {
  toolCallId?: string;
  abortSignal?: AbortSignal;
}

function isToolExecutionContext(value: unknown): value is ToolExecutionContext {
  if (typeof value !== "object" || value == null || Array.isArray(value)) {
    return false;
  }
  const record = value as Record<string, unknown>;
  return (
    (record.toolCallId == null || typeof record.toolCallId === "string") &&
    (record.abortSignal == null || record.abortSignal instanceof AbortSignal)
  );
}

export class AIService extends EventEmitter {
  private readonly streamManager: StreamManager;
  private readonly turnRequestBuilder: TurnRequestBuilder;
  private readonly historyService: HistoryService;
  private readonly config: Config;
  private readonly workspaceMcpOverridesService: WorkspaceMcpOverridesService;
  private readonly policyService?: PolicyService;
  private readonly telemetryService?: TelemetryService;
  private readonly initStateManager: InitStateManager;
  private mockModeEnabled: boolean;
  public mockAiStreamPlayer?: MockAiStreamPlayer;
  private readonly backgroundProcessManager?: BackgroundProcessManager;
  private readonly sessionUsageService?: SessionUsageService;
  private readonly providerService: ProviderService;
  private readonly providerModelFactory: ProviderModelFactory;
  private readonly devToolsService?: DevToolsService;
  private readonly providersConfigStore: ProvidersConfigStore;
  private readonly experimentsService?: ExperimentsService;

  /**
   * Tracks queued DevTools run metadata by assistant message id so stream-end/abort
   * can clear orphaned entries when a stream starts but never reaches middleware run creation.
   */
  private readonly pendingDevToolsRunMetadataByMessageId = new Map<
    string,
    { workspaceId: string; metadataId: string }
  >();

  // Debug: captured LLM request payloads for last send per workspace
  private lastLlmRequestByWorkspace = new Map<string, DebugLlmRequestSnapshot>();

  constructor(
    config: Config,
    historyService: HistoryService,
    initStateManager: InitStateManager,
    providerService: ProviderService,
    backgroundProcessManager?: BackgroundProcessManager,
    sessionUsageService?: SessionUsageService,
    workspaceMcpOverridesService?: WorkspaceMcpOverridesService,
    policyService?: PolicyService,
    telemetryService?: TelemetryService,
    devToolsService?: DevToolsService,
    experimentsService?: ExperimentsService,
    streamManager?: StreamManager,
    public readonly turnRequestBuilderBindings: TurnRequestBuilderBindings = {},
    providersConfigStore?: ProvidersConfigStore,
    private readonly secretsStore: Pick<SecretsStore, "getEffectiveSecrets"> = new SecretsStore(
      config.rootDir
    )
  ) {
    super();
    // Increase max listeners to accommodate multiple concurrent workspace listeners
    // Each workspace subscribes to stream events, and we expect >10 concurrent workspaces
    this.setMaxListeners(50);
    this.workspaceMcpOverridesService =
      workspaceMcpOverridesService ?? new WorkspaceMcpOverridesService(config);
    this.providersConfigStore = providersConfigStore ?? new ProvidersConfigStore(config.rootDir);
    this.config = config;
    this.historyService = historyService;
    this.initStateManager = initStateManager;
    this.backgroundProcessManager = backgroundProcessManager;
    this.sessionUsageService = sessionUsageService;
    this.policyService = policyService;
    this.telemetryService = telemetryService;
    this.experimentsService = experimentsService;
    this.providerService = providerService;
    this.providerService.onConfigChanged(() => this.emit("providers-config-changed"));
    this.streamManager =
      streamManager ??
      new StreamManager(historyService, sessionUsageService, () =>
        this.providerService.getConfig()
      );
    this.streamManager.setEventSink((event) => this.emitEngineEvent(event));
    this.devToolsService = devToolsService;
    this.providerModelFactory = new ProviderModelFactory(
      config,
      providerService,
      policyService,
      turnRequestBuilderBindings,
      devToolsService,
      this.providersConfigStore
    );
    this.turnRequestBuilder = new TurnRequestBuilder({
      config: this.config,
      providersConfigStore: this.providersConfigStore,
      secretsStore: this.secretsStore,
      historyService: this.historyService,
      initStateManager: this.initStateManager,
      providerService: this.providerService,
      providerModelFactory: this.providerModelFactory,
      streamManager: this.streamManager,
      workspaceMcpOverridesService: this.workspaceMcpOverridesService,
      policyService: this.policyService,
      telemetryService: this.telemetryService,
      backgroundProcessManager: this.backgroundProcessManager,
      sessionUsageService: this.sessionUsageService,
      devToolsService: this.devToolsService,
      experimentsService: this.experimentsService,
      lastLlmRequestByWorkspace: this.lastLlmRequestByWorkspace,
      bindings: this.turnRequestBuilderBindings,
      emit: (event, ...args) => this.emit(event, ...args),
      createAbortedTurnHandle: (messageId, signal) =>
        this.createAbortedTurnHandle(messageId, signal),
      createSettledTurnHandle: (messageId, completion) =>
        this.createSettledTurnHandle(messageId, completion),
      getWorkspaceMetadata: (workspaceId) => this.getWorkspaceMetadata(workspaceId),
      createWorkspaceRuntimeContext: (workspaceId, metadata) =>
        this.createWorkspaceRuntimeContext(workspaceId, metadata),
      isClaudeSkillsCompatEnabled: () => this.isClaudeSkillsCompatEnabled(),
      isAgentPluginsEnabled: () => this.isAgentPluginsEnabled(),
      wrapToolsForDelegation: (workspaceId, tools, delegatedToolNames) =>
        this.wrapToolsForDelegation(workspaceId, tools, delegatedToolNames),
      durableEventJournalFor: (workspaceId) => this.durableEventJournalFor(workspaceId),
      shouldAllowLegacyInvalidWorkflowAgentOutputSchema: (metadata) =>
        this.shouldAllowLegacyInvalidWorkflowAgentOutputSchema(metadata),
      createModel: (modelString, providerOptions, options) =>
        this.createModel(modelString, providerOptions, options),
      isStreaming: (workspaceId) => this.streamManager.isStreaming(workspaceId),
      trackPendingDevToolsRunMetadata: (messageId, workspaceId, metadataId) =>
        this.trackPendingDevToolsRunMetadata(messageId, workspaceId, metadataId),
    });
    void this.ensureSessionsDir();
    this.mockModeEnabled = false;

    if (resolveXumEnvironmentValue("MOCK_AI", process.env) === "1") {
      log.info("AIService running in MUX_MOCK_AI mode");
      this.enableMockMode();
    }
  }

  /**
   * Whether a global experiment is enabled. False when no ExperimentsService was
   * provided (lightweight test setups). Exposed so collaborators constructed with
   * an AIService reference (e.g. AgentSession) can gate experiment-only behavior
   * without threading ExperimentsService through every constructor.
   */
  isExperimentEnabled(experimentId: ExperimentId): boolean {
    return this.experimentsService?.isExperimentEnabled(experimentId) === true;
  }

  /**
   * Build the session-segment memory context: the index snapshot advertised
   * in the memory tool description, plus the hot-memories block (pinned +
   * frequently used memory files; memory-hot-set sub-experiment). Returns
   * null when the memory experiment is off.
   *
   * Callers (AgentSession) cache the result per model and recompute it only
   * on the first use of a model in a session segment, or at compaction
   * boundaries, so repeated turns keep prompt-cache-stable bytes. Memories
   * written mid-segment surface in the next segment's index for cached models
   * (the writing agent already has its own tool calls in context, and `view`
   * lists live state).
   */
  async buildMemorySessionContext(
    workspaceId: string,
    modelString: string,
    options?: { includeHotMemories?: boolean }
  ): Promise<MemorySessionContext | null> {
    if (!this.turnRequestBuilderBindings.memoryService) return null;
    if (this.experimentsService?.isExperimentEnabled(EXPERIMENT_IDS.MEMORY) !== true) {
      return null;
    }
    try {
      const metadataResult = await this.getWorkspaceMetadata(workspaceId);
      if (!metadataResult.success) return null;
      const metadata = metadataResult.data;
      const runtime = createRuntimeForWorkspace(metadata);
      const ctx = {
        runtime,
        checkoutCwd: "",
        workspaceId,
        // Stable per-project identity (handles multi-project workspaces); ""
        // disables project memory when no single project identity exists.
        projectPath: resolveMemoryProjectIdentity(metadata),
      };
      const indexEntries =
        await this.turnRequestBuilderBindings.memoryService.listIndexEntries(ctx);
      // Hot preloading is a sub-experiment: without it, memories stay
      // pull-based like skills (index only, contents fetched on demand).
      let hotMemoriesBlock: string | null = null;
      if (
        options?.includeHotMemories !== false &&
        this.experimentsService?.isExperimentEnabled(EXPERIMENT_IDS.MEMORY_HOT_SET) === true
      ) {
        try {
          const metadataModel = resolveModelForMetadata(
            modelString,
            this.providerService.getConfig()
          );
          const tokenizer = await getTokenizerForModel(modelString, metadataModel);
          const items = await this.turnRequestBuilderBindings.memoryService.listHotMemories(ctx, {
            countTokens: (text) => tokenizer.countTokens(text),
          });
          hotMemoriesBlock = items.length === 0 ? null : formatHotMemoriesBlock(items);
        } catch (error) {
          // Hot preloading is best-effort context. Preserve the pull-based
          // memory index when tokenizer setup or ranked selection fails.
          log.warn("Failed to build hot memories; continuing with memory index only", {
            workspaceId,
            error,
          });
        }
      }
      return { indexEntries, hotMemoriesBlock };
    } catch (error) {
      // Self-healing: memory context is best-effort, never a stream blocker.
      log.warn("Failed to build memory session context", { workspaceId, error });
      return null;
    }
  }

  getProvidersConfig(providersConfig?: ProvidersConfig): ProvidersConfigMap | null {
    return this.providerService.getConfig(providersConfig);
  }

  /** Keep model credentials and compaction limits on one backend-only snapshot for the turn. */
  captureModelRoutingSnapshot(workspaceId?: string, projectPath?: string): ModelRoutingSnapshot {
    // CLI routing config can be temporary. Read credentials from the injected provider store.
    const providersConfig = this.providersConfigStore.loadProvidersConfig() ?? {};
    const workspace = workspaceId ? this.config.findWorkspace(workspaceId) : undefined;
    const routingProjectPath = getCodexOauthProjectPath(workspace) ?? projectPath;
    const appConfig = this.config.loadConfigOrDefault();
    const projectAccountId = routingProjectPath
      ? appConfig.projects.get(routingProjectPath)?.codexOauthAccountId
      : undefined;
    // Copy routing rules before metadata reads. Nested models need their own captured overrides.
    const routeConfig = {
      routePriority: [...(appConfig.routePriority ?? ["direct"])],
      routeOverrides: { ...appConfig.routeOverrides },
    };
    return {
      providersConfig,
      routeConfig,
      metadata: this.getProvidersConfig(providersConfig),
      codexOauthSelection: {
        accountId: getCodexOauthAccountId(providersConfig.openai, projectAccountId),
        explicit:
          projectAccountId !== undefined ||
          providersConfig.openai?.codexOauthDefaultAccountId !== undefined,
      },
    };
  }

  private emitEngineEvent(event: TurnEngineEvent): void | Promise<void> {
    if (event.type === "error") {
      this.clearTrackedPendingDevToolsRunMetadata(event.messageId);
      this.emit("error", event);
      return;
    }

    if (event.type === "stream-end") {
      this.clearTrackedPendingDevToolsRunMetadata(event.messageId);

      try {
        const snapshot = this.lastLlmRequestByWorkspace.get(event.workspaceId);
        if (snapshot) {
          const shouldAttach = snapshot.messageId === event.messageId || snapshot.messageId == null;
          if (shouldAttach) {
            const updated: DebugLlmRequestSnapshot = {
              ...snapshot,
              response: {
                capturedAt: Date.now(),
                metadata: event.metadata,
                parts: event.parts,
              },
            };

            this.lastLlmRequestByWorkspace.set(event.workspaceId, structuredClone(updated));
          }
        }
      } catch (error) {
        const errMsg = getErrorMessage(error);
        log.warn("Failed to capture debug LLM response snapshot", { error: errMsg });
      }

      this.emit("stream-end", event);
      return;
    }

    if (event.type === "stream-abort") {
      this.clearTrackedPendingDevToolsRunMetadata(event.messageId);
      return (async () => {
        try {
          if (event.abandonPartial) {
            await this.historyService.deletePartial(event.workspaceId);
          } else {
            const partial = await this.historyService.readPartial(event.workspaceId);
            if (partial) {
              await this.historyService.commitPartial(event.workspaceId);
              await this.historyService.deletePartial(event.workspaceId);
            }
          }
        } catch (error) {
          log.error("Failed partial cleanup during stream-abort", {
            workspaceId: event.workspaceId,
            error: getErrorMessage(error),
          });
        } finally {
          this.emit("stream-abort", event);
        }
      })();
    }

    this.emit(event.type, event);
  }

  private createSettledTurnHandle(messageId: string, completion: TurnCompletion): TurnStreamHandle {
    return { messageId, completion: Promise.resolve(completion) };
  }

  private createAbortedTurnHandle(messageId: string, signal?: AbortSignal): TurnStreamHandle {
    return this.createSettledTurnHandle(messageId, {
      status: "aborted",
      abortReason: this.streamManager.getStartupAbortReason(signal),
    });
  }

  private trackPendingDevToolsRunMetadata(
    messageId: string,
    workspaceId: string,
    metadataId: string
  ): void {
    assert(messageId.trim().length > 0, "trackPendingDevToolsRunMetadata requires a messageId");
    assert(workspaceId.trim().length > 0, "trackPendingDevToolsRunMetadata requires a workspaceId");
    assert(metadataId.trim().length > 0, "trackPendingDevToolsRunMetadata requires a metadataId");

    this.pendingDevToolsRunMetadataByMessageId.set(messageId, {
      workspaceId,
      metadataId,
    });
  }

  private clearTrackedPendingDevToolsRunMetadata(messageId: string): void {
    // StreamManager can emit stream-abort with an empty messageId during startup races.
    // Treat that as "nothing to clear" instead of throwing so interruptStream remains reliable.
    if (messageId.trim().length === 0) {
      return;
    }

    const pending = this.pendingDevToolsRunMetadataByMessageId.get(messageId);
    if (!pending) {
      return;
    }

    this.pendingDevToolsRunMetadataByMessageId.delete(messageId);
    this.devToolsService?.clearPendingRunMetadata(pending.workspaceId, pending.metadataId);
  }

  private clearTrackedPendingDevToolsRunMetadataById(
    workspaceId: string,
    metadataId: string
  ): void {
    assert(
      workspaceId.trim().length > 0,
      "clearTrackedPendingDevToolsRunMetadataById requires a workspaceId"
    );
    assert(
      metadataId.trim().length > 0,
      "clearTrackedPendingDevToolsRunMetadataById requires a metadataId"
    );

    for (const [messageId, pending] of this.pendingDevToolsRunMetadataByMessageId.entries()) {
      if (pending.workspaceId === workspaceId && pending.metadataId === metadataId) {
        this.pendingDevToolsRunMetadataByMessageId.delete(messageId);
        break;
      }
    }

    this.devToolsService?.clearPendingRunMetadata(workspaceId, metadataId);
  }

  private async shouldAllowLegacyInvalidWorkflowAgentOutputSchema(
    metadata: WorkspaceMetadata
  ): Promise<boolean> {
    const workflowTask = metadata.workflowTask;
    if (workflowTask?.outputSchema === undefined) {
      return false;
    }
    if (
      validateJsonSchemaSubsetSchema(workflowTask.outputSchema, { requireObjectSchema: true })
        .success
    ) {
      return false;
    }
    if (metadata.parentWorkspaceId == null) {
      return false;
    }

    try {
      const runStore = new WorkflowRunStore({
        sessionDir: path.join(this.config.sessionsDir, metadata.parentWorkspaceId),
      });
      const run = await runStore.getRun(workflowTask.runId);
      return run.agentOutputSchemaRequired !== true;
    } catch (error) {
      log.debug("Could not determine legacy workflow agent_report schema policy", {
        workspaceId: metadata.id,
        workflowRunId: workflowTask.runId,
        error: getErrorMessage(error),
      });
      return false;
    }
  }

  private async ensureSessionsDir(): Promise<void> {
    try {
      await ensurePrivateDir(this.config.sessionsDir);
    } catch (error) {
      log.error("Failed to create sessions directory:", error);
    }
  }

  /**
   * Journal for the workspace's session dir — always the process-shared
   * instance so sequence assignment stays coordinated with the sandbox host's
   * vars-snapshot writer (independent instances would corrupt seq ordering).
   */
  private durableEventJournalFor(workspaceId: string): DurableEventJournal {
    return sharedDurableEventJournal(path.join(this.config.sessionsDir, workspaceId));
  }

  isMockModeEnabled(): boolean {
    return this.mockModeEnabled;
  }

  releaseMockStreamStartGate(workspaceId: string): void {
    this.mockAiStreamPlayer?.releaseStreamStartGate(workspaceId);
  }

  enableMockMode(): void {
    this.mockModeEnabled = true;

    this.mockAiStreamPlayer ??= new MockAiStreamPlayer({
      aiService: this,
      historyService: this.historyService,
    });
    this.streamManager.setMockStreamLifecycle(this.mockAiStreamPlayer);
  }

  async getWorkspaceMetadata(workspaceId: string): Promise<Result<WorkspaceMetadata>> {
    try {
      // Read from config.json (single source of truth)
      // getAllWorkspaceMetadata() handles migration from legacy metadata.json files
      const allMetadata = await this.config.getAllWorkspaceMetadata();
      const metadata = allMetadata.find((m) => m.id === workspaceId);

      if (!metadata) {
        return Err(
          `Workspace metadata not found for ${workspaceId}. Workspace may not be properly initialized.`
        );
      }

      return Ok(metadata);
    } catch (error) {
      const message = getErrorMessage(error);
      return Err(`Failed to read workspace metadata: ${message}`);
    }
  }

  /**
   * Create an AI SDK model from a model string (e.g., "anthropic:claude-opus-4-1").
   * Delegates to ProviderModelFactory.
   */
  async createModel(
    modelString: string,
    muxProviderOptions?: MuxProviderOptions,
    opts?: {
      agentInitiated?: boolean;
      workspaceId?: string;
      projectPath?: string;
      /** Snapshot pass-through (see ProviderModelFactory.createModel). */
      providersConfig?: ProvidersConfig;
      modelRoutingSnapshot?: ModelRoutingSnapshot;
    }
  ): Promise<Result<LanguageModel, SendMessageError>> {
    return this.providerModelFactory.createModel(modelString, muxProviderOptions, {
      ...opts,
      providersConfig: opts?.modelRoutingSnapshot?.providersConfig ?? opts?.providersConfig,
      codexOauthSelection: opts?.modelRoutingSnapshot?.codexOauthSelection,
      routeConfig: opts?.modelRoutingSnapshot?.routeConfig,
    });
  }

  /**
   * Create a model AND its pricing/metadata identity from ONE providers.jsonc
   * snapshot. For headless callers (status generation, memory sweeps) that
   * record usage via recordHeadlessUsage: resolving the identity at
   * completion (or from a second read) races catalog refreshes — a Coder
   * instance removed/retagged mid-request would attribute the spend to an
   * unknown or different upstream than the wire the model was created for.
   */
  async createModelWithPinnedMetadata(
    modelString: string,
    opts?: {
      agentInitiated?: boolean;
      workspaceId?: string;
      projectPath?: string;
      modelRoutingSnapshot?: ModelRoutingSnapshot;
    }
  ): Promise<Result<{ model: LanguageModel; metadataModel: string }, SendMessageError>> {
    // Keep model construction and metadata on one route, including callers without an outer snapshot.
    const snapshot =
      opts?.modelRoutingSnapshot ??
      this.captureModelRoutingSnapshot(opts?.workspaceId, opts?.projectPath);
    const providersConfig = snapshot.providersConfig;
    const result = await this.providerModelFactory.createModel(modelString, undefined, {
      ...opts,
      providersConfig,
      codexOauthSelection: snapshot.codexOauthSelection,
      routeConfig: snapshot.routeConfig,
    });
    if (!result.success) {
      return result;
    }
    // The identity must follow the EFFECTIVE route (same snapshot, same
    // resolution createModel dispatched on): a coder: selection whose gateway
    // is unavailable falls away inside createModel (e.g. cross-typed
    // coder:openai/<claude>, type anthropic, creates a direct OpenAI model),
    // and pricing/bucketing from the raw selection would attribute that spend
    // to the instance's type instead of the route that actually served it.
    const effectiveModelString = this.providerModelFactory.resolveEffectiveModelString(
      modelString,
      undefined,
      providersConfig,
      snapshot.routeConfig
    );
    const metadataSeed = effectiveModelString.startsWith("coder:")
      ? modelString
      : normalizeToCanonical(effectiveModelString);
    return Ok({
      model: result.data,
      metadataModel: resolveModelForMetadata(metadataSeed, providersConfig),
    });
  }

  private wrapToolsForDelegation(
    workspaceId: string,
    tools: Record<string, Tool>,
    delegatedToolNames?: string[]
  ): Record<string, Tool> {
    const normalizedDelegatedTools =
      delegatedToolNames
        ?.map((toolName) => toolName.trim())
        .filter((toolName) => toolName.length > 0) ?? [];

    if (normalizedDelegatedTools.length === 0) {
      return tools;
    }

    const delegatedToolSet = new Set(normalizedDelegatedTools);
    const wrappedTools = { ...tools };

    for (const [toolName, tool] of Object.entries(tools)) {
      if (!delegatedToolSet.has(toolName)) {
        continue;
      }

      const toolRecord = tool as Record<string, unknown>;
      const execute = toolRecord.execute;
      if (typeof execute !== "function") {
        continue;
      }

      const wrappedTool = cloneToolPreservingDescriptors(tool);
      const wrappedToolRecord = wrappedTool as Record<string, unknown>;

      wrappedToolRecord.execute = async (_args: unknown, options: unknown) => {
        const executionContext = isToolExecutionContext(options) ? options : undefined;
        const toolCallId = executionContext?.toolCallId?.trim();

        if (executionContext == null || toolCallId == null || toolCallId.length === 0) {
          throw new Error(
            `Delegated tool '${toolName}' requires a non-empty toolCallId in execute context`
          );
        }

        const pendingResult = delegatedToolCallManager.registerPending(
          workspaceId,
          toolCallId,
          toolName
        );

        const abortSignal = executionContext.abortSignal;
        if (abortSignal == null) {
          return pendingResult;
        }

        if (abortSignal.aborted) {
          try {
            delegatedToolCallManager.cancel(workspaceId, toolCallId, "Interrupted");
          } catch {
            // no-op: pending may already have resolved
          }
          throw new Error("Interrupted");
        }

        let abortListener: (() => void) | undefined;
        const abortPromise = new Promise<never>((_, reject) => {
          abortListener = () => {
            try {
              delegatedToolCallManager.cancel(workspaceId, toolCallId, "Interrupted");
            } catch {
              // no-op: pending may already have resolved
            }
            reject(new Error("Interrupted"));
          };

          abortSignal.addEventListener("abort", abortListener, { once: true });
        });

        try {
          return await Promise.race([pendingResult, abortPromise]);
        } finally {
          if (abortListener != null) {
            abortSignal.removeEventListener("abort", abortListener);
          }
        }
      };

      wrappedTools[toolName] = wrappedTool;
    }

    return wrappedTools;
  }

  private getMultiProjectExecutionDisabledMessage(workspaceId: string): string {
    return `Workspace ${workspaceId} reached multi-project AI runtime execution while ${EXPERIMENT_IDS.MULTI_PROJECT_WORKSPACES} is disabled`;
  }

  /** Builds the runtime context shared by stream startup and MCP prompt discovery. */
  createWorkspaceRuntimeContext(
    workspaceId: string,
    metadata: WorkspaceMetadata
  ): Result<
    WorkspaceRuntimeContext & {
      hostCheckoutRoot: string | null;
      projectCheckoutRoot: string | null;
    },
    SendMessageError
  > {
    const workspace = this.config.findWorkspace(workspaceId);
    if (!workspace) {
      return Err({ type: "unknown", raw: `Workspace ${workspaceId} not found in config` });
    }

    const metadataWithPath = {
      ...metadata,
      // Existing SSH workspaces may use a persisted root that differs from the
      // canonical hashed layout.
      namedWorkspacePath: workspace.workspacePath,
    };

    const multiProjectExecutionGate = this.ensureMultiProjectRuntimeExecutionEnabled(
      workspaceId,
      metadata
    );
    if (!multiProjectExecutionGate.success) {
      return multiProjectExecutionGate;
    }

    const singleProjectContext = isMultiProject(metadata)
      ? undefined
      : createRuntimeContextForWorkspace(metadataWithPath);
    const runtime = singleProjectContext
      ? singleProjectContext.runtime
      : new MultiProjectRuntime(
          new ContainerManager(getSrcBaseDir(metadata.runtimeConfig) ?? this.config.srcDir),
          getProjects(metadata).map((project) => ({
            projectPath: project.projectPath,
            projectName: project.projectName,
            runtime: createRuntime(metadata.runtimeConfig, {
              projectPath: project.projectPath,
              workspaceName: metadata.name,
              workspacePath: isSSHRuntime(metadata.runtimeConfig)
                ? getWorkspacePathHintForProject(
                    {
                      workspaceId,
                      workspaceName: metadata.name,
                      workspacePath: workspace.workspacePath,
                      runtimeConfig: metadata.runtimeConfig,
                      projectPath: metadata.projectPath,
                      projectName: metadata.projectName,
                      projects: metadata.projects,
                    },
                    project.projectPath
                  )
                : undefined,
            }),
          })),
          metadata.name
        );

    const workspacePath =
      singleProjectContext?.workspacePath ??
      (isSSHRuntime(metadata.runtimeConfig)
        ? resolveWorkspaceExecutionPath(metadataWithPath, runtime)
        : // Multi-project containers start at their shared root so sibling repos remain addressable.
          runtime.getWorkspacePath(metadata.projectPath, metadata.name));

    const projectCheckoutRoot = singleProjectContext
      ? resolveWorkspaceRootPath(metadataWithPath, runtime)
      : null;
    // Agent Plugin containers use the host checkout root, not a subproject directory.
    const hostCheckoutRoot =
      projectCheckoutRoot != null &&
      metadata.runtimeConfig.type !== "ssh" &&
      metadata.runtimeConfig.type !== "docker"
        ? projectCheckoutRoot
        : null;

    return Ok({ runtime, workspacePath, hostCheckoutRoot, projectCheckoutRoot });
  }

  private ensureMultiProjectRuntimeExecutionEnabled(
    workspaceId: string,
    metadata: WorkspaceMetadata
  ): Result<void, SendMessageError> {
    if (!isMultiProject(metadata)) {
      return Ok(undefined);
    }

    // Multi-project execution should already be gated before streamMessage reaches backend runtime
    // orchestration. If stale workspace ids or future callsites bypass those checks, fail closed
    // before constructing MultiProjectRuntime or loading shared-project secrets/tools.
    if (!this.experimentsService) {
      return Err({
        type: "unknown",
        raw: "AIService multi-project execution requires ExperimentsService to enforce the runtime gate",
      });
    }

    if (!this.experimentsService.isExperimentEnabled(EXPERIMENT_IDS.MULTI_PROJECT_WORKSPACES)) {
      return Err({
        type: "unknown",
        raw: this.getMultiProjectExecutionDisabledMessage(workspaceId),
      });
    }

    return Ok(undefined);
  }

  /**
   * Host-evaluated gate for the claude-skills-compat experiment. When enabled,
   * read paths include Claude's skills roots and ~/.claude/CLAUDE.md as read-only,
   * lowest-precedence compatibility sources. Public so every consumer shares the gate.
   */
  isClaudeSkillsCompatEnabled(): boolean {
    return (
      this.experimentsService?.isExperimentEnabled(EXPERIMENT_IDS.CLAUDE_SKILLS_COMPAT) === true
    );
  }

  /**
   * Host-evaluated gate for the agent-plugins experiment: when enabled, skill
   * discovery/read paths also scan Agent Plugins containers (.xum/plugins,
   * .agents/plugins, ~/.xum/plugins, ~/.agents/plugins; read-only, lowest
   * precedence). Public for the same reason as isClaudeSkillsCompatEnabled.
   */
  isAgentPluginsEnabled(): boolean {
    return this.experimentsService?.isExperimentEnabled(EXPERIMENT_IDS.AGENT_PLUGINS) === true;
  }

  /**
   * Resolve the XumToolScope a workspace's tools receive, including the checkout
   * boundary used for subproject skill inheritance. Host-local scopes also use
   * this root to anchor Agent Plugins containers.
   */
  resolveXumToolScopeForWorkspace(
    metadata: WorkspaceMetadata,
    runtime: Runtime,
    workspacePath: string
  ): XumToolScope {
    const projectCheckoutRoot = !isMultiProject(metadata)
      ? resolveWorkspaceRootPath(metadata, runtime)
      : null;
    return resolveXumToolScope(this.config, metadata, workspacePath, projectCheckoutRoot);
  }

  /** Stream a message conversation to the AI model. */
  async streamMessage(
    opts: StreamMessageOptions
  ): Promise<Result<TurnStreamHandle, SendMessageError>> {
    const { messages, workspaceId, modelString, thinkingLevel, abortSignal, agentId, muxMetadata } =
      opts;
    // Register before the first await so interrupts can cancel slow preparation.
    const pendingStart = this.streamManager.beginStreamStart({
      workspaceId,
      abortSignal,
      acpPromptId: opts.acpPromptId,
    });
    const startTime = Date.now();
    const syntheticMessageId = pendingStart.syntheticMessageId;
    opts.onStreamStarting?.(syntheticMessageId);
    const combinedAbortSignal = pendingStart.abortSignal;
    const startupPhaseTimingsMs: Record<string, number> = {};
    const recordStartupPhaseTiming = (phase: string, phaseStartedAt: number): void => {
      startupPhaseTimingsMs[phase] = Date.now() - phaseStartedAt;
    };
    const startupState = {
      pendingRunMetadataId: null as string | null,
      logSlowStreamStartup: undefined as ((details: Record<string, unknown>) => void) | undefined,
    };

    try {
      if (this.mockModeEnabled && this.mockAiStreamPlayer) {
        await this.initStateManager.waitForInit(workspaceId, combinedAbortSignal);
        if (combinedAbortSignal.aborted) {
          return Ok(this.createAbortedTurnHandle(syntheticMessageId, combinedAbortSignal));
        }
        const result = await this.mockAiStreamPlayer.play(messages, workspaceId, {
          model: modelString,
          agentId,
          thinkingLevel,
          muxMetadata,
          abortSignal: combinedAbortSignal,
        });
        if (!result.success) {
          return result;
        }
        return Ok(
          result.data ?? this.createAbortedTurnHandle(syntheticMessageId, combinedAbortSignal)
        );
      }

      const lastMessage = messages[messages.length - 1];
      log.debug(
        "[STREAM MESSAGE] workspaceId=" +
          workspaceId +
          " messageCount=" +
          messages.length +
          " lastRole=" +
          lastMessage?.role
      );

      const commitPartialStartedAt = Date.now();
      await this.historyService.commitPartial(workspaceId);
      recordStartupPhaseTiming("commitPartialMs", commitPartialStartedAt);

      const buildOutcome = await this.turnRequestBuilder.build(opts, {
        abortSignal: combinedAbortSignal,
        syntheticMessageId,
        startTime,
        startupPhaseTimingsMs,
        startupState,
        recordStartupPhaseTiming,
      });
      if (buildOutcome.type === "finished") {
        return buildOutcome.result;
      }

      const startStreamStartedAt = Date.now();
      const streamResult = await this.streamManager.startStream(buildOutcome.turnExecutionOptions);
      recordStartupPhaseTiming("startStreamMs", startStreamStartedAt);

      if (!streamResult.success) {
        if (startupState.pendingRunMetadataId != null) {
          this.clearTrackedPendingDevToolsRunMetadata(buildOutcome.assistantMessageId);
          startupState.pendingRunMetadataId = null;
        }
        buildOutcome.logStartOutcome("stream_start_failed", streamResult.error.type);
        return Err(streamResult.error);
      }

      if (combinedAbortSignal.aborted && !this.streamManager.isStreaming(workspaceId)) {
        if (startupState.pendingRunMetadataId != null) {
          this.clearTrackedPendingDevToolsRunMetadata(buildOutcome.assistantMessageId);
          startupState.pendingRunMetadataId = null;
        }
        await buildOutcome.deleteAbortedPlaceholder(buildOutcome.assistantMessageId);
      }

      buildOutcome.logStartOutcome("started");
      return Ok(streamResult.data);
    } catch (error) {
      if (startupState.pendingRunMetadataId != null) {
        this.clearTrackedPendingDevToolsRunMetadataById(
          workspaceId,
          startupState.pendingRunMetadataId
        );
        startupState.pendingRunMetadataId = null;
      }
      const errorMessage = getErrorMessage(error);
      startupState.logSlowStreamStartup?.({ outcome: "error", errorMessage });
      log.error("Stream message error:", error);
      return Err({ type: "unknown", raw: "Failed to stream message: " + errorMessage });
    } finally {
      pendingStart.finish();
    }
  }

  async stopStream(
    workspaceId: string,
    options?: { soft?: boolean; abandonPartial?: boolean; abortReason?: StreamAbortReason }
  ): Promise<Result<void>> {
    return this.streamManager.stopStream(workspaceId, options);
  }

  /**
   * Check if a workspace is currently streaming
   */
  isStreaming(workspaceId: string): boolean {
    return this.streamManager.isStreaming(workspaceId);
  }

  debugGetLastLlmRequest(workspaceId: string): Result<DebugLlmRequestSnapshot | null> {
    if (typeof workspaceId !== "string" || workspaceId.trim().length === 0) {
      return Err("debugGetLastLlmRequest: workspaceId is required");
    }

    return Ok(this.lastLlmRequestByWorkspace.get(workspaceId) ?? null);
  }

  async deleteWorkspace(workspaceId: string): Promise<Result<void>> {
    try {
      const workspaceDir = path.join(this.config.sessionsDir, workspaceId);
      await fs.rm(workspaceDir, { recursive: true, force: true });
      return Ok(undefined);
    } catch (error) {
      const message = getErrorMessage(error);
      return Err(`Failed to delete workspace: ${message}`);
    }
  }
}

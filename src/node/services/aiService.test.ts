import { eventSpine, type RequestAssembleContext } from "./events/eventSpine";
// Bun test file - doesn't support Jest mocking, so we skip this test for now
// These tests would need to be rewritten to work with Bun's test runner
// For now, the commandProcessor tests demonstrate our testing approach

import * as fs from "node:fs/promises";
import * as path from "node:path";

import { describe, it, expect, beforeEach, afterEach, mock, spyOn } from "bun:test";

import { resolveModelForMetadata } from "@/common/utils/providers/modelEntries";
import { AIService, resolveMuxProjectRootForHostFs } from "./aiService";
import { discoverAvailableSubagentsForToolContext } from "./turnContextAssembler";
import {
  normalizeAnthropicBaseURL,
  buildAppAttributionHeaders,
  ProviderModelFactory,
} from "./providerModelFactory";
import { HistoryService } from "./historyService";
import { InitStateManager } from "./initStateManager";
import { ProviderService } from "./providerService";
import { EXPERIMENT_IDS } from "@/common/constants/experiments";
import { Config, ProvidersConfigStore } from "@/node/config";
import * as runtimeFactory from "@/node/runtime/runtimeFactory";
import { LocalRuntime } from "@/node/runtime/LocalRuntime";
import { DisposableTempDir } from "@/node/services/tempDir";

import { createTaskTool } from "./tools/task";
import { createTestToolConfig } from "./tools/testHelpers";
import { XUM_APP_ATTRIBUTION_TITLE, XUM_APP_ATTRIBUTION_URL } from "@/constants/appAttribution";
import type { ProviderName } from "@/common/constants/providers";
import { KNOWN_MODELS } from "@/common/constants/knownModels";
import type { CodexOauthService } from "@/node/services/codexOauthService";
import { DEFAULT_RUNTIME_CONFIG } from "@/common/constants/workspace";
import { CODEX_ENDPOINT } from "@/common/constants/codexOAuth";

import { jsonSchema, tool, type LanguageModel, type Tool } from "ai";
import { createMuxMessage } from "@/common/types/message";
import type { ModelMessage } from "@/common/types/message";
import type { XumToolScope } from "@/common/types/toolScope";
import type { WorkspaceMetadata } from "@/common/types/workspace";
import { DEFAULT_TASK_SETTINGS } from "@/common/types/tasks";
import type {
  ErrorEvent,
  RuntimeStatusEvent,
  StreamAbortEvent,
  StreamEndEvent,
} from "@/common/types/stream";
import { log } from "./log";
import type { SessionUsageService } from "./sessionUsageService";
import type {
  StreamManager,
  TurnCompletion,
  TurnEngineEvent,
  TurnExecutionOptions,
  TurnStreamHandle,
} from "./streamManager";
import { ExperimentsService } from "./experimentsService";
import type { DevToolsService } from "./devToolsService";
import { TelemetryService } from "@/node/services/telemetryService";
import type { WorkspaceGoalService } from "./workspaceGoalService";
import * as agentResolution from "./agentResolution";
import * as turnContextAssembler from "./turnContextAssembler";
import * as messagePipeline from "./messagePipeline";
import { MemoryMetaService } from "@/node/services/memoryMeta";
import { DurableEventJournal } from "@/node/utils/journal/durableEventJournal";
import { MemoryService, projectMemoryDirName } from "@/node/services/memoryService";
import * as toolAssembly from "./toolAssembly";
import type { ToolModelUsageEvent } from "@/common/utils/tools/tools";
import { createDisplayUsage } from "@/common/utils/tokens/displayUsage";
import { normalizeToCanonical } from "@/common/utils/ai/models";
import * as toolsModule from "@/common/utils/tools/tools";
import * as systemMessageModule from "./systemMessage";

interface BasicAIServiceParts {
  config: Config;
  historyService: HistoryService;
  initStateManager: InitStateManager;
  providerService: ProviderService;
  providersConfigStore: ProvidersConfigStore;
  service: AIService;
}

type GeneratePrompt = Array<{
  role: "system" | "user";
  content: string | Array<{ type: "text"; text: string }>;
}>;

type RecordingFetch = (
  input: Parameters<typeof fetch>[0],
  init?: Parameters<typeof fetch>[1]
) => Promise<Response>;

interface RecordedFetchRequest {
  input: Parameters<typeof fetch>[0];
  init?: Parameters<typeof fetch>[1];
}

const TEST_CODEX_OAUTH = {
  type: "oauth" as const,
  access: "test-access-token",
  refresh: "test-refresh-token",
  expires: Date.now() + 60_000,
  accountId: "test-account-id",
};

function createBasicAIService(
  root?: string,
  options?: {
    sessionUsageService?: SessionUsageService;
    devToolsService?: DevToolsService;
    experimentsService?: ExperimentsService;
  }
): BasicAIServiceParts {
  const config = new Config(root);
  const historyService = new HistoryService(config);
  const initStateManager = new InitStateManager(config);
  const providersConfigStore = new ProvidersConfigStore(config.rootDir);
  const providerService = new ProviderService(config, undefined, providersConfigStore);
  const service = new AIService(
    config,
    historyService,
    initStateManager,
    providerService,
    undefined,
    options?.sessionUsageService,
    undefined,
    undefined,
    undefined,
    options?.devToolsService,
    options?.experimentsService,
    undefined,
    undefined,
    providersConfigStore
  );
  return {
    config,
    historyService,
    initStateManager,
    providerService,
    providersConfigStore,
    service,
  };
}

async function writeMainConfig(root: string, config: object): Promise<void> {
  await fs.writeFile(
    path.join(root, "config.json"),
    JSON.stringify({ projects: [], ...config }, null, 2),
    "utf-8"
  );
}

async function writeProvidersConfig(root: string, config: object): Promise<void> {
  await fs.writeFile(path.join(root, "providers.jsonc"), JSON.stringify(config, null, 2), "utf-8");
}

function toGatewayModelString(modelString: string): string {
  const colonIndex = modelString.indexOf(":");
  const provider = colonIndex === -1 ? modelString : modelString.slice(0, colonIndex);
  const modelId = colonIndex === -1 ? "" : modelString.slice(colonIndex + 1);
  return `mux-gateway:${provider}/${modelId}`;
}

function createRecordingOpenAIFetch(
  requests: RecordedFetchRequest[],
  model = "gpt-5.2"
): RecordingFetch {
  return (input, init) => {
    requests.push({ input, init });
    return Promise.resolve(
      new Response(
        JSON.stringify({
          id: "resp_test",
          created_at: 0,
          model,
          output: [
            {
              type: "message",
              role: "assistant",
              id: "msg_test",
              content: [{ type: "output_text", text: "ok", annotations: [] }],
            },
          ],
          usage: { input_tokens: 1, output_tokens: 1 },
        }),
        { status: 200, headers: { "content-type": "application/json" } }
      )
    );
  };
}

function configureOpenAICodexOAuth(
  service: AIService,
  providersConfigStore: ProvidersConfigStore,
  requests: RecordedFetchRequest[],
  options?: { defaultAuth?: "apiKey"; responseModel?: string; setOauthService?: boolean }
): void {
  spyOn(providersConfigStore, "loadProvidersConfig").mockReturnValue({
    openai: {
      apiKey: "test-openai-api-key",
      codexOauth: TEST_CODEX_OAUTH,
      ...(options?.defaultAuth ? { codexOauthDefaultAuth: options.defaultAuth } : {}),
      fetch: createRecordingOpenAIFetch(requests, options?.responseModel),
    },
  });

  if (options?.setOauthService !== false) {
    const codexOauthStub = {
      getValidAuth: () => Promise.resolve({ success: true, data: TEST_CODEX_OAUTH }),
    };
    service.turnRequestBuilderBindings.codexOauthService =
      codexOauthStub as unknown as CodexOauthService;
  }
}

async function createGeneratedModel(
  service: AIService,
  modelString: string,
  prompt: GeneratePrompt
): Promise<void> {
  const modelResult = await service.createModel(modelString);
  expect(modelResult.success).toBe(true);
  if (!modelResult.success) return;

  const model = modelResult.data;
  if (typeof model === "string") {
    throw new Error("Expected a LanguageModelV2 instance, got a model id string");
  }

  const generateModel = model as unknown as {
    doGenerate: (args: { prompt: GeneratePrompt }) => Promise<unknown>;
  };
  await generateModel.doGenerate({ prompt });
}

function getFetchUrl(input: Parameters<typeof fetch>[0]): string {
  if (typeof input === "string") return input;
  if (input instanceof URL) return input.toString();
  if (typeof input === "object" && input !== null && "url" in input) {
    const possibleUrl = (input as { url?: unknown }).url;
    if (typeof possibleUrl === "string") return possibleUrl;
  }
  return "";
}

function createLocalWorkspaceMetadata(
  workspaceId: string,
  projectPath: string,
  overrides?: Partial<WorkspaceMetadata>
): WorkspaceMetadata {
  return {
    id: workspaceId,
    name: "workspace-under-test",
    projectName: "project-under-test",
    projectPath,
    runtimeConfig: { type: "local" },
    ...overrides,
  };
}

function resolvedAgentResultFor(
  metadata: WorkspaceMetadata
): Awaited<ReturnType<typeof agentResolution.resolveAgentForStream>> {
  return {
    success: true,
    data: {
      effectiveAgentId: "exec",
      agentDefinition: {
        id: "exec",
        scope: "built-in",
        frontmatter: { name: "Exec" },
        body: "Exec agent body",
      },
      agentDiscoveryRuntime: new LocalRuntime(metadata.projectPath),
      agentDiscoveryPath: metadata.projectPath,
      isSubagentWorkspace: false,
      agentInheritanceChain: [{ id: "exec", scope: "built-in", tools: { add: [".*"] } }],
      agentIsPlanLike: false,
      effectiveMode: "exec",
      taskSettings: DEFAULT_TASK_SETTINGS,
      taskDepth: 0,
      shouldDisableTaskToolsForDepth: false,
      effectiveToolPolicy: undefined,
    },
  };
}

function providerNameFromModelString(modelString: string): ProviderName {
  return modelString.startsWith("anthropic:") ? "anthropic" : "openai";
}

function modelIdFromModelString(modelString: string): string {
  return modelString.includes(":") ? (modelString.split(":").at(1) ?? modelString) : modelString;
}

function stubCommonStreamMessageDependencies(args: {
  service: AIService;
  config: Config;
  historyService: HistoryService;
  initStateManager: InitStateManager;
  metadata: WorkspaceMetadata;
  startStreamCalls?: TurnExecutionOptions[];
  routeProvider?: ProviderName;
  allTools?: Record<string, Tool>;
  workspacePathOverride?: string;
  historySequence?: number;
  effectiveModelString?: string;
  canonicalProviderName?: ProviderName;
  canonicalModelId?: string;
  useRequestedModelString?: boolean;
  onPlanPayloadMessageIds?: (messageIds: string[]) => void;
  onBuildStreamSystemContext?: (
    args: Parameters<typeof turnContextAssembler.buildStreamSystemContext>[0]
  ) => void;
  onPrepareMessagesForProvider?: (
    args: Parameters<typeof messagePipeline.prepareMessagesForProvider>[0]
  ) => void;
}): ReturnType<typeof spyOn<typeof toolsModule, "getToolsForModel">> {
  spyOn(agentResolution, "resolveAgentForStream").mockResolvedValue(
    resolvedAgentResultFor(args.metadata)
  );
  spyOn(turnContextAssembler, "buildPlanInstructions").mockImplementation((planArgs) => {
    args.onPlanPayloadMessageIds?.(planArgs.requestPayloadMessages.map((message) => message.id));
    return Promise.resolve({
      effectiveAdditionalInstructions: undefined,
      planFilePath: path.join(args.metadata.projectPath, "plan.md"),
      planContentForTransition: undefined,
    });
  });
  spyOn(turnContextAssembler, "buildStreamSystemContext").mockImplementation((contextArgs) => {
    args.onBuildStreamSystemContext?.(contextArgs);
    return Promise.resolve({
      agentSystemPromptSections: ["test-agent-prompt"],
      systemMessage: "test-system-message",
      systemMessageTokens: 1,
      agentDefinitions: undefined,
      availableSkills: undefined,
      ancestorPlanFilePaths: [],
    });
  });
  spyOn(messagePipeline, "prepareMessagesForProvider").mockImplementation((pipelineArgs) => {
    args.onPrepareMessagesForProvider?.(pipelineArgs);
    return Promise.resolve(
      pipelineArgs.messagesWithSentinel as unknown as Awaited<
        ReturnType<typeof messagePipeline.prepareMessagesForProvider>
      >
    );
  });
  const getToolsForModelSpy = spyOn(toolsModule, "getToolsForModel").mockResolvedValue(
    args.allTools ?? {}
  );
  spyOn(systemMessageModule, "readToolInstructions").mockResolvedValue({});

  const providerModelFactory = Reflect.get(args.service, "providerModelFactory") as
    | ProviderModelFactory
    | undefined;
  if (!providerModelFactory) {
    throw new Error("Expected AIService.providerModelFactory in streamMessage test harness");
  }
  spyOn(providerModelFactory, "resolveAndCreateModel").mockImplementation(
    (requestedModelString) => {
      const canonicalModelString = args.useRequestedModelString
        ? requestedModelString
        : (args.effectiveModelString ?? "openai:gpt-5.2");
      return Promise.resolve({
        success: true,
        data: {
          model: Object.create(null) as LanguageModel,
          effectiveModelString: canonicalModelString,
          canonicalModelString,
          canonicalProviderName:
            args.canonicalProviderName ?? providerNameFromModelString(canonicalModelString),
          canonicalModelId: args.canonicalModelId ?? modelIdFromModelString(canonicalModelString),
          wireProviderName:
            args.canonicalProviderName ?? providerNameFromModelString(canonicalModelString),
          routedThroughGateway: false,
          ...(args.routeProvider != null ? { routeProvider: args.routeProvider } : {}),
        },
      });
    }
  );
  spyOn(args.service, "getWorkspaceMetadata").mockResolvedValue({
    success: true,
    data: args.metadata,
  });
  spyOn(args.initStateManager, "waitForInit").mockResolvedValue(undefined);
  spyOn(args.config, "findWorkspace").mockReturnValue({
    workspacePath: args.workspacePathOverride ?? args.metadata.projectPath,
    projectPath: args.metadata.projectPath,
  });
  spyOn(args.historyService, "commitPartial").mockResolvedValue({ success: true, data: undefined });
  spyOn(args.historyService, "appendToHistory").mockImplementation((_workspaceId, message) => {
    message.metadata = { ...(message.metadata ?? {}), historySequence: args.historySequence ?? 7 };
    return Promise.resolve({ success: true, data: undefined });
  });

  const streamManager = (args.service as unknown as { streamManager: StreamManager }).streamManager;
  const streamToken = "stream-token" as ReturnType<StreamManager["generateStreamToken"]>;
  spyOn(streamManager, "generateStreamToken").mockReturnValue(streamToken);
  spyOn(streamManager, "createTempDirForStream").mockResolvedValue(
    path.join(args.metadata.projectPath, ".tmp-stream")
  );
  spyOn(streamManager, "isResponseIdLost").mockReturnValue(false);
  // Mirror the real contract: startStream invokes onStreamConstructed once
  // the stream is registered (durable turn-envelope emission hangs on it), so
  // a success stub must call it too or envelope tests assert an empty journal.
  const stubStartStream = async (
    options: TurnExecutionOptions
  ): Promise<{ success: true; data: TurnStreamHandle }> => {
    args.startStreamCalls?.push(options);
    await options.onStreamConstructed?.();
    return {
      success: true,
      data: {
        messageId: options.messageId,
        completion: new Promise<TurnCompletion>(() => undefined),
      },
    };
  };
  spyOn(streamManager, "startStream").mockImplementation(stubStartStream);

  return getToolsForModelSpy;
}

describe("AIService", () => {
  let service: AIService;

  beforeEach(() => {
    service = createBasicAIService().service;
  });

  // Note: These tests are placeholders as Bun doesn't support Jest mocking
  // In a production environment, we'd use dependency injection or other patterns
  // to make the code more testable without mocking

  it("should create an AIService instance", () => {
    expect(service).toBeDefined();
    expect(service).toBeInstanceOf(AIService);
  });
});

describe("resolveMuxProjectRootForHostFs", () => {
  const projectPath = "/home/user/projects/my-app";
  const workspacePath = "/home/user/.mux/src/my-app/feature-branch";

  function createMetadata(runtimeConfig: WorkspaceMetadata["runtimeConfig"]): WorkspaceMetadata {
    return {
      id: "workspace-id",
      name: "feature-branch",
      projectName: "my-app",
      projectPath,
      runtimeConfig,
    };
  }

  it("returns workspacePath for local runtime", () => {
    expect(resolveMuxProjectRootForHostFs(createMetadata({ type: "local" }), workspacePath)).toBe(
      workspacePath
    );
  });

  it("returns workspacePath for worktree runtime", () => {
    expect(
      resolveMuxProjectRootForHostFs(
        createMetadata({ type: "worktree", srcBaseDir: "/home/user/.mux/src" }),
        workspacePath
      )
    ).toBe(workspacePath);
  });

  it("returns workspacePath for devcontainer runtime", () => {
    expect(
      resolveMuxProjectRootForHostFs(
        createMetadata({ type: "devcontainer", configPath: ".devcontainer/devcontainer.json" }),
        workspacePath
      )
    ).toBe(workspacePath);
  });

  it("returns projectPath for ssh runtime", () => {
    expect(
      resolveMuxProjectRootForHostFs(
        createMetadata({
          type: "ssh",
          host: "remote",
          srcBaseDir: "/home/remote/.mux/src",
        }),
        "/remote/workspace/path"
      )
    ).toBe(projectPath);
  });

  it("returns projectPath for docker runtime", () => {
    expect(
      resolveMuxProjectRootForHostFs(
        createMetadata({ type: "docker", image: "ubuntu:22.04" }),
        "/src"
      )
    ).toBe(projectPath);
  });
});

describe("AIService turn engine events", () => {
  interface ForwardingInternals {
    emitEngineEvent: (event: TurnEngineEvent) => void | Promise<void>;
    pendingDevToolsRunMetadataByMessageId: Map<string, { workspaceId: string; metadataId: string }>;
  }

  function createForwardingHarness(tempDirName: string): {
    historyService: HistoryService;
    service: AIService;
    internals: ForwardingInternals;
    clearPendingRunMetadataSpy: ReturnType<typeof mock>;
    [Symbol.dispose]: () => void;
  } {
    const xumHome = new DisposableTempDir(tempDirName);
    const clearPendingRunMetadataSpy = mock(
      (_workspaceId: string, _metadataId?: string) => undefined
    );
    const devToolsService = {
      enabled: true,
      clearPendingRunMetadata: clearPendingRunMetadataSpy,
    } as unknown as DevToolsService;
    const { historyService, service } = createBasicAIService(xumHome.path, { devToolsService });
    return {
      historyService,
      service,
      internals: service as unknown as ForwardingInternals,
      clearPendingRunMetadataSpy,
      [Symbol.dispose]: () => xumHome[Symbol.dispose](),
    };
  }

  afterEach(() => {
    mock.restore();
  });

  it("forwards stream-abort even when partial cleanup throws", async () => {
    using harness = createForwardingHarness("ai-service-stream-abort-forwarding");
    const { historyService, service, internals, clearPendingRunMetadataSpy } = harness;
    const cleanupError = new Error("disk full");
    const deletePartialSpy = spyOn(historyService, "deletePartial").mockImplementation(() =>
      Promise.reject(cleanupError)
    );
    const abortEvent: StreamAbortEvent = {
      type: "stream-abort",
      workspaceId: "workspace-1",
      messageId: "message-1",
      abandonPartial: true,
    };
    internals.pendingDevToolsRunMetadataByMessageId.set(abortEvent.messageId, {
      workspaceId: abortEvent.workspaceId,
      metadataId: "metadata-1",
    });

    const forwardedAbortPromise = new Promise<StreamAbortEvent>((resolve) => {
      service.once("stream-abort", (event) => resolve(event as StreamAbortEvent));
    });
    await internals.emitEngineEvent(abortEvent);

    expect(await forwardedAbortPromise).toEqual(abortEvent);
    expect(deletePartialSpy).toHaveBeenCalledWith(abortEvent.workspaceId);
    expect(clearPendingRunMetadataSpy).toHaveBeenCalledWith(abortEvent.workspaceId, "metadata-1");
    expect(internals.pendingDevToolsRunMetadataByMessageId.has(abortEvent.messageId)).toBe(false);
  });

  it.each([
    {
      name: "stream error clears tracked metadata",
      eventName: "error" as const,
      event: {
        type: "error" as const,
        workspaceId: "workspace-1",
        messageId: "message-1",
        error: "request failed",
        errorType: "rate_limit" as const,
      } satisfies ErrorEvent,
      expectCleared: true,
    },
    {
      name: "stream-end clears tracked metadata",
      eventName: "stream-end" as const,
      event: {
        type: "stream-end" as const,
        workspaceId: "workspace-1",
        messageId: "message-1",
        metadata: { model: "anthropic:claude-opus-4-1" },
        parts: [],
      } satisfies StreamEndEvent,
      expectCleared: true,
    },
    {
      name: "stream-abort with empty messageId leaves unrelated metadata",
      eventName: "stream-abort" as const,
      event: {
        type: "stream-abort" as const,
        workspaceId: "workspace-1",
        messageId: "",
        abandonPartial: true,
      } satisfies StreamAbortEvent,
      expectCleared: false,
    },
  ])("devtools run metadata: $name", async ({ eventName, event, expectCleared }) => {
    using harness = createForwardingHarness(`ai-service-${eventName}-devtools-cleanup`);
    const { service, internals, clearPendingRunMetadataSpy } = harness;
    const trackedMessageId = event.messageId || "message-1";
    internals.pendingDevToolsRunMetadataByMessageId.set(trackedMessageId, {
      workspaceId: event.workspaceId,
      metadataId: "metadata-1",
    });

    const forwardedPromise = new Promise<typeof event>((resolve) => {
      service.once(eventName, (forwarded) => resolve(forwarded as typeof event));
    });
    await internals.emitEngineEvent(event);

    expect(await forwardedPromise).toEqual(event);
    if (expectCleared) {
      expect(clearPendingRunMetadataSpy).toHaveBeenCalledWith(event.workspaceId, "metadata-1");
    } else {
      expect(clearPendingRunMetadataSpy).not.toHaveBeenCalled();
    }
    expect(internals.pendingDevToolsRunMetadataByMessageId.has(trackedMessageId)).toBe(
      !expectCleared
    );
  });
});

describe("AIService.resolveGatewayModelString", () => {
  it("routes allowlisted models when gateway is enabled + configured", async () => {
    using xumHome = new DisposableTempDir("gateway-routing");

    await writeMainConfig(xumHome.path, {
      muxGatewayEnabled: true,
      muxGatewayModels: [KNOWN_MODELS.SONNET.id],
    });
    await writeProvidersConfig(xumHome.path, {
      "mux-gateway": { couponCode: "test-coupon" },
    });

    const service = createBasicAIService(xumHome.path).service;

    // @ts-expect-error - accessing private field for testing
    const resolved = service.providerModelFactory.resolveGatewayModelString(KNOWN_MODELS.SONNET.id);

    expect(resolved).toBe(toGatewayModelString(KNOWN_MODELS.SONNET.id));
  });

  it("does not route when the mux-gateway provider is disabled", async () => {
    using xumHome = new DisposableTempDir("gateway-routing-provider-disabled");

    await writeMainConfig(xumHome.path, {
      routePriority: ["mux-gateway", "direct"],
    });
    await writeProvidersConfig(xumHome.path, {
      anthropic: { apiKey: "sk-ant-test" },
      "mux-gateway": {
        couponCode: "test-coupon",
        enabled: false,
      },
    });

    const service = createBasicAIService(xumHome.path).service;

    // @ts-expect-error - accessing private field for testing
    const resolved = service.providerModelFactory.resolveGatewayModelString(KNOWN_MODELS.SONNET.id);

    expect(resolved).toBe(KNOWN_MODELS.SONNET.id);
  });

  it("does not route when gateway is not configured", async () => {
    using xumHome = new DisposableTempDir("gateway-routing-unconfigured");

    await writeMainConfig(xumHome.path, {
      muxGatewayEnabled: true,
      muxGatewayModels: [KNOWN_MODELS.SONNET.id],
    });

    const service = createBasicAIService(xumHome.path).service;

    // @ts-expect-error - accessing private field for testing
    const resolved = service.providerModelFactory.resolveGatewayModelString(KNOWN_MODELS.SONNET.id);

    expect(resolved).toBe(KNOWN_MODELS.SONNET.id);
  });

  it("does not route unsupported providers even when allowlisted", async () => {
    using xumHome = new DisposableTempDir("gateway-routing-unsupported-provider");

    const modelString = "openrouter:some-model";
    await writeMainConfig(xumHome.path, {
      muxGatewayEnabled: true,
      muxGatewayModels: [modelString],
    });
    await writeProvidersConfig(xumHome.path, {
      "mux-gateway": { couponCode: "test-coupon" },
    });

    const service = createBasicAIService(xumHome.path).service;

    // @ts-expect-error - accessing private field for testing
    const resolved = service.providerModelFactory.resolveGatewayModelString(modelString);

    expect(resolved).toBe(modelString);
  });

  it("routes model variants when the base model is allowlisted via modelKey", async () => {
    using xumHome = new DisposableTempDir("gateway-routing-model-key");

    const variant = "xai:grok-4-1-fast-reasoning";
    await writeMainConfig(xumHome.path, {
      muxGatewayEnabled: true,
      muxGatewayModels: ["xai:grok-4-1-fast"],
    });
    await writeProvidersConfig(xumHome.path, {
      "mux-gateway": { couponCode: "test-coupon" },
    });

    const service = createBasicAIService(xumHome.path).service;

    // @ts-expect-error - accessing private field for testing
    const resolved = service.providerModelFactory.resolveGatewayModelString(
      variant,
      "xai:grok-4-1-fast"
    );

    expect(resolved).toBe(toGatewayModelString(variant));
  });

  it("honors explicit mux-gateway prefixes from legacy clients", async () => {
    using xumHome = new DisposableTempDir("gateway-routing-explicit");

    await writeMainConfig(xumHome.path, {
      muxGatewayEnabled: true,
      muxGatewayModels: [],
    });
    await writeProvidersConfig(xumHome.path, {
      "mux-gateway": { couponCode: "test-coupon" },
    });

    const service = createBasicAIService(xumHome.path).service;

    // @ts-expect-error - accessing private field for testing
    const resolved = service.providerModelFactory.resolveGatewayModelString(
      KNOWN_MODELS.GPT.id,
      undefined,
      true
    );

    expect(resolved).toBe(toGatewayModelString(KNOWN_MODELS.GPT.id));
  });
});

describe("AIService.createModel (Codex OAuth routing)", () => {
  it("returns oauth_not_connected for required Codex models when both OAuth and API key are missing", async () => {
    using xumHome = new DisposableTempDir("codex-oauth-missing");

    await writeProvidersConfig(xumHome.path, {
      openai: {},
    });

    // Temporarily clear OPENAI_API_KEY so resolveProviderCredentials doesn't find it
    const savedKey = process.env.OPENAI_API_KEY;
    delete process.env.OPENAI_API_KEY;
    try {
      const service = createBasicAIService(xumHome.path).service;
      const result = await service.createModel(KNOWN_MODELS.GPT_53_CODEX_SPARK.id);

      expect(result.success).toBe(false);
      if (!result.success) {
        expect(result.error).toEqual({ type: "oauth_not_connected", provider: "openai" });
      }
    } finally {
      if (savedKey !== undefined) {
        process.env.OPENAI_API_KEY = savedKey;
      }
    }
  });

  it("returns api_key_not_found for released gpt-5.3-codex when OAuth and API key are missing", async () => {
    using xumHome = new DisposableTempDir("codex-api-model-missing-auth");

    await writeProvidersConfig(xumHome.path, {
      openai: {},
    });

    const savedKey = process.env.OPENAI_API_KEY;
    delete process.env.OPENAI_API_KEY;
    try {
      const service = createBasicAIService(xumHome.path).service;
      const result = await service.createModel(KNOWN_MODELS.GPT_53_CODEX.id);

      expect(result.success).toBe(false);
      if (!result.success) {
        expect(result.error).toEqual({ type: "api_key_not_found", provider: "openai" });
      }
    } finally {
      if (savedKey !== undefined) {
        process.env.OPENAI_API_KEY = savedKey;
      }
    }
  });

  it("returns api_key_not_found for gpt-5.5 when OAuth and API key are missing", async () => {
    using xumHome = new DisposableTempDir("codex-gpt-5-5-missing-auth");

    await writeProvidersConfig(xumHome.path, {
      openai: {},
    });

    const savedKey = process.env.OPENAI_API_KEY;
    delete process.env.OPENAI_API_KEY;
    try {
      const service = createBasicAIService(xumHome.path).service;
      const result = await service.createModel(KNOWN_MODELS.GPT.id);

      expect(result.success).toBe(false);
      if (!result.success) {
        expect(result.error).toEqual({ type: "api_key_not_found", provider: "openai" });
      }
    } finally {
      if (savedKey !== undefined) {
        process.env.OPENAI_API_KEY = savedKey;
      }
    }
  });

  it("falls back to API key for required Codex models when OAuth is missing but API key is present", async () => {
    using xumHome = new DisposableTempDir("codex-oauth-missing-apikey-present");

    await writeProvidersConfig(xumHome.path, {
      openai: { apiKey: "sk-test-key" },
    });

    const service = createBasicAIService(xumHome.path).service;
    const result = await service.createModel(KNOWN_MODELS.GPT_53_CODEX_SPARK.id);

    // Should succeed — falls back to API key instead of erroring with oauth_not_connected
    expect(result.success).toBe(true);
  });

  it("does not require an OpenAI API key when Codex OAuth is configured", async () => {
    using xumHome = new DisposableTempDir("codex-oauth-present");

    await writeProvidersConfig(xumHome.path, {
      openai: {
        codexOauth: {
          type: "oauth",
          access: "test-access-token",
          refresh: "test-refresh-token",
          expires: Date.now() + 60_000,
          accountId: "test-account-id",
        },
      },
    });

    const service = createBasicAIService(xumHome.path).service;
    const result = await service.createModel(KNOWN_MODELS.GPT_53_CODEX_SPARK.id);

    expect(result.success).toBe(true);
  });

  it.each([
    {
      name: "defaults OAuth-allowed models to ChatGPT OAuth when both auth methods are configured",
      tempDirName: "codex-oauth-default-auth-oauth",
      defaultAuth: undefined,
      endpointMatcher: (url: string) => expect(url).toBe(CODEX_ENDPOINT),
    },
    {
      name: "does not rewrite OAuth-allowed models when default auth is set to apiKey",
      tempDirName: "codex-oauth-default-auth-api-key",
      defaultAuth: "apiKey" as const,
      endpointMatcher: (url: string) => expect(url).not.toBe(CODEX_ENDPOINT),
    },
  ])("$name", async ({ tempDirName, defaultAuth, endpointMatcher }) => {
    using xumHome = new DisposableTempDir(tempDirName);
    const { providersConfigStore, service } = createBasicAIService(xumHome.path);
    const requests: RecordedFetchRequest[] = [];
    configureOpenAICodexOAuth(service, providersConfigStore, requests, { defaultAuth });

    await createGeneratedModel(service, KNOWN_MODELS.GPT.id, [
      { role: "user", content: [{ type: "text", text: "Hello" }] },
    ]);

    expect(requests.length).toBeGreaterThan(0);
    const lastRequest = requests[requests.length - 1];
    endpointMatcher(getFetchUrl(lastRequest.input));
  });

  it("ensures Codex OAuth routed Responses requests include non-empty instructions", async () => {
    using xumHome = new DisposableTempDir("codex-oauth-instructions");
    const { providersConfigStore, service } = createBasicAIService(xumHome.path);
    const requests: RecordedFetchRequest[] = [];
    configureOpenAICodexOAuth(service, providersConfigStore, requests, {
      responseModel: "gpt-5.3-codex",
    });
    const systemPrompt = "Test system prompt";

    await createGeneratedModel(service, KNOWN_MODELS.GPT_53_CODEX.id, [
      { role: "system", content: systemPrompt },
      { role: "user", content: [{ type: "text", text: "Hello" }] },
    ]);

    expect(requests.length).toBeGreaterThan(0);

    const lastRequest = requests[requests.length - 1];

    // URL rewrite to chatgpt.com
    expect(lastRequest.input).toBe(CODEX_ENDPOINT);

    // Auth header injection
    const headers = new Headers(lastRequest.init?.headers);
    expect(headers.get("authorization")).toBe("Bearer test-access-token");
    expect(headers.get("chatgpt-account-id")).toBe("test-account-id");

    // Body mutation: non-empty instructions
    const bodyString = lastRequest.init?.body;
    expect(typeof bodyString).toBe("string");
    if (typeof bodyString !== "string") {
      throw new Error("Expected request body to be a string");
    }

    const parsedBody = JSON.parse(bodyString) as unknown;
    if (!parsedBody || typeof parsedBody !== "object") {
      throw new Error("Expected request body to parse as an object");
    }

    const instructions = (parsedBody as { instructions?: unknown }).instructions;
    expect(typeof instructions).toBe("string");
    if (typeof instructions !== "string") {
      throw new Error("Expected instructions to be a string");
    }

    expect(instructions.trim().length).toBeGreaterThan(0);
    expect(instructions).toBe(systemPrompt);

    // Codex endpoint requires store=false
    const store = (parsedBody as { store?: unknown }).store;
    expect(store).toBe(false);

    // System message should be removed from input to avoid double-system
    const input = (parsedBody as { input?: unknown[] }).input;
    if (Array.isArray(input)) {
      for (const item of input) {
        if (item && typeof item === "object" && "role" in item) {
          expect((item as { role: string }).role).not.toBe("system");
          expect((item as { role: string }).role).not.toBe("developer");
        }
      }
    }
  });

  it("filters out item_reference entries and preserves inline items when routing through Codex OAuth", async () => {
    using xumHome = new DisposableTempDir("codex-oauth-filter-refs");
    const { providersConfigStore, service } = createBasicAIService(xumHome.path);
    const requests: RecordedFetchRequest[] = [];
    configureOpenAICodexOAuth(service, providersConfigStore, requests, {
      responseModel: "gpt-5.3-codex",
    });

    await createGeneratedModel(service, KNOWN_MODELS.GPT_53_CODEX.id, [
      { role: "system", content: "You are a helpful assistant" },
      { role: "user", content: [{ type: "text", text: "Hello" }] },
    ]);

    expect(requests.length).toBeGreaterThan(0);

    const lastRequest = requests[requests.length - 1];
    const bodyString = lastRequest.init?.body;
    expect(typeof bodyString).toBe("string");
    if (typeof bodyString !== "string") {
      throw new Error("Expected request body to be a string");
    }

    const parsedBody = JSON.parse(bodyString) as { store?: boolean; input?: unknown[] };

    // Verify Codex transform ran (store=false is set)
    expect(parsedBody.store).toBe(false);

    // Verify no item_reference entries exist in output
    const input = parsedBody.input;
    expect(Array.isArray(input)).toBe(true);
    if (Array.isArray(input)) {
      for (const item of input) {
        if (item && typeof item === "object" && item !== null) {
          expect((item as Record<string, unknown>).type).not.toBe("item_reference");
        }
      }
    }
  });

  it("item_reference filter removes references and preserves inline items", () => {
    // Direct unit test of the item_reference filtering logic used in the
    // Codex body transformation, independent of the full AIService pipeline.
    const input: Array<Record<string, unknown>> = [
      { role: "user", content: [{ type: "input_text", text: "hello" }] },
      { type: "item_reference", id: "rs_abc123" },
      {
        type: "message",
        role: "assistant",
        id: "msg_001",
        content: [{ type: "output_text", text: "hi" }],
      },
      {
        type: "function_call",
        id: "fc_xyz",
        call_id: "call_1",
        name: "test_fn",
        arguments: "{}",
      },
      { type: "item_reference", id: "rs_def456" },
      { type: "function_call_output", call_id: "call_1", output: "result" },
    ];

    // Same filter logic as in aiService.ts Codex body transformation
    const filtered = input.filter(
      (item) => !(item && typeof item === "object" && item.type === "item_reference")
    );

    // Both item_reference entries removed
    expect(filtered).toHaveLength(4);
    expect(filtered.some((i) => i.type === "item_reference")).toBe(false);

    // Inline items preserved with their IDs intact
    expect(filtered.find((i) => i.role === "assistant")?.id).toBe("msg_001");
    expect(filtered.find((i) => i.type === "function_call")?.id).toBe("fc_xyz");
    expect(filtered.find((i) => i.type === "function_call_output")?.call_id).toBe("call_1");
    expect(filtered.find((i) => i.role === "user")).toBeDefined();
  });
});

describe("AIService.createModelWithPinnedMetadata", () => {
  it("derives the pinned identity from the effective route when a coder selection falls away", async () => {
    using xumHome = new DisposableTempDir("pinned-metadata-fallback-away");

    // Cross-typed canonical-named instance (name openai, type anthropic) with
    // NO coder credential: the gateway is not routable, so createModel falls
    // away to direct OpenAI. The pinned identity must follow that effective
    // route — resolving the raw selection would price/bucket this spend as
    // anthropic:<model> despite the request being served by OpenAI.
    await writeProvidersConfig(xumHome.path, {
      coder: { additionalProviders: [{ name: "openai", type: "anthropic" }] },
      openai: { apiKey: "sk-test-key" },
    });

    const service = createBasicAIService(xumHome.path).service;
    const result = await service.createModelWithPinnedMetadata("coder:openai/claude-opus-4-1");

    expect(result.success).toBe(true);
    if (result.success) {
      expect(result.data.metadataModel).toBe("openai:claude-opus-4-1");
    }
  });
});

describe("AIService.streamMessage compaction boundary slicing", () => {
  interface StreamMessageHarness {
    config: Config;
    service: AIService;
    planPayloadMessageIds: string[][];
    preparedPayloadMessageIds: string[][];
    preparedToolNamesForSentinel: string[][];
    streamSystemContextMuxScopes: XumToolScope[];
    streamSystemContextAdvisorFlags: Array<boolean | undefined>;
    streamSystemContextMemoryToolFlags: Array<boolean | undefined>;
    streamSystemContextIntuitionFlags: Array<boolean | undefined>;
    streamSystemContextHotMemoriesBlocks: Array<string | undefined>;
    startStreamCalls: TurnExecutionOptions[];
    getToolsForModelSpy: ReturnType<typeof spyOn<typeof toolsModule, "getToolsForModel">>;
  }

  function initialMetadataFromStartStreamCall(
    startStreamOptions: TurnExecutionOptions
  ): Record<string, unknown> {
    const initialMetadata = startStreamOptions.initialMetadata;
    if (!initialMetadata || typeof initialMetadata !== "object" || Array.isArray(initialMetadata)) {
      throw new Error("Expected initial metadata object in startStream options");
    }

    return initialMetadata as Record<string, unknown>;
  }

  function createHarness(
    xumHomePath: string,
    metadata: WorkspaceMetadata,
    options?: {
      routeProvider?: ProviderName;
      allTools?: Record<string, Tool>;
      postPolicyTools?: Record<string, Tool>;
      sessionUsageService?: SessionUsageService;
      effectiveModelString?: string;
      canonicalProviderName?: ProviderName;
      canonicalModelId?: string;
      useRequestedModelString?: boolean;
      experimentsService?: ExperimentsService;
    }
  ): StreamMessageHarness {
    const { config, historyService, initStateManager, service } = createBasicAIService(
      xumHomePath,
      {
        sessionUsageService: options?.sessionUsageService,
        experimentsService: options?.experimentsService,
      }
    );
    const planPayloadMessageIds: string[][] = [];
    const preparedPayloadMessageIds: string[][] = [];
    const preparedToolNamesForSentinel: string[][] = [];
    const streamSystemContextMuxScopes: XumToolScope[] = [];
    const streamSystemContextAdvisorFlags: Array<boolean | undefined> = [];
    const streamSystemContextMemoryToolFlags: Array<boolean | undefined> = [];
    const streamSystemContextIntuitionFlags: Array<boolean | undefined> = [];
    const streamSystemContextHotMemoriesBlocks: Array<string | undefined> = [];
    const startStreamCalls: TurnExecutionOptions[] = [];

    const getToolsForModelSpy = stubCommonStreamMessageDependencies({
      service,
      config,
      historyService,
      initStateManager,
      metadata,
      startStreamCalls,
      routeProvider: options?.routeProvider,
      allTools: options?.allTools,
      effectiveModelString: options?.effectiveModelString,
      canonicalProviderName: options?.canonicalProviderName,
      canonicalModelId: options?.canonicalModelId,
      useRequestedModelString: options?.useRequestedModelString,
      onPlanPayloadMessageIds: (messageIds) => planPayloadMessageIds.push(messageIds),
      onBuildStreamSystemContext: (contextArgs) => {
        if (!contextArgs.xumScope) {
          throw new Error("Expected xumScope in stream system context build args");
        }
        streamSystemContextMuxScopes.push(contextArgs.xumScope);
        streamSystemContextAdvisorFlags.push(contextArgs.advisorToolAvailable);
        streamSystemContextMemoryToolFlags.push(contextArgs.memoryToolAvailable);
        streamSystemContextIntuitionFlags.push(contextArgs.intuitionToolAvailable);
        streamSystemContextHotMemoriesBlocks.push(contextArgs.hotMemoriesBlock);
      },
      onPrepareMessagesForProvider: (pipelineArgs) => {
        preparedPayloadMessageIds.push(
          pipelineArgs.messagesWithSentinel.map((message) => message.id)
        );
        preparedToolNamesForSentinel.push(pipelineArgs.toolNamesForSentinel);
      },
    });
    if (options?.postPolicyTools) {
      spyOn(toolAssembly, "applyToolPolicyAndExperiments").mockResolvedValue(
        options.postPolicyTools
      );
    }

    return {
      config,
      service,
      planPayloadMessageIds,
      preparedPayloadMessageIds,
      preparedToolNamesForSentinel,
      streamSystemContextMuxScopes,
      streamSystemContextAdvisorFlags,
      streamSystemContextMemoryToolFlags,
      streamSystemContextIntuitionFlags,
      streamSystemContextHotMemoriesBlocks,
      startStreamCalls,
      getToolsForModelSpy,
    };
  }

  interface AdvisorRuntimeForTests {
    createModel: (modelString: string) => Promise<LanguageModel>;
    takeToolCallSnapshot: (toolCallId: string) =>
      | {
          toolCallId: string;
          toolName: "advisor";
          input: Record<string, unknown>;
          stepText: string;
          stepReasoning: string;
        }
      | undefined;
  }

  type AdvisorOnChunk = (event: {
    chunk: {
      type: string;
      delta?: string;
      toolCallId?: string;
      toolName?: string;
      input?: unknown;
    };
  }) => PromiseLike<void> | void;

  async function enableAdvisorForHarness(
    harness: StreamMessageHarness,
    advisorModelString: string = KNOWN_MODELS.SONNET.id
  ): Promise<void> {
    const baseConfig = harness.config.loadConfigOrDefault();
    await harness.config.editConfig(() => ({
      ...baseConfig,
      advisorModelString,
      agentAiDefaults: {
        ...baseConfig.agentAiDefaults,
        exec: {
          ...baseConfig.agentAiDefaults?.exec,
          advisorEnabled: true,
        },
      },
    }));
  }

  async function startAdvisorStream(
    harness: StreamMessageHarness,
    workspaceId: string
  ): Promise<Awaited<ReturnType<AIService["streamMessage"]>>> {
    const result = await harness.service.streamMessage({
      messages: [createMuxMessage("latest-user", "user", "continue")],
      workspaceId,
      modelString: "openai:gpt-5.2",
      thinkingLevel: "off",
      experiments: { advisorTool: true },
    });
    expect(result.success).toBe(true);
    return result;
  }

  function getToolConfigFromHarness(harness: StreamMessageHarness): Record<string, unknown> {
    const toolConfig = harness.getToolsForModelSpy.mock.calls[0]?.[1];
    if (!toolConfig || typeof toolConfig !== "object") {
      throw new Error("Expected getToolsForModel to receive a tool configuration object");
    }
    return toolConfig as unknown as Record<string, unknown>;
  }

  function getAdvisorRuntimeFromHarness(harness: StreamMessageHarness): AdvisorRuntimeForTests {
    const toolConfig = getToolConfigFromHarness(harness);
    const advisorRuntime = (toolConfig as { advisorRuntime?: AdvisorRuntimeForTests })
      .advisorRuntime;
    expect(advisorRuntime).toBeDefined();
    if (!advisorRuntime) {
      throw new Error("Expected advisorRuntime in tool configuration");
    }
    return advisorRuntime;
  }

  function getAdvisorCallbacksFromHarness(harness: StreamMessageHarness): {
    onChunk: AdvisorOnChunk;
    onStepMessages: (messages: ModelMessage[]) => void;
  } {
    expect(harness.startStreamCalls).toHaveLength(1);
    const startStreamCall = harness.startStreamCalls[0];
    if (!startStreamCall) {
      throw new Error("Expected streamManager.startStream call arguments");
    }

    const onChunk = startStreamCall.onChunk;
    const onStepMessages = startStreamCall.onStepMessages;
    expect(typeof onChunk).toBe("function");
    expect(typeof onStepMessages).toBe("function");
    if (typeof onChunk !== "function" || typeof onStepMessages !== "function") {
      throw new Error("Expected advisor startStream callbacks");
    }

    return {
      onChunk: onChunk as AdvisorOnChunk,
      onStepMessages: onStepMessages as (messages: ModelMessage[]) => void,
    };
  }

  afterEach(() => {
    mock.restore();
  });

  it.each(["request-row", "idle-row", "agent", "send-metadata", "ordinary", "historical"] as const)(
    "keeps oversized compaction recovery outside token-budget preflight: %s",
    async (identity) => {
      using xumHome = new DisposableTempDir("ai-service-compaction-budget");
      const metadata = createLocalWorkspaceMetadata("compaction-budget", xumHome.path);
      const harness = createHarness(xumHome.path, metadata);
      const compactionMetadata = {
        type: "compaction-request" as const,
        rawCommand: "/compact",
        parsed: {},
        ...(identity === "idle-row" ? { source: "idle-compaction" as const } : {}),
      };
      if (identity === "agent") {
        const resolved = resolvedAgentResultFor(metadata);
        if (!resolved.success) throw new Error("Expected resolved agent");
        resolved.data.effectiveAgentId = "compact";
        resolved.data.effectiveMode = "compact";
        spyOn(agentResolution, "resolveAgentForStream").mockResolvedValue(resolved);
      }
      const currentRowIsCompaction = identity === "request-row" || identity === "idle-row";
      const messages = [
        createMuxMessage("large-history", "user", "x".repeat(2_000_000)),
        ...(identity === "historical"
          ? [
              createMuxMessage("previous-compact", "user", "summarize", {
                muxMetadata: compactionMetadata,
              }),
            ]
          : []),
        createMuxMessage("latest-user", "user", "continue", {
          ...(currentRowIsCompaction ? { muxMetadata: compactionMetadata } : {}),
          ...(identity === "send-metadata" ? { synthetic: true } : {}),
        }),
      ];
      const result = await harness.service.streamMessage({
        workspaceId: metadata.id,
        messages,
        modelString: "openai:gpt-5.2",
        thinkingLevel: "off",
        experiments: { tokenBudget: true },
        ...(identity === "send-metadata" ? { muxMetadata: compactionMetadata } : {}),
      });
      const shouldBypass = identity !== "ordinary" && identity !== "historical";
      expect(result.success).toBe(shouldBypass);
      expect(harness.startStreamCalls).toHaveLength(shouldBypass ? 1 : 0);
      expect(harness.preparedPayloadMessageIds[0]).toContain("large-history");
      if (!shouldBypass && !result.success) {
        expect(result.error.type).toBe("context_budget_exceeded");
      }
    }
  );

  it("keeps set_goal disabled for one-shot streams that do not opt into agent-created goals", async () => {
    using xumHome = new DisposableTempDir("ai-service-set-goal-disabled");
    const projectPath = path.join(xumHome.path, "project");
    await fs.mkdir(projectPath, { recursive: true });

    const workspaceId = "workspace-set-goal-disabled";
    const metadata = createLocalWorkspaceMetadata(workspaceId, projectPath);
    const harness = createHarness(xumHome.path, metadata);
    const goalService = {
      getGoal: mock(() => Promise.resolve(null)),
    } as unknown as WorkspaceGoalService;

    const result = await harness.service.streamMessage({
      messages: [createMuxMessage("latest-user", "user", "hello")],
      workspaceId,
      modelString: "openai:gpt-5.2",
      thinkingLevel: "off",
      workspaceGoalService: goalService,
    });

    expect(result.success).toBe(true);
    expect(getToolConfigFromHarness(harness).enableGoalTools).toMatchObject({
      setGoal: false,
    });
  });

  it("enables set_goal for parent streams that opt into agent-created goals", async () => {
    using xumHome = new DisposableTempDir("ai-service-set-goal-enabled");
    const projectPath = path.join(xumHome.path, "project");
    await fs.mkdir(projectPath, { recursive: true });

    const workspaceId = "workspace-set-goal-enabled";
    const metadata = createLocalWorkspaceMetadata(workspaceId, projectPath);
    const harness = createHarness(xumHome.path, metadata);
    const goalService = {
      getGoal: mock(() => Promise.resolve(null)),
    } as unknown as WorkspaceGoalService;

    const result = await harness.service.streamMessage({
      messages: [createMuxMessage("latest-user", "user", "hello")],
      workspaceId,
      modelString: "openai:gpt-5.2",
      thinkingLevel: "off",
      workspaceGoalService: goalService,
      allowAgentSetGoal: true,
    });

    expect(result.success).toBe(true);
    expect(getToolConfigFromHarness(harness).enableGoalTools).toMatchObject({
      setGoal: true,
    });
  });

  it("keeps set_goal disabled for child workspaces even when the host opts in", async () => {
    using xumHome = new DisposableTempDir("ai-service-set-goal-child-disabled");
    const projectPath = path.join(xumHome.path, "project");
    await fs.mkdir(projectPath, { recursive: true });

    const workspaceId = "workspace-set-goal-child-disabled";
    const metadata = createLocalWorkspaceMetadata(workspaceId, projectPath, {
      parentWorkspaceId: "parent-workspace",
    });
    const harness = createHarness(xumHome.path, metadata);
    const goalService = {
      getGoal: mock(() => Promise.resolve(null)),
    } as unknown as WorkspaceGoalService;

    const result = await harness.service.streamMessage({
      messages: [createMuxMessage("latest-user", "user", "hello")],
      workspaceId,
      modelString: "openai:gpt-5.2",
      thinkingLevel: "off",
      workspaceGoalService: goalService,
      allowAgentSetGoal: true,
    });

    expect(result.success).toBe(true);
    expect(getToolConfigFromHarness(harness).enableGoalTools).toMatchObject({
      setGoal: false,
    });
  });

  it("prepares fallback system context with the fallback model's hot memories", async () => {
    using xumHome = new DisposableTempDir("ai-service-fallback-hot-memories");
    const projectPath = path.join(xumHome.path, "project");
    await fs.mkdir(projectPath, { recursive: true });

    const workspaceId = "workspace-fallback-hot-memories";
    const sourceModel = KNOWN_MODELS.SONNET.id;
    const fallbackModel = KNOWN_MODELS.GPT.id;
    await writeMainConfig(xumHome.path, {
      modelFallbacks: {
        [sourceModel]: { models: [fallbackModel] },
      },
    });

    const metadata = createLocalWorkspaceMetadata(workspaceId, projectPath);
    const experimentsService = new ExperimentsService({
      telemetryService: new TelemetryService(xumHome.path),
      xumHome: xumHome.path,
    });
    spyOn(experimentsService, "isExperimentEnabled").mockImplementation(
      (experimentId) =>
        experimentId === EXPERIMENT_IDS.MEMORY || experimentId === EXPERIMENT_IDS.MEMORY_HOT_SET
    );
    // eslint-disable-next-line @typescript-eslint/consistent-type-assertions -- stub for memory availability gating
    const stubTool: Tool = {} as never;
    const harness = createHarness(xumHome.path, metadata, {
      allTools: { memory: stubTool },
      useRequestedModelString: true,
      experimentsService,
    });
    harness.service.turnRequestBuilderBindings.memoryService = new MemoryService(
      harness.config,
      new MemoryMetaService(xumHome.path)
    );

    const memoryCalls: Array<{ modelString: string; includeHotMemories: boolean }> = [];
    const resolveMemoryContext = mock(
      (modelString: string, options?: { includeHotMemories?: boolean }) => {
        const includeHotMemories = options?.includeHotMemories !== false;
        memoryCalls.push({ modelString, includeHotMemories });
        return Promise.resolve({
          indexEntries: [],
          hotMemoriesBlock: includeHotMemories
            ? `<hot_memories>${modelString}</hot_memories>`
            : null,
        });
      }
    );

    const result = await harness.service.streamMessage({
      messages: [createMuxMessage("latest-user", "user", "fix the issue")],
      workspaceId,
      modelString: sourceModel,
      thinkingLevel: "off",
      experiments: { memory: true },
      resolveMemoryContext,
    });
    expect(result.success).toBe(true);

    const modelFallback = harness.startStreamCalls[0]?.modelFallback;
    expect(modelFallback).toBeDefined();
    if (!modelFallback) {
      throw new Error("Expected modelFallback options on startStream");
    }

    const prepared = await modelFallback.prepare(fallbackModel);
    expect(prepared.success).toBe(true);
    expect(memoryCalls).toContainEqual({ modelString: sourceModel, includeHotMemories: false });
    expect(memoryCalls).toContainEqual({ modelString: sourceModel, includeHotMemories: true });
    expect(memoryCalls).toContainEqual({ modelString: fallbackModel, includeHotMemories: true });
    expect(harness.streamSystemContextHotMemoriesBlocks).toContain(
      `<hot_memories>${fallbackModel}</hot_memories>`
    );
  });

  it("uses the admitted snapshot for primary, fallback, and thinking rebuilds without restoring live-denied tools", async () => {
    using xumHome = new DisposableTempDir("ai-pinned-request-assembly");
    const sourceModel = KNOWN_MODELS.SONNET.id;
    const fallbackModel = KNOWN_MODELS.GPT.id;
    await writeMainConfig(xumHome.path, {
      modelFallbacks: { [sourceModel]: { models: [fallbackModel] } },
    });
    const metadata = createLocalWorkspaceMetadata("pinned-request", xumHome.path);
    const harness = createHarness(xumHome.path, metadata, {
      allTools: { session_history: { inputSchema: jsonSchema({ type: "object" }) } },
      useRequestedModelString: true,
    });
    const seenModels: string[] = [];
    const unregister = eventSpine.useRequestContext(
      (ctx) => {
        seenModels.push(ctx.modelString);
        ctx.systemMessage += "\npinned-context";
      },
      { workspaceId: metadata.id }
    );
    let removeLive: (() => void) | undefined;
    try {
      const captured = await harness.service.captureRequestAssemblySnapshot(metadata.id);
      expect(captured.success).toBe(true);
      if (!captured.success) throw new Error("Expected assembly snapshot");
      expect(harness.getToolsForModelSpy).not.toHaveBeenCalled();
      unregister();
      const live = mock((ctx: RequestAssembleContext) => {
        delete ctx.tools.session_history;
      });
      removeLive = eventSpine.useBefore("request.assemble", live, { workspaceId: metadata.id });
      const request = {
        messages: [createMuxMessage("user", "user", "continue")],
        workspaceId: metadata.id,
        modelString: sourceModel,
        thinkingLevel: "off" as const,
      };
      expect(
        (
          await harness.service.streamMessage({
            ...request,
            requestAssemblySnapshot: captured.data,
          })
        ).success
      ).toBe(true);
      const primary = harness.startStreamCalls[0];
      expect(primary.tools?.session_history).toBeDefined();
      const rebuilt = await primary.rebuildFirstStepForThinkingLevel!("low", {});
      expect(JSON.stringify(rebuilt)).toContain("pinned-context");
      const fallback = await primary.modelFallback!.prepare(fallbackModel);
      expect(fallback.success).toBe(true);
      if (fallback.success) expect(fallback.data.tools?.session_history).toBeDefined();
      expect(seenModels).toEqual([sourceModel, fallbackModel]);
      expect(live).not.toHaveBeenCalled();
      expect((await harness.service.streamMessage(request)).success).toBe(true);
      expect(live).toHaveBeenCalledTimes(1);
      expect(harness.startStreamCalls[1].tools?.session_history).toBeUndefined();
    } finally {
      unregister();
      removeLive?.();
    }
  });

  it("emits startup breadcrumbs as runtime-status events before stream start", async () => {
    using xumHome = new DisposableTempDir("ai-service-startup-breadcrumbs");
    const projectPath = path.join(xumHome.path, "project");
    await fs.mkdir(projectPath, { recursive: true });

    const workspaceId = "workspace-startup-breadcrumbs";
    const metadata = createLocalWorkspaceMetadata(workspaceId, projectPath);
    const harness = createHarness(xumHome.path, metadata);
    const runtimeStatusEvents: RuntimeStatusEvent[] = [];

    harness.service.on("runtime-status", (event) => {
      runtimeStatusEvents.push(event as RuntimeStatusEvent);
    });

    const result = await harness.service.streamMessage({
      messages: [createMuxMessage("latest-user", "user", "hello")],
      workspaceId,
      modelString: "openai:gpt-5.2",
      thinkingLevel: "off",
    });

    expect(result.success).toBe(true);
    expect(
      runtimeStatusEvents.map((event) => ({
        phase: event.phase,
        detail: event.detail,
        runtimeType: event.runtimeType,
      }))
    ).toEqual([
      {
        phase: "waiting",
        detail: "Waiting for workspace initialization...",
        runtimeType: "local",
      },
      {
        phase: "starting",
        detail: "Checking workspace runtime...",
        runtimeType: "local",
      },
      {
        phase: "checking",
        detail: "Checking repository...",
        runtimeType: "local",
      },
      {
        phase: "ready",
        detail: undefined,
        runtimeType: "local",
      },
      {
        phase: "starting",
        detail: "Loading workspace context...",
        runtimeType: "local",
      },
      {
        phase: "starting",
        detail: "Loading tools...",
        runtimeType: "local",
      },
      {
        phase: "starting",
        detail: "Preparing model request...",
        runtimeType: "local",
      },
      {
        phase: "starting",
        detail: "Starting model stream...",
        runtimeType: "local",
      },
    ]);
  });

  it("reuses the pre-policy stream system context when advisor availability is unchanged", async () => {
    using xumHome = new DisposableTempDir("ai-service-reuse-system-context");
    const projectPath = path.join(xumHome.path, "project");
    await fs.mkdir(projectPath, { recursive: true });

    const workspaceId = "workspace-reuse-system-context";
    const metadata = createLocalWorkspaceMetadata(workspaceId, projectPath);
    const harness = createHarness(xumHome.path, metadata);

    const result = await harness.service.streamMessage({
      messages: [createMuxMessage("latest-user", "user", "hello")],
      workspaceId,
      modelString: "openai:gpt-5.2",
      thinkingLevel: "off",
    });

    expect(result.success).toBe(true);
    expect(harness.streamSystemContextAdvisorFlags).toEqual([false]);
    expect(harness.startStreamCalls[0]?.providedRuntimeTempDir).toBe(
      path.join(metadata.projectPath, ".tmp-stream")
    );
  });

  it("rebuilds the stream system context when policy removes advisor guidance", async () => {
    using xumHome = new DisposableTempDir("ai-service-rebuild-system-context-advisor");
    const projectPath = path.join(xumHome.path, "project");
    await fs.mkdir(projectPath, { recursive: true });

    const workspaceId = "workspace-rebuild-system-context-advisor";
    const metadata = createLocalWorkspaceMetadata(workspaceId, projectPath);
    // eslint-disable-next-line @typescript-eslint/consistent-type-assertions -- stub for advisor availability gating
    const stubTool: Tool = {} as never;
    const harness = createHarness(xumHome.path, metadata, {
      allTools: { advisor: stubTool },
      postPolicyTools: {},
    });
    await harness.config.editConfig((cfg) => {
      cfg.advisorModelString = KNOWN_MODELS.SONNET.id;
      return cfg;
    });

    const result = await harness.service.streamMessage({
      messages: [createMuxMessage("latest-user", "user", "hello")],
      workspaceId,
      modelString: "openai:gpt-5.2",
      thinkingLevel: "off",
      experiments: { advisorTool: true },
    });

    expect(result.success).toBe(true);
    expect(harness.streamSystemContextAdvisorFlags).toEqual([true, false]);
  });

  it("rebuilds the stream system context without memory availability when policy strips the memory tool", async () => {
    using xumHome = new DisposableTempDir("ai-service-rebuild-system-context-memory");
    const projectPath = path.join(xumHome.path, "project");
    await fs.mkdir(projectPath, { recursive: true });

    const workspaceId = "workspace-rebuild-system-context-memory";
    const metadata = createLocalWorkspaceMetadata(workspaceId, projectPath);
    // eslint-disable-next-line @typescript-eslint/consistent-type-assertions -- stub for memory availability gating
    const stubTool: Tool = {} as never;
    const harness = createHarness(xumHome.path, metadata, {
      allTools: { memory: stubTool },
      // Tool policy strips the memory tool: the final prompt must not claim
      // the memory tool is enabled (memoryToolAvailable gates the
      // hot-memories block; the index lives in the stripped tool's
      // description).
      postPolicyTools: {},
    });
    harness.service.turnRequestBuilderBindings.memoryService = new MemoryService(
      harness.config,
      new MemoryMetaService(xumHome.path)
    );
    const memoryCalls: Array<{ includeHotMemories: boolean }> = [];

    const result = await harness.service.streamMessage({
      messages: [createMuxMessage("latest-user", "user", "hello")],
      workspaceId,
      modelString: "openai:gpt-5.2",
      thinkingLevel: "off",
      experiments: { memory: true },
      resolveMemoryContext: (_modelString, options) => {
        memoryCalls.push({ includeHotMemories: options?.includeHotMemories !== false });
        return Promise.resolve({ indexEntries: [], hotMemoriesBlock: null });
      },
    });

    expect(result.success).toBe(true);
    expect(harness.streamSystemContextMemoryToolFlags).toEqual([true, false]);
    expect(memoryCalls).toEqual([{ includeHotMemories: false }]);
  });

  for (const scenario of [
    {
      name: "enabled parent",
      memory: true,
      intuition: true,
      child: false,
      service: true,
      eligible: true,
    },
    {
      name: "disabled flag",
      memory: true,
      intuition: false,
      child: false,
      service: true,
      eligible: false,
    },
    {
      name: "disabled intuition agent",
      memory: true,
      intuition: true,
      child: false,
      service: true,
      agentEnabled: false,
      eligible: false,
    },
    {
      name: "explicitly enabled intuition agent",
      memory: true,
      intuition: true,
      child: false,
      service: true,
      agentEnabled: true,
      eligible: true,
    },
    ...[
      { frontmatterDisabled: true, agentEnabled: undefined, eligible: false },
      { frontmatterDisabled: true, agentEnabled: undefined, emptyBody: true, eligible: false },
      { frontmatterDisabled: true, agentEnabled: true, eligible: true },
      { frontmatterDisabled: false, agentEnabled: false, eligible: false },
    ].map((definition) => ({
      name: `frontmatter disabled=${definition.frontmatterDisabled}, enabled override=${String(definition.agentEnabled)}, empty body=${"emptyBody" in definition}`,
      memory: true,
      intuition: true,
      child: false,
      service: true,
      ...definition,
    })),
    {
      name: "per-send false overriding host true",
      memory: true,
      intuition: true,
      memoryIntuitionOverride: false,
      child: false,
      service: true,
      eligible: false,
    },
    {
      name: "per-send true overriding host false",
      memory: true,
      intuition: false,
      memoryIntuitionOverride: true,
      child: false,
      service: true,
      eligible: true,
    },
    {
      name: "per-send true still gated by parent memory",
      memory: false,
      intuition: false,
      memoryIntuitionOverride: true,
      child: false,
      service: true,
      eligible: false,
    },
    {
      name: "per-send true still gated in subagents",
      memory: true,
      intuition: false,
      memoryIntuitionOverride: true,
      child: true,
      service: true,
      eligible: false,
    },
    {
      name: "disabled memory",
      memory: false,
      intuition: true,
      child: false,
      service: true,
      eligible: false,
    },
    {
      name: "missing service",
      memory: true,
      intuition: true,
      child: false,
      service: false,
      eligible: false,
    },
    {
      name: "subagent",
      memory: true,
      intuition: true,
      child: true,
      service: true,
      eligible: false,
    },
  ]) {
    it(`gates the intuition runtime and prompt for ${scenario.name}`, async () => {
      using xumHome = new DisposableTempDir("ai-intuition-gating");
      const metadata = createLocalWorkspaceMetadata("intuition-gating", xumHome.path);
      const experimentsService = new ExperimentsService({
        telemetryService: new TelemetryService(xumHome.path),
        xumHome: xumHome.path,
      });
      spyOn(experimentsService, "isExperimentEnabled").mockImplementation(
        (id) => id === EXPERIMENT_IDS.MEMORY_INTUITION && scenario.intuition
      );
      const harness = createHarness(xumHome.path, metadata, { experimentsService });
      const agent = resolvedAgentResultFor(metadata);
      if (!agent.success) throw new Error("Expected resolved agent");
      agent.data.isSubagentWorkspace = scenario.child;
      spyOn(agentResolution, "resolveAgentForStream").mockResolvedValue(agent);
      if (scenario.service)
        harness.service.turnRequestBuilderBindings.memoryService = new MemoryService(
          harness.config,
          new MemoryMetaService(xumHome.path)
        );
      const stubTool: Tool = { inputSchema: jsonSchema({ type: "object" }) };
      harness.getToolsForModelSpy.mockImplementation((_model, config) =>
        Promise.resolve({
          ...(config?.memoryService && config.experiments?.memory ? { memory: stubTool } : {}),
          ...(config?.intuitionRuntime ? { intuition: stubTool } : {}),
        })
      );
      await harness.config.editConfig((cfg) => {
        cfg.agentAiDefaults = {
          ...cfg.agentAiDefaults,
          intuition: {
            modelString: KNOWN_MODELS.SONNET.id,
            enabled: scenario.agentEnabled,
            thinkingLevel: "high",
          },
        };
        return cfg;
      });
      const frontmatterDisabled =
        "frontmatterDisabled" in scenario ? scenario.frontmatterDisabled : undefined;
      const definitionPath = path.join(xumHome.path, "agents", "intuition.md");
      if (frontmatterDisabled !== undefined) {
        await fs.mkdir(path.dirname(definitionPath), { recursive: true });
        await fs.writeFile(
          definitionPath,
          `---\nname: Intuition\ndisabled: ${frontmatterDisabled}\n---\n${"emptyBody" in scenario ? "" : "Pinned global intuition body."}`
        );
      }
      const createModel = spyOn(harness.service, "createModel");
      const result = await harness.service.streamMessage({
        messages: [createMuxMessage("user", "user", "hello")],
        workspaceId: metadata.id,
        modelString: "openai:gpt-5.2",
        thinkingLevel: "off",
        experiments: {
          memory: scenario.memory,
          memoryIntuition:
            "memoryIntuitionOverride" in scenario ? scenario.memoryIntuitionOverride : undefined,
        },
      });
      expect(result.success).toBe(true);
      const runtime = harness.getToolsForModelSpy.mock.calls[0]?.[1]?.intuitionRuntime;
      expect(runtime !== undefined).toBe(scenario.eligible);
      if (runtime) {
        expect(runtime.modelString).toBe(KNOWN_MODELS.SONNET.id);
        expect(runtime.thinkingLevel).toBe("high");
        if (frontmatterDisabled !== undefined) {
          await fs.writeFile(
            definitionPath,
            "---\nname: Intuition\ndisabled: true\n---\nChanged after gate."
          );
          expect(await runtime.resolveAgentBody()).toBe("Pinned global intuition body.");
        }
      }
      expect(harness.streamSystemContextIntuitionFlags).toEqual([scenario.eligible]);
      expect(harness.startStreamCalls[0]?.tools?.intuition !== undefined).toBe(scenario.eligible);
      expect(createModel).not.toHaveBeenCalled();
    });
  }

  it.each([false, true])(
    "pins intuition to the resolved definition route before its parent fallback (definition override=%s)",
    async (definitionOverride) => {
      using xumHome = new DisposableTempDir("ai-intuition-selected-route");
      const metadata = createLocalWorkspaceMetadata("intuition-selected-route", xumHome.path);
      const experimentsService = new ExperimentsService({
        telemetryService: new TelemetryService(xumHome.path),
        xumHome: xumHome.path,
      });
      spyOn(experimentsService, "isExperimentEnabled").mockImplementation(
        (id) => id === EXPERIMENT_IDS.MEMORY_INTUITION
      );
      const harness = createHarness(xumHome.path, metadata, { experimentsService });
      harness.service.turnRequestBuilderBindings.memoryService = new MemoryService(
        harness.config,
        new MemoryMetaService(xumHome.path)
      );
      const selected = "private:exec-global";
      if (definitionOverride) {
        const agents = path.join(xumHome.path, "agents");
        await fs.mkdir(agents, { recursive: true });
        await fs.writeFile(
          path.join(agents, "intuition.md"),
          "---\nname: Intuition\nbase: private-base\n---\nLocal guidance."
        );
        await fs.writeFile(
          path.join(agents, "private-base.md"),
          "---\nname: Private base\nai:\n  model: private:definition-route\n  thinkingLevel: low\n---\nPrivate guidance."
        );
      }
      await harness.config.editConfig((cfg) => {
        cfg.agentAiDefaults = { exec: { modelString: selected } };
        cfg.projects.set(metadata.projectPath, {
          workspaces: [
            {
              path: metadata.projectPath,
              id: metadata.id,
              agentId: "exec",
              aiSettingsByAgent: { plan: { model: "openai:stale-plan", thinkingLevel: "off" } },
            },
          ],
        });
        return cfg;
      });
      const result = await harness.service.streamMessage({
        messages: [createMuxMessage("user", "user", "hello")],
        workspaceId: metadata.id,
        modelString: selected,
        thinkingLevel: "high",
        experiments: { memory: true },
      });
      expect(result.success).toBe(true);
      expect(harness.getToolsForModelSpy.mock.calls[0]?.[1]?.intuitionRuntime?.thinkingLevel).toBe(
        definitionOverride ? "low" : "off"
      );
      expect(harness.getToolsForModelSpy.mock.calls[0]?.[1]?.intuitionRuntime?.modelString).toBe(
        definitionOverride ? "private:definition-route" : selected
      );
    }
  );

  it.each(["off", "high"] as const)(
    "creates Intuition's effort-dependent model variant with %s reasoning from one provider snapshot",
    async (thinkingLevel) => {
      using xumHome = new DisposableTempDir("ai-intuition-model-variant");
      const metadata = createLocalWorkspaceMetadata("intuition-variant", xumHome.path);
      const experimentsService = new ExperimentsService({
        telemetryService: new TelemetryService(xumHome.path),
        xumHome: xumHome.path,
      });
      spyOn(experimentsService, "isExperimentEnabled").mockImplementation(
        (id) => id === EXPERIMENT_IDS.MEMORY_INTUITION
      );
      const harness = createHarness(xumHome.path, metadata, { experimentsService });
      harness.service.turnRequestBuilderBindings.memoryService = new MemoryService(
        harness.config,
        new MemoryMetaService(xumHome.path)
      );
      const providersStore = new ProvidersConfigStore(harness.config.rootDir);
      providersStore.saveProvidersConfig({ xai: { apiKey: "test-xai-key" } });
      await harness.config.editConfig((cfg) => ({
        ...cfg,
        agentAiDefaults: { intuition: { modelString: "xai:grok-4-1-fast", thinkingLevel } },
      }));
      const result = await harness.service.streamMessage({
        messages: [createMuxMessage("user", "user", "hello")],
        workspaceId: metadata.id,
        modelString: "openai:gpt-5.2",
        thinkingLevel: "off",
        experiments: { memory: true },
      });
      expect(result.success).toBe(true);
      const runtime = harness.getToolsForModelSpy.mock.calls[0]?.[1]?.intuitionRuntime;
      if (!runtime) throw new Error("Expected Intuition runtime");
      const factory = Reflect.get(harness.service, "providerModelFactory") as ProviderModelFactory;
      const resolve = spyOn(factory, "resolveAndCreateModel").mockImplementation((...args) => {
        // A concurrent config change must not replace the tool's creation-time snapshot.
        providersStore.saveProvidersConfig({ xai: { enabled: false } });
        return ProviderModelFactory.prototype.resolveAndCreateModel.apply(factory, args);
      });
      const created = await runtime.createModel(runtime.modelString);
      expect(typeof created.model).not.toBe("string");
      if (typeof created.model === "string") throw new Error("Expected model instance");
      expect(created.model.modelId).toBe(
        thinkingLevel === "off" ? "grok-4-1-fast-non-reasoning" : "grok-4-1-fast-reasoning"
      );
      expect(resolve).toHaveBeenCalledWith(
        "xai:grok-4-1-fast",
        thinkingLevel,
        expect.anything(),
        expect.objectContaining({
          workspaceId: metadata.id,
          agentInitiated: true,
          providersConfig: { xai: { apiKey: "test-xai-key" } },
        })
      );
      expect(created.optionsProvidersConfig?.xai?.isEnabled).toBe(true);
    }
  );

  for (const denied of ["memory", "intuition"]) {
    it(`strips intuition and its guidance when policy denies ${denied}`, async () => {
      using xumHome = new DisposableTempDir("ai-intuition-policy");
      const metadata = createLocalWorkspaceMetadata("intuition-policy", xumHome.path);
      const experimentsService = new ExperimentsService({
        telemetryService: new TelemetryService(xumHome.path),
        xumHome: xumHome.path,
      });
      spyOn(experimentsService, "isExperimentEnabled").mockImplementation(
        (id) => id === EXPERIMENT_IDS.MEMORY_INTUITION
      );
      const stubTool: Tool = { inputSchema: jsonSchema({ type: "object" }) };
      const harness = createHarness(xumHome.path, metadata, {
        experimentsService,
        allTools: { memory: stubTool, intuition: stubTool },
      });
      harness.service.turnRequestBuilderBindings.memoryService = new MemoryService(
        harness.config,
        new MemoryMetaService(xumHome.path)
      );
      const agent = resolvedAgentResultFor(metadata);
      if (!agent.success) throw new Error("Expected resolved agent");
      agent.data.effectiveToolPolicy = [
        { regex_match: "intuition", action: "enable" },
        { regex_match: denied, action: "disable" },
      ];
      spyOn(agentResolution, "resolveAgentForStream").mockResolvedValue(agent);
      const result = await harness.service.streamMessage({
        messages: [createMuxMessage("user", "user", "hello")],
        workspaceId: metadata.id,
        modelString: "openai:gpt-5.2",
        thinkingLevel: "off",
        experiments: { memory: true },
      });
      expect(result.success).toBe(true);
      expect(harness.startStreamCalls[0]?.tools?.intuition).toBeUndefined();
      expect(harness.startStreamCalls[0]?.tools?.memory !== undefined).toBe(denied !== "memory");
      expect(harness.streamSystemContextIntuitionFlags).toEqual([true, false]);
      expect(harness.streamSystemContextMemoryToolFlags).toEqual([true, denied !== "memory"]);
    });
  }

  it.each(["memory", "intuition", "restore-denied"])(
    "keeps recall policy enforced after request middleware: %s",
    async (mode) => {
      using xumHome = new DisposableTempDir("ai-intuition-middleware");
      const metadata = createLocalWorkspaceMetadata("intuition-middleware", xumHome.path);
      const experimentsService = new ExperimentsService({
        telemetryService: new TelemetryService(xumHome.path),
        xumHome: xumHome.path,
      });
      spyOn(experimentsService, "isExperimentEnabled").mockImplementation(
        (id) => id === EXPERIMENT_IDS.MEMORY_INTUITION
      );
      const stubTool: Tool = { inputSchema: jsonSchema({ type: "object" }) };
      const harness = createHarness(xumHome.path, metadata, {
        experimentsService,
        allTools: { memory: stubTool, intuition: stubTool },
        ...(mode === "restore-denied" ? { postPolicyTools: { memory: stubTool } } : {}),
      });
      harness.service.turnRequestBuilderBindings.memoryService = new MemoryService(
        harness.config,
        new MemoryMetaService(xumHome.path)
      );
      const removeHook = eventSpine.useBefore("request.assemble", (ctx) => {
        if (ctx.workspaceId !== metadata.id) return;
        if (mode === "restore-denied") ctx.tools.intuition = stubTool;
        else delete ctx.tools[mode];
        ctx.systemMessage += "\nPreserved plugin context.";
      });
      try {
        const result = await harness.service.streamMessage({
          messages: [createMuxMessage("user", "user", "hello")],
          workspaceId: metadata.id,
          modelString: "openai:gpt-5.2",
          thinkingLevel: "off",
          experiments: { memory: true },
        });
        expect(result.success).toBe(true);
        expect(harness.startStreamCalls[0]?.tools?.intuition).toBeUndefined();
        expect(harness.startStreamCalls[0]?.tools?.memory !== undefined).toBe(mode !== "memory");
        expect(JSON.stringify(harness.startStreamCalls[0]?.system)).toContain(
          "Preserved plugin context."
        );
      } finally {
        removeHook();
      }
    }
  );

  it("does not upgrade memory context when the hot-set sub-experiment is disabled", async () => {
    using xumHome = new DisposableTempDir("ai-service-memory-hot-set-disabled");
    const projectPath = path.join(xumHome.path, "project");
    await fs.mkdir(projectPath, { recursive: true });

    const workspaceId = "workspace-memory-hot-set-disabled";
    const metadata = createLocalWorkspaceMetadata(workspaceId, projectPath);
    // eslint-disable-next-line @typescript-eslint/consistent-type-assertions -- stub for memory availability gating
    const stubTool: Tool = {} as never;
    const harness = createHarness(xumHome.path, metadata, {
      allTools: { memory: stubTool },
    });
    harness.service.turnRequestBuilderBindings.memoryService = new MemoryService(
      harness.config,
      new MemoryMetaService(xumHome.path)
    );
    const memoryCalls: Array<{ includeHotMemories: boolean }> = [];

    const result = await harness.service.streamMessage({
      messages: [createMuxMessage("latest-user", "user", "hello")],
      workspaceId,
      modelString: "openai:gpt-5.2",
      thinkingLevel: "off",
      experiments: { memory: true },
      resolveMemoryContext: (_modelString, options) => {
        memoryCalls.push({ includeHotMemories: options?.includeHotMemories !== false });
        return Promise.resolve({ indexEntries: [], hotMemoriesBlock: null });
      },
    });

    expect(result.success).toBe(true);
    expect(harness.streamSystemContextMemoryToolFlags).toEqual([true]);
    expect(memoryCalls).toEqual([{ includeHotMemories: false }]);
  });

  it("anchors the memory index by project identity and gates hot preloading on the memory-hot-set experiment", async () => {
    using xumHome = new DisposableTempDir("ai-service-memory-session-context");
    const projectPath = path.join(xumHome.path, "project");
    const checkoutRoot = path.join(xumHome.path, "checkout");
    const subProjectCwd = path.join(checkoutRoot, "packages", "app");
    await fs.mkdir(subProjectCwd, { recursive: true });
    // Project memory lives in a host-local root keyed by the stable project
    // identity, so the advertised index must enumerate it even when the
    // workspace executes inside a sub-project checkout directory.
    const projectMemoryRoot = path.join(
      xumHome.path,
      "memory",
      "project",
      projectMemoryDirName(projectPath)
    );
    await fs.mkdir(projectMemoryRoot, { recursive: true });
    await fs.writeFile(path.join(projectMemoryRoot, "root-note.md"), "root fact\n");

    let hotSetEnabled = false;
    const experimentsService = new ExperimentsService({
      telemetryService: new TelemetryService(xumHome.path),
      xumHome: xumHome.path,
    });
    spyOn(experimentsService, "isExperimentEnabled").mockImplementation(
      (experimentId) =>
        experimentId === EXPERIMENT_IDS.MEMORY ||
        (experimentId === EXPERIMENT_IDS.MEMORY_HOT_SET && hotSetEnabled)
    );
    const { config, service } = createBasicAIService(xumHome.path, { experimentsService });
    const memoryService = new MemoryService(config, new MemoryMetaService(xumHome.path));
    service.turnRequestBuilderBindings.memoryService = memoryService;

    const workspaceId = "workspace-memory-session-context";
    // namedWorkspacePath is the persisted checkout root consumed by
    // resolveWorkspaceRootPath (WorkspaceMetadataForRuntime extension).
    const metadata: WorkspaceMetadata & { namedWorkspacePath: string } = {
      ...createLocalWorkspaceMetadata(workspaceId, projectPath),
      runtimeConfig: DEFAULT_RUNTIME_CONFIG,
      namedWorkspacePath: checkoutRoot,
      subProjectPath: "packages/app",
    };
    spyOn(service, "getWorkspaceMetadata").mockResolvedValue({ success: true, data: metadata });
    // Hot selection needs sidecar usage stats; stub the real instance so the
    // gating branch (not the ranking) is under test.
    const listHotSpy = spyOn(memoryService, "listHotMemories").mockResolvedValue([
      {
        path: "/memories/project/root-note.md",
        pinned: true,
        truncated: false,
        content: "root fact",
      },
    ]);

    const pullOnly = await service.buildMemorySessionContext(workspaceId, "openai:gpt-5.2");
    expect(pullOnly?.indexEntries.map((entry) => entry.path)).toEqual([
      "/memories/project/root-note.md",
    ]);
    // Sub-experiment off: no preloaded content, memories stay pull-based.
    expect(pullOnly?.hotMemoriesBlock).toBeNull();
    expect(listHotSpy).not.toHaveBeenCalled();

    hotSetEnabled = true;
    const withHotSet = await service.buildMemorySessionContext(workspaceId, "openai:gpt-5.2");
    expect(withHotSet?.hotMemoriesBlock).toContain("root fact");
  });

  it("adds context notes only for an active request with Memory and HotSet allowed", async () => {
    using root = new DisposableTempDir("ai-service-additive-context-notes");
    let memoryEnabled = true;
    let hotSetEnabled = true;
    const experimentsService = new ExperimentsService({
      telemetryService: new TelemetryService(root.path),
      xumHome: root.path,
    });
    spyOn(experimentsService, "isExperimentEnabled").mockImplementation(
      (id) =>
        (id === EXPERIMENT_IDS.MEMORY && memoryEnabled) ||
        (id === EXPERIMENT_IDS.MEMORY_HOT_SET && hotSetEnabled)
    );
    const { config, service } = createBasicAIService(root.path, { experimentsService });
    const metaService = new MemoryMetaService(root.path);
    const memoryService = new MemoryService(config, metaService);
    service.turnRequestBuilderBindings.memoryService = memoryService;
    const workspaceId = "additive-context-notes";
    spyOn(service, "getWorkspaceMetadata").mockResolvedValue({
      success: true,
      data: {
        ...createLocalWorkspaceMetadata(workspaceId, root.path),
        runtimeConfig: { type: "local" },
      },
    });
    const directory = path.join(config.sessionsDir, workspaceId, "memory");
    await fs.mkdir(directory, { recursive: true });
    const file = path.join(directory, "context-notes.md");
    await fs.writeFile(file, "Unused but important handoff facts");
    const before = await metaService.getEntries();
    const build = (options?: Parameters<AIService["buildMemorySessionContext"]>[2]) =>
      service.buildMemorySessionContext(workspaceId, "openai:gpt-5.2", options);
    expect((await build())?.hotMemoriesBlock).toBeNull();
    expect((await build({ tokenBudgetActive: true }))?.hotMemoriesBlock).toContain(
      "Unused but important handoff facts"
    );
    expect((await build({ tokenBudgetActive: false }))?.hotMemoriesBlock).toBeNull();
    expect(
      (await build({ tokenBudgetActive: true, includeHotMemories: false }))?.hotMemoriesBlock
    ).toBeNull();
    hotSetEnabled = false;
    expect((await build({ tokenBudgetActive: true }))?.hotMemoriesBlock).toBeNull();
    memoryEnabled = false;
    expect(await build({ tokenBudgetActive: true })).toBeNull();
    expect(await metaService.getEntries()).toEqual(before);
    expect(await fs.readFile(file, "utf8")).toBe("Unused but important handoff facts");
  });

  it("preserves the memory index when hot-memory selection fails", async () => {
    using xumHome = new DisposableTempDir("ai-service-memory-hot-failure");
    const projectPath = path.join(xumHome.path, "project");
    const checkoutRoot = path.join(xumHome.path, "checkout");
    const projectMemoryRoot = path.join(
      xumHome.path,
      "memory",
      "project",
      projectMemoryDirName(projectPath)
    );
    await fs.mkdir(projectMemoryRoot, { recursive: true });
    await fs.writeFile(path.join(projectMemoryRoot, "root-note.md"), "root fact\n");

    const experimentsService = new ExperimentsService({
      telemetryService: new TelemetryService(xumHome.path),
      xumHome: xumHome.path,
    });
    spyOn(experimentsService, "isExperimentEnabled").mockImplementation(
      (experimentId) =>
        experimentId === EXPERIMENT_IDS.MEMORY || experimentId === EXPERIMENT_IDS.MEMORY_HOT_SET
    );
    const { config, service } = createBasicAIService(xumHome.path, { experimentsService });
    const memoryService = new MemoryService(config, new MemoryMetaService(xumHome.path));
    service.turnRequestBuilderBindings.memoryService = memoryService;

    const workspaceId = "workspace-memory-hot-failure";
    const metadata: WorkspaceMetadata & { namedWorkspacePath: string } = {
      ...createLocalWorkspaceMetadata(workspaceId, projectPath),
      runtimeConfig: DEFAULT_RUNTIME_CONFIG,
      namedWorkspacePath: checkoutRoot,
    };
    spyOn(service, "getWorkspaceMetadata").mockResolvedValue({ success: true, data: metadata });
    spyOn(memoryService, "listHotMemories").mockImplementation(() => {
      throw new Error("tokenizer failed");
    });

    const context = await service.buildMemorySessionContext(workspaceId, "openai:gpt-5.2");

    expect(context?.indexEntries.map((entry) => entry.path)).toEqual([
      "/memories/project/root-note.md",
    ]);
    expect(context?.hotMemoriesBlock).toBeNull();
  });

  it("resolves the memory context only after the runtime is ready", async () => {
    using xumHome = new DisposableTempDir("ai-service-hot-memories-after-ready");
    const projectPath = path.join(xumHome.path, "project");
    await fs.mkdir(projectPath, { recursive: true });

    const workspaceId = "workspace-hot-memories-after-ready";
    const metadata = createLocalWorkspaceMetadata(workspaceId, projectPath);
    const harness = createHarness(xumHome.path, metadata);

    // Ordering is the contract under test: AgentSession caches the resolver
    // result per model/session segment, so resolving before ensureReady on a
    // stopped Docker/remote workspace would pin an empty/partial block.
    const order: string[] = [];
    const realCreateRuntime = runtimeFactory.createRuntime;
    spyOn(runtimeFactory, "createRuntime").mockImplementation((runtimeConfig, options) => {
      const runtime = realCreateRuntime(runtimeConfig, options);
      const realEnsureReady = runtime.ensureReady.bind(runtime);
      spyOn(runtime, "ensureReady").mockImplementation((...readyArgs) => {
        order.push("ensureReady");
        return realEnsureReady(...readyArgs);
      });
      return runtime;
    });

    const result = await harness.service.streamMessage({
      messages: [createMuxMessage("latest-user", "user", "hello")],
      workspaceId,
      modelString: "openai:gpt-5.2",
      thinkingLevel: "off",
      resolveMemoryContext: () => {
        order.push("resolveMemoryContext");
        return Promise.resolve({
          indexEntries: [{ path: "/memories/global/lesson.md", description: "a lesson" }],
          hotMemoriesBlock: "<hot_memories>cached</hot_memories>",
        });
      },
    });

    expect(result.success).toBe(true);
    expect(order.indexOf("ensureReady")).toBeGreaterThanOrEqual(0);
    expect(order.indexOf("resolveMemoryContext")).toBeGreaterThan(order.indexOf("ensureReady"));
    expect(harness.streamSystemContextHotMemoriesBlocks).toContain(
      "<hot_memories>cached</hot_memories>"
    );
    // The index snapshot flows into the tool configuration so the memory tool
    // can advertise it in its description (same disclosure mechanic as skills).
    const toolConfig = harness.getToolsForModelSpy.mock.calls[0]?.[1];
    expect(toolConfig).toMatchObject({
      memoryIndexEntries: [{ path: "/memories/global/lesson.md", description: "a lesson" }],
    });
  });

  it.each([
    { auth: "oauth", model: KNOWN_MODELS.GPT_53_CODEX.id },
    { auth: "oauth", model: "openai:team-codex" },
    { auth: "apiKey", model: KNOWN_MODELS.GPT_53_CODEX.id },
  ] as const)("keeps $auth chat usage priced for $model", async ({ auth, model }) => {
    using xumHome = new DisposableTempDir("ai-service-codex-costs");
    const projectPath = path.join(xumHome.path, "project");
    await fs.mkdir(projectPath, { recursive: true });
    const workspaceId = "workspace-codex-costs";
    const metadata = createLocalWorkspaceMetadata(workspaceId, projectPath);
    const harness = createHarness(xumHome.path, metadata);
    const providersConfig = {
      openai: {
        ...(auth === "oauth" ? { codexOauth: TEST_CODEX_OAUTH } : { apiKey: "sk-test" }),
        models: [{ id: "team-codex", mappedToModel: KNOWN_MODELS.GPT_53_CODEX.id }],
      },
    };
    new ProvidersConfigStore(harness.config.rootDir).saveProvidersConfig(providersConfig);

    // Use real model creation so authentication participates in the pricing regression.
    const factory = Reflect.get(harness.service, "providerModelFactory") as ProviderModelFactory;
    spyOn(factory, "resolveAndCreateModel").mockImplementation(
      ProviderModelFactory.prototype.resolveAndCreateModel.bind(factory)
    );
    const result = await harness.service.streamMessage({
      messages: [createMuxMessage("latest-user", "user", "continue")],
      workspaceId,
      modelString: model,
      thinkingLevel: "off",
    });
    expect(result.success).toBe(true);
    expect(harness.startStreamCalls).toHaveLength(1);
    const stream = harness.startStreamCalls[0];
    if (!stream) throw new Error("Expected stream options");
    const initialMetadata = initialMetadataFromStartStreamCall(stream);
    expect(initialMetadata.costsIncluded).toBeUndefined();

    const usage = createDisplayUsage(
      { inputTokens: 1500, cachedInputTokens: 500, outputTokens: 450, reasoningTokens: 150 },
      stream.modelString,
      { mux: initialMetadata },
      resolveModelForMetadata(stream.modelString, stream.providersConfigSnapshot ?? null)
    );
    expect(usage).toBeDefined();
    if (!usage) throw new Error("Expected display usage");
    expect(usage.costsIncluded).toBeUndefined();
    expect(usage.input.cost_usd).toBeGreaterThan(0);
    expect(usage.cached.cost_usd).toBeGreaterThan(0);
    expect(usage.output.cost_usd).toBeGreaterThan(0);
    expect(usage.reasoning.cost_usd).toBeGreaterThan(0);
  });

  it("passes the resolved routeProvider into initial stream metadata", async () => {
    using xumHome = new DisposableTempDir("ai-service-route-provider-present");
    const projectPath = path.join(xumHome.path, "project");
    await fs.mkdir(projectPath, { recursive: true });

    const workspaceId = "workspace-route-provider-present";
    const metadata = createLocalWorkspaceMetadata(workspaceId, projectPath);
    const harness = createHarness(xumHome.path, metadata, { routeProvider: "openrouter" });

    const result = await harness.service.streamMessage({
      messages: [createMuxMessage("latest-user", "user", "continue")],
      workspaceId,
      modelString: "openai:gpt-5.2",
      thinkingLevel: "medium",
    });

    expect(result.success).toBe(true);
    expect(harness.startStreamCalls).toHaveLength(1);

    const startStreamCall = harness.startStreamCalls[0];
    expect(startStreamCall).toBeDefined();
    if (!startStreamCall) {
      throw new Error("Expected streamManager.startStream call arguments");
    }

    const initialMetadata = initialMetadataFromStartStreamCall(startStreamCall);
    expect(initialMetadata.routeProvider).toBe("openrouter");
  });

  it("passes muxMetadata into initial stream metadata", async () => {
    using xumHome = new DisposableTempDir("ai-service-mux-metadata");
    const projectPath = path.join(xumHome.path, "project");
    await fs.mkdir(projectPath, { recursive: true });

    const workspaceId = "workspace-mux-metadata";
    const metadata = createLocalWorkspaceMetadata(workspaceId, projectPath);
    const harness = createHarness(xumHome.path, metadata);

    const result = await harness.service.streamMessage({
      messages: [createMuxMessage("latest-user", "user", "continue")],
      workspaceId,
      modelString: "openai:gpt-5.2",
      thinkingLevel: "medium",
      muxMetadata: {
        type: "workspace-turn-task",
        taskHandleId: "wst_handle",
        ownerWorkspaceId: "owner-workspace",
        turnId: "turn-id",
      },
    });

    expect(result.success).toBe(true);
    expect(harness.startStreamCalls).toHaveLength(1);

    const startStreamCall = harness.startStreamCalls[0];
    expect(startStreamCall).toBeDefined();
    if (!startStreamCall) {
      throw new Error("Expected streamManager.startStream call arguments");
    }

    const initialMetadata = initialMetadataFromStartStreamCall(startStreamCall);
    expect(initialMetadata.muxMetadata).toEqual({
      type: "workspace-turn-task",
      taskHandleId: "wst_handle",
      ownerWorkspaceId: "owner-workspace",
      turnId: "turn-id",
    });
  });

  it("omits routeProvider from initial stream metadata when unresolved", async () => {
    using xumHome = new DisposableTempDir("ai-service-route-provider-absent");
    const projectPath = path.join(xumHome.path, "project");
    await fs.mkdir(projectPath, { recursive: true });

    const workspaceId = "workspace-route-provider-absent";
    const metadata = createLocalWorkspaceMetadata(workspaceId, projectPath);
    const harness = createHarness(xumHome.path, metadata);

    const result = await harness.service.streamMessage({
      messages: [createMuxMessage("latest-user", "user", "continue")],
      workspaceId,
      modelString: "openai:gpt-5.2",
      thinkingLevel: "medium",
    });

    expect(result.success).toBe(true);
    expect(harness.startStreamCalls).toHaveLength(1);

    const startStreamCall = harness.startStreamCalls[0];
    expect(startStreamCall).toBeDefined();
    if (!startStreamCall) {
      throw new Error("Expected streamManager.startStream call arguments");
    }

    const initialMetadata = initialMetadataFromStartStreamCall(startStreamCall);
    expect(Object.prototype.hasOwnProperty.call(initialMetadata, "routeProvider")).toBe(false);
  });

  it.each([
    { advisorReasoningMode: "pro", parentMode: "standard" },
    { advisorReasoningMode: "standard", parentMode: "pro" },
    { advisorReasoningMode: undefined, parentMode: "pro" },
  ] as const)("pins advisor mode independently of the parent: %j", async (testCase) => {
    using xumHome = new DisposableTempDir("ai-service-advisor-reasoning-mode");
    const projectPath = path.join(xumHome.path, "project");
    await fs.mkdir(projectPath, { recursive: true });
    const workspaceId = "workspace-advisor-reasoning-mode";
    const harness = createHarness(
      xumHome.path,
      createLocalWorkspaceMetadata(workspaceId, projectPath)
    );
    await enableAdvisorForHarness(harness, "openai:gpt-5.6");
    await harness.config.saveUserConfig({
      advisorThinkingLevel: "high",
      advisorReasoningMode: testCase.advisorReasoningMode,
    });
    const result = await harness.service.streamMessage({
      messages: [createMuxMessage("latest-user", "user", "continue")],
      workspaceId,
      modelString: "openai:gpt-5.6",
      thinkingLevel: "max",
      reasoningMode: testCase.parentMode,
      experiments: { advisorTool: true },
    });
    expect(result.success).toBe(true);
    expect(getToolConfigFromHarness(harness).advisorRuntime).toMatchObject({
      reasoningLevel: "high",
      reasoningMode: testCase.advisorReasoningMode,
    });
  });

  it.each([
    { model: "openai:gpt-5.6", wireFormat: "responses", route: "openai" },
    { model: "openai:gpt-5.6", wireFormat: "chatCompletions", route: "openai" },
    { model: "mux-gateway:openai/gpt-5.6", wireFormat: "responses", route: "mux-gateway" },
  ] as const)("pins advisor wire and route independently of live config: %j", async (testCase) => {
    using xumHome = new DisposableTempDir("ai-service-advisor-reasoning-route");
    const projectPath = path.join(xumHome.path, "project");
    await fs.mkdir(projectPath, { recursive: true });
    const workspaceId = "workspace-advisor-reasoning-route";
    const harness = createHarness(
      xumHome.path,
      createLocalWorkspaceMetadata(workspaceId, projectPath)
    );
    const providersStore = new ProvidersConfigStore(harness.config.rootDir);
    providersStore.saveProvidersConfig({
      openai: { apiKey: "sk-test-key", wireFormat: testCase.wireFormat },
      "mux-gateway": { couponCode: "test-coupon" },
    });
    await harness.config.editConfig((cfg) => ({
      ...cfg,
      routePriority: ["direct"],
      muxGatewayEnabled: true,
    }));
    await enableAdvisorForHarness(harness, testCase.model);
    await startAdvisorStream(harness, workspaceId);
    const runtime = harness.getToolsForModelSpy.mock.calls[0]?.[1].advisorRuntime;
    if (!runtime) throw new Error("Expected advisor runtime");
    const created = await runtime.createModel(testCase.model);
    providersStore.saveProvidersConfig({
      openai: { apiKey: "changed-key", wireFormat: "responses" },
    });

    expect(created.optionsRouteProvider).toBe(testCase.route);
    expect(normalizeToCanonical(created.optionsModelString)).toBe("openai:gpt-5.6");
    if (testCase.route === "openai") {
      expect(created.optionsMuxProviderOptions?.openai?.wireFormat).toBe(testCase.wireFormat);
    }
  });

  it("freezes advisor tool-call snapshots at the tool-call boundary", async () => {
    using xumHome = new DisposableTempDir("ai-service-advisor-step-snapshot-boundary");
    const projectPath = path.join(xumHome.path, "project");
    await fs.mkdir(projectPath, { recursive: true });

    const workspaceId = "workspace-advisor-step-snapshot-boundary";
    const metadata = createLocalWorkspaceMetadata(workspaceId, projectPath);
    const harness = createHarness(xumHome.path, metadata);
    await enableAdvisorForHarness(harness);

    await startAdvisorStream(harness, workspaceId);

    const advisorRuntime = getAdvisorRuntimeFromHarness(harness);
    const { onChunk, onStepMessages } = getAdvisorCallbacksFromHarness(harness);
    onStepMessages([{ role: "user", content: "continue" }]);

    const input = { focus: "shared context" };
    await onChunk({ chunk: { type: "text-delta", delta: "draft answer" } });
    await onChunk({ chunk: { type: "reasoning-delta", delta: "risk analysis" } });
    await onChunk({
      chunk: {
        type: "tool-call",
        toolCallId: "advisor-call-1",
        toolName: "advisor",
        input,
      },
    });
    input.focus = "mutated after freeze";

    expect(advisorRuntime.takeToolCallSnapshot("advisor-call-1")).toEqual({
      toolCallId: "advisor-call-1",
      toolName: "advisor",
      input: { focus: "shared context" },
      stepText: "draft answer",
      stepReasoning: "risk analysis",
    });
  });

  it("keeps multiple advisor tool-call snapshots isolated within the same step", async () => {
    using xumHome = new DisposableTempDir("ai-service-advisor-step-snapshot-isolated");
    const projectPath = path.join(xumHome.path, "project");
    await fs.mkdir(projectPath, { recursive: true });

    const workspaceId = "workspace-advisor-step-snapshot-isolated";
    const metadata = createLocalWorkspaceMetadata(workspaceId, projectPath);
    const harness = createHarness(xumHome.path, metadata);
    await enableAdvisorForHarness(harness);

    await startAdvisorStream(harness, workspaceId);

    const advisorRuntime = getAdvisorRuntimeFromHarness(harness);
    const { onChunk, onStepMessages } = getAdvisorCallbacksFromHarness(harness);
    onStepMessages([{ role: "user", content: "continue" }]);

    await onChunk({ chunk: { type: "text-delta", delta: "alpha" } });
    await onChunk({ chunk: { type: "reasoning-delta", delta: "first" } });
    await onChunk({
      chunk: {
        type: "tool-call",
        toolCallId: "advisor-call-1",
        toolName: "advisor",
        input: {},
      },
    });
    await onChunk({ chunk: { type: "text-delta", delta: " beta" } });
    await onChunk({ chunk: { type: "reasoning-delta", delta: " second" } });
    await onChunk({
      chunk: {
        type: "tool-call",
        toolCallId: "advisor-call-2",
        toolName: "advisor",
        input: {},
      },
    });

    expect(advisorRuntime.takeToolCallSnapshot("advisor-call-1")).toMatchObject({
      stepText: "alpha",
      stepReasoning: "first",
    });
    expect(advisorRuntime.takeToolCallSnapshot("advisor-call-2")).toMatchObject({
      stepText: "alpha beta",
      stepReasoning: "first second",
    });
  });

  it("resets advisor step capture buffers and frozen snapshots between steps", async () => {
    using xumHome = new DisposableTempDir("ai-service-advisor-step-snapshot-reset");
    const projectPath = path.join(xumHome.path, "project");
    await fs.mkdir(projectPath, { recursive: true });

    const workspaceId = "workspace-advisor-step-snapshot-reset";
    const metadata = createLocalWorkspaceMetadata(workspaceId, projectPath);
    const harness = createHarness(xumHome.path, metadata);
    await enableAdvisorForHarness(harness);

    await startAdvisorStream(harness, workspaceId);

    const advisorRuntime = getAdvisorRuntimeFromHarness(harness);
    const { onChunk, onStepMessages } = getAdvisorCallbacksFromHarness(harness);
    onStepMessages([{ role: "user", content: "step 1" }]);

    await onChunk({ chunk: { type: "text-delta", delta: "old text" } });
    await onChunk({ chunk: { type: "reasoning-delta", delta: "old reasoning" } });
    await onChunk({
      chunk: {
        type: "tool-call",
        toolCallId: "advisor-call-1",
        toolName: "advisor",
        input: {},
      },
    });

    onStepMessages([{ role: "user", content: "step 2" }]);
    expect(advisorRuntime.takeToolCallSnapshot("advisor-call-1")).toBeUndefined();

    await onChunk({ chunk: { type: "text-delta", delta: "new text" } });
    await onChunk({ chunk: { type: "reasoning-delta", delta: "new reasoning" } });
    await onChunk({
      chunk: {
        type: "tool-call",
        toolCallId: "advisor-call-2",
        toolName: "advisor",
        input: {},
      },
    });

    expect(advisorRuntime.takeToolCallSnapshot("advisor-call-2")).toEqual({
      toolCallId: "advisor-call-2",
      toolName: "advisor",
      input: {},
      stepText: "new text",
      stepReasoning: "new reasoning",
    });
  });

  it("consumes advisor tool-call snapshots on first read", async () => {
    using xumHome = new DisposableTempDir("ai-service-advisor-step-snapshot-consume");
    const projectPath = path.join(xumHome.path, "project");
    await fs.mkdir(projectPath, { recursive: true });

    const workspaceId = "workspace-advisor-step-snapshot-consume";
    const metadata = createLocalWorkspaceMetadata(workspaceId, projectPath);
    const harness = createHarness(xumHome.path, metadata);
    await enableAdvisorForHarness(harness);

    await startAdvisorStream(harness, workspaceId);

    const advisorRuntime = getAdvisorRuntimeFromHarness(harness);
    const { onChunk, onStepMessages } = getAdvisorCallbacksFromHarness(harness);
    onStepMessages([{ role: "user", content: "continue" }]);

    await onChunk({ chunk: { type: "text-delta", delta: "visible text" } });
    await onChunk({
      chunk: {
        type: "tool-call",
        toolCallId: "advisor-call-1",
        toolName: "advisor",
        input: {},
      },
    });

    expect(advisorRuntime.takeToolCallSnapshot("advisor-call-1")).toMatchObject({
      toolCallId: "advisor-call-1",
      stepText: "visible text",
    });
    expect(advisorRuntime.takeToolCallSnapshot("advisor-call-1")).toBeUndefined();
  });

  it("resolves advisor tool metadata pricing without changing the stored model bucket", async () => {
    using xumHome = new DisposableTempDir("ai-service-tool-model-usage");
    const projectPath = path.join(xumHome.path, "project");
    await fs.mkdir(projectPath, { recursive: true });

    const workspaceId = "workspace-tool-model-usage";
    const metadata = createLocalWorkspaceMetadata(workspaceId, projectPath);
    const recordUsage = mock(() => Promise.resolve(undefined));
    const getSessionUsage = mock(() => Promise.resolve(undefined));
    const sessionUsageService = {
      recordUsage,
      getSessionUsage,
    } as unknown as SessionUsageService;
    const harness = createHarness(xumHome.path, metadata, { sessionUsageService });
    const metadataModel = KNOWN_MODELS.SONNET.id;
    new ProvidersConfigStore(harness.config.rootDir).saveProvidersConfig({
      anthropic: {
        models: [{ id: "custom-sonnet", mappedToModel: metadataModel }],
      },
    });

    const result = await harness.service.streamMessage({
      messages: [createMuxMessage("latest-user", "user", "continue")],
      workspaceId,
      modelString: "openai:gpt-5.2",
      thinkingLevel: "off",
    });

    expect(result.success).toBe(true);
    const toolConfig = harness.getToolsForModelSpy.mock.calls[0]?.[1];
    if (!toolConfig || typeof toolConfig !== "object") {
      throw new Error("Expected getToolsForModel to receive a tool configuration object");
    }

    const reportModelUsage = (
      toolConfig as {
        reportModelUsage?: (event: ToolModelUsageEvent) => void;
      }
    ).reportModelUsage;
    expect(typeof reportModelUsage).toBe("function");
    if (!reportModelUsage) {
      throw new Error("Expected reportModelUsage callback on tool configuration");
    }

    const event: ToolModelUsageEvent = {
      source: "tool",
      toolName: "advisor",
      model: "anthropic:custom-sonnet",
      usage: {
        inputTokens: 120,
        cachedInputTokens: 10,
        outputTokens: 45,
        reasoningTokens: 5,
        totalTokens: 165,
      },
      providerMetadata: {
        anthropic: { cacheCreationInputTokens: 6 },
      },
      toolCallId: "call-1",
      timestamp: Date.now(),
    };
    const unresolvedDisplayUsage = createDisplayUsage(
      event.usage,
      event.model,
      event.providerMetadata
    );
    expect(unresolvedDisplayUsage).toBeDefined();
    if (!unresolvedDisplayUsage) {
      throw new Error("Expected unresolved tool usage event to produce display usage");
    }
    expect(unresolvedDisplayUsage.input.cost_usd).toBeUndefined();

    const expectedDisplayUsage = createDisplayUsage(
      event.usage,
      event.model,
      event.providerMetadata,
      metadataModel
    );
    expect(expectedDisplayUsage).toBeDefined();
    if (!expectedDisplayUsage) {
      throw new Error("Expected tool usage event to produce display usage");
    }
    expect(expectedDisplayUsage.model).toBe(event.model);
    expect(expectedDisplayUsage.input.cost_usd).toBeDefined();

    const canonicalModel = normalizeToCanonical(event.model);
    const callSequence: string[] = [];
    let sessionUsageDeltaEvent: unknown;
    harness.service.once("session-usage-delta", (payload) => {
      callSequence.push("emit");
      sessionUsageDeltaEvent = payload;
    });

    recordUsage.mockImplementationOnce(() => {
      callSequence.push("recordUsage");
      return Promise.resolve(undefined);
    });

    reportModelUsage(event);
    await Promise.resolve();
    await Promise.resolve();

    expect(recordUsage).toHaveBeenCalledWith(workspaceId, canonicalModel, expectedDisplayUsage);
    expect(callSequence).toEqual(["recordUsage", "emit"]);
    expect(sessionUsageDeltaEvent).toBeDefined();
    if (typeof sessionUsageDeltaEvent !== "object" || sessionUsageDeltaEvent === null) {
      throw new Error("Expected session-usage-delta event payload");
    }
    const sessionUsageDeltaRecord = sessionUsageDeltaEvent as Record<string, unknown>;
    expect(sessionUsageDeltaRecord.type).toBe("session-usage-delta");
    expect(sessionUsageDeltaRecord.workspaceId).toBe(workspaceId);
    expect(sessionUsageDeltaRecord.sourceWorkspaceId).toBe(workspaceId);
    expect(sessionUsageDeltaRecord.byModelDelta).toEqual({
      [canonicalModel]: expectedDisplayUsage,
    });
    expect(typeof sessionUsageDeltaRecord.timestamp).toBe("number");
  });

  it("keeps pricing identities independent for overlapping Advisor and Intuition creations of the same model", async () => {
    using xumHome = new DisposableTempDir("ai-tool-invocation-pricing");
    const metadata = createLocalWorkspaceMetadata("tool-invocation-pricing", xumHome.path);
    const experimentsService = new ExperimentsService({
      telemetryService: new TelemetryService(xumHome.path),
      xumHome: xumHome.path,
    });
    spyOn(experimentsService, "isExperimentEnabled").mockImplementation(
      (id) => id === EXPERIMENT_IDS.MEMORY_INTUITION
    );
    const harness = createHarness(xumHome.path, metadata, { experimentsService });
    harness.service.turnRequestBuilderBindings.memoryService = new MemoryService(
      harness.config,
      new MemoryMetaService(xumHome.path)
    );
    const model = "xai:grok-4-1-fast";
    new ProvidersConfigStore(harness.config.rootDir).saveProvidersConfig({
      xai: { apiKey: "test-key" },
    });
    await enableAdvisorForHarness(harness, model);
    await harness.config.editConfig((cfg) => ({
      ...cfg,
      agentAiDefaults: {
        ...cfg.agentAiDefaults,
        intuition: { modelString: model, thinkingLevel: "high" },
      },
    }));
    const result = await harness.service.streamMessage({
      messages: [createMuxMessage("user", "user", "hello")],
      workspaceId: metadata.id,
      modelString: "openai:gpt-5.2",
      thinkingLevel: "off",
      experiments: { advisorTool: true, memory: true },
    });
    expect(result.success).toBe(true);
    const tools = harness.getToolsForModelSpy.mock.calls[0]?.[1];
    if (!tools?.advisorRuntime || !tools.intuitionRuntime || !tools.reportModelUsage)
      throw new Error("Expected both tool runtimes");
    const factory = Reflect.get(harness.service, "providerModelFactory") as ProviderModelFactory;
    spyOn(factory, "resolveAndCreateModel").mockImplementation(
      ProviderModelFactory.prototype.resolveAndCreateModel.bind(factory)
    );
    const advisor = await tools.advisorRuntime.createModel(model);
    const intuition = await tools.intuitionRuntime.createModel(model);
    const streamManager = Reflect.get(harness.service, "streamManager") as StreamManager;
    const record = spyOn(streamManager, "recordToolModelUsage");
    for (const [toolName, created] of [
      ["advisor", advisor],
      ["intuition", intuition],
    ] as const) {
      tools.reportModelUsage({
        source: "tool",
        toolName,
        model,
        metadataModel: created.metadataModel,
        usage: { inputTokens: 120, outputTokens: 45, totalTokens: 165 },
        timestamp: 1,
      });
    }
    expect(record.mock.calls.map((call) => call[2].metadataModel)).toEqual([
      model,
      "xai:grok-4-1-fast-reasoning",
    ]);
  });

  it.each(["advisor", "intuition"] as const)(
    "records API-equivalent costs for %s tool usage through Codex OAuth",
    async (toolName) => {
      using xumHome = new DisposableTempDir("ai-service-tool-model-usage-oauth");
      const projectPath = path.join(xumHome.path, "project");
      await fs.mkdir(projectPath, { recursive: true });

      const workspaceId = "workspace-tool-model-usage-oauth";
      const metadata = createLocalWorkspaceMetadata(workspaceId, projectPath);
      const recordUsage = mock(() => Promise.resolve(undefined));
      const getSessionUsage = mock(() => Promise.resolve(undefined));
      const sessionUsageService = {
        recordUsage,
        getSessionUsage,
      } as unknown as SessionUsageService;
      const experimentsService = new ExperimentsService({
        telemetryService: new TelemetryService(xumHome.path),
        xumHome: xumHome.path,
      });
      spyOn(experimentsService, "isExperimentEnabled").mockImplementation(
        (id) => id === EXPERIMENT_IDS.MEMORY_INTUITION
      );
      const harness = createHarness(xumHome.path, metadata, {
        sessionUsageService,
        experimentsService,
      });
      harness.service.turnRequestBuilderBindings.memoryService = new MemoryService(
        harness.config,
        new MemoryMetaService(xumHome.path)
      );

      new ProvidersConfigStore(harness.config.rootDir).saveProvidersConfig({
        openai: {
          codexOauth: {
            type: "oauth",
            access: "test-access-token",
            refresh: "test-refresh-token",
            expires: Date.now() + 60_000,
            accountId: "test-account-id",
          },
        },
      });
      const baseConfig = harness.config.loadConfigOrDefault();
      await harness.config.editConfig(() => ({
        ...baseConfig,
        advisorModelString: KNOWN_MODELS.GPT_53_CODEX.id,
        agentAiDefaults: {
          ...baseConfig.agentAiDefaults,
          exec: {
            ...baseConfig.agentAiDefaults?.exec,
            advisorEnabled: true,
          },
        },
      }));

      const result = await harness.service.streamMessage({
        messages: [createMuxMessage("latest-user", "user", "continue")],
        workspaceId,
        modelString: "openai:gpt-5.2",
        thinkingLevel: "off",
        experiments: { advisorTool: true, memory: true },
      });

      expect(result.success).toBe(true);
      const toolConfig = harness.getToolsForModelSpy.mock.calls[0]?.[1];
      if (!toolConfig || typeof toolConfig !== "object") {
        throw new Error("Expected getToolsForModel to receive a tool configuration object");
      }

      const runtime =
        toolName === "advisor" ? toolConfig.advisorRuntime : toolConfig.intuitionRuntime;
      if (!runtime) throw new Error(`Expected ${toolName} runtime`);
      const factory = Reflect.get(harness.service, "providerModelFactory") as ProviderModelFactory;
      const resolveModel = spyOn(factory, "resolveAndCreateModel").mockImplementation(
        ProviderModelFactory.prototype.resolveAndCreateModel.bind(factory)
      );
      const createModel = spyOn(harness.service, "createModel");
      const created = await runtime.createModel(KNOWN_MODELS.GPT_53_CODEX.id);
      const creationOptions =
        toolName === "advisor"
          ? createModel.mock.calls.at(-1)?.[2]
          : resolveModel.mock.calls.at(-1)?.[3];
      expect(creationOptions).toMatchObject({
        agentInitiated: true,
        workspaceId,
      });
      // Cost estimates must remain available after an authentication change.
      new ProvidersConfigStore(harness.config.rootDir).saveProvidersConfig({
        openai: { apiKey: "new-direct-key" },
      });

      const reportModelUsage = (
        toolConfig as {
          reportModelUsage?: (event: ToolModelUsageEvent) => void;
        }
      ).reportModelUsage;
      if (!reportModelUsage) {
        throw new Error("Expected reportModelUsage callback on tool configuration");
      }

      const event: ToolModelUsageEvent = {
        source: "tool",
        toolName,
        model: KNOWN_MODELS.GPT_53_CODEX.id,
        metadataModel: created.metadataModel,
        usage: {
          inputTokens: 120,
          outputTokens: 45,
          totalTokens: 165,
        },
        providerMetadata: {
          openai: { reasoningTokens: 5 },
        },
        timestamp: Date.now(),
      };
      const expectedDisplayUsage = createDisplayUsage(
        event.usage,
        event.model,
        event.providerMetadata
      );
      expect(expectedDisplayUsage).toBeDefined();
      if (!expectedDisplayUsage) {
        throw new Error("Expected tool usage event to produce display usage");
      }
      expect(expectedDisplayUsage.costsIncluded).toBeUndefined();
      expect(expectedDisplayUsage.input.cost_usd).toBeGreaterThan(0);
      expect(expectedDisplayUsage.output.cost_usd).toBeGreaterThan(0);
      expect(expectedDisplayUsage.reasoning.cost_usd).toBeGreaterThan(0);

      reportModelUsage(event);
      await Promise.resolve();
      await Promise.resolve();

      expect(recordUsage).toHaveBeenCalledWith(
        workspaceId,
        normalizeToCanonical(event.model),
        expectedDisplayUsage
      );
    }
  );

  it("logs and swallows tool model usage persistence failures", async () => {
    using xumHome = new DisposableTempDir("ai-service-tool-model-usage-failure");
    const projectPath = path.join(xumHome.path, "project");
    await fs.mkdir(projectPath, { recursive: true });

    const workspaceId = "workspace-tool-model-usage-failure";
    const metadata = createLocalWorkspaceMetadata(workspaceId, projectPath);
    const recordUsageError = new Error("write failed");
    const recordUsage = mock(() => Promise.reject(recordUsageError));
    const getSessionUsage = mock(() => Promise.resolve(undefined));
    const sessionUsageService = {
      recordUsage,
      getSessionUsage,
    } as unknown as SessionUsageService;
    const warnSpy = spyOn(log, "warn").mockImplementation(() => undefined);
    const harness = createHarness(xumHome.path, metadata, { sessionUsageService });

    const result = await harness.service.streamMessage({
      messages: [createMuxMessage("latest-user", "user", "continue")],
      workspaceId,
      modelString: "openai:gpt-5.2",
      thinkingLevel: "off",
    });

    expect(result.success).toBe(true);
    const toolConfig = harness.getToolsForModelSpy.mock.calls[0]?.[1];
    if (!toolConfig || typeof toolConfig !== "object") {
      throw new Error("Expected getToolsForModel to receive a tool configuration object");
    }

    const reportModelUsage = (
      toolConfig as {
        reportModelUsage?: (event: ToolModelUsageEvent) => void;
      }
    ).reportModelUsage;
    if (!reportModelUsage) {
      throw new Error("Expected reportModelUsage callback on tool configuration");
    }

    const event: ToolModelUsageEvent = {
      source: "tool",
      toolName: "advisor",
      model: "anthropic:claude-sonnet-4-20250514",
      usage: {
        inputTokens: 50,
        outputTokens: 20,
        totalTokens: 70,
      },
      providerMetadata: {
        anthropic: { cacheCreationInputTokens: 2 },
      },
      toolCallId: "call-2",
      timestamp: Date.now(),
    };

    reportModelUsage(event);
    await Promise.resolve();
    await Promise.resolve();

    expect(warnSpy).toHaveBeenCalledWith(
      "Failed to record tool model usage",
      expect.objectContaining({
        error: recordUsageError,
        workspaceId,
        toolName: "advisor",
        model: event.model,
      })
    );
  });
});

describe("AIService.streamMessage multi-project trust gating", () => {
  interface TrustGatingHarness {
    service: AIService;
    config: Config;
    getToolsForModelSpy: ReturnType<typeof spyOn<typeof toolsModule, "getToolsForModel">>;
  }

  function createTrustMetadata(
    workspaceId: string,
    projectPaths: string[],
    runtimeConfig: WorkspaceMetadata["runtimeConfig"] = { type: "local" }
  ): WorkspaceMetadata {
    const [primaryProjectPath, secondaryProjectPath] = projectPaths;
    if (!primaryProjectPath) {
      throw new Error("Expected at least one project path");
    }

    return {
      id: workspaceId,
      name: "workspace-trust-gating",
      projectName: "project-a",
      projectPath: primaryProjectPath,
      projects: secondaryProjectPath
        ? [
            { projectPath: primaryProjectPath, projectName: "project-a" },
            { projectPath: secondaryProjectPath, projectName: "project-b" },
          ]
        : undefined,
      runtimeConfig,
    };
  }

  function createHarness(
    xumHomePath: string,
    metadata: WorkspaceMetadata,
    multiProjectExperimentEnabled = true,
    workspacePathOverride?: string
  ): TrustGatingHarness {
    const experimentsService = new ExperimentsService({
      telemetryService: new TelemetryService(xumHomePath),
      xumHome: xumHomePath,
    });
    spyOn(experimentsService, "isExperimentEnabled").mockImplementation((experimentId) =>
      experimentId === EXPERIMENT_IDS.MULTI_PROJECT_WORKSPACES
        ? multiProjectExperimentEnabled
        : false
    );
    const { config, historyService, initStateManager, service } = createBasicAIService(
      xumHomePath,
      {
        experimentsService,
      }
    );
    const getToolsForModelSpy = stubCommonStreamMessageDependencies({
      service,
      config,
      historyService,
      initStateManager,
      metadata,
      workspacePathOverride,
      historySequence: 11,
    });
    return { service, config, getToolsForModelSpy };
  }

  async function streamOnce(harness: TrustGatingHarness, workspaceId: string): Promise<void> {
    const result = await harness.service.streamMessage({
      messages: [createMuxMessage("user-message", "user", "hello")],
      workspaceId,
      modelString: "openai:gpt-5.2",
      thinkingLevel: "off",
    });

    expect(result.success).toBe(true);
  }

  function trustedFromFirstGetToolsCall(
    getToolsForModelSpy: TrustGatingHarness["getToolsForModelSpy"]
  ): boolean | undefined {
    const toolConfig = getToolsForModelSpy.mock.calls[0]?.[1];
    if (!toolConfig || typeof toolConfig !== "object") {
      throw new Error("Expected getToolsForModel to receive a tool configuration object");
    }

    return (toolConfig as { trusted?: boolean }).trusted;
  }

  afterEach(() => {
    mock.restore();
  });

  it("marks multi-project tool execution untrusted when any secondary project is untrusted", async () => {
    using xumHome = new DisposableTempDir("ai-service-multi-project-trust-gating");
    const projectAPath = path.join(xumHome.path, "project-a");
    const projectBPath = path.join(xumHome.path, "project-b");
    await fs.mkdir(projectAPath, { recursive: true });
    await fs.mkdir(projectBPath, { recursive: true });

    const workspaceId = "workspace-multi-project-trust";
    const metadata = createTrustMetadata(workspaceId, [projectAPath, projectBPath]);
    const harness = createHarness(xumHome.path, metadata);

    await harness.config.editConfig((cfg) => {
      cfg.projects.set(projectAPath, { workspaces: [], trusted: true });
      cfg.projects.set(projectBPath, { workspaces: [], trusted: false });
      return cfg;
    });

    await streamOnce(harness, workspaceId);

    expect(harness.getToolsForModelSpy).toHaveBeenCalledTimes(1);
    expect(trustedFromFirstGetToolsCall(harness.getToolsForModelSpy)).toBe(false);
  });

  it("uses the persisted workspace root as cwd for multi-project ssh startup", async () => {
    using xumHome = new DisposableTempDir("ai-service-multi-project-persisted-cwd");
    const projectAPath = path.join(xumHome.path, "project-a");
    const projectBPath = path.join(xumHome.path, "project-b");
    await fs.mkdir(projectAPath, { recursive: true });
    await fs.mkdir(projectBPath, { recursive: true });

    const workspaceId = "workspace-multi-project-persisted-cwd";
    const persistedWorkspacePath = path.join(xumHome.path, "persisted-legacy-workspace-root");
    const metadata = createTrustMetadata(workspaceId, [projectAPath, projectBPath], {
      type: "ssh",
      host: "example.com",
      srcBaseDir: "/remote/src",
    });
    const harness = createHarness(xumHome.path, metadata, true, persistedWorkspacePath);
    const createRuntimeSpy = spyOn(runtimeFactory, "createRuntime").mockImplementation(
      (_runtimeConfig, options) => new LocalRuntime(options?.projectPath ?? projectAPath)
    );

    try {
      await harness.config.editConfig((cfg) => {
        cfg.projects.set(projectAPath, { workspaces: [], trusted: true });
        cfg.projects.set(projectBPath, { workspaces: [], trusted: true });
        return cfg;
      });

      await streamOnce(harness, workspaceId);

      const toolConfig = harness.getToolsForModelSpy.mock.calls[0]?.[1] as
        | { cwd?: unknown }
        | undefined;
      expect(toolConfig?.cwd).toBe(persistedWorkspacePath);
    } finally {
      createRuntimeSpy.mockRestore();
    }
  });
  it("fails closed before tool setup when the multi-project experiment is disabled", async () => {
    using xumHome = new DisposableTempDir("ai-service-multi-project-experiment-disabled");
    const projectAPath = path.join(xumHome.path, "project-a");
    const projectBPath = path.join(xumHome.path, "project-b");
    await fs.mkdir(projectAPath, { recursive: true });
    await fs.mkdir(projectBPath, { recursive: true });

    const workspaceId = "workspace-multi-project-disabled";
    const metadata = createTrustMetadata(workspaceId, [projectAPath, projectBPath]);
    const harness = createHarness(xumHome.path, metadata, false);

    const result = await harness.service.streamMessage({
      messages: [createMuxMessage("user-message", "user", "hello")],
      workspaceId,
      modelString: "openai:gpt-5.2",
      thinkingLevel: "off",
    });

    expect(result).toEqual({
      success: false,
      error: {
        type: "unknown",
        raw: `Workspace ${workspaceId} reached multi-project AI runtime execution while ${EXPERIMENT_IDS.MULTI_PROJECT_WORKSPACES} is disabled`,
      },
    });
    expect(harness.getToolsForModelSpy).not.toHaveBeenCalled();
  });
});

describe("AIService.streamMessage turn envelope", () => {
  interface TurnEnvelopeHarness {
    service: AIService;
    config: Config;
    providersConfigStore: ProvidersConfigStore;
    startStreamCalls: TurnExecutionOptions[];
  }

  function createHarness(
    xumHomePath: string,
    metadata: WorkspaceMetadata,
    options?: { allTools?: Record<string, Tool> }
  ): TurnEnvelopeHarness {
    const { config, historyService, initStateManager, providersConfigStore, service } =
      createBasicAIService(xumHomePath);
    const startStreamCalls: TurnExecutionOptions[] = [];
    stubCommonStreamMessageDependencies({
      service,
      config,
      historyService,
      initStateManager,
      metadata,
      startStreamCalls,
      allTools: options?.allTools,
    });
    return { service, config, providersConfigStore, startStreamCalls };
  }

  async function streamTurn(harness: TurnEnvelopeHarness, workspaceId: string): Promise<void> {
    const result = await harness.service.streamMessage({
      messages: [createMuxMessage("user-message", "user", "hello")],
      workspaceId,
      modelString: "openai:gpt-5.2",
      thinkingLevel: "off",
    });
    expect(result.success).toBe(true);
  }

  afterEach(() => {
    mock.restore();
  });

  it("appends one turn-envelope row per assistant turn with a deduped prompt blob", async () => {
    using xumHome = new DisposableTempDir("ai-service-turn-envelope");
    const projectPath = path.join(xumHome.path, "project");
    await fs.mkdir(projectPath, { recursive: true });

    const workspaceId = "workspace-turn-envelope";
    const metadata = createLocalWorkspaceMetadata(workspaceId, projectPath);
    // Keys deliberately out of order: the manifest must sort by name.
    const allTools: Record<string, Tool> = {
      zebra_tool: tool({
        description: "z",
        inputSchema: jsonSchema({ type: "object", properties: { a: {} } }),
      }),
      alpha_tool: tool({
        description: "a",
        inputSchema: jsonSchema({ type: "object", properties: { b: {} } }),
      }),
    };
    const harness = createHarness(xumHome.path, metadata, { allTools });

    // Two turns (e.g. a retry/continuation) must each emit their own row.
    await streamTurn(harness, workspaceId);
    await streamTurn(harness, workspaceId);
    expect(harness.startStreamCalls).toHaveLength(2);

    const journal = new DurableEventJournal(path.join(harness.config.sessionsDir, workspaceId));
    const events = await journal.read();
    expect(events).toHaveLength(2);
    expect(new Set(events.map((event) => event.id)).size).toBe(2);
    for (const event of events) {
      expect(event.kind).toBe("turn-envelope");
      if (event.kind !== "turn-envelope") continue;
      expect(event.workspaceId).toBe(workspaceId);
      expect(event.data.modelString).toBe("openai:gpt-5.2");
      expect(event.data.toolsetManifest.map((entry) => entry.name)).toEqual([
        "alpha_tool",
        "zebra_tool",
      ]);
      // Identical requests fingerprint identically; the prompt text itself
      // round-trips through the content-addressed blob store.
      expect(event.data.systemPromptHash).toBe(
        events[0].kind === "turn-envelope" ? events[0].data.systemPromptHash : ""
      );
      expect(await journal.blobs.getText(event.data.systemPromptHash)).toBe("test-system-message");
    }
  });

  it("never fails the turn when the session dir is unwritable", async () => {
    using xumHome = new DisposableTempDir("ai-service-turn-envelope-unwritable");
    const projectPath = path.join(xumHome.path, "project");
    await fs.mkdir(projectPath, { recursive: true });

    const workspaceId = "workspace-turn-envelope-unwritable";
    const metadata = createLocalWorkspaceMetadata(workspaceId, projectPath);
    const harness = createHarness(xumHome.path, metadata);

    // A regular file where the session dir should be makes every journal write
    // fail (ENOTDIR); the turn must still stream.
    const sessionDir = path.join(harness.config.sessionsDir, workspaceId);
    await fs.mkdir(path.dirname(sessionDir), { recursive: true });
    await fs.writeFile(sessionDir, "not a directory", "utf-8");

    await streamTurn(harness, workspaceId);
    expect(harness.startStreamCalls).toHaveLength(1);
  });
});

describe("normalizeAnthropicBaseURL", () => {
  it("appends /v1 to URLs without it", () => {
    expect(normalizeAnthropicBaseURL("https://api.anthropic.com")).toBe(
      "https://api.anthropic.com/v1"
    );
    expect(normalizeAnthropicBaseURL("https://custom-proxy.com")).toBe(
      "https://custom-proxy.com/v1"
    );
  });

  it("preserves URLs already ending with /v1", () => {
    expect(normalizeAnthropicBaseURL("https://api.anthropic.com/v1")).toBe(
      "https://api.anthropic.com/v1"
    );
    expect(normalizeAnthropicBaseURL("https://custom-proxy.com/v1")).toBe(
      "https://custom-proxy.com/v1"
    );
  });

  it("removes trailing slashes before appending /v1", () => {
    expect(normalizeAnthropicBaseURL("https://api.anthropic.com/")).toBe(
      "https://api.anthropic.com/v1"
    );
    expect(normalizeAnthropicBaseURL("https://api.anthropic.com///")).toBe(
      "https://api.anthropic.com/v1"
    );
  });

  it("removes trailing slash after /v1", () => {
    expect(normalizeAnthropicBaseURL("https://api.anthropic.com/v1/")).toBe(
      "https://api.anthropic.com/v1"
    );
  });

  it("appends /v1 to the path, not the query or fragment", () => {
    expect(normalizeAnthropicBaseURL("https://proxy.example/anthropic?token=x")).toBe(
      "https://proxy.example/anthropic/v1?token=x"
    );
  });

  it("handles URLs with ports", () => {
    expect(normalizeAnthropicBaseURL("http://localhost:8080")).toBe("http://localhost:8080/v1");
    expect(normalizeAnthropicBaseURL("http://localhost:8080/v1")).toBe("http://localhost:8080/v1");
  });

  it("handles URLs with paths that include v1 in the middle", () => {
    // This should still append /v1 because the path doesn't END with /v1
    expect(normalizeAnthropicBaseURL("https://proxy.com/api/v1-beta")).toBe(
      "https://proxy.com/api/v1-beta/v1"
    );
  });
});

describe("buildAppAttributionHeaders", () => {
  it("adds both headers when no headers exist", () => {
    expect(buildAppAttributionHeaders(undefined)).toEqual({
      "HTTP-Referer": XUM_APP_ATTRIBUTION_URL,
      "X-Title": XUM_APP_ATTRIBUTION_TITLE,
    });
  });

  it("adds only the missing header when one is present", () => {
    const existing = { "HTTP-Referer": "https://example.com" };
    const result = buildAppAttributionHeaders(existing);
    expect(result).toEqual({
      "HTTP-Referer": "https://example.com",
      "X-Title": XUM_APP_ATTRIBUTION_TITLE,
    });
  });

  it("does not overwrite existing values (case-insensitive)", () => {
    const existing = { "http-referer": "https://example.com", "X-TITLE": "My App" };
    const result = buildAppAttributionHeaders(existing);
    expect(result).toEqual(existing);
  });

  it("preserves unrelated headers", () => {
    const existing = { "x-custom": "value" };
    const result = buildAppAttributionHeaders(existing);
    expect(result).toEqual({
      "x-custom": "value",
      "HTTP-Referer": XUM_APP_ATTRIBUTION_URL,
      "X-Title": XUM_APP_ATTRIBUTION_TITLE,
    });
  });

  it("does not mutate the input object", () => {
    const existing = { "x-custom": "value" };
    const existingSnapshot = { ...existing };

    buildAppAttributionHeaders(existing);

    expect(existing).toEqual(existingSnapshot);
  });
});

describe("discoverAvailableSubagentsForToolContext", () => {
  it("includes derived agents that inherit subagent.runnable from base", async () => {
    using project = new DisposableTempDir("available-subagents");
    using xumHome = new DisposableTempDir("available-subagents-home");

    const agentsRoot = path.join(project.path, ".mux", "agents");
    await fs.mkdir(agentsRoot, { recursive: true });

    // Derived agent: base exec but no explicit subagent.runnable.
    await fs.writeFile(
      path.join(agentsRoot, "custom.md"),
      `---\nname: Custom Exec Derivative\nbase: exec\n---\nBody\n`,
      "utf-8"
    );

    const runtime = new LocalRuntime(project.path);
    const cfg = new Config(xumHome.path).loadConfigOrDefault();

    const availableSubagents = await discoverAvailableSubagentsForToolContext({
      runtime,
      workspacePath: project.path,
      cfg,
      roots: {
        projectRoots: [agentsRoot],
        globalRoot: path.join(project.path, "empty-global-agents"),
      },
    });

    const custom = availableSubagents.find((agent) => agent.id === "custom");
    expect(custom).toBeDefined();
    expect(custom?.subagentRunnable).toBe(true);

    // Ensure the task tool description includes the derived agent in the runnable sub-agent list.
    const taskTool = createTaskTool({
      ...createTestToolConfig(project.path, { workspaceId: "test-workspace" }),
      availableSubagents,
    });

    const description = (taskTool as unknown as { description?: unknown }).description;
    expect(typeof description).toBe("string");
    if (typeof description === "string") {
      expect(description).toContain("Available sub-agents");
      expect(description).toContain("- custom");
    }
  });

  it("filters the desktop agent when capability is unavailable", async () => {
    using project = new DisposableTempDir("available-subagents-desktop");
    using xumHome = new DisposableTempDir("available-subagents-desktop-home");

    const agentsRoot = path.join(project.path, ".mux", "agents");
    await fs.mkdir(agentsRoot, { recursive: true });
    await fs.writeFile(
      path.join(agentsRoot, "plain.md"),
      `---\nname: Plain Agent\nbase: exec\n---\nBody\n`,
      "utf-8"
    );

    const runtime = new LocalRuntime(project.path);
    const cfg = new Config(xumHome.path).loadConfigOrDefault();
    const loadDesktopCapability = mock(() =>
      Promise.resolve({
        available: false as const,
        reason: "unsupported_runtime" as const,
      })
    );

    const availableSubagents = await discoverAvailableSubagentsForToolContext({
      runtime,
      workspacePath: project.path,
      cfg,
      roots: {
        projectRoots: [agentsRoot],
        globalRoot: path.join(project.path, "empty-global-agents"),
      },
      loadDesktopCapability,
    });

    // The built-in `desktop` agent should be filtered out when capability is unavailable.
    expect(availableSubagents.find((agent) => agent.id === "desktop")).toBeUndefined();
    expect(availableSubagents.find((agent) => agent.id === "plain")?.subagentRunnable).toBe(true);
  });

  it("keeps the desktop agent when capability is available", async () => {
    using project = new DisposableTempDir("available-subagents-desktop-enabled");
    using xumHome = new DisposableTempDir("available-subagents-desktop-enabled-home");

    const runtime = new LocalRuntime(project.path);
    const cfg = new Config(xumHome.path).loadConfigOrDefault();
    const loadDesktopCapability = mock(() =>
      Promise.resolve({
        available: true as const,
        width: 1440,
        height: 900,
        sessionId: "desktop:test-workspace",
      })
    );

    const availableSubagents = await discoverAvailableSubagentsForToolContext({
      runtime,
      workspacePath: project.path,
      cfg,
      roots: {
        projectRoots: [path.join(project.path, "empty-project-agents")],
        globalRoot: path.join(project.path, "empty-global-agents"),
      },
      loadDesktopCapability,
    });

    expect(availableSubagents.find((agent) => agent.id === "desktop")?.subagentRunnable).toBe(true);
  });

  it("keeps a project-scope `desktop.md` override even when capability is unavailable", async () => {
    using project = new DisposableTempDir("available-subagents-desktop-override");
    using xumHome = new DisposableTempDir("available-subagents-desktop-override-home");

    const agentsRoot = path.join(project.path, ".mux", "agents");
    await fs.mkdir(agentsRoot, { recursive: true });
    // A user-defined `desktop` agent that does not need real desktop capability.
    // The built-in same-name agent should be shadowed by this project-scope override;
    // the runtime gate must not hide the override just because it shares the `desktop` id.
    await fs.writeFile(
      path.join(agentsRoot, "desktop.md"),
      `---\nname: Custom Desktop\nbase: exec\nsubagent:\n  runnable: true\n---\nBody\n`,
      "utf-8"
    );

    const runtime = new LocalRuntime(project.path);
    const cfg = new Config(xumHome.path).loadConfigOrDefault();
    const loadDesktopCapability = mock(() =>
      Promise.resolve({
        available: false as const,
        reason: "unsupported_runtime" as const,
      })
    );

    const availableSubagents = await discoverAvailableSubagentsForToolContext({
      runtime,
      workspacePath: project.path,
      cfg,
      roots: {
        projectRoots: [agentsRoot],
        globalRoot: path.join(project.path, "empty-global-agents"),
      },
      loadDesktopCapability,
    });

    const desktop = availableSubagents.find((agent) => agent.id === "desktop");
    expect(desktop).toBeDefined();
    expect(desktop?.scope).toBe("project");
    expect(desktop?.subagentRunnable).toBe(true);
  });
});

import * as fs from "fs";
import * as os from "os";
import * as path from "path";
import { afterEach, beforeEach, describe, expect, it, spyOn } from "bun:test";
import type { Context } from "effect";
import { createConfigStores, type ConfigStores } from "@/node/config";
import { createRuntime } from "@/node/runtime/runtimeFactory";
import * as agentPluginsMcpConfig from "@/node/services/agentPlugins/mcpConfig";
import type { CoreServices } from "@/node/services/coreServices";
import { AppFiberScopeTag } from "@/node/services/di/appFiberScope";
import {
  closeScopeBounded,
  disposeAppRuntime,
  makeAppRuntime,
} from "@/node/services/di/appRuntime";
import { EffectRunnerTag } from "@/node/services/di/effectRunner";
import { CoreLive, CoreOptionsTag } from "@/node/services/di/layers/core";
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
  TerminalAttentionStoreTag,
  TurnRequestBuilderBindingsTag,
  Workspace,
  WorkspaceGoal,
  WorkspaceMcpOverrides,
  WorkspaceTurnManagerTag,
  type CoreRootTags,
  type CoreTags,
} from "@/node/services/di/tags";
import type { TurnRequestBuilderBindings } from "@/node/services/turnRequestBuilder";
import { createCoreServices, type CoreServicesRoot } from "./coreServicesRoot";

/**
 * Independent field → tag listing (the production mapping lives in
 * di/layers/core.ts); `Record<keyof CoreServices, …>` keeps it exhaustive.
 */
const CORE_FIELD_TAGS: Record<keyof CoreServices, Context.Key<CoreTags, unknown>> = {
  historyService: History,
  initStateManager: InitStateManagerTag,
  providerService: Provider,
  backgroundProcessManager: BackgroundProcessManagerTag,
  sessionUsageService: SessionUsage,
  workspaceGoalService: WorkspaceGoal,
  idleDispatcher: IdleDispatcherTag,
  aiService: AI,
  streamManager: StreamManagerTag,
  mcpConfigService: MCPConfig,
  mcpServerManager: MCPServerManagerTag,
  extensionMetadata: ExtensionMetadata,
  workspaceService: Workspace,
  taskService: Task,
  workspaceTurnManager: WorkspaceTurnManagerTag,
  memoryService: Memory,
  memoryMetaService: MemoryMeta,
  memoryConsolidationService: MemoryConsolidation,
  turnRequestBuilderBindings: TurnRequestBuilderBindingsTag,
};

describe("createCoreServices", () => {
  let tempDir: string;
  let stores: ConfigStores;
  let root: CoreServicesRoot | undefined;

  beforeEach(() => {
    tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "mux-core-root-test-"));
    stores = createConfigStores(tempDir);
  });

  afterEach(async () => {
    if (root) {
      // The CLI cleanup order: supervised scope first, runtime last.
      await closeScopeBounded(root.appFiberScope);
      await disposeAppRuntime(root.runtime.managed);
      root = undefined;
    }
    fs.rmSync(tempDir, { recursive: true, force: true });
  });

  it("serves every CoreServices field through its tag (one instance each)", () => {
    root = createCoreServices({
      ...stores,
      extensionMetadataPath: path.join(tempDir, "extensionMetadata.json"),
    });

    for (const [field, tag] of Object.entries(CORE_FIELD_TAGS) as Array<
      [keyof CoreServices, Context.Key<CoreRootTags, unknown>]
    >) {
      expect(root.runtime.get(tag)).toBe(root[field]);
    }
    expect(root.appFiberScope).toBe(root.runtime.get(AppFiberScopeTag));
    expect(root.appFiberScope.state._tag).not.toBe("Closed");
    expect(root.runtime.get(EffectRunnerTag)).toBeDefined();
  });

  it("uses the caller's stores and carries the remaining options under CoreOptionsTag", () => {
    const extensionMetadataPath = path.join(tempDir, "extensionMetadata.json");
    root = createCoreServices({ ...stores, extensionMetadataPath, mcpConfig: stores.config });

    expect(root.runtime.get(ConfigTag)).toBe(stores.config);
    expect(root.runtime.get(SessionLocatorTag)).toBe(stores.sessionLocator);
    expect(root.runtime.get(ProvidersConfigStoreTag)).toBe(stores.providersConfigStore);
    expect(root.runtime.get(SecretsStoreTag)).toBe(stores.secretsStore);
    expect(root.runtime.get(FileLeaseManagerTag)).toBe(stores.fileLeaseManager);
    // Options minus stores, exactly as passed (no cross-cutting services in a CLI root).
    expect(root.runtime.get(CoreOptionsTag)).toEqual({
      extensionMetadataPath,
      mcpConfig: stores.config,
    });
  });

  it("defaults omitted stores to the config root, like the graph body did", () => {
    root = createCoreServices({
      config: stores.config,
      extensionMetadataPath: path.join(tempDir, "extensionMetadata.json"),
    });

    expect(root.runtime.get(ConfigTag)).toBe(stores.config);
    expect(root.runtime.get(SessionLocatorTag).rootDir).toBe(stores.config.rootDir);
    expect(root.runtime.get(ProvidersConfigStoreTag).rootDir).toBe(stores.config.rootDir);
    expect(root.runtime.get(SecretsStoreTag).rootDir).toBe(stores.config.rootDir);
    expect(root.runtime.get(FileLeaseManagerTag).rootDir).toBe(stores.config.rootDir);
    expect(root.runtime.get(SessionLocatorTag)).not.toBe(stores.sessionLocator);
  });

  it("releases the runtime through the CLI cleanup steps, idempotently", async () => {
    root = createCoreServices({
      ...stores,
      extensionMetadataPath: path.join(tempDir, "extensionMetadata.json"),
    });
    const { appFiberScope, runtime } = root;

    await closeScopeBounded(appFiberScope);
    expect(appFiberScope.state._tag).toBe("Closed");
    // Dependencies are still alive between the two steps (the explicit CLI
    // disposers run here).
    expect(runtime.managed.cachedContext).toBeDefined();

    await disposeAppRuntime(runtime.managed);
    expect(runtime.managed.cachedContext).toBeUndefined();
    // The afterEach pair then exercises the idempotent second close/dispose.
  });

  it("the CLI cleanup list's appFiberScope.close aborts and awaits an in-flight stream", async () => {
    // `xum run`/`xum workflow` mirror ServiceContainer.dispose(): the
    // appFiberScope.close step runs before session.dispose. With the stream
    // engine as the scope's occupant, that step must abort a live stream as
    // "system", commit its partial into chat.jsonl and remove partial.json.
    root = createCoreServices({
      ...stores,
      extensionMetadataPath: path.join(tempDir, "extensionMetadata.json"),
    });
    const workspaceId = "cli-cleanup-in-flight-stream-workspace";
    const messageId = "cli-cleanup-in-flight-stream-message";
    const abortReasons: string[] = [];
    Reflect.set(root.streamManager, "tokenTracker", {
      setModel: () => Promise.resolve(undefined),
      countTokens: () => Promise.resolve(0),
    });
    Reflect.set(
      root.streamManager,
      "createStreamResult",
      (_request: unknown, abortController: AbortController) => ({
        fullStream: (async function* () {
          yield { type: "text-delta", text: "cli stream text" };
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
    Reflect.set(root.streamManager, "createTempDirForStream", () =>
      Promise.resolve(path.join(tempDir, "stream-tempdir"))
    );
    Reflect.set(root.streamManager, "cleanupStreamTempDir", () => undefined);
    root.aiService.on("stream-abort", (event: { abortReason?: string }) => {
      abortReasons.push(event.abortReason ?? "");
    });
    const appendResult = await root.historyService.appendToHistory(workspaceId, {
      id: messageId,
      role: "assistant",
      metadata: { historySequence: 1, partial: true },
      parts: [],
    });
    expect(appendResult.success).toBe(true);
    const started = await root.streamManager.startStream({
      workspaceId,
      messageId,
      model: {
        specificationVersion: "v3",
        provider: "test",
        modelId: "cli-cleanup-model",
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
    expect(started.success).toBe(true);
    if (!started.success) throw new Error("expected the stream to start");
    const deadline = Date.now() + 5_000;
    while ((await root.historyService.readPartial(workspaceId)) === null) {
      if (Date.now() > deadline) throw new Error("partial never written");
      await new Promise((resolve) => setTimeout(resolve, 5));
    }

    await closeScopeBounded(root.appFiberScope);

    expect(abortReasons).toEqual(["system"]);
    expect(await started.data.completion).toMatchObject({
      status: "aborted",
      abortReason: "system",
    });
    expect(root.streamManager.isStreaming(workspaceId)).toBe(false);
    expect(await root.historyService.readPartial(workspaceId)).toBeNull();
    const history = await root.historyService.getHistoryFromLatestBoundary(workspaceId);
    expect(history.success).toBe(true);
    if (!history.success) throw new Error(history.error);
    const committed = history.data.find((message) => message.id === messageId);
    expect(
      committed?.parts.some((part) => part.type === "text" && part.text === "cli stream text")
    ).toBe(true);
    // Dependencies are still alive for the remaining CLI cleanup steps.
    expect(root.runtime.managed.cachedContext).toBeDefined();
  });

  it("surfaces a throwing layer body as a synchronous throw", () => {
    // A throw deep inside a nested stage (MCPConfigLive, S4) must propagate
    // through the staged composition as the same synchronous throw a service
    // constructor produces, so the CLI roots' existing startup error paths
    // apply unchanged.
    const providerSpy = spyOn(
      agentPluginsMcpConfig,
      "createAgentPluginsMcpProvider"
    ).mockImplementation(() => {
      throw new Error("core boom");
    });
    try {
      expect(() =>
        createCoreServices({
          ...stores,
          extensionMetadataPath: path.join(tempDir, "extensionMetadata.json"),
        })
      ).toThrow("core boom");
    } finally {
      providerSpy.mockRestore();
    }
  });

  it("provides the CLI defaults for the desktop-built inputs and the graph-internal store", () => {
    root = createCoreServices({
      ...stores,
      extensionMetadataPath: path.join(tempDir, "extensionMetadata.json"),
    });

    expect(root.runtime.get(WorkspaceMcpOverrides)).toBeDefined();
    expect(root.runtime.get(TerminalAttentionStoreTag)).toBeDefined();
    expect(root.memoryMetaService).toBe(root.runtime.get(MemoryMeta));
  });

  it("wires the graph like the construction body did (each line has an observable effect)", async () => {
    root = createCoreServices({
      ...stores,
      extensionMetadataPath: path.join(tempDir, "extensionMetadata.json"),
    });

    // turnRequestBuilderBindings: every collaborator the core wiring binds
    // (the desktop container adds analyticsService and the OAuth services).
    const expectedBindings: Pick<
      Required<TurnRequestBuilderBindings>,
      | "memoryService"
      | "mcpServerManager"
      | "workspaceHeartbeatService"
      | "workflowResultContinuationSender"
      | "taskService"
      | "workspaceTurnManager"
    > = {
      memoryService: root.memoryService,
      mcpServerManager: root.mcpServerManager,
      workspaceHeartbeatService: root.workspaceService,
      workflowResultContinuationSender: root.workspaceService,
      taskService: root.taskService,
      workspaceTurnManager: root.workspaceTurnManager,
    };
    for (const [key, expected] of Object.entries(expectedBindings)) {
      expect(root.turnRequestBuilderBindings[key as keyof typeof expectedBindings]).toBe(expected);
    }
    const emitSpy = spyOn(root.workspaceService, "emitWorkflowRunActivity").mockResolvedValue(
      undefined
    );
    const event = { workspaceId: "ws-1", runId: "run-1", status: "completed" as const };
    await root.turnRequestBuilderBindings.onWorkflowRunStatusChanged?.(event);
    expect(emitSpy).toHaveBeenCalledWith(event);

    // Goal continuation consumer registered on the shared idle dispatcher: the
    // goal service refuses a second registration.
    const { workspaceGoalService, idleDispatcher } = root;
    expect(() =>
      workspaceGoalService.registerGoalContinuationConsumer(idleDispatcher, {
        hasActiveDescendantTasks: () => false,
        getRuntimeState: () => {
          throw new Error("unused");
        },
        executeGoalContinuation: () => Promise.resolve(false),
        getKickoffSendOptions: () => {
          throw new Error("unused");
        },
      })
    ).toThrow("already registered");

    // Setter-provided collaborators (the former body's `set*` lines).
    const workspaceInternals = root.workspaceService as unknown as {
      mcpServerManager?: unknown;
      workspaceGoalService?: unknown;
      agentTaskIntegration?: unknown;
      memoryConsolidationService?: unknown;
      workspaceMcpOverridesService?: unknown;
    };
    expect(workspaceInternals.mcpServerManager).toBe(root.mcpServerManager);
    expect(workspaceInternals.workspaceGoalService).toBe(root.workspaceGoalService);
    expect(workspaceInternals.agentTaskIntegration).toBe(root.taskService);
    expect(workspaceInternals.memoryConsolidationService).toBe(root.memoryConsolidationService);
    expect(workspaceInternals.workspaceMcpOverridesService).toBe(
      root.runtime.get(WorkspaceMcpOverrides)
    );
    const taskInternals = root.taskService as unknown as { workspaceTurnManager?: unknown };
    expect(taskInternals.workspaceTurnManager).toBe(root.workspaceTurnManager);

    // Goal service hooks: activity changes fan out to the workspace service and
    // a promote interrupts the workspace's stream.
    const goalInternals = root.workspaceGoalService as unknown as {
      onActivityChange?: (workspaceId: string, snapshot: unknown) => void;
      streamInterrupter?: (workspaceId: string) => Promise<void>;
    };
    const activitySpy = spyOn(root.workspaceService, "emitWorkspaceActivity").mockImplementation(
      () => undefined
    );
    goalInternals.onActivityChange?.("ws-1", null);
    expect(activitySpy).toHaveBeenCalledWith("ws-1", null);
    const interruptSpy = spyOn(root.workspaceService, "interruptStream").mockResolvedValue({
      success: true,
      data: undefined,
    });
    await goalInternals.streamInterrupter?.("ws-1");
    expect(interruptSpy).toHaveBeenCalledWith("ws-1");

    // streamManager knows the MCP manager (lease acquire/release per stream).
    const streamManagerInternals = root.streamManager as unknown as {
      mcpServerManager?: unknown;
    };
    expect(streamManagerInternals.mcpServerManager).toBe(root.mcpServerManager);

    // Registration probe installed on the extension metadata store and bound to
    // this config: an unknown id is reported as not registered.
    const extensionMetadataInternals = root.extensionMetadata as unknown as {
      registrationProbe: ((workspaceId: string) => Promise<boolean>) | null;
    };
    expect(extensionMetadataInternals.registrationProbe).not.toBeNull();
    const probe = extensionMetadataInternals.registrationProbe!;
    expect(await probe("no-such-workspace")).toBe(false);
  });

  it("rejects a core graph whose inputs are missing at compile time", () => {
    // `makeAppRuntime` accepts only fully provided graphs (R = never); `CoreLive`
    // alone still requires its inputs (stores, options, MemoryMeta, overrides).
    // @ts-expect-error CoreLive requires CoreInputTags
    const build = () => makeAppRuntime(CoreLive);
    expect(typeof build).toBe("function");
  });
});

import type { FileReadToolResult } from "@/common/types/tools";
import * as path from "node:path";
import { sandboxHostService } from "./sandbox/sandboxHostService";
import { QuickJSRuntimeFactory } from "./ptc/quickjsRuntime";
import { ExperimentsService } from "./experimentsService";
import { TelemetryService } from "./telemetryService";
import { MemoryService } from "./memoryService";
import { MemoryMetaService } from "./memoryMeta";
import { EXPERIMENT_IDS } from "@/common/constants/experiments";
import * as fs from "node:fs/promises";
import { attachLanguageModelCleanup, runLanguageModelCleanup } from "./languageModelCleanup";
import { WorkspaceGoalService } from "./workspaceGoalService";
import { ExtensionMetadataService } from "./ExtensionMetadataService";
import { afterEach, describe, expect, mock, spyOn, test } from "bun:test";
import { jsonSchema, tool, type LanguageModel, type Tool } from "ai";
import { InitStateManager } from "./initStateManager";
import { ProviderService } from "./providerService";
import type { ProviderModelFactory } from "./providerModelFactory";
import { AIService } from "./aiService";
import type { StreamManager } from "./streamManager";
import type { MCPServerManager } from "./mcpServerManager";
import { createTestHistoryService } from "./testHistoryService";
import { createAgentSessionHarness, createStartedTurnHandle } from "./agentSession.testHarness";
import { createMuxMessage } from "@/common/types/message";
import { Err, Ok } from "@/common/types/result";
import { eventSpine } from "./events/eventSpine";
import * as contextLimit from "@/common/utils/compaction/contextLimit";
import * as toolsModule from "@/common/utils/tools/tools";

const model = "openai:gpt-4o";
const workspaceId = "pinned-budget-admission";
const smallTool = tool({ inputSchema: jsonSchema({ type: "object", properties: {} }) });

afterEach(() => mock.restore());

async function setup(
  kind: "system" | "advertised-schema" | "deferred-schema" | "small",
  emergency = false
) {
  const history = await createTestHistoryService();
  const { config, historyService } = history;
  spyOn(config, "findWorkspace").mockReturnValue({
    projectPath: config.rootDir,
    workspacePath: config.rootDir,
  });
  const init = new InitStateManager(config);
  const experimentsService = new ExperimentsService({
    telemetryService: new TelemetryService(config.rootDir),
    xumHome: config.rootDir,
  });
  const service = new AIService(
    config,
    historyService,
    init,
    new ProviderService(config),
    undefined,
    undefined,
    undefined,
    undefined,
    undefined,
    undefined,
    experimentsService
  );
  const manager = Reflect.get(service, "streamManager") as StreamManager;
  const factory = Reflect.get(service, "providerModelFactory") as ProviderModelFactory;
  const models: LanguageModel[] = [];
  const modelCleanup = mock(() => undefined);
  spyOn(factory, "resolveAndCreateModel").mockImplementation((requestedModel) => {
    const created = Object.create(null) as LanguageModel;
    models.push(created);
    attachLanguageModelCleanup(created, modelCleanup);
    return Promise.resolve(
      Ok({
        model: created,
        effectiveModelString: requestedModel,
        canonicalModelString: requestedModel,
        canonicalProviderName: "openai",
        canonicalModelId: requestedModel.slice("openai:".length),
        wireProviderName: "openai",
        routedThroughGateway: false,
      })
    );
  });
  spyOn(service, "getWorkspaceMetadata").mockResolvedValue(
    Ok({
      id: workspaceId,
      name: "test",
      projectName: "test",
      projectPath: config.rootDir,
      runtimeConfig: { type: "local" },
    })
  );
  spyOn(init, "waitForInit").mockResolvedValue(undefined);
  spyOn(contextLimit, "getEffectiveContextLimit").mockReturnValue(64000);
  const large = "漢".repeat(70000);
  const mcpTools: Record<string, Tool> =
    kind === "system" || kind === "small"
      ? {}
      : {
          mcp_large: tool({
            description: large,
            inputSchema: jsonSchema({ type: "object", properties: {} }),
          }),
        };
  service.turnRequestBuilderBindings.mcpServerManager = {
    listServers: () => Promise.resolve({}),
    getToolsForWorkspace: () =>
      Promise.resolve({
        tools: mcpTools,
        promptDescriptors: [],
        stats: {
          totalTools: Object.keys(mcpTools).length,
          activeServerCount: 1,
          failedServerCount: 0,
          failedServerNames: [],
        },
      }),
  } as unknown as MCPServerManager;
  const assembleTools = spyOn(toolsModule, "getToolsForModel").mockImplementation(
    (_model, options) =>
      Promise.resolve({
        session_history: smallTool,
        tool_catalog_search: smallTool,
        ...mcpTools,
        ...(options.enableGoalTools?.completeGoal ? { complete_goal: smallTool } : {}),
      })
  );
  const goalService = new WorkspaceGoalService(
    config,
    historyService,
    new ExtensionMetadataService(config.rootDir + "/extension-metadata.json")
  );
  const h = await createAgentSessionHarness({
    workspaceId,
    config,
    historyService,
    aiService: service,
    streamManager: manager,
    aiEmitter: service,
    initStateManager: init,
    workspaceGoalService: goalService,
  });
  const tempPaths: string[] = [];
  const createTemp = manager.createTempDirForStream.bind(manager);
  spyOn(manager, "createTempDirForStream").mockImplementation(async (...args) => {
    const dir = await createTemp(...args);
    tempPaths.push(dir);
    return dir;
  });
  let starts = 0;
  const start = spyOn(manager, "startStream").mockImplementation(async (options) => {
    if (emergency && kind === "deferred-schema" && ++starts === 1)
      return Err({
        type: "context_budget_exceeded",
        model,
        estimate: 64000,
        hardCeiling: 55808,
      });
    await options.onStreamConstructed?.();
    return Ok(createStartedTurnHandle(h.session.closingSignal, options.messageId));
  });
  const applyReset = spyOn(h.session, "applyContextResetSideEffects");
  const assembly = mock((ctx: { systemMessage: string }) => {
    if (kind === "system") ctx.systemMessage += large;
    return Promise.resolve();
  });
  const registration = eventSpine.useRequestContext(assembly, { workspaceId });
  const oldCache = Reflect.get(h.session, "memoryContextByModelString") as Map<string, unknown>;
  oldCache.set("preserved-model", { context: { hotMemoriesBlock: "Preserved old notes" } });
  h.session.setAutoCompactionThreshold(0.7);
  expect(
    (
      await historyService.appendManyToHistory(workspaceId, [
        createMuxMessage("old-user", "user", "Old accepted request"),
        createMuxMessage("old-answer", "assistant", "Retain this useful context", {
          model,
          contextUsage: {
            inputTokens: emergency ? 20000 : 56000,
            outputTokens: 10,
            totalTokens: emergency ? 20010 : 56010,
          },
        }),
      ])
    ).success
  ).toBe(true);
  const before = await historyService.getHistoryFromLatestBoundary(workspaceId);
  return {
    h,
    historyService,
    before,
    config,
    service,
    manager,
    factory,
    goalService,
    experimentsService,
    start,
    assembleTools,
    assembly,
    applyReset,
    oldCache,
    models,
    modelCleanup,
    tempPaths,
    cleanup: async () => {
      registration();
      await h.session.dispose();
      for (const model of models) runLanguageModelCleanup(model);
      for (const dir of tempPaths) await fs.rm(dir, { recursive: true, force: true });
      await history.cleanup();
    },
  };
}

describe("pinned full-payload rollover admission", () => {
  test.each(
    (["system", "advertised-schema", "deferred-schema"] as const).flatMap((kind) =>
      [false, true].map((emergency) => ({ kind, emergency }))
    )
  )(
    "$kind is sized before the old context is reset (emergency=$emergency)",
    async ({ kind, emergency }) => {
      const fixture = await setup(kind, emergency);
      const { h, historyService, before, start, assembleTools, assembly, applyReset, oldCache } =
        fixture;
      try {
        const result = await h.session.sendMessage("Small follow-up", {
          model,
          agentId: "exec",
          experiments: { tokenBudget: true, toolSearch: kind === "deferred-schema" },
        });
        const fits = kind === "deferred-schema";
        expect(result.success).toBe(fits);
        expect(applyReset).toHaveBeenCalledTimes(fits ? 1 : 0);
        expect(start).toHaveBeenCalledTimes(fits ? (emergency ? 2 : 1) : 0);
        expect(assembleTools).toHaveBeenCalledTimes(emergency ? 2 : 1);
        expect(assembly).toHaveBeenCalledTimes(emergency ? 2 : 1);
        const after = await historyService.getHistoryFromLatestBoundary(workspaceId);
        expect(after.success).toBe(true);
        if (!before.success || !after.success) throw new Error("History read failed");
        expect(
          after.data.some((row) => row.metadata?.muxMetadata?.type === "context-window-rollover")
        ).toBe(fits);
        if (!fits) {
          expect(fixture.modelCleanup).toHaveBeenCalledTimes(emergency ? 2 : 1);
          for (const dir of fixture.tempPaths)
            expect(
              await fs.stat(dir).then(
                () => true,
                () => false
              )
            ).toBe(false);
          expect(Reflect.get(h.session, "memoryContextByModelString")).toBe(oldCache);
          expect(oldCache.get("preserved-model")).toEqual({
            context: { hotMemoriesBlock: "Preserved old notes" },
          });
        }
        if (fits) {
          const started = start.mock.calls.at(-1)![0];
          const trigger = after.data.findLast((row) => row.role === "user");
          expect(started.initialMetadata?.requestHistorySequence).toBe(
            trigger?.metadata?.historySequence
          );
        }
        if (!fits)
          expect(after.data.filter((row) => before.data.some((old) => old.id === row.id))).toEqual(
            before.data
          );
      } finally {
        await fixture.cleanup();
      }
    }
  );
  test.each(["during-assembly", "after-preparation"] as const)(
    "%s cancellation owns the unstarted model and temp directory",
    async (phase) => {
      const fixture = await setup("small");
      const { h, assembly, applyReset, start, modelCleanup, tempPaths } = fixture;
      const entered = Promise.withResolvers<void>();
      const release = Promise.withResolvers<void>();
      if (phase === "during-assembly")
        assembly.mockImplementation(async () => {
          entered.resolve();
          await release.promise;
        });
      const sending = h.session.sendMessage(
        "Canceled candidate",
        { model, agentId: "exec", experiments: { tokenBudget: true } },
        {
          onAccepted:
            phase === "after-preparation"
              ? async () => {
                  entered.resolve();
                  await release.promise;
                }
              : undefined,
        }
      );
      let disposal: Promise<void> | undefined;
      try {
        await entered.promise;
        disposal = h.session.dispose();
        release.resolve();
        await sending;
        await disposal;
        expect(start).not.toHaveBeenCalled();
        expect(applyReset).toHaveBeenCalledTimes(phase === "during-assembly" ? 0 : 1);
        expect(modelCleanup).toHaveBeenCalledTimes(1);
        expect(tempPaths).toHaveLength(1);
        for (const dir of tempPaths)
          expect(
            await fs.stat(dir).then(
              () => true,
              () => false
            )
          ).toBe(false);
      } finally {
        release.resolve();
        await sending;
        await disposal;
        await fixture.cleanup();
      }
    }
  );

  test.each([false, true])(
    "manual goal availability previews later pause (queued consent=%s)",
    async (consent) => {
      const fixture = await setup("small");
      const { h, goalService, start, applyReset, assembly } = fixture;
      try {
        expect(
          (await goalService.setGoal({ workspaceId, objective: "Active work", initiator: "user" }))
            .success
        ).toBe(true);
        const goal = await goalService.getGoal(workspaceId);
        expect(goal?.lastUserActivationAtMs).toBeNumber();
        expect(
          (
            await h.session.sendMessage(
              "Manual intervention",
              { model, agentId: "exec", experiments: { tokenBudget: true } },
              {
                enqueuedAtMs: consent ? goal!.lastUserActivationAtMs! - 1000 : undefined,
              }
            )
          ).success
        ).toBe(true);
        expect(start).toHaveBeenCalledTimes(1);
        expect(start.mock.calls[0][0].tools?.complete_goal !== undefined).toBe(consent);
        expect((await goalService.getGoal(workspaceId))?.status).toBe(
          consent ? "active" : "paused"
        );
        expect(assembly).toHaveBeenCalledTimes(1);
        expect(applyReset).toHaveBeenCalledTimes(1);
      } finally {
        await fixture.cleanup();
      }
    }
  );

  test("rejected full assembly preserves old context while applying manual goal safety", async () => {
    const fixture = await setup("system");
    try {
      expect(
        (
          await fixture.goalService.setGoal({
            workspaceId,
            objective: "Active work",
            initiator: "user",
          })
        ).success
      ).toBe(true);
      const result = await fixture.h.session.sendMessage("Manual intervention", {
        model,
        agentId: "exec",
        experiments: { tokenBudget: true },
      });
      expect(result).toMatchObject({ success: false, error: { type: "context_budget_blocked" } });
      expect((await fixture.goalService.getGoal(workspaceId))?.status).toBe("paused");
      expect(fixture.applyReset).not.toHaveBeenCalled();
      const rows = await fixture.historyService.getHistoryFromLatestBoundary(workspaceId);
      expect(rows.success && rows.data.some((row) => row.metadata?.contextBudgetRejected)).toBe(
        true
      );
    } finally {
      await fixture.cleanup();
    }
  });
  test.each([false, true])(
    "fresh-window notes are isolated until accepted (overflow=%s)",
    async (overflow) => {
      const fixture = await setup("small");
      const { h, service, config, oldCache, assembleTools, start, applyReset } = fixture;
      service.turnRequestBuilderBindings.memoryService = new MemoryService(
        config,
        new MemoryMetaService(config.rootDir)
      );
      spyOn(fixture.experimentsService, "isExperimentEnabled").mockImplementation(
        (id) => id === EXPERIMENT_IDS.MEMORY || id === EXPERIMENT_IDS.MEMORY_HOT_SET
      );
      // The real builder gates hot-memory injection on its experiment service, independently of the session cache.
      const experiments = { memory: true, tokenBudget: true };
      const previous = {
        context: { indexEntries: [], hotMemoriesBlock: "Obsolete notes" },
        includesHotMemories: true,
        tokenBudgetActive: true,
        memoryEnabled: true,
        hotSetEnabled: true,
      };
      oldCache.set(model, previous);
      const fresh = overflow ? "漢".repeat(70000) : "Fresh retained notes";
      const readMemory = spyOn(service, "buildMemorySessionContext").mockImplementation(
        (_workspace, _model, options) =>
          Promise.resolve({
            indexEntries: [],
            hotMemoriesBlock: options?.includeHotMemories === false ? null : fresh,
          })
      );
      assembleTools.mockResolvedValue({ session_history: smallTool, memory: smallTool });
      try {
        expect(
          (
            await h.session.sendMessage("Use current notes", {
              model,
              agentId: "exec",
              experiments,
            })
          ).success
        ).toBe(!overflow);
        expect(readMemory).toHaveBeenCalledTimes(2);
        expect(applyReset).toHaveBeenCalledTimes(overflow ? 0 : 1);
        if (overflow) {
          expect(Reflect.get(h.session, "memoryContextByModelString")).toBe(oldCache);
          expect(oldCache.get(model)).toBe(previous);
        } else {
          expect(start.mock.calls[0][0].system).toContain(fresh);
          expect(start.mock.calls[0][0].system).not.toContain("Obsolete notes");
          const cache = Reflect.get(h.session, "memoryContextByModelString") as Map<
            string,
            unknown
          >;
          expect(cache.get(model)).toMatchObject({
            context: { hotMemoriesBlock: fresh },
            includesHotMemories: true,
          });
        }
      } finally {
        await fixture.cleanup();
      }
    }
  );
  test.each(["dispose", "cancel", "admission-revoked"] as const)(
    "%s after preparation publishes no stream or accepted history",
    async (action) => {
      const fixture = await setup("small");
      const {
        h,
        service,
        manager,
        historyService,
        before,
        modelCleanup,
        tempPaths,
        start,
        applyReset,
      } = fixture;
      const prepared = service.prepareStreamMessage.bind(service);
      const entered = Promise.withResolvers<void>();
      const release = Promise.withResolvers<void>();
      spyOn(service, "prepareStreamMessage").mockImplementation(async (options) => {
        const result = await prepared(options);
        expect(result.success).toBe(true);
        entered.resolve();
        await release.promise;
        return result;
      });
      const beginStart = spyOn(manager, "beginStreamStart");
      const append = spyOn(historyService, "appendToHistory");
      const appendBatch = spyOn(historyService, "appendManyToHistory");
      const accepted = mock(() => undefined);
      const controller = new AbortController();
      let revoked = false;
      const sending = h.session.sendMessage(
        "Revocable candidate",
        { model, agentId: "exec", experiments: { tokenBudget: true } },
        {
          cancelSignal: controller.signal,
          admissionStale: () => revoked,
          onAccepted: accepted,
        }
      );
      let disposal: Promise<void> | undefined;
      try {
        await entered.promise;
        expect(beginStart).not.toHaveBeenCalled();
        expect(append).not.toHaveBeenCalled();
        expect(appendBatch).not.toHaveBeenCalled();
        if (action === "dispose") disposal = h.session.dispose();
        else if (action === "cancel") controller.abort();
        else revoked = true;
        release.resolve();
        await sending;
        await disposal;
        expect(start).not.toHaveBeenCalled();
        expect(beginStart).not.toHaveBeenCalled();
        expect(accepted).not.toHaveBeenCalled();
        expect(applyReset).not.toHaveBeenCalled();
        expect(await historyService.getHistoryFromLatestBoundary(workspaceId)).toEqual(before);
        expect(modelCleanup).toHaveBeenCalledTimes(1);
        for (const dir of tempPaths)
          expect(
            await fs.stat(dir).then(
              () => true,
              () => false
            )
          ).toBe(false);
      } finally {
        release.resolve();
        await sending;
        await disposal;
        await fixture.cleanup();
      }
    }
  );

  test("rollover append failure disposes the prepared request without registering an assistant", async () => {
    const fixture = await setup("small");
    const {
      h,
      manager,
      historyService,
      before,
      start,
      applyReset,
      assembly,
      modelCleanup,
      tempPaths,
    } = fixture;
    const beginStart = spyOn(manager, "beginStreamStart");
    const accepted = mock(() => undefined);
    spyOn(historyService, "appendManyToHistory").mockResolvedValueOnce(
      Err("injected rollover append failure")
    );
    try {
      expect(
        await h.session.sendMessage(
          "Prepared but not committed",
          { model, agentId: "exec", experiments: { tokenBudget: true } },
          { onAccepted: accepted }
        )
      ).toMatchObject({ success: false, error: { type: "unknown" } });
      expect(assembly).toHaveBeenCalledTimes(1);
      expect(applyReset).toHaveBeenCalledTimes(1);
      expect(accepted).not.toHaveBeenCalled();
      expect(start).not.toHaveBeenCalled();
      expect(beginStart).not.toHaveBeenCalled();
      expect(await historyService.getHistoryFromLatestBoundary(workspaceId)).toEqual(before);
      expect(modelCleanup).toHaveBeenCalledTimes(1);
      for (const dir of tempPaths)
        expect(
          await fs.stat(dir).then(
            () => true,
            () => false
          )
        ).toBe(false);
    } finally {
      await fixture.cleanup();
    }
  });

  test("real prepared tools retain a usable runtime after old sandbox and cache state is discarded", async () => {
    const getToolsForModel = toolsModule.getToolsForModel;
    const fixture = await setup("small");
    const { h, config, start, assembleTools, assembly, oldCache } = fixture;
    assembleTools.mockImplementation(getToolsForModel);
    spyOn(contextLimit, "getEffectiveContextLimit").mockReturnValue(256000);
    h.session.setAutoCompactionThreshold(0.1);
    const sessionDir = path.join(config.sessionsDir, workspaceId);
    const mountOptions = {
      lifetime: "persistent" as const,
      runtimeFactory: new QuickJSRuntimeFactory(),
      scopeKey: workspaceId,
      sessionDir,
    };
    try {
      const oldMount = await sandboxHostService.acquireMount(mountOptions);
      expect(
        (await oldMount.runtime.eval("vars.secret = 'old-window'; return true;")).success
      ).toBe(true);
      await oldMount.persistVars();
      const filename = path.join(config.rootDir, "prepared-runtime.txt");
      await fs.writeFile(filename, "Prepared runtime is usable\n");
      expect(
        (
          await h.session.sendMessage("Start a fresh window", {
            model,
            agentId: "exec",
            experiments: { tokenBudget: true },
          })
        ).success
      ).toBe(true);
      expect(oldMount.isDisposed).toBe(true);
      expect(oldCache.size).toBe(0);
      expect(assembleTools).toHaveBeenCalledTimes(1);
      expect(assembly).toHaveBeenCalledTimes(1);
      const preparedTools = start.mock.calls[0][0].tools!;
      expect(preparedTools.file_read?.execute).toBeDefined();
      const result = (await preparedTools.file_read.execute!(
        { path: filename },
        { toolCallId: "read-after-reset", messages: [], context: undefined }
      )) as FileReadToolResult;
      expect(result.success).toBe(true);
      if (!result.success) throw new Error(result.error);
      expect(result.content).toContain("Prepared runtime is usable");
      const freshMount = await sandboxHostService.acquireMount(mountOptions);
      expect(freshMount).not.toBe(oldMount);
      const vars = await freshMount.runtime.eval("return Object.keys(vars);");
      expect(vars).toMatchObject({ success: true, result: [] });
    } finally {
      await sandboxHostService.dropScope(workspaceId);
      await fixture.cleanup();
    }
  });

  test("prepared primary keeps fallbacks lazy and admits the actual fallback model on demand", async () => {
    const fixture = await setup("small");
    const { h, config, start, factory, assembly, assembleTools, modelCleanup } = fixture;
    const fallbackModel = "openai:gpt-4o-mini";
    await config.editConfig((cfg) => ({
      ...cfg,
      modelFallbacks: { [model]: { models: [fallbackModel] } },
    }));
    const created = spyOn(factory, "resolveAndCreateModel");
    const contextualAssembly = eventSpine.useRequestContext(
      (ctx) => {
        if (ctx.modelString === fallbackModel) ctx.systemMessage += "漢".repeat(70000);
      },
      { workspaceId }
    );
    try {
      expect(
        (
          await h.session.sendMessage("Use a prepared primary", {
            model,
            agentId: "exec",
            experiments: { tokenBudget: true },
          })
        ).success
      ).toBe(true);
      expect(created.mock.calls.map((call) => call[0])).toEqual([model]);
      expect(assembleTools).toHaveBeenCalledTimes(1);
      expect(assembly).toHaveBeenCalledTimes(1);
      expect(modelCleanup).not.toHaveBeenCalled();
      const fallback = start.mock.calls[0][0].modelFallback!;
      expect(fallback.chain).toEqual([fallbackModel]);
      expect(await fallback.prepare(fallbackModel)).toMatchObject({
        success: false,
        error: { type: "context_budget_exceeded", model: fallbackModel },
      });
      expect(created.mock.calls.map((call) => call[0])).toEqual([model, fallbackModel]);
      expect(assembleTools).toHaveBeenCalledTimes(2);
      expect(assembly).toHaveBeenCalledTimes(2);
      expect(modelCleanup).toHaveBeenCalledTimes(1);
    } finally {
      contextualAssembly();
      await fixture.cleanup();
    }
  });
  test.each(["goal-sync", "on-accepted", "streaming"] as const)(
    "late admission cancellation during %s cannot revoke an accepted prepared wake",
    async (phase) => {
      const fixture = await setup("small");
      const { h, goalService, start, historyService, applyReset, assembly } = fixture;
      const entered = Promise.withResolvers<void>();
      const release = Promise.withResolvers<void>();
      const controller = new AbortController();
      const canceled = mock(() => undefined);
      const accepted = mock(async () => {
        if (phase === "on-accepted") {
          entered.resolve();
          await release.promise;
        }
      });
      if (phase === "goal-sync") {
        const sync = goalService.syncGoalModeWithChatTail.bind(goalService);
        spyOn(goalService, "syncGoalModeWithChatTail").mockImplementationOnce(async (...args) => {
          entered.resolve();
          await release.promise;
          return sync(...args);
        });
      }
      const sending = h.session.sendMessage(
        "Durable prepared monitor wake",
        { model, agentId: "exec", experiments: { tokenBudget: true } },
        {
          synthetic: true,
          agentInitiated: true,
          cancelSignal: controller.signal,
          onCanceled: canceled,
          onAccepted: accepted,
        }
      );
      try {
        if (phase === "streaming") expect((await sending).success).toBe(true);
        else await entered.promise;
        controller.abort("monitor removed after the rollback horizon");
        release.resolve();
        expect((await sending).success).toBe(true);
        expect(accepted).toHaveBeenCalledTimes(1);
        expect(canceled).not.toHaveBeenCalled();
        expect(start).toHaveBeenCalledTimes(1);
        expect(start.mock.calls[0][0].abortSignal?.aborted).toBe(false);
        expect(applyReset).toHaveBeenCalledTimes(1);
        expect(assembly).toHaveBeenCalledTimes(1);
        const rows = await historyService.getHistoryFromLatestBoundary(workspaceId);
        expect(
          rows.success &&
            rows.data.some(
              (row) =>
                row.role === "user" &&
                row.parts.some(
                  (part) => part.type === "text" && part.text === "Durable prepared monitor wake"
                )
            )
        ).toBe(true);
      } finally {
        release.resolve();
        await sending;
        await fixture.cleanup();
      }
    }
  );
  test.each(["interrupt", "dispose"] as const)(
    "accepted prepared startup still honors %s after admission cancellation detaches",
    async (action) => {
      const fixture = await setup("small");
      const { h, start, applyReset } = fixture;
      const entered = Promise.withResolvers<AbortSignal>();
      const aborted = Promise.withResolvers<void>();
      const release = Promise.withResolvers<void>();
      start.mockImplementation(async (options) => {
        const signal = options.abortSignal;
        if (!signal) throw new Error("Prepared startup must have an abort signal");
        signal.addEventListener("abort", () => aborted.resolve(), { once: true });
        entered.resolve(signal);
        await release.promise;
        return Ok(createStartedTurnHandle(signal, options.messageId));
      });
      const controller = new AbortController();
      const sending = h.session.sendMessage(
        "Accepted prepared wake",
        { model, agentId: "exec", experiments: { tokenBudget: true } },
        {
          synthetic: true,
          agentInitiated: true,
          cancelSignal: controller.signal,
        }
      );
      let stopped: Promise<void> | undefined;
      try {
        const signal = await entered.promise;
        controller.abort("admission-only cancellation");
        expect(signal.aborted).toBe(false);
        stopped =
          action === "interrupt"
            ? h.session.interruptStream().then((result) => {
                expect(result.success).toBe(true);
              })
            : h.session.dispose();
        await aborted.promise;
        expect(signal.aborted).toBe(true);
        release.resolve();
        await sending;
        await stopped;
        expect(start).toHaveBeenCalledTimes(1);
        expect(applyReset).toHaveBeenCalledTimes(1);
      } finally {
        release.resolve();
        await sending;
        await stopped;
        await fixture.cleanup();
      }
    }
  );
  test.each([false, true])(
    "cancellation during rollover append follows the durable rollback outcome (rollback fails=%s)",
    async (rollbackFails) => {
      const fixture = await setup("small");
      const { h, historyService, before, start, assembly, modelCleanup } = fixture;
      const entered = Promise.withResolvers<void>();
      const release = Promise.withResolvers<void>();
      const append = historyService.appendManyToHistory.bind(historyService);
      spyOn(historyService, "appendManyToHistory").mockImplementationOnce(async (...args) => {
        entered.resolve();
        await release.promise;
        return append(...args);
      });
      const rollback = spyOn(historyService, "deleteMessages");
      if (rollbackFails) rollback.mockResolvedValueOnce(Err("injected durable rollback failure"));
      const controller = new AbortController();
      const accepted = mock(() => undefined);
      const canceled = mock(() => undefined);
      const cancelState = { canceledBeforeAcceptance: false };
      const sending = h.session.sendMessage(
        "Wake retained when rollback fails",
        { model, agentId: "exec", experiments: { tokenBudget: true } },
        {
          synthetic: true,
          agentInitiated: true,
          cancelSignal: controller.signal,
          cancelState,
          onAccepted: accepted,
          onCanceled: canceled,
        }
      );
      try {
        await entered.promise;
        controller.abort("monitor canceled during rollover publication");
        release.resolve();
        expect((await sending).success).toBe(true);
        expect(rollback).toHaveBeenCalledTimes(1);
        expect(accepted).toHaveBeenCalledTimes(rollbackFails ? 1 : 0);
        expect(canceled).toHaveBeenCalledTimes(rollbackFails ? 0 : 1);
        expect(cancelState.canceledBeforeAcceptance).toBe(!rollbackFails);
        expect(assembly).toHaveBeenCalledTimes(1);
        expect(start).toHaveBeenCalledTimes(rollbackFails ? 1 : 0);
        if (rollbackFails) {
          expect(start.mock.calls[0][0].abortSignal?.aborted).toBe(false);
          const rows = await historyService.getHistoryFromLatestBoundary(workspaceId);
          expect(
            rows.success &&
              rows.data.some((row) =>
                row.parts.some(
                  (part) =>
                    part.type === "text" && part.text === "Wake retained when rollback fails"
                )
              )
          ).toBe(true);
        } else {
          expect(modelCleanup).toHaveBeenCalledTimes(1);
          expect(await historyService.getHistoryFromLatestBoundary(workspaceId)).toEqual(before);
        }
      } finally {
        release.resolve();
        await sending;
        await fixture.cleanup();
      }
    }
  );
});

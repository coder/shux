import { findWorkspaceEntry } from "@/node/services/taskUtils";
import {
  clearWorkspaceMemoryDenyMarker,
  readWorkspaceMemoryDenyMarker,
  readWorkspaceMemoryDenyMarkerForEpochs,
  workspaceMemoryDenyMarkerPath,
  writeWorkspaceMemoryDenyMarker,
} from "@/node/services/workspaceMemoryDenyMarker";
import {
  workspaceRemovalTombstonePath,
  isWorkspaceRemovalTombstoned,
} from "@/node/services/workspaceRemoval";
import {
  setWorkspaceMemoryWritableForEpoch,
  workspaceMemoryWritableForEpoch,
} from "@/node/services/workspaceMemoryPolicyEpochs";
import { withTargetMutationLock } from "@/node/services/refinement/targetMutationLocks";
import type { TurnCompletion } from "./streamManager";
import type { TurnCoordinator } from "./turnCoordinator";
import { MutexMap } from "@/node/utils/concurrency/mutexMap";
import { describe, expect, test, mock, beforeEach, afterEach, spyOn, type Mock } from "bun:test";
import { WorkspaceService, generateForkBranchName, generateForkTitle } from "./workspaceService";
import { STOP_UNRECORDED_MESSAGE } from "@/common/constants/workspace";
import { registerInProcessWorkflowRun } from "@/node/services/workflows/workflowArchiveAdmission";
import type { IdleCompactionOutcome } from "./idleCompactionService";
import type { AgentSession } from "./agentSession";
import { CONTEXT_MUTATION_SEND_BLOCKED_MESSAGE } from "./agentSession";
import {
  createAgentSessionHarness,
  createStartedTurnHandle,
  createStreamLifecycleMocks,
} from "./agentSession.testHarness";
import type { AutoCompactionUsageState } from "@/common/utils/compaction/autoCompactionCheck";
import { createDisplayUsage } from "@/common/utils/tokens/displayUsage";
import { askUserQuestionManager } from "./askUserQuestionManager";
import { WorkspaceLifecycleHooks } from "./workspaceLifecycleHooks";
import { EventEmitter } from "events";
import { existsSync } from "fs";
import * as fsPromises from "fs/promises";
import { tmpdir } from "os";
import path from "path";
import { Err, Ok, type Result } from "@/common/types/result";
import { SCRATCH_PROJECT_CONFIG_KEY } from "@/common/constants/scratch";
import type { SendMessageError } from "@/common/types/errors";
import type { ProjectsConfig } from "@/common/types/project";
import type { Config, SecretsStore } from "@/node/config";
import type { HistoryService } from "./historyService";
import { createTestHistoryService } from "./testHistoryService";
import type { SessionTimingService } from "./sessionTimingService";
import { SessionUsageService } from "./sessionUsageService";
import type { AIService } from "./aiService";
import { MockLanguageModelV3, simulateReadableStream } from "ai/test";
import { streamText, tool } from "ai";
import { z } from "zod";
import { StreamManager } from "./streamManager";
import type { LanguageModelV3StreamPart } from "@ai-sdk/provider";
import { EXPERIMENT_IDS } from "@/common/constants/experiments";
import type { ExperimentsService } from "./experimentsService";
import {
  awaitPendingBranchSummary,
  startAbandonedBranchSummaryInBackground,
  type BranchSummaryAiService,
} from "./branchSummary";
import type { InitStateManager, InitStatus } from "./initStateManager";
import {
  ExtensionMetadataService,
  type ExtensionMetadataStreamingUpdate,
} from "./ExtensionMetadataService";
import type {
  FrontendWorkspaceMetadata,
  WorkspaceActivitySnapshot,
  WorkspaceMetadata,
} from "@/common/types/workspace";
import { makeAgentTaskIntegrationFake } from "./taskWorkspaceSeam.testUtils";
import type { BackgroundProcessManager } from "./backgroundProcessManager";
import type { TerminalService } from "@/node/services/terminalService";
import type { DesktopSessionManager } from "@/node/services/desktop/DesktopSessionManager";
import type { MCPServerManager } from "@/node/services/mcpServerManager";
import type { WorktreeArchiveSnapshot } from "@/common/schemas/project";
import type { BashToolResult } from "@/common/types/tools";
import type { SendMessageOptions, WorkspaceChatMessage } from "@/common/orpc/types";
import { createMuxMessage, type MuxMessageMetadata } from "@/common/types/message";
import { buildStagedAttachmentNotice } from "@/browser/features/ChatInput/stagedAttachments";
import {
  WORKFLOW_RESULT_METADATA_TYPE,
  WORKFLOW_RUN_CARD_DISPLAY_METADATA_TYPE,
  WORKFLOW_TRIGGER_DISPLAY_METADATA_TYPE,
  buildWorkflowResultContextMessage,
} from "@/common/utils/workflowRunMessages";
import { recordAgentWorkflowRunReference } from "@/node/services/agentWorkflowRunReferences";
import { getPlanFilePath } from "@/common/utils/planStorage";
import * as todoStorageModule from "@/node/services/todos/todoStorage";
import * as runtimeFactory from "@/node/runtime/runtimeFactory";
import * as bashToolModule from "@/node/services/tools/bash";
import * as forkOrchestratorModule from "@/node/services/utils/forkOrchestrator";
import * as runtimeExecHelpers from "@/node/utils/runtime/helpers";
import * as removeManagedGitWorktreeModule from "@/node/worktree/removeManagedGitWorktree";
import * as workspaceTitleGenerator from "./workspaceTitleGenerator";
import { WorkflowRunStore } from "./workflows/WorkflowRunStore";
import { WorkspaceGoalService } from "./workspaceGoalService";
import { IdleDispatcher } from "./idleDispatcher";
import type { GoalRecordV1 } from "@/common/types/goal";
import { enforceThinkingPolicy } from "@/common/utils/thinking/policy";
import {
  hasBudgetedResumableGoal,
  modelHasPricingData,
  UNPRICED_TARGET_MODEL_GOAL_MESSAGE,
} from "@/common/utils/goals/budgetPricing";
// Shared `drainPendingDispatches` + `waitForCondition` helpers live in
// `./testDispatchHelpers` (Coder-agents-review P3 DEREM-41 + nit DEREM-48 +
// nit DEREM-50) — import instead of defining local copies.
import { drainPendingDispatches, waitForCondition } from "./testDispatchHelpers";
import { sandboxHostService } from "./sandbox/sandboxHostService";
import type {
  BashMonitorProcessSnapshot,
  BashMonitorWakeReconciler,
  BashMonitorWakeReconcilerProcessManager,
  BashMonitorWakeReconcilerRegistry,
  BashMonitorWakeDispatch,
} from "./bashMonitorWakeReconciler";

// Helper to access private renamingWorkspaces set
function addToRenamingWorkspaces(service: WorkspaceService, workspaceId: string): void {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any, @typescript-eslint/no-unsafe-member-access, @typescript-eslint/no-unsafe-call
  (service as any).renamingWorkspaces.add(workspaceId);
}

// Helper to access private archivingWorkspaces set
function addToArchivingWorkspaces(service: WorkspaceService, workspaceId: string): void {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any, @typescript-eslint/no-unsafe-member-access, @typescript-eslint/no-unsafe-call
  (service as any).archivingWorkspaces.add(workspaceId);
}

async function withTempMuxRoot<T>(fn: (root: string) => Promise<T>): Promise<T> {
  const originalMuxRoot = process.env.MUX_ROOT;
  const tempRoot = await fsPromises.mkdtemp(path.join(tmpdir(), "mux-plan-"));
  process.env.MUX_ROOT = tempRoot;

  try {
    return await fn(tempRoot);
  } finally {
    if (originalMuxRoot === undefined) {
      delete process.env.MUX_ROOT;
    } else {
      process.env.MUX_ROOT = originalMuxRoot;
    }
    await fsPromises.rm(tempRoot, { recursive: true, force: true });
  }
}

async function writePlanFile(
  root: string,
  projectName: string,
  workspaceName: string
): Promise<string> {
  const planFile = getPlanFilePath(workspaceName, projectName, root);
  await fsPromises.mkdir(path.dirname(planFile), { recursive: true });
  await fsPromises.writeFile(planFile, "# Plan\n");
  return planFile;
}

function createDeferred<T>() {
  let resolve!: (value: T | PromiseLike<T>) => void;
  let reject!: (reason?: unknown) => void;
  const promise = new Promise<T>((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
}

// NOTE: This test file uses bun:test mocks (not Jest).

const mockInitStateManager: Partial<InitStateManager> = {
  on: mock(() => undefined as unknown as InitStateManager),
  off: mock(() => undefined as unknown as InitStateManager),
  getInitState: mock(() => undefined),
  waitForInit: mock(() => Promise.resolve()),
  clearInMemoryState: mock(() => undefined),
};
const mockExtensionMetadataService: Partial<ExtensionMetadataService> = {
  isWorkspaceDeleted: mock(() => false),
  clearTombstonesForRegisteredIds: mock(() => undefined),
  getTombstonedIds: mock((): ReadonlyMap<string, number> => new Map()),
  setTombstoneClearedListener: mock(() => undefined),
  setStreaming: mock(() =>
    Promise.resolve({
      recency: Date.now(),
      streaming: false,
      lastModel: null,
      lastThinkingLevel: null,
      agentStatus: null,
    })
  ),
  updateRecency: mock(() =>
    Promise.resolve({
      recency: Date.now(),
      streaming: false,
      lastModel: null,
      lastThinkingLevel: null,
      agentStatus: null,
    })
  ),
};
const mockBackgroundProcessManager: Partial<BackgroundProcessManager> = {
  cleanup: mock(() => Promise.resolve()),
  hasRunningBackgroundProcesses: mock(() => false),
  hasOrphanedRunningBackgroundProcesses: mock(() => Promise.resolve(false)),
};

type WorkspaceServiceArgs = ConstructorParameters<typeof WorkspaceService>;
type MockWorkspaceConfig = Partial<Config> & {
  getEffectiveSecrets?: SecretsStore["getEffectiveSecrets"];
};

function createMockAIService(overrides: Partial<AIService> = {}): AIService {
  return {
    on: mock(() => undefined),
    off: mock(() => undefined),
    ...createStreamLifecycleMocks(),
    ...overrides,
  } as unknown as AIService;
}

/**
 * Mock configs model no file on disk. Production requires an EXISTING
 * config.json for removal's shared-memory handover and the memory policy
 * accumulator (Config.loadExistingConfigOrThrow); for a mock that only
 * provides loadConfigOrDefault, treat that snapshot as the existing file.
 */
function withExistingConfigLoader<T extends Partial<Config>>(config: T): T {
  if (
    typeof config.loadExistingConfigOrThrow !== "function" &&
    typeof config.loadConfigOrDefault === "function"
  ) {
    const load = config.loadConfigOrDefault.bind(config);
    return { ...config, loadExistingConfigOrThrow: () => load({ throwOnError: true }) };
  }
  return config;
}

function createWorkspaceServiceForTest(options: {
  config:
    | (Partial<Config> & { getEffectiveSecrets?: SecretsStore["getEffectiveSecrets"] })
    | Config;
  historyService?: HistoryService;
  aiService?: AIService;
  initStateManager?: InitStateManager;
  extensionMetadata?: ExtensionMetadataService;
  backgroundProcessManager?: BackgroundProcessManager;
  sessionUsageService?: WorkspaceServiceArgs[6];
  policyService?: WorkspaceServiceArgs[7];
  telemetryService?: WorkspaceServiceArgs[8];
  experimentsService?: WorkspaceServiceArgs[9];
  sessionTimingService?: WorkspaceServiceArgs[10];
  streamManager?: WorkspaceServiceArgs[11];
  secretsStore?: WorkspaceServiceArgs[12];
}): WorkspaceService {
  // Test helpers often don't exercise HistoryService; use a narrow stub for those cases.
  // eslint-disable-next-line @typescript-eslint/consistent-type-assertions
  const defaultHistoryService: HistoryService = {} as HistoryService;
  return new WorkspaceService(
    withExistingConfigLoader(options.config as Partial<Config>) as Config,
    options.historyService ?? defaultHistoryService,
    options.aiService ?? createMockAIService(),
    options.initStateManager ?? (mockInitStateManager as InitStateManager),
    options.extensionMetadata ?? (mockExtensionMetadataService as ExtensionMetadataService),
    options.backgroundProcessManager ?? (mockBackgroundProcessManager as BackgroundProcessManager),
    options.sessionUsageService,
    options.policyService,
    options.telemetryService,
    options.experimentsService,
    options.sessionTimingService,
    options.streamManager,
    options.secretsStore
  );
}

describe("WorkspaceService bash monitor wake reconciler wiring", () => {
  async function createWakeWiringService() {
    const { config, historyService, cleanup } = await createTestHistoryService();
    const events = new EventEmitter();
    const backgroundProcessManager = Object.assign(events, {
      cleanup: mock(() => Promise.resolve()),
      notifyMonitorWakeStateChanged: mock(() => undefined),
      getActiveMonitorCount: mock(() => 0),
      pullMonitorWakeSignals: mock(() => []),
      getMonitorWakeDeliveryState: mock(() => Promise.resolve(undefined)),
      acknowledgeMonitorWake: mock(() => undefined),
      dropRetiredMonitor: mock(() => undefined),
      setMessageQueued: mock(() => undefined),
    }) as unknown as BackgroundProcessManager;
    const service = createWorkspaceServiceForTest({
      config,
      historyService,
      aiService: createMockAIService({ isStreaming: mock(() => false) }),
      extensionMetadata: new ExtensionMetadataService(
        path.join(config.rootDir, "wake-wiring-extension-metadata.json")
      ),
      backgroundProcessManager,
    });
    return { config, historyService, backgroundProcessManager, service, events, cleanup };
  }

  async function createActiveWakeHarness(options?: {
    workspaceGoalService?: WorkspaceGoalService;
  }) {
    const fixture = await createWakeWiringService();
    const { config, service, historyService, backgroundProcessManager } = fixture;
    const workspaceId = "monitor-attention-owner";
    await config.addWorkspace("/tmp/monitor-attention-project", {
      id: workspaceId,
      name: workspaceId,
      projectName: "monitor-attention-project",
      projectPath: "/tmp/monitor-attention-project",
      runtimeConfig: { type: "local" },
    });
    const model = "anthropic:claude-sonnet-4-5";
    const aiEmitter = new EventEmitter();
    const requests: Array<Parameters<AIService["streamMessage"]>[0]> = [];
    const completions: Array<ReturnType<typeof Promise.withResolvers<TurnCompletion>>> = [];
    const launched = new EventEmitter();
    let streaming = false;
    const harness = await createAgentSessionHarness({
      workspaceId,
      config,
      historyService,
      backgroundProcessManager,
      aiEmitter,
      workspaceGoalService: options?.workspaceGoalService,
      aiServiceOverrides: {
        isStreaming: () => streaming,
        streamMessage: mock((request: Parameters<AIService["streamMessage"]>[0]) => {
          requests.push(request);
          const completion = Promise.withResolvers<TurnCompletion>();
          completions.push(completion);
          // Session shutdown retires an in-flight handle (as createStartedTurnHandle does), so
          // finish() can drain a turn the test never completed.
          harness.session.closingSignal.addEventListener(
            "abort",
            () => completion.resolve({ status: "aborted", abortReason: "user" }),
            { once: true }
          );
          streaming = true;
          const messageId = "assistant-" + requests.length;
          aiEmitter.emit("stream-start", {
            type: "stream-start",
            workspaceId,
            messageId,
            model,
            startTime: Date.now(),
          });
          launched.emit("start");
          return Promise.resolve(Ok({ messageId, completion: completion.promise }));
        }),
      },
    });
    const internal = service as unknown as {
      aiService: typeof harness.aiService;
      sessions: Map<string, AgentSession>;
      bashMonitorRecoveryPromise: Promise<void>;
      bashMonitorWakeReconciler: BashMonitorWakeReconciler;
      pendingBashMonitorWakeIdleWaitsByOwner: Map<string, Promise<void>>;
      getDelegatedTurnContinuationSendOptions(workspaceId: string): Promise<SendMessageOptions>;
      dispatchBashMonitorWake(dispatch: BashMonitorWakeDispatch): Promise<"in-flight" | "deferred">;
    };
    await internal.bashMonitorRecoveryPromise;
    internal.aiService = harness.aiService;
    internal.sessions.set(workspaceId, harness.session);
    internal.getDelegatedTurnContinuationSendOptions = () =>
      Promise.resolve({ model, agentId: "exec" });
    const signals: BashMonitorProcessSnapshot[] = [];
    let shown = 0;
    spyOn(backgroundProcessManager, "pullMonitorWakeSignals").mockImplementation(() => [
      ...signals,
    ]);
    spyOn(backgroundProcessManager, "getMonitorWakeDeliveryState").mockImplementation(() =>
      Promise.resolve({ status: "settled", shownThroughOffset: shown, terminalStatusShown: false })
    );
    const reconciler = internal.bashMonitorWakeReconciler;
    const dispatch = spyOn(internal, "dispatchBashMonitorWake");
    const complete = async (finishReason = "stop") => {
      const messageId = "assistant-" + requests.length;
      const message = createMuxMessage(messageId, "assistant", "final answer", {
        model,
        finishReason,
        muxMetadata: requests[requests.length - 1].muxMetadata,
      });
      await historyService.appendToHistory(workspaceId, message);
      const completed = new Promise<void>((resolve) => {
        const unsubscribe = harness.session.onChatEvent(({ message: event }) => {
          if (event.type === "stream-end") {
            unsubscribe();
            resolve();
          }
        });
      });
      streaming = false;
      const streamEnd = {
        type: "stream-end" as const,
        workspaceId,
        parts: [{ type: "text" as const, text: "final answer" }],
        metadata: { model, finishReason },
      };
      aiEmitter.emit("stream-end", { ...streamEnd, messageId });
      completions[requests.length - 1].resolve({ status: "completed", streamEnd });
      await completed;
    };
    const abort = (abortReason: "user" | "system") => {
      const messageId = "assistant-" + requests.length;
      const streamAbort = { type: "stream-abort" as const, workspaceId, metadata: { duration: 1 } };
      streaming = false;
      aiEmitter.emit("stream-abort", { ...streamAbort, messageId, abortReason });
      completions[requests.length - 1].resolve({ status: "aborted", abortReason, streamAbort });
    };
    return {
      ...fixture,
      ...harness,
      workspaceId,
      model,
      requests,
      launched,
      internal,
      reconciler,
      dispatch,
      complete,
      abort,
      stopStream: spyOn(harness.aiService, "stopStream"),
      addAttention: async (offset: number) => {
        signals.splice(
          0,
          signals.length,
          ...["first", "second"].map((processId) => ({
            processId,
            taskId: "bash:" + processId,
            ownerWorkspaceId: workspaceId,
            filter: "READY",
            filterExclude: false,
            script: "watch",
            createdAt: "2026-01-01T00:00:00.000Z",
            retired: false,
            match: { throughOffset: offset, lines: ["READY " + offset], totalMatches: 1 },
          }))
        );
        fixture.events.emit("monitor:match", workspaceId, {});
        await reconciler.reconcile(workspaceId);
      },
      consume: async (offset: number) => {
        shown = offset;
        fixture.events.emit("output:shown", workspaceId, {});
        await reconciler.reconcile(workspaceId);
      },
      finish: async () => {
        await reconciler.dispose(workspaceId);
        await harness.session.dispose();
        await fixture.cleanup();
      },
    };
  }

  test("a wake row already in history is consumed without a dispatch, even behind a compaction boundary", async () => {
    const h = await createActiveWakeHarness();
    const acknowledged = spyOn(h.backgroundProcessManager, "acknowledgeMonitorWake");
    try {
      // The row is durable but its acceptance never reached the watermark (I/O failed until exit);
      // a later compaction moved it out of the window the model sees.
      await h.historyService.appendToHistory(
        h.workspaceId,
        createMuxMessage("wake-delivered", "user", "Monitor matched", {
          timestamp: Date.now(),
          muxMetadata: {
            type: "bash-monitor-wake",
            records: ["first", "second"].map((processId) => ({
              processId,
              wakeUpdatedAt: "2026-01-01T00:00:00.000Z:7",
              kind: "match" as const,
              displayName: processId,
              filter: "READY",
              filterExclude: false,
            })),
          },
        })
      );
      await h.historyService.appendToHistory(
        h.workspaceId,
        createMuxMessage("summary-1", "assistant", "Summary", {
          timestamp: Date.now(),
          compactionBoundary: true,
          compacted: true,
          compactionEpoch: 1,
          muxMetadata: { type: "compaction-summary" },
        })
      );
      await h.addAttention(7);
      expect(h.dispatch).not.toHaveBeenCalled();
      expect(acknowledged).toHaveBeenCalledTimes(2);
      await h.addAttention(12);
      expect(h.dispatch).toHaveBeenCalledTimes(1);
    } finally {
      await h.finish();
    }
  });

  test("a wake persisted as an on-send compaction request is consumed without a dispatch", async () => {
    const h = await createActiveWakeHarness();
    const acknowledged = spyOn(h.backgroundProcessManager, "acknowledgeMonitorWake");
    try {
      await h.historyService.appendToHistory(
        h.workspaceId,
        createMuxMessage("wake-compaction", "user", "/compact", {
          timestamp: Date.now(),
          muxMetadata: {
            type: "compaction-request",
            rawCommand: "/compact",
            parsed: {
              followUpContent: {
                text: "Monitor matched",
                model: h.model,
                agentId: "exec",
                muxMetadata: {
                  type: "bash-monitor-wake",
                  records: ["first", "second"].map((processId) => ({
                    processId,
                    wakeUpdatedAt: "2026-01-01T00:00:00.000Z:7",
                    kind: "match" as const,
                    displayName: processId,
                    filter: "READY",
                    filterExclude: false,
                  })),
                },
              },
            },
          },
        })
      );
      await h.addAttention(7);
      expect(h.dispatch).not.toHaveBeenCalled();
      expect(acknowledged).toHaveBeenCalledTimes(2);
    } finally {
      await h.finish();
    }
  });

  test("an archived owner's wake is held without an idle-retry loop and dispatches on unarchive", async () => {
    const h = await createActiveWakeHarness();
    const send = spyOn(h.service, "sendMessage");
    try {
      await h.config.editConfig((config) => {
        for (const project of config.projects.values()) {
          for (const workspace of project.workspaces) {
            if (workspace.id === h.workspaceId) workspace.archivedAt = new Date().toISOString();
          }
        }
        return config;
      });
      await h.addAttention(7);
      expect(send).not.toHaveBeenCalled();
      expect(h.internal.pendingBashMonitorWakeIdleWaitsByOwner.has(h.workspaceId)).toBe(false);
      expect((await h.reconciler.snapshot(h.workspaceId)).pendingWakeKinds.size).toBe(2);

      // An unarchive whose restoration fails rolls back to archived; the wake must not have run
      // against the half-restored checkout in between.
      const snapshots = h.internal as unknown as {
        worktreeArchiveSnapshotService?: { restoreSnapshotAfterUnarchive(): Promise<unknown> };
      };
      snapshots.worktreeArchiveSnapshotService = {
        restoreSnapshotAfterUnarchive: () => Promise.resolve(Err("restore failed")),
      };
      expect((await h.service.unarchive(h.workspaceId)).success).toBe(false);
      await h.reconciler.reconcile(h.workspaceId);
      expect(send).not.toHaveBeenCalled();

      snapshots.worktreeArchiveSnapshotService = undefined;
      // Restoration succeeds but a follow-up step throws: unarchivedAt is already persisted and a
      // retried unarchive would not run the hooks again, so the held attention must still wake.
      spyOn(
        h.internal as unknown as { syncCodeWorkspaceFiles(): Promise<void> },
        "syncCodeWorkspaceFiles"
      ).mockImplementationOnce(() => {
        throw new Error("sync failed");
      });
      expect((await h.service.unarchive(h.workspaceId)).success).toBe(false);
      // Unarchive itself schedules the reconcile; no manual reconcile here.
      await waitForCondition(() => h.requests.length === 1);
    } finally {
      await h.finish();
    }
  });

  test("malformed wake metadata in history neither stalls nor consumes an outstanding wake", async () => {
    const h = await createActiveWakeHarness();
    try {
      await h.historyService.appendToHistory(
        h.workspaceId,
        createMuxMessage("wake-corrupt", "user", "Monitor matched", {
          timestamp: Date.now(),
          muxMetadata: {
            type: "bash-monitor-wake",
            records: [null, "junk", { processId: "first" }],
          } as unknown as MuxMessageMetadata,
        })
      );
      await h.addAttention(7);
      expect(h.dispatch).toHaveBeenCalledTimes(1);
    } finally {
      await h.finish();
    }
  });

  test("the SDK answers in the original stream after repeated owed wakes are consumed", async () => {
    const h = await createActiveWakeHarness();
    let step = 0;
    let offset = 0;
    const sdkModel = new MockLanguageModelV3({
      doStream: () => {
        step++;
        const chunks: LanguageModelV3StreamPart[] =
          step <= 6
            ? [
                {
                  type: "tool-call",
                  toolCallId: "tool-" + step,
                  toolName: step % 2 === 1 ? "held_tool" : "task_await",
                  input: "{}",
                },
              ]
            : [
                { type: "text-start", id: "answer" },
                { type: "text-delta", id: "answer", delta: "final answer" },
                { type: "text-end", id: "answer" },
              ];
        chunks.push({
          type: "finish",
          finishReason: { unified: step <= 6 ? "tool-calls" : "stop", raw: undefined },
          usage: {
            inputTokens: { total: 1, noCache: 1, cacheRead: 0, cacheWrite: 0 },
            outputTokens: { total: 1, text: 1, reasoning: 0 },
          },
        });
        return Promise.resolve({
          stream: simulateReadableStream({ chunks, initialDelayInMs: null, chunkDelayInMs: null }),
        });
      },
    });
    try {
      await h.session.sendMessage("original", { model: h.model, agentId: "exec" });
      const engine = new StreamManager(h.historyService) as unknown as {
        createStopWhenCondition(
          request: Pick<Parameters<AIService["streamMessage"]>[0], "hasQueuedMessages">
        ): Array<(options: { steps: unknown[] }) => boolean>;
      };
      const result = streamText({
        model: sdkModel,
        prompt: "run the monitored tasks",
        stopWhen: engine.createStopWhenCondition(h.requests[0]),
        tools: {
          held_tool: tool({
            inputSchema: z.object({}),
            execute: async () => {
              offset += 10;
              await h.addAttention(offset);
              expect((await h.reconciler.snapshot(h.workspaceId)).pendingWakeKinds.size).toBe(2);
              return "foreground finished";
            },
          }),
          task_await: tool({
            inputSchema: z.object({}),
            execute: async () => {
              await h.consume(offset);
              return "READY";
            },
          }),
        },
      });
      expect(await result.text).toBe("final answer");
      expect(step).toBe(7);
      expect(h.dispatch).toHaveBeenCalled();
      await h.complete();
      await h.internal.pendingBashMonitorWakeIdleWaitsByOwner.get(h.workspaceId);
      await h.reconciler.reconcile(h.workspaceId);
      expect(h.requests).toHaveLength(1);
      const history = await h.historyService.getHistoryFromLatestBoundary(h.workspaceId);
      expect(history.success && history.data.map((row) => row.role)).toEqual(["user", "assistant"]);
    } finally {
      await h.finish();
    }
  });

  test.each([false, true])(
    "owed monitor attention never cuts an active tool (native=%s)",
    async (providerExecuted) => {
      const h = await createActiveWakeHarness();
      try {
        expect(
          (await h.session.sendMessage("original", { model: h.model, agentId: "exec" })).success
        ).toBe(true);
        for (const offset of [10, 20, 30]) {
          h.aiEmitter.emit("tool-call-start", {
            type: "tool-call-start",
            workspaceId: h.workspaceId,
            messageId: "assistant-1",
            toolCallId: "held-tool",
            toolName: "bash",
            args: {},
            timestamp: Date.now(),
          });
          await h.addAttention(offset);
          expect((await h.reconciler.snapshot(h.workspaceId)).pendingWakeKinds.size).toBe(2);
          expect(h.dispatch).toHaveBeenCalled();
          expect(h.requests[0].hasQueuedMessages?.("tool-end")).toBe(false);
          h.aiEmitter.emit("tool-call-end", {
            type: "tool-call-end",
            workspaceId: h.workspaceId,
            messageId: "assistant-1",
            toolCallId: "held-tool",
            toolName: "bash",
            result: {},
            providerExecuted,
            timestamp: Date.now(),
          });
          expect(h.stopStream).not.toHaveBeenCalled();
          await h.consume(offset);
          expect(h.requests[0].hasQueuedMessages?.("tool-end")).toBe(false);
        }
        await h.complete();
        await h.internal.pendingBashMonitorWakeIdleWaitsByOwner.get(h.workspaceId);
        await h.reconciler.reconcile(h.workspaceId);
        expect(h.requests).toHaveLength(1);
        const history = await h.historyService.getHistoryFromLatestBoundary(h.workspaceId);
        expect(history.success && history.data.map((row) => row.role)).toEqual([
          "user",
          "assistant",
        ]);
        expect((await h.reconciler.snapshot(h.workspaceId)).pendingWakeKinds.size).toBe(0);
      } finally {
        await h.finish();
      }
    }
  );

  test("owed attention does not hold a delegated completion open or inherit its closed correlation", async () => {
    const h = await createActiveWakeHarness();
    const correlation = {
      type: "workspace-turn-task" as const,
      taskHandleId: "wst_turn",
      ownerWorkspaceId: "parent",
      turnId: "turn",
    };
    try {
      await h.session.sendMessage(
        "delegated",
        { model: h.model, agentId: "exec", muxMetadata: correlation },
        { synthetic: true, agentInitiated: true }
      );
      await h.addAttention(10);
      expect(h.service.hasPendingWorkspaceTurnContinuation(h.workspaceId, correlation)).toBe(false);
      expect(h.service.hasPendingBashMonitorWakeContinuation(h.workspaceId)).toBe(false);
      const next = new Promise<void>((resolve) => h.launched.once("start", resolve));
      await h.complete();
      await next;
      expect(h.requests).toHaveLength(2);
      expect(h.requests[0].muxMetadata).toEqual(correlation);
      expect(h.requests[1].muxMetadata).toBeUndefined();
    } finally {
      await h.finish();
    }
  });

  test("full context discard retires owed attention before the active turn becomes idle", async () => {
    const h = await createActiveWakeHarness();
    try {
      await h.session.sendMessage("original", { model: h.model, agentId: "exec" });
      await h.addAttention(10);
      const token = await h.reconciler.beginFullHistoryClear(h.workspaceId);
      await h.reconciler.finishFullHistoryClear(token);
      await h.complete();
      await h.internal.pendingBashMonitorWakeIdleWaitsByOwner.get(h.workspaceId);
      await h.reconciler.reconcile(h.workspaceId);
      expect(h.requests).toHaveLength(1);
      expect((await h.reconciler.snapshot(h.workspaceId)).pendingWakeKinds.size).toBe(0);
    } finally {
      await h.finish();
    }
  });

  test("hard Stop retires owed attention without disarming future idle wakes", async () => {
    const h = await createActiveWakeHarness();
    try {
      await h.session.sendMessage("original", { model: h.model, agentId: "exec" });
      await h.addAttention(10);
      spyOn(h.aiService, "stopStream").mockImplementation(async () => {
        h.abort("user");
        await h.session.waitForIdle();
        return Ok(undefined);
      });
      spyOn(h.aiService, "isStreaming").mockReturnValue(false);
      expect(
        (await h.service.interruptStream(h.workspaceId, { retireBashMonitorAttention: true }))
          .success
      ).toBe(true);
      await h.internal.pendingBashMonitorWakeIdleWaitsByOwner.get(h.workspaceId);
      await h.reconciler.reconcile(h.workspaceId);
      expect(h.requests).toHaveLength(1);
      expect((await h.reconciler.snapshot(h.workspaceId)).pendingWakeKinds.size).toBe(0);
      await h.addAttention(20);
      expect(h.requests).toHaveLength(2);
    } finally {
      await h.finish();
    }
  });

  test("hard Stop does not wait behind a wake admission holding the history lock", async () => {
    const h = await createActiveWakeHarness();
    try {
      await h.session.sendMessage("original", { model: h.model, agentId: "exec" });
      await h.addAttention(10);
      const release = createDeferred<void>();
      const locks = (
        h.service as unknown as {
          bashMonitorHistoryLocks: { withLock<T>(key: string, op: () => Promise<T>): Promise<T> };
        }
      ).bashMonitorHistoryLocks;
      const held = locks.withLock(h.workspaceId, () => release.promise);
      spyOn(h.aiService, "stopStream").mockImplementation(async () => {
        h.abort("user");
        await h.session.waitForIdle();
        return Ok(undefined);
      });
      spyOn(h.aiService, "isStreaming").mockReturnValue(false);
      expect(
        (await h.service.interruptStream(h.workspaceId, { retireBashMonitorAttention: true }))
          .success
      ).toBe(true);
      release.resolve();
      await held;
      await h.internal.pendingBashMonitorWakeIdleWaitsByOwner.get(h.workspaceId);
      await h.reconciler.reconcile(h.workspaceId);
      expect(h.requests).toHaveLength(1);
    } finally {
      await h.finish();
    }
  });

  test("a hard Stop whose retirement failed reports it and the retirement lands before any later wake", async () => {
    const h = await createActiveWakeHarness();
    try {
      await h.session.sendMessage("original", { model: h.model, agentId: "exec" });
      await h.addAttention(10);
      const reconcilerInternal = h.reconciler as unknown as {
        args: { registry: BashMonitorWakeReconcilerRegistry };
      };
      // Lazy rejection: the stop's I/O crosses a macrotask boundary before the retirement reads
      // the registry, and an eager mockRejectedValueOnce promise trips bun's unhandled-rejection
      // detector in that gap.
      spyOn(reconcilerInternal.args.registry, "listAll").mockImplementationOnce(() =>
        Promise.reject(new Error("transient registry read"))
      );
      spyOn(h.aiService, "stopStream").mockImplementation(async () => {
        h.abort("user");
        await h.session.waitForIdle();
        return Ok(undefined);
      });
      spyOn(h.aiService, "isStreaming").mockReturnValue(false);
      // The stream stopped, but the dismissal is only in memory, so the Stop reports it.
      expect(
        await h.service.interruptStream(h.workspaceId, { retireBashMonitorAttention: true })
      ).toEqual(Err(STOP_UNRECORDED_MESSAGE));
      expect(h.stopStream).toHaveBeenCalledTimes(1);
      await h.internal.pendingBashMonitorWakeIdleWaitsByOwner.get(h.workspaceId);
      await h.reconciler.reconcile(h.workspaceId);
      // The stop's idle reconcile retried the retirement instead of re-dispatching the output.
      expect(h.requests).toHaveLength(1);
      expect((await h.reconciler.snapshot(h.workspaceId)).pendingWakeKinds.size).toBe(0);
      await h.addAttention(20);
      expect(h.requests).toHaveLength(2);
    } finally {
      await h.finish();
    }
  });

  test("a failed hard Stop keeps owed attention for the idle wake", async () => {
    const h = await createActiveWakeHarness();
    try {
      await h.session.sendMessage("original", { model: h.model, agentId: "exec" });
      await h.addAttention(10);
      h.stopStream.mockResolvedValueOnce(Err("stop failed"));
      expect(
        (await h.service.interruptStream(h.workspaceId, { retireBashMonitorAttention: true }))
          .success
      ).toBe(false);
      expect((await h.reconciler.snapshot(h.workspaceId)).pendingWakeKinds.size).toBe(2);
      await h.complete();
      await h.internal.pendingBashMonitorWakeIdleWaitsByOwner.get(h.workspaceId);
      await h.reconciler.reconcile(h.workspaceId);
      expect(h.requests).toHaveLength(2);
    } finally {
      await h.finish();
    }
  });

  test("an interrupt without retireBashMonitorAttention keeps owed attention for the idle wake", async () => {
    const h = await createActiveWakeHarness();
    try {
      await h.session.sendMessage("original", { model: h.model, agentId: "exec" });
      await h.addAttention(10);
      spyOn(h.aiService, "stopStream").mockImplementation(async () => {
        h.abort("system");
        await h.session.waitForIdle();
        return Ok(undefined);
      });
      spyOn(h.aiService, "isStreaming").mockReturnValue(false);
      expect((await h.service.interruptStream(h.workspaceId)).success).toBe(true);
      await h.internal.pendingBashMonitorWakeIdleWaitsByOwner.get(h.workspaceId);
      await h.reconciler.reconcile(h.workspaceId);
      expect(h.requests).toHaveLength(2);
    } finally {
      await h.finish();
    }
  });

  test("a wake deferred as its idle wait hands off installs the next idle wait", async () => {
    const h = await createActiveWakeHarness();
    try {
      const internal = h.internal as typeof h.internal & {
        scheduleBashMonitorWakeReconcileAfterIdle(ownerWorkspaceId: string): void;
      };
      const waits = h.internal.pendingBashMonitorWakeIdleWaitsByOwner;
      internal.scheduleBashMonitorWakeReconcileAfterIdle(h.workspaceId);
      const handedOff = waits.get(h.workspaceId);
      let replacedDuringHandoff: boolean | undefined;
      spyOn(h.reconciler, "scheduleReconcile").mockImplementationOnce(() => {
        // A turn that started as the wait resolved defers the wake from inside the wait's own
        // hand-off; the finished wait must not swallow the re-arm as a duplicate.
        internal.scheduleBashMonitorWakeReconcileAfterIdle(h.workspaceId);
        replacedDuringHandoff = waits.get(h.workspaceId) !== handedOff;
      });
      await handedOff;
      expect(replacedDuringHandoff).toBe(true);
      await waits.get(h.workspaceId);
    } finally {
      await h.finish();
    }
  });

  test("hard Stop during a wake's acceptance window keeps the wake from streaming", async () => {
    const h = await createActiveWakeHarness();
    try {
      let stop: Promise<Result<void>> | undefined;
      const unsubscribe = h.session.onChatEvent(({ message: event }) => {
        // The wake's user row is emitted past the point of no return and before PREPARING.
        if (event.type === "message" && event.role === "user" && stop == null) {
          stop = h.service.interruptStream(h.workspaceId, { retireBashMonitorAttention: true });
        }
      });
      await h.addAttention(10);
      unsubscribe();
      expect(stop).toBeDefined();
      expect((await stop!).success).toBe(true);
      expect(h.requests).toHaveLength(0);
      expect(h.session.isBusy()).toBe(false);
      expect((await h.reconciler.snapshot(h.workspaceId)).pendingWakeKinds.size).toBe(0);
      await h.addAttention(20);
      expect(h.requests).toHaveLength(1);
    } finally {
      await h.finish();
    }
  });

  test("a Stop that disables auto-retry interrupts the stream without waiting on the opt-out write", async () => {
    const h = await createActiveWakeHarness();
    const release = createDeferred<void>();
    try {
      await h.session.sendMessage("original", { model: h.model, agentId: "exec" });
      const stopStream = spyOn(h.aiService, "stopStream").mockImplementation(async () => {
        h.abort("user");
        await h.session.waitForIdle();
        return Ok(undefined);
      });
      const optOut = h.session.setAutoRetryEnabled.bind(h.session);
      spyOn(h.session, "setAutoRetryEnabled").mockImplementation(async (enabled, options) => {
        await release.promise;
        return optOut(enabled, options);
      });
      const stop = h.service.interruptStream(h.workspaceId, {
        retireBashMonitorAttention: true,
        disableAutoRetry: true,
      });
      // The abort reaches the stream while the preference write is still pending.
      await waitForCondition(() => stopStream.mock.calls.length === 1);
      let stopSettled = false;
      void stop.then(() => {
        stopSettled = true;
      });
      await new Promise((resolve) => setTimeout(resolve, 20));
      expect(stopSettled).toBe(false);
      release.resolve();
      expect((await stop).success).toBe(true);
    } finally {
      release.resolve();
      await h.finish();
    }
  });

  test("a Stop that disables auto-retry withdraws the wake before releasing the retry gate", async () => {
    const h = await createActiveWakeHarness();
    try {
      let wakeWithdrawnAtOptOut: boolean | undefined;
      const optOut = h.session.setAutoRetryEnabled.bind(h.session);
      spyOn(h.session, "setAutoRetryEnabled").mockImplementation(async (enabled, options) => {
        // The opt-out releases the idle gate a pending wake waits behind; retirement must already
        // have withdrawn the wake's dispatch by then.
        wakeWithdrawnAtOptOut = h.dispatch.mock.calls[0]?.[0].cancelSignal.aborted;
        return optOut(enabled, options);
      });
      let stop: Promise<Result<void>> | undefined;
      const unsubscribe = h.session.onChatEvent(({ message: event }) => {
        if (event.type === "message" && event.role === "user" && stop == null) {
          stop = h.service.interruptStream(h.workspaceId, {
            retireBashMonitorAttention: true,
            disableAutoRetry: true,
          });
        }
      });
      await h.addAttention(10);
      unsubscribe();
      expect((await stop!).success).toBe(true);
      expect(wakeWithdrawnAtOptOut).toBe(true);
      expect(h.requests).toHaveLength(0);
      const sessionInternal = h.session as unknown as { getAutoRetryPreferencePath(): string };
      const persisted = JSON.parse(
        await fsPromises.readFile(sessionInternal.getAutoRetryPreferencePath(), "utf-8")
      ) as { enabled?: boolean };
      expect(persisted.enabled).toBe(false);
    } finally {
      await h.finish();
    }
  });

  test("hard Stop during a wake's acceptance window is acknowledged only once the wake's abandon marker is durable", async () => {
    const h = await createActiveWakeHarness();
    const release = createDeferred<void>();
    try {
      const sessionInternal = h.session as unknown as {
        persistAutoRetryState(): Promise<void>;
        getAutoRetryPreferencePath(): string;
      };
      const persist = sessionInternal.persistAutoRetryState.bind(h.session);
      const persisting = createDeferred<void>();
      spyOn(sessionInternal, "persistAutoRetryState").mockImplementation(async () => {
        persisting.resolve();
        await release.promise;
        return persist();
      });
      let stop: Promise<Result<void>> | undefined;
      const unsubscribe = h.session.onChatEvent(({ message: event }) => {
        if (event.type === "message" && event.role === "user" && stop == null) {
          stop = h.service.interruptStream(h.workspaceId, { retireBashMonitorAttention: true });
        }
      });
      const attention = h.addAttention(10);
      await persisting.promise;
      unsubscribe();
      let stopSettled = false;
      void stop!.then(() => {
        stopSettled = true;
      });
      // Retirement has consumed the signals; Stop still waits for the withdrawn send's marker.
      expect((await h.reconciler.snapshot(h.workspaceId)).pendingWakeKinds.size).toBe(0);
      await new Promise((resolve) => setTimeout(resolve, 20));
      expect(stopSettled).toBe(false);
      release.resolve();
      expect((await stop!).success).toBe(true);
      await attention;
      const persisted = JSON.parse(
        await fsPromises.readFile(sessionInternal.getAutoRetryPreferencePath(), "utf-8")
      ) as { startupAutoRetryAbandon?: { reason: string; userMessageId?: string } };
      expect(persisted.startupAutoRetryAbandon?.reason).toBe("aborted");
      expect(persisted.startupAutoRetryAbandon?.userMessageId).toBeDefined();
      expect(h.requests).toHaveLength(0);
    } finally {
      release.resolve();
      await h.finish();
    }
  });

  test("hard Stop during a wake's acceptance window fails until the withdrawn wake's abandon marker is written", async () => {
    const h = await createActiveWakeHarness();
    try {
      const sessionInternal = h.session as unknown as { getAutoRetryPreferencePath(): string };
      const preferencePath = sessionInternal.getAutoRetryPreferencePath();
      // A directory at the preference path makes the marker write fail (EISDIR).
      await fsPromises.mkdir(preferencePath, { recursive: true });
      let stop: Promise<Result<void>> | undefined;
      const unsubscribe = h.session.onChatEvent(({ message: event }) => {
        if (event.type === "message" && event.role === "user" && stop == null) {
          stop = h.service.interruptStream(h.workspaceId, { retireBashMonitorAttention: true });
        }
      });
      await h.addAttention(10);
      unsubscribe();
      expect(stop).toBeDefined();
      expect(await stop!).toEqual(Err(STOP_UNRECORDED_MESSAGE));
      expect(h.requests).toHaveLength(0);
      expect(h.session.isBusy()).toBe(false);
      // The obligation outlives the joined send: a later Stop retries the write once it can succeed.
      await fsPromises.rmdir(preferencePath);
      expect(
        (await h.service.interruptStream(h.workspaceId, { retireBashMonitorAttention: true }))
          .success
      ).toBe(true);
      const persisted = JSON.parse(await fsPromises.readFile(preferencePath, "utf-8")) as {
        startupAutoRetryAbandon?: { reason: string; userMessageId?: string };
      };
      expect(persisted.startupAutoRetryAbandon?.reason).toBe("aborted");
      expect(persisted.startupAutoRetryAbandon?.userMessageId).toBeDefined();
    } finally {
      await h.finish();
    }
  });

  test("output arriving while a hard Stop waits behind a wake's acceptance stays owed", async () => {
    const h = await createActiveWakeHarness();
    const release = createDeferred<void>();
    try {
      const acknowledging = createDeferred<void>();
      const reconcilerInternal = h.reconciler as unknown as {
        args: { processManager: BashMonitorWakeReconcilerProcessManager };
      };
      spyOn(reconcilerInternal.args.processManager, "acknowledgeMonitorWake").mockImplementation(
        async () => {
          acknowledging.resolve();
          await release.promise;
        }
      );
      const attention = h.addAttention(10);
      await acknowledging.promise;
      // Acceptance holds the reconciler lock; the Stop snapshots the frontier (10) on entry and waits.
      const stop = h.service.interruptStream(h.workspaceId, { retireBashMonitorAttention: true });
      const later = h.addAttention(20);
      release.resolve();
      expect((await stop).success).toBe(true);
      await Promise.all([attention, later]);
      // Only the frontier the Stop saw was retired; the newer output woke the idle agent.
      expect(h.requests).toHaveLength(1);
    } finally {
      release.resolve();
      await h.finish();
    }
  });

  test.each([
    ["the failing goal sync", "goal-sync"],
    ["the acceptance I/O owed after a failed goal sync", "acceptance"],
  ] as const)(
    "hard Stop during %s records the abandon marker for the withdrawn wake",
    async (_, at) => {
      let stop: Promise<Result<void>> | undefined;
      const requestStop = () => {
        stop ??= h.service.interruptStream(h.workspaceId, { retireBashMonitorAttention: true });
      };
      const h = await createActiveWakeHarness({
        workspaceGoalService: {
          assertPricedModelForBudgetedGoal: () => Promise.resolve(Ok(undefined)),
          recordStreamStarted: () => undefined,
          // Goal sync runs past the point of no return and fails; the failure path still awaits
          // acceptance, so Stop can land during either await.
          syncGoalModeWithChatTail: () => {
            if (at === "goal-sync") requestStop();
            return Promise.reject(new Error("goal sync failed"));
          },
        } as unknown as WorkspaceGoalService,
      });
      if (at === "acceptance") {
        spyOn(h.backgroundProcessManager, "acknowledgeMonitorWake").mockImplementation(requestStop);
      }
      try {
        await h.addAttention(10);
        expect(stop).toBeDefined();
        expect((await stop!).success).toBe(true);
        const sessionInternal = h.session as unknown as { getAutoRetryPreferencePath(): string };
        const persisted = JSON.parse(
          await fsPromises.readFile(sessionInternal.getAutoRetryPreferencePath(), "utf-8")
        ) as { startupAutoRetryAbandon?: { reason: string; userMessageId?: string } };
        const history = await h.historyService.getHistoryFromLatestBoundary(h.workspaceId);
        const wakeRow = history.success
          ? history.data.filter((row) => row.role === "user").at(-1)
          : undefined;
        expect(wakeRow).toBeDefined();
        expect(persisted.startupAutoRetryAbandon).toEqual({
          reason: "aborted",
          userMessageId: wakeRow!.id,
        });
        expect((await h.reconciler.snapshot(h.workspaceId)).pendingWakeKinds.size).toBe(0);
        expect(h.requests).toHaveLength(0);
      } finally {
        await h.finish();
      }
    }
  );

  test.each(["options", "pricing"] as const)(
    "wake yields when a turn starts during %s admission",
    async (gate) => {
      const h = await createActiveWakeHarness();
      const entered = createDeferred<void>();
      const release = createDeferred<void>();
      const options = { model: h.model, agentId: "exec" };
      if (gate === "options") {
        spyOn(h.internal, "getDelegatedTurnContinuationSendOptions").mockImplementationOnce(
          async () => {
            entered.resolve();
            await release.promise;
            return options;
          }
        );
      } else {
        const internal = h.service as unknown as {
          assertPricedModelForBudgetedGoal(): Promise<Result<void, SendMessageError>>;
        };
        spyOn(internal, "assertPricedModelForBudgetedGoal").mockImplementationOnce(async () => {
          entered.resolve();
          await release.promise;
          return Ok(undefined);
        });
      }
      try {
        const attention = h.addAttention(10);
        await entered.promise;
        await h.session.sendMessage("original", options);
        release.resolve();
        await attention;
        expect(h.requests).toHaveLength(1);
        expect(h.requests[0].hasQueuedMessages?.("tool-end")).toBe(false);
        await h.consume(10);
        await h.complete();
        await h.reconciler.reconcile(h.workspaceId);
        expect(h.requests).toHaveLength(1);
      } finally {
        release.resolve();
        await h.finish();
      }
    }
  );

  test("unconsumed attention coalesces after natural completion and idle attention starts promptly", async () => {
    const h = await createActiveWakeHarness();
    try {
      await h.session.sendMessage("original", { model: h.model, agentId: "exec" });
      await h.addAttention(10);
      await h.reconciler.reconcile(h.workspaceId);
      expect(h.requests).toHaveLength(1);
      const next = new Promise<void>((resolve) => h.launched.once("start", resolve));
      await h.complete();
      await next;
      expect(h.requests).toHaveLength(2);
      await h.reconciler.reconcile(h.workspaceId);
      expect((await h.reconciler.snapshot(h.workspaceId)).pendingWakeKinds.size).toBe(0);
      await h.complete();
      await h.addAttention(20);
      expect(h.requests).toHaveLength(3);
    } finally {
      await h.finish();
    }
  });

  test.each([false, true])(
    "manual tool-end input takes precedence over owed bash attention (native=%s)",
    async (providerExecuted) => {
      const h = await createActiveWakeHarness();
      try {
        await h.session.sendMessage("original", { model: h.model, agentId: "exec" });
        await h.addAttention(10);
        expect(
          (
            await h.service.sendMessage(h.workspaceId, "manual", {
              model: h.model,
              agentId: "exec",
              queueDispatchMode: "tool-end",
            })
          ).success
        ).toBe(true);
        expect(h.requests[0].hasQueuedMessages?.("tool-end")).toBe(true);
        h.aiEmitter.emit("tool-call-end", {
          type: "tool-call-end",
          workspaceId: h.workspaceId,
          messageId: "assistant-1",
          toolCallId: "tool",
          toolName: "bash",
          result: {},
          providerExecuted,
          timestamp: Date.now(),
        });
        expect(h.stopStream).toHaveBeenCalledTimes(providerExecuted ? 1 : 0);
        await h.consume(10);
        const next = new Promise<void>((resolve) => h.launched.once("start", resolve));
        if (providerExecuted) {
          h.abort("system");
        } else {
          await h.complete("tool-calls");
        }
        await next;
        expect(h.requests).toHaveLength(2);
        const history = await h.historyService.getHistoryFromLatestBoundary(h.workspaceId);
        expect(
          history.success &&
            history.data.filter((row) => row.role === "user").map((row) => row.parts[0])
        ).toEqual([
          expect.objectContaining({ type: "text", text: "original" }),
          expect.objectContaining({ type: "text", text: "manual" }),
        ]);
      } finally {
        await h.finish();
      }
    }
  );

  test("monitor lifecycle and shown-output events poke the reconciler", async () => {
    const { service, events, cleanup } = await createWakeWiringService();
    const scheduleReconcile = mock(() => undefined);
    const discardProcess = mock(() => Promise.resolve());
    const upsert = mock(() => Promise.resolve());
    const remove = mock(() => Promise.resolve());
    const recordTerminal = mock(() => Promise.resolve());
    const internal = service as unknown as {
      bashMonitorRecoveryPromise: Promise<void>;
      bashMonitorWakeReconciler: {
        scheduleReconcile: typeof scheduleReconcile;
        discardProcess: typeof discardProcess;
      };
      bashMonitorRegistryStore: {
        upsert: typeof upsert;
        remove: typeof remove;
        recordTerminal: typeof recordTerminal;
      };
    };
    try {
      await internal.bashMonitorRecoveryPromise;
      internal.bashMonitorWakeReconciler = { scheduleReconcile, discardProcess };
      internal.bashMonitorRegistryStore = { upsert, remove, recordTerminal };
      const armed = {
        processId: "proc",
        taskId: "bash:proc",
        workspaceId: "owner",
        filter: "READY",
        filterExclude: false,
        script: "run",
        createdAt: "2026-08-31T12:00:00.000Z",
      };
      events.emit("monitor:match", "owner", {});
      events.emit("output:shown", "owner", {});
      events.emit("monitor:armed", "owner", armed);
      events.emit("monitor:stopped", "owner", {
        processId: "proc",
        reason: "canceled",
        armMetadata: armed,
      });
      for (let attempt = 0; attempt < 10 && scheduleReconcile.mock.calls.length < 4; attempt++) {
        await Promise.resolve();
      }

      expect(upsert).toHaveBeenCalledWith(armed);
      expect(discardProcess).toHaveBeenCalledWith("owner", "proc", armed.createdAt);
      expect(remove).toHaveBeenCalledWith("owner", "proc", armed.createdAt);
      expect(scheduleReconcile).toHaveBeenCalledTimes(4);
    } finally {
      await cleanup();
    }
  });

  test("workspace removal drain waits for armed and failed-monitor registry writes", async () => {
    const { service, events, cleanup } = await createWakeWiringService();
    let releaseArmed: (() => void) | undefined;
    let releaseLost: (() => void) | undefined;
    const armedGate = new Promise<void>((resolve) => {
      releaseArmed = resolve;
    });
    const lostGate = new Promise<void>((resolve) => {
      releaseLost = resolve;
    });
    const upsert = mock((payload: { processId: string }) =>
      payload.processId === "armed-proc" ? armedGate : Promise.resolve()
    );
    const recordLost = mock(() => lostGate);
    const internal = service as unknown as {
      bashMonitorRecoveryPromise: Promise<void>;
      bashMonitorWakeReconciler: { scheduleReconcile(workspaceId: string): void };
      bashMonitorRegistryStore: {
        upsert: typeof upsert;
        recordTerminal(): Promise<void>;
        recordLost: typeof recordLost;
      };
      drainBashMonitorPersistence(workspaceId: string): Promise<void>;
    };
    try {
      await internal.bashMonitorRecoveryPromise;
      internal.bashMonitorWakeReconciler = { scheduleReconcile: () => undefined };
      internal.bashMonitorRegistryStore = {
        upsert,
        recordTerminal: () => Promise.resolve(),
        recordLost,
      };
      const armed = {
        processId: "armed-proc",
        taskId: "bash:armed-proc",
        workspaceId: "owner",
        filter: "READY",
        filterExclude: false,
        script: "run",
        createdAt: "2026-09-01T00:01:00.000Z",
      };
      events.emit("monitor:armed", "owner", armed);
      let armedDrained = false;
      const armedDrain = internal.drainBashMonitorPersistence("owner").then(() => {
        armedDrained = true;
      });
      await Promise.resolve();
      expect(armedDrained).toBe(false);
      releaseArmed?.();
      await armedDrain;

      const failed = { ...armed, processId: "failed-proc", taskId: "bash:failed-proc" };
      events.emit("monitor:stopped", "owner", {
        processId: failed.processId,
        reason: "failed",
        armMetadata: failed,
        failureMessage: "transport unavailable",
      });
      for (let attempt = 0; attempt < 20 && recordLost.mock.calls.length === 0; attempt++) {
        await new Promise((resolve) => setTimeout(resolve, 5));
      }
      let failureDrained = false;
      const failureDrain = internal.drainBashMonitorPersistence("owner").then(() => {
        failureDrained = true;
      });
      await Promise.resolve();
      expect(failureDrained).toBe(false);
      releaseLost?.();
      await failureDrain;
    } finally {
      await cleanup();
    }
  });

  test("runtime failure recreates missing registry evidence from arm metadata", async () => {
    const { service, events, cleanup } = await createWakeWiringService();
    const scheduleReconcile = mock(() => undefined);
    const internal = service as unknown as {
      bashMonitorRecoveryPromise: Promise<void>;
      bashMonitorWakeReconciler: { scheduleReconcile: typeof scheduleReconcile };
      bashMonitorRegistryStore: {
        listAll(workspaceId: string): Promise<
          Array<{
            processId: string;
            lost?: {
              reason: "runtime-failure";
              failureMessage?: string;
              failedOperations?: string[];
              failedMatch?: { lines: string[] };
            };
          }>
        >;
      };
    };
    try {
      await internal.bashMonitorRecoveryPromise;
      internal.bashMonitorWakeReconciler = { scheduleReconcile };
      const armMetadata = {
        processId: "failed-proc",
        taskId: "bash:failed-proc",
        workspaceId: "owner",
        filter: "READY",
        filterExclude: false,
        script: "run",
        createdAt: "2026-08-31T12:00:00.000Z",
      };

      events.emit("monitor:stopped", "owner", {
        processId: "failed-proc",
        reason: "failed",
        armMetadata,
        failureMessage: "transport unavailable",
        failedOperations: ["readOutput"],
        failedMatch: {
          lines: ["READY before failure"],
          totalMatches: 1,
          droppedLines: 0,
          matchedThroughOffset: 12,
        },
      });

      let rows = await internal.bashMonitorRegistryStore.listAll("owner");
      for (let attempt = 0; attempt < 20 && rows.length === 0; attempt++) {
        await new Promise((resolve) => setTimeout(resolve, 10));
        rows = await internal.bashMonitorRegistryStore.listAll("owner");
      }
      expect(rows).toHaveLength(1);
      expect(rows[0]).toMatchObject({
        processId: "failed-proc",
        lost: {
          reason: "runtime-failure",
          failureMessage: "transport unavailable",
          failedOperations: ["readOutput"],
          failedMatch: { lines: ["READY before failure"] },
        },
      });
      expect(scheduleReconcile).toHaveBeenCalledWith("owner");
    } finally {
      await cleanup();
    }
  });

  test("runtime failure persistence retries before scheduling its wake", async () => {
    const { service, events, cleanup } = await createWakeWiringService();
    const scheduleReconcile = mock(() => undefined);
    const upsert = mock(() => Promise.resolve());
    let lostAttempts = 0;
    const recordLost = mock(() => {
      lostAttempts++;
      return lostAttempts === 1
        ? Promise.reject(new Error("transient registry write failure"))
        : Promise.resolve();
    });
    const internal = service as unknown as {
      bashMonitorRecoveryPromise: Promise<void>;
      bashMonitorWakeReconciler: { scheduleReconcile: typeof scheduleReconcile };
      bashMonitorRegistryStore: {
        upsert: typeof upsert;
        recordTerminal(): Promise<void>;
        recordLost: typeof recordLost;
      };
    };
    try {
      await internal.bashMonitorRecoveryPromise;
      internal.bashMonitorWakeReconciler = { scheduleReconcile };
      internal.bashMonitorRegistryStore = {
        upsert,
        recordTerminal: () => Promise.resolve(),
        recordLost,
      };
      const armMetadata = {
        processId: "retry-failed-proc",
        taskId: "bash:retry-failed-proc",
        workspaceId: "owner",
        filter: "READY",
        filterExclude: false,
        script: "run",
        createdAt: "2026-08-31T12:14:00.000Z",
      };

      events.emit("monitor:stopped", "owner", {
        processId: armMetadata.processId,
        reason: "failed",
        armMetadata,
        failureMessage: "transport unavailable",
      });
      for (let attempt = 0; attempt < 40 && scheduleReconcile.mock.calls.length === 0; attempt++) {
        await new Promise((resolve) => setTimeout(resolve, 10));
      }

      expect(recordLost).toHaveBeenCalledTimes(2);
      expect(scheduleReconcile).toHaveBeenCalledWith("owner");
    } finally {
      await cleanup();
    }
  });

  test("cancellation invalidates a scheduled runtime failure persistence retry", async () => {
    const { service, events, cleanup } = await createWakeWiringService();
    const scheduleReconcile = mock(() => undefined);
    const discardProcess = mock(() => Promise.resolve());
    const upsert = mock(() => Promise.resolve());
    const remove = mock(() => Promise.resolve());
    const recordLost = mock(() => Promise.reject(new Error("transient registry write failure")));
    const internal = service as unknown as {
      bashMonitorRecoveryPromise: Promise<void>;
      bashMonitorWakeReconciler: {
        scheduleReconcile: typeof scheduleReconcile;
        discardProcess: typeof discardProcess;
      };
      bashMonitorRegistryStore: {
        upsert: typeof upsert;
        remove: typeof remove;
        recordTerminal(): Promise<void>;
        recordLost: typeof recordLost;
      };
    };
    try {
      await internal.bashMonitorRecoveryPromise;
      internal.bashMonitorWakeReconciler = { scheduleReconcile, discardProcess };
      internal.bashMonitorRegistryStore = {
        upsert,
        remove,
        recordTerminal: () => Promise.resolve(),
        recordLost,
      };
      const armMetadata = {
        processId: "canceled-retry-proc",
        taskId: "bash:canceled-retry-proc",
        workspaceId: "owner",
        filter: "READY",
        filterExclude: false,
        script: "run",
        createdAt: "2026-08-31T12:15:00.000Z",
      };
      events.emit("monitor:stopped", "owner", {
        processId: armMetadata.processId,
        reason: "failed",
        armMetadata,
        failureMessage: "transport unavailable",
      });
      for (let attempt = 0; attempt < 20 && recordLost.mock.calls.length === 0; attempt++) {
        await new Promise((resolve) => setTimeout(resolve, 5));
      }

      events.emit("monitor:stopped", "owner", {
        processId: armMetadata.processId,
        reason: "canceled",
        armMetadata,
      });
      await new Promise((resolve) => setTimeout(resolve, 300));

      expect(recordLost).toHaveBeenCalledTimes(1);
      expect(upsert).toHaveBeenCalledTimes(1);
      expect(remove).toHaveBeenCalledWith("owner", armMetadata.processId, armMetadata.createdAt);
      expect(discardProcess).toHaveBeenCalledWith(
        "owner",
        armMetadata.processId,
        armMetadata.createdAt
      );
      // The invalidated chain must also release its tracking entry so the
      // per-process failure-persist map stays bounded by in-flight chains.
      const tracking = (
        service as unknown as { activeBashMonitorFailurePersists: Map<string, unknown> }
      ).activeBashMonitorFailurePersists;
      expect(tracking.size).toBe(0);
    } finally {
      await cleanup();
    }
  });

  test("late monitor pokes are ignored after removal begins", async () => {
    const { service, cleanup } = await createWakeWiringService();
    const scheduleReconcile = mock(() => undefined);
    const internal = service as unknown as {
      removingWorkspaces: Set<string>;
      bashMonitorWakeReconciler: { scheduleReconcile: typeof scheduleReconcile };
      scheduleBashMonitorWakeReconcile(workspaceId: string): void;
    };
    try {
      internal.bashMonitorWakeReconciler = { scheduleReconcile };
      internal.removingWorkspaces.add("removed-owner");

      internal.scheduleBashMonitorWakeReconcile("removed-owner");

      expect(scheduleReconcile).not.toHaveBeenCalled();
    } finally {
      await cleanup();
    }
  });

  test("full clears preconsume and postconsume wakes while truncations leave them alone", async () => {
    const { service, cleanup } = await createWakeWiringService();
    const order: string[] = [];
    const internal = service as unknown as {
      bashMonitorRecoveryPromise: Promise<void>;
      bashMonitorWakeReconciler: {
        beginFullHistoryClear(workspaceId: string): Promise<{ ownerWorkspaceId: string }>;
        finishFullHistoryClear(token: { ownerWorkspaceId: string }): Promise<void>;
      };
      clearHistoryWithRetiredBashMonitorWakes<T>(
        workspaceId: string,
        clear: () => Promise<Result<T>>,
        options?: { discardUnacceptedOnSuccess?: boolean }
      ): Promise<Result<T>>;
    };
    try {
      await internal.bashMonitorRecoveryPromise;
      internal.bashMonitorWakeReconciler = {
        beginFullHistoryClear: (workspaceId) => {
          order.push("pre");
          return Promise.resolve({ ownerWorkspaceId: workspaceId });
        },
        finishFullHistoryClear: () => {
          order.push("post");
          return Promise.resolve();
        },
      };
      const truncate = await internal.clearHistoryWithRetiredBashMonitorWakes(
        "owner",
        () => {
          order.push("truncate");
          return Promise.resolve(Ok(undefined));
        },
        { discardUnacceptedOnSuccess: false }
      );
      expect(truncate.success).toBe(true);
      expect(order).toEqual(["truncate"]);

      const clear = await internal.clearHistoryWithRetiredBashMonitorWakes(
        "owner",
        () => {
          order.push("clear");
          return Promise.resolve(Ok(undefined));
        },
        { discardUnacceptedOnSuccess: true }
      );
      expect(clear.success).toBe(true);
      expect(order).toEqual(["truncate", "pre", "clear", "post"]);
    } finally {
      await cleanup();
    }
  });

  test("startup schedules reconciliation only for pre-construction registry rows", async () => {
    const { service, cleanup } = await createWakeWiringService();
    const scheduleReconcile = mock(() => undefined);
    const internal = service as unknown as {
      constructedAtMs: number;
      bashMonitorWakeReconciler: { scheduleReconcile: typeof scheduleReconcile };
      bashMonitorRegistryStore: {
        listOwnerWorkspaceIds(): Promise<{ ownerWorkspaceIds: string[]; scanFailed: boolean }>;
        listAll(workspaceId: string): Promise<Array<{ createdAt: string }>>;
      };
      recoverBashMonitorStateAfterRestart(): Promise<void>;
    };
    try {
      internal.constructedAtMs = Date.parse("2026-08-31T12:00:00.000Z");
      internal.bashMonitorWakeReconciler = { scheduleReconcile };
      internal.bashMonitorRegistryStore = {
        listOwnerWorkspaceIds: () =>
          Promise.resolve({
            ownerWorkspaceIds: ["old", "new", "invalid"],
            scanFailed: false,
          }),
        listAll: (workspaceId) =>
          Promise.resolve([
            {
              createdAt:
                workspaceId === "old"
                  ? "2026-08-31T11:59:00.000Z"
                  : workspaceId === "invalid"
                    ? "not-a-date"
                    : "2026-08-31T12:01:00.000Z",
            },
          ]),
      };

      await internal.recoverBashMonitorStateAfterRestart();
      expect(scheduleReconcile).toHaveBeenCalledTimes(2);
      expect(scheduleReconcile).toHaveBeenCalledWith("old");
      expect(scheduleReconcile).toHaveBeenCalledWith("invalid");
    } finally {
      await cleanup();
    }
  });

  test("startup retries a partial registry scan before scheduling reconciliation", async () => {
    const { service, cleanup } = await createWakeWiringService();
    const scheduleReconcile = mock(() => undefined);
    let scans = 0;
    const internal = service as unknown as {
      constructedAtMs: number;
      bashMonitorWakeReconciler: { scheduleReconcile: typeof scheduleReconcile };
      bashMonitorRegistryStore: {
        listOwnerWorkspaceIds(): Promise<{ ownerWorkspaceIds: string[]; scanFailed: boolean }>;
        listAll(workspaceId: string): Promise<Array<{ createdAt: string }>>;
      };
      recoverBashMonitorStateAfterRestart(): Promise<void>;
    };
    try {
      internal.constructedAtMs = Date.parse("2026-08-31T12:00:00.000Z");
      internal.bashMonitorWakeReconciler = { scheduleReconcile };
      internal.bashMonitorRegistryStore = {
        listOwnerWorkspaceIds: () => {
          scans++;
          return Promise.resolve({ ownerWorkspaceIds: ["owner"], scanFailed: scans === 1 });
        },
        listAll: () =>
          scans === 1
            ? Promise.reject(new Error("transient owner scan failure"))
            : Promise.resolve([{ createdAt: "2026-08-31T11:59:00.000Z" }]),
      };

      await internal.recoverBashMonitorStateAfterRestart();

      expect(scans).toBe(2);
      expect(scheduleReconcile).toHaveBeenCalledWith("owner");
    } finally {
      await cleanup();
    }
  });

  test("busy owners defer reconciliation without queueing a synthetic turn", async () => {
    const { config, service, cleanup } = await createWakeWiringService();
    const workspaceId = "busy-wake-owner";
    await config.addWorkspace("/tmp/busy-wake-project", {
      id: workspaceId,
      name: workspaceId,
      projectName: "busy-wake-project",
      projectPath: "/tmp/busy-wake-project",
      runtimeConfig: { type: "local" },
    });
    const afterIdle = mock(() => undefined);
    const onAccepted = mock(() => Promise.resolve());
    const onDeferred = mock(() => Promise.resolve());
    const internal = service as unknown as {
      hasPendingQueuedOrPreparingTurn(workspaceId: string): boolean;
      scheduleBashMonitorWakeReconcileAfterIdle(workspaceId: string): void;
      dispatchBashMonitorWake(dispatch: {
        ownerWorkspaceId: string;
        prompt: string;
        muxMetadata: { type: "bash-monitor-wake"; records: [] };
        cancelSignal: AbortSignal;
        onAccepted(): Promise<void>;
        onDeferred(): Promise<void>;
      }): Promise<"in-flight" | "deferred">;
    };
    try {
      internal.hasPendingQueuedOrPreparingTurn = () => true;
      internal.scheduleBashMonitorWakeReconcileAfterIdle = afterIdle;
      const outcome = await internal.dispatchBashMonitorWake({
        ownerWorkspaceId: workspaceId,
        prompt: "wake",
        muxMetadata: { type: "bash-monitor-wake", records: [] },
        cancelSignal: new AbortController().signal,
        onAccepted,
        onDeferred,
      });
      expect(outcome).toBe("deferred");
      expect(afterIdle).toHaveBeenCalledWith(workspaceId);
      expect(onAccepted).not.toHaveBeenCalled();
    } finally {
      await cleanup();
    }
  });

  test("active session-backed streams defer monitor attention until idle", async () => {
    const { config, service, cleanup } = await createWakeWiringService();
    const workspaceId = "streaming-wake-owner";
    await config.addWorkspace("/tmp/streaming-wake-project", {
      id: workspaceId,
      name: workspaceId,
      projectName: "streaming-wake-project",
      projectPath: "/tmp/streaming-wake-project",
      runtimeConfig: { type: "local" },
    });
    const sendMessage = mock(() => Promise.resolve(Ok(undefined)));
    const afterIdle = mock(() => undefined);
    const internal = service as unknown as {
      aiService: { isStreaming(workspaceId: string): boolean };
      hasPendingQueuedOrPreparingTurn(workspaceId: string): boolean;
      scheduleBashMonitorWakeReconcileAfterIdle(workspaceId: string): void;
      getDelegatedTurnContinuationSendOptions(workspaceId: string): Promise<object>;
      sendMessage: typeof sendMessage;
      dispatchBashMonitorWake(dispatch: {
        ownerWorkspaceId: string;
        prompt: string;
        muxMetadata: { type: "bash-monitor-wake"; records: [] };
        cancelSignal: AbortSignal;
        onAccepted(): Promise<void>;
        onDeferred(): Promise<void>;
      }): Promise<"in-flight" | "deferred">;
    };
    try {
      spyOn(service.getOrCreateSession(workspaceId), "isBusy").mockReturnValue(true);
      internal.aiService = { isStreaming: () => true };
      internal.hasPendingQueuedOrPreparingTurn = () => false;
      internal.scheduleBashMonitorWakeReconcileAfterIdle = afterIdle;
      internal.getDelegatedTurnContinuationSendOptions = () => Promise.resolve({});
      internal.sendMessage = sendMessage;

      const outcome = await internal.dispatchBashMonitorWake({
        ownerWorkspaceId: workspaceId,
        prompt: "wake",
        muxMetadata: { type: "bash-monitor-wake", records: [] },
        cancelSignal: new AbortController().signal,
        onAccepted: () => Promise.resolve(),
        onDeferred: () => Promise.resolve(),
      });

      expect(outcome).toBe("deferred");
      expect(sendMessage).not.toHaveBeenCalled();
      expect(afterIdle).toHaveBeenCalledWith(workspaceId);
    } finally {
      await cleanup();
    }
  });

  test("pending mid-stream compaction defers monitor attention like an active turn", async () => {
    const { config, service, cleanup } = await createWakeWiringService();
    const workspaceId = "compacting-wake-owner";
    await config.addWorkspace("/tmp/compacting-wake-project", {
      id: workspaceId,
      name: workspaceId,
      projectName: "compacting-wake-project",
      projectPath: "/tmp/compacting-wake-project",
      runtimeConfig: { type: "local" },
    });
    const sendMessage = mock(() => Promise.resolve(Ok(undefined)));
    const afterIdle = mock(() => undefined);
    const internal = service as unknown as {
      scheduleBashMonitorWakeReconcileAfterIdle(workspaceId: string): void;
      getDelegatedTurnContinuationSendOptions(workspaceId: string): Promise<object>;
      sendMessage: typeof sendMessage;
      dispatchBashMonitorWake(dispatch: {
        ownerWorkspaceId: string;
        prompt: string;
        muxMetadata: { type: "bash-monitor-wake"; records: [] };
        cancelSignal: AbortSignal;
        onAccepted(): Promise<void>;
        onDeferred(): Promise<void>;
      }): Promise<"in-flight" | "deferred">;
    };
    try {
      // Between the stopped stream and its compaction request the coordinator is idle and no
      // stream is running; only the session's pending flag marks the turn work.
      const session = service.getOrCreateSession(workspaceId);
      const { coordinator } = session as unknown as { coordinator: TurnCoordinator };
      const token = coordinator.beginCompactionObservation("legacy");
      if (token == null) throw new Error("Expected compaction observation");
      coordinator.setCompactionStage(token, "stopping");
      internal.scheduleBashMonitorWakeReconcileAfterIdle = afterIdle;
      internal.getDelegatedTurnContinuationSendOptions = () => Promise.resolve({});
      internal.sendMessage = sendMessage;

      const outcome = await internal.dispatchBashMonitorWake({
        ownerWorkspaceId: workspaceId,
        prompt: "wake",
        muxMetadata: { type: "bash-monitor-wake", records: [] },
        cancelSignal: new AbortController().signal,
        onAccepted: () => Promise.resolve(),
        onDeferred: () => Promise.resolve(),
      });

      expect(outcome).toBe("deferred");
      expect(sendMessage).not.toHaveBeenCalled();
      expect(afterIdle).toHaveBeenCalledWith(workspaceId);
    } finally {
      await cleanup();
    }
  });

  test("withdrawn idle wake rolls back admission and permits a fresh delivery", async () => {
    const h = await createActiveWakeHarness();
    const entered = createDeferred<void>();
    const release = createDeferred<void>();
    const append = h.historyService.appendToHistory.bind(h.historyService);
    spyOn(h.historyService, "appendToHistory").mockImplementationOnce(async (...args) => {
      entered.resolve();
      await release.promise;
      return append(...args);
    });
    const controller = new AbortController();
    const accepted = mock(() => Promise.resolve());
    const deferred = mock(() => Promise.resolve());
    const send = (cancelSignal: AbortSignal) =>
      h.internal.dispatchBashMonitorWake({
        ownerWorkspaceId: h.workspaceId,
        prompt: "wake",
        muxMetadata: { type: "bash-monitor-wake", records: [] },
        cancelSignal,
        onAccepted: accepted,
        onDeferred: deferred,
      });
    try {
      const dispatch = send(controller.signal);
      await entered.promise;
      controller.abort();
      release.resolve();
      await dispatch;
      expect(accepted).not.toHaveBeenCalled();
      expect(deferred).toHaveBeenCalledTimes(1);
      expect(h.requests).toHaveLength(0);
      expect(h.session.hasQueuedMessages()).toBe(false);
      const history = await h.historyService.getHistoryFromLatestBoundary(h.workspaceId);
      expect(history.success && history.data).toEqual([]);
      await send(new AbortController().signal);
      expect(h.requests).toHaveLength(1);
      expect(accepted).toHaveBeenCalledTimes(1);
    } finally {
      release.resolve();
      await h.finish();
    }
  });

  test("superseding queued sub-agent progress skips its continuation-failure callbacks", async () => {
    const { config, service, cleanup } = await createWakeWiringService();
    const workspaceId = "superseded-progress-owner";
    await config.addWorkspace("/tmp/superseded-progress-project", {
      id: workspaceId,
      name: workspaceId,
      projectName: "superseded-progress-project",
      projectPath: "/tmp/superseded-progress-project",
      runtimeConfig: { type: "local" },
    });
    const session = service.getOrCreateSession(workspaceId);
    const options: SendMessageOptions = { model: "gpt-4", agentId: "exec" };
    try {
      // A progress report queued into an owner that runs as a delegated turn carries callbacks
      // that settle that turn as interrupted; supersession by the terminal report must not fire them.
      const progressCanceled = mock(() => undefined);
      const wakeCanceled = mock(() => undefined);
      expect(
        session.queueMessage("progress", options, {
          synthetic: true,
          agentInitiated: true,
          dedupeKey: "agent-report:child:wst_1:call-1",
          removableDedupeKey: true,
          onCanceled: progressCanceled,
        })
      ).toBe("tool-end");
      expect(
        session.queueMessage("wake", options, {
          synthetic: true,
          agentInitiated: true,
          dedupeKey: "bash-monitor-wake:owner:1",
          removableDedupeKey: true,
          onCanceled: wakeCanceled,
        })
      ).toBe("tool-end");

      expect(
        service.removeQueuedMessagesByDedupeKeyPrefix(workspaceId, "agent-report:child:wst_1:", {
          cancelReason: "superseded",
          skipCancelCallbacks: true,
        })
      ).toEqual(Ok(1));
      // Withdrawal (the default) still notifies, so wake bookkeeping keeps working.
      expect(
        service.removeQueuedMessagesByDedupeKeyPrefix(workspaceId, "bash-monitor-wake:", {
          cancelReason: "withdrawn",
        })
      ).toEqual(Ok(1));
      await new Promise((resolve) => setTimeout(resolve, 0));

      expect(progressCanceled).not.toHaveBeenCalled();
      expect(wakeCanceled).toHaveBeenCalledWith("withdrawn");
      expect(session.hasQueuedMessages()).toBe(false);
    } finally {
      await cleanup();
    }
  });
});

async function setWorkspaceGoalOk(
  goalService: WorkspaceGoalService,
  input: Parameters<WorkspaceGoalService["setGoal"]>[0]
): Promise<GoalRecordV1> {
  const result = await goalService.setGoal(input);
  expect(result.success).toBe(true);
  if (!result.success) {
    throw new Error(`Expected goal set to succeed, got ${JSON.stringify(result.error)}`);
  }
  return result.data;
}

function createFrontendWorkspaceMetadata(
  overrides: Partial<FrontendWorkspaceMetadata> & Pick<FrontendWorkspaceMetadata, "id" | "name">
): FrontendWorkspaceMetadata {
  return {
    ...overrides,
    id: overrides.id,
    name: overrides.name,
    projectName: overrides.projectName ?? "project",
    projectPath: overrides.projectPath ?? "/tmp/project",
    createdAt: overrides.createdAt ?? new Date().toISOString(),
    runtimeConfig: overrides.runtimeConfig ?? { type: "local" },
    namedWorkspacePath: overrides.namedWorkspacePath ?? `/tmp/${overrides.id}`,
  };
}

describe("WorkspaceService.stageAttachment", () => {
  test("waits for workspace init before writing into the workspace", async () => {
    const { config, historyService, cleanup } = await createTestHistoryService();
    const workspaceId = "stage-attachment-init";
    // Local runtime resolves the execution path to the project dir itself.
    const projectPath = path.join(config.rootDir, "project");
    const workspacePath = projectPath;
    try {
      await fsPromises.mkdir(workspacePath, { recursive: true });
      await config.addWorkspace(projectPath, {
        id: workspaceId,
        name: "stage-attachment-init",
        projectName: "project",
        projectPath,
        runtimeConfig: { type: "local" },
        namedWorkspacePath: workspacePath,
      });

      let releaseInit: () => void = () => undefined;
      const initGate = new Promise<void>((resolve) => {
        releaseInit = resolve;
      });
      let barrierReached: () => void = () => undefined;
      const barrierReachedGate = new Promise<void>((resolve) => {
        barrierReached = resolve;
      });
      const waitForInit = mock(() => {
        barrierReached();
        return initGate;
      });
      const workspaceService = createWorkspaceServiceForTest({
        config,
        historyService,
        initStateManager: {
          ...mockInitStateManager,
          waitForInit,
        } as unknown as InitStateManager,
      });

      const stagePromise = workspaceService.stageAttachment({
        workspaceId,
        filename: "notes.md",
        mediaType: "text/markdown",
        sizeBytes: 8,
        dataBase64: Buffer.from("markdown").toString("base64"),
      });

      // Staging must block on the init barrier before any workspace write.
      await barrierReachedGate;
      expect(waitForInit).toHaveBeenCalledWith(workspaceId);
      const entriesBeforeInit = await fsPromises.readdir(workspacePath);
      expect(entriesBeforeInit).toEqual([]);

      releaseInit();
      const result = await stagePromise;
      expect(result.success).toBe(true);
      if (!result.success) throw new Error(result.error);
      await fsPromises.access(path.join(workspacePath, result.data.stagedPath));
    } finally {
      await cleanup();
    }
  });
});

describe("WorkspaceService.setActiveTurnThinkingLevel", () => {
  test("returns accepted:false when the workspace has no session", () => {
    const workspaceService = createWorkspaceServiceForTest({ config: {} });
    // No session was ever created for this workspace: nothing is running, so
    // the mid-turn override is a no-op and persisted settings cover the next turn.
    const result = workspaceService.setActiveTurnThinkingLevel("unknown-workspace", "high");
    expect(result).toEqual(Ok({ accepted: false }));
  });
});

describe("WorkspaceService workflow activity", () => {
  test("caches active workflow run counts and updates emitted activity from status events", async () => {
    const { config, historyService, cleanup } = await createTestHistoryService();
    const listStatusSnapshotsSpy = spyOn(WorkflowRunStore.prototype, "listRunStatusSnapshots");
    try {
      const workspaceId = "workflow-activity";
      const projectPath = path.join(config.rootDir, "project");
      await config.addWorkspace(projectPath, {
        id: workspaceId,
        name: "workflow-activity",
        projectName: "project",
        projectPath,
        createdAt: "2026-06-17T00:00:00.000Z",
        runtimeConfig: { type: "local" },
      });
      const extensionMetadata = new ExtensionMetadataService(
        path.join(config.rootDir, "extensionMetadata.json")
      );
      const workspaceService = createWorkspaceServiceForTest({
        config,
        historyService,
        extensionMetadata,
      });
      const runStore = new WorkflowRunStore({
        sessionDir: path.join(config.sessionsDir, workspaceId),
      });
      const definition = {
        name: "demo",
        description: "Demo workflow",
        scope: "global" as const,
        executable: true,
      };
      await runStore.createRun({
        id: "wfr_active",
        workspaceId,
        workflow: definition,
        source: "export default function workflow() { return {}; }",
        args: {},
        now: "2026-06-17T00:00:00.000Z",
      });
      await runStore.createRun({
        id: "wfr_nested",
        workspaceId,
        workflow: definition,
        source: "export default function workflow() { return {}; }",
        args: {},
        parentWorkflow: { runId: "wfr_active", stepId: "child", inputHash: "hash", depth: 0 },
        now: "2026-06-17T00:00:01.000Z",
      });

      expect(
        (await workspaceService.getActivityList())?.[workspaceId]?.activeWorkflowRunIds
      ).toEqual(["wfr_active"]);
      expect(
        (await workspaceService.getActivityList())?.[workspaceId]?.activeWorkflowRunCount
      ).toBe(1);
      expect(
        (await workspaceService.getActivityList())?.[workspaceId]?.activeWorkflowRunCount
      ).toBe(1);
      expect(listStatusSnapshotsSpy).toHaveBeenCalledTimes(1);

      const activityEvents: Array<{
        workspaceId: string;
        activity: WorkspaceActivitySnapshot | null;
      }> = [];
      workspaceService.on("activity", (event) => activityEvents.push(event));
      await workspaceService.emitWorkflowRunActivity({
        workspaceId,
        runId: "wfr_active",
        status: "completed",
      });
      expect(activityEvents.at(-1)?.activity?.activeWorkflowRunIds).toBeUndefined();
      expect(activityEvents.at(-1)?.activity?.activeWorkflowRunCount).toBeUndefined();

      const clearedActivityList = await workspaceService.getActivityList();
      expect(clearedActivityList?.[workspaceId]).toBeDefined();
      expect(clearedActivityList?.[workspaceId]?.activeWorkflowRunCount).toBeUndefined();

      await workspaceService.emitWorkflowRunActivity({
        workspaceId,
        runId: "wfr_next",
        status: "running",
      });
      expect(activityEvents.at(-1)?.activity?.activeWorkflowRunIds).toEqual(["wfr_next"]);
      expect(activityEvents.at(-1)?.activity?.activeWorkflowRunCount).toBe(1);
      await workspaceService.updateAgentStatus(workspaceId, {
        emoji: "🔄",
        message: "Still running workflow",
      });
      expect(activityEvents.at(-1)?.activity?.activeWorkflowRunCount).toBe(1);

      workspaceService.emitWorkspaceActivity(workspaceId, {
        recency: Date.now(),
        streaming: false,
        lastModel: null,
        lastThinkingLevel: null,
      });
      expect(activityEvents.at(-1)?.activity?.activeWorkflowRunCount).toBe(1);

      expect(listStatusSnapshotsSpy).toHaveBeenCalledTimes(1);
    } finally {
      listStatusSnapshotsSpy.mockRestore();
      await cleanup();
    }
  });

  test("shares initial active workflow cache bootstrap across parallel status events", async () => {
    const { config, historyService, cleanup } = await createTestHistoryService();
    const scanStarted = createDeferred<void>();
    const releaseScan = createDeferred<void>();
    const listStatusSnapshotsSpy = spyOn(
      WorkflowRunStore.prototype,
      "listRunStatusSnapshots"
    ).mockImplementation(async () => {
      scanStarted.resolve();
      await releaseScan.promise;
      return [];
    });

    try {
      const workspaceId = "workflow-activity-race";
      // getActivityList only emits entries for config-known workspaces.
      const projectPath = path.join(config.rootDir, "project");
      await config.addWorkspace(projectPath, {
        id: workspaceId,
        name: workspaceId,
        projectName: "project",
        projectPath,
        runtimeConfig: { type: "local" },
      });
      const workspaceService = createWorkspaceServiceForTest({
        config,
        historyService,
        extensionMetadata: new ExtensionMetadataService(
          path.join(config.rootDir, "extensionMetadata.json")
        ),
      });
      const activityEvents: Array<{
        workspaceId: string;
        activity: WorkspaceActivitySnapshot | null;
      }> = [];
      workspaceService.on("activity", (event) => activityEvents.push(event));

      const first = workspaceService.emitWorkflowRunActivity({
        workspaceId,
        runId: "wfr_first",
        status: "running",
      });
      await scanStarted.promise;
      const second = workspaceService.emitWorkflowRunActivity({
        workspaceId,
        runId: "wfr_second",
        status: "running",
      });

      releaseScan.resolve();
      await Promise.all([first, second]);

      expect(listStatusSnapshotsSpy).toHaveBeenCalledTimes(1);
      expect(activityEvents.at(-1)?.activity?.activeWorkflowRunCount).toBe(2);
      expect(
        (await workspaceService.getActivityList())?.[workspaceId]?.activeWorkflowRunCount
      ).toBe(2);
    } finally {
      listStatusSnapshotsSpy.mockRestore();
      releaseScan.resolve();
      await cleanup();
    }
  });

  test("emits current workflow count after overlapping metadata snapshot reads", async () => {
    const { config, historyService, cleanup } = await createTestHistoryService();
    const firstSnapshotStarted = createDeferred<void>();
    const releaseFirstSnapshot = createDeferred<void>();
    const extensionMetadata = new ExtensionMetadataService(
      path.join(config.rootDir, "extensionMetadata.json")
    );
    const getSnapshotSpy = spyOn(extensionMetadata, "getSnapshot");

    try {
      const workspaceId = "workflow-activity-overlap";
      // getActivityList only emits entries for config-known workspaces; keep
      // this workspace known so the zero-count assertion below exercises the
      // tombstone path rather than trivially missing the entry.
      const projectPath = path.join(config.rootDir, "project");
      await config.addWorkspace(projectPath, {
        id: workspaceId,
        name: workspaceId,
        projectName: "project",
        projectPath,
        runtimeConfig: { type: "local" },
      });
      const workspaceService = createWorkspaceServiceForTest({
        config,
        historyService,
        extensionMetadata,
      });
      await workspaceService.emitWorkflowRunActivity({
        workspaceId,
        runId: "wfr_first",
        status: "running",
      });
      await workspaceService.emitWorkflowRunActivity({
        workspaceId,
        runId: "wfr_second",
        status: "running",
      });

      let shouldDelayNextSnapshot = true;
      getSnapshotSpy.mockImplementation(async (id: string) => {
        if (shouldDelayNextSnapshot) {
          shouldDelayNextSnapshot = false;
          firstSnapshotStarted.resolve();
          await releaseFirstSnapshot.promise;
        }
        return ExtensionMetadataService.prototype.getSnapshot.call(extensionMetadata, id);
      });
      const activityEvents: Array<{
        workspaceId: string;
        activity: WorkspaceActivitySnapshot | null;
      }> = [];
      workspaceService.on("activity", (event) => activityEvents.push(event));

      const first = workspaceService.emitWorkflowRunActivity({
        workspaceId,
        runId: "wfr_first",
        status: "completed",
      });
      await firstSnapshotStarted.promise;
      const second = workspaceService.emitWorkflowRunActivity({
        workspaceId,
        runId: "wfr_second",
        status: "completed",
      });

      await second;
      releaseFirstSnapshot.resolve();
      await first;

      expect(activityEvents.at(-1)?.activity?.activeWorkflowRunCount).toBeUndefined();
      expect(
        (await workspaceService.getActivityList())?.[workspaceId]?.activeWorkflowRunCount
      ).toBeUndefined();
    } finally {
      getSnapshotSpy.mockRestore();
      releaseFirstSnapshot.resolve();
      await cleanup();
    }
  });
});

describe("WorkspaceService activity list scoping", () => {
  test("drops stale extension metadata entries and lazily prunes them once", async () => {
    const { config, historyService, cleanup } = await createTestHistoryService();
    try {
      const workspaceId = "activity-scoping-known";
      const projectPath = path.join(config.rootDir, "project");
      await config.addWorkspace(projectPath, {
        id: workspaceId,
        name: workspaceId,
        projectName: "project",
        projectPath,
        runtimeConfig: { type: "local" },
      });
      const extensionMetadata = new ExtensionMetadataService(
        path.join(config.rootDir, "extensionMetadata.json")
      );
      await extensionMetadata.updateRecency(workspaceId, 100);
      // Simulates the leaked entry of a removed workspace/sub-agent.
      await extensionMetadata.updateRecency("removed-workspace", 200);
      const pruneSpy = spyOn(extensionMetadata, "pruneMissingWorkspaces");
      const workspaceService = createWorkspaceServiceForTest({
        config,
        historyService,
        extensionMetadata,
      });

      const activityList = await workspaceService.getActivityList();
      expect(activityList).not.toBeNull();
      expect(activityList?.[workspaceId]?.recency).toBe(100);
      expect(activityList?.["removed-workspace"]).toBeUndefined();

      // The one-time lazy cleanup dropped the stale entry from disk while
      // keeping the still-existing workspace's entry.
      const snapshots = await extensionMetadata.getAllSnapshots();
      expect(snapshots.has("removed-workspace")).toBe(false);
      expect(snapshots.get(workspaceId)?.recency).toBe(100);

      // One-time: a second bootstrap must not re-run the cleanup scan.
      await workspaceService.getActivityList();
      expect(pruneSpy).toHaveBeenCalledTimes(1);
    } finally {
      await cleanup();
    }
  });

  test("repeat lists keep omitting idle workspaces after the first list installs caches", async () => {
    // The first list's workflow probe installs an empty run cache for every
    // scoped id. Cache initialization must not read as activity: treating it
    // as the zero-count tombstone signal would emit a fabricated recency:0
    // entry for every idle config-known workspace from the second list on,
    // re-bloating exactly the payload this scoping trims.
    const { config, historyService, cleanup } = await createTestHistoryService();
    try {
      const workspaceId = "activity-scoping-idle";
      const projectPath = path.join(config.rootDir, "project");
      await config.addWorkspace(projectPath, {
        id: workspaceId,
        name: workspaceId,
        projectName: "project",
        projectPath,
        runtimeConfig: { type: "local" },
      });
      const extensionMetadata = new ExtensionMetadataService(
        path.join(config.rootDir, "extensionMetadata.json")
      );
      const workspaceService = createWorkspaceServiceForTest({
        config,
        historyService,
        extensionMetadata,
      });

      const firstList = await workspaceService.getActivityList();
      expect(firstList).not.toBeNull();
      expect(firstList?.[workspaceId]).toBeUndefined();
      const secondList = await workspaceService.getActivityList();
      expect(secondList).not.toBeNull();
      expect(secondList?.[workspaceId]).toBeUndefined();
    } finally {
      await cleanup();
    }
  });

  test("a run-status event racing cache eviction does not strand the seen marker", async () => {
    // An eviction (removal, or a tombstone lifted for revival) can land in
    // the microtask gap after the run cache resolves. The status event must
    // retry against the freshly installed cache instead of mutating the
    // detached set and marking the seen set — a stale marker would fabricate
    // zero-count entries for the idle revived workspace on every later list.
    const { config, historyService, cleanup } = await createTestHistoryService();
    try {
      const workspaceId = "evict-race";
      const projectPath = path.join(config.rootDir, "project");
      await config.addWorkspace(projectPath, {
        id: workspaceId,
        name: workspaceId,
        projectName: "project",
        projectPath,
        runtimeConfig: { type: "local" },
      });
      const extensionMetadata = new ExtensionMetadataService(
        path.join(config.rootDir, "extensionMetadata.json")
      );
      const workspaceService = createWorkspaceServiceForTest({
        config,
        historyService,
        extensionMetadata,
      });
      const internals = workspaceService as unknown as {
        getActiveWorkflowRunIds(workspaceId: string): Promise<Set<string>>;
        evictWorkspaceActivityCaches(workspaceId: string): void;
      };
      const realGetActiveWorkflowRunIds = internals.getActiveWorkflowRunIds.bind(workspaceService);
      let evicted = false;
      internals.getActiveWorkflowRunIds = async (targetWorkspaceId: string) => {
        const result = await realGetActiveWorkflowRunIds(targetWorkspaceId);
        if (!evicted && targetWorkspaceId === workspaceId) {
          evicted = true;
          // Lands after the cache read resolved, before the caller's
          // continuation — the exact revival-eviction window.
          internals.evictWorkspaceActivityCaches(targetWorkspaceId);
        }
        return result;
      };

      await workspaceService.emitWorkflowRunActivity({
        workspaceId,
        runId: "wfr_race",
        status: "running",
      });
      const activity = (await workspaceService.getActivityList())?.[workspaceId];
      // The retried update must land the run in the INSTALLED cache (not a
      // detached pre-eviction set that leaves only the stale seen marker).
      expect(activity?.activeWorkflowRunCount).toBe(1);
    } finally {
      await cleanup();
    }
  });

  test("getActivityList re-establishes the config baseline after a transient initial read failure", async () => {
    // The pre-await baseline read can fail transiently while the strict
    // scoping enumeration succeeds. Without a replacement baseline both
    // cross-process removal guards stay disabled on an authoritative
    // response: a workspace another backend deregisters during the workflow
    // probes (its metadata entry still present in the normal cleanup gap)
    // would ride back into the renderer with no event to correct it.
    const { config, historyService, cleanup } = await createTestHistoryService();
    const listStatusSnapshotsSpy = spyOn(WorkflowRunStore.prototype, "listRunStatusSnapshots");
    try {
      const workspaceId = "baseline-retry";
      const projectPath = path.join(config.rootDir, "project");
      await config.addWorkspace(projectPath, {
        id: workspaceId,
        name: workspaceId,
        projectName: "project",
        projectPath,
        runtimeConfig: { type: "local" },
      });
      const extensionMetadata = new ExtensionMetadataService(
        path.join(config.rootDir, "extensionMetadata.json")
      );
      await extensionMetadata.updateRecency(workspaceId, 321);
      const realSuperset = config.readPersistedWorkspaceIdSuperset.bind(config);
      let failedOnce = false;
      const supersetSpy = spyOn(config, "readPersistedWorkspaceIdSuperset").mockImplementation(
        () => {
          if (!failedOnce) {
            failedOnce = true;
            throw new Error("transient config read failure");
          }
          return realSuperset();
        }
      );
      let removedFromConfig = false;
      listStatusSnapshotsSpy.mockImplementation(async () => {
        if (!removedFromConfig) {
          removedFromConfig = true;
          // Another backend deregisters the workspace while the per-id
          // probe awaits; its metadata entry intentionally stays behind.
          const configPath = path.join(config.rootDir, "config.json");
          const parsed = JSON.parse(await fsPromises.readFile(configPath, "utf-8")) as {
            projects?: Array<[string, { workspaces?: Array<{ id?: string }> }]>;
          };
          for (const [, projectConfig] of parsed.projects ?? []) {
            projectConfig.workspaces = (projectConfig.workspaces ?? []).filter(
              (workspace) => workspace.id !== workspaceId
            );
          }
          await fsPromises.writeFile(configPath, JSON.stringify(parsed));
        }
        return [];
      });
      try {
        const workspaceService = createWorkspaceServiceForTest({
          config,
          historyService,
          extensionMetadata,
        });
        const activityList = await workspaceService.getActivityList();
        expect(activityList).not.toBeNull();
        expect(activityList?.[workspaceId]).toBeUndefined();
      } finally {
        supersetSpy.mockRestore();
      }
    } finally {
      listStatusSnapshotsSpy.mockRestore();
      await cleanup();
    }
  });

  test("prune spares both legacy identities when compatibility files disagree", async () => {
    // An id-less legacy entry can have BOTH supported session layouts with
    // different stable ids (stale basename-side file + live generated-legacy
    // metadata). findWorkspace resolves either id, so the one-time prune must
    // spare extension-metadata entries under both — classifying the second
    // identity as stale would delete activity findWorkspace still vouches
    // for.
    const { config, historyService, cleanup } = await createTestHistoryService();
    try {
      const projectPath = path.join(config.rootDir, "project");
      const workspacePath = path.join(projectPath, "old-ws");
      await fsPromises.writeFile(
        path.join(config.rootDir, "config.json"),
        JSON.stringify({ projects: [[projectPath, { workspaces: [{ path: workspacePath }] }]] })
      );
      const basenameSessionDir = path.join(config.sessionsDir, "old-ws");
      await fsPromises.mkdir(basenameSessionDir, { recursive: true });
      await fsPromises.writeFile(
        path.join(basenameSessionDir, "metadata.json"),
        JSON.stringify({ id: "basename-stable-id", name: "old-ws" })
      );
      const legacySessionDir = path.join(
        config.sessionsDir,
        config.generateLegacyId(projectPath, workspacePath)
      );
      await fsPromises.mkdir(legacySessionDir, { recursive: true });
      await fsPromises.writeFile(
        path.join(legacySessionDir, "metadata.json"),
        JSON.stringify({ id: "generated-live-id", name: "old-ws" })
      );
      const extensionMetadata = new ExtensionMetadataService(
        path.join(config.rootDir, "extensionMetadata.json")
      );
      await extensionMetadata.updateRecency("basename-stable-id", 100);
      await extensionMetadata.updateRecency("generated-live-id", 200);
      await extensionMetadata.updateRecency("truly-stale-id", 300);
      const workspaceService = createWorkspaceServiceForTest({
        config,
        historyService,
        extensionMetadata,
      });

      const activityList = await workspaceService.getActivityList();
      expect(activityList).not.toBeNull();

      const snapshots = await extensionMetadata.getAllSnapshots();
      expect(snapshots.get("basename-stable-id")?.recency).toBe(100);
      expect(snapshots.get("generated-live-id")?.recency).toBe(200);
      expect(snapshots.has("truly-stale-id")).toBe(false);
    } finally {
      await cleanup();
    }
  });

  test("getActivityList fails closed when no raw baseline can be established", async () => {
    // If every raw baseline read fails transiently while the strict scoping
    // enumeration succeeds, both cross-process removal guards would stay
    // disabled on a response the renderer applies as authoritative — a
    // workspace another backend deregisters during the probes would ride
    // back with no event to correct it. The list must fail (null → renderer
    // keeps last-known state and retries) instead of serving guardless
    // authoritative data; only the fail-open scope (config unreadable) may
    // do that, and there the enumeration fails too.
    const { config, historyService, cleanup } = await createTestHistoryService();
    try {
      const workspaceId = "baseline-unavailable";
      const projectPath = path.join(config.rootDir, "project");
      await config.addWorkspace(projectPath, {
        id: workspaceId,
        name: workspaceId,
        projectName: "project",
        projectPath,
        runtimeConfig: { type: "local" },
      });
      const extensionMetadata = new ExtensionMetadataService(
        path.join(config.rootDir, "extensionMetadata.json")
      );
      await extensionMetadata.updateRecency(workspaceId, 111);
      const supersetSpy = spyOn(config, "readPersistedWorkspaceIdSuperset").mockImplementation(
        () => {
          throw new Error("persistent raw read failure");
        }
      );
      try {
        const workspaceService = createWorkspaceServiceForTest({
          config,
          historyService,
          extensionMetadata,
        });
        expect(await workspaceService.getActivityList()).toBeNull();
      } finally {
        supersetSpy.mockRestore();
      }
    } finally {
      await cleanup();
    }
  });

  test("first prune also removes stale entries stranded in a sidecar", async () => {
    // Crash strands the full snapshot in .corrupt while a valid partial main
    // was recreated. The one-time prune must reconcile FIRST: sidecar-only
    // stale entries would otherwise dodge the deletion set and merge back on
    // the very next read — with the prune latched, they would keep inflating
    // every read and rewrite until restart.
    const { config, historyService, cleanup } = await createTestHistoryService();
    try {
      const workspaceId = "sidecar-live";
      const projectPath = path.join(config.rootDir, "project");
      await config.addWorkspace(projectPath, {
        id: workspaceId,
        name: workspaceId,
        projectName: "project",
        projectPath,
        runtimeConfig: { type: "local" },
      });
      const metadataPath = path.join(config.rootDir, "extensionMetadata.json");
      await fsPromises.writeFile(
        metadataPath,
        JSON.stringify({
          version: 1,
          workspaces: { [workspaceId]: { recency: 100, streaming: false } },
        })
      );
      await fsPromises.writeFile(
        `${metadataPath}.corrupt`,
        JSON.stringify({
          version: 1,
          workspaces: {
            [workspaceId]: { recency: 90, streaming: false },
            "sidecar-stale": { recency: 80, streaming: false },
          },
        })
      );
      const extensionMetadata = new ExtensionMetadataService(metadataPath);
      const workspaceService = createWorkspaceServiceForTest({
        config,
        historyService,
        extensionMetadata,
      });

      const activityList = await workspaceService.getActivityList();
      expect(activityList).not.toBeNull();
      expect(activityList?.["sidecar-stale"]).toBeUndefined();

      const snapshots = await extensionMetadata.getAllSnapshots({ throwOnError: true });
      expect(snapshots.get(workspaceId)?.recency).toBe(100);
      expect(snapshots.has("sidecar-stale")).toBe(false);
    } finally {
      await cleanup();
    }
  });

  test("late-admitted raw-registered ids keep their initial snapshot when re-reads fail", async () => {
    // A raw-registered entry outside the normalized scope (invalid project
    // path) is admitted through the raw config view. When both mid-list
    // snapshot re-reads fail transiently, the already-loaded initial
    // snapshot must still supply its recency/goal/status — an authoritative
    // response omitting the entry would clear that renderer state with no
    // repair event.
    const { config, historyService, cleanup } = await createTestHistoryService();
    try {
      const workspaceId = "raw-only-live";
      const projectPath = path.join(config.rootDir, "project");
      // Migration flags pre-seeded: without them the first load schedules an
      // async settings-migration persist that rewrites config.json through
      // the parsed view mid-test whenever it happens to land before the
      // second list's raw reads (observed flake).
      await fsPromises.writeFile(
        path.join(config.rootDir, "config.json"),
        JSON.stringify({
          projects: [
            [
              projectPath,
              { workspaces: [{ id: workspaceId, path: path.join(projectPath, "ws") }] },
            ],
          ],
          taskSettings: { preserveSubagentsUntilArchive: true },
          migrations: { persistentSubagentsDefaulted: true, defaultModelFallbacksSeeded: true },
        })
      );
      // Raw-visible but enumeration-invisible: the strict normalized
      // enumeration resolves no ids while the raw persisted view carries the
      // inline id, keeping it out of the per-id scope so it takes the
      // late-candidate path. (Strict loads now reject the previously used
      // malformed-project-key vehicle, so divergence is modeled directly.)
      const enumerateSpy = spyOn(config, "getAllWorkspaceMetadata").mockResolvedValue([]);
      const extensionMetadata = new ExtensionMetadataService(
        path.join(config.rootDir, "extensionMetadata.json")
      );
      await extensionMetadata.updateRecency(workspaceId, 42);
      const realGetAllSnapshots = extensionMetadata.getAllSnapshots.bind(extensionMetadata);
      let snapshotCalls = 0;
      const snapshotsSpy = spyOn(extensionMetadata, "getAllSnapshots").mockImplementation(
        async (options?: { throwOnError?: boolean }) => {
          snapshotCalls += 1;
          // List #1 (prune latch): initial + fresh reads stay real. List #2:
          // the initial read (call 3) succeeds; the fresh and final re-reads
          // fail transiently.
          if (snapshotCalls > 3) {
            throw new Error("transient snapshot re-read failure");
          }
          return realGetAllSnapshots(options);
        }
      );
      try {
        const workspaceService = createWorkspaceServiceForTest({
          config,
          historyService,
          extensionMetadata,
        });
        const firstList = await workspaceService.getActivityList();
        expect(firstList?.[workspaceId]?.recency).toBe(42);

        const secondList = await workspaceService.getActivityList();
        expect(secondList).not.toBeNull();
        expect(secondList?.[workspaceId]?.recency).toBe(42);
      } finally {
        snapshotsSpy.mockRestore();
        enumerateSpy.mockRestore();
      }
    } finally {
      await cleanup();
    }
  });

  test("mid-list enumeration proves removal when the raw refresh fails", async () => {
    // An inline-id workspace is removed by another backend while the
    // mid-list authoritative enumeration awaits, and the post-enumeration
    // raw refresh fails transiently. The raw comparison is disabled (fresh
    // view null) and the id sits in the initial baseline, so without the
    // enumeration fallback every removal guard passes and the stale entry
    // rides the authoritative response with no event to repair the
    // renderer.
    const { config, historyService, cleanup } = await createTestHistoryService();
    try {
      const workspaceId = "inline-removed-mid-enum";
      const projectPath = path.join(config.rootDir, "project");
      const configPath = path.join(config.rootDir, "config.json");
      await fsPromises.writeFile(
        configPath,
        JSON.stringify({
          projects: [
            [
              projectPath,
              {
                workspaces: [
                  { id: workspaceId, path: path.join(projectPath, "ws") },
                  // Id-less legacy entry whose stable id lives in session
                  // metadata.json: raw-INVISIBLE at the initial baseline, so
                  // its retained entry forces the mid-list authoritative
                  // enumeration this test exercises (the read-time migration
                  // may persist the id later, but the baseline predates it).
                  { path: path.join(projectPath, "legacy-ws") },
                ],
              },
            ],
          ],
          // Migration flags pre-seeded: without them the first load schedules
          // an async settings-migration persist that rewrites config.json
          // through the parsed view — attaching the resolved legacy id inline
          // — which would make this entry raw-VISIBLE mid-test and skip the
          // mid-list enumeration whenever the persist lands first.
          taskSettings: { preserveSubagentsUntilArchive: true },
          migrations: { persistentSubagentsDefaulted: true, defaultModelFallbacksSeeded: true },
        })
      );
      const legacyStableId = "legacy-stable-mid-enum";
      const legacySessionDir = path.join(config.sessionsDir, "legacy-ws");
      await fsPromises.mkdir(legacySessionDir, { recursive: true });
      await fsPromises.writeFile(
        path.join(legacySessionDir, "metadata.json"),
        JSON.stringify({ id: legacyStableId, name: "legacy-ws" })
      );
      const extensionMetadata = new ExtensionMetadataService(
        path.join(config.rootDir, "extensionMetadata.json")
      );
      await extensionMetadata.updateRecency(workspaceId, 77);
      await extensionMetadata.updateRecency(legacyStableId, 55);
      const realEnumerate = config.getAllWorkspaceMetadata.bind(config);
      let enumerationCalls = 0;
      let failEvidenceReads = false;
      const enumerationSpy = spyOn(config, "getAllWorkspaceMetadata").mockImplementation(
        async (options?: Parameters<typeof realEnumerate>[0]) => {
          enumerationCalls += 1;
          if (enumerationCalls === 2) {
            // Mid-list enumeration: another backend deregisters the inline-id
            // workspace just before the config read, and every later raw
            // view read fails transiently.
            const parsed = JSON.parse(await fsPromises.readFile(configPath, "utf-8")) as {
              projects: Array<[string, { workspaces: Array<{ id?: string }> }]>;
            };
            for (const [, projectConfig] of parsed.projects) {
              projectConfig.workspaces = projectConfig.workspaces.filter(
                (workspace) => workspace.id !== workspaceId
              );
            }
            await fsPromises.writeFile(configPath, JSON.stringify(parsed));
            const result = await realEnumerate(options);
            failEvidenceReads = true;
            return result;
          }
          return realEnumerate(options);
        }
      );
      const realEvidence = config.readPersistedWorkspaceIdEvidence.bind(config);
      const evidenceSpy = spyOn(config, "readPersistedWorkspaceIdEvidence").mockImplementation(
        () => {
          if (failEvidenceReads) {
            throw new Error("transient raw config read failure");
          }
          return realEvidence();
        }
      );
      try {
        const workspaceService = createWorkspaceServiceForTest({
          config,
          historyService,
          extensionMetadata,
        });
        const activityList = await workspaceService.getActivityList();
        expect(activityList).not.toBeNull();
        // The still-registered raw-invisible entry survives the fallback...
        expect(activityList?.[legacyStableId]?.recency).toBe(55);
        // ...while the enumeration-proven removal is dropped.
        expect(activityList?.[workspaceId]).toBeUndefined();
      } finally {
        enumerationSpy.mockRestore();
        evidenceSpy.mockRestore();
      }
    } finally {
      await cleanup();
    }
  });

  test("final enumeration proves removal when the post-probe raw read fails", async () => {
    // An inline-id workspace is deregistered by another backend while the
    // late-candidate workflow probes await, and the post-probe raw reads
    // fail transiently. Without the enumeration fallback every raw
    // deregistration guard is disabled (finalConfigIds null) and the stale
    // retained entry rides the authoritative response with no cross-process
    // event to repair it.
    const { config, historyService, cleanup } = await createTestHistoryService();
    try {
      const removedId = "inline-removed-final";
      const survivorId = "inline-survivor-final";
      const lateId = "late-registered-final";
      const projectPath = path.join(config.rootDir, "project");
      const configPath = path.join(config.rootDir, "config.json");
      const configFor = (ids: string[]): string =>
        JSON.stringify({
          projects: [
            [
              projectPath,
              { workspaces: ids.map((id) => ({ id, path: path.join(projectPath, id) })) },
            ],
          ],
          // Migration flags pre-seeded so the first load never schedules the
          // async settings-migration persist mid-test.
          taskSettings: { preserveSubagentsUntilArchive: true },
          migrations: { persistentSubagentsDefaulted: true, defaultModelFallbacksSeeded: true },
        });
      await fsPromises.writeFile(configPath, configFor([removedId, survivorId]));
      const extensionMetadata = new ExtensionMetadataService(
        path.join(config.rootDir, "extensionMetadata.json")
      );
      await extensionMetadata.updateRecency(removedId, 77);
      await extensionMetadata.updateRecency(survivorId, 55);
      // Fresh snapshot re-read (call 2) doubles as the moment "another
      // backend" registers a new workspace: its id enters the fresh raw
      // view outside the initial scope, forcing the late-candidate probes
      // and with them the final post-probe views this test exercises.
      // The final-phase snapshot re-read (call 3) marks the start of the
      // post-probe views: the concurrent deregistration lands there and
      // every later raw evidence read fails transiently, so only the
      // fallback enumeration can prove the removal.
      const realGetAllSnapshots = extensionMetadata.getAllSnapshots.bind(extensionMetadata);
      let snapshotCalls = 0;
      let failRawEvidenceReads = false;
      const snapshotsSpy = spyOn(extensionMetadata, "getAllSnapshots").mockImplementation(
        async (options?: { throwOnError?: boolean }) => {
          snapshotCalls += 1;
          if (snapshotCalls === 2) {
            await fsPromises.writeFile(configPath, configFor([removedId, survivorId, lateId]));
          }
          if (snapshotCalls === 3) {
            await fsPromises.writeFile(configPath, configFor([survivorId, lateId]));
            failRawEvidenceReads = true;
          }
          return realGetAllSnapshots(options);
        }
      );
      const realEvidence = config.readPersistedWorkspaceIdEvidence.bind(config);
      const evidenceSpy = spyOn(config, "readPersistedWorkspaceIdEvidence").mockImplementation(
        () => {
          if (failRawEvidenceReads) {
            throw new Error("transient raw config read failure");
          }
          return realEvidence();
        }
      );
      try {
        const workspaceService = createWorkspaceServiceForTest({
          config,
          historyService,
          extensionMetadata,
        });
        const activityList = await workspaceService.getActivityList();
        expect(activityList).not.toBeNull();
        expect(activityList?.[survivorId]?.recency).toBe(55);
        // The enumeration-proven removal is dropped despite the raw view
        // being unreadable.
        expect(activityList?.[removedId]).toBeUndefined();
      } finally {
        snapshotsSpy.mockRestore();
        evidenceSpy.mockRestore();
      }
    } finally {
      await cleanup();
    }
  });

  test("foreign removals observed mid-list evict process-local activity caches", async () => {
    // A cross-process removal publishes no local tombstone, so the
    // tombstone-cleared eviction listener never fires. Without eviction at
    // the removal guards, the removed incarnation's workflow caches survive
    // — and a downgraded backend re-registering the same deterministic
    // legacy id would then be served ghost runs instead of a fresh probe.
    const { config, historyService, cleanup } = await createTestHistoryService();
    try {
      const workspaceId = "foreign-removed-evict";
      const projectPath = path.join(config.rootDir, "project");
      const configPath = path.join(config.rootDir, "config.json");
      const configFor = (ids: string[]): string =>
        JSON.stringify({
          projects: [
            [
              projectPath,
              { workspaces: ids.map((id) => ({ id, path: path.join(projectPath, id) })) },
            ],
          ],
          taskSettings: { preserveSubagentsUntilArchive: true },
          migrations: { persistentSubagentsDefaulted: true, defaultModelFallbacksSeeded: true },
        });
      await fsPromises.writeFile(configPath, configFor([workspaceId]));
      const extensionMetadata = new ExtensionMetadataService(
        path.join(config.rootDir, "extensionMetadata.json")
      );
      await extensionMetadata.updateRecency(workspaceId, 42);
      const workspaceService = createWorkspaceServiceForTest({
        config,
        historyService,
        extensionMetadata,
      });
      const first = await workspaceService.getActivityList();
      expect(first?.[workspaceId]?.recency).toBe(42);
      const internals = workspaceService as unknown as {
        activeWorkflowRunIdsByWorkspace: Map<string, ReadonlySet<string>>;
      };
      expect(internals.activeWorkflowRunIdsByWorkspace.has(workspaceId)).toBe(true);
      // Another backend removes the workspace between the second list's
      // initial and fresh raw reads (its metadata cleanup may lag).
      const realGetAllSnapshots = extensionMetadata.getAllSnapshots.bind(extensionMetadata);
      let snapshotCalls = 0;
      const snapshotsSpy = spyOn(extensionMetadata, "getAllSnapshots").mockImplementation(
        async (options?: { throwOnError?: boolean }) => {
          snapshotCalls += 1;
          if (snapshotCalls === 2) {
            await fsPromises.writeFile(configPath, configFor([]));
          }
          return realGetAllSnapshots(options);
        }
      );
      try {
        const second = await workspaceService.getActivityList();
        expect(second?.[workspaceId]).toBeUndefined();
        expect(internals.activeWorkflowRunIdsByWorkspace.has(workspaceId)).toBe(false);
      } finally {
        snapshotsSpy.mockRestore();
      }
    } finally {
      await cleanup();
    }
  });

  test("first bootstrap reuses the prune's config enumeration for scoping", async () => {
    // getAllWorkspaceMetadata walks every workspace with per-workspace disk
    // probes; the latency-sensitive first bootstrap must not pay it twice.
    const { config, historyService, cleanup } = await createTestHistoryService();
    try {
      const workspaceId = "activity-scoping-reuse";
      const projectPath = path.join(config.rootDir, "project");
      await config.addWorkspace(projectPath, {
        id: workspaceId,
        name: workspaceId,
        projectName: "project",
        projectPath,
        runtimeConfig: { type: "local" },
      });
      const extensionMetadata = new ExtensionMetadataService(
        path.join(config.rootDir, "extensionMetadata.json")
      );
      await extensionMetadata.updateRecency(workspaceId, 100);
      await extensionMetadata.updateRecency("removed-workspace", 200);
      const metadataSpy = spyOn(config, "getAllWorkspaceMetadata");
      const workspaceService = createWorkspaceServiceForTest({
        config,
        historyService,
        extensionMetadata,
      });

      const activityList = await workspaceService.getActivityList();
      expect(activityList).not.toBeNull();
      expect(activityList?.[workspaceId]?.recency).toBe(100);
      expect(activityList?.["removed-workspace"]).toBeUndefined();
      // The single walk belongs to the prune's initial enumeration: the
      // list's SCOPING reuses the prune's ids, and the prune's mid-pass
      // re-registration recheck uses the raw config view (complete evidence
      // here — every persisted workspace id is inline) instead of repeating
      // the per-workspace walk while the metadata queue blocks live writes.
      expect(metadataSpy).toHaveBeenCalledTimes(1);
      // The stale entry really was reclaimed on disk, not merely filtered.
      expect((await extensionMetadata.getAllSnapshots()).has("removed-workspace")).toBe(false);
    } finally {
      await cleanup();
    }
  });

  test("first bootstrap scope keeps raw-registered ids the normalized view cannot see", async () => {
    // A duplicate project path key (e.g. a trailing-slash variant) shadows
    // the earlier pair in the normalized view — its workspace is registered
    // and raw-visible (spared by the prune) yet absent from every strict
    // enumeration. The first-bootstrap scope must come from the prune's
    // FULL raw-plus-normalized union, not the enumeration alone: when the
    // later raw refreshes fail transiently, an enumeration-only scope would
    // serve an authoritative response omitting the live workspace, clearing
    // its renderer activity state with no event to correct it.
    const { config, historyService, cleanup } = await createTestHistoryService();
    try {
      const shadowedId = "raw-only-shadowed-ws";
      const winnerId = "normalized-winner-ws";
      const projectPath = path.join(config.rootDir, "project");
      await fsPromises.writeFile(
        path.join(config.rootDir, "config.json"),
        JSON.stringify({
          projects: [
            // Map construction keeps the LAST duplicate key: the first pair
            // (trailing-slash variant of the same path) is dropped from the
            // normalized view with its workspace, while the raw id scan
            // still collects it.
            [
              `${projectPath}/`,
              { workspaces: [{ id: shadowedId, path: path.join(projectPath, "shadowed") }] },
            ],
            [
              projectPath,
              { workspaces: [{ id: winnerId, path: path.join(projectPath, "winner") }] },
            ],
          ],
          taskSettings: { preserveSubagentsUntilArchive: true },
          migrations: { persistentSubagentsDefaulted: true, defaultModelFallbacksSeeded: true },
        })
      );
      const extensionMetadata = new ExtensionMetadataService(
        path.join(config.rootDir, "extensionMetadata.json")
      );
      await extensionMetadata.updateRecency(shadowedId, 42);
      const workspaceService = createWorkspaceServiceForTest({
        config,
        historyService,
        extensionMetadata,
      });
      // Every raw config read AFTER the prune's successful one fails
      // transiently (the finding's window: the id was already loaded, and
      // only the discarded return kept it out of scope).
      const internals = workspaceService as unknown as {
        pruneStaleExtensionMetadataOnce(): Promise<unknown>;
      };
      const realPrune = internals.pruneStaleExtensionMetadataOnce.bind(workspaceService);
      let failRawReads = false;
      internals.pruneStaleExtensionMetadataOnce = async () => {
        const prefetched = await realPrune();
        failRawReads = true;
        return prefetched;
      };
      const realEvidence = config.readPersistedWorkspaceIdEvidence.bind(config);
      const evidenceSpy = spyOn(config, "readPersistedWorkspaceIdEvidence").mockImplementation(
        () => {
          if (failRawReads) {
            throw new Error("transient config read failure");
          }
          return realEvidence();
        }
      );
      try {
        const activityList = await workspaceService.getActivityList();
        expect(activityList).not.toBeNull();
        expect(activityList?.[shadowedId]?.recency).toBe(42);
        // Its snapshot was spared by the prune too, not merely re-admitted.
        expect((await extensionMetadata.getAllSnapshots()).has(shadowedId)).toBe(true);
      } finally {
        evidenceSpy.mockRestore();
      }
    } finally {
      await cleanup();
    }
  });

  test("a mid-list corruption reset does not read as workspace removal", async () => {
    // getAllSnapshots self-heals a deterministically corrupt metadata file
    // into a valid (possibly EMPTY) one, so a quarantine landing between the
    // initial and fresh reads makes every earlier snapshot key vanish from a
    // SUCCESSFUL re-read while the config still registers the workspaces.
    // Treating that disappearance as foreign-removal evidence would evict
    // the workflow caches and omit live workspaces from an authoritative
    // response — with no cross-process event to repair the renderer.
    const { config, historyService, cleanup } = await createTestHistoryService();
    try {
      const workspaceId = "corruption-reset-survivor";
      const projectPath = path.join(config.rootDir, "project");
      await config.addWorkspace(projectPath, {
        id: workspaceId,
        name: workspaceId,
        projectName: "project",
        projectPath,
        runtimeConfig: { type: "local" },
      });
      const extensionMetadata = new ExtensionMetadataService(
        path.join(config.rootDir, "extensionMetadata.json")
      );
      await extensionMetadata.updateRecency(workspaceId, 123);
      const workspaceService = createWorkspaceServiceForTest({
        config,
        historyService,
        extensionMetadata,
      });
      const realGetAll = extensionMetadata.getAllSnapshots.bind(extensionMetadata);
      let snapshotReads = 0;
      const snapshotsSpy = spyOn(extensionMetadata, "getAllSnapshots").mockImplementation(
        (options) => {
          snapshotReads += 1;
          if (snapshotReads === 1) {
            return realGetAll(options);
          }
          // Every re-read after the initial one models the post-quarantine
          // self-healed EMPTY file: a successful, authoritative-looking
          // read with every previous key gone.
          return Promise.resolve(new Map<string, WorkspaceActivitySnapshot>());
        }
      );
      try {
        const activityList = await workspaceService.getActivityList();
        expect(activityList).not.toBeNull();
        expect(activityList?.[workspaceId]?.recency).toBe(123);
      } finally {
        snapshotsSpy.mockRestore();
      }
    } finally {
      await cleanup();
    }
  });

  test("a raw-removed id affirmed by the fresh enumeration is retained, not tombstoned", async () => {
    // A downgraded backend can remove an inline-id workspace entry and
    // re-register the SAME deterministic id as an id-less legacy entry
    // while this list awaits. The id then vanishes from every fresh raw
    // view (its identity lives in session metadata.json) while the fresh
    // authoritative enumeration — the very evidence that clears the id's
    // tombstone — still resolves it. Treating the raw disappearance alone
    // as removal would drop the revived workspace's activity and republish
    // the tombstone that evidence just cleared, suppressing it again.
    const { config, historyService, cleanup } = await createTestHistoryService();
    try {
      const workspaceId = "raw-invisible-revival";
      const projectPath = path.join(config.rootDir, "project");
      await config.addWorkspace(projectPath, {
        id: workspaceId,
        name: workspaceId,
        projectName: "project",
        projectPath,
        runtimeConfig: { type: "local" },
      });
      const extensionMetadata = new ExtensionMetadataService(
        path.join(config.rootDir, "extensionMetadata.json")
      );
      await extensionMetadata.updateRecency(workspaceId, 42);
      const workspaceService = createWorkspaceServiceForTest({
        config,
        historyService,
        extensionMetadata,
      });
      const internals = workspaceService as unknown as {
        pruneStaleExtensionMetadataOnce(): Promise<unknown>;
        enumerateAuthoritativeWorkspaceIds(): Promise<Set<string>>;
      };
      const realPrune = internals.pruneStaleExtensionMetadataOnce.bind(workspaceService);
      let revivedIdless = false;
      internals.pruneStaleExtensionMetadataOnce = async () => {
        const prefetched = await realPrune();
        // The removal + id-less re-registration lands after the initial
        // baseline and the prune, before the fresh evidence read.
        revivedIdless = true;
        return prefetched;
      };
      const realEvidence = config.readPersistedWorkspaceIdEvidence.bind(config);
      const evidenceSpy = spyOn(config, "readPersistedWorkspaceIdEvidence").mockImplementation(
        () => {
          const evidence = realEvidence();
          if (!revivedIdless) {
            return evidence;
          }
          // The downgraded backend rewrote the entry without an inline id:
          // the id disappears from the raw view, and the id-less entry
          // marks that view incomplete.
          const ids = new Set(evidence.ids);
          ids.delete(workspaceId);
          return { ids, hasWorkspaceEntriesWithoutIds: true };
        }
      );
      const realEnumerate = internals.enumerateAuthoritativeWorkspaceIds.bind(workspaceService);
      internals.enumerateAuthoritativeWorkspaceIds = async () => {
        // The enumeration resolves the id-less entry's stable identity.
        const ids = await realEnumerate();
        ids.add(workspaceId);
        return ids;
      };
      try {
        const activityList = await workspaceService.getActivityList();
        expect(activityList).not.toBeNull();
        expect(activityList?.[workspaceId]?.recency).toBe(42);
        // No republished tombstone suppressing the revived workspace.
        expect(extensionMetadata.isWorkspaceDeleted(workspaceId)).toBe(false);
      } finally {
        evidenceSpy.mockRestore();
      }
    } finally {
      await cleanup();
    }
  });

  test("a revival landing between the enumeration and the raw refresh is re-checked, not dropped", async () => {
    // The staleness window the post-refresh re-enumeration closes: the id
    // is removed BEFORE the mid-list enumeration runs (so that enumeration
    // denies it) and re-registered id-less right after it. The raw refresh
    // then reports id-less entries — proof the earlier denial may be
    // stale — so the removal arms must consult a fresh enumeration (which
    // resolves the revived identity) instead of dropping the workspace on
    // the stale denial and tombstoning it.
    const { config, historyService, cleanup } = await createTestHistoryService();
    try {
      const workspaceId = "revived-between-reads";
      const projectPath = path.join(config.rootDir, "project");
      await config.addWorkspace(projectPath, {
        id: workspaceId,
        name: workspaceId,
        projectName: "project",
        projectPath,
        runtimeConfig: { type: "local" },
      });
      const extensionMetadata = new ExtensionMetadataService(
        path.join(config.rootDir, "extensionMetadata.json")
      );
      await extensionMetadata.updateRecency(workspaceId, 42);
      const workspaceService = createWorkspaceServiceForTest({
        config,
        historyService,
        extensionMetadata,
      });
      const internals = workspaceService as unknown as {
        pruneStaleExtensionMetadataOnce(): Promise<unknown>;
        enumerateAuthoritativeWorkspaceIds(): Promise<Set<string>>;
      };
      const realPrune = internals.pruneStaleExtensionMetadataOnce.bind(workspaceService);
      let removed = false;
      internals.pruneStaleExtensionMetadataOnce = async () => {
        const prefetched = await realPrune();
        // The cross-process removal lands after the initial baseline and
        // the prune.
        removed = true;
        return prefetched;
      };
      const realEvidence = config.readPersistedWorkspaceIdEvidence.bind(config);
      const evidenceSpy = spyOn(config, "readPersistedWorkspaceIdEvidence").mockImplementation(
        () => {
          const evidence = realEvidence();
          if (!removed) {
            return evidence;
          }
          // Post-removal raw views: the id is gone, and an unrelated
          // id-less legacy entry keeps the view incomplete throughout.
          const ids = new Set(evidence.ids);
          ids.delete(workspaceId);
          return { ids, hasWorkspaceEntriesWithoutIds: true };
        }
      );
      const realEnumerate = internals.enumerateAuthoritativeWorkspaceIds.bind(workspaceService);
      let postRemovalEnumerations = 0;
      internals.enumerateAuthoritativeWorkspaceIds = async () => {
        const ids = await realEnumerate();
        if (!removed) {
          return ids;
        }
        postRemovalEnumerations += 1;
        if (postRemovalEnumerations === 1) {
          // First post-removal enumeration: the removal is visible, the
          // id-less re-registration has not landed yet — a stale denial.
          ids.delete(workspaceId);
        }
        // Later enumerations resolve the revived id-less identity.
        return ids;
      };
      try {
        const activityList = await workspaceService.getActivityList();
        expect(activityList).not.toBeNull();
        expect(activityList?.[workspaceId]?.recency).toBe(42);
        expect(extensionMetadata.isWorkspaceDeleted(workspaceId)).toBe(false);
      } finally {
        evidenceSpy.mockRestore();
      }
    } finally {
      await cleanup();
    }
  });

  test("first bootstrap admits snapshotless ids registered after the prune enumerated config", async () => {
    // A workspace another backend registers after the prune captured its id
    // set may have workflow- or bash-monitor-only activity and therefore no
    // extensionMetadata snapshot. Admission must come from the refreshed raw
    // config view — filtering through snapshot keys would skip the per-id
    // workflow probe entirely and return an authoritative list without it.
    const { config, historyService, cleanup } = await createTestHistoryService();
    try {
      const lateWorkspaceId = "late-registered-workspace";
      // Registered for real (the mid-list registration lands in config.json
      // in the modeled race); the spies below hide it from the baseline and
      // prune reads so only the refresh discovers it — the authoritative
      // removal recheck must then still find it registered.
      const projectPath = path.join(config.rootDir, "project");
      await config.addWorkspace(projectPath, {
        id: lateWorkspaceId,
        name: lateWorkspaceId,
        projectName: "project",
        projectPath,
        runtimeConfig: { type: "local" },
      });
      const extensionMetadata = new ExtensionMetadataService(
        path.join(config.rootDir, "extensionMetadata.json")
      );
      const realSuperset = config.readPersistedWorkspaceIdSuperset.bind(config);
      let supersetCalls = 0;
      const supersetSpy = spyOn(config, "readPersistedWorkspaceIdSuperset").mockImplementation(
        () => {
          supersetCalls += 1;
          const ids = realSuperset();
          // Calls 1 (pre-await baseline) and 2 (prune enumeration) see the
          // pre-registration config; the refresh and the post-await
          // revalidation see the concurrently registered workspace.
          if (supersetCalls <= 2) {
            ids.delete(lateWorkspaceId);
          }
          return ids;
        }
      );
      const realMetadata = config.getAllWorkspaceMetadata.bind(config);
      let metadataCalls = 0;
      const metadataSpy = spyOn(config, "getAllWorkspaceMetadata").mockImplementation(
        async (options?: { throwOnError?: boolean }) => {
          // Only the prune's enumeration (first call) predates the
          // registration in the modeled race; the revalidation's fresh
          // authoritative enumeration sees the registered workspace.
          metadataCalls += 1;
          const all = await realMetadata(options);
          if (metadataCalls === 1) {
            return all.filter((metadata) => metadata.id !== lateWorkspaceId);
          }
          return all;
        }
      );
      try {
        const workspaceService = createWorkspaceServiceForTest({
          config,
          historyService,
          extensionMetadata,
        });
        // Workflow-only activity: discoverable by the per-id probe, never a
        // persisted snapshot.
        await workspaceService.emitWorkflowRunActivity({
          workspaceId: lateWorkspaceId,
          runId: "late-run",
          status: "running",
        });

        const activityList = await workspaceService.getActivityList();
        expect(activityList?.[lateWorkspaceId]?.activeWorkflowRunCount).toBe(1);
      } finally {
        supersetSpy.mockRestore();
        metadataSpy.mockRestore();
      }
    } finally {
      await cleanup();
    }
  });

  test("suppresses activity emissions for removed workspaces", async () => {
    // A late in-flight producer completing after removal must not broadcast:
    // the renderer would re-insert the removed id into its activity map after
    // already processing the metadata-removal event.
    const { config, historyService, cleanup } = await createTestHistoryService();
    try {
      const workspaceId = "activity-emit-after-removal";
      const projectPath = path.join(config.rootDir, "project");
      await config.addWorkspace(projectPath, {
        id: workspaceId,
        name: workspaceId,
        projectName: "project",
        projectPath,
        runtimeConfig: { type: "local" },
      });
      const extensionMetadata = new ExtensionMetadataService(
        path.join(config.rootDir, "extensionMetadata.json")
      );
      const workspaceService = createWorkspaceServiceForTest({
        config,
        historyService,
        extensionMetadata,
      });
      const events: Array<{ workspaceId: string }> = [];
      workspaceService.on("activity", (event) => events.push(event));

      await workspaceService.updateAgentStatus(workspaceId, { emoji: "🛠️", message: "Working" });
      expect(events.length).toBe(1);

      // Discard verifies deregistration against persisted config, so remove
      // the workspace first (mirroring the real removal flow).
      await config.removeWorkspace(workspaceId);
      await workspaceService.discardExtensionMetadataEntry(workspaceId);
      // Simulates the producer that was already in flight when removal ran.
      await workspaceService.updateAgentStatus(workspaceId, { emoji: "🛠️", message: "Late" });
      expect(events.length).toBe(1);
      // Clearing (null) emissions stay allowed for removed workspaces.
      workspaceService.emitWorkspaceActivity(workspaceId, null);
      expect(events.length).toBe(2);
      // A late workflow-run producer can also fire after removal: its cache
      // entry turns a null snapshot into a non-null merged payload, which
      // must be suppressed exactly like a non-null snapshot emission — the
      // tombstone check runs on the merged payload, not the raw snapshot.
      await workspaceService.emitWorkflowRunActivity({
        workspaceId,
        runId: "late-run",
        status: "running",
      });
      expect(events.length).toBe(2);
      workspaceService.emitWorkspaceActivity(workspaceId, null);
      expect(events.length).toBe(2);
    } finally {
      await cleanup();
    }
  });

  test("a re-registered id sheds its tombstone on the next activity list", async () => {
    // Tombstones are process-local removal knowledge; the shared config is
    // the authority. A downgraded concurrent backend can legitimately
    // re-register a deterministic legacy id this process pruned — the next
    // activity list observes the id in fresh config evidence and must lift
    // the write suppression instead of muting the revived workspace until
    // restart.
    const { config, historyService, cleanup } = await createTestHistoryService();
    try {
      const workspaceId = "revived-legacy-workspace";
      const projectPath = path.join(config.rootDir, "project");
      const workspaceEntry = {
        id: workspaceId,
        name: workspaceId,
        projectName: "project",
        projectPath,
        runtimeConfig: { type: "local" as const },
      };
      await config.addWorkspace(projectPath, workspaceEntry);
      const extensionMetadata = new ExtensionMetadataService(
        path.join(config.rootDir, "extensionMetadata.json")
      );
      await extensionMetadata.updateRecency(workspaceId, 100);
      const workspaceService = createWorkspaceServiceForTest({
        config,
        historyService,
        extensionMetadata,
      });
      // Removal flow: deregister, then discard (delete + tombstone).
      await config.removeWorkspace(workspaceId);
      await workspaceService.discardExtensionMetadataEntry(workspaceId);
      expect(extensionMetadata.isWorkspaceDeleted(workspaceId)).toBe(true);
      // Writes are suppressed while tombstoned.
      await extensionMetadata.updateRecency(workspaceId, 200);
      expect((await extensionMetadata.getAllSnapshots()).has(workspaceId)).toBe(false);

      // The "other backend" re-registers the same id in the shared config.
      await config.addWorkspace(projectPath, workspaceEntry);

      await workspaceService.getActivityList();
      expect(extensionMetadata.isWorkspaceDeleted(workspaceId)).toBe(false);
      // Writes persist again after the revival.
      await extensionMetadata.updateRecency(workspaceId, 300);
      expect((await extensionMetadata.getAllSnapshots()).get(workspaceId)?.recency).toBe(300);
    } finally {
      await cleanup();
    }
  });

  test("discardExtensionMetadataEntry keeps the entry when the workspace is still persisted", async () => {
    // saveConfig swallows write failures, so config.removeWorkspace can
    // resolve while the workspace is still persisted in config.json.
    // Discarding then would write-tombstone a live id and suppress all of
    // its future activity writes for the rest of the process.
    const { config, historyService, cleanup } = await createTestHistoryService();
    try {
      const workspaceId = "discard-still-persisted";
      const projectPath = path.join(config.rootDir, "project");
      await config.addWorkspace(projectPath, {
        id: workspaceId,
        name: workspaceId,
        projectName: "project",
        projectPath,
        runtimeConfig: { type: "local" },
      });
      const extensionMetadata = new ExtensionMetadataService(
        path.join(config.rootDir, "extensionMetadata.json")
      );
      await extensionMetadata.updateRecency(workspaceId, 100);
      const workspaceService = createWorkspaceServiceForTest({
        config,
        historyService,
        extensionMetadata,
      });

      await workspaceService.discardExtensionMetadataEntry(workspaceId);

      expect((await extensionMetadata.getAllSnapshots()).has(workspaceId)).toBe(true);
      expect(extensionMetadata.isWorkspaceDeleted(workspaceId)).toBe(false);
    } finally {
      await cleanup();
    }
  });

  test("discardExtensionMetadataEntry keeps entries of id-less legacy workspaces", async () => {
    // An id-less legacy config entry resolves its stable id from
    // sessions/<generated-legacy-id>/metadata.json. The raw config scan
    // cannot see that id, so the discard's registration check must resolve
    // it through the same authoritative path getAllWorkspaceMetadata uses;
    // otherwise the still-registered workspace would be reported absent and
    // its activity writes permanently tombstoned for this process.
    const { config, historyService, cleanup } = await createTestHistoryService();
    try {
      const stableId = "legacy-stable-id";
      const projectPath = path.join(config.rootDir, "project");
      const workspacePath = path.join(projectPath, "legacy-ws");
      await fsPromises.writeFile(
        path.join(config.rootDir, "config.json"),
        JSON.stringify({
          projects: [[projectPath, { workspaces: [{ path: workspacePath }] }]],
        })
      );
      const legacySessionDir = path.join(
        config.sessionsDir,
        config.generateLegacyId(projectPath, workspacePath)
      );
      await fsPromises.mkdir(legacySessionDir, { recursive: true });
      await fsPromises.writeFile(
        path.join(legacySessionDir, "metadata.json"),
        JSON.stringify({ id: stableId, name: "legacy-ws" })
      );
      const extensionMetadata = new ExtensionMetadataService(
        path.join(config.rootDir, "extensionMetadata.json")
      );
      await extensionMetadata.updateRecency(stableId, 100);
      const workspaceService = createWorkspaceServiceForTest({
        config,
        historyService,
        extensionMetadata,
      });

      await workspaceService.discardExtensionMetadataEntry(stableId);

      expect((await extensionMetadata.getAllSnapshots()).has(stableId)).toBe(true);
      expect(extensionMetadata.isWorkspaceDeleted(stableId)).toBe(false);
    } finally {
      await cleanup();
    }
  });

  test("discardExtensionMetadataEntry keeps entries when legacy metadata parses without an id", async () => {
    // Same identity-unknowable contract as the unparseable case: a legacy
    // metadata.json that parses as `{}` carries no id, so the strict
    // findWorkspace lookup must fail closed rather than fall through to
    // "not registered" — the entry under the real (unknowable) stable id
    // would otherwise be deleted and write-tombstoned while its workspace
    // remains registered.
    const { config, historyService, cleanup } = await createTestHistoryService();
    try {
      const stableId = "legacy-stable-id";
      const projectPath = path.join(config.rootDir, "project");
      const workspacePath = path.join(projectPath, "legacy-ws");
      await fsPromises.writeFile(
        path.join(config.rootDir, "config.json"),
        JSON.stringify({
          projects: [[projectPath, { workspaces: [{ path: workspacePath }] }]],
        })
      );
      const legacySessionDir = path.join(
        config.sessionsDir,
        config.generateLegacyId(projectPath, workspacePath)
      );
      await fsPromises.mkdir(legacySessionDir, { recursive: true });
      await fsPromises.writeFile(path.join(legacySessionDir, "metadata.json"), "{}");
      const extensionMetadata = new ExtensionMetadataService(
        path.join(config.rootDir, "extensionMetadata.json")
      );
      await extensionMetadata.updateRecency(stableId, 100);
      const workspaceService = createWorkspaceServiceForTest({
        config,
        historyService,
        extensionMetadata,
      });

      await workspaceService.discardExtensionMetadataEntry(stableId);

      expect((await extensionMetadata.getAllSnapshots()).has(stableId)).toBe(true);
      expect(extensionMetadata.isWorkspaceDeleted(stableId)).toBe(false);
    } finally {
      await cleanup();
    }
  });

  test("getActivityList merges snapshots another process persisted mid-list", async () => {
    // Another backend can register a workspace and persist its first
    // activity after this process's initial snapshot read. The refreshed
    // config admits the id, but the per-id computation saw a null snapshot
    // and no local caches, so the entry would be omitted — and the activity
    // subscription is process-local, so no delta ever heals it. The fresh
    // revalidation re-read must merge the addition.
    const { config, historyService, cleanup } = await createTestHistoryService();
    try {
      const workspaceId = "late-snapshot-workspace";
      const projectPath = path.join(config.rootDir, "project");
      await config.addWorkspace(projectPath, {
        id: workspaceId,
        name: workspaceId,
        projectName: "project",
        projectPath,
        runtimeConfig: { type: "local" },
      });
      const extensionMetadata = new ExtensionMetadataService(
        path.join(config.rootDir, "extensionMetadata.json")
      );
      // Simulate the cross-process write landing between the initial read
      // (call 1) and the revalidation re-read (call 2).
      const realGetAllSnapshots = extensionMetadata.getAllSnapshots.bind(extensionMetadata);
      let snapshotCalls = 0;
      const snapshotsSpy = spyOn(extensionMetadata, "getAllSnapshots").mockImplementation(
        async (options?: { throwOnError?: boolean }) => {
          snapshotCalls += 1;
          if (snapshotCalls === 1) {
            return realGetAllSnapshots(options);
          }
          await extensionMetadata.updateRecency(workspaceId, 777);
          return realGetAllSnapshots(options);
        }
      );
      try {
        const workspaceService = createWorkspaceServiceForTest({
          config,
          historyService,
          extensionMetadata,
        });

        const activityList = await workspaceService.getActivityList();
        expect(activityList?.[workspaceId]?.recency).toBe(777);
      } finally {
        snapshotsSpy.mockRestore();
      }
    } finally {
      await cleanup();
    }
  });

  test("getActivityList merges workspaces registered and written entirely mid-list", async () => {
    // Harder variant of the mid-list merge: the workspace is registered AND
    // written after every scope read (baseline, prune, refresh), so it is in
    // neither the per-id scope nor the initial snapshots — only the fresh
    // revalidation views (snapshot re-read + raw config re-read) know it.
    // The merge must admit ids those fresh views agree on.
    const { config, historyService, cleanup } = await createTestHistoryService();
    try {
      const workspaceId = "brand-new-workspace";
      const projectPath = path.join(config.rootDir, "project");
      const extensionMetadata = new ExtensionMetadataService(
        path.join(config.rootDir, "extensionMetadata.json")
      );
      const realGetAllSnapshots = extensionMetadata.getAllSnapshots.bind(extensionMetadata);
      let snapshotCalls = 0;
      const snapshotsSpy = spyOn(extensionMetadata, "getAllSnapshots").mockImplementation(
        async (options?: { throwOnError?: boolean }) => {
          snapshotCalls += 1;
          if (snapshotCalls === 2) {
            // The other backend registers the workspace and persists its
            // first activity between the initial read and the revalidation
            // re-read (before the fresh raw config re-read).
            await config.addWorkspace(projectPath, {
              id: workspaceId,
              name: workspaceId,
              projectName: "project",
              projectPath,
              runtimeConfig: { type: "local" },
            });
            await extensionMetadata.updateRecency(workspaceId, 888);
          }
          return realGetAllSnapshots(options);
        }
      );
      try {
        const workspaceService = createWorkspaceServiceForTest({
          config,
          historyService,
          extensionMetadata,
        });

        const activityList = await workspaceService.getActivityList();
        expect(activityList?.[workspaceId]?.recency).toBe(888);
      } finally {
        snapshotsSpy.mockRestore();
      }
    } finally {
      await cleanup();
    }
  });

  test("getActivityList bootstraps workflow runs for workspaces merged mid-list", async () => {
    // A workspace admitted only by the fresh revalidation re-reads never went
    // through the per-id loop, so its on-disk active workflow runs are not in
    // the process-local cache. The merge must probe disk for them — a
    // cached-only merge would omit activeWorkflowRunCount for exactly the
    // cross-process registrations it exists to bootstrap, and the
    // process-local activity subscription can never deliver that delta.
    const { config, historyService, cleanup } = await createTestHistoryService();
    try {
      const workspaceId = "brand-new-workflow-workspace";
      const projectPath = path.join(config.rootDir, "project");
      const extensionMetadata = new ExtensionMetadataService(
        path.join(config.rootDir, "extensionMetadata.json")
      );
      const realGetAllSnapshots = extensionMetadata.getAllSnapshots.bind(extensionMetadata);
      let snapshotCalls = 0;
      const snapshotsSpy = spyOn(extensionMetadata, "getAllSnapshots").mockImplementation(
        async (options?: { throwOnError?: boolean }) => {
          snapshotCalls += 1;
          if (snapshotCalls === 2) {
            // The other backend registers the workspace, persists its first
            // activity, AND starts a workflow run before the revalidation
            // re-read.
            await config.addWorkspace(projectPath, {
              id: workspaceId,
              name: workspaceId,
              projectName: "project",
              projectPath,
              runtimeConfig: { type: "local" },
            });
            await extensionMetadata.updateRecency(workspaceId, 888);
            const runStore = new WorkflowRunStore({
              sessionDir: path.join(config.sessionsDir, workspaceId),
            });
            await runStore.createRun({
              id: "wfr_midlist",
              workspaceId,
              workflow: {
                name: "demo",
                description: "Demo workflow",
                scope: "global" as const,
                executable: true,
              },
              source: "export default function workflow() { return {}; }",
              args: {},
              now: "2026-06-17T00:00:00.000Z",
            });
          }
          return realGetAllSnapshots(options);
        }
      );
      try {
        const workspaceService = createWorkspaceServiceForTest({
          config,
          historyService,
          extensionMetadata,
        });

        const activityList = await workspaceService.getActivityList();
        expect(activityList?.[workspaceId]?.recency).toBe(888);
        expect(activityList?.[workspaceId]?.activeWorkflowRunCount).toBe(1);
        expect(activityList?.[workspaceId]?.activeWorkflowRunIds).toEqual(["wfr_midlist"]);
      } finally {
        snapshotsSpy.mockRestore();
      }
    } finally {
      await cleanup();
    }
  });

  test("getActivityList admits raw-invisible legacy workspaces registered mid-list", async () => {
    // A downgraded backend can register a legacy (id-less config entry)
    // workspace mid-list: its stable id lives only in session metadata.json,
    // so the fresh raw config re-read can never vouch for it. The merge must
    // resolve such fresh-snapshot ids through the authoritative identity
    // path instead of excluding them until reconnect.
    const { config, historyService, cleanup } = await createTestHistoryService();
    try {
      const stableId = "late-legacy-stable-id";
      const projectPath = path.join(config.rootDir, "project");
      const workspacePath = path.join(projectPath, "legacy-ws");
      const configPath = path.join(config.rootDir, "config.json");
      const extensionMetadata = new ExtensionMetadataService(
        path.join(config.rootDir, "extensionMetadata.json")
      );
      const realGetAllSnapshots = extensionMetadata.getAllSnapshots.bind(extensionMetadata);
      let snapshotCalls = 0;
      const snapshotsSpy = spyOn(extensionMetadata, "getAllSnapshots").mockImplementation(
        async (options?: { throwOnError?: boolean }) => {
          snapshotCalls += 1;
          if (snapshotCalls === 2) {
            await fsPromises.writeFile(
              configPath,
              JSON.stringify({
                projects: [[projectPath, { workspaces: [{ path: workspacePath }] }]],
              })
            );
            const legacySessionDir = path.join(
              config.sessionsDir,
              config.generateLegacyId(projectPath, workspacePath)
            );
            await fsPromises.mkdir(legacySessionDir, { recursive: true });
            await fsPromises.writeFile(
              path.join(legacySessionDir, "metadata.json"),
              JSON.stringify({ id: stableId, name: "legacy-ws" })
            );
            await extensionMetadata.updateRecency(stableId, 777);
          }
          return realGetAllSnapshots(options);
        }
      );
      try {
        const workspaceService = createWorkspaceServiceForTest({
          config,
          historyService,
          extensionMetadata,
        });

        const activityList = await workspaceService.getActivityList();
        expect(activityList?.[stableId]?.recency).toBe(777);
      } finally {
        snapshotsSpy.mockRestore();
      }
    } finally {
      await cleanup();
    }
  });

  test("getActivityList bootstraps workflow-only workspaces registered mid-list", async () => {
    // A backend can register a workspace after the scope reads and start a
    // workflow WITHOUT writing extension metadata: the fresh snapshot re-read
    // never contains the id, so admission must come from the fresh raw
    // config view alone — otherwise the workflow-only activity is missing
    // from the authoritative response until reconnect.
    const { config, historyService, cleanup } = await createTestHistoryService();
    try {
      const workspaceId = "workflow-only-late-workspace";
      const projectPath = path.join(config.rootDir, "project");
      const extensionMetadata = new ExtensionMetadataService(
        path.join(config.rootDir, "extensionMetadata.json")
      );
      const realGetAllSnapshots = extensionMetadata.getAllSnapshots.bind(extensionMetadata);
      let snapshotCalls = 0;
      const snapshotsSpy = spyOn(extensionMetadata, "getAllSnapshots").mockImplementation(
        async (options?: { throwOnError?: boolean }) => {
          snapshotCalls += 1;
          if (snapshotCalls === 2) {
            // Registered + workflow started, but NO metadata write.
            await config.addWorkspace(projectPath, {
              id: workspaceId,
              name: workspaceId,
              projectName: "project",
              projectPath,
              runtimeConfig: { type: "local" },
            });
            const runStore = new WorkflowRunStore({
              sessionDir: path.join(config.sessionsDir, workspaceId),
            });
            await runStore.createRun({
              id: "wfr_workflow_only",
              workspaceId,
              workflow: {
                name: "demo",
                description: "Demo workflow",
                scope: "global" as const,
                executable: true,
              },
              source: "export default function workflow() { return {}; }",
              args: {},
              now: "2026-06-17T00:00:00.000Z",
            });
          }
          return realGetAllSnapshots(options);
        }
      );
      try {
        const workspaceService = createWorkspaceServiceForTest({
          config,
          historyService,
          extensionMetadata,
        });

        const activityList = await workspaceService.getActivityList();
        expect(activityList?.[workspaceId]?.activeWorkflowRunCount).toBe(1);
        expect(activityList?.[workspaceId]?.activeWorkflowRunIds).toEqual(["wfr_workflow_only"]);
      } finally {
        snapshotsSpy.mockRestore();
      }
    } finally {
      await cleanup();
    }
  });

  test("a workflow bootstrap evicted mid-flight is retried instead of served detached", async () => {
    // Cache eviction (removal / tombstone-lift revival) can race an
    // in-flight bootstrap: waiters that captured the pre-eviction Set would
    // return the removed incarnation's runs — ghost counts with no terminal
    // event to clear them. The read must detect the eviction and re-probe.
    const { config, historyService, cleanup } = await createTestHistoryService();
    const listStatusSnapshotsSpy = spyOn(WorkflowRunStore.prototype, "listRunStatusSnapshots");
    try {
      const workspaceId = "evicted-mid-bootstrap";
      const workspaceService = createWorkspaceServiceForTest({
        config,
        historyService,
        extensionMetadata: new ExtensionMetadataService(
          path.join(config.rootDir, "extensionMetadata.json")
        ),
      });
      const internals = workspaceService as unknown as {
        getActiveWorkflowRunIds(id: string): Promise<Set<string>>;
        evictWorkspaceActivityCaches(id: string): void;
      };
      const releaseFirstScan = createDeferred<void>();
      let scanCalls = 0;
      listStatusSnapshotsSpy.mockImplementation(async () => {
        scanCalls += 1;
        if (scanCalls === 1) {
          // Old-incarnation bootstrap: parked, then reports a ghost run.
          await releaseFirstScan.promise;
          return [
            {
              id: "wfr_ghost",
              workspaceId,
              status: "running" as const,
              createdAt: "2026-06-17T00:00:00.000Z",
              updatedAt: "2026-06-17T00:00:00.000Z",
            },
          ];
        }
        // Post-revival probe: the new incarnation has no runs.
        return [];
      });

      const read = internals.getActiveWorkflowRunIds(workspaceId);
      // Removal + re-registration land while the bootstrap is parked.
      internals.evictWorkspaceActivityCaches(workspaceId);
      releaseFirstScan.resolve();
      const runIds = await read;
      expect(runIds.size).toBe(0);
    } finally {
      listStatusSnapshotsSpy.mockRestore();
      await cleanup();
    }
  });

  test("a re-registered id does not inherit workflow caches from its removed incarnation", async () => {
    // Workspace removal deletes session state without producing terminal
    // workflow events, and the process-local run cache was never evicted:
    // a deterministic legacy id re-registered by a downgraded backend would
    // show the removed incarnation's ghost activeWorkflowRunCount forever
    // (the per-id bootstrap returns the cached set without re-probing disk).
    const { config, historyService, cleanup } = await createTestHistoryService();
    try {
      const workspaceId = "revived-workspace";
      const projectPath = path.join(config.rootDir, "project");
      const extensionMetadata = new ExtensionMetadataService(
        path.join(config.rootDir, "extensionMetadata.json")
      );
      const workspaceService = createWorkspaceServiceForTest({
        config,
        historyService,
        extensionMetadata,
      });
      // Cache a live workflow run for the (unregistered) old incarnation.
      await workspaceService.emitWorkflowRunActivity({
        workspaceId,
        runId: "wfr_ghost",
        status: "running",
      });
      // Removal cleanup: deregistered (never in config here), so the entry
      // is tombstoned and the process-local caches must be evicted.
      await workspaceService.discardExtensionMetadataEntry(workspaceId);
      // The downgraded backend re-registers the same id; its session dir has
      // no workflow runs.
      await config.addWorkspace(projectPath, {
        id: workspaceId,
        name: workspaceId,
        projectName: "project",
        projectPath,
        runtimeConfig: { type: "local" },
      });

      const activityList = await workspaceService.getActivityList();
      expect(activityList).not.toBeNull();
      // No ghost count from the removed incarnation's cache: the revived id
      // re-probes disk (empty) and stays absent from the list.
      expect(activityList?.[workspaceId]).toBeUndefined();
    } finally {
      await cleanup();
    }
  });

  test("getActivityList bootstraps workflow-only late ids even when the metadata reread fails", async () => {
    // The fresh raw config re-read can discover a workflow-only late
    // registration while the metadata re-read transiently fails. The list
    // still returns an authoritative (non-null) response, and the
    // process-local subscription cannot supply the foreign workflow event —
    // so the config-proven id must be probed regardless of the failed
    // snapshot view.
    const { config, historyService, cleanup } = await createTestHistoryService();
    try {
      const workspaceId = "workflow-only-late-reread-fails";
      const projectPath = path.join(config.rootDir, "project");
      const extensionMetadata = new ExtensionMetadataService(
        path.join(config.rootDir, "extensionMetadata.json")
      );
      const realGetAllSnapshots = extensionMetadata.getAllSnapshots.bind(extensionMetadata);
      let snapshotCalls = 0;
      const snapshotsSpy = spyOn(extensionMetadata, "getAllSnapshots").mockImplementation(
        async (options?: { throwOnError?: boolean }) => {
          snapshotCalls += 1;
          if (snapshotCalls === 1) {
            return realGetAllSnapshots(options);
          }
          if (snapshotCalls === 2) {
            // Registration + workflow start land before the (failing)
            // revalidation re-read.
            await config.addWorkspace(projectPath, {
              id: workspaceId,
              name: workspaceId,
              projectName: "project",
              projectPath,
              runtimeConfig: { type: "local" },
            });
            const runStore = new WorkflowRunStore({
              sessionDir: path.join(config.sessionsDir, workspaceId),
            });
            await runStore.createRun({
              id: "wfr_reread_fail",
              workspaceId,
              workflow: {
                name: "demo",
                description: "Demo workflow",
                scope: "global" as const,
                executable: true,
              },
              source: "export default function workflow() { return {}; }",
              args: {},
              now: "2026-06-17T00:00:00.000Z",
            });
          }
          // Every re-read after the initial one fails transiently.
          throw new Error("transient metadata read failure");
        }
      );
      try {
        const workspaceService = createWorkspaceServiceForTest({
          config,
          historyService,
          extensionMetadata,
        });

        const activityList = await workspaceService.getActivityList();
        expect(activityList).not.toBeNull();
        expect(activityList?.[workspaceId]?.activeWorkflowRunCount).toBe(1);
        expect(activityList?.[workspaceId]?.activeWorkflowRunIds).toEqual(["wfr_reread_fail"]);
      } finally {
        snapshotsSpy.mockRestore();
      }
    } finally {
      await cleanup();
    }
  });

  test("getActivityList bootstraps workflow-only legacy workspaces registered mid-list", async () => {
    // Combined raw-invisible + snapshotless case: a downgraded backend
    // registers an id-less legacy workspace mid-list and starts a workflow
    // WITHOUT writing extension metadata. The stable id appears in neither
    // the fresh raw view nor the fresh snapshots, so discovery must come
    // from the authoritative enumeration triggered by the raw evidence's
    // id-less-entry signal.
    const { config, historyService, cleanup } = await createTestHistoryService();
    try {
      const stableId = "late-legacy-workflow-only";
      const projectPath = path.join(config.rootDir, "project");
      const workspacePath = path.join(projectPath, "legacy-ws");
      const configPath = path.join(config.rootDir, "config.json");
      const extensionMetadata = new ExtensionMetadataService(
        path.join(config.rootDir, "extensionMetadata.json")
      );
      const realGetAllSnapshots = extensionMetadata.getAllSnapshots.bind(extensionMetadata);
      let snapshotCalls = 0;
      const snapshotsSpy = spyOn(extensionMetadata, "getAllSnapshots").mockImplementation(
        async (options?: { throwOnError?: boolean }) => {
          snapshotCalls += 1;
          if (snapshotCalls === 2) {
            await fsPromises.writeFile(
              configPath,
              JSON.stringify({
                projects: [[projectPath, { workspaces: [{ path: workspacePath }] }]],
              })
            );
            const legacySessionDir = path.join(
              config.sessionsDir,
              config.generateLegacyId(projectPath, workspacePath)
            );
            await fsPromises.mkdir(legacySessionDir, { recursive: true });
            await fsPromises.writeFile(
              path.join(legacySessionDir, "metadata.json"),
              JSON.stringify({ id: stableId, name: "legacy-ws" })
            );
            const runStore = new WorkflowRunStore({
              sessionDir: path.join(config.sessionsDir, stableId),
            });
            await runStore.createRun({
              id: "wfr_legacy_only",
              workspaceId: stableId,
              workflow: {
                name: "demo",
                description: "Demo workflow",
                scope: "global" as const,
                executable: true,
              },
              source: "export default function workflow() { return {}; }",
              args: {},
              now: "2026-06-17T00:00:00.000Z",
            });
          }
          return realGetAllSnapshots(options);
        }
      );
      try {
        const workspaceService = createWorkspaceServiceForTest({
          config,
          historyService,
          extensionMetadata,
        });

        const activityList = await workspaceService.getActivityList();
        expect(activityList?.[stableId]?.activeWorkflowRunCount).toBe(1);
        expect(activityList?.[stableId]?.activeWorkflowRunIds).toEqual(["wfr_legacy_only"]);
      } finally {
        snapshotsSpy.mockRestore();
      }
    } finally {
      await cleanup();
    }
  });

  test("getActivityList drops legacy additions deregistered during the workflow probe", async () => {
    // A raw-invisible legacy workspace admitted mid-list and deregistered
    // while the workflow probe awaits: every raw view is blind to it and its
    // metadata snapshot survives the deregistration gap, so only the
    // post-probe authoritative re-enumeration can prove the removal.
    const { config, historyService, cleanup } = await createTestHistoryService();
    const listStatusSnapshotsSpy = spyOn(WorkflowRunStore.prototype, "listRunStatusSnapshots");
    try {
      const stableId = "late-legacy-then-removed";
      const projectPath = path.join(config.rootDir, "project");
      const workspacePath = path.join(projectPath, "legacy-ws");
      const configPath = path.join(config.rootDir, "config.json");
      const extensionMetadata = new ExtensionMetadataService(
        path.join(config.rootDir, "extensionMetadata.json")
      );
      const realGetAllSnapshots = extensionMetadata.getAllSnapshots.bind(extensionMetadata);
      let snapshotCalls = 0;
      const snapshotsSpy = spyOn(extensionMetadata, "getAllSnapshots").mockImplementation(
        async (options?: { throwOnError?: boolean }) => {
          snapshotCalls += 1;
          if (snapshotCalls === 2) {
            await fsPromises.writeFile(
              configPath,
              JSON.stringify({
                projects: [[projectPath, { workspaces: [{ path: workspacePath }] }]],
              })
            );
            const legacySessionDir = path.join(
              config.sessionsDir,
              config.generateLegacyId(projectPath, workspacePath)
            );
            await fsPromises.mkdir(legacySessionDir, { recursive: true });
            await fsPromises.writeFile(
              path.join(legacySessionDir, "metadata.json"),
              JSON.stringify({ id: stableId, name: "legacy-ws" })
            );
            await extensionMetadata.updateRecency(stableId, 999);
          }
          return realGetAllSnapshots(options);
        }
      );
      listStatusSnapshotsSpy.mockImplementation(async () => {
        // Another backend deregisters the legacy workspace mid-probe; its
        // metadata snapshot intentionally survives (cleanup gap).
        await fsPromises.writeFile(configPath, JSON.stringify({ projects: [] }));
        return [];
      });
      try {
        const workspaceService = createWorkspaceServiceForTest({
          config,
          historyService,
          extensionMetadata,
        });

        const activityList = await workspaceService.getActivityList();
        expect(activityList).not.toBeNull();
        expect(activityList?.[stableId]).toBeUndefined();
      } finally {
        snapshotsSpy.mockRestore();
      }
    } finally {
      listStatusSnapshotsSpy.mockRestore();
      await cleanup();
    }
  });

  test("getActivityList drops late additions deregistered during the workflow probe", async () => {
    // A workspace registered AFTER the initial raw baseline and removed
    // while the workflow probe awaits sits in the normal gap between config
    // deregistration and extension-metadata cleanup: its snapshot still
    // exists, so only the post-probe raw config re-read (compared against
    // the fresh view that admitted it — the initial baseline never saw it)
    // can prove the removal.
    const { config, historyService, cleanup } = await createTestHistoryService();
    const listStatusSnapshotsSpy = spyOn(WorkflowRunStore.prototype, "listRunStatusSnapshots");
    try {
      const workspaceId = "late-then-deregistered";
      const projectPath = path.join(config.rootDir, "project");
      const configPath = path.join(config.rootDir, "config.json");
      const extensionMetadata = new ExtensionMetadataService(
        path.join(config.rootDir, "extensionMetadata.json")
      );
      const realGetAllSnapshots = extensionMetadata.getAllSnapshots.bind(extensionMetadata);
      let snapshotCalls = 0;
      const snapshotsSpy = spyOn(extensionMetadata, "getAllSnapshots").mockImplementation(
        async (options?: { throwOnError?: boolean }) => {
          snapshotCalls += 1;
          if (snapshotCalls === 2) {
            await config.addWorkspace(projectPath, {
              id: workspaceId,
              name: workspaceId,
              projectName: "project",
              projectPath,
              runtimeConfig: { type: "local" },
            });
            await extensionMetadata.updateRecency(workspaceId, 888);
          }
          return realGetAllSnapshots(options);
        }
      );
      listStatusSnapshotsSpy.mockImplementation(async () => {
        // Another backend deregisters the workspace mid-probe; its metadata
        // entry intentionally survives (cleanup has not run yet).
        await fsPromises.writeFile(configPath, JSON.stringify({ projects: [] }));
        return [];
      });
      try {
        const workspaceService = createWorkspaceServiceForTest({
          config,
          historyService,
          extensionMetadata,
        });

        const activityList = await workspaceService.getActivityList();
        expect(activityList).not.toBeNull();
        expect(activityList?.[workspaceId]).toBeUndefined();
      } finally {
        snapshotsSpy.mockRestore();
      }
    } finally {
      listStatusSnapshotsSpy.mockRestore();
      await cleanup();
    }
  });

  test("getActivityList drops mid-list additions removed during the workflow probe", async () => {
    // The workflow-run bootstrap for late merge candidates awaits disk; a
    // cross-process removal landing during that probe is invisible to every
    // guard view captured before it. The final post-probe snapshot re-read
    // must drop the entry instead of riding the deleted id back into the
    // renderer (the process-local subscription cannot correct it).
    const { config, historyService, cleanup } = await createTestHistoryService();
    const metadataPath = path.join(config.rootDir, "extensionMetadata.json");
    const listStatusSnapshotsSpy = spyOn(WorkflowRunStore.prototype, "listRunStatusSnapshots");
    try {
      const workspaceId = "late-then-removed";
      const projectPath = path.join(config.rootDir, "project");
      const extensionMetadata = new ExtensionMetadataService(metadataPath);
      const realGetAllSnapshots = extensionMetadata.getAllSnapshots.bind(extensionMetadata);
      let snapshotCalls = 0;
      const snapshotsSpy = spyOn(extensionMetadata, "getAllSnapshots").mockImplementation(
        async (options?: { throwOnError?: boolean }) => {
          snapshotCalls += 1;
          if (snapshotCalls === 2) {
            await config.addWorkspace(projectPath, {
              id: workspaceId,
              name: workspaceId,
              projectName: "project",
              projectPath,
              runtimeConfig: { type: "local" },
            });
            await extensionMetadata.updateRecency(workspaceId, 888);
          }
          return realGetAllSnapshots(options);
        }
      );
      listStatusSnapshotsSpy.mockImplementation(async () => {
        // Another backend removes the workspace while the probe is awaited:
        // its persisted metadata entry disappears, unseen by this process's
        // tombstones.
        await new ExtensionMetadataService(metadataPath).deleteWorkspace(workspaceId);
        return [];
      });
      try {
        const workspaceService = createWorkspaceServiceForTest({
          config,
          historyService,
          extensionMetadata,
        });

        const activityList = await workspaceService.getActivityList();
        expect(activityList).not.toBeNull();
        expect(activityList?.[workspaceId]).toBeUndefined();
      } finally {
        snapshotsSpy.mockRestore();
      }
    } finally {
      listStatusSnapshotsSpy.mockRestore();
      await cleanup();
    }
  });

  test("getActivityList drops retained entries removed during late workflow probes", async () => {
    // The retained-entry filter runs before the late-candidate workflow
    // probes await disk. A cross-process removal of an ALREADY-RETAINED
    // workspace landing during those probes is invisible to every view the
    // filter used — without the post-probe re-filter the removed id rides
    // the response back into the renderer with no event to correct it.
    const { config, historyService, cleanup } = await createTestHistoryService();
    const metadataPath = path.join(config.rootDir, "extensionMetadata.json");
    const listStatusSnapshotsSpy = spyOn(WorkflowRunStore.prototype, "listRunStatusSnapshots");
    try {
      const retainedId = "retained-then-removed";
      const lateId = "late-registered";
      const projectPath = path.join(config.rootDir, "project");
      await config.addWorkspace(projectPath, {
        id: retainedId,
        name: retainedId,
        projectName: "project",
        projectPath,
        runtimeConfig: { type: "local" },
      });
      const extensionMetadata = new ExtensionMetadataService(metadataPath);
      await extensionMetadata.updateRecency(retainedId, 555);
      const realGetAllSnapshots = extensionMetadata.getAllSnapshots.bind(extensionMetadata);
      let snapshotCalls = 0;
      const snapshotsSpy = spyOn(extensionMetadata, "getAllSnapshots").mockImplementation(
        async (options?: { throwOnError?: boolean }) => {
          snapshotCalls += 1;
          if (snapshotCalls === 2) {
            // Another backend registers a NEW workspace mid-list so the
            // merge has a late candidate whose probe awaits disk.
            await config.addWorkspace(projectPath, {
              id: lateId,
              name: lateId,
              projectName: "project",
              projectPath,
              runtimeConfig: { type: "local" },
            });
            await extensionMetadata.updateRecency(lateId, 777);
          }
          return realGetAllSnapshots(options);
        }
      );
      let probeCalls = 0;
      listStatusSnapshotsSpy.mockImplementation(async () => {
        probeCalls += 1;
        if (probeCalls === 2) {
          // The late candidate's probe is awaited: another backend removes
          // the RETAINED workspace — config deregistration first (the real
          // removeUnlocked order), then the metadata entry deletion unseen
          // by this process's tombstones.
          await config.removeWorkspace(retainedId);
          await new ExtensionMetadataService(metadataPath).deleteWorkspace(retainedId);
        }
        return [];
      });
      try {
        const workspaceService = createWorkspaceServiceForTest({
          config,
          historyService,
          extensionMetadata,
        });

        const activityList = await workspaceService.getActivityList();
        expect(activityList).not.toBeNull();
        expect(activityList?.[lateId]).toBeDefined();
        expect(activityList?.[retainedId]).toBeUndefined();
      } finally {
        snapshotsSpy.mockRestore();
      }
    } finally {
      listStatusSnapshotsSpy.mockRestore();
      await cleanup();
    }
  });

  test("getActivityList drops snapshotless legacy entries removed mid-list", async () => {
    // A legacy id-less config entry's stable id is resolved authoritatively
    // during enumeration and can never appear in the raw config-id baseline,
    // so the raw-superset removal comparison is blind to it. If another
    // backend removes the workspace while the per-id reads run, a
    // snapshotless (workflow-only) entry has no metadata-file revalidation
    // to catch it either — the authoritative findWorkspace recheck must
    // drop it instead of reinserting the removed workspace.
    const { config, historyService, cleanup } = await createTestHistoryService();
    try {
      const stableId = "legacy-stable-id";
      const projectPath = path.join(config.rootDir, "project");
      const workspacePath = path.join(projectPath, "legacy-ws");
      const configPath = path.join(config.rootDir, "config.json");
      await fsPromises.writeFile(
        configPath,
        JSON.stringify({
          projects: [[projectPath, { workspaces: [{ path: workspacePath }] }]],
        })
      );
      const legacySessionDir = path.join(
        config.sessionsDir,
        config.generateLegacyId(projectPath, workspacePath)
      );
      await fsPromises.mkdir(legacySessionDir, { recursive: true });
      await fsPromises.writeFile(
        path.join(legacySessionDir, "metadata.json"),
        JSON.stringify({ id: stableId, name: "legacy-ws" })
      );
      const extensionMetadata = new ExtensionMetadataService(
        path.join(config.rootDir, "extensionMetadata.json")
      );
      const workspaceService = createWorkspaceServiceForTest({
        config,
        historyService,
        extensionMetadata,
      });
      // Workflow-only activity: no persisted snapshot.
      await workspaceService.emitWorkflowRunActivity({
        workspaceId: stableId,
        runId: "legacy-run",
        status: "running",
      });
      // Simulate the cross-process removal between the entry computation and
      // the revalidation phase: the fresh metadata re-read is the first
      // revalidation step, so rewriting config.json there lands mid-list.
      const realGetAllSnapshots = extensionMetadata.getAllSnapshots.bind(extensionMetadata);
      let snapshotCalls = 0;
      const snapshotsSpy = spyOn(extensionMetadata, "getAllSnapshots").mockImplementation(
        async (options?: { throwOnError?: boolean }) => {
          snapshotCalls += 1;
          if (snapshotCalls === 2) {
            await fsPromises.writeFile(configPath, JSON.stringify({ projects: [] }));
          }
          return realGetAllSnapshots(options);
        }
      );
      try {
        const activityList = await workspaceService.getActivityList();
        expect(activityList).not.toBeNull();
        expect(activityList?.[stableId]).toBeUndefined();
      } finally {
        snapshotsSpy.mockRestore();
      }
    } finally {
      await cleanup();
    }
  });

  test("drops retained legacy entries removed during the mid-list identity scan", async () => {
    // An id-less legacy workspace is retained on the strength of the
    // mid-list authoritative enumeration — which can observe the stable id
    // right before another backend deregisters it and deletes its metadata
    // later in the same await. Raw config scans can never see the stable
    // id and the fresh snapshot re-read predates the removal, so with zero
    // late candidates nothing else re-reads: the final revalidation must
    // run for retained raw-invisible ids too, or the deleted workspace
    // rides every authoritative response until reconnect.
    const { config, historyService, cleanup } = await createTestHistoryService();
    try {
      const stableId = "legacy-retained-stable-id";
      const projectPath = path.join(config.rootDir, "project");
      const workspacePath = path.join(projectPath, "legacy-ws");
      const configPath = path.join(config.rootDir, "config.json");
      await fsPromises.writeFile(
        configPath,
        JSON.stringify({
          projects: [[projectPath, { workspaces: [{ path: workspacePath }] }]],
        })
      );
      const legacySessionDir = path.join(
        config.sessionsDir,
        config.generateLegacyId(projectPath, workspacePath)
      );
      await fsPromises.mkdir(legacySessionDir, { recursive: true });
      await fsPromises.writeFile(
        path.join(legacySessionDir, "metadata.json"),
        JSON.stringify({ id: stableId, name: "legacy-ws" })
      );
      const metadataPath = path.join(config.rootDir, "extensionMetadata.json");
      const extensionMetadata = new ExtensionMetadataService(metadataPath);
      // Persisted snapshot: the entry is RETAINED by the per-id loop, so
      // the late-candidate merge has nothing to probe.
      await extensionMetadata.updateRecency(stableId, 321);
      const workspaceService = createWorkspaceServiceForTest({
        config,
        historyService,
        extensionMetadata,
      });
      const internals = workspaceService as unknown as {
        enumerateAuthoritativeWorkspaceIds(): Promise<Set<string>>;
      };
      const realEnumerate = internals.enumerateAuthoritativeWorkspaceIds.bind(workspaceService);
      let enumerateCalls = 0;
      internals.enumerateAuthoritativeWorkspaceIds = async () => {
        enumerateCalls += 1;
        const ids = await realEnumerate();
        if (enumerateCalls === 2) {
          // The removal lands INSIDE the mid-list enumeration await, after
          // the enumeration observed the id: config deregistration first
          // (the real removal write order), then the metadata deletion by
          // another backend (no local tombstone).
          await fsPromises.writeFile(configPath, JSON.stringify({ projects: [] }));
          await new ExtensionMetadataService(metadataPath).deleteWorkspace(stableId);
        }
        return ids;
      };
      const activityList = await workspaceService.getActivityList();
      expect(activityList).not.toBeNull();
      expect(activityList?.[stableId]).toBeUndefined();
    } finally {
      await cleanup();
    }
  });

  test("getActivityList quarantines a deterministically corrupt metadata file", async () => {
    // Parse/structure corruption fails identically on every retry, so a
    // strict read that only rethrows would leave activity hydration broken
    // across restarts until some unrelated writer replaced the file. The
    // strict path quarantines the bytes (preserved for inspection, never
    // silently deleted) and the resulting empty state is authoritative.
    // Note: a valid file with version !== 1 is deliberately NOT here — that
    // is a newer build's schema, treated as unsupported (propagated, never
    // quarantined/reset) so a downgrade round-trip cannot destroy it.
    const corruptFiles = [
      "{not json",
      JSON.stringify({ version: 1, workspaces: [] }),
      JSON.stringify({ version: 1, workspaces: "bogus" }),
      JSON.stringify({ version: 1, workspaces: null }),
    ];
    for (const corruptFile of corruptFiles) {
      const { config, historyService, cleanup } = await createTestHistoryService();
      try {
        const metadataPath = path.join(config.rootDir, "extensionMetadata.json");
        await fsPromises.writeFile(metadataPath, corruptFile, "utf-8");
        const extensionMetadata = new ExtensionMetadataService(metadataPath);
        const workspaceService = createWorkspaceServiceForTest({
          config,
          historyService,
          extensionMetadata,
        });

        // Lenient reads (writer paths) self-heal without quarantining.
        expect((await extensionMetadata.getAllSnapshots()).size).toBe(0);
        expect(await fsPromises.readFile(metadataPath, "utf-8")).toBe(corruptFile);

        const activityList = await workspaceService.getActivityList();
        expect(activityList).toEqual({});
        // The corrupt bytes were moved aside, not destroyed.
        expect(await fsPromises.readFile(`${metadataPath}.corrupt`, "utf-8")).toBe(corruptFile);
        // Quarantine must leave a valid EMPTY main file behind (never a
        // missing path): readers of a missing-main-plus-sidecar state treat
        // it as a retryable mid-quarantine window, not authoritative empty.
        expect(JSON.parse(await fsPromises.readFile(metadataPath, "utf-8"))).toEqual({
          version: 1,
          workspaces: {},
        });
      } finally {
        await cleanup();
      }
    }
  });

  test("getActivityList returns null when the metadata path exists but cannot be read", async () => {
    // Only a genuinely missing file (ENOENT) is a healthy empty state. Any
    // other read failure (here EISDIR; EACCES/ENOTDIR/EIO in the field) must
    // surface as the null read-failure signal instead of masquerading as an
    // authoritative empty list.
    const { config, historyService, cleanup } = await createTestHistoryService();
    try {
      const metadataPath = path.join(config.rootDir, "extensionMetadata.json");
      await fsPromises.mkdir(metadataPath, { recursive: true });
      const extensionMetadata = new ExtensionMetadataService(metadataPath);
      const workspaceService = createWorkspaceServiceForTest({
        config,
        historyService,
        extensionMetadata,
      });

      // Lenient reads (writer paths) still self-heal.
      expect((await extensionMetadata.getAllSnapshots()).size).toBe(0);

      expect(await workspaceService.getActivityList()).toBeNull();
    } finally {
      await cleanup();
    }
  });

  test("getActivityList drops workspaces removed while the list was computing", async () => {
    // A removal that lands between the snapshot read and the response must
    // not ride the delayed list past emitWorkspaceActivity's tombstone
    // suppression: a renderer that already processed the removal event would
    // re-insert the deleted id until the next reconnect.
    const { config, historyService, cleanup } = await createTestHistoryService();
    try {
      const workspaceId = "removed-mid-list";
      const projectPath = path.join(config.rootDir, "project");
      await config.addWorkspace(projectPath, {
        id: workspaceId,
        name: workspaceId,
        projectName: "project",
        projectPath,
        runtimeConfig: { type: "local" },
      });
      const extensionMetadata = new ExtensionMetadataService(
        path.join(config.rootDir, "extensionMetadata.json")
      );
      await extensionMetadata.updateRecency(workspaceId, 100);
      const readSnapshots = extensionMetadata.getAllSnapshots.bind(extensionMetadata);
      spyOn(extensionMetadata, "getAllSnapshots").mockImplementationOnce(async () => {
        const snapshots = await readSnapshots();
        // Simulates a concurrent removal completing after this request read
        // its snapshot view but before the response was assembled — in the
        // real removeUnlocked order: config deregistration first, then the
        // metadata deletion.
        await config.removeWorkspace(workspaceId);
        await extensionMetadata.deleteWorkspace(workspaceId);
        return snapshots;
      });
      const workspaceService = createWorkspaceServiceForTest({
        config,
        historyService,
        extensionMetadata,
      });

      const activityList = await workspaceService.getActivityList();
      expect(activityList).not.toBeNull();
      expect(activityList?.[workspaceId]).toBeUndefined();
    } finally {
      await cleanup();
    }
  });

  test("getActivityList drops entries whose metadata another process removed mid-list", async () => {
    // XUM_ALLOW_MULTIPLE_INSTANCES: a removal in another backend never
    // reaches this process's in-memory tombstones, so the final response
    // revalidates against a fresh read of the shared file instead.
    const { config, historyService, cleanup } = await createTestHistoryService();
    try {
      const workspaceId = "removed-by-other-process";
      const projectPath = path.join(config.rootDir, "project");
      await config.addWorkspace(projectPath, {
        id: workspaceId,
        name: workspaceId,
        projectName: "project",
        projectPath,
        runtimeConfig: { type: "local" },
      });
      const metadataPath = path.join(config.rootDir, "extensionMetadata.json");
      const extensionMetadata = new ExtensionMetadataService(metadataPath);
      await extensionMetadata.updateRecency(workspaceId, 100);
      const readSnapshots = extensionMetadata.getAllSnapshots.bind(extensionMetadata);
      spyOn(extensionMetadata, "getAllSnapshots").mockImplementationOnce(async (options) => {
        const snapshots = await readSnapshots(options);
        // Simulates another backend's removal landing after this request read
        // its snapshot view: rewrite the shared file without the entry, with
        // no in-process deleteWorkspace tombstone. Faithful to the removal
        // protocol's write order (removeUnlocked deregisters config BEFORE
        // deleting metadata): a vanished snapshot with config still
        // registering the id is a corruption-reset lookalike and must be
        // retained, so removal simulations must deregister first.
        await config.removeWorkspace(workspaceId);
        await fsPromises.writeFile(
          metadataPath,
          JSON.stringify({ version: 1, workspaces: {} }),
          "utf-8"
        );
        return snapshots;
      });
      const workspaceService = createWorkspaceServiceForTest({
        config,
        historyService,
        extensionMetadata,
      });

      const activityList = await workspaceService.getActivityList();
      expect(activityList).not.toBeNull();
      expect(activityList?.[workspaceId]).toBeUndefined();
      // The removal was detected from foreign evidence — and retained as a
      // local tombstone: cache eviction alone cannot stop a LATE local
      // producer (workflow-run/bash-monitor completion) from re-emitting
      // the removed incarnation's activity right after this authoritative
      // response dropped it, because emitWorkspaceActivity's
      // isWorkspaceDeleted check only knows local removals.
      expect(extensionMetadata.isWorkspaceDeleted(workspaceId)).toBe(true);
      // A late producer's write stays unpersisted (transient) instead of
      // recreating the removed entry on disk.
      await extensionMetadata.updateRecency(workspaceId, 200);
      expect((await extensionMetadata.getAllSnapshots()).has(workspaceId)).toBe(false);
    } finally {
      await cleanup();
    }
  });

  test("getActivityList drops entries another process deregistered from config mid-list", async () => {
    // Covers entries without a persisted snapshot too: the metadata-file
    // revalidation cannot see workflow/bash-monitor-only entries, so final
    // membership is also re-checked against the shared config state.
    const { config, historyService, cleanup } = await createTestHistoryService();
    try {
      const workspaceId = "deregistered-by-other-process";
      const projectPath = path.join(config.rootDir, "project");
      await config.addWorkspace(projectPath, {
        id: workspaceId,
        name: workspaceId,
        projectName: "project",
        projectPath,
        runtimeConfig: { type: "local" },
      });
      const extensionMetadata = new ExtensionMetadataService(
        path.join(config.rootDir, "extensionMetadata.json")
      );
      await extensionMetadata.updateRecency(workspaceId, 100);
      const readSnapshots = extensionMetadata.getAllSnapshots.bind(extensionMetadata);
      spyOn(extensionMetadata, "getAllSnapshots").mockImplementationOnce(async (options) => {
        const snapshots = await readSnapshots(options);
        // Simulates another backend deregistering the workspace after this
        // request read its snapshot view. The metadata entry stays behind, so
        // only the fresh config membership check can catch it.
        await config.removeWorkspace(workspaceId);
        return snapshots;
      });
      const workspaceService = createWorkspaceServiceForTest({
        config,
        historyService,
        extensionMetadata,
      });

      const activityList = await workspaceService.getActivityList();
      expect(activityList).not.toBeNull();
      expect(activityList?.[workspaceId]).toBeUndefined();
      // Foreign removals proven by the list guards publish a local
      // tombstone (late-producer suppression — see the metadata-removal
      // test above).
      expect(extensionMetadata.isWorkspaceDeleted(workspaceId)).toBe(true);
    } finally {
      await cleanup();
    }
  });

  test("getActivityList returns null on metadata read failure instead of {}", async () => {
    // With scoping, {} is a valid authoritative answer that clears renderer
    // state; failures must be distinguishable (null) so the renderer keeps
    // its last-known snapshots and retries.
    const { config, historyService, cleanup } = await createTestHistoryService();
    try {
      const extensionMetadata = new ExtensionMetadataService(
        path.join(config.rootDir, "extensionMetadata.json")
      );
      const snapshotsSpy = spyOn(extensionMetadata, "getAllSnapshots").mockImplementation(() =>
        Promise.reject(new Error("metadata unreadable"))
      );
      try {
        const workspaceService = createWorkspaceServiceForTest({
          config,
          historyService,
          extensionMetadata,
        });
        expect(await workspaceService.getActivityList()).toBeNull();
      } finally {
        snapshotsSpy.mockRestore();
      }
    } finally {
      await cleanup();
    }
  });

  test("falls back to the unscoped union when config workspaces cannot be listed", async () => {
    // Real on-disk corruption shapes. loadConfigOrDefault SWALLOWS the first
    // (parse failure) and lenient-normalizes the rest (parseable but
    // structurally invalid) into an empty/partial workspace view unless
    // callers opt into the strict read. Without throwOnError + strict
    // structural validation, each of these states would silently wipe every
    // metadata entry (prune sees an "empty" config) and drop every live
    // entry from the list instead of reaching the fail-open fallback.
    const corruptConfigs = [
      "{not json",
      JSON.stringify({ projects: {} }),
      JSON.stringify({ projects: [["/tmp/project", { workspaces: "bogus" }]] }),
      // Arrays pass typeof "object": lenient normalization turns an
      // array-valued project config into a project with no workspaces.
      JSON.stringify({ projects: [["/tmp/project", []]] }),
    ];
    for (const corruptConfig of corruptConfigs) {
      const { config, historyService, cleanup } = await createTestHistoryService();
      try {
        const extensionMetadata = new ExtensionMetadataService(
          path.join(config.rootDir, "extensionMetadata.json")
        );
        await extensionMetadata.updateRecency("possibly-live", 100);
        await fsPromises.writeFile(path.join(config.rootDir, "config.json"), corruptConfig);
        const workspaceService = createWorkspaceServiceForTest({
          config,
          historyService,
          extensionMetadata,
        });
        // Fail open: without a trustworthy config view, stale ids cannot be
        // told apart from live ones, so nothing may be dropped from the list
        // or pruned from disk.
        const activityList = await workspaceService.getActivityList();
        expect(activityList?.["possibly-live"]?.recency).toBe(100);
        expect((await extensionMetadata.getAllSnapshots()).has("possibly-live")).toBe(true);
      } finally {
        await cleanup();
      }
    }
  });

  test("falls back to the unscoped union when config.json exists but cannot be read", async () => {
    // EISDIR here; EACCES/ENOTDIR/EIO in the field. existsSync-style probes
    // report all of these as "missing", which would masquerade as an empty
    // config and let the prune delete every metadata entry instead of
    // failing open.
    const { config, historyService, cleanup } = await createTestHistoryService();
    try {
      const extensionMetadata = new ExtensionMetadataService(
        path.join(config.rootDir, "extensionMetadata.json")
      );
      await extensionMetadata.updateRecency("possibly-live", 100);
      const configPath = path.join(config.rootDir, "config.json");
      await fsPromises.rm(configPath, { force: true });
      await fsPromises.mkdir(configPath);
      const workspaceService = createWorkspaceServiceForTest({
        config,
        historyService,
        extensionMetadata,
      });

      const activityList = await workspaceService.getActivityList();
      expect(activityList?.["possibly-live"]?.recency).toBe(100);
      expect((await extensionMetadata.getAllSnapshots()).has("possibly-live")).toBe(true);
    } finally {
      await cleanup();
    }
  });

  test("fails open when a legacy workspace's identity lookup fails", async () => {
    // A legacy config entry without an id resolves its authoritative stable
    // id from its session metadata.json. If that file is unreadable or
    // unparseable, the lenient path substitutes the generated path id — the
    // strict enumeration must instead propagate the failure so the prune
    // cannot classify the real stable id's entries as stale.
    const { config, historyService, cleanup } = await createTestHistoryService();
    try {
      const extensionMetadata = new ExtensionMetadataService(
        path.join(config.rootDir, "extensionMetadata.json")
      );
      await extensionMetadata.updateRecency("legacy-stable-id", 100);
      const projectPath = path.join(config.rootDir, "project");
      const workspacePath = path.join(projectPath, "legacy-ws");
      await fsPromises.writeFile(
        path.join(config.rootDir, "config.json"),
        JSON.stringify({
          projects: [[projectPath, { workspaces: [{ path: workspacePath }] }]],
        })
      );
      // Corrupt the metadata.json holding that entry's stable id.
      const legacySessionDir = path.join(
        config.sessionsDir,
        config.generateLegacyId(projectPath, workspacePath)
      );
      await fsPromises.mkdir(legacySessionDir, { recursive: true });
      await fsPromises.writeFile(path.join(legacySessionDir, "metadata.json"), "{not json");
      const workspaceService = createWorkspaceServiceForTest({
        config,
        historyService,
        extensionMetadata,
      });

      const activityList = await workspaceService.getActivityList();
      // Fail open: the identity of the legacy workspace is unknowable, so
      // nothing may be dropped from the list or pruned from disk.
      expect(activityList?.["legacy-stable-id"]?.recency).toBe(100);
      expect((await extensionMetadata.getAllSnapshots()).has("legacy-stable-id")).toBe(true);
    } finally {
      await cleanup();
    }
  });

  test("fails open when a legacy metadata.json parses without a usable id", async () => {
    // Successful JSON parsing does not establish identity: `{}` (or an
    // array) passes the parse but resolves an id-less entry, and the raw
    // config has no id to contribute. Strict enumeration must fail closed
    // exactly like the unparseable case above, or the prune classifies the
    // real stable id's entries as stale and deletes them.
    const idlessMetadataFiles = ["{}", "[]"];
    for (const idlessMetadataFile of idlessMetadataFiles) {
      const { config, historyService, cleanup } = await createTestHistoryService();
      try {
        const extensionMetadata = new ExtensionMetadataService(
          path.join(config.rootDir, "extensionMetadata.json")
        );
        await extensionMetadata.updateRecency("legacy-stable-id", 100);
        const projectPath = path.join(config.rootDir, "project");
        const workspacePath = path.join(projectPath, "legacy-ws");
        await fsPromises.writeFile(
          path.join(config.rootDir, "config.json"),
          JSON.stringify({
            projects: [[projectPath, { workspaces: [{ path: workspacePath }] }]],
          })
        );
        const legacySessionDir = path.join(
          config.sessionsDir,
          config.generateLegacyId(projectPath, workspacePath)
        );
        await fsPromises.mkdir(legacySessionDir, { recursive: true });
        await fsPromises.writeFile(
          path.join(legacySessionDir, "metadata.json"),
          idlessMetadataFile
        );
        const workspaceService = createWorkspaceServiceForTest({
          config,
          historyService,
          extensionMetadata,
        });

        const activityList = await workspaceService.getActivityList();
        expect(activityList?.["legacy-stable-id"]?.recency).toBe(100);
        expect((await extensionMetadata.getAllSnapshots()).has("legacy-stable-id")).toBe(true);
      } finally {
        await cleanup();
      }
    }
  });

  test("never prunes entries whose config entry is discarded by normalization", async () => {
    // A parseable config entry that lenient normalization filters out (null
    // project path): the workspace vanishes from the normalized view — and
    // thus from the activity list, matching every other renderer surface —
    // but its metadata entry must survive the prune. Two guards enforce it:
    // strict loads reject the malformed project key outright (aborting the
    // prune, fail closed), and the raw-superset union spares the inline id
    // even if enumeration were to succeed.
    const { config, historyService, cleanup } = await createTestHistoryService();
    try {
      const extensionMetadata = new ExtensionMetadataService(
        path.join(config.rootDir, "extensionMetadata.json")
      );
      await extensionMetadata.updateRecency("possibly-live", 100);
      await fsPromises.writeFile(
        path.join(config.rootDir, "config.json"),
        JSON.stringify({
          projects: [[null, { workspaces: [{ id: "possibly-live", path: "/tmp/x" }] }]],
        })
      );
      const workspaceService = createWorkspaceServiceForTest({
        config,
        historyService,
        extensionMetadata,
      });
      await workspaceService.getActivityList();
      expect((await extensionMetadata.getAllSnapshots()).has("possibly-live")).toBe(true);
    } finally {
      await cleanup();
    }
  });

  test("prunes the extension metadata entry after a workspace is removed", async () => {
    const { historyService, cleanup } = await createTestHistoryService();
    const workspaceId = "remove-prunes-metadata";
    const tempRoot = await fsPromises.mkdtemp(path.join(tmpdir(), "mux-remove-metadata-"));
    try {
      const sessionRoot = path.join(tempRoot, "sessions");
      await fsPromises.mkdir(path.join(sessionRoot, workspaceId), { recursive: true });

      const deleteWorkspace = mock(() => Promise.resolve());
      const extensionMetadata = {
        ...mockExtensionMetadataService,
        deleteWorkspace,
      } as unknown as ExtensionMetadataService;
      const mockConfig: MockWorkspaceConfig = {
        rootDir: path.join(tempRoot, "root"),
        srcDir: "/tmp/src",
        sessionsDir: sessionRoot,
        removeWorkspace: mock(() => Promise.resolve()),
        findWorkspace: mock(() => null),
        loadConfigOrDefault: mock(() => ({ projects: new Map() })),
        // The discard verifies deregistration against the persisted superset
        // (and the findWorkspace mock above) before deleting.
        readPersistedWorkspaceIdSuperset: mock(() => new Set<string>()),
        getAllWorkspaceMetadata: mock(() => Promise.resolve([])),
      };
      const workspaceService = createWorkspaceServiceForTest({
        config: mockConfig,
        historyService,
        extensionMetadata,
        aiService: createMockAIService({
          isStreaming: mock(() => false),
          stopStream: mock(() => Promise.resolve(Ok(undefined))),
          getWorkspaceMetadata: mock(() =>
            Promise.resolve(
              Ok(createFrontendWorkspaceMetadata({ id: workspaceId, name: workspaceId }))
            )
          ),
        }),
      });

      const removeResult = await workspaceService.remove(workspaceId, true);
      expect(removeResult.success).toBe(true);
      expect(deleteWorkspace).toHaveBeenCalledWith(workspaceId);
    } finally {
      await fsPromises.rm(tempRoot, { recursive: true, force: true });
      await cleanup();
    }
  });

  test("discardExtensionMetadataEntry swallows deletion failures", async () => {
    // Rollback paths (e.g. TaskService's failed task-create rollback) call
    // this best-effort; a metadata disk failure must not abort the rollback.
    const { config, historyService, cleanup } = await createTestHistoryService();
    try {
      const deleteWorkspace = mock(() => Promise.reject(new Error("disk full")));
      const workspaceService = createWorkspaceServiceForTest({
        config,
        historyService,
        extensionMetadata: {
          ...mockExtensionMetadataService,
          deleteWorkspace,
        } as unknown as ExtensionMetadataService,
      });

      await workspaceService.discardExtensionMetadataEntry("rollback-ws");
      expect(deleteWorkspace).toHaveBeenCalledWith("rollback-ws");
    } finally {
      await cleanup();
    }
  });
});

describe("WorkspaceService workflow invocation events", () => {
  test("emits workflow slash invocation rows through the active session chat stream", async () => {
    const { config, historyService, cleanup } = await createTestHistoryService();
    const workspaceId = "workflow-live-events";
    const projectPath = path.join(config.rootDir, "project");
    try {
      await config.addWorkspace(projectPath, {
        id: workspaceId,
        name: "workflow-live-events",
        projectName: "project",
        projectPath,
        runtimeConfig: { type: "local" },
      });
      const workspaceService = createWorkspaceServiceForTest({
        config,
        historyService,
        aiService: createMockAIService({
          stopStream: mock(() => Promise.resolve(Ok(undefined))),
        }),
        extensionMetadata: new ExtensionMetadataService(
          path.join(config.rootDir, "extensionMetadata.json")
        ),
        initStateManager: {
          ...mockInitStateManager,
          off: mock(() => undefined as unknown as InitStateManager),
        } as unknown as InitStateManager,
      });
      const session = workspaceService.getOrCreateSession(workspaceId);
      const events: WorkspaceChatMessage[] = [];
      const unsubscribe = session.onChatEvent(({ message }) => {
        events.push(message);
      });

      try {
        const persisted = await workspaceService.appendWorkflowRunInvocation({
          workspaceId,
          rawCommand: "/demo investigate live events",
          scriptPath: "./workflows/demo.js",
          args: { input: "investigate live events" },
          runId: "wfr_live_events",
          status: "running",
          result: null,
        });

        expect(persisted).toBe(true);
        expect(events).toHaveLength(2);
        const triggerMessage = events[0];
        const cardMessage = events[1];
        if (triggerMessage?.type !== "message" || cardMessage?.type !== "message") {
          throw new Error("Expected workflow invocation to emit message events");
        }
        expect(triggerMessage).toMatchObject({ role: "user", type: "message" });
        expect(triggerMessage.metadata?.muxMetadata).toEqual(
          expect.objectContaining({ type: WORKFLOW_TRIGGER_DISPLAY_METADATA_TYPE })
        );
        expect(cardMessage).toMatchObject({ role: "assistant", type: "message" });
        expect(cardMessage.metadata?.muxMetadata).toEqual(
          expect.objectContaining({ type: WORKFLOW_RUN_CARD_DISPLAY_METADATA_TYPE })
        );
      } finally {
        unsubscribe();
        await workspaceService.disposeSession(workspaceId);
      }
    } finally {
      await cleanup();
    }
  });

  test("keeps workflow invocations current across synthetic user continuations", async () => {
    const { config, historyService, cleanup } = await createTestHistoryService();
    const workspaceId = "workflow-currentness";
    const runId = "wfr_currentness";
    const projectPath = path.join(config.rootDir, "project");
    try {
      await config.addWorkspace(projectPath, {
        id: workspaceId,
        name: "workflow-currentness",
        projectName: "project",
        projectPath,
        runtimeConfig: { type: "local" },
      });
      const workspaceService = createWorkspaceServiceForTest({
        config,
        historyService,
        aiService: createMockAIService({
          stopStream: mock(() => Promise.resolve(Ok(undefined))),
        }),
        extensionMetadata: new ExtensionMetadataService(
          path.join(config.rootDir, "extensionMetadata.json")
        ),
        initStateManager: {
          ...mockInitStateManager,
          off: mock(() => undefined as unknown as InitStateManager),
        } as unknown as InitStateManager,
      });

      await historyService.appendToHistory(
        workspaceId,
        createMuxMessage("assistant-workflow-run", "assistant", "", { timestamp: 1_000 }, [
          {
            type: "dynamic-tool",
            toolCallId: "workflow-call-1",
            toolName: "workflow_run",
            state: "output-available",
            input: { script_path: "./workflows/demo.js", args: {}, run_in_background: true },
            output: { status: "running", runId, result: null },
          },
        ])
      );
      await historyService.appendToHistory(
        workspaceId,
        createMuxMessage("synthetic-await", "user", "Call task_await", {
          timestamp: 1_100,
          synthetic: true,
        })
      );

      expect(await workspaceService.isWorkflowInvocationCurrent(workspaceId, runId)).toBe(true);

      await historyService.appendToHistory(
        workspaceId,
        createMuxMessage("manual-user", "user", "Never mind, answer something else", {
          timestamp: 1_200,
        })
      );

      expect(await workspaceService.isWorkflowInvocationCurrent(workspaceId, runId)).toBe(false);
      await workspaceService.disposeSession(workspaceId);
    } finally {
      await cleanup();
    }
  });

  test("counts workflow_resume output as the current invocation after manual supersession", async () => {
    const { config, historyService, cleanup } = await createTestHistoryService();
    const workspaceId = "workflow-currentness-resume";
    const runId = "wfr_currentness_resume";
    const projectPath = path.join(config.rootDir, "project");
    try {
      await config.addWorkspace(projectPath, {
        id: workspaceId,
        name: "workflow-currentness-resume",
        projectName: "project",
        projectPath,
        runtimeConfig: { type: "local" },
      });
      const workspaceService = createWorkspaceServiceForTest({
        config,
        historyService,
        aiService: createMockAIService({
          stopStream: mock(() => Promise.resolve(Ok(undefined))),
        }),
        extensionMetadata: new ExtensionMetadataService(
          path.join(config.rootDir, "extensionMetadata.json")
        ),
        initStateManager: {
          ...mockInitStateManager,
          off: mock(() => undefined as unknown as InitStateManager),
        } as unknown as InitStateManager,
      });

      await historyService.appendToHistory(
        workspaceId,
        createMuxMessage("assistant-workflow-run", "assistant", "", { timestamp: 1_000 }, [
          {
            type: "dynamic-tool",
            toolCallId: "workflow-call-1",
            toolName: "workflow_run",
            state: "output-available",
            input: { script_path: "./workflows/demo.js", args: {}, run_in_background: true },
            output: { status: "running", runId, result: null },
          },
        ])
      );
      await historyService.appendToHistory(
        workspaceId,
        createMuxMessage("manual-user", "user", "Never mind, answer something else", {
          timestamp: 1_100,
        })
      );

      expect(await workspaceService.isWorkflowInvocationCurrent(workspaceId, runId)).toBe(false);

      // An unrelated tool output mentioning the run does not re-establish the invocation.
      await historyService.appendToHistory(
        workspaceId,
        createMuxMessage("assistant-unrelated-tool", "assistant", "", { timestamp: 1_200 }, [
          {
            type: "dynamic-tool",
            toolCallId: "task-list-1",
            toolName: "task_list",
            state: "output-available",
            input: {},
            output: { status: "running", runId, result: null },
          },
        ])
      );

      expect(await workspaceService.isWorkflowInvocationCurrent(workspaceId, runId)).toBe(false);

      // workflow_resume re-attaches the agent to the run, so the invocation counts as current
      // again and the terminal continuation would be delivered.
      await historyService.appendToHistory(
        workspaceId,
        createMuxMessage("assistant-workflow-resume", "assistant", "", { timestamp: 1_300 }, [
          {
            type: "dynamic-tool",
            toolCallId: "workflow-resume-1",
            toolName: "workflow_resume",
            state: "output-available",
            input: { run_id: runId, mode: "resume", run_in_background: true },
            output: { status: "running", runId, result: null },
          },
        ])
      );

      expect(await workspaceService.isWorkflowInvocationCurrent(workspaceId, runId)).toBe(true);
      await workspaceService.disposeSession(workspaceId);
    } finally {
      await cleanup();
    }
  });

  test("counts a kernel-launched run recorded in the sidecar as the current invocation", async () => {
    const { config, historyService, cleanup } = await createTestHistoryService();
    const workspaceId = "workflow-currentness-kernel";
    const runId = "wfr_currentness_kernel";
    const projectPath = path.join(config.rootDir, "project");
    try {
      await config.addWorkspace(projectPath, {
        id: workspaceId,
        name: "workflow-currentness-kernel",
        projectName: "project",
        projectPath,
        runtimeConfig: { type: "local" },
      });
      const workspaceService = createWorkspaceServiceForTest({
        config,
        historyService,
        aiService: createMockAIService({
          stopStream: mock(() => Promise.resolve(Ok(undefined))),
        }),
        extensionMetadata: new ExtensionMetadataService(
          path.join(config.rootDir, "extensionMetadata.json")
        ),
        initStateManager: {
          ...mockInitStateManager,
          off: mock(() => undefined as unknown as InitStateManager),
        } as unknown as InitStateManager,
      });

      // mux.workflow_run inside code_execution leaves no workflow_run tool part in history; the
      // agent-workflow-runs sidecar reference is the only durable invocation evidence.
      await historyService.appendToHistory(
        workspaceId,
        createMuxMessage("manual-user", "user", "run the audit workflow", { timestamp: 1_000 })
      );
      await historyService.appendToHistory(
        workspaceId,
        createMuxMessage("assistant-kernel-launch", "assistant", "", { timestamp: 1_100 }, [
          {
            type: "dynamic-tool",
            toolCallId: "code-exec-1",
            toolName: "code_execution",
            state: "output-available",
            input: { code: "return xum.workflow_run({ script_path: './workflows/demo.js' })" },
            output: { success: true, result: { status: "running", runId } },
          },
        ])
      );

      // The nested runId in the code_execution output alone is not invocation evidence.
      expect(await workspaceService.isWorkflowInvocationCurrent(workspaceId, runId)).toBe(false);

      await recordAgentWorkflowRunReference({
        workspaceSessionDir: path.join(config.sessionsDir, workspaceId),
        runId,
        createdAtMs: 1_150,
        afterBoundaryMessageId: "manual-user",
      });
      expect(await workspaceService.isWorkflowInvocationCurrent(workspaceId, runId)).toBe(true);

      // A newer manual user message supersedes the sidecar reference.
      await historyService.appendToHistory(
        workspaceId,
        createMuxMessage("manual-user-2", "user", "never mind, answer something else", {
          timestamp: 1_200,
        })
      );
      expect(await workspaceService.isWorkflowInvocationCurrent(workspaceId, runId)).toBe(false);

      // A kernel workflow_resume re-records the reference after the supersession and
      // re-establishes provenance (latest record wins).
      await recordAgentWorkflowRunReference({
        workspaceSessionDir: path.join(config.sessionsDir, workspaceId),
        runId,
        createdAtMs: 1_250,
        afterBoundaryMessageId: "manual-user-2",
      });
      expect(await workspaceService.isWorkflowInvocationCurrent(workspaceId, runId)).toBe(true);

      // Once the terminal result was delivered, the sidecar must not resurrect the invocation.
      await historyService.appendToHistory(
        workspaceId,
        createMuxMessage("workflow-result", "user", "The workflow below has finished.", {
          timestamp: 1_300,
          synthetic: true,
          muxMetadata: {
            type: WORKFLOW_RESULT_METADATA_TYPE,
            rawCommand: "workflow_run ./workflows/demo.js",
            runId,
          },
        })
      );
      expect(await workspaceService.isWorkflowInvocationCurrent(workspaceId, runId)).toBe(false);

      // A kernel background resume issued after the delivered result re-records the reference,
      // so the retried run's next terminal wake must count as current again.
      await recordAgentWorkflowRunReference({
        workspaceSessionDir: path.join(config.sessionsDir, workspaceId),
        runId,
        createdAtMs: 1_350,
        afterBoundaryMessageId: "workflow-result",
      });
      expect(await workspaceService.isWorkflowInvocationCurrent(workspaceId, runId)).toBe(true);
      await workspaceService.disposeSession(workspaceId);
    } finally {
      await cleanup();
    }
  });

  test("does not treat sidecar references as current after a full history clear", async () => {
    const { config, historyService, cleanup } = await createTestHistoryService();
    const workspaceId = "workflow-currentness-cleared";
    const runId = "wfr_currentness_cleared";
    const projectPath = path.join(config.rootDir, "project");
    try {
      await config.addWorkspace(projectPath, {
        id: workspaceId,
        name: "workflow-currentness-cleared",
        projectName: "project",
        projectPath,
        runtimeConfig: { type: "local" },
      });
      const workspaceService = createWorkspaceServiceForTest({
        config,
        historyService,
        aiService: createMockAIService({
          stopStream: mock(() => Promise.resolve(Ok(undefined))),
        }),
        extensionMetadata: new ExtensionMetadataService(
          path.join(config.rootDir, "extensionMetadata.json")
        ),
        initStateManager: {
          ...mockInitStateManager,
          off: mock(() => undefined as unknown as InitStateManager),
        } as unknown as InitStateManager,
      });

      // A full clear (truncateHistory) removes every row without appending a reset boundary
      // and leaves the sidecar intact; the surviving reference must not inject a workflow
      // result into the freshly cleared conversation.
      await recordAgentWorkflowRunReference({
        workspaceSessionDir: path.join(config.sessionsDir, workspaceId),
        runId,
        createdAtMs: 1_150,
        afterBoundaryMessageId: "manual-user",
      });

      expect(await workspaceService.isWorkflowInvocationCurrent(workspaceId, runId)).toBe(false);
      await workspaceService.disposeSession(workspaceId);
    } finally {
      await cleanup();
    }
  });

  test("delivers kernel launches recorded against a decision-free history", async () => {
    const { config, historyService, cleanup } = await createTestHistoryService();
    const workspaceId = "workflow-currentness-empty";
    const runId = "wfr_currentness_empty";
    const legacyRunId = "wfr_currentness_empty_legacy";
    const projectPath = path.join(config.rootDir, "project");
    try {
      await config.addWorkspace(projectPath, {
        id: workspaceId,
        name: "workflow-currentness-empty",
        projectName: "project",
        projectPath,
        runtimeConfig: { type: "local" },
      });
      const workspaceService = createWorkspaceServiceForTest({
        config,
        historyService,
        aiService: createMockAIService({
          stopStream: mock(() => Promise.resolve(Ok(undefined))),
        }),
        extensionMetadata: new ExtensionMetadataService(
          path.join(config.rootDir, "extensionMetadata.json")
        ),
        initStateManager: {
          ...mockInitStateManager,
          off: mock(() => undefined as unknown as InitStateManager),
        } as unknown as InitStateManager,
      });

      // A kernel launch from a synthetic turn in a new (or fully cleared) workspace records a
      // verified-empty snapshot (null). History still having no decision row means the launch
      // context is unchanged, so the wake must deliver.
      await recordAgentWorkflowRunReference({
        workspaceSessionDir: path.join(config.sessionsDir, workspaceId),
        runId,
        createdAtMs: 1_150,
        afterBoundaryMessageId: null,
      });
      expect(await workspaceService.isWorkflowInvocationCurrent(workspaceId, runId)).toBe(true);

      // A reference without a verified snapshot cannot claim the empty history as its launch
      // context; it may merely have survived a full clear.
      await recordAgentWorkflowRunReference({
        workspaceSessionDir: path.join(config.sessionsDir, workspaceId),
        runId: legacyRunId,
        createdAtMs: 1_150,
      });
      expect(await workspaceService.isWorkflowInvocationCurrent(workspaceId, legacyRunId)).toBe(
        false
      );

      // A decision row appearing after the launch supersedes the verified-empty snapshot.
      await historyService.appendToHistory(
        workspaceId,
        createMuxMessage("manual-user", "user", "never mind, answer something else", {
          timestamp: 1_200,
        })
      );
      expect(await workspaceService.isWorkflowInvocationCurrent(workspaceId, runId)).toBe(false);
      await workspaceService.disposeSession(workspaceId);
    } finally {
      await cleanup();
    }
  });

  test("retires kernel workflow run references on a full history clear", async () => {
    const { config, historyService, cleanup } = await createTestHistoryService();
    const workspaceId = "workflow-currentness-retire";
    const runId = "wfr_currentness_retire";
    const projectPath = path.join(config.rootDir, "project");
    try {
      await config.addWorkspace(projectPath, {
        id: workspaceId,
        name: "workflow-currentness-retire",
        projectName: "project",
        projectPath,
        runtimeConfig: { type: "local" },
      });
      const workspaceService = createWorkspaceServiceForTest({
        config,
        historyService,
        aiService: createMockAIService({
          stopStream: mock(() => Promise.resolve(Ok(undefined))),
        }),
        extensionMetadata: new ExtensionMetadataService(
          path.join(config.rootDir, "extensionMetadata.json")
        ),
        initStateManager: {
          ...mockInitStateManager,
          off: mock(() => undefined as unknown as InitStateManager),
        } as unknown as InitStateManager,
      });

      // Launched from a decision-free history: the verified-empty snapshot delivers.
      await recordAgentWorkflowRunReference({
        workspaceSessionDir: path.join(config.sessionsDir, workspaceId),
        runId,
        createdAtMs: 1_150,
        afterBoundaryMessageId: null,
      });
      expect(await workspaceService.isWorkflowInvocationCurrent(workspaceId, runId)).toBe(true);

      await historyService.appendToHistory(
        workspaceId,
        createMuxMessage("manual-user", "user", "never mind, answer something else", {
          timestamp: 1_200,
        })
      );
      expect(await workspaceService.isWorkflowInvocationCurrent(workspaceId, runId)).toBe(false);

      // A full clear returns history to decision-free, making the pre-clear null snapshot
      // indistinguishable from a fresh empty-history launch; the clear must retire the
      // reference so the stale result cannot inject into the fresh conversation.
      const clearResult = await workspaceService.truncateHistory(workspaceId, 1.0);
      expect(clearResult.success).toBe(true);
      expect(await workspaceService.isWorkflowInvocationCurrent(workspaceId, runId)).toBe(false);
      await workspaceService.disposeSession(workspaceId);
    } finally {
      await cleanup();
    }
  });

  test("retires kernel workflow run references even when a later post-clear step fails", async () => {
    const { config, historyService, cleanup } = await createTestHistoryService();
    const workspaceId = "workflow-currentness-retire-early";
    const runId = "wfr_currentness_retire_early";
    const projectPath = path.join(config.rootDir, "project");
    try {
      await config.addWorkspace(projectPath, {
        id: workspaceId,
        name: "workflow-currentness-retire-early",
        projectName: "project",
        projectPath,
        runtimeConfig: { type: "local" },
      });
      const workspaceService = createWorkspaceServiceForTest({
        config,
        historyService,
        aiService: createMockAIService({
          stopStream: mock(() => Promise.resolve(Ok(undefined))),
        }),
        extensionMetadata: new ExtensionMetadataService(
          path.join(config.rootDir, "extensionMetadata.json")
        ),
        initStateManager: {
          ...mockInitStateManager,
          off: mock(() => undefined as unknown as InitStateManager),
        } as unknown as InitStateManager,
      });

      await recordAgentWorkflowRunReference({
        workspaceSessionDir: path.join(config.sessionsDir, workspaceId),
        runId,
        createdAtMs: 1_150,
        afterBoundaryMessageId: null,
      });
      await historyService.appendToHistory(
        workspaceId,
        createMuxMessage("manual-user", "user", "never mind, answer something else", {
          timestamp: 1_200,
        })
      );

      // The truncation commits, then a later post-clear step fails. Retirement must already
      // have happened, or the stale null-snapshot reference survives the committed clear and
      // reads current against the emptied history.
      const sessionAccessor = workspaceService as unknown as {
        getOrCreateSession(id: string): { clearPostCompactionState(): Promise<void> };
      };
      const session = sessionAccessor.getOrCreateSession(workspaceId);
      const carryoverSpy = spyOn(session, "clearPostCompactionState").mockImplementationOnce(() =>
        Promise.reject(new Error("carryover discard failed"))
      );
      try {
        const clearResult = await workspaceService.truncateHistory(workspaceId, 1.0);
        expect(clearResult.success).toBe(false);
      } finally {
        carryoverSpy.mockRestore();
      }
      expect(await workspaceService.isWorkflowInvocationCurrent(workspaceId, runId)).toBe(false);
      await workspaceService.disposeSession(workspaceId);
    } finally {
      await cleanup();
    }
  });

  test("a failed reference retirement aborts the clear before truncation", async () => {
    const { config, historyService, cleanup } = await createTestHistoryService();
    const workspaceId = "workflow-currentness-retire-abort";
    const runId = "wfr_currentness_retire_abort";
    const projectPath = path.join(config.rootDir, "project");
    try {
      await config.addWorkspace(projectPath, {
        id: workspaceId,
        name: "workflow-currentness-retire-abort",
        projectName: "project",
        projectPath,
        runtimeConfig: { type: "local" },
      });
      const workspaceService = createWorkspaceServiceForTest({
        config,
        historyService,
        aiService: createMockAIService({
          stopStream: mock(() => Promise.resolve(Ok(undefined))),
        }),
        extensionMetadata: new ExtensionMetadataService(
          path.join(config.rootDir, "extensionMetadata.json")
        ),
        initStateManager: {
          ...mockInitStateManager,
          off: mock(() => undefined as unknown as InitStateManager),
        } as unknown as InitStateManager,
      });

      await recordAgentWorkflowRunReference({
        workspaceSessionDir: path.join(config.sessionsDir, workspaceId),
        runId,
        createdAtMs: 1_150,
        afterBoundaryMessageId: null,
      });
      await historyService.appendToHistory(
        workspaceId,
        createMuxMessage("manual-user", "user", "never mind, answer something else", {
          timestamp: 1_200,
        })
      );

      // Retirement failing after a committed truncation would leave the null-snapshot
      // reference reading current against the emptied history (pre-clear output injected
      // into the fresh conversation), so the clear must abort with the transcript intact.
      const truncateSpy = spyOn(historyService, "truncateHistory");
      const internal = workspaceService as unknown as {
        retireKernelWorkflowRunReferences(id: string): Promise<void>;
      };
      const retireSpy = spyOn(internal, "retireKernelWorkflowRunReferences")
        // Lazy rejection: an eager mockRejectedValueOnce promise trips bun's
        // unhandled-rejection detector on this host before the clear consumes it.
        .mockImplementationOnce(() => Promise.reject(new Error("read-only session storage")));
      try {
        const clearResult = await workspaceService.truncateHistory(workspaceId, 1.0);
        expect(clearResult.success).toBe(false);
        if (!clearResult.success) {
          expect(clearResult.error).toContain("could not be retired");
        }
        expect(truncateSpy).not.toHaveBeenCalled();
      } finally {
        retireSpy.mockRestore();
        truncateSpy.mockRestore();
      }

      // A retry once storage recovers clears normally and retires the sidecar.
      const retryResult = await workspaceService.truncateHistory(workspaceId, 1.0);
      expect(retryResult.success).toBe(true);
      expect(
        existsSync(path.join(config.sessionsDir, workspaceId, "agent-workflow-runs.json"))
      ).toBe(false);
      await workspaceService.disposeSession(workspaceId);
    } finally {
      await cleanup();
    }
  });

  test("a partial truncation that empties history retires kernel workflow references", async () => {
    const { config, historyService, cleanup } = await createTestHistoryService();
    const workspaceId = "workflow-currentness-partial-empty";
    const runId = "wfr_currentness_partial_empty";
    const projectPath = path.join(config.rootDir, "project");
    try {
      await config.addWorkspace(projectPath, {
        id: workspaceId,
        name: "workflow-currentness-partial-empty",
        projectName: "project",
        projectPath,
        runtimeConfig: { type: "local" },
      });
      const workspaceService = createWorkspaceServiceForTest({
        config,
        historyService,
        aiService: createMockAIService({
          stopStream: mock(() => Promise.resolve(Ok(undefined))),
        }),
        extensionMetadata: new ExtensionMetadataService(
          path.join(config.rootDir, "extensionMetadata.json")
        ),
        initStateManager: {
          ...mockInitStateManager,
          off: mock(() => undefined as unknown as InitStateManager),
        } as unknown as InitStateManager,
      });

      await recordAgentWorkflowRunReference({
        workspaceSessionDir: path.join(config.sessionsDir, workspaceId),
        runId,
        createdAtMs: 1_150,
        afterBoundaryMessageId: null,
      });
      await historyService.appendToHistory(
        workspaceId,
        createMuxMessage("manual-user", "user", "single short message", { timestamp: 1_200 })
      );

      // Half of a single-message transcript crosses the whole-history removal budget, so the
      // token-proportional truncation takes historyService's full-delete fast path. The
      // emptied transcript must retire the null-snapshot reference exactly like an explicit
      // clear, or the pre-truncation workflow result would read current against the emptied
      // decision-free history.
      const truncateResult = await workspaceService.truncateHistory(workspaceId, 0.5);
      expect(truncateResult.success).toBe(true);
      expect(await historyService.getHistoryFromLatestBoundary(workspaceId)).toEqual(Ok([]));
      expect(
        existsSync(path.join(config.sessionsDir, workspaceId, "agent-workflow-runs.json"))
      ).toBe(false);
      await workspaceService.disposeSession(workspaceId);
    } finally {
      await cleanup();
    }
  });

  test("an overlapping truncation that would empty history is refused, not silently cleared", async () => {
    const { config, historyService, cleanup } = await createTestHistoryService();
    const workspaceId = "workflow-currentness-preflight-race";
    const runId = "wfr_currentness_preflight_race";
    const projectPath = path.join(config.rootDir, "project");
    try {
      await config.addWorkspace(projectPath, {
        id: workspaceId,
        name: "workflow-currentness-preflight-race",
        projectName: "project",
        projectPath,
        runtimeConfig: { type: "local" },
      });
      const workspaceService = createWorkspaceServiceForTest({
        config,
        historyService,
        aiService: createMockAIService({
          stopStream: mock(() => Promise.resolve(Ok(undefined))),
        }),
        extensionMetadata: new ExtensionMetadataService(
          path.join(config.rootDir, "extensionMetadata.json")
        ),
        initStateManager: {
          ...mockInitStateManager,
          off: mock(() => undefined as unknown as InitStateManager),
        } as unknown as InitStateManager,
      });

      await recordAgentWorkflowRunReference({
        workspaceSessionDir: path.join(config.sessionsDir, workspaceId),
        runId,
        createdAtMs: 1_150,
        afterBoundaryMessageId: null,
      });
      await historyService.appendToHistory(
        workspaceId,
        createMuxMessage("manual-user", "user", "single short message", { timestamp: 1_200 })
      );

      // Simulate the preflight racing an overlapping truncation: it classifies this request
      // as non-emptying, but the locked rewrite's own recomputation would empty history. The
      // serialized revalidation must refuse rather than skip the full-clear guards.
      const preflightSpy = spyOn(
        historyService,
        "classifyTruncationRemoval"
      ).mockImplementationOnce(() => Promise.resolve("partial" as const));
      try {
        const result = await workspaceService.truncateHistory(workspaceId, 0.5);
        expect(result.success).toBe(false);
        if (!result.success) {
          expect(result.error).toContain("full clear");
        }
      } finally {
        preflightSpy.mockRestore();
      }
      // The transcript is intact; the reference was already retired before the refused
      // rewrite (retirement precedes every row-removing truncation), which is the fail-safe
      // direction: a dropped wake, with the result still retrievable via resume.
      const history = await historyService.getHistoryFromLatestBoundary(workspaceId);
      expect(history.success).toBe(true);
      if (history.success) {
        expect(history.data).toHaveLength(1);
      }
      expect(
        existsSync(path.join(config.sessionsDir, workspaceId, "agent-workflow-runs.json"))
      ).toBe(false);
      await workspaceService.disposeSession(workspaceId);
    } finally {
      await cleanup();
    }
  });

  test("an unreadable truncation scope preflight refuses instead of applying full-clear effects", async () => {
    const { config, historyService, cleanup } = await createTestHistoryService();
    const workspaceId = "workflow-currentness-preflight-refuse";
    const runId = "wfr_currentness_preflight_refuse";
    const projectPath = path.join(config.rootDir, "project");
    try {
      await config.addWorkspace(projectPath, {
        id: workspaceId,
        name: "workflow-currentness-preflight-refuse",
        projectName: "project",
        projectPath,
        runtimeConfig: { type: "local" },
      });
      const workspaceService = createWorkspaceServiceForTest({
        config,
        historyService,
        aiService: createMockAIService({
          stopStream: mock(() => Promise.resolve(Ok(undefined))),
        }),
        extensionMetadata: new ExtensionMetadataService(
          path.join(config.rootDir, "extensionMetadata.json")
        ),
        initStateManager: {
          ...mockInitStateManager,
          off: mock(() => undefined as unknown as InitStateManager),
        } as unknown as InitStateManager,
      });

      await recordAgentWorkflowRunReference({
        workspaceSessionDir: path.join(config.sessionsDir, workspaceId),
        runId,
        createdAtMs: 1_150,
        afterBoundaryMessageId: null,
      });
      await historyService.appendToHistory(
        workspaceId,
        createMuxMessage("manual-user", "user", "single short message", { timestamp: 1_200 })
      );

      // A transiently unreadable preflight must refuse: an unknown scope labeled "all" would
      // apply full-clear side effects while a prefix removal can leave rows behind.
      const preflightSpy = spyOn(historyService, "classifyTruncationRemoval").mockRejectedValueOnce(
        new Error("EIO: history unreadable")
      );
      try {
        const result = await workspaceService.truncateHistory(workspaceId, 0.5);
        expect(result.success).toBe(false);
        if (!result.success) {
          expect(result.error).toContain("classify");
        }
      } finally {
        preflightSpy.mockRestore();
      }
      // Lossless refusal: the transcript is intact and the kernel workflow reference survives
      // for the retry (no wake was settled superseded by a truncation that never happened).
      const history = await historyService.getHistoryFromLatestBoundary(workspaceId);
      expect(history.success).toBe(true);
      if (history.success) {
        expect(history.data).toHaveLength(1);
      }
      expect(
        existsSync(path.join(config.sessionsDir, workspaceId, "agent-workflow-runs.json"))
      ).toBe(true);
      await workspaceService.disposeSession(workspaceId);
    } finally {
      await cleanup();
    }
  });

  test("a full-clear-classified truncation that would leave rows is refused under the history lock", async () => {
    const { config, historyService, cleanup } = await createTestHistoryService();
    const workspaceId = "workflow-currentness-all-drift-refuse";
    const runId = "wfr_currentness_all_drift_refuse";
    const projectPath = path.join(config.rootDir, "project");
    try {
      await config.addWorkspace(projectPath, {
        id: workspaceId,
        name: "workflow-currentness-all-drift-refuse",
        projectName: "project",
        projectPath,
        runtimeConfig: { type: "local" },
      });
      const workspaceService = createWorkspaceServiceForTest({
        config,
        historyService,
        aiService: createMockAIService({
          stopStream: mock(() => Promise.resolve(Ok(undefined))),
        }),
        extensionMetadata: new ExtensionMetadataService(
          path.join(config.rootDir, "extensionMetadata.json")
        ),
        initStateManager: {
          ...mockInitStateManager,
          off: mock(() => undefined as unknown as InitStateManager),
        } as unknown as InitStateManager,
      });

      await recordAgentWorkflowRunReference({
        workspaceSessionDir: path.join(config.sessionsDir, workspaceId),
        runId,
        createdAtMs: 1_150,
        afterBoundaryMessageId: null,
      });
      for (let i = 0; i < 6; i++) {
        await historyService.appendToHistory(
          workspaceId,
          createMuxMessage(`manual-user-${i}`, "user", `padding message ${i}`, {
            timestamp: 1_200 + i,
          })
        );
      }

      // Simulate rows appended during the unserialized preflight (e.g. a turn completing
      // before the admission guard is acquired): it classified this request as emptying, but
      // the locked rewrite's recomputation removes only a prefix. The serialized revalidation
      // must refuse rather than apply full-clear side effects (context epoch advance,
      // goal/plan/retry discards) while rows remain.
      const preflightSpy = spyOn(
        historyService,
        "classifyTruncationRemoval"
      ).mockImplementationOnce(() => Promise.resolve("all" as const));
      try {
        const result = await workspaceService.truncateHistory(workspaceId, 0.5);
        expect(result.success).toBe(false);
        if (!result.success) {
          expect(result.error).toContain("leave messages");
        }
      } finally {
        preflightSpy.mockRestore();
      }
      // The transcript is intact; the reference was already retired before the refused
      // rewrite (retirement precedes every row-removing truncation), which is the fail-safe
      // direction: a dropped wake, with the result still retrievable via resume.
      const history = await historyService.getHistoryFromLatestBoundary(workspaceId);
      expect(history.success).toBe(true);
      if (history.success) {
        expect(history.data).toHaveLength(6);
      }
      expect(
        existsSync(path.join(config.sessionsDir, workspaceId, "agent-workflow-runs.json"))
      ).toBe(false);
      await workspaceService.disposeSession(workspaceId);
    } finally {
      await cleanup();
    }
  });

  test("the admission guard is held across the truncation scope preflight", async () => {
    const { config, historyService, cleanup } = await createTestHistoryService();
    const workspaceId = "workflow-currentness-preflight-guard";
    const projectPath = path.join(config.rootDir, "project");
    try {
      await config.addWorkspace(projectPath, {
        id: workspaceId,
        name: "workflow-currentness-preflight-guard",
        projectName: "project",
        projectPath,
        runtimeConfig: { type: "local" },
      });
      const workspaceService = createWorkspaceServiceForTest({
        config,
        historyService,
        aiService: createMockAIService({
          stopStream: mock(() => Promise.resolve(Ok(undefined))),
        }),
        extensionMetadata: new ExtensionMetadataService(
          path.join(config.rootDir, "extensionMetadata.json")
        ),
        initStateManager: {
          ...mockInitStateManager,
          off: mock(() => undefined as unknown as InitStateManager),
        } as unknown as InitStateManager,
      });
      for (let i = 0; i < 6; i++) {
        await historyService.appendToHistory(
          workspaceId,
          createMuxMessage(`manual-user-${i}`, "user", `padding message ${i}`, {
            timestamp: 1_200 + i,
          })
        );
      }

      // A turn admitted during the preflight could launch a kernel workflow whose sidecar
      // reference the wholesale retirement deletes while its rows survive the prefix cut,
      // permanently suppressing that run's wake. Admission must therefore already be held
      // while the classification snapshot is read: park the preflight and prove a concurrent
      // context mutation is refused for the whole window.
      let releasePreflight: ((scope: "partial") => void) | undefined;
      const preflightGate = new Promise<"partial">((resolve) => {
        releasePreflight = resolve;
      });
      const preflightSpy = spyOn(
        historyService,
        "classifyTruncationRemoval"
      ).mockImplementationOnce(() => preflightGate);
      try {
        const first = workspaceService.truncateHistory(workspaceId, 0.5);
        const second = await workspaceService.truncateHistory(workspaceId, 1.0);
        expect(second.success).toBe(false);
        if (!second.success) {
          expect(second.error).toContain("already in progress");
        }
        releasePreflight?.("partial");
        const firstResult = await first;
        expect(firstResult.success).toBe(true);
      } finally {
        preflightSpy.mockRestore();
      }
      // The refused full clear touched nothing: the prefix cut left a suffix behind.
      const history = await historyService.getHistoryFromLatestBoundary(workspaceId);
      expect(history.success).toBe(true);
      if (history.success) {
        expect(history.data.length).toBeGreaterThan(0);
      }
      await workspaceService.disposeSession(workspaceId);
    } finally {
      await cleanup();
    }
  });

  test("a turn becoming active during reference retirement refuses the truncation", async () => {
    const { config, historyService, cleanup } = await createTestHistoryService();
    const workspaceId = "workflow-currentness-retirement-recheck";
    const projectPath = path.join(config.rootDir, "project");
    try {
      await config.addWorkspace(projectPath, {
        id: workspaceId,
        name: "workflow-currentness-retirement-recheck",
        projectName: "project",
        projectPath,
        runtimeConfig: { type: "local" },
      });
      let streaming = false;
      const workspaceService = createWorkspaceServiceForTest({
        config,
        historyService,
        aiService: createMockAIService({
          stopStream: mock(() => Promise.resolve(Ok(undefined))),
          isStreaming: mock(() => streaming),
        }),
        extensionMetadata: new ExtensionMetadataService(
          path.join(config.rootDir, "extensionMetadata.json")
        ),
        initStateManager: {
          ...mockInitStateManager,
          off: mock(() => undefined as unknown as InitStateManager),
        } as unknown as InitStateManager,
      });
      for (let i = 0; i < 6; i++) {
        await historyService.appendToHistory(
          workspaceId,
          createMuxMessage(`manual-user-${i}`, "user", `padding message ${i}`, {
            timestamp: 1_200 + i,
          })
        );
      }

      // An in-turn compaction retry bypasses admission gating across a transient idle gap,
      // and the retirement await is the last one before the rewrite: a retry that becomes
      // active during it must refuse the truncation instead of streaming across it.
      const retireSpy = spyOn(
        workspaceService as unknown as {
          retireKernelWorkflowRunReferences: (id: string) => Promise<void>;
        },
        "retireKernelWorkflowRunReferences"
      ).mockImplementationOnce(() => {
        streaming = true;
        return Promise.resolve();
      });
      try {
        const result = await workspaceService.truncateHistory(workspaceId, 0.5);
        expect(result.success).toBe(false);
        if (!result.success) {
          expect(result.error).toContain("turn is active");
        }
      } finally {
        retireSpy.mockRestore();
      }
      // Refused before the rewrite: the transcript is intact.
      const history = await historyService.getHistoryFromLatestBoundary(workspaceId);
      expect(history.success).toBe(true);
      if (history.success) {
        expect(history.data).toHaveLength(6);
      }
      await workspaceService.disposeSession(workspaceId);
    } finally {
      await cleanup();
    }
  });

  test("a partial prefix truncation retires kernel workflow references", async () => {
    const { config, historyService, cleanup } = await createTestHistoryService();
    const workspaceId = "workflow-currentness-prefix-retire";
    const runId = "wfr_currentness_prefix_retire";
    const projectPath = path.join(config.rootDir, "project");
    try {
      await config.addWorkspace(projectPath, {
        id: workspaceId,
        name: "workflow-currentness-prefix-retire",
        projectName: "project",
        projectPath,
        runtimeConfig: { type: "local" },
      });
      const workspaceService = createWorkspaceServiceForTest({
        config,
        historyService,
        aiService: createMockAIService({
          stopStream: mock(() => Promise.resolve(Ok(undefined))),
        }),
        extensionMetadata: new ExtensionMetadataService(
          path.join(config.rootDir, "extensionMetadata.json")
        ),
        initStateManager: {
          ...mockInitStateManager,
          off: mock(() => undefined as unknown as InitStateManager),
        } as unknown as InitStateManager,
      });

      await recordAgentWorkflowRunReference({
        workspaceSessionDir: path.join(config.sessionsDir, workspaceId),
        runId,
        createdAtMs: 1_150,
        afterBoundaryMessageId: null,
      });
      await historyService.appendToHistory(
        workspaceId,
        createMuxMessage("manual-user", "user", "before truncation", { timestamp: 1_200 })
      );
      await historyService.appendToHistory(
        workspaceId,
        createMuxMessage("manual-user-b", "user", "still here after", { timestamp: 1_300 })
      );

      // A genuinely partial prefix cut can delete the launch turn's restriction-bearing rows
      // without adding a supersession decision, so the reference must not survive to
      // recompose the wake from unrestricted defaults; the run stays retrievable via resume.
      const truncateResult = await workspaceService.truncateHistory(workspaceId, 0.5);
      expect(truncateResult.success).toBe(true);
      const history = await historyService.getHistoryFromLatestBoundary(workspaceId);
      expect(history.success).toBe(true);
      if (history.success) {
        expect(history.data).toHaveLength(1);
      }
      expect(
        existsSync(path.join(config.sessionsDir, workspaceId, "agent-workflow-runs.json"))
      ).toBe(false);
      await workspaceService.disposeSession(workspaceId);
    } finally {
      await cleanup();
    }
  });

  test("a partial truncation blocks send admission across reference retirement", async () => {
    const { config, historyService, cleanup } = await createTestHistoryService();
    const workspaceId = "workflow-currentness-partial-admission";
    const runId = "wfr_currentness_partial_admission";
    const projectPath = path.join(config.rootDir, "project");
    try {
      await config.addWorkspace(projectPath, {
        id: workspaceId,
        name: "workflow-currentness-partial-admission",
        projectName: "project",
        projectPath,
        runtimeConfig: { type: "local" },
      });
      const workspaceService = createWorkspaceServiceForTest({
        config,
        historyService,
        aiService: createMockAIService({
          stopStream: mock(() => Promise.resolve(Ok(undefined))),
        }),
        extensionMetadata: new ExtensionMetadataService(
          path.join(config.rootDir, "extensionMetadata.json")
        ),
        initStateManager: {
          ...mockInitStateManager,
          off: mock(() => undefined as unknown as InitStateManager),
        } as unknown as InitStateManager,
      });

      await recordAgentWorkflowRunReference({
        workspaceSessionDir: path.join(config.sessionsDir, workspaceId),
        runId,
        createdAtMs: 1_150,
        afterBoundaryMessageId: null,
      });
      await historyService.appendToHistory(
        workspaceId,
        createMuxMessage("manual-user", "user", "before truncation", { timestamp: 1_200 })
      );
      await historyService.appendToHistory(
        workspaceId,
        createMuxMessage("manual-user-b", "user", "still here after", { timestamp: 1_300 })
      );

      // A send racing the partial truncation during the retirement await must be refused:
      // admitted, it would snapshot the pre-truncation transcript and lose its turn's
      // workflow provenance to the reference retirement.
      const internal = workspaceService as unknown as {
        retireKernelWorkflowRunReferences: (id: string) => Promise<void>;
      };
      const originalRetire = internal.retireKernelWorkflowRunReferences.bind(workspaceService);
      let raceSendOutcome: string | null = null;
      const retireSpy = spyOn(internal, "retireKernelWorkflowRunReferences").mockImplementationOnce(
        async (id: string) => {
          const sendResult = await workspaceService.sendMessage(workspaceId, "race the cut", {
            model: "openai:gpt-4o",
            agentId: "exec",
          });
          raceSendOutcome = sendResult.success ? "accepted" : JSON.stringify(sendResult.error);
          await originalRetire(id);
        }
      );
      try {
        const truncateResult = await workspaceService.truncateHistory(workspaceId, 0.5);
        expect(truncateResult.success).toBe(true);
      } finally {
        retireSpy.mockRestore();
      }
      expect(raceSendOutcome ?? "").toContain(CONTEXT_MUTATION_SEND_BLOCKED_MESSAGE);
      const history = await historyService.getHistoryFromLatestBoundary(workspaceId);
      expect(history.success).toBe(true);
      if (history.success) {
        expect(history.data).toHaveLength(1);
      }
      await workspaceService.disposeSession(workspaceId);
    } finally {
      await cleanup();
    }
  });

  test("a destructive history replacement retires kernel workflow references", async () => {
    const { config, historyService, cleanup } = await createTestHistoryService();
    const workspaceId = "workflow-currentness-replace-retire";
    const runId = "wfr_currentness_replace_retire";
    const projectPath = path.join(config.rootDir, "project");
    try {
      await config.addWorkspace(projectPath, {
        id: workspaceId,
        name: "workflow-currentness-replace-retire",
        projectName: "project",
        projectPath,
        runtimeConfig: { type: "local" },
      });
      const workspaceService = createWorkspaceServiceForTest({
        config,
        historyService,
        aiService: createMockAIService({
          stopStream: mock(() => Promise.resolve(Ok(undefined))),
        }),
        extensionMetadata: new ExtensionMetadataService(
          path.join(config.rootDir, "extensionMetadata.json")
        ),
        initStateManager: {
          ...mockInitStateManager,
          off: mock(() => undefined as unknown as InitStateManager),
        } as unknown as InitStateManager,
      });

      await recordAgentWorkflowRunReference({
        workspaceSessionDir: path.join(config.sessionsDir, workspaceId),
        runId,
        createdAtMs: 1_150,
        afterBoundaryMessageId: null,
      });
      await historyService.appendToHistory(
        workspaceId,
        createMuxMessage("manual-user", "user", "before replacement", { timestamp: 1_200 })
      );

      // A destructive non-compaction replacement leaves a decision-free transcript that a
      // null-boundary reference would read as current, injecting the pre-replacement result.
      const replaceResult = await workspaceService.replaceHistory(
        workspaceId,
        createMuxMessage("replacement-summary", "assistant", "Replacement summary", {})
      );
      expect(replaceResult.success).toBe(true);
      expect(
        existsSync(path.join(config.sessionsDir, workspaceId, "agent-workflow-runs.json"))
      ).toBe(false);
      await workspaceService.disposeSession(workspaceId);
    } finally {
      await cleanup();
    }
  });

  test("a truncation that removes no rows preserves kernel workflow references", async () => {
    const { config, historyService, cleanup } = await createTestHistoryService();
    const workspaceId = "workflow-currentness-noop-preserve";
    const runId = "wfr_currentness_noop_preserve";
    const projectPath = path.join(config.rootDir, "project");
    try {
      await config.addWorkspace(projectPath, {
        id: workspaceId,
        name: "workflow-currentness-noop-preserve",
        projectName: "project",
        projectPath,
        runtimeConfig: { type: "local" },
      });
      const workspaceService = createWorkspaceServiceForTest({
        config,
        historyService,
        aiService: createMockAIService({
          stopStream: mock(() => Promise.resolve(Ok(undefined))),
        }),
        extensionMetadata: new ExtensionMetadataService(
          path.join(config.rootDir, "extensionMetadata.json")
        ),
        initStateManager: {
          ...mockInitStateManager,
          off: mock(() => undefined as unknown as InitStateManager),
        } as unknown as InitStateManager,
      });

      await recordAgentWorkflowRunReference({
        workspaceSessionDir: path.join(config.sessionsDir, workspaceId),
        runId,
        createdAtMs: 1_150,
        afterBoundaryMessageId: null,
      });
      await historyService.appendToHistory(
        workspaceId,
        createMuxMessage("manual-user", "user", "first message", { timestamp: 1_200 })
      );
      await historyService.appendToHistory(
        workspaceId,
        createMuxMessage("manual-user-b", "user", "second message", { timestamp: 1_300 })
      );

      // A tiny percentage rounds to a zero removal budget: the transcript is unchanged, so
      // the run's reference must survive or its terminal wake would settle superseded under
      // a conversation that never lost a row.
      const truncateResult = await workspaceService.truncateHistory(workspaceId, 0.0001);
      expect(truncateResult.success).toBe(true);
      const history = await historyService.getHistoryFromLatestBoundary(workspaceId);
      expect(history.success).toBe(true);
      if (history.success) {
        expect(history.data).toHaveLength(2);
      }
      expect(
        existsSync(path.join(config.sessionsDir, workspaceId, "agent-workflow-runs.json"))
      ).toBe(true);
      await workspaceService.disposeSession(workspaceId);
    } finally {
      await cleanup();
    }
  });

  test("a no-op-classified truncation that would remove rows is refused with references intact", async () => {
    const { config, historyService, cleanup } = await createTestHistoryService();
    const workspaceId = "workflow-currentness-noop-race";
    const runId = "wfr_currentness_noop_race";
    const projectPath = path.join(config.rootDir, "project");
    try {
      await config.addWorkspace(projectPath, {
        id: workspaceId,
        name: "workflow-currentness-noop-race",
        projectName: "project",
        projectPath,
        runtimeConfig: { type: "local" },
      });
      const workspaceService = createWorkspaceServiceForTest({
        config,
        historyService,
        aiService: createMockAIService({
          stopStream: mock(() => Promise.resolve(Ok(undefined))),
        }),
        extensionMetadata: new ExtensionMetadataService(
          path.join(config.rootDir, "extensionMetadata.json")
        ),
        initStateManager: {
          ...mockInitStateManager,
          off: mock(() => undefined as unknown as InitStateManager),
        } as unknown as InitStateManager,
      });

      await recordAgentWorkflowRunReference({
        workspaceSessionDir: path.join(config.sessionsDir, workspaceId),
        runId,
        createdAtMs: 1_150,
        afterBoundaryMessageId: null,
      });
      await historyService.appendToHistory(
        workspaceId,
        createMuxMessage("manual-user", "user", "single short message", { timestamp: 1_200 })
      );

      // Simulate the scope preflight racing history growth: classified a no-op (so reference
      // retirement was skipped), but the locked recomputation reaches real rows. The
      // serialized guard must refuse rather than remove rows with live references.
      const preflightSpy = spyOn(
        historyService,
        "classifyTruncationRemoval"
      ).mockImplementationOnce(() => Promise.resolve("none" as const));
      try {
        const result = await workspaceService.truncateHistory(workspaceId, 0.9);
        expect(result.success).toBe(false);
        if (!result.success) {
          expect(result.error).toContain("no-op");
        }
      } finally {
        preflightSpy.mockRestore();
      }
      const history = await historyService.getHistoryFromLatestBoundary(workspaceId);
      expect(history.success).toBe(true);
      if (history.success) {
        expect(history.data).toHaveLength(1);
      }
      expect(
        existsSync(path.join(config.sessionsDir, workspaceId, "agent-workflow-runs.json"))
      ).toBe(true);
      await workspaceService.disposeSession(workspaceId);
    } finally {
      await cleanup();
    }
  });

  test("a delivered coalesced workflow result consumes the kernel run's currentness", async () => {
    const { config, historyService, cleanup } = await createTestHistoryService();
    const workspaceId = "workflow-currentness-coalesced";
    const runId = "wfr_currentness_coalesced";
    const projectPath = path.join(config.rootDir, "project");
    try {
      await config.addWorkspace(projectPath, {
        id: workspaceId,
        name: "workflow-currentness-coalesced",
        projectName: "project",
        projectPath,
        runtimeConfig: { type: "local" },
      });
      const workspaceService = createWorkspaceServiceForTest({
        config,
        historyService,
        aiService: createMockAIService({
          stopStream: mock(() => Promise.resolve(Ok(undefined))),
        }),
        extensionMetadata: new ExtensionMetadataService(
          path.join(config.rootDir, "extensionMetadata.json")
        ),
        initStateManager: {
          ...mockInitStateManager,
          off: mock(() => undefined as unknown as InitStateManager),
        } as unknown as InitStateManager,
      });

      await recordAgentWorkflowRunReference({
        workspaceSessionDir: path.join(config.sessionsDir, workspaceId),
        runId,
        createdAtMs: 1_150,
        afterBoundaryMessageId: null,
      });
      expect(await workspaceService.isWorkflowInvocationCurrent(workspaceId, runId)).toBe(true);

      // Another run's payload quoting nothing about this run must not count as consumption.
      await historyService.appendToHistory(
        workspaceId,
        createMuxMessage(
          "coalesced-other",
          "user",
          buildWorkflowResultContextMessage({
            rawCommand: "workflow_run other.js",
            name: "other.js",
            runId: "wfr_currentness_other",
            status: "completed",
            result: { reportMarkdown: "other done" },
            run: null,
          }),
          { timestamp: 1_250, synthetic: true }
        )
      );
      expect(await workspaceService.isWorkflowInvocationCurrent(workspaceId, runId)).toBe(true);

      // The drain's synthetic coalesced prompt carries no workflow-result metadata. After a
      // crash between durable acceptance and the settled-marker write, this row is the only
      // evidence the result already reached history; it must read as consumption or the next
      // sweep injects the same terminal result again.
      await historyService.appendToHistory(
        workspaceId,
        createMuxMessage(
          "coalesced-result",
          "user",
          buildWorkflowResultContextMessage({
            rawCommand: "workflow_run research.js",
            name: "research.js",
            runId,
            status: "completed",
            result: { reportMarkdown: "done" },
            run: null,
          }),
          { timestamp: 1_300, synthetic: true }
        )
      );
      expect(await workspaceService.isWorkflowInvocationCurrent(workspaceId, runId)).toBe(false);
      await workspaceService.disposeSession(workspaceId);
    } finally {
      await cleanup();
    }
  });

  test("decides sidecar currentness by boundary identity, not wall-clock order", async () => {
    const { config, historyService, cleanup } = await createTestHistoryService();
    const workspaceId = "workflow-currentness-clock";
    const runId = "wfr_currentness_clock";
    const projectPath = path.join(config.rootDir, "project");
    try {
      await config.addWorkspace(projectPath, {
        id: workspaceId,
        name: "workflow-currentness-clock",
        projectName: "project",
        projectPath,
        runtimeConfig: { type: "local" },
      });
      const workspaceService = createWorkspaceServiceForTest({
        config,
        historyService,
        aiService: createMockAIService({
          stopStream: mock(() => Promise.resolve(Ok(undefined))),
        }),
        extensionMetadata: new ExtensionMetadataService(
          path.join(config.rootDir, "extensionMetadata.json")
        ),
        initStateManager: {
          ...mockInitStateManager,
          off: mock(() => undefined as unknown as InitStateManager),
        } as unknown as InitStateManager,
      });

      await historyService.appendToHistory(
        workspaceId,
        createMuxMessage("manual-user", "user", "run the audit workflow", { timestamp: 1_000 })
      );
      // A backward clock correction after recording makes the reference timestamp future-dated
      // relative to every later history row; identity comparison must still deliver the wake.
      const skewedCreatedAtMs = Date.now() + 30 * 60_000;
      await recordAgentWorkflowRunReference({
        workspaceSessionDir: path.join(config.sessionsDir, workspaceId),
        runId,
        createdAtMs: skewedCreatedAtMs,
        afterBoundaryMessageId: "manual-user",
      });
      expect(await workspaceService.isWorkflowInvocationCurrent(workspaceId, runId)).toBe(true);

      // A user message written after the correction has a smaller timestamp than the reference;
      // wall-clock ordering would keep the stale reference current, identity must not.
      await historyService.appendToHistory(
        workspaceId,
        createMuxMessage("manual-user-2", "user", "never mind, answer something else", {
          timestamp: 1_200,
        })
      );
      expect(await workspaceService.isWorkflowInvocationCurrent(workspaceId, runId)).toBe(false);
      await workspaceService.disposeSession(workspaceId);
    } finally {
      await cleanup();
    }
  });

  test("fails boundaryless sidecar references quiet instead of trusting wall-clock order", async () => {
    const { config, historyService, cleanup } = await createTestHistoryService();
    const workspaceId = "workflow-currentness-legacy";
    const runId = "wfr_currentness_legacy";
    const projectPath = path.join(config.rootDir, "project");
    try {
      await config.addWorkspace(projectPath, {
        id: workspaceId,
        name: "workflow-currentness-legacy",
        projectName: "project",
        projectPath,
        runtimeConfig: { type: "local" },
      });
      const workspaceService = createWorkspaceServiceForTest({
        config,
        historyService,
        aiService: createMockAIService({
          stopStream: mock(() => Promise.resolve(Ok(undefined))),
        }),
        extensionMetadata: new ExtensionMetadataService(
          path.join(config.rootDir, "extensionMetadata.json")
        ),
        initStateManager: {
          ...mockInitStateManager,
          off: mock(() => undefined as unknown as InitStateManager),
        } as unknown as InitStateManager,
      });

      await historyService.appendToHistory(
        workspaceId,
        createMuxMessage("manual-user", "user", "run the audit workflow", { timestamp: 1_000 })
      );
      // A reference without a boundary snapshot (pre-upgrade entry or record-time history read
      // failure) cannot be ordered against the decision row by identity: the wake fails quiet
      // (not_current) rather than delivering or deferring forever.
      await recordAgentWorkflowRunReference({
        workspaceSessionDir: path.join(config.sessionsDir, workspaceId),
        runId,
        createdAtMs: 1_150,
      });
      expect(await workspaceService.getWorkflowInvocationCurrentness(workspaceId, runId)).toBe(
        "not_current"
      );
      expect(await workspaceService.isWorkflowInvocationCurrent(workspaceId, runId)).toBe(false);

      // A backward clock correction gives the newer superseding turn an OLDER timestamp than
      // the reference. Wall-clock ordering would resurrect the superseded reference as current
      // and deliver its output under the newer turn's tool policy; it must stay quiet.
      await historyService.appendToHistory(
        workspaceId,
        createMuxMessage("manual-user-2", "user", "never mind, answer something else", {
          timestamp: 1_100,
        })
      );
      expect(await workspaceService.getWorkflowInvocationCurrentness(workspaceId, runId)).toBe(
        "not_current"
      );
      await workspaceService.disposeSession(workspaceId);
    } finally {
      await cleanup();
    }
  });

  test("treats an unreadable history as indeterminate, not superseded", async () => {
    const { config, historyService, cleanup } = await createTestHistoryService();
    const workspaceId = "workflow-currentness-io-error";
    const runId = "wfr_currentness_io_error";
    const projectPath = path.join(config.rootDir, "project");
    try {
      await config.addWorkspace(projectPath, {
        id: workspaceId,
        name: "workflow-currentness-io-error",
        projectName: "project",
        projectPath,
        runtimeConfig: { type: "local" },
      });
      const workspaceService = createWorkspaceServiceForTest({
        config,
        historyService,
        aiService: createMockAIService({
          stopStream: mock(() => Promise.resolve(Ok(undefined))),
        }),
        extensionMetadata: new ExtensionMetadataService(
          path.join(config.rootDir, "extensionMetadata.json")
        ),
        initStateManager: {
          ...mockInitStateManager,
          off: mock(() => undefined as unknown as InitStateManager),
        } as unknown as InitStateManager,
      });

      await historyService.appendToHistory(
        workspaceId,
        createMuxMessage("manual-user", "user", "run the audit workflow", { timestamp: 1_000 })
      );
      await recordAgentWorkflowRunReference({
        workspaceSessionDir: path.join(config.sessionsDir, workspaceId),
        runId,
        createdAtMs: 1_150,
        afterBoundaryMessageId: "manual-user",
      });
      expect(await workspaceService.isWorkflowInvocationCurrent(workspaceId, runId)).toBe(true);

      const readSpy = spyOn(historyService, "iterateFullHistory").mockResolvedValue(
        Err("disk read failed")
      );
      try {
        // The drain distinguishes a read failure (retain and retry) from supersession
        // (settle as superseded); the boolean view stays fail-safe false for non-destructive
        // callers.
        expect(await workspaceService.getWorkflowInvocationCurrentness(workspaceId, runId)).toBe(
          "indeterminate"
        );
        expect(await workspaceService.isWorkflowInvocationCurrent(workspaceId, runId)).toBe(false);
        // The record path must fail loudly instead of persisting a verified-empty boundary that
        // would permanently strand the run's wake after storage recovers.
        let boundaryError: unknown;
        try {
          await workspaceService.getWorkflowInvocationBoundaryMessageId(workspaceId, runId);
        } catch (error: unknown) {
          boundaryError = error;
        }
        expect(String(boundaryError)).toContain("boundary unavailable");
      } finally {
        readSpy.mockRestore();
      }
      expect(await workspaceService.getWorkflowInvocationCurrentness(workspaceId, runId)).toBe(
        "current"
      );
      await workspaceService.disposeSession(workspaceId);
    } finally {
      await cleanup();
    }
  });

  test("treats an unreadable sidecar as indeterminate, not superseded", async () => {
    const { config, historyService, cleanup } = await createTestHistoryService();
    const workspaceId = "workflow-currentness-sidecar-error";
    const runId = "wfr_currentness_sidecar_error";
    const projectPath = path.join(config.rootDir, "project");
    try {
      await config.addWorkspace(projectPath, {
        id: workspaceId,
        name: "workflow-currentness-sidecar-error",
        projectName: "project",
        projectPath,
        runtimeConfig: { type: "local" },
      });
      const workspaceService = createWorkspaceServiceForTest({
        config,
        historyService,
        aiService: createMockAIService({
          stopStream: mock(() => Promise.resolve(Ok(undefined))),
        }),
        extensionMetadata: new ExtensionMetadataService(
          path.join(config.rootDir, "extensionMetadata.json")
        ),
        initStateManager: {
          ...mockInitStateManager,
          off: mock(() => undefined as unknown as InitStateManager),
        } as unknown as InitStateManager,
      });

      await historyService.appendToHistory(
        workspaceId,
        createMuxMessage("manual-user", "user", "run the audit workflow", { timestamp: 1_000 })
      );
      await recordAgentWorkflowRunReference({
        workspaceSessionDir: path.join(config.sessionsDir, workspaceId),
        runId,
        createdAtMs: 1_150,
        afterBoundaryMessageId: "manual-user",
      });
      expect(await workspaceService.isWorkflowInvocationCurrent(workspaceId, runId)).toBe(true);

      // The sidecar is the only invocation evidence for kernel-launched runs: an unreadable
      // file must read as "cannot know right now", not "no reference", or the drain would
      // settle the wake as superseded on a transient storage fault.
      const sidecarPath = path.join(config.sessionsDir, workspaceId, "agent-workflow-runs.json");
      await fsPromises.rm(sidecarPath);
      await fsPromises.mkdir(sidecarPath);
      try {
        expect(await workspaceService.getWorkflowInvocationCurrentness(workspaceId, runId)).toBe(
          "indeterminate"
        );
        expect(await workspaceService.isWorkflowInvocationCurrent(workspaceId, runId)).toBe(false);
      } finally {
        await fsPromises.rmdir(sidecarPath);
      }
      await recordAgentWorkflowRunReference({
        workspaceSessionDir: path.join(config.sessionsDir, workspaceId),
        runId,
        createdAtMs: 1_150,
        afterBoundaryMessageId: "manual-user",
      });
      expect(await workspaceService.getWorkflowInvocationCurrentness(workspaceId, runId)).toBe(
        "current"
      );
      await workspaceService.disposeSession(workspaceId);
    } finally {
      await cleanup();
    }
  });

  test.each(["workflow_run", "workflow_resume"] as const)(
    "treats terminal %s output as a consumed workflow result",
    async (toolName) => {
      const { config, historyService, cleanup } = await createTestHistoryService();
      const workspaceId = `workflow-terminal-${toolName}`;
      const runId = `wfr_terminal_${toolName}`;
      const projectPath = path.join(config.rootDir, "project");
      try {
        await config.addWorkspace(projectPath, {
          id: workspaceId,
          name: workspaceId,
          projectName: "project",
          projectPath,
          runtimeConfig: { type: "local" },
        });
        const workspaceService = createWorkspaceServiceForTest({
          config,
          historyService,
          aiService: createMockAIService({
            stopStream: mock(() => Promise.resolve(Ok(undefined))),
          }),
          extensionMetadata: new ExtensionMetadataService(
            path.join(config.rootDir, "extensionMetadata.json")
          ),
          initStateManager: {
            ...mockInitStateManager,
            off: mock(() => undefined as unknown as InitStateManager),
          } as unknown as InitStateManager,
        });

        await historyService.appendToHistory(
          workspaceId,
          createMuxMessage(`assistant-${toolName}`, "assistant", "", { timestamp: 1_000 }, [
            {
              type: "dynamic-tool",
              toolCallId: `${toolName}-call-1`,
              toolName,
              state: "output-available",
              input:
                toolName === "workflow_run"
                  ? { script_path: "./workflows/demo.js", args: {}, run_in_background: false }
                  : { run_id: runId, mode: "resume", run_in_background: false },
              output: {
                status: "completed",
                runId,
                result: { reportMarkdown: "done" },
              },
            },
          ])
        );

        expect(await workspaceService.isWorkflowInvocationCurrent(workspaceId, runId)).toBe(false);
        await workspaceService.disposeSession(workspaceId);
      } finally {
        await cleanup();
      }
    }
  );

  test("keeps workflow invocations current across mid-stream auto-compaction requests", async () => {
    const { config, historyService, cleanup } = await createTestHistoryService();
    const workspaceId = "workflow-currentness-midstream-compact";
    const runId = "wfr_currentness_midstream_compact";
    const projectPath = path.join(config.rootDir, "project");
    try {
      await config.addWorkspace(projectPath, {
        id: workspaceId,
        name: "workflow-currentness-midstream-compact",
        projectName: "project",
        projectPath,
        runtimeConfig: { type: "local" },
      });
      const workspaceService = createWorkspaceServiceForTest({
        config,
        historyService,
        aiService: createMockAIService({
          stopStream: mock(() => Promise.resolve(Ok(undefined))),
        }),
        extensionMetadata: new ExtensionMetadataService(
          path.join(config.rootDir, "extensionMetadata.json")
        ),
        initStateManager: {
          ...mockInitStateManager,
          off: mock(() => undefined as unknown as InitStateManager),
        } as unknown as InitStateManager,
      });

      await historyService.appendToHistory(
        workspaceId,
        createMuxMessage("assistant-workflow-run", "assistant", "", { timestamp: 1_000 }, [
          {
            type: "dynamic-tool",
            toolCallId: "workflow-call-1",
            toolName: "workflow_run",
            state: "output-available",
            input: { script_path: "./workflows/demo.js", args: {}, run_in_background: true },
            output: { status: "running", runId, result: null },
          },
        ])
      );
      await historyService.appendToHistory(
        workspaceId,
        createMuxMessage("midstream-auto-compaction", "user", "Compacting to continue", {
          timestamp: 1_100,
          synthetic: true,
          muxMetadata: {
            type: "compaction-request",
            rawCommand: "/compact",
            parsed: {
              followUpContent: {
                text: "Continue",
                model: "openai:gpt-5.2",
                agentId: "exec",
                dispatchOptions: { source: "internal-resume" },
              },
            },
            source: "auto-compaction",
          },
        })
      );

      expect(await workspaceService.isWorkflowInvocationCurrent(workspaceId, runId)).toBe(true);
      await workspaceService.disposeSession(workspaceId);
    } finally {
      await cleanup();
    }
  });

  test("treats on-send compaction requests as manual workflow supersession", async () => {
    const { config, historyService, cleanup } = await createTestHistoryService();
    const workspaceId = "workflow-currentness-auto-compact";
    const runId = "wfr_currentness_auto_compact";
    const projectPath = path.join(config.rootDir, "project");
    try {
      await config.addWorkspace(projectPath, {
        id: workspaceId,
        name: "workflow-currentness-auto-compact",
        projectName: "project",
        projectPath,
        runtimeConfig: { type: "local" },
      });
      const workspaceService = createWorkspaceServiceForTest({
        config,
        historyService,
        aiService: createMockAIService({
          stopStream: mock(() => Promise.resolve(Ok(undefined))),
        }),
        extensionMetadata: new ExtensionMetadataService(
          path.join(config.rootDir, "extensionMetadata.json")
        ),
        initStateManager: {
          ...mockInitStateManager,
          off: mock(() => undefined as unknown as InitStateManager),
        } as unknown as InitStateManager,
      });

      await historyService.appendToHistory(
        workspaceId,
        createMuxMessage("assistant-workflow-run", "assistant", "", { timestamp: 1_000 }, [
          {
            type: "dynamic-tool",
            toolCallId: "workflow-call-1",
            toolName: "workflow_run",
            state: "output-available",
            input: { script_path: "./workflows/demo.js", args: {}, run_in_background: true },
            output: { status: "running", runId, result: null },
          },
        ])
      );
      await historyService.appendToHistory(
        workspaceId,
        createMuxMessage("auto-compaction", "user", "Compacting before a new user prompt", {
          timestamp: 1_100,
          synthetic: true,
          muxMetadata: {
            type: "compaction-request",
            rawCommand: "/compact",
            parsed: {},
            source: "auto-compaction",
          },
        })
      );

      expect(await workspaceService.isWorkflowInvocationCurrent(workspaceId, runId)).toBe(false);
      await workspaceService.disposeSession(workspaceId);
    } finally {
      await cleanup();
    }
  });

  test("keeps workflow invocations current across compaction boundaries", async () => {
    const { config, historyService, cleanup } = await createTestHistoryService();
    const workspaceId = "workflow-currentness-boundary";
    const runId = "wfr_currentness_boundary";
    const projectPath = path.join(config.rootDir, "project");
    try {
      await config.addWorkspace(projectPath, {
        id: workspaceId,
        name: "workflow-currentness-boundary",
        projectName: "project",
        projectPath,
        runtimeConfig: { type: "local" },
      });
      const workspaceService = createWorkspaceServiceForTest({
        config,
        historyService,
        aiService: createMockAIService({
          stopStream: mock(() => Promise.resolve(Ok(undefined))),
        }),
        extensionMetadata: new ExtensionMetadataService(
          path.join(config.rootDir, "extensionMetadata.json")
        ),
        initStateManager: {
          ...mockInitStateManager,
          off: mock(() => undefined as unknown as InitStateManager),
        } as unknown as InitStateManager,
      });

      const persisted = await workspaceService.appendWorkflowRunInvocation({
        workspaceId,
        rawCommand: "/demo currentness boundary",
        scriptPath: "./workflows/demo.js",
        args: { input: "currentness boundary" },
        runId,
        status: "running",
        result: null,
      });
      expect(persisted).toBe(true);
      await historyService.appendToHistory(
        workspaceId,
        createMuxMessage("boundary", "assistant", "Compacted summary", {
          timestamp: 2_000,
          compactionBoundary: true,
        })
      );

      expect(await workspaceService.isWorkflowInvocationCurrent(workspaceId, runId)).toBe(true);
      await workspaceService.disposeSession(workspaceId);
    } finally {
      await cleanup();
    }
  });

  test("treats reset boundaries as workflow supersession", async () => {
    const { config, historyService, cleanup } = await createTestHistoryService();
    const workspaceId = "workflow-currentness-reset";
    const runId = "wfr_currentness_reset";
    const projectPath = path.join(config.rootDir, "project");
    try {
      await config.addWorkspace(projectPath, {
        id: workspaceId,
        name: "workflow-currentness-reset",
        projectName: "project",
        projectPath,
        runtimeConfig: { type: "local" },
      });
      const workspaceService = createWorkspaceServiceForTest({
        config,
        historyService,
        aiService: createMockAIService({
          stopStream: mock(() => Promise.resolve(Ok(undefined))),
        }),
        extensionMetadata: new ExtensionMetadataService(
          path.join(config.rootDir, "extensionMetadata.json")
        ),
        initStateManager: {
          ...mockInitStateManager,
          off: mock(() => undefined as unknown as InitStateManager),
        } as unknown as InitStateManager,
      });

      await historyService.appendToHistory(
        workspaceId,
        createMuxMessage("assistant-workflow-run", "assistant", "", { timestamp: 1_000 }, [
          {
            type: "dynamic-tool",
            toolCallId: "workflow-call-1",
            toolName: "workflow_run",
            state: "output-available",
            input: { script_path: "./workflows/demo.js", args: {}, run_in_background: true },
            output: { status: "running", runId, result: null },
          },
        ])
      );
      expect(await workspaceService.isWorkflowInvocationCurrent(workspaceId, runId)).toBe(true);

      await historyService.appendToHistory(
        workspaceId,
        createMuxMessage("reset-boundary", "assistant", "Context reset", {
          timestamp: 1_100,
          contextBoundaryKind: "reset",
        })
      );

      expect(await workspaceService.isWorkflowInvocationCurrent(workspaceId, runId)).toBe(false);
      await workspaceService.disposeSession(workspaceId);
    } finally {
      await cleanup();
    }
  });

  test("keeps workflow current after non-terminal task_await errors", async () => {
    const { config, historyService, cleanup } = await createTestHistoryService();
    const workspaceId = "workflow-currentness-error";
    const runId = "wfr_currentness_error";
    const projectPath = path.join(config.rootDir, "project");
    try {
      await config.addWorkspace(projectPath, {
        id: workspaceId,
        name: "workflow-currentness-error",
        projectName: "project",
        projectPath,
        runtimeConfig: { type: "local" },
      });
      const workspaceService = createWorkspaceServiceForTest({
        config,
        historyService,
        aiService: createMockAIService({
          stopStream: mock(() => Promise.resolve(Ok(undefined))),
        }),
        extensionMetadata: new ExtensionMetadataService(
          path.join(config.rootDir, "extensionMetadata.json")
        ),
        initStateManager: {
          ...mockInitStateManager,
          off: mock(() => undefined as unknown as InitStateManager),
        } as unknown as InitStateManager,
      });

      await historyService.appendToHistory(
        workspaceId,
        createMuxMessage("assistant-workflow-run", "assistant", "", { timestamp: 1_000 }, [
          {
            type: "dynamic-tool",
            toolCallId: "workflow-call-1",
            toolName: "workflow_run",
            state: "output-available",
            input: { script_path: "./workflows/demo.js", args: {}, run_in_background: true },
            output: { status: "running", runId, result: null },
          },
        ])
      );
      await historyService.appendToHistory(
        workspaceId,
        createMuxMessage(
          "assistant-task-await-active-error",
          "assistant",
          "",
          { timestamp: 1_100 },
          [
            {
              type: "dynamic-tool",
              toolCallId: "task-await-1",
              toolName: "task_await",
              state: "output-available",
              input: { task_ids: [runId] },
              output: {
                results: [
                  {
                    taskId: runId,
                    status: "error",
                    error: "Interrupted",
                    run: { id: runId, status: "running" },
                  },
                ],
              },
            },
          ]
        )
      );

      expect(await workspaceService.isWorkflowInvocationCurrent(workspaceId, runId)).toBe(true);

      await historyService.appendToHistory(
        workspaceId,
        createMuxMessage(
          "assistant-task-await-failed-error",
          "assistant",
          "",
          { timestamp: 1_200 },
          [
            {
              type: "dynamic-tool",
              toolCallId: "task-await-2",
              toolName: "task_await",
              state: "output-available",
              input: { task_ids: [runId] },
              output: {
                results: [
                  {
                    taskId: runId,
                    status: "error",
                    error: "Workflow failed",
                    run: { id: runId, status: "failed" },
                  },
                ],
              },
            },
          ]
        )
      );

      expect(await workspaceService.isWorkflowInvocationCurrent(workspaceId, runId)).toBe(false);
      await workspaceService.disposeSession(workspaceId);
    } finally {
      await cleanup();
    }
  });

  test("marks workflow invocations consumed after terminal task_await results", async () => {
    const { config, historyService, cleanup } = await createTestHistoryService();
    const workspaceId = "workflow-currentness-consumed";
    const runId = "wfr_currentness_consumed";
    const projectPath = path.join(config.rootDir, "project");
    try {
      await config.addWorkspace(projectPath, {
        id: workspaceId,
        name: "workflow-currentness-consumed",
        projectName: "project",
        projectPath,
        runtimeConfig: { type: "local" },
      });
      const workspaceService = createWorkspaceServiceForTest({
        config,
        historyService,
        aiService: createMockAIService({
          stopStream: mock(() => Promise.resolve(Ok(undefined))),
        }),
        extensionMetadata: new ExtensionMetadataService(
          path.join(config.rootDir, "extensionMetadata.json")
        ),
        initStateManager: {
          ...mockInitStateManager,
          off: mock(() => undefined as unknown as InitStateManager),
        } as unknown as InitStateManager,
      });

      await historyService.appendToHistory(
        workspaceId,
        createMuxMessage("assistant-workflow-run", "assistant", "", { timestamp: 1_000 }, [
          {
            type: "dynamic-tool",
            toolCallId: "workflow-call-1",
            toolName: "workflow_run",
            state: "output-available",
            input: { script_path: "./workflows/demo.js", args: {}, run_in_background: true },
            output: { status: "running", runId, result: null },
          },
        ])
      );
      expect(await workspaceService.isWorkflowInvocationCurrent(workspaceId, runId)).toBe(true);

      await historyService.appendToHistory(
        workspaceId,
        createMuxMessage("assistant-task-await", "assistant", "", { timestamp: 1_100 }, [
          {
            type: "dynamic-tool",
            toolCallId: "task-await-1",
            toolName: "task_await",
            state: "output-available",
            input: { task_ids: [runId] },
            output: { results: [{ taskId: runId, status: "completed" }] },
          },
        ])
      );

      expect(await workspaceService.isWorkflowInvocationCurrent(workspaceId, runId)).toBe(false);
      await workspaceService.disposeSession(workspaceId);
    } finally {
      await cleanup();
    }
  });
});

describe("WorkspaceService truncateHistory goal acknowledgment", () => {
  async function createServices(aiServiceOverride?: AIService) {
    const { config, historyService, cleanup } = await createTestHistoryService();
    const extensionMetadata = new ExtensionMetadataService(
      path.join(config.rootDir, "extensionMetadata.json")
    );
    const aiService =
      aiServiceOverride ??
      ({
        ...createStreamLifecycleMocks(),
        on: mock(() => undefined),
        isStreaming: mock(() => false),
      } as unknown as AIService);
    const initStateManager = {
      on: mock(() => undefined),
      getInitState: mock(() => null),
    } as unknown as InitStateManager;
    const workspaceService = new WorkspaceService(
      withExistingConfigLoader(config),
      historyService,
      aiService,
      initStateManager,
      extensionMetadata,
      mockBackgroundProcessManager as BackgroundProcessManager
    );
    const goalService = new WorkspaceGoalService(config, historyService, extensionMetadata);
    workspaceService.setWorkspaceGoalService(goalService);
    return { aiService, config, historyService, workspaceService, goalService, cleanup };
  }

  test("requireIdle sends carry a live idle-admission probe re-evaluated at session gates", async () => {
    // Codex P1 (PRRT_kwDOPxxmWM6cJ6NI): the preflight count check at
    // sendMessage entry is a one-shot snapshot — a manual send can enter
    // preflight during the later admission awaits, before the continuation
    // makes the session busy. The forwarded admissionStale probe must sample
    // the LIVE preflight count so AgentSession's admission gates (re-evaluated
    // up to the last gate before the pre-turn batch becomes irrevocable) can
    // refuse the continuation.
    const { config, workspaceService, cleanup } = await createServices();
    const workspaceId = "require-idle-admission-probe";
    const internalAccess = workspaceService as unknown as {
      sessions: Map<string, AgentSession>;
      preflightSendCounts: Map<string, number>;
    };
    try {
      await config.addWorkspace("/tmp/require-idle-probe-project", {
        id: workspaceId,
        name: workspaceId,
        projectName: "require-idle-probe-project",
        projectPath: "/tmp/require-idle-probe-project",
        runtimeConfig: { type: "local" },
      });
      let capturedProbe: (() => boolean) | undefined;
      const fakeSession = {
        isBusy: mock(() => false),
        emitMetadata: mock(() => undefined),
        drainQueuedMessagesIfIdle: mock(() => undefined),
        sendMessage: mock(
          (_msg: string, _opts: unknown, internal?: { admissionStale?: () => boolean }) => {
            capturedProbe = internal?.admissionStale;
            return Promise.resolve(Ok(undefined));
          }
        ),
      } as unknown as AgentSession;
      internalAccess.sessions.set(workspaceId, fakeSession);

      const result = await workspaceService.sendMessage(
        workspaceId,
        "Continue working on the goal.",
        { model: "openai:gpt-4o", agentId: "exec" },
        { synthetic: true, agentInitiated: true, requireIdle: true, goalContinuation: true }
      );
      expect(result.success).toBe(true);
      expect(typeof capturedProbe).toBe("function");

      // Live sampling: idle (only the continuation itself would hold a slot).
      expect(capturedProbe?.()).toBe(false);
      // A manual send entering preflight while the continuation is still in
      // its admission awaits (continuation slot + manual slot) flips the
      // probe stale — even though the entry snapshot passed.
      internalAccess.preflightSendCounts.set(workspaceId, 2);
      expect(capturedProbe?.()).toBe(true);
      internalAccess.preflightSendCounts.delete(workspaceId);
    } finally {
      internalAccess.sessions.delete(workspaceId);
      await cleanup();
    }
  });

  test("idle wait follows auto-retry startup into the resumed stream", async () => {
    const { workspaceService, cleanup } = await createServices();
    const workspaceId = "idle-wait-auto-retry-starting";
    const chatEvents = new EventEmitter();
    let busy = false;
    let pendingAutoRetry = true;
    const idleWaiters: Array<() => void> = [];
    const waitForIdle = mock(() => {
      if (!busy) {
        return Promise.resolve();
      }
      return new Promise<void>((resolve) => {
        idleWaiters.push(resolve);
      });
    });
    interface WaitSessionEvent {
      message: { type: string };
    }
    const session = {
      closingSignal: new AbortController().signal,
      isBusy: mock(() => busy),
      hasActiveOrPendingTurnWork: mock(() => busy),
      hasQueuedMessages: mock(() => false),
      hasPendingAutoRetry: mock(() => pendingAutoRetry),
      waitForIdle,
      onChatEvent: mock((listener: (event: WaitSessionEvent) => void) => {
        chatEvents.on("chat-event", listener);
        return () => chatEvents.off("chat-event", listener);
      }),
    } as unknown as AgentSession;
    const internalWorkspaceService = workspaceService as unknown as {
      sessions: Map<string, AgentSession>;
    };

    try {
      internalWorkspaceService.sessions.set(workspaceId, session);
      let resolved = false;
      const waitPromise = workspaceService.waitForIdleAndNoQueuedMessages(workspaceId).then(() => {
        resolved = true;
      });
      await Promise.resolve();

      chatEvents.emit("chat-event", { message: { type: "auto-retry-starting" } });
      await Promise.resolve();
      expect(resolved).toBe(false);

      busy = true;
      chatEvents.emit("chat-event", { message: { type: "stream-lifecycle" } });
      await waitForCondition(() => idleWaiters.length === 1);
      expect(resolved).toBe(false);

      busy = false;
      pendingAutoRetry = false;
      idleWaiters.splice(0).forEach((resolve) => resolve());
      await waitPromise;

      expect(resolved).toBe(true);
      expect(waitForIdle).toHaveBeenCalledTimes(1);
    } finally {
      internalWorkspaceService.sessions.delete(workspaceId);
      await cleanup();
    }
  });

  test("idle wait outlasts a pending mid-stream compaction request", async () => {
    const { workspaceService, cleanup } = await createServices();
    const workspaceId = "idle-wait-pending-compaction";
    const session = workspaceService.getOrCreateSession(workspaceId);
    const { coordinator } = session as unknown as { coordinator: TurnCoordinator };
    const token = coordinator.beginCompactionObservation("legacy");
    if (token == null) throw new Error("Expected compaction observation");
    try {
      coordinator.setCompactionStage(token, "stopping");
      let resolved = false;
      const waitPromise = workspaceService.waitForIdleAndNoQueuedMessages(workspaceId).then(() => {
        resolved = true;
      });
      await drainPendingDispatches();
      expect(resolved).toBe(false);

      // The compaction request never became a turn: no stream event fires, only the window closes.
      coordinator.finishCompactionObservation(token);
      await waitPromise;
      expect(resolved).toBe(true);
    } finally {
      await cleanup();
    }
  });

  test("destructive clear waits for startup monitor recovery discovery", async () => {
    const { historyService, workspaceService, cleanup } = await createServices();
    const workspaceId = "clear-waits-for-monitor-recovery";
    const recovery = createDeferred<void>();
    const internal = workspaceService as unknown as {
      bashMonitorRecoveryPromise: Promise<void>;
    };
    internal.bashMonitorRecoveryPromise = recovery.promise;
    const truncateSpy = spyOn(historyService, "truncateHistory").mockResolvedValue(Ok([]));

    try {
      const clearPromise = workspaceService.truncateHistory(workspaceId, 1.0);
      await drainPendingDispatches();
      expect(truncateSpy).not.toHaveBeenCalled();

      recovery.resolve();
      expect(await clearPromise).toEqual(Ok(undefined));
      expect(truncateSpy).toHaveBeenCalledTimes(1);
    } finally {
      recovery.resolve();
      truncateSpy.mockRestore();
      await cleanup();
    }
  });

  test("full chat clear preserves the goal and requires user acknowledgment", async () => {
    const { config, historyService, workspaceService, goalService, cleanup } =
      await createServices();
    const workspaceId = "clear-goal-workspace";
    try {
      await config.addWorkspace("/tmp/clear-goal-project", {
        id: workspaceId,
        name: "clear-goal-workspace",
        projectName: "clear-goal-project",
        projectPath: "/tmp/clear-goal-project",
        runtimeConfig: { type: "local" },
      });
      const created = await setWorkspaceGoalOk(goalService, {
        workspaceId,
        objective: "Keep pursuing the objective",
      });
      const appendResult = await historyService.appendToHistory(
        workspaceId,
        createMuxMessage("clear-goal-message", "user", "please remember this", {})
      );
      expect(appendResult.success).toBe(true);

      const nowSpy = spyOn(Date, "now").mockReturnValue(1_234_567);
      try {
        const result = await workspaceService.truncateHistory(workspaceId, 1.0);
        expect(result.success).toBe(true);
      } finally {
        nowSpy.mockRestore();
      }

      expect(await goalService.getGoal(workspaceId)).toMatchObject({
        goalId: created.goalId,
        objective: created.objective,
        requireUserAcknowledgmentSinceMs: 1_234_567,
      });
    } finally {
      await cleanup();
    }
  });

  test("full chat clear without a goal does not create goal state", async () => {
    const { config, workspaceService, goalService, cleanup } = await createServices();
    const workspaceId = "clear-without-goal-workspace";
    try {
      await config.addWorkspace("/tmp/clear-without-goal-project", {
        id: workspaceId,
        name: "clear-without-goal-workspace",
        projectName: "clear-without-goal-project",
        projectPath: "/tmp/clear-without-goal-project",
        runtimeConfig: { type: "local" },
      });

      const result = await workspaceService.truncateHistory(workspaceId, 1.0);

      expect(result.success).toBe(true);
      expect(await goalService.getGoal(workspaceId)).toBeNull();
    } finally {
      await cleanup();
    }
  });

  test("context reset appends a boundary and preserves transcript history", async () => {
    const { config, historyService, workspaceService, cleanup } = await createServices();
    const workspaceId = "context-reset-preserves-history";
    try {
      await config.addWorkspace("/tmp/context-reset-project", {
        id: workspaceId,
        name: workspaceId,
        projectName: "context-reset-project",
        projectPath: "/tmp/context-reset-project",
        runtimeConfig: { type: "local" },
      });
      expect(
        (
          await historyService.appendToHistory(
            workspaceId,
            createMuxMessage("pre-reset-user", "user", "before reset", {})
          )
        ).success
      ).toBe(true);

      const result = await workspaceService.resetContext(workspaceId);

      expect(result).toEqual({ success: true, data: "reset" });
      const activeWindow = await historyService.getHistoryFromLatestBoundary(workspaceId);
      expect(activeWindow.success).toBe(true);
      const activeIds = activeWindow.success ? activeWindow.data.map((message) => message.id) : [];
      expect(activeIds).toHaveLength(1);
      expect(activeIds[0]?.startsWith("context-reset-")).toBe(true);
      expect(
        activeWindow.success ? activeWindow.data[0]?.metadata?.contextBoundaryKind : undefined
      ).toBe("reset");

      const allMessages: string[] = [];
      const iterateResult = await historyService.iterateFullHistory(
        workspaceId,
        "forward",
        (messages) => {
          allMessages.push(...messages.map((message) => message.id));
        }
      );
      expect(iterateResult.success).toBe(true);
      expect(allMessages).toHaveLength(2);
      expect(allMessages[0]).toBe("pre-reset-user");
      expect(allMessages[1]?.startsWith("context-reset-")).toBe(true);
    } finally {
      await cleanup();
    }
  });

  test("start-here replacement does not auto-compact the next send from stale usage", async () => {
    const { config, historyService, workspaceService, cleanup } = await createServices();
    const workspaceId = "start-here-clears-usage-state";
    const streamMessage = mock((..._args: unknown[]) =>
      Promise.resolve(Ok(createStartedTurnHandle(harness.session.closingSignal)))
    );
    const harness = await createAgentSessionHarness({
      workspaceId,
      config,
      historyService,
      aiServiceOverrides: {
        streamMessage: streamMessage as unknown as AIService["streamMessage"],
      },
    });
    try {
      await config.addWorkspace("/tmp/start-here-usage-project", {
        id: workspaceId,
        name: workspaceId,
        projectName: "start-here-usage-project",
        projectPath: "/tmp/start-here-usage-project",
        runtimeConfig: { type: "local" },
      });
      await historyService.appendToHistory(
        workspaceId,
        createMuxMessage("pre-start-here-user", "user", "long conversation", {})
      );
      await historyService.appendToHistory(
        workspaceId,
        createMuxMessage("pre-start-here-assistant", "assistant", "long reply", {
          model: "openai:gpt-4o",
          contextUsage: { inputTokens: 95_000, outputTokens: 200, totalTokens: 95_200 },
        })
      );

      (workspaceService as unknown as { sessions: Map<string, AgentSession> }).sessions.set(
        workspaceId,
        harness.session
      );
      (harness.session as unknown as { lastUsageState?: AutoCompactionUsageState }).lastUsageState =
        {
          lastContextUsage: createDisplayUsage(
            { inputTokens: 95_000, outputTokens: 200, totalTokens: 95_200 },
            "openai:gpt-4o"
          ),
        };

      expect(
        (
          await workspaceService.replaceHistory(
            workspaceId,
            createMuxMessage("start-here-summary", "assistant", "Start Here summary", {
              compacted: "user",
            }),
            { mode: "append-compaction-boundary" }
          )
        ).success
      ).toBe(true);
      expect(
        (
          await harness.session.sendMessage("follow-up after start here", {
            model: "openai:gpt-4o",
            agentId: "exec",
          })
        ).success
      ).toBe(true);

      const activeWindow = await historyService.getHistoryFromLatestBoundary(workspaceId);
      expect(activeWindow.success).toBe(true);
      const activeMessages = activeWindow.success ? activeWindow.data : [];
      expect(
        activeMessages.filter(
          (message) => message.metadata?.muxMetadata?.type === "compaction-request"
        )
      ).toHaveLength(0);
      expect(activeMessages.find((message) => message.role === "user")?.parts[0]).toMatchObject({
        type: "text",
        text: "follow-up after start here",
      });
      expect(streamMessage).toHaveBeenCalledTimes(1);
    } finally {
      await harness.session.dispose();
      await cleanup();
    }
  });

  test("context reset is a no-op when repeated without provider-eligible messages", async () => {
    const { config, historyService, workspaceService, cleanup } = await createServices();
    const workspaceId = "context-reset-noop";
    try {
      await config.addWorkspace("/tmp/context-reset-noop-project", {
        id: workspaceId,
        name: workspaceId,
        projectName: "context-reset-noop-project",
        projectPath: "/tmp/context-reset-noop-project",
        runtimeConfig: { type: "local" },
      });
      expect(
        (
          await historyService.appendToHistory(
            workspaceId,
            createMuxMessage("pre-reset-user", "user", "before reset", {})
          )
        ).success
      ).toBe(true);

      expect(await workspaceService.resetContext(workspaceId)).toEqual({
        success: true,
        data: "reset",
      });
      expect(await workspaceService.resetContext(workspaceId)).toEqual({
        success: true,
        data: "noop",
      });

      let boundaryCount = 0;
      const iterateResult = await historyService.iterateFullHistory(
        workspaceId,
        "forward",
        (messages) => {
          boundaryCount += messages.filter(
            (message) => message.metadata?.contextBoundaryKind === "reset"
          ).length;
        }
      );
      expect(iterateResult.success).toBe(true);
      expect(boundaryCount).toBe(1);
    } finally {
      await cleanup();
    }
  });

  test("context reset discards persisted post-compaction carryover", async () => {
    // An RLM compaction persists cumulative read-file paths / loaded skills
    // (post-compaction.json). A reset starts a NEW context segment: without
    // discarding that state, a later turn would inject PRE-reset read paths
    // (even in a fresh session after a restart), resurrecting context the
    // reset was meant to discard.
    const { config, historyService, workspaceService, cleanup } = await createServices();
    const workspaceId = "context-reset-post-compaction";
    try {
      await config.addWorkspace("/tmp/context-reset-post-compaction-project", {
        id: workspaceId,
        name: workspaceId,
        projectName: "context-reset-post-compaction-project",
        projectPath: "/tmp/context-reset-post-compaction-project",
        runtimeConfig: { type: "local" },
      });
      await historyService.appendToHistory(
        workspaceId,
        createMuxMessage("pre-reset-user", "user", "before reset", {})
      );
      const sessionDir = path.join(config.sessionsDir, workspaceId);
      await fsPromises.mkdir(sessionDir, { recursive: true });
      const pendingStatePath = path.join(sessionDir, "post-compaction.json");
      await fsPromises.writeFile(
        pendingStatePath,
        JSON.stringify({
          version: 1,
          createdAt: Date.now(),
          diffs: [],
          loadedSkills: [],
          readFiles: ["/tmp/pre-reset-read.ts"],
        })
      );

      expect(await workspaceService.resetContext(workspaceId)).toEqual({
        success: true,
        data: "reset",
      });

      const stateExists = await fsPromises.access(pendingStatePath).then(
        () => true,
        () => false
      );
      expect(stateExists).toBe(false);
    } finally {
      await cleanup();
    }
  });

  test("context reset fails when the post-compaction carryover discard is not durable", async () => {
    // Best-effort deletion of post-compaction.json swallowed unlink failures
    // while resetContext still reported success — after a restart the stale
    // file re-injects PRE-reset read paths/skills/diffs. The discard must be
    // durable-or-fail, matching the sandbox invalidation posture.
    const { config, historyService, workspaceService, cleanup } = await createServices();
    const workspaceId = "context-reset-carryover-not-durable";
    try {
      await config.addWorkspace("/tmp/context-reset-carryover-project", {
        id: workspaceId,
        name: workspaceId,
        projectName: "context-reset-carryover-project",
        projectPath: "/tmp/context-reset-carryover-project",
        runtimeConfig: { type: "local" },
      });
      await historyService.appendToHistory(
        workspaceId,
        createMuxMessage("pre-reset-user", "user", "before reset", {})
      );
      // Deterministic unlink failure: a DIRECTORY at the pending-state path
      // fails unlink with EISDIR (read errors are swallowed at load, so this
      // models exactly the stale-undeletable-file case).
      const pendingStatePath = path.join(config.sessionsDir, workspaceId, "post-compaction.json");
      await fsPromises.mkdir(pendingStatePath, { recursive: true });

      const result = await workspaceService.resetContext(workspaceId);
      expect(result.success).toBe(false);
      expect(result.success ? "" : result.error).toContain("post-compaction carryover");
    } finally {
      await cleanup();
    }
  });

  test("context reset fails when the sandbox invalidation is not durable", async () => {
    // The reset's kernel-vars invalidation is only durable once the
    // empty-snapshot tombstone publishes; the in-memory reset-pending guard
    // dies with the process. Reporting Ok on a failed publish would hide that
    // a restart can resurrect the cleared (potentially sensitive) vars, so
    // the failure must reach the caller as a partial-failure error.
    const { config, historyService, workspaceService, cleanup } = await createServices();
    const workspaceId = "context-reset-sandbox-invalidation";
    try {
      await config.addWorkspace("/tmp/context-reset-sandbox-project", {
        id: workspaceId,
        name: workspaceId,
        projectName: "context-reset-sandbox-project",
        projectPath: "/tmp/context-reset-sandbox-project",
        runtimeConfig: { type: "local" },
      });
      await historyService.appendToHistory(
        workspaceId,
        createMuxMessage("pre-reset-user", "user", "before reset", {})
      );
      const discardSpy = spyOn(sandboxHostService, "discardScope").mockImplementationOnce(() =>
        Promise.reject(new Error("journal write failed"))
      );

      try {
        const result = await workspaceService.resetContext(workspaceId);
        expect(result.success).toBe(false);
        expect(result.success ? "" : result.error).toContain("durably invalidated");
        expect(result.success ? "" : result.error).toContain("journal write failed");

        // A retry reaches the no-op branch (the boundary row already
        // landed) — it must RE-ATTEMPT the pending cleanup, not report
        // success while the invalidation is still not durable: a restart
        // could otherwise restore pre-reset kernel vars across the boundary.
        discardSpy.mockImplementationOnce(() => Promise.reject(new Error("journal write failed")));
        const retry = await workspaceService.resetContext(workspaceId);
        expect(retry.success).toBe(false);
        expect(retry.success ? "" : retry.error).toContain("durably invalidated");
      } finally {
        discardSpy.mockRestore();
      }

      // Once cleanup succeeds, the retry settles as a clean noop (the
      // chat-side boundary already applied; the real discard re-runs and
      // lands durably).
      expect(await workspaceService.resetContext(workspaceId)).toEqual({
        success: true,
        data: "noop",
      });
    } finally {
      await cleanup();
    }
  });

  test("full history clear durably discards sandbox kernel state", async () => {
    // A full /clear removes the transcript; kernel vars DERIVED from it (and
    // restorable from the latest durable snapshot after a restart) must not
    // stay readable through the sandbox — same invalidation boundary as
    // resetContext. Partial truncation keeps context, so it must NOT discard.
    const { config, historyService, workspaceService, cleanup } = await createServices();
    const workspaceId = "full-clear-sandbox-discard";
    try {
      await config.addWorkspace("/tmp/full-clear-sandbox-project", {
        id: workspaceId,
        name: workspaceId,
        projectName: "full-clear-sandbox-project",
        projectPath: "/tmp/full-clear-sandbox-project",
        runtimeConfig: { type: "local" },
      });
      // Two similar-size messages: 50% removes only the first, keeping the truncation genuinely
      // partial (a one-message 50% empties history and routes as a full clear).
      await historyService.appendToHistory(
        workspaceId,
        createMuxMessage("pre-clear-user", "user", "before clear", {})
      );
      await historyService.appendToHistory(
        workspaceId,
        createMuxMessage("pre-clear-user-b", "user", "still here", {})
      );
      const discardSpy = spyOn(sandboxHostService, "discardScope").mockImplementation(() =>
        Promise.resolve()
      );
      try {
        expect(await workspaceService.truncateHistory(workspaceId, 0.5)).toEqual({
          success: true,
          data: undefined,
        });
        expect(discardSpy).not.toHaveBeenCalled();

        expect(await workspaceService.truncateHistory(workspaceId)).toEqual({
          success: true,
          data: undefined,
        });
        expect(discardSpy).toHaveBeenCalledTimes(1);

        // Same partial-failure posture as resetContext: history IS cleared,
        // but a non-durable invalidation must fail the operation (a restart
        // could otherwise resurrect the cleared vars from the snapshot).
        await historyService.appendToHistory(
          workspaceId,
          createMuxMessage("pre-clear-user-2", "user", "before second clear", {})
        );
        discardSpy.mockImplementationOnce(() => Promise.reject(new Error("journal write failed")));
        const failed = await workspaceService.truncateHistory(workspaceId);
        expect(failed.success).toBe(false);
        expect(failed.success ? "" : failed.error).toContain("durably invalidated");
      } finally {
        discardSpy.mockRestore();
      }
    } finally {
      await cleanup();
    }
  });

  test("context-discarding mutations drain in-flight refine passes", async () => {
    // A streaming refine pass distills the current transcript; reset and
    // full clear discard it, so both must cancel + drain the pass before
    // mutating (a late proposal would otherwise describe discarded context).
    // Partial truncation keeps context and must NOT drain.
    const { config, historyService, workspaceService, cleanup } = await createServices();
    const workspaceId = "clear-drains-refine";
    try {
      await config.addWorkspace("/tmp/clear-drains-refine-project", {
        id: workspaceId,
        name: workspaceId,
        projectName: "clear-drains-refine-project",
        projectPath: "/tmp/clear-drains-refine-project",
        runtimeConfig: { type: "local" },
      });
      // Two similar-size messages keep the 50% truncation genuinely partial (see the sandbox
      // discard test above).
      await historyService.appendToHistory(
        workspaceId,
        createMuxMessage("pre-clear-user", "user", "before clear", {})
      );
      await historyService.appendToHistory(
        workspaceId,
        createMuxMessage("pre-clear-user-b", "user", "still here", {})
      );
      const drained: string[] = [];
      workspaceService.setRefinePassCanceller({
        cancelInFlightRefinePass: (id) => {
          drained.push(id);
          return Promise.resolve();
        },
      });

      expect((await workspaceService.truncateHistory(workspaceId, 0.5)).success).toBe(true);
      expect(drained).toHaveLength(0);

      expect((await workspaceService.truncateHistory(workspaceId)).success).toBe(true);
      expect(drained).toEqual([workspaceId]);

      await historyService.appendToHistory(
        workspaceId,
        createMuxMessage("pre-reset-user", "user", "before reset", {})
      );
      expect((await workspaceService.resetContext(workspaceId)).success).toBe(true);
      expect(drained).toEqual([workspaceId, workspaceId]);
    } finally {
      await cleanup();
    }
  });

  test("context-discarding mutations block send admission across their awaits (r40)", async () => {
    // SECURITY: a full clear awaits the refine drain + cross-process lock
    // BETWEEN its busy check and the truncation. A send admitted during that
    // window would snapshot the pre-clear transcript and stream across the
    // clear, repopulating the cleared context — so the mutation publishes an
    // admission guard BEFORE its first await: new sends reject at the door
    // and concurrent mutations are refused.
    const { config, historyService, workspaceService, cleanup } = await createServices();
    const workspaceId = "clear-blocks-sends";
    try {
      await config.addWorkspace("/tmp/clear-blocks-sends-project", {
        id: workspaceId,
        name: workspaceId,
        projectName: "clear-blocks-sends-project",
        projectPath: "/tmp/clear-blocks-sends-project",
        runtimeConfig: { type: "local" },
      });
      await historyService.appendToHistory(
        workspaceId,
        createMuxMessage("pre-clear-user", "user", "before clear", {})
      );
      const drainStarted = createDeferred<void>();
      const releaseDrain = createDeferred<void>();
      workspaceService.setRefinePassCanceller({
        cancelInFlightRefinePass: async () => {
          drainStarted.resolve();
          await releaseDrain.promise;
        },
      });

      const clearPromise = workspaceService.truncateHistory(workspaceId);
      await drainStarted.promise;

      // Mid-await: the guard is already published.
      const sendResult = await workspaceService.sendMessage(workspaceId, "hello", {
        model: "anthropic:claude-sonnet-4-6",
        thinkingLevel: "off",
        toolPolicy: [],
        agentId: "exec",
      });
      expect(sendResult).toEqual({
        success: false,
        error: {
          type: "unknown",
          raw: "Workspace history is being cleared or reset. Please wait and try again.",
        },
      });
      expect(await workspaceService.resetContext(workspaceId)).toEqual({
        success: false,
        error: "A context reset or clear is already in progress for this workspace.",
      });

      releaseDrain.resolve();
      expect(await clearPromise).toEqual({ success: true, data: undefined });
      // Guard released: a follow-up mutation is admitted again.
      expect(await workspaceService.resetContext(workspaceId)).toEqual({
        success: true,
        data: "noop",
      });
    } finally {
      await cleanup();
    }
  });

  test("full clear fails closed when a turn starts during its awaits (r40)", async () => {
    // A turn start that bypasses send admission (in-turn compaction retries
    // crossing a transient idle gap) can begin streaming while the clear sits
    // in its refine drain/lock awaits. The busy recheck under the guard +
    // lock must fail the mutation instead of truncating under a live stream.
    let streaming = false;
    const aiService = {
      ...createStreamLifecycleMocks(),
      on: mock(() => undefined),
      isStreaming: mock(() => streaming),
    } as unknown as AIService;
    const { config, historyService, workspaceService, cleanup } = await createServices(aiService);
    const workspaceId = "clear-recheck-busy";
    try {
      await config.addWorkspace("/tmp/clear-recheck-busy-project", {
        id: workspaceId,
        name: workspaceId,
        projectName: "clear-recheck-busy-project",
        projectPath: "/tmp/clear-recheck-busy-project",
        runtimeConfig: { type: "local" },
      });
      await historyService.appendToHistory(
        workspaceId,
        createMuxMessage("pre-clear-user", "user", "before clear", {})
      );
      workspaceService.setRefinePassCanceller({
        cancelInFlightRefinePass: () => {
          // A stream starts exactly inside the mutation's await window.
          streaming = true;
          return Promise.resolve();
        },
      });

      const result = await workspaceService.truncateHistory(workspaceId);
      expect(result).toEqual({
        success: false,
        error:
          "Cannot truncate history while a turn is active. Press Esc to stop the stream first.",
      });
      // Failed closed: nothing was truncated under the live stream.
      const history = await historyService.getHistoryFromLatestBoundary(workspaceId);
      expect(history.success ? history.data : []).toHaveLength(1);

      // Once the stream ends, the clear (and its admission guard) work again.
      streaming = false;
      workspaceService.setRefinePassCanceller({
        cancelInFlightRefinePass: () => Promise.resolve(),
      });
      expect(await workspaceService.truncateHistory(workspaceId)).toEqual({
        success: true,
        data: undefined,
      });
    } finally {
      await cleanup();
    }
  });

  test("acquireIdleTurnExclusion refuses busy workspaces and blocks turn admission while held (r40)", async () => {
    // /refine publication rides this exclusion: it must fail closed when a
    // turn is active and, while held, refuse new turn admission so the
    // published row cannot land inside a PREPARING snapshot window.
    let streaming = true;
    const aiService = {
      ...createStreamLifecycleMocks(),
      on: mock(() => undefined),
      isStreaming: mock(() => streaming),
    } as unknown as AIService;
    const { config, workspaceService, cleanup } = await createServices(aiService);
    const workspaceId = "refine-turn-exclusion";
    try {
      await config.addWorkspace("/tmp/refine-turn-exclusion-project", {
        id: workspaceId,
        name: workspaceId,
        projectName: "refine-turn-exclusion-project",
        projectPath: "/tmp/refine-turn-exclusion-project",
        runtimeConfig: { type: "local" },
      });

      expect(workspaceService.acquireIdleTurnExclusion(workspaceId)).toEqual({
        success: false,
        error: "a turn is preparing or streaming",
      });

      streaming = false;
      const exclusion = workspaceService.acquireIdleTurnExclusion(workspaceId);
      expect(exclusion.success).toBe(true);
      if (!exclusion.success) return;
      try {
        const sendResult = await workspaceService.sendMessage(workspaceId, "hello", {
          model: "anthropic:claude-sonnet-4-6",
          thinkingLevel: "off",
          toolPolicy: [],
          agentId: "exec",
        });
        expect(sendResult).toEqual({
          success: false,
          error: {
            type: "unknown",
            raw: "Workspace history is being cleared or reset. Please wait and try again.",
          },
        });
      } finally {
        exclusion.data[Symbol.dispose]();
      }
    } finally {
      await cleanup();
    }
  });

  test("acquireIdleTurnExclusion refuses while a send is in its pre-admission window (r41)", async () => {
    // Release-before-resume: a send past the entry check may have already
    // persisted its user row while the session still looks idle. If refine
    // published and released here, the proposal row would land after that
    // user row and enter the send's request as a trailing foreign assistant
    // row — the exclusion must refuse instead.
    const { config, historyService, workspaceService, cleanup } = await createServices();
    const workspaceId = "refine-preflight-send";
    try {
      await config.addWorkspace("/tmp/refine-preflight-project", {
        id: workspaceId,
        name: workspaceId,
        projectName: "refine-preflight-project",
        projectPath: "/tmp/refine-preflight-project",
        runtimeConfig: { type: "local" },
      });

      const appendReached = createDeferred<void>();
      const releaseAppend = createDeferred<void>();
      const originalAppend = historyService.appendToHistory.bind(historyService);
      const appendSpy = spyOn(historyService, "appendToHistory").mockImplementationOnce(
        async (...args: Parameters<HistoryService["appendToHistory"]>) => {
          appendReached.resolve();
          await releaseAppend.promise;
          return originalAppend(...args);
        }
      );
      try {
        const sendPromise = workspaceService.sendMessage(workspaceId, "hello", {
          model: "anthropic:claude-sonnet-4-6",
          thinkingLevel: "off",
          toolPolicy: [],
          agentId: "exec",
        });
        await appendReached.promise;

        expect(workspaceService.acquireIdleTurnExclusion(workspaceId)).toEqual({
          success: false,
          error: "a send is being admitted",
        });

        releaseAppend.resolve();
        // The send fails at stream startup (no provider in this fixture) —
        // only its settled outcome matters here.
        await sendPromise;

        // Preflight released: the exclusion is available again.
        const exclusion = workspaceService.acquireIdleTurnExclusion(workspaceId);
        expect(exclusion.success).toBe(true);
        if (exclusion.success) {
          exclusion.data[Symbol.dispose]();
        }
      } finally {
        appendSpy.mockRestore();
      }
    } finally {
      await cleanup();
    }
  });

  test("context mutations are refused while a send is in its pre-admission window (r42)", async () => {
    // SECURITY: a send past the entry check may have passed its pre-persist
    // gate but not yet appended its rows (family payload + user row). A
    // mutation committing in that window would leave those rows — composed
    // against, and possibly influenced by, the discarded context — durably in
    // the fresh transcript: the epoch gate blocks the send's stream but
    // cannot un-append. The mutation must refuse while the send is in
    // preflight, and succeed again once it settles.
    const { config, historyService, workspaceService, cleanup } = await createServices();
    const workspaceId = "mutation-refuses-preflight";
    try {
      await config.addWorkspace("/tmp/mutation-refuses-preflight-project", {
        id: workspaceId,
        name: workspaceId,
        projectName: "mutation-refuses-preflight-project",
        projectPath: "/tmp/mutation-refuses-preflight-project",
        runtimeConfig: { type: "local" },
      });
      await historyService.appendToHistory(
        workspaceId,
        createMuxMessage("pre-clear-user", "user", "before clear", {})
      );

      // Park the send at its user-row append: past every entry check and the
      // pre-persist gate, strictly before its rows land.
      const appendReached = createDeferred<void>();
      const releaseAppend = createDeferred<void>();
      const originalAppend = historyService.appendToHistory.bind(historyService);
      const appendSpy = spyOn(historyService, "appendToHistory").mockImplementationOnce(
        async (...args: Parameters<HistoryService["appendToHistory"]>) => {
          appendReached.resolve();
          await releaseAppend.promise;
          return originalAppend(...args);
        }
      );
      try {
        const sendPromise = workspaceService.sendMessage(workspaceId, "hello", {
          model: "anthropic:claude-sonnet-4-6",
          thinkingLevel: "off",
          toolPolicy: [],
          agentId: "exec",
        });
        await appendReached.promise;

        expect(await workspaceService.truncateHistory(workspaceId)).toEqual({
          success: false,
          error: "Cannot truncate history while a message is being sent. Try again in a moment.",
        });
        expect(await workspaceService.resetContext(workspaceId)).toEqual({
          success: false,
          error: "Cannot reset context while a message is being sent. Try again in a moment.",
        });

        releaseAppend.resolve();
        // The send fails at stream startup (no provider in this fixture) —
        // only its settled outcome matters here.
        await sendPromise;

        // Preflight settled: the clear is admitted and discards everything,
        // including the send's rows — nothing straddles the mutation.
        expect(await workspaceService.truncateHistory(workspaceId)).toEqual({
          success: true,
          data: undefined,
        });
        const history = await historyService.getHistoryFromLatestBoundary(workspaceId);
        expect(history.success ? history.data : ["unexpected"]).toHaveLength(0);
      } finally {
        appendSpy.mockRestore();
      }
    } finally {
      await cleanup();
    }
  });

  test("context mutations and refine exclusion refuse while mid-stream compaction is pending (r43)", async () => {
    // interruptForCompaction stops the original stream, waits for idle, then
    // calls AgentSession.sendMessage directly — bypassing WorkspaceService
    // entry accounting. During that window the session looks idle, so
    // mutations and refine publication must treat pending mid-stream
    // compaction as turn work and refuse.
    const { config, workspaceService, cleanup } = await createServices();
    const workspaceId = "midstream-compaction-guard";
    try {
      await config.addWorkspace("/tmp/midstream-compaction-project", {
        id: workspaceId,
        name: workspaceId,
        projectName: "midstream-compaction-project",
        projectPath: "/tmp/midstream-compaction-project",
        runtimeConfig: { type: "local" },
      });
      const session = workspaceService.getOrCreateSession(workspaceId);
      const pendingSpy = spyOn(session, "hasActiveOrPendingTurnWork").mockReturnValue(true);
      try {
        expect(await workspaceService.truncateHistory(workspaceId)).toEqual({
          success: false,
          error:
            "Cannot truncate history while a turn is active. Press Esc to stop the stream first.",
        });
        expect(await workspaceService.resetContext(workspaceId)).toEqual({
          success: false,
          error: "Cannot reset context while a turn is active. Press Esc to stop the stream first.",
        });
        expect(workspaceService.acquireIdleTurnExclusion(workspaceId)).toEqual({
          success: false,
          error: "a turn is preparing or streaming",
        });
      } finally {
        pendingSpy.mockRestore();
      }
      // Window closed: mutations are admitted again.
      expect(await workspaceService.resetContext(workspaceId)).toEqual({
        success: true,
        data: "noop",
      });
    } finally {
      await cleanup();
    }
  });

  /**
   * Seed a fork-shaped history and drive a background abandoned-branch
   * summary until its row is durably appended, leaving the registration
   * settled but unconsumed (the r43/r44 scenario: settled before the fork's
   * first send). History ends up with 3 rows: m1, m2, summary.
   */
  async function seedSettledBranchSummaryRegistration(
    historyService: HistoryService,
    workspaceId: string
  ): Promise<void> {
    // Fork shape: kept rows end at the guard tail; the abandoned branch is
    // meaty enough to clear the summarization threshold.
    await historyService.appendToHistory(
      workspaceId,
      createMuxMessage("m1", "user", "original question", { timestamp: 1 })
    );
    await historyService.appendToHistory(
      workspaceId,
      createMuxMessage("m2", "assistant", "branch point answer", { timestamp: 2 })
    );
    const filler = "investigated the flaky test and traced the race ".repeat(200);
    const abandonedMessages = [
      createMuxMessage("abandoned-user", "user", `Please fix this: ${filler}`, { timestamp: 3 }),
      createMuxMessage("abandoned-assistant", "assistant", `Findings: ${filler}`, {
        timestamp: 4,
      }),
    ];
    const summaryAiService: BranchSummaryAiService = {
      createModelWithPinnedMetadata: (modelString: string) =>
        Promise.resolve(
          Ok({
            model: new MockLanguageModelV3({
              doStream: () =>
                Promise.resolve({
                  stream: simulateReadableStream({
                    chunks: [
                      { type: "text-start", id: "t1" },
                      { type: "text-delta", id: "t1", delta: "Abandoned: explored a race." },
                      { type: "text-end", id: "t1" },
                      {
                        type: "finish",
                        finishReason: { unified: "stop", raw: "stop" },
                        usage: {
                          inputTokens: { total: 10, noCache: 10, cacheRead: 0, cacheWrite: 0 },
                          outputTokens: { total: 5, text: 5, reasoning: 0 },
                        },
                      } satisfies LanguageModelV3StreamPart,
                    ] satisfies LanguageModelV3StreamPart[],
                  }),
                }),
            }),
            metadataModel: modelString,
          })
        ) as ReturnType<BranchSummaryAiService["createModelWithPinnedMetadata"]>,
      getWorkspaceMetadata: () =>
        Promise.resolve(Ok({ aiSettings: { model: "anthropic:claude-haiku-4-5" } })) as ReturnType<
          BranchSummaryAiService["getWorkspaceMetadata"]
        >,
    };
    await startAbandonedBranchSummaryInBackground({
      historyService,
      aiService: summaryAiService,
      workspaceId,
      abandonedMessages,
      experiments: { rlm: true, programmaticToolCalling: true },
      guardTailMessageId: "m2",
    });
    // Wait for the background generation to append + settle WITHOUT
    // consuming the registration.
    const deadline = Date.now() + 10_000;
    for (;;) {
      const history = await historyService.getHistoryFromLatestBoundary(workspaceId);
      if (history.success && history.data.length === 3) return;
      if (Date.now() > deadline) {
        throw new Error("branch summary row never appended");
      }
      await new Promise((resolve) => setTimeout(resolve, 20));
    }
  }

  test("a full clear drops a settled-but-unconsumed branch-summary registration (r43)", async () => {
    // A fork's summary can append and settle before the fork's first send;
    // the registration stays consumable so that send can emit the row. A
    // full clear deletes the row — the registration must be dropped with it,
    // or the next send re-emits the discarded summary into the live
    // transcript (absent from history after reload).
    const { config, historyService, workspaceService, cleanup } = await createServices();
    const workspaceId = "clear-drops-summary-registration";
    try {
      await config.addWorkspace("/tmp/clear-drops-summary-project", {
        id: workspaceId,
        name: workspaceId,
        projectName: "clear-drops-summary-project",
        projectPath: "/tmp/clear-drops-summary-project",
        runtimeConfig: { type: "local" },
      });
      await seedSettledBranchSummaryRegistration(historyService, workspaceId);

      expect(await workspaceService.truncateHistory(workspaceId)).toEqual({
        success: true,
        data: undefined,
      });

      // The registration went with the row: nothing left to re-emit.
      expect(await awaitPendingBranchSummary(workspaceId)).toBeNull();
      const cleared = await historyService.getHistoryFromLatestBoundary(workspaceId);
      expect(cleared.success ? cleared.data : ["unexpected"]).toHaveLength(0);
    } finally {
      await cleanup();
    }
  });

  test("a failed full clear retains the settled branch-summary registration (r44)", async () => {
    // The registration is dropped only AFTER the truncation commits: dropping
    // it first and then failing the write would leave the durable summary row
    // in history with nothing left to emit it — the provider would see
    // assistant context the user cannot see until a reload.
    const { config, historyService, workspaceService, cleanup } = await createServices();
    const workspaceId = "failed-clear-retains-registration";
    try {
      await config.addWorkspace("/tmp/failed-clear-retains-project", {
        id: workspaceId,
        name: workspaceId,
        projectName: "failed-clear-retains-project",
        projectPath: "/tmp/failed-clear-retains-project",
        runtimeConfig: { type: "local" },
      });
      await seedSettledBranchSummaryRegistration(historyService, workspaceId);

      const truncateSpy = spyOn(historyService, "truncateHistory").mockImplementationOnce(() =>
        Promise.resolve(Err("disk full"))
      );
      try {
        expect(await workspaceService.truncateHistory(workspaceId)).toEqual({
          success: false,
          error: "disk full",
        });
      } finally {
        truncateSpy.mockRestore();
      }

      // The registration survived the failed clear: the next send still
      // consumes and emits the row, which remains in history.
      const summary = await awaitPendingBranchSummary(workspaceId);
      expect(summary).not.toBeNull();
      const history = await historyService.getHistoryFromLatestBoundary(workspaceId);
      expect(history.success).toBe(true);
      if (history.success) {
        expect(history.data.some((row) => row.id === summary?.id)).toBe(true);
      }
    } finally {
      await cleanup();
    }
  });

  test("context-discarding mutations drop pending partials so retries cannot replay them (r41)", async () => {
    // A retry scheduled during backoff would fire after the guard releases,
    // commit the pre-mutation partial, and stream a request derived from the
    // discarded context — mutations must durably drop that state first, and
    // fail closed when they cannot.
    const { config, historyService, workspaceService, cleanup } = await createServices();
    const workspaceId = "clear-discards-partial";
    try {
      await config.addWorkspace("/tmp/clear-discards-partial-project", {
        id: workspaceId,
        name: workspaceId,
        projectName: "clear-discards-partial-project",
        projectPath: "/tmp/clear-discards-partial-project",
        runtimeConfig: { type: "local" },
      });
      await historyService.appendToHistory(
        workspaceId,
        createMuxMessage("pre-clear-user", "user", "before clear", {})
      );
      const seedPartial = () =>
        historyService.writePartial(
          workspaceId,
          createMuxMessage("partial-1", "assistant", "pre-mutation partial", {})
        );

      // getOrCreateSession must exist for the discard hook to run.
      await seedPartial();
      expect(await workspaceService.truncateHistory(workspaceId)).toEqual({
        success: true,
        data: undefined,
      });
      expect(await historyService.readPartial(workspaceId)).toBeNull();

      // Reset drops the partial too — even on its no-op branch the discard
      // runs before the history read, so stale retry state cannot survive.
      await seedPartial();
      expect(await workspaceService.resetContext(workspaceId)).toEqual({
        success: true,
        data: "noop",
      });
      expect(await historyService.readPartial(workspaceId)).toBeNull();

      // Fail closed: an undeletable partial blocks the clear.
      await historyService.appendToHistory(
        workspaceId,
        createMuxMessage("post-clear-user", "user", "again", {})
      );
      await seedPartial();
      const deleteSpy = spyOn(historyService, "deletePartial").mockImplementationOnce(() =>
        Promise.resolve(Err("disk full"))
      );
      try {
        const blocked = await workspaceService.truncateHistory(workspaceId);
        expect(blocked).toEqual({
          success: false,
          error: "Cannot clear history: pending retry state could not be discarded (disk full)",
        });
        // Nothing was truncated.
        const history = await historyService.getHistoryFromLatestBoundary(workspaceId);
        expect(history.success ? history.data : []).toHaveLength(1);
      } finally {
        deleteSpy.mockRestore();
      }
    } finally {
      await cleanup();
    }
  });

  test("context reset surfaces active-context history read failures", async () => {
    const { config, historyService, workspaceService, cleanup } = await createServices();
    const workspaceId = "context-reset-history-read-fails";
    try {
      await config.addWorkspace("/tmp/context-reset-history-read-fails-project", {
        id: workspaceId,
        name: workspaceId,
        projectName: "context-reset-history-read-fails-project",
        projectPath: "/tmp/context-reset-history-read-fails-project",
        runtimeConfig: { type: "local" },
      });
      const historySpy = spyOn(
        historyService,
        "getHistoryFromLatestBoundary"
      ).mockResolvedValueOnce(Err("read failed"));

      try {
        const result = await workspaceService.resetContext(workspaceId);

        expect(result).toEqual({
          success: false,
          error: "Failed to read active context before reset: read failed",
        });
      } finally {
        historySpy.mockRestore();
      }
    } finally {
      await cleanup();
    }
  });

  test("context reset rejects active streams", async () => {
    const aiService = {
      ...createStreamLifecycleMocks(),
      on: mock(() => undefined),
      isStreaming: mock(() => true),
    } as unknown as AIService;
    const { config, workspaceService, cleanup } = await createServices(aiService);
    const workspaceId = "context-reset-active-stream";
    try {
      await config.addWorkspace("/tmp/context-reset-active-project", {
        id: workspaceId,
        name: workspaceId,
        projectName: "context-reset-active-project",
        projectPath: "/tmp/context-reset-active-project",
        runtimeConfig: { type: "local" },
      });

      const result = await workspaceService.resetContext(workspaceId);

      expect(result.success).toBe(false);
      expect(result.success ? undefined : result.error).toBe(
        "Cannot reset context while a turn is active. Press Esc to stop the stream first."
      );
    } finally {
      await cleanup();
    }
  });

  test("context reset rejects queued or preparing turns", async () => {
    const { config, workspaceService, cleanup } = await createServices();
    const workspaceId = "context-reset-queued-turn";
    try {
      await config.addWorkspace("/tmp/context-reset-queued-project", {
        id: workspaceId,
        name: workspaceId,
        projectName: "context-reset-queued-project",
        projectPath: "/tmp/context-reset-queued-project",
        runtimeConfig: { type: "local" },
      });
      const pendingSpy = spyOn(
        workspaceService,
        "hasPendingQueuedOrPreparingTurn"
      ).mockReturnValueOnce(true);

      try {
        const result = await workspaceService.resetContext(workspaceId);

        expect(result.success).toBe(false);
        expect(result.success ? undefined : result.error).toBe(
          "Cannot reset context while queued user input is pending. Send or clear the queued message first."
        );
      } finally {
        pendingSpy.mockRestore();
      }
    } finally {
      await cleanup();
    }
  });

  test("context reset preserves plan files", async () => {
    const { config, historyService, workspaceService, cleanup } = await createServices();
    const workspaceId = "context-reset-preserves-plan-file";
    const projectName = "context-reset-preserves-plan-project";
    try {
      await config.addWorkspace(`/tmp/${projectName}`, {
        id: workspaceId,
        name: workspaceId,
        projectName,
        projectPath: `/tmp/${projectName}`,
        runtimeConfig: { type: "local" },
      });
      const planFile = await writePlanFile(config.rootDir, projectName, workspaceId);
      expect(
        (
          await historyService.appendToHistory(
            workspaceId,
            createMuxMessage("pre-reset-user", "user", "before reset", {})
          )
        ).success
      ).toBe(true);

      const result = await workspaceService.resetContext(workspaceId);

      expect(result).toEqual({ success: true, data: "reset" });
      await fsPromises.access(planFile);
    } finally {
      await cleanup();
    }
  });

  test("context reset does not clear plan files when boundary append fails", async () => {
    const { config, historyService, workspaceService, cleanup } = await createServices();
    const workspaceId = "context-reset-append-fails";
    try {
      await config.addWorkspace("/tmp/context-reset-append-fails-project", {
        id: workspaceId,
        name: workspaceId,
        projectName: "context-reset-append-fails-project",
        projectPath: "/tmp/context-reset-append-fails-project",
        runtimeConfig: { type: "local" },
      });
      const planFile = await writePlanFile(
        config.rootDir,
        "context-reset-append-fails-project",
        workspaceId
      );
      const seedResult = await historyService.appendToHistory(
        workspaceId,
        createMuxMessage("pre-reset-user", "user", "before reset", {})
      );
      expect(seedResult.success).toBe(true);
      const appendSpy = spyOn(historyService, "appendToHistory").mockResolvedValueOnce(
        Err("disk full")
      );

      try {
        const result = await workspaceService.resetContext(workspaceId);

        expect(result.success).toBe(false);
        expect(result.success ? undefined : result.error).toBe(
          "Failed to append context reset boundary: disk full"
        );
        await fsPromises.access(planFile);
      } finally {
        appendSpy.mockRestore();
      }
    } finally {
      await cleanup();
    }
  });

  test("context reset remains successful when post-boundary goal acknowledgment fails", async () => {
    const { config, historyService, workspaceService, cleanup } = await createServices();
    const workspaceId = "context-reset-goal-ack-fails";
    try {
      await config.addWorkspace("/tmp/context-reset-goal-ack-fails-project", {
        id: workspaceId,
        name: workspaceId,
        projectName: "context-reset-goal-ack-fails-project",
        projectPath: "/tmp/context-reset-goal-ack-fails-project",
        runtimeConfig: { type: "local" },
      });
      workspaceService.setWorkspaceGoalService({
        requireUserAcknowledgment: mock(() => Promise.reject(new Error("goal write failed"))),
      } as unknown as WorkspaceGoalService);
      const seedResult = await historyService.appendToHistory(
        workspaceId,
        createMuxMessage("pre-reset-user", "user", "before reset", {})
      );
      expect(seedResult.success).toBe(true);

      const result = await workspaceService.resetContext(workspaceId);

      expect(result).toEqual({ success: true, data: "reset" });
    } finally {
      await cleanup();
    }
  });

  test("context reset rejects duplicate resets and sends while a reset is in progress", async () => {
    const { config, historyService, workspaceService, cleanup } = await createServices();
    const workspaceId = "context-reset-reentrancy";
    try {
      await config.addWorkspace("/tmp/context-reset-reentrancy-project", {
        id: workspaceId,
        name: workspaceId,
        projectName: "context-reset-reentrancy-project",
        projectPath: "/tmp/context-reset-reentrancy-project",
        runtimeConfig: { type: "local" },
      });
      const historyDeferred =
        createDeferred<Awaited<ReturnType<HistoryService["getHistoryFromLatestBoundary"]>>>();
      const historySpy = spyOn(
        historyService,
        "getHistoryFromLatestBoundary"
      ).mockImplementationOnce(() => historyDeferred.promise);

      try {
        const firstReset = workspaceService.resetContext(workspaceId);
        await Promise.resolve();

        const duplicateReset = await workspaceService.resetContext(workspaceId);
        expect(duplicateReset).toEqual({
          success: false,
          error: "A context reset or clear is already in progress for this workspace.",
        });

        const sendResult = await workspaceService.sendMessage(workspaceId, "hello", {
          model: "anthropic:claude-sonnet-4-6",
          thinkingLevel: "off",
          toolPolicy: [],
          agentId: "exec",
        });
        expect(sendResult).toEqual({
          success: false,
          error: {
            type: "unknown",
            raw: "Workspace history is being cleared or reset. Please wait and try again.",
          },
        });

        historyDeferred.resolve(Ok([]));
        expect(await firstReset).toEqual({ success: true, data: "noop" });
      } finally {
        historySpy.mockRestore();
      }
    } finally {
      await cleanup();
    }
  });

  test("context reset preserves the goal and requires user acknowledgment", async () => {
    const { config, historyService, workspaceService, goalService, cleanup } =
      await createServices();
    const workspaceId = "context-reset-goal-workspace";
    try {
      await config.addWorkspace("/tmp/context-reset-goal-project", {
        id: workspaceId,
        name: workspaceId,
        projectName: "context-reset-goal-project",
        projectPath: "/tmp/context-reset-goal-project",
        runtimeConfig: { type: "local" },
      });
      const created = await setWorkspaceGoalOk(goalService, {
        workspaceId,
        objective: "Keep pursuing the objective",
      });
      expect(
        (
          await historyService.appendToHistory(
            workspaceId,
            createMuxMessage("pre-reset-user", "user", "before reset", {})
          )
        ).success
      ).toBe(true);

      const nowSpy = spyOn(Date, "now").mockReturnValue(1_234_568);
      try {
        const result = await workspaceService.resetContext(workspaceId);
        expect(result.success).toBe(true);
      } finally {
        nowSpy.mockRestore();
      }

      expect(await goalService.getGoal(workspaceId)).toMatchObject({
        goalId: created.goalId,
        objective: created.objective,
        requireUserAcknowledgmentSinceMs: 1_234_568,
      });
    } finally {
      await cleanup();
    }
  });

  // ---------------------------------------------------------------------------
  // Codex P1 (PRRT_kwDOPxxmWM5_ucm2): the WorkspaceService stream-abort
  // listener must NOT replay queued goal mutations on user-aborted streams.
  // `applyPendingAfterStreamEnd` consumes `pendingGoalMutations` synchronously
  // before its first await, while `recordUserStoppedStream` (which clears the
  // map) runs later in the AgentSession listener — so without an explicit
  // skip, a user who interrupted a stream mid-objective-edit would still see
  // the queued edit committed, defeating the stop-to-cancel safety contract
  // (DEREM-18).
  // ---------------------------------------------------------------------------
  test("user-aborted streams do NOT replay queued goal mutations", async () => {
    const aiEmitter = new EventEmitter();
    const aiService = Object.assign(aiEmitter, {
      ...createStreamLifecycleMocks(),
      isStreaming: mock(() => false),
    }) as unknown as AIService;
    const { config, workspaceService, goalService, cleanup } = await createServices(aiService);
    const workspaceId = "user-abort-discards-mutation";
    try {
      await config.addWorkspace("/tmp/user-abort-test-project", {
        id: workspaceId,
        name: workspaceId,
        projectName: "project",
        projectPath: "/tmp/user-abort-test-project",
        runtimeConfig: { type: "local" },
      });
      // Voids the unused-var warning; workspaceService just needs to exist.
      void workspaceService;

      const created = await setWorkspaceGoalOk(goalService, {
        workspaceId,
        objective: "Original objective",
      });

      // Queue a mid-stream mutation (the real flow goes through
      // setGoal-while-streaming; we override the private streaming check
      // directly to avoid plumbing an entire AgentSession into this test).
      const goalServiceAccess = goalService as unknown as {
        isWorkspaceStreaming: (workspaceId: string) => Promise<boolean>;
      };
      const isStreamingOriginal = goalServiceAccess.isWorkspaceStreaming;
      goalServiceAccess.isWorkspaceStreaming = () => Promise.resolve(true);
      try {
        const queued = await goalService.setGoal({
          workspaceId,
          objective: "Should be dropped on user abort",
          expectedGoalId: created.goalId,
        });
        expect(queued.success).toBe(true);
      } finally {
        goalServiceAccess.isWorkspaceStreaming = isStreamingOriginal;
      }

      // Mirror the real AgentSession listener: when abortReason === "user",
      // `recordUserStoppedStream` clears `pendingGoalMutations`. The
      // WorkspaceService stream-abort listener fires synchronously on the
      // emit below, before this clear — so the new gate inside that listener
      // is what prevents the replay.
      aiService.emit("stream-abort", {
        type: "stream-abort",
        workspaceId,
        messageId: "msg",
        abortReason: "user",
        metadata: { duration: 1 },
        abandonPartial: true,
      });
      await goalService.recordUserStoppedStream(workspaceId);

      // Drain pending microtasks to give any racing
      // applyPendingAfterStreamEnd a chance to fire.
      await drainPendingDispatches();

      const persisted = await goalService.getGoal(workspaceId);
      expect(persisted?.objective).toBe("Original objective");
    } finally {
      await cleanup();
    }
  });

  // A goal set mid-stream is held as optimistic state until stream-end
  // persistence, so goal.json keeps the pre-stream goal. Non-goal activity
  // emits (status_set/todo_write/recency) read that persisted goal and, before
  // this overlay, replaced the activity snapshot with the stale goal — the Goal
  // tab flickered back to the old goal until the next goal read. The overlay
  // keeps the optimistic goal visible, and clears once the goal service drops
  // the pending mutation (abort / stream-end).
  test("mid-stream activity emits surface the optimistic goal, then revert on user abort", async () => {
    const aiEmitter = new EventEmitter();
    const aiService = Object.assign(aiEmitter, {
      ...createStreamLifecycleMocks(),
      isStreaming: mock(() => false),
    }) as unknown as AIService;
    const { config, workspaceService, goalService, cleanup } = await createServices(aiService);
    const workspaceId = "midstream-goal-overlay";
    try {
      await config.addWorkspace("/tmp/midstream-goal-overlay-project", {
        id: workspaceId,
        name: workspaceId,
        projectName: "project",
        projectPath: "/tmp/midstream-goal-overlay-project",
        runtimeConfig: { type: "local" },
      });

      const created = await setWorkspaceGoalOk(goalService, {
        workspaceId,
        objective: "Pre-stream goal",
      });

      // Queue a goal set mid-stream (publishes an optimistic, pendingPersistence
      // snapshot without persisting goal.json).
      const goalServiceAccess = goalService as unknown as {
        isWorkspaceStreaming: (workspaceId: string) => Promise<boolean>;
      };
      const isStreamingOriginal = goalServiceAccess.isWorkspaceStreaming;
      goalServiceAccess.isWorkspaceStreaming = () => Promise.resolve(true);
      try {
        const queued = await goalService.setGoal({
          workspaceId,
          objective: "Optimistic mid-stream goal",
          expectedGoalId: created.goalId,
        });
        expect(queued.success).toBe(true);
      } finally {
        goalServiceAccess.isWorkspaceStreaming = isStreamingOriginal;
      }

      // The durable goal.json still holds the pre-stream goal.
      expect((await goalService.getGoal(workspaceId))?.objective).toBe("Pre-stream goal");

      const activityEvents: Array<{
        workspaceId: string;
        activity: WorkspaceActivitySnapshot | null;
      }> = [];
      const listener = (event: {
        workspaceId: string;
        activity: WorkspaceActivitySnapshot | null;
      }) => activityEvents.push(event);
      workspaceService.on("activity", listener);
      try {
        // A non-goal activity emit reads persisted metadata (still the pre-stream
        // goal) but must surface the optimistic goal so the Goal tab is stable.
        await workspaceService.updateAgentStatus(workspaceId, { emoji: "🛠️", message: "Working" });
        expect(activityEvents.at(-1)?.activity?.goal).toMatchObject({
          objective: "Optimistic mid-stream goal",
          pendingPersistence: true,
        });

        // The bootstrap path (renderer reconnect/reload) builds straight from
        // persisted metadata, so it must apply the same overlay.
        const listed = await workspaceService.getActivityList();
        expect(listed?.[workspaceId]?.goal).toMatchObject({
          objective: "Optimistic mid-stream goal",
          pendingPersistence: true,
        });

        // User aborts: the goal service drops the queued mutation and reverts the
        // panel to the persisted goal. Subsequent activity emits must show that
        // reverted goal, not the discarded optimistic one.
        await goalService.recordUserStoppedStream(workspaceId);
        await workspaceService.updateAgentStatus(workspaceId, { emoji: "💤", message: "Idle" });
        expect(activityEvents.at(-1)?.activity?.goal).toMatchObject({
          goalId: created.goalId,
          objective: "Pre-stream goal",
        });
        expect(activityEvents.at(-1)?.activity?.goal?.pendingPersistence).toBeUndefined();
      } finally {
        workspaceService.off("activity", listener);
      }
    } finally {
      await cleanup();
    }
  });

  test("WorkspaceService stream-abort listener leaves queued goal mutations for AgentSession", async () => {
    // Non-user abort goal mutation drains happen in AgentSession after abort
    // accounting. WorkspaceService must not drain here, or the aborted
    // in-flight stream can be charged to the replacement goal.
    const aiEmitter = new EventEmitter();
    const aiService = Object.assign(aiEmitter, {
      ...createStreamLifecycleMocks(),
      isStreaming: mock(() => false),
    }) as unknown as AIService;
    const { config, workspaceService, goalService, cleanup } = await createServices(aiService);
    const workspaceId = "system-abort-replays-mutation";
    try {
      await config.addWorkspace("/tmp/system-abort-test-project", {
        id: workspaceId,
        name: workspaceId,
        projectName: "project",
        projectPath: "/tmp/system-abort-test-project",
        runtimeConfig: { type: "local" },
      });
      void workspaceService;

      const created = await setWorkspaceGoalOk(goalService, {
        workspaceId,
        objective: "Original objective",
      });

      const goalServiceAccess = goalService as unknown as {
        isWorkspaceStreaming: (workspaceId: string) => Promise<boolean>;
      };
      const isStreamingOriginal = goalServiceAccess.isWorkspaceStreaming;
      goalServiceAccess.isWorkspaceStreaming = () => Promise.resolve(true);
      try {
        const queued = await goalService.setGoal({
          workspaceId,
          objective: "Should commit on system abort",
          expectedGoalId: created.goalId,
        });
        expect(queued.success).toBe(true);
      } finally {
        goalServiceAccess.isWorkspaceStreaming = isStreamingOriginal;
      }

      aiService.emit("stream-abort", {
        type: "stream-abort",
        workspaceId,
        messageId: "msg",
        abortReason: "system",
        metadata: { duration: 1 },
        abandonPartial: false,
      });

      // Drain pending microtasks to prove WorkspaceService did not consume the
      // queued mutation before AgentSession has a chance to account the abort.
      await drainPendingDispatches();

      const persisted = await goalService.getGoal(workspaceId);
      expect(persisted?.objective).toBe("Original objective");
    } finally {
      await cleanup();
    }
  });
});

describe("WorkspaceService initialize", () => {
  let workspaceService: WorkspaceService;
  let config: Config;

  beforeEach(() => {
    config = {
      getAllWorkspaceMetadata: mock(() => Promise.resolve([])),
    } as unknown as Config;

    const aiService = {
      ...createStreamLifecycleMocks(),
      on: mock(() => undefined),
      off: mock(() => undefined),
    } as unknown as AIService;

    workspaceService = createWorkspaceServiceForTest({
      config,
      aiService,
      initStateManager: mockInitStateManager as InitStateManager,
      secretsStore: { getEffectiveSecrets: mock(() => []) } as unknown as SecretsStore,
    });
  });

  test("schedules startup recovery for non-task, non-archived chats", async () => {
    const liveWorkspace = createFrontendWorkspaceMetadata({
      id: "live-ws",
      name: "Live Workspace",
    });
    const taskWorkspace = createFrontendWorkspaceMetadata({
      id: "task-ws",
      name: "Task Workspace",
      taskStatus: "running",
    });
    const archivedWorkspace = createFrontendWorkspaceMetadata({
      id: "archived-ws",
      name: "Archived Workspace",
      archivedAt: "2026-03-20T00:00:00.000Z",
    });
    // Active when metadata was read, but archived (or removed) by a client before the
    // scheduling loop ran: the live config decides, not the stale metadata.
    const archivedSinceWorkspace = createFrontendWorkspaceMetadata({
      id: "archived-since-ws",
      name: "Archived Since Read",
    });
    const removedSinceWorkspace = createFrontendWorkspaceMetadata({
      id: "removed-since-ws",
      name: "Removed Since Read",
    });

    config.getAllWorkspaceMetadata = mock(() =>
      Promise.resolve([
        liveWorkspace,
        taskWorkspace,
        archivedWorkspace,
        archivedSinceWorkspace,
        removedSinceWorkspace,
      ])
    ) as unknown as Config["getAllWorkspaceMetadata"];
    config.loadConfigOrDefault = mock(() => ({
      projects: new Map([
        [
          "/tmp/project",
          {
            workspaces: [
              { id: "live-ws", name: "live-ws", path: "/tmp/live-ws" },
              { id: "task-ws", name: "task-ws", path: "/tmp/task-ws", taskStatus: "running" },
              {
                id: "archived-ws",
                name: "archived-ws",
                path: "/tmp/archived-ws",
                archivedAt: "2026-03-20T00:00:00.000Z",
              },
              {
                id: "archived-since-ws",
                name: "archived-since-ws",
                path: "/tmp/archived-since-ws",
                archivedAt: "2026-03-21T00:00:00.000Z",
              },
            ],
          },
        ],
      ]),
    })) as unknown as Config["loadConfigOrDefault"];

    const startupAccess = workspaceService as unknown as {
      startStartupRecovery: (workspaceId: string) => void;
    };
    const startStartupRecoverySpy = spyOn(startupAccess, "startStartupRecovery").mockImplementation(
      () => undefined
    );

    await workspaceService.initialize();

    expect(startStartupRecoverySpy).toHaveBeenCalledTimes(1);
    expect(startStartupRecoverySpy).toHaveBeenCalledWith("live-ws");
  });

  test("swallows startup metadata lookup failures", async () => {
    config.getAllWorkspaceMetadata = mock(() =>
      Promise.reject(new Error("config unavailable"))
    ) as unknown as Config["getAllWorkspaceMetadata"];

    const startupAccess = workspaceService as unknown as {
      startStartupRecovery: (workspaceId: string) => void;
    };
    const startStartupRecoverySpy = spyOn(startupAccess, "startStartupRecovery");

    await workspaceService.initialize();

    expect(startStartupRecoverySpy).not.toHaveBeenCalled();
  });

  test("preserves scratch workdirs when config cannot be loaded", async () => {
    const { config: realConfig, historyService, cleanup } = await createTestHistoryService();
    const scratchPath = path.join(realConfig.rootDir, "scratch", "existing-scratch");
    await fsPromises.mkdir(scratchPath, { recursive: true });
    await fsPromises.writeFile(path.join(realConfig.rootDir, "config.json"), "{invalid-json");

    const aiService = {
      ...createStreamLifecycleMocks(),
      on: mock(() => undefined),
      off: mock(() => undefined),
    } as unknown as AIService;
    const service = createWorkspaceServiceForTest({
      config: realConfig,
      historyService,
      aiService,
      initStateManager: mockInitStateManager as InitStateManager,
    });

    try {
      await service.initialize();
      expect(await fsPromises.stat(scratchPath).then(() => true)).toBe(true);
    } finally {
      await cleanup();
    }
  });

  test("accumulates the workspace memory write policy fail-closed in config across an epoch", async () => {
    const { config: realConfig, historyService, cleanup } = await createTestHistoryService();
    const scratchDir = path.join(realConfig.rootDir, "scratch", "policy-scratch");
    await fsPromises.mkdir(scratchDir, { recursive: true });
    await realConfig.editConfig((cfg) => {
      cfg.projects.set(SCRATCH_PROJECT_CONFIG_KEY, {
        workspaces: [
          {
            kind: "scratch",
            path: scratchDir,
            id: "policy-scratch",
            name: "scratch-policy-scratch",
            runtimeConfig: { type: "local" },
          },
        ],
        projectKind: "system",
        trusted: true,
      });
      return cfg;
    });
    const aiService = {
      ...createStreamLifecycleMocks(),
      on: mock(() => undefined),
      off: mock(() => undefined),
    } as unknown as AIService;
    const service = createWorkspaceServiceForTest({
      config: realConfig,
      historyService,
      aiService,
      initStateManager: mockInitStateManager as InitStateManager,
    });
    const persistedFor = (epoch: number) =>
      findWorkspaceEntry(realConfig.loadConfigOrDefault(), "policy-scratch")?.workspace
        .workspaceMemoryWritableByEpoch?.[String(epoch)];
    const persisted = () => persistedFor(-1);
    const EPOCH0 = { epochHasPriorTurns: false, policyEpoch: -1 };
    try {
      // The durable bit is the epoch accumulator: the harvest reads every
      // message of the epoch, so a read-only turn denies the epoch even when
      // a writable turn follows — across restarts and backends, since the
      // conjunction lives in config.json rather than in one process.
      expect(await service.recordWorkspaceMemoryWritable("policy-scratch", true, EPOCH0)).toBe(
        true
      );
      expect(persisted()).toBe(true);
      expect(await service.recordWorkspaceMemoryWritable("policy-scratch", false, EPOCH0)).toBe(
        true
      );
      expect(persisted()).toBe(false);
      expect(await service.recordWorkspaceMemoryWritable("policy-scratch", true, EPOCH0)).toBe(
        true
      );
      expect(persisted()).toBe(false);

      // New epoch (field cleared at the boundary), then ANOTHER backend records
      // a read-only turn straight into config: this backend's next grant must
      // not publish false→true.
      await realConfig.editConfig((cfg) => {
        const entry = findWorkspaceEntry(cfg, "policy-scratch")!;
        delete entry.workspace.workspaceMemoryWritableByEpoch;
        return cfg;
      });
      expect(await service.recordWorkspaceMemoryWritable("policy-scratch", true, EPOCH0)).toBe(
        true
      );
      expect(persisted()).toBe(true);
      await realConfig.editConfig((cfg) => {
        findWorkspaceEntry(cfg, "policy-scratch")!.workspace.workspaceMemoryWritableByEpoch = {
          "-1": false,
        };
        return cfg;
      });
      expect(await service.recordWorkspaceMemoryWritable("policy-scratch", true, EPOCH0)).toBe(
        true
      );
      expect(persisted()).toBe(false);

      // New epoch again, and now config.json cannot take the deny: the turn's
      // user row is already durable, so the deny falls back to the session
      // dir (same durability domain) and the record still succeeds. A later
      // writable turn — even from a fresh process with no mirror — stays
      // denied by that marker, and it is ANDed into the compaction
      // observation as well.
      await realConfig.editConfig((cfg) => {
        const entry = findWorkspaceEntry(cfg, "policy-scratch")!;
        delete entry.workspace.workspaceMemoryWritableByEpoch;
        return cfg;
      });
      const sessionDir = path.join(realConfig.sessionsDir, "policy-scratch");
      spyOn(realConfig, "editConfig").mockImplementationOnce(() =>
        Promise.reject(new Error("disk full"))
      );
      expect(await service.recordWorkspaceMemoryWritable("policy-scratch", false, EPOCH0)).toBe(
        true
      );
      expect(persisted()).toBeUndefined();
      expect(await readWorkspaceMemoryDenyMarker(sessionDir)).toBe(true);
      expect(await service.recordWorkspaceMemoryWritable("policy-scratch", true, EPOCH0)).toBe(
        true
      );
      expect(persisted()).toBe(false);
      // Malformed marker still denies; an epoch boundary — even the fenced
      // compaction one, since a malformed file cannot claim to be a newer
      // deny — heals it and the next epoch can become writable again.
      await fsPromises.writeFile(workspaceMemoryDenyMarkerPath(sessionDir), "not json");
      expect(await readWorkspaceMemoryDenyMarker(sessionDir)).toBe(true);
      // Another backend's new-epoch deny write must not heal the malformed
      // marker away (it may be the only evidence of a read-only turn in the
      // closing epoch): the deny is carried as a wildcard until the closing
      // boundary observes and clears it.
      await writeWorkspaceMemoryDenyMarker(sessionDir, 7);
      expect(await readWorkspaceMemoryDenyMarker(sessionDir, -1)).toBe(true);
      expect(await readWorkspaceMemoryDenyMarker(sessionDir, 3)).toBe(true);
      await clearWorkspaceMemoryDenyMarker(realConfig.rootDir, sessionDir, { closingEpoch: -1 });
      expect(await readWorkspaceMemoryDenyMarker(sessionDir, -1)).toBe(false);
      expect(await readWorkspaceMemoryDenyMarker(sessionDir, 7)).toBe(true);
      await clearWorkspaceMemoryDenyMarker(realConfig.rootDir, sessionDir, { closingEpoch: 7 });
      expect(await readWorkspaceMemoryDenyMarker(sessionDir)).toBe(false);
      await fsPromises.writeFile(workspaceMemoryDenyMarkerPath(sessionDir), "not json");
      await clearWorkspaceMemoryDenyMarker(realConfig.rootDir, sessionDir, { closingEpoch: -1 });
      expect(await readWorkspaceMemoryDenyMarker(sessionDir)).toBe(false);
      // Unreadable is not malformed: a marker that cannot be read may hold a
      // newer epoch's deny, so the fenced clear refuses instead of deleting it.
      await writeWorkspaceMemoryDenyMarker(sessionDir, 9);
      const unreadableMarker = spyOn(fsPromises, "readFile").mockImplementationOnce((() =>
        Promise.reject(Object.assign(new Error("EIO"), { code: "EIO" }))) as never);
      const refusedClear = await clearWorkspaceMemoryDenyMarker(realConfig.rootDir, sessionDir, {
        closingEpoch: -1,
      }).then(
        () => null,
        (error: unknown) => (error instanceof Error ? error.message : String(error))
      );
      expect(refusedClear).toContain("unreadable");
      unreadableMarker.mockRestore();
      expect(await readWorkspaceMemoryDenyMarker(sessionDir, 9)).toBe(true);
      await clearWorkspaceMemoryDenyMarker(realConfig.rootDir, sessionDir, { closingEpoch: 9 });
      expect(await readWorkspaceMemoryDenyMarker(sessionDir)).toBe(false);
      await fsPromises.writeFile(workspaceMemoryDenyMarkerPath(sessionDir), "{}");
      await clearWorkspaceMemoryDenyMarker(realConfig.rootDir, sessionDir);
      await realConfig.editConfig((cfg) => {
        const entry = findWorkspaceEntry(cfg, "policy-scratch")!;
        delete entry.workspace.workspaceMemoryWritableByEpoch;
        return cfg;
      });
      expect(await service.recordWorkspaceMemoryWritable("policy-scratch", true, EPOCH0)).toBe(
        true
      );
      expect(persisted()).toBe(true);
      // The fenced clear (compaction boundary) keeps a deny recorded for the
      // NEW epoch; readers of any other epoch ignore that deny. A new-epoch
      // deny written before the clear does not displace the closing one.
      await writeWorkspaceMemoryDenyMarker(sessionDir, -1);
      await writeWorkspaceMemoryDenyMarker(sessionDir, 7);
      expect(await readWorkspaceMemoryDenyMarker(sessionDir, -1)).toBe(true);
      expect(await readWorkspaceMemoryDenyMarker(sessionDir, 7)).toBe(true);
      await clearWorkspaceMemoryDenyMarker(realConfig.rootDir, sessionDir, { closingEpoch: -1 });
      expect(await readWorkspaceMemoryDenyMarker(sessionDir, 7)).toBe(true);
      expect(await readWorkspaceMemoryDenyMarker(sessionDir, -1)).toBe(false);
      expect(await readWorkspaceMemoryDenyMarker(sessionDir)).toBe(true);
      await clearWorkspaceMemoryDenyMarker(realConfig.rootDir, sessionDir, { closingEpoch: 7 });
      expect(await readWorkspaceMemoryDenyMarker(sessionDir)).toBe(false);

      // The durable bit is bound to its epoch too: the closing epoch's
      // `false` is invisible to the first turn of the next epoch on ANOTHER
      // backend (which cannot await this backend's boundary reset), so it
      // grants under its own epoch's record — WITHOUT displacing the closing
      // epoch's deny, which the compacting backend's completion observation
      // may not have read yet (a single slot would let its writable mirror
      // grant the harvest of the read-only turn).
      await realConfig.editConfig((cfg) => {
        const entry = findWorkspaceEntry(cfg, "policy-scratch")!.workspace;
        entry.workspaceMemoryWritableByEpoch = { "-1": false };
        return cfg;
      });
      expect(
        await service.recordWorkspaceMemoryWritable("policy-scratch", true, {
          epochHasPriorTurns: false,
          policyEpoch: 12,
        })
      ).toBe(true);
      expect(persistedFor(12)).toBe(true);
      expect(persisted()).toBe(false);
      // A PRESERVED-TAIL epoch names the epoch its tail was copied out of:
      // that epoch's deny is ANDed in directly, under whichever key it sits —
      // the closing key (compacting backend's carry not landed yet), the new
      // key (carry landed), or the session-dir marker — so no window exists
      // in which the read-only tail reads as writable to another backend.
      await realConfig.editConfig((cfg) => {
        const entry = findWorkspaceEntry(cfg, "policy-scratch")!.workspace;
        entry.workspaceMemoryWritableByEpoch = { "-1": false };
        return cfg;
      });
      expect(
        await service.recordWorkspaceMemoryWritable("policy-scratch", true, {
          epochHasPriorTurns: false,
          policyEpoch: 14,
          carriedPolicyEpochs: [-1],
        })
      ).toBe(true);
      expect(persistedFor(14)).toBe(false);
      expect(persisted()).toBe(false);
      await realConfig.editConfig((cfg) => {
        const entry = findWorkspaceEntry(cfg, "policy-scratch")!.workspace;
        entry.workspaceMemoryWritableByEpoch = { "16": true };
        return cfg;
      });
      await writeWorkspaceMemoryDenyMarker(sessionDir, 12);
      // One snapshot answers for every epoch consulted (a carry re-stamping
      // 12 → 16 between two separate reads could hide the entry from both).
      expect(await readWorkspaceMemoryDenyMarkerForEpochs(sessionDir, [16, -1, 12])).toBe(true);
      expect(await readWorkspaceMemoryDenyMarkerForEpochs(sessionDir, [16, -1])).toBe(false);
      expect(
        await service.recordWorkspaceMemoryWritable("policy-scratch", true, {
          epochHasPriorTurns: false,
          policyEpoch: 16,
          carriedPolicyEpochs: [-1, 12],
        })
      ).toBe(true);
      expect(persistedFor(16)).toBe(false);
      await clearWorkspaceMemoryDenyMarker(realConfig.rootDir, sessionDir, { closingEpoch: 12 });
      // A carried grant (or no carried record at all) changes nothing.
      await realConfig.editConfig((cfg) => {
        const entry = findWorkspaceEntry(cfg, "policy-scratch")!.workspace;
        entry.workspaceMemoryWritableByEpoch = { "-1": true };
        return cfg;
      });
      expect(
        await service.recordWorkspaceMemoryWritable("policy-scratch", true, {
          epochHasPriorTurns: false,
          policyEpoch: 18,
          carriedPolicyEpochs: [-1],
        })
      ).toBe(true);
      expect(persistedFor(18)).toBe(true);
      // A tail copy whose source epoch is unknown (persisted before the field
      // existed) carries a policy nobody can look up: denied, like unknown
      // history, even for an otherwise writable first turn.
      expect(
        await service.recordWorkspaceMemoryWritable("policy-scratch", true, {
          epochHasPriorTurns: false,
          policyEpoch: 22,
          carriedPolicyUnknown: true,
        })
      ).toBe(true);
      expect(persistedFor(22)).toBe(false);
      await realConfig.editConfig((cfg) => {
        const entry = findWorkspaceEntry(cfg, "policy-scratch")!.workspace;
        entry.workspaceMemoryWritableByEpoch = { "-1": false, "12": true };
        return cfg;
      });
      // ...while a turn of the closing epoch itself still sees its deny.
      expect(await service.recordWorkspaceMemoryWritable("policy-scratch", true, EPOCH0)).toBe(
        true
      );
      expect(persisted()).toBe(false);
      expect(persistedFor(12)).toBe(true);
      // Records are never pruned by count: a suspended compacting backend
      // must still find its closing epoch's record however many epochs
      // others opened meanwhile.
      for (const policyEpoch of [20, 30, 40]) {
        expect(
          await service.recordWorkspaceMemoryWritable("policy-scratch", true, {
            epochHasPriorTurns: false,
            policyEpoch,
          })
        ).toBe(true);
      }
      expect(
        Object.keys(
          findWorkspaceEntry(realConfig.loadConfigOrDefault(), "policy-scratch")!.workspace
            .workspaceMemoryWritableByEpoch!
        ).sort()
      ).toEqual(["-1", "12", "20", "30", "40"]);
      // Raw config is not schema-validated: a corrupted non-boolean record
      // reads as a deny, never as a grant.
      await realConfig.editConfig((cfg) => {
        const entry = findWorkspaceEntry(cfg, "policy-scratch")!.workspace;
        (entry.workspaceMemoryWritableByEpoch as Record<string, unknown>)["50"] = "false";
        (entry.workspaceMemoryWritableByEpoch as Record<string, unknown>)["51"] = null;
        return cfg;
      });
      for (const policyEpoch of [50, 51]) {
        expect(
          await service.recordWorkspaceMemoryWritable("policy-scratch", true, {
            epochHasPriorTurns: false,
            policyEpoch,
          })
        ).toBe(true);
        // The deny stands (no grant written over the corrupted value)...
        expect(persistedFor(policyEpoch)).not.toBe(true);
        // ...and every reader sees it as false.
        expect(
          workspaceMemoryWritableForEpoch(
            findWorkspaceEntry(realConfig.loadConfigOrDefault(), "policy-scratch")!.workspace,
            policyEpoch
          )
        ).toBe(false);
      }
      // A corrupted CONTAINER (null, array, string) must not throw out of
      // every turn start; it reads as a deny for every epoch and is healed
      // (replaced, not spread) by the next write.
      for (const container of [null, "false", ["-1"]]) {
        await realConfig.editConfig((cfg) => {
          const entry = findWorkspaceEntry(cfg, "policy-scratch")!.workspace as Record<
            string,
            unknown
          >;
          entry.workspaceMemoryWritableByEpoch = container;
          return cfg;
        });
        const corrupted = findWorkspaceEntry(
          realConfig.loadConfigOrDefault(),
          "policy-scratch"
        )!.workspace;
        expect(workspaceMemoryWritableForEpoch(corrupted, 60)).toBe(false);
        expect(
          await service.recordWorkspaceMemoryWritable("policy-scratch", true, {
            epochHasPriorTurns: false,
            policyEpoch: 60,
          })
        ).toBe(true);
        expect(persistedFor(60)).not.toBe(true);
        setWorkspaceMemoryWritableForEpoch(corrupted, 61, true);
        expect(corrupted.workspaceMemoryWritableByEpoch).toEqual({ "61": true });
      }

      // Unknown history fails closed: no accumulator, no marker, no mirror
      // (this service never recorded this epoch), yet the epoch already holds
      // turns — the record was lost (a deny that could not be made durable
      // anywhere before a restart, an upgrade mid-epoch). A writable turn
      // must not grant the whole epoch; the first turn of a fresh epoch does.
      await realConfig.editConfig((cfg) => {
        const entry = findWorkspaceEntry(cfg, "policy-scratch")!;
        delete entry.workspace.workspaceMemoryWritableByEpoch;
        return cfg;
      });
      expect(
        await service.recordWorkspaceMemoryWritable("policy-scratch", true, {
          epochHasPriorTurns: true,
          policyEpoch: -1,
        })
      ).toBe(true);
      expect(persisted()).toBe(false);
      await realConfig.editConfig((cfg) => {
        const entry = findWorkspaceEntry(cfg, "policy-scratch")!;
        delete entry.workspace.workspaceMemoryWritableByEpoch;
        return cfg;
      });
      expect(
        await service.recordWorkspaceMemoryWritable("policy-scratch", true, {
          epochHasPriorTurns: false,
          policyEpoch: -1,
        })
      ).toBe(true);
      expect(persisted()).toBe(true);

      // A record must wait for the session's in-flight epoch reset (a no-tail
      // compaction clearing the closing epoch's accumulator/marker), or the
      // first turn of the new epoch would AND itself with the stale deny.
      let releaseReset!: () => void;
      const resetInFlight = new Promise<void>((resolve) => (releaseReset = resolve));
      const fakeSession = {
        settleWorkspaceMemoryPolicyEpoch: () => resetInFlight,
        workspaceMemoryWritableMirror: () => undefined,
        recordWorkspaceMemoryWritable: () => undefined,
      };
      (service as unknown as { sessions: Map<string, unknown> }).sessions.set(
        "policy-scratch",
        fakeSession
      );
      await realConfig.editConfig((cfg) => {
        findWorkspaceEntry(cfg, "policy-scratch")!.workspace.workspaceMemoryWritableByEpoch = {
          "-1": false,
        };
        return cfg;
      });
      let settled = false;
      const pendingRecord = service
        .recordWorkspaceMemoryWritable("policy-scratch", true, EPOCH0)
        .then((ok) => {
          settled = true;
          return ok;
        });
      await new Promise((resolve) => setTimeout(resolve, 20));
      expect(settled).toBe(false);
      // The reset finishes (field cleared) and only then does the record read.
      await realConfig.editConfig((cfg) => {
        delete findWorkspaceEntry(cfg, "policy-scratch")!.workspace.workspaceMemoryWritableByEpoch;
        return cfg;
      });
      releaseReset();
      expect(await pendingRecord).toBe(true);
      expect(persisted()).toBe(true);
      (service as unknown as { sessions: Map<string, unknown> }).sessions.delete("policy-scratch");

      // An unreadable config.json (missing/malformed while the turn starts)
      // must not make the still-registered workspace look unregistered: the
      // deny takes the session-dir fallback instead of being reported durable
      // without a record anywhere, and a grant is reported unpersisted (the
      // harvest stays closed) rather than "done".
      await realConfig.editConfig((cfg) => {
        delete findWorkspaceEntry(cfg, "policy-scratch")!.workspace.workspaceMemoryWritableByEpoch;
        return cfg;
      });
      const unreadable = () => {
        throw new Error("config.json: unexpected token");
      };
      spyOn(realConfig, "loadConfigOrDefault").mockImplementationOnce(unreadable);
      expect(await service.recordWorkspaceMemoryWritable("policy-scratch", true, EPOCH0)).toBe(
        false
      );
      expect(persisted()).toBeUndefined();
      expect(await readWorkspaceMemoryDenyMarker(sessionDir)).toBe(false);
      spyOn(realConfig, "loadConfigOrDefault").mockImplementationOnce(unreadable);
      expect(await service.recordWorkspaceMemoryWritable("policy-scratch", false, EPOCH0)).toBe(
        true
      );
      expect(persisted()).toBeUndefined();
      expect(await readWorkspaceMemoryDenyMarker(sessionDir)).toBe(true);
      await clearWorkspaceMemoryDenyMarker(realConfig.rootDir, sessionDir);
      // A MISSING config.json (mid-rewrite by another backend) is not a fresh
      // install either: strict mode alone would read it as one and take the
      // "unregistered" shortcut. Same fallback as unreadable.
      const configFile = path.join(realConfig.rootDir, "config.json");
      await fsPromises.rename(configFile, `${configFile}.parked`);
      try {
        expect(await service.recordWorkspaceMemoryWritable("policy-scratch", true, EPOCH0)).toBe(
          false
        );
        expect(await service.recordWorkspaceMemoryWritable("policy-scratch", false, EPOCH0)).toBe(
          true
        );
        expect(await readWorkspaceMemoryDenyMarker(sessionDir)).toBe(true);
      } finally {
        await fsPromises.rename(`${configFile}.parked`, configFile);
      }
      await clearWorkspaceMemoryDenyMarker(realConfig.rootDir, sessionDir);
      expect(persisted()).toBeUndefined();

      // A late deny reaching the marker fallback after the workspace was
      // removed (tombstoned, session dir deleted) must not recreate the
      // session dir as an orphan; nothing is left to harvest, so it is done.
      await realConfig.editConfig((cfg) => {
        const entry = findWorkspaceEntry(cfg, "policy-scratch")!;
        delete entry.workspace.workspaceMemoryWritableByEpoch;
        return cfg;
      });
      await fsPromises.rm(sessionDir, { recursive: true, force: true });
      const tombstonePath = workspaceRemovalTombstonePath(realConfig.rootDir, "policy-scratch");
      await fsPromises.mkdir(path.dirname(tombstonePath), { recursive: true });
      await fsPromises.writeFile(tombstonePath, JSON.stringify({ workspaceId: "policy-scratch" }));
      spyOn(realConfig, "editConfig").mockImplementationOnce(() =>
        Promise.reject(new Error("disk full"))
      );
      expect(await service.recordWorkspaceMemoryWritable("policy-scratch", false, EPOCH0)).toBe(
        true
      );
      expect(
        await fsPromises.stat(sessionDir).then(
          () => true,
          () => false
        )
      ).toBe(false);
    } finally {
      await cleanup();
    }
  });

  test("the fenced deny-marker clear cannot delete a new-epoch deny written under the lock", async () => {
    const { config: realConfig, cleanup } = await createTestHistoryService();
    try {
      const sessionDir = path.join(realConfig.sessionsDir, "policy-lock");
      await writeWorkspaceMemoryDenyMarker(sessionDir, -1);
      // Another backend's deny writer holds the session-dir lock while the
      // boundary reset starts its read-check-delete: the reset must queue
      // behind it and then see (and keep) the new epoch's marker.
      let cleared = false;
      let clear: Promise<void> | undefined;
      await withTargetMutationLock(realConfig.rootDir, sessionDir, async () => {
        clear = clearWorkspaceMemoryDenyMarker(realConfig.rootDir, sessionDir, {
          closingEpoch: -1,
        }).then(() => {
          cleared = true;
        });
        await new Promise((resolve) => setTimeout(resolve, 20));
        expect(cleared).toBe(false);
        await writeWorkspaceMemoryDenyMarker(sessionDir, 5);
      });
      await clear;
      expect(cleared).toBe(true);
      expect(await readWorkspaceMemoryDenyMarker(sessionDir, 5)).toBe(true);
    } finally {
      await cleanup();
    }
  });

  test("removes stale orphaned scratch workdirs but keeps referenced and recent ones", async () => {
    const { config: realConfig, historyService, cleanup } = await createTestHistoryService();
    const scratchDirFor = (id: string) => path.join(realConfig.rootDir, "scratch", id);
    const referencedDir = scratchDirFor("referenced-scratch");
    const staleOrphanDir = scratchDirFor("stale-orphan-scratch");
    // A scratch chat created while the sweep runs has a fresh workdir and, briefly, no
    // config entry yet (createScratch persists config after mkdir).
    const freshOrphanDir = scratchDirFor("fresh-orphan-scratch");
    for (const dir of [referencedDir, staleOrphanDir, freshOrphanDir]) {
      await fsPromises.mkdir(dir, { recursive: true });
    }
    const staleTime = new Date(Date.now() - 48 * 60 * 60 * 1000);
    for (const dir of [referencedDir, staleOrphanDir]) {
      await fsPromises.utimes(dir, staleTime, staleTime);
    }
    await realConfig.editConfig((cfg) => {
      cfg.projects.set(SCRATCH_PROJECT_CONFIG_KEY, {
        workspaces: [
          {
            kind: "scratch",
            path: referencedDir,
            id: "referenced-scratch",
            name: "scratch-referenced-scratch",
            runtimeConfig: { type: "local" },
          },
        ],
        projectKind: "system",
        trusted: true,
      });
      return cfg;
    });

    const aiService = {
      ...createStreamLifecycleMocks(),
      on: mock(() => undefined),
      off: mock(() => undefined),
    } as unknown as AIService;
    const service = createWorkspaceServiceForTest({
      config: realConfig,
      historyService,
      aiService,
      initStateManager: mockInitStateManager as InitStateManager,
    });
    const startupAccess = service as unknown as {
      startStartupRecovery: (workspaceId: string) => void;
    };
    spyOn(startupAccess, "startStartupRecovery").mockImplementation(() => undefined);

    const exists = (dir: string) =>
      fsPromises.stat(dir).then(
        () => true,
        () => false
      );

    try {
      await service.initialize();
      expect(await exists(referencedDir)).toBe(true);
      expect(await exists(freshOrphanDir)).toBe(true);
      expect(await exists(staleOrphanDir)).toBe(false);
    } finally {
      await cleanup();
    }
  });

  test("removes stale orphaned session directories but keeps referenced and recent ones", async () => {
    const { config: realConfig, historyService, cleanup } = await createTestHistoryService();
    await realConfig.editConfig((cfg) => {
      cfg.projects.set("/tmp/proj", {
        workspaces: [
          { path: "/tmp/proj/known-ws", id: "known-ws", name: "known-ws" },
          // Legacy entry without a stable ID: its session dir is keyed by "<project>-<workspace>".
          { path: "/tmp/proj/legacy-branch" },
        ],
      });
      return cfg;
    });

    const sessionDirFor = (id: string) => path.join(realConfig.sessionsDir, id);
    const knownDir = sessionDirFor("known-ws");
    const legacyDir = sessionDirFor("proj-legacy-branch");
    // Unreferenced in config (the load-time migration removed the legacy Chat
    // with Xum entry) but exempt from reaping so downgrades keep the history.
    const muxChatDir = sessionDirFor("mux-chat");
    const staleOrphanDir = sessionDirFor("stale-orphan-ws");
    const freshOrphanDir = sessionDirFor("fresh-orphan-ws");
    for (const dir of [knownDir, legacyDir, muxChatDir, staleOrphanDir, freshOrphanDir]) {
      await fsPromises.mkdir(dir, { recursive: true });
    }
    // Backdate everything except the fresh orphan past the grace window, proving
    // retention comes from config references rather than directory age.
    const staleTime = new Date(Date.now() - 48 * 60 * 60 * 1000);
    for (const dir of [knownDir, legacyDir, muxChatDir, staleOrphanDir]) {
      await fsPromises.utimes(dir, staleTime, staleTime);
    }

    const aiService = {
      ...createStreamLifecycleMocks(),
      on: mock(() => undefined),
      off: mock(() => undefined),
    } as unknown as AIService;
    const service = createWorkspaceServiceForTest({
      config: realConfig,
      historyService,
      aiService,
      initStateManager: mockInitStateManager as InitStateManager,
    });
    const startupAccess = service as unknown as {
      startStartupRecovery: (workspaceId: string) => void;
    };
    spyOn(startupAccess, "startStartupRecovery").mockImplementation(() => undefined);

    const exists = (dir: string) =>
      fsPromises.stat(dir).then(
        () => true,
        () => false
      );

    try {
      await service.initialize();
      expect(await exists(knownDir)).toBe(true);
      expect(await exists(legacyDir)).toBe(true);
      expect(await exists(muxChatDir)).toBe(true);
      expect(await exists(freshOrphanDir)).toBe(true);
      expect(await exists(staleOrphanDir)).toBe(false);
    } finally {
      await cleanup();
    }
  });

  test("preserves orphaned session directories when config cannot be loaded", async () => {
    const { config: realConfig, historyService, cleanup } = await createTestHistoryService();
    const orphanDir = path.join(realConfig.sessionsDir, "stale-orphan-ws");
    await fsPromises.mkdir(orphanDir, { recursive: true });
    const staleTime = new Date(Date.now() - 48 * 60 * 60 * 1000);
    await fsPromises.utimes(orphanDir, staleTime, staleTime);
    await fsPromises.writeFile(path.join(realConfig.rootDir, "config.json"), "{invalid-json");

    const aiService = {
      ...createStreamLifecycleMocks(),
      on: mock(() => undefined),
      off: mock(() => undefined),
    } as unknown as AIService;
    const service = createWorkspaceServiceForTest({
      config: realConfig,
      historyService,
      aiService,
      initStateManager: mockInitStateManager as InitStateManager,
    });

    try {
      await service.initialize();
      expect(await fsPromises.stat(orphanDir).then(() => true)).toBe(true);
    } finally {
      await cleanup();
    }
  });

  test("removes DevTools logs for archived workspaces at startup", async () => {
    const liveWorkspace = createFrontendWorkspaceMetadata({
      id: "live-ws",
      name: "Live Workspace",
    });
    const archivedWorkspace = createFrontendWorkspaceMetadata({
      id: "archived-ws",
      name: "Archived Workspace",
      archivedAt: "2026-03-20T00:00:00.000Z",
    });
    // Archived when metadata was read, but a client unarchived it (and produced new logs)
    // before the sweep reached it: the live config decides.
    const unarchivedSinceWorkspace = createFrontendWorkspaceMetadata({
      id: "unarchived-since-ws",
      name: "Unarchived Since Read",
      archivedAt: "2026-03-20T00:00:00.000Z",
    });
    const archivedWithoutDataWorkspace = createFrontendWorkspaceMetadata({
      id: "archived-no-data-ws",
      name: "Archived Without DevTools Data",
      archivedAt: "2026-03-20T00:00:00.000Z",
    });
    config.getAllWorkspaceMetadata = mock(() =>
      Promise.resolve([
        liveWorkspace,
        archivedWorkspace,
        unarchivedSinceWorkspace,
        archivedWithoutDataWorkspace,
      ])
    ) as unknown as Config["getAllWorkspaceMetadata"];
    config.loadConfigOrDefault = mock(() => ({
      projects: new Map([
        [
          "/tmp/project",
          {
            workspaces: [
              { id: "live-ws", name: "live-ws", path: "/tmp/live-ws" },
              {
                id: "archived-ws",
                name: "archived-ws",
                path: "/tmp/archived-ws",
                archivedAt: "2026-03-20T00:00:00.000Z",
              },
              {
                id: "unarchived-since-ws",
                name: "unarchived-since-ws",
                path: "/tmp/unarchived-since-ws",
                archivedAt: "2026-03-20T00:00:00.000Z",
                unarchivedAt: "2026-03-21T00:00:00.000Z",
              },
              {
                id: "archived-no-data-ws",
                name: "archived-no-data-ws",
                path: "/tmp/archived-no-data-ws",
                archivedAt: "2026-03-20T00:00:00.000Z",
              },
            ],
          },
        ],
      ]),
    })) as unknown as Config["loadConfigOrDefault"];

    const removeWorkspaceData = mock(() => Promise.resolve());
    workspaceService.setDevToolsService({
      hasWorkspaceData: (workspaceId: string) =>
        Promise.resolve(workspaceId !== "archived-no-data-ws"),
      removeWorkspaceData,
    });

    const startupAccess = workspaceService as unknown as {
      startStartupRecovery: (workspaceId: string) => void;
    };
    spyOn(startupAccess, "startStartupRecovery").mockImplementation(() => undefined);

    await workspaceService.initialize();

    expect(removeWorkspaceData).toHaveBeenCalledTimes(1);
    expect(removeWorkspaceData).toHaveBeenCalledWith("archived-ws");
  });

  test("initialize schedules no recovery once shutdown has aborted it", async () => {
    config.getAllWorkspaceMetadata = mock(() =>
      Promise.resolve([createFrontendWorkspaceMetadata({ id: "live-ws", name: "Live Workspace" })])
    ) as unknown as Config["getAllWorkspaceMetadata"];
    config.loadConfigOrDefault = mock(() => ({
      projects: new Map([
        [
          "/tmp/project",
          { workspaces: [{ id: "live-ws", name: "live-ws", path: "/tmp/live-ws" }] },
        ],
      ]),
    })) as unknown as Config["loadConfigOrDefault"];
    const startupAccess = workspaceService as unknown as {
      startStartupRecovery: (workspaceId: string) => void;
    };
    const startStartupRecoverySpy = spyOn(startupAccess, "startStartupRecovery").mockImplementation(
      () => undefined
    );
    const shutdown = new AbortController();

    await workspaceService.initialize({ signal: shutdown.signal });
    expect(startStartupRecoverySpy).toHaveBeenCalledTimes(1);

    shutdown.abort();
    await workspaceService.initialize({ signal: shutdown.signal });
    expect(startStartupRecoverySpy).toHaveBeenCalledTimes(1);
  });

  test("beginShutdown disposes transient recovery sessions and halts the rest", async () => {
    const release = Promise.withResolvers<void>();
    const dispose = mock(() => release.promise);
    const beginShutdown = mock(() => undefined);
    const startupAccess = workspaceService as unknown as {
      transientStartupRecoverySessions: Map<string, AgentSession>;
      sessions: Map<string, AgentSession>;
      pendingWorkspaceCleanup: Set<Promise<void>>;
    };
    startupAccess.transientStartupRecoverySessions.set("ws-a", {
      dispose,
    } as unknown as AgentSession);
    startupAccess.transientStartupRecoverySessions.set("ws-b", {
      dispose,
    } as unknown as AgentSession);
    // A recovery session promoted with a retry pending, or a client-created session that
    // housekeeping scheduled recovery on: it may own a live stream, so it is not disposed.
    startupAccess.sessions.set("ws-promoted", {
      dispose,
      beginShutdown,
    } as unknown as AgentSession);

    workspaceService.beginShutdown();

    expect(dispose).toHaveBeenCalledTimes(2);
    expect(startupAccess.transientStartupRecoverySessions.size).toBe(2);
    release.resolve();
    await Promise.all(startupAccess.pendingWorkspaceCleanup);
    expect(startupAccess.transientStartupRecoverySessions.size).toBe(0);
    expect(beginShutdown).toHaveBeenCalledTimes(1);
    startupAccess.sessions.delete("ws-promoted");
  });

  test("disposes transient startup-recovery sessions that go idle", async () => {
    const dispose = mock(() => undefined);
    const fakeSession = {
      runStartupRecovery: mock(() => Promise.resolve()),
      shouldRetainAfterStartupRecovery: mock(() => false),
      scheduleStartupRecovery: mock(() => undefined),
      dispose,
    } as unknown as AgentSession;

    const startupAccess = workspaceService as unknown as {
      startStartupRecovery: (workspaceId: string) => void;
      createSession: (workspaceId: string) => AgentSession;
      sessions: Map<string, AgentSession>;
    };
    const createSessionSpy = spyOn(startupAccess, "createSession").mockImplementation(
      () => fakeSession
    );

    startupAccess.startStartupRecovery("live-ws");
    await Promise.resolve();
    await Promise.resolve();

    expect(createSessionSpy).toHaveBeenCalledWith("live-ws");
    expect(dispose).toHaveBeenCalledTimes(1);
    expect(startupAccess.sessions.has("live-ws")).toBe(false);
  });

  test("retains transient startup-recovery sessions when recovery stays active", async () => {
    const dispose = mock(() => undefined);
    const onChatEvent = mock(() => () => undefined);
    const onMetadataEvent = mock(() => () => undefined);
    const fakeSession = {
      runStartupRecovery: mock(() => Promise.resolve()),
      shouldRetainAfterStartupRecovery: mock(() => true),
      scheduleStartupRecovery: mock(() => undefined),
      onChatEvent,
      onMetadataEvent,
      dispose,
    } as unknown as AgentSession;

    const startupAccess = workspaceService as unknown as {
      startStartupRecovery: (workspaceId: string) => void;
      createSession: (workspaceId: string) => AgentSession;
      sessions: Map<string, AgentSession>;
    };
    spyOn(startupAccess, "createSession").mockImplementation(() => fakeSession);

    startupAccess.startStartupRecovery("live-ws");
    await Promise.resolve();
    await Promise.resolve();

    expect(dispose).not.toHaveBeenCalled();
    expect(startupAccess.sessions.get("live-ws")).toBe(fakeSession);
  });

  test("claims transient startup-recovery sessions instead of creating duplicates", () => {
    const onChatEvent = mock(() => () => undefined);
    const onMetadataEvent = mock(() => () => undefined);
    const fakeSession = {
      onChatEvent,
      onMetadataEvent,
    } as unknown as AgentSession;

    const startupAccess = workspaceService as unknown as {
      transientStartupRecoverySessions: Map<string, AgentSession>;
      sessions: Map<string, AgentSession>;
      getOrCreateSession: (workspaceId: string) => AgentSession;
      createSession: (workspaceId: string) => AgentSession;
    };
    startupAccess.transientStartupRecoverySessions.set("live-ws", fakeSession);
    const createSessionSpy = spyOn(startupAccess, "createSession");

    const claimedSession = startupAccess.getOrCreateSession("live-ws");

    expect(claimedSession).toBe(fakeSession);
    expect(startupAccess.transientStartupRecoverySessions.has("live-ws")).toBe(false);
    expect(startupAccess.sessions.get("live-ws")).toBe(fakeSession);
    expect(createSessionSpy).not.toHaveBeenCalled();
  });
});

describe("WorkspaceService rename lock", () => {
  let workspaceService: WorkspaceService;
  let mockAIService: AIService;
  let historyService: HistoryService;
  let cleanupHistory: () => Promise<void>;

  beforeEach(async () => {
    // Create minimal mocks for the services
    mockAIService = {
      ...createStreamLifecycleMocks(),
      isStreaming: mock(() => false),
      getWorkspaceMetadata: mock(() => Promise.resolve({ success: false, error: "not found" })),
      // eslint-disable-next-line @typescript-eslint/no-empty-function
      on: mock(() => {}),
      // eslint-disable-next-line @typescript-eslint/no-empty-function
      off: mock(() => {}),
    } as unknown as AIService;

    ({ historyService, cleanup: cleanupHistory } = await createTestHistoryService());

    const mockConfig: MockWorkspaceConfig = {
      srcDir: "/tmp/test",
      sessionsDir: "/tmp/test/sessions",
      generateStableId: mock(() => "test-id"),
      findWorkspace: mock(() => null),
    };
    const mockInitStateManager: Partial<InitStateManager> = {
      on: mock(() => undefined as unknown as InitStateManager),
      getInitState: mock(() => undefined),
    };
    workspaceService = createWorkspaceServiceForTest({
      config: mockConfig,
      historyService,
      aiService: mockAIService,
      initStateManager: mockInitStateManager as InitStateManager,
    });
  });

  afterEach(async () => {
    await cleanupHistory();
  });

  test("sendMessage returns error when workspace is being renamed", async () => {
    const workspaceId = "test-workspace";

    addToRenamingWorkspaces(workspaceService, workspaceId);

    const result = await workspaceService.sendMessage(workspaceId, "test message", {
      model: "test-model",
      agentId: "exec",
    });

    expect(result.success).toBe(false);
    if (!result.success) {
      const error = result.error;
      // Error is SendMessageError which has a discriminated union
      expect(typeof error === "object" && error.type === "unknown").toBe(true);
      if (typeof error === "object" && error.type === "unknown") {
        expect(error.raw).toContain("being renamed");
      }
    }
  });

  test("resumeStream returns error when workspace is being renamed", async () => {
    const workspaceId = "test-workspace";

    addToRenamingWorkspaces(workspaceService, workspaceId);

    const result = await workspaceService.resumeStream(workspaceId, {
      model: "test-model",
      agentId: "exec",
    });

    expect(result.success).toBe(false);
    if (!result.success) {
      const error = result.error;
      // Error is SendMessageError which has a discriminated union
      expect(typeof error === "object" && error.type === "unknown").toBe(true);
      if (typeof error === "object" && error.type === "unknown") {
        expect(error.raw).toContain("being renamed");
      }
    }
  });

  test("rename returns error when workspace is streaming", async () => {
    const workspaceId = "test-workspace";

    // Mock isStreaming to return true
    (mockAIService.isStreaming as ReturnType<typeof mock>).mockReturnValue(true);

    const result = await workspaceService.rename(workspaceId, "new-name");

    expect(result.success).toBe(false);
    if (!result.success) {
      expect(result.error).toContain("stream is active");
    }
  });
});

describe("WorkspaceService sendMessage status clearing", () => {
  let workspaceService: WorkspaceService;
  let historyService: HistoryService;
  let cleanupHistory: () => Promise<void>;
  let fakeSession: {
    isBusy: ReturnType<typeof mock>;
    hasQueuedMessages: ReturnType<typeof mock>;
    hasQueuedOrDispatchingEntry: ReturnType<typeof mock>;
    dropQueuedMessageWithOnlyDedupeKey: ReturnType<typeof mock>;
    queueMessage: ReturnType<typeof mock>;
    sendMessage: ReturnType<typeof mock>;
    resumeStream: ReturnType<typeof mock>;
    drainQueuedMessagesIfIdle: ReturnType<typeof mock>;
  };

  beforeEach(async () => {
    const aiService: AIService = {
      ...createStreamLifecycleMocks(),
      isStreaming: mock(() => false),
      getWorkspaceMetadata: mock(() =>
        Promise.resolve({ success: false as const, error: "not found" })
      ),
      // eslint-disable-next-line @typescript-eslint/no-empty-function
      on: mock(() => {}),
      // eslint-disable-next-line @typescript-eslint/no-empty-function
      off: mock(() => {}),
    } as unknown as AIService;

    ({ historyService, cleanup: cleanupHistory } = await createTestHistoryService());

    const mockConfig: MockWorkspaceConfig = {
      srcDir: "/tmp/test",
      sessionsDir: "/tmp/test/sessions",
      generateStableId: mock(() => "test-id"),
      findWorkspace: mock(() => ({
        workspacePath: "/tmp/test/workspace",
        projectPath: "/tmp/test/project",
      })),
      loadConfigOrDefault: mock(() => ({ projects: new Map() })),
    };

    const mockExtensionMetadata: Partial<ExtensionMetadataService> = {
      updateRecency: mock(() =>
        Promise.resolve({
          recency: Date.now(),
          streaming: false,
          lastModel: null,
          lastThinkingLevel: null,
          agentStatus: null,
        })
      ),
      setStreaming: mock(() =>
        Promise.resolve({
          recency: Date.now(),
          streaming: false,
          lastModel: null,
          lastThinkingLevel: null,
          agentStatus: null,
        })
      ),
      setAgentStatus: mock(() =>
        Promise.resolve({
          recency: Date.now(),
          streaming: false,
          lastModel: null,
          lastThinkingLevel: null,
          agentStatus: null,
        })
      ),
    };

    workspaceService = createWorkspaceServiceForTest({
      config: mockConfig,
      historyService,
      aiService,
      extensionMetadata: mockExtensionMetadata as ExtensionMetadataService,
      initStateManager: mockInitStateManager as InitStateManager,
    });

    fakeSession = {
      isBusy: mock(() => true),
      hasQueuedMessages: mock(() => false),
      hasQueuedOrDispatchingEntry: mock(() => false),
      dropQueuedMessageWithOnlyDedupeKey: mock(() => false),
      queueMessage: mock(() => "tool-end" as const),
      sendMessage: mock(() => Promise.resolve(Ok(undefined))),
      resumeStream: mock(() => Promise.resolve(Ok({ started: true }))),
      drainQueuedMessagesIfIdle: mock(() => undefined),
    };

    (
      workspaceService as unknown as {
        getOrCreateSession: (workspaceId: string) => AgentSession;
      }
    ).getOrCreateSession = mock(() => fakeSession as unknown as AgentSession);

    (
      workspaceService as unknown as {
        maybePersistAISettingsFromOptions: (workspaceId: string, options: unknown) => Promise<void>;
      }
    ).maybePersistAISettingsFromOptions = mock(() => Promise.resolve());
  });

  afterEach(async () => {
    await cleanupHistory();
  });

  test.each(["send", "synthetic", "resume"] as const)(
    "only a user message updates remembered settings (%s)",
    async (kind) => {
      const persist = mock(() => Promise.resolve());
      (
        workspaceService as unknown as {
          maybePersistAISettingsFromOptions: typeof persist;
        }
      ).maybePersistAISettingsFromOptions = persist;
      const options = { model: "openai:gpt-5.2", agentId: "plan", thinkingLevel: "high" as const };
      const result =
        kind === "resume"
          ? await workspaceService.resumeStream("test-workspace", options)
          : await workspaceService.sendMessage("test-workspace", "hello", options, {
              synthetic: kind === "synthetic",
            });
      expect(result.success).toBe(true);
      expect(persist).toHaveBeenCalledTimes(kind === "send" ? 1 : 0);
    }
  );

  test("delegates manual pricing rejections to AgentSession so user input is preserved", async () => {
    fakeSession.isBusy.mockReturnValue(false);
    const pricingError: SendMessageError = { type: "unknown", raw: "unpriced model" };
    workspaceService.setWorkspaceGoalService({
      assertPricedModelForBudgetedGoal: mock(() => Promise.resolve(Err(pricingError))),
    } as unknown as WorkspaceGoalService);
    fakeSession.sendMessage.mockResolvedValue(Err(pricingError));

    const result = await workspaceService.sendMessage("test-workspace", "please stop", {
      model: "custom:unpriced-model",
      agentId: "exec",
    });

    expect(result.success).toBe(false);
    expect(fakeSession.sendMessage).toHaveBeenCalledTimes(1);
    expect(fakeSession.sendMessage).toHaveBeenCalledWith(
      "please stop",
      expect.objectContaining({ model: "custom:unpriced-model", agentId: "exec" }),
      expect.objectContaining({ synthetic: undefined })
    );
  });

  test("a send arriving during an earlier send's preflight queues instead of starting a second turn", async () => {
    // The session only reports busy once AgentSession.sendMessage claims PREPARING. A
    // later send admitted against the idle snapshot would start a competing stream that
    // StreamManager resolves by aborting the earlier turn. Both sends sit in preflight
    // awaits here, so arrival order (not who checks first) must decide who yields.
    fakeSession.isBusy.mockReturnValue(false);
    const firstSend = createDeferred<Result<void, SendMessageError>>();
    fakeSession.sendMessage.mockImplementationOnce(() => firstSend.promise);

    const firstResult = workspaceService.sendMessage("test-workspace", "first", {
      model: "openai:gpt-4o-mini",
      agentId: "exec",
    });
    const secondResult = workspaceService.sendMessage("test-workspace", "second", {
      model: "openai:gpt-4o-mini",
      agentId: "exec",
    });
    expect((await secondResult).success).toBe(true);
    expect(fakeSession.queueMessage).toHaveBeenCalledTimes(1);
    expect(fakeSession.queueMessage.mock.calls[0]?.[0]).toBe("second");
    expect(fakeSession.sendMessage).toHaveBeenCalledTimes(1);
    expect(fakeSession.sendMessage.mock.calls[0]?.[0]).toBe("first");

    firstSend.resolve(Ok(undefined));
    expect((await firstResult).success).toBe(true);
  });

  test("entries queued behind a preflight send drain only once that send settles without a turn", async () => {
    // Nothing else will drain them: the failed send never claimed PREPARING, so no stream
    // end fires. Draining while the earlier send is still in preflight would let the queued
    // entry jump ahead of it.
    fakeSession.isBusy.mockReturnValue(false);
    (workspaceService as unknown as { sessions: Map<string, AgentSession> }).sessions.set(
      "test-workspace",
      fakeSession as unknown as AgentSession
    );
    const firstSend = createDeferred<Result<void, SendMessageError>>();
    fakeSession.sendMessage.mockImplementationOnce(() => firstSend.promise);

    const firstResult = workspaceService.sendMessage("test-workspace", "first", {
      model: "openai:gpt-4o-mini",
      agentId: "exec",
    });
    await waitForCondition(() => fakeSession.sendMessage.mock.calls.length === 1);
    await workspaceService.sendMessage("test-workspace", "second", {
      model: "openai:gpt-4o-mini",
      agentId: "exec",
    });
    expect(fakeSession.queueMessage).toHaveBeenCalledTimes(1);
    expect(fakeSession.drainQueuedMessagesIfIdle).not.toHaveBeenCalled();

    firstSend.resolve(Err({ type: "unknown", raw: "rejected before the turn was accepted" }));
    expect((await firstResult).success).toBe(false);
    expect(fakeSession.drainQueuedMessagesIfIdle).toHaveBeenCalledTimes(1);
  });

  test("the oldest preflight failing drains the entries queued behind it while a younger preflight is live", async () => {
    // Codex P1 (PRRT_kwDOPxxmWM6eaerl): waiting for every preflight to settle would let the
    // younger send pass shouldQueue with no earlier ticket left and start ahead of the entry
    // queued behind the failed one. Draining as soon as the head of the line settles makes
    // the younger send observe the dispatched (busy) session instead.
    fakeSession.isBusy.mockReturnValue(false);
    (workspaceService as unknown as { sessions: Map<string, AgentSession> }).sessions.set(
      "test-workspace",
      fakeSession as unknown as AgentSession
    );
    const persistSettings = (
      workspaceService as unknown as { maybePersistAISettingsFromOptions: ReturnType<typeof mock> }
    ).maybePersistAISettingsFromOptions;
    const firstSend = createDeferred<Result<void, SendMessageError>>();
    fakeSession.sendMessage.mockImplementationOnce(() => firstSend.promise);
    const sendOptions = { model: "openai:gpt-4o-mini", agentId: "exec" };

    const firstResult = workspaceService.sendMessage("test-workspace", "first", sendOptions);
    await waitForCondition(() => fakeSession.sendMessage.mock.calls.length === 1);
    await workspaceService.sendMessage("test-workspace", "second", sendOptions);
    expect(fakeSession.queueMessage).toHaveBeenCalledTimes(1);

    const thirdPreflight = createDeferred<void>();
    persistSettings.mockImplementationOnce(() => thirdPreflight.promise);
    const thirdResult = workspaceService.sendMessage("test-workspace", "third", sendOptions);
    await waitForCondition(() => persistSettings.mock.calls.length === 3);
    expect(fakeSession.drainQueuedMessagesIfIdle).not.toHaveBeenCalled();

    firstSend.resolve(Err({ type: "unknown", raw: "rejected before the turn was accepted" }));
    expect((await firstResult).success).toBe(false);
    expect(fakeSession.drainQueuedMessagesIfIdle).toHaveBeenCalledTimes(1);

    thirdPreflight.resolve();
    expect((await thirdResult).success).toBe(true);
  });

  test("manual input is not queued behind a requireIdle send in preflight, which yields to it", async () => {
    // Codex P1 (PRRT_kwDOPxxmWM6eaerm): a heartbeat's ticket is older, but queueing the
    // user's message behind it would let the heartbeat take the turn first. The maintenance
    // send is supersedable: the manual send goes direct and the heartbeat's own
    // preflight-count skip refuses it.
    fakeSession.isBusy.mockReturnValue(false);
    const pricingGate = mock(() => Promise.resolve(Ok(undefined)));
    workspaceService.setWorkspaceGoalService({
      assertPricedModelForBudgetedGoal: pricingGate,
    } as unknown as WorkspaceGoalService);
    const heartbeatPreflight = createDeferred<void>();
    pricingGate.mockImplementationOnce(() => heartbeatPreflight.promise.then(() => Ok(undefined)));
    const sendOptions = { model: "openai:gpt-4o-mini", agentId: "exec" };

    const heartbeatResult = workspaceService.sendMessage(
      "test-workspace",
      "check in",
      sendOptions,
      {
        synthetic: true,
        agentInitiated: true,
        requireIdle: true,
      }
    );
    await waitForCondition(() => pricingGate.mock.calls.length === 1);

    const manualSend = createDeferred<Result<void, SendMessageError>>();
    fakeSession.sendMessage.mockImplementationOnce(() => manualSend.promise);
    const manualResult = workspaceService.sendMessage("test-workspace", "manual", sendOptions);
    await waitForCondition(() => fakeSession.sendMessage.mock.calls.length === 1);
    expect(fakeSession.sendMessage.mock.calls[0]?.[0]).toBe("manual");
    expect(fakeSession.queueMessage).not.toHaveBeenCalled();

    heartbeatPreflight.resolve();
    expect((await heartbeatResult).success).toBe(false);
    // The heartbeat never reached the session; only the manual send did.
    expect(fakeSession.sendMessage).toHaveBeenCalledTimes(1);

    manualSend.resolve(Ok(undefined));
    expect((await manualResult).success).toBe(true);
  });

  test("a failed send drains the entries queued behind it even when a supersedable preflight is older", async () => {
    // Codex P1 (PRRT_kwDOPxxmWM6ebIHT): the requireIdle send is physically oldest but nobody
    // queues behind it, so it must not decide who drains. Otherwise the entry queued behind
    // the failed manual send waits until the maintenance preflight settles.
    fakeSession.isBusy.mockReturnValue(false);
    (workspaceService as unknown as { sessions: Map<string, AgentSession> }).sessions.set(
      "test-workspace",
      fakeSession as unknown as AgentSession
    );
    const pricingGate = mock(() => Promise.resolve(Ok(undefined)));
    workspaceService.setWorkspaceGoalService({
      assertPricedModelForBudgetedGoal: pricingGate,
    } as unknown as WorkspaceGoalService);
    const sendOptions = { model: "openai:gpt-4o-mini", agentId: "exec" };
    const maintenancePreflight = createDeferred<void>();
    pricingGate.mockImplementationOnce(() =>
      maintenancePreflight.promise.then(() => Ok(undefined))
    );
    const maintenanceResult = workspaceService.sendMessage(
      "test-workspace",
      "check in",
      sendOptions,
      { synthetic: true, agentInitiated: true, requireIdle: true }
    );
    await waitForCondition(() => pricingGate.mock.calls.length === 1);

    const firstManual = createDeferred<Result<void, SendMessageError>>();
    fakeSession.sendMessage.mockImplementationOnce(() => firstManual.promise);
    const firstManualResult = workspaceService.sendMessage("test-workspace", "first", sendOptions);
    await waitForCondition(() => fakeSession.sendMessage.mock.calls.length === 1);
    await workspaceService.sendMessage("test-workspace", "second", sendOptions);
    expect(fakeSession.queueMessage).toHaveBeenCalledTimes(1);
    expect(fakeSession.drainQueuedMessagesIfIdle).not.toHaveBeenCalled();

    // Codex P1 (PRRT_kwDOPxxmWM6ebqSE): the maintenance send settling first (it yields to the
    // manual send in preflight) must not drain either: "second" is queued behind "first",
    // which is still live, and dispatching it now would start it ahead of "first".
    maintenancePreflight.resolve();
    expect((await maintenanceResult).success).toBe(false);
    expect(fakeSession.drainQueuedMessagesIfIdle).not.toHaveBeenCalled();

    firstManual.resolve(Err({ type: "unknown", raw: "rejected before the turn was accepted" }));
    expect((await firstManualResult).success).toBe(false);
    expect(fakeSession.drainQueuedMessagesIfIdle).toHaveBeenCalledTimes(1);
  });

  test("sends reach the queue in arrival order even when a later one finishes preflight first", async () => {
    // Codex P1 (PRRT_kwDOPxxmWM6ebqSR): with "first" in preflight, "third" can finish its
    // pricing/settings awaits before "second"; enqueueing on completion order would make the
    // user's third prompt dispatch before the second.
    fakeSession.isBusy.mockReturnValue(false);
    const persistSettings = (
      workspaceService as unknown as { maybePersistAISettingsFromOptions: ReturnType<typeof mock> }
    ).maybePersistAISettingsFromOptions;
    const sendOptions = { model: "openai:gpt-4o-mini", agentId: "exec" };
    const firstSend = createDeferred<Result<void, SendMessageError>>();
    fakeSession.sendMessage.mockImplementationOnce(() => firstSend.promise);
    const firstResult = workspaceService.sendMessage("test-workspace", "first", sendOptions);
    await waitForCondition(() => fakeSession.sendMessage.mock.calls.length === 1);

    const secondPreflight = createDeferred<void>();
    persistSettings.mockImplementationOnce(() => secondPreflight.promise);
    const secondResult = workspaceService.sendMessage("test-workspace", "second", sendOptions);
    await waitForCondition(() => persistSettings.mock.calls.length === 2);
    const thirdResult = workspaceService.sendMessage("test-workspace", "third", sendOptions);
    await waitForCondition(() => persistSettings.mock.calls.length === 3);
    await drainPendingDispatches();
    // "third" finished its awaits but must wait for "second" to decide.
    expect(fakeSession.queueMessage).not.toHaveBeenCalled();

    secondPreflight.resolve();
    expect((await secondResult).success).toBe(true);
    expect((await thirdResult).success).toBe(true);
    expect((fakeSession.queueMessage.mock.calls as unknown[][]).map((call) => call[0])).toEqual([
      "second",
      "third",
    ]);

    firstSend.resolve(Ok(undefined));
    expect((await firstResult).success).toBe(true);
  });

  test("a queue-mode heartbeat in preflight yields quietly to manual input instead of racing it", async () => {
    // Codex P1 (PRRT_kwDOPxxmWM6ebIHa): queue-mode heartbeats set yieldToQueuedMessages, not
    // requireIdle. The manual send must not queue behind the heartbeat, and the heartbeat
    // must not start once that input is in preflight; its next slot fires anyway.
    fakeSession.isBusy.mockReturnValue(false);
    const pricingGate = mock(() => Promise.resolve(Ok(undefined)));
    workspaceService.setWorkspaceGoalService({
      assertPricedModelForBudgetedGoal: pricingGate,
    } as unknown as WorkspaceGoalService);
    const heartbeatPreflight = createDeferred<void>();
    pricingGate.mockImplementationOnce(() => heartbeatPreflight.promise.then(() => Ok(undefined)));
    const sendOptions = { model: "openai:gpt-4o-mini", agentId: "exec" };

    const heartbeatResult = workspaceService.sendMessage(
      "test-workspace",
      "check in",
      { ...sendOptions, queueDispatchMode: "turn-end" },
      {
        synthetic: true,
        agentInitiated: true,
        skipAutoResumeReset: true,
        queueDedupeKey: "heartbeat",
        yieldToQueuedMessages: true,
      }
    );
    await waitForCondition(() => pricingGate.mock.calls.length === 1);

    const manualSend = createDeferred<Result<void, SendMessageError>>();
    fakeSession.sendMessage.mockImplementationOnce(() => manualSend.promise);
    const manualResult = workspaceService.sendMessage("test-workspace", "manual", sendOptions);
    await waitForCondition(() => fakeSession.sendMessage.mock.calls.length === 1);
    expect(fakeSession.sendMessage.mock.calls[0]?.[0]).toBe("manual");
    expect(fakeSession.queueMessage).not.toHaveBeenCalled();

    heartbeatPreflight.resolve();
    // Superseded heartbeats report success so the scheduler does not record a failure.
    expect((await heartbeatResult).success).toBe(true);
    expect(fakeSession.sendMessage).toHaveBeenCalledTimes(1);

    manualSend.resolve(Ok(undefined));
    expect((await manualResult).success).toBe(true);
  });

  test("the follow-up idle probe excludes the originating send after its session handoff", async () => {
    // Codex P1 (PRRT_kwDOPxxmWM6cRi_J): preflightSendCounts stays positive
    // until the outer service call returns, so a probe reading it would let a
    // continuation's on-send compaction completion veto the continuation's
    // OWN saved follow-up. The probe must see unrelated preflights (round-37
    // semantics) but release the originating send at its session handoff.
    fakeSession.isBusy.mockReturnValue(false);
    const realSession = (
      workspaceService as unknown as { createSession: (workspaceId: string) => AgentSession }
    ).createSession("test-workspace");
    // The shared fixture aiService omits stopStream; disposal needs it.
    (
      realSession as unknown as { aiService: { stopStream?: () => Promise<unknown> } }
    ).aiService.stopStream = () => Promise.resolve(Ok(undefined));
    const probe = (realSession as unknown as { hasExternalSendPreflight?: () => boolean })
      .hasExternalSendPreflight;
    expect(probe).toBeDefined();
    try {
      expect(probe!()).toBe(false);

      // A send stalled in its pricing preflight is visible to the probe.
      let releasePricing!: () => void;
      const pricingGate = new Promise<void>((resolve) => {
        releasePricing = resolve;
      });
      let pricingStarted = false;
      workspaceService.setWorkspaceGoalService({
        assertPricedModelForBudgetedGoal: mock(async () => {
          pricingStarted = true;
          await pricingGate;
          return Ok(undefined);
        }),
        getPendingGoalSnapshot: mock(() => null),
      } as unknown as WorkspaceGoalService);
      // Ref objects: closure assignments to a `let` are invisible to TS
      // control-flow narrowing at the later assertion sites.
      const probeBeforeAdmission: { value: boolean | null } = { value: null };
      const probeAfterAdmission: { value: boolean | null } = { value: null };
      fakeSession.sendMessage.mockImplementationOnce(
        (
          _message: unknown,
          _options: unknown,
          internal?: { onTurnAdmissionCommitted?: () => void }
        ) => {
          // Codex P2 (PRRT_kwDOPxxmWM6cSRkH): the reservation must survive the
          // session's admission awaits (the idle gap before the busy claim)...
          probeBeforeAdmission.value = probe!();
          internal?.onTurnAdmissionCommitted?.();
          // ...and release the moment the turn synchronously claims PREPARING,
          // so a follow-up redispatched from within this very turn (on-send
          // compaction completion) does not veto itself.
          probeAfterAdmission.value = probe!();
          return Promise.resolve(Ok(undefined));
        }
      );

      const sendPromise = workspaceService.sendMessage("test-workspace", "manual message", {
        model: "openai:gpt-4o-mini",
        agentId: "exec",
      });
      await waitForCondition(() => pricingStarted);
      expect(probe!()).toBe(true);

      releasePricing();
      const result = await sendPromise;
      expect(result.success).toBe(true);
      expect(probeBeforeAdmission.value).toBe(true);
      expect(probeAfterAdmission.value).toBe(false);
      // Fully settled: no residual reservation leaks.
      expect(probe!()).toBe(false);
    } finally {
      await realSession.dispose();
    }
  });

  test("holds the preflight reservation through resumeStream session admission", async () => {
    // Codex P1 (PRRT_kwDOPxxmWM6cSREO): AgentSession.resumeStream runs its own
    // async admission (a second pricing gate) during which the session still
    // reports idle. Releasing the reservation before that await let follow-up
    // recovery admit a recovered synthetic turn that then ran concurrently
    // with the resumed stream — the reservation must survive until the session
    // call settles.
    fakeSession.isBusy.mockReturnValue(false);
    const realSession = (
      workspaceService as unknown as { createSession: (workspaceId: string) => AgentSession }
    ).createSession("test-workspace");
    // The shared fixture aiService omits stopStream; disposal needs it.
    (
      realSession as unknown as { aiService: { stopStream?: () => Promise<unknown> } }
    ).aiService.stopStream = () => Promise.resolve(Ok(undefined));
    const probe = (realSession as unknown as { hasExternalSendPreflight?: () => boolean })
      .hasExternalSendPreflight;
    expect(probe).toBeDefined();
    try {
      workspaceService.setWorkspaceGoalService({
        assertPricedModelForBudgetedGoal: mock(() => Promise.resolve(Ok(undefined))),
        getPendingGoalSnapshot: mock(() => null),
      } as unknown as WorkspaceGoalService);
      const probeDuringResume: { value: boolean | null } = { value: null };
      fakeSession.resumeStream.mockImplementationOnce(() => {
        probeDuringResume.value = probe!();
        return Promise.resolve(Ok({ started: true }));
      });

      const result = await workspaceService.resumeStream("test-workspace", {
        model: "openai:gpt-4o-mini",
        agentId: "exec",
      });
      expect(result.success).toBe(true);
      expect(probeDuringResume.value).toBe(true);
      // Fully settled: no residual reservation leaks.
      expect(probe!()).toBe(false);
    } finally {
      await realSession.dispose();
    }
  });

  test("holds the preflight reservation through the rejected-send fallback", async () => {
    // Codex P1 (PRRT_kwDOPxxmWM6cSCjs): a manual send rejected by the pricing
    // gate delegates into AgentSession to persist the user row and apply goal
    // safety, but it never streams and cannot produce its own compaction
    // follow-up. Releasing the reservation before that fallback let a
    // completing goal-scoped follow-up be admitted ahead of the user's
    // intervention; the reservation must survive until the fallback settles.
    fakeSession.isBusy.mockReturnValue(false);
    const realSession = (
      workspaceService as unknown as { createSession: (workspaceId: string) => AgentSession }
    ).createSession("test-workspace");
    // The shared fixture aiService omits stopStream; disposal needs it.
    (
      realSession as unknown as { aiService: { stopStream?: () => Promise<unknown> } }
    ).aiService.stopStream = () => Promise.resolve(Ok(undefined));
    const probe = (realSession as unknown as { hasExternalSendPreflight?: () => boolean })
      .hasExternalSendPreflight;
    expect(probe).toBeDefined();
    try {
      const pricingError: SendMessageError = { type: "unknown", raw: "unpriced model" };
      workspaceService.setWorkspaceGoalService({
        assertPricedModelForBudgetedGoal: mock(() => Promise.resolve(Err(pricingError))),
        getPendingGoalSnapshot: mock(() => null),
      } as unknown as WorkspaceGoalService);
      const probeDuringFallback: { value: boolean | null } = { value: null };
      fakeSession.sendMessage.mockImplementationOnce(() => {
        probeDuringFallback.value = probe!();
        return Promise.resolve(Err(pricingError));
      });

      const result = await workspaceService.sendMessage("test-workspace", "please stop", {
        model: "custom:unpriced-model",
        agentId: "exec",
      });
      expect(result.success).toBe(false);
      // The fallback persists the rejected row and applies goal safety while
      // other dispatchers may probe idleness — it must still see this send.
      expect(probeDuringFallback.value).toBe(true);
      // Fully settled: no residual reservation leaks.
      expect(probe!()).toBe(false);
    } finally {
      await realSession.dispose();
    }
  });

  test.each(["sendMessage", "resumeStream"] as const)(
    "%s refuses the stream when desktop task admission fails",
    async (operation) => {
      fakeSession.isBusy.mockReturnValue(false);
      const restoreInterruptedTaskAfterResumeFailure = mock(() => Promise.resolve());
      workspaceService.setAgentTaskIntegration(
        makeAgentTaskIntegrationFake({
          markInterruptedTaskRunning: mock(() =>
            Promise.reject(new Error("Desktop is controlled by another child"))
          ),
          restoreInterruptedTaskAfterResumeFailure,
        })
      );
      const options = { model: "openai:gpt-4o-mini", agentId: "exec" };
      const result =
        operation === "sendMessage"
          ? await workspaceService.sendMessage("test-workspace", "hello", options)
          : await workspaceService.resumeStream("test-workspace", options);
      expect(result.success).toBe(false);
      expect(fakeSession.sendMessage).not.toHaveBeenCalled();
      expect(fakeSession.resumeStream).not.toHaveBeenCalled();
      expect(restoreInterruptedTaskAfterResumeFailure).not.toHaveBeenCalled();
    }
  );

  // Send outcome drives interrupted-task rollback: a successful send keeps the
  // restored running status; a failed or thrown send rolls it back.
  test.each([
    ["sendMessage restores interrupted task status before successful send", "ok", true],
    ["sendMessage restores interrupted status when resumed send fails", "err", false],
    ["sendMessage restores interrupted status when resumed send throws", "throw", false],
  ] as const)("%s", async (_name, sendOutcome, expectSuccess) => {
    fakeSession.isBusy.mockReturnValue(false);
    if (sendOutcome === "err") {
      fakeSession.sendMessage.mockResolvedValue(
        Err({ type: "unknown" as const, raw: "runtime startup failed after user turn persisted" })
      );
    } else if (sendOutcome === "throw") {
      fakeSession.sendMessage.mockRejectedValue(new Error("send explode"));
    }

    const markInterruptedTaskRunning = mock(() => Promise.resolve(true));
    const restoreInterruptedTaskAfterResumeFailure = mock(() => Promise.resolve());
    workspaceService.setAgentTaskIntegration(
      makeAgentTaskIntegrationFake({
        markInterruptedTaskRunning,
        restoreInterruptedTaskAfterResumeFailure,
      })
    );

    const result = await workspaceService.sendMessage("test-workspace", "hello", {
      model: "openai:gpt-4o-mini",
      agentId: "exec",
    });

    expect(result.success).toBe(expectSuccess);
    expect(markInterruptedTaskRunning).toHaveBeenCalledWith("test-workspace");
    if (expectSuccess) {
      expect(restoreInterruptedTaskAfterResumeFailure).not.toHaveBeenCalled();
    } else {
      expect(restoreInterruptedTaskAfterResumeFailure).toHaveBeenCalledWith(
        "test-workspace",
        undefined
      );
    }
  });

  test("sendMessage restores interrupted status when accepted edit startup fails later", async () => {
    fakeSession.isBusy.mockReturnValue(false);

    const markInterruptedTaskRunning = mock(() => Promise.resolve(true));
    const restoreInterruptedTaskAfterResumeFailure = mock(() => Promise.resolve());
    workspaceService.setAgentTaskIntegration(
      makeAgentTaskIntegrationFake({
        markInterruptedTaskRunning,
        restoreInterruptedTaskAfterResumeFailure,
      })
    );

    const startupFailureHandled = createDeferred<void>();
    fakeSession.sendMessage.mockImplementation(
      (
        _message: string,
        _options: unknown,
        internal?: {
          onAcceptedPreStreamFailure?: (error: SendMessageError) => Promise<void> | void;
        }
      ) => {
        void Promise.resolve().then(async () => {
          await internal?.onAcceptedPreStreamFailure?.({
            type: "runtime_start_failed",
            message: "Runtime is starting",
          });
          startupFailureHandled.resolve();
        });
        return Promise.resolve(Ok(undefined));
      }
    );

    const result = await workspaceService.sendMessage("test-workspace", "hello", {
      model: "openai:gpt-4o-mini",
      agentId: "exec",
      editMessageId: "user-123",
    });

    expect(result.success).toBe(true);
    expect(markInterruptedTaskRunning).toHaveBeenCalledWith("test-workspace");

    await startupFailureHandled.promise;
    expect(restoreInterruptedTaskAfterResumeFailure).toHaveBeenCalledWith(
      "test-workspace",
      undefined
    );
  });

  // Resume outcome drives interrupted-task rollback: only a resume that actually
  // starts a stream keeps the restored running status.
  test.each([
    ["resumeStream restores interrupted task status before successful resume", "started", true],
    ["resumeStream keeps interrupted task status when no stream starts", "not-started", true],
    ["resumeStream restores interrupted status when resumed stream throws", "throw", false],
  ] as const)("%s", async (_name, resumeOutcome, expectSuccess) => {
    if (resumeOutcome === "not-started") {
      fakeSession.resumeStream.mockResolvedValue(Ok({ started: false }));
    } else if (resumeOutcome === "throw") {
      fakeSession.resumeStream.mockRejectedValue(new Error("resume explode"));
    }

    const markInterruptedTaskRunning = mock(() => Promise.resolve(true));
    const restoreInterruptedTaskAfterResumeFailure = mock(() => Promise.resolve());
    workspaceService.setAgentTaskIntegration(
      makeAgentTaskIntegrationFake({
        markInterruptedTaskRunning,
        restoreInterruptedTaskAfterResumeFailure,
      })
    );

    const result = await workspaceService.resumeStream("test-workspace", {
      model: "openai:gpt-4o-mini",
      agentId: "exec",
    });

    expect(result.success).toBe(expectSuccess);
    if (resumeOutcome === "not-started" && result.success) {
      expect(result.data.started).toBe(false);
    }
    expect(markInterruptedTaskRunning).toHaveBeenCalledWith("test-workspace");
    if (resumeOutcome === "started") {
      expect(restoreInterruptedTaskAfterResumeFailure).not.toHaveBeenCalled();
    } else {
      expect(restoreInterruptedTaskAfterResumeFailure).toHaveBeenCalledWith(
        "test-workspace",
        undefined
      );
    }
  });

  // Winding-down gate: an interrupted task that has not finished stopping
  // refuses new work on both entry points without touching the session.
  test.each([
    ["resumeStream does not start interrupted tasks while still busy", "resumeStream"],
    ["sendMessage does not queue interrupted tasks while still busy", "sendMessage"],
  ] as const)("%s", async (_name, entryPoint) => {
    const getAgentTaskStatus = mock(() => "interrupted" as const);
    const markInterruptedTaskRunning = mock(() => Promise.resolve(false));
    workspaceService.setAgentTaskIntegration(
      makeAgentTaskIntegrationFake({ getAgentTaskStatus, markInterruptedTaskRunning })
    );

    const options = { model: "openai:gpt-4o-mini", agentId: "exec" };
    const result =
      entryPoint === "resumeStream"
        ? await workspaceService.resumeStream("test-workspace", options)
        : await workspaceService.sendMessage("test-workspace", "hello", options);

    expect(result.success).toBe(false);
    if (!result.success && result.error.type === "unknown") {
      expect(result.error.raw).toContain("Interrupted task is still winding down");
    }
    expect(getAgentTaskStatus).toHaveBeenCalledWith("test-workspace");
    expect(markInterruptedTaskRunning).not.toHaveBeenCalled();
    expect(fakeSession.resumeStream).not.toHaveBeenCalled();
    expect(fakeSession.queueMessage).not.toHaveBeenCalled();
  });

  // Queued sends reset the auto-resume counter unless the send is a synthetic
  // auto-resume continuation that opted out.
  test.each([
    ["queued user messages reset auto-resume state", undefined, true],
    [
      "synthetic queued auto-resume messages preserve auto-resume state",
      { skipAutoResumeReset: true, synthetic: true, agentInitiated: true },
      false,
    ],
  ] as const)("%s", async (_name, internal, expectReset) => {
    fakeSession.isBusy.mockReturnValue(true);

    const resetAutoResumeCount = mock(() => undefined);
    workspaceService.setAgentTaskIntegration(
      makeAgentTaskIntegrationFake({ resetAutoResumeCount })
    );

    const result = await workspaceService.sendMessage(
      "test-workspace",
      "hello",
      { model: "openai:gpt-4o-mini", agentId: "exec" },
      internal
    );

    expect(result.success).toBe(true);
    expect(fakeSession.queueMessage).toHaveBeenCalled();
    if (expectReset) {
      expect(resetAutoResumeCount).toHaveBeenCalledWith("test-workspace");
    } else {
      expect(resetAutoResumeCount).not.toHaveBeenCalled();
    }
  });

  test("refuses to queue a send whose cancel signal already fired", async () => {
    fakeSession.isBusy.mockReturnValue(true);
    const controller = new AbortController();
    controller.abort("monitor withdrawn");
    const onCanceled = mock(() => undefined);
    const cancelState = { canceledBeforeAcceptance: false };

    const result = await workspaceService.sendMessage(
      "test-workspace",
      "wake",
      { model: "openai:gpt-4o-mini", agentId: "exec" },
      {
        synthetic: true,
        agentInitiated: true,
        cancelSignal: controller.signal,
        cancelState,
        onCanceled,
        queueDedupeKey: "bash-monitor-wake:test-workspace:1",
        removableQueueDedupeKey: true,
      }
    );

    expect(result.success).toBe(true);
    expect(fakeSession.queueMessage).not.toHaveBeenCalled();
    expect(onCanceled).toHaveBeenCalledTimes(1);
    expect(onCanceled).toHaveBeenCalledWith("monitor withdrawn");
    expect(cancelState.canceledBeforeAcceptance).toBe(true);
  });

  test("strips stale workspace-turn correlation behind an earlier queued entry", async () => {
    fakeSession.hasQueuedOrDispatchingEntry.mockReturnValue(true);
    const onCanceled = mock(() => undefined);
    const onAcceptedPreStreamFailure = mock(() => undefined);
    const muxMetadata = {
      type: "workspace-turn-task" as const,
      taskHandleId: "wst_stale_progress",
      ownerWorkspaceId: "owner-workspace",
      turnId: "turn-stale-progress",
    };

    const result = await workspaceService.sendMessage(
      "test-workspace",
      "nested progress",
      { model: "openai:gpt-4o-mini", agentId: "exec", muxMetadata },
      {
        synthetic: true,
        agentInitiated: true,
        workspaceTurnContinuation: true,
        onCanceled,
        onAcceptedPreStreamFailure,
      }
    );

    expect(result.success).toBe(true);
    expect(fakeSession.queueMessage).toHaveBeenCalledWith(
      "nested progress",
      expect.not.objectContaining({ muxMetadata }),
      expect.objectContaining({
        onCanceled: undefined,
        onAcceptedPreStreamFailure: undefined,
      })
    );
  });

  test("judges a promoted progress report's correlation against the entries it stays behind", async () => {
    fakeSession.hasQueuedOrDispatchingEntry.mockReturnValue(false);
    const onCanceled = mock(() => undefined);
    const muxMetadata = {
      type: "workspace-turn-task" as const,
      taskHandleId: "wst_promoted_progress",
      ownerWorkspaceId: "owner-workspace",
      turnId: "turn-promoted-progress",
    };

    const result = await workspaceService.sendMessage(
      "test-workspace",
      "nested progress",
      { model: "openai:gpt-4o-mini", agentId: "exec", muxMetadata },
      {
        synthetic: true,
        agentInitiated: true,
        workspaceTurnContinuation: true,
        queueDedupeKey: "agent-report:child:call-1",
        removableQueueDedupeKey: true,
        promoteAheadOfHiddenTurnEnd: true,
        onCanceled,
      }
    );

    expect(result.success).toBe(true);
    // The session excludes the hidden turn-end entries the promotion will overtake (e.g. a
    // queued heartbeat) when deciding whether a predecessor supersedes this continuation.
    expect(fakeSession.hasQueuedOrDispatchingEntry).toHaveBeenCalledWith(muxMetadata, {
      promoteAheadOfHiddenTurnEnd: true,
    });
    expect(fakeSession.queueMessage).toHaveBeenCalledWith(
      "nested progress",
      expect.objectContaining({ muxMetadata }),
      expect.objectContaining({ onCanceled, promoteAheadOfHiddenTurnEnd: true })
    );
  });

  test("keeps workspace-turn correlation for the next queued continuation", async () => {
    fakeSession.hasQueuedOrDispatchingEntry.mockReturnValue(false);
    const onCanceled = mock(() => undefined);
    const onAcceptedPreStreamFailure = mock(() => undefined);
    const muxMetadata = {
      type: "workspace-turn-task" as const,
      taskHandleId: "wst_next_progress",
      ownerWorkspaceId: "owner-workspace",
      turnId: "turn-next-progress",
    };

    const result = await workspaceService.sendMessage(
      "test-workspace",
      "nested progress",
      { model: "openai:gpt-4o-mini", agentId: "exec", muxMetadata },
      {
        synthetic: true,
        agentInitiated: true,
        workspaceTurnContinuation: true,
        onCanceled,
        onAcceptedPreStreamFailure,
      }
    );

    expect(result.success).toBe(true);
    expect(fakeSession.queueMessage).toHaveBeenCalledWith(
      "nested progress",
      expect.objectContaining({ muxMetadata }),
      expect.objectContaining({ onCanceled, onAcceptedPreStreamFailure })
    );
  });

  test("synthetic queued sends leave a pending interactive question intact", async () => {
    fakeSession.isBusy.mockReturnValue(true);

    const questionPromise = askUserQuestionManager.registerPending("test-workspace", "tool-q1", [
      {
        question: "Proceed?",
        header: "Next",
        options: [
          { label: "Yes", description: "Continue" },
          { label: "No", description: "Stop" },
        ],
        multiSelect: false,
      },
    ]);
    // Attach handler before cleanup cancel so Bun does not flag an unhandled rejection.
    const settled = questionPromise.catch((error: unknown) => error);

    try {
      const result = await workspaceService.sendMessage(
        "test-workspace",
        "[Heartbeat] scheduled check-in",
        { model: "openai:gpt-4o-mini", agentId: "exec", queueDispatchMode: "turn-end" },
        { synthetic: true, skipAutoResumeReset: true }
      );

      expect(result.success).toBe(true);
      expect(fakeSession.queueMessage).toHaveBeenCalled();
      // A backend-initiated maintenance send is not a user response: the prompt survives.
      expect(askUserQuestionManager.getLatestPending("test-workspace")?.toolCallId).toBe("tool-q1");
    } finally {
      askUserQuestionManager.cancel("test-workspace", "tool-q1", "test cleanup");
      await settled;
    }
  });

  // The heartbeat caller's queue-emptiness check happens before sendMessage's internal
  // awaits (pricing gate, settings persistence), so a user send can queue in that window.
  // yieldToQueuedMessages re-checks at the enqueue point: queued messages own the slot.
  test("yieldToQueuedMessages drops the send when messages queued during preparation", async () => {
    fakeSession.isBusy.mockReturnValue(true);
    fakeSession.hasQueuedMessages.mockReturnValue(true);

    const result = await workspaceService.sendMessage(
      "test-workspace",
      "[Heartbeat] scheduled check-in",
      { model: "openai:gpt-4o-mini", agentId: "exec", queueDispatchMode: "turn-end" },
      { synthetic: true, skipAutoResumeReset: true, yieldToQueuedMessages: true }
    );

    // Quiet success: the slot is consumed, but nothing is enqueued over the user's message.
    expect(result.success).toBe(true);
    expect(fakeSession.queueMessage).not.toHaveBeenCalled();
  });

  // The reverse race: a heartbeat queued first must not absorb a later real message —
  // MessageQueue batches texts under the first entry's muxMetadata, so input queued behind
  // a heartbeat would dispatch tagged as a heartbeat. New input supersedes the heartbeat.
  test("queued sends supersede a pending queued heartbeat before enqueueing", async () => {
    fakeSession.isBusy.mockReturnValue(true);
    fakeSession.dropQueuedMessageWithOnlyDedupeKey.mockReturnValue(true);

    const result = await workspaceService.sendMessage("test-workspace", "real user input", {
      model: "openai:gpt-4o-mini",
      agentId: "exec",
    });

    expect(result.success).toBe(true);
    expect(fakeSession.dropQueuedMessageWithOnlyDedupeKey).toHaveBeenCalledWith(
      "heartbeat-request"
    );
    // The user message still queues normally after the heartbeat is dropped.
    expect(fakeSession.queueMessage).toHaveBeenCalled();
  });

  test("a queued heartbeat send does not supersede itself", async () => {
    fakeSession.isBusy.mockReturnValue(true);

    const result = await workspaceService.sendMessage(
      "test-workspace",
      "[Heartbeat] scheduled check-in",
      { model: "openai:gpt-4o-mini", agentId: "exec", queueDispatchMode: "turn-end" },
      {
        synthetic: true,
        skipAutoResumeReset: true,
        queueDedupeKey: "heartbeat-request",
        yieldToQueuedMessages: true,
      }
    );

    expect(result.success).toBe(true);
    expect(fakeSession.dropQueuedMessageWithOnlyDedupeKey).not.toHaveBeenCalled();
  });

  test("yieldToQueuedMessages still queues into an empty queue", async () => {
    fakeSession.isBusy.mockReturnValue(true);
    fakeSession.hasQueuedMessages.mockReturnValue(false);

    const result = await workspaceService.sendMessage(
      "test-workspace",
      "[Heartbeat] scheduled check-in",
      { model: "openai:gpt-4o-mini", agentId: "exec", queueDispatchMode: "turn-end" },
      { synthetic: true, skipAutoResumeReset: true, yieldToQueuedMessages: true }
    );

    expect(result.success).toBe(true);
    expect(fakeSession.queueMessage).toHaveBeenCalled();
  });

  test("non-synthetic queued sends cancel a pending interactive question", async () => {
    fakeSession.isBusy.mockReturnValue(true);

    const questionPromise = askUserQuestionManager.registerPending("test-workspace", "tool-q1", [
      {
        question: "Proceed?",
        header: "Next",
        options: [
          { label: "Yes", description: "Continue" },
          { label: "No", description: "Stop" },
        ],
        multiSelect: false,
      },
    ]);
    // Attach handler before the send cancels the question, avoiding an unhandled rejection.
    const settled = questionPromise.catch((error: unknown) => error);

    const result = await workspaceService.sendMessage("test-workspace", "hello", {
      model: "openai:gpt-4o-mini",
      agentId: "exec",
    });

    expect(result.success).toBe(true);
    expect(fakeSession.queueMessage).toHaveBeenCalled();
    // A real user message supersedes the question: it is canceled before queueing.
    expect(askUserQuestionManager.getLatestPending("test-workspace")).toBeNull();
    expect(await settled).toBeInstanceOf(Error);
  });

  // The sticky case: incoming mode is turn-end but the queue's effective mode is
  // tool-end from a prior enqueue, so the wait still backgrounds.
  test.each([
    [
      "backgrounds foreground task waits when queuing a tool-end message",
      "tool-end",
      "hello",
      undefined,
      true,
    ],
    [
      "does not background foreground task waits when queuing a turn-end message",
      "turn-end",
      "hello",
      "turn-end",
      false,
    ],
    [
      "does not background foreground task waits when queueMessage enqueues nothing",
      null,
      "   ",
      undefined,
      false,
    ],
    [
      "backgrounds foreground task waits when effective queue mode is tool-end despite incoming turn-end",
      "tool-end",
      "hello",
      "turn-end",
      true,
    ],
  ] as const)(
    "%s",
    async (_name, effectiveQueueMode, message, queueDispatchMode, expectBackgrounded) => {
      fakeSession.isBusy.mockReturnValue(true);
      fakeSession.queueMessage.mockReturnValue(effectiveQueueMode);

      const backgroundForegroundWaitsForWorkspace = mock(() => 0);
      workspaceService.setAgentTaskIntegration(
        makeAgentTaskIntegrationFake({ backgroundForegroundWaitsForWorkspace })
      );

      const result = await workspaceService.sendMessage("test-workspace", message, {
        model: "openai:gpt-4o-mini",
        agentId: "exec",
        queueDispatchMode,
      });

      expect(result.success).toBe(true);
      if (expectBackgrounded) {
        expect(backgroundForegroundWaitsForWorkspace).toHaveBeenCalledWith("test-workspace");
      } else {
        expect(backgroundForegroundWaitsForWorkspace).not.toHaveBeenCalled();
      }
    }
  );

  test("registerSession clears persisted agent status for accepted user chat events", () => {
    const updateAgentStatus = spyOn(
      workspaceService as unknown as {
        updateAgentStatus: (workspaceId: string, status: null) => Promise<void>;
      },
      "updateAgentStatus"
    ).mockResolvedValue(undefined);

    const workspaceId = "listener-workspace";
    const sessionEmitter = new EventEmitter();
    const listenerSession = {
      onChatEvent: (listener: (event: unknown) => void) => {
        sessionEmitter.on("chat-event", listener);
        return () => sessionEmitter.off("chat-event", listener);
      },
      onMetadataEvent: (listener: (event: unknown) => void) => {
        sessionEmitter.on("metadata-event", listener);
        return () => sessionEmitter.off("metadata-event", listener);
      },
      // eslint-disable-next-line @typescript-eslint/no-empty-function
      dispose: () => {},
    } as unknown as AgentSession;

    workspaceService.registerSession(workspaceId, listenerSession);

    sessionEmitter.emit("chat-event", {
      workspaceId,
      message: {
        type: "message",
        ...createMuxMessage("user-accepted", "user", "hello"),
      },
    });

    expect(updateAgentStatus).toHaveBeenCalledWith(workspaceId, null);
  });

  test("registerSession does not clear persisted agent status for synthetic user chat events", () => {
    const updateAgentStatus = spyOn(
      workspaceService as unknown as {
        updateAgentStatus: (workspaceId: string, status: null) => Promise<void>;
      },
      "updateAgentStatus"
    ).mockResolvedValue(undefined);

    const workspaceId = "synthetic-listener-workspace";
    const sessionEmitter = new EventEmitter();
    const listenerSession = {
      onChatEvent: (listener: (event: unknown) => void) => {
        sessionEmitter.on("chat-event", listener);
        return () => sessionEmitter.off("chat-event", listener);
      },
      onMetadataEvent: (listener: (event: unknown) => void) => {
        sessionEmitter.on("metadata-event", listener);
        return () => sessionEmitter.off("metadata-event", listener);
      },
      // eslint-disable-next-line @typescript-eslint/no-empty-function
      dispose: () => {},
    } as unknown as AgentSession;

    workspaceService.registerSession(workspaceId, listenerSession);

    sessionEmitter.emit("chat-event", {
      workspaceId,
      message: {
        type: "message",
        ...createMuxMessage("user-synthetic", "user", "hello", { synthetic: true }),
      },
    });

    expect(updateAgentStatus).not.toHaveBeenCalled();
  });
});

describe("WorkspaceService pending auto-title", () => {
  let workspaceService: WorkspaceService;
  let historyService: HistoryService;
  let cleanupHistory: () => Promise<void>;
  let config: Config;
  let tempDir: string;
  let workspaceId: string;
  let projectPath: string;
  let workspacePath: string;
  let fakeSession: {
    isBusy: ReturnType<typeof mock>;
    hasQueuedMessages: ReturnType<typeof mock>;
    hasQueuedOrDispatchingEntry: ReturnType<typeof mock>;
    dropQueuedMessageWithOnlyDedupeKey: ReturnType<typeof mock>;
    queueMessage: ReturnType<typeof mock>;
    sendMessage: ReturnType<typeof mock>;
    resumeStream: ReturnType<typeof mock>;
  };

  beforeEach(async () => {
    ({
      config,
      tempDir,
      historyService,
      cleanup: cleanupHistory,
    } = await createTestHistoryService());

    workspaceId = "pending-auto-title-workspace";
    projectPath = path.join(tempDir, "project");
    workspacePath = path.join(projectPath, "fork-branch");
    await fsPromises.mkdir(projectPath, { recursive: true });
    await config.addWorkspace(projectPath, {
      id: workspaceId,
      name: "fork-branch",
      title: "Parent title (1)",
      pendingAutoTitle: true,
      projectName: "project",
      projectPath,
      createdAt: new Date().toISOString(),
      runtimeConfig: { type: "local" },
      namedWorkspacePath: workspacePath,
    });

    const metadata: FrontendWorkspaceMetadata = {
      id: workspaceId,
      name: "fork-branch",
      title: "Parent title (1)",
      pendingAutoTitle: true,
      projectName: "project",
      projectPath,
      createdAt: new Date().toISOString(),
      runtimeConfig: { type: "local" },
      namedWorkspacePath: workspacePath,
    };
    const aiService: AIService = {
      ...createStreamLifecycleMocks(),
      isStreaming: mock(() => false),
      getWorkspaceMetadata: mock(() => Promise.resolve(Ok(metadata))),
      // eslint-disable-next-line @typescript-eslint/no-empty-function
      on: mock(() => {}),
      // eslint-disable-next-line @typescript-eslint/no-empty-function
      off: mock(() => {}),
    } as unknown as AIService;

    const mockExtensionMetadata: Partial<ExtensionMetadataService> = {
      updateRecency: mock(() =>
        Promise.resolve({
          recency: Date.now(),
          streaming: false,
          lastModel: null,
          lastThinkingLevel: null,
          agentStatus: null,
        })
      ),
      setStreaming: mock(() =>
        Promise.resolve({
          recency: Date.now(),
          streaming: false,
          lastModel: null,
          lastThinkingLevel: null,
          agentStatus: null,
        })
      ),
    };

    workspaceService = new WorkspaceService(
      withExistingConfigLoader(config),
      historyService,
      aiService,
      mockInitStateManager as InitStateManager,
      mockExtensionMetadata as ExtensionMetadataService,
      mockBackgroundProcessManager as BackgroundProcessManager
    );

    fakeSession = {
      isBusy: mock(() => false),
      hasQueuedMessages: mock(() => false),
      hasQueuedOrDispatchingEntry: mock(() => false),
      dropQueuedMessageWithOnlyDedupeKey: mock(() => false),
      queueMessage: mock(() => "tool-end" as const),
      sendMessage: mock(() => Promise.resolve(Ok(undefined))),
      resumeStream: mock(() => Promise.resolve(Ok({ started: true }))),
    };

    (
      workspaceService as unknown as {
        getOrCreateSession: (workspaceId: string) => AgentSession;
      }
    ).getOrCreateSession = mock(() => fakeSession as unknown as AgentSession);

    (
      workspaceService as unknown as {
        maybePersistAISettingsFromOptions: (workspaceId: string, options: unknown) => Promise<void>;
      }
    ).maybePersistAISettingsFromOptions = mock(() => Promise.resolve());
  });

  afterEach(async () => {
    await cleanupHistory();
  });

  test("sendMessage triggers fork auto-title after the first accepted continue message", async () => {
    const autoTitleSpy = spyOn(
      workspaceService as unknown as {
        maybeRunPendingAutoTitleFromMessage: (
          workspaceId: string,
          message: string
        ) => Promise<void>;
      },
      "maybeRunPendingAutoTitleFromMessage"
    ).mockResolvedValue(undefined);

    const result = await workspaceService.sendMessage(workspaceId, "Continue with auth hardening", {
      model: "openai:gpt-4o-mini",
      agentId: "exec",
    });

    expect(result.success).toBe(true);
    expect(autoTitleSpy).toHaveBeenCalledWith(workspaceId, "Continue with auth hardening");
  });

  test("concurrent sends only claim one pending auto-title generation", async () => {
    const releaseSend = createDeferred<Result<void, SendMessageError>>();
    fakeSession.sendMessage.mockImplementation(() => releaseSend.promise);
    const autoTitleSpy = spyOn(
      workspaceService as unknown as {
        maybeRunPendingAutoTitleFromMessage: (
          workspaceId: string,
          message: string
        ) => Promise<void>;
      },
      "maybeRunPendingAutoTitleFromMessage"
    ).mockResolvedValue(undefined);

    try {
      const firstSend = workspaceService.sendMessage(workspaceId, "First continue message", {
        model: "openai:gpt-4o-mini",
        agentId: "exec",
      });
      const secondSend = workspaceService.sendMessage(workspaceId, "Second continue message", {
        model: "openai:gpt-4o-mini",
        agentId: "exec",
      });

      releaseSend.resolve(Ok(undefined));
      const [firstResult, secondResult] = await Promise.all([firstSend, secondSend]);

      expect(firstResult.success).toBe(true);
      expect(secondResult.success).toBe(true);
      expect(autoTitleSpy).toHaveBeenCalledTimes(1);
      expect(autoTitleSpy).toHaveBeenCalledWith(workspaceId, "First continue message");
    } finally {
      autoTitleSpy.mockRestore();
    }
  });

  test("sendMessage only launches one pending auto-title generation at a time", async () => {
    const generationStarted = createDeferred<void>();
    const releaseGeneration = createDeferred<void>();
    const autoTitleSpy = spyOn(
      workspaceService as unknown as {
        maybeRunPendingAutoTitleFromMessage: (
          workspaceId: string,
          message: string
        ) => Promise<void>;
      },
      "maybeRunPendingAutoTitleFromMessage"
    ).mockImplementation(async () => {
      generationStarted.resolve();
      await releaseGeneration.promise;
    });

    try {
      const firstResult = await workspaceService.sendMessage(
        workspaceId,
        "First continue message",
        {
          model: "openai:gpt-4o-mini",
          agentId: "exec",
        }
      );
      expect(firstResult.success).toBe(true);
      await generationStarted.promise;

      const secondResult = await workspaceService.sendMessage(
        workspaceId,
        "Second continue message",
        {
          model: "openai:gpt-4o-mini",
          agentId: "exec",
        }
      );
      expect(secondResult.success).toBe(true);
      expect(autoTitleSpy).toHaveBeenCalledTimes(1);

      releaseGeneration.resolve();
      await Promise.resolve();
    } finally {
      autoTitleSpy.mockRestore();
    }
  });

  test("completing a pending auto-title replaces the fallback title and clears the state", async () => {
    const generateIdentitySpy = spyOn(
      workspaceTitleGenerator,
      "generateWorkspaceIdentity"
    ).mockResolvedValue(
      Ok({
        name: "auth-hardening-a1b2",
        title: "Harden auth flow",
        modelUsed: "openai:gpt-4o-mini",
      })
    );

    try {
      await (
        workspaceService as unknown as {
          maybeRunPendingAutoTitleFromMessage: (
            workspaceId: string,
            message: string
          ) => Promise<void>;
        }
      ).maybeRunPendingAutoTitleFromMessage(workspaceId, "Continue with auth hardening");

      const metadata = (await config.getAllWorkspaceMetadata()).find(
        (entry) => entry.id === workspaceId
      );
      expect(metadata?.title).toBe("Harden auth flow");
      expect(metadata?.pendingAutoTitle).toBeUndefined();
      expect(generateIdentitySpy.mock.calls[0]?.[0]).toBe("Continue with auth hardening");
    } finally {
      generateIdentitySpy.mockRestore();
    }
  });

  test("manual title edits cancel an in-flight auto-title before it can overwrite the title", async () => {
    const generationStarted = createDeferred<void>();
    const autoTitleResult =
      createDeferred<
        Awaited<ReturnType<typeof workspaceTitleGenerator.generateWorkspaceIdentity>>
      >();
    const generateIdentitySpy = spyOn(
      workspaceTitleGenerator,
      "generateWorkspaceIdentity"
    ).mockImplementation((_message, _candidates, _aiService) => {
      generationStarted.resolve();
      return autoTitleResult.promise;
    });

    try {
      const autoTitlePromise = (
        workspaceService as unknown as {
          maybeRunPendingAutoTitleFromMessage: (
            workspaceId: string,
            message: string
          ) => Promise<void>;
        }
      ).maybeRunPendingAutoTitleFromMessage(workspaceId, "Continue with auth hardening");

      await generationStarted.promise;

      const updateTitleResult = await workspaceService.updateTitle(workspaceId, "Manual title");
      expect(updateTitleResult.success).toBe(true);

      autoTitleResult.resolve(
        Ok({
          name: "auth-hardening-a1b2",
          title: "Harden auth flow",
          modelUsed: "openai:gpt-4o-mini",
        })
      );
      await autoTitlePromise;

      const metadata = (await config.getAllWorkspaceMetadata()).find(
        (entry) => entry.id === workspaceId
      );
      expect(metadata?.title).toBe("Manual title");
      expect(metadata?.pendingAutoTitle).toBeUndefined();
    } finally {
      generateIdentitySpy.mockRestore();
    }
  });
});

describe("WorkspaceService idle compaction dispatch", () => {
  let workspaceService: WorkspaceService;
  let historyService: HistoryService;
  let cleanupHistory: () => Promise<void>;

  beforeEach(async () => {
    const aiService: AIService = {
      ...createStreamLifecycleMocks(),
      isStreaming: mock(() => false),
      getWorkspaceMetadata: mock(() =>
        Promise.resolve({ success: false as const, error: "not found" })
      ),
      // eslint-disable-next-line @typescript-eslint/no-empty-function
      on: mock(() => {}),
      // eslint-disable-next-line @typescript-eslint/no-empty-function
      off: mock(() => {}),
    } as unknown as AIService;

    ({ historyService, cleanup: cleanupHistory } = await createTestHistoryService());

    const mockConfig: MockWorkspaceConfig = {
      srcDir: "/tmp/test",
      sessionsDir: "/tmp/test/sessions",
      generateStableId: mock(() => "test-id"),
      findWorkspace: mock(() => null),
    };

    workspaceService = createWorkspaceServiceForTest({
      config: mockConfig,
      historyService,
      aiService,
      initStateManager: mockInitStateManager as InitStateManager,
    });
  });

  afterEach(async () => {
    await cleanupHistory();
  });

  test("marks idle compaction send as synthetic when stream stays active", async () => {
    const workspaceId = "idle-ws";
    const sendMessage = mock(() => Promise.resolve(Ok(undefined)));
    const buildIdleCompactionSendOptions = mock(() =>
      Promise.resolve({ model: "openai:gpt-4o", agentId: "compact" })
    );

    let busyChecks = 0;
    const session = {
      isBusy: mock(() => {
        busyChecks += 1;
        return busyChecks >= 2;
      }),
    } as unknown as AgentSession;

    (
      workspaceService as unknown as {
        sendMessage: typeof sendMessage;
        buildIdleCompactionSendOptions: typeof buildIdleCompactionSendOptions;
        getOrCreateSession: (workspaceId: string) => AgentSession;
      }
    ).sendMessage = sendMessage;
    (
      workspaceService as unknown as {
        sendMessage: typeof sendMessage;
        buildIdleCompactionSendOptions: typeof buildIdleCompactionSendOptions;
        getOrCreateSession: (workspaceId: string) => AgentSession;
      }
    ).buildIdleCompactionSendOptions = buildIdleCompactionSendOptions;
    (
      workspaceService as unknown as {
        sendMessage: typeof sendMessage;
        buildIdleCompactionSendOptions: typeof buildIdleCompactionSendOptions;
        getOrCreateSession: (workspaceId: string) => AgentSession;
      }
    ).getOrCreateSession = (_workspaceId: string) => session;

    await workspaceService.executeIdleCompaction(workspaceId);

    expect(sendMessage).toHaveBeenCalledTimes(1);
    expect(sendMessage).toHaveBeenCalledWith(
      workspaceId,
      expect.any(String),
      expect.any(Object),
      expect.objectContaining({
        skipAutoResumeReset: true,
        synthetic: true,
        requireIdle: true,
      })
    );

    const idleCompactingWorkspaces = (
      workspaceService as unknown as { idleCompactingWorkspaces: Set<string> }
    ).idleCompactingWorkspaces;
    expect(idleCompactingWorkspaces.has(workspaceId)).toBe(true);
  });

  test("does not mark idle compaction when send succeeds without active stream", async () => {
    const workspaceId = "idle-no-stream-ws";
    const sendMessage = mock(() => Promise.resolve(Ok(undefined)));
    const buildIdleCompactionSendOptions = mock(() =>
      Promise.resolve({ model: "openai:gpt-4o", agentId: "compact" })
    );

    const session = {
      isBusy: mock(() => false),
    } as unknown as AgentSession;

    (
      workspaceService as unknown as {
        sendMessage: typeof sendMessage;
        buildIdleCompactionSendOptions: typeof buildIdleCompactionSendOptions;
        getOrCreateSession: (workspaceId: string) => AgentSession;
      }
    ).sendMessage = sendMessage;
    (
      workspaceService as unknown as {
        sendMessage: typeof sendMessage;
        buildIdleCompactionSendOptions: typeof buildIdleCompactionSendOptions;
        getOrCreateSession: (workspaceId: string) => AgentSession;
      }
    ).buildIdleCompactionSendOptions = buildIdleCompactionSendOptions;
    (
      workspaceService as unknown as {
        sendMessage: typeof sendMessage;
        buildIdleCompactionSendOptions: typeof buildIdleCompactionSendOptions;
        getOrCreateSession: (workspaceId: string) => AgentSession;
      }
    ).getOrCreateSession = (_workspaceId: string) => session;

    await workspaceService.executeIdleCompaction(workspaceId);

    const idleCompactingWorkspaces = (
      workspaceService as unknown as { idleCompactingWorkspaces: Set<string> }
    ).idleCompactingWorkspaces;
    expect(idleCompactingWorkspaces.has(workspaceId)).toBe(false);
  });

  test("propagates busy-skip errors", async () => {
    const workspaceId = "idle-busy-ws";
    const sendMessage = mock(() =>
      Promise.resolve(
        Err({
          type: "unknown" as const,
          raw: "Workspace is busy; idle-only send was skipped.",
        })
      )
    );
    const buildIdleCompactionSendOptions = mock(() =>
      Promise.resolve({ model: "openai:gpt-4o", agentId: "compact" })
    );

    (
      workspaceService as unknown as {
        sendMessage: typeof sendMessage;
        buildIdleCompactionSendOptions: typeof buildIdleCompactionSendOptions;
      }
    ).sendMessage = sendMessage;
    (
      workspaceService as unknown as {
        sendMessage: typeof sendMessage;
        buildIdleCompactionSendOptions: typeof buildIdleCompactionSendOptions;
      }
    ).buildIdleCompactionSendOptions = buildIdleCompactionSendOptions;

    // The busy-skip is an expected race, so it must not be reported as a failure
    // (otherwise two normal user-interaction races would suppress idle compaction).
    const outcomes: Array<{ workspaceId: string; outcome: IdleCompactionOutcome }> = [];
    workspaceService.setIdleCompactionOutcomeListener((id, outcome) =>
      outcomes.push({ workspaceId: id, outcome })
    );

    let executionError: unknown;
    try {
      await workspaceService.executeIdleCompaction(workspaceId);
    } catch (error) {
      executionError = error;
    }

    expect(executionError).toBeInstanceOf(Error);
    if (!(executionError instanceof Error)) {
      throw new Error("Expected idle compaction to throw when workspace is busy");
    }
    expect(executionError.message).toContain("idle-only send was skipped");
    expect(outcomes).toEqual([]);
  });

  test("reports a model_not_found outcome when the compaction model is invalid", async () => {
    const workspaceId = "idle-model-not-found-ws";
    const sendMessage = mock(() =>
      Promise.resolve(
        Err({
          type: "invalid_model_string" as const,
          message: "Invalid model string: openai:does-not-exist",
        })
      )
    );
    const buildIdleCompactionSendOptions = mock(() =>
      Promise.resolve({ model: "openai:does-not-exist", agentId: "compact" })
    );
    const session = { isBusy: mock(() => false) } as unknown as AgentSession;

    (
      workspaceService as unknown as {
        sendMessage: typeof sendMessage;
        buildIdleCompactionSendOptions: typeof buildIdleCompactionSendOptions;
        getOrCreateSession: (workspaceId: string) => AgentSession;
      }
    ).sendMessage = sendMessage;
    (
      workspaceService as unknown as {
        buildIdleCompactionSendOptions: typeof buildIdleCompactionSendOptions;
      }
    ).buildIdleCompactionSendOptions = buildIdleCompactionSendOptions;
    (
      workspaceService as unknown as {
        getOrCreateSession: (workspaceId: string) => AgentSession;
      }
    ).getOrCreateSession = () => session;

    const outcomes: Array<{ workspaceId: string; outcome: IdleCompactionOutcome }> = [];
    workspaceService.setIdleCompactionOutcomeListener((id, outcome) =>
      outcomes.push({ workspaceId: id, outcome })
    );

    let threw = false;
    try {
      await workspaceService.executeIdleCompaction(workspaceId);
    } catch {
      threw = true;
    }

    expect(threw).toBe(true);
    expect(outcomes).toEqual([{ workspaceId, outcome: { success: false, modelNotFound: true } }]);
  });

  test("reports a non-model_not_found outcome for generic pre-stream failures", async () => {
    const workspaceId = "idle-generic-failure-ws";
    const sendMessage = mock(() => Promise.resolve(Err({ type: "unknown" as const, raw: "boom" })));
    const buildIdleCompactionSendOptions = mock(() =>
      Promise.resolve({ model: "openai:gpt-4o", agentId: "compact" })
    );
    const session = { isBusy: mock(() => false) } as unknown as AgentSession;

    (
      workspaceService as unknown as {
        sendMessage: typeof sendMessage;
        buildIdleCompactionSendOptions: typeof buildIdleCompactionSendOptions;
        getOrCreateSession: (workspaceId: string) => AgentSession;
      }
    ).sendMessage = sendMessage;
    (
      workspaceService as unknown as {
        buildIdleCompactionSendOptions: typeof buildIdleCompactionSendOptions;
      }
    ).buildIdleCompactionSendOptions = buildIdleCompactionSendOptions;
    (
      workspaceService as unknown as {
        getOrCreateSession: (workspaceId: string) => AgentSession;
      }
    ).getOrCreateSession = () => session;

    const outcomes: Array<{ workspaceId: string; outcome: IdleCompactionOutcome }> = [];
    workspaceService.setIdleCompactionOutcomeListener((id, outcome) =>
      outcomes.push({ workspaceId: id, outcome })
    );

    let threw = false;
    try {
      await workspaceService.executeIdleCompaction(workspaceId);
    } catch {
      threw = true;
    }

    expect(threw).toBe(true);
    expect(outcomes).toEqual([{ workspaceId, outcome: { success: false, modelNotFound: false } }]);
  });

  test("prefers global compact thinking default over exec and activity fallbacks", async () => {
    const projectPath = "/tmp/project";
    const workspacePath = "/tmp/project/ws";

    type ThinkingLevel = Parameters<typeof enforceThinkingPolicy>[1];

    interface WorkspaceServiceIdleCompactionAccess {
      buildIdleCompactionSendOptions: (workspaceId: string) => Promise<{
        model: string;
        thinkingLevel: ThinkingLevel;
      }>;
      config: {
        findWorkspace: (
          workspaceId: string
        ) => { projectPath: string; workspacePath: string } | null;
        loadConfigOrDefault: () => {
          projects: Map<string, { workspaces: Array<Record<string, unknown>> }>;
          agentAiDefaults?: {
            compact?: {
              thinkingLevel?: ThinkingLevel;
            };
          };
        };
      };
      extensionMetadata: ExtensionMetadataService;
    }

    const svc = workspaceService as unknown as WorkspaceServiceIdleCompactionAccess;

    svc.config.findWorkspace = mock((workspaceId: string) =>
      workspaceId === "ws" ? { projectPath, workspacePath } : null
    );
    svc.config.loadConfigOrDefault = mock(() => ({
      projects: new Map([
        [
          projectPath,
          {
            workspaces: [
              {
                id: "ws",
                path: workspacePath,
                name: "ws",
                aiSettingsByAgent: {
                  exec: { model: "openai:gpt-4o-mini", thinkingLevel: "low" },
                },
              },
            ],
          },
        ],
      ]),
      agentAiDefaults: {
        compact: { thinkingLevel: "high" as ThinkingLevel },
      },
    }));

    svc.extensionMetadata = {
      getSnapshot: mock(() => Promise.resolve({ lastThinkingLevel: "off" })),
    } as unknown as ExtensionMetadataService;

    const options = await svc.buildIdleCompactionSendOptions("ws");

    expect(options.thinkingLevel).toBe(enforceThinkingPolicy(options.model, "high"));
  });

  test("does not tag streaming=true snapshots as idle compaction", async () => {
    const workspaceId = "idle-streaming-true-no-tag";
    const snapshot = {
      recency: Date.now(),
      streaming: true,
      lastModel: "claude-sonnet-4",
      lastThinkingLevel: null,
    };

    const setStreaming = mock(() => Promise.resolve(snapshot));
    const emitWorkspaceActivity = mock(
      (_workspaceId: string, _snapshot: typeof snapshot) => undefined
    );

    (
      workspaceService as unknown as {
        extensionMetadata: ExtensionMetadataService;
        emitWorkspaceActivity: typeof emitWorkspaceActivity;
      }
    ).extensionMetadata = {
      setStreaming,
    } as unknown as ExtensionMetadataService;
    (
      workspaceService as unknown as {
        extensionMetadata: ExtensionMetadataService;
        emitWorkspaceActivity: typeof emitWorkspaceActivity;
      }
    ).emitWorkspaceActivity = emitWorkspaceActivity;

    const internals = workspaceService as unknown as {
      idleCompactingWorkspaces: Set<string>;
      updateStreamingStatus: (
        workspaceId: string,
        streaming: boolean,
        options?: ExtensionMetadataStreamingUpdate
      ) => Promise<void>;
    };

    internals.idleCompactingWorkspaces.add(workspaceId);

    await internals.updateStreamingStatus(workspaceId, true);

    expect(setStreaming).toHaveBeenCalledWith(workspaceId, true, {});
    expect(emitWorkspaceActivity).toHaveBeenCalledTimes(1);
    expect(emitWorkspaceActivity).toHaveBeenCalledWith(workspaceId, snapshot);
    expect(internals.idleCompactingWorkspaces.has(workspaceId)).toBe(true);
  });

  test("passes through stream-start thinkingLevel without re-deriving it from config", async () => {
    const workspaceId = "streaming-thinking-level";
    const snapshot = {
      recency: Date.now(),
      streaming: true,
      lastModel: "claude-sonnet-4",
      lastThinkingLevel: "high" as const,
    };

    const setStreaming = mock(() => Promise.resolve(snapshot));
    const emitWorkspaceActivity = mock(
      (_workspaceId: string, _snapshot: typeof snapshot) => undefined
    );

    (
      workspaceService as unknown as {
        extensionMetadata: ExtensionMetadataService;
        emitWorkspaceActivity: typeof emitWorkspaceActivity;
      }
    ).extensionMetadata = {
      setStreaming,
    } as unknown as ExtensionMetadataService;
    (
      workspaceService as unknown as {
        extensionMetadata: ExtensionMetadataService;
        emitWorkspaceActivity: typeof emitWorkspaceActivity;
      }
    ).emitWorkspaceActivity = emitWorkspaceActivity;

    const internals = workspaceService as unknown as {
      updateStreamingStatus: (
        workspaceId: string,
        streaming: boolean,
        options?: ExtensionMetadataStreamingUpdate
      ) => Promise<void>;
    };

    await internals.updateStreamingStatus(workspaceId, true, {
      model: "claude-sonnet-4",
      thinkingLevel: "high",
    });

    expect(setStreaming).toHaveBeenCalledWith(workspaceId, true, {
      model: "claude-sonnet-4",
      thinkingLevel: "high",
    });
    expect(emitWorkspaceActivity).toHaveBeenCalledWith(workspaceId, snapshot);
  });

  test("clears idle marker when streaming=false metadata update fails", async () => {
    const workspaceId = "idle-streaming-false-failure";

    const setStreaming = mock(() => Promise.reject(new Error("setStreaming failed")));
    const extensionMetadata = {
      setStreaming,
    } as unknown as ExtensionMetadataService;

    (
      workspaceService as unknown as {
        extensionMetadata: ExtensionMetadataService;
      }
    ).extensionMetadata = extensionMetadata;

    const internals = workspaceService as unknown as {
      idleCompactingWorkspaces: Set<string>;
      updateStreamingStatus: (
        workspaceId: string,
        streaming: boolean,
        options?: ExtensionMetadataStreamingUpdate
      ) => Promise<void>;
    };

    internals.idleCompactingWorkspaces.add(workspaceId);

    await internals.updateStreamingStatus(workspaceId, false);

    expect(internals.idleCompactingWorkspaces.has(workspaceId)).toBe(false);
    // todoStatus is intentionally NOT passed when there are no todos —
    // passing null would delete an AgentStatusService-written AI summary
    // from the same slot. Explicit clears happen via setTodoStatus.
    expect(setStreaming).toHaveBeenCalledWith(workspaceId, false, {
      hasTodos: false,
    });
  });

  test("stream-stop with no todos does NOT clear todoStatus (preserves AI summary)", async () => {
    // Codex: AgentStatusService writes its AI-generated summary into the
    // same `todoStatus` slot that `setTodoStatus` uses. The stream-stop
    // path used to read an empty todo list and pass `todoStatus: null`,
    // which deleted the slot — wiping a summary that was just generated
    // during the stream. Free-form chats (no todos) hit this every turn.
    const workspaceId = "stream-stop-preserves-ai-status";
    const snapshot = {
      recency: Date.now(),
      streaming: false,
      lastModel: "claude-sonnet-4",
      lastThinkingLevel: null,
    };
    const setStreaming = mock(() => Promise.resolve(snapshot));
    const emitWorkspaceActivity = mock(
      (_workspaceId: string, _snapshot: typeof snapshot) => undefined
    );

    (
      workspaceService as unknown as {
        extensionMetadata: ExtensionMetadataService;
        emitWorkspaceActivity: typeof emitWorkspaceActivity;
      }
    ).extensionMetadata = { setStreaming } as unknown as ExtensionMetadataService;
    (
      workspaceService as unknown as {
        extensionMetadata: ExtensionMetadataService;
        emitWorkspaceActivity: typeof emitWorkspaceActivity;
      }
    ).emitWorkspaceActivity = emitWorkspaceActivity;

    const internals = workspaceService as unknown as {
      updateStreamingStatus: (
        workspaceId: string,
        streaming: boolean,
        options?: ExtensionMetadataStreamingUpdate
      ) => Promise<void>;
    };

    await internals.updateStreamingStatus(workspaceId, false);

    // The setStreaming call must omit `todoStatus` entirely. If it included
    // `todoStatus: null`, ExtensionMetadataService.setStreaming would delete
    // the slot (see the `update.todoStatus !== undefined` branch there).
    expect(setStreaming).toHaveBeenCalledTimes(1);
    expect(setStreaming).toHaveBeenCalledWith(workspaceId, false, { hasTodos: false });
    // Defensive double-check that the assertion is strict — toHaveBeenCalledWith
    // with an object literal in some matchers tolerates extra fields. Use
    // `not` against an explicit `todoStatus: null` payload to lock the
    // contract.
    expect(setStreaming).not.toHaveBeenCalledWith(workspaceId, false, {
      hasTodos: false,
      todoStatus: null,
    });
  });
});

describe("WorkspaceService streaming generation guard", () => {
  let workspaceService: WorkspaceService;
  let historyService: HistoryService;
  let cleanupHistory: () => Promise<void>;
  let readTodosSpy:
    | ReturnType<typeof spyOn<typeof todoStorageModule, "readTodosForSessionDir">>
    | undefined;

  beforeEach(async () => {
    const aiService: AIService = {
      ...createStreamLifecycleMocks(),
      isStreaming: mock(() => false),
      getWorkspaceMetadata: mock(() =>
        Promise.resolve({ success: false as const, error: "not found" })
      ),
      // eslint-disable-next-line @typescript-eslint/no-empty-function
      on: mock(() => {}),
      // eslint-disable-next-line @typescript-eslint/no-empty-function
      off: mock(() => {}),
    } as unknown as AIService;

    ({ historyService, cleanup: cleanupHistory } = await createTestHistoryService());

    const mockConfig: MockWorkspaceConfig = {
      srcDir: "/tmp/test",
      sessionsDir: "/tmp/test/sessions",
      generateStableId: mock(() => "test-id"),
      findWorkspace: mock(() => null),
    };

    workspaceService = createWorkspaceServiceForTest({
      config: mockConfig,
      historyService,
      aiService,
      initStateManager: mockInitStateManager as InitStateManager,
    });
  });

  afterEach(async () => {
    readTodosSpy?.mockRestore();
    await cleanupHistory();
  });

  test("stop-side metadata write is skipped when a newer stream has started", async () => {
    const workspaceId = "ws-generation-guard";
    const todoReadDeferred =
      createDeferred<Awaited<ReturnType<typeof todoStorageModule.readTodosForSessionDir>>>();
    let todoReadCalls = 0;
    const setStreaming = mock(
      (_workspaceId: string, streaming: boolean, update: ExtensionMetadataStreamingUpdate = {}) =>
        Promise.resolve({
          recency: Date.now(),
          streaming,
          lastModel: update.model ?? null,
          lastThinkingLevel: update.thinkingLevel ?? null,
          hasTodos: update.hasTodos,
          agentStatus: null,
        })
    );

    readTodosSpy = spyOn(todoStorageModule, "readTodosForSessionDir").mockImplementation(() => {
      todoReadCalls += 1;
      if (todoReadCalls === 1) {
        return todoReadDeferred.promise;
      }
      return Promise.resolve([]);
    });

    (
      workspaceService as unknown as {
        extensionMetadata: ExtensionMetadataService;
      }
    ).extensionMetadata = {
      setStreaming,
    } as unknown as ExtensionMetadataService;

    const internals = workspaceService as unknown as {
      streamingGenerations: Map<string, number>;
      updateStreamingStatus: (
        workspaceId: string,
        streaming: boolean,
        options?: ExtensionMetadataStreamingUpdate
      ) => Promise<void>;
    };

    internals.streamingGenerations.set(workspaceId, 1);
    const staleStopPromise = internals.updateStreamingStatus(workspaceId, false, {
      generation: 1,
    });

    internals.streamingGenerations.set(workspaceId, 2);
    await internals.updateStreamingStatus(workspaceId, true, { model: "openai:gpt-4o" });

    todoReadDeferred.resolve([]);
    await staleStopPromise;

    expect(setStreaming).toHaveBeenCalledTimes(1);
    expect(setStreaming).toHaveBeenCalledWith(workspaceId, true, { model: "openai:gpt-4o" });
  });

  test("todo snapshot refreshes run in call order for consecutive updates", async () => {
    const workspaceId = "ws-todo-refresh-order";
    const firstWriteDeferred = createDeferred<WorkspaceActivitySnapshot>();
    const setTodoStatus = mock(
      (
        _workspaceId: string,
        todoStatus: { emoji: string; message: string } | null,
        hasTodos: boolean
      ) => {
        if (todoStatus?.message === "First task") {
          return firstWriteDeferred.promise;
        }
        return Promise.resolve({
          recency: Date.now(),
          streaming: false,
          lastModel: null,
          lastThinkingLevel: null,
          todoStatus,
          hasTodos,
        });
      }
    );

    let readCount = 0;
    readTodosSpy = spyOn(todoStorageModule, "readTodosForSessionDir").mockImplementation(() => {
      readCount += 1;
      if (readCount === 1) {
        return Promise.resolve([{ content: "First task", status: "in_progress" }]);
      }
      return Promise.resolve([{ content: "Second task", status: "in_progress" }]);
    });

    (
      workspaceService as unknown as {
        extensionMetadata: ExtensionMetadataService;
      }
    ).extensionMetadata = {
      setTodoStatus,
    } as unknown as ExtensionMetadataService;

    const internals = workspaceService as unknown as {
      updateTodoStatusFromStorage: (workspaceId: string) => Promise<void>;
    };

    const firstRefresh = internals.updateTodoStatusFromStorage(workspaceId);
    const secondRefresh = internals.updateTodoStatusFromStorage(workspaceId);

    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(setTodoStatus).toHaveBeenCalledTimes(1);
    expect(readCount).toBe(1);

    firstWriteDeferred.resolve({
      recency: Date.now(),
      streaming: false,
      lastModel: null,
      lastThinkingLevel: null,
      todoStatus: { emoji: "🔄", message: "First task" },
      hasTodos: true,
    });

    await Promise.all([firstRefresh, secondRefresh]);

    expect(setTodoStatus).toHaveBeenCalledTimes(2);
    expect(setTodoStatus.mock.calls[0]).toEqual([
      workspaceId,
      { emoji: "🔄", message: "First task" },
      true,
    ]);
    expect(setTodoStatus.mock.calls[1]).toEqual([
      workspaceId,
      { emoji: "🔄", message: "Second task" },
      true,
    ]);
  });

  test("handleStreamCompletion captures generation before awaiting recency updates", async () => {
    const workspaceId = "ws-stream-completion-generation";
    const recencyDeferred = createDeferred<void>();
    const setStreaming = mock(
      (_workspaceId: string, streaming: boolean, update: ExtensionMetadataStreamingUpdate = {}) =>
        Promise.resolve({
          recency: Date.now(),
          streaming,
          lastModel: update.model ?? null,
          lastThinkingLevel: update.thinkingLevel ?? null,
          hasTodos: update.hasTodos,
          agentStatus: null,
        })
    );

    readTodosSpy = spyOn(todoStorageModule, "readTodosForSessionDir").mockResolvedValue([]);

    const internals = workspaceService as unknown as {
      extensionMetadata: ExtensionMetadataService;
      streamingGenerations: Map<string, number>;
      updateStreamingStatus: (
        workspaceId: string,
        streaming: boolean,
        options?: ExtensionMetadataStreamingUpdate
      ) => Promise<void>;
      updateRecencyTimestamp: (workspaceId: string, timestamp?: number) => Promise<void>;
      handleStreamCompletion: (workspaceId: string) => Promise<void>;
    };

    internals.extensionMetadata = {
      setStreaming,
    } as unknown as ExtensionMetadataService;
    internals.updateRecencyTimestamp = mock(() => recencyDeferred.promise);

    internals.streamingGenerations.set(workspaceId, 1);
    const completionPromise = internals.handleStreamCompletion(workspaceId);

    internals.streamingGenerations.set(workspaceId, 2);
    await internals.updateStreamingStatus(workspaceId, true, { model: "openai:gpt-4o-mini" });

    recencyDeferred.resolve();
    await completionPromise;

    expect(internals.updateRecencyTimestamp).toHaveBeenCalledTimes(1);
    expect(setStreaming).toHaveBeenCalledTimes(1);
    expect(setStreaming).toHaveBeenCalledWith(workspaceId, true, { model: "openai:gpt-4o-mini" });
  });
  test("tags matching compaction stop snapshots and clears the generation marker", async () => {
    const workspaceId = "ws-compaction-stream-stop";
    const setStreaming = mock(
      (_workspaceId: string, streaming: boolean, update: ExtensionMetadataStreamingUpdate = {}) =>
        Promise.resolve({
          recency: Date.now(),
          streaming,
          lastModel: update.model ?? null,
          lastThinkingLevel: update.thinkingLevel ?? null,
          hasTodos: update.hasTodos,
          agentStatus: null,
        })
    );
    const emitWorkspaceActivity = mock(
      (_workspaceId: string, _snapshot: WorkspaceActivitySnapshot | null) => undefined
    );

    readTodosSpy = spyOn(todoStorageModule, "readTodosForSessionDir").mockResolvedValue([]);

    const internals = workspaceService as unknown as {
      extensionMetadata: ExtensionMetadataService;
      streamingGenerations: Map<string, number>;
      compactionStreamGenerations: Map<string, number>;
      emitWorkspaceActivity: (
        workspaceId: string,
        snapshot: WorkspaceActivitySnapshot | null
      ) => void;
      updateStreamingStatus: (
        workspaceId: string,
        streaming: boolean,
        options?: ExtensionMetadataStreamingUpdate
      ) => Promise<void>;
    };

    internals.extensionMetadata = {
      setStreaming,
    } as unknown as ExtensionMetadataService;
    internals.emitWorkspaceActivity = emitWorkspaceActivity;
    internals.streamingGenerations.set(workspaceId, 3);
    internals.compactionStreamGenerations.set(workspaceId, 3);

    await internals.updateStreamingStatus(workspaceId, false, { generation: 3 });

    expect(emitWorkspaceActivity).toHaveBeenCalledWith(
      workspaceId,
      expect.objectContaining({ streaming: false, isCompaction: true })
    );
    expect(internals.compactionStreamGenerations.has(workspaceId)).toBe(false);
  });

  test("handleStreamCompletion skips recency updates for idle compaction", async () => {
    const workspaceId = "ws-idle-stream-completion";
    const setStreaming = mock(
      (_workspaceId: string, streaming: boolean, update: ExtensionMetadataStreamingUpdate = {}) =>
        Promise.resolve({
          recency: Date.now(),
          streaming,
          lastModel: update.model ?? null,
          lastThinkingLevel: update.thinkingLevel ?? null,
          hasTodos: update.hasTodos,
          agentStatus: null,
        })
    );

    readTodosSpy = spyOn(todoStorageModule, "readTodosForSessionDir").mockResolvedValue([]);

    const internals = workspaceService as unknown as {
      extensionMetadata: ExtensionMetadataService;
      streamingGenerations: Map<string, number>;
      idleCompactingWorkspaces: Set<string>;
      updateRecencyTimestamp: (workspaceId: string, timestamp?: number) => Promise<void>;
      handleStreamCompletion: (workspaceId: string) => Promise<void>;
    };

    internals.extensionMetadata = {
      setStreaming,
    } as unknown as ExtensionMetadataService;
    internals.updateRecencyTimestamp = mock(() => Promise.resolve());

    internals.streamingGenerations.set(workspaceId, 7);
    internals.idleCompactingWorkspaces.add(workspaceId);

    await internals.handleStreamCompletion(workspaceId);

    expect(internals.updateRecencyTimestamp).not.toHaveBeenCalled();
    expect(setStreaming).toHaveBeenCalledTimes(1);
    expect(setStreaming).toHaveBeenCalledWith(
      workspaceId,
      false,
      expect.objectContaining({ generation: 7, hasTodos: false })
    );
  });
});

describe("WorkspaceService executeBash archive guards", () => {
  let workspaceService: WorkspaceService;
  let waitForInitMock: ReturnType<typeof mock>;
  let getWorkspaceMetadataMock: ReturnType<typeof mock>;
  let historyService: HistoryService;
  let cleanupHistory: () => Promise<void>;

  beforeEach(async () => {
    waitForInitMock = mock(() => Promise.resolve());

    getWorkspaceMetadataMock = mock(() =>
      Promise.resolve({ success: false as const, error: "not found" })
    );

    const aiService: AIService = {
      ...createStreamLifecycleMocks(),
      isStreaming: mock(() => false),
      getWorkspaceMetadata: getWorkspaceMetadataMock,
      // eslint-disable-next-line @typescript-eslint/no-empty-function
      on: mock(() => {}),
      // eslint-disable-next-line @typescript-eslint/no-empty-function
      off: mock(() => {}),
    } as unknown as AIService;

    ({ historyService, cleanup: cleanupHistory } = await createTestHistoryService());

    const mockConfig: MockWorkspaceConfig = {
      srcDir: "/tmp/test",
      sessionsDir: "/tmp/test/sessions",
      generateStableId: mock(() => "test-id"),
      findWorkspace: mock(() => null),
    };
    const mockInitStateManager: Partial<InitStateManager> = {
      on: mock(() => undefined as unknown as InitStateManager),
      getInitState: mock(() => undefined),
      waitForInit: waitForInitMock,
    };

    workspaceService = createWorkspaceServiceForTest({
      config: mockConfig,
      historyService,
      aiService,
      initStateManager: mockInitStateManager as InitStateManager,
    });
  });

  afterEach(async () => {
    await cleanupHistory();
  });

  test("archived workspace => executeBash returns error mentioning archived", async () => {
    const workspaceId = "ws-archived";

    const archivedMetadata: WorkspaceMetadata = {
      id: workspaceId,
      name: "ws",
      projectName: "proj",
      projectPath: "/tmp/proj",
      runtimeConfig: { type: "local", srcBaseDir: "/tmp" },
      archivedAt: "2026-01-01T00:00:00.000Z",
    };

    getWorkspaceMetadataMock.mockReturnValue(Promise.resolve(Ok(archivedMetadata)));

    const result = await workspaceService.executeBash(workspaceId, "echo hello");

    expect(result.success).toBe(false);
    if (!result.success) {
      expect(result.error).toContain("archived");
    }

    // This must happen before init/runtime operations.
    expect(waitForInitMock).toHaveBeenCalledTimes(0);
  });

  test("archiving workspace => executeBash returns error mentioning being archived", async () => {
    const workspaceId = "ws-archiving";

    addToArchivingWorkspaces(workspaceService, workspaceId);

    const result = await workspaceService.executeBash(workspaceId, "echo hello");

    expect(result.success).toBe(false);
    if (!result.success) {
      expect(result.error).toContain("being archived");
    }

    expect(waitForInitMock).toHaveBeenCalledTimes(0);
    expect(getWorkspaceMetadataMock).toHaveBeenCalledTimes(0);
  });

  test("in-flight executeBash holds the archive gate until it settles", async () => {
    const workspaceId = "ws-exec-pairing";

    // Park executeBash at its first await (metadata fetch): the admission was counted in its
    // synchronous entry block, so the archive gate must observe it with no timing games.
    let releaseMetadata: () => void = () => undefined;
    const metadataGate = new Promise<{ success: false; error: string }>((resolve) => {
      releaseMetadata = () => resolve({ success: false, error: "metadata unavailable (test)" });
    });
    getWorkspaceMetadataMock.mockReturnValue(metadataGate);

    const execPromise = workspaceService.executeBash(workspaceId, "echo hello");

    const archiveResult = await workspaceService.archive(workspaceId, undefined, {
      refuseLiveUserActivity: true,
    });
    expect(archiveResult.success).toBe(false);
    if (!archiveResult.success) {
      expect(archiveResult.error).toContain("bash command");
    }

    releaseMetadata();
    const execResult = await execPromise;
    expect(execResult.success).toBe(false);

    // Once the exec settled, its admission is released and the gate no longer reports it.
    const archiveAfter = await workspaceService.archive(workspaceId, undefined, {
      refuseLiveUserActivity: true,
    });
    if (!archiveAfter.success) {
      expect(archiveAfter.error).not.toContain("bash command");
    }
  });

  test("stageAttachment refuses while the workspace is being archived", async () => {
    addToArchivingWorkspaces(workspaceService, "ws-staging");

    const result = await workspaceService.stageAttachment({
      workspaceId: "ws-staging",
      filename: "notes.txt",
      sizeBytes: 1,
      dataBase64: Buffer.from("x").toString("base64"),
    });

    expect(result.success).toBe(false);
    if (!result.success) {
      expect(result.error).toContain("being archived");
    }
  });

  test("downloadStagedAttachment refuses while the workspace is being archived", async () => {
    // Downloads read from the checkout through the runtime (and can restart a stopped Coder
    // workspace), so they pair with the archive gates exactly like staging.
    addToArchivingWorkspaces(workspaceService, "ws-download");

    const result = await workspaceService.downloadStagedAttachment({
      workspaceId: "ws-download",
      stagedPath: ".xum/user-attachments/notes.txt",
    });

    expect(result.success).toBe(false);
    if (!result.success) {
      expect(result.error).toContain("being archived");
    }
  });

  test("getFileCompletions returns empty without touching the workspace while archiving", async () => {
    addToArchivingWorkspaces(workspaceService, "ws-completions");

    // The sync entry guard must return before getInfo: this fixture's config has no
    // getAllWorkspaceMetadata, so reaching metadata/runtime work would throw.
    const result = await workspaceService.getFileCompletions("ws-completions", "src");

    expect(result.paths).toEqual([]);
  });

  test("in-flight staging and completion refreshes hold the archive gate", async () => {
    // Park both requests at getInfo: their admissions were counted in the synchronous entry
    // blocks, so the archive gate observes them with no timing assumptions.
    let releaseMetadata: () => void = () => undefined;
    const metadataGate = new Promise<never[]>((resolve) => {
      releaseMetadata = () => resolve([]);
    });
    const service = createWorkspaceServiceForTest({
      config: {
        srcDir: "/tmp/test",
        sessionsDir: "/tmp/test/sessions",
        loadConfigOrDefault: mock(() => ({ projects: new Map() })),
        getAllWorkspaceMetadata: mock(() => metadataGate),
      } as unknown as Config,
      historyService,
    });

    const stagePromise = service.stageAttachment({
      workspaceId: "ws-gate",
      filename: "notes.txt",
      sizeBytes: 1,
      dataBase64: Buffer.from("x").toString("base64"),
    });
    const completionsPromise = service.getFileCompletions("ws-gate", "src");

    const archiveResult = await service.archive("ws-gate", undefined, {
      refuseLiveUserActivity: true,
    });
    expect(archiveResult.success).toBe(false);
    if (!archiveResult.success) {
      expect(archiveResult.error).toContain("an attachment transfer in progress");
      expect(archiveResult.error).toContain("a file completion refresh in progress");
    }

    releaseMetadata();
    const staged = await stagePromise;
    expect(staged.success).toBe(false); // Workspace not found in the empty metadata list.
    const completions = await completionsPromise;
    expect(completions.paths).toEqual([]);
  });
});

describe("WorkspaceService executeBash workspace path resolution", () => {
  let workspaceService: WorkspaceService;
  let waitForInitMock: ReturnType<typeof mock>;
  let getWorkspaceMetadataMock: ReturnType<typeof mock>;
  let findWorkspaceMock: ReturnType<typeof mock>;
  let createRuntimeSpy: Mock<typeof runtimeFactory.createRuntime>;
  let createBashToolSpy: Mock<typeof bashToolModule.createBashTool>;
  let historyService: HistoryService;
  let cleanupHistory: () => Promise<void>;

  beforeEach(async () => {
    waitForInitMock = mock(() => Promise.resolve());
    findWorkspaceMock = mock(() => ({
      workspacePath: "/persisted/workspace-root",
      projectPath: "/tmp/proj",
      workspaceName: "ws",
    }));
    getWorkspaceMetadataMock = mock(() =>
      Promise.resolve(
        Ok({
          id: "ws-path",
          name: "ws",
          projectName: "proj",
          projectPath: "/tmp/proj",
          runtimeConfig: { type: "worktree", srcBaseDir: "/tmp/runtime-src" },
        } satisfies WorkspaceMetadata)
      )
    );

    const aiService: AIService = {
      ...createStreamLifecycleMocks(),
      isStreaming: mock(() => false),
      getWorkspaceMetadata: getWorkspaceMetadataMock,
      on(_eventName: string | symbol, _listener: (...args: unknown[]) => void) {
        return this;
      },
      off(_eventName: string | symbol, _listener: (...args: unknown[]) => void) {
        return this;
      },
    } as unknown as AIService;

    ({ historyService, cleanup: cleanupHistory } = await createTestHistoryService());

    const mockConfig: MockWorkspaceConfig = {
      srcDir: "/tmp/test",
      sessionsDir: "/tmp/test/sessions",
      generateStableId: mock(() => "test-id"),
      findWorkspace: findWorkspaceMock,
      loadConfigOrDefault: mock(() => ({ projects: new Map() })),
    };
    const mockInitStateManager: Partial<InitStateManager> = {
      on: mock(() => undefined as unknown as InitStateManager),
      getInitState: mock(() => undefined),
      waitForInit: waitForInitMock,
    };
    workspaceService = createWorkspaceServiceForTest({
      config: mockConfig,
      historyService,
      aiService,
      initStateManager: mockInitStateManager as InitStateManager,
      secretsStore: { getEffectiveSecrets: mock(() => []) } as unknown as SecretsStore,
    });

    createRuntimeSpy = spyOn(runtimeFactory, "createRuntime").mockReturnValue({
      ensureReady: mock(() => Promise.resolve({ ready: true })),
      getWorkspacePath: mock(() => "/runtime/workspace-root"),
      normalizePath: mock((targetPath: string, basePath: string) =>
        targetPath ? `${basePath}/${targetPath}` : basePath
      ),
    } as unknown as ReturnType<typeof runtimeFactory.createRuntime>);

    createBashToolSpy = spyOn(bashToolModule, "createBashTool").mockReturnValue({
      execute: mock(() =>
        Promise.resolve({
          success: true,
          output: "ok",
          exitCode: 0,
          wall_duration_ms: 1,
        } satisfies BashToolResult)
      ),
    } as unknown as ReturnType<typeof bashToolModule.createBashTool>);
  });

  afterEach(async () => {
    createRuntimeSpy.mockRestore();
    createBashToolSpy.mockRestore();
    await cleanupHistory();
  });

  test("uses persisted workspace root for path-addressable runtimes", async () => {
    const result = await workspaceService.executeBash("ws-path", "pwd");

    expect(result.success).toBe(true);
    expect(createRuntimeSpy).toHaveBeenCalled();
    expect(createBashToolSpy).toHaveBeenCalledTimes(1);
    expect(createBashToolSpy.mock.calls[0]?.[0]?.cwd).toBe("/persisted/workspace-root");
    expect(waitForInitMock).toHaveBeenCalledWith("ws-path");
  });

  test("keeps default sub-project execution in the sub-project but runs repo-root mode at checkout root", async () => {
    getWorkspaceMetadataMock.mockReturnValue(
      Promise.resolve(
        Ok({
          id: "ws-path",
          name: "ws",
          projectName: "proj",
          projectPath: "/tmp/proj",
          subProjectPath: "/tmp/proj/packages/api",
          runtimeConfig: { type: "worktree", srcBaseDir: "/tmp/runtime-src" },
        } satisfies WorkspaceMetadata)
      )
    );

    const defaultResult = await workspaceService.executeBash("ws-path", "pwd");
    const repoRootResult = await workspaceService.executeBash("ws-path", "git diff", {
      cwdMode: "repo-root",
    });
    const gitCommandResult = await workspaceService.executeBash("ws-path", "", undefined, "git", [
      "status",
    ]);

    expect(defaultResult.success).toBe(true);
    expect(repoRootResult.success).toBe(true);
    expect(gitCommandResult.success).toBe(true);
    expect(createBashToolSpy).toHaveBeenCalledTimes(3);
    expect(createBashToolSpy.mock.calls[0]?.[0]?.cwd).toBe(
      "/persisted/workspace-root/packages/api"
    );
    expect(createBashToolSpy.mock.calls[1]?.[0]?.cwd).toBe("/persisted/workspace-root");
    expect(createBashToolSpy.mock.calls[2]?.[0]?.cwd).toBe("/persisted/workspace-root");
  });

  test("keeps docker executeBash rooted in the translated runtime path", async () => {
    getWorkspaceMetadataMock.mockReturnValue(
      Promise.resolve(
        Ok({
          id: "ws-path",
          name: "ws",
          projectName: "proj",
          projectPath: "/tmp/proj",
          runtimeConfig: { type: "docker", image: "node:20" },
        } satisfies WorkspaceMetadata)
      )
    );

    const result = await workspaceService.executeBash("ws-path", "pwd");

    expect(result.success).toBe(true);
    expect(createBashToolSpy).toHaveBeenCalledTimes(1);
    expect(createBashToolSpy.mock.calls[0]?.[0]?.cwd).toBe("/runtime/workspace-root");
  });
});

describe("WorkspaceService getFileCompletions", () => {
  let workspaceService: WorkspaceService;
  let historyService: HistoryService;
  let cleanupHistory: () => Promise<void>;
  let createRuntimeSpy: Mock<typeof runtimeFactory.createRuntime>;
  let execBufferedSpy: Mock<typeof runtimeExecHelpers.execBuffered>;

  beforeEach(async () => {
    const aiService: AIService = {
      ...createStreamLifecycleMocks(),
      isStreaming: mock(() => false),
      getWorkspaceMetadata: mock(() =>
        Promise.resolve({ success: false as const, error: "not found" })
      ),
      on(_eventName: string | symbol, _listener: (...args: unknown[]) => void) {
        return this;
      },
      off(_eventName: string | symbol, _listener: (...args: unknown[]) => void) {
        return this;
      },
    } as unknown as AIService;

    ({ historyService, cleanup: cleanupHistory } = await createTestHistoryService());

    const mockConfig: MockWorkspaceConfig = {
      srcDir: "/tmp/test",
      sessionsDir: "/tmp/test/sessions",
      generateStableId: mock(() => "test-id"),
      findWorkspace: mock(() => null),
      loadConfigOrDefault: mock(() => ({ projects: new Map() })),
    };
    const mockInitStateManager: Partial<InitStateManager> = {
      on: mock(() => undefined as unknown as InitStateManager),
      getInitState: mock(() => undefined),
    };
    workspaceService = createWorkspaceServiceForTest({
      config: mockConfig,
      historyService,
      aiService,
      initStateManager: mockInitStateManager as InitStateManager,
    });

    createRuntimeSpy = spyOn(runtimeFactory, "createRuntime").mockImplementation(
      (_runtimeConfig, options) => {
        if (!options?.projectPath) {
          throw new Error("Expected createRuntime projectPath in getFileCompletions test");
        }
        const runtimeProjectPath = options.projectPath;

        return {
          getWorkspacePath: (_projectPath: string, workspaceName: string) =>
            `/runtime/${path.basename(runtimeProjectPath)}/${workspaceName}`,
        } as unknown as ReturnType<typeof runtimeFactory.createRuntime>;
      }
    );

    execBufferedSpy = spyOn(runtimeExecHelpers, "execBuffered").mockImplementation(
      (_runtime, _command, options) =>
        Promise.reject(new Error(`Unexpected execBuffered call for ${options.cwd}`))
    );
  });

  afterEach(async () => {
    createRuntimeSpy.mockRestore();
    execBufferedSpy.mockRestore();
    await cleanupHistory();
  });

  test("keeps single-project completions unchanged", async () => {
    interface WorkspaceServiceTestAccess {
      getInfo: (workspaceId: string) => Promise<FrontendWorkspaceMetadata | null>;
    }

    const svc = workspaceService as unknown as WorkspaceServiceTestAccess;
    svc.getInfo = mock(() =>
      Promise.resolve({
        id: "ws-single",
        name: "ws",
        projectName: "project-a",
        projectPath: "/tmp/project-a",
        namedWorkspacePath: "/persisted/project-a/ws",
        runtimeConfig: { type: "worktree", srcBaseDir: "/tmp/src" },
      } satisfies FrontendWorkspaceMetadata)
    );

    execBufferedSpy.mockResolvedValue({
      stdout: "src/single.ts\n",
      stderr: "",
      exitCode: 0,
      duration: 1,
    });

    const result = await workspaceService.getFileCompletions("ws-single", "src/");

    expect(result.paths).toEqual(["src/single.ts"]);
    expect(execBufferedSpy).toHaveBeenCalledTimes(1);
    expect(execBufferedSpy.mock.calls[0]?.[2].cwd).toBe("/persisted/project-a/ws");
  });

  test("preserves the current SSH workspace path and derives sibling legacy paths for multi-project completions when the persisted root matches that layout", async () => {
    interface WorkspaceServiceTestAccess {
      getInfo: (workspaceId: string) => Promise<FrontendWorkspaceMetadata | null>;
    }

    const svc = workspaceService as unknown as WorkspaceServiceTestAccess;
    svc.getInfo = mock(() =>
      Promise.resolve({
        id: "ws-multi-ssh",
        name: "ws",
        projectName: "project-a",
        projectPath: "/tmp/project-a",
        namedWorkspacePath: "/tmp/src/project-a/ws",
        runtimeConfig: { type: "ssh", host: "example.com", srcBaseDir: "/tmp/src" },
        projects: [
          { projectPath: "/tmp/project-a", projectName: "project-a" },
          { projectPath: "/tmp/project-b", projectName: "project-b" },
        ],
      } satisfies FrontendWorkspaceMetadata)
    );
    const config = (workspaceService as unknown as { config: Config }).config;
    spyOn(config, "findWorkspace").mockReturnValue({
      projectPath: "/tmp/project-a",
      workspacePath: "/tmp/src/project-a/ws",
    });
    createRuntimeSpy.mockImplementation((_runtimeConfig, options) => {
      const runtimeProjectPath = options?.projectPath;
      if (!runtimeProjectPath) {
        throw new Error("Expected createRuntime projectPath in SSH completion test");
      }
      return {
        getWorkspacePath: () =>
          options.workspacePath ?? `/runtime/${path.basename(runtimeProjectPath)}/ws`,
      } as unknown as ReturnType<typeof runtimeFactory.createRuntime>;
    });

    execBufferedSpy.mockImplementation((_runtime, _command, options) => {
      if (options.cwd === "/tmp/src/project-a/ws") {
        return Promise.resolve({
          stdout: "README.md\n",
          stderr: "",
          exitCode: 0,
          duration: 1,
        });
      }
      if (options.cwd === "/tmp/src/project-b/ws") {
        return Promise.resolve({
          stdout: "src/b.ts\n",
          stderr: "",
          exitCode: 0,
          duration: 1,
        });
      }
      return Promise.reject(new Error(`Unexpected cwd ${options.cwd}`));
    });

    const result = await workspaceService.getFileCompletions("ws-multi-ssh", "", 10);

    expect(result.paths).toContain("project-a/README.md");
    expect(result.paths).toContain("project-b/src/b.ts");
    expect(createRuntimeSpy).toHaveBeenNthCalledWith(1, expect.anything(), {
      projectPath: "/tmp/project-a",
      workspaceName: "ws",
      workspacePath: "/tmp/src/project-a/ws",
    });
    expect(createRuntimeSpy).toHaveBeenNthCalledWith(2, expect.anything(), {
      projectPath: "/tmp/project-b",
      workspaceName: "ws",
      workspacePath: "/tmp/src/project-b/ws",
    });
  });

  test("aggregates multi-project completions using project-prefixed paths", async () => {
    interface WorkspaceServiceTestAccess {
      getInfo: (workspaceId: string) => Promise<FrontendWorkspaceMetadata | null>;
    }

    const svc = workspaceService as unknown as WorkspaceServiceTestAccess;
    svc.getInfo = mock(() =>
      Promise.resolve({
        id: "ws-multi",
        name: "ws",
        projectName: "project-a",
        projectPath: "/tmp/project-a",
        namedWorkspacePath: "/persisted/container/ws",
        runtimeConfig: { type: "worktree", srcBaseDir: "/tmp/src" },
        projects: [
          { projectPath: "/tmp/project-a", projectName: "project-a" },
          { projectPath: "/tmp/project-b", projectName: "project-b" },
        ],
      } satisfies FrontendWorkspaceMetadata)
    );

    execBufferedSpy.mockImplementation((_runtime, _command, options) => {
      if (options.cwd === "/runtime/project-a/ws") {
        return Promise.resolve({
          stdout: "README.md\nsrc/a.ts\n",
          stderr: "",
          exitCode: 0,
          duration: 1,
        });
      }

      if (options.cwd === "/runtime/project-b/ws") {
        return Promise.resolve({
          stdout: "src/b.ts\nnested/keep.ts\n",
          stderr: "",
          exitCode: 0,
          duration: 1,
        });
      }

      return Promise.reject(new Error(`Unexpected cwd ${options.cwd}`));
    });

    const result = await workspaceService.getFileCompletions("ws-multi", "", 10);

    expect(result.paths).toContain("project-a/README.md");
    expect(result.paths).toContain("project-a/src/a.ts");
    expect(result.paths).toContain("project-b/src/b.ts");
    expect(result.paths).toContain("project-b/nested/keep.ts");
    expect(result.paths).not.toContain("src/a.ts");
    expect(result.paths).toHaveLength(4);

    const completionCwds = execBufferedSpy.mock.calls
      .map((call) => call[2].cwd)
      .sort((left, right) => left.localeCompare(right));
    expect(completionCwds).toEqual(["/runtime/project-a/ws", "/runtime/project-b/ws"]);
  });
});

describe("WorkspaceService getProjectGitStatuses", () => {
  let historyService: HistoryService;
  let cleanupHistory: () => Promise<void>;

  beforeEach(async () => {
    ({ historyService, cleanup: cleanupHistory } = await createTestHistoryService());
  });

  afterEach(async () => {
    await cleanupHistory();
  });

  function createGitStatusOutput(params?: {
    headBranch?: string;
    primaryBranch?: string;
    ahead?: number;
    behind?: number;
    dirtyCount?: number;
    outgoingAdditions?: number;
    outgoingDeletions?: number;
    incomingAdditions?: number;
    incomingDeletions?: number;
  }): string {
    return [
      "---HEAD_BRANCH---",
      params?.headBranch ?? "feature/test",
      "---PRIMARY---",
      params?.primaryBranch ?? "main",
      "---AHEAD_BEHIND---",
      `${params?.ahead ?? 1} ${params?.behind ?? 0}`,
      "---DIRTY---",
      String(params?.dirtyCount ?? 0),
      "---LINE_DELTA---",
      `${params?.outgoingAdditions ?? 5} ${params?.outgoingDeletions ?? 2} ${params?.incomingAdditions ?? 3} ${params?.incomingDeletions ?? 1}`,
      "",
    ].join("\n");
  }

  function bashOk(output: string): Result<BashToolResult> {
    return {
      success: true,
      data: {
        success: true,
        output,
        exitCode: 0,
        wall_duration_ms: 0,
      },
    };
  }

  function createServiceHarness(params: {
    metadata: WorkspaceMetadata;
    executeBashImpl: (
      workspaceId: string,
      script: string,
      options?: {
        timeout_secs?: number | null;
        cwdMode?: "default" | "repo-root" | null;
        repoRootProjectPath?: string | null;
      }
    ) => Promise<Result<BashToolResult>>;
  }): {
    workspaceService: WorkspaceService;
    executeBashMock: ReturnType<typeof mock>;
    getWorkspaceMetadataMock: ReturnType<typeof mock>;
  } {
    const getWorkspaceMetadataMock = mock(() => Promise.resolve(Ok(params.metadata)));
    const aiService: AIService = {
      ...createStreamLifecycleMocks(),
      isStreaming: mock(() => false),
      getWorkspaceMetadata: getWorkspaceMetadataMock,
      on(_eventName: string | symbol, _listener: (...args: unknown[]) => void) {
        return this;
      },
      off(_eventName: string | symbol, _listener: (...args: unknown[]) => void) {
        return this;
      },
    } as unknown as AIService;

    const mockConfig: MockWorkspaceConfig = {
      srcDir: "/tmp/test",
      sessionsDir: "/tmp/test/sessions",
      generateStableId: mock(() => "test-id"),
      findWorkspace: mock(() => null),
    };
    const mockInitStateManager: Partial<InitStateManager> = {
      on: mock(() => undefined as unknown as InitStateManager),
      getInitState: mock(() => undefined),
    };
    const workspaceService = createWorkspaceServiceForTest({
      config: mockConfig,
      historyService,
      aiService,
      initStateManager: mockInitStateManager as InitStateManager,
    });

    const executeBashMock = mock(params.executeBashImpl);

    interface WorkspaceServiceTestAccess {
      executeBash: typeof executeBashMock;
    }

    const svc = workspaceService as unknown as WorkspaceServiceTestAccess;
    svc.executeBash = executeBashMock;

    return { workspaceService, executeBashMock, getWorkspaceMetadataMock };
  }

  test("returns no entries for scratch workspaces without invoking git", async () => {
    const metadata: WorkspaceMetadata = {
      kind: "scratch",
      id: "ws-scratch",
      name: "scratch-ws-scratch",
      projectName: "Scratch",
      projectPath: "/tmp/mux/scratch/ws-scratch",
      runtimeConfig: { type: "local" },
    };
    const { workspaceService, executeBashMock } = createServiceHarness({
      metadata,
      executeBashImpl: () => Promise.reject(new Error("git should not run")),
    });

    expect(await workspaceService.getProjectGitStatuses(metadata.id)).toEqual([]);
    expect(executeBashMock).not.toHaveBeenCalled();
  });

  test("returns a single entry for single-project workspaces", async () => {
    const metadata: WorkspaceMetadata = {
      id: "ws-single",
      name: "ws-single",
      projectName: "project-a",
      projectPath: "/tmp/project-a",
      runtimeConfig: { type: "local" },
    };

    const { workspaceService, executeBashMock, getWorkspaceMetadataMock } = createServiceHarness({
      metadata,
      executeBashImpl: () => Promise.resolve(bashOk(createGitStatusOutput({ dirtyCount: 2 }))),
    });

    const result = await workspaceService.getProjectGitStatuses(metadata.id);

    expect(result).toEqual([
      {
        projectPath: "/tmp/project-a",
        projectName: "project-a",
        gitStatus: {
          branch: "feature/test",
          ahead: 1,
          behind: 0,
          dirty: true,
          outgoingAdditions: 5,
          outgoingDeletions: 2,
          incomingAdditions: 3,
          incomingDeletions: 1,
        },
        error: null,
      },
    ]);
    expect(getWorkspaceMetadataMock).toHaveBeenCalledWith(metadata.id);
    expect(executeBashMock).toHaveBeenCalledTimes(1);
    expect(executeBashMock).toHaveBeenNthCalledWith(
      1,
      metadata.id,
      expect.stringContaining("PREFERRED_BRANCH=''"),
      expect.objectContaining({
        cwdMode: "repo-root",
        repoRootProjectPath: "/tmp/project-a",
        timeout_secs: 5,
      })
    );
    expect(executeBashMock.mock.calls.some(([, script]) => script === "git fetch --quiet")).toBe(
      false
    );
  });

  test("returns one entry per project in stable order for multi-project workspaces", async () => {
    const metadata: WorkspaceMetadata = {
      id: "ws-multi",
      name: "ws-multi",
      projectName: "project-a",
      projectPath: "/tmp/project-a",
      runtimeConfig: { type: "local" },
      projects: [
        { projectPath: "/tmp/project-a", projectName: "project-a" },
        { projectPath: "/tmp/project-b", projectName: "project-b" },
      ],
    };

    const { workspaceService, executeBashMock } = createServiceHarness({
      metadata,
      executeBashImpl: (_workspaceId, _script, options) => {
        const repoRootProjectPath = options?.repoRootProjectPath;
        if (repoRootProjectPath === "/tmp/project-a") {
          return Promise.resolve(
            bashOk(createGitStatusOutput({ headBranch: "feature/a", ahead: 2 }))
          );
        }
        if (repoRootProjectPath === "/tmp/project-b") {
          return Promise.resolve(
            bashOk(createGitStatusOutput({ headBranch: "feature/b", behind: 3 }))
          );
        }
        throw new Error(`Unexpected repoRootProjectPath: ${String(repoRootProjectPath)}`);
      },
    });

    const result = await workspaceService.getProjectGitStatuses(metadata.id, "origin/release");

    expect(result.map((entry) => entry.projectName)).toEqual(["project-a", "project-b"]);
    expect(result[0]?.gitStatus?.branch).toBe("feature/a");
    expect(result[0]?.gitStatus?.ahead).toBe(2);
    expect(result[1]?.gitStatus?.branch).toBe("feature/b");
    expect(result[1]?.gitStatus?.behind).toBe(3);
    expect(executeBashMock).toHaveBeenCalledTimes(2);
    expect(executeBashMock).toHaveBeenNthCalledWith(
      1,
      metadata.id,
      expect.stringContaining("PREFERRED_BRANCH='release'"),
      expect.objectContaining({ repoRootProjectPath: "/tmp/project-a", timeout_secs: 5 })
    );
    expect(executeBashMock).toHaveBeenNthCalledWith(
      2,
      metadata.id,
      expect.stringContaining("PREFERRED_BRANCH='release'"),
      expect.objectContaining({ repoRootProjectPath: "/tmp/project-b", timeout_secs: 5 })
    );
    expect(executeBashMock.mock.calls.some(([, script]) => script === "git fetch --quiet")).toBe(
      false
    );
  });

  test("continues when one project bash execution fails", async () => {
    const metadata: WorkspaceMetadata = {
      id: "ws-multi-failure",
      name: "ws-multi-failure",
      projectName: "project-a",
      projectPath: "/tmp/project-a",
      runtimeConfig: { type: "local" },
      projects: [
        { projectPath: "/tmp/project-a", projectName: "project-a" },
        { projectPath: "/tmp/project-b", projectName: "project-b" },
      ],
    };

    const { workspaceService } = createServiceHarness({
      metadata,
      executeBashImpl: (_workspaceId, _script, options) => {
        if (options?.repoRootProjectPath === "/tmp/project-a") {
          return Promise.resolve(bashOk(createGitStatusOutput()));
        }
        return Promise.resolve(Err("git failed for project-b"));
      },
    });

    const result = await workspaceService.getProjectGitStatuses(metadata.id);

    expect(result).toEqual([
      {
        projectPath: "/tmp/project-a",
        projectName: "project-a",
        gitStatus: {
          branch: "feature/test",
          ahead: 1,
          behind: 0,
          dirty: false,
          outgoingAdditions: 5,
          outgoingDeletions: 2,
          incomingAdditions: 3,
          incomingDeletions: 1,
        },
        error: null,
      },
      {
        projectPath: "/tmp/project-b",
        projectName: "project-b",
        gitStatus: null,
        error: "git failed for project-b",
      },
    ]);
  });

  test("returns gitStatus null with an error when output cannot be parsed", async () => {
    const metadata: WorkspaceMetadata = {
      id: "ws-unparsable",
      name: "ws-unparsable",
      projectName: "project-a",
      projectPath: "/tmp/project-a",
      runtimeConfig: { type: "local" },
    };

    const { workspaceService } = createServiceHarness({
      metadata,
      executeBashImpl: () => Promise.resolve(bashOk("definitely not git status output")),
    });

    const result = await workspaceService.getProjectGitStatuses(metadata.id);

    expect(result).toEqual([
      {
        projectPath: "/tmp/project-a",
        projectName: "project-a",
        gitStatus: null,
        error: "Failed to parse git status script output",
      },
    ]);
  });
});

describe("WorkspaceService post-compaction metadata refresh", () => {
  let workspaceService: WorkspaceService;
  let historyService: HistoryService;
  let cleanupHistory: () => Promise<void>;

  beforeEach(async () => {
    const aiService: AIService = {
      ...createStreamLifecycleMocks(),
      isStreaming: mock(() => false),
      getWorkspaceMetadata: mock(() =>
        Promise.resolve({ success: false as const, error: "not found" })
      ),
      on(_eventName: string | symbol, _listener: (...args: unknown[]) => void) {
        return this;
      },
      off(_eventName: string | symbol, _listener: (...args: unknown[]) => void) {
        return this;
      },
    } as unknown as AIService;

    ({ historyService, cleanup: cleanupHistory } = await createTestHistoryService());

    const mockConfig: MockWorkspaceConfig = {
      srcDir: "/tmp/test",
      sessionsDir: "/tmp/test/sessions",
      generateStableId: mock(() => "test-id"),
      findWorkspace: mock(() => null),
    };
    const mockInitStateManager: Partial<InitStateManager> = {
      on: mock(() => undefined as unknown as InitStateManager),
      getInitState: mock(() => undefined),
    };
    workspaceService = createWorkspaceServiceForTest({
      config: mockConfig,
      historyService,
      aiService,
      initStateManager: mockInitStateManager as InitStateManager,
    });
  });

  afterEach(async () => {
    await cleanupHistory();
  });

  test("returns expanded plan path for local runtimes", async () => {
    await withTempMuxRoot(async (muxRoot) => {
      const workspaceId = "ws-plan-path";
      const workspaceName = "plan-workspace";
      const projectName = "cmux";
      const planFile = await writePlanFile(muxRoot, projectName, workspaceName);

      interface WorkspaceServiceTestAccess {
        getInfo: (workspaceId: string) => Promise<FrontendWorkspaceMetadata | null>;
      }

      const fakeMetadata: FrontendWorkspaceMetadata = {
        id: workspaceId,
        name: workspaceName,
        projectName,
        projectPath: "/tmp/proj",
        namedWorkspacePath: "/tmp/proj/plan-workspace",
        runtimeConfig: { type: "local", srcBaseDir: "/tmp" },
      };

      const svc = workspaceService as unknown as WorkspaceServiceTestAccess;
      svc.getInfo = mock(() => Promise.resolve(fakeMetadata));

      const result = await workspaceService.getPostCompactionState(workspaceId);

      expect(result.planPath).toBe(planFile);
      expect(result.planPath?.startsWith("~")).toBe(false);
    });
  });

  test("debounces multiple refresh requests into a single metadata emit", async () => {
    const workspaceId = "ws-post-compaction";

    const emitMetadata = mock(() => undefined);

    interface WorkspaceServiceTestAccess {
      sessions: Map<string, { emitMetadata: (metadata: unknown) => void }>;
      getInfo: (workspaceId: string) => Promise<FrontendWorkspaceMetadata | null>;
      getPostCompactionState: (workspaceId: string) => Promise<{
        planPath: string | null;
        trackedFilePaths: string[];
        excludedItems: string[];
      }>;
      schedulePostCompactionMetadataRefresh: (workspaceId: string) => void;
    }

    const svc = workspaceService as unknown as WorkspaceServiceTestAccess;
    svc.sessions.set(workspaceId, { emitMetadata });

    const fakeMetadata: FrontendWorkspaceMetadata = {
      id: workspaceId,
      name: "ws",
      projectName: "proj",
      projectPath: "/tmp/proj",
      namedWorkspacePath: "/tmp/proj/ws",
      runtimeConfig: { type: "local", srcBaseDir: "/tmp" },
    };

    const getInfoMock: WorkspaceServiceTestAccess["getInfo"] = mock(() =>
      Promise.resolve(fakeMetadata)
    );

    const postCompactionState = {
      planPath: "~/.mux/plans/cmux/plan.md",
      trackedFilePaths: ["/tmp/proj/file.ts"],
      excludedItems: [],
    };

    const getPostCompactionStateMock: WorkspaceServiceTestAccess["getPostCompactionState"] = mock(
      () => Promise.resolve(postCompactionState)
    );

    svc.getInfo = getInfoMock;
    svc.getPostCompactionState = getPostCompactionStateMock;

    svc.schedulePostCompactionMetadataRefresh(workspaceId);
    svc.schedulePostCompactionMetadataRefresh(workspaceId);
    svc.schedulePostCompactionMetadataRefresh(workspaceId);

    // Debounce is short, but use a safe buffer.
    await new Promise((resolve) => setTimeout(resolve, 150));

    expect(getInfoMock).toHaveBeenCalledTimes(1);
    expect(getPostCompactionStateMock).toHaveBeenCalledTimes(1);
    expect(emitMetadata).toHaveBeenCalledTimes(1);

    const enriched = (emitMetadata as ReturnType<typeof mock>).mock.calls[0][0] as {
      postCompaction?: { planPath: string | null };
    };
    expect(enriched.postCompaction?.planPath).toBe(postCompactionState.planPath);
  });
});

describe("WorkspaceService maybePersistAISettingsFromOptions", () => {
  let workspaceService: WorkspaceService;
  let historyService: HistoryService;
  let cleanupHistory: () => Promise<void>;

  beforeEach(async () => {
    const aiService: AIService = {
      ...createStreamLifecycleMocks(),
      isStreaming: mock(() => false),
      getWorkspaceMetadata: mock(() => Promise.resolve({ success: false as const, error: "nope" })),
      on(_eventName: string | symbol, _listener: (...args: unknown[]) => void) {
        return this;
      },
      off(_eventName: string | symbol, _listener: (...args: unknown[]) => void) {
        return this;
      },
    } as unknown as AIService;

    ({ historyService, cleanup: cleanupHistory } = await createTestHistoryService());

    const workspacePath = "/tmp/proj/ws";
    const projectPath = "/tmp/proj";
    const mockConfig: MockWorkspaceConfig = {
      srcDir: "/tmp/test",
      sessionsDir: "/tmp/test/sessions",
      generateStableId: mock(() => "test-id"),
      findWorkspace: mock((workspaceId: string) =>
        workspaceId === "ws" ? { projectPath, workspacePath } : null
      ),
      loadConfigOrDefault: mock(() => ({
        projects: new Map([
          [
            projectPath,
            {
              workspaces: [
                {
                  id: "ws",
                  path: workspacePath,
                  name: "ws",
                },
              ],
            },
          ],
        ]),
      })),
    };
    const mockInitStateManager: Partial<InitStateManager> = {
      on: mock(() => undefined as unknown as InitStateManager),
      getInitState: mock(() => undefined),
    };
    workspaceService = createWorkspaceServiceForTest({
      config: mockConfig,
      historyService,
      aiService,
      initStateManager: mockInitStateManager as InitStateManager,
    });
  });

  afterEach(async () => {
    await cleanupHistory();
  });

  test("refuses unpriced model persistence for budgeted active goals", async () => {
    workspaceService.setWorkspaceGoalService({
      getGoal: mock(() => Promise.resolve({ status: "active", budgetCents: 500 })),
    } as unknown as WorkspaceGoalService);

    const result = await workspaceService.updateAgentAISettings("ws", "exec", {
      model: "openai:not-priced-model",
      thinkingLevel: "off",
    });

    expect(result).toEqual({
      success: false,
      error: "Target model has no pricing data. Pick a priced model before switching.",
    });
  });

  test("allows unpriced model persistence when no budgeted goal is active", async () => {
    const persistSpy = mock(() => Promise.resolve({ success: true as const, data: true }));
    workspaceService.setWorkspaceGoalService({
      // No goal record (or one without a budget) — the gate must pass through.
      getGoal: mock(() => Promise.resolve(null)),
    } as unknown as WorkspaceGoalService);
    (
      workspaceService as unknown as {
        persistWorkspaceAISettingsForAgent: (...args: unknown[]) => unknown;
      }
    ).persistWorkspaceAISettingsForAgent = persistSpy;

    const result = await workspaceService.updateAgentAISettings("ws", "exec", {
      model: "openai:not-priced-model",
      thinkingLevel: "off",
    });

    expect(result.success).toBe(true);
    expect(persistSpy).toHaveBeenCalledTimes(1);
  });

  test("persists agent AI settings for custom agent", async () => {
    const persistSpy = mock(() => Promise.resolve({ success: true as const, data: true }));

    interface WorkspaceServiceTestAccess {
      maybePersistAISettingsFromOptions: (workspaceId: string, options: unknown) => Promise<void>;
      persistWorkspaceAISettingsForAgent: (...args: unknown[]) => unknown;
    }

    const svc = workspaceService as unknown as WorkspaceServiceTestAccess;
    svc.persistWorkspaceAISettingsForAgent = persistSpy;

    await svc.maybePersistAISettingsFromOptions("ws", {
      agentId: "reviewer",
      model: "openai:gpt-4o-mini",
      thinkingLevel: "off",
    });

    expect(persistSpy).toHaveBeenCalledTimes(1);
  });

  test("persists agent AI settings when agentId matches", async () => {
    const persistSpy = mock(() => Promise.resolve({ success: true as const, data: true }));

    interface WorkspaceServiceTestAccess {
      maybePersistAISettingsFromOptions: (workspaceId: string, options: unknown) => Promise<void>;
      persistWorkspaceAISettingsForAgent: (...args: unknown[]) => unknown;
    }

    const svc = workspaceService as unknown as WorkspaceServiceTestAccess;
    svc.persistWorkspaceAISettingsForAgent = persistSpy;

    await svc.maybePersistAISettingsFromOptions("ws", {
      agentId: "exec",
      model: "openai:gpt-4o-mini",
      thinkingLevel: "off",
    });

    expect(persistSpy).toHaveBeenCalledTimes(1);
  });

  test("persists AI settings for sub-agent workspaces so auto-resume can use latest model", async () => {
    const persistSpy = mock(() => Promise.resolve({ success: true as const, data: true }));

    interface WorkspaceServiceTestAccess {
      maybePersistAISettingsFromOptions: (workspaceId: string, options: unknown) => Promise<void>;
      persistWorkspaceAISettingsForAgent: (...args: unknown[]) => unknown;
      config: {
        findWorkspace: (
          workspaceId: string
        ) => { projectPath: string; workspacePath: string } | null;
        loadConfigOrDefault: () => {
          projects: Map<string, { workspaces: Array<Record<string, unknown>> }>;
        };
      };
    }

    const svc = workspaceService as unknown as WorkspaceServiceTestAccess;
    svc.persistWorkspaceAISettingsForAgent = persistSpy;

    const projectPath = "/tmp/proj";
    const workspacePath = "/tmp/proj/ws";
    svc.config.findWorkspace = mock((workspaceId: string) =>
      workspaceId === "ws" ? { projectPath, workspacePath } : null
    );
    svc.config.loadConfigOrDefault = mock(() => ({
      projects: new Map([
        [
          projectPath,
          {
            workspaces: [
              {
                id: "ws",
                path: workspacePath,
                name: "ws",
                parentWorkspaceId: "parent-ws",
              },
            ],
          },
        ],
      ]),
    }));

    await svc.maybePersistAISettingsFromOptions("ws", {
      agentId: "exec",
      model: "openai:gpt-4o-mini",
      thinkingLevel: "off",
    });

    expect(persistSpy).toHaveBeenCalledTimes(1);
    expect(persistSpy).toHaveBeenCalledWith(
      "ws",
      "exec",
      { model: "openai:gpt-4o-mini", thinkingLevel: "off" },
      { persistSelectedAgentId: true }
    );
  });
});

// ---------------------------------------------------------------------------
// assertPricedModelForBudgetedGoal — pre-stream gate that rejects unpriced
// models for budgeted resumable goals (active/paused/budget_limited).
//
// Codex P1 (PRRT_kwDOPxxmWM5_sN02) flagged that a persistence-only skip is
// not enough: the request still flows into session.sendMessage and accounting
// records 0 cost on an unpriced model, silently bypassing budget enforcement.
// These tests pin the new pre-dispatch gate so a future regression that puts
// the check back inside maybePersistAISettingsFromOptions is caught.
// ---------------------------------------------------------------------------
describe("WorkspaceService assertPricedModelForBudgetedGoal", () => {
  interface GateOptions {
    model?: string;
    skipAiSettingsPersistence?: boolean;
  }
  interface GateAccess {
    assertPricedModelForBudgetedGoal: (
      workspaceId: string,
      options: GateOptions | undefined
    ) => Promise<Result<void, SendMessageError>>;
  }
  const UNPRICED = "openai:not-priced-model";
  const PRICED = "openai:gpt-4o-mini";
  let workspaceService: WorkspaceService;
  let cleanupHistory: () => Promise<void>;

  async function makeService(): Promise<WorkspaceService> {
    const aiService = {
      ...createStreamLifecycleMocks(),
      isStreaming: mock(() => false),
      on: mock(() => undefined),
      off: mock(() => undefined),
    } as unknown as AIService;
    const { historyService, cleanup } = await createTestHistoryService();
    cleanupHistory = cleanup;
    return new WorkspaceService(
      {
        srcDir: "/tmp/test",
        sessionsDir: "/tmp/test/sessions",
        generateStableId: mock(() => "test-id"),
        findWorkspace: mock(() => null),
      } as unknown as Config,
      historyService,
      aiService,
      {
        on: mock(() => undefined),
        getInitState: mock(() => undefined),
      } as unknown as InitStateManager,
      {} as ExtensionMetadataService,
      { cleanup: mock(() => Promise.resolve()) } as unknown as BackgroundProcessManager
    );
  }

  function setGoal(goal: GoalRecordV1 | null): void {
    // Mock the canonical WorkspaceGoalService.assertPricedModelForBudgetedGoal
    // by composing the same primitives the real implementation uses (model
    // pricing + hasBudgetedResumableGoal). This keeps the gate behaviour in
    // one place — the test still exercises the WS-side delegation contract.
    const fakeGoalService: Pick<
      WorkspaceGoalService,
      "getGoal" | "assertPricedModelForBudgetedGoal"
    > = {
      getGoal: mock(() => Promise.resolve(goal)),
      assertPricedModelForBudgetedGoal: mock((_workspaceId: string, model?: string) => {
        if (!model || modelHasPricingData(model)) {
          return Promise.resolve(Ok(undefined));
        }
        if (!hasBudgetedResumableGoal(goal)) {
          return Promise.resolve(Ok(undefined));
        }
        return Promise.resolve(
          Err({ type: "unknown" as const, raw: UNPRICED_TARGET_MODEL_GOAL_MESSAGE })
        );
      }),
    };
    workspaceService.setWorkspaceGoalService(fakeGoalService as unknown as WorkspaceGoalService);
  }

  function callGate(options: GateOptions | undefined): Promise<Result<void, SendMessageError>> {
    return (workspaceService as unknown as GateAccess).assertPricedModelForBudgetedGoal(
      "ws",
      options
    );
  }

  beforeEach(async () => {
    workspaceService = await makeService();
  });

  afterEach(async () => {
    await cleanupHistory();
  });

  test.each([
    ["active", { status: "active" as const, budgetCents: 500 }],
    ["paused", { status: "paused" as const, budgetCents: 500 }],
    ["budget_limited", { status: "budget_limited" as const, budgetCents: 500 }],
  ])("rejects unpriced model on %s budgeted goal", async (_label, partial) => {
    setGoal(partial as unknown as GoalRecordV1);
    const result = await callGate({ model: UNPRICED });
    expect(result.success).toBe(false);
    if (!result.success) {
      const error = result.error;
      expect(typeof error === "object" && error.type === "unknown").toBe(true);
      if (typeof error === "object" && error.type === "unknown") {
        expect(error.raw).toContain("Target model has no pricing data");
      }
    }
  });

  test("allows priced models even on budgeted active goals", async () => {
    setGoal({ status: "active", budgetCents: 500 } as unknown as GoalRecordV1);
    const result = await callGate({ model: PRICED });
    expect(result.success).toBe(true);
  });

  test("allows when no goal exists", async () => {
    setGoal(null);
    const result = await callGate({ model: UNPRICED });
    expect(result.success).toBe(true);
  });

  test("allows when goal has no budget", async () => {
    setGoal({ status: "active", budgetCents: null } as unknown as GoalRecordV1);
    const result = await callGate({ model: UNPRICED });
    expect(result.success).toBe(true);
  });

  test("allows terminal goals (complete) regardless of model", async () => {
    setGoal({ status: "complete", budgetCents: 500 } as unknown as GoalRecordV1);
    const result = await callGate({ model: UNPRICED });
    expect(result.success).toBe(true);
  });

  test("ignores client-controlled skipAiSettingsPersistence flag", async () => {
    // Codex P1 (PRRT_kwDOPxxmWM5_sh1R): `skipAiSettingsPersistence` is part
    // of the public SendMessageOptionsSchema and forwarded verbatim by the
    // router, so a direct API caller could otherwise flip this single bool
    // to disarm the gate while running an unpriced model on a budgeted goal.
    // The gate must reject regardless of the flag.
    setGoal({ status: "active", budgetCents: 500 } as unknown as GoalRecordV1);
    const result = await callGate({ model: UNPRICED, skipAiSettingsPersistence: true });
    expect(result.success).toBe(false);
    if (!result.success) {
      const error = result.error;
      expect(typeof error === "object" && error.type === "unknown").toBe(true);
      if (typeof error === "object" && error.type === "unknown") {
        expect(error.raw).toContain("Target model has no pricing data");
      }
    }
  });

  test("delegates to WorkspaceGoalService.assertPricedModelForBudgetedGoal", async () => {
    // Pin the WS → WorkspaceGoalService delegation contract: WS must not
    // re-implement the gate, otherwise we'd reintroduce the original bug
    // where queued messages bypassed it. See workspaceGoalService.test.ts
    // for the canonical priced-model short-circuit + rejection coverage.
    const assertPricedModelForBudgetedGoal = mock(() =>
      Promise.resolve(Ok(undefined) as Result<void, SendMessageError>)
    );
    workspaceService.setWorkspaceGoalService({
      getGoal: mock(() => Promise.resolve(null)),
      assertPricedModelForBudgetedGoal,
    } as unknown as WorkspaceGoalService);

    const result = await callGate({ model: PRICED });

    expect(result.success).toBe(true);
    expect(assertPricedModelForBudgetedGoal).toHaveBeenCalledTimes(1);
    expect(assertPricedModelForBudgetedGoal).toHaveBeenCalledWith("ws", PRICED);
  });

  test("allows when no model is provided (caller will fall back later)", async () => {
    setGoal({ status: "active", budgetCents: 500 } as unknown as GoalRecordV1);
    const result = await callGate({});
    expect(result.success).toBe(true);
  });
});

describe("WorkspaceService remove lifecycle coordination", () => {
  test("acknowledged removal keeps the parent last and returns forced failure scope", async () => {
    const { config, historyService, cleanup } = await createTestHistoryService();
    const workspaceService = createWorkspaceServiceForTest({ config, historyService });
    let notifications = 0;
    const unsubscribe = config.onConfigChanged(() => {
      notifications += 1;
    });
    const descendants = [{ workspaceId: "child", title: "Child", active: true }];
    const order: string[] = [];
    let locked = false;
    let blocked = true;
    const removeDescendants = mock(async () => {
      expect(locked).toBe(true);
      const before = notifications;
      order.push("descendants");
      await config.editConfig((value) => value);
      await config.editConfig((value) => value);
      expect(notifications).toBe(before);
      return blocked ? Err("active child") : Ok(undefined);
    });
    workspaceService.setAgentTaskIntegration(
      makeAgentTaskIntegrationFake({
        withTaskTreeLifecycleLock: async <T>(
          _id: string,
          operation: () => Promise<T>
        ): Promise<T> => {
          expect(locked).toBe(false);
          locked = true;
          try {
            return await operation();
          } finally {
            locked = false;
          }
        },
        listWorkspaceRemovalDescendants: () => descendants,
        removeAcknowledgedDescendantsWhileTaskTreeLocked: removeDescendants,
      })
    );
    const removeParent = spyOn(
      workspaceService as unknown as {
        removeUnlocked(id: string, force: boolean): Promise<Result<void>>;
      },
      "removeUnlocked"
    ).mockImplementation(async () => {
      expect(locked).toBe(true);
      order.push("parent");
      await config.editConfig((value) => value);
      return Err("parent failure");
    });
    expect(
      await workspaceService.remove("parent", true, { acknowledgedDescendantIds: ["child"] })
    ).toEqual({
      success: false,
      error: "active child",
      descendants,
    });
    expect(removeParent).not.toHaveBeenCalled();
    blocked = false;
    expect(
      await workspaceService.remove("parent", true, { acknowledgedDescendantIds: ["child"] })
    ).toEqual({
      success: false,
      error: "parent failure",
      descendants,
    });
    expect(order).toEqual(["descendants", "descendants", "parent"]);
    expect(notifications).toBe(2);
    removeDescendants.mockClear();
    expect(await workspaceService.remove("parent", true)).toEqual({
      success: false,
      error: "parent failure",
      descendants,
    });
    expect(removeDescendants).not.toHaveBeenCalled();
    expect(notifications).toBe(3);
    unsubscribe();
    removeParent.mockRestore();
    await cleanup();
  });

  test("checks descendant tasks while holding the task-tree lifecycle lock", async () => {
    const workspaceId = "parent-remove-lifecycle";
    const workspaceService = createWorkspaceServiceForTest({
      config: {
        findWorkspace: mock(() => null),
      },
    });
    let insideLifecycleLock = false;
    const withTaskTreeLifecycleLock = mock(
      (_workspaceId: string, _operation: () => Promise<unknown>) => undefined
    );
    const runWithTaskTreeLifecycleLock = async <T>(
      workspaceId: string,
      operation: () => Promise<T>
    ): Promise<T> => {
      withTaskTreeLifecycleLock(workspaceId, operation);
      insideLifecycleLock = true;
      try {
        return await operation();
      } finally {
        insideLifecycleLock = false;
      }
    };
    const hasDescendantAgentTasks = mock(() => {
      expect(insideLifecycleLock).toBe(true);
      return true;
    });
    workspaceService.setAgentTaskIntegration(
      makeAgentTaskIntegrationFake({
        withTaskTreeLifecycleLock: runWithTaskTreeLifecycleLock,
        hasDescendantAgentTasks,
      })
    );

    expect(await workspaceService.remove(workspaceId, true)).toEqual(
      Err(
        "This workspace has descendant sub-agent workspaces. Remove those descendants deepest-first before removing their parent."
      )
    );
    expect(withTaskTreeLifecycleLock).toHaveBeenCalledWith(workspaceId, expect.any(Function));
    expect(hasDescendantAgentTasks).toHaveBeenCalledWith(workspaceId);
  });
});

describe("WorkspaceService registration-time plugin override sanitization", () => {
  // A LocalRuntime checkout preserves .mux/mcp.local.jsonc across workspace
  // removal, and a removed workspace is invisible to the Agent Plugin
  // uninstaller's pruning/tombstones. Consent dies with the workspace:
  // registering the directory as a NEW workspace sanitizes canonical plugin
  // keys — unless a live sibling still resolves to the same path (its consent
  // context is alive), and a failed sanitize aborts creation instead of
  // silently activating stale enables.
  interface SanitizeAccess {
    sanitizeStalePluginOverridesForNewWorkspace(
      workspaceId: string,
      workspacePath: string,
      persistentSiblingConfig?: Pick<Config, "loadConfigOrDefault">
    ): Promise<string | undefined>;
    pendingPluginSanitizations: Set<string>;
    rollbackUnsanitizedWorkspaceRegistration(workspaceId: string): Promise<boolean>;
  }

  function makeService(
    existingWorkspaces: Array<{ id: string; path: string; runtimeConfig?: unknown }>
  ): WorkspaceService {
    return createWorkspaceServiceForTest({
      config: {
        srcDir: "/tmp/src",
        loadConfigOrDefault: mock(() => ({
          projects: new Map([["/tmp/proj", { workspaces: existingWorkspaces }]]),
        })),
      } as unknown as Config,
    });
  }

  test("sanitizes canonical plugin keys when no sibling shares the path", async () => {
    const service = makeService([{ id: "ws-new", path: "/tmp/proj" }]);
    const pruned: string[] = [];
    service.setWorkspaceMcpOverridesService({
      acquireExclusiveLock: () => Promise.resolve(() => Promise.resolve()),
      prunePluginOverrideKeys: (workspaceId, keyPrefix) => {
        pruned.push(`${workspaceId}:${keyPrefix}`);
        return Promise.resolve();
      },
    });
    const error = await (
      service as unknown as SanitizeAccess
    ).sanitizeStalePluginOverridesForNewWorkspace("ws-new", "/tmp/proj");
    expect(error).toBeUndefined();
    expect(pruned).toEqual(["ws-new:plugin:"]);
  });

  test("skips sanitization when the live sibling is only visible in the persistent config", async () => {
    // xum run / xum workflow register on an EPHEMERAL temp config whose
    // project entries carry no workspace records; a desktop workspace live on
    // the same checkout exists only in the persistent config. Pruning would
    // strip enables that live consent context still owns from the shared
    // .xum/mcp.local.jsonc — the persistent sibling must force a skip, while
    // a persistent record for a DIFFERENT checkout must not.
    const service = makeService([{ id: "ws-new", path: "/tmp/proj" }]);
    const pruned: string[] = [];
    service.setWorkspaceMcpOverridesService({
      acquireExclusiveLock: () => Promise.resolve(() => Promise.resolve()),
      prunePluginOverrideKeys: (workspaceId, keyPrefix) => {
        pruned.push(`${workspaceId}:${keyPrefix}`);
        return Promise.resolve();
      },
    });
    const persistentWith = (workspacePath: string): Pick<Config, "loadConfigOrDefault"> =>
      ({
        loadConfigOrDefault: () => ({
          projects: new Map([
            ["/tmp/proj", { workspaces: [{ id: "ws-desktop", path: workspacePath }] }],
          ]),
        }),
      }) as unknown as Pick<Config, "loadConfigOrDefault">;

    const skip = await (
      service as unknown as SanitizeAccess
    ).sanitizeStalePluginOverridesForNewWorkspace(
      "ws-new",
      "/tmp/proj",
      persistentWith("/tmp/proj")
    );
    expect(skip).toBeUndefined();
    expect(pruned).toEqual([]);

    const prune = await (
      service as unknown as SanitizeAccess
    ).sanitizeStalePluginOverridesForNewWorkspace(
      "ws-new",
      "/tmp/proj",
      persistentWith("/tmp/other")
    );
    expect(prune).toBeUndefined();
    expect(pruned).toEqual(["ws-new:plugin:"]);
  });

  test("refuses to prune when the persistent sibling config is unreadable", async () => {
    // The lenient loadConfigOrDefault swallows a malformed ~/.xum/config.json
    // into an EMPTY project map — which reads as "no live sibling" and would
    // prune enables a live desktop workspace still owns. The persistent
    // source must be read in throwing mode and sanitization must fail closed
    // (abort the registration, leave the override file untouched).
    const service = makeService([{ id: "ws-new", path: "/tmp/proj" }]);
    const pruned: string[] = [];
    service.setWorkspaceMcpOverridesService({
      acquireExclusiveLock: () => Promise.resolve(() => Promise.resolve()),
      prunePluginOverrideKeys: (workspaceId, keyPrefix) => {
        pruned.push(`${workspaceId}:${keyPrefix}`);
        return Promise.resolve();
      },
    });
    const broken = {
      loadConfigOrDefault: (options?: { throwOnError?: boolean }) => {
        if (options?.throwOnError) {
          throw new Error("config.json is malformed");
        }
        // A lenient read would hide the corruption behind an empty map.
        return { projects: new Map() };
      },
    } as unknown as Pick<Config, "loadConfigOrDefault">;
    const error = await (
      service as unknown as SanitizeAccess
    ).sanitizeStalePluginOverridesForNewWorkspace("ws-new", "/tmp/proj", broken);
    expect(error).toContain("unreadable");
    expect(pruned).toEqual([]);
  });

  test("skips sanitization while a live sibling resolves to the same path", async () => {
    // Conversation forks of a local workspace share the checkout: the
    // sibling's consent context is alive, so its enables must survive.
    const service = makeService([
      { id: "ws-sibling", path: "/tmp/proj" },
      { id: "ws-new", path: "/tmp/proj/" },
    ]);
    const pruned: string[] = [];
    service.setWorkspaceMcpOverridesService({
      acquireExclusiveLock: () => Promise.resolve(() => Promise.resolve()),
      prunePluginOverrideKeys: (workspaceId, keyPrefix) => {
        pruned.push(`${workspaceId}:${keyPrefix}`);
        return Promise.resolve();
      },
    });
    const error = await (
      service as unknown as SanitizeAccess
    ).sanitizeStalePluginOverridesForNewWorkspace("ws-new", "/tmp/proj");
    expect(error).toBeUndefined();
    expect(pruned).toEqual([]);
  });

  test("a failed sanitize surfaces an error so creation aborts", async () => {
    const service = makeService([{ id: "ws-new", path: "/tmp/proj" }]);
    service.setWorkspaceMcpOverridesService({
      acquireExclusiveLock: () => Promise.resolve(() => Promise.resolve()),
      prunePluginOverrideKeys: () =>
        Promise.reject(new Error('duplicate "enabledServers" properties')),
    });
    const error = await (
      service as unknown as SanitizeAccess
    ).sanitizeStalePluginOverridesForNewWorkspace("ws-new", "/tmp/proj");
    expect(error).toContain("could not be sanitized");
    expect(error).toContain("mcp.local.jsonc");
  });

  test("an off-host workspace with an equal path string is not a sibling", async () => {
    // SSH/container paths occupy a different filesystem namespace: an equal
    // STRING proves nothing about the local overrides file, and skipping
    // would leave a stale enable to activate on the next local request.
    const service = makeService([
      { id: "ws-ssh", path: "/tmp/proj", runtimeConfig: { type: "ssh", host: "box" } },
      { id: "ws-new", path: "/tmp/proj" },
    ]);
    const pruned: string[] = [];
    service.setWorkspaceMcpOverridesService({
      acquireExclusiveLock: () => Promise.resolve(() => Promise.resolve()),
      prunePluginOverrideKeys: (workspaceId, keyPrefix) => {
        pruned.push(`${workspaceId}:${keyPrefix}`);
        return Promise.resolve();
      },
    });
    const error = await (
      service as unknown as SanitizeAccess
    ).sanitizeStalePluginOverridesForNewWorkspace("ws-new", "/tmp/proj");
    expect(error).toBeUndefined();
    expect(pruned).toEqual(["ws-new:plugin:"]);
  });

  test("a sibling registered through a symlinked spelling still forces a skip", async () => {
    // Canonical (realpath) identity, not just spelling: pruning here would
    // strip the live symlink-spelled sibling's enables from the shared file.
    const realDir = await fsPromises.mkdtemp(path.join(tmpdir(), "mux-sanitize-real-"));
    const linkPath = `${realDir}-link`;
    await fsPromises.symlink(realDir, linkPath);
    try {
      const service = makeService([
        { id: "ws-symlink-sibling", path: linkPath },
        { id: "ws-new", path: realDir },
      ]);
      const pruned: string[] = [];
      service.setWorkspaceMcpOverridesService({
        acquireExclusiveLock: () => Promise.resolve(() => Promise.resolve()),
        prunePluginOverrideKeys: (workspaceId, keyPrefix) => {
          pruned.push(`${workspaceId}:${keyPrefix}`);
          return Promise.resolve();
        },
      });
      const error = await (
        service as unknown as SanitizeAccess
      ).sanitizeStalePluginOverridesForNewWorkspace("ws-new", realDir);
      expect(error).toBeUndefined();
      expect(pruned).toEqual([]);
    } finally {
      await fsPromises.rm(linkPath, { force: true });
      await fsPromises.rm(realDir, { recursive: true, force: true });
    }
  });

  test("an overlapping registration pending its own sanitization is not a sibling", async () => {
    // Two creations for the same checkout can both persist config entries
    // before either sanitizes; a not-yet-sanitized entry is no proof of live
    // consent, so the scan must ignore it or BOTH creations skip pruning.
    const service = makeService([
      { id: "ws-concurrent", path: "/tmp/proj" },
      { id: "ws-new", path: "/tmp/proj" },
    ]);
    (service as unknown as SanitizeAccess).pendingPluginSanitizations.add("ws-concurrent");
    const pruned: string[] = [];
    service.setWorkspaceMcpOverridesService({
      acquireExclusiveLock: () => Promise.resolve(() => Promise.resolve()),
      prunePluginOverrideKeys: (workspaceId, keyPrefix) => {
        pruned.push(`${workspaceId}:${keyPrefix}`);
        return Promise.resolve();
      },
    });
    const error = await (
      service as unknown as SanitizeAccess
    ).sanitizeStalePluginOverridesForNewWorkspace("ws-new", "/tmp/proj");
    expect(error).toBeUndefined();
    expect(pruned).toEqual(["ws-new:plugin:"]);
  });

  test("rollback verification detects a swallowed config write failure", async () => {
    // Config.saveConfig logs and swallows write errors, so removeWorkspace
    // can resolve while the entry survives on disk; the rollback must verify
    // absence rather than trust the resolved promise.
    const stuckWorkspaces = [{ id: "ws-stuck", path: "/tmp/proj" }];
    const service = createWorkspaceServiceForTest({
      config: {
        removeWorkspace: mock(() => Promise.resolve()),
        loadConfigOrDefault: mock(() => ({
          projects: new Map([["/tmp/proj", { workspaces: stuckWorkspaces }]]),
        })),
      } as unknown as Config,
    });
    const access = service as unknown as SanitizeAccess;
    expect(await access.rollbackUnsanitizedWorkspaceRegistration("ws-stuck")).toBe(false);
    // A rollback that actually lands verifies clean.
    expect(await access.rollbackUnsanitizedWorkspaceRegistration("ws-gone")).toBe(true);
  });
});

describe("WorkspaceService remove timing rollup", () => {
  let historyService: HistoryService;
  let cleanupHistory: () => Promise<void>;

  beforeEach(async () => {
    ({ historyService, cleanup: cleanupHistory } = await createTestHistoryService());
  });

  afterEach(async () => {
    await cleanupHistory();
  });

  test("waits for stream-abort before rolling up session timing", async () => {
    const workspaceId = "child-ws";
    const parentWorkspaceId = "parent-ws";

    const tempRoot = await fsPromises.mkdtemp(path.join(tmpdir(), "mux-remove-"));
    const stopEntered = Promise.withResolvers<void>();
    const stopRelease = Promise.withResolvers<void>();
    try {
      const sessionRoot = path.join(tempRoot, "sessions");
      await fsPromises.mkdir(path.join(sessionRoot, workspaceId), { recursive: true });

      let abortEmitted = false;
      let rollUpSawAbort = false;

      class FakeAIService extends EventEmitter {
        isStreaming = mock(() => true);

        stopStream = mock(async () => {
          stopEntered.resolve();
          await stopRelease.promise;
          abortEmitted = true;
          this.emit("stream-abort", {
            type: "stream-abort",
            workspaceId,
            messageId: "msg",
            abortReason: "system",
            metadata: { duration: 123 },
            abandonPartial: true,
          });
          return { success: true as const, data: undefined };
        });

        getWorkspaceMetadata = mock(() =>
          Promise.resolve({
            success: true as const,
            data: {
              id: workspaceId,
              name: "child",
              projectPath: "/tmp/proj",
              runtimeConfig: { type: "local" },
              parentWorkspaceId,
            },
          })
        );
      }

      const aiService = new FakeAIService() as unknown as AIService;
      const mockConfig: MockWorkspaceConfig = {
        rootDir: path.join(tempRoot, "root"),
        srcDir: "/tmp/src",
        sessionsDir: sessionRoot,
        removeWorkspace: mock(() => Promise.resolve()),
        findWorkspace: mock(() => null),
        loadConfigOrDefault: mock(() => ({ projects: new Map() })),
      };

      const timingService: Partial<SessionTimingService> = {
        waitForIdle: mock(() => Promise.resolve()),
        rollUpTimingIntoParent: mock(() => {
          rollUpSawAbort = abortEmitted;
          return Promise.resolve({ didRollUp: true });
        }),
      };

      const workspaceService = new WorkspaceService(
        withExistingConfigLoader(mockConfig) as Config,
        historyService,
        aiService,
        mockInitStateManager as InitStateManager,
        mockExtensionMetadataService as ExtensionMetadataService,
        mockBackgroundProcessManager as BackgroundProcessManager,
        undefined, // sessionUsageService
        undefined, // policyService
        undefined, // telemetryService
        undefined, // experimentsService
        timingService as SessionTimingService
      );

      const removing = workspaceService.remove(workspaceId, true);
      await stopEntered.promise;
      expect(timingService.rollUpTimingIntoParent).not.toHaveBeenCalled();
      stopRelease.resolve();
      const removeResult = await removing;
      expect(removeResult.success).toBe(true);
      expect(mockInitStateManager.clearInMemoryState).toHaveBeenCalledWith(workspaceId);
      expect(rollUpSawAbort).toBe(true);
    } finally {
      stopRelease.resolve();
      await fsPromises.rm(tempRoot, { recursive: true, force: true });
    }
  });
});

describe("WorkspaceService remove sub-agent handover ordering", () => {
  // A sub-agent's final shared-memory handover + removal tombstone are sealed
  // under the removal locks BEFORE the checkout is deleted: a handover the
  // owner store cannot take aborts with the checkout intact, and a refused
  // checkout deletion rolls the tombstone back.
  const projectPath = "/tmp/proj-handover";
  const workspaceId = "child-handover";
  const ownerId = "owner-handover";
  const workspacePath = path.join(projectPath, "child-ws");
  const runtimeConfig = { type: "worktree" as const, srcBaseDir: "/tmp/src" };
  let rootDir: string;

  beforeEach(async () => {
    rootDir = path.join(tmpdir(), "mux-handover-order", `root-${crypto.randomUUID()}`);
    await fsPromises.mkdir(path.join(rootDir, "sessions", workspaceId), { recursive: true });
  });
  afterEach(async () => {
    await fsPromises.rm(rootDir, { recursive: true, force: true });
  });

  function buildConfig(): Partial<Config> {
    const topology = {
      projects: new Map([
        [
          projectPath,
          {
            trusted: true,
            workspaces: [
              {
                id: ownerId,
                name: "owner",
                path: path.join(projectPath, "owner-ws"),
                runtimeConfig,
              },
              {
                id: workspaceId,
                name: "child",
                path: workspacePath,
                runtimeConfig,
                parentWorkspaceId: ownerId,
              },
            ],
          },
        ],
      ]),
    };
    return {
      rootDir,
      srcDir: "/tmp/src",
      sessionsDir: path.join(rootDir, "sessions"),
      removeWorkspace: mock(() => Promise.resolve()),
      findWorkspace: mock(() => ({ workspacePath, projectPath })),
      loadConfigOrDefault: mock(() => topology),
      editConfig: mock((edit: (cfg: typeof topology) => typeof topology) =>
        Promise.resolve(edit(topology))
      ),
    } as unknown as Partial<Config>;
  }

  function buildAiService(): AIService {
    return {
      ...createStreamLifecycleMocks(),
      isStreaming: mock(() => false),
      stopStream: mock(() => Promise.resolve(Ok(undefined))),
      getWorkspaceMetadata: mock(() =>
        Promise.resolve(
          Ok({
            id: workspaceId,
            name: "child",
            projectPath,
            projectName: "proj",
            runtimeConfig,
            parentWorkspaceId: ownerId,
          })
        )
      ),
      on: mock(() => undefined),
      off: mock(() => undefined),
    } as unknown as AIService;
  }

  test("a handover the owner cannot take aborts before the checkout is deleted", async () => {
    const deleteWorkspace = mock(() =>
      Promise.resolve({ success: true as const, deletedPath: workspacePath })
    );
    const createRuntimeSpy = spyOn(runtimeFactory, "createRuntime").mockReturnValue({
      deleteWorkspace,
    } as unknown as ReturnType<typeof runtimeFactory.createRuntime>);
    try {
      const workspaceService = createWorkspaceServiceForTest({
        config: buildConfig(),
        aiService: buildAiService(),
      });
      let adoptions = 0;
      workspaceService.setSharedWorkspaceMemoryStore({
        adoptLegacyPrivateStoreForRemoval: (_child, _owner, options) => {
          adoptions++;
          // The unlocked pre-pass succeeds; the late note appears for the
          // locked pass, which cannot place it.
          return options?.locksHeld
            ? Promise.reject(new Error("1 legacy note could not be folded"))
            : Promise.resolve();
        },
      });
      const result = await workspaceService.remove(workspaceId);
      expect(result.success).toBe(false);
      if (!result.success) expect(result.error).toContain("could not be folded");
      expect(adoptions).toBe(2);
      expect(deleteWorkspace).not.toHaveBeenCalled();
      expect(existsSync(path.join(rootDir, "sessions", workspaceId))).toBe(true);
      expect(await isWorkspaceRemovalTombstoned(rootDir, workspaceId)).toBe(false);
      // force accepts the loss and completes the removal.
      expect((await workspaceService.remove(workspaceId, true)).success).toBe(true);
      expect(deleteWorkspace).toHaveBeenCalledTimes(1);
      expect(existsSync(path.join(rootDir, "sessions", workspaceId))).toBe(false);
    } finally {
      createRuntimeSpy.mockRestore();
    }
  });

  test("a refused checkout deletion rolls the sealed tombstone back", async () => {
    let refuse = true;
    const deleteWorkspace = mock(() =>
      Promise.resolve(
        refuse
          ? { success: false as const, error: "Workspace has uncommitted changes" }
          : { success: true as const, deletedPath: workspacePath }
      )
    );
    const createRuntimeSpy = spyOn(runtimeFactory, "createRuntime").mockReturnValue({
      deleteWorkspace,
    } as unknown as ReturnType<typeof runtimeFactory.createRuntime>);
    try {
      const workspaceService = createWorkspaceServiceForTest({
        config: buildConfig(),
        aiService: buildAiService(),
      });
      let sealedTombstone = false;
      workspaceService.setSharedWorkspaceMemoryStore({
        adoptLegacyPrivateStoreForRemoval: () => Promise.resolve(),
      });
      deleteWorkspace.mockImplementation(async () => {
        // Runtime deletion runs with the tombstone already sealed.
        sealedTombstone = await isWorkspaceRemovalTombstoned(rootDir, workspaceId);
        return refuse
          ? { success: false as const, error: "Workspace has uncommitted changes" }
          : { success: true as const, deletedPath: workspacePath };
      });
      const refused = await workspaceService.remove(workspaceId);
      expect(refused.success).toBe(false);
      if (!refused.success) expect(refused.error).toContain("uncommitted changes");
      expect(sealedTombstone).toBe(true);
      expect(await isWorkspaceRemovalTombstoned(rootDir, workspaceId)).toBe(false);
      expect(existsSync(path.join(rootDir, "sessions", workspaceId))).toBe(true);
      refuse = false;
      expect((await workspaceService.remove(workspaceId)).success).toBe(true);
      expect(await isWorkspaceRemovalTombstoned(rootDir, workspaceId)).toBe(true);
    } finally {
      createRuntimeSpy.mockRestore();
    }
  });
});

describe("WorkspaceService remove shared-workspace guard", () => {
  const projectPath = "/tmp/proj-shared";
  const workspaceId = "child-shared";
  const sharedPath = path.join(projectPath, "parent-ws");
  const runtimeConfig = { type: "worktree" as const, srcBaseDir: "/tmp/src" };

  function buildConfig(taskIsolation?: "none" | "fork"): Partial<Config> {
    return {
      // Unique per-build root: removal publishes durable tombstones under
      // <rootDir>/locks, which must not leak across tests or runs.
      rootDir: path.join(tmpdir(), "mux-shared-guard", `root-${crypto.randomUUID()}`),
      srcDir: "/tmp/src",
      sessionsDir: path.join(tmpdir(), "mux-shared-guard"),
      removeWorkspace: mock(() => Promise.resolve()),
      findWorkspace: mock(() => ({ workspacePath: sharedPath, projectPath })),
      loadConfigOrDefault: mock(() => ({
        projects: new Map([
          [
            projectPath,
            {
              trusted: true,
              workspaces: [
                {
                  id: workspaceId,
                  name: "agent_explore_child",
                  path: sharedPath,
                  runtimeConfig,
                  taskIsolation,
                },
              ],
            },
          ],
        ]),
      })),
    } as unknown as Partial<Config>;
  }

  function buildAiService(): AIService {
    class FakeAIService extends EventEmitter {
      isStreaming = mock(() => false);
      stopStream = mock(() => Promise.resolve({ success: true as const, data: undefined }));
      getWorkspaceMetadata = mock(() =>
        Promise.resolve({
          success: true as const,
          data: {
            id: workspaceId,
            name: "agent_explore_child",
            projectPath,
            runtimeConfig,
          },
        })
      );
    }
    return new FakeAIService() as unknown as AIService;
  }

  test("does not delete the shared parent checkout for isolation: none tasks", async () => {
    const deleteWorkspace = mock(() =>
      Promise.resolve({ success: true as const, deletedPath: sharedPath })
    );
    const createRuntimeSpy = spyOn(runtimeFactory, "createRuntime").mockReturnValue({
      deleteWorkspace,
    } as unknown as ReturnType<typeof runtimeFactory.createRuntime>);
    try {
      const workspaceService = createWorkspaceServiceForTest({
        config: buildConfig("none"),
        aiService: buildAiService(),
      });

      const result = await workspaceService.remove(workspaceId, true);
      expect(result.success).toBe(true);
      // The parent's checkout must never be physically deleted on behalf of a shared task.
      expect(deleteWorkspace).not.toHaveBeenCalled();
    } finally {
      createRuntimeSpy.mockRestore();
    }
  });

  test("deletes the workspace for normal (forked) tasks", async () => {
    const deleteWorkspace = mock(() =>
      Promise.resolve({ success: true as const, deletedPath: sharedPath })
    );
    const createRuntimeSpy = spyOn(runtimeFactory, "createRuntime").mockReturnValue({
      deleteWorkspace,
    } as unknown as ReturnType<typeof runtimeFactory.createRuntime>);
    try {
      const workspaceService = createWorkspaceServiceForTest({
        config: buildConfig(undefined),
        aiService: buildAiService(),
      });

      const result = await workspaceService.remove(workspaceId, true);
      expect(result.success).toBe(true);
      expect(deleteWorkspace).toHaveBeenCalledTimes(1);
    } finally {
      createRuntimeSpy.mockRestore();
    }
  });

  // Inverse direction: removing the PARENT while a live shared child points at its checkout.
  function buildParentConfig(childTaskStatus: string): Partial<Config> {
    return {
      rootDir: path.join(tmpdir(), "mux-shared-guard", `root-${crypto.randomUUID()}`),
      srcDir: "/tmp/src",
      sessionsDir: path.join(tmpdir(), "mux-shared-guard"),
      removeWorkspace: mock(() => Promise.resolve()),
      findWorkspace: mock(() => ({ workspacePath: sharedPath, projectPath })),
      loadConfigOrDefault: mock(() => ({
        projects: new Map([
          [
            projectPath,
            {
              trusted: true,
              workspaces: [
                {
                  id: "parent-ws-id",
                  name: "parent-ws",
                  path: sharedPath,
                  runtimeConfig,
                },
                {
                  id: workspaceId,
                  name: "agent_explore_child",
                  path: sharedPath,
                  runtimeConfig,
                  parentWorkspaceId: "parent-ws-id",
                  taskIsolation: "none",
                  taskStatus: childTaskStatus,
                },
              ],
            },
          ],
        ]),
      })),
    } as unknown as Partial<Config>;
  }

  function buildParentAiService(): AIService {
    class FakeAIService extends EventEmitter {
      isStreaming = mock(() => false);
      stopStream = mock(() => Promise.resolve({ success: true as const, data: undefined }));
      getWorkspaceMetadata = mock(() =>
        Promise.resolve({
          success: true as const,
          data: {
            id: "parent-ws-id",
            name: "parent-ws",
            projectPath,
            runtimeConfig,
          },
        })
      );
    }
    return new FakeAIService() as unknown as AIService;
  }

  test("does not delete a parent checkout shared by an active isolation: none child", async () => {
    const deleteWorkspace = mock(() =>
      Promise.resolve({ success: true as const, deletedPath: sharedPath })
    );
    const createRuntimeSpy = spyOn(runtimeFactory, "createRuntime").mockReturnValue({
      deleteWorkspace,
    } as unknown as ReturnType<typeof runtimeFactory.createRuntime>);
    try {
      const workspaceService = createWorkspaceServiceForTest({
        config: buildParentConfig("running"),
        aiService: buildParentAiService(),
      });

      const result = await workspaceService.remove("parent-ws-id", true);
      expect(result.success).toBe(true);
      // The running shared child still uses this checkout as its cwd.
      expect(deleteWorkspace).not.toHaveBeenCalled();
    } finally {
      createRuntimeSpy.mockRestore();
    }
  });

  test("deletes a parent checkout when its shared child is only queued (fails fast at dequeue like forked tasks)", async () => {
    const deleteWorkspace = mock(() =>
      Promise.resolve({ success: true as const, deletedPath: sharedPath })
    );
    const createRuntimeSpy = spyOn(runtimeFactory, "createRuntime").mockReturnValue({
      deleteWorkspace,
    } as unknown as ReturnType<typeof runtimeFactory.createRuntime>);
    try {
      const workspaceService = createWorkspaceServiceForTest({
        config: buildParentConfig("queued"),
        aiService: buildParentAiService(),
      });

      const result = await workspaceService.remove("parent-ws-id", true);
      expect(result.success).toBe(true);
      // Queued children require the parent config entry to launch regardless of isolation, so
      // they fail fast at dequeue either way — preserving the checkout would only leak it.
      expect(deleteWorkspace).toHaveBeenCalledTimes(1);
    } finally {
      createRuntimeSpy.mockRestore();
    }
  });

  test("deletes a parent checkout when its shared child already reported", async () => {
    const deleteWorkspace = mock(() =>
      Promise.resolve({ success: true as const, deletedPath: sharedPath })
    );
    const createRuntimeSpy = spyOn(runtimeFactory, "createRuntime").mockReturnValue({
      deleteWorkspace,
    } as unknown as ReturnType<typeof runtimeFactory.createRuntime>);
    try {
      const workspaceService = createWorkspaceServiceForTest({
        config: buildParentConfig("reported"),
        aiService: buildParentAiService(),
      });

      const result = await workspaceService.remove("parent-ws-id", true);
      expect(result.success).toBe(true);
      expect(deleteWorkspace).toHaveBeenCalledTimes(1);
    } finally {
      createRuntimeSpy.mockRestore();
    }
  });
});

describe("WorkspaceService remove desktop session cleanup", () => {
  const workspaceId = "ws-remove-desktop";

  let historyService: HistoryService;
  let cleanupHistory: () => Promise<void>;
  let workspaceService: WorkspaceService;
  let removeWorkspaceMock: ReturnType<typeof mock>;
  let tempRoot: string;

  beforeEach(async () => {
    ({ historyService, cleanup: cleanupHistory } = await createTestHistoryService());
    tempRoot = await fsPromises.mkdtemp(path.join(tmpdir(), "mux-remove-desktop-"));
    removeWorkspaceMock = mock(() => Promise.resolve());

    const aiService: AIService = {
      ...createStreamLifecycleMocks(),
      isStreaming: mock(() => false),
      stopStream: mock(() => Promise.resolve(Ok(undefined))),
      getWorkspaceMetadata: mock(() => Promise.resolve(Err("not found"))),
      // eslint-disable-next-line @typescript-eslint/no-empty-function
      on: mock(() => {}),
      // eslint-disable-next-line @typescript-eslint/no-empty-function
      off: mock(() => {}),
    } as unknown as AIService;

    const mockConfig: MockWorkspaceConfig = {
      srcDir: "/tmp/src",
      // r63: removal serializes session-dir deletion with the memory target
      // locks and removal tombstones under `<rootDir>/locks`.
      rootDir: tempRoot,
      sessionsDir: path.join(tempRoot, "sessions"),
      removeWorkspace: removeWorkspaceMock,
      findWorkspace: mock(() => null),
      loadConfigOrDefault: mock(() => ({ projects: new Map() })),
    };

    workspaceService = createWorkspaceServiceForTest({
      config: mockConfig,
      historyService,
      aiService,
      initStateManager: mockInitStateManager as InitStateManager,
    });
  });

  afterEach(async () => {
    await fsPromises.rm(tempRoot, { recursive: true, force: true });
    await cleanupHistory();
  });

  test("remove() closes desktop sessions on success", async () => {
    let guard: ((workspaceId: string) => boolean) | undefined;
    const guardDuringClose: { value?: boolean } = {};
    const close = mock(() => {
      // Desktop startups consult this guard synchronously; a borrower bridge connecting between
      // the close and the awaited config deletion must be refused just like during archive.
      guardDuringClose.value = guard?.(workspaceId);
      return Promise.resolve(undefined);
    });
    const desktopSessionManager = {
      close,
      setWorkspaceArchiveGuard: (next: (workspaceId: string) => boolean) => {
        guard = next;
      },
    } as unknown as DesktopSessionManager;
    workspaceService.setDesktopSessionManager(desktopSessionManager);
    expect(guard?.(workspaceId)).toBe(false);

    const result = await workspaceService.remove(workspaceId);

    expect(result.success).toBe(true);
    expect(guardDuringClose.value).toBe(true);
    expect(close).toHaveBeenCalledTimes(1);
    expect(close).toHaveBeenCalledWith(workspaceId);
  });

  test("remove() reopens the timeline when removal aborts with the workspace still configured", async () => {
    await fsPromises.mkdir(path.join(tempRoot, "sessions", workspaceId), { recursive: true });
    const reopened: string[] = [];
    workspaceService.setTimelineRecorder({
      record: () => undefined,
      closeWorkspace: () => Promise.resolve(),
      reopenWorkspace: (id) => reopened.push(id),
    });
    removeWorkspaceMock.mockImplementation(() => {
      throw new Error("config write failed");
    });

    const result = await workspaceService.remove(workspaceId);

    expect(result.success).toBe(false);
    expect(reopened).toEqual([workspaceId]);
  });

  test("remove() lifts the consolidation teardown gate only when it aborts before committing", async () => {
    const calls: string[] = [];
    workspaceService.setMemoryConsolidationService({
      triggerInBackground: () => undefined,
      triggerHarvestThenSweepInBackground: () => undefined,
      cancelInFlightConsolidation: () => {
        calls.push("cancel");
        return Promise.resolve();
      },
      releaseRemovalCancellation: () => {
        calls.push("release");
      },
      finalizeHarvestsForRemoval: () => Promise.resolve(),
    });
    // Aborted before the point of no return (live descendant tasks): the
    // workspace stays intact, so any teardown gate is lifted again.
    let descendants = true;
    workspaceService.setAgentTaskIntegration(
      makeAgentTaskIntegrationFake({ hasDescendantAgentTasks: () => descendants })
    );
    const aborted = await workspaceService.remove(workspaceId);
    expect(aborted.success).toBe(false);
    expect(calls).toEqual(["release"]);
    // Aborted inside the locked handover (a late legacy note the owner store
    // cannot take), i.e. after the drain but BEFORE the tombstone: the session
    // directory survives, so the gate is lifted too.
    descendants = false;
    calls.length = 0;
    const sessionDir = path.join(tempRoot, "sessions", workspaceId);
    await fsPromises.mkdir(sessionDir, { recursive: true });
    const topology = {
      projects: new Map([
        [
          "/tmp/src/project",
          {
            workspaces: [
              { path: "/tmp/src/project/owner", id: "ws-owner" },
              { path: "/tmp/src/project/child", id: workspaceId, parentWorkspaceId: "ws-owner" },
            ],
          },
        ],
      ]),
    };
    // The service holds its own copy of the mock config (createWorkspaceServiceForTest).
    const config = (workspaceService as unknown as { config: MockWorkspaceConfig }).config;
    const previousLoad = config.loadConfigOrDefault;
    const previousLoadExisting = config.loadExistingConfigOrThrow;
    config.loadConfigOrDefault = (() => topology) as MockWorkspaceConfig["loadConfigOrDefault"];
    config.loadExistingConfigOrThrow = (() =>
      topology) as MockWorkspaceConfig["loadExistingConfigOrThrow"];
    workspaceService.setSharedWorkspaceMemoryStore({
      adoptLegacyPrivateStoreForRemoval: () =>
        Promise.reject(new Error("1 legacy note could not be folded into the shared notebook")),
    });
    try {
      const lockedAbort = await workspaceService.remove(workspaceId);
      expect(lockedAbort.success).toBe(false);
      if (!lockedAbort.success) expect(lockedAbort.error).toContain("tombstone could be published");
      expect(existsSync(sessionDir)).toBe(true);
      expect(calls).toContain("cancel");
      expect(calls).toContain("release");
    } finally {
      config.loadConfigOrDefault = previousLoad;
      config.loadExistingConfigOrThrow = previousLoadExisting;
      workspaceService.setSharedWorkspaceMemoryStore({
        adoptLegacyPrivateStoreForRemoval: () => Promise.resolve(),
      });
    }
    // Committed removal: cancelled (drained) and never released.
    calls.length = 0;
    const removed = await workspaceService.remove(workspaceId);
    expect(removed.success).toBe(true);
    expect(calls.filter((call) => call === "cancel").length).toBeGreaterThan(0);
    expect(calls).not.toContain("release");
  });

  test("remove() flushes the timeline before deleting the session directory", async () => {
    const sessionDir = path.join(tempRoot, "sessions", workspaceId);
    await fsPromises.mkdir(sessionDir, { recursive: true });
    const order: string[] = [];
    workspaceService.setTimelineRecorder({
      record: () => undefined,
      closeWorkspace: () => {
        // A queued append recreates the session directory, so closing is only useful while the
        // directory still exists.
        order.push(existsSync(sessionDir) ? "closed-before-delete" : "closed-after-delete");
        return Promise.resolve();
      },
      reopenWorkspace: () => undefined,
    });

    const result = await workspaceService.remove(workspaceId);

    expect(result.success).toBe(true);
    expect(order).toEqual(["closed-before-delete"]);
    expect(existsSync(sessionDir)).toBe(false);
  });

  test("remove() continues when desktop session cleanup fails", async () => {
    const close = mock(() => Promise.reject(new Error("close failed")));
    const desktopSessionManager = {
      close,
      setWorkspaceArchiveGuard: () => undefined,
    } as unknown as DesktopSessionManager;
    workspaceService.setDesktopSessionManager(desktopSessionManager);

    const result = await workspaceService.remove(workspaceId);

    expect(result.success).toBe(true);
    expect(close).toHaveBeenCalledTimes(1);
    expect(close).toHaveBeenCalledWith(workspaceId);
    expect(removeWorkspaceMock).toHaveBeenCalledWith(workspaceId);
  });
});

describe("WorkspaceService metadata listeners", () => {
  let historyService: HistoryService;
  let cleanupHistory: () => Promise<void>;

  beforeEach(async () => {
    ({ historyService, cleanup: cleanupHistory } = await createTestHistoryService());
  });

  afterEach(async () => {
    await cleanupHistory();
  });

  test("error events clear streaming metadata", async () => {
    const workspaceId = "ws-error";
    const setStreaming = mock(() =>
      Promise.resolve({
        recency: Date.now(),
        streaming: false,
        lastModel: null,
        lastThinkingLevel: null,
        agentStatus: null,
      })
    );

    class FakeAIService extends EventEmitter {
      isStreaming = mock(() => false);
      getWorkspaceMetadata = mock(() =>
        Promise.resolve({ success: false as const, error: "not found" })
      );
    }

    const aiService = new FakeAIService() as unknown as AIService;
    const mockConfig: MockWorkspaceConfig = {
      srcDir: "/tmp/src",
      sessionsDir: "/tmp/test/sessions",
      findWorkspace: mock(() => null),
      loadConfigOrDefault: mock(() => ({ projects: new Map() })),
    };
    const mockExtensionMetadata: Partial<ExtensionMetadataService> = {
      isWorkspaceDeleted: mock(() => false),
      setStreaming,
    };

    new WorkspaceService(
      withExistingConfigLoader(mockConfig) as Config,
      historyService,
      aiService,
      mockInitStateManager as InitStateManager,
      mockExtensionMetadata as ExtensionMetadataService,
      mockBackgroundProcessManager as BackgroundProcessManager
    );

    aiService.emit("error", {
      type: "error",
      workspaceId,
      messageId: "msg-1",
      error: "rate limited",
      errorType: "rate_limit",
    });

    await new Promise((resolve) => setTimeout(resolve, 0));

    expect(setStreaming).toHaveBeenCalledTimes(1);
    // todoStatus is intentionally NOT passed when there are no todos —
    // see updateStreamingStatus comment for rationale.
    expect(setStreaming).toHaveBeenCalledWith(workspaceId, false, {
      hasTodos: false,
      generation: 0,
    });
  });

  test("todo_write events publish todo-derived sidebar status", async () => {
    const workspaceId = "ws-todo-status";
    const setTodoStatus = mock(() =>
      Promise.resolve({
        recency: Date.now(),
        streaming: true,
        lastModel: null,
        lastThinkingLevel: null,
        agentStatus: null,
      })
    );
    const readTodosSpy = spyOn(todoStorageModule, "readTodosForSessionDir").mockResolvedValue([
      { content: "Run typecheck", status: "in_progress" },
      { content: "Add tests", status: "pending" },
    ]);

    class FakeAIService extends EventEmitter {
      isStreaming = mock(() => false);
      getWorkspaceMetadata = mock(() =>
        Promise.resolve({ success: false as const, error: "not found" })
      );
    }

    const aiService = new FakeAIService() as unknown as AIService;
    const mockConfig: MockWorkspaceConfig = {
      srcDir: "/tmp/src",
      sessionsDir: "/tmp/test/sessions",
      findWorkspace: mock(() => null),
      loadConfigOrDefault: mock(() => ({ projects: new Map() })),
    };
    const mockExtensionMetadata: Partial<ExtensionMetadataService> = {
      isWorkspaceDeleted: mock(() => false),
      setTodoStatus,
    };

    new WorkspaceService(
      withExistingConfigLoader(mockConfig) as Config,
      historyService,
      aiService,
      mockInitStateManager as InitStateManager,
      mockExtensionMetadata as ExtensionMetadataService,
      mockBackgroundProcessManager as BackgroundProcessManager
    );

    try {
      aiService.emit("tool-call-end", {
        type: "tool-call-end",
        workspaceId,
        messageId: "msg-1",
        toolCallId: "tool-1",
        toolName: "todo_write",
        result: { success: true, count: 2 },
        timestamp: Date.now(),
      });

      await new Promise((resolve) => setTimeout(resolve, 0));

      expect(readTodosSpy).toHaveBeenCalledWith(
        path.join(mockConfig.sessionsDir ?? "", workspaceId)
      );
      expect(setTodoStatus).toHaveBeenCalledWith(
        workspaceId,
        { emoji: "🔄", message: "Run typecheck" },
        true
      );
    } finally {
      readTodosSpy.mockRestore();
    }
  });
});

describe("WorkspaceService setPinned", () => {
  const projectPath = "/tmp/project";
  const rootId = "ws-root";
  const otherRootId = "ws-other";
  const childId = "ws-child";
  const archivedId = "ws-archived";

  let workspaceService: WorkspaceService;
  let configState: ProjectsConfig;
  let historyService: HistoryService;
  let cleanupHistory: () => Promise<void>;
  let emittedMetadata: Array<{ workspaceId: string; metadata: FrontendWorkspaceMetadata | null }>;

  const getEntry = (id: string) =>
    configState.projects.get(projectPath)?.workspaces.find((w) => w.id === id);

  beforeEach(async () => {
    configState = {
      projects: new Map([
        [
          projectPath,
          {
            workspaces: [
              { path: `${projectPath}/${rootId}`, id: rootId },
              { path: `${projectPath}/${otherRootId}`, id: otherRootId },
              {
                path: `${projectPath}/${childId}`,
                id: childId,
                parentWorkspaceId: rootId,
              },
              {
                path: `${projectPath}/${archivedId}`,
                id: archivedId,
                archivedAt: "2026-01-01T00:00:00.000Z",
              },
            ],
          },
        ],
      ]),
    };

    ({ historyService, cleanup: cleanupHistory } = await createTestHistoryService());

    const mockConfig: MockWorkspaceConfig = {
      srcDir: "/tmp/src",
      sessionsDir: "/tmp/test/sessions",
      findWorkspace: mock((id: string) => {
        const entry = getEntry(id);
        if (!entry) return null;
        return {
          projectPath,
          workspacePath: entry.path,
          parentWorkspaceId: entry.parentWorkspaceId,
        };
      }),
      editConfig: mock((fn: (config: ProjectsConfig) => ProjectsConfig) => {
        configState = fn(configState);
        return Promise.resolve();
      }),
      // Project config entries back into metadata so emitted events carry pin state.
      getAllWorkspaceMetadata: mock(() =>
        Promise.resolve(
          (configState.projects.get(projectPath)?.workspaces ?? [])
            .filter((w): w is typeof w & { id: string } => w.id != null)
            .map(
              (w): FrontendWorkspaceMetadata => ({
                id: w.id,
                name: w.id,
                projectName: "proj",
                projectPath,
                namedWorkspacePath: w.path,
                runtimeConfig: { type: "local", srcBaseDir: "/tmp" },
                parentWorkspaceId: w.parentWorkspaceId,
                archivedAt: w.archivedAt,
                unarchivedAt: w.unarchivedAt,
                pinnedAt: w.pinnedAt,
              })
            )
        )
      ),
      loadConfigOrDefault: mock(() => configState),
    };

    workspaceService = createWorkspaceServiceForTest({
      config: mockConfig,
      historyService,
    });

    emittedMetadata = [];
    workspaceService.on("metadata", (payload) => {
      emittedMetadata.push(payload as (typeof emittedMetadata)[number]);
    });
  });

  afterEach(async () => {
    await cleanupHistory();
  });

  test("pin persists pinnedAt and emits metadata; unpin clears it and emits", async () => {
    const pinResult = await workspaceService.setPinned(rootId, true);
    expect(pinResult.success).toBe(true);

    const pinnedAt = getEntry(rootId)?.pinnedAt;
    expect(pinnedAt).toBeDefined();
    expect(emittedMetadata).toHaveLength(1);
    expect(emittedMetadata[0].workspaceId).toBe(rootId);
    expect(emittedMetadata[0].metadata?.pinnedAt).toBe(pinnedAt);

    const unpinResult = await workspaceService.setPinned(rootId, false);
    expect(unpinResult.success).toBe(true);
    expect(getEntry(rootId)?.pinnedAt).toBeUndefined();
    expect(emittedMetadata).toHaveLength(2);
    expect(emittedMetadata[1].metadata?.pinnedAt).toBeUndefined();
  });

  test("corrupted boundary pinnedAt on another chat cannot block pinning", async () => {
    // A parseable boundary timestamp has no representable +1ms successor; the
    // global monotonic scan must ignore it rather than fail every future pin.
    const other = getEntry(otherRootId);
    if (!other) throw new Error("fixture missing otherRootId");
    other.pinnedAt = "+275760-09-13T00:00:00.000Z";

    const result = await workspaceService.setPinned(rootId, true);
    expect(result.success).toBe(true);
    const pinnedAt = getEntry(rootId)?.pinnedAt;
    expect(pinnedAt).toBeDefined();
    // The assigned timestamp is a normal near-now value, not a successor of
    // the corrupted boundary.
    expect(new Date(pinnedAt ?? "").getTime()).toBeLessThan(Date.now() + 60_000);
  });

  test("pinning heals a saturated boundary timestamp so keys stay unique", async () => {
    // An existing pin at the sane cap has no strictly-greater sane successor;
    // the write path renumbers pins instead of minting a duplicate key.
    const saneMax = new Date(8_640_000_000_000_000 - 1).toISOString();
    const other = getEntry(otherRootId);
    if (!other) throw new Error("fixture missing otherRootId");
    other.pinnedAt = saneMax;

    const result = await workspaceService.setPinned(rootId, true);
    expect(result.success).toBe(true);
    const rootPinnedAt = getEntry(rootId)?.pinnedAt;
    const otherPinnedAt = getEntry(otherRootId)?.pinnedAt;
    expect(rootPinnedAt).toBeDefined();
    expect(otherPinnedAt).toBeDefined();
    expect(rootPinnedAt).not.toBe(otherPinnedAt);
    // The healed pin sorts before the new pin and both are near-now values.
    expect(new Date(otherPinnedAt ?? "").getTime()).toBeLessThan(
      new Date(rootPinnedAt ?? "").getTime()
    );
    expect(new Date(rootPinnedAt ?? "").getTime()).toBeLessThan(Date.now() + 60_000);
  });

  test("pin-when-pinned and unpin-when-unpinned are no-ops without event churn", async () => {
    const first = await workspaceService.setPinned(rootId, true);
    expect(first.success).toBe(true);
    const firstPinnedAt = getEntry(rootId)?.pinnedAt;
    expect(emittedMetadata).toHaveLength(1);

    // Concurrent double-pin from another client must not move the row.
    const again = await workspaceService.setPinned(rootId, true);
    expect(again.success).toBe(true);
    expect(getEntry(rootId)?.pinnedAt).toBe(firstPinnedAt);
    expect(emittedMetadata).toHaveLength(1);

    // Unpinning a chat that is not pinned is also a quiet no-op.
    const noopUnpin = await workspaceService.setPinned(otherRootId, false);
    expect(noopUnpin.success).toBe(true);
    expect(emittedMetadata).toHaveLength(1);
  });

  test("rejects pinning sub-agent and archived workspaces", async () => {
    const subAgentResult = await workspaceService.setPinned(childId, true);
    expect(subAgentResult.success).toBe(false);
    expect(getEntry(childId)?.pinnedAt).toBeUndefined();

    const archivedResult = await workspaceService.setPinned(archivedId, true);
    expect(archivedResult.success).toBe(false);
    expect(getEntry(archivedId)?.pinnedAt).toBeUndefined();

    expect(emittedMetadata).toHaveLength(0);
  });

  test("pinning after an existing pin yields a strictly greater pinnedAt", async () => {
    expect((await workspaceService.setPinned(otherRootId, true)).success).toBe(true);
    expect((await workspaceService.setPinned(rootId, true)).success).toBe(true);

    const firstMs = Date.parse(getEntry(otherRootId)?.pinnedAt ?? "");
    const secondMs = Date.parse(getEntry(rootId)?.pinnedAt ?? "");
    expect(secondMs).toBeGreaterThan(firstMs);
  });

  test("appends after an existing future pinnedAt (clock skew)", async () => {
    const future = new Date(Date.now() + 60 * 60 * 1000).toISOString();
    getEntry(otherRootId)!.pinnedAt = future;

    expect((await workspaceService.setPinned(rootId, true)).success).toBe(true);
    expect(Date.parse(getEntry(rootId)?.pinnedAt ?? "")).toBeGreaterThan(Date.parse(future));
  });

  test("archive clears pinnedAt and unarchive does not restore it", async () => {
    expect((await workspaceService.setPinned(rootId, true)).success).toBe(true);
    expect(getEntry(rootId)?.pinnedAt).toBeDefined();

    const archiveResult = await workspaceService.archive(rootId);
    expect(archiveResult.success).toBe(true);
    expect(getEntry(rootId)?.pinnedAt).toBeUndefined();

    const unarchiveResult = await workspaceService.unarchive(rootId);
    expect(unarchiveResult.success).toBe(true);
    expect(getEntry(rootId)?.pinnedAt).toBeUndefined();

    // Re-pinning after unarchive works (pin state starts fresh).
    expect((await workspaceService.setPinned(rootId, true)).success).toBe(true);
    expect(getEntry(rootId)?.pinnedAt).toBeDefined();
  });

  test("unarchive pokes task-side workflow attention reconciliation", async () => {
    const noteWorkspaceUnarchived = mock(() => Promise.resolve());
    workspaceService.setAgentTaskIntegration(
      makeAgentTaskIntegrationFake({ noteWorkspaceUnarchived })
    );
    expect((await workspaceService.archive(rootId)).success).toBe(true);
    expect(noteWorkspaceUnarchived).not.toHaveBeenCalled();

    expect((await workspaceService.unarchive(rootId)).success).toBe(true);
    expect(noteWorkspaceUnarchived).toHaveBeenCalledWith(rootId);
    expect(noteWorkspaceUnarchived).toHaveBeenCalledTimes(1);

    // No archived -> unarchived transition: a repeat unarchive must not re-poke.
    expect((await workspaceService.unarchive(rootId)).success).toBe(true);
    expect(noteWorkspaceUnarchived).toHaveBeenCalledTimes(1);
  });
});

describe("WorkspaceService reorderPinned", () => {
  const projectPath = "/tmp/project";
  const idA = "ws-a";
  const idB = "ws-b";
  const idC = "ws-c";
  const unpinnedId = "ws-unpinned";
  const childId = "ws-child";
  const archivedId = "ws-archived";

  let workspaceService: WorkspaceService;
  let configState: ProjectsConfig;
  let historyService: HistoryService;
  let cleanupHistory: () => Promise<void>;
  let emittedMetadata: Array<{ workspaceId: string; metadata: FrontendWorkspaceMetadata | null }>;

  const getEntry = (id: string) =>
    configState.projects.get(projectPath)?.workspaces.find((w) => w.id === id);

  /** Pinned ids in effective order (pinnedAt asc), as the sidebar sorts them. */
  const pinnedOrder = () =>
    (configState.projects.get(projectPath)?.workspaces ?? [])
      .filter((w) => w.id && w.pinnedAt && !w.parentWorkspaceId && !w.archivedAt)
      .sort((a, b) => Date.parse(a.pinnedAt ?? "") - Date.parse(b.pinnedAt ?? ""))
      .map((w) => w.id);

  beforeEach(async () => {
    configState = {
      projects: new Map([
        [
          projectPath,
          {
            workspaces: [
              // Pinned block in order A, B, C (pinnedAt ascending).
              {
                path: `${projectPath}/${idA}`,
                id: idA,
                pinnedAt: "2026-01-01T00:00:00.000Z",
              },
              {
                path: `${projectPath}/${idB}`,
                id: idB,
                pinnedAt: "2026-01-01T00:00:10.000Z",
              },
              {
                path: `${projectPath}/${idC}`,
                id: idC,
                pinnedAt: "2026-01-01T00:00:20.000Z",
              },
              { path: `${projectPath}/${unpinnedId}`, id: unpinnedId },
              {
                path: `${projectPath}/${childId}`,
                id: childId,
                parentWorkspaceId: idA,
              },
              {
                path: `${projectPath}/${archivedId}`,
                id: archivedId,
                archivedAt: "2026-01-01T00:00:00.000Z",
              },
            ],
          },
        ],
      ]),
    };

    ({ historyService, cleanup: cleanupHistory } = await createTestHistoryService());

    const mockConfig: MockWorkspaceConfig = {
      srcDir: "/tmp/src",
      sessionsDir: "/tmp/test/sessions",
      findWorkspace: mock((id: string) => {
        const entry = getEntry(id);
        if (!entry) return null;
        return {
          projectPath,
          workspacePath: entry.path,
          parentWorkspaceId: entry.parentWorkspaceId,
        };
      }),
      editConfig: mock((fn: (config: ProjectsConfig) => ProjectsConfig) => {
        configState = fn(configState);
        return Promise.resolve();
      }),
      getAllWorkspaceMetadata: mock(() =>
        Promise.resolve(
          (configState.projects.get(projectPath)?.workspaces ?? [])
            .filter((w): w is typeof w & { id: string } => w.id != null)
            .map(
              (w): FrontendWorkspaceMetadata => ({
                id: w.id,
                name: w.id,
                projectName: "proj",
                projectPath,
                namedWorkspacePath: w.path,
                runtimeConfig: { type: "local", srcBaseDir: "/tmp" },
                parentWorkspaceId: w.parentWorkspaceId,
                archivedAt: w.archivedAt,
                unarchivedAt: w.unarchivedAt,
                pinnedAt: w.pinnedAt,
              })
            )
        )
      ),
      loadConfigOrDefault: mock(() => configState),
    };

    workspaceService = createWorkspaceServiceForTest({
      config: mockConfig,
      historyService,
    });

    emittedMetadata = [];
    workspaceService.on("metadata", (payload) => {
      emittedMetadata.push(payload as (typeof emittedMetadata)[number]);
    });
  });

  afterEach(async () => {
    await cleanupHistory();
  });

  test("persists the new order and emits metadata only for displaced rows", async () => {
    // Move C to the front: every rank shifts, so all three rows change.
    const result = await workspaceService.reorderPinned([idC, idA, idB]);
    expect(result.success).toBe(true);
    expect(pinnedOrder()).toEqual([idC, idA, idB]);
    expect(emittedMetadata.map((e) => e.workspaceId).sort()).toEqual([idA, idB, idC].sort());
    // Emitted metadata carries the rewritten pinnedAt values.
    for (const event of emittedMetadata) {
      expect(event.metadata?.pinnedAt).toBe(getEntry(event.workspaceId)?.pinnedAt);
    }
  });

  test("swapping only a suffix leaves preceding pins untouched", async () => {
    const pinnedAtA = getEntry(idA)?.pinnedAt;
    const result = await workspaceService.reorderPinned([idA, idC, idB]);
    expect(result.success).toBe(true);
    expect(pinnedOrder()).toEqual([idA, idC, idB]);
    // A kept its rank, so its timestamp is untouched and no event is emitted for it.
    expect(getEntry(idA)?.pinnedAt).toBe(pinnedAtA);
    expect(emittedMetadata.map((e) => e.workspaceId).sort()).toEqual([idB, idC].sort());
  });

  test("no-op order emits nothing and rewrites nothing", async () => {
    const before = [getEntry(idA)?.pinnedAt, getEntry(idB)?.pinnedAt, getEntry(idC)?.pinnedAt];
    const result = await workspaceService.reorderPinned([idA, idB, idC]);
    expect(result.success).toBe(true);
    expect([getEntry(idA)?.pinnedAt, getEntry(idB)?.pinnedAt, getEntry(idC)?.pinnedAt]).toEqual(
      before
    );
    expect(emittedMetadata).toHaveLength(0);
  });

  test("drops stale/unpinned/duplicate ids and keeps omitted pins in place", async () => {
    // Client sends duplicates, an unpinned id, a sub-agent, an archived chat,
    // and a ghost id, and omits B entirely: C and A swap within the slots
    // they occupy while omitted B keeps its position.
    const result = await workspaceService.reorderPinned([
      idC,
      idC,
      unpinnedId,
      childId,
      archivedId,
      "ws-ghost",
      idA,
    ]);
    expect(result.success).toBe(true);
    expect(pinnedOrder()).toEqual([idC, idB, idA]);
    // Ineligible ids never gain pinnedAt.
    expect(getEntry(unpinnedId)?.pinnedAt).toBeUndefined();
    expect(getEntry(childId)?.pinnedAt).toBeUndefined();
    expect(getEntry(archivedId)?.pinnedAt).toBeUndefined();
  });

  test("reorder preserves the timestamp pool so setPinned still appends at the bottom", async () => {
    const maxBefore = Math.max(
      ...[idA, idB, idC].map((id) => Date.parse(getEntry(id)?.pinnedAt ?? ""))
    );
    expect((await workspaceService.reorderPinned([idC, idB, idA])).success).toBe(true);
    const maxAfter = Math.max(
      ...[idA, idB, idC].map((id) => Date.parse(getEntry(id)?.pinnedAt ?? ""))
    );
    // Re-dealing the pool must not inflate the max timestamp.
    expect(maxAfter).toBe(maxBefore);

    expect((await workspaceService.setPinned(unpinnedId, true)).success).toBe(true);
    expect(pinnedOrder()).toEqual([idC, idB, idA, unpinnedId]);
  });

  test("returns Ok no-op when no id resolves to a workspace", async () => {
    const result = await workspaceService.reorderPinned(["ws-ghost-1", "ws-ghost-2"]);
    expect(result.success).toBe(true);
    expect(pinnedOrder()).toEqual([idA, idB, idC]);
    expect(emittedMetadata).toHaveLength(0);
  });

  test("identical pinnedAt values (client races) still reorder deterministically", async () => {
    const same = "2026-01-01T00:00:00.000Z";
    getEntry(idA)!.pinnedAt = same;
    getEntry(idB)!.pinnedAt = same;
    getEntry(idC)!.pinnedAt = same;

    const result = await workspaceService.reorderPinned([idB, idC, idA]);
    expect(result.success).toBe(true);
    expect(pinnedOrder()).toEqual([idB, idC, idA]);
    // Strictly monotonic after the re-deal.
    const values = [idB, idC, idA].map((id) => Date.parse(getEntry(id)?.pinnedAt ?? ""));
    expect(values[0]).toBeLessThan(values[1]);
    expect(values[1]).toBeLessThan(values[2]);
  });
});

describe("WorkspaceService reorderPinned across projects", () => {
  const projectA = "/tmp/project-a";
  const projectB = "/tmp/project-b";
  const idA1 = "ws-a1";
  const idA2 = "ws-a2";
  const idA3 = "ws-a3";
  const idB1 = "ws-b1";
  const idB2 = "ws-b2";

  let workspaceService: WorkspaceService;
  let configState: ProjectsConfig;
  let historyService: HistoryService;
  let cleanupHistory: () => Promise<void>;

  const findEntry = (id: string) => {
    for (const [projectPath, project] of configState.projects) {
      const entry = project.workspaces.find((w) => w.id === id);
      if (entry) return { projectPath, entry };
    }
    return undefined;
  };

  /** Pinned ids across all projects in effective order (pinnedAt asc), as the flat sidebar sorts them. */
  const globalPinnedOrder = () =>
    [...configState.projects.values()]
      .flatMap((project) => project.workspaces)
      .filter((w) => w.id && w.pinnedAt && !w.parentWorkspaceId && !w.archivedAt)
      .sort((a, b) => Date.parse(a.pinnedAt ?? "") - Date.parse(b.pinnedAt ?? ""))
      .map((w) => w.id);

  beforeEach(async () => {
    // Interleaved global pin order: a1, b1, a2, b2.
    configState = {
      projects: new Map([
        [
          projectA,
          {
            workspaces: [
              { path: `${projectA}/${idA1}`, id: idA1, pinnedAt: "2026-01-01T00:00:00.000Z" },
              { path: `${projectA}/${idA2}`, id: idA2, pinnedAt: "2026-01-01T00:00:20.000Z" },
              { path: `${projectA}/${idA3}`, id: idA3 },
            ],
          },
        ],
        [
          projectB,
          {
            workspaces: [
              { path: `${projectB}/${idB1}`, id: idB1, pinnedAt: "2026-01-01T00:00:10.000Z" },
              { path: `${projectB}/${idB2}`, id: idB2, pinnedAt: "2026-01-01T00:00:30.000Z" },
            ],
          },
        ],
      ]),
    };

    ({ historyService, cleanup: cleanupHistory } = await createTestHistoryService());

    const mockConfig: Partial<Config> = {
      srcDir: "/tmp/src",
      findWorkspace: mock((id: string) => {
        const found = findEntry(id);
        if (!found) return null;
        return {
          projectPath: found.projectPath,
          workspacePath: found.entry.path,
          parentWorkspaceId: found.entry.parentWorkspaceId,
        };
      }),
      editConfig: mock((fn: (config: ProjectsConfig) => ProjectsConfig) => {
        configState = fn(configState);
        return Promise.resolve();
      }),
      getAllWorkspaceMetadata: mock(() => Promise.resolve([])),
      loadConfigOrDefault: mock(() => configState),
    };

    workspaceService = createWorkspaceServiceForTest({
      config: mockConfig,
      historyService,
    });
  });

  afterEach(async () => {
    await cleanupHistory();
  });

  test("persists a flat-mode reorder spanning project buckets", async () => {
    const maxBefore = Math.max(
      ...[idA1, idA2, idB1, idB2].map((id) => Date.parse(findEntry(id)?.entry.pinnedAt ?? ""))
    );

    // Drag b1 above a1 in the unified pinned block.
    const result = await workspaceService.reorderPinned([idB1, idA1, idA2, idB2]);
    expect(result.success).toBe(true);
    expect(globalPinnedOrder()).toEqual([idB1, idA1, idA2, idB2]);

    // The timestamp pool is re-dealt, not inflated.
    const maxAfter = Math.max(
      ...[idA1, idA2, idB1, idB2].map((id) => Date.parse(findEntry(id)?.entry.pinnedAt ?? ""))
    );
    expect(maxAfter).toBe(maxBefore);
  });

  test("setPinned appends after the global pinned max, not just its own bucket's", async () => {
    // Give the other bucket the newest pin so a bucket-local max would sort the
    // new pin above it in the flat sidebar's unified block.
    const future = new Date(Date.now() + 60_000).toISOString();
    findEntry(idB2)!.entry.pinnedAt = future;

    expect((await workspaceService.setPinned(idA3, true)).success).toBe(true);
    expect(globalPinnedOrder().at(-1)).toBe(idA3);
  });

  test("partial cross-bucket reorder keeps omitted pins in their global slots", async () => {
    // The grouped multi-project section sends only its own pinned ids, which
    // can live in different project buckets. Swapping b1 and a2 must not
    // displace the ordinary pins a1 and b2 in the flat global order.
    const a1Before = findEntry(idA1)?.entry.pinnedAt;
    const b2Before = findEntry(idB2)?.entry.pinnedAt;

    const result = await workspaceService.reorderPinned([idA2, idB1]);
    expect(result.success).toBe(true);
    expect(globalPinnedOrder()).toEqual([idA1, idA2, idB1, idB2]);
    // The untouched slots keep their exact timestamps.
    expect(findEntry(idA1)?.entry.pinnedAt).toBe(a1Before);
    expect(findEntry(idB2)?.entry.pinnedAt).toBe(b2Before);
  });

  test("grouped-mode reorder of one bucket leaves other buckets' timestamps untouched", async () => {
    const b1Before = findEntry(idB1)?.entry.pinnedAt;
    const b2Before = findEntry(idB2)?.entry.pinnedAt;

    const result = await workspaceService.reorderPinned([idA2, idA1]);
    expect(result.success).toBe(true);

    // Project A flipped within its own timestamp pool.
    const a1 = Date.parse(findEntry(idA1)?.entry.pinnedAt ?? "");
    const a2 = Date.parse(findEntry(idA2)?.entry.pinnedAt ?? "");
    expect(a2).toBeLessThan(a1);
    // Project B was not referenced, so its entries are byte-identical.
    expect(findEntry(idB1)?.entry.pinnedAt).toBe(b1Before);
    expect(findEntry(idB2)?.entry.pinnedAt).toBe(b2Before);
  });
});

describe("WorkspaceService archive lifecycle hooks", () => {
  const workspaceId = "ws-archive";
  const projectPath = "/tmp/project";
  const workspacePath = "/tmp/project/ws-archive";
  const sessionsDir = "/tmp/test/sessions";
  const externalEditorMarkerPath = path.join(sessionsDir, workspaceId, "external-editor-opened");

  let workspaceService: WorkspaceService;
  let mockAIService: AIService;
  let mockStreamManager: { getStreamInfo: ReturnType<typeof mock> };
  let configState: ProjectsConfig;
  let editConfigSpy: ReturnType<typeof mock>;
  let historyService: HistoryService;
  let cleanupHistory: () => Promise<void>;

  const workspaceMetadata: WorkspaceMetadata = {
    id: workspaceId,
    name: "ws-archive",
    projectName: "proj",
    projectPath,
    runtimeConfig: { type: "local", srcBaseDir: "/tmp" },
  };

  beforeEach(async () => {
    configState = {
      projects: new Map([
        [
          projectPath,
          {
            workspaces: [
              {
                path: workspacePath,
                id: workspaceId,
              },
            ],
          },
        ],
      ]),
    };

    editConfigSpy = mock((fn: (config: ProjectsConfig) => ProjectsConfig) => {
      configState = fn(configState);
      return Promise.resolve();
    });

    ({ historyService, cleanup: cleanupHistory } = await createTestHistoryService());

    const mockConfig: MockWorkspaceConfig = {
      srcDir: "/tmp/src",
      sessionsDir,
      generateStableId: mock(() => "test-id"),
      findWorkspace: mock((id: string) => {
        if (id !== workspaceId) {
          return null;
        }

        return { projectPath, workspacePath };
      }),
      editConfig: editConfigSpy,
      getAllWorkspaceMetadata: mock(() => Promise.resolve([])),
      loadConfigOrDefault: mock(() => configState),
    };
    mockAIService = {
      ...createStreamLifecycleMocks(),
      isStreaming: mock(() => false),
      getWorkspaceMetadata: mock(() => Promise.resolve(Ok(workspaceMetadata))),
      // eslint-disable-next-line @typescript-eslint/no-empty-function
      on: mock(() => {}),
      // eslint-disable-next-line @typescript-eslint/no-empty-function
      off: mock(() => {}),
    } as unknown as AIService;

    mockStreamManager = { ...createStreamLifecycleMocks(), getStreamInfo: mock(() => undefined) };
    workspaceService = createWorkspaceServiceForTest({
      config: mockConfig,
      historyService,
      aiService: mockAIService,
      initStateManager: mockInitStateManager as InitStateManager,
      streamManager: mockStreamManager as unknown as WorkspaceServiceArgs[11],
    });
  });

  afterEach(async () => {
    await cleanupHistory();
  });

  test("archive refuses to hide a parent while descendant sub-agents remain active", async () => {
    const hasActiveDescendantAgentTasksForWorkspace = mock(() => true);
    workspaceService.setAgentTaskIntegration(
      makeAgentTaskIntegrationFake({
        hasActiveDescendantAgentTasksForWorkspace,
      })
    );

    const preflight = await workspaceService.preflightArchive(workspaceId);
    const archive = await workspaceService.archive(workspaceId);

    const expectedError =
      "This workspace has active descendant sub-agents. Stop them before archiving their parent.";
    expect(preflight).toEqual(Err(expectedError));
    expect(archive).toEqual(Err(expectedError));
    expect(hasActiveDescendantAgentTasksForWorkspace).toHaveBeenCalledWith(workspaceId);
    expect(editConfigSpy).not.toHaveBeenCalled();
  });

  test.each([
    ["shared", "interrupted", "owner"],
    ["isolated", "queued", undefined],
  ] as const)(
    "archiving a %s queued child leaves its task status %s",
    async (_kind, expectedStatus, taskDesktopOwnerWorkspaceId) => {
      const project = configState.projects.get(projectPath);
      if (!project) throw new Error("project fixture must exist");
      project.workspaces.unshift({ path: "/tmp/project/owner", id: "owner" });
      Object.assign(project.workspaces[1], {
        parentWorkspaceId: "owner",
        taskStatus: "queued",
        taskPrompt: "brief",
        ...(taskDesktopOwnerWorkspaceId !== undefined ? { taskDesktopOwnerWorkspaceId } : {}),
      });

      expect(await workspaceService.archive(workspaceId)).toEqual(Ok({ kind: "archived" }));

      // A shared child must not stay an active borrower of the owner's desktop while archived;
      // the queued brief survives for the reawaken path.
      const entry = project.workspaces.find((w) => w.id === workspaceId);
      expect(entry?.archivedAt).toBeTruthy();
      expect(entry?.taskStatus).toBe(expectedStatus);
      expect(entry?.taskPrompt).toBe("brief");
    }
  );

  test("returns Err and does not persist archivedAt when beforeArchive hook fails", async () => {
    const hooks = new WorkspaceLifecycleHooks();
    hooks.registerBeforeArchive(() => Promise.resolve(Err("hook failed")));
    workspaceService.setWorkspaceLifecycleHooks(hooks);

    const result = await workspaceService.archive(workspaceId);

    expect(result.success).toBe(false);
    if (!result.success) {
      expect(result.error).toBe("hook failed");
    }

    expect(editConfigSpy).toHaveBeenCalledTimes(0);

    const entry = configState.projects.get(projectPath)?.workspaces[0];
    expect(entry?.archivedAt).toBeUndefined();
  });

  test("does not interrupt an active stream when beforeArchive hook fails", async () => {
    const hooks = new WorkspaceLifecycleHooks();
    hooks.registerBeforeArchive(() => Promise.resolve(Err("hook failed")));
    workspaceService.setWorkspaceLifecycleHooks(hooks);

    (mockAIService.isStreaming as ReturnType<typeof mock>).mockReturnValue(true);

    const interruptStreamSpy = mock(() => Promise.resolve(Ok(undefined)));
    workspaceService.interruptStream =
      interruptStreamSpy as unknown as typeof workspaceService.interruptStream;

    const result = await workspaceService.archive(workspaceId);

    expect(result.success).toBe(false);
    expect(interruptStreamSpy).toHaveBeenCalledTimes(0);
  });

  test("archive() stays successful when post-persist terminal teardown fails", async () => {
    const closeWorkspaceSessions = mock(() => {
      throw new Error("terminal close failed");
    });
    const terminalService = {
      closeWorkspaceSessions,
      setWorkspaceArchiveGuard: () => undefined,
    } as unknown as TerminalService;
    workspaceService.setTerminalService(terminalService);

    const result = await workspaceService.archive(workspaceId);

    expect(result).toEqual(Ok({ kind: "archived" }));
    const entry = configState.projects.get(projectPath)?.workspaces[0];
    expect(entry?.archivedAt).toBeTruthy();
  });

  test("archive() disposes a transient startup-recovery session once archivedAt is durable", async () => {
    let editConfigCallsAtDispose = -1;
    const dispose = mock(() => {
      editConfigCallsAtDispose = editConfigSpy.mock.calls.length;
    });
    const access = workspaceService as unknown as {
      transientStartupRecoverySessions: Map<string, AgentSession>;
    };
    access.transientStartupRecoverySessions.set(workspaceId, {
      dispose,
    } as unknown as AgentSession);

    const result = await workspaceService.archive(workspaceId);

    expect(result.success).toBe(true);
    expect(dispose).toHaveBeenCalledTimes(1);
    expect(editConfigCallsAtDispose).toBe(1);
    expect(access.transientStartupRecoverySessions.has(workspaceId)).toBe(false);
  });

  test("archive() closes workspace terminal sessions on success", async () => {
    const closeWorkspaceSessions = mock(() => undefined);
    const terminalService = {
      closeWorkspaceSessions,
      setWorkspaceArchiveGuard: () => undefined,
    } as unknown as TerminalService;
    workspaceService.setTerminalService(terminalService);

    const result = await workspaceService.archive(workspaceId);

    expect(result.success).toBe(true);
    expect(closeWorkspaceSessions).toHaveBeenCalledTimes(1);
    expect(closeWorkspaceSessions).toHaveBeenCalledWith(workspaceId);
  });

  test("archive() does not close terminal sessions when beforeArchive hook fails", async () => {
    const hooks = new WorkspaceLifecycleHooks();
    hooks.registerBeforeArchive(() => Promise.resolve(Err("hook failed")));
    workspaceService.setWorkspaceLifecycleHooks(hooks);

    const closeWorkspaceSessions = mock(() => undefined);
    const terminalService = {
      closeWorkspaceSessions,
      setWorkspaceArchiveGuard: () => undefined,
    } as unknown as TerminalService;
    workspaceService.setTerminalService(terminalService);

    const result = await workspaceService.archive(workspaceId);

    expect(result.success).toBe(false);
    expect(closeWorkspaceSessions).not.toHaveBeenCalled();
  });

  test("archive() releases desktop viewers before persisting the archived identity", async () => {
    const started = createDeferred<void>();
    const released = createDeferred<void>();
    const close = mock(() => {
      started.resolve();
      return released.promise;
    });
    const desktopSessionManager = {
      close,
      setWorkspaceArchiveGuard: () => undefined,
    } as unknown as DesktopSessionManager;
    workspaceService.setDesktopSessionManager(desktopSessionManager);

    const archiving = workspaceService.archive(workspaceId);
    await started.promise;
    const entry = configState.projects.get(projectPath)?.workspaces[0];
    try {
      expect(entry?.archivedAt).toBeUndefined();
    } finally {
      released.resolve();
    }
    const result = await archiving;

    expect(result.success).toBe(true);
    expect(entry?.archivedAt).toBeTruthy();
    expect(close).toHaveBeenCalledTimes(1);
    expect(close).toHaveBeenCalledWith(workspaceId);
  });

  test("archive() does not close desktop sessions when beforeArchive hook fails", async () => {
    const hooks = new WorkspaceLifecycleHooks();
    hooks.registerBeforeArchive(() => Promise.resolve(Err("hook failed")));
    workspaceService.setWorkspaceLifecycleHooks(hooks);

    const close = mock(() => Promise.resolve(undefined));
    const desktopSessionManager = {
      close,
      setWorkspaceArchiveGuard: () => undefined,
    } as unknown as DesktopSessionManager;
    workspaceService.setDesktopSessionManager(desktopSessionManager);

    const result = await workspaceService.archive(workspaceId);

    expect(result.success).toBe(false);
    expect(close).not.toHaveBeenCalled();
  });

  test("persists archivedAt when beforeArchive hooks succeed", async () => {
    const hooks = new WorkspaceLifecycleHooks();
    hooks.registerBeforeArchive(() => Promise.resolve(Ok(undefined)));
    workspaceService.setWorkspaceLifecycleHooks(hooks);

    const result = await workspaceService.archive(workspaceId);

    expect(result.success).toBe(true);
    expect(editConfigSpy).toHaveBeenCalledTimes(1);

    const entry = configState.projects.get(projectPath)?.workspaces[0];
    expect(entry?.archivedAt).toBeTruthy();
    expect(entry?.archivedAt).toMatch(/^\d{4}-\d{2}-\d{2}T/);
  });
  test("persists archivedAt before afterArchive hooks run and treats hook failures as best-effort", async () => {
    const hooks = new WorkspaceLifecycleHooks();

    const afterHook = mock(() => {
      const entry = configState.projects.get(projectPath)?.workspaces[0];
      expect(entry?.archivedAt).toBeTruthy();
      return Promise.resolve(Err("hook failed"));
    });
    hooks.registerAfterArchive(afterHook);

    workspaceService.setWorkspaceLifecycleHooks(hooks);

    const result = await workspaceService.archive(workspaceId);

    expect(result.success).toBe(true);
    expect(afterHook).toHaveBeenCalledTimes(1);

    const entry = configState.projects.get(projectPath)?.workspaces[0];
    expect(entry?.archivedAt).toBeTruthy();
    expect(entry?.archivedAt).toMatch(/^\d{4}-\d{2}-\d{2}T/);
  });
  test("archive() removes DevTools data only after archivedAt is persisted", async () => {
    const removeWorkspaceData = mock((id: string) => {
      // devtools cleanup must run only once the archived state is durable
      expect(id).toBe(workspaceId);
      const entry = configState.projects.get(projectPath)?.workspaces[0];
      expect(entry?.archivedAt).toBeTruthy();
      return Promise.resolve();
    });
    workspaceService.setDevToolsService({
      hasWorkspaceData: () => Promise.resolve(true),
      removeWorkspaceData,
    });

    const result = await workspaceService.archive(workspaceId);

    expect(result.success).toBe(true);
    expect(removeWorkspaceData).toHaveBeenCalledTimes(1);
  });

  test("archive() stays successful when DevTools cleanup fails", async () => {
    workspaceService.setDevToolsService({
      hasWorkspaceData: () => Promise.resolve(true),
      removeWorkspaceData: mock(() => Promise.reject(new Error("disk error"))),
    });

    const result = await workspaceService.archive(workspaceId);

    expect(result.success).toBe(true);
    const entry = configState.projects.get(projectPath)?.workspaces[0];
    expect(entry?.archivedAt).toBeTruthy();
  });

  test("archive() honors the caller's pinned Coder policy over a flipped config read", async () => {
    // Dedicated (mux-created) Coder workspace: the remote-deletion guard only applies to these.
    (mockAIService.getWorkspaceMetadata as ReturnType<typeof mock>).mockReturnValue(
      Promise.resolve(
        Ok({
          ...workspaceMetadata,
          runtimeConfig: {
            type: "ssh",
            host: "coder.example",
            srcBaseDir: "/home/coder/src",
            coder: { workspaceName: "mux-child", existingWorkspace: false },
          },
        })
      )
    );
    // Simulate a keep → delete settings flip landing AFTER the caller read "keep" and committed
    // to the archive (e.g. by interrupting turns based on that read).
    configState.coderWorkspaceArchiveBehavior = "delete";

    const hooks = new WorkspaceLifecycleHooks();
    let hookBehavior: string | undefined;
    hooks.registerBeforeArchive((args) => {
      hookBehavior = args.coderWorkspaceArchiveBehavior;
      return Promise.resolve(Ok(undefined));
    });
    workspaceService.setWorkspaceLifecycleHooks(hooks);

    // Without a pinned read, the sink's fresh config read refuses under the flipped policy.
    const unpinned = await workspaceService.archive(workspaceId, undefined, {
      forbidCoderWorkspaceDeletion: true,
    });
    expect(unpinned.success).toBe(false);
    if (!unpinned.success) {
      expect(unpinned.error).toContain("Coder workspace archive behavior");
    }

    // With the caller's pinned read, the same flipped config cannot change the operation: the
    // guard passes and the before-archive hook receives the pinned value.
    const pinned = await workspaceService.archive(workspaceId, undefined, {
      forbidCoderWorkspaceDeletion: true,
      coderWorkspaceArchiveBehaviorOverride: "keep",
    });
    expect(pinned).toEqual(Ok({ kind: "archived" }));
    expect(hookBehavior).toBe("keep");
  });

  test("archive() under refuseLiveUserActivity closes an idle desktop process instead of refusing", async () => {
    // The desktop process an agent started lingers after its turn finished; nobody is attached,
    // so an agent-driven archive must proceed and close it like the user-driven path does.
    const close = mock(() => Promise.resolve(undefined));
    const desktopSessionManager = {
      close,
      has: () => true,
      hasAttachedViewers: () => false,
      setWorkspaceArchiveGuard: () => undefined,
    } as unknown as DesktopSessionManager;
    workspaceService.setDesktopSessionManager(desktopSessionManager);

    const result = await workspaceService.archive(workspaceId, undefined, {
      refuseLiveUserActivity: true,
    });

    expect(result).toEqual(Ok({ kind: "archived" }));
    expect(close).toHaveBeenCalledWith(workspaceId);
  });

  test("archive() under refuseLiveUserActivity refuses while a desktop viewer is attached", async () => {
    const close = mock(() => Promise.resolve(undefined));
    const desktopSessionManager = {
      close,
      has: () => true,
      hasAttachedViewers: () => true,
      setWorkspaceArchiveGuard: () => undefined,
    } as unknown as DesktopSessionManager;
    workspaceService.setDesktopSessionManager(desktopSessionManager);

    const result = await workspaceService.archive(workspaceId, undefined, {
      refuseLiveUserActivity: true,
    });

    expect(result.success).toBe(false);
    if (!result.success) {
      expect(result.error).toContain("desktop viewer");
    }
    expect(close).not.toHaveBeenCalled();
  });

  test("archive() refuses while in-process workflow work exists under refuseLiveUserActivity", async () => {
    // Simulates a workflow admission/runner that entered before the archive gate armed: the
    // sink's synchronous gate must observe it and refuse instead of orphaning the run.
    const release = registerInProcessWorkflowRun(workspaceId);
    try {
      const refused = await workspaceService.archive(workspaceId, undefined, {
        refuseLiveUserActivity: true,
      });
      expect(refused.success).toBe(false);
      if (!refused.success) {
        expect(refused.error).toContain("workflow run starting or running");
      }
    } finally {
      release();
    }

    const archived = await workspaceService.archive(workspaceId, undefined, {
      refuseLiveUserActivity: true,
    });
    expect(archived).toEqual(Ok({ kind: "archived" }));
  });

  test("acquirePreInterruptionArchiveHold validates and arms the gate before turn interruption", async () => {
    await fsPromises.rm(externalEditorMarkerPath, { force: true });

    // In-flight user activity must refuse BEFORE the caller destroys delegated turns: the
    // sink's own gate runs only after interruption, when the turns are already lost.
    const release = registerInProcessWorkflowRun(workspaceId);
    let refused: ReturnType<typeof workspaceService.acquirePreInterruptionArchiveHold>;
    try {
      refused = workspaceService.acquirePreInterruptionArchiveHold(workspaceId, {
        queuedDelegatedTurnCount: 0,
        expectedDelegatedTurnCorrelations: [],
      });
    } finally {
      release();
    }
    expect(refused.success).toBe(false);
    if (!refused.success) {
      expect(refused.error).toContain("workflow run");
    }

    // MCP prompt discovery admitted before the hold pairs the same way: its counter refuses
    // the hold before any delegated turn is interrupted.
    const discovery = workspaceService.acquireMcpPromptDiscoveryAdmission(workspaceId);
    expect(discovery).toBeDefined();
    const refusedByDiscovery = workspaceService.acquirePreInterruptionArchiveHold(workspaceId, {
      queuedDelegatedTurnCount: 0,
      expectedDelegatedTurnCorrelations: [],
    });
    expect(refusedByDiscovery.success).toBe(false);
    if (!refusedByDiscovery.success) {
      expect(refusedByDiscovery.error).toContain("MCP prompt discovery in progress");
    }
    discovery![Symbol.dispose]();

    // In-flight editor/terminal opens are visible only through the pending-open counters
    // until their durable markers persist; the hold must refuse on them before the caller
    // interrupts anything (the sink's untrackable-app check would refuse only afterwards).
    const pendingOpen = workspaceService.recordExternalEditorOpenForLaunch(workspaceId);
    const refusedByOpen = workspaceService.acquirePreInterruptionArchiveHold(workspaceId, {
      queuedDelegatedTurnCount: 0,
      expectedDelegatedTurnCorrelations: [],
    });
    expect(refusedByOpen.success).toBe(false);
    if (!refusedByOpen.success) {
      expect(refusedByOpen.error).toContain("external editor open in progress");
    }
    const admittedOpen = await pendingOpen;
    expect(admittedOpen.success).toBe(true);
    if (admittedOpen.success) {
      await admittedOpen.data.rollbackAfterFailedLaunch();
    }

    // A refused hold releases the gate; a granted one arms it for the caller to carry
    // through the sink, refusing new user admissions exactly like the sink's own gate.
    const hold = workspaceService.acquirePreInterruptionArchiveHold(workspaceId, {
      queuedDelegatedTurnCount: 0,
      expectedDelegatedTurnCorrelations: [],
    });
    expect(hold.success).toBe(true);
    if (!hold.success) return;
    try {
      const refusedOpen = await workspaceService.recordExternalEditorOpen(workspaceId, "tok-hold");
      expect(refusedOpen.success).toBe(false);
      if (!refusedOpen.success) {
        expect(refusedOpen.error).toContain("being archived");
      }
      expect(workspaceService.acquireMcpPromptDiscoveryAdmission(workspaceId)).toBeUndefined();
    } finally {
      hold.data[Symbol.dispose]();
    }

    // Released (e.g. the archive failed): admissions flow again.
    const allowed = await workspaceService.recordExternalEditorOpen(workspaceId, "tok-hold-2");
    expect(allowed.success).toBe(true);
    await fsPromises.rm(externalEditorMarkerPath, { force: true });
  });

  test("acquirePreInterruptionArchiveHold binds the stream exemption to the delegated turns", () => {
    const delegated = { taskHandleId: "wt-1", ownerWorkspaceId: "owner-1", turnId: "turn-1" };
    const streamMeta: Record<string, unknown> = { type: "workspace-turn-task", ...delegated };
    Object.assign(mockAIService, { isStreaming: mock(() => true) });
    // The delegated-turn correlation is read from the engine, not the AI facade.
    mockStreamManager.getStreamInfo = mock(() => ({ muxMetadata: streamMeta }));

    // The active stream carries the collected turn's exact correlation: interruptible
    // delegated work, so the hold is granted.
    const held = workspaceService.acquirePreInterruptionArchiveHold(workspaceId, {
      queuedDelegatedTurnCount: 0,
      expectedDelegatedTurnCorrelations: [delegated],
    });
    expect(held.success).toBe(true);
    if (held.success) held.data[Symbol.dispose]();

    // A stream correlated to a DIFFERENT turn (the collected turn ended and something else
    // took the workspace's stream slot) must refuse — interruption would stopStream() it.
    streamMeta.turnId = "turn-2";
    const refusedMismatch = workspaceService.acquirePreInterruptionArchiveHold(workspaceId, {
      queuedDelegatedTurnCount: 0,
      expectedDelegatedTurnCorrelations: [delegated],
    });
    expect(refusedMismatch.success).toBe(false);
    if (!refusedMismatch.success) {
      expect(refusedMismatch.error).toContain("not attributable to the delegated turns");
    }

    // A stream with no correlation metadata (a plain user stream that replaced the ended
    // delegated stream) also refuses, even though a running delegated turn was collected —
    // the stale collection must not exempt whichever stream happens to be active now.
    Object.assign(mockAIService, {
      getStreamInfo: mock(() => ({ muxMetadata: undefined })),
    });
    const refusedPlain = workspaceService.acquirePreInterruptionArchiveHold(workspaceId, {
      queuedDelegatedTurnCount: 0,
      expectedDelegatedTurnCorrelations: [delegated],
    });
    expect(refusedPlain.success).toBe(false);
    if (!refusedPlain.success) {
      expect(refusedPlain.error).toContain("not attributable to the delegated turns");
    }
  });

  test("acquirePreInterruptionArchiveHold freezes queue dispatch for the hold's lifetime", () => {
    // A queued delegated entry that dispatched into PREPARING between the hold and turn
    // interruption would evade the interrupt's targeted queue removal, so the hold must
    // acquire the session's turn-admission block when it arms and release it on dispose.
    const session = workspaceService.getOrCreateSession(workspaceId);
    const realHoldTurnAdmission = session.holdTurnAdmission.bind(session);
    let releases = 0;
    const holdTurnAdmissionSpy = mock(() => {
      const inner = realHoldTurnAdmission();
      return {
        [Symbol.dispose]: () => {
          releases += 1;
          inner[Symbol.dispose]();
        },
      };
    });
    session.holdTurnAdmission = holdTurnAdmissionSpy;

    const held = workspaceService.acquirePreInterruptionArchiveHold(workspaceId, {
      queuedDelegatedTurnCount: 0,
      expectedDelegatedTurnCorrelations: [],
    });
    expect(held.success).toBe(true);
    expect(holdTurnAdmissionSpy).toHaveBeenCalledTimes(1);
    if (!held.success) return;
    // Held across interruption and the sink — not released before the caller disposes.
    expect(releases).toBe(0);
    held.data[Symbol.dispose]();
    expect(releases).toBe(1);

    // A refused hold must not leak the admission block either.
    Object.assign(mockAIService, {
      isStreaming: mock(() => true),
      getStreamInfo: mock(() => undefined),
    });
    const refused = workspaceService.acquirePreInterruptionArchiveHold(workspaceId, {
      queuedDelegatedTurnCount: 0,
      expectedDelegatedTurnCorrelations: [],
    });
    expect(refused.success).toBe(false);
    expect(releases).toBe(2);
  });

  test("acquirePreInterruptionArchiveHold exempts only a stoppable PREPARING delegated turn", () => {
    const delegated = { taskHandleId: "wt-1", ownerWorkspaceId: "owner-1", turnId: "turn-1" };
    const session = workspaceService.getOrCreateSession(workspaceId);
    session.isPreparingTurn = () => true;
    let stoppable: typeof delegated | undefined = delegated;
    session.getStoppablePreparingWorkspaceTurn = () => stoppable;
    let queued = 0;
    session.queuedMessageEntryCount = () => queued;

    // The collected turn itself is PREPARING with its startup registered: interruptWorkspaceTurn's
    // stopStream cancels it, so the hold is granted.
    const held = workspaceService.acquirePreInterruptionArchiveHold(workspaceId, {
      queuedDelegatedTurnCount: 0,
      expectedDelegatedTurnCorrelations: [delegated],
    });
    expect(held.success).toBe(true);
    if (held.success) held.data[Symbol.dispose]();

    // A user entry queued behind the exempt delegated turn is still user work.
    queued = 1;
    const refusedQueued = workspaceService.acquirePreInterruptionArchiveHold(workspaceId, {
      queuedDelegatedTurnCount: 0,
      expectedDelegatedTurnCorrelations: [delegated],
    });
    expect(refusedQueued.success).toBe(false);
    if (!refusedQueued.success) {
      expect(refusedQueued.error).toContain("queued messages beyond the delegated turns");
      expect(refusedQueued.error).not.toContain("a message dispatching");
    }
    queued = 0;

    // PREPARING for a different turn than the collected one (the collected turn ended and
    // another delegated turn took the session) is not the work the caller is interrupting.
    stoppable = { ...delegated, turnId: "turn-2" };
    const refusedMismatch = workspaceService.acquirePreInterruptionArchiveHold(workspaceId, {
      queuedDelegatedTurnCount: 0,
      expectedDelegatedTurnCorrelations: [delegated],
    });
    expect(refusedMismatch.success).toBe(false);
    if (!refusedMismatch.success) {
      expect(refusedMismatch.error).toContain("a message dispatching");
    }

    // PREPARING work that has not handed its startup to the engine (or a user send) reports no
    // stoppable turn: a stop there would not cancel it, so the hold fails closed.
    stoppable = undefined;
    const refusedUnstoppable = workspaceService.acquirePreInterruptionArchiveHold(workspaceId, {
      queuedDelegatedTurnCount: 0,
      expectedDelegatedTurnCorrelations: [delegated],
    });
    expect(refusedUnstoppable.success).toBe(false);
    if (!refusedUnstoppable.success) {
      expect(refusedUnstoppable.error).toContain("a message dispatching");
    }
  });

  test("archive sink admits a PREPARING delegated turn once its interruption has settled", async () => {
    // End to end through a real session: the delegated send is PREPARING with its startup
    // registered, the hold exempts it, the engine-side stop cancels it, and the sink accepts
    // only after the aborted turn has unwound (stopStream resolves before that happens).
    const delegated = { taskHandleId: "wt-prep", ownerWorkspaceId: "owner-1", turnId: "turn-prep" };
    const syntheticMessageId = "starting-prep";
    const aiEmitter = new EventEmitter();
    const entered = Promise.withResolvers<void>();
    const abortController = new AbortController();
    // StreamManager.stopStream for a pending start: abort it and deliver the startup abort.
    const stopStream = mock(() => {
      abortController.abort("system");
      aiEmitter.emit("stream-abort", {
        type: "stream-abort",
        workspaceId,
        messageId: syntheticMessageId,
        abortReason: "system",
        metadata: {},
      });
      return Promise.resolve(Ok(undefined));
    });
    const harness = await createAgentSessionHarness({
      workspaceId,
      historyService,
      aiEmitter,
      aiServiceOverrides: {
        streamMessage: mock(async (request: Parameters<AIService["streamMessage"]>[0]) => {
          // StreamManager registers the pending start before its first await.
          request.onStreamStarting?.(syntheticMessageId);
          entered.resolve();
          await new Promise<void>((resolve) => {
            abortController.signal.addEventListener("abort", () => resolve(), { once: true });
          });
          const completion: TurnCompletion = { status: "aborted", abortReason: "system" };
          return Ok({ messageId: syntheticMessageId, completion: Promise.resolve(completion) });
        }),
        stopStream,
      },
    });
    const internal = workspaceService as unknown as {
      sessions: Map<string, AgentSession>;
      aiService: typeof harness.aiService;
    };
    internal.sessions.set(workspaceId, harness.session);
    internal.aiService = harness.aiService;
    try {
      const sent = harness.session.sendMessage(
        "Summarize",
        {
          model: "anthropic:claude-sonnet-4-5",
          agentId: "exec",
          muxMetadata: { type: "workspace-turn-task", ...delegated },
        },
        { startStreamInBackground: true }
      );
      await entered.promise;
      // The PREPARING send reads as a queued message to the coarse activity snapshot; the
      // correlation is what tells it apart from user input.
      expect(workspaceService.listLiveWorkspaceActivity(workspaceId).queuedMessages).toBe(true);
      expect(workspaceService.getStoppablePreparingWorkspaceTurn(workspaceId)).toEqual(delegated);

      const refused = workspaceService.acquirePreInterruptionArchiveHold(workspaceId, {
        queuedDelegatedTurnCount: 0,
        expectedDelegatedTurnCorrelations: [],
      });
      expect(refused.success).toBe(false);
      if (!refused.success) {
        expect(refused.error).toContain("a message dispatching");
      }
      expect(harness.session.isPreparingTurn()).toBe(true);

      const hold = workspaceService.acquirePreInterruptionArchiveHold(workspaceId, {
        queuedDelegatedTurnCount: 0,
        expectedDelegatedTurnCorrelations: [delegated],
      });
      expect(hold.success).toBe(true);
      if (!hold.success) return;
      try {
        // What interruptWorkspaceTurn does for a running handle. The engine has aborted when
        // this resolves, but the session's aborted turn has not reached policy yet.
        expect((await stopStream()).success).toBe(true);
        expect(harness.session.isPreparingTurn()).toBe(true);

        await workspaceService.waitForIdle(workspaceId);
        expect((await sent).success).toBe(true);
        expect(harness.session.hasActiveOrPendingTurnWork()).toBe(false);
        expect(
          await workspaceService.archive(workspaceId, undefined, { refuseLiveUserActivity: true })
        ).toEqual(Ok({ kind: "archived" }));
      } finally {
        hold.data[Symbol.dispose]();
      }
    } finally {
      internal.sessions.delete(workspaceId);
      await harness.session.dispose();
    }
  });

  test("fork() refuses while the source workspace is being archived", async () => {
    // Source-fork admission pairs with the archive gates: a Coder-stop archive must not stop
    // the dedicated remote workspace mid-clone while a fork shares it.
    addToArchivingWorkspaces(workspaceService, workspaceId);

    const result = await workspaceService.fork(workspaceId);

    expect(result.success).toBe(false);
    if (!result.success) {
      expect(result.error).toContain("being archived");
    }
  });

  test("archive() rechecks durably active workflow runs after arming the admission gate", async () => {
    workspaceService.setAgentTaskIntegration(
      makeAgentTaskIntegrationFake({
        hasActiveTopLevelWorkflowRunsForWorkspace: mock(() => Promise.resolve(true)),
      })
    );

    const result = await workspaceService.archive(workspaceId, undefined, {
      refuseLiveUserActivity: true,
    });

    expect(result.success).toBe(false);
    if (!result.success) {
      expect(result.error).toContain("active workflow runs");
    }
  });

  test("archive() refuses when durable spawn records show crash-orphaned background processes", async () => {
    // Simulates the post-unclean-restart state: the manager's in-memory map is empty but a
    // durable spawn record still points at a live nohup/setsid child (probe behavior itself
    // is covered in backgroundProcessManager.test.ts).
    (
      mockBackgroundProcessManager.hasOrphanedRunningBackgroundProcesses as Mock<
        (workspaceId: string) => Promise<boolean>
      >
    ).mockImplementationOnce(() => Promise.resolve(true));

    const result = await workspaceService.archive(workspaceId, undefined, {
      refuseLiveUserActivity: true,
    });

    expect(result.success).toBe(false);
    if (!result.success) {
      expect(result.error).toContain("previous app session");
    }
  });

  test("recordExternalEditorOpen refuses while the workspace is being archived", async () => {
    // A crashed prior run may have leaked the shared-session-dir marker; clear it first.
    await fsPromises.rm(externalEditorMarkerPath, { force: true });
    addToArchivingWorkspaces(workspaceService, workspaceId);

    const result = await workspaceService.recordExternalEditorOpen(workspaceId, "tok-refused");

    expect(result.success).toBe(false);
    if (!result.success) {
      expect(result.error).toContain("being archived");
    }
    // The refused open launched nothing, so its reservation rolls back: a sticky entry would
    // permanently refuse model-driven snapshot/Coder-stop archives after unarchive.
    expect(await workspaceService.hasUntrackableExternalAppOpen(workspaceId)).toBe(false);
  });

  test("recordExternalEditorOpen rejects workspace IDs without a config entry", async () => {
    await fsPromises.rm(externalEditorMarkerPath, { force: true });

    // Unknown IDs never reach the marker path (which joins the raw ID beneath the sessions
    // directory), closing both stale-ID requests and traversal-crafted IDs.
    const result = await workspaceService.recordExternalEditorOpen("../../etc-trap", "tok-trap");

    expect(result.success).toBe(false);
    if (!result.success) {
      expect(result.error).toContain("not found");
    }
    let markerExists = true;
    try {
      await fsPromises.access(externalEditorMarkerPath);
    } catch {
      markerExists = false;
    }
    expect(markerExists).toBe(false);
    // The rejected reservation rolled back too.
    expect(await workspaceService.hasUntrackableExternalAppOpen("../../etc-trap")).toBe(false);
  });

  test("recordExternalEditorOpen marks the workspace as having an untrackable app open", async () => {
    // A crashed prior run may have leaked the shared-session-dir marker; clear it first.
    await fsPromises.rm(externalEditorMarkerPath, { force: true });
    expect(await workspaceService.hasUntrackableExternalAppOpen(workspaceId)).toBe(false);

    const result = await workspaceService.recordExternalEditorOpen(workspaceId, "tok-marks");
    expect(result.success).toBe(true);
    expect(await workspaceService.hasUntrackableExternalAppOpen(workspaceId)).toBe(true);

    // The durable marker outlives this test run; remove it so "not yet opened" assertions in
    // future runs (this fixture shares one session dir) stay deterministic.
    await fsPromises.rm(externalEditorMarkerPath, { force: true });
  });

  test("recordExternalEditorOpenForLaunch rolls back a freshly created marker after a failed launch", async () => {
    await fsPromises.rm(externalEditorMarkerPath, { force: true });

    const admitted = await workspaceService.recordExternalEditorOpenForLaunch(workspaceId);
    expect(admitted.success).toBe(true);
    if (!admitted.success) return;
    expect(await workspaceService.hasUntrackableExternalAppOpen(workspaceId)).toBe(true);

    // EditorService failures occur only before its detached spawn (missing executable,
    // unsupported runtime), so nothing launched: the marker this recording created must not
    // permanently refuse future model-driven snapshot/Coder-stop archives.
    await admitted.data.rollbackAfterFailedLaunch();
    expect(await workspaceService.hasUntrackableExternalAppOpen(workspaceId)).toBe(false);
  });

  test("rollbackAfterFailedLaunch removes the marker when every open in a concurrent batch fails", async () => {
    await fsPromises.rm(externalEditorMarkerPath, { force: true });

    // Two first-time recordings overlap in flight: the second sees the marker written by the
    // first, but that in-flight marker must not masquerade as evidence of a real prior
    // launch — when both launches fail, the whole batch failed and the marker must go.
    const [first, second] = await Promise.all([
      workspaceService.recordExternalEditorOpenForLaunch(workspaceId),
      workspaceService.recordExternalEditorOpenForLaunch(workspaceId),
    ]);
    expect(first.success).toBe(true);
    expect(second.success).toBe(true);
    if (!first.success || !second.success) return;

    await first.data.rollbackAfterFailedLaunch();
    // One failed launch alone must not delete the marker (the other may still launch).
    expect(await workspaceService.hasUntrackableExternalAppOpen(workspaceId)).toBe(true);
    await second.data.rollbackAfterFailedLaunch();
    expect(await workspaceService.hasUntrackableExternalAppOpen(workspaceId)).toBe(false);
  });

  test("rollbackRecordedEditorOpen redeems a renderer launch token", async () => {
    await fsPromises.rm(externalEditorMarkerPath, { force: true });

    // Client-generated token: the renderer knows it even when the recording response is
    // lost, so an ambiguous outcome can still be reconciled.
    const recorded = await workspaceService.recordExternalEditorOpen(workspaceId, "tok-redeem");
    expect(recorded.success).toBe(true);
    expect(await workspaceService.hasUntrackableExternalAppOpen(workspaceId)).toBe(true);

    // The renderer's placeholder window was closed before navigation: the deep link provably
    // never launched, so redeeming the token must roll the durable marker back.
    const rolledBack = await workspaceService.rollbackRecordedEditorOpen(workspaceId, "tok-redeem");
    expect(rolledBack.success).toBe(true);
    expect(await workspaceService.hasUntrackableExternalAppOpen(workspaceId)).toBe(false);

    // Idempotent: redeeming again (or redeeming a token that was never committed) is a
    // safe no-op.
    expect(
      (await workspaceService.rollbackRecordedEditorOpen(workspaceId, "tok-redeem")).success
    ).toBe(true);
    expect(
      (await workspaceService.rollbackRecordedEditorOpen(workspaceId, "tok-never-committed"))
        .success
    ).toBe(true);
  });

  test("rollbackRecordedEditorOpen tombstones a token whose recording is still in flight", async () => {
    await fsPromises.rm(externalEditorMarkerPath, { force: true });

    // The renderer saw its recording RPC reject at the transport while the backend handler
    // was still persisting the marker, and rolled back immediately. The not-yet-registered
    // token must not no-op: the handler would then commit a durable marker for a launch the
    // renderer already abandoned, permanently refusing future model-driven archives.
    const pending = workspaceService.recordExternalEditorOpen(workspaceId, "tok-inflight");
    const rolledBack = await workspaceService.rollbackRecordedEditorOpen(
      workspaceId,
      "tok-inflight"
    );
    expect(rolledBack.success).toBe(true);

    const recorded = await pending;
    expect(recorded.success).toBe(false);
    if (!recorded.success) {
      expect(recorded.error).toContain("rolled back");
    }
    expect(await workspaceService.hasUntrackableExternalAppOpen(workspaceId)).toBe(false);
  });

  test("a failed marker persistence does not leave stale ancestry for the next attempt", async () => {
    await fsPromises.rm(externalEditorMarkerPath, { force: true });

    // Same filesystem hiccup hits both the probe (EACCES -> fail-closed "unknown", so the
    // batch records markerPreexisted: true) and the write. The failed attempt must discard
    // that batch; otherwise the retry below would join it and its rollback would preserve a
    // marker no launch ever backed.
    const accessSpy = spyOn(fsPromises, "access").mockImplementationOnce(() =>
      Promise.reject(Object.assign(new Error("EACCES: permission denied"), { code: "EACCES" }))
    );
    const writeSpy = spyOn(fsPromises, "writeFile").mockImplementationOnce(() =>
      Promise.reject(Object.assign(new Error("EIO: i/o error"), { code: "EIO" }))
    );
    try {
      const failed = await workspaceService.recordExternalEditorOpenForLaunch(workspaceId);
      expect(failed.success).toBe(false);

      const retried = await workspaceService.recordExternalEditorOpenForLaunch(workspaceId);
      expect(retried.success).toBe(true);
      if (!retried.success) return;
      await retried.data.rollbackAfterFailedLaunch();
      expect(await workspaceService.hasUntrackableExternalAppOpen(workspaceId)).toBe(false);
    } finally {
      accessSpy.mockRestore();
      writeSpy.mockRestore();
    }
  });

  test("archive gating stays closed while an editor recording is in flight", async () => {
    await fsPromises.rm(externalEditorMarkerPath, { force: true });

    // Freeze the recording at its marker write: the pending-recording count must keep the
    // untrackable-app probe true for the whole in-flight window even though no durable
    // marker or cache entry exists yet (a concurrent rollback may have collapsed them).
    let releaseWrite!: () => void;
    const writeGate = new Promise<void>((resolve) => {
      releaseWrite = resolve;
    });
    const writeSpy = spyOn(fsPromises, "writeFile").mockImplementationOnce(async () => {
      await writeGate;
    });
    try {
      const pending = workspaceService.recordExternalEditorOpenForLaunch(workspaceId);
      expect(await workspaceService.hasUntrackableExternalAppOpen(workspaceId)).toBe(true);

      releaseWrite();
      const admitted = await pending;
      expect(admitted.success).toBe(true);
      if (!admitted.success) return;
      // Clean up: the gated write never created a real marker, so a failed-launch rollback
      // clears the in-memory record.
      await admitted.data.rollbackAfterFailedLaunch();
      expect(await workspaceService.hasUntrackableExternalAppOpen(workspaceId)).toBe(false);
    } finally {
      writeSpy.mockRestore();
    }
  });

  test("rollbackAfterFailedLaunch preserves a marker that predates the recording", async () => {
    // An earlier session's editor may still be running behind a pre-existing marker; a later
    // failed launch must not delete the evidence protecting it.
    await fsPromises.mkdir("/tmp/test/sessions", { recursive: true });
    await fsPromises.writeFile(externalEditorMarkerPath, "earlier session");

    const admitted = await workspaceService.recordExternalEditorOpenForLaunch(workspaceId);
    expect(admitted.success).toBe(true);
    if (!admitted.success) return;
    await admitted.data.rollbackAfterFailedLaunch();
    expect(await workspaceService.hasUntrackableExternalAppOpen(workspaceId)).toBe(true);

    await fsPromises.rm(externalEditorMarkerPath, { force: true });
  });

  test("rollbackAfterFailedLaunch preserves the marker while another open holds launch evidence", async () => {
    await fsPromises.rm(externalEditorMarkerPath, { force: true });

    const failing = await workspaceService.recordExternalEditorOpenForLaunch(workspaceId);
    expect(failing.success).toBe(true);
    // A deep-link open recorded meanwhile launches in the renderer unconditionally; its
    // evidence must keep protecting the marker when the custom-editor launch fails.
    const deepLink = await workspaceService.recordExternalEditorOpen(workspaceId, "tok-deep-link");
    expect(deepLink.success).toBe(true);
    if (!failing.success) return;

    await failing.data.rollbackAfterFailedLaunch();
    expect(await workspaceService.hasUntrackableExternalAppOpen(workspaceId)).toBe(true);

    await fsPromises.rm(externalEditorMarkerPath, { force: true });
  });

  test("archive waits for a retained background-init settlement before proceeding", async () => {
    // Aborting init only signals: the fire-and-forget init hook process settles later, and
    // snapshot capture / checkout deletion / Coder hooks must not run under its writes.
    let releaseInit!: () => void;
    const settlement = new Promise<void>((resolve) => {
      releaseInit = resolve;
    });
    // eslint-disable-next-line @typescript-eslint/no-explicit-any, @typescript-eslint/no-unsafe-member-access, @typescript-eslint/no-unsafe-call
    (workspaceService as any).initSettlementPromises.set(workspaceId, settlement);

    let archiveSettled = false;
    const archivePromise = workspaceService.archive(workspaceId).then((result) => {
      archiveSettled = true;
      return result;
    });
    // Generous scheduling room: without the settlement await, this mock-backed archive
    // completes within these turns and the assertion below goes red.
    for (let i = 0; i < 50; i++) {
      await new Promise((resolve) => setImmediate(resolve));
    }
    expect(archiveSettled).toBe(false);

    releaseInit();
    expect(await archivePromise).toEqual(Ok({ kind: "archived" }));
  });

  test("resumeStream refuses while the workspace is being archived", async () => {
    addToArchivingWorkspaces(workspaceService, workspaceId);

    const result = await workspaceService.resumeStream(workspaceId, {
      model: "openai:gpt-4o-mini",
      agentId: "exec",
    } satisfies SendMessageOptions);

    expect(result.success).toBe(false);
    if (!result.success) {
      expect(result.error.type).toBe("unknown");
      if (result.error.type === "unknown") {
        expect(result.error.raw).toContain("being archived");
      }
    }
  });

  test("resumeStream refuses archived workspaces", async () => {
    const entry = configState.projects.get(projectPath)?.workspaces[0];
    expect(entry).toBeDefined();
    if (entry) {
      entry.archivedAt = "2026-01-01T00:00:00.000Z";
    }

    const result = await workspaceService.resumeStream(workspaceId, {
      model: "openai:gpt-4o-mini",
      agentId: "exec",
    } satisfies SendMessageOptions);

    expect(result.success).toBe(false);
    if (!result.success) {
      expect(result.error.type).toBe("unknown");
      if (result.error.type === "unknown") {
        expect(result.error.raw).toContain("archived");
      }
    }
  });
});

describe("WorkspaceService archive init cancellation", () => {
  let historyService: HistoryService;
  let cleanupHistory: () => Promise<void>;

  beforeEach(async () => {
    ({ historyService, cleanup: cleanupHistory } = await createTestHistoryService());
  });

  afterEach(async () => {
    await cleanupHistory();
  });

  test("emits metadata when it cancels init but beforeArchive hook fails", async () => {
    const workspaceId = "ws-archive-init-cancel";
    const projectPath = "/tmp/project";
    const workspacePath = "/tmp/project/ws-archive-init-cancel";

    const initStates = new Map<string, InitStatus>([
      [
        workspaceId,
        {
          status: "running",
          hookPath: projectPath,
          startTime: 0,
          lines: [],
          exitCode: null,
          endTime: null,
        },
      ],
    ]);

    const clearInMemoryStateMock = mock((id: string) => {
      initStates.delete(id);
    });

    const mockInitStateManager: Partial<InitStateManager> = {
      on: mock(() => undefined as unknown as InitStateManager),
      getInitState: mock((id: string) => initStates.get(id)),
      clearInMemoryState: clearInMemoryStateMock,
    };

    let configState: ProjectsConfig = {
      projects: new Map([
        [
          projectPath,
          {
            workspaces: [
              {
                path: workspacePath,
                id: workspaceId,
              },
            ],
          },
        ],
      ]),
    };

    const editConfigSpy = mock((fn: (config: ProjectsConfig) => ProjectsConfig) => {
      configState = fn(configState);
      return Promise.resolve();
    });

    const frontendMetadata: FrontendWorkspaceMetadata = {
      id: workspaceId,
      name: "ws-archive-init-cancel",
      projectName: "proj",
      projectPath,
      runtimeConfig: { type: "local", srcBaseDir: "/tmp" },
      namedWorkspacePath: workspacePath,
    };

    const workspaceMetadata: WorkspaceMetadata = {
      id: workspaceId,
      name: "ws-archive-init-cancel",
      projectName: "proj",
      projectPath,
      runtimeConfig: { type: "local", srcBaseDir: "/tmp" },
    };

    const mockConfig: MockWorkspaceConfig = {
      srcDir: "/tmp/src",
      sessionsDir: "/tmp/test/sessions",
      generateStableId: mock(() => "test-id"),
      findWorkspace: mock((id: string) => {
        if (id !== workspaceId) {
          return null;
        }

        return { projectPath, workspacePath };
      }),
      editConfig: editConfigSpy,
      getAllWorkspaceMetadata: mock(() => Promise.resolve([frontendMetadata])),
      loadConfigOrDefault: mock(() => configState),
    };

    const mockAIService: AIService = {
      ...createStreamLifecycleMocks(),
      isStreaming: mock(() => false),
      getWorkspaceMetadata: mock(() => Promise.resolve(Ok(workspaceMetadata))),
      // eslint-disable-next-line @typescript-eslint/no-empty-function
      on: mock(() => {}),
      // eslint-disable-next-line @typescript-eslint/no-empty-function
      off: mock(() => {}),
    } as unknown as AIService;

    const workspaceService = new WorkspaceService(
      withExistingConfigLoader(mockConfig) as Config,
      historyService,
      mockAIService,
      mockInitStateManager as InitStateManager,
      {} as ExtensionMetadataService,
      { cleanup: mock(() => Promise.resolve()) } as unknown as BackgroundProcessManager
    );

    // Seed abort controller so archive() can cancel init.
    const abortController = new AbortController();
    const initAbortControllers = (
      workspaceService as unknown as { initAbortControllers: Map<string, AbortController> }
    ).initAbortControllers;
    initAbortControllers.set(workspaceId, abortController);

    const metadataEvents: Array<FrontendWorkspaceMetadata | null> = [];
    workspaceService.on("metadata", (event: unknown) => {
      if (!event || typeof event !== "object") {
        return;
      }
      const parsed = event as { workspaceId: string; metadata: FrontendWorkspaceMetadata | null };
      if (parsed.workspaceId === workspaceId) {
        metadataEvents.push(parsed.metadata);
      }
    });

    const hooks = new WorkspaceLifecycleHooks();
    hooks.registerBeforeArchive(() => Promise.resolve(Err("hook failed")));
    workspaceService.setWorkspaceLifecycleHooks(hooks);

    const result = await workspaceService.archive(workspaceId);

    expect(result.success).toBe(false);
    if (!result.success) {
      expect(result.error).toBe("hook failed");
    }

    // Ensure we didn't persist archivedAt on hook failure.
    expect(editConfigSpy).toHaveBeenCalledTimes(0);
    const entry = configState.projects.get(projectPath)?.workspaces[0];
    expect(entry?.archivedAt).toBeUndefined();

    expect(abortController.signal.aborted).toBe(true);
    expect(clearInMemoryStateMock).toHaveBeenCalledWith(workspaceId);

    expect(metadataEvents.length).toBeGreaterThanOrEqual(1);
    expect(metadataEvents.at(-1)?.isInitializing).toBe(undefined);
  });
});

describe("WorkspaceService unarchive lifecycle hooks", () => {
  const workspaceId = "ws-unarchive";
  const projectPath = "/tmp/project";
  const workspacePath = "/tmp/project/ws-unarchive";

  let workspaceService: WorkspaceService;
  let configState: ProjectsConfig;
  let editConfigSpy: ReturnType<typeof mock>;
  let historyService: HistoryService;
  let cleanupHistory: () => Promise<void>;

  const workspaceMetadata: FrontendWorkspaceMetadata = {
    id: workspaceId,
    name: "ws-unarchive",
    projectName: "proj",
    projectPath,
    runtimeConfig: { type: "local", srcBaseDir: "/tmp" },
    archivedAt: "2020-01-01T00:00:00.000Z",
    namedWorkspacePath: workspacePath,
  };

  beforeEach(async () => {
    ({ historyService, cleanup: cleanupHistory } = await createTestHistoryService());

    configState = {
      projects: new Map([
        [
          projectPath,
          {
            workspaces: [
              {
                path: workspacePath,
                id: workspaceId,
                archivedAt: "2020-01-01T00:00:00.000Z",
              },
            ],
          },
        ],
      ]),
    };

    editConfigSpy = mock((fn: (config: ProjectsConfig) => ProjectsConfig) => {
      configState = fn(configState);
      return Promise.resolve();
    });

    const mockConfig: MockWorkspaceConfig = {
      srcDir: "/tmp/src",
      sessionsDir: "/tmp/test/sessions",
      generateStableId: mock(() => "test-id"),
      findWorkspace: mock((id: string) => {
        if (id !== workspaceId) {
          return null;
        }

        return { projectPath, workspacePath };
      }),
      editConfig: editConfigSpy,
      getAllWorkspaceMetadata: mock(() => Promise.resolve([workspaceMetadata])),
    };
    const aiService: AIService = {
      ...createStreamLifecycleMocks(),
      isStreaming: mock(() => false),
      getWorkspaceMetadata: mock(() => Promise.resolve(Ok(workspaceMetadata))),
      // eslint-disable-next-line @typescript-eslint/no-empty-function
      on: mock(() => {}),
      // eslint-disable-next-line @typescript-eslint/no-empty-function
      off: mock(() => {}),
    } as unknown as AIService;

    workspaceService = createWorkspaceServiceForTest({
      config: mockConfig,
      historyService,
      aiService,
      initStateManager: mockInitStateManager as InitStateManager,
    });
  });

  afterEach(async () => {
    await cleanupHistory();
  });

  test.each([
    ["shared", "interrupted", "owner"],
    ["isolated", "queued", undefined],
  ] as const)(
    "unarchiving a legacy archived %s queued child leaves its task status %s",
    async (_kind, expectedStatus, taskDesktopOwnerWorkspaceId) => {
      const project = configState.projects.get(projectPath);
      if (!project) throw new Error("project fixture must exist");
      project.workspaces.unshift({ path: "/tmp/project/owner", id: "owner" });
      Object.assign(project.workspaces[1], {
        parentWorkspaceId: "owner",
        taskStatus: "queued",
        ...(taskDesktopOwnerWorkspaceId !== undefined ? { taskDesktopOwnerWorkspaceId } : {}),
      });

      expect(await workspaceService.unarchive(workspaceId)).toEqual(Ok(undefined));

      // Records archived before archive-time settlement must not resurface as a second active
      // controller in the same edit that makes them visible again.
      const entry = project.workspaces.find((w) => w.id === workspaceId);
      expect(entry?.unarchivedAt).toBeTruthy();
      expect(entry?.taskStatus).toBe(expectedStatus);
    }
  );

  test("persists unarchivedAt and runs afterUnarchive hooks (best-effort)", async () => {
    const hooks = new WorkspaceLifecycleHooks();

    const afterHook = mock(() => {
      const entry = configState.projects.get(projectPath)?.workspaces[0];
      expect(entry?.unarchivedAt).toBeTruthy();
      return Promise.resolve(Err("hook failed"));
    });
    hooks.registerAfterUnarchive(afterHook);

    workspaceService.setWorkspaceLifecycleHooks(hooks);

    const result = await workspaceService.unarchive(workspaceId);

    expect(result.success).toBe(true);
    expect(afterHook).toHaveBeenCalledTimes(1);

    const entry = configState.projects.get(projectPath)?.workspaces[0];
    expect(entry?.unarchivedAt).toBeTruthy();
    expect(entry?.unarchivedAt).toMatch(/^\d{4}-\d{2}-\d{2}T/);
  });

  test("does not run afterUnarchive hooks when workspace is not archived", async () => {
    const entry = configState.projects.get(projectPath)?.workspaces[0];
    if (!entry) {
      throw new Error("Missing workspace entry");
    }
    entry.archivedAt = undefined;

    const hooks = new WorkspaceLifecycleHooks();
    const afterHook = mock(() => Promise.resolve(Ok(undefined)));
    hooks.registerAfterUnarchive(afterHook);
    workspaceService.setWorkspaceLifecycleHooks(hooks);

    const result = await workspaceService.unarchive(workspaceId);

    expect(result.success).toBe(true);
    expect(afterHook).toHaveBeenCalledTimes(0);
  });
  test("unarchiving with missing managed worktree does not recreate the directory", async () => {
    const result = await workspaceService.unarchive(workspaceId);

    expect(result.success).toBe(true);

    const entry = configState.projects.get(projectPath)?.workspaces[0];
    expect(entry?.unarchivedAt).toBeTruthy();
    expect(entry?.unarchivedAt).toMatch(/^\d{4}-\d{2}-\d{2}T/);

    expect(
      await fsPromises
        .access(workspacePath)
        .then(() => true)
        .catch(() => false)
    ).toBe(false);
    expect(entry?.path).toBe(workspacePath);
  });
});

describe("WorkspaceService archive snapshots", () => {
  const workspaceId = "ws-archive-snapshot";
  const projectPath = "/tmp/project";
  const workspacePath = "/tmp/project/ws-archive-snapshot";

  let historyService: HistoryService;
  let cleanupHistory: () => Promise<void>;
  let configState: ProjectsConfig;
  let editConfigSpy: ReturnType<typeof mock>;
  let workspaceService: WorkspaceService;

  const workspaceMetadata: WorkspaceMetadata = {
    id: workspaceId,
    name: "ws-archive-snapshot",
    projectName: "proj",
    projectPath,
    runtimeConfig: { type: "worktree", srcBaseDir: "/tmp/src" },
  };

  beforeEach(async () => {
    ({ historyService, cleanup: cleanupHistory } = await createTestHistoryService());

    configState = {
      projects: new Map([
        [
          projectPath,
          {
            workspaces: [
              {
                path: workspacePath,
                id: workspaceId,
                name: "ws-archive-snapshot",
                runtimeConfig: { type: "worktree", srcBaseDir: "/tmp/src" },
              },
            ],
          },
        ],
      ]),
      worktreeArchiveBehavior: "snapshot",
    };

    editConfigSpy = mock((fn: (config: ProjectsConfig) => ProjectsConfig) => {
      configState = fn(configState);
      return Promise.resolve();
    });

    const mockConfig: MockWorkspaceConfig = {
      srcDir: "/tmp/src",
      sessionsDir: "/tmp/test/sessions",
      generateStableId: mock(() => "test-id"),
      findWorkspace: mock((id: string) => {
        if (id !== workspaceId) {
          return null;
        }

        return { projectPath, workspacePath };
      }),
      editConfig: editConfigSpy,
      getAllWorkspaceMetadata: mock(() => Promise.resolve([])),
      loadConfigOrDefault: mock(() => configState),
    };
    const aiService: AIService = {
      ...createStreamLifecycleMocks(),
      isStreaming: mock(() => false),
      getWorkspaceMetadata: mock(() => Promise.resolve(Ok(workspaceMetadata))),
      on: mock(() => undefined),
      off: mock(() => undefined),
    } as unknown as AIService;

    workspaceService = createWorkspaceServiceForTest({
      config: mockConfig,
      historyService,
      aiService,
      initStateManager: mockInitStateManager as InitStateManager,
    });
  });

  afterEach(async () => {
    await cleanupHistory();
  });

  test("archive() persists captured snapshot metadata together with archivedAt", async () => {
    const snapshot = {
      version: 1 as const,
      capturedAt: "2026-03-30T00:00:00.000Z",
      stateDirPath: "archive-state",
      projects: [
        {
          projectPath,
          projectName: "proj",
          storageKey: "proj",
          branchName: "ws-archive-snapshot",
          trunkBranch: "main",
          baseSha: "base-sha",
          headSha: "head-sha",
        },
      ],
    };
    const captureSnapshotForArchive = mock(() => Promise.resolve(Ok(snapshot)));
    workspaceService.setWorktreeArchiveSnapshotService({
      preflightSnapshotForArchive: mock(() => Promise.resolve(Ok(undefined))),
      captureSnapshotForArchive,
      restoreSnapshotAfterUnarchive: mock(() => Promise.resolve(Ok("skipped" as const))),
      getUnsupportedUntrackedPaths: mock(() => Promise.resolve(Ok([]))),
    });

    const result = await workspaceService.archive(workspaceId);

    expect(result).toEqual(Ok({ kind: "archived" }));
    const entry = configState.projects.get(projectPath)?.workspaces[0];
    expect(entry?.archivedAt).toBeTruthy();
    expect(entry?.worktreeArchiveSnapshot).toEqual(snapshot);
    expect(captureSnapshotForArchive).toHaveBeenCalledWith({
      workspaceId,
      workspaceMetadata,
      acknowledgedUntrackedPaths: undefined,
    });
  });

  test("archive() stops cached MCP servers before snapshot capture", async () => {
    const order: string[] = [];
    const stopServers = mock(
      (_workspaceId: string, _options?: { retainRestartOptions?: boolean }) => {
        order.push("stop-mcp");
        return Promise.resolve();
      }
    );
    workspaceService.setMCPServerManager({ stopServers } as unknown as MCPServerManager);
    const snapshot = {
      version: 1 as const,
      capturedAt: "2026-03-30T00:00:00.000Z",
      stateDirPath: "archive-state",
      projects: [],
    };
    workspaceService.setWorktreeArchiveSnapshotService({
      preflightSnapshotForArchive: mock(() => Promise.resolve(Ok(undefined))),
      captureSnapshotForArchive: mock(() => {
        order.push("capture");
        return Promise.resolve(Ok(snapshot));
      }),
      restoreSnapshotAfterUnarchive: mock(() => Promise.resolve(Ok("skipped" as const))),
      getUnsupportedUntrackedPaths: mock(() => Promise.resolve(Ok([]))),
    });

    const result = await workspaceService.archive(workspaceId);

    expect(result).toEqual(Ok({ kind: "archived" }));
    // Removal-style stop (no retainRestartOptions) so its stop epoch retires in-flight startups.
    expect(stopServers).toHaveBeenCalledWith(workspaceId);
    expect(order).toEqual(["stop-mcp", "capture"]);
  });

  test("in-flight MCP prompt discovery holds the model-facing archive gate until released", async () => {
    workspaceService.setWorktreeArchiveSnapshotService({
      preflightSnapshotForArchive: mock(() => Promise.resolve(Ok(undefined))),
      captureSnapshotForArchive: mock(() => Promise.resolve(Err("unused"))),
      restoreSnapshotAfterUnarchive: mock(() => Promise.resolve(Ok("skipped" as const))),
      getUnsupportedUntrackedPaths: mock(() => Promise.resolve(Ok([]))),
    });

    const admission = workspaceService.acquireMcpPromptDiscoveryAdmission(workspaceId);
    expect(admission).toBeDefined();

    const refused = await workspaceService.archive(workspaceId, undefined, {
      refuseLiveUserActivity: true,
    });
    expect(refused.success).toBe(false);
    if (!refused.success) {
      expect(refused.error).toContain("an MCP prompt discovery in progress");
    }
    expect(configState.projects.get(projectPath)?.workspaces[0]?.archivedAt).toBeUndefined();

    admission![Symbol.dispose]();

    const afterRelease = await workspaceService.archive(workspaceId, undefined, {
      refuseLiveUserActivity: true,
    });
    if (!afterRelease.success) {
      expect(afterRelease.error).not.toContain("MCP prompt discovery");
    }
  });

  test("acquireMcpPromptDiscoveryAdmission refuses archiving and archived workspaces", () => {
    addToArchivingWorkspaces(workspaceService, workspaceId);
    expect(workspaceService.acquireMcpPromptDiscoveryAdmission(workspaceId)).toBeUndefined();

    // Discovery on an archived workspace would re-wake its runtime; refuse it durably too.
    const archivedService = createWorkspaceServiceForTest({
      config: {
        srcDir: "/tmp/src",
        sessionsDir: "/tmp/test/sessions",
        loadConfigOrDefault: mock(() => ({
          projects: new Map([
            [
              projectPath,
              {
                workspaces: [
                  {
                    path: workspacePath,
                    id: workspaceId,
                    name: "ws-archive-snapshot",
                    archivedAt: "2026-01-01T00:00:00.000Z",
                  },
                ],
              },
            ],
          ]),
        })),
      } as unknown as Config,
      historyService,
    });
    expect(archivedService.acquireMcpPromptDiscoveryAdmission(workspaceId)).toBeUndefined();
    expect(archivedService.acquireMcpPromptDiscoveryAdmission("ws-other")).toBeDefined();
  });

  test("archive() does not close live sessions when archive readiness checks fail", async () => {
    const closeWorkspaceSessions = mock(() => undefined);
    workspaceService.setTerminalService({
      closeWorkspaceSessions,
      setWorkspaceArchiveGuard: () => undefined,
    } as unknown as TerminalService);

    const closeDesktopSession = mock(() => Promise.resolve(undefined));
    workspaceService.setDesktopSessionManager({
      close: closeDesktopSession,
      setWorkspaceArchiveGuard: () => undefined,
    } as unknown as DesktopSessionManager);

    const stopServers = mock(() => Promise.resolve());
    workspaceService.setMCPServerManager({ stopServers } as unknown as MCPServerManager);

    const captureSnapshotForArchive = mock(() => Promise.resolve(Err("should not run")));
    workspaceService.setWorktreeArchiveSnapshotService({
      preflightSnapshotForArchive: mock(() => Promise.resolve(Ok(undefined))),
      captureSnapshotForArchive,
      restoreSnapshotAfterUnarchive: mock(() => Promise.resolve(Ok("skipped" as const))),
      getUnsupportedUntrackedPaths: mock(() => Promise.resolve(Err("snapshot failed"))),
    });

    const result = await workspaceService.archive(workspaceId);

    expect(result).toEqual(Err("snapshot failed"));
    expect(captureSnapshotForArchive).not.toHaveBeenCalled();
    expect(closeWorkspaceSessions).not.toHaveBeenCalled();
    expect(closeDesktopSession).not.toHaveBeenCalled();
    expect(stopServers).not.toHaveBeenCalled();
  });

  test("archive() skips snapshot capture for multi-project workspaces", async () => {
    const captureSnapshotForArchive = mock(() => Promise.resolve(Err("should not run")));
    workspaceService.setWorktreeArchiveSnapshotService({
      preflightSnapshotForArchive: mock(() => Promise.resolve(Ok(undefined))),
      captureSnapshotForArchive,
      restoreSnapshotAfterUnarchive: mock(() => Promise.resolve(Ok("skipped" as const))),
      getUnsupportedUntrackedPaths: mock(() => Promise.resolve(Ok([]))),
    });

    const multiProjectMetadata = {
      ...workspaceMetadata,
      projects: [
        { projectPath, projectName: "proj" },
        { projectPath: "/tmp/project-b", projectName: "proj-b" },
      ],
    } satisfies WorkspaceMetadata;
    const aiService = workspaceService as unknown as { aiService: AIService };
    aiService.aiService.getWorkspaceMetadata = mock(() =>
      Promise.resolve(Ok(multiProjectMetadata))
    );

    const result = await workspaceService.archive(workspaceId);

    expect(result).toEqual(Ok({ kind: "archived" }));
    expect(captureSnapshotForArchive).not.toHaveBeenCalled();
  });

  test("archive() aborts when snapshot capture fails", async () => {
    const captureSnapshotForArchive = mock(() => Promise.resolve(Err("snapshot failed")));
    workspaceService.setWorktreeArchiveSnapshotService({
      preflightSnapshotForArchive: mock(() => Promise.resolve(Ok(undefined))),
      captureSnapshotForArchive,
      restoreSnapshotAfterUnarchive: mock(() => Promise.resolve(Ok("skipped" as const))),
      getUnsupportedUntrackedPaths: mock(() => Promise.resolve(Ok([]))),
    });

    const result = await workspaceService.archive(workspaceId);

    expect(result.success).toBe(false);
    if (!result.success) {
      expect(result.error).toBe("snapshot failed");
    }
    const entry = configState.projects.get(projectPath)?.workspaces[0];
    expect(entry?.archivedAt).toBeUndefined();
    expect(entry?.worktreeArchiveSnapshot).toBeUndefined();
    expect(editConfigSpy).toHaveBeenCalledTimes(0);
  });

  test("unarchive reconciles workflow attention only after snapshot restoration", async () => {
    const snapshot = {
      version: 1 as const,
      capturedAt: "2026-03-30T00:00:00.000Z",
      stateDirPath: "archive-state",
      projects: [
        {
          projectPath,
          projectName: "proj",
          storageKey: "proj",
          branchName: "ws-archive-snapshot",
          trunkBranch: "main",
          baseSha: "base-sha",
          headSha: "head-sha",
        },
      ],
    };
    const order: string[] = [];
    const noteWorkspaceUnarchived = mock((_workspaceId: string) => {
      order.push("reconcile");
      return Promise.resolve();
    });
    workspaceService.setAgentTaskIntegration(
      makeAgentTaskIntegrationFake({ noteWorkspaceUnarchived })
    );
    workspaceService.setWorktreeArchiveSnapshotService({
      preflightSnapshotForArchive: mock(() => Promise.resolve(Ok(undefined))),
      captureSnapshotForArchive: mock(() => Promise.resolve(Ok(snapshot))),
      restoreSnapshotAfterUnarchive: mock(() => {
        order.push("restore");
        return Promise.resolve(Ok("skipped" as const));
      }),
      getUnsupportedUntrackedPaths: mock(() => Promise.resolve(Ok([]))),
    });

    expect((await workspaceService.archive(workspaceId)).success).toBe(true);
    expect((await workspaceService.unarchive(workspaceId)).success).toBe(true);
    // The reconciliation drain can admit a synthetic agent turn, which must never run
    // against a half-restored checkout.
    expect(order).toEqual(["restore", "reconcile"]);
  });

  test("a failed snapshot restoration skips workflow attention reconciliation", async () => {
    const snapshot = {
      version: 1 as const,
      capturedAt: "2026-03-30T00:00:00.000Z",
      stateDirPath: "archive-state",
      projects: [
        {
          projectPath,
          projectName: "proj",
          storageKey: "proj",
          branchName: "ws-archive-snapshot",
          trunkBranch: "main",
          baseSha: "base-sha",
          headSha: "head-sha",
        },
      ],
    };
    const noteWorkspaceUnarchived = mock((_workspaceId: string) => Promise.resolve());
    workspaceService.setAgentTaskIntegration(
      makeAgentTaskIntegrationFake({ noteWorkspaceUnarchived })
    );
    workspaceService.setWorktreeArchiveSnapshotService({
      preflightSnapshotForArchive: mock(() => Promise.resolve(Ok(undefined))),
      captureSnapshotForArchive: mock(() => Promise.resolve(Ok(snapshot))),
      restoreSnapshotAfterUnarchive: mock(() => Promise.resolve(Err("restore failed"))),
      getUnsupportedUntrackedPaths: mock(() => Promise.resolve(Ok([]))),
    });

    expect((await workspaceService.archive(workspaceId)).success).toBe(true);
    const result = await workspaceService.unarchive(workspaceId);
    expect(result.success).toBe(false);
    // The failed restoration rolled the unarchive back; reconciling would admit a synthetic
    // turn into a workspace that is still archived.
    expect(noteWorkspaceUnarchived).not.toHaveBeenCalled();
  });
});

describe("WorkspaceService preflightArchive and acknowledged archive", () => {
  const workspaceId = "ws-preflight-archive";
  const projectPath = "/tmp/project-preflight";
  const workspacePath = "/tmp/project-preflight/ws-preflight-archive";

  let historyService: HistoryService;
  let cleanupHistory: () => Promise<void>;
  let workspaceService: WorkspaceService;

  const workspaceMetadata: WorkspaceMetadata = {
    id: workspaceId,
    name: "ws-preflight-archive",
    projectName: "proj",
    projectPath,
    runtimeConfig: { type: "worktree", srcBaseDir: "/tmp/src" },
  };

  beforeEach(async () => {
    ({ historyService, cleanup: cleanupHistory } = await createTestHistoryService());

    const configState: ProjectsConfig = {
      projects: new Map([
        [
          projectPath,
          {
            workspaces: [
              {
                path: workspacePath,
                id: workspaceId,
                name: "ws-preflight-archive",
                runtimeConfig: { type: "worktree", srcBaseDir: "/tmp/src" },
              },
            ],
          },
        ],
      ]),
      worktreeArchiveBehavior: "snapshot",
    };

    const mockConfig: MockWorkspaceConfig = {
      srcDir: "/tmp/src",
      sessionsDir: "/tmp/test/sessions",
      generateStableId: mock(() => "test-id"),
      findWorkspace: mock((id: string) => {
        if (id !== workspaceId) return null;
        return { projectPath, workspacePath };
      }),
      editConfig: mock((fn: (config: ProjectsConfig) => ProjectsConfig) => {
        fn(configState);
        return Promise.resolve();
      }),
      getAllWorkspaceMetadata: mock(() => Promise.resolve([])),
      loadConfigOrDefault: mock(() => configState),
    };
    const aiService: AIService = {
      ...createStreamLifecycleMocks(),
      isStreaming: mock(() => false),
      getWorkspaceMetadata: mock(() => Promise.resolve(Ok(workspaceMetadata))),
      on: mock(() => undefined),
      off: mock(() => undefined),
    } as unknown as AIService;

    workspaceService = createWorkspaceServiceForTest({
      config: mockConfig,
      historyService,
      aiService,
      initStateManager: mockInitStateManager as InitStateManager,
    });
  });

  afterEach(async () => {
    await cleanupHistory();
  });

  test("preflightArchive returns ready for scratch workspaces under snapshot behavior", async () => {
    // Scratch chats run on the plain local runtime, so the worktree snapshot
    // preflight must short-circuit instead of consulting the snapshot service
    // (whose non-worktree path would reject and block archiving).
    const scratchMetadata: WorkspaceMetadata = {
      kind: "scratch",
      id: workspaceId,
      name: "ws-preflight-archive",
      projectName: "Scratch",
      projectPath: "/tmp/mux/scratch/ws-preflight-archive",
      runtimeConfig: { type: "local" },
    };
    (workspaceService as unknown as { aiService: AIService }).aiService.getWorkspaceMetadata = mock(
      () => Promise.resolve(Ok(scratchMetadata))
    );
    const getUnsupportedUntrackedPaths = mock(() =>
      Promise.resolve(Err("Archive snapshots are only supported for worktree runtimes"))
    );
    workspaceService.setWorktreeArchiveSnapshotService({
      preflightSnapshotForArchive: mock(() => Promise.resolve(Ok(undefined))),
      captureSnapshotForArchive: mock(() => Promise.resolve(Err("unused"))),
      restoreSnapshotAfterUnarchive: mock(() => Promise.resolve(Ok("skipped" as const))),
      getUnsupportedUntrackedPaths,
    });

    const result = await workspaceService.preflightArchive(workspaceId);

    expect(result).toEqual(Ok({ kind: "ready" }));
    expect(getUnsupportedUntrackedPaths).not.toHaveBeenCalled();
  });

  test("preflightArchive returns ready when no untracked files", async () => {
    workspaceService.setWorktreeArchiveSnapshotService({
      preflightSnapshotForArchive: mock(() => Promise.resolve(Ok(undefined))),
      captureSnapshotForArchive: mock(() => Promise.resolve(Err("unused"))),
      restoreSnapshotAfterUnarchive: mock(() => Promise.resolve(Ok("skipped" as const))),
      getUnsupportedUntrackedPaths: mock(() => Promise.resolve(Ok([]))),
    });

    const result = await workspaceService.preflightArchive(workspaceId);

    expect(result.success).toBe(true);
    if (result.success) {
      expect(result.data).toEqual({ kind: "ready" });
    }
  });

  test("preflightArchive returns confirm-lossy-untracked-files with paths", async () => {
    const untrackedPaths = [".ruff_cache/", "tmp/scratch.txt"];
    workspaceService.setWorktreeArchiveSnapshotService({
      preflightSnapshotForArchive: mock(() => Promise.resolve(Ok(undefined))),
      captureSnapshotForArchive: mock(() => Promise.resolve(Err("unused"))),
      restoreSnapshotAfterUnarchive: mock(() => Promise.resolve(Ok("skipped" as const))),
      getUnsupportedUntrackedPaths: mock(() => Promise.resolve(Ok(untrackedPaths))),
    });

    const result = await workspaceService.preflightArchive(workspaceId);

    expect(result.success).toBe(true);
    if (result.success) {
      expect(result.data).toEqual({
        kind: "confirm-lossy-untracked-files",
        paths: untrackedPaths,
      });
    }
  });

  test("preflightArchive returns error when getUnsupportedUntrackedPaths fails", async () => {
    workspaceService.setWorktreeArchiveSnapshotService({
      preflightSnapshotForArchive: mock(() => Promise.resolve(Ok(undefined))),
      captureSnapshotForArchive: mock(() => Promise.resolve(Err("unused"))),
      restoreSnapshotAfterUnarchive: mock(() => Promise.resolve(Ok("skipped" as const))),
      getUnsupportedUntrackedPaths: mock(() =>
        Promise.resolve(Err("Failed to check: dirty submodule"))
      ),
    });

    const result = await workspaceService.preflightArchive(workspaceId);

    expect(result.success).toBe(false);
    if (!result.success) {
      expect(result.error).toContain("dirty submodule");
    }
  });

  test("archive with matching acknowledgedUntrackedPaths succeeds", async () => {
    const untrackedPaths = [".cache/", "temp.txt"];
    const snapshot: WorktreeArchiveSnapshot = {
      version: 1,
      capturedAt: new Date().toISOString(),
      stateDirPath: "archive-state",
      projects: [
        {
          projectPath,
          projectName: "proj",
          storageKey: "proj",
          branchName: "ws-preflight-archive",
          headSha: "abc123",
          baseSha: "def456",
          trunkBranch: "main",
        },
      ],
    };
    const captureSnapshotForArchive = mock(() => Promise.resolve(Ok(snapshot)));
    workspaceService.setWorktreeArchiveSnapshotService({
      preflightSnapshotForArchive: mock(() => Promise.resolve(Ok(undefined))),
      captureSnapshotForArchive,
      restoreSnapshotAfterUnarchive: mock(() => Promise.resolve(Ok("skipped" as const))),
      getUnsupportedUntrackedPaths: mock(() => Promise.resolve(Ok(untrackedPaths))),
    });

    const result = await workspaceService.archive(workspaceId, untrackedPaths);

    expect(result).toEqual(Ok({ kind: "archived" }));
    // The capture should have been called with acknowledgedUntrackedPaths.
    expect(captureSnapshotForArchive).toHaveBeenCalledWith({
      workspaceId,
      workspaceMetadata,
      acknowledgedUntrackedPaths: untrackedPaths,
    });
  });

  test("archive returns refreshed confirmation when capture detects new untracked files", async () => {
    const captureSnapshotForArchive = mock(() =>
      Promise.resolve(
        Err({
          kind: "confirm-lossy-untracked-files" as const,
          paths: [".cache/", "new-file.txt"],
        })
      )
    );
    workspaceService.setWorktreeArchiveSnapshotService({
      preflightSnapshotForArchive: mock(() => Promise.resolve(Ok(undefined))),
      captureSnapshotForArchive,
      restoreSnapshotAfterUnarchive: mock(() => Promise.resolve(Ok("skipped" as const))),
      getUnsupportedUntrackedPaths: mock(() => Promise.resolve(Ok([".cache/", "temp.txt"]))),
    });

    const result = await workspaceService.archive(workspaceId, [".cache/", "temp.txt"]);

    expect(result).toEqual(
      Ok({
        kind: "confirm-lossy-untracked-files",
        paths: [".cache/", "new-file.txt"],
      })
    );
    expect(captureSnapshotForArchive).toHaveBeenCalledWith({
      workspaceId,
      workspaceMetadata,
      acknowledgedUntrackedPaths: [".cache/", "temp.txt"],
    });
  });

  test("archive returns refreshed confirmation when acknowledged paths drift before capture", async () => {
    const captureSnapshotForArchive = mock(() => Promise.resolve(Err("should not run")));
    workspaceService.setWorktreeArchiveSnapshotService({
      preflightSnapshotForArchive: mock(() => Promise.resolve(Ok(undefined))),
      captureSnapshotForArchive,
      restoreSnapshotAfterUnarchive: mock(() => Promise.resolve(Ok("skipped" as const))),
      getUnsupportedUntrackedPaths: mock(() =>
        Promise.resolve(Ok([".cache/", "new-file.txt", "temp.txt"]))
      ),
    });

    const result = await workspaceService.archive(workspaceId, [".cache/", "temp.txt"]);

    expect(result).toEqual(
      Ok({
        kind: "confirm-lossy-untracked-files",
        paths: [".cache/", "new-file.txt", "temp.txt"],
      })
    );
    expect(captureSnapshotForArchive).not.toHaveBeenCalled();
  });

  test("archive without acknowledgedUntrackedPaths returns confirmation for untracked files", async () => {
    const captureSnapshotForArchive = mock(() => Promise.resolve(Err("should not run")));
    workspaceService.setWorktreeArchiveSnapshotService({
      preflightSnapshotForArchive: mock(() => Promise.resolve(Ok(undefined))),
      captureSnapshotForArchive,
      restoreSnapshotAfterUnarchive: mock(() => Promise.resolve(Ok("skipped" as const))),
      getUnsupportedUntrackedPaths: mock(() => Promise.resolve(Ok([".cache/"]))),
    });

    const result = await workspaceService.archive(workspaceId);

    expect(result).toEqual(Ok({ kind: "confirm-lossy-untracked-files", paths: [".cache/"] }));
    expect(captureSnapshotForArchive).not.toHaveBeenCalled();
  });
});

describe("WorkspaceService unarchive snapshot restore", () => {
  const workspaceId = "ws-unarchive-snapshot";
  const projectPath = "/tmp/project";
  const workspacePath = "/tmp/project/ws-unarchive-snapshot";

  let historyService: HistoryService;
  let cleanupHistory: () => Promise<void>;
  let workspaceService: WorkspaceService;

  const workspaceMetadata: FrontendWorkspaceMetadata = {
    id: workspaceId,
    name: "ws-unarchive-snapshot",
    projectName: "proj",
    projectPath,
    runtimeConfig: { type: "worktree", srcBaseDir: "/tmp/src" },
    archivedAt: "2020-01-01T00:00:00.000Z",
    namedWorkspacePath: workspacePath,
  };

  beforeEach(async () => {
    ({ historyService, cleanup: cleanupHistory } = await createTestHistoryService());

    let configState: ProjectsConfig = {
      projects: new Map([
        [
          projectPath,
          {
            workspaces: [
              {
                path: workspacePath,
                id: workspaceId,
                name: "ws-unarchive-snapshot",
                archivedAt: "2020-01-01T00:00:00.000Z",
                runtimeConfig: { type: "worktree", srcBaseDir: "/tmp/src" },
                worktreeArchiveSnapshot: {
                  version: 1,
                  capturedAt: "2026-03-30T00:00:00.000Z",
                  stateDirPath: "archive-state",
                  projects: [
                    {
                      projectPath,
                      projectName: "proj",
                      storageKey: "proj",
                      branchName: "ws-unarchive-snapshot",
                      trunkBranch: "main",
                      baseSha: "base-sha",
                      headSha: "head-sha",
                    },
                  ],
                },
              },
            ],
          },
        ],
      ]),
    };

    const mockConfig: MockWorkspaceConfig = {
      srcDir: "/tmp/src",
      sessionsDir: "/tmp/test/sessions",
      generateStableId: mock(() => "test-id"),
      findWorkspace: mock((id: string) => {
        if (id !== workspaceId) {
          return null;
        }

        return { projectPath, workspacePath };
      }),
      editConfig: mock((fn: (config: ProjectsConfig) => ProjectsConfig) => {
        configState = fn(configState);
        return Promise.resolve();
      }),
      getAllWorkspaceMetadata: mock(() => Promise.resolve([workspaceMetadata])),
      loadConfigOrDefault: mock(() => configState),
    };
    const aiService: AIService = {
      ...createStreamLifecycleMocks(),
      isStreaming: mock(() => false),
      getWorkspaceMetadata: mock(() => Promise.resolve(Ok(workspaceMetadata))),
      on: mock(() => undefined),
      off: mock(() => undefined),
    } as unknown as AIService;

    workspaceService = createWorkspaceServiceForTest({
      config: mockConfig,
      historyService,
      aiService,
      initStateManager: mockInitStateManager as InitStateManager,
    });
  });

  afterEach(async () => {
    await cleanupHistory();
  });

  test("unarchive() returns Err when snapshot restore fails", async () => {
    const restoreSnapshotAfterUnarchive = mock(() => Promise.resolve(Err("restore failed")));
    workspaceService.setWorktreeArchiveSnapshotService({
      preflightSnapshotForArchive: mock(() => Promise.resolve(Ok(undefined))),
      captureSnapshotForArchive: mock(() => Promise.resolve(Err("unused"))),
      restoreSnapshotAfterUnarchive,
      getUnsupportedUntrackedPaths: mock(() => Promise.resolve(Ok([]))),
    });

    const result = await workspaceService.unarchive(workspaceId);

    expect(result).toEqual(Err("restore failed"));
  });

  test("unarchive() rolls back legacy path-only entries when snapshot restore fails", async () => {
    const restoreSnapshotAfterUnarchive = mock(() => Promise.resolve(Err("restore failed")));
    workspaceService.setWorktreeArchiveSnapshotService({
      preflightSnapshotForArchive: mock(() => Promise.resolve(Ok(undefined))),
      captureSnapshotForArchive: mock(() => Promise.resolve(Err("unused"))),
      restoreSnapshotAfterUnarchive,
      getUnsupportedUntrackedPaths: mock(() => Promise.resolve(Ok([]))),
    });

    const config = workspaceService as unknown as { config: Config };
    await config.config.editConfig((currentConfig) => {
      const workspaceEntry = currentConfig.projects.get(projectPath)?.workspaces[0];
      if (!workspaceEntry) {
        throw new Error("Missing workspace entry");
      }
      delete workspaceEntry.id;
      return currentConfig;
    });

    const result = await workspaceService.unarchive(workspaceId);

    expect(result).toEqual(Err("restore failed"));
  });

  test("unarchive() invokes snapshot restore when snapshot metadata is present", async () => {
    const restoreSnapshotAfterUnarchive = mock(() => Promise.resolve(Ok("restored" as const)));
    workspaceService.setWorktreeArchiveSnapshotService({
      preflightSnapshotForArchive: mock(() => Promise.resolve(Ok(undefined))),
      captureSnapshotForArchive: mock(() => Promise.resolve(Err("unused"))),
      restoreSnapshotAfterUnarchive,
      getUnsupportedUntrackedPaths: mock(() => Promise.resolve(Ok([]))),
    });

    const result = await workspaceService.unarchive(workspaceId);

    expect(result).toEqual(Ok(undefined));
    expect(restoreSnapshotAfterUnarchive).toHaveBeenCalledWith({
      workspaceId,
      workspaceMetadata,
    });
  });
});

describe("WorkspaceService deleteWorktree", () => {
  const workspaceId = "ws-delete-worktree";
  const projectName = "proj";
  const projectPath = "/tmp/project";
  const workspaceName = "ws-delete-worktree";

  let historyService: HistoryService;
  let cleanupHistory: () => Promise<void>;
  let tempSrcBaseDir: string;

  beforeEach(async () => {
    ({ historyService, cleanup: cleanupHistory } = await createTestHistoryService());
    tempSrcBaseDir = await fsPromises.mkdtemp(path.join(tmpdir(), "mux-delete-worktree-"));
  });

  afterEach(async () => {
    mock.restore();
    await cleanupHistory();
    await fsPromises.rm(tempSrcBaseDir, { recursive: true, force: true });
  });

  function createHarness(options?: {
    archivedAt?: string;
    runtimeConfig?: FrontendWorkspaceMetadata["runtimeConfig"];
    taskIsolation?: FrontendWorkspaceMetadata["taskIsolation"];
  }): {
    workspaceService: WorkspaceService;
    metadataEvents: Array<FrontendWorkspaceMetadata | null>;
    managedPath: string;
  } {
    const runtimeConfig = options?.runtimeConfig ?? {
      type: "worktree",
      srcBaseDir: tempSrcBaseDir,
    };
    const managedPath = path.join(tempSrcBaseDir, "_workspaces", workspaceName);

    const getCurrentMetadata = async (): Promise<FrontendWorkspaceMetadata> => {
      const transcriptOnly = await fsPromises
        .access(managedPath)
        .then(() => false)
        .catch(() => true);

      return {
        id: workspaceId,
        name: workspaceName,
        projectName,
        projectPath,
        runtimeConfig,
        archivedAt: options?.archivedAt,
        taskIsolation: options?.taskIsolation,
        transcriptOnly,
        namedWorkspacePath: managedPath,
      };
    };

    const mockConfig: MockWorkspaceConfig = {
      srcDir: tempSrcBaseDir,
      sessionsDir: "/tmp/test/sessions",
      generateStableId: mock(() => "test-id"),
      getAllWorkspaceMetadata: mock(async () => [await getCurrentMetadata()]),
    };

    const aiService = {
      ...createStreamLifecycleMocks(),
      on: mock(() => undefined),
      off: mock(() => undefined),
    } as unknown as AIService;

    const workspaceService = createWorkspaceServiceForTest({
      config: mockConfig,
      historyService,
      aiService,
      initStateManager: mockInitStateManager as InitStateManager,
    });

    const metadataEvents: Array<FrontendWorkspaceMetadata | null> = [];
    workspaceService.on("metadata", (event: unknown) => {
      if (!event || typeof event !== "object") {
        return;
      }
      const parsed = event as { workspaceId: string; metadata: FrontendWorkspaceMetadata | null };
      if (parsed.workspaceId === workspaceId) {
        metadataEvents.push(parsed.metadata);
      }
    });

    return { workspaceService, metadataEvents, managedPath };
  }

  test("deletes an archived managed worktree and emits transcript-only metadata", async () => {
    const { workspaceService, metadataEvents, managedPath } = createHarness({
      archivedAt: "2026-03-01T00:00:00.000Z",
    });
    await fsPromises.mkdir(managedPath, { recursive: true });
    const removeManagedGitWorktreeSpy = spyOn(
      removeManagedGitWorktreeModule,
      "removeManagedGitWorktree"
    ).mockImplementation(async (_projectPath, worktreePath) => {
      await fsPromises.rm(worktreePath, { recursive: true, force: true });
    });

    const result = await workspaceService.deleteWorktree(workspaceId);

    expect(result).toEqual(Ok(undefined));
    expect(removeManagedGitWorktreeSpy).toHaveBeenCalledWith(projectPath, managedPath);
    expect(
      await fsPromises
        .access(managedPath)
        .then(() => true)
        .catch(() => false)
    ).toBe(false);
    expect(metadataEvents.at(-1)?.transcriptOnly).toBe(true);
  });

  test("returns success when the managed worktree is already missing", async () => {
    const { workspaceService, metadataEvents, managedPath } = createHarness({
      archivedAt: "2026-03-01T00:00:00.000Z",
    });
    const removeManagedGitWorktreeSpy = spyOn(
      removeManagedGitWorktreeModule,
      "removeManagedGitWorktree"
    ).mockResolvedValue(undefined);

    const result = await workspaceService.deleteWorktree(workspaceId);

    expect(result).toEqual(Ok(undefined));
    expect(removeManagedGitWorktreeSpy).toHaveBeenCalledWith(projectPath, managedPath);
    expect(metadataEvents.at(-1)?.transcriptOnly).toBe(true);
  });

  test("rejects deleting a worktree for a non-archived workspace", async () => {
    const { workspaceService, managedPath } = createHarness({
      archivedAt: undefined,
    });
    await fsPromises.mkdir(managedPath, { recursive: true });

    const result = await workspaceService.deleteWorktree(workspaceId);

    expect(result.success).toBe(false);
    if (!result.success) {
      expect(result.error).toBe("Only archived workspaces can delete their managed worktree");
    }
    expect(
      await fsPromises
        .access(managedPath)
        .then(() => true)
        .catch(() => false)
    ).toBe(true);
  });

  test("rejects deleting the shared checkout for an isolation-none sub-agent", async () => {
    const { workspaceService, managedPath } = createHarness({
      archivedAt: "2026-03-01T00:00:00.000Z",
      taskIsolation: "none",
    });
    await fsPromises.mkdir(managedPath, { recursive: true });
    const removeManagedGitWorktreeSpy = spyOn(
      removeManagedGitWorktreeModule,
      "removeManagedGitWorktree"
    );

    const result = await workspaceService.deleteWorktree(workspaceId);

    expect(result).toEqual(Err("Shared-checkout sub-agents do not own a managed worktree"));
    expect(removeManagedGitWorktreeSpy).not.toHaveBeenCalled();
  });

  test("rejects deleting a worktree for non-worktree runtimes", async () => {
    const { workspaceService } = createHarness({
      archivedAt: "2026-03-01T00:00:00.000Z",
      runtimeConfig: { type: "local" },
    });

    const result = await workspaceService.deleteWorktree(workspaceId);

    expect(result.success).toBe(false);
    if (!result.success) {
      expect(result.error).toBe(
        "Deleting a managed worktree is only supported for worktree runtimes"
      );
    }
  });
});

describe("WorkspaceService archiveMergedInProject", () => {
  const TARGET_PROJECT_PATH = "/tmp/project";

  let historyService: HistoryService;
  let cleanupHistory: () => Promise<void>;

  beforeEach(async () => {
    ({ historyService, cleanup: cleanupHistory } = await createTestHistoryService());
  });

  afterEach(async () => {
    await cleanupHistory();
  });

  function createMetadata(
    id: string,
    options?: { projectPath?: string; archivedAt?: string; unarchivedAt?: string }
  ): FrontendWorkspaceMetadata {
    const projectPath = options?.projectPath ?? TARGET_PROJECT_PATH;

    return {
      id,
      name: id,
      projectName: "test-project",
      projectPath,
      runtimeConfig: { type: "local" },
      namedWorkspacePath: path.join(projectPath, id),
      archivedAt: options?.archivedAt,
      unarchivedAt: options?.unarchivedAt,
    };
  }

  function bashOk(output: string): Result<BashToolResult> {
    return {
      success: true,
      data: {
        success: true,
        output,
        exitCode: 0,
        wall_duration_ms: 0,
      },
    };
  }

  function bashToolFailure(error: string): Result<BashToolResult> {
    return {
      success: true,
      data: {
        success: false,
        error,
        exitCode: 1,
        wall_duration_ms: 0,
      },
    };
  }

  function executeBashFailure(error: string): Result<BashToolResult> {
    return { success: false, error };
  }

  type ExecuteBashFn = (
    workspaceId: string,
    script: string,
    options?: {
      timeout_secs?: number;
    }
  ) => Promise<Result<BashToolResult>>;

  type ArchiveFn = (workspaceId: string) => Promise<Result<{ kind: "archived" }>>;

  function archiveSuccess(): Promise<Result<{ kind: "archived" }>> {
    return Promise.resolve(Ok({ kind: "archived" }));
  }

  function createServiceHarness(
    allMetadata: FrontendWorkspaceMetadata[],
    executeBashImpl: ExecuteBashFn,
    archiveImpl: ArchiveFn
  ): {
    workspaceService: WorkspaceService;
    executeBashMock: ReturnType<typeof mock>;
    archiveMock: ReturnType<typeof mock>;
  } {
    const mockConfig: MockWorkspaceConfig = {
      srcDir: "/tmp/test",
      sessionsDir: "/tmp/test/sessions",
      generateStableId: mock(() => "test-id"),
      findWorkspace: mock(() => null),
      getAllWorkspaceMetadata: mock(() => Promise.resolve(allMetadata)),
    };

    const aiService: AIService = {
      ...createStreamLifecycleMocks(),
      on(_eventName: string | symbol, _listener: (...args: unknown[]) => void) {
        return this;
      },
      off(_eventName: string | symbol, _listener: (...args: unknown[]) => void) {
        return this;
      },
    } as unknown as AIService;
    const workspaceService = createWorkspaceServiceForTest({
      config: mockConfig,
      historyService,
      aiService,
      initStateManager: mockInitStateManager as InitStateManager,
    });

    const executeBashMock = mock(executeBashImpl);
    const archiveMock = mock(archiveImpl);

    interface WorkspaceServiceTestAccess {
      executeBash: typeof executeBashMock;
      archive: typeof archiveMock;
    }

    const svc = workspaceService as unknown as WorkspaceServiceTestAccess;
    svc.executeBash = executeBashMock;
    svc.archive = archiveMock;

    return { workspaceService, executeBashMock, archiveMock };
  }

  test("treats workspaces with later unarchivedAt as eligible", async () => {
    const allMetadata: FrontendWorkspaceMetadata[] = [
      createMetadata("ws-merged-unarchived", {
        archivedAt: "2025-01-01T00:00:00.000Z",
        unarchivedAt: "2025-02-01T00:00:00.000Z",
      }),
      createMetadata("ws-still-archived", {
        archivedAt: "2025-03-01T00:00:00.000Z",
        unarchivedAt: "2025-02-01T00:00:00.000Z",
      }),
    ];

    const ghResultsByWorkspaceId: Record<string, Result<BashToolResult>> = {
      "ws-merged-unarchived": bashOk('{"state":"MERGED"}'),
    };

    const { workspaceService, executeBashMock, archiveMock } = createServiceHarness(
      allMetadata,
      (workspaceId) => {
        const result = ghResultsByWorkspaceId[workspaceId];
        if (!result) {
          throw new Error(`Unexpected executeBash call for workspaceId: ${workspaceId}`);
        }
        return Promise.resolve(result);
      },
      () => archiveSuccess()
    );

    const result = await workspaceService.archiveMergedInProject(TARGET_PROJECT_PATH);

    expect(result.success).toBe(true);
    if (!result.success) {
      return;
    }

    expect(result.data.archivedWorkspaceIds).toEqual(["ws-merged-unarchived"]);
    expect(result.data.skippedWorkspaceIds).toEqual([]);
    expect(result.data.errors).toEqual([]);

    expect(archiveMock).toHaveBeenCalledTimes(1);
    expect(archiveMock).toHaveBeenCalledWith("ws-merged-unarchived");

    // Should only query GitHub for the workspace that is considered unarchived.
    expect(executeBashMock).toHaveBeenCalledTimes(1);
  });
  test("archives only MERGED workspaces", async () => {
    const allMetadata: FrontendWorkspaceMetadata[] = [
      createMetadata("ws-open"),
      createMetadata("ws-merged"),
      createMetadata("ws-no-pr"),
      createMetadata("ws-other-project", { projectPath: "/tmp/other" }),
      createMetadata("ws-already-archived", { archivedAt: "2025-01-01T00:00:00.000Z" }),
    ];

    const ghResultsByWorkspaceId: Record<string, Result<BashToolResult>> = {
      "ws-open": bashOk('{"state":"OPEN"}'),
      "ws-merged": bashOk('{"state":"MERGED"}'),
      "ws-no-pr": bashOk('{"no_pr":true}'),
    };

    const { workspaceService, executeBashMock, archiveMock } = createServiceHarness(
      allMetadata,
      (workspaceId, script, options) => {
        expect(script).toContain("gh pr view --json state");
        expect(options?.timeout_secs).toBe(15);

        const result = ghResultsByWorkspaceId[workspaceId];
        if (!result) {
          throw new Error(`Unexpected executeBash call for workspaceId: ${workspaceId}`);
        }
        return Promise.resolve(result);
      },
      () => archiveSuccess()
    );

    const result = await workspaceService.archiveMergedInProject(TARGET_PROJECT_PATH);

    expect(result.success).toBe(true);
    if (!result.success) {
      return;
    }

    expect(result.data.archivedWorkspaceIds).toEqual(["ws-merged"]);
    expect(result.data.skippedWorkspaceIds).toEqual(["ws-no-pr", "ws-open"]);
    expect(result.data.errors).toEqual([]);

    expect(archiveMock).toHaveBeenCalledTimes(1);
    expect(archiveMock).toHaveBeenCalledWith("ws-merged");

    expect(executeBashMock).toHaveBeenCalledTimes(3);
  });

  test("skips no_pr and non-merged states", async () => {
    const allMetadata: FrontendWorkspaceMetadata[] = [
      createMetadata("ws-open"),
      createMetadata("ws-closed"),
      createMetadata("ws-no-pr"),
    ];

    const ghResultsByWorkspaceId: Record<string, Result<BashToolResult>> = {
      "ws-open": bashOk('{"state":"OPEN"}'),
      "ws-closed": bashOk('{"state":"CLOSED"}'),
      "ws-no-pr": bashOk('{"no_pr":true}'),
    };

    const { workspaceService, archiveMock } = createServiceHarness(
      allMetadata,
      (workspaceId) => {
        const result = ghResultsByWorkspaceId[workspaceId];
        if (!result) {
          throw new Error(`Unexpected executeBash call for workspaceId: ${workspaceId}`);
        }
        return Promise.resolve(result);
      },
      () => archiveSuccess()
    );

    const result = await workspaceService.archiveMergedInProject(TARGET_PROJECT_PATH);

    expect(result.success).toBe(true);
    if (!result.success) {
      return;
    }

    expect(result.data.archivedWorkspaceIds).toEqual([]);
    expect(result.data.skippedWorkspaceIds).toEqual(["ws-closed", "ws-no-pr", "ws-open"]);
    expect(result.data.errors).toEqual([]);

    expect(archiveMock).toHaveBeenCalledTimes(0);
  });

  test("records errors for malformed JSON and executeBash failures", async () => {
    const allMetadata: FrontendWorkspaceMetadata[] = [
      createMetadata("ws-bad-json"),
      createMetadata("ws-exec-failed"),
      createMetadata("ws-bash-failed"),
    ];

    const ghResultsByWorkspaceId: Record<string, Result<BashToolResult>> = {
      "ws-bad-json": bashOk("not-json"),
      "ws-exec-failed": executeBashFailure("executeBash failed"),
      "ws-bash-failed": bashToolFailure("gh failed"),
    };

    const { workspaceService, archiveMock } = createServiceHarness(
      allMetadata,
      (workspaceId) => {
        const result = ghResultsByWorkspaceId[workspaceId];
        if (!result) {
          throw new Error(`Unexpected executeBash call for workspaceId: ${workspaceId}`);
        }
        return Promise.resolve(result);
      },
      () => archiveSuccess()
    );

    const result = await workspaceService.archiveMergedInProject(TARGET_PROJECT_PATH);

    expect(result.success).toBe(true);
    if (!result.success) {
      return;
    }

    expect(result.data.archivedWorkspaceIds).toEqual([]);
    expect(result.data.skippedWorkspaceIds).toEqual([]);
    expect(result.data.errors).toHaveLength(3);

    const badJsonError = result.data.errors.find((e) => e.workspaceId === "ws-bad-json");
    expect(badJsonError).toBeDefined();
    expect(badJsonError?.error).toContain("Failed to parse gh output");

    const execFailedError = result.data.errors.find((e) => e.workspaceId === "ws-exec-failed");
    expect(execFailedError).toBeDefined();
    expect(execFailedError?.error).toBe("executeBash failed");

    const bashFailedError = result.data.errors.find((e) => e.workspaceId === "ws-bash-failed");
    expect(bashFailedError).toBeDefined();
    expect(bashFailedError?.error).toBe("gh failed");

    expect(archiveMock).toHaveBeenCalledTimes(0);
  });
});

describe("WorkspaceService init cancellation", () => {
  let historyService: HistoryService;
  let cleanupHistory: () => Promise<void>;

  beforeEach(async () => {
    ({ historyService, cleanup: cleanupHistory } = await createTestHistoryService());
  });

  afterEach(async () => {
    await cleanupHistory();
  });

  test("scratch workspace deletion preserves shared workdirs until the last reference", async () => {
    const {
      config,
      historyService: scratchHistoryService,
      cleanup,
    } = await createTestHistoryService();
    const parentId = "1111111111";
    const childId = "2222222222";
    const configWithStableId = config as unknown as { generateStableId: () => string };
    configWithStableId.generateStableId = () => parentId;

    const aiService = {
      ...createStreamLifecycleMocks(),
      isStreaming: mock(() => false),
      stopStream: mock(() => Promise.resolve(Ok(undefined))),
      getWorkspaceMetadata: mock(async (workspaceId: string) => {
        const metadata = (await config.getAllWorkspaceMetadata()).find(
          (workspace) => workspace.id === workspaceId
        );
        return metadata ? Ok(metadata) : Err("not found");
      }),
      on: mock(() => undefined),
      off: mock(() => undefined),
    } as unknown as AIService;

    try {
      const workspaceService = createWorkspaceServiceForTest({
        config,
        historyService: scratchHistoryService,
        aiService,
      });
      const created = await workspaceService.createScratch("Scratch test");
      expect(created.success).toBe(true);
      if (!created.success) return;

      const scratchPath = created.data.metadata.namedWorkspacePath;
      await config.editConfig((current) => {
        const scratchProject = current.projects.get(SCRATCH_PROJECT_CONFIG_KEY);
        if (!scratchProject) throw new Error("Scratch project missing");
        scratchProject.workspaces.push({
          kind: "scratch",
          path: scratchPath,
          id: childId,
          name: `agent-explore-${childId}`,
          parentWorkspaceId: parentId,
          taskIsolation: "none",
          taskStatus: "reported",
          createdAt: new Date().toISOString(),
          runtimeConfig: { type: "local" },
        });
        return current;
      });

      expect(await fsPromises.stat(scratchPath).then(() => true)).toBe(true);
      expect(await workspaceService.remove(parentId, true)).toEqual(Ok(undefined));
      expect(await fsPromises.stat(scratchPath).then(() => true)).toBe(true);
      expect(await workspaceService.remove(childId, true)).toEqual(Ok(undefined));
      expect(
        await fsPromises
          .stat(scratchPath)
          .then(() => true)
          .catch(() => false)
      ).toBe(false);
    } finally {
      await cleanup();
    }
  });

  test("scratch removal refuses to delete a workdir the workspace does not own", async () => {
    // A stale or hand-edited config entry can point at another chat's dir
    // under the scratch root; removal must not recursively delete it.
    const {
      config,
      historyService: scratchHistoryService,
      cleanup,
    } = await createTestHistoryService();
    const victimId = "3333333333";
    const malformedId = "4444444444";
    const configWithStableId = config as unknown as { generateStableId: () => string };
    configWithStableId.generateStableId = () => victimId;

    const aiService = {
      ...createStreamLifecycleMocks(),
      isStreaming: mock(() => false),
      stopStream: mock(() => Promise.resolve(Ok(undefined))),
      getWorkspaceMetadata: mock(async (workspaceId: string) => {
        const metadata = (await config.getAllWorkspaceMetadata()).find(
          (workspace) => workspace.id === workspaceId
        );
        return metadata ? Ok(metadata) : Err("not found");
      }),
      on: mock(() => undefined),
      off: mock(() => undefined),
    } as unknown as AIService;

    try {
      const workspaceService = createWorkspaceServiceForTest({
        config,
        historyService: scratchHistoryService,
        aiService,
      });
      const created = await workspaceService.createScratch("Victim scratch");
      expect(created.success).toBe(true);
      if (!created.success) return;
      const victimPath = created.data.metadata.namedWorkspacePath;

      // Remove the victim's config entry (keep the dir) so the malformed
      // entry is the workdir's only reference; then point the malformed
      // root entry (no task ancestry) at the victim's dir.
      await config.editConfig((current) => {
        const scratchProject = current.projects.get(SCRATCH_PROJECT_CONFIG_KEY);
        if (!scratchProject) throw new Error("Scratch project missing");
        scratchProject.workspaces = scratchProject.workspaces.filter(
          (workspace) => workspace.id !== victimId
        );
        scratchProject.workspaces.push({
          kind: "scratch",
          path: victimPath,
          id: malformedId,
          name: `scratch-${malformedId}`,
          createdAt: new Date().toISOString(),
          runtimeConfig: { type: "local" },
        });
        return current;
      });

      expect(await workspaceService.remove(malformedId, true)).toEqual(Ok(undefined));
      // Config cleanup proceeded, but the victim's dir must survive.
      expect(await fsPromises.stat(victimPath).then(() => true)).toBe(true);
    } finally {
      await cleanup();
    }
  });

  test("createScratch rejects when policy disallows the local runtime", async () => {
    const {
      config,
      historyService: scratchHistoryService,
      cleanup,
    } = await createTestHistoryService();
    const policyService = {
      isEnforced: mock(() => true),
      isRuntimeAllowed: mock(() => false),
    } as unknown as WorkspaceServiceArgs[7];

    try {
      const workspaceService = createWorkspaceServiceForTest({
        config,
        historyService: scratchHistoryService,
        policyService,
      });

      const result = await workspaceService.createScratch("Blocked scratch");

      expect(result.success).toBe(false);
      if (!result.success) {
        expect(result.error).toContain("not allowed by policy");
      }
      // No config entry or workdir may be left behind by the rejected create.
      expect((await config.getAllWorkspaceMetadata()).length).toBe(0);
    } finally {
      await cleanup();
    }
  });

  test("create() rejects untrusted projects", async () => {
    const projectPath = "/tmp/proj";
    const generateStableIdMock = mock(() => "ws-untrusted");

    const mockAIService = {
      ...createStreamLifecycleMocks(),
      isStreaming: mock(() => false),
      // eslint-disable-next-line @typescript-eslint/no-empty-function
      on: mock(() => {}),
      // eslint-disable-next-line @typescript-eslint/no-empty-function
      off: mock(() => {}),
    } as unknown as AIService;

    const mockConfig: MockWorkspaceConfig = {
      rootDir: "/tmp/mux-root",
      srcDir: "/tmp/src",
      sessionsDir: "/tmp/test/sessions",
      generateStableId: generateStableIdMock,
      findWorkspace: mock(() => null),
      loadConfigOrDefault: mock(() => ({
        projects: new Map([
          [
            projectPath,
            {
              workspaces: [],
              trusted: false,
            },
          ],
        ]),
      })),
    };

    const mockInitStateManager: Partial<InitStateManager> = {
      on: mock(() => undefined as unknown as InitStateManager),
      getInitState: mock(() => undefined),
    };

    const workspaceService = createWorkspaceServiceForTest({
      config: mockConfig,
      historyService,
      aiService: mockAIService,
      initStateManager: mockInitStateManager as InitStateManager,
    });

    const result = await workspaceService.create(projectPath, "ws-branch", undefined, "title", {
      type: "local",
    });

    expect(result).toEqual(
      Err(
        "This project must be trusted before creating workspaces. Trust the project in Settings → Security, or create a workspace from the project page."
      )
    );
    expect(generateStableIdMock).not.toHaveBeenCalled();
  });

  test("create() rejects slash branches whose sanitized workspace name already exists", async () => {
    const projectPath = "/tmp/proj";
    const generateStableIdMock = mock(() => "ws-conflict");
    const mockConfig: MockWorkspaceConfig = {
      rootDir: "/tmp/mux-root",
      srcDir: "/tmp/src",
      sessionsDir: "/tmp/test/sessions",
      generateStableId: generateStableIdMock,
      findWorkspace: mock(() => null),
      loadConfigOrDefault: mock(() => ({
        projects: new Map([
          [
            projectPath,
            {
              workspaces: [{ id: "existing", name: "feature-foo", path: "/tmp/proj/feature-foo" }],
              trusted: true,
            },
          ],
        ]),
      })),
    };
    const workspaceService = createWorkspaceServiceForTest({
      config: mockConfig,
      historyService,
    });

    const result = await workspaceService.create(projectPath, "feature/foo", undefined, "title", {
      type: "local",
    });

    expect(result.success).toBe(false);
    if (!result.success) {
      expect(result.error).toContain('Branch "feature/foo"');
      expect(result.error).toContain('workspace name "feature-foo"');
    }
    expect(generateStableIdMock).not.toHaveBeenCalled();
  });

  test("archive() aborts init and still archives when init is running", async () => {
    const workspaceId = "ws-init-running";

    const removeMock = mock(() => Promise.resolve({ success: true as const, data: undefined }));
    const editConfigMock = mock(() => Promise.resolve());
    const clearInMemoryStateMock = mock((_workspaceId: string) => undefined);

    const mockAIService = {
      ...createStreamLifecycleMocks(),
      isStreaming: mock(() => false),
      // eslint-disable-next-line @typescript-eslint/no-empty-function
      on: mock(() => {}),
      // eslint-disable-next-line @typescript-eslint/no-empty-function
      off: mock(() => {}),
    } as unknown as AIService;

    const mockConfig: MockWorkspaceConfig = {
      srcDir: "/tmp/test",
      findWorkspace: mock(() => ({ projectPath: "/tmp/proj", workspacePath: "/tmp/proj/ws" })),
      editConfig: editConfigMock,
      getAllWorkspaceMetadata: mock(() => Promise.resolve([])),
      sessionsDir: "/tmp/test/sessions",
      generateStableId: mock(() => "test-id"),
      loadConfigOrDefault: mock(() => ({ projects: new Map() })),
    };

    const mockInitStateManager: Partial<InitStateManager> = {
      // WorkspaceService subscribes to init-end events on construction.
      on: mock(() => undefined as unknown as InitStateManager),
      getInitState: mock(
        (): InitStatus => ({
          status: "running",
          hookPath: "/tmp/proj",
          startTime: 0,
          lines: [],
          exitCode: null,
          endTime: null,
        })
      ),
      clearInMemoryState: clearInMemoryStateMock,
    };
    const workspaceService = createWorkspaceServiceForTest({
      config: mockConfig,
      historyService,
      aiService: mockAIService,
      initStateManager: mockInitStateManager as InitStateManager,
    });

    // Make it obvious if archive() incorrectly chooses deletion.
    workspaceService.remove = removeMock as unknown as typeof workspaceService.remove;

    const result = await workspaceService.archive(workspaceId);
    expect(result.success).toBe(true);
    expect(editConfigMock).toHaveBeenCalled();
    expect(removeMock).not.toHaveBeenCalled();
    expect(clearInMemoryStateMock).toHaveBeenCalledWith(workspaceId);
  });

  test("archive() uses normal archive flow when init is complete", async () => {
    const workspaceId = "ws-init-complete";

    const removeMock = mock(() => Promise.resolve({ success: true as const, data: undefined }));
    const editConfigMock = mock(() => Promise.resolve());

    const mockAIService = {
      ...createStreamLifecycleMocks(),
      isStreaming: mock(() => false),
      // eslint-disable-next-line @typescript-eslint/no-empty-function
      on: mock(() => {}),
      // eslint-disable-next-line @typescript-eslint/no-empty-function
      off: mock(() => {}),
    } as unknown as AIService;

    const mockConfig: MockWorkspaceConfig = {
      srcDir: "/tmp/test",
      findWorkspace: mock(() => ({ projectPath: "/tmp/proj", workspacePath: "/tmp/proj/ws" })),
      editConfig: editConfigMock,
      getAllWorkspaceMetadata: mock(() => Promise.resolve([])),
      sessionsDir: "/tmp/test/sessions",
      generateStableId: mock(() => "test-id"),
      loadConfigOrDefault: mock(() => ({ projects: new Map() })),
    };

    const mockInitStateManager: Partial<InitStateManager> = {
      // WorkspaceService subscribes to init-end events on construction.
      on: mock(() => undefined as unknown as InitStateManager),
      getInitState: mock(
        (): InitStatus => ({
          status: "success",
          hookPath: "/tmp/proj",
          startTime: 0,
          lines: [],
          exitCode: 0,
          endTime: 1,
        })
      ),
      clearInMemoryState: mock((_workspaceId: string) => undefined),
    };
    const workspaceService = createWorkspaceServiceForTest({
      config: mockConfig,
      historyService,
      aiService: mockAIService,
      initStateManager: mockInitStateManager as InitStateManager,
    });

    // Make it obvious if archive() incorrectly chooses deletion.
    workspaceService.remove = removeMock as unknown as typeof workspaceService.remove;

    const result = await workspaceService.archive(workspaceId);
    expect(result.success).toBe(true);
    expect(editConfigMock).toHaveBeenCalled();
    expect(removeMock).not.toHaveBeenCalled();
  });

  test("list() includes isInitializing when init state is running", async () => {
    const workspaceId = "ws-list-initializing";

    const mockAIService = {
      ...createStreamLifecycleMocks(),
      isStreaming: mock(() => false),
      // eslint-disable-next-line @typescript-eslint/no-empty-function
      on: mock(() => {}),
      // eslint-disable-next-line @typescript-eslint/no-empty-function
      off: mock(() => {}),
    } as unknown as AIService;

    const mockMetadata: FrontendWorkspaceMetadata = {
      id: workspaceId,
      name: "ws",
      projectName: "proj",
      projectPath: "/tmp/proj",
      createdAt: "2026-01-01T00:00:00.000Z",
      namedWorkspacePath: "/tmp/proj/ws",
      runtimeConfig: { type: "local" },
    };

    const mockConfig: MockWorkspaceConfig = {
      srcDir: "/tmp/test",
      getAllWorkspaceMetadata: mock(() => Promise.resolve([mockMetadata])),
      sessionsDir: "/tmp/test/sessions",
      generateStableId: mock(() => "test-id"),
      findWorkspace: mock(() => null),
    };

    const mockInitStateManager: Partial<InitStateManager> = {
      // WorkspaceService subscribes to init-end events on construction.
      on: mock(() => undefined as unknown as InitStateManager),
      getInitState: mock((id: string): InitStatus | undefined =>
        id === workspaceId
          ? {
              status: "running",
              hookPath: "/tmp/proj",
              startTime: 0,
              lines: [],
              exitCode: null,
              endTime: null,
            }
          : undefined
      ),
    };
    const workspaceService = createWorkspaceServiceForTest({
      config: mockConfig,
      historyService,
      aiService: mockAIService,
      initStateManager: mockInitStateManager as InitStateManager,
    });

    const list = await workspaceService.list();
    expect(list).toHaveLength(1);
    expect(list[0]?.isInitializing).toBe(true);
  });

  test("create() clears init state + emits updated metadata when skipping background init", async () => {
    const workspaceId = "ws-skip-init";
    const projectPath = "/tmp/proj";
    const branchName = "ws_branch";
    const workspacePath = "/tmp/proj/ws_branch";

    const initStates = new Map<string, InitStatus>();
    const clearInMemoryStateMock = mock((id: string) => {
      initStates.delete(id);
    });

    const mockInitStateManager: Partial<InitStateManager> = {
      on: mock(() => undefined as unknown as InitStateManager),
      startInit: mock((id: string) => {
        initStates.set(id, {
          status: "running",
          hookPath: projectPath,
          startTime: 0,
          lines: [],
          exitCode: null,
          endTime: null,
        });
      }),
      getInitState: mock((id: string) => initStates.get(id)),
      clearInMemoryState: clearInMemoryStateMock,
    };

    const configState: ProjectsConfig = { projects: new Map() };

    const mockMetadata: FrontendWorkspaceMetadata = {
      id: workspaceId,
      name: branchName,
      title: "title",
      projectName: "proj",
      projectPath,
      createdAt: "2026-01-01T00:00:00.000Z",
      namedWorkspacePath: workspacePath,
      runtimeConfig: { type: "local" },
    };

    const mockConfig: MockWorkspaceConfig = {
      rootDir: "/tmp/mux-root",
      srcDir: "/tmp/src",
      generateStableId: mock(() => workspaceId),
      editConfig: mock((editFn: (config: ProjectsConfig) => ProjectsConfig) => {
        editFn(configState);
        return Promise.resolve();
      }),
      getAllWorkspaceMetadata: mock(() => Promise.resolve([mockMetadata])),
      sessionsDir: "/tmp/test/sessions",
      findWorkspace: mock(() => null),
      loadConfigOrDefault: mock(() => ({
        projects: new Map([
          [
            projectPath,
            {
              workspaces: [],
              trusted: true,
            },
          ],
        ]),
      })),
    };

    const mockAIService = {
      ...createStreamLifecycleMocks(),
      isStreaming: mock(() => false),
      // eslint-disable-next-line @typescript-eslint/no-empty-function
      on: mock(() => {}),
      // eslint-disable-next-line @typescript-eslint/no-empty-function
      off: mock(() => {}),
    } as unknown as AIService;
    const createWorkspaceMock = mock(() =>
      Promise.resolve({ success: true as const, workspacePath })
    );

    const createRuntimeSpy = spyOn(runtimeFactory, "createRuntime").mockReturnValue({
      createWorkspace: createWorkspaceMock,
    } as unknown as ReturnType<typeof runtimeFactory.createRuntime>);

    const sessionEmitter = new EventEmitter();
    const fakeSession = {
      onChatEvent: (listener: (event: unknown) => void) => {
        sessionEmitter.on("chat-event", listener);
        return () => sessionEmitter.off("chat-event", listener);
      },
      onMetadataEvent: (listener: (event: unknown) => void) => {
        sessionEmitter.on("metadata-event", listener);
        return () => sessionEmitter.off("metadata-event", listener);
      },
      emitMetadata: (metadata: FrontendWorkspaceMetadata | null) => {
        sessionEmitter.emit("metadata-event", { workspaceId, metadata });
      },
      // eslint-disable-next-line @typescript-eslint/no-empty-function
      dispose: () => {},
    } as unknown as AgentSession;

    try {
      const workspaceService = createWorkspaceServiceForTest({
        config: mockConfig,
        historyService,
        aiService: mockAIService,
        initStateManager: mockInitStateManager as InitStateManager,
        secretsStore: {
          getEffectiveSecrets: mock(() => [{ key: "GH_TOKEN", value: "token" }]),
        } as unknown as SecretsStore,
      });

      const metadataEvents: Array<FrontendWorkspaceMetadata | null> = [];
      workspaceService.on("metadata", (event: unknown) => {
        if (!event || typeof event !== "object") {
          return;
        }
        const parsed = event as { workspaceId: string; metadata: FrontendWorkspaceMetadata | null };
        if (parsed.workspaceId === workspaceId) {
          metadataEvents.push(parsed.metadata);
        }
      });

      workspaceService.registerSession(workspaceId, fakeSession);

      const removingWorkspaces = (
        workspaceService as unknown as { removingWorkspaces: Set<string> }
      ).removingWorkspaces;
      removingWorkspaces.add(workspaceId);

      const result = await workspaceService.create(projectPath, branchName, undefined, "title", {
        type: "local",
      });

      expect(result.success).toBe(true);
      if (!result.success) {
        return;
      }

      expect(createWorkspaceMock).toHaveBeenCalledWith(
        expect.objectContaining({ env: { GH_TOKEN: "token" } })
      );
      expect(result.data.metadata.isInitializing).toBe(undefined);
      expect(clearInMemoryStateMock).toHaveBeenCalledWith(workspaceId);

      expect(metadataEvents).toHaveLength(2);
      expect(metadataEvents[0]?.isInitializing).toBe(true);
      expect(metadataEvents[1]?.isInitializing).toBe(undefined);
    } finally {
      createRuntimeSpy.mockRestore();
    }
  });

  test("create() auto-generates a workspace branch name when none is provided", async () => {
    // /new mirrors /fork's seamless flow: callers no longer have to invent a
    // workspace name. The backend should derive the next "workspace-N" slot
    // and persist `pendingAutoTitle` so the first message can title the workspace.
    const workspaceId = "ws-auto-named";
    const projectPath = "/tmp/proj-auto";
    const workspacePath = "/tmp/proj-auto/workspace-3";

    const initStates = new Map<string, InitStatus>();
    const mockInitStateManager: Partial<InitStateManager> = {
      on: mock(() => undefined as unknown as InitStateManager),
      startInit: mock((id: string) => {
        initStates.set(id, {
          status: "running",
          hookPath: projectPath,
          startTime: 0,
          lines: [],
          exitCode: null,
          endTime: null,
        });
      }),
      getInitState: mock((id: string) => initStates.get(id)),
      clearInMemoryState: mock((id: string) => {
        initStates.delete(id);
      }),
    };

    const configState: ProjectsConfig = { projects: new Map() };

    const mockMetadata: FrontendWorkspaceMetadata = {
      id: workspaceId,
      name: "workspace-3",
      projectName: "proj-auto",
      projectPath,
      createdAt: "2026-01-01T00:00:00.000Z",
      namedWorkspacePath: workspacePath,
      runtimeConfig: { type: "local" },
      pendingAutoTitle: true,
    };

    const mockConfig: MockWorkspaceConfig = {
      rootDir: "/tmp/mux-root",
      srcDir: "/tmp/src",
      generateStableId: mock(() => workspaceId),
      editConfig: mock((editFn: (config: ProjectsConfig) => ProjectsConfig) => {
        editFn(configState);
        return Promise.resolve();
      }),
      getAllWorkspaceMetadata: mock(() => Promise.resolve([mockMetadata])),
      sessionsDir: "/tmp/test/sessions",
      findWorkspace: mock(() => null),
      // Two pre-existing workspaces — auto-naming should skip past them.
      loadConfigOrDefault: mock(() => ({
        projects: new Map([
          [
            projectPath,
            {
              workspaces: [
                { id: "x", name: "workspace-1", path: "/tmp/proj-auto/workspace-1" },
                { id: "y", name: "workspace-2", path: "/tmp/proj-auto/workspace-2" },
              ],
              trusted: true,
            },
          ],
        ]),
      })),
    };

    const mockAIService = {
      ...createStreamLifecycleMocks(),
      isStreaming: mock(() => false),
      // eslint-disable-next-line @typescript-eslint/no-empty-function
      on: mock(() => {}),
      // eslint-disable-next-line @typescript-eslint/no-empty-function
      off: mock(() => {}),
    } as unknown as AIService;
    const createWorkspaceMock = mock(() =>
      Promise.resolve({ success: true as const, workspacePath })
    );

    const createRuntimeSpy = spyOn(runtimeFactory, "createRuntime").mockReturnValue({
      createWorkspace: createWorkspaceMock,
    } as unknown as ReturnType<typeof runtimeFactory.createRuntime>);

    try {
      const workspaceService = new WorkspaceService(
        withExistingConfigLoader(mockConfig) as Config,
        historyService,
        mockAIService,
        mockInitStateManager as InitStateManager,
        mockExtensionMetadataService as ExtensionMetadataService,
        mockBackgroundProcessManager as BackgroundProcessManager,
        undefined,
        undefined,
        undefined,
        undefined,
        undefined,
        undefined,
        { getEffectiveSecrets: mock(() => []) } as unknown as SecretsStore
      );

      const removingWorkspaces = (
        workspaceService as unknown as { removingWorkspaces: Set<string> }
      ).removingWorkspaces;
      // Skip the background init path so the test stays focused on auto-naming/persistence.
      removingWorkspaces.add(workspaceId);

      const result = await workspaceService.create(
        projectPath,
        // No branchName — backend should auto-generate workspace-3.
        undefined,
        undefined,
        undefined,
        { type: "local" },
        undefined,
        // pendingAutoTitle: true mirrors the /fork-with-message flow.
        true
      );

      expect(result.success).toBe(true);
      if (!result.success) {
        return;
      }

      // Backend picked the next "workspace-N" slot and threaded it through to
      // both the runtime call and the persisted config entry.
      expect(createWorkspaceMock).toHaveBeenCalledWith(
        expect.objectContaining({
          branchName: "workspace-3",
          directoryName: "workspace-3",
        })
      );

      const persisted = configState.projects.get(projectPath)?.workspaces ?? [];
      const newEntry = persisted.find((entry) => entry.id === workspaceId);
      expect(newEntry?.name).toBe("workspace-3");
      expect(newEntry?.pendingAutoTitle).toBe(true);
    } finally {
      createRuntimeSpy.mockRestore();
    }
  });

  test("remove() aborts init and clears state before teardown", async () => {
    const workspaceId = "ws-remove-aborts";

    const tempRoot = await fsPromises.mkdtemp(path.join(tmpdir(), "mux-ws-remove-"));
    try {
      const abortController = new AbortController();
      const clearInMemoryStateMock = mock((_workspaceId: string) => undefined);
      const mockInitStateManager = {
        on: mock(() => undefined as unknown as InitStateManager),
        getInitState: mock(() => undefined),
        clearInMemoryState: clearInMemoryStateMock,
      } as unknown as InitStateManager;

      const mockAIService = {
        ...createStreamLifecycleMocks(),
        isStreaming: mock(() => false),
        stopStream: mock(() => Promise.resolve({ success: true as const, data: undefined })),
        getWorkspaceMetadata: mock(() => Promise.resolve({ success: false as const, error: "na" })),
        // eslint-disable-next-line @typescript-eslint/no-empty-function
        on: mock(() => {}),
        // eslint-disable-next-line @typescript-eslint/no-empty-function
        off: mock(() => {}),
      } as unknown as AIService;

      const mockConfig: MockWorkspaceConfig = {
        rootDir: path.join(tempRoot, "root"),
        srcDir: "/tmp/src",
        sessionsDir: tempRoot,
        removeWorkspace: mock(() => Promise.resolve()),
        findWorkspace: mock(() => null),
        // The metadata-less removal path resolves the shared-memory owner
        // strictly from config; an unreadable config aborts the removal.
        loadConfigOrDefault: mock(() => ({ projects: new Map() })),
      };
      const workspaceService = new WorkspaceService(
        withExistingConfigLoader(mockConfig) as Config,
        historyService,
        mockAIService,
        mockInitStateManager,
        mockExtensionMetadataService as ExtensionMetadataService,
        mockBackgroundProcessManager as BackgroundProcessManager
      );

      // Inject an in-progress init AbortController.
      const initAbortControllers = (
        workspaceService as unknown as { initAbortControllers: Map<string, AbortController> }
      ).initAbortControllers;
      initAbortControllers.set(workspaceId, abortController);

      const result = await workspaceService.remove(workspaceId, true);
      expect(result.success).toBe(true);
      expect(abortController.signal.aborted).toBe(true);
      expect(clearInMemoryStateMock).toHaveBeenCalledWith(workspaceId);

      expect(initAbortControllers.has(workspaceId)).toBe(false);
    } finally {
      await fsPromises.rm(tempRoot, { recursive: true, force: true });
    }
  });

  test("remove() does not clear init state when runtime deletion fails with force=false", async () => {
    const workspaceId = "ws-remove-runtime-delete-fails";
    const projectPath = "/tmp/proj";

    const abortController = new AbortController();
    const clearInMemoryStateMock = mock((_workspaceId: string) => undefined);
    const mockInitStateManager = {
      on: mock(() => undefined as unknown as InitStateManager),
      getInitState: mock(() => undefined),
      clearInMemoryState: clearInMemoryStateMock,
    } as unknown as InitStateManager;
    const removeWorkspaceMock = mock(() => Promise.resolve());

    const deleteWorkspaceMock = mock(() =>
      Promise.resolve({ success: false as const, error: "dirty" })
    );

    const createRuntimeSpy = spyOn(runtimeFactory, "createRuntime").mockReturnValue({
      deleteWorkspace: deleteWorkspaceMock,
    } as unknown as ReturnType<typeof runtimeFactory.createRuntime>);

    const tempRoot = await fsPromises.mkdtemp(path.join(tmpdir(), "mux-ws-remove-fail-"));
    try {
      const mockAIService = {
        ...createStreamLifecycleMocks(),
        isStreaming: mock(() => false),
        stopStream: mock(() => Promise.resolve({ success: true as const, data: undefined })),
        getWorkspaceMetadata: mock(() =>
          Promise.resolve(
            Ok({
              id: workspaceId,
              name: "ws",
              projectPath,
              projectName: "proj",
              runtimeConfig: { type: "local" },
            })
          )
        ),
        // eslint-disable-next-line @typescript-eslint/no-empty-function
        on: mock(() => {}),
        // eslint-disable-next-line @typescript-eslint/no-empty-function
        off: mock(() => {}),
      } as unknown as AIService;

      const mockConfig: MockWorkspaceConfig = {
        srcDir: "/tmp/src",
        sessionsDir: tempRoot,
        removeWorkspace: removeWorkspaceMock,
        findWorkspace: mock(() => null),
      };
      const workspaceService = new WorkspaceService(
        withExistingConfigLoader(mockConfig) as Config,
        historyService,
        mockAIService,
        mockInitStateManager,
        mockExtensionMetadataService as ExtensionMetadataService,
        mockBackgroundProcessManager as BackgroundProcessManager
      );

      // Inject an in-progress init AbortController.
      const initAbortControllers = (
        workspaceService as unknown as { initAbortControllers: Map<string, AbortController> }
      ).initAbortControllers;
      initAbortControllers.set(workspaceId, abortController);

      const result = await workspaceService.remove(workspaceId, false);
      expect(result.success).toBe(false);
      expect(abortController.signal.aborted).toBe(true);

      // If runtime deletion fails with force=false, removal returns early and the workspace remains.
      // Keep init state intact so init-end can refresh metadata and clear isInitializing.
      expect(clearInMemoryStateMock).not.toHaveBeenCalled();
      expect(removeWorkspaceMock).not.toHaveBeenCalled();
    } finally {
      createRuntimeSpy.mockRestore();
      await fsPromises.rm(tempRoot, { recursive: true, force: true });
    }
  });
  test("remove() holds turn admission on the session until removal settles", async () => {
    const workspaceId = "ws-remove-holds-admission";
    const projectPath = "/tmp/proj";

    let releases = 0;
    let releasesWhenRuntimeDeleted = -1;
    const deleteWorkspaceMock = mock(() => {
      releasesWhenRuntimeDeleted = releases;
      return Promise.resolve({ success: false as const, error: "dirty" });
    });
    const createRuntimeSpy = spyOn(runtimeFactory, "createRuntime").mockReturnValue({
      deleteWorkspace: deleteWorkspaceMock,
    } as unknown as ReturnType<typeof runtimeFactory.createRuntime>);

    const tempRoot = await fsPromises.mkdtemp(path.join(tmpdir(), "mux-ws-remove-hold-"));
    try {
      const mockAIService = {
        ...createStreamLifecycleMocks(),
        isStreaming: mock(() => false),
        stopStream: mock(() => Promise.resolve({ success: true as const, data: undefined })),
        getWorkspaceMetadata: mock(() =>
          Promise.resolve(
            Ok({
              id: workspaceId,
              name: "ws",
              projectPath,
              projectName: "proj",
              runtimeConfig: { type: "local" },
            })
          )
        ),
        // eslint-disable-next-line @typescript-eslint/no-empty-function
        on: mock(() => {}),
        // eslint-disable-next-line @typescript-eslint/no-empty-function
        off: mock(() => {}),
      } as unknown as AIService;
      const mockConfig: MockWorkspaceConfig = {
        rootDir: path.join(tempRoot, "root"),
        srcDir: "/tmp/src",
        sessionsDir: tempRoot,
        removeWorkspace: mock(() => Promise.resolve()),
        findWorkspace: mock(() => ({ projectPath, workspacePath: "/tmp/proj/ws" })),
        loadConfigOrDefault: mock(() => ({ projects: new Map() })),
      };
      const workspaceService = new WorkspaceService(
        withExistingConfigLoader(mockConfig) as Config,
        historyService,
        mockAIService,
        mockInitStateManager as InitStateManager,
        mockExtensionMetadataService as ExtensionMetadataService,
        mockBackgroundProcessManager as BackgroundProcessManager
      );

      // A session whose startup recovery may be one await away from dispatching.
      const holdTurnAdmission = mock(() => ({
        [Symbol.dispose]: () => {
          releases += 1;
        },
      }));
      const dispose = mock(() => undefined);
      (workspaceService as unknown as { sessions: Map<string, AgentSession> }).sessions.set(
        workspaceId,
        {
          holdTurnAdmission,
          dispose,
        } as unknown as AgentSession
      );

      const result = await workspaceService.remove(workspaceId, false);
      expect(result.success).toBe(false);
      expect(holdTurnAdmission).toHaveBeenCalledTimes(1);
      // Held across the runtime deletion, released once the failed removal settles so the
      // still-configured workspace stays usable.
      expect(releasesWhenRuntimeDeleted).toBe(0);
      expect(releases).toBe(1);
      expect(dispose).not.toHaveBeenCalled();
    } finally {
      createRuntimeSpy.mockRestore();
      await fsPromises.rm(tempRoot, { recursive: true, force: true });
    }
  });
  test("remove() calls runtime.deleteWorkspace when force=true", async () => {
    const workspaceId = "ws-remove-runtime-delete";
    const projectPath = "/tmp/proj";

    const deleteWorkspaceMock = mock(() =>
      Promise.resolve({ success: true as const, deletedPath: "/tmp/deleted" })
    );

    const createRuntimeSpy = spyOn(runtimeFactory, "createRuntime").mockReturnValue({
      deleteWorkspace: deleteWorkspaceMock,
    } as unknown as ReturnType<typeof runtimeFactory.createRuntime>);

    const tempRoot = await fsPromises.mkdtemp(path.join(tmpdir(), "mux-ws-remove-runtime-"));
    try {
      const mockAIService = {
        ...createStreamLifecycleMocks(),
        isStreaming: mock(() => false),
        stopStream: mock(() => Promise.resolve({ success: true as const, data: undefined })),
        getWorkspaceMetadata: mock(() =>
          Promise.resolve(
            Ok({
              id: workspaceId,
              name: "ws",
              projectPath,
              projectName: "proj",
              runtimeConfig: { type: "local" },
            })
          )
        ),
        // eslint-disable-next-line @typescript-eslint/no-empty-function
        on: mock(() => {}),
        // eslint-disable-next-line @typescript-eslint/no-empty-function
        off: mock(() => {}),
      } as unknown as AIService;

      const mockConfig: MockWorkspaceConfig = {
        rootDir: path.join(tempRoot, "root"),
        srcDir: "/tmp/src",
        sessionsDir: tempRoot,
        removeWorkspace: mock(() => Promise.resolve()),
        findWorkspace: mock(() => ({ projectPath, workspacePath: "/tmp/proj/ws" })),
        loadConfigOrDefault: mock(() => ({ projects: new Map() })),
      };
      const workspaceService = new WorkspaceService(
        withExistingConfigLoader(mockConfig) as Config,
        historyService,
        mockAIService,
        mockInitStateManager as InitStateManager,
        mockExtensionMetadataService as ExtensionMetadataService,
        mockBackgroundProcessManager as BackgroundProcessManager
      );

      const result = await workspaceService.remove(workspaceId, true);
      expect(result.success).toBe(true);
      // trusted defaults to false (no project config), so deleteWorkspace gets (path, name, force, undefined, false)
      expect(deleteWorkspaceMock).toHaveBeenCalledWith(projectPath, "ws", true, undefined, false);
    } finally {
      createRuntimeSpy.mockRestore();
      await fsPromises.rm(tempRoot, { recursive: true, force: true });
    }
  });
});

describe("WorkspaceService regenerateTitle", () => {
  let workspaceService: WorkspaceService;
  let historyService: HistoryService;
  let cleanupHistory: () => Promise<void>;

  beforeEach(async () => {
    const mockAIService = {
      ...createStreamLifecycleMocks(),
      isStreaming: mock(() => false),
      getWorkspaceMetadata: mock(() =>
        Promise.resolve({ success: false as const, error: "workspace metadata unavailable" })
      ),
      // eslint-disable-next-line @typescript-eslint/no-empty-function
      on: mock(() => {}),
      // eslint-disable-next-line @typescript-eslint/no-empty-function
      off: mock(() => {}),
    } as unknown as AIService;

    ({ historyService, cleanup: cleanupHistory } = await createTestHistoryService());

    const mockConfig: MockWorkspaceConfig = {
      srcDir: "/tmp/test",
      sessionsDir: "/tmp/test/sessions",
      generateStableId: mock(() => "test-id"),
      findWorkspace: mock(() => ({ projectPath: "/tmp/proj", workspacePath: "/tmp/proj/ws" })),
    };
    const mockInitStateManager: Partial<InitStateManager> = {
      on: mock(() => undefined as unknown as InitStateManager),
      getInitState: mock(() => undefined),
    };

    workspaceService = createWorkspaceServiceForTest({
      config: mockConfig,
      historyService,
      aiService: mockAIService,
      initStateManager: mockInitStateManager as InitStateManager,
    });
  });

  afterEach(async () => {
    await cleanupHistory();
  });

  test("returns updateTitle error when persisting generated title fails", async () => {
    const workspaceId = "ws-regenerate-title";

    await historyService.appendToHistory(workspaceId, createMuxMessage("user-1", "user", "Fix CI"));

    const generateIdentitySpy = spyOn(
      workspaceTitleGenerator,
      "generateWorkspaceIdentity"
    ).mockResolvedValue(
      Ok({
        name: "ci-fix-a1b2",
        title: "Fix CI",
        modelUsed: "anthropic:claude-3-5-haiku-latest",
      })
    );
    const updateTitleSpy = spyOn(workspaceService, "updateTitle").mockResolvedValueOnce(
      Err("Failed to update workspace title: disk full")
    );

    try {
      const result = await workspaceService.regenerateTitle(workspaceId);

      expect(result.success).toBe(false);
      if (!result.success) {
        expect(result.error).toBe("Failed to update workspace title: disk full");
      }
      expect(generateIdentitySpy).toHaveBeenCalledTimes(1);
      const call = generateIdentitySpy.mock.calls[0];
      expect(call?.[3]).toBeUndefined();
      expect(call?.[4]).toBe("Fix CI");
      expect(updateTitleSpy).toHaveBeenCalledWith(workspaceId, "Fix CI");
    } finally {
      updateTitleSpy.mockRestore();
      generateIdentitySpy.mockRestore();
    }
  });
  test("falls back to full history when latest compaction epoch has no user message", async () => {
    const workspaceId = "ws-regenerate-title-compacted";

    await historyService.appendToHistory(
      workspaceId,
      createMuxMessage("user-before-boundary", "user", "Refactor sidebar loading")
    );
    await historyService.appendToHistory(
      workspaceId,
      createMuxMessage("summary-boundary", "assistant", "Compacted summary", {
        compacted: true,
        compactionBoundary: true,
        compactionEpoch: 1,
      })
    );
    await historyService.appendToHistory(
      workspaceId,
      createMuxMessage("assistant-after-boundary", "assistant", "No new user messages yet")
    );

    const iterateSpy = spyOn(historyService, "iterateFullHistory");
    const generateIdentitySpy = spyOn(
      workspaceTitleGenerator,
      "generateWorkspaceIdentity"
    ).mockResolvedValue(
      Ok({
        name: "sidebar-refactor-a1b2",
        title: "Refactor sidebar loading",
        modelUsed: "anthropic:claude-3-5-haiku-latest",
      })
    );
    const updateTitleSpy = spyOn(workspaceService, "updateTitle").mockResolvedValueOnce(
      Ok(undefined)
    );

    try {
      const result = await workspaceService.regenerateTitle(workspaceId);

      expect(result.success).toBe(true);
      if (result.success) {
        expect(result.data.title).toBe("Refactor sidebar loading");
      }
      expect(iterateSpy).toHaveBeenCalledTimes(1);
      expect(generateIdentitySpy).toHaveBeenCalledTimes(1);
      const call = generateIdentitySpy.mock.calls[0];
      expect(call?.[0]).toBe("Refactor sidebar loading");
      const context = call?.[3];
      expect(typeof context).toBe("string");
      if (typeof context === "string") {
        expect(context).toContain("Refactor sidebar loading");
        expect(context).toContain("Compacted summary");
        expect(context).toContain("No new user messages yet");
        expect(context).not.toContain("omitted for brevity");
      }
      expect(call?.[4]).toBe("Refactor sidebar loading");
      expect(updateTitleSpy).toHaveBeenCalledWith(workspaceId, "Refactor sidebar loading");
    } finally {
      updateTitleSpy.mockRestore();
      generateIdentitySpy.mockRestore();
      iterateSpy.mockRestore();
    }
  });
  test("uses first user turn + latest 3 turns and flags omitted context", async () => {
    const workspaceId = "ws-regenerate-title-first-plus-last-three";

    for (let turn = 1; turn <= 12; turn++) {
      const role: "user" | "assistant" = turn % 2 === 1 ? "user" : "assistant";
      const text = `${role === "user" ? "User" : "Assistant"} turn ${turn}`;
      await historyService.appendToHistory(
        workspaceId,
        createMuxMessage(`${role}-${turn}`, role, text)
      );
    }

    const generateIdentitySpy = spyOn(
      workspaceTitleGenerator,
      "generateWorkspaceIdentity"
    ).mockResolvedValue(
      Ok({
        name: "title-refresh-a1b2",
        title: "User turn 1",
        modelUsed: "anthropic:claude-3-5-haiku-latest",
      })
    );
    const updateTitleSpy = spyOn(workspaceService, "updateTitle").mockResolvedValueOnce(
      Ok(undefined)
    );

    try {
      const result = await workspaceService.regenerateTitle(workspaceId);

      expect(result.success).toBe(true);
      expect(generateIdentitySpy).toHaveBeenCalledTimes(1);
      const call = generateIdentitySpy.mock.calls[0];
      expect(call?.[0]).toBe("User turn 1");
      const context = call?.[3];
      expect(typeof context).toBe("string");
      expect(call?.[4]).toBe("User turn 11");
      expect(updateTitleSpy).toHaveBeenCalledWith(workspaceId, "User turn 1");
    } finally {
      updateTitleSpy.mockRestore();
      generateIdentitySpy.mockRestore();
    }
  });
});

describe("WorkspaceService fork", () => {
  let config: Config;
  let tempDir: string;
  let historyService: HistoryService;
  let cleanupHistory: () => Promise<void>;

  beforeEach(async () => {
    ({
      config,
      tempDir,
      historyService,
      cleanup: cleanupHistory,
    } = await createTestHistoryService());
  });

  afterEach(async () => {
    await cleanupHistory();
  });

  test("cleans up init state when orchestrateFork rejects", async () => {
    const sourceWorkspaceId = "source-workspace";
    const newWorkspaceId = "forked-workspace";
    const sourceProjectPath = "/tmp/project";

    const mockAIService = {
      ...createStreamLifecycleMocks(),
      isStreaming: mock(() => false),
      getWorkspaceMetadata: mock(() =>
        Promise.resolve(
          Ok({
            id: sourceWorkspaceId,
            name: "source-branch",
            projectPath: sourceProjectPath,
            projectName: "project",
            runtimeConfig: { type: "local" },
          })
        )
      ),
      // eslint-disable-next-line @typescript-eslint/no-empty-function
      on: mock(() => {}),
      // eslint-disable-next-line @typescript-eslint/no-empty-function
      off: mock(() => {}),
    } as unknown as AIService;

    const startInitMock = mock(() => undefined);
    const endInitMock = mock(() => Promise.resolve());
    const mockInitStateManager: Partial<InitStateManager> = {
      on: mock(() => undefined as unknown as InitStateManager),
      getInitState: mock(() => ({ status: "running" }) as unknown as InitStatus),
      startInit: startInitMock,
      endInit: endInitMock,
      appendOutput: mock(() => undefined),
      enterHookPhase: mock(() => undefined),
    };

    const mockConfig: MockWorkspaceConfig = {
      srcDir: "/tmp/src",
      generateStableId: mock(() => newWorkspaceId),
      findWorkspace: mock(() => null),
      sessionsDir: "/tmp/test/sessions",
      loadConfigOrDefault: mock(() => ({
        projects: new Map([[sourceProjectPath, { workspaces: [], trusted: true }]]),
      })),
    };

    const workspaceService = createWorkspaceServiceForTest({
      config: mockConfig,
      historyService,
      aiService: mockAIService,
      initStateManager: mockInitStateManager as InitStateManager,
      secretsStore: { getEffectiveSecrets: mock(() => []) } as unknown as SecretsStore,
    });

    const getOrCreateSessionSpy = spyOn(workspaceService, "getOrCreateSession").mockReturnValue({
      emitMetadata: mock(() => undefined),
    } as unknown as AgentSession);
    const createRuntimeSpy = spyOn(runtimeFactory, "createRuntime").mockReturnValue(
      {} as ReturnType<typeof runtimeFactory.createRuntime>
    );
    const orchestrateForkSpy = spyOn(forkOrchestratorModule, "orchestrateFork").mockImplementation(
      () => Promise.reject(new Error("runtime explosion"))
    );

    try {
      const result = await workspaceService.fork(sourceWorkspaceId, "fork-child");

      expect(result.success).toBe(false);
      if (!result.success) {
        expect(result.error).toBe("Failed to fork workspace: runtime explosion");
      }

      expect(startInitMock).toHaveBeenCalledWith(newWorkspaceId, sourceProjectPath);
      expect(endInitMock).toHaveBeenCalledWith(newWorkspaceId, -1);

      const initAbortControllers = (
        workspaceService as unknown as { initAbortControllers: Map<string, AbortController> }
      ).initAbortControllers;
      expect(initAbortControllers.has(newWorkspaceId)).toBe(false);
    } finally {
      orchestrateForkSpy.mockRestore();
      createRuntimeSpy.mockRestore();
      getOrCreateSessionSpy.mockRestore();
    }
  });
  test("fork inherits a paused goal snapshot with fresh accounting", async () => {
    const sourceWorkspaceId = "source-workspace";
    const newWorkspaceId = "forked-workspace";
    const sourceProjectPath = path.join(tempDir, "project");
    const forkedWorkspacePath = path.join(sourceProjectPath, "fork-child");
    const sourceMetadata: FrontendWorkspaceMetadata = {
      id: sourceWorkspaceId,
      name: "source-branch",
      projectPath: sourceProjectPath,
      projectName: "project",
      runtimeConfig: { type: "local" },
      namedWorkspacePath: path.join(sourceProjectPath, "source-branch"),
    };

    await fsPromises.mkdir(sourceProjectPath, { recursive: true });
    await config.addWorkspace(sourceProjectPath, sourceMetadata);
    await config.editConfig((current) => {
      const project = current.projects.get(sourceProjectPath);
      if (!project) {
        throw new Error("Expected test project config to exist");
      }
      project.trusted = true;
      return current;
    });

    const extensionMetadata = new ExtensionMetadataService(
      path.join(config.rootDir, "extensionMetadata.json")
    );
    const goalService = new WorkspaceGoalService(config, historyService, extensionMetadata);
    const parentGoal = await setWorkspaceGoalOk(goalService, {
      workspaceId: sourceWorkspaceId,
      objective: "Keep fork goal",
      budgetCents: 500,
      turnCap: 8,
    });
    await goalService.recordStreamAccounting({
      workspaceId: sourceWorkspaceId,
      costUsd: 1,
      streamOriginKind: "goal_continuation",
    });

    const mockAIService = {
      ...createStreamLifecycleMocks(),
      isStreaming: mock(() => false),
      getWorkspaceMetadata: mock(() => Promise.resolve(Ok(sourceMetadata))),
      on: mock(() => undefined),
      off: mock(() => undefined),
    } as unknown as AIService;

    const mockInitStateManager: Partial<InitStateManager> = {
      on: mock(() => undefined as unknown as InitStateManager),
      getInitState: mock(() => ({ status: "running" }) as unknown as InitStatus),
      startInit: mock(() => undefined),
      endInit: mock(() => Promise.resolve()),
      appendOutput: mock(() => undefined),
      enterHookPhase: mock(() => undefined),
    };

    const workspaceService = new WorkspaceService(
      withExistingConfigLoader(config),
      historyService,
      mockAIService,
      mockInitStateManager as InitStateManager,
      extensionMetadata,
      mockBackgroundProcessManager as BackgroundProcessManager
    );
    workspaceService.setWorkspaceGoalService(goalService);

    const targetRuntime = {
      getWorkspacePath: mock(() => forkedWorkspacePath),
    } as unknown as ReturnType<typeof runtimeFactory.createRuntime>;

    const generateStableIdSpy = spyOn(config, "generateStableId").mockReturnValue(newWorkspaceId);
    const getOrCreateSessionSpy = spyOn(workspaceService, "getOrCreateSession").mockReturnValue({
      emitMetadata: mock(() => undefined),
    } as unknown as AgentSession);
    const createRuntimeSpy = spyOn(runtimeFactory, "createRuntime").mockReturnValue(
      {} as ReturnType<typeof runtimeFactory.createRuntime>
    );
    const runBackgroundInitSpy = spyOn(runtimeFactory, "runBackgroundInit").mockImplementation(() =>
      Promise.resolve(undefined)
    );
    const copyPlanSpy = spyOn(runtimeExecHelpers, "copyPlanFileAcrossRuntimes").mockResolvedValue(
      undefined
    );
    const orchestrateForkSpy = spyOn(forkOrchestratorModule, "orchestrateFork").mockResolvedValue(
      Ok({
        workspacePath: forkedWorkspacePath,
        trunkBranch: "main",
        forkedRuntimeConfig: { type: "local" },
        targetRuntime,
        forkedFromSource: true,
        sourceRuntimeConfigUpdated: false,
      })
    );

    try {
      const result = await workspaceService.fork(sourceWorkspaceId, "fork-child");

      expect(result.success).toBe(true);
      if (!result.success) {
        throw new Error(`Expected success result, got error: ${result.error}`);
      }

      const forkGoal = await goalService.getGoal(newWorkspaceId);
      expect(forkGoal).toMatchObject({
        objective: "Keep fork goal",
        budgetCents: 500,
        turnCap: 8,
        status: "paused",
        costCents: 0,
        turnsUsed: 0,
        attributedChildren: [],
      });
      expect(forkGoal?.goalId).not.toBe(parentGoal.goalId);
      expect(await goalService.getGoal(sourceWorkspaceId)).toMatchObject({
        goalId: parentGoal.goalId,
        status: "active",
        costCents: 100,
        turnsUsed: 1,
      });
    } finally {
      orchestrateForkSpy.mockRestore();
      copyPlanSpy.mockRestore();
      runBackgroundInitSpy.mockRestore();
      createRuntimeSpy.mockRestore();
      getOrCreateSessionSpy.mockRestore();
      generateStableIdSpy.mockRestore();
    }
  });

  test("resets forked session usage while preserving copied history", async () => {
    const sourceWorkspaceId = "source-workspace";
    const newWorkspaceId = "forked-workspace";
    const sourceProjectPath = path.join(tempDir, "project");
    const sourceMetadata: FrontendWorkspaceMetadata = {
      id: sourceWorkspaceId,
      name: "source-branch",
      projectPath: sourceProjectPath,
      projectName: "project",
      runtimeConfig: { type: "local" },
      namedWorkspacePath: path.join(sourceProjectPath, "source-branch"),
    };

    await fsPromises.mkdir(sourceProjectPath, { recursive: true });
    await config.addWorkspace(sourceProjectPath, sourceMetadata);
    await config.editConfig((current) => {
      const project = current.projects.get(sourceProjectPath);
      if (!project) {
        throw new Error("Expected test project config to exist");
      }
      project.trusted = true;
      return current;
    });

    // Seed source history with assistant usage so the source cost ledger is non-empty
    // before we fork. The fork should keep this history but not inherit its costs.
    await historyService.appendToHistory(
      sourceWorkspaceId,
      createMuxMessage("assistant-1", "assistant", "Hello", {
        model: "claude-sonnet-4-20250514",
        usage: { inputTokens: 100, outputTokens: 50, totalTokens: 150 },
      })
    );

    const sessionUsageService = new SessionUsageService(config, historyService);
    const sourceUsage = await sessionUsageService.getSessionUsage(sourceWorkspaceId);
    expect(sourceUsage?.byModel["claude-sonnet-4-20250514"]?.input.tokens).toBe(100);

    const mockAIService = {
      ...createStreamLifecycleMocks(),
      isStreaming: mock(() => false),
      getWorkspaceMetadata: mock(() => Promise.resolve(Ok(sourceMetadata))),
      // eslint-disable-next-line @typescript-eslint/no-empty-function
      on: mock(() => {}),
      // eslint-disable-next-line @typescript-eslint/no-empty-function
      off: mock(() => {}),
    } as unknown as AIService;

    const mockInitStateManager: Partial<InitStateManager> = {
      on: mock(() => undefined as unknown as InitStateManager),
      getInitState: mock(() => ({ status: "running" }) as unknown as InitStatus),
      startInit: mock(() => undefined),
      endInit: mock(() => Promise.resolve()),
      appendOutput: mock(() => undefined),
      enterHookPhase: mock(() => undefined),
    };

    const workspaceService = new WorkspaceService(
      withExistingConfigLoader(config),
      historyService,
      mockAIService,
      mockInitStateManager as InitStateManager,
      mockExtensionMetadataService as ExtensionMetadataService,
      mockBackgroundProcessManager as BackgroundProcessManager,
      sessionUsageService
    );

    const targetRuntime = {
      getWorkspacePath: mock(() => path.join(sourceProjectPath, "fork-child")),
    } as unknown as ReturnType<typeof runtimeFactory.createRuntime>;

    const generateStableIdSpy = spyOn(config, "generateStableId").mockReturnValue(newWorkspaceId);
    const getOrCreateSessionSpy = spyOn(workspaceService, "getOrCreateSession").mockReturnValue({
      emitMetadata: mock(() => undefined),
    } as unknown as AgentSession);
    const createRuntimeSpy = spyOn(runtimeFactory, "createRuntime").mockReturnValue(
      {} as ReturnType<typeof runtimeFactory.createRuntime>
    );
    const runBackgroundInitSpy = spyOn(runtimeFactory, "runBackgroundInit").mockImplementation(() =>
      Promise.resolve(undefined)
    );
    const copyPlanSpy = spyOn(runtimeExecHelpers, "copyPlanFileAcrossRuntimes").mockResolvedValue(
      undefined
    );
    const orchestrateForkSpy = spyOn(forkOrchestratorModule, "orchestrateFork").mockResolvedValue(
      Ok({
        workspacePath: path.join(sourceProjectPath, "fork-child"),
        trunkBranch: "main",
        forkedRuntimeConfig: { type: "local" },
        targetRuntime,
        forkedFromSource: true,
        sourceRuntimeConfigUpdated: false,
      })
    );

    try {
      const result = await workspaceService.fork(sourceWorkspaceId, "fork-child");
      expect(result.success).toBe(true);
      if (!result.success) {
        throw new Error(`Expected success result, got error: ${result.error}`);
      }
      expect(result.data.metadata.forkFamilyBaseName).toBeUndefined();

      const forkedUsage = await sessionUsageService.getSessionUsage(newWorkspaceId);
      expect(forkedUsage).toEqual({ byModel: {}, version: 1 });

      const forkedMessages: string[] = [];
      const historyResult = await historyService.iterateFullHistory(
        newWorkspaceId,
        "forward",
        (chunk) => {
          forkedMessages.push(...chunk.map((message) => message.id));
        }
      );
      expect(historyResult.success).toBe(true);
      expect(forkedMessages).toContain("assistant-1");
    } finally {
      orchestrateForkSpy.mockRestore();
      copyPlanSpy.mockRestore();
      runBackgroundInitSpy.mockRestore();
      createRuntimeSpy.mockRestore();
      getOrCreateSessionSpy.mockRestore();
      generateStableIdSpy.mockRestore();
    }
  });
  test("fork snapshots persisted partials without mutating the source workspace", async () => {
    const sourceWorkspaceId = "source-workspace";
    const newWorkspaceId = "forked-workspace";
    const sourceProjectPath = path.join(tempDir, "project");
    const forkedWorkspacePath = path.join(sourceProjectPath, "fork-child");
    const sourceMetadata: FrontendWorkspaceMetadata = {
      id: sourceWorkspaceId,
      name: "source-branch",
      projectPath: sourceProjectPath,
      projectName: "project",
      runtimeConfig: { type: "local" },
      namedWorkspacePath: path.join(sourceProjectPath, "source-branch"),
    };

    await fsPromises.mkdir(sourceProjectPath, { recursive: true });
    await config.addWorkspace(sourceProjectPath, sourceMetadata);
    await config.editConfig((current) => {
      const project = current.projects.get(sourceProjectPath);
      if (!project) {
        throw new Error("Expected test project config to exist");
      }
      project.trusted = true;
      return current;
    });

    const sourcePartial = createMuxMessage(
      "assistant-partial",
      "assistant",
      "Waiting on task_await",
      { historySequence: 1 }
    );
    const writePartialResult = await historyService.writePartial(sourceWorkspaceId, sourcePartial);
    expect(writePartialResult.success).toBe(true);

    const mockAIService = {
      ...createStreamLifecycleMocks(),
      isStreaming: mock(() => false),
      getWorkspaceMetadata: mock(() => Promise.resolve(Ok(sourceMetadata))),
      on: mock(() => undefined),
      off: mock(() => undefined),
    } as unknown as AIService;

    const mockInitStateManager: Partial<InitStateManager> = {
      on: mock(() => undefined as unknown as InitStateManager),
      getInitState: mock(() => ({ status: "running" }) as unknown as InitStatus),
      startInit: mock(() => undefined),
      endInit: mock(() => Promise.resolve()),
      appendOutput: mock(() => undefined),
      enterHookPhase: mock(() => undefined),
    };

    const workspaceService = new WorkspaceService(
      withExistingConfigLoader(config),
      historyService,
      mockAIService,
      mockInitStateManager as InitStateManager,
      mockExtensionMetadataService as ExtensionMetadataService,
      mockBackgroundProcessManager as BackgroundProcessManager
    );

    const targetRuntime = {
      getWorkspacePath: mock(() => forkedWorkspacePath),
    } as unknown as ReturnType<typeof runtimeFactory.createRuntime>;

    const generateStableIdSpy = spyOn(config, "generateStableId").mockReturnValue(newWorkspaceId);
    const getOrCreateSessionSpy = spyOn(workspaceService, "getOrCreateSession").mockReturnValue({
      emitMetadata: mock(() => undefined),
    } as unknown as AgentSession);
    const createRuntimeSpy = spyOn(runtimeFactory, "createRuntime").mockReturnValue(
      {} as ReturnType<typeof runtimeFactory.createRuntime>
    );
    const runBackgroundInitSpy = spyOn(runtimeFactory, "runBackgroundInit").mockImplementation(() =>
      Promise.resolve(undefined)
    );
    const copyPlanSpy = spyOn(runtimeExecHelpers, "copyPlanFileAcrossRuntimes").mockResolvedValue(
      undefined
    );
    const orchestrateForkSpy = spyOn(forkOrchestratorModule, "orchestrateFork").mockResolvedValue(
      Ok({
        workspacePath: forkedWorkspacePath,
        trunkBranch: "main",
        forkedRuntimeConfig: { type: "local" },
        targetRuntime,
        forkedFromSource: true,
        sourceRuntimeConfigUpdated: false,
      })
    );

    try {
      const result = await workspaceService.fork(sourceWorkspaceId, "fork-child");
      expect(result.success).toBe(true);
      if (!result.success) {
        throw new Error(`Expected success result, got error: ${result.error}`);
      }

      const sourcePartialAfterFork = await historyService.readPartial(sourceWorkspaceId);
      expect(sourcePartialAfterFork?.id).toBe(sourcePartial.id);
      expect(await historyService.readPartial(newWorkspaceId)).toBeNull();

      const forkedMessageIds: string[] = [];
      const historyResult = await historyService.iterateFullHistory(
        newWorkspaceId,
        "forward",
        (chunk) => {
          forkedMessageIds.push(...chunk.map((message) => message.id));
        }
      );
      expect(historyResult.success).toBe(true);
      expect(forkedMessageIds).toContain(sourcePartial.id);
    } finally {
      orchestrateForkSpy.mockRestore();
      copyPlanSpy.mockRestore();
      runBackgroundInitSpy.mockRestore();
      createRuntimeSpy.mockRestore();
      getOrCreateSessionSpy.mockRestore();
      generateStableIdSpy.mockRestore();
    }
  });

  test("auto-generated fork names normalize legacy fork families before the validation fallback", async () => {
    const sourceWorkspaceId = "source-workspace";
    const newWorkspaceId = "forked-workspace";
    const sourceProjectPath = path.join(tempDir, "project");
    const sourceMetadata: FrontendWorkspaceMetadata = {
      id: sourceWorkspaceId,
      name: "Feature-fork-2",
      title: "Feature branch",
      projectPath: sourceProjectPath,
      projectName: "project",
      runtimeConfig: { type: "local" },
      namedWorkspacePath: path.join(sourceProjectPath, "Feature-fork-2"),
    };
    const forkedWorkspacePath = path.join(sourceProjectPath, "feature-1");

    await fsPromises.mkdir(sourceProjectPath, { recursive: true });
    await config.addWorkspace(sourceProjectPath, sourceMetadata);
    await config.editConfig((current) => {
      const project = current.projects.get(sourceProjectPath);
      if (!project) {
        throw new Error("Expected test project config to exist");
      }
      project.trusted = true;
      return current;
    });

    const mockAIService = {
      ...createStreamLifecycleMocks(),
      isStreaming: mock(() => false),
      getWorkspaceMetadata: mock(() => Promise.resolve(Ok(sourceMetadata))),
      // eslint-disable-next-line @typescript-eslint/no-empty-function
      on: mock(() => {}),
      // eslint-disable-next-line @typescript-eslint/no-empty-function
      off: mock(() => {}),
    } as unknown as AIService;

    const mockInitStateManager: Partial<InitStateManager> = {
      on: mock(() => undefined as unknown as InitStateManager),
      getInitState: mock(() => ({ status: "running" }) as unknown as InitStatus),
      startInit: mock(() => undefined),
      endInit: mock(() => Promise.resolve()),
      appendOutput: mock(() => undefined),
      enterHookPhase: mock(() => undefined),
    };

    const workspaceService = new WorkspaceService(
      withExistingConfigLoader(config),
      historyService,
      mockAIService,
      mockInitStateManager as InitStateManager,
      mockExtensionMetadataService as ExtensionMetadataService,
      mockBackgroundProcessManager as BackgroundProcessManager
    );

    const targetRuntime = {
      getWorkspacePath: mock(() => forkedWorkspacePath),
    } as unknown as ReturnType<typeof runtimeFactory.createRuntime>;

    const generateStableIdSpy = spyOn(config, "generateStableId").mockReturnValue(newWorkspaceId);
    const getOrCreateSessionSpy = spyOn(workspaceService, "getOrCreateSession").mockReturnValue({
      emitMetadata: mock(() => undefined),
    } as unknown as AgentSession);
    const createRuntimeSpy = spyOn(runtimeFactory, "createRuntime").mockReturnValue(
      {} as ReturnType<typeof runtimeFactory.createRuntime>
    );
    const runBackgroundInitSpy = spyOn(runtimeFactory, "runBackgroundInit").mockImplementation(() =>
      Promise.resolve(undefined)
    );
    const copyPlanSpy = spyOn(runtimeExecHelpers, "copyPlanFileAcrossRuntimes").mockResolvedValue(
      undefined
    );
    const orchestrateForkSpy = spyOn(forkOrchestratorModule, "orchestrateFork").mockResolvedValue(
      Ok({
        workspacePath: forkedWorkspacePath,
        trunkBranch: "main",
        forkedRuntimeConfig: { type: "local" },
        targetRuntime,
        forkedFromSource: true,
        sourceRuntimeConfigUpdated: false,
      })
    );

    try {
      const result = await workspaceService.fork(sourceWorkspaceId);

      expect(orchestrateForkSpy).toHaveBeenCalledWith(
        expect.objectContaining({
          sourceWorkspaceName: sourceMetadata.name,
          newWorkspaceName: "feature-1",
        })
      );

      expect(result.success).toBe(true);
      if (!result.success) {
        throw new Error(`Expected success result, got error: ${result.error}`);
      }

      expect(result.data.metadata.name).toBe("feature-1");
      expect(result.data.metadata.forkFamilyBaseName).toBe("Feature");
      expect(result.data.metadata.namedWorkspacePath).toBe(forkedWorkspacePath);
    } finally {
      orchestrateForkSpy.mockRestore();
      copyPlanSpy.mockRestore();
      runBackgroundInitSpy.mockRestore();
      createRuntimeSpy.mockRestore();
      getOrCreateSessionSpy.mockRestore();
      generateStableIdSpy.mockRestore();
    }
  });

  test("auto-generated fork names increment existing fork suffixes instead of nesting them", async () => {
    const sourceWorkspaceId = "source-workspace";
    const newWorkspaceId = "forked-workspace";
    const sourceProjectPath = path.join(tempDir, "project");
    const sourceMetadata: FrontendWorkspaceMetadata = {
      id: sourceWorkspaceId,
      name: "source-branch-2",
      title: "Source branch (2)",
      forkFamilyBaseName: "source-branch",
      projectPath: sourceProjectPath,
      projectName: "project",
      runtimeConfig: { type: "local" },
      namedWorkspacePath: path.join(sourceProjectPath, "source-branch-2"),
    };
    const forkedWorkspacePath = path.join(sourceProjectPath, "source-branch-3");

    await fsPromises.mkdir(sourceProjectPath, { recursive: true });
    await config.addWorkspace(sourceProjectPath, sourceMetadata);
    await config.editConfig((current) => {
      const project = current.projects.get(sourceProjectPath);
      if (!project) {
        throw new Error("Expected test project config to exist");
      }
      project.trusted = true;
      return current;
    });

    const mockAIService = {
      ...createStreamLifecycleMocks(),
      isStreaming: mock(() => false),
      getWorkspaceMetadata: mock(() => Promise.resolve(Ok(sourceMetadata))),
      // eslint-disable-next-line @typescript-eslint/no-empty-function
      on: mock(() => {}),
      // eslint-disable-next-line @typescript-eslint/no-empty-function
      off: mock(() => {}),
    } as unknown as AIService;

    const mockInitStateManager: Partial<InitStateManager> = {
      on: mock(() => undefined as unknown as InitStateManager),
      getInitState: mock(() => ({ status: "running" }) as unknown as InitStatus),
      startInit: mock(() => undefined),
      endInit: mock(() => Promise.resolve()),
      appendOutput: mock(() => undefined),
      enterHookPhase: mock(() => undefined),
    };

    const workspaceService = new WorkspaceService(
      withExistingConfigLoader(config),
      historyService,
      mockAIService,
      mockInitStateManager as InitStateManager,
      mockExtensionMetadataService as ExtensionMetadataService,
      mockBackgroundProcessManager as BackgroundProcessManager
    );

    const targetRuntime = {
      getWorkspacePath: mock(() => forkedWorkspacePath),
    } as unknown as ReturnType<typeof runtimeFactory.createRuntime>;

    const generateStableIdSpy = spyOn(config, "generateStableId").mockReturnValue(newWorkspaceId);
    const getOrCreateSessionSpy = spyOn(workspaceService, "getOrCreateSession").mockReturnValue({
      emitMetadata: mock(() => undefined),
    } as unknown as AgentSession);
    const createRuntimeSpy = spyOn(runtimeFactory, "createRuntime").mockReturnValue(
      {} as ReturnType<typeof runtimeFactory.createRuntime>
    );
    const runBackgroundInitSpy = spyOn(runtimeFactory, "runBackgroundInit").mockImplementation(() =>
      Promise.resolve(undefined)
    );
    const copyPlanSpy = spyOn(runtimeExecHelpers, "copyPlanFileAcrossRuntimes").mockResolvedValue(
      undefined
    );
    const orchestrateForkSpy = spyOn(forkOrchestratorModule, "orchestrateFork").mockResolvedValue(
      Ok({
        workspacePath: forkedWorkspacePath,
        trunkBranch: "main",
        forkedRuntimeConfig: { type: "local" },
        targetRuntime,
        forkedFromSource: true,
        sourceRuntimeConfigUpdated: false,
      })
    );

    try {
      const result = await workspaceService.fork(sourceWorkspaceId);

      expect(orchestrateForkSpy).toHaveBeenCalledWith(
        expect.objectContaining({
          sourceWorkspaceName: sourceMetadata.name,
          newWorkspaceName: "source-branch-3",
        })
      );

      expect(result.success).toBe(true);
      if (!result.success) {
        throw new Error(`Expected success result, got error: ${result.error}`);
      }

      expect(result.data.metadata.name).toBe("source-branch-3");
      expect(result.data.metadata.title).toBe("Source branch (3)");
      expect(result.data.metadata.forkFamilyBaseName).toBe("source-branch");
      expect(result.data.metadata.namedWorkspacePath).toBe(forkedWorkspacePath);
    } finally {
      orchestrateForkSpy.mockRestore();
      copyPlanSpy.mockRestore();
      runBackgroundInitSpy.mockRestore();
      createRuntimeSpy.mockRestore();
      getOrCreateSessionSpy.mockRestore();
      generateStableIdSpy.mockRestore();
    }
  });
  test("fork marks the new workspace as pending auto-title when a continue message is queued", async () => {
    const sourceWorkspaceId = "source-workspace";
    const newWorkspaceId = "forked-workspace";
    const sourceProjectPath = path.join(tempDir, "project");
    const sourceMetadata: FrontendWorkspaceMetadata = {
      id: sourceWorkspaceId,
      name: "source-branch",
      title: "Source branch",
      projectPath: sourceProjectPath,
      projectName: "project",
      runtimeConfig: { type: "local" },
      namedWorkspacePath: path.join(sourceProjectPath, "source-branch"),
    };
    const forkedWorkspacePath = path.join(sourceProjectPath, "source-branch-1");

    await fsPromises.mkdir(sourceProjectPath, { recursive: true });
    await config.addWorkspace(sourceProjectPath, sourceMetadata);
    await config.editConfig((current) => {
      const project = current.projects.get(sourceProjectPath);
      if (!project) {
        throw new Error("Expected test project config to exist");
      }
      project.trusted = true;
      return current;
    });

    const mockAIService = {
      ...createStreamLifecycleMocks(),
      isStreaming: mock(() => false),
      getWorkspaceMetadata: mock(() => Promise.resolve(Ok(sourceMetadata))),
      // eslint-disable-next-line @typescript-eslint/no-empty-function
      on: mock(() => {}),
      // eslint-disable-next-line @typescript-eslint/no-empty-function
      off: mock(() => {}),
    } as unknown as AIService;

    const mockInitStateManager: Partial<InitStateManager> = {
      on: mock(() => undefined as unknown as InitStateManager),
      getInitState: mock(() => ({ status: "running" }) as unknown as InitStatus),
      startInit: mock(() => undefined),
      endInit: mock(() => Promise.resolve()),
      appendOutput: mock(() => undefined),
      enterHookPhase: mock(() => undefined),
    };

    const workspaceService = new WorkspaceService(
      withExistingConfigLoader(config),
      historyService,
      mockAIService,
      mockInitStateManager as InitStateManager,
      mockExtensionMetadataService as ExtensionMetadataService,
      mockBackgroundProcessManager as BackgroundProcessManager
    );

    const targetRuntime = {
      getWorkspacePath: mock(() => forkedWorkspacePath),
    } as unknown as ReturnType<typeof runtimeFactory.createRuntime>;

    const generateStableIdSpy = spyOn(config, "generateStableId").mockReturnValue(newWorkspaceId);
    const getOrCreateSessionSpy = spyOn(workspaceService, "getOrCreateSession").mockReturnValue({
      emitMetadata: mock(() => undefined),
    } as unknown as AgentSession);
    const createRuntimeSpy = spyOn(runtimeFactory, "createRuntime").mockReturnValue(
      {} as ReturnType<typeof runtimeFactory.createRuntime>
    );
    const runBackgroundInitSpy = spyOn(runtimeFactory, "runBackgroundInit").mockImplementation(() =>
      Promise.resolve(undefined)
    );
    const copyPlanSpy = spyOn(runtimeExecHelpers, "copyPlanFileAcrossRuntimes").mockResolvedValue(
      undefined
    );
    const orchestrateForkSpy = spyOn(forkOrchestratorModule, "orchestrateFork").mockResolvedValue(
      Ok({
        workspacePath: forkedWorkspacePath,
        trunkBranch: "main",
        forkedRuntimeConfig: { type: "local" },
        targetRuntime,
        forkedFromSource: true,
        sourceRuntimeConfigUpdated: false,
      })
    );

    try {
      const result = await workspaceService.fork(sourceWorkspaceId, undefined, undefined, true);

      expect(result.success).toBe(true);
      if (!result.success) {
        throw new Error(`Expected success result, got error: ${result.error}`);
      }

      expect(result.data.metadata.pendingAutoTitle).toBe(true);
      const persistedMetadata = (await config.getAllWorkspaceMetadata()).find(
        (metadata) => metadata.id === newWorkspaceId
      );
      expect(persistedMetadata?.pendingAutoTitle).toBe(true);
    } finally {
      orchestrateForkSpy.mockRestore();
      copyPlanSpy.mockRestore();
      runBackgroundInitSpy.mockRestore();
      createRuntimeSpy.mockRestore();
      getOrCreateSessionSpy.mockRestore();
      generateStableIdSpy.mockRestore();
    }
  });
});

describe("WorkspaceService interruptStream", () => {
  let historyService: HistoryService;
  let cleanupHistory: () => Promise<void>;

  beforeEach(async () => {
    ({ historyService, cleanup: cleanupHistory } = await createTestHistoryService());
  });

  afterEach(async () => {
    await cleanupHistory();
  });

  test("sendQueuedImmediately waits for interrupted accounting and terminal publication", async () => {
    const workspaceId = "ws-interrupt-policy-barrier";
    const completion = Promise.withResolvers<TurnCompletion>();
    const accountingEntered = Promise.withResolvers<void>();
    const releaseAccounting = Promise.withResolvers<void>();
    const replacementStarted = Promise.withResolvers<void>();
    const emitter = new EventEmitter();
    const terminalOrder: string[] = [];
    let streamCount = 0;
    const h = await createAgentSessionHarness({
      workspaceId,
      aiEmitter: emitter,
      captureEvents: true,
      aiServiceOverrides: {
        streamMessage: mock(() => {
          const messageId = `assistant-${++streamCount}`;
          emitter.emit("stream-start", {
            type: "stream-start",
            workspaceId,
            messageId,
            model: "openai:gpt-4o",
            startTime: Date.now(),
          });
          if (streamCount === 2) replacementStarted.resolve();
          return Promise.resolve(
            Ok({
              messageId,
              completion:
                streamCount === 1
                  ? completion.promise
                  : createStartedTurnHandle(h.session.closingSignal).completion,
            })
          );
        }),
        stopStream: mock(() => {
          const streamAbort = {
            type: "stream-abort" as const,
            workspaceId,
            messageId: "assistant-1",
            abortReason: "user" as const,
          };
          emitter.emit("stream-abort", streamAbort);
          completion.resolve({ status: "aborted", abortReason: "user", streamAbort });
          return Promise.resolve(Ok(undefined));
        }),
      },
    });
    const workspaceService = createWorkspaceServiceForTest({
      config: h.config,
      historyService: h.historyService,
      aiService: h.aiService as AIService,
      initStateManager: h.initStateManager,
      backgroundProcessManager: h.backgroundProcessManager,
    });
    spyOn(workspaceService, "getOrCreateSession").mockReturnValue(h.session);
    const policy = h.session as unknown as {
      recordGoalAccountingFromUsage(input: unknown): Promise<void>;
    };
    spyOn(policy, "recordGoalAccountingFromUsage").mockImplementation(async () => {
      accountingEntered.resolve();
      await releaseAccounting.promise;
    });
    const dispatch = spyOn(h.session, "sendNextUserQueuedMessage");
    h.session.onChatEvent(({ message }) => {
      if (message.type === "stream-start" || message.type === "stream-abort")
        terminalOrder.push(`${message.type}:${message.messageId}`);
    });
    let interrupt: Promise<unknown> | undefined;
    try {
      await h.session.sendMessage("source", { model: "openai:gpt-4o", agentId: "exec" });
      h.session.queueMessage("queued replacement", { model: "openai:gpt-4o", agentId: "exec" });
      interrupt = workspaceService.interruptStream(workspaceId, { sendQueuedImmediately: true });
      await accountingEntered.promise;
      // Drain the facade's Promise-only bookkeeping while terminal accounting is
      // held by the explicit barrier; no elapsed-time assumption or timer is needed.
      await new Promise<void>((resolve) => setImmediate(resolve));
      expect(dispatch).not.toHaveBeenCalled();
      releaseAccounting.resolve();
      await interrupt;
      await replacementStarted.promise;
      expect(terminalOrder).toEqual([
        "stream-start:assistant-1",
        "stream-abort:assistant-1",
        "stream-start:assistant-2",
      ]);
      expect(h.session.isBusy()).toBe(true);
    } finally {
      releaseAccounting.resolve();
      await interrupt;
      await h.session.dispose();
      await h.cleanup();
    }
  });

  test("sendQueuedImmediately clears hard-interrupt suppression before queued resend", async () => {
    const workspaceId = "ws-interrupt-queue-111";

    const mockConfig: MockWorkspaceConfig = {
      srcDir: "/tmp/test",
      sessionsDir: "/tmp/test/sessions",
      generateStableId: mock(() => "test-id"),
      findWorkspace: mock(() => null),
    };

    const mockAIService: AIService = {
      ...createStreamLifecycleMocks(),
      isStreaming: mock(() => false),
      getWorkspaceMetadata: mock(() => Promise.resolve({ success: false, error: "not found" })),
      // eslint-disable-next-line @typescript-eslint/no-empty-function
      on: mock(() => {}),
      // eslint-disable-next-line @typescript-eslint/no-empty-function
      off: mock(() => {}),
    } as unknown as AIService;

    const workspaceService = createWorkspaceServiceForTest({
      config: mockConfig,
      historyService,
      aiService: mockAIService,
      initStateManager: mockInitStateManager as InitStateManager,
    });

    const resetAutoResumeCount = mock(() => undefined);
    const markParentWorkspaceInterrupted = mock(() => undefined);
    const terminateAllDescendantAgentTasks = mock(() => Promise.resolve([] as string[]));
    workspaceService.setAgentTaskIntegration(
      makeAgentTaskIntegrationFake({
        resetAutoResumeCount,
        markParentWorkspaceInterrupted,
        terminateAllDescendantAgentTasks,
      })
    );

    const sendNextUserQueuedMessage = mock(() => true);
    const restoreQueueToInput = mock(() => undefined);
    const interruptStream = mock(() => Promise.resolve(Ok(undefined)));
    const fakeSession = {
      interruptStream,
      sendNextUserQueuedMessage,
      restoreQueueToInput,
    };
    const getOrCreateSessionSpy = spyOn(workspaceService, "getOrCreateSession").mockReturnValue(
      fakeSession as unknown as AgentSession
    );

    try {
      const result = await workspaceService.interruptStream(workspaceId, {
        sendQueuedImmediately: true,
      });

      expect(result.success).toBe(true);
      expect(markParentWorkspaceInterrupted).toHaveBeenCalledWith(workspaceId);
      expect(terminateAllDescendantAgentTasks).toHaveBeenCalledWith(workspaceId);
      expect(resetAutoResumeCount).toHaveBeenCalledTimes(2);
      expect(sendNextUserQueuedMessage).toHaveBeenCalledTimes(1);
      expect(restoreQueueToInput).not.toHaveBeenCalled();
    } finally {
      getOrCreateSessionSpy.mockRestore();
    }
  });
});

// --- Pure helper tests (no mocks needed) ---

describe("generateForkBranchName", () => {
  test("returns -1 when no existing forks", () => {
    expect(generateForkBranchName("sidebar-a1b2", [])).toBe("sidebar-a1b2-1");
  });

  test("increments past the highest existing fork number", () => {
    expect(
      generateForkBranchName("sidebar-a1b2", [
        "sidebar-a1b2-1",
        "sidebar-a1b2-3",
        "other-workspace",
      ])
    ).toBe("sidebar-a1b2-4");
  });

  test("continues numbering for generated forks when given the stable family base name", () => {
    expect(generateForkBranchName("ws", ["ws-1", "ws-2"])).toBe("ws-3");
  });

  test("preserves numeric suffixes for non-fork names", () => {
    expect(generateForkBranchName("release-2024", ["release-1"])).toBe("release-2024-1");
  });

  test("continues numbering across legacy and new fork name patterns", () => {
    expect(generateForkBranchName("ws", ["ws-fork-1", "ws-2", "ws-fork-3"])).toBe("ws-4");
  });

  test("ignores non-matching workspace names", () => {
    expect(generateForkBranchName("feature", ["feature-branch", "feature-impl", "other-1"])).toBe(
      "feature-1"
    );
  });

  test("handles gaps in numbering", () => {
    expect(generateForkBranchName("ws", ["ws-1", "ws-5"])).toBe("ws-6");
  });

  test("ignores non-numeric suffixes", () => {
    expect(generateForkBranchName("ws", ["ws-abc", "ws-fork-"])).toBe("ws-1");
  });

  test("ignores partially numeric suffixes", () => {
    expect(generateForkBranchName("ws", ["ws-1abc", "ws-fork-02x", "ws-3"])).toBe("ws-4");
  });
});

describe("generateForkTitle", () => {
  test("returns (1) when no existing forks", () => {
    expect(generateForkTitle("Fix sidebar layout", [])).toBe("Fix sidebar layout (1)");
  });

  test("increments past the highest existing suffix", () => {
    expect(
      generateForkTitle("Fix sidebar layout", [
        "Fix sidebar layout",
        "Fix sidebar layout (1)",
        "Fix sidebar layout (3)",
      ])
    ).toBe("Fix sidebar layout (4)");
  });

  test("strips existing suffix from parent before computing base", () => {
    // Forking "Fix sidebar (2)" should produce "Fix sidebar (3)", not "Fix sidebar (2) (1)"
    expect(generateForkTitle("Fix sidebar (2)", ["Fix sidebar (1)", "Fix sidebar (2)"])).toBe(
      "Fix sidebar (3)"
    );
  });

  test("ignores non-matching titles", () => {
    expect(generateForkTitle("Refactor auth", ["Fix sidebar layout (1)", "Other task (2)"])).toBe(
      "Refactor auth (1)"
    );
  });

  test("handles gaps in numbering", () => {
    expect(generateForkTitle("Task", ["Task (1)", "Task (5)"])).toBe("Task (6)");
  });

  test("ignores non-numeric suffixes when selecting the next title number", () => {
    expect(generateForkTitle("Task", ["Task (2025 roadmap)", "Task (12abc)", "Task (2)"])).toBe(
      "Task (3)"
    );
  });
});

// Regression: persisted completed init state must not defer goal continuations as initializing.
describe("WorkspaceService.getGoalContinuationRuntimeState", () => {
  async function makeService(initState: InitStatus | undefined): Promise<WorkspaceService> {
    const mockAIService = {
      ...createStreamLifecycleMocks(),
      isStreaming: mock(() => false),
      on: mock(() => undefined),
      off: mock(() => undefined),
    } as unknown as AIService;

    const mockConfig: MockWorkspaceConfig = {
      srcDir: "/tmp/test",
      findWorkspace: mock(() => ({ projectPath: "/tmp/proj", workspacePath: "/tmp/proj/ws" })),
      getAllWorkspaceMetadata: mock(() => Promise.resolve([])),
      sessionsDir: "/tmp/test/sessions",
      generateStableId: mock(() => "test-id"),
      loadConfigOrDefault: mock(() => ({ projects: new Map() })),
    };
    const mockInitStateManager: Partial<InitStateManager> = {
      on: mock(() => undefined as unknown as InitStateManager),
      getInitState: mock(() => initState),
    };
    const mockExtensionMetadataService = {};
    const mockBackgroundProcessManager = {};
    const { historyService } = await createTestHistoryService();
    return new WorkspaceService(
      withExistingConfigLoader(mockConfig) as Config,
      historyService,
      mockAIService,
      mockInitStateManager as InitStateManager,
      mockExtensionMetadataService as ExtensionMetadataService,
      mockBackgroundProcessManager as BackgroundProcessManager
    );
  }

  test("isInitializing is false when init has finished successfully", async () => {
    const service = await makeService({
      status: "success",
      hookPath: "/tmp/proj",
      startTime: 0,
      lines: [],
      exitCode: 0,
      endTime: 1,
    });
    expect(service.getGoalContinuationRuntimeState("ws-1").isInitializing).toBe(false);
  });

  test("isInitializing is false when no init state has ever existed", async () => {
    const service = await makeService(undefined);
    expect(service.getGoalContinuationRuntimeState("ws-1").isInitializing).toBe(false);
  });

  test("isInitializing is true only while init is actively running", async () => {
    const service = await makeService({
      status: "running",
      hookPath: "/tmp/proj",
      startTime: 0,
      lines: [],
      exitCode: null,
      endTime: null,
    });
    expect(service.getGoalContinuationRuntimeState("ws-1").isInitializing).toBe(true);
  });

  test("in-preflight direct sends report the workspace busy for goal continuations", async () => {
    // Codex P1 (PRRT_kwDOPxxmWM6cECpR): a direct send does not set PREPARING
    // until late in AgentSession.sendMessage, so a kickoff candidate restored
    // while the send is mid-preflight (manual row already durable, session
    // still phase-idle) could otherwise be consumed by goal-continuation
    // eligibility and dispatched ahead of the user's turn. The runtime busy
    // predicate must include sendMessage's preflight counter.
    const service = await makeService(undefined);
    expect(service.getGoalContinuationRuntimeState("ws-1").isBusy).toBe(false);

    const counts = (service as unknown as { preflightSendCounts: Map<string, number> })
      .preflightSendCounts;
    counts.set("ws-1", 1);
    expect(service.getGoalContinuationRuntimeState("ws-1").isBusy).toBe(true);
    counts.delete("ws-1");
    expect(service.getGoalContinuationRuntimeState("ws-1").isBusy).toBe(false);
  });

  test("kickoff continuation fires on a freshly-init'd workspace", async () => {
    const workspaceId = "kickoff-after-init";
    const service = await makeService({
      status: "success",
      hookPath: "/tmp/proj",
      startTime: 0,
      lines: [],
      exitCode: 0,
      endTime: 1,
    });

    const { historyService, config, cleanup } = await createTestHistoryService();
    try {
      await config.addWorkspace("/tmp/kickoff-proj", {
        id: workspaceId,
        name: workspaceId,
        projectName: "kickoff-proj",
        projectPath: "/tmp/kickoff-proj",
        runtimeConfig: { type: "local" },
      });
      const extensionMetadata = new ExtensionMetadataService(
        `${config.rootDir}/kickoff-extension-metadata.json`
      );
      const goalService = new WorkspaceGoalService(config, historyService, extensionMetadata);

      const dispatcher = new IdleDispatcher();
      const execute = mock(() => Promise.resolve(true));
      goalService.registerGoalContinuationConsumer(dispatcher, {
        hasActiveDescendantTasks: () => false,
        getRuntimeState: (id) => service.getGoalContinuationRuntimeState(id),
        executeGoalContinuation: execute,
        getKickoffSendOptions: () => Promise.resolve({ model: "openai:gpt-4o", agentId: "exec" }),
      });

      const result = await goalService.setGoal({ workspaceId, objective: "Ship the kickoff fix" });
      expect(result.success).toBe(true);

      // Wait for the kickoff continuation dispatch via the shared
      // `waitForCondition` helper instead of an inline `Date.now()` loop —
      // the dispatcher worker is microtask + setTimeout-driven so we poll
      // until it lands (Coder-agents-review nit DEREM-50).
      await waitForCondition(() => execute.mock.calls.length > 0, { timeoutMs: 1_000 });

      expect(execute).toHaveBeenCalledTimes(1);
      expect(execute).toHaveBeenCalledWith(expect.objectContaining({ workspaceId }));
    } finally {
      await cleanup();
    }
  });

  // --------------------------------------------------------------------------
  // getDelegatedTurnContinuationSendOptions — bash-monitor wake continuations
  // --------------------------------------------------------------------------

  describe("delegated-turn continuation send options", () => {
    async function makeServiceWithHistory(): Promise<{
      service: WorkspaceService;
      historyService: HistoryService;
    }> {
      const mockAIService = {
        ...createStreamLifecycleMocks(),
        isStreaming: mock(() => false),
        on: mock(() => undefined),
        off: mock(() => undefined),
      } as unknown as AIService;
      const mockInitStateManager: Partial<InitStateManager> = {
        on: mock(() => undefined as unknown as InitStateManager),
        getInitState: mock(() => undefined),
      };
      const mockConfig: MockWorkspaceConfig = {
        srcDir: "/tmp/test",
        getAllWorkspaceMetadata: mock(() => Promise.resolve([])),
        sessionsDir: "/tmp/test/sessions",
        generateStableId: mock(() => "test-id"),
      };
      const { historyService } = await createTestHistoryService();
      const service = new WorkspaceService(
        withExistingConfigLoader(mockConfig) as Config,
        historyService,
        mockAIService,
        mockInitStateManager as InitStateManager,
        {} as ExtensionMetadataService,
        {} as BackgroundProcessManager
      );
      return { service, historyService };
    }

    interface DelegatedContinuationInternals {
      getDelegatedTurnContinuationSendOptions: (
        workspaceId: string
      ) => Promise<SendMessageOptions | null>;
    }

    const delegatedTurnCorrelation = {
      type: "workspace-turn-task" as const,
      taskHandleId: "wst_handle",
      ownerWorkspaceId: "owner-ws",
      turnId: "turn-1",
    };

    const delegatedTurnMessage = (id: string) =>
      createMuxMessage(id, "user", "Delegated prompt", {
        timestamp: Date.now(),
        muxMetadata: delegatedTurnCorrelation,
        retrySendOptions: {
          model: "anthropic:claude-opus-4-6",
          agentId: "plan",
          strictAgentResolution: true,
          agentInitiated: true,
        },
      });

    /** Correlated assistant response; "tool-calls" is the queue-dispatch cut that leaves the turn open. */
    const delegatedAssistantMessage = (id: string, finishReason: "tool-calls" | "stop") =>
      createMuxMessage(id, "assistant", "Working…", {
        timestamp: Date.now(),
        partial: false,
        finishReason,
        muxMetadata: delegatedTurnCorrelation,
      });

    test("continues a still-open delegated turn under its own per-turn options", async () => {
      const workspaceId = "ws-delegated-continuation";
      const { service, historyService } = await makeServiceWithHistory();
      await historyService.appendToHistory(workspaceId, delegatedTurnMessage("delegated-1"));
      await historyService.appendToHistory(
        workspaceId,
        delegatedAssistantMessage("assistant-cut", "tool-calls")
      );
      // A previous wake continuation must not hide the delegated turn's options.
      await historyService.appendToHistory(
        workspaceId,
        createMuxMessage("wake-1", "user", "Monitor matched", {
          timestamp: Date.now(),
          muxMetadata: { type: "bash-monitor-wake" as const, records: [] },
        })
      );

      const internals = service as unknown as DelegatedContinuationInternals;
      const options = await internals.getDelegatedTurnContinuationSendOptions(workspaceId);

      expect(options).not.toBeNull();
      // Per-turn overrides (agent, strictness) continue the turn; they never become
      // workspace defaults, and internal-only fields are not forwarded.
      expect(options).toMatchObject({
        model: "anthropic:claude-opus-4-6",
        agentId: "plan",
        strictAgentResolution: true,
        skipAiSettingsPersistence: true,
      });
      expect(options && "agentInitiated" in options).toBe(false);
      expect(options?.muxMetadata).toBeUndefined();
    });

    test("recovers options from a wake row after on-send compaction hid the delegated row", async () => {
      const workspaceId = "ws-delegated-post-compaction";
      const { service, historyService } = await makeServiceWithHistory();
      // On-send compaction consumed a wake continuation: the original delegated row is
      // behind the boundary; the compaction summary proves the turn is still open and
      // the follow-up wake-typed row is the remaining carrier of the turn's options.
      await historyService.appendToHistory(
        workspaceId,
        createMuxMessage("summary-1", "assistant", "Summary", {
          timestamp: Date.now(),
          muxMetadata: {
            type: "compaction-summary" as const,
            pendingFollowUp: {
              text: "Continue",
              model: "anthropic:claude-opus-4-6",
              agentId: "plan",
              workspaceTurnMetadata: delegatedTurnCorrelation,
            },
          },
        })
      );
      await historyService.appendToHistory(
        workspaceId,
        createMuxMessage("wake-followup", "user", "Monitor matched", {
          timestamp: Date.now(),
          muxMetadata: { type: "bash-monitor-wake" as const, records: [] },
          retrySendOptions: {
            model: "anthropic:claude-opus-4-6",
            agentId: "plan",
            strictAgentResolution: { expectedScope: "built-in" },
          },
        })
      );

      const internals = service as unknown as DelegatedContinuationInternals;
      const options = await internals.getDelegatedTurnContinuationSendOptions(workspaceId);
      expect(options).toMatchObject({
        model: "anthropic:claude-opus-4-6",
        agentId: "plan",
        strictAgentResolution: { expectedScope: "built-in" },
        skipAiSettingsPersistence: true,
      });
    });

    test("sanitizes persisted options through the canonical whitelist", async () => {
      const workspaceId = "ws-delegated-sanitized";
      const { service, historyService } = await makeServiceWithHistory();
      const tamperedRetrySendOptions: Record<string, unknown> = {
        model: "anthropic:claude-opus-4-6",
        agentId: "plan",
        editMessageId: "innocent-message",
        muxMetadata: { type: "workspace-turn-task" },
      };
      const malformedRetrySendOptions: Record<string, unknown> = { agentId: "plan" }; // model missing
      await historyService.appendToHistory(
        workspaceId,
        createMuxMessage("delegated-tampered", "user", "Delegated prompt", {
          timestamp: Date.now(),
          muxMetadata: delegatedTurnCorrelation,
          // History is untrusted at rest: injected fields outside the whitelist
          // (editMessageId would flip the send into the edit/truncation flow) must
          // never reach the internal continuation send.
          retrySendOptions: tamperedRetrySendOptions as never,
        })
      );
      await historyService.appendToHistory(
        workspaceId,
        delegatedAssistantMessage("assistant-cut-3", "tool-calls")
      );

      const internals = service as unknown as DelegatedContinuationInternals;
      const options = await internals.getDelegatedTurnContinuationSendOptions(workspaceId);
      expect(options).toMatchObject({ agentId: "plan", skipAiSettingsPersistence: true });
      expect(options && "editMessageId" in options && options.editMessageId).toBeFalsy();
      expect(options?.muxMetadata).toBeUndefined();

      // A row whose options fail schema validation entirely yields nothing.
      const malformedWorkspaceId = "ws-delegated-malformed";
      await historyService.appendToHistory(
        malformedWorkspaceId,
        createMuxMessage("delegated-malformed", "user", "Delegated prompt", {
          timestamp: Date.now(),
          muxMetadata: delegatedTurnCorrelation,
          retrySendOptions: malformedRetrySendOptions as never,
        })
      );
      await historyService.appendToHistory(
        malformedWorkspaceId,
        delegatedAssistantMessage("assistant-cut-4", "tool-calls")
      );
      expect(
        await internals.getDelegatedTurnContinuationSendOptions(malformedWorkspaceId)
      ).toBeNull();
    });

    test("yields nothing after a terminal assistant response closed the delegated turn", async () => {
      const workspaceId = "ws-delegated-closed";
      const { service, historyService } = await makeServiceWithHistory();
      await historyService.appendToHistory(workspaceId, delegatedTurnMessage("delegated-2"));
      // finishReason "stop" ends the delegated turn: a later monitor match is a NEW
      // synthetic turn and must resolve from persisted defaults, not stale overrides.
      await historyService.appendToHistory(
        workspaceId,
        delegatedAssistantMessage("assistant-final", "stop")
      );

      const internals = service as unknown as DelegatedContinuationInternals;
      expect(await internals.getDelegatedTurnContinuationSendOptions(workspaceId)).toBeNull();
    });

    test("yields nothing once another user send follows the delegated prompt", async () => {
      const workspaceId = "ws-delegated-superseded";
      const { service, historyService } = await makeServiceWithHistory();
      await historyService.appendToHistory(workspaceId, delegatedTurnMessage("delegated-3"));
      await historyService.appendToHistory(
        workspaceId,
        delegatedAssistantMessage("assistant-cut-2", "tool-calls")
      );
      await historyService.appendToHistory(
        workspaceId,
        createMuxMessage("manual-1", "user", "Manual user message", { timestamp: Date.now() })
      );

      const internals = service as unknown as DelegatedContinuationInternals;
      expect(await internals.getDelegatedTurnContinuationSendOptions(workspaceId)).toBeNull();
    });
  });

  // --------------------------------------------------------------------------
  // getGoalContinuationKickoffSendOptions — model-resolution cascade
  // --------------------------------------------------------------------------

  describe("model-resolution cascade", () => {
    async function makeServiceWithConfig(
      configOverrides: Partial<Config>
    ): Promise<WorkspaceService> {
      const mockAIService = {
        ...createStreamLifecycleMocks(),
        isStreaming: mock(() => false),
        on: mock(() => undefined),
        off: mock(() => undefined),
      } as unknown as AIService;
      const mockInitStateManager: Partial<InitStateManager> = {
        on: mock(() => undefined as unknown as InitStateManager),
        getInitState: mock(() => undefined),
      };
      const mockConfig: MockWorkspaceConfig = {
        srcDir: "/tmp/test",
        getAllWorkspaceMetadata: mock(() => Promise.resolve([])),
        sessionsDir: "/tmp/test/sessions",
        generateStableId: mock(() => "test-id"),
        ...configOverrides,
      };
      const { historyService } = await createTestHistoryService();
      const mockExtensionMetadataService = {};
      const mockBackgroundProcessManager = {};
      return new WorkspaceService(
        withExistingConfigLoader(mockConfig) as Config,
        historyService,
        mockAIService,
        mockInitStateManager as InitStateManager,
        mockExtensionMetadataService as ExtensionMetadataService,
        mockBackgroundProcessManager as BackgroundProcessManager
      );
    }

    test("returns null when the workspace is not found in config", async () => {
      const service = await makeServiceWithConfig({
        findWorkspace: mock(() => null),
        loadConfigOrDefault: mock(() => ({ projects: new Map() })),
      });
      expect(await service.getGoalContinuationKickoffSendOptions("ws-unknown")).toBeNull();
    });

    test("prefers per-workspace agent model over workspace default and globals", async () => {
      const projectPath = "/tmp/proj";
      const workspaceId = "ws-1";
      const projects = new Map([
        [
          projectPath,
          {
            workspaces: [
              {
                id: workspaceId,
                path: "/tmp/proj/ws",
                aiSettingsByAgent: {
                  exec: { model: "anthropic:claude-haiku-4-5", thinkingLevel: "off" as const },
                },
                aiSettings: { model: "openai:gpt-4o", thinkingLevel: "off" as const },
              },
            ],
          },
        ],
      ]);
      const service = await makeServiceWithConfig({
        findWorkspace: mock(() => ({ projectPath, workspacePath: "/tmp/proj/ws" })),
        loadConfigOrDefault: mock(() => ({
          projects,
          agentAiDefaults: { exec: { modelString: "google:gemini-2.5-pro" } },
        })),
      });
      const result = await service.getGoalContinuationKickoffSendOptions(workspaceId);
      expect(result?.model).toContain("haiku");
      expect(result?.agentId).toBe("exec");
    });

    test("uses the persisted selected agent for initial goal kickoff options", async () => {
      const projectPath = "/tmp/proj";
      const workspaceId = "ws-selected-agent";
      const projects = new Map([
        [
          projectPath,
          {
            workspaces: [
              {
                id: workspaceId,
                path: "/tmp/proj/ws",
                agentId: "review",
                aiSettingsByAgent: {
                  review: { model: "anthropic:claude-sonnet-4-6", thinkingLevel: "off" as const },
                  exec: { model: "openai:gpt-4o", thinkingLevel: "off" as const },
                },
              },
            ],
          },
        ],
      ]);
      const service = await makeServiceWithConfig({
        findWorkspace: mock(() => ({ projectPath, workspacePath: "/tmp/proj/ws" })),
        loadConfigOrDefault: mock(() => ({ projects })),
      });

      const result = await service.getGoalContinuationKickoffSendOptions(workspaceId);

      expect(result).toEqual({
        model: "anthropic:claude-sonnet-4-6",
        agentId: "review",
        thinkingLevel: "off",
        // The bucket owns the reasoning choice; absent resolves to explicit standard.
        reasoningMode: "standard",
      });
    });

    test("carries the persisted thinking level with the winning model candidate", async () => {
      const projectPath = "/tmp/proj";
      const workspaceId = "ws-thinking";
      const projects = new Map([
        [
          projectPath,
          {
            workspaces: [
              {
                id: workspaceId,
                path: "/tmp/proj/ws",
                aiSettingsByAgent: {
                  exec: { model: "anthropic:claude-fable-5", thinkingLevel: "medium" as const },
                },
              },
            ],
          },
        ],
      ]);
      const service = await makeServiceWithConfig({
        findWorkspace: mock(() => ({ projectPath, workspacePath: "/tmp/proj/ws" })),
        loadConfigOrDefault: mock(() => ({ projects })),
      });

      const result = await service.getGoalContinuationKickoffSendOptions(workspaceId);

      // Regression: continuations previously dropped the persisted thinking
      // level, streaming with an implicit "off" that Fable/Mythos-class
      // Anthropic models reject ("thinking.type.disabled" unsupported).
      expect(result).toEqual({
        model: "anthropic:claude-fable-5",
        agentId: "exec",
        thinkingLevel: "medium",
        reasoningMode: "standard",
      });
    });

    test("falls back to exec when the selected agent cannot run goal continuations", async () => {
      const projectPath = "/tmp/proj";
      const workspaceId = "ws-plan-agent";
      const projects = new Map([
        [
          projectPath,
          {
            workspaces: [
              {
                id: workspaceId,
                path: "/tmp/proj/ws",
                agentId: "plan",
                aiSettingsByAgent: {
                  plan: { model: "anthropic:claude-sonnet-4-6", thinkingLevel: "off" as const },
                  exec: { model: "openai:gpt-4o", thinkingLevel: "off" as const },
                },
              },
            ],
          },
        ],
      ]);
      const service = await makeServiceWithConfig({
        findWorkspace: mock(() => ({ projectPath, workspacePath: "/tmp/proj/ws" })),
        loadConfigOrDefault: mock(() => ({ projects })),
      });

      const result = await service.getGoalContinuationKickoffSendOptions(workspaceId);

      expect(result).toEqual({
        model: "openai:gpt-4o",
        agentId: "exec",
        thinkingLevel: "off",
        reasoningMode: "standard",
      });
    });

    test("falls through to workspace default model when per-agent is missing", async () => {
      const projectPath = "/tmp/proj";
      const workspaceId = "ws-1";
      const projects = new Map([
        [
          projectPath,
          {
            workspaces: [
              {
                id: workspaceId,
                path: "/tmp/proj/ws",
                aiSettings: { model: "openai:gpt-4o", thinkingLevel: "off" as const },
              },
            ],
          },
        ],
      ]);
      const service = await makeServiceWithConfig({
        findWorkspace: mock(() => ({ projectPath, workspacePath: "/tmp/proj/ws" })),
        loadConfigOrDefault: mock(() => ({ projects })),
      });
      const result = await service.getGoalContinuationKickoffSendOptions(workspaceId);
      expect(result?.model).toBe("openai:gpt-4o");
    });

    test("falls through to global agent default when workspace has no model", async () => {
      const projectPath = "/tmp/proj";
      const workspaceId = "ws-1";
      const projects = new Map([
        [projectPath, { workspaces: [{ id: workspaceId, path: "/tmp/proj/ws" }] }],
      ]);
      const service = await makeServiceWithConfig({
        findWorkspace: mock(() => ({ projectPath, workspacePath: "/tmp/proj/ws" })),
        loadConfigOrDefault: mock(() => ({
          projects,
          agentAiDefaults: { exec: { modelString: "anthropic:claude-sonnet-4-6" } },
        })),
      });
      const result = await service.getGoalContinuationKickoffSendOptions(workspaceId);
      expect(result?.model).toContain("sonnet");
    });

    test("model-less reasoning-only agent default still contributes its fields", async () => {
      const projectPath = "/tmp/proj";
      const workspaceId = "ws-1";
      const projects = new Map([
        [projectPath, { workspaces: [{ id: workspaceId, path: "/tmp/proj/ws" }] }],
      ]);
      const service = await makeServiceWithConfig({
        findWorkspace: mock(() => ({ projectPath, workspacePath: "/tmp/proj/ws" })),
        loadConfigOrDefault: mock(() => ({
          projects,
          // "Inherit" model in settings persists entries with only thinking
          // fields; the model must fall through while these fields apply.
          agentAiDefaults: {
            exec: { thinkingLevel: "high" as const, reasoningMode: "pro" as const },
          },
        })),
      });
      const result = await service.getGoalContinuationKickoffSendOptions(workspaceId);
      expect(result?.model).toBeTruthy();
      expect(result?.thinkingLevel).toBe("high");
      expect(result?.reasoningMode).toBe("pro");
    });

    test("resolves defaults through the selected agent's declared base chain", async () => {
      // A custom agent declaring base: plan must inherit Plan's configured
      // defaults, not fall through to the Exec approximation (mirrors
      // Settings/ACP/task-spawn resolution).
      const projectPath = await fsPromises.mkdtemp(path.join(tmpdir(), "mux-goal-chain-"));
      try {
        const agentsDir = path.join(projectPath, ".mux", "agents");
        await fsPromises.mkdir(agentsDir, { recursive: true });
        await fsPromises.writeFile(
          path.join(agentsDir, "researcher.md"),
          `---\nname: Researcher\ndescription: Plan-derived custom agent for tests\nbase: plan\nsubagent:\n  runnable: true\n---\n\nTest agent body.\n`,
          "utf-8"
        );

        const workspaceId = "ws-1";
        const projects = new Map([
          [
            projectPath,
            { workspaces: [{ id: workspaceId, path: projectPath, agentId: "researcher" }] },
          ],
        ]);
        const service = await makeServiceWithConfig({
          findWorkspace: mock(() => ({ projectPath, workspacePath: projectPath })),
          loadConfigOrDefault: mock(() => ({
            projects,
            agentAiDefaults: {
              plan: { thinkingLevel: "high" as const, reasoningMode: "pro" as const },
              exec: { thinkingLevel: "low" as const, reasoningMode: "standard" as const },
            },
          })),
        });
        // In-place metadata (projectPath === name) resolves the checkout root
        // to the fixture directory holding .mux/agents/researcher.md.
        spyOn(service, "getInfo").mockResolvedValue({
          id: workspaceId,
          name: projectPath,
          projectPath,
          projectName: "goal-chain",
          runtimeConfig: { type: "local" },
        } as FrontendWorkspaceMetadata);

        const result = await service.getGoalContinuationKickoffSendOptions(workspaceId);
        expect(result?.thinkingLevel).toBe("high");
        expect(result?.reasoningMode).toBe("pro");
      } finally {
        await fsPromises.rm(projectPath, { recursive: true, force: true });
      }
    });

    test("a project-scoped exec override with base: plan inherits Plan's defaults", async () => {
      // Every agent's declaration must be inspected, including one named
      // "exec": a project exec.md with base: plan must resolve Plan's pro
      // default, matching ACP/task/desktop resolution.
      const projectPath = await fsPromises.mkdtemp(path.join(tmpdir(), "mux-exec-chain-"));
      try {
        const agentsDir = path.join(projectPath, ".mux", "agents");
        await fsPromises.mkdir(agentsDir, { recursive: true });
        await fsPromises.writeFile(
          path.join(agentsDir, "exec.md"),
          `---\nname: Exec\ndescription: Project exec override for tests\nbase: plan\n---\n\nTest agent body.\n`,
          "utf-8"
        );

        const workspaceId = "ws-1";
        const projects = new Map([
          [projectPath, { workspaces: [{ id: workspaceId, path: projectPath, agentId: "exec" }] }],
        ]);
        const service = await makeServiceWithConfig({
          findWorkspace: mock(() => ({ projectPath, workspacePath: projectPath })),
          loadConfigOrDefault: mock(() => ({
            projects,
            agentAiDefaults: {
              plan: { reasoningMode: "pro" as const },
            },
          })),
        });
        spyOn(service, "getInfo").mockResolvedValue({
          id: workspaceId,
          name: projectPath,
          projectPath,
          projectName: "exec-chain",
          runtimeConfig: { type: "local" },
        } as FrontendWorkspaceMetadata);

        const result = await service.getGoalContinuationKickoffSendOptions(workspaceId);
        expect(result?.reasoningMode).toBe("pro");
      } finally {
        await fsPromises.rm(projectPath, { recursive: true, force: true });
      }
    });

    test("idle compaction inherits reasoning through compact's configured base chain", async () => {
      // Same class as the /compact frontend fix: exec's configured pro must
      // reach backend compaction even with no workspace-level overrides.
      const projectPath = "/tmp/proj";
      const workspaceId = "ws-1";
      const projects = new Map([
        [projectPath, { workspaces: [{ id: workspaceId, path: "/tmp/proj/ws" }] }],
      ]);
      const service = await makeServiceWithConfig({
        findWorkspace: mock(() => ({ projectPath, workspacePath: "/tmp/proj/ws" })),
        loadConfigOrDefault: mock(() => ({
          projects,
          agentAiDefaults: {
            exec: { reasoningMode: "pro" as const },
          },
        })),
      });
      (
        service as unknown as {
          extensionMetadata: { getSnapshot: (id: string) => Promise<undefined> };
        }
      ).extensionMetadata = { getSnapshot: () => Promise.resolve(undefined) };

      const result = await (
        service as unknown as {
          buildIdleCompactionSendOptions(id: string): Promise<{ reasoningMode?: string }>;
        }
      ).buildIdleCompactionSendOptions(workspaceId);
      expect(result.reasoningMode).toBe("pro");
    });

    test("heartbeat reasoning resolves through the selected agent's declared base chain", async () => {
      // Same parity requirement as goal kickoffs: a base: plan custom agent
      // must inherit Plan's configured Pro default, not the Exec fallback.
      const projectPath = await fsPromises.mkdtemp(path.join(tmpdir(), "mux-hb-chain-"));
      try {
        const agentsDir = path.join(projectPath, ".mux", "agents");
        await fsPromises.mkdir(agentsDir, { recursive: true });
        await fsPromises.writeFile(
          path.join(agentsDir, "researcher.md"),
          `---\nname: Researcher\ndescription: Plan-derived custom agent for tests\nbase: plan\nsubagent:\n  runnable: true\n---\n\nTest agent body.\n`,
          "utf-8"
        );

        const workspaceId = "ws-1";
        const projects = new Map([
          [
            projectPath,
            { workspaces: [{ id: workspaceId, path: projectPath, agentId: "researcher" }] },
          ],
        ]);
        const service = await makeServiceWithConfig({
          findWorkspace: mock(() => ({ projectPath, workspacePath: projectPath })),
          loadConfigOrDefault: mock(() => ({
            projects,
            agentAiDefaults: {
              plan: {
                modelString: "openai:gpt-5.6-sol",
                thinkingLevel: "high" as const,
                reasoningMode: "pro" as const,
              },
              exec: {
                modelString: "anthropic:claude-sonnet-4-6",
                thinkingLevel: "low" as const,
                reasoningMode: "standard" as const,
              },
            },
          })),
        });
        (
          service as unknown as {
            extensionMetadata: { getSnapshot: (id: string) => Promise<undefined> };
          }
        ).extensionMetadata = { getSnapshot: () => Promise.resolve(undefined) };
        spyOn(service, "getInfo").mockResolvedValue({
          id: workspaceId,
          name: projectPath,
          projectPath,
          projectName: "hb-chain",
          runtimeConfig: { type: "local" },
        } as FrontendWorkspaceMetadata);

        // Model, thinking, and reasoning must ALL resolve through the chain:
        // inheriting pro beside exec's Anthropic model would gate pro out.
        const result = await (
          service as unknown as {
            buildHeartbeatSendOptions(id: string): Promise<{
              sendOptions: { model: string; thinkingLevel?: string; reasoningMode?: string };
            }>;
          }
        ).buildHeartbeatSendOptions(workspaceId);
        expect(result.sendOptions.model).toBe("openai:gpt-5.6-sol");
        expect(result.sendOptions.thinkingLevel).toBe("high");
        expect(result.sendOptions.reasoningMode).toBe("pro");
      } finally {
        await fsPromises.rm(projectPath, { recursive: true, force: true });
      }
    });

    test("falls through to DEFAULT_MODEL as the final fallback", async () => {
      const projectPath = "/tmp/proj";
      const workspaceId = "ws-1";
      const projects = new Map([
        [projectPath, { workspaces: [{ id: workspaceId, path: "/tmp/proj/ws" }] }],
      ]);
      const service = await makeServiceWithConfig({
        findWorkspace: mock(() => ({ projectPath, workspacePath: "/tmp/proj/ws" })),
        loadConfigOrDefault: mock(() => ({ projects })),
      });
      const result = await service.getGoalContinuationKickoffSendOptions(workspaceId);
      expect(result?.model).toBeTruthy();
      expect(result?.agentId).toBe("exec");
    });

    test("skips invalid candidate strings and tries the next fallback", async () => {
      const projectPath = "/tmp/proj";
      const workspaceId = "ws-1";
      const projects = new Map([
        [
          projectPath,
          {
            workspaces: [
              {
                id: workspaceId,
                path: "/tmp/proj/ws",
                aiSettings: { model: "   ", thinkingLevel: "off" as const }, // whitespace-only -> skipped
              },
            ],
          },
        ],
      ]);
      const service = await makeServiceWithConfig({
        findWorkspace: mock(() => ({ projectPath, workspacePath: "/tmp/proj/ws" })),
        loadConfigOrDefault: mock(() => ({
          projects,
          agentAiDefaults: { exec: { modelString: "openai:gpt-4o" } },
        })),
      });
      const result = await service.getGoalContinuationKickoffSendOptions(workspaceId);
      expect(result?.model).toBe("openai:gpt-4o");
    });
  });
});

describe("WorkspaceService.getLastUserPrompt", () => {
  async function withService(
    seed: (historyService: HistoryService, workspaceId: string) => Promise<void>
  ): Promise<string | null> {
    const { config, historyService, cleanup } = await createTestHistoryService();
    const workspaceId = "last-user-prompt";
    try {
      await seed(historyService, workspaceId);
      const workspaceService = createWorkspaceServiceForTest({ config, historyService });
      const result = await workspaceService.getLastUserPrompt(workspaceId);
      return result?.text ?? null;
    } finally {
      await cleanup();
    }
  }

  test("returns a typed prompt that predates the latest compaction boundary", async () => {
    const prompt = await withService(async (historyService, workspaceId) => {
      await historyService.appendToHistory(
        workspaceId,
        createMuxMessage("u1", "user", "the prompt before compaction", { historySequence: 1 })
      );
      await historyService.appendToHistory(
        workspaceId,
        createMuxMessage("summary", "assistant", "Compacted summary", {
          historySequence: 2,
          compacted: "user",
          compactionBoundary: true,
          compactionEpoch: 1,
        })
      );
    });

    expect(prompt).toBe("the prompt before compaction");
  });

  test("skips synthetic and empty user turns", async () => {
    const prompt = await withService(async (historyService, workspaceId) => {
      await historyService.appendToHistory(
        workspaceId,
        createMuxMessage("u1", "user", "typed by the user", { historySequence: 1 })
      );
      await historyService.appendToHistory(
        workspaceId,
        createMuxMessage("u2", "user", "   ", { historySequence: 2 })
      );
      await historyService.appendToHistory(
        workspaceId,
        createMuxMessage("u3", "user", "injected turn", { historySequence: 3, synthetic: true })
      );
    });

    expect(prompt).toBe("typed by the user");
  });

  test("returns null when the workspace has no typed prompt", async () => {
    const prompt = await withService(async (historyService, workspaceId) => {
      await historyService.appendToHistory(
        workspaceId,
        createMuxMessage("a1", "assistant", "hello", { historySequence: 1 })
      );
    });

    expect(prompt).toBeNull();
  });

  test("prefers the raw slash command over its expanded provider text", async () => {
    const prompt = await withService(async (historyService, workspaceId) => {
      const message = createMuxMessage("u1", "user", "Expanded skill body sent to the model", {
        historySequence: 1,
      });
      await historyService.appendToHistory(workspaceId, {
        ...message,
        metadata: { ...message.metadata, muxMetadata: { rawCommand: "/compact" } },
      } as typeof message);
    });

    expect(prompt).toBe("/compact");
  });

  test("reconstructs a compaction command's follow-up text", async () => {
    const prompt = await withService(async (historyService, workspaceId) => {
      const message = createMuxMessage("u1", "user", "Expanded compaction instructions", {
        historySequence: 1,
      });
      await historyService.appendToHistory(workspaceId, {
        ...message,
        metadata: {
          ...message.metadata,
          muxMetadata: {
            type: "compaction-request",
            rawCommand: "/compact",
            parsed: { followUpContent: { text: "then rerun the failing test" } },
          },
        },
      } as typeof message);
    });

    expect(prompt).toBe("/compact\nthen rerun the failing test");
  });

  test("keeps the bare compaction command when the follow-up is the resume sentinel", async () => {
    const prompt = await withService(async (historyService, workspaceId) => {
      const message = createMuxMessage("u1", "user", "Expanded compaction instructions", {
        historySequence: 1,
      });
      await historyService.appendToHistory(workspaceId, {
        ...message,
        metadata: {
          ...message.metadata,
          muxMetadata: {
            type: "compaction-request",
            rawCommand: "/compact",
            parsed: { followUpContent: { text: "Continue" } },
          },
        },
      } as typeof message);
    });

    expect(prompt).toBe("/compact");
  });

  test("keeps scanning past a staged-attachment notice", async () => {
    const prompt = await withService(async (historyService, workspaceId) => {
      await historyService.appendToHistory(
        workspaceId,
        createMuxMessage("u1", "user", "summarize the attached data", { historySequence: 1 })
      );
      const notice = buildStagedAttachmentNotice([
        {
          kind: "staged",
          id: "csv-1",
          filename: "data.csv",
          mediaType: "text/csv",
          sizeBytes: 34,
          stagedPath: ".mux/user-attachments/id/data.csv",
        },
      ]);
      await historyService.appendToHistory(
        workspaceId,
        createMuxMessage("u2", "user", notice.trimStart(), { historySequence: 2 })
      );
    });

    expect(prompt).toBe("summarize the attached data");
  });

  test("survives a compaction row whose parsed metadata is missing", async () => {
    const prompt = await withService(async (historyService, workspaceId) => {
      const message = createMuxMessage("u1", "user", "Expanded compaction instructions", {
        historySequence: 1,
      });
      await historyService.appendToHistory(workspaceId, {
        ...message,
        metadata: {
          ...message.metadata,
          muxMetadata: { type: "compaction-request", rawCommand: "/compact" },
        },
      } as unknown as typeof message);
    });

    expect(prompt).toBe("/compact");
  });

  test("keeps scanning past a user row with primitive muxMetadata", async () => {
    const prompt = await withService(async (historyService, workspaceId) => {
      await historyService.appendToHistory(
        workspaceId,
        createMuxMessage("u1", "user", "the older valid prompt", { historySequence: 1 })
      );
      const broken = createMuxMessage("u2", "user", "   ", { historySequence: 2 });
      await historyService.appendToHistory(workspaceId, {
        ...broken,
        metadata: { ...broken.metadata, muxMetadata: "corrupted" },
      } as unknown as typeof broken);
    });

    expect(prompt).toBe("the older valid prompt");
  });

  test("keeps scanning past a user row with malformed parts", async () => {
    const prompt = await withService(async (historyService, workspaceId) => {
      await historyService.appendToHistory(
        workspaceId,
        createMuxMessage("u1", "user", "the older valid prompt", { historySequence: 1 })
      );
      const broken = createMuxMessage("u2", "user", "ignored", { historySequence: 2 });
      await historyService.appendToHistory(workspaceId, {
        ...broken,
        parts: undefined,
      } as unknown as typeof broken);
    });

    expect(prompt).toBe("the older valid prompt");
  });

  test("returns the newest prompt when several share one reverse-read chunk", async () => {
    const prompt = await withService(async (historyService, workspaceId) => {
      for (const [index, text] of ["oldest prompt", "middle prompt", "newest prompt"].entries()) {
        await historyService.appendToHistory(
          workspaceId,
          createMuxMessage(`u${index}`, "user", text, { historySequence: index + 1 })
        );
      }
    });

    expect(prompt).toBe("newest prompt");
  });
});

describe("WorkspaceService.remove usage-rollup ordering", () => {
  test("usage recorded while draining background producers reaches the parent rollup", async () => {
    // Codex round 13: the child's usage snapshot was read BEFORE the
    // cancel-and-drain calls for the pending branch summary and in-flight
    // /refine pass. A draining producer records headless usage as it
    // settles, so that spend landed after the snapshot and was permanently
    // lost from parent accounting (the child is deleted with no second
    // rollup). Drains must complete before the snapshot is read.
    const { config, historyService, cleanup } = await createTestHistoryService();
    const projectDir = await fsPromises.mkdtemp(path.join(tmpdir(), "mux-rollup-"));
    const parentId = "rollup-parent-ws";
    const childId = "rollup-child-ws";
    try {
      await config.editConfig((cfg) => {
        cfg.projects.set(projectDir, {
          trusted: true,
          workspaces: [
            { path: projectDir, id: parentId, name: parentId },
            { path: projectDir, id: childId, name: childId, parentWorkspaceId: parentId },
          ],
        });
        return cfg;
      });

      // Fake usage ledger: the draining refine pass records the child's
      // spend only when cancelInFlightRefinePass runs (modelling a settle-
      // time recordHeadlessUsage write).
      const usageByWorkspace = new Map<string, Record<string, unknown>>();
      const rollupCalls: Array<{ parent: string; child: string; byModel: object }> = [];
      const sessionUsageService = {
        getSessionUsage: (workspaceId: string) =>
          Promise.resolve({ byModel: usageByWorkspace.get(workspaceId) ?? {} }),
        rollUpUsageIntoParent: (parent: string, child: string, byModel: object) => {
          rollupCalls.push({ parent, child, byModel });
          return Promise.resolve({ didRollUp: true });
        },
      } as unknown as SessionUsageService;
      const cancelInFlightRefinePass = mock((workspaceId: string) => {
        // The drained pass settles and records its spend against the child.
        usageByWorkspace.set(workspaceId, {
          "anthropic:claude-sonnet-4-5": { input: { tokens: 42, cost_usd: 0.01 } },
        });
        return Promise.resolve();
      });

      const service = createWorkspaceServiceForTest({
        config,
        historyService,
        sessionUsageService,
        aiService: createMockAIService({
          getWorkspaceMetadata: (async (workspaceId: string) => {
            const metadata = (await config.getAllWorkspaceMetadata()).find(
              (m) => m.id === workspaceId
            );
            return metadata ? Ok(metadata) : Err("workspace not found");
          }) as AIService["getWorkspaceMetadata"],
        }),
      });
      service.setRefinePassCanceller({ cancelInFlightRefinePass });

      const result = await service.remove(childId);
      expect(result.success).toBe(true);
      expect(cancelInFlightRefinePass).toHaveBeenCalled();

      // The drain-recorded spend made it into the parent rollup snapshot.
      expect(rollupCalls).toHaveLength(1);
      expect(rollupCalls[0].parent).toBe(parentId);
      expect(rollupCalls[0].child).toBe(childId);
      expect(Object.keys(rollupCalls[0].byModel)).toContain("anthropic:claude-sonnet-4-5");
    } finally {
      await fsPromises.rm(projectDir, { recursive: true, force: true });
      await cleanup();
    }
  });

  test("a failed non-forced deletion defers the one-shot rollups until removal commits", async () => {
    // rollUpUsageIntoParent / rollUpTimingIntoParent record the child in the
    // one-shot rolledUpFrom guard. Rolling up BEFORE runtime deletion meant a
    // force=false deletion failure left the child usable, and the eventual
    // successful removal skipped the rollup — permanently losing the child's
    // post-failure spend from parent accounting. Rollups must run only after
    // deletion can no longer fail, so a failed attempt rolls up nothing and
    // the retry captures the child's full (including post-failure) usage.
    const { config, historyService, cleanup } = await createTestHistoryService();
    const projectDir = await fsPromises.mkdtemp(path.join(tmpdir(), "mux-rollup-retry-"));
    const parentId = "rollup-retry-parent-ws";
    const childId = "rollup-retry-child-ws";
    let deletionFails = true;
    const deleteWorkspaceMock = mock(() =>
      deletionFails
        ? Promise.resolve({ success: false as const, error: "worktree has uncommitted changes" })
        : Promise.resolve({ success: true as const, deletedPath: projectDir })
    );
    const createRuntimeSpy = spyOn(runtimeFactory, "createRuntime").mockReturnValue({
      deleteWorkspace: deleteWorkspaceMock,
    } as unknown as ReturnType<typeof runtimeFactory.createRuntime>);
    try {
      await config.editConfig((cfg) => {
        cfg.projects.set(projectDir, {
          trusted: true,
          workspaces: [
            { path: projectDir, id: parentId, name: parentId },
            { path: projectDir, id: childId, name: childId, parentWorkspaceId: parentId },
          ],
        });
        return cfg;
      });

      const childUsage: Record<string, unknown> = {
        "anthropic:claude-sonnet-4-5": { input: { tokens: 42, cost_usd: 0.01 } },
      };
      const usageRollups: Array<{ parent: string; child: string; byModel: object }> = [];
      const sessionUsageService = {
        getSessionUsage: () => Promise.resolve({ byModel: { ...childUsage } }),
        rollUpUsageIntoParent: (parent: string, child: string, byModel: object) => {
          usageRollups.push({ parent, child, byModel });
          return Promise.resolve({ didRollUp: true });
        },
      } as unknown as SessionUsageService;
      const timingRollups: string[] = [];
      const sessionTimingService = {
        waitForIdle: () => Promise.resolve(),
        rollUpTimingIntoParent: (_parent: string, child: string) => {
          timingRollups.push(child);
          return Promise.resolve();
        },
      } as unknown as SessionTimingService;

      const service = createWorkspaceServiceForTest({
        config,
        historyService,
        sessionUsageService,
        sessionTimingService,
        aiService: createMockAIService({
          getWorkspaceMetadata: (async (workspaceId: string) => {
            const metadata = (await config.getAllWorkspaceMetadata()).find(
              (m) => m.id === workspaceId
            );
            return metadata ? Ok(metadata) : Err("workspace not found");
          }) as AIService["getWorkspaceMetadata"],
        }),
      });

      // Non-forced removal fails at runtime deletion: the child stays usable,
      // so neither one-shot rollup may have been consumed.
      const failedAttempt = await service.remove(childId);
      expect(failedAttempt.success).toBe(false);
      expect(deleteWorkspaceMock).toHaveBeenCalledTimes(1);
      expect(usageRollups).toHaveLength(0);
      expect(timingRollups).toHaveLength(0);

      // The still-usable child accrues more spend before the retry.
      childUsage["openai:gpt-5.2"] = { input: { tokens: 7, cost_usd: 0.002 } };

      deletionFails = false;
      const retry = await service.remove(childId);
      expect(retry.success).toBe(true);

      // The retry rolls up exactly once, with the full post-failure snapshot.
      expect(timingRollups).toEqual([childId]);
      expect(usageRollups).toHaveLength(1);
      expect(usageRollups[0].parent).toBe(parentId);
      expect(usageRollups[0].child).toBe(childId);
      expect(Object.keys(usageRollups[0].byModel)).toEqual([
        "anthropic:claude-sonnet-4-5",
        "openai:gpt-5.2",
      ]);
    } finally {
      createRuntimeSpy.mockRestore();
      await fsPromises.rm(projectDir, { recursive: true, force: true });
      await cleanup();
    }
  });
});

describe("WorkspaceService.remove checkout-deletion ordering", () => {
  test("an admitted apply's checkout write completes before removal deletes the workdir", async () => {
    // Codex round 15: the refine drain ran AFTER runtime/workdir deletion, so
    // an admitted /refine apply's agent_skill_write could race checkout
    // deletion — recreating .mux/skills inside the deleted tree (orphaned
    // state) or failing midway with the failure swallowed. The drain must
    // complete before any disk mutation.
    const { config, historyService, cleanup } = await createTestHistoryService();
    const scratchId = "scratch-apply-race";
    const scratchDir = path.join(config.rootDir, "scratch", scratchId);
    try {
      await fsPromises.mkdir(scratchDir, { recursive: true });
      await config.editConfig((cfg) => {
        cfg.projects.set(SCRATCH_PROJECT_CONFIG_KEY, {
          workspaces: [{ path: scratchDir, id: scratchId, name: scratchId, kind: "scratch" }],
        });
        return cfg;
      });
      const scratchMetadata: WorkspaceMetadata = {
        id: scratchId,
        name: scratchId,
        projectName: "scratch",
        projectPath: scratchDir,
        runtimeConfig: { type: "local" },
        kind: "scratch",
      };
      // Models the admitted apply completing during the drain: it writes a
      // project skill into the CHECKOUT as it settles. Only the FIRST drain
      // has an in-flight pass (matching the real idempotent canceller — later
      // calls find nothing to drain and no-op).
      let drained = false;
      const cancelInFlightRefinePass = mock(async () => {
        if (drained) return;
        drained = true;
        await fsPromises.mkdir(path.join(scratchDir, ".mux", "skills", "lesson"), {
          recursive: true,
        });
        await fsPromises.writeFile(
          path.join(scratchDir, ".mux", "skills", "lesson", "SKILL.md"),
          "distilled\n"
        );
      });
      const service = createWorkspaceServiceForTest({
        config,
        historyService,
        aiService: createMockAIService({
          getWorkspaceMetadata: (() =>
            Promise.resolve(Ok(scratchMetadata))) as AIService["getWorkspaceMetadata"],
        }),
      });
      service.setRefinePassCanceller({ cancelInFlightRefinePass });

      const result = await service.remove(scratchId);
      expect(result.success).toBe(true);
      expect(cancelInFlightRefinePass).toHaveBeenCalled();

      // The drain's checkout write happened BEFORE workdir deletion, so the
      // removal deleted everything — no recreated .mux/skills orphan.
      const workdirExists = await fsPromises.access(scratchDir).then(
        () => true,
        () => false
      );
      expect(workdirExists).toBe(false);
    } finally {
      await fsPromises.rm(scratchDir, { recursive: true, force: true });
      await cleanup();
    }
  });
});

describe("WorkspaceService.fork branch-summary rollback ordering", () => {
  test("a fork whose setup fails never leaves a summary writer or registration behind", async () => {
    // Codex round-11: the background summary writer used to start BEFORE
    // staged-attachment copying and usage reset. Their failure handler
    // deletes newSessionDir without cancelling the registration, so a racing
    // guarded append (tail verified pre-rollback, append landing after)
    // recreated the failed fork's session dir, and the settled entry leaked
    // forever because the fork never returned. The writer now starts only
    // after all failure-prone setup completed.
    const { config, historyService, cleanup } = await createTestHistoryService();
    const projectDir = await fsPromises.mkdtemp(path.join(tmpdir(), "mux-fork-src-"));
    const sourceId = "fork-src-ws";
    // Gate the guarded append so the writer (old ordering) is mid-append when
    // the rollback deletes the session dir — Codex's exact race window.
    let releaseAppend: () => void = () => undefined;
    const appendGate = new Promise<void>((resolve) => {
      releaseAppend = resolve;
    });
    const realGuardedAppend = historyService.appendToHistoryIfTailMatches.bind(historyService);
    const guardedAppendSpy = spyOn(
      historyService,
      "appendToHistoryIfTailMatches"
    ).mockImplementation(async (workspaceId, message, tailMessageId) => {
      await appendGate;
      // Model the lost race deterministically: the tail was verified before
      // the rollback, so the append itself lands unconditionally.
      void tailMessageId;
      const result = await historyService.appendToHistory(workspaceId, message);
      return result.success ? Ok("appended" as const) : result;
    });
    try {
      await config.editConfig((cfg) => {
        cfg.projects.set(projectDir, {
          trusted: true,
          workspaces: [{ path: projectDir, id: sourceId, name: sourceId }],
        });
        return cfg;
      });
      // Meaty abandoned tail (clears BRANCH_SUMMARY_MIN_SEGMENT_TOKENS).
      const filler = "explored the fork rollback race and traced the write path ".repeat(200);
      const branchPoint = createMuxMessage("fork-bp", "assistant", "branch point", {
        timestamp: 1,
      });
      for (const message of [
        createMuxMessage("fork-m1", "user", "original question", { timestamp: 0 }),
        branchPoint,
        createMuxMessage("fork-tail-u", "user", filler, { timestamp: 2 }),
        createMuxMessage("fork-tail-a", "assistant", filler, { timestamp: 3 }),
      ]) {
        expect((await historyService.appendToHistory(sourceId, message)).success).toBe(true);
      }

      const sourceMetadata: WorkspaceMetadata = {
        id: sourceId,
        name: sourceId,
        projectName: "fork-src",
        projectPath: projectDir,
        runtimeConfig: { type: "local" },
      };
      const summaryChunks: LanguageModelV3StreamPart[] = [
        { type: "text-start", id: "t1" },
        { type: "text-delta", id: "t1", delta: "The abandoned branch explored a race." },
        { type: "text-end", id: "t1" },
        {
          type: "finish",
          finishReason: { unified: "stop", raw: "stop" },
          usage: {
            inputTokens: { total: 1, noCache: 1, cacheRead: 0, cacheWrite: 0 },
            outputTokens: { total: 1, text: 1, reasoning: 0 },
          },
        },
      ];
      const aiService = {
        ...createStreamLifecycleMocks(),
        on: mock(() => undefined),
        off: mock(() => undefined),
        isStreaming: mock(() => false),
        getWorkspaceMetadata: mock((workspaceId: string) =>
          Promise.resolve(
            workspaceId === sourceId ? Ok(sourceMetadata) : Err("workspace not found")
          )
        ),
        createModelWithPinnedMetadata: mock((modelString: string) =>
          Promise.resolve(
            Ok({
              model: new MockLanguageModelV3({
                doStream: () =>
                  Promise.resolve({ stream: simulateReadableStream({ chunks: summaryChunks }) }),
              }),
              metadataModel: modelString,
            })
          )
        ),
      } as unknown as AIService;
      const initStateManager = {
        on: mock(() => undefined),
        off: mock(() => undefined),
        getInitState: mock(() => undefined),
        startInit: mock(() => undefined),
        appendOutput: mock(() => undefined),
        endInit: mock(() => Promise.resolve()),
        enterHookPhase: mock(() => undefined),
        clearInMemoryState: mock(() => undefined),
      } as unknown as InitStateManager;
      // Failure injection: the usage reset (the LAST failure-prone setup
      // step) rejects, driving the fork into its rollback path.
      const sessionUsageService = {
        resetSessionUsage: mock(() => Promise.reject(new Error("usage reset failed"))),
        recordHeadlessUsage: mock(() => Promise.resolve(undefined)),
      } as unknown as SessionUsageService;
      const experimentsService = {
        isExperimentEnabled: (id: string) =>
          id === EXPERIMENT_IDS.RLM || id === EXPERIMENT_IDS.PROGRAMMATIC_TOOL_CALLING,
      } as unknown as ExperimentsService;

      const service = createWorkspaceServiceForTest({
        config,
        historyService,
        aiService,
        initStateManager,
        sessionUsageService,
        experimentsService,
      });
      let newWorkspaceId = "";
      const realGenerateId = config.generateStableId.bind(config);
      const idSpy = spyOn(config, "generateStableId").mockImplementation(() => {
        newWorkspaceId = realGenerateId();
        return newWorkspaceId;
      });
      try {
        const forkResult = await service.fork(sourceId, "fork-rollback-target", "fork-bp");
        expect(forkResult.success).toBe(false);
        if (forkResult.success) return;
        expect(forkResult.error).toContain("Failed to copy fork state");
        expect(newWorkspaceId.length).toBeGreaterThan(0);

        // Unblock any (old-ordering) writer mid-append and let it settle.
        releaseAppend();
        await new Promise((resolve) => setTimeout(resolve, 50));

        // No writer ran, so no registration leaked and the rolled-back
        // session's chat.jsonl was not recreated by a late guarded append.
        expect(await awaitPendingBranchSummary(newWorkspaceId)).toBeNull();
        expect(guardedAppendSpy).not.toHaveBeenCalled();
        const chatFile = path.join(config.sessionsDir, newWorkspaceId, "chat.jsonl");
        const chatExists = await fsPromises.access(chatFile).then(
          () => true,
          () => false
        );
        expect(chatExists).toBe(false);
      } finally {
        idSpy.mockRestore();
      }
    } finally {
      guardedAppendSpy.mockRestore();
      void realGuardedAppend;
      await fsPromises.rm(projectDir, { recursive: true, force: true });
      await cleanup();
    }
  });
});

describe("WorkspaceService phantom removal probes", () => {
  test("skips teardown only on PROVEN absence; an unreadable probe aborts the removal", async () => {
    const { config, historyService, cleanup } = await createTestHistoryService();
    const service = createWorkspaceServiceForTest({
      config,
      historyService,
      aiService: createMockAIService({
        getWorkspaceMetadata: mock(() => Promise.resolve(Err("not found"))),
      }),
    });
    const workspaceId = "phantom-probe";
    const sessionDir = path.join(config.sessionsDir, workspaceId);
    try {
      // No config.json and no session dir: nothing to tear down (idempotent).
      expect((await service.remove(workspaceId, true)).success).toBe(true);
      // (Deregistration wrote config.json; take it away again so the probe
      // pair is exercised.) The session dir probe now fails for a reason
      // other than absence: the removal must not deregister on a guess —
      // abort, retryable.
      await fsPromises.rm(path.join(config.rootDir, "config.json"), { force: true });
      const realStat = fsPromises.stat.bind(fsPromises);
      const unreadable = spyOn(fsPromises, "stat").mockImplementation(((
        target: Parameters<typeof fsPromises.stat>[0],
        ...rest: unknown[]
      ) =>
        String(target) === sessionDir
          ? Promise.reject(Object.assign(new Error("EACCES"), { code: "EACCES" }))
          : (realStat as (...args: unknown[]) => unknown)(target, ...rest)) as never);
      try {
        const aborted = await service.remove(workspaceId, true);
        expect(aborted.success).toBe(false);
        expect(aborted.success ? "" : aborted.error).toContain("removal aborted");
      } finally {
        unreadable.mockRestore();
      }
    } finally {
      await cleanup();
    }
  });
});

describe("WorkspaceService disposal ownership", () => {
  test.each([false, true])(
    "leased cleanup removes real session files without a task-tree self-join (external=%s)",
    async (externalRemoval) => {
      const h = await createAgentSessionHarness({ workspaceId: "leased-removal" });
      const workspaceId = "leased-removal";
      // Removal requires an EXISTING config.json (an absent one reads as
      // mid-rewrite, not as a fresh install); this workspace is simply not
      // registered in it, exercising the phantom (metadata-less) path.
      await h.config.editConfig((cfg) => cfg);
      const service = createWorkspaceServiceForTest({
        config: h.config,
        historyService: h.historyService,
        extensionMetadata: new ExtensionMetadataService(
          path.join(h.config.rootDir, "extensionMetadata.json")
        ),
        aiService: createMockAIService({
          getWorkspaceMetadata: mock(() => Promise.resolve(Err("not found"))),
        }),
      });
      const tree = new MutexMap<string>();
      service.setAgentTaskIntegration(
        makeAgentTaskIntegrationFake({
          withTaskTreeLifecycleLock: (_id, run) => tree.withLock("tree", run),
        })
      );
      service.registerSession(workspaceId, h.session);
      await h.historyService.appendToHistory(
        workspaceId,
        createMuxMessage("user", "user", "remove after callback")
      );
      const sessionDir = path.join(h.config.sessionsDir, workspaceId);
      const { coordinator } = h.session as unknown as { coordinator: TurnCoordinator };
      const lease = coordinator.enterExecution();
      const disposalEntered = Promise.withResolvers<void>();
      const originalDispose = h.session.dispose.bind(h.session);
      spyOn(h.session, "dispose").mockImplementation(() => {
        disposalEntered.resolve();
        return originalDispose();
      });
      const removed = Promise.withResolvers<Result<void>>();
      let external: Promise<Result<void>> | undefined;
      try {
        if (externalRemoval) {
          external = service.remove(workspaceId, true);
          await disposalEntered.promise;
          expect(existsSync(sessionDir)).toBe(true);
        }
        // This is the leased continuation callback's tail: schedule removal without
        // awaiting it, then return/release. The service owns the actual remove and join.
        service.deferWorkspaceCleanup(async () => {
          removed.resolve(await service.remove(workspaceId, true));
        });
        lease[Symbol.dispose]();
        if (external) expect((await external).success).toBe(true);
        expect((await removed.promise).success).toBe(true);
        expect(existsSync(sessionDir)).toBe(false);
      } finally {
        lease[Symbol.dispose]();
        await external;
        await h.session.dispose();
        await h.cleanup();
      }
    }
  );

  test.each(["workspace-busy", "queue-busy", "queue-only"] as const)(
    "shutdown cancels %s wait without pretending the physical lease drained",
    async (kind) => {
      const h = await createAgentSessionHarness({ workspaceId: "closing-idle-wait" });
      const service = createWorkspaceServiceForTest({
        config: h.config,
        historyService: h.historyService,
      });
      service.registerSession("closing-idle-wait", h.session);
      const { coordinator } = h.session as unknown as { coordinator: TurnCoordinator };
      const lease = coordinator.enterExecution();
      if (kind === "queue-only") h.session.queueMessage("pending");
      else {
        const admitted = coordinator.prepare({
          kind: "fresh",
          intent: "handoff",
          expectedTurnId: coordinator.turnId,
        });
        expect(admitted.status).toBe("admitted");
      }
      const waiting = (
        kind === "workspace-busy"
          ? service.waitForWorkspaceIdle("closing-idle-wait")
          : service.waitForIdleAndNoQueuedMessages("closing-idle-wait")
      ).then(
        () => undefined,
        (error: unknown) => error
      );
      h.session.beginShutdown();
      let drained = false;
      const drain = coordinator.drain().then(() => {
        drained = true;
      });
      try {
        expect(await waiting).toBeInstanceOf(Error);
        expect(drained).toBe(false);
        if (kind !== "queue-only") expect(coordinator.phase).toBe("preparing");
      } finally {
        lease[Symbol.dispose]();
        await drain;
        await service.disposeSession("closing-idle-wait");
        await h.cleanup();
      }
    }
  );

  test("an old disposal cannot remove replacement session subscriptions", async () => {
    const h = await createAgentSessionHarness({ workspaceId: "dispose-replacement" });
    const replacement = await createAgentSessionHarness({ workspaceId: "dispose-replacement" });
    const service = createWorkspaceServiceForTest({
      config: h.config,
      historyService: h.historyService,
    });
    service.registerSession("dispose-replacement", h.session);
    const internals = service as unknown as {
      sessions: Map<string, AgentSession>;
      sessionSubscriptions: Map<string, { chat: () => void; metadata: () => void }>;
    };
    const { coordinator } = h.session as unknown as { coordinator: TurnCoordinator };
    const lease = coordinator.enterExecution();
    const disposal = service.disposeSession("dispose-replacement");
    try {
      internals.sessions.delete("dispose-replacement");
      service.registerSession("dispose-replacement", replacement.session);
      const subscriptions = internals.sessionSubscriptions.get("dispose-replacement");
      lease[Symbol.dispose]();
      await disposal;
      expect(internals.sessions.get("dispose-replacement")).toBe(replacement.session);
      expect(internals.sessionSubscriptions.get("dispose-replacement")).toBe(subscriptions);
    } finally {
      lease[Symbol.dispose]();
      await disposal;
      await service.disposeSession("dispose-replacement");
      await h.cleanup();
      await replacement.cleanup();
    }
  });
});

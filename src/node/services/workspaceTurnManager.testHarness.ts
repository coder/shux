import * as path from "path";
import type { Config, Workspace as WorkspaceConfigEntry } from "@/node/config";
import type { AIService } from "@/node/services/aiService";
import { HistoryService } from "@/node/services/historyService";
import type { InitStateManager } from "@/node/services/initStateManager";
import { ForegroundWaitBackgroundedError } from "@/node/services/taskService";
import { TerminalAttentionStore } from "@/node/services/terminalAttentionStore";
import { WorkspaceTurnManager } from "@/node/services/workspaceTurnManager";
import { WorkflowRunStore } from "@/node/services/workflows/WorkflowRunStore";
import { MutexMap } from "@/node/utils/concurrency/mutexMap";
import type {
  BackgroundableForegroundWaiter,
  WorkspaceHost,
  WorkspaceTurnManagerHost,
} from "@/node/services/taskWorkspaceSeam";
import {
  createAIServiceMocks,
  createMockInitStateManager,
  createWorkspaceServiceMocks,
} from "@/node/services/taskService.testHarness";

type WorkspaceTurnManagerHostFake = WorkspaceTurnManagerHost & {
  backgroundForegroundWaitsForWorkspace(workspaceId: string): number;
};

function createWorkspaceTurnManagerHost(
  config: Config,
  workspaceService: WorkspaceHost,
  aiService: AIService,
  terminalAttentionStore: TerminalAttentionStore
): WorkspaceTurnManagerHostFake {
  const lifecycleLocks = new MutexMap<string>();
  const foregroundWaiters = new Map<string, Set<BackgroundableForegroundWaiter>>();
  const foregroundAwaitCounts = new Map<string, number>();
  const agentTasks = (cfg: ReturnType<Config["loadConfigOrDefault"]>) =>
    Array.from(cfg.projects.values())
      .flatMap((project) => project.workspaces)
      .filter((workspace) => workspace.id != null && workspace.parentWorkspaceId != null);
  const isActiveAgentTask = (workspace: WorkspaceConfigEntry) => {
    if (
      workspace.archivedAt != null &&
      (workspace.unarchivedAt == null || workspace.unarchivedAt < workspace.archivedAt)
    ) {
      return workspace.id != null && aiService.isStreaming(workspace.id);
    }
    return (
      ["starting", "running", "awaiting_report"].includes(workspace.taskStatus ?? "running") ||
      ["starting", "running"].includes(workspace.taskExecutionStatus ?? "")
    );
  };
  const isDescendant = (
    cfg: ReturnType<Config["loadConfigOrDefault"]>,
    ancestorWorkspaceId: string,
    taskId: string
  ) => {
    const parents = new Map(
      agentTasks(cfg).map((workspace) => [workspace.id, workspace.parentWorkspaceId])
    );
    let current: string | undefined = taskId;
    for (let depth = 0; depth < 32 && current != null; depth++) {
      current = parents.get(current);
      if (current === ancestorWorkspaceId) return true;
    }
    return false;
  };
  const backgroundForegroundWaitsForWorkspace = (workspaceId: string) => {
    let signaled = 0;
    for (const waiter of foregroundWaiters.get(workspaceId) ?? []) {
      waiter.cleanup();
      waiter.reject(new ForegroundWaitBackgroundedError());
      signaled += 1;
    }
    return signaled;
  };
  return {
    acquireTaskCreationLock: () =>
      Promise.resolve({
        [Symbol.asyncDispose]: () => Promise.resolve(),
      }),
    backgroundForegroundWaitIfQueued: (enabled, workspaceId) => {
      if (
        !enabled ||
        workspaceId == null ||
        !workspaceService.hasQueuedMessages(workspaceId, "tool-end")
      )
        return;
      backgroundForegroundWaitsForWorkspace(workspaceId);
    },
    backgroundForegroundWaitsForWorkspace,
    buildParentAiSettingsFallbacks: (parent, targetAgentId) =>
      [
        parent.aiSettingsByAgent?.[targetAgentId],
        parent.agentId == null ? undefined : parent.aiSettingsByAgent?.[parent.agentId],
        parent.aiSettings,
      ].filter((settings) => settings != null),
    bumpWorkspaceStopEpoch: () => undefined,
    countActiveAgentTasks: (cfg) =>
      agentTasks(cfg).filter(
        (workspace) =>
          isActiveAgentTask(workspace) &&
          workspace.id != null &&
          !foregroundAwaitCounts.has(workspace.id) &&
          !(
            workspace.taskExecutionId?.startsWith("wst_") === true &&
            ["starting", "running"].includes(workspace.taskExecutionStatus ?? "")
          )
      ).length,
    editWorkspaceEntry: async (workspaceId, updater, options) => {
      let found = false;
      await config.editConfig((cfg) => {
        for (const project of cfg.projects.values()) {
          const workspace = project.workspaces.find((candidate) => candidate.id === workspaceId);
          if (workspace != null) {
            updater(workspace, cfg);
            found = true;
            break;
          }
        }
        return cfg;
      });
      if (!found && options?.allowMissing !== true)
        throw new Error("Workspace not found: " + workspaceId);
      return found;
    },
    emitWorkspaceMetadata: () => Promise.resolve(),
    enqueueTerminalAttention: async (params) => {
      await terminalAttentionStore.enqueueIfAbsent(params);
    },
    hasActiveDescendantAgentTasks: (cfg, workspaceId) =>
      agentTasks(cfg).some(
        (workspace) =>
          workspace.id != null &&
          isActiveAgentTask(workspace) &&
          isDescendant(cfg, workspaceId, workspace.id)
      ),
    isDescendantAgentTaskInConfig: isDescendant,
    isForegroundAwaiting: (workspaceId) => foregroundAwaitCounts.has(workspaceId),
    latchWorkspaceStopsInProgress: () => () => undefined,
    listActiveBackgroundWorkflowRunIds: async (workspaceId, referencedRunIds) => {
      if (referencedRunIds.length === 0) return [];
      const runs = await new WorkflowRunStore({
        sessionDir: path.join(config.sessionsDir, workspaceId),
      }).listRuns();
      return runs
        .filter(
          (run) =>
            referencedRunIds.includes(run.id) &&
            run.workspaceId === workspaceId &&
            ["pending", "running", "backgrounded"].includes(run.status)
        )
        .map((run) => run.id);
    },
    listActiveWorkflowRunIdsForWorkspaceStrict: async (workspaceId) => {
      const runStore = new WorkflowRunStore({
        sessionDir: path.join(config.sessionsDir, workspaceId),
      });
      const runs = await runStore.listRunsForActivityScan();
      return runs
        .filter(
          (run) =>
            run.workspaceId === workspaceId &&
            run.parentWorkflow == null &&
            ["pending", "running", "backgrounded"].includes(run.status)
        )
        .map((run) => run.id);
    },
    listAgentReferencedWorkflowRunIds: () => Promise.resolve([]),
    listAgentTaskExecutionEntries: agentTasks,
    markTaskForegroundRelevant: () => undefined,
    maybeStartPatchGenerationForReportedTask: () => Promise.resolve(),
    registerBackgroundableForegroundWaiter: (workspaceId, waiter) => {
      const waiters = foregroundWaiters.get(workspaceId) ?? new Set();
      waiters.add(waiter);
      foregroundWaiters.set(workspaceId, waiters);
    },
    releaseRetainedStopLatches: () => undefined,
    resolveWorkspaceAISettings: (workspace, agentId) =>
      (agentId != null ? workspace.aiSettingsByAgent?.[agentId] : undefined) ??
      workspace.aiSettings,
    scheduleMaybeStartQueuedTasks: () => undefined,
    scheduleTerminalAttentionDrain: () => undefined,
    startForegroundAwait: (workspaceId) => {
      foregroundAwaitCounts.set(workspaceId, (foregroundAwaitCounts.get(workspaceId) ?? 0) + 1);
      return () => {
        const count = foregroundAwaitCounts.get(workspaceId) ?? 0;
        if (count <= 1) foregroundAwaitCounts.delete(workspaceId);
        else foregroundAwaitCounts.set(workspaceId, count - 1);
      };
    },
    unregisterBackgroundableForegroundWaiter: (workspaceId, waiter) => {
      const waiters = foregroundWaiters.get(workspaceId);
      waiters?.delete(waiter);
      if (waiters?.size === 0) foregroundWaiters.delete(workspaceId);
    },
    withTaskTreeLifecycleLock: (workspaceId, operation) =>
      lifecycleLocks.withLock(workspaceId, operation),
  };
}

export function createWorkspaceTurnManagerHarness(
  config: Config,
  overrides?: {
    historyService?: HistoryService;
    aiService?: AIService;
    workspaceService?: WorkspaceHost;
    initStateManager?: InitStateManager;
  }
): {
  historyService: HistoryService;
  taskService: WorkspaceTurnManager;
  taskHost: WorkspaceTurnManagerHostFake;
  aiService: AIService;
  workspaceService: WorkspaceHost;
  initStateManager: InitStateManager;
} {
  const historyService = overrides?.historyService ?? new HistoryService(config);
  const aiService = overrides?.aiService ?? createAIServiceMocks(config).aiService;
  const workspaceService =
    overrides?.workspaceService ?? createWorkspaceServiceMocks().workspaceService;
  const initStateManager = overrides?.initStateManager ?? createMockInitStateManager();
  const terminalAttentionStore = new TerminalAttentionStore(config);
  const taskHost = createWorkspaceTurnManagerHost(
    config,
    workspaceService,
    aiService,
    terminalAttentionStore
  );
  const taskService = new WorkspaceTurnManager(
    config,
    historyService,
    aiService,
    workspaceService,
    initStateManager,
    taskHost,
    terminalAttentionStore
  );

  return {
    historyService,
    taskService,
    taskHost,
    aiService,
    workspaceService,
    initStateManager,
  };
}

import { Err, Ok } from "@/common/types/result";
import type { AgentTaskIntegration, WorkspaceHost } from "@/node/services/taskWorkspaceSeam";

export function makeWorkspaceHostFake(overrides: Partial<WorkspaceHost> = {}): WorkspaceHost {
  return {
    deferWorkspaceCleanup: (run) => {
      run().catch(() => undefined);
    },
    sendMessage: () => Promise.resolve(Ok(undefined)),
    resumeStream: () => Promise.resolve(Ok({ started: true })),
    clearQueue: () => Ok(undefined),
    replaceHistory: () => Promise.resolve(Ok(undefined)),
    waitForIdleAndNoQueuedMessages: () => Promise.resolve(),
    waitForPendingCompactionCompletionDecision: () => Promise.resolve(true),
    waitForPendingStreamErrorRecoveryDecision: () => Promise.resolve(undefined),
    isBusyForMessage: () => false,
    hasQueuedMessages: () => false,
    hasPendingQueuedOrPreparingTurn: () => false,
    hasPendingAutoRetry: () => false,
    hasPendingBashMonitorWakeContinuation: () => false,
    hasPendingWorkspaceTurnContinuation: () => false,
    hasQueuedWorkspaceTurn: () => false,
    removeQueuedWorkspaceTurn: () => Ok(true),
    removeQueuedMessagesByDedupeKeyPrefix: () => Ok(0),
    getQueueCutCutter: () => undefined,
    countQueuedAgentPeerMessages: () => 0,
    archive: () => Promise.resolve(Ok({ kind: "archived" })),
    archiveWhileTaskTreeLocked: () => Promise.resolve(Ok({ kind: "archived" })),
    unarchiveWhileTaskTreeLocked: () => Promise.resolve(Ok(undefined)),
    preflightArchive: () => Promise.resolve(Ok({ kind: "ready" })),
    // No live activity grants the hold so task tests reach interruption behavior.
    acquirePreInterruptionArchiveHold: () => Ok({ [Symbol.dispose]: () => undefined }),
    listLiveWorkspaceActivity: () => ({
      streaming: false,
      queuedMessages: false,
      backgroundBashProcesses: false,
      terminalSessions: false,
      desktopSession: false,
    }),
    hasRunningBackgroundBashProcesses: () => Promise.resolve(false),
    hasUntrackableExternalAppOpen: () => Promise.resolve(false),
    // Keep-style behavior makes archive eligibility independent of untracked files.
    isSnapshotArchiveEligibilityMutationSensitive: () => false,
    remove: () => Promise.resolve(Ok(undefined)),
    removeWhileTaskTreeLocked: () => Promise.resolve(Ok(undefined)),
    create: () => Promise.resolve(Err("workspaceHost.create not mocked")),
    // Task-create tests exercise launch flow, not plugin-override sanitization.
    sanitizeMaterializedTaskWorkspace: () => Promise.resolve(undefined),
    discardExtensionMetadataEntry: () => Promise.resolve(),
    registerExternalBackgroundInit: () => undefined,
    getInfo: () => Promise.resolve(null),
    updateTitle: () => Promise.resolve(Ok(undefined)),
    emit: () => true,
    emitChatEvent: () => undefined,
    isExperimentEnabled: () => false,
    isWorkflowInvocationCurrent: () => Promise.resolve(true),
    getWorkflowInvocationCurrentness: () => Promise.resolve("current" as const),
    getWorkflowInvocationBoundaryMessageId: () => Promise.resolve(null),
    ...overrides,
  };
}

export function makeAgentTaskIntegrationFake(
  overrides: Partial<AgentTaskIntegration> = {}
): AgentTaskIntegration {
  return {
    withTaskTreeLifecycleLock: <T>(_workspaceId: string, operation: () => Promise<T>): Promise<T> =>
      operation(),
    hasDescendantAgentTasks: () => false,
    hasActiveDescendantAgentTasksForWorkspace: () => false,
    hasActiveTopLevelWorkflowRunsForWorkspace: () => Promise.resolve(false),
    getAgentTaskStatus: () => undefined,
    resetAutoResumeCount: () => undefined,
    backgroundForegroundWaitsForWorkspace: () => 0,
    markInterruptedTaskRunning: () => Promise.resolve(false),
    restoreInterruptedTaskAfterResumeFailure: () => Promise.resolve(),
    markParentWorkspaceInterrupted: () => undefined,
    latchHardInterruptCascade: () => undefined,
    terminateAllDescendantAgentTasks: () => Promise.resolve([]),
    noteWorkspaceUnarchived: () => Promise.resolve(),
    ...overrides,
  };
}

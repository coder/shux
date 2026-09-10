import { SUBAGENT_FAILURE_FOOTER } from "@/common/utils/subagentFailureEnvelope";
import type { StartupRecoveryState } from "./startupRecovery";
import type { CoderWorkspaceArchiveBehavior } from "@/common/config/coderArchiveBehavior";
import type { WorktreeArchiveBehavior } from "@/common/config/worktreeArchiveBehavior";
import type { ExperimentId } from "@/common/constants/experiments";
import type { GoalSyntheticMessageKind } from "@/constants/goals";
import type { ArchivePreflightResult, ArchiveWorkspaceResult } from "@/common/orpc/schemas/api";
import type { FilePart, SendMessageOptions, WorkspaceChatMessage } from "@/common/orpc/types";
import type { SendMessageError } from "@/common/types/errors";
import type {
  MuxMessage,
  MuxMessageMetadata,
  WorkspaceTurnTaskCorrelation,
} from "@/common/types/message";
import type { Result } from "@/common/types/result";
import type { StreamErrorRecoveryOutcome } from "@/node/services/agentSession";
import type { RuntimeConfig } from "@/common/types/runtime";
import type {
  FrontendWorkspaceMetadata,
  WorkspaceMetadata,
  WorkspaceRemovalDescendant,
} from "@/common/types/workspace";
import type { AgentAiSettingsLayerValues } from "@/common/types/agentAiSettings";
import type {
  OpenAIReasoningMode,
  ParsedThinkingInput,
  ThinkingLevel,
} from "@/common/types/thinking";
import type {
  TerminalAttentionNotification,
  TerminalAttentionOutcome,
} from "@/node/services/terminalAttentionStore";
import assert from "@/common/utils/assert";
import type { Config, Workspace as WorkspaceConfigEntry } from "@/node/config";
import type { QueueCutCutter } from "@/node/services/messageQueue";
import type { z } from "zod";
import strictAssert from "node:assert/strict";
import type { BackgroundWorkAttentionPolicy } from "@/common/types/backgroundWorkAttention";
import {
  SUBAGENT_FAILURE_ENVELOPE_TAG,
  formatSubagentReportEnvelope,
} from "@/common/utils/subagentReportEnvelope";
import { resolvePersistedAgentId } from "@/common/utils/agentIds";
import type { WorkflowRunStatus } from "@/common/types/workflow";
import type {
  TaskIsolation,
  TaskWorkspaceLifecycleToolTargetResultSchema,
} from "@/common/utils/tools/toolDefinitions";
import type { WorkspaceTurnTaskStatus } from "@/node/services/taskHandleStore";

/**
 * One-directional service ports keep task and workspace orchestration from depending on each
 * other's concrete class. Host call placement intentionally stays at the race-hardened sinks and
 * admission gates; this seam is the leverage point for any later control-flow inversion.
 */

export type AgentTaskStatus = NonNullable<WorkspaceConfigEntry["taskStatus"]>;

export type TaskKind = "agent";

/**
 * Resolved per-agent AI settings (canonical model + optional thinking level).
 *
 * `thinkingLevel` is optional because internal callers read these settings off of
 * partial workspace metadata where the field may be missing on older entries.
 */
export interface ResolvedWorkspaceAiSettings {
  model: string;
  thinkingLevel?: ThinkingLevel;
  /** OpenAI pro reasoning mode; per-workspace choice inherited by spawned tasks. */
  reasoningMode?: OpenAIReasoningMode;
}

export type WorkspaceLifecycleResult = z.infer<typeof TaskWorkspaceLifecycleToolTargetResultSchema>;

export interface TaskCreateArgs {
  parentWorkspaceId: string;
  kind: TaskKind;
  /** Preferred identifier (matches agent definition id). */
  agentId?: string;
  /** @deprecated Legacy alias for agentId (kept for on-disk compatibility). */
  agentType?: string;
  prompt: string;
  /** Human-readable title for the task (displayed in sidebar) */
  title: string;
  modelString?: string;
  /**
   * Explicit thinking override. Named levels apply directly; a numeric index is
   * deferred (ParsedThinkingInput) and resolved against the chosen model's policy
   * in resolveTaskAISettings, mirroring the UI's `/model+level` semantics.
   */
  thinkingLevel?: ParsedThinkingInput;
  /**
   * Workspace isolation for this task. "none" runs the sub-agent directly in the parent
   * workspace's checkout (shared working tree, no fork) on runtimes that support it; defaults to
   * "fork" (isolated copy) when omitted. Ignored (treated as "fork") on unsupported runtimes.
   */
  isolation?: TaskIsolation;
  /** Desktop sharing is independent of checkout isolation. */
  desktop?: "shared" | "isolated";
  parentRuntimeAiSettings?: { modelString?: string; thinkingLevel?: ThinkingLevel };
  /**
   * Model-refusal policy persisted on the child workspace. "fail" opts the task
   * out of configured model-fallback chains so a refusal settles terminally
   * (workflow verifier steps demand honest failure). Defaults to "fallback".
   */
  onRefusal?: "fail" | "fallback";
  /** Shared grouping metadata when one tool call spawns multiple sibling tasks. */
  bestOf?: {
    groupId: string;
    index: number;
    total: number;
  };
  workflowTask?: {
    runId: string;
    stepId: string;
    workflowName?: string;
    outputSchema?: unknown;
  };
  /**
   * How the owner's stream-end treats this task while it is active. Derived from
   * launch intent: `run_in_background: true` -> "notify_on_terminal" (non-blocking
   * with terminal wake-up); foreground/default -> "blocking_until_terminal".
   * Defaults to blocking when omitted.
   */
  attentionPolicy?: BackgroundWorkAttentionPolicy;
  /** Experiments to inherit to subagent */
  experiments?: {
    programmaticToolCalling?: boolean;
    /** RLM mode: persisted on the task record so RLM-gated child features survive restarts. */
    rlm?: boolean;
    advisorTool?: boolean;
    dynamicWorkflows?: boolean;
  };
}

export function formatSubagentReportUserMessage(params: {
  childWorkspaceId: string;
  agentType: string;
  title: string;
  reportMarkdown: string;
  status: "in_progress" | "completed";
  executionVersion?: string;
  executionId?: string;
  model?: string;
  thinkingLevel?: ThinkingLevel;
  structuredOutput?: unknown;
}): string {
  strictAssert(params.childWorkspaceId.length > 0, "subagent report message requires child id");
  strictAssert(params.agentType.length > 0, "subagent report message requires agent type");
  strictAssert(params.title.length > 0, "subagent report message requires title");
  strictAssert(params.reportMarkdown.length > 0, "subagent report message requires markdown");

  return formatSubagentReportEnvelope({
    taskId: params.childWorkspaceId,
    agentType: params.agentType,
    status: params.status,
    title: params.title,
    reportMarkdown: params.reportMarkdown,
    ...(params.executionVersion != null ? { executionVersion: params.executionVersion } : {}),
    ...(params.executionId != null ? { executionId: params.executionId } : {}),
    ...(params.model != null ? { model: params.model } : {}),
    ...(params.thinkingLevel != null ? { thinkingLevel: params.thinkingLevel } : {}),
    ...(params.structuredOutput !== undefined ? { structuredOutput: params.structuredOutput } : {}),
  });
}

// Failure twin of formatSubagentReportUserMessage: terminal child failures are
// delivered into the parent context as an explicit failure block (never as a
// report) so a later wake-up — by ANY sibling's settlement — cannot present the
// fanout as fully successful.
export function formatSubagentFailureUserMessage(params: {
  childWorkspaceId: string;
  agentType: string;
  executionVersion?: string;
  executionId?: string;
  errorType: string;
  errorMessage: string;
}): string {
  strictAssert(params.childWorkspaceId.length > 0, "subagent failure message requires child id");
  strictAssert(params.agentType.length > 0, "subagent failure message requires agent type");
  strictAssert(params.errorMessage.length > 0, "subagent failure message requires error message");

  return [
    SUBAGENT_FAILURE_ENVELOPE_TAG,
    `<task_id>${params.childWorkspaceId}</task_id>`,
    ...(params.executionVersion != null
      ? [`<execution_version>${params.executionVersion}</execution_version>`]
      : []),
    ...(params.executionId != null ? [`<execution_id>${params.executionId}</execution_id>`] : []),
    `<agent_type>${params.agentType}</agent_type>`,
    `<error_type>${params.errorType}</error_type>`,
    "<error_message>",
    params.errorMessage,
    "</error_message>",
    // Older clients require this exact terminator to render persisted failures.
    SUBAGENT_FAILURE_FOOTER,
    "</mux_subagent_failure>",
  ].join("\n");
}

export function terminalAttentionOutcome(
  status: WorkflowRunStatus | WorkspaceTurnTaskStatus
): TerminalAttentionOutcome {
  switch (status) {
    case "completed":
      return "completed";
    case "failed":
      return "failed";
    case "interrupted":
      return "interrupted";
    default:
      return "error";
  }
}

export interface BackgroundableForegroundWaiter {
  taskId: string;
  reject: (error: Error) => void;
  cleanup: () => void;
  requestingWorkspaceId?: string;
  backgroundOnMessageQueued: boolean;
}

// Task-recovery paths must stay deterministic and editing-capable even when
// workspace/default agent preferences evolve (e.g., auto router defaults).
export const TASK_RECOVERY_FALLBACK_AGENT_ID = "exec";

export function resolveTaskAgentIdForResume(workspace: {
  agentId?: string;
  agentType?: string;
  parentWorkspaceId?: string | null;
}): string {
  return resolvePersistedAgentId(workspace, TASK_RECOVERY_FALLBACK_AGENT_ID);
}

/**
 * In-memory cut-attribution state captured synchronously when a stream-end
 * event is handled, BEFORE any awaits. handleStreamEnd performs async
 * persistence and attention work ahead of settlement, during which the child
 * session can dispatch further queued turns; classifying from live state at
 * that later point could attribute the cut to an input that engaged only
 * after the real cutter (e.g. a same-owner follow-up dispatched after a
 * manual message's turn failed instantly), wrongly suppressing the
 * notification for the real manual/cross-owner supersede. The snapshot pins
 * attribution to the state observed at the ended stream's own event.
 */
export interface QueueCutAttributionSnapshot {
  activeStream: { messageId: string; muxMetadata: unknown } | undefined;
  cutter: QueueCutCutter | undefined;
  hasPendingQueuedOrPreparingTurn: boolean;
}

export function getIsoNow(): string {
  return new Date().toISOString();
}

export interface ArchiveWorkspaceOptions {
  /**
   * Refuse to archive when the effective worktree archive behavior would delete the checkout
   * ("delete"). Model-facing callers set this so a concurrent settings flip cannot turn an
   * agent-driven archive into an unconfirmed checkout deletion; enforced against the same
   * behavior read that drives the snapshot/deletion decisions.
   */
  forbidWorktreeCheckoutDeletion?: boolean;
  /**
   * Refuse to archive when live user activity exists at the sink (a stream, a send still in
   * its pre-admission window, queued/preparing turns, terminal sessions, or an attached
   * desktop viewer/popout). Model-facing callers set this so an agent-driven archive fails
   * closed instead of silently terminating user work that started after the caller's earlier
   * activity check.
   * Checked synchronously in the same block that marks the workspace as archiving, pairing
   * with sendMessage's synchronous entry guards: whichever side runs first is observed by the
   * other. Also holds the session's turn admission for the rest of the archive so a queued
   * entry cannot dispatch through AgentSession's internal send path (which bypasses
   * WorkspaceService.sendMessage) into the workspace mid-archive. The user-driven archive
   * path intentionally omits this and keeps its stop-activity semantics.
   */
  refuseLiveUserActivity?: boolean;
  /**
   * Behavior snapshot read by the caller before it committed to the archive (e.g. before
   * interrupting active turns). The sink uses it for every snapshot/deletion decision instead
   * of re-reading config, so a concurrent settings flip cannot change archive eligibility
   * between the caller's checks and the sink — e.g. flipping keep → snapshot after turns were
   * interrupted would otherwise bounce with requires_confirmation, stranding destroyed work.
   */
  worktreeArchiveBehaviorOverride?: WorktreeArchiveBehavior;
  /**
   * Refuse to archive when the Coder workspace-on-archive policy would permanently delete a
   * dedicated (mux-created) remote Coder workspace via the before-archive hook. Unarchive
   * does not recreate deleted Coder workspaces, so a model-facing "reversible" archive must
   * fail closed instead; route that policy through user-mediated archive.
   */
  forbidCoderWorkspaceDeletion?: boolean;
  /**
   * Coder archive-policy snapshot read by the caller before it committed to the archive (e.g.
   * before deciding interrupt_active eligibility and interrupting turns). Mirrors
   * worktreeArchiveBehaviorOverride: the sink's deletion guard and the before-archive hook honor
   * this same read, so a keep → stop/delete settings flip after the caller's checks cannot make
   * the sink run (or refuse on) a remote stop/deletion the caller never admitted — which would
   * otherwise strand already-interrupted turns behind a failed archive.
   */
  coderWorkspaceArchiveBehaviorOverride?: CoderWorkspaceArchiveBehavior;
}

export interface WorkspaceLiveActivity {
  streaming: boolean;
  /** Queued or dispatching (PREPARING) messages that would start a stream after archive. */
  queuedMessages: boolean;
  /**
   * Detached background bash processes still running (sync snapshot; may briefly read
   * stale-running until the next lazy refresh — callers wanting freshness should await
   * hasRunningBackgroundBashProcesses first).
   */
  backgroundBashProcesses: boolean;
  terminalSessions: boolean;
  /**
   * A desktop startup, browser viewer, or popout window attached to this workspace's desktop.
   * A bare idle desktop process is intentionally excluded (see
   * DesktopSessionManager.hasAttachedViewers).
   */
  desktopViewers: boolean;
}

export interface SendMessageInternalOptions {
  allowQueuedAgentTask?: boolean;
  skipAutoResumeReset?: boolean;
  synthetic?: boolean;
  /** Marks a synthetic send as an active-goal continuation turn. */
  goalContinuation?: boolean;
  /** Specific active-goal synthetic turn kind to persist on the user message. */
  goalKind?: GoalSyntheticMessageKind;
  /** Goal identity persisted alongside goalKind so reconciliation can scope the row. */
  goalId?: string;
  /** Force Copilot billing classification to "agent" for internal sends. */
  agentInitiated?: boolean;
  onAccepted?: () => Promise<void> | void;
  onCanceled?: (reason: string) => Promise<void> | void;
  onAcceptedPreStreamFailure?: (error: SendMessageError) => Promise<void> | void;
  cancelState?: { canceledBeforeAcceptance: boolean };
  /** Cancels a synthetic send even after it has left MessageQueue for PREPARING. */
  cancelSignal?: AbortSignal;
  /** Let a late `cancelSignal` abort withdraw the send after its rows are durable (see AgentSession). */
  withdrawAcceptedOnCancel?: boolean;
  /**
   * Synchronous staleness probe from the caller, re-evaluated at the real admission points
   * (the enqueue block and the session's turn-admission gates) in addition to the
   * context-mutation epoch. Peer agent sends use it so a user Stop or task_stop landing
   * during this method's awaits refuses the send instead of queueing a wake or resurrecting
   * the stopped task via markInterruptedTaskRunning.
   */
  admissionStale?: () => boolean;
  /**
   * Synthetic assistant rows persisted just before the turn's user row
   * (family-message payloads). Delivered atomically with the message —
   * queued alongside it when the workspace is busy — so they never land
   * inside another turn's PREPARING window (see AgentSession.sendMessage).
   */
  preTurnMessages?: MuxMessage[];
  /** r54: fired once pre-turn rows cross the rollback horizon (see AgentSession). */
  onPreTurnRowsPersisted?: () => void;
  /** Return once the user message is accepted; stream startup continues asynchronously. */
  startStreamInBackground?: boolean;
  /** When true, reject instead of queueing if the workspace is busy. */
  requireIdle?: boolean;
  /** Preserve workspace-turn correlation only when this send is the next continuation. */
  workspaceTurnContinuation?: boolean;
  /** Coalescing for queued sends: drop the message when the same key is already queued. */
  queueDedupeKey?: string;
  /** Restore durable guidance behind a restarted question without dispatching a turn. */
  restoreQueued?: boolean;
  /** Keep this dedupe-keyed queue entry isolated so it can be selectively superseded. */
  removableQueueDedupeKey?: boolean;
  /**
   * For queued tool-end sends: enqueue ahead of hidden (non-user-authored) turn-end entries so
   * a background turn-end predecessor cannot hold this send until the turn ends naturally.
   * Never overtakes a user-authored entry. See MessageQueue.promoteAheadOfHiddenTurnEnd.
   */
  promoteAheadOfHiddenTurnEnd?: boolean;
  /**
   * For queued sends: quietly drop the message (success) when other messages are already
   * queued at enqueue time. Scheduled heartbeats use this so a user send racing the awaits
   * in this method keeps queue ownership — MessageQueue dispatches with the latest queued
   * options, so merging a heartbeat in would run the user's queued turn with the
   * heartbeat's model/agent.
   */
  yieldToQueuedMessages?: boolean;
}

export interface WorkspaceTurnHost {
  sendMessage(
    workspaceId: string,
    message: string,
    options: SendMessageOptions & { fileParts?: FilePart[] },
    internal?: SendMessageInternalOptions
  ): Promise<Result<void, SendMessageError>>;
  resumeStream(
    workspaceId: string,
    options: SendMessageOptions,
    internal?: { allowQueuedAgentTask?: boolean; agentInitiated?: boolean }
  ): Promise<Result<{ started: boolean }, SendMessageError>>;
  clearQueue(workspaceId: string, options?: { cancelReason?: string }): Result<void>;
  replaceHistory(
    workspaceId: string,
    summaryMessage: MuxMessage,
    options?: {
      mode?: "destructive" | "append-compaction-boundary" | null;
      deletePlanFile?: boolean;
    }
  ): Promise<Result<void>>;
  waitForIdleAndNoQueuedMessages(workspaceId: string): Promise<void>;
  waitForPendingCompactionCompletionDecision(
    workspaceId: string,
    messageId: string
  ): Promise<boolean | undefined>;
  waitForPendingStreamErrorRecoveryDecision(
    workspaceId: string,
    messageId: string
  ): Promise<StreamErrorRecoveryOutcome | undefined>;
}

export interface TurnAdmissionHost {
  acquireIdleTurnExclusion(workspaceId: string): Result<Disposable>;
  getStartupRecoveryState(workspaceId: string): Promise<StartupRecoveryState>;
  dispatchPendingCompactionFollowUp(workspaceId: string): Promise<Result<boolean>>;
  isBusyForMessage(workspaceId: string): boolean;
  hasQueuedMessages(workspaceId: string, dispatchMode?: "tool-end" | "turn-end"): boolean;
  hasPendingQueuedOrPreparingTurn(workspaceId: string): boolean;
  hasPendingAutoRetry(workspaceId: string): boolean;
  hasPendingBashMonitorWakeContinuation(workspaceId: string): boolean;
  hasPendingWorkspaceTurnContinuation(
    workspaceId: string,
    metadata: Extract<MuxMessageMetadata, { type: "workspace-turn-task" }>
  ): boolean;
  hasQueuedWorkspaceTurn(workspaceId: string, handleId: string): boolean;
  removeQueuedWorkspaceTurn(
    workspaceId: string,
    handleId: string,
    options: { cancelReason: string }
  ): Result<boolean>;
  removeQueuedMessagesByDedupeKeyPrefix(
    workspaceId: string,
    prefix: string,
    options?: {
      cancelReason?: string;
      /**
       * Drop the entries without invoking their onCanceled/onAcceptedPreStreamFailure callbacks.
       * For supersession (the entry's source produced a later, authoritative message) rather than
       * withdrawal: a workspace-turn continuation the entry carried must not be settled as failed.
       */
      skipCancelCallbacks?: boolean;
    }
  ): Result<number>;
  getQueueCutCutter(workspaceId: string): QueueCutCutter | undefined;
  countQueuedAgentPeerMessages(workspaceId: string): number;
}

export interface WorkspaceLifecycleHost {
  archive(
    workspaceId: string,
    acknowledgedUntrackedPaths?: string[],
    options?: ArchiveWorkspaceOptions
  ): Promise<Result<ArchiveWorkspaceResult>>;
  archiveWhileTaskTreeLocked(
    workspaceId: string,
    acknowledgedUntrackedPaths?: string[],
    options?: ArchiveWorkspaceOptions
  ): Promise<Result<ArchiveWorkspaceResult>>;
  unarchiveWhileTaskTreeLocked(workspaceId: string): Promise<Result<void>>;
  preflightArchive(
    workspaceId: string,
    options?: { worktreeArchiveBehaviorOverride?: WorktreeArchiveBehavior }
  ): Promise<Result<ArchivePreflightResult>>;
  acquirePreInterruptionArchiveHold(
    workspaceId: string,
    options: {
      queuedDelegatedTurnCount: number;
      expectedDelegatedTurnCorrelations: readonly WorkspaceTurnTaskCorrelation[];
    }
  ): Result<Disposable>;
  listLiveWorkspaceActivity(workspaceId: string): WorkspaceLiveActivity;
  getStoppablePreparingWorkspaceTurn(workspaceId: string): WorkspaceTurnTaskCorrelation | undefined;
  waitForIdle(workspaceId: string): Promise<void>;
  hasRunningBackgroundBashProcesses(workspaceId: string): Promise<boolean>;
  hasUntrackableExternalAppOpen(workspaceId: string): Promise<boolean>;
  isSnapshotArchiveEligibilityMutationSensitive(
    workspaceId: string,
    worktreeArchiveBehavior?: WorktreeArchiveBehavior,
    metadata?: WorkspaceMetadata
  ): boolean;
  remove(
    workspaceId: string,
    force?: boolean,
    options?: { beforeRemove?: () => Promise<boolean> }
  ): Promise<Result<void>>;
  removeWhileTaskTreeLocked(workspaceId: string, force?: boolean): Promise<Result<void>>;
  /** Own cleanup outside the originating session callback and inside bounded app shutdown. */
  deferWorkspaceCleanup(run: () => Promise<void>): void;
}

export interface WorkspaceProvisioningHost {
  create(
    projectPath: string,
    branchName: string | undefined,
    trunkBranch: string | undefined,
    title?: string,
    runtimeConfig?: RuntimeConfig,
    subProjectPath?: string,
    pendingAutoTitle?: boolean,
    tags?: Record<string, string>
  ): Promise<Result<{ metadata: FrontendWorkspaceMetadata }>>;
  sanitizeMaterializedTaskWorkspace(
    workspaceId: string,
    workspacePath: string,
    runtimeConfig: RuntimeConfig | undefined,
    persistentSiblingConfig?: Pick<Config, "loadConfigOrDefault">
  ): Promise<string | undefined>;
  discardExtensionMetadataEntry(workspaceId: string): Promise<void>;
  registerExternalBackgroundInit(
    workspaceId: string,
    abortController: AbortController,
    settled: Promise<unknown>
  ): void;
}

export interface WorkspaceMetadataHost {
  getInfo(workspaceId: string): Promise<FrontendWorkspaceMetadata | null>;
  updateTitle(workspaceId: string, title: string): Promise<Result<void>>;
  emit(
    event: "metadata",
    payload: { workspaceId: string; metadata: FrontendWorkspaceMetadata | null }
  ): boolean;
  emit(event: "chat", payload: { workspaceId: string; message: WorkspaceChatMessage }): boolean;
  emitChatEvent(workspaceId: string, message: WorkspaceChatMessage): void;
  getWorkflowInvocationBoundaryMessageId(
    workspaceId: string,
    runId: string
  ): Promise<string | null>;
  getWorkflowInvocationCurrentness(
    workspaceId: string,
    runId: string
  ): Promise<"current" | "not_current" | "indeterminate">;
  isExperimentEnabled(experimentId: ExperimentId): boolean;
  isWorkflowInvocationCurrent(workspaceId: string, runId: string): Promise<boolean>;
}

export type WorkspaceHost = WorkspaceTurnHost &
  TurnAdmissionHost &
  WorkspaceLifecycleHost &
  WorkspaceProvisioningHost &
  WorkspaceMetadataHost;

export interface AgentTaskIntegration {
  withTaskTreeLifecycleLock<T>(workspaceId: string, operation: () => Promise<T>): Promise<T>;
  hasDescendantAgentTasks(workspaceId: string): boolean;
  listWorkspaceRemovalDescendants(workspaceId: string): WorkspaceRemovalDescendant[];
  removeAcknowledgedDescendantsWhileTaskTreeLocked(
    workspaceId: string,
    acknowledgedIds: string[]
  ): Promise<Result<void>>;
  hasActiveDescendantAgentTasksForWorkspace(workspaceId: string): boolean;
  hasActiveTopLevelWorkflowRunsForWorkspace(workspaceId: string): Promise<boolean>;
  getAgentTaskStatus(workspaceId: string): AgentTaskStatus | null | undefined;
  resetAutoResumeCount(workspaceId: string): void;
  backgroundForegroundWaitsForWorkspace(workspaceId: string): number;
  markInterruptedTaskRunning(workspaceId: string): Promise<boolean>;
  restoreInterruptedTaskAfterResumeFailure(
    workspaceId: string,
    previousStatus?: AgentTaskStatus | null
  ): Promise<void>;
  markParentWorkspaceInterrupted(workspaceId: string): void;
  latchHardInterruptCascade(workspaceId: string): (() => void) | undefined;
  terminateAllDescendantAgentTasks(
    workspaceId: string,
    options?: { workflowRunId?: string }
  ): Promise<string[]>;
  noteWorkspaceUnarchived(workspaceId: string): Promise<void>;
}

export interface WorkspaceTurnTaskHost {
  acquireTaskCreationLock(): Promise<AsyncDisposable>;
  backgroundForegroundWaitIfQueued(
    shouldBackgroundOnQueuedMessage: boolean,
    requestingWorkspaceId: string | undefined
  ): void;
  buildParentAiSettingsFallbacks(
    parentMeta: {
      agentId?: string;
      aiSettingsByAgent?: Record<string, ResolvedWorkspaceAiSettings>;
      aiSettings?: ResolvedWorkspaceAiSettings;
    },
    targetAgentId: string
  ): AgentAiSettingsLayerValues[];
  bumpWorkspaceStopEpoch(workspaceId: string): void;
  countActiveAgentTasks(config: ReturnType<Config["loadConfigOrDefault"]>): number;
  editWorkspaceEntry(
    workspaceId: string,
    updater: (
      workspace: WorkspaceConfigEntry,
      config: ReturnType<Config["loadConfigOrDefault"]>
    ) => void,
    options?: { allowMissing?: boolean }
  ): Promise<boolean>;
  emitWorkspaceMetadata(workspaceId: string): Promise<void>;
  enqueueTerminalAttention(params: {
    ownerWorkspaceId: string;
    sourceKind: TerminalAttentionNotification["sourceKind"];
    terminalOutcome: TerminalAttentionOutcome;
    sourceId: string;
    generationId?: string;
  }): Promise<void>;
  hasActiveDescendantAgentTasks(
    config: ReturnType<Config["loadConfigOrDefault"]>,
    workspaceId: string
  ): boolean;
  isDescendantAgentTaskInConfig(
    config: ReturnType<Config["loadConfigOrDefault"]>,
    ancestorWorkspaceId: string,
    taskId: string
  ): boolean;
  isForegroundAwaiting(workspaceId: string): boolean;
  latchWorkspaceStopsInProgress(workspaceIds: readonly string[]): () => void;
  listActiveBackgroundWorkflowRunIds(
    workspaceId: string,
    referencedWorkflowRunIds: readonly string[]
  ): Promise<string[]>;
  listActiveWorkflowRunIdsForWorkspaceStrict(workspaceId: string): Promise<string[]>;
  listAgentReferencedWorkflowRunIds(
    workspaceId: string,
    currentParts: readonly unknown[],
    currentMessageId?: string
  ): Promise<string[]>;
  listAgentTaskExecutionEntries(
    config: ReturnType<Config["loadConfigOrDefault"]>
  ): Array<{ id?: string; taskExecutionId?: string }>;
  markTaskForegroundRelevant(taskId: string): void;
  maybeStartPatchGenerationForReportedTask(
    workspaceId: string,
    options?: { refreshForContinuation?: boolean }
  ): Promise<void>;
  registerBackgroundableForegroundWaiter(
    workspaceId: string,
    waiter: BackgroundableForegroundWaiter
  ): void;
  releaseRetainedStopLatches(workspaceId: string): void;
  resolveWorkspaceAISettings(
    workspace: {
      aiSettingsByAgent?: Record<string, ResolvedWorkspaceAiSettings>;
      aiSettings?: ResolvedWorkspaceAiSettings;
    },
    agentId: string | undefined
  ): ResolvedWorkspaceAiSettings | undefined;
  scheduleMaybeStartQueuedTasks(): void;
  scheduleTerminalAttentionDrain(ownerWorkspaceId: string): void;
  startForegroundAwait(workspaceId: string): () => void;
  unregisterBackgroundableForegroundWaiter(
    workspaceId: string,
    waiter: BackgroundableForegroundWaiter
  ): void;
}

export type WorkspaceTurnManagerHost = Pick<AgentTaskIntegration, "withTaskTreeLifecycleLock"> &
  WorkspaceTurnTaskHost;

export function normalizeArchiveUntrackedPaths(paths: readonly string[]): string[] {
  const normalizedPaths = paths.map((untrackedPath) => {
    const trimmedPath = untrackedPath.trim();
    assert(
      trimmedPath.length > 0,
      "normalizeArchiveUntrackedPaths: untracked paths must be non-empty"
    );
    return trimmedPath;
  });
  return [...new Set(normalizedPaths)].sort();
}

// Shared so the task-side pre-interruption archive preflight applies the exact
// acknowledgement semantics enforced at the archive sink (getArchiveUntrackedFilesConfirmation):
// a drifted acknowledged set (extra OR missing paths) must re-confirm before any
// destructive interruption, not after.
export function areArchiveUntrackedPathListsEqual(
  leftPaths: readonly string[],
  rightPaths: readonly string[]
): boolean {
  const normalizedLeftPaths = normalizeArchiveUntrackedPaths(leftPaths);
  const normalizedRightPaths = normalizeArchiveUntrackedPaths(rightPaths);
  if (normalizedLeftPaths.length !== normalizedRightPaths.length) {
    return false;
  }

  return normalizedLeftPaths.every((path, index) => path === normalizedRightPaths[index]);
}

import type { RestartBlocker } from "@/common/orpc/types";
import { Effect, type Scope } from "effect";
import { defaultEffectRunner, type EffectRunner } from "./di/effectRunner";
import {
  DesktopInputCoordinator,
  settleArchivedSharedDesktopTask,
} from "@/node/services/desktop/DesktopInputCoordinator";
import * as path from "path";
import { TASK_TERMINATION_STOP_STREAM_TIMEOUT_MS } from "@/constants/terminationTimeouts";
import { raceWithAbortAndTimeout } from "@/node/utils/concurrency/withTimeout";
import { SERVER_UPDATE_MONITOR_VERIFY_TIMEOUT_MS } from "@/constants/serverUpdate";
import { EventEmitter } from "events";
import { acquireCrossProcessLock } from "@/node/utils/main/crossProcessLock";
import {
  clearAgentWorkflowRunReferences,
  readAgentWorkflowRunReferences,
  type AgentWorkflowRunReference,
} from "@/node/services/agentWorkflowRunReferences";
import * as fsPromises from "fs/promises";
import assert from "@/common/utils/assert";
import { DEFAULT_WORKTREE_ARCHIVE_BEHAVIOR } from "@/common/config/worktreeArchiveBehavior";
import type { WorktreeArchiveBehavior } from "@/common/config/worktreeArchiveBehavior";
import { DEFAULT_CODER_ARCHIVE_BEHAVIOR } from "@/common/config/coderArchiveBehavior";
import type { WorktreeArchiveSnapshot } from "@/common/schemas/project";
import { isWorkspaceArchived } from "@/common/utils/archive";
import {
  comparePinnedOrder,
  isWorkspacePinned,
  appendPinnedTimestamp,
  reassignPinnedTimestamps,
} from "@/common/utils/pin";
import { SCRATCH_PROJECT_CONFIG_KEY } from "@/common/constants/scratch";
import { STOP_UNRECORDED_MESSAGE } from "@/common/constants/workspace";
import { MULTI_PROJECT_CONFIG_KEY } from "@/common/constants/multiProject";
import type { CompactionCompletionMetadata } from "@/common/types/compaction";
import { ProvidersConfigStore, SecretsStore, type Config } from "@/node/config";
import type { ProjectsConfig, Workspace } from "@/common/types/project";
import type { Result } from "@/common/types/result";
import { Ok, Err } from "@/common/types/result";
import { askUserQuestionManager } from "@/node/services/askUserQuestionManager";
import { delegatedToolCallManager } from "@/node/services/delegatedToolCallManager";
import { log } from "@/node/services/log";
import { eventSpine } from "@/node/services/events/eventSpine";
import { agentPluginHookService } from "@/node/services/agentPlugins/hookService";
import { sandboxHostService } from "@/node/services/sandbox/sandboxHostService";
import { isPathInsideDir } from "@/node/utils/pathUtils";
import {
  AgentSession,
  clearProviderConfigFixableAbandonMarkers,
  CONTEXT_MUTATION_SEND_BLOCKED_MESSAGE,
  inheritOpenWorkspaceTurnMetadata,
  type StreamErrorRecoveryOutcome,
} from "@/node/services/agentSession";
import type { QueueCutCutter } from "@/node/services/messageQueue";
import { cancelReasonBeforeAcceptance } from "@/node/services/messageQueue";
import type { HistoryService } from "@/node/services/historyService";
import type { AIService } from "@/node/services/aiService";
import type { StreamManager } from "@/node/services/streamManager";
import type { InitStateManager } from "@/node/services/initStateManager";
import type {
  ExtensionMetadataService,
  ExtensionMetadataStreamingUpdate,
} from "@/node/services/ExtensionMetadataService";
import { coerceAgentStatus } from "@/node/utils/extensionMetadata";
import { readTodosForSessionDir } from "@/node/services/todos/todoStorage";
import type { TelemetryService } from "@/node/services/telemetryService";
import type { ExperimentsService } from "@/node/services/experimentsService";
import { EXPERIMENT_IDS } from "@/common/constants/experiments";
import type { PolicyService } from "@/node/services/policyService";
import type { MCPServerManager } from "@/node/services/mcpServerManager";
import {
  createRuntime,
  IncompatibleRuntimeError,
  runBackgroundInit,
  runFullInit,
} from "@/node/runtime/runtimeFactory";
import { MultiProjectRuntime } from "@/node/runtime/multiProjectRuntime";
import {
  createRuntimeContextForWorkspace,
  createRuntimeForWorkspace,
  resolveWorkspaceExecutionPath,
  resolveWorkspaceRootPath,
} from "@/node/runtime/runtimeHelpers";
import {
  resolveNodeAgentAiSettings,
  type NodeAgentDefinitionContext,
} from "@/node/services/agentDefinitions/resolveNodeAgentAiSettings";
import { targetWorkspaceBucketToLayer } from "@/common/types/agentAiSettings";
import type { AgentAiDefaults } from "@/common/types/agentAiDefaults";
import { resolveAgentAiSettings } from "@/common/utils/ai/resolveAgentAiSettings";
import { getWorkspacePathHintForProject } from "@/node/services/workspaceProjectRepos";
import {
  formatBranchWorkspaceNameConflict,
  getBranchWorkspaceNameConflict,
  sanitizeBranchNameForWorkspace,
  validateWorkspaceBranchName,
  validateWorkspaceName,
} from "@/common/utils/validation/workspaceValidation";
import { ensurePrivateDir, isErrnoWithCode } from "@/node/utils/fs";
import {
  CHAT_FILE_NAME,
  CHAT_ARCHIVE_FILE_NAME,
  HEADLESS_USAGE_FILE_NAME,
} from "@/common/constants/paths";
import { stripTrailingSlashes } from "@/node/utils/pathUtils";
import { getProjects, isMultiProject } from "@/common/utils/multiProject";
import { generateGitStatusScript, parseGitStatusScriptOutput } from "@/common/utils/git/gitStatus";
import { isWorkspaceTrustedForSharedExecution } from "@/node/services/utils/workspaceTrust";
import { mergeMultiProjectSecrets } from "@/node/services/utils/multiProjectSecrets";
import { getPlanFilePath, getLegacyPlanFilePath } from "@/common/utils/planStorage";
import { detectDefaultTrunkBranch, listLocalBranches } from "@/node/git";
import { shellQuote } from "@/node/runtime/backgroundCommands";
import { extractEditedFilePaths } from "@/common/utils/messages/extractEditedFiles";
import { buildCompactionMessageText } from "@/common/utils/compaction/compactionPrompt";
import {
  CONTEXT_BOUNDARY_KINDS,
  hasProviderEligibleMessages,
  isDurableCompactedMarker,
  sliceMessagesForProviderFromLatestContextBoundary,
} from "@/common/utils/messages/compactionBoundary";
import { isNonNegativeInteger, isPositiveInteger } from "@/common/utils/numbers";
import { isPlainObject } from "@/common/utils/isPlainObject";
import { deriveTodoStatus } from "@/common/utils/todoList";
import { createContextResetBoundaryMessageId } from "@/node/services/utils/messageIds";
import { fileExists } from "@/node/utils/runtime/fileExists";
import {
  clearPendingBranchSummary,
  deriveSideChannelModelCandidates,
  startAbandonedBranchSummaryInBackground,
} from "@/node/services/branchSummary";
import {
  healRemovalTombstonesForRegisteredWorkspaces,
  removeSessionDirUnderMemoryLocks,
  refineApplyLockPath,
  rollbackRemovalTombstoneIfOwned,
  startRemovalTombstoneLease,
  TombstoneNotDurableError,
} from "@/node/services/workspaceRemoval";
import { orchestrateFork } from "@/node/services/utils/forkOrchestrator";
import {
  ADDITIONAL_SYSTEM_CONTEXT_DISABLED_FILENAME,
  ADDITIONAL_SYSTEM_CONTEXT_FILENAME,
} from "@/node/services/additionalSystemContext";
import { generateWorkspaceIdentity } from "@/node/services/workspaceTitleGenerator";
import { NAME_GEN_PREFERRED_MODELS } from "@/common/constants/nameGeneration";
import type { DevcontainerRuntime } from "@/node/runtime/DevcontainerRuntime";
import { WorktreeRuntime } from "@/node/runtime/WorktreeRuntime";
import {
  getDevcontainerContainerName,
  probeDevcontainerStatuses,
  stopDevcontainer,
} from "@/node/runtime/devcontainerCli";
import { isWorktreeRuntime } from "@/node/runtime/worktreeLifecycleHooks";
import { expandTilde, expandTildeForSSH } from "@/node/runtime/tildeExpansion";
import { removeManagedGitWorktree } from "@/node/worktree/removeManagedGitWorktree";
import { managedRootsByProject, syncProjectCodeWorkspace } from "@/node/worktree/codeWorkspaceSync";

import {
  copyStagedWorkspaceAttachments,
  extractStagedAttachmentPathsFromText,
  readStagedWorkspaceAttachment,
  stageWorkspaceAttachment,
  type DownloadedStagedWorkspaceAttachment,
  type StagedWorkspaceAttachment,
} from "@/node/utils/attachments/stageWorkspaceAttachment";
import { ContainerManager } from "@/node/multiProject/containerManager";

import type { PostCompactionExclusions } from "@/common/types/attachment";
import type {
  SendMessageOptions,
  DeleteMessage,
  FilePart,
  WorkspaceChatMessage,
} from "@/common/orpc/types";

import type { z } from "zod";
import type { SendMessageError, StreamErrorType } from "@/common/types/errors";
// Aliased to avoid clashing with the private `formatSendMessageError` string formatter below.
import { formatSendMessageError as classifySendMessageError } from "@/node/services/utils/sendMessageError";
import type { IdleCompactionOutcome } from "@/node/services/idleCompactionService";
import type {
  FrontendWorkspaceMetadata,
  GitStatus,
  ProjectRef,
  WorkspaceActivitySnapshot,
  WorkspaceMetadata,
  WorkspaceRemovalDescendant,
} from "@/common/types/workspace";
import { isDynamicToolPart } from "@/common/types/toolParts";
import { buildAskUserQuestionSummary } from "@/common/utils/tools/askUserQuestionSummary";
import {
  AskUserQuestionToolArgsSchema,
  AskUserQuestionToolResultSchema,
} from "@/common/utils/tools/toolDefinitions";
import { UIModeSchema, type UIMode } from "@/common/types/mode";
import {
  createMuxMessage,
  getCompactionFollowUpContent,
  isSameWorkspaceTurnTaskCorrelation,
  parseWorkspaceTurnTaskCorrelation,
  pickPreservedSendOptions,
  type CompactionFollowUpRequest,
  type MuxMessageMetadata,
  type MuxMessage,
  type WorkspaceTurnTaskCorrelation,
} from "@/common/types/message";
import { getFollowUpContentText } from "@/browser/utils/compaction/format";
import { stripStagedAttachmentNotice } from "@/browser/features/ChatInput/stagedAttachments";
import {
  isActiveWorkflowRunStatus,
  isNestedWorkflowRun,
  type WorkflowRunRecord,
  type WorkflowRunStatus,
} from "@/common/types/workflow";
import { WorkflowRunStore } from "@/node/services/workflows/WorkflowRunStore";
import {
  hasInProcessWorkflowWork,
  setWorkflowArchiveAdmissionGuard,
} from "@/node/services/workflows/workflowArchiveAdmission";
import {
  WORKFLOW_RESULT_METADATA_TYPE,
  textContainsWorkflowResultPayload,
  WORKFLOW_RUN_CARD_DISPLAY_METADATA_TYPE,
  WORKFLOW_TRIGGER_DISPLAY_METADATA_TYPE,
  buildWorkflowRunCardMessage,
  isTerminalWorkflowRunToolOutput,
  isWorkflowRunEmittingToolName,
} from "@/common/utils/workflowRunMessages";
import type { RuntimeConfig } from "@/common/types/runtime";
import type {
  PendingMaterialization,
  Runtime,
  WorkspaceCreationResult,
  WorkspaceInitParams,
} from "@/node/runtime/Runtime";
import {
  hasSrcBaseDir,
  getSrcBaseDir,
  isSSHRuntime,
  isDockerRuntime,
  isDevcontainerRuntime,
} from "@/common/types/runtime";
import { BG_OUTPUT_SUBDIR } from "@/node/services/backgroundProcessExecutor";
// Backend maintenance sends (goal continuations, idle compaction, heartbeats)
// normalize persisted models with gateway-preserving normalizeSelectedModel:
// normalizeToCanonical would rewrite cross-typed Coder selections
// (coder:openai/<claude> with type anthropic) to direct openai:<claude>,
// bypassing the gateway or failing without direct credentials.
import { isValidModelFormat, normalizeSelectedModel } from "@/common/utils/ai/models";
import {
  hasBudgetedResumableGoal,
  modelHasPricingData,
  UNPRICED_TARGET_MODEL_GOAL_MESSAGE,
} from "@/common/utils/goals/budgetPricing";
import {
  coerceOpenAIReasoningMode,
  coerceThinkingLevel,
  type ThinkingLevel,
} from "@/common/types/thinking";
import { normalizeAgentId } from "@/common/utils/agentIds";
import {
  HEARTBEAT_CONTEXT_MODE_VALUES,
  HEARTBEAT_DEFAULT_CONTEXT_MODE,
  HEARTBEAT_DEFAULT_INTERVAL_MS,
  HEARTBEAT_DEFAULT_MESSAGE_BODY,
  HEARTBEAT_MAX_INTERVAL_MS,
  HEARTBEAT_MIN_INTERVAL_MS,
  HEARTBEAT_QUEUE_DEDUPE_KEY,
  HEARTBEAT_REMOVED_SUMMARY,
  HEARTBEAT_RESET_BOUNDARY_MESSAGE,
  formatHeartbeatInterval,
  summarizeHeartbeatSettings,
  isHeartbeatTrigger,
  isHeartbeatWhenBusy,
  isValidHeartbeatScheduleUpdatedAt,
  resolveHeartbeatSchedulePolicy,
  type HeartbeatContextMode,
  type HeartbeatSchedulePolicy,
} from "@/constants/heartbeat";
import { WORKSPACE_DEFAULTS } from "@/constants/workspaceDefaults";
import {
  GOAL_BUDGET_LIMIT_KIND,
  GOAL_CONTINUATION_KIND,
  type GoalSyntheticMessageKind,
} from "@/constants/goals";
import type {
  StreamStartEvent,
  StreamEndEvent,
  StreamAbortEvent,
  ToolCallEndEvent,
} from "@/common/types/stream";
import type { TerminalService } from "@/node/services/terminalService";
import type { DesktopSessionManager } from "@/node/services/desktop/DesktopSessionManager";
import type {
  WorkspaceAISettingsSchema,
  WorkspaceGoalDefaultsOverrideSchema,
  WorkspaceHeartbeatSettingsSchema,
} from "@/common/orpc/schemas";
import { SendMessageOptionsSchema } from "@/common/orpc/schemas";
import type {
  ArchiveLossyUntrackedFilesConfirmation,
  ArchivePreflightResult,
  ArchiveWorkspaceResult,
  BackgroundProcessInfo,
} from "@/common/orpc/schemas/api";
import type { SessionTimingService } from "@/node/services/sessionTimingService";
import type { SessionUsageService } from "@/node/services/sessionUsageService";
import type {
  GoalContinuationRuntimeState,
  WorkspaceGoalService,
} from "@/node/services/workspaceGoalService";
import { NOOP_TIMELINE_RECORDER, type TimelineRecorder } from "@/node/services/timelineRecorder";
import type {
  BackgroundProcess,
  BackgroundProcessManager,
  MonitorArmedPayload,
  MonitorMatchPayload,
  MonitorStoppedPayload,
  OutputShownPayload,
} from "@/node/services/backgroundProcessManager";
import {
  BashMonitorRegistryStore,
  type BashMonitorRegistryRecord,
} from "@/node/services/bashMonitorRegistryStore";
import { MutexMap } from "@/node/utils/concurrency/mutexMap";
import { acquireProcessFileLock } from "@/node/utils/concurrency/fileLock";
import { REFINE_APPLY_CROSS_PROCESS_LOCK_TIMEOUT_MS } from "@/constants/refine";
import {
  BashMonitorWakeReconciler,
  type BashMonitorWakeDispatch,
  type BashMonitorWakeDispatchOutcome,
  type BashMonitorWakeReconcilerSnapshot,
  type DeliveredWakeRecord,
} from "@/node/services/bashMonitorWakeReconciler";
import type { WorkspaceLifecycleHooks } from "@/node/services/workspaceLifecycleHooks";
import {
  areArchiveUntrackedPathListsEqual,
  normalizeArchiveUntrackedPaths,
  type AgentTaskIntegration,
  type ArchiveWorkspaceOptions,
  type SendMessageInternalOptions,
  type WorkspaceHost,
  type WorkspaceLiveActivity,
} from "@/node/services/taskWorkspaceSeam";
import { findWorkspaceEntry } from "@/node/services/taskUtils";
import type { WorktreeArchiveSnapshotService } from "@/node/services/worktreeArchiveSnapshotService";
import type { DevToolsService } from "@/node/services/devToolsService";
import type { WorkspaceMcpOverridesService } from "@/node/services/workspaceMcpOverridesService";

import { DisposableTempDir } from "@/node/services/tempDir";
import { createBashTool } from "@/node/services/tools/bash";
import type { AskUserQuestionToolSuccessResult, BashToolResult } from "@/common/types/tools";
import { secretsToRecord } from "@/common/types/secrets";

import {
  copyPlanFileAcrossRuntimes,
  execBuffered,
  movePlanFile,
} from "@/node/utils/runtime/helpers";
import {
  buildFileCompletionsIndex,
  EMPTY_FILE_COMPLETIONS_INDEX,
  searchFileCompletions,
  type FileCompletionsIndex,
} from "@/node/services/fileCompletionsIndex";
import { taskQueueDebug } from "@/node/services/taskQueueDebug";
import {
  getSubagentGitPatchMboxPath,
  readSubagentGitPatchArtifactsFile,
  updateSubagentGitPatchArtifactsFile,
} from "@/node/services/subagentGitPatchArtifacts";
import {
  getSubagentReportArtifactPath,
  readSubagentReportArtifactsFile,
  updateSubagentReportArtifactsFile,
} from "@/node/services/subagentReportArtifacts";
import {
  getSubagentTranscriptChatPath,
  getSubagentTranscriptPartialPath,
  readSubagentTranscriptArtifactsFile,
  updateSubagentTranscriptArtifactsFile,
  upsertSubagentTranscriptArtifactIndexEntry,
} from "@/node/services/subagentTranscriptArtifacts";
import { getErrorMessage } from "@/common/utils/errors";

/** Maximum number of retry attempts when workspace name collides */
const MAX_WORKSPACE_NAME_COLLISION_RETRIES = 3;

/**
 * Minimum age before an unreferenced session directory is treated as an orphan and
 * deleted at startup. Protects session data written by a workspace whose config entry
 * has not been observed yet (e.g., creation racing the sweep); true orphans are stale
 * for far longer and get reaped on a later startup.
 */
const ORPHAN_SESSION_DIR_GRACE_MS = 24 * 60 * 60 * 1000;

// Upper bound on startup .code-workspace reconciliation (see initialize()).
const STARTUP_CODE_WORKSPACE_SYNC_TIMEOUT_MS = 10_000;

/**
 * Base name used when /new auto-generates a branch name. Numbered suffixes
 * (`workspace-1`, `workspace-2`, ...) come from {@link generateForkBranchName}
 * so the existing fork-style numbering helpers stay the single source of truth.
 */
const AUTO_NEW_WORKSPACE_BASE_NAME = "workspace";

// Keep short to feel instant, but debounce bursts of file_edit_* tool calls.

// Shared type for workspace-scoped AI settings (model + thinking)
type WorkspaceAISettings = z.infer<typeof WorkspaceAISettingsSchema>;
type WorkspaceHeartbeatSettings = z.infer<typeof WorkspaceHeartbeatSettingsSchema>;
type WorkspaceHeartbeatSettingsUpdate = Partial<WorkspaceHeartbeatSettings>;
type WorkspaceGoalDefaultsOverride = z.infer<typeof WorkspaceGoalDefaultsOverrideSchema>;
interface HeartbeatWorkspaceConfigEntry {
  normalizedWorkspaceId: string;
  /** Project/workspace paths so editConfig transforms can re-find the FRESH entry. */
  projectPath: string;
  workspacePath: string;
  config: ProjectsConfig;
  /**
   * Entry from the pre-read snapshot: valid for read paths and input validation only.
   * Mutations must re-resolve the entry from fresh config inside editConfig — persisting
   * a stale snapshot loses concurrent edits (e.g. resurrects removed workspaces).
   */
  workspaceEntry: Workspace;
}
interface HeartbeatExecutionRequest {
  contextMode: HeartbeatContextMode;
  schedulePolicy: HeartbeatSchedulePolicy;
  sendOptions: SendMessageOptions;
  heartbeatPrompt: string;
  muxMetadata: Extract<MuxMessageMetadata, { type: "heartbeat-request" }>;
  followUp: CompactionFollowUpRequest;
}

type WorktreeArchiveSnapshotLifecycleService = Pick<
  WorktreeArchiveSnapshotService,
  | "preflightSnapshotForArchive"
  | "captureSnapshotForArchive"
  | "restoreSnapshotAfterUnarchive"
  | "getUnsupportedUntrackedPaths"
>;
// Trim and normalize a heartbeat message for storage. Accepts `unknown` so it safely handles
// both user input (string | undefined) and persisted config values that may have been corrupted.
function isWorkflowInvocationMessage(message: MuxMessage, runId: string): boolean {
  if (
    message.metadata?.muxMetadata?.type === WORKFLOW_RUN_CARD_DISPLAY_METADATA_TYPE &&
    message.metadata.muxMetadata.runId === runId
  ) {
    return true;
  }

  return message.parts.some((part) => {
    // A workflow_resume call re-attaches the agent to an existing run, so it counts as the
    // current invocation for background-continuation supersession checks too.
    if (part.type !== "dynamic-tool" || !isWorkflowRunEmittingToolName(part.toolName)) {
      return false;
    }
    if (part.state !== "output-available") {
      return false;
    }
    const output = part.output;
    return (
      output != null &&
      typeof output === "object" &&
      (output as Record<string, unknown>).runId === runId
    );
  });
}

function isTerminalWorkflowToolResultMessage(message: MuxMessage, runId: string): boolean {
  return message.parts.some(
    (part) =>
      part.type === "dynamic-tool" &&
      part.state === "output-available" &&
      isTerminalWorkflowRunToolOutput(part.toolName, part.output, runId)
  );
}

function isInternalResumeAutoCompactionMessage(message: MuxMessage): boolean {
  const muxMetadata = message.metadata?.muxMetadata;
  if (muxMetadata?.type !== "compaction-request" || muxMetadata.source !== "auto-compaction") {
    return false;
  }
  return muxMetadata.parsed.followUpContent?.dispatchOptions?.source === "internal-resume";
}

function isSyntheticManualSupersessionMessage(message: MuxMessage): boolean {
  const muxMetadata = message.metadata?.muxMetadata;
  return (
    message.metadata?.synthetic === true &&
    muxMetadata?.type === "compaction-request" &&
    muxMetadata.source === "auto-compaction" &&
    !isInternalResumeAutoCompactionMessage(message)
  );
}

function isManualUserSupersessionMessage(message: MuxMessage): boolean {
  return (
    message.role === "user" &&
    (message.metadata?.synthetic !== true || isSyntheticManualSupersessionMessage(message))
  );
}

function isWorkflowResultContinuationMessage(message: MuxMessage, runId: string): boolean {
  return (
    message.metadata?.muxMetadata?.type === WORKFLOW_RESULT_METADATA_TYPE &&
    message.metadata.muxMetadata.runId === runId
  );
}

/**
 * The terminal-attention drain delivers workflow results as one synthetic user prompt that may
 * coalesce several runs, so it carries no per-run workflow-result metadata. If a crash lands
 * between the send's durable acceptance and the settled-marker write, the next sweep re-queues
 * the run; recognizing the accepted row as consumption is what settles it without a re-send.
 * Only synthetic rows qualify: a manual user message is a supersession boundary and is
 * classified before this check runs.
 */
function isCoalescedWorkflowResultMessage(message: MuxMessage, runId: string): boolean {
  if (message.role !== "user" || message.metadata?.synthetic !== true) {
    return false;
  }
  return message.parts.some(
    (part) => part.type === "text" && textContainsWorkflowResultPayload(part.text, runId)
  );
}

function isResetBoundaryMessage(message: MuxMessage): boolean {
  return message.metadata?.contextBoundaryKind === CONTEXT_BOUNDARY_KINDS.RESET;
}

function isFailedWorkflowRunSnapshot(value: unknown, runId: string): boolean {
  if (value == null || typeof value !== "object") {
    return false;
  }
  const record = value as Record<string, unknown>;
  return record.id === runId && record.status === "failed";
}

function isTerminalWorkflowTaskAwaitRecord(
  record: Record<string, unknown>,
  runId: string
): boolean {
  if (record.taskId !== runId) {
    return false;
  }
  if (record.status === "completed" || record.status === "interrupted") {
    return true;
  }
  if (record.status === "error") {
    return isFailedWorkflowRunSnapshot(record.run, runId);
  }
  return false;
}

function isTerminalWorkflowTaskAwaitResultMessage(message: MuxMessage, runId: string): boolean {
  if (message.role !== "assistant") {
    return false;
  }

  return message.parts.some((part) => {
    if (part.type !== "dynamic-tool" || part.toolName !== "task_await") {
      return false;
    }
    if (part.state !== "output-available") {
      return false;
    }
    const output = part.output;
    if (output == null || typeof output !== "object") {
      return false;
    }
    const results = (output as Record<string, unknown>).results;
    if (!Array.isArray(results)) {
      return false;
    }
    return results.some((result) => {
      if (result == null || typeof result !== "object") {
        return false;
      }
      return isTerminalWorkflowTaskAwaitRecord(result as Record<string, unknown>, runId);
    });
  });
}

function sanitizeHeartbeatMessage(message: unknown): string | undefined {
  if (typeof message !== "string") {
    return undefined;
  }

  const trimmedMessage = message.trim();
  if (trimmedMessage.length === 0) {
    return undefined;
  }

  return trimmedMessage;
}

function isHeartbeatContextMode(value: unknown): value is HeartbeatContextMode {
  return (
    typeof value === "string" &&
    HEARTBEAT_CONTEXT_MODE_VALUES.some((candidate) => candidate === value)
  );
}

function sanitizeHeartbeatContextMode(value: unknown): HeartbeatContextMode {
  return isHeartbeatContextMode(value) ? value : HEARTBEAT_DEFAULT_CONTEXT_MODE;
}

function sanitizeHeartbeatIntervalMs(intervalMs: unknown, defaultIntervalMs: number): number {
  assert(
    Number.isInteger(defaultIntervalMs) &&
      defaultIntervalMs >= HEARTBEAT_MIN_INTERVAL_MS &&
      defaultIntervalMs <= HEARTBEAT_MAX_INTERVAL_MS,
    "sanitizeHeartbeatIntervalMs requires a supported default interval"
  );

  if (
    typeof intervalMs === "number" &&
    Number.isInteger(intervalMs) &&
    intervalMs >= HEARTBEAT_MIN_INTERVAL_MS &&
    intervalMs <= HEARTBEAT_MAX_INTERVAL_MS
  ) {
    return intervalMs;
  }

  return defaultIntervalMs;
}

function normalizeHeartbeatSettings(
  settings: Partial<WorkspaceHeartbeatSettings> | null | undefined,
  defaultIntervalMs: number
): WorkspaceHeartbeatSettings | null {
  if (!settings) {
    return null;
  }

  const message = sanitizeHeartbeatMessage(settings.message);
  return {
    enabled: settings.enabled === true,
    intervalMs: sanitizeHeartbeatIntervalMs(settings.intervalMs, defaultIntervalMs),
    contextMode: sanitizeHeartbeatContextMode(settings.contextMode),
    ...(message != null ? { message } : {}),
    // trigger/whenBusy stay sparse: unset values are never materialized so read-time
    // defaulting (resolveHeartbeatSchedulePolicy) keeps working and "never touched"
    // remains distinguishable from an explicit choice.
    ...(isHeartbeatTrigger(settings.trigger) ? { trigger: settings.trigger } : {}),
    ...(isHeartbeatWhenBusy(settings.whenBusy) ? { whenBusy: settings.whenBusy } : {}),
    ...(isValidHeartbeatScheduleUpdatedAt(settings.scheduleUpdatedAt)
      ? { scheduleUpdatedAt: settings.scheduleUpdatedAt }
      : {}),
  };
}

interface WorkspaceAgentStatus {
  emoji: string;
  message: string;
  url?: string;
}
type WorkspaceRuntimeStatus = "running" | "stopped" | "unknown" | "unsupported";

/** Narrow DevTools cleanup surface used on archive/remove and by the startup sweep. */
type WorkspaceDevToolsCleanup = Pick<DevToolsService, "hasWorkspaceData" | "removeWorkspaceData">;
/**
 * Narrow overrides surface: stale plugin-key sanitization on registration,
 * fork-time copy, and the per-workspace lock rename holds across its checkout move.
 */
type WorkspaceServiceMcpOverridesPort = Pick<
  WorkspaceMcpOverridesService,
  "prunePluginOverrideKeys" | "copyOverridesToForkedCheckout" | "acquireWorkspaceLock"
>;
const POST_COMPACTION_METADATA_REFRESH_DEBOUNCE_MS = 100;

const DESCENDANT_WORKSPACE_REMOVE_ERROR =
  "This workspace has descendant sub-agent workspaces. Remove those descendants deepest-first before removing their parent.";
const ACTIVE_DESCENDANT_ARCHIVE_ERROR =
  "This workspace has active descendant sub-agents. Stop them before archiving their parent.";
const MULTI_PROJECT_WORKSPACES_DISABLED_ERROR = "Multi-project workspaces experiment is disabled";

function normalizeRepoRootProjectPath(projectPath: string | null | undefined): string {
  const normalizedPath = projectPath?.replaceAll("\\", "/").trim() ?? "";
  if (!normalizedPath) {
    return "";
  }

  return stripTrailingSlashes(path.posix.normalize(normalizedPath));
}

function buildArchiveLossyUntrackedFilesConfirmation(
  paths: readonly string[]
): ArchiveLossyUntrackedFilesConfirmation {
  const normalizedPaths = normalizeArchiveUntrackedPaths(paths);
  assert(
    normalizedPaths.length > 0,
    "buildArchiveLossyUntrackedFilesConfirmation: expected at least one untracked path"
  );
  return {
    kind: "confirm-lossy-untracked-files",
    paths: normalizedPaths,
  };
}

function isArchiveLossyUntrackedFilesConfirmation(
  value: unknown
): value is ArchiveLossyUntrackedFilesConfirmation {
  if (typeof value !== "object" || value === null) {
    return false;
  }

  const maybeConfirmation: { kind?: unknown; paths?: unknown } = value;
  return (
    maybeConfirmation.kind === "confirm-lossy-untracked-files" &&
    Array.isArray(maybeConfirmation.paths) &&
    maybeConfirmation.paths.every((path) => typeof path === "string")
  );
}

const WORKSPACE_IDLE_WAIT_CANCELED_MESSAGE =
  "Workflow start canceled while waiting for workspace to become idle.";

// Returned by sendMessage when an idle-only (requireIdle) send is skipped because the
// workspace became active. This is an expected race, not a compaction failure, so the
// idle-compaction loop must not count it toward suppression.
const IDLE_ONLY_BUSY_SKIP_MESSAGE = "Workspace is busy; idle-only send was skipped.";
const BASH_MONITOR_PERSIST_RETRY_DELAYS_MS = [50, 200] as const;

/** Returned when a caller-supplied admission probe (internal.admissionStale) flips mid-send. */
const SEND_ADMISSION_STALE_MESSAGE =
  "Send refused: the target was stopped or interrupted while the message was being admitted.";

async function waitForAgentSessionIdle(session: AgentSession, signal?: AbortSignal): Promise<void> {
  assert(session instanceof AgentSession, "waitForAgentSessionIdle requires an AgentSession");
  try {
    await session.waitForIdle(signal);
  } catch (error) {
    if (signal?.aborted === true) {
      throw new Error(WORKSPACE_IDLE_WAIT_CANCELED_MESSAGE);
    }
    throw new Error(getErrorMessage(error));
  }
}

interface FileCompletionsCacheEntry {
  index: FileCompletionsIndex;
  fetchedAt: number;
  refreshing?: Promise<void>;
}

function parseFileCompletionPaths(stdout: string): string[] {
  return (
    stdout
      .split("\n")
      .map((line) => line.trim())
      // File @mentions are whitespace-delimited, so we exclude spaced paths from autocomplete.
      .filter((filePath) => Boolean(filePath) && !/\s/.test(filePath))
  );
}

interface ArchiveMergedInProjectResult {
  archivedWorkspaceIds: string[];
  skippedWorkspaceIds: string[];
  errors: Array<{ workspaceId: string; error: string }>;
}

interface ProjectGitStatusResult {
  projectPath: string;
  projectName: string;
  gitStatus: GitStatus | null;
  error: string | null;
}

interface ExecuteBashOptions {
  timeout_secs?: number | null;
  cwdMode?: "default" | "repo-root" | null;
  repoRootProjectPath?: string | null;
}

/**
 * Checks if an error indicates a workspace name collision
 */
function isWorkspaceNameCollision(error: string | undefined): boolean {
  return error?.includes("Workspace already exists") ?? false;
}

/**
 * Generates a unique workspace name by appending a random suffix
 */
function appendCollisionSuffix(baseName: string): string {
  const suffix = Math.random().toString(36).substring(2, 6);
  return `${baseName}-${suffix}`;
}

const MAX_REGENERATE_TITLE_RECENT_TURNS = 3;

interface WorkspaceTitleContextTurn {
  role: "user" | "assistant";
  text: string;
}

interface WorkspaceTitleConversationContext {
  conversationContext: string | undefined;
  latestUserText: string | undefined;
}

function extractMuxMessageText(message: MuxMessage): string {
  const text =
    message.parts
      ?.filter((part) => part.type === "text")
      .map((part) => part.text.trim())
      .filter((partText) => partText.length > 0)
      .join("\n") ?? "";
  return text;
}

function collectWorkspaceTitleContextTurns(
  messages: readonly MuxMessage[]
): WorkspaceTitleContextTurn[] {
  const turns: WorkspaceTitleContextTurn[] = [];

  for (const message of messages) {
    if (message.role !== "user" && message.role !== "assistant") {
      continue;
    }

    const text = extractMuxMessageText(message);
    if (!text) {
      continue;
    }

    turns.push({ role: message.role, text });
  }

  return turns;
}

function formatWorkspaceTitleContextTurns(turns: readonly WorkspaceTitleContextTurn[]): string {
  return turns
    .map(
      (turn, index) =>
        `Turn ${index + 1} (${turn.role === "user" ? "User" : "Assistant"}):\n${turn.text}`
    )
    .join("\n\n");
}

function buildWorkspaceTitleConversationContext(
  turns: readonly WorkspaceTitleContextTurn[]
): WorkspaceTitleConversationContext {
  const firstUserIndex = turns.findIndex((turn) => turn.role === "user");

  let latestUserText: string | undefined;
  for (let i = turns.length - 1; i >= 0; i--) {
    if (turns[i].role === "user") {
      latestUserText = turns[i].text;
      break;
    }
  }

  const selectedIndexes = new Set<number>();
  if (firstUserIndex >= 0) {
    selectedIndexes.add(firstUserIndex);
  }
  const recentStartIndex = Math.max(0, turns.length - MAX_REGENERATE_TITLE_RECENT_TURNS);
  for (let i = recentStartIndex; i < turns.length; i++) {
    selectedIndexes.add(i);
  }

  const selectedTurns = [...selectedIndexes].sort((a, b) => a - b).map((index) => turns[index]);
  const omittedTurns = turns.length - selectedTurns.length;

  // If there is only the first user message, avoid adding a redundant conversation block.
  if (selectedTurns.length <= 1 && omittedTurns === 0) {
    return { conversationContext: undefined, latestUserText };
  }

  const formattedTurns = formatWorkspaceTitleContextTurns(selectedTurns);
  const omissionSummary =
    omittedTurns > 0
      ? `Note: ${omittedTurns} earlier conversation turn${omittedTurns === 1 ? "" : "s"} omitted for brevity.`
      : undefined;

  return {
    conversationContext: omissionSummary
      ? `${omissionSummary}\n\n${formattedTurns}`
      : formattedTurns,
    latestUserText,
  };
}

/**
 * Find the highest sequential number among items that match `prefix<digits>trailingSuffix`.
 * Returns 0 when no items match.
 */
function findMaxSequentialNumber(items: string[], prefix: string, trailingSuffix = ""): number {
  let max = 0;
  for (const item of items) {
    if (!item.startsWith(prefix)) continue;
    if (trailingSuffix && !item.endsWith(trailingSuffix)) continue;

    const numberStr = trailingSuffix
      ? item.slice(prefix.length, -trailingSuffix.length)
      : item.slice(prefix.length);
    if (!/^\d+$/.test(numberStr)) continue;

    const n = Number(numberStr);
    if (n > max) max = n;
  }
  return max;
}

function deriveForkFamilyBaseName(metadata: { name: string; forkFamilyBaseName?: string }): string {
  if (metadata.forkFamilyBaseName) {
    return metadata.forkFamilyBaseName;
  }

  const legacyForkMatch = /^(.*)-fork-\d+$/.exec(metadata.name);
  if (legacyForkMatch) {
    return legacyForkMatch[1];
  }

  return metadata.name;
}

/**
 * Generate a unique fork branch name from a stable fork family base name.
 * Scans existing workspace names for both the new `{base}-{N}` pattern and the legacy
 * `{base}-fork-{N}` pattern so numbering continues cleanly across upgrades.
 */
export function generateForkBranchName(
  forkFamilyBaseName: string,
  existingNames: string[]
): string {
  const nextForkNumber = Math.max(
    findMaxSequentialNumber(existingNames, `${forkFamilyBaseName}-`),
    findMaxSequentialNumber(existingNames, `${forkFamilyBaseName}-fork-`)
  );
  return `${forkFamilyBaseName}-${nextForkNumber + 1}`;
}

/**
 * Generate a forked workspace title by appending a " (N)" suffix to the parent title.
 * Scans existing titles in the same project to pick the next available number.
 */
export function generateForkTitle(parentTitle: string, existingTitles: string[]): string {
  // Strip any existing " (N)" suffix from the parent title to get the base
  const base = parentTitle.replace(/ \(\d+\)$/, "");
  const prefix = `${base} (`;
  // If parent title itself exists in the list (without suffix), start at (1)
  // Otherwise continue from the highest found suffix
  return `${base} (${findMaxSequentialNumber(existingTitles, prefix, ")") + 1})`;
}

async function copyIfExists(sourcePath: string, destinationPath: string): Promise<void> {
  try {
    await fsPromises.copyFile(sourcePath, destinationPath);
  } catch (error) {
    if (!isErrnoWithCode(error, "ENOENT")) {
      throw error;
    }
  }
}

async function resetForkedSessionUsage(
  sessionUsageService: SessionUsageService | undefined,
  workspaceId: string,
  sessionDir: string
): Promise<void> {
  if (sessionUsageService) {
    await sessionUsageService.resetSessionUsage(workspaceId);
    return;
  }

  await fsPromises.writeFile(
    path.join(sessionDir, "session-usage.json"),
    JSON.stringify({ byModel: {}, version: 1 }, null, 2)
  );
}

async function materializeForkedPartialSnapshot(params: {
  historyService: HistoryService;
  partialSnapshot: MuxMessage | null;
  sourceWorkspaceId: string;
  targetWorkspaceId: string;
}): Promise<void> {
  if (!params.partialSnapshot) {
    return;
  }

  // Forking must be read-only with respect to the source workspace. During tool calls
  // such as task_await, deleting or committing the source partial can make the live
  // parent turn look interrupted. Instead, copy the partial into the fork and finalize
  // only that snapshot so the child has no inherited live-stream state. The snapshot
  // is captured before fork checkout/copy I/O so a parent stream that finishes mid-fork
  // cannot make the child miss the latest visible assistant state.
  const writeResult = await params.historyService.writePartial(
    params.targetWorkspaceId,
    params.partialSnapshot
  );
  if (!writeResult.success) {
    log.warn("Failed to snapshot source partial into fork", {
      sourceWorkspaceId: params.sourceWorkspaceId,
      targetWorkspaceId: params.targetWorkspaceId,
      error: writeResult.error,
    });
    return;
  }

  const commitResult = await params.historyService.commitPartial(params.targetWorkspaceId);
  if (!commitResult.success) {
    log.warn("Failed to finalize forked partial snapshot", {
      sourceWorkspaceId: params.sourceWorkspaceId,
      targetWorkspaceId: params.targetWorkspaceId,
      error: commitResult.error,
    });
    await params.historyService.deletePartial(params.targetWorkspaceId);
  }
}

function getOldestSequencedMessage(
  messages: readonly MuxMessage[]
): { message: MuxMessage; historySequence: number } | null {
  let oldest: { message: MuxMessage; historySequence: number } | null = null;

  for (const message of messages) {
    const historySequence = message.metadata?.historySequence;
    if (!isNonNegativeInteger(historySequence)) {
      continue;
    }

    if (oldest === null || historySequence < oldest.historySequence) {
      oldest = { message, historySequence };
    }
  }

  return oldest;
}

interface WorkspaceHistoryLoadMoreCursor {
  beforeHistorySequence: number;
  beforeMessageId?: string | null;
}

interface WorkspaceHistoryLoadMoreResult {
  messages: WorkspaceChatMessage[];
  nextCursor: WorkspaceHistoryLoadMoreCursor | null;
  hasOlder: boolean;
}

function isCompactedSummaryMessage(message: MuxMessage): boolean {
  return isDurableCompactedMarker(message.metadata?.compacted);
}

function getNextCompactionEpochForAppendBoundary(
  workspaceId: string,
  messages: MuxMessage[]
): number {
  let epochCursor = 0;

  for (const message of messages) {
    const metadata = message.metadata;
    if (!metadata) {
      continue;
    }

    const isCompactedSummary = isCompactedSummaryMessage(message);
    const hasBoundaryMarker = metadata.compactionBoundary === true;
    const epoch = metadata.compactionEpoch;

    if (hasBoundaryMarker && !isCompactedSummary) {
      // Self-healing read path: skip malformed persisted boundary markers.
      // Boundary markers are only valid on compacted summaries.
      log.warn("Skipping malformed compaction boundary while deriving next epoch", {
        workspaceId,
        messageId: message.id,
        reason: "compactionBoundary set on non-compacted message",
      });
      continue;
    }

    if (!isCompactedSummary) {
      continue;
    }

    if (hasBoundaryMarker) {
      if (!isPositiveInteger(epoch)) {
        // Self-healing read path: invalid boundary metadata should not brick compaction.
        log.warn("Skipping malformed compaction boundary while deriving next epoch", {
          workspaceId,
          messageId: message.id,
          reason: "compactionBoundary missing positive integer compactionEpoch",
        });
        continue;
      }
      epochCursor = Math.max(epochCursor, epoch);
      continue;
    }

    if (epoch === undefined) {
      // Legacy compacted summaries predate compactionEpoch metadata.
      epochCursor += 1;
      continue;
    }

    if (!isPositiveInteger(epoch)) {
      // Self-healing read path: malformed compactionEpoch should not crash compaction.
      log.warn("Skipping malformed compactionEpoch while deriving next epoch", {
        workspaceId,
        messageId: message.id,
        reason: "compactionEpoch must be a positive integer when present",
      });
      continue;
    }

    epochCursor = Math.max(epochCursor, epoch);
  }

  const nextEpoch = epochCursor + 1;
  assert(nextEpoch > 0, "next compaction epoch must be positive");
  return nextEpoch;
}

async function copyFileBestEffort(params: {
  srcPath: string;
  destPath: string;
  logContext: Record<string, unknown>;
}): Promise<boolean> {
  try {
    await fsPromises.mkdir(path.dirname(params.destPath), { recursive: true });
    await fsPromises.copyFile(params.srcPath, params.destPath);
    return true;
  } catch (error: unknown) {
    if (isErrnoWithCode(error, "ENOENT")) {
      return false;
    }

    log.error("Failed to copy session artifact file", {
      ...params.logContext,
      srcPath: params.srcPath,
      destPath: params.destPath,
      error: getErrorMessage(error),
    });
    return false;
  }
}

/**
 * Concatenate source files (skipping missing ones) into destPath.
 * Returns false when no source exists or on write failure.
 */
async function concatFilesBestEffort(params: {
  srcPaths: string[];
  destPath: string;
  logContext: Record<string, unknown>;
}): Promise<boolean> {
  const chunks: Buffer[] = [];
  for (const srcPath of params.srcPaths) {
    try {
      chunks.push(await fsPromises.readFile(srcPath));
    } catch (error: unknown) {
      if (!isErrnoWithCode(error, "ENOENT")) {
        log.error("Failed to read session artifact file for concatenation", {
          ...params.logContext,
          srcPath,
          error: getErrorMessage(error),
        });
      }
    }
  }

  if (chunks.length === 0) {
    return false;
  }

  try {
    await fsPromises.mkdir(path.dirname(params.destPath), { recursive: true });
    await fsPromises.writeFile(params.destPath, Buffer.concat(chunks));
    return true;
  } catch (error: unknown) {
    log.error("Failed to write concatenated session artifact file", {
      ...params.logContext,
      destPath: params.destPath,
      error: getErrorMessage(error),
    });
    return false;
  }
}

async function copyDirIfMissingBestEffort(params: {
  srcDir: string;
  destDir: string;
  logContext: Record<string, unknown>;
}): Promise<void> {
  try {
    try {
      const stat = await fsPromises.stat(params.destDir);
      if (stat.isDirectory()) {
        return;
      }
      // If it's a file, fall through and try to copy (will likely fail).
    } catch (error: unknown) {
      if (!isErrnoWithCode(error, "ENOENT")) {
        throw error;
      }
    }

    await fsPromises.mkdir(path.dirname(params.destDir), { recursive: true });
    await fsPromises.cp(params.srcDir, params.destDir, { recursive: true });
  } catch (error: unknown) {
    if (isErrnoWithCode(error, "ENOENT")) {
      return;
    }

    log.error("Failed to copy session artifact directory", {
      ...params.logContext,
      srcDir: params.srcDir,
      destDir: params.destDir,
      error: getErrorMessage(error),
    });
  }
}

function coerceUpdatedAtMs(entry: { createdAtMs?: number; updatedAtMs?: number }): number {
  if (typeof entry.updatedAtMs === "number" && Number.isFinite(entry.updatedAtMs)) {
    return entry.updatedAtMs;
  }

  if (typeof entry.createdAtMs === "number" && Number.isFinite(entry.createdAtMs)) {
    return entry.createdAtMs;
  }

  return 0;
}

function rollUpAncestorWorkspaceIds(params: {
  ancestorWorkspaceIds: string[];
  removedWorkspaceId: string;
  newParentWorkspaceId: string;
}): string[] {
  const filtered = params.ancestorWorkspaceIds.filter((id) => id !== params.removedWorkspaceId);

  // Ensure the roll-up target is first (parent-first ordering).
  if (filtered[0] === params.newParentWorkspaceId) {
    return filtered;
  }

  return [
    params.newParentWorkspaceId,
    ...filtered.filter((id) => id !== params.newParentWorkspaceId),
  ];
}

async function collectReferencedStagedAttachmentPaths(sessionDir: string): Promise<string[]> {
  const paths = new Set<string>();
  for (const fileName of [CHAT_ARCHIVE_FILE_NAME, CHAT_FILE_NAME, "partial.json"] as const) {
    try {
      const content = await fsPromises.readFile(path.join(sessionDir, fileName), "utf8");
      for (const stagedPath of extractStagedAttachmentPathsFromText(content)) {
        paths.add(stagedPath);
      }
    } catch (error) {
      if (!isErrnoWithCode(error, "ENOENT")) {
        throw error;
      }
    }
  }
  return [...paths];
}

async function archiveChildSessionArtifactsIntoParentSessionDir(params: {
  parentWorkspaceId: string;
  parentSessionDir: string;
  childWorkspaceId: string;
  childSessionDir: string;
  /** Task-level model string for the child workspace (optional; persists into transcript artifacts). */
  childTaskModelString?: string;
  /** Task-level thinking/reasoning level for the child workspace (optional; persists into transcript artifacts). */
  childTaskThinkingLevel?: ThinkingLevel;
}): Promise<void> {
  if (params.parentWorkspaceId.length === 0) {
    return;
  }

  if (params.childWorkspaceId.length === 0) {
    return;
  }

  if (params.parentSessionDir.length === 0 || params.childSessionDir.length === 0) {
    return;
  }

  // 1) Archive the child session transcript (chat.jsonl + partial.json) into the parent session dir
  // BEFORE deleting ~/.xum/sessions/<childWorkspaceId>.
  try {
    const childChatPath = path.join(params.childSessionDir, CHAT_FILE_NAME);
    const childChatArchivePath = path.join(params.childSessionDir, CHAT_ARCHIVE_FILE_NAME);
    const childPartialPath = path.join(params.childSessionDir, "partial.json");

    const archivedChatPath = getSubagentTranscriptChatPath(
      params.parentSessionDir,
      params.childWorkspaceId
    );
    const archivedPartialPath = getSubagentTranscriptPartialPath(
      params.parentSessionDir,
      params.childWorkspaceId
    );

    // Defensive: avoid path traversal in workspace IDs.
    if (!isPathInsideDir(params.parentSessionDir, archivedChatPath)) {
      log.error("Refusing to archive session transcript outside parent session dir", {
        parentWorkspaceId: params.parentWorkspaceId,
        childWorkspaceId: params.childWorkspaceId,
        parentSessionDir: params.parentSessionDir,
        archivedChatPath,
      });
    } else {
      // Sub-agent sessions can auto-compact, which rotates sealed history into
      // chat-archive.jsonl. The archived transcript is a one-time snapshot of a
      // dead workspace, so concatenate archive + active file into a single
      // chat.jsonl for the transcript reader.
      const didCopyChat = await concatFilesBestEffort({
        srcPaths: [childChatArchivePath, childChatPath],
        destPath: archivedChatPath,
        logContext: {
          parentWorkspaceId: params.parentWorkspaceId,
          childWorkspaceId: params.childWorkspaceId,
          artifact: "chat.jsonl",
        },
      });

      const didCopyPartial = await copyFileBestEffort({
        srcPath: childPartialPath,
        destPath: archivedPartialPath,
        logContext: {
          parentWorkspaceId: params.parentWorkspaceId,
          childWorkspaceId: params.childWorkspaceId,
          artifact: "partial.json",
        },
      });

      const childMetadataPath = path.join(params.childSessionDir, "metadata.json");
      const archivedMetadataPath = path.join(
        params.parentSessionDir,
        "subagent-transcripts",
        params.childWorkspaceId,
        "metadata.json"
      );
      await copyFileBestEffort({
        srcPath: childMetadataPath,
        destPath: archivedMetadataPath,
        logContext: {
          parentWorkspaceId: params.parentWorkspaceId,
          childWorkspaceId: params.childWorkspaceId,
          artifact: "metadata.json",
        },
      });

      // Headless usage (status generation, memory sweeps) has no chat row;
      // the archived sidecar is the only way the analytics ETL can restore
      // that spend after clearWorkspace deletes the child's event rows.
      await copyFileBestEffort({
        srcPath: path.join(params.childSessionDir, HEADLESS_USAGE_FILE_NAME),
        destPath: path.join(
          params.parentSessionDir,
          "subagent-transcripts",
          params.childWorkspaceId,
          HEADLESS_USAGE_FILE_NAME
        ),
        logContext: {
          parentWorkspaceId: params.parentWorkspaceId,
          childWorkspaceId: params.childWorkspaceId,
          artifact: HEADLESS_USAGE_FILE_NAME,
        },
      });

      if (didCopyChat || didCopyPartial) {
        const nowMs = Date.now();

        const model =
          typeof params.childTaskModelString === "string" &&
          params.childTaskModelString.trim().length > 0
            ? params.childTaskModelString.trim()
            : undefined;
        const thinkingLevel = coerceThinkingLevel(params.childTaskThinkingLevel);

        await upsertSubagentTranscriptArtifactIndexEntry({
          workspaceId: params.parentWorkspaceId,
          workspaceSessionDir: params.parentSessionDir,
          childTaskId: params.childWorkspaceId,
          updater: (existing) => ({
            childTaskId: params.childWorkspaceId,
            parentWorkspaceId: params.parentWorkspaceId,
            createdAtMs: existing?.createdAtMs ?? nowMs,
            updatedAtMs: nowMs,
            model: model ?? existing?.model,
            thinkingLevel: thinkingLevel ?? existing?.thinkingLevel,
            chatPath: didCopyChat ? archivedChatPath : existing?.chatPath,
            partialPath: didCopyPartial ? archivedPartialPath : existing?.partialPath,
          }),
        });
      }
    }
  } catch (error: unknown) {
    log.error("Failed to archive child transcript into parent session dir", {
      parentWorkspaceId: params.parentWorkspaceId,
      childWorkspaceId: params.childWorkspaceId,
      error: getErrorMessage(error),
    });
  }

  // 2) Roll up nested subagent artifacts from the child session dir into the parent session dir.
  // This preserves grandchild artifacts when intermediate subagent workspaces are cleaned up.

  // --- subagent-patches.json + subagent-patches/<taskId>/...
  try {
    const childArtifacts = await readSubagentGitPatchArtifactsFile(params.childSessionDir);
    const childEntries = Object.entries(childArtifacts.artifactsByChildTaskId);

    for (const [taskId, childEntry] of childEntries) {
      if (!taskId) continue;

      for (const projectArtifact of childEntry.projectArtifacts) {
        if (!projectArtifact.mboxPath) {
          continue;
        }

        const srcDir = path.dirname(projectArtifact.mboxPath);
        const destDir = path.dirname(
          getSubagentGitPatchMboxPath(params.parentSessionDir, taskId, projectArtifact.storageKey)
        );

        if (!isPathInsideDir(params.childSessionDir, srcDir)) {
          log.error("Refusing to roll up patch artifact outside child session dir", {
            parentWorkspaceId: params.parentWorkspaceId,
            childWorkspaceId: params.childWorkspaceId,
            taskId,
            childSessionDir: params.childSessionDir,
            srcDir,
          });
          continue;
        }

        if (!isPathInsideDir(params.parentSessionDir, destDir)) {
          log.error("Refusing to roll up patch artifact outside parent session dir", {
            parentWorkspaceId: params.parentWorkspaceId,
            childWorkspaceId: params.childWorkspaceId,
            taskId,
            parentSessionDir: params.parentSessionDir,
            destDir,
          });
          continue;
        }

        await copyDirIfMissingBestEffort({
          srcDir,
          destDir,
          logContext: {
            parentWorkspaceId: params.parentWorkspaceId,
            childWorkspaceId: params.childWorkspaceId,
            artifact: "subagent-patches",
            taskId,
            projectPath: projectArtifact.projectPath,
          },
        });
      }
    }

    if (childEntries.length > 0) {
      await updateSubagentGitPatchArtifactsFile({
        workspaceId: params.parentWorkspaceId,
        workspaceSessionDir: params.parentSessionDir,
        update: (parentFile) => {
          for (const [taskId, childEntry] of childEntries) {
            if (!taskId) continue;
            const existing = parentFile.artifactsByChildTaskId[taskId] ?? null;

            const childUpdated = coerceUpdatedAtMs(childEntry);
            const existingUpdated = existing ? coerceUpdatedAtMs(existing) : -1;

            if (!existing || childUpdated > existingUpdated) {
              parentFile.artifactsByChildTaskId[taskId] = {
                ...childEntry,
                childTaskId: taskId,
                parentWorkspaceId: params.parentWorkspaceId,
                projectArtifacts: childEntry.projectArtifacts.map((projectArtifact) => ({
                  ...projectArtifact,
                  mboxPath: projectArtifact.mboxPath
                    ? getSubagentGitPatchMboxPath(
                        params.parentSessionDir,
                        taskId,
                        projectArtifact.storageKey
                      )
                    : undefined,
                })),
              };
            }
          }
        },
      });
    }
  } catch (error: unknown) {
    log.error("Failed to roll up subagent patch artifacts into parent", {
      parentWorkspaceId: params.parentWorkspaceId,
      childWorkspaceId: params.childWorkspaceId,
      error: getErrorMessage(error),
    });
  }

  // --- subagent-reports.json + subagent-reports/<taskId>/...
  try {
    const childArtifacts = await readSubagentReportArtifactsFile(params.childSessionDir);
    const childEntries = Object.entries(childArtifacts.artifactsByChildTaskId);

    for (const [taskId] of childEntries) {
      if (!taskId) continue;

      const srcDir = path.dirname(getSubagentReportArtifactPath(params.childSessionDir, taskId));
      const destDir = path.dirname(getSubagentReportArtifactPath(params.parentSessionDir, taskId));

      if (!isPathInsideDir(params.childSessionDir, srcDir)) {
        log.error("Refusing to roll up report artifact outside child session dir", {
          parentWorkspaceId: params.parentWorkspaceId,
          childWorkspaceId: params.childWorkspaceId,
          taskId,
          childSessionDir: params.childSessionDir,
          srcDir,
        });
        continue;
      }

      if (!isPathInsideDir(params.parentSessionDir, destDir)) {
        log.error("Refusing to roll up report artifact outside parent session dir", {
          parentWorkspaceId: params.parentWorkspaceId,
          childWorkspaceId: params.childWorkspaceId,
          taskId,
          parentSessionDir: params.parentSessionDir,
          destDir,
        });
        continue;
      }

      await copyDirIfMissingBestEffort({
        srcDir,
        destDir,
        logContext: {
          parentWorkspaceId: params.parentWorkspaceId,
          childWorkspaceId: params.childWorkspaceId,
          artifact: "subagent-reports",
          taskId,
        },
      });
    }

    if (childEntries.length > 0) {
      await updateSubagentReportArtifactsFile({
        workspaceId: params.parentWorkspaceId,
        workspaceSessionDir: params.parentSessionDir,
        update: (parentFile) => {
          for (const [taskId, childEntry] of childEntries) {
            if (!taskId) continue;

            const existing = parentFile.artifactsByChildTaskId[taskId] ?? null;
            const childUpdated = coerceUpdatedAtMs(childEntry);
            const existingUpdated = existing ? coerceUpdatedAtMs(existing) : -1;

            if (!existing || childUpdated > existingUpdated) {
              parentFile.artifactsByChildTaskId[taskId] = {
                ...childEntry,
                childTaskId: taskId,
                parentWorkspaceId: params.parentWorkspaceId,
                ancestorWorkspaceIds: rollUpAncestorWorkspaceIds({
                  ancestorWorkspaceIds: childEntry.ancestorWorkspaceIds,
                  removedWorkspaceId: params.childWorkspaceId,
                  newParentWorkspaceId: params.parentWorkspaceId,
                }),
              };
            }
          }
        },
      });
    }
  } catch (error: unknown) {
    log.error("Failed to roll up subagent report artifacts into parent", {
      parentWorkspaceId: params.parentWorkspaceId,
      childWorkspaceId: params.childWorkspaceId,
      error: getErrorMessage(error),
    });
  }

  // --- subagent-transcripts.json + subagent-transcripts/<taskId>/...
  try {
    const childArtifacts = await readSubagentTranscriptArtifactsFile(params.childSessionDir);
    const childEntries = Object.entries(childArtifacts.artifactsByChildTaskId);

    for (const [taskId] of childEntries) {
      if (!taskId) continue;

      const srcDir = path.dirname(getSubagentTranscriptChatPath(params.childSessionDir, taskId));
      const destDir = path.dirname(getSubagentTranscriptChatPath(params.parentSessionDir, taskId));

      if (!isPathInsideDir(params.childSessionDir, srcDir)) {
        log.error("Refusing to roll up transcript artifact outside child session dir", {
          parentWorkspaceId: params.parentWorkspaceId,
          childWorkspaceId: params.childWorkspaceId,
          taskId,
          childSessionDir: params.childSessionDir,
          srcDir,
        });
        continue;
      }

      if (!isPathInsideDir(params.parentSessionDir, destDir)) {
        log.error("Refusing to roll up transcript artifact outside parent session dir", {
          parentWorkspaceId: params.parentWorkspaceId,
          childWorkspaceId: params.childWorkspaceId,
          taskId,
          parentSessionDir: params.parentSessionDir,
          destDir,
        });
        continue;
      }

      await copyDirIfMissingBestEffort({
        srcDir,
        destDir,
        logContext: {
          parentWorkspaceId: params.parentWorkspaceId,
          childWorkspaceId: params.childWorkspaceId,
          artifact: "subagent-transcripts",
          taskId,
        },
      });
    }

    if (childEntries.length > 0) {
      await updateSubagentTranscriptArtifactsFile({
        workspaceId: params.parentWorkspaceId,
        workspaceSessionDir: params.parentSessionDir,
        update: (parentFile) => {
          for (const [taskId, childEntry] of childEntries) {
            if (!taskId) continue;

            const existing = parentFile.artifactsByChildTaskId[taskId] ?? null;
            const childUpdated = coerceUpdatedAtMs(childEntry);
            const existingUpdated = existing ? coerceUpdatedAtMs(existing) : -1;

            if (!existing || childUpdated > existingUpdated) {
              parentFile.artifactsByChildTaskId[taskId] = {
                ...childEntry,
                childTaskId: taskId,
                parentWorkspaceId: params.parentWorkspaceId,
                chatPath: childEntry.chatPath
                  ? getSubagentTranscriptChatPath(params.parentSessionDir, taskId)
                  : undefined,
                partialPath: childEntry.partialPath
                  ? getSubagentTranscriptPartialPath(params.parentSessionDir, taskId)
                  : undefined,
              };
            }
          }
        },
      });
    }
  } catch (error: unknown) {
    log.error("Failed to roll up subagent transcript artifacts into parent", {
      parentWorkspaceId: params.parentWorkspaceId,
      childWorkspaceId: params.childWorkspaceId,
      error: getErrorMessage(error),
    });
  }
}

async function forEachWithConcurrencyLimit<T>(
  items: readonly T[],
  limit: number,
  fn: (item: T) => Promise<void>
): Promise<void> {
  assert(Number.isInteger(limit) && limit > 0, "Concurrency limit must be a positive integer");

  let nextIndex = 0;
  const workerCount = Math.min(limit, items.length);

  const workers = Array.from({ length: workerCount }, async () => {
    while (true) {
      const index = nextIndex++;
      if (index >= items.length) {
        return;
      }
      await fn(items[index]);
    }
  });

  await Promise.all(workers);
}

export interface WorkspaceServiceEvents {
  chat: (event: { workspaceId: string; message: WorkspaceChatMessage }) => void;
  metadata: (event: {
    workspaceId: string;
    metadata: FrontendWorkspaceMetadata | null;
    /**
     * Set on removal (metadata === null) when the removed workspace was a
     * sub-agent/task child: its transcript was archived into this parent's
     * session dir, so analytics can re-ingest the parent to restore the
     * child's spend after clearing the child's live rows.
     */
    removedParentWorkspaceId?: string;
  }) => void;
  activity: (event: { workspaceId: string; activity: WorkspaceActivitySnapshot | null }) => void;
  /** Request an incremental analytics ingest outside the stream-end path. */
  analyticsIngest: (event: { workspaceId: string }) => void;
}

// eslint-disable-next-line @typescript-eslint/no-unsafe-declaration-merging
export declare interface WorkspaceService {
  on<U extends keyof WorkspaceServiceEvents>(event: U, listener: WorkspaceServiceEvents[U]): this;
  emit<U extends keyof WorkspaceServiceEvents>(
    event: U,
    ...args: Parameters<WorkspaceServiceEvents[U]>
  ): boolean;
}

function createDefaultActivitySnapshot(): WorkspaceActivitySnapshot {
  return {
    recency: 0,
    streaming: false,
    lastModel: null,
    lastThinkingLevel: null,
  };
}

function mergeActiveWorkflowRuns(
  snapshot: WorkspaceActivitySnapshot | null,
  activeRunIds: ReadonlySet<string>
): WorkspaceActivitySnapshot {
  const merged: WorkspaceActivitySnapshot = { ...(snapshot ?? createDefaultActivitySnapshot()) };
  const sortedRunIds = [...activeRunIds].sort();
  if (sortedRunIds.length > 0) {
    merged.activeWorkflowRunIds = sortedRunIds;
    merged.activeWorkflowRunCount = sortedRunIds.length;
  } else {
    delete merged.activeWorkflowRunIds;
    delete merged.activeWorkflowRunCount;
  }
  return merged;
}

// Merge the optional armed-bash-monitor count into an activity snapshot: a positive count sets
// the field, while zero deletes it so the snapshot stays sparse (absent === none).
function mergeActiveCount(
  snapshot: WorkspaceActivitySnapshot | null,
  key: "activeBashMonitorCount",
  count: number
): WorkspaceActivitySnapshot {
  assert(count >= 0, `${key} must be non-negative`);
  const merged: WorkspaceActivitySnapshot = { ...(snapshot ?? createDefaultActivitySnapshot()) };
  if (count > 0) {
    merged[key] = count;
  } else {
    delete merged[key];
  }
  return merged;
}

/**
 * `/compact` stores its follow-up separately from `rawCommand`; reconstruct it to match the
 * transcript display.
 */
function appendCompactionFollowUp(rawCommand: string, message: MuxMessage): string {
  const muxMeta: unknown = message.metadata?.muxMetadata;
  if (rawCommand.includes("\n") || typeof muxMeta !== "object" || muxMeta === null) {
    return rawCommand;
  }
  const followUpText = getFollowUpContentText(
    getCompactionFollowUpContent(message.metadata?.muxMetadata)
  );
  return followUpText === null ? rawCommand : `${rawCommand}\n${followUpText}`;
}

/**
 * Prefer `rawCommand` so slash commands match the transcript instead of provider-expanded content.
 * Treat malformed persisted rows as empty so they cannot hide older valid prompts.
 */
function extractUserPromptText(message: MuxMessage): string {
  const muxMeta: unknown = message.metadata?.muxMetadata;
  const rawCommand =
    typeof muxMeta === "object" &&
    muxMeta !== null &&
    "rawCommand" in muxMeta &&
    typeof muxMeta.rawCommand === "string"
      ? muxMeta.rawCommand.trim()
      : "";
  if (rawCommand.length > 0) {
    return stripStagedAttachmentNotice(appendCompactionFollowUp(rawCommand, message)).trim();
  }

  if (!Array.isArray(message.parts)) {
    return "";
  }

  const partsText = message.parts
    .map((part) =>
      part && typeof part === "object" && part.type === "text" && typeof part.text === "string"
        ? part.text
        : ""
    )
    .join("");

  return stripStagedAttachmentNotice(partsText).trim();
}

/**
 * Canonical whitelist for options replayed from a persisted delegated-turn row
 * (see getDelegatedTurnContinuationSendOptions). History metadata stores
 * retrySendOptions as an untyped blob, so a malformed or tampered row must be
 * rejected (parse failure) or stripped to exactly these fields — never spread
 * verbatim into an internal send where extras like editMessageId would trigger
 * the edit/truncation flow.
 */
const DELEGATED_TURN_CONTINUATION_OPTIONS_SCHEMA = SendMessageOptionsSchema.pick({
  model: true,
  agentId: true,
  thinkingLevel: true,
  reasoningMode: true,
  toolPolicy: true,
  additionalSystemInstructions: true,
  maxOutputTokens: true,
  providerOptions: true,
  experiments: true,
  disableWorkspaceAgents: true,
  strictAgentResolution: true,
  allowAgentSetGoal: true,
});

// eslint-disable-next-line @typescript-eslint/no-unsafe-declaration-merging
export class WorkspaceService extends EventEmitter implements WorkspaceHost {
  private readonly sessions = new Map<string, AgentSession>();
  private shuttingDown = false;
  private readonly shutdownSessions = new Set<AgentSession>();
  private readonly pendingWorkspaceCleanup = new Set<Promise<void>>();
  private readonly providerConfigChangedListener = (): void => {
    const liveSessions = new Map([
      ...this.sessions.entries(),
      ...this.transientStartupRecoverySessions.entries(),
    ]);

    // Clearing persisted credential failures restores the manual retry path only. The config
    // change itself must never schedule or resume a stream (PR #2317 was rejected).
    for (const [workspaceId, session] of liveSessions) {
      void session.handleProviderConfigChanged().catch((error: unknown) => {
        log.warn("Failed to clear provider-fixable auto-retry abandon state", {
          workspaceId,
          error: getErrorMessage(error),
        });
      });
    }

    // Closed chats have no session to clear their persisted marker, so sweep their
    // preference files directly; otherwise reopening after a credential fix would
    // resurrect the stale abandoned state from disk.
    void clearProviderConfigFixableAbandonMarkers(
      this.config.sessionsDir,
      new Set(liveSessions.keys())
    ).catch((error: unknown) => {
      log.warn("Failed to sweep persisted auto-retry abandon markers", {
        error: getErrorMessage(error),
      });
    });
  };
  // Startup recovery may need a short-lived session even before the workspace is opened.
  // Promote only sessions that keep retry/stream activity alive after the initial check.
  private readonly transientStartupRecoverySessions = new Map<string, AgentSession>();
  private readonly sessionSubscriptions = new Map<
    string,
    { chat: () => void; metadata: () => void }
  >();

  private readonly bashMonitorRegistryStore: BashMonitorRegistryStore;
  private readonly bashMonitorWakeReconciler: BashMonitorWakeReconciler;
  private readonly constructedAtMs = Date.now();
  private readonly pendingBashMonitorWakeIdleWaitsByOwner = new Map<string, Promise<void>>();
  /** The wake send in flight per owner (at most one: dispatch runs under the history lock). */
  private readonly inFlightBashMonitorWakeSendsByOwner = new Map<string, Promise<unknown>>();
  private readonly bashMonitorHistoryLocks = new MutexMap<string>();
  private readonly bashMonitorRecoveryPromise: Promise<void>;
  private readonly pendingBashMonitorPersistenceByWorkspace = new Map<string, Set<Promise<void>>>();
  // Failed-persistence chains active per process, so a later cancellation (task_stop after a
  // runtime failure) can invalidate in-flight persists and scheduled retries by generation.
  // "failed" can never follow "canceled" for one generation (stopMonitor guards on
  // monitor.stopped), so tracking only live failed chains suffices; the owning chain removes
  // its entry on termination, keeping the map bounded by in-flight failure persists.
  private readonly activeBashMonitorFailurePersists = new Map<
    string,
    { createdAt: string; canceled: boolean }
  >();

  private trackBashMonitorPersistence(workspaceId: string, promise: Promise<void>): Promise<void> {
    const pending =
      this.pendingBashMonitorPersistenceByWorkspace.get(workspaceId) ?? new Set<Promise<void>>();
    this.pendingBashMonitorPersistenceByWorkspace.set(workspaceId, pending);
    const tracked = promise.finally(() => {
      pending.delete(tracked);
      if (pending.size === 0) this.pendingBashMonitorPersistenceByWorkspace.delete(workspaceId);
    });
    pending.add(tracked);
    return tracked;
  }

  private async drainBashMonitorPersistence(workspaceId: string): Promise<void> {
    const pending = this.pendingBashMonitorPersistenceByWorkspace.get(workspaceId);
    if (pending != null) await Promise.allSettled([...pending]);
  }
  private readonly bashOutputShownListener = (
    workspaceId: string,
    _payload: OutputShownPayload
  ): void => {
    this.scheduleBashMonitorWakeReconcile(workspaceId);
  };
  private readonly bashMonitorMatchListener = (
    workspaceId: string,
    _payload: MonitorMatchPayload
  ): void => {
    this.scheduleBashMonitorWakeReconcile(workspaceId);
  };
  private readonly bashMonitorArmedListener = (
    _workspaceId: string,
    payload: MonitorArmedPayload
  ): void => {
    if (this.removingWorkspaces.has(payload.workspaceId)) return;
    const persistence = this.bashMonitorRegistryStore
      .upsert(payload)
      .then(() => this.scheduleBashMonitorWakeReconcile(payload.workspaceId));
    void this.trackBashMonitorPersistence(payload.workspaceId, persistence).catch(
      (error: unknown) => {
        log.error("Failed to persist armed bash monitor", {
          workspaceId: payload.workspaceId,
          error,
        });
      }
    );
  };
  private readonly bashMonitorStoppedListener = (
    workspaceId: string,
    payload: MonitorStoppedPayload
  ): void => {
    const processKey = workspaceId + "\u0000" + payload.processId;
    const createdAt = payload.armMetadata?.createdAt;
    if (payload.reason === "canceled" && createdAt != null) {
      const active = this.activeBashMonitorFailurePersists.get(processKey);
      if (active?.createdAt === createdAt) active.canceled = true;
    }
    const failurePersist =
      payload.reason === "failed" && createdAt != null ? { createdAt, canceled: false } : undefined;
    if (failurePersist != null) {
      this.activeBashMonitorFailurePersists.set(processKey, failurePersist);
    }
    const wasCanceled = (): boolean => failurePersist?.canceled === true;
    const settleFailurePersist = (): void => {
      if (
        failurePersist != null &&
        this.activeBashMonitorFailurePersists.get(processKey) === failurePersist
      ) {
        this.activeBashMonitorFailurePersists.delete(processKey);
      }
    };
    const persist = async (): Promise<boolean> => {
      if (payload.reason === "canceled") {
        if (createdAt == null) return false;
        await this.bashMonitorWakeReconciler.discardProcess(
          workspaceId,
          payload.processId,
          createdAt
        );
        await this.bashMonitorRegistryStore.remove(workspaceId, payload.processId, createdAt);
        return true;
      }
      if (payload.reason === "failed") {
        if (wasCanceled()) return false;
        if (payload.armMetadata != null) {
          await this.bashMonitorRegistryStore.upsert(payload.armMetadata);
        }
        if (wasCanceled()) return false;
        if (payload.terminal != null) {
          if (createdAt == null) return false;
          await this.bashMonitorRegistryStore.recordTerminal(
            workspaceId,
            payload.processId,
            createdAt,
            payload.terminal
          );
        }
        if (wasCanceled()) return false;
        if (createdAt == null) return false;
        await this.bashMonitorRegistryStore.recordLost(workspaceId, payload.processId, createdAt, {
          reason: "runtime-failure",
          ...(payload.failureMessage != null ? { failureMessage: payload.failureMessage } : {}),
          ...(payload.failedOperations != null
            ? { failedOperations: payload.failedOperations }
            : {}),
          ...(payload.failedMatch != null ? { failedMatch: payload.failedMatch } : {}),
          failedAt: new Date().toISOString(),
        });
        return !wasCanceled();
      }
      if (payload.terminal != null && createdAt != null) {
        await this.bashMonitorRegistryStore.recordTerminal(
          workspaceId,
          payload.processId,
          createdAt,
          payload.terminal
        );
      }
      return true;
    };
    const persistence = new Promise<void>((resolve) => {
      let retryIndex = 0;
      const finish = (): void => {
        settleFailurePersist();
        resolve();
      };
      const run = (): void => {
        if (this.removingWorkspaces.has(workspaceId) || wasCanceled()) {
          finish();
          return;
        }
        void persist()
          .then((persisted) => {
            if (persisted && !wasCanceled()) {
              this.scheduleBashMonitorWakeReconcile(workspaceId);
            }
            finish();
          })
          .catch((error: unknown) => {
            if (wasCanceled()) {
              finish();
              return;
            }
            const delay = BASH_MONITOR_PERSIST_RETRY_DELAYS_MS[retryIndex++];
            if (delay == null) {
              log.error("Failed to retire bash monitor state", { workspaceId, error });
              finish();
              return;
            }
            const timer = setTimeout(run, delay);
            timer.unref();
          });
      };
      run();
    });
    void this.trackBashMonitorPersistence(workspaceId, persistence);
  };
  // Last armed-monitor count successfully broadcast per workspace, so background process
  // churn that doesn't change the count (e.g. a monitorless bash exiting) skips the
  // activity re-emit. A missing entry means "unknown" (never successfully emitted), which
  // must never dedupe: renderers may have bootstrapped a non-zero count from
  // getActivityList(), so suppressing an unknown->0 transition would strand the sidebar.
  private readonly lastEmittedBashMonitorCounts = new Map<string, number>();
  // Workspaces where an armed monitor has ever been observed (by the change listener or
  // a getActivityList read). Deliberately never pruned and kept separate from the dedupe
  // map above: the dedupe entry is dropped while emits are in flight or failed, but the
  // tombstone decision in getActivityList must survive those windows, otherwise a
  // renderer that bootstrapped a non-zero count can never see the zero-count clear.
  private readonly bashMonitorSeenWorkspaces = new Set<string>();
  private readonly bashProcessChangeListener = (workspaceId: string): void => {
    const count = this.getActiveBashMonitorCount(workspaceId);
    if (count > 0) {
      this.bashMonitorSeenWorkspaces.add(workspaceId);
    }
    if (this.lastEmittedBashMonitorCounts.get(workspaceId) === count) {
      return;
    }
    // Clear the entry synchronously BEFORE the async emit: while an emit is in flight
    // the last delivered count is unknown (the snapshot read may fail, and renderers
    // may observe transient counts via workspace.activity.list()). Deleting up front
    // means a concurrent change event — e.g. a stop racing a slow armed emit in a fast
    // 0 -> 1 -> 0 sequence — can never dedupe against a stale pre-emit value and drop
    // the clear. Cost: an occasional duplicate emit, which renderers apply idempotently.
    this.lastEmittedBashMonitorCounts.delete(workspaceId);
    void this.extensionMetadata
      // Strict: emitting a suspect (partial-main) snapshot after a failed
      // sidecar reconcile would clear goal/status in the renderer; the
      // catch below already retains "unknown" and re-emits on next change.
      .getSnapshot(workspaceId, { throwOnError: true })
      .then((snapshot) => {
        this.emitWorkspaceActivity(workspaceId, snapshot);
        // Record only after a successful emit. Re-read the count because the emit merges
        // the live value, which may have moved past the one that triggered this listener.
        this.lastEmittedBashMonitorCounts.set(
          workspaceId,
          this.getActiveBashMonitorCount(workspaceId)
        );
      })
      .catch((error: unknown) => {
        // Leave the entry absent ("unknown") so the next change event always re-emits.
        log.debug("Failed to emit activity after background bash monitor change", {
          workspaceId,
          error,
        });
      });
  };

  // Lazily bootstrapped workflow activity cache so sidebar refreshes don't rescan run history.
  private readonly activeWorkflowRunIdBootstrapsByWorkspace = new Map<
    string,
    Promise<Set<string>>
  >();
  private readonly activeWorkflowRunIdsByWorkspace = new Map<string, Set<string>>();
  // Workspaces where NONZERO workflow-run activity was actually observed
  // (bootstrap probe, run-status event, or list read). This — not cache
  // presence — is the zero-count tombstone signal: the activity list's own
  // probe installs an (empty) cache for every scoped id, so cache existence
  // would fabricate recency:0 entries for every idle config-known workspace
  // from the second list on, re-bloating the payload this scoping trims.
  private readonly workflowRunSeenWorkspaces = new Set<string>();

  // Debounce post-compaction metadata refreshes (file_edit_* can fire rapidly)
  private readonly postCompactionRefreshTimers = new Map<string, ReturnType<typeof setTimeout>>();
  // Tracks workspaces currently being renamed to prevent streaming during rename
  private readonly renamingWorkspaces = new Set<string>();

  // Cache for @file mention autocomplete (git ls-files output).
  private readonly fileCompletionsCache = new Map<string, FileCompletionsCacheEntry>();
  // Tracks workspaces currently being removed to prevent new sessions/streams during deletion.
  private readonly removingWorkspaces = new Set<string>();

  // Tracks workspaces currently being archived to prevent runtime-affecting operations (e.g. SSH)
  // from waking a dedicated workspace during archive().
  private readonly archivingWorkspaces = new Set<string>();

  // Tracks stream generations that are compaction turns so background stop snapshots
  // can carry authoritative notification policy instead of forcing the frontend to
  // infer compaction from best-effort chat replay state.
  private readonly compactionStreamGenerations = new Map<string, number>();

  // Tracks workspaces undergoing idle (background) compaction so the activity snapshot
  // can tag the stream, letting the frontend suppress notifications for maintenance work.
  private readonly idleCompactingWorkspaces = new Set<string>();

  // Reports the terminal outcome of an idle compaction (success or failure, including
  // mid-stream failures like model_not_found) back to IdleCompactionService so it can
  // stop re-attempting a persistently failing workspace. Wired in ServiceContainer.
  private idleCompactionOutcomeListener:
    | ((workspaceId: string, outcome: IdleCompactionOutcome) => void)
    | undefined;

  // Blocks new sends while a context-discarding history mutation (reset, full
  // clear, destructive replace) is in flight, and enforces one such mutation
  // at a time (r40). Sends already past this entry check are refused by the
  // session-level turn-admission block (AgentSession.holdTurnAdmission).
  private readonly contextMutationWorkspaces = new Set<string>();

  // r41: monotonic count of COMPLETED context-discarding mutations per
  // workspace. Sends capture it synchronously with the entry check above and
  // re-verify at their admission gates: the level-triggered admission block
  // cannot catch a mutation that started and finished while a send sat in
  // pre-admission awaits (e.g. branch-summary generation).
  private readonly contextMutationEpochs = new Map<string, number>();

  // r41: sends currently between the entry check and their settled outcome
  // (queued, refused, or admitted — PREPARING is set before any early
  // background-start return). Refine publication must not interleave with a
  // send's pre-admission window: a proposal row published and RELEASED while
  // a send with an already-persisted user row awaits admission would land
  // after that user row and enter the send's request as a trailing foreign
  // assistant row (see acquireIdleTurnExclusion).
  private readonly preflightSendCounts = new Map<string, number>();
  /**
   * Codex P1 (PRRT_kwDOPxxmWM6cRi_J): sends the SESSION cannot observe yet —
   * counted from service entry until the queue/session handoff, then released.
   * Unlike preflightSendCounts (held for the whole service call for archive
   * and refine interlocks), this feeds the session's follow-up idle probes:
   * a follow-up redispatched from within the originating send's own turn
   * (e.g. its on-send compaction completing) must not veto itself, and once
   * handed off the session's own queue/turn-phase state governs visibility.
   * Tickets are kept in arrival order so a send can tell whether an EARLIER send is
   * still in preflight (sendMessage queues behind it) without two simultaneous
   * arrivals each deferring to the other, and so sends reach their queue-or-direct
   * decision in arrival order (a later arrival must not enqueue first because its
   * preflight awaits finished sooner). Supersedable tickets are maintenance sends that
   * yield to user input (requireIdle skips and queue-mode heartbeats): they never count
   * as "earlier" for anyone, nobody waits on them, and they yield to a manual send in
   * preflight through preflightSendCounts.
   */
  private readonly sessionInvisiblePreflights = new Map<
    string,
    Map<number, { supersedable: boolean; decided: Promise<void>; markDecided: () => void }>
  >();
  private nextSessionInvisiblePreflightTicket = 0;

  private hasSessionInvisiblePreflight(workspaceId: string): boolean {
    return (this.sessionInvisiblePreflights.get(workspaceId)?.size ?? 0) > 0;
  }

  /**
   * See sessionInvisiblePreflights. Release is idempotent. Disposal (scope exit of the
   * service call) also drains messages queued behind this preflight when it is a
   * blocking ticket with no blocking ticket before it (the head of the line that others
   * queue behind): those entries have no stream end to drain them if this send settled
   * without a turn (refused, rejected, startup failed). A younger send that settles
   * first must not drain, or it would dispatch entries ahead of the older still-live
   * preflight; the older send drains when it settles. Supersedable tickets never drain
   * because nothing queues behind them, and the drain is a no-op when a turn was handed
   * off (the session is busy).
   */
  private armSessionInvisiblePreflight(
    workspaceId: string,
    options?: { supersedable?: boolean }
  ): {
    release: () => void;
    hasEarlierPreflight: () => boolean;
    /** Resolve once every earlier blocking ticket has reached its queue-or-direct decision. */
    awaitEarlierDecisions: () => Promise<void>;
    markDecided: () => void;
  } & Disposable {
    const ticket = this.nextSessionInvisiblePreflightTicket++;
    const supersedable = options?.supersedable === true;
    let tickets = this.sessionInvisiblePreflights.get(workspaceId);
    if (tickets == null) {
      tickets = new Map();
      this.sessionInvisiblePreflights.set(workspaceId, tickets);
    }
    let markDecided!: () => void;
    const decided = new Promise<void>((resolve) => {
      markDecided = resolve;
    });
    tickets.set(ticket, { supersedable, decided, markDecided });
    let released = false;
    let releasedAsHead = false;
    // Map iteration follows insertion order, so tickets before this one arrived earlier.
    const earlierBlockingTickets = () => {
      const earlier: Array<{ decided: Promise<void> }> = [];
      if (released) {
        return earlier;
      }
      for (const [liveTicket, entry] of this.sessionInvisiblePreflights.get(workspaceId) ?? []) {
        if (liveTicket === ticket) {
          break;
        }
        if (!entry.supersedable) {
          earlier.push(entry);
        }
      }
      return earlier;
    };
    const hasEarlierPreflight = () => earlierBlockingTickets().length > 0;
    const release = () => {
      if (released) {
        return;
      }
      releasedAsHead = !supersedable && !hasEarlierPreflight();
      released = true;
      // A send that leaves before deciding must not keep later arrivals waiting.
      markDecided();
      const live = this.sessionInvisiblePreflights.get(workspaceId);
      live?.delete(ticket);
      if (live?.size === 0) {
        this.sessionInvisiblePreflights.delete(workspaceId);
      }
    };
    return {
      release,
      hasEarlierPreflight,
      awaitEarlierDecisions: async () => {
        await Promise.all(earlierBlockingTickets().map((entry) => entry.decided));
      },
      markDecided,
      [Symbol.dispose]: () => {
        release();
        if (releasedAsHead) {
          this.sessions.get(workspaceId)?.drainQueuedMessagesIfIdle();
        }
      },
    };
  }
  // In-flight renderer executeBash requests per workspace. Incremented in the same
  // synchronous block as executeBash's archivingWorkspaces check (mirroring
  // preflightSendCounts) so archive admission and bash execution always observe each other:
  // an exec admitted first holds the archive gate open for its full duration, and an exec
  // entering after the gate armed is refused at entry.
  private readonly preflightExecCounts = new Map<string, number>();
  // Same pairing for renderer attachment staging (writes into the checkout an archive may
  // capture/remove) and file-completion refreshes (run git through a runtime that could
  // re-wake a stopped Coder workspace). See acquirePreflightAdmission.
  private readonly preflightStagingCounts = new Map<string, number>();
  private readonly preflightFileCompletionCounts = new Map<string, number>();
  // Same pairing for renderer MCP prompt discovery (workspace.mcp.prompts.list): it readies the
  // runtime (which can re-wake a stopped Coder workspace) and starts cached stdio servers inside
  // the checkout. See acquireMcpPromptDiscoveryAdmission.
  private readonly preflightMcpPromptDiscoveryCounts = new Map<string, number>();
  /**
   * In-flight forks counted per SOURCE workspace. A fork clones the source checkout and (for
   * SSH/Coder runtimes) shares its remote workspace, so a model-driven archive admitted
   * mid-fork could stop or snapshot the environment under the clone. Pairs with the archive
   * gates like the other preflight counters: a fork admitted first is visible to the sink
   * and the pre-interruption hold; one entering later observes archivingWorkspaces.
   */
  private readonly preflightForkCounts = new Map<string, number>();

  // Tracks in-flight fork auto-title generations so only the first accepted continue
  // message can claim the workspace title.
  private readonly autoTitlingWorkspaces = new Set<string>();

  // Monotonic per-workspace stream generations prevent delayed stop-side metadata writes
  // from older streams from clobbering a newer streaming=true snapshot after async awaits.
  private readonly streamingGenerations = new Map<string, number>();

  private timelineRecorder: TimelineRecorder = NOOP_TIMELINE_RECORDER;

  // Serialize todo snapshot refreshes so back-to-back todo_write/propose_plan updates cannot
  // finish out of order and briefly restore stale progress in workspace activity metadata.
  private readonly todoStatusUpdateQueue = new Map<string, Promise<void>>();

  // AbortControllers for in-progress workspace initialization (postCreateSetup + initWorkspace).
  //
  // Why this lives here: archive/remove are the user-facing lifecycle operations that should
  // cancel any fire-and-forget init work to avoid orphaned processes (e.g., SSH sync, .xum/init).
  private readonly initAbortControllers = new Map<string, AbortController>();

  /**
   * Settlement promises of fire-and-forget background inits (create/createMulti/fork), kept
   * so archive can wait for the init hook process to actually exit after aborting it: the
   * abort only signals, and snapshot capture, checkout deletion, or a Coder stop under a
   * still-writing init would race its writes. Entries self-clean on settlement; the stored
   * promises never reject (init failures are reported through the init logger).
   */
  private readonly initSettlementPromises = new Map<string, Promise<void>>();

  /**
   * Registers a fire-and-forget background init started outside this service (task orchestration
   * starts inits for task workspaces after materializing their checkouts) with the same
   * abort-and-settlement mechanism archive uses: archiveUnlocked aborts the registered
   * controller when init state is still running, and always awaits the retained settlement
   * before snapshot capture, checkout deletion, or Coder hooks can proceed. The controller
   * entry self-cleans on settlement.
   */
  registerExternalBackgroundInit(
    workspaceId: string,
    abortController: AbortController,
    settled: Promise<unknown>
  ): void {
    this.initAbortControllers.set(workspaceId, abortController);
    this.retainInitSettlement(workspaceId, settled);
    void settled
      .then(
        () => undefined,
        () => undefined
      )
      .then(() => {
        if (this.initAbortControllers.get(workspaceId) === abortController) {
          this.initAbortControllers.delete(workspaceId);
        }
      });
  }

  /** See initSettlementPromises. */
  private retainInitSettlement(workspaceId: string, settled: Promise<unknown>): void {
    const swallowed = settled.then(
      () => undefined,
      () => undefined
    );
    this.initSettlementPromises.set(workspaceId, swallowed);
    void swallowed.then(() => {
      if (this.initSettlementPromises.get(workspaceId) === swallowed) {
        this.initSettlementPromises.delete(workspaceId);
      }
    });
  }

  // ExtensionMetadataService now serializes all mutations globally because every
  // workspace shares the same extensionMetadata.json file.

  /** Check if a workspace is currently being removed. */
  isRemoving(workspaceId: string): boolean {
    return this.removingWorkspaces.has(workspaceId);
  }

  constructor(
    private readonly config: Config,
    private readonly historyService: HistoryService,
    private readonly aiService: AIService,
    private readonly initStateManager: InitStateManager,
    private readonly extensionMetadata: ExtensionMetadataService,
    private readonly backgroundProcessManager: BackgroundProcessManager,
    private readonly sessionUsageService?: SessionUsageService,
    policyService?: PolicyService,
    telemetryService?: TelemetryService,
    experimentsService?: ExperimentsService,
    sessionTimingService?: SessionTimingService,
    private readonly streamManager?: StreamManager,
    private readonly secretsStore: Pick<SecretsStore, "getEffectiveSecrets"> = new SecretsStore(
      config.rootDir
    ),
    private readonly providersConfigStore = new ProvidersConfigStore(config.rootDir),
    private readonly desktopInputCoordinator = new DesktopInputCoordinator(config),
    private readonly effectRunner: EffectRunner = defaultEffectRunner,
    private readonly appFiberScope?: Scope.Scope
  ) {
    super();
    this.bashMonitorRegistryStore = new BashMonitorRegistryStore(config);
    // Narrow WorkspaceService test doubles construct partial manager stubs (see the
    // typeof guard on subscriptions below); a missing method reads as "no live monitor
    // state" so shared paths like history clear still reconcile instead of crashing.
    const monitorManager = this.backgroundProcessManager;
    this.bashMonitorWakeReconciler = new BashMonitorWakeReconciler({
      sessionsDir: config.sessionsDir,
      processManager: {
        pullMonitorWakeSignals: (ownerWorkspaceId) =>
          typeof monitorManager.pullMonitorWakeSignals === "function"
            ? monitorManager.pullMonitorWakeSignals(ownerWorkspaceId)
            : [],
        getMonitorWakeDeliveryState: (processId, originNotAfterMs) =>
          typeof monitorManager.getMonitorWakeDeliveryState === "function"
            ? monitorManager.getMonitorWakeDeliveryState(processId, originNotAfterMs)
            : Promise.resolve(undefined),
        acknowledgeMonitorWake: (processId, originNotAfterMs, matchedThroughOffset, settledAt) =>
          typeof monitorManager.acknowledgeMonitorWake === "function"
            ? monitorManager.acknowledgeMonitorWake(
                processId,
                originNotAfterMs,
                matchedThroughOffset,
                settledAt
              )
            : undefined,
        dropRetiredMonitor: (processId, createdAt) =>
          typeof monitorManager.dropRetiredMonitor === "function"
            ? monitorManager.dropRetiredMonitor(processId, createdAt)
            : undefined,
      },
      registry: this.bashMonitorRegistryStore,
      deliveredWakes: (ownerWorkspaceId, sinceMs) =>
        this.listDeliveredBashMonitorWakes(ownerWorkspaceId, sinceMs),
      onWake: (dispatch) => this.dispatchBashMonitorWake(dispatch),
    });
    if (typeof this.backgroundProcessManager.on === "function") {
      this.backgroundProcessManager.on("output:shown", this.bashOutputShownListener);
      this.backgroundProcessManager.on("monitor:match", this.bashMonitorMatchListener);
      this.backgroundProcessManager.on("monitor:armed", this.bashMonitorArmedListener);
      this.backgroundProcessManager.on("monitor:stopped", this.bashMonitorStoppedListener);
      this.backgroundProcessManager.on("change", this.bashProcessChangeListener);
    }
    this.bashMonitorRecoveryPromise = this.recoverBashMonitorStateAfterRestart();
    this.policyService = policyService;
    this.telemetryService = telemetryService;
    this.experimentsService = experimentsService;
    this.sessionTimingService = sessionTimingService;
    this.aiService.on("providers-config-changed", this.providerConfigChangedListener);
    // Archive admission pairing for workflow starts/resumes: WorkflowService instances are
    // per-request, so the guard is registered at module scope (see workflowArchiveAdmission).
    // Entry points check it in the same synchronous block that counts their admission, so
    // whichever of {archive gate, workflow admission} runs first is observed by the other.
    setWorkflowArchiveAdmissionGuard((workspaceId) => {
      if (this.archivingWorkspaces.has(workspaceId)) {
        return `Workspace is being archived: ${workspaceId}. Unarchive it before starting or resuming workflows.`;
      }
      const workspaceEntry = findWorkspaceEntry(this.config.loadConfigOrDefault(), workspaceId);
      if (
        workspaceEntry != null &&
        isWorkspaceArchived(
          workspaceEntry.workspace.archivedAt,
          workspaceEntry.workspace.unarchivedAt
        )
      ) {
        return `Workspace is archived: ${workspaceId}. Unarchive it before starting or resuming workflows.`;
      }
      return null;
    });
    this.setupMetadataListeners();
    this.setupInitMetadataListeners();
    // A cleared tombstone means a removed id was re-registered (downgraded
    // concurrent backend re-creating a deterministic legacy id): evict the
    // process-local activity caches bootstrapped for the REMOVED incarnation
    // so the revived workspace re-probes disk instead of showing ghost
    // workflow-run counts from session state that removal deleted.
    // Guarded like the backgroundProcessManager subscriptions above: tests
    // may construct WorkspaceService with a partial ExtensionMetadataService
    // stub.
    if (typeof this.extensionMetadata.setTombstoneClearedListener === "function") {
      this.extensionMetadata.setTombstoneClearedListener((workspaceId) => {
        this.evictWorkspaceActivityCaches(workspaceId);
      });
    }
    // r63 startup self-heal: reclaim removal tombstones left behind by a
    // removal whose config deregistration AND tombstone rollback both failed
    // — otherwise that workspace stays registered but refused every mutation
    // across restarts. Fire-and-forget with an explicit catch (startup
    // initialization must never crash the app).
    healRemovalTombstonesForRegisteredWorkspaces(this.config).catch((error: unknown) => {
      log.debug("Removal tombstone self-heal failed at startup", { error });
    });
    if (this.appFiberScope) {
      // A sibling of session guardians, never a child of a session being disposed. Producers
      // can enqueue destructive cleanup while their final callbacks release physical leases.
      this.effectRunner.runSync(
        Effect.forkIn(
          Effect.never.pipe(
            Effect.onInterrupt(() =>
              Effect.suspend(() => {
                this.beginShutdown();
                // Empty graph rollback must stay synchronous so constructor failures retain
                // their original error instead of becoming an async runSync failure.
                if (this.shutdownSessions.size === 0 && this.pendingWorkspaceCleanup.size === 0)
                  return Effect.void;
                return Effect.promise(async () => {
                  await Promise.all(
                    [...this.shutdownSessions].map((session) =>
                      session.finishShutdown().catch((error: unknown) => {
                        log.warn("Session shutdown failed", { error });
                      })
                    )
                  );
                  while (this.pendingWorkspaceCleanup.size > 0) {
                    await Promise.all([...this.pendingWorkspaceCleanup]);
                  }
                });
              })
            )
          ),
          this.appFiberScope,
          { startImmediately: true }
        )
      );
    }
  }

  private async recoverBashMonitorRegistryPass(): Promise<boolean> {
    let scan: { ownerWorkspaceIds: string[]; scanFailed: boolean };
    try {
      scan = await this.bashMonitorRegistryStore.listOwnerWorkspaceIds();
    } catch (error) {
      log.debug("Failed to scan bash monitor registry", { error });
      return true;
    }
    let retryNeeded = scan.scanFailed;
    for (const ownerWorkspaceId of scan.ownerWorkspaceIds) {
      try {
        const records = await this.bashMonitorRegistryStore.listAll(ownerWorkspaceId);
        if (
          records.some((record) => {
            const createdAtMs = Date.parse(record.createdAt);
            return !Number.isFinite(createdAtMs) || createdAtMs < this.constructedAtMs;
          })
        ) {
          this.scheduleBashMonitorWakeReconcile(ownerWorkspaceId);
        }
      } catch (error) {
        retryNeeded = true;
        log.debug("Failed to scan bash monitor registry owner", { ownerWorkspaceId, error });
      }
    }
    return retryNeeded;
  }

  private async recoverBashMonitorStateAfterRestart(): Promise<void> {
    if (!(await this.recoverBashMonitorRegistryPass())) return;
    if (!(await this.recoverBashMonitorRegistryPass())) return;
    const timer = setTimeout(() => {
      void this.recoverBashMonitorRegistryPass();
    }, 1_000);
    timer.unref();
  }

  private scheduleBashMonitorWakeReconcile(ownerWorkspaceId: string): void {
    if (this.removingWorkspaces.has(ownerWorkspaceId)) return;
    assert(
      ownerWorkspaceId.trim().length > 0,
      "scheduleBashMonitorWakeReconcile requires workspaceId"
    );
    this.notifyBashMonitorWakeStateChanged(ownerWorkspaceId);
    this.bashMonitorWakeReconciler.scheduleReconcile(ownerWorkspaceId);
  }

  private scheduleBashMonitorWakeReconcileAfterIdle(ownerWorkspaceId: string): void {
    if (this.pendingBashMonitorWakeIdleWaitsByOwner.has(ownerWorkspaceId)) return;
    const promise = this.waitForIdleAndNoQueuedMessages(ownerWorkspaceId)
      .catch((error: unknown) => {
        log.debug("Bash monitor idle wait failed; retrying reconciliation anyway", {
          ownerWorkspaceId,
          error,
        });
      })
      .then(() => {
        // Release the slot before scheduling: the reconcile may find a new turn already running
        // and must be able to install the next idle wait.
        if (this.pendingBashMonitorWakeIdleWaitsByOwner.get(ownerWorkspaceId) === promise) {
          this.pendingBashMonitorWakeIdleWaitsByOwner.delete(ownerWorkspaceId);
        }
        this.scheduleBashMonitorWakeReconcile(ownerWorkspaceId);
      });
    this.pendingBashMonitorWakeIdleWaitsByOwner.set(ownerWorkspaceId, promise);
  }

  /**
   * Wake records in transcript rows written since `sinceMs`, scanning newest-first across the
   * compaction archive too because a delivered row stays proof of delivery after it leaves the
   * window the model sees. A failed read rejects so the reconciler holds dispatch in its retry
   * backoff instead of risking a duplicate row.
   */
  private async listDeliveredBashMonitorWakes(
    ownerWorkspaceId: string,
    sinceMs: number
  ): Promise<readonly DeliveredWakeRecord[]> {
    const records: DeliveredWakeRecord[] = [];
    const result = await this.historyService.iterateFullHistory(
      ownerWorkspaceId,
      "backward",
      (messages) => {
        // A wake row is appended after its process was created, so once a whole chunk predates
        // every process being checked the rest of history cannot carry one.
        let predatesAll = messages.length > 0;
        for (const message of messages) {
          const muxMetadata = message.metadata?.muxMetadata;
          // A wake that triggered on-send compaction persists only the compaction request, with
          // the wake's metadata nested as its follow-up.
          const wake =
            muxMetadata?.type === "bash-monitor-wake"
              ? muxMetadata
              : getCompactionFollowUpContent(muxMetadata)?.muxMetadata;
          if (message.role === "user" && wake?.type === "bash-monitor-wake") {
            // Persisted metadata is unvalidated: a malformed row must degrade to "not delivered"
            // rather than fail the scan, which would hold every wake of this owner.
            const rows: unknown = wake.records;
            if (Array.isArray(rows)) {
              for (const row of rows) {
                if (
                  isPlainObject(row) &&
                  typeof row.processId === "string" &&
                  typeof row.wakeUpdatedAt === "string"
                ) {
                  records.push({ processId: row.processId, wakeUpdatedAt: row.wakeUpdatedAt });
                }
              }
            }
          }
          const timestamp = message.metadata?.timestamp;
          if (!(typeof timestamp === "number" && timestamp < sinceMs)) predatesAll = false;
        }
        return !predatesAll;
      }
    );
    if (!result.success) throw new Error(result.error);
    return records;
  }

  private async dispatchBashMonitorWake(
    dispatch: BashMonitorWakeDispatch
  ): Promise<BashMonitorWakeDispatchOutcome> {
    return this.bashMonitorHistoryLocks.withLock(dispatch.ownerWorkspaceId, async () => {
      const ownerWorkspaceId = dispatch.ownerWorkspaceId;
      const entry = findWorkspaceEntry(this.config.loadConfigOrDefault(), ownerWorkspaceId);
      if (entry == null) {
        await dispatch.onAccepted();
        this.notifyBashMonitorWakeStateChanged(ownerWorkspaceId);
        return "in-flight";
      }
      // sendMessage refuses archived workspaces and no session exists to wait on, so an after-idle
      // retry would spin; the wake stays owed and unarchive reconciles it.
      if (
        this.archivingWorkspaces.has(ownerWorkspaceId) ||
        isWorkspaceArchived(entry.workspace.archivedAt, entry.workspace.unarchivedAt)
      ) {
        return "deferred";
      }
      const hasPendingTurn = this.hasPendingQueuedOrPreparingTurn(ownerWorkspaceId);
      // Pending mid-stream compaction counts as turn work: the session reads idle between the
      // stopped stream and its compaction request, which the session sends directly.
      const hasSessionBackedBusyState =
        this.sessions.get(ownerWorkspaceId)?.hasActiveOrPendingTurnWork() === true;
      const hasAiServiceStream = this.aiService.isStreaming(ownerWorkspaceId);
      // Cancelable attention must not cut a turn that can consume it in its current tool call.
      // Keep it outside the queue so later manual tool-end input cannot be held behind it.
      if (hasPendingTurn || hasSessionBackedBusyState) {
        this.scheduleBashMonitorWakeReconcileAfterIdle(ownerWorkspaceId);
        return "deferred";
      }
      if (hasAiServiceStream) {
        return "deferred";
      }
      const sendOptions =
        (await this.getDelegatedTurnContinuationSendOptions(ownerWorkspaceId)) ??
        (await this.getWorkflowContinuationSendOptions(ownerWorkspaceId));
      if (sendOptions == null) {
        log.debug("Bash monitor wake has no send options; leaving pending", { ownerWorkspaceId });
        return "deferred";
      }

      // Withdrawal during send-option resolution must not enter preflight or persist settings.
      if (dispatch.cancelSignal.aborted) return "deferred";

      let accepted = false;
      const send = this.sendMessage(
        ownerWorkspaceId,
        dispatch.prompt,
        {
          ...sendOptions,
          muxMetadata: dispatch.muxMetadata,
        },
        {
          skipAutoResumeReset: true,
          synthetic: true,
          agentInitiated: true,
          requireIdle: true,
          cancelSignal: dispatch.cancelSignal,
          withdrawAcceptedOnCancel: true,
          onAccepted: async () => {
            accepted = true;
            await dispatch.onAccepted();
            this.notifyBashMonitorWakeStateChanged(ownerWorkspaceId);
          },
          onAcceptedPreStreamFailure: async () => {
            if (accepted) await dispatch.onAccepted();
          },
          onCanceled: async () => {
            if (!accepted) {
              await dispatch.onDeferred();
              this.scheduleBashMonitorWakeReconcile(ownerWorkspaceId);
            }
          },
        }
      );
      // Published so a hard Stop that withdraws this wake can join it (see interruptStream).
      this.inFlightBashMonitorWakeSendsByOwner.set(ownerWorkspaceId, send);
      let sendResult: Awaited<typeof send>;
      try {
        sendResult = await send;
      } finally {
        if (this.inFlightBashMonitorWakeSendsByOwner.get(ownerWorkspaceId) === send) {
          this.inFlightBashMonitorWakeSendsByOwner.delete(ownerWorkspaceId);
        }
      }
      if (!sendResult.success && !accepted) {
        this.scheduleBashMonitorWakeReconcileAfterIdle(ownerWorkspaceId);
        return "deferred";
      }
      return "in-flight";
    });
  }

  private readonly policyService?: PolicyService;
  private readonly telemetryService?: TelemetryService;
  private readonly experimentsService?: ExperimentsService;
  private mcpServerManager?: MCPServerManager;
  // Optional services for workspace cleanup during archive/remove lifecycle operations.
  private terminalService?: TerminalService;
  private desktopSessionManager?: DesktopSessionManager;
  private readonly sessionTimingService?: SessionTimingService;
  private workspaceLifecycleHooks?: WorkspaceLifecycleHooks;
  private memoryConsolidationService?: {
    triggerInBackground(workspaceId: string, trigger: "compaction" | "archive"): void;
    triggerHarvestThenSweepInBackground(metadata: CompactionCompletionMetadata): void;
    cancelInFlightConsolidation(workspaceId: string): Promise<void>;
  };
  private worktreeArchiveSnapshotService?: WorktreeArchiveSnapshotLifecycleService;
  private agentTaskIntegration?: AgentTaskIntegration;
  private workspaceGoalService?: WorkspaceGoalService;
  /** Narrow DevTools cleanup surface; wired by coreServices when a DevToolsService exists. */
  private devToolsService?: WorkspaceDevToolsCleanup;
  /** Cancels running /refine passes before removal deletes the session dir; wired post-construction (RefineService is built later). */
  private refinePassCanceller?: { cancelInFlightRefinePass(workspaceId: string): Promise<void> };
  /** Narrow overrides-cleanup surface; wired by ServiceContainer for stale plugin-key sanitization. */
  private workspaceMcpOverridesService?: WorkspaceServiceMcpOverridesPort;

  setTimelineRecorder(recorder: TimelineRecorder): void {
    this.timelineRecorder = recorder;
  }

  /**
   * Set the MCP server manager for tool access.
   * Called after construction due to circular dependency.
   */
  setMCPServerManager(manager: MCPServerManager): void {
    this.mcpServerManager = manager;
  }

  setWorkspaceMcpOverridesService(service: WorkspaceServiceMcpOverridesPort): void {
    this.workspaceMcpOverridesService = service;
  }

  /**
   * Workspace IDs whose creation persisted a config entry but has not yet
   * finished registration-time plugin-override sanitization. Two overlapping
   * creations for the same checkout would otherwise each see the other's
   * just-persisted entry as a live sibling and BOTH skip sanitizing; entries
   * in this set never qualify as siblings, so the first sanitize to run
   * prunes (a concurrent double-prune is idempotent) and later ones see a
   * completed registration.
   */
  private readonly pendingPluginSanitizations = new Set<string>();

  /**
   * Serializes persist + sanitize of a new host-local registration across
   * PROCESSES sharing this config root. pendingPluginSanitizations only
   * covers this process: two processes registering the same preserved
   * checkout could otherwise each persist an entry and then each read the
   * other's unsanitized entry as a live sibling — both skipping the prune,
   * letting a stale canonical enable activate a same-name reinstall's
   * default-disabled server. Under the lock the second registrant scans only
   * after the first's prune committed, so it correctly sees a completed live
   * sibling.
   */
  private acquireRegistrationSanitizeLock(): Promise<() => Promise<void>> {
    return acquireCrossProcessLock({
      lockPath: path.join(this.config.rootDir, "workspace-registration.lock"),
      // Persist + sibling scan + one override-file prune; canonicalization is
      // bounded per entry, so a minute outlasts any legitimate holder.
      acquireTimeoutMs: 60_000,
      staleMs: 5 * 60_000,
      timeoutMessage:
        "Another Mux process is currently registering a workspace. Wait for it to finish and try again.",
    });
  }

  /**
   * Task orchestration entry point: task worktrees are REGISTERED before their
   * checkout exists (queued/reserved launches persist the entry with a future
   * path), so creation-time sanitization cannot cover them and an uninstall's
   * override pruning enumerates a path with nothing to prune — the later
   * materialization then restores a committed stale `plugin:` enable. Call
   * this after the checkout materializes and BEFORE the first send. Off-host
   * runtimes are skipped (plugin servers never spawn there in v1); shared
   * parent checkouts are skipped by the live-sibling scan inside.
   * Returns an error string (the launch must fail) or undefined on success.
   */
  async sanitizeMaterializedTaskWorkspace(
    workspaceId: string,
    workspacePath: string,
    runtimeConfig: RuntimeConfig | undefined,
    persistentSiblingConfig?: Pick<Config, "loadConfigOrDefault">
  ): Promise<string | undefined> {
    const hostLocal =
      runtimeConfig === undefined ||
      runtimeConfig.type === "local" ||
      runtimeConfig.type === "worktree";
    if (!hostLocal) {
      return undefined;
    }
    return this.sanitizeStalePluginOverridesForNewWorkspace(
      workspaceId,
      workspacePath,
      persistentSiblingConfig
    );
  }

  /**
   * Registration-time sanitization for workspaces that AgentSession registers
   * directly (CLI `xum run` / `xum workflow` in a directory without existing
   * metadata) — a path that bypasses WorkspaceService.create/fork and the
   * task-materialization flows. Called between the config write and the
   * metadata announcement; on failure the registration is rolled back so a
   * preserved checkout's stale `plugin:` enables can never activate a
   * same-name reinstall's default-disabled server on the first CLI send.
   * Returns an error string (the caller must abort) or undefined on success.
   */
  async sanitizeCliRegisteredWorkspace(
    workspaceId: string,
    workspacePath: string,
    runtimeConfig: RuntimeConfig | undefined,
    /**
     * CLI sessions run on an EPHEMERAL config whose project entries carry no
     * workspace records, so the live-sibling scan below would never see a
     * desktop workspace registered for the same checkout — and would prune
     * plugin enables that live consent context still owns from the shared
     * .xum/mcp.local.jsonc. Callers on a temp config must pass the persistent
     * config so those siblings are visible.
     */
    persistentSiblingConfig?: Pick<Config, "loadConfigOrDefault">
  ): Promise<string | undefined> {
    this.pendingPluginSanitizations.add(workspaceId);
    try {
      const sanitizeError = await this.sanitizeMaterializedTaskWorkspace(
        workspaceId,
        workspacePath,
        runtimeConfig,
        persistentSiblingConfig
      );
      if (sanitizeError !== undefined) {
        await this.rollbackUnsanitizedWorkspaceRegistration(workspaceId);
      }
      return sanitizeError;
    } finally {
      this.pendingPluginSanitizations.delete(workspaceId);
    }
  }

  /**
   * Registration-time sanitization of stale Agent Plugin override keys.
   *
   * A host-local workspace's `.mux/mcp.local.jsonc` lives in the checkout,
   * which removal PRESERVES — while a removed workspace is invisible to the
   * plugin uninstaller's pruning/tombstones. Plugin-server consent must die
   * with the workspace that granted it: when a directory is REGISTERED as a
   * new local workspace and no other live workspace resolves to the same
   * path, canonical `plugin:<16-hex>:` keys are pruned before the workspace
   * is announced, so a stale enable can never silently re-activate a
   * same-name reinstall's default-disabled server.
   *
   * Deliberately NOT done at removal time: a removal-time prune edits a file
   * that sibling workspaces (conversation forks share the local checkout) may
   * still be using, has no durable retry if it fails (the workspace becomes
   * unresolvable), and races Workspace MCP dialog saves that land between the
   * prune and the metadata drop. Sanitizing at the moment the NEW workspace
   * identity is created has none of those windows: siblings force a skip,
   * a failure aborts creation (nothing announced, no silent activation), and
   * no dialog can target a workspace that has not been announced yet.
   *
   * Returns an error string (creation must abort) or undefined on success.
   */
  private async sanitizeStalePluginOverridesForNewWorkspace(
    workspaceId: string,
    workspacePath: string,
    persistentSiblingConfig?: Pick<Config, "loadConfigOrDefault">
  ): Promise<string | undefined> {
    if (!this.workspaceMcpOverridesService) {
      return undefined;
    }
    // A sibling workspace resolving to the same checkout (local-runtime
    // conversation forks) means the consent context is still ALIVE — its
    // enables must survive, and the uninstaller can still reach the file
    // through that sibling. Qualification is deliberately strict on runtime
    // KIND and loose on path SPELLING:
    // - Only host-local workspaces (project-dir local / worktree, including
    //   legacy entries without a runtimeConfig) qualify: an SSH or container
    //   workspace whose persisted remote path merely equals this local path
    //   string lives in a different filesystem namespace and preserves no
    //   consent context for the local file.
    // - Paths compare by canonical filesystem identity (realpath) IN ADDITION
    //   to normalized spelling: a sibling registered through a symlinked or
    //   differently-cased spelling of the same checkout must still be
    //   recognized, or pruning would strip a live workspace's enables.
    //   Failures fall back to spelling so an unresolvable path errs toward
    //   skipping (leaving keys) rather than pruning live consent.
    // Bounded canonicalization: realpath against a stalled filesystem (e.g. a
    // dead NFS mount backing an UNRELATED persistent workspace record) must
    // not hang CLI registration indefinitely. Timeouts join ordinary realpath
    // failures in the spelling fallback below.
    const CANONICALIZE_TIMEOUT_MS = 2_000;
    const canonicalize = async (candidate: string): Promise<string> => {
      const stripped = stripTrailingSlashes(candidate);
      let timer: NodeJS.Timeout | undefined;
      try {
        return await Promise.race([
          fsPromises.realpath(stripped),
          new Promise<never>((_resolve, reject) => {
            timer = setTimeout(
              () => reject(new Error("realpath timed out")),
              CANONICALIZE_TIMEOUT_MS
            );
          }),
        ]);
      } catch {
        return stripped;
      } finally {
        clearTimeout(timer);
      }
    };
    const isHostLocalConfig = (runtimeConfig: RuntimeConfig | undefined): boolean =>
      runtimeConfig === undefined ||
      runtimeConfig.type === "local" ||
      runtimeConfig.type === "worktree";
    const normalizedPath = stripTrailingSlashes(workspacePath);
    const canonicalPath = await canonicalize(workspacePath);
    // Scan the service's own config AND (when provided) the persistent one:
    // ephemeral CLI configs carry no workspace records, so a desktop
    // workspace live on the same checkout is only visible in the latter.
    // The persistent source reads in THROWING mode: the lenient read swallows
    // a malformed/unreadable config into an empty project map, which reads as
    // "no live sibling" and would prune enables a live desktop workspace
    // still owns. A missing file still yields the default (genuinely no
    // siblings). this.config keeps the lenient read — it is the service's own
    // store, whose desktop/task registration paths already depend on it.
    let configSnapshots: ProjectsConfig[];
    try {
      configSnapshots = [
        this.config.loadConfigOrDefault(),
        ...(persistentSiblingConfig
          ? [persistentSiblingConfig.loadConfigOrDefault({ throwOnError: true })]
          : []),
      ];
    } catch (error) {
      return `Cannot verify live sibling workspaces for plugin override sanitization (the persistent config is unreadable: ${getErrorMessage(error)}). Refusing to prune; fix the config and retry.`;
    }
    for (const config of configSnapshots) {
      for (const project of config.projects.values()) {
        for (const workspace of project.workspaces) {
          if (
            workspace.id === workspaceId ||
            // Registered-but-unsanitized entries from an overlapping creation
            // are not live consent contexts (see pendingPluginSanitizations).
            (workspace.id !== undefined && this.pendingPluginSanitizations.has(workspace.id)) ||
            !isHostLocalConfig(workspace.runtimeConfig)
          ) {
            continue;
          }
          if (
            stripTrailingSlashes(workspace.path) === normalizedPath ||
            (await canonicalize(workspace.path)) === canonicalPath
          ) {
            return undefined;
          }
        }
      }
    }
    try {
      // A new identity owes no earlier pass an epoch bump: require the
      // cross-process signal only when this pass actually rewrote a file, so
      // a fork copy's valid key-free document is not rolled back by a
      // transiently unwritable epoch file.
      await this.workspaceMcpOverridesService.prunePluginOverrideKeys(workspaceId, "plugin:", {
        epochOnlyWhenRewritten: true,
      });
      return undefined;
    } catch (error) {
      // Abort creation instead of proceeding with the stale file: continuing
      // would re-create the silent-activation path this sanitization exists
      // to close, with no durable record left to retry it.
      return `The directory's existing MCP overrides file could not be sanitized: ${getErrorMessage(error)}. Fix or remove the workspace MCP overrides file (.xum/mcp.local.jsonc, or legacy .mux/mcp.local.jsonc) in ${workspacePath} and try again.`;
    }
  }

  /**
   * Roll back a just-persisted workspace registration and VERIFY it left the
   * on-disk config. Config.saveConfig logs and swallows write failures, so
   * removeWorkspace can resolve while the entry is still persisted — after a
   * restart that entry would resurrect with the unsanitized overrides file
   * this rollback exists to keep unreachable. Returns whether the entry is
   * provably gone from disk.
   */
  private async rollbackUnsanitizedWorkspaceRegistration(workspaceId: string): Promise<boolean> {
    for (let attempt = 0; attempt < 2; attempt++) {
      await this.config.removeWorkspace(workspaceId).catch(() => undefined);
      const persisted = this.config.loadConfigOrDefault();
      const stillPresent = Array.from(persisted.projects.values()).some((project) =>
        project.workspaces.some((workspace) => workspace.id === workspaceId)
      );
      if (!stillPresent) {
        return true;
      }
    }
    log.error(
      `Failed to roll back workspace ${workspaceId} after plugin-override sanitization aborted creation`
    );
    return false;
  }

  /**
   * Undo a registration whose checkout could not be sanitized: the config entry, the
   * worktree this creation made, and the in-memory state registered for it. Returns whether
   * the entry is provably gone.
   */
  private async abortUnsanitizedCreation(args: {
    workspaceId: string;
    runtime: Runtime;
    runtimeConfig: RuntimeConfig;
    projectPath: string;
    workspaceName: string;
    trusted: boolean;
    initAbortController: AbortController;
  }): Promise<boolean> {
    const { workspaceId } = args;
    const rolledBack = await this.rollbackUnsanitizedWorkspaceRegistration(workspaceId);
    // WORKTREE runtimes created a fresh checkout; without deleting it,
    // retrying the same branch collides with the orphaned worktree and leaks
    // a suffixed checkout per attempt. LocalRuntime registered an EXISTING
    // user directory, which must be preserved (its deleteWorkspace is a
    // no-op by design, but we never call it here to keep that contract
    // explicit). Only after a successful config rollback: while the entry
    // persists, the checkout is still referenced.
    if (rolledBack && isWorktreeRuntime(args.runtimeConfig)) {
      const deleteResult = await args.runtime
        .deleteWorkspace(
          args.projectPath,
          // Worktree directories are named after the sanitized workspace
          // name (branch names may contain "/").
          args.workspaceName,
          false,
          undefined,
          args.trusted
        )
        .catch((error: unknown) => ({
          success: false as const,
          error: getErrorMessage(error),
        }));
      if (!deleteResult.success) {
        log.warn("Failed to remove created worktree after sanitization aborted creation", {
          workspaceId,
          error: deleteResult.error,
        });
      }
    }
    // Tear down the in-memory state registered earlier in this creation
    // (session, init record, abort controller) exactly like workspace
    // removal would; without this every aborted retry against the same bad
    // file leaks another unreachable session for the process lifetime.
    args.initAbortController.abort();
    this.initAbortControllers.delete(workspaceId);
    this.initStateManager.clearInMemoryState(workspaceId);
    await this.disposeSession(workspaceId);
    return rolledBack;
  }

  /**
   * Background init for a worktree announced before its files existed: populate the
   * checkout (streaming progress to the creation card), then sanitize plugin overrides
   * exactly as task worktrees do after materialization, then run the ordinary init.
   * A checkout failure fails the init like any deferred runtime's sync failure, but the
   * checkout is still sanitized first: a later step (submodules, .xumignore) can fail after
   * the tracked override file is already on disk, and sends proceed after a failed init.
   * A sanitize failure tears the creation down, as it would have at registration time.
   */
  private async materializeDeferredCheckout(args: {
    workspaceId: string;
    runtime: Runtime;
    runtimeConfig: RuntimeConfig;
    workspaceName: string;
    initParams: WorkspaceInitParams;
    pending: PendingMaterialization;
    initAbortController: AbortController;
  }): Promise<void> {
    const { workspaceId, runtime, initParams } = args;
    assert(
      runtime.materializeWorkspace !== undefined,
      "materializeDeferredCheckout: runtime cannot materialize"
    );
    let materializeError: unknown;
    try {
      await runtime.materializeWorkspace(initParams, args.pending);
    } catch (error) {
      materializeError = error;
    }
    if (args.initAbortController.signal.aborted) {
      // Removal owns the checkout now (it aborted us and awaits this settlement).
      return;
    }
    const sanitizeError = await this.sanitizeMaterializedTaskWorkspace(
      workspaceId,
      initParams.workspacePath,
      args.runtimeConfig
    );
    if (sanitizeError !== undefined) {
      log.error(`Workspace creation aborted for ${workspaceId}: ${sanitizeError}`);
      initParams.initLogger.logStderr(sanitizeError);
      await this.abortUnsanitizedCreation({
        workspaceId,
        runtime,
        runtimeConfig: args.runtimeConfig,
        projectPath: initParams.projectPath,
        workspaceName: args.workspaceName,
        trusted: initParams.trusted ?? false,
        initAbortController: args.initAbortController,
      });
      initParams.initLogger.logComplete(-1);
      // Already announced, unlike a registration-time abort.
      this.emit("metadata", { workspaceId, metadata: null });
      return;
    }
    if (materializeError !== undefined) {
      log.error(`Workspace checkout failed for ${workspaceId}:`, { error: materializeError });
      const [summary, ...details] = getErrorMessage(materializeError).split(/\r?\n/);
      initParams.initLogger.logStderr(`Initialization failed: ${summary}`);
      for (const line of details) {
        if (line) initParams.initLogger.logStderr(line);
      }
      initParams.initLogger.logComplete(-1);
      return;
    }
    await runBackgroundInit(runtime, initParams, workspaceId, log);
  }

  setWorkspaceGoalService(service: WorkspaceGoalService): void {
    this.workspaceGoalService = service;
  }

  /**
   * Set the terminal service for cleanup on workspace removal.
   */
  setTerminalService(terminalService: TerminalService): void {
    this.terminalService = terminalService;
    // Archive admission pairing for terminal startups: create() checks this guard in the same
    // synchronous block as its startup reservation, so whichever of {archive gate, terminal
    // entry} runs first is observed by the other (see archiveUnlocked's refuseLiveUserActivity
    // gate and TerminalService.create).
    terminalService.setWorkspaceArchiveGuard((workspaceId) =>
      this.archivingWorkspaces.has(workspaceId)
    );
  }

  setDesktopSessionManager(manager: DesktopSessionManager): void {
    this.desktopSessionManager = manager;
    // Archive admission pairing for desktop startups (mirrors setTerminalService above):
    // ensureStarted checks this guard in the same synchronous block that registers its startup
    // promise, so whichever of {archive gate, desktop startup entry} runs first is observed by
    // the other. Removal latches removingWorkspaces before closing the desktop and only then
    // awaits config deletion, so a borrower bridge connecting in that window must be refused
    // by the same guard rather than start a session the removal never closes.
    manager.setWorkspaceArchiveGuard(
      (workspaceId) =>
        this.archivingWorkspaces.has(workspaceId) || this.removingWorkspaces.has(workspaceId)
    );
  }

  private async closeDesktopSessionBestEffort(
    workspaceId: string,
    reason: "archive" | "remove"
  ): Promise<void> {
    try {
      await this.desktopSessionManager?.close(workspaceId);
    } catch (error) {
      log.debug(
        `Failed to close desktop session during ${reason} for workspace ${workspaceId}: ${getErrorMessage(error)}`
      );
    }
  }

  /** Background dream consolidation (memory-consolidation experiment); wired by coreServices. */
  setMemoryConsolidationService(service: {
    triggerInBackground(workspaceId: string, trigger: "compaction" | "archive"): void;
    triggerHarvestThenSweepInBackground(metadata: CompactionCompletionMetadata): void;
    cancelInFlightConsolidation(workspaceId: string): Promise<void>;
  }): void {
    this.memoryConsolidationService = service;
  }

  setWorkspaceLifecycleHooks(hooks: WorkspaceLifecycleHooks): void {
    this.workspaceLifecycleHooks = hooks;
  }

  setWorktreeArchiveSnapshotService(service: WorktreeArchiveSnapshotLifecycleService): void {
    this.worktreeArchiveSnapshotService = service;
  }

  setAgentTaskIntegration(integration: AgentTaskIntegration): void {
    this.agentTaskIntegration = integration;
  }

  /** DevTools debug-log cleanup on archive/remove; wired by coreServices. */
  setDevToolsService(service: WorkspaceDevToolsCleanup): void {
    this.devToolsService = service;
  }

  /** Refine-pass cancellation on remove; wired by the service container. */
  setRefinePassCanceller(service: {
    cancelInFlightRefinePass(workspaceId: string): Promise<void>;
  }): void {
    this.refinePassCanceller = service;
  }

  /**
   * Serialize a context-discarding history mutation (reset, full clear,
   * destructive replace) with refine staging/apply, which hold the same
   * per-workspace lockfile across their recheck-and-publish write sections.
   * Without it, a refine pass could recheck before the mutation and publish
   * after it, landing a proposal distilled from the discarded rows where the
   * approval-hash scan accepts it. Callers must cancel+drain in-flight
   * passes BEFORE acquiring (a drained pass may be waiting on this lock).
   */
  private async acquireRefineSerializationLock(
    workspaceId: string,
    operation: string
  ): Promise<Result<AsyncDisposable>> {
    try {
      return Ok(
        await acquireProcessFileLock({
          // r66: session-dir-external (see refineApplyLockPath) — acquiring
          // the old in-session lockfile after removal recreated the deleted
          // directory via the lock's own mkdir.
          lockPath: refineApplyLockPath(this.config.rootDir, workspaceId),
          timeoutMs: REFINE_APPLY_CROSS_PROCESS_LOCK_TIMEOUT_MS,
          label: `refine serialization lock (${operation})`,
        })
      );
    } catch (error) {
      return Err(
        `Cannot ${operation} while a refine operation is in progress: ${getErrorMessage(error)}`
      );
    }
  }

  /** r41: mark a context-discarding mutation as durably committed (see contextMutationEpochs). */
  private advanceContextMutationEpoch(workspaceId: string): void {
    this.contextMutationEpochs.set(
      workspaceId,
      (this.contextMutationEpochs.get(workspaceId) ?? 0) + 1
    );
  }

  /**
   * Admission guard for context-discarding history mutations (r40): reject
   * new sends at the door (contextMutationWorkspaces), block turn admission
   * inside the session, and only then verify idleness — all in one
   * synchronous block, so no turn can slip between the check and the guard
   * (see AgentSession.holdTurnAdmission for the pairing argument). Callers
   * hold the guard across the whole mutation — including the refine
   * drain/lock awaits — and must recheck busy-ness after those awaits for
   * the turn starts that bypass admission gating (in-turn compaction
   * retries observing a transient idle gap).
   *
   * Scope: process-local, like every send/rename/remove/busy guard in this
   * service. Under XUM_ALLOW_MULTIPLE_INSTANCES=1 a second backend sharing
   * the workspace can admit a send this guard never sees; sends do not
   * participate in a cross-process admission protocol (only refine's
   * durable staging/apply state does, via refine-apply.lock). Multi-instance
   * mode is a development escape hatch — concurrent turn traffic against one
   * workspace from two backends is unsupported beyond those durable-state
   * locks.
   */
  private acquireContextMutationAdmissionGuard(
    workspaceId: string,
    operation: "truncate history" | "reset context" | "replace history"
  ): Result<Disposable> {
    if (this.contextMutationWorkspaces.has(workspaceId)) {
      return Err("A context reset or clear is already in progress for this workspace.");
    }
    const session = this.getOrCreateSession(workspaceId);
    this.contextMutationWorkspaces.add(workspaceId);
    const admissionHold = session.holdTurnAdmission();
    const guard: Disposable = {
      [Symbol.dispose]: () => {
        this.contextMutationWorkspaces.delete(workspaceId);
        admissionHold[Symbol.dispose]();
      },
    };
    // Busy check AFTER arming the block: a turn admitted first is observed
    // here; a turn admitted later observes the block and refuses. Pending
    // mid-stream compaction counts as turn work (r43): its direct session
    // send bypasses this service's entry accounting.
    if (session.hasActiveOrPendingTurnWork() || this.aiService.isStreaming(workspaceId)) {
      guard[Symbol.dispose]();
      return Err(`Cannot ${operation} while a turn is active. Press Esc to stop the stream first.`);
    }
    // r42: a send between its entry check and admission may have passed its
    // pre-persist gate but not yet appended its rows. If this mutation
    // committed first, those rows — including attacker-influenced family
    // payload rows — would land durably in the fresh context: the epoch gate
    // blocks the send's stream but cannot un-append. Refuse instead; sends
    // settle in bounded time and the user retries. Counted synchronously at
    // the send's entry, so one side always observes the other.
    if ((this.preflightSendCounts.get(workspaceId) ?? 0) > 0) {
      guard[Symbol.dispose]();
      return Err(`Cannot ${operation} while a message is being sent. Try again in a moment.`);
    }
    return Ok(guard);
  }

  /**
   * Block turn admission while a background service (/refine) publishes rows
   * into an idle workspace's history or applies refinements (r40). Fails
   * when a turn is active: foreign rows must not land inside a PREPARING
   * snapshot window or between a streaming turn's user row and its response.
   * Same Dekker pairing as acquireContextMutationAdmissionGuard, without the
   * send entry-set — sends admitted after release see the completed append.
   */
  acquireIdleTurnExclusion(workspaceId: string): Result<Disposable> {
    const session = this.getOrCreateSession(workspaceId);
    const hold = session.holdTurnAdmission();
    // Pending mid-stream compaction counts as turn work (r43): its direct
    // session send bypasses this service's entry accounting, so publishing
    // between the stopped stream and the compaction request would interleave
    // exactly like publishing mid-turn.
    if (session.hasActiveOrPendingTurnWork() || this.aiService.isStreaming(workspaceId)) {
      hold[Symbol.dispose]();
      return Err("a turn is preparing or streaming");
    }
    // r41: a send between its entry check and admission looks idle here, but
    // may have already persisted its user row — publishing and releasing
    // before it resumes would slip the published row into its request as a
    // trailing foreign assistant row. Refuse instead; the caller reports a
    // retryable failure. Counted synchronously at the send's entry, so on a
    // single thread one side always observes the other.
    if ((this.preflightSendCounts.get(workspaceId) ?? 0) > 0) {
      hold[Symbol.dispose]();
      return Err("a send is being admitted");
    }
    return Ok(hold);
  }

  private getWorktreeArchiveBehavior(): "keep" | "delete" | "snapshot" {
    return (
      this.config.loadConfigOrDefault().worktreeArchiveBehavior ?? DEFAULT_WORKTREE_ARCHIVE_BEHAVIOR
    );
  }

  private isSharedTaskWorkspace(workspaceId: string): boolean {
    const entry = findWorkspaceEntry(this.config.loadConfigOrDefault(), workspaceId);
    return entry?.workspace.taskIsolation === "none";
  }

  private async getCurrentArchiveUntrackedPaths(args: {
    workspaceId: string;
    workspaceMetadata: WorkspaceMetadata;
  }): Promise<Result<string[]>> {
    if (this.worktreeArchiveSnapshotService == null) {
      return Ok([]);
    }

    if (!isWorktreeRuntime(args.workspaceMetadata.runtimeConfig)) {
      return Ok([]);
    }

    // Multi-project workspaces skip snapshot capture entirely, so there is nothing to confirm.
    if (
      Array.isArray(args.workspaceMetadata.projects) &&
      args.workspaceMetadata.projects.length > 1
    ) {
      return Ok([]);
    }

    const unsupportedUntrackedPathsResult =
      await this.worktreeArchiveSnapshotService.getUnsupportedUntrackedPaths({
        workspaceId: args.workspaceId,
        workspaceMetadata: args.workspaceMetadata,
      });
    if (!unsupportedUntrackedPathsResult.success) {
      return Err(unsupportedUntrackedPathsResult.error);
    }

    return Ok(normalizeArchiveUntrackedPaths(unsupportedUntrackedPathsResult.data));
  }

  private async getArchiveUntrackedFilesConfirmation(args: {
    workspaceId: string;
    workspaceMetadata: WorkspaceMetadata;
    acknowledgedUntrackedPaths?: string[];
  }): Promise<Result<ArchiveLossyUntrackedFilesConfirmation | null>> {
    const currentUntrackedPathsResult = await this.getCurrentArchiveUntrackedPaths({
      workspaceId: args.workspaceId,
      workspaceMetadata: args.workspaceMetadata,
    });
    if (!currentUntrackedPathsResult.success) {
      return Err(currentUntrackedPathsResult.error);
    }

    const currentUntrackedPaths = currentUntrackedPathsResult.data;
    if (currentUntrackedPaths.length === 0) {
      return Ok(null);
    }

    if (args.acknowledgedUntrackedPaths == null) {
      return Ok(buildArchiveLossyUntrackedFilesConfirmation(currentUntrackedPaths));
    }

    if (
      !areArchiveUntrackedPathListsEqual(args.acknowledgedUntrackedPaths, currentUntrackedPaths)
    ) {
      return Ok(buildArchiveLossyUntrackedFilesConfirmation(currentUntrackedPaths));
    }

    return Ok(null);
  }

  /**
   * Best-effort startup recovery for non-task chats so restart auto-retry can resume
   * interrupted turns before the user explicitly opens each workspace.
   */
  async initialize(options?: { signal?: AbortSignal }): Promise<void> {
    const startupStartedAt = Date.now();

    try {
      await this.cleanupOrphanScratchWorkdirs().catch((error: unknown) => {
        log.debug("Failed to clean orphaned scratch workdirs", { error });
      });
      const allMetadata = await this.config.getAllWorkspaceMetadata();
      await this.cleanupOrphanSessionDirs(allMetadata).catch((error: unknown) => {
        log.debug("Failed to clean orphaned session directories", { error });
      });
      await this.cleanupArchivedDevToolsLogs(allMetadata).catch((error: unknown) => {
        log.debug("Failed to clean archived workspace DevTools logs", { error });
      });
      let scheduledCount = 0;
      let skippedTaskCount = 0;
      let skippedArchivedCount = 0;

      // Shutdown may have started during the cleanups above; the (synchronous) loop below must
      // not spawn recovery sessions that beginShutdown() has already swept.
      if (options?.signal?.aborted === true) {
        log.info("[startup] WorkspaceService.initialize cancelled before scheduling recovery");
        return;
      }
      // This can run while the server is already serving clients, and the cleanups above took
      // time: re-read config right before the (synchronous) scheduling loop so a workspace archived
      // or removed since `allMetadata` was read does not get a hidden recovery stream.
      const liveConfig = this.config.loadConfigOrDefault();
      for (const metadata of allMetadata) {
        if (metadata.parentWorkspaceId != null) {
          skippedTaskCount += 1;
          continue;
        }

        const live = findWorkspaceEntry(liveConfig, metadata.id)?.workspace;
        if (live == null || isWorkspaceArchived(live.archivedAt, live.unarchivedAt)) {
          skippedArchivedCount += 1;
          continue;
        }

        this.startStartupRecovery(metadata.id, metadata);
        scheduledCount += 1;
      }

      // Repair .code-workspace drift from lifecycle changes that happened while
      // the app was not running. Each sync is internally bounded, but startup
      // additionally caps the whole loop: many enabled projects on a stalled
      // filesystem must never delay launch. Past the deadline the loop keeps
      // running in the background; syncProjectCodeWorkspace never throws, so
      // the orphaned promise cannot reject unhandled.
      const codeWorkspaceSyncAll = (async () => {
        for (const [projectPath, projectConfig] of this.config.loadConfigOrDefault().projects) {
          if (projectConfig.codeWorkspaceSyncPath?.trim()) {
            await syncProjectCodeWorkspace(this.config, projectPath);
          }
        }
      })();
      await raceWithAbortAndTimeout(codeWorkspaceSyncAll, {
        timeoutMs: STARTUP_CODE_WORKSPACE_SYNC_TIMEOUT_MS,
      });

      log.info("[startup] WorkspaceService.initialize completed", {
        totalMs: Date.now() - startupStartedAt,
        scheduledCount,
        skippedTaskCount,
        skippedArchivedCount,
      });
    } catch (error) {
      log.warn("[startup] WorkspaceService.initialize failed", {
        totalMs: Date.now() - startupStartedAt,
        error: error instanceof Error ? error.message : String(error),
      });
    }
  }

  isExperimentEnabled(experimentId: (typeof EXPERIMENT_IDS)[keyof typeof EXPERIMENT_IDS]): boolean {
    return this.experimentsService?.isExperimentEnabled(experimentId) === true;
  }

  private async stopLiveWorkspaceActivityForArchive(workspaceId: string): Promise<void> {
    // Archiving removes the workspace from the sidebar; ensure we don't leave a stream running
    // "headless" with no obvious UI affordance to interrupt it.
    if (this.aiService.isStreaming(workspaceId)) {
      const stopResult = await this.interruptStream(workspaceId);
      if (!stopResult.success) {
        log.debug("Failed to stop stream during workspace archive", {
          workspaceId,
          error: stopResult.error,
        });
      }
    }

    // Archiving hides workspace UI; do not leave terminal PTYs running headless.
    this.terminalService?.closeWorkspaceSessions(workspaceId);

    // Cached MCP servers outlive the stream that started them, and stdio ones run inside the
    // checkout a snapshot archive is about to delete. Removal-style stop (no
    // retainRestartOptions): its stop-epoch bump makes a startup already in flight close its late
    // clients instead of publishing them; servers restart lazily on the first MCP use after
    // unarchive.
    await this.mcpServerManager?.stopServers(workspaceId);
  }

  /**
   * DEBUG ONLY: Trigger an artificial stream error for testing.
   * This is used by integration tests to simulate network errors mid-stream.
   * @returns true if an active stream was found and error was triggered
   */
  debugTriggerStreamError(
    workspaceId: string,
    errorMessage = "Test-triggered stream error"
  ): Promise<boolean> {
    return (
      this.streamManager?.debugTriggerStreamError(workspaceId, errorMessage) ??
      Promise.resolve(false)
    );
  }

  /**
   * Setup listeners to update metadata store based on AIService events.
   * This tracks workspace recency and streaming status for VS Code extension integration.
   */
  private setupMetadataListeners(): void {
    const isObj = (v: unknown): v is Record<string, unknown> => typeof v === "object" && v !== null;
    const isWorkspaceEvent = (v: unknown): v is { workspaceId: string } =>
      isObj(v) && "workspaceId" in v && typeof v.workspaceId === "string";
    const isStreamStartEvent = (v: unknown): v is StreamStartEvent =>
      isWorkspaceEvent(v) && "model" in v && typeof (v as { model: unknown }).model === "string";
    const isStreamEndEvent = (v: unknown): v is StreamEndEvent =>
      isWorkspaceEvent(v) &&
      (!("metadata" in (v as Record<string, unknown>)) || isObj((v as StreamEndEvent).metadata));
    const isStreamAbortEvent = (v: unknown): v is StreamAbortEvent => isWorkspaceEvent(v);
    const isErrorEvent = (
      v: unknown
    ): v is { workspaceId: string; error: string; errorType?: StreamErrorType } =>
      isWorkspaceEvent(v) && "error" in v && typeof (v as { error: unknown }).error === "string";
    const isToolCallEndEvent = (v: unknown): v is ToolCallEndEvent =>
      isWorkspaceEvent(v) &&
      "toolName" in v &&
      typeof (v as { toolName: unknown }).toolName === "string" &&
      "result" in v;
    const extractStatusSetResult = (result: unknown): WorkspaceAgentStatus | null =>
      isObj(result) && result.success === true ? coerceAgentStatus(result) : null;
    const isSuccessfulToolResult = (result: unknown): result is { success: true } =>
      isObj(result) && result.success === true;
    // Update streaming status and recency on stream start
    this.aiService.on("stream-start", (data: unknown) => {
      if (isStreamStartEvent(data)) {
        const generation = (this.streamingGenerations.get(data.workspaceId) ?? 0) + 1;
        this.streamingGenerations.set(data.workspaceId, generation);
        if (data.agentId === "compact" || data.mode === "compact") {
          this.compactionStreamGenerations.set(data.workspaceId, generation);
        } else {
          this.compactionStreamGenerations.delete(data.workspaceId);
        }
        void this.updateStreamingStatus(data.workspaceId, true, {
          model: data.model,
          thinkingLevel: data.thinkingLevel,
          generation,
        });
      }
    });

    this.aiService.on("stream-end", (data: unknown) => {
      if (isStreamEndEvent(data)) {
        void this.handleStreamCompletion(data.workspaceId);
        this.scheduleBashMonitorWakeReconcile(data.workspaceId);
      }
    });

    this.aiService.on("stream-abort", (data: unknown) => {
      if (isStreamAbortEvent(data)) {
        void this.stopStreamingStatus(data.workspaceId);
        this.scheduleBashMonitorWakeReconcile(data.workspaceId);
        // Goal mutations are drained by AgentSession after any abort accounting
        // runs. Draining here would race ahead of AgentSession's stream-abort
        // listener and could charge the aborted in-flight stream to a goal that
        // was queued during that stream. User aborts are still discarded by
        // recordUserStoppedStream in AgentSession.
      }
    });

    this.aiService.on("error", (data: unknown) => {
      if (isErrorEvent(data)) {
        // Read the idle-compaction marker before stopStreamingStatus clears it, so a
        // mid-stream failure (e.g. provider rejecting the compaction model) stops the loop.
        if (this.idleCompactingWorkspaces.has(data.workspaceId)) {
          this.reportIdleCompactionOutcome(data.workspaceId, {
            success: false,
            modelNotFound: data.errorType === "model_not_found",
          });
        }
        void this.stopStreamingStatus(data.workspaceId);
        this.scheduleBashMonitorWakeReconcile(data.workspaceId);
        void this.workspaceGoalService?.applyPendingAfterStreamEnd(data.workspaceId);
      }
    });

    this.aiService.on("tool-call-end", (data: unknown) => {
      if (!isToolCallEndEvent(data) || data.replay === true) {
        return;
      }

      if (data.toolName === "status_set") {
        const agentStatus = extractStatusSetResult(data.result);
        if (!agentStatus) {
          return;
        }

        void this.updateAgentStatus(data.workspaceId, agentStatus);
        return;
      }

      if (
        (data.toolName === "todo_write" || data.toolName === "propose_plan") &&
        isSuccessfulToolResult(data.result)
      ) {
        void this.updateTodoStatusFromStorage(data.workspaceId);
      }
    });
  }

  private setupInitMetadataListeners(): void {
    const isObj = (v: unknown): v is Record<string, unknown> => typeof v === "object" && v !== null;
    const isWorkspaceEvent = (v: unknown): v is { workspaceId: string } =>
      isObj(v) && "workspaceId" in v && typeof v.workspaceId === "string";

    // When init completes, refresh metadata so the UI can clear isInitializing and swap
    // "Cancel creation" back to the normal archive affordance.
    this.initStateManager.on("init-end", (event: unknown) => {
      if (!isWorkspaceEvent(event)) {
        return;
      }
      void this.refreshAndEmitMetadata(event.workspaceId);
    });
  }

  private async populateActiveWorkflowRunIds(
    workspaceId: string,
    activeRunIds: Set<string>
  ): Promise<Set<string>> {
    try {
      const runStore = new WorkflowRunStore({
        sessionDir: path.join(this.config.sessionsDir, workspaceId),
      });
      const runs = await runStore.listRunStatusSnapshots();
      for (const run of runs) {
        if (
          run.workspaceId === workspaceId &&
          !isNestedWorkflowRun(run) &&
          isActiveWorkflowRunStatus(run.status)
        ) {
          activeRunIds.add(run.id);
        }
      }
    } catch (error) {
      log.debug("Failed to inspect active workflow runs for workspace activity", {
        workspaceId,
        error,
      });
    }
    return activeRunIds;
  }

  private async getActiveWorkflowRunIds(workspaceId: string): Promise<Set<string>> {
    const activeRunIds = await this.resolveActiveWorkflowRunIds(workspaceId);
    if (
      activeRunIds.size > 0 &&
      // Installation re-check in THIS continuation: an eviction (removal, or
      // a tombstone lifted for revival) can land in the microtask gap after
      // resolve's own final check. A detached set must not repopulate the
      // seen marker — the evicted id's caches are empty, so a stale marker
      // would fabricate zero-count entries for the idle revived workspace.
      this.activeWorkflowRunIdsByWorkspace.get(workspaceId) === activeRunIds
    ) {
      // A list- or event-delivered nonzero count is what makes a later zero
      // meaningful as a tombstone (see workflowRunSeenWorkspaces).
      this.workflowRunSeenWorkspaces.add(workspaceId);
    }
    return activeRunIds;
  }

  private async resolveActiveWorkflowRunIds(workspaceId: string): Promise<Set<string>> {
    assert(workspaceId.length > 0, "getActiveWorkflowRunIds requires workspaceId");
    // Bounded retry: evictWorkspaceActivityCaches (removal, or a tombstone
    // lifted for re-registration) can race an in-flight bootstrap. A waiter
    // that captured the pre-eviction Set would otherwise return the removed
    // incarnation's runs — ghost counts with no future terminal event to
    // clear them — so after every await the Set is re-verified as still the
    // installed cache and the read restarts when it was evicted.
    for (let attempt = 0; attempt < 3; attempt++) {
      const cached = this.activeWorkflowRunIdsByWorkspace.get(workspaceId);
      if (cached != null) {
        const bootstrap = this.activeWorkflowRunIdBootstrapsByWorkspace.get(workspaceId);
        if (bootstrap != null) {
          await bootstrap;
        }
        if (this.activeWorkflowRunIdsByWorkspace.get(workspaceId) !== cached) {
          continue;
        }
        return cached;
      }

      // Install the shared Set before awaiting disk so parallel workflow status events
      // mutate the same cache instead of racing to replace each other after bootstrap.
      const activeRunIds = new Set<string>();
      this.activeWorkflowRunIdsByWorkspace.set(workspaceId, activeRunIds);
      const bootstrap = this.populateActiveWorkflowRunIds(workspaceId, activeRunIds);
      this.activeWorkflowRunIdBootstrapsByWorkspace.set(workspaceId, bootstrap);
      try {
        await bootstrap;
      } finally {
        if (this.activeWorkflowRunIdBootstrapsByWorkspace.get(workspaceId) === bootstrap) {
          this.activeWorkflowRunIdBootstrapsByWorkspace.delete(workspaceId);
        }
      }
      if (this.activeWorkflowRunIdsByWorkspace.get(workspaceId) !== activeRunIds) {
        continue;
      }
      return activeRunIds;
    }
    // Eviction churn exhausted the retries (pathological): probe disk once
    // more DETACHED so the caller still gets current durable state without
    // installing a cache that may itself be mid-eviction.
    return this.populateActiveWorkflowRunIds(workspaceId, new Set<string>());
  }

  private async updateActiveWorkflowRunCount(event: {
    workspaceId: string;
    runId: string;
    status: WorkflowRunStatus;
  }): Promise<number> {
    // Bounded retry (same reason as resolveActiveWorkflowRunIds): an
    // eviction can land in the microtask gap after the cache read resolves,
    // so the mutation below would hit a detached incarnation — and must not
    // mark the seen set for an id whose caches were just evicted, or the
    // idle revived workspace emits fabricated zero-count entries forever.
    let detachedSize = 0;
    for (let attempt = 0; attempt < 3; attempt++) {
      const activeRunIds = await this.getActiveWorkflowRunIds(event.workspaceId);
      if (isActiveWorkflowRunStatus(event.status)) {
        activeRunIds.add(event.runId);
      } else {
        activeRunIds.delete(event.runId);
      }
      detachedSize = activeRunIds.size;
      if (this.activeWorkflowRunIdsByWorkspace.get(event.workspaceId) !== activeRunIds) {
        continue;
      }
      if (isActiveWorkflowRunStatus(event.status)) {
        this.workflowRunSeenWorkspaces.add(event.workspaceId);
      }
      return activeRunIds.size;
    }
    // Eviction churn exhausted the retries (pathological): report the last
    // detached mutation's size without seen-marking, mirroring the detached
    // disk-probe fallback in resolveActiveWorkflowRunIds.
    return detachedSize;
  }

  private mergeCachedActiveWorkflowRuns(
    workspaceId: string,
    snapshot: WorkspaceActivitySnapshot | null
  ): WorkspaceActivitySnapshot | null {
    const activeRunIds = this.activeWorkflowRunIdsByWorkspace.get(workspaceId);
    if (activeRunIds == null) {
      return snapshot;
    }
    if (snapshot == null && activeRunIds.size === 0) {
      return null;
    }
    return mergeActiveWorkflowRuns(snapshot, activeRunIds);
  }

  private getActiveBashMonitorCount(workspaceId: string): number {
    // Tests may construct WorkspaceService with a partial BackgroundProcessManager stub
    // (same reason the constructor guards the event subscriptions).
    if (typeof this.backgroundProcessManager.getActiveMonitorCount !== "function") {
      return 0;
    }
    return this.backgroundProcessManager.getActiveMonitorCount(workspaceId);
  }

  private readonly lastGoodPendingWakesByWorkspace = new Map<
    string,
    {
      snapshot: BashMonitorWakeReconcilerSnapshot;
      registryRows: readonly BashMonitorRegistryRecord[];
    }
  >();

  // One retry timer per workspace after a failed pending-wake read. The fallback above
  // makes listBackgroundProcesses RESOLVE, so the subscription's failure-retry path never
  // sees the error — and with no live process there may be no later change event either.
  // Re-emitting a change re-drives a read; if that read fails again its own catch
  // reschedules, giving the same bounded once-per-delay retry loop as the subscription,
  // and the chain stops as soon as a read succeeds or no subscriber re-reads.
  private readonly pendingWakeReadRetryTimers = new Map<string, NodeJS.Timeout>();

  private schedulePendingWakeReadRetry(workspaceId: string): void {
    if (this.pendingWakeReadRetryTimers.has(workspaceId)) return;
    const timer = setTimeout(() => {
      this.pendingWakeReadRetryTimers.delete(workspaceId);
      this.notifyBashMonitorWakeStateChanged(workspaceId);
    }, 1_000);
    // Never hold process shutdown open for a UI refresh nudge.
    timer.unref();
    this.pendingWakeReadRetryTimers.set(workspaceId, timer);
  }

  private notifyBashMonitorWakeStateChanged(workspaceId: string): void {
    // Tests may construct WorkspaceService with a partial BackgroundProcessManager stub
    // (same reason the constructor guards the event subscriptions).
    if (typeof this.backgroundProcessManager.notifyMonitorWakeStateChanged !== "function") {
      return;
    }
    this.backgroundProcessManager.notifyMonitorWakeStateChanged(workspaceId);
  }

  private mergeCurrentActiveBashMonitorCount(
    workspaceId: string,
    snapshot: WorkspaceActivitySnapshot | null
  ): WorkspaceActivitySnapshot | null {
    const count = this.getActiveBashMonitorCount(workspaceId);
    if (snapshot == null && count === 0) {
      return snapshot;
    }
    return mergeActiveCount(snapshot, "activeBashMonitorCount", count);
  }

  private async mergeCurrentActiveWorkflowRuns(
    workspaceId: string,
    snapshot: WorkspaceActivitySnapshot
  ): Promise<WorkspaceActivitySnapshot> {
    return mergeActiveWorkflowRuns(snapshot, await this.getActiveWorkflowRunIds(workspaceId));
  }

  public async emitWorkflowRunActivity(event: {
    workspaceId: string;
    runId: string;
    status: WorkflowRunStatus;
  }): Promise<void> {
    assert(event.workspaceId.length > 0, "emitWorkflowRunActivity requires workspaceId");
    assert(event.runId.length > 0, "emitWorkflowRunActivity requires runId");
    await this.updateActiveWorkflowRunCount(event);
    let snapshot: WorkspaceActivitySnapshot | null;
    try {
      snapshot = await this.extensionMetadata.getSnapshot(event.workspaceId, {
        throwOnError: true,
      });
    } catch (error) {
      // Emitting a suspect (partial-main) snapshot after a failed sidecar
      // reconcile would clear goal/status in the renderer with no repair
      // event. Retention is recoverable: the run count is already cached,
      // so the next emit or list read delivers it.
      log.debug("Skipping workflow-run activity emit after failed snapshot read", {
        workspaceId: event.workspaceId,
        error,
      });
      return;
    }
    this.emitWorkspaceActivity(event.workspaceId, snapshot);
  }

  /**
   * Public so AgentStatusService can broadcast a snapshot it produced after
   * a direct setX call. (Most callers use emitWorkspaceActivityUpdate, which
   * couples persist + emit but swallows persist errors.)
   */
  public emitWorkspaceActivity(
    workspaceId: string,
    snapshot: WorkspaceActivitySnapshot | null
  ): void {
    const activity = this.mergeCurrentActiveBashMonitorCount(
      workspaceId,
      this.mergeCachedActiveWorkflowRuns(
        workspaceId,
        this.overlayPendingGoal(workspaceId, snapshot)
      )
    );
    // A late in-flight producer (e.g. a stream-abort stop-status handler mid
    // todo read) can complete after removal deleted this workspace's
    // metadata entry. Its disk write is already blocked by the write
    // tombstone; suppress the broadcast too, or the renderer re-inserts the
    // removed id into its activity map after having processed the
    // metadata-removal event. Null (clearing) emissions stay allowed — the
    // check runs on the MERGED payload (not the raw snapshot) because the
    // workflow/bash-monitor cache overlays above can turn a null snapshot
    // into a non-null activity from still-populated caches, which would
    // re-insert the deleted id just the same.
    if (activity !== null && this.extensionMetadata.isWorkspaceDeleted(workspaceId)) {
      return;
    }
    this.emit("activity", { workspaceId, activity });
  }

  /**
   * Overlay the optimistic mid-stream goal onto an activity snapshot.
   *
   * A goal set while the agent is streaming is held as optimistic state in the
   * goal service until stream-end persistence; goal.json keeps the pre-stream
   * goal. Activity snapshots built from persisted metadata (status_set,
   * todo_write, recency, streaming) therefore still carry the pre-stream goal,
   * and emitting them as-is makes the Goal tab flicker back to the stale goal
   * mid-stream until the next goal read re-emits the optimistic one. Overlaying
   * the pending snapshot here keeps the displayed goal stable across those
   * emits. Authoritative goal emits authored by the goal service are left
   * untouched: transient goal pushes already carry the optimistic goal
   * (`transientGoalOnly`), and abort reverts / durable persistence clear the
   * pending snapshot before emitting, so they win naturally.
   */
  private overlayPendingGoal(
    workspaceId: string,
    snapshot: WorkspaceActivitySnapshot | null
  ): WorkspaceActivitySnapshot | null {
    if (!snapshot || snapshot.transientGoalOnly === true) {
      return snapshot;
    }
    const pending = this.workspaceGoalService?.getPendingGoalSnapshot(workspaceId);
    if (!pending) {
      return snapshot;
    }
    return { ...snapshot, goal: pending };
  }

  private async emitWorkspaceActivityUpdate(
    workspaceId: string,
    description: string,
    update: () => Promise<WorkspaceActivitySnapshot>
  ): Promise<void> {
    try {
      this.emitWorkspaceActivity(
        workspaceId,
        await this.mergeCurrentActiveWorkflowRuns(workspaceId, await update())
      );
    } catch (error) {
      log.error(`Failed to ${description}`, { workspaceId, error });
    }
  }

  private async updateRecencyTimestamp(workspaceId: string, timestamp?: number): Promise<void> {
    await this.emitWorkspaceActivityUpdate(workspaceId, "update workspace recency", () =>
      this.extensionMetadata.updateRecency(workspaceId, timestamp ?? Date.now())
    );
  }

  public async updateAgentStatus(
    workspaceId: string,
    agentStatus: WorkspaceAgentStatus | null
  ): Promise<void> {
    await this.emitWorkspaceActivityUpdate(workspaceId, "update workspace agent status", () =>
      this.extensionMetadata.setAgentStatus(workspaceId, agentStatus)
    );
  }

  private async updateTodoStatusFromStorage(workspaceId: string): Promise<void> {
    const previousUpdate = this.todoStatusUpdateQueue.get(workspaceId) ?? Promise.resolve();
    const nextUpdate = previousUpdate
      .catch(() => undefined)
      .then(async () => {
        const sessionDir = path.join(this.config.sessionsDir, workspaceId);
        const todos = await readTodosForSessionDir(sessionDir);
        const todoStatus = deriveTodoStatus(todos) ?? null;

        await this.emitWorkspaceActivityUpdate(workspaceId, "update workspace todo status", () =>
          this.extensionMetadata.setTodoStatus(workspaceId, todoStatus, todos.length > 0)
        );
      });

    this.todoStatusUpdateQueue.set(workspaceId, nextUpdate);
    try {
      await nextUpdate;
    } finally {
      if (this.todoStatusUpdateQueue.get(workspaceId) === nextUpdate) {
        this.todoStatusUpdateQueue.delete(workspaceId);
      }
    }
  }

  private async updateStreamingStatus(
    workspaceId: string,
    streaming: boolean,
    update: ExtensionMetadataStreamingUpdate = {}
  ): Promise<void> {
    const streamGeneration = update.generation ?? this.streamingGenerations.get(workspaceId) ?? 0;
    try {
      let { hasTodos, todoStatus } = update;
      if (!streaming && (hasTodos === undefined || todoStatus === undefined)) {
        // Stop snapshots need an authoritative todo summary even for background workspaces,
        // and centralizing the read here preserves the fire-and-forget abort/error handlers.
        const sessionDir = path.join(this.config.sessionsDir, workspaceId);
        const todos = await readTodosForSessionDir(sessionDir);
        hasTodos ??= todos.length > 0;
        // When there are no todos to derive from, leave `todoStatus` undefined
        // so setStreaming doesn't touch the slot. AgentStatusService writes
        // its AI-generated summary into the same `todoStatus` field — passing
        // `null` here would clobber a freshly generated summary every time a
        // free-form (no-todo) turn ends. Explicit clears still happen via
        // setTodoStatus(null) when the agent calls `todo_write([])`.
        todoStatus ??= deriveTodoStatus(todos);
      }
      if (
        !streaming &&
        update.generation !== undefined &&
        update.generation !== (this.streamingGenerations.get(workspaceId) ?? 0)
      ) {
        // A newer stream has started since this stop was initiated, so dropping the stale
        // streaming=false write preserves the active stream's metadata snapshot.
        return;
      }

      const snapshot = await this.extensionMetadata.setStreaming(workspaceId, streaming, {
        ...update,
        ...(todoStatus !== undefined ? { todoStatus } : {}),
        ...(hasTodos !== undefined ? { hasTodos } : {}),
      });
      // Compaction tagging is stop-snapshot only. Never tag streaming=true updates,
      // otherwise fast follow-up turns can inherit stale compaction metadata before cleanup runs.
      const shouldTagCompaction =
        !streaming && this.compactionStreamGenerations.get(workspaceId) === streamGeneration;
      const shouldTagIdleCompaction = !streaming && this.idleCompactingWorkspaces.has(workspaceId);
      this.emitWorkspaceActivity(
        workspaceId,
        await this.mergeCurrentActiveWorkflowRuns(workspaceId, {
          ...snapshot,
          ...(shouldTagCompaction ? { isCompaction: true } : {}),
          ...(shouldTagIdleCompaction ? { isIdleCompaction: true } : {}),
        })
      );
    } catch (error) {
      log.error("Failed to update workspace streaming status", { workspaceId, error });
    } finally {
      // Compaction markers are turn-scoped. Always clear matching streaming=false
      // transitions, even when metadata writes fail, so stale state cannot leak into
      // future user streams. Match by generation so an old stop cannot clear a newer
      // compaction that started while the stop snapshot was doing async work.
      if (!streaming) {
        if (this.compactionStreamGenerations.get(workspaceId) === streamGeneration) {
          this.compactionStreamGenerations.delete(workspaceId);
        }
        this.idleCompactingWorkspaces.delete(workspaceId);
      }
    }
  }

  /**
   * Snapshot the current streaming generation and fire a streaming=false metadata update.
   * Accepts an optional pre-captured generation for callers that need to snapshot before
   * async work (e.g., handleStreamCompletion captures before updateRecencyTimestamp so a
   * concurrent stream-start won't cause the stop to silently overwrite the newer stream).
   */
  private stopStreamingStatus(workspaceId: string, capturedGeneration?: number): Promise<void> {
    const generation = capturedGeneration ?? this.streamingGenerations.get(workspaceId) ?? 0;
    return this.updateStreamingStatus(workspaceId, false, { generation });
  }

  private async handleStreamCompletion(workspaceId: string): Promise<void> {
    const generation = this.streamingGenerations.get(workspaceId) ?? 0;
    const isIdleCompaction = this.idleCompactingWorkspaces.has(workspaceId);

    // Note: idle-compaction success/failure is reported from onIdleCompactionOutcome
    // (after the summary is actually persisted), not here — a clean provider stream-end
    // does not guarantee the post-stream history compaction succeeded.

    // Idle compaction is maintenance work, so preserve the pre-existing recency.
    // That keeps the workspace from jumping to the top of the sidebar and also
    // prevents the background activity path from treating compaction as a fresh response.

    if (!isIdleCompaction) {
      // Always use Date.now() for stream-completion recency.
      // extractTimestamp() returns the message-creation timestamp from stream
      // metadata, which is effectively the same as the sendMessage recency and
      // can lose the race against the frontend's lastRead (set via Date.now()
      // after the IPC round-trip). Using a fresh timestamp here ensures the
      // completion recency is strictly after any earlier lastRead write.
      await this.updateRecencyTimestamp(workspaceId, Date.now());
    }

    await this.stopStreamingStatus(workspaceId, generation);
    // Goal mutations are drained by AgentSession after stream accounting. Doing
    // it here races with per-session stream-end listeners because EventEmitter
    // does not await async handlers.
  }

  private createInitLogger(workspaceId: string) {
    const hasInitState = () => this.initStateManager.getInitState(workspaceId) !== undefined;

    return {
      logStep: (message: string) => {
        if (!hasInitState()) {
          return;
        }
        this.initStateManager.appendOutput(workspaceId, message, false, true);
      },
      logProgress: (label: string, percent: number) =>
        this.initStateManager.reportProgress(workspaceId, label, percent),
      logStdout: (line: string) => {
        if (!hasInitState()) {
          return;
        }
        this.initStateManager.appendOutput(workspaceId, line, false);
      },
      logStderr: (line: string) => {
        if (!hasInitState()) {
          return;
        }
        this.initStateManager.appendOutput(workspaceId, line, true);
      },
      logComplete: (exitCode: number) => {
        this.initAbortControllers.delete(workspaceId);

        // WorkspaceService.remove() clears in-memory init state early so waiters/tools can bail out.
        // If init completes after deletion, avoid noisy logs (endInit() would report missing state).
        if (!hasInitState()) {
          return;
        }

        void this.initStateManager.endInit(workspaceId, exitCode);
      },
      enterHookPhase: () => {
        if (!hasInitState()) {
          return;
        }
        this.initStateManager.enterHookPhase(workspaceId);
      },
    };
  }

  private schedulePostCompactionMetadataRefresh(workspaceId: string): void {
    assert(typeof workspaceId === "string", "workspaceId must be a string");
    const trimmed = workspaceId.trim();
    assert(trimmed.length > 0, "workspaceId must not be empty");

    const existing = this.postCompactionRefreshTimers.get(trimmed);
    if (existing) {
      clearTimeout(existing);
    }

    const timer = setTimeout(() => {
      this.postCompactionRefreshTimers.delete(trimmed);
      void this.emitPostCompactionMetadata(trimmed);
    }, POST_COMPACTION_METADATA_REFRESH_DEBOUNCE_MS);

    this.postCompactionRefreshTimers.set(trimmed, timer);
  }

  private async emitPostCompactionMetadata(workspaceId: string): Promise<void> {
    try {
      const session = this.sessions.get(workspaceId);
      if (!session) {
        return;
      }

      const metadata = await this.getInfo(workspaceId);
      if (!metadata) {
        return;
      }

      const postCompaction = await this.getPostCompactionState(workspaceId);
      const enrichedMetadata = { ...metadata, postCompaction };
      session.emitMetadata(enrichedMetadata);
    } catch (error) {
      // Workspace runtime unavailable (e.g., SSH unreachable) - skip emitting post-compaction state.
      log.debug("Failed to emit post-compaction metadata", { workspaceId, error });
    }
  }

  // Clear persisted sidebar status only after the user turn is accepted and emitted.
  // sendMessage can fail before acceptance (for example invalid_model_string), so
  // clearing inside sendMessage would drop status for turns that never entered history.
  private shouldClearAgentStatusFromChatMessage(message: WorkspaceChatMessage): boolean {
    return (
      message.type === "message" && message.role === "user" && message.metadata?.synthetic !== true
    );
  }

  async getRestartSafeBashMonitors(
    processes: readonly BackgroundProcess[]
  ): Promise<Map<string, string>> {
    const monitors = processes.flatMap((process) =>
      process.status === "running" &&
      !process.isForeground &&
      process.monitor &&
      !process.monitor.stopped
        ? [process.monitor.armMetadata]
        : []
    );
    // Only durable registrations can produce a monitor-lost wake after an update restart.
    // Read without draining pending writes: a failed or stalled arm write must still block.
    try {
      const result = await raceWithAbortAndTimeout(
        Promise.all(
          [...new Set(monitors.map((monitor) => monitor.workspaceId))].map((workspaceId) =>
            this.bashMonitorRegistryStore.listAll(workspaceId)
          )
        ),
        { timeoutMs: SERVER_UPDATE_MONITOR_VERIFY_TIMEOUT_MS }
      );
      if (result.kind === "ok") {
        const records = new Map(result.value.flat().map((record) => [record.processId, record]));
        return new Map(
          monitors
            .filter((monitor) => {
              const record = records.get(monitor.processId);
              return (
                record?.ownerWorkspaceId === monitor.workspaceId &&
                record.createdAt === monitor.createdAt &&
                !record.terminal &&
                !record.lost
              );
            })
            .map((monitor) => [monitor.processId, monitor.createdAt])
        );
      }
    } catch (error) {
      log.warn("Failed to verify restart-safe bash monitors", { error });
    }
    return new Map();
  }

  collectRestartBlockers(): RestartBlocker[] {
    const sessions = new Map([...this.sessions, ...this.transientStartupRecoverySessions]);
    const pendingTurns = new Set(this.preflightSendCounts.keys());
    let queuedMessages = 0;
    let autoRetries = 0;
    for (const [workspaceId, session] of sessions) {
      if (session.hasActiveOrPendingTurnWork()) pendingTurns.add(workspaceId);
      if (session.hasQueuedMessages()) queuedMessages++;
      if (session.hasPendingAutoRetry()) autoRetries++;
    }
    const blockers: RestartBlocker[] = [
      { kind: "pending-turns", count: pendingTurns.size },
      {
        kind: "workspace-inits",
        // Controllers exist from the start of provisioning; settlements from init start onward.
        count: new Set([...this.initAbortControllers.keys(), ...this.initSettlementPromises.keys()])
          .size,
      },
      {
        kind: "workspace-lifecycle",
        count: new Set([
          ...this.renamingWorkspaces,
          ...this.removingWorkspaces,
          ...this.archivingWorkspaces,
          ...this.contextMutationWorkspaces,
          ...this.preflightForkCounts.keys(),
          ...this.preflightStagingCounts.keys(),
        ]).size,
      },
      { kind: "queued-messages", count: queuedMessages },
      { kind: "auto-retries", count: autoRetries },
      {
        kind: "background-processes",
        count: Array.from(this.preflightExecCounts.values()).reduce((sum, count) => sum + count, 0),
      },
    ];
    return blockers.filter((blocker) => blocker.count > 0);
  }

  /**
   * Shutdown: stop startup chat recovery before the services it dispatches through go away.
   * Transient recovery sessions are disposed outright. Sessions that outlived that sweep (promoted
   * because recovery left a retry pending, or client-created ones housekeeping scheduled recovery
   * on) may own a live stream whose partial the next startup needs, so they only stop dispatching.
   */
  beginShutdown(): void {
    if (this.shuttingDown) return;
    this.shuttingDown = true;
    // Capture before disposal can remove transient instances from either registry.
    for (const session of [
      ...this.sessions.values(),
      ...this.transientStartupRecoverySessions.values(),
    ]) {
      this.shutdownSessions.add(session);
    }
    for (const [workspaceId] of this.transientStartupRecoverySessions)
      this.disposeSession(workspaceId).catch((error: unknown) =>
        log.warn("Transient session disposal failed", { workspaceId, error })
      );
    for (const session of this.sessions.values()) session.beginShutdown();
  }

  /** Transfer destructive cleanup out of a callback that still owns a session lease. */
  deferWorkspaceCleanup(run: () => Promise<void>): void {
    this.trackWorkspaceCleanup(run).catch((error: unknown) =>
      log.warn("Deferred workspace cleanup failed", { error })
    );
  }

  private trackWorkspaceCleanup(run: () => Promise<void>): Promise<void> {
    const settled = Promise.withResolvers<void>();
    this.pendingWorkspaceCleanup.add(settled.promise);
    (async () => run())()
      .catch((error: unknown) => log.warn("Workspace cleanup failed", { error }))
      .finally(() => {
        this.pendingWorkspaceCleanup.delete(settled.promise);
        settled.resolve();
      });
    return settled.promise;
  }

  /**
   * Run startup recovery without permanently caching a session for every workspace.
   * Only promote the temporary session if recovery leaves background activity alive.
   */
  private startStartupRecovery(workspaceId: string, metadata?: WorkspaceMetadata): void {
    const trimmed = workspaceId.trim();
    if (!trimmed) {
      return;
    }

    this.deferWorkspaceCleanup(async () => {
      try {
        await this.withStartupSession(trimmed, (session) => session.runStartupRecovery(metadata));
      } catch (error) {
        log.warn("Failed to run startup recovery for workspace", {
          workspaceId: trimmed,
          error: getErrorMessage(error),
        });
      }
    });
  }

  private async withStartupSession<T>(
    workspaceId: string,
    run: (session: AgentSession) => Promise<T>
  ): Promise<T> {
    workspaceId = workspaceId.trim();
    assert(workspaceId.length > 0, "workspaceId must not be empty");
    const existing =
      this.sessions.get(workspaceId) ?? this.transientStartupRecoverySessions.get(workspaceId);
    if (existing) return run(existing);
    const session = this.createSession(workspaceId);
    this.transientStartupRecoverySessions.set(workspaceId, session);
    try {
      const result = await run(session);
      if (
        this.transientStartupRecoverySessions.get(workspaceId) === session &&
        !this.shuttingDown &&
        session.shouldRetainAfterStartupRecovery()
      ) {
        this.registerSession(workspaceId, session);
      }
      return result;
    } finally {
      // Adoption transfers ownership. Otherwise detach before asynchronous cleanup so a timed-out
      // physical read cannot block startup or make a later caller adopt a closing session.
      if (this.transientStartupRecoverySessions.get(workspaceId) === session) {
        this.transientStartupRecoverySessions.delete(workspaceId);
        this.deferWorkspaceCleanup(() => session.dispose());
      }
    }
  }

  private createSession(workspaceId: string): AgentSession {
    if (this.shuttingDown) throw new Error("Server is shutting down");
    return new AgentSession({
      effectRunner: this.effectRunner,
      appFiberScope: this.appFiberScope,
      workspaceId,
      config: this.config,
      historyService: this.historyService,
      aiService: this.aiService,
      streamManager: this.streamManager,
      mcpServerManager: this.mcpServerManager,
      telemetryService: this.telemetryService,
      initStateManager: this.initStateManager,
      workspaceGoalService: this.workspaceGoalService,
      backgroundProcessManager: this.backgroundProcessManager,
      // Branch-summary side-channel spend recording (edit-resend path).
      sessionUsageService: this.sessionUsageService,
      sanitizeCliWorkspaceRegistration: (args) =>
        this.sanitizeCliRegisteredWorkspace(
          args.workspaceId,
          args.workspacePath,
          args.runtimeConfig
        ),
      onContextWindowRollover: () => this.advanceContextMutationEpoch(workspaceId),
      onCompactionComplete: (metadata) => {
        this.schedulePostCompactionMetadataRefresh(workspaceId);
        // Compaction marks a long session with accumulated learnings: harvest
        // the compacted epoch first, then let Dream sweep/merge the candidates.
        this.memoryConsolidationService?.triggerHarvestThenSweepInBackground(metadata);
      },
      onIdleCompactionOutcome: (success) => {
        // Reports the *persisted* idle-compaction outcome (success only after the summary
        // is written; failure on post-stream persistence errors). Reporting on actual
        // persistence — not the provider stream-end — keeps the idle loop's failure streak
        // accurate. A persistence failure is not a model error, so modelNotFound is false.
        this.reportIdleCompactionOutcome(
          workspaceId,
          success ? { success: true } : { success: false, modelNotFound: false }
        );
      },
      onPostCompactionStateChange: () => {
        this.schedulePostCompactionMetadataRefresh(workspaceId);
      },
      // Codex P1 (PRRT_kwDOPxxmWM6cRJD-): expose service-level send
      // preflights (manual sends counted but not yet queued or busy) to the
      // session's follow-up idle probes so redispatched synthetic turns yield
      // to them. Codex P1 (PRRT_kwDOPxxmWM6cRi_J): reads the session-invisible
      // counter, not preflightSendCounts — the originating send's reservation
      // is released at its queue/session handoff so a follow-up dispatched
      // from within that turn does not veto itself.
      hasExternalSendPreflight: () => this.hasSessionInvisiblePreflight(workspaceId),
    });
  }

  private attachSessionSubscriptions(workspaceId: string, session: AgentSession): void {
    const chatUnsubscribe = session.onChatEvent((event) => {
      this.emit("chat", { workspaceId: event.workspaceId, message: event.message });
      if (this.shouldClearAgentStatusFromChatMessage(event.message)) {
        void this.updateAgentStatus(event.workspaceId, null);
      }
    });

    const metadataUnsubscribe = session.onMetadataEvent((event) => {
      this.emit("metadata", {
        workspaceId: event.workspaceId,
        metadata: event.metadata!,
      });
    });

    this.sessionSubscriptions.set(workspaceId, {
      chat: chatUnsubscribe,
      metadata: metadataUnsubscribe,
    });
  }

  public getOrCreateSession(workspaceId: string): AgentSession {
    assert(typeof workspaceId === "string", "workspaceId must be a string");
    const trimmed = workspaceId.trim();
    assert(trimmed.length > 0, "workspaceId must not be empty");

    const existing = this.sessions.get(trimmed);
    if (existing) return existing;
    const session =
      this.transientStartupRecoverySessions.get(trimmed) ?? this.createSession(trimmed);
    this.registerSession(trimmed, session);
    return session;
  }

  async waitForWorkspaceIdle(
    workspaceId: string,
    options?: { signal?: AbortSignal; manualFollowUp?: boolean }
  ): Promise<void> {
    assert(typeof workspaceId === "string", "waitForWorkspaceIdle requires a workspaceId string");
    const trimmed = workspaceId.trim();
    assert(trimmed.length > 0, "waitForWorkspaceIdle requires a non-empty workspaceId");

    let releaseManualFollowUp: (() => void) | undefined;
    try {
      for (;;) {
        if (options?.signal?.aborted === true) {
          throw new Error(WORKSPACE_IDLE_WAIT_CANCELED_MESSAGE);
        }

        const session =
          this.sessions.get(trimmed) ?? this.transientStartupRecoverySessions.get(trimmed);
        if (session?.closingSignal.aborted) throw new Error(WORKSPACE_IDLE_WAIT_CANCELED_MESSAGE);
        if (session?.isBusy() !== true) {
          return;
        }

        if (options?.manualFollowUp === true && releaseManualFollowUp == null) {
          releaseManualFollowUp = session.registerExternalManualFollowUp(options.signal);
        }
        await waitForAgentSessionIdle(session, options?.signal);
      }
    } finally {
      releaseManualFollowUp?.();
    }
  }

  /**
   * Register an externally-created AgentSession so that WorkspaceService
   * operations (sendMessage, resumeStream, remove, etc.) reuse it instead of
   * creating a duplicate. Used by `mux run` CLI to keep a single session
   * instance for the parent workspace.
   */
  public registerSession(workspaceId: string, session: AgentSession): void {
    workspaceId = workspaceId.trim();
    assert(workspaceId.length > 0, "workspaceId must not be empty");
    assert(!this.sessions.has(workspaceId), `session already registered for ${workspaceId}`);
    if (this.transientStartupRecoverySessions.get(workspaceId) === session) {
      this.transientStartupRecoverySessions.delete(workspaceId);
    }

    this.sessions.set(workspaceId, session);
    this.attachSessionSubscriptions(workspaceId, session);
  }

  public emitChatEvent(workspaceId: string, message: WorkspaceChatMessage): void {
    const trimmed = workspaceId.trim();
    assert(trimmed.length > 0, "emitChatEvent requires workspaceId");
    this.sessions.get(trimmed)?.emitChatEvent(message);
  }

  /** Queued agent peer messages behind a busy workspace; sessions are lazy, so no session ⇒ 0. */
  public countQueuedAgentPeerMessages(workspaceId: string): number {
    const trimmed = workspaceId.trim();
    assert(trimmed.length > 0, "countQueuedAgentPeerMessages requires workspaceId");
    return this.sessions.get(trimmed)?.countQueuedAgentPeerMessages() ?? 0;
  }

  public disposeSession(workspaceId: string): Promise<void> {
    const trimmed = workspaceId.trim();
    const transientSession = this.transientStartupRecoverySessions.get(trimmed);
    const session = this.sessions.get(trimmed);
    const subscriptions = this.sessionSubscriptions.get(trimmed);
    const refreshTimer = this.postCompactionRefreshTimers.get(trimmed);
    if (refreshTimer) {
      clearTimeout(refreshTimer);
      this.postCompactionRefreshTimers.delete(trimmed);
    }
    return this.trackWorkspaceCleanup(async () => {
      // Start both synchronous admission latches before the first await. Registry identity
      // remains visible through terminal delivery and prevents a late old disposer removing B.
      await Promise.all([transientSession?.dispose(), session?.dispose()]);
      if (this.transientStartupRecoverySessions.get(trimmed) === transientSession) {
        this.transientStartupRecoverySessions.delete(trimmed);
      }
      subscriptions?.chat();
      subscriptions?.metadata();
      if (this.sessionSubscriptions.get(trimmed) === subscriptions)
        this.sessionSubscriptions.delete(trimmed);
      if (this.sessions.get(trimmed) === session) this.sessions.delete(trimmed);
    });
  }

  private async getPersistedPostCompactionDiffPaths(workspaceId: string): Promise<string[] | null> {
    const postCompactionPath = path.join(
      this.config.sessionsDir,
      workspaceId,
      "post-compaction.json"
    );

    try {
      const raw = await fsPromises.readFile(postCompactionPath, "utf-8");
      const parsed: unknown = JSON.parse(raw);
      const diffsRaw = (parsed as { diffs?: unknown }).diffs;
      if (!Array.isArray(diffsRaw)) {
        return null;
      }

      const result: string[] = [];
      for (const diff of diffsRaw) {
        if (!diff || typeof diff !== "object") continue;
        const p = (diff as { path?: unknown }).path;
        if (typeof p !== "string") continue;
        const trimmed = p.trim();
        if (trimmed.length === 0) continue;
        result.push(trimmed);
      }

      return result;
    } catch {
      return null;
    }
  }

  /**
   * Get post-compaction context state for a workspace.
   * Returns info about what will be injected after compaction.
   * Prefers cached paths from pending compaction, falls back to history extraction.
   */
  public async getPostCompactionState(workspaceId: string): Promise<{
    planPath: string | null;
    trackedFilePaths: string[];
    excludedItems: string[];
  }> {
    // Get workspace metadata to create runtime for plan file check
    const metadata = await this.getInfo(workspaceId);
    if (!metadata) {
      // Can't get metadata, return empty state
      const exclusions = await this.getPostCompactionExclusions(workspaceId);
      return { planPath: null, trackedFilePaths: [], excludedItems: exclusions.excludedItems };
    }

    const runtime = createRuntimeForWorkspace(metadata);
    const xumHome = runtime.getXumHome();
    const planPath = getPlanFilePath(metadata.name, metadata.projectName, xumHome);
    // For local/SSH: expand tilde for comparison with message history paths
    // For Docker: paths are already absolute (/var/mux/...), no expansion needed
    const expandedPlanPath = xumHome.startsWith("~") ? expandTilde(planPath) : planPath;
    // Legacy plan path (stored by workspace ID) for filtering — same runtime home
    const legacyPlanPath = getLegacyPlanFilePath(workspaceId, xumHome);
    const expandedLegacyPlanPath = expandTilde(legacyPlanPath);

    // Check both new and legacy plan paths, prefer new path
    const newPlanExists = await fileExists(runtime, planPath);
    const legacyPlanExists = !newPlanExists && (await fileExists(runtime, legacyPlanPath));
    // Resolve plan path via runtime to get correct absolute path for deep links.
    // Local: expands ~ to local home. SSH: expands ~ on remote host.
    const activePlanPath = newPlanExists
      ? await runtime.resolvePath(planPath)
      : legacyPlanExists
        ? await runtime.resolvePath(legacyPlanPath)
        : null;

    // Load exclusions
    const exclusions = await this.getPostCompactionExclusions(workspaceId);

    // Helper to check if a path is a plan file (new or legacy format)
    const isPlanPath = (p: string) =>
      p === planPath ||
      p === expandedPlanPath ||
      p === legacyPlanPath ||
      p === expandedLegacyPlanPath;

    // If session has pending compaction attachments, use cached paths
    // (history is cleared after compaction, but cache survives)
    const session = this.sessions.get(workspaceId);
    const pendingPaths = session?.getPendingTrackedFilePaths();
    if (pendingPaths) {
      // Filter out both new and legacy plan file paths
      const trackedFilePaths = pendingPaths.filter((p) => !isPlanPath(p));
      return {
        planPath: activePlanPath,
        trackedFilePaths,
        excludedItems: exclusions.excludedItems,
      };
    }

    // Fallback (crash-safe): if a post-compaction snapshot exists on disk, use it.
    const persistedPaths = await this.getPersistedPostCompactionDiffPaths(workspaceId);
    if (persistedPaths !== null) {
      const trackedFilePaths = persistedPaths.filter((p) => !isPlanPath(p));
      return {
        planPath: activePlanPath,
        trackedFilePaths,
        excludedItems: exclusions.excludedItems,
      };
    }

    // Fallback: compute tracked files from message history (survives reloads).
    // Only the current compaction epoch matters — post-compaction files are from
    // the active epoch only.
    const historyResult = await this.historyService.getHistoryFromLatestBoundary(workspaceId);
    const messages = historyResult.success ? historyResult.data : [];
    const allPaths = extractEditedFilePaths(messages);

    // Exclude plan file from tracked files since it has its own section
    // Filter out both new and legacy plan file paths
    const trackedFilePaths = allPaths.filter((p) => !isPlanPath(p));
    return {
      planPath: activePlanPath,
      trackedFilePaths,
      excludedItems: exclusions.excludedItems,
    };
  }

  /**
   * Get post-compaction exclusions for a workspace.
   * Returns empty exclusions if file doesn't exist.
   */
  public async getPostCompactionExclusions(workspaceId: string): Promise<PostCompactionExclusions> {
    const exclusionsPath = path.join(this.config.sessionsDir, workspaceId, "exclusions.json");
    try {
      const data = await fsPromises.readFile(exclusionsPath, "utf-8");
      return JSON.parse(data) as PostCompactionExclusions;
    } catch {
      return { excludedItems: [] };
    }
  }

  /**
   * Set whether an item is excluded from post-compaction context.
   * Item IDs: "plan" for plan file, "skills" for loaded skill snapshots, "file:<path>" for tracked files.
   */
  public async setPostCompactionExclusion(
    workspaceId: string,
    itemId: string,
    excluded: boolean
  ): Promise<Result<void>> {
    try {
      const exclusions = await this.getPostCompactionExclusions(workspaceId);
      const set = new Set(exclusions.excludedItems);

      if (excluded) {
        set.add(itemId);
      } else {
        set.delete(itemId);
      }

      const sessionDir = path.join(this.config.sessionsDir, workspaceId);
      await ensurePrivateDir(sessionDir);
      const exclusionsPath = path.join(sessionDir, "exclusions.json");
      await fsPromises.writeFile(
        exclusionsPath,
        JSON.stringify({ excludedItems: [...set] }, null, 2)
      );
      return Ok(undefined);
    } catch (error) {
      const message = getErrorMessage(error);
      return Err(`Failed to set exclusion: ${message}`);
    }
  }

  private getScratchRoot(): string {
    return path.join(this.config.rootDir, "scratch");
  }

  private getScratchWorkdir(workspaceId: string): string {
    return path.join(this.getScratchRoot(), workspaceId);
  }

  private isManagedScratchWorkdir(workspacePath: string): boolean {
    const scratchRoot = path.resolve(this.getScratchRoot());
    const resolvedPath = path.resolve(workspacePath);
    return path.dirname(resolvedPath) === scratchRoot && isPathInsideDir(scratchRoot, resolvedPath);
  }

  /**
   * Scratch workdirs are named after the workspace that created them, and
   * isolation "none" task children share an ancestor's workdir. Deletion is
   * only safe when the dir basename matches the removed workspace or one of
   * its task ancestors; a stale or hand-edited config entry pointing at some
   * other chat's directory must never recursively delete it.
   */
  private scratchWorkdirOwnedByWorkspace(
    configSnapshot: ProjectsConfig,
    metadata: WorkspaceMetadata,
    workdirBasename: string
  ): boolean {
    if (workdirBasename === metadata.id) {
      return true;
    }

    const parentIdsByWorkspaceId = new Map<string, string | undefined>();
    for (const project of configSnapshot.projects.values()) {
      for (const workspace of project.workspaces) {
        if (workspace.id) {
          parentIdsByWorkspaceId.set(workspace.id, workspace.parentWorkspaceId);
        }
      }
    }
    let ancestorId = metadata.parentWorkspaceId;
    for (let depth = 0; ancestorId != null && depth < 32; depth++) {
      if (ancestorId === workdirBasename) {
        return true;
      }
      ancestorId = parentIdsByWorkspaceId.get(ancestorId);
    }
    return false;
  }

  /**
   * Scratch workdirs referenced by config. Throws on unreadable config: never interpret a
   * config read failure as an empty reference set, because that would turn best-effort
   * orphan cleanup into deletion of valid scratch chats.
   */
  private listReferencedScratchPaths(): Set<string> {
    const config = this.config.loadConfigOrDefault({ throwOnError: true });
    return new Set(
      (config.projects.get(SCRATCH_PROJECT_CONFIG_KEY)?.workspaces ?? [])
        .filter((workspace) => workspace.kind === "scratch")
        .map((workspace) => path.resolve(workspace.path))
    );
  }

  private async cleanupOrphanScratchWorkdirs(): Promise<void> {
    const scratchRoot = this.getScratchRoot();
    await ensurePrivateDir(scratchRoot);

    const referencedScratchPaths = this.listReferencedScratchPaths();

    const nowMs = Date.now();
    for (const entry of await fsPromises.readdir(scratchRoot, { withFileTypes: true })) {
      if (!entry.isDirectory()) continue;

      const candidatePath = path.resolve(scratchRoot, entry.name);
      if (referencedScratchPaths.has(candidatePath)) continue;

      try {
        // This sweep can run while the server is already accepting requests, and createScratch
        // creates the workdir before persisting its config entry. Same guards as the session
        // sweep: skip recently touched directories, then re-check fresh config right before
        // deleting so a scratch chat created after the snapshot above is never reaped.
        const stat = await fsPromises.stat(candidatePath);
        if (nowMs - stat.mtimeMs < ORPHAN_SESSION_DIR_GRACE_MS) continue;
        if (this.listReferencedScratchPaths().has(candidatePath)) continue;

        await fsPromises.rm(candidatePath, { recursive: true, force: true });
      } catch (error: unknown) {
        log.debug("Failed to clean orphaned scratch workdir", { candidatePath, error });
      }
    }
  }

  /**
   * Startup sweep over the sessions directory: delete session directories whose
   * workspace no longer exists in config at all (orphans left behind by crashed
   * or partially-failed removals), so they stop hogging disk forever.
   */
  private async cleanupOrphanSessionDirs(allMetadata: FrontendWorkspaceMetadata[]): Promise<void> {
    // Never interpret a config read failure as an empty reference set, because that
    // would turn best-effort orphan cleanup into deletion of every workspace's session data.
    const config = this.config.loadConfigOrDefault({ throwOnError: true });

    const knownIds = new Set<string>(allMetadata.map((metadata) => metadata.id));
    // Same rationale as the extension-metadata prune: normalization is lossy,
    // and a live workspace whose config entry gets filtered (e.g. invalid
    // project path) must not have its session data reaped as an orphan.
    // Throws on unreadable/unparseable config, aborting this cleanup.
    for (const persistedId of this.config.readPersistedWorkspaceIdSuperset()) {
      knownIds.add(persistedId);
    }
    // The config load-time migration (removeLegacyXumChatEntries) drops the
    // removed Chat with Xum workspace from config, which would make its
    // session dir look orphaned here. Preserve the transcript: a downgraded
    // build recreates the workspace and should find its history intact.
    knownIds.add("mux-chat");
    for (const [projectPath, projectConfig] of config.projects) {
      for (const workspace of projectConfig.workspaces) {
        if (workspace.id) {
          knownIds.add(workspace.id);
        }
        // Pre-stable-ID sessions are keyed by the legacy "<project>-<workspace>" ID;
        // keep them even if the config entry has since been migrated.
        knownIds.add(this.config.generateLegacyId(projectPath, workspace.path));
      }
    }

    const entries = await fsPromises
      .readdir(this.config.sessionsDir, { withFileTypes: true })
      .catch((error: unknown) => {
        if (isErrnoWithCode(error, "ENOENT")) {
          return null;
        }
        throw error;
      });
    if (entries == null) {
      return;
    }

    const nowMs = Date.now();
    for (const entry of entries) {
      if (!entry.isDirectory()) continue;
      if (knownIds.has(entry.name)) continue;

      const candidatePath = path.join(this.config.sessionsDir, entry.name);
      try {
        // Grace window: never reap a directory with recent activity, so a workspace
        // being created concurrently with this sweep cannot lose its session data.
        const stat = await fsPromises.stat(candidatePath);
        if (nowMs - stat.mtimeMs < ORPHAN_SESSION_DIR_GRACE_MS) continue;

        // Re-check fresh config immediately before deleting (findWorkspace also
        // resolves legacy IDs), closing the race with workspaces created after
        // the snapshot above.
        if (this.config.findWorkspace(entry.name)) continue;

        await fsPromises.rm(candidatePath, { recursive: true, force: true });
        log.info("Removed orphaned session directory", { workspaceId: entry.name });
      } catch (error: unknown) {
        log.debug("Failed to clean orphaned session directory", { candidatePath, error });
      }
    }
  }

  /**
   * Startup sweep deleting devtools.jsonl for archived workspaces. Archive-time cleanup
   * handles new archives; this retroactively heals workspaces archived before that
   * cleanup existed (debug logs routinely dwarf all other session data).
   */
  private async cleanupArchivedDevToolsLogs(
    allMetadata: FrontendWorkspaceMetadata[]
  ): Promise<void> {
    if (!this.devToolsService) {
      return;
    }

    const devToolsService = this.devToolsService;
    for (const metadata of allMetadata) {
      if (!isWorkspaceArchived(metadata.archivedAt, metadata.unarchivedAt)) continue;
      try {
        // archive() already removed the log for most archived workspaces, so gate the fresh config
        // read below on there being something to delete: a per-workspace reload for every archived
        // entry would scale this sweep with (archived workspaces x config size).
        if (!(await devToolsService.hasWorkspaceData(metadata.id))) continue;
        // This sweep can run while the server is serving clients. Unarchive runs under the same
        // lock, so re-checking the live config inside it means a workspace unarchived since
        // `allMetadata` was read keeps the logs it has produced since.
        await this.withTaskTreeLifecycleLock(metadata.id, async () => {
          const live = findWorkspaceEntry(
            this.config.loadConfigOrDefault(),
            metadata.id
          )?.workspace;
          if (live == null || !isWorkspaceArchived(live.archivedAt, live.unarchivedAt)) return;
          await devToolsService.removeWorkspaceData(metadata.id);
        });
      } catch (error: unknown) {
        log.debug("Failed to remove DevTools log for archived workspace", {
          workspaceId: metadata.id,
          error,
        });
      }
    }
  }

  async createScratch(title?: string): Promise<Result<{ metadata: FrontendWorkspaceMetadata }>> {
    // Scratch chats always run on the local runtime; locked-down deployments
    // that disallow local runtimes must not get a local tool-execution
    // workspace through the scratch path either.
    if (this.policyService?.isEnforced()) {
      if (!this.policyService.isRuntimeAllowed({ type: "local" })) {
        return Err("Scratch chats require the local runtime, which is not allowed by policy");
      }
    }

    const workspaceId = this.config.generateStableId();
    const workspaceName = `scratch-${workspaceId}`;
    const workspacePath = this.getScratchWorkdir(workspaceId);
    const createdAt = new Date().toISOString();

    try {
      await ensurePrivateDir(this.getScratchRoot());
      await ensurePrivateDir(workspacePath);

      await this.config.editConfig((config) => {
        const scratchProject = config.projects.get(SCRATCH_PROJECT_CONFIG_KEY) ?? {
          workspaces: [],
          projectKind: "system" as const,
          trusted: true,
        };
        scratchProject.projectKind = "system";
        scratchProject.trusted = true;
        scratchProject.workspaces.push({
          kind: "scratch",
          path: workspacePath,
          id: workspaceId,
          name: workspaceName,
          title,
          createdAt,
          runtimeConfig: { type: "local" },
        });
        config.projects.set(SCRATCH_PROJECT_CONFIG_KEY, scratchProject);
        return config;
      });

      const completeMetadata = (await this.config.getAllWorkspaceMetadata()).find(
        (metadata) => metadata.id === workspaceId
      );
      if (!completeMetadata) {
        await this.config.removeWorkspace(workspaceId);
        await fsPromises.rm(workspacePath, { recursive: true, force: true });
        return Err("Failed to retrieve scratch workspace metadata");
      }

      const enrichedMetadata = this.enrichFrontendMetadata(completeMetadata);
      this.getOrCreateSession(workspaceId).emitMetadata(enrichedMetadata);
      eventSpine.emit("workspace.created", { workspaceId });
      return Ok({ metadata: enrichedMetadata });
    } catch (error) {
      await this.config.removeWorkspace(workspaceId).catch(() => undefined);
      await fsPromises.rm(workspacePath, { recursive: true, force: true }).catch(() => undefined);
      return Err(`Failed to create scratch workspace: ${getErrorMessage(error)}`);
    }
  }

  async create(
    projectPath: string,
    branchName: string | undefined,
    trunkBranch: string | undefined,
    title?: string,
    runtimeConfig?: RuntimeConfig,
    subProjectPath?: string,
    pendingAutoTitle?: boolean,
    tags?: Record<string, string>,
    options?: {
      /**
       * Resolve only once the checkout's files exist. By default a local worktree is
       * announced first so its checkout progress streams to the creation card; callers that
       * read the checkout right after create() (and cannot wait for init) opt out.
       */
      awaitMaterialization?: boolean;
    }
  ): Promise<Result<{ metadata: FrontendWorkspaceMetadata }>> {
    if (tags != null) {
      for (const [tagKey, tagValue] of Object.entries(tags)) {
        assert(tagKey.trim().length > 0, "Workspace tag keys must be non-empty");
        assert(typeof tagValue === "string", "Workspace tag values must be strings");
      }
    }
    const configSnapshot = this.config.loadConfigOrDefault();
    const requestedProjectPath = stripTrailingSlashes(projectPath);
    const requestedProjectConfig = configSnapshot.projects.get(requestedProjectPath);
    const owningProjectPath = requestedProjectConfig?.parentProjectPath ?? requestedProjectPath;
    const effectiveSubProjectPath = requestedProjectConfig?.parentProjectPath
      ? requestedProjectPath
      : subProjectPath;
    const projectConfig = configSnapshot.projects.get(owningProjectPath);

    if (
      effectiveSubProjectPath &&
      configSnapshot.projects.get(effectiveSubProjectPath)?.parentProjectPath !== owningProjectPath
    ) {
      return Err(`Sub-project not found under parent: ${effectiveSubProjectPath}`);
    }

    // Trust gate: block workspace creation for untrusted projects.
    // The frontend shows a confirmation dialog before reaching here,
    // but this guards secondary paths (slash commands, forking). Sub-projects
    // share their parent's checkout, so trust is owned by that parent project.
    if (!projectConfig?.trusted) {
      return Err(
        "This project must be trusted before creating workspaces. Trust the project in Settings → Security, or create a workspace from the project page."
      );
    }

    // Auto-generate a branch name when the caller omits one (used by /new to
    // mirror /fork's seamless creation flow). Mirrors fork's auto-naming: scan
    // existing workspace names AND local git branches so numbering is stable.
    // Branches/worktrees are owned by the parent project, so always read from
    // owningProjectPath even when a sub-project initiated creation.
    let resolvedBranchName: string;
    if (branchName == null) {
      const existingNamesSet = new Set<string>();
      for (const entry of projectConfig.workspaces ?? []) {
        if (typeof entry.name === "string") {
          existingNamesSet.add(entry.name);
        }
      }
      try {
        for (const localBranch of await listLocalBranches(owningProjectPath)) {
          existingNamesSet.add(localBranch);
        }
      } catch (error) {
        log.debug("Failed to list local branches for /new auto-name preflight", {
          projectPath: owningProjectPath,
          error: getErrorMessage(error),
        });
      }
      resolvedBranchName = generateForkBranchName(AUTO_NEW_WORKSPACE_BASE_NAME, [
        ...existingNamesSet,
      ]);
    } else {
      resolvedBranchName = branchName;
    }

    const validation = validateWorkspaceBranchName(resolvedBranchName);
    if (!validation.valid) {
      return Err(validation.error ?? "Invalid branch name");
    }

    const initialWorkspaceName = sanitizeBranchNameForWorkspace(resolvedBranchName);
    // Sanitized collisions must fail so distinct Git branches cannot share one workspace identity.
    const initialConflict = getBranchWorkspaceNameConflict(
      resolvedBranchName,
      (projectConfig.workspaces ?? []).map((workspace) => workspace.name)
    );
    if (initialConflict) {
      return Err(initialConflict);
    }

    const workspaceId = this.config.generateStableId();

    // Create runtime for workspace creation
    // Default to worktree runtime for backward compatibility
    let finalRuntimeConfig: RuntimeConfig = runtimeConfig ?? {
      type: "worktree",
      srcBaseDir: this.config.srcDir,
    };

    if (this.policyService?.isEnforced()) {
      if (!this.policyService.isRuntimeAllowed(finalRuntimeConfig)) {
        return Err("Selected runtime is not allowed by policy");
      }
    }

    // Local runtime doesn't need a trunk branch; worktree/SSH runtimes require it
    const isLocalRuntime = finalRuntimeConfig.type === "local";
    const normalizedTrunkBranch = trunkBranch?.trim() ?? "";
    if (!isLocalRuntime && normalizedTrunkBranch.length === 0) {
      return Err("Trunk branch is required for worktree and SSH runtimes");
    }

    let runtime;
    try {
      runtime = createRuntime(finalRuntimeConfig, { projectPath: owningProjectPath });

      // Resolve srcBaseDir path if the config has one.
      // Skip if runtime has deferredRuntimeAccess flag (runtime doesn't exist yet, e.g., Coder).
      const srcBaseDir = getSrcBaseDir(finalRuntimeConfig);
      if (srcBaseDir && !runtime.createFlags?.deferredRuntimeAccess) {
        const resolvedSrcBaseDir = await runtime.resolvePath(srcBaseDir);
        if (resolvedSrcBaseDir !== srcBaseDir && hasSrcBaseDir(finalRuntimeConfig)) {
          finalRuntimeConfig = {
            ...finalRuntimeConfig,
            srcBaseDir: resolvedSrcBaseDir,
          };
          runtime = createRuntime(finalRuntimeConfig, { projectPath: owningProjectPath });
        }
      }
    } catch (error) {
      const errorMsg = getErrorMessage(error);
      return Err(errorMsg);
    }

    const session = this.getOrCreateSession(workspaceId);
    this.initStateManager.startInit(workspaceId, owningProjectPath);

    // Create abort controller immediately so workspace lifecycle operations (e.g., cancel/remove)
    // can reliably interrupt init even if the UI deletes the workspace during create().
    const initAbortController = new AbortController();
    this.initAbortControllers.set(workspaceId, initAbortController);

    const initLogger = this.createInitLogger(workspaceId);

    try {
      let finalBranchName = resolvedBranchName;
      let finalWorkspaceName = initialWorkspaceName;
      const hasSanitizedWorkspaceName = finalBranchName !== finalWorkspaceName;
      let createResult: WorkspaceCreationResult;

      // If runtime uses config-level collision detection (e.g., Coder - can't reach host),
      // check against existing workspace names before createWorkspace.
      if (runtime.createFlags?.configLevelCollisionDetection) {
        const existingNames = new Set(
          (this.config.loadConfigOrDefault().projects.get(owningProjectPath)?.workspaces ?? []).map(
            (w) => w.name
          )
        );
        const configConflict = getBranchWorkspaceNameConflict(finalBranchName, existingNames);
        if (configConflict) {
          initLogger.logComplete(-1);
          return Err(configConflict);
        }

        for (
          let i = 0;
          i < MAX_WORKSPACE_NAME_COLLISION_RETRIES && existingNames.has(finalWorkspaceName);
          i++
        ) {
          log.debug(`Workspace name collision for "${finalWorkspaceName}", adding suffix`);
          finalBranchName = appendCollisionSuffix(resolvedBranchName);
          finalWorkspaceName = sanitizeBranchNameForWorkspace(finalBranchName);
        }
      }

      const createEnv = await secretsToRecord(
        this.secretsStore.getEffectiveSecrets(owningProjectPath)
      );
      const maxCollisionRetries = hasSanitizedWorkspaceName
        ? 0
        : MAX_WORKSPACE_NAME_COLLISION_RETRIES;

      for (let attempt = 0; attempt <= maxCollisionRetries; attempt++) {
        createResult = await runtime.createWorkspace({
          projectPath: owningProjectPath,
          branchName: finalBranchName,
          trunkBranch: normalizedTrunkBranch,
          directoryName: finalWorkspaceName,
          initLogger,
          abortSignal: initAbortController.signal,
          env: createEnv,
          trusted: projectConfig.trusted ?? false,
          deferMaterialization:
            options?.awaitMaterialization !== true && runtime.materializeWorkspace !== undefined,
        });

        if (createResult.success) break;

        if (hasSanitizedWorkspaceName && isWorkspaceNameCollision(createResult.error)) {
          initLogger.logComplete(-1);
          return Err(formatBranchWorkspaceNameConflict(finalBranchName));
        }

        if (
          isWorkspaceNameCollision(createResult.error) &&
          attempt < MAX_WORKSPACE_NAME_COLLISION_RETRIES
        ) {
          log.debug(`Workspace name collision for "${finalWorkspaceName}", retrying with suffix`);
          finalBranchName = appendCollisionSuffix(resolvedBranchName);
          finalWorkspaceName = sanitizeBranchNameForWorkspace(finalBranchName);
          continue;
        }
        break;
      }

      if (!createResult!.success || !createResult!.workspacePath) {
        initLogger.logComplete(-1);
        return Err(createResult!.error ?? "Failed to create workspace");
      }

      // Let runtime finalize config (e.g., derive names, compute host) after collision handling
      if (runtime.finalizeConfig) {
        const finalizeResult = await runtime.finalizeConfig(finalWorkspaceName, finalRuntimeConfig);
        if (!finalizeResult.success) {
          initLogger.logComplete(-1);
          return Err(finalizeResult.error);
        }
        finalRuntimeConfig = finalizeResult.data;
        runtime = createRuntime(finalRuntimeConfig, { projectPath: owningProjectPath });
      }

      // Let runtime validate before persisting (e.g., external collision checks)
      if (runtime.validateBeforePersist) {
        const validateResult = await runtime.validateBeforePersist(
          finalWorkspaceName,
          finalRuntimeConfig
        );
        if (!validateResult.success) {
          initLogger.logComplete(-1);
          return Err(validateResult.error);
        }
      }

      const projectName =
        owningProjectPath.split("/").pop() ?? owningProjectPath.split("\\").pop() ?? "unknown";

      const metadata = {
        id: workspaceId,
        name: finalWorkspaceName,
        title,
        projectName,
        projectPath: owningProjectPath,
        subProjectPath: effectiveSubProjectPath,
        createdAt: new Date().toISOString(),
      };

      // Host-local checkouts (project-dir local and worktree) get their
      // preserved/tracked .mux/mcp.local.jsonc sanitized below. Mark this
      // registration pending BEFORE the entry persists so an overlapping
      // creation for the same checkout cannot mistake the not-yet-sanitized
      // entry for a live sibling and skip its own sanitization.
      // A deferred worktree has no files yet; it is sanitized once
      // materialized, before its init hook (see materializeDeferredCheckout).
      const pendingMaterialization = createResult!.pendingMaterialization;
      const sanitizeAtRegistration =
        (finalRuntimeConfig.type === "local" || finalRuntimeConfig.type === "worktree") &&
        pendingMaterialization === undefined;
      let completeMetadata: FrontendWorkspaceMetadata | undefined;
      if (sanitizeAtRegistration) {
        this.pendingPluginSanitizations.add(workspaceId);
      }
      let releaseRegistrationLock: (() => Promise<void>) | undefined;
      try {
        if (sanitizeAtRegistration) {
          // Cross-process: persist + sanitize must not interleave with a
          // sibling process registering the same checkout (see
          // acquireRegistrationSanitizeLock).
          releaseRegistrationLock = await this.acquireRegistrationSanitizeLock();
        }
        await this.config.editConfig((config) => {
          let projectConfig = config.projects.get(owningProjectPath);
          if (!projectConfig) {
            projectConfig = { workspaces: [] };
            config.projects.set(owningProjectPath, projectConfig);
          }
          projectConfig.workspaces.push({
            path: createResult!.workspacePath!,
            id: workspaceId,
            name: finalWorkspaceName,
            title,
            createdAt: metadata.createdAt,
            runtimeConfig: finalRuntimeConfig,
            subProjectPath: effectiveSubProjectPath,
            // Persist tags atomically with creation so orchestration loops that
            // look workspaces up by tag (e.g. workspace.ensure) never observe a
            // created-but-untagged window after a crash.
            ...(tags != null && Object.keys(tags).length > 0 ? { tags } : {}),
            // Mirror /fork: when /new is invoked with a start message, defer title
            // selection until the first message can drive LLM-based generation.
            ...(pendingAutoTitle === true ? { pendingAutoTitle: true } : {}),
          });
          return config;
        });

        const allMetadata = await this.config.getAllWorkspaceMetadata();
        completeMetadata = allMetadata.find((m) => m.id === workspaceId);
        if (!completeMetadata) {
          initLogger.logComplete(-1);
          return Err("Failed to retrieve workspace metadata");
        }

        // The checkout being registered may already hold plugin enables no
        // live workspace consented to: LocalRuntime registers an EXISTING
        // directory whose preserved .mux/mcp.local.jsonc can carry enables
        // from a since-removed workspace, and a fresh WORKTREE checkout
        // materializes the file when the repository tracks it (project plugin
        // instance IDs are stable across a project's worktrees, so committed
        // enables would silently activate here). Sanitize before announcing;
        // a failure aborts the creation so nothing stale ever activates.
        // SSH/container runtimes exec off-host, where plugin servers never
        // spawn (host-path containers only in v1).
        if (sanitizeAtRegistration) {
          const sanitizeError = await this.sanitizeStalePluginOverridesForNewWorkspace(
            workspaceId,
            createResult!.workspacePath
          );
          if (sanitizeError !== undefined) {
            const rolledBack = await this.abortUnsanitizedCreation({
              workspaceId,
              runtime,
              runtimeConfig: finalRuntimeConfig,
              projectPath: owningProjectPath,
              workspaceName: finalWorkspaceName,
              trusted: projectConfig.trusted ?? false,
              initAbortController,
            });
            initLogger.logComplete(-1);
            return Err(
              rolledBack
                ? sanitizeError
                : `${sanitizeError} Additionally, the half-created workspace registration could not be rolled back; remove workspace ${workspaceId} manually before retrying.`
            );
          }
        }
      } finally {
        await releaseRegistrationLock?.();
        this.pendingPluginSanitizations.delete(workspaceId);
      }
      assert(
        completeMetadata !== undefined,
        "create: registration must have produced workspace metadata"
      );

      session.emitMetadata(this.enrichFrontendMetadata(completeMetadata));

      // Background init: run postCreateSetup (if present) then initWorkspace
      const secrets = await secretsToRecord(
        this.secretsStore.getEffectiveSecrets(owningProjectPath)
      );
      // Background init: postCreateSetup (provisioning) + initWorkspace (sync/checkout/hook)
      //
      // If the user cancelled creation while create() was still in flight, avoid spawning
      // additional background work for a workspace that's already being removed.
      if (!this.removingWorkspaces.has(workspaceId) && !initAbortController.signal.aborted) {
        const initParams: WorkspaceInitParams = {
          projectPath: owningProjectPath,
          branchName: finalBranchName,
          trunkBranch: normalizedTrunkBranch,
          workspacePath: createResult!.workspacePath,
          initLogger,
          env: secrets,
          abortSignal: initAbortController.signal,
          trusted: projectConfig.trusted ?? false,
        };
        // Retained (not just fired) so archive can await the hook process's actual exit.
        this.retainInitSettlement(
          workspaceId,
          pendingMaterialization
            ? this.materializeDeferredCheckout({
                workspaceId,
                runtime,
                runtimeConfig: finalRuntimeConfig,
                workspaceName: finalWorkspaceName,
                initParams,
                pending: pendingMaterialization,
                initAbortController,
              })
            : runBackgroundInit(runtime, initParams, workspaceId, log)
        );
      } else {
        initAbortController.abort();
        this.initAbortControllers.delete(workspaceId);

        // Background init will never run, so init-end won’t fire.
        // Clear init state + re-emit metadata so the sidebar doesn’t stay stuck on isInitializing.
        this.initStateManager.clearInMemoryState(workspaceId);
        session.emitMetadata(this.enrichFrontendMetadata(completeMetadata));
      }

      await this.syncCodeWorkspaceFiles(completeMetadata);
      eventSpine.emit("workspace.created", { workspaceId });
      return Ok({ metadata: this.enrichFrontendMetadata(completeMetadata) });
    } catch (error) {
      initLogger.logComplete(-1);
      const message = getErrorMessage(error);
      return Err(`Failed to create workspace: ${message}`);
    }
  }

  /**
   * Scope note: unlike create(), this does not accept creation-time `tags` —
   * multi-project workspaces currently can't be tagged atomically (callers
   * would need a follow-up updateTags, reintroducing a crash-window gap).
   * Thread tags through here if orchestration loops ever target multi-project
   * workspaces.
   */
  async createMultiProject(
    projects: ProjectRef[],
    branchName: string,
    trunkBranch: string | undefined,
    title?: string,
    runtimeConfig?: RuntimeConfig
  ): Promise<Result<FrontendWorkspaceMetadata>> {
    assert(projects.length > 1, "createMultiProject requires at least two projects");
    if (!this.isMultiProjectWorkspacesExperimentEnabled()) {
      return Err(MULTI_PROJECT_WORKSPACES_DISABLED_ERROR);
    }

    let initLogger: ReturnType<WorkspaceService["createInitLogger"]> | null = null;

    try {
      const validation = validateWorkspaceBranchName(branchName);
      if (!validation.valid) {
        return Err(validation.error ?? "Invalid branch name");
      }
      const workspaceName = sanitizeBranchNameForWorkspace(branchName);

      const normalizedProjects = projects.map((project) => ({
        projectPath: stripTrailingSlashes(project.projectPath),
        projectName: project.projectName,
      }));
      const primaryProject = normalizedProjects[0];
      assert(primaryProject, "createMultiProject requires a primary project");

      const configSnapshot = this.config.loadConfigOrDefault();
      for (const project of normalizedProjects) {
        const projectConfig = configSnapshot.projects.get(
          stripTrailingSlashes(project.projectPath)
        );
        if (projectConfig?.parentProjectPath) {
          return Err(
            `Sub-project ${project.projectName} cannot be added directly to a multi-project workspace. Add its parent project instead.`
          );
        }
      }

      for (const project of normalizedProjects) {
        const projectConfig = configSnapshot.projects.get(
          stripTrailingSlashes(project.projectPath)
        );
        if (!projectConfig?.trusted) {
          return Err(
            `Project ${project.projectName} must be trusted before creating workspaces. Trust the project in Settings → Security, or create a workspace from the project page.`
          );
        }
      }

      const existingWorkspaceNames = [
        ...(configSnapshot.projects.get(MULTI_PROJECT_CONFIG_KEY)?.workspaces ?? []).map(
          (workspace) => workspace.name
        ),
        ...normalizedProjects.flatMap((project) =>
          (
            configSnapshot.projects.get(stripTrailingSlashes(project.projectPath))?.workspaces ?? []
          ).map((workspace) => workspace.name)
        ),
      ];
      const workspaceNameConflict = getBranchWorkspaceNameConflict(
        branchName,
        existingWorkspaceNames
      );
      if (workspaceNameConflict) {
        return Err(workspaceNameConflict);
      }

      const workspaceId = this.config.generateStableId();

      let finalRuntimeConfig: RuntimeConfig = runtimeConfig ?? {
        type: "worktree",
        srcBaseDir: this.config.srcDir,
      };

      if (this.policyService?.isEnforced()) {
        if (!this.policyService.isRuntimeAllowed(finalRuntimeConfig)) {
          return Err("Selected runtime is not allowed by policy");
        }
      }

      const runtimeType = finalRuntimeConfig.type;
      assert(
        runtimeType === "local" || runtimeType === "worktree",
        `Multi-project workspaces currently require local or worktree runtime, got: ${runtimeType}`
      );

      const isLocalRuntime = finalRuntimeConfig.type === "local";
      const normalizedPreferredTrunkBranch = trunkBranch?.trim();
      if (!isLocalRuntime && normalizedPreferredTrunkBranch === "") {
        return Err("Trunk branch is required for worktree runtime");
      }

      let containerSrcBaseDir = getSrcBaseDir(finalRuntimeConfig) ?? this.config.srcDir;
      const runtimeSrcBaseDir = getSrcBaseDir(finalRuntimeConfig);
      if (runtimeSrcBaseDir) {
        const primaryRuntime = createRuntime(finalRuntimeConfig, {
          projectPath: primaryProject.projectPath,
        });

        if (!primaryRuntime.createFlags?.deferredRuntimeAccess) {
          const resolvedSrcBaseDir = await primaryRuntime.resolvePath(runtimeSrcBaseDir);
          containerSrcBaseDir = resolvedSrcBaseDir;
          if (resolvedSrcBaseDir !== runtimeSrcBaseDir && hasSrcBaseDir(finalRuntimeConfig)) {
            finalRuntimeConfig = {
              ...finalRuntimeConfig,
              srcBaseDir: resolvedSrcBaseDir,
            };
          }
        }
      }

      const session = this.getOrCreateSession(workspaceId);
      this.initStateManager.startInit(workspaceId, primaryProject.projectPath);
      const initAbortController = new AbortController();
      this.initAbortControllers.set(workspaceId, initAbortController);
      initLogger = this.createInitLogger(workspaceId);

      const resolveProjectTrunkBranch = async (projectPath: string): Promise<string> => {
        if (isLocalRuntime) {
          return normalizedPreferredTrunkBranch ?? "";
        }

        if (!normalizedPreferredTrunkBranch) {
          const localBranches = await listLocalBranches(projectPath);
          return detectDefaultTrunkBranch(projectPath, localBranches);
        }

        try {
          const localBranches = await listLocalBranches(projectPath);
          if (localBranches.includes(normalizedPreferredTrunkBranch)) {
            return normalizedPreferredTrunkBranch;
          }

          const detectedTrunkBranch = await detectDefaultTrunkBranch(projectPath, localBranches);
          log.debug("Requested multi-project trunk branch missing; using detected branch", {
            projectPath,
            requestedTrunkBranch: normalizedPreferredTrunkBranch,
            detectedTrunkBranch,
          });
          return detectedTrunkBranch;
        } catch (error: unknown) {
          // When branch discovery is unavailable, preserve the caller-provided branch.
          // This mirrors single-project create() behavior for non-local runtimes.
          log.debug("Failed to detect per-project trunk branch; using requested branch", {
            projectPath,
            requestedTrunkBranch: normalizedPreferredTrunkBranch,
            error: getErrorMessage(error),
          });
          return normalizedPreferredTrunkBranch;
        }
      };
      const projectRuntimeEntries = normalizedProjects.map((project) => ({
        project,
        runtime: createRuntime(finalRuntimeConfig, {
          projectPath: project.projectPath,
          workspaceName,
        }),
      }));

      const createdWorkspaces: Array<{
        project: ProjectRef;
        runtime: ReturnType<typeof createRuntime>;
        workspacePath: string;
        trunkBranch: string;
      }> = [];

      const rollbackCreatedWorkspaces = async (): Promise<void> => {
        for (const createdWorkspace of [...createdWorkspaces].reverse()) {
          const trusted =
            configSnapshot.projects.get(stripTrailingSlashes(createdWorkspace.project.projectPath))
              ?.trusted ?? false;
          try {
            // Rollback only removes the just-created workspace path; forcing deletion could
            // also drop an older same-named branch in worktree runtimes.
            await createdWorkspace.runtime.deleteWorkspace(
              createdWorkspace.project.projectPath,
              workspaceName,
              false,
              initAbortController.signal,
              trusted
            );
          } catch (error: unknown) {
            log.error("Failed to roll back multi-project workspace creation", {
              workspaceId,
              projectPath: createdWorkspace.project.projectPath,
              error: getErrorMessage(error),
            });
          }
        }
      };

      for (const projectRuntimeEntry of projectRuntimeEntries) {
        const trusted =
          configSnapshot.projects.get(stripTrailingSlashes(projectRuntimeEntry.project.projectPath))
            ?.trusted ?? false;

        let projectTrunkBranch: string;
        try {
          projectTrunkBranch = await resolveProjectTrunkBranch(
            projectRuntimeEntry.project.projectPath
          );
        } catch (error: unknown) {
          await rollbackCreatedWorkspaces();
          initLogger.logComplete(-1);
          return Err(
            `Failed to resolve trunk branch for project ${projectRuntimeEntry.project.projectName}: ${getErrorMessage(error)}`
          );
        }

        assert(
          isLocalRuntime || projectTrunkBranch.length > 0,
          `Expected non-empty trunk branch for project ${projectRuntimeEntry.project.projectPath}`
        );

        const createEnv = await secretsToRecord(
          this.secretsStore.getEffectiveSecrets(projectRuntimeEntry.project.projectPath)
        );

        const createResult = await projectRuntimeEntry.runtime.createWorkspace({
          projectPath: projectRuntimeEntry.project.projectPath,
          branchName,
          trunkBranch: projectTrunkBranch,
          directoryName: workspaceName,
          initLogger,
          abortSignal: initAbortController.signal,
          env: createEnv,
          trusted,
        });

        if (!createResult.success || !createResult.workspacePath) {
          await rollbackCreatedWorkspaces();
          initLogger.logComplete(-1);
          if (branchName !== workspaceName && isWorkspaceNameCollision(createResult.error)) {
            return Err(formatBranchWorkspaceNameConflict(branchName));
          }
          return Err(
            createResult.error ??
              `Failed to create workspace for project ${projectRuntimeEntry.project.projectName}`
          );
        }

        createdWorkspaces.push({
          project: projectRuntimeEntry.project,
          runtime: projectRuntimeEntry.runtime,
          workspacePath: createResult.workspacePath,
          trunkBranch: projectTrunkBranch,
        });
      }

      const containerManager = new ContainerManager(containerSrcBaseDir);
      let containerPath: string;
      try {
        containerPath = await containerManager.createContainer(
          workspaceName,
          createdWorkspaces.map((workspace) => ({
            projectName: workspace.project.projectName,
            workspacePath: workspace.workspacePath,
          }))
        );
      } catch (error) {
        await rollbackCreatedWorkspaces();
        const containerAlreadyExists = isErrnoWithCode(error, "EEXIST");
        if (!containerAlreadyExists) {
          try {
            await containerManager.removeContainer(workspaceName);
          } catch (cleanupError: unknown) {
            log.error("Failed to clean up multi-project container after create failure", {
              workspaceId,
              branchName,
              error: getErrorMessage(cleanupError),
            });
          }
        }
        initLogger.logComplete(-1);
        if (containerAlreadyExists) {
          if (branchName !== workspaceName) {
            return Err(formatBranchWorkspaceNameConflict(branchName));
          }
          return Err(`Failed to create multi-project container: ${workspaceName} already exists`);
        }
        return Err(`Failed to create multi-project container: ${getErrorMessage(error)}`);
      }

      const createdAt = new Date().toISOString();
      await this.config.editConfig((config) => {
        const multiProjectConfig = config.projects.get(MULTI_PROJECT_CONFIG_KEY) ?? {
          workspaces: [],
          projectKind: "system",
        };
        // Ensure legacy _multi entries are hidden from user-facing project lists.
        multiProjectConfig.projectKind = "system";
        multiProjectConfig.workspaces.push({
          path: containerPath,
          id: workspaceId,
          name: workspaceName,
          title,
          createdAt,
          runtimeConfig: finalRuntimeConfig,
          projects: normalizedProjects,
        });
        config.projects.set(MULTI_PROJECT_CONFIG_KEY, multiProjectConfig);
        return config;
      });

      const allMetadata = await this.config.getAllWorkspaceMetadata();
      const completeMetadata = allMetadata.find((metadata) => metadata.id === workspaceId);
      if (!completeMetadata) {
        initLogger.logComplete(-1);
        return Err("Failed to retrieve workspace metadata");
      }

      const enrichedMetadata = this.enrichFrontendMetadata(completeMetadata);
      session.emitMetadata(enrichedMetadata);

      // Background init: run postCreateSetup (if present) then initWorkspace for each project runtime.
      // Multi-project creation should mirror create(): return metadata immediately, but only mark init
      // complete after initialization work has run.
      if (!this.removingWorkspaces.has(workspaceId) && !initAbortController.signal.aborted) {
        // Retained (not just fired) so archive can await the per-project init loop's exit.
        this.retainInitSettlement(
          workspaceId,
          (async () => {
            let initFailed = false;

            for (const createdWorkspace of createdWorkspaces) {
              if (this.removingWorkspaces.has(workspaceId) || initAbortController.signal.aborted) {
                break;
              }

              const trusted =
                configSnapshot.projects.get(
                  stripTrailingSlashes(createdWorkspace.project.projectPath)
                )?.trusted ?? false;

              const projectInitLogger = {
                ...initLogger,
                // Each runtime's init path reports completion. Suppress per-project completion so
                // multi-project workspaces only transition out of initializing after all runtimes finish.
                logComplete: (_exitCode: number) => undefined,
              };

              try {
                const secrets = await secretsToRecord(
                  this.secretsStore.getEffectiveSecrets(createdWorkspace.project.projectPath)
                );

                const initResult = await runFullInit(createdWorkspace.runtime, {
                  projectPath: createdWorkspace.project.projectPath,
                  branchName,
                  trunkBranch: createdWorkspace.trunkBranch,
                  workspacePath: createdWorkspace.workspacePath,
                  initLogger: projectInitLogger,
                  env: secrets,
                  abortSignal: initAbortController.signal,
                  trusted,
                });

                if (!initResult.success) {
                  initFailed = true;
                  log.error("Multi-project workspace init failed", {
                    workspaceId,
                    projectPath: createdWorkspace.project.projectPath,
                    error: initResult.error ?? "Unknown initialization failure",
                  });
                }
              } catch (error: unknown) {
                initFailed = true;
                const message = getErrorMessage(error);
                log.error("Multi-project workspace init failed", {
                  workspaceId,
                  projectPath: createdWorkspace.project.projectPath,
                  error: message,
                });
                initLogger.logStderr(
                  `Initialization failed for ${createdWorkspace.project.projectName}: ${message}`
                );
              }
            }

            if (this.removingWorkspaces.has(workspaceId) || initAbortController.signal.aborted) {
              initAbortController.abort();
              this.initAbortControllers.delete(workspaceId);

              // Background init will never fully complete, so init-end won’t fire.
              // Clear init state + re-emit fresh metadata so the sidebar doesn’t stay stuck on isInitializing.
              this.initStateManager.clearInMemoryState(workspaceId);
              session.emitMetadata(this.enrichFrontendMetadata(completeMetadata));
              return;
            }

            initLogger.logComplete(initFailed ? -1 : 0);
          })()
        );
      } else {
        initAbortController.abort();
        this.initAbortControllers.delete(workspaceId);

        // Background init will never run, so init-end won’t fire.
        // Clear init state + re-emit fresh metadata so the sidebar doesn’t stay stuck on isInitializing.
        this.initStateManager.clearInMemoryState(workspaceId);
        session.emitMetadata(this.enrichFrontendMetadata(completeMetadata));
      }

      await this.syncCodeWorkspaceFiles(completeMetadata);
      eventSpine.emit("workspace.created", { workspaceId });
      return Ok(enrichedMetadata);
    } catch (error) {
      initLogger?.logComplete(-1);
      const message = getErrorMessage(error);
      return Err(`Failed to create multi-project workspace: ${message}`);
    }
  }

  private async withTaskTreeLifecycleLock<T>(
    workspaceId: string,
    operation: () => Promise<T>
  ): Promise<T> {
    const integration = this.agentTaskIntegration;
    return integration == null
      ? await operation()
      : await integration.withTaskTreeLifecycleLock(workspaceId, operation);
  }

  /**
   * @param options.beforeRemove - evaluated inside the task-tree lifecycle lock; returning false
   *   turns the call into a no-op. Lets callers that screened eligibility outside the lock confirm
   *   it against live state within the same lock hold that performs the removal.
   */
  async remove(
    workspaceId: string,
    force = false,
    options?: { beforeRemove?: () => Promise<boolean>; acknowledgedDescendantIds?: string[] }
  ): Promise<Result<void> & { descendants?: WorkspaceRemovalDescendant[] }> {
    return await this.withTaskTreeLifecycleLock(workspaceId, async () => {
      const operation = async () => {
        if (options?.beforeRemove != null && !(await options.beforeRemove())) {
          return Ok(undefined);
        }
        const failure = (error: string) => {
          const descendants =
            this.agentTaskIntegration?.listWorkspaceRemovalDescendants(workspaceId);
          return { ...Err(error), ...(descendants?.length ? { descendants } : {}) };
        };
        try {
          if (options?.acknowledgedDescendantIds != null) {
            if (this.agentTaskIntegration == null) {
              return failure("Task lifecycle service is unavailable.");
            }
            const descendantsResult =
              await this.agentTaskIntegration.removeAcknowledgedDescendantsWhileTaskTreeLocked(
                workspaceId,
                options.acknowledgedDescendantIds
              );
            if (!descendantsResult.success) return failure(descendantsResult.error);
          }
          const result = await this.removeUnlocked(workspaceId, force);
          return result.success ? result : failure(result.error);
        } catch (error) {
          return failure(getErrorMessage(error));
        }
      };
      // Defer the project-list refresh until the complete descendant cascade ends.
      return options?.acknowledgedDescendantIds != null
        ? await this.config.withDeferredChangeNotifications(operation)
        : await operation();
    });
  }

  /**
   * Internal entry point for task orchestration callers that already hold the task-tree lifecycle lock,
   * or that must not acquire it for lock-ordering reasons (e.g. createWorkspaceTurn cleanup runs
   * under the task creation mutex, which the tree lock is ordered before).
   */
  async removeWhileTaskTreeLocked(workspaceId: string, force = false): Promise<Result<void>> {
    return await this.removeUnlocked(workspaceId, force);
  }

  private async removeUnlocked(workspaceId: string, force = false): Promise<Result<void>> {
    if (this.shuttingDown) return Err("Server is shutting down");
    // Idempotent: if already removing, return success to prevent race conditions
    if (this.removingWorkspaces.has(workspaceId)) {
      return Ok(undefined);
    }
    this.removingWorkspaces.add(workspaceId);
    let timelineClosed = false;
    let removedFromConfig = false;

    // If this workspace is mid-init, cancel the fire-and-forget init work (postCreateSetup,
    // sync/checkout, .xum/init hook, etc.) so removal doesn't leave orphaned background work.
    const initAbortController = this.initAbortControllers.get(workspaceId);
    if (initAbortController) {
      initAbortController.abort();
      this.initAbortControllers.delete(workspaceId);
    }

    // The registered entry is read AFTER the MCP-overrides lock below is held
    // (a sibling backend's rename retargets the lock onto the renamed checkout,
    // and the deletion must address that checkout, not a stale path); this
    // pre-lock view only serves the project-list refresh at the end.
    let persistedWorkspace = this.config.findWorkspace(workspaceId);
    // Startup recovery or a queued dispatch can be one await from starting a stream that the single
    // stopStream() below cannot see, and the entry stays present and unarchived until removal has
    // finished with the runtime. Hold admission for the whole removal: success disposes the session,
    // failure releases the hold so the workspace stays usable.
    const admissionHolds = [
      this.sessions.get(workspaceId),
      this.transientStartupRecoverySessions.get(workspaceId),
    ]
      .filter((session): session is AgentSession => session != null)
      .map((session) => session.holdTurnAdmission());

    // Removal deletes the checkout: hold THIS workspace's MCP-overrides lock
    // like rename does (see rename), so a settings save that verified the
    // checkout's existence cannot have its `mkdir -p` recreate the deleted
    // path and write an orphaned override file while both operations report
    // success. Scoped to this workspace; taken before any disk mutation and
    // released once removal has settled (finally below).
    let releaseOverridesLock: (() => Promise<void>) | undefined;
    // Try to remove from runtime (filesystem)
    try {
      if (this.agentTaskIntegration?.hasDescendantAgentTasks(workspaceId) === true) {
        return Err(DESCENDANT_WORKSPACE_REMOVE_ERROR);
      }
      // Forced removals too (routine task cleanup uses force): proceeding
      // while a stalled writer still owns the lock would let it resume after
      // the deletion and recreate the removed path. The acquisition is
      // bounded (and a crashed holder's lease is reclaimed), so a failure here
      // is retryable rather than a permanent block.
      releaseOverridesLock =
        await this.workspaceMcpOverridesService?.acquireWorkspaceLock(workspaceId);
      // Fresh under the lock (see above).
      persistedWorkspace = this.config.findWorkspace(workspaceId) ?? persistedWorkspace;

      // The captured engine stop joins partial finalization and raw terminal delivery.
      try {
        const stopPromise = this.aiService.stopStream(workspaceId, { abandonPartial: true });
        const stopOutcome = await raceWithAbortAndTimeout(stopPromise, {
          timeoutMs: TASK_TERMINATION_STOP_STREAM_TIMEOUT_MS,
        });
        if (stopOutcome.kind !== "ok") {
          void stopPromise.catch((error: unknown) => {
            log.debug("Timed-out workspace removal stopStream later threw", {
              workspaceId,
              error,
            });
          });
          return Err("Timed out stopping workspace stream; workspace was not removed");
        }
        if (!stopOutcome.value.success) {
          log.debug("Failed to stop stream during workspace removal", {
            workspaceId,
            error: stopOutcome.value.error,
          });
        }
      } catch (error: unknown) {
        log.debug("Failed to stop stream during workspace removal (threw)", { workspaceId, error });
      }

      // Raw terminal listeners may enqueue timing writes; join those before rollup/removal.
      await this.sessionTimingService?.waitForIdle(workspaceId);

      let parentWorkspaceId: string | null = null;
      let childTaskModelString: string | undefined;
      let childTaskThinkingLevel: ThinkingLevel | undefined;

      const metadataResult = await this.aiService.getWorkspaceMetadata(workspaceId);
      if (metadataResult.success) {
        const metadata = metadataResult.data;
        const configSnapshot = this.config.loadConfigOrDefault();

        const persistedWorkspacePath = persistedWorkspace?.workspacePath;

        // Tasks spawned with isolation: "none" share their parent workspace's checkout (their
        // persisted path points at it). Physically deleting that directory would destroy the
        // parent's working tree, so skip runtime deletion and only remove config/session state.
        // Runtime deletion is keyed on the task's unique name today (a safe no-op), but guard
        // explicitly so this stays correct if runtime deletion ever resolves the persisted path.
        const taskSharesParentCheckout =
          findWorkspaceEntry(configSnapshot, workspaceId)?.workspace.taskIsolation === "none";

        // Inverse direction: this workspace's checkout may be shared by live isolation: "none"
        // descendants (their persisted path points at it). Deleting it would yank the cwd out
        // from under their started streams, so preserve the directory and only clean up this
        // workspace's config/session state. Reported/interrupted shared tasks don't block
        // deletion, and neither do "queued" ones: dequeue requires the parent config entry
        // regardless of isolation, so a queued child of a removed parent fails fast at launch
        // ("Queued task parent not found") exactly like a queued forked task — preserving its
        // checkout would only leak the directory.
        const activeSharedTaskStatuses = new Set(["starting", "running", "awaiting_report"]);
        const checkoutSharedByActiveTask =
          persistedWorkspacePath != null &&
          Array.from(configSnapshot.projects.values()).some((project) =>
            project.workspaces.some(
              (ws) =>
                ws.id !== workspaceId &&
                ws.taskIsolation === "none" &&
                ws.path === persistedWorkspacePath &&
                activeSharedTaskStatuses.has(ws.taskStatus ?? "")
            )
          );

        parentWorkspaceId = metadata.parentWorkspaceId ?? null;
        childTaskModelString = metadata.taskModelString;
        childTaskThinkingLevel = coerceThinkingLevel(metadata.taskThinkingLevel);

        // Cancel and drain BOTH background producers BEFORE any disk
        // mutation below. Two invariants depend on this ordering:
        // (1) an admitted /refine apply runs to completion and can write
        //     project skills into the CHECKOUT — draining after
        //     runtime.deleteWorkspace() let that write race checkout
        //     deletion (recreating .mux/skills in a deleted tree, or failing
        //     midway with the failure swallowed);
        // (2) a draining producer records headless usage as it settles, so
        //     the usage rollup below must read its snapshot only after both
        //     drains (spend landing later is lost — the child is deleted
        //     with no second rollup).
        // Trade-off: a force=false deletion failure below keeps the
        // workspace but its producers were already drained. That loss is
        // recoverable (rerun /refine, refork); a checkout write racing
        // deletion is not. Both calls are idempotent; they run again later
        // for the phantom-metadata path.
        // Dream/harvest consolidation is a third producer (r60): its runs
        // ride only a hard timeout, so removal must abort them explicitly or
        // a detached run could mutate memory and journal into the deleted
        // session directory. Cancel BEFORE clearPendingBranchSummary so
        // residual wedged runs it hands to the usage-write registry get that
        // drain's bounded second chance.
        await this.memoryConsolidationService?.cancelInFlightConsolidation(workspaceId);
        await clearPendingBranchSummary(workspaceId);
        await this.refinePassCanceller?.cancelInFlightRefinePass(workspaceId);

        if (isMultiProject(metadata)) {
          const projects = getProjects(metadata);
          const deleteErrors: string[] = [];
          const projectRemovals: Array<{
            project: (typeof projects)[number];
            runtime: ReturnType<typeof createRuntime>;
            trusted: boolean;
          }> = [];

          for (const project of projects) {
            try {
              const runtime = createRuntime(metadata.runtimeConfig, {
                projectPath: project.projectPath,
                workspaceName: metadata.name,
                workspacePath: persistedWorkspacePath
                  ? getWorkspacePathHintForProject(
                      {
                        workspaceId,
                        workspaceName: metadata.name,
                        workspacePath: persistedWorkspacePath,
                        runtimeConfig: metadata.runtimeConfig,
                        projectPath: metadata.projectPath,
                        projectName: metadata.projectName,
                        projects: metadata.projects,
                      },
                      project.projectPath
                    )
                  : undefined,
              });
              const trusted =
                configSnapshot.projects.get(stripTrailingSlashes(project.projectPath))?.trusted ??
                false;
              projectRemovals.push({ project, runtime, trusted });
            } catch (error: unknown) {
              deleteErrors.push(`[${project.projectName}] ${getErrorMessage(error)}`);
            }
          }

          if (deleteErrors.length > 0 && !force) {
            return Err(
              `Failed to delete multi-project workspace from disk: ${deleteErrors.join("; ")}`
            );
          }

          const requiresWorktreeDeletePreflight =
            !force &&
            (metadata.runtimeConfig.type === "worktree" ||
              (metadata.runtimeConfig.type === "local" && hasSrcBaseDir(metadata.runtimeConfig)));
          if (requiresWorktreeDeletePreflight) {
            const preflightErrors: string[] = [];

            for (const projectRemoval of projectRemovals) {
              const preflightRuntime = projectRemoval.runtime as typeof projectRemoval.runtime & {
                canDeleteWorkspaceWithoutForce?: (
                  projectPath: string,
                  workspaceName: string,
                  trusted?: boolean
                ) => Promise<{ success: true } | { success: false; error: string }>;
              };

              try {
                if (typeof preflightRuntime.canDeleteWorkspaceWithoutForce !== "function") {
                  preflightErrors.push(
                    `[${projectRemoval.project.projectName}] Worktree delete preflight is unavailable for runtime type ${metadata.runtimeConfig.type}`
                  );
                  continue;
                }

                // Preflight every worktree before mutating disk so force=false cannot partially
                // delete earlier projects when a later worktree still needs force.
                const preflightResult = await preflightRuntime.canDeleteWorkspaceWithoutForce(
                  projectRemoval.project.projectPath,
                  metadata.name,
                  projectRemoval.trusted
                );
                if (!preflightResult.success) {
                  preflightErrors.push(
                    `[${projectRemoval.project.projectName}] ${preflightResult.error}`
                  );
                }
              } catch (error: unknown) {
                preflightErrors.push(
                  `[${projectRemoval.project.projectName}] ${getErrorMessage(error)}`
                );
              }
            }

            if (preflightErrors.length > 0) {
              return Err(
                `Failed to delete multi-project workspace from disk: ${preflightErrors.join("; ")}`
              );
            }
          }

          for (const projectRemoval of projectRemovals) {
            try {
              const deleteResult = await projectRemoval.runtime.deleteWorkspace(
                projectRemoval.project.projectPath,
                metadata.name,
                force,
                undefined,
                projectRemoval.trusted
              );

              if (!deleteResult.success) {
                deleteErrors.push(
                  `[${projectRemoval.project.projectName}] ${
                    deleteResult.error ?? "Failed to delete workspace from disk"
                  }`
                );
              }
            } catch (error: unknown) {
              deleteErrors.push(
                `[${projectRemoval.project.projectName}] ${getErrorMessage(error)}`
              );
            }
          }

          if (deleteErrors.length > 0 && !force) {
            return Err(
              `Failed to delete multi-project workspace from disk: ${deleteErrors.join("; ")}`
            );
          }

          const containerManager = new ContainerManager(
            getSrcBaseDir(metadata.runtimeConfig) ?? this.config.srcDir
          );
          try {
            await containerManager.removeContainer(metadata.name);
          } catch (error: unknown) {
            deleteErrors.push(`[container] ${getErrorMessage(error)}`);
          }

          if (deleteErrors.length > 0) {
            if (!force) {
              return Err(
                `Failed to delete multi-project workspace from disk: ${deleteErrors.join("; ")}`
              );
            }
            log.error(
              `Failed to fully delete multi-project workspace from disk, but force=true. Removing from config. Errors: ${deleteErrors.join("; ")}`
            );
          }
        } else if (metadata.kind === "scratch") {
          if (
            persistedWorkspacePath == null ||
            !this.isManagedScratchWorkdir(persistedWorkspacePath)
          ) {
            return Err(
              "Refusing to delete scratch workspace outside the managed scratch directory"
            );
          }

          const resolvedScratchPath = path.resolve(persistedWorkspacePath);
          const hasOtherScratchReference = Array.from(configSnapshot.projects.values()).some(
            (project) =>
              project.workspaces.some(
                (workspace) =>
                  workspace.id !== workspaceId &&
                  workspace.kind === "scratch" &&
                  path.resolve(workspace.path) === resolvedScratchPath
              )
          );
          if (!hasOtherScratchReference) {
            if (
              this.scratchWorkdirOwnedByWorkspace(
                configSnapshot,
                metadata,
                path.basename(resolvedScratchPath)
              )
            ) {
              await fsPromises.rm(persistedWorkspacePath, { recursive: true, force: true });
            } else {
              // Skip instead of failing: config cleanup still proceeds, and the
              // startup orphan sweep reclaims the dir once nothing references it.
              log.warn(
                "Skipping scratch workdir deletion: basename matches neither the workspace nor its task ancestors",
                { workspaceId, workspacePath: persistedWorkspacePath }
              );
            }
          }
        } else if (taskSharesParentCheckout) {
          // Shared checkout (isolation: "none"): do not touch the filesystem — the directory
          // belongs to the parent workspace. Config/session cleanup below still runs.
          log.debug("Skipping runtime deletion for shared-workspace task", {
            workspaceId,
            workspacePath: persistedWorkspacePath,
          });
        } else if (checkoutSharedByActiveTask) {
          // This checkout is the live cwd of one or more isolation: "none" descendants. Removing
          // the workspace from config/sessions is fine, but deleting the directory would break
          // those running/queued tasks mid-flight.
          log.warn("Skipping runtime deletion: checkout is shared by an active sub-agent task", {
            workspaceId,
            workspacePath: persistedWorkspacePath,
          });
        } else {
          const projectPath = metadata.projectPath;
          const runtime = createRuntime(metadata.runtimeConfig, {
            projectPath,
            workspaceName: metadata.name,
            workspacePath: persistedWorkspacePath,
          });

          // Delete workspace from runtime first - if this fails with force=false, we abort
          // and keep workspace in config so user can retry. This prevents orphaned directories.
          const trusted =
            configSnapshot.projects.get(stripTrailingSlashes(projectPath))?.trusted ?? false;
          const deleteResult = await runtime.deleteWorkspace(
            projectPath,
            metadata.name, // use branch name
            force,
            undefined, // abortSignal
            trusted
          );

          if (!deleteResult.success) {
            // If force is true, we continue to remove from config even if fs removal failed
            if (!force) {
              return Err(deleteResult.error ?? "Failed to delete workspace from disk");
            }
            log.error(
              `Failed to delete workspace from disk, but force=true. Removing from config. Error: ${deleteResult.error}`
            );
          }

          // Note: Coder workspace deletion is handled by CoderSSHRuntime.deleteWorkspace()
        }

        // Roll accumulated child timing/usage into the parent only AFTER runtime deletion is
        // committed (every force=false early return is behind us) and BEFORE the session
        // directory (session-timing.json / session-usage.json) is deleted below. rolledUpFrom
        // is a one-shot idempotency guard: rolling up before a failed non-forced deletion left
        // the child usable, and its post-failure spend was permanently skipped by the eventual
        // successful removal. Crash-safety is preserved: a crash between deletion and these
        // rollups keeps config + session files, and retrying removal re-runs deletion (a no-op
        // for an already-missing checkout) before rolling up, so drained spend is not lost.
        // Both producer drains above already ran, so the snapshots read here are complete.
        if (parentWorkspaceId && this.sessionTimingService) {
          try {
            // Flush any last timing write (e.g. from stream-abort) before reading.
            await this.sessionTimingService.waitForIdle(workspaceId);
            await this.sessionTimingService.rollUpTimingIntoParent(parentWorkspaceId, workspaceId);
          } catch (error: unknown) {
            log.error("Failed to roll up child session timing into parent", {
              workspaceId,
              parentWorkspaceId,
              error: getErrorMessage(error),
            });
          }
        }

        if (parentWorkspaceId && this.sessionUsageService) {
          try {
            const childUsage = await this.sessionUsageService.getSessionUsage(workspaceId);
            if (childUsage && Object.keys(childUsage.byModel).length > 0) {
              const rollup = await this.sessionUsageService.rollUpUsageIntoParent(
                parentWorkspaceId,
                workspaceId,
                childUsage.byModel,
                {
                  agentType: metadata.agentType,
                  model: metadata.taskModelString,
                }
              );

              if (rollup.didRollUp) {
                // Live UI update (best-effort): only emit if the parent session is already active.
                this.sessions.get(parentWorkspaceId)?.emitChatEvent({
                  type: "session-usage-delta",
                  workspaceId: parentWorkspaceId,
                  sourceWorkspaceId: workspaceId,
                  byModelDelta: childUsage.byModel,
                  timestamp: Date.now(),
                });
              }
            }
          } catch (error: unknown) {
            log.error("Failed to roll up child session usage into parent", {
              workspaceId,
              parentWorkspaceId,
              error: getErrorMessage(error),
            });
          }
        }
      } else {
        log.error(`Could not find metadata for workspace ${workspaceId}, creating phantom cleanup`);
      }

      // Avoid leaking init waiters/logs after workspace deletion.
      // Must happen before deleting the session directory so queued init-status writes don't
      // recreate ~/.xum/sessions/<workspaceId>/ after removal.
      //
      // Intentionally deferred until we're committed to removal: if runtime deletion fails with
      // force=false we return early and keep init state intact so init-end can refresh metadata.
      this.initStateManager.clearInMemoryState(workspaceId);

      // Dispose the session before deleting its directory: disposal aborts the active stream, and
      // the resulting stream-abort event would otherwise be recorded on the timeline after the
      // delete, recreating the session directory for a workspace the user removed.
      await this.disposeSession(workspaceId);

      // Same for in-flight dream/harvest consolidation (r60): abort + drain
      // before the session directory disappears (idempotent; normally
      // already cancelled before the usage rollup above).
      await this.memoryConsolidationService?.cancelInFlightConsolidation(workspaceId);

      // Cancel and drain any background branch-summary writer BEFORE deleting
      // the session directory: a mid-flight append could otherwise recreate
      // the directory after removal, leaving an orphaned session. This also
      // drops the retained registration a fork that never sent would leak.
      // Normally already drained before the usage rollup above (idempotent);
      // this covers the phantom-metadata path, which skips that block.
      await clearPendingBranchSummary(workspaceId);

      // Same posture for a running /refine pass: abort + drain so its
      // tool-driven memory/skill writes and summary-row append cannot land
      // after the session directory is deleted.
      await this.refinePassCanceller?.cancelInFlightRefinePass(workspaceId);

      // Drop any persistent sandbox mount BEFORE deleting the session
      // directory: dropScope disposes the runtime without disk writes and
      // waits for in-flight evaluation, so a late vars snapshot cannot
      // recreate the directory (and the QuickJS runtime is not leaked in the
      // process-wide singleton).
      await sandboxHostService.dropScope(workspaceId);
      // Plugin hook mounts live under their own scope keys; unregister their
      // spine middleware and drop their runtimes too. Never throws.
      await agentPluginHookService.disposeWorkspace(workspaceId);
      try {
        await this.timelineRecorder.closeWorkspace(workspaceId);
        timelineClosed = true;
      } catch (error: unknown) {
        log.warn("Failed to close the timeline before workspace removal", {
          workspaceId,
          error: getErrorMessage(error),
        });
      }

      await this.drainBashMonitorPersistence(workspaceId);
      await this.bashMonitorHistoryLocks.withLock(workspaceId, () =>
        this.bashMonitorWakeReconciler.dispose(workspaceId)
      );

      // Remove session data
      const sessionDir = path.join(this.config.sessionsDir, workspaceId);
      // r66: identifies THIS removal attempt in the durable tombstone so the
      // compensating rollback below cannot delete a concurrent backend
      // attempt's marker.
      const removalAttemptId = crypto.randomUUID();
      try {
        if (parentWorkspaceId) {
          try {
            const parentSessionDir = path.join(this.config.sessionsDir, parentWorkspaceId);
            await archiveChildSessionArtifactsIntoParentSessionDir({
              parentWorkspaceId,
              parentSessionDir,
              childWorkspaceId: workspaceId,
              childSessionDir: sessionDir,
              childTaskModelString,
              childTaskThinkingLevel,
            });
          } catch (error: unknown) {
            log.error("Failed to roll up child session artifacts into parent", {
              workspaceId,
              parentWorkspaceId,
              error: getErrorMessage(error),
            });
          }
        }

        // r61: serialized with the memory target mutation locks and preceded
        // by a durable removal tombstone (see workspaceRemoval.ts) — a memory
        // write stalled inside its commit either lands before this deletion
        // (and is deleted with the directory) or observes the tombstone under
        // its own lock and refuses, so a late write can never recreate the
        // directory. Fail-closed on a wedged writer: the catch below keeps
        // the directory as a recoverable orphan instead of deleting it out
        // from under a live commit.
        await removeSessionDirUnderMemoryLocks({
          rootDir: this.config.rootDir,
          sessionDir,
          workspaceId,
          attemptId: removalAttemptId,
        });
      } catch (error) {
        // r63: without a durable tombstone the retained orphan stays
        // writable by foreign backends forever — abort the removal (the
        // workspace stays registered and retryable) instead of proceeding
        // to deregistration below.
        if (error instanceof TombstoneNotDurableError) {
          throw error;
        }
        log.error(`Failed to remove session directory for ${workspaceId}:`, error);
      }
      // r65: the tombstone is durable here (both the locked path and the
      // orphan fallback published it). Keep renewing its mtime until this
      // removal settles so a foreign backend's startup self-heal cannot
      // mistake a merely SLOW removal (e.g. a hung MCP server close below)
      // for crash residue and delete the marker while removal is live.
      // Disposal at scope exit (after deregistration or its rollback) is
      // safe: a late renewal of a retained terminal marker is meaningless,
      // and utimes on a rolled-back (deleted) marker is a swallowed ENOENT.
      using _tombstoneLease = startRemovalTombstoneLease(this.config.rootDir, workspaceId);

      // The on-disk devtools.jsonl died with the session directory above; also drop any
      // in-memory DevTools state so stale runs cannot outlive the workspace.
      try {
        await this.devToolsService?.removeWorkspaceData(workspaceId);
      } catch (error) {
        log.debug("Failed to drop DevTools state after workspace removal", {
          workspaceId,
          error: getErrorMessage(error),
        });
      }

      // Stop MCP servers for this workspace
      if (this.mcpServerManager) {
        await this.mcpServerManager.stopServers(workspaceId);
      }

      this.terminalService?.closeWorkspaceSessions(workspaceId);
      await this.closeDesktopSessionBestEffort(workspaceId, "remove");

      // Capture managed roots before the config entry disappears: a worktree
      // under a custom/legacy srcBaseDir cannot be reconstructed afterwards,
      // which would leave its folder entry in the .code-workspace file forever.
      // Best-effort: removal must proceed even when the capture fails.
      let removedMetadata: FrontendWorkspaceMetadata | undefined;
      let removedWorkspaceRoots: Map<string, string[]> | undefined;
      try {
        removedMetadata = (await this.config.getAllWorkspaceMetadata()).find(
          (m) => m.id === workspaceId
        );
        removedWorkspaceRoots = removedMetadata
          ? managedRootsByProject(removedMetadata)
          : undefined;
      } catch (error) {
        log.debug("Failed to capture removed workspace roots for .code-workspace sync", {
          workspaceId,
          error,
        });
      }

      // Remove from config
      try {
        await this.config.removeWorkspace(workspaceId);
      } catch (error) {
        // r62: the session directory and its durable removal tombstone are
        // already committed above. If deregistration fails here (e.g. the
        // config lock timed out), the workspace would survive REGISTERED but
        // permanently tombstoned — every memory mutation refused forever.
        // Un-tombstone so the surviving workspace stays usable (its missing
        // session state self-heals on demand) and removal can be retried.
        // In-process consolidation stays cancelled until restart, matching
        // the drained-producers tradeoff documented above. Ownership-checked
        // (r66): only delete the marker while it still carries THIS
        // attempt's ID and the workspace is still registered — a concurrent
        // backend's removal may have republished or completed with it.
        try {
          await rollbackRemovalTombstoneIfOwned({
            rootDir: this.config.rootDir,
            sessionDir,
            workspaceId,
            attemptId: removalAttemptId,
            workspaceStillRegistered: () => this.config.findWorkspace(workspaceId) != null,
          });
        } catch (rollbackError) {
          // r63: a failed rollback must not be silent — the workspace
          // would stay registered but refused every mutation across
          // restarts. The startup self-heal
          // (healRemovalTombstonesForRegisteredWorkspaces) reclaims this
          // exact residue once the tombstone ages past its guard window.
          log.error(
            "Failed to roll back the removal tombstone after config deregistration failed; " +
              "the startup self-heal will reclaim it",
            { workspaceId, rollbackError }
          );
        }
        this.bashMonitorWakeReconciler.revive(workspaceId);
        throw error;
      }
      removedFromConfig = true;
      this.autoTitlingWorkspaces.delete(workspaceId);

      // Deregistration succeeded: drop the workspace's activity/status entry
      // so extensionMetadata.json stays bounded (stale entries were
      // historically never pruned and grew monotonically, issue #3959).
      await this.discardExtensionMetadataEntry(workspaceId);

      if (removedMetadata || persistedWorkspace) {
        await this.syncCodeWorkspaceFiles(
          removedMetadata ?? {
            projectPath: persistedWorkspace!.projectPath,
            projects: persistedWorkspace!.projects,
          },
          removedWorkspaceRoots
        );
      }

      this.emit("metadata", {
        workspaceId,
        metadata: null,
        ...(parentWorkspaceId ? { removedParentWorkspaceId: parentWorkspaceId } : {}),
      });

      return Ok(undefined);
    } catch (error) {
      // An abort before the workspace left the config leaves it usable, so undo the timeline close:
      // otherwise every later event for it would be dropped for the rest of the process.
      if (timelineClosed && !removedFromConfig) {
        this.timelineRecorder.reopenWorkspace(workspaceId);
      }
      const message = getErrorMessage(error);
      return Err(`Failed to remove workspace: ${message}`);
    } finally {
      if (releaseOverridesLock !== undefined) {
        try {
          await releaseOverridesLock();
        } catch (error) {
          log.debug("Failed to release the MCP overrides lock after workspace removal", {
            workspaceId,
            error: getErrorMessage(error),
          });
        }
      }
      for (const hold of admissionHolds) {
        hold[Symbol.dispose]();
      }
      this.removingWorkspaces.delete(workspaceId);
    }
  }

  /**
   * Best-effort .code-workspace reconcile for every project involved in a
   * workspace lifecycle change (multi-project workspaces touch several).
   * syncProjectCodeWorkspace never throws, so lifecycle ops cannot fail here.
   */
  private async syncCodeWorkspaceFiles(
    workspace: {
      projectPath: string;
      projects?: ReadonlyArray<{ projectPath: string }>;
      subProjectPath?: string;
    },
    extraManagedRootDirsByProject?: ReadonlyMap<string, string[]>
  ): Promise<void> {
    const involvedPaths = new Set([
      workspace.projectPath,
      // A registered sub-project's file lists workspaces assigned to it even
      // though they live in the parent's bucket.
      ...(workspace.subProjectPath != null ? [workspace.subProjectPath] : []),
      ...(workspace.projects ?? []).map((ref) => ref.projectPath),
    ]);
    for (const involvedPath of involvedPaths) {
      await syncProjectCodeWorkspace(this.config, involvedPath, {
        // Extras are scoped per project so one project's file never gains
        // removal rights under another project's root.
        extraManagedRootDirs: extraManagedRootDirsByProject?.get(
          stripTrailingSlashes(involvedPath)
        ),
      });
    }
  }

  private enrichFrontendMetadata(metadata: FrontendWorkspaceMetadata): FrontendWorkspaceMetadata {
    const isInitializing =
      this.initStateManager.getInitState(metadata.id)?.status === "running" || undefined;
    return {
      ...metadata,
      isRemoving: this.removingWorkspaces.has(metadata.id) || undefined,
      isInitializing,
    };
  }

  private isMultiProjectWorkspacesExperimentEnabled(): boolean {
    return (
      this.experimentsService?.isExperimentEnabled(EXPERIMENT_IDS.MULTI_PROJECT_WORKSPACES) ?? false
    );
  }

  private shouldExposeWorkspaceMetadata(
    metadata: WorkspaceMetadata | FrontendWorkspaceMetadata
  ): boolean {
    return this.isMultiProjectWorkspacesExperimentEnabled() || !isMultiProject(metadata);
  }

  private filterVisibleWorkspaceMetadata<T extends WorkspaceMetadata | FrontendWorkspaceMetadata>(
    workspaces: readonly T[]
  ): T[] {
    if (this.isMultiProjectWorkspacesExperimentEnabled()) {
      return [...workspaces];
    }

    // Keep persisted _multi config intact and hide it only at workspace-facing service boundaries.
    return workspaces.filter((workspace) => this.shouldExposeWorkspaceMetadata(workspace));
  }

  private enrichMaybeFrontendMetadata(
    metadata: FrontendWorkspaceMetadata | null
  ): FrontendWorkspaceMetadata | null {
    if (!metadata) {
      return null;
    }
    return this.enrichFrontendMetadata(metadata);
  }

  async list(): Promise<FrontendWorkspaceMetadata[]> {
    try {
      const workspaces = await this.config.getAllWorkspaceMetadata();
      return this.filterVisibleWorkspaceMetadata(workspaces).map((workspace) =>
        this.enrichFrontendMetadata(workspace)
      );
    } catch (error) {
      log.error("Failed to list workspaces:", error);
      return [];
    }
  }

  async listByArchivedStatus(archived: boolean): Promise<FrontendWorkspaceMetadata[]> {
    const workspaces = await this.list();
    return workspaces.filter(
      (workspace) => isWorkspaceArchived(workspace.archivedAt, workspace.unarchivedAt) === archived
    );
  }

  // Devcontainer Docker labels are keyed by the exact host worktree path from startup, so stop/status
  // APIs must prefer the persisted config path and only fall back to canonical reconstruction if the
  // config entry is missing.
  private async getDevcontainerHostWorkspacePath(workspaceId: string): Promise<string> {
    const workspace = this.config.findWorkspace(workspaceId);
    if (workspace) {
      return workspace.workspacePath;
    }

    const metadataResult = await this.aiService.getWorkspaceMetadata(workspaceId);
    if (!metadataResult.success) {
      throw new Error(metadataResult.error);
    }

    const metadata = metadataResult.data;
    const hostRuntime = new WorktreeRuntime(this.config.srcDir, {
      projectPath: metadata.projectPath,
      workspaceName: metadata.name,
    });
    return hostRuntime.getWorkspacePath(metadata.projectPath, metadata.name);
  }

  /**
   * Get devcontainer info for deep link generation.
   * Returns null if not a devcontainer workspace or container is not running.
   *
   * This queries Docker for the container name (on-demand discovery) and
   * calls ensureReady to get the container workspace path.
   */
  async getDevcontainerInfo(workspaceId: string): Promise<{
    containerName: string;
    containerWorkspacePath: string;
    hostWorkspacePath: string;
  } | null> {
    const metadata = await this.getInfo(workspaceId);
    if (metadata?.runtimeConfig?.type !== "devcontainer") {
      return null;
    }

    const workspace = this.config.findWorkspace(workspaceId);
    if (!workspace) {
      return null;
    }

    const runtimeConfig = metadata.runtimeConfig;
    const runtime = createRuntime(runtimeConfig, {
      projectPath: metadata.projectPath,
      workspaceName: metadata.name,
      workspacePath: workspace.workspacePath,
    });

    const hostWorkspacePath = workspace.workspacePath;

    // Query Docker for container name (on-demand discovery)
    const containerName = await getDevcontainerContainerName(hostWorkspacePath);
    if (!containerName) {
      return null; // Container not running
    }

    // Get container workspace path via ensureReady (idempotent if already running)
    const readyResult = await runtime.ensureReady();
    if (!readyResult.ready) {
      return null;
    }

    // Access the cached remoteWorkspaceFolder from DevcontainerRuntime
    const devRuntime = runtime as DevcontainerRuntime;
    const containerWorkspacePath = devRuntime.getRemoteWorkspaceFolder();
    if (!containerWorkspacePath) {
      return null;
    }

    return { containerName, containerWorkspacePath, hostWorkspacePath };
  }
  async getInfo(workspaceId: string): Promise<FrontendWorkspaceMetadata | null> {
    const allMetadata = await this.config.getAllWorkspaceMetadata();
    const found = allMetadata.find((metadata) => metadata.id === workspaceId) ?? null;
    if (found && !this.shouldExposeWorkspaceMetadata(found)) {
      return null;
    }
    return this.enrichMaybeFrontendMetadata(found);
  }

  private resolveHeartbeatWorkspaceEntry(
    workspaceId: string,
    methodName: "getHeartbeatSettings" | "setHeartbeatSettings" | "unsetHeartbeatSettings"
  ): Result<HeartbeatWorkspaceConfigEntry, string> {
    const normalizedWorkspaceId = workspaceId.trim();
    assert(normalizedWorkspaceId.length > 0, `${methodName} requires a non-empty workspaceId`);

    const found = this.config.findWorkspace(normalizedWorkspaceId);
    if (!found) {
      return Err("Workspace not found");
    }

    const config = this.config.loadConfigOrDefault();
    const projectConfig = config.projects.get(found.projectPath);
    if (!projectConfig) {
      return Err(`Project not found: ${found.projectPath}`);
    }

    const workspaceEntry =
      projectConfig.workspaces.find((workspace) => workspace.id === normalizedWorkspaceId) ??
      projectConfig.workspaces.find((workspace) => workspace.path === found.workspacePath);
    if (!workspaceEntry) {
      return Err("Workspace not found");
    }

    return Ok({
      normalizedWorkspaceId,
      projectPath: found.projectPath,
      workspacePath: found.workspacePath,
      config,
      workspaceEntry,
    });
  }

  /**
   * Re-resolve a workspace entry from a FRESH config snapshot inside an editConfig
   * transform. Mutating a pre-read snapshot entry and persisting that snapshot was a
   * lost-update race: a stale full-config write racing removeWorkspace() resurrected
   * the removed entry as a permanent sidebar ghost. All config mutations must re-find
   * their target entry here (or equivalent) inside the serialized transform.
   */
  private findFreshWorkspaceEntry(
    config: ProjectsConfig,
    target: { projectPath: string; workspaceId: string; workspacePath: string }
  ): Workspace | undefined {
    const projectConfig = config.projects.get(target.projectPath);
    return (
      projectConfig?.workspaces.find((workspace) => workspace.id === target.workspaceId) ??
      // Path fallback is for legacy entries that predate stable IDs only. A path match
      // that carries a DIFFERENT id is a replacement workspace (paths are reusable after
      // deletion) — treat the original entry as gone rather than leaking the stale
      // settings write into the fresh workspace.
      projectConfig?.workspaces.find(
        (workspace) => workspace.path === target.workspacePath && !workspace.id
      )
    );
  }

  getHeartbeatSettings(workspaceId: string): WorkspaceHeartbeatSettings | null {
    const resolved = this.resolveHeartbeatWorkspaceEntry(workspaceId, "getHeartbeatSettings");
    if (!resolved.success) {
      return null;
    }

    const defaultIntervalMs = this.getHeartbeatDefaultIntervalMsFromConfig(resolved.data.config);
    return normalizeHeartbeatSettings(resolved.data.workspaceEntry.heartbeat, defaultIntervalMs);
  }

  private getHeartbeatDefaultIntervalMsFromConfig(config: ProjectsConfig): number {
    const intervalMs = config.heartbeatDefaultIntervalMs ?? HEARTBEAT_DEFAULT_INTERVAL_MS;
    assert(
      Number.isInteger(intervalMs) &&
        intervalMs >= HEARTBEAT_MIN_INTERVAL_MS &&
        intervalMs <= HEARTBEAT_MAX_INTERVAL_MS,
      "Configured heartbeat default interval must be within supported bounds"
    );
    return intervalMs;
  }

  async unsetHeartbeatSettings(workspaceId: string): Promise<Result<void, string>> {
    try {
      const resolved = this.resolveHeartbeatWorkspaceEntry(workspaceId, "unsetHeartbeatSettings");
      if (!resolved.success) {
        return Err(resolved.error);
      }

      const { normalizedWorkspaceId, projectPath, workspacePath } = resolved.data;
      if (!resolved.data.workspaceEntry.heartbeat) {
        return Ok(undefined);
      }

      // Mutate inside the serialized editConfig transform, re-finding the entry from
      // fresh config (see findFreshWorkspaceEntry). Entry gone meanwhile means the
      // workspace was removed concurrently — unset is then trivially satisfied.
      let removedHeartbeat = false;
      await this.config.editConfig((freshConfig) => {
        const entry = this.findFreshWorkspaceEntry(freshConfig, {
          projectPath,
          workspaceId: normalizedWorkspaceId,
          workspacePath,
        });
        if (entry?.heartbeat) {
          delete entry.heartbeat;
          removedHeartbeat = true;
        }
        return freshConfig;
      });
      if (!removedHeartbeat) {
        return Ok(undefined);
      }

      const interactionTimestamp = Date.now();
      await this.updateRecencyTimestamp(normalizedWorkspaceId, interactionTimestamp);
      await this.emitCurrentWorkspaceMetadata(normalizedWorkspaceId);
      this.timelineRecorder.record(normalizedWorkspaceId, {
        kind: "heartbeat.configured",
        source: { system: "heartbeat" },
        status: "completed",
        data: { digest: HEARTBEAT_REMOVED_SUMMARY },
      });

      return Ok(undefined);
    } catch (error) {
      const message = getErrorMessage(error);
      return Err(`Failed to unset heartbeat settings: ${message}`);
    }
  }

  async setHeartbeatSettings(
    workspaceId: string,
    settings: WorkspaceHeartbeatSettingsUpdate
  ): Promise<Result<WorkspaceHeartbeatSettings, string>> {
    try {
      assert(
        settings != null && typeof settings === "object",
        "setHeartbeatSettings requires settings"
      );

      const hasEnabledUpdate = Object.prototype.hasOwnProperty.call(settings, "enabled");
      assert(
        !hasEnabledUpdate || typeof settings.enabled === "boolean",
        "Heartbeat enabled flag must be a boolean when provided"
      );
      const hasIntervalUpdate = Object.prototype.hasOwnProperty.call(settings, "intervalMs");
      assert(
        !hasIntervalUpdate || Number.isInteger(settings.intervalMs),
        "Heartbeat interval must be an integer when provided"
      );
      assert(
        !hasIntervalUpdate ||
          (settings.intervalMs! >= HEARTBEAT_MIN_INTERVAL_MS &&
            settings.intervalMs! <= HEARTBEAT_MAX_INTERVAL_MS),
        `Heartbeat interval must be between ${HEARTBEAT_MIN_INTERVAL_MS} and ${HEARTBEAT_MAX_INTERVAL_MS} ms`
      );
      const hasMessageUpdate = Object.prototype.hasOwnProperty.call(settings, "message");
      assert(
        !hasMessageUpdate || settings.message == null || typeof settings.message === "string",
        "Heartbeat message must be a string when provided"
      );
      const hasContextModeUpdate = Object.prototype.hasOwnProperty.call(settings, "contextMode");
      assert(
        !hasContextModeUpdate ||
          settings.contextMode == null ||
          isHeartbeatContextMode(settings.contextMode),
        "Heartbeat context mode must be a supported value when provided"
      );
      const hasTriggerUpdate = Object.prototype.hasOwnProperty.call(settings, "trigger");
      assert(
        !hasTriggerUpdate || settings.trigger == null || isHeartbeatTrigger(settings.trigger),
        "Heartbeat trigger must be a supported value when provided"
      );
      const hasWhenBusyUpdate = Object.prototype.hasOwnProperty.call(settings, "whenBusy");
      assert(
        !hasWhenBusyUpdate || settings.whenBusy == null || isHeartbeatWhenBusy(settings.whenBusy),
        "Heartbeat whenBusy must be a supported value when provided"
      );

      const resolved = this.resolveHeartbeatWorkspaceEntry(workspaceId, "setHeartbeatSettings");
      if (!resolved.success) {
        return Err(resolved.error);
      }

      const { normalizedWorkspaceId, projectPath, workspacePath } = resolved.data;
      const interactionTimestamp = Date.now();
      // Merge with the FRESH entry inside the serialized editConfig transform (not the
      // pre-read snapshot): merging against a stale entry could silently drop a concurrent
      // heartbeat edit, and persisting the stale snapshot could resurrect concurrently
      // removed workspaces (lost-update race). Entry gone meanwhile → Err.
      let mergeResult: Result<{ settings: WorkspaceHeartbeatSettings; changed: boolean }, string> =
        Err("Workspace not found");
      await this.config.editConfig((freshConfig) => {
        const workspaceEntry = this.findFreshWorkspaceEntry(freshConfig, {
          projectPath,
          workspaceId: normalizedWorkspaceId,
          workspacePath,
        });
        if (!workspaceEntry) {
          mergeResult = Err("Workspace not found");
          return freshConfig;
        }

        const defaultIntervalMs = this.getHeartbeatDefaultIntervalMsFromConfig(freshConfig);
        const currentSettings = normalizeHeartbeatSettings(
          workspaceEntry.heartbeat,
          defaultIntervalMs
        );
        const nextMessage = hasMessageUpdate
          ? sanitizeHeartbeatMessage(settings.message)
          : currentSettings?.message;
        // trigger/whenBusy mirror the `message` pattern (not `contextMode`): a present key with
        // null clears back to unset, an absent key preserves, and unset is never materialized
        // into config so read-time defaulting stays intact (see resolveHeartbeatSchedulePolicy).
        const nextTrigger = hasTriggerUpdate
          ? (settings.trigger ?? undefined)
          : currentSettings?.trigger;
        const nextWhenBusy = hasWhenBusyUpdate
          ? (settings.whenBusy ?? undefined)
          : currentSettings?.whenBusy;
        const nextEnabled = hasEnabledUpdate
          ? settings.enabled!
          : (currentSettings?.enabled ?? true);
        const nextIntervalMs = hasIntervalUpdate
          ? settings.intervalMs!
          : (currentSettings?.intervalMs ?? defaultIntervalMs);
        // Server-managed cadence-edit stamp: fixed-interval restart anchoring uses
        // max(last persisted firing, scheduleUpdatedAt), so a heartbeat fired under the
        // previous schedule cannot bypass this edit (HeartbeatService's
        // deriveInitialIntervalNextEligibleAt). Only cadence-affecting fields count —
        // resolved trigger, not raw, so an explicit no-op like null→"idle" does not
        // re-anchor (mirroring ensureTrackedWorkspace's live re-anchor conditions).
        const cadenceChanged =
          currentSettings?.enabled !== nextEnabled ||
          currentSettings?.intervalMs !== nextIntervalMs ||
          resolveHeartbeatSchedulePolicy(currentSettings ?? undefined).trigger !==
            resolveHeartbeatSchedulePolicy({ trigger: nextTrigger, whenBusy: nextWhenBusy })
              .trigger;
        const nextScheduleUpdatedAt = cadenceChanged
          ? interactionTimestamp
          : currentSettings?.scheduleUpdatedAt;
        // Keep the interval on disk even when disabled so re-enabling restores the user's choice.
        const nextSettings: WorkspaceHeartbeatSettings = {
          enabled: nextEnabled,
          intervalMs: nextIntervalMs,
          contextMode: hasContextModeUpdate
            ? sanitizeHeartbeatContextMode(settings.contextMode)
            : (currentSettings?.contextMode ?? HEARTBEAT_DEFAULT_CONTEXT_MODE),
          ...(nextMessage != null ? { message: nextMessage } : {}),
          ...(nextTrigger != null ? { trigger: nextTrigger } : {}),
          ...(nextWhenBusy != null ? { whenBusy: nextWhenBusy } : {}),
          ...(nextScheduleUpdatedAt != null ? { scheduleUpdatedAt: nextScheduleUpdatedAt } : {}),
        };

        const changed =
          workspaceEntry.heartbeat?.enabled !== nextSettings.enabled ||
          workspaceEntry.heartbeat?.intervalMs !== nextSettings.intervalMs ||
          workspaceEntry.heartbeat?.message !== nextSettings.message ||
          sanitizeHeartbeatContextMode(workspaceEntry.heartbeat?.contextMode) !==
            nextSettings.contextMode ||
          (workspaceEntry.heartbeat?.trigger ?? undefined) !== nextSettings.trigger ||
          (workspaceEntry.heartbeat?.whenBusy ?? undefined) !== nextSettings.whenBusy;
        if (!changed) {
          mergeResult = Ok({ settings: nextSettings, changed: false });
          return freshConfig;
        }

        workspaceEntry.heartbeat = nextSettings;
        mergeResult = Ok({ settings: nextSettings, changed: true });
        return freshConfig;
      });

      if (!mergeResult.success) {
        return Err(mergeResult.error);
      }
      if (!mergeResult.data.changed) {
        return Ok(mergeResult.data.settings);
      }

      // Changing heartbeat settings is a real user interaction. Persist that recency before
      // emitting metadata so restarts preserve the post-config-change first-fire deadline
      // instead of rebuilding from an older completed turn.
      await this.updateRecencyTimestamp(normalizedWorkspaceId, interactionTimestamp);
      await this.emitCurrentWorkspaceMetadata(normalizedWorkspaceId);
      // Recorded here rather than in the heartbeat tool so sidebar edits are on the record too.
      this.timelineRecorder.record(normalizedWorkspaceId, {
        kind: "heartbeat.configured",
        source: { system: "heartbeat" },
        status: "completed",
        data: { digest: summarizeHeartbeatSettings(mergeResult.data.settings) },
      });

      return Ok(mergeResult.data.settings);
    } catch (error) {
      const message = getErrorMessage(error);
      return Err(`Failed to set heartbeat settings: ${message}`);
    }
  }

  /**
   * Read the per-workspace goal-defaults override.
   *
   * Returns `null` when this workspace has no override (callers should fall
   * back to `appConfig.goalDefaults`). The override is *sparse*: each field
   * is independently nullable so a workspace can pin (e.g.) a custom budget
   * without also overriding the turn cap.
   */
  getWorkspaceGoalDefaults(workspaceId: string): WorkspaceGoalDefaultsOverride | null {
    const normalizedWorkspaceId = workspaceId.trim();
    assert(
      normalizedWorkspaceId.length > 0,
      "getWorkspaceGoalDefaults requires a non-empty workspaceId"
    );

    const found = this.config.findWorkspace(normalizedWorkspaceId);
    if (!found) {
      return null;
    }

    const config = this.config.loadConfigOrDefault();
    const projectConfig = config.projects.get(found.projectPath);
    const workspaceEntry =
      projectConfig?.workspaces.find((workspace) => workspace.id === normalizedWorkspaceId) ??
      projectConfig?.workspaces.find((workspace) => workspace.path === found.workspacePath);
    const override = workspaceEntry?.goalDefaults;
    if (!override) {
      return null;
    }
    // Normalize sparse shape: each field defaults to null when absent so
    // the frontend can treat "missing" and "explicitly inherit" identically.
    return {
      defaultBudgetCents: override.defaultBudgetCents ?? null,
      defaultTurnCap: override.defaultTurnCap ?? null,
      alwaysRequireExplicitBudget: override.alwaysRequireExplicitBudget ?? null,
    };
  }

  /**
   * Write the per-workspace goal-defaults override.
   *
   * `null` fields mean "follow the global default" — when *every* field is
   * null, the entire override is dropped from `~/.xum/config.json` so the
   * workspace is indistinguishable from never having had one. Modeled on
   * `setHeartbeatSettings` so consumers re-fetch via the existing workspace
   * metadata subscription.
   */
  async setWorkspaceGoalDefaults(
    workspaceId: string,
    override: WorkspaceGoalDefaultsOverride
  ): Promise<Result<void, string>> {
    try {
      const normalizedWorkspaceId = workspaceId.trim();
      assert(
        normalizedWorkspaceId.length > 0,
        "setWorkspaceGoalDefaults requires a non-empty workspaceId"
      );

      const defaultBudgetCents = override.defaultBudgetCents;
      assert(
        defaultBudgetCents == null ||
          (Number.isInteger(defaultBudgetCents) && defaultBudgetCents >= 0),
        "Goal default budget must be a non-negative integer or null"
      );
      const defaultTurnCap = override.defaultTurnCap;
      assert(
        defaultTurnCap == null || (Number.isInteger(defaultTurnCap) && defaultTurnCap > 0),
        "Goal default turn cap must be a positive integer or null"
      );
      assert(
        override.alwaysRequireExplicitBudget == null ||
          typeof override.alwaysRequireExplicitBudget === "boolean",
        "alwaysRequireExplicitBudget must be a boolean or null"
      );

      const found = this.config.findWorkspace(normalizedWorkspaceId);
      if (!found) {
        return Err("Workspace not found");
      }

      const { projectPath, workspacePath } = found;

      // Drop the whole record when every field is null — keeps the
      // config.json minimal and makes "no override" the canonical state
      // that resolves to global defaults.
      const allNull =
        override.defaultBudgetCents == null &&
        override.defaultTurnCap == null &&
        override.alwaysRequireExplicitBudget == null;

      // No-op fast path from a snapshot read: skip the queued write entirely when the
      // override already matches. Race-safe — equivalent to a serialized write of the
      // identical value landing first, and skipping cannot resurrect removed entries.
      {
        const snapshotEntry = this.findFreshWorkspaceEntry(this.config.loadConfigOrDefault(), {
          projectPath,
          workspaceId: normalizedWorkspaceId,
          workspacePath,
        });
        const prior = snapshotEntry?.goalDefaults;
        if (snapshotEntry && allNull && prior == null) {
          return Ok(undefined);
        }
        if (
          snapshotEntry &&
          !allNull &&
          prior != null &&
          (prior.defaultBudgetCents ?? null) === (override.defaultBudgetCents ?? null) &&
          (prior.defaultTurnCap ?? null) === (override.defaultTurnCap ?? null) &&
          (prior.alwaysRequireExplicitBudget ?? null) ===
            (override.alwaysRequireExplicitBudget ?? null)
        ) {
          return Ok(undefined);
        }
      }

      // Compare against the FRESH entry inside the serialized editConfig transform
      // (see findFreshWorkspaceEntry): persisting a pre-read snapshot loses concurrent
      // edits and can resurrect removed workspaces. Entry gone meanwhile → Err.
      let writeResult: Result<{ changed: boolean }, string> = Err("Workspace not found");
      await this.config.editConfig((freshConfig) => {
        const workspaceEntry = this.findFreshWorkspaceEntry(freshConfig, {
          projectPath,
          workspaceId: normalizedWorkspaceId,
          workspacePath,
        });
        if (!workspaceEntry) {
          writeResult = Err("Workspace not found");
          return freshConfig;
        }

        const prior = workspaceEntry.goalDefaults;
        if (allNull) {
          if (prior == null) {
            writeResult = Ok({ changed: false });
            return freshConfig;
          }
          delete workspaceEntry.goalDefaults;
        } else {
          const next: WorkspaceGoalDefaultsOverride = {
            defaultBudgetCents: override.defaultBudgetCents ?? null,
            defaultTurnCap: override.defaultTurnCap ?? null,
            alwaysRequireExplicitBudget: override.alwaysRequireExplicitBudget ?? null,
          };
          const unchanged =
            prior != null &&
            (prior.defaultBudgetCents ?? null) === next.defaultBudgetCents &&
            (prior.defaultTurnCap ?? null) === next.defaultTurnCap &&
            (prior.alwaysRequireExplicitBudget ?? null) === next.alwaysRequireExplicitBudget;
          if (unchanged) {
            writeResult = Ok({ changed: false });
            return freshConfig;
          }
          workspaceEntry.goalDefaults = next;
        }

        writeResult = Ok({ changed: true });
        return freshConfig;
      });

      if (!writeResult.success) {
        return Err(writeResult.error);
      }
      if (!writeResult.data.changed) {
        return Ok(undefined);
      }
      await this.emitCurrentWorkspaceMetadata(normalizedWorkspaceId);
      return Ok(undefined);
    } catch (error) {
      const message = getErrorMessage(error);
      return Err(`Failed to set workspace goal defaults: ${message}`);
    }
  }

  /**
   * Refresh workspace metadata from config and emit to subscribers.
   * Useful when external changes (like section assignment) modify workspace config.
   */
  async refreshAndEmitMetadata(workspaceId: string): Promise<void> {
    const metadata = await this.getInfo(workspaceId);
    if (metadata) {
      this.emit("metadata", { workspaceId, metadata });
    }
  }

  async rename(workspaceId: string, newName: string): Promise<Result<{ newWorkspaceId: string }>> {
    let releaseOverridesLock: (() => Promise<void>) | undefined;
    try {
      if (this.shuttingDown) return Err("Server is shutting down");
      if (this.aiService.isStreaming(workspaceId)) {
        return Err(
          "Cannot rename workspace while AI stream is active. Please wait for the stream to complete."
        );
      }

      const validation = validateWorkspaceName(newName);
      if (!validation.valid) {
        return Err(validation.error ?? "Invalid workspace name");
      }

      // Mark workspace as renaming to block new streams during the rename operation
      this.renamingWorkspaces.add(workspaceId);

      const metadataResult = await this.aiService.getWorkspaceMetadata(workspaceId);
      if (!metadataResult.success) {
        return Err(`Failed to get workspace metadata: ${metadataResult.error}`);
      }
      const oldMetadata = metadataResult.data;
      const oldName = oldMetadata.name;

      if (newName === oldName) {
        return Ok({ newWorkspaceId: workspaceId });
      }

      const allWorkspaces = await this.config.getAllWorkspaceMetadata();
      const collision = allWorkspaces.find(
        (ws) => (ws.name === newName || ws.id === newName) && ws.id !== workspaceId
      );
      if (collision) {
        return Err(`Workspace with name "${newName}" already exists`);
      }

      const workspace = this.config.findWorkspace(workspaceId);
      if (!workspace) {
        return Err("Failed to find workspace in config");
      }
      const { projectPath: configProjectPath } = workspace;
      const configSnapshot = this.config.loadConfigOrDefault();

      // Hold THIS workspace's MCP-overrides lock across the checkout move AND
      // the config rewrite below, for every runtime. Every writer of the
      // workspace's override document takes the same lock before the global
      // write lock: the Agent Plugin override prune (host-local checkouts)
      // would otherwise stat the vacated old path, find nothing, and retire a
      // cleanup tombstone while the moved .xum/mcp.local.jsonc still holds the
      // plugin key; and an MCP settings save (any runtime) that passed its
      // revision check on the old path would write its disable into a
      // recreated old path after the move while the renamed checkout keeps
      // the prior enable. The lock is scoped to this workspace, so a slow
      // remote move never blocks unrelated workspaces' settings saves; the
      // lease is re-stamped while held, so a long hold is never reclaimed as
      // stale.
      releaseOverridesLock =
        await this.workspaceMcpOverridesService?.acquireWorkspaceLock(workspaceId);

      let oldPath: string;
      let newPath: string;
      let runtimeForPlanFile: ReturnType<typeof createRuntime>;

      if (isMultiProject(oldMetadata)) {
        const projects = getProjects(oldMetadata);
        const primaryProject = projects[0];
        assert(primaryProject, "Multi-project workspace requires a primary project");
        const renamedProjectWorkspaces: Array<{
          projectName: string;
          projectPath: string;
          oldWorkspacePath: string;
          newWorkspacePath: string;
        }> = [];

        const rollbackRenamedProjects = async (): Promise<void> => {
          // Roll back already-renamed project workspaces to avoid leaving mixed workspace names.
          for (const renamedProject of [...renamedProjectWorkspaces].reverse()) {
            try {
              const rollbackRuntime = createRuntime(oldMetadata.runtimeConfig, {
                projectPath: renamedProject.projectPath,
                workspaceName: newName,
                workspacePath: renamedProject.newWorkspacePath,
              });
              const rollbackTrusted =
                configSnapshot.projects.get(stripTrailingSlashes(renamedProject.projectPath))
                  ?.trusted ?? false;
              const rollbackResult = await rollbackRuntime.renameWorkspace(
                renamedProject.projectPath,
                newName,
                oldName,
                undefined,
                rollbackTrusted
              );

              if (!rollbackResult.success) {
                log.error("Failed to rollback multi-project rename", {
                  workspaceId,
                  projectName: renamedProject.projectName,
                  error: rollbackResult.error,
                });
              }
            } catch (rollbackError: unknown) {
              log.error("Failed to rollback multi-project rename", {
                workspaceId,
                projectName: renamedProject.projectName,
                error: getErrorMessage(rollbackError),
              });
            }
          }
        };

        for (const project of projects) {
          const runtime = createRuntime(oldMetadata.runtimeConfig, {
            projectPath: project.projectPath,
            workspaceName: oldName,
            workspacePath: getWorkspacePathHintForProject(
              {
                workspaceId,
                workspaceName: oldName,
                workspacePath: workspace.workspacePath,
                runtimeConfig: oldMetadata.runtimeConfig,
                projectPath: oldMetadata.projectPath,
                projectName: oldMetadata.projectName,
                projects: oldMetadata.projects,
              },
              project.projectPath
            ),
          });

          const trusted =
            configSnapshot.projects.get(stripTrailingSlashes(project.projectPath))?.trusted ??
            false;
          const renameResult = await runtime.renameWorkspace(
            project.projectPath,
            oldName,
            newName,
            undefined,
            trusted
          );

          if (!renameResult.success) {
            await rollbackRenamedProjects();
            return Err(
              `Failed to rename workspace for project ${project.projectName}: ${renameResult.error}`
            );
          }

          renamedProjectWorkspaces.push({
            projectName: project.projectName,
            projectPath: project.projectPath,
            oldWorkspacePath: renameResult.oldPath,
            newWorkspacePath: renameResult.newPath,
          });
        }

        const containerManager = new ContainerManager(
          getSrcBaseDir(oldMetadata.runtimeConfig) ?? this.config.srcDir
        );
        const oldContainerPath = containerManager.getContainerPath(oldName);
        const newContainerPath = containerManager.getContainerPath(newName);

        let newContainerExistedBeforeRename = false;
        try {
          await fsPromises.access(newContainerPath);
          newContainerExistedBeforeRename = true;
        } catch {
          newContainerExistedBeforeRename = false;
        }

        try {
          await containerManager.removeContainer(oldName);
          await containerManager.createContainer(
            newName,
            renamedProjectWorkspaces.map((workspaceEntry) => ({
              projectName: workspaceEntry.projectName,
              workspacePath: workspaceEntry.newWorkspacePath,
            }))
          );
        } catch (containerError: unknown) {
          await rollbackRenamedProjects();

          if (!newContainerExistedBeforeRename) {
            try {
              await containerManager.removeContainer(newName);
            } catch (cleanupErr: unknown) {
              log.error("Failed to remove partially created new container after rename failure", {
                workspaceId,
                workspaceName: newName,
                error: getErrorMessage(cleanupErr),
              });
            }
          }

          // Recreate the old container from the per-project paths returned by the rename
          // calls so rollback never reuses the primary project's runtime for sibling links.
          try {
            const originalWorkspaces = projects.map((project) => {
              const renamedWorkspaceEntry = renamedProjectWorkspaces.find(
                (workspaceEntry) => workspaceEntry.projectPath === project.projectPath
              );
              assert(
                renamedWorkspaceEntry,
                "Expected renamed workspace entry while recreating old container after rollback"
              );

              return {
                projectName: project.projectName,
                workspacePath: renamedWorkspaceEntry.oldWorkspacePath,
              };
            });
            await fsPromises.mkdir(oldContainerPath, { recursive: true });
            for (const workspaceEntry of originalWorkspaces) {
              const linkPath = path.join(oldContainerPath, workspaceEntry.projectName);
              await fsPromises.access(workspaceEntry.workspacePath);
              await fsPromises.symlink(workspaceEntry.workspacePath, linkPath);
            }
          } catch (recreateErr: unknown) {
            log.error("Failed to recreate old container after rename failure", recreateErr);
          }

          return Err(`Failed to recreate container: ${getErrorMessage(containerError)}`);
        }

        // Multi-project tasks/forks stored under a real project must keep their git-root path in
        // config so downstream artifact collection can resolve the owning repo after rename.
        const persistedWorkspacePath =
          configProjectPath === MULTI_PROJECT_CONFIG_KEY
            ? undefined
            : (renamedProjectWorkspaces.find(
                (workspaceEntry) => workspaceEntry.projectPath === configProjectPath
              ) ??
              renamedProjectWorkspaces.find(
                (workspaceEntry) => workspaceEntry.projectPath === primaryProject.projectPath
              ));
        assert(
          configProjectPath === MULTI_PROJECT_CONFIG_KEY || persistedWorkspacePath,
          "Expected multi-project rename to preserve the config project's workspace path"
        );
        oldPath = persistedWorkspacePath?.oldWorkspacePath ?? oldContainerPath;
        newPath = persistedWorkspacePath?.newWorkspacePath ?? newContainerPath;

        runtimeForPlanFile = createRuntime(oldMetadata.runtimeConfig, {
          projectPath: primaryProject.projectPath,
          workspaceName: newName,
        });
      } else {
        const runtime = createRuntime(oldMetadata.runtimeConfig, {
          projectPath: configProjectPath,
          workspaceName: oldName,
          workspacePath: workspace.workspacePath,
        });

        const trusted =
          configSnapshot.projects.get(stripTrailingSlashes(configProjectPath))?.trusted ?? false;
        const renameResult = await runtime.renameWorkspace(
          configProjectPath,
          oldName,
          newName,
          undefined, // abortSignal
          trusted
        );

        if (!renameResult.success) {
          return Err(renameResult.error);
        }

        oldPath = renameResult.oldPath;
        newPath = renameResult.newPath;
        runtimeForPlanFile = runtime;
      }

      await this.config.editConfig((config) => {
        const projectConfig = config.projects.get(configProjectPath);
        if (projectConfig) {
          const workspaceEntry =
            projectConfig.workspaces.find((w) => w.id === workspaceId) ??
            projectConfig.workspaces.find((w) => w.path === oldPath);
          if (workspaceEntry) {
            workspaceEntry.name = newName;
            workspaceEntry.path = newPath;
          }
        }
        return config;
      });
      // Checkout and config agree again: let MCP-settings writers proceed
      // instead of queueing behind plan-file moves and .code-workspace sync.
      const releaseNow = releaseOverridesLock;
      releaseOverridesLock = undefined;
      await releaseNow?.().catch((error: unknown) => {
        // The rename itself is complete; a lock-file cleanup failure must not
        // report it as failed. The lease simply ages out for other holders.
        log.warn("Failed to release MCP-overrides lock after rename", {
          workspaceId,
          error: getErrorMessage(error),
        });
      });

      // Rename plan file if it exists (uses workspace name, not ID)
      await movePlanFile(runtimeForPlanFile, oldName, newName, oldMetadata.projectName);

      const allMetadataUpdated = await this.config.getAllWorkspaceMetadata();
      const updatedMetadata = allMetadataUpdated.find((m) => m.id === workspaceId);
      if (!updatedMetadata) {
        return Err("Failed to retrieve updated workspace metadata");
      }

      const enrichedMetadata = this.enrichFrontendMetadata(updatedMetadata);

      const session = this.sessions.get(workspaceId);
      if (session) {
        session.emitMetadata(enrichedMetadata);
      } else {
        this.emit("metadata", { workspaceId, metadata: enrichedMetadata });
      }

      await this.syncCodeWorkspaceFiles(updatedMetadata);

      return Ok({ newWorkspaceId: workspaceId });
    } catch (error) {
      const message = getErrorMessage(error);
      return Err(`Failed to rename workspace: ${message}`);
    } finally {
      // Still held only when the move/config section exited early. Never let
      // a release failure skip clearing the renaming flag below.
      await releaseOverridesLock?.().catch((error: unknown) => {
        log.warn("Failed to release MCP-overrides lock after rename", {
          workspaceId,
          error: getErrorMessage(error),
        });
      });
      // Always clear renaming flag, even on error
      this.renamingWorkspaces.delete(workspaceId);
    }
  }

  private async emitCurrentWorkspaceMetadata(workspaceId: string): Promise<void> {
    await this.emitCurrentWorkspaceMetadataBatch([workspaceId]);
  }

  /** Emit fresh metadata for several workspaces with a single config reload. */
  private async emitCurrentWorkspaceMetadataBatch(workspaceIds: string[]): Promise<void> {
    const allMetadata = await this.config.getAllWorkspaceMetadata();
    const metadataById = new Map(allMetadata.map((metadata) => [metadata.id, metadata]));
    for (const workspaceId of workspaceIds) {
      const enrichedMetadata = this.enrichMaybeFrontendMetadata(
        metadataById.get(workspaceId) ?? null
      );
      const session = this.sessions.get(workspaceId);
      if (session) {
        session.emitMetadata(enrichedMetadata);
      } else {
        this.emit("metadata", { workspaceId, metadata: enrichedMetadata });
      }
    }
  }

  private hasPendingAutoTitle(workspaceId: string): boolean {
    return this.config.findWorkspace(workspaceId)?.pendingAutoTitle === true;
  }

  private async updateWorkspaceTitleState(
    workspaceId: string,
    options: {
      title?: string;
      clearPendingAutoTitle?: boolean;
      requirePendingAutoTitle?: boolean;
    }
  ): Promise<Result<{ updated: boolean }>> {
    try {
      const workspace = this.config.findWorkspace(workspaceId);
      if (!workspace) {
        return Err("Workspace not found");
      }
      const { projectPath, workspacePath } = workspace;

      let updated = false;
      await this.config.editConfig((config) => {
        const projectConfig = config.projects.get(projectPath);
        if (!projectConfig) {
          return config;
        }

        const workspaceEntry =
          projectConfig.workspaces.find((entry) => entry.id === workspaceId) ??
          projectConfig.workspaces.find((entry) => entry.path === workspacePath);
        if (!workspaceEntry) {
          return config;
        }

        if (options.requirePendingAutoTitle && workspaceEntry.pendingAutoTitle !== true) {
          return config;
        }

        if (options.title !== undefined) {
          workspaceEntry.title = options.title;
          updated = true;
        }

        if (options.clearPendingAutoTitle && workspaceEntry.pendingAutoTitle) {
          delete workspaceEntry.pendingAutoTitle;
          updated = true;
        }

        return config;
      });

      if (updated) {
        await this.emitCurrentWorkspaceMetadata(workspaceId);
      }

      return Ok({ updated });
    } catch (error) {
      const message = getErrorMessage(error);
      return Err(`Failed to update workspace title: ${message}`);
    }
  }

  /**
   * Candidate list for "small model" callers (title + AI sidebar status).
   * Global preferences first, then any workspace-configured model so a
   * custom-model workspace still works when global preferences are
   * unavailable. Public so AgentStatusService can share the precedence.
   */
  public async getWorkspaceTitleModelCandidates(workspaceId: string): Promise<string[]> {
    const candidates: string[] = [];
    const metadataResult = await this.aiService.getWorkspaceMetadata(workspaceId);
    const metadata = metadataResult.success ? metadataResult.data : undefined;

    // A configured name_workspace model (workspace bucket, then agent
    // defaults) leads the candidate list. Model-only: this runtime ignores
    // thinking and reasoning parameters. Defensive config read: tests
    // construct the service with partial Config mocks.
    let agentAiDefaults: AgentAiDefaults | undefined;
    try {
      agentAiDefaults = this.config.loadConfigOrDefault().agentAiDefaults;
    } catch {
      agentAiDefaults = undefined;
    }
    const nameBucket = metadata?.aiSettingsByAgent?.name_workspace;
    const resolved = resolveAgentAiSettings({
      targetAgentId: "name_workspace",
      profile: "interactive",
      agentAiDefaults,
      targetWorkspaceSettings: nameBucket ? { model: nameBucket.model } : undefined,
    });
    if (resolved.sources.model.tier !== "default") {
      candidates.push(resolved.selected.model);
    }
    for (const preferred of NAME_GEN_PREFERRED_MODELS) {
      if (!candidates.includes(preferred)) {
        candidates.push(preferred);
      }
    }
    if (!metadata) {
      return candidates;
    }

    const fallbackModels = [
      metadata.aiSettings?.model,
      ...Object.values(metadata.aiSettingsByAgent ?? {}).map((settings) => settings.model),
    ];
    for (const model of fallbackModels) {
      if (model && !candidates.includes(model)) {
        candidates.push(model);
      }
    }

    return candidates;
  }

  private async maybeRunPendingAutoTitleFromMessage(
    workspaceId: string,
    message: string
  ): Promise<void> {
    const trimmedMessage = message.trim();
    if (!trimmedMessage || !this.hasPendingAutoTitle(workspaceId)) {
      return;
    }

    try {
      const candidates = await this.getWorkspaceTitleModelCandidates(workspaceId);
      const result = await generateWorkspaceIdentity(trimmedMessage, candidates, this.aiService);
      if (result.success) {
        const persistResult = await this.updateWorkspaceTitleState(workspaceId, {
          title: result.data.title,
          clearPendingAutoTitle: true,
          requirePendingAutoTitle: true,
        });
        if (!persistResult.success) {
          log.warn("Failed to persist fork auto-title", {
            workspaceId,
            error: persistResult.error,
          });
        }
        return;
      }

      log.warn("Failed to generate fork auto-title", {
        workspaceId,
        error: result.error,
      });
    } catch (error) {
      log.error("Unexpected error generating fork auto-title", {
        workspaceId,
        error: getErrorMessage(error),
      });
    }

    const clearPendingResult = await this.updateWorkspaceTitleState(workspaceId, {
      clearPendingAutoTitle: true,
      requirePendingAutoTitle: true,
    });
    if (!clearPendingResult.success) {
      log.warn("Failed to clear pending fork auto-title state", {
        workspaceId,
        error: clearPendingResult.error,
      });
    }
  }

  /**
   * Merge programmatic tag updates into a workspace (null value deletes a key).
   * Tags are not rendered in the UI; they exist for API/CLI/workflow-action
   * callers that need stable workspace identity (e.g. reconcile loops).
   */
  async updateTags(
    workspaceId: string,
    updates: Record<string, string | null>
  ): Promise<Result<{ tags: Record<string, string> }>> {
    assert(Object.keys(updates).length > 0, "updateTags requires at least one tag update");
    for (const tagKey of Object.keys(updates)) {
      assert(tagKey.trim().length > 0, "Workspace tag keys must be non-empty");
    }
    try {
      const workspace = this.config.findWorkspace(workspaceId);
      if (!workspace) {
        return Err("Workspace not found");
      }

      let finalTags: Record<string, string> = {};
      // findWorkspace above can match via metadata fallback (legacy entries
      // without an id) or race a concurrent removal; track whether the edit
      // actually landed so callers never get a silent-success no-op.
      let applied = false;
      await this.config.editConfig((config) => {
        const projectConfig = config.projects.get(workspace.projectPath);
        const workspaceEntry = projectConfig?.workspaces.find((entry) => entry.id === workspaceId);
        if (!workspaceEntry) {
          return config;
        }
        const merged = { ...workspaceEntry.tags };
        for (const [tagKey, tagValue] of Object.entries(updates)) {
          if (tagValue === null) {
            delete merged[tagKey];
          } else {
            merged[tagKey] = tagValue;
          }
        }
        if (Object.keys(merged).length > 0) {
          workspaceEntry.tags = merged;
        } else {
          delete workspaceEntry.tags;
        }
        finalTags = merged;
        applied = true;
        return config;
      });
      if (!applied) {
        return Err("Workspace not found");
      }

      await this.emitCurrentWorkspaceMetadata(workspaceId);
      return Ok({ tags: finalTags });
    } catch (error) {
      return Err(`Failed to update workspace tags: ${getErrorMessage(error)}`);
    }
  }

  /**
   * Update workspace title without affecting the filesystem name.
   * Unlike rename(), this can be called even while streaming is active.
   */
  async updateTitle(workspaceId: string, title: string): Promise<Result<void>> {
    const result = await this.updateWorkspaceTitleState(workspaceId, {
      title,
      clearPendingAutoTitle: true,
    });
    if (!result.success) {
      return Err(result.error);
    }
    return Ok(undefined);
  }

  /**
   * Pin or unpin a chat (root workspace) so it floats to the top of its project
   * in the sidebar. Pin order is stable: pinnedAt ascending, new pins append at
   * the bottom of the pinned block. Recency is intentionally untouched, so
   * unpinning drops the chat back to its natural recency position.
   */
  async setPinned(workspaceId: string, pinned: boolean): Promise<Result<void>> {
    try {
      const workspace = this.config.findWorkspace(workspaceId);
      if (!workspace) {
        return Err("Workspace not found");
      }
      const { projectPath, workspacePath } = workspace;

      let updated = false;
      const healedIds: string[] = [];
      let validationError: string | undefined;
      await this.config.editConfig((config) => {
        const projectConfig = config.projects.get(projectPath);
        if (!projectConfig) {
          validationError = "Workspace not found";
          return config;
        }

        const workspaceEntry =
          projectConfig.workspaces.find((entry) => entry.id === workspaceId) ??
          projectConfig.workspaces.find((entry) => entry.path === workspacePath);
        if (!workspaceEntry) {
          validationError = "Workspace not found";
          return config;
        }

        // Only root chats are pinnable; sub-agents follow their pinned parent.
        if (workspaceEntry.parentWorkspaceId) {
          validationError = "Sub-agent chats cannot be pinned";
          return config;
        }

        if (pinned) {
          if (isWorkspaceArchived(workspaceEntry.archivedAt, workspaceEntry.unarchivedAt)) {
            validationError = "Archived chats cannot be pinned";
            return config;
          }
          // Idempotent: a concurrent double-pin from another client must not move the row.
          if (workspaceEntry.pinnedAt) {
            return config;
          }
          // Server-generated global monotonic timestamp, plus write-path
          // healing when corrupted state saturates the sane key range; see
          // appendPinnedTimestamp.
          const pinnedEntries = Array.from(config.projects.values()).flatMap((project) =>
            project.workspaces
              .filter((entry) => entry.pinnedAt)
              .map((entry) => ({ id: entry.id, pinnedAt: entry.pinnedAt }))
          );
          const { changed, pinnedAt } = appendPinnedTimestamp(pinnedEntries);
          if (changed.size > 0) {
            for (const project of config.projects.values()) {
              for (const entry of project.workspaces) {
                if (!entry.id) continue;
                const healedPinnedAt = changed.get(entry.id);
                if (healedPinnedAt !== undefined) {
                  entry.pinnedAt = healedPinnedAt;
                  healedIds.push(entry.id);
                }
              }
            }
          }
          workspaceEntry.pinnedAt = pinnedAt;
          updated = true;
        } else if (workspaceEntry.pinnedAt) {
          delete workspaceEntry.pinnedAt;
          updated = true;
        }

        return config;
      });

      if (validationError) {
        return Err(validationError);
      }

      if (healedIds.length > 0) {
        await this.emitCurrentWorkspaceMetadataBatch(healedIds);
      }
      if (updated) {
        await this.emitCurrentWorkspaceMetadata(workspaceId);
      }

      return Ok(undefined);
    } catch (error) {
      return Err(`Failed to update pin state: ${getErrorMessage(error)}`);
    }
  }

  /**
   * Reorder a pinned block. `workspaceIds` is the full desired pinned order
   * for that block as the client sees it: one project bucket in grouped mode,
   * or the unified cross-project block in flat sidebar mode. The reorder
   * scope is the union of config buckets referenced by the input ids, so a
   * grouped drag never disturbs other buckets while a flat drag re-deals the
   * whole unified block. Defensive contract: unknown/unpinned ids are
   * dropped, and partial inputs (e.g. the grouped multi-project section sends
   * only its own pins, which can span project buckets) permute the requested
   * ids among the slots they already occupy while every omitted pin keeps its
   * current position, so a section drag never shifts unrelated chats in the
   * flat global order and concurrent pin/unpin from other clients is absorbed
   * instead of erroring.
   *
   * Persistence model: pinnedAt is an ordering key, so reordering re-deals the
   * existing pool of pinnedAt timestamps onto the new order (see
   * reassignPinnedTimestamps). Reusing the pool keeps max(pinnedAt) stable,
   * preserving setPinned's append-at-bottom invariant across reorders.
   */
  async reorderPinned(workspaceIds: string[]): Promise<Result<void>> {
    try {
      // Resolve buckets from the ids so clients never need internal bucket
      // keys (e.g. the multi-project bucket). Nothing resolvable means the
      // client acted on stale state: a benign no-op.
      const projectPaths = new Set<string>();
      for (const id of workspaceIds) {
        const path = this.config.findWorkspace(id)?.projectPath;
        if (path !== undefined) {
          projectPaths.add(path);
        }
      }
      if (projectPaths.size === 0) {
        return Ok(undefined);
      }

      const changedIds: string[] = [];
      await this.config.editConfig((config) => {
        const bucketConfigs = [...projectPaths]
          .map((path) => config.projects.get(path))
          .filter((bucket) => bucket !== undefined);

        // Current pinned roots across the referenced buckets, in effective pin order.
        const pinnedEntries: Array<{ id: string; pinnedAt: string }> = [];
        for (const bucket of bucketConfigs) {
          for (const entry of bucket.workspaces) {
            if (!entry.id || !entry.pinnedAt) continue;
            if (!isWorkspacePinned(entry)) continue;
            pinnedEntries.push({ id: entry.id, pinnedAt: entry.pinnedAt });
          }
        }
        if (pinnedEntries.length < 2) {
          return config;
        }
        pinnedEntries.sort(comparePinnedOrder);
        const currentOrder = pinnedEntries.map((entry) => entry.id);
        const currentSet = new Set(currentOrder);

        // Desired order: dedupe the input, keep only currently-pinned ids,
        // then substitute the requested ids into the slots they currently
        // occupy so omitted pins never move.
        const seen = new Set<string>();
        const requestedIds: string[] = [];
        for (const id of workspaceIds) {
          if (seen.has(id)) continue;
          seen.add(id);
          if (currentSet.has(id)) {
            requestedIds.push(id);
          }
        }
        const requestedSet = new Set(requestedIds);
        let nextRequestedIndex = 0;
        const desiredOrder = currentOrder.map((id) =>
          requestedSet.has(id) ? requestedIds[nextRequestedIndex++] : id
        );
        if (desiredOrder.every((id, index) => id === currentOrder[index])) {
          return config;
        }

        const currentPinnedAtById = new Map(
          pinnedEntries.map((entry) => [entry.id, entry.pinnedAt])
        );
        const changes = reassignPinnedTimestamps(desiredOrder, currentPinnedAtById);
        for (const bucket of bucketConfigs) {
          for (const entry of bucket.workspaces) {
            if (!entry.id) continue;
            const nextPinnedAt = changes.get(entry.id);
            if (nextPinnedAt !== undefined) {
              entry.pinnedAt = nextPinnedAt;
              changedIds.push(entry.id);
            }
          }
        }
        return config;
      });

      if (changedIds.length > 0) {
        await this.emitCurrentWorkspaceMetadataBatch(changedIds);
      }
      return Ok(undefined);
    } catch (error) {
      return Err(`Failed to reorder pinned chats: ${getErrorMessage(error)}`);
    }
  }

  /**
   * Regenerate the workspace title from chat history using AI.
   * Uses the first user message as the durable objective, plus a context block with
   * that first user message and the latest turns, then persists the generated title.
   */
  async regenerateTitle(workspaceId: string): Promise<Result<{ title: string }>> {
    const historyResult = await this.historyService.getHistoryFromLatestBoundary(workspaceId);
    if (!historyResult.success) {
      return Err("Could not read workspace history");
    }

    let contextTurns = collectWorkspaceTitleContextTurns(historyResult.data);
    let firstUserText = contextTurns.find((turn) => turn.role === "user")?.text;

    if (!firstUserText) {
      // Compaction boundaries can leave the latest epoch with only an assistant summary.
      // Fall back to scanning full history so regenerateTitle still works for compacted chats.
      const fallbackTurns: WorkspaceTitleContextTurn[] = [];
      let fallbackFirstUserText: string | undefined;
      const fullHistoryResult = await this.historyService.iterateFullHistory(
        workspaceId,
        "forward",
        (messages) => {
          const chunkTurns = collectWorkspaceTitleContextTurns(messages);
          for (const turn of chunkTurns) {
            if (!fallbackFirstUserText && turn.role === "user") {
              fallbackFirstUserText = turn.text;
            }
            fallbackTurns.push(turn);
          }
        }
      );
      if (!fullHistoryResult.success) {
        return Err("Could not read workspace history");
      }

      firstUserText = fallbackFirstUserText;
      contextTurns = fallbackTurns;
    }

    if (!firstUserText) {
      return Err("No user messages in workspace history");
    }

    const { conversationContext, latestUserText } =
      buildWorkspaceTitleConversationContext(contextTurns);

    const candidates = await this.getWorkspaceTitleModelCandidates(workspaceId);

    const result = await generateWorkspaceIdentity(
      firstUserText,
      candidates,
      this.aiService,
      conversationContext,
      latestUserText
    );
    if (!result.success) {
      return Err("Title generation failed");
    }

    const updateTitleResult = await this.updateTitle(workspaceId, result.data.title);
    if (!updateTitleResult.success) {
      return Err(updateTitleResult.error);
    }

    return Ok({ title: result.data.title });
  }

  /**
   * Check whether archiving a workspace requires user acknowledgement (e.g. untracked files
   * that snapshot cannot preserve). Returns a discriminated union the frontend uses to decide
   * whether to show a destructive confirmation dialog.
   */
  async preflightArchive(
    workspaceId: string,
    options?: { worktreeArchiveBehaviorOverride?: WorktreeArchiveBehavior }
  ): Promise<Result<ArchivePreflightResult>> {
    try {
      if (
        this.agentTaskIntegration?.hasActiveDescendantAgentTasksForWorkspace(workspaceId) === true
      ) {
        return Err(ACTIVE_DESCENDANT_ARCHIVE_ERROR);
      }

      const workspace = this.config.findWorkspace(workspaceId);
      if (!workspace) {
        return Err("Workspace not found");
      }

      const snapshotBehaviorEnabled = this.isSnapshotArchiveEligibilityMutationSensitive(
        workspaceId,
        options?.worktreeArchiveBehaviorOverride ?? this.getWorktreeArchiveBehavior()
      );

      if (!snapshotBehaviorEnabled) {
        return Ok({ kind: "ready" as const });
      }

      const metadataResult = await this.aiService.getWorkspaceMetadata(workspaceId);
      if (!metadataResult.success) {
        return Err(metadataResult.error);
      }
      const metadata = metadataResult.data;

      const confirmationResult = await this.getArchiveUntrackedFilesConfirmation({
        workspaceId,
        workspaceMetadata: metadata,
      });
      if (!confirmationResult.success) {
        return Err(confirmationResult.error);
      }

      if (confirmationResult.data) {
        return Ok(confirmationResult.data);
      }

      return Ok({ kind: "ready" as const });
    } catch (error) {
      return Err(`Failed to preflight archive: ${getErrorMessage(error)}`);
    }
  }

  /**
   * True when this workspace's archive eligibility depends on its live untracked-file set:
   * snapshot-behavior archives require an exact acknowledgement of the current untracked
   * paths, so any worktree write can flip the archive between proceeding and bouncing with
   * requires_confirmation. Model-facing lifecycle paths consult this to refuse interrupting
   * active turns — a turn interrupted for an archive that then bounces would strand the
   * workspace with destroyed in-flight work and no archive.
   */
  isSnapshotArchiveEligibilityMutationSensitive(
    workspaceId: string,
    // Callers that pin one behavior read across an interrupt+archive operation pass it here so
    // this check agrees with the pinned sink decision.
    worktreeArchiveBehavior: WorktreeArchiveBehavior = this.getWorktreeArchiveBehavior(),
    // When provided, mirrors the sink's snapshot-capture scoping: only single-project managed
    // worktrees ever capture a snapshot, so other runtimes (SSH/Docker) and multi-project
    // targets are never untracked-file sensitive and may be interrupted safely.
    metadata?: WorkspaceMetadata
  ): boolean {
    if (
      metadata != null &&
      (!isWorktreeRuntime(metadata.runtimeConfig) ||
        (Array.isArray(metadata.projects) && metadata.projects.length > 1))
    ) {
      return false;
    }
    return (
      !this.isSharedTaskWorkspace(workspaceId) &&
      worktreeArchiveBehavior === "snapshot" &&
      this.worktreeArchiveSnapshotService != null
    );
  }

  /**
   * Workspaces an external editor (VS Code/Cursor/Zed deep link or a custom editor command)
   * was opened for. Like native terminals, external editors are untrackable once open (deep
   * links leave no process handle; custom commands spawn detached), so opens are recorded
   * stickily in memory and as a durable per-workspace marker that survives app restarts.
   */
  private readonly externalEditorWorkspaces = new Set<string>();

  /**
   * Marker ancestry batches per workspace. A batch begins with a disk probe (did a durable
   * marker exist before this batch wrote one?) and collects one launch-evidence token per
   * recorded open; tokens are removed only by failed launches. When the last token of a
   * batch is removed, every open in the batch failed, so the batch's marker is deleted
   * unless it predated the batch (an earlier session's editor may still be running behind
   * it). Deep-link opens recorded via recordExternalEditorOpen retain their token forever
   * (they launch in the renderer immediately after recording and cannot report failures
   * back), pinning the marker. Probing per batch — not per call — prevents a marker written
   * by an earlier in-flight open of the same batch from masquerading as pre-existing
   * evidence when every open in the batch fails.
   */
  private readonly externalEditorMarkerBatches = new Map<
    string,
    { markerPreexisted: boolean; tokens: Set<symbol> }
  >();

  /**
   * Serializes marker writes against failed-launch rollbacks per workspace: an unserialized
   * rollback's unlink could interleave with a concurrent open's write and delete the marker
   * protecting that open's live editor.
   */
  private readonly externalEditorMarkerLocks = new MutexMap<string>();

  /**
   * Editor-open recordings currently in flight per workspace, counted synchronously at
   * entry and released when the recording settles. An in-flight recording has already
   * passed (or will synchronously fail) the admission checks and its launch follows without
   * rechecking, so hasExternalEditorOpen counts these alongside durable evidence — a
   * concurrent failed launch's rollback may collapse the shared marker and cache entry, and
   * without this count that collapse would make a still-recording sibling invisible to an
   * archive that then removes the environment beneath the launching editor.
   */
  private readonly pendingExternalEditorRecordings = new Map<string, number>();

  private externalEditorMarkerPath(workspaceId: string): string {
    return path.join(this.config.sessionsDir, workspaceId, "external-editor-opened");
  }

  /**
   * Disk probe for the durable marker. "unknown" means the probe failed in a way that cannot
   * prove absence (EACCES, EIO, ...).
   */
  private async probeExternalEditorMarkerOnDisk(
    workspaceId: string
  ): Promise<"present" | "absent" | "unknown"> {
    try {
      await fsPromises.access(this.externalEditorMarkerPath(workspaceId));
      return "present";
    } catch (error) {
      return isErrnoWithCode(error, "ENOENT") ? "absent" : "unknown";
    }
  }

  /**
   * Rollback handles for renderer-recorded deep-link opens, keyed by the CLIENT-generated
   * launch token (client-side so the renderer can still redeem it when the recording
   * response is lost mid-connection — a backend-minted token would die with the response).
   * The renderer redeems a token via rollbackRecordedEditorOpen only when its launch
   * provably never happened (placeholder closed before navigation, or an ambiguous
   * recording RPC whose launch was abandoned). Entries for successful launches are retained
   * for the app session — they pin the batch token that keeps the durable marker protected.
   * A (buggy) reused token overwrites its old entry, whose pinned launch evidence then only
   * over-refuses (fail closed).
   */
  private readonly externalEditorLaunchRollbacks = new Map<
    string,
    { workspaceId: string; rollback: () => Promise<void> }
  >();

  /**
   * Rollback requests that arrived before their recording committed, keyed by launch token.
   * The renderer can observe a transport rejection of its recordEditorOpen RPC while the
   * backend handler is still awaiting marker persistence; its immediate rollback would find
   * no rollback entry, no-op, and the handler would then commit a durable marker for a
   * launch the renderer already abandoned — a false marker that permanently refuses future
   * model-driven archives. An unknown-token rollback therefore leaves a tombstone that the
   * recording consumes at commit time (in the same synchronous block that would register
   * the rollback entry), undoing its own admission instead of committing. Bounded FIFO:
   * tombstones whose recording never reached the backend are unredeemable, and evicting one
   * can at worst leave a sticky marker behind (over-refuses archives — fail closed).
   */
  private readonly externalEditorRollbackTombstones = new Map<string, string>();

  private static readonly EXTERNAL_EDITOR_ROLLBACK_TOMBSTONE_CAP = 1024;

  /**
   * Record that the user is opening this workspace in an external editor. Refuses while an
   * agent-driven archive is gating the workspace: the check shares the synchronous block with
   * the in-memory recording (mirroring TerminalService.openNative), so an archive gate armed
   * first refuses the open while an open recorded first is observed by the sink's
   * untrackable-app check before snapshot capture.
   */
  async recordExternalEditorOpen(workspaceId: string, launchToken: string): Promise<Result<void>> {
    const admitted = await this.recordExternalEditorOpenForLaunch(workspaceId);
    if (!admitted.success) {
      return admitted;
    }
    // A rollback for this token that raced ahead of the recording (the renderer saw the RPC
    // reject while this handler was still persisting the marker) is consumed here, in the
    // same synchronous block that would otherwise register the rollback entry: the renderer
    // has already abandoned the launch, so undo the admission instead of committing a marker
    // no editor will ever sit behind.
    if (this.externalEditorRollbackTombstones.get(launchToken) === workspaceId) {
      this.externalEditorRollbackTombstones.delete(launchToken);
      await admitted.data.rollbackAfterFailedLaunch();
      return Err(`Editor open for ${workspaceId} was rolled back before its recording finished.`);
    }
    // Deep-link opens launch in the renderer immediately after this returns; the rollback
    // entry lets the renderer report a launch that provably never happened so the marker
    // cannot outlive it (see externalEditorLaunchRollbacks for why the token is
    // client-generated).
    this.externalEditorLaunchRollbacks.set(launchToken, {
      workspaceId,
      rollback: admitted.data.rollbackAfterFailedLaunch,
    });
    return Ok(undefined);
  }

  /**
   * Redeems a recordExternalEditorOpen launch token after the renderer's placeholder window
   * was closed before navigation (no editor launched). Idempotent for the renderer: unknown
   * or already redeemed tokens succeed without touching durable state (they only leave a
   * tombstone for a possibly in-flight recording), so renderer retries are safe.
   */
  async rollbackRecordedEditorOpen(
    workspaceId: string,
    launchToken: string
  ): Promise<Result<void>> {
    const entry = this.externalEditorLaunchRollbacks.get(launchToken);
    if (entry?.workspaceId !== workspaceId) {
      // Unknown token: the recording may still be in flight (its RPC rejected at the
      // transport while the handler awaits marker persistence). Tombstone the token so the
      // commit rolls itself back instead of persisting a marker for an abandoned launch
      // (see externalEditorRollbackTombstones). Already-redeemed or never-recorded tokens
      // leave an unredeemable tombstone the FIFO cap eventually evicts.
      this.externalEditorRollbackTombstones.set(launchToken, workspaceId);
      if (
        this.externalEditorRollbackTombstones.size >
        WorkspaceService.EXTERNAL_EDITOR_ROLLBACK_TOMBSTONE_CAP
      ) {
        const oldest = this.externalEditorRollbackTombstones.keys().next().value;
        if (oldest != null) {
          this.externalEditorRollbackTombstones.delete(oldest);
        }
      }
      return Ok(undefined);
    }
    this.externalEditorLaunchRollbacks.delete(launchToken);
    await entry.rollback();
    return Ok(undefined);
  }

  /**
   * Like recordExternalEditorOpen, but for callers that launch the editor themselves and can
   * observe deterministic launch failures (the custom-editor route: EditorService validates
   * the command and spawns nothing on failure). A failed launch must call
   * rollbackAfterFailedLaunch so a marker this call created cannot become a sticky false
   * positive that permanently refuses future model-driven snapshot/Coder-stop archives.
   */
  async recordExternalEditorOpenForLaunch(
    workspaceId: string
  ): Promise<Result<{ rollbackAfterFailedLaunch: () => Promise<void> }>> {
    // Pending-recording admission pairing (mirrors TerminalService.openNative): the count is
    // registered before any await — including the marker-lock wait, where a concurrent
    // failed launch's rollback may collapse the shared marker and cache entry — so
    // hasExternalEditorOpen stays true for the whole in-flight window. Refused recordings
    // record nothing durable; the count simply releases in the finally.
    this.pendingExternalEditorRecordings.set(
      workspaceId,
      (this.pendingExternalEditorRecordings.get(workspaceId) ?? 0) + 1
    );
    try {
      return await this.recordExternalEditorOpenAdmitted(workspaceId);
    } finally {
      const remaining = (this.pendingExternalEditorRecordings.get(workspaceId) ?? 1) - 1;
      if (remaining <= 0) {
        this.pendingExternalEditorRecordings.delete(workspaceId);
      } else {
        this.pendingExternalEditorRecordings.set(workspaceId, remaining);
      }
    }
  }

  /** Body of recordExternalEditorOpenForLaunch after pending-recording admission. */
  private async recordExternalEditorOpenAdmitted(
    workspaceId: string
  ): Promise<Result<{ rollbackAfterFailedLaunch: () => Promise<void> }>> {
    if (this.archivingWorkspaces.has(workspaceId)) {
      return Err(
        `Workspace is being archived: ${workspaceId}. Unarchive it before opening an editor.`
      );
    }
    const workspaceEntry = findWorkspaceEntry(this.config.loadConfigOrDefault(), workspaceId);
    if (workspaceEntry == null) {
      // Also a path-safety boundary: the marker path joins the raw ID beneath the sessions
      // directory, so an unknown (possibly traversal-crafted, e.g. "../../.ssh") ID must
      // never reach the filesystem.
      return Err(`Workspace not found: ${workspaceId}`);
    }
    // Persisted archived state (not just an in-progress archive): a stale renderer can request
    // an editor for an already-archived workspace whose checkout may already be snapshot and
    // removed (mirrors TerminalService.openNative and the send/PTY/desktop admissions).
    // Checked before the durable marker write so a refused open cannot permanently gate
    // future snapshot archives of this workspace.
    if (
      isWorkspaceArchived(
        workspaceEntry.workspace.archivedAt,
        workspaceEntry.workspace.unarchivedAt
      )
    ) {
      return Err(`Workspace is archived: ${workspaceId}. Unarchive it before opening an editor.`);
    }
    // Durable marker: the editor can outlive Xum, so a restart must not forget the open.
    // Persistence failure is fatal to the open (mirrors TerminalService.openNative): an
    // editor opened without the marker would be invisible to archive gating after a restart,
    // so refusing here is the only fail-closed option (the in-memory Set covers just this
    // app session).
    let admissionToken: symbol;
    try {
      admissionToken = await this.externalEditorMarkerLocks.withLock(workspaceId, async () => {
        // Batch-scoped ancestry (see externalEditorMarkerBatches): the pre-existence probe
        // runs once per batch, before the batch's first write, so a marker written by an
        // earlier in-flight open of this same batch cannot masquerade as evidence of a real
        // prior launch. "unknown" probes count as pre-existing (fail closed).
        let batch = this.externalEditorMarkerBatches.get(workspaceId);
        const createdBatch = batch == null;
        if (batch == null) {
          const preexisting = await this.probeExternalEditorMarkerOnDisk(workspaceId);
          batch = { markerPreexisted: preexisting !== "absent", tokens: new Set() };
          this.externalEditorMarkerBatches.set(workspaceId, batch);
        }
        const markerPath = this.externalEditorMarkerPath(workspaceId);
        try {
          await fsPromises.mkdir(path.dirname(markerPath), { recursive: true });
          await fsPromises.writeFile(markerPath, new Date().toISOString());
        } catch (error) {
          // A newly created, still-empty batch must not outlive a failed persistence attempt:
          // its probe (possibly a fail-closed "unknown" during the same filesystem hiccup)
          // would become stale ancestry for a later retry, permanently preserving a marker
          // that retry writes even when its launch fails. Discarding it makes the next
          // attempt re-probe the recovered disk. A joined batch keeps its live tokens.
          if (createdBatch && batch.tokens.size === 0) {
            this.externalEditorMarkerBatches.delete(workspaceId);
            // The failed write may still have created (or truncated) the marker file —
            // ENOSPC and I/O errors can reject after the open. When this batch's probe
            // proved absence, that artifact is ours and no launch backs it: left behind, it
            // reads as durable launch evidence across restarts and classifies as
            // pre-existing on retry. An "unknown" probe stays fail closed (never unlink
            // what might predate us); unlink failure only over-refuses archives.
            if (!batch.markerPreexisted) {
              try {
                await fsPromises.unlink(markerPath);
              } catch {
                // Best-effort (fail closed).
              }
            }
          }
          throw error;
        }
        // The sticky in-memory record is a cache of the just-written marker; before this
        // point the pending-recording count already keeps archive gates closed.
        this.externalEditorWorkspaces.add(workspaceId);
        // Launch evidence is registered under the same lock as the write so a concurrent
        // failed launch's rollback can never observe the marker without the token.
        const token = Symbol("external-editor-launch");
        batch.tokens.add(token);
        return token;
      });
    } catch (error) {
      log.error("Failed to persist external editor marker", { workspaceId, error });
      return Err(
        `Cannot open an editor for ${workspaceId}: persisting the editor-open marker failed (${getErrorMessage(error)}), and without it archive safety checks would forget the editor after a restart.`
      );
    }
    return Ok({
      rollbackAfterFailedLaunch: () =>
        this.rollbackExternalEditorMarkerAfterFailedLaunch(workspaceId, admissionToken),
    });
  }

  /**
   * Undo a failed editor launch's durable marker. The marker is deleted only when its whole
   * ancestry batch failed (no launch-evidence token remains, so no editor launched or can
   * still launch under it) and it did not predate the batch (an earlier session's editor may
   * still be running behind it). Serialized with marker writes so the unlink can never race
   * a concurrent open's write; deletion failure keeps the sticky marker (fail closed).
   */
  private async rollbackExternalEditorMarkerAfterFailedLaunch(
    workspaceId: string,
    token: symbol
  ): Promise<void> {
    await this.externalEditorMarkerLocks.withLock(workspaceId, async () => {
      const batch = this.externalEditorMarkerBatches.get(workspaceId);
      if (batch == null) {
        // Unknown batch (cannot happen: batches are only closed here): keep everything.
        return;
      }
      batch.tokens.delete(token);
      if (batch.tokens.size > 0) {
        return;
      }
      // Every open in the batch failed: close it so the next open starts a fresh probe.
      this.externalEditorMarkerBatches.delete(workspaceId);
      if (batch.markerPreexisted) {
        return;
      }
      try {
        await fsPromises.unlink(this.externalEditorMarkerPath(workspaceId));
      } catch (error) {
        if (!isErrnoWithCode(error, "ENOENT")) {
          // The marker may still exist, so the in-memory cache entry must stay to match it.
          log.error("Failed to roll back external editor marker after a failed launch", {
            workspaceId,
            error,
          });
          return;
        }
      }
      this.externalEditorWorkspaces.delete(workspaceId);
    });
  }

  private async hasExternalEditorOpen(workspaceId: string): Promise<boolean> {
    // Recordings still in flight count as open: see pendingExternalEditorRecordings.
    if ((this.pendingExternalEditorRecordings.get(workspaceId) ?? 0) > 0) {
      return true;
    }
    if (this.externalEditorWorkspaces.has(workspaceId)) {
      return true;
    }
    const probe = await this.probeExternalEditorMarkerOnDisk(workspaceId);
    if (probe === "present") {
      this.externalEditorWorkspaces.add(workspaceId);
      return true;
    }
    // An "unknown" probe (EACCES, EIO, ...) cannot prove the marker is absent, and a false
    // "absent" would let a snapshot archive remove the checkout under a surviving editor —
    // fail closed without caching (the marker may still prove readable later).
    return probe !== "absent";
  }

  /**
   * Whether an untrackable local app (native terminal or external editor) was ever opened for
   * this workspace. Such apps are detached and daemonize, so their lifetime cannot be tracked;
   * the model-facing lifecycle path refuses snapshot archives (which remove the checkout) for
   * such workspaces instead of pulling the directory out from under a live shell or editor.
   */
  async hasUntrackableExternalAppOpen(workspaceId: string): Promise<boolean> {
    if ((await this.terminalService?.hasOpenedNativeTerminal(workspaceId)) === true) {
      return true;
    }
    return await this.hasExternalEditorOpen(workspaceId);
  }

  /**
   * Fresh background-bash check: refreshes exit statuses first so a long-exited process cannot
   * hold an archive refusal open. Pre-gates use this; the synchronous snapshot in
   * listLiveWorkspaceActivity covers the sink's same-tick gate. Also consults the durable
   * spawn records for crash orphans: nohup/setsid children survive an unclean app shutdown
   * while the manager's in-memory map resets, so a purely in-memory answer would let a
   * post-restart snapshot archive remove the checkout under a still-running process.
   */
  async hasRunningBackgroundBashProcesses(workspaceId: string): Promise<boolean> {
    const processes = await this.backgroundProcessManager.list(workspaceId);
    if (processes.some((process) => process.status === "running")) {
      return true;
    }
    return await this.backgroundProcessManager.hasOrphanedRunningBackgroundProcesses(workspaceId, {
      extraRecordDirs: this.extraBgRecordDirsForWorkspace(workspaceId),
    });
  }

  /**
   * Devcontainer background spawn records live inside the container under
   * `<workspaceFolder>/.xum/tmp/mux-bashes/<workspaceId>` (DevcontainerRuntime.tempDir()),
   * which the standard workspace bind mount makes host-visible at the same path beneath the
   * checkout. The crash-orphan probe's default root covers only the host /tmp layout, so
   * devcontainer workspaces pass this root as an extra record dir; PIDs recorded there are
   * container-namespace, which the scan treats as unprobeable (running records fail closed).
   */
  private extraBgRecordDirsForWorkspace(workspaceId: string): string[] {
    const entry = findWorkspaceEntry(this.config.loadConfigOrDefault(), workspaceId);
    const workspace = entry?.workspace;
    if (workspace == null || !isDevcontainerRuntime(workspace.runtimeConfig)) return [];
    if (workspace.path.trim().length === 0) return [];
    return [path.join(workspace.path, ".xum", "tmp", BG_OUTPUT_SUBDIR, workspaceId)];
  }

  /**
   * Live user-facing activity that archiveUnlocked would silently terminate via
   * stopLiveWorkspaceActivityForArchive. Model-facing lifecycle paths consult this to refuse
   * archiving instead of killing activity that has no delegated workspace-turn handle.
   */
  listLiveWorkspaceActivity(workspaceId: string): WorkspaceLiveActivity {
    return {
      streaming: this.aiService.isStreaming(workspaceId),
      queuedMessages:
        this.hasQueuedMessages(workspaceId) || this.hasPendingQueuedOrPreparingTurn(workspaceId),
      backgroundBashProcesses:
        this.backgroundProcessManager.hasRunningBackgroundProcesses(workspaceId),
      terminalSessions: this.terminalService?.hasWorkspaceSessions(workspaceId) === true,
      desktopViewers: this.desktopSessionManager?.hasAttachedViewers(workspaceId) === true,
    };
  }

  /**
   * Arm the archive admission gate BEFORE a destructive pre-archive step (interrupt_active
   * turn interruption) and validate that no live user activity is already in flight. The
   * sink's refuseLiveUserActivity gate runs only inside archiveUnlocked — after the caller
   * has already destroyed the delegated turns — so a renderer send, bash execution,
   * attachment upload, file-completion refresh, workflow admission, or user queue entry
   * admitted between the caller's earlier activity snapshot and the sink would refuse the
   * archive with the turns already lost. This hold adds the workspace to
   * archivingWorkspaces (refusing new admissions synchronously, exactly like the sink) and
   * checks the same counters in the same synchronous block; the caller carries the returned
   * hold through the sink call so nothing can be admitted in between. Turn-shaped activity
   * (active streams, the delegated queue entries themselves) is intentionally NOT checked:
   * the caller is about to interrupt those turns, and the sink's admission-hold recheck
   * re-validates queue emptiness after interruption. Queue entries beyond
   * queuedDelegatedTurnCount — or any dispatching (PREPARING) entry other than a collected
   * delegated turn that stopStream can still cancel — fail closed here instead.
   *
   * The sink adds/removes the same Set entry around its own gate; both operations are
   * idempotent, and by the time the sink's finally removes it either archivedAt is
   * persisted (admissions refuse durably) or the archive failed and re-admission is
   * correct.
   */
  acquirePreInterruptionArchiveHold(
    workspaceId: string,
    options: {
      queuedDelegatedTurnCount: number;
      /**
       * Correlations of the collected active (starting/running) delegated turns on this
       * workspace. The workspace's one active stream is exempt only when its muxMetadata
       * correlates to one of these turns; a stream without that exact correlation (a user
       * stream that replaced an ended delegated stream, or one belonging to a different
       * turn) refuses the hold so interruption cannot stopStream() user work.
       */
      expectedDelegatedTurnCorrelations: readonly WorkspaceTurnTaskCorrelation[];
    }
  ): Result<Disposable> {
    assert(workspaceId.length > 0, "acquirePreInterruptionArchiveHold requires workspaceId");
    assert(
      Number.isInteger(options.queuedDelegatedTurnCount) && options.queuedDelegatedTurnCount >= 0,
      "acquirePreInterruptionArchiveHold requires a non-negative queuedDelegatedTurnCount"
    );
    this.archivingWorkspaces.add(workspaceId);
    const session = this.getOrCreateSession(workspaceId);
    // Freeze queue dispatch for the hold's whole lifetime (through interruption and the
    // sink): counting queued delegated entries below is not enough on its own, because an
    // expected entry could leave the queue and enter PREPARING between this check and
    // interruptWorkspaceTurn's targeted queue removal — the interrupt would then mark the
    // handle interrupted without stopping the dispatch, and the sink would refuse on the
    // pending turn work with the tasks already destroyed. Admission blocks stack, so the
    // sink acquiring its own hold is fine.
    const turnAdmissionHold = session.holdTurnAdmission();
    const hold: Disposable = {
      [Symbol.dispose]: () => {
        this.archivingWorkspaces.delete(workspaceId);
        turnAdmissionHold[Symbol.dispose]();
      },
    };
    const activityLabels: string[] = [];
    if ((this.preflightSendCounts.get(workspaceId) ?? 0) > 0) {
      activityLabels.push("a message send in progress");
    }
    // A user stream admitted after the caller's activity snapshot has already released its
    // send preflight, so the counter above cannot see it — recheck streaming itself and
    // bind the exemption to the collected delegated turns: the caller's earlier snapshot is
    // stale by now, so only a stream whose correlation metadata names one of those turns is
    // interruptible delegated work. Anything else (no stream info, no correlation, or a
    // different turn) is treated as user work and refuses.
    if (this.aiService.isStreaming(workspaceId)) {
      const streamCorrelation = parseWorkspaceTurnTaskCorrelation(
        this.streamManager?.getStreamInfo(workspaceId)?.muxMetadata
      );
      const streamIsExpectedDelegatedTurn =
        streamCorrelation != null &&
        options.expectedDelegatedTurnCorrelations.some((expected) =>
          isSameWorkspaceTurnTaskCorrelation(expected, streamCorrelation)
        );
      if (!streamIsExpectedDelegatedTurn) {
        activityLabels.push("an active stream not attributable to the delegated turns");
      }
    }
    if ((this.preflightExecCounts.get(workspaceId) ?? 0) > 0) {
      activityLabels.push("a bash command executing");
    }
    if ((this.preflightStagingCounts.get(workspaceId) ?? 0) > 0) {
      activityLabels.push("an attachment transfer in progress");
    }
    if ((this.preflightFileCompletionCounts.get(workspaceId) ?? 0) > 0) {
      activityLabels.push("a file completion refresh in progress");
    }
    if ((this.preflightForkCounts.get(workspaceId) ?? 0) > 0) {
      activityLabels.push("a fork of this workspace in progress");
    }
    if ((this.preflightMcpPromptDiscoveryCounts.get(workspaceId) ?? 0) > 0) {
      activityLabels.push("an MCP prompt discovery in progress");
    }
    // In-flight native-terminal/editor opens passed their own archive guards before this
    // hold armed and surface only through the pending-open counters until their durable
    // markers persist; the sink's untrackable-app check would refuse on them after the
    // turns were already destroyed.
    if ((this.pendingExternalEditorRecordings.get(workspaceId) ?? 0) > 0) {
      activityLabels.push("an external editor open in progress");
    }
    if (this.terminalService?.hasPendingNativeTerminalOpen(workspaceId) === true) {
      activityLabels.push("a native terminal open in progress");
    }
    if (hasInProcessWorkflowWork(workspaceId)) {
      activityLabels.push("a workflow run starting or running");
    }
    if (this.backgroundProcessManager.hasRunningBackgroundProcesses(workspaceId)) {
      activityLabels.push("running background bash processes");
    }
    if (this.terminalService?.hasWorkspaceSessions(workspaceId) === true) {
      activityLabels.push("open terminal sessions");
    }
    if (this.desktopSessionManager?.hasAttachedViewers(workspaceId) === true) {
      activityLabels.push("an open desktop viewer or popout");
    }
    // Narrow PREPARING/auto-retry check, NOT hasPendingQueuedOrPreparingTurn: that predicate
    // also reports plain queued messages, which would refuse every interrupt_active on a
    // queued delegated turn before the entry-count comparison below could attribute it.
    // (Queued entries cannot dispatch into PREPARING after this check: the turn-admission
    // hold above freezes queue dispatch for the hold's lifetime.)
    // A PREPARING send is exempt only when it IS one of the collected active delegated turns
    // (exact correlation) and has handed its startup to the engine, so interruptWorkspaceTurn's
    // stopStream cancels it. Any other PREPARING entry has left the queue without registering
    // a stream, so the queue comparison below cannot attribute it — fail closed. The same
    // correlation binding as the stream check above keeps a user send that replaced an ended
    // delegated turn, or a delegated turn still holding a queued handle, out of the exemption.
    const preparingTurn = session.getStoppablePreparingWorkspaceTurn();
    const preparingIsExpectedDelegatedTurn =
      preparingTurn != null &&
      options.expectedDelegatedTurnCorrelations.some((expected) =>
        isSameWorkspaceTurnTaskCorrelation(expected, preparingTurn)
      );
    if (
      (session.isPreparingTurn() && !preparingIsExpectedDelegatedTurn) ||
      session.hasPendingAutoRetry()
    ) {
      activityLabels.push("a message dispatching");
    }
    // Checked even while an exempt delegated turn is PREPARING: user entries queued behind it
    // are still user work the archive would silently drop.
    if (session.queuedMessageEntryCount() > options.queuedDelegatedTurnCount) {
      activityLabels.push("queued messages beyond the delegated turns");
    }
    if (activityLabels.length > 0) {
      hold[Symbol.dispose]();
      return Err(
        `Workspace has live activity (${activityLabels.join(", ")}) that interrupting and archiving would destroy or terminate. Wait for it to finish or ask the user to archive manually.`
      );
    }
    return Ok(hold);
  }

  async archive(
    workspaceId: string,
    acknowledgedUntrackedPaths?: string[],
    options?: ArchiveWorkspaceOptions
  ): Promise<Result<ArchiveWorkspaceResult>> {
    return await this.withTaskTreeLifecycleLock(workspaceId, async () =>
      this.archiveUnlocked(workspaceId, acknowledgedUntrackedPaths, options)
    );
  }

  /**
   * Internal entry point for task orchestration callers that already hold the task-tree lifecycle
   * lock. The model-facing workspace lifecycle path pre-acquires that lock before its own
   * lifecycle locks to preserve the global lock order (task-tree → task-creation mutex →
   * workspace lifecycle), so the sink must not re-acquire it.
   */
  async archiveWhileTaskTreeLocked(
    workspaceId: string,
    acknowledgedUntrackedPaths?: string[],
    options?: ArchiveWorkspaceOptions
  ): Promise<Result<ArchiveWorkspaceResult>> {
    return await this.archiveUnlocked(workspaceId, acknowledgedUntrackedPaths, options);
  }

  /**
   * Archive a workspace. Archived workspaces are hidden from the main sidebar
   * but can be viewed on the project page.
   *
   * If init is still running, we abort it before archiving so we don't leave
   * orphaned post-create work running in the background.
   *
   * Returns a typed confirmation result instead of a generic error when the current
   * untracked-file set must be re-reviewed before a lossy snapshot archive can proceed.
   */
  private async archiveUnlocked(
    workspaceId: string,
    acknowledgedUntrackedPaths?: string[],
    options?: ArchiveWorkspaceOptions
  ): Promise<Result<ArchiveWorkspaceResult>> {
    if (this.shuttingDown) return Err("Server is shutting down");
    this.archivingWorkspaces.add(workspaceId);
    let admissionHold: Disposable | undefined;

    try {
      // Fail-closed live-activity gate for model-facing callers. This check and the
      // archivingWorkspaces.add above run in one synchronous block, pairing with the
      // synchronous entry guards in sendMessage: a send whose entry block ran first is
      // visible here (preflightSendCounts or a registered stream) and refuses the archive;
      // a send entering later observes archivingWorkspaces and is refused instead.
      if (options?.refuseLiveUserActivity === true) {
        const liveActivity = this.listLiveWorkspaceActivity(workspaceId);
        const activityLabels: string[] = [];
        if (liveActivity.streaming) activityLabels.push("an active stream");
        if ((this.preflightSendCounts.get(workspaceId) ?? 0) > 0) {
          activityLabels.push("a message send in progress");
        }
        if ((this.preflightExecCounts.get(workspaceId) ?? 0) > 0) {
          activityLabels.push("a bash command executing");
        }
        if ((this.preflightStagingCounts.get(workspaceId) ?? 0) > 0) {
          activityLabels.push("an attachment transfer in progress");
        }
        if ((this.preflightFileCompletionCounts.get(workspaceId) ?? 0) > 0) {
          activityLabels.push("a file completion refresh in progress");
        }
        if ((this.preflightForkCounts.get(workspaceId) ?? 0) > 0) {
          activityLabels.push("a fork of this workspace in progress");
        }
        if ((this.preflightMcpPromptDiscoveryCounts.get(workspaceId) ?? 0) > 0) {
          activityLabels.push("an MCP prompt discovery in progress");
        }
        if (liveActivity.queuedMessages) activityLabels.push("queued messages");
        if (liveActivity.backgroundBashProcesses) {
          activityLabels.push("running background bash processes");
        }
        if (liveActivity.terminalSessions) activityLabels.push("open terminal sessions");
        if (liveActivity.desktopViewers) activityLabels.push("an open desktop viewer or popout");
        // Workflow admissions pair with this gate (see workflowArchiveAdmission): an admission
        // whose synchronous entry ran first is counted here; one entering later observes the
        // archivingWorkspaces guard registered in the constructor and refuses.
        if (hasInProcessWorkflowWork(workspaceId)) {
          activityLabels.push("a workflow run starting or running");
        }
        if (activityLabels.length > 0) {
          return Err(
            `Workspace has live activity (${activityLabels.join(", ")}) that archiving would terminate. Wait for it to finish or ask the user to archive manually.`
          );
        }
        // Hold the session's turn admission for the remainder of the archive: queued entries
        // dispatch through AgentSession's internal send path, which bypasses
        // WorkspaceService.sendMessage's archived guard, so without the hold a message queued
        // during this operation could start a hidden stream after archivedAt persists. Armed
        // synchronously with the checks above and released in this function's finally; the
        // post-arm recheck mirrors acquireContextMutationAdmissionGuard's pairing argument (a
        // turn admitted first is observed here; a turn admitted later observes the block).
        const session = this.getOrCreateSession(workspaceId);
        admissionHold = session.holdTurnAdmission();
        if (session.hasActiveOrPendingTurnWork() || this.aiService.isStreaming(workspaceId)) {
          return Err(
            "Workspace has pending turn work that archiving would terminate. Wait for it to finish or ask the user to archive manually."
          );
        }
        // Post-arm workflow recheck: an admission that entered before archivingWorkspaces was
        // armed either still holds its in-process admission (caught synchronously above) or
        // released it only after a durably active run record existed (caught here); admissions
        // entering later observe the armed guard and refuse. This closes the window between
        // the caller's earlier active-run snapshot and this sink.
        if (
          (await this.agentTaskIntegration?.hasActiveTopLevelWorkflowRunsForWorkspace(
            workspaceId
          )) === true
        ) {
          return Err(
            "Workspace has active workflow runs that archiving would orphan. Wait for them to finish or ask the user to archive manually."
          );
        }
        // Crash-orphan background processes: nohup/setsid children of a previous app session
        // survive an unclean shutdown while the manager's in-memory map (checked in the
        // synchronous gate above) resets. Orphans are static post-crash artifacts, not racing
        // admissions, so this sink recheck is defense-in-depth against callers that skipped
        // the fresh pre-gate.
        if (
          await this.backgroundProcessManager.hasOrphanedRunningBackgroundProcesses(workspaceId, {
            extraRecordDirs: this.extraBgRecordDirsForWorkspace(workspaceId),
          })
        ) {
          return Err(
            "Workspace has background processes surviving from a previous app session that archiving could strand. Terminate them or ask the user to archive manually."
          );
        }
      }
      const workspace = this.config.findWorkspace(workspaceId);
      if (!workspace) {
        return Err("Workspace not found");
      }
      if (
        this.agentTaskIntegration?.hasActiveDescendantAgentTasksForWorkspace(workspaceId) === true
      ) {
        return Err(ACTIVE_DESCENDANT_ARCHIVE_ERROR);
      }
      const initState = this.initStateManager.getInitState(workspaceId);
      if (initState?.status === "running") {
        // Archiving should not leave post-create setup running in the background.
        const initAbortController = this.initAbortControllers.get(workspaceId);
        if (initAbortController) {
          initAbortController.abort();
          this.initAbortControllers.delete(workspaceId);
        }

        this.initStateManager.clearInMemoryState(workspaceId);

        // Clearing init state prevents init-end from firing (createInitLogger.logComplete() bails when
        // state is missing). If archiving fails before we persist archivedAt (e.g., beforeArchive hook
        // error), ensure the sidebar doesn't stay stuck on isInitializing/"Cancel creation".
        try {
          const allMetadata = await this.config.getAllWorkspaceMetadata();
          const updatedMetadata = allMetadata.find((m) => m.id === workspaceId);
          if (updatedMetadata) {
            const enrichedMetadata = this.enrichFrontendMetadata(updatedMetadata);
            const session = this.sessions.get(workspaceId);
            if (session) {
              session.emitMetadata(enrichedMetadata);
            } else {
              this.emit("metadata", { workspaceId, metadata: enrichedMetadata });
            }
          }
        } catch (error) {
          log.debug("Failed to emit metadata after init cancellation during archive", {
            workspaceId,
            error: getErrorMessage(error),
          });
        }
      }

      // The abort above only signals: the fire-and-forget init hook process (create/
      // createMulti/fork) may still be writing to the checkout or reconnecting. Wait for its
      // retained settlement — a deterministic exit signal, not a timer — before snapshot
      // capture, checkout deletion, or Coder hooks can proceed under it. Checked outside the
      // init-state branch because state may already be cleared while the process is exiting;
      // the retained promise never rejects.
      const initSettlement = this.initSettlementPromises.get(workspaceId);
      if (initSettlement != null) {
        await initSettlement;
      }

      const { projectPath, workspacePath } = workspace;
      // Prefer the caller's pinned behavior: model-facing callers make interruption and
      // eligibility decisions against one read, and the sink honoring that same read keeps the
      // whole operation coherent under concurrent settings flips.
      const worktreeArchiveBehavior =
        options?.worktreeArchiveBehaviorOverride ?? this.getWorktreeArchiveBehavior();
      const forbidDeleteCheckNeeded =
        options?.forbidWorktreeCheckoutDeletion === true && worktreeArchiveBehavior === "delete";
      const snapshotBehaviorEnabled =
        !this.isSharedTaskWorkspace(workspaceId) &&
        worktreeArchiveBehavior === "snapshot" &&
        this.worktreeArchiveSnapshotService != null;

      let beforeArchiveMetadata: WorkspaceMetadata | undefined;
      if (this.workspaceLifecycleHooks || snapshotBehaviorEnabled || forbidDeleteCheckNeeded) {
        const metadataResult = await this.aiService.getWorkspaceMetadata(workspaceId);
        if (!metadataResult.success) {
          return Err(metadataResult.error);
        }
        beforeArchiveMetadata = metadataResult.data;
      }

      // Enforced at the sink, not just in callers: this read is the same snapshot passed to the
      // afterArchive worktree-deletion hook, so a concurrent settings flip cannot slip a
      // checkout deletion past a caller that forbade it. Scoped to targets the worktree
      // archive hook would actually delete (managed worktrees not shared via isolation:none);
      // for other runtimes the delete policy cannot destroy a checkout, so it must not make
      // reversible archive unavailable. Fails closed when metadata is unavailable.
      if (forbidDeleteCheckNeeded) {
        const runsManagedWorktreeDeletion =
          beforeArchiveMetadata == null ||
          (isWorktreeRuntime(beforeArchiveMetadata.runtimeConfig) &&
            beforeArchiveMetadata.taskIsolation !== "none");
        if (runsManagedWorktreeDeletion) {
          return Err(
            'Worktree archive behavior is set to "Delete checkout", which this caller forbids because it deletes the checkout without user confirmation.'
          );
        }
      }

      // Snapshot the Coder archive policy once: the before-archive hook receives this same
      // value, so a settings flip cannot slip a remote deletion past the guard below. Callers
      // that already pinned a read before committing to the archive (e.g. before interrupting
      // turns) pass it as an override so the whole operation honors one policy.
      const coderWorkspaceArchiveBehavior =
        options?.coderWorkspaceArchiveBehaviorOverride ??
        this.config.loadConfigOrDefault().coderWorkspaceArchiveBehavior ??
        DEFAULT_CODER_ARCHIVE_BEHAVIOR;
      const beforeArchiveRuntimeConfig = beforeArchiveMetadata?.runtimeConfig;
      const isDedicatedCoderWorkspace =
        beforeArchiveRuntimeConfig != null &&
        isSSHRuntime(beforeArchiveRuntimeConfig) &&
        beforeArchiveRuntimeConfig.coder != null &&
        beforeArchiveRuntimeConfig.coder.existingWorkspace !== true &&
        (beforeArchiveRuntimeConfig.coder.workspaceName?.trim() ?? "") !== "";
      if (options?.forbidCoderWorkspaceDeletion === true) {
        if (isDedicatedCoderWorkspace && coderWorkspaceArchiveBehavior === "delete") {
          return Err(
            'Coder workspace archive behavior is set to "Delete", which would permanently delete the dedicated remote Coder workspace without user confirmation (unarchive cannot recreate it). Ask the user to archive this workspace manually or change the Coder archive behavior.'
          );
        }
      }

      const canSnapshotManagedWorktree =
        snapshotBehaviorEnabled &&
        beforeArchiveMetadata != null &&
        isWorktreeRuntime(beforeArchiveMetadata.runtimeConfig);
      const shouldSkipSnapshotCapture =
        canSnapshotManagedWorktree &&
        beforeArchiveMetadata != null &&
        Array.isArray(beforeArchiveMetadata.projects) &&
        beforeArchiveMetadata.projects.length > 1;
      const needsSnapshotCapture = canSnapshotManagedWorktree && !shouldSkipSnapshotCapture;

      // Native terminals and external editors are detached and untrackable (see
      // hasUntrackableExternalAppOpen): when this archive would capture a snapshot and remove
      // the managed worktree — or stop a dedicated remote Coder workspace the user may still
      // be connected to through such an app — a model-driven archive must not pull the
      // environment out from under a user's live shell or editor. Mirrors the lifecycle
      // caller's early refusal against the same pinned behavior reads. ("delete" for a
      // dedicated Coder workspace is refused outright above, so non-"keep" here means stop.)
      const stopsDedicatedCoderWorkspace =
        isDedicatedCoderWorkspace && coderWorkspaceArchiveBehavior !== "keep";
      if (
        options?.refuseLiveUserActivity === true &&
        (needsSnapshotCapture || stopsDedicatedCoderWorkspace) &&
        (await this.hasUntrackableExternalAppOpen(workspaceId))
      ) {
        return Err(
          "A native terminal or external editor was opened for this workspace and its lifetime cannot be tracked; the archive policy would remove the checkout or stop the dedicated remote Coder workspace under it. Ask the user to archive this workspace manually."
        );
      }

      if (needsSnapshotCapture && beforeArchiveMetadata) {
        const initialArchiveConfirmationResult = await this.getArchiveUntrackedFilesConfirmation({
          workspaceId,
          workspaceMetadata: beforeArchiveMetadata,
          acknowledgedUntrackedPaths,
        });
        if (!initialArchiveConfirmationResult.success) {
          return Err(initialArchiveConfirmationResult.error);
        }
        if (initialArchiveConfirmationResult.data) {
          return Ok(initialArchiveConfirmationResult.data);
        }
      }

      // Lifecycle hooks run *before* we persist archivedAt.
      //
      // NOTE: Archiving is typically a quick UI action, but it can fail if a hook needs to perform
      // cleanup (e.g., stopping a dedicated mux-created Coder workspace) and that cleanup fails.
      if (this.workspaceLifecycleHooks && beforeArchiveMetadata) {
        const hookResult = await this.workspaceLifecycleHooks.runBeforeArchive({
          workspaceId,
          workspaceMetadata: beforeArchiveMetadata,
          coderWorkspaceArchiveBehavior,
          // Model-facing archives (refuseLiveUserActivity) must not stop a running remote
          // workspace under a surviving detached job the host-local orphan scans cannot see.
          refuseStopUnderUnverifiedRemoteJobs: options?.refuseLiveUserActivity === true,
        });
        if (!hookResult.success) {
          return Err(hookResult.error);
        }
      }

      let capturedWorktreeSnapshot: WorktreeArchiveSnapshot | undefined;
      if (
        needsSnapshotCapture &&
        beforeArchiveMetadata &&
        isWorktreeRuntime(beforeArchiveMetadata.runtimeConfig)
      ) {
        const latestArchiveConfirmationResult = await this.getArchiveUntrackedFilesConfirmation({
          workspaceId,
          workspaceMetadata: beforeArchiveMetadata,
          acknowledgedUntrackedPaths,
        });
        if (!latestArchiveConfirmationResult.success) {
          return Err(latestArchiveConfirmationResult.error);
        }
        if (latestArchiveConfirmationResult.data) {
          return Ok(latestArchiveConfirmationResult.data);
        }

        if (acknowledgedUntrackedPaths != null) {
          log.info("Archive proceeding with acknowledged lossy untracked files", {
            workspaceId,
            acknowledgedPaths: acknowledgedUntrackedPaths,
          });
        }

        await this.closeDesktopSessionBestEffort(workspaceId, "archive");
        await this.stopLiveWorkspaceActivityForArchive(workspaceId);

        // Pass acknowledgedUntrackedPaths to capture so it re-verifies at capture time,
        // closing the remaining race window between the final confirmation check and the
        // actual snapshot capture work.
        const captureResult = await this.worktreeArchiveSnapshotService!.captureSnapshotForArchive({
          workspaceId,
          workspaceMetadata: beforeArchiveMetadata,
          acknowledgedUntrackedPaths,
        });
        if (!captureResult.success) {
          if (isArchiveLossyUntrackedFilesConfirmation(captureResult.error)) {
            return Ok(captureResult.error);
          }
          return Err(captureResult.error);
        }
        capturedWorktreeSnapshot = captureResult.data;
      }

      // Let borrowed viewers release input before archivedAt revokes their bridge identity.
      if (!needsSnapshotCapture) await this.closeDesktopSessionBestEffort(workspaceId, "archive");

      await this.config.editConfig((config) => {
        const projectConfig = config.projects.get(projectPath);
        if (projectConfig) {
          const workspaceEntry =
            projectConfig.workspaces.find((w) => w.id === workspaceId) ??
            projectConfig.workspaces.find((w) => w.path === workspacePath);
          if (workspaceEntry) {
            // Just set archivedAt - archived state is derived from archivedAt > unarchivedAt.
            workspaceEntry.archivedAt = new Date().toISOString();
            // A shared-desktop child releases the owner's desktop in the same edit.
            settleArchivedSharedDesktopTask(workspaceEntry);
            // Archiving clears the pin; unarchive does not restore it.
            delete workspaceEntry.pinnedAt;
            if (capturedWorktreeSnapshot) {
              workspaceEntry.worktreeArchiveSnapshot = capturedWorktreeSnapshot;
            } else {
              delete workspaceEntry.worktreeArchiveSnapshot;
            }
          }
        }
        return config;
      });

      // Startup housekeeping may still be recovering this chat in a transient session whose
      // stream has not started yet, so the stream stop cannot see it. Disposing it once
      // archivedAt is durable stops its pending auto-retry or follow-up dispatch; a session the
      // scheduling loop creates later sees the archived entry and is never started.
      const transientRecoverySession = this.transientStartupRecoverySessions.get(workspaceId);
      if (transientRecoverySession) {
        await this.disposeSession(workspaceId);
      }

      if (!needsSnapshotCapture) {
        try {
          await this.stopLiveWorkspaceActivityForArchive(workspaceId);
        } catch (error) {
          log.debug("Failed to stop live workspace activity after archive persistence", {
            workspaceId,
            error: getErrorMessage(error),
          });
        }
      }

      // DevTools debug logs can be huge and are only useful for live workspaces; drop them
      // once the archived state is durable (worst case after unarchive is an empty DevTools
      // panel). Best-effort: archive stays successful even if this fails — the startup sweep
      // in initialize() retries for archived workspaces.
      try {
        await this.devToolsService?.removeWorkspaceData(workspaceId);
      } catch (error) {
        log.debug("Failed to remove DevTools log after archive", {
          workspaceId,
          error: getErrorMessage(error),
        });
      }

      // Emit updated metadata
      const allMetadata = await this.config.getAllWorkspaceMetadata();
      const updatedMetadata = allMetadata.find((m) => m.id === workspaceId);
      if (updatedMetadata) {
        const enrichedMetadata = this.enrichFrontendMetadata(updatedMetadata);
        const session = this.sessions.get(workspaceId);
        if (session) {
          session.emitMetadata(enrichedMetadata);
        } else {
          this.emit("metadata", { workspaceId, metadata: enrichedMetadata });
        }
      }

      // Lifecycle hooks run after we persist archivedAt.
      //
      // Why best-effort: Archive should stay successful once the archived state is durable, even if
      // follow-up cleanup like managed worktree deletion fails.
      if (this.workspaceLifecycleHooks) {
        let hookMetadata: WorkspaceMetadata | undefined = updatedMetadata;
        if (!hookMetadata) {
          const metadataResult = await this.aiService.getWorkspaceMetadata(workspaceId);
          if (!metadataResult.success) {
            log.debug("Failed to load workspace metadata for afterArchive hook", {
              workspaceId,
              error: metadataResult.error,
            });
          } else {
            hookMetadata = metadataResult.data;
          }
        }

        if (hookMetadata) {
          await this.workspaceLifecycleHooks.runAfterArchive({
            workspaceId,
            workspaceMetadata: hookMetadata,
            // Same read that decided snapshot capture above; keeps the deletion decision
            // consistent with the capture decision under concurrent settings changes.
            worktreeArchiveBehavior,
          });
          await this.emitCurrentWorkspaceMetadata(workspaceId);
        }
      }

      // Dream trigger (PRD #3534): final consolidation pass — last chance to
      // promote durable workspace-scope lessons to the narrowest available scope
      // before the workspace's memory dies with it. Fire-and-forget; never blocks archive.
      this.memoryConsolidationService?.triggerInBackground(workspaceId, "archive");

      // Dispose the workspace's persistent sandbox mount (snapshot-then-dispose
      // inside disposeScope keeps vars recoverable on un-archive).
      await sandboxHostService.disposeScope(workspaceId);

      // Plugin hooks re-register lazily on the next send after un-archive, so
      // disposal here only frees runtimes and spine middleware. Never throws.
      await agentPluginHookService.disposeWorkspace(workspaceId);

      await this.syncCodeWorkspaceFiles({
        projectPath,
        projects: beforeArchiveMetadata?.projects,
        subProjectPath: beforeArchiveMetadata?.subProjectPath,
      });
      eventSpine.emit("workspace.archived", { workspaceId });
      return Ok({ kind: "archived" as const });
    } catch (error) {
      const message = getErrorMessage(error);
      return Err(`Failed to archive workspace: ${message}`);
    } finally {
      admissionHold?.[Symbol.dispose]();
      this.archivingWorkspaces.delete(workspaceId);
    }
  }

  /**
   * Unarchive a workspace. Restores it to the main sidebar view.
   */
  async unarchive(workspaceId: string): Promise<Result<void>> {
    // Serialize with archive under the same task-tree lifecycle lock: an unarchive admitted
    // while an archive is still running its post-persist cleanup (e.g. worktree deletion after
    // a snapshot) could restore a checkout the archive hook then removes, leaving a visible
    // workspace with a missing checkout.
    return await this.withTaskTreeLifecycleLock(workspaceId, async () =>
      this.unarchiveUnlocked(workspaceId)
    );
  }

  /**
   * Internal entry point for task orchestration callers that already hold the task-tree lifecycle
   * lock (the model-facing unarchive path pre-acquires it for lock ordering; agent-task
   * ancestry unarchive runs under the send path's tree lock).
   */
  async unarchiveWhileTaskTreeLocked(workspaceId: string): Promise<Result<void>> {
    return await this.unarchiveUnlocked(workspaceId);
  }

  private async unarchiveUnlocked(workspaceId: string): Promise<Result<void>> {
    try {
      const workspace = this.config.findWorkspace(workspaceId);
      if (!workspace) {
        return Err("Workspace not found");
      }
      const { projectPath, workspacePath } = workspace;

      let didUnarchive = false;
      let previousUnarchivedAt: string | undefined;
      let persistedUnarchivedAt: string | undefined;

      await this.config.editConfig((config) => {
        const projectConfig = config.projects.get(projectPath);
        if (projectConfig) {
          const workspaceEntry =
            projectConfig.workspaces.find((w) => w.id === workspaceId) ??
            projectConfig.workspaces.find((w) => w.path === workspacePath);
          if (workspaceEntry) {
            const wasArchived = isWorkspaceArchived(
              workspaceEntry.archivedAt,
              workspaceEntry.unarchivedAt
            );
            if (wasArchived) {
              // Just set unarchivedAt - archived state is derived from archivedAt > unarchivedAt.
              // This also bumps workspace to top of recency.
              previousUnarchivedAt = workspaceEntry.unarchivedAt;
              persistedUnarchivedAt = new Date().toISOString();
              workspaceEntry.unarchivedAt = persistedUnarchivedAt;
              // Records archived before archive-time settlement must reappear as interrupted,
              // never as a competing active desktop controller.
              settleArchivedSharedDesktopTask(workspaceEntry);
              didUnarchive = true;
            }
          }
        }
        return config;
      });

      // Only run hooks when the workspace is transitioning from archived → unarchived.
      if (!didUnarchive) {
        return Ok(undefined);
      }

      // Emit updated metadata
      const allMetadata = await this.config.getAllWorkspaceMetadata();
      const updatedMetadata = allMetadata.find((m) => m.id === workspaceId);
      if (updatedMetadata) {
        const enrichedMetadata = this.enrichFrontendMetadata(updatedMetadata);
        const session = this.sessions.get(workspaceId);
        if (session) {
          session.emitMetadata(enrichedMetadata);
        } else {
          this.emit("metadata", { workspaceId, metadata: enrichedMetadata });
        }
      }

      let hookMetadata: WorkspaceMetadata | undefined = updatedMetadata;
      if (!hookMetadata && (this.workspaceLifecycleHooks || this.worktreeArchiveSnapshotService)) {
        const metadataResult = await this.aiService.getWorkspaceMetadata(workspaceId);
        if (metadataResult.success) {
          hookMetadata = metadataResult.data;
        } else {
          log.debug("Failed to load workspace metadata for unarchive follow-up work", {
            workspaceId,
            error: metadataResult.error,
          });
        }
      }

      if (this.worktreeArchiveSnapshotService && hookMetadata) {
        const restoreResult =
          await this.worktreeArchiveSnapshotService.restoreSnapshotAfterUnarchive({
            workspaceId,
            workspaceMetadata: hookMetadata,
          });
        if (!restoreResult.success) {
          log.debug("Failed to restore worktree archive snapshot during unarchive", {
            workspaceId,
            error: restoreResult.error,
          });
          if (persistedUnarchivedAt) {
            await this.config.editConfig((config) => {
              const projectConfig = config.projects.get(projectPath);
              const workspaceEntry =
                projectConfig?.workspaces.find((w) => w.id === workspaceId) ??
                projectConfig?.workspaces.find((w) => w.path === workspacePath);
              if (workspaceEntry && workspaceEntry.unarchivedAt === persistedUnarchivedAt) {
                if (previousUnarchivedAt === undefined) {
                  delete workspaceEntry.unarchivedAt;
                } else {
                  workspaceEntry.unarchivedAt = previousUnarchivedAt;
                }
              }
              return config;
            });
            await this.emitCurrentWorkspaceMetadata(workspaceId);
          }
          return Err(restoreResult.error);
        }
      }

      // Restoration succeeded, so the unarchive is final from here: monitor attention held while
      // archived (see dispatchBashMonitorWake) wakes after lifecycle startup below, and still
      // wakes when a follow-up step throws, since a retried unarchive would take the
      // !didUnarchive exit and never reach this point again.
      try {
        // Lifecycle hooks run *after* we persist unarchivedAt.
        //
        // Why best-effort: Unarchive is a quick UI action and should not fail permanently due to a
        // start error (e.g., Coder workspace start).
        if (this.workspaceLifecycleHooks && hookMetadata) {
          await this.workspaceLifecycleHooks.runAfterUnarchive({
            workspaceId,
            workspaceMetadata: hookMetadata,
          });
        }

        if (this.workspaceLifecycleHooks || this.worktreeArchiveSnapshotService) {
          await this.emitCurrentWorkspaceMetadata(workspaceId);
        }

        await this.syncCodeWorkspaceFiles({
          projectPath,
          projects: hookMetadata?.projects,
          subProjectPath: hookMetadata?.subProjectPath,
        });
      } finally {
        this.scheduleBashMonitorWakeReconcile(workspaceId);
      }

      // Archived owners park workflow terminal wakes unsettled; reconcile so an idle
      // workspace does not stay silent until the interval sweep. Only AFTER snapshot
      // restoration and lifecycle startup above: the drain can admit a synthetic agent turn,
      // which must not run against a half-restored checkout or precede a failed restoration's
      // config rollback. Contained: reconciliation failure must not fail the unarchive (the
      // sweep retries on its own cadence).
      try {
        await this.agentTaskIntegration?.noteWorkspaceUnarchived(workspaceId);
      } catch (error: unknown) {
        log.warn("Unarchive workflow attention reconciliation failed", { workspaceId, error });
      }

      return Ok(undefined);
    } catch (error) {
      const message = getErrorMessage(error);
      return Err(`Failed to unarchive workspace: ${message}`);
    }
  }

  async deleteWorktree(workspaceId: string): Promise<Result<void>> {
    try {
      const allMetadata = await this.config.getAllWorkspaceMetadata();
      const workspaceMetadata = allMetadata.find((metadata) => metadata.id === workspaceId);
      if (!workspaceMetadata) {
        return Err("Workspace not found");
      }

      if (!isWorkspaceArchived(workspaceMetadata.archivedAt, workspaceMetadata.unarchivedAt)) {
        return Err("Only archived workspaces can delete their managed worktree");
      }

      if (workspaceMetadata.taskIsolation === "none") {
        return Err("Shared-checkout sub-agents do not own a managed worktree");
      }

      if (!isWorktreeRuntime(workspaceMetadata.runtimeConfig)) {
        return Err("Deleting a managed worktree is only supported for worktree runtimes");
      }

      const managedPath = workspaceMetadata.namedWorkspacePath;
      await removeManagedGitWorktree(workspaceMetadata.projectPath, managedPath);
      await this.emitCurrentWorkspaceMetadata(workspaceId);
      return Ok(undefined);
    } catch (error) {
      const message = getErrorMessage(error);
      return Err(`Failed to delete managed worktree: ${message}`);
    }
  }

  async stopRuntime(workspaceId: string): Promise<Result<void>> {
    const metadataResult = await this.aiService.getWorkspaceMetadata(workspaceId);
    if (!metadataResult.success) {
      return Err(metadataResult.error);
    }

    if (this.aiService.isStreaming(workspaceId)) {
      return Err("Cannot stop: workspace has an active AI stream");
    }

    // Treat any open terminal as active, even if idle, so we do not tear down a runtime with
    // attached shells still open in the UI.
    const workspaceActivity = this.terminalService?.getWorkspaceActivity(workspaceId);
    if ((workspaceActivity?.totalSessions ?? 0) > 0) {
      return Err("Cannot stop: workspace has active sessions");
    }

    const metadata = metadataResult.data;
    if (metadata.runtimeConfig.type !== "devcontainer") {
      return Err(`Runtime stop is unsupported for ${metadata.runtimeConfig.type} workspaces`);
    }

    const stopResult = await stopDevcontainer(
      await this.getDevcontainerHostWorkspacePath(workspaceId)
    );
    if (stopResult.kind === "error") {
      return Err(`Failed to stop runtime: ${stopResult.message}`);
    }

    return Ok(undefined);
  }

  async getRuntimeStatuses(
    workspaceIds: string[]
  ): Promise<Record<string, WorkspaceRuntimeStatus>> {
    const statuses: Record<string, WorkspaceRuntimeStatus> = {};
    for (const workspaceId of workspaceIds) {
      statuses[workspaceId] = "unknown";
    }

    if (workspaceIds.length === 0) {
      return statuses;
    }

    let allMetadata: WorkspaceMetadata[];
    try {
      allMetadata = await this.config.getAllWorkspaceMetadata();
    } catch (error) {
      log.debug("Failed to load workspace metadata for runtime status checks", {
        error: getErrorMessage(error),
      });
      return statuses;
    }

    const metadataById = new Map(allMetadata.map((metadata) => [metadata.id, metadata]));
    const devcontainerWorkspaces: Array<{ workspaceId: string; hostWorkspacePath: string }> = [];

    for (const workspaceId of workspaceIds) {
      const metadata = metadataById.get(workspaceId);
      if (!metadata) {
        continue;
      }

      if (metadata.runtimeConfig.type !== "devcontainer") {
        statuses[workspaceId] = "unsupported";
        continue;
      }

      try {
        devcontainerWorkspaces.push({
          workspaceId,
          hostWorkspacePath: await this.getDevcontainerHostWorkspacePath(workspaceId),
        });
      } catch (error) {
        log.debug("Failed to resolve devcontainer workspace path for runtime status", {
          workspaceId,
          error: getErrorMessage(error),
        });
      }
    }

    // Passive status probes must not call ensureReady(); Docker labels are enough to tell
    // whether devcontainers are already running. Probe all requested paths with one docker ps.
    const probeResults = await probeDevcontainerStatuses(
      devcontainerWorkspaces.map((workspace) => workspace.hostWorkspacePath)
    );
    for (const workspace of devcontainerWorkspaces) {
      const probeResult = probeResults[workspace.hostWorkspacePath] ?? { kind: "absent" as const };
      statuses[workspace.workspaceId] =
        probeResult.kind === "found"
          ? "running"
          : probeResult.kind === "absent"
            ? "stopped"
            : "unknown";
    }

    return statuses;
  }

  async getProjectGitStatuses(
    workspaceId: string,
    baseRef?: string | null
  ): Promise<ProjectGitStatusResult[]> {
    assert(workspaceId.trim().length > 0, "getProjectGitStatuses requires a workspaceId");

    const metadataResult = await this.aiService.getWorkspaceMetadata(workspaceId);
    if (!metadataResult.success) {
      throw new Error(`Failed to get workspace metadata: ${metadataResult.error}`);
    }

    const metadata = metadataResult.data;
    assert(metadata, `Workspace ${workspaceId} metadata is required for git status checks`);

    if (metadata.kind === "scratch") {
      return [];
    }

    const projects = getProjects(metadata);
    assert(projects.length > 0, `Workspace ${workspaceId} must include at least one project`);

    const normalizedProjectPaths = projects.map((project) => {
      assert(
        project.projectPath.trim().length > 0,
        `Workspace ${workspaceId} project ${project.projectName} is missing a projectPath`
      );
      assert(
        project.projectName.trim().length > 0,
        `Workspace ${workspaceId} project ${project.projectPath} is missing a projectName`
      );
      const normalizedProjectPath = normalizeRepoRootProjectPath(project.projectPath);
      assert(
        normalizedProjectPath.length > 0,
        `Workspace ${workspaceId} project ${project.projectName} normalized to an empty projectPath`
      );
      return normalizedProjectPath;
    });
    const uniqueNormalizedProjectPaths = new Set(normalizedProjectPaths);
    assert(
      uniqueNormalizedProjectPaths.size === normalizedProjectPaths.length,
      `Workspace ${workspaceId} has duplicate project paths`
    );

    const script = generateGitStatusScript(baseRef ?? undefined);
    const results: ProjectGitStatusResult[] = [];

    for (const project of projects) {
      try {
        const result = await this.executeBash(workspaceId, script, {
          cwdMode: "repo-root",
          repoRootProjectPath: project.projectPath,
          timeout_secs: 5,
        });

        if (!result.success) {
          results.push({
            projectPath: project.projectPath,
            projectName: project.projectName,
            gitStatus: null,
            error: result.error,
          });
          continue;
        }

        if (!result.data.success) {
          results.push({
            projectPath: project.projectPath,
            projectName: project.projectName,
            gitStatus: null,
            error: result.data.error,
          });
          continue;
        }

        if (result.data.output.trim().length === 0) {
          results.push({
            projectPath: project.projectPath,
            projectName: project.projectName,
            gitStatus: null,
            error: "Git status script returned empty output",
          });
          continue;
        }

        const parsed = parseGitStatusScriptOutput(result.data.output);
        if (!parsed) {
          results.push({
            projectPath: project.projectPath,
            projectName: project.projectName,
            gitStatus: null,
            error: "Failed to parse git status script output",
          });
          continue;
        }

        results.push({
          projectPath: project.projectPath,
          projectName: project.projectName,
          gitStatus: {
            branch: parsed.headBranch,
            ahead: parsed.ahead,
            behind: parsed.behind,
            dirty: parsed.dirtyCount > 0,
            outgoingAdditions: parsed.outgoingAdditions,
            outgoingDeletions: parsed.outgoingDeletions,
            incomingAdditions: parsed.incomingAdditions,
            incomingDeletions: parsed.incomingDeletions,
          },
          error: null,
        });
      } catch (error) {
        results.push({
          projectPath: project.projectPath,
          projectName: project.projectName,
          gitStatus: null,
          error: getErrorMessage(error),
        });
      }
    }

    assert(
      results.length === projects.length,
      `Workspace ${workspaceId} git status result count must match project count`
    );
    const resultProjectPaths = results.map((result) =>
      normalizeRepoRootProjectPath(result.projectPath)
    );
    assert(
      new Set(resultProjectPaths).size === uniqueNormalizedProjectPaths.size,
      `Workspace ${workspaceId} git status results must contain one entry per project`
    );
    for (const resultProjectPath of resultProjectPaths) {
      assert(
        uniqueNormalizedProjectPaths.has(resultProjectPath),
        `Workspace ${workspaceId} git status returned an unknown project path: ${resultProjectPath}`
      );
    }

    return results;
  }

  /**
   * Archive all non-archived workspaces within a project whose GitHub PR is merged.
   *
   * This is intended for a single command-palette action (one backend call), to avoid
   * O(n) frontend→backend loops.
   */
  async archiveMergedInProject(projectPath: string): Promise<Result<ArchiveMergedInProjectResult>> {
    const targetProjectPath = projectPath.trim();
    if (!targetProjectPath) {
      return Err("projectPath is required");
    }

    const archivedWorkspaceIds: string[] = [];
    const skippedWorkspaceIds: string[] = [];
    const errors: Array<{ workspaceId: string; error: string }> = [];

    try {
      const allMetadata = await this.config.getAllWorkspaceMetadata();

      const candidates = allMetadata.filter((metadata) => {
        if (metadata.projectPath !== targetProjectPath) {
          return false;
        }
        return !isWorkspaceArchived(metadata.archivedAt, metadata.unarchivedAt);
      });

      const mergedWorkspaceIds: string[] = [];

      const GH_CONCURRENCY_LIMIT = 4;
      const GH_TIMEOUT_SECS = 15;

      await forEachWithConcurrencyLimit(candidates, GH_CONCURRENCY_LIMIT, async (metadata) => {
        const workspaceId = metadata.id;

        try {
          const result = await this.executeBash(
            workspaceId,
            `gh pr view --json state 2>/dev/null || echo '{"no_pr":true}'`,
            {
              timeout_secs: GH_TIMEOUT_SECS,
              // gh requires the runtime environment — devcontainer auth/CLI
              // may only exist inside the container.
            }
          );

          if (!result.success) {
            errors.push({ workspaceId, error: result.error });
            return;
          }

          if (!result.data.success) {
            errors.push({ workspaceId, error: result.data.error });
            return;
          }

          const output = result.data.output;
          if (!output || output.trim().length === 0) {
            errors.push({ workspaceId, error: "gh pr view returned empty output" });
            return;
          }

          let parsed: unknown;
          try {
            parsed = JSON.parse(output);
          } catch (error) {
            const message = getErrorMessage(error);
            errors.push({ workspaceId, error: `Failed to parse gh output: ${message}` });
            return;
          }

          if (typeof parsed !== "object" || parsed === null) {
            errors.push({ workspaceId, error: "Unexpected gh output: not a JSON object" });
            return;
          }

          const record = parsed as Record<string, unknown>;

          if ("no_pr" in record) {
            skippedWorkspaceIds.push(workspaceId);
            return;
          }

          if (record.state === "MERGED") {
            mergedWorkspaceIds.push(workspaceId);
            return;
          }

          skippedWorkspaceIds.push(workspaceId);
        } catch (error) {
          const message = getErrorMessage(error);
          errors.push({ workspaceId, error: message });
        }
      });

      // Archive sequentially: config.editConfig is not mutex-protected.
      for (const workspaceId of mergedWorkspaceIds) {
        const result = await this.archive(workspaceId);
        if (!result.success) {
          errors.push({ workspaceId, error: result.error });
          continue;
        }
        if (result.data.kind !== "archived") {
          errors.push({
            workspaceId,
            error: `Archive requires confirmation for untracked files: ${result.data.paths.join(", ")}`,
          });
          continue;
        }
        archivedWorkspaceIds.push(workspaceId);
      }

      archivedWorkspaceIds.sort();
      skippedWorkspaceIds.sort();
      errors.sort((a, b) => a.workspaceId.localeCompare(b.workspaceId));

      return Ok({
        archivedWorkspaceIds,
        skippedWorkspaceIds,
        errors,
      });
    } catch (error) {
      const message = getErrorMessage(error);
      return Err(`Failed to archive merged workspaces: ${message}`);
    }
  }

  private normalizeWorkspaceAISettings(
    aiSettings: WorkspaceAISettings
  ): Result<WorkspaceAISettings, string> {
    const rawModel = aiSettings.model;
    const model = normalizeSelectedModel(rawModel).trim();
    if (!model) {
      return Err("Model is required");
    }
    if (!isValidModelFormat(model)) {
      return Err(`Invalid model format: ${rawModel}`);
    }

    return Ok({
      model,
      thinkingLevel: aiSettings.thinkingLevel,
      ...(aiSettings.reasoningMode != null ? { reasoningMode: aiSettings.reasoningMode } : {}),
    });
  }

  private normalizeSendMessageAgentId(options: SendMessageOptions): SendMessageOptions {
    // agentId is required by the schema, so this just normalizes the value.
    const rawAgentId = options.agentId;
    const normalizedAgentId = normalizeAgentId(rawAgentId, WORKSPACE_DEFAULTS.agentId);

    if (normalizedAgentId === options.agentId) {
      return options;
    }

    return {
      ...options,
      agentId: normalizedAgentId,
    };
  }

  private extractWorkspaceAISettingsFromSendOptions(
    options: SendMessageOptions | undefined
  ): WorkspaceAISettings | null {
    const rawModel = options?.model;
    if (typeof rawModel !== "string" || rawModel.trim().length === 0) {
      return null;
    }

    const model = normalizeSelectedModel(rawModel).trim();
    if (!isValidModelFormat(model)) {
      return null;
    }

    const requestedThinking = options?.thinkingLevel;
    // Be defensive: if a (very) old client doesn't send thinkingLevel, don't overwrite
    // any existing workspace-scoped value.
    if (requestedThinking === undefined) {
      return null;
    }

    const thinkingLevel = requestedThinking;

    // reasoningMode is optional: old clients omit it and the persist path then
    // preserves any previously stored value instead of wiping it.
    const reasoningMode = options?.reasoningMode;

    return { model, thinkingLevel, ...(reasoningMode != null ? { reasoningMode } : {}) };
  }

  /**
   * Pre-dispatch gate at the WorkspaceService boundary. Delegates to
   * `WorkspaceGoalService.assertPricedModelForBudgetedGoal` so the gate
   * lives in exactly one place; this layer exists so `sendMessage` /
   * `resumeStream` reject before persisting an unpriced model into the
   * workspace's AI settings (otherwise the user's stored model selection
   * gets corrupted on a rejected request).
   *
   * The same gate runs again inside `AgentSession.sendMessage` to cover
   * every dispatch path (queued messages, internal compaction/heartbeat
   * sends, agent-switch follow-ups), so a budgeted goal that becomes
   * resumable after queueing still cannot bypass enforcement.
   */
  private async assertPricedModelForBudgetedGoal(
    workspaceId: string,
    options: SendMessageOptions | undefined
  ): Promise<Result<void, SendMessageError>> {
    return (
      (await this.workspaceGoalService?.assertPricedModelForBudgetedGoal(
        workspaceId,
        options?.model
      )) ?? Ok(undefined)
    );
  }

  private async maybePersistAISettingsFromOptions(
    workspaceId: string,
    options: SendMessageOptions | undefined
  ): Promise<void> {
    if (options?.skipAiSettingsPersistence) {
      // One-shot/compaction sends shouldn't overwrite workspace defaults.
      return;
    }

    const rawAgentId = options?.agentId;
    const agentId = normalizeAgentId(rawAgentId, WORKSPACE_DEFAULTS.agentId);
    const extractedSettings = this.extractWorkspaceAISettingsFromSendOptions(options);

    const persistResult = await this.persistWorkspaceAISettingsForAgent(
      workspaceId,
      agentId,
      extractedSettings,
      {
        // Save the selected agent so heartbeats can reuse it after reloads and reconnects.
        persistSelectedAgentId: true,
        ...(options?.disableWorkspaceAgents === true ? { disableWorkspaceAgents: true } : {}),
      }
    );
    if (!persistResult.success) {
      log.debug("Failed to persist workspace AI settings from user message", {
        workspaceId,
        error: persistResult.error,
      });
    }
  }

  private async persistWorkspaceAISettingsForAgent(
    workspaceId: string,
    agentId: string,
    aiSettings: WorkspaceAISettings | null,
    options?: {
      emitMetadata?: boolean;
      disableWorkspaceAgents?: boolean;
      persistSelectedAgentId?: boolean;
    }
  ): Promise<Result<boolean, string>> {
    const found = this.config.findWorkspace(workspaceId);
    if (!found) {
      return Err("Workspace not found");
    }

    const { projectPath, workspacePath } = found;

    const normalizedAgentId = normalizeAgentId(agentId, "");
    if (!normalizedAgentId) {
      return Err("Agent ID is required");
    }

    // Removing the built-in Ask agent should not force writes into Auto's
    // settings bucket. Persist whatever agent ID the caller chose so legacy Ask
    // settings can fade out naturally instead of being mixed into Auto.

    // Hot path: this runs on every message send, so skip the queued write when a
    // snapshot read already shows no change. Skipping is race-safe — it is equivalent
    // to a serialized write of the identical value landing first, and not writing can
    // never resurrect concurrently removed entries.
    {
      const snapshotEntry = this.findFreshWorkspaceEntry(this.config.loadConfigOrDefault(), {
        projectPath,
        workspaceId,
        workspacePath,
      });
      if (!snapshotEntry) {
        return Err("Workspace not found");
      }
      const prev = snapshotEntry.aiSettingsByAgent?.[normalizedAgentId];
      const aiSettingsChanged =
        aiSettings != null &&
        (prev?.model !== aiSettings.model ||
          prev?.thinkingLevel !== aiSettings.thinkingLevel ||
          // Absent reasoningMode preserves the previous value (see write below),
          // so only an explicit different value counts as a change.
          (aiSettings.reasoningMode != null && prev?.reasoningMode !== aiSettings.reasoningMode));
      const selectedAgentChanged =
        options?.persistSelectedAgentId === true && snapshotEntry.agentId !== normalizedAgentId;
      if (!aiSettingsChanged && !selectedAgentChanged) {
        return Ok(false);
      }
    }

    // Compare/merge against the FRESH entry inside the serialized editConfig transform
    // (see findFreshWorkspaceEntry): persisting a pre-read snapshot loses concurrent
    // edits and can resurrect removed workspaces. Entry gone meanwhile → Err.
    let writeResult: Result<boolean, string> = Err("Workspace not found");
    await this.config.editConfig((freshConfig) => {
      const workspaceEntry = this.findFreshWorkspaceEntry(freshConfig, {
        projectPath,
        workspaceId,
        workspacePath,
      });
      if (!workspaceEntry) {
        writeResult = Err("Workspace not found");
        return freshConfig;
      }

      const prev = workspaceEntry.aiSettingsByAgent?.[normalizedAgentId];
      const aiSettingsChanged =
        aiSettings != null &&
        (prev?.model !== aiSettings.model ||
          prev?.thinkingLevel !== aiSettings.thinkingLevel ||
          (aiSettings.reasoningMode != null && prev?.reasoningMode !== aiSettings.reasoningMode));
      const selectedAgentChanged =
        options?.persistSelectedAgentId === true && workspaceEntry.agentId !== normalizedAgentId;
      if (!aiSettingsChanged && !selectedAgentChanged) {
        writeResult = Ok(false);
        return freshConfig;
      }

      if (aiSettings != null) {
        // Callers that omit reasoningMode (older clients, thinking-only updates)
        // must not wipe a previously persisted value — self-healing merge.
        const mergedReasoningMode = aiSettings.reasoningMode ?? prev?.reasoningMode;
        workspaceEntry.aiSettingsByAgent = {
          ...(workspaceEntry.aiSettingsByAgent ?? {}),
          [normalizedAgentId]: {
            ...aiSettings,
            ...(mergedReasoningMode != null ? { reasoningMode: mergedReasoningMode } : {}),
          },
        };
      }

      if (options?.persistSelectedAgentId === true) {
        workspaceEntry.agentId = normalizedAgentId;
      }

      writeResult = Ok(true);
      return freshConfig;
    });

    if (!writeResult.success) {
      return Err(writeResult.error);
    }
    if (!writeResult.data) {
      return Ok(false);
    }

    if (options?.emitMetadata !== false) {
      const allMetadata = await this.config.getAllWorkspaceMetadata();
      const updatedMetadata = allMetadata.find((m) => m.id === workspaceId) ?? null;
      const enrichedMetadata = this.enrichMaybeFrontendMetadata(updatedMetadata);

      const session = this.sessions.get(workspaceId);
      if (session) {
        session.emitMetadata(enrichedMetadata);
      } else {
        this.emit("metadata", { workspaceId, metadata: enrichedMetadata });
      }
    }

    return Ok(true);
  }

  async updateModeAISettings(
    workspaceId: string,
    mode: UIMode,
    aiSettings: WorkspaceAISettings
  ): Promise<Result<void, string>> {
    // Mode-based updates use mode as the agentId.
    return this.updateAgentAISettings(workspaceId, mode, aiSettings);
  }

  async updateAgentAISettings(
    workspaceId: string,
    agentId: string,
    aiSettings: WorkspaceAISettings,
    options?: { persistSelectedAgentId?: boolean }
  ): Promise<Result<void, string>> {
    try {
      const normalized = this.normalizeWorkspaceAISettings(aiSettings);
      if (!normalized.success) {
        return Err(normalized.error);
      }

      if (this.workspaceGoalService) {
        const goal = await this.workspaceGoalService.getGoal(workspaceId);
        // Use the resumable check rather than active-only: a paused or
        // budget-limited budgeted goal will resume accounting when the user
        // un-pauses or raises the budget. Letting them switch to an unpriced
        // model in the meantime silently records 0 cost on the next stream
        // and budget enforcement quietly stops working.
        if (
          hasBudgetedResumableGoal(goal) &&
          !modelHasPricingData(
            normalized.data.model,
            this.providersConfigStore.loadProvidersConfig()
          )
        ) {
          return Err(UNPRICED_TARGET_MODEL_GOAL_MESSAGE);
        }
      }

      const persistResult = await this.persistWorkspaceAISettingsForAgent(
        workspaceId,
        agentId,
        normalized.data,
        {
          emitMetadata: true,
          ...(options?.persistSelectedAgentId === true ? { persistSelectedAgentId: true } : {}),
        }
      );
      if (!persistResult.success) {
        return Err(persistResult.error);
      }

      if (persistResult.data) {
        const parsedMode = UIModeSchema.safeParse(agentId);
        this.timelineRecorder.record(workspaceId, {
          kind: "settings.changed",
          source: { system: "settings" },
          status: "completed",
          data: {
            agentId,
            model: normalized.data.model,
            mode: parsedMode.success ? parsedMode.data : undefined,
          },
        });
      }

      return Ok(undefined);
    } catch (error) {
      const message = getErrorMessage(error);
      return Err(`Failed to update workspace AI settings: ${message}`);
    }
  }

  /**
   * Mid-turn thinking change: forward the requested level to the workspace's
   * active turn (if any). Deliberately `sessions.get`, not getOrCreateSession —
   * creating a session to tell it "change the turn you don't have" is pointless;
   * persisted settings already cover the next turn.
   */
  setActiveTurnThinkingLevel(
    workspaceId: string,
    level: ThinkingLevel
  ): Result<{ accepted: boolean }, string> {
    try {
      const session = this.sessions.get(workspaceId.trim());
      if (!session) {
        return Ok({ accepted: false });
      }
      return Ok(session.setActiveTurnThinkingLevel(level));
    } catch (error) {
      return Err(`Failed to set active-turn thinking level: ${getErrorMessage(error)}`);
    }
  }

  async fork(
    sourceWorkspaceId: string,
    newName?: string,
    sourceMessageId?: string,
    pendingAutoTitle?: boolean
  ): Promise<Result<{ metadata: FrontendWorkspaceMetadata; projectPath: string }>> {
    // Source-fork admission pairs with the model-facing archive gates (same synchronous
    // block as the entry guards in sendMessage/executeBash): a fork admitted first is
    // visible to the sink and the pre-interruption hold via preflightForkCounts and refuses
    // the archive; a fork entering later observes archivingWorkspaces and refuses here.
    // Without this pairing, a Coder-stop archive could stop the dedicated remote workspace
    // mid-clone while the fork shares it, and the child's init could restart it afterwards.
    if (this.archivingWorkspaces.has(sourceWorkspaceId)) {
      return Err(`Workspace is being archived: ${sourceWorkspaceId}. Unarchive it before forking.`);
    }
    using _preflightFork = this.acquirePreflightAdmission(
      this.preflightForkCounts,
      sourceWorkspaceId
    );
    try {
      const sourceMetadataResult = await this.aiService.getWorkspaceMetadata(sourceWorkspaceId);
      if (!sourceMetadataResult.success) {
        return Err(`Failed to get source workspace metadata: ${sourceMetadataResult.error}`);
      }
      const sourceMetadata = sourceMetadataResult.data;
      if (sourceMetadata.kind === "scratch") {
        return Err("Forking scratch chats is not supported yet");
      }
      const partialSnapshot =
        sourceMessageId == null ? await this.historyService.readPartial(sourceWorkspaceId) : null;
      const foundProjectPath = sourceMetadata.projectPath;
      const projectName = sourceMetadata.projectName;
      const sourceRuntimeConfig = sourceMetadata.runtimeConfig;

      // Policy: do not allow creating new workspaces (including via fork) with a disallowed runtime.
      if (this.policyService?.isEnforced()) {
        if (!this.policyService.isRuntimeAllowed(sourceRuntimeConfig)) {
          return Err("Forking this workspace is not allowed by policy (runtime disabled)");
        }
      }

      // Trust gate: block fork for untrusted projects.
      // Same defense-in-depth as create() — the frontend shows a dialog,
      // but forking is a secondary creation path that needs backend gating.
      const projectConfig = this.config
        .loadConfigOrDefault()
        .projects.get(stripTrailingSlashes(foundProjectPath));
      if (!projectConfig?.trusted) {
        return Err(
          "This project must be trusted before creating workspaces. Trust the project in Settings → Security, or create a workspace from the project page."
        );
      }

      // Auto-generate branch name (and title) when user omits one (seamless fork).
      // Uses pattern: {parentName}-{N} for branch, "{parentTitle} (N)" for title.
      const isAutoName = newName == null;
      // Fetch all metadata upfront for both branch name and title collision checks.
      const allMetadata = isAutoName ? await this.config.getAllWorkspaceMetadata() : [];
      let resolvedName: string;
      if (isAutoName) {
        const existingNamesSet = new Set(
          allMetadata.filter((m) => m.projectPath === foundProjectPath).map((m) => m.name)
        );
        // Also include local branch names to avoid silently reusing stale branches that
        // were left behind on disk but no longer exist in config metadata.
        try {
          for (const branchName of await listLocalBranches(foundProjectPath)) {
            existingNamesSet.add(branchName);
          }
        } catch (error) {
          log.debug("Failed to list local branches for fork auto-name preflight", {
            projectPath: foundProjectPath,
            error: getErrorMessage(error),
          });
        }

        const existingNames = [...existingNamesSet];
        const forkFamilyBaseName = deriveForkFamilyBaseName(sourceMetadata);
        resolvedName = generateForkBranchName(forkFamilyBaseName, existingNames);

        if (!validateWorkspaceName(resolvedName).valid) {
          // Legacy workspace names can violate current naming rules (invalid
          // chars / length). Normalize and shrink the parent base until the
          // generated fork name satisfies current invariants.
          let normalizedParent = forkFamilyBaseName
            .toLowerCase()
            .replace(/[^a-z0-9_-]+/g, "-")
            .replace(/-+/g, "-")
            .replace(/^[-_]+|[-_]+$/g, "");

          if (!normalizedParent) {
            normalizedParent = "workspace";
          }

          let candidateParent = normalizedParent;
          while (candidateParent.length > 1) {
            resolvedName = generateForkBranchName(candidateParent, existingNames);
            if (validateWorkspaceName(resolvedName).valid) {
              break;
            }
            candidateParent = candidateParent.slice(0, -1);
          }

          if (!validateWorkspaceName(resolvedName).valid) {
            resolvedName = generateForkBranchName(candidateParent, existingNames);
          }
        }
      } else {
        resolvedName = newName;
      }

      const resolvedNameValidation = validateWorkspaceName(resolvedName);
      if (!resolvedNameValidation.valid) {
        return Err(resolvedNameValidation.error ?? "Invalid workspace name");
      }

      const sourceWorkspace = this.config.findWorkspace(sourceWorkspaceId);
      const sourceRuntime = createRuntime(sourceRuntimeConfig, {
        projectPath: foundProjectPath,
        workspaceName: sourceMetadata.name,
        workspacePath: sourceWorkspace?.workspacePath,
      });

      const newWorkspaceId = this.config.generateStableId();

      const session = this.getOrCreateSession(newWorkspaceId);
      this.initStateManager.startInit(newWorkspaceId, foundProjectPath);
      const initLogger = this.createInitLogger(newWorkspaceId);

      const initAbortController = new AbortController();
      this.initAbortControllers.set(newWorkspaceId, initAbortController);

      const projectEnvCache = new Map<string, Record<string, string>>();
      const resolveProjectEnv = async (runtimeProjectPath: string) => {
        const normalizedRuntimeProjectPath = stripTrailingSlashes(runtimeProjectPath);
        const cachedEnv = projectEnvCache.get(normalizedRuntimeProjectPath);
        if (cachedEnv) {
          return cachedEnv;
        }

        const projectEnv = await secretsToRecord(
          this.secretsStore.getEffectiveSecrets(normalizedRuntimeProjectPath)
        );
        projectEnvCache.set(normalizedRuntimeProjectPath, projectEnv);
        return projectEnv;
      };
      const createEnv = await resolveProjectEnv(foundProjectPath);

      let forkResult: Awaited<ReturnType<typeof orchestrateFork>>;
      try {
        forkResult = await orchestrateFork({
          sourceRuntime,
          projectPath: foundProjectPath,
          sourceWorkspaceName: sourceMetadata.name,
          newWorkspaceName: resolvedName,
          initLogger,
          config: this.config,
          sourceWorkspaceId,
          sourceRuntimeConfig,
          parentMetadata: sourceMetadata,
          allowCreateFallback: false,
          abortSignal: initAbortController.signal,
          env: createEnv,
          projectEnvResolver: resolveProjectEnv,
          trusted: projectConfig.trusted ?? false,
          multiProjectExperimentEnabled: this.isExperimentEnabled(
            EXPERIMENT_IDS.MULTI_PROJECT_WORKSPACES
          ),
        });
      } catch (error) {
        // Guarantee init lifecycle cleanup when orchestrateFork rejects.
        // initLogger.logComplete deletes from initAbortControllers and ends init state.
        initLogger.logComplete(-1);
        throw error;
      }

      if (!forkResult.success) {
        initLogger.logComplete(-1);
        return Err(forkResult.error);
      }

      const {
        workspacePath,
        trunkBranch,
        forkedRuntimeConfig,
        targetRuntime,
        sourceRuntimeConfigUpdate,
        sourceRuntimeConfigUpdated,
      } = forkResult.data;

      // Per-workspace MCP enables live in the gitignored .xum/mcp.local.jsonc,
      // which a fresh checkout never materializes; without this copy a server
      // enabled only for the source workspace is silently gone in the fork.
      // Runs before the init hook starts (so the hook sees the fork's initial
      // configuration deterministically) and before the plugin-override
      // sanitization below (so stale plugin enables are pruned from the copy).
      // Target path = what WorkspaceMcpOverridesService will later derive for
      // the registered fork (runtime.getWorkspacePath), NOT forkResult's
      // primary-project checkout: they differ for multi-project forks, whose
      // persisted root is the multi-project container.
      await this.workspaceMcpOverridesService?.copyOverridesToForkedCheckout(sourceWorkspaceId, {
        runtime: targetRuntime,
        workspacePath: targetRuntime.getWorkspacePath(foundProjectPath, resolvedName),
        runtimeConfig: forkedRuntimeConfig,
      });

      // Run init for forked workspace (fire-and-forget like create()).
      // Multi-project forks need per-project secrets for each runtime's init hook.
      if (targetRuntime instanceof MultiProjectRuntime) {
        targetRuntime.envResolver = resolveProjectEnv;
      }

      const secrets = await resolveProjectEnv(foundProjectPath);
      // Fire-and-forget on the happy path, but keep the termination handle:
      // the sanitization-abort cleanup below deletes the fresh worktree, and
      // doing that while init still runs against the checkout races its
      // writes/open handles (a failed delete leaves an orphaned worktree that
      // collides with the next fork of the same branch).
      const initSettled = runBackgroundInit(
        targetRuntime,
        {
          projectPath: foundProjectPath,
          branchName: resolvedName,
          trunkBranch,
          workspacePath,
          initLogger,
          env: secrets,
          abortSignal: initAbortController.signal,
          trusted: projectConfig.trusted ?? false,
        },
        newWorkspaceId,
        log
      );
      // Also retained for archive: see initSettlementPromises.
      this.retainInitSettlement(newWorkspaceId, initSettled);

      // Create a fresh source runtime handle because DockerRuntime.forkWorkspace() can
      // mutate the original runtime's container identity to target the new workspace.
      const freshSourceRuntime = createRuntime(sourceRuntimeConfig, {
        projectPath: foundProjectPath,
        workspaceName: sourceMetadata.name,
        workspacePath: sourceWorkspace?.workspacePath,
      });

      const sourceSessionDir = path.join(this.config.sessionsDir, sourceWorkspaceId);
      const newSessionDir = path.join(this.config.sessionsDir, newWorkspaceId);

      // Removed tail captured inside the try, summarized only after setup
      // survives the rollback window (see the comment at the capture site).
      let abandonedBranchMessages: MuxMessage[] | null = null;
      try {
        const historyCopyResult = await this.historyService.copyHistorySnapshotToNewWorkspace(
          sourceWorkspaceId,
          newWorkspaceId
        );
        if (!historyCopyResult.success) {
          throw new Error(historyCopyResult.error);
        }

        const sessionFiles = [
          "session-timing.json",
          ADDITIONAL_SYSTEM_CONTEXT_FILENAME,
          // Preserve the enabled/disabled toggle when forking so the fork
          // behaves identically to its source from the very first turn.
          ADDITIONAL_SYSTEM_CONTEXT_DISABLED_FILENAME,
        ] as const;
        for (const fileName of sessionFiles) {
          await copyIfExists(
            path.join(sourceSessionDir, fileName),
            path.join(newSessionDir, fileName)
          );
        }

        if (sourceMessageId) {
          const truncateResult = await this.historyService.truncateAfterMessage(
            newWorkspaceId,
            sourceMessageId,
            {
              keepTargetMessage: true,
            }
          );
          if (!truncateResult.success) {
            throw new Error(truncateResult.error);
          }

          // Forking from a prior assistant response intentionally discards any later in-flight
          // state so the new workspace resumes cleanly at the chosen branch point.
          await fsPromises.rm(path.join(newSessionDir, "partial.json"), { force: true });
          if (this.sessionTimingService) {
            await this.sessionTimingService.clearTimingFile(newWorkspaceId);
          } else {
            await fsPromises.rm(path.join(newSessionDir, "session-timing.json"), { force: true });
          }

          // The abandoned tail is summarized in the background — but only
          // AFTER the failure-prone fork setup below completes (see the
          // startAbandonedBranchSummaryInBackground call past the catch).
          // Starting the writer here let a setup failure delete newSessionDir
          // without cancelling the registration: a racing append could
          // recreate the failed fork's session dir, and an early-settling
          // summary left its map entry permanently unconsumed because the
          // fork never returned.
          abandonedBranchMessages = truncateResult.data.removedMessages;
        }

        await materializeForkedPartialSnapshot({
          historyService: this.historyService,
          partialSnapshot,
          sourceWorkspaceId,
          targetWorkspaceId: newWorkspaceId,
        });

        const referencedStagedAttachmentPaths =
          await collectReferencedStagedAttachmentPaths(newSessionDir);
        if (referencedStagedAttachmentPaths.length > 0) {
          const sourceWorkspacePath = resolveWorkspaceExecutionPath(
            sourceMetadata,
            freshSourceRuntime
          );
          const targetWorkspacePath = resolveWorkspaceExecutionPath(
            {
              ...sourceMetadata,
              name: resolvedName,
              namedWorkspacePath: workspacePath,
              projectPath: foundProjectPath,
              runtimeConfig: forkedRuntimeConfig,
            },
            targetRuntime
          );
          const copyStagedAttachmentsResult = await copyStagedWorkspaceAttachments({
            sourceRuntime: freshSourceRuntime,
            targetRuntime,
            sourceWorkspacePath,
            stagedPaths: referencedStagedAttachmentPaths,
            targetWorkspacePath,
          });
          if (!copyStagedAttachmentsResult.success) {
            throw new Error(copyStagedAttachmentsResult.error);
          }
        }

        // Forks inherit chat history, but their cost ledger must start fresh.
        // Persist an explicit empty usage file so later reads do not rebuild
        // historical costs from the copied messages.
        await resetForkedSessionUsage(this.sessionUsageService, newWorkspaceId, newSessionDir);
      } catch (copyError) {
        const forkTrusted = projectConfig.trusted ?? false;
        await targetRuntime.deleteWorkspace(
          foundProjectPath,
          resolvedName,
          true,
          undefined,
          forkTrusted
        );
        try {
          await fsPromises.rm(newSessionDir, { recursive: true, force: true });
        } catch (cleanupError) {
          log.error(`Failed to clean up session dir ${newSessionDir}:`, cleanupError);
        }
        initLogger.logComplete(-1);
        const message = getErrorMessage(copyError);
        return Err(`Failed to copy fork state: ${message}`);
      }

      // Copy plan file using explicit source/target runtimes for cross-runtime safety.
      await copyPlanFileAcrossRuntimes(
        freshSourceRuntime,
        targetRuntime,
        sourceMetadata.name,
        sourceWorkspaceId,
        resolvedName,
        projectName
      );

      if (sourceRuntimeConfigUpdate) {
        await this.config.updateWorkspaceMetadata(sourceWorkspaceId, {
          runtimeConfig: sourceRuntimeConfigUpdate,
        });
      }

      if (sourceRuntimeConfigUpdated) {
        const allMetadataUpdated = await this.config.getAllWorkspaceMetadata();
        const updatedMetadata = allMetadataUpdated.find((m) => m.id === sourceWorkspaceId) ?? null;
        const enrichedMetadata = this.enrichMaybeFrontendMetadata(updatedMetadata);
        const sourceSession = this.sessions.get(sourceWorkspaceId);
        if (sourceSession) {
          sourceSession.emitMetadata(enrichedMetadata);
        } else {
          this.emit("metadata", { workspaceId: sourceWorkspaceId, metadata: enrichedMetadata });
        }
      }

      // Compute namedWorkspacePath for frontend metadata
      const namedWorkspacePath = targetRuntime.getWorkspacePath(foundProjectPath, resolvedName);

      const metadata: FrontendWorkspaceMetadata = {
        id: newWorkspaceId,
        name: resolvedName,
        projectName,
        projectPath: foundProjectPath,
        projects: forkResult.data.projects ?? sourceMetadata.projects,
        createdAt: new Date().toISOString(),
        runtimeConfig: forkedRuntimeConfig,
        namedWorkspacePath,
        // Preserve sub-project cwd/prompt context when forking via /fork.
        subProjectPath: sourceMetadata.subProjectPath,
        // Forks with a continue message stay pending until the first accepted user send
        // can generate a more specific title, unless the user edits the title first.
        pendingAutoTitle: pendingAutoTitle === true ? true : undefined,
        ...(isAutoName
          ? {
              // Preserve the original base name only for auto-generated forks so future
              // auto-forks can keep the same numbered family without affecting manual names.
              forkFamilyBaseName: deriveForkFamilyBaseName(sourceMetadata),
              // Seamless fork: generate a numbered title like "Parent Title (1)".
              title: generateForkTitle(
                sourceMetadata.title ?? sourceMetadata.name,
                allMetadata
                  .filter((m) => m.projectPath === foundProjectPath)
                  .map((m) => m.title ?? m.name)
              ),
            }
          : {}),
      };

      // Same pre-announcement sanitization as create(): a worktree fork of a
      // trusted repo materializes tracked files, so a committed
      // .mux/mcp.local.jsonc can carry a stale canonical plugin: enable that
      // no live workspace consented to — announced unpruned, the first agent
      // request would spawn that plugin's default-disabled MCP server. Local
      // (project-dir) forks share the source checkout, which the sibling scan
      // detects and skips (the source's consent context is alive).
      const forkIsHostLocalCheckout =
        forkedRuntimeConfig.type === "local" || forkedRuntimeConfig.type === "worktree";
      if (forkIsHostLocalCheckout) {
        this.pendingPluginSanitizations.add(newWorkspaceId);
      }
      let releaseRegistrationLock: (() => Promise<void>) | undefined;
      try {
        if (forkIsHostLocalCheckout) {
          // Cross-process: persist + sanitize must not interleave with a
          // sibling process registering the same checkout (see
          // acquireRegistrationSanitizeLock).
          releaseRegistrationLock = await this.acquireRegistrationSanitizeLock();
        }
        await this.config.addWorkspace(foundProjectPath, metadata);
        if (forkIsHostLocalCheckout) {
          const sanitizeError = await this.sanitizeStalePluginOverridesForNewWorkspace(
            newWorkspaceId,
            workspacePath
          );
          if (sanitizeError !== undefined) {
            // Background init is still running against this checkout: abort
            // it and AWAIT termination before deleting the worktree, or the
            // delete races init's writes/open handles and can fail, leaving
            // an orphaned worktree that collides with the next fork attempt.
            initAbortController.abort();
            await initSettled;
            const rolledBack = await this.rollbackUnsanitizedWorkspaceRegistration(newWorkspaceId);
            if (rolledBack && isWorktreeRuntime(forkedRuntimeConfig)) {
              // Matches the copy-failure cleanup above: the fork's checkout
              // is known fresh, so force-delete is safe here.
              await targetRuntime
                .deleteWorkspace(
                  foundProjectPath,
                  resolvedName,
                  true,
                  undefined,
                  projectConfig.trusted ?? false
                )
                .catch((error: unknown) => {
                  log.warn("Failed to remove forked worktree after sanitization abort", {
                    newWorkspaceId,
                    error: getErrorMessage(error),
                  });
                });
            }
            await this.disposeSession(newWorkspaceId);
            await fsPromises
              .rm(newSessionDir, { recursive: true, force: true })
              .catch(() => undefined);
            this.initAbortControllers.delete(newWorkspaceId);
            this.initStateManager.clearInMemoryState(newWorkspaceId);
            initLogger.logComplete(-1);
            return Err(
              rolledBack
                ? sanitizeError
                : `${sanitizeError} Additionally, the half-created workspace registration could not be rolled back; remove workspace ${newWorkspaceId} manually before retrying.`
            );
          }
        }
      } finally {
        await releaseRegistrationLock?.();
        this.pendingPluginSanitizations.delete(newWorkspaceId);
      }
      await this.workspaceGoalService?.inheritFromFork(sourceWorkspaceId, newWorkspaceId);

      if (sourceMessageId && abandonedBranchMessages !== null) {
        // RLM mode: summarize the abandoned tail into a durable labeled row on
        // the fork. Runs in the BACKGROUND so the user-facing fork returns
        // immediately (a synchronous wait stalled forks for the full deadline
        // when generation missed it). Ordering stays safe: the fork's first
        // send awaits the pending summary before building its request, and
        // the tail guard drops the row if anything else landed first.
        // Deliberately started only AFTER every failure-prone setup step and
        // config registration: a rollback can no longer race the writer, and
        // once the workspace is in config, removal can always cancel + drain
        // the registration. Also keeps the summary's recorded usage from
        // being wiped by resetForkedSessionUsage above. Fork IPC carries no
        // send-option experiments, so gating falls back to the persisted
        // machine overrides. Best-effort — never fails the fork (the promise
        // never rejects). Awaited so the cross-process pending marker is
        // stat-visible before the fork IPC returns (r55): an immediate first
        // send handled by another backend must find it; generation itself
        // still runs in the background.
        await startAbandonedBranchSummaryInBackground({
          historyService: this.historyService,
          aiService: this.aiService,
          workspaceId: newWorkspaceId,
          // Cross-process pending marker home (r48): lets a first send served
          // by another backend wait for the in-flight summary.
          sessionDir: path.join(this.config.sessionsDir, newWorkspaceId),
          abandonedMessages: abandonedBranchMessages,
          isExperimentEnabled: (experimentId) => this.isExperimentEnabled(experimentId),
          guardTailMessageId: sourceMessageId,
          // The fork target's metadata carries no model settings yet (its
          // first send would populate them, but that send awaits this very
          // summary), so candidates must be snapshotted from the SOURCE
          // workspace or generation silently no-ops on an empty list.
          modelCandidates: deriveSideChannelModelCandidates(sourceMetadata),
          // Side-channel spend must reach session usage / the cost UI.
          ...(this.sessionUsageService ? { sessionUsageService: this.sessionUsageService } : {}),
        });
      }

      const enrichedMetadata = this.enrichFrontendMetadata(metadata);
      session.emitMetadata(enrichedMetadata);

      await this.syncCodeWorkspaceFiles(metadata);
      eventSpine.emit("workspace.created", { workspaceId: newWorkspaceId });
      return Ok({ metadata: enrichedMetadata, projectPath: foundProjectPath });
    } catch (error) {
      const message = getErrorMessage(error);
      return Err(`Failed to fork workspace: ${message}`);
    }
  }

  async prepareManualWorkflowInvocation(workspaceId: string): Promise<void> {
    const trimmed = workspaceId.trim();
    assert(trimmed.length > 0, "prepareManualWorkflowInvocation requires workspaceId");
    const goalService = this.workspaceGoalService;
    if (!goalService) {
      return;
    }

    // Slash workflows are explicit user interventions, so they should preempt
    // pending automatic goal continuations just like queued composer messages do.
    goalService.clearPendingContinuationForManualUserMessage(trimmed);
    const goal = await goalService.acknowledgeUser(trimmed);
    if (goal?.status !== "active") {
      return;
    }

    const result = await goalService.setGoal({
      workspaceId: trimmed,
      status: "paused",
      initiator: "auto",
    });
    if (!result.success) {
      log.warn("Failed to auto-pause goal for workflow slash invocation", {
        workspaceId: trimmed,
        error: result.error,
      });
    }
  }

  async appendWorkflowRunInvocation(input: {
    workspaceId: string;
    rawCommand: string;
    scriptPath: string;
    args: unknown;
    runId: string;
    status: string;
    result: unknown;
    synthetic?: boolean;
    run?: WorkflowRunRecord;
  }): Promise<boolean> {
    assert(input.workspaceId.length > 0, "appendWorkflowRunInvocation requires workspaceId");
    assert(input.rawCommand.trim().length > 0, "appendWorkflowRunInvocation requires rawCommand");
    assert(input.scriptPath.length > 0, "appendWorkflowRunInvocation requires workflow scriptPath");
    assert(input.runId.length > 0, "appendWorkflowRunInvocation requires runId");

    const now = Date.now();
    void this.updateRecencyTimestamp(input.workspaceId, now);
    const commandPrefix = input.rawCommand.trim().split(/\s+/u)[0] ?? "/workflow";
    const userMessage = createMuxMessage(
      `workflow-run-command-${input.runId}`,
      "user",
      input.rawCommand,
      {
        timestamp: now,
        ...(input.synthetic === true ? { synthetic: true, uiVisible: true } : {}),
        muxMetadata: {
          type: WORKFLOW_TRIGGER_DISPLAY_METADATA_TYPE,
          rawCommand: input.rawCommand,
          commandPrefix,
          runId: input.runId,
        },
      }
    );
    const workflowMessage = buildWorkflowRunCardMessage(
      { scriptPath: input.scriptPath, args: input.args },
      {
        runId: input.runId,
        status: input.status,
        result: input.result,
        ...(input.run != null ? { run: input.run } : {}),
      },
      now
    );
    workflowMessage.metadata = {
      timestamp: now,
      synthetic: true,
      uiVisible: true,
      muxMetadata: {
        type: WORKFLOW_RUN_CARD_DISPLAY_METADATA_TYPE,
        runId: input.runId,
      },
    };

    const session = this.getOrCreateSession(input.workspaceId);
    const userAppend = await this.historyService.appendToHistory(input.workspaceId, userMessage);
    if (!userAppend.success) {
      log.error("Failed to append workflow slash command to history", {
        workspaceId: input.workspaceId,
        runId: input.runId,
        error: userAppend.error,
      });
      return false;
    }
    session.emitChatEvent({ ...userMessage, type: "message" });

    const toolAppend = await this.historyService.appendToHistory(
      input.workspaceId,
      workflowMessage
    );
    if (!toolAppend.success) {
      log.error("Failed to append workflow run card to history", {
        workspaceId: input.workspaceId,
        runId: input.runId,
        error: toolAppend.error,
      });
      return false;
    }
    session.emitChatEvent({ ...workflowMessage, type: "message" });
    return true;
  }

  async isWorkflowInvocationCurrent(workspaceId: string, runId: string): Promise<boolean> {
    return (await this.getWorkflowInvocationCurrentness(workspaceId, runId)) === "current";
  }

  /**
   * Three-state currentness: "indeterminate" means history/provenance could not be read or
   * ordered, so the answer is unknown rather than no. Callers that would permanently settle a
   * terminal wake on a negative answer (the terminal-attention drain records a superseded
   * settlement marker) must retain and retry on "indeterminate" instead; boolean callers treat
   * it as not-current,
   * the pre-existing fail-safe for non-destructive decisions.
   */
  async getWorkflowInvocationCurrentness(
    workspaceId: string,
    runId: string
  ): Promise<"current" | "not_current" | "indeterminate"> {
    assert(workspaceId.length > 0, "getWorkflowInvocationCurrentness requires workspaceId");
    assert(runId.length > 0, "getWorkflowInvocationCurrentness requires runId");

    const decision = await this.findWorkflowInvocationDecisionRow(workspaceId, runId);
    if (decision.status === "error") {
      return "indeterminate";
    }
    if (decision.status === "found" && decision.outcome === "invocation") {
      return "current";
    }

    // Kernel-launched runs (mux.workflow_run / mux.workflow_resume inside code_execution) leave
    // no recognizable invocation part in history, so the backward walk above stops at the prior
    // real user message (or, after a delivered result, at that consumed terminal message) and
    // would wrongly drop the run's notify_on_terminal wake. Their durable provenance is the
    // agent-workflow-runs sidecar, which snapshots the ID of the decision row that was newest
    // at record time: the run is current exactly when that row is still the newest decision row.
    // Row identity, not wall-clock ordering, so a backward clock correction can neither strand
    // a legitimate wake nor let a pre-supersession reference outrank a newer boundary. For a
    // consumed boundary, equality means a background resume/retry was recorded after the prior
    // result was delivered. References without a boundary snapshot (pre-upgrade entries,
    // record-time read failures) cannot be ordered against the decision row at all and defer
    // as indeterminate below.
    let references: AgentWorkflowRunReference[];
    try {
      references = await readAgentWorkflowRunReferences(
        path.join(this.config.sessionsDir, workspaceId)
      );
    } catch (error: unknown) {
      // The sidecar is the only invocation evidence a kernel-launched run has, so an
      // unreadable file is "cannot know right now", not "no reference": defer wake decisions
      // exactly like an unreadable history.
      log.warn("Could not read workflow run references for currentness", {
        workspaceId,
        runId,
        error,
      });
      return "indeterminate";
    }
    const reference = references.find((candidate) => candidate.runId === runId);
    if (decision.status === "none") {
      // A decision-free history is current only for a reference whose snapshot verified an
      // empty history at record time (null): kernel launches from a new or fully cleared
      // workspace (e.g. a heartbeat turn) have no decision row before or after, and their wake
      // must still deliver. Every other surviving reference fails safe, because a full clear
      // (truncateHistory) removes every row WITHOUT appending a reset boundary while leaving
      // the sidecar intact, and a reference pointing at a cleared row, or one without a
      // verified snapshot, must not inject a workflow result into the freshly cleared
      // conversation.
      return reference?.afterBoundaryMessageId === null ? "current" : "not_current";
    }
    if (reference == null) {
      return "not_current";
    }
    if (reference.afterBoundaryMessageId === undefined) {
      // No boundary snapshot (pre-upgrade entry or record-time history read failure): row
      // identity cannot be verified, and wall-clock ordering is the exact hole the identity
      // path exists to close (a backward clock correction would let a pre-supersession
      // reference outrank a newer manual turn and deliver its output under that turn's tool
      // policy). Fail quiet rather than deliver or defer forever: this is a deliberately
      // accepted narrow window (downgrade-stripped or snapshot-failed launches), and the
      // run's result stays retrievable via an explicit workflow_resume, which re-records the
      // reference with a fresh boundary.
      return "not_current";
    }
    if (reference.afterBoundaryMessageId === null) {
      // Verified-empty snapshot: a decision row now exists, so it appeared after the record.
      return "not_current";
    }
    return reference.afterBoundaryMessageId === decision.messageId ? "current" : "not_current";
  }

  /**
   * The newest invocation-decision row for this run: a manual user/reset supersession, a
   * consumed terminal result for the run, or a direct invocation part. Shared by
   * isWorkflowInvocationCurrent and the sidecar record path so both sides of the identity
   * comparison classify rows identically.
   */
  private async findWorkflowInvocationDecisionRow(
    workspaceId: string,
    runId: string
  ): Promise<
    | {
        status: "found";
        outcome: "invocation" | "consumed" | "superseded";
        messageId: string;
      }
    | { status: "none" }
    | { status: "error" }
  > {
    const state: {
      found: {
        outcome: "invocation" | "consumed" | "superseded";
        messageId: string;
      } | null;
    } = { found: null };
    const historyResult = await this.historyService.iterateFullHistory(
      workspaceId,
      "backward",
      (messages) => {
        for (const message of messages) {
          if (isManualUserSupersessionMessage(message) || isResetBoundaryMessage(message)) {
            state.found = { outcome: "superseded", messageId: message.id };
            return false;
          }
          if (
            isWorkflowResultContinuationMessage(message, runId) ||
            isCoalescedWorkflowResultMessage(message, runId) ||
            isTerminalWorkflowTaskAwaitResultMessage(message, runId) ||
            isTerminalWorkflowToolResultMessage(message, runId)
          ) {
            state.found = { outcome: "consumed", messageId: message.id };
            return false;
          }
          if (isWorkflowInvocationMessage(message, runId)) {
            state.found = { outcome: "invocation", messageId: message.id };
            return false;
          }
        }
        return undefined;
      }
    );
    if (!historyResult.success) {
      log.warn("Could not read history before workflow continuation", {
        workspaceId,
        runId,
        error: historyResult.error,
      });
      return { status: "error" };
    }
    return state.found != null
      ? { status: "found", outcome: state.found.outcome, messageId: state.found.messageId }
      : { status: "none" };
  }

  /** Testable seam for the pre-truncation retirement in truncateHistory. */
  private async retireKernelWorkflowRunReferences(workspaceId: string): Promise<void> {
    await clearAgentWorkflowRunReferences(path.join(this.config.sessionsDir, workspaceId));
  }

  /**
   * Boundary snapshot for the agent-workflow-runs sidecar: the message ID of the newest
   * invocation-decision row for this run, or null when history has none. Recorded at
   * background launch/resume so isWorkflowInvocationCurrent can compare row identity instead
   * of wall-clock timestamps, which clock corrections can reorder.
   */
  async getWorkflowInvocationBoundaryMessageId(
    workspaceId: string,
    runId: string
  ): Promise<string | null> {
    assert(workspaceId.length > 0, "getWorkflowInvocationBoundaryMessageId requires workspaceId");
    assert(runId.length > 0, "getWorkflowInvocationBoundaryMessageId requires runId");
    const decision = await this.findWorkflowInvocationDecisionRow(workspaceId, runId);
    // A read failure must not masquerade as a verified-empty history: persisting null would
    // permanently fail the run's currentness check even after storage recovers. Throw so the
    // record path can distinguish and record a rediscovery-only reference instead.
    if (decision.status === "error") {
      throw new Error("workflow invocation boundary unavailable: history read failed");
    }
    return decision.status === "found" ? decision.messageId : null;
  }

  /**
   * Increment a preflight admission counter in the caller's synchronous entry block and
   * return a disposable releasing it. Pairs renderer-initiated workspace activity with the
   * archive gate (see archiveUnlocked's refuseLiveUserActivity): an activity admitted first
   * holds the gate open until it settles, and one entering after the gate armed observes
   * archivingWorkspaces and refuses at entry.
   */
  private acquirePreflightAdmission(counts: Map<string, number>, workspaceId: string): Disposable {
    counts.set(workspaceId, (counts.get(workspaceId) ?? 0) + 1);
    return {
      [Symbol.dispose]: () => {
        const remaining = (counts.get(workspaceId) ?? 1) - 1;
        if (remaining <= 0) {
          counts.delete(workspaceId);
        } else {
          counts.set(workspaceId, remaining);
        }
      },
    };
  }

  /**
   * Archive admission pairing for MCP prompt discovery (workspace.mcp.prompts.list), which
   * readies the runtime and starts cached stdio servers outside any stream. The guard check and
   * the counter increment run in one synchronous block, mirroring executeBash: a discovery
   * admitted first holds the archive gate open until the caller disposes the admission, and one
   * entering after the gate armed (or against an archived workspace) is refused with undefined.
   */
  acquireMcpPromptDiscoveryAdmission(workspaceId: string): Disposable | undefined {
    if (this.archivingWorkspaces.has(workspaceId)) {
      return undefined;
    }
    const workspaceEntry = findWorkspaceEntry(this.config.loadConfigOrDefault(), workspaceId);
    if (
      workspaceEntry != null &&
      isWorkspaceArchived(
        workspaceEntry.workspace.archivedAt,
        workspaceEntry.workspace.unarchivedAt
      )
    ) {
      return undefined;
    }
    return this.acquirePreflightAdmission(this.preflightMcpPromptDiscoveryCounts, workspaceId);
  }

  async stageAttachment(input: {
    workspaceId: string;
    filename: string;
    mediaType?: string | null;
    sizeBytes: number;
    dataBase64: string;
  }): Promise<Result<StagedWorkspaceAttachment, string>> {
    // Archive admission pairing (same synchronous block, mirroring executeBash): staging
    // writes into the checkout, so an archive must not capture/remove it mid-upload.
    if (this.archivingWorkspaces.has(input.workspaceId)) {
      return Err("Workspace is being archived. Unarchive it before attaching files.");
    }
    using _preflightStaging = this.acquirePreflightAdmission(
      this.preflightStagingCounts,
      input.workspaceId
    );

    const metadata = await this.getInfo(input.workspaceId);
    if (metadata == null) {
      return Err("Workspace not found");
    }
    if (isWorkspaceArchived(metadata.archivedAt, metadata.unarchivedAt)) {
      return Err("Workspace is archived. Unarchive it before attaching files.");
    }

    // Deferred runtimes (Coder/SSH/devcontainer) return from create before
    // provisioning finishes; wait like executeBash so staging right after
    // creation does not write into a not-yet-ready workspace.
    await this.initStateManager.waitForInit(input.workspaceId);

    const { runtime, workspacePath } = createRuntimeContextForWorkspace(metadata);
    return stageWorkspaceAttachment({
      runtime,
      workspacePath,
      filename: input.filename,
      mediaType: input.mediaType,
      sizeBytes: input.sizeBytes,
      dataBase64: input.dataBase64,
    });
  }

  async downloadStagedAttachment(input: {
    workspaceId: string;
    stagedPath: string;
  }): Promise<Result<DownloadedStagedWorkspaceAttachment, string>> {
    // Archive admission pairing (same synchronous block, mirroring stageAttachment): the
    // download reads from the checkout through the runtime, so an archive must not remove a
    // snapshot-managed checkout mid-read — and on a dedicated Coder target the admitted
    // read could reconnect and restart a workspace the archive just stopped. Downloads
    // share the staging counter: both directions are attachment transfers the archive
    // gates refuse on identically.
    if (this.archivingWorkspaces.has(input.workspaceId)) {
      return Err("Workspace is being archived. Unarchive it before downloading attachments.");
    }
    using _preflightDownload = this.acquirePreflightAdmission(
      this.preflightStagingCounts,
      input.workspaceId
    );

    const metadata = await this.getInfo(input.workspaceId);
    if (metadata == null) {
      return Err("Workspace not found");
    }
    if (isWorkspaceArchived(metadata.archivedAt, metadata.unarchivedAt)) {
      return Err("Workspace is archived. Unarchive it before downloading attachments.");
    }

    const { runtime, workspacePath } = createRuntimeContextForWorkspace(metadata);
    return readStagedWorkspaceAttachment({
      runtime,
      workspacePath,
      stagedPath: input.stagedPath,
    });
  }

  async sendMessage(
    workspaceId: string,
    message: string,
    options: SendMessageOptions & {
      fileParts?: FilePart[];
    },
    internal?: SendMessageInternalOptions
  ): Promise<Result<void, SendMessageError>> {
    log.debug("sendMessage handler: Received", {
      workspaceId,
      messagePreview: message.substring(0, 50),
      agentId: options?.agentId,
      options,
    });
    // Codex P2 (PRRT_kwDOPxxmWM6b-orA): capture authoring time at request
    // entry, before the preflight awaits below (pricing gate, AI-settings
    // persistence). Goal safety compares this against goal creation, so
    // sampling later — at enqueue or dispatch — would misclassify a message
    // the user authored before a goal became visible as an intervention
    // against it, pausing the fresh goal.
    const authoredAtMs = Date.now();

    let resumedInterruptedTask = false;
    let previousTaskStatus: ReturnType<AgentTaskIntegration["getAgentTaskStatus"]>;
    let claimedAutoTitle = false;
    try {
      // Block streaming while workspace is being renamed to prevent path conflicts
      if (this.renamingWorkspaces.has(workspaceId)) {
        log.debug("sendMessage blocked: workspace is being renamed", { workspaceId });
        return Err({
          type: "unknown",
          raw: "Workspace is being renamed. Please wait and try again.",
        });
      }

      // Block streaming while workspace is being removed to prevent races with config/session deletion.
      if (this.removingWorkspaces.has(workspaceId)) {
        log.debug("sendMessage blocked: workspace is being removed", { workspaceId });
        return Err({
          type: "unknown",
          raw: "Workspace is being deleted. Please wait and try again.",
        });
      }

      // Archive admission pairing (see archiveUnlocked's refuseLiveUserActivity gate): these
      // checks run in the same synchronous block as the preflightSendCounts increment below,
      // so a send and an archive always observe each other — whichever entry block runs first
      // refuses the other side. Also refuses sends to already-archived workspaces so no stream
      // can run hidden in a workspace the UI no longer surfaces.
      if (this.archivingWorkspaces.has(workspaceId)) {
        log.debug("sendMessage blocked: workspace is being archived", { workspaceId });
        return Err({
          type: "unknown",
          raw: "Workspace is being archived. Unarchive it before sending messages.",
        });
      }
      {
        const workspaceEntry = findWorkspaceEntry(this.config.loadConfigOrDefault(), workspaceId);
        if (
          workspaceEntry != null &&
          isWorkspaceArchived(
            workspaceEntry.workspace.archivedAt,
            workspaceEntry.workspace.unarchivedAt
          )
        ) {
          log.debug("sendMessage blocked: workspace is archived", { workspaceId });
          return Err({
            type: "unknown",
            raw: "Workspace is archived. Unarchive it before sending messages.",
          });
        }
      }

      if (this.contextMutationWorkspaces.has(workspaceId)) {
        log.debug("sendMessage blocked: a context-discarding history mutation is in progress", {
          workspaceId,
        });
        return Err({
          type: "unknown",
          raw: CONTEXT_MUTATION_SEND_BLOCKED_MESSAGE,
        });
      }
      const dedupeKey = internal?.queueDedupeKey;
      if (dedupeKey && this.sessions.get(workspaceId)?.hasQueuedDedupeKey(dedupeKey)) {
        return Ok(undefined);
      }
      // Restarted questions have no busy phase: regain their queue without preflight or dispatch.
      if (internal?.restoreQueued) {
        this.getOrCreateSession(workspaceId).queueMessage(message, options, {
          ...internal,
          dedupeKey,
        });
        return Ok(undefined);
      }
      // r41: capture the mutation epoch in the same synchronous block as the
      // entry check; the session's admission gates re-verify it so a
      // reset/clear/replace that completes while this send is still doing
      // pre-admission work refuses the send instead of letting it append and
      // stream stale content into the fresh context.
      let admissionEpoch = this.contextMutationEpochs.get(workspaceId) ?? 0;
      const admissionEpochStale = () =>
        (this.contextMutationEpochs.get(workspaceId) ?? 0) !== admissionEpoch;
      // r41: count this send as in-preflight until it settles so refine
      // publication refuses to interleave with its pre-admission window
      // (context mutations instead refuse the send itself via the epoch
      // probe above). Released on every exit path; admitted sends have set
      // PREPARING (busy) by the time sendMessage returns.
      this.preflightSendCounts.set(
        workspaceId,
        (this.preflightSendCounts.get(workspaceId) ?? 0) + 1
      );
      using _preflightSend = {
        [Symbol.dispose]: () => {
          const remaining = (this.preflightSendCounts.get(workspaceId) ?? 1) - 1;
          if (remaining <= 0) {
            this.preflightSendCounts.delete(workspaceId);
          } else {
            this.preflightSendCounts.set(workspaceId, remaining);
          }
        },
      };
      // Maintenance sends that yield to user input: requireIdle skips and queue-mode
      // heartbeats. Both must yield to a manual send in preflight rather than race it.
      const yieldsToPreflightSends =
        internal?.requireIdle === true || internal?.yieldToQueuedMessages === true;
      // A queue-mode heartbeat superseded by input that arrived during its preparation is a
      // quiet success: its next slot fires anyway.
      const yieldToPreflightSend = (): Result<void, SendMessageError> => {
        log.info("sendMessage: yielded to a send in preflight during send preparation", {
          workspaceId,
        });
        return Ok(undefined);
      };
      using sessionInvisiblePreflight = this.armSessionInvisiblePreflight(workspaceId, {
        supersedable: yieldsToPreflightSends,
      });

      // Guard: avoid creating sessions for workspaces that don't exist anymore.
      const workspaceConfig = this.config.findWorkspace(workspaceId);
      if (!workspaceConfig) {
        return Err({
          type: "unknown",
          raw: "Workspace not found. It may have been deleted.",
        });
      }

      // Guard: queued agent tasks must not start streaming via generic sendMessage calls.
      // They should only be started by task orchestration once a parallel slot is available.
      if (!internal?.allowQueuedAgentTask) {
        const config = this.config.loadConfigOrDefault();
        for (const [_projectPath, project] of config.projects) {
          const ws = project.workspaces.find((w) => w.id === workspaceId);
          if (!ws) continue;
          if (
            ws.parentWorkspaceId &&
            (ws.taskStatus === "queued" || ws.taskStatus === "starting")
          ) {
            taskQueueDebug("WorkspaceService.sendMessage blocked (queued/starting task)", {
              workspaceId,
              stack: new Error("sendMessage blocked").stack,
            });
            return Err({
              type: "unknown",
              raw: "This agent task is queued or starting and cannot accept generic messages yet.",
            });
          }
          break;
        }
      } else {
        taskQueueDebug("WorkspaceService.sendMessage allowed (internal dequeue)", {
          workspaceId,
          stack: new Error("sendMessage internal").stack,
        });
      }

      const session = this.getOrCreateSession(workspaceId);

      // Skip recency update for idle compaction - preserve original "last used" time
      const muxMeta = options?.muxMetadata as { type?: string; source?: string } | undefined;
      const isIdleCompaction =
        muxMeta?.type === "compaction-request" && muxMeta?.source === "idle-compaction";
      // Use current time for recency - this matches the timestamp used on the message
      // in agentSession.sendMessage(). Keeps ExtensionMetadata in sync with chat.jsonl.
      const messageTimestamp = Date.now();
      if (!isIdleCompaction) {
        void this.updateRecencyTimestamp(workspaceId, messageTimestamp);
      }

      const normalizedOptions = this.normalizeSendMessageAgentId(options);
      const normalizedMuxMetadata = normalizedOptions.muxMetadata as MuxMessageMetadata | undefined;
      const workspaceTurnContinuationMetadata =
        normalizedMuxMetadata?.type === "workspace-turn-task" ? normalizedMuxMetadata : undefined;

      const isWorkspaceTurnContinuation = internal?.workspaceTurnContinuation === true;
      const stripWorkspaceTurnCorrelation = (
        sendOptions: SendMessageOptions & { fileParts?: FilePart[] }
      ): SendMessageOptions & { fileParts?: FilePart[] } => {
        const withoutCorrelation = { ...sendOptions };
        // A peer-message trigger keeps its machine-notification identity even when its
        // delegated-turn correlation is superseded: downgrade to plain peer attribution
        // instead of deleting the metadata wholesale, or the fixed backend trigger would
        // render as a human prompt and re-enter prompt navigation.
        const typedMuxMetadata = sendOptions.muxMetadata as MuxMessageMetadata | undefined;
        const peerTrigger =
          typedMuxMetadata?.type === "workspace-turn-task"
            ? typedMuxMetadata.agentPeerMessageTrigger
            : undefined;
        if (peerTrigger != null) {
          withoutCorrelation.muxMetadata = { type: "agent-peer-message", ...peerTrigger };
        } else {
          delete withoutCorrelation.muxMetadata;
        }
        return withoutCorrelation;
      };
      // A promoted tool-end send (sub-agent progress) overtakes trailing hidden turn-end entries
      // such as a queued heartbeat, so they must not count as superseding predecessors here — or
      // the report would be stripped of the correlation it then dispatches ahead of them with.
      const promotesAheadOfHiddenTurnEnd =
        internal?.promoteAheadOfHiddenTurnEnd === true &&
        (normalizedOptions.queueDispatchMode ?? "tool-end") === "tool-end";
      const getContinuationSendState = () => {
        const preserveCorrelation =
          !isWorkspaceTurnContinuation ||
          !session.hasQueuedOrDispatchingEntry(workspaceTurnContinuationMetadata, {
            promoteAheadOfHiddenTurnEnd: promotesAheadOfHiddenTurnEnd,
          });
        // Dropping callbacks on a superseded correlation protects the delegated-turn OWNER
        // (its onCanceled settles the owner's handle, which the superseded entry no longer
        // represents) — but a peer trigger's onCanceled is the sender's budget refund, tied to
        // this entry rather than the foreign handle, so it survives the downgrade.
        const isPeerTrigger = workspaceTurnContinuationMetadata?.agentPeerMessageTrigger != null;
        return {
          options: preserveCorrelation
            ? normalizedOptions
            : stripWorkspaceTurnCorrelation(normalizedOptions),
          onCanceled: preserveCorrelation || isPeerTrigger ? internal?.onCanceled : undefined,
          onAcceptedPreStreamFailure:
            preserveCorrelation || isPeerTrigger ? internal?.onAcceptedPreStreamFailure : undefined,
        };
      };

      // Reject before any settings persistence so an unpriced model can never
      // be saved for a budgeted resumable goal — including via direct callers
      // that bypass the client-side guard. Manual sends still delegate into
      // AgentSession on rejection so it can preserve the user's interruption
      // message and apply goal auto-pause safety.
      const pricingGate = await this.assertPricedModelForBudgetedGoal(
        workspaceId,
        normalizedOptions
      );
      if (!pricingGate.success) {
        if (internal?.synthetic !== true) {
          // Codex P1 (PRRT_kwDOPxxmWM6cSCjs): unlike the accepted handoffs
          // below, this rejected send never streams and cannot produce its own
          // compaction follow-up, so the handoff release does not apply. Hold
          // the reservation (released by `using` disposal after the await
          // settles) so a completing goal-scoped follow-up cannot be admitted
          // ahead of the user's intervention while the fallback persists the
          // rejected row and applies goal safety.
          return await session.sendMessage(message, normalizedOptions, {
            synthetic: internal?.synthetic,
            agentInitiated: internal?.agentInitiated,
            goalKind: internal?.goalKind,
            goalId: internal?.goalId,
            cancelState: internal?.cancelState,
            cancelSignal: internal?.cancelSignal,
            withdrawAcceptedOnCancel: internal?.withdrawAcceptedOnCancel,
            onCanceled: internal?.onCanceled,
            onAccepted: internal?.onAccepted,
            onAcceptedPreStreamFailure: internal?.onAcceptedPreStreamFailure,
            startStreamInBackground: internal?.startStreamInBackground,
            goalContinuation: internal?.goalContinuation,
            admissionEpochStale,
            // The rejected manual send still persists the user row; carry the
            // authoring time so goal safety and restart reconciliation can
            // prove it predates any goal published during the pricing await.
            enqueuedAtMs: authoredAtMs,
            admissionStale: internal?.admissionStale,
          });
        }
        return Err(pricingGate.error);
      }

      // Synthetic turns must not replace the user's remembered model and mode.
      if (internal?.synthetic !== true) {
        await this.maybePersistAISettingsFromOptions(workspaceId, normalizedOptions);
      }

      // Decide queue-or-direct in arrival order: a later send whose awaits above finished
      // first would otherwise enqueue ahead of an earlier one. The decision below runs
      // synchronously up to queueMessage / the session handoff.
      await sessionInvisiblePreflight.awaitEarlierDecisions();
      sessionInvisiblePreflight.markDecided();

      // A send between service entry and the session's PREPARING claim is invisible to
      // isBusy(). A later send admitted against that idle snapshot reaches StreamManager
      // while the earlier turn is streaming, and ensureStreamSafety aborts the earlier turn
      // to start the later one. Queue behind the earlier in-preflight send instead.
      // requireIdle callers keep their skip semantics below (and are never waited on, see
      // sessionInvisiblePreflights); edits bypass the queue by design.
      const shouldQueue =
        !normalizedOptions?.editMessageId &&
        (session.isBusy() ||
          (sessionInvisiblePreflight.hasEarlierPreflight() && !yieldsToPreflightSends));

      // Codex P1 (PRRT_kwDOPxxmWM6cGSPP): a goal-continuation dispatch closure
      // captured before a manual send entered preflight would otherwise win
      // idle admission here — the session only reports busy late in
      // AgentSession.sendMessage, so `isBusy()` alone cannot see the user's
      // in-flight turn. `preflightSendCounts` includes THIS send (incremented
      // synchronously at entry above), so any other in-preflight send makes
      // the count exceed 1; refusing is safe because idle-only callers
      // (continuations, heartbeats) treat this as a transient skip and retry.
      const hasOtherSendInPreflight = (this.preflightSendCounts.get(workspaceId) ?? 0) > 1;
      if (!shouldQueue && internal?.requireIdle && hasOtherSendInPreflight) {
        return Err({
          type: "unknown",
          raw: IDLE_ONLY_BUSY_SKIP_MESSAGE,
        });
      }
      // Starting a queue-mode heartbeat here would race that input to PREPARING.
      if (!shouldQueue && internal?.yieldToQueuedMessages === true && hasOtherSendInPreflight) {
        return yieldToPreflightSend();
      }

      // Codex P1 (PRRT_kwDOPxxmWM6cJ6NI): the count check above is a one-shot
      // snapshot — a manual send can enter preflight during the awaits between
      // here and the session reporting busy (markInterruptedTaskRunning, the
      // admission awaits inside AgentSession.sendMessage). Compose the
      // caller's staleness probe with a live preflight re-check so
      // AgentSession's admission gates (including the last gate before the
      // pre-turn batch becomes irrevocable) re-validate idleness; refusal
      // rolls back the synthetic row and idle-only callers retry. Queue-mode heartbeats
      // carry the same probe so they cannot claim PREPARING against a manual send that
      // entered preflight after their entry check (see the quiet yield below).
      if (yieldsToPreflightSends) {
        const callerAdmissionStale = internal?.admissionStale;
        internal = {
          ...internal,
          admissionStale: () =>
            callerAdmissionStale?.() === true ||
            (this.preflightSendCounts.get(workspaceId) ?? 0) > 1,
        };
      }

      if (shouldQueue) {
        // Mirrors AgentSession's cancelBeforeAcceptance for the queue path: a send withdrawn
        // during the preflight awaits above must not occupy a queue slot (and hold its dedupe
        // key) until the stream drains it. Nothing is persisted yet, so only the handshake runs.
        if (internal?.cancelSignal?.aborted === true) {
          await getContinuationSendState().onCanceled?.(
            cancelReasonBeforeAcceptance(internal.cancelSignal)
          );
          if (internal.cancelState != null) {
            internal.cancelState.canceledBeforeAcceptance = true;
          }
          return Ok(undefined);
        }
        // Everything from here to queueMessage is synchronous, so a probe pass here cannot go
        // stale before the entry is enqueued.
        if (internal?.admissionStale?.() === true) {
          if (internal.yieldToQueuedMessages === true) {
            return yieldToPreflightSend();
          }
          return Err({ type: "unknown", raw: SEND_ADMISSION_STALE_MESSAGE });
        }
        const taskStatus = this.agentTaskIntegration?.getAgentTaskStatus(workspaceId);
        if (taskStatus === "interrupted") {
          return Err({
            type: "unknown",
            raw: "Interrupted task is still winding down. Wait until it is idle, then try again.",
          });
        }

        if (internal?.requireIdle) {
          return Err({
            type: "unknown",
            raw: IDLE_ONLY_BUSY_SKIP_MESSAGE,
          });
        }

        // A pending interactive question is only moot when the user actually responds in
        // chat. Backend-initiated synthetic sends (scheduled heartbeats, task wakes) are
        // not user responses — canceling would destroy a user-facing prompt and record a
        // misleading cancel reason, so synthetic sends queue behind the question instead.
        const pendingAskUserQuestion =
          internal?.synthetic === true
            ? null
            : askUserQuestionManager.getLatestPending(workspaceId);
        if (pendingAskUserQuestion) {
          try {
            askUserQuestionManager.cancel(
              workspaceId,
              pendingAskUserQuestion.toolCallId,
              "User responded in chat; questions canceled"
            );
          } catch (error) {
            log.debug("Failed to cancel pending ask_user_question", {
              workspaceId,
              toolCallId: pendingAskUserQuestion.toolCallId,
              error: getErrorMessage(error),
            });
          }
        }

        // The reverse of yieldToQueuedMessages below: a pending scheduled heartbeat must
        // never absorb real input. MessageQueue batches later texts under the first entry's
        // muxMetadata, so a message queued behind a heartbeat would dispatch tagged (and
        // displayed) as a heartbeat. New input supersedes the check-in instead — the
        // heartbeat is periodic and its next slot will fire anyway.
        if (
          internal?.queueDedupeKey !== HEARTBEAT_QUEUE_DEDUPE_KEY &&
          session.dropQueuedMessageWithOnlyDedupeKey(HEARTBEAT_QUEUE_DEDUPE_KEY)
        ) {
          log.info("sendMessage: dropped pending queued heartbeat superseded by new input", {
            workspaceId,
          });
        }

        // Re-check queue emptiness at the enqueue point: the caller's decision may be stale
        // by now (the pricing/settings awaits above yield the event loop, so a user send can
        // queue first). Everything from here to queueMessage is synchronous, so this check
        // cannot go stale again.
        if (internal?.yieldToQueuedMessages === true && session.hasQueuedMessages()) {
          log.info("sendMessage: yielded to messages queued during send preparation", {
            workspaceId,
          });
          return Ok(undefined);
        }

        // Background any foreground task waits so the queued message can dispatch promptly.
        // This must happen after queueMessage succeeds — if enqueue fails (throws),
        // we must not cancel foreground waits. Use the queue's effective dispatch mode
        // (not incoming options) because MessageQueue makes tool-end sticky.
        const continuationSendState = getContinuationSendState();
        sessionInvisiblePreflight.release();
        const effectiveQueueDispatchMode = session.queueMessage(
          message,
          continuationSendState.options,
          {
            synthetic: internal?.synthetic,
            agentInitiated: internal?.agentInitiated,
            authoredAtMs,
            workspaceTurnContinuation: internal?.workspaceTurnContinuation,
            dedupeKey: internal?.queueDedupeKey,
            removableDedupeKey: internal?.removableQueueDedupeKey,
            promoteAheadOfHiddenTurnEnd: internal?.promoteAheadOfHiddenTurnEnd,
            cancelState: internal?.cancelState,
            cancelSignal: internal?.cancelSignal,
            onCanceled: continuationSendState.onCanceled,
            onAccepted: internal?.onAccepted,
            onAcceptedPreStreamFailure: continuationSendState.onAcceptedPreStreamFailure,
            preTurnMessages: internal?.preTurnMessages,
            onPreTurnRowsPersisted: internal?.onPreTurnRowsPersisted,
            // Thread the probe onto the queued entry: a Stop landing after dequeue is
            // invisible to queue clearing, so the session's turn-admission gates must
            // re-check it at dispatch.
            admissionStale: internal?.admissionStale,
          }
        );

        // A dedupe-keyed send that raced an already-pending duplicate is a quiet success:
        // the pending queue entry already covers it (coalescing), so don't double-queue.
        if (effectiveQueueDispatchMode == null && internal?.queueDedupeKey != null) {
          log.info("sendMessage: dropped duplicate queued message for dedupe key", {
            workspaceId,
            queueDedupeKey: internal.queueDedupeKey,
          });
        }

        if (effectiveQueueDispatchMode != null && !internal?.skipAutoResumeReset) {
          this.agentTaskIntegration?.resetAutoResumeCount(workspaceId);
        }

        if (effectiveQueueDispatchMode === "tool-end") {
          this.agentTaskIntegration?.backgroundForegroundWaitsForWorkspace(workspaceId);
        }

        return Ok(undefined);
      }

      if (!internal?.skipAutoResumeReset) {
        this.agentTaskIntegration?.resetAutoResumeCount(workspaceId);
      }

      // A stale caller probe must refuse BEFORE the interrupted-task rescue below: a peer send
      // racing task_stop would otherwise flip the freshly stopped task back to running and start
      // the very turn the stop was meant to prevent.
      if (internal?.admissionStale?.() === true) {
        return Err({ type: "unknown", raw: SEND_ADMISSION_STALE_MESSAGE });
      }

      // Non-destructive interrupt cascades preserve descendant task workspaces with
      // taskStatus=interrupted. Transition before starting a new stream so task orchestration
      // stream-end handling does not early-return on interrupted status.
      //
      // Guarded sends (peer messages) skip this rescue entirely: it exists for user-driven
      // resumes, and a task_stop persisting `interrupted` between the probe pass above and the
      // config read inside markInterruptedTaskRunning would otherwise be flipped straight back
      // to running — after which every later probe sees an active status and admits the very
      // turn the stop was meant to prevent.
      if (
        findWorkspaceEntry(this.config.loadConfigOrDefault(), workspaceId)?.workspace
          .taskDesktopOwnerWorkspaceId !== undefined
      ) {
        await this.desktopInputCoordinator.withAdmission(workspaceId, () =>
          Promise.resolve(undefined)
        );
      }
      if (internal?.admissionStale == null) {
        previousTaskStatus = this.agentTaskIntegration?.getAgentTaskStatus(workspaceId);
        resumedInterruptedTask =
          (await this.agentTaskIntegration?.markInterruptedTaskRunning(workspaceId)) ?? false;
      }

      const continuationSendState = getContinuationSendState();
      const onAcceptedPreStreamFailure = async (error: SendMessageError) => {
        if (resumedInterruptedTask && normalizedOptions?.editMessageId) {
          try {
            await this.agentTaskIntegration?.restoreInterruptedTaskAfterResumeFailure(
              workspaceId,
              previousTaskStatus
            );
          } catch (restoreError: unknown) {
            log.error(
              "Failed to restore interrupted task status after accepted edit startup failure",
              {
                workspaceId,
                error,
                restoreError,
              }
            );
          }
        }
        await continuationSendState.onAcceptedPreStreamFailure?.(error);
      };

      const shouldRunPendingAutoTitle =
        internal?.synthetic !== true &&
        normalizedOptions.editMessageId == null &&
        workspaceConfig.pendingAutoTitle === true &&
        !this.autoTitlingWorkspaces.has(workspaceId);
      if (shouldRunPendingAutoTitle) {
        this.autoTitlingWorkspaces.add(workspaceId);
        claimedAutoTitle = true;
      }

      // Handoff: the session releases the probe reservation the moment the
      // turn synchronously claims PREPARING (onTurnAdmissionCommitted), so a
      // follow-up redispatched from within this very turn (on-send compaction
      // completion) does not veto itself — while the admission awaits between
      // here and the busy claim stay covered. Codex P2 (PRRT_kwDOPxxmWM6cSRkH):
      // releasing at the handoff itself left AgentSession's
      // cancelBeforeAcceptance yield observable as idle, letting follow-up
      // recovery admit an exec turn ahead of the accepted manual send. Refusal
      // paths never fire the callback; the scoped disposal releases on return.
      const result = await session.sendMessage(message, continuationSendState.options, {
        onTurnAdmissionCommitted: () => sessionInvisiblePreflight.release(),
        onContextWindowRollover: () => {
          this.advanceContextMutationEpoch(workspaceId);
          admissionEpoch = this.contextMutationEpochs.get(workspaceId) ?? 0;
        },
        synthetic: internal?.synthetic,
        agentInitiated: internal?.agentInitiated,
        goalKind: internal?.goalKind,
        goalId: internal?.goalId,
        goalContinuation: internal?.goalContinuation,
        startStreamInBackground: internal?.startStreamInBackground,
        cancelState: internal?.cancelState,
        cancelSignal: internal?.cancelSignal,
        withdrawAcceptedOnCancel: internal?.withdrawAcceptedOnCancel,
        // Same authoring-time race as the queued path: the goal-creating
        // stream can end during the preflight awaits above, making a fresh
        // goal visible after the user hit enter but before this dispatch.
        enqueuedAtMs: authoredAtMs,
        onCanceled: continuationSendState.onCanceled,
        onAccepted: internal?.onAccepted,
        onAcceptedPreStreamFailure,
        preTurnMessages: internal?.preTurnMessages,
        onPreTurnRowsPersisted: internal?.onPreTurnRowsPersisted,
        admissionEpochStale,
        admissionStale: internal?.admissionStale,
      });
      if (
        !result.success &&
        internal?.yieldToQueuedMessages === true &&
        result.error.type === "unknown" &&
        result.error.raw === SEND_ADMISSION_STALE_MESSAGE
      ) {
        return yieldToPreflightSend();
      }
      if (!result.success) {
        log.error("sendMessage handler: session returned error", {
          workspaceId,
          error: result.error,
        });

        if (claimedAutoTitle) {
          this.autoTitlingWorkspaces.delete(workspaceId);
          claimedAutoTitle = false;
        }

        if (resumedInterruptedTask) {
          try {
            await this.agentTaskIntegration?.restoreInterruptedTaskAfterResumeFailure(
              workspaceId,
              previousTaskStatus
            );
          } catch (error: unknown) {
            log.error("Failed to restore interrupted task status after sendMessage failure", {
              workspaceId,
              error,
            });
          }
        }

        return result;
      }

      if (claimedAutoTitle) {
        const autoTitlePromise = this.maybeRunPendingAutoTitleFromMessage(workspaceId, message);
        autoTitlePromise
          .catch((error: unknown) => {
            log.error("Unexpected rejection while running fork auto-title", {
              workspaceId,
              error: getErrorMessage(error),
            });
          })
          .finally(() => {
            this.autoTitlingWorkspaces.delete(workspaceId);
          });
      }

      return result;
    } catch (error) {
      if (claimedAutoTitle) {
        this.autoTitlingWorkspaces.delete(workspaceId);
        claimedAutoTitle = false;
      }

      if (resumedInterruptedTask) {
        try {
          await this.agentTaskIntegration?.restoreInterruptedTaskAfterResumeFailure(
            workspaceId,
            previousTaskStatus
          );
        } catch (restoreError: unknown) {
          log.error("Failed to restore interrupted task status after sendMessage throw", {
            workspaceId,
            error: restoreError,
          });
        }
      }

      const errorMessage = error instanceof Error ? error.message : JSON.stringify(error, null, 2);
      log.error("Unexpected error in sendMessage handler:", error);

      // Handle incompatible workspace errors from downgraded configs
      if (error instanceof IncompatibleRuntimeError) {
        const sendError: SendMessageError = {
          type: "incompatible_workspace",
          message: error.message,
        };
        return Err(sendError);
      }

      const sendError: SendMessageError = {
        type: "unknown",
        raw: `Failed to send message: ${errorMessage}`,
      };
      return Err(sendError);
    }
  }

  async resumeStream(
    workspaceId: string,
    options: SendMessageOptions,
    internal?: { allowQueuedAgentTask?: boolean; agentInitiated?: boolean }
  ): Promise<Result<{ started: boolean }, SendMessageError>> {
    let resumedInterruptedTask = false;
    let previousTaskStatus: ReturnType<AgentTaskIntegration["getAgentTaskStatus"]>;
    try {
      // Block streaming while workspace is being renamed to prevent path conflicts
      if (this.renamingWorkspaces.has(workspaceId)) {
        log.debug("resumeStream blocked: workspace is being renamed", { workspaceId });
        return Err({
          type: "unknown",
          raw: "Workspace is being renamed. Please wait and try again.",
        });
      }

      // Block streaming while workspace is being removed to prevent races with config/session deletion.
      if (this.removingWorkspaces.has(workspaceId)) {
        log.debug("resumeStream blocked: workspace is being removed", { workspaceId });
        return Err({
          type: "unknown",
          raw: "Workspace is being deleted. Please wait and try again.",
        });
      }

      // Archive admission pairing (see archiveUnlocked's refuseLiveUserActivity gate): resume
      // is a stream-starting entry point just like sendMessage, so it shares the same
      // synchronous guards — otherwise a resume admitted after the gate's activity snapshot
      // could start a provider stream hidden in the archived workspace.
      if (this.archivingWorkspaces.has(workspaceId)) {
        log.debug("resumeStream blocked: workspace is being archived", { workspaceId });
        return Err({
          type: "unknown",
          raw: "Workspace is being archived. Unarchive it before resuming.",
        });
      }
      {
        const workspaceEntry = findWorkspaceEntry(this.config.loadConfigOrDefault(), workspaceId);
        if (
          workspaceEntry != null &&
          isWorkspaceArchived(
            workspaceEntry.workspace.archivedAt,
            workspaceEntry.workspace.unarchivedAt
          )
        ) {
          log.debug("resumeStream blocked: workspace is archived", { workspaceId });
          return Err({
            type: "unknown",
            raw: "Workspace is archived. Unarchive it before resuming.",
          });
        }
      }
      // Count this resume as in-preflight in the same synchronous block as the checks above
      // (mirrors sendMessage): the archive gate refuses while a resume that already passed
      // these guards is still doing pre-admission work, so neither side can slip past the
      // other's snapshot.
      this.preflightSendCounts.set(
        workspaceId,
        (this.preflightSendCounts.get(workspaceId) ?? 0) + 1
      );
      using _preflightResume = {
        [Symbol.dispose]: () => {
          const remaining = (this.preflightSendCounts.get(workspaceId) ?? 1) - 1;
          if (remaining <= 0) {
            this.preflightSendCounts.delete(workspaceId);
          } else {
            this.preflightSendCounts.set(workspaceId, remaining);
          }
        },
      };
      using sessionInvisiblePreflight = this.armSessionInvisiblePreflight(workspaceId);
      // A resume never queues, so later sends must not wait on its decision.
      sessionInvisiblePreflight.markDecided();

      // Guard: avoid creating sessions for workspaces that don't exist anymore.
      if (!this.config.findWorkspace(workspaceId)) {
        return Err({
          type: "unknown",
          raw: "Workspace not found. It may have been deleted.",
        });
      }

      // Guard: queued agent tasks must not be resumed by generic UI/API calls.
      // Task orchestration is responsible for dequeuing and starting them.
      if (!internal?.allowQueuedAgentTask) {
        const config = this.config.loadConfigOrDefault();
        for (const [_projectPath, project] of config.projects) {
          const ws = project.workspaces.find((w) => w.id === workspaceId);
          if (!ws) continue;
          if (
            ws.parentWorkspaceId &&
            (ws.taskStatus === "queued" || ws.taskStatus === "starting")
          ) {
            taskQueueDebug("WorkspaceService.resumeStream blocked (queued/starting task)", {
              workspaceId,
              stack: new Error("resumeStream blocked").stack,
            });
            return Err({
              type: "unknown",
              raw: "This agent task is queued or starting and cannot resume through generic calls yet.",
            });
          }
          break;
        }
      } else {
        taskQueueDebug("WorkspaceService.resumeStream allowed (internal dequeue)", {
          workspaceId,
          stack: new Error("resumeStream internal").stack,
        });
      }

      const session = this.getOrCreateSession(workspaceId);

      const taskStatus = this.agentTaskIntegration?.getAgentTaskStatus(workspaceId);
      if (taskStatus === "interrupted" && session.isBusy()) {
        return Err({
          type: "unknown",
          raw: "Interrupted task is still winding down. Wait until it is idle, then try again.",
        });
      }

      const normalizedOptions = this.normalizeSendMessageAgentId(options);

      // Reject before persistence/dispatch when the chosen model would silently
      // bypass budget enforcement on a budgeted resumable goal.
      const pricingGate = await this.assertPricedModelForBudgetedGoal(
        workspaceId,
        normalizedOptions
      );
      if (!pricingGate.success) {
        return Err(pricingGate.error);
      }

      // Non-destructive interrupt cascades preserve descendant task workspaces with
      // taskStatus=interrupted. Transition before stream start so task orchestration stream-end
      // handling does not early-return on interrupted status.
      if (
        findWorkspaceEntry(this.config.loadConfigOrDefault(), workspaceId)?.workspace
          .taskDesktopOwnerWorkspaceId !== undefined
      ) {
        await this.desktopInputCoordinator.withAdmission(workspaceId, () =>
          Promise.resolve(undefined)
        );
      }
      previousTaskStatus = this.agentTaskIntegration?.getAgentTaskStatus(workspaceId);
      resumedInterruptedTask =
        (await this.agentTaskIntegration?.markInterruptedTaskRunning(workspaceId)) ?? false;

      // Codex P1 (PRRT_kwDOPxxmWM6cSREO): resumeStream runs its own async
      // admission (a second pricing gate) during which the session still
      // reports idle — releasing the reservation before that await let
      // follow-up recovery admit a recovered synthetic turn that then ran
      // concurrently with the resumed stream. Hold the reservation until the
      // session call settles: resumeStream returns once the stream has
      // started (or refused), so no follow-up redispatched from within the
      // resumed turn itself can observe the reservation and self-veto.
      const result = await session.resumeStream(normalizedOptions, {
        agentInitiated: internal?.agentInitiated,
      });
      sessionInvisiblePreflight.release();
      if (!result.success) {
        log.error("resumeStream handler: session returned error", {
          workspaceId,
          error: result.error,
        });
        if (resumedInterruptedTask) {
          try {
            await this.agentTaskIntegration?.restoreInterruptedTaskAfterResumeFailure(
              workspaceId,
              previousTaskStatus
            );
          } catch (error: unknown) {
            log.error("Failed to restore interrupted task status after resumeStream failure", {
              workspaceId,
              error,
            });
          }
        }
        return result;
      }

      // resumeStream can succeed without starting a new stream when the session is
      // still busy (started=false). Keep interrupted semantics in that case.
      if (!result.data.started) {
        if (resumedInterruptedTask) {
          try {
            await this.agentTaskIntegration?.restoreInterruptedTaskAfterResumeFailure(
              workspaceId,
              previousTaskStatus
            );
          } catch (error: unknown) {
            log.error("Failed to restore interrupted task status after no-op resumeStream", {
              workspaceId,
              error,
            });
          }
        }
        return result;
      }

      return result;
    } catch (error) {
      if (resumedInterruptedTask) {
        try {
          await this.agentTaskIntegration?.restoreInterruptedTaskAfterResumeFailure(
            workspaceId,
            previousTaskStatus
          );
        } catch (restoreError: unknown) {
          log.error("Failed to restore interrupted task status after resumeStream throw", {
            workspaceId,
            error: restoreError,
          });
        }
      }

      const errorMessage = getErrorMessage(error);
      log.error("Unexpected error in resumeStream handler:", error);

      // Handle incompatible workspace errors from downgraded configs
      if (error instanceof IncompatibleRuntimeError) {
        const sendError: SendMessageError = {
          type: "incompatible_workspace",
          message: error.message,
        };
        return Err(sendError);
      }

      const sendError: SendMessageError = {
        type: "unknown",
        raw: `Failed to resume stream: ${errorMessage}`,
      };
      return Err(sendError);
    }
  }

  async setAutoRetryEnabled(
    workspaceId: string,
    enabled: boolean,
    persist = true
  ): Promise<Result<{ previousEnabled: boolean; enabled: boolean }>> {
    try {
      const session = this.getOrCreateSession(workspaceId);
      const state = await session.setAutoRetryEnabled(enabled, { persist });
      return Ok(state);
    } catch (error) {
      const errorMessage = error instanceof Error ? error.message : String(error);
      log.error("Unexpected error in setAutoRetryEnabled handler:", error);
      return Err(`Failed to set auto-retry enabled state: ${errorMessage}`);
    }
  }

  async dispatchPendingCompactionFollowUp(workspaceId: string): Promise<Result<boolean>> {
    try {
      return Ok(
        await this.withStartupSession(workspaceId, (session) =>
          session.dispatchPendingCompactionFollowUpIfNeeded(undefined, true)
        )
      );
    } catch (error) {
      log.warn("Failed to recover pending compaction follow-up", { workspaceId, error });
      return Err(getErrorMessage(error));
    }
  }

  getStartupRecoveryState(
    workspaceId: string
  ): ReturnType<AgentSession["getStartupRecoveryState"]> {
    return this.withStartupSession(workspaceId, (session) => session.getStartupRecoveryState());
  }

  async getStartupAutoRetryModel(workspaceId: string): Promise<Result<string | null>> {
    try {
      return Ok(await this.getOrCreateSession(workspaceId).getStartupAutoRetryModelHint());
    } catch (error) {
      const errorMessage = error instanceof Error ? error.message : String(error);
      log.error("Unexpected error in getStartupAutoRetryModel handler:", error);
      return Err(`Failed to inspect startup auto-retry model: ${errorMessage}`);
    }
  }

  setAutoCompactionThreshold(workspaceId: string, threshold: number): Result<void> {
    try {
      const session = this.getOrCreateSession(workspaceId);
      session.setAutoCompactionThreshold(threshold);
      return Ok(undefined);
    } catch (error) {
      const errorMessage = error instanceof Error ? error.message : String(error);
      log.error("Unexpected error in setAutoCompactionThreshold handler:", error);
      return Err(`Failed to set auto-compaction threshold: ${errorMessage}`);
    }
  }

  async interruptStream(
    workspaceId: string,
    options?: {
      soft?: boolean;
      abandonPartial?: boolean;
      sendQueuedImmediately?: boolean;
      retireBashMonitorAttention?: boolean;
      disableAutoRetry?: boolean;
    }
  ): Promise<Result<void>> {
    let releaseHardStopLatch: (() => void) | undefined;
    try {
      this.agentTaskIntegration?.resetAutoResumeCount(workspaceId);
      if (!options?.soft) {
        // Mark before attempting the session interrupt to close races where a child
        // could report between stop initiation and descendant cascade termination.
        this.agentTaskIntegration?.markParentWorkspaceInterrupted(workspaceId);
        // Latch synchronously at the request boundary, BEFORE the session-interrupt await
        // below: the suppression mark above is level-triggered (a user resume clears it), so
        // a peer send from a still-running descendant entering during that await — or during
        // the cascade's own mutex acquisition — would otherwise capture the already-bumped
        // ancestor epoch as its clean baseline and wake workspaces outside the stopped
        // subtree. Released in the finally, after the descendant cascade persisted terminal
        // statuses.
        releaseHardStopLatch = this.agentTaskIntegration?.latchHardInterruptCascade(workspaceId);
      }

      const session = this.getOrCreateSession(workspaceId);
      // Only a user Stop dismisses owed attention; internal interrupts (goal promotion, archive,
      // ACP disconnect, send-now) must not lose monitor output. Start retiring before the abort:
      // consumeCurrent withdraws an in-flight dispatch synchronously and reserves the reconciler
      // lock ahead of the reconcile this abort's idle transition triggers, so the abort itself
      // never waits behind acceptance I/O. The durable consumption commits only once the stop
      // succeeded: a failed stop leaves the agent running, so its output stays owed. Monitors stay
      // armed for new output. Retirement I/O that fails keeps the frontier owed in memory (the
      // reconciler retries it before any dispatch, as does the next Stop) but fails this Stop
      // below: that obligation is not durable, so a restart before the retry could wake the agent
      // on the dismissed output. Never behind the history lock (a wake admission holds it across
      // stream construction).
      const retiring = options?.retireBashMonitorAttention === true;
      const withdrawnWakeSend = retiring
        ? this.inFlightBashMonitorWakeSendsByOwner.get(workspaceId)
        : undefined;
      let settleStop!: (stopped: boolean) => void;
      const stopSettled = new Promise<boolean>((resolve) => {
        settleStop = resolve;
      });
      let retirementRecorded = true;
      const retirement = retiring
        ? this.bashMonitorWakeReconciler
            .consumeCurrent(workspaceId, () => stopSettled)
            .catch((error: unknown) => {
              retirementRecorded = false;
              log.warn("Failed to retire bash monitor attention before Stop", {
                workspaceId,
                error,
              });
            })
        : undefined;
      // The opt-out starts only after retirement reserved the reconciler lock above: disabling
      // retry releases the idle gate a pending wake may be waiting behind, and that wake must
      // find its attention withdrawn, not a window to start a turn after the user's Stop. The
      // interrupt does not wait for the opt-out's disk write (a stuck write must not keep the
      // stream running); the write is joined and verified below, and a failure fails the Stop.
      const disabling = options?.disableAutoRetry === true;
      const optOut = disabling
        ? session.setAutoRetryEnabled(false).catch((error: unknown) => {
            log.warn("Failed to disable auto-retry during Stop", { workspaceId, error });
          })
        : undefined;
      let stopResult: Result<void> | undefined;
      try {
        stopResult = await session.interruptStream(options);
      } finally {
        settleStop(stopResult?.success === true);
      }
      await retirement;
      await optOut;
      // A wake withdrawn past its point of no return (durable row, not yet PREPARING, so the
      // session interrupt above saw idle) records the startup abandon marker for that row on every
      // exit before it resolves, including a failed goal sync or acceptance (see
      // abandonWithdrawnSend in AgentSession.sendMessage). Stop is acknowledged after it settles: a
      // forced exit right after Stop must not leave the row eligible for startup replay. The send's
      // own result is the dispatch's to report; a marker (or a RetryBarrier Stop's opt-out) still
      // unrecorded after the session retried the write fails the Stop below, on this and every later
      // Stop, so the obligation is not lost with the joined send.
      await withdrawnWakeSend?.catch(() => undefined);
      const stopRecorded =
        !(retiring || disabling) ||
        ((await session.recordPendingAutoRetryState()) && retirementRecorded);
      if (!stopResult.success) {
        // Interrupt failed, so clear hard-interrupt suppression we set above.
        if (!options?.soft) {
          this.agentTaskIntegration?.resetAutoResumeCount(workspaceId);
        }
        log.error("Failed to stop stream:", stopResult.error);
        return Err(stopResult.error);
      }

      // For hard interrupts, delete partial immediately. For soft interrupts,
      // defer to stream-abort handler (stream is still running and may recreate partial).
      if (options?.abandonPartial && !options?.soft) {
        log.debug("Abandoning partial for workspace:", workspaceId);
        await this.historyService.deletePartial(workspaceId);
      }

      // Rationale: user-initiated hard interrupts should stop the entire task tree so
      // descendant sub-agents cannot finish later and auto-resume this workspace.
      if (!options?.soft) {
        try {
          const interruptedTaskIds =
            await this.agentTaskIntegration?.terminateAllDescendantAgentTasks(workspaceId);
          if (interruptedTaskIds && interruptedTaskIds.length > 0) {
            log.debug("Cascade-interrupted descendant tasks on interrupt", {
              workspaceId,
              interruptedTaskIds,
            });
          }
        } catch (error: unknown) {
          log.error("Failed to cascade-interrupt descendant tasks on interrupt", {
            workspaceId,
            error,
          });
        }
      }

      // Handle queued messages based on option
      if (options?.sendQueuedImmediately) {
        // `sendQueuedMessages()` routes through AgentSession directly, so explicitly
        // clear hard-interrupt suppression first (it won't flow through sendMessage()).
        this.agentTaskIntegration?.resetAutoResumeCount(workspaceId);
        // The card represents only user-authored queue content. Prioritize that
        // entry over hidden synthetic/background work before dispatching.
        session.sendNextUserQueuedMessage();
      } else {
        // Restore queued messages to input box for user-initiated interrupts
        session.restoreQueueToInput();
      }

      if (!stopRecorded) {
        log.error("Stop left stopped work eligible to resume on restart", { workspaceId });
        return Err(STOP_UNRECORDED_MESSAGE);
      }
      return Ok(undefined);
    } catch (error) {
      if (!options?.soft) {
        // Keep suppression state consistent if interrupt setup/stop throws.
        this.agentTaskIntegration?.resetAutoResumeCount(workspaceId);
      }
      const errorMessage = getErrorMessage(error);
      log.error("Unexpected error in interruptStream handler:", error);
      return Err(`Failed to interrupt stream: ${errorMessage}`);
    } finally {
      releaseHardStopLatch?.();
    }
  }

  async answerAskUserQuestion(
    workspaceId: string,
    toolCallId: string,
    answers: Record<string, string>
  ): Promise<Result<void>> {
    try {
      // Fast path: normal in-memory execution (stream still running, tool is awaiting input).
      askUserQuestionManager.answer(workspaceId, toolCallId, answers);
      return Ok(undefined);
    } catch (error) {
      // Fallback path: app restart (or other process death) means the in-memory
      // AskUserQuestionManager has no pending entry anymore.
      //
      // In that case we persist the tool result into partial.json or chat.jsonl,
      // then emit a synthetic tool-call-end so the renderer updates immediately.
      try {
        // Helper: update a message in-place if it contains this ask_user_question tool call.
        const tryFinalizeMessage = (
          msg: MuxMessage
        ): Result<{ updated: MuxMessage; output: AskUserQuestionToolSuccessResult }> => {
          let foundToolCall = false;
          let output: AskUserQuestionToolSuccessResult | null = null;
          let errorMessage: string | null = null;

          const updatedParts = msg.parts.map((part) => {
            if (!isDynamicToolPart(part) || part.toolCallId !== toolCallId) {
              return part;
            }

            foundToolCall = true;

            if (part.toolName !== "ask_user_question") {
              errorMessage = `toolCallId=${toolCallId} is toolName=${part.toolName}, expected ask_user_question`;
              return part;
            }

            // Already answered - treat as idempotent.
            if (part.state === "output-available") {
              const parsedOutput = AskUserQuestionToolResultSchema.safeParse(part.output);
              if (!parsedOutput.success) {
                errorMessage = `ask_user_question output validation failed: ${parsedOutput.error.message}`;
                return part;
              }
              output = parsedOutput.data;
              return part;
            }

            const parsedArgs = AskUserQuestionToolArgsSchema.safeParse(part.input);
            if (!parsedArgs.success) {
              errorMessage = `ask_user_question input validation failed: ${parsedArgs.error.message}`;
              return part;
            }

            const nextOutput: AskUserQuestionToolSuccessResult = {
              summary: buildAskUserQuestionSummary(answers),
              ui_only: {
                ask_user_question: {
                  questions: parsedArgs.data.questions,
                  answers,
                },
              },
            };
            output = nextOutput;

            return {
              ...part,
              state: "output-available" as const,
              output: nextOutput,
            };
          });

          if (errorMessage) {
            return Err(errorMessage);
          }
          if (!foundToolCall) {
            return Err("ask_user_question toolCallId not found in message");
          }
          if (!output) {
            return Err("ask_user_question output missing after update");
          }

          return Ok({ updated: { ...msg, parts: updatedParts }, output });
        };

        // 1) Prefer partial.json (most common after restart while waiting)
        const partial = await this.historyService.readPartial(workspaceId);
        if (partial) {
          const finalized = tryFinalizeMessage(partial);
          if (finalized.success) {
            const writeResult = await this.historyService.writePartial(
              workspaceId,
              finalized.data.updated
            );
            if (!writeResult.success) {
              return Err(writeResult.error);
            }

            const session = this.getOrCreateSession(workspaceId);
            session.emitChatEvent({
              type: "tool-call-end",
              workspaceId,
              messageId: finalized.data.updated.id,
              toolCallId,
              toolName: "ask_user_question",
              result: finalized.data.output,
              timestamp: Date.now(),
            });

            return Ok(undefined);
          }
        }

        // 2) Fall back to chat history (partial may have already been committed).
        // Only the current compaction epoch matters — pending tool calls don't survive compaction.
        const historyResult = await this.historyService.getHistoryFromLatestBoundary(workspaceId);
        if (!historyResult.success) {
          return Err(historyResult.error);
        }

        // Find the newest message containing this tool call.
        let best: MuxMessage | null = null;
        let bestSeq = -Infinity;
        for (const msg of historyResult.data) {
          const seq = msg.metadata?.historySequence;
          if (seq === undefined) continue;

          const hasTool = msg.parts.some(
            (p) => isDynamicToolPart(p) && p.toolCallId === toolCallId
          );
          if (hasTool && seq > bestSeq) {
            best = msg;
            bestSeq = seq;
          }
        }

        if (!best) {
          const errorMessage = getErrorMessage(error);
          return Err(`Failed to answer ask_user_question: ${errorMessage}`);
        }

        // Guard against answering stale tool calls.
        const maxSeq = Math.max(
          ...historyResult.data
            .map((m) => m.metadata?.historySequence)
            .filter((n): n is number => typeof n === "number")
        );
        if (bestSeq !== maxSeq) {
          return Err(
            `Refusing to answer ask_user_question: tool call is not the latest message (toolSeq=${bestSeq}, latestSeq=${maxSeq})`
          );
        }

        const finalized = tryFinalizeMessage(best);
        if (!finalized.success) {
          return Err(finalized.error);
        }

        const updateResult = await this.historyService.updateHistory(
          workspaceId,
          finalized.data.updated
        );
        if (!updateResult.success) {
          return Err(updateResult.error);
        }

        const session = this.getOrCreateSession(workspaceId);
        session.emitChatEvent({
          type: "tool-call-end",
          workspaceId,
          messageId: finalized.data.updated.id,
          toolCallId,
          toolName: "ask_user_question",
          result: finalized.data.output,
          timestamp: Date.now(),
        });

        return Ok(undefined);
      } catch (innerError) {
        const errorMessage = getErrorMessage(innerError);
        return Err(errorMessage);
      }
    }
  }

  answerDelegatedToolCall(workspaceId: string, toolCallId: string, result: unknown): Result<void> {
    try {
      delegatedToolCallManager.answer(workspaceId, toolCallId, result);
      return Ok(undefined);
    } catch (error) {
      const errorMessage = getErrorMessage(error);
      return Err(`Failed to answer delegated tool call: ${errorMessage}`);
    }
  }

  clearQueue(workspaceId: string, options?: { cancelReason?: string }): Result<void> {
    try {
      this.sessions.get(workspaceId.trim())?.clearQueue(options?.cancelReason);
      return Ok(undefined);
    } catch (error) {
      const errorMessage = getErrorMessage(error);
      log.error("Unexpected error in clearQueue handler:", error);
      return Err(`Failed to clear queue: ${errorMessage}`);
    }
  }

  setQueuedMessageDispatchMode(
    workspaceId: string,
    queueDispatchMode: "tool-end" | "turn-end"
  ): Result<boolean> {
    try {
      const session = this.getOrCreateSession(workspaceId);
      return Ok(session.setQueuedMessageDispatchMode(queueDispatchMode));
    } catch (error) {
      const errorMessage = getErrorMessage(error);
      log.error("Unexpected error updating queued message dispatch mode:", error);
      return Err(`Failed to update queued message dispatch mode: ${errorMessage}`);
    }
  }

  removeQueuedMessagesByDedupeKeyPrefix(
    workspaceId: string,
    prefix: string,
    options?: { cancelReason?: string; skipCancelCallbacks?: boolean }
  ): Result<number> {
    try {
      const session = this.sessions.get(workspaceId.trim());
      if (session == null) {
        return Ok(0);
      }
      return Ok(
        session.removeQueuedMessagesByDedupeKeyPrefix(
          prefix,
          options?.cancelReason ?? "Queued message superseded before dispatch.",
          options?.skipCancelCallbacks === true ? { skipCancelCallbacks: true } : undefined
        )
      );
    } catch (error) {
      const errorMessage = getErrorMessage(error);
      log.error("Unexpected error removing queued messages by dedupe prefix:", error);
      return Err(`Failed to remove queued messages: ${errorMessage}`);
    }
  }

  isBusyForMessage(workspaceId: string): boolean {
    return this.sessions.get(workspaceId.trim())?.isBusy() === true;
  }

  hasQueuedWorkspaceTurn(workspaceId: string, handleId: string): boolean {
    return this.sessions.get(workspaceId.trim())?.hasQueuedWorkspaceTurn(handleId) ?? false;
  }

  /**
   * Remove only the queued workspace-turn entry for this handle (targeted cancel);
   * unrelated queued messages stay pending. Returns whether an entry was removed.
   */
  removeQueuedWorkspaceTurn(
    workspaceId: string,
    handleId: string,
    options: { cancelReason: string }
  ): Result<boolean> {
    try {
      const session = this.sessions.get(workspaceId.trim());
      if (session == null) {
        return Ok(false);
      }
      return Ok(session.removeQueuedWorkspaceTurn(handleId, options.cancelReason));
    } catch (error) {
      const errorMessage = getErrorMessage(error);
      log.error("Unexpected error in removeQueuedWorkspaceTurn handler:", error);
      return Err(`Failed to remove queued workspace turn: ${errorMessage}`);
    }
  }

  hasQueuedOrDispatchingEntry(workspaceId: string): boolean {
    return this.sessions.get(workspaceId.trim())?.hasQueuedOrDispatchingEntry() ?? false;
  }

  hasQueuedMessages(workspaceId: string, dispatchMode?: "tool-end" | "turn-end"): boolean {
    return this.sessions.get(workspaceId.trim())?.hasQueuedMessages(dispatchMode) ?? false;
  }

  async waitForPendingCompactionCompletionDecision(
    workspaceId: string,
    messageId: string
  ): Promise<boolean | undefined> {
    const session = this.sessions.get(workspaceId.trim());
    return session?.waitForPendingCompactionCompletionDecision(messageId);
  }

  async waitForPendingStreamErrorRecoveryDecision(
    workspaceId: string,
    messageId: string
  ): Promise<StreamErrorRecoveryOutcome | undefined> {
    const session = this.sessions.get(workspaceId.trim());
    return session?.waitForPendingStreamErrorRecoveryDecision(messageId);
  }

  async waitForIdle(workspaceId: string): Promise<void> {
    const session = this.sessions.get(workspaceId.trim());
    await session?.waitForIdle();
  }

  async waitForIdleAndNoQueuedMessages(workspaceId: string): Promise<void> {
    const session = this.sessions.get(workspaceId.trim());
    if (!session) {
      return;
    }

    if (session.closingSignal.aborted) throw new Error(WORKSPACE_IDLE_WAIT_CANCELED_MESSAGE);
    // Pending mid-stream compaction is turn work the coordinator cannot see: the session reads
    // idle until the compaction request claims PREPARING.
    const hasTurnWork = () =>
      session.hasActiveOrPendingTurnWork() ||
      session.hasQueuedMessages() ||
      session.hasPendingAutoRetry();
    while (hasTurnWork()) {
      if (session.closingSignal.aborted) throw new Error(WORKSPACE_IDLE_WAIT_CANCELED_MESSAGE);
      if (session.isBusy()) {
        await session.waitForIdle();
        continue;
      }
      if (session.hasActiveOrPendingTurnWork()) {
        await session.waitForMidStreamCompactionSettled();
        continue;
      }

      await new Promise<void>((resolve) => {
        let settled = false;
        const finish = () => {
          if (settled) {
            return;
          }
          settled = true;
          unsubscribe();
          session.closingSignal.removeEventListener("abort", finish);
          resolve();
        };
        const unsubscribe = session.onChatEvent((event) => {
          const eventType = event.message.type;
          const retryStartedOrTurnPhaseChanged =
            eventType === "auto-retry-starting" ||
            eventType === "auto-retry-scheduled" ||
            eventType === "stream-lifecycle";
          const queuedOrRetryCleared =
            (eventType === "queued-message-changed" || eventType === "auto-retry-abandoned") &&
            !hasTurnWork();
          if (retryStartedOrTurnPhaseChanged || queuedOrRetryCleared) {
            finish();
          }
        });
        session.closingSignal.addEventListener("abort", finish, { once: true });
        if (session.closingSignal.aborted || !hasTurnWork()) {
          finish();
        }
      });
    }
    if (session.closingSignal.aborted) throw new Error(WORKSPACE_IDLE_WAIT_CANCELED_MESSAGE);
  }

  hasPendingQueuedOrPreparingTurn(workspaceId: string): boolean {
    const session = this.sessions.get(workspaceId.trim());
    if (!session) {
      return false;
    }

    return (
      session.hasQueuedMessages() || session.isPreparingTurn() || session.hasPendingAutoRetry()
    );
  }

  /**
   * Whether a bash-monitor-wake continuation is queued next or mid-dispatch.
   * See AgentSession.hasPendingBashMonitorWakeContinuation for semantics.
   */
  hasPendingBashMonitorWakeContinuation(workspaceId: string): boolean {
    const session = this.sessions.get(workspaceId.trim());
    return session?.hasPendingBashMonitorWakeContinuation() ?? false;
  }

  /**
   * Whether a queued or dispatching entry continues the exact workspace-turn correlation.
   */
  hasPendingWorkspaceTurnContinuation(
    workspaceId: string,
    metadata: Extract<MuxMessageMetadata, { type: "workspace-turn-task" }>
  ): boolean {
    const session = this.sessions.get(workspaceId.trim());
    return session?.hasPendingWorkspaceTurnContinuation(metadata) ?? false;
  }

  /**
   * Input poised to take over the session at a queue cut, for cut attribution.
   * See AgentSession.getQueueCutCutter for stage semantics.
   */
  getQueueCutCutter(workspaceId: string): QueueCutCutter | undefined {
    const session = this.sessions.get(workspaceId.trim());
    return session?.getQueueCutCutter();
  }

  /** See AgentSession.getStoppablePreparingWorkspaceTurn. */
  getStoppablePreparingWorkspaceTurn(
    workspaceId: string
  ): WorkspaceTurnTaskCorrelation | undefined {
    return this.sessions.get(workspaceId.trim())?.getStoppablePreparingWorkspaceTurn();
  }

  /**
   * Narrow check for an actual scheduled/starting auto-retry, excluding queued
   * manual messages and preparing turns. Callers that must distinguish "the
   * same turn will resume on its own" from "some other queued work exists"
   * (e.g. workspace-turn stream-error settlement) need this instead of
   * hasPendingQueuedOrPreparingTurn.
   */
  hasPendingAutoRetry(workspaceId: string): boolean {
    const session = this.sessions.get(workspaceId.trim());
    return session?.hasPendingAutoRetry() ?? false;
  }

  /**
   * Best-effort delete of plan files (new + legacy paths) for a workspace.
   *
   * Why best-effort: plan files may not exist yet, or deletion may fail due to permissions.
   */
  private async deletePlanFilesForWorkspace(
    workspaceId: string,
    metadata: FrontendWorkspaceMetadata
  ): Promise<void> {
    // Create runtime to get correct xumHome (local ~/.xum, SSH ~/.mux, Docker /var/mux)
    const runtime = createRuntimeForWorkspace(metadata);
    const xumHome = runtime.getXumHome();
    const planPath = getPlanFilePath(metadata.name, metadata.projectName, xumHome);
    const legacyPlanPath = getLegacyPlanFilePath(workspaceId, xumHome);

    const isDocker = isDockerRuntime(metadata.runtimeConfig);
    const isSSH = isSSHRuntime(metadata.runtimeConfig);

    // For Docker: paths are already absolute (/var/mux/...), just quote
    // For SSH: use $HOME expansion so the runtime shell resolves to the runtime home directory
    // For local: expand tilde locally since shellQuote prevents shell expansion
    const quotedPlanPath = isDocker
      ? shellQuote(planPath)
      : isSSH
        ? expandTildeForSSH(planPath)
        : shellQuote(expandTilde(planPath));
    // For legacy path: SSH/Docker use $HOME expansion, local expands tilde
    const quotedLegacyPlanPath =
      isDocker || isSSH
        ? expandTildeForSSH(legacyPlanPath)
        : shellQuote(expandTilde(legacyPlanPath));

    if (isDocker || isSSH) {
      try {
        // Use exec to delete files since runtime doesn't have a deleteFile method.
        // Use runtime workspace path (not host projectPath) for Docker containers.
        const workspacePath = runtime.getWorkspacePath(metadata.projectPath, metadata.name);
        const execStream = await runtime.exec(`rm -f ${quotedPlanPath} ${quotedLegacyPlanPath}`, {
          cwd: workspacePath,
          timeout: 10,
        });

        try {
          await execStream.stdin.close();
        } catch {
          // Ignore stdin-close errors (e.g. already closed).
        }

        await execStream.exitCode.catch(() => {
          // Best-effort: ignore failures.
        });
      } catch {
        // Plan files don't exist or can't be deleted - ignore
      }

      return;
    }

    // Local runtimes: delete directly on the local filesystem.
    const planPathAbs = expandTilde(planPath);
    const legacyPlanPathAbs = expandTilde(legacyPlanPath);

    await Promise.allSettled([
      fsPromises.rm(planPathAbs, { force: true }),
      fsPromises.rm(legacyPlanPathAbs, { force: true }),
    ]);
  }

  private clearHistoryWithRetiredBashMonitorWakes<T>(
    workspaceId: string,
    clear: () => Promise<Result<T>>,
    options?: { discardUnacceptedOnSuccess?: boolean }
  ): Promise<Result<T>> {
    if (options?.discardUnacceptedOnSuccess !== true) return clear();
    return this.bashMonitorRecoveryPromise.then(() =>
      this.bashMonitorHistoryLocks.withLock(workspaceId, async () => {
        if (this.removingWorkspaces.has(workspaceId)) {
          return Err("Cannot clear history while the workspace is being removed.");
        }
        const clearToken = await this.bashMonitorWakeReconciler.beginFullHistoryClear(workspaceId);
        this.notifyBashMonitorWakeStateChanged(workspaceId);
        const result = await clear();
        if (result.success) {
          await this.bashMonitorWakeReconciler.finishFullHistoryClear(clearToken);
          this.notifyBashMonitorWakeStateChanged(workspaceId);
        }
        return result;
      })
    );
  }

  async truncateHistory(workspaceId: string, percentage?: number): Promise<Result<void>> {
    const effectivePercentage = percentage ?? 1.0;
    // The admission guard is acquired BEFORE the scope preflight and held across every await
    // below: a turn admitted during any of them could snapshot the pre-truncation transcript
    // and stream across the mutation, and one admitted during the preflight itself could
    // launch a kernel workflow whose sidecar reference the wholesale retirement below would
    // delete while its launch turn's rows survive the prefix cut, permanently suppressing
    // that run's wake. The preflight cannot yet prove scope "none", so every request that
    // may remove rows (percentage > 0) pays the guard; percentage <= 0 is a deterministic
    // no-op that retires nothing and keeps the plain busy pre-check.
    let admissionGuard: Disposable | null = null;
    if (effectivePercentage > 0) {
      const guardResult = this.acquireContextMutationAdmissionGuard(
        workspaceId,
        "truncate history"
      );
      if (!guardResult.success) {
        return Err(guardResult.error);
      }
      admissionGuard = guardResult.data;
    } else if (
      this.sessions.get(workspaceId)?.isBusy() ||
      this.aiService.isStreaming(workspaceId)
    ) {
      return Err(
        "Cannot truncate history while a turn is active. Press Esc to stop the stream first."
      );
    }
    using _admissionGuard = admissionGuard;
    // A token-proportional truncation below 100% can remove nothing (budget rounds to zero),
    // a proper prefix, or everything (historyService's full-delete fast path), and each scope
    // carries different obligations: an emptied transcript needs every full-clear guard, a
    // prefix cut still needs kernel workflow reference retirement (it can delete the launch
    // turn's restriction rows without a supersession decision), and a no-op must retire
    // nothing, or active runs' wakes would settle superseded under an unchanged transcript.
    // Decide up front; historyService revalidates the dangerous drift directions under the
    // history write lock (refuseFullDelete / refuseRowRemoval / requireFullDelete below).
    const truncationScope =
      effectivePercentage >= 1.0
        ? ("all" as const)
        : effectivePercentage <= 0
          ? ("none" as const)
          : await this.historyService
              .classifyTruncationRemoval(workspaceId, effectivePercentage)
              .catch((error: unknown) => {
                log.warn("History truncation scope preflight failed; refusing truncation", {
                  workspaceId,
                  error,
                });
                return null;
              });
    if (truncationScope == null) {
      // An unknown scope must not choose a side-effect set: labeling it a full clear would
      // discard goal/plan/retry state and advance the context epoch while rows may remain,
      // and labeling it smaller would skip full-clear guards. Nothing is mutated or retired
      // yet, so refusing is lossless and the user can simply retry.
      return Err("Failed to read history to classify the truncation scope. Try again.");
    }
    const isFullClear = truncationScope === "all";
    const session = this.sessions.get(workspaceId);

    // A full clear discards the transcript a streaming refine pass may be
    // distilling — and unlike a reset it appends NO boundary marker, so the
    // pass's boundary identity stays null-to-null; only its segment-anchor
    // recheck (first-row identity) catches the mutation. Drain the pass and
    // hold the shared refine lock across the truncation so the recheck and
    // this mutation cannot interleave (see acquireRefineSerializationLock).
    let refineLock: AsyncDisposable | null = null;
    if (isFullClear) {
      await this.refinePassCanceller?.cancelInFlightRefinePass(workspaceId);
      const refineLockResult = await this.acquireRefineSerializationLock(
        workspaceId,
        "clear history"
      );
      if (!refineLockResult.success) {
        return Err(refineLockResult.error);
      }
      refineLock = refineLockResult.data;
    }
    await using _refineLock = refineLock;
    // Recheck under the guard + lock: the admission block refuses ordinary
    // turn starts during the awaits above, but in-turn compaction retries
    // bypass admission gating when they cross a transient idle gap.
    if (
      isFullClear &&
      (session?.hasActiveOrPendingTurnWork() || this.aiService.isStreaming(workspaceId))
    ) {
      return Err(
        "Cannot truncate history while a turn is active. Press Esc to stop the stream first."
      );
    }
    // r41: a retry scheduled before this clear would replay the discarded
    // context after the guard releases — cancel it and drop the partial
    // durably before the transcript goes away.
    if (isFullClear && session) {
      const retryDiscard = await session.discardAutoRetryForContextMutation();
      if (!retryDiscard.success) {
        return Err(
          `Cannot clear history: pending retry state could not be discarded (${retryDiscard.error})`
        );
      }
    }
    // Kernel workflow run references belong to the conversation this truncation mutates: a
    // full clear leaves a verified-empty (null) boundary snapshot reading the fresh
    // conversation as current, and even a prefix truncation can delete the launch turn's
    // restriction-bearing rows without appending any supersession decision, letting the wake
    // recompose from unrestricted defaults. Retire the references on every row-removing
    // truncation, BEFORE it commits, so both fault directions fail safe: a failed retirement
    // aborts with the conversation intact, and a failed or refused truncation leaves
    // reference-less runs settling superseded (dropped wake, still retrievable via resume,
    // which re-records provenance under the surviving context).
    if (truncationScope !== "none") {
      try {
        await this.retireKernelWorkflowRunReferences(workspaceId);
      } catch (error) {
        return Err(
          `Cannot clear history: stale workflow run references could not be retired ` +
            `(${getErrorMessage(error)}). Retry once the session storage is writable.`
        );
      }
      // In-turn compaction retries bypass admission gating across a transient idle gap (see
      // the full-clear recheck above), and this retirement is the last await before the
      // rewrite for BOTH row-removing scopes: revalidate here or a retry admitted during it
      // would have its history truncated underneath the stream. Refusing after retirement is
      // the documented fail-safe direction (dropped wake, retrievable via resume).
      if (session?.hasActiveOrPendingTurnWork() || this.aiService.isStreaming(workspaceId)) {
        return Err(
          "Cannot truncate history while a turn is active. Press Esc to stop the stream first."
        );
      }
    }
    if (effectivePercentage > 0) {
      session?.clearUsageState();
    }
    // historyService revalidates the scope preflight under the history write lock: an
    // overlapping mutation can shift this one across a scope boundary in any dangerous
    // direction (a partial cut becoming a full delete skips the full-clear guards; a no-op
    // becoming a real cut skips reference retirement; a full clear leaving survivors would
    // apply full-clear-only discards while rows remain).
    const truncate = () =>
      this.historyService.truncateHistory(workspaceId, effectivePercentage, {
        refuseFullDelete: truncationScope === "partial",
        refuseRowRemoval: truncationScope === "none",
        requireFullDelete: truncationScope === "all",
      });
    const truncateResult =
      effectivePercentage > 0
        ? await this.clearHistoryWithRetiredBashMonitorWakes(workspaceId, truncate, {
            discardUnacceptedOnSuccess: isFullClear,
          })
        : await truncate();
    if (!truncateResult.success) {
      return Err(truncateResult.error);
    }

    // r41: the discard is durable — sends that entered before it must not be
    // admitted afterwards (their content references the discarded context).
    if (isFullClear) {
      this.advanceContextMutationEpoch(workspaceId);
    }
    // r43: a fork's settled branch-summary registration stays consumable
    // until the first send; its row was just deleted, so drop the
    // registration too or the next send would re-emit the discarded summary
    // into the live transcript (resurfacing pre-clear content that is absent
    // from history after reload). Only AFTER the truncation commits (r44): a
    // failed clear keeps the row in history, and dropping the registration
    // first would leave that never-emitted row with nothing to emit it —
    // hidden assistant context the user cannot see until a reload. Late
    // in-flight writer appends stay safe either way via the compare-and-
    // append tail guard, and the admission guard blocks consuming sends for
    // this whole window.
    if (isFullClear) {
      await clearPendingBranchSummary(workspaceId);
    }

    const deletedSequences = truncateResult.data;
    if (deletedSequences.length > 0) {
      const deleteMessage: DeleteMessage = {
        type: "delete",
        historySequences: deletedSequences,
      };
      // Emit through the session so ORPC subscriptions receive the event
      if (session) {
        session.emitChatEvent(deleteMessage);
      } else {
        // Fallback to direct emit (legacy path)
        this.emit("chat", { workspaceId, message: deleteMessage });
      }
    }

    // On full clear, also delete plan file and clear file change tracking
    if (isFullClear) {
      const metadata = await this.getInfo(workspaceId);
      if (metadata) {
        await this.deletePlanFilesForWorkspace(workspaceId, metadata);
      }
      // A full chat clear removes the context the goal loop was using; require
      // one user re-engagement before later continuation slices resume it.
      try {
        await this.workspaceGoalService?.requireUserAcknowledgment(workspaceId);
      } catch (error) {
        return Err(getErrorMessage(error));
      }
      this.sessions.get(workspaceId)?.clearFileState();
      // Same new-segment invariant as resetContext: pre-clear read/skill
      // carryover must not be injected after the transcript is gone, and the
      // discard must be durable before the clear reports success (a stale
      // persisted file would re-inject pre-clear context after a restart).
      try {
        await this.getOrCreateSession(workspaceId).clearPostCompactionState();
      } catch (error) {
        return Err(
          `History was cleared, but the persisted post-compaction carryover could not be ` +
            `durably discarded (${getErrorMessage(error)}). Pre-clear read/skill context may ` +
            `be re-injected after a restart; retry once the session storage is writable.`
        );
      }
      // The persistent RLM sandbox holds context DERIVED from the cleared
      // transcript (vars populated by code execution), and its latest durable
      // snapshot would restore it after a restart — later turns could read
      // data from the supposedly cleared context through the kernel. Same
      // durable invalidation + partial-failure posture as resetContext.
      try {
        await sandboxHostService.discardScope(
          workspaceId,
          path.join(this.config.sessionsDir, workspaceId)
        );
      } catch (error) {
        log.error(
          `Failed to durably invalidate sandbox state for ${workspaceId} after history clear; ` +
            `the sandbox kernel stays unavailable until invalidation succeeds`,
          error
        );
        return Err(
          `History was cleared, but the sandbox kernel state could not be durably invalidated ` +
            `(${getErrorMessage(error)}). The sandbox stays unavailable and cleared variables ` +
            `may reappear after a restart; retry once the session storage is writable.`
        );
      }
    }

    return Ok(undefined);
  }

  async resetContext(workspaceId: string): Promise<Result<"reset" | "noop">> {
    // Admission guard (r40): rejects duplicate mutations and new sends at the
    // door, blocks turn admission inside the session, and verifies idleness —
    // held across the refine drain/lock awaits below so a send admitted
    // mid-reset cannot snapshot the pre-reset transcript and stream across
    // the boundary.
    const guardResult = this.acquireContextMutationAdmissionGuard(workspaceId, "reset context");
    if (!guardResult.success) {
      return Err(guardResult.error);
    }
    const admissionGuard = guardResult.data;
    try {
      const session = this.sessions.get(workspaceId);

      if (this.hasPendingQueuedOrPreparingTurn(workspaceId)) {
        return Err(
          "Cannot reset context while queued user input is pending. Send or clear the queued message first."
        );
      }

      // A refine pass distills the PRE-reset transcript. Letting it stream on
      // and publish AFTER the boundary lands would make its proposal the
      // newest hashed row of the post-reset segment — approvable edits
      // derived from the very context this reset discards. Cancel and drain
      // it first (never rejects): a pass already in its write section
      // finishes before the boundary is appended, leaving its proposal
      // pre-boundary where the approval-hash scan refuses it.
      await this.refinePassCanceller?.cancelInFlightRefinePass(workspaceId);
      // The one-shot drain cannot exclude a pass admitted right after it, so
      // the rest of the reset runs under the SAME per-workspace lockfile the
      // refine staging/apply write sections hold. That forces an ordering: a
      // pass that wins the lock publishes BEFORE the boundary lands (its
      // proposal stays pre-boundary, refused by the approval-hash scan), and
      // a pass that loses rechecks the boundary/anchor identity after
      // release and fails closed. The drain stays BEFORE acquisition —
      // draining while holding the lock would deadlock against a pass
      // waiting for it.
      const refineLockResult = await this.acquireRefineSerializationLock(workspaceId, "reset");
      if (!refineLockResult.success) {
        return Err(refineLockResult.error);
      }
      await using _refineLock = refineLockResult.data;

      // Recheck under the guard + lock: the admission block refuses ordinary
      // turn starts during the awaits above, but in-turn compaction retries
      // bypass admission gating when they cross a transient idle gap.
      if (session?.hasActiveOrPendingTurnWork() || this.aiService.isStreaming(workspaceId)) {
        return Err(
          "Cannot reset context while a turn is active. Press Esc to stop the stream first."
        );
      }
      // r41: a retry scheduled before this reset would commit the pre-reset
      // partial past the boundary and replay the discarded context after the
      // guard releases — cancel it and drop the partial durably first.
      if (session) {
        const retryDiscard = await session.discardAutoRetryForContextMutation();
        if (!retryDiscard.success) {
          return Err(
            `Cannot reset context: pending retry state could not be discarded (${retryDiscard.error})`
          );
        }
      }
      const historyResult = await this.historyService.getHistoryFromLatestBoundary(workspaceId);
      if (!historyResult.success) {
        return Err(`Failed to read active context before reset: ${historyResult.error}`);
      }

      const activeContextMessages = sliceMessagesForProviderFromLatestContextBoundary(
        historyResult.data
      );
      if (!hasProviderEligibleMessages(activeContextMessages)) {
        // An earlier reset may have failed AFTER writing its boundary but
        // BEFORE its durable cleanup landed (the partial-failure Errs below).
        // A retry then reaches this branch — no provider-eligible rows after
        // the boundary — so pending cleanup must be re-attempted before the
        // no-op is reported, or the UI claims success while a restart can
        // still restore pre-reset carryover or kernel vars across the reset
        // boundary. Both steps are idempotent: the pending-state unlink
        // treats ENOENT as success and a discard tombstone re-publish is
        // harmless, so a genuinely clean no-op stays a no-op.
        try {
          await this.getOrCreateSession(workspaceId).clearPostCompactionState();
        } catch (error) {
          return Err(
            `Nothing to reset, but persisted post-compaction carryover from an earlier partial ` +
              `reset could not be durably discarded (${getErrorMessage(error)}). Pre-reset ` +
              `read/skill context may be re-injected after a restart; retry once the session ` +
              `storage is writable.`
          );
        }
        try {
          await sandboxHostService.discardScope(
            workspaceId,
            path.join(this.config.sessionsDir, workspaceId)
          );
        } catch (error) {
          return Err(
            `Nothing to reset, but the sandbox kernel state could not be durably invalidated ` +
              `(${getErrorMessage(error)}). The sandbox stays unavailable and cleared variables ` +
              `may reappear after a restart; retry once the session storage is writable.`
          );
        }
        return Ok("noop");
      }

      const boundaryMessage = createMuxMessage(
        createContextResetBoundaryMessageId(),
        "assistant",
        "",
        {
          timestamp: Date.now(),
          contextBoundaryKind: CONTEXT_BOUNDARY_KINDS.RESET,
        }
      );

      const appendResult = await this.historyService.appendToHistory(workspaceId, boundaryMessage);
      if (!appendResult.success) {
        return Err(`Failed to append context reset boundary: ${appendResult.error}`);
      }
      // r41: the boundary is durable — sends that entered before it must not
      // be admitted afterwards (their content references the discarded
      // context).
      this.advanceContextMutationEpoch(workspaceId);
      // r43: drop any settled-but-unconsumed branch-summary registration —
      // its row now sits behind the new boundary, and the next send would
      // otherwise re-emit that pre-reset summary into the live transcript.
      // Only AFTER the boundary append commits (r44): a reset failing before
      // the boundary lands keeps the row in the active context, and dropping
      // the registration first would leave that never-emitted row invisible
      // to the user until a reload while the provider still sees it. The
      // later cleanup steps may still Err, but the discard itself is durable
      // by this point, so the registration goes regardless.
      await clearPendingBranchSummary(workspaceId);

      session?.clearUsageState();

      const typedBoundaryMessage = { ...boundaryMessage, type: "message" as const };
      if (session) {
        session.emitChatEvent(typedBoundaryMessage);
      } else {
        this.emit("chat", { workspaceId, message: typedBoundaryMessage });
      }

      try {
        await this.workspaceGoalService?.requireUserAcknowledgment(workspaceId);
      } catch (error) {
        log.error("Failed to require goal acknowledgment after context reset:", error);
      }
      this.sessions.get(workspaceId)?.clearFileState();
      // A reset starts a NEW context segment: cumulative post-compaction
      // carryover (read-file paths, loaded skills, pending diff snapshot)
      // summarizes PRE-reset epochs and must not be injected into later
      // turns. getOrCreateSession so the persisted pending state is
      // discarded even when no session exists yet (e.g. reset right after
      // an app restart).
      try {
        await this.getOrCreateSession(workspaceId).applyContextResetSideEffects();
      } catch (error) {
        // The boundary is durable, but success must wait for both persisted
        // carryover and sandbox invalidation. Preserve the failing stage's diagnosis.
        log.error(`Failed to durably discard context state for ${workspaceId}`, error);
        return Err(
          `Context was reset, but ${getErrorMessage(error)} Retry once the session storage is writable.`
        );
      }

      return Ok("reset");
    } finally {
      admissionGuard[Symbol.dispose]();
    }
  }

  async replaceHistory(
    workspaceId: string,
    summaryMessage: MuxMessage,
    options?: {
      mode?: "destructive" | "append-compaction-boundary" | null;
      deletePlanFile?: boolean;
    }
  ): Promise<Result<void>> {
    // Support both new enum ("user"|"idle") and legacy boolean (true)
    const isCompaction = !!summaryMessage.metadata?.compacted;
    // Non-compaction replaces hold the admission guard (r40): the destructive
    // path awaits the refine drain/lock below, and a send admitted during
    // those awaits could snapshot the pre-replace transcript and stream
    // across the mutation. Compaction replaces preserve context and run
    // inside an active turn, so they stay unguarded.
    let admissionGuard: Disposable | null = null;
    if (!isCompaction) {
      const guardResult = this.acquireContextMutationAdmissionGuard(workspaceId, "replace history");
      if (!guardResult.success) {
        return Err(guardResult.error);
      }
      admissionGuard = guardResult.data;
    }
    using _admissionGuard = admissionGuard;

    const replaceMode = options?.mode ?? "destructive";

    try {
      let messageToAppend = summaryMessage;
      let deletedSequences: number[] = [];

      if (replaceMode === "append-compaction-boundary") {
        assert(
          summaryMessage.role === "assistant",
          "append-compaction-boundary replace mode requires an assistant summary message"
        );

        // Only need the current epoch's messages — the latest boundary marker holds
        // the max compaction epoch, and epochs are monotonically increasing with
        // append-only compaction. Falls back to full history for uncompacted workspaces.
        const historyResult = await this.historyService.getHistoryFromLatestBoundary(workspaceId);
        if (!historyResult.success) {
          return Err(
            `Failed to read history for append-compaction-boundary mode: ${historyResult.error}`
          );
        }

        const nextCompactionEpoch = getNextCompactionEpochForAppendBoundary(
          workspaceId,
          historyResult.data
        );
        assert(
          isPositiveInteger(nextCompactionEpoch),
          "append-compaction-boundary replace mode must compute a positive compaction epoch"
        );

        const compactedMarker = isDurableCompactedMarker(summaryMessage.metadata?.compacted)
          ? summaryMessage.metadata.compacted
          : "user";

        messageToAppend = {
          ...summaryMessage,
          metadata: {
            ...(summaryMessage.metadata ?? {}),
            compacted: compactedMarker,
            compactionBoundary: true,
            compactionEpoch: nextCompactionEpoch,
          },
        };

        assert(
          isDurableCompactedMarker(messageToAppend.metadata?.compacted),
          "append-compaction-boundary replace mode requires a durable compacted marker"
        );
        assert(
          messageToAppend.metadata?.compactionBoundary === true,
          "append-compaction-boundary replace mode must persist compactionBoundary=true"
        );
        assert(
          isPositiveInteger(messageToAppend.metadata?.compactionEpoch),
          "append-compaction-boundary replace mode must persist a positive compactionEpoch"
        );
      } else {
        assert(
          replaceMode === "destructive",
          `replaceHistory received unsupported replace mode: ${String(replaceMode)}`
        );

        // Same context-discard boundary as a full clear: drain + serialize
        // with refine so a mid-pass proposal cannot publish into the
        // replaced history (compaction replaces are exempt — they preserve
        // context and the compaction boundary flips the recheck identity).
        let refineLock: AsyncDisposable | null = null;
        if (!isCompaction) {
          await this.refinePassCanceller?.cancelInFlightRefinePass(workspaceId);
          const refineLockResult = await this.acquireRefineSerializationLock(
            workspaceId,
            "replace history"
          );
          if (!refineLockResult.success) {
            return Err(refineLockResult.error);
          }
          refineLock = refineLockResult.data;
        }
        await using _refineLock = refineLock;
        // Recheck under the guard + lock: the admission block refuses
        // ordinary turn starts during the awaits above, but in-turn
        // compaction retries bypass admission gating when they cross a
        // transient idle gap.
        if (
          !isCompaction &&
          (this.sessions.get(workspaceId)?.hasActiveOrPendingTurnWork() ||
            this.aiService.isStreaming(workspaceId))
        ) {
          return Err(
            "Cannot replace history while a turn is active. Press Esc to stop the stream first."
          );
        }
        // r41: same retry hygiene as full clear — a pending retry would
        // replay the replaced context after the guard releases.
        const replaceSession = this.sessions.get(workspaceId);
        if (!isCompaction && replaceSession) {
          const retryDiscard = await replaceSession.discardAutoRetryForContextMutation();
          if (!retryDiscard.success) {
            return Err(
              `Cannot replace history: pending retry state could not be discarded (${retryDiscard.error})`
            );
          }
        }
        // A destructive non-compaction replacement discards the conversation the kernel
        // workflow references belong to, exactly like a full clear: a verified-empty (null)
        // boundary snapshot reads the decision-free replacement history as current and would
        // inject a pre-replacement workflow result into it. Same ordering and failure posture
        // as truncateHistory: retire before the clear commits, abort when retirement fails.
        // Compaction replaces preserve conversation identity, so their references stay live.
        if (!isCompaction) {
          try {
            await this.retireKernelWorkflowRunReferences(workspaceId);
          } catch (error) {
            return Err(
              `Cannot replace history: stale workflow run references could not be retired ` +
                `(${getErrorMessage(error)}). Retry once the session storage is writable.`
            );
          }
        }
        this.sessions.get(workspaceId)?.clearUsageState();
        const clearResult = await this.clearHistoryWithRetiredBashMonitorWakes(
          workspaceId,
          () => this.historyService.clearHistory(workspaceId),
          { discardUnacceptedOnSuccess: true }
        );
        if (!clearResult.success) {
          return Err(`Failed to clear history: ${clearResult.error}`);
        }
        if (!isCompaction) {
          // r41: the destructive replacement is durable — refuse sends that
          // entered before it (see contextMutationEpochs).
          this.advanceContextMutationEpoch(workspaceId);
          // r43: same branch-summary hygiene as full clear, and same r44
          // ordering — drop the registration only after the clear commits
          // (see truncateHistory).
          await clearPendingBranchSummary(workspaceId);
          // A destructive non-compaction replace (e.g. "start here") begins a
          // new context segment: discard pre-boundary post-compaction
          // carryover like resetContext does, durable-or-fail for the same
          // reason (a stale persisted file re-injects after a restart).
          // Compaction summaries instead RELY on the pending post-compaction
          // state persisted for them.
          try {
            await this.getOrCreateSession(workspaceId).clearPostCompactionState();
          } catch (error) {
            return Err(
              `History was cleared, but the persisted post-compaction carryover could not be ` +
                `durably discarded (${getErrorMessage(error)}). Pre-boundary read/skill context ` +
                `may be re-injected after a restart; retry once the session storage is writable.`
            );
          }
          // Same boundary as the full-clear path above: a destructive
          // non-compaction replace discards the transcript, so kernel vars
          // derived from it must not stay readable (or restorable from the
          // durable snapshot) afterwards. Compaction replaces instead KEEP
          // sandbox state — surviving compaction is the kernel's purpose.
          try {
            await sandboxHostService.discardScope(
              workspaceId,
              path.join(this.config.sessionsDir, workspaceId)
            );
          } catch (error) {
            log.error(
              `Failed to durably invalidate sandbox state for ${workspaceId} after destructive ` +
                `history replace; the sandbox kernel stays unavailable until invalidation succeeds`,
              error
            );
            return Err(
              `History was replaced, but the sandbox kernel state could not be durably ` +
                `invalidated (${getErrorMessage(error)}). The sandbox stays unavailable and ` +
                `cleared variables may reappear after a restart; retry once the session storage ` +
                `is writable.`
            );
          }
        }
        this.timelineRecorder.record(workspaceId, {
          kind: "history.cleared",
          source: { system: "chat" },
          status: "completed",
        });
        deletedSequences = clearResult.data;
      }

      const appendResult = await this.historyService.appendToHistory(workspaceId, messageToAppend);
      if (!appendResult.success) {
        return Err(`Failed to append summary message: ${appendResult.error}`);
      }

      this.sessions.get(workspaceId)?.clearUsageState();

      // Emit through the session so ORPC subscriptions receive the events
      const session = this.sessions.get(workspaceId);
      if (deletedSequences.length > 0) {
        const deleteMessage: DeleteMessage = {
          type: "delete",
          historySequences: deletedSequences,
        };
        if (session) {
          session.emitChatEvent(deleteMessage);
        } else {
          this.emit("chat", { workspaceId, message: deleteMessage });
        }
      }

      // Add type: "message" for discriminated union (XumMessage doesn't have it)
      const typedSummaryMessage = { ...messageToAppend, type: "message" as const };
      if (session) {
        session.emitChatEvent(typedSummaryMessage);
      } else {
        this.emit("chat", { workspaceId, message: typedSummaryMessage });
      }

      // Optional cleanup: delete plan file when caller explicitly requests it.
      // Note: the propose_plan UI keeps the plan file on disk; this flag is reserved for
      // explicit reset flows and backwards compatibility.
      if (options?.deletePlanFile === true) {
        const metadata = await this.getInfo(workspaceId);
        if (metadata) {
          await this.deletePlanFilesForWorkspace(workspaceId, metadata);
        }
        this.sessions.get(workspaceId)?.clearFileState();
      }

      return Ok(undefined);
    } catch (error) {
      const message = getErrorMessage(error);
      return Err(`Failed to replace history: ${message}`);
    }
  }

  /**
   * Best-effort removal of a deregistered workspace's activity/status entry
   * from extensionMetadata.json. Used by remove() and by rollback paths that
   * deregister via config.removeWorkspace directly (e.g. TaskService's failed
   * task-create rollback, where a send that failed mid-create may already
   * have scheduled metadata writes that would recreate the entry after
   * deregistration). A missed delete is reclaimed by the one-time
   * pruneStaleExtensionMetadataOnce pass on a later process start.
   */
  async discardExtensionMetadataEntry(workspaceId: string): Promise<void> {
    try {
      // Deleting also write-tombstones the id for the rest of this process,
      // so verify deregistration actually landed before publishing it:
      // saveConfig swallows write failures, meaning config.removeWorkspace
      // can resolve while the workspace is still persisted in config.json —
      // tombstoning a still-live id would suppress all of its future
      // activity writes. A failed verification (unreadable config) skips the
      // delete too; like a missed delete, the entry is reclaimed by a later
      // process start's prune, which re-checks against config.
      //
      // Deliberately NOT getAllWorkspaceMetadata here: that walks every
      // configured workspace with per-workspace fs probes — an O(n)
      // traversal just to check one id. The raw persisted superset (which
      // throws on an unreadable config, also making findWorkspace's lenient
      // internal load safe below) covers entries normalization would drop,
      // and the targeted findWorkspace lookup covers normalized/legacy ids
      // (metadata.json / generated legacy ids) the raw scan cannot see.
      const knownIds = this.config.readPersistedWorkspaceIdSuperset();
      // throwOnError: a lenient findWorkspace swallows unreadable legacy
      // metadata.json files, and "identity unknowable" must fail closed here
      // (skip the delete) rather than read as "not registered".
      if (
        knownIds.has(workspaceId) ||
        this.config.findWorkspace(workspaceId, { throwOnError: true }) != null
      ) {
        log.debug("Skipping extension metadata discard: workspace still persisted in config", {
          workspaceId,
        });
        return;
      }
      await this.extensionMetadata.deleteWorkspace(workspaceId);
      // Removal-side counterpart of the tombstone-cleared eviction: drop the
      // process-local workflow/bash-monitor caches for the removed id so a
      // later re-registration never inherits activity bootstrapped from
      // session state that removal deleted.
      this.evictWorkspaceActivityCaches(workspaceId);
    } catch (error) {
      log.debug("Failed to prune extension metadata after workspace deregistration", {
        workspaceId,
        error: getErrorMessage(error),
      });
    }
  }

  /**
   * Strict authoritative enumeration for destructive/identity decisions:
   * every primary workspace id PLUS legacy alias identities (a second
   * resolvable compatibility file findWorkspace still vouches for — see
   * Config.getAllWorkspaceMetadata's legacyAliasIds). Known-id sets built
   * without the aliases would prune or drop live alias-keyed activity.
   */
  private async enumerateAuthoritativeWorkspaceIds(): Promise<Set<string>> {
    const legacyAliasIds = new Set<string>();
    const ids = new Set(
      (await this.config.getAllWorkspaceMetadata({ throwOnError: true, legacyAliasIds })).map(
        (metadata) => metadata.id
      )
    );
    for (const aliasId of legacyAliasIds) {
      ids.add(aliasId);
    }
    return ids;
  }

  /**
   * Evict process-local activity caches for a removed (or removed-then-
   * revived) workspace id. The caches re-bootstrap from disk on next access;
   * an in-flight bootstrap keeps populating its orphaned Set harmlessly.
   */
  private evictWorkspaceActivityCaches(workspaceId: string): void {
    this.activeWorkflowRunIdsByWorkspace.delete(workspaceId);
    this.activeWorkflowRunIdBootstrapsByWorkspace.delete(workspaceId);
    this.bashMonitorSeenWorkspaces.delete(workspaceId);
    this.workflowRunSeenWorkspaces.delete(workspaceId);
  }

  /**
   * One-time lazy cleanup for pre-existing deployments: drop
   * extensionMetadata.json entries whose workspace no longer exists in
   * config. remove() prunes going forward, but entries that leaked before
   * that hook existed (issue #3959) would otherwise bloat the file — and
   * every serialized rewrite of it — forever. Runs at most once per process
   * from the activity bootstrap path; never a per-read scan.
   */
  private prunedStaleExtensionMetadata = false;
  /**
   * Returns the config-known workspace ids captured during the prune so the
   * first activity bootstrap can reuse them for scoping —
   * getAllWorkspaceMetadata walks every workspace with per-workspace disk
   * probes, which large deployments should not pay twice in the
   * latency-sensitive bootstrap. `knownIds` is the FULL raw-plus-normalized
   * union the prune spared from deletion: scoping to anything narrower (the
   * normalized view alone) would drop raw-registered ids the normalized
   * view cannot see (e.g. a project pair shadowed by a duplicate path key),
   * and if the bootstrap's later raw refreshes then failed transiently, the
   * authoritative response would omit a live workspace whose id this READ
   * already loaded successfully — clearing its renderer state with no event
   * to correct it. `enumeratedIds` is what the strict enumeration itself
   * vouched for (see scopeEnumerationIds: only those ids may treat
   * enumeration absence as removal evidence). Null when the prune was
   * skipped or failed.
   */
  private async pruneStaleExtensionMetadataOnce(): Promise<{
    knownIds: Set<string>;
    enumeratedIds: ReadonlySet<string>;
  } | null> {
    if (this.prunedStaleExtensionMetadata) {
      return null;
    }
    // Latch before awaiting so concurrent bootstraps don't queue redundant
    // prunes; a failed attempt is retried on the next process start rather
    // than on every read.
    this.prunedStaleExtensionMetadata = true;
    try {
      let prunedScope: { knownIds: Set<string>; enumeratedIds: ReadonlySet<string> } | null = null;
      const prunedCount = await this.extensionMetadata.pruneMissingWorkspaces(
        async () => {
          // Invoked inside the file's serialized mutation AFTER the file load,
          // reading config fresh from disk (see pruneMissingWorkspaces), so a
          // concurrently created workspace — even in another backend process —
          // cannot lose its just-written entry.
          //
          // Union of two views, both of which throw (aborting the prune, caught
          // below) rather than resolving with a silently lossy id set:
          // - the raw persisted superset covers entries loadConfigOrDefault's
          //   validation/normalization would filter or discard (see
          //   readPersistedWorkspaceIdSuperset), so a live workspace with a
          //   malformed config entry is never treated as removed;
          // - the strict normalized view covers ids produced by in-memory
          //   config migrations that are not yet persisted verbatim.
          // A missing config file resolves as a healthy empty set in both.
          const knownIds = this.config.readPersistedWorkspaceIdSuperset();
          const enumeratedIds = await this.enumerateAuthoritativeWorkspaceIds();
          for (const workspaceId of enumeratedIds) {
            knownIds.add(workspaceId);
          }
          prunedScope = { knownIds, enumeratedIds };
          return knownIds;
        },
        async () => {
          // Mid-prune re-registration recheck. The first callback's strict
          // enumeration walks a session lookup per configured workspace;
          // rerunning it doubles that cost on exactly the stale-heavy
          // deployments this prune exists to fix, while the serialized
          // metadata queue blocks live recency/status writes. The raw id view
          // is complete registration evidence whenever every persisted
          // workspace entry carries its id inline — only id-less legacy
          // entries (whose stable id lives in session metadata.json) can be
          // registered raw-invisibly, so the enumeration is repeated only
          // when such entries exist. Both reads throw on failure, aborting
          // the prune rather than deleting on lossy evidence.
          const evidence = this.config.readPersistedWorkspaceIdEvidence();
          if (!evidence.hasWorkspaceEntriesWithoutIds) {
            return evidence.ids;
          }
          for (const workspaceId of await this.enumerateAuthoritativeWorkspaceIds()) {
            evidence.ids.add(workspaceId);
          }
          return evidence.ids;
        }
      );
      if (prunedCount > 0) {
        log.info(`Pruned ${prunedCount} stale extension metadata entries`);
      }
      return prunedScope;
    } catch (error) {
      log.debug("Failed to prune stale extension metadata entries", { error });
      return null;
    }
  }

  async getActivityList(): Promise<Record<string, WorkspaceActivitySnapshot> | null> {
    try {
      // On the first bootstrap the prune already enumerated the config; reuse
      // that id set instead of paying the per-workspace disk walk twice.
      // Baseline for the post-await cross-process removal revalidation at
      // the end of this method: captured before ANY await (including the
      // first-bootstrap prune, whose enumeration another backend's removal
      // could otherwise outdate before this baseline is read) so ids
      // deregistered from the shared config while this list computes can be
      // told apart from ids the raw scan can never see.
      let initialConfigIds: ReadonlySet<string> | null = null;
      try {
        initialConfigIds = this.config.readPersistedWorkspaceIdSuperset();
      } catch {
        initialConfigIds = null;
      }
      const prefetchedScope = await this.pruneStaleExtensionMetadataOnce();
      // throwOnError: the default load self-heals an unreadable/malformed
      // metadata file into an empty one, which this list would then present
      // as an authoritative "no activity anywhere" answer — the renderer
      // applies that by wiping every cached streaming/status/goal snapshot
      // with no retry (the subscription stays connected). Throwing to the
      // null-returning catch below instead keeps last-known renderer state
      // and lets the bootstrap retry read the real list later.
      const snapshots = await this.extensionMetadata.getAllSnapshots({ throwOnError: true });
      // Scope the list to config-known workspaces. extensionMetadata.json was
      // historically never pruned, so long-lived deployments accumulate stale
      // entries for removed workspaces/sub-agents by the thousands (issue
      // #3959: 13,901 entries / 2.89 MB / ~59 s per bootstrap while the
      // sidebar needed ~246). Stale ids must neither inflate the payload nor
      // trigger the per-id workflow-run bootstrap disk probe below. Known ids
      // WITHOUT a snapshot still flow through the tombstone logic below —
      // scoping only drops ids that are not in config at all.
      let workspaceIds: Set<string>;
      // Whether scoping ended up on the fail-open legacy union (config
      // unreadable): only that availability path may serve a response with
      // the cross-process removal guards disabled.
      let scopedFailOpen = false;
      // Ids the SCOPE's strict enumeration itself vouched for, captured
      // before raw-view additions: the authoritative-removal fallback below
      // may treat mid-list enumeration absence as removal evidence only for
      // these ids — raw-registered ids the normalized view cannot see
      // (invalid project path) are legitimately absent from every
      // enumeration and must not read that absence as removal.
      let scopeEnumerationIds: ReadonlySet<string> | null = null;
      if (prefetchedScope != null) {
        scopeEnumerationIds = prefetchedScope.enumeratedIds;
        // Scope to the FULL known-id union the prune spared (raw +
        // normalized), not the enumeration alone: a raw-registered id the
        // normalized view cannot see was already loaded successfully by the
        // prune's raw read, and relying solely on the refresh below to
        // re-admit it would let a transient refresh failure turn into an
        // authoritative response that omits the live workspace.
        workspaceIds = prefetchedScope.knownIds;
        // The prune enumerated config BEFORE the snapshot read above, so a
        // workspace registered in between would be missing here — and an
        // authoritative list omitting it would clear its live-arrived
        // renderer state with no retry. Admit every id a fresh raw config
        // view now knows, NOT just ids with a persisted snapshot: a
        // concurrently registered workspace with workflow- or bash-monitor-
        // only activity has no extensionMetadata entry, and its on-disk
        // workflow runs are only discovered by the per-id probe below.
        // (Cheap sync read; on failure the prefetched view stands and the
        // miss is a transient one.)
        try {
          const refreshedConfigIds = this.config.readPersistedWorkspaceIdSuperset();
          for (const workspaceId of refreshedConfigIds) {
            workspaceIds.add(workspaceId);
          }
        } catch (error) {
          log.debug("Failed to refresh config ids for first-bootstrap scoping", { error });
        }
      } else {
        try {
          // throwOnError so a corrupted config.json actually reaches the
          // fail-open fallback below instead of silently resolving as the
          // empty default and dropping every live entry from the list.
          workspaceIds = await this.enumerateAuthoritativeWorkspaceIds();
          scopeEnumerationIds = workspaceIds;
        } catch (error) {
          // Fail open: without the config view, stale ids cannot be told apart
          // from live ones, and dropping live entries would strand renderer
          // activity state. Fall back to the legacy unscoped union.
          log.debug("Failed to scope activity list to known workspaces", { error });
          scopedFailOpen = true;
          workspaceIds = new Set(snapshots.keys());
          for (const workspaceId of this.activeWorkflowRunIdsByWorkspace.keys()) {
            workspaceIds.add(workspaceId);
          }
          for (const workspaceId of this.bashMonitorSeenWorkspaces) {
            workspaceIds.add(workspaceId);
          }
          for (const workspaceId of this.workflowRunSeenWorkspaces) {
            workspaceIds.add(workspaceId);
          }
        }
      }

      // Re-establish the raw baseline when the pre-await read failed: with a
      // null baseline BOTH cross-process removal guards stay disabled while
      // the response is still authoritative — a workspace another backend
      // removes during the probes below would ride back into the renderer
      // with no event to correct it. This retry still precedes every per-id
      // probe await, so it remains a valid "registered at list start"
      // baseline; ids it cannot see flow through the authoritative-identity
      // path instead. If it fails again the config is genuinely unreadable
      // and the fail-open scoping above already chose availability.
      if (initialConfigIds == null) {
        try {
          initialConfigIds = this.config.readPersistedWorkspaceIdSuperset();
        } catch (error) {
          // Authoritative scope but NO raw baseline even on retry: both
          // cross-process removal guards would silently stay disabled on a
          // response the renderer applies as authoritative — a workspace
          // another backend deregisters during the probes below would ride
          // back with no event to correct it. Fail the list instead (null →
          // renderer keeps last-known state and retries). The fail-open
          // scope keeps its availability contract: config is unreadable
          // there by definition, and no baseline exists by design.
          if (!scopedFailOpen) {
            throw error;
          }
          initialConfigIds = null;
        }
      }
      const entries = await Promise.all(
        Array.from(
          workspaceIds,
          async (workspaceId): Promise<readonly [string, WorkspaceActivitySnapshot] | null> => {
            const snapshot = snapshots.get(workspaceId) ?? null;
            // Nonzero-observation signal, NOT cache presence: the probe below
            // installs an empty cache for every scoped id, which would turn
            // every idle config-known workspace into a fabricated recency:0
            // entry on the next list.
            const hadWorkflowActivity = this.workflowRunSeenWorkspaces.has(workspaceId);
            // Bash-monitor counterpart of the workflow tombstone: a monitor that stopped
            // while the renderer was disconnected (or whose stop emit failed) must still
            // surface a zero-count entry here, otherwise the renderer's last-known
            // "watching" state survives reconnect. The seen-set is used instead of the
            // dedupe map because dedupe entries are dropped around in-flight/failed emits.
            const hadBashMonitorActivityCache = this.bashMonitorSeenWorkspaces.has(workspaceId);
            const activeWorkflowRunIds = await this.getActiveWorkflowRunIds(workspaceId);
            const activeWorkflowRunCount = activeWorkflowRunIds.size;
            const activeBashMonitorCount = this.getActiveBashMonitorCount(workspaceId);
            if (activeBashMonitorCount > 0) {
              // A list-delivered non-zero count is a renderer-visible observation too:
              // remember it so the eventual stop always yields a tombstone entry.
              this.bashMonitorSeenWorkspaces.add(workspaceId);
            }
            // Keep a zero-count tombstone for workspaces whose workflow- or monitor-only
            // activity was cleared while a frontend activity subscription was disconnected.
            if (
              snapshot == null &&
              activeWorkflowRunCount === 0 &&
              !hadWorkflowActivity &&
              activeBashMonitorCount === 0 &&
              !hadBashMonitorActivityCache
            ) {
              return null;
            }
            return [
              workspaceId,
              // Overlay the optimistic mid-stream goal here too: the renderer
              // bootstraps via this list (the subscription does not replay
              // historical snapshots), and `getAllSnapshots()` returns the
              // still-pre-stream persisted goal. Without this, a reconnect/reload
              // during a mid-stream goal set would seed the UI with the stale
              // goal until the next live emit or goal read.
              mergeActiveCount(
                mergeActiveWorkflowRuns(
                  this.overlayPendingGoal(workspaceId, snapshot),
                  activeWorkflowRunIds
                ),
                "activeBashMonitorCount",
                activeBashMonitorCount
              ),
            ] as const;
          }
        )
      );
      // Cross-process counterparts of the in-process tombstone check below:
      // with XUM_ALLOW_MULTIPLE_INSTANCES another backend can remove a
      // workspace while this list computes, invisible to this process's
      // deletedWorkspaceIds. Re-read the (post-prune bounded) metadata file
      // and the raw persisted config id superset once. Best-effort: an
      // unreadable re-read skips its revalidation instead of failing an
      // otherwise complete response.
      let freshSnapshots: ReadonlyMap<string, WorkspaceActivitySnapshot> | null = null;
      try {
        freshSnapshots = await this.extensionMetadata.getAllSnapshots({ throwOnError: true });
      } catch {
        freshSnapshots = null;
      }
      const freshPersistedIds: ReadonlySet<string> | null =
        freshSnapshots != null ? new Set(freshSnapshots.keys()) : null;
      // Tombstones the registration evidence below may legitimately clear:
      // only ones that already exist HERE, before the evidence is captured
      // (the raw superset read is synchronous with this snapshot, and the
      // authoritative enumeration runs later still). A same-process removal
      // landing during the enumeration await publishes its tombstone after
      // the evidence reads began — stale evidence still showing the id
      // registered must not clear that fresh tombstone, or the pre-removal
      // snapshot rides back into the renderer and late producers persist the
      // entry again. Such a tombstone stays clearable by the NEXT list's
      // fresh evidence if the id really is re-registered.
      const clearableTombstoneIds = this.extensionMetadata.getTombstonedIds();
      let freshConfigIds: ReadonlySet<string> | null = null;
      // Whether the fresh raw view is COMPLETE registration evidence: id-less
      // legacy entries register raw-invisibly (their stable id lives in
      // session metadata.json), so their presence — or an unreadable raw
      // view — forces the authoritative enumeration below for admission and
      // removal decisions the raw comparison cannot make.
      let freshConfigHasRawInvisibleEntries = false;
      try {
        const evidence = this.config.readPersistedWorkspaceIdEvidence();
        freshConfigIds = evidence.ids;
        freshConfigHasRawInvisibleEntries = evidence.hasWorkspaceEntriesWithoutIds;
      } catch {
        freshConfigIds = null;
        freshConfigHasRawInvisibleEntries = true;
      }
      // Like-for-like raw-superset comparison only: an id that WAS persisted
      // in config before the awaits and is gone from the fresh raw view was
      // verifiably deregistered. Ids the raw scan cannot see (legacy entries
      // whose stable id lives in a session metadata.json, in-memory migration
      // ids) never appear in either view — dropping them on a cheap fresh
      // view would misclassify identity-lookup gaps as removals, so they are
      // revalidated through the authoritative identity path below instead.
      // Skipped when either superset read fails.
      const isRemovedFromConfig = (workspaceId: string): boolean =>
        initialConfigIds != null &&
        freshConfigIds != null &&
        initialConfigIds.has(workspaceId) &&
        !freshConfigIds.has(workspaceId);
      // Raw-invisible ids (legacy stable ids resolved from session
      // metadata.json during enumeration) need their own removal
      // revalidation: the raw baseline can never contain them, so the
      // comparison above is blind to their cross-process removal — a
      // snapshotless (workflow/bash-monitor-only) legacy entry removed
      // mid-list would otherwise ride the delayed authoritative response
      // back into the renderer. Revalidate against ONE fresh authoritative
      // enumeration (per-id findWorkspace lookups would re-read and scan the
      // whole config per entry — O(n²) on legacy-heavy first bootstraps,
      // recreating the very stall this scoping removes): a verified "not
      // registered" drops the entry, while an unknowable identity anywhere
      // (unreadable/id-less metadata.json throws in strict mode) skips the
      // recheck and conservatively retains every raw-invisible id. Computed
      // only when a retained entry is actually missing from the raw
      // baseline (or a raw-invisible late snapshot needs admission below),
      // so modern deployments (every workspace id persisted in config)
      // never pay the extra walk.
      // Second trigger: a fresh-snapshot id outside the per-id scope that
      // the raw view cannot vouch for. It is either a raw-invisible legacy
      // id a downgraded backend registered mid-list — which the merge below
      // must ADMIT, and only the authoritative enumeration can prove
      // registered — or noise the merge must keep excluding; either way the
      // enumeration is the only view that can tell.
      const hasRawInvisibleLateSnapshotId =
        freshSnapshots != null &&
        Array.from(freshSnapshots.keys()).some(
          (workspaceId) =>
            !workspaceIds.has(workspaceId) && !(freshConfigIds?.has(workspaceId) ?? false)
        );
      let authoritativeIds: ReadonlySet<string> | null = null;
      if (
        initialConfigIds != null &&
        (entries.some((entry) => entry != null && !initialConfigIds.has(entry[0])) ||
          hasRawInvisibleLateSnapshotId ||
          // Third trigger: id-less legacy entries exist, so a downgraded
          // backend may have registered a raw-invisible workspace with
          // workflow-only activity (no snapshot) mid-list — only the
          // enumeration can discover it for the merge admission below.
          // Modern deployments (every id inline) never pay this walk.
          freshConfigHasRawInvisibleEntries)
      ) {
        try {
          authoritativeIds = await this.enumerateAuthoritativeWorkspaceIds();
        } catch (error) {
          log.debug("Failed to enumerate authoritative ids for removal revalidation", { error });
          authoritativeIds = null;
        }
        // The enumeration awaited disk: refresh the raw view so the
        // like-for-like removal comparison below never compares two
        // pre-removal reads. An inline-id workspace removed by another
        // backend DURING the enumeration is invisible to the pre-await
        // freshConfigIds (and deliberately exempt from the authoritative
        // check, which skips ids present in the initial baseline), so its
        // stale entry would otherwise pass the retained-entry filter with no
        // cross-process event to correct it. Fresher raw evidence is
        // strictly better for every downstream consumer; the tombstone-clear
        // eligibility snapshot was captured before ALL evidence reads, so
        // ordering stays sound.
        try {
          const refreshedEvidence = this.config.readPersistedWorkspaceIdEvidence();
          freshConfigIds = refreshedEvidence.ids;
          freshConfigHasRawInvisibleEntries = refreshedEvidence.hasWorkspaceEntriesWithoutIds;
        } catch {
          freshConfigIds = null;
          freshConfigHasRawInvisibleEntries = true;
        }
        if (freshConfigHasRawInvisibleEntries) {
          // The refresh postdates the enumeration and reveals id-less
          // entries, so the enumeration's DENIALS may already be stale: an
          // id removed before the enumeration can have been re-registered
          // id-less (with fresh cross-process activity) in the gap, and
          // trusting the stale denial would drop the revived workspace and
          // tombstone it. Re-enumerate ONCE so the enumeration-backed
          // removal arms use the freshest capable view; a revival landing
          // after this last read is the contract's out-of-scope window
          // (the next list's evidence clears any republished tombstone).
          // The raw view deliberately stays at its pre-re-enumeration
          // read: staleness there errs toward retention (an id present in
          // the older view is kept), never toward a wrong drop. On failure
          // fall back to retention, not the stale denial set.
          try {
            authoritativeIds = await this.enumerateAuthoritativeWorkspaceIds();
          } catch (error) {
            log.debug("Failed to re-enumerate authoritative ids after raw refresh", { error });
            authoritativeIds = null;
          }
        }
      }
      const isRemovedPerAuthoritativeIdentity = (workspaceId: string): boolean =>
        (initialConfigIds != null &&
          !initialConfigIds.has(workspaceId) &&
          // An id visible in the FRESH raw view is verifiably registered
          // regardless of what the (possibly earlier) authoritative
          // enumeration saw — e.g. a workspace registered after that
          // enumeration ran must not read as removed.
          !(freshConfigIds?.has(workspaceId) ?? false) &&
          authoritativeIds != null &&
          !authoritativeIds.has(workspaceId)) ||
        // Raw view unavailable (initial evidence read or post-enumeration
        // refresh failed): the mid-list authoritative enumeration is the
        // only usable post-removal view — without this arm an inline-id
        // workspace removed during that enumeration would ride the
        // authoritative response with every raw guard disabled and no
        // cross-process event to repair the renderer. Confined to ids the
        // scope enumeration itself vouched for (see scopeEnumerationIds).
        (freshConfigIds == null &&
          authoritativeIds != null &&
          (scopeEnumerationIds?.has(workspaceId) ?? false) &&
          !authoritativeIds.has(workspaceId));
      // Raw-visible→raw-invisible is verifiable removal only while the
      // fresh raw view is COMPLETE registration evidence. With id-less
      // legacy entries present, the id may have been removed and
      // RE-REGISTERED by a downgraded backend as an id-less entry during
      // the awaits (raw-invisible from then on) — the raw comparison alone
      // would drop the revived workspace and republish the very tombstone
      // the authoritative evidence just cleared, suppressing its activity
      // again. In that case the authoritative enumeration (which resolves
      // id-less identities, and is attempted whenever id-less entries
      // exist — see the third trigger above) must DENY the id before the
      // transition counts as removal; an affirmation or a failed
      // enumeration retains the entry (keeping a stale entry briefly is
      // recoverable, wrongly suppressing a live workspace is not). The
      // enumeration consulted here postdates the raw refresh whenever that
      // refresh reports id-less entries (see the re-enumeration above), so
      // a stale pre-refresh denial can never veto a revived id; a revival
      // landing after that last enumeration is the contract's out-of-scope
      // window — the next list's initial baseline no longer contains the
      // id, so the raw arm cannot re-fire and its fresh evidence clears
      // the republished tombstone.
      const isVerifiablyRemovedFromRawConfig = (workspaceId: string): boolean =>
        isRemovedFromConfig(workspaceId) &&
        (!freshConfigHasRawInvisibleEntries ||
          (authoritativeIds != null && !authoritativeIds.has(workspaceId)));
      // Tombstones are process-local removal knowledge; the shared config is
      // the authority. A downgraded concurrent backend can legitimately
      // re-register a deterministic legacy id this process pruned earlier —
      // observing the id in a FRESH config-derived view (raw superset or the
      // strict authoritative enumeration above; never snapshot/cache keys,
      // which do not prove registration) makes the tombstone stale, so its
      // write suppression and list filtering must end. Cleared before the
      // revalidation filter below so a re-registered id's entry survives.
      if (freshConfigIds != null || authoritativeIds != null) {
        const registeredIds = new Set<string>();
        for (const workspaceId of freshConfigIds ?? []) {
          registeredIds.add(workspaceId);
        }
        for (const workspaceId of authoritativeIds ?? []) {
          registeredIds.add(workspaceId);
        }
        this.extensionMetadata.clearTombstonesForRegisteredIds(
          registeredIds,
          clearableTombstoneIds
        );
      }
      const activityById = Object.fromEntries(
        entries.filter((entry): entry is readonly [string, WorkspaceActivitySnapshot] => {
          if (entry == null) {
            return false;
          }
          const workspaceId = entry[0];
          // Revalidate after the per-workspace awaits above: a workspace
          // removed while this list was computing would otherwise ride the
          // delayed response past emitWorkspaceActivity's tombstone
          // suppression — a renderer that already processed the removal
          // event would re-insert the deleted id until the next reconnect.
          if (this.extensionMetadata.isWorkspaceDeleted(workspaceId)) {
            return false;
          }
          const foreignRemoved =
            // Persisted snapshot vanished from the shared file mid-list.
            // Metadata keys normally only disappear through removal, but
            // NOT always: a deterministically corrupt file self-heals into
            // a valid (possibly EMPTY) one on the strict re-read, so a
            // mid-list quarantine makes every earlier key vanish while the
            // workspaces stay registered. Disappearance therefore counts as
            // removal evidence only when a fresh config-derived view
            // CAPABLE of seeing the id corroborates the deregistration:
            // raw-visible ids need the fresh raw view to deny them,
            // raw-invisible (legacy) ids the authoritative enumeration.
            // With neither view available the entry is retained — keeping a
            // stale entry briefly is recoverable, wiping live renderer
            // state on a corruption reset is not. Entries that never had a
            // persisted snapshot are covered by the config check.
            (freshPersistedIds != null &&
              snapshots.has(workspaceId) &&
              !freshPersistedIds.has(workspaceId) &&
              !(authoritativeIds?.has(workspaceId) ?? false) &&
              ((initialConfigIds?.has(workspaceId) ?? false) ||
              (freshConfigIds?.has(workspaceId) ?? false)
                ? freshConfigIds != null && !freshConfigIds.has(workspaceId)
                : authoritativeIds != null)) ||
            // Deregistered from the shared config mid-list — also covers
            // workflow/bash-monitor-only entries with no persisted snapshot.
            isVerifiablyRemovedFromRawConfig(workspaceId) ||
            // Raw-invisible (legacy stable) ids: authoritative-lookup
            // counterpart of the raw-superset comparison above.
            isRemovedPerAuthoritativeIdentity(workspaceId);
          if (foreignRemoved) {
            // A cross-process removal publishes no local tombstone, so the
            // tombstone-cleared eviction listener never fires for it. Stale
            // workflow-run/monitor caches would then survive the removal —
            // and if a downgraded backend re-registers the same
            // deterministic legacy id later, getActiveWorkflowRunIds would
            // serve the REMOVED incarnation's cached runs as ghost activity
            // instead of probing the recreated session.
            this.evictWorkspaceActivityCaches(workspaceId);
            // Eviction alone cannot stop a LATE local producer (workflow-run
            // or bash-monitor completion) from repopulating the caches and
            // re-emitting the removed incarnation's activity right after
            // this authoritative response dropped it — publish a local
            // tombstone so emits and writes stay suppressed until fresh
            // config evidence proves a revival.
            this.extensionMetadata.suppressForeignRemoval(workspaceId);
            return false;
          }
          return true;
        })
      );
      // Addition-side counterpart of the fresh re-read: another backend can
      // register a workspace AND persist its first activity after this
      // process's initial snapshot read. The refreshed config admits the id
      // into scope, but its per-id computation saw a null snapshot (and no
      // local workflow/monitor caches, which are process-local), so the
      // entry was omitted — and the activity subscription cannot heal that
      // (it is backed by this process's EventEmitter, so cross-process
      // writes produce no delta). Merge in-scope additions from the fresh
      // re-read, subject to the same removal guards as retained entries.
      // NOT gated on the snapshot re-read succeeding: config-proven late ids
      // (workflow-only registrations) must be probed even when the metadata
      // re-read transiently failed — the method still returns an
      // authoritative (non-null) response in that case, and the
      // process-local subscription can never supply the foreign workflow
      // event, so skipping the probe would hide that activity until
      // reconnect. Snapshot-derived candidates and snapshot guards simply
      // degrade to the views that ARE available.
      {
        // Merge scope: the (possibly stale) per-id scope PLUS fresh-snapshot
        // ids a fresh config-derived view proves registered — a workspace
        // registered and written between the scope reads and the fresh
        // re-read is in both fresh views but in neither stale one. Raw-
        // invisible ids (legacy stable ids resolved from session
        // metadata.json) can never appear in the raw view, so they are
        // admitted through the authoritative enumeration instead — without
        // that, a legacy workspace registered by a downgraded backend
        // mid-list would stay absent until reconnect (the process-local
        // subscription cannot deliver the cross-process snapshot).
        const mergeCandidateIds = new Set(workspaceIds);
        for (const workspaceId of freshSnapshots?.keys() ?? []) {
          if (
            (freshConfigIds?.has(workspaceId) ?? false) ||
            (authoritativeIds?.has(workspaceId) ?? false)
          ) {
            mergeCandidateIds.add(workspaceId);
          }
        }
        // Workflow-only late registrations: a workspace registered after the
        // scope reads can have active workflow runs but no metadata snapshot
        // at all, so admission cannot come from fresh-snapshot keys alone —
        // every fresh config-derived id outside the stale per-id scope is a
        // candidate. The authoritative enumeration contributes the ids the
        // raw view can never carry (id-less legacy registrations by a
        // downgraded backend). Ids with neither a snapshot nor live activity
        // cost one workflow probe and are dropped by the emptiness check
        // below.
        for (const lateIdSource of [freshConfigIds, authoritativeIds]) {
          for (const workspaceId of lateIdSource ?? []) {
            if (!workspaceIds.has(workspaceId)) {
              mergeCandidateIds.add(workspaceId);
            }
          }
        }
        // Workflow-run bootstrap for candidates the per-id loop never saw:
        // their on-disk active runs are not in the process-local cache, and
        // a cached-only merge would omit activeWorkflowRunCount for exactly
        // the cross-process registrations this merge exists to bootstrap.
        // Probed BEFORE the final guard views below so no await separates
        // guard evaluation from insertion (ids the per-id loop already
        // probed resolve synchronously from the shared cached Set).
        const probedWorkflowRunIds = new Map<string, ReadonlySet<string>>();
        for (const workspaceId of mergeCandidateIds) {
          if (
            workspaceId in activityById ||
            // In-scope ids without a late snapshot were fully decided by the
            // per-id loop (probe + zero-tombstone logic); re-probing them
            // would only trigger the final re-reads below on every list.
            (workspaceIds.has(workspaceId) && !(freshSnapshots?.has(workspaceId) ?? false))
          ) {
            continue;
          }
          probedWorkflowRunIds.set(workspaceId, await this.getActiveWorkflowRunIds(workspaceId));
        }
        const isRawInvisible = (workspaceId: string): boolean =>
          !(initialConfigIds?.has(workspaceId) ?? false) &&
          !(freshConfigIds?.has(workspaceId) ?? false);
        // The final revalidation must ALSO run when a retained entry is
        // raw-invisible even with zero late candidates: the mid-list
        // authoritative enumeration can observe a legacy stable id right
        // before another backend deregisters it and deletes its metadata
        // later in the same await. Every view the retained filter used
        // (pre-enumeration freshSnapshots, raw scans blind to stable ids,
        // the stale enumeration itself) then still shows the workspace, and
        // with no candidates to probe nothing else would re-read — the
        // deleted workspace would ride every authoritative response
        // indefinitely because cross-process removals emit no local event.
        // Modern deployments (all ids raw-visible) never pay this path.
        if (probedWorkflowRunIds.size > 0 || Object.keys(activityById).some(isRawInvisible)) {
          // Final post-probe views: the probes awaited disk, so a removal
          // landing during them is invisible to every view captured above —
          // inserting on those alone would ride the deleted id back into the
          // renderer. Re-read the (post-prune bounded) metadata file and the
          // raw config superset once more, then evaluate every guard with no
          // awaits before insertion. A removed workspace's metadata key is
          // deleted on removal, so the snapshot re-read also covers legacy
          // ids the raw view cannot see; same-process removals are covered
          // by the tombstone check. Best-effort like the other fresh
          // re-reads: an unreadable view falls back to the pre-probe one.
          let finalSnapshots: ReadonlyMap<string, WorkspaceActivitySnapshot> | null = null;
          try {
            finalSnapshots = await this.extensionMetadata.getAllSnapshots({ throwOnError: true });
          } catch {
            finalSnapshots = null;
          }
          // Post-probe authoritative recheck, only when a probed candidate is
          // raw-invisible (in no raw view): the raw deregistration guard
          // below is blind to a legacy workspace removed during the probes,
          // and in the normal gap between config deregistration and metadata
          // cleanup its snapshot still exists — the pre-probe authoritative
          // set is the view that ADMITTED it, so only a fresh enumeration
          // can prove the removal. Modern deployments never pay this walk.
          let finalAuthoritativeIds: ReadonlySet<string> | null = null;
          let finalConfigIds: ReadonlySet<string> | null = null;
          // Completeness of the final raw view, mirroring the mid-list
          // fresh read: id-less legacy entries make raw denial insufficient
          // removal evidence (see isVerifiablyRemovedFromRawConfig).
          let finalConfigHasRawInvisibleEntries = false;
          try {
            const finalEvidence = this.config.readPersistedWorkspaceIdEvidence();
            finalConfigIds = finalEvidence.ids;
            finalConfigHasRawInvisibleEntries = finalEvidence.hasWorkspaceEntriesWithoutIds;
          } catch {
            finalConfigIds = null;
            finalConfigHasRawInvisibleEntries = true;
          }
          if (
            Array.from(probedWorkflowRunIds.keys()).some(isRawInvisible) ||
            // Retained entries are re-filtered with the final views below
            // (they were admitted before the probes awaited), and a
            // raw-invisible retained id's removal is provable only through
            // the same fresh enumeration.
            Object.keys(activityById).some(isRawInvisible) ||
            // A transiently unreadable post-probe raw view would otherwise
            // disable the raw deregistration guards below entirely: an
            // inline-id workspace deregistered during the probes (its
            // metadata key not yet cleaned up) would ride the response with
            // no cross-process event to repair it. The enumeration
            // substitutes as removal evidence for ids the scope enumeration
            // vouched for.
            finalConfigIds == null ||
            // Id-less legacy entries in the final raw view: a raw-visible
            // id deregistered during the probes is indistinguishable from
            // one removed-and-revived as an id-less entry by a downgraded
            // backend, so the raw deregistration guards below need the
            // enumeration to tell them apart (same rule as the mid-list
            // isVerifiablyRemovedFromRawConfig). Modern deployments (every
            // id inline) never pay this walk.
            finalConfigHasRawInvisibleEntries
          ) {
            try {
              finalAuthoritativeIds = await this.enumerateAuthoritativeWorkspaceIds();
            } catch (error) {
              log.debug("Failed to re-enumerate authoritative ids after workflow probes", {
                error,
              });
              finalAuthoritativeIds = null;
            }
            // The enumeration is itself an await: a raw-invisible legacy
            // workspace can be admitted by it and then removed (metadata
            // key deleted) before it finishes — invisible to the snapshot
            // view captured before it and to every raw view. Re-read the
            // snapshot evidence after the enumeration so the vanish guard
            // sees the removal; on failure keep the pre-enumeration view
            // (still a post-probe view).
            try {
              finalSnapshots = await this.extensionMetadata.getAllSnapshots({
                throwOnError: true,
              });
            } catch {
              // Keep the pre-enumeration re-read (possibly null).
            }
            // Re-read the raw view after the awaits above so the raw
            // deregistration guards see the freshest possible view; on a
            // repeat failure keep the earlier successful read (still a
            // valid post-probe view) rather than degrading to null.
            try {
              const refreshedFinalEvidence = this.config.readPersistedWorkspaceIdEvidence();
              finalConfigIds = refreshedFinalEvidence.ids;
              finalConfigHasRawInvisibleEntries =
                refreshedFinalEvidence.hasWorkspaceEntriesWithoutIds;
            } catch {
              // Keep the pre-enumeration read (possibly null).
            }
            if (finalConfigHasRawInvisibleEntries) {
              // Same staleness rule as the mid-list re-enumeration: the
              // refresh revealed id-less entries, so the enumeration's
              // denials may predate an id-less re-registration — the
              // enumeration-backed drops below must use the freshest
              // capable view (a revival after this last read is the
              // contract's out-of-scope window). The raw and snapshot
              // views deliberately stay at their earlier reads: their
              // staleness errs toward retention, never a wrong drop. On
              // failure retain rather than trust the stale denial set.
              try {
                finalAuthoritativeIds = await this.enumerateAuthoritativeWorkspaceIds();
              } catch (error) {
                log.debug("Failed to re-enumerate authoritative ids after final raw refresh", {
                  error,
                });
                finalAuthoritativeIds = null;
              }
            }
          }
          // The retained-entry filter above ran BEFORE the workflow probes,
          // so a removal landing during those awaits is invisible to every
          // view it used — the removed workspace would ride the response
          // back into the renderer with no cross-process event to correct
          // it. Re-apply the removal guards to retained entries with the
          // post-probe views (final filtering must follow the last await).
          // Removal guards only: zero-count tombstone entries legitimately
          // have no snapshot and no live counts, so the probed candidates'
          // emptiness check must not run here.
          for (const workspaceId of Object.keys(activityById)) {
            const foreignRemoved =
              // Persisted snapshot vanished during the probes — also covers
              // legacy ids the raw views cannot see. Corroborated like the
              // mid-list filter's vanish arm: a strict re-read self-heals
              // deterministic corruption into a valid (possibly EMPTY)
              // file, so disappearance alone is not removal evidence — a
              // post-probe config-derived view capable of seeing the id
              // must also deny it.
              (finalSnapshots != null &&
                (snapshots.has(workspaceId) || (freshSnapshots?.has(workspaceId) ?? false)) &&
                !finalSnapshots.has(workspaceId) &&
                !(finalConfigIds?.has(workspaceId) ?? false) &&
                !(finalAuthoritativeIds?.has(workspaceId) ?? false) &&
                (isRawInvisible(workspaceId)
                  ? finalAuthoritativeIds != null
                  : finalConfigIds != null)) ||
              // Verifiably deregistered from the raw config during the
              // probes: visible in an earlier raw view, gone from the
              // post-probe one. With id-less entries in the final raw view
              // the id may instead have been removed-and-revived id-less,
              // so the final enumeration must deny it (same completeness
              // rule as isVerifiablyRemovedFromRawConfig).
              (finalConfigIds != null &&
                !finalConfigIds.has(workspaceId) &&
                ((initialConfigIds?.has(workspaceId) ?? false) ||
                  (freshConfigIds?.has(workspaceId) ?? false)) &&
                (!finalConfigHasRawInvisibleEntries ||
                  (finalAuthoritativeIds != null && !finalAuthoritativeIds.has(workspaceId)))) ||
              // Raw-invisible retained ids: post-probe authoritative
              // counterpart of the raw guard above.
              (isRawInvisible(workspaceId) &&
                !(finalConfigIds?.has(workspaceId) ?? false) &&
                finalAuthoritativeIds != null &&
                !finalAuthoritativeIds.has(workspaceId)) ||
              // Raw view unreadable post-probe: the fallback enumeration
              // substitutes as removal evidence, but only for ids the scope
              // enumeration itself vouched for — raw-only ids are
              // enumeration-invisible by design and stay retained on
              // transient read failures.
              (finalConfigIds == null &&
                finalAuthoritativeIds != null &&
                (scopeEnumerationIds?.has(workspaceId) ?? false) &&
                !finalAuthoritativeIds.has(workspaceId));
            if (foreignRemoved) {
              // Cross-process removals publish no local tombstone, so the
              // tombstone-cleared eviction listener never fires — see the
              // mid-list filter above (including the late-producer
              // suppression rationale).
              this.evictWorkspaceActivityCaches(workspaceId);
              this.extensionMetadata.suppressForeignRemoval(workspaceId);
              delete activityById[workspaceId];
            } else if (this.extensionMetadata.isWorkspaceDeleted(workspaceId)) {
              delete activityById[workspaceId];
            }
          }
          for (const [workspaceId, activeWorkflowRunIds] of probedWorkflowRunIds) {
            // Freshest available view, degrading to the INITIAL read: a raw-
            // registered id outside the normalized scope (e.g. invalid
            // project path) is admitted here, and when both re-reads failed
            // transiently its already-loaded initial snapshot must still
            // supply goal/status/recency — omitting it from an authoritative
            // response would clear that renderer state with no repair event.
            const lateSnapshot =
              finalSnapshots != null
                ? (finalSnapshots.get(workspaceId) ?? null)
                : freshSnapshots != null
                  ? (freshSnapshots.get(workspaceId) ?? null)
                  : (snapshots.get(workspaceId) ?? null);
            const lateForeignRemoved =
              isVerifiablyRemovedFromRawConfig(workspaceId) ||
              isRemovedPerAuthoritativeIdentity(workspaceId) ||
              // Persisted snapshot vanished during the probes — also covers
              // legacy ids the raw views cannot see. Same corruption-reset
              // corroboration as the retained-entry vanish arms: a
              // self-healed (possibly empty) re-read is not removal
              // evidence on its own.
              (finalSnapshots != null &&
                (freshSnapshots?.has(workspaceId) ?? false) &&
                !finalSnapshots.has(workspaceId) &&
                !(finalConfigIds?.has(workspaceId) ?? false) &&
                !(finalAuthoritativeIds?.has(workspaceId) ?? false) &&
                (isRawInvisible(workspaceId)
                  ? finalAuthoritativeIds != null
                  : finalConfigIds != null)) ||
              // Verifiably deregistered from the raw config during the
              // probes: the id was visible in an EARLIER raw view — the
              // initial baseline or the fresh re-read that admitted it (a
              // late registration is absent from the initial baseline by
              // definition) — and is gone from the post-probe view. During
              // the normal gap between config deregistration and metadata
              // cleanup the snapshot still exists, so the vanish check
              // above cannot catch this. Same raw-view completeness rule as
              // the retained-entry arm: with id-less entries present the
              // final enumeration must deny a possibly-revived id.
              (finalConfigIds != null &&
                !finalConfigIds.has(workspaceId) &&
                ((initialConfigIds?.has(workspaceId) ?? false) ||
                  (freshConfigIds?.has(workspaceId) ?? false)) &&
                (!finalConfigHasRawInvisibleEntries ||
                  (finalAuthoritativeIds != null && !finalAuthoritativeIds.has(workspaceId)))) ||
              // Raw-invisible candidates: post-probe authoritative
              // counterpart of the raw guard above — a legacy workspace
              // deregistered during the probes is invisible to every raw
              // view, and its snapshot may outlive the deregistration.
              (!(initialConfigIds?.has(workspaceId) ?? false) &&
                !(freshConfigIds?.has(workspaceId) ?? false) &&
                !(finalConfigIds?.has(workspaceId) ?? false) &&
                finalAuthoritativeIds != null &&
                !finalAuthoritativeIds.has(workspaceId)) ||
              // Raw view unreadable post-probe: same enumeration fallback
              // as the retained-entry filter, scoped to ids the scope
              // enumeration vouched for (raw-only ids stay admitted on
              // transient read failures — see lateSnapshot above).
              (finalConfigIds == null &&
                finalAuthoritativeIds != null &&
                (scopeEnumerationIds?.has(workspaceId) ?? false) &&
                !finalAuthoritativeIds.has(workspaceId));
            if (lateForeignRemoved) {
              // Same cross-process eviction + late-producer suppression
              // rationale as the mid-list filter: no local tombstone means
              // no listener-driven eviction, and the probes above may have
              // installed caches for the removed incarnation.
              this.evictWorkspaceActivityCaches(workspaceId);
              this.extensionMetadata.suppressForeignRemoval(workspaceId);
              continue;
            }
            if (
              // Nothing to contribute: no persisted snapshot and no live
              // counts (a workflow-only candidate legitimately has no
              // snapshot, so its absence alone is not removal evidence) —
              // never removal proof, so no cache eviction.
              (lateSnapshot == null &&
                activeWorkflowRunIds.size === 0 &&
                this.getActiveBashMonitorCount(workspaceId) === 0) ||
              this.extensionMetadata.isWorkspaceDeleted(workspaceId)
            ) {
              continue;
            }
            // Same overlay path emitWorkspaceActivity uses.
            const merged = this.mergeCurrentActiveBashMonitorCount(
              workspaceId,
              mergeActiveWorkflowRuns(
                this.overlayPendingGoal(workspaceId, lateSnapshot),
                activeWorkflowRunIds
              )
            );
            if (merged != null) {
              activityById[workspaceId] = merged;
            }
          }
        }
      }
      return activityById;
    } catch (error) {
      log.error("Failed to list activity:", error);
      // null (not {}) so the renderer can tell a read failure from a legitimately
      // idle deployment — with scoping, {} is a valid authoritative answer (no
      // known workspace has activity) that the renderer must apply to clear
      // stale entries after a disconnected removal. On null the renderer keeps
      // last-known state and retries in the background.
      return null;
    }
  }
  async getChatHistory(workspaceId: string): Promise<MuxMessage[]> {
    try {
      // Only return messages from the latest compaction boundary onward.
      // Pre-boundary messages are summarized in the boundary marker.
      // TODO: allow users to opt in to viewing full pre-boundary history.
      const history = await this.historyService.getHistoryFromLatestBoundary(workspaceId);
      return history.success ? history.data : [];
    } catch (error) {
      log.error("Failed to get chat history:", error);
      return [];
    }
  }

  /** Full history is required because compaction removes older prompts from replay. */
  async getLastUserPrompt(
    workspaceId: string
  ): Promise<{ text: string; messageId: string } | null> {
    assert(
      typeof workspaceId === "string" && workspaceId.trim().length > 0,
      "workspaceId is required"
    );

    let found: { text: string; messageId: string } | null = null;
    const result = await this.historyService.iterateFullHistory(
      workspaceId,
      "backward",
      (chunk) => {
        // Each backward chunk is newest-first; reversing it can return an older prompt.
        for (const message of chunk) {
          if (message.role !== "user" || message.metadata?.synthetic === true) {
            continue;
          }
          const text = extractUserPromptText(message);
          if (text.length > 0) {
            found = { text, messageId: message.id };
            return false;
          }
        }
      }
    );

    if (!result.success) {
      log.warn("workspace.history.lastUserPrompt: failed to read history", {
        workspaceId,
        error: result.error,
      });
      return null;
    }

    return found;
  }

  async getHistoryLoadMore(
    workspaceId: string,
    cursor: WorkspaceHistoryLoadMoreCursor | null | undefined
  ): Promise<WorkspaceHistoryLoadMoreResult> {
    assert(
      typeof workspaceId === "string" && workspaceId.trim().length > 0,
      "workspaceId is required"
    );

    if (cursor !== null && cursor !== undefined) {
      assert(
        isNonNegativeInteger(cursor.beforeHistorySequence),
        "cursor.beforeHistorySequence must be a non-negative integer"
      );
      assert(
        cursor.beforeMessageId === null ||
          cursor.beforeMessageId === undefined ||
          typeof cursor.beforeMessageId === "string",
        "cursor.beforeMessageId must be a string, null, or undefined"
      );
      if (typeof cursor.beforeMessageId === "string") {
        assert(
          cursor.beforeMessageId.trim().length > 0,
          "cursor.beforeMessageId must be non-empty when provided"
        );
      }
    }

    const emptyResult: WorkspaceHistoryLoadMoreResult = {
      messages: [],
      nextCursor: null,
      hasOlder: false,
    };

    try {
      let beforeHistorySequence: number | undefined = cursor?.beforeHistorySequence;

      if (beforeHistorySequence === undefined) {
        // Initial load-more request (no cursor) should page one epoch older than startup replay.
        const latestBoundaryResult = await this.historyService.getHistoryFromLatestBoundary(
          workspaceId,
          0
        );
        if (!latestBoundaryResult.success) {
          log.warn("workspace.history.loadMore: failed to read latest boundary", {
            workspaceId,
            error: latestBoundaryResult.error,
          });
          return emptyResult;
        }

        const oldestFromLatestBoundary = getOldestSequencedMessage(latestBoundaryResult.data);
        if (!oldestFromLatestBoundary) {
          return emptyResult;
        }

        beforeHistorySequence = oldestFromLatestBoundary.historySequence;
      }

      assert(
        isNonNegativeInteger(beforeHistorySequence),
        "resolved beforeHistorySequence must be a non-negative integer"
      );

      const historyWindowResult = await this.historyService.getHistoryBoundaryWindow(
        workspaceId,
        beforeHistorySequence
      );
      if (!historyWindowResult.success) {
        log.warn("workspace.history.loadMore: failed to read boundary window", {
          workspaceId,
          beforeHistorySequence,
          error: historyWindowResult.error,
        });
        return emptyResult;
      }

      const messages: WorkspaceChatMessage[] = historyWindowResult.data.messages.map((message) => ({
        ...message,
        type: "message",
      }));

      if (!historyWindowResult.data.hasOlder) {
        return {
          messages,
          nextCursor: null,
          hasOlder: false,
        };
      }

      const oldestInWindow = getOldestSequencedMessage(historyWindowResult.data.messages);
      if (!oldestInWindow) {
        // Defensive fallback: if we cannot build a stable cursor, stop paging instead of looping.
        log.warn("workspace.history.loadMore: cannot compute next cursor despite hasOlder=true", {
          workspaceId,
          beforeHistorySequence,
        });
        return {
          messages,
          nextCursor: null,
          hasOlder: false,
        };
      }

      return {
        messages,
        nextCursor: {
          beforeHistorySequence: oldestInWindow.historySequence,
          beforeMessageId: oldestInWindow.message.id,
        },
        hasOlder: true,
      };
    } catch (error) {
      log.error("Failed to load more workspace history:", {
        workspaceId,
        error: getErrorMessage(error),
      });
      return emptyResult;
    }
  }

  private async listGitPathsForFileCompletions(
    runtime: Parameters<typeof execBuffered>[0],
    cwd: string
  ): Promise<string[] | null> {
    assert(cwd.trim().length > 0, "File completion git listing requires a workspace cwd");

    const result = await execBuffered(runtime, "git ls-files -co --exclude-standard", {
      cwd,
      timeout: 5,
    });

    if (result.exitCode !== 0) {
      return null;
    }

    return parseFileCompletionPaths(result.stdout);
  }

  private async listWorkspacePathsForFileCompletions(
    metadata: FrontendWorkspaceMetadata,
    workspacePath?: string
  ): Promise<string[] | null> {
    if (!isMultiProject(metadata)) {
      const { runtime, workspacePath } = createRuntimeContextForWorkspace(metadata);
      return this.listGitPathsForFileCompletions(runtime, workspacePath);
    }

    const projectFiles = await Promise.all(
      getProjects(metadata).map(async (project) => {
        assert(
          project.projectName.trim().length > 0,
          `Workspace ${metadata.id} has a project without a projectName`
        );

        const projectRuntime = createRuntime(metadata.runtimeConfig, {
          projectPath: project.projectPath,
          workspaceName: metadata.name,
          workspacePath:
            isSSHRuntime(metadata.runtimeConfig) && workspacePath != null
              ? getWorkspacePathHintForProject(
                  {
                    workspaceId: metadata.id,
                    workspaceName: metadata.name,
                    workspacePath,
                    runtimeConfig: metadata.runtimeConfig,
                    projectPath: metadata.projectPath,
                    projectName: metadata.projectName,
                    projects: metadata.projects,
                  },
                  project.projectPath
                )
              : undefined,
        });
        const projectWorkspacePath = projectRuntime.getWorkspacePath(
          project.projectPath,
          metadata.name
        );
        assert(
          projectWorkspacePath.trim().length > 0,
          `Workspace ${metadata.id} project ${project.projectName} resolved to an empty workspace path`
        );

        const repoFiles = await this.listGitPathsForFileCompletions(
          projectRuntime,
          projectWorkspacePath
        );
        if (repoFiles === null) {
          return null;
        }

        return repoFiles.map((filePath) => path.posix.join(project.projectName, filePath));
      })
    );

    const validProjectFiles = projectFiles.filter((files): files is string[] => files !== null);
    if (validProjectFiles.length !== projectFiles.length) {
      return null;
    }

    return validProjectFiles.flat();
  }

  async getFileCompletions(
    workspaceId: string,
    query: string,
    limit = 20
  ): Promise<{ paths: string[] }> {
    assert(workspaceId, "workspaceId is required");
    assert(typeof query === "string", "query must be a string");

    const resolvedLimit = Math.min(Math.max(1, Math.trunc(limit)), 50);

    // Archive admission pairing (same synchronous block, mirroring executeBash): the refresh
    // below runs git through the target runtime, which can re-wake a Coder workspace the
    // archive hook just stopped. Completions degrade gracefully to empty instead of erroring.
    if (this.archivingWorkspaces.has(workspaceId)) {
      return { paths: [] };
    }
    using _preflightCompletions = this.acquirePreflightAdmission(
      this.preflightFileCompletionCounts,
      workspaceId
    );

    const metadata = await this.getInfo(workspaceId);
    if (!metadata) {
      return { paths: [] };
    }
    if (isWorkspaceArchived(metadata.archivedAt, metadata.unarchivedAt)) {
      return { paths: [] };
    }

    const now = Date.now();
    const CACHE_TTL_MS = 10_000;

    let cached = this.fileCompletionsCache.get(workspaceId);
    if (!cached) {
      cached = { index: EMPTY_FILE_COMPLETIONS_INDEX, fetchedAt: 0 };
      this.fileCompletionsCache.set(workspaceId, cached);
    }

    const cacheEntry = cached;

    const isStale = cacheEntry.fetchedAt === 0 || now - cacheEntry.fetchedAt > CACHE_TTL_MS;
    if (isStale && !cacheEntry.refreshing) {
      // The refresh can outlive this call, so it holds its own admission: acquired here
      // while the outer admission is still held (no unguarded gap) and released when the
      // refresh settles, keeping the archive gate closed for the runtime work's duration.
      const refreshAdmission = this.acquirePreflightAdmission(
        this.preflightFileCompletionCounts,
        workspaceId
      );
      cacheEntry.refreshing = (async () => {
        const previousIndex = cacheEntry.index;

        try {
          const workspace = this.config.findWorkspace(workspaceId);
          const files = await this.listWorkspacePathsForFileCompletions(
            metadata,
            workspace?.workspacePath
          );
          cacheEntry.index = files === null ? previousIndex : buildFileCompletionsIndex(files);
          cacheEntry.fetchedAt = Date.now();
        } catch (error) {
          log.debug("getFileCompletions: failed to list files", {
            workspaceId,
            error: getErrorMessage(error),
          });

          // Keep any previously indexed data, but avoid retrying in a tight loop.
          cacheEntry.index = previousIndex;
          cacheEntry.fetchedAt = Date.now();
        }
      })().finally(() => {
        cacheEntry.refreshing = undefined;
        refreshAdmission[Symbol.dispose]();
      });
    }

    if (cacheEntry.fetchedAt === 0 && cacheEntry.refreshing) {
      await cacheEntry.refreshing;
    }

    return { paths: searchFileCompletions(cacheEntry.index, query, resolvedLimit) };
  }
  async getFullReplay(workspaceId: string): Promise<WorkspaceChatMessage[]> {
    try {
      const session = this.getOrCreateSession(workspaceId);
      const events: WorkspaceChatMessage[] = [];
      await session.replayHistory(({ message }) => {
        events.push(message);
      });
      return events;
    } catch (error) {
      log.error("Failed to get full replay:", error);
      return [];
    }
  }

  async executeBash(
    workspaceId: string,
    script: string,
    options?: ExecuteBashOptions,
    command?: string,
    args?: string[]
  ): Promise<Result<BashToolResult>> {
    if (this.shuttingDown) return Err("Server is shutting down");
    // Block bash execution while workspace is being removed to prevent races with directory deletion.
    // A common case: subagent calls agent_report → frontend's GitStatusStore triggers a git status
    // refresh → executeBash arrives while remove() is deleting the directory → spawn fails with ENOENT.
    // removingWorkspaces is set for the entire duration of remove(), covering the window between
    // disk deletion and metadata invalidation.
    if (this.removingWorkspaces.has(workspaceId)) {
      return Err(`Workspace ${workspaceId} is being removed`);
    }

    // NOTE: This guard must run before any init/runtime operations that could wake a stopped SSH
    // runtime (e.g., Coder workspaces started via `coder ssh --wait=yes`).
    if (this.archivingWorkspaces.has(workspaceId)) {
      return Err(`Workspace ${workspaceId} is being archived; cannot execute bash`);
    }
    // Archive admission pairing (same synchronous block as the guard above, mirroring
    // sendMessage's preflightSendCounts): the metadata/init awaits below would otherwise
    // hide this in-flight exec from the archive gate, letting an archive capture/remove the
    // checkout (or stop a dedicated Coder workspace) while the admitted command resumes
    // against it — on Coder even waking the workspace the archive hook just stopped. Held
    // until the command settles; an archive arming later observes the count, and an exec
    // entering after the gate armed is refused above.
    this.preflightExecCounts.set(workspaceId, (this.preflightExecCounts.get(workspaceId) ?? 0) + 1);
    using _preflightExec = {
      [Symbol.dispose]: () => {
        const remaining = (this.preflightExecCounts.get(workspaceId) ?? 1) - 1;
        if (remaining <= 0) {
          this.preflightExecCounts.delete(workspaceId);
        } else {
          this.preflightExecCounts.set(workspaceId, remaining);
        }
      },
    };

    const metadataResult = await this.aiService.getWorkspaceMetadata(workspaceId);
    if (!metadataResult.success) {
      return Err(`Failed to get workspace metadata: ${metadataResult.error}`);
    }

    const metadata = metadataResult.data;
    if (isWorkspaceArchived(metadata.archivedAt, metadata.unarchivedAt)) {
      return Err(`Workspace ${workspaceId} is archived; cannot execute bash`);
    }

    // Wait for workspace initialization (container creation, code sync, etc.)
    // Same behavior as AI tools - 5 min timeout, then proceeds anyway
    await this.initStateManager.waitForInit(workspaceId);

    try {
      // Get the persisted workspace entry from config. Multi-project git command mode needs the
      // workspace checkout path rather than metadata.projectPath, and other path-addressable
      // runtimes also reuse the persisted workspace root shown in the Explorer.
      const workspace = this.config.findWorkspace(workspaceId);
      if (!workspace) {
        return Err(`Workspace ${workspaceId} not found in config`);
      }

      const multiProjectRuntimes = isMultiProject(metadata)
        ? getProjects(metadata).map((project) => ({
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
          }))
        : undefined;

      // Multi-project workspaces execute bash from the container root so sibling repos are addressable.
      // Single-project workspaces use the persisted workspacePath so devcontainer Docker labels
      // resolve to the correct container even if the path diverges from canonical reconstruction.
      const runtime = multiProjectRuntimes
        ? new MultiProjectRuntime(
            new ContainerManager(getSrcBaseDir(metadata.runtimeConfig) ?? this.config.srcDir),
            multiProjectRuntimes,
            metadata.name
          )
        : createRuntime(metadata.runtimeConfig, {
            projectPath: metadata.projectPath,
            workspaceName: metadata.name,
            workspacePath: workspace.workspacePath,
          });

      // Ensure runtime is ready (e.g., start Docker container if stopped)
      const readyResult = await runtime.ensureReady();
      if (!readyResult.ready) {
        return Err(readyResult.error ?? "Runtime not ready");
      }

      const singleProjectMetadataWithPath = {
        ...metadata,
        namedWorkspacePath: workspace.workspacePath,
      };
      const workspaceRootPath = multiProjectRuntimes
        ? undefined
        : resolveWorkspaceRootPath(singleProjectMetadataWithPath, runtime);
      const workspacePath = multiProjectRuntimes
        ? undefined
        : resolveWorkspaceExecutionPath(singleProjectMetadataWithPath, runtime);
      const multiProjectContainerPath = multiProjectRuntimes
        ? runtime.getWorkspacePath(metadata.projectPath, metadata.name)
        : undefined;
      if (multiProjectContainerPath != null) {
        assert(
          multiProjectContainerPath.length > 0,
          "Multi-project executeBash requires a shared container cwd"
        );
      }

      // Read trust state so tool_env is sourced only when the shared execution environment is trusted.
      const configSnapshot = this.config.loadConfigOrDefault();

      let scriptToExecute = script;
      if (command != null) {
        if (command !== "git") {
          return Err("executeBash command mode only supports git");
        }

        const commandArgs = args ?? [];
        scriptToExecute = [shellQuote(command), ...commandArgs.map((arg) => shellQuote(arg))].join(
          " "
        );
      }

      // Multi-project script mode must stay at the shared container root so sibling repos remain
      // addressable even when task/child workspaces persist their primary-project checkout path.
      // Repo-context UI can opt scripts back into a repo checkout, and path-targeted callers can
      // point repo-root execution at the project that owns the referenced workspace-relative path.
      // Bare git command mode still defaults to the primary repo checkout so git always runs inside
      // a repo even when no caller hint is provided.
      let cwdForExecution = multiProjectContainerPath ?? workspacePath;
      assert(cwdForExecution?.length, "executeBash requires a resolved execution cwd");
      const requiresRepoRootCwd = command === "git" || options?.cwdMode === "repo-root";
      const requestedRepoRootProjectPath = normalizeRepoRootProjectPath(
        options?.repoRootProjectPath
      );
      if (!multiProjectRuntimes && requiresRepoRootCwd) {
        // Sub-project workspaces normally execute tools from their scoped cwd, but repo-context
        // commands (Review, Git status, bare git command mode) need the checkout root so git
        // pathspecs and diff output share the same repo-root coordinate system.
        cwdForExecution = workspaceRootPath;
        assert(cwdForExecution?.length, "Single-project repo-root execution requires a repo cwd");
      }
      if (multiProjectRuntimes && requiresRepoRootCwd) {
        const repoRootRuntime = requestedRepoRootProjectPath
          ? multiProjectRuntimes.find(
              (runtimeEntry) =>
                normalizeRepoRootProjectPath(runtimeEntry.projectPath) ===
                requestedRepoRootProjectPath
            )
          : (multiProjectRuntimes.find(
              (runtimeEntry) =>
                normalizeRepoRootProjectPath(runtimeEntry.projectPath) ===
                normalizeRepoRootProjectPath(metadata.projectPath)
            ) ?? multiProjectRuntimes[0]);
        if (!repoRootRuntime) {
          return Err(
            requestedRepoRootProjectPath
              ? `Unknown repo-root project for workspace ${workspaceId}: ${requestedRepoRootProjectPath}`
              : `Missing primary project runtime for workspace ${workspaceId}`
          );
        }
        cwdForExecution = repoRootRuntime.runtime.getWorkspacePath(
          repoRootRuntime.projectPath,
          metadata.name
        );
        assert(cwdForExecution.length > 0, "Multi-project repo-root execution requires a repo cwd");
      }

      // Multi-project bash shares one execution environment, so inject the union of repo secrets.
      const projectSecrets = isMultiProject(metadata)
        ? mergeMultiProjectSecrets(metadata, this.secretsStore)
        : this.secretsStore.getEffectiveSecrets(metadata.projectPath);

      // Create scoped temp directory for this IPC call
      using tempDir = new DisposableTempDir("mux-ipc-bash");

      const bashTool = createBashTool({
        cwd: cwdForExecution,
        runtime,
        secrets: await secretsToRecord(projectSecrets),
        runtimeTempDir: tempDir.path,
        overflow_policy: "truncate",
        trusted: isWorkspaceTrustedForSharedExecution(metadata, configSnapshot.projects),
      });

      // Execute the script
      const result = (await bashTool.execute!(
        {
          script: scriptToExecute,
          timeout_secs: options?.timeout_secs ?? 120,
        },
        {
          toolCallId: `bash-${Date.now()}`,
          messages: [],
          context: undefined,
        }
      )) as BashToolResult;

      return Ok(result);
    } catch (error) {
      // bashTool.execute returns error results instead of throwing, so this only catches
      // failures from setup code (getWorkspaceMetadata, findWorkspace, createRuntime, etc.)
      const message = getErrorMessage(error);
      return Err(`Failed to execute bash command: ${message}`);
    }
  }

  /**
   * List background processes for a workspace.
   * Returns process info suitable for UI display (excludes handle).
   * Typed against the shared IPC schema so the service and schema cannot drift.
   */
  async listBackgroundProcesses(workspaceId: string): Promise<BackgroundProcessInfo[]> {
    const processes = await this.backgroundProcessManager.list(workspaceId);
    let wakeState: {
      snapshot: BashMonitorWakeReconcilerSnapshot;
      registryRows: readonly BashMonitorRegistryRecord[];
    };
    try {
      const [snapshot, registryRows] = await Promise.all([
        this.bashMonitorWakeReconciler.snapshot(workspaceId),
        this.bashMonitorRegistryStore.listAll(workspaceId),
      ]);
      wakeState = { snapshot, registryRows };
      this.lastGoodPendingWakesByWorkspace.set(workspaceId, wakeState);
    } catch (error) {
      log.debug("Failed to read pending bash monitor wakes for process listing", {
        workspaceId,
        error,
      });
      wakeState = this.lastGoodPendingWakesByWorkspace.get(workspaceId) ?? {
        snapshot: { ownerWorkspaceId: workspaceId, pendingWakeKinds: new Map() },
        registryRows: [],
      };
      this.schedulePendingWakeReadRetry(workspaceId);
    }

    const rows: BackgroundProcessInfo[] = processes.map((process) => {
      const monitor = this.backgroundProcessManager.getMonitorSnapshot(process);
      const pendingWakeKind = this.bashMonitorWakeReconciler.pendingWakeKind(
        wakeState.snapshot,
        process.id
      );
      return {
        id: process.id,
        pid: process.pid,
        script: process.script,
        displayName: process.displayName,
        startTime: process.startTime,
        status: process.status,
        ...(monitor != null
          ? { monitor: pendingWakeKind != null ? { ...monitor, pendingWakeKind } : monitor }
          : {}),
        exitCode: process.exitCode,
      };
    });

    const liveProcessIds = new Set(processes.map((process) => process.id));
    const usedRowIds = new Set(rows.map((row) => row.id));
    for (const record of wakeState.registryRows) {
      const pendingWakeKind = this.bashMonitorWakeReconciler.pendingWakeKind(
        wakeState.snapshot,
        record.processId
      );
      if (pendingWakeKind == null || liveProcessIds.has(record.processId)) continue;
      let rowId = record.processId;
      while (usedRowIds.has(rowId)) rowId = rowId + "#pending-wake";
      usedRowIds.add(rowId);
      const startTime = Date.parse(record.createdAt);
      rows.push({
        id: rowId,
        pid: 0,
        script: record.script,
        displayName: record.displayName ?? record.processId,
        synthesized: true,
        startTime: Number.isNaN(startTime) ? Date.now() : startTime,
        status: "exited",
        monitor: {
          filter: record.filter,
          filter_exclude: record.filterExclude,
          cooldown_ms: 0,
          totalMatches: 0,
          droppedLines: 0,
          lastLines: [],
          stopped: true,
          pendingWakeKind,
        },
        exitCode: record.terminal?.exitCode,
      });
    }
    return rows;
  }

  /**
   * Terminate a background process by ID.
   * Verifies the process belongs to the specified workspace.
   */
  async terminateBackgroundProcess(workspaceId: string, processId: string): Promise<Result<void>> {
    // Get process to verify workspace ownership
    const proc = await this.backgroundProcessManager.getProcess(processId);
    if (!proc) {
      return Err(`Process not found: ${processId}`);
    }
    if (proc.workspaceId !== workspaceId) {
      return Err(`Process ${processId} does not belong to workspace ${workspaceId}`);
    }

    const result = await this.backgroundProcessManager.terminate(processId, {
      monitorDisposition: "discard",
    });
    if (!result.success) {
      return Err(result.error);
    }
    return Ok(undefined);
  }

  /**
   * Peek output for a background bash process.
   *
   * This must not consume the output cursor used by bash_output/task_await.
   */
  async getBackgroundProcessOutput(
    workspaceId: string,
    processId: string,
    options?: { fromOffset?: number; tailBytes?: number }
  ): Promise<
    Result<{
      status: "running" | "exited" | "killed" | "failed";
      output: string;
      nextOffset: number;
      truncatedStart: boolean;
    }>
  > {
    const proc = await this.backgroundProcessManager.getProcess(processId);
    if (!proc) {
      return Err(`Process not found: ${processId}`);
    }
    if (proc.workspaceId !== workspaceId) {
      return Err(`Process ${processId} does not belong to workspace ${workspaceId}`);
    }

    const result = await this.backgroundProcessManager.peekOutput(processId, options);
    if (!result.success) {
      return Err(result.error);
    }

    return Ok({
      status: result.status,
      output: result.output,
      nextOffset: result.nextOffset,
      truncatedStart: result.truncatedStart,
    });
  }

  /**
   * Get the tool call IDs of foreground bash processes for a workspace.
   * Returns empty array if no foreground bashes are running.
   */
  getForegroundToolCallIds(workspaceId: string): string[] {
    return this.backgroundProcessManager.getForegroundToolCallIds(workspaceId);
  }

  /**
   * Send a foreground bash process to background by its tool call ID.
   * The process continues running but the agent stops waiting for it.
   */
  sendToBackground(toolCallId: string): Result<void> {
    const result = this.backgroundProcessManager.sendToBackground(toolCallId);
    if (!result.success) {
      return Err(result.error);
    }
    return Ok(undefined);
  }

  /**
   * Subscribe to background bash state changes.
   */
  onBackgroundBashChange(callback: (workspaceId: string) => void): void {
    this.backgroundProcessManager.on("change", callback);
  }

  /**
   * Unsubscribe from background bash state changes.
   */
  offBackgroundBashChange(callback: (workspaceId: string) => void): void {
    this.backgroundProcessManager.off("change", callback);
  }

  getGoalContinuationRuntimeState(workspaceId: string): GoalContinuationRuntimeState {
    assert(workspaceId.trim().length > 0, "getGoalContinuationRuntimeState requires workspaceId");
    const session =
      this.sessions.get(workspaceId) ?? this.transientStartupRecoverySessions.get(workspaceId);
    const initState = this.initStateManager.getInitState(workspaceId);
    return {
      // Finished init states remain cached; only "running" should block continuations.
      isInitializing: initState?.status === "running",
      isRuntimeCompatible: true,
      // Codex P1 (PRRT_kwDOPxxmWM6cECpR): a direct send does not set PREPARING
      // until late in AgentSession.sendMessage, so goal-continuation
      // eligibility must also treat in-preflight sends as busy. Otherwise a
      // kickoff candidate restored while a pre-goal manual send is mid-flight
      // (row already durable, session still phase-idle) can be consumed and
      // dispatched concurrently with — or ahead of — the user's turn.
      // `preflightSendCounts` is incremented synchronously at sendMessage
      // entry and held until the send settles; admitted sends have set
      // PREPARING (busy) by the time it releases. Queue-dispatched sends set
      // PREPARING synchronously before dispatch and are covered by isBusy().
      isBusy: session?.isBusy() === true || (this.preflightSendCounts.get(workspaceId) ?? 0) > 0,
      hasQueuedMessages: session?.hasPendingManualFollowUp() === true,
      hasPendingFollowUp: false,
    };
  }

  getWorkflowContinuationSendOptions(workspaceId: string): Promise<SendMessageOptions | null> {
    return this.getGoalContinuationKickoffSendOptions(workspaceId);
  }

  /**
   * Send options for continuing a STILL-OPEN delegated workspace turn. The delegated
   * prompt's persisted retrySendOptions carry the turn's own settings — including
   * per-turn overrides (agentId, model, strictAgentResolution) that are deliberately NOT
   * in the workspace's persisted defaults when the launch used skipAiSettingsPersistence —
   * so resolving from workspace defaults would continue the turn under the wrong
   * agent. Openness is decided by the same rule as workspace-turn correlation
   * (inheritOpenWorkspaceTurnMetadata): only a correlated assistant cut with
   * finishReason "tool-calls" leaves the turn open. Once a terminal assistant
   * response closed the turn (or any other user send took over the conversation),
   * a late monitor match is a NEW synthetic turn and resolves from the target's
   * persisted defaults instead of resurrecting stale per-turn overrides.
   *
   * Carrier rows for the open turn's options, newest first: the correlated
   * workspace-turn user row itself, and this mechanism's own wake continuations
   * (their sends were dispatched with the delegated options and re-stamped them) —
   * after an on-send compaction consumed a wake, the follow-up wake-typed row is
   * the only carrier left inside the boundary while the summary still proves the
   * turn is open. Persisted options are rebuilt through a canonical schema
   * whitelist (history is untrusted at rest; a tampered row must not inject fields
   * like editMessageId into an internal send). Continuations never persist these
   * options as workspace defaults.
   */
  private async getDelegatedTurnContinuationSendOptions(
    workspaceId: string
  ): Promise<SendMessageOptions | null> {
    // Tests construct WorkspaceService with partial HistoryService mocks (same
    // defensive pattern as the iterateFullHistory caller above).
    if (typeof this.historyService.getHistoryFromLatestBoundary !== "function") {
      return null;
    }
    const history = await this.historyService.getHistoryFromLatestBoundary(workspaceId);
    if (!history.success) {
      return null;
    }
    const openTurn = inheritOpenWorkspaceTurnMetadata(history.data);
    if (openTurn == null) {
      return null;
    }
    for (let i = history.data.length - 1; i >= 0; i--) {
      const message = history.data[i];
      if (message.role !== "user") {
        continue;
      }
      const muxMetadata = message.metadata?.muxMetadata;
      const isOpenTurnRow =
        muxMetadata?.type === "workspace-turn-task" &&
        muxMetadata.taskHandleId === openTurn.taskHandleId &&
        muxMetadata.turnId === openTurn.turnId;
      const isWakeContinuationRow = muxMetadata?.type === "bash-monitor-wake";
      if (!isOpenTurnRow && !isWakeContinuationRow) {
        continue;
      }
      const parsed = DELEGATED_TURN_CONTINUATION_OPTIONS_SCHEMA.safeParse(
        message.metadata?.retrySendOptions
      );
      if (parsed.success) {
        return {
          ...parsed.data,
          // Per-turn continuation settings must not become workspace defaults.
          skipAiSettingsPersistence: true,
        };
      }
      if (isOpenTurnRow) {
        // The anchor row itself has no usable options; nothing older can be more
        // authoritative for this turn.
        return null;
      }
      // A wake row without valid options: keep walking toward the anchor row.
    }
    return null;
  }

  /**
   * Defensive providers-config read: tests construct WorkspaceService with
   * partial AIService mocks, so a missing method degrades to null instead of
   * throwing inside internal turns (goal kickoff, heartbeats, compaction).
   */
  private getProvidersConfigSafe(): ReturnType<AIService["getProvidersConfig"]> | null {
    try {
      return this.aiService.getProvidersConfig() ?? null;
    } catch {
      return null;
    }
  }

  /**
   * Checkout context for reading agent definitions (definition `ai` defaults
   * and declared base chains). Undefined when the workspace cannot be
   * resolved; the unified resolver then uses its implicit fallback ancestor.
   */
  private async getAgentDefinitionContext(
    workspaceId: string
  ): Promise<NodeAgentDefinitionContext | undefined> {
    try {
      const metadata = await this.getInfo(workspaceId);
      if (!metadata) {
        return undefined;
      }
      const runtime = createRuntimeForWorkspace(metadata);
      return { runtime, workspacePath: resolveWorkspaceRootPath(metadata, runtime), workspaceId };
    } catch {
      return undefined;
    }
  }

  async getGoalContinuationKickoffSendOptions(
    workspaceId: string
  ): Promise<SendMessageOptions | null> {
    assert(
      workspaceId.trim().length > 0,
      "getGoalContinuationKickoffSendOptions requires workspaceId"
    );
    const config = this.config.loadConfigOrDefault();
    const workspaceMatch = this.config.findWorkspace(workspaceId);
    if (!workspaceMatch) {
      return null;
    }
    const project = config.projects.get(workspaceMatch.projectPath);
    const workspaceEntry =
      project?.workspaces.find((w) => w.id === workspaceId) ??
      project?.workspaces.find((w) => w.path === workspaceMatch.workspacePath);

    // Initial workspace `/goal` creation can arm a continuation before any normal
    // sendMessage call runs, so resolve kickoff options from the persisted selected
    // agent instead of assuming the default exec agent. Plan/compact are UI modes,
    // not continuation-capable agents, so fall back to exec for the actual kickoff.
    const persistedAgentId = normalizeAgentId(workspaceEntry?.agentId, WORKSPACE_DEFAULTS.agentId);
    const agentId =
      persistedAgentId === "plan" || persistedAgentId === "compact"
        ? WORKSPACE_DEFAULTS.agentId
        : persistedAgentId;
    const selectedAgentSettings = workspaceEntry?.aiSettingsByAgent?.[agentId];

    // Unified interactive resolution: the workspace's own bucket, then
    // configured/definition defaults and the declared base chain, then the
    // legacy workspace settings as a fallback layer.
    const resolved = await resolveNodeAgentAiSettings({
      agentId,
      profile: "interactive",
      cfg: config,
      providersConfig: this.getProvidersConfigSafe(),
      targetWorkspaceSettings: selectedAgentSettings
        ? targetWorkspaceBucketToLayer(selectedAgentSettings)
        : undefined,
      fallbacks: workspaceEntry?.aiSettings
        ? [
            {
              model: workspaceEntry.aiSettings.model,
              thinkingLevel: coerceThinkingLevel(workspaceEntry.aiSettings.thinkingLevel),
              reasoningMode: coerceOpenAIReasoningMode(workspaceEntry.aiSettings.reasoningMode),
            },
          ]
        : undefined,
      definitionContext: await this.getAgentDefinitionContext(workspaceId),
    });

    // Selected values: the send path persists them and re-clamps at request time.
    return {
      model: resolved.selected.model,
      agentId,
      thinkingLevel: resolved.selected.thinkingLevel,
      ...(resolved.selected.reasoningMode != null
        ? { reasoningMode: resolved.selected.reasoningMode }
        : {}),
    };
  }

  async executeGoalContinuation(input: {
    workspaceId: string;
    message: string;
    startStreamInBackground?: boolean;
    kind?: GoalSyntheticMessageKind;
    goalId?: string;
    options: SendMessageOptions;
    admissionStale?: () => boolean;
  }): Promise<boolean> {
    assert(input.workspaceId.trim().length > 0, "executeGoalContinuation requires workspaceId");
    assert(input.message.trim().length > 0, "executeGoalContinuation requires message");

    const goalKind = input.kind ?? GOAL_CONTINUATION_KIND;
    const startStreamInBackground =
      input.startStreamInBackground === true && goalKind !== GOAL_BUDGET_LIMIT_KIND;
    const sendResult = await this.sendMessage(
      input.workspaceId,
      input.message,
      {
        ...input.options,
        editMessageId: undefined,
      },
      {
        skipAutoResumeReset: true,
        synthetic: true,
        agentInitiated: true,
        startStreamInBackground,
        onAcceptedPreStreamFailure: startStreamInBackground
          ? () =>
              this.workspaceGoalService?.requestPendingGoalContinuationDispatch(input.workspaceId)
          : undefined,
        requireIdle: true,
        goalKind,
        goalId: input.goalId,
        goalContinuation: true,
        // Composed with the requireIdle preflight probe (see the requireIdle
        // admission section in sendMessage).
        admissionStale: input.admissionStale,
      }
    );

    if (!sendResult.success) {
      log.info("WorkspaceService: goal continuation send skipped", {
        workspaceId: input.workspaceId,
        error: sendResult.error,
      });
      return false;
    }
    return true;
  }

  /**
   * Register the callback that receives terminal idle-compaction outcomes.
   * Wired by ServiceContainer to forward outcomes to IdleCompactionService so the
   * idle loop can stop re-attempting a persistently failing workspace.
   */
  setIdleCompactionOutcomeListener(
    listener: (workspaceId: string, outcome: IdleCompactionOutcome) => void
  ): void {
    this.idleCompactionOutcomeListener = listener;
  }

  private reportIdleCompactionOutcome(workspaceId: string, outcome: IdleCompactionOutcome): void {
    this.idleCompactionOutcomeListener?.(workspaceId, outcome);
  }

  /**
   * Execute idle compaction for a workspace directly from the backend.
   *
   * This path is frontend-independent: compaction still runs even if no UI is open.
   * Throws on failure so IdleCompactionService can log and continue with the next workspace.
   */
  async executeIdleCompaction(workspaceId: string): Promise<void> {
    assert(workspaceId.trim().length > 0, "executeIdleCompaction requires a non-empty workspaceId");

    const sendOptions = await this.buildIdleCompactionSendOptions(workspaceId);

    const muxMetadata: MuxMessageMetadata = {
      type: "compaction-request",
      rawCommand: "/compact",
      commandPrefix: "/compact",
      parsed: {
        model: sendOptions.model,
      },
      requestedModel: sendOptions.model,
      source: "idle-compaction",
      displayStatus: { emoji: "💤", message: "Compacting idle workspace..." },
    };

    const session = this.getOrCreateSession(workspaceId);
    if (session.isBusy()) {
      // Expected race (workspace became active), not a failure — do not report an outcome.
      throw new Error(`Failed to execute idle compaction: ${IDLE_ONLY_BUSY_SKIP_MESSAGE}`);
    }

    const sendResult = await this.sendMessage(
      workspaceId,
      buildCompactionMessageText({}),
      {
        ...sendOptions,
        muxMetadata,
      },
      {
        // Idle compaction runs in background; avoid mutating auto-resume counters.
        skipAutoResumeReset: true,
        // Backend-initiated maintenance turn: do not treat as explicit user re-engagement.
        synthetic: true,
        // If the workspace became active after eligibility checks, skip instead of queueing
        // stale maintenance work for later.
        requireIdle: true,
      }
    );

    if (!sendResult.success) {
      const rawError = sendResult.error;
      const formattedError =
        typeof rawError === "object" && rawError !== null
          ? "raw" in rawError && typeof rawError.raw === "string"
            ? rawError.raw
            : "message" in rawError && typeof rawError.message === "string"
              ? rawError.message
              : "type" in rawError && typeof rawError.type === "string"
                ? rawError.type
                : JSON.stringify(rawError)
          : String(rawError);
      // Report genuine pre-stream failures (e.g. invalid/unavailable compaction model) so the
      // idle loop can stop re-attempting this workspace. Mid-stream failures are reported
      // separately from the stream error/completion listeners. The requireIdle busy-skip is an
      // expected race (workspace became active), so it must NOT count toward suppression.
      const isBusySkip =
        sendResult.error.type === "unknown" && sendResult.error.raw === IDLE_ONLY_BUSY_SKIP_MESSAGE;
      if (!isBusySkip) {
        this.reportIdleCompactionOutcome(workspaceId, {
          success: false,
          modelNotFound: classifySendMessageError(sendResult.error).errorType === "model_not_found",
        });
      }
      throw new Error(`Failed to execute idle compaction: ${formattedError}`);
    }

    // Mark idle compaction only while a stream is actually active.
    // sendMessage can succeed on startup-abort paths where no stream is running,
    // and leaking this marker into the next user stream would suppress real notifications.
    if (session.isBusy()) {
      // Marker is added after dispatch to avoid races with concurrent user sends.
      // The streaming=true snapshot was already emitted without the flag, but the
      // streaming=false snapshot (on stream end) picks up the marker.
      this.idleCompactingWorkspaces.add(workspaceId);
      return;
    }

    // Defensive cleanup for startup-abort paths or extremely fast completions that
    // finish before executeIdleCompaction regains control.
    this.idleCompactingWorkspaces.delete(workspaceId);
  }

  private async buildIdleCompactionSendOptions(workspaceId: string): Promise<SendMessageOptions> {
    const config = this.config.loadConfigOrDefault();
    const workspaceMatch = this.config.findWorkspace(workspaceId);

    const workspaceEntry = workspaceMatch
      ? (() => {
          const project = config.projects.get(workspaceMatch.projectPath);
          return (
            project?.workspaces.find((workspace) => workspace.id === workspaceId) ??
            project?.workspaces.find((workspace) => workspace.path === workspaceMatch.workspacePath)
          );
        })()
      : undefined;

    const activity = await this.extensionMetadata.getSnapshot(workspaceId);

    const compactAgentSettings = workspaceEntry?.aiSettingsByAgent?.compact;
    const execAgentSettings =
      workspaceEntry?.aiSettingsByAgent?.[WORKSPACE_DEFAULTS.agentId] ?? workspaceEntry?.aiSettings;

    // Unified resolution for agent "compact": the compact bucket, configured
    // compact defaults, then the declared base chain (so a saved Exec pro
    // default reaches compaction), then the workspace's exec/legacy settings
    // and activity snapshot as fallback layers.
    const resolved = await resolveNodeAgentAiSettings({
      agentId: "compact",
      profile: "interactive",
      cfg: config,
      providersConfig: this.getProvidersConfigSafe(),
      targetWorkspaceSettings: compactAgentSettings
        ? targetWorkspaceBucketToLayer(compactAgentSettings)
        : undefined,
      fallbacks: [
        ...(execAgentSettings
          ? [
              {
                model: execAgentSettings.model,
                thinkingLevel: coerceThinkingLevel(execAgentSettings.thinkingLevel),
                reasoningMode: coerceOpenAIReasoningMode(execAgentSettings.reasoningMode),
              },
            ]
          : []),
        // Activity snapshots do not carry reasoningMode.
        {
          model: activity?.lastModel ?? undefined,
          thinkingLevel: coerceThinkingLevel(activity?.lastThinkingLevel),
        },
      ],
      defaultModel: WORKSPACE_DEFAULTS.model,
      definitionContext: await this.getAgentDefinitionContext(workspaceId),
    });

    return {
      model: resolved.selected.model,
      agentId: "compact",
      // Effective (clamped) thinking: this internal request skips persistence,
      // so there is no user preference to preserve.
      thinkingLevel: resolved.effective.thinkingLevel,
      ...(resolved.selected.reasoningMode != null
        ? { reasoningMode: resolved.selected.reasoningMode }
        : {}),
      maxOutputTokens: undefined,
      // Disable all tools during compaction - regex .* matches all tool names.
      toolPolicy: [{ regex_match: ".*", action: "disable" }],
      // Compaction should not mutate persisted workspace AI defaults.
      skipAiSettingsPersistence: true,
    };
  }

  /**
   * Execute a synthetic heartbeat turn for an idle workspace.
   *
   * This path is frontend-independent: heartbeats still run even if no UI is open.
   * Throws on failure so HeartbeatService can log and continue with the next workspace.
   */
  async executeHeartbeat(workspaceId: string): Promise<void> {
    assert(workspaceId.trim().length > 0, "executeHeartbeat requires a non-empty workspaceId");

    const heartbeatRequest = await this.buildHeartbeatRequest(workspaceId);
    const session = this.getOrCreateSession(workspaceId);
    if (heartbeatRequest.schedulePolicy.whenBusy === "skip") {
      // Idle-only delivery (default): a busy workspace misses this slot entirely.
      if (session.isBusy()) {
        throw new Error(
          "Failed to execute heartbeat: Workspace is busy; idle-only send was skipped."
        );
      }
      if (session.hasQueuedMessages()) {
        throw new Error(
          "Failed to execute heartbeat: Workspace has queued user input; idle-only send was skipped."
        );
      }
    } else {
      // Queue modes deliver through the message queue only while a turn is actively
      // streaming. A non-empty queue instead wins the slot outright: merging a heartbeat
      // into queued user input would clobber that queue's send options (MessageQueue
      // dispatches with the latest options, so the user's queued turn could run with the
      // heartbeat's model/agent), and parking a heartbeat in an idle session's queue
      // deadlocks descendant-task terminal wake-ups — they defer while the owner has
      // queued messages, and an idle queue only drains at the next turn boundary, which
      // would then never come. This also coalesces: a still-pending queued heartbeat is
      // itself a queued message, so the next firing consumes its slot quietly here.
      if (session.hasQueuedMessages()) {
        log.info("Skipped heartbeat enqueue: queued messages own the next turn", {
          workspaceId,
          hadQueuedHeartbeat: session.hasQueuedDedupeKey(HEARTBEAT_QUEUE_DEDUPE_KEY),
        });
        return;
      }
      if (session.isBusy()) {
        await this.queueHeartbeatMessage(workspaceId, heartbeatRequest);
        return;
      }
      // Active descendant tasks alone leave the session idle — fall through to immediate
      // dispatch: the child's terminal wake defers during the heartbeat turn and delivers
      // right after it, so nothing is preempted and nothing deadlocks.
    }

    log.info("Executing heartbeat", {
      workspaceId,
      contextMode: heartbeatRequest.contextMode,
      model: heartbeatRequest.sendOptions.model,
      agentId: heartbeatRequest.sendOptions.agentId,
    });

    switch (heartbeatRequest.contextMode) {
      case "normal":
        await this.dispatchHeartbeatMessage(workspaceId, heartbeatRequest);
        return;
      case "compact":
        await this.dispatchHeartbeatCompactionRequest(workspaceId, heartbeatRequest);
        return;
      case "reset": {
        const appendResult = await session.appendHeartbeatContextResetBoundary({
          boundaryText: HEARTBEAT_RESET_BOUNDARY_MESSAGE,
          pendingFollowUp: heartbeatRequest.followUp,
        });
        if (!appendResult.success) {
          throw new Error(`Failed to execute heartbeat: ${appendResult.error}`);
        }

        const dispatched = await session.dispatchPendingCompactionFollowUpIfNeeded(
          appendResult.data.summaryMessageId
        );
        if (!dispatched) {
          log.info("Skipped heartbeat follow-up after reset boundary", {
            workspaceId,
            contextMode: heartbeatRequest.contextMode,
          });
        }
        return;
      }
      default: {
        const exhaustiveContextMode: never = heartbeatRequest.contextMode;
        throw new Error(`Unhandled heartbeat context mode: ${String(exhaustiveContextMode)}`);
      }
    }
  }

  private async buildHeartbeatRequest(workspaceId: string): Promise<HeartbeatExecutionRequest> {
    const { sendOptions, heartbeatMessage, contextMode, schedulePolicy, intervalMs } =
      await this.buildHeartbeatSendOptions(workspaceId);

    const activity = await this.extensionMetadata.getSnapshot(workspaceId);
    const idleMs =
      typeof activity?.recency === "number"
        ? Math.max(0, Date.now() - activity.recency)
        : HEARTBEAT_DEFAULT_INTERVAL_MS;
    const idleDuration = this.formatIdleDuration(idleMs);
    // Fixed-interval heartbeats are wall-clock scheduled, so "idle for approximately X"
    // would be wrong (the workspace may not have been idle at all). Only the lead varies by
    // trigger; the custom `message` override still replaces only the body, never the lead.
    const heartbeatLead =
      schedulePolicy.trigger === "interval"
        ? `[Scheduled heartbeat] This is a scheduled check-in that fires every ${formatHeartbeatInterval(intervalMs)}.`
        : `[Heartbeat] This workspace has been idle for approximately ${idleDuration}.`;
    const heartbeatBody = heartbeatMessage ?? HEARTBEAT_DEFAULT_MESSAGE_BODY;
    const heartbeatPrompt = `${heartbeatLead} ${heartbeatBody}`;

    assert(
      typeof sendOptions.agentId === "string" && sendOptions.agentId.trim().length > 0,
      "Heartbeat requests require a resolved agentId"
    );

    const muxMetadata: Extract<MuxMessageMetadata, { type: "heartbeat-request" }> = {
      type: "heartbeat-request",
      source: "heartbeat",
      requestedModel: sendOptions.model,
      displayStatus: { emoji: "💓", message: "Heartbeat check..." },
      // The slot's fire time. Queue-mode deliveries persist the history row after the
      // busy turn ends, so restart anchoring reads this instead of the row timestamp.
      firedAt: Date.now(),
    };

    return {
      contextMode,
      schedulePolicy,
      sendOptions,
      heartbeatPrompt,
      muxMetadata,
      followUp: {
        text: heartbeatPrompt,
        model: sendOptions.model,
        agentId: sendOptions.agentId,
        ...pickPreservedSendOptions(sendOptions),
        muxMetadata,
        dispatchOptions: { requireIdle: true },
      },
    };
  }

  /**
   * Deliver a heartbeat that fired while a turn was actively streaming through the message
   * queue. Only used for whenBusy queue modes ("tool-end" / "turn-end"); the caller has
   * already ruled out queued messages (a non-empty queue wins the slot instead).
   */
  private async queueHeartbeatMessage(
    workspaceId: string,
    heartbeatRequest: HeartbeatExecutionRequest
  ): Promise<void> {
    const whenBusy = heartbeatRequest.schedulePolicy.whenBusy;
    assert(whenBusy !== "skip", "queueHeartbeatMessage requires a queue whenBusy mode");

    // The awaiting_interactive_input eligibility gate only sees committed history, but a
    // mid-stream ask_user_question lives in partial.json until the turn commits — so the
    // delivery path must re-check the live manager. A scheduled check-in must never disturb
    // a user-facing prompt; consume the slot quietly instead (like the coalescing skip).
    if (askUserQuestionManager.getLatestPending(workspaceId) != null) {
      log.info("Skipped heartbeat enqueue: an interactive question is pending", {
        workspaceId,
      });
      return;
    }

    // compact/reset boundaries cannot be applied mid-turn, so a busy firing downgrades to a
    // plain queued message for this slot. Idle firings keep honoring contextMode.
    if (heartbeatRequest.contextMode !== "normal") {
      log.info("Busy heartbeat delivery downgrades contextMode to normal for this firing", {
        workspaceId,
        contextMode: heartbeatRequest.contextMode,
      });
    }

    log.info("Queueing heartbeat for busy workspace", {
      workspaceId,
      queueDispatchMode: whenBusy,
    });

    const sendResult = await this.sendMessage(
      workspaceId,
      heartbeatRequest.heartbeatPrompt,
      {
        ...heartbeatRequest.sendOptions,
        muxMetadata: heartbeatRequest.muxMetadata,
        queueDispatchMode: whenBusy,
      },
      {
        // Heartbeats run in background; avoid mutating auto-resume counters.
        skipAutoResumeReset: true,
        // Backend-initiated maintenance turn: do not treat as explicit user re-engagement.
        synthetic: true,
        // If the stream ends between the caller's isBusy check and this send, the message
        // dispatches immediately — the workspace is idle then, so that is the right outcome.
        // The dedupe key guards the opposite race: a heartbeat queued mid-flight coalesces
        // instead of double-queueing.
        queueDedupeKey: HEARTBEAT_QUEUE_DEDUPE_KEY,
        // And if a user send queued during this method's awaits, it owns the slot — the
        // caller's queue-emptiness check is re-verified at the enqueue point.
        yieldToQueuedMessages: true,
      }
    );

    if (!sendResult.success) {
      throw new Error(
        `Failed to execute heartbeat: ${this.formatSendMessageError(sendResult.error)}`
      );
    }
  }

  private async dispatchHeartbeatMessage(
    workspaceId: string,
    heartbeatRequest: HeartbeatExecutionRequest
  ): Promise<void> {
    const whenBusy = heartbeatRequest.schedulePolicy.whenBusy;
    const sendResult = await this.sendMessage(
      workspaceId,
      heartbeatRequest.heartbeatPrompt,
      {
        ...heartbeatRequest.sendOptions,
        muxMetadata: heartbeatRequest.muxMetadata,
        // Queue whenBusy modes tolerate a busy race between the idle check and this send:
        // the heartbeat queues at the requested boundary instead of being dropped.
        ...(whenBusy !== "skip" ? { queueDispatchMode: whenBusy } : {}),
      },
      {
        // Heartbeats run in background; avoid mutating auto-resume counters.
        skipAutoResumeReset: true,
        // Backend-initiated maintenance turn: do not treat as explicit user re-engagement.
        synthetic: true,
        // whenBusy "skip": if the workspace became active after eligibility checks, skip
        // instead of queueing stale maintenance work for later. Queue modes instead queue on
        // that race, deduped against an already-pending heartbeat and yielding to any user
        // input that queued first (queued messages own the slot).
        ...(whenBusy === "skip"
          ? { requireIdle: true }
          : { queueDedupeKey: HEARTBEAT_QUEUE_DEDUPE_KEY, yieldToQueuedMessages: true }),
      }
    );

    if (!sendResult.success) {
      throw new Error(
        `Failed to execute heartbeat: ${this.formatSendMessageError(sendResult.error)}`
      );
    }
  }

  private async dispatchHeartbeatCompactionRequest(
    workspaceId: string,
    heartbeatRequest: HeartbeatExecutionRequest
  ): Promise<void> {
    const compactionSendOptions = await this.buildIdleCompactionSendOptions(workspaceId);
    const compactionMuxMetadata: MuxMessageMetadata = {
      type: "compaction-request",
      rawCommand: "/compact",
      commandPrefix: "/compact",
      parsed: {
        model: compactionSendOptions.model,
        followUpContent: heartbeatRequest.followUp,
      },
      requestedModel: compactionSendOptions.model,
      source: "idle-compaction",
      displayStatus: { emoji: "💓", message: "Compacting before heartbeat..." },
    };

    const sendResult = await this.sendMessage(
      workspaceId,
      buildCompactionMessageText({ followUpContent: heartbeatRequest.followUp }),
      {
        ...compactionSendOptions,
        muxMetadata: compactionMuxMetadata,
      },
      {
        skipAutoResumeReset: true,
        synthetic: true,
        requireIdle: true,
      }
    );

    if (!sendResult.success) {
      throw new Error(
        `Failed to execute heartbeat: ${this.formatSendMessageError(sendResult.error)}`
      );
    }
  }

  private formatSendMessageError(error: SendMessageError): string {
    return typeof error === "object" && error !== null
      ? "raw" in error && typeof error.raw === "string"
        ? error.raw
        : "message" in error && typeof error.message === "string"
          ? error.message
          : "type" in error && typeof error.type === "string"
            ? error.type
            : JSON.stringify(error)
      : String(error);
  }

  private async buildHeartbeatSendOptions(workspaceId: string): Promise<{
    sendOptions: SendMessageOptions;
    heartbeatMessage: string | undefined;
    contextMode: HeartbeatContextMode;
    schedulePolicy: HeartbeatSchedulePolicy;
    intervalMs: number;
  }> {
    const config = this.config.loadConfigOrDefault();
    const workspaceMatch = this.config.findWorkspace(workspaceId);

    const workspaceEntry = workspaceMatch
      ? (() => {
          const project = config.projects.get(workspaceMatch.projectPath);
          return (
            project?.workspaces.find((workspace) => workspace.id === workspaceId) ??
            project?.workspaces.find((workspace) => workspace.path === workspaceMatch.workspacePath)
          );
        })()
      : undefined;

    const activity = await this.extensionMetadata.getSnapshot(workspaceId);

    const rawAgentId = workspaceEntry?.agentId;
    const agentId = normalizeAgentId(rawAgentId, WORKSPACE_DEFAULTS.agentId);
    const agentSettings = workspaceEntry?.aiSettingsByAgent?.[agentId];

    // Unified interactive resolution for the workspace's selected agent: its
    // bucket, configured/definition defaults and the declared base chain, then
    // the legacy workspace settings and activity snapshot as fallback layers.
    const resolved = await resolveNodeAgentAiSettings({
      agentId,
      profile: "interactive",
      cfg: config,
      providersConfig: this.getProvidersConfigSafe(),
      targetWorkspaceSettings: agentSettings
        ? targetWorkspaceBucketToLayer(agentSettings)
        : undefined,
      fallbacks: [
        ...(workspaceEntry?.aiSettings
          ? [
              {
                model: workspaceEntry.aiSettings.model,
                thinkingLevel: coerceThinkingLevel(workspaceEntry.aiSettings.thinkingLevel),
                reasoningMode: coerceOpenAIReasoningMode(workspaceEntry.aiSettings.reasoningMode),
              },
            ]
          : []),
        // Activity snapshots do not carry reasoningMode.
        {
          model: activity?.lastModel ?? undefined,
          thinkingLevel: coerceThinkingLevel(activity?.lastThinkingLevel),
        },
      ],
      defaultModel: WORKSPACE_DEFAULTS.model,
      definitionContext: await this.getAgentDefinitionContext(workspaceId),
    });

    return {
      sendOptions: {
        model: resolved.selected.model,
        agentId,
        // Effective (clamped) thinking: this internal request skips
        // persistence, so there is no user preference to preserve.
        thinkingLevel: resolved.effective.thinkingLevel,
        ...(resolved.selected.reasoningMode != null
          ? { reasoningMode: resolved.selected.reasoningMode }
          : {}),
        maxOutputTokens: undefined,
        // Heartbeats are idle control loops; their prompt may ask the agent to seed a bounded
        // goal before continuing. AIService still gates set_goal to top-level exec-like agents.
        allowAgentSetGoal: true,
        // Heartbeats should not mutate persisted workspace AI defaults.
        skipAiSettingsPersistence: true,
      },
      heartbeatMessage:
        sanitizeHeartbeatMessage(workspaceEntry?.heartbeat?.message) ??
        sanitizeHeartbeatMessage(config.heartbeatDefaultPrompt),
      contextMode: sanitizeHeartbeatContextMode(workspaceEntry?.heartbeat?.contextMode),
      schedulePolicy: resolveHeartbeatSchedulePolicy(workspaceEntry?.heartbeat),
      intervalMs: sanitizeHeartbeatIntervalMs(
        workspaceEntry?.heartbeat?.intervalMs,
        this.getHeartbeatDefaultIntervalMsFromConfig(config)
      ),
    };
  }

  private formatIdleDuration(ms: number): string {
    assert(Number.isFinite(ms) && ms >= 0, "formatIdleDuration requires a non-negative ms value");

    if (ms < 60_000) {
      return "less than a minute";
    }

    if (ms < 3_600_000) {
      const minutes = Math.round(ms / 60_000);
      return `${minutes} minute${minutes === 1 ? "" : "s"}`;
    }

    if (ms < 86_400_000) {
      const hours = Math.round(ms / 3_600_000);
      return `${hours} hour${hours === 1 ? "" : "s"}`;
    }

    const days = Math.round(ms / 86_400_000);
    return `${days} day${days === 1 ? "" : "s"}`;
  }
}

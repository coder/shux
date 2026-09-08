import { DesktopInputCoordinator } from "@/node/services/desktop/DesktopInputCoordinator";
import { randomUUID } from "node:crypto";
import assert from "node:assert/strict";
import * as path from "node:path";
import * as fsPromises from "fs/promises";
import type { z } from "zod";
import {
  TASK_TERMINATION_STOP_STREAM_TIMEOUT_MS,
  TASK_TERMINATION_WORKSPACE_REMOVE_TIMEOUT_MS,
} from "@/constants/terminationTimeouts";
// Persisted task snapshots stamp the legacy exclusive mirror so downgraded
// builds resume tasks in the exclusive posture (see withLegacyPtcExclusiveMirror).
import { withLegacyPtcExclusiveMirror } from "@/common/constants/experiments";
import { SLOW_STARTUP_WARN_THRESHOLD_MS } from "@/constants/startup";
import { raceWithAbortAndTimeout } from "@/node/utils/concurrency/withTimeout";
import { MutexMap } from "@/node/utils/concurrency/mutexMap";
import { AsyncMutex } from "@/node/utils/concurrency/asyncMutex";
import {
  SecretsStore,
  type Config,
  type ProjectsConfig,
  type Workspace as WorkspaceConfigEntry,
} from "@/node/config";
import type { AIService } from "@/node/services/aiService";
import {
  workspaceTurnTerminalAttentionSuppressed,
  type WorkspaceTurnManager,
} from "@/node/services/workspaceTurnManager";
import {
  TASK_RECOVERY_FALLBACK_AGENT_ID,
  formatSubagentFailureUserMessage,
  formatSubagentReportUserMessage,
  getIsoNow,
  resolveTaskAgentIdForResume,
  terminalAttentionOutcome,
  type AgentTaskIntegration,
  type AgentTaskStatus,
  type BackgroundableForegroundWaiter,
  type QueueCutAttributionSnapshot,
  type ResolvedWorkspaceAiSettings,
  type TaskCreateArgs,
  type TaskKind,
  type WorkspaceHost,
  type WorkspaceLifecycleResult,
} from "@/node/services/taskWorkspaceSeam";
export type { TaskKind } from "@/node/services/taskWorkspaceSeam";
import type { HistoryService } from "@/node/services/historyService";
import type { InitStateManager } from "@/node/services/initStateManager";
import { STRUCTURED_WORKFLOW_REPORT_PLACEHOLDER_MARKDOWN } from "@/common/constants/workflowReports";
import {
  SUBAGENT_FAILURE_ENVELOPE_TAG,
  parseSubagentReportEnvelope,
  subagentReportFallbackTitle,
  subagentUpdateFallbackTitle,
} from "@/common/utils/subagentReportEnvelope";
import { BACKGROUND_WORK_WAKE_OPENINGS } from "@/common/utils/machineTurnPrompts";
import type { AgentPeerMessageMeta } from "@/common/utils/agentMessageEnvelope";
import type { SendMessageOptions } from "@/common/orpc/types";
import {
  AGENT_PEER_MESSAGE_DEDUPE_PREFIX,
  AGENT_REPORT_PROGRESS_SUPERSEDED_REASON,
  agentReportProgressDedupePrefix,
} from "@/constants/agentMessaging";
import { TASK_FAMILY_MESSAGE_MAX_CHARS } from "@/constants/taskMessages";
import { log } from "@/node/services/log";
import { eventSpine } from "@/node/services/events/eventSpine";
import { sandboxHostService } from "@/node/services/sandbox/sandboxHostService";
import {
  discoverAgentDefinitions,
  getSkipScopesAboveForKnownScope,
  readAgentDefinition,
  resolveAgentFrontmatter,
} from "@/node/services/agentDefinitions/agentDefinitionsService";
import { resolveAgentInheritanceChain } from "@/node/services/agentDefinitions/resolveAgentInheritanceChain";
import { isAgentEffectivelyDisabled } from "@/node/services/agentDefinitions/agentEnablement";
import { orchestrateFork } from "@/node/services/utils/forkOrchestrator";
import {
  createRuntimeContextForWorkspace,
  createRuntimeForWorkspace,
} from "@/node/runtime/runtimeHelpers";
import { MultiProjectRuntime } from "@/node/runtime/multiProjectRuntime";
import { runBackgroundInit } from "@/node/runtime/runtimeFactory";
import type { InitLogger, Runtime } from "@/node/runtime/Runtime";
import { readPlanFile } from "@/node/utils/runtime/helpers";
import {
  coerceNonEmptyString,
  tryReadGitHeadCommitSha,
  findWorkspaceEntry,
} from "@/node/services/taskUtils";
import { validateWorkspaceName } from "@/common/utils/validation/workspaceValidation";
import { getTaskGroupCount } from "@/common/utils/tools/taskGroups";
import { stripTrailingSlashes } from "@/node/utils/pathUtils";
import { Ok, Err, type Result } from "@/common/types/result";
import { DEFAULT_TASK_SETTINGS, type TaskSettings } from "@/common/types/tasks";
import {
  resolveBackgroundWorkAttentionPolicy,
  type BackgroundWorkAttentionPolicy,
} from "@/common/types/backgroundWorkAttention";
import { createMuxMessage, type MuxMessage, type MuxMessageMetadata } from "@/common/types/message";
import {
  createCompactionSummaryMessageId,
  createTaskFailureMessageId,
  createTaskReportMessageId,
} from "@/node/services/utils/messageIds";
import { defaultModel, normalizeSelectedModel } from "@/common/utils/ai/models";
import { EXPERIMENT_IDS } from "@/common/constants/experiments";
import { SCRATCH_PROJECT_CONFIG_KEY, SCRATCH_PROJECT_NAME } from "@/common/constants/scratch";
import { DEFAULT_RUNTIME_CONFIG } from "@/common/constants/workspace";
import { runtimeModeSupportsSharedTaskWorkspace, type RuntimeConfig } from "@/common/types/runtime";
import type { ProjectRef, WorkspaceMetadata } from "@/common/types/workspace";
import { getRuntimeType } from "@/node/runtime/initHook";
import { AgentIdSchema } from "@/common/orpc/schemas";
import { SendMessageOptionsSchema, ToolPolicySchema } from "@/common/orpc/schemas/stream";
import {
  normalizeAgentId,
  resolvePersistedAgentId,
  resolvePersistedAgentIdCandidates,
} from "@/common/utils/agentIds";
import { GitPatchArtifactService } from "@/node/services/gitPatchArtifactService";
import { getWorkspaceProjectRepos } from "@/node/services/workspaceProjectRepos";
import type { SessionUsageService } from "@/node/services/sessionUsageService";
import type { WorkspaceGoalService } from "@/node/services/workspaceGoalService";
import { subagentReportSourceKey } from "@/common/orpc/schemas/timeline";
import { NOOP_TIMELINE_RECORDER, type TimelineRecorder } from "@/node/services/timelineRecorder";
import { getTotalCost, sumUsageHistory } from "@/common/utils/tokens/usageAggregator";
import {
  coerceOpenAIReasoningMode,
  coerceThinkingLevel,
  type OpenAIReasoningMode,
  type ParsedThinkingInput,
  type ThinkingLevel,
} from "@/common/types/thinking";
import {
  targetWorkspaceBucketToLayer,
  type AgentAiSettingsLayerValues,
} from "@/common/types/agentAiSettings";
import { InvalidExplicitAiSettingError } from "@/common/utils/ai/resolveAgentAiSettings";
import {
  resolveNodeAgentAiSettings,
  type NodeAgentDefinitionContext,
} from "@/node/services/agentDefinitions/resolveNodeAgentAiSettings";
import type { ErrorEvent, StreamAbortEvent, StreamEndEvent } from "@/common/types/stream";
import {
  isActiveWorkflowRunStatus,
  isTerminalWorkflowRunStatus,
  WORKFLOW_BACKGROUND_CONTINUATION_STATUSES,
  type WorkflowRunRecord,
  type WorkflowRunStatus,
} from "@/common/types/workflow";
import { isDynamicToolPart, type DynamicToolPart } from "@/common/types/toolParts";
import {
  buildWorkflowResultContextMessage,
  isTerminalWorkflowRunToolOutput,
  isWorkflowDisplayOnlyMessage,
  isWorkflowRunEmittingToolName,
} from "@/common/utils/workflowRunMessages";
import {
  AgentReportInlineToolArgsSchema,
  AgentReportSubmittedReportSchema,
  TaskToolResultSchema,
  TaskToolArgsSchema,
} from "@/common/utils/tools/toolDefinitions";
import { isPlanLikeInResolvedChain } from "@/common/utils/agentTools";
import { formatSendMessageError } from "@/node/services/utils/sendMessageError";
import {
  AgentPeerMessageBroker,
  type AgentPeerMessageAdmissionError,
} from "@/node/services/agentPeerMessageBroker";
import { taskQueueDebug } from "@/node/services/taskQueueDebug";
import { readSubagentGitPatchArtifact } from "@/node/services/subagentGitPatchArtifacts";
import {
  readSubagentReportArtifact,
  readSubagentReportArtifactsFile,
  upsertSubagentReportArtifact,
} from "@/node/services/subagentReportArtifacts";
import {
  readSubagentFailureArtifact,
  readSubagentFailureArtifactsFile,
  upsertSubagentFailureArtifact,
} from "@/node/services/subagentFailureArtifacts";
import { secretsToRecord } from "@/common/types/secrets";
import { getErrorMessage } from "@/common/utils/errors";
import { isNonRetryableStreamError } from "@/common/utils/messages/retryEligibility";
import type { SendMessageError, StreamErrorType } from "@/common/types/errors";
import { hasCompletedAgentReport } from "@/common/utils/agentTaskCompletion";
import { isWorkspaceArchived } from "@/common/utils/archive";
import type { ToolPolicy } from "@/common/utils/tools/toolPolicy";
import { CONTEXT_BOUNDARY_KINDS } from "@/common/constants/contextBoundary";
import { WorkflowRunStore } from "@/node/services/workflows/WorkflowRunStore";
import {
  isActiveWorkspaceTurnTaskStatus,
  isWorkspaceTurnTaskId,
  type WorkspaceTurnTaskHandleRecord,
  type WorkspaceTurnTaskStatus,
} from "@/node/services/taskHandleStore";
import {
  TerminalAttentionStore,
  type TerminalAttentionNotification,
  type TerminalAttentionOutcome,
} from "@/node/services/terminalAttentionStore";
import { readAgentWorkflowRunReferences } from "@/node/services/agentWorkflowRunReferences";
import type { AgentWorkflowRunStrictPin } from "@/node/services/agentWorkflowRunReferences";
import { isWorkflowRunTaskId } from "@/node/services/tools/taskId";
import { normalizeWorkflowAgentReportPayloadForHostSchema } from "@/common/utils/tools/workflowReportPayload";
import {
  formatJsonSchemaValidationErrors,
  validateJsonSchemaSubset,
  validateJsonSchemaSubsetSchema,
} from "@/common/utils/jsonSchemaSubset";

export class AgentReportWaitTimeoutError extends Error {
  constructor() {
    super("Timed out waiting for agent_report");
    this.name = "AgentReportWaitTimeoutError";
  }
}

interface TaskParentAiMeta {
  /** Parent's persisted selected agent (see persistSelectedAgentId). */
  agentId?: string;
  aiSettingsByAgent?: Record<string, ResolvedWorkspaceAiSettings>;
  aiSettings?: ResolvedWorkspaceAiSettings;
}

export interface AgentTaskStatusLookup {
  exists: boolean;
  taskStatus: AgentTaskStatus | null;
}

export interface AgentTaskTimestamps {
  createdAt?: string;
  reportedAt?: string;
}

type RpcTaskCreateArgs = Omit<TaskCreateArgs, "thinkingLevel"> & { thinkingLevel?: string };

function normalizeRpcTaskThinkingLevel(value: string | undefined): ThinkingLevel | undefined {
  return value === "off" ||
    value === "low" ||
    value === "medium" ||
    value === "high" ||
    value === "xhigh"
    ? value
    : undefined;
}

function parseTerminalSubagentTaskId(content: string): string | null {
  const report = parseSubagentReportEnvelope(content);
  if (report?.status === "completed") return report.taskId;
  if (!content.startsWith(SUBAGENT_FAILURE_ENVELOPE_TAG)) return null;
  return /<task_id>([^\n<]+)<\/task_id>/.exec(content)?.[1] ?? null;
}

/**
 * Workspace-turn terminal output is not injected into parent history; it lives in the task handle
 * store. The wake-up must tell the agent to retrieve it with a one-shot task_await.
 */
function buildCompletedWorkspaceTurnPrompt(handleIds: string[]): string {
  assert(handleIds.length > 0, "buildCompletedWorkspaceTurnPrompt requires at least one handle id");
  return (
    `${BACKGROUND_WORK_WAKE_OPENINGS.workspaceTurnsTerminal} ` +
    `${handleIds.join(", ")}. ` +
    `Call task_await now with task_ids: ${JSON.stringify(handleIds)} and timeout_secs: 0 to ` +
    "retrieve their terminal output, then integrate it into your work. These handles are already " +
    "terminal — do not repeatedly wait if task_await returns a terminal status."
  );
}

function getTaskCompletionInstruction(params: {
  completionKind: "final_response" | "propose_plan";
  requiresStructuredOutput?: boolean;
}): string {
  if (params.completionKind === "propose_plan") {
    return "Call propose_plan exactly once now. Base it only on the planning work already completed in this workspace.";
  }

  const structuredInstruction = params.requiresStructuredOutput
    ? "First call agent_report with the final structured output required by this workflow step. Then "
    : "";
  return `${structuredInstruction}respond with your final assistant message now. Base it only on the work already completed in this workspace.`;
}

type AgentReportFinalizationResult =
  | { finalized: true }
  | {
      finalized: false;
      reason: "invalid_structured_output" | "pending_guidance" | "terminal_interrupted";
      message: string;
    };

/**
 * Rendered form of a labeled task message as sendMessageToDescendantAgentTask
 * persists it. Shared with the sibling family-message budget accounting so
 * the charged trigger length can never drift from the delivered bytes (r21).
 */
function renderLabeledTaskMessage(label: string, message: string): string {
  return `${label}:\n\n${message}`;
}

function formatStructuredOutputValidationMessage(params: {
  workflowTask: NonNullable<WorkspaceConfigEntry["workflowTask"]>;
  errors: Array<{ path: string; message: string }>;
}): string {
  const stepLabel = params.workflowTask.stepId
    ? ` for workflow step ${params.workflowTask.stepId}`
    : "";
  const errorSummary = formatJsonSchemaValidationErrors(params.errors, { maxErrors: 5 });
  return `agent_report structuredOutput failed schema validation${stepLabel}: ${errorSummary}`;
}

function normalizeWorkflowAgentReportArgsForWorkflowTask(
  workflowTask: WorkspaceConfigEntry["workflowTask"] | undefined,
  reportArgs: {
    reportMarkdown: string;
    title?: string;
    structuredOutput?: unknown;
    planFilePath?: string;
  }
): { reportMarkdown: string; title?: string; structuredOutput?: unknown; planFilePath?: string } {
  if (workflowTask?.outputSchema === undefined || reportArgs.structuredOutput === undefined) {
    return reportArgs;
  }
  return {
    ...reportArgs,
    structuredOutput: normalizeWorkflowAgentReportPayloadForHostSchema(
      workflowTask.outputSchema,
      reportArgs.structuredOutput
    ),
  };
}

function validateWorkflowAgentReportStructuredOutput(params: {
  workflowTask?: WorkspaceConfigEntry["workflowTask"];
  reportArgs: { structuredOutput?: unknown };
  allowLegacyInvalidOutputSchema: boolean;
}): string | null {
  const workflowTask = params.workflowTask;
  if (workflowTask?.outputSchema === undefined) {
    return null;
  }

  if (params.allowLegacyInvalidOutputSchema) {
    return null;
  }

  if (
    !Object.hasOwn(params.reportArgs, "structuredOutput") ||
    params.reportArgs.structuredOutput === undefined
  ) {
    return formatStructuredOutputValidationMessage({
      workflowTask,
      errors: [{ path: "$.structuredOutput", message: "Required property is missing" }],
    });
  }

  const structuredOutput = normalizeWorkflowAgentReportPayloadForHostSchema(
    workflowTask.outputSchema,
    params.reportArgs.structuredOutput
  );
  const validation = validateJsonSchemaSubset(workflowTask.outputSchema, structuredOutput);
  if (validation.success) {
    return null;
  }

  return formatStructuredOutputValidationMessage({
    workflowTask,
    errors: validation.errors,
  });
}

function isAgentRunnableAsChild(
  frontmatter: { subagent?: { runnable?: boolean; workflow_runnable?: boolean } },
  params: { workflowOwned: boolean }
): boolean {
  if (frontmatter.subagent?.runnable === true) {
    return true;
  }
  return params.workflowOwned && frontmatter.subagent?.workflow_runnable === true;
}

export interface TaskCreateResult {
  desktopOwnerWorkspaceId?: string;
  taskId: string;
  kind: TaskKind;
  status: "queued" | "starting" | "running";
  /** Resolved (post-precedence) AI settings the child was created with. */
  modelString?: string;
  thinkingLevel?: ThinkingLevel;
}

type TaskLaunchStart = { kind: "sendMessage"; prompt: string } | { kind: "resumeStream" };

interface TaskLaunchPlan {
  taskId: string;
  parentWorkspaceId: string;
  parentMeta: WorkspaceMetadata;
  agentId: string;
  agentType: string;
  start: TaskLaunchStart;
  title: string;
  workspaceName: string;
  createdAt: string;
  taskRuntimeConfig: RuntimeConfig;
  parentRuntimeConfig: RuntimeConfig;
  configProjectPath: string;
  workspaceKind?: "scratch";
  taskModelString: string;
  canonicalModel: string;
  effectiveThinkingLevel?: ThinkingLevel;
  effectiveReasoningMode?: OpenAIReasoningMode;
  skipInitHook: boolean;
  preferredTrunkBranch?: string;
  workflowTask?: TaskCreateArgs["workflowTask"];
  bestOf?: TaskCreateArgs["bestOf"];
  experiments?: TaskCreateArgs["experiments"];
  onRefusal?: TaskCreateArgs["onRefusal"];
  attentionPolicy?: TaskCreateArgs["attentionPolicy"];
  taskDesktopOwnerWorkspaceId?: string;
}

interface TaskCreateManyOptions {
  onTaskReserved?: (index: number, result: TaskCreateResult) => Promise<void> | void;
}

interface MaterializedTaskLaunch {
  workspacePath: string;
  trunkBranch: string;
  forkedRuntimeConfig: RuntimeConfig;
  runtimeForTaskWorkspace: Runtime;
  inheritedProjects: WorkspaceMetadata["projects"];
  sourceRuntimeConfigUpdate?: RuntimeConfig;
}

export type TaskMessageQueueDispatchMode = "tool-end" | "turn-end";

export interface SendAgentTaskMessageResult {
  delivery: "accepted" | "queued" | "reactivated";
  queueDispatchMode?: TaskMessageQueueDispatchMode;
  executionTaskId?: string;
}

export interface RetitleAgentTaskResult {
  title: string;
}

export type RetitleAgentTaskError =
  | { code: "not_found" }
  | { code: "invalid_scope" }
  | { code: "update_failed"; message: string };

export type SendAgentTaskMessageError =
  | { code: "not_found" }
  | { code: "invalid_scope" }
  | { code: "not_active"; taskStatus: AgentTaskStatus | "unknown"; message?: string }
  | { code: "send_failed"; message: string };

/** Result of a child->parent family message (RLM family messaging). */
export interface SendParentAgentMessageResult {
  parentWorkspaceId: string;
}

export type SendParentAgentMessageError =
  | { code: "invalid_scope"; message: string }
  | { code: "send_failed"; message: string };

/**
 * How the target relates to the sender within one task tree (parentWorkspaceId chains only).
 * "target_descendant" routes to the trusted parent→child guidance path; "peer" (sibling/cousin)
 * and "target_ancestor" take the untrusted <mux_agent_message> envelope path.
 */
export type AgentTreeTargetRelation = "target_descendant" | "target_ancestor" | "peer";

export type SendAgentTreeMessageError = SendAgentTaskMessageError | AgentPeerMessageAdmissionError;

interface TrustedDescendantMessageOptions {
  messageLabel?: string;
  preTurnMessages?: MuxMessage[];
  onPreTurnPersisted?: () => void;
}

type TreeMessageSpec =
  | {
      relation: "descendant";
      senderWorkspaceId: string;
      targetId: string;
      message: string;
      queueDispatchMode: TaskMessageQueueDispatchMode;
      options?: TrustedDescendantMessageOptions;
    }
  | {
      relation: "peer";
      senderWorkspaceId: string;
      targetId: string;
      message: string;
      targetRelation: "peer" | "target_ancestor";
      queueDispatchMode?: TaskMessageQueueDispatchMode;
    }
  | {
      relation: "parent-family";
      senderWorkspaceId: string;
      message: string;
      queueDispatchMode: TaskMessageQueueDispatchMode;
    }
  | {
      relation: "sibling-family";
      senderWorkspaceId: string;
      targetId: string;
      message: string;
      queueDispatchMode: TaskMessageQueueDispatchMode;
    };

type TreeMessagePipelineResult =
  | SendAgentTaskMessageResult
  | SendParentAgentMessageResult
  | (SendAgentTaskMessageResult & { relation: AgentTreeTargetRelation });

type TreeMessagePipelineError = SendAgentTreeMessageError | SendParentAgentMessageError;

interface TreeMessageBudgetReservation {
  markPersisted(): void;
  refundIfUnpersisted(): void;
}

/** The caller-relative relationship tag on task_list scope:"tree" rows. */
export type TreeAgentRelationship = "self" | "ancestor" | "sibling" | "descendant";

export interface TreeAgentTaskInfo extends DescendantAgentTaskInfo {
  relationship: TreeAgentRelationship;
}

export interface TaskTreeAgentsResult {
  /** Root of the caller's task tree (a plain workspace, not an agent task). */
  rootWorkspaceId: string;
  rootTitle?: string;
  /** "self" when the caller is the root; "ancestor" otherwise. */
  rootRelationship: "self" | "ancestor";
  /** True when the root workspace is archived: peer sends refuse it, so discovery hides it. */
  rootArchived?: true;
  /**
   * True when the resolved root ID has no config entry (parent chain ends at a removed or
   * corrupted workspace): peer sends return not_found for it, so discovery hides the row.
   */
  rootMissing?: true;
  /**
   * True when the CALLER cannot send peer messages at all (best-of candidate or workflow-owned
   * chain): non-descendant rows are omitted so discovery never advertises unreachable targets.
   */
  callerPeerMessagingRestricted?: true;
  tasks: TreeAgentTaskInfo[];
}

export interface TerminateAgentTaskResult {
  /** Task IDs terminated (includes descendants). */
  terminatedTaskIds: string[];
}

export interface DescendantAgentTaskInfo {
  taskId: string;
  status: AgentTaskStatus;
  parentWorkspaceId: string;
  agentType?: string;
  workspaceName?: string;
  title?: string;
  createdAt?: string;
  executionTaskId?: string;
  executionStatus?: WorkspaceTurnTaskStatus;
  modelString?: string;
  thinkingLevel?: ThinkingLevel;
  bestOf?: WorkspaceMetadata["bestOf"];
  depth: number;
}

type AgentTaskWorkspaceEntry = WorkspaceConfigEntry & { projectPath: string };

const ACTIVE_AGENT_TASK_STATUSES = new Set<AgentTaskStatus>([
  "queued",
  "starting",
  "running",
  "awaiting_report",
]);

const WORKSPACE_BUSY_IDLE_ONLY_SEND_MESSAGE = "Workspace is busy; idle-only send was skipped.";

function isWorkspaceBusyIdleOnlySend(error: unknown): boolean {
  return (
    error != null &&
    typeof error === "object" &&
    (error as { type?: unknown }).type === "unknown" &&
    typeof (error as { raw?: unknown }).raw === "string" &&
    (error as { raw: string }).raw.includes(WORKSPACE_BUSY_IDLE_ONLY_SEND_MESSAGE)
  );
}

const REMOVED_AGENT_TASKS_DIR = "removed-agent-tasks";

const COMPLETED_REPORT_CACHE_MAX_ENTRIES = 128;

// Level-triggered backstop for workflow terminal wakes: the sweep re-derives owed wakes from
// durable state (run records + settled markers), so lost terminal callbacks, deferred
// (transiently unreadable) evaluations, and crashes all recover here without any per-failure
// retry bookkeeping.
const WORKFLOW_TERMINAL_ATTENTION_SWEEP_INTERVAL_MS = 5 * 60_000;

/** Maximum consecutive auto-resumes before stopping. Prevents infinite loops when descendants are stuck. */

const MAX_CONSECUTIVE_PARENT_AUTO_RESUMES = 3;

/**
 * Maximum completion-tool recovery prompts for a child task (since it last
 * completed successfully) before the task is interrupted instead of prompted
 * again. Unlike the in-memory
 * parent auto-resume counter above, this budget is persisted on the workspace
 * config entry (taskRecoveryAttempts) so crash/restart recovery loops stay
 * bounded across app restarts. Covers terminal-but-unclassified outcomes such
 * as repeated empty_output errors, repeated length-truncated turns, and models
 * that never call their completion tool.
 */
const MAX_TASK_RECOVERY_ATTEMPTS = 5;

/**
 * Reason persisted when other queued input (a manual user message, /compact)
 * cut a delegated turn at a tool boundary and superseded it. The target
 * workspace continues under the new input, so the owner sees an interruption
 * with this explanation rather than a task failure.
 */

/**
 * Reason prefix persisted when the owner's OWN follow-up turn (task
 * kind="workspace", mode="existing", tool-end dispatch) cut its active
 * delegated turn at a tool boundary. The full reason names the successor
 * handle. Wording stays neutral third-person: the persisted error can surface
 * to a direct parent that did NOT initiate the successor (parent ≠ owner
 * envelope case) and to any awaiting workspace — second-person phrasing
 * belongs only in the initiating task tool's creation note. This flavor
 * settles quietly for the owner (no terminal-attention wake, no direct-parent
 * envelope when the parent IS the owner): an agent should not be woken merely
 * to learn the expected consequence of a follow-up it just initiated.
 */

/**
 * The error string is the durable flavor marker (no schema field): prefix
 * matching keeps old records parseable on downgrade while letting suppression
 * decisions derive purely from the persisted record.
 */

/**
 * Terminal settlements whose owner terminal-attention wake is suppressed. A
 * pure function of the settled record so live settlement, startup recovery,
 * and resettle agree — restarts must not resurrect a suppressed wake.
 * Deliberately NOT recorded via terminalAttentionNotifiedAt (which means "a
 * notification was delivered"): deriving from the record keeps the audit trail
 * clean and stays downgrade-safe with no schema change.
 */

/**
 * Provider-terminal stream errors that settle a child task even while it is
 * still `running` (before it owes its completion tool). Subset of
 * NON_RETRYABLE_STREAM_ERRORS: user intent (aborted) must never terminally
 * settle a running task, and errors with in-session recovery
 * (context_exceeded) settle only after that recovery declines (see
 * handleTaskStreamError).
 */
const RUNNING_TASK_TERMINAL_STREAM_ERRORS: ReadonlySet<StreamErrorType> = new Set([
  "model_refusal",
  "authentication",
  "quota",
  "model_not_found",
  "runtime_not_ready",
]);

interface AgentTaskIndex {
  byId: Map<string, AgentTaskWorkspaceEntry>;
  childrenByParent: Map<string, string[]>;
  parentById: Map<string, string>;
}

type WorkflowTaskConfig = NonNullable<WorkspaceConfigEntry["workflowTask"]>;

interface WorkflowTaskOwner {
  taskId: string;
  workspace: AgentTaskWorkspaceEntry;
  workflowTask: WorkflowTaskConfig;
}

interface InactiveWorkflowTaskOwner {
  ownerTaskId: string;
  runId: string;
  status?: WorkflowRunStatus;
  reason: string;
}

type InterruptedTaskStatusMutation = "interrupted" | "preserved-completed-report";

interface PendingTaskWaiter extends BackgroundableForegroundWaiter {
  resolve: (report: {
    reportMarkdown: string;
    title?: string;
    structuredOutput?: unknown;
    planFilePath?: string;
    model?: string;
    thinkingLevel?: ThinkingLevel;
  }) => void;
}

interface PendingTaskStartWaiter {
  start: () => void;
  cleanup: () => void;
}

interface CompletedAgentReportCacheEntry {
  reportMarkdown: string;
  planFilePath?: string;
  structuredOutput?: unknown;
  title?: string;
  // Final settings the child reported with (post plan-to-exec handoff), not the launch snapshot.
  model?: string;
  thinkingLevel?: ThinkingLevel;
  // Ancestor workspace IDs captured when the report was cached.
  // Used to keep descendant-scope checks working even if the task workspace is cleaned up.
  ancestorWorkspaceIds: string[];
  // Ancestors for which the task report must only be consumed through a workflow run.
  workflowOwnedAncestorWorkspaceIds?: string[];
}

interface ParentAutoResumeHint {
  agentId?: string;
}

/** Launch identity recorded with a workflow run reference; see AgentWorkflowRunReference. */
interface WorkflowWakeInitiatingAgent {
  agentId: string;
  createdAtMs: number;
  strictAgentResolution?: AgentWorkflowRunStrictPin | null;
}

// Coalescing key for terminal workflow wakes: the pin is part of the launch identity, so an
// agentId alone must not merge a pinned launch with an unpinned (or differently pinned) one.
// undefined (legacy walk fallback), null (verified unpinned), and each concrete pin are
// distinct groups; over-splitting structurally equal pins is safe, merging them is not.
function workflowWakeGroupKey(agent: WorkflowWakeInitiatingAgent): string {
  const pin = agent.strictAgentResolution;
  return `${agent.agentId}\u0000${pin === undefined ? "walk" : JSON.stringify(pin)}`;
}

// Reserved workflowWakeGroupSendBackoffUntilMs key for the non-workflow (sub-agent and
// workspace-turn) send batch. Group keys start with a non-empty agentId and the empty string
// keys the unpinned group, so a leading \u0000 cannot collide.
const NON_WORKFLOW_WAKE_BACKOFF_KEY = "\u0000non-workflow";

function isTypedWorkspaceEvent(value: unknown, type: string): boolean {
  return (
    typeof value === "object" &&
    value !== null &&
    "type" in value &&
    (value as { type: unknown }).type === type &&
    "workspaceId" in value &&
    typeof (value as { workspaceId: unknown }).workspaceId === "string"
  );
}

function isStreamEndEvent(value: unknown): value is StreamEndEvent {
  return isTypedWorkspaceEvent(value, "stream-end");
}

function isStreamAbortEvent(value: unknown): value is StreamAbortEvent {
  return isTypedWorkspaceEvent(value, "stream-abort");
}

function isErrorEvent(value: unknown): value is ErrorEvent {
  return isTypedWorkspaceEvent(value, "error");
}

function hasAncestorWorkspaceId(
  entry: { ancestorWorkspaceIds?: unknown } | null | undefined,
  ancestorWorkspaceId: string
): boolean {
  const ids = entry?.ancestorWorkspaceIds;
  return Array.isArray(ids) && ids.includes(ancestorWorkspaceId);
}

function hasWorkflowOwnedAncestorWorkspaceId(
  entry: { workflowOwnedAncestorWorkspaceIds?: unknown } | null | undefined,
  ancestorWorkspaceId: string
): boolean {
  const ids = entry?.workflowOwnedAncestorWorkspaceIds;
  return Array.isArray(ids) && ids.includes(ancestorWorkspaceId);
}

function isSuccessfulToolResult(value: unknown): boolean {
  return (
    typeof value === "object" &&
    value !== null &&
    "success" in value &&
    (value as { success?: unknown }).success === true
  );
}

function formatBackgroundAwaitTargetList(label: string, ids: string[]): string | null {
  if (ids.length === 0) {
    return null;
  }
  return `${label} (${ids.join(", ")})`;
}

function buildBackgroundAwaitPrompt(params: {
  taskIds: string[];
  workflowRunIds: string[];
}): string {
  assert(
    params.taskIds.length > 0 || params.workflowRunIds.length > 0,
    "buildBackgroundAwaitPrompt requires at least one awaitable target"
  );

  const targetLabels = [
    formatBackgroundAwaitTargetList("task handle(s)", params.taskIds),
    formatBackgroundAwaitTargetList("workflow run(s)", params.workflowRunIds),
  ].filter((label): label is string => label != null);
  const taskIds = [...params.taskIds, ...params.workflowRunIds];

  return (
    `${BACKGROUND_WORK_WAKE_OPENINGS.awaitableWorkActive}${targetLabels.join(" and ")}. ` +
    "You MUST NOT end your turn while any listed task handles are queued/starting/running/awaiting_report or workflow runs are pending/running/backgrounded. " +
    `Call task_await now with task_ids: ${JSON.stringify(taskIds)} to wait for them. ` +
    "If any are still queued/starting/running/awaiting_report/backgrounded after that, call task_await again. " +
    "Only once all listed work is terminal should you write your final response, integrating any reports or workflow results."
  );
}

const isWorkflowRunId = isWorkflowRunTaskId;

function collectWorkflowRunIdsFromToolOutput(output: unknown): string[] {
  if (output == null || typeof output !== "object") {
    return [];
  }

  const record = output as Record<string, unknown>;
  if (isWorkflowRunId(record.runId)) {
    return [record.runId];
  }

  const results = record.results;
  if (!Array.isArray(results)) {
    return [];
  }

  const runIds: string[] = [];
  for (const result of results) {
    if (result == null || typeof result !== "object") {
      continue;
    }
    const taskId = (result as Record<string, unknown>).taskId;
    if (isWorkflowRunId(taskId)) {
      runIds.push(taskId);
    }
  }
  return runIds;
}

/**
 * Tolerant extraction of the task IDs a persisted task tool output references. Recovery
 * bookkeeping must survive outputs written by newer releases (extra fields would fail the
 * strict result schema) so that a mid-stream downgrade cannot duplicate fallback reports.
 */
function collectReferencedTaskIdsFromTaskToolOutput(output: unknown, into: Set<string>): void {
  if (output == null || typeof output !== "object") {
    return;
  }
  const addTaskId = (value: unknown): void => {
    if (typeof value === "string" && value.length > 0) {
      into.add(value);
    }
  };

  const record = output as Record<string, unknown>;
  addTaskId(record.taskId);
  if (Array.isArray(record.taskIds)) {
    for (const taskId of record.taskIds) {
      addTaskId(taskId);
    }
  }
  for (const key of ["tasks", "reports"] as const) {
    const rows = record[key];
    if (!Array.isArray(rows)) {
      continue;
    }
    for (const row of rows) {
      if (row != null && typeof row === "object") {
        addTaskId((row as Record<string, unknown>).taskId);
      }
    }
  }
}

interface RecoveredTaskToolInput {
  data: z.infer<typeof TaskToolArgsSchema>;
  groupCount: number;
  legacyVariants: boolean;
}

/**
 * Persisted partials may contain the removed `variants` input. Keep that field out of the
 * model-facing schema while accepting it narrowly during crash recovery so completed legacy
 * siblings can still finalize their parent tool call.
 */
function parseTaskToolInputForRecovery(input: unknown): RecoveredTaskToolInput | null {
  const current = TaskToolArgsSchema.safeParse(input);
  if (current.success) {
    return {
      data: current.data,
      groupCount: getTaskGroupCount(current.data),
      legacyVariants: false,
    };
  }

  if (!input || typeof input !== "object" || Array.isArray(input)) {
    return null;
  }

  const sanitized = { ...(input as Record<string, unknown>) };
  const variants = sanitized.variants;
  delete sanitized.variants;
  const parsed = TaskToolArgsSchema.safeParse(sanitized);
  if (!parsed.success) {
    return null;
  }

  if (variants == null) {
    return {
      data: parsed.data,
      groupCount: getTaskGroupCount(parsed.data),
      legacyVariants: false,
    };
  }
  if (!Array.isArray(variants) || variants.length < 1 || variants.length > 20) {
    return null;
  }

  const labels = variants.map((variant) => (typeof variant === "string" ? variant.trim() : ""));
  if (labels.some((label) => label.length === 0) || new Set(labels).size !== labels.length) {
    return null;
  }

  return {
    data: parsed.data,
    groupCount: labels.length,
    legacyVariants: true,
  };
}

function collectWorkflowRunIdsFromTaskAwaitInput(input: unknown): string[] {
  if (input == null || typeof input !== "object") {
    return [];
  }
  const taskIds = (input as Record<string, unknown>).task_ids;
  if (!Array.isArray(taskIds)) {
    return [];
  }
  return taskIds.filter(isWorkflowRunId);
}

function collectAgentReferencedWorkflowRunIdsFromParts(
  parts: readonly unknown[],
  knownAgentRunIds: ReadonlySet<string>
): string[] {
  const runIds = new Set<string>();

  for (const part of parts) {
    if (!isDynamicToolPart(part) || part.state !== "output-available") {
      continue;
    }
    // workflow_resume re-establishes agent provenance the same way workflow_run does: both
    // outputs carry the runId of a run the agent explicitly owns.
    if (!isWorkflowRunEmittingToolName(part.toolName)) {
      continue;
    }
    for (const runId of collectWorkflowRunIdsFromToolOutput(part.output)) {
      runIds.add(runId);
    }
  }

  const allowedTaskAwaitRunIds = new Set([...knownAgentRunIds, ...runIds]);
  for (const part of parts) {
    if (!isDynamicToolPart(part) || part.state !== "output-available") {
      continue;
    }
    if (part.toolName !== "task_await") {
      continue;
    }

    // Omitted task_ids makes task_await discover every active run in the workspace, including
    // slash-command runs. Only treat task_await output as agent provenance when the model either
    // explicitly awaited that workflow ID in this turn or we already know the run was agent-started.
    for (const runId of collectWorkflowRunIdsFromTaskAwaitInput(part.input)) {
      runIds.add(runId);
      allowedTaskAwaitRunIds.add(runId);
    }
    for (const runId of collectWorkflowRunIdsFromToolOutput(part.output)) {
      if (allowedTaskAwaitRunIds.has(runId)) {
        runIds.add(runId);
      }
    }
  }

  return Array.from(runIds);
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

function isResetBoundaryMessage(message: MuxMessage): boolean {
  return message.metadata?.contextBoundaryKind === CONTEXT_BOUNDARY_KINDS.RESET;
}

function isCompactionRequestMessage(message: MuxMessage): boolean {
  return message.metadata?.muxMetadata?.type === "compaction-request";
}

function isWorkflowSupersessionMessage(message: MuxMessage): boolean {
  return isManualUserSupersessionMessage(message) || isResetBoundaryMessage(message);
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

function hasTerminalWorkflowTaskAwaitInParts(parts: readonly unknown[], runId: string): boolean {
  return parts.some((part) => {
    if (!isDynamicToolPart(part) || part.toolName !== "task_await") {
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

function hasTerminalWorkflowToolOutputInParts(parts: readonly unknown[], runId: string): boolean {
  return parts.some(
    (part) =>
      isDynamicToolPart(part) &&
      part.state === "output-available" &&
      isTerminalWorkflowRunToolOutput(part.toolName, part.output, runId)
  );
}

function sanitizeAgentTypeForName(agentType: string): string {
  const normalized = agentType
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9_-]/g, "_")
    .replace(/_+/g, "_")
    .replace(/-+/g, "-")
    .replace(/^[_-]+|[_-]+$/g, "");

  return normalized.length > 0 ? normalized : "agent";
}

function buildAgentWorkspaceName(agentType: string, workspaceId: string): string {
  const safeType = sanitizeAgentTypeForName(agentType);
  const base = `agent_${safeType}_${workspaceId}`;
  // Hard cap to validation limit (64). Ensure stable suffix is preserved.
  if (base.length <= 64) return base;

  const suffix = `_${workspaceId}`;
  const maxPrefixLen = 64 - suffix.length;
  const prefix = `agent_${safeType}`.slice(0, Math.max(0, maxPrefixLen));
  const name = `${prefix}${suffix}`;
  return name.length <= 64 ? name : `agent_${workspaceId}`.slice(0, 64);
}

async function runtimePathExists(runtime: Runtime, path: string): Promise<boolean> {
  assert(path.length > 0, "runtimePathExists: path must be non-empty");
  try {
    await runtime.stat(path);
    return true;
  } catch {
    return false;
  }
}

async function readTaskBaseCommitShaByProjectPath(params: {
  workspaceId: string;
  workspaceName: string;
  workspacePath: string;
  runtimeConfig: RuntimeConfig;
  projectPath: string;
  projectName: string;
  projects?: WorkspaceMetadata["projects"];
  runtime: Runtime;
}): Promise<Record<string, string>> {
  const projectRepos = getWorkspaceProjectRepos({
    workspaceId: params.workspaceId,
    workspaceName: params.workspaceName,
    workspacePath: params.workspacePath,
    runtimeConfig: params.runtimeConfig,
    projectPath: params.projectPath,
    projectName: params.projectName,
    projects: params.projects,
  });

  const taskBaseCommitShaByProjectPath: Record<string, string> = {};
  for (const projectRepo of projectRepos) {
    const taskBaseCommitSha = await tryReadGitHeadCommitSha(params.runtime, projectRepo.repoCwd);
    if (taskBaseCommitSha) {
      taskBaseCommitShaByProjectPath[projectRepo.projectPath] = taskBaseCommitSha;
    }
  }

  return taskBaseCommitShaByProjectPath;
}

export class ForegroundWaitBackgroundedError extends Error {
  constructor() {
    super("Foreground wait sent to background due to queued message");
    this.name = "ForegroundWaitBackgroundedError";
  }
}

function buildWorkflowTimeoutFinalizationPrompt(
  finalInstructions: string | undefined,
  completionKind: "final_response" | "propose_plan",
  requiresStructuredOutput: boolean
): string {
  const reportNoun = completionKind === "propose_plan" ? "plan" : "response";
  const base =
    `Your workflow step time budget has expired. Stop starting new work and prepare a final ${reportNoun} now.\n\n` +
    `In your ${reportNoun}:\n` +
    "- summarize work completed;\n" +
    "- list files changed or inspected;\n" +
    "- include validation/test results already obtained;\n" +
    "- call out uncertainty and remaining work;\n" +
    `- do not run additional long-running tools unless absolutely necessary to write the ${reportNoun}.\n\n` +
    getTaskCompletionInstruction({ completionKind, requiresStructuredOutput });
  if (finalInstructions == null) {
    return base;
  }
  return `${base}\n\nAdditional workflow-specific finalization instructions:\n${finalInstructions}`;
}

export class TaskService implements AgentTaskIntegration {
  // Serialize stream-end processing per workspace to avoid races when
  // finalizing reported tasks and cleanup state transitions.
  private readonly workspaceEventLocks = new MutexMap<string>();
  // Separate parent-scoped lock for deferred best-of fallback/finalization. This path can run
  // concurrently from multiple child stream-end handlers for the same parent, and it must remain
  // safe even when the parent stream-end already holds workspaceEventLocks for the parent itself.
  private readonly deferredBestOfLocks = new MutexMap<string>();
  // Serialize lifecycle transitions across a whole parent/descendant tree so reawakening and
  // removal cannot cross and delete a child while its next execution starts.
  private readonly workspaceTreeLifecycleLocks = new MutexMap<string>();
  private readonly mutex = new AsyncMutex();
  private maybeStartQueuedTasksInFlight: Promise<void> | undefined;
  private maybeStartQueuedTasksRerunRequested = false;
  // Git worktree creation touches per-repository metadata; serialize that narrow phase per project
  // while allowing post-fork init/send startup work for sibling tasks to overlap.
  private readonly reservedTaskLaunchByProjectPath = new Map<string, Promise<void>>();
  // In-flight durable persistence of notify_on_terminal policy for backgrounded foreground waits.
  // Awaited at the start of handleStreamEnd so a just-detached wait is treated as non-blocking.
  private readonly pendingNotifyOnTerminalPersists = new Set<Promise<void>>();
  // In-flight terminal attention drains (workspace-turn / sub-agent terminal wake-ups). Tracked so
  // tests and shutdown can await them; drains are idempotent and re-triggered on owner idle events.
  private readonly pendingTerminalAttentionDrainsByOwner = new Map<string, Promise<void>>();
  private readonly pendingTerminalAttentionDrains = new Set<Promise<void>>();
  // Terminal settlements of the same run must not overlap: settlement is multi-step (stable
  // refresh, generation marker, post-write mismatch delete), so an older generation reaching
  // its mismatch delete after a newer settlement's stable refresh would remove the newer
  // generation's valid marker and let a downgraded build re-deliver a consumed result.
  private readonly workflowRunSettlementByRun = new Map<string, Promise<void>>();
  // Owed workflow terminal wakes (owner -> runIds believed terminal and not yet settled). An
  // in-memory work queue over durable state, not a delivery record: entries are (re)derived
  // from run records + settled markers at startup and on the periodic sweep and added by live
  // terminal callbacks, so losing the map merely delays a wake until the next sweep.
  private readonly pendingWorkflowRunAttention = new Map<string, Set<string>>();
  // Owner -> wake-group key -> epoch ms before which the drain skips selecting the group. A
  // group whose send was rejected for group-specific reasons (for example an unresolvable
  // strictly pinned agent) would otherwise be re-selected newest-first by every drain and
  // sweep, starving older deliverable groups. In-memory only: a restart retries every group,
  // and entries expire on read.
  private readonly workflowWakeGroupSendBackoffUntilMs = new Map<string, Map<string, number>>();
  private workflowAttentionSweepTimer: ReturnType<typeof setInterval> | null = null;
  private readonly pendingWaitersByTaskId = new Map<string, PendingTaskWaiter[]>();
  private readonly pendingStartWaitersByTaskId = new Map<string, PendingTaskStartWaiter[]>();
  // Tracks workspaces currently blocked in a foreground wait (e.g. a task tool call awaiting
  // agent_report). Used to avoid scheduler deadlocks when maxParallelAgentTasks is low and tasks
  // spawn nested tasks in the foreground.
  private readonly foregroundAwaitCountByWorkspaceId = new Map<string, number>();
  private readonly backgroundableForegroundWaitersByWorkspaceId = new Map<
    string,
    Set<BackgroundableForegroundWaiter>
  >();

  private readonly terminalAttentionStore: TerminalAttentionStore;
  private readonly userBackgroundedTaskIds = new Set<string>();

  // Cache completed reports so callers can retrieve them without re-reading disk.
  // Bounded by max entries; disk persistence is the source of truth for restart-safety.
  private readonly completedReportsByTaskId = new Map<string, CompletedAgentReportCacheEntry>();

  // Task workspace removals that outlived their termination timeout. Retries must
  // await the ORIGINAL removal outcome: the host's remove() short-circuits Ok
  // for IDs already being removed, so re-calling it would count a still-in-flight
  // (possibly failing) removal as success and let ancestor deletion orphan the child.
  private readonly pendingTaskWorkspaceRemovals = new Map<string, Promise<Result<void>>>();
  private readonly gitPatchArtifactService: GitPatchArtifactService;
  private timelineRecorder: TimelineRecorder = NOOP_TIMELINE_RECORDER;
  private readonly handoffInProgress = new Set<string>();
  /**
   * Hard-interrupted parent workspaces must not auto-resume until the next user message.
   * This closes races where descendants could report between parent interrupt and cascade cleanup.
   */
  private interruptedParentWorkspaceIds = new Set<string>();
  /**
   * Monotonic per-workspace stop generation, bumped synchronously at every explicit stop
   * boundary (user Stop suppression, task_stop interruption, workspace-turn interruption).
   * Peer-send admission captures its endpoints' generations and refuses when any changed:
   * unlike the level-triggered suppression set and persisted statuses — which a quick user
   * resume clears between probe evaluations — a bump latches, so an intervening stop keeps
   * the in-flight send stale forever.
   */
  private readonly workspaceStopEpochs = new Map<string, number>();
  /**
   * Level-triggered stop latches: workspace IDs whose stop cascade is currently between its
   * synchronous epoch bump and terminal status persistence. The epoch map alone cannot refuse
   * a send that ENTERS during that window — the post-bump generation becomes the send's clean
   * baseline while the endpoints' persisted statuses still read running — so peer-send
   * admission also rejects any endpoint chain holding an in-progress stop latch. Refcounted:
   * overlapping stops (a subtree stop racing a workspace-turn interrupt on the same workspace)
   * must not clear each other's latch.
   */
  private readonly workspaceStopsInProgress = new Map<string, number>();
  /** Stop latches retained past their cascade because the stop could not be confirmed; released on authoritative terminal settlement. */
  private readonly retainedStopLatchReleasesByWorkspaceId = new Map<string, Array<() => void>>();
  /** Tracks consecutive auto-resumes per workspace. Reset when a user message is sent. */
  private consecutiveAutoResumes = new Map<string, number>();

  private async findLatestWorkflowSupersession(workspaceId: string): Promise<{
    found: boolean;
    timestamp?: number;
  }> {
    assert(workspaceId.length > 0, "findLatestWorkflowSupersession requires workspaceId");
    let latest: { found: boolean; timestamp?: number } = { found: false };
    const historyResult = await this.historyService.iterateFullHistory(
      workspaceId,
      "backward",
      (messages) => {
        for (const message of messages) {
          if (!isWorkflowSupersessionMessage(message)) {
            continue;
          }
          const timestamp = message.metadata?.timestamp;
          latest = {
            found: true,
            ...(typeof timestamp === "number" ? { timestamp } : {}),
          };
          return false;
        }
        return undefined;
      }
    );

    if (!historyResult.success) {
      log.warn("Failed to read full history for workflow supersession", {
        workspaceId,
        error: historyResult.error,
      });
    }
    return latest;
  }

  async listAgentReferencedWorkflowRunIds(
    workspaceId: string,
    currentParts: readonly unknown[],
    currentMessageId?: string
  ): Promise<string[]> {
    assert(workspaceId.length > 0, "listAgentReferencedWorkflowRunIds requires workspaceId");

    const latestSupersession = await this.findLatestWorkflowSupersession(workspaceId);
    const historyResult = await this.historyService.getHistoryFromLatestBoundary(workspaceId);
    let historyMessages: MuxMessage[] = [];
    let historyScanStartIndex = 0;
    let trustCurrentParts = true;
    if (historyResult.success) {
      historyMessages = historyResult.data;
      const latestSupersessionIndex = historyMessages.findLastIndex(isWorkflowSupersessionMessage);
      if (latestSupersessionIndex !== -1) {
        historyScanStartIndex = latestSupersessionIndex + 1;
        const currentMessageIndex =
          currentMessageId == null
            ? -1
            : historyMessages.findIndex((message) => message.id === currentMessageId);
        if (currentMessageIndex !== -1 && currentMessageIndex < latestSupersessionIndex) {
          trustCurrentParts = false;
        }
      }
    } else {
      log.warn("Failed to read history for workflow run references", {
        workspaceId,
        error: historyResult.error,
      });
    }

    const runIds = new Set<string>();
    let references: Awaited<ReturnType<typeof readAgentWorkflowRunReferences>> = [];
    try {
      references = await readAgentWorkflowRunReferences(
        path.join(this.config.sessionsDir, workspaceId)
      );
    } catch (error: unknown) {
      // Rediscovery is non-destructive and re-runs on the next listing; skip this pass.
      log.warn("Failed to read agent workflow run references", { workspaceId, error });
    }
    for (const reference of references) {
      // If the latest user/reset supersession has no durable timestamp, fail safe: only trust
      // workflow provenance re-established by current/post-supersession assistant output below.
      if (latestSupersession.found && latestSupersession.timestamp === undefined) {
        continue;
      }
      if (
        latestSupersession.timestamp !== undefined &&
        reference.createdAtMs <= latestSupersession.timestamp
      ) {
        continue;
      }
      runIds.add(reference.runId);
    }

    if (trustCurrentParts) {
      for (const runId of collectAgentReferencedWorkflowRunIdsFromParts(currentParts, runIds)) {
        runIds.add(runId);
      }
    }

    for (const message of historyMessages.slice(historyScanStartIndex)) {
      if (message.role !== "assistant" || isWorkflowDisplayOnlyMessage(message)) {
        continue;
      }
      for (const runId of collectAgentReferencedWorkflowRunIdsFromParts(message.parts, runIds)) {
        runIds.add(runId);
      }
    }

    return Array.from(runIds);
  }

  async listActiveBackgroundWorkflowRunIds(
    workspaceId: string,
    referencedWorkflowRunIds: readonly string[]
  ): Promise<string[]> {
    assert(workspaceId.length > 0, "listActiveBackgroundWorkflowRunIds requires workspaceId");
    if (referencedWorkflowRunIds.length === 0) {
      return [];
    }

    try {
      const referencedRunIdSet = new Set(referencedWorkflowRunIds);
      const runStore = new WorkflowRunStore({
        sessionDir: path.join(this.config.sessionsDir, workspaceId),
      });
      const runs = await runStore.listRuns();
      return runs
        .filter(
          (run) =>
            referencedRunIdSet.has(run.id) &&
            run.workspaceId === workspaceId &&
            isActiveWorkflowRunStatus(run.status)
        )
        .map((run) => run.id);
    } catch (error: unknown) {
      // Workflow state should never make stream-end cleanup fail; task_await can still discover
      // runs on a later turn once storage is readable again.
      log.warn("Failed to list active background workflow runs", {
        workspaceId,
        error: getErrorMessage(error),
      });
      return [];
    }
  }

  private async listBlockingBackgroundWorkflowRunIds(
    workspaceId: string,
    referencedWorkflowRunIds: readonly string[],
    currentParts: readonly unknown[]
  ): Promise<string[]> {
    assert(workspaceId.length > 0, "listBlockingBackgroundWorkflowRunIds requires workspaceId");
    if (referencedWorkflowRunIds.length === 0) {
      return [];
    }

    try {
      const referencedRunIdSet = new Set(referencedWorkflowRunIds);
      const runStore = new WorkflowRunStore({
        sessionDir: path.join(this.config.sessionsDir, workspaceId),
      });
      const runs = await runStore.listRuns();
      const blockingRunIds: string[] = [];
      for (const run of runs) {
        if (!referencedRunIdSet.has(run.id) || run.workspaceId !== workspaceId) {
          continue;
        }
        if (resolveBackgroundWorkAttentionPolicy(run.attentionPolicy) === "notify_on_terminal") {
          continue;
        }
        if (isActiveWorkflowRunStatus(run.status)) {
          blockingRunIds.push(run.id);
          continue;
        }
        if (!isTerminalWorkflowRunStatus(run.status)) {
          continue;
        }
        // A foreground workflow_run/workflow_resume terminal result is already visible to this
        // turn, so requiring a second task_await would be redundant (and impossible for agents
        // whose read-only policy only permits task_await as a recovery tool).
        if (
          hasTerminalWorkflowTaskAwaitInParts(currentParts, run.id) ||
          hasTerminalWorkflowToolOutputInParts(currentParts, run.id)
        ) {
          continue;
        }
        const isCurrent = await this.workspaceService.isWorkflowInvocationCurrent(
          workspaceId,
          run.id
        );
        if (isCurrent) {
          blockingRunIds.push(run.id);
        }
      }
      return blockingRunIds;
    } catch (error: unknown) {
      log.warn("Failed to list blocking background workflow runs", {
        workspaceId,
        error: getErrorMessage(error),
      });
      return [];
    }
  }

  // Workflow abort/interrupt is the source of truth: task-level restart and stream-end
  // recovery must not resurrect a workflow child (or its descendants) once the owning run
  // is no longer active. Manual workflow_resume replays from the workflow journal instead.
  private findWorkflowTaskOwnersInAncestry(
    index: AgentTaskIndex,
    taskId: string
  ): WorkflowTaskOwner[] {
    assert(taskId.length > 0, "findWorkflowTaskOwnersInAncestry requires taskId");
    const owners: WorkflowTaskOwner[] = [];
    let current: string | undefined = taskId;
    for (let depth = 0; current != null; depth += 1) {
      assert(
        depth < 32,
        `findWorkflowTaskOwnersInAncestry: possible parentWorkspaceId cycle starting at ${taskId}`
      );
      const entry = index.byId.get(current);
      if (entry == null) {
        current = index.parentById.get(current);
        continue;
      }
      const workflowTask = entry.workflowTask;
      if (workflowTask != null) {
        owners.push({ taskId: current, workspace: entry, workflowTask });
      }
      current = index.parentById.get(current);
    }
    return owners;
  }

  private findWorkflowTaskOwnerInAncestry(
    index: AgentTaskIndex,
    taskId: string
  ): WorkflowTaskOwner | null {
    return this.findWorkflowTaskOwnersInAncestry(index, taskId)[0] ?? null;
  }

  private async getInactiveWorkflowTaskOwner(
    owner: WorkflowTaskOwner
  ): Promise<InactiveWorkflowTaskOwner | null> {
    const workflowTask = owner.workflowTask;
    const parentWorkspaceId = coerceNonEmptyString(owner.workspace.parentWorkspaceId);
    if (!parentWorkspaceId) {
      return {
        ownerTaskId: owner.taskId,
        runId: workflowTask.runId,
        reason: "workflow-owned task is missing its parent workspace",
      };
    }

    try {
      const runStore = new WorkflowRunStore({
        sessionDir: path.join(this.config.sessionsDir, parentWorkspaceId),
      });
      const run = await runStore.getRun(workflowTask.runId);
      if (run.workspaceId !== parentWorkspaceId) {
        return {
          ownerTaskId: owner.taskId,
          runId: workflowTask.runId,
          status: run.status,
          reason: `workflow run belongs to ${run.workspaceId}, not ${parentWorkspaceId}`,
        };
      }
      if (isActiveWorkflowRunStatus(run.status)) {
        return null;
      }
      return {
        ownerTaskId: owner.taskId,
        runId: workflowTask.runId,
        status: run.status,
        reason: `workflow run is ${run.status}`,
      };
    } catch (error: unknown) {
      return {
        ownerTaskId: owner.taskId,
        runId: workflowTask.runId,
        reason: `workflow run is unavailable: ${getErrorMessage(error)}`,
      };
    }
  }

  private async getInactiveWorkflowTaskOwnerForRecovery(
    taskId: string,
    config: ProjectsConfig,
    index?: AgentTaskIndex
  ): Promise<InactiveWorkflowTaskOwner | null> {
    assert(taskId.length > 0, "getInactiveWorkflowTaskOwnerForRecovery requires taskId");
    const owners = this.findWorkflowTaskOwnersInAncestry(
      index ?? this.buildAgentTaskIndex(config),
      taskId
    );
    for (const owner of owners) {
      const inactiveOwner = await this.getInactiveWorkflowTaskOwner(owner);
      if (inactiveOwner != null) {
        return inactiveOwner;
      }
    }
    return null;
  }

  bumpWorkspaceStopEpoch(workspaceId: string): void {
    this.workspaceStopEpochs.set(workspaceId, (this.workspaceStopEpochs.get(workspaceId) ?? 0) + 1);
  }

  private getWorkspaceStopEpoch(workspaceId: string): number {
    return this.workspaceStopEpochs.get(workspaceId) ?? 0;
  }

  /**
   * Hold a stop-in-progress latch for the given workspaces until the returned release runs.
   * Callers latch synchronously with the epoch bump and release only after the cascade has
   * persisted terminal state, so sends entering mid-stop are refused at admission.
   */
  latchWorkspaceStopsInProgress(workspaceIds: readonly string[]): () => void {
    for (const id of workspaceIds) {
      this.workspaceStopsInProgress.set(id, (this.workspaceStopsInProgress.get(id) ?? 0) + 1);
    }
    return () => {
      for (const id of workspaceIds) {
        const count = this.workspaceStopsInProgress.get(id) ?? 0;
        if (count <= 1) {
          this.workspaceStopsInProgress.delete(id);
        } else {
          this.workspaceStopsInProgress.set(id, count - 1);
        }
      }
    };
  }

  private isWorkspaceStopInProgress(workspaceId: string): boolean {
    return this.workspaceStopsInProgress.has(workspaceId);
  }

  /**
   * Park a stop latch whose owning cascade could not confirm the workspace's stop (failed
   * stream cancellation or failed status persistence). The latch keeps refusing peer-message
   * admission, but unlike an unconditionally discarded release it stays releasable: authoritative
   * terminal settlement (releaseRetainedStopLatches) frees the workspace again instead of locking
   * it out of peer messaging until restart.
   */
  private retainStopLatchUntilSettlement(workspaceId: string, release: () => void): void {
    const releases = this.retainedStopLatchReleasesByWorkspaceId.get(workspaceId) ?? [];
    releases.push(release);
    this.retainedStopLatchReleasesByWorkspaceId.set(workspaceId, releases);
  }

  /**
   * Release latches parked by retainStopLatchUntilSettlement. Call ONLY on admission-visible
   * settlement evidence for the workspace: a persisted terminal (or cleared) execution mirror,
   * or a persisted interrupted task status — either refuses peer sends on its own, so the latch
   * is no longer the last line of defense. Each closure is removed before invocation because the
   * underlying releases are plain refcount decrements, not idempotent.
   */
  releaseRetainedStopLatches(workspaceId: string): void {
    const releases = this.retainedStopLatchReleasesByWorkspaceId.get(workspaceId);
    if (releases == null) return;
    this.retainedStopLatchReleasesByWorkspaceId.delete(workspaceId);
    for (const release of releases) {
      release();
    }
  }

  /**
   * True when persisted evidence alone already refuses this workspace's peer sends, making a
   * retained stop latch redundant: the workspace is missing, or its stable status is terminal
   * with no live accepted running execution to rescue it. Active stable statuses return false —
   * for a running child only the latch refuses, so it must be retained. Used to close the
   * park-after-settlement race: settlement persists its terminal mirror BEFORE releasing
   * retained latches, so a recheck that still sees a live execution is ordered before the
   * settlement's release, which will then find the freshly parked latch.
   */
  private isStopSettledForAdmission(workspaceId: string): boolean {
    const entry = findWorkspaceEntry(this.config.loadConfigOrDefault(), workspaceId);
    if (entry == null) return true;
    const workspace = entry.workspace;
    if (ACTIVE_AGENT_TASK_STATUSES.has(workspace.taskStatus ?? "running")) return false;
    // Mirror of the peer relation leg's hasLiveRunningExecution: terminal-status senders are
    // admitted only through a running mirror backed by a matching ACCEPTED live registration.
    const live = this.getWorkspaceTurnManager().getLiveWorkspaceTurnRegistration(workspaceId);
    const liveRunningExecution =
      workspace.taskExecutionStatus === "running" &&
      workspace.taskExecutionId != null &&
      live != null &&
      live.handleId === workspace.taskExecutionId &&
      live.accepted;
    return !liveRunningExecution;
  }

  private recordTaskInterrupted(taskId: string, parentWorkspaceId: string | undefined): void {
    // Latch the stop for in-flight peer-send admission even when there is no parent to notify.
    this.bumpWorkspaceStopEpoch(taskId);
    if (!parentWorkspaceId) {
      return;
    }
    // Every interrupted transition lands here right after the status commit. The child's queued
    // incremental updates are superseded now: left in place as tool-end entries they would still
    // cut the parent's active turn at its next step boundary before their admission probe refuses
    // them. (A continuation owned by a different ancestor is cleaned by its settlement instead.)
    const queuedProgressRemoval = this.workspaceService.removeQueuedMessagesByDedupeKeyPrefix(
      parentWorkspaceId,
      agentReportProgressDedupePrefix(taskId),
      { cancelReason: AGENT_REPORT_PROGRESS_SUPERSEDED_REASON, skipCancelCallbacks: true }
    );
    if (!queuedProgressRemoval.success) {
      log.warn("Failed to remove queued incremental sub-agent reports after interrupt", {
        parentWorkspaceId,
        childWorkspaceId: taskId,
        error: queuedProgressRemoval.error,
      });
    }
    this.timelineRecorder.record(parentWorkspaceId, {
      kind: "task.interrupted",
      source: { system: "task" },
      status: "interrupted",
      anchor: { taskId, childWorkspaceId: taskId },
    });
  }

  private applyInterruptedTaskStatus(
    workspace: WorkspaceConfigEntry
  ): InterruptedTaskStatusMutation {
    if (hasCompletedAgentReport(workspace)) {
      // Preserve completed report evidence so already-finished tasks stay inspectable
      // and collapse-eligible after a later interrupt/recovery pass.
      return "preserved-completed-report";
    }

    const previousStatus = workspace.taskStatus;
    const persistedQueuedPrompt = coerceNonEmptyString(workspace.taskPrompt);
    workspace.taskStatus = "interrupted";
    workspace.reportedAt = undefined;

    // Queued tasks persist their initial prompt in config until first start. Preserve that
    // intent across interrupts, including repeated interrupts after the status is no longer queued.
    if (previousStatus !== "queued" && !persistedQueuedPrompt) {
      workspace.taskPrompt = undefined;
    }
    return "interrupted";
  }

  private async interruptTaskRecoveryForInactiveWorkflowOwner(
    taskId: string,
    config: ProjectsConfig,
    trigger: string,
    index?: AgentTaskIndex,
    options?: { scheduleQueueDrain?: boolean }
  ): Promise<boolean> {
    assert(taskId.length > 0, "interruptTaskRecoveryForInactiveWorkflowOwner requires taskId");
    assert(trigger.length > 0, "interruptTaskRecoveryForInactiveWorkflowOwner requires trigger");
    const inactiveOwner = await this.getInactiveWorkflowTaskOwnerForRecovery(taskId, config, index);
    if (inactiveOwner == null) {
      return false;
    }

    let interrupted = false;
    let transitionedToInterrupted = false;
    let parentWorkspaceId: string | undefined;
    await this.editWorkspaceEntry(
      taskId,
      (ws) => {
        const previousStatus = ws.taskStatus;
        parentWorkspaceId = ws.parentWorkspaceId;
        interrupted = this.applyInterruptedTaskStatus(ws) === "interrupted";
        transitionedToInterrupted = interrupted && previousStatus !== "interrupted";
      },
      { allowMissing: true }
    );
    if (transitionedToInterrupted) {
      this.recordTaskInterrupted(taskId, parentWorkspaceId);
    }

    log.debug("Skipping workflow-owned task recovery after inactive workflow owner", {
      taskId,
      trigger,
      ownerTaskId: inactiveOwner.ownerTaskId,
      workflowRunId: inactiveOwner.runId,
      workflowRunStatus: inactiveOwner.status,
      reason: inactiveOwner.reason,
    });
    if (interrupted) {
      this.rejectWaiters(taskId, new Error("Task interrupted"));
      await this.emitWorkspaceMetadata(taskId);
      if (options?.scheduleQueueDrain !== false) {
        this.scheduleMaybeStartQueuedTasks();
      }
    }
    return true;
  }

  private markTaskQueueBackgrounded(taskId: string): void {
    this.userBackgroundedTaskIds.add(taskId);
  }

  markTaskForegroundRelevant(taskId: string): void {
    this.userBackgroundedTaskIds.delete(taskId);
  }

  private isTaskQueueBackgrounded(taskId: string): boolean {
    return this.userBackgroundedTaskIds.has(taskId);
  }

  /**
   * Resolve the persisted attention policy for a child agent-task workspace.
   * Missing/legacy records default to `blocking_until_terminal`.
   */
  private resolveAgentTaskAttentionPolicy(
    taskId: string,
    index: AgentTaskIndex
  ): BackgroundWorkAttentionPolicy {
    return resolveBackgroundWorkAttentionPolicy(index.byId.get(taskId)?.taskAttentionPolicy);
  }

  private readonly agentPeerMessageBroker: AgentPeerMessageBroker;
  private workspaceTurnManager: WorkspaceTurnManager | undefined;

  constructor(
    private readonly config: Config,
    private readonly historyService: HistoryService,
    private readonly aiService: AIService,
    private readonly workspaceService: WorkspaceHost,
    private readonly initStateManager: InitStateManager,
    private readonly sessionUsageService?: SessionUsageService,
    private readonly workspaceGoalService?: WorkspaceGoalService,
    private readonly secretsStore: SecretsStore = new SecretsStore(config.rootDir),
    terminalAttentionStore?: TerminalAttentionStore,
    private readonly desktopInputCoordinator = new DesktopInputCoordinator(config)
  ) {
    this.agentPeerMessageBroker = new AgentPeerMessageBroker(workspaceService);
    this.terminalAttentionStore = terminalAttentionStore ?? new TerminalAttentionStore(config);
    this.gitPatchArtifactService = new GitPatchArtifactService(config);

    this.aiService.on("stream-end", (payload: unknown) => {
      if (!isStreamEndEvent(payload)) return;

      // Captured synchronously at event time, BEFORE the workspace event lock:
      // another operation holding the lock would otherwise let the session
      // drain the real (manual/cross-owner) cutter and engage a later
      // same-owner follow-up during the wait, misattributing the cut and
      // wrongly suppressing the real cutter's wake (see
      // QueueCutAttributionSnapshot).
      const queueCutSnapshot = this.getWorkspaceTurnManager().captureQueueCutAttributionSnapshot(
        payload.workspaceId
      );
      void this.workspaceEventLocks
        .withLock(payload.workspaceId, async () => {
          await this.handleStreamEnd(payload, queueCutSnapshot);
        })
        .catch((error: unknown) => {
          log.error("TaskService.handleStreamEnd failed", { error });
        });
    });

    this.aiService.on("stream-abort", (payload: unknown) => {
      if (!isStreamAbortEvent(payload)) return;

      void this.workspaceEventLocks
        .withLock(payload.workspaceId, async () => {
          await this.handleStreamAbort(payload);
        })
        .catch((error: unknown) => {
          log.error("TaskService.handleStreamAbort failed", { error });
        });
    });

    this.aiService.on("error", (payload: unknown) => {
      if (!isErrorEvent(payload)) return;

      void this.workspaceEventLocks
        .withLock(payload.workspaceId, async () => {
          await this.handleTaskStreamError(payload);
        })
        .catch((error: unknown) => {
          log.error("TaskService.handleTaskStreamError failed", { error });
        });
    });
  }

  setWorkspaceTurnManager(manager: WorkspaceTurnManager): void {
    this.workspaceTurnManager = manager;
  }

  private getWorkspaceTurnManager(): WorkspaceTurnManager {
    assert(this.workspaceTurnManager, "WorkspaceTurnManager is not configured");
    return this.workspaceTurnManager;
  }

  async acquireTaskCreationLock(): Promise<AsyncDisposable> {
    return await this.mutex.acquire();
  }

  setTimelineRecorder(recorder: TimelineRecorder): void {
    this.timelineRecorder = recorder;
  }

  // Prefer per-agent settings so tasks inherit the correct agent defaults;
  // fall back to legacy workspace settings for older configs.
  resolveWorkspaceAISettings(
    workspace: {
      aiSettingsByAgent?: Record<string, ResolvedWorkspaceAiSettings>;
      aiSettings?: ResolvedWorkspaceAiSettings;
    },
    agentId: string | undefined
  ): ResolvedWorkspaceAiSettings | undefined {
    const normalizedAgentId =
      typeof agentId === "string" && agentId.trim().length > 0
        ? normalizeAgentId(agentId, "")
        : undefined;
    return (
      (normalizedAgentId ? workspace.aiSettingsByAgent?.[normalizedAgentId] : undefined) ??
      workspace.aiSettings
    );
  }

  /**
   * Parent-workspace fallback layers (unified precedence tier 7) for a spawned
   * task: the parent's bucket for the TARGET agent, then the parent's ACTIVE
   * agent bucket (the user toggles settings on the active agent, so the target
   * bucket rarely exists), then legacy workspace settings.
   */
  buildParentAiSettingsFallbacks(
    parentMeta: TaskParentAiMeta,
    targetAgentId: string
  ): AgentAiSettingsLayerValues[] {
    const layers: AgentAiSettingsLayerValues[] = [];
    const push = (settings: ResolvedWorkspaceAiSettings | undefined) => {
      if (!settings) return;
      layers.push({
        model: settings.model,
        thinkingLevel: coerceThinkingLevel(settings.thinkingLevel),
        reasoningMode: coerceOpenAIReasoningMode(settings.reasoningMode),
      });
    };
    const normalizedTarget = normalizeAgentId(targetAgentId, "");
    push(normalizedTarget ? parentMeta.aiSettingsByAgent?.[normalizedTarget] : undefined);
    push(parentMeta.aiSettingsByAgent?.[normalizeAgentId(parentMeta.agentId)]);
    push(parentMeta.aiSettings);
    return layers;
  }

  /**
   * Delegated-run AI settings for a spawned task via the unified resolver
   * (profile "subagent"). Persistence and send options use selected values so
   * a pro preference survives temporarily non-pro models (the send path
   * re-gates per model/route); thinking uses the effective clamped level.
   * Model normalization stays gateway-preserving (see resolveAgentAiSettings):
   * the value is persisted into child workspace aiSettings and drives queued
   * follow-ups and plan->exec continuations.
   *
   * Throws InvalidExplicitAiSettingError for an invalid explicit model; call
   * sites convert it to their Err surface instead of silently running a
   * fallback model.
   */
  private async resolveTaskAISettings(params: {
    cfg: ReturnType<Config["loadConfigOrDefault"]>;
    parentWorkspaceId: string;
    parentMeta: TaskParentAiMeta;
    agentId: string;
    modelString?: string;
    thinkingLevel?: ParsedThinkingInput;
    parentRuntimeAiSettings?: { modelString?: string; thinkingLevel?: ThinkingLevel };
    /** Checkout for definition/base-chain tiers; omit to use the implicit fallback chain. */
    definitionContext?: NodeAgentDefinitionContext;
  }): Promise<{
    taskModelString: string;
    canonicalModel: string;
    effectiveThinkingLevel: ThinkingLevel;
    effectiveReasoningMode?: OpenAIReasoningMode;
  }> {
    // Display metadata synthesizes Exec/Plan buckets from legacy aiSettings.
    // Only raw persisted Exec choices may outrank global Exec defaults.
    const parent = findWorkspaceEntry(params.cfg, params.parentWorkspaceId)?.workspace;
    const parentWorkspaceExecSettings =
      parent?.aiSettingsByAgent?.exec ??
      (normalizeAgentId(parent?.agentId ?? parent?.agentType, "") === "exec"
        ? parent?.aiSettings
        : undefined);
    const resolved = await resolveNodeAgentAiSettings({
      agentId: params.agentId,
      profile: "subagent",
      cfg: params.cfg,
      providersConfig: this.aiService.getProvidersConfig(),
      explicit: {
        model: coerceNonEmptyString(params.modelString) ?? undefined,
        thinkingLevel: params.thinkingLevel ?? undefined,
      },
      // A saved workspace's omitted reasoning mode means Standard, not inheritance.
      parentWorkspaceExecSettings: parentWorkspaceExecSettings
        ? targetWorkspaceBucketToLayer(parentWorkspaceExecSettings)
        : undefined,
      parentRuntime: params.parentRuntimeAiSettings
        ? {
            model: coerceNonEmptyString(params.parentRuntimeAiSettings.modelString) ?? undefined,
            thinkingLevel: params.parentRuntimeAiSettings.thinkingLevel,
          }
        : undefined,
      fallbacks: this.buildParentAiSettingsFallbacks(params.parentMeta, params.agentId),
      definitionContext: params.definitionContext,
    });

    return {
      taskModelString: resolved.selected.model,
      canonicalModel: resolved.effective.model,
      effectiveThinkingLevel: resolved.effective.thinkingLevel,
      ...(resolved.selected.reasoningMode != null
        ? { effectiveReasoningMode: resolved.selected.reasoningMode }
        : {}),
    };
  }

  /**
   * Derives auto-resume send options (agentId, model, thinkingLevel) from durable
   * conversation metadata, so synthetic resumes preserve the parent's active agent.
   *
   * Precedence: stream-end event metadata → last non-compaction assistant message in history → workspace AI settings → defaults.
   */
  private async resolveParentAutoResumeOptions(
    parentWorkspaceId: string,
    parentEntry: {
      workspace: {
        aiSettingsByAgent?: Record<string, ResolvedWorkspaceAiSettings>;
        aiSettings?: ResolvedWorkspaceAiSettings;
      };
    },
    fallbackModel: string,
    hint?: ParentAutoResumeHint
  ): Promise<{
    model: string;
    agentId: string;
    thinkingLevel?: ThinkingLevel;
    reasoningMode?: OpenAIReasoningMode;
  }> {
    // 1) Try stream-end hint metadata (available in handleStreamEnd path)
    // Compaction is internal bookkeeping, not an identity for resuming user work.
    let agentId = hint?.agentId === "compact" ? undefined : hint?.agentId;

    // Durable history preserves the parent identity across process restarts. The walk is
    // unbounded: synthetic rows without an agent identity (drain-appended sub-agent reports,
    // heartbeat scaffolding) can push the newest agent-bearing assistant row past any fixed
    // tail, and a truncated read would silently recompose terminal-wake sends from the exec
    // fallback, lifting a restricted agent's tool policy.
    if (!agentId) {
      const found: { agentId?: string } = {};
      await this.historyService.iterateFullHistory(parentWorkspaceId, "backward", (messages) => {
        for (const msg of messages) {
          if (
            msg.role === "assistant" &&
            typeof msg.metadata?.agentId === "string" &&
            msg.metadata.agentId.length > 0 &&
            msg.metadata.agentId !== "compact"
          ) {
            found.agentId = msg.metadata.agentId;
            return false;
          }
        }
        return undefined;
      });
      // A failed read falls through to defaults (best-effort); the terminal drain separately
      // fails closed on unreadable history via resolveTerminalWakeCallerSendRestrictions.
      agentId = found.agentId;
    }

    // 3) Default
    // Keep task auto-resume recovery on exec even if the workspace default agent changes.
    // This path needs a deterministic editing-capable fallback for legacy/incomplete metadata.
    agentId = agentId ?? TASK_RECOVERY_FALLBACK_AGENT_ID;

    // Unified interactive resolution: the workspace's own bucket owns the
    // settings; configured agent defaults and the legacy workspace settings
    // fill unset fields. Reasoning passes through selected (un-gated); the
    // send path re-gates per model/route so pro is inert for unsupported models.
    const workspace = parentEntry.workspace;
    const normalizedAgentId = normalizeAgentId(agentId, "");
    const bucket = normalizedAgentId ? workspace.aiSettingsByAgent?.[normalizedAgentId] : undefined;
    const resolved = await resolveNodeAgentAiSettings({
      agentId,
      profile: "interactive",
      cfg: this.config.loadConfigOrDefault(),
      providersConfig: this.aiService.getProvidersConfig(),
      targetWorkspaceSettings: bucket ? targetWorkspaceBucketToLayer(bucket) : undefined,
      fallbacks: workspace.aiSettings
        ? [
            {
              model: workspace.aiSettings.model,
              thinkingLevel: workspace.aiSettings.thinkingLevel,
              reasoningMode: coerceOpenAIReasoningMode(workspace.aiSettings.reasoningMode),
            },
          ]
        : undefined,
      defaultModel: fallbackModel,
    });
    return {
      model: resolved.selected.model,
      agentId,
      thinkingLevel: resolved.selected.thinkingLevel,
      ...(resolved.selected.reasoningMode != null
        ? { reasoningMode: resolved.selected.reasoningMode }
        : {}),
    };
  }

  private async isPlanLikeTaskWorkspace(entry: {
    projectPath: string;
    workspace: Pick<
      WorkspaceConfigEntry,
      "id" | "name" | "path" | "runtimeConfig" | "agentId" | "agentType" | "parentWorkspaceId"
    >;
  }): Promise<boolean> {
    assert(entry.projectPath.length > 0, "isPlanLikeTaskWorkspace: projectPath must be non-empty");

    const agentIdCandidates = resolvePersistedAgentIdCandidates(entry.workspace);
    if (agentIdCandidates.length === 0) {
      return false;
    }

    const workspacePath = coerceNonEmptyString(entry.workspace.path);
    const workspaceName = coerceNonEmptyString(entry.workspace.name) ?? entry.workspace.id;
    const runtimeConfig = entry.workspace.runtimeConfig ?? DEFAULT_RUNTIME_CONFIG;
    if (!workspacePath || !workspaceName) {
      return agentIdCandidates.includes("plan");
    }

    const cfg = this.config.loadConfigOrDefault();
    const runtime = createRuntimeForWorkspace({
      runtimeConfig,
      projectPath: entry.projectPath,
      name: workspaceName,
    });
    const agentDiscoveryCandidates: Array<{ runtime: Runtime; workspacePath: string }> = [
      { runtime, workspacePath },
    ];

    const parentEntry = entry.workspace.parentWorkspaceId
      ? findWorkspaceEntry(cfg, entry.workspace.parentWorkspaceId)
      : null;
    const parentWorkspaceName = coerceNonEmptyString(parentEntry?.workspace.name);
    if (parentEntry != null && parentWorkspaceName != null) {
      try {
        agentDiscoveryCandidates.push(
          createRuntimeContextForWorkspace({
            runtimeConfig: parentEntry.workspace.runtimeConfig ?? runtimeConfig,
            projectPath: parentEntry.projectPath,
            name: parentWorkspaceName,
            namedWorkspacePath: coerceNonEmptyString(parentEntry.workspace.path),
          })
        );
      } catch (error: unknown) {
        log.debug("Failed to build parent task agent-discovery runtime", {
          workspaceId: entry.workspace.id,
          parentWorkspaceId: entry.workspace.parentWorkspaceId,
          error: error instanceof Error ? error.message : String(error),
        });
      }
    }

    for (const agentId of agentIdCandidates) {
      let fallbackChain: Awaited<ReturnType<typeof resolveAgentInheritanceChain>> | undefined;
      let fallbackAgentId: string | undefined;
      for (const discovery of agentDiscoveryCandidates) {
        try {
          const agentDefinition = await readAgentDefinition(
            discovery.runtime,
            discovery.workspacePath,
            agentId
          );
          const chain = await resolveAgentInheritanceChain({
            runtime: discovery.runtime,
            workspacePath: discovery.workspacePath,
            agentId: agentDefinition.id,
            agentDefinition,
            workspaceId: entry.workspace.id ?? workspaceName,
          });

          if (agentDefinition.scope === "project") {
            return agentDefinition.id === "compact" ? false : isPlanLikeInResolvedChain(chain);
          }
          fallbackChain ??= chain;
          fallbackAgentId ??= agentDefinition.id;
        } catch (error: unknown) {
          log.debug("Failed to resolve task agent mode from discovery path", {
            workspaceId: entry.workspace.id,
            agentId,
            agentDiscoveryPath: discovery.workspacePath,
            error: error instanceof Error ? error.message : String(error),
          });
        }
      }

      if (fallbackChain != null) {
        if (fallbackAgentId === "compact") {
          return false;
        }
        return isPlanLikeInResolvedChain(fallbackChain);
      }
    }

    return agentIdCandidates.includes("plan");
  }

  async emitWorkspaceMetadata(workspaceId: string): Promise<void> {
    assert(workspaceId.length > 0, "emitWorkspaceMetadata: workspaceId must be non-empty");

    const allMetadata = await this.config.getAllWorkspaceMetadata();
    const metadata = allMetadata.find((m) => m.id === workspaceId) ?? null;
    this.workspaceService.emit("metadata", { workspaceId, metadata });
  }

  private configureMultiProjectRuntimeEnvResolver(runtime: Runtime): void {
    if (!(runtime instanceof MultiProjectRuntime)) {
      return;
    }

    const projectEnvCache = new Map<string, Record<string, string>>();
    runtime.envResolver = async (runtimeProjectPath: string) => {
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
  }

  private taskTreeRootId(workspaceId: string): string {
    const index = this.buildAgentTaskIndex(this.config.loadConfigOrDefault());
    let currentWorkspaceId = workspaceId;
    const visited = new Set<string>();
    for (let depth = 0; depth < 32; depth++) {
      if (visited.has(currentWorkspaceId)) {
        log.warn("Task tree lifecycle lock encountered a parent cycle", { workspaceId });
        return workspaceId;
      }
      visited.add(currentWorkspaceId);
      const parentWorkspaceId = index.parentById.get(currentWorkspaceId);
      if (parentWorkspaceId == null) {
        return currentWorkspaceId;
      }
      currentWorkspaceId = parentWorkspaceId;
    }
    log.warn("Task tree lifecycle lock exceeded parent traversal depth", { workspaceId });
    return workspaceId;
  }

  async withTaskTreeLifecycleLock<T>(workspaceId: string, operation: () => Promise<T>): Promise<T> {
    assert(workspaceId.length > 0, "withTaskTreeLifecycleLock requires workspaceId");
    return await this.withTaskTreeLifecycleLocks([workspaceId], operation);
  }

  withGitPatchArtifactOperationLock<T>(taskId: string, operation: () => Promise<T>): Promise<T> {
    assert(taskId.length > 0, "withGitPatchArtifactOperationLock requires taskId");
    return this.gitPatchArtifactService.withOperationLock(taskId, operation);
  }

  private async withTaskTreeLifecycleLocks<T>(
    workspaceIds: readonly string[],
    operation: () => Promise<T>
  ): Promise<T> {
    const rootIds = [
      ...new Set(workspaceIds.map((workspaceId) => this.taskTreeRootId(workspaceId))),
    ]
      .filter((workspaceId) => workspaceId.length > 0)
      .sort();
    const acquire = async (index: number): Promise<T> => {
      const rootId = rootIds[index];
      if (rootId == null) {
        return await operation();
      }
      return await this.workspaceTreeLifecycleLocks.withLock(rootId, () => acquire(index + 1));
    };
    return await acquire(0);
  }

  async editWorkspaceEntry(
    workspaceId: string,
    updater: (workspace: WorkspaceConfigEntry, config: ProjectsConfig) => void,
    options?: { allowMissing?: boolean }
  ): Promise<boolean> {
    assert(workspaceId.length > 0, "editWorkspaceEntry: workspaceId must be non-empty");

    let found = false;
    await this.config.editConfig((config) => {
      for (const [_projectPath, project] of config.projects) {
        const ws = project.workspaces.find((w) => w.id === workspaceId);
        if (!ws) continue;
        updater(ws, config);
        found = true;
        return config;
      }

      if (options?.allowMissing) {
        return config;
      }

      throw new Error(`editWorkspaceEntry: workspace ${workspaceId} not found`);
    });

    return found;
  }

  /**
   * Restart recovery for agent tasks followed by the startup housekeeping passes. The server
   * entry point runs the two halves separately around its listener bind (see
   * ServiceContainer.initializeCore / runStartupHousekeeping); desktop startup runs them back to back.
   */
  async initialize(): Promise<void> {
    await this.recoverInterruptedTasks();
    await this.runStartupHousekeeping();
  }

  /**
   * Re-establishes the tasks that were active when the process last exited: execution-handle
   * mirrors, stale `starting` tasks, the queue drain, and the restart prompts for
   * `awaiting_report`/`running` tasks. Bounded by the number of active tasks, not by deployment
   * size. Must finish before any client can act on tasks: a stop, resume, or send racing these
   * transitions would be overwritten or would resurrect a task the client just stopped, so the
   * server binds its listener only after this resolves.
   */
  async recoverInterruptedTasks(): Promise<void> {
    const startupStartedAt = Date.now();
    const startupConfig = this.config.loadConfigOrDefault();
    const queuedTaskCountAtStartup = this.listAgentTaskWorkspaces(startupConfig).filter(
      (task) => task.taskStatus === "queued" && typeof task.id === "string"
    ).length;

    log.info("[startup] TaskService.recoverInterruptedTasks starting", {
      queuedTaskCountAtStartup,
    });

    await this.getWorkspaceTurnManager().reconcileAgentTaskExecutionIds();

    const staleStartingTasks = this.listAgentTaskWorkspaces(startupConfig).filter(
      (task) => task.taskStatus === "starting" && typeof task.id === "string"
    );
    if (staleStartingTasks.length > 0) {
      const recoveries = new Map<
        string,
        { status: Extract<AgentTaskStatus, "queued" | "running">; acceptedPrompt: boolean }
      >();
      for (const task of staleStartingTasks) {
        assert(task.id != null && task.id.length > 0, "stale starting task id is required");
        const isStreaming = this.aiService.isStreaming(task.id);
        recoveries.set(task.id, {
          status: isStreaming ? "running" : "queued",
          acceptedPrompt: !isStreaming && (await this.hasAcceptedInitialTaskPrompt(task.id)),
        });
      }

      for (const task of staleStartingTasks) {
        assert(task.id != null && task.id.length > 0, "stale starting task id is required");
        const recovery = recoveries.get(task.id);
        assert(recovery != null, "stale starting task recovery is required");
        try {
          await this.editActiveWorkspaceEntry(
            task.id,
            (workspace) => {
              if (workspace.taskStatus !== "starting") return;
              workspace.taskStatus = recovery.status;
              // History already owns accepted prompts; do not duplicate them on restart.
              if (recovery.acceptedPrompt) workspace.taskPrompt = undefined;
            },
            { allowMissing: true }
          );
        } catch (error) {
          await this.markTaskLaunchFailed(task.id, getErrorMessage(error));
        }
      }
      log.info("[startup] Recovered stale starting agent tasks", {
        count: staleStartingTasks.length,
        acceptedPromptCount: [...recoveries.values()].filter((recovery) => recovery.acceptedPrompt)
          .length,
      });
    }

    const maybeStartQueuedTasksStartedAt = Date.now();
    await this.maybeStartQueuedTasks();
    const maybeStartQueuedTasksMs = Date.now() - maybeStartQueuedTasksStartedAt;

    let config = this.config.loadConfigOrDefault();
    let taskIndex = this.buildAgentTaskIndex(config);
    // Recompute the startup recovery candidate lists from a config snapshot. Hoisted into a
    // closure so the post-interrupt refresh below reuses the exact same status filters.
    const listStartupRecoveryCandidates = (
      sourceConfig: ProjectsConfig
    ): {
      awaitingReportTasks: AgentTaskWorkspaceEntry[];
      runningTasks: AgentTaskWorkspaceEntry[];
    } => ({
      awaitingReportTasks: this.listAgentTaskWorkspaces(sourceConfig).filter(
        (t) => t.taskStatus === "awaiting_report"
      ),
      runningTasks: this.listAgentTaskWorkspaces(sourceConfig).filter(
        (t) => t.taskStatus === "running"
      ),
    });
    let { awaitingReportTasks, runningTasks } = listStartupRecoveryCandidates(config);

    let interruptedInactiveWorkflowOwnerAtStartup = false;
    for (const task of [...awaitingReportTasks, ...runningTasks]) {
      if (!task.id) continue;
      if (
        await this.interruptTaskRecoveryForInactiveWorkflowOwner(
          task.id,
          config,
          "startup-inactive-workflow-owner-prepass",
          taskIndex,
          { scheduleQueueDrain: false }
        )
      ) {
        interruptedInactiveWorkflowOwnerAtStartup = true;
      }
    }
    if (interruptedInactiveWorkflowOwnerAtStartup) {
      // Refresh before descendant checks so a parent awaiting_report task does not stay
      // blocked by a child that this startup pass just interrupted.
      config = this.config.loadConfigOrDefault();
      taskIndex = this.buildAgentTaskIndex(config);
      ({ awaitingReportTasks, runningTasks } = listStartupRecoveryCandidates(config));
    }

    let resumedAwaitingReportCount = 0;
    let skippedAwaitingReportDueToActiveDescendants = 0;
    let failedAwaitingReportCount = 0;

    for (const task of awaitingReportTasks) {
      if (!task.id) continue;
      if (!(await this.admitTaskDesktopRecovery(task.id))) continue;

      if (
        await this.interruptTaskRecoveryForInactiveWorkflowOwner(
          task.id,
          config,
          "startup-awaiting-report",
          taskIndex
        )
      ) {
        continue;
      }

      // Avoid resuming a task while it still has blocking active descendants (it shouldn't report yet).
      const hasBlockingActiveDescendants =
        this.listBlockingActiveDescendantAgentTaskIdsUsingIndex(taskIndex, task.id).length > 0;
      if (hasBlockingActiveDescendants) {
        skippedAwaitingReportDueToActiveDescendants += 1;
        continue;
      }

      const resumed = await this.promptTaskForRequiredCompletionTool(task.id, {
        reason: "startup",
      });
      if (!resumed) {
        failedAwaitingReportCount += 1;
        continue;
      }

      resumedAwaitingReportCount += 1;
    }

    let resumedRunningCount = 0;
    let skippedRunningDueToActiveDescendants = 0;
    let skippedRunningAlreadyStreaming = 0;
    let failedRunningCount = 0;

    for (const task of runningTasks) {
      if (!task.id) continue;
      if (!(await this.admitTaskDesktopRecovery(task.id))) continue;
      if (
        await this.interruptTaskRecoveryForInactiveWorkflowOwner(
          task.id,
          config,
          "startup-running",
          taskIndex
        )
      ) {
        continue;
      }

      const pendingGuidance = task.taskPendingGuidance ?? [];
      if (pendingGuidance.length > 0) {
        // Pending corrections outrank generic restart recovery and must replay even when this task
        // still has active descendants. Otherwise the descendant gate below can strand the durable
        // reservation forever after the in-memory queue is lost on restart.
        const pendingGuidanceIds = new Set(pendingGuidance.map((guidance) => guidance.id));
        const model = task.taskModelString ?? defaultModel;
        const agentId = resolveTaskAgentIdForResume(task);
        const clearAcceptedPendingGuidance = async (): Promise<void> => {
          await this.editWorkspaceEntry(
            task.id!,
            (workspace) => {
              const remaining = (workspace.taskPendingGuidance ?? []).filter(
                (guidance) => !pendingGuidanceIds.has(guidance.id)
              );
              workspace.taskPendingGuidance = remaining.length > 0 ? remaining : undefined;
            },
            { allowMissing: true }
          );
        };
        const sendResult = await this.workspaceService.sendMessage(
          task.id,
          "Xum restarted before these parent guidance updates could run. Apply them in order and continue:\n\n" +
            pendingGuidance
              .map((guidance, index) => `${index + 1}. ${guidance.message}`)
              .join("\n\n"),
          {
            model,
            agentId,
            thinkingLevel: task.taskThinkingLevel,
            reasoningMode: coerceOpenAIReasoningMode(task.aiSettings?.reasoningMode),
            experiments: task.taskExperiments,
          },
          {
            synthetic: true,
            agentInitiated: true,
            onAccepted: clearAcceptedPendingGuidance,
          }
        );
        if (!sendResult.success) {
          failedRunningCount += 1;
          log.error("Failed to replay pending task guidance on startup", {
            taskId: task.id,
            error: sendResult.error,
          });
          continue;
        }
        resumedRunningCount += 1;
        continue;
      }

      // The queue drain above can have launched this task already; nudging it again would queue
      // a spurious "Xum restarted" turn behind its first stream.
      if (this.aiService.isStreaming(task.id)) {
        skippedRunningAlreadyStreaming += 1;
        continue;
      }

      // Best-effort: if xum restarted mid-stream, nudge the agent to continue and report.
      // Only do this when the task has no blocking running descendants, to avoid duplicate spawns.
      const hasBlockingActiveDescendants =
        this.listBlockingActiveDescendantAgentTaskIdsUsingIndex(taskIndex, task.id).length > 0;
      if (hasBlockingActiveDescendants) {
        skippedRunningDueToActiveDescendants += 1;
        continue;
      }

      const isPlanLike = await this.isPlanLikeTaskWorkspace({
        projectPath: task.projectPath,
        workspace: task,
      });

      const model = task.taskModelString ?? defaultModel;
      const agentId = resolveTaskAgentIdForResume(task);
      log.info("[startup] Resuming running task", {
        taskId: task.id,
        taskName: task.name,
        projectPath: task.projectPath,
        model,
        agentId,
        isPlanLike,
      });
      const resumeStartedAt = Date.now();
      const restartCompletionInstruction = isPlanLike
        ? "When you have a final plan, call propose_plan exactly once."
        : "When you have a final answer, return it in your final assistant message.";
      const sendResult = await this.workspaceService.sendMessage(
        task.id,
        "Xum restarted while this task was running. Continue where you left off. " +
          restartCompletionInstruction,
        {
          model,
          agentId,
          thinkingLevel: task.taskThinkingLevel,
          reasoningMode: coerceOpenAIReasoningMode(task.aiSettings?.reasoningMode),
          experiments: task.taskExperiments,
        },
        { synthetic: true, agentInitiated: true }
      );
      const durationMs = Date.now() - resumeStartedAt;
      if (!sendResult.success) {
        failedRunningCount += 1;
        log.error("Failed to resume running task on startup", {
          taskId: task.id,
          taskName: task.name,
          projectPath: task.projectPath,
          model,
          agentId,
          isPlanLike,
          durationMs,
          error: sendResult.error,
        });
        continue;
      }

      resumedRunningCount += 1;
      log.info("[startup] Resumed running task", {
        taskId: task.id,
        taskName: task.name,
        projectPath: task.projectPath,
        model,
        agentId,
        isPlanLike,
        durationMs,
      });
    }

    if (interruptedInactiveWorkflowOwnerAtStartup) {
      // Startup queue draining already ran before these interruptions freed slots.
      // Run it once more after recovery prompts so unrelated queued work is not stranded.
      await this.maybeStartQueuedTasks();
    }

    log.info("[startup] TaskService.recoverInterruptedTasks completed", {
      totalMs: Date.now() - startupStartedAt,
      maybeStartQueuedTasksMs,
      awaitingReportTaskCount: awaitingReportTasks.length,
      resumedAwaitingReportCount,
      skippedAwaitingReportDueToActiveDescendants,
      failedAwaitingReportCount,
      runningTaskCount: runningTasks.length,
      resumedRunningCount,
      skippedRunningDueToActiveDescendants,
      skippedRunningAlreadyStreaming,
      failedRunningCount,
    });
  }

  /**
   * Startup passes over every reported task and session directory: pending patch-artifact
   * generation, reported-task cleanup, workflow garbage sweeps, and terminal-attention delivery.
   * Scales with deployment size, so the server runs it after its listener is bound. Clients may
   * therefore already be acting: every step re-checks live state before it mutates, and
   * `options.signal` (aborted by dispose) stops the pass at the next step boundary so teardown
   * neither waits for nor races housekeeping against disposed services.
   */
  async runStartupHousekeeping(options?: { signal?: AbortSignal }): Promise<void> {
    const startupStartedAt = Date.now();
    const cancelled = (): boolean => options?.signal?.aborted === true;
    const config = this.config.loadConfigOrDefault();

    // Restart-safety for git patch artifacts:
    // - If xum crashed mid-generation, patch artifacts can be left "pending".
    // - Completed tasks can be stranded in config until cleanup runs again, so restart should
    //   resume artifact generation and re-run the deletion pass.
    const completedReportTasks = this.listAgentTaskWorkspaces(config).filter(
      (task) => hasCompletedAgentReport(task) && typeof task.id === "string" && task.id.length > 0
    );

    const patchGenerationRecoveryStartedAt = Date.now();
    for (const task of completedReportTasks) {
      if (cancelled()) return;
      if (!task.parentWorkspaceId) continue;
      // A reported task that is streaming again (a client reactivated it) may be committing;
      // the continuation refresh that runs when that turn ends generates its artifact.
      if (this.aiService.isStreaming(task.id!)) continue;
      try {
        // Pass the loop snapshot: reloading config.json per reported task made this pass scale
        // with (reported tasks x config size) on large deployments.
        await this.gitPatchArtifactService.maybeStartGeneration(
          task.parentWorkspaceId,
          task.id!,
          (wsId) => this.requestReportedTaskCleanupRecheck(wsId),
          { config }
        );
      } catch (error: unknown) {
        log.error("Failed to resume subagent git patch generation on startup", {
          parentWorkspaceId: task.parentWorkspaceId,
          childWorkspaceId: task.id,
          error,
        });
      }
    }
    const patchGenerationRecoveryMs = Date.now() - patchGenerationRecoveryStartedAt;

    // Restart-safety for grouped best-of completion: if child report artifacts already exist
    // on disk after a restart, there may be no later child stream-end to finalize the pending
    // parent task tool call. Re-run the deferred parent delivery/finalization pass first so
    // cleanup rechecks do not stay blocked forever behind a stale input-available partial.
    // A parent turn (client or resumed child) may start meanwhile; the finalization write is a
    // compare-and-set on the partial's identity, so it never lands on a live turn's partial.
    if (cancelled()) return;
    const bestOfRecoveryStartedAt = Date.now();
    const bestOfParentWorkspaceIds = new Set<string>();
    for (const task of completedReportTasks) {
      const parentWorkspaceId = coerceNonEmptyString(task.parentWorkspaceId);
      const taskId = coerceNonEmptyString(task.id);
      const bestOf = taskId ? this.getEffectiveTaskGroup(taskId, task) : undefined;
      if (!parentWorkspaceId || (bestOf?.total ?? 1) <= 1) {
        continue;
      }
      if (this.aiService.isStreaming(parentWorkspaceId)) {
        continue;
      }
      bestOfParentWorkspaceIds.add(parentWorkspaceId);
    }
    for (const parentWorkspaceId of bestOfParentWorkspaceIds) {
      if (cancelled()) return;
      await this.deliverDeferredBestOfReportsForParent(parentWorkspaceId);
    }
    const bestOfRecoveryMs = Date.now() - bestOfRecoveryStartedAt;

    // Best-effort completed-report ancestor recheck after restart.
    const cleanupReportedTasksStartedAt = Date.now();
    // Reuse one config snapshot across tasks to screen out the (usual) ineligible majority without
    // a config parse each; reload it only after a removal changed the tree. The snapshot never
    // decides a deletion: canCleanupReportedTask re-evaluates any positive verdict on fresh config,
    // since clients may have reactivated or re-parented a task since the snapshot.
    let cleanupConfig = config;
    for (const task of completedReportTasks) {
      if (cancelled()) return;
      if (!task.id) continue;
      const removedCount = await this.cleanupReportedLeafTask(task.id, { config: cleanupConfig });
      if (removedCount > 0) {
        cleanupConfig = this.config.loadConfigOrDefault();
      }
    }
    const cleanupReportedTasksMs = Date.now() - cleanupReportedTasksStartedAt;
    if (cancelled()) return;

    // Startup self-heal for leftover workflow task garbage: interrupted-without-report
    // workflow-owned children of inactive runs (both the ones the prepass above just
    // interrupted and historical leftovers) are archived out of the active sidebar.
    // Startup-time rule: never crash the app — archive failures are logged and retried
    // on the next launch.
    try {
      await this.archiveLeftoverTasksOfInactiveWorkflowRuns();
    } catch (error: unknown) {
      log.error("Startup workflow task archive sweep failed", { error });
    }

    if (cancelled()) return;
    let queuedTerminalWorkflowRunAttentionCount = 0;
    try {
      queuedTerminalWorkflowRunAttentionCount = await this.sweepWorkflowRunTerminalAttention();
    } catch (error: unknown) {
      // Startup-time initialization must never crash the app; the interval sweep retries.
      log.warn("Startup workflow terminal attention sweep failed", { error });
    }
    if (this.workflowAttentionSweepTimer == null) {
      this.workflowAttentionSweepTimer = setInterval(() => {
        void this.sweepWorkflowRunTerminalAttention().catch((error: unknown) => {
          log.warn("Workflow terminal attention sweep failed", { error });
        });
        void this.schedulePendingTerminalAttentionOwnerDrains().catch((error: unknown) => {
          log.warn("Pending terminal attention re-poke failed", { error });
        });
      }, WORKFLOW_TERMINAL_ATTENTION_SWEEP_INTERVAL_MS);
      this.workflowAttentionSweepTimer.unref?.();
    }
    if (cancelled()) return;
    const recoveredTerminalWorkspaceTurnNotificationCount =
      await this.getWorkspaceTurnManager().recoverTerminalWorkspaceTurnAttentionNotifications();
    const terminalAttentionDrainStartedAt = Date.now();
    const pendingTerminalAttentionOwnerWorkspaceCount =
      await this.schedulePendingTerminalAttentionOwnerDrains();
    const terminalAttentionDrainMs = Date.now() - terminalAttentionDrainStartedAt;

    const totalMs = Date.now() - startupStartedAt;
    const completedPayload = {
      totalMs,
      completedReportTaskCount: completedReportTasks.length,
      patchGenerationRecoveryMs,
      bestOfParentRecoveryCount: bestOfParentWorkspaceIds.size,
      bestOfRecoveryMs,
      queuedTerminalWorkflowRunAttentionCount,
      recoveredTerminalWorkspaceTurnNotificationCount,
      pendingTerminalAttentionOwnerWorkspaceCount,
      terminalAttentionDrainMs,
      cleanupReportedTasksMs,
    };
    if (totalMs > SLOW_STARTUP_WARN_THRESHOLD_MS) {
      log.warn("[startup] TaskService.runStartupHousekeeping completed", completedPayload);
    } else {
      log.info("[startup] TaskService.runStartupHousekeeping completed", completedPayload);
    }
  }

  private async hasAcceptedInitialTaskPrompt(workspaceId: string): Promise<boolean> {
    assert(workspaceId.length > 0, "hasAcceptedInitialTaskPrompt: workspaceId must be non-empty");

    const historyResult = await this.historyService.getHistoryFromLatestBoundary(workspaceId);
    if (!historyResult.success) {
      log.warn("Failed to inspect task history during stale starting recovery", {
        workspaceId,
        error: historyResult.error,
      });
      return false;
    }

    return historyResult.data.some((message) => message.role === "user");
  }

  private startWorkspaceInit(workspaceId: string, projectPath: string): InitLogger {
    assert(workspaceId.length > 0, "startWorkspaceInit: workspaceId must be non-empty");
    assert(projectPath.length > 0, "startWorkspaceInit: projectPath must be non-empty");

    this.initStateManager.startInit(workspaceId, projectPath);
    return {
      logStep: (message: string) => this.initStateManager.appendOutput(workspaceId, message, false),
      logStdout: (line: string) => this.initStateManager.appendOutput(workspaceId, line, false),
      logStderr: (line: string) => this.initStateManager.appendOutput(workspaceId, line, true),
      logComplete: (exitCode: number) => void this.initStateManager.endInit(workspaceId, exitCode),
      enterHookPhase: () => this.initStateManager.enterHookPhase(workspaceId),
    };
  }

  private resolveTaskDesktopOwner(args: TaskCreateArgs, agentId: string): string | undefined {
    const desktop = args.desktop ?? (agentId === "desktop" ? "shared" : "isolated");
    if (desktop !== "shared") return undefined;
    if (args.bestOf != null && args.bestOf.total > 1) {
      throw new Error("Shared desktop tasks cannot use best-of groups; use desktop: isolated");
    }
    return this.desktopInputCoordinator.resolveTarget(args.parentWorkspaceId).ownerWorkspaceId;
  }

  private async admitTaskDesktopRecovery(taskId: string): Promise<boolean> {
    try {
      await this.desktopInputCoordinator.withAdmission(taskId, () => Promise.resolve(undefined));
      return true;
    } catch (error) {
      await this.markTaskLaunchFailed(taskId, getErrorMessage(error));
      return false;
    }
  }

  private async editActiveWorkspaceEntry(
    workspaceId: string,
    updater: (workspace: WorkspaceConfigEntry) => void,
    options?: { allowMissing?: boolean }
  ): Promise<boolean> {
    // Admission protects only persistence. Never hold the desktop gate across nested sends.
    return await this.desktopInputCoordinator.withAdmission(workspaceId, () =>
      this.editWorkspaceEntry(
        workspaceId,
        (workspace, config) => {
          updater(workspace);
          this.desktopInputCoordinator.assertAdmission(config, workspaceId);
        },
        options
      )
    );
  }

  async createMany(
    argsList: TaskCreateArgs[],
    options: TaskCreateManyOptions = {}
  ): Promise<Result<TaskCreateResult[], string>> {
    if (argsList.length === 0) {
      return Ok([]);
    }
    const parentWorkspaceIds = argsList.map((args) => coerceNonEmptyString(args.parentWorkspaceId));
    if (parentWorkspaceIds.some((workspaceId) => workspaceId == null)) {
      return Err("Task.createMany: parentWorkspaceId is required");
    }
    return await this.withTaskTreeLifecycleLocks(
      parentWorkspaceIds.filter((workspaceId): workspaceId is string => workspaceId != null),
      () => this.createManyUnderTaskTreeLifecycleLocks(argsList, options)
    );
  }

  private async createManyUnderTaskTreeLifecycleLocks(
    argsList: TaskCreateArgs[],
    options: TaskCreateManyOptions
  ): Promise<Result<TaskCreateResult[], string>> {
    // sharedWorkspacePath is set for honored isolation: "none" plans; the entry is persisted
    // pointing at the parent's checkout and startReservedAgentTask reuses it without fork/init.
    const plans: Array<
      TaskLaunchPlan & { status: "queued" | "starting"; sharedWorkspacePath?: string }
    > = [];
    const results: TaskCreateResult[] = [];

    await using _lock = await this.mutex.acquire();

    const cfg = this.config.loadConfigOrDefault();
    const taskSettings = cfg.taskSettings ?? DEFAULT_TASK_SETTINGS;
    let reservedActiveCount =
      this.countActiveAgentTasks(cfg) +
      (await this.getWorkspaceTurnManager().countActiveWorkspaceTurns());

    for (const args of argsList) {
      const parentWorkspaceId = coerceNonEmptyString(args.parentWorkspaceId);
      if (!parentWorkspaceId) return Err("Task.createMany: parentWorkspaceId is required");
      if (args.kind !== "agent") return Err("Task.createMany: unsupported kind");

      const prompt = coerceNonEmptyString(args.prompt);
      if (!prompt) return Err("Task.createMany: prompt is required");

      const normalizedAgentId = normalizeAgentId(args.agentId ?? args.agentType, "");
      if (!normalizedAgentId) return Err("Task.createMany: agentId is required");
      const parsedAgentId = AgentIdSchema.safeParse(normalizedAgentId);
      if (!parsedAgentId.success) {
        return Err(`Task.createMany: invalid agentId (${normalizedAgentId})`);
      }
      const agentId = parsedAgentId.data;
      const agentType = agentId;
      let taskDesktopOwnerWorkspaceId: string | undefined;
      try {
        taskDesktopOwnerWorkspaceId = this.resolveTaskDesktopOwner(args, agentId);
      } catch (error) {
        return Err(getErrorMessage(error));
      }

      let normalizedBestOf: TaskCreateArgs["bestOf"];
      const bestOf = args.bestOf;
      if (bestOf) {
        const groupId = coerceNonEmptyString(bestOf.groupId);
        if (!groupId)
          return Err("Task.createMany: bestOf.groupId is required when bestOf is provided");
        if (!Number.isInteger(bestOf.index) || bestOf.index < 0) {
          return Err("Task.createMany: bestOf.index must be a non-negative integer");
        }
        if (!Number.isInteger(bestOf.total) || bestOf.total < 2) {
          return Err("Task.createMany: bestOf.total must be an integer >= 2");
        }
        if (bestOf.index >= bestOf.total) {
          return Err("Task.createMany: bestOf.index must be less than bestOf.total");
        }
        normalizedBestOf = {
          groupId,
          index: bestOf.index,
          total: bestOf.total,
        };
      }

      const parentMetaResult = await this.aiService.getWorkspaceMetadata(parentWorkspaceId);
      if (!parentMetaResult.success) {
        return Err(`Task.createMany: parent workspace not found (${parentMetaResult.error})`);
      }
      const parentMeta = parentMetaResult.data;
      const parentEntry = findWorkspaceEntry(cfg, parentWorkspaceId);
      if (
        parentEntry != null &&
        isWorkspaceArchived(parentEntry.workspace.archivedAt, parentEntry.workspace.unarchivedAt)
      ) {
        return Err("Task.createMany: parent workspace is archived");
      }
      const parentIsScratch = parentEntry?.workspace.kind === "scratch";
      const configProjectPath = parentIsScratch
        ? SCRATCH_PROJECT_CONFIG_KEY
        : stripTrailingSlashes(parentMeta.projectPath);
      const taskProjectConfig = cfg.projects.get(configProjectPath);
      if (!taskProjectConfig?.trusted) {
        return Err(
          "This project must be trusted before creating workspaces. Trust the project in Settings → Security, or create a workspace from the project page."
        );
      }

      if (
        parentEntry?.workspace.taskStatus === "interrupted" &&
        !isActiveWorkspaceTurnTaskStatus(parentEntry.workspace.taskExecutionStatus)
      ) {
        return Err("Task.createMany: cannot spawn new tasks after task_stop");
      }

      if (
        parentEntry?.workspace.taskStatus === "reported" &&
        !isActiveWorkspaceTurnTaskStatus(parentEntry.workspace.taskExecutionStatus)
      ) {
        return Err("Task.createMany: cannot spawn new tasks after agent_report");
      }

      const requestedDepth = this.getTaskDepth(cfg, parentWorkspaceId) + 1;
      if (requestedDepth > taskSettings.maxTaskNestingDepth) {
        return Err(
          `Task.createMany: maxTaskNestingDepth exceeded (requestedDepth=${requestedDepth}, max=${taskSettings.maxTaskNestingDepth})`
        );
      }

      const taskId = this.config.generateStableId();
      const workspaceName = buildAgentWorkspaceName(agentId, taskId);
      const nameValidation = validateWorkspaceName(workspaceName);
      if (!nameValidation.valid) {
        return Err(
          `Task.createMany: generated workspace name invalid (${nameValidation.error ?? "unknown error"})`
        );
      }

      const parentRuntimeConfig = parentMeta.runtimeConfig;
      const taskRuntimeConfig: RuntimeConfig = parentRuntimeConfig;
      // Supply the parent's persisted path so override-aware runtimes (worktree/SSH) resolve the
      // parent's REAL checkout when the parent is itself an isolation: "none" task (see create()).
      const runtime = createRuntimeForWorkspace({
        runtimeConfig: taskRuntimeConfig,
        projectPath: parentMeta.projectPath,
        name: parentMeta.name,
        namedWorkspacePath: coerceNonEmptyString(parentEntry?.workspace.path),
      });
      // Prefer the parent's persisted checkout path over the name-derived one: when the parent is
      // itself an isolation: "none" task, its name is synthetic and the derived path does not
      // exist — its real checkout is the persisted (shared) path.
      const isInPlace = parentMeta.projectPath === parentMeta.name;
      const parentWorkspacePath = isInPlace
        ? parentMeta.projectPath
        : (coerceNonEmptyString(parentEntry?.workspace.path) ??
          runtime.getWorkspacePath(parentMeta.projectPath, parentMeta.name));

      // isolation: "none" — same gating as create(): only worktree/SSH single-project parents
      // share the parent checkout; everything else falls back to the normal fork path.
      const taskRuntimeMode = getRuntimeType(taskRuntimeConfig);
      const parentIsMultiProject = (parentMeta.projects?.length ?? 0) > 1;
      const useSharedWorkspace =
        parentIsScratch ||
        (args.isolation === "none" &&
          runtimeModeSupportsSharedTaskWorkspace(taskRuntimeMode) &&
          !parentIsMultiProject);
      const sharedWorkspacePath = useSharedWorkspace ? parentWorkspacePath : undefined;
      // Branch actually checked out in the parent's checkout (see create() for rationale).
      const parentIsSharedTask = parentEntry?.workspace.taskIsolation === "none";
      const parentBranchName = parentIsSharedTask
        ? (coerceNonEmptyString(parentEntry?.workspace.taskTrunkBranch) ??
          coerceNonEmptyString(parentMeta.name))
        : coerceNonEmptyString(parentMeta.name);
      if (args.isolation === "none" && !useSharedWorkspace) {
        log.debug("Task.createMany: isolation=none not honored; falling back to fork", {
          taskId,
          runtimeMode: taskRuntimeMode,
          parentIsMultiProject,
        });
      }

      const getRunnableHint = async (): Promise<string> => {
        try {
          const allAgents = await discoverAgentDefinitions(runtime, parentWorkspacePath);
          const runnableIds = (
            await Promise.all(
              allAgents.map(async (agent) => {
                try {
                  const frontmatter = await resolveAgentFrontmatter(
                    runtime,
                    parentWorkspacePath,
                    agent.id,
                    { skipScopesAbove: getSkipScopesAboveForKnownScope(agent.scope) }
                  );
                  if (
                    !isAgentRunnableAsChild(frontmatter, {
                      workflowOwned: args.workflowTask != null,
                    })
                  ) {
                    return null;
                  }
                  return isAgentEffectivelyDisabled({
                    cfg,
                    agentId: agent.id,
                    resolvedFrontmatter: frontmatter,
                  })
                    ? null
                    : agent.id;
                } catch {
                  return null;
                }
              })
            )
          ).filter((id): id is string => typeof id === "string");
          return runnableIds.length > 0
            ? `Runnable agentIds: ${runnableIds.join(", ")}`
            : "No runnable agents available";
        } catch {
          return "Could not discover available agents";
        }
      };

      let skipInitHook = false;
      try {
        const frontmatter = await resolveAgentFrontmatter(runtime, parentWorkspacePath, agentId);
        if (!isAgentRunnableAsChild(frontmatter, { workflowOwned: args.workflowTask != null })) {
          const hint = await getRunnableHint();
          return Err(
            `Task.createMany: agentId is not runnable as a sub-agent (${agentId}). ${hint}`
          );
        }
        if (isAgentEffectivelyDisabled({ cfg, agentId, resolvedFrontmatter: frontmatter })) {
          const hint = await getRunnableHint();
          return Err(`Task.createMany: agentId is disabled (${agentId}). ${hint}`);
        }
        skipInitHook = frontmatter.subagent?.skip_init_hook === true;
      } catch {
        const hint = await getRunnableHint();
        return Err(`Task.createMany: unknown agentId (${agentId}). ${hint}`);
      }

      let taskModelString: string;
      let canonicalModel: string;
      let effectiveThinkingLevel: ThinkingLevel;
      let effectiveReasoningMode: OpenAIReasoningMode | undefined;
      try {
        ({ taskModelString, canonicalModel, effectiveThinkingLevel, effectiveReasoningMode } =
          await this.resolveTaskAISettings({
            cfg,
            parentWorkspaceId,
            parentMeta,
            agentId,
            modelString: args.modelString,
            thinkingLevel: args.thinkingLevel,
            parentRuntimeAiSettings: args.parentRuntimeAiSettings,
            definitionContext: {
              runtime,
              workspacePath: parentWorkspacePath,
              workspaceId: parentWorkspaceId,
            },
          }));
      } catch (error) {
        if (error instanceof InvalidExplicitAiSettingError) {
          return Err(`Task.createMany: ${error.message}`);
        }
        throw error;
      }

      const status: "queued" | "starting" =
        reservedActiveCount >= taskSettings.maxParallelAgentTasks ? "queued" : "starting";
      if (status === "starting") reservedActiveCount += 1;

      const createdAt = getIsoNow();
      plans.push({
        taskId,
        parentWorkspaceId,
        parentMeta,
        agentId,
        agentType,
        start: { kind: "sendMessage", prompt },
        title: args.title,
        workspaceName,
        createdAt,
        taskRuntimeConfig,
        parentRuntimeConfig,
        configProjectPath,
        workspaceKind: parentIsScratch ? "scratch" : undefined,
        taskModelString,
        canonicalModel,
        effectiveThinkingLevel,
        effectiveReasoningMode,
        skipInitHook,
        workflowTask: args.workflowTask,
        bestOf: normalizedBestOf,
        experiments: args.experiments,
        onRefusal: args.onRefusal,
        attentionPolicy: args.attentionPolicy,
        taskDesktopOwnerWorkspaceId,
        status,
        ...(sharedWorkspacePath != null ? { sharedWorkspacePath } : {}),
        // Real branch checked out in the parent's checkout: persisted as taskTrunkBranch and used
        // by orchestrateFork's create-fallback when the fork cannot detect a source branch
        // (a shared parent's synthetic name never names a real branch). Gated to shared parents
        // to keep the existing branch-discovery fallback otherwise.
        ...(parentIsSharedTask && parentBranchName != null
          ? { preferredTrunkBranch: parentBranchName }
          : {}),
      });
      results.push({
        taskId,
        kind: "agent",
        status,
        modelString: taskModelString,
        thinkingLevel: effectiveThinkingLevel,
        desktopOwnerWorkspaceId: taskDesktopOwnerWorkspaceId ?? taskId,
      });
    }

    try {
      await this.desktopInputCoordinator.withReservations(
        plans.flatMap((plan) =>
          plan.taskDesktopOwnerWorkspaceId == null
            ? []
            : [
                {
                  ownerWorkspaceId: plan.taskDesktopOwnerWorkspaceId,
                  borrowerWorkspaceId: plan.taskId,
                },
              ]
        ),
        async () => {
          for (const [index, result] of results.entries()) {
            // Workflow callers durably checkpoint returned task IDs before task records are persisted.
            // If config persistence fails afterward, replay sees a started step whose task is not found
            // and restarts it instead of duplicating an already-launched child after a crash.
            await options.onTaskReserved?.(index, result);
          }

          await this.config.editConfig((config) => {
            for (const plan of plans) {
              const runtime = createRuntimeForWorkspace({
                runtimeConfig: plan.taskRuntimeConfig,
                projectPath: plan.parentMeta.projectPath,
                name: plan.parentMeta.name,
              });
              const workspacePath =
                plan.sharedWorkspacePath ??
                runtime.getWorkspacePath(plan.parentMeta.projectPath, plan.workspaceName);
              const trunkBranch =
                coerceNonEmptyString(plan.preferredTrunkBranch) ??
                coerceNonEmptyString(plan.parentMeta.name);
              if (!trunkBranch) {
                throw new Error("Task.createMany: parent workspace name missing");
              }
              let projectConfig = config.projects.get(plan.configProjectPath);
              if (!projectConfig) {
                projectConfig = { workspaces: [] };
                config.projects.set(plan.configProjectPath, projectConfig);
              }
              projectConfig.workspaces.push({
                kind: plan.workspaceKind,
                path: workspacePath,
                id: plan.taskId,
                name: plan.workspaceName,
                title: plan.title,
                createdAt: plan.createdAt,
                runtimeConfig: plan.taskRuntimeConfig,
                aiSettings:
                  plan.effectiveThinkingLevel !== undefined
                    ? {
                        model: plan.canonicalModel,
                        thinkingLevel: plan.effectiveThinkingLevel,
                        ...(plan.effectiveReasoningMode != null
                          ? { reasoningMode: plan.effectiveReasoningMode }
                          : {}),
                      }
                    : undefined,
                parentWorkspaceId: plan.parentWorkspaceId,
                agentId: plan.agentId,
                agentType: plan.agentType,
                workflowTask: plan.workflowTask,
                bestOf: plan.bestOf,
                taskStatus: plan.status,
                taskPrompt: plan.start.kind === "sendMessage" ? plan.start.prompt : undefined,
                taskTrunkBranch: trunkBranch,
                taskModelString: plan.taskModelString,
                taskThinkingLevel: plan.effectiveThinkingLevel,
                taskOnRefusal: plan.onRefusal,
                taskExperiments: withLegacyPtcExclusiveMirror(plan.experiments),
                taskIsolation: plan.sharedWorkspacePath != null ? "none" : undefined,
                taskAttentionPolicy: plan.attentionPolicy,
                taskDesktopOwnerWorkspaceId: plan.taskDesktopOwnerWorkspaceId,
                projects: plan.parentMeta.projects,
              });
              this.desktopInputCoordinator.assertAdmission(config, plan.taskId);
            }
            return config;
          });
        }
      );
    } catch (error) {
      return Err(getErrorMessage(error));
    }

    for (const result of results) {
      await this.emitWorkspaceMetadata(result.taskId);
    }
    for (const plan of plans) {
      if (plan.status === "starting") {
        this.scheduleReservedTaskLaunch(plan);
      }
    }
    if (plans.some((plan) => plan.status === "queued")) {
      this.scheduleMaybeStartQueuedTasks();
    }

    return Ok(results);
  }

  private async cleanupMaterializedTaskWorkspace(
    runtime: Runtime,
    projectPath: string,
    workspaceName: string,
    taskId: string,
    options?: {
      /**
       * Skip physical workspace deletion. Required for isolation: "none" tasks whose runtime
       * resolves this task's name to the shared parent checkout (e.g. SSHRuntime.deleteWorkspace
       * goes through the persisted-path override) — deleting it would destroy the parent's
       * working tree. Session/config cleanup still runs.
       */
      preservePhysicalWorkspace?: boolean;
    }
  ): Promise<void> {
    assert(projectPath.length > 0, "cleanupMaterializedTaskWorkspace requires projectPath");
    assert(workspaceName.length > 0, "cleanupMaterializedTaskWorkspace requires workspaceName");
    assert(taskId.length > 0, "cleanupMaterializedTaskWorkspace requires taskId");

    if (options?.preservePhysicalWorkspace) {
      log.debug("Task launch cleanup: preserving shared parent checkout", { taskId });
    } else {
      try {
        const deleteResult = await runtime.deleteWorkspace(projectPath, workspaceName, true);
        if (!deleteResult.success) {
          log.error("Task launch cleanup: failed to delete materialized workspace", {
            taskId,
            error: deleteResult.error,
          });
        }
      } catch (error: unknown) {
        log.error("Task launch cleanup: runtime.deleteWorkspace threw", {
          taskId,
          error: getErrorMessage(error),
        });
      }
    }

    try {
      const sessionDir = path.join(this.config.sessionsDir, taskId);
      await fsPromises.rm(sessionDir, { recursive: true, force: true });
    } catch (error: unknown) {
      log.error("Task launch cleanup: failed to remove session directory", {
        taskId,
        error: getErrorMessage(error),
      });
    }
  }

  private async getExistingMaterializedTaskLaunch(
    plan: TaskLaunchPlan,
    sourceRuntime: Runtime,
    workspace: WorkspaceConfigEntry
  ): Promise<MaterializedTaskLaunch | null> {
    const workspacePath =
      coerceNonEmptyString(workspace.path) ??
      sourceRuntime.getWorkspacePath(plan.parentMeta.projectPath, plan.workspaceName);
    if (!(await runtimePathExists(sourceRuntime, workspacePath))) {
      return null;
    }

    const forkedRuntimeConfig = workspace.runtimeConfig ?? plan.taskRuntimeConfig;
    const runtimeForTaskWorkspace = createRuntimeForWorkspace({
      runtimeConfig: forkedRuntimeConfig,
      projectPath: plan.parentMeta.projectPath,
      name: plan.workspaceName,
      namedWorkspacePath: workspacePath,
    });
    const trunkBranch =
      coerceNonEmptyString(workspace.taskTrunkBranch) ??
      coerceNonEmptyString(plan.preferredTrunkBranch) ??
      coerceNonEmptyString(plan.parentMeta.name) ??
      plan.workspaceName;

    return {
      workspacePath,
      trunkBranch,
      forkedRuntimeConfig,
      runtimeForTaskWorkspace,
      inheritedProjects: workspace.projects ?? plan.parentMeta.projects,
    };
  }

  private async runProjectForkExclusive<T>(projectPath: string, fn: () => Promise<T>): Promise<T> {
    assert(projectPath.length > 0, "runProjectForkExclusive requires projectPath");

    const previousLaunch =
      this.reservedTaskLaunchByProjectPath.get(projectPath) ?? Promise.resolve();
    const run = previousLaunch.catch(() => undefined).then(fn);
    const trackedLaunch = run
      .then(
        () => undefined,
        () => undefined
      )
      .finally(() => {
        if (this.reservedTaskLaunchByProjectPath.get(projectPath) === trackedLaunch) {
          this.reservedTaskLaunchByProjectPath.delete(projectPath);
        }
      });
    this.reservedTaskLaunchByProjectPath.set(projectPath, trackedLaunch);
    return await run;
  }

  private async materializeReservedTaskWorkspace(
    plan: TaskLaunchPlan,
    sourceRuntime: Runtime,
    initLogger: InitLogger
  ): Promise<MaterializedTaskLaunch | null> {
    const entry = findWorkspaceEntry(this.config.loadConfigOrDefault(), plan.taskId);
    if (entry?.workspace.taskStatus !== "starting") {
      return null;
    }

    const existing = await this.getExistingMaterializedTaskLaunch(
      plan,
      sourceRuntime,
      entry.workspace
    );
    if (existing) {
      taskQueueDebug("TaskService.startReservedAgentTask reusing materialized workspace", {
        taskId: plan.taskId,
        workspacePath: existing.workspacePath,
      });
      return existing;
    }

    const projectPath = stripTrailingSlashes(plan.parentMeta.projectPath);
    return await this.runProjectForkExclusive(projectPath, async () => {
      const entryBeforeFork = findWorkspaceEntry(this.config.loadConfigOrDefault(), plan.taskId);
      if (entryBeforeFork?.workspace.taskStatus !== "starting") {
        return null;
      }

      const forkResult = await orchestrateFork({
        sourceRuntime,
        projectPath: plan.parentMeta.projectPath,
        sourceWorkspaceName: plan.parentMeta.name,
        newWorkspaceName: plan.workspaceName,
        initLogger,
        config: this.config,
        sourceWorkspaceId: plan.parentWorkspaceId,
        sourceRuntimeConfig: plan.parentRuntimeConfig,
        parentMetadata: plan.parentMeta,
        allowCreateFallback: true,
        ...(plan.preferredTrunkBranch != null
          ? { preferredTrunkBranch: plan.preferredTrunkBranch }
          : {}),
        trusted:
          this.config.loadConfigOrDefault().projects.get(plan.configProjectPath)?.trusted ?? false,
        multiProjectExperimentEnabled: this.workspaceService.isExperimentEnabled(
          EXPERIMENT_IDS.MULTI_PROJECT_WORKSPACES
        ),
      });

      if (!forkResult.success) {
        throw new Error(`Task fork failed: ${forkResult.error}`);
      }

      return {
        workspacePath: forkResult.data.workspacePath,
        trunkBranch: forkResult.data.trunkBranch,
        forkedRuntimeConfig: forkResult.data.forkedRuntimeConfig,
        runtimeForTaskWorkspace: forkResult.data.targetRuntime,
        inheritedProjects: forkResult.data.projects,
        ...(forkResult.data.sourceRuntimeConfigUpdate != null
          ? { sourceRuntimeConfigUpdate: forkResult.data.sourceRuntimeConfigUpdate }
          : {}),
      };
    });
  }

  private scheduleReservedTaskLaunch(plan: TaskLaunchPlan): void {
    assert(plan.taskId.length > 0, "scheduleReservedTaskLaunch requires taskId");
    void this.enqueueReservedTaskLaunch(plan).catch((error: unknown) => {
      log.error("Failed to launch reserved task", { taskId: plan.taskId, error });
      void this.markTaskLaunchFailed(plan.taskId, getErrorMessage(error));
    });
  }

  scheduleMaybeStartQueuedTasks(): void {
    void this.maybeStartQueuedTasks().catch((error: unknown) => {
      log.error("TaskService.maybeStartQueuedTasks failed", { error });
    });
  }

  private async markTaskLaunchFailed(taskId: string, message: string): Promise<void> {
    assert(taskId.length > 0, "markTaskLaunchFailed requires taskId");
    let transitionedToInterrupted = false;
    let parentWorkspaceId: string | undefined;
    await this.editWorkspaceEntry(
      taskId,
      (ws) => {
        transitionedToInterrupted = ws.taskStatus !== "interrupted";
        parentWorkspaceId = ws.parentWorkspaceId;
        ws.taskStatus = "interrupted";
        ws.taskLaunchError = message;
      },
      { allowMissing: true }
    );
    if (transitionedToInterrupted) {
      this.recordTaskInterrupted(taskId, parentWorkspaceId);
    }
    await this.emitWorkspaceMetadata(taskId);
    this.rejectWaiters(taskId, new Error(message));
    this.scheduleMaybeStartQueuedTasks();
  }

  private async startReservedAgentTask(plan: TaskLaunchPlan): Promise<void> {
    assert(plan.taskId.length > 0, "startReservedAgentTask requires taskId");
    assert(plan.parentWorkspaceId.length > 0, "startReservedAgentTask requires parentWorkspaceId");
    if (plan.start.kind === "sendMessage") {
      assert(plan.start.prompt.length > 0, "startReservedAgentTask requires prompt");
    }

    const entryAtStart = findWorkspaceEntry(this.config.loadConfigOrDefault(), plan.taskId);
    if (entryAtStart?.workspace.taskStatus !== "starting") {
      return;
    }

    // Revalidate persisted bindings on restart before materializing a checkout or starting init.
    if (!(await this.admitTaskDesktopRecovery(plan.taskId))) return;

    // isolation: "none" tasks were queued pointing at the parent's checkout. When that checkout
    // still exists, materialization reuses it (no fork); if it disappeared, materialization falls
    // back to forking a real workspace and the shared flag must be cleared below.
    const taskWasShared = entryAtStart.workspace.taskIsolation === "none";
    const persistedSharedPath = taskWasShared
      ? coerceNonEmptyString(entryAtStart.workspace.path)
      : undefined;

    const initLogger = this.startWorkspaceInit(plan.taskId, plan.parentMeta.projectPath);
    // Supply the parent's persisted path so override-aware runtimes (worktree/SSH) fork from the
    // parent's REAL checkout when the parent is itself an isolation: "none" task (see create()).
    const parentEntryForLaunch = findWorkspaceEntry(
      this.config.loadConfigOrDefault(),
      plan.parentWorkspaceId
    );
    const runtime = createRuntimeForWorkspace({
      runtimeConfig: plan.taskRuntimeConfig,
      projectPath: plan.parentMeta.projectPath,
      name: plan.parentMeta.name,
      namedWorkspacePath: coerceNonEmptyString(parentEntryForLaunch?.workspace.path),
    });

    let materialized: MaterializedTaskLaunch | null;
    try {
      materialized = await this.materializeReservedTaskWorkspace(plan, runtime, initLogger);
    } catch (error: unknown) {
      initLogger.logComplete(-1);
      throw error;
    }
    if (!materialized) {
      initLogger.logComplete(-1);
      return;
    }

    // Reuse of the persisted shared path means the task still runs in the parent's checkout;
    // any other materialized path means the fork fallback created a real (deletable) workspace.
    const sharesParentCheckout =
      taskWasShared && materialized.workspacePath === persistedSharedPath;

    const entryAfterMaterialize = findWorkspaceEntry(
      this.config.loadConfigOrDefault(),
      plan.taskId
    );
    if (!entryAfterMaterialize) {
      initLogger.logComplete(-1);
      await this.cleanupMaterializedTaskWorkspace(
        materialized.runtimeForTaskWorkspace,
        plan.parentMeta.projectPath,
        plan.workspaceName,
        plan.taskId,
        { preservePhysicalWorkspace: sharesParentCheckout }
      );
      return;
    }
    if (entryAfterMaterialize.workspace.taskStatus !== "starting") {
      initLogger.logComplete(-1);
      return;
    }

    if (materialized.sourceRuntimeConfigUpdate) {
      await this.config.updateWorkspaceMetadata(plan.parentWorkspaceId, {
        runtimeConfig: materialized.sourceRuntimeConfigUpdate,
      });
      await this.emitWorkspaceMetadata(plan.parentWorkspaceId);
    }

    const {
      workspacePath,
      trunkBranch,
      forkedRuntimeConfig,
      runtimeForTaskWorkspace,
      inheritedProjects,
    } = materialized;

    this.configureMultiProjectRuntimeEnvResolver(runtimeForTaskWorkspace);
    const taskBaseCommitShaByProjectPath = await readTaskBaseCommitShaByProjectPath({
      workspaceId: plan.taskId,
      workspaceName: plan.workspaceName,
      workspacePath,
      runtimeConfig: forkedRuntimeConfig,
      projectPath: plan.parentMeta.projectPath,
      projectName: plan.parentMeta.projectName,
      projects: inheritedProjects,
      runtime: runtimeForTaskWorkspace,
    });
    const taskBaseCommitSha = taskBaseCommitShaByProjectPath[plan.parentMeta.projectPath];

    await this.editWorkspaceEntry(
      plan.taskId,
      (ws) => {
        if (ws.taskStatus !== "starting") {
          return;
        }
        ws.path = workspacePath;
        ws.runtimeConfig = forkedRuntimeConfig;
        ws.taskTrunkBranch = trunkBranch;
        ws.taskBaseCommitSha = taskBaseCommitSha ?? undefined;
        ws.taskBaseCommitShaByProjectPath = taskBaseCommitShaByProjectPath;
        ws.projects = inheritedProjects;
        // The shared parent checkout was gone, so this task had to fork a real workspace.
        // Clear the shared flag so removal cleans up the new worktree.
        if (taskWasShared && !sharesParentCheckout) {
          ws.taskIsolation = undefined;
        }
      },
      { allowMissing: true }
    );
    await this.emitWorkspaceMetadata(plan.taskId);

    const entryBeforeSend = findWorkspaceEntry(this.config.loadConfigOrDefault(), plan.taskId);
    if (!entryBeforeSend) {
      initLogger.logComplete(-1);
      await this.cleanupMaterializedTaskWorkspace(
        runtimeForTaskWorkspace,
        plan.parentMeta.projectPath,
        plan.workspaceName,
        plan.taskId,
        { preservePhysicalWorkspace: sharesParentCheckout }
      );
      return;
    }
    if (entryBeforeSend.workspace.taskStatus !== "starting") {
      initLogger.logComplete(-1);
      return;
    }

    if (!sharesParentCheckout) {
      // SECURITY: task worktrees materialize AFTER their workspace entry is
      // registered, so creation-time plugin-override sanitization never saw
      // this checkout — a tracked stale `plugin:` enable would re-activate a
      // same-name reinstall's default-disabled MCP server on the first send.
      // Same contract as the host's create/fork paths: sanitize or fail.
      const sanitizeError = await this.workspaceService.sanitizeMaterializedTaskWorkspace(
        plan.taskId,
        workspacePath,
        forkedRuntimeConfig
      );
      if (sanitizeError !== undefined) {
        initLogger.logComplete(-1);
        // Reclaim the just-materialized worktree/session before failing the
        // launch: the throw reaches scheduleReservedTaskLaunch, which only
        // marks the task interrupted — without this cleanup the physical
        // checkout would accumulate and collide with later same-name forks.
        await this.cleanupMaterializedTaskWorkspace(
          runtimeForTaskWorkspace,
          plan.parentMeta.projectPath,
          plan.workspaceName,
          plan.taskId,
          { preservePhysicalWorkspace: false }
        );
        throw new Error(sanitizeError);
      }
    }

    if (sharesParentCheckout) {
      // The parent's checkout is already initialized and live; re-running init would redundantly
      // (and possibly disruptively) mutate it. Skip init entirely.
      initLogger.logStep("Sharing parent workspace (isolation: none) — skipping fork and init");
      initLogger.logComplete(0);
    } else {
      const secrets = await secretsToRecord(
        this.secretsStore.getEffectiveSecrets(plan.parentMeta.projectPath)
      );
      // Registered (not just fired) with the host's abort-and-settlement mechanism:
      // a model-driven archive of this task workspace must be able to cancel the init and
      // must wait for the hook process's actual exit before snapshot capture, checkout
      // deletion, or Coder hooks can proceed (see initSettlementPromises).
      const initAbortController = new AbortController();
      this.workspaceService.registerExternalBackgroundInit(
        plan.taskId,
        initAbortController,
        runBackgroundInit(
          runtimeForTaskWorkspace,
          {
            projectPath: plan.parentMeta.projectPath,
            branchName: plan.workspaceName,
            trunkBranch,
            workspacePath,
            initLogger,
            env: secrets,
            abortSignal: initAbortController.signal,
            skipInitHook: plan.skipInitHook,
            trusted:
              this.config.loadConfigOrDefault().projects.get(plan.configProjectPath)?.trusted ??
              false,
          },
          plan.taskId
        )
      );
    }

    const startOptions = {
      model: plan.taskModelString,
      agentId: plan.agentId,
      thinkingLevel: plan.effectiveThinkingLevel,
      // Inherited pro mode: the send path re-gates per model/route, so this is
      // inert for non-GPT-5.6 task models.
      reasoningMode: plan.effectiveReasoningMode,
      experiments: plan.experiments,
    };
    const sendResult =
      plan.start.kind === "sendMessage"
        ? await this.workspaceService.sendMessage(plan.taskId, plan.start.prompt, startOptions, {
            allowQueuedAgentTask: true,
            agentInitiated: true,
          })
        : await this.workspaceService.resumeStream(plan.taskId, startOptions, {
            allowQueuedAgentTask: true,
            agentInitiated: true,
          });
    if (!sendResult.success) {
      const message =
        typeof sendResult.error === "string"
          ? sendResult.error
          : formatSendMessageError(sendResult.error).message;
      await this.cleanupMaterializedTaskWorkspace(
        runtimeForTaskWorkspace,
        plan.parentMeta.projectPath,
        plan.workspaceName,
        plan.taskId,
        { preservePhysicalWorkspace: sharesParentCheckout }
      );
      throw new Error(message);
    }

    await this.setTaskStatus(plan.taskId, "running");
    this.scheduleMaybeStartQueuedTasks();
  }

  createFromRpc(args: RpcTaskCreateArgs): Promise<Result<TaskCreateResult, string>> {
    return this.create({
      ...args,
      thinkingLevel: normalizeRpcTaskThinkingLevel(args.thinkingLevel),
    });
  }

  async create(args: TaskCreateArgs): Promise<Result<TaskCreateResult, string>> {
    const parentWorkspaceId = coerceNonEmptyString(args.parentWorkspaceId);
    if (!parentWorkspaceId) {
      return Err("Task.create: parentWorkspaceId is required");
    }
    return await this.withTaskTreeLifecycleLock(parentWorkspaceId, async () =>
      this.createUnderTaskTreeLifecycleLock(args, parentWorkspaceId)
    );
  }

  private async createUnderTaskTreeLifecycleLock(
    args: TaskCreateArgs,
    parentWorkspaceId: string
  ): Promise<Result<TaskCreateResult, string>> {
    if (args.kind !== "agent") {
      return Err("Task.create: unsupported kind");
    }

    const prompt = coerceNonEmptyString(args.prompt);
    if (!prompt) {
      return Err("Task.create: prompt is required");
    }

    const normalizedAgentId = normalizeAgentId(args.agentId ?? args.agentType, "");
    if (!normalizedAgentId) {
      return Err("Task.create: agentId is required");
    }

    const parsedAgentId = AgentIdSchema.safeParse(normalizedAgentId);
    if (!parsedAgentId.success) {
      return Err(`Task.create: invalid agentId (${normalizedAgentId})`);
    }

    let normalizedBestOf: TaskCreateArgs["bestOf"];
    const bestOf = args.bestOf;
    if (bestOf) {
      const groupId = coerceNonEmptyString(bestOf.groupId);
      if (!groupId) {
        return Err("Task.create: bestOf.groupId is required when bestOf is provided");
      }
      if (!Number.isInteger(bestOf.index) || bestOf.index < 0) {
        return Err("Task.create: bestOf.index must be a non-negative integer");
      }
      if (!Number.isInteger(bestOf.total) || bestOf.total < 2) {
        return Err("Task.create: bestOf.total must be an integer >= 2");
      }
      if (bestOf.index >= bestOf.total) {
        return Err("Task.create: bestOf.index must be less than bestOf.total");
      }

      normalizedBestOf = {
        groupId,
        index: bestOf.index,
        total: bestOf.total,
      };
    }

    const agentId = parsedAgentId.data;
    const agentType = agentId; // Legacy alias for on-disk compatibility.
    let taskDesktopOwnerWorkspaceId: string | undefined;
    try {
      taskDesktopOwnerWorkspaceId = this.resolveTaskDesktopOwner(args, agentId);
    } catch (error) {
      return Err(getErrorMessage(error));
    }
    const reserveDesktop = <T>(reserve: () => Promise<T>): Promise<T> =>
      taskDesktopOwnerWorkspaceId == null
        ? reserve()
        : this.desktopInputCoordinator.withReservation(
            taskDesktopOwnerWorkspaceId,
            taskId,
            reserve
          );

    await using _lock = await this.mutex.acquire();

    // Validate parent exists and fetch runtime context.
    const parentMetaResult = await this.aiService.getWorkspaceMetadata(parentWorkspaceId);
    if (!parentMetaResult.success) {
      return Err(`Task.create: parent workspace not found (${parentMetaResult.error})`);
    }
    const parentMeta = parentMetaResult.data;

    // Enforce nesting depth.
    const cfg = this.config.loadConfigOrDefault();
    const taskSettings = cfg.taskSettings ?? DEFAULT_TASK_SETTINGS;
    const parentEntry = findWorkspaceEntry(cfg, parentWorkspaceId);
    if (
      parentEntry != null &&
      isWorkspaceArchived(parentEntry.workspace.archivedAt, parentEntry.workspace.unarchivedAt)
    ) {
      return Err("Task.create: parent workspace is archived");
    }
    const parentIsScratch = parentEntry?.workspace.kind === "scratch";
    const configProjectPath = parentIsScratch
      ? SCRATCH_PROJECT_CONFIG_KEY
      : stripTrailingSlashes(parentMeta.projectPath);

    // Trust gate: block task creation for untrusted projects.
    // The frontend shows a confirmation dialog for primary workspace creation,
    // but task spawning bypasses the UI — enforce trust here as defense-in-depth.
    const taskProjectConfig = cfg.projects.get(configProjectPath);
    if (!taskProjectConfig?.trusted) {
      return Err(
        "This project must be trusted before creating workspaces. Trust the project in Settings → Security, or create a workspace from the project page."
      );
    }

    if (
      parentEntry?.workspace.taskStatus === "interrupted" &&
      !isActiveWorkspaceTurnTaskStatus(parentEntry.workspace.taskExecutionStatus)
    ) {
      return Err("Task.create: cannot spawn new tasks after task_stop");
    }

    if (
      parentEntry?.workspace.taskStatus === "reported" &&
      !isActiveWorkspaceTurnTaskStatus(parentEntry.workspace.taskExecutionStatus)
    ) {
      return Err("Task.create: cannot spawn new tasks after agent_report");
    }

    const requestedDepth = this.getTaskDepth(cfg, parentWorkspaceId) + 1;
    if (requestedDepth > taskSettings.maxTaskNestingDepth) {
      return Err(
        `Task.create: maxTaskNestingDepth exceeded (requestedDepth=${requestedDepth}, max=${taskSettings.maxTaskNestingDepth})`
      );
    }

    // Enforce parallelism (global).
    const activeCount =
      this.countActiveAgentTasks(cfg) +
      (await this.getWorkspaceTurnManager().countActiveWorkspaceTurns());
    const shouldQueue = activeCount >= taskSettings.maxParallelAgentTasks;

    const taskId = this.config.generateStableId();
    const workspaceName = buildAgentWorkspaceName(agentId, taskId);

    const nameValidation = validateWorkspaceName(workspaceName);
    if (!nameValidation.valid) {
      return Err(
        `Task.create: generated workspace name invalid (${nameValidation.error ?? "unknown error"})`
      );
    }

    const parentRuntimeConfig = parentMeta.runtimeConfig;
    const taskRuntimeConfig: RuntimeConfig = parentRuntimeConfig;

    // Supply the parent's persisted path so override-aware runtimes (worktree/SSH) resolve the
    // parent's REAL checkout — critical when the parent is itself an isolation: "none" task whose
    // synthetic name has no derived checkout (agent discovery + fork source both depend on it).
    const runtime = createRuntimeForWorkspace({
      runtimeConfig: taskRuntimeConfig,
      projectPath: parentMeta.projectPath,
      name: parentMeta.name,
      namedWorkspacePath: coerceNonEmptyString(parentEntry?.workspace.path),
    });

    // Validate the agent definition exists and is runnable as a sub-agent.
    // Prefer the parent's persisted checkout path over the name-derived one: when the parent is
    // itself an isolation: "none" task, its name is synthetic and the derived path does not exist —
    // its real checkout is the persisted (shared) path. Persisted paths are canonical elsewhere too
    // (see runtimeHelpers.resolveWorkspaceRootPath).
    const isInPlace = parentMeta.projectPath === parentMeta.name;
    const parentWorkspacePath = isInPlace
      ? parentMeta.projectPath
      : (coerceNonEmptyString(parentEntry?.workspace.path) ??
        runtime.getWorkspacePath(parentMeta.projectPath, parentMeta.name));

    // isolation: "none" — run the sub-agent directly in the parent workspace's checkout instead of
    // forking a new one. Only honored on runtimes where the fork creates a separate checkout we can
    // safely bypass (worktree/SSH) and for single-project parents; otherwise fall back to forking.
    const taskRuntimeMode = getRuntimeType(taskRuntimeConfig);
    const parentIsMultiProject = (parentMeta.projects?.length ?? 0) > 1;
    const useSharedWorkspace =
      parentIsScratch ||
      (args.isolation === "none" &&
        runtimeModeSupportsSharedTaskWorkspace(taskRuntimeMode) &&
        !parentIsMultiProject);
    // The branch actually checked out in the parent's checkout. When the parent is itself an
    // isolation: "none" task, parentMeta.name is a synthetic agent workspace name with no real
    // branch — the shared checkout sits on the parent's own persisted taskTrunkBranch. Persisting
    // the real branch keeps dequeue fork-fallbacks (preferredTrunkBranch) on an existing base.
    const parentIsSharedTask = parentEntry?.workspace.taskIsolation === "none";
    const parentBranchName = parentIsSharedTask
      ? (coerceNonEmptyString(parentEntry?.workspace.taskTrunkBranch) ??
        coerceNonEmptyString(parentMeta.name))
      : coerceNonEmptyString(parentMeta.name);
    if (args.isolation === "none" && !useSharedWorkspace) {
      log.debug("Task.create: isolation=none not honored; falling back to fork", {
        taskId,
        runtimeMode: taskRuntimeMode,
        parentIsMultiProject,
      });
    }

    // Helper to build error hint with all available runnable agents.
    // NOTE: This resolves frontmatter inheritance so same-name overrides (e.g. project exec.md
    // with base: exec) still count as runnable.
    const getRunnableHint = async (): Promise<string> => {
      try {
        const allAgents = await discoverAgentDefinitions(runtime, parentWorkspacePath);

        const runnableIds = (
          await Promise.all(
            allAgents.map(async (agent) => {
              try {
                const frontmatter = await resolveAgentFrontmatter(
                  runtime,
                  parentWorkspacePath,
                  agent.id,
                  {
                    skipScopesAbove: getSkipScopesAboveForKnownScope(agent.scope),
                  }
                );
                if (
                  !isAgentRunnableAsChild(frontmatter, {
                    workflowOwned: args.workflowTask != null,
                  })
                ) {
                  return null;
                }

                const effectivelyDisabled = isAgentEffectivelyDisabled({
                  cfg,
                  agentId: agent.id,
                  resolvedFrontmatter: frontmatter,
                });
                return effectivelyDisabled ? null : agent.id;
              } catch {
                return null;
              }
            })
          )
        ).filter((id): id is string => typeof id === "string");

        return runnableIds.length > 0
          ? `Runnable agentIds: ${runnableIds.join(", ")}`
          : "No runnable agents available";
      } catch {
        return "Could not discover available agents";
      }
    };

    let skipInitHook = false;
    try {
      const frontmatter = await resolveAgentFrontmatter(runtime, parentWorkspacePath, agentId);
      if (!isAgentRunnableAsChild(frontmatter, { workflowOwned: args.workflowTask != null })) {
        const hint = await getRunnableHint();
        return Err(`Task.create: agentId is not runnable as a sub-agent (${agentId}). ${hint}`);
      }

      if (
        isAgentEffectivelyDisabled({
          cfg,
          agentId,
          resolvedFrontmatter: frontmatter,
        })
      ) {
        const hint = await getRunnableHint();
        return Err(`Task.create: agentId is disabled (${agentId}). ${hint}`);
      }
      skipInitHook = frontmatter.subagent?.skip_init_hook === true;
    } catch {
      const hint = await getRunnableHint();
      return Err(`Task.create: unknown agentId (${agentId}). ${hint}`);
    }

    let taskModelString: string;
    let canonicalModel: string;
    let effectiveThinkingLevel: ThinkingLevel;
    let effectiveReasoningMode: OpenAIReasoningMode | undefined;
    try {
      ({ taskModelString, canonicalModel, effectiveThinkingLevel, effectiveReasoningMode } =
        await this.resolveTaskAISettings({
          cfg,
          parentWorkspaceId,
          parentMeta,
          agentId,
          modelString: args.modelString,
          thinkingLevel: args.thinkingLevel,
          parentRuntimeAiSettings: args.parentRuntimeAiSettings,
          definitionContext: {
            runtime,
            workspacePath: parentWorkspacePath,
            workspaceId: parentWorkspaceId,
            includeAgentPlugins: this.workspaceService.isExperimentEnabled(
              EXPERIMENT_IDS.AGENT_PLUGINS
            ),
          },
        }));
    } catch (error) {
      if (error instanceof InvalidExplicitAiSettingError) {
        return Err(`Task.create: ${error.message}`);
      }
      throw error;
    }

    const createdAt = getIsoNow();

    taskQueueDebug("TaskService.create decision", {
      parentWorkspaceId,
      taskId,
      agentId,
      workspaceName,
      createdAt,
      activeCount,
      maxParallelAgentTasks: taskSettings.maxParallelAgentTasks,
      shouldQueue,
      runtimeType: taskRuntimeConfig.type,
      workflowRunId: args.workflowTask?.runId,
      workflowStepId: args.workflowTask?.stepId,
      promptLength: prompt.length,
      model: taskModelString,
      thinkingLevel: effectiveThinkingLevel,
    });

    if (shouldQueue) {
      const trunkBranch = parentBranchName;
      if (!trunkBranch) {
        return Err("Task.create: parent workspace name missing (cannot queue task)");
      }

      // NOTE: Queued tasks are persisted immediately, but their workspace is created later
      // when a parallel slot is available. This ensures queued tasks don't create worktrees
      // or run init hooks until they actually start.
      // Shared-workspace (isolation: "none") tasks point at the parent's existing checkout, so the
      // dequeue path sees the directory already exists and skips fork + init.
      const workspacePath = useSharedWorkspace
        ? parentWorkspacePath
        : runtime.getWorkspacePath(parentMeta.projectPath, workspaceName);

      taskQueueDebug("TaskService.create queued (persist-only)", {
        taskId,
        workspaceName,
        parentWorkspaceId,
        trunkBranch,
        workspacePath,
      });

      try {
        await reserveDesktop(async () => {
          await this.config.editConfig((config) => {
            let projectConfig = config.projects.get(configProjectPath);
            if (!projectConfig) {
              projectConfig = { workspaces: [] };
              config.projects.set(configProjectPath, projectConfig);
            }

            projectConfig.workspaces.push({
              kind: parentIsScratch ? "scratch" : undefined,
              path: workspacePath,
              id: taskId,
              name: workspaceName,
              title: args.title,
              createdAt,
              runtimeConfig: taskRuntimeConfig,
              aiSettings: {
                model: canonicalModel,
                thinkingLevel: effectiveThinkingLevel,
                ...(effectiveReasoningMode != null
                  ? { reasoningMode: effectiveReasoningMode }
                  : {}),
              },
              parentWorkspaceId,
              agentId,
              agentType,
              workflowTask: args.workflowTask,
              bestOf: normalizedBestOf,
              taskStatus: "queued",
              taskPrompt: prompt,
              taskTrunkBranch: trunkBranch,
              taskModelString,
              taskThinkingLevel: effectiveThinkingLevel,
              taskOnRefusal: args.onRefusal,
              taskExperiments: withLegacyPtcExclusiveMirror(args.experiments),
              taskIsolation: useSharedWorkspace ? "none" : undefined,
              taskAttentionPolicy: args.attentionPolicy,
              taskDesktopOwnerWorkspaceId,
              projects: parentMeta.projects,
            });
            this.desktopInputCoordinator.assertAdmission(config, taskId);
            return config;
          });
        });
      } catch (error) {
        return Err(getErrorMessage(error));
      }

      // Emit metadata update so the UI sees the workspace immediately.
      await this.emitWorkspaceMetadata(taskId);

      // NOTE: Do NOT persist the prompt into chat history until the task actually starts.
      // Otherwise the frontend treats "last message is user" as an interrupted stream and
      // will auto-retry / backoff-spam resume attempts while the task is queued.
      taskQueueDebug("TaskService.create queued persisted (prompt stored in config)", {
        taskId,
        workspaceName,
      });

      // Schedule queue processing (best-effort).
      void this.maybeStartQueuedTasks();
      taskQueueDebug("TaskService.create queued scheduled maybeStartQueuedTasks", { taskId });
      return Ok({
        taskId,
        kind: "agent",
        status: "queued",
        modelString: taskModelString,
        thinkingLevel: effectiveThinkingLevel,
        desktopOwnerWorkspaceId: taskDesktopOwnerWorkspaceId ?? taskId,
      });
    }

    // Set once a checkout exists for this task: a throw after that point (base-SHA read, config
    // persistence) must roll the checkout back instead of leaking it like an unhandled rejection.
    let materializedCheckout: { initLogger: InitLogger; runtime: Runtime } | undefined;
    const materialize = async () => {
      const initLogger = this.startWorkspaceInit(taskId, parentMeta.projectPath);

      let workspacePath: string;
      let trunkBranch: string;
      let forkedRuntimeConfig: RuntimeConfig;
      let runtimeForTaskWorkspace: Runtime;
      let forkedFromSource: boolean;
      let inheritedProjects: ProjectRef[] | undefined;

      if (useSharedWorkspace) {
        // isolation: "none" — run the sub-agent directly in the parent workspace's checkout instead
        // of forking. Mirrors local-runtime semantics for worktree/SSH so read-only analysis (or
        // prompt-isolated work) skips the fork + init overhead and sees the parent's uncommitted work.
        //
        // SAFETY: the task still gets a unique workspace name, and workspace deletion is keyed on that
        // name (runtime.deleteWorkspace(projectPath, name)), so removing this task never deletes the
        // shared parent checkout. workspaceService.remove additionally skips physical deletion for
        // tasks persisted with taskIsolation === "none".
        workspacePath = parentWorkspacePath;
        trunkBranch = parentBranchName ?? "main";
        forkedRuntimeConfig = parentRuntimeConfig;
        forkedFromSource = false;
        inheritedProjects = parentMeta.projects;
        // Build the runtime with the child's identity but the parent's checkout path. Worktree/SSH
        // runtimes honor this persisted path override (see *Runtime.getWorkspacePath), so cwd
        // resolution and ensureReady land in the shared parent checkout instead of a name-derived
        // directory that was never created. This mirrors the runtime rebuilt from the persisted entry.
        runtimeForTaskWorkspace = createRuntimeForWorkspace({
          runtimeConfig: parentRuntimeConfig,
          projectPath: parentMeta.projectPath,
          name: workspaceName,
          namedWorkspacePath: parentWorkspacePath,
        });
        initLogger.logStep("Sharing parent workspace (isolation: none) — skipping fork and init");
        initLogger.logComplete(0);
      } else {
        // Note: Local project-dir runtimes share the same directory (unsafe by design).
        // For worktree/ssh runtimes we attempt a fork first; otherwise fall back to createWorkspace.
        const forkResult = await orchestrateFork({
          sourceRuntime: runtime,
          projectPath: parentMeta.projectPath,
          sourceWorkspaceName: parentMeta.name,
          newWorkspaceName: workspaceName,
          initLogger,
          config: this.config,
          sourceWorkspaceId: parentWorkspaceId,
          sourceRuntimeConfig: parentRuntimeConfig,
          parentMetadata: parentMeta,
          allowCreateFallback: true,
          // Create-fallback base when the fork cannot detect a source branch — a shared parent's
          // synthetic name never names a real branch, so supply the actual checked-out branch.
          // Gated to shared parents to keep the existing branch-discovery fallback otherwise.
          ...(parentIsSharedTask && parentBranchName != null
            ? { preferredTrunkBranch: parentBranchName }
            : {}),
          trusted:
            this.config.loadConfigOrDefault().projects.get(configProjectPath)?.trusted ?? false,
          multiProjectExperimentEnabled: this.workspaceService.isExperimentEnabled(
            EXPERIMENT_IDS.MULTI_PROJECT_WORKSPACES
          ),
        });

        if (forkResult.success && forkResult.data.sourceRuntimeConfigUpdate) {
          await this.config.updateWorkspaceMetadata(parentWorkspaceId, {
            runtimeConfig: forkResult.data.sourceRuntimeConfigUpdate,
          });
          // Ensure UI gets the updated runtimeConfig for the parent workspace.
          await this.emitWorkspaceMetadata(parentWorkspaceId);
        }

        if (!forkResult.success) {
          initLogger.logComplete(-1);
          return Err(`Task fork failed: ${forkResult.error}`);
        }

        workspacePath = forkResult.data.workspacePath;
        trunkBranch = forkResult.data.trunkBranch;
        forkedRuntimeConfig = forkResult.data.forkedRuntimeConfig;
        runtimeForTaskWorkspace = forkResult.data.targetRuntime;
        forkedFromSource = forkResult.data.forkedFromSource;
        inheritedProjects = forkResult.data.projects;
      }

      materializedCheckout = { initLogger, runtime: runtimeForTaskWorkspace };

      // Multi-project forks need per-project secrets for each runtime's init hook.
      this.configureMultiProjectRuntimeEnvResolver(runtimeForTaskWorkspace);

      const taskBaseCommitShaByProjectPath = await readTaskBaseCommitShaByProjectPath({
        workspaceId: taskId,
        workspaceName,
        workspacePath,
        runtimeConfig: forkedRuntimeConfig,
        projectPath: parentMeta.projectPath,
        projectName: parentMeta.projectName,
        projects: inheritedProjects,
        runtime: runtimeForTaskWorkspace,
      });
      const taskBaseCommitSha = taskBaseCommitShaByProjectPath[parentMeta.projectPath];

      taskQueueDebug("TaskService.create started (workspace created)", {
        taskId,
        workspaceName,
        workspacePath,
        trunkBranch,
        forkSuccess: forkedFromSource,
      });

      // Persist workspace entry before starting work so it's durable across crashes.
      await this.config.editConfig((config) => {
        let projectConfig = config.projects.get(configProjectPath);
        if (!projectConfig) {
          projectConfig = { workspaces: [] };
          config.projects.set(configProjectPath, projectConfig);
        }

        projectConfig.workspaces.push({
          kind: parentIsScratch ? "scratch" : undefined,
          path: workspacePath,
          id: taskId,
          name: workspaceName,
          title: args.title,
          createdAt,
          runtimeConfig: forkedRuntimeConfig,
          aiSettings: {
            model: canonicalModel,
            thinkingLevel: effectiveThinkingLevel,
            ...(effectiveReasoningMode != null ? { reasoningMode: effectiveReasoningMode } : {}),
          },
          agentId,
          parentWorkspaceId,
          agentType,
          workflowTask: args.workflowTask,
          bestOf: normalizedBestOf,
          taskStatus: "running",
          taskTrunkBranch: trunkBranch,
          taskBaseCommitSha: taskBaseCommitSha ?? undefined,
          taskBaseCommitShaByProjectPath,
          taskModelString,
          taskThinkingLevel: effectiveThinkingLevel,
          taskOnRefusal: args.onRefusal,
          taskExperiments: withLegacyPtcExclusiveMirror(args.experiments),
          taskIsolation: useSharedWorkspace ? "none" : undefined,
          taskAttentionPolicy: args.attentionPolicy,
          taskDesktopOwnerWorkspaceId,
          projects: inheritedProjects,
        });
        this.desktopInputCoordinator.assertAdmission(config, taskId);
        return config;
      });

      return Ok({
        initLogger,
        workspacePath,
        trunkBranch,
        forkedRuntimeConfig,
        runtimeForTaskWorkspace,
      });
    };
    const materialized = await reserveDesktop(materialize).catch((error: unknown) =>
      Err(getErrorMessage(error))
    );
    if (!materialized.success) {
      if (materializedCheckout != null) {
        // Runs after the desktop gate released: only the checkout and any persisted entry (which
        // would otherwise hold the desktop reservation as a running child) need to go.
        await this.rollbackFailedTaskCreate(
          materializedCheckout.runtime,
          parentMeta.projectPath,
          workspaceName,
          taskId,
          { preservePhysicalWorkspace: useSharedWorkspace }
        );
        materializedCheckout.initLogger.logComplete(-1);
      }
      return materialized;
    }
    const { initLogger, workspacePath, trunkBranch, forkedRuntimeConfig, runtimeForTaskWorkspace } =
      materialized.data;

    if (!useSharedWorkspace) {
      // SECURITY: this checkout materialized outside the host's create/fork paths, so
      // registration-time plugin-override sanitization never saw it —
      // a tracked stale `plugin:` enable would re-activate a same-name
      // reinstall's default-disabled MCP server on the send below. Runs
      // BEFORE emitWorkspaceMetadata (the pre-announcement invariant of
      // normal workspace creation): once metadata is emitted, the UI or any
      // subscriber can send to this running-status task workspace while
      // sanitization is still waiting on the override lock.
      const sanitizeError = await this.workspaceService.sanitizeMaterializedTaskWorkspace(
        taskId,
        workspacePath,
        forkedRuntimeConfig
      );
      if (sanitizeError !== undefined) {
        await this.rollbackFailedTaskCreate(
          runtimeForTaskWorkspace,
          parentMeta.projectPath,
          workspaceName,
          taskId
        );
        initLogger.logComplete(-1);
        return Err(sanitizeError);
      }
    }

    // Emit metadata update so the UI sees the workspace immediately.
    await this.emitWorkspaceMetadata(taskId);

    // Kick init (best-effort, async). Shared-workspace (isolation: "none") tasks reuse the parent's
    // already-initialized checkout, so re-running init would redundantly (and possibly disruptively)
    // mutate the live parent workspace — skip it entirely.
    if (!useSharedWorkspace) {
      const secrets = await secretsToRecord(
        this.secretsStore.getEffectiveSecrets(parentMeta.projectPath)
      );
      // Registered (not just fired) with the host's abort-and-settlement mechanism:
      // a model-driven archive of this task workspace must be able to cancel the init and
      // must wait for the hook process's actual exit before snapshot capture, checkout
      // deletion, or Coder hooks can proceed (see initSettlementPromises).
      const initAbortController = new AbortController();
      this.workspaceService.registerExternalBackgroundInit(
        taskId,
        initAbortController,
        runBackgroundInit(
          runtimeForTaskWorkspace,
          {
            projectPath: parentMeta.projectPath,
            branchName: workspaceName,
            trunkBranch,
            workspacePath,
            initLogger,
            env: secrets,
            abortSignal: initAbortController.signal,
            skipInitHook,
            trusted:
              this.config.loadConfigOrDefault().projects.get(configProjectPath)?.trusted ?? false,
          },
          taskId
        )
      );
    }

    // Start immediately (counts towards parallel limit).
    const sendResult = await this.workspaceService
      .sendMessage(
        taskId,
        prompt,
        {
          model: taskModelString,
          agentId,
          thinkingLevel: effectiveThinkingLevel,
          reasoningMode: effectiveReasoningMode,
          experiments: args.experiments,
        },
        { agentInitiated: true }
      )
      .catch((error: unknown) => Err(getErrorMessage(error)));
    if (!sendResult.success) {
      const message =
        typeof sendResult.error === "string"
          ? sendResult.error
          : formatSendMessageError(sendResult.error).message;
      await this.rollbackFailedTaskCreate(
        runtimeForTaskWorkspace,
        parentMeta.projectPath,
        workspaceName,
        taskId,
        { preservePhysicalWorkspace: useSharedWorkspace }
      );
      return Err(message);
    }

    return Ok({
      taskId,
      kind: "agent",
      status: "running",
      modelString: taskModelString,
      thinkingLevel: effectiveThinkingLevel,
      desktopOwnerWorkspaceId: taskDesktopOwnerWorkspaceId ?? taskId,
    });
  }

  async retitleDescendantAgentTask(
    ancestorWorkspaceId: string,
    taskId: string,
    title: string
  ): Promise<Result<RetitleAgentTaskResult, RetitleAgentTaskError>> {
    assert(ancestorWorkspaceId.length > 0, "retitleDescendantAgentTask: ancestor ID is required");
    assert(taskId.length > 0, "retitleDescendantAgentTask: task ID is required");
    const trimmedTitle = title.trim();
    assert(trimmedTitle.length > 0, "retitleDescendantAgentTask: title is required");

    return await this.withTaskTreeLifecycleLock(taskId, async () => {
      const cfg = this.config.loadConfigOrDefault();
      const entry = findWorkspaceEntry(cfg, taskId);
      if (entry == null) {
        return Err({ code: "not_found" as const });
      }

      const index = this.buildAgentTaskIndex(cfg);
      if (
        !this.isDescendantAgentTaskUsingParentById(index.parentById, ancestorWorkspaceId, taskId) ||
        this.isWorkflowOwnedTaskUsingIndex(index, taskId)
      ) {
        return Err({ code: "invalid_scope" as const });
      }

      const result = await this.workspaceService.updateTitle(taskId, trimmedTitle);
      if (!result.success) {
        return Err({ code: "update_failed" as const, message: result.error });
      }
      return Ok({ title: trimmedTitle });
    });
  }

  async sendMessageToDescendantAgentTask(
    ancestorWorkspaceId: string,
    taskId: string,
    message: string,
    queueDispatchMode: TaskMessageQueueDispatchMode,
    options?: {
      /** Transcript label prefixed to the delivered message. */
      messageLabel?: string;
      /**
       * Synthetic assistant rows delivered atomically with the message through queued prompt
       * updates, reactivation, or live turn admission.
       */
      preTurnMessages?: MuxMessage[];
      /** Invoked as soon as the pre-turn rows are durably persisted. */
      onPreTurnPersisted?: () => void;
    }
  ): Promise<Result<SendAgentTaskMessageResult, SendAgentTaskMessageError>> {
    assert(
      ancestorWorkspaceId.length > 0,
      "sendMessageToDescendantAgentTask: ancestorWorkspaceId must be non-empty"
    );
    assert(taskId.length > 0, "sendMessageToDescendantAgentTask: taskId must be non-empty");
    return this.sendTreeMessage({
      relation: "descendant",
      senderWorkspaceId: ancestorWorkspaceId,
      targetId: taskId,
      message,
      queueDispatchMode,
      options,
    });
  }

  /**
   * Trusted ancestor guidance keeps its dedicated lifecycle machinery: queued prompt splice,
   * inactive-task reactivation, and durable live-guidance reservation.
   */
  private async dispatchTrustedDescendantMessage(
    ancestorWorkspaceId: string,
    taskId: string,
    trimmedMessage: string,
    queueDispatchMode: TaskMessageQueueDispatchMode,
    options?: TrustedDescendantMessageOptions
  ): Promise<Result<SendAgentTaskMessageResult, SendAgentTaskMessageError>> {
    const messageLabel = options?.messageLabel ?? "Updated guidance from parent";
    // Keep the labeled message explicit in the child transcript so it cannot be confused
    // with the original brief, whoever the sender is.
    const labeledMessage = renderLabeledTaskMessage(messageLabel, trimmedMessage);

    const queuedUpdateResult = await (async (): Promise<
      Result<SendAgentTaskMessageResult | null, SendAgentTaskMessageError>
    > => {
      // The scheduler snapshots taskPrompt and flips queued -> starting under this mutex. Use the
      // same lock so a correction is either included in that snapshot or observes starting and is
      // rejected; it can never be persisted after the scheduler already captured a stale prompt.
      await using _lock = await this.mutex.acquire();
      const cfg = this.config.loadConfigOrDefault();
      const entry = findWorkspaceEntry(cfg, taskId);
      if (!entry) {
        return Err({ code: "not_found" as const });
      }
      const taskIndex = this.buildAgentTaskIndex(cfg);
      if (
        !this.isDescendantAgentTaskUsingParentById(
          taskIndex.parentById,
          ancestorWorkspaceId,
          taskId
        )
      ) {
        return Err({ code: "invalid_scope" as const });
      }
      if (entry.workspace.taskStatus !== "queued") {
        return Ok(null);
      }
      if (isWorkspaceArchived(entry.workspace.archivedAt, entry.workspace.unarchivedAt)) {
        return Ok(null);
      }

      const initialPrompt = coerceNonEmptyString(entry.workspace.taskPrompt);
      if (!initialPrompt) {
        return Err({
          code: "send_failed" as const,
          message: "Queued task has no durable prompt to update.",
        });
      }
      // While the entry is still queued under the scheduler mutex, no prompt
      // send can be mid-admission (the scheduler flips queued -> starting
      // under this same mutex before sending), so a direct durable append
      // cannot land inside a PREPARING window; the rows precede the future
      // prompt row. Persisted before the splice: a splice failure leaves an
      // untriggered untrusted-labeled row behind (charge kept), never a
      // refunded-but-persisted one.
      if (options?.preTurnMessages != null && options.preTurnMessages.length > 0) {
        const appendOutcome = await this.appendFamilyPayloadRows(
          taskId,
          options.preTurnMessages,
          options.onPreTurnPersisted
        );
        if (!appendOutcome.success) {
          return appendOutcome;
        }
      }
      await this.editWorkspaceEntry(taskId, (workspace) => {
        workspace.taskPrompt = `${initialPrompt}\n\n${labeledMessage}`;
      });
      return Ok({ delivery: "queued" as const });
    })();
    if (!queuedUpdateResult.success) {
      return queuedUpdateResult;
    }
    if (queuedUpdateResult.data != null) {
      return Ok(queuedUpdateResult.data);
    }

    return this.withTaskTreeLifecycleLock(taskId, async () =>
      this.workspaceEventLocks.withLock(taskId, async () => {
        const cfg = this.config.loadConfigOrDefault();
        const entry = findWorkspaceEntry(cfg, taskId);
        if (!entry) {
          return Err({ code: "not_found" as const });
        }
        const taskIndex = this.buildAgentTaskIndex(cfg);
        if (
          !this.isDescendantAgentTaskUsingParentById(
            taskIndex.parentById,
            ancestorWorkspaceId,
            taskId
          )
        ) {
          return Err({ code: "invalid_scope" as const });
        }

        const currentExecution =
          entry.workspace.taskExecutionId != null
            ? ((await this.getDescendantAgentTaskExecutionSnapshot(ancestorWorkspaceId, taskId))
                ?.record ?? null)
            : null;
        const continuationActive = isActiveWorkspaceTurnTaskStatus(currentExecution?.status);
        const legacyArchived = isWorkspaceArchived(
          entry.workspace.archivedAt,
          entry.workspace.unarchivedAt
        );
        if (
          !continuationActive &&
          (entry.workspace.taskStatus === "reported" ||
            entry.workspace.taskStatus === "interrupted" ||
            legacyArchived) &&
          !this.aiService.isStreaming(taskId)
        ) {
          const unarchiveResult = await this.unarchiveAgentTaskAncestry(
            ancestorWorkspaceId,
            taskId
          );
          if (!unarchiveResult.success) {
            return Err({ code: "send_failed" as const, message: unarchiveResult.error });
          }
          const refreshedEntry = findWorkspaceEntry(this.config.loadConfigOrDefault(), taskId);
          if (refreshedEntry == null) {
            return Err({ code: "not_found" as const });
          }
          // Verified above: not streaming and no active continuation, and
          // concurrent task-machinery sends serialize on the lifecycle + event
          // locks held here, so no task-driven turn admission can be in flight
          // during this append; the rows precede the reactivation prompt row
          // createWorkspaceTurn sends. A createWorkspaceTurn failure leaves an
          // untriggered untrusted-labeled row behind (charge kept).
          if (options?.preTurnMessages != null && options.preTurnMessages.length > 0) {
            const appendOutcome = await this.appendFamilyPayloadRows(
              taskId,
              options.preTurnMessages,
              options.onPreTurnPersisted
            );
            if (!appendOutcome.success) {
              return appendOutcome;
            }
          }
          const preservedQueuedPrompt = coerceNonEmptyString(refreshedEntry.workspace.taskPrompt);
          const execution = await this.getWorkspaceTurnManager().createWorkspaceTurn({
            ownerWorkspaceId: ancestorWorkspaceId,
            prompt: preservedQueuedPrompt
              ? `${preservedQueuedPrompt}\n\n${labeledMessage}`
              : labeledMessage,
            title:
              coerceNonEmptyString(refreshedEntry.workspace.title) ??
              coerceNonEmptyString(refreshedEntry.workspace.name) ??
              "Sub-agent",
            workspace: { mode: "existing", workspaceId: taskId, queueDispatchMode },
            allowAgentWorkspace: true,
            attentionPolicy: "notify_on_terminal",
          });
          if (!execution.success) {
            return Err({ code: "send_failed" as const, message: execution.error });
          }
          return Ok({
            delivery: "reactivated" as const,
            executionTaskId: execution.data.taskId,
          });
        }

        if (isWorkspaceArchived(entry.workspace.archivedAt, entry.workspace.unarchivedAt)) {
          return Err({
            code: "not_active" as const,
            taskStatus: entry.workspace.taskStatus ?? "unknown",
            message:
              "Task workspace is archived; retry task_send_message to restore and reawaken it.",
          });
        }

        // Missing status is a legacy running task. A reported/interrupted agent workspace may also
        // have an active follow-up workspace-turn execution; its live stream accepts steering here.
        const previousStatus = entry.workspace.taskStatus ?? "running";
        if (
          previousStatus !== "running" &&
          previousStatus !== "awaiting_report" &&
          !this.aiService.isStreaming(taskId) &&
          !continuationActive
        ) {
          return Err({ code: "not_active" as const, taskStatus: previousStatus ?? "unknown" });
        }

        const guidanceId = randomUUID();
        await this.editActiveWorkspaceEntry(
          taskId,
          (workspace) => {
            workspace.taskPendingGuidance = [
              ...(workspace.taskPendingGuidance ?? []),
              {
                id: guidanceId,
                // Startup-recovery replay presents reservations as parent guidance, so
                // non-default labels (sibling messages) must keep their attribution in
                // the durable record.
                message: options?.messageLabel != null ? labeledMessage : trimmedMessage,
                queueDispatchMode,
              },
            ];
            if (workspace.taskStatus == null || previousStatus === "awaiting_report") {
              // Persist the legacy implicit-running state so startup recovery can replay this durable
              // guidance if Xum exits before the replacement turn accepts it.
              workspace.taskStatus = "running";
            }
          },
          { allowMissing: true }
        );

        const clearGuidanceReservation = async (restoreAfterFailure: boolean): Promise<void> => {
          await this.editWorkspaceEntry(
            taskId,
            (workspace) => {
              const remainingGuidance = (workspace.taskPendingGuidance ?? []).filter(
                (guidance) => guidance.id !== guidanceId
              );
              workspace.taskPendingGuidance =
                remainingGuidance.length > 0 ? remainingGuidance : undefined;
              if (
                restoreAfterFailure &&
                remainingGuidance.length === 0 &&
                workspace.taskStatus === "running"
              ) {
                workspace.taskStatus = this.aiService.isStreaming(taskId)
                  ? previousStatus
                  : "awaiting_report";
              }
            },
            { allowMissing: true }
          );
        };

        const activeAgentId = resolveTaskAgentIdForResume(entry.workspace);
        const activeAiSettings = this.resolveWorkspaceAISettings(entry.workspace, activeAgentId);
        // Parent guidance continues the delegated execution, rather than superseding it and
        // stranding its report. Use the normal continuation guards for earlier manual input.
        const workspaceTurnMuxMetadata =
          await this.getWorkspaceTurnManager().getActiveWorkspaceTurnMuxMetadataForWorkspace(
            taskId
          );
        let accepted = false;
        const sendResult = await this.workspaceService.sendMessage(
          taskId,
          // Synthetic metadata avoids treating parent/sibling orchestration as a direct human
          // intervention in child-only features such as goals and interactive questions.
          labeledMessage,
          {
            model:
              coerceNonEmptyString(activeAiSettings?.model) ??
              entry.workspace.taskModelString ??
              defaultModel,
            agentId: activeAgentId,
            thinkingLevel: activeAiSettings?.thinkingLevel ?? entry.workspace.taskThinkingLevel,
            reasoningMode: coerceOpenAIReasoningMode(activeAiSettings?.reasoningMode),
            experiments: entry.workspace.taskExperiments,
            queueDispatchMode,
            ...(workspaceTurnMuxMetadata != null ? { muxMetadata: workspaceTurnMuxMetadata } : {}),
          },
          {
            synthetic: true,
            agentInitiated: true,
            startStreamInBackground: true,
            workspaceTurnContinuation: workspaceTurnMuxMetadata != null,
            ...(workspaceTurnMuxMetadata != null
              ? {
                  onCanceled: async (reason: string) => {
                    await clearGuidanceReservation(true);
                    await this.getWorkspaceTurnManager().settleWorkspaceTurnContinuationFailure(
                      taskId,
                      workspaceTurnMuxMetadata,
                      "interrupted",
                      reason
                    );
                  },
                }
              : {}),
            // Live target: pre-turn rows ride the send through AgentSession
            // turn admission (queued with the trigger when the target is busy).
            preTurnMessages: options?.preTurnMessages,
            onAcceptedPreStreamFailure: async (error: SendMessageError) => {
              // If the replacement turn cannot start, remove the settlement reservation and restore
              // an idle child to completion recovery instead of leaving it permanently running.
              await clearGuidanceReservation(true);
              if (workspaceTurnMuxMetadata != null) {
                await this.getWorkspaceTurnManager().settleWorkspaceTurnContinuationFailure(
                  taskId,
                  workspaceTurnMuxMetadata,
                  "error",
                  formatSendMessageError(error).message
                );
              }
            },
            onAccepted: async () => {
              await clearGuidanceReservation(false);
              accepted = true;
            },
            // r54: persistence is signaled at the rollback horizon, not at
            // acceptance — acceptance can fail after the pre-turn batch is
            // already irrevocable, and the budget charge must stick then.
            onPreTurnRowsPersisted: () => {
              options?.onPreTurnPersisted?.();
            },
          }
        );

        if (!sendResult.success) {
          await clearGuidanceReservation(true);
          return Err({
            code: "send_failed" as const,
            message: formatSendMessageError(sendResult.error).message,
          });
        }

        return Ok(accepted ? { delivery: "accepted" } : { delivery: "queued", queueDispatchMode });
      })
    );
  }

  /**
   * Append family payload rows directly to a target's durable history for the
   * delivery paths with no live turn admission (queued splice, reactivation).
   * `onPersisted` fires before the chat events so budget accounting observes
   * persistence first; a mid-loop failure rolls earlier rows back (best
   * effort) so the caller can treat the failure as nothing-persisted.
   */
  private async appendFamilyPayloadRows(
    targetWorkspaceId: string,
    rows: MuxMessage[],
    onPersisted?: () => void
  ): Promise<Result<void, SendAgentTaskMessageError>> {
    assert(rows.length > 0, "appendFamilyPayloadRows: rows must be non-empty");
    const appendedIds: string[] = [];
    for (const row of rows) {
      const appendResult = await this.historyService.appendToHistory(targetWorkspaceId, row);
      if (!appendResult.success) {
        if (appendedIds.length > 0) {
          await this.historyService.deleteMessages(targetWorkspaceId, appendedIds);
        }
        return Err({ code: "send_failed" as const, message: appendResult.error });
      }
      appendedIds.push(row.id);
    }
    onPersisted?.();
    for (const row of rows) {
      this.workspaceService.emitChatEvent(targetWorkspaceId, { ...row, type: "message" });
    }
    return Ok(undefined);
  }

  /**
   * Routes a task_send_message send by the target's relation to the sender within one task tree.
   * Descendant targets take the unchanged trusted guidance path (framing, reactivation, durable
   * pending guidance); siblings/cousins and ancestors (including the root workspace) receive an
   * untrusted <mux_agent_message> envelope. The relation is computed server-side so a sender can
   * never claim parent authority it does not have.
   */
  async sendAgentTreeMessage(
    senderWorkspaceId: string,
    targetId: string,
    message: string,
    queueDispatchMode?: TaskMessageQueueDispatchMode
  ): Promise<
    Result<
      SendAgentTaskMessageResult & { relation: AgentTreeTargetRelation },
      SendAgentTreeMessageError
    >
  > {
    assert(
      senderWorkspaceId.length > 0,
      "sendAgentTreeMessage: senderWorkspaceId must be non-empty"
    );
    assert(targetId.length > 0, "sendAgentTreeMessage: targetId must be non-empty");
    const trimmedMessage = message.trim();
    assert(trimmedMessage.length > 0, "sendAgentTreeMessage: message must be non-empty");

    const cfg = this.config.loadConfigOrDefault();
    const relation = this.resolveAgentTreeTargetRelation(
      this.buildAgentTaskIndex(cfg).parentById,
      senderWorkspaceId,
      targetId
    );
    if (relation == null) {
      // Cross-tree targets and self-sends are out of scope for tree messaging.
      return Err({ code: "invalid_scope" as const });
    }

    if (relation === "target_descendant") {
      const result = await this.sendTreeMessage({
        relation: "descendant",
        senderWorkspaceId,
        targetId,
        message,
        queueDispatchMode: queueDispatchMode ?? "tool-end",
      });
      return result.success ? Ok({ ...result.data, relation }) : result;
    }

    return this.sendTreeMessage({
      relation: "peer",
      senderWorkspaceId,
      targetId,
      message,
      targetRelation: relation,
      queueDispatchMode,
    });
  }

  private async sendFamilyTreeMessage(
    spec: Extract<TreeMessageSpec, { relation: "parent-family" | "sibling-family" }>,
    message: string
  ): Promise<Result<TreeMessagePipelineResult, TreeMessagePipelineError>> {
    const cfg = this.config.loadConfigOrDefault();
    const senderEntry = findWorkspaceEntry(cfg, spec.senderWorkspaceId);
    let targetWorkspaceId: string;
    let familyKind: "child" | "sibling";
    let authorizingParentId: string | undefined;

    if (spec.relation === "parent-family") {
      const parentWorkspaceId = senderEntry?.workspace.parentWorkspaceId;
      if (senderEntry == null || !parentWorkspaceId) {
        return Err({
          code: "invalid_scope" as const,
          message: "task_message_parent is only available from a sub-agent task workspace.",
        });
      }
      if (senderEntry.workspace.workflowTask != null) {
        return Err({
          code: "invalid_scope" as const,
          message: "Workflow-owned tasks communicate through the workflow journal, not messaging.",
        });
      }
      if (findWorkspaceEntry(cfg, parentWorkspaceId) == null) {
        return Err({ code: "send_failed" as const, message: "Parent workspace no longer exists." });
      }
      targetWorkspaceId = parentWorkspaceId;
      familyKind = "child";
    } else {
      const index = this.buildAgentTaskIndex(cfg);
      const sharedParentId = index.parentById.get(spec.senderWorkspaceId);
      if (senderEntry == null || !sharedParentId) {
        return Err({ code: "invalid_scope" as const });
      }
      if (findWorkspaceEntry(cfg, spec.targetId) == null) {
        return Err({ code: "not_found" as const });
      }
      if (
        spec.targetId === spec.senderWorkspaceId ||
        index.parentById.get(spec.targetId) !== sharedParentId
      ) {
        return Err({ code: "invalid_scope" as const });
      }
      if (
        this.isWorkflowOwnedTaskUsingIndex(index, spec.targetId) ||
        this.isWorkflowOwnedTaskUsingIndex(index, spec.senderWorkspaceId)
      ) {
        return Err({ code: "invalid_scope" as const });
      }
      targetWorkspaceId = spec.targetId;
      familyKind = "sibling";
      authorizingParentId = sharedParentId;
    }

    assert(senderEntry != null, "family sender validated above");
    const prepared = this.agentPeerMessageBroker.prepareFamilyMessage({
      kind: familyKind,
      senderWorkspaceId: spec.senderWorkspaceId,
      senderTitle:
        coerceNonEmptyString(senderEntry.workspace.title) ??
        coerceNonEmptyString(senderEntry.workspace.name) ??
        "sub-agent",
      message,
    });
    const triggerLabel = prepared.triggerLabel;
    if (spec.relation === "sibling-family") {
      assert(triggerLabel != null, "sibling family message requires a trigger label");
    }
    const renderedTrigger =
      triggerLabel != null
        ? renderLabeledTaskMessage(triggerLabel, prepared.triggerContent)
        : prepared.triggerContent;
    const reservation = this.reserveTreeMessageBudget(
      spec.senderWorkspaceId,
      targetWorkspaceId,
      prepared.payloadContent.length + this.agentPeerMessageBroker.triggerCharge(renderedTrigger)
    );
    if (reservation == null) {
      return Err(this.agentPeerMessageBroker.budgetExhaustedError());
    }

    return this.agentPeerMessageBroker.withDeliveryLock(targetWorkspaceId, async () => {
      // SECURITY: sender-controlled content and title stay in an untrusted assistant row. A fixed
      // user-row trigger containing only server-generated IDs wakes the recipient (r21/r25), and
      // both rows ride turn admission together so neither can land in a PREPARING window (r30).
      const payloadRow = createMuxMessage(
        prepared.payloadMessageId,
        "assistant",
        prepared.payloadContent,
        {
          timestamp: Date.now(),
          synthetic: true,
          uiVisible: true,
          muxMetadata: { type: "family-message" },
        }
      );
      if (spec.relation === "parent-family") {
        const parentEntry = findWorkspaceEntry(cfg, targetWorkspaceId);
        assert(parentEntry != null, "validated parent workspace disappeared from snapshot");
        const wakeResult = await this.wakeParentWorkspaceWithSyntheticMessage({
          parentWorkspaceId: targetWorkspaceId,
          parentEntry,
          content: prepared.triggerContent,
          queueDispatchMode: spec.queueDispatchMode,
          preTurnMessages: [payloadRow],
          onPreTurnRowsPersisted: () => reservation.markPersisted(),
        });
        if (!wakeResult.success) {
          reservation.refundIfUnpersisted();
          return Err({ code: "send_failed" as const, message: wakeResult.error });
        }
        return Ok({ parentWorkspaceId: targetWorkspaceId });
      }

      assert(authorizingParentId != null, "validated sibling sender lost its parent in snapshot");
      assert(triggerLabel != null, "sibling family message requires a trigger label");
      const sendResult = await this.dispatchTrustedDescendantMessage(
        authorizingParentId,
        spec.targetId,
        prepared.triggerContent,
        spec.queueDispatchMode,
        {
          messageLabel: triggerLabel,
          preTurnMessages: [payloadRow],
          onPreTurnPersisted: () => reservation.markPersisted(),
        }
      );
      if (!sendResult.success) reservation.refundIfUnpersisted();
      return sendResult;
    });
  }
  private reserveTreeMessageBudget(
    senderWorkspaceId: string,
    targetWorkspaceId: string,
    chars: number
  ): TreeMessageBudgetReservation | null {
    const refund = this.agentPeerMessageBroker.reserveBudget(
      senderWorkspaceId,
      targetWorkspaceId,
      chars
    );
    if (refund == null) return null;

    // The reservation becomes irrevocable at the persistence horizon, not at turn acceptance.
    // Every route can therefore share idempotent rollback without weakening its refund policy.
    let payloadPersisted = false;
    return {
      markPersisted: () => {
        payloadPersisted = true;
      },
      refundIfUnpersisted: () => {
        if (!payloadPersisted) refund();
      },
    };
  }

  private sendTreeMessage(
    spec: Extract<TreeMessageSpec, { relation: "descendant" }>
  ): Promise<Result<SendAgentTaskMessageResult, SendAgentTaskMessageError>>;
  private sendTreeMessage(
    spec: Extract<TreeMessageSpec, { relation: "peer" }>
  ): Promise<
    Result<
      SendAgentTaskMessageResult & { relation: AgentTreeTargetRelation },
      SendAgentTreeMessageError
    >
  >;
  private sendTreeMessage(
    spec: Extract<TreeMessageSpec, { relation: "parent-family" }>
  ): Promise<Result<SendParentAgentMessageResult, SendParentAgentMessageError>>;
  private sendTreeMessage(
    spec: Extract<TreeMessageSpec, { relation: "sibling-family" }>
  ): Promise<Result<SendAgentTaskMessageResult, SendAgentTaskMessageError>>;
  private async sendTreeMessage(
    spec: TreeMessageSpec
  ): Promise<Result<TreeMessagePipelineResult, TreeMessagePipelineError>> {
    const message = spec.message.trim();
    const assertionName =
      spec.relation === "descendant"
        ? "sendMessageToDescendantAgentTask"
        : spec.relation === "peer"
          ? "sendAgentTreeMessage"
          : spec.relation === "parent-family"
            ? "sendMessageToParentFromAgentTask"
            : "sendMessageToSiblingAgentTask";
    assert(message.length > 0, `${assertionName}: message must be non-empty`);

    if (spec.relation === "descendant") {
      return this.dispatchTrustedDescendantMessage(
        spec.senderWorkspaceId,
        spec.targetId,
        message,
        spec.queueDispatchMode,
        spec.options
      );
    }

    if (message.length > TASK_FAMILY_MESSAGE_MAX_CHARS) {
      return spec.relation === "peer"
        ? Err({
            code: "refused" as const,
            reason: `Message exceeds the ${TASK_FAMILY_MESSAGE_MAX_CHARS}-character peer-message limit; send a shorter summary.`,
          })
        : Err({
            code: "send_failed" as const,
            message: `Message exceeds the ${TASK_FAMILY_MESSAGE_MAX_CHARS}-character family-message limit; send a summary instead.`,
          });
    }

    if (spec.relation === "parent-family" || spec.relation === "sibling-family") {
      return this.sendFamilyTreeMessage(spec, message);
    }

    const { senderWorkspaceId, targetId, targetRelation: relation } = spec;
    return this.workspaceEventLocks.withLock(targetId, async () => {
      const cfg = this.config.loadConfigOrDefault();
      const targetEntry = findWorkspaceEntry(cfg, targetId);
      const senderEntry = findWorkspaceEntry(cfg, senderWorkspaceId);
      if (!targetEntry || !senderEntry) {
        return Err({ code: "not_found" as const });
      }
      const index = this.buildAgentTaskIndex(cfg);

      // Re-verify under the target's event lock: tree membership may have changed since routing.
      if (
        this.resolveAgentTreeTargetRelation(index.parentById, senderWorkspaceId, targetId) !==
        relation
      ) {
        return Err({ code: "invalid_scope" as const });
      }

      // Terminal and archived senders cannot wake peers. A reawakened child may send only while
      // its mirrored workspace-turn execution is running and backed by an accepted live handle;
      // queued/starting reservations still belong to the previous terminal execution.
      const senderInactiveRefusal = {
        code: "refused" as const,
        reason: "Sender is no longer active; terminal or archived tasks cannot send peer messages.",
      };
      // A persisted running mirror can outlive its handle after a crash. Requiring the matching
      // accepted registration prevents stale mirrors and creation-time reservations from
      // peer-reactivating a terminal task.
      const hasLiveRunningExecution = (
        workspace: WorkspaceConfigEntry,
        workspaceId: string
      ): boolean => {
        const live = this.getWorkspaceTurnManager().getLiveWorkspaceTurnRegistration(workspaceId);
        return (
          workspace.taskExecutionStatus === "running" &&
          workspace.taskExecutionId != null &&
          live != null &&
          live.handleId === workspace.taskExecutionId &&
          live.accepted
        );
      };
      const isInactivePeerSender = (workspace: WorkspaceConfigEntry): boolean => {
        if (coerceNonEmptyString(workspace.parentWorkspaceId) == null) {
          // Root workspaces have no task lifecycle to go terminal.
          return false;
        }
        const status = workspace.taskStatus ?? "running";
        return (
          isWorkspaceArchived(workspace.archivedAt, workspace.unarchivedAt) ||
          (!hasLiveRunningExecution(workspace, senderWorkspaceId) &&
            status !== "running" &&
            status !== "awaiting_report")
        );
      };
      if (isInactivePeerSender(senderEntry.workspace)) {
        return Err(senderInactiveRefusal);
      }

      // Workflow-owned endpoints exchange I/O through WorkflowRunner's journal; peer messages
      // would break durable replay (same rationale as reportAgentProgress's early return).
      if (
        this.isWorkflowOwnedTaskUsingIndex(index, senderWorkspaceId) ||
        this.isWorkflowOwnedTaskUsingIndex(index, targetId)
      ) {
        return Err({
          code: "refused" as const,
          reason: "Workflow-owned tasks cannot send or receive peer messages.",
        });
      }

      // Best-of candidates (and their subtrees) must stay independent: sibling↔candidate would
      // break candidate independence and candidate→ancestor would lobby the selecting parent
      // mid-run. Only the existing ancestor→candidate guidance path is allowed.
      if (
        this.isBestOfChainUsingIndex(index, senderWorkspaceId) ||
        this.isBestOfChainUsingIndex(index, targetId)
      ) {
        return Err({
          code: "refused" as const,
          reason: "Best-of candidates cannot send or receive peer messages.",
        });
      }

      const legacyArchived = isWorkspaceArchived(
        targetEntry.workspace.archivedAt,
        targetEntry.workspace.unarchivedAt
      );
      if (legacyArchived) {
        return Err({
          code: "not_active" as const,
          taskStatus: targetEntry.workspace.taskStatus ?? "unknown",
          message: "Target workspace is archived; only its parent can restore and reawaken it.",
        });
      }

      // Roots may start an idle turn. Agent-task targets must already be live: peers cannot own
      // queued prompts or reactivate terminal tasks without rerouting their report ownership.
      const targetIsAgentTask =
        coerceNonEmptyString(targetEntry.workspace.parentWorkspaceId) != null;
      if (targetIsAgentTask) {
        const targetStatus = targetEntry.workspace.taskStatus ?? "running";
        // Match task_list's effective-running overlay, but require accepted correlation so a
        // queued reawakening cannot be converted into an unowned peer continuation.
        const targetExecutionActive = hasLiveRunningExecution(targetEntry.workspace, targetId);
        if (!targetExecutionActive) {
          if (targetStatus === "queued" || targetStatus === "starting") {
            return Err({
              code: "not_active" as const,
              taskStatus: targetStatus,
              message:
                "Target has not started yet; only its parent may update a queued task's prompt.",
            });
          }
          // Stable terminal status wins even while the old stream winds down, or a queued peer
          // trigger could dispatch after completion and reactivate the task.
          if (targetStatus !== "running" && targetStatus !== "awaiting_report") {
            return Err({
              code: "not_active" as const,
              taskStatus: targetStatus,
              message: "Target is inactive; peer messages cannot reactivate it — ask its parent.",
            });
          }
        }
      }

      // A hard interrupt is an explicit user stop: markParentWorkspaceInterrupted suppresses
      // auto-resume until real user input, and an agent message racing that cascade must not
      // undo the stop by queueing or starting another turn on the interrupted workspace. The
      // suppression set holds the ANCESTOR the user interrupted, so check the target's whole
      // ancestor chain — the termination cascade may not have reached a lower target yet.
      const targetChainIds = [
        targetId,
        ...this.listAncestorWorkspaceIdsUsingParentById(index.parentById, targetId),
      ];
      const targetChainInterrupted = (): boolean =>
        targetChainIds.some((id) => this.interruptedParentWorkspaceIds.has(id));
      const interruptedRefusal = {
        code: "refused" as const,
        reason:
          "Target was interrupted by the user and will not accept agent messages until the user resumes it.",
      };
      if (targetChainInterrupted()) {
        return Err(interruptedRefusal);
      }

      // A user stop on any of the SENDER's ancestors also invalidates this send: the descendant
      // interruption cascade may not have reached the sender yet (its status still reads
      // running), but a prompt-influenced agent in a stopped subtree must not wake workspaces
      // outside it from its winding-down tool call.
      const senderChainIds = [
        senderWorkspaceId,
        ...this.listAncestorWorkspaceIdsUsingParentById(index.parentById, senderWorkspaceId),
      ];
      const senderChainInterrupted = (): boolean =>
        senderChainIds.some((id) => this.interruptedParentWorkspaceIds.has(id));
      if (senderChainInterrupted()) {
        return Err(senderInactiveRefusal);
      }

      // In-progress stop latches: a send ENTERING after a stop's epoch bump would capture the
      // post-bump generation as its clean baseline (making the epoch probe below blind to it)
      // while the cascade is still persisting terminal statuses — the endpoints still read
      // running. The level latch spans exactly that window; once released, the persisted
      // statuses take over refusal. Target attribution wins on a shared stopped ancestor.
      const targetChainStopping = (): boolean =>
        targetChainIds.some((id) => this.isWorkspaceStopInProgress(id));
      const senderChainStopping = (): boolean =>
        senderChainIds.some((id) => this.isWorkspaceStopInProgress(id));
      if (targetChainStopping()) {
        return Err(interruptedRefusal);
      }
      if (senderChainStopping()) {
        return Err(senderInactiveRefusal);
      }

      // Latch stop generations for the admission probe below: the suppression set and persisted
      // statuses are level-triggered, so a Stop followed by a quick user resume BETWEEN probe
      // evaluations (e.g. while a queued entry sits in PREPARING) would read as clean again. Any
      // bump after this capture keeps the send stale forever — the resumed workspace belongs to
      // the user, not to a wake admitted before the stop. Both endpoints' chains are captured;
      // the per-chain probes attribute the refusal to the stopped side.
      const capturedStopEpochs = new Map(
        [...senderChainIds, ...targetChainIds].map((id) => [id, this.getWorkspaceStopEpoch(id)])
      );
      const chainStopEpochChanged = (chainIds: string[]): boolean =>
        chainIds.some((id) => this.getWorkspaceStopEpoch(id) !== capturedStopEpochs.get(id));

      const throttleError = this.agentPeerMessageBroker.checkPeerAdmission(
        senderWorkspaceId,
        targetId,
        message
      );
      if (throttleError != null) {
        return Err(throttleError);
      }

      const rawSenderTitle =
        coerceNonEmptyString(senderEntry.workspace.title) ??
        coerceNonEmptyString(senderEntry.workspace.name);
      const {
        envelope,
        fromTitle: senderTitle,
        payloadMessageId,
        relationship,
        trigger,
      } = this.agentPeerMessageBroker.preparePeerMessage({
        senderWorkspaceId,
        senderTitle: rawSenderTitle,
        relation,
        message,
      });
      const muxMetadata: MuxMessageMetadata = {
        type: "agent-peer-message",
        fromWorkspaceId: senderWorkspaceId,
        ...(senderTitle != null ? { fromTitle: senderTitle } : {}),
        relationship,
      };
      // Bare attribution (no discriminator) — carried on workspace-turn correlated triggers so
      // correlation stripping can downgrade the row to plain peer metadata (see message.ts).
      const peerTriggerMeta: AgentPeerMessageMeta = {
        fromWorkspaceId: senderWorkspaceId,
        ...(senderTitle != null ? { fromTitle: senderTitle } : {}),
        relationship,
      };
      // SECURITY: same assistant-row/fixed-trigger separation as the family-message paths above —
      // sending the envelope as the message TEXT persisted it as a USER row, promoting
      // prompt-injected peer output to user-priority input in the target (user turns drive
      // bash/file tools under the target's own policy). The envelope rides as an assistant-role
      // pre-turn row instead, and the turn is triggered by a fixed-content user message with
      // ZERO sender-controlled bytes (workspace IDs are server-generated; the capped title stays
      // inside the untrusted envelope row). The trigger names the payload row by its
      // server-generated message ID, not adjacency — a streaming target's own assistant row can
      // land between payload and queued trigger.

      const reservation = this.reserveTreeMessageBudget(
        senderWorkspaceId,
        targetId,
        envelope.length + trigger.length
      );
      if (reservation == null) {
        return Err({
          code: "refused" as const,
          reason: this.agentPeerMessageBroker.budgetExhaustedError().message,
        });
      }

      // Everything from here to dispatch can throw (correlation lookup and resume-option
      // resolution read the handle store/config): refund exceptional pre-persistence exits in
      // the catch below, or transient failures would consume the pair/target budgets without
      // delivering anything — eventually refusing valid peer messages until restart.
      try {
        // Ancestor targets are often human-driven: default to turn-end so a peer message does not
        // cut into an active turn unless the sender explicitly asks. Sibling sends keep tool-end.
        const effectiveDispatchMode =
          spec.queueDispatchMode ?? (relation === "target_ancestor" ? "turn-end" : "tool-end");

        // Delegated-turn correlation: if the target is currently executing a delegated workspace
        // turn, the trigger must carry that correlation (like wakeParentWorkspaceWithSynthetic-
        // Message) — otherwise the queued peer wake dispatches as an unrelated turn and the next
        // stream end settles the owner's delegated turn as interrupted/superseded. Peer
        // attribution stays on the assistant payload row, so no provenance is lost; the queue
        // still counts these entries by their dedupe-key prefix.
        const workspaceTurnMuxMetadata =
          await this.getWorkspaceTurnManager().getActiveWorkspaceTurnMuxMetadataForWorkspace(
            targetId,
            { requireAcceptedRegistration: true }
          );
        // Keep the explicit trigger marker alongside the correlation: displayedMessageBuilder
        // renders machine notifications from metadata, so a bare workspace-turn replacement would
        // present the backend trigger as a human prompt (and re-enter prompt navigation).
        const triggerMuxMetadata: MuxMessageMetadata =
          workspaceTurnMuxMetadata != null
            ? { ...workspaceTurnMuxMetadata, agentPeerMessageTrigger: peerTriggerMeta }
            : muxMetadata;

        let sendOptions: SendMessageOptions;
        if (relation === "target_ancestor") {
          const resumeOptions = await this.resolveParentAutoResumeOptions(
            targetId,
            targetEntry,
            defaultModel
          );
          sendOptions = {
            model: resumeOptions.model,
            agentId: resumeOptions.agentId,
            thinkingLevel: resumeOptions.thinkingLevel,
            reasoningMode: resumeOptions.reasoningMode,
            muxMetadata: triggerMuxMetadata,
            queueDispatchMode: effectiveDispatchMode,
          };
        } else {
          const activeAgentId = resolveTaskAgentIdForResume(targetEntry.workspace);
          const activeAiSettings = this.resolveWorkspaceAISettings(
            targetEntry.workspace,
            activeAgentId
          );
          sendOptions = {
            model:
              coerceNonEmptyString(activeAiSettings?.model) ??
              targetEntry.workspace.taskModelString ??
              defaultModel,
            agentId: activeAgentId,
            thinkingLevel:
              activeAiSettings?.thinkingLevel ?? targetEntry.workspace.taskThinkingLevel,
            reasoningMode: coerceOpenAIReasoningMode(activeAiSettings?.reasoningMode),
            experiments: targetEntry.workspace.taskExperiments,
            muxMetadata: triggerMuxMetadata,
            queueDispatchMode: effectiveDispatchMode,
          };
        }

        // The envelope rides as an assistant-role pre-turn row (never a user turn), persisted
        // atomically with the trigger through the target's own turn admission — a direct history
        // append could land inside another turn's PREPARING window.
        const payloadRow = createMuxMessage(payloadMessageId, "assistant", envelope, {
          timestamp: Date.now(),
          synthetic: true,
          uiVisible: true,
          muxMetadata,
        });

        // Admission staleness probe: neither interruptStream nor stopDescendantAgentTask takes
        // this target's event lock, so a user Stop or task_stop can land during ANY await between
        // here and the real admission — including the host's sendMessage() pricing/settings
        // awaits and the session's turn preparation. The probe is synchronous and
        // re-evaluated by the host at the enqueue block and the session's turn-admission
        // gates, so a stop in those windows refuses the send instead of queueing a wake or
        // resurrecting the stopped task via markInterruptedTaskRunning.
        let admissionRefusal: SendAgentTreeMessageError | null = null;
        const admissionStale = (): boolean => {
          // Latched stop checks first: unlike the level-triggered probes below, a generation bump
          // stays observable even when a user resume already cleared suppression and restored
          // running statuses between probe evaluations. The in-progress latch backstops stops
          // whose cascade has not yet persisted terminal statuses. Target attribution wins when
          // a shared ancestor (e.g. the tree root) was stopped — the target-side refusal tells
          // the sender the recipient will not accept messages until the user resumes it.
          if (chainStopEpochChanged(targetChainIds) || targetChainStopping()) {
            admissionRefusal = interruptedRefusal;
            return true;
          }
          if (chainStopEpochChanged(senderChainIds) || senderChainStopping()) {
            admissionRefusal = senderInactiveRefusal;
            return true;
          }
          if (targetChainInterrupted()) {
            admissionRefusal = interruptedRefusal;
            return true;
          }
          const freshCfg = this.config.loadConfigOrDefault();
          // Sender revalidation: a reawakened child stopped mid-send (its owner interrupted the
          // workspace turn) must not wake an idle peer from its winding-down tool call. The
          // execution mirror is marked terminal with the handle transition, so this re-read
          // observes the stop before stopStream completes. The chain check covers a user stop on
          // a sender ancestor whose cascade has not reached the sender yet.
          const freshSender = findWorkspaceEntry(freshCfg, senderWorkspaceId);
          if (
            freshSender == null ||
            senderChainInterrupted() ||
            isInactivePeerSender(freshSender.workspace)
          ) {
            admissionRefusal = senderInactiveRefusal;
            return true;
          }
          const freshEntry = findWorkspaceEntry(freshCfg, targetId);
          if (freshEntry == null) {
            admissionRefusal = { code: "not_found" as const };
            return true;
          }
          // Archive is reversible-only but stops delivery: a target archived after the initial
          // check (archive does not synchronize with in-flight guarded sends) must refuse here
          // rather than accept or queue a peer turn behind the archive boundary.
          if (
            isWorkspaceArchived(freshEntry.workspace.archivedAt, freshEntry.workspace.unarchivedAt)
          ) {
            admissionRefusal = {
              code: "not_active" as const,
              taskStatus: freshEntry.workspace.taskStatus ?? "unknown",
              message: "Target workspace is archived; only its parent can restore and reawaken it.",
            };
            return true;
          }
          if (targetIsAgentTask) {
            // task_stop persists taskStatus="interrupted" (and terminal execution mirrors) under
            // the task-tree lifecycle lock; re-read the persisted state at admission so the stop
            // always wins the race.
            const freshStatus = freshEntry.workspace.taskStatus ?? "running";
            if (
              !hasLiveRunningExecution(freshEntry.workspace, targetId) &&
              freshStatus !== "running" &&
              freshStatus !== "awaiting_report"
            ) {
              admissionRefusal = {
                code: "not_active" as const,
                taskStatus: freshStatus,
                message:
                  "Target stopped before the message was admitted; peer messages cannot reactivate it.",
              };
              return true;
            }
          }
          return false;
        };
        // Recheck immediately before dispatch: resolveParentAutoResumeOptions and the
        // workspace-turn lookup awaited since the first check.
        if (admissionStale()) {
          reservation.refundIfUnpersisted();
          return Err(admissionRefusal ?? interruptedRefusal);
        }

        let accepted = false;
        const sendResult = await this.workspaceService.sendMessage(targetId, trigger, sendOptions, {
          admissionStale,
          synthetic: true,
          agentInitiated: true,
          startStreamInBackground: true,
          // Peer sends must not count as fresh user attention: resetAutoResumeCount also clears
          // consecutivePeerWakes, so letting a peer message trigger it would let peers extend each
          // other's wake budget indefinitely.
          skipAutoResumeReset: true,
          // Unique key ⇒ never coalesces (removable dedupe keys force a sealed queue entry), so
          // sender attribution, queue caps, and previews survive later queued messages.
          queueDedupeKey: `${AGENT_PEER_MESSAGE_DEDUPE_PREFIX}${senderWorkspaceId}:${randomUUID()}`,
          removableQueueDedupeKey: true,
          workspaceTurnContinuation: workspaceTurnMuxMetadata != null,
          preTurnMessages: [payloadRow],
          onPreTurnRowsPersisted: () => reservation.markPersisted(),
          onAccepted: () => {
            accepted = true;
          },
          // Queued sends return before dispatch, so cancellation must refund if persistence never
          // happened. The shared reservation keeps this idempotent.
          onCanceled: () => {
            reservation.refundIfUnpersisted();
          },
          // Queued dispatch failures use a separate callback but share the same horizon.
          onAcceptedPreStreamFailure: () => {
            reservation.refundIfUnpersisted();
          },
        });
        if (!sendResult.success) {
          // Refund only when nothing landed in the target transcript: pre-horizon failures roll
          // back every persisted pre-turn row, while post-persistence failures keep the charge —
          // refunding durable rows would let a sender retry unlimited max-size payloads while the
          // acceptance path is failing (same rationale as the family-message routes).
          reservation.refundIfUnpersisted();
          // A probe-triggered rejection surfaces the precise refusal (stop won the race), not a
          // generic transport failure.
          if (admissionRefusal != null) {
            return Err(admissionRefusal);
          }
          return Err({
            code: "send_failed" as const,
            message: formatSendMessageError(sendResult.error).message,
          });
        }

        // Charge the wake budget at ADMISSION (still inside the target's event lock), not at
        // dispatch: acceptance callbacks fire only when an entry is dequeued into a turn, so any
        // dispatch-time accounting leaves a dequeue-to-acceptance window where a parallel sender
        // sees neither a queued entry nor an incremented counter. Counting admitted sends makes
        // the budget independent of queue state; user attention still resets it.
        this.agentPeerMessageBroker.chargeConsecutivePeerWake(targetId);
        this.agentPeerMessageBroker.recordPeerSend(senderWorkspaceId, targetId, message);
        return Ok(
          accepted
            ? { delivery: "accepted" as const, relation }
            : { delivery: "queued" as const, relation, queueDispatchMode: effectiveDispatchMode }
        );
      } catch (error: unknown) {
        reservation.refundIfUnpersisted();
        throw error;
      }
    });
  }

  async stopDescendantAgentTask(
    ancestorWorkspaceId: string,
    taskId: string
  ): Promise<Result<{ stoppedTaskIds: string[] }, string>> {
    assert(ancestorWorkspaceId.length > 0, "stopDescendantAgentTask: ancestorWorkspaceId required");
    assert(taskId.length > 0, "stopDescendantAgentTask: taskId required");

    return await this.withTaskTreeLifecycleLock(taskId, () =>
      this.stopDescendantAgentTaskUnderLifecycleLock(ancestorWorkspaceId, taskId)
    );
  }

  private async stopDescendantAgentTaskUnderLifecycleLock(
    ancestorWorkspaceId: string,
    taskId: string
  ): Promise<Result<{ stoppedTaskIds: string[] }, string>> {
    const stoppedTaskIds: string[] = [];
    const metadataToEmit = new Set<string>();

    {
      await using _lock = await this.mutex.acquire();
      const cfg = this.config.loadConfigOrDefault();
      const entry = findWorkspaceEntry(cfg, taskId);
      if (!entry?.workspace.parentWorkspaceId) {
        return Err("Task not found");
      }
      const index = this.buildAgentTaskIndex(cfg);
      if (
        !this.isDescendantAgentTaskUsingParentById(index.parentById, ancestorWorkspaceId, taskId)
      ) {
        return Err("Task is not a descendant of this workspace");
      }

      const taskIds = [taskId, ...this.listDescendantAgentTaskIdsFromIndex(index, taskId)];
      taskIds.sort(
        (left, right) =>
          this.getTaskDepthFromParentById(index.parentById, right) -
          this.getTaskDepthFromParentById(index.parentById, left)
      );
      // Latch the stop for the whole subtree BEFORE any await below: stopStream waits for
      // in-flight tool calls to settle, and one of those tool calls may be the very peer send
      // this stop must invalidate — a bump deferred to the status transition would deadlock
      // behind it and let every admission probe pass in the meantime.
      for (const id of taskIds) {
        this.bumpWorkspaceStopEpoch(id);
      }
      // Level latch alongside the bump: the epoch only invalidates sends that captured a
      // BASELINE before it — a send ENTERING during the awaits below would treat the bumped
      // generation as clean while the subtree's statuses still read running, letting a
      // prompt-influenced agent in the stopped subtree wake workspaces outside it. Held until
      // every id's terminal status persists (the loop below), then the persisted statuses
      // take over refusal.
      const releaseStopLatch = this.latchWorkspaceStopsInProgress(taskIds);
      try {
        const activeWorkspaceTurns = await this.getWorkspaceTurnManager().listAllWorkspaceTurns({
          statuses: ["queued", "starting", "running"],
        });

        for (const id of taskIds) {
          const current = findWorkspaceEntry(this.config.loadConfigOrDefault(), id);
          if (!current) continue;
          const status = current.workspace.taskStatus ?? "running";
          const activeHandles = activeWorkspaceTurns.filter((turn) => turn.workspaceId === id);
          const executionActive =
            ACTIVE_AGENT_TASK_STATUSES.has(status) || this.aiService.isStreaming(id);
          if (!executionActive && activeHandles.length === 0) {
            continue;
          }

          for (const handle of activeHandles) {
            const interrupted = await this.getWorkspaceTurnManager().interruptWorkspaceTurn(
              handle.ownerWorkspaceId,
              handle.handleId
            );
            if (!interrupted.success) {
              return Err(interrupted.error);
            }
            await this.suppressTerminalAttention({
              ownerWorkspaceId: handle.ownerWorkspaceId,
              sourceKind: "workspace_turn",
              sourceId: handle.handleId,
            });
          }

          const clearQueueResult = this.workspaceService.clearQueue(id);
          if (!clearQueueResult.success) {
            log.debug("stopDescendantAgentTask: clearQueue failed", {
              taskId: id,
              error: clearQueueResult.error,
            });
          }
          if (this.aiService.isStreaming(id)) {
            try {
              await this.aiService.stopStream(id, { abandonPartial: false });
            } catch (error: unknown) {
              log.debug("stopDescendantAgentTask: stopStream threw", { taskId: id, error });
            }
          }

          let transitioned = false;
          let parentWorkspaceId: string | undefined;
          await this.editWorkspaceEntry(
            id,
            (workspace) => {
              const previousStatus = workspace.taskStatus;
              parentWorkspaceId = workspace.parentWorkspaceId;
              const mutation = this.applyInterruptedTaskStatus(workspace);
              transitioned = mutation === "interrupted" && previousStatus !== "interrupted";
            },
            { allowMissing: true }
          );
          if (parentWorkspaceId != null) {
            await this.suppressTerminalAttention({
              ownerWorkspaceId: parentWorkspaceId,
              sourceKind: "agent_task",
              sourceId: id,
            });
          }
          if (transitioned) {
            this.recordTaskInterrupted(id, parentWorkspaceId);
            // Authoritative settlement for latches parked by earlier failed cascades: the
            // persisted interrupted status refuses peer sends on its own now.
            this.releaseRetainedStopLatches(id);
            this.rejectWaiters(id, new Error("Task stopped"));
            metadataToEmit.add(id);
          }
          stoppedTaskIds.push(id);
        }
      } finally {
        releaseStopLatch();
      }
    }

    for (const id of metadataToEmit) {
      await this.emitWorkspaceMetadata(id);
    }
    await this.maybeStartQueuedTasks();
    return Ok({ stoppedTaskIds });
  }

  async terminateDescendantAgentTask(
    ancestorWorkspaceId: string,
    taskId: string
  ): Promise<Result<TerminateAgentTaskResult, string>> {
    assert(
      ancestorWorkspaceId.length > 0,
      "terminateDescendantAgentTask: ancestorWorkspaceId must be non-empty"
    );
    assert(taskId.length > 0, "terminateDescendantAgentTask: taskId must be non-empty");

    const terminatedTaskIds: string[] = [];
    const terminationErrors: string[] = [];

    {
      await using _lock = await this.mutex.acquire();

      const cfg = this.config.loadConfigOrDefault();
      const entry = findWorkspaceEntry(cfg, taskId);
      if (!entry?.workspace.parentWorkspaceId) {
        return Err("Task not found");
      }

      const index = this.buildAgentTaskIndex(cfg);
      if (
        !this.isDescendantAgentTaskUsingParentById(index.parentById, ancestorWorkspaceId, taskId)
      ) {
        return Err("Task is not a descendant of this workspace");
      }

      // Terminate the entire subtree to avoid orphaned descendant tasks.
      const descendants = this.listDescendantAgentTaskIdsFromIndex(index, taskId);
      const toTerminate = Array.from(new Set([taskId, ...descendants]));

      // Delete leaves first to avoid leaving children with missing parents.
      const parentById = index.parentById;
      const depthById = new Map<string, number>();
      for (const id of toTerminate) {
        depthById.set(id, this.getTaskDepthFromParentById(parentById, id));
      }
      toTerminate.sort((a, b) => (depthById.get(b) ?? 0) - (depthById.get(a) ?? 0));

      const terminationError = new Error("Task terminated");

      // When a descendant workspace could not be removed, keep every ancestor of it
      // so the surviving child never points at removed parent metadata.
      const ancestorsBlockedByFailedChild = new Set<string>();
      const blockAncestorsOf = (id: string) => {
        for (
          let cur = parentById.get(id);
          cur != null && !ancestorsBlockedByFailedChild.has(cur);
          cur = parentById.get(cur)
        ) {
          ancestorsBlockedByFailedChild.add(cur);
        }
      };

      for (const id of toTerminate) {
        // Best-effort: stop any active stream immediately to avoid further token usage.
        try {
          const stopPromise = this.aiService.stopStream(id, { abandonPartial: true });
          const stopOutcome = await raceWithAbortAndTimeout(stopPromise, {
            timeoutMs: TASK_TERMINATION_STOP_STREAM_TIMEOUT_MS,
          });
          if (stopOutcome.kind !== "ok") {
            void stopPromise.catch((error: unknown) => {
              log.debug("terminateDescendantAgentTask: timed-out stopStream later threw", {
                taskId: id,
                error,
              });
            });
            terminationErrors.push(`Timed out stopping task stream (${id})`);
            blockAncestorsOf(id);
            continue;
          }
          if (!stopOutcome.value.success) {
            log.debug("terminateDescendantAgentTask: stopStream failed", { taskId: id });
          }
        } catch (error: unknown) {
          log.debug("terminateDescendantAgentTask: stopStream threw", { taskId: id, error });
        }

        if (ancestorsBlockedByFailedChild.has(id)) {
          terminationErrors.push(
            `Skipped removing task workspace (${id}): a descendant task workspace was not removed`
          );
          continue;
        }

        this.completedReportsByTaskId.delete(id);
        this.rejectWaiters(id, terminationError);

        try {
          let removePromise = this.pendingTaskWorkspaceRemovals.get(id);
          if (!removePromise) {
            removePromise = this.workspaceService.remove(id, true);
            this.pendingTaskWorkspaceRemovals.set(id, removePromise);
            const trackedPromise = removePromise;
            void trackedPromise
              .then(
                (result) => result.success,
                (error: unknown) => {
                  log.debug("terminateDescendantAgentTask: workspace removal threw", {
                    taskId: id,
                    error,
                  });
                  return false;
                }
              )
              .then(async (removed) => {
                if (this.pendingTaskWorkspaceRemovals.get(id) === trackedPromise) {
                  this.pendingTaskWorkspaceRemovals.delete(id);
                }
                // A removal that outlived its termination timeout frees the task slot
                // only when it settles, so kick the scheduler for queued tasks then.
                if (removed) {
                  await this.maybeStartQueuedTasks();
                }
              });
          }
          const removeOutcome = await raceWithAbortAndTimeout(removePromise, {
            timeoutMs: TASK_TERMINATION_WORKSPACE_REMOVE_TIMEOUT_MS,
          });
          if (removeOutcome.kind !== "ok") {
            terminationErrors.push(`Timed out removing task workspace (${id})`);
            blockAncestorsOf(id);
            continue;
          }
          if (!removeOutcome.value.success) {
            terminationErrors.push(
              `Failed to remove task workspace (${id}): ${removeOutcome.value.error}`
            );
            blockAncestorsOf(id);
            continue;
          }
        } catch (error: unknown) {
          terminationErrors.push(
            `Failed to remove task workspace (${id}): ${getErrorMessage(error)}`
          );
          blockAncestorsOf(id);
          continue;
        }

        terminatedTaskIds.push(id);
      }
    }

    // Free slots and start any queued tasks (best-effort).
    await this.maybeStartQueuedTasks();

    if (terminationErrors.length > 0) {
      return Err(terminationErrors.join("; "));
    }
    return Ok({ terminatedTaskIds });
  }

  /**
   * Best-effort sweep of leftover task workspaces once a workflow run reached a terminal
   * state (completed, failed, interrupted): recheck completed children still deferred by
   * cleanup gates and archive interrupted-without-report garbage.
   */
  async markWorkflowRunEnded(workflowRunId: string): Promise<void> {
    assert(workflowRunId.length > 0, "markWorkflowRunEnded: workflowRunId must be non-empty");
    await this.sweepEndedWorkflowRunTasks(workflowRunId);
  }

  /**
   * Hide leftover task workspaces of a workflow run that reached a terminal state.
   *
   * Why: interrupting a run leaves its children in taskStatus "interrupted" WITHOUT a
   * completed report, and canCleanupReportedTask requires a completed report — so those
   * children would linger in the active sidebar forever (until manual deletion).
   * Workflow-owned children are transient by design (results persist in the workflow
   * run/report artifacts), so archive them — never remove — once the owning run has
   * ended. Archived entries disappear from the active sidebar but keep their data for
   * inspection. User-spawned interrupted tasks are untouched: they intentionally stay
   * visible for manual inspection/resume.
   *
   * workflow_resume stays safe: resume replays the journal and restarts incomplete steps
   * with FRESH task ids (see WorkflowRunner's unrecoverable-started-task restart), so
   * archived old children are never reused.
   *
   * Idempotent (interrupted + not-already-archived filter), so it runs from both the
   * run-end hook and the run-scoped interrupt path: WorkflowService.interruptRun aborts
   * the runner BEFORE terminating descendants, so the runner's onRunEnded can fire while
   * children are still "running" — only the later interrupt-path sweep sees them.
   */
  private async sweepEndedWorkflowRunTasks(workflowRunId: string): Promise<void> {
    assert(workflowRunId.length > 0, "sweepEndedWorkflowRunTasks: workflowRunId must be non-empty");

    // Phase 1: archive interrupted-without-report descendants of the run. Descendants of
    // run children (spawned by workflow-owned agents) are included via ancestry.
    {
      const cfg = this.config.loadConfigOrDefault();
      const index = this.buildAgentTaskIndex(cfg);
      const interruptedTaskIds = [...index.byId.entries()]
        .filter(
          ([taskId, workspace]) =>
            this.isWorkflowRunDescendant(index, taskId, workflowRunId) &&
            workspace.taskStatus === "interrupted" &&
            !hasCompletedAgentReport(workspace) &&
            !isWorkspaceArchived(workspace.archivedAt, workspace.unarchivedAt)
        )
        .map(([taskId]) => taskId);
      await this.archiveWorkflowTaskWorkspacesDeepestFirst(interruptedTaskIds, index);
    }

    // Phase 2: recheck reported descendants of the run (deepest-first). Eligible ones are
    // removed by the normal cleanup walk. The rest can be blocked by the structural-leaf
    // topology gate: hasChildAgentTasks counts archived children too, so a reported
    // ancestor whose only remaining children are the entries archived in phase 1 can
    // never become removable — removing it anyway would orphan those archived config
    // entries. Archive such ancestors instead: hidden from the active sidebar, fully
    // preserved for inspection, tree intact.
    {
      const cfg = this.config.loadConfigOrDefault();
      const index = this.buildAgentTaskIndex(cfg);
      const reportedTaskIds = [...index.byId.entries()]
        .filter(
          ([taskId, workspace]) =>
            this.isWorkflowRunDescendant(index, taskId, workflowRunId) &&
            hasCompletedAgentReport(workspace)
        )
        .map(([taskId]) => taskId);
      const depthById = new Map<string, number>();
      for (const taskId of reportedTaskIds) {
        depthById.set(taskId, this.getTaskDepthFromParentById(index.parentById, taskId));
      }
      reportedTaskIds.sort((a, b) => (depthById.get(b) ?? 0) - (depthById.get(a) ?? 0));

      for (const taskId of reportedTaskIds) {
        await this.cleanupReportedLeafTask(taskId);

        const freshConfig = this.config.loadConfigOrDefault();
        const entry = findWorkspaceEntry(freshConfig, taskId);
        if (!entry) continue; // removed by the cleanup walk
        if (isWorkspaceArchived(entry.workspace.archivedAt, entry.workspace.unarchivedAt)) {
          continue;
        }
        // Defensive: never hide a workspace with an active stream.
        if (this.aiService.isStreaming(taskId)) continue;
        const freshIndex = this.buildAgentTaskIndex(freshConfig);
        const childTaskIds = freshIndex.childrenByParent.get(taskId) ?? [];
        // Leaf tasks deferred by non-topology gates (pending patch artifact, best-of
        // grouping) keep their own event-driven rechecks; do not archive them here.
        if (childTaskIds.length === 0) continue;
        const blockedOnlyByArchivedChildren = childTaskIds.every((childTaskId) => {
          const child = freshIndex.byId.get(childTaskId);
          return child != null && isWorkspaceArchived(child.archivedAt, child.unarchivedAt);
        });
        if (!blockedOnlyByArchivedChildren) continue;
        await this.archiveWorkflowTaskWorkspacesDeepestFirst([taskId], freshIndex);
      }
    }
  }

  /**
   * Archive task workspaces deepest-first (so the host's archive preconditions on
   * descendants hold), logging and continuing on per-task failures — one failed archive
   * must not abort the sweep; failures self-heal on the next startup sweep.
   */
  private async archiveWorkflowTaskWorkspacesDeepestFirst(
    taskIds: readonly string[],
    index: AgentTaskIndex
  ): Promise<void> {
    if (taskIds.length === 0) return;
    const depthById = new Map<string, number>();
    for (const taskId of taskIds) {
      depthById.set(taskId, this.getTaskDepthFromParentById(index.parentById, taskId));
    }
    const orderedTaskIds = [...taskIds].sort(
      (a, b) => (depthById.get(b) ?? 0) - (depthById.get(a) ?? 0)
    );
    // Ancestors of a task whose archive failed or was skipped must stay visible too:
    // hiding the parent while its child remains active would orphan the child in the
    // sidebar. Deepest-first ordering guarantees descendants settle before ancestors.
    const blockedAncestorIds = new Set<string>();
    const markAncestorsBlocked = (taskId: string): void => {
      let currentId = index.parentById.get(taskId);
      for (let depth = 0; currentId != null && depth < 32; depth++) {
        blockedAncestorIds.add(currentId);
        currentId = index.parentById.get(currentId);
      }
    };
    for (const taskId of orderedTaskIds) {
      if (blockedAncestorIds.has(taskId)) {
        // Own ancestors are already in the set: the failing descendant's walk went to root.
        log.warn(
          "Skipping auto-archive of workflow task workspace; a descendant stayed unarchived",
          { taskId }
        );
        continue;
      }
      try {
        const result = await this.workspaceService.archive(taskId);
        if (!result.success) {
          log.warn("Failed to archive leftover workflow task workspace", {
            taskId,
            error: result.error,
          });
          markAncestorsBlocked(taskId);
        } else if (result.data.kind === "confirm-lossy-untracked-files") {
          // Snapshot-archive mode asks for user confirmation before discarding untracked
          // files. Auto-acknowledging would silently lose data, so leave this workspace
          // visible for manual handling instead.
          log.warn(
            "Skipping auto-archive of workflow task workspace pending untracked-file confirmation",
            { taskId }
          );
          markAncestorsBlocked(taskId);
        }
      } catch (error: unknown) {
        log.warn("Archive of leftover workflow task workspace threw", { taskId, error });
        markAncestorsBlocked(taskId);
      }
    }
  }

  /**
   * Startup self-heal: archive interrupted-without-report workflow-owned tasks whose
   * owning workflow run is no longer active. Covers both children the startup prepass
   * just transitioned to "interrupted" (inactive workflow owner) and historical garbage
   * left by interrupts before this sweep existed. Delegates to
   * sweepEndedWorkflowRunTasks per inactive run so blocked reported ancestors are also
   * resolved. Returns the number of inactive runs swept.
   */
  private async archiveLeftoverTasksOfInactiveWorkflowRuns(): Promise<number> {
    const cfg = this.config.loadConfigOrDefault();
    const index = this.buildAgentTaskIndex(cfg);
    const inactiveRunIds = new Set<string>();
    for (const [taskId, workspace] of index.byId) {
      if (isWorkspaceArchived(workspace.archivedAt, workspace.unarchivedAt)) continue;
      // Seed from two unarchived shapes so a crash mid-sweep still self-heals:
      // - interrupted-without-report children (normal leftover garbage), and
      // - reported tasks, covering a crash after phase 1 archived the interrupted
      //   children but before phase 2 archived the reported ancestor they block —
      //   at that point no unarchived interrupted task remains to re-seed the run.
      // Reported tasks of ACTIVE runs are filtered out by the inactivity check below.
      if (workspace.taskStatus !== "interrupted" && !hasCompletedAgentReport(workspace)) {
        continue;
      }
      // Non-workflow-owned tasks have no owner in ancestry → null → skipped (user-spawned
      // interrupted tasks intentionally stay visible).
      const inactiveOwner = await this.getInactiveWorkflowTaskOwnerForRecovery(taskId, cfg, index);
      if (inactiveOwner == null) continue;
      inactiveRunIds.add(inactiveOwner.runId);
    }
    for (const runId of inactiveRunIds) {
      await this.sweepEndedWorkflowRunTasks(runId);
    }
    return inactiveRunIds.size;
  }

  /**
   * Interrupt all descendant agent tasks for a workspace (leaf-first).
   *
   * Rationale: when a user hard-interrupts a parent workspace, descendants must
   * also stop so they cannot later auto-resume the interrupted parent.
   *
   * Keep interrupted task workspaces on disk so users can inspect or manually
   * resume them later.
   *
   * Legacy naming note: this method retains the original "terminate" name for
   * compatibility with existing call sites.
   */
  async terminateAllDescendantAgentTasks(
    workspaceId: string,
    options?: { workflowRunId?: string }
  ): Promise<string[]> {
    assert(
      workspaceId.length > 0,
      "terminateAllDescendantAgentTasks: workspaceId must be non-empty"
    );

    const interruptedTaskIds: string[] = [];

    {
      await using _lock = await this.mutex.acquire();

      const cfg = this.config.loadConfigOrDefault();
      const index = this.buildAgentTaskIndex(cfg);
      const descendants = this.listDescendantAgentTaskIdsFromIndex(index, workspaceId).filter(
        (taskId) =>
          options?.workflowRunId == null ||
          this.isWorkflowRunDescendant(index, taskId, options.workflowRunId)
      );
      if (descendants.length === 0) {
        return interruptedTaskIds;
      }

      // Interrupt leaves first to avoid descendant/ancestor status races.
      const parentById = index.parentById;
      const depthById = new Map<string, number>();
      for (const id of descendants) {
        depthById.set(id, this.getTaskDepthFromParentById(parentById, id));
      }
      descendants.sort((a, b) => (depthById.get(b) ?? 0) - (depthById.get(a) ?? 0));

      const interruptionError = new Error("Parent workspace interrupted");

      // Same protection as stopDescendantAgentTask: bump + latch the WHOLE descendant set
      // before any await below. The hard-interrupted ancestor's suppression entry is
      // level-triggered and cleared by the user's next real send (resetAutoResumeCount), which
      // can happen while a descendant is still blocked in stopStream with taskStatus "running" —
      // a peer send entering then would capture the already-bumped ancestor epoch as its clean
      // baseline and could wake a cousin or the root after Stop. The latch holds until every
      // descendant's terminal status persists — and is RETAINED (fail closed) for descendants
      // whose interrupt processing throws: interruptStream's outer catch suppresses the error
      // and reports success, so without an admission-visible stop marker a still-running
      // descendant would resume peer sends right after the failed cascade. The retained latch
      // refuses admission until the process restarts (which also kills the descendant's
      // stream) or a later cascade completes.
      for (const id of descendants) {
        this.bumpWorkspaceStopEpoch(id);
      }
      const releaseById = new Map(
        descendants.map((id) => [id, this.latchWorkspaceStopsInProgress([id])] as const)
      );
      try {
        for (const id of descendants) {
          try {
            // Best-effort: clear queue first. AgentSession stream-end cleanup auto-flushes
            // queued messages, so descendants must not keep pending input after a hard interrupt.
            try {
              const clearQueueResult = this.workspaceService.clearQueue(id);
              if (!clearQueueResult.success) {
                log.debug("terminateAllDescendantAgentTasks: clearQueue failed", {
                  taskId: id,
                  error: clearQueueResult.error,
                });
              }
            } catch (error: unknown) {
              log.debug("terminateAllDescendantAgentTasks: clearQueue threw", {
                taskId: id,
                error,
              });
            }

            // Best-effort: stop any active stream immediately to avoid further token usage
            // while preserving commit-worthy partial progress for inspection/resume. Success is
            // NOT stop confirmation for latch purposes: an accepted-but-PREPARING turn has no
            // registered stream yet, so stopStream no-ops with success while the turn can still
            // start afterward — only terminal execution settlement confirms.
            try {
              const stopResult = await this.aiService.stopStream(id, { abandonPartial: false });
              if (!stopResult.success) {
                log.debug("terminateAllDescendantAgentTasks: stopStream failed", { taskId: id });
              }
            } catch (error: unknown) {
              log.debug("terminateAllDescendantAgentTasks: stopStream threw", {
                taskId: id,
                error,
              });
            }

            let preservedCompletedDescendant = false;
            let transitionedToInterrupted = false;
            let parentWorkspaceId: string | undefined;
            const updated = await this.editWorkspaceEntry(
              id,
              (ws) => {
                const previousStatus = ws.taskStatus;
                parentWorkspaceId = ws.parentWorkspaceId;
                preservedCompletedDescendant =
                  this.applyInterruptedTaskStatus(ws) === "preserved-completed-report";
                transitionedToInterrupted =
                  !preservedCompletedDescendant && previousStatus !== "interrupted";
              },
              { allowMissing: true }
            );
            if (!updated) {
              // Missing descendants should still reject prompt waiters promptly so task_await does
              // not hang until timeout after a parent hard interrupt races with external cleanup.
              this.rejectWaiters(id, interruptionError);
              log.debug("terminateAllDescendantAgentTasks: descendant workspace missing", {
                taskId: id,
              });
              continue;
            }

            if (preservedCompletedDescendant) {
              // A reawakened completed child executes under a live workspace-turn handle while
              // its STABLE status stays terminal, so this branch persists neither an interrupted
              // status nor a terminal execution mirror. Until that execution settles terminally,
              // nothing admission-visible marks the stop once the latch drops — a still-running
              // child (failed stream cancellation) or an accepted-but-PREPARING turn (stopStream
              // no-ops with success before a stream registers, and the turn starts afterward)
              // could message a root or cousin right after Stop. Retain the latch (fail closed,
              // same contract as the catch below) whenever a live registration remains;
              // settlement releases it via releaseRetainedStopLatches so the child is not
              // barred until restart.
              const release = releaseById.get(id);
              if (
                release != null &&
                this.getWorkspaceTurnManager().getLiveWorkspaceTurnRegistration(id) != null
              ) {
                releaseById.delete(id);
                this.retainStopLatchUntilSettlement(id, release);
                // Park-then-recheck: a settlement racing this cascade may have persisted the
                // terminal mirror and run ITS release before the park above. If persisted
                // evidence now refuses on its own, free the latch immediately — no later
                // settlement callback will.
                if (this.isStopSettledForAdmission(id)) {
                  this.releaseRetainedStopLatches(id);
                } else {
                  log.error(
                    "terminateAllDescendantAgentTasks: unsettled live execution for completed descendant; retaining stop latch",
                    { taskId: id }
                  );
                }
              }
              log.debug(
                "terminateAllDescendantAgentTasks: preserving completed descendant report",
                {
                  taskId: id,
                }
              );
              continue;
            }

            if (transitionedToInterrupted) {
              this.recordTaskInterrupted(id, parentWorkspaceId);
            }
            // The persisted interrupted status is authoritative settlement for any latch a
            // PREVIOUS failed cascade parked for this id — refusal now rides the status itself.
            this.releaseRetainedStopLatches(id);

            // Report monotonicity: descendants that did not complete a report must reject waiters
            // once the interrupt status transition is persisted.
            this.rejectWaiters(id, interruptionError);
            interruptedTaskIds.push(id);
          } catch (error: unknown) {
            // Retain this descendant's latch as the stop marker (see comment above) and keep
            // processing the remaining descendants instead of aborting the whole cascade;
            // authoritative settlement (releaseRetainedStopLatches) frees it later. The same
            // park-then-recheck as the preserved-completed branch closes the race with a
            // settlement whose release ran before this park (running children recheck false and
            // stay latched).
            const release = releaseById.get(id);
            if (release != null) {
              releaseById.delete(id);
              this.retainStopLatchUntilSettlement(id, release);
              if (this.isStopSettledForAdmission(id)) {
                this.releaseRetainedStopLatches(id);
              }
            }
            log.error(
              "terminateAllDescendantAgentTasks: interrupt processing failed; retaining stop latch",
              { taskId: id, error }
            );
          }
        }
      } finally {
        for (const release of releaseById.values()) {
          release();
        }
      }
    }

    for (const taskId of interruptedTaskIds) {
      await this.emitWorkspaceMetadata(taskId);
    }

    if (options?.workflowRunId != null) {
      // Run-scoped interrupts arrive after the owning run's terminal status write
      // (WorkflowService.interruptRun aborts the runner, persists "interrupted", THEN
      // terminates descendants), so the children just interrupted above can be archived
      // right away. markWorkflowRunEnded also sweeps, but the runner-abort path can fire
      // onRunEnded before this termination completes — sweeping here closes that
      // ordering race (the sweep is idempotent).
      await this.sweepEndedWorkflowRunTasks(options.workflowRunId);
    }

    // Free slots and start any queued tasks (best-effort).
    await this.maybeStartQueuedTasks();

    return interruptedTaskIds;
  }

  private async rollbackFailedTaskCreate(
    runtime: Runtime,
    projectPath: string,
    workspaceName: string,
    taskId: string,
    options?: {
      /**
       * Skip physical workspace deletion. Required for isolation: "none" tasks whose runtime
       * resolves this task's name to the shared parent checkout (e.g. SSHRuntime.deleteWorkspace
       * goes through the persisted-path override) — deleting it would destroy the parent's
       * working tree. Session/config cleanup still runs.
       */
      preservePhysicalWorkspace?: boolean;
    }
  ): Promise<void> {
    let removedFromConfig = false;
    try {
      await this.config.removeWorkspace(taskId);
      removedFromConfig = true;
    } catch (error: unknown) {
      log.error("Task.create rollback: failed to remove workspace from config", {
        taskId,
        error: getErrorMessage(error),
      });
    }

    // A create that failed after sendMessage may already have scheduled
    // extension-metadata writes (e.g. the recency update), which would
    // recreate the entry after the deregistration above and leak a stale key
    // until the next process start's lazy prune. Only after deregistration
    // actually succeeded: discarding also write-tombstones the id for this
    // process, which must not silence metadata for a workspace that is still
    // registered because removeWorkspace failed.
    if (removedFromConfig) {
      await this.workspaceService.discardExtensionMetadataEntry(taskId);
    }

    this.workspaceService.emit("metadata", { workspaceId: taskId, metadata: null });

    if (options?.preservePhysicalWorkspace) {
      log.debug("Task.create rollback: preserving shared parent checkout", { taskId });
    } else {
      try {
        const deleteResult = await runtime.deleteWorkspace(projectPath, workspaceName, true);
        if (!deleteResult.success) {
          log.error("Task.create rollback: failed to delete workspace", {
            taskId,
            error: deleteResult.error,
          });
        }
      } catch (error: unknown) {
        log.error("Task.create rollback: runtime.deleteWorkspace threw", {
          taskId,
          error: getErrorMessage(error),
        });
      }
    }

    try {
      const sessionDir = path.join(this.config.sessionsDir, taskId);
      await fsPromises.rm(sessionDir, { recursive: true, force: true });
    } catch (error: unknown) {
      log.error("Task.create rollback: failed to remove session directory", {
        taskId,
        error: getErrorMessage(error),
      });
    }
  }

  isForegroundAwaiting(workspaceId: string): boolean {
    const count = this.foregroundAwaitCountByWorkspaceId.get(workspaceId);
    return typeof count === "number" && count > 0;
  }

  startForegroundAwait(workspaceId: string): () => void {
    assert(workspaceId.length > 0, "startForegroundAwait: workspaceId must be non-empty");

    const current = this.foregroundAwaitCountByWorkspaceId.get(workspaceId) ?? 0;
    assert(
      Number.isInteger(current) && current >= 0,
      "startForegroundAwait: expected non-negative integer counter"
    );

    this.foregroundAwaitCountByWorkspaceId.set(workspaceId, current + 1);

    return () => {
      const current = this.foregroundAwaitCountByWorkspaceId.get(workspaceId) ?? 0;
      assert(
        Number.isInteger(current) && current > 0,
        "startForegroundAwait cleanup: expected positive integer counter"
      );
      if (current <= 1) {
        this.foregroundAwaitCountByWorkspaceId.delete(workspaceId);
      } else {
        this.foregroundAwaitCountByWorkspaceId.set(workspaceId, current - 1);
      }
    };
  }

  registerBackgroundableForegroundWaiter(
    workspaceId: string,
    waiter: BackgroundableForegroundWaiter
  ): void {
    let set = this.backgroundableForegroundWaitersByWorkspaceId.get(workspaceId);
    if (!set) {
      set = new Set();
      this.backgroundableForegroundWaitersByWorkspaceId.set(workspaceId, set);
    }
    set.add(waiter);
  }

  unregisterBackgroundableForegroundWaiter(
    workspaceId: string,
    waiter: BackgroundableForegroundWaiter
  ): void {
    const set = this.backgroundableForegroundWaitersByWorkspaceId.get(workspaceId);
    if (!set) return;
    set.delete(waiter);
    if (set.size === 0) {
      this.backgroundableForegroundWaitersByWorkspaceId.delete(workspaceId);
    }
  }

  /**
   * Reject all foreground task waiters for a workspace that opted into backgrounding
   * when a new message is queued. Returns the number of waiters signaled.
   * Safe to call repeatedly — already-cleaned-up waiters are skipped.
   */
  backgroundForegroundWaitsForWorkspace(workspaceId: string): number {
    const set = this.backgroundableForegroundWaitersByWorkspaceId.get(workspaceId);
    if (!set || set.size === 0) return 0;

    const waiters = [...set];
    let count = 0;
    for (const waiter of waiters) {
      try {
        this.markTaskQueueBackgrounded(waiter.taskId);
        // A foreground wait detached by a queued message becomes durably non-blocking:
        // persist notify_on_terminal so future stream-ends and restarts do not re-force the
        // await. The in-memory mark above covers the immediate next stream-end while this
        // persistence settles. Tracked so handleStreamEnd can await it before reading config.
        this.scheduleNotifyOnTerminalPersist(waiter.taskId, waiter.requestingWorkspaceId);
        waiter.reject(new ForegroundWaitBackgroundedError());
        count++;
      } catch {
        // waiter already resolved/rejected — ignore
      }
    }
    return count;
  }

  /**
   * Persist `notify_on_terminal` on a backgrounded handle (agent task config or
   * workspace-turn record). Tracked per workspace so `handleStreamEnd` can await
   * any in-flight persistence before it reads config to decide blocking work.
   */
  /**
   * Durably mark a still-active task/handle as `notify_on_terminal`. Used when a foreground wait
   * detaches because it exceeded its foreground wait budget (timeout) and the work continues in the
   * background: like queued-message detachment, the work must not re-force the owner to await it.
   * Awaited so callers (e.g. the task tool) can rely on the policy before returning pending results.
   */
  async markBackgroundWorkNotifyOnTerminal(
    taskId: string,
    ownerWorkspaceId: string
  ): Promise<void> {
    await this.persistNotifyOnTerminalPolicy(taskId, ownerWorkspaceId);
  }

  private scheduleNotifyOnTerminalPersist(
    taskId: string,
    ownerWorkspaceId: string | undefined
  ): void {
    const promise = this.persistNotifyOnTerminalPolicy(taskId, ownerWorkspaceId)
      .catch((error: unknown) => {
        log.error("Failed to persist notify_on_terminal policy for backgrounded wait", {
          taskId,
          error,
        });
      })
      .finally(() => {
        this.pendingNotifyOnTerminalPersists.delete(promise);
      });
    this.pendingNotifyOnTerminalPersists.add(promise);
  }

  private async persistNotifyOnTerminalPolicy(
    taskId: string,
    ownerWorkspaceId: string | undefined
  ): Promise<void> {
    if (isWorkspaceTurnTaskId(taskId)) {
      if (ownerWorkspaceId != null) {
        await this.getWorkspaceTurnManager().markWorkspaceTurnBackgroundWorkNotifyOnTerminal(
          taskId,
          ownerWorkspaceId
        );
      }
      return;
    }
    await this.config.editConfig((config) => {
      const found = findWorkspaceEntry(config, taskId);
      if (found != null && found.workspace.taskAttentionPolicy !== "notify_on_terminal") {
        found.workspace.taskAttentionPolicy = "notify_on_terminal";
      }
      return config;
    });
  }

  /**
   * Level-triggered reconciliation scan: re-derive owed workflow terminal wakes from durable
   * state (top-level notify_on_terminal run records in a terminal status, minus
   * generation-scoped settled markers) into the in-memory queue and poke the drain. Runs at
   * startup and on a fixed sweep interval, so missed terminal callbacks, crashes, and
   * deferred (transiently unreadable) evaluations always get re-evaluated without any
   * per-failure retry bookkeeping. Archived workspaces are skipped, which parks their wakes
   * unsettled: the unarchive hook (noteWorkspaceUnarchived) and the next interval sweep
   * re-queue them instead of dropping them.
   */
  private async sweepWorkflowRunTerminalAttention(onlyWorkspaceId?: string): Promise<number> {
    const cfg = this.config.loadConfigOrDefault();
    let queuedCount = 0;
    for (const project of cfg.projects.values()) {
      for (const workspace of project.workspaces) {
        if (
          workspace.id == null ||
          (onlyWorkspaceId != null && workspace.id !== onlyWorkspaceId) ||
          isWorkspaceArchived(workspace.archivedAt, workspace.unarchivedAt)
        ) {
          continue;
        }
        const runStore = new WorkflowRunStore({
          sessionDir: path.join(this.config.sessionsDir, workspace.id),
        });
        let runs: Awaited<ReturnType<WorkflowRunStore["listRuns"]>>;
        try {
          runs = await runStore.listRuns();
        } catch (error: unknown) {
          log.warn("Failed to sweep workflow terminal attention", {
            workspaceId: workspace.id,
            error: getErrorMessage(error),
          });
          continue;
        }
        let queuedForWorkspace = false;
        for (const run of runs) {
          if (
            run.workspaceId !== workspace.id ||
            run.parentWorkflow != null ||
            resolveBackgroundWorkAttentionPolicy(run.attentionPolicy) !== "notify_on_terminal" ||
            // Interrupted runs were stopped deliberately: the terminal callback only notifies
            // them under an explicit service opt-in, and this re-derivation must not undo the
            // user's stop by injecting a continuation prompt. Opt-in callbacks queue directly.
            !WORKFLOW_BACKGROUND_CONTINUATION_STATUSES.has(run.status)
          ) {
            continue;
          }
          let marker: Awaited<ReturnType<TerminalAttentionStore["get"]>>;
          try {
            marker = await this.terminalAttentionStore.get(
              workspace.id,
              TerminalAttentionStore.notificationId("workflow_run", run.id, run.updatedAt)
            );
          } catch (error: unknown) {
            // Startup awaits this sweep, so one unreadable marker must not abort it (or app
            // init). Skip the run: an unreadable marker cannot prove the wake is owed, and
            // the next sweep retries, so delivery is delayed, never crashed or duplicated.
            log.warn("Failed to read workflow terminal settlement marker; skipping run", {
              workspaceId: workspace.id,
              runId: run.id,
              error: getErrorMessage(error),
            });
            continue;
          }
          if (marker != null) {
            continue;
          }
          // Upgrade compatibility: the previous build recorded consumption only under the
          // stable un-suffixed id (no generation markers), including history-invisible
          // consumption such as a kernel-nested task_await. The guard keeps generation
          // markers authoritative: the restart-time stable clear is best-effort, so a stale
          // previous-generation marker must not suppress the newer result; mismatched or
          // unparseable evidence fails toward notify.
          let stableMarker: Awaited<ReturnType<TerminalAttentionStore["get"]>>;
          try {
            stableMarker = await this.terminalAttentionStore.get(
              workspace.id,
              TerminalAttentionStore.notificationId("workflow_run", run.id)
            );
          } catch (error: unknown) {
            log.warn("Failed to read stable workflow settlement marker; skipping run", {
              workspaceId: workspace.id,
              runId: run.id,
              error: getErrorMessage(error),
            });
            continue;
          }
          if (
            stableMarker != null &&
            (stableMarker.status === "delivered" || stableMarker.status === "superseded")
          ) {
            // Prefer exact generation evidence (this build's settlement refresh records the
            // consumed generation), which is immune to wall-clock corrections; the createdAt
            // recency heuristic remains only for legacy markers from the previous build,
            // which recorded no generation.
            let consumedByStableMarker = stableMarker.generationId === run.updatedAt;
            if (!consumedByStableMarker && stableMarker.generationId == null) {
              const stableMarkerAt = Date.parse(stableMarker.createdAt);
              const terminalGenerationAt = Date.parse(run.updatedAt);
              consumedByStableMarker =
                Number.isFinite(stableMarkerAt) &&
                Number.isFinite(terminalGenerationAt) &&
                stableMarkerAt >= terminalGenerationAt;
            }
            if (consumedByStableMarker) {
              try {
                // Migrate the decision onto this generation's marker so later sweeps stay
                // single-read; the stable marker already proves consumption, so a failed
                // migration only re-runs this fallback on the next sweep.
                await this.terminalAttentionStore.recordSettled({
                  ownerWorkspaceId: workspace.id,
                  sourceKind: "workflow_run",
                  sourceId: run.id,
                  generationId: run.updatedAt,
                  terminalOutcome: terminalAttentionOutcome(run.status),
                  status: stableMarker.status,
                });
              } catch (error: unknown) {
                log.warn("Failed to migrate stable workflow settlement marker", {
                  workspaceId: workspace.id,
                  runId: run.id,
                  error: getErrorMessage(error),
                });
              }
              continue;
            }
          }
          if (this.queueWorkflowRunAttention(workspace.id, run.id)) {
            queuedCount += 1;
          }
          queuedForWorkspace = true;
        }
        if (queuedForWorkspace) {
          this.scheduleTerminalAttentionDrain(workspace.id);
        }
      }
    }
    return queuedCount;
  }

  // ---- Terminal attention notifier ------------------------------------------------------------
  // Deep module for delivering terminal wake-ups for notify_on_terminal work. Sub-agent and
  // workspace-turn settlements enqueue a persisted outbox notification (outside any settlement
  // lock); workflow wakes are level-triggered instead, re-derived from run records + settled
  // markers (see sweepWorkflowRunTerminalAttention). The drain fires when the owner is idle,
  // sends one coalesced synthetic wake-up, and records delivery only after an accepted send.

  /**
   * Note a top-level background workflow run's terminal transition and poke the drain. Purely
   * an accelerator over the durable state the sweep re-derives (run records + settled
   * markers): a lost poke, a removed workspace, or a later resume needs no compensation here,
   * so this writes nothing to disk.
   */
  noteWorkflowRunTerminalAttention(params: {
    ownerWorkspaceId: string;
    runId: string;
    status: WorkflowRunStatus;
  }): void {
    assert(
      params.ownerWorkspaceId.length > 0,
      "noteWorkflowRunTerminalAttention requires ownerWorkspaceId"
    );
    assert(params.runId.length > 0, "noteWorkflowRunTerminalAttention requires runId");
    if (!isTerminalWorkflowRunStatus(params.status)) {
      return;
    }
    this.queueWorkflowRunAttention(params.ownerWorkspaceId, params.runId);
    this.scheduleTerminalAttentionDrain(params.ownerWorkspaceId);
  }

  /**
   * Level-triggered retry for outbox (sub-agent / workspace-turn) attention: pending records
   * are the durable "wake owed" state, but unlike workflow runs they have no periodic
   * re-derivation of their own, so a drain that failed transiently (for example an unreadable
   * history for caller restrictions) would otherwise leave them stuck until restart. Startup
   * and the sweep interval both re-poke their owners; drains are idempotent and no-op when
   * nothing is deliverable.
   */
  private async schedulePendingTerminalAttentionOwnerDrains(): Promise<number> {
    const ownerWorkspaceIds = await this.terminalAttentionStore.listPendingOwnerWorkspaceIds();
    for (const ownerWorkspaceId of ownerWorkspaceIds) {
      this.scheduleTerminalAttentionDrain(ownerWorkspaceId);
    }
    return ownerWorkspaceIds.length;
  }

  /** Returns true when the run was newly queued for this owner. */
  private queueWorkflowRunAttention(ownerWorkspaceId: string, runId: string): boolean {
    let runIds = this.pendingWorkflowRunAttention.get(ownerWorkspaceId);
    if (runIds == null) {
      runIds = new Set();
      this.pendingWorkflowRunAttention.set(ownerWorkspaceId, runIds);
    }
    if (runIds.has(runId)) {
      return false;
    }
    runIds.add(runId);
    return true;
  }

  /**
   * Tool-path access to the invocation-boundary snapshot recorded into the
   * agent-workflow-runs sidecar (see recordBackgroundWorkflowRunReference).
   */
  async getWorkflowInvocationBoundaryMessageId(
    workspaceId: string,
    runId: string
  ): Promise<string | null> {
    return this.workspaceService.getWorkflowInvocationBoundaryMessageId(workspaceId, runId);
  }

  /**
   * Durable "this terminal generation needs no further wake" marker, keyed by the run's
   * terminal updatedAt: a later resume produces a new generation and thereby re-arms
   * attention without any reset bookkeeping. Write-once and best-effort by design: if the
   * write fails or never happens, the next drain evaluation re-derives the same answer from
   * run + history evidence and merely re-attempts the marker.
   */
  async markWorkflowRunTerminalAttentionSettled(params: {
    ownerWorkspaceId: string;
    runId: string;
    status: WorkflowRunStatus;
    runUpdatedAt: string;
    settledAs: "delivered" | "superseded";
  }): Promise<void> {
    assert(
      params.ownerWorkspaceId.length > 0,
      "markWorkflowRunTerminalAttentionSettled requires ownerWorkspaceId"
    );
    assert(params.runId.length > 0, "markWorkflowRunTerminalAttentionSettled requires runId");
    if (!isTerminalWorkflowRunStatus(params.status)) {
      return;
    }
    const key = `${params.ownerWorkspaceId}\u0000${params.runId}`;
    const previous = this.workflowRunSettlementByRun.get(key) ?? Promise.resolve();
    const run = previous
      .catch(() => undefined)
      .then(() => this.settleWorkflowRunTerminalAttention(params));
    const tracked = run
      .then(
        () => undefined,
        () => undefined
      )
      .finally(() => {
        if (this.workflowRunSettlementByRun.get(key) === tracked) {
          this.workflowRunSettlementByRun.delete(key);
        }
      });
    this.workflowRunSettlementByRun.set(key, tracked);
    return await run;
  }

  private async settleWorkflowRunTerminalAttention(params: {
    ownerWorkspaceId: string;
    runId: string;
    status: WorkflowRunStatus;
    runUpdatedAt: string;
    settledAs: "delivered" | "superseded";
  }): Promise<void> {
    try {
      // Downgrade compatibility: the previous build dedupes its startup re-derivation on the
      // stable un-suffixed workflow_run id, so settling only the generation marker would let
      // a downgraded build re-create a pending wake for a result the user already consumed.
      // Stable-first ordering keeps the generation marker (this build's authority) retryable:
      // if either write fails, the queue entry survives and the next drain re-settles both.
      // The refresh (not write-once) matters: a stale previous-generation stable marker can
      // survive its best-effort restart-time clear, and a downgraded build would read it as
      // consumption of THIS generation's result. The recorded generation also gives the
      // sweep's upgrade fallback exact evidence immune to wall-clock corrections.
      await this.terminalAttentionStore.recordSettled(
        {
          ownerWorkspaceId: params.ownerWorkspaceId,
          sourceKind: "workflow_run",
          sourceId: params.runId,
          generationId: params.runUpdatedAt,
          terminalOutcome: terminalAttentionOutcome(params.status),
          status: params.settledAs,
        },
        { wholeSourceRefresh: true }
      );
      await this.terminalAttentionStore.recordSettled({
        ownerWorkspaceId: params.ownerWorkspaceId,
        sourceKind: "workflow_run",
        sourceId: params.runId,
        generationId: params.runUpdatedAt,
        terminalOutcome: terminalAttentionOutcome(params.status),
        status: params.settledAs,
      });
    } catch (error: unknown) {
      // Contain marker I/O here so no caller fails on bookkeeping: workflow_resume and
      // task_await must still return the run's durable result, and the drain must move on to
      // its other candidates. Keep the queue entry so the next drain re-evaluates from run +
      // history evidence and re-attempts the marker; at worst a truthful wake re-delivers.
      log.warn("Failed to record workflow terminal settlement marker", {
        ownerWorkspaceId: params.ownerWorkspaceId,
        runId: params.runId,
        settledAs: params.settledAs,
        error,
      });
      return;
    }
    // Post-write revalidation: a wake-turn workflow_resume can restart the run while this
    // settlement's snapshot was in flight, so the restart-time stable clear can land BEFORE
    // the stable write above re-creates the marker. That marker postdates the newer
    // generation's updatedAt, so the sweep's upgrade fallback (and a downgraded build's
    // whole-run dedupe) would permanently suppress the newer result, and the by-run-id queue
    // delete below would drop its owed wake. Reading the run AFTER the writes closes the
    // write-side race: any restart after this read re-clears the stable marker itself and
    // its terminal callback re-queues behind this deletion.
    let currentRunUpdatedAt: string | null;
    try {
      const runStore = new WorkflowRunStore({
        sessionDir: path.join(this.config.sessionsDir, params.ownerWorkspaceId),
      });
      currentRunUpdatedAt = (await runStore.getRun(params.runId)).updatedAt;
    } catch {
      currentRunUpdatedAt = null;
    }
    if (currentRunUpdatedAt !== params.runUpdatedAt) {
      // The settled snapshot is no longer the run's newest generation (or the run is
      // unreadable): the stable whole-run marker must not outlive the snapshot. The
      // generation marker stays; it truthfully settles only this snapshot.
      await this.clearWorkflowRunDowngradeSettlement({
        ownerWorkspaceId: params.ownerWorkspaceId,
        runId: params.runId,
      });
      if (currentRunUpdatedAt != null) {
        // The queue entry now represents the newer generation's owed wake: leave it for the
        // drain the terminal callback scheduled (the sweep backstops a lost poke).
        return;
      }
      // Unreadable run: fall through to the delete. With no stable marker surviving, the
      // sweep re-derives any owed newer generation from durable state.
    }
    this.pendingWorkflowRunAttention.get(params.ownerWorkspaceId)?.delete(params.runId);
  }

  /**
   * Downgrade-compat bookkeeping only: settlement dual-writes a stable un-suffixed marker for
   * the previous build's whole-run dedupe (see markWorkflowRunTerminalAttentionSettled), and a
   * restarted run invalidates it. Without this delete, downgrading after a resume would leave
   * the old build refusing to enqueue the run's newer result behind the stale stable marker.
   * This build reads the stable marker only as recency-gated upgrade evidence behind
   * generation markers (see sweepWorkflowRunTerminalAttention), so the delete stays
   * best-effort and must never fail the status transition.
   */
  async clearWorkflowRunDowngradeSettlement(params: {
    ownerWorkspaceId: string;
    runId: string;
  }): Promise<void> {
    assert(
      params.ownerWorkspaceId.length > 0,
      "clearWorkflowRunDowngradeSettlement requires ownerWorkspaceId"
    );
    assert(params.runId.length > 0, "clearWorkflowRunDowngradeSettlement requires runId");
    try {
      await this.terminalAttentionStore.delete(
        params.ownerWorkspaceId,
        TerminalAttentionStore.notificationId("workflow_run", params.runId)
      );
    } catch (error: unknown) {
      log.warn("Failed to clear stale workflow downgrade settlement marker", {
        ownerWorkspaceId: params.ownerWorkspaceId,
        runId: params.runId,
        error,
      });
    }
  }

  private async suppressTerminalAttention(params: {
    ownerWorkspaceId: string;
    sourceKind: TerminalAttentionNotification["sourceKind"];
    sourceId: string;
  }): Promise<void> {
    await this.terminalAttentionStore.enqueueIfAbsent({
      ...params,
      terminalOutcome: "interrupted",
    });
    await this.terminalAttentionStore.markSuperseded(
      params.ownerWorkspaceId,
      TerminalAttentionStore.notificationId(params.sourceKind, params.sourceId)
    );
  }

  private async getAgentTerminalAttentionGenerationId(
    ownerWorkspaceId: string,
    childTaskId: string
  ): Promise<string | undefined> {
    const execution = await this.getDescendantAgentTaskExecutionSnapshot(
      ownerWorkspaceId,
      childTaskId
    );
    return execution?.record.handleId;
  }

  async enqueueTerminalAttention(params: {
    ownerWorkspaceId: string;
    sourceKind: TerminalAttentionNotification["sourceKind"];
    terminalOutcome: TerminalAttentionOutcome;
    sourceId: string;
    generationId?: string;
  }): Promise<void> {
    const created = await this.terminalAttentionStore.enqueueIfAbsent(params);
    if (created == null) {
      return;
    }
    this.scheduleTerminalAttentionDrain(params.ownerWorkspaceId);
  }

  scheduleTerminalAttentionDrain(ownerWorkspaceId: string): void {
    const previous = this.pendingTerminalAttentionDrainsByOwner.get(ownerWorkspaceId);
    const promise = (previous ?? Promise.resolve())
      .catch(() => undefined)
      .then(() => this.drainTerminalAttention(ownerWorkspaceId))
      .catch((error: unknown) => {
        log.error("Terminal attention drain failed", { ownerWorkspaceId, error });
      })
      .finally(() => {
        this.pendingTerminalAttentionDrains.delete(promise);
        if (this.pendingTerminalAttentionDrainsByOwner.get(ownerWorkspaceId) === promise) {
          this.pendingTerminalAttentionDrainsByOwner.delete(ownerWorkspaceId);
        }
      });
    this.pendingTerminalAttentionDrainsByOwner.set(ownerWorkspaceId, promise);
    this.pendingTerminalAttentionDrains.add(promise);
  }

  /**
   * Caller send restrictions (tool policy, workspace-agent disable flag, strict-agent pin) to
   * restore on a terminal-attention wake. The newest manual user row carries the
   * conversation's persisted restrictions; synthetic rows without any (earlier wakes,
   * heartbeat scaffolding) do not define them and are skipped. The walk is unbounded: a long
   * assistant/synthetic tail after the launch turn must not push the defining row out of
   * sight and silently lift the restrictions. It stops at the newest context reset boundary,
   * since rows from the discarded context must not re-disable tools available to the reset
   * context. Throws when history is unreadable so the caller can fail closed instead of
   * waking with unrestricted tools.
   */
  private async resolveTerminalWakeCallerSendRestrictions(ownerWorkspaceId: string): Promise<{
    toolPolicy?: ToolPolicy;
    disableWorkspaceAgents?: boolean;
    strictAgentResolution?: SendMessageOptions["strictAgentResolution"];
  }> {
    // The pin and the policy resolve independently: a synthetic launch row (preserved
    // heartbeat, compaction follow-up) can carry only a strict pin, and the wake bound to that
    // turn's agent must keep the pin loud without lifting an older manual row's policy.
    // Manual rows still define both wholesale (absence means lifted).
    const state: {
      pin: { strictAgentResolution?: SendMessageOptions["strictAgentResolution"] } | null;
      restrictions: { toolPolicy?: ToolPolicy; disableWorkspaceAgents?: boolean } | null;
    } = { pin: null, restrictions: null };
    const historyResult = await this.historyService.iterateFullHistory(
      ownerWorkspaceId,
      "backward",
      (messages) => {
        for (const message of messages) {
          // A context reset discards everything before it: pre-reset rows must not define
          // the wake's restrictions or pin. Stopping here leaves undefined fields as fresh
          // defaults, matching a manual send in the post-reset context.
          if (isResetBoundaryMessage(message)) {
            return false;
          }
          if (message.role !== "user") {
            continue;
          }
          // A compaction request disables every tool for its own summary turn only. That
          // per-turn policy is not a caller restriction: adopting it would strip all tools
          // from every wake until the next manual send, so the walk keeps going to the row
          // that actually defines the conversation's restrictions.
          if (isCompactionRequestMessage(message)) {
            continue;
          }
          const metadata = message.metadata;
          // The strict-agent pin lives in the row's retry snapshot: an explicit agent override
          // must stay loud on the wake too, or a vanished/corrupted definition would silently
          // recompose the send from the exec fallback (same rule as startup retry and
          // compaction follow-ups). Forwarded verbatim per the field's design note: the object
          // form pins the validated definition's scope/source/chain provenance, not just
          // loudness. Schema-validated like toolPolicy below, since it crosses the same
          // persisted-row boundary; invalid shapes are dropped.
          const rawStrictPin = metadata?.retrySendOptions?.strictAgentResolution;
          const parsedStrictPin =
            rawStrictPin != null && rawStrictPin !== false
              ? SendMessageOptionsSchema.shape.strictAgentResolution.safeParse(rawStrictPin)
              : null;
          if (parsedStrictPin != null && !parsedStrictPin.success) {
            log.warn("Ignoring malformed persisted strictAgentResolution on terminal wake", {
              ownerWorkspaceId,
              messageId: message.id,
            });
          }
          const strictAgentResolution = parsedStrictPin?.success ? parsedStrictPin.data : undefined;
          if (
            state.pin == null &&
            (strictAgentResolution != null || metadata?.synthetic !== true)
          ) {
            state.pin = strictAgentResolution != null ? { strictAgentResolution } : {};
          }
          if (
            state.restrictions == null &&
            (metadata?.toolPolicy != null ||
              metadata?.disableWorkspaceAgents != null ||
              metadata?.synthetic !== true)
          ) {
            // Persisted rows are untrusted disk state: a malformed toolPolicy would throw deep
            // inside send resolution and leave the wake permanently blocked on the same corrupt
            // row. Sanitize instead of trusting the JSON shape; an unparseable policy restores
            // nothing while a valid disable flag still applies (self-healing doctrine).
            const parsedPolicy =
              metadata?.toolPolicy != null ? ToolPolicySchema.safeParse(metadata.toolPolicy) : null;
            if (parsedPolicy != null && !parsedPolicy.success) {
              log.warn("Ignoring malformed persisted toolPolicy on terminal wake", {
                ownerWorkspaceId,
                messageId: message.id,
              });
            }
            state.restrictions = {
              ...(parsedPolicy?.success ? { toolPolicy: parsedPolicy.data } : {}),
              ...(typeof metadata?.disableWorkspaceAgents === "boolean"
                ? { disableWorkspaceAgents: metadata.disableWorkspaceAgents }
                : {}),
            };
          }
          if (state.pin != null && state.restrictions != null) {
            return false;
          }
        }
        return undefined;
      }
    );
    if (!historyResult.success) {
      throw new Error(`history unavailable: ${historyResult.error}`);
    }
    return { ...(state.restrictions ?? {}), ...(state.pin ?? {}) };
  }

  private scheduleTerminalAttentionDrainAfterIdle(ownerWorkspaceId: string): void {
    const promise = this.workspaceService
      .waitForIdleAndNoQueuedMessages(ownerWorkspaceId)
      .catch((error: unknown) => {
        log.debug("Terminal attention idle wait failed; retrying drain anyway", {
          ownerWorkspaceId,
          error,
        });
      })
      .then(() => {
        this.scheduleTerminalAttentionDrain(ownerWorkspaceId);
      })
      .finally(() => {
        this.pendingTerminalAttentionDrains.delete(promise);
      });
    this.pendingTerminalAttentionDrains.add(promise);
  }

  /**
   * Last-moment revalidation for an already-materialized workflow prompt candidate. The
   * composed prompt retains the run snapshot captured at derivation, and invocation
   * currentness alone (conversation evidence) misses two hazards that arrive without
   * touching history or owner busy-ness:
   * - the run's generation can change (a Workflows UI resume/retry flips it back to running;
   *   a kernel resume can complete a NEWER generation), so the retained prompt would deliver
   *   a stale result as if final;
   * - a kernel-nested task_await can consume this generation, writing only the settlement
   *   marker, so resending would replay output the conversation already handled.
   * "superseded" settles the candidate; "defer" leaves its queue entry pending so a later
   * drain re-derives from the then-current run record and markers.
   * Currentness is deliberately the LAST await: it is the read that observes a destructive
   * history mutation (clear/truncation) retiring the run's invocation, and any awaited read
   * after it would reopen the stale-injection window this reread exists to close.
   */
  private async revalidateWorkflowPromptForDispatch(
    ownerWorkspaceId: string,
    candidate: { runId: string; run: WorkflowRunRecord }
  ): Promise<"deliverable" | "superseded" | "defer"> {
    try {
      const runStore = new WorkflowRunStore({
        sessionDir: path.join(this.config.sessionsDir, ownerWorkspaceId),
      });
      const currentRun = await runStore.getRun(candidate.runId);
      if (
        currentRun.status !== candidate.run.status ||
        currentRun.updatedAt !== candidate.run.updatedAt
      ) {
        return "defer";
      }
      const settledMarker = await this.terminalAttentionStore.get(
        ownerWorkspaceId,
        TerminalAttentionStore.notificationId(
          "workflow_run",
          candidate.runId,
          candidate.run.updatedAt
        )
      );
      if (settledMarker != null) {
        return "defer";
      }
    } catch {
      return "defer";
    }
    const currentness = await this.workspaceService
      .getWorkflowInvocationCurrentness(ownerWorkspaceId, candidate.runId)
      .catch(() => "indeterminate" as const);
    if (currentness !== "current") {
      return currentness === "not_current" ? "superseded" : "defer";
    }
    return "deliverable";
  }

  private async buildWorkflowTerminalPrompt(
    ownerWorkspaceId: string,
    runId: string
  ): Promise<
    | {
        outcome: "deliver";
        prompt: string;
        run: WorkflowRunRecord;
        initiatingAgent?: WorkflowWakeInitiatingAgent;
      }
    // settle: superseded or already consumed; record the generation marker so scans stop here.
    | { outcome: "settle"; run: WorkflowRunRecord }
    // drop: not (or no longer) a wake candidate; just dequeue, nothing durable to mark.
    | { outcome: "drop" }
    // defer: state transiently unreadable; keep queued for the next drain trigger or sweep.
    | { outcome: "defer" }
  > {
    assert(ownerWorkspaceId.length > 0, "buildWorkflowTerminalPrompt requires ownerWorkspaceId");
    assert(runId.length > 0, "buildWorkflowTerminalPrompt requires runId");
    const runStore = new WorkflowRunStore({
      sessionDir: path.join(this.config.sessionsDir, ownerWorkspaceId),
    });
    let run: Awaited<ReturnType<WorkflowRunStore["getRun"]>>;
    try {
      run = await runStore.getRun(runId);
    } catch (error: unknown) {
      // A missing run (ENOENT) or an unparseable record (no fs code; rereading cannot repair
      // it) is definitively ineligible. Every other fs failure (EIO, EACCES, EISDIR...) is
      // potentially transient, and dropping on it would delay the wake to the next sweep's
      // re-derivation for no reason: defer those like indeterminate currentness below.
      const code =
        error != null && typeof error === "object" && "code" in error
          ? (error as { code?: unknown }).code
          : undefined;
      if (typeof code === "string" && code !== "ENOENT") {
        log.warn("Deferring workflow terminal wake-up; run record unreadable", {
          ownerWorkspaceId,
          runId,
          error: getErrorMessage(error),
        });
        return { outcome: "defer" };
      }
      log.warn("Failed to load terminal workflow run for wake-up", {
        ownerWorkspaceId,
        runId,
        error: getErrorMessage(error),
      });
      return { outcome: "drop" };
    }
    if (
      run.workspaceId !== ownerWorkspaceId ||
      run.parentWorkflow != null ||
      // A resumed run left terminal state; its next terminal transition re-queues it.
      !isTerminalWorkflowRunStatus(run.status)
    ) {
      return { outcome: "drop" };
    }
    // The durable settled marker outranks the in-memory queue entry: a kernel-nested
    // task_await or workflow_resume can settle this generation after the terminal callback
    // queued it, and that consumption leaves no history evidence for the classification
    // below, so skipping this check would deliver a duplicate wake.
    let settledMarker: Awaited<ReturnType<TerminalAttentionStore["get"]>>;
    try {
      settledMarker = await this.terminalAttentionStore.get(
        ownerWorkspaceId,
        TerminalAttentionStore.notificationId("workflow_run", run.id, run.updatedAt)
      );
    } catch (error: unknown) {
      // An unreadable marker cannot prove the wake is owed; defer like indeterminate currentness.
      log.warn("Deferring workflow terminal wake-up; settlement marker unreadable", {
        ownerWorkspaceId,
        runId,
        error: getErrorMessage(error),
      });
      return { outcome: "defer" };
    }
    if (settledMarker != null) {
      return { outcome: "drop" };
    }
    const currentness = await this.workspaceService.getWorkflowInvocationCurrentness(
      ownerWorkspaceId,
      run.id
    );
    // Indeterminate means history was unreadable, not that the run was superseded: settling
    // now would permanently drop the wake over a transient fault, so defer and retry instead.
    if (currentness === "indeterminate") {
      return { outcome: "defer" };
    }
    if (currentness === "not_current") {
      return { outcome: "settle", run };
    }
    // Bind the wake to the agent recorded at launch: the newest agent-bearing assistant row
    // can belong to an unrelated later synthetic turn (a heartbeat is not a supersession
    // boundary), which would pair a different agent's tool surface with the launch turn's
    // caller policy. Advisory: legacy references fall back to the history walk.
    let initiatingAgent: WorkflowWakeInitiatingAgent | undefined;
    try {
      const references = await readAgentWorkflowRunReferences(
        path.join(this.config.sessionsDir, ownerWorkspaceId)
      );
      const reference = references.find((candidate) => candidate.runId === run.id);
      if (reference?.agentId != null) {
        initiatingAgent = {
          agentId: reference.agentId,
          createdAtMs: reference.createdAtMs,
          ...(reference.strictAgentResolution !== undefined
            ? { strictAgentResolution: reference.strictAgentResolution }
            : {}),
        };
      }
    } catch {
      // Currentness can succeed (e.g. a direct invocation row) and this identity read still
      // fail transiently. Delivering without the recorded identity would bind the wake to the
      // newest agent-bearing history row, handing the run's output to an unrelated later
      // synthetic turn's agent; defer like an unreadable run record.
      return { outcome: "defer" };
    }
    const scriptPath = run.workflow.sourcePath ?? run.workflow.name;
    return {
      outcome: "deliver",
      run,
      ...(initiatingAgent != null ? { initiatingAgent } : {}),
      prompt: buildWorkflowResultContextMessage({
        rawCommand: `workflow_run ${scriptPath}`,
        name: scriptPath,
        runId: run.id,
        status: run.status,
        result: null,
        run,
      }),
    };
  }

  private async ensureAgentTerminalMessages(
    ownerWorkspaceId: string,
    notifications: readonly TerminalAttentionNotification[]
  ): Promise<{
    deliverableNotificationIds: Set<string>;
    latestMessageTimestampByTaskId: Map<string, number>;
  }> {
    const deliverableNotificationIds = new Set<string>();
    const latestMessageTimestampByTaskId = new Map<string, number>();
    const historyResult = await this.historyService.getHistoryFromLatestBoundary(ownerWorkspaceId);
    if (!historyResult.success) {
      return { deliverableNotificationIds, latestMessageTimestampByTaskId };
    }
    const existingReportMessages = new Map<string, MuxMessage>();
    const existingTaskIds = new Set<string>();
    for (const message of historyResult.data) {
      if (message.role !== "user" || message.metadata?.synthetic !== true) continue;
      const taskId = parseTerminalSubagentTaskId(
        message.parts
          .filter((part): part is Extract<typeof part, { type: "text" }> => part.type === "text")
          .map((part) => part.text)
          .join("\n")
      );
      if (taskId == null) continue;
      existingTaskIds.add(taskId);
      existingReportMessages.set(taskId, message);
      const timestamp = message.metadata?.timestamp;
      if (typeof timestamp === "number" && Number.isFinite(timestamp)) {
        latestMessageTimestampByTaskId.set(
          taskId,
          Math.max(latestMessageTimestampByTaskId.get(taskId) ?? 0, timestamp)
        );
      }
    }

    const workspaceTurnMuxMetadata =
      await this.getWorkspaceTurnManager().getActiveWorkspaceTurnMuxMetadataForWorkspace(
        ownerWorkspaceId
      );
    const sessionDir = path.join(this.config.sessionsDir, ownerWorkspaceId);
    for (const notification of notifications) {
      if (existingTaskIds.has(notification.sourceId)) {
        const existingMessage = existingReportMessages.get(notification.sourceId);
        if (existingMessage != null && workspaceTurnMuxMetadata != null) {
          const existingCorrelation =
            this.getWorkspaceTurnManager().getWorkspaceTurnMetadataFromValue(
              existingMessage.metadata?.muxMetadata
            );
          if (existingCorrelation != null) {
            const matchesActiveTurn =
              existingCorrelation.taskHandleId === workspaceTurnMuxMetadata.taskHandleId &&
              existingCorrelation.ownerWorkspaceId === workspaceTurnMuxMetadata.ownerWorkspaceId &&
              existingCorrelation.turnId === workspaceTurnMuxMetadata.turnId;
            if (!matchesActiveTurn) {
              // Keep the old report visible, but do not let it wake or settle a later turn.
              await this.terminalAttentionStore.markSuperseded(ownerWorkspaceId, notification.id);
              continue;
            }
          } else {
            const updatedMessage: MuxMessage = {
              ...existingMessage,
              metadata: {
                ...existingMessage.metadata,
                muxMetadata: workspaceTurnMuxMetadata,
              },
            };
            const updateResult = await this.historyService.updateHistory(
              ownerWorkspaceId,
              updatedMessage
            );
            if (updateResult.success) {
              existingReportMessages.set(notification.sourceId, updatedMessage);
              this.workspaceService.emitChatEvent(ownerWorkspaceId, {
                ...updatedMessage,
                type: "message",
              });
            } else {
              log.warn("Failed to backfill workspace-turn metadata on terminal report", {
                ownerWorkspaceId,
                taskId: notification.sourceId,
                error: updateResult.error,
              });
            }
          }
        }

        // Report/failure delivery necessarily precedes terminal-attention enqueue. Presence in parent
        // history is therefore authoritative here; continuation freshness is checked separately
        // against the private execution's createdAt before suppressing its workspace-turn wake.
        deliverableNotificationIds.add(notification.id);
        continue;
      }

      const report = await readSubagentReportArtifact(sessionDir, notification.sourceId);
      const failure =
        report == null
          ? await readSubagentFailureArtifact(sessionDir, notification.sourceId)
          : null;
      const content = report
        ? formatSubagentReportUserMessage({
            childWorkspaceId: notification.sourceId,
            agentType: "agent",
            title: report.title ?? "Subagent report",
            reportMarkdown: report.reportMarkdown,
            status: "completed",
            ...(report.model != null ? { model: report.model } : {}),
            ...(report.thinkingLevel != null ? { thinkingLevel: report.thinkingLevel } : {}),
            ...(report.structuredOutput !== undefined
              ? { structuredOutput: report.structuredOutput }
              : {}),
          })
        : failure
          ? formatSubagentFailureUserMessage({
              childWorkspaceId: notification.sourceId,
              agentType: "agent",
              errorType: failure.errorType,
              errorMessage: failure.errorMessage,
            })
          : null;
      if (content == null) {
        log.warn("Superseding terminal sub-agent attention with no durable result", {
          ownerWorkspaceId,
          taskId: notification.sourceId,
        });
        await this.terminalAttentionStore.markSuperseded(ownerWorkspaceId, notification.id);
        continue;
      }

      const timestamp = Date.now();
      const message = createMuxMessage(
        report != null ? createTaskReportMessageId() : createTaskFailureMessageId(),
        "user",
        content,
        {
          timestamp,
          synthetic: true,
          uiVisible: true,
          ...(workspaceTurnMuxMetadata != null ? { muxMetadata: workspaceTurnMuxMetadata } : {}),
        }
      );
      const appendResult = await this.historyService.appendToHistory(ownerWorkspaceId, message);
      if (!appendResult.success) {
        log.warn("Failed to repair terminal sub-agent message", {
          ownerWorkspaceId,
          taskId: notification.sourceId,
          error: appendResult.error,
        });
        continue;
      }
      this.workspaceService.emitChatEvent(ownerWorkspaceId, { ...message, type: "message" });
      existingTaskIds.add(notification.sourceId);
      latestMessageTimestampByTaskId.set(notification.sourceId, timestamp);
      deliverableNotificationIds.add(notification.id);
    }
    return { deliverableNotificationIds, latestMessageTimestampByTaskId };
  }

  private async consumeRespondedAgentTerminalAttention(ownerWorkspaceId: string): Promise<void> {
    const pending = (await this.terminalAttentionStore.listPending(ownerWorkspaceId)).filter(
      (notification) => notification.sourceKind === "agent_task"
    );
    if (pending.length === 0) return;

    const pendingIds = new Set(pending.map((notification) => notification.sourceId));
    const terminalSequenceByTaskId = new Map<string, number>();
    const responded = new Set<string>();
    const historyResult = await this.historyService.getHistoryFromLatestBoundary(ownerWorkspaceId);
    if (!historyResult.success) {
      log.warn("Failed to inspect terminal sub-agent responses", {
        ownerWorkspaceId,
        error: historyResult.error,
      });
      return;
    }

    for (const message of historyResult.data) {
      if (message.role === "user" && message.metadata?.synthetic === true) {
        const text = message.parts
          .filter((part): part is Extract<typeof part, { type: "text" }> => part.type === "text")
          .map((part) => part.text)
          .join("\n");
        const taskId = parseTerminalSubagentTaskId(text);
        const historySequence = message.metadata?.historySequence;
        if (taskId != null && pendingIds.has(taskId) && typeof historySequence === "number") {
          terminalSequenceByTaskId.set(taskId, historySequence);
          responded.delete(taskId);
        }
        continue;
      }

      if (message.role === "assistant" && message.metadata?.partial !== true) {
        const requestHistorySequence = message.metadata?.requestHistorySequence;
        if (typeof requestHistorySequence !== "number") continue;
        for (const [taskId, terminalSequence] of terminalSequenceByTaskId) {
          if (requestHistorySequence >= terminalSequence) responded.add(taskId);
        }
      }
    }

    for (const notification of pending) {
      if (responded.has(notification.sourceId)) {
        await this.terminalAttentionStore.markDelivered(ownerWorkspaceId, notification.id);
      }
    }
  }

  /**
   * Back the given terminal-wake send batches off until the sweep cadence retries them and
   * re-poke the drain so the remaining batches get their send this cycle instead of starving
   * behind the failed one.
   */
  private backOffTerminalWakeSends(ownerWorkspaceId: string, keys: readonly string[]): void {
    assert(keys.length > 0, "backOffTerminalWakeSends requires keys");
    let ownerBackoff = this.workflowWakeGroupSendBackoffUntilMs.get(ownerWorkspaceId);
    if (ownerBackoff == null) {
      ownerBackoff = new Map();
      this.workflowWakeGroupSendBackoffUntilMs.set(ownerWorkspaceId, ownerBackoff);
    }
    const retryAt = Date.now() + WORKFLOW_TERMINAL_ATTENTION_SWEEP_INTERVAL_MS;
    for (const key of keys) {
      ownerBackoff.set(key, retryAt);
    }
    this.scheduleTerminalAttentionDrain(ownerWorkspaceId);
  }

  /**
   * Drain pending terminal notifications for one owner workspace: defer (leave pending) when the
   * owner is busy/queued/preparing, otherwise send one coalesced synthetic wake-up and mark the
   * drained notifications delivered. Stale (deleted-workspace) notifications are marked superseded.
   */
  private async drainTerminalAttention(ownerWorkspaceId: string): Promise<void> {
    const allPending = await this.terminalAttentionStore.listPending(ownerWorkspaceId);
    // Legacy pre-reconciler outbox records for workflow runs (no generation suffix) are dead
    // state now that workflow wakes are re-derived from run records + settled markers: delete
    // them so they cannot hold the drain hot forever.
    for (const notification of allPending) {
      if (notification.sourceKind === "workflow_run") {
        await this.terminalAttentionStore.delete(ownerWorkspaceId, notification.id);
      }
    }
    const pending = allPending.filter((notification) => notification.sourceKind !== "workflow_run");
    const queuedWorkflowRunIds = Array.from(
      this.pendingWorkflowRunAttention.get(ownerWorkspaceId) ?? []
    );
    if (pending.length === 0 && queuedWorkflowRunIds.length === 0) {
      return;
    }

    const cfg = this.config.loadConfigOrDefault();
    const entry = findWorkspaceEntry(cfg, ownerWorkspaceId);
    if (entry == null) {
      // Owner workspace no longer exists: the terminal artifacts remain retrievable elsewhere.
      // Queue only, no markers: a settled-marker write would recreate the deleted session dir.
      this.pendingWorkflowRunAttention.delete(ownerWorkspaceId);
      for (const notification of pending) {
        await this.terminalAttentionStore.markSuperseded(ownerWorkspaceId, notification.id);
      }
      return;
    }

    if (isWorkspaceArchived(entry.workspace.archivedAt, entry.workspace.unarchivedAt)) {
      // Workflow wakes stay unsettled while archived: the sweep skips archived workspaces, so
      // dropping the queue parks them until an unarchive-time sweep re-derives the entries.
      this.pendingWorkflowRunAttention.delete(ownerWorkspaceId);
      for (const notification of pending) {
        await this.terminalAttentionStore.markSuperseded(ownerWorkspaceId, notification.id);
      }
      return;
    }

    // Defer-until-idle: never inject ahead of an active stream or a queued/preparing user turn.
    const ownerHasPendingQueuedPreparingOrRetry =
      this.workspaceService.hasPendingQueuedOrPreparingTurn(ownerWorkspaceId);
    const ownerHasBusyQueuedOrRetry =
      this.workspaceService.isBusyForMessage(ownerWorkspaceId) ||
      this.workspaceService.hasQueuedMessages(ownerWorkspaceId) ||
      ownerHasPendingQueuedPreparingOrRetry;
    if (
      this.aiService.isStreaming(ownerWorkspaceId) ||
      ownerHasPendingQueuedPreparingOrRetry ||
      this.interruptedParentWorkspaceIds.has(ownerWorkspaceId)
    ) {
      if (ownerHasBusyQueuedOrRetry && !this.interruptedParentWorkspaceIds.has(ownerWorkspaceId)) {
        this.scheduleTerminalAttentionDrainAfterIdle(ownerWorkspaceId);
      }
      return;
    }

    const taskIndex = this.buildAgentTaskIndex(cfg);
    if (await this.hasBlockingActiveWorkForTerminalDrain(ownerWorkspaceId, taskIndex)) {
      return;
    }

    const agentNotifications = pending.filter(
      (notification) => notification.sourceKind === "agent_task"
    );
    const {
      deliverableNotificationIds: deliverableAgentNotificationIds,
      latestMessageTimestampByTaskId,
    } = await this.ensureAgentTerminalMessages(ownerWorkspaceId, agentNotifications);
    const workspaceTurnNotifications = pending.filter(
      (notification) => notification.sourceKind === "workspace_turn"
    );
    const workspaceTurnCandidates: Array<{
      notification: (typeof pending)[number];
      publicAwaitId: string;
    }> = [];
    for (const notification of workspaceTurnNotifications) {
      const record = await this.getWorkspaceTurnManager().getWorkspaceTurnRecord(
        ownerWorkspaceId,
        notification.sourceId
      );
      const isPersistentChildContinuation =
        record != null &&
        this.isDescendantAgentTaskUsingParentById(
          taskIndex.parentById,
          ownerWorkspaceId,
          record.workspaceId
        );
      if (isPersistentChildContinuation) {
        const latestTerminalMessageAt = latestMessageTimestampByTaskId.get(record.workspaceId);
        const continuationCreatedAt = Date.parse(record.createdAt);
        if (
          latestTerminalMessageAt != null &&
          Number.isFinite(continuationCreatedAt) &&
          latestTerminalMessageAt >= continuationCreatedAt
        ) {
          // A persistent child continuation reports through the stable child transcript row. Once
          // that report/failure is in parent history, a second task_await wake for the private
          // workspace-turn handle is redundant and exposes an implementation detail to the user.
          await this.terminalAttentionStore.markSuperseded(ownerWorkspaceId, notification.id);
          continue;
        }
      }

      workspaceTurnCandidates.push({
        notification,
        publicAwaitId: isPersistentChildContinuation ? record.workspaceId : notification.sourceId,
      });
    }
    const deliverableWorkflowPrompts: Array<{
      runId: string;
      run: WorkflowRunRecord;
      prompt: string;
      initiatingAgent?: WorkflowWakeInitiatingAgent;
    }> = [];

    for (const runId of queuedWorkflowRunIds) {
      const workflowPrompt = await this.buildWorkflowTerminalPrompt(ownerWorkspaceId, runId);
      if (workflowPrompt.outcome === "defer") {
        // History, sidecar, or the run record was transiently unreadable: the run stays
        // queued and the next drain trigger or sweep re-evaluates it.
        log.warn("Deferring workflow terminal attention; state unavailable", {
          ownerWorkspaceId,
          runId,
        });
        continue;
      }
      if (workflowPrompt.outcome === "drop") {
        this.pendingWorkflowRunAttention.get(ownerWorkspaceId)?.delete(runId);
        continue;
      }
      if (workflowPrompt.outcome === "settle") {
        // Dropping a notify_on_terminal wake strands the run's owner; keep the drop diagnosable.
        log.warn("Settling superseded workflow terminal attention", {
          ownerWorkspaceId,
          runId,
        });
        await this.markWorkflowRunTerminalAttentionSettled({
          ownerWorkspaceId,
          runId,
          status: workflowPrompt.run.status,
          runUpdatedAt: workflowPrompt.run.updatedAt,
          settledAs: "superseded",
        });
        continue;
      }
      deliverableWorkflowPrompts.push({
        runId,
        run: workflowPrompt.run,
        prompt: workflowPrompt.prompt,
        ...(workflowPrompt.initiatingAgent != null
          ? { initiatingAgent: workflowPrompt.initiatingAgent }
          : {}),
      });
    }
    // Deliver one launch-identity group per drain, keyed by agentId AND recorded strict pin:
    // the whole coalesced prompt is handled under the single agentId/pin passed to
    // sendMessage, so batching runs from different launch identities would hand a restricted
    // launch's (attacker-influenced) output to another launch's tool grants. Mixed batches
    // too: workspace-turn and sub-agent attention resumes under the conversation's own
    // (history-walk) identity, so agent-bound workflow groups never share their send.
    // Unselected groups stay queued for a later drain; the newest launch goes first.
    // Suppression revalidation below can only shrink the workspace-turn set, so gating on
    // pre-suppression candidates over-approximates non-workflow deliverables: the safe
    // direction, deferring agent-bound groups rather than ever mixing identities in one send.
    // A backed-off non-workflow batch (its conversation-identity send was rejected) sits out
    // the drain entirely, staying pending for the sweep-cadence retry, so agent-bound groups
    // are not starved behind a send that fails the same way on every drain.
    const nonWorkflowSendBackoffUntil = this.workflowWakeGroupSendBackoffUntilMs
      .get(ownerWorkspaceId)
      ?.get(NON_WORKFLOW_WAKE_BACKOFF_KEY);
    let nonWorkflowSendBackedOff = false;
    if (nonWorkflowSendBackoffUntil != null) {
      if (nonWorkflowSendBackoffUntil > Date.now()) {
        nonWorkflowSendBackedOff = true;
      } else {
        const ownerBackoff = this.workflowWakeGroupSendBackoffUntilMs.get(ownerWorkspaceId);
        ownerBackoff?.delete(NON_WORKFLOW_WAKE_BACKOFF_KEY);
        if (ownerBackoff?.size === 0) {
          this.workflowWakeGroupSendBackoffUntilMs.delete(ownerWorkspaceId);
        }
      }
    }
    const hasNonWorkflowDeliverables =
      !nonWorkflowSendBackedOff &&
      (deliverableAgentNotificationIds.size > 0 || workspaceTurnCandidates.length > 0);
    // Unselected groups stay queued: the delivered group's wake turn ends with a streamEnded
    // drain (and the sweep backstops an aborted one), which delivers the next group.
    const workspaceTurnMuxMetadata =
      await this.getWorkspaceTurnManager().getActiveWorkspaceTurnMuxMetadataForWorkspace(
        ownerWorkspaceId
      );

    // Security: restore the conversation's active caller tool policy on the wake. The ordinary
    // in-stream workflow continuation carries the live turn's effectiveToolPolicy; this
    // synthetic send starts a fresh turn, and omitting the policy would let a workflow wake
    // regain tools the caller disabled (with attacker-influenced workflow output choosing the
    // timing). The agent-level policy recomposes from agentId at send resolution.
    let wakeRestrictions: {
      toolPolicy?: ToolPolicy;
      disableWorkspaceAgents?: boolean;
      strictAgentResolution?: SendMessageOptions["strictAgentResolution"];
    };
    try {
      wakeRestrictions = await this.resolveTerminalWakeCallerSendRestrictions(ownerWorkspaceId);
    } catch (error: unknown) {
      // Fail closed: an unknown policy must not fall back to unrestricted tools. Everything
      // stays pending/queued for the next drain trigger or sweep.
      log.warn("Deferring terminal wake; caller tool policy unavailable", {
        ownerWorkspaceId,
        error,
      });
      return;
    }

    // Last-moment suppression revalidation: a quiet owner-follow-up resettle
    // deletes its notification files, but cannot retract this drain's
    // already-taken listPending() snapshot, so the handle records are the
    // source of truth. All candidates are re-read in ONE parallel batch and
    // partitioned synchronously, so no candidate's check goes stale behind a
    // later candidate's await; suppressed handles are dropped instead of
    // waking the owner, and their notifications are marked superseded only
    // after the delivery decision. The residual window is the batch read →
    // sendMessage gap below (no awaits in between besides workflow group
    // selection and delivery itself) — closing it would
    // require holding settlement locks across delivery, which the drain must
    // not do; worst case is one redundant wake (fail toward notify, never a
    // lost wake).
    const candidateRecords = await Promise.all(
      workspaceTurnCandidates.map((candidate) =>
        this.getWorkspaceTurnManager().getWorkspaceTurnRecord(
          ownerWorkspaceId,
          candidate.notification.sourceId
        )
      )
    );
    // Workflow candidates get the same last-moment treatment, one launch-identity group at a
    // time: a full history clear that completes after buildWorkflowTerminalPrompt classified
    // these runs retires the sidecar but cannot retract the materialized candidates, and once
    // the clear releases its admission guard the owner is idle again, so this requireIdle
    // send would inject a pre-clear workflow result into the freshly cleared conversation.
    // The clear retires references before truncating, so a reread sees not_current and
    // settles; unreadable state stays queued for the next drain or sweep. Groups are tried
    // newest-first until one revalidates, so one unreadable group cannot stall independent
    // wakes behind the sweep. Bounded: every iteration permanently removes one group from
    // this drain's consideration.
    const supersededWorkflowPrompts: typeof deliverableWorkflowPrompts = [];
    let currentWorkflowPrompts: typeof deliverableWorkflowPrompts = [];
    let workflowInitiatingAgent: WorkflowWakeInitiatingAgent | undefined;
    let resumeOptions:
      | Awaited<ReturnType<TaskService["resolveParentAutoResumeOptions"]>>
      | undefined;
    let remainingWorkflowPrompts = hasNonWorkflowDeliverables
      ? deliverableWorkflowPrompts.filter((candidate) => candidate.initiatingAgent == null)
      : deliverableWorkflowPrompts;
    while (remainingWorkflowPrompts.length > 0) {
      let groupAgent: WorkflowWakeInitiatingAgent | undefined;
      for (const candidate of remainingWorkflowPrompts) {
        const agent = candidate.initiatingAgent;
        if (agent != null && (groupAgent == null || agent.createdAtMs > groupAgent.createdAtMs)) {
          groupAgent = agent;
        }
      }
      const groupKey = groupAgent != null ? workflowWakeGroupKey(groupAgent) : undefined;
      const groupCandidates = remainingWorkflowPrompts.filter((candidate) =>
        groupKey == null
          ? candidate.initiatingAgent == null
          : candidate.initiatingAgent != null &&
            workflowWakeGroupKey(candidate.initiatingAgent) === groupKey
      );
      // Group keys embed \u0000, so the empty string safely keys the unpinned group.
      const backoffKey = groupKey ?? "";
      const ownerBackoff = this.workflowWakeGroupSendBackoffUntilMs.get(ownerWorkspaceId);
      const backoffUntil = ownerBackoff?.get(backoffKey);
      if (backoffUntil != null) {
        if (backoffUntil > Date.now()) {
          // Recently rejected send: leave the group queued and give the next group its turn.
          remainingWorkflowPrompts = remainingWorkflowPrompts.filter(
            (candidate) => !groupCandidates.includes(candidate)
          );
          continue;
        }
        ownerBackoff?.delete(backoffKey);
        if (ownerBackoff?.size === 0) {
          this.workflowWakeGroupSendBackoffUntilMs.delete(ownerWorkspaceId);
        }
      }
      // Resolve the send identity before the revalidation reread so the reread stays the last
      // await before dispatch: a history clear that completes during this history and
      // agent-settings read retires the sidecar, and a reread taken before it would go stale
      // and inject the pre-clear result into the freshly cleared conversation.
      const groupResumeOptions = await this.resolveParentAutoResumeOptions(
        ownerWorkspaceId,
        entry,
        defaultModel,
        groupAgent != null ? { agentId: groupAgent.agentId } : undefined
      );
      const groupRevalidation = await Promise.all(
        groupCandidates.map((candidate) =>
          this.revalidateWorkflowPromptForDispatch(ownerWorkspaceId, candidate)
        )
      );
      const groupCurrent: typeof deliverableWorkflowPrompts = [];
      groupCandidates.forEach((candidate, index) => {
        const verdict = groupRevalidation[index];
        if (verdict === "deliverable") {
          groupCurrent.push(candidate);
        } else if (verdict === "superseded") {
          supersededWorkflowPrompts.push(candidate);
        }
      });
      if (groupCurrent.length > 0) {
        currentWorkflowPrompts = groupCurrent;
        workflowInitiatingAgent = groupAgent;
        resumeOptions = groupResumeOptions;
        break;
      }
      remainingWorkflowPrompts = remainingWorkflowPrompts.filter(
        (candidate) => !groupCandidates.includes(candidate)
      );
    }

    // No workflow group was selected: resolve under the conversation's own identity. The
    // workspace-turn and sub-agent wakes tolerate this await in the residual window (worst
    // case one redundant wake, never a stale workflow injection).
    resumeOptions ??= await this.resolveParentAutoResumeOptions(
      ownerWorkspaceId,
      entry,
      defaultModel
    );
    // Pair the pin with the delivered group: the newest pin-bearing history row can belong to
    // a different group's wake (each wake persists its own pin), and pinning another agent's
    // provenance onto this group's agentId makes resolution reject the wake on every retry. A
    // recorded pin (or a verified-unpinned null) overrides the walk; legacy references
    // without the field keep the walk pin.
    const groupPin = workflowInitiatingAgent?.strictAgentResolution;
    const effectiveStrictPin =
      groupPin !== undefined ? (groupPin ?? undefined) : wakeRestrictions.strictAgentResolution;
    const deliverableWorkspaceTurnNotificationIds = new Set<string>();
    const publicAwaitIds: string[] = [];
    const suppressedNotificationIds: string[] = [];
    workspaceTurnCandidates.forEach((candidate, index) => {
      const record = candidateRecords[index];
      if (record != null && workspaceTurnTerminalAttentionSuppressed(record)) {
        suppressedNotificationIds.push(candidate.notification.id);
        return;
      }
      if (nonWorkflowSendBackedOff) {
        // Backed off: sits out this drain and stays pending for the sweep-cadence retry.
        return;
      }
      deliverableWorkspaceTurnNotificationIds.add(candidate.notification.id);
      publicAwaitIds.push(candidate.publicAwaitId);
    });
    const markSuppressedSuperseded = async () => {
      for (const id of suppressedNotificationIds) {
        await this.terminalAttentionStore.markSuperseded(ownerWorkspaceId, id);
      }
      for (const candidate of supersededWorkflowPrompts) {
        await this.markWorkflowRunTerminalAttentionSettled({
          ownerWorkspaceId,
          runId: candidate.runId,
          status: candidate.run.status,
          runUpdatedAt: candidate.run.updatedAt,
          settledAs: "superseded",
        });
      }
    };

    // Sub-agent reports and failures are already durable user-context messages. Resume from history
    // directly instead of injecting a second user turn that merely tells the model they exist.
    const promptSections: string[] = [];
    if (publicAwaitIds.length > 0) {
      promptSections.push(buildCompletedWorkspaceTurnPrompt(publicAwaitIds));
    }
    promptSections.push(...currentWorkflowPrompts.map((candidate) => candidate.prompt));
    const prompt = promptSections.join("\n\n");
    const effectivePending = nonWorkflowSendBackedOff
      ? []
      : pending.filter((notification) => {
          if (notification.sourceKind === "agent_task") {
            return deliverableAgentNotificationIds.has(notification.id);
          }
          return deliverableWorkspaceTurnNotificationIds.has(notification.id);
        });
    if (effectivePending.length === 0 && currentWorkflowPrompts.length === 0) {
      await markSuppressedSuperseded();
      // Suppression can empty the very batch that excluded agent-bound workflow groups; with
      // nothing sent there is no streamEnded drain, so re-poke instead of parking the queued
      // wake on the sweep. No spin: re-poke only when this drain durably changed state (a
      // suppressed turn or superseded workflow was just marked), so the re-drain sees a
      // different candidate set; an all-indeterminate batch parks for the sweep instead.
      if (
        deliverableWorkflowPrompts.length > 0 &&
        (suppressedNotificationIds.length > 0 || supersededWorkflowPrompts.length > 0)
      ) {
        this.scheduleTerminalAttentionDrain(ownerWorkspaceId);
      }
      return;
    }

    const markPendingDelivered = async () => {
      for (const notification of effectivePending) {
        await this.terminalAttentionStore.markDelivered(ownerWorkspaceId, notification.id);
      }
      for (const candidate of currentWorkflowPrompts) {
        // Marker failures are contained inside the settle method; the delivered wake itself is
        // durable history evidence, so the next evaluation settles this run as consumed.
        await this.markWorkflowRunTerminalAttentionSettled({
          ownerWorkspaceId,
          runId: candidate.runId,
          status: candidate.run.status,
          runUpdatedAt: candidate.run.updatedAt,
          settledAs: "delivered",
        });
      }
    };

    const markPendingForRetry = async () => {
      for (const notification of effectivePending) {
        await this.terminalAttentionStore.markPending(ownerWorkspaceId, notification.id);
      }
    };

    const sendOptions = {
      model: resumeOptions.model,
      agentId: resumeOptions.agentId,
      thinkingLevel: resumeOptions.thinkingLevel,
      reasoningMode: resumeOptions.reasoningMode,
      ...(wakeRestrictions.toolPolicy != null ? { toolPolicy: wakeRestrictions.toolPolicy } : {}),
      ...(wakeRestrictions.disableWorkspaceAgents === true ? { disableWorkspaceAgents: true } : {}),
      ...(effectiveStrictPin != null ? { strictAgentResolution: effectiveStrictPin } : {}),
      ...(workspaceTurnMuxMetadata != null ? { muxMetadata: workspaceTurnMuxMetadata } : {}),
    };
    if (prompt.length === 0) {
      assert(agentNotifications.length > 0, "prompt-free terminal drain requires sub-agent work");
      // No workspace-turn wakes are delivered on this path, so marking the
      // suppressed ones first cannot go stale against a delivery.
      await markSuppressedSuperseded();
      const resumeResult = await this.workspaceService.resumeStream(ownerWorkspaceId, sendOptions, {
        agentInitiated: true,
      });
      if (!resumeResult.success) {
        // Persistent failures (for example a budget/model gate) are not made retryable by waiting for
        // idle—the owner is already idle here. Keep the outbox entry pending for a later real signal.
        log.warn("Prompt-free sub-agent resume failed; leaving attention pending", {
          ownerWorkspaceId,
          error: resumeResult.error,
        });
        // Same starvation shape as the prompt path: agent-bound groups were excluded by this
        // batch, so back it off and re-poke to let them send under their own launch identity.
        if (deliverableWorkflowPrompts.some((candidate) => candidate.initiatingAgent != null)) {
          this.backOffTerminalWakeSends(ownerWorkspaceId, [NON_WORKFLOW_WAKE_BACKOFF_KEY]);
        }
        return;
      }
      if (!resumeResult.data.started) {
        this.scheduleTerminalAttentionDrainAfterIdle(ownerWorkspaceId);
        return;
      }
      await markPendingDelivered();
      return;
    }

    let sendResult = await this.workspaceService.sendMessage(
      ownerWorkspaceId,
      prompt,
      sendOptions,
      // Synthetic, idle-only auto-resume — same flags as the active-work auto-resume path.
      { skipAutoResumeReset: true, synthetic: true, agentInitiated: true, requireIdle: true }
    );
    // Deferred until after the delivery attempt so no await separates the
    // batch revalidation above from sendMessage. Best-effort: an early return
    // above leaves these pending, and a later drain re-derives suppression
    // from the records and drops them again.
    await markSuppressedSuperseded();

    if (!sendResult.success && isWorkspaceBusyIdleOnlySend(sendResult.error)) {
      const latestCfg = this.config.loadConfigOrDefault();
      const latestTaskIndex = this.buildAgentTaskIndex(latestCfg);
      if (
        findWorkspaceEntry(latestCfg, ownerWorkspaceId) != null &&
        !this.aiService.isStreaming(ownerWorkspaceId) &&
        !this.workspaceService.hasPendingQueuedOrPreparingTurn(ownerWorkspaceId) &&
        !this.interruptedParentWorkspaceIds.has(ownerWorkspaceId) &&
        !(await this.hasBlockingActiveWorkForTerminalDrain(ownerWorkspaceId, latestTaskIndex))
      ) {
        // Security: the composed prompt retains the pre-check workflow results, and this
        // fallback send omits requireIdle, so its epoch snapshot postdates any clear or reset
        // that completed during the awaited checks above and the clear guard would accept the
        // stale injection into the fresh context. The busy race the primary send just lost
        // may also have been a competing owner turn consuming these very results through
        // kernel-nested task_await (settlement marker only, no history evidence) or a
        // Workflows UI resume changing the run generation. Revalidate everything so the
        // fallback keeps the primary path's contract (no awaits between revalidation and
        // delivery); any stale candidate aborts toward a fresh drain that re-derives, and
        // the queue entries survive for it.
        if (currentWorkflowPrompts.length > 0) {
          const fallbackRevalidation = await Promise.all(
            currentWorkflowPrompts.map((candidate) =>
              this.revalidateWorkflowPromptForDispatch(ownerWorkspaceId, candidate)
            )
          );
          if (fallbackRevalidation.some((verdict) => verdict !== "deliverable")) {
            log.debug("Terminal wake busy fallback aborted; workflow candidates went stale", {
              ownerWorkspaceId,
            });
            this.scheduleTerminalAttentionDrain(ownerWorkspaceId);
            return;
          }
        }
        let fallbackAccepted = false;
        sendResult = await this.workspaceService.sendMessage(
          ownerWorkspaceId,
          prompt,
          sendOptions,
          {
            skipAutoResumeReset: true,
            synthetic: true,
            agentInitiated: true,
            onCanceled: () => {
              this.scheduleTerminalAttentionDrainAfterIdle(ownerWorkspaceId);
            },
            onAcceptedPreStreamFailure: async () => {
              await markPendingForRetry();
              this.scheduleTerminalAttentionDrainAfterIdle(ownerWorkspaceId);
            },
            onAccepted: async () => {
              fallbackAccepted = true;
              await markPendingDelivered();
            },
          }
        );
        if (sendResult.success && !fallbackAccepted) {
          return;
        }
      }
    }

    if (!sendResult.success) {
      if (!isWorkspaceBusyIdleOnlySend(sendResult.error)) {
        // A non-busy rejection is likely batch-specific (an unresolvable pinned agent, a model
        // or provider gate). Back the sent batches off until the sweep cadence retries them
        // and re-poke so the remaining groups get their send this cycle instead of starving
        // behind newest-first selection; the non-workflow batch backs off the same way so a
        // persistently rejected conversation-identity send cannot exclude agent-bound groups
        // on every drain. Bounded: each re-poked drain either delivers or backs off one more
        // key, and with every key backed off it selects nothing.
        const backoffKeys: string[] = [];
        if (currentWorkflowPrompts.length > 0) {
          backoffKeys.push(
            workflowInitiatingAgent != null ? workflowWakeGroupKey(workflowInitiatingAgent) : ""
          );
        }
        if (effectivePending.length > 0) {
          backoffKeys.push(NON_WORKFLOW_WAKE_BACKOFF_KEY);
        }
        if (backoffKeys.length > 0) {
          this.backOffTerminalWakeSends(ownerWorkspaceId, backoffKeys);
        }
      }
      // Busy rejection: the owner started work between the idle check and the send; leave
      // pending and retry on the next drain trigger.
      log.debug("Terminal attention wake-up not accepted; leaving pending", {
        ownerWorkspaceId,
        error: sendResult.error,
      });
      return;
    }

    await markPendingDelivered();
  }

  /**
   * Background any registered foreground waits for the requesting workspace when a
   * tool-end message is already queued. Shared by both wait-registration paths
   * (workspace-turn and task await): the auto-backgrounding signal is edge-triggered
   * on enqueue, so a message queued before the waiter registered must be re-checked
   * here. No-op when backgrounding is disabled or no requesting workspace is set.
   */
  backgroundForegroundWaitIfQueued(
    shouldBackgroundOnQueuedMessage: boolean,
    requestingWorkspaceId: string | undefined
  ): void {
    if (
      shouldBackgroundOnQueuedMessage &&
      requestingWorkspaceId &&
      this.workspaceService.hasQueuedMessages(requestingWorkspaceId, "tool-end")
    ) {
      this.backgroundForegroundWaitsForWorkspace(requestingWorkspaceId);
    }
  }

  async reportAgentProgress(
    childWorkspaceId: string,
    toolCallId: string,
    report: { reportMarkdown: string; title?: string; structuredOutput?: unknown }
  ): Promise<void> {
    assert(childWorkspaceId.length > 0, "reportAgentProgress requires childWorkspaceId");
    assert(toolCallId.length > 0, "reportAgentProgress requires toolCallId");
    assert(report.reportMarkdown.length > 0, "reportAgentProgress requires reportMarkdown");

    await this.workspaceEventLocks.withLock(childWorkspaceId, async () => {
      const cfg = this.config.loadConfigOrDefault();
      const childEntry = findWorkspaceEntry(cfg, childWorkspaceId);
      const directParentWorkspaceId = childEntry?.workspace.parentWorkspaceId;
      if (!childEntry || !directParentWorkspaceId) {
        throw new Error("agent_report is only available from an active sub-agent task");
      }

      const executionId = childEntry.workspace.taskExecutionId;
      let continuationRecord: WorkspaceTurnTaskHandleRecord | null = null;
      if (executionId != null) {
        const active =
          this.getWorkspaceTurnManager().getLiveWorkspaceTurnRegistration(childWorkspaceId);
        if (active?.handleId === executionId) {
          continuationRecord = await this.getWorkspaceTurnManager().getWorkspaceTurnRecord(
            active.ownerWorkspaceId,
            executionId
          );
        } else {
          continuationRecord =
            (await this.getWorkspaceTurnManager().listAllWorkspaceTurns()).find(
              (record) => record.handleId === executionId
            ) ?? null;
        }
      }
      const continuationActive = isActiveWorkspaceTurnTaskStatus(continuationRecord?.status);
      if (hasCompletedAgentReport(childEntry.workspace) && !continuationActive) {
        throw new Error("agent_report cannot send updates after the sub-agent has completed");
      }
      if (childEntry.workspace.taskStatus === "interrupted" && !continuationActive) {
        throw new Error("agent_report cannot send updates from an interrupted sub-agent");
      }
      const activeExecution =
        continuationActive && continuationRecord != null ? continuationRecord : null;
      const parentWorkspaceId = activeExecution?.ownerWorkspaceId ?? directParentWorkspaceId;

      if (childEntry.workspace.workflowTask != null) {
        // Workflow-owned tasks deliver structured output through WorkflowRunner's journal/result
        // path. Waking the parent here would background a foreground workflow wait and expose the
        // internal schema handoff as a user-visible sub-agent update.
        return;
      }

      const parentEntry = findWorkspaceEntry(cfg, parentWorkspaceId);
      if (!parentEntry) {
        throw new Error("agent_report could not find the parent workspace");
      }

      const agentType = coerceNonEmptyString(childEntry.workspace.agentType) ?? "agent";
      const title = coerceNonEmptyString(report.title) ?? subagentUpdateFallbackTitle(agentType);
      const reportContent = formatSubagentReportUserMessage({
        childWorkspaceId,
        agentType,
        title,
        reportMarkdown: report.reportMarkdown,
        status: "in_progress",
        ...(childEntry.workspace.taskModelString != null
          ? { model: childEntry.workspace.taskModelString }
          : {}),
        ...(childEntry.workspace.taskThinkingLevel != null
          ? { thinkingLevel: childEntry.workspace.taskThinkingLevel }
          : {}),
        ...(report.structuredOutput !== undefined
          ? { structuredOutput: report.structuredOutput }
          : {}),
      });
      // A progress report is itself the wake-up message. Unlike terminal attention, it must be
      // allowed through while this child is still active so review findings and other incremental
      // results can immediately background a foreground wait or queue behind a busy parent turn.
      // The key is scoped to the active continuation execution (when any) so that execution's
      // terminal settlement drops exactly the updates it superseded.
      const dedupePrefix = agentReportProgressDedupePrefix(
        childWorkspaceId,
        activeExecution?.handleId
      );
      // Superseded once this run is over: the settlement paths persist the child's status mirror
      // (`reported`/`interrupted`, or a terminal execution status for a continuation) BEFORE they
      // remove queued updates, so an entry already dequeued into the parent's asynchronous
      // PREPARING phase — invisible to that removal — is refused at admission instead of starting
      // a stale "in progress" turn after the terminal outcome. Synchronous reads only: admission
      // probes run inside the session's turn gates. As with peer sends, a probe-carrying send
      // never resurrects an interrupted parent.
      const superseded = (): boolean => {
        const fresh = findWorkspaceEntry(this.config.loadConfigOrDefault(), childWorkspaceId);
        if (fresh == null) {
          return true;
        }
        if (activeExecution != null) {
          // A successor generation claims the mirror only once this execution stopped being the
          // live registration, and clearing it is part of this execution's own teardown — either
          // way the update belongs to a finished generation.
          return (
            fresh.workspace.taskExecutionId !== activeExecution.handleId ||
            !isActiveWorkspaceTurnTaskStatus(fresh.workspace.taskExecutionStatus)
          );
        }
        return (
          hasCompletedAgentReport(fresh.workspace) || fresh.workspace.taskStatus === "interrupted"
        );
      };
      // A stop or settlement can land between the status checks above and here (neither shares
      // this child's event lock), and the mirror is written at continuation acceptance, before
      // the child's turn can call agent_report — so a probe that is already true means the run
      // is over. Refuse now rather than wake the parent with an obsolete update.
      if (superseded()) {
        throw new Error("agent_report cannot send updates after the sub-agent's run has ended");
      }
      const wakeResult = await this.wakeParentWorkspaceWithSyntheticMessage({
        parentWorkspaceId,
        parentEntry,
        content: reportContent,
        queueDedupeKey: `${dedupePrefix}${toolCallId}`,
        // Only the queue head's dispatch mode can cut the parent's stream. A child's earlier
        // ancestor-bound peer message (turn-end by default) at the head would otherwise hold this
        // report until the parent's turn ends — observed as 8–40 minute "delayed" updates.
        promoteAheadOfHiddenTurnEnd: true,
        admissionStale: superseded,
      });
      if (!wakeResult.success) {
        throw new Error(`agent_report failed to wake the parent workspace: ${wakeResult.error}`);
      }
    });
  }

  /**
   * Wake a parent workspace with a synthetic child-originated message. Shared by
   * agent_report progress updates and RLM family messaging (task_message_parent).
   * The message travels through the parent's normal send/queue mechanics, so it is
   * durably logged like any user turn, coalesces behind a busy parent stream, and
   * carries workspace-turn continuation metadata when the parent itself runs as a
   * delegated workspace turn.
   */
  private async wakeParentWorkspaceWithSyntheticMessage(params: {
    parentWorkspaceId: string;
    parentEntry: {
      workspace: {
        aiSettingsByAgent?: Record<string, ResolvedWorkspaceAiSettings>;
        aiSettings?: ResolvedWorkspaceAiSettings;
      };
    };
    content: string;
    /** Coalesces repeated wakes for the same source (e.g. one agent_report tool call). */
    queueDedupeKey?: string;
    /** Queue ahead of hidden turn-end predecessors (see SendMessageInternalOptions). */
    promoteAheadOfHiddenTurnEnd?: boolean;
    /**
     * Synchronous "this wake has been superseded" probe, re-checked at the parent's turn-admission
     * gates (even after the entry left the queue for PREPARING). A stale wake is refused rather
     * than dispatched, and never settles the parent's own workspace turn as failed.
     */
    admissionStale?: () => boolean;
    queueDispatchMode?: TaskMessageQueueDispatchMode;
    /** Synthetic assistant rows persisted just before the wake's user row (family payloads). */
    preTurnMessages?: MuxMessage[];
    /** Invoked once the wake turn is durably accepted. */
    onAccepted?: () => void;
    /**
     * r54: invoked once the pre-turn rows cross the rollback horizon —
     * acceptance can still fail AFTER that point (e.g. goal sync throwing)
     * with the rows durable, so budget accounting must key off this, not
     * onAccepted.
     */
    onPreTurnRowsPersisted?: () => void;
  }): Promise<Result<void, string>> {
    assert(params.parentWorkspaceId.length > 0, "wakeParentWorkspace: parent ID required");
    assert(params.content.length > 0, "wakeParentWorkspace: content required");
    const { parentWorkspaceId } = params;
    const resumeOptions = await this.resolveParentAutoResumeOptions(
      parentWorkspaceId,
      params.parentEntry,
      defaultModel
    );
    const workspaceTurnMuxMetadata =
      await this.getWorkspaceTurnManager().getActiveWorkspaceTurnMuxMetadataForWorkspace(
        parentWorkspaceId
      );
    // When the parent itself runs as a delegated workspace turn, this wake continues that turn,
    // so a canceled/failed send normally settles the turn as failed. A wake whose source has been
    // superseded (params.admissionStale, e.g. a sub-agent progress report outrun by the child's
    // terminal outcome) is the exception: the parent's live turn is intact and the terminal
    // delivery is its next wake, so refusing or dropping the stale wake must not interrupt it.
    const settleContinuationFailure = async (
      status: "interrupted" | "error",
      message: string
    ): Promise<void> => {
      if (workspaceTurnMuxMetadata == null) {
        return;
      }
      if (params.admissionStale?.() === true) {
        log.debug("Superseded parent wake dropped without settling the parent's workspace turn", {
          parentWorkspaceId,
          status,
          message,
        });
        return;
      }
      await this.getWorkspaceTurnManager().settleWorkspaceTurnContinuationFailure(
        parentWorkspaceId,
        workspaceTurnMuxMetadata,
        status,
        message
      );
    };

    const sendResult = await this.workspaceService.sendMessage(
      parentWorkspaceId,
      params.content,
      {
        model: resumeOptions.model,
        agentId: resumeOptions.agentId,
        thinkingLevel: resumeOptions.thinkingLevel,
        reasoningMode: resumeOptions.reasoningMode,
        ...(params.queueDispatchMode != null
          ? { queueDispatchMode: params.queueDispatchMode }
          : {}),
        ...(workspaceTurnMuxMetadata != null ? { muxMetadata: workspaceTurnMuxMetadata } : {}),
      },
      {
        skipAutoResumeReset: true,
        synthetic: true,
        agentInitiated: true,
        startStreamInBackground: true,
        workspaceTurnContinuation: workspaceTurnMuxMetadata != null,
        ...(params.preTurnMessages != null ? { preTurnMessages: params.preTurnMessages } : {}),
        ...(params.onAccepted != null ? { onAccepted: params.onAccepted } : {}),
        ...(params.onPreTurnRowsPersisted != null
          ? { onPreTurnRowsPersisted: params.onPreTurnRowsPersisted }
          : {}),
        ...(params.queueDedupeKey != null
          ? { queueDedupeKey: params.queueDedupeKey, removableQueueDedupeKey: true }
          : {}),
        ...(params.promoteAheadOfHiddenTurnEnd === true
          ? { promoteAheadOfHiddenTurnEnd: true }
          : {}),
        ...(params.admissionStale != null ? { admissionStale: params.admissionStale } : {}),
        ...(workspaceTurnMuxMetadata != null
          ? {
              onCanceled: async (reason: string) => {
                await settleContinuationFailure("interrupted", reason);
              },
              onAcceptedPreStreamFailure: async (error: SendMessageError) => {
                await settleContinuationFailure("error", formatSendMessageError(error).message);
              },
            }
          : {}),
      }
    );
    if (!sendResult.success) {
      const formattedError = formatSendMessageError(sendResult.error);
      await settleContinuationFailure("error", formattedError.message);
      return Err(formattedError.message);
    }
    return Ok(undefined);
  }

  /**
   * Child -> parent family message (RLM family messaging, task_message_parent).
   *
   * Appends a clearly-labeled child message into the PARENT workspace's queue using
   * the same synthetic send/queue mechanics task_send_message uses toward children.
   * Loop safety: the message coalesces in the parent's existing queue and creates no
   * automatic reply obligation or delivery receipt — agent_report remains the
   * terminal/progress reporting channel.
   */
  async sendMessageToParentFromAgentTask(
    childWorkspaceId: string,
    message: string,
    queueDispatchMode: TaskMessageQueueDispatchMode
  ): Promise<Result<SendParentAgentMessageResult, SendParentAgentMessageError>> {
    assert(
      childWorkspaceId.length > 0,
      "sendMessageToParentFromAgentTask: childWorkspaceId must be non-empty"
    );
    return this.sendTreeMessage({
      relation: "parent-family",
      senderWorkspaceId: childWorkspaceId,
      message,
      queueDispatchMode,
    });
  }

  /**
   * Sibling -> sibling family message (RLM family messaging, task_message_sibling).
   *
   * NUCLEAR-FAMILY SCOPING: the target must share the sender's DIRECT parent —
   * exactly one hop up plus one hop down. Grandparents, grandchildren, uncles, and
   * unrelated tasks are refused with invalid_scope. Restricting messaging to the
   * nuclear family keeps the parent the coordination hub and prevents global-mailbox
   * chaos across the task tree.
   */
  async sendMessageToSiblingAgentTask(
    senderWorkspaceId: string,
    targetTaskId: string,
    message: string,
    queueDispatchMode: TaskMessageQueueDispatchMode
  ): Promise<Result<SendAgentTaskMessageResult, SendAgentTaskMessageError>> {
    assert(
      senderWorkspaceId.length > 0,
      "sendMessageToSiblingAgentTask: senderWorkspaceId must be non-empty"
    );
    assert(
      targetTaskId.length > 0,
      "sendMessageToSiblingAgentTask: targetTaskId must be non-empty"
    );
    return this.sendTreeMessage({
      relation: "sibling-family",
      senderWorkspaceId,
      targetId: targetTaskId,
      message,
      queueDispatchMode,
    });
  }

  async requestAgentFinalReportForTimeout(
    taskId: string,
    options: {
      workflowRunId: string;
      stepId: string;
      inputHash: string;
      finalizationToken: string;
      finalInstructions?: string;
    }
  ): Promise<"prompted" | "queued" | "already_reported" | "not_active"> {
    assert(taskId.length > 0, "requestAgentFinalReportForTimeout: taskId must be non-empty");
    assert(
      options.finalizationToken.length > 0,
      "requestAgentFinalReportForTimeout: finalizationToken must be non-empty"
    );

    const reservation = await this.workspaceEventLocks.withLock(taskId, async () => {
      const cfg = this.config.loadConfigOrDefault();
      const entry = findWorkspaceEntry(cfg, taskId);
      if (!entry?.workspace.parentWorkspaceId) {
        return { status: "not_active" as const };
      }
      if (hasCompletedAgentReport(entry.workspace) || this.completedReportsByTaskId.has(taskId)) {
        return { status: "already_reported" as const };
      }
      if (entry.workspace.taskStatus === "interrupted" && !this.aiService.isStreaming(taskId)) {
        return { status: "not_active" as const };
      }

      const tokens = entry.workspace.taskTimeoutFinalizationTokens ?? [];
      const alreadyPrompted = tokens.includes(options.finalizationToken);
      if (!alreadyPrompted) {
        await this.editActiveWorkspaceEntry(
          taskId,
          (workspace) => {
            workspace.taskStatus = "awaiting_report";
          },
          { allowMissing: true }
        );
      }
      return { status: "reserved" as const, alreadyPrompted };
    });

    if (reservation.status !== "reserved") {
      return reservation.status;
    }
    if (reservation.alreadyPrompted) {
      return "prompted";
    }
    if (this.aiService.isStreaming(taskId)) {
      await this.aiService.stopStream(taskId, {
        soft: true,
        abandonPartial: false,
        abortReason: "system",
      });
    }

    const freshConfig = this.config.loadConfigOrDefault();
    const freshEntry = findWorkspaceEntry(freshConfig, taskId);
    if (!freshEntry?.workspace.parentWorkspaceId) {
      return "not_active";
    }
    if (
      hasCompletedAgentReport(freshEntry.workspace) ||
      this.completedReportsByTaskId.has(taskId)
    ) {
      return "already_reported";
    }
    let finalizationAccepted = false;
    const persistFinalizationToken = async (): Promise<void> => {
      await this.workspaceEventLocks.withLock(taskId, async () => {
        const cfg = this.config.loadConfigOrDefault();
        const entry = findWorkspaceEntry(cfg, taskId);
        if (!entry?.workspace.parentWorkspaceId) {
          return;
        }
        if (hasCompletedAgentReport(entry.workspace) || this.completedReportsByTaskId.has(taskId)) {
          return;
        }
        await this.editActiveWorkspaceEntry(
          taskId,
          (workspace) => {
            const existing = workspace.taskTimeoutFinalizationTokens ?? [];
            workspace.taskTimeoutFinalizationTokens = Array.from(
              new Set([...existing, options.finalizationToken])
            );
            workspace.taskStatus = "awaiting_report";
          },
          { allowMissing: true }
        );
      });
      finalizationAccepted = true;
    };
    const completionKind = (await this.isPlanLikeTaskWorkspace(freshEntry))
      ? "propose_plan"
      : "final_response";
    const requiresStructuredOutput =
      freshEntry.workspace.workflowTask?.outputSchema !== undefined &&
      !(await this.shouldAllowLegacyInvalidWorkflowOutputSchema(taskId, freshEntry));
    const model = freshEntry.workspace.taskModelString ?? defaultModel;
    const agentId = resolveTaskAgentIdForResume(freshEntry.workspace);
    const sendResult = await this.workspaceService.sendMessage(
      taskId,
      buildWorkflowTimeoutFinalizationPrompt(
        options.finalInstructions,
        completionKind,
        requiresStructuredOutput
      ),
      {
        model,
        agentId,
        thinkingLevel: freshEntry.workspace.taskThinkingLevel,
        reasoningMode: coerceOpenAIReasoningMode(freshEntry.workspace.aiSettings?.reasoningMode),
        experiments: freshEntry.workspace.taskExperiments,
        ...(completionKind === "propose_plan"
          ? { toolPolicy: [{ regex_match: "^propose_plan$", action: "require" as const }] }
          : {}),
      },
      {
        synthetic: true,
        agentInitiated: true,
        startStreamInBackground: true,
        onAccepted: persistFinalizationToken,
        onCanceled: (reason) => {
          log.debug("Workflow timeout finalization prompt was canceled", {
            taskId,
            workflowRunId: options.workflowRunId,
            stepId: options.stepId,
            reason,
          });
        },
      }
    );
    if (!sendResult.success) {
      log.error("Failed to prompt workflow task for timeout final report", {
        taskId,
        workflowRunId: options.workflowRunId,
        stepId: options.stepId,
        error: sendResult.error,
      });
      return "not_active";
    }

    return finalizationAccepted ? "prompted" : "queued";
  }

  async failAgentTaskForHardTimeout(
    taskId: string,
    options: { workflowRunId: string; stepId: string; inputHash: string; reason: string }
  ): Promise<void> {
    assert(taskId.length > 0, "failAgentTaskForHardTimeout: taskId must be non-empty");
    assert(options.reason.length > 0, "failAgentTaskForHardTimeout: reason must be non-empty");

    await this.workspaceEventLocks.withLock(taskId, async () => {
      const cfg = this.config.loadConfigOrDefault();
      const entry = findWorkspaceEntry(cfg, taskId);
      if (!entry?.workspace.parentWorkspaceId) {
        return;
      }
      if (hasCompletedAgentReport(entry.workspace) || this.completedReportsByTaskId.has(taskId)) {
        return;
      }
      try {
        const clearQueueResult = this.workspaceService.clearQueue(taskId);
        if (!clearQueueResult.success) {
          log.debug("failAgentTaskForHardTimeout: clearQueue failed", {
            taskId,
            error: clearQueueResult.error,
          });
        }
      } catch (error: unknown) {
        log.debug("failAgentTaskForHardTimeout: clearQueue threw", { taskId, error });
      }
      try {
        await this.aiService.stopStream(taskId, {
          abandonPartial: true,
          abortReason: "system",
        });
      } catch (error: unknown) {
        log.debug("failAgentTaskForHardTimeout: stopStream threw", { taskId, error });
      }
      await this.terminateAllDescendantAgentTasks(taskId, { workflowRunId: options.workflowRunId });
      await this.failAgentTaskTerminally(taskId, entry, {
        errorType: "workflow_agent_timeout",
        errorMessage: options.reason,
      });
    });
  }

  async waitForAgentReport(
    taskId: string,
    options?: {
      timeoutMs?: number;
      abortSignal?: AbortSignal;
      requestingWorkspaceId?: string;
      backgroundOnMessageQueued?: boolean;
      onExecutionStarted?: () => void | Promise<void>;
    }
  ): Promise<{
    reportMarkdown: string;
    title?: string;
    structuredOutput?: unknown;
    planFilePath?: string;
    model?: string;
    thinkingLevel?: ThinkingLevel;
  }> {
    assert(taskId.length > 0, "waitForAgentReport: taskId must be non-empty");

    // Report monotonicity invariant: check the in-memory cache before any status-based
    // interruption handling so a finalized report stays awaitable once observed.
    const cached = this.completedReportsByTaskId.get(taskId);
    if (cached) {
      return {
        reportMarkdown: cached.reportMarkdown,
        title: cached.title,
        planFilePath: cached.planFilePath,
        structuredOutput: cached.structuredOutput,
        model: cached.model,
        thinkingLevel: cached.thinkingLevel,
      };
    }

    const timeoutMs = options?.timeoutMs ?? 10 * 60 * 1000; // 10 minutes
    assert(Number.isFinite(timeoutMs) && timeoutMs > 0, "waitForAgentReport: timeoutMs invalid");

    const requestingWorkspaceId = coerceNonEmptyString(options?.requestingWorkspaceId);
    if (requestingWorkspaceId) {
      // A renewed foreground wait means this task is blocking again unless re-backgrounded later.
      this.markTaskForegroundRelevant(taskId);
    }

    const tryReadPersistedReport = async (): Promise<{
      reportMarkdown: string;
      planFilePath?: string;
      structuredOutput?: unknown;
      title?: string;
      model?: string;
      thinkingLevel?: ThinkingLevel;
    } | null> => {
      if (!requestingWorkspaceId) {
        return null;
      }

      const sessionDir = path.join(this.config.sessionsDir, requestingWorkspaceId);
      const artifact = await readSubagentReportArtifact(sessionDir, taskId);
      if (!artifact) {
        return null;
      }

      // Cache for the current process (best-effort). Disk is the source of truth.
      this.completedReportsByTaskId.set(taskId, {
        reportMarkdown: artifact.reportMarkdown,
        title: artifact.title,
        planFilePath: artifact.planFilePath,
        structuredOutput: artifact.structuredOutput,
        model: artifact.model,
        thinkingLevel: artifact.thinkingLevel,
        workflowOwnedAncestorWorkspaceIds: artifact.workflowOwnedAncestorWorkspaceIds,
        ancestorWorkspaceIds: artifact.ancestorWorkspaceIds,
      });
      this.enforceCompletedReportCacheLimit();

      const entry = findWorkspaceEntry(this.config.loadConfigOrDefault(), taskId);
      if (entry != null && !hasCompletedAgentReport(entry.workspace)) {
        await this.editWorkspaceEntry(
          taskId,
          (workspace) => {
            workspace.taskStatus = "reported";
            workspace.reportedAt = getIsoNow();
            delete workspace.taskRecoveryAttempts;
          },
          { allowMissing: true }
        );
        eventSpine.emit("task.reported", { workspaceId: taskId, taskId });
        await this.maybeStartPatchGenerationForReportedTask(taskId);
        await this.emitWorkspaceMetadata(taskId);
        await this.maybeStartQueuedTasks();
        await this.cleanupReportedLeafTask(taskId);
      }

      return {
        reportMarkdown: artifact.reportMarkdown,
        title: artifact.title,
        planFilePath: artifact.planFilePath,
        structuredOutput: artifact.structuredOutput,
        model: artifact.model,
        thinkingLevel: artifact.thinkingLevel,
      };
    };

    // Persisted terminal failures (e.g. model_refusal) are checked AFTER reports —
    // report monotonicity — and surface as rejections, never as reportMarkdown.
    const tryReadPersistedFailureError = async (): Promise<Error | null> => {
      if (!requestingWorkspaceId) {
        return null;
      }

      const sessionDir = path.join(this.config.sessionsDir, requestingWorkspaceId);
      const failure = await readSubagentFailureArtifact(sessionDir, taskId);
      return failure ? new Error(failure.errorMessage) : null;
    };

    // Fast-path: if the task is already gone (cleanup) or already reported (restart), return the
    // persisted artifact from the requesting workspace session dir.
    const cfg = this.config.loadConfigOrDefault();
    const taskWorkspaceEntry = findWorkspaceEntry(cfg, taskId);
    const taskStatus = taskWorkspaceEntry?.workspace.taskStatus;

    if (!taskWorkspaceEntry || taskStatus === "reported") {
      const persisted = await tryReadPersistedReport();
      if (persisted) {
        return persisted;
      }

      const persistedFailure = await tryReadPersistedFailureError();
      if (persistedFailure) {
        throw persistedFailure;
      }

      throw new Error("Task not found");
    }

    if (taskStatus === "interrupted") {
      const persisted = await tryReadPersistedReport();
      if (persisted) {
        return persisted;
      }

      // Report monotonicity: interrupted tasks can still be streaming while stream-end
      // finalization persists agent_report. Waiters should keep waiting in that window.
      if (!this.aiService.isStreaming(taskId)) {
        throw new Error(taskWorkspaceEntry.workspace.taskLaunchError ?? "Task interrupted");
      }
    }

    return await new Promise<{
      reportMarkdown: string;
      title?: string;
      planFilePath?: string;
      structuredOutput?: unknown;
    }>((resolve, reject) => {
      void (async () => {
        // Validate existence early to avoid waiting on never-resolving task IDs.
        const cfg = this.config.loadConfigOrDefault();
        const taskWorkspaceEntry = findWorkspaceEntry(cfg, taskId);
        if (!taskWorkspaceEntry) {
          const persisted = await tryReadPersistedReport();
          if (persisted) {
            resolve(persisted);
            return;
          }

          const persistedFailure = await tryReadPersistedFailureError();
          reject(persistedFailure ?? new Error("Task not found"));
          return;
        }

        if (taskWorkspaceEntry.workspace.taskStatus === "reported") {
          const persisted = await tryReadPersistedReport();
          if (persisted) {
            resolve(persisted);
            return;
          }

          const persistedFailure = await tryReadPersistedFailureError();
          reject(persistedFailure ?? new Error("Task not found"));
          return;
        }

        if (taskWorkspaceEntry.workspace.taskStatus === "interrupted") {
          const persisted = await tryReadPersistedReport();
          if (persisted) {
            resolve(persisted);
            return;
          }

          // Report monotonicity: an interrupted task may still be in stream-end teardown,
          // so keep the waiter alive while the stream is active.
          if (!this.aiService.isStreaming(taskId)) {
            reject(new Error(taskWorkspaceEntry.workspace.taskLaunchError ?? "Task interrupted"));
            return;
          }
        }

        let timeout: ReturnType<typeof setTimeout> | null = null;
        let startWaiter: PendingTaskStartWaiter | null = null;
        let abortListener: (() => void) | null = null;
        let stopBlockingRequester: (() => void) | null = requestingWorkspaceId
          ? this.startForegroundAwait(requestingWorkspaceId)
          : null;

        let executionStartNotified = false;
        const notifyExecutionStarted = () => {
          if (executionStartNotified) return;
          executionStartNotified = true;
          void Promise.resolve(options?.onExecutionStarted?.()).catch((error: unknown) => {
            log.error("waitForAgentReport execution-start callback failed", { taskId, error });
          });
        };

        const startReportTimeout = () => {
          if (timeout) return;
          notifyExecutionStarted();
          timeout = setTimeout(() => {
            // Prefer a persisted terminal failure over a generic timeout so late
            // awaits surface the typed failure (e.g. model_refusal) even when the
            // live rejection was missed (restart/cleanup windows).
            void (async () => {
              const persistedFailure = await tryReadPersistedFailureError().catch(() => null);
              entry.cleanup();
              reject(persistedFailure ?? new AgentReportWaitTimeoutError());
            })();
          }, timeoutMs);
        };

        const cleanupStartWaiter = () => {
          if (!startWaiter) return;
          startWaiter.cleanup();
          startWaiter = null;
        };

        const entry: PendingTaskWaiter = {
          taskId,
          requestingWorkspaceId: undefined,
          backgroundOnMessageQueued: false,
          resolve: (report) => {
            entry.cleanup();
            resolve(report);
          },
          reject: (error) => {
            entry.cleanup();
            reject(error);
          },
          cleanup: () => {
            if (entry.requestingWorkspaceId && entry.backgroundOnMessageQueued) {
              this.unregisterBackgroundableForegroundWaiter(entry.requestingWorkspaceId, entry);
            }

            const current = this.pendingWaitersByTaskId.get(taskId);
            if (current) {
              const next = current.filter((w) => w !== entry);
              if (next.length === 0) {
                this.pendingWaitersByTaskId.delete(taskId);
              } else {
                this.pendingWaitersByTaskId.set(taskId, next);
              }
            }

            cleanupStartWaiter();

            if (timeout) {
              clearTimeout(timeout);
              timeout = null;
            }

            if (abortListener && options?.abortSignal) {
              options.abortSignal.removeEventListener("abort", abortListener);
              abortListener = null;
            }

            if (stopBlockingRequester) {
              try {
                stopBlockingRequester();
              } finally {
                stopBlockingRequester = null;
              }
            }
          },
        };

        const list = this.pendingWaitersByTaskId.get(taskId) ?? [];
        list.push(entry);
        this.pendingWaitersByTaskId.set(taskId, list);

        const shouldBackgroundOnQueuedMessage = Boolean(
          requestingWorkspaceId && (options?.backgroundOnMessageQueued ?? true)
        );
        entry.requestingWorkspaceId = requestingWorkspaceId;
        entry.backgroundOnMessageQueued = shouldBackgroundOnQueuedMessage;

        if (shouldBackgroundOnQueuedMessage && requestingWorkspaceId) {
          this.registerBackgroundableForegroundWaiter(requestingWorkspaceId, entry);
        }

        const persistedAfterRegister = await tryReadPersistedReport();
        if (persistedAfterRegister) {
          entry.resolve(persistedAfterRegister);
          return;
        }

        // Don't start the execution timeout while the task is still queued/starting.
        // The timer starts once the child actually begins running (queued/starting -> running).
        const initialStatus = taskWorkspaceEntry.workspace.taskStatus;
        if (initialStatus === "queued" || initialStatus === "starting") {
          const startWaiterEntry: PendingTaskStartWaiter = {
            start: startReportTimeout,
            cleanup: () => {
              const currentStartWaiters = this.pendingStartWaitersByTaskId.get(taskId);
              if (currentStartWaiters) {
                const next = currentStartWaiters.filter((w) => w !== startWaiterEntry);
                if (next.length === 0) {
                  this.pendingStartWaitersByTaskId.delete(taskId);
                } else {
                  this.pendingStartWaitersByTaskId.set(taskId, next);
                }
              }
            },
          };
          startWaiter = startWaiterEntry;

          const currentStartWaiters = this.pendingStartWaitersByTaskId.get(taskId) ?? [];
          currentStartWaiters.push(startWaiterEntry);
          this.pendingStartWaitersByTaskId.set(taskId, currentStartWaiters);

          // Close the race where the task starts between the initial config read and registering the waiter.
          const cfgAfterRegister = this.config.loadConfigOrDefault();
          const afterEntry = findWorkspaceEntry(cfgAfterRegister, taskId);
          if (
            afterEntry?.workspace.taskStatus !== "queued" &&
            afterEntry?.workspace.taskStatus !== "starting"
          ) {
            cleanupStartWaiter();
            startReportTimeout();
          }

          // If the awaited task is queued and the caller is blocked in the foreground, ensure the
          // scheduler runs after the waiter is registered. This avoids deadlocks when
          // maxParallelAgentTasks is low.
          if (requestingWorkspaceId) {
            this.scheduleMaybeStartQueuedTasks();
          }
        } else {
          startReportTimeout();
        }

        if (initialStatus === "awaiting_report") {
          // Reuse the standard completion reminder when a waiter attaches instead of carrying a
          // separate waiter-only recovery mode and prompt string.
          void this.workspaceEventLocks
            .withLock(taskId, async () => {
              await this.promptTaskForRequiredCompletionTool(taskId);
            })
            .catch((error: unknown) => {
              log.error("Failed to resume awaiting_report task for waiter", {
                taskId,
                error,
              });
            });
        }
        if (options?.abortSignal) {
          if (options.abortSignal.aborted) {
            entry.cleanup();
            reject(new Error("Interrupted"));
            return;
          }

          abortListener = () => {
            entry.cleanup();
            reject(new Error("Interrupted"));
          };
          options.abortSignal.addEventListener("abort", abortListener, { once: true });
        }

        this.backgroundForegroundWaitIfQueued(
          shouldBackgroundOnQueuedMessage,
          requestingWorkspaceId
        );
      })().catch((error: unknown) => {
        reject(error instanceof Error ? error : new Error(String(error)));
      });
    });
  }

  getAgentTaskExecutionId(taskId: string): string | null {
    assert(taskId.length > 0, "getAgentTaskExecutionId: taskId must be non-empty");
    const entry = findWorkspaceEntry(this.config.loadConfigOrDefault(), taskId);
    return entry?.workspace.taskExecutionId ?? null;
  }

  async getDescendantAgentTaskExecutionSnapshot(
    ancestorWorkspaceId: string,
    taskId: string,
    options: { consumingWorkspaceId?: string } = {}
  ): Promise<{
    ownerWorkspaceId: string;
    record: WorkspaceTurnTaskHandleRecord;
  } | null> {
    assert(
      ancestorWorkspaceId.length > 0,
      "getDescendantAgentTaskExecutionSnapshot: ancestorWorkspaceId must be non-empty"
    );
    assert(taskId.length > 0, "getDescendantAgentTaskExecutionSnapshot: taskId must be non-empty");

    const cfg = this.config.loadConfigOrDefault();
    const index = this.buildAgentTaskIndex(cfg);
    if (!this.isDescendantAgentTaskUsingParentById(index.parentById, ancestorWorkspaceId, taskId)) {
      return null;
    }

    const executionTaskId = index.byId.get(taskId)?.taskExecutionId;
    if (!isWorkspaceTurnTaskId(executionTaskId)) {
      return null;
    }

    // A continuation is owned by whichever ancestor reawakened the child, not necessarily by the
    // ancestor currently listing or awaiting it. Search the child's ancestry, then return the
    // actual owner so subsequent reads and terminal-attention updates use the correct session.
    for (const ownerWorkspaceId of this.listAncestorWorkspaceIdsUsingParentById(
      index.parentById,
      taskId
    )) {
      const record = await this.getWorkspaceTurnManager().getWorkspaceTurnSnapshot(
        ownerWorkspaceId,
        executionTaskId,
        options
      );
      if (record?.workspaceId === taskId) {
        return { ownerWorkspaceId, record };
      }
    }

    return null;
  }

  getAgentTaskStatus(taskId: string): AgentTaskStatus | null {
    assert(taskId.length > 0, "getAgentTaskStatus: taskId must be non-empty");

    const cfg = this.config.loadConfigOrDefault();
    const entry = findWorkspaceEntry(cfg, taskId);
    const status = entry?.workspace.taskStatus;
    return status ?? null;
  }

  getAgentTaskTimestamps(taskId: string): AgentTaskTimestamps | null {
    assert(taskId.length > 0, "getAgentTaskTimestamps: taskId must be non-empty");

    const cfg = this.config.loadConfigOrDefault();
    const entry = findWorkspaceEntry(cfg, taskId);
    if (!entry) {
      return null;
    }

    return {
      createdAt: entry.workspace.createdAt,
      reportedAt: entry.workspace.reportedAt,
    };
  }

  getAgentTaskStatuses(taskIds: string[]): Map<string, AgentTaskStatusLookup> {
    for (const taskId of taskIds) {
      assert(taskId.length > 0, "getAgentTaskStatuses: taskId must be non-empty");
    }

    if (taskIds.length === 0) {
      return new Map<string, AgentTaskStatusLookup>();
    }

    const cfg = this.config.loadConfigOrDefault();
    const statuses = new Map<string, AgentTaskStatusLookup>();

    for (const taskId of taskIds) {
      const entry = findWorkspaceEntry(cfg, taskId);
      statuses.set(taskId, {
        exists: entry != null,
        taskStatus: entry?.workspace.taskStatus ?? null,
      });
    }

    return statuses;
  }

  hasDescendantAgentTasks(workspaceId: string): boolean {
    assert(workspaceId.length > 0, "hasDescendantAgentTasks: workspaceId must be non-empty");

    const cfg = this.config.loadConfigOrDefault();
    const index = this.buildAgentTaskIndex(cfg);
    return this.listDescendantAgentTaskIdsFromIndex(index, workspaceId).length > 0;
  }

  hasActiveDescendantAgentTasksForWorkspace(workspaceId: string): boolean {
    assert(
      workspaceId.length > 0,
      "hasActiveDescendantAgentTasksForWorkspace: workspaceId must be non-empty"
    );

    const cfg = this.config.loadConfigOrDefault();
    return this.hasActiveDescendantAgentTasks(cfg, workspaceId);
  }

  listActiveDescendantAgentTaskIds(
    workspaceId: string,
    options: { excludeWorkflowTasks?: boolean } = {}
  ): string[] {
    assert(
      workspaceId.length > 0,
      "listActiveDescendantAgentTaskIds: workspaceId must be non-empty"
    );

    const cfg = this.config.loadConfigOrDefault();
    const index = this.buildAgentTaskIndex(cfg);

    const result: string[] = [];
    const stack: Array<{ taskId: string; workflowOwned: boolean }> = [
      ...(index.childrenByParent.get(workspaceId) ?? []).map((taskId) => ({
        taskId,
        workflowOwned: false,
      })),
    ];
    while (stack.length > 0) {
      const next = stack.pop()!;
      const entry = index.byId.get(next.taskId);
      const workflowOwned = next.workflowOwned || entry?.workflowTask != null;
      if (
        entry != null &&
        this.isActiveAgentTaskEntry(entry) &&
        !(options.excludeWorkflowTasks && workflowOwned)
      ) {
        result.push(next.taskId);
      }
      const children = index.childrenByParent.get(next.taskId);
      if (children) {
        for (const child of children) {
          stack.push({ taskId: child, workflowOwned });
        }
      }
    }
    return result;
  }

  private async unarchiveAgentTaskAncestry(
    ownerWorkspaceId: string,
    taskId: string
  ): Promise<Result<boolean, string>> {
    const config = this.config.loadConfigOrDefault();
    const index = this.buildAgentTaskIndex(config);
    const chain: string[] = [];
    let currentWorkspaceId: string | undefined = taskId;
    for (let depth = 0; currentWorkspaceId != null && depth < 32; depth++) {
      chain.push(currentWorkspaceId);
      if (currentWorkspaceId === ownerWorkspaceId) break;
      currentWorkspaceId = index.parentById.get(currentWorkspaceId);
    }
    if (chain.at(-1) !== ownerWorkspaceId) {
      return Err("Task is not a descendant of this workspace");
    }

    // A child cannot appear in the active workspace tree while an ancestor remains archived.
    // Restore root-to-leaf so every intermediate parent is visible before its child.
    let didUnarchive = false;
    chain.reverse();
    for (const workspaceId of chain) {
      const entry = findWorkspaceEntry(this.config.loadConfigOrDefault(), workspaceId);
      if (
        entry == null ||
        !isWorkspaceArchived(entry.workspace.archivedAt, entry.workspace.unarchivedAt)
      ) {
        continue;
      }
      didUnarchive = true;
      // WhileTaskTreeLocked: callers run under the send path's task-tree lock for this same
      // tree (ancestors share the root), so the plain unarchive() wrapper would self-deadlock.
      const result = await this.workspaceService.unarchiveWhileTaskTreeLocked(workspaceId);
      if (!result.success) {
        return Err(result.error);
      }
    }
    return Ok(didUnarchive);
  }

  async removeInactiveDescendantAgentTask(
    ownerWorkspaceId: string,
    taskId: string
  ): Promise<Result<WorkspaceLifecycleResult, string>> {
    assert(ownerWorkspaceId.length > 0, "removeInactiveDescendantAgentTask requires owner");
    assert(taskId.length > 0, "removeInactiveDescendantAgentTask requires taskId");

    return await this.withTaskTreeLifecycleLock(taskId, async () => {
      const config = this.config.loadConfigOrDefault();
      const entry = findWorkspaceEntry(config, taskId);
      if (entry == null) {
        const wasOwned =
          (await this.hasRemovedAgentTaskTombstone(ownerWorkspaceId, taskId)) ||
          (await this.filterDescendantAgentTaskIds(ownerWorkspaceId, [taskId])).includes(taskId);
        return Ok(
          wasOwned
            ? { status: "already_removed", action: "remove", taskId, workspaceId: taskId }
            : { status: "invalid_scope", action: "remove", taskId }
        );
      }

      const index = this.buildAgentTaskIndex(config);
      if (!this.isDescendantAgentTaskUsingParentById(index.parentById, ownerWorkspaceId, taskId)) {
        return Ok({ status: "invalid_scope", action: "remove", taskId });
      }

      const displayName = coerceNonEmptyString(entry.workspace.title) ?? entry.workspace.name;
      const target = {
        taskId,
        workspaceId: taskId,
        ...(displayName != null ? { displayName } : {}),
      };
      const descendantTaskIds = this.listDescendantAgentTasks(taskId).map((task) => task.taskId);
      if (descendantTaskIds.length > 0) {
        return Ok({
          status: "error",
          action: "remove",
          ...target,
          descendantTaskIds,
          error: "Cannot remove a sub-agent while descendant sub-agents remain.",
        });
      }

      if (
        this.isActiveAgentTaskEntry({ ...entry.workspace, projectPath: entry.projectPath }) ||
        this.aiService.isStreaming(taskId)
      ) {
        return Ok({
          status: "active",
          action: "remove",
          ...target,
          activeTaskIds: [taskId],
          note: "Stop the sub-agent before removing it.",
        });
      }

      return await this.gitPatchArtifactService.withOperationLock(taskId, async () => {
        // The task can become inactive before its background format-patch job finishes. Wait for the
        // in-process job, then refuse removal if a restart left a durable pending marker behind; the
        // child worktree is the source needed to recover that artifact.
        await this.gitPatchArtifactService.waitForGeneration(taskId);
        const parentWorkspaceId = entry.workspace.parentWorkspaceId;
        if (parentWorkspaceId) {
          const patchArtifact = await readSubagentGitPatchArtifact(
            path.join(this.config.sessionsDir, parentWorkspaceId),
            taskId
          );
          if (patchArtifact?.status === "pending") {
            return Ok({
              status: "error",
              action: "remove",
              ...target,
              error: "Cannot remove the sub-agent while its git patch artifact is still pending.",
            });
          }
        }

        const tombstoneResult = await this.persistRemovedAgentTaskTombstones(taskId);
        if (!tombstoneResult.success) {
          return Ok({ status: "error", action: "remove", ...target, error: tombstoneResult.error });
        }
        const result = await this.workspaceService.removeWhileTaskTreeLocked(taskId, true);
        return Ok(
          result.success
            ? { status: "removed", action: "remove", ...target }
            : { status: "error", action: "remove", ...target, error: result.error }
        );
      });
    });
  }

  private removedAgentTaskTombstonePath(ownerWorkspaceId: string, taskId: string): string {
    return path.join(
      this.config.sessionsDir,
      ownerWorkspaceId,
      REMOVED_AGENT_TASKS_DIR,
      `${encodeURIComponent(taskId)}.json`
    );
  }

  private async hasRemovedAgentTaskTombstone(
    ownerWorkspaceId: string,
    taskId: string
  ): Promise<boolean> {
    try {
      const raw = await fsPromises.readFile(
        this.removedAgentTaskTombstonePath(ownerWorkspaceId, taskId),
        "utf-8"
      );
      const parsed = JSON.parse(raw) as unknown;
      return (
        parsed != null &&
        typeof parsed === "object" &&
        (parsed as { taskId?: unknown }).taskId === taskId
      );
    } catch (error: unknown) {
      if (
        error != null &&
        typeof error === "object" &&
        "code" in error &&
        error.code === "ENOENT"
      ) {
        return false;
      }
      log.debug("Failed to read removed sub-agent tombstone", {
        ownerWorkspaceId,
        taskId,
        error,
      });
      return false;
    }
  }

  private async persistRemovedAgentTaskTombstones(taskId: string): Promise<Result<void, string>> {
    const config = this.config.loadConfigOrDefault();
    const index = this.buildAgentTaskIndex(config);
    const ancestorWorkspaceIds = this.listAncestorWorkspaceIdsUsingParentById(
      index.parentById,
      taskId
    );
    if (ancestorWorkspaceIds.length === 0) {
      return Err("Cannot persist removed sub-agent ownership: missing ancestor lineage");
    }

    const payload = JSON.stringify(
      {
        taskId,
        ancestorWorkspaceIds,
        removedAt: getIsoNow(),
      },
      null,
      2
    );
    try {
      for (const ancestorWorkspaceId of ancestorWorkspaceIds) {
        const filePath = this.removedAgentTaskTombstonePath(ancestorWorkspaceId, taskId);
        await fsPromises.mkdir(path.dirname(filePath), { recursive: true });
        await fsPromises.writeFile(filePath, payload, "utf-8");
      }
      return Ok(undefined);
    } catch (error: unknown) {
      return Err(`Failed to persist removed sub-agent tombstone: ${getErrorMessage(error)}`);
    }
  }

  listDescendantAgentTasks(
    workspaceId: string,
    options?: { statuses?: AgentTaskStatus[]; excludeWorkflowTasks?: boolean }
  ): DescendantAgentTaskInfo[] {
    assert(workspaceId.length > 0, "listDescendantAgentTasks: workspaceId must be non-empty");

    const statuses = options?.statuses;
    const statusFilter = statuses && statuses.length > 0 ? new Set(statuses) : null;

    const cfg = this.config.loadConfigOrDefault();
    const index = this.buildAgentTaskIndex(cfg);

    const result: DescendantAgentTaskInfo[] = [];

    const stack: Array<{ taskId: string; depth: number; workflowOwned: boolean }> = [];
    for (const childTaskId of index.childrenByParent.get(workspaceId) ?? []) {
      stack.push({ taskId: childTaskId, depth: 1, workflowOwned: false });
    }

    while (stack.length > 0) {
      const next = stack.pop()!;
      const entry = index.byId.get(next.taskId);
      if (!entry) continue;

      assert(
        entry.parentWorkspaceId,
        `listDescendantAgentTasks: task ${next.taskId} is missing parentWorkspaceId`
      );

      const workflowOwned = next.workflowOwned || entry.workflowTask != null;
      const status: AgentTaskStatus = entry.taskStatus ?? "running";
      if (
        (!statusFilter || statusFilter.has(status)) &&
        !(options?.excludeWorkflowTasks === true && workflowOwned)
      ) {
        result.push({
          taskId: next.taskId,
          status,
          parentWorkspaceId: entry.parentWorkspaceId,
          agentType: entry.agentType,
          workspaceName: entry.name,
          title: entry.title,
          createdAt: entry.createdAt,
          executionTaskId: entry.taskExecutionId,
          executionStatus: entry.taskExecutionStatus,
          modelString: entry.aiSettings?.model,
          thinkingLevel: entry.aiSettings?.thinkingLevel,
          ...(entry.bestOf != null ? { bestOf: { ...entry.bestOf } } : {}),
          depth: next.depth,
        });
      }

      for (const childTaskId of index.childrenByParent.get(next.taskId) ?? []) {
        stack.push({ taskId: childTaskId, depth: next.depth + 1, workflowOwned });
      }
    }

    // Stable ordering: oldest first, then depth (ties by taskId for determinism).
    result.sort((a, b) => {
      const aTime = a.createdAt ? Date.parse(a.createdAt) : 0;
      const bTime = b.createdAt ? Date.parse(b.createdAt) : 0;
      if (aTime !== bTime) return aTime - bTime;
      if (a.depth !== b.depth) return a.depth - b.depth;
      return a.taskId.localeCompare(b.taskId);
    });

    return result;
  }

  async filterDescendantAgentTaskIds(
    ancestorWorkspaceId: string,
    taskIds: string[]
  ): Promise<string[]> {
    assert(
      ancestorWorkspaceId.length > 0,
      "filterDescendantAgentTaskIds: ancestorWorkspaceId required"
    );
    assert(Array.isArray(taskIds), "filterDescendantAgentTaskIds: taskIds must be an array");

    const cfg = this.config.loadConfigOrDefault();
    const parentById = this.buildAgentTaskIndex(cfg).parentById;

    const result: string[] = [];
    const maybePersisted: string[] = [];

    for (const taskId of taskIds) {
      if (typeof taskId !== "string" || taskId.length === 0) continue;

      if (this.isDescendantAgentTaskUsingParentById(parentById, ancestorWorkspaceId, taskId)) {
        result.push(taskId);
        continue;
      }

      const cached = this.completedReportsByTaskId.get(taskId);
      if (hasAncestorWorkspaceId(cached, ancestorWorkspaceId)) {
        result.push(taskId);
        continue;
      }

      maybePersisted.push(taskId);
    }

    if (maybePersisted.length === 0) {
      return result;
    }

    // Terminal failures persist in a separate artifacts file (a failure must
    // never masquerade as a completed report), so scope checks must consult
    // BOTH: a background-failed child that was cleaned up or lost to a restart
    // must stay in scope for task_await so waitForAgentReport can surface the
    // persisted typed failure instead of degrading to invalid_scope/not_found.
    const sessionDir = path.join(this.config.sessionsDir, ancestorWorkspaceId);
    const [reports, failures] = await Promise.all([
      readSubagentReportArtifactsFile(sessionDir),
      readSubagentFailureArtifactsFile(sessionDir),
    ]);
    for (const taskId of maybePersisted) {
      if (
        hasAncestorWorkspaceId(reports.artifactsByChildTaskId[taskId], ancestorWorkspaceId) ||
        hasAncestorWorkspaceId(failures.failuresByChildTaskId[taskId], ancestorWorkspaceId)
      ) {
        result.push(taskId);
      }
    }

    return result;
  }

  private listDescendantAgentTaskIdsFromIndex(
    index: AgentTaskIndex,
    workspaceId: string
  ): string[] {
    assert(
      workspaceId.length > 0,
      "listDescendantAgentTaskIdsFromIndex: workspaceId must be non-empty"
    );

    const result: string[] = [];
    const visited = new Set([workspaceId]);
    const stack: string[] = [...(index.childrenByParent.get(workspaceId) ?? [])];
    while (stack.length > 0) {
      const next = stack.pop()!;
      if (visited.has(next)) {
        continue;
      }
      visited.add(next);
      result.push(next);
      const children = index.childrenByParent.get(next);
      if (children) {
        for (const child of children) {
          stack.push(child);
        }
      }
    }
    return result;
  }

  private isWorkflowRunDescendant(
    index: AgentTaskIndex,
    taskId: string,
    workflowRunId: string
  ): boolean {
    let current: string | undefined = taskId;
    for (let i = 0; current != null && i < 32; i++) {
      const entry = index.byId.get(current);
      if (entry?.workflowTask?.runId === workflowRunId) {
        return true;
      }
      current = index.parentById.get(current);
    }
    return false;
  }

  async isWorkflowOwnedDescendantAgentTask(
    ancestorWorkspaceId: string,
    taskId: string
  ): Promise<boolean> {
    assert(
      ancestorWorkspaceId.length > 0,
      "isWorkflowOwnedDescendantAgentTask: ancestorWorkspaceId required"
    );
    assert(taskId.length > 0, "isWorkflowOwnedDescendantAgentTask: taskId required");

    const cfg = this.config.loadConfigOrDefault();
    const indexResult = this.getWorkflowOwnedDescendantAgentTaskUsingIndex(
      this.buildAgentTaskIndex(cfg),
      ancestorWorkspaceId,
      taskId
    );
    if (indexResult != null) {
      return indexResult;
    }

    const cached = this.completedReportsByTaskId.get(taskId);
    if (hasWorkflowOwnedAncestorWorkspaceId(cached, ancestorWorkspaceId)) {
      return true;
    }
    if (hasAncestorWorkspaceId(cached, ancestorWorkspaceId)) {
      return false;
    }

    const sessionDir = path.join(this.config.sessionsDir, ancestorWorkspaceId);
    const persisted = await readSubagentReportArtifactsFile(sessionDir);
    const entry = persisted.artifactsByChildTaskId[taskId];
    if (entry != null) {
      return hasWorkflowOwnedAncestorWorkspaceId(entry, ancestorWorkspaceId);
    }

    // A workflow-owned child that failed terminally leaves only a failure
    // artifact. It must stay excluded from direct task_await after cleanup,
    // matching live behavior: its failure is consumed through the workflow run.
    const failures = await readSubagentFailureArtifactsFile(sessionDir);
    return hasWorkflowOwnedAncestorWorkspaceId(
      failures.failuresByChildTaskId[taskId],
      ancestorWorkspaceId
    );
  }

  private getWorkflowOwnedDescendantAgentTaskUsingIndex(
    index: AgentTaskIndex,
    ancestorWorkspaceId: string,
    taskId: string
  ): boolean | null {
    let current = taskId;
    let workflowOwned = false;

    for (let i = 0; i < 32; i++) {
      const entry = index.byId.get(current);
      workflowOwned ||= entry?.workflowTask != null;

      const parent = index.parentById.get(current);
      if (!parent) return null;
      if (parent === ancestorWorkspaceId) return workflowOwned;
      current = parent;
    }

    throw new Error(
      `getWorkflowOwnedDescendantAgentTaskUsingIndex: possible parentWorkspaceId cycle starting at ${taskId}`
    );
  }

  async isDescendantAgentTask(ancestorWorkspaceId: string, taskId: string): Promise<boolean> {
    assert(ancestorWorkspaceId.length > 0, "isDescendantAgentTask: ancestorWorkspaceId required");
    assert(taskId.length > 0, "isDescendantAgentTask: taskId required");

    const cfg = this.config.loadConfigOrDefault();
    const parentById = this.buildAgentTaskIndex(cfg).parentById;
    if (this.isDescendantAgentTaskUsingParentById(parentById, ancestorWorkspaceId, taskId)) {
      return true;
    }

    if (await this.hasRemovedAgentTaskTombstone(ancestorWorkspaceId, taskId)) {
      return true;
    }

    // The task workspace may have been removed after it settled (cleanup/restart). Preserve scope
    // checks by consulting persisted report AND failure artifacts in the ancestor session dir —
    // a terminally-failed child must stay awaitable so its typed failure can be surfaced.
    const cached = this.completedReportsByTaskId.get(taskId);
    if (hasAncestorWorkspaceId(cached, ancestorWorkspaceId)) {
      return true;
    }

    const sessionDir = path.join(this.config.sessionsDir, ancestorWorkspaceId);
    const [reports, failures] = await Promise.all([
      readSubagentReportArtifactsFile(sessionDir),
      readSubagentFailureArtifactsFile(sessionDir),
    ]);
    return (
      hasAncestorWorkspaceId(reports.artifactsByChildTaskId[taskId], ancestorWorkspaceId) ||
      hasAncestorWorkspaceId(failures.failuresByChildTaskId[taskId], ancestorWorkspaceId)
    );
  }

  isDescendantAgentTaskUsingParentById(
    parentById: Map<string, string>,
    ancestorWorkspaceId: string,
    taskId: string
  ): boolean {
    let current = taskId;
    for (let i = 0; i < 32; i++) {
      const parent = parentById.get(current);
      if (!parent) return false;
      if (parent === ancestorWorkspaceId) return true;
      current = parent;
    }

    throw new Error(
      `isDescendantAgentTaskUsingParentById: possible parentWorkspaceId cycle starting at ${taskId}`
    );
  }

  /** Walks parentWorkspaceId chains up to the tree root (a workspace with no agent-task parent). */
  private resolveRootWorkspaceIdUsingParentById(
    parentById: Map<string, string>,
    workspaceId: string
  ): string {
    let current = workspaceId;
    for (let i = 0; i < 32; i++) {
      const parent = parentById.get(current);
      if (!parent) return current;
      current = parent;
    }

    throw new Error(
      `resolveRootWorkspaceIdUsingParentById: possible parentWorkspaceId cycle starting at ${workspaceId}`
    );
  }

  /**
   * Relation of `targetId` to `senderWorkspaceId` within one task tree, or null when the endpoints
   * are the same workspace (self-sends are out of scope) or live in different trees. Only
   * parentWorkspaceId chains define the tree; workspace-turn ownership tags are a separate graph.
   */
  private resolveAgentTreeTargetRelation(
    parentById: Map<string, string>,
    senderWorkspaceId: string,
    targetId: string
  ): AgentTreeTargetRelation | null {
    if (senderWorkspaceId === targetId) return null;
    if (this.isDescendantAgentTaskUsingParentById(parentById, senderWorkspaceId, targetId)) {
      return "target_descendant";
    }
    if (this.isDescendantAgentTaskUsingParentById(parentById, targetId, senderWorkspaceId)) {
      return "target_ancestor";
    }
    // Ancestor/descendant is already ruled out, so a shared root means sibling/cousin. Distinct
    // roots (including two unrelated plain workspaces, each its own root) are cross-tree.
    const senderRoot = this.resolveRootWorkspaceIdUsingParentById(parentById, senderWorkspaceId);
    const targetRoot = this.resolveRootWorkspaceIdUsingParentById(parentById, targetId);
    return senderRoot === targetRoot ? "peer" : null;
  }

  /** True when the workspace or any agent-task ancestor carries best-of candidate metadata. */
  private isBestOfChainUsingIndex(index: AgentTaskIndex, workspaceId: string): boolean {
    return this.findNearestBestOfGroupUsingIndex(index, workspaceId) != null;
  }

  /** Nearest best-of candidate metadata on the workspace or any agent-task ancestor. */
  private findNearestBestOfGroupUsingIndex(
    index: AgentTaskIndex,
    workspaceId: string
  ): TaskCreateArgs["bestOf"] {
    let current = workspaceId;
    for (let i = 0; i < 32; i++) {
      const entry = index.byId.get(current);
      const group = entry != null ? this.getEffectiveTaskGroup(current, entry) : undefined;
      if (group != null) return group;
      const parent = index.parentById.get(current);
      if (!parent) return undefined;
      current = parent;
    }

    throw new Error(
      `findNearestBestOfGroupUsingIndex: possible parentWorkspaceId cycle starting at ${workspaceId}`
    );
  }

  /**
   * All addressable agent tasks in the caller's task tree (the root's full descendant
   * enumeration, workflow-owned subtrees excluded), tagged with each row's relationship to the
   * caller. The root is returned separately because it is a plain workspace, not an agent task.
   */
  listTaskTreeAgents(workspaceId: string): TaskTreeAgentsResult {
    assert(workspaceId.length > 0, "listTaskTreeAgents: workspaceId must be non-empty");

    const cfg = this.config.loadConfigOrDefault();
    const index = this.buildAgentTaskIndex(cfg);
    // the peer relation leg refuses EVERY peer/ancestor delivery from a best-of candidate
    // (independence) or a workflow-owned task (journal determinism) based on the sender's own
    // chain — advertising root/sibling/ancestor rows to such a caller would direct it at
    // targets it can never message. Descendant guidance stays valid, so those rows survive.
    const callerWorkflowOwned = this.isWorkflowOwnedTaskUsingIndex(index, workspaceId);
    const callerRestricted =
      this.isBestOfChainUsingIndex(index, workspaceId) || callerWorkflowOwned;
    const rootWorkspaceId = this.resolveRootWorkspaceIdUsingParentById(
      index.parentById,
      workspaceId
    );
    const rootEntry = findWorkspaceEntry(cfg, rootWorkspaceId);
    const rootTitle =
      rootEntry != null
        ? (coerceNonEmptyString(rootEntry.workspace.title) ??
          coerceNonEmptyString(rootEntry.workspace.name))
        : undefined;

    const tasks = this.listDescendantAgentTasks(rootWorkspaceId)
      .filter((task) => {
        if (!this.isWorkflowOwnedTaskUsingIndex(index, task.taskId)) return true;
        // Workflow subtrees are hidden from callers OUTSIDE them (their I/O rides the runner's
        // durable journal). A workflow-owned caller still owns its own subtree: descendant
        // guidance routes through the trusted path before peer workflow restrictions apply, so
        // the restricted view must keep the self/descendant rows its note promises.
        return (
          callerWorkflowOwned &&
          (task.taskId === workspaceId ||
            this.isDescendantAgentTaskUsingParentById(index.parentById, workspaceId, task.taskId))
        );
      })
      .map((task): TreeAgentTaskInfo => {
        const relationship: TreeAgentRelationship =
          task.taskId === workspaceId
            ? "self"
            : this.isDescendantAgentTaskUsingParentById(index.parentById, workspaceId, task.taskId)
              ? "descendant"
              : this.isDescendantAgentTaskUsingParentById(
                    index.parentById,
                    task.taskId,
                    workspaceId
                  )
                ? "ancestor"
                : "sibling";
        // the peer relation leg refuses a candidate's ENTIRE subtree (isBestOfChainUsingIndex walks
        // ancestors), so discovery must mark nested children of a candidate too: inherit the
        // nearest ancestor's candidate metadata when the row carries none of its own, keeping the
        // tree note's "bestOf metadata ⇒ not peer-addressable" rule aligned with refusal behavior.
        const bestOf = task.bestOf ?? this.findNearestBestOfGroupUsingIndex(index, task.taskId);
        const info: TreeAgentTaskInfo = {
          ...task,
          ...(bestOf != null ? { bestOf } : {}),
          relationship,
        };
        // A crash or failed startup reconciliation can leave a stale persisted "running"
        // execution mirror on a stably terminal peer, and peer admission only honors a mirror
        // backed by the matching ACCEPTED live handle — so peer discovery must apply the same
        // predicate or it would advertise a nonterminal, addressable row task_send_message
        // always refuses. Descendant/self rows keep the full overlay (guidance may target any
        // state, and the ancestor-scoped snapshot in task_list refines them).
        if (relationship === "sibling" || relationship === "ancestor") {
          const live = this.getWorkspaceTurnManager().getLiveWorkspaceTurnRegistration(task.taskId);
          const liveBacked =
            task.executionTaskId != null &&
            live != null &&
            live.handleId === task.executionTaskId &&
            live.accepted;
          if (!liveBacked) {
            delete info.executionTaskId;
            delete info.executionStatus;
          }
        }
        return info;
      })
      .filter((task) => {
        // Archived state is independent of taskStatus (legacy archived rows can still read
        // "running"), and the peer relation leg unconditionally refuses archived targets — hide
        // them from PEER discovery so the note's addressability claim stays true. Archived
        // DESCENDANTS stay visible: their delivery routes through the trusted
        // sendMessageToDescendantAgentTask path, which can restore and reawaken an inactive
        // child, so hiding them would strand a valid reusable task ID after compaction.
        if (task.relationship === "descendant" || task.relationship === "self") {
          return true;
        }
        if (callerRestricted) {
          return false;
        }
        const entry = index.byId.get(task.taskId);
        return entry == null || !isWorkspaceArchived(entry.archivedAt, entry.unarchivedAt);
      });

    // An archived root refuses peer sends at the peer relation leg's archived-target check, so
    // discovery must not advertise it as an addressable "workspace" row.
    const rootArchived =
      rootEntry != null &&
      isWorkspaceArchived(rootEntry.workspace.archivedAt, rootEntry.workspace.unarchivedAt);

    return {
      rootWorkspaceId,
      ...(rootTitle != null ? { rootTitle } : {}),
      rootRelationship: rootWorkspaceId === workspaceId ? "self" : "ancestor",
      ...(rootArchived ? { rootArchived: true as const } : {}),
      // Partial removal or config corruption can leave a retained descendant whose parent chain
      // ends at a workspace that no longer exists; sendAgentTreeMessage returns not_found for
      // that ID, so discovery must say so instead of advertising an addressable root row.
      ...(rootEntry == null ? { rootMissing: true as const } : {}),
      ...(callerRestricted ? { callerPeerMessagingRestricted: true as const } : {}),
      tasks,
    };
  }

  // --- Internal orchestration ---

  private listAncestorWorkspaceIdsUsingParentById(
    parentById: Map<string, string>,
    taskId: string
  ): string[] {
    const ancestors: string[] = [];

    let current = taskId;
    for (let i = 0; i < 32; i++) {
      const parent = parentById.get(current);
      if (!parent) return ancestors;
      ancestors.push(parent);
      current = parent;
    }

    throw new Error(
      `listAncestorWorkspaceIdsUsingParentById: possible parentWorkspaceId cycle starting at ${taskId}`
    );
  }

  listAgentTaskWorkspaces(
    config: ReturnType<Config["loadConfigOrDefault"]>
  ): AgentTaskWorkspaceEntry[] {
    const tasks: AgentTaskWorkspaceEntry[] = [];
    for (const [projectPath, project] of config.projects) {
      for (const workspace of project.workspaces) {
        if (!workspace.id) continue;
        if (!workspace.parentWorkspaceId) continue;
        tasks.push({ ...workspace, projectPath });
      }
    }
    return tasks;
  }

  isDescendantAgentTaskInConfig(
    config: ReturnType<Config["loadConfigOrDefault"]>,
    ancestorWorkspaceId: string,
    taskId: string
  ): boolean {
    return this.isDescendantAgentTaskUsingParentById(
      this.buildAgentTaskIndex(config).parentById,
      ancestorWorkspaceId,
      taskId
    );
  }

  listAgentTaskExecutionEntries(
    config: ReturnType<Config["loadConfigOrDefault"]>
  ): Array<{ id?: string; taskExecutionId?: string }> {
    return this.listAgentTaskWorkspaces(config);
  }

  buildAgentTaskIndex(config: ReturnType<Config["loadConfigOrDefault"]>): AgentTaskIndex {
    const byId = new Map<string, AgentTaskWorkspaceEntry>();
    const childrenByParent = new Map<string, string[]>();
    const parentById = new Map<string, string>();

    for (const task of this.listAgentTaskWorkspaces(config)) {
      const taskId = task.id!;
      byId.set(taskId, task);

      const parent = task.parentWorkspaceId;
      if (!parent) continue;

      parentById.set(taskId, parent);
      const list = childrenByParent.get(parent) ?? [];
      list.push(taskId);
      childrenByParent.set(parent, list);
    }

    return { byId, childrenByParent, parentById };
  }

  private isWorkflowOwnedTaskUsingIndex(index: AgentTaskIndex, taskId: string): boolean {
    assert(taskId.length > 0, "isWorkflowOwnedTaskUsingIndex: taskId must be non-empty");
    return this.findWorkflowTaskOwnerInAncestry(index, taskId) != null;
  }

  /**
   * Filter active workflow run IDs down to those whose persisted attention
   * policy still blocks the owner's turn-end. `notify_on_terminal` runs are
   * non-blocking; their terminal result is delivered via the existing
   * AIService background-run terminal continuation.
   */
  private async listBlockingWorkflowRunIds(
    workspaceId: string,
    runIds: string[]
  ): Promise<string[]> {
    if (runIds.length === 0) {
      return [];
    }
    const runStore = new WorkflowRunStore({
      sessionDir: path.join(this.config.sessionsDir, workspaceId),
    });
    const blocking: string[] = [];
    for (const runId of runIds) {
      const run = await runStore.getRun(runId).catch(() => null);
      if (resolveBackgroundWorkAttentionPolicy(run?.attentionPolicy) !== "notify_on_terminal") {
        blocking.push(runId);
      }
    }
    return blocking;
  }

  async noteWorkspaceUnarchived(workspaceId: string): Promise<void> {
    assert(workspaceId.length > 0, "noteWorkspaceUnarchived requires workspaceId");
    // Archived owners park workflow terminal wakes unsettled (the drain drops the in-memory
    // queue and the sweep skips archived workspaces), so without this unarchive-time
    // reconciliation an idle owner would stay silent until the interval sweep.
    await this.sweepWorkflowRunTerminalAttention(workspaceId);
  }

  /**
   * Whether any top-level workflow runs are durably active for this workspace. The archive
   * sink rechecks this after arming its admission gate (see archiveUnlocked) so a workflow
   * admitted between the lifecycle caller's earlier snapshot and the sink cannot be orphaned
   * in an archived workspace.
   */
  async hasActiveTopLevelWorkflowRunsForWorkspace(workspaceId: string): Promise<boolean> {
    try {
      return (await this.listActiveWorkflowRunIdsForWorkspaceStrict(workspaceId)).length > 0;
    } catch (error: unknown) {
      // Fail closed: this feeds the archive sink, and an unreadable run store cannot prove
      // the absence of active runs (a crash-recovered run may still resume later).
      log.warn("Workflow activity scan failed; treating workspace as having active runs", {
        workspaceId,
        error: getErrorMessage(error),
      });
      return true;
    }
  }

  /**
   * Strict variant for archive gates: scan failures (unreadable run store or run records)
   * propagate instead of reading as "no runs". A crash-recovered run with a delayed resume
   * would otherwise restart inside a workspace whose archive was admitted on the false
   * empty answer.
   */
  async listActiveWorkflowRunIdsForWorkspaceStrict(workspaceId: string): Promise<string[]> {
    assert(
      workspaceId.length > 0,
      "listActiveWorkflowRunIdsForWorkspaceStrict requires workspaceId"
    );
    const runStore = new WorkflowRunStore({
      sessionDir: path.join(this.config.sessionsDir, workspaceId),
    });
    const runs = await runStore.listRunsForActivityScan();
    return runs
      .filter(
        (run) =>
          run.workspaceId === workspaceId &&
          run.parentWorkflow == null &&
          isActiveWorkflowRunStatus(run.status)
      )
      .map((run) => run.id);
  }

  /**
   * Lenient variant for heuristics (task-owned-work and terminal-drain checks) where a
   * transient scan failure should not abort the surrounding flow. Archive gates must use
   * the strict variant (or hasActiveTopLevelWorkflowRunsForWorkspace, which fails closed).
   */
  private async listActiveWorkflowRunIdsForWorkspace(workspaceId: string): Promise<string[]> {
    try {
      return await this.listActiveWorkflowRunIdsForWorkspaceStrict(workspaceId);
    } catch (error: unknown) {
      log.warn("Failed to list active workflow runs for workspace", {
        workspaceId,
        error: getErrorMessage(error),
      });
      return [];
    }
  }

  private async hasActiveTaskOwnedWork(
    workspaceId: string,
    taskIndex: AgentTaskIndex
  ): Promise<boolean> {
    assert(workspaceId.length > 0, "hasActiveTaskOwnedWork requires workspaceId");
    if (this.hasActiveDescendantAgentTasksUsingIndex(taskIndex, workspaceId)) {
      return true;
    }
    if (
      (await this.getWorkspaceTurnManager().listActiveWorkspaceTurnTaskIdsForOwner(workspaceId))
        .length > 0
    ) {
      return true;
    }
    return (await this.listActiveWorkflowRunIdsForWorkspace(workspaceId)).length > 0;
  }

  private async hasBlockingActiveWorkForTerminalDrain(
    workspaceId: string,
    taskIndex: AgentTaskIndex
  ): Promise<boolean> {
    assert(workspaceId.length > 0, "hasBlockingActiveWorkForTerminalDrain requires workspaceId");
    if (
      this.listBlockingActiveDescendantAgentTaskIdsUsingIndex(taskIndex, workspaceId, {
        excludeWorkflowTasks: true,
      }).length > 0
    ) {
      return true;
    }
    const activeWorkspaceTurnIds =
      await this.getWorkspaceTurnManager().listActiveWorkspaceTurnTaskIdsForOwner(workspaceId);
    if (
      (
        await this.getWorkspaceTurnManager().listBlockingWorkspaceTurnTaskIds(
          workspaceId,
          activeWorkspaceTurnIds
        )
      ).length > 0
    ) {
      return true;
    }
    const activeWorkflowRunIds = await this.listActiveWorkflowRunIdsForWorkspace(workspaceId);
    return (await this.listBlockingWorkflowRunIds(workspaceId, activeWorkflowRunIds)).length > 0;
  }

  private isActiveAgentTaskEntry(task: AgentTaskWorkspaceEntry): boolean {
    if (isActiveWorkspaceTurnTaskStatus(task.taskExecutionStatus)) {
      return true;
    }
    const status: AgentTaskStatus = task.taskStatus ?? "running";
    if (!ACTIVE_AGENT_TASK_STATUSES.has(status)) {
      return false;
    }

    // Archiving a task stops its stream but intentionally leaves taskStatus untouched in
    // persisted config. Treat archived, non-streaming tasks as inactive so stale status cannot
    // keep ancestors/workspace-turn handles blocked forever.
    if (isWorkspaceArchived(task.archivedAt, task.unarchivedAt)) {
      return task.id != null && this.aiService.isStreaming(task.id);
    }

    return true;
  }

  countActiveAgentTasks(config: ReturnType<Config["loadConfigOrDefault"]>): number {
    let activeCount = 0;
    for (const task of this.listAgentTaskWorkspaces(config)) {
      const status: AgentTaskStatus = task.taskStatus ?? "running";
      // A reawakened persistent child is represented by its private workspace-turn handle in the
      // workspace-turn count. Charging its mirrored execution status here would count one task twice.
      if (
        isWorkspaceTurnTaskId(task.taskExecutionId) &&
        isActiveWorkspaceTurnTaskStatus(task.taskExecutionStatus)
      ) {
        continue;
      }
      // If this task workspace is blocked in a foreground wait, do not count it towards parallelism.
      // This prevents deadlocks where a task spawns a nested task in the foreground while
      // maxParallelAgentTasks is low (e.g. 1).
      // Note: StreamManager can still report isStreaming() while a tool call is executing, so
      // isStreaming is not a reliable signal for "actively doing work" here.
      if (status === "running" && task.id && this.isForegroundAwaiting(task.id)) {
        continue;
      }
      if (status !== "queued" && this.isActiveAgentTaskEntry(task)) {
        activeCount += 1;
        continue;
      }

      // Defensive: task status and runtime stream state can be briefly out of sync during
      // termination/cleanup boundaries. Count streaming tasks as active so we never exceed
      // the configured parallel limit.
      if (task.id && this.aiService.isStreaming(task.id)) {
        activeCount += 1;
      }
    }

    return activeCount;
  }

  hasActiveDescendantAgentTasks(
    config: ReturnType<Config["loadConfigOrDefault"]>,
    workspaceId: string
  ): boolean {
    return this.hasActiveDescendantAgentTasksUsingIndex(
      this.buildAgentTaskIndex(config),
      workspaceId
    );
  }

  private hasActiveDescendantAgentTasksUsingIndex(
    index: AgentTaskIndex,
    workspaceId: string
  ): boolean {
    assert(
      workspaceId.length > 0,
      "hasActiveDescendantAgentTasksUsingIndex: workspaceId must be non-empty"
    );

    const stack: string[] = [...(index.childrenByParent.get(workspaceId) ?? [])];
    while (stack.length > 0) {
      const next = stack.pop()!;
      const entry = index.byId.get(next);
      if (entry != null && this.isActiveAgentTaskEntry(entry)) {
        return true;
      }
      const children = index.childrenByParent.get(next);
      if (children) {
        for (const child of children) {
          stack.push(child);
        }
      }
    }

    return false;
  }

  private listBlockingActiveDescendantAgentTaskIdsUsingIndex(
    index: AgentTaskIndex,
    workspaceId: string,
    options: { excludeWorkflowTasks?: boolean } = {}
  ): string[] {
    assert(
      workspaceId.length > 0,
      "listBlockingActiveDescendantAgentTaskIdsUsingIndex: workspaceId must be non-empty"
    );

    const result: string[] = [];
    const stack: Array<{ taskId: string; workflowOwned: boolean }> = [
      ...(index.childrenByParent.get(workspaceId) ?? []).map((taskId) => ({
        taskId,
        workflowOwned: false,
      })),
    ];
    while (stack.length > 0) {
      const next = stack.pop()!;
      const entry = index.byId.get(next.taskId);
      const workflowOwned = next.workflowOwned || entry?.workflowTask != null;
      const nonBlockingSubtree =
        this.resolveAgentTaskAttentionPolicy(next.taskId, index) === "notify_on_terminal" ||
        this.isTaskQueueBackgrounded(next.taskId);
      if (
        !nonBlockingSubtree &&
        entry != null &&
        this.isActiveAgentTaskEntry(entry) &&
        !(options.excludeWorkflowTasks && workflowOwned)
      ) {
        result.push(next.taskId);
      }
      const children = index.childrenByParent.get(next.taskId);
      if (!nonBlockingSubtree && children) {
        for (const child of children) {
          stack.push({ taskId: child, workflowOwned });
        }
      }
    }
    return result;
  }

  /**
   * Topology predicate: does this workspace still have child agent-task nodes in config?
   * Unlike hasActiveDescendantAgentTasks (which checks runtime activity for scheduling),
   * this checks structural tree shape — any child node blocks parent deletion regardless
   * of its status.
   */
  private hasChildAgentTasks(index: AgentTaskIndex, workspaceId: string): boolean {
    return (index.childrenByParent.get(workspaceId)?.length ?? 0) > 0;
  }

  private getTaskDepth(
    config: ReturnType<Config["loadConfigOrDefault"]>,
    workspaceId: string
  ): number {
    assert(workspaceId.length > 0, "getTaskDepth: workspaceId must be non-empty");

    return this.getTaskDepthFromParentById(
      this.buildAgentTaskIndex(config).parentById,
      workspaceId
    );
  }

  private getTaskDepthFromParentById(parentById: Map<string, string>, workspaceId: string): number {
    let depth = 0;
    let current = workspaceId;
    for (let i = 0; i < 32; i++) {
      const parent = parentById.get(current);
      if (!parent) break;
      depth += 1;
      current = parent;
    }

    if (depth >= 32) {
      throw new Error(
        `getTaskDepthFromParentById: possible parentWorkspaceId cycle starting at ${workspaceId}`
      );
    }

    return depth;
  }

  async maybeStartQueuedTasks(): Promise<void> {
    const existingRun = this.maybeStartQueuedTasksInFlight;
    if (existingRun != null) {
      this.maybeStartQueuedTasksRerunRequested = true;
      await existingRun;
      return;
    }

    // A foreground task waiter registers itself in waitForAgentReport's async setup. Yield once so
    // immediate scheduler calls from the same turn see that foreground-awaiting state and avoid a
    // nested-task deadlock at maxParallelAgentTasks=1.
    await Promise.resolve();
    const existingRunAfterYield = this.maybeStartQueuedTasksInFlight;
    if (existingRunAfterYield != null) {
      this.maybeStartQueuedTasksRerunRequested = true;
      await existingRunAfterYield;
      return;
    }

    const run = (async () => {
      do {
        this.maybeStartQueuedTasksRerunRequested = false;
        await this.maybeStartQueuedTasksFromReservations();
      } while (this.maybeStartQueuedTasksRerunRequested);
    })().finally(() => {
      if (this.maybeStartQueuedTasksInFlight === run) {
        this.maybeStartQueuedTasksInFlight = undefined;
      }
    });
    this.maybeStartQueuedTasksInFlight = run;
    await run;
  }

  private async maybeStartQueuedTasksFromReservations(): Promise<void> {
    const plans: TaskLaunchPlan[] = [];

    {
      await using _lock = await this.mutex.acquire();

      let config = this.config.loadConfigOrDefault();
      const taskSettings: TaskSettings = config.taskSettings ?? DEFAULT_TASK_SETTINGS;
      const listQueuedTasks = (sourceConfig: ProjectsConfig): AgentTaskWorkspaceEntry[] =>
        this.listAgentTaskWorkspaces(sourceConfig)
          .filter((task) => task.taskStatus === "queued" && typeof task.id === "string")
          .sort((a, b) => {
            const aTime = a.createdAt ? Date.parse(a.createdAt) : 0;
            const bTime = b.createdAt ? Date.parse(b.createdAt) : 0;
            return aTime - bTime;
          });
      let taskIndex = this.buildAgentTaskIndex(config);
      let queuedTasks = listQueuedTasks(config);

      let interruptedInactiveWorkflowQueuedTask = false;
      for (const task of queuedTasks) {
        const taskId = task.id;
        assert(taskId != null && taskId.length > 0, "queued task id is required");
        if (
          await this.interruptTaskRecoveryForInactiveWorkflowOwner(
            taskId,
            config,
            "queued-inactive-workflow-owner-prepass",
            taskIndex,
            { scheduleQueueDrain: false }
          )
        ) {
          interruptedInactiveWorkflowQueuedTask = true;
        }
      }
      if (interruptedInactiveWorkflowQueuedTask) {
        config = this.config.loadConfigOrDefault();
        taskIndex = this.buildAgentTaskIndex(config);
        queuedTasks = listQueuedTasks(config);
      }

      const availableSlots = Math.max(
        0,
        taskSettings.maxParallelAgentTasks -
          (this.countActiveAgentTasks(config) +
            (await this.getWorkspaceTurnManager().countActiveWorkspaceTurns()))
      );
      taskQueueDebug("TaskService.maybeStartQueuedTasks reservation summary", {
        maxParallelAgentTasks: taskSettings.maxParallelAgentTasks,
        availableSlots,
      });
      if (availableSlots === 0) return;

      let reservedSlots = 0;
      for (const task of queuedTasks) {
        if (reservedSlots >= availableSlots) {
          break;
        }
        const taskId = task.id;
        assert(taskId != null && taskId.length > 0, "queued task id is required");
        if (
          await this.interruptTaskRecoveryForInactiveWorkflowOwner(
            taskId,
            config,
            "queued-launch",
            taskIndex,
            { scheduleQueueDrain: false }
          )
        ) {
          continue;
        }

        if (this.aiService.isStreaming(taskId)) {
          await this.setTaskStatus(taskId, "running");
          reservedSlots += 1;
          continue;
        }

        const queuedPrompt = coerceNonEmptyString(task.taskPrompt);
        const start: TaskLaunchStart = queuedPrompt
          ? { kind: "sendMessage", prompt: queuedPrompt }
          : { kind: "resumeStream" };
        if (start.kind === "resumeStream") {
          // Older queued task records stored the initial prompt only in chat history.
          // Keep those upgrade-safe by resuming the existing pending stream instead of failing launch.
          taskQueueDebug("TaskService.maybeStartQueuedTasks legacy resumeStream reservation", {
            taskId,
          });
        }

        const parentWorkspaceId = coerceNonEmptyString(task.parentWorkspaceId);
        if (!parentWorkspaceId) {
          await this.markTaskLaunchFailed(taskId, "Queued task missing parentWorkspaceId");
          continue;
        }

        const parentEntry = findWorkspaceEntry(config, parentWorkspaceId);
        if (!parentEntry) {
          await this.markTaskLaunchFailed(taskId, "Queued task parent not found");
          continue;
        }
        const parentWorkspaceName = coerceNonEmptyString(parentEntry.workspace.name);
        if (!parentWorkspaceName) {
          await this.markTaskLaunchFailed(taskId, "Queued task parent missing workspace name");
          continue;
        }

        const taskRuntimeConfig = task.runtimeConfig ?? parentEntry.workspace.runtimeConfig;
        const parentRuntimeConfig = parentEntry.workspace.runtimeConfig ?? taskRuntimeConfig;
        if (!taskRuntimeConfig || !parentRuntimeConfig) {
          await this.markTaskLaunchFailed(taskId, "Queued task missing runtimeConfig");
          continue;
        }

        const normalizedTaskProjectPath = stripTrailingSlashes(task.projectPath);
        const taskProjectConfig = config.projects.get(normalizedTaskProjectPath);
        if (!taskProjectConfig?.trusted) {
          await this.markTaskLaunchFailed(taskId, "Task skipped: project is not trusted");
          continue;
        }
        const untrustedSecondaryProject =
          Array.isArray(task.projects) && task.projects.length > 1
            ? task.projects.find((project) => {
                const normalizedProjectPath = stripTrailingSlashes(project.projectPath);
                if (normalizedProjectPath === normalizedTaskProjectPath) {
                  return false;
                }
                return !(config.projects.get(normalizedProjectPath)?.trusted ?? false);
              })
            : undefined;
        if (untrustedSecondaryProject) {
          await this.markTaskLaunchFailed(
            taskId,
            `Task skipped: project ${untrustedSecondaryProject.projectPath} is not trusted`
          );
          continue;
        }

        const parentRuntimeProjectPath =
          parentEntry.workspace.kind === "scratch"
            ? parentEntry.workspace.path
            : parentEntry.projectPath;
        const parentMetaResult = await this.aiService.getWorkspaceMetadata(parentWorkspaceId);
        const parentMeta = parentMetaResult.success
          ? parentMetaResult.data
          : ({
              id: parentWorkspaceId,
              name: parentWorkspaceName,
              kind: parentEntry.workspace.kind,
              projectPath: parentRuntimeProjectPath,
              projectName:
                parentEntry.workspace.kind === "scratch"
                  ? SCRATCH_PROJECT_NAME
                  : (parentEntry.workspace.projects?.find(
                      (project) =>
                        stripTrailingSlashes(project.projectPath) ===
                        stripTrailingSlashes(parentEntry.projectPath)
                    )?.projectName ??
                    parentEntry.projectPath.split("/").filter(Boolean).at(-1) ??
                    parentEntry.projectPath),
              runtimeConfig: parentRuntimeConfig,
              projects: parentEntry.workspace.projects,
            } satisfies WorkspaceMetadata);

        const agentId = resolveTaskAgentIdForResume(task);
        assert(agentId.length > 0, "queued task agentId is required");
        let skipInitHook = false;
        try {
          const parentRuntime = createRuntimeForWorkspace({
            runtimeConfig: parentRuntimeConfig,
            projectPath: parentRuntimeProjectPath,
            name: parentWorkspaceName,
          });
          const parentWorkspacePath =
            coerceNonEmptyString(parentEntry.workspace.path) ??
            parentRuntime.getWorkspacePath(parentRuntimeProjectPath, parentWorkspaceName);
          const frontmatter = await resolveAgentFrontmatter(
            parentRuntime,
            parentWorkspacePath,
            agentId
          );
          skipInitHook = frontmatter.subagent?.skip_init_hook === true;
        } catch (error: unknown) {
          log.debug("Queued task: failed to resolve skip_init_hook during reservation", {
            taskId,
            agentId,
            error: getErrorMessage(error),
          });
        }

        const workspaceName = coerceNonEmptyString(task.name);
        if (!workspaceName) {
          await this.markTaskLaunchFailed(taskId, "Queued task missing workspace name");
          continue;
        }

        const canonicalModel =
          coerceNonEmptyString(task.aiSettings?.model) ??
          // Gateway-preserving (see resolveTaskAISettings): this lands in the
          // relaunched task's persisted aiSettings.
          normalizeSelectedModel(task.taskModelString ?? defaultModel);
        const createdAt = task.createdAt ?? getIsoNow();
        try {
          await this.editActiveWorkspaceEntry(taskId, (workspace) => {
            workspace.taskStatus = "starting";
          });
        } catch (error) {
          await this.markTaskLaunchFailed(taskId, getErrorMessage(error));
          continue;
        }
        reservedSlots += 1;

        plans.push({
          taskId,
          parentWorkspaceId,
          parentMeta,
          agentId,
          agentType: task.agentType ?? agentId,
          start,
          title: task.title ?? workspaceName,
          workspaceName,
          createdAt,
          taskRuntimeConfig,
          parentRuntimeConfig,
          configProjectPath: normalizedTaskProjectPath,
          workspaceKind: task.kind,
          taskModelString: task.taskModelString ?? defaultModel,
          canonicalModel,
          effectiveThinkingLevel: task.taskThinkingLevel,
          // Durable pro-mode source: the task record's aiSettings (written at
          // creation, kept current by subsequent sends' persistence merge).
          effectiveReasoningMode: coerceOpenAIReasoningMode(task.aiSettings?.reasoningMode),
          skipInitHook,
          preferredTrunkBranch: task.taskTrunkBranch,
          workflowTask: task.workflowTask,
          bestOf: this.getEffectiveTaskGroup(taskId, task),
          experiments: task.taskExperiments,
        });
      }
    }

    await Promise.allSettled(
      plans.map(async (plan) => {
        try {
          await this.enqueueReservedTaskLaunch(plan);
        } catch (error: unknown) {
          log.error("Failed to launch dequeued task", { taskId: plan.taskId, error });
          await this.markTaskLaunchFailed(plan.taskId, getErrorMessage(error));
        }
      })
    );
  }

  private async enqueueReservedTaskLaunch(plan: TaskLaunchPlan): Promise<void> {
    assert(plan.taskId.length > 0, "enqueueReservedTaskLaunch requires taskId");
    await this.startReservedAgentTask(plan);
  }

  private async setTaskStatus(workspaceId: string, status: AgentTaskStatus): Promise<void> {
    assert(workspaceId.length > 0, "setTaskStatus: workspaceId must be non-empty");

    const update = (workspace: WorkspaceConfigEntry) => {
      workspace.taskStatus = status;
      if (status === "running") {
        workspace.taskPrompt = undefined;
      }
    };
    if (ACTIVE_AGENT_TASK_STATUSES.has(status)) {
      await this.editActiveWorkspaceEntry(workspaceId, update);
    } else {
      await this.editWorkspaceEntry(workspaceId, update);
    }

    await this.emitWorkspaceMetadata(workspaceId);

    if (status === "running") {
      const waiters = this.pendingStartWaitersByTaskId.get(workspaceId);
      if (!waiters || waiters.length === 0) return;
      this.pendingStartWaitersByTaskId.delete(workspaceId);
      for (const waiter of waiters) {
        try {
          waiter.start();
        } catch (error: unknown) {
          log.error("Task start waiter callback failed", { workspaceId, error });
        }
      }
    }
  }

  /**
   * Reset interrupt + auto-resume state for a workspace (called when user sends a real message).
   */
  resetAutoResumeCount(workspaceId: string): void {
    assert(workspaceId.length > 0, "resetAutoResumeCount: workspaceId must be non-empty");
    this.consecutiveAutoResumes.delete(workspaceId);
    this.interruptedParentWorkspaceIds.delete(workspaceId);
    // User-authored sends (and parent guidance, which does not skip this reset) count as fresh
    // attention: peer messages may wake this workspace again.
    this.agentPeerMessageBroker.resetConsecutivePeerWakes(workspaceId);
  }

  /** Mark a parent workspace as hard-interrupted by the user. */
  markParentWorkspaceInterrupted(workspaceId: string): void {
    assert(workspaceId.length > 0, "markParentWorkspaceInterrupted: workspaceId must be non-empty");
    this.consecutiveAutoResumes.delete(workspaceId);
    this.interruptedParentWorkspaceIds.add(workspaceId);
    // Latch the stop: the suppression entry above is level-triggered and cleared by resume, so
    // in-flight peer-send admission also needs the monotonic generation to observe the stop.
    this.bumpWorkspaceStopEpoch(workspaceId);
  }

  /**
   * Hold the stop-in-progress latch for a hard-interrupted workspace across the ENTIRE hard-stop
   * flow: the caller acquires it synchronously at the request boundary (before awaiting the
   * session interrupt) and releases it only after terminateAllDescendantAgentTasks persisted the
   * descendants' terminal statuses. markParentWorkspaceInterrupted's suppression entry is
   * level-triggered and cleared by the user's next real send, and the cascade's descendant-set
   * latch only exists after the session-interrupt await plus the cascade's mutex acquisition —
   * without this boundary latch, a still-running descendant could admit a peer send in those
   * windows (the ancestor's epoch was bumped BEFORE the send captured its baseline, so it reads
   * clean) and wake a cousin or the root after Stop. Latching the subtree root suffices: peer
   * admission checks the latch on every endpoint's ancestor chain, which contains this
   * workspace for all subtree members.
   */
  latchHardInterruptCascade(workspaceId: string): () => void {
    assert(workspaceId.length > 0, "latchHardInterruptCascade: workspaceId must be non-empty");
    return this.latchWorkspaceStopsInProgress([workspaceId]);
  }

  /**
   * If a preserved descendant task workspace was previously interrupted and the user manually
   * resumes it, restore taskStatus=running so stream-end finalization can proceed normally.
   * Shared-desktop reported tasks also need this durable reservation for direct sends that have
   * no workspace-turn handle. Their original binding is never inferred again on reawakening.
   *
   * Returns true only when a state transition happened.
   */
  async markInterruptedTaskRunning(workspaceId: string): Promise<boolean> {
    assert(workspaceId.length > 0, "markInterruptedTaskRunning: workspaceId must be non-empty");

    const configAtStart = this.config.loadConfigOrDefault();
    const entryAtStart = findWorkspaceEntry(configAtStart, workspaceId);
    if (!entryAtStart?.workspace.parentWorkspaceId) {
      return false;
    }
    if (
      entryAtStart.workspace.taskStatus !== "interrupted" &&
      !(
        entryAtStart.workspace.taskStatus === "reported" &&
        entryAtStart.workspace.taskDesktopOwnerWorkspaceId != null
      )
    ) {
      return false;
    }

    let transitionedToRunning = false;
    await this.editActiveWorkspaceEntry(
      workspaceId,
      (ws) => {
        // Only descendant task workspaces have task lifecycle status.
        if (!ws.parentWorkspaceId) {
          return;
        }
        if (
          ws.taskStatus !== "interrupted" &&
          !(ws.taskStatus === "reported" && ws.taskDesktopOwnerWorkspaceId != null)
        ) {
          return;
        }

        // Preserve taskPrompt here: interrupted queued tasks store their only initial
        // prompt in config. If send/resume fails, restoreInterruptedTaskAfterResumeFailure
        // must be able to retain that original prompt for inspection/retry.
        ws.taskStatus = "running";
        // A user-initiated resume is a fresh chance: clear the recovery budget so a
        // breaker-tripped task doesn't instantly re-fail on its first recovery prompt.
        delete ws.taskRecoveryAttempts;
        transitionedToRunning = true;
      },
      { allowMissing: true }
    );

    if (!transitionedToRunning) {
      return false;
    }

    await this.emitWorkspaceMetadata(workspaceId);
    return true;
  }

  /**
   * Revert a pre-stream interrupted->running transition when send/resume fails to start
   * or complete. This preserves fail-fast interrupted semantics for task_await.
   */
  async restoreInterruptedTaskAfterResumeFailure(
    workspaceId: string,
    previousStatus?: AgentTaskStatus | null
  ): Promise<void> {
    assert(
      workspaceId.length > 0,
      "restoreInterruptedTaskAfterResumeFailure: workspaceId must be non-empty"
    );

    let revertedToInterrupted = false;
    let parentWorkspaceId: string | undefined;
    await this.editWorkspaceEntry(
      workspaceId,
      (ws) => {
        if (!ws.parentWorkspaceId) {
          return;
        }
        if (ws.taskStatus !== "running") {
          return;
        }

        parentWorkspaceId = ws.parentWorkspaceId;
        ws.taskStatus = previousStatus === "reported" ? "reported" : "interrupted";
        if (previousStatus !== "reported") ws.reportedAt = undefined;
        revertedToInterrupted = true;
      },
      { allowMissing: true }
    );

    if (!revertedToInterrupted) {
      return;
    }

    this.recordTaskInterrupted(workspaceId, parentWorkspaceId);
    await this.emitWorkspaceMetadata(workspaceId);
  }

  private buildTaskCompletionRecoveryMessage(
    completionKind: "final_response" | "propose_plan",
    requiresStructuredOutput: boolean,
    options?: {
      reason?: "startup" | "stream_end" | "error";
      error?: Pick<ErrorEvent, "error" | "errorType">;
    }
  ): string {
    const completionLabel =
      completionKind === "propose_plan" ? "propose_plan" : "final assistant response";
    const completionInstruction = getTaskCompletionInstruction({
      completionKind,
      requiresStructuredOutput,
    });
    const noExtraWorkInstruction =
      completionKind === "propose_plan"
        ? "Do not continue planning or call other tools."
        : requiresStructuredOutput
          ? "Do not continue investigating or call tools other than agent_report."
          : "Do not continue investigating or call other tools.";

    switch (options?.reason) {
      case "startup":
        return `This task is awaiting its ${completionLabel}. ${noExtraWorkInstruction} ${completionInstruction}`;
      case "error": {
        const errorType = options.error?.errorType
          ? ` (last error: ${options.error.errorType})`
          : "";
        return `The previous ${completionLabel} attempt failed${errorType}. ${noExtraWorkInstruction} ${completionInstruction}`;
      }
      case "stream_end":
      default:
        return `Your stream ended without a ${completionLabel}. ${noExtraWorkInstruction} ${completionInstruction}`;
    }
  }

  private async promptTaskForRequiredCompletionTool(
    workspaceId: string,
    options?: {
      reason?: "startup" | "stream_end" | "error";
      error?: Pick<ErrorEvent, "error" | "errorType">;
    }
  ): Promise<boolean> {
    assert(
      workspaceId.length > 0,
      "promptTaskForRequiredCompletionTool: workspaceId must be non-empty"
    );

    const cfg = this.config.loadConfigOrDefault();
    const entry = findWorkspaceEntry(cfg, workspaceId);
    if (!entry?.workspace.parentWorkspaceId) {
      return false;
    }
    if (entry.workspace.taskStatus !== "awaiting_report") {
      return false;
    }
    const taskIndex = this.buildAgentTaskIndex(cfg);
    if (
      await this.interruptTaskRecoveryForInactiveWorkflowOwner(
        workspaceId,
        cfg,
        `completion-tool-${options?.reason ?? "unknown"}`,
        taskIndex
      )
    ) {
      return false;
    }
    if (await this.hasActiveTaskOwnedWork(workspaceId, taskIndex)) {
      return false;
    }
    if (this.aiService.isStreaming(workspaceId)) {
      return true;
    }

    const isPlanLike = await this.isPlanLikeTaskWorkspace(entry);
    const completionKind = isPlanLike ? "propose_plan" : "final_response";
    const requiresStructuredOutput =
      entry.workspace.workflowTask?.outputSchema !== undefined &&
      !(await this.shouldAllowLegacyInvalidWorkflowOutputSchema(workspaceId, entry));

    // Persisted circuit breaker: a task that keeps consuming recovery prompts
    // without ever completing is stuck (repeated empty output, repeated
    // length-truncated turns, or a model that never calls its completion
    // tool). Interrupt it with a descriptive error instead of prompting
    // forever. The counter lives on the workspace entry so restart loops stay
    // bounded too; finalizeAgentTaskReport clears it on success.
    const recoveryAttempts = entry.workspace.taskRecoveryAttempts ?? 0;
    if (recoveryAttempts >= MAX_TASK_RECOVERY_ATTEMPTS) {
      const lastError = options?.error
        ? ` Last error (${options.error.errorType ?? "unknown"}): ${options.error.error}`
        : "";
      log.error("Task exceeded its recovery attempt budget; interrupting task", {
        workspaceId,
        taskName: entry.workspace.name,
        recoveryAttempts,
        limit: MAX_TASK_RECOVERY_ATTEMPTS,
        reason: options?.reason,
      });
      await this.failAgentTaskTerminally(workspaceId, entry, {
        errorType: "task_recovery_limit",
        errorMessage: `Task interrupted after ${MAX_TASK_RECOVERY_ATTEMPTS} recovery attempts without a successful ${completionKind === "propose_plan" ? "propose_plan" : "final assistant response"}.${lastError} The task model may be unable to complete this request; try a different model or a simpler prompt.`,
      });
      return false;
    }
    // Consume budget before sending so a crash mid-send still counts the attempt.
    // Read the fresh value inside the mutator (not the entry-time snapshot above)
    // so concurrent edits cannot lose an increment.
    await this.editWorkspaceEntry(
      workspaceId,
      (ws) => {
        ws.taskRecoveryAttempts = (ws.taskRecoveryAttempts ?? 0) + 1;
      },
      { allowMissing: true }
    );

    const model = entry.workspace.taskModelString ?? defaultModel;
    const agentId = resolveTaskAgentIdForResume(entry.workspace);
    const startedAt = Date.now();
    const sendResult = await this.workspaceService.sendMessage(
      workspaceId,
      this.buildTaskCompletionRecoveryMessage(completionKind, requiresStructuredOutput, options),
      {
        model,
        agentId,
        thinkingLevel: entry.workspace.taskThinkingLevel,
        reasoningMode: coerceOpenAIReasoningMode(entry.workspace.aiSettings?.reasoningMode),
        experiments: entry.workspace.taskExperiments,
        ...(completionKind === "propose_plan"
          ? { toolPolicy: [{ regex_match: "^propose_plan$", action: "require" as const }] }
          : {}),
      },
      { synthetic: true, agentInitiated: true }
    );
    const durationMs = Date.now() - startedAt;
    if (!sendResult.success) {
      log.error("Failed to prompt task for required completion", {
        workspaceId,
        taskName: entry.workspace.name,
        projectPath: entry.projectPath,
        completionKind,
        reason: options?.reason,
        model,
        agentId,
        durationMs,
        sendError: sendResult.error,
        priorErrorType: options?.error?.errorType,
        priorError: options?.error?.error,
      });
      return false;
    }

    log.info("Prompted task for required completion", {
      workspaceId,
      taskName: entry.workspace.name,
      projectPath: entry.projectPath,
      completionKind,
      reason: options?.reason,
      model,
      agentId,
      durationMs,
    });
    return true;
  }

  private async promptTaskForBackgroundAwait(
    workspaceId: string,
    params: { taskIds: string[]; workflowRunIds: string[] }
  ): Promise<boolean> {
    assert(workspaceId.length > 0, "promptTaskForBackgroundAwait requires workspaceId");
    assert(
      params.taskIds.length > 0 || params.workflowRunIds.length > 0,
      "promptTaskForBackgroundAwait requires at least one awaitable target"
    );

    const cfg = this.config.loadConfigOrDefault();
    const entry = findWorkspaceEntry(cfg, workspaceId);
    if (!entry?.workspace.parentWorkspaceId) {
      return false;
    }

    const model = entry.workspace.taskModelString ?? defaultModel;
    const agentId = entry.workspace.agentId ?? TASK_RECOVERY_FALLBACK_AGENT_ID;
    const sendResult = await this.workspaceService.sendMessage(
      workspaceId,
      buildBackgroundAwaitPrompt(params),
      {
        model,
        agentId,
        thinkingLevel: entry.workspace.taskThinkingLevel,
        reasoningMode: coerceOpenAIReasoningMode(entry.workspace.aiSettings?.reasoningMode),
        experiments: entry.workspace.taskExperiments,
      },
      { synthetic: true, agentInitiated: true }
    );
    if (!sendResult.success) {
      log.error("Failed to prompt task for active background awaitables", {
        workspaceId,
        taskName: entry.workspace.name,
        taskIds: params.taskIds,
        workflowRunIds: params.workflowRunIds,
        model,
        agentId,
        error: sendResult.error,
      });
      return false;
    }
    return true;
  }

  private async handleStreamEnd(
    event: StreamEndEvent,
    // The production stream-end listener captures this synchronously at event
    // time, before waiting on the workspace event lock; the entry-time capture
    // below is a fallback for direct callers (tests) only.
    eventTimeQueueCutSnapshot?: QueueCutAttributionSnapshot
  ): Promise<void> {
    // Cut attribution must reflect the state at the ended stream's own event,
    // not whatever input engaged while the lock wait or the awaits below ran
    // (see QueueCutAttributionSnapshot).
    const queueCutSnapshot =
      eventTimeQueueCutSnapshot ??
      this.getWorkspaceTurnManager().captureQueueCutAttributionSnapshot(event.workspaceId);
    const isCompaction = event.metadata.agentId === "compact" || event.metadata.mode === "compact";
    // AgentSession resolves true only after a durable compaction follow-up is accepted. Bare,
    // rejected, and failed-to-dispatch compactions remain on the normal child recovery path.
    if (
      isCompaction &&
      (await this.workspaceService.waitForPendingCompactionCompletionDecision(
        event.workspaceId,
        event.messageId
      )) === true
    ) {
      return;
    }

    const workspaceId = event.workspaceId;

    // Ensure any in-flight notify_on_terminal persistence (from a just-detached foreground wait)
    // has settled so the config we read below reflects the durable non-blocking policy.
    if (this.pendingNotifyOnTerminalPersists.size > 0) {
      await Promise.all([...this.pendingNotifyOnTerminalPersists]);
    }

    // A parent response after a terminal report consumes that report's outbox entry. This also
    // closes the crash-recovery path where startup auto-retry finishes a response before the
    // terminal-attention drain gets a chance to resume it.
    await this.consumeRespondedAgentTerminalAttention(workspaceId);

    // The owner's own stream ending is the signal to retry any terminal wake-ups that were deferred
    // while it was busy. Drain checks idle internally and leaves notifications pending otherwise.
    this.scheduleTerminalAttentionDrain(workspaceId);

    const cfg = this.config.loadConfigOrDefault();
    const entry = findWorkspaceEntry(cfg, workspaceId);
    if (!entry) return;
    const taskIndex = this.buildAgentTaskIndex(cfg);

    // Parent workspaces must not end while they have active background tasks/workflows.
    // Enforce by auto-resuming the stream with a directive to await outstanding work.
    if (!entry.workspace.parentWorkspaceId) {
      const hasActiveDescendants = this.hasActiveDescendantAgentTasksUsingIndex(
        taskIndex,
        workspaceId
      );
      const referencedWorkflowRunIds = await this.listAgentReferencedWorkflowRunIds(
        workspaceId,
        event.parts,
        event.messageId
      );
      let activeWorkflowRunIds = await this.listActiveBackgroundWorkflowRunIds(
        workspaceId,
        referencedWorkflowRunIds
      );
      let activeWorkspaceTurnIds =
        await this.getWorkspaceTurnManager().listActiveWorkspaceTurnTaskIdsForOwner(workspaceId);
      if (!hasActiveDescendants) {
        // Foreground best-of children can finish while the parent task tool call is still pending,
        // which temporarily blocks their leaf cleanup and may defer synthetic fallback delivery.
        // Recheck both once the parent stream reaches a descendant-free stream-end.
        await this.deliverDeferredBestOfReportsForParent(workspaceId);
        await this.requestReportedChildCleanupRechecks(workspaceId);
        if (activeWorkflowRunIds.length === 0 && activeWorkspaceTurnIds.length === 0) {
          if (
            await this.getWorkspaceTurnManager().finalizeWorkspaceTurnFromStreamEnd(
              event,
              queueCutSnapshot
            )
          ) {
            return;
          }
          this.consecutiveAutoResumes.delete(workspaceId);
          return;
        }
      }

      // Workflow-owned descendants report through the workflow runner; parent nudges must not
      // bypass that journal/final-result path by asking the model to task_await those child tasks
      // directly. Instead, await the owning workflow run when one is still active.
      // Foreground waits can also be backgrounded at runtime when users queue another message.
      const listBlockingDescendantTaskIds = () =>
        this.listBlockingActiveDescendantAgentTaskIdsUsingIndex(taskIndex, workspaceId, {
          excludeWorkflowTasks: true,
        });
      let activeTaskIds = [...listBlockingDescendantTaskIds(), ...activeWorkspaceTurnIds];
      const queueBackgroundedTaskIds = new Set(
        activeTaskIds.filter((id) => this.isTaskQueueBackgrounded(id))
      );
      // Durable `notify_on_terminal` work is non-blocking: it never forces the parent to
      // task_await and is not consumed at stream-end. Agent-task policy is applied by
      // listBlockingDescendantTaskIds, which also suppresses descendants below a notify child;
      // workspace-turn policy comes from the handle record.
      const notifyOnTerminalTaskIds = new Set<string>();
      const blockingWorkspaceTurnIds = new Set(
        await this.getWorkspaceTurnManager().listBlockingWorkspaceTurnTaskIds(
          workspaceId,
          activeWorkspaceTurnIds
        )
      );
      for (const handleId of activeWorkspaceTurnIds) {
        if (!blockingWorkspaceTurnIds.has(handleId)) {
          notifyOnTerminalTaskIds.add(handleId);
        }
      }
      const getBlockingTaskIds = (taskIds: string[]) =>
        taskIds.filter(
          (id) => !queueBackgroundedTaskIds.has(id) && !notifyOnTerminalTaskIds.has(id)
        );
      // Only the queue-backgrounded one-shot exemption is consumed; durable notify policy stays.
      const consumeQueueBackgroundedExemptions = () => {
        for (const taskId of new Set([...activeTaskIds, ...queueBackgroundedTaskIds])) {
          this.markTaskForegroundRelevant(taskId);
        }
      };
      let blockingTaskIds = getBlockingTaskIds(activeTaskIds);
      activeWorkflowRunIds = await this.listBlockingWorkflowRunIds(
        workspaceId,
        activeWorkflowRunIds
      );

      if (blockingTaskIds.length === 0 && activeWorkflowRunIds.length === 0) {
        if (
          await this.getWorkspaceTurnManager().finalizeWorkspaceTurnFromStreamEnd(
            event,
            queueCutSnapshot
          )
        ) {
          return;
        }
        this.consecutiveAutoResumes.delete(workspaceId);
        consumeQueueBackgroundedExemptions();
        log.debug("Skipping parent auto-resume: all active descendants were queue-backgrounded", {
          workspaceId,
        });
        return;
      }

      await this.getWorkspaceTurnManager().markWorkspaceTurnStreamEndDeferred(event);

      if (this.aiService.isStreaming(workspaceId)) {
        return;
      }

      if (this.interruptedParentWorkspaceIds.has(workspaceId)) {
        log.debug("Skipping parent auto-resume after hard interrupt", { workspaceId });
        return;
      }

      // If the parent already has a follow-up turn queued or starting (for example, the user
      // interrupted with new context), do not inject a synthetic task_await warning mid-handoff.
      if (this.workspaceService.hasPendingQueuedOrPreparingTurn(workspaceId)) {
        consumeQueueBackgroundedExemptions();
        log.debug("Skipping parent auto-resume: follow-up turn already queued or preparing", {
          workspaceId,
        });
        return;
      }

      const resumeOptions = await this.resolveParentAutoResumeOptions(
        workspaceId,
        entry,
        defaultModel,
        event.metadata
      );

      activeWorkspaceTurnIds =
        await this.getWorkspaceTurnManager().listActiveWorkspaceTurnTaskIdsForOwner(workspaceId);
      activeTaskIds = [...listBlockingDescendantTaskIds(), ...activeWorkspaceTurnIds];
      blockingTaskIds = getBlockingTaskIds(activeTaskIds);
      activeWorkflowRunIds = await this.listBlockingWorkflowRunIds(
        workspaceId,
        await this.listActiveBackgroundWorkflowRunIds(workspaceId, activeWorkflowRunIds)
      );
      if (blockingTaskIds.length === 0 && activeWorkflowRunIds.length === 0) {
        if (
          await this.getWorkspaceTurnManager().finalizeWorkspaceTurnFromStreamEnd(
            event,
            queueCutSnapshot
          )
        ) {
          return;
        }
        this.consecutiveAutoResumes.delete(workspaceId);
        consumeQueueBackgroundedExemptions();
        return;
      }
      if (
        this.aiService.isStreaming(workspaceId) ||
        this.workspaceService.hasPendingQueuedOrPreparingTurn(workspaceId)
      ) {
        consumeQueueBackgroundedExemptions();
        log.debug("Skipping parent auto-resume: workspace is no longer idle", { workspaceId });
        return;
      }

      // Check for auto-resume flood protection after the final active-work recheck so stale
      // workflow completions do not consume the retry budget.
      const resumeCount = this.consecutiveAutoResumes.get(workspaceId) ?? 0;
      if (resumeCount >= MAX_CONSECUTIVE_PARENT_AUTO_RESUMES) {
        consumeQueueBackgroundedExemptions();
        log.warn("Auto-resume limit reached for parent workspace with active background work", {
          workspaceId,
          resumeCount,
          activeTaskIds: blockingTaskIds,
          activeWorkflowRunIds,
          limit: MAX_CONSECUTIVE_PARENT_AUTO_RESUMES,
        });
        return;
      }
      this.consecutiveAutoResumes.set(workspaceId, resumeCount + 1);

      const prompt = buildBackgroundAwaitPrompt({
        taskIds: blockingTaskIds,
        workflowRunIds: activeWorkflowRunIds,
      });
      const workspaceTurnMuxMetadata =
        this.getWorkspaceTurnManager().resolveWorkspaceTurnMuxMetadataForStreamEnd(event);
      const sendOptions = {
        model: resumeOptions.model,
        agentId: resumeOptions.agentId,
        thinkingLevel: resumeOptions.thinkingLevel,
        reasoningMode: resumeOptions.reasoningMode,
        ...(workspaceTurnMuxMetadata != null ? { muxMetadata: workspaceTurnMuxMetadata } : {}),
      };
      let sendResult = await this.workspaceService.sendMessage(
        workspaceId,
        prompt,
        sendOptions,
        // Skip auto-resume counter reset — this IS an auto-resume, not a user message.
        { skipAutoResumeReset: true, synthetic: true, agentInitiated: true, requireIdle: true }
      );
      if (!sendResult.success && isWorkspaceBusyIdleOnlySend(sendResult.error)) {
        activeWorkspaceTurnIds =
          await this.getWorkspaceTurnManager().listActiveWorkspaceTurnTaskIdsForOwner(workspaceId);
        activeTaskIds = [...listBlockingDescendantTaskIds(), ...activeWorkspaceTurnIds];
        blockingTaskIds = getBlockingTaskIds(activeTaskIds);
        activeWorkflowRunIds = await this.listBlockingWorkflowRunIds(
          workspaceId,
          await this.listActiveBackgroundWorkflowRunIds(workspaceId, activeWorkflowRunIds)
        );
        if (blockingTaskIds.length === 0 && activeWorkflowRunIds.length === 0) {
          if (
            await this.getWorkspaceTurnManager().finalizeWorkspaceTurnFromStreamEnd(
              event,
              queueCutSnapshot
            )
          ) {
            return;
          }
          this.consecutiveAutoResumes.delete(workspaceId);
          consumeQueueBackgroundedExemptions();
          return;
        }
        if (
          this.aiService.isStreaming(workspaceId) ||
          this.workspaceService.hasPendingQueuedOrPreparingTurn(workspaceId)
        ) {
          if (resumeCount === 0) {
            this.consecutiveAutoResumes.delete(workspaceId);
          } else {
            this.consecutiveAutoResumes.set(workspaceId, resumeCount);
          }
          consumeQueueBackgroundedExemptions();
          log.debug("Skipping parent auto-resume fallback: workspace is no longer idle", {
            workspaceId,
          });
          return;
        }

        // AgentSession can still be in COMPLETING when StreamManager has emitted stream-end.
        // Queue this nudge rather than dropping the only await prompt for active background work.
        sendResult = await this.workspaceService.sendMessage(
          workspaceId,
          buildBackgroundAwaitPrompt({
            taskIds: blockingTaskIds,
            workflowRunIds: activeWorkflowRunIds,
          }),
          sendOptions,
          {
            skipAutoResumeReset: true,
            synthetic: true,
            agentInitiated: true,
          }
        );
      }
      consumeQueueBackgroundedExemptions();
      if (!sendResult.success) {
        if (resumeCount === 0) {
          this.consecutiveAutoResumes.delete(workspaceId);
        } else {
          this.consecutiveAutoResumes.set(workspaceId, resumeCount);
        }
        log.error("Failed to resume parent with active background work", {
          workspaceId,
          error: sendResult.error,
        });
      }
      return;
    }

    if (
      await this.getWorkspaceTurnManager().finalizeWorkspaceTurnFromStreamEnd(
        event,
        queueCutSnapshot
      )
    ) {
      return;
    }

    const status = entry.workspace.taskStatus;
    const workflowOutputSchema = entry.workspace.workflowTask?.outputSchema;
    const acceptsSchemaShapedWorkflowReport =
      workflowOutputSchema !== undefined &&
      validateJsonSchemaSubsetSchema(workflowOutputSchema, { requireObjectSchema: true }).success;
    // Missing finish reasons are not proof of a clean stop: providers may omit them and metadata
    // collection may time out. Only explicit `stop` can promote the final assistant response to the
    // terminal report; otherwise recovery asks the child to finish instead of finalizing an update.
    const finalAgentReportArgs =
      !isCompaction && event.metadata.finishReason === "stop"
        ? await this.resolveFinalAgentReportArgs(workspaceId, event.parts, {
            acceptSchemaShapedWorkflowReport: acceptsSchemaShapedWorkflowReport,
          })
        : null;
    const isPlanLike = await this.isPlanLikeTaskWorkspace(entry);
    const reportArgs = isPlanLike ? null : finalAgentReportArgs;
    const proposePlanResult = this.findProposePlanSuccessInParts(event.parts);

    // Stream-end settlement: interrupted tasks must settle all pending waiters.
    // A workflow-owned plan step that successfully called propose_plan is already complete,
    // even if the interruption status landed before the provider emitted stream-end.
    if (status === "interrupted") {
      if (isPlanLike && proposePlanResult && entry.workspace.workflowTask != null) {
        await this.handleSuccessfulWorkflowProposePlan({ workspaceId, entry, proposePlanResult });
        return;
      }
      await this.settleInterruptedTaskAtStreamEnd(workspaceId, entry, reportArgs);
      return;
    }
    if (status === "reported") {
      await this.finalizeTerminationPhaseForReportedTask(workspaceId);
      return;
    }

    if (
      reportArgs == null &&
      !(isPlanLike && proposePlanResult && entry.workspace.workflowTask != null) &&
      (await this.interruptTaskRecoveryForInactiveWorkflowOwner(
        workspaceId,
        cfg,
        "stream-end",
        taskIndex
      ))
    ) {
      return;
    }

    const activeDescendantTaskIds = this.listActiveDescendantAgentTaskIds(workspaceId);
    const blockingDescendantTaskIds = this.listBlockingActiveDescendantAgentTaskIdsUsingIndex(
      taskIndex,
      workspaceId
    );
    if (blockingDescendantTaskIds.length > 0) {
      if (status === "awaiting_report") {
        await this.setTaskStatus(workspaceId, "running");
      }
      return;
    }

    const taskReferencedWorkflowRunIds = await this.listAgentReferencedWorkflowRunIds(
      workspaceId,
      event.parts,
      event.messageId
    );
    const activeTaskWorkflowRunIds = await this.listActiveBackgroundWorkflowRunIds(
      workspaceId,
      taskReferencedWorkflowRunIds
    );
    const blockingTaskWorkflowRunIds = await this.listBlockingBackgroundWorkflowRunIds(
      workspaceId,
      taskReferencedWorkflowRunIds,
      event.parts
    );
    const activeWorkspaceTurnIds =
      await this.getWorkspaceTurnManager().listActiveWorkspaceTurnTaskIdsForOwner(workspaceId);
    const blockingWorkspaceTurnIds =
      await this.getWorkspaceTurnManager().listBlockingWorkspaceTurnTaskIds(
        workspaceId,
        activeWorkspaceTurnIds
      );
    if (blockingTaskWorkflowRunIds.length > 0 || blockingWorkspaceTurnIds.length > 0) {
      if (status === "awaiting_report") {
        await this.setTaskStatus(workspaceId, "running");
      }
      await this.promptTaskForBackgroundAwait(workspaceId, {
        taskIds: blockingWorkspaceTurnIds,
        workflowRunIds: blockingTaskWorkflowRunIds,
      });
      return;
    }

    // Non-blocking background children should not force task_await, but a child task's final
    // agent_report must wait for them so the original parent does not receive an incomplete report.
    if (
      activeDescendantTaskIds.length > 0 ||
      activeTaskWorkflowRunIds.length > 0 ||
      activeWorkspaceTurnIds.length > 0
    ) {
      if (status === "awaiting_report") {
        await this.setTaskStatus(workspaceId, "running");
      }
      return;
    }

    // Parent corrections queued for the next task turn supersede any report emitted by the old
    // turn. Keep the task active until AgentSession accepts the reserved guidance and clears this
    // durable flag; otherwise turn-end dispatch could deliver a stale report before the correction.
    if ((entry.workspace.taskPendingGuidance?.length ?? 0) > 0) {
      return;
    }

    if (reportArgs) {
      const finalization = await this.finalizeAgentTaskReport(workspaceId, entry, reportArgs);
      if (finalization.finalized) {
        await this.finalizeTerminationPhaseForReportedTask(workspaceId);
      }
      return;
    }

    if (isPlanLike && proposePlanResult) {
      if (entry.workspace.workflowTask != null) {
        await this.handleSuccessfulWorkflowProposePlan({ workspaceId, entry, proposePlanResult });
        return;
      }
      await this.handleSuccessfulProposePlanAutoHandoff({
        workspaceId,
        entry,
        proposePlanResult,
      });
      return;
    }

    if (status !== "awaiting_report") {
      await this.setTaskStatus(workspaceId, "awaiting_report");
    }

    await this.promptTaskForRequiredCompletionTool(workspaceId, { reason: "stream_end" });
  }

  private async handleStreamAbort(event: StreamAbortEvent): Promise<void> {
    // Settles a continuation handle (execution mirror) first. A reawakened child is ALSO
    // `running` in its stable status (markInterruptedTaskRunning), and the desktop ledger treats
    // either active source as control, so the stable status must be released independently.
    await this.getWorkspaceTurnManager().finalizeWorkspaceTurnFromStreamAbort(event);
    if (event.abortReason === "user") {
      await this.releaseSharedDesktopTaskOnUserStop(event.workspaceId);
    }
  }

  /**
   * A user Stop on an ordinary child is a steerable pause: the task stays `running` so the
   * user can resume it. A shared-desktop child, however, holds the owner's desktop through that
   * `running` status (the config ledger is the only ownership source), so a paused child would
   * block the owner indefinitely — a wait timeout must never release a still-active child, only
   * an explicit stop may. Mirror task_stop instead: the durable `interrupted` status releases the
   * desktop and fails the parent's wait fast, while a user resume re-admits the child onto the
   * same desktop via markInterruptedTaskRunning.
   */
  private async releaseSharedDesktopTaskOnUserStop(workspaceId: string): Promise<void> {
    // Cheap bound only; every release decision below is re-evaluated inside the serialized edit.
    const workspace = findWorkspaceEntry(this.config.loadConfigOrDefault(), workspaceId)?.workspace;
    if (workspace?.parentWorkspaceId == null || workspace.taskDesktopOwnerWorkspaceId == null) {
      return;
    }
    let transitionedToInterrupted = false;
    let parentWorkspaceId: string | undefined;
    await this.editWorkspaceEntry(
      workspaceId,
      (ws) => {
        if (ws.taskDesktopOwnerWorkspaceId == null) return;
        if (ws.taskStatus !== "running" && ws.taskStatus !== "awaiting_report") return;
        // Evaluated against the fresh config inside the FIFO config edit: a successor that
        // claimed the execution mirror, queued a turn, or started streaming while this edit
        // waited in the queue keeps the desktop (stop-and-send-queued, newer continuation). A
        // preflight-only check would let this stale abort clear that successor.
        if (
          this.aiService.isStreaming(workspaceId) ||
          this.workspaceService.hasPendingQueuedOrPreparingTurn(workspaceId) ||
          isActiveWorkspaceTurnTaskStatus(ws.taskExecutionStatus)
        ) {
          return;
        }
        parentWorkspaceId = ws.parentWorkspaceId;
        transitionedToInterrupted = this.applyInterruptedTaskStatus(ws) === "interrupted";
      },
      { allowMissing: true }
    );
    if (!transitionedToInterrupted) {
      return;
    }
    this.recordTaskInterrupted(workspaceId, parentWorkspaceId);
    this.rejectWaiters(workspaceId, new Error("Task interrupted"));
    await this.emitWorkspaceMetadata(workspaceId);
    this.scheduleMaybeStartQueuedTasks();
  }

  private async handleTaskStreamError(event: ErrorEvent): Promise<void> {
    if (await this.getWorkspaceTurnManager().finalizeWorkspaceTurnFromStreamError(event)) {
      return;
    }
    const workspaceId = event.workspaceId;
    const cfg = this.config.loadConfigOrDefault();
    const entry = findWorkspaceEntry(cfg, workspaceId);
    if (!entry?.workspace.parentWorkspaceId) {
      return;
    }

    const status = entry.workspace.taskStatus;
    // Stream errors only need settlement handling while the task is mid-run
    // (running) or waiting on its completion tool (awaiting_report).
    if (status !== "running" && status !== "awaiting_report") {
      return;
    }
    const taskIndex = this.buildAgentTaskIndex(cfg);

    if (
      await this.interruptTaskRecoveryForInactiveWorkflowOwner(
        workspaceId,
        cfg,
        "stream-error",
        taskIndex
      )
    ) {
      return;
    }

    if (await this.hasActiveTaskOwnedWork(workspaceId, taskIndex)) {
      return;
    }

    const isNonRetryable =
      event.errorType != null && isNonRetryableStreamError({ type: event.errorType });

    // Terminal provider outcomes (e.g. model_refusal) settle the task even during its
    // first `running` turn — previously only awaiting_report settled, leaving the
    // parent's waitForAgentReport to block until timeout. Deliberately an allow-list
    // rather than "all non-retryable":
    // - `aborted` is a steerable user pause, not a terminal failure.
    // - `context_exceeded` has in-session recovery (compaction retry, post-compaction
    //   retry in AgentSession.handleStreamError) listening on the same error event;
    //   it settles below only after that recovery declines.
    const settlesRunningTask =
      event.errorType != null && RUNNING_TASK_TERMINAL_STREAM_ERRORS.has(event.errorType);

    if (isNonRetryable && (status === "awaiting_report" || settlesRunningTask)) {
      log.error("Task hit a non-retryable stream error; interrupting task", {
        workspaceId,
        taskStatus: status,
        errorType: event.errorType,
        error: event.error,
      });
      await this.failAgentTaskTerminally(workspaceId, entry, {
        errorType: event.errorType ?? "unknown",
        errorMessage: event.error,
      });
      return;
    }

    if (status === "running" && event.errorType === "context_exceeded") {
      // Wait for AgentSession.handleStreamError's recovery decision instead of
      // racing it. When no retry started, the turn failed terminally without a
      // later stream-end, so leaving the task `running` would block the
      // parent's waitForAgentReport until timeout.
      //
      // Act on the recorded per-attempt outcome, not live phase flags: a fast
      // successful retry can start AND finish before this handler (queued
      // behind the workspace event lock) gets here, so sampling isStreaming
      // would misread a successful recovery as declined. "retry-started"
      // means this attempt's recovery completed stream startup; that retry's
      // own stream events (including a possible follow-up error event, which
      // gets its own decision) settle the task later. "terminal" means the
      // error settled with no retry. Queued messages must NOT count as
      // recovery — the terminal error path does not dispatch the queue, so an
      // unrelated queued message would otherwise leave the task running
      // forever.
      const recoveryOutcome = await this.workspaceService.waitForPendingStreamErrorRecoveryDecision(
        workspaceId,
        event.messageId
      );
      if (recoveryOutcome === "retry-started") {
        return;
      }
      // No recorded decision means the session is gone or was recreated
      // (e.g. restart recovery); a live stream then belongs to a real
      // continuing turn, so leave settlement to its stream events.
      if (recoveryOutcome === undefined && this.aiService.isStreaming(workspaceId)) {
        return;
      }
      log.error("Task hit context_exceeded and in-session recovery declined; interrupting task", {
        workspaceId,
        error: event.error,
      });
      await this.failAgentTaskTerminally(workspaceId, entry, {
        errorType: event.errorType,
        errorMessage: event.error,
      });
      return;
    }

    if (status !== "awaiting_report") {
      // Retryable errors during `running` are handled by the agent session's
      // retry loop; TaskService only intervenes once the task owes its report.
      return;
    }

    log.warn(
      "Task awaiting required completion tool hit a stream error; retrying report-only recovery",
      {
        workspaceId,
        errorType: event.errorType,
        error: event.error,
      }
    );

    await this.promptTaskForRequiredCompletionTool(workspaceId, {
      reason: "error",
      error: event,
    });
  }

  /**
   * Terminal settlement for a child task whose stream failed with a
   * non-retryable error: mark interrupted with a descriptive launch error,
   * persist a durable failure artifact in every ancestor session dir (so
   * background children, restarts, and post-cleanup task_awaits observe the
   * typed failure), then reject pending waiters with the failure message.
   */
  private async failAgentTaskTerminally(
    workspaceId: string,
    entry: { projectPath: string; workspace: WorkspaceConfigEntry },
    failure: { errorType: string; errorMessage: string }
  ): Promise<void> {
    assert(workspaceId.length > 0, "failAgentTaskTerminally: workspaceId must be non-empty");
    assert(
      failure.errorMessage.length > 0,
      "failAgentTaskTerminally: errorMessage must be non-empty"
    );

    let transitionedToInterrupted = false;
    let parentWorkspaceId = entry.workspace.parentWorkspaceId;
    await this.editWorkspaceEntry(
      workspaceId,
      (ws) => {
        transitionedToInterrupted = ws.taskStatus !== "interrupted";
        parentWorkspaceId = ws.parentWorkspaceId;
        ws.taskStatus = "interrupted";
        ws.taskLaunchError = failure.errorMessage;
      },
      { allowMissing: true }
    );
    if (transitionedToInterrupted) {
      this.recordTaskInterrupted(workspaceId, parentWorkspaceId);
    }
    await this.emitWorkspaceMetadata(workspaceId);

    if (parentWorkspaceId) {
      const cfg = this.config.loadConfigOrDefault();
      const index = this.buildAgentTaskIndex(cfg);
      const ancestorWorkspaceIds = this.listAncestorWorkspaceIdsUsingParentById(
        index.parentById,
        workspaceId
      );
      const workflowOwnedAncestorWorkspaceIds = ancestorWorkspaceIds.filter(
        (ancestorWorkspaceId) =>
          this.getWorkflowOwnedDescendantAgentTaskUsingIndex(
            index,
            ancestorWorkspaceId,
            workspaceId
          ) === true
      );

      const persistedAtMs = Date.now();
      for (const ancestorWorkspaceId of ancestorWorkspaceIds) {
        try {
          await upsertSubagentFailureArtifact({
            workspaceId: ancestorWorkspaceId,
            workspaceSessionDir: path.join(this.config.sessionsDir, ancestorWorkspaceId),
            childTaskId: workspaceId,
            parentWorkspaceId,
            ancestorWorkspaceIds,
            workflowOwnedAncestorWorkspaceIds,
            errorType: failure.errorType,
            errorMessage: failure.errorMessage,
            model: entry.workspace.taskModelString,
            nowMs: persistedAtMs,
          });
        } catch (error: unknown) {
          log.error("Failed to persist subagent failure artifact", {
            workspaceId: ancestorWorkspaceId,
            childTaskId: workspaceId,
            error,
          });
        }
      }
    }

    // Captured before settlement: rejectWaiters consumes the pending waiters
    // that prove a parent turn is actively listening for this task.
    const hadForegroundWaiters = (this.pendingWaitersByTaskId.get(workspaceId)?.length ?? 0) > 0;

    await this.settleInterruptedTaskAtStreamEnd(workspaceId, entry, null, {
      rejectionError: new Error(failure.errorMessage),
    });

    // Free this task's concurrency slot for queued siblings.
    this.scheduleMaybeStartQueuedTasks();

    await this.maybeResumeParentAfterTerminalChildFailure(
      workspaceId,
      entry,
      failure,
      hadForegroundWaiters
    );
  }

  /**
   * Background-spawned children may have no pending waiter to reject, and the
   * parent stream typically already returned early because the child was still
   * active. The report path delivers into the parent context and wakes idle
   * parents (deliverReportToParent + post-report auto-resume), so terminal
   * failures must too — otherwise an idle parent stays at taskStatus "running"
   * until a timeout or manual task_await, or worse: a later sibling's report
   * wakes it and the fanout looks fully successful. Two mirrored halves:
   *
   * 1. Always append a synthetic mux_subagent_failure message to the parent
   *    history (the durable context delivery — survives any wake-up ordering).
   * 2. Auto-resume the parent only when this was the last active child and the
   *    parent is idle (same gates as the post-report auto-resume).
   */
  private async maybeResumeParentAfterTerminalChildFailure(
    childWorkspaceId: string,
    childEntry: { projectPath: string; workspace: WorkspaceConfigEntry },
    failure: { errorType: string; errorMessage: string },
    hadForegroundWaiters: boolean
  ): Promise<void> {
    const parentWorkspaceId = childEntry.workspace.parentWorkspaceId;
    if (!parentWorkspaceId) {
      return;
    }
    // An active waiter (foreground task tool call or task_await) already
    // surfaced the rejection to the parent's in-flight turn.
    if (hadForegroundWaiters) {
      this.scheduleTerminalAttentionDrain(parentWorkspaceId);
      return;
    }
    // Workflow-owned children propagate failures through the WorkflowRunner
    // step result; do not also resume the parent from a child-level failure row.
    if (childEntry.workspace.workflowTask != null) {
      return;
    }

    const cfg = this.config.loadConfigOrDefault();
    const parentEntry = findWorkspaceEntry(cfg, parentWorkspaceId);
    if (!parentEntry) {
      return;
    }

    // Durable context delivery, mirroring deliverReportToParent's synthetic
    // append: the failure must be visible to the parent's next turn regardless
    // of whether this settlement resumes it or a later sibling report/failure does.
    const failureMessage = createMuxMessage(
      createTaskFailureMessageId(),
      "user",
      formatSubagentFailureUserMessage({
        childWorkspaceId,
        agentType: coerceNonEmptyString(childEntry.workspace.agentType) ?? "agent",
        errorType: failure.errorType,
        errorMessage: failure.errorMessage,
      }),
      { timestamp: Date.now(), synthetic: true, uiVisible: true }
    );
    const appendResult = await this.historyService.appendToHistory(
      parentWorkspaceId,
      failureMessage
    );
    if (appendResult.success) {
      this.workspaceService.emitChatEvent(parentWorkspaceId, {
        ...failureMessage,
        type: "message",
      });
    }
    if (!appendResult.success) {
      log.error("Failed to append synthetic subagent failure to parent history", {
        parentWorkspaceId,
        childWorkspaceId,
        error: appendResult.error,
      });
    }

    const hasActiveDescendants = this.hasActiveDescendantAgentTasks(cfg, parentWorkspaceId);
    if (!hasActiveDescendants) {
      this.consecutiveAutoResumes.delete(parentWorkspaceId);
    }
    if (this.interruptedParentWorkspaceIds.has(parentWorkspaceId)) {
      log.debug("Skipping terminal-failure parent auto-resume after hard interrupt", {
        parentWorkspaceId,
        childWorkspaceId,
      });
      return;
    }
    // The failure message is already injected above. Enqueue even when other children are active:
    // the drain defers on blocking work, and the later settling child may have a foreground waiter
    // that suppresses its own terminal wake-up.
    const generationId = await this.getAgentTerminalAttentionGenerationId(
      parentWorkspaceId,
      childWorkspaceId
    );
    await this.enqueueTerminalAttention({
      ownerWorkspaceId: parentWorkspaceId,
      sourceKind: "agent_task",
      terminalOutcome: "failed",
      sourceId: childWorkspaceId,
      ...(generationId != null ? { generationId } : {}),
    });
  }

  /**
   * Stream-end settlement for interrupted tasks. Guarantees every pending waiter
   * is settled exactly once: resolved if an agent_report exists, rejected otherwise.
   * No waiter should depend on timeout to discover terminal interruption.
   */
  private async settleInterruptedTaskAtStreamEnd(
    workspaceId: string,
    entry: { projectPath: string; workspace: WorkspaceConfigEntry },
    reportArgs: {
      reportMarkdown: string;
      title?: string;
      structuredOutput?: unknown;
      planFilePath?: string;
    } | null,
    options?: { rejectionError?: Error }
  ): Promise<void> {
    if (reportArgs) {
      const finalization = await this.finalizeAgentTaskReport(workspaceId, entry, reportArgs);
      if (!finalization.finalized) {
        this.rejectWaiters(workspaceId, new Error(finalization.message));
      }
      return;
    }

    this.rejectWaiters(workspaceId, options?.rejectionError ?? new Error("Task interrupted"));

    const parentWorkspaceId = entry.workspace.parentWorkspaceId;
    const bestOf = this.getEffectiveTaskGroup(workspaceId, entry.workspace);
    if (
      parentWorkspaceId &&
      bestOf?.total != null &&
      bestOf.total > 1 &&
      !this.aiService.isStreaming(parentWorkspaceId)
    ) {
      await this.deliverDeferredBestOfSiblingReports({
        parentWorkspaceId,
        groupId: bestOf.groupId,
        total: bestOf.total,
      });
    }
  }

  private async handleSuccessfulWorkflowProposePlan(args: {
    workspaceId: string;
    entry: { projectPath: string; workspace: WorkspaceConfigEntry };
    proposePlanResult: { planPath: string };
  }): Promise<void> {
    assert(
      args.workspaceId.length > 0,
      "handleSuccessfulWorkflowProposePlan: workspaceId must be non-empty"
    );
    assert(
      args.proposePlanResult.planPath.length > 0,
      "handleSuccessfulWorkflowProposePlan: planPath must be non-empty"
    );

    if (args.entry.workspace.workflowTask?.outputSchema !== undefined) {
      const error = new Error(
        "Workflow plan agents return { reportMarkdown, planFilePath }; do not provide schema/outputSchema."
      );
      let transitionedToInterrupted = false;
      let parentWorkspaceId = args.entry.workspace.parentWorkspaceId;
      await this.editWorkspaceEntry(
        args.workspaceId,
        (workspace) => {
          transitionedToInterrupted = workspace.taskStatus !== "interrupted";
          parentWorkspaceId = workspace.parentWorkspaceId;
          workspace.taskStatus = "interrupted";
          workspace.taskLaunchError = error.message;
        },
        { allowMissing: true }
      );
      if (transitionedToInterrupted) {
        this.recordTaskInterrupted(args.workspaceId, parentWorkspaceId);
      }
      this.rejectWaiters(args.workspaceId, error);
      await this.emitWorkspaceMetadata(args.workspaceId);
      return;
    }

    let planSummary: { content: string; path: string } | null = null;
    try {
      const info = await this.workspaceService.getInfo(args.workspaceId);
      if (!info) {
        log.error("Workflow plan completion could not read workspace metadata", {
          workspaceId: args.workspaceId,
        });
      } else {
        const runtime = createRuntimeForWorkspace(info);
        const planResult = await readPlanFile(
          runtime,
          info.name,
          info.projectName,
          args.workspaceId
        );
        if (planResult.exists && planResult.content.trim().length > 0) {
          if (planResult.path !== args.proposePlanResult.planPath) {
            log.debug("Workflow plan completion using canonical plan file path", {
              workspaceId: args.workspaceId,
              proposedPlanPath: args.proposePlanResult.planPath,
              canonicalPlanPath: planResult.path,
            });
          }
          planSummary = { content: planResult.content, path: planResult.path };
        } else {
          log.error("Workflow plan completion did not find non-empty plan file content", {
            workspaceId: args.workspaceId,
            planPath: args.proposePlanResult.planPath,
            canonicalPlanPath: planResult.path,
          });
        }
      }
    } catch (error: unknown) {
      log.error("Workflow plan completion failed to read plan file", {
        workspaceId: args.workspaceId,
        planPath: args.proposePlanResult.planPath,
        error,
      });
    }

    if (planSummary == null) {
      await this.editActiveWorkspaceEntry(
        args.workspaceId,
        (workspace) => {
          workspace.taskStatus = "awaiting_report";
          workspace.reportedAt = undefined;
        },
        { allowMissing: true }
      );
      await this.emitWorkspaceMetadata(args.workspaceId);
      await this.promptTaskForRequiredCompletionTool(args.workspaceId, { reason: "stream_end" });
      return;
    }

    const finalization = await this.finalizeAgentTaskReport(args.workspaceId, args.entry, {
      reportMarkdown: planSummary.content,
      title: "Proposed plan",
      planFilePath: planSummary.path,
    });
    if (finalization.finalized) {
      await this.finalizeTerminationPhaseForReportedTask(args.workspaceId);
    } else {
      this.rejectWaiters(args.workspaceId, new Error(finalization.message));
    }
  }

  private async handleSuccessfulProposePlanAutoHandoff(args: {
    workspaceId: string;
    entry: { projectPath: string; workspace: WorkspaceConfigEntry };
    proposePlanResult: { planPath: string };
  }): Promise<void> {
    assert(
      args.workspaceId.length > 0,
      "handleSuccessfulProposePlanAutoHandoff: workspaceId must be non-empty"
    );
    assert(
      args.proposePlanResult.planPath.length > 0,
      "handleSuccessfulProposePlanAutoHandoff: planPath must be non-empty"
    );

    if (this.handoffInProgress.has(args.workspaceId)) {
      log.debug("Skipping duplicate plan-task auto-handoff", { workspaceId: args.workspaceId });
      return;
    }

    this.handoffInProgress.add(args.workspaceId);

    try {
      let planSummary: { content: string; path: string } | null = null;

      try {
        const info = await this.workspaceService.getInfo(args.workspaceId);
        if (!info) {
          log.error("Plan-task auto-handoff could not read workspace metadata", {
            workspaceId: args.workspaceId,
          });
        } else {
          const runtime = createRuntimeForWorkspace(info);
          const planResult = await readPlanFile(
            runtime,
            info.name,
            info.projectName,
            args.workspaceId
          );
          if (planResult.exists) {
            planSummary = { content: planResult.content, path: planResult.path };
          } else {
            log.error("Plan-task auto-handoff did not find plan file content", {
              workspaceId: args.workspaceId,
              planPath: args.proposePlanResult.planPath,
            });
          }
        }
      } catch (error: unknown) {
        log.error("Plan-task auto-handoff failed to read plan file", {
          workspaceId: args.workspaceId,
          planPath: args.proposePlanResult.planPath,
          error,
        });
      }

      const targetAgentId = "exec" as const;

      const summaryContent = planSummary
        ? `# Plan\n\n${planSummary.content}\n\nNote: This chat already contains the full plan; no need to re-open the plan file.\n\n---\n\n*Plan file preserved at:* \`${planSummary.path}\``
        : `A plan was proposed at ${args.proposePlanResult.planPath}. Read the plan file and implement it.`;

      const summaryMessage = createMuxMessage(
        createCompactionSummaryMessageId(),
        "assistant",
        summaryContent,
        {
          timestamp: Date.now(),
          compacted: "user",
          agentId: "plan",
        }
      );

      const replaceHistoryResult = await this.workspaceService.replaceHistory(
        args.workspaceId,
        summaryMessage,
        {
          mode: "append-compaction-boundary",
          deletePlanFile: false,
        }
      );
      if (!replaceHistoryResult.success) {
        log.error("Plan-task auto-handoff failed to compact history", {
          workspaceId: args.workspaceId,
          error: replaceHistoryResult.error,
        });
      }

      // Resolve a new Exec phase from this workspace, not its parent. A Plan-only
      // PRO preference still falls through via the existing workspace fallback.
      const { taskModelString, canonicalModel, effectiveThinkingLevel, effectiveReasoningMode } =
        await this.resolveTaskAISettings({
          cfg: this.config.loadConfigOrDefault(),
          parentWorkspaceId: args.workspaceId,
          parentMeta: args.entry.workspace,
          agentId: targetAgentId,
          parentRuntimeAiSettings: {
            modelString: args.entry.workspace.taskModelString,
            thinkingLevel: args.entry.workspace.taskThinkingLevel,
          },
        });

      await this.editWorkspaceEntry(args.workspaceId, (workspace) => {
        workspace.agentId = targetAgentId;
        workspace.agentType = targetAgentId;
        workspace.aiSettings = {
          model: canonicalModel,
          thinkingLevel: effectiveThinkingLevel,
          ...(effectiveReasoningMode != null ? { reasoningMode: effectiveReasoningMode } : {}),
        };
        workspace.taskModelString = taskModelString;
        workspace.taskThinkingLevel = effectiveThinkingLevel;
        // A successful propose_plan is a successful completion-tool outcome: the
        // exec phase starts with a fresh recovery budget rather than inheriting
        // whatever the plan phase consumed.
        delete workspace.taskRecoveryAttempts;
      });

      await this.setTaskStatus(args.workspaceId, "running");

      try {
        const sendKickoffResult = await this.workspaceService.sendMessage(
          args.workspaceId,
          "Implement the plan.",
          {
            model: taskModelString,
            agentId: targetAgentId,
            thinkingLevel: effectiveThinkingLevel,
            ...(effectiveReasoningMode != null ? { reasoningMode: effectiveReasoningMode } : {}),
            experiments: args.entry.workspace.taskExperiments,
          },
          { synthetic: true, agentInitiated: true }
        );
        if (!sendKickoffResult.success) {
          // Keep status as "running" so the restart handler in initialize() can
          // re-attempt the kickoff on next startup, rather than moving to
          // "awaiting_report" which could finalize the task prematurely.
          log.error(
            "Plan-task auto-handoff failed to send kickoff message; task stays running for retry on restart",
            {
              workspaceId: args.workspaceId,
              targetAgentId,
              error: sendKickoffResult.error,
            }
          );
        }
      } catch (error: unknown) {
        // Same as above: leave status as "running" for restart recovery.
        log.error(
          "Plan-task auto-handoff failed to send kickoff message; task stays running for retry on restart",
          {
            workspaceId: args.workspaceId,
            targetAgentId,
            error,
          }
        );
      }
    } catch (error: unknown) {
      log.error("Plan-task auto-handoff failed", {
        workspaceId: args.workspaceId,
        planPath: args.proposePlanResult.planPath,
        error,
      });
    } finally {
      this.handoffInProgress.delete(args.workspaceId);
    }
  }

  private async finalizeTerminationPhaseForReportedTask(workspaceId: string): Promise<void> {
    assert(
      workspaceId.length > 0,
      "finalizeTerminationPhaseForReportedTask: workspaceId must be non-empty"
    );

    await this.cleanupReportedLeafTask(workspaceId);
  }

  async maybeStartPatchGenerationForReportedTask(
    workspaceId: string,
    options?: { refreshForContinuation?: boolean }
  ): Promise<void> {
    assert(
      workspaceId.length > 0,
      "maybeStartPatchGenerationForReportedTask: workspaceId must be non-empty"
    );

    const cfg = this.config.loadConfigOrDefault();
    const parentWorkspaceId = findWorkspaceEntry(cfg, workspaceId)?.workspace.parentWorkspaceId;
    if (!parentWorkspaceId) {
      return;
    }

    try {
      await this.gitPatchArtifactService.maybeStartGeneration(
        parentWorkspaceId,
        workspaceId,
        (wsId) => this.requestReportedTaskCleanupRecheck(wsId),
        options
      );
    } catch (error: unknown) {
      log.error("Failed to start subagent git patch generation", {
        parentWorkspaceId,
        childWorkspaceId: workspaceId,
        error,
      });
    }
  }

  private requestReportedTaskCleanupRecheck(workspaceId: string): Promise<void> {
    assert(
      workspaceId.length > 0,
      "requestReportedTaskCleanupRecheck: workspaceId must be non-empty"
    );

    return this.workspaceEventLocks.withLock(workspaceId, async () => {
      await this.cleanupReportedLeafTask(workspaceId);
    });
  }

  private async requestReportedChildCleanupRechecks(parentWorkspaceId: string): Promise<void> {
    assert(
      parentWorkspaceId.length > 0,
      "requestReportedChildCleanupRechecks: parentWorkspaceId must be non-empty"
    );

    const cfg = this.config.loadConfigOrDefault();
    const reportedChildTaskIds: string[] = [];
    for (const project of cfg.projects.values()) {
      for (const workspace of project.workspaces) {
        const workspaceId = coerceNonEmptyString(workspace.id);
        if (!workspaceId || workspace.parentWorkspaceId !== parentWorkspaceId) {
          continue;
        }
        if (!hasCompletedAgentReport(workspace)) {
          continue;
        }
        reportedChildTaskIds.push(workspaceId);
      }
    }

    for (const workspaceId of reportedChildTaskIds) {
      await this.requestReportedTaskCleanupRecheck(workspaceId);
    }
  }

  private async deliverDeferredBestOfReportsForParent(parentWorkspaceId: string): Promise<void> {
    assert(
      parentWorkspaceId.length > 0,
      "deliverDeferredBestOfReportsForParent: parentWorkspaceId must be non-empty"
    );

    const pendingGroup = await this.resolvePendingBestOfGroupForParent(parentWorkspaceId);
    if (!pendingGroup) {
      return;
    }

    await this.deliverDeferredBestOfSiblingReports({
      parentWorkspaceId,
      groupId: pendingGroup.groupId,
      total: pendingGroup.total,
    });
  }

  private async resolvePendingBestOfGroupForParent(
    parentWorkspaceId: string
  ): Promise<{ groupId: string; total: number } | null> {
    const partial = await this.historyService.readPartial(parentWorkspaceId);
    if (!partial) {
      return null;
    }

    const pendingParts = partial.parts.filter(
      (part): part is DynamicToolPart & { toolName: "task"; state: "input-available" } =>
        isDynamicToolPart(part) && part.toolName === "task" && part.state === "input-available"
    );
    if (pendingParts.length !== 1) {
      return null;
    }

    const parsedInput = parseTaskToolInputForRecovery(pendingParts[0].input);
    if (!parsedInput) {
      return null;
    }

    const requestedTotal = parsedInput.groupCount;
    if (requestedTotal <= 1) {
      return null;
    }

    const requestedAgentId = coerceNonEmptyString(
      parsedInput.data.agentId ?? parsedInput.data.subagent_type
    )?.toLowerCase();
    const requestedTitle = coerceNonEmptyString(parsedInput.data.title);
    const partialStartedAt =
      typeof partial.metadata?.timestamp === "number" ? partial.metadata.timestamp : undefined;

    const cfg = this.config.loadConfigOrDefault();
    const groups = new Map<string, { groupId: string; total: number; createdAtMs: number[] }>();
    for (const project of cfg.projects.values()) {
      for (const workspace of project.workspaces) {
        if (workspace.parentWorkspaceId !== parentWorkspaceId) {
          continue;
        }

        const groupId = coerceNonEmptyString(workspace.bestOf?.groupId);
        const total = workspace.bestOf?.total;
        if (!groupId || total !== requestedTotal) {
          continue;
        }

        const workspaceAgentId = resolvePersistedAgentId(workspace, "");
        if (requestedAgentId && workspaceAgentId && workspaceAgentId !== requestedAgentId) {
          continue;
        }

        const workspaceTitle = coerceNonEmptyString(workspace.title);
        if (requestedTitle && workspaceTitle && workspaceTitle !== requestedTitle) {
          continue;
        }

        const entry = groups.get(groupId) ?? { groupId, total, createdAtMs: [] };
        const createdAtMs =
          typeof workspace.createdAt === "string" ? Date.parse(workspace.createdAt) : Number.NaN;
        if (Number.isFinite(createdAtMs)) {
          entry.createdAtMs.push(createdAtMs);
        }
        groups.set(groupId, entry);
      }
    }

    if (parsedInput.legacyVariants) {
      for (const workspace of this.config.listLegacyTaskVariantWorkspaces(parentWorkspaceId)) {
        const { groupId, total } = workspace.bestOf;
        if (total !== requestedTotal) {
          continue;
        }

        const workspaceAgentId = normalizeAgentId(workspace.agentId ?? workspace.agentType, "");
        if (requestedAgentId && workspaceAgentId && workspaceAgentId !== requestedAgentId) {
          continue;
        }
        if (requestedTitle && workspace.title && workspace.title !== requestedTitle) {
          continue;
        }

        const entry = groups.get(groupId) ?? { groupId, total, createdAtMs: [] };
        const createdAtMs = workspace.createdAt ? Date.parse(workspace.createdAt) : Number.NaN;
        if (Number.isFinite(createdAtMs)) {
          entry.createdAtMs.push(createdAtMs);
        }
        groups.set(groupId, entry);
      }
    }

    const matchingGroups = Array.from(groups.values());
    const startedAfterPartial = (group: { createdAtMs: number[] }): boolean => {
      if (partialStartedAt == null) {
        return true;
      }

      return (
        group.createdAtMs.length > 0 &&
        group.createdAtMs.every((createdAtMs) => createdAtMs >= partialStartedAt)
      );
    };
    if (matchingGroups.length === 0) {
      return null;
    }
    if (matchingGroups.length === 1) {
      return startedAfterPartial(matchingGroups[0]) ? matchingGroups[0] : null;
    }
    if (partialStartedAt == null) {
      return null;
    }

    const recentMatchingGroups = matchingGroups.filter((group) => startedAfterPartial(group));
    return recentMatchingGroups.length === 1 ? recentMatchingGroups[0] : null;
  }

  private async deliverDeferredBestOfSiblingReports(params: {
    parentWorkspaceId: string;
    groupId: string;
    total: number;
  }): Promise<void> {
    assert(
      params.parentWorkspaceId.length > 0,
      "deliverDeferredBestOfSiblingReports: parentWorkspaceId must be non-empty"
    );

    const cleanupTaskIds = new Set<string>();
    await this.deferredBestOfLocks.withLock(params.parentWorkspaceId, async () => {
      const cfg = this.config.loadConfigOrDefault();
      const siblings = this.listBestOfSiblingTasks({
        parentWorkspaceId: params.parentWorkspaceId,
        groupId: params.groupId,
      });
      const groupedOutput = await this.buildBestOfCompletedTaskToolOutput({
        parentWorkspaceId: params.parentWorkspaceId,
        groupId: params.groupId,
        total: params.total,
      });
      if (groupedOutput) {
        const representativeTaskId = siblings[0]?.taskId;
        if (representativeTaskId) {
          const finalization = await this.tryFinalizePendingTaskToolCallInPartial(
            params.parentWorkspaceId,
            groupedOutput,
            representativeTaskId,
            findWorkspaceEntry(cfg, representativeTaskId)
          );
          if (finalization.kind === "finalized") {
            for (const taskId of finalization.taskIds) {
              cleanupTaskIds.add(taskId);
            }
            return;
          }
        }
      }

      if (
        await this.shouldDeferBestOfFallback({
          parentWorkspaceId: params.parentWorkspaceId,
          groupId: params.groupId,
          total: params.total,
        })
      ) {
        return;
      }

      const parentTaskToolState = await this.getTaskToolPartialState(params.parentWorkspaceId);
      const syntheticReportTaskIds = new Set<string>();
      const historyResult = await this.historyService.getHistoryFromLatestBoundary(
        params.parentWorkspaceId
      );
      if (historyResult.success) {
        for (const message of historyResult.data) {
          if (message.role !== "user" || message.metadata?.synthetic !== true) {
            continue;
          }
          const text = message.parts
            .filter((part): part is Extract<typeof part, { type: "text" }> => part.type === "text")
            .map((part) => part.text)
            .join("\n");
          const reportEnvelope = parseSubagentReportEnvelope(text);
          if (reportEnvelope == null || reportEnvelope.status === "in_progress") {
            continue;
          }
          syntheticReportTaskIds.add(reportEnvelope.taskId);
        }
      }

      const parentSessionDir = path.join(this.config.sessionsDir, params.parentWorkspaceId);
      for (const sibling of siblings) {
        if (
          parentTaskToolState.referencedTaskIds.has(sibling.taskId) ||
          syntheticReportTaskIds.has(sibling.taskId)
        ) {
          continue;
        }
        if (!(sibling.taskStatus === "reported" || sibling.taskStatus === "interrupted")) {
          continue;
        }

        const artifact = await readSubagentReportArtifact(parentSessionDir, sibling.taskId);
        if (!artifact) {
          continue;
        }

        const siblingCleanupTaskIds = await this.deliverReportToParentUnlocked(
          params.parentWorkspaceId,
          sibling.taskId,
          findWorkspaceEntry(cfg, sibling.taskId),
          {
            reportMarkdown: artifact.reportMarkdown,
            ...(artifact.title !== undefined ? { title: artifact.title } : {}),
            ...(artifact.planFilePath !== undefined ? { planFilePath: artifact.planFilePath } : {}),
            ...(artifact.structuredOutput !== undefined
              ? { structuredOutput: artifact.structuredOutput }
              : {}),
          }
        );
        for (const taskId of siblingCleanupTaskIds) {
          cleanupTaskIds.add(taskId);
        }
      }
    });

    for (const taskId of cleanupTaskIds) {
      await this.requestReportedTaskCleanupRecheck(taskId);
    }
  }

  private async getChildReportCostCents(childWorkspaceId: string): Promise<number> {
    assert(childWorkspaceId.trim().length > 0, "getChildReportCostCents requires childWorkspaceId");
    if (!this.sessionUsageService) {
      return 0;
    }

    try {
      const childUsage = await this.sessionUsageService.getSessionUsage(childWorkspaceId);
      if (!childUsage) {
        return 0;
      }
      return Math.max(
        0,
        Math.round((getTotalCost(sumUsageHistory(Object.values(childUsage.byModel))) ?? 0) * 100)
      );
    } catch (error) {
      log.warn("Failed to read child usage for goal attribution", { childWorkspaceId, error });
      return 0;
    }
  }

  private async attributeChildReportToParentGoal(
    parentWorkspaceId: string,
    childWorkspaceId: string
  ): Promise<void> {
    assert(
      parentWorkspaceId.trim().length > 0,
      "attributeChildReportToParentGoal requires parentWorkspaceId"
    );
    assert(
      childWorkspaceId.trim().length > 0,
      "attributeChildReportToParentGoal requires childWorkspaceId"
    );
    if (!this.workspaceGoalService) {
      return;
    }

    const childCostCents = await this.getChildReportCostCents(childWorkspaceId);
    const attribution = await this.workspaceGoalService.attributeChildReport({
      parentWorkspaceId,
      childWorkspaceId,
      childCostCents,
    });
    if (!attribution?.causedBudgetLimit) {
      return;
    }

    this.workspaceService.emitChatEvent(parentWorkspaceId, {
      type: "goal-budget-limited",
      workspaceId: parentWorkspaceId,
      goalId: attribution.goalAfter.goalId,
      causedByChild: true,
      childWorkspaceId,
      message: "Child workspace exceeded the parent's goal budget.",
    });
  }

  private async shouldAllowLegacyInvalidWorkflowOutputSchema(
    childWorkspaceId: string,
    childEntry: { projectPath: string; workspace: WorkspaceConfigEntry } | null | undefined
  ): Promise<boolean> {
    const workflowTask = childEntry?.workspace.workflowTask;
    if (workflowTask?.outputSchema === undefined) {
      return false;
    }
    if (
      validateJsonSchemaSubsetSchema(workflowTask.outputSchema, { requireObjectSchema: true })
        .success
    ) {
      return false;
    }
    const parentWorkspaceId = childEntry?.workspace.parentWorkspaceId;
    if (parentWorkspaceId == null) {
      return false;
    }

    try {
      const runStore = new WorkflowRunStore({
        sessionDir: path.join(this.config.sessionsDir, parentWorkspaceId),
      });
      const run = await runStore.getRun(workflowTask.runId);
      return run.agentOutputSchemaRequired !== true;
    } catch (error) {
      log.debug("Could not determine legacy workflow schema validation policy", {
        childWorkspaceId,
        workflowRunId: workflowTask.runId,
        error: getErrorMessage(error),
      });
      return false;
    }
  }

  private async finalizeAgentTaskReport(
    childWorkspaceId: string,
    childEntry: { projectPath: string; workspace: WorkspaceConfigEntry } | null | undefined,
    rawReportArgs: {
      reportMarkdown: string;
      title?: string;
      structuredOutput?: unknown;
      planFilePath?: string;
    }
  ): Promise<AgentReportFinalizationResult> {
    this.markTaskForegroundRelevant(childWorkspaceId);

    assert(
      childWorkspaceId.length > 0,
      "finalizeAgentTaskReport: childWorkspaceId must be non-empty"
    );
    assert(
      typeof rawReportArgs.reportMarkdown === "string" && rawReportArgs.reportMarkdown.length > 0,
      "finalizeAgentTaskReport: reportMarkdown must be non-empty"
    );

    const cfgBeforeReport = this.config.loadConfigOrDefault();
    const latestEntryBeforeReport =
      findWorkspaceEntry(cfgBeforeReport, childWorkspaceId) ?? childEntry;
    if ((latestEntryBeforeReport?.workspace.taskPendingGuidance?.length ?? 0) > 0) {
      return {
        finalized: false,
        reason: "pending_guidance",
        message: "A parent guidance update is pending; ignore this stale report.",
      };
    }

    const statusBefore = latestEntryBeforeReport?.workspace.taskStatus;
    if (statusBefore === "reported") {
      return { finalized: true };
    }

    const allowLegacyInvalidOutputSchema = await this.shouldAllowLegacyInvalidWorkflowOutputSchema(
      childWorkspaceId,
      latestEntryBeforeReport
    );
    const reportArgs = normalizeWorkflowAgentReportArgsForWorkflowTask(
      latestEntryBeforeReport?.workspace.workflowTask,
      rawReportArgs
    );
    const validationMessage = validateWorkflowAgentReportStructuredOutput({
      workflowTask: latestEntryBeforeReport?.workspace.workflowTask,
      reportArgs,
      allowLegacyInvalidOutputSchema,
    });
    if (validationMessage != null) {
      log.warn("Rejecting invalid workflow agent_report structured output", {
        childWorkspaceId,
        workflowTask: latestEntryBeforeReport?.workspace.workflowTask,
        message: validationMessage,
      });
      if (statusBefore === "interrupted") {
        return {
          finalized: false,
          reason: "terminal_interrupted",
          message: validationMessage,
        };
      }

      await this.editActiveWorkspaceEntry(
        childWorkspaceId,
        (ws) => {
          ws.taskStatus = "awaiting_report";
          ws.reportedAt = undefined;
        },
        { allowMissing: true }
      );
      await this.emitWorkspaceMetadata(childWorkspaceId);
      await this.promptTaskForRequiredCompletionTool(childWorkspaceId, {
        reason: "error",
        error: { error: validationMessage, errorType: "unknown" },
      });
      return {
        finalized: false,
        reason: "invalid_structured_output",
        message: validationMessage,
      };
    }

    // A best-of sibling's status flip and artifact write must not interleave with the grouped
    // assembly that runs under this lock (deliverReportToParent, startup recovery): an assembly
    // that read the old artifact of a sibling already marked reported would finalize the parent
    // on the report this publication is replacing.
    const bestOfParentWorkspaceId =
      latestEntryBeforeReport != null &&
      (this.getEffectiveTaskGroup(childWorkspaceId, latestEntryBeforeReport.workspace)?.total ??
        1) > 1
        ? latestEntryBeforeReport.workspace.parentWorkspaceId
        : undefined;
    const publish = () =>
      this.publishAgentTaskReport(
        childWorkspaceId,
        childEntry,
        latestEntryBeforeReport,
        reportArgs
      );
    const published =
      bestOfParentWorkspaceId != null
        ? await this.deferredBestOfLocks.withLock(bestOfParentWorkspaceId, publish)
        : await publish();
    if (!published) {
      return { finalized: true };
    }
    const { parentWorkspaceId, latestChildEntry, isWorkflowOwnedChildReport } = published;

    // Goal attribution is informational; if it throws (permissions failure,
    // disk-full, corrupted extensionMetadata.json in pushSnapshot), execution
    // would otherwise exit before reaching deliverReportToParent / waiter
    // resolution / queue drain — leaving the parent's task_await waiting
    // indefinitely (Coder-agents-review P1 DEREM-14). Match the
    // upsertSubagentReportArtifact pattern above: log and continue.
    try {
      await this.attributeChildReportToParentGoal(parentWorkspaceId, childWorkspaceId);
    } catch (error: unknown) {
      log.error("Failed to attribute child report to parent goal", {
        parentWorkspaceId,
        childWorkspaceId,
        error,
      });
    }

    await this.maybeStartPatchGenerationForReportedTask(childWorkspaceId);

    await this.deliverReportToParent(
      parentWorkspaceId,
      childWorkspaceId,
      latestChildEntry,
      reportArgs
    );

    const hadForegroundWaiters = this.resolveWaiters(childWorkspaceId, {
      ...reportArgs,
      model: latestChildEntry?.workspace.taskModelString,
      thinkingLevel: latestChildEntry?.workspace.taskThinkingLevel,
    });

    // Track 2 r5: surface the terminal report into the parent's persistent
    // sandbox mount so a later code_execution eval can drain it via
    // mux.events(). Foreground waiters (blocking mux.task / task_await)
    // already consume the report directly, so skip the queue to avoid
    // double-delivery. Fire-and-forget by contract: the oversized-report path
    // acquires the scope lock (a long-running eval may hold it), and the
    // queue is best-effort acceleration — the durable terminal wake below
    // remains the source of truth, so failures only log.
    if (!hadForegroundWaiters) {
      void sandboxHostService
        .postTaskTerminalEvent(parentWorkspaceId, {
          taskId: childWorkspaceId,
          status: "completed",
          reportMarkdown: reportArgs.reportMarkdown,
        })
        .catch((error: unknown) => {
          log.warn("Failed to post task terminal event to sandbox mount", {
            parentWorkspaceId,
            childWorkspaceId,
            error,
          });
        });
    }

    // Free slot and start queued tasks.
    await this.maybeStartQueuedTasks();

    // Auto-resume any parent stream that was waiting on a task tool call (restart-safe).
    const postCfg = this.config.loadConfigOrDefault();
    const parentEntry = findWorkspaceEntry(postCfg, parentWorkspaceId);
    if (!parentEntry) {
      // Parent may have been cleaned up (e.g. it already reported and this was its last descendant).
      return { finalized: true };
    }
    const hasActiveDescendants = this.hasActiveDescendantAgentTasks(postCfg, parentWorkspaceId);
    if (!hasActiveDescendants) {
      this.consecutiveAutoResumes.delete(parentWorkspaceId);
    }

    if (this.interruptedParentWorkspaceIds.has(parentWorkspaceId)) {
      log.debug("Skipping post-report parent auto-resume after hard interrupt", {
        parentWorkspaceId,
        childWorkspaceId,
      });
      return { finalized: true };
    }

    if (hadForegroundWaiters) {
      log.debug("Skipping post-report parent auto-resume: report delivered to foreground waiter", {
        parentWorkspaceId,
        childWorkspaceId,
      });
      this.scheduleTerminalAttentionDrain(parentWorkspaceId);
      return { finalized: true };
    }

    if (isWorkflowOwnedChildReport) {
      // Workflow-owned tasks report through WorkflowRunner's journal/final-result path. Do not
      // also resume the parent directly from the child report.
      log.debug("Skipping post-report parent auto-resume for workflow-owned child", {
        parentWorkspaceId,
        childWorkspaceId,
      });
      this.scheduleTerminalAttentionDrain(parentWorkspaceId);
      return { finalized: true };
    }

    // The report is already injected into parent history above (deliverReportToParent). Enqueue the
    // notification even when other children are still active: the drain defers on blocking work and
    // a later foreground-awaited sibling may suppress its own wake-up.
    const generationId = await this.getAgentTerminalAttentionGenerationId(
      parentWorkspaceId,
      childWorkspaceId
    );
    await this.enqueueTerminalAttention({
      ownerWorkspaceId: parentWorkspaceId,
      sourceKind: "agent_task",
      terminalOutcome: "completed",
      sourceId: childWorkspaceId,
      ...(generationId != null ? { generationId } : {}),
    });

    return { finalized: true };
  }

  /**
   * Marks the child reported and persists its report artifact in every ancestor session dir.
   * Returns null when the child is not an agent task (no parent to deliver to).
   */
  private async publishAgentTaskReport(
    childWorkspaceId: string,
    childEntry: { projectPath: string; workspace: WorkspaceConfigEntry } | null | undefined,
    latestEntryBeforeReport:
      | { projectPath: string; workspace: WorkspaceConfigEntry }
      | null
      | undefined,
    reportArgs: {
      reportMarkdown: string;
      title?: string;
      structuredOutput?: unknown;
      planFilePath?: string;
    }
  ): Promise<{
    parentWorkspaceId: string;
    latestChildEntry: { projectPath: string; workspace: WorkspaceConfigEntry } | null | undefined;
    isWorkflowOwnedChildReport: boolean;
  } | null> {
    // Notify clients immediately even if we can't delete the workspace yet.
    await this.editWorkspaceEntry(
      childWorkspaceId,
      (ws) => {
        ws.taskStatus = "reported";
        ws.reportedAt = getIsoNow();
        // Successful completion resets the persisted recovery circuit breaker.
        delete ws.taskRecoveryAttempts;
      },
      { allowMissing: true }
    );
    // Drop queued incremental updates synchronously with the terminal commit: while they sit at
    // the parent's queue head as tool-end entries, the parent's stream stops at its next step
    // boundary for them, and a dispatch refused as superseded cannot restore that cut turn.
    // skipCancelCallbacks: a parent running as a delegated workspace turn queues each report with
    // continuation-failure callbacks; superseding the report must not interrupt that live turn.
    const progressParentWorkspaceId = latestEntryBeforeReport?.workspace.parentWorkspaceId;
    if (progressParentWorkspaceId) {
      const queuedProgressRemoval = this.workspaceService.removeQueuedMessagesByDedupeKeyPrefix(
        progressParentWorkspaceId,
        agentReportProgressDedupePrefix(childWorkspaceId),
        { cancelReason: AGENT_REPORT_PROGRESS_SUPERSEDED_REASON, skipCancelCallbacks: true }
      );
      if (!queuedProgressRemoval.success) {
        log.warn("Failed to remove queued incremental sub-agent reports", {
          parentWorkspaceId: progressParentWorkspaceId,
          childWorkspaceId,
          error: queuedProgressRemoval.error,
        });
      }
    }
    eventSpine.emit("task.reported", { workspaceId: childWorkspaceId, taskId: childWorkspaceId });

    await this.emitWorkspaceMetadata(childWorkspaceId);

    // NOTE: Stream continues — we intentionally do NOT abort it.
    // Deterministic termination is enforced by StreamManager stopWhen logic that
    // waits for an agent_report tool result where output.success === true at the
    // step boundary (preserving usage accounting). recordSessionUsage runs when
    // the stream ends naturally.

    const cfgAfterReport = this.config.loadConfigOrDefault();
    const latestChildEntry = findWorkspaceEntry(cfgAfterReport, childWorkspaceId) ?? childEntry;
    const parentWorkspaceId = latestChildEntry?.workspace.parentWorkspaceId;
    if (!parentWorkspaceId) {
      const reason = latestChildEntry
        ? "missing parentWorkspaceId"
        : "workspace not found in config";
      log.debug("Ignoring agent_report: workspace is not an agent task", {
        childWorkspaceId,
        reason,
      });
      // Best-effort: resolve any foreground waiters even if we can't deliver to a parent.
      this.resolveWaiters(childWorkspaceId, reportArgs);
      void this.maybeStartQueuedTasks();
      return null;
    }

    const reportTitle = coerceNonEmptyString(reportArgs.title);
    this.timelineRecorder.record(parentWorkspaceId, {
      kind: "task.reported",
      // Background reports are also injected into parent history, which the timeline maps; keying
      // both on the task keeps one row per report.
      source: { system: "task", key: subagentReportSourceKey(childWorkspaceId) },
      status: "completed",
      anchor: { taskId: childWorkspaceId, childWorkspaceId },
      data: {
        ...(reportTitle ? { title: reportTitle } : {}),
        digest: reportArgs.reportMarkdown,
      },
    });

    const isWorkflowOwnedChildReport = latestChildEntry?.workspace.workflowTask != null;

    const indexAfterReport = this.buildAgentTaskIndex(cfgAfterReport);
    const ancestorWorkspaceIds = this.listAncestorWorkspaceIdsUsingParentById(
      indexAfterReport.parentById,
      childWorkspaceId
    );
    const workflowOwnedAncestorWorkspaceIds = ancestorWorkspaceIds.filter(
      (ancestorWorkspaceId) =>
        this.getWorkflowOwnedDescendantAgentTaskUsingIndex(
          indexAfterReport,
          ancestorWorkspaceId,
          childWorkspaceId
        ) === true
    );

    // Persist the completed report in the session dirs of all ancestors so `task_await` can
    // retrieve it after cleanup/restart (even if the task workspace itself is deleted).
    const persistedAtMs = Date.now();
    for (const ancestorWorkspaceId of ancestorWorkspaceIds) {
      try {
        const ancestorSessionDir = path.join(this.config.sessionsDir, ancestorWorkspaceId);
        await upsertSubagentReportArtifact({
          workspaceId: ancestorWorkspaceId,
          workspaceSessionDir: ancestorSessionDir,
          childTaskId: childWorkspaceId,
          parentWorkspaceId,
          ancestorWorkspaceIds,
          workflowOwnedAncestorWorkspaceIds,
          reportMarkdown: reportArgs.reportMarkdown,
          model: latestChildEntry?.workspace.taskModelString,
          thinkingLevel: latestChildEntry?.workspace.taskThinkingLevel,
          title: reportArgs.title,
          planFilePath: reportArgs.planFilePath,
          structuredOutput: reportArgs.structuredOutput,
          nowMs: persistedAtMs,
        });
      } catch (error: unknown) {
        log.error("Failed to persist subagent report artifact", {
          workspaceId: ancestorWorkspaceId,
          childTaskId: childWorkspaceId,
          error,
        });
      }
    }

    return { parentWorkspaceId, latestChildEntry, isWorkflowOwnedChildReport };
  }

  private enforceCompletedReportCacheLimit(): void {
    while (this.completedReportsByTaskId.size > COMPLETED_REPORT_CACHE_MAX_ENTRIES) {
      const first = this.completedReportsByTaskId.keys().next();
      if (first.done) break;
      this.completedReportsByTaskId.delete(first.value);
    }
  }

  private resolveWaiters(
    taskId: string,
    report: {
      reportMarkdown: string;
      title?: string;
      structuredOutput?: unknown;
      planFilePath?: string;
      model?: string;
      thinkingLevel?: ThinkingLevel;
    }
  ): boolean {
    this.markTaskForegroundRelevant(taskId);

    const cfg = this.config.loadConfigOrDefault();
    const index = this.buildAgentTaskIndex(cfg);
    const ancestorWorkspaceIds = this.listAncestorWorkspaceIdsUsingParentById(
      index.parentById,
      taskId
    );
    const workflowOwnedAncestorWorkspaceIds = ancestorWorkspaceIds.filter(
      (ancestorWorkspaceId) =>
        this.getWorkflowOwnedDescendantAgentTaskUsingIndex(index, ancestorWorkspaceId, taskId) ===
        true
    );

    this.completedReportsByTaskId.set(taskId, {
      reportMarkdown: report.reportMarkdown,
      title: report.title,
      planFilePath: report.planFilePath,
      structuredOutput: report.structuredOutput,
      model: report.model,
      thinkingLevel: report.thinkingLevel,
      ancestorWorkspaceIds,
      workflowOwnedAncestorWorkspaceIds,
    });
    this.enforceCompletedReportCacheLimit();

    const waiters = this.pendingWaitersByTaskId.get(taskId);
    if (!waiters || waiters.length === 0) {
      return false;
    }

    this.pendingWaitersByTaskId.delete(taskId);
    for (const waiter of waiters) {
      try {
        waiter.cleanup();
        waiter.resolve(report);
      } catch {
        // ignore
      }
    }

    return true;
  }

  private rejectWaiters(taskId: string, error: Error): void {
    this.markTaskForegroundRelevant(taskId);

    const waiters = this.pendingWaitersByTaskId.get(taskId);
    if (!waiters || waiters.length === 0) {
      return;
    }

    for (const waiter of [...waiters]) {
      try {
        waiter.reject(error);
      } catch (rejectError: unknown) {
        log.error("Task waiter reject callback failed", { taskId, error: rejectError });
      }
    }
  }

  private findProposePlanSuccessInParts(parts: readonly unknown[]): { planPath: string } | null {
    for (let i = parts.length - 1; i >= 0; i--) {
      const part = parts[i];
      if (!isDynamicToolPart(part)) continue;
      if (part.toolName !== "propose_plan") continue;
      if (part.state !== "output-available") continue;
      if (!isSuccessfulToolResult(part.output)) continue;

      const planPath =
        typeof part.output === "object" &&
        part.output !== null &&
        "planPath" in part.output &&
        typeof (part.output as { planPath?: unknown }).planPath === "string"
          ? (part.output as { planPath: string }).planPath.trim()
          : "";
      if (!planPath) continue;

      return { planPath };
    }
    return null;
  }

  private findFinalAssistantResponseInParts(
    parts: readonly unknown[]
  ): { reportMarkdown: string } | null {
    const lastToolIndex = parts.findLastIndex((part) => isDynamicToolPart(part));
    let reportMarkdown = "";
    for (let index = lastToolIndex + 1; index < parts.length; index += 1) {
      const part = parts[index];
      if (!part || typeof part !== "object") continue;
      const maybeText = part as { type?: unknown; text?: unknown };
      if (maybeText.type !== "text" || typeof maybeText.text !== "string") continue;
      reportMarkdown += maybeText.text;
    }

    const trimmedReport = reportMarkdown.trim();
    if (trimmedReport.length === 0) {
      return null;
    }

    return { reportMarkdown: trimmedReport };
  }

  private async findLatestAgentReportArgsInHistory(
    workspaceId: string,
    options: { acceptSchemaShapedWorkflowReport?: boolean } = {}
  ): Promise<{ reportMarkdown: string; title?: string; structuredOutput?: unknown } | null> {
    const historyResult = await this.historyService.getHistoryFromLatestBoundary(workspaceId);
    if (!historyResult.success) {
      log.warn("Failed to read sub-agent history for final report metadata", {
        workspaceId,
        error: historyResult.error,
      });
      return null;
    }

    for (let index = historyResult.data.length - 1; index >= 0; index -= 1) {
      const message = historyResult.data[index];
      if (message.role !== "assistant") {
        continue;
      }
      // A failed newer report invalidates all older structured candidates. Recovery must
      // produce a fresh successful report rather than scanning backward to stale metadata.
      const outcome = this.findLatestAgentReportOutcomeInParts(message.parts, options);
      if (outcome?.kind === "failure") {
        return null;
      }
      if (outcome?.kind === "success") {
        return outcome.report;
      }
    }
    return null;
  }

  private async resolveFinalAgentReportArgs(
    workspaceId: string,
    parts: readonly unknown[],
    options: { acceptSchemaShapedWorkflowReport?: boolean } = {}
  ): Promise<{ reportMarkdown: string; title?: string; structuredOutput?: unknown } | null> {
    const finalResponse = this.findFinalAssistantResponseInParts(parts);
    if (finalResponse == null) {
      return null;
    }

    // The newest agent_report attempt controls replacement semantics: a newer correction may
    // recover from an earlier failure, while a newer failure invalidates older successes.
    const latestOutcomeInTurn = this.findLatestAgentReportOutcomeInParts(parts, options);
    const latestProgress =
      latestOutcomeInTurn?.kind === "success"
        ? latestOutcomeInTurn.report
        : latestOutcomeInTurn?.kind === "failure"
          ? null
          : await this.findLatestAgentReportArgsInHistory(workspaceId, options);
    return {
      reportMarkdown: finalResponse.reportMarkdown,
      ...(latestProgress?.title !== undefined ? { title: latestProgress.title } : {}),
      ...(latestProgress?.structuredOutput !== undefined
        ? { structuredOutput: latestProgress.structuredOutput }
        : {}),
    };
  }

  private findLatestAgentReportOutcomeInParts(
    parts: readonly unknown[],
    options: { acceptSchemaShapedWorkflowReport?: boolean } = {}
  ):
    | {
        kind: "success";
        report: { reportMarkdown: string; title?: string; structuredOutput?: unknown };
      }
    | { kind: "failure" }
    | null {
    for (let index = parts.length - 1; index >= 0; index -= 1) {
      const part = parts[index];
      if (!isDynamicToolPart(part) || part.toolName !== "agent_report") {
        continue;
      }
      if (part.state !== "output-available") {
        continue;
      }
      if (!isSuccessfulToolResult(part.output)) {
        return { kind: "failure" };
      }
      const report = this.findAgentReportArgsInParts([part], options);
      return report == null ? { kind: "failure" } : { kind: "success", report };
    }
    return null;
  }

  private findAgentReportArgsInParts(
    parts: readonly unknown[],
    options: { acceptSchemaShapedWorkflowReport?: boolean } = {}
  ): { reportMarkdown: string; title?: string; structuredOutput?: unknown } | null {
    for (let i = parts.length - 1; i >= 0; i--) {
      const part = parts[i];
      if (!isDynamicToolPart(part)) continue;
      if (part.toolName !== "agent_report") continue;
      if (part.state !== "output-available") continue;
      if (!isSuccessfulToolResult(part.output)) continue;
      const outputReport = AgentReportSubmittedReportSchema.safeParse(
        typeof part.output === "object" && part.output !== null && "report" in part.output
          ? (part.output as { report?: unknown }).report
          : undefined
      );
      if (outputReport.success) {
        return outputReport.data;
      }

      if (
        options.acceptSchemaShapedWorkflowReport === true &&
        part.input != null &&
        typeof part.input === "object" &&
        !Array.isArray(part.input)
      ) {
        return {
          reportMarkdown: STRUCTURED_WORKFLOW_REPORT_PLACEHOLDER_MARKDOWN,
          structuredOutput: part.input,
        };
      }

      const parsedInlineArgs = AgentReportInlineToolArgsSchema.safeParse(part.input);
      if (parsedInlineArgs.success) {
        // Normalize null → undefined at the schema boundary so downstream
        // code that expects `title?: string` doesn't need to handle null.
        return {
          reportMarkdown: parsedInlineArgs.data.reportMarkdown,
          title: parsedInlineArgs.data.title ?? undefined,
        };
      }
    }
    return null;
  }

  private listBestOfSiblingTasks(params: { parentWorkspaceId: string; groupId: string }): Array<{
    taskId: string;
    index: number;
    agentId?: string;
    agentType?: string;
    taskStatus?: WorkspaceConfigEntry["taskStatus"];
    taskExecutionStatus?: WorkspaceConfigEntry["taskExecutionStatus"];
  }> {
    const cfg = this.config.loadConfigOrDefault();
    const siblings: Array<{
      taskId: string;
      index: number;
      agentId?: string;
      agentType?: string;
      taskStatus?: WorkspaceConfigEntry["taskStatus"];
      taskExecutionStatus?: WorkspaceConfigEntry["taskExecutionStatus"];
    }> = [];

    for (const project of cfg.projects.values()) {
      for (const workspace of project.workspaces) {
        const taskId = coerceNonEmptyString(workspace.id);
        if (!taskId) {
          continue;
        }
        if (workspace.parentWorkspaceId !== params.parentWorkspaceId) {
          continue;
        }
        if (workspace.bestOf?.groupId !== params.groupId) {
          continue;
        }
        if (!Number.isInteger(workspace.bestOf.index)) {
          continue;
        }

        siblings.push({
          taskId,
          index: workspace.bestOf.index,
          agentId: coerceNonEmptyString(workspace.agentId),
          agentType: coerceNonEmptyString(workspace.agentType),
          taskStatus: workspace.taskStatus,
          taskExecutionStatus: workspace.taskExecutionStatus,
        });
      }
    }

    const siblingTaskIds = new Set(siblings.map((sibling) => sibling.taskId));
    for (const workspace of this.config.listLegacyTaskVariantWorkspaces(params.parentWorkspaceId)) {
      if (workspace.bestOf.groupId !== params.groupId || siblingTaskIds.has(workspace.id)) {
        continue;
      }
      siblings.push({
        taskId: workspace.id,
        index: workspace.bestOf.index,
        agentId: workspace.agentId,
        agentType: workspace.agentType,
        taskStatus: workspace.taskStatus,
      });
    }

    siblings.sort(
      (left, right) => left.index - right.index || left.taskId.localeCompare(right.taskId)
    );
    return siblings;
  }

  /**
   * A reported sibling that a client reawakened (workspace-turn continuation), that a resume put
   * back to running (its re-run may be between streams or past stream-end but before its
   * publication), or that is streaming still owns its previous report artifact. Finalizing the
   * parent on that artifact would freeze the grouped result on a report the child is replacing,
   * so its group waits for the new report.
   */
  private isBestOfSiblingExecutingAgain(sibling: {
    taskId: string;
    taskStatus?: WorkspaceConfigEntry["taskStatus"];
    taskExecutionStatus?: WorkspaceConfigEntry["taskExecutionStatus"];
  }): boolean {
    return (
      sibling.taskStatus === "running" ||
      sibling.taskStatus === "awaiting_report" ||
      isActiveWorkspaceTurnTaskStatus(sibling.taskExecutionStatus) ||
      this.aiService.isStreaming(sibling.taskId)
    );
  }

  /**
   * Synchronous so the partial-commit transform can re-run it with no await between the check and
   * the write: every sibling the grouped output was assembled from must still be the group and
   * none may be executing again.
   */
  private areBestOfSiblingsStillSettled(params: {
    parentWorkspaceId: string;
    groupId: string;
    assembledTaskIds: readonly string[];
    reportingTaskId?: string;
  }): boolean {
    const liveSiblings = this.listBestOfSiblingTasks({
      parentWorkspaceId: params.parentWorkspaceId,
      groupId: params.groupId,
    });
    return (
      liveSiblings.length === params.assembledTaskIds.length &&
      liveSiblings.every(
        (sibling, index) =>
          sibling.taskId === params.assembledTaskIds[index] &&
          (sibling.taskId === params.reportingTaskId ||
            !this.isBestOfSiblingExecutingAgain(sibling))
      )
    );
  }

  private async buildBestOfCompletedTaskToolOutput(params: {
    parentWorkspaceId: string;
    groupId: string;
    total: number;
    /** The sibling whose report is being delivered right now; its execution is live by construction. */
    reportingTaskId?: string;
  }): Promise<z.infer<typeof TaskToolResultSchema> | null> {
    const siblings = this.listBestOfSiblingTasks({
      parentWorkspaceId: params.parentWorkspaceId,
      groupId: params.groupId,
    });
    if (siblings.length === 0) {
      return null;
    }
    if (siblings.length > params.total) {
      log.error("buildBestOfCompletedTaskToolOutput: found more siblings than requested", {
        parentWorkspaceId: params.parentWorkspaceId,
        groupId: params.groupId,
        siblingCount: siblings.length,
        requestedTotal: params.total,
      });
      return null;
    }

    // Best-of creation can fail or be interrupted after only some candidates are spawned.
    // When recovering an interrupted parent stream, finalize against the siblings that
    // actually exist so the parent task tool call does not stay pending forever.
    const parentSessionDir = path.join(this.config.sessionsDir, params.parentWorkspaceId);
    const reports: Array<{
      taskId: string;
      reportMarkdown: string;
      structuredOutput?: unknown;
      planFilePath?: string;
      title?: string;
      agentId?: string;
      agentType?: string;
      modelString?: string;
      thinkingLevel?: ThinkingLevel;
    }> = [];

    for (const sibling of siblings) {
      if (
        sibling.taskId !== params.reportingTaskId &&
        this.isBestOfSiblingExecutingAgain(sibling)
      ) {
        return null;
      }

      const artifact = await readSubagentReportArtifact(parentSessionDir, sibling.taskId);
      if (!artifact) {
        return null;
      }

      reports.push({
        taskId: sibling.taskId,
        reportMarkdown: artifact.reportMarkdown,
        title: artifact.title,
        planFilePath: artifact.planFilePath,
        structuredOutput: artifact.structuredOutput,
        agentId: sibling.agentId,
        agentType: sibling.agentType,
        modelString: artifact.model,
        thinkingLevel: artifact.thinkingLevel,
      });
    }

    // The artifact reads above awaited disk I/O, during which a client can reawaken a sibling
    // whose old report is already in `reports`; re-read live state once more before handing out.
    // The commit transform repeats this check so a resume landing after this point cannot slip
    // between it and the partial write either.
    const taskIds = siblings.map((sibling) => sibling.taskId);
    if (
      !this.areBestOfSiblingsStillSettled({
        parentWorkspaceId: params.parentWorkspaceId,
        groupId: params.groupId,
        assembledTaskIds: taskIds,
        reportingTaskId: params.reportingTaskId,
      })
    ) {
      return null;
    }

    const output = {
      status: "completed" as const,
      taskIds,
      reports,
    };
    const parsed = TaskToolResultSchema.safeParse(output);
    if (!parsed.success) {
      log.error("buildBestOfCompletedTaskToolOutput: invalid grouped task output", {
        error: parsed.error.message,
        parentWorkspaceId: params.parentWorkspaceId,
        groupId: params.groupId,
      });
      return null;
    }

    return parsed.data;
  }

  private async getTaskToolPartialState(workspaceId: string): Promise<{
    pendingBestOfTaskToolCount: number;
    pendingTaskToolCount: number;
    referencedTaskIds: Set<string>;
  }> {
    const partial = await this.historyService.readPartial(workspaceId);
    const referencedTaskIds = new Set<string>();
    if (!partial) {
      return {
        pendingBestOfTaskToolCount: 0,
        pendingTaskToolCount: 0,
        referencedTaskIds,
      };
    }

    let pendingBestOfTaskToolCount = 0;
    let pendingTaskToolCount = 0;
    for (const part of partial.parts) {
      if (!isDynamicToolPart(part) || part.toolName !== "task") {
        continue;
      }

      if (part.state === "input-available") {
        pendingTaskToolCount += 1;
        const parsedInput = parseTaskToolInputForRecovery(part.input);
        if (parsedInput && parsedInput.groupCount > 1) {
          pendingBestOfTaskToolCount += 1;
        }
        continue;
      }
      if (part.state !== "output-available") {
        continue;
      }

      collectReferencedTaskIdsFromTaskToolOutput(part.output, referencedTaskIds);
    }

    return {
      pendingBestOfTaskToolCount,
      pendingTaskToolCount,
      referencedTaskIds,
    };
  }

  private async shouldDeferBestOfFallback(params: {
    parentWorkspaceId: string;
    groupId: string;
    total: number;
  }): Promise<boolean> {
    const parentTaskToolState = await this.getTaskToolPartialState(params.parentWorkspaceId);
    if (
      parentTaskToolState.pendingBestOfTaskToolCount !== 1 ||
      parentTaskToolState.pendingTaskToolCount !== 1
    ) {
      return false;
    }

    const siblings = this.listBestOfSiblingTasks({
      parentWorkspaceId: params.parentWorkspaceId,
      groupId: params.groupId,
    });
    const hasRecoverableSibling = siblings.some((sibling) => {
      return (
        sibling.taskStatus === "queued" ||
        sibling.taskStatus === "starting" ||
        this.isBestOfSiblingExecutingAgain(sibling)
      );
    });
    if (hasRecoverableSibling) {
      return true;
    }

    return (
      (await this.buildBestOfCompletedTaskToolOutput({
        parentWorkspaceId: params.parentWorkspaceId,
        groupId: params.groupId,
        total: params.total,
      })) != null
    );
  }

  private getEffectiveTaskGroup(
    workspaceId: string,
    workspace: Pick<WorkspaceConfigEntry, "bestOf">
  ): TaskCreateArgs["bestOf"] {
    const bestOf = workspace.bestOf ?? this.config.getLegacyTaskVariantGroup(workspaceId);
    if (!bestOf) {
      return undefined;
    }
    return { groupId: bestOf.groupId, index: bestOf.index, total: bestOf.total };
  }

  private async deliverReportToParent(
    parentWorkspaceId: string,
    childWorkspaceId: string,
    childEntry: { projectPath: string; workspace: WorkspaceConfigEntry } | null | undefined,
    report: {
      reportMarkdown: string;
      title?: string;
      structuredOutput?: unknown;
      planFilePath?: string;
    }
  ): Promise<void> {
    assert(
      childWorkspaceId.length > 0,
      "deliverReportToParent: childWorkspaceId must be non-empty"
    );

    let cleanupTaskIds: readonly string[] = [];
    const bestOf = childEntry
      ? this.getEffectiveTaskGroup(childWorkspaceId, childEntry.workspace)
      : undefined;
    const bestOfTotal = bestOf?.total ?? 1;
    if (bestOfTotal > 1) {
      await this.deferredBestOfLocks.withLock(parentWorkspaceId, async () => {
        cleanupTaskIds = await this.deliverReportToParentUnlocked(
          parentWorkspaceId,
          childWorkspaceId,
          childEntry,
          report
        );
      });
    } else {
      cleanupTaskIds = await this.deliverReportToParentUnlocked(
        parentWorkspaceId,
        childWorkspaceId,
        childEntry,
        report
      );
    }

    for (const taskId of cleanupTaskIds) {
      await this.requestReportedTaskCleanupRecheck(taskId);
    }
  }

  private async deliverReportToParentUnlocked(
    parentWorkspaceId: string,
    childWorkspaceId: string,
    childEntry: { projectPath: string; workspace: WorkspaceConfigEntry } | null | undefined,
    report: {
      reportMarkdown: string;
      title?: string;
      structuredOutput?: unknown;
      planFilePath?: string;
    }
  ): Promise<readonly string[]> {
    const agentType = coerceNonEmptyString(childEntry?.workspace.agentType) ?? "agent";
    const childModelString = childEntry?.workspace.taskModelString;
    const childThinkingLevel = childEntry?.workspace.taskThinkingLevel;

    const output = {
      status: "completed" as const,
      taskId: childWorkspaceId,
      reportMarkdown: report.reportMarkdown,
      title: report.title,
      planFilePath: report.planFilePath,
      structuredOutput: report.structuredOutput,
      agentType,
      modelString: childModelString,
      thinkingLevel: childThinkingLevel,
    };
    const parsedOutput = TaskToolResultSchema.safeParse(output);
    if (!parsedOutput.success) {
      log.error("Task tool output schema validation failed", { error: parsedOutput.error.message });
      return [];
    }

    if (childEntry?.workspace.workflowTask != null) {
      log.debug("Skipping generic parent report delivery for workflow-owned child", {
        parentWorkspaceId,
        childWorkspaceId,
      });
      return [];
    }

    // Restart-safe: if the parent has a pending task tool call in partial.json (interrupted stream),
    // finalize it with the report. Avoid rewriting persisted history to keep earlier messages immutable.
    if (!this.aiService.isStreaming(parentWorkspaceId)) {
      const finalization = await this.tryFinalizePendingTaskToolCallInPartial(
        parentWorkspaceId,
        parsedOutput.data,
        childWorkspaceId,
        childEntry
      );
      if (finalization.kind === "finalized") {
        return finalization.taskIds.filter((taskId) => taskId !== childWorkspaceId);
      }

      const bestOf = childEntry
        ? this.getEffectiveTaskGroup(childWorkspaceId, childEntry.workspace)
        : undefined;
      if (bestOf?.total != null && bestOf.total > 1) {
        const parentTaskToolState = await this.getTaskToolPartialState(parentWorkspaceId);

        // Concurrent sibling completions can arrive after another sibling already finalized
        // the grouped task output in the interrupted parent partial. Avoid appending an
        // extra synthetic fallback report once that grouped result already contains this child.
        if (parentTaskToolState.referencedTaskIds.has(childWorkspaceId)) {
          return [];
        }

        if (
          finalization.kind === "not_ready" &&
          (await this.shouldDeferBestOfFallback({
            parentWorkspaceId,
            groupId: bestOf.groupId,
            total: bestOf.total,
          }))
        ) {
          return [];
        }
      }
    }

    // If someone is actively awaiting this report (foreground task tool call or task_await),
    // skip injecting a synthetic history message to avoid duplicating the report in context.
    if (childWorkspaceId) {
      const waiters = this.pendingWaitersByTaskId.get(childWorkspaceId);
      if (waiters && waiters.length > 0) {
        return [];
      }
    }

    // Background tasks: append a synthetic user message containing the report so earlier history
    // remains immutable (append-only) and prompt caches can still reuse the prefix.
    const titlePrefix =
      typeof report.title === "string" && report.title.trim().length > 0
        ? report.title
        : subagentReportFallbackTitle(agentType);
    const reportContent = formatSubagentReportUserMessage({
      childWorkspaceId,
      agentType,
      title: titlePrefix,
      reportMarkdown: report.reportMarkdown,
      status: "completed",
      ...(childModelString != null ? { model: childModelString } : {}),
      ...(childThinkingLevel != null ? { thinkingLevel: childThinkingLevel } : {}),
      ...(report.structuredOutput !== undefined
        ? { structuredOutput: report.structuredOutput }
        : {}),
    });

    const workspaceTurnMuxMetadata =
      await this.getWorkspaceTurnManager().getActiveWorkspaceTurnMuxMetadataForWorkspace(
        parentWorkspaceId
      );
    const messageId = createTaskReportMessageId();
    const reportMessage = createMuxMessage(messageId, "user", reportContent, {
      timestamp: Date.now(),
      synthetic: true,
      uiVisible: true,
      ...(workspaceTurnMuxMetadata != null ? { muxMetadata: workspaceTurnMuxMetadata } : {}),
    });

    const appendResult = await this.historyService.appendToHistory(
      parentWorkspaceId,
      reportMessage
    );
    if (appendResult.success) {
      this.workspaceService.emitChatEvent(parentWorkspaceId, {
        ...reportMessage,
        type: "message",
      });
    }
    if (!appendResult.success) {
      log.error("Failed to append synthetic subagent report to parent history", {
        parentWorkspaceId,
        error: appendResult.error,
      });
    }

    return [];
  }

  private async tryFinalizePendingTaskToolCallInPartial(
    workspaceId: string,
    output: unknown,
    childWorkspaceId: string,
    childEntry: { projectPath: string; workspace: WorkspaceConfigEntry } | null | undefined
  ): Promise<
    { kind: "finalized"; taskIds: readonly string[] } | { kind: "not_ready" } | { kind: "failed" }
  > {
    const parsedOutput = TaskToolResultSchema.safeParse(output);
    if (!parsedOutput.success || parsedOutput.data.status !== "completed") {
      log.error("tryFinalizePendingTaskToolCallInPartial: invalid output", {
        error: parsedOutput.success ? "status is not 'completed'" : parsedOutput.error.message,
      });
      return { kind: "failed" };
    }

    const partial = await this.historyService.readPartial(workspaceId);
    if (!partial) {
      return { kind: "failed" };
    }

    type PendingTaskToolPart = DynamicToolPart & { toolName: "task"; state: "input-available" };
    const pendingParts = partial.parts.filter(
      (p): p is PendingTaskToolPart =>
        isDynamicToolPart(p) && p.toolName === "task" && p.state === "input-available"
    );

    if (pendingParts.length === 0) {
      return { kind: "failed" };
    }
    if (pendingParts.length > 1) {
      log.error("tryFinalizePendingTaskToolCallInPartial: multiple pending task tool calls", {
        workspaceId,
      });
      return { kind: "failed" };
    }

    const toolCallId = pendingParts[0].toolCallId;

    const parsedInput = parseTaskToolInputForRecovery(pendingParts[0].input);
    if (!parsedInput) {
      log.error("tryFinalizePendingTaskToolCallInPartial: task input validation failed", {
        workspaceId,
      });
      return { kind: "failed" };
    }

    let finalizedOutput: z.infer<typeof TaskToolResultSchema> = parsedOutput.data;
    let areGroupSiblingsStillSettled: (() => boolean) | undefined;
    if (parsedInput.groupCount > 1) {
      const bestOf =
        childEntry?.workspace.bestOf ?? this.config.getLegacyTaskVariantGroup(childWorkspaceId);
      if (!bestOf) {
        return { kind: "failed" };
      }

      const hasGroupedCompletedOutput =
        Array.isArray(parsedOutput.data.taskIds) &&
        "reports" in parsedOutput.data &&
        Array.isArray(parsedOutput.data.reports);
      // A caller-assembled grouped output (deferred delivery) names no reporting sibling, so
      // every sibling must be settled at commit time.
      const reportingTaskId = hasGroupedCompletedOutput ? undefined : childWorkspaceId;
      if (!hasGroupedCompletedOutput) {
        const groupedOutput = await this.buildBestOfCompletedTaskToolOutput({
          parentWorkspaceId: workspaceId,
          groupId: bestOf.groupId,
          total: bestOf.total,
          reportingTaskId,
        });
        if (!groupedOutput) {
          return { kind: "not_ready" };
        }

        finalizedOutput = groupedOutput;
      }
      const assembledTaskIds = finalizedOutput.taskIds ?? [];
      areGroupSiblingsStillSettled = () =>
        this.areBestOfSiblingsStillSettled({
          parentWorkspaceId: workspaceId,
          groupId: bestOf.groupId,
          assembledTaskIds,
          reportingTaskId,
        });
    }

    // The grouped output above was assembled from disk reads that a parent turn can overtake:
    // its commitPartial moves this partial into history and its stream writes a fresh one under a
    // new message id. Apply the finalization only while the partial is still this message with
    // this call pending, and never under a stream that has already started. A sibling resumed
    // during those reads is about to replace the artifact already assembled here; the transform
    // runs with no await before the write, so this is the last point that can still see it.
    let groupSiblingResumed = false;
    const writeResult = await this.historyService.updatePartialIfMessageIdMatches(
      workspaceId,
      partial.id,
      (current) => {
        if (this.aiService.isStreaming(workspaceId)) return null;
        if (areGroupSiblingsStillSettled != null && !areGroupSiblingsStillSettled()) {
          groupSiblingResumed = true;
          return null;
        }
        const stillPending = current.parts.some(
          (part) =>
            isDynamicToolPart(part) &&
            part.toolCallId === toolCallId &&
            part.toolName === "task" &&
            part.state === "input-available"
        );
        if (!stillPending) return null;
        return {
          ...current,
          parts: current.parts.map((part) => {
            if (!isDynamicToolPart(part)) return part;
            if (part.toolCallId !== toolCallId) return part;
            if (part.toolName !== "task") return part;
            if (part.state === "output-available") return part;
            return { ...part, state: "output-available" as const, output: finalizedOutput };
          }),
        };
      }
    );
    if (!writeResult.success) {
      log.error("Failed to write finalized task tool output to partial", {
        workspaceId,
        error: writeResult.error,
      });
      return { kind: "failed" };
    }
    if (!writeResult.data) {
      if (groupSiblingResumed) {
        return { kind: "not_ready" };
      }
      log.debug("tryFinalizePendingTaskToolCallInPartial: partial superseded before finalization", {
        workspaceId,
        messageId: partial.id,
      });
      return { kind: "failed" };
    }

    this.workspaceService.emit("chat", {
      workspaceId,
      message: {
        type: "tool-call-end",
        workspaceId,
        messageId: partial.id,
        toolCallId,
        toolName: "task",
        result: finalizedOutput,
        timestamp: Date.now(),
      },
    });

    if (Array.isArray(finalizedOutput.taskIds) && finalizedOutput.taskIds.length > 0) {
      return { kind: "finalized", taskIds: finalizedOutput.taskIds };
    }

    return {
      kind: "finalized",
      taskIds: finalizedOutput.taskId ? [finalizedOutput.taskId] : [childWorkspaceId],
    };
  }

  private async canCleanupReportedTask(
    workspaceId: string,
    config: ProjectsConfig = this.config.loadConfigOrDefault()
  ): Promise<{ ok: true; parentWorkspaceId: string } | { ok: false; reason: string }> {
    assert(workspaceId.length > 0, "canCleanupReportedTask: workspaceId must be non-empty");

    const entry = findWorkspaceEntry(config, workspaceId);
    if (!entry) {
      return { ok: false, reason: "workspace_not_found" };
    }

    const parentWorkspaceId = entry.workspace.parentWorkspaceId;
    if (!parentWorkspaceId) {
      return { ok: false, reason: "missing_parent_workspace" };
    }

    if (!hasCompletedAgentReport(entry.workspace)) {
      return { ok: false, reason: "task_not_reported" };
    }

    // A reported task reactivated through an existing-workspace turn keeps taskStatus "reported"
    // while its execution mirror is already starting or running, before any stream registers.
    if (isActiveWorkspaceTurnTaskStatus(entry.workspace.taskExecutionStatus)) {
      return { ok: false, reason: "workspace_turn_active" };
    }

    const bestOf = this.getEffectiveTaskGroup(workspaceId, entry.workspace);
    if (bestOf?.total != null && bestOf.total > 1) {
      if (
        await this.shouldDeferBestOfFallback({
          parentWorkspaceId,
          groupId: bestOf.groupId,
          total: bestOf.total,
        })
      ) {
        return { ok: false, reason: "best_of_parent_partial_pending" };
      }
    }

    if (this.aiService.isStreaming(workspaceId)) {
      log.debug("cleanupReportedLeafTask: deferring auto-delete; stream still active", {
        workspaceId,
        parentWorkspaceId,
      });
      return { ok: false, reason: "still_streaming" };
    }

    // Topology gate: a completed task can only be cleaned up when it is a structural leaf
    // (has no child agent tasks in config). This stays status-agnostic so ancestor deletion
    // never orphans descendants that have not been pruned yet.
    const index = this.buildAgentTaskIndex(config);
    const isWorkflowOwnedTask = this.isWorkflowOwnedTaskUsingIndex(index, workspaceId);
    if (this.hasChildAgentTasks(index, workspaceId)) {
      return { ok: false, reason: "has_child_tasks" };
    }

    const parentSessionDir = path.join(this.config.sessionsDir, parentWorkspaceId);
    const patchArtifact = await readSubagentGitPatchArtifact(parentSessionDir, workspaceId);
    if (patchArtifact?.status === "pending") {
      log.debug("cleanupReportedLeafTask: deferring auto-delete; patch artifact pending", {
        workspaceId,
        parentWorkspaceId,
      });
      return { ok: false, reason: "patch_pending" };
    }

    // User-owned children persist unconditionally until task_remove. Workflow-owned workers remain
    // transient implementation details because their workflow journal owns the durable result.
    if (!isWorkflowOwnedTask) {
      return { ok: false, reason: "preserved" };
    }

    return { ok: true, parentWorkspaceId };
  }

  /**
   * @param options.config - config snapshot used only to screen the first (depth 0) candidate
   *   cheaply; deletion eligibility is always confirmed on fresh config inside remove()'s
   *   lifecycle lock, and every later depth re-evaluates the parent after a removal changed the tree.
   * @returns the number of workspaces removed.
   */
  private async cleanupReportedLeafTask(
    workspaceId: string,
    options?: { config?: ProjectsConfig }
  ): Promise<number> {
    assert(workspaceId.length > 0, "cleanupReportedLeafTask: workspaceId must be non-empty");

    // Lineage reduction: each iteration removes exactly one completed leaf, then re-evaluates
    // the parent on fresh config. The structural-leaf gate in canCleanupReportedTask ensures
    // ancestors are only deleted after every child has been pruned.
    let currentWorkspaceId = workspaceId;
    let removedCount = 0;
    const visited = new Set<string>();
    for (let depth = 0; depth < 32; depth++) {
      if (visited.has(currentWorkspaceId)) {
        log.error("cleanupReportedLeafTask: possible parentWorkspaceId cycle", {
          workspaceId: currentWorkspaceId,
        });
        return removedCount;
      }
      visited.add(currentWorkspaceId);

      const targetWorkspaceId = currentWorkspaceId;
      // Screen outside any lock (with the caller's snapshot at depth 0) so the (usual) ineligible
      // majority returns without a lock acquisition or config parse.
      const screened = await this.canCleanupReportedTask(
        targetWorkspaceId,
        depth === 0 ? options?.config : undefined
      );
      if (!screened.ok) {
        return removedCount;
      }
      // Deletion is decided on live state inside the task-tree lifecycle lock that remove()
      // holds: reactivation, re-parenting, and task_stop all mutate under that lock, so a task
      // confirmed eligible there cannot change underneath the removal. remove() is the only lock
      // acquisition on this path: runtime callers reach it under the workspace event lock
      // (stream-end finalization, cleanup rechecks), nesting event -> task-tree, the inverse of
      // the send path's task-tree -> event. That nesting predates the live recheck.
      let confirmed: { ok: true; parentWorkspaceId: string } | undefined;
      const removeResult = await this.workspaceService.remove(targetWorkspaceId, true, {
        beforeRemove: async () => {
          const live = await this.canCleanupReportedTask(targetWorkspaceId);
          confirmed = live.ok ? live : undefined;
          return live.ok;
        },
      });
      if (!removeResult.success) {
        log.error("Failed to auto-delete completed task workspace", {
          workspaceId: currentWorkspaceId,
          error: removeResult.error,
        });
        return removedCount;
      }
      if (confirmed == null) {
        return removedCount;
      }
      removedCount += 1;

      // The removal just made this parent a candidate, so follow the parent the live check saw
      // (a client may have re-parented the task since the screen).
      currentWorkspaceId = confirmed.parentWorkspaceId;
    }

    log.error("cleanupReportedLeafTask: exceeded max parent traversal depth", {
      workspaceId,
    });
    return removedCount;
  }
}
